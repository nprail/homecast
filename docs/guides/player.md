---
title: "Using the player"
description: "Playback, queue, playlists, bookmarks, offline and sync in the web player."
---

# Using the player

The web player is an installable PWA. It stores everything it shows in a local database (IndexedDB), so it opens instantly and works without a connection. Changes you make are queued and synced when you are online.

## Library

- **Add podcasts** by feed URL or by importing an OPML file. Private feeds (credentials or tokens in the URL) are never shown in Discover.
- **Podcast page**: filters for unplayed, all and downloaded episodes, plus per-podcast settings: speed override, auto-download (latest N or all new) and delete-played-after-N-days.
- **Discover** lists podcasts other people on your server follow. Only a subscriber *count* is shown, never who.

## Playback

| Feature | Details |
|---|---|
| Skip | back 15 s, forward 30 s; Media Session gives lock-screen and headset controls |
| Speed | 0.5× to 3.0× in 0.1 steps with pitch correction. A podcast override wins over the global default; clear it from the player |
| Sleep timer | 5, 15, 30, 45, 60 minutes, a custom time, or end of episode. Fades out over the last 10 s; tap (or shake on mobile) to extend |
| Resume | position saved locally every 5 s, pushed to the server on pause, episode change and every 30 s while online |

## Up Next, playlists and smart playlists

- **Up Next** is the built-in queue. Use *Play next* or *Play last* from any episode menu and reorder with the drag handle (or the arrow keys on the handle).
- **Playlists** are ordered lists you can play through.
- **Smart playlists** collect episodes by [rules](/reference/smart-playlists) evaluated on your device, so they work offline. They can auto-download their results.

## Bookmarks

Tap the bookmark button in the player to save a moment with an optional title and note, or use **Bookmark this line** in a transcript. Bookmarks are listed per episode and globally; tap one to jump there. When a transcript is available, the nearby line is shown as a preview.

## Offline

- **Downloads** go through the server's authenticated audio proxy into the browser's Cache API. The audio proxy is needed because browsers cannot cache cross-origin audio without CORS headers.
- Set a **storage cap** and a **Wi-Fi only** switch on the Profile page (device-local settings).
- The service worker caches the app shell, so the player loads offline.

::: callout warning "Browser limits"
iOS Safari may evict stored audio when space is low, and background playback is less reliable than in a native app. The native apps are the primary offline experience.
:::

## Sync status

The sidebar (or Profile page) shows when the last sync happened. *Offline* appears only when a request to the server actually fails; the player keeps trying every few seconds and syncs as soon as the server is reachable.
