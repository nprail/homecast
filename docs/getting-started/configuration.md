---
title: "Configuration"
description: "Environment variables and runtime settings."
---

# Configuration

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | database, `backups/`, `jwt.secret`, temp files, models |
| `PUBLIC_URL` | `http://localhost:$PORT` | used for links, cookies (`Secure` when `https`), CORS and HSTS |
| `TRUST_PROXY` | off | `true`, or a list of proxy IPs, CIDRs or keywords (`loopback`, `uniquelocal`). `X-Forwarded-*` is trusted only from these |
| `JWT_SECRET` | generated | optional override, 32 or more characters |
| `CORS_ORIGINS` | none | extra allowed origins (for example `http://localhost:5173` in development) beyond `PUBLIC_URL` |
| `WHISPER_BIN` | `whisper-cli` | path to the whisper.cpp binary |
| `WHISPER_MODEL` | `base.en-q5_1` | model name; the file is `ggml-<model>.bin`. Can also be changed in the admin dashboard |
| `WHISPER_MODEL_DIR` | `$DATA_DIR/models` | missing standard models are downloaded here on first use |
| `FFMPEG_BIN` | `ffmpeg` | |
| `WEB_DIR` | `../web/dist` | the built web app |
| `MAX_EPISODES_PER_FEED` | `5000` | newest episodes kept per feed |
| `LOG_LEVEL` | `info` | |
| `DISABLE_WORKERS` | unset | `true` disables the feed poller, transcript queue and maintenance |
| `ALLOW_PRIVATE_NETWORKS` | `false` | **tests and development only**: disables the SSRF guard's address blocking |

## Settings in the dashboard

These live in the database and apply immediately (**Admin → Settings**):

- **Allow new sign-ups**: turn off to stop accepting invite codes entirely.
- **Poll interval**: how often subscribed feeds are checked (5 to 1440 minutes).
- **Whisper model** and **auto-transcribe** (see [Transcripts](/guides/transcripts)).
- **Back up now**.
