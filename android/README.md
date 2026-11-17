# Homecast for Android

Native Kotlin app (Jetpack Compose, Material 3, minSdk 26) with Android Auto. Local-first: Room is the source of truth, the server is a sync hub.

```bash
cd android
./gradlew :app:assembleDebug      # or open this folder in Android Studio
./gradlew testDebugUnitTest       # unit tests, including the shared smart-playlist vectors
./gradlew :app:assembleRelease    # minified (R8), signed with the debug key for sideloading
```

Modules
- `:contract` shared models and service interfaces (the seam between the layers).
- `:core` Room database, sync engine (outbox + delta sync, spec §5), API client, auth (encrypted token storage), smart-playlist evaluator.
- `:playback` Media3 `MediaLibraryService` (ExoPlayer, notification, Bluetooth/headset), sleep timer, WorkManager downloads, Android Auto browse tree (Up Next, Playlists, Podcasts, Downloads) with speed and bookmark actions.
- `:app` Compose UI with the Homecast brand on Material 3 (teal/amber on ink, Space Grotesk, light and dark themes).

Casting: Google Cast through Media3's `CastPlayer`. `CastRoutes` (MediaRouter) finds devices while the picker sheet is open and selects one; when the Cast session starts, `PlaybackEngine.attachCast` moves the current episode to the `CastPlayer` (server copy or the podcast's URL, never a local file) and the media session follows it. Needs Google Play services; without them casting is simply absent. `CastOptionsProvider` uses the default media receiver.

Streaming: when the server hosts a copy of an episode (episode hosting), `PlaybackEngine` asks `Remote.streamUrl` for a signed URL and plays that; it renews the link if it expires and falls back to the podcast's own URL. Downloaded episodes play from disk.

Debug builds accept launch extras for testing, e.g.
`adb shell am start -n app.homecast.android/.MainActivity --es autologin "http://host:8080,user,pass" --ez play true --ez player true`.
`:app:assembleStaging` is minified like release but keeps those hooks.
Self-hosted servers on a LAN are usually plain http, so cleartext traffic is allowed; use TLS on the internet (spec §7).

## Testing Android Auto (Desktop Head Unit)
Verified on the Desktop Head Unit 2.0 (SDK `extras/google/auto`) against an emulator with the Android Auto app installed.
1. On the phone/emulator: Android Auto settings, tap *Version* 10 times to enable developer mode; in *Developer settings* enable **Unknown sources** (Homecast is sideloaded); overflow menu, **Start head unit server**; accept the first-run welcome and grant notification access to Android Auto.
2. `adb forward tcp:5277 tcp:5277` then run `desktop-head-unit`. The DHU console accepts `screenshot <file>`, `tap x y`, `keycode media`.
3. Open the app launcher: Homecast shows up with tabs Up Next, Playlists, Podcasts, Downloads, and Now Playing with speed and bookmark actions.
The Android Auto app can freeze in the background on emulators; `adb shell settings put global cached_apps_freezer disabled` helps.
