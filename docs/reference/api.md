---
title: "REST API"
description: "The JSON API under /api/v1."
---

# REST API

All routes live under `/api/v1` and speak JSON. Authenticated routes need `Authorization: Bearer <access token>`. Errors have the shape `{ "error": { "code": "...", "message": "..." } }`.

## Auth

| Route | Description |
|---|---|
| `POST /auth/register` | create an account with `inviteCode`, or the first admin with `bootstrapToken` |
| `POST /auth/login` | `{ username, password, deviceName?, client }`; returns tokens |
| `POST /auth/refresh` | rotate the refresh token (body for native clients, cookie for the web) |
| `POST /auth/logout` | revoke the current session |
| `GET /auth/me` | the signed-in user |
| `GET /auth/sessions`, `DELETE /auth/sessions/:id` | list and revoke your own devices |
| `POST /auth/change-password` | requires the current password; signs out other devices |
| `POST /auth/reset-password` | redeem a one-time reset link |

`client: "web"` keeps the refresh token in an `HttpOnly` cookie and omits it from the response body; `client: "native"` returns it in the body for the Keychain or Keystore.

## Library and discovery

| Route | Description |
|---|---|
| `POST /podcasts` | `{ feedUrl, private? }` validates and adds a feed, and subscribes you |
| `POST /subscriptions` | subscribe by podcast id (public podcasts only) |
| `DELETE /subscriptions/:id` | unsubscribe |
| `GET /discover?q=&sort=` | podcasts other users follow; `sort` is `subscribers`, `recent` or `az` |
| `POST /opml/import` | OPML document as the body (`text/x-opml`). Subscribes to up to 500 feeds, nested folders included. Returns `{ imported, alreadySubscribed, failed: [{ url, error }], skipped }` |
| `GET /opml/export` | your subscriptions as OPML |
| `GET /me/export` | all of your own data as JSON |

### Public directory (no login)

Served only while Settings → Public directory is on; otherwise every route except `config` answers 404. Read-only. See [Public directory](/guides/admin#public-directory).

| Route | Description |
|---|---|
| `GET /public/config` | `{ enabled, listening, transcripts, subscriberCounts }` |
| `GET /public/discover?q=&sort=&limit=&offset=` | the Discover list. `sort` is `recent` or `az`, or `subscribers` when counts are shown. `subscriberCount` is 0 unless counts are shown |
| `GET /public/podcasts/:id?limit=&offset=` | the podcast and a page of episodes, newest first. Private feeds are 404 |
| `GET /public/episodes/:id` | the episode with show notes and chapters. `audioUrl` is the publisher's address when public listening is on, else `null`. `hasTranscript` is true only when public transcripts are on |
| `GET /public/episodes/:id/transcript` | `{ status, source, segments }`; 404 unless public transcripts are on |

## Sync, transcripts and audio

| Route | Description |
|---|---|
| `POST /sync` | delta sync, see [Sync protocol](/reference/sync) |
| `POST /episodes/:id/transcript` | request a transcript (deduplicated) |
| `GET /episodes/:id/transcript` | the transcript, or `202` while it is being generated |
| `GET /search/transcripts?q=&podcastId=&limit=&offset=` | ranked full-text search over the transcripts of podcasts you subscribe to. `q` is 2 to 100 characters: words (every one must appear in the episode, other forms and the start of the last word match, small typos are tolerated), `"quoted phrases"` (exact, in order), and `-word` or `-"phrase"` to exclude. Returns `{ total, items: [{ episodeId, podcastId, episodeTitle, podcastTitle, releasedAt, matches, hits: [{ startMs, text, marks }] }] }`, best match first. `matches` counts the lines with all the words (or, if no line has them all, any of them); `hits` holds up to three of those lines in transcript order, and `marks` are the matched stretches of `text` as `[start, end]` offsets (UTF-16 code units, end exclusive) |
| `GET /episodes/:id/share` | what a shared moment link points at: `{ episode: { id, title, durationSec, releasedAt }, podcast: { id, title, imageUrl, isPrivate }, subscribed }`. Public podcasts for everyone; private ones only for subscribers and admins (`404` otherwise) |
| `GET /episodes/:id/chapters` | `{ source: "json" \| "feed" \| "description", chapters: [{ startMs, title, img?, url? }] }`, or `404` when the episode has none. The publisher's chapters file is fetched on demand (SSRF-guarded) and cached for a day |
| `GET /jobs/:id` | job status (the requester, attached users and admins) |
| `GET /proxy/audio?url=` | authenticated audio proxy, web app only; supports `Range`. Serves the server's own copy when episode hosting has one |
| `GET /episodes/:id/stream` | a signed, short-lived URL (12 hours) to stream the server's copy: `{ url, expiresAt }`, or `url: null` when the episode isn't hosted. Needs `Authorization` |
| `GET /media/:id?u=&exp=&sig=` | streams a hosted copy with `Range` support using a signed URL, so an `<audio>` element can play it without a header. No `Authorization`; the signature is bound to the episode, the user and the expiry |

### Streaming hosted episodes (client authors)

When the server keeps its own copy of an episode (episode hosting), clients should stream that copy instead of the podcast's URL:

1. Before playing an episode that isn't downloaded, call `GET /episodes/:id/stream` (with `Authorization`) and give it a short timeout, about 4 seconds.
2. If the response has a non-null `url`, resolve it against the server address and play it directly. It needs no `Authorization` header, so `AVPlayer` and ExoPlayer can use it as is, with range requests.
3. If `url` is `null`, the request fails or it is too slow, play the episode's own `audioUrl`.
4. If playback of a signed URL fails (the link expired or the copy was deleted), request a fresh one and resume from the same position. After two failed renewals, fall back to `audioUrl`.

The web player and both native apps follow this.

## Admin

All require the `admin` role.

| Route | Description |
|---|---|
| `GET /admin/overview` | dashboard numbers |
| `GET /admin/users`, `PATCH /admin/users/:id`, `DELETE /admin/users/:id` | manage users |
| `POST /admin/users/:id/reset-link`, `POST /admin/users/:id/revoke-sessions` | one-time reset link, revoke all sessions |
| `GET/POST /admin/invites`, `DELETE /admin/invites/:id` | invites |
| `GET /admin/feeds`, `PATCH /admin/feeds/:id`, `POST /admin/feeds/:id/refresh`, `DELETE /admin/feeds/orphans` | feeds |
| `GET /admin/jobs`, `POST /admin/jobs/:id/retry`, `POST /admin/jobs/:id/cancel` | transcript jobs |
| `GET /admin/usage?days=&format=` | usage; `format=csv` for the export |
| `GET /admin/audit` | audit log |
| `GET/PATCH /admin/settings`, `POST /admin/backup` | settings (including `episodeMirror`) and backups |
| `DELETE /admin/mirror` | delete all hosted episode copies; only allowed while episode hosting is off |

## Operations

`GET /healthz` (also available at the server root) returns `{ ok, version, uptimeSec }` for load balancers and container health checks.

## Rate limits

A global limit applies per IP, with stricter limits on login, registration, password reset, OPML import and transcript requests. Exceeding a limit returns `429`.
