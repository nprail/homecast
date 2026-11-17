import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync,
  fsync as fsyncAsync,
} from 'node:fs';
import path from 'node:path';
import { Collection, type CollectionOptions, type Sink } from './collection.js';
import { CorruptionError, DocstoreError, LockedError } from './errors.js';
import { encode, readLog } from './log.js';

export interface OpenOptions {
  /** How often buffered changes are written to the journal (ms). Default 20. */
  flushIntervalMs?: number;
  /** How often the journal is forced to disk (ms, 0 = never on a timer). Default 1000. */
  fsyncIntervalMs?: number;
  /**
   * `relaxed` (default): changes reach the journal within `flushIntervalMs` and the disk within `fsyncIntervalMs`, so a
   * crash can lose the last second. `strict`: every change (or batch) is on disk before the call returns.
   */
  durability?: 'relaxed' | 'strict';
  /** Rewrite the snapshot once the journal is larger than this and larger than the snapshot. Default 32 MiB. */
  compactAtBytes?: number;
  /** Turn off automatic compaction (call `compact()` yourself). */
  autoCompact?: boolean;
  /** Refuse to open a directory another live process has open. Default true. */
  lock?: boolean;
  /** Called when a background flush or compaction fails. */
  onError?: (e: unknown) => void;
}

interface Manifest {
  v: 1;
  /** Collection names; a collection's position is the id used in the files. */
  collections: string[];
  snapshot: string | null;
  /** Oldest first; the last is the one being written. */
  journals: string[];
}

type Doc = Record<string, unknown> & { id: string };

const HIGH_WATER = 16 << 20; // buffered bytes before a write is forced
const MAX_GROUP = 8 << 20; // a batch bigger than this is written as several groups
const pad = (n: number) => String(n).padStart(6, '0');

/**
 * Documents live in memory, as plain objects with indexes. Every change is appended to a journal; the journal is
 * folded into a snapshot in the background in small slices, so nothing ever rewrites the whole database in one go.
 *
 * Open with `Docstore.open(dir)`, or `Docstore.open(null)` for a store that lives only in memory.
 */
export class Docstore implements Sink {
  private names: string[] = [];
  private cids = new Map<string, number>();
  private readonly loaded = new Map<string, Map<string, Doc>>();
  private readonly cols = new Map<string, Collection<{ id: string }>>();
  private manifest: Manifest = { v: 1, collections: [], snapshot: null, journals: [] };
  private seq = 0;
  private fd: number | null = null;
  private journalBytes = 0;
  private snapshotBytes = 0;
  private pending: string[] = [];
  private pendingBytes = 0;
  private group: { lines: string[]; bytes: number } | null = null;
  private dirty = false; // written but not yet fsynced
  private syncing = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private compacting: Promise<void> | null = null;
  private lockFile: string | null = null;
  private onExit: (() => void) | null = null;
  private closed = false;

  private constructor(
    readonly dir: string | null,
    private readonly opts: Required<Pick<OpenOptions, 'flushIntervalMs' | 'fsyncIntervalMs' | 'durability' | 'compactAtBytes' | 'autoCompact' | 'lock'>> & Pick<OpenOptions, 'onError'>,
  ) {}

  static async open(dir: string | null, options: OpenOptions = {}): Promise<Docstore> {
    const s = new Docstore(dir, {
      flushIntervalMs: options.flushIntervalMs ?? 20,
      fsyncIntervalMs: options.fsyncIntervalMs ?? 1000,
      durability: options.durability ?? 'relaxed',
      compactAtBytes: options.compactAtBytes ?? 32 << 20,
      autoCompact: options.autoCompact ?? true,
      lock: options.lock ?? true,
      onError: options.onError,
    });
    if (dir) s.init();
    return s;
  }

