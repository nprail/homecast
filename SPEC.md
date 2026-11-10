# Podcast App + Self-Hosted Sync Server: Spec (v0.2)

Working title: **Homecast**. A podcast player with a self-hosted server. Native iOS (Swift), native Android (Kotlin), and a PWA.

## 1. Goals and Non-Goals

**Goals**
- Fully usable offline. The network is needed only for downloading episodes, refreshing feeds (server-side), and syncing.
- Simple, auditable server: Node.js + LokiJS, one process, one data directory.
- Multi-user and safe to expose directly to the internet (behind a TLS reverse proxy).
- Consistent behavior across iOS, Android, and web, including CarPlay and Android Auto in v1.
- Admin dashboard for running the server (users, invites, feeds, jobs, usage).

**Non-goals (v1)**
- External podcast directory search. Discovery is limited to podcasts users on this server have added (§3.10); anything else is added by feed URL or OPML import.
- Social features, public sharing, paid/private-feed marketplace.
- Silence trimming / voice boost (v2).
- Server-side audio hosting or transcoding.

## 2. Architecture

```
┌────────────┐ ┌────────────┐ ┌────────────┐
│ iOS (Swift)│ │ Android    │ │ PWA        │
│ SQLite     │ │ (Kotlin)   │ │ IndexedDB  │
│ (GRDB)     │ │ Room       │ │ + SW cache │
└─────┬──────┘ └─────┬──────┘ └─────┬──────┘
      └──────────────┼──────────────┘
                     │ HTTPS (REST + JSON)
              ┌──────▼───────┐
              │ Node server  │  Fastify + LokiJS
              │  - auth      │  - feed poller
              │  - sync      │  - transcript worker (whisper.cpp)
              │  - proxy     │
              └──────────────┘
```

Key decisions:
- **Local-first clients.** Each client owns a full local database of the user's data and works entirely from it. The server is a sync hub, not a runtime dependency.
- **Server fetches feeds.** One poller serves all users, so smart playlists and "new episode" state are consistent across devices, and the PWA avoids CORS problems.
- **Audio goes directly from the podcast CDN to the client.** The server never stores audio, except transiently for transcription. The exception is an authenticated audio proxy for the PWA (see §7), because browsers can't cache cross-origin audio without CORS headers.
- **Smart playlists are evaluated on-device** from local data, so they work offline. The server stores only the rule definitions.

## 3. Features

### 3.1 Library and Playback (baseline)
- Subscribe by feed URL or OPML import/export. Episode list per podcast, Up Next queue, resume position, mark played/unplayed, star episode.
- Background audio with lock-screen/notification controls, headset buttons. CarPlay and Android Auto are v1 requirements (§3.12).
- Position sync: saved locally every 5 s while playing, pushed to the server on pause, episode change, and every 30 s while online.

### 3.2 Bookmarks
- Bookmark = `{episodeId, positionMs, title?, note?, createdAt}`.
- Created from the player (one tap, optional title/note), listed per episode and globally, tap to seek, edit, delete.
- Synced; transcript text near the position is shown as a preview when available.

### 3.3 Playback Speed
- Range 0.5x to 3.0x in 0.1 steps, with pitch correction.
- Resolution order: **podcast override → global default**.
- Overrides are set from the player or the podcast settings screen, and can be cleared.
- Synced as part of user settings.

### 3.4 Sleep Timer
- Presets (5/15/30/45/60 min), custom duration, or "end of episode".
- Fades out the last 10 s. Extends on shake (mobile) or tap.
- Device-local, not synced.

### 3.5 Offline
- Download episodes manually, via auto-download rules per podcast (latest N, or all new), or via playlist "download all".
- Storage management: per-podcast cleanup (delete played after X days), a global storage cap, and Wi-Fi-only toggle.
- Everything else (library, queue, bookmarks, playlists, smart playlists, transcripts already synced) works with no connectivity. Writes go into a local outbox and sync when online.
- PWA: service worker caches the app shell. Audio is stored in OPFS/Cache API with a user-visible storage quota note.

### 3.6 Playlists
- Manual playlists: ordered list of episodes, reorderable, can be played in order.
- Up Next is a special built-in playlist.

### 3.7 Smart Playlists
Rules stored as JSON and evaluated on-device:

```json
{
  "name": "Fresh news",
  "match": "all",
  "rules": [
    { "field": "podcast", "op": "in", "value": ["pod_1", "pod_7"] },
    { "field": "status", "op": "is", "value": "unplayed" },
    { "field": "releasedWithin", "op": "days", "value": 7 }
  ],
  "sort": { "field": "releasedAt", "dir": "desc" },
  "limit": 50
}
```

