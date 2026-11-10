---
title: "Sync protocol"
description: "Delta sync between clients and the server, for client authors."
---

# Sync protocol

A single endpoint, `POST /api/v1/sync`, pushes your local changes and pulls everything newer than your cursor.

## Request

```json
{
  "cursor": 4182,
  "deviceId": "6f1c…",
  "changes": {
    "episodeStates": [
      { "id": "…", "episodeId": "…", "status": "inProgress", "positionMs": 91000, "starred": false, "clientUpdatedAt": 1731200000000 }
    ],
    "bookmarks": [],
    "playlists": [],
    "smartPlaylists": [],
    "settings": [],
    "subscriptions": []
  }
}
```

## Response

```json
{
  "cursor": 4230,
  "hasMore": false,
  "fullResync": false,
  "rejected": [],
  "changes": { "podcasts": [], "episodes": [], "episodeStates": [], "bookmarks": [], "playlists": [], "smartPlaylists": [], "settings": [], "subscriptions": [] }
}
```

Persist the returned `cursor` and send it next time. While `hasMore` is true, call again immediately. Retry failures with exponential backoff.

## When to sync

On app open, when connectivity returns, shortly after local writes (debounced), and periodically. While playing, push position on pause, on episode change and every 30 seconds while online.

## Conflict resolution

Per record, **last write wins** by `clientUpdatedAt` (the server clamps future timestamps), with these exceptions:

- `episodeStates.positionMs` takes the most recent **play event** (send `positionUpdatedAt`).
- `played` beats an older progress update, but a newer explicit `unplayed` wins.
- Playlists are replaced whole.

Deletes are **tombstones** (`deleted: true`), purged by the server after 90 days.

## Details that matter

- **Identifiers.** One row per user and episode, and per user and podcast. The web app derives deterministic ids so devices agree. If you send a record whose natural key already exists under a different `id`, the server keeps its own row; adopt the id it returns.
- **Shared records.** `podcasts` and `episodes` arrive only for feeds you subscribe to. A new subscription **backfills the whole feed**, delivered in one page.
- **Paging** is by whole revision groups so the numeric cursor never splits records that share a revision.
- **`fullResync: true`** means your cursor predates the tombstone horizon: discard your local synced data and pull again from cursor `0`.
- **`rejected`** lists records the server refused (wrong owner, unknown episode or podcast, private feed). Stop re-sending them.
- **Private feeds** can only be subscribed to with `POST /podcasts` and the feed URL, never by id.

## Settings

The single `settings` record holds `defaultSpeed`, `podcastSpeeds` (a map from podcast id to speed) and `prefs` for anything else. Speed resolves as **podcast override, then global default**.

## Up Next

Up Next is a special `playlists` record with the reserved name `__upnext__` and a deterministic id per user. Hide it from playlist lists.