  /** Create a store in `dir` from a file written by `exportSync`. `dir` must not hold a store already. */
  static restore(file: string, dir: string): void {
    mkdirSync(dir, { recursive: true });
    if (existsSync(path.join(dir, 'MANIFEST.json'))) throw new DocstoreError(`${dir} already holds a store`, 'exists');
    let names: string[] | null = null;
    readLog(file, (rec) => {
      if (names === null && rec.charCodeAt(0) === 72) names = (JSON.parse(rec.slice(2)) as { collections: string[] }).collections;
    }, { tolerateTail: false });
    if (!names) throw new CorruptionError(`${file} is not an export (no header)`);
    const snap = 'snap-000001.jsonl';
    copyFileChunked(file, path.join(dir, snap));
    const m: Manifest = { v: 1, collections: names, snapshot: snap, journals: ['wal-000001.log'] };
    writeFileSync(path.join(dir, 'wal-000001.log'), '');
    writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(m));
  }

  // ---- opening ---------------------------------------------------------------------------------

  private file(name: string): string {
    return path.join(this.dir!, name);
  }

  private init(): void {
    mkdirSync(this.dir!, { recursive: true });
    if (this.opts.lock) this.acquireLock();
    try {
      for (const f of readdirSync(this.dir!)) if (f.endsWith('.tmp')) unlinkSync(this.file(f));
      const mf = this.file('MANIFEST.json');
      if (existsSync(mf)) {
        this.manifest = JSON.parse(readFileSync(mf, 'utf8')) as Manifest;
        this.names = [...this.manifest.collections];
        this.names.forEach((n, i) => this.cids.set(n, i));
        this.seq = Math.max(0, ...[this.manifest.snapshot, ...this.manifest.journals].map((f) => parseInt(/-(\d+)\./.exec(f ?? '')?.[1] ?? '0', 10)));
      } else {
        this.seq = 1;
        this.manifest = { v: 1, collections: [], snapshot: null, journals: [`wal-${pad(1)}.log`] };
        writeFileSync(this.file(this.manifest.journals[0]!), '');
        this.writeManifest();
      }
      if (this.manifest.snapshot) {
        const file = this.file(this.manifest.snapshot);
        this.snapshotBytes = statSync(file).size;
        this.replay(file, false);
      }
      const last = this.manifest.journals.length - 1;
      this.manifest.journals.forEach((j, i) => {
        const file = this.file(j);
        if (!existsSync(file)) writeFileSync(file, '');
        const r = this.replay(file, i === last);
        // Cut off a half-written record so new records do not follow garbage.
        if (r.truncated) truncateSync(file, r.validBytes);
        this.journalBytes += r.validBytes;
      });
      this.fd = openSync(this.file(this.manifest.journals[last]!), 'a');
    } catch (e) {
      this.releaseLock();
      throw e;
    }
    this.startTimers();
  }

  /** Apply a file's records to the in-memory staging area. Groups (B..E) apply only if complete. */
  private replay(file: string, tolerateTail: boolean) {
    let group: { del: boolean; cid: number; doc?: Doc; id?: string }[] | null = null;
    let groupStart = 0;
    const apply = (a: { del: boolean; cid: number; doc?: Doc; id?: string }) => {
      const name = this.names[a.cid];
      if (name === undefined) throw new CorruptionError(`${file}: record for unknown collection ${a.cid}`);
      let m = this.loaded.get(name);
      if (!m) this.loaded.set(name, (m = new Map()));
      if (a.del) m.delete(a.id!);
      else m.set(a.doc!.id, a.doc!);
    };
    const result = readLog(file, (rec, offset) => {
      const kind = rec.charCodeAt(0);
      if (kind === 80 /* P */ || kind === 68 /* D */) {
        const sp = rec.indexOf(' ', 2);
        const cid = parseInt(rec.slice(2, sp), 10);
        const body = rec.slice(sp + 1);
        const a = kind === 80 ? { del: false, cid, doc: JSON.parse(body) as Doc } : { del: true, cid, id: JSON.parse(body) as string };
        if (group) group.push(a);
        else apply(a);
      } else if (kind === 66 /* B */) {
        group = [];
        groupStart = offset;
      } else if (kind === 69 /* E */) {
        if (group) for (const a of group) apply(a);
        group = null;
      }
      // H (header) and anything unknown is skipped.
    }, { tolerateTail });
    // A group still open at the end of the file never finished. In the journal being written that is a crash in the middle
    // of a batch: drop it, and cut the file back so new records do not land inside it.
    if (group !== null) {
      if (!tolerateTail) throw new CorruptionError(`${file}: a batch was never finished`);
      return { ...result, validBytes: groupStart, truncated: true };
    }
    return result;
  }

  private writeManifest(): void {
    const tmp = this.file('MANIFEST.json.tmp');
    writeFileSync(tmp, JSON.stringify({ ...this.manifest, collections: this.names }));
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file('MANIFEST.json'));
  }

  private acquireLock(): void {
    const lock = this.file('LOCK');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lock, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        this.lockFile = lock;
        this.onExit = () => this.releaseLock();
        process.once('exit', this.onExit);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const pid = parseInt(readFileSync(lock, 'utf8'), 10);
        if (pid && pid !== process.pid && alive(pid)) throw new LockedError(`${this.dir} is in use by process ${pid}`);
        if (pid === process.pid) throw new LockedError(`${this.dir} is already open in this process`);
        unlinkSync(lock); // left behind by a process that is gone
      }
    }
    throw new LockedError(`Could not lock ${this.dir}`);
  }

  private releaseLock(): void {
    if (this.onExit) process.removeListener('exit', this.onExit);
    this.onExit = null;
    if (this.lockFile) {
      try {
        unlinkSync(this.lockFile);
      } catch {
        /* already gone */
      }
      this.lockFile = null;
    }
  }

  // ---- collections -----------------------------------------------------------------------------

  /** Get (or create) a collection. Call it once per collection, right after opening, with the indexes you need. */
  collection<T extends { id: string }>(name: string, options: CollectionOptions = {}): Collection<T> {
    const have = this.cols.get(name);
    if (have) return have as unknown as Collection<T>;
    if (!this.cids.has(name)) {
      this.cids.set(name, this.names.length);
      this.names.push(name);
      if (this.dir) this.writeManifest();
    }
    const staged = this.loaded.get(name);
    this.loaded.delete(name);
    const col = new Collection<T>(name, options, this, staged);
    this.cols.set(name, col as unknown as Collection<{ id: string }>);
    return col;
  }

  // ---- recording changes -----------------------------------------------------------------------

  put(collection: string, json: string): void {
    if (this.fd === null) return;
    this.append(`P ${this.cids.get(collection)} ${json}`);
  }

  del(collection: string, id: string): void {
    if (this.fd === null) return;
    this.append(`D ${this.cids.get(collection)} ${JSON.stringify(id)}`);
  }

  private append(record: string): void {
    if (this.closed) return;
    const line = encode(record);
    if (this.group) {
      this.group.lines.push(line);
      this.group.bytes += line.length;
      if (this.group.bytes >= MAX_GROUP) this.commitGroup();
      return;
    }
    this.pending.push(line);
    this.pendingBytes += line.length;
    if (this.opts.durability === 'strict') this.flushSync();
    else if (this.pendingBytes >= HIGH_WATER) this.writePending();
  }

  /**
   * Run `fn`; everything it changes is written as one group that a crash applies completely or not at all
   * (groups over 8 MB are written as several). Nothing is rolled back if `fn` throws: the changes already made are kept,
   * in memory and in the journal.
   */
  batch<R>(fn: () => R): R {
    if (this.group || this.fd === null) return fn();
    this.group = { lines: [], bytes: 0 };
    try {
      return fn();
    } finally {
      this.commitGroup();
      this.group = null;
      if (this.opts.durability === 'strict') this.flushSync();
    }
  }

  private commitGroup(): void {
    const g = this.group;
    if (!g || g.lines.length === 0) return;
    const block = encode('B') + g.lines.join('') + encode('E');
    this.pending.push(block);
    this.pendingBytes += block.length;
    g.lines = [];
    g.bytes = 0;
    if (this.pendingBytes >= HIGH_WATER) this.writePending();
  }

  // ---- writing to disk -------------------------------------------------------------------------

  private writePending(): void {
    if (this.fd === null || this.pending.length === 0) return;
    const data = Buffer.from(this.pending.join(''), 'utf8');
    this.pending = [];
    this.pendingBytes = 0;
    let off = 0;
    while (off < data.length) off += writeSync(this.fd, data, off, data.length - off);
    this.journalBytes += data.length;
    this.dirty = true;
  }

  /** Write buffered changes and force them to disk, now. */
  flushSync(): void {
    if (this.fd === null) return;
    this.writePending();
    if (this.dirty) {
      fsyncSync(this.fd);
      this.dirty = false;
    }
  }

  /** Write buffered changes and wait for the disk, without blocking other work while it waits. */
  async flush(): Promise<void> {
    if (this.fd === null) return;
    this.writePending();
    if (!this.dirty) return;
    const fd = this.fd;
    this.dirty = false;
    await new Promise<void>((resolve, reject) => fsyncAsync(fd, (err) => (err ? reject(err) : resolve())));
  }

  private startTimers(): void {
    this.flushTimer = setInterval(() => {
      try {
        this.writePending();
        this.maybeCompact();
      } catch (e) {
        this.opts.onError?.(e);
      }
    }, this.opts.flushIntervalMs);
    this.flushTimer.unref();
    if (this.opts.fsyncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        if (!this.dirty || this.syncing || this.fd === null) return;
        const fd = this.fd;
        this.syncing = true;
        this.dirty = false;
        fsyncAsync(fd, (err) => {
          this.syncing = false;
          if (err && !this.closed && fd === this.fd) this.opts.onError?.(err);
        });
      }, this.opts.fsyncIntervalMs);
      this.syncTimer.unref();
    }
  }

  // ---- compaction ------------------------------------------------------------------------------

  private maybeCompact(): void {
    if (!this.opts.autoCompact || this.compacting || this.closed) return;
    if (this.journalBytes > this.opts.compactAtBytes && this.journalBytes > this.snapshotBytes) {
      void this.compact().catch((e) => this.opts.onError?.(e));
    }
  }

  /**
   * Fold the journal into a new snapshot. The journal switches to a new file first, then the snapshot is written in
   * slices of about a megabyte with the event loop free in between. Changes made meanwhile are in the new journal, and
   * replaying a change over a snapshot that already holds it is harmless, so the result is always consistent.
   */
  compact(): Promise<void> {
    if (this.fd === null || this.closed) return Promise.resolve();
    this.compacting ??= this.doCompact().finally(() => (this.compacting = null));
    return this.compacting;
  }

  private async doCompact(): Promise<void> {
    this.flushSync();
    const oldSnapshot = this.manifest.snapshot;
    const oldJournals = [...this.manifest.journals];
    const seq = ++this.seq;
    const wal = `wal-${pad(seq)}.log`;
    const snap = `snap-${pad(seq)}.jsonl`;
    const next = openSync(this.file(wal), 'a');
    closeSync(this.fd!);
    this.fd = next;
    this.journalBytes = 0;
    this.manifest.journals = [...oldJournals, wal];
    this.writeManifest();

    const tmp = this.file(`${snap}.tmp`);
    const out = openSync(tmp, 'w');
    let bytes = 0;
    try {
      const write = (s: string) => {
        const b = Buffer.from(s, 'utf8');
        let off = 0;
        while (off < b.length) off += writeSync(out, b, off, b.length - off);
        bytes += b.length;
      };
      write(encode(`H ${JSON.stringify({ v: 1, collections: this.names })}`));
      let slice: string[] = [];
      let sliceBytes = 0;
      const emit = async (cid: number, docs: Iterable<Doc>) => {
        for (const doc of docs) {
          const line = encode(`P ${cid} ${JSON.stringify(doc)}`);
          slice.push(line);
          sliceBytes += line.length;
          if (sliceBytes >= 1 << 20) {
            write(slice.join(''));
            slice = [];
            sliceBytes = 0;
            await new Promise<void>((r) => setImmediate(r));
            if (this.closed) throw new DocstoreError('closed during compaction', 'closed');
          }
        }
      };
      for (const [name, col] of [...this.cols]) await emit(this.cids.get(name)!, col.values() as unknown as Iterable<Doc>);
      for (const [name, docs] of [...this.loaded]) await emit(this.cids.get(name)!, docs.values());
      if (slice.length) write(slice.join(''));
      fsyncSync(out);
    } catch (e) {
      closeSync(out);
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      throw e;
    }
    closeSync(out);
    renameSync(tmp, this.file(snap));
    this.manifest = { v: 1, collections: this.names, snapshot: snap, journals: [wal] };
    this.writeManifest();
    this.snapshotBytes = bytes;
    for (const f of [oldSnapshot, ...oldJournals]) {
      if (!f) continue;
      try {
        unlinkSync(this.file(f));
      } catch {
        /* already gone */
      }
    }
  }

  // ---- backups and bookkeeping -----------------------------------------------------------------

  /**
   * Write everything to one file (a snapshot followed by the journals, all in the record format). `Docstore.restore`
   * turns it back into a store. Copies bytes only, so it is quick; it holds the event loop for the copy.
   */
  exportSync(dest: string): number {
    if (!this.dir) return this.exportMemory(dest);
    this.flushSync();
    const tmp = `${dest}.tmp`;
    const out = openSync(tmp, 'w', 0o600);
    let total = 0;
    try {
      const header = Buffer.from(encode(`H ${JSON.stringify({ v: 1, collections: this.names })}`));
      writeSync(out, header);
      total += header.length;
      for (const f of [this.manifest.snapshot, ...this.manifest.journals]) {
        if (!f) continue;
        const fd = openSync(this.file(f), 'r');
        try {
          const size = fstatSync(fd).size;
          const buf = Buffer.allocUnsafe(1 << 22);
          let pos = 0;
          // Skip a snapshot's own header: the export has one.
          while (pos < size) {
            const n = readSync(fd, buf, 0, buf.length, pos);
            if (n === 0) break;
            let o = 0;
            while (o < n) o += writeSync(out, buf, o, n - o);
            pos += n;
            total += n;
          }
        } finally {
          closeSync(fd);
        }
      }
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    renameSync(tmp, dest);
    return total;
  }

  /** A store with no files has no journal to copy, so write its documents out instead (same format). */
  private exportMemory(dest: string): number {
    const tmp = `${dest}.tmp`;
    const out = openSync(tmp, 'w', 0o600);
    let total = 0;
    try {
      const write = (s: string) => {
        const b = Buffer.from(s, 'utf8');
        let off = 0;
        while (off < b.length) off += writeSync(out, b, off, b.length - off);
        total += b.length;
      };
      write(encode(`H ${JSON.stringify({ v: 1, collections: this.names })}`));
      for (const [name, col] of this.cols) {
        const cid = this.cids.get(name)!;
        let chunk: string[] = [];
        for (const doc of col.values()) {
          chunk.push(encode(`P ${cid} ${JSON.stringify(doc)}`));
          if (chunk.length >= 2000) (write(chunk.join('')), (chunk = []));
        }
        if (chunk.length) write(chunk.join(''));
      }
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    renameSync(tmp, dest);
    return total;
  }

  /** Bytes the store occupies on disk. */
  diskBytes(): number {
    if (!this.dir) return 0;
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      try {
        n += statSync(this.file(f)).size;
      } catch {
        /* removed while counting */
      }
    }
    return n;
  }

  stats() {
    return {
      collections: Object.fromEntries([...this.cols].map(([n, c]) => [n, c.size])),
      journalBytes: this.journalBytes,
      snapshotBytes: this.snapshotBytes,
      bufferedBytes: this.pendingBytes,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.compacting) await this.compacting.catch(() => undefined);
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.fd !== null) {
      this.writePending();
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = null;
    }
    this.releaseLock();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function copyFileChunked(from: string, to: string): void {
  const src = openSync(from, 'r');
  const dst = openSync(to, 'w', 0o600);
  try {
    const buf = Buffer.allocUnsafe(1 << 22);
    for (;;) {
      const n = readSync(src, buf, 0, buf.length, null);
      if (n === 0) break;
      let o = 0;
      while (o < n) o += writeSync(dst, buf, o, n - o);
    }
    fsyncSync(dst);
  } finally {
    closeSync(src);
    closeSync(dst);
  }
}
