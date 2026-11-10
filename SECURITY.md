# Security policy

Homecast is designed to be exposed to the internet behind a TLS reverse proxy, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability** (https://github.com/nprail/homecast/security/advisories/new).

Include what you found, how to reproduce it, and the version or commit. You can expect an acknowledgement within a few days. Please give a reasonable time to fix the issue before disclosing it publicly.

## Scope

In scope: the server (`server/`), the web app and admin dashboard (`web/`), the shared protocol code (`shared/`) and the Docker image.

Particularly interested in: authentication and session handling, authorization on `/api/v1/admin/*`, server-side request forgery in the feed fetcher, audio proxy and transcript downloader, injection through feed content, and the sync protocol.

## Notes for operators

- The bootstrap token printed on first run lets whoever has it create the admin account. Do not paste server logs into public places, and create the admin account promptly.
- The demo credentials in the docs (`demo` / `demo-password-123`) belong to the optional seed script for local development only. Never run it on a real server.
- `ALLOW_PRIVATE_NETWORKS=true` disables the server-side request forgery guard. It exists for tests and local development only.
- See the Security page in the documentation for how the server is hardened.
