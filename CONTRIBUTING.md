# Contributing

Thanks for your interest in Homecast.

## Getting set up

```bash
npm install
npm run dev:server   # http://localhost:8080
npm run dev:web      # http://localhost:5173, proxies /api to :8080
```

On first run the server prints a bootstrap token for creating the admin account. The documentation covers this in the Quick start.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run build
```

- Keep changes focused. For larger changes, open an issue first to discuss the approach.
- Add or update tests with behaviour changes. Server tests live in `server/test` and run against an in-memory database; smart-playlist rules are covered by the shared vectors in `shared/vectors`.
- If you change the sync protocol or the smart-playlist rules, update the vectors and the documentation, because native clients implement the same contracts.
- Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Documentation

The docs are Markdown in `docs/`, built with [docmd](https://docmd.io): `npm run docs:dev` for a live preview.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
