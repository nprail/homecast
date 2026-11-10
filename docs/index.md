---
title: "Homecast"
description: "A self-hosted podcast player with a sync server, admin dashboard and offline-first PWA."
---

# Homecast

Homecast is a podcast player with a self-hosted sync server. You run one small Node.js process, your family or team signs in with invite codes, and everyone's subscriptions, progress, bookmarks and playlists stay in sync across devices.

::: callout info "What is in the box"
The **server** (Fastify + LokiJS), the **web player** (an installable, offline-first PWA) and the **admin dashboard** are built. Native Android and iOS apps are planned and will speak the same [sync protocol](/reference/sync).
:::

## Highlights

::: card "Local-first" icon:wifi-off
The player reads only from a database on your device and works fully offline, including downloaded episodes. The server is a sync hub, not a runtime dependency.
:::

::: card "One feed poller for everyone" icon:rss
The server fetches feeds once for all users, so new-episode state and smart playlists agree on every device. Audio goes straight from the podcast CDN to the listener.
:::

::: card "Transcripts" icon:captions
Publisher transcripts when the feed has them, otherwise [Whisper](/guides/transcripts) on your own hardware. Tap a line to seek, search inside an episode, and bookmark a line.
:::

::: card "Safe to expose" icon:shield-check
Invite-only registration, argon2id, instantly revocable sessions, refresh-token reuse detection, SSRF-guarded fetching and an audit log. See [Security](/guides/security).
:::

## Where to go next

- New here? Follow the [Quick start](/getting-started/quick-start).
- Putting it on a server? Read [Deployment](/getting-started/deployment) and [Configuration](/getting-started/configuration).
- Running it for other people? See the [Admin dashboard](/guides/admin) guide.
- Writing a client? Start with the [Sync protocol](/reference/sync) and [REST API](/reference/api).

## Project layout

```text
shared/   zod schemas for the API and sync protocol, smart-playlist evaluator + test vectors
server/   Fastify + LokiJS server (repository layer in src/db, services/, routes/)
web/      React 19 + Vite + Tailwind v4: the player PWA and the admin dashboard
deploy/   docker-compose (published image), docker-compose.dev.yml (build from source), Caddyfile
logo/     Homecast logo sources
docs/     this documentation (docmd)
```
