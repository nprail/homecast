import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Loki from 'lokijs';
import type {
  AuditLogEntry, Bookmark, Episode, EpisodeState, Invite, Job, Meta, Playlist, Podcast, RefreshToken, ResetToken,
  ServerSettings, SmartPlaylist, Subscription, Transcript, UsageStat, User, UserSettings,
} from './types.js';
import { clean, uuid } from '../util/misc.js';

type Doc<T> = T;

/**
 * Thin repository over a LokiJS collection (spec §8). Everything outside `db/`
 * goes through this class, so swapping the storage engine later only touches this module.
 */
export class Repo<T extends { id: string }> {
  constructor(
    readonly col: Collection<T>,
    private readonly nextRev: (() => number) | null,
  ) {}

  insert(doc: Omit<T, 'id'> & { id?: string }): Doc<T> {
    const full = { ...doc, id: doc.id ?? uuid() } as T & { rev?: number };
    if (this.nextRev) full.rev = this.nextRev();
    return this.col.insert(full as T) as Doc<T>;
  }
  /** Persist a mutated live document, bumping `rev` for synced collections. */
  save(doc: Doc<T>): Doc<T> {
    if (this.nextRev) (doc as T & { rev?: number }).rev = this.nextRev();
    return this.col.update(doc as T & LokiObj) as Doc<T>;
  }
  /** Persist without touching `rev` (server-internal bookkeeping that clients don't need). */
  saveQuiet(doc: Doc<T>): Doc<T> {
    return this.col.update(doc as T & LokiObj) as Doc<T>;
  }
  get(id: string): Doc<T> | null {
    return (this.col.by('id', id) as Doc<T> | undefined) ?? null;
  }
  findOne(q: LokiQuery<T & LokiObj>): Doc<T> | null {
    return (this.col.findOne(q) as Doc<T> | null) ?? null;
  }
  find(q?: LokiQuery<T & LokiObj>): Doc<T>[] {
    return (q ? this.col.find(q) : this.col.find()) as Doc<T>[];
  }
  where(fn: (d: Doc<T>) => boolean): Doc<T>[] {
    return this.col.where(fn as unknown as (d: T) => boolean) as Doc<T>[];
  }
  count(q?: LokiQuery<T & LokiObj>): number {
    return q ? this.col.count(q) : this.col.count();
  }
  remove(doc: Doc<T>): void {
    this.col.remove(doc as T & LokiObj);
  }
  removeWhere(fn: (d: Doc<T>) => boolean): number {
    const docs = this.where(fn);
    for (const d of docs) this.col.remove(d);
    return docs.length;
  }
}

export interface DbOptions {
  dataDir: string;
  /** In-memory only (tests). */
  memory?: boolean;
  autosaveMs?: number;
}

export class Database {
  readonly loki: Loki;
  readonly users: Repo<User>;
  readonly refreshTokens: Repo<RefreshToken>;
  readonly invites: Repo<Invite>;
  readonly resetTokens: Repo<ResetToken>;
  readonly podcasts: Repo<Podcast>;
  readonly episodes: Repo<Episode>;
  readonly transcripts: Repo<Transcript>;
  readonly subscriptions: Repo<Subscription>;
  readonly episodeStates: Repo<EpisodeState>;
  readonly bookmarks: Repo<Bookmark>;
  readonly playlists: Repo<Playlist>;
  readonly smartPlaylists: Repo<SmartPlaylist>;
  readonly userSettings: Repo<UserSettings>;
  readonly jobs: Repo<Job>;
  readonly usageStats: Repo<UsageStat>;
  readonly auditLog: Repo<AuditLogEntry>;
  readonly serverSettings: Repo<ServerSettings>;
  private meta!: Collection<Meta>;
  private metaDoc!: Meta & LokiObj;
  readonly file: string;

