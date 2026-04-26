import { execFile } from 'child_process';
import * as cache from './cache';
import { extractWithPlaywright } from './playwright-extractor';

export interface ExtractionResult {
  manifestUrl: string;
  headers: Record<string, string>;
}

export async function extract(inputUrl: string): Promise<ExtractionResult> {
  const cached = cache.get(inputUrl);
  if (cached) return cached;

  let result: ExtractionResult;
  try {
    result = await tier1(inputUrl);
    console.log('[tier1] success:', result.manifestUrl);
  } catch (err) {
    console.warn('[tier1] failed, trying Playwright:', (err as Error).message);
    result = await extractWithPlaywright(inputUrl);
    console.log('[playwright] success:', result.manifestUrl);
  }

  cache.set(inputUrl, result.manifestUrl, result.headers);
  return result;
}

function tier1(inputUrl: string): Promise<ExtractionResult> {
  return new Promise((resolve, reject) => {
    const binary = process.env.YTDLP_PATH ?? '/usr/local/bin/yt-dlp';
    execFile(
      binary,
      ['--dump-json', '--no-download', inputUrl],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) { reject(err); return; }

        let info: Record<string, unknown>;
        try {
          info = JSON.parse(stdout) as Record<string, unknown>;
        } catch (e) {
          reject(new Error('yt-dlp output was not valid JSON')); return;
        }

        const formats = (info.formats as Array<Record<string, unknown>>) ?? [];
        const m3u8Formats = formats.filter(
          (f) => f.protocol === 'm3u8_native' || f.protocol === 'm3u8'
        );

        if (m3u8Formats.length === 0) {
          reject(new Error('No m3u8 format found in yt-dlp output')); return;
        }

        // Pick highest resolution
        m3u8Formats.sort((a, b) => ((b.height as number) ?? 0) - ((a.height as number) ?? 0));
        const best = m3u8Formats[0];

        resolve({
          manifestUrl: best.url as string,
          headers: (best.http_headers as Record<string, string>) ?? {},
        });
      }
    );
  });
}
