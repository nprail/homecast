---
title: "Storage engines"
description: "Choose between the in-memory LokiJS database and SQLite, switch between them, and see how they compare on a large library."
---

# Storage engines

Homecast has two storage engines behind one small interface (`server/src/db`). The rest of the server does not know which one is running.

| | `loki` (default) | `sqlite` |
|---|---|---|
| Where the data lives | In memory, saved to `homecast.db.json` every 5 s while anything changes | On disk in `homecast.db.sqlite`, with an index per queried field. Only what you use is in memory |
| Backups | A JSON copy | A consistent SQLite copy taken while the server runs (`VACUUM INTO`) |
| Needs | Nothing | Node.js 22.5 or newer (the built-in `node:sqlite`; the Docker image has it) |
| Switch with | nothing | `DB_ENGINE=sqlite` |

## Which one should I use?

**Stay on the default** for a household or small team library (up to roughly 100,000 episodes). It is the fastest at that size, it has been the only engine until now, and its few downsides only matter when the library is big.

**Switch to SQLite** if any of these apply:

- **A big library.** The default engine writes the whole database as one JSON string, and Node cannot hold a string larger than about 512 MB. With the data in the benchmark below, I estimate that limit is reached at around 200,000 episodes (the database file is about the size of that string), after which the default engine can no longer save at all. SQLite has no such limit.
- **A small server.** The default engine keeps everything in memory, so a 100,000-episode library needs about 670 MB of RAM at start-up against about 160 MB for SQLite.
- **You notice pauses.** Every save of the default engine rewrites the whole database on the main thread and stalls every request meanwhile: about 70 ms at 20,000 episodes and 400 ms at 100,000, growing with the library. SQLite writes only what changed.
- **Slow starts.** Opening the default database parses the whole file (about 0.4 s at 100,000 episodes). SQLite opens in about 2 ms at any size.

## Switching

```bash
DB_ENGINE=sqlite
```

The first time the server starts on SQLite in a data directory that has a `homecast.db.json` and no SQLite file, it imports the JSON database once and logs how many records it copied. **The JSON file is not changed**, so you can go back. Changes made on SQLite are not copied back by themselves, though.

To go back to the default engine, or to do the copy ahead of time, stop the server and run:

```bash
cd server
npx tsx scripts/migrate-db.ts --data-dir ../data --to loki     # or --to sqlite
```

It refuses to overwrite an existing destination database. Both directions are covered by the test suite.

Things to know about SQLite:

- **One server per data directory.** Do not run two server processes on the same database.
- **`-wal` and `-shm` files** appear next to `homecast.db.sqlite` while the server runs. Back up the folder with the server stopped, or use the daily snapshots in `backups/`, which are always consistent.
- **Node prints an experimental warning** for `node:sqlite` at start-up. It is harmless.
- **Restoring a backup** means stopping the server and copying a `backups/homecast-….sqlite` file over `homecast.db.sqlite` (and deleting its `-wal` and `-shm` files).

## How they compare

The numbers come from `server/scripts/bench-db.ts`, which fills a database with a realistic library and then measures each engine in a fresh process, going through the real services and HTTP routes (the sync protocol, discover, transcript search and the admin pages), not just the database calls. The figures below are medians from one run on a laptop with Node 22. Absolute times depend on your hardware; compare the columns, not the rows.

```bash
cd server
npm run bench:db -- --scale medium                        # small, medium or large
npm run bench:db -- --scale large --engines sqlite
```

| Scale | Episodes | Play states | Transcripts | Podcasts | Users |
|---|---:|---:|---:|---:|---:|
| small | 20,000 | 5,000 | 100 | 100 | 10 |
| medium | 100,000 | 50,000 | 300 | 250 | 25 |
| large | 500,000 | 300,000 | 600 | 1,000 | 100 |

### Results

