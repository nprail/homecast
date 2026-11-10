---
title: "Deployment"
description: "Run Homecast behind Caddy with the published Docker image."
---

# Deployment

Homecast listens on plain HTTP and expects a TLS-terminating reverse proxy in front of it. The repository ships a Docker image and a Compose file with [Caddy](https://caddyserver.com), which gets certificates automatically.

## Docker Compose

The Compose file runs the published image `ghcr.io/nprail/homecast`, so there is nothing to build:

```bash
cp deploy/.env.example deploy/.env       # set DOMAIN=podcasts.example.com
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.yml logs homecast   # find the bootstrap token
```

To pin a version, set `HOMECAST_TAG` in `deploy/.env` (for example `HOMECAST_TAG=1.2.0`). Upgrading is `docker compose ... pull && docker compose ... up -d`.

The image:

- runs as a **non-root** user with a **read-only root filesystem** (only `/data` is writable);
- bundles `ffmpeg` and `whisper.cpp` (the prebuilt release binary for its architecture, checksum-verified at build time) with the `base.en-q5_1` model, so transcripts work out of the box;
- contains **no secrets**: the JWT secret is generated on first run and stored in the data volume.

## Published images

A GitHub Actions workflow publishes the image to the GitHub Container Registry:

| Event | Tags |
|---|---|
| push to `main` | `ghcr.io/nprail/homecast:main` |
| push of a git tag `vX.Y.Z` | `ghcr.io/nprail/homecast:X.Y.Z` and `:latest` |

Images are built for **`linux/amd64`** and **`linux/arm64`**, so they run on x86 servers and on ARM machines such as Raspberry Pi 4/5 (64-bit OS) and Apple Silicon. Docker picks the right one automatically.

::: callout tip "Building from source"
For development, build the image from your checkout instead of pulling it:

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml --env-file deploy/.env up -d --build
```
:::

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
