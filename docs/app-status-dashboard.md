# App Status / Control Dashboard

A high-level sketch for a status/control dashboard for your gaylon.photos apps.

## What It Does

A small web dashboard that shows whether each app (btc, photos, giftlist, gmailwiz,
madonnahist) is up or down, and gives you a button to restart any of them. You'd hit it
from a browser, see a row of green/red indicators, and click "Restart" when something's
stuck.

## The Two Halves

**Frontend (the UI):** A single page showing a card per app with status, last-checked
time, and a restart button. SvelteKit is the natural pick since you already run it for
gaylon.photos and madonnahist — no new stack to learn.

**Backend (the control plane):** A small API that does two jobs: check each app's health,
and restart a given app. This is the part that needs care, because restarting a process
means executing privileged commands on your server.

## How Status Polling Works

Each app exposes (or you add) a lightweight `/health` endpoint that returns `200 OK` with
maybe a JSON blob:

```json
{ "status": "ok", "uptime": 12345 }
```

The backend loops over your app list, makes an HTTP request to each, and records up/down +
response time. The frontend polls the backend every, say, 15 seconds to refresh the cards.

If an app doesn't have a health endpoint, the fallback is a TCP port check or a process
check (is the systemd service / pm2 process running?).

## How Restart Works — The Important Design Decision

You don't want your dashboard running arbitrary shell commands directly. The clean
pattern: each app runs under a process manager (systemd services or pm2, since you're on
macOS/M2 — pm2 or launchd likely). The restart button calls a backend endpoint like
`POST /restart/giftlist`, and the backend translates that into a specific, whitelisted
command — e.g. `pm2 restart giftlist` or `launchctl kickstart ...`. The whitelist (a fixed
map of app-name → exact command) is what keeps this safe: the UI can only restart known
apps, never inject commands.

## Security — Non-Negotiable Since It Can Restart Things

Put the whole dashboard behind auth (it controls production). Options that fit your setup:
a Cloudflare Access policy on the tunnel (you already use Cloudflare tunnels), or simple
HTTP basic auth, or a single shared token. Never expose the restart endpoint to the open
internet unauthenticated.

## Rough Architecture

```
Browser (SvelteKit UI)
    │  poll every 15s
    ▼
Backend API (Node/SvelteKit endpoints on M2)
    ├── GET  /status      → checks each app's /health
    └── POST /restart/:app → runs whitelisted command
            │
            ▼
    Process manager (pm2 / launchd) ── restarts the app
```

## Suggested Build Order

1. Define the app registry (a config file: name, health URL, restart command).
2. Build `GET /status` and confirm it reads health correctly.
3. Build the SvelteKit UI that renders status cards.
4. Add `POST /restart/:app` with the whitelist.
5. Add auth before exposing it anywhere.

## Open Question

One question that shapes the design: what's currently managing these processes on your M2
— pm2, launchd/launchctl, Docker, or something else? That determines the exact restart
mechanism and is worth nailing down before step 4.
