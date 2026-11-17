---
title: "Durability and backups"
description: "What a crash can lose, batches, compaction, export and restore."
---

# Durability and backups

By default a change reaches the journal within 20 ms and the disk within a second. A crash can lose the last second of changes and never leaves the store inconsistent.

## Options

`Docstore.open(dir, options)`:

| Option | Default | Meaning |
|---|---|---|
| `durability` | `'relaxed'` | `'strict'`: every change (or batch) is on disk before the call returns |
| `flushIntervalMs` | 20 | how often buffered changes are written to the journal |
| `fsyncIntervalMs` | 1000 | how often the journal is forced to disk (0 = never on a timer) |
| `compactAtBytes` | 32 MiB | the journal size that triggers folding it into a new snapshot |
| `autoCompact` | true | turn off to call `compact()` yourself |
| `lock` | true | refuse to open a directory another live process has open |
| `onError` | | called when a background flush or compaction fails |

## Batches

```ts
db.batch(() => {
  // many changes
});
```

Everything `fn` changes is written as one group that a crash applies completely or not at all (groups over 8 MB are split). It does **not** roll back: if `fn` throws, the changes made so far stay.

## Compaction

The journal grows until it is folded into a snapshot, automatically once it passes `compactAtBytes`, or with `await db.compact()`. The snapshot is written in the background in 1 MB slices, so the event loop stays free. Changes made meanwhile go to a new journal, and replaying a record over a snapshot that already holds it changes nothing, which is what makes this safe.

## Backups

```ts
db.exportSync('./backup.docstore');           // one file; copies the snapshot and journals, no re-serialising
Docstore.restore('./backup.docstore', dir);   // into an empty directory
```

`exportSync` also works on memory-only stores.

## Recovery

On open the store reads the snapshot and journals in order, checking every record's checksum:

- A damaged or half-written **last** record (or an unfinished batch at the end) is ignored and the file is truncated back to the last good point.
- Damage **anywhere else** throws `CorruptionError` rather than guessing.
- A `LOCK` left by a crashed process is taken over; one held by a live process throws `LockedError`.
