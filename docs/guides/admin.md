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
| **Settings** | sign-ups, poll interval, Whisper model, auto-transcribe, backups |

## Users and invites

- Registration is **invite-only**. An invite is a single-use code that expires (1 to 60 days). The full code is shown **once** when you create it.
- A **password reset link** is one-time and works for 24 hours. Setting a new password signs that user out everywhere. You cannot see the link again after closing the dialog.
- **The last remaining admin cannot be demoted, disabled or deleted.**
- Deleting a user removes their subscriptions, playback state, bookmarks, playlists, settings and usage history. Shared feeds and transcripts stay.

## Feeds

Feeds with no subscribers are not polled. **Remove orphans** deletes them and their episodes. Private and tokenized feed URLs are redacted in this list, and private feeds are never listed in Discover.

## Usage

Usage is **tracking only**: there are no quotas. Daily rows record, per user, the bytes through the audio proxy, bytes fetched for feeds (split between a feed's subscribers), bytes downloaded for transcription and transcript minutes processed. Rows are kept for one year and pruned nightly.

## Backups and maintenance

- A snapshot of the database is written daily at 03:00 server time (and caught up after downtime); the newest 14 are kept in `DATA_DIR/backups`.
- Nightly housekeeping purges tombstones older than 90 days, prunes old usage and audit rows, and clears dead sessions.
