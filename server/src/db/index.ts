import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  AuditLogEntry, Bookmark, Episode, EpisodeChapters, EpisodeState, Invite, Job, Playlist, Podcast, RefreshToken, ResetToken,
  EpisodeMirror, ServerSettings, SmartPlaylist, Subscription, Transcript, UsageStat, User, UserSettings,
} from './types.js';
import { DocstoreBackend } from './docstore.js';
import { LokiBackend, listBackupFiles } from './loki.js';
import type { Backend, EngineName, Repo } from './repo.js';
import { SqliteBackend } from './sqlite.js';
import { clean } from '../util/misc.js';
import { observe, type Change } from './observe.js';

export type { Change } from './observe.js';

export type { EngineName, Query, Repo } from './repo.js';
export const ENGINES: readonly EngineName[] = ['loki', 'sqlite', 'docstore'];

/** Where each engine keeps its data inside the data directory. */
export const localPath = (engine: EngineName, dataDir: string): string =>
  path.join(dataDir, engine === 'loki' ? 'homecast.db.json' : engine === 'sqlite' ? 'homecast.db.sqlite' : 'homecast.docstore');

export interface DbOptions {
  dataDir: string;
  /** In-memory only (tests). */
  memory?: boolean;
  autosaveMs?: number;
  /** `loki` (default): in memory with a JSON file. `sqlite`: on disk, needs Node.js 22.5+. `docstore`: in memory with a journal. */
  engine?: EngineName;
  /** Skip the one-time import of another engine's database when this one is new (for tools that copy explicitly). */
  noImport?: boolean;
}

export class Database {
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
  readonly episodeMirrors: Repo<EpisodeMirror>;
  readonly episodeChapters: Repo<EpisodeChapters>;
  /** Every collection by name (copying between engines). */
  readonly collections = new Map<string, Repo<{ id: string }>>();
  readonly file: string;
  private readonly transcriptListeners: ((c: Change<Transcript>) => void)[] = [];

  private constructor(readonly backend: Backend) {
    this.file = backend.file;
    const rev = () => backend.bumpRev();
    const col = <T extends { id: string }>(name: string, unique: (keyof T & string)[], indices: (keyof T & string)[], synced = false, compound: string[][] = [], wrap?: (r: Repo<T>) => Repo<T>): Repo<T> => {
      const r = wrap ? wrap(backend.repo<T>(name, unique, indices, synced ? rev : null, compound)) : backend.repo<T>(name, unique, indices, synced ? rev : null, compound);
      this.collections.set(name, r as unknown as Repo<{ id: string }>);
      return r;
    };

    this.users = col<User>('users', ['usernameKey'], []);
    this.refreshTokens = col<RefreshToken>('refreshTokens', [], ['userId']);
    this.invites = col<Invite>('invites', ['codeHash'], []);
    this.resetTokens = col<ResetToken>('resetTokens', ['tokenHash'], []);
    this.podcasts = col<Podcast>('podcasts', ['feedUrl'], ['rev'], true);
    this.episodes = col<Episode>('episodes', [], ['podcastId', 'rev', 'audioUrl', 'createdAt'], true, [['podcastId', 'rev']]);
    this.transcripts = col<Transcript>('transcripts', ['episodeId'], [], false, [], (r) => observe(r, (c) => this.transcriptListeners.forEach((fn) => fn(c))));
    this.subscriptions = col<Subscription>('subscriptions', [], ['userId', 'podcastId', 'rev'], true, [['userId', 'rev']]);
    this.episodeStates = col<EpisodeState>('episodeStates', [], ['userId', 'episodeId', 'rev'], true, [['userId', 'rev']]);
    this.bookmarks = col<Bookmark>('bookmarks', [], ['userId', 'episodeId', 'rev'], true, [['userId', 'rev']]);
    this.playlists = col<Playlist>('playlists', [], ['userId', 'rev'], true, [['userId', 'rev']]);
    this.smartPlaylists = col<SmartPlaylist>('smartPlaylists', [], ['userId', 'rev'], true, [['userId', 'rev']]);
    this.userSettings = col<UserSettings>('settings', [], ['userId', 'rev'], true, [['userId', 'rev']]);
    this.jobs = col<Job>('jobs', [], ['episodeId', 'status']);
    this.usageStats = col<UsageStat>('usageStats', ['key'], ['userId', 'day']);
    this.auditLog = col<AuditLogEntry>('auditLog', [], ['at']);
    this.serverSettings = col<ServerSettings>('serverSettings', [], []);
    this.episodeMirrors = col<EpisodeMirror>('episodeMirrors', [], ['status']);
    this.episodeChapters = col<EpisodeChapters>('episodeChapters', ['episodeId'], []);
  }

  static async open(opts: DbOptions): Promise<Database> {
    const engine = opts.engine ?? 'loki';
    if (engine === 'loki') return new Database(await LokiBackend.open(opts));
    const firstRun = !opts.memory && !opts.noImport && !existsSync(localPath(engine, opts.dataDir));
    const db = new Database(engine === 'sqlite' ? SqliteBackend.open(opts) : await DocstoreBackend.open(opts));
    // Switching an existing server to this engine: bring the data over once. The old database is left untouched.
    if (firstRun) {
      const from = (['loki', 'sqlite', 'docstore'] as const).find((e) => e !== engine && existsSync(localPath(e, opts.dataDir)));
      if (from) {
        const old = await Database.open({ dataDir: opts.dataDir, autosaveMs: 0, engine: from });
        const n = copyDatabase(old, db);
        await old.close();
        process.stderr.write(`Imported ${n} records from ${localPath(from, opts.dataDir)} into ${localPath(engine, opts.dataDir)}. The old database was not changed.\n`);
      }
    }
    return db;
  }

  /** Be told when a transcript is added, changed or removed. */
  onTranscriptChange(fn: (c: Change<Transcript>) => void): void {
    this.transcriptListeners.push(fn);
  }

  get engine(): EngineName {
    return this.backend.kind;
  }
  get currentRev(): number {
    return this.backend.currentRev;
  }
  get horizon(): number {
    return this.backend.horizon;
  }
  raiseHorizon(rev: number): void {
    this.backend.raiseHorizon(rev);
  }

  /** Group many changes into one disk write (a single transaction on SQLite; a no-op on the in-memory engine). */
  batch<R>(fn: () => R): R {
    return this.backend.batch(fn);
  }

  /** Flush to disk now. */
  save(): Promise<void> {
    return this.backend.save();
  }

  fileSize(): number {
    return this.backend.fileSize();
  }

  /** Atomic snapshot into `backups/`, keeping the newest `keep`. Returns the file written. */
  snapshot(dataDir: string, keep = 14): { file: string; bytes: number; kept: number } {
    return this.backend.snapshot(dataDir, keep);
  }

  listBackups(dataDir: string): { name: string; bytes: number; mtime: number }[] {
    return listBackupFiles(dataDir);
  }

  close(): Promise<void> {
    return this.backend.close();
  }
}

/** Copy every record from one database into an empty one (any engine to any engine). Returns the record count. */
export function copyDatabase(from: Database, to: Database): number {
  let n = 0;
  to.batch(() => {
    for (const [name, src] of from.collections) {
      const dst = to.collections.get(name);
      if (!dst) continue;
      for (const doc of src.find()) {
        dst.insertRaw(clean(JSON.parse(JSON.stringify(doc)) as { id: string })); // drop the in-memory engine's bookkeeping fields
        n++;
      }
    }
  });
  to.backend.setRevState(from.currentRev, from.horizon);
  return n;
}

export { clean };
