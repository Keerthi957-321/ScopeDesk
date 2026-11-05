# Update 15 (build 2026-11-05-v15): simpler layout, Remote Connection hub, Specific Window Only sharing

| Change | Files |
|---|---|
| Removed the Command Center dashboard and every KPI tile (Analytics keeps its charts only). Clients land on Tickets, vendors on My Tasks | `public/index.html`, `public/workspace.js`, `public/script.js` |
| Premium membership badge in the top bar (gold "Premium Member", "Premium Trial" with "Keep Premium", "Free plan" with "Upgrade"); the sidebar plan card is gone | `public/index.html`, `public/workspace.js`, `public/theme.css` |
| NEW Remote Connection hub: live status ("Remote Access Enabled: Specific Window Only" / "Entire Screen" / ready / off), session facts, share / remote control / Terminate Session Now, and the two share modes as big cards | `public/index.html`, `public/workspace.js`, `public/theme.css` |
| NEW share mode, enforced, not just displayed: "Specific Window Only" (default) hides whole screens in the browser picker and lists only windows in the desktop picker (nothing is pre-selected, no fallback to the main screen); a whole screen captured anyway is stopped at once and refused. Same check when changing what is shared | `public/share-mode.js`, `public/screen-share.js`, `public/webrtc.js`, `public/script.js` |
| Share dialog: "What to share" switch and texts that follow the mode | `public/index.html`, `public/script.js` |
| Tests | `test/share-mode.test.js` |

# Update 14 (build 2026-11-05-v12): host agent never started (fixed), membership plans, AI assistant

| Change | Files |
|---|---|
| FIX: "Start remote control" never worked. `validateAgentConfig` dropped the `manual` flag, so `main.js` ignored every start as "not an explicit start by the Client" and the host agent never ran. Needs a rebuilt / restarted desktop app | `desktop/validate.js`, `desktop/test/validate.test.js` |
| Plans: 30-day free trial (all tasks free + AI assistant) -> Free (3 tasks of up to 15 min a month, then pay per task, no assistant) -> Membership (monthly / yearly via Razorpay: unlimited tasks + assistant). Worked out from `users.created_at` and `users.membership_until` on every request | `server/billing.js`, `server.js`, `db.js` |
| `GET /api/billing/status`, `POST /api/membership/checkout`; `POST /api/payments/verify` now also activates / extends memberships (renewals stack) | `server.js` |
| AI assistant: `POST /api/chat`, OpenAI called from the server (key never sent to browsers), plan checked on every message, rate-limited, system messages from the page refused | `server/assistant.js`, `server.js` |
| Plan card in the sidebar, plans dialog, chat widget; ticket form text for trial / member | `public/membership.js`, `public/index.html`, `public/style.css`, `public/script.js` |
| Tests | `test/membership.test.js`; existing billing tests use clients past the trial |

# Update 13 (build 2026-11-05-v11): Razorpay payments + hard "Terminate Session Now"

## Payments (Razorpay)
| Change | Files |
|---|---|
| NEW billing rules module: 3 free tasks per calendar month (each up to 15 min), then paid; price table in rupees, charged in paise; Razorpay Orders API + HMAC signature check (no SDK). Payments switch OFF (every task free and unlimited) when either key is missing | `server/billing.js` |
| `GET /api/billing/quote` (display only), `POST /api/tasks` now decides free vs paid **from the database**. The free-allowance check and the insert are one SQL statement, so two tabs cannot both take the last free task. Paid requests get a Razorpay order and no task yet | `server.js` |
| `POST /api/payments/verify`: signature-verified, owner-only, claim-once; the task is created from the request stored with the order, never from what the browser sends after paying | `server.js` |
| New columns `tasks.billing / billing_month / amount_paise / payment_order_id`, new table `payment_orders` (migrated automatically) | `db.js` |
| Ticket form shows "This task is FREE - N of 3 free tasks left this month" or "Pay ₹X & Issue Token"; Razorpay's script is only loaded when the server says payment is needed | `public/script.js`, `public/index.html`, `public/style.css` |
| Desktop app: Razorpay's netbanking / 3-D Secure popup opens inside the app (sandboxed) instead of being thrown to the external browser | `desktop/main.js` |
| `.env.example`: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, optional `TASK_PRICES_INR`, `BILLING_TIMEZONE` | `.env.example` |

