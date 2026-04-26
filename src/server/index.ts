import 'dotenv/config';
import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import session from 'express-session';
import { registerSocketHandlers } from '../sync/socket-handler';
import { hlsRouter } from '../proxy/hls';
import { shutdownBrowser } from '../extractor/playwright-extractor';
import { requireAuth, validateCredentials } from '../auth/index';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET ?? 'change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware as any);

// Auth gate — must come before static serving
app.use(requireAuth);

// Login routes
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    return res.redirect('/login?error=1');
  }
  const ok = await validateCredentials(username, password);
  if (!ok) {
    return res.redirect('/login?error=1');
  }
  (req.session as any).user = username;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Share session middleware with Socket.io
io.engine.use(sessionMiddleware as any);

// Socket.io auth gate
io.use((socket, next) => {
  const sess = (socket.request as any).session;
  if (sess?.user) return next();
  next(new Error('unauthorized'));
});

app.use(express.static(path.join(__dirname, '..', '..', 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/proxy', hlsRouter);

registerSocketHandlers(io);

const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => {
  console.log(`VidSync server running on port ${PORT}`);
});

async function shutdown(): Promise<void> {
  await shutdownBrowser();
  httpServer.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
