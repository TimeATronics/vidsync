import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';

// Hardcoded users: bcrypt hash of 'sunflower2905'
const users = new Map<string, string>([
  ['aradhya',   '$2b$10$mzqd42TCaaiseCe2fFxvdufsD8jQzPXIdenlhgrQHU6TptKPqB0qe'],
  ['priyanshi', '$2b$10$mzqd42TCaaiseCe2fFxvdufsD8jQzPXIdenlhgrQHU6TptKPqB0qe'],
]);

export async function validateCredentials(username: string, password: string): Promise<boolean> {
  const hash = users.get(username);
  if (!hash) {
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
