/**
 * Local extraction test — run with:
 *   npx ts-node scripts/test-extract.ts <url>
 *
 * Tests both tier1 (yt-dlp) and tier2 (Playwright) independently.
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { extractWithPlaywright, shutdownBrowser } from '../src/extractor/playwright-extractor';

const url = process.argv[2];
if (!url) {
  console.error('Usage: npx ts-node scripts/test-extract.ts <url>');
  process.exit(1);
}

async function testYtDlp(inputUrl: string): Promise<void> {
  console.log('\n── yt-dlp ──────────────────────────────────');
  await new Promise<void>((resolve) => {
    execFile(
      'yt-dlp',
      ['--dump-json', '--no-download', inputUrl],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          console.log('✕ yt-dlp failed:', err.message);
          if (stderr) console.log('stderr:', stderr.slice(0, 500));
          resolve();
          return;
        }
        try {
          const info = JSON.parse(stdout) as Record<string, unknown>;
          const formats = (info.formats as Array<Record<string, unknown>>) ?? [];
          const m3u8 = formats.filter(f => f.protocol === 'm3u8_native' || f.protocol === 'm3u8');
          if (m3u8.length === 0) {
            console.log('✕ yt-dlp succeeded but found no m3u8 formats');
            console.log('  available protocols:', [...new Set(formats.map(f => f.protocol))]);
          } else {
            console.log('✓ yt-dlp found', m3u8.length, 'm3u8 format(s)');
            m3u8.forEach(f => console.log(' ', f.height + 'p', f.url));
          }
        } catch {
          console.log('✕ yt-dlp output was not valid JSON');
        }
        resolve();
      }
    );
  });
}

async function testPlaywright(inputUrl: string): Promise<void> {
  console.log('\n── Playwright (diagnostic mode) ────────────');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const allRequests: string[] = [];

  page.on('request', (req: any) => {
    const url: string = req.url();
    // Log anything that looks media/stream-related
    if (/\.(m3u8|ts|mp4|mpd|vtt|webm|mkv)(\?|$)/i.test(url) ||
        /manifest|playlist|master|chunklist|hls|dash|stream/i.test(url)) {
      console.log('  [req]', req.resourceType().padEnd(10), url.slice(0, 120));
    }
    allRequests.push(url);
  });

  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    console.log('  page title:', await page.title());

    // Dismiss ALL modals in a loop
    let dismissCount = 0;
    for (let i = 0; i < 5; i++) {
      let dismissed = false;
      for (const text of ['Got it!', 'Got it', 'OK', 'Close', 'Accept', 'Continue']) {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
          await btn.click();
          console.log(`  dismissed modal #${i+1} button:`, text);
          dismissed = true;
          dismissCount++;
          await page.waitForTimeout(1000);
          break;
        }
      }
      // Also try clicking × close buttons
      if (!dismissed) {
        const xBtn = page.locator('button:has-text("×"), button[aria-label*="close" i], [class*="close"]:visible').first();
        if (await xBtn.isVisible({ timeout: 800 }).catch(() => false)) {
          await xBtn.click();
          console.log(`  dismissed modal #${i+1} via close button`);
          dismissed = true;
          dismissCount++;
          await page.waitForTimeout(1000);
        }
      }
      if (!dismissed) break;
    }
    if (dismissCount === 0) console.log('  no modals found');

    // After dismissal, check iframes via locator
    const iframeEls = await page.locator('iframe').all();
    const iframeSrcs: string[] = [];
    for (const iframe of iframeEls) {
      const src = await iframe.getAttribute('src');
      if (src) iframeSrcs.push(src);
    }
    console.log('  iframes after dismissal:', iframeSrcs);

    // List all iframes
    const frames = page.frames();
    console.log('  frames:', frames.length);
    frames.forEach((f: any) => console.log('   ', f.url().slice(0, 100)));

    // Wait 15s watching for media requests
    console.log('  waiting 15s for media requests...');
    await page.waitForTimeout(15000);

    console.log('\n  total requests captured:', allRequests.length);
    const mediaUrls = allRequests.filter(u =>
      /\.(m3u8|ts|mp4|mpd|vtt)(\?|$)/i.test(u) ||
      /manifest|playlist|master|hls|stream/i.test(u)
    );
    if (mediaUrls.length > 0) {
      console.log('  media-like URLs found:');
      mediaUrls.forEach(u => console.log('   ', u.slice(0, 120)));
    } else {
      console.log('  no media URLs found in any request');
    }
  } catch (err) {
    console.log('✕ error:', (err as Error).message);
  } finally {
    await page.screenshot({ path: 'scripts/debug-screenshot.png' });
    console.log('  screenshot saved to scripts/debug-screenshot.png');
    await browser.close();
  }
}

(async () => {
  console.log('Testing URL:', url);
  await testYtDlp(url);
  await testPlaywright(url);

  // Also run the production extractor to verify it works end-to-end
  console.log('\n── Production extractor ────────────────────');
  try {
    const result = await extractWithPlaywright(url);
    console.log('✓ manifest URL:', result.manifestUrl);
  } catch (err) {
    console.log('✕ production extractor failed:', (err as Error).message);
  }

  await shutdownBrowser();
  process.exit(0);
})();