  private constructor(loki: Loki, file: string) {
    this.loki = loki;
    this.file = file;
    const rev = () => this.bumpRev();
    const col = <T extends { id: string }>(name: string, unique: (keyof T & string)[], indices: (keyof T & string)[]) =>
      (loki.getCollection<T>(name) ??
        loki.addCollection<T>(name, { unique: ['id', ...unique] as never, indices: indices as never, clone: false })) as Collection<T>;

    this.meta = col<Meta>('meta', [], []);
    this.users = new Repo(col<User>('users', ['usernameKey'], []), null);
    this.refreshTokens = new Repo(col<RefreshToken>('refreshTokens', [], ['userId']), null);
    this.invites = new Repo(col<Invite>('invites', ['codeHash'], []), null);
    this.resetTokens = new Repo(col<ResetToken>('resetTokens', ['tokenHash'], []), null);
    this.podcasts = new Repo(col<Podcast>('podcasts', ['feedUrl'], ['rev']), rev);
    this.episodes = new Repo(col<Episode>('episodes', [], ['podcastId', 'rev', 'guid', 'audioUrl']), rev);
    this.transcripts = new Repo(col<Transcript>('transcripts', ['episodeId'], []), null);
    this.subscriptions = new Repo(col<Subscription>('subscriptions', [], ['userId', 'podcastId', 'rev']), rev);
    this.episodeStates = new Repo(col<EpisodeState>('episodeStates', [], ['userId', 'episodeId', 'rev']), rev);
    this.bookmarks = new Repo(col<Bookmark>('bookmarks', [], ['userId', 'episodeId', 'rev']), rev);
    this.playlists = new Repo(col<Playlist>('playlists', [], ['userId', 'rev']), rev);
    this.smartPlaylists = new Repo(col<SmartPlaylist>('smartPlaylists', [], ['userId', 'rev']), rev);
    this.userSettings = new Repo(col<UserSettings>('settings', [], ['userId', 'rev']), rev);
    this.jobs = new Repo(col<Job>('jobs', [], ['episodeId', 'status']), null);
    this.usageStats = new Repo(col<UsageStat>('usageStats', ['key'], ['userId', 'day']), null);
    this.auditLog = new Repo(col<AuditLogEntry>('auditLog', [], ['at']), null);
    this.serverSettings = new Repo(col<ServerSettings>('serverSettings', [], []), null);

    this.metaDoc = (this.meta.findOne({ id: 'rev' }) as (Meta & LokiObj) | null) ?? (this.meta.insert({ id: 'rev', rev: 0 }) as Meta & LokiObj);
  }

  static async open(opts: DbOptions): Promise<Database> {
    const file = path.join(opts.dataDir, 'homecast.db.json');
    mkdirSync(opts.dataDir, { recursive: true });
    // Data directories created before the rename (when the project was called Podcast Sync).
    const legacy = path.join(opts.dataDir, 'podsync.db.json');
    if (!opts.memory && !existsSync(file) && existsSync(legacy)) renameSync(legacy, file);
    const loki = await new Promise<Loki>((resolve, reject) => {
      const db: Loki = new Loki(file, {
        adapter: opts.memory ? new Loki.LokiMemoryAdapter() : new Loki.LokiFsAdapter(),
        autoload: false,
        autosave: !opts.memory,
        autosaveInterval: opts.autosaveMs ?? 5000,
        serializationMethod: 'normal',
      });
      db.loadDatabase({}, (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(db)));
    });
    return new Database(loki, file);
  }

  private bumpRev(): number {
    this.metaDoc.rev += 1;
    this.meta.update(this.metaDoc);
    return this.metaDoc.rev;
  }
  get currentRev(): number {
    return this.metaDoc.rev;
  }
  get horizon(): number {
    return this.metaDoc.horizon ?? 0;
  }
  raiseHorizon(rev: number): void {
    if (rev > this.horizon) {
      this.metaDoc.horizon = rev;
      this.meta.update(this.metaDoc);
    }
  }

  /** Flush to disk now. */
  save(): Promise<void> {
    return new Promise((resolve, reject) => this.loki.saveDatabase((err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())));
  }

  fileSize(): number {
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  /** Atomic snapshot into `backups/`, keeping the newest `keep`. Returns the file written. */
  snapshot(dataDir: string, keep = 14): { file: string; bytes: number; kept: number } {
    const dir = path.join(dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const final = path.join(dir, `homecast-${stamp}.json`);
    const tmp = `${final}.tmp`;
    const data = this.loki.serialize();
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, final);
    const files = this.listBackups(dataDir);
    for (const old of files.slice(keep)) {
      try {
        unlinkSync(path.join(dir, old.name));
      } catch {
        /* ignore */
      }
    }
    return { file: final, bytes: Buffer.byteLength(data), kept: Math.min(files.length, keep) };
  }

  listBackups(dataDir: string): { name: string; bytes: number; mtime: number }[] {
    const dir = path.join(dataDir, 'backups');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => /^(homecast|podsync)-.*\.json$/.test(n))
      .map((name) => {
        const st = statSync(path.join(dir, name));
        return { name, bytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.loki.close(() => resolve()));
  }
}

export { clean };