| Field | Operators |
|---|---|
| `podcast` | `in`, `notIn` |
| `status` | `is` (unplayed, inProgress, played) |
| `releasedWithin` | `days` |
| `duration` | `lt`, `gt` (minutes) |
| `downloaded` | `is` (true/false) |
| `starred` | `is` |
| `title` | `contains` |

`match` is `all` or `any`. Sort fields: `releasedAt`, `duration`, `title`. Optional "auto-download results" flag.

### 3.8 Transcripts
- On request ("Generate transcript" on an episode, available to any user), the server queues a job. A request for an episode that already has a job or transcript attaches to it instead of creating a new one.
- Order of preference: (1) publisher-provided transcript from the feed (`<podcast:transcript>`), (2) Whisper via whisper.cpp. Default model is **`base.en` quantized (q5_1)**: about 60 MB, runs faster than real time on a modest CPU, and gives reasonable accuracy for clear English speech. It's configurable; step up to `small.en-q5_1` for better accuracy at roughly 3x the compute, or use the multilingual `base` for non-English feeds.
- Worker: downloads audio to a temp dir, converts with ffmpeg to 16 kHz mono WAV, runs Whisper, stores segments `[{startMs, endMs, text}]`, deletes temp files. Concurrency 1 by default.
- Transcripts are **shared across users** (keyed by episode) so each episode is processed once.
- Client: transcript view with tap-to-seek, current-line highlight, in-episode search. Clients fetch and cache transcripts for offline reading.

### 3.9 Multiple Users
- Roles: `admin`, `user`. The first run creates the admin via a bootstrap token printed to the server log.
- Registration is **invite-only**: the admin creates invite codes (single-use, expiring).
- Per-user: subscriptions, state, bookmarks, playlists, settings. Shared: feeds, episodes, transcripts.

### 3.10 Discovery
- A **Discover** tab lists every podcast that at least one user on the server has subscribed to, minus ones the current user already follows.
- Search by title/author; sort by subscriber count, recently added, or A–Z. One tap to subscribe.
- Shows only a subscriber *count*, never who subscribed.
- **Private feeds are never listed.** Feeds that use credentials or tokenized URLs (HTTP auth, or flagged private by the user or detected heuristically) are excluded, and subscribing from Discover references the podcast by ID, so another user's feed URL is never exposed.
- Podcasts drop out of Discover when nobody is subscribed. Admins can hide a podcast from Discover.
- Requires a connection; the last list is cached for offline browsing.

### 3.11 Admin Dashboard
Part of the same React app under `/admin`. Every `/admin` API route enforces the `admin` role server-side; hiding UI is not the security boundary.
- **Overview:** users, feeds, episodes, DB size, disk free, last backup, uptime, version.
- **Users:** list, disable/enable, promote/demote, revoke all sessions, issue a one-time password-reset link, delete user and data. The last admin can't be demoted or deleted.
- **Invites:** create (single-use, expiring), revoke, see status.
- **Feeds:** last fetch status and errors, refresh now, remove orphans, hide from Discover.
- **Jobs:** transcript queue with retry/cancel, active model, per-job duration.
- **Usage (tracking only, no quotas):** per user per day bytes through the audio proxy, bytes fetched for feeds, bytes downloaded for transcription, and transcript minutes processed. 30/90-day charts, CSV export.
- **Audit log** (logins, failed logins, admin actions) and **settings** (registration on/off, Whisper model, poll interval, backup now).

### 3.12 CarPlay and Android Auto
Both are v1 and are offline-first: browsing reads from the local database, and playback uses downloaded files or streams.
- **CarPlay:** audio-app entitlement (`com.apple.developer.carplay-audio`). **Apple must approve this, which can take weeks, so request it at project start.** Tabs: Up Next, Playlists (manual and smart), Podcasts, Downloads. Now Playing exposes speed and an "add bookmark" button.
- **Android Auto:** Media3 `MediaLibraryService` with a browse tree mirroring the same sections, voice search/play via the media session, and custom actions for speed and bookmark.
- Both follow driver-distraction rules: shallow lists, no text entry, large controls.

## 4. Data Model (LokiJS collections)

Every synced record carries `id` (UUID), `updatedAt` (server-assigned monotonically increasing `rev`), and `deleted` (tombstone flag).