| | loki | sqlite |
|---|---:|---:|
| **Small: 20,000 episodes** | | |
| Open the database | 77 ms | 1.7 ms |
| Memory after start | 266 MB | 161 MB |
| Idle sync poll | 0.2 ms | 0.3 ms |
| Push 25 play positions | 1.2 ms | 2.1 ms |
| A new device pulls a heavy library | 44 ms | 80 ms |
| Transcript search | 16 ms | 18 ms |
| Admin overview | 0.7 ms | 1.1 ms |
| Single record writes per second | 72,597 | 11,829 |
| Periodic save, longest stall | 73 ms | 0 ms |
| Backup time | 86 ms | 118 ms |
| **Medium: 100,000 episodes** | | |
| Open the database | 420 ms | 1.9 ms |
| Memory after start | 665 MB | 159 MB |
| Idle sync poll | 0.3 ms | 0.3 ms |
| Push 25 play positions | 4.3 ms | 4.9 ms |
| A new device pulls a heavy library | 141 ms | 418 ms |
| Transcript search | 73 ms | 79 ms |
| Admin overview | 2.2 ms | 3.4 ms |
| Single record writes per second | 8,906 | 10,222 |
| Periodic save, longest stall | 396 ms | 0 ms |
| Backup time | 466 ms | 596 ms |
| Database on disk | 237 MB | 281 MB |
| **Large: 500,000 episodes** | | |
| Open the database | fails | 1.9 ms |
| Memory after start | fails | 162 MB |
| Idle sync poll | fails | 0.3 ms |
| Push 25 play positions | fails | 4.7 ms |
| A new device pulls a heavy library | fails | 1.9 s |
| Transcript search | fails | 195 ms |
| Admin overview | fails | 16 ms |
| Single record writes per second | fails | 9,902 |
| Periodic save, longest stall | fails | 0 ms |
| Backup time | fails | 2.7 s |
| Database on disk | fails | 1,357 MB |

At the large scale the default engine builds the database but fails when it saves it: the JSON would be over 1 GB, beyond Node's string limit of about 512 MB. (I did not capture the exact error message; it matches Node's "Invalid string length".)

### What the numbers say

- **SQLite wins on everything that grows with the library**: start-up, memory, the save stall (none, against hundreds of milliseconds), and, once the database is large, the steady-state cost of writes. It also keeps working at sizes where the default engine cannot save at all.
- **The default engine wins on raw read speed.** Everything is already in memory, so a full sync pull is about three times faster than SQLite at 100,000 episodes, and on a small database its writes are much faster (73,000 a second against 12,000). At 100,000 episodes its write rate falls to about 9,000 a second, because it maintains sorted indexes in memory.
- **Day-to-day requests are fast on both.** An idle sync poll, the most common request, takes about 0.3 ms on both engines at every size, and a play position update takes a few milliseconds. A household will not notice the difference.
- **SQLite is slower for a new device's first sync and for transcript search**, which read many records. They scale with the amount of data read: 1.9 s for a new device to pull a user's 60 podcasts (30,000 episodes) out of a 500,000-episode library, and 195 ms to search 600 transcripts.
- **SQLite uses a little more disk** (about 20% more) and its backups take longer on a very large library, because it copies a whole database file where the default engine already has the data in memory.

### How the benchmark changed the server

Running it found problems in the sync path that affected both engines, and I fixed them:

- Every sync request read every episode of every podcast you follow and then threw away the unchanged ones. That was cheap in memory but slow on disk, and it grew with the library. The sync service now asks only for records changed since the client's cursor, using a compound index of (owner, revision). An idle sync poll on SQLite dropped from 7.6 ms to 0.3 ms on the small library.
- Sync, the admin overview and the admin feed list made one query per podcast. They now make a handful of queries in total (a new "any of these values" query, and one pass over subscriptions for counts). The default engine answers the new query as one indexed lookup per value, so it did not get slower.
- The admin overview counts new episodes with an index instead of scanning all of them.

### Running the tests on each engine

```bash
npm test                          # the default engine
npm run test:sqlite -w server
```

CI runs both.
