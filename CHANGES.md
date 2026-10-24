# ScopeDesk 3.2 — what changed and how to roll it out

## 1. Fix the two live problems first (no code needed)
1. **Redeploy the Railway service** with this code. It no longer crashes when `JWT_SECRET` is missing.
2. In Railway > Variables set `JWT_SECRET` (any long random string) and add a **Volume** mounted at `/data` with `DB_PATH=/data/scopedesk.db`.
   Your log shows the database at `/app/scopedesk.db`, which is wiped on every deploy (all accounts and tickets are lost).
3. `public/app-config.json` and `desktop/app-config.json` now contain
   `https://scopedesk-api-production.up.railway.app` (read from your GitHub screenshot). Change it if that is not your API address.
   The GitHub Pages screenshot showed "Cannot reach the ScopeDesk server" because `serverUrl` was empty there.

## 2. Why the vendor never saw the ticket
* The browser on GitHub Pages / Vercel could not reach Railway at all (empty `serverUrl`), and the server's CORS/Socket.IO allow-list only
  contained Railway's own address. Both fixed (`server/net-config.js`).
* A `task-request` event was only sent to a vendor who was **online at that moment** and **selected in the ticket form**. Now the server replays
  open requests when a vendor connects, and the vendor page refreshes on every (re)connect and every 15 s.
* Tickets created with "Any vendor with the token" are still invisible to vendors by design: the vendor must type the token.

## 3. File map
| File | Change |
|---|---|
| `server.js` | CORS + Socket.IO origins, never-crash JWT loader, replay of pending requests, build `2026-10-24-b` |
| `server/net-config.js` (new) + `server/test/` | JWT-secret loader and CORS rules, unit-tested |
| `server/remote-control.js` | accepts the new `open` (open-folder) frame |
| `public/webrtc.js` | rewritten: data channel -> Electron IPC, lockout freeze, `openFolder()`, no local WebSocket bridge |
| `public/script.js`, `public/index.html` | "Pair host agent" popup removed; agent starts when a ticket is created; vendor refresh; Open-folder box |
| `desktop/main.js` | agent forked at launch (standby), `init-session` IPC, input/freeze IPC, native Notification + lockout on violation |
| `desktop/preload.js` | `initSession` (`ipcRenderer.send('init-session')`), `sendInput`, `freezeInput`, `onLockout` |
| `desktop/agent-runner.js` | `warm / init / input / freeze / stop`, token over IPC (not env), auto re-warm |
| `agent/client-agent.js` | standby mode, IPC input, no open localhost port (`agent/bridge.js` and the `ws` dependency removed) |
| `agent/input-injector.js`, `agent/validate.js` | policy-checked `open` action; out-of-scope folder = violation |
| root `script.js`, `webrtc.js`, `style.css` | **deleted**: stale copies; the `alert('webrtc.js is running')` popup came from root `webrtc.js` |

## 4. Build the desktop app
```
cd agent   && npm install
cd ../desktop && npm install && npm run dist      # installer in desktop/dist
```
Windows: input cannot be injected into elevated (admin/UAC) windows unless the app itself runs elevated.
macOS: grant ScopeDesk **Accessibility** and **Screen Recording** in System Settings > Privacy & Security.
Linux: folder-restricted tasks are refused (no reliable way to read the folder a window shows); Wayland blocks input injection.

## 5. Two-machine test (what to check)
1. Client: open the desktop app, sign in, create a ticket for the vendor account. Vendor (other network): a toast appears within seconds.
2. Vendor accepts. Client clicks Share. Vendor sees the screen; clicks and keys land on the Client's PC.
3. Vendor types an allowed folder in "Open folder": File Manager opens it. Type a different folder: Client gets a **native OS notification**,
   the page shows the locked state, the stream and data channels are closed.
4. If video never connects across networks (symmetric NAT / mobile data), add a TURN server (`TURN_URLS`, `TURN_SECRET`).
