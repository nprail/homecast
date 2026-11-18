---
title: "Using the player"
description: "Playback, queue, playlists, bookmarks, offline and sync in the web player."
---

# Using the player

The web player is an installable PWA. It stores everything it shows in a local database (IndexedDB), so it opens instantly and works without a connection. Changes you make are queued and synced when you are online.

## Library

- **Add podcasts** by feed URL or by importing an OPML file (from Overcast, Pocket Casts, Apple Podcasts and most other apps; folders are fine). The import skips podcasts you already follow and lists any feeds it could not read. **Profile → Export subscriptions** downloads your own OPML. Private feeds (credentials or tokens in the URL) are never shown in Discover.
- **Search transcripts** (the magnifier on the Podcasts page, or *Search transcripts* in the sidebar) finds what was said across the transcripts of every podcast you follow. Results show the episode, the matching lines and their timestamps; tap one to play from there with the transcript open. It is a ranked full-text search: it finds other forms of a word ("plant" finds "planting"), the start of the word you are still typing, accented letters without the accent, and small typos. Every word must appear somewhere in the episode, and episodes where the words come close together rank first. Put quotes around an exact phrase and a minus sign before a word to leave it out (`slow "sun and water" -blight`). Search runs on the server, so it needs a connection, and only episodes that have a transcript are searched.
- **Podcast page**: filters for unplayed, all and downloaded episodes, plus per-podcast settings: speed override, auto-download (latest N or all new) and delete-played-after-N-days.
- **Discover** lists podcasts other people on your server follow. Only a subscriber *count* is shown, never who.

## Playback

| Feature | Details |
|---|---|
| Skip | back 15 s, forward 30 s; Media Session gives lock-screen and headset controls |
| Speed | 0.5× to 3.0× in 0.1 steps with pitch correction. A podcast override wins over the global default; clear it from the player |
| Sleep timer | 5, 15, 30, 45, 60 minutes, a custom time, or end of episode. Fades out over the last 10 s; tap (or shake on mobile) to extend |
| Resume | position saved locally every 5 s, pushed to the server on pause, episode change and every 30 s while online |
| Pick up where you left off | after a sync, a device that is not playing shows the episode you last played on any device, paused at its position. It never interrupts playback, and a finished episode is not brought back |

### Picking up on another device

Nothing extra is synced for this. Every device already syncs each episode's position, and the server keeps the time of the last play. When a device syncs, it looks for the in-progress episode (of a podcast you follow) with the newest play time. If that is not the episode loaded in the player, the player loads it paused, in the Up Next context. If it is the same episode and another device has moved on, the player jumps to the new position. Pausing, backgrounding the app or reloading the page does not count as a play, so a device you only looked at never takes over. Casting devices and a player that is playing or loading are left alone.

## Show notes

Links in show notes open in your browser, and a timestamp (`12:30`, `1:02:03`) jumps to that time: it starts the episode if it is not playing, then seeks. Web addresses written as plain text (`https://…` or `www.…`) become links too. A time written like a clock time (`8:30 PM`) and a timestamp past the end of the episode are left as text. Only `http`, `https` and `mailto` links are kept. The same rules run on web, iOS and Android (`shared/vectors/show-notes.json`).

## Casting

Play on a speaker, TV or Chromecast from the full-screen player (the **Cast** button, or the AirPlay button on iPhone and iPad). The phone or browser stays the remote: play, pause, seek, skip and speed all work, and your position keeps syncing to the server while the device plays.

| | How |
|---|---|
| Web | the browser's own device picker: Chromecast in Chrome and Edge, AirPlay in Safari. Firefox has no casting |
| Android | Google Cast (Chromecast, and speakers and TVs with Google Cast built in). Needs Google Play services |
| iOS | AirPlay (the system route picker). Chromecast devices are not supported on iOS |

How the device gets the audio:

