# Homecast for iOS

Native SwiftUI app (iOS 26+, Liquid Glass) with CarPlay. Local-first: GRDB/SQLite is the source of truth, the server is a sync hub.

```bash
open ios/Homecast.xcodeproj   # regular Xcode project, GRDB comes in via Swift Package Manager
```

- `Core/` models (synced records), GRDB database, sync engine (outbox + delta sync, spec §5), API client + Keychain, player (AVPlayer, Now Playing, sleep timer, speed resolution), background downloads.
- Streaming: when the server hosts a copy of an episode (episode hosting), `Player` asks `APIClient.signedStreamURL` for a signed URL and plays that; it renews the link if it expires and falls back to the podcast's own URL. Downloaded episodes play from disk.
- `Features/` SwiftUI screens: Library, Podcast, Episode, Up Next / Playlists / Smart playlists (on-device evaluator), Bookmarks, Transcripts, Discover, Downloads, Settings.
- `CarPlay/` CPTemplateApplicationSceneDelegate: tabs Up Next, Playlists, Podcasts, Downloads; Now Playing with speed + bookmark buttons.
- `Tests/` run the shared smart-playlist vectors (`shared/vectors/smart-playlist.json`) plus data-layer tests: `xcodebuild test -scheme Homecast -destination 'platform=iOS Simulator,name=iPhone 17'`.

CarPlay needs the `com.apple.developer.carplay-audio` entitlement from Apple (spec §3.12). Xcode 27's CarPlay Simulator only supports a physical iPhone, so CarPlay can't be exercised in the iOS Simulator.
Debug builds accept `HC_AUTOLOGIN="server|user|pass"` and a few `HC_*` launch variables used for screenshots.
