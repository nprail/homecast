---
title: "Moving from Loki"
description: "The differences that matter when porting code from LokiJS."
---

# Moving from Loki

docstore covers Loki's query language and result sets. What it leaves out is listed at the end.

| LokiJS | docstore |
|---|---|
| `addCollection(name, { unique, indices })` | `collection(name, { unique, indexed, ordered })`. Ranges and sorting use `ordered`. Dotted paths work in all three |
| `insert`, `update(doc)`, `remove(doc)` | same names. `update` takes the document you changed |
| `find({ a: { $gt: 1 } })` and every operator Loki has (`$regex`, `$contains`, `$between`, `$type`, `$size`, `$dteq`, `$jgt`, ...), `$and`, `$or` | same names. Also `$nor`, `$not`, `$where` |
| `by('id', value)`, `findOne` | `by(field, value)`, `findOne(query)`, `get(id)` |
| `chain().find().simplesort().limit().data()` | same, plus `find(query, { sort, offset, limit })` |
| `compoundsort`, `offset`, `limit`, `copy`, `update`, `remove`, `eqJoin`, `map`, `mapReduce` | same |
| `avg`, `min`, `max`, `median`, `stdDev`, `mode`, `extract`, `extractNumerical` | same, on the collection and on a result set |
| `findAndUpdate`, `findAndRemove`, `updateWhere`, `removeWhere` | same |
| `$loki`, `meta` on every document | not added. `id` is a string, generated on insert |
| `saveDatabase` and autosave of the whole file | a journal, nothing to call. `flush()` forces it to disk |
| clones documents unless `clone: false` | never clones |

## Differences to watch for

- **Result sets are eager.** Each step produces its list at once. `find(q, { sort, limit })` is the lazy path.
- **`map` returns an array**, not another result set.
- **Ranges on strings** compare by code unit (`'Z' < 'a'`), with no locale.
- **`$regex` matches strings only.** Loki's matches anything `RegExp.test` can coerce.
- **Ties in a sort come out in no promised order.** Sort by a second field when it matters.
- **Dates** compare as timestamps. They become ISO strings after a reload, so use timestamps in indexed date fields.

## What docstore does not have

- **Dynamic views** (a live, incrementally maintained filtered and sorted result).
- **Events** on insert, update and delete, and the change log.
- **TTL** (documents that expire).
- **Cloning on read**, and `startTransaction` / `rollback`.
- **Browsers and storage adapters.** docstore is Node-only and has one storage format.

## Reading old data

docstore does not read Loki files. To move data, read the Loki database and `insert` the documents. Homecast does exactly that on first start with `DB_ENGINE=docstore`, and `server/scripts/migrate-db.ts` does it by hand.
