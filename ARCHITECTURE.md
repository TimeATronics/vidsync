# VidSync Backend Architecture Blueprint

## 1. Patterns & Conventions Found (from DESIGN.md)

- **Two-user model**: strictly a Host + one Client (not a multi-room broadcast system). This constraint allows aggressive simplicity.
- **Ephemeral rooms**: no persistent storage of room state; in-memory is sufficient.
- **Mobile-first**: the Android buffering case is a first-class concern, not an afterthought.
- **Cost-zero target**: DigitalOcean basic droplet. CPU/RAM budget is ~1 vCPU / 1GB RAM. This rules out always-on headless browsers.

---

## 2. Stream Extraction: Decision & Rationale

### Why a simple HTTP proxy is NOT enough

Providers like `vidsrc.to`, `vidzee`, and their aggregators (e.g., `voidflix.pages.dev/watch/...`) do the following:

1. The iframe source page executes JavaScript that assembles a signed, time-limited token and appends it to the `.m3u8` URL. The URL itself does not exist in the raw HTML.
2. The `.m3u8` manifest is served with a `Referer` check — requests without the correct origin domain return `403`.
3. Some providers add a Cloudflare Turnstile or similar JS challenge on the embed page before any media URL is disclosed.

A simple `fetch()` relay with spoofed headers will work for ~10% of providers. It will fail for vidsrc/vidzee entirely.

### Chosen Strategy: Two-Tier Extraction Pipeline with HLS Re-proxy

**Tier 1 — yt-dlp subprocess** (fast path, ~1–4 seconds)

`yt-dlp` has maintained extractors for vidsrc and dozens of similar embed providers. It handles JS token assembly internally by embedding a lightweight JS engine (PhantomJS-free). It outputs the raw `.m3u8` URL and the required headers (`Referer`, `Origin`, `User-Agent`) as JSON.

- Spawn `yt-dlp --dump-json --no-download <url>` as a child process.
- Parse the `formats` array for the highest-quality `m3u8_native` entry.
- Capture the `http_headers` field — these headers must be replayed on every subsequent HLS segment fetch.
- **Success rate**: ~70% of embed providers that have a yt-dlp extractor.

**Tier 2 — Playwright headless browser** (slow path, ~8–20 seconds, fallback only)

When Tier 1 fails (exit code non-zero, or no `.m3u8` in output):

- Launch a persistent Playwright Chromium instance (not one-per-request — one shared instance, new page per extraction).
- Navigate to the embed URL with a spoofed `Referer` that matches what the provider expects.
- Intercept network requests via `page.on('request', ...)` and capture the first request whose URL matches `*.m3u8*`.
- Terminate the page immediately after capture.
- This handles JS challenges, dynamic token generation, and anti-hotlink schemes.

**Why not Playwright-only?** A 1GB droplet can hold one Chromium instance but the startup cost is 15+ seconds cold and ~8 seconds warm. For a two-person app this is tolerable only as a fallback.

**HLS Re-proxy (mandatory for both tiers)**

Once the `.m3u8` URL is obtained, it cannot be handed directly to the client's `<video>` element because:
- Segment URLs inside the manifest also carry referer-locked tokens.
- Mobile browsers enforce CORS — cross-origin HLS manifests without `Access-Control-Allow-Origin: *` will be blocked.

The server must:
1. Fetch the `.m3u8`, rewrite all relative/absolute segment URLs to point back through the server's own `/proxy/segment?url=<encoded>&token=<hmac>`.
2. Serve the rewritten manifest with `Content-Type: application/x-mpegurl` and `Access-Control-Allow-Origin: *`.
3. On segment requests, reverse-proxy the segment to the CDN with the captured headers attached. Do NOT cache segments on disk — stream them through directly to avoid storage costs.

**URL caching**: extracted `.m3u8` root URLs must be cached in-memory with a TTL of ~4 hours (typical token expiry). Key: `SHA256(inputUrl)`.

---

## 3. WebSocket (Socket.io) Event Schema

### Design Principles

- **Host is the single source of truth**. Clients never push their position to the host; they only report their readiness and buffering state.
- **Correction over command**: the server does not continuously push state. It sends corrections when drift exceeds a threshold, not on every tick.
- **Mobile buffering is a pause trigger, not an error**: when the Host buffers, all Clients pause. When a Client buffers, the Host is paused (soft hold). This prevents the Client from falling irreparably behind.

---

### Room & Role Events

