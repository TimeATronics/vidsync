/**
 * Bulk test: TMDB search + rivestream sources for 20 popular Hollywood movies.
 * Run on the US VPS to avoid Indian geo-blocks (HTTP 451).
 *
 *   npx ts-node scripts/test-bulk.ts 2>/dev/null
 */
import 'dotenv/config';
import { getSources } from '../src/extractor/playwright-extractor';
import { searchTMDB } from '../src/api/search';

// 20 popular Hollywood movies with known TMDB IDs
const MOVIES = [
  { id: 27205,  title: 'Inception (2010)' },
  { id: 155,    title: 'The Dark Knight (2008)' },
  { id: 299534, title: 'Avengers: Endgame (2019)' },
  { id: 157336, title: 'Interstellar (2014)' },
  { id: 533535, title: 'Deadpool & Wolverine (2024)' },
  { id: 872585, title: 'Oppenheimer (2023)' },
  { id: 693134, title: 'Dune: Part Two (2024)' },
  { id: 634649, title: 'Spider-Man: No Way Home (2021)' },
  { id: 361743, title: 'Top Gun: Maverick (2022)' },
  { id: 414906, title: 'The Batman (2022)' },
  { id: 76600,  title: 'Avatar: The Way of Water (2022)' },
  { id: 545611, title: 'Everything Everywhere All at Once (2022)' },
  { id: 546554, title: 'Knives Out (2019)' },
  { id: 447365, title: 'Guardians of the Galaxy Vol. 3 (2023)' },
  { id: 315162, title: 'Puss in Boots: The Last Wish (2022)' },
  { id: 385687, title: 'Fast X (2023)' },
  { id: 640146, title: 'Ant-Man and the Wasp: Quantumania (2023)' },
  { id: 550988, title: 'Free Guy (2021)' },
  { id: 297762, title: 'Wonder Woman (2017)' },
  { id: 438631, title: 'Dune (2021)' },
];

const BATCH = 4; // concurrent pages

function pad(s: string, n: number) { return s.padEnd(n).slice(0, n); }

async function testSearch() {
  console.log('\n── TMDB Search Smoke Test ──────────────────────────────');
  const tests = ['Inception', 'Oppenheimer', 'Dune'];
  for (const q of tests) {
    try {
      const res = await searchTMDB(q, 'movie');
      const top = res[0];
      console.log(`  ✓ "${q}" → ${top?.title} (id: ${top?.id}, ${top?.year})`);
    } catch (e) {
      console.log(`  ✕ "${q}" → ${(e as Error).message}`);
    }
  }
}

interface Result { title: string; count: number; elapsed: string; sources: string[] }

async function testOne(id: number, title: string): Promise<Result> {
  const t0 = Date.now();
  try {
    const sources = await getSources('movie', String(id));
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const descs = sources.map(s => `${s.format.toUpperCase()} ${s.url.slice(0, 70)}`);
    return { title, count: sources.length, elapsed, sources: descs };
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    return { title, count: -1, elapsed, sources: [`ERROR: ${(e as Error).message.slice(0, 80)}`] };
  }
}

async function runBatch(items: typeof MOVIES) {
  return Promise.all(items.map(m => testOne(m.id, m.title)));
}

async function main() {
  const start = Date.now();
  console.log('═══════════════════════════════════════════════════════');
  console.log('  VidSync Bulk Source Test  —  20 Hollywood Movies');
  console.log('═══════════════════════════════════════════════════════');

  await testSearch();

  console.log('\n── Source Fetch (parallel batches of ' + BATCH + ') ────────────────');

  const allResults: Result[] = [];
  for (let i = 0; i < MOVIES.length; i += BATCH) {
    const batch = MOVIES.slice(i, i + BATCH);
    console.log(`\n  Batch ${Math.floor(i / BATCH) + 1}: ${batch.map(m => m.title.split(' ')[0]).join(', ')}…`);
    const results = await runBatch(batch);
    for (const r of results) {
      const icon  = r.count > 0 ? '✓' : r.count === 0 ? '○' : '✕';
      const label = pad(r.title, 44);
      console.log(`  ${icon} [${r.elapsed}s] ${label}  ${r.count < 0 ? 'error' : r.count + ' source(s)'}`);
      for (const s of r.sources) console.log(`          ${s}`);
    }
    allResults.push(...results);
  }

  const ok    = allResults.filter(r => r.count > 0).length;
  const empty = allResults.filter(r => r.count === 0).length;
  const err   = allResults.filter(r => r.count < 0).length;
  const total = ((Date.now() - start) / 1000).toFixed(0);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Results: ${ok} with sources  /  ${empty} empty  /  ${err} errors`);
  console.log(`  Total time: ${total}s`);
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(console.error).finally(() => process.exit(0));
