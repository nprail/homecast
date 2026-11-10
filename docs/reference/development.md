---
title: "Development"
description: "Working on Homecast: repository, tests, docs and releases."
---

# Development

## Repository

An npm-workspaces monorepo:

| Workspace | Purpose |
|---|---|
| `shared/` | zod schemas, sync types, smart-playlist evaluator and test vectors |
| `server/` | Fastify + LokiJS server |
| `web/` | React player PWA and admin dashboard |

```bash
npm install
npm run dev:server     # http://localhost:8080
npm run dev:web        # http://localhost:5173, proxying /api
npm run typecheck
npm test               # shared evaluator vectors + the server suite
npm run build
```

## Tests

The server suite covers auth (invites, lockout, token rotation and reuse, immediate revocation), every admin route's authorization, the SSRF guard, sync conflict rules and paging, feeds, discovery, the audio proxy, usage, and transcripts. The transcript tests run the real worker against stand-in `ffmpeg` and `whisper-cli` scripts, so they need no binaries.

## Docs

These docs are built with [docmd](https://docmd.io) from the Markdown in `docs/`:

```bash
npm run docs:dev       # live preview
npm run docs:build     # static site in site/
```

Pushes to `main` publish the site to GitHub Pages.

## Icons and branding

The PWA icons are rendered from `logo/homecast-app-icon.svg` by `web/scripts/make-icons.mjs` (it needs `playwright-core` and a Chromium binary; see the header of the script).

## Docker

The Docker image is built from this checkout only for development:

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml up -d --build
```

The `Dockerfile` downloads a pinned whisper.cpp release binary for the target architecture (amd64 or arm64) and the default model, checking each against a SHA-256 digest. To upgrade whisper.cpp, change `WHISPER_RELEASE` and both `WHISPER_SHA256_*` values together.

## Releases

Push a git tag `vX.Y.Z` to publish `ghcr.io/nprail/homecast:X.Y.Z` and `:latest`. Pushes to `main` publish `:main`.

## Demo data

`server/scripts/seed-demo.ts` fills a data directory with sample users, feeds, jobs, usage and an audit log, so the dashboard looks populated.

## License

Homecast is MIT licensed. See the repository's `LICENSE`, `SECURITY.md` and `CONTRIBUTING.md`.
