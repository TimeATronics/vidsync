import { Server, Socket } from 'socket.io';
import * as roomManager from './room-manager';
import { extract } from '../extractor/pipeline';
import { registerCdnHeaders } from '../proxy/hls';

export function registerSocketHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    let currentRoomId: string | null = null;

    // Rate-limit stream:load — max 3 per socket per 60 seconds
    let loadCount = 0;
    let loadWindowStart = Date.now();
    const LOAD_LIMIT = 3;
    const LOAD_WINDOW_MS = 60_000;

    socket.on('room:join', ({ roomId, role, displayName }: { roomId: string; role: 'host' | 'client'; displayName: string }) => {
      const result = roomManager.joinRoom(roomId, role, socket.id, displayName);

      if (!result.success) {
        socket.emit('room:error', {
          code: result.error,
          message: result.error === 'ROLE_TAKEN' ? `Role "${role}" is already taken in room "${roomId}"` : 'Room is full',
        });
        return;
      }

      currentRoomId = roomId;
      socket.join(roomId);

      socket.emit('room:joined', {
        roomId,
        role,
        peerConnected: !!result.peerDisplayName,
      });

      if (result.peerDisplayName) {
        const peerSocketId = roomManager.getPeerSocketId(roomId, socket.id);
        if (peerSocketId) {
          io.to(peerSocketId).emit('room:peer_joined', { displayName });
        }
      }
    });

    socket.on('room:leave', ({ roomId }: { roomId: string }) => {
      handleLeave(roomId);
    });

    socket.on('stream:load', async ({ url }: { url: string }) => {
      if (!currentRoomId) return;
      if (roomManager.getRole(currentRoomId, socket.id) !== 'host') return;

      // Rate-limit check
      const now = Date.now();
      if (now - loadWindowStart > LOAD_WINDOW_MS) { loadCount = 0; loadWindowStart = now; }
      if (loadCount >= LOAD_LIMIT) {
        socket.emit('stream:error', { code: 'EXTRACTION_FAILED', message: 'Too many requests — wait a minute' });
        return;
      }
      loadCount++;

      // SSRF guard: only allow http/https URLs
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error();
      } catch {
        socket.emit('stream:error', { code: 'UNSUPPORTED_SOURCE', message: 'Only http/https URLs are accepted' });
        return;
      }      const roomId = currentRoomId;
      socket.emit('stream:loading', {});

      // Direct MP4 pass-through — no extraction needed
      if (/\.mp4(\?|$)/i.test(parsedUrl.pathname + parsedUrl.search)) {
        const directUrl = parsedUrl.toString();
        socket.emit('stream:ready', { url: directUrl, format: 'mp4' });
        const p = roomManager.getPeerSocketId(roomId, socket.id);
        if (p) io.to(p).emit('stream:assigned', { url: directUrl, format: 'mp4' });
        return;
      }

      try {
        const { manifestUrl, headers } = await extract(parsedUrl.toString());
        registerCdnHeaders(manifestUrl, headers);

        const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
        const proxyManifestUrl = `${PUBLIC_URL}/proxy/manifest?url=${encodeURIComponent(manifestUrl)}`;

        socket.emit('stream:ready', { proxyManifestUrl });

        const peerSocketId = roomManager.getPeerSocketId(roomId, socket.id);
        if (peerSocketId) {
          io.to(peerSocketId).emit('stream:assigned', { proxyManifestUrl });
        }
      } catch (err) {
        console.error('[extract] failed for', parsedUrl.toString(), err);
        socket.emit('stream:error', {
          code: 'EXTRACTION_FAILED',
          message: 'Could not extract a playable stream from the provided URL',
        });
      }
    });

    // source:load — direct stream URL from sources API (skips extraction)
    socket.on('source:load', ({ url, format }: { url: string; format: 'hls' | 'mp4' }) => {
      if (!currentRoomId) return;
      if (roomManager.getRole(currentRoomId, socket.id) !== 'host') return;

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error();
      } catch {
        socket.emit('stream:error', { code: 'UNSUPPORTED_SOURCE', message: 'Invalid source URL' });
        return;
      }

      const roomId = currentRoomId;

      if (format === 'mp4') {
        const payload = { url: parsedUrl.toString(), format: 'mp4' };
        socket.emit('stream:ready', payload);
        const p = roomManager.getPeerSocketId(roomId, socket.id);
        if (p) io.to(p).emit('stream:assigned', payload);
        return;
      }

      // HLS: register headers and proxy the manifest
      const headers = {
        Referer: 'https://rivestream.org/',
        Origin: 'https://rivestream.org',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      };
      registerCdnHeaders(parsedUrl.toString(), headers);
      const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
      const proxyUrl = `${PUBLIC_URL}/proxy/manifest?url=${encodeURIComponent(parsedUrl.toString())}`;
      const payload = { url: proxyUrl, format: 'hls' };
      socket.emit('stream:ready', payload);
      const p = roomManager.getPeerSocketId(roomId, socket.id);
      if (p) io.to(p).emit('stream:assigned', payload);
    });

    // ── Playback commands (Host → Server → Client) ────────────────────────

    for (const event of ['player:play', 'player:pause', 'player:seek'] as const) {
      socket.on(event, ({ position }: { position: number }) => {
        if (!currentRoomId) return;
        if (roomManager.getRole(currentRoomId, socket.id) !== 'host') return;

        if (event === 'player:play' || event === 'player:pause') {
          roomManager.updateHostState(currentRoomId, {
            position,
            playing: event === 'player:play',
            timestamp: Date.now(),
          });
        }

        const peerSocketId = roomManager.getPeerSocketId(currentRoomId, socket.id);
        if (peerSocketId) io.to(peerSocketId).emit(event, { position });
      });
    }

    // ── Heartbeat & drift correction ──────────────────────────────────────

    socket.on('player:heartbeat', ({ position, playing, timestamp }: { position: number; playing: boolean; timestamp: number }) => {
      if (!currentRoomId) return;
      if (roomManager.getRole(currentRoomId, socket.id) !== 'host') return;

      roomManager.updateHostState(currentRoomId, { position, playing, timestamp });
    });

    // Called by Client every 5s to allow server to compute drift
    socket.on('player:position_report', ({ position }: { position: number }) => {
      if (!currentRoomId) return;
      if (roomManager.getRole(currentRoomId, socket.id) !== 'client') return;

      const hostState = roomManager.getHostState(currentRoomId);
      if (!hostState || !hostState.playing) return;

      const elapsed = (Date.now() - hostState.timestamp) / 1000;
      const correctedPosition = hostState.position + elapsed;
      const drift = Math.abs(position - correctedPosition);

      if (drift > 2.5) {
        socket.emit('player:correction', { position: correctedPosition, playing: hostState.playing });
      } else if (drift > 1.0) {
        socket.emit('player:catchup', { targetPosition: correctedPosition, rate: 1.08 });
      }
    });

    // ── Buffer hold / resume ──────────────────────────────────────────────

    socket.on('player:buffer_start', ({ position, role }: { position: number; role: 'host' | 'client' }) => {
      if (!currentRoomId) return;
      if (roomManager.getRole(currentRoomId, socket.id) !== role) return;

      roomManager.setBuffering(currentRoomId, role, true);

      const reason = role === 'host' ? 'host_buffering' : 'client_buffering';
      io.to(currentRoomId).emit('player:hold', { reason });

      // If host is buffering, update hostState to paused at this position
      if (role === 'host') {
        const hs = roomManager.getHostState(currentRoomId);
        if (hs) {
          roomManager.updateHostState(currentRoomId, { ...hs, position, playing: false, timestamp: Date.now() });
        }
      }
    });

    socket.on('player:buffer_end', ({ position, role }: { position: number; role: 'host' | 'client' }) => {
      if (!currentRoomId) return;
      if (roomManager.getRole(currentRoomId, socket.id) !== role) return;

      roomManager.setBuffering(currentRoomId, role, false);

      // Resume only when both peers have cleared their buffer
      if (!roomManager.isAnyoneBuffering(currentRoomId)) {
        const hostState = roomManager.getHostState(currentRoomId);
        const resumePosition = role === 'host' ? position : (hostState?.position ?? position);
        io.to(currentRoomId).emit('player:resume', { position: resumePosition });
      }
    });

    socket.on('disconnect', () => {
      if (currentRoomId) handleLeave(currentRoomId);
    });

    function handleLeave(roomId: string): void {
      const peerSocketId = roomManager.getPeerSocketId(roomId, socket.id);
      roomManager.leaveRoom(roomId, socket.id);
      socket.leave(roomId);
      currentRoomId = null;

      if (peerSocketId) {
        io.to(peerSocketId).emit('room:peer_left', {});
      }
    }
  });
}
