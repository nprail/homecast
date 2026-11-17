---
title: "Limits"
description: "What docstore does not do."
---

# Limits

- **Everything is in memory.** A million documents of 2 KB take a few gigabytes of heap. If memory is the constraint, use an on-disk database such as SQLite.
- **One process per directory.** A lock file enforces it.
- **Ordered indexes hold numbers, dates and strings.** A document whose value is something else (missing, `null`, a boolean, an object) is left out of that index. Ids are strings.
- **No dynamic views, events, TTL, cloning or rollback,** and no browser support. See [Moving from Loki](/guides/from-loki).
- **No rollback, joins or schema.** `batch` is atomic on disk but does not undo in-memory changes if it throws.
- **Start-up reads everything.** Every record is checksummed and every index is built while loading: about 0.7 s at 100,000 documents of the Homecast shape, 3.7 s at 500,000.
- **It is new.** It has unit tests, a randomised comparison against a plain scan and crash-recovery tests, but far less time in production than LokiJS or SQLite.
