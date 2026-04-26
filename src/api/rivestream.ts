/**
 * Direct HTTP client for the rivestream backendfetch API.
 * No Playwright needed — pure axios calls mimicking the browser's fetch pattern.
 *
 * secretKey algorithm extracted from the rive_app.js webpack bundle (HAR-verified):
 *   1. Pick element t = c[id % c.length] from the obfuscation array
 *   2. Insert t into the id string at position n = floor(id % id.length / 2)
 *   3. Apply innerHash + outerHash to the modified string
 *   4. Return btoa(outerHash result)
 *
 * Verified: makeSecretKey("332835") === "MDU1NDRkMjA=" ✓
 */
import axios from 'axios';

const BASE    = 'https://rivestream.org/api/backendfetch';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer':    'https://rivestream.org/',
  'Origin':     'https://rivestream.org',
};

// Obfuscation array, extracted verbatim from rive_app.js
const C = [
  '4Z7lUo','gwIVSMD','PLmz2elE2v','Z4OFV0','SZ6RZq6Zc','zhJEFYxrz8','FOm7b0','axHS3q4KDq',
  'o9zuXQ','4Aebt','wgjjWwKKx','rY4VIxqSN','kfjbnSo','2DyrFA1M','YUixDM9B','JQvgEj0',
  'mcuFx6JIek','eoTKe26gL','qaI9EVO1rB','0xl33btZL','1fszuAU','a7jnHzst6P','wQuJkX','cBNhTJlEOf',
  'KNcFWhDvgT','XipDGjST','PCZJlbHoyt','2AYnMZkqd','HIpJh','KH0C3iztrG','W81hjts92','rJhAT',
  'NON7LKoMQ','NMdY3nsKzI','t4En5v','Qq5cOQ9H','Y9nwrp','VX5FYVfsf','cE5SJG','x1vj1',
  'HegbLe','zJ3nmt4OA','gt7rxW57dq','clIE9b','jyJ9g','B5jXjMCSx','cOzZBZTV','FTXGy',
  'Dfh1q1','ny9jqZ2POI','X2NnMn','MBtoyD','qz4Ilys7wB','68lbOMye','3YUJnmxp','1fv5Imona',
  'PlfvvXD7mA','ZarKfHCaPR','owORnX','dQP1YU','dVdkx','qgiK0E','cx9wQ','5F9bGa',
  '7UjkKrp','Yvhrj','wYXez5Dg3','pG4GMU','MwMAu','rFRD5wlM',
];

// ── secretKey generation (ported from rive_app.js webpack bundle, HAR-verified) ──

function innerHash(e: string): string {
  let t = 0;
  for (let n = 0; n < e.length; n++) {
    const r = e.charCodeAt(n);
    const i = (((t = (r + (t << 6) + (t << 16) - t) >>> 0) << (n % 5)) | (t >>> (32 - n % 5))) >>> 0;
    t = (t ^ (i ^ ((r << (n % 7)) | (r >>> (8 - n % 7))))) >>> 0;
    t = (t + ((t >>> 11) ^ (t << 3))) >>> 0;
  }
  t ^= t >>> 15;
  t = (((65535 & t) * 49842) + ((((t >>> 16) * 49842) & 65535) << 16)) >>> 0;
  t ^= t >>> 13;
  t = (((65535 & t) * 40503) + ((((t >>> 16) * 40503) & 65535) << 16)) >>> 0;
  t ^= t >>> 16;
  return t.toString(16).padStart(8, '0');
}

