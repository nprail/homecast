# AGENTS.md

Guidance for AI coding agents working in this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

Homecast is a self-hosted podcast player and sync server. One server, three clients that must behave the same: the **web** PWA, the **iOS** app and the **Android** app.

## Repository map

| Path | What it is |
|---|---|
| `shared/` | zod schemas, sync types, the smart-playlist evaluator and its test vectors (`shared/vectors`) |
| `docstore/` | `@homecast/docstore`, our own in-memory document store (standalone package, has its own docs site) |
| `server/` | Fastify server. `src/routes` (HTTP), `src/services` (logic), `src/db` (repository layer over three engines), `test/` |
| `web/` | React PWA: the player (`src/player`) and the admin dashboard (`src/pages/admin`) |
| `ios/` | SwiftUI app, GRDB. `Sources/Homecast/{Core,Features,CarPlay}` |
| `android/` | Kotlin, Compose, Room. Modules `:contract`, `:core`, `:playback`, `:app` |
| `docs/` | The documentation site (docmd). `docs/reference/spec.md` and `SPEC.md` are the product spec |

## Commands

```bash
npm install
npm run dev:server        # http://localhost:8080
npm run dev:web           # http://localhost:5173, proxies /api
npm run typecheck         # shared, docstore, server, web
npm test                  # shared vectors + docstore + server suites
npm run build
npm run docs:dev          # the main docs site
```

Run before saying a change is done: `npm run typecheck && npm test`. CI also runs the server suite on the other engines:

```bash
npm run test:sqlite -w server
npm run test:docstore -w server
```

Native apps:

```bash
cd android && ./gradlew :app:assembleDebug && ./gradlew testDebugUnitTest
xcodebuild test -scheme Homecast -destination 'platform=iOS Simulator,name=iPhone 17'   # from ios/
```

## Commits

