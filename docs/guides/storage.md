---
title: "Storage engines"
description: "Choose between LokiJS, SQLite and docstore, switch between them, and see how they compare on a large library."
---

# Storage engines

Homecast has three storage engines behind one small interface (`server/src/db`). The rest of the server does not know which one is running.

| | `loki` (default) | `sqlite` | `docstore` |
|---|---|---|---|
| Where the data lives | In memory, saved to `homecast.db.json` every 5 s while anything changes | On disk in `homecast.db.sqlite`. Only what you use is in memory | In memory, with every change appended to a journal in `homecast.docstore/` |
| What a save costs | Rewrites the whole database, on the main thread | Only what changed | Only what changed; the snapshot is rewritten in the background in small slices |
| Size limit | About 200,000 episodes, then it cannot save | None | None (memory) |
| Memory | Everything | Little | Everything, 10 to 30% more than `loki` |
| Backups | A JSON copy | A consistent SQLite copy taken while the server runs | One file copied from the snapshot and journal |
| Needs | Nothing | Node.js 22.5 or newer (the Docker image has it) | Nothing (it is `docstore/` in this repository, with no dependencies) |
| Switch with | nothing | `DB_ENGINE=sqlite` | `DB_ENGINE=docstore` |

## Which one should I use?

**Stay on the default** while you are happy with it. Up to roughly 100,000 episodes it is fine, and it is the one that has been used the longest.

**Switch to `docstore`** if you want the default's speed without its limits. It keeps the data in memory like the default, so reads are just as fast, and it fixes what hurts at size:

- **Writes are much faster.** About 60,000 changes a second at any size, against 8,000 for the default at 100,000 episodes (the default's write cost grows with the library). A play-position sync takes under a millisecond.
- **No stalls.** The default rewrites the whole database on every save and stops the server while it does: 75 ms at 20,000 episodes and 414 ms at 100,000. `docstore` appends changes and writes its snapshot a megabyte at a time, so the longest stall was 1.5 ms.
- **No size limit.** The default cannot save a database larger than about 512 MB (the biggest string Node allows), which for this library means around 200,000 episodes. `docstore` ran a 500,000-episode library in the benchmark below without trouble.
- **Quicker backups and admin pages**, and crash safety: every record has a checksum, a half-written record is ignored, and snapshots are replaced atomically.

What it costs: starting up is slower than the default (about 0.7 s against 0.45 s at 100,000 episodes, and 3.7 s at 500,000), and it uses a little more memory. It is also the newest engine. It has its own tests, including a randomised comparison against a plain scan and crash-recovery tests, but it has not run in production as long as the others.

**Switch to SQLite** if memory is the problem: it holds almost nothing in RAM (160 MB at 500,000 episodes against 1.7 GB for the in-memory engines) and starts in 2 ms at any size. That is the one to pick for a small NAS with a big library. Its writes are slower (about 8,000 a second) and a new device pulling a big library takes a few times longer.

## Switching

```bash
DB_ENGINE=docstore    # or sqlite
```

The first time the server starts on a new SQLite or docstore database in a data directory that has another engine's database, it imports that database once and logs how many records it copied. **The old database is not changed**, so you can go back. Changes made on the new engine are not copied back by themselves, though.

To copy by hand, in any direction, stop the server and run:

```bash
cd server
npx tsx scripts/migrate-db.ts --data-dir ../data --to docstore
npx tsx scripts/migrate-db.ts --data-dir ../data --from docstore --to loki
```

It refuses to overwrite an existing database. All directions are covered by the test suite.

Things to know about `docstore`:

- **One server per data directory.** A `LOCK` file stops a second process from opening the same directory. A lock left by a crashed process is taken over.
- **A crash can lose the last second of changes** (the journal is written every 20 ms and forced to disk every second), never more, and never leaves the database inconsistent.
- **Restoring a backup** means stopping the server, moving `homecast.docstore/` away, and restoring a file from `backups/` with the `Docstore.restore` function of the `docstore` package (see its README).

Things to know about SQLite:

- **One server per data directory.** Do not run two server processes on the same database.
- **`-wal` and `-shm` files** appear next to `homecast.db.sqlite` while the server runs. Back up the folder with the server stopped, or use the daily snapshots in `backups/`, which are always consistent.
- **Node prints an experimental warning** for `node:sqlite` at start-up. It is harmless.
- **Restoring a backup** means stopping the server and copying a `backups/homecast-….sqlite` file over `homecast.db.sqlite` (and deleting its `-wal` and `-shm` files).

## How they compare

The numbers come from `server/scripts/bench-db.ts`, which fills a database with a realistic library and then measures each engine in a fresh process, going through the real services and HTTP routes (the sync protocol, discover, transcript search and the admin pages), not just the database calls. The figures are medians from one run on a laptop with Node 22. Absolute times depend on your hardware; compare the columns, not the rows.

```bash
cd server
npm run bench:db -- --scale medium                        # small, medium or large
npm run bench:db -- --scale large --engines sqlite,docstore
```

| Scale | Episodes | Play states | Transcripts | Podcasts | Users |
|---|---:|---:|---:|---:|---:|
| small | 20,000 | 5,000 | 100 | 100 | 10 |
| medium | 100,000 | 50,000 | 300 | 250 | 25 |
| large | 500,000 | 300,000 | 600 | 1,000 | 100 |

### Results

| | loki | sqlite | docstore |
|---|---:|---:|---:|
| **Small: 20,000 episodes** | | | |
| Open the database | 84 ms | 2.1 ms | 122 ms |
| Memory after start | 265 MB | 165 MB | 233 MB |
| Idle sync poll | 0.4 ms | 0.3 ms | 0.2 ms |
| Push 25 play positions | 1.3 ms | 2.8 ms | 0.6 ms |
| Admin feeds list | 2.9 ms | 2.4 ms | 1.0 ms |
| Single record writes per second | 60,135 | 10,888 | 62,943 |
| Periodic save, longest stall | 75 ms | 0 ms | 1.5 ms |
| Backup time | 85 ms | 150 ms | 33 ms |
| **Medium: 100,000 episodes** | | | |
| Open the database | 445 ms | 1.8 ms | 678 ms |
| Memory after start | 667 MB | 160 MB | 495 MB |
| Idle sync poll | 0.4 ms | 0.5 ms | 0.5 ms |
| Push 25 play positions | 4.7 ms | 5.8 ms | 0.8 ms |
| A new device pulls a heavy library | 192 ms | 534 ms | 201 ms |
| Transcript search | 75 ms | 87 ms | 78 ms |
| Admin overview | 2.4 ms | 4.8 ms | 0.8 ms |
| Admin feeds list | 8.5 ms | 4.1 ms | 1.4 ms |
| Single record writes per second | 8,658 | 8,145 | 61,456 |
| Periodic save, longest stall | 414 ms | 0 ms | 1.3 ms |
| Backup time | 534 ms | 967 ms | 135 ms |
| Database on disk | 236 MB | 276 MB | 227 MB |
| **Large: 500,000 episodes** | | | |
| Open the database | fails | 1.9 ms | 3.7 s |
| Memory after start | fails | 161 MB | 1,741 MB |
| Idle sync poll | fails | 0.8 ms | 0.3 ms |
| Push 25 play positions | fails | 6.4 ms | 0.7 ms |
| A new device pulls a heavy library | fails | 2.5 s | 0.8 s |
| Transcript search | fails | 208 ms | 201 ms |
| Admin overview | fails | 30 ms | 1.3 ms |
| Single record writes per second | fails | 6,748 | 58,122 |
| Periodic save, longest stall | fails | 0 ms | 1.4 ms |
| Backup time | fails | 3.2 s | 0.5 s |
| Database on disk | fails | 1,332 MB | 1,077 MB |

At the large scale the default engine builds the database but fails when it saves it: the JSON would be over 1 GB, beyond Node's string limit of about 512 MB. (I did not capture the exact error message; it matches Node's "Invalid string length".)

