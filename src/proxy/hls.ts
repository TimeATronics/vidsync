import { Router, Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';

const SECRET_KEY = process.env.SECRET_KEY ?? 'change_me';
const TOKEN_TTL_SECONDS = 4 * 3600;

// Headers keyed by CDN origin (protocol+host). Populated by the extractor in Phase 3+.
const cdnHeaders = new Map<string, Record<string, string>>();

export function registerCdnHeaders(manifestUrl: string, headers: Record<string, string>): void {
  const origin = new URL(manifestUrl).origin;
  cdnHeaders.set(origin, headers);
}

function headersForUrl(url: string): Record<string, string> {
  const origin = new URL(url).origin;
  return cdnHeaders.get(origin) ?? {};
}

function signSegment(segmentUrl: string, expiry: number): string {
  return crypto.createHmac('sha256', SECRET_KEY).update(`${segmentUrl}:${expiry}`).digest('hex');
}

function buildSegmentProxyUrl(segmentUrl: string): string {
  const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = signSegment(segmentUrl, expiry);
  return `/proxy/segment?url=${encodeURIComponent(segmentUrl)}&expiry=${expiry}&token=${token}`;
}

function rewriteManifest(manifest: string, baseUrl: string): string {
  return manifest
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      // Resolve relative URLs against the manifest base
      const absolute = new URL(trimmed, baseUrl).toString();
      return buildSegmentProxyUrl(absolute);
    })
    .join('\n');
}

export const hlsRouter = Router();

// GET /proxy/manifest?url=<encodedManifestUrl>
hlsRouter.get('/manifest', async (req: Request, res: Response) => {
  const raw = req.query.url as string | undefined;
  if (!raw) { res.status(400).json({ error: 'Missing url parameter' }); return; }

  let manifestUrl: string;
  try {
    manifestUrl = decodeURIComponent(raw);
    new URL(manifestUrl); // throws if invalid
  } catch {
    res.status(400).json({ error: 'Invalid url parameter' }); return;
  }

  try {
    const upstream = await axios.get(manifestUrl, {
      headers: { ...headersForUrl(manifestUrl), 'User-Agent': 'Mozilla/5.0' },
      responseType: 'text',
      timeout: 10_000,
    });
    const rewritten = rewriteManifest(upstream.data as string, manifestUrl);
    res.set('Content-Type', 'application/x-mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  } catch {
    res.status(502).json({ error: 'Failed to fetch manifest' });
  }
});

// GET /proxy/segment?url=<encoded>&expiry=<ts>&token=<hmac>
hlsRouter.get('/segment', async (req: Request, res: Response) => {
  const { url: rawUrl, expiry: rawExpiry, token } = req.query as Record<string, string>;
  if (!rawUrl || !rawExpiry || !token) {
    res.status(400).json({ error: 'Missing required parameters' }); return;
  }

  const expiry = parseInt(rawExpiry, 10);
  if (isNaN(expiry) || Math.floor(Date.now() / 1000) > expiry) {
    res.status(403).json({ error: 'Token expired' }); return;
  }

  let segmentUrl: string;
  try {
    segmentUrl = decodeURIComponent(rawUrl);
    new URL(segmentUrl);
  } catch {
    res.status(400).json({ error: 'Invalid url parameter' }); return;
  }

  const expected = signSegment(segmentUrl, expiry);
  // Reject if lengths differ (prevents timingSafeEqual throwing on unequal-length buffers)
  if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    res.status(403).json({ error: 'Invalid token' }); return;
  }

  try {
    const upstream = await axios.get(segmentUrl, {
      headers: { ...headersForUrl(segmentUrl), 'User-Agent': 'Mozilla/5.0' },
      responseType: 'stream',
      timeout: 15_000,
    });
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', (upstream.headers['content-type'] as string) ?? 'video/mp2t');
    (upstream.data as NodeJS.ReadableStream).pipe(res);
  } catch {
    res.status(502).json({ error: 'Failed to fetch segment' });
  }
});

// ── MP4 proxy ──────────────────────────────────────────────────────────────
// Proxies MP4 streams that require a specific Referer (e.g. valhallastream CDN
// checks for rivestream.org). Supports Range requests so seeking works.
//
// GET /proxy/mp4?url=<encoded>&expiry=<ts>&token=<hmac>

function signMp4(url: string, expiry: number): string {
  return crypto.createHmac('sha256', SECRET_KEY).update(`mp4:${url}:${expiry}`).digest('hex');
}

export function buildMp4ProxyUrl(mp4Url: string, publicUrl: string): string {
  const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = signMp4(mp4Url, expiry);
  return `${publicUrl}/proxy/mp4?url=${encodeURIComponent(mp4Url)}&expiry=${expiry}&token=${token}`;
}

hlsRouter.get('/mp4', async (req: Request, res: Response) => {
  const { url: rawUrl, expiry: rawExpiry, token } = req.query as Record<string, string>;
  if (!rawUrl || !rawExpiry || !token) {
    res.status(400).json({ error: 'Missing required parameters' }); return;
  }

  const expiry = parseInt(rawExpiry, 10);
  if (isNaN(expiry) || Math.floor(Date.now() / 1000) > expiry) {
    res.status(403).json({ error: 'Token expired' }); return;
  }

  let mp4Url: string;
  try {
    mp4Url = decodeURIComponent(rawUrl);
    new URL(mp4Url);
  } catch {
    res.status(400).json({ error: 'Invalid url parameter' }); return;
  }

  const expected = signMp4(mp4Url, expiry);
  if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    res.status(403).json({ error: 'Invalid token' }); return;
  }

  const rangeHeader = req.headers['range'];
  const upstreamHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://rivestream.org/',
    'Origin': 'https://rivestream.org',
  };
  if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

  try {
    const upstream = await axios.get(mp4Url, {
      headers: upstreamHeaders,
      responseType: 'stream',
      timeout: 30_000,
    });
    res.status(rangeHeader ? (upstream.status === 206 ? 206 : 200) : 200);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', (upstream.headers['content-type'] as string) ?? 'video/mp4');
    if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length'] as string);
    if (upstream.headers['content-range']) res.set('Content-Range', upstream.headers['content-range'] as string);
    res.set('Accept-Ranges', 'bytes');
    (upstream.data as NodeJS.ReadableStream).pipe(res);
  } catch {
    res.status(502).json({ error: 'Failed to fetch mp4' });
  }
});