```
CLIENT → SERVER
  room:join       { roomId: string, role: "host" | "client", displayName: string }
  room:leave      { roomId: string }

SERVER → CLIENT (acknowledgement)
  room:joined     { roomId: string, role: "host" | "client", peerConnected: boolean }
  room:peer_joined  { displayName: string }
  room:peer_left    {}
  room:error      { code: "ROOM_FULL" | "ROOM_NOT_FOUND" | "ROLE_TAKEN", message: string }
```

---

### Stream Loading Events

```
CLIENT → SERVER  (Host only)
  stream:load     { url: string }   // raw user-pasted URL

SERVER → CLIENT  (Host only, in response)
  stream:loading  {}
  stream:ready    { proxyManifestUrl: string }  // rewritten .m3u8 URL via our server
  stream:error    { code: "EXTRACTION_FAILED" | "UNSUPPORTED_SOURCE", message: string }

SERVER → CLIENT  (broadcast to Client)
  stream:assigned { proxyManifestUrl: string }  // same URL, served to Client
```

---

### Playback Sync Events

#### Host → Server → Client (commands)

```
CLIENT → SERVER  (Host only)
  player:play     { position: number }   // seconds, current timestamp when play pressed
  player:pause    { position: number }
  player:seek     { position: number }

SERVER → CLIENT  (broadcast to Client, relayed immediately)
  player:play     { position: number }
  player:pause    { position: number }
  player:seek     { position: number }
```

#### Heartbeat & Drift Correction

```
CLIENT → SERVER  (Host only, every 5 seconds while playing)
  player:heartbeat  { position: number, playing: boolean, timestamp: number }
  // `timestamp` = Date.now() on the host — used to correct for network latency

SERVER → CLIENT  (Client only, emitted by server when drift > threshold)
  player:correction { position: number, playing: boolean }
  // Server calculates: correctedPosition = hostPosition + (now - hostTimestamp) / 1000
  // Threshold: abs(clientPosition - correctedPosition) > 2.5 seconds
```

The server owns the correction logic. The client sends its position in the buffer report (below), and the server computes drift inline. The Client does not need a separate heartbeat event.

#### Buffering Events (critical for mobile)

```
CLIENT → SERVER  (both Host and Client)
  player:buffer_start  { position: number, role: "host" | "client" }
  player:buffer_end    { position: number, role: "host" | "client" }

SERVER → CLIENT  (broadcast to both peers when buffer state changes)
  player:hold    { reason: "host_buffering" | "client_buffering" }
  // Both players should pause locally. Client does NOT seek.
  player:resume  { position: number }
  // Emitted when buffer clears. Position is host's confirmed position.
```

**Mobile buffering rule**:
- `host_buffering` → server immediately broadcasts `player:hold` to all. Client pauses.
- `client_buffering` → server broadcasts `player:hold` to Host (Host pauses). Prevents Client from falling behind.
- Both cases resolve with `player:resume` when the buffering peer emits `player:buffer_end`. Server waits for both peers to confirm `buffer_end` before emitting `resume`.

#### Catch-up (soft re-sync, no jarring seek)

```
SERVER → CLIENT  (Client only)
  player:catchup  { targetPosition: number, rate: 1.08 }
  // Emitted instead of player:correction when drift is 1.0–2.5 seconds
  // Client sets playbackRate = 1.08 until position reaches targetPosition, then resets to 1.0
  // If drift > 2.5s, use hard player:correction (seek) instead
```

---

### Full Event Taxonomy (summary table)

| Event | Direction | Emitter | Purpose |
|---|---|---|---|
| `room:join` | C→S | Client/Host | Enter room |
| `room:leave` | C→S | Client/Host | Exit room |
| `room:joined` | S→C | Server | Confirm join, role assigned |
| `room:peer_joined` | S→C | Server | Notify other peer connected |
| `room:peer_left` | S→C | Server | Notify peer disconnected |
| `stream:load` | C→S | Host only | Submit URL for extraction |
| `stream:ready` | S→C | Server | Extraction complete, manifest URL |
| `stream:assigned` | S→C | Server | Push manifest to Client |
| `player:play` | C→S, S→C | Host→Server→Client | Play command |
| `player:pause` | C→S, S→C | Host→Server→Client | Pause command |
| `player:seek` | C→S, S→C | Host→Server→Client | Seek command |
| `player:heartbeat` | C→S | Host only | Position tick every 5s |
| `player:correction` | S→C | Server→Client | Hard seek correction (drift >2.5s) |
| `player:catchup` | S→C | Server→Client | Soft speed-up correction (drift 1–2.5s) |
| `player:buffer_start` | C→S | Host or Client | Buffering began |
| `player:buffer_end` | C→S | Host or Client | Buffering cleared |
| `player:hold` | S→C | Server | Pause both (someone buffered) |
| `player:resume` | S→C | Server | Both buffered-clear, play from position |

