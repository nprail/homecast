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
| `POST /opml/import`, `GET /opml/export` | OPML in and out |
| `GET /me/export` | all of your own data as JSON |

## Sync, transcripts and audio

| Route | Description |
|---|---|
| `POST /sync` | delta sync, see [Sync protocol](/reference/sync) |
| `POST /episodes/:id/transcript` | request a transcript (deduplicated) |
| `GET /episodes/:id/transcript` | the transcript, or `202` while it is being generated |
| `GET /jobs/:id` | job status (the requester, attached users and admins) |
| `GET /proxy/audio?url=` | authenticated audio proxy, web app only; supports `Range` |

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
| `GET/PATCH /admin/settings`, `POST /admin/backup` | settings and backups |

## Operations

`GET /healthz` (also available at the server root) returns `{ ok, version, uptimeSec }` for load balancers and container health checks.

## Rate limits

A global limit applies per IP, with stricter limits on login, registration, password reset, OPML import and transcript requests. Exceeding a limit returns `429`.
