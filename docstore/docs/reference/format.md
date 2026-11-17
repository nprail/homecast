---
title: "File format"
description: "How a store is laid out on disk."
---

# File format

A store is one directory:

```
MANIFEST.json       which snapshot and journals are current, and the collection names
snap-000007.jsonl   the latest snapshot
wal-000007.log      the journal being written (older ones are removed once folded in)
LOCK                the owner's process id
```

Every snapshot and journal is one record per line: an 8-digit hex CRC-32, a space, then the record.

| Record | Meaning |
|---|---|
| `P <collection> <json>` | store a document |
| `D <collection> <json id>` | delete a document |
| `B` / `E` | begin and end an atomic group |
| `H <json>` | file header |

A snapshot is just a long list of `P` records. Replaying a record over a snapshot that already contains it changes nothing, so a snapshot may be taken while documents keep changing: it starts by switching to a new journal, copies the documents as they are, and anything changed meanwhile is in the new journal.

`MANIFEST.json` is replaced atomically (write a temporary file, rename), so a crash leaves either the old or the new set of files, never half of each.

Because the files are plain lines of JSON, they can be inspected with ordinary tools. Do not edit them: the checksums will refuse the change.
