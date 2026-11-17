---
title: "API"
description: "Every exported class, method and error."
---

# API

## Docstore

| Member | |
|---|---|
| `Docstore.open(dir \| null, options?)` | Open or create a store. `null` is memory-only. Resolves once loaded |
| `Docstore.restore(file, dir)` | Turn an export file into a store in an empty directory |
| `db.collection<T>(name, options)` | Register a collection |
| `db.batch(fn)` | Write the changes `fn` makes as one atomic group |
| `await db.flush()` / `db.flushSync()` | Write the journal to disk now |
| `await db.compact()` | Fold the journal into a new snapshot |
| `db.exportSync(file)` | Write the whole store to one file; returns bytes |
| `db.diskBytes()` | Size of the store's files |
| `db.stats()` | `{ collections, journalBytes, snapshotBytes, bufferedBytes }` |
| `await db.close()` | Flush, wait for background work and release the lock |

## Collection<T>

| Member | |
|---|---|
| `insert(doc)` | Add a document (gets an `id` if missing); returns the same object |
| `update(doc)` | Store the current state of a document already in the collection |
| `remove(docOrId)` | Delete one document |
| `get(id)`, `has(id)`, `by(field, value)` | Look up by id, or by a unique or indexed field |
| `find(query?, { sort?, offset?, limit? })` | Matching documents; no query returns everything |
| `findOne(query, { sort? })` | The first match, or `null` |
| `where(fn)` | Any function (scans) |
| `count(query?)` | Count, from an index where possible |
| `chain()` | A [result set](/guides/queries) |
| `findAndUpdate(query, fnOrObject)` | Change every match; returns how many |
| `findAndRemove(query)`, `removeWhere(queryOrFn)` | Delete every match; returns how many |
| `updateWhere(filterFn, changeFn)` | Change every document a function accepts |
| `max(field)`, `min(field)` | Largest and smallest number; free on an ordered field |
| `avg`, `median`, `stdDev`, `mode`, `extract`, `extractNumerical` | Aggregates over a field |
| `values()`, `size` | Iterate all documents, count them |

## Resultset<T>

From `collection.chain()`: `find`, `where`, `sort`, `simplesort`, `compoundsort`, `limit`, `offset`, `copy`, `data`, `count`, `first`, `update`, `remove`, `map`, `mapReduce`, `eqJoin`, `extract`, `extractNumerical`, `avg`, `min`, `max`, `median`, `stdDev`, `mode`. See [Queries and indexes](/guides/queries).

## Errors

All extend `DocstoreError`, which has a `code`.

| Error | `code` | When |
|---|---|---|
| `UniqueViolation` | `unique` | Two documents would share an id or a unique value |
| `CorruptionError` | `corrupt` | A checksum fails somewhere other than the end of the journal |
| `LockedError` | `locked` | Another live process has the directory open |
| `NotFoundError` | `not_found` | An update or removal names a document that is not there |
