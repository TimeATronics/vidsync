# VidSync — Frontend Design & Implementation

## Design Direction: Late-Night Private Cinema

**Purpose**: A two-person private watch party. Intimate, focused, distraction-free. The video is the hero. Everything else gets out of the way.

**Tone**: Cinema Noir — deep near-black, warm amber accents, a serif italic logo that looks like a film title card. The feeling of watching a film at midnight, just the two of you.

**What makes it memorable**: The `Fraunces` optical-size italic serif is completely unexpected in a web app — it reads like a vintage cinema marquee. Paired with IBM Plex Mono for all functional UI text, the contrast between the editorial and the technical creates a distinctive voice.

---

## Tech Stack

| Concern | Choice | Reason |
|---|---|---|
| Markup/Style/Logic | Single HTML file (`public/index.html`) | Zero build step, zero dependencies, easy to serve statically |
| HLS playback | [HLS.js](https://cdn.jsdelivr.net/npm/hls.js@1) via CDN | Required for Android Chrome (no native HLS) |
| Realtime sync | Socket.io client (served by same Express server) | Consistent with backend |
| Fonts | Google Fonts (Fraunces + IBM Plex Mono) | Loaded async, no FOUT flash |
| Framework | None | Lightweight requirement; vanilla JS is ~250 lines |

---

## Color System

```css
--bg:          #07060A  /* near-black, slight warm-purple */
--surface:     #0F0D13  /* panels */
--surface-2:   #181621  /* hold banner */
--border:      #28242F  /* resting borders */
--border-lit:  #3C3645  /* active/hover borders */
--accent:      #C97C2E  /* warm amber — the signature color */
--text:        #EDE8DF  /* warm white */
--text-mid:    #9A9490  /* secondary text */
--text-dim:    #5A5654  /* labels, placeholders */
--danger:      #C44040  /* errors */
--success:     #4A9968  /* peer connected dot */
```

---

## Typography

- **Display** — `Fraunces` (variable optical-size serif, italic 300 weight): logo, role names
- **Mono** — `IBM Plex Mono` (400/500): all labels, times, codes, UI chrome

---

## Application Views

### 1. Join Screen

Centered card (max 340px), staggered fade-up entrance (3-step animation delay). Three input areas:

- **Room code** — text field; the shared identifier for the session
- **Your name** — displayed to your peer on join
- **Role selector** — Host (controls playback) / Guest (watches along); radio cards with amber highlight on selection

### 2. Watch Room Layout (top → bottom, flex column)

```
┌────────────────────────────────────┐
│ VS  [room-code]  [role]    ● Peer  │  ← header
├────────────────────────────────────┤
│ [HOST ONLY] stream url input [Load]│  ← stream loader
├────────────────────────────────────┤
│ status text                        │
├────────────────────────────────────┤
│                                    │
│      VIDEO (16:9 aspect ratio)     │  ← player
│      with overlay for loading      │
│                                    │
├────────────────────────────────────┤
│ ⏸ host is buffering…              │  ← hold banner (shown/hidden)
├────────────────────────────────────┤
│ ↻ resynced                        │  ← sync notification
├────────────────────────────────────┤
│ ───────────────────────────────── │  ← seek bar
│  ▶  0:00 / 0:00          🔊 ████ │  ← controls
└────────────────────────────────────┘
```

---

## Mobile Considerations

- `viewport-fit=cover` + `user-scalable=no` — prevents double-tap zoom on controls
- `apple-mobile-web-app-capable` — enables home screen shortcut on iOS (partial PWA)
- `meta theme-color` — Android status bar matches the UI background
- **Autoplay gate**: `player:play` from the server may arrive before a user gesture. The app buffers the command in `state.pendingPlay` and executes it on the next user tap (via a `document` click listener)
- Seek bar has a `touchstart` listener (passive) for mobile scrubbing
- All interactive targets are ≥ 34px tall for comfortable touch

---

## Sync Logic (Client-Side)

| Server event | Client action |
|---|---|
| `player:play { position }` | Seek + play; buffer if autoplay blocked |
| `player:pause { position }` | Seek + pause |
| `player:seek { position }` | Seek; resume if was playing |
| `player:correction { position }` | Hard seek; resume |
| `player:catchup { targetPosition, rate }` | Set `playbackRate = 1.08`; poll until past target |
| `player:hold` | Pause; show hold banner |
| `player:resume { position }` | Hide banner; seek; resume if playing |

**Host emits** (every 5s while playing): `player:heartbeat { position, playing, timestamp }`  
**Guest emits** (every 5s while playing): `player:position_report { position }`

---

## File

All frontend code lives in a single file: [`public/index.html`](public/index.html)

It is served statically by Express from the `/` route. No build step required. Total size: ~12 KB uncompressed.

---

## Serving from Express

The server was updated to serve `public/` as static files:

```typescript
import path from 'path';
// ...
app.use(express.static(path.join(__dirname, '..', '..', 'public')));
```

The `__dirname` path works for both `ts-node` (runs from `src/server/`) and the compiled output (runs from `dist/server/`), since `public/` sits at the project root two levels up from both.
