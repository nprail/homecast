---
title: "Quick start"
description: "Run Homecast locally in a few minutes."
---

# Quick start

## Requirements

- Node.js 22 or newer (the spec targets Node 26; both work).
- `ffmpeg` and [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`) **only** if you want to generate transcripts.

## Run it

```bash
git clone https://github.com/nprail/homecast.git
cd homecast
npm install
npm run dev:server    # API on :8080, data in ./server/data
npm run dev:web       # web app on :5173, proxies /api to :8080
```

## Create the admin account

On first run, while no users exist, the server prints a **bootstrap token** to its log:

```text
First run: no users exist yet.
Create the admin account at http://localhost:8080/register
Bootstrap token: <token>
```

1. Open `/register`.
2. Choose **Setting up a new server?** and paste the token.
3. Pick a username and a password of at least 10 characters.

After that, registration is invite-only. Create invites under **Admin → Users & invites** and send the code or sign-up link to the person you are inviting.

::: callout tip "Add your first podcast"
In the player press **Add**, paste a feed URL (or import an OPML file) and the server fetches the feed and syncs it to your device.
:::

## Try it with demo data

The seed script is for local development only. Do not run it on a real server.

```bash
cd server
DATA_DIR=./data-demo npx tsx scripts/seed-demo.ts     # with the server stopped
DATA_DIR=./data-demo npm run dev                       # sign in: demo / demo-password-123
```

## Production build

```bash
npm run build
DATA_DIR=/var/lib/homecast PUBLIC_URL=https://podcasts.example.com TRUST_PROXY=loopback npm start
```

The server serves the built web app itself from `web/dist` (see `WEB_DIR`). For a real deployment use [Docker and Caddy](/getting-started/deployment).