| Collection | Scope | Key fields |
|---|---|---|
| `users` | global | username (unique), passwordHash, role, createdAt, disabled |
| `refreshTokens` | global | userId, tokenHash, deviceName, expiresAt, revokedAt |
| `invites` | global | codeHash, createdBy, expiresAt, usedBy |
| `podcasts` | shared | feedUrl (unique), isPrivate, hiddenFromDiscover, title, author, imageUrl, description, lastFetchedAt, etag, lastModified, fetchError |
| `episodes` | shared | podcastId, guid, title, description, audioUrl, mimeType, durationSec, releasedAt, transcriptUrl? |
| `transcripts` | shared | episodeId, source (feed/whisper), segments, status, model |
| `subscriptions` | user | userId, podcastId, autoDownload, newEpisodeNotify |
| `episodeStates` | user | userId, episodeId, status, positionMs, playedAt, starred |
| `bookmarks` | user | userId, episodeId, positionMs, title, note |
| `playlists` | user | userId, name, episodeIds[] (ordered) |
| `smartPlaylists` | user | userId, name, definition (JSON) |
| `settings` | user | userId, defaultSpeed, podcastSpeeds{podcastId: speed}, other prefs |
| `jobs` | global | type, episodeId, status, error, createdAt |
| `usageStats` | global | userId, day, proxyBytes, feedBytes, transcribeBytes, transcriptMinutes (tracking only) |
| `auditLog` | global | actorId, action, target, ip, at |

Indexes: unique on `users.username`, `podcasts.feedUrl`; indexed `userId`, `podcastId`, `episodeId`, `updatedAt`. Loki persists with its fs adapter and autosave (5 s), plus a periodic atomic snapshot to `data/backups/` (daily, keep 14).

## 5. Sync Protocol

Single endpoint pair, delta-based:

`POST /api/v1/sync`
```json
{
  "cursor": 4182,
  "deviceId": "…",
  "changes": {
    "episodeStates": [{ "id": "…", "positionMs": 91000, "status": "inProgress", "clientUpdatedAt": 1731200000000 }],
    "bookmarks": [],
    "playlists": [],
    "smartPlaylists": [],
    "settings": [],
    "subscriptions": []
  }
}
```
Response: `{ "cursor": 4230, "changes": { …same shape, including shared episodes/podcasts for subscribed feeds… }, "hasMore": false }`

- Server applies client changes, assigns `rev` values, and returns everything with `rev > cursor` for that user's scope.
- **Conflict resolution:** last-write-wins per record using `clientUpdatedAt` (server clamps future timestamps). Exceptions: `episodeStates.positionMs` takes the most recent play event; `played` status wins over `unplayed` unless the unplayed change is newer; playlists are replaced whole (LWW).
- Deletes are tombstones, purged after 90 days.
- Pagination via `hasMore`. Clients retry with exponential backoff. A full resync is triggered if the cursor is older than the tombstone horizon.
- Sync is triggered on app open, on connectivity regained, after local writes (debounced), and periodically.

## 6. REST API (all under `/api/v1`, JSON)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/register` (invite code), `GET /auth/sessions`, `DELETE /auth/sessions/:id` |
| Discovery | `GET /discover?q=&sort=`, `POST /subscriptions` (by podcast ID) |
| Admin | `GET /admin/overview`, `GET/POST/DELETE /admin/invites`, `GET/PATCH/DELETE /admin/users`, `POST /admin/users/:id/reset-link`, `GET /admin/feeds`, `POST /admin/feeds/:id/refresh`, `GET /admin/jobs`, `GET /admin/usage`, `GET /admin/audit`, `GET/PATCH /admin/settings` |
| Library | `POST /podcasts` (feed URL, also validates), `DELETE /subscriptions/:id`, `POST /opml/import`, `GET /opml/export` |
| Sync | `POST /sync` |
| Transcripts | `POST /episodes/:id/transcript` (queue), `GET /episodes/:id/transcript`, `GET /jobs/:id` |
| Proxy | `GET /proxy/audio?url=` (PWA only, see §7) |
| Ops | `GET /healthz` |

## 7. Security (internet-exposed)

