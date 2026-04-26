import crypto from 'crypto';

interface CacheEntry {
  manifestUrl: string;
  headers: Record<string, string>;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();
const TTL_MS = 4 * 3600 * 1000; // 4 hours

function hash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex');
}

export function get(inputUrl: string): { manifestUrl: string; headers: Record<string, string> } | null {
  const key = hash(inputUrl);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { store.delete(key); return null; }
  return { manifestUrl: entry.manifestUrl, headers: entry.headers };
}

export function set(inputUrl: string, manifestUrl: string, headers: Record<string, string>): void {
  store.set(hash(inputUrl), { manifestUrl, headers, expiresAt: Date.now() + TTL_MS });
}
