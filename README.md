# Homecast

A podcast player with a self-hosted sync server. See [`SPEC.md`](SPEC.md) for the full spec (v0.2).

## Status

| Piece | State |
|---|---|
| **Server** (`server/`): auth, invites, feed poller, sync, discovery, OPML, transcripts (publisher + Whisper), audio proxy, usage, audit, backups, admin API | Built and tested |
| **Admin dashboard** (`web/`, served at `/admin`): Overview, Users & invites, Feeds, Jobs, Usage, Audit log, Settings | Built |
| `shared/`: API/sync schemas (zod), smart-playlist evaluator and test vectors | Built and tested |
| **Player PWA** (`web/`, served at `/`): library, playback, Up Next, playlists, smart playlists, bookmarks, transcripts, Discover, downloads/offline, sync | Built |
| Android, iOS | Not started (milestones 6, 7) |

The player and the admin dashboard are one React app: `/` is the player, `/admin` the dashboard.

## Quick start (development)

Requires Node 22 or newer (the spec targets Node 26; both work) and ffmpeg + [whisper.cpp](https://github.com/ggml-org/whisper.cpp) only if you want to generate transcripts.

```bash
npm install
npm run dev:server        # API on :8080, data in ./server/data
npm run dev:web           # dashboard on :5173, proxies /api to :8080
```

On first run the server prints a **bootstrap token** to its log. Open `/register` (or `/register?bootstrap`), choose "Setting up a new server?", paste the token and create the admin account. After that, registration is invite-only: create invites under **Users & invites**.

Demo data:

```bash
cd server && DATA_DIR=./data-demo npx tsx scripts/seed-demo.ts   # server stopped
DATA_DIR=./data-demo npm run dev                                   # sign in: demo / demo-password-123
```

### Production build

```bash
npm run build            # web/dist + server/dist
DATA_DIR=/var/lib/homecast PUBLIC_URL=https://podcasts.example.com TRUST_PROXY=loopback npm start
```

The server serves the dashboard itself from `web/dist` (`WEB_DIR`).

### Docker + Caddy

The Compose file runs the published image `ghcr.io/nprail/homecast` (linux/amd64 and linux/arm64):

```bash
cp deploy/.env.example deploy/.env   # set DOMAIN (and optionally HOMECAST_TAG)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.yml logs homecast    # bootstrap token
```

To build from source for development, add the dev override: `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml --env-file deploy/.env up -d --build`.

The image runs as a non-root user with a read-only root filesystem (only `/data` is writable), bundles ffmpeg and the prebuilt whisper.cpp binary (per architecture) with the `base.en-q5_1` model, and contains no secrets: the JWT secret is generated on first run into the data volume.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | Loki database, `backups/`, `jwt.secret`, temp files |
| `PUBLIC_URL` | `http://localhost:$PORT` | Used for links, cookies (`Secure` when https), CORS and HSTS |
| `TRUST_PROXY` | off | `true`, or a list of proxy IPs/CIDRs/keywords (`loopback`, `uniquelocal`). `X-Forwarded-*` is trusted only from these |
| `JWT_SECRET` | generated | Optional override, 32+ chars |
| `CORS_ORIGINS` | none | Extra allowed origins (e.g. `http://localhost:5173` in dev) beyond `PUBLIC_URL` |
| `WHISPER_BIN` / `WHISPER_MODEL` / `WHISPER_MODEL_DIR` | `whisper-cli` / `base.en-q5_1` / `$DATA_DIR/models` | Model file is `ggml-<model>.bin`. The model can also be changed in the dashboard |
| `FFMPEG_BIN` | `ffmpeg` | |
| `WEB_DIR` | `../web/dist` | Static dashboard |
| `MAX_EPISODES_PER_FEED` | `5000` | |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Tests/dev only: disables the SSRF guard's address blocking |
| `LOG_LEVEL` | `info` | |

## Documentation

The docs live in `docs/` and are built with [docmd](https://docmd.io): `npm run docs:dev` for a live preview, `npm run docs:build` for the static site. Pushes to `main` publish them to GitHub Pages (https://nprail.github.io/homecast/) via `.github/workflows/docs.yml`; enable it once under Settings > Pages > Source: GitHub Actions.

## Layout

```
shared/   zod schemas for the API and sync protocol, smart-playlist evaluator + vectors/
server/   Fastify + LokiJS (src/db is the thin repository layer), services/, routes/
web/      React 19 + Vite + Tailwind v4 admin dashboard
deploy/   docker-compose (published image), docker-compose.dev.yml (build from source), Caddyfile
logo/     Homecast logo sources (the PWA icons are rendered from logo/homecast-app-icon.svg by web/scripts/make-icons.mjs)
docs/     documentation source (docmd.config.json at the repo root)
```

## What the server does

- **Auth:** invite-only registration, argon2id, 14-day access JWTs bound to a session id that is checked on every request (revocation is immediate), 90-day rotating refresh tokens with reuse detection, `HttpOnly; SameSite=Strict` refresh cookie for the web (`client: "web"`), progressive login lockout (5 failures/min -> 15 min, doubling), one-time password-reset links.
- **Feeds:** one poller for everyone (30 min default, jittered, `ETag`/`If-Modified-Since`, backoff), RSS and Atom, `<podcast:transcript>`, sanitized descriptions, private-feed detection, SSRF-guarded fetching (private/loopback/link-local/metadata ranges blocked at connect time, redirects revalidated, size caps).
- **Sync:** `POST /api/v1/sync` delta protocol with last-write-wins per record, play-event position rule, "played beats unplayed unless newer", tombstones purged after 90 days, resync past the tombstone horizon. Response includes `rejected` entries for ids the server refused.
- **Discover, OPML, transcripts, audio proxy, data export:** as in the spec (§3.10, §6, §7). Transcripts are shared and deduplicated per episode; the queue is persisted and resumed on boot.
- **Operations:** daily 03:00 snapshot (14 kept), nightly pruning, usage rows kept 1 year, audit log, `GET /healthz`.

### Sync notes for client authors

- If you send a record whose natural key already exists for the user (an `episodeStates` row for the same episode, a subscription for the same podcast, the user's single `settings` row) under a different `id`, the server keeps its existing record; adopt the `id` it returns.
- `fullResync: true` means your cursor predates the tombstone horizon: drop local synced data and pull from cursor 0.
- Shared `podcasts`/`episodes` arrive for subscribed feeds only. A new subscription backfills the whole feed.
- `POST /podcasts` (feed URL) is the only way to subscribe to a private feed; subscribing by id (Discover or sync) is refused for private feeds.

## Player PWA

Local-first: the UI reads only from an IndexedDB database (Dexie, one per user) and the sync engine feeds it. It works fully offline, including playback of downloaded episodes.

| Area | Notes |
|---|---|
| Playback | One `<audio>` element, Media Session (lock-screen/headset controls), −15 s / +30 s, speed 0.5×–3.0× with pitch correction, podcast override then global default (clear override from the player), sleep timer (5/15/30/45/60, custom, end of episode, 10 s fade, extend by tap or shake), resume position, auto-advance |
| Position sync | Saved locally every 5 s, pushed on pause / episode change / every 30 s while online |
| Library | Subscribe by feed URL or OPML, podcast page with filters and per-podcast settings (speed override, auto-download latest N / all new, delete played after N days), episode pages, mark played/unplayed, star |
| Queue and playlists | Up Next is the built-in playlist (drag handle or arrow keys to reorder); manual playlists; smart playlists (rule editor, evaluated on-device with the shared evaluator) |
| Bookmarks | One tap from the player or "Bookmark this line" in the transcript, title/note, list per episode and global, tap to seek, transcript preview |
| Transcripts | Request generation (publisher transcript or Whisper), tap-to-seek, current-line highlight, in-episode search, cached for offline |
| Discover | Podcasts others on the server follow (counts only), cached last list offline |
| Offline | Service worker caches the app shell; downloads go through the authenticated audio proxy into the Cache API; storage cap, Wi-Fi-only toggle (where the browser reports connection type), auto-download rules |

PWA limits (spec §9): iOS Safari may evict stored audio, and background playback is less reliable than native apps. Durations missing from a feed (e.g. Planning Center Publishing) are estimated from the file size by the server and corrected locally once the audio metadata loads.

## Admin dashboard

Every `/api/v1/admin/*` route enforces the `admin` role server-side (covered by a test that calls each one anonymously and as a regular user). The dashboard is a client of those routes only.

| Page | Route | Notes |
|---|---|---|
| Overview | `/admin` | Stats, feed health, recent activity, back up now |
| Users & invites | `/admin/users` | Row menu: reset link, revoke sessions, promote/demote, disable/enable, delete. Last-admin guard. Invite codes are shown once |
| Feeds | `/admin/feeds` | Fetch status/errors, refresh now, hide from Discover, remove orphans |
| Jobs | `/admin/jobs` | Live progress, cancel/retry |
| Usage | `/admin/usage` | 30 d / 90 d / 1 y, chart + table, per-user shares, CSV export |
| Audit log | `/admin/audit` | Filter all / sign-ins / admin, paginated |
| Settings | `/admin/settings` | Sign-ups on/off, poll interval, Whisper model, auto-transcribe (off / new episodes / all episodes, for all or selected podcasts), backups |

## Tests

```bash
npm test          # shared evaluator vectors + server (auth, SSRF, sync, feeds, transcripts, proxy, admin)
npm run typecheck
```

The transcript tests run the real worker pipeline against stand-in `ffmpeg`/`whisper-cli` scripts, so they need no binaries.

## Notes and decisions beyond the spec

- Usage `feedBytes` are attributed to a feed's subscribers (split evenly), or to the requesting user when a feed is first added.
- Feeds with no subscribers are not polled; "Remove orphans" deletes them and their episodes.
- Private feed URLs (and anything with credentials) are redacted in the admin Feeds list.
- Access tokens are kept in memory by the dashboard; a page reload restores the session from the refresh cookie.
- Request an Apple CarPlay entitlement early (spec §3.12); nothing here depends on it.

## License and credits

Homecast is released under the [MIT License](LICENSE). See also [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Third-party software the project builds on or ships:

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and the Whisper models (MIT), used for transcripts.
- [FFmpeg](https://ffmpeg.org) (LGPL/GPL, installed from the Debian package in the Docker image) for audio conversion. Its source is available from Debian; the image does not modify it.
- [Inter](https://rsms.me/inter/) and [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) (SIL Open Font License 1.1), bundled through `@fontsource`.
- The npm dependencies listed in `package-lock.json`, all under permissive licenses (MIT, ISC, BSD, Apache-2.0, MPL-2.0).
