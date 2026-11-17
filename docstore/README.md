# docstore

A small in-memory document store with indexes and a crash-safe journal. Pure JavaScript, no dependencies, Node.js 22.2 or newer.

It is written to replace [LokiJS](https://github.com/techfort/LokiJS) in Homecast, and keeps the part of Loki that is worth keeping: documents are plain objects that live in your process, queries are synchronous, and reads cost nothing because you get the object itself back. It fixes the parts that hurt at size:

| Loki | docstore |
|---|---|
| Every save serialises the whole database into one string on the main thread. Saves stall the process for as long as that takes (hundreds of milliseconds at 100,000 documents) | Every change is appended to a journal. The snapshot is rewritten in the background, a megabyte at a time, with the event loop free in between. The longest stall is a few milliseconds |
| A database larger than about 512 MB cannot be saved at all (it exceeds the largest string V8 allows), and cannot be loaded either | Files are read and written in chunks, so there is no size limit short of memory and disk |
| A crash mid-save can leave a corrupt file | Every record has a checksum. A half-written last record is ignored, damage anywhere else is reported, and snapshots are replaced atomically |
| Indexes are sorted arrays that are spliced on every insert, so inserts get slower the bigger the collection is | Hash indexes for equality, and a blocked sorted list for ranges: inserts and deletes cost the same at 10 documents and at 10 million |
| `$in` and range queries scan unless the field has a binary index | Equality, `$in` and range queries use an index when one exists, and the planner starts from the most selective condition |
| Per-document `$loki` and `meta` fields | No fields are added to your documents |
| Opening reads the whole file into one string, then parses it | Opening streams the files and builds the sorted indexes in one pass |

What it does not change: everything is in memory, and only one process can use a store at a time.

## Use

```ts
import { Docstore } from '@homecast/docstore';

const db = await Docstore.open('./data/mydb');      // or Docstore.open(null) for memory only

interface User { id: string; name: string; role: string; createdAt: number }

const users = db.collection<User>('users', {
  unique: ['name'],            // enforced; also indexed
  indexed: ['role'],           // equality and $in
  ordered: ['createdAt'],      // equality, ranges and sorting (numbers, dates, strings)
});

const maya = users.insert({ name: 'Maya', role: 'admin', createdAt: Date.now() }); // gets an id
maya.role = 'user';
users.update(maya);                                   // store the change (and keep the indexes right)

users.get(maya.id);                                   // the same object, no copy
users.find({ role: 'user', createdAt: { $gt: 0 } });
users.findOne({ name: 'Maya' });
users.count({ role: 'user' });                        // answered from the index
users.where((u) => u.name.startsWith('M'));           // any function (scans)
users.remove(maya);

db.batch(() => { /* many changes, written as one group */ });
await db.flush();                                     // journal on disk
await db.close();
```

Documents are held by reference. **Change a document, then call `update`.** Changing one without calling `update` changes it in memory but not on disk, and leaves the indexes as they were.

### Queries

A query is an object of conditions that must all hold, with the operators LokiJS has and a few more:

```ts
users.find({ name: /^m/i, 'address.city': { $in: ['Lyon', 'Oslo'] } });          // dotted paths, regexes
users.find({ $or: [{ role: 'admin' }, { age: { $lt: 18 } }] });                   // $and $or $nor $not $where
users.find({ role: 'user' }, { sort: { createdAt: -1 }, offset: 20, limit: 10 }); // sorting and paging
users.chain().find({ active: true }).simplesort('age').limit(5).data();           // result sets
users.avg('age'); users.findAndUpdate({ active: false }, { archived: true });     // aggregates, bulk changes
```

The planner uses an index for whichever condition selects the fewest documents (an `$or` uses one per branch) and checks the rest on those documents. Fields without an index still work, by scanning. A field listed under `ordered` is indexed for ranges and sorting (numbers, dates and strings), so "the newest 20" is read straight off the index.

Equality, `$ne`, `$in`, `$nin`, `$gt`/`$gte`/`$lt`/`$lte`/`$between`, `$regex`, `$contains`, `$containsAny`, `$containsNone`, `$containsString`, `$type`, `$exists`, `$finite`, `$size`, `$len`, `$aeq`, `$dteq`, `$keyin`, `$definedin`, `$jgt` and friends, and `$not` on a field are all there. See the documentation site for the full list.

### Durability

By default a change reaches the journal within 20 ms and the disk within a second, so a crash can lose the last second of changes and never leaves the store inconsistent. Options for `Docstore.open(dir, options)`:

- `durability: 'strict'`: every change (or batch) is on disk before the call returns.
- `fsyncIntervalMs`, `flushIntervalMs`: the two intervals above.
- `compactAtBytes` (32 MiB), `autoCompact`: when the journal is folded into a new snapshot. `await db.compact()` does it now.
- `lock` (true): refuse to open a directory another live process has open.

`db.batch(fn)` writes everything `fn` changes as one group that a crash applies completely or not at all (groups over 8 MB are split). It does not roll back: if `fn` throws, the changes made so far stay.

### Backups

`db.exportSync(file)` writes the whole store to one file by copying the snapshot and journals (no re-serialising, so it is quick). `Docstore.restore(file, dir)` turns that file back into a store in an empty directory.

## How it stores data

One directory:

```
MANIFEST.json       which snapshot and journals are current, and the collection names
snap-000007.jsonl   the latest snapshot
wal-000007.log      the journal being written (older ones are removed once folded in)
LOCK                the owner's process id
```

Every file is one record per line: an 8-digit CRC-32, a space, then `P <collection> <json>` (store a document), `D <collection> <json id>` (delete), or `B` / `E` around a batch. A snapshot is just a long list of `P` records, and replaying a record over a snapshot that already contains it changes nothing. That is what makes the background snapshot safe: it starts by switching to a new journal, copies the documents as they are while they keep changing, and any change made meanwhile is in the new journal.

## Limits

- Everything is in memory. A million documents of 2 KB take a few gigabytes of heap.
- One process per directory (a lock file enforces it).
- Ordered indexes hold numbers, dates and strings; ids are strings.
- No transactions with rollback, no dynamic views, no events, no schema.

## Develop

```bash
npm test -w docstore            # unit tests, including a randomised comparison against a plain scan
npm run bench -w docstore       # against Loki, in this repository
```

The package has no runtime dependencies. To use it elsewhere, copy the `src` directory (it is plain TypeScript with no build step beyond your own) and the `LICENSE`.
