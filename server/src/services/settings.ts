import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { ServerSettings } from '../db/types.js';

export class SettingsService {
  constructor(
    private db: Database,
    private config: Config,
  ) {
    if (!db.serverSettings.count()) {
      db.serverSettings.insert({
        id: 'server',
        registrationOpen: true,
        whisperModel: config.whisperModel,
        pollIntervalMinutes: 30,
        autoTranscribe: { enabled: false, scope: 'new', podcastIds: null, enabledAt: 0 },
        lastBackupAt: null,
        lastBackupBytes: null,
      });
    }
  }
  get doc() {
    const d = this.db.serverSettings.find()[0]!;
    // Databases created before auto-transcribe existed.
    d.autoTranscribe ??= { enabled: false, scope: 'new', podcastIds: null, enabledAt: 0 };
    return d;
  }
  get(): ServerSettings {
    return this.doc;
  }
  update(patch: Partial<Pick<ServerSettings, 'registrationOpen' | 'whisperModel' | 'pollIntervalMinutes'>> & { autoTranscribe?: { enabled: boolean; scope: 'new' | 'all'; podcastIds: string[] | null } }): ServerSettings {
    const d = this.doc;
    const { autoTranscribe, ...rest } = patch;
    Object.assign(d, rest);
    if (autoTranscribe) {
      const prev = d.autoTranscribe;
      // "New episodes" counts from the moment it is switched on (or the scope is narrowed to new).
      const restart = autoTranscribe.enabled && (!prev.enabled || (autoTranscribe.scope === 'new' && prev.scope !== 'new'));
      d.autoTranscribe = { ...autoTranscribe, enabledAt: restart ? Date.now() : prev.enabledAt };
    }
    this.db.serverSettings.saveQuiet(d);
    return d;
  }
  recordBackup(at: number, bytes: number): void {
    const d = this.doc;
    d.lastBackupAt = at;
    d.lastBackupBytes = bytes;
    this.db.serverSettings.saveQuiet(d);
  }
}