### What the numbers say

- **Day-to-day requests are fast on all three.** An idle sync poll, the most common request, is well under a millisecond everywhere. A household will not notice a difference between the engines on reads.
- **`docstore` is the fastest at writing**, by a wide margin, and the only engine whose write speed does not fall as the library grows.
- **`docstore` and the default are equal on reads** (they are both in memory); SQLite is a few times slower on the requests that read a lot, such as a new device's first sync.
- **SQLite wins on memory and start-up**, `docstore` loses on start-up to the default, and by more as the library grows: it checks every record and builds its indexes while loading.
- **Transcript search is the same on every engine** (200 ms at 600 transcripts). It scans every line of every transcript, which no storage engine speeds up; a full-text index would.

### The standalone benchmark of the library

`docstore/bench/vs-loki.ts` compares the two in-memory stores head to head, without the server, on 1 KB documents (100,000 of them, three indexes):

| | loki | docstore |
|---|---:|---:|
| Insert (per second, one batch) | 82,689 | 128,889 |
| Indexed lookup of about 500 documents (per second) | 49,503 | 226,457 |
| Range lookup, newest 50 (per second) | 440,857 | 350,000 |
| Newest 20 of an indexed group of about 500 (per second) | 30,500 | 37,000 |
| Lookup by a unique field (per second) | 2,394 | 1,346,253 |
| Update a document (per second) | 5,330 | 55,047 |
| Delete and insert (per second) | 4,023 | 85,399 |
| Save, longest stall of the process | 284 ms | 34 ms |
| Open from disk | 384 ms | 393 ms |
| Memory held by the data | 54 MB | 72 MB |

### How the benchmark changed the server

Running it found problems in the sync path that affected every engine, and I fixed them:

- Every sync request read every episode of every podcast you follow and then threw away the unchanged ones. That was cheap in memory but slow on disk, and it grew with the library. The sync service now asks only for records changed since the client's cursor, using a compound index of (owner, revision). An idle sync poll on SQLite dropped from 7.6 ms to 0.3 ms on the small library.
- Sync, the admin overview and the admin feed list made one query per podcast. They now make a handful of queries in total (an "any of these values" query, and one pass over subscriptions for counts).
- The admin overview counts new episodes with an index instead of scanning all of them.
- Episodes are no longer indexed by `guid`, which nothing queries; that saves memory and write time on every engine.

### Running the tests on each engine

```bash
npm test                          # the default engine, plus the docstore package's own tests
npm run test:sqlite -w server
npm run test:docstore -w server
```

CI runs all of them.
