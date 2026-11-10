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

## Releases

Push a git tag `vX.Y.Z` to publish `ghcr.io/nprail/homecast:X.Y.Z` and `:latest`. Pushes to `main` publish `:main`.

## Demo data

`server/scripts/seed-demo.ts` fills a data directory with sample users, feeds, jobs, usage and an audit log, so the dashboard looks populated.

## License

Homecast is MIT licensed. See the repository's `LICENSE`, `SECURITY.md` and `CONTRIBUTING.md`.
