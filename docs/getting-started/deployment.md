---
title: "Deployment"
description: "Run Homecast behind Caddy with Docker."
---

# Deployment

Homecast listens on plain HTTP and expects a TLS-terminating reverse proxy in front of it. The repository ships a Docker image and a Compose file with [Caddy](https://caddyserver.com), which gets certificates automatically.

## Docker Compose

```bash
cp deploy/.env.example deploy/.env       # set DOMAIN=podcasts.example.com
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml logs homecast   # find the bootstrap token
```

The image:

- runs as a **non-root** user with a **read-only root filesystem** (only `/data` is writable);
- bundles `ffmpeg` and `whisper.cpp` with the `base.en-q5_1` model, so transcripts work out of the box;
- contains **no secrets**: the JWT secret is generated on first run and stored in the data volume.

## Prebuilt images

A GitHub Actions workflow publishes images to the GitHub Container Registry:

| Event | Tags |
|---|---|
| push to `main` | `ghcr.io/nprail/homecast:main` |
| push of a git tag `vX.Y.Z` | `ghcr.io/nprail/homecast:X.Y.Z` and `:latest` |

Images are built for `linux/amd64` and `linux/arm64`.

## Behind a reverse proxy

Set `PUBLIC_URL` to the public HTTPS address and `TRUST_PROXY` to the proxy's address so the server trusts `X-Forwarded-*` only from it. In the Compose file this is `uniquelocal`, which matches the private Docker network.

::: callout warning "HTTPS matters for the web app"
Offline downloads, the service worker and "install as app" require a secure context (HTTPS or `localhost`). Over plain `http://` on a LAN address the player still works, but without those features.
:::

## Data and backups

Everything lives in `DATA_DIR`:

| Path | Contents |
|---|---|
| `homecast.db.json` | the LokiJS database (autosaved every 5 s) |
| `backups/` | daily snapshots at 03:00 server time, newest 14 kept |
| `jwt.secret` | generated signing secret (mode 0600) |
| `models/` | Whisper models (downloaded on first use) |

Back up the volume, or use the **Back up now** button and copy `backups/`. Each user can also export their own data from the player's Profile page.

## Upgrading

Pull the new image (or rebuild) and restart. Data directories from older versions are migrated on start.