## Remote access: hard termination
| Change | Files |
|---|---|
| FIX: `clearLive()` called `ScopeDeskDesktop.endTask()`, which was missing from the shipped bridge. In the desktop app this threw, so the host agent was never stopped from the Client's side and the rest of the cleanup was skipped. Bridge restored (`endTask`, ordered status events, `manual` flag); this also fixes the 3 failing bridge tests | `public/desktop-bridge.js` |
| "Terminate Session Now" (alert dialog, breach banner, and NEW on the breach overlay): kills the host agent and WebRTC on this PC first, then terminates over the WebSocket, falling back to HTTPS if the socket is down or silent for 4 s | `public/script.js`, `public/index.html`, `public/style.css` |
| Token revocation: `tasks.token_revoked` is set on terminate / expiry / completion. A revoked task refuses the vendor token, host-agent WebSocket handshakes (checked in `io.use`), `/api/agent/scope` and new agent tokens | `server.js`, `db.js` |
| `terminateTask` flips the status atomically and is idempotent: pressing the button after a breach auto-terminated the task now reports success (it used to say "Could not terminate the session") and re-runs the teardown | `server.js` |
| NEW `POST /api/tasks/:id/terminate` (owner-only HTTPS kill switch) | `server.js` |
| `cutStream` also removes each socket's stream permission, not only its room membership | `server.js` |
| FIX: completing a session now closes the host agent (it used to keep running until the original window ran out) | `server.js` |
| Desktop: a task-ending stop force-kills the agent after 0.6 s (was 1.5 s) | `desktop/agent-runner.js` |
| Tests: `test/billing.test.js`, `test/billing-off.test.js`, `test/kill-switch.test.js`, harness `test/helpers/server-harness.js` (loads the real server.js with stub packages) | `test/` |

# Update 12 (build 2026-10-29-v10): window sessions with control, click-through past ScopeDesk, visible start errors

