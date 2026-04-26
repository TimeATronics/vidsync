import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';

// Parse AUTH_USERS env var: "alice:$2b$10$hash1,bob:$2b$10$hash2"
function parseUsers(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = process.env.AUTH_USERS ?? '';
  for (const entry of raw.split(',')) {
    const idx = entry.indexOf(':');
    if (idx > 0) {
      map.set(entry.slice(0, idx).trim(), entry.slice(idx + 1).trim());
    }
  }
  return map;
}

const users = parseUsers();

export async function validateCredentials(username: string, password: string): Promise<boolean> {
  const hash = users.get(username);
  if (!hash) {
    // Run a dummy compare to avoid timing-based username enumeration
    await bcrypt.compare(password, '$2b$10$invalidhashpaddingtomatchlength123456789012');
    return false;
  }
  return bcrypt.compare(password, hash);
}

const OPEN_PATHS = ['/login', '/favicon.ico'];

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (OPEN_PATHS.some(p => req.path === p || req.path.startsWith(p + '.'))) {
    return next();
  }
  if ((req.session as any).user) return next();
  res.redirect('/login');
}
