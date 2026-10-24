# Deploying ScopeDesk on Railway (production)

The server (website, API, logins, live connections) runs on Railway. Nobody runs a server on their own computer,
and there are no `.bat` / `.command` launchers for it.

## 1. Deploy
1. Put this project (the folder that contains `server.js`) in a GitHub repository.
2. On railway.com: **New Project > Deploy from GitHub repo** and pick it. `railway.json` already tells Railway how to start it and which health check to use.
3. Open the service > **Settings > Networking > Generate Domain**. You get an address like `https://scopedesk-production.up.railway.app`.

## 2. Save the data (important)
Railway wipes a service's disk on every deploy. Without a Volume every account and task disappears.
1. Service > **Volumes > New Volume**, mount path `/data`.
2. Keep the service at **one replica** (the database is a single SQLite file).

## 3. Variables (Service > Variables)
| Name | Value |
|---|---|
| `JWT_SECRET` | a long random string (run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) |
| `DB_PATH` | `/data/scopedesk.db` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | for password-reset emails (see `.env.example`) |
| `TURN_URLS`, `TURN_SECRET` | recommended: relay for WebRTC between different networks |

The server stops with a clear message if `JWT_SECRET` is missing. Demo accounts are never created in production.
`APP_URL` and CORS are filled in automatically from Railway's domain.

## Using GitHub Pages or Vercel too? (not needed)
Railway already serves the whole app (pages + API). If you also publish the `public` folder on GitHub Pages or Vercel, those pages only forward people to Railway. For that to work, add this variable so Railway accepts them:
`CORS_ORIGIN` = `https://keerthi957-321.github.io,https://scope-desk.vercel.app` (comma separated, no trailing slash)
and put the Railway address in `public/app-config.json`. The simplest setup is to share only the Railway address.

## 4. Check it
Open `https://your-address/api/health`. You should see `{"app":"scopedesk","ok":true,"status":"online"}`.
Then open `https://your-address` and create your first account (Sign up).

## 5. Point the desktop app and agent at it
Edit `public/app-config.json`:
```json
{ "serverUrl": "https://your-address" }
```
Commit and push (Railway redeploys), then build the desktop installer (`cd desktop`, then `npm run dist`). The same file is used by the web page and the host agent.
A custom domain works the same way: put it in `serverUrl`.

## If the build fails
- `npm ci ... exit code 1`: the lock file did not match `package.json`. This project now builds with `npm install` (see `nixpacks.toml`) and has no lock file, so pull the latest files.
- `You have Node.js ... ScopeDesk needs 22.13 or newer` in the deploy log: add the variable `NIXPACKS_NODE_VERSION` = `22` and redeploy.
- Keep ONE Railway project/service for ScopeDesk. Extra copies each build separately and only add confusion (and cost).

## Relay (TURN): required when the two people are on different networks
Symptom without it: the Vendor window stays on "Connecting..." and the Client sees "connection lost, retrying". Open `https://your-address/api/health`: if it shows `"relay":false`, this step is missing.
1. Create a free Cloudflare account, open **Realtime > TURN Server** and create a TURN key. Copy the **Turn Token ID** and the **API Token**.
2. In Railway > Variables add `CLOUDFLARE_TURN_KEY_ID` (the Token ID) and `CLOUDFLARE_TURN_API_TOKEN` (the API Token). Railway redeploys by itself.
3. Check `/api/health` again: it must show `"relay":true`. Credentials are created per session and expire when the task time ends.

**No Cloudflare? Use Metered (free account) instead.** Sign up at metered.ca, create an app, and open its TURN Server page. Add the Railway variables `METERED_APP` (your app name, the part before `.metered.live`) and `METERED_API_KEY`. Check `/api/health` shows `"relay":true`.
Cloudflare is the better choice (larger free allowance, and its credentials expire exactly when the task ends), but both work.
Do not paste shared "open" usernames/passwords from the internet into the code: they stop working without warning and cannot expire with a task. Your own coturn server or another provider also works: see `.env.example`.