function outerHash(e: string): string {
  const t = String(e);
  let n = (3735928559 ^ t.length) >>> 0;
  for (let e = 0; e < t.length; e++) {
    let r = t.charCodeAt(e);
    r = (r ^ ((131 * e + 89 ^ (r << (e % 5))) & 255)) >>> 0;
    n = (((n << 7) | (n >>> 25)) >>> 0) ^ r;
    const i = (65535 & n) * 60205;
    const o = (n >>> 16) * 60205 << 16;
    n = (i + o) >>> 0;
    n ^= n >>> 11;
  }
  n ^= n >>> 15;
  n = (((65535 & n) * 49842) + (((n >>> 16) * 49842) << 16)) >>> 0;
  n ^= n >>> 13;
  n = (((65535 & n) * 40503) + (((n >>> 16) * 40503) << 16)) >>> 0;
  n ^= n >>> 16;
  n = (((65535 & n) * 10196) + (((n >>> 16) * 10196) << 16)) >>> 0;
  n ^= n >>> 15;
  return n.toString(16).padStart(8, '0');
}

/**
 * Compute the secretKey for a given TMDB id (numeric string) or search query.
 * Returns "rive" for undefined (used for VideoProviderServices).
 * Verified: makeSecretKey("332835") === "MDU1NDRkMjA="
 */
export function makeSecretKey(input: string | number | undefined): string {
  if (input === undefined) return 'rive';
  try {
    let t: string;
    let n: number;
    const r = String(input);
    if (isNaN(Number(input))) {
      const sum = r.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
      t = C[sum % C.length] ?? Buffer.from(r).toString('base64');
      n = Math.floor((sum % r.length) / 2);
    } else {
      const i = Number(input);
      t = C[i % C.length] ?? Buffer.from(r).toString('base64');
      n = Math.floor((i % r.length) / 2);
    }
    const intermediate = r.slice(0, n) + t + r.slice(n);
    const o = outerHash(innerHash(intermediate));
    return Buffer.from(o).toString('base64');
  } catch {
    return 'topSecret';
  }
}

export interface RiveSource {
  label:   string;
  url:     string;
  format:  'hls' | 'mp4';
  quality: string;
}

/** Step 1: get available provider service names */
async function getServices(): Promise<string[]> {
  try {
    const { data } = await axios.get(BASE, {
      params:  { requestID: 'VideoProviderServices', secretKey: 'rive', proxyMode: 'undefined' },
      headers: HEADERS,
      timeout: 12_000,
    });
    return Array.isArray(data?.data) ? (data.data as string[]) : [];
  } catch {
    return [];
  }
}

/** Step 2: fetch stream sources from one provider service */
async function fetchService(
  requestID: string,
  id:        string,
  service:   string,
  secretKey: string,
  extra:     Record<string, string | number> = {},
): Promise<RiveSource[]> {
  try {
    const { data } = await axios.get(BASE, {
      params:  { requestID, id, service, secretKey, proxyMode: 'undefined', ...extra },
      headers: HEADERS,
      timeout: 20_000,
    });
    const sources: any[] = data?.data?.sources ?? [];
    return sources
      .filter(s => s?.url && (s.format === 'mp4' || s.format === 'hls'))
      .map(s => ({
        label:   `${s.source ?? service} ${s.quality ?? ''}`.trim(),
        url:     s.url as string,
        format:  s.format as 'hls' | 'mp4',
        quality: String(s.quality ?? ''),
      }));
  } catch {
    return [];
  }
}

/**
 * Main entry: fetch all available stream sources for a movie or TV episode.
 * Returns sources from all providers, in parallel.
 */
export async function getRiveSources(
  type:     'movie' | 'tv',
  id:       string,
  season?:  number,
  episode?: number,
): Promise<RiveSource[]> {
  const secretKey = makeSecretKey(id);
  const requestID = type === 'movie' ? 'movieVideoProvider' : 'tvVideoProvider';

  const extra: Record<string, string | number> = {};
  if (type === 'tv' && season && episode) {
    extra.season  = season;
    extra.episode = episode;
  }

  const services = await getServices();
  if (!services.length) throw new Error('rivestream: failed to fetch service list');

  const batches = await Promise.all(
    services.map(svc => fetchService(requestID, id, svc, secretKey, extra))
  );

  return batches.flat();
}
