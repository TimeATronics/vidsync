import { chromium, Browser, Page, Request as PlaywrightRequest, Response as PlaywrightResponse } from 'playwright';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

const HLS_URL_PATTERN = /\.(m3u8|ts)(\?|$)/i;
const MP4_URL_PATTERN = /\.mp4(\?|$)/i;

export interface StreamSource {
  label: string;
  url: string;
  format: 'hls' | 'mp4';
}
const HLS_MIME_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

function isLikelyManifestUrl(url: string): boolean {
  return HLS_URL_PATTERN.test(url);
}

function isHlsMimeType(contentType: string): boolean {
  return HLS_MIME_TYPES.some(m => contentType.toLowerCase().includes(m));
}

// Walk a parsed JSON object looking for a string value that looks like an HLS URL.
function findM3u8InJson(obj: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof obj === 'string' && HLS_URL_PATTERN.test(obj)) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findM3u8InJson(item, depth + 1);
      if (found) return found;
    }
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      const found = findM3u8InJson(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export async function extractWithPlaywright(inputUrl: string): Promise<{ manifestUrl: string; headers: Record<string, string> }> {
  const b = await getBrowser();
  const page: Page = await b.newPage();

  try {
    let m3u8Url: string | null = null;

    const onRequest = (req: PlaywrightRequest) => {
      if (m3u8Url) return;
      if (isLikelyManifestUrl(req.url())) {
        console.log('[playwright] HLS URL match:', req.url());
        m3u8Url = req.url();
      }
    };

    const onResponse = async (res: PlaywrightResponse) => {
      if (m3u8Url) return;
      const ct = res.headers()['content-type'] ?? '';
      if (isHlsMimeType(ct)) {
        console.log('[playwright] HLS Content-Type match:', res.url());
        m3u8Url = res.url();
        return;
      }
      if (ct.includes('application/json')) {
        try {
          const body = await res.text();
          const found = findM3u8InJson(JSON.parse(body));
          if (found) {
            console.log('[playwright] HLS URL found in JSON API response:', found);
            m3u8Url = found;
          }
        } catch { /* ignore */ }
      }
    };

    page.on('request', onRequest);
    page.on('response', onResponse);

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    // Dismiss consent/cookie/welcome modals — these often gate iframe rendering
    await dismissModals(page);

    // Wait up to 25s for HLS to appear — embed pages (e.g. rivestream) fire their
    // stream API call 10-15s into the page lifecycle. The onResponse handler for
    // application/json uses findM3u8InJson to catch playlist URLs in API payloads.
    if (!m3u8Url) {
      m3u8Url = await waitForM3u8(page, 25_000);
    }

    // Give any in-flight async onResponse handlers a tick to finish
    if (!m3u8Url) await new Promise(r => setTimeout(r, 500));

    // Fallback: if still nothing, find the first external iframe and navigate to it
    if (!m3u8Url) {
      const iframeSrc = await getFirstExternalIframe(page, inputUrl);
      if (iframeSrc) {
        console.log('[playwright] following iframe:', iframeSrc);
        await page.goto(iframeSrc, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await dismissModals(page);
        m3u8Url = await waitForM3u8(page, 12_000);
      }
    }

    if (!m3u8Url) throw new Error('Playwright: no HLS manifest intercepted within timeout');

    return {
      manifestUrl: m3u8Url,
      headers: {
        Referer: inputUrl,
        Origin: new URL(inputUrl).origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    };
  } finally {
    await page.close();
  }
}

// Click common consent/popup buttons. Streaming sites gate their player behind these.
async function dismissModals(page: Page): Promise<void> {
  const patterns = [
    'button:has-text("Got it")',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Close")',
    'button:has-text("Continue")',
    '[class*="close-btn"]',
    '[class*="modal-close"]',
    '[aria-label="Close"]',
  ];
  for (const sel of patterns) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 1_000 });
        console.log('[playwright] dismissed modal:', sel);
        await page.waitForTimeout(400);
      }
    } catch { /* not present */ }
  }
}

// Wait up to `ms` milliseconds for an m3u8 URL via any detection method.
function waitForM3u8(page: Page, ms: number): Promise<string | null> {
  return Promise.race([
    page.waitForEvent('request', {
      predicate: (req) => isLikelyManifestUrl(req.url()),
      timeout: ms,
    }).then((req) => req.url()).catch(() => null),
    page.waitForEvent('response', {
      predicate: (res) => isHlsMimeType(res.headers()['content-type'] ?? ''),
      timeout: ms,
    }).then((res) => res.url()).catch(() => null),
  ]);
}

// Extract the src of the first iframe that is on a different origin from the parent.
async function getFirstExternalIframe(page: Page, parentUrl: string): Promise<string | null> {
  try {
    const parentOrigin = new URL(parentUrl).origin;
    const srcs = await page.locator('iframe[src]').evaluateAll(
      (els) => els.map((el) => (el as any).src as string)
    );
    return srcs.find((s) => {
      try { return new URL(s).origin !== parentOrigin; } catch { return false; }
    }) ?? null;
  } catch { return null; }
}