- **TLS:** the server listens on HTTP behind a reverse proxy (Caddy recommended, for automatic HTTPS). The server trusts `X-Forwarded-*` only from a configured proxy and sets HSTS.
- **Passwords:** argon2id. Minimum length 10, no composition rules.
- **Tokens:** access token (14 days, signed JWT, `EdDSA` or `HS256`) + rotating refresh token (90 days, stored hashed, per-device, reuse detection revokes the family). Because 14 days is long for a stateless token, the access token carries a session ID and the server checks it against the in-memory session record on each request, so revoking a session (user logout, admin action, password reset) takes effect immediately. The PWA keeps the refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie. Native apps use Keychain / Keystore.
- **Abuse protection:** rate limits per IP and per username (login: 5/min with progressive lockout), request body size limits, JSON-schema validation on every route, strict CORS (the PWA origin only), `helmet` headers, CSP on the PWA.
- **SSRF protection** (feed fetcher, audio proxy, transcript downloader): http/https only; resolve DNS and **block private, loopback, link-local, and metadata ranges**; connect to the resolved IP to prevent DNS rebinding; revalidate on every redirect (max 5); timeouts; response size caps (feeds 10 MB, audio 1 GB for transcription only). The audio proxy additionally requires auth, records bytes transferred per user (tracking only, no quota; see Usage in §3.11), and only proxies URLs that belong to an episode in the database.
- **Transcription:** subprocesses are spawned with argument arrays (never a shell), in a temp directory, with a timeout and a file-size cap. Run as a non-root user.
- **Content safety:** feed HTML (descriptions) is sanitized server-side and rendered as text/limited HTML in clients. Never `eval` or interpolate feed data.
- **Registration:** invite-only; admin can disable users and revoke sessions. Audit log for auth events.
- **Deployment hardening:** Docker image, non-root, read-only filesystem except `/data`, no secrets in the image, JWT secret generated on first run, `npm audit` in CI, pinned dependencies.
- **Backups:** daily snapshot of the Loki file, plus an admin "export all my data" endpoint per user.

## 8. Server Details

- **Stack:** Node 26, TypeScript (strict), Fastify, LokiJS, `rss-parser` (or `fast-xml-parser` with custom podcast namespace handling), `argon2`, `pino` logging.
- **Feed poller:** runs every 30 min with a jittered per-feed schedule, using `ETag` / `If-Modified-Since`, backoff on failures, and a cap on episodes retained per feed in the DB (full history kept as metadata).
- **Job queue:** in-process, persisted in the `jobs` collection and resumed on boot. No external broker.
- **Config (env):** `PORT`, `DATA_DIR`, `PUBLIC_URL`, `WHISPER_BIN`, `WHISPER_MODEL`, `TRUST_PROXY`, `JWT_SECRET` (optional override).
- **Scale target:** about 1–20 users, about 500 feeds, and tens of thousands of episodes, comfortably in memory. LokiJS is unmaintained, so the DB access layer is wrapped in a thin repository module to make a later swap (e.g. SQLite) cheap.

## 9. Client Details

| | iOS | Android | PWA |
|---|---|---|---|
| Language/UI | Swift, SwiftUI (+ CarPlay templates) | Kotlin, Jetpack Compose (+ Android Auto) | TypeScript, React 19, Vite (latest), Tailwind v4 |
| Local DB | SQLite (GRDB) | Room | IndexedDB (Dexie) |
| Audio | AVPlayer, background audio, `MPNowPlayingInfoCenter` | Media3 / ExoPlayer, `MediaSessionService` | `<audio>` + Media Session API |
| Downloads | `URLSession` background | `WorkManager` + `DownloadManager` | fetch via proxy → OPFS/Cache |
| Secrets | Keychain | Keystore | HttpOnly cookie |

Shared across all three, as a documented contract in the repo: sync protocol schemas (JSON Schema), smart-playlist rule evaluator test vectors, and speed-resolution rules. This keeps the three implementations aligned without shared code.

**Repo layout:** a TypeScript monorepo (npm workspaces) with `server/`, `web/` (PWA + admin dashboard), and `shared/`. `shared/` holds the API types, validation schemas (zod), and the smart-playlist evaluator, used by both server and web with no duplication. The native apps implement the same evaluator and are verified against the shared test vectors.

PWA limits to document: iOS Safari may evict stored audio, and background playback is less reliable than native. Native apps are the primary offline experience.

## 10. Milestones

1. **Server core:** auth, invites, feed fetch/parse, episodes API, sync endpoint, SSRF guard, Docker + Caddy example.
2. **PWA MVP:** library, playback, speed, sleep timer, queue, offline downloads, sync. Fastest way to validate the protocol.
3. **Bookmarks, playlists, smart playlists** (server schema + PWA UI + shared rule test vectors).
4. **Transcripts:** worker, feed transcripts, viewer, search.
5. **Admin dashboard, Discover, usage tracking.**
6. **Android app** (parity with PWA) including Android Auto.
7. **iOS app** (parity with PWA) including CarPlay.
8. **Hardening pass:** pen-test checklist, rate-limit tuning, backups/restore drill, OPML.

Start the Apple CarPlay entitlement request during milestone 1; approval time is outside our control.

## 11. Open Questions
None at this time. Decisions made along the way:
- Any user can request a transcript. Requests are deduplicated per episode, so each episode is transcribed at most once.
- Usage stats are kept as daily rows for 1 year and pruned nightly.
- Discover shows subscriber count only, with no other popularity signals.
