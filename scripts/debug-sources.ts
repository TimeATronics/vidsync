/**
 * Diagnose the rivestream download page structure.
 * Run on VPS:
 *   npx ts-node scripts/debug-sources.ts [tmdbId] [type]
 *   npx ts-node scripts/debug-sources.ts 27205 movie
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';

const id   = process.argv[2] ?? '27205';
const type = process.argv[3] ?? 'movie';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const networkLog: { url: string; status: number; ct: string; preview: string }[] = [];

  page.on('response', async (res) => {
    const u  = res.url();
    const ct = res.headers()['content-type'] ?? '';
    if (/\.(css|png|jpg|gif|ico|woff|ttf|svg)(\?|$)/i.test(u)) return;
    try {
      let preview = '';
      if (ct.includes('json') || ct.includes('text/html') || ct.includes('text/plain')) {
        const t = await res.text().catch(() => '');
        preview = t.slice(0, 300).replace(/\s+/g, ' ');
      }
      networkLog.push({ url: u.slice(0, 150), status: res.status(), ct: ct.slice(0, 60), preview });
    } catch {}
  });

  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const targetUrl = `https://rivestream.org/download?type=${type}&id=${id}`;
  console.log('Target:', targetUrl);
  console.log('Navigating…');

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });

  // Try clicking any "Get Download Links" / "Show" type buttons
  const triggers = [
    'button:has-text("Download")',
    'button:has-text("Get")',
    'button:has-text("Load")',
    'button:has-text("Show")',
    'button:has-text("Fetch")',
  ];
  for (const sel of triggers) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_500 })) {
        console.log('Clicking trigger button:', sel);
        await el.click();
        await page.waitForTimeout(500);
      }
    } catch {}
  }

  console.log('Waiting 35s for dynamic content…');
  await page.waitForTimeout(35_000);

  // ── Dump page HTML snippet ──
  const html = await page.content();
  fs.writeFileSync('/tmp/rive-download-page.html', html, 'utf8');
  console.log('\n[HTML saved to /tmp/rive-download-page.html]');

  // ── All links on the page ──
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(h => h.startsWith('http'))
  );

  // ── All text in likely download containers ──
  const downloadSectionText = await page.evaluate(() => {
    const candidates = [
      ...Array.from(document.querySelectorAll('[class*="download"],[class*="source"],[class*="link"],[class*="server"],[class*="quality"]')),
    ];
    return candidates.slice(0, 30).map(el => ({
      tag: el.tagName,
      cls: el.className?.toString().slice(0, 60),
      text: el.textContent?.trim().slice(0, 120),
    }));
  });

  // ── Data attributes that might hold URLs ──
  const dataAttrs = await page.evaluate(() => {
    const result: string[] = [];
    document.querySelectorAll('[data-url],[data-src],[data-link],[data-href]').forEach(el => {
      const d = (el as HTMLElement).dataset;
      for (const v of Object.values(d)) {
        if (v && v.startsWith('http')) result.push(v);
      }
    });
    return result;
  });

  // ── Screenshot ──
  await page.screenshot({ path: '/tmp/rive-download.png', fullPage: true });

  // ── Report ──
  console.log('\n═══ NETWORK RESPONSES (' + networkLog.length + ') ═══');
  for (const r of networkLog) {
    console.log(`  [${r.status}] ${r.url}`);
    if (r.preview) console.log(`        ${r.preview.slice(0, 200)}`);
  }

  console.log('\n═══ LINKS ON PAGE (' + links.length + ') ═══');
  for (const l of links.slice(0, 40)) console.log(' ', l);

  console.log('\n═══ DOWNLOAD-SECTION ELEMENTS (' + downloadSectionText.length + ') ═══');
  for (const el of downloadSectionText) {
    console.log(`  <${el.tag} class="${el.cls}">  ${el.text}`);
  }

  console.log('\n═══ DATA-ATTRIBUTE URLs (' + dataAttrs.length + ') ═══');
  for (const u of dataAttrs) console.log(' ', u);

  console.log('\nScreenshot: /tmp/rive-download.png');
  console.log('Full HTML:  /tmp/rive-download-page.html\n');

  await browser.close();
}

main().catch(console.error).finally(() => process.exit(0));