| Change | Files |
|---|---|
| Sharing ONE window now allows control of that window (AnyDesk-style window session): positions are mapped onto the window's current rectangle and the window is brought to the front on each click. Falls back to watch-only only if the OS cannot locate the window | `agent/input-injector.js`, `desktop/main.js` |
| ScopeDesk's own window in front is neutral: the vendor's clicks pass through to the approved app behind it (keys never), no violation. A click that brings an UNAPPROVED app forward is still a violation | `agent/monitor.js`, `agent/client-agent.js` |
| The vendor can never click inside the ScopeDesk window (Stop, Terminate, alert switches stay the Client's) | `agent/input-injector.js`, `desktop/main.js`, `desktop/agent-runner.js` |
| "Host agent: not running" now says why (refused start, or the last reason it stopped); the agent's log is printed in the terminal that runs `npm start` | `public/script.js`, `desktop/main.js` |

Tests: root 168/168, desktop 40/40, agent 53/54 (active-win not installable in the test sandbox).

---

# Update 11 (build 2026-10-29-v9): stale host agent, screen/window picker, faster connection

**"The host agent stopped: viewOnly is not defined"** does not come from the v8 files: in every agent version since v6, `viewOnly`
only appears where it is defined (`connect(token, viewOnly = false, ...)`), and `onHello()` reads `viewOnlyMode`. That error is
the crash of an OLDER `client-agent.js` (from before v6, when `onHello()` read a variable that only existed inside `connect()`).
It happens when the Windows app is an old installed / `dist` build, or when the agent folder was not copied. From now on:
- the agent sends `protocol: 9` with its hello; the server refuses older agents with "This ScopeDesk desktop app is out of date..."
  (`server/remote-control.js`), so an old app shows that sentence instead of crashing;
- the desktop app checks the agent it forks; a mismatched agent is reported and Start is refused with the fix (`desktop/agent-runner.js`);
- the build stamp is now `2026-10-29-v9` (bottom-right of the page and `/api/health`), so you can see what Railway serves.

| Change | Files |
|---|---|
| Screen / window picker in the share dialog (desktop app): tiles with thumbnails for every screen and window (ScopeDesk itself excluded). Screen = remote control; one window = watch only (input off on the agent, both sides told why). "Change what I share" swaps it live | `desktop/main.js`, `desktop/preload.js`, `desktop/display-media-handler.js`, `public/script.js`, `public/index.html`, `public/style.css`, `agent/input-injector.js`, `agent/client-agent.js` |
| In a normal browser the native picker offers Entire screen / Window / Tab (window and tab are watch-only) | `public/webrtc.js` |
| Server relay starts after 5 s without a direct link (was 12-16 s), and at once when ICE fails | `public/webrtc.js` |
| Codec order VP8 > H.264 > VP9 > AV1, 30 fps cap, 3 Mbit/s, keep resolution (sharp text) | `public/webrtc.js` |

The real cause of "Still connecting..." across networks is that no TURN relay is configured (`/api/health` shows `"relay":false`):
direct WebRTC cannot pass most home/mobile NATs. The server relay now shows the screen within ~5 s; TURN gives full speed (RAILWAY.md).

---

# Update 10: every OS combination, any network, AnyDesk-style tools inside the approved scope

| Need | What was added | Files |
|---|---|---|
| **Windows <-> Mac <-> Linux keyboard** | Each key carries the vendor's OS. Windows/Linux vendor on a Mac: Ctrl is pressed as Cmd (Ctrl+C copies). Mac vendor on Windows/Linux: Cmd+C/V/X/Z/A/S/F... become Ctrl+letter. Blocked everywhere: Alt+Tab, Alt+F4, Alt+Esc, Ctrl+Esc, Ctrl+Shift+Esc, Win key, Cmd+Tab, Cmd+Space, Cmd+Q, Force Quit, Ctrl+Cmd+Q, Mac Ctrl+arrows | `agent/input-injector.js`, `public/remote-input.js`, `agent/validate.js`, `server/remote-control.js` |
| **Any keyboard layout** | Printable characters (é, @, €, Hindi, IME input) are typed as characters, not as key positions | same |
| **Copy/paste** | Ctrl/Cmd+V on the vendor's side pastes the vendor's copied text inside the approved app (up to 4000 characters). Vendor -> Client only: the Client's clipboard is never sent to the vendor | same |
| **Different networks without TURN** | If the direct WebRTC link is not up after ~12 s, the vendor's page asks for a **server relay**: the Client's page sends ~5 JPEG pictures/second (max 1280 px wide) through the ScopeDesk server. Input already uses the server relay. WebRTC keeps retrying and takes over when it connects. TURN (RAILWAY.md) is still recommended for full speed | `public/webrtc.js`, `server.js` |
| **Several monitors** | The share dialog lists the Client's screens; "Switch screen" in the live bar swaps the shared monitor without reconnecting. The agent maps the pointer onto the chosen display (Windows scaling handled) | `desktop/main.js`, `desktop/preload.js`, `desktop/display-media-handler.js`, `desktop/agent-runner.js`, `public/script.js`, `public/index.html` |
| **File transfer** | Vendor workspace: "Send file" button or drag-and-drop. Saved ONLY in a folder the task approved, max 25 MB, programs/scripts refused, never overwrites, both screens told, audit-logged. No download direction | `agent/file-receiver.js`, `server/remote-control.js`, `public/remote-viewport.*` |
| **Linux** | Wayland sessions are detected and the Client is told exactly how to switch to Xorg (control needs X11) instead of failing silently | `desktop/main.js` |
| **Scope warnings** | The task form warns when a web browser is allowed (it opens every website and local file) | `public/script.js`, `public/index.html` |

Tests: root 166/166, desktop 36/36, agent 48/49 (the one failure needs the real `active-win` package, unavailable in the test sandbox,
and fails the same way on the original files). New: `agent/test/cross-os-keys.test.js`, `agent/test/file-receiver.test.js`,
`test/remote-features.test.js`, `desktop/test/multi-monitor.test.js`, more cases in `agent/test/remote-control-e2e.test.js`.

---

# Update 9: remote control really controls the Client's PC, the Start/Stop button no longer flips, Stop revokes access on the server

## Root causes (found in the code, reproduced by tests against the uploaded files)
1. **The host agent received events for OTHER tasks.** `server.js` registered the agent's socket under the Client's user id, so
   `emitToUser(client, 'session-ended' | 'control-halt' | 'control-resume')` for ANY ticket of that Client reached it, and
   `agent/client-agent.js` ignored the `taskId`. When another ticket expired (the 15 s sweep) or was terminated, the running agent shut
   down: remote control died and the button went back to "Start remote control" without a click. A `control-resume` for another task
   could even unlock a locked agent. Reproduced: event for task 99 -> agent of task 7 `running > stopped ("Session ended.")`.
2. **Approved apps never matched the real process.** The task form stores clean names ("Word", "File Manager", "Chrome", "Excel"); the
   foreground monitor compared them directly with what the OS reports ("Microsoft Word", WINWORD.EXE, Finder, "Google Chrome"). The
   monitor stayed in "waiting" for ever and every vendor click/key was dropped silently. `agent/policy.js` now expands each approved name
   through `agent/app-catalog.js` (macOS names added). Unknown names still match only themselves.
3. **A host-agent reconnect froze the fast path.** After any agent socket blip the desktop app moved the session back to `connected`
   (input is only forwarded while `running`), and the agent never re-announced its state, so both screens stayed on "waiting".
4. **No record of the Client's decision on the server.** "Stop remote control" only stopped the local agent: relayed input was still
   accepted by the server and the vendor's page kept sending; nothing was audited.

## Changes
| File | Change |
|---|---|
| `server.js` | agent sockets are no longer registered as the Client user; `onControlChange` writes `REMOTE_CONTROL_STARTED/STOPPED` with the reason to the audit log |
| `server/remote-control.js` | `remote-control` {start, stop} from the owning Client of an active task (idempotent); after Stop every relayed input is refused, the agent gets `control-halt {reason:'revoked'}`, a stale agent cannot reconnect, both screens get `control-state`; privacy-safe stage logs (`[RC] task N: ...`, no input content) |
| `agent/client-agent.js` | ignores events for other tasks; `revoked` ends the agent; no input once ending; on reconnect re-announces its state (or exits if the server refuses); forwards monitor diagnostics |
| `agent/monitor.js` | reports WHY input is paused: which app is in front (name only) or why the foreground window cannot be read (macOS permissions) |
| `agent/policy.js`, `agent/app-catalog.js` | approved app names expanded to real process names; only Explorer/Finder count as folder-checkable file managers |
| `desktop/agent-runner.js` | a reconnect never downgrades `running`; `diag` fills the detail line; `armed` clears it |
| `public/webrtc.js` | `control-state` (stopped) blocks input on every path and tells the vendor the bridge is not ready; desktop status sequence check; a slow `agent-status` reply cannot overwrite a newer `agent-state` |
| `public/script.js` | Start asks the server first (and shows its refusal), Stop stops the local agent then records it on the server; the button follows only the status of THIS task; the waiting/stop reason is shown; the duplicate vendor capture (`ScopeDeskHub.startVendorCapture`, sending to channels nobody read) is removed; approval dialog lists task, approved apps and duration |
| `public/index.html`, `public/remote-viewport.html`, `public/remote-viewport.js` | approval details; "client stopped remote control" badge; cache-busting `?v=` |
| `package.json` | `npm test` also runs `test/*.test.js` |
| tests | `test/remote-control-lifecycle.test.js` (11), `agent/test/remote-control-e2e.test.js` (12, real forked agent + real runner), `desktop/test/agent-reconnect.test.js` (2) |

Tests: root 160/160, desktop 34/34, agent 37/38. The one agent failure (`monitor.start() finds the active-win function`) needs the real
`active-win` package, which could not be downloaded in the test sandbox; it fails the same way on the uploaded files.
Not tested here: a real Mac/Windows desktop, real nut-js/active-win, a real browser WebRTC connection, the real Express/Socket.IO server.

---

# Update 6: cross-OS shortcuts, folder auditing for Explorer / Finder, macOS lock chain, TURN aliases

| File | Change |
|---|---|
| `server/rtc-config.js` | Accepts `TURN_URL` (single address) as well as `TURN_URLS`, `TURN_PASSWORD` as well as `TURN_CREDENTIAL`; a bare `turn:host:3478` is tried over UDP and TCP; with `TURN_SECRET`, `TURN_USERNAME` becomes a label in the minted username |
| `agent/input-executor.js` | Windows vendor -> Mac host: Ctrl is pressed as Command (Ctrl+C/V/A/Z... work). Mac vendor -> Windows host: Cmd+A/C/V/X/Z/Y/F/S/P/N/O is pressed as Ctrl+letter. Ctrl+Q / Ctrl+Space / Ctrl+Tab are blocked on a Mac host (they would become Cmd+Q etc.). The Windows key and all other Meta shortcuts stay blocked |
| `agent/sandbox-guard.js` | macOS lock tries `CGSession -suspend` first, then `pmset displaysleepnow`. Windows is unchanged (`rundll32.exe user32.dll,LockWorkStation`) |
| `agent/native/windows-foreground.ps1` | When Explorer is in front, also reports the folder it shows |
| `agent/native/macos-foreground.js` | When Finder is in front, also reports its front window's POSIX folder |
| `agent/foreground-monitor.js` | File manager is allowed only while it shows an approved folder or a sub-folder; anything else is a `path` breach (same lockdown as an unapproved app). Virtual views (This PC, Quick access, Recents) are ignored until a real folder opens. No approved folders = no folder policy |
| `agent/host-runtime.js` | Passes the approved folders to the monitor |
| `test/cross-platform.test.js` (new) | 8 tests (74 total pass) |

macOS asks once to let ScopeDesk control Finder (Privacy & Security > Automation). Without it, Finder is checked as an app only.

Not run here (no Windows or Mac machine, no network): the PowerShell and JXA probes, a real lock, a real TURN relay. The logic around them is tested with simulated probes.

**About "Host agent: could not start: Node.js v22.21.1":** that text is the last line Node prints after a crash, so the real error is just above it. The message comes from the OLD agent path (a separate `node` process), which is not in this zip. The new in-app host (`agent/electron-glue.js`) runs inside Electron's own Node and has no native modules. Your screen still shows the old path, so your `desktop/main.js` and `desktop/preload.js` do not yet call `registerHostIpc` / `exposeHostApi`. Those two files were not in the upload.

---

# Update 5: email through Brevo (Railway blocks Gmail's SMTP port)

Railway log showed `Could not send the verification code: Connection timeout`: free/Hobby Railway plans block SMTP (587/465), so Gmail can never be reached from there.

| File | Change |
|---|---|
| `server/mailer.js` | If `BREVO_API_KEY` is set, codes are sent over HTTPS through Brevo (never blocked). Sender = `BREVO_SENDER_EMAIL`, else the address in `MAIL_FROM`. SMTP/Gmail still works when no Brevo key is set (your own PC) |
| `.env.example` | Brevo settings documented |
| `test/brevo-mailer.test.js` (new) | 3 tests (66 total pass) |

Railway Variables to add: `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` (the address you verified in Brevo). You can delete the four `SMTP_` variables.
Not run: a real Brevo send (no network here).

---

# Update 4: friendlier message + short route names

| File | Change |
|---|---|
| `public/script.js` | When email is not connected on a hosted server the sign-up form now says "Sign-up is temporarily unavailable. Please try again later." (no "contact the administrator") |
| `server.js` | Added aliases: `POST /api/verify-signup-otp`, `POST /api/forgot-password`, `POST /api/reset-password`. Reset also accepts `otpCode` and `newPassword` besides `code` and `password` |

The red box itself goes away only when the server has a mail login: set `SMTP_USER` and `SMTP_PASS` (a Gmail App Password) in Railway > Variables, or in `.env` on your PC, then redeploy/restart.

Tests: 63 of 63 pass; `server.js` and `script.js` pass a syntax check. Not run: booting `server.js` and a real SMTP login.

---

# Update 3: seamless sign-up with a 6-digit code (no terminal)

Why the red banner appeared: the server had no SMTP login (`SMTP_USER` / `SMTP_PASS`), and no code can invent one. It disappears once a login exists, and you can now enter it **inside the app**.

| File | Change |
|---|---|
| `server/otp.js` (new) | 6-digit code (crypto random), keyed hash only, **15-minute** expiry, 5 wrong tries then dead, new code cancels old ones |
| `server/mail-settings.js` (new) | in-app email settings saved to `mail-settings.json` (owner-only); env/.env always wins; only the server's own computer, never in production, only while email is unconfigured |
| `server/mailer.js` | professional HTML email (code in a highlighted box, 15 min), `testSmtpLogin` (logs in without sending), `explainSmtpError` (plain sentences, e.g. "use a Google App Password") |
| `db.js` | `users.status` (`PENDING_VERIFICATION` -> `ACTIVE`), migrated from the previous flag |
| `server.js` | `POST /api/register` (+ old paths) creates the account as `PENDING_VERIFICATION` and emails the code; `POST /api/verify-otp` activates it **and returns the login token**; `POST /api/resend-otp` with a server-enforced 60 s cooldown; `GET/POST /api/setup/mail`; mailer reloads without a restart |
| `public/index.html`, `public/style.css`, `public/script.js` | "Verify Your Account" screen: your email in the text, 6 segmented boxes (auto-advance, paste, backspace), red error under the boxes ("Incorrect or expired code. Please try again."), **Verify & Activate**, **Resend Code (59s)**; success goes straight to the dashboard. "Connect email" screen offered automatically when email is not connected |
| `.gitignore` (new) | keeps `.env`, `mail-settings.json`, the database out of git |
| `test/otp-and-setup.test.js` (new) | 10 tests (63 total pass), incl. OTP against a real SQLite engine and an HTML/JS element-id cross-check |

Not run here: a real SMTP login, or `server.js` itself (needs `express`, `socket.io`, `bcryptjs` and the modules missing from the upload). The new SQL was run against the real schema.

---

# Update 2: email verification, cross-network streaming, input control, breach guard

Install once: `npm install nodemailer socket.io-client` (socket.io-client is only needed by the desktop app). Copy `.env.example` to `.env`.

## 1. Email
| File | Change |
|---|---|
| `server/email-check.js` (new) | strict address parsing, disposable-domain block, "did you mean gmail.com", DNS check (MX, then A/AAAA; a DNS outage never blocks a real person) |
| `server/mailer.js` | `sendVerificationCode`, `isPermanentRecipientFailure` (SMTP 5xx on the recipient) |
| `db.js` | `users.email_verified` (existing accounts stay verified), `email_verifications` table |
| `server.js` | register: validate -> create account **unverified** -> email a 6-digit code (hash only stored, 30 min, 5 wrong tries); `POST /api/auth/verify-email`, `POST /api/auth/resend-verification`; login refuses unverified accounts (`EMAIL_NOT_VERIFIED`); forgot/reset only for verified accounts; unverified leftovers are replaceable and purged after 24 h; a mailbox the mail server rejects (5xx) removes the account again; no SMTP = 503, no account |
| `public/index.html`, `public/script.js` | "Verify your email" step after sign-up and after a sign-in attempt on an unverified account |

Verification uses `users.email_verified`, not `is_active`: `is_active = 0` already means "deactivated by an administrator", and mixing the two would let a deactivated account re-activate itself by verifying.

## 2. Cross-network WebRTC and remote input
| File | Change |
|---|---|
| `server/rtc-config.js` | STUN (Google, Cloudflare) + TURN from `.env`; `TURN_SECRET` mints credentials that expire with the task window; start-up line says whether TURN is set |
| `public/rtc-channel-hub.js` (new, load before `webrtc.js`) | wraps `RTCPeerConnection`: adds public STUN if a config has none, creates the two input data channels before every offer, registers every peer / track / channel so `hardStop()` really ends the stream |
| `public/remote-input-channel.js` (new) | protocol + validator (shared by both ends), vendor capture with letter-box-aware pointer scaling (0..1 of the real screen), throttled moves, clicks, wheel, key strings |
| `agent/input-executor.js`, `agent/native/windows-input.ps1`, `agent/native/macos-input.js` (new) | native input: Windows SendInput, macOS CoreGraphics, Linux xdotool (X11). Drops Win/Super keys, Alt+Tab, Alt+F4, Ctrl+Esc, Cmd+Q/Tab/Space |
| `agent/electron-glue.js` (new) | `registerHostIpc` for Electron main, `exposeHostApi` for the preload (`window.scopedeskHost`) |
| `public/script.js` | uses `scopedeskHost.hostStart` when present; starts vendor capture after the viewer connects |

## 3. Sandbox guard and forced termination
| File | Change |
|---|---|
| `agent/foreground-monitor.js`, `agent/native/windows-foreground.ps1`, `agent/native/macos-foreground.js` (new) | watches the foreground program for the whole approved window (Store apps resolved to the real app), breach if an unapproved program stays in front > 350 ms, once |
| `agent/host-runtime.js` (new) | guard + monitor + executor. Breach order: input stops -> every track / peer closed -> PC locked + local full-screen alert + persistent notification -> `host-violation` to the server (which ends the task and the vendor's session) |
| `agent/app-catalog.js` | WhatsApp added; `filemanager` / `file-manager` match File Manager |

## Wiring in the desktop app (3 lines)
```js
// main process
const { registerHostIpc } = require('./agent/electron-glue');
registerHostIpc({ ipcMain, Notification, getWindow: () => mainWindow, serverUrl: SERVER_URL });
// preload
require('./agent/electron-glue').exposeHostApi({ contextBridge, ipcRenderer });
```
`remote-viewport.html` (the vendor's full-screen window) must also load `remote-input-channel.js` and `rtc-channel-hub.js` before its WebRTC script, then call `ScopeDeskHub.startVendorCapture({ surface, video })` once the stream plays.

## Not verified / not seen
* Tested here: all logic (53 tests), not the real PowerShell/JXA/xdotool helpers on real Windows/macOS/Linux machines and not a real SMTP login.
* Not in the upload and therefore not changed: `webrtc.js`, `remote-input.js`, `desktop-bridge.js`, `remote-viewport.html`, `agent/client-agent.js`, `agent/monitor.js`, `server/remote-control.js`, the Electron `desktop/` files.
* "Host agent: could not start: Node.js v22.21.1" comes from one of those files. The new host runtime runs inside Electron's own Node, so it avoids that check.
* Windows cannot inject input into elevated (administrator) windows; macOS needs the Accessibility permission for ScopeDesk.

---

# Update: real email + application picker

Install the one new dependency once: `npm install nodemailer`, then copy `.env.example` to `.env` and fill in `SMTP_USER` / `SMTP_PASS`
(`SMTP_HOST` defaults to `smtp.gmail.com`, `SMTP_PORT` to `587`; for Mailtrap use `sandbox.smtp.mailtrap.io` / `2525`).

| File | What changed |
|---|---|
| `server/mailer.js` (new) | env-driven nodemailer transport, Gmail App Password spaces stripped, timeouts, `sendResetCode(to, username, code)` |
| `server.js` | forgot-password now emails the code to `user.email`; **the `[RESET CODE]` console log is gone**; no SMTP config = HTTP 503 and no code is created; a failed send cancels the code. New `GET /api/apps` (built-in matrix + device-reported apps + search aliases) and `POST /api/apps/report` |
| `agent/app-catalog.js` | adds **File Manager** (+ Paint, WordPad, Snipping Tool, Photos, Media Player, Brave, 7-Zip, VLC, Zoom, Teams ...), `mergeAppLists`, `listAliases`; "File Manager" still forces the approved-folder check in the guard |
| `agent/app-discovery.js` (new) | reads installed programs on the Client's PC (Windows Start Menu + App Paths, macOS `*.app`, Linux `.desktop`), cleans names, falls back to the catalog |
| `server/task-scope.js` | up to 50 applications per ticket (was 10) |
| `public/script.js` | picker always shows the built-in list immediately, merges server + device apps, search matches names and aliases ("file manager", "explorer", "calc"), "Select all shown" / "Clear", retries loading when opened |
| `test/mailer-and-apps.test.js` (new) | 8 tests (29 total pass) |
| `.env.example` (new) | Gmail and Mailtrap settings |

One wiring step (the `desktop/` Electron files were not in the upload). A website running on Railway cannot see programs installed on the Client's PC,
so the desktop app must expose the discovery module. In Electron main: `ipcMain.handle('scopedesk:list-apps', () => require('./agent/app-discovery').discoverInstalledApps());`
In the preload script: `contextBridge.exposeInMainWorld('scopedeskNative', { listInstalledApps: () => ipcRenderer.invoke('scopedesk:list-apps') });`
The page already calls `window.scopedeskNative.listInstalledApps()` and reports the result to the server. Until that is wired, the picker shows the built-in list (never "No applications available").
Not tested: a real SMTP login (no network here; the transport is tested with a stub) and booting `server.js` (its other `server/*` modules were not in the upload).

---

# ScopeDesk: changed files

Copy these over the same paths in your repo (they are the files that changed, plus three new modules and tests).
Run the tests with `node --test test/sandbox-guard.test.js test/trust-engine.test.js` (Node 22.13+).

| File | What changed |
|---|---|
| `db.js` | `tasks.alerts_enabled` column; **trust-engine trigger** (`rating = rating + 1` on `completed`); demo vendors/tasks no longer seeded on real databases |
| `server.js` | data isolation, vendor required + only that vendor can claim, new task validation, breach protocol, role-aware history, `GET /api/apps`, `GET /api/agent/scope` |
| `server/task-scope.js` (new) | server-side validation of the new ticket form |
| `agent/app-catalog.js` (new) | clean app names (no `.exe`/`.app`), blocked shells, alias matching |
| `agent/sandbox-guard.js` (new) | payload validation + lockdown (close peers, lock PC, report) |
| `public/index.html`, `script.js`, `style.css` | new ticket form, apps multi-select, alert switch, task details, termination overlay |
| `test/*.test.js` (new) | 21 tests |

## One thing you must wire (I did not have these files)
Your upload had no `agent/` (host agent), `desktop/` (Electron), `server/remote-control.js` or `public/webrtc.js`, so I could not edit
the code that receives data-channel messages on the Client's PC. `agent/sandbox-guard.js` is built to drop in there:

```js
const { createSandboxGuard } = require('./sandbox-guard');
const scope = await (await fetch(`${SERVER_URL}/api/agent/scope`, { headers: { Authorization: `Bearer ${agentToken}` } })).json();
const guard = createSandboxGuard({
  taskId: scope.taskId,
  allowedApps: scope.allowedApps,           // clean names from the ticket
  allowedPaths: scope.allowedPaths,         // folders named in the task text
  closeConnections: () => closeEveryPeerConnectionAndDataChannel(),   // your existing teardown
  reportViolation: (v) => socket.emitWithAck('host-violation', v)    // the agent's existing socket
});
dataChannel.onmessage = async (ev) => {
  const r = await guard.handlePayload(ev.data);   // never executes anything itself
  if (r.ok) execute(r.payload);                    // run ONLY the sanitized payload
};
```
On a breach the guard closes all connections, runs `rundll32.exe user32.dll,LockWorkStation` (macOS: `pmset displaysleepnow`,
Linux: `loginctl lock-session`) and reports to the server, which ends the task and sends the `termination-alert` event
(overlay on the Client's page). The check must stay on the Client's PC, never in the vendor's browser.

## Behaviour changes to know about
- A task now **requires** a vendor. The token works only for that vendor (anyone else gets the same "token not found" answer).
  Old pending tasks with no vendor can no longer be claimed.
- The form's folder boundary comes from folders written in the task text (quote paths with spaces). No folder in the text = no folder allowed.
- Shells and system tools (cmd, PowerShell, regedit, Task Manager...) can never be allowed. Edit `BLOCKED` in `agent/app-catalog.js` to change that.
- A breach now terminates the task immediately. Set `ALLOW_RESUME_AFTER_VIOLATION=true` to restore the old "Client decides" flow.
- Alerts switch off = no overlay or notification, but lockdown, termination and the audit log still happen.
- Rating starts at 0 for a vendor's first row in a client's directory and gets +1 per clean completed task (a task with a logged violation earns nothing).
  A vendor can press "End Session" to complete a task, so they can raise their own rating inside a client's directory. If that matters, make completion client-only.
- If your production database was created by an older build, delete any fake demo rows (vendors with client_id 1 and ids 1-4, tasks `SCD-1042-XP8B`, `SCD-3091-ZN72`) if they are not yours.

## What was and was not tested
Tested: the rating trigger (real SQLite), form/task validation, the sandbox guard (Windows and POSIX path rules, symlinks, traversal, lockdown order),
and the new UI in headless Chrome with the missing front-end scripts stubbed. **Not tested:** booting `server.js` (express, socket.io and your
`server/*` modules were not available) and a real WebRTC session; syntax-checked and reviewed only.

## UPDATE 9: session enforcement and screen-share fix

- Screen share "ScopeDesk app detail: error: undefined": `desktop/display-media-handler.js` printed `err.message` for errors that are not
  Error objects. Every thrown value is now described, `getSources` is retried (3 attempts, different thumbnail sizes), and when the
  capturer itself keeps failing the primary display is offered directly.
- In the desktop app the share dialog no longer tells the Client to "click the picture of your screen" (there is no picker there).
- `server/remote-control.js`: new `teardown(taskId, reason)` (halt, cancel countdown, drop host-agent sockets, release memory) used by
  `terminateTask`; the countdown is also armed from the database when the host agent says hello or a peer joins the stream
  (`session-timers.js` `ensure()`); a vendor "open folder" request outside the approved paths is checked on the SERVER
  (`task-scope.js` `checkPathScope`) and ends the session as a breach before it reaches the Client's PC.
- `server.js`: breach handling shared by host-agent reports and the server-side check (`enforceBreach`).
- `public/screen-share.js`: `stopAll()` stops every capture, `showSessionClosed()` shows a friendly notice at the top of the window;
  wired to `session-ended`, `webrtc-close` and `control-halt` (`script.js`, `webrtc.js`). Cache-busting query strings bumped.
- Tests: `test/session-enforcement.test.js`, extra cases in `test/screen-share.test.js`.

## UPDATE 10: cross-network relay and diagnostics

- `server/rtc-config.js` now matches its tests and RAILWAY.md: Cloudflare Realtime TURN (per-session credentials that expire with the task),
  Metered TURN, your own coturn/fixed account, `TURN_FORCE_RELAY`. Failures are logged once without keys and fall through to the next option.
  There is deliberately no built-in "public" relay: the shared open-relay servers are gone or parked.
- Desktop app: Help > Save diagnostics report writes ScopeDesk-diagnostics.txt on the Desktop (agent files/modules present, agent state,
  last log lines, last screen-share refusal; tokens and keys removed). `diagnostics.js` is in the installer's file list and a test now
  fails the build if any file main.js requires is missing from that list.

## UPDATE 11: host agent crash on session start

- `agent/client-agent.js`: "The host agent stopped: viewOnly is not defined". `onHello()` had been moved out of `connect()` but still read
  `viewOnly`, so the agent crashed the moment the server accepted it and the Client saw "Host agent: not running". The flag is now kept in a
  module variable (`viewOnlyMode`).
- `agent/test/agent-session-start.test.js` + `helpers/agent-harness.js`: starts the real agent with fake network/monitor/injector and fails
  on any crash during session start (verified to fail on the old code with the exact error above).

## UPDATE 12: remote control lifecycle, Start/Stop flipping, silent failures

- Start/Stop flipping: `syncClientLive()` (runs on every task-list refresh) called `startDesktopAgent(false)`, and ticket creation did too. Each call
  re-initialised the agent, and every restart/crash/session end changed the button. Remote control now starts only on the Client's explicit action
  (pressing "Share my screen" in the approval dialog, or "Start remote control"); the desktop app ignores any start that is not `manual: true`.
- `desktop/agent-runner.js`: one authoritative status with a sequence number, no announcement when nothing changed, idempotent `init()`,
  no restart after Stop / session end / crash (`blocked`), a standby event no longer wipes an error, input is accepted only while the agent
  is running, new `endTask()` and `fail()`.
- `public/desktop-bridge.js`: ignores status events older than the newest one seen; `endTask()`.
- `public/webrtc.js`: the host bridge is "ready" only when the agent is running AND reports it can apply input; the vendor gets an explicit input
  path (`channel` / `relay` / `none`); events fall back to the relay when the channel closes or throws; no duplicate socket handlers; changes
  are announced only when a value really changes; privacy-safe stage diagnostics.
- Agent: reports `{type:'input', ready, reason}`; reports `view-only` (never `armed`) when it cannot apply input; macOS Accessibility is checked in
  `desktop/main.js` and shown as the reason. `server/remote-control.js` accepts `view-only` and tells the vendor (`input-undeliverable`) when no
  agent can receive input.
- Tests: `desktop/test/agent-lifecycle.test.js`, `test/remote-control-page.test.js`, more cases in `test/session-enforcement.test.js` and
  `agent/test/agent-session-start.test.js`. Manual test guide: REMOTE-CONTROL-TEST.md.