---

## 4. Component Design

### `extractor/pipeline.ts`
**Responsibilities**: Orchestrate Tier 1 → Tier 2 fallback, return `{ manifestUrl, headers }`. Consult in-memory cache first.
**Dependencies**: child_process (yt-dlp), Playwright

### `extractor/cache.ts`
**Responsibilities**: In-memory Map with TTL eviction. Key: SHA-256 of input URL. TTL: 4 hours.
**Dependencies**: Node `crypto`

### `proxy/hls.ts`
**Responsibilities**: Express middleware. Route `/proxy/manifest` rewrites `.m3u8`. Route `/proxy/segment` reverse-proxies a segment. HMAC-signs segment URLs to prevent abuse.
**Dependencies**: `node-fetch` or `axios`, `crypto` (for HMAC)

### `sync/room-manager.ts`
**Responsibilities**: In-memory room registry. Tracks `{ host, client, hostState, bufferState }`. Computes drift and emits corrections.
**Dependencies**: None

### `sync/socket-handler.ts`
**Responsibilities**: Registers all Socket.io event listeners. Delegates to room-manager.
**Dependencies**: `socket.io`, room-manager

### `server/index.ts`
**Responsibilities**: Express app + Socket.io server. Mounts HLS proxy middleware. Handles graceful shutdown of Playwright.
**Dependencies**: `express`, `socket.io`, `https`

---

## 5. Required Dependencies

| Package | Purpose |
|---|---|
| `express` | HTTP server, HLS proxy routes |
| `socket.io` | WebSocket sync engine |
| `playwright` (chromium only) | Tier 2 headless extraction |
| `yt-dlp` (system binary) | Tier 1 extraction subprocess |
| `node-fetch` or `undici` | Segment reverse-proxy, manifest fetch |
| `crypto` (Node built-in) | HMAC segment URL signing, cache keys |
| `dotenv` | Environment config |

No database. No Redis. In-memory state is sufficient for a two-user app; the server restart clears rooms gracefully since both clients reconnect and re-load.

---

## 6. Build Sequence (Phased)

- [ ] **Phase 1 — Skeleton**: Express + Socket.io server boots; `room:join`, `room:leave`, `room:joined`, `room:peer_joined` work end-to-end
- [ ] **Phase 2 — HLS Proxy**: `/proxy/manifest` and `/proxy/segment` routes functional with hardcoded test `.m3u8`; HMAC signing in place
- [ ] **Phase 3 — Extractor Tier 1**: yt-dlp subprocess wrapper; cache module; `stream:load` → `stream:ready` flow with yt-dlp
- [ ] **Phase 4 — Extractor Tier 2**: Playwright fallback; shared browser instance lifecycle; fallback invoked on yt-dlp failure
- [ ] **Phase 5 — Sync Core**: `player:play/pause/seek` relay; heartbeat; server-side drift calculation; `player:correction` and `player:catchup` emission
- [ ] **Phase 6 — Buffer Handling**: `player:buffer_start/end` → `player:hold/resume`; two-peer buffer-clear gate
- [ ] **Phase 7 — Hardening**: HMAC validation on segment proxy; rate-limit `stream:load`; Playwright page timeout + cleanup

---

## 7. Critical Details

**Security**: The `/proxy/segment` route must verify the HMAC signature to prevent the server from being used as an open proxy for arbitrary URLs. Sign with a server secret: `HMAC-SHA256(segmentUrl + expiry, SECRET_KEY)`.

**Playwright instance lifecycle**: One shared browser, one page per extraction, page closed immediately after `.m3u8` capture. Never leave idle pages open — they hold ~50MB RAM each.

**yt-dlp binary**: Must be installed on the droplet and kept updated (providers break extractors regularly). Pin a version and add a weekly cron update.

**Mobile autoplay**: The client will receive `player:play` from the server before the user has interacted with the page. iOS/Android both require a user gesture before `video.play()` succeeds. The frontend must buffer the `player:play` command and execute it only after the first user tap — the sync engine must account for this 1–3 second gate.

**Drift clock skew**: Host and Client clocks are not synchronized. The heartbeat `timestamp: Date.now()` approach introduces error proportional to `RTT/2`. For two people on home wifi/LTE this is acceptable (<50ms). If needed in Phase 7, add a clock-sync handshake (client sends `ping:timestamp`, server echoes back, client computes offset).