- **Only commit or push when asked.** Never open a pull request unless asked.
- **Conventional Commits**: `type(scope): summary`. Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`. Scopes are optional and match the area: `server`, `web`, `ios`, `android`, `docstore`, `shared`, `docs`. Examples: `feat(server): add new-episode notification endpoints`, `fix(ios): focus the search field on the transcript search page`.
- Summary in the imperative mood, lowercase after the colon, no trailing period, about 72 characters at most. Use the body to say **why**, wrapped at about 72 columns. Mark breaking changes with `!` (`feat(server)!:`) and a `BREAKING CHANGE:` footer.
- **No co-author or attribution lines.** No `Co-Authored-By`, no "Generated with" footers, in commits or in PR descriptions, and no mention of any AI model or tool.
- **Commits are unsigned**: `git -c commit.gpgsign=false commit`. Signing prompts cannot be answered from an agent session.
- Keep commits focused. When asked to commit a large change, split it into logical commits (for example a library, then the code that uses it), each of which builds and passes tests.
- Never use `--no-verify`, never force-push `main`, never rewrite pushed history.

## Keep web, Android and iOS in sync

A feature is not done until it exists on **all three clients** with the same behaviour. When you add or change a user-facing feature:

1. **Decide the contract first.** If it needs the server, change the server and `shared/` (schemas, sync types) before the clients, and write the REST or sync shape in `docs/reference/api.md` or `docs/reference/sync.md`.
2. **Implement it on web, iOS and Android in the same change** (or the same series of commits). Behaviour, naming, defaults, ordering, empty states and error messages should match. Native UI follows platform conventions (SwiftUI and Liquid Glass on iOS, Material 3 on Android); the feature does not change between them.
3. **Where it lives:**

   | Concern | Web | iOS | Android |
   |---|---|---|---|
   | Screens | `web/src/player/pages`, `components` | `ios/Sources/Homecast/Features/*` | `android/app/src/main/kotlin/app/homecast/android/ui/*` |
   | Data and sync | `web/src/player/AppData.tsx`, `lib` | `Core/Sync`, `Core/Data`, `Core/Models` | `:core` (Room, sync engine), `:contract` |
   | Playback | `web/src/player/lib` | `Core/Playback` | `:playback` |
   | Settings | player settings page | `Features/Settings` | `ui/settings` |

4. **Server-owned logic belongs on the server.** Anything all clients must agree on (smart-playlist rules, sync conflict rules, search, chapters, share links) is either defined in `shared/` with test vectors that every client runs, or computed by the server. Do not let three implementations drift.
5. **If you really cannot do all three** (a platform limit, such as CarPlay not being testable in the simulator, or Android Auto), say so explicitly in the final message and in the commit body, and note it in the docs so the gap is known. Do not silently ship one client.
6. Native clients are offline-first: GRDB (iOS) and Room (Android) are the source of truth and the server is a sync hub. New synced data needs an outbox entry and delta-sync handling on both native clients, plus a database migration.
7. If you change the sync protocol or the smart-playlist rules, update `shared/vectors` and the docs. Native clients run those vectors in their tests.

When reviewing your own change, check each of the three clients against the checklist: screen, empty state, error state, offline behaviour, settings, tests.

## Server and storage

- The server talks to storage only through the repository interface in `server/src/db/repo.ts` (`find`, `findOne`, `where`, `count`, `save`, `insert`, `remove`). Do not reach into an engine. There are three: `loki` (default), `sqlite`, `docstore`. A query or index you add must work on all three, so use only equality, `$in`, `$gt` and compound indexes declared in `server/src/db/index.ts`, and run the suite on every engine.
- Documents from Loki and docstore are the live objects: change one, then call `save`/`update`. SQLite returns copies from an identity map, so always save.
- Sync asks for changed records only (`rev` cursors, compound `(owner, rev)` indexes). Do not add a query that reads everything per request.
- Background work (transcripts, mirroring, polling) must be awaited on shutdown before the database closes.
- Hardening is deliberate: argon2id passwords, token rotation, the SSRF guard (`security/ssrf.ts`), signed media URLs. Do not weaken or bypass them, and add a test for any new route's authorization.
- Config comes from environment variables in `server/src/config.ts` and is documented in `docs/getting-started/configuration.md`. A new variable needs both.

## Docs

- User-visible changes update the docs in the same commit: `docs/` for Homecast, `docstore/docs/` for the document store (and `docstore/README.md`).
- Write plainly. No marketing language, no em-dash flourishes. Numbers in docs come from a run you did; say how they were measured.
- Check links and build before finishing: `npm run docs:build` (and `npx docmd build` inside `docstore/`).

## Testing expectations

- Add or update tests with every behaviour change. Server tests run against an in-memory database (`server/test/helpers.ts`; `HC_TEST_DB=sqlite|docstore` selects the engine).
- For performance claims, measure. `server/scripts/bench-db.ts` and `docstore/bench/vs-loki.ts` exist for this. Do not state a speedup you did not run.
- Fix the cause of a failing test rather than weakening it. If a test is wrong, say why.

## iOS notes

- Open `ios/Homecast.xcodeproj` (a normal Xcode project; GRDB comes through Swift Package Manager). Targets iOS 26 and later.
- Installing on a physical device needs a development team and a connected, trusted device; the CarPlay entitlements are disabled for personal teams. Ask the user for the team and device rather than guessing.
- `.gitignore` has an exception for `ios/Sources/Homecast/Core/Data/` (a macOS case-insensitivity quirk with the `data/` rule). Do not remove it.
- Debug builds take `HC_*` launch variables (for example `HC_AUTOLOGIN="server|user|pass"`) for screenshots and testing.

## Android notes

- Debug builds accept launch extras (`--es autologin "http://host:8080,user,pass"`). `:app:assembleStaging` is minified like release but keeps those hooks.
- Self-hosted servers on a LAN are usually plain http, so cleartext traffic is allowed.

## Safety

- Do not commit secrets, tokens, `.env` files, signing keys or anything under `data/`, `data-*/` (these are gitignored; keep it that way). Test credentials come from fixtures or seed scripts, not from real accounts.
- Do not delete or overwrite a user's data directory or database. Migrations write to a new location and never modify the source.
- Never run a destructive command (`rm -rf`, `git reset --hard`, dropping data) on something you have not looked at first.
- Dependencies are pinned to exact versions. Add one only when it earns its place, and say why in the commit body. Run `npm run audit` after changing them.
