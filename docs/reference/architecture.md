---
title: "Architecture"
description: "How the server, web app and native clients fit together."
---

# Architecture

```text
┌────────────┐ ┌────────────┐ ┌────────────┐
│ iOS (Swift)│ │ Android    │ │ Web PWA    │
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

## Key decisions

- **Local-first clients.** Each client owns a full local database of the user's data and works entirely from it. The server is a sync hub.
- **The server fetches feeds.** One poller serves all users, so smart playlists and "new episode" state are consistent across devices, and the PWA avoids CORS problems.
- **Audio goes directly from the podcast CDN to the client.** The server never stores audio, except transiently for transcription. The exception is an authenticated proxy for the PWA's downloads.
- **Smart playlists are evaluated on-device** from local data. The server stores only the rule definitions.

## Server

- **Stack**: Node.js, TypeScript (strict), Fastify, LokiJS, `fast-xml-parser`, `argon2`, `pino`.
- **Repository layer**: all database access goes through `server/src/db`, a thin wrapper over LokiJS, so swapping the engine later (for example SQLite) is cheap. LokiJS is unmaintained.
- **Scale target**: about 1 to 20 users, 500 feeds and tens of thousands of episodes, comfortably in memory.
- **Feed poller**: every 30 minutes by default with per-feed jitter, `ETag` / `If-Modified-Since`, and exponential backoff on failures.
- **Job queue**: in-process, persisted in the database and resumed on boot. No external broker.
- **Maintenance**: daily backup at 03:00, nightly tombstone purge, usage and audit pruning.

## Data model

Every synced record carries `id`, `rev` (a server-assigned, monotonically increasing revision) and a `deleted` tombstone flag.

| Collection | Scope | Notes |
|---|---|---|
| `users`, `refreshTokens`, `invites`, `resetTokens` | global | accounts and sessions |
| `podcasts`, `episodes`, `transcripts` | shared | one copy for all users |
| `subscriptions`, `episodeStates`, `bookmarks`, `playlists`, `smartPlaylists`, `settings` | per user | synced to clients |
| `jobs`, `usageStats`, `auditLog`, `serverSettings` | global | operations |

## Web app

React 19, Vite and Tailwind v4. The player and the admin dashboard are one app; the dashboard is code-split. The local database is Dexie over IndexedDB (one database per user), and a service worker caches the app shell.

The native apps implement the same sync protocol and the same smart-playlist evaluator, verified against the shared test vectors in `shared/vectors`.