- **A copy the server hosts** (episode hosting) is played from the server through a signed link, so the device must be able to reach your server. A server on `localhost`, or one that is only reachable from outside your network, cannot be cast from; use an address the device can open (your LAN address, or the public URL).
- **Any other episode** is fetched from the podcast's own address by the device itself.
- **A downloaded episode** lives on your phone or in your browser, so the device cannot read it. While casting, the app plays the server's copy or the podcast's address instead, and goes back to the download when you stop.
- Devices have to be on the same network as the phone, and (on Android and in Chrome) are found only while the picker is open or in the page.

Choosing "This phone" (Android) or stopping the cast brings playback back to the phone at the same position. The sleep timer still pauses a cast session; its volume fade does not apply to a device.

## Chapters

When an episode has chapters, the player shows the current chapter under the title, marks them on the seek bar and adds a **Chapters** list: tap a chapter to jump to it. The episode page lists them too.

Chapters come from, in order: the publisher's Podcasting 2.0 chapters file (`<podcast:chapters>`), chapters written into the feed (Podlove Simple Chapters), or a list of timestamps in the show notes (like `00:00 Intro`), which is used only when there are at least three, in order, starting near the beginning. Chapters embedded inside the audio file itself are not read.

## Sharing a moment

Share an episode, or a specific moment in it, with other people on your server. In the web player use **More → Share this moment** (it uses the current position), the **Share** button on an episode page, or **Share this line** on a transcript line, which also quotes the line. The native apps have the same options from the player menu, the episode menu and transcript lines.

The link looks like `https://your-server/episode/ID?t=754` and opens the web player at that time. Someone who is signed in but doesn't follow the podcast yet sees what was shared and can follow it and start playing in one tap (private podcasts are only visible to people who already follow them). Someone who isn't signed in is asked to sign in first and then lands on the same moment. The links open in the browser, not in the native apps. If an admin has turned on the [public directory](/guides/admin#public-directory), the link also works for people who are not signed in: they see the episode, and can listen or read the transcript if the server allows it, and are asked to sign in for anything else.

## Notifications for new episodes

The Android and iOS apps can notify you when a podcast you follow publishes a new episode. Turn it on under **Settings → Notifications**, then choose per podcast with the bell in the podcast's menu (on by default; the choice syncs across your devices).

A self-hosted server has no push service, so the app checks for new episodes itself in the background and notifies you about anything released since its last check. The phone decides when background checks run (about hourly on Android, a few times a day on iOS, and less often in battery saver), so a notification can arrive some time after the episode is published. Opening the app marks everything on screen as seen, so you are not notified twice. Tapping a notification opens the episode. The web player does not send notifications.

## Up Next, playlists and smart playlists

- **Up Next** is the built-in queue. Use *Play next* or *Play last* from any episode menu and reorder with the drag handle (or the arrow keys on the handle).
- **Playlists** are ordered lists you can play through.
- **Smart playlists** collect episodes by [rules](/reference/smart-playlists) evaluated on your device, so they work offline. They can auto-download their results.

## Bookmarks

Tap the bookmark button in the player to save a moment with an optional title and note, or use **Bookmark this line** in a transcript. Bookmarks are listed per episode and globally; tap one to jump there. When a transcript is available, the nearby line is shown as a preview.

## Offline

- **Streaming** uses the server's own copy when there is one (see [Episode hosting](/guides/admin#episode-hosting)). The player requests a signed link for the episode, valid for 12 hours, and renews it if it expires during playback. Otherwise it streams from the podcast's own URL. The Android and iOS apps do the same.
- **Downloads** go through the server's authenticated audio proxy into the browser's Cache API. The audio proxy is needed because browsers cannot cache cross-origin audio without CORS headers. If the server keeps its own copy of an episode (see [Episode hosting](/guides/admin#episode-hosting)), the download comes from there.
- Set a **storage cap** and a **Wi-Fi only** switch on the Profile page (device-local settings).
- The service worker caches the app shell, so the player loads offline.

::: callout warning "Browser limits"
iOS Safari may evict stored audio when space is low, and background playback is less reliable than in a native app. The native apps are the primary offline experience.
:::

## Sync status

The sidebar (or Profile page) shows when the last sync happened. *Offline* appears only when a request to the server actually fails; the player keeps trying every few seconds and syncs as soon as the server is reachable.
