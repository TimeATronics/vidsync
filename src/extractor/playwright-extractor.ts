import { chromium, Browser, Page } from 'playwright';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function extractWithPlaywright(inputUrl: string): Promise<{ manifestUrl: string; headers: Record<string, string> }> {
  const b = await getBrowser();
  const page: Page = await b.newPage();

  try {
    let m3u8Url: string | null = null;

    page.on('request', (req) => {
      if (!m3u8Url && req.url().includes('.m3u8')) {
        m3u8Url = req.url();
      }
    });

    await page.setExtraHTTPHeaders({ 'Referer': inputUrl });
    await page.goto(inputUrl, { waitUntil: 'networkidle', timeout: 20_000 });

    // Wait up to 10s more for the m3u8 request to appear
    if (!m3u8Url) {
      await page.waitForEvent('request', {
        predicate: (req) => req.url().includes('.m3u8'),
        timeout: 10_000,
      }).then((req) => { m3u8Url = req.url(); }).catch(() => { /* timeout — fall through */ });
    }

    if (!m3u8Url) throw new Error('Playwright: no .m3u8 request intercepted');

    return {
      manifestUrl: m3u8Url,
      headers: {
        Referer: inputUrl,
        Origin: new URL(inputUrl).origin,
        'User-Agent': 'Mozilla/5.0',
      },
    };
  } finally {
    await page.close();
  }
}

export async function shutdownBrowser(): Promise<void> {
  if (browser) { await browser.close(); browser = null; }
}
