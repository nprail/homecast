---
title: "Smart playlists"
description: "Rule definitions and the shared evaluator."
---

# Smart playlists

Rules are stored as JSON and evaluated **on the device** from local data, so they work offline. The server stores only the definition.

```json
{
  "name": "Fresh news",
  "match": "all",
  "rules": [
    { "field": "podcast", "op": "in", "value": ["pod_1", "pod_7"] },
    { "field": "status", "op": "is", "value": "unplayed" },
    { "field": "releasedWithin", "op": "days", "value": 7 }
  ],
  "sort": { "field": "releasedAt", "dir": "desc" },
  "limit": 50
}
```

| Field | Operators | Value |
|---|---|---|
| `podcast` | `in`, `notIn` | list of podcast ids |
| `status` | `is` | `unplayed`, `inProgress` or `played` |
| `releasedWithin` | `days` | number of days |
| `duration` | `lt`, `gt` | minutes |
| `downloaded` | `is` | true or false |
| `starred` | `is` | true or false |
| `title` | `contains` | case-insensitive text |

- `match` is `all` or `any`. An empty rule list matches every episode.
- Sort fields: `releasedAt`, `duration`, `title`. Ties are broken by episode id so every platform agrees.
- `limit` is applied after sorting. `autoDownload: true` keeps the results downloaded.

## One evaluator, many platforms

The TypeScript evaluator lives in `shared/src/smartPlaylist.ts` and is used by the web app. The native apps implement the same logic and are verified against the language-neutral test vectors in `shared/vectors/smart-playlist.json`: a fixed set of episodes, a fixed "now", and cases with the expected ids in order.
