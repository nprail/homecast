---
title: "Getting started"
description: "Open a store, define collections and run queries."
---

# Getting started

docstore lives in the Homecast repository as the workspace package `@homecast/docstore`, with no runtime dependencies. To use it elsewhere, copy its `src` directory (plain TypeScript, no build step beyond your own).

```ts
import { Docstore } from '@homecast/docstore';

const db = await Docstore.open('./data/mydb');      // or Docstore.open(null) for memory only

interface User { id: string; name: string; role: string; createdAt: number }

const users = db.collection<User>('users', {
  unique: ['name'],            // enforced; also indexed
  indexed: ['role'],           // equality and $in
  ordered: ['createdAt'],      // equality and ranges (numbers only)
});

const maya = users.insert({ name: 'Maya', role: 'admin', createdAt: Date.now() }); // gets an id
maya.role = 'user';
users.update(maya);                                   // store the change (and keep the indexes right)

users.get(maya.id);                                   // the same object, no copy
users.find({ role: 'user', createdAt: { $gt: 0 } });
users.findOne({ name: 'Maya' });
users.count({ role: 'user' });
users.remove(maya);

await db.close();
```

## Documents are held by reference

`get` and `find` return the objects the store holds, not copies. That is why reads are free. The rule that follows:

> **Change a document, then call `update`.**

Changing a document without calling `update` changes it in memory but not on disk, and leaves the indexes as they were.

## Collections

`db.collection(name, options)` registers a collection and loads its documents. Call it once per collection, right after `open`. Options:

| Option | Effect |
|---|---|
| `unique` | Values must be unique across the collection (a missing or `null` value is allowed any number of times). Also indexed. Violations throw `UniqueViolation` |
| `indexed` | Hash index for equality and `$in` |
| `ordered` | Sorted index for numbers: equality and ranges |

Every document has a string `id`, generated on insert if you do not give one. `id` is always indexed.

## Memory-only stores

`Docstore.open(null)` gives a store with the same API and no files. It is what the Homecast tests use.
