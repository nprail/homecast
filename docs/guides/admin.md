---
title: "Admin dashboard"
description: "Run the server: users, invites, feeds, jobs, usage and settings."
---

# Admin dashboard

Admins reach the dashboard at `/admin` (or **Admin** in the player's sidebar and Profile page). Every `/api/v1/admin/*` route enforces the `admin` role on the server; hiding the UI is not the security boundary.

| Page | What it does |
|---|---|
| **Overview** | users, podcasts, episodes, database size, disk free, last backup, uptime, version; feed health; recent activity; *Back up now* |
| **Users & invites** | create invites, reset links, revoke sessions, promote or demote, disable or enable, delete a user and their data |
| **Feeds** | last fetch status and errors, refresh now, hide from Discover, remove orphans |
| **Jobs** | transcript queue with progress, cancel and retry |
| **Usage** | traffic per day (30 days, 90 days, 1 year), per-user totals, CSV export |
| **Audit log** | sign-ins, failed sign-ins and admin actions, kept for one year |
| **Settings** | sign-ups, poll interval, Whisper model, auto-transcribe, episode hosting, backups |

## Users and invites

- Registration is **invite-only**. An invite is a single-use code that expires (1 to 60 days). The full code is shown **once** when you create it.
- A **password reset link** is one-time and works for 24 hours. Setting a new password signs that user out everywhere. You cannot see the link again after closing the dialog.
- **The last remaining admin cannot be demoted, disabled or deleted.**
- Deleting a user removes their subscriptions, playback state, bookmarks, playlists, settings and usage history. Shared feeds and transcripts stay.

## Feeds

Feeds with no subscribers are not polled. **Remove orphans** deletes them and their episodes. Private and tokenized feed URLs are redacted in this list, and private feeds are never listed in Discover.

## Public directory

Off by default. Turn it on under **Settings → Public directory** to let anyone, signed in or not, browse the podcasts people on this server follow and open shared episode links. The pages are view-only: following, queueing, downloading, bookmarking and every other action asks the visitor to sign in, and brings them back to the same page afterwards.

| Setting | Default | What it does |
|---|---|---|
| Show a public directory | off | Serves the public Discover page, podcast pages and episode pages (title, art, show notes with links and timestamps, chapters). While it is off, every public address answers 404 and shared links ask for a sign-in as before. |
| Allow public listening | off | Adds a player to the public episode page. Audio streams straight from the podcast's own server. Copies hosted by [Episode hosting](#episode-hosting) are never served publicly. |
| Allow public viewing of transcripts | off | Visitors can read the transcript of an episode that has one. Nothing is transcribed for visitors, and they cannot request one. |
| Show subscriber counts | off | Shows how many people follow each podcast and allows sorting by it. Never shows who. |

The directory lists the same podcasts as signed-in Discover (followed by at least one person, not private, not hidden). **Private feeds are never served.** A podcast you hide from Discover is left out of the list, but a link to one of its episodes still opens, the same as it does for signed-in users. The public pages are part of the web player; the iOS and Android apps need an account on the server and have no signed-out view.

## Episode hosting

Off by default. When you turn on **Keep copies of episodes on this server** (**Settings → Episode hosting**), the server downloads every episode of the podcasts people subscribe to and keeps the audio on its own disk:

- **One at a time, newest first.** Copies are made in the background, one download at a time, so the server's bandwidth isn't swamped.
- **Served from the server.** Playing or downloading an episode, in the web player and in the Android and iOS apps, uses the server's copy, so the podcast's own host isn't hit again. Transcripts use the copy too: if an episode is transcribed before it has been copied, the transcription joins the hosting download, so the audio is fetched once. If an episode can't be hosted (over the storage cap, or its podcast has no subscribers), transcription downloads a temporary copy instead.
- **Storage cap.** Optionally set a cap in GB. Copying also stops while less than 5 GB is free on the data disk, and the page says why it paused.
- **Failures are retried** with increasing delays (15 minutes, doubling, up to a day). An episode larger than 4 GB is never copied.
- **Copies follow the feed.** If a feed changes an episode's audio URL, the old copy is replaced. Copies of podcasts nobody follows are removed.
- **Turning it off keeps the copies.** To free the space, turn hosting off and then choose **Delete hosted copies**. Copies are downloaded again if you turn hosting back on.

::: callout warning "Plan the disk space first"
Copies can be large: a feed of a few hundred episodes can take tens of gigabytes. Check the storage figures on the settings page before you turn it on, and set a cap if the disk is shared.
:::

Copies are kept in `DATA_DIR/media`. The daily database backup does not include them. After a restore, copies are fetched again when hosting is on.

## Usage

Usage is **tracking only**: there are no quotas. Daily rows record, per user, the bytes through the audio proxy, bytes fetched for feeds (split between a feed's subscribers), bytes downloaded for transcription and transcript minutes processed. Rows are kept for one year and pruned nightly.

## Backups and maintenance

- A snapshot of the database is written daily at 03:00 server time (and caught up after downtime); the newest 14 are kept in `DATA_DIR/backups`.
- Nightly housekeeping purges tombstones older than 90 days, prunes old usage and audit rows, and clears dead sessions.
