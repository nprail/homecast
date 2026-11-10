---
title: "Security"
description: "How Homecast is hardened for internet exposure."
---

# Security

Homecast is designed to be exposed to the internet behind a TLS reverse proxy.

## Accounts and sessions

- **Passwords**: argon2id, minimum length 10, no composition rules.
- **Registration** is invite-only. The first admin is created with a bootstrap token printed to the server log.
- **Access tokens** are signed JWTs valid for 14 days, but each carries a session id that is checked against the live session on every request, so logging out, an admin revoking sessions, disabling a user or a password reset takes effect **immediately**.
- **Refresh tokens** last 90 days, are stored hashed per device, and **rotate on every use**. Replaying a superseded token revokes the whole session.
- The web app keeps its refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie; its access token lives only in memory.
- **Login throttling**: 5 failures per minute per IP and per username trigger a 15-minute lockout that doubles on repeat (capped at 24 hours). Unknown usernames are throttled identically so lockouts do not reveal which accounts exist.

## Network requests (SSRF)

The feed fetcher, the audio proxy and the transcript downloader:

- allow only `http` and `https`;
- resolve DNS and **block private, loopback, link-local and metadata ranges** (including IPv4-mapped IPv6, NAT64 and 6to4);
- connect to the **validated address**, so DNS rebinding cannot swap it;
- re-validate on every redirect (maximum 5) and never forward credentials to another origin;
- enforce timeouts and size caps (feeds 10 MB, audio 1 GB for transcription only).

The audio proxy additionally requires authentication, only proxies URLs belonging to an episode in the database and records bytes per user.

## Other protections

- JSON-schema validation on every route, request body size limits, strict CORS, `helmet` headers and a Content-Security-Policy.
- Feed HTML is sanitized on the server, and sanitized again before the web app renders it.
- Private feeds can only be added with their feed URL; their ids are never accepted by Discover or sync.
- An audit log records sign-ins, failed sign-ins and admin actions.
- The Docker image runs as non-root with a read-only filesystem; there are no secrets in the image.

## Operating notes

- The **bootstrap token** printed on first run lets whoever has it create the admin account. Create the admin promptly and avoid pasting server logs into public places.
- The `demo` / `demo-password-123` login from the seed script is for local development only. Never run the seed script on a real server.

::: callout tip "Report a vulnerability"
Please open a private security advisory on the [GitHub repository](https://github.com/nprail/homecast/security) instead of a public issue.
:::