export async function shutdownBrowser(): Promise<void> {
  if (browser) { await browser.close(); browser = null; }
}

// ── Multi-source collection ───────────────────────────────────────────────────

function collectStreamUrls(
  obj: unknown,
  results: Map<string, StreamSource>,
  label: string,
  depth = 0,
): void {
  if (depth > 8) return;
  if (typeof obj === 'string') {
    if (HLS_URL_PATTERN.test(obj) && !results.has(obj)) {
      results.set(obj, { label, url: obj, format: 'hls' });
    } else if (MP4_URL_PATTERN.test(obj) && !results.has(obj)) {
      results.set(obj, { label, url: obj, format: 'mp4' });
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectStreamUrls(item, results, label, depth + 1);
  } else if (obj && typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    const id = typeof record.sourceId === 'string' ? record.sourceId : label;
    for (const val of Object.values(record)) collectStreamUrls(val, results, id, depth + 1);
  }
}

// Known video CDN host fragments — used to classify extensionless URLs
const VIDEO_HOST_PATTERNS = [
  /cdn\./i, /stream\./i, /video\./i, /play\./i, /media\./i,
  /\/stream\//i, /\/video\//i, /\/play\//i, /\/hls\//i, /\/mp4\//i,
  /\.mkv(\?|$)/i, /\.webm(\?|$)/i,
];

function isVideoUrl(url: string): boolean {
  return (
    HLS_URL_PATTERN.test(url) ||
    MP4_URL_PATTERN.test(url) ||
    VIDEO_HOST_PATTERNS.some(p => p.test(url))
  );
}

function formatFromUrl(url: string): 'hls' | 'mp4' {
  if (HLS_URL_PATTERN.test(url)) return 'hls';
  return 'mp4';
}

/**
 * Navigate to the rivestream download page and collect all stream URLs found in
 * JSON API responses AND in the rendered DOM (links, data attributes, innerText).
 */
export async function getSources(
  type: 'movie' | 'tv',
  id: string,
  season?: number,
  episode?: number,
): Promise<StreamSource[]> {
  const b = await getBrowser();
  const page = await b.newPage();
  const found = new Map<string, StreamSource>();

  const addUrl = (url: string, label: string) => {
    if (!url.startsWith('http')) return;
    if (found.has(url)) return;
    const fmt = formatFromUrl(url);
    found.set(url, { label, url, format: fmt });
  };

  try {
    // ── Network interception: catch JSON API responses ──
    page.on('response', async (res: PlaywrightResponse) => {
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('application/json') && !ct.includes('text/plain')) return;
      try {
        const text = await res.text();
        // Walk the raw text for any URLs before trying to parse
        const rawMatches = text.match(/https?:\/\/[^\s"'<>]+\.(m3u8|mp4|mkv|webm)[^\s"'<>]*/gi) ?? [];
        for (const m of rawMatches) addUrl(m, 'api');

        const json = JSON.parse(text);
        const sourceId: string =
          (json?.sourceId as string) ?? (json?.data?.sourceId as string) ?? 'api';
        collectStreamUrls(json, found, sourceId);
      } catch { /* ignore */ }
    });

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    let url = `https://rivestream.org/download?type=${type}&id=${id}`;
    if (type === 'tv' && season && episode) url += `&season=${season}&episode=${episode}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    // Poll up to 35 s. Short-circuit early once we have ≥ 2 sources after 10 s.
    for (let i = 0; i < 35; i++) {
      await page.waitForTimeout(1000);
      if (found.size >= 2 && i >= 9) break;
    }

    // ── DOM fallback: scrape <a href>, data-* attrs, and visible text ──
    // The function passed to evaluate() runs in the browser context.
    // We use indirect globals to avoid TypeScript's no-dom lib restriction.
    const domData: string[] = await page.evaluate(
      /* istanbul ignore next */
      new Function(`
        const urls = [];
        const doc = window.document;

        doc.querySelectorAll('a[href]').forEach(a => {
          if (a.href && a.href.startsWith('http')) urls.push(a.href);
        });

        doc.querySelectorAll('[data-url],[data-src],[data-link],[data-href]').forEach(el => {
          Object.values(el.dataset || {}).forEach(v => {
            if (v && v.startsWith('http')) urls.push(v);
          });
        });

        const bodyText = doc.body ? doc.body.innerText : '';
        const matches = bodyText.match(/https?:\\/\\/[^\\s"'<>]+/g) || [];
        matches.forEach(u => { if (u.startsWith('http')) urls.push(u); });

        return [...new Set(urls)];
      `) as () => string[]
    );

    for (const u of domData) {
      if (isVideoUrl(u)) addUrl(u, 'download');
    }

    return Array.from(found.values());
  } finally {
    await page.close();
  }
}
