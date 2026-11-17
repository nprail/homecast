---
title: "docstore"
description: "A small in-memory document store with indexes and a crash-safe journal. Pure JavaScript, no dependencies."
---

# docstore

A small in-memory document store with indexes and a crash-safe journal. Pure JavaScript, no dependencies, Node.js 22.2 or newer.

It was written to replace [LokiJS](https://github.com/techfort/LokiJS) in Homecast. It keeps what is worth keeping from Loki: documents are plain objects that live in your process, queries are synchronous, and reads cost nothing because you get the object itself back. It fixes the parts that hurt at size.

| Loki | docstore |
|---|---|
| Every save serialises the whole database into one string on the main thread, stalling the process (hundreds of milliseconds at 100,000 documents) | Every change is appended to a journal. The snapshot is rewritten in the background, a megabyte at a time. The longest stall is a few milliseconds |
| A database over about 512 MB cannot be saved or loaded (the largest string V8 allows) | Files are read and written in chunks: no size limit short of memory and disk |
| A crash mid-save can leave a corrupt file | Every record has a checksum, a half-written last record is ignored, and snapshots are replaced atomically |
| Indexes are sorted arrays spliced on every insert, so inserts slow down as collections grow | Hash indexes for equality and a blocked sorted list for ranges: the same cost at 10 documents and at 10 million |
| `$in` and range queries scan unless the field has a binary index | Equality, `$in` and range queries use an index, starting from the most selective condition |
| `$loki` and `meta` fields added to every document | Your documents are left alone |

What it does not change: everything is in memory, and one process at a time can use a store.

## Where to go next

- [Getting started](/guides/getting-started): install, open a store, insert, query.
- [Queries and indexes](/guides/queries): every operator, sorting, result sets and aggregates, and which indexes answer what.
- [Durability and backups](/guides/durability): what a crash can lose, batches, compaction, export and restore.
- [Moving from Loki](/guides/from-loki): the differences that matter when porting code.
- [Benchmarks](/reference/benchmarks): head to head against Loki.
