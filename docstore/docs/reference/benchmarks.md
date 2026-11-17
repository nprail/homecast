---
title: "Benchmarks"
description: "docstore against LokiJS on the same workload."
---

# Benchmarks

`bench/vs-loki.ts` runs both stores on the same workload, each in its own process, with 1 KB documents and three indexes (100,000 documents here). Medians from one run on a laptop with Node 22: compare the columns, not the absolute numbers.

```bash
npm run bench -w docstore                    # 100,000 and 500,000 documents
npx tsx bench/vs-loki.ts --sizes 200000
```

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

## Reading the numbers

- **Writes** are the big change. Loki updates cost more as the collection grows; docstore appends one line.
- **Stalls** are measured with a 1 ms heartbeat timer: the longest gap is the longest the process was unresponsive.
- **Ranges** are at parity: Loki's binary index is fine for reads, the cost is on writes.
- **Memory** is higher, by 10 to 30%, because of the indexes and a small per-document record of what is indexed.
- **Opening** is about equal here, but with checksums and index building it is slower than Loki in the server benchmark: 0.7 s against 0.45 s at 100,000 episodes, and 3.7 s at 500,000, where Loki cannot save at all.

The server-level comparison of Loki, SQLite and docstore (HTTP routes, sync, admin pages) is in the Homecast storage guide.
