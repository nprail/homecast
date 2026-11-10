import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptSegment } from '@homecast/shared';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { Episode, Job } from '../db/types.js';
import { notFound } from '../util/errors.js';
import { now } from '../util/misc.js';
import { safeDownloadToFile, safeFetchBuffer } from '../security/ssrf.js';
import type { AuditService } from './audit.js';
import type { SettingsService } from './settings.js';
import { parseTranscript } from './transcriptFormats.js';
import type { UsageService } from './usage.js';

const AUDIO_MAX_BYTES = 1024 ** 3; // 1 GB, for transcription only
const DOWNLOAD_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 60 * 60_000;
const WHISPER_TIMEOUT_MS = 8 * 60 * 60_000;
const TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;

interface ProcResult {
  code: number | null;
  stderr: string;
}

/** Spawn with an argument array (never a shell), a timeout, and cancellation. */
function runProcess(bin: string, args: string[], opts: { timeoutMs: number; signal: AbortSignal; onLine?: (line: string) => void; cwd?: string }): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd, shell: false });
    let tail = '';
    let buf = '';
    const feed = (d: Buffer) => {
      const s = d.toString('utf8');
      tail = (tail + s).slice(-8000);
      if (opts.onLine) {
        buf += s;
        const parts = buf.split(/[\r\n]+/);
        buf = parts.pop() ?? '';
        parts.forEach(opts.onLine);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, opts.timeoutMs);
    opts.signal.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', kill);
      resolve({ code, stderr: tail });
    });
  });
}

export function resolveModelPath(config: Config, model: string): string {
  if (model.includes('/') || model.endsWith('.bin')) return path.isAbsolute(model) ? model : path.join(config.whisperModelDir, model);
  return path.join(config.whisperModelDir, `ggml-${model}.bin`);
}

/** Requester id for jobs queued by the auto-transcribe setting. */
export const SYSTEM_USER = 'system';

export class TranscriptService {
  /** Fired after each job finishes (auto-transcribe tops up the queue from here). */
  onJobFinished: (() => void) | null = null;
  private active = new Map<string, AbortController>();
  private running = false;
  private stopped = false;

  constructor(
    private db: Database,
    private config: Config,
    private usage: UsageService,
    private settings: SettingsService,
    private audit: AuditService,
    private log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
  ) {}

  /** Resume persisted jobs after a restart (spec §8: in-process queue persisted in the DB). */
  start(): void {
    for (const j of this.db.jobs.find({ status: 'running' })) {
      j.status = 'queued';
      j.stage = null;
      j.progress = null;
      j.startedAt = null;
      this.db.jobs.saveQuiet(j);
    }
    this.kick();
  }
  stop(): void {
    this.stopped = true;
    for (const c of this.active.values()) c.abort();
  }

  get(episodeId: string) {
    return this.db.transcripts.findOne({ episodeId });
  }

  /** Request a transcript. Deduplicated per episode: attaches to an existing transcript or job. */
  request(userId: string, episodeId: string): { status: 'ready' | 'queued' | 'running'; job: Job | null } {
    const episode = this.db.episodes.get(episodeId);
    if (!episode || episode.deleted) throw notFound('Episode not found');
    if (this.get(episodeId)) return { status: 'ready', job: null };
    const open = this.db.jobs.find({ episodeId }).find((j) => j.status === 'queued' || j.status === 'running');
    if (open) {
      if (userId !== SYSTEM_USER && !open.attachedUsers.includes(userId)) {
        open.attachedUsers.push(userId);
        this.db.jobs.saveQuiet(open);
      }
      return { status: open.status as 'queued' | 'running', job: open };
    }
    const job = this.db.jobs.insert({
      type: 'transcript',
      episodeId,
      podcastId: episode.podcastId,
      status: 'queued',
      stage: null,
      progress: null,
      error: null,
      requestedBy: userId,
      attachedUsers: userId === SYSTEM_USER ? [] : [userId],
      source: null,
      audioSeconds: episode.durationSec || null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    });
    if (episode.transcriptUrl) void this.tryPublisher(job, episode);
    else this.kick();
    return { status: 'queued', job };
  }

  canView(job: Job, userId: string, isAdmin: boolean): boolean {
    return isAdmin || job.requestedBy === userId || job.attachedUsers.includes(userId);
  }

  retry(id: string): Job {
    const j = this.db.jobs.get(id);
    if (!j) throw notFound('Job not found');
    if (j.status !== 'failed' && j.status !== 'cancelled') return j;
    Object.assign(j, { status: 'queued', error: null, stage: null, progress: null, startedAt: null, finishedAt: null, durationMs: null, createdAt: now() });
    this.db.jobs.saveQuiet(j);
    this.kick();
    return j;
  }

  cancel(id: string): Job {
    const j = this.db.jobs.get(id);
    if (!j) throw notFound('Job not found');
    if (j.status === 'queued') {
      Object.assign(j, { status: 'cancelled', finishedAt: now() });
      this.db.jobs.saveQuiet(j);
    } else if (j.status === 'running') {
      this.active.get(j.id)?.abort();
    }
    return j;
  }

  queuePosition(job: Job): number | null {
    if (job.status !== 'queued') return null;
    return this.db.jobs.find({ status: 'queued' }).filter((q) => q.createdAt < job.createdAt || (q.createdAt === job.createdAt && q.id < job.id)).length + 1;
  }

  // ---- publisher transcripts ------------------------------------------------------------------

  private async tryPublisher(job: Job, episode: Episode): Promise<void> {
    const started = now();
    Object.assign(job, { status: 'running', stage: 'Fetching publisher transcript', startedAt: started });
    this.db.jobs.saveQuiet(job);
    try {
      const res = await safeFetchBuffer(episode.transcriptUrl!, { maxBytes: TRANSCRIPT_MAX_BYTES, timeoutMs: 20_000, allowPrivate: this.config.allowPrivateNetworks });
      this.usage.add(job.requestedBy, 'transcribeBytes', res.bytes);
      const ct = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : episode.transcriptType;
      const segments = res.status === 200 ? parseTranscript(res.body.toString('utf8'), ct ?? null, episode.transcriptUrl!) : null;
      if (segments) {
        this.complete(job, episode, segments, 'feed', null);
        return;
      }
    } catch (e) {
      this.log.warn({ err: e, episode: episode.id }, 'publisher transcript unavailable; falling back to whisper');
    }
    Object.assign(job, { status: 'queued', stage: null, startedAt: null });
    this.db.jobs.saveQuiet(job);
    this.kick();
  }

  private complete(job: Job, episode: Episode, segments: TranscriptSegment[], source: 'feed' | 'whisper', model: string | null): void {
    if (!this.get(episode.id)) {
      this.db.transcripts.insert({ episodeId: episode.id, source, status: 'ready', model, segments, createdAt: now() });
    }
    const t = now();
    Object.assign(job, { status: 'done', source, stage: null, progress: 100, error: null, finishedAt: t, durationMs: t - (job.startedAt ?? t) });
    this.db.jobs.saveQuiet(job);
    this.audit.log({ action: 'job.done', target: job.id, targetLabel: episode.title, actorId: job.requestedBy === SYSTEM_USER ? null : job.requestedBy });
  }

  // ---- whisper worker -------------------------------------------------------------------------

  kick(): void {
    if (this.running || this.stopped) return;
    void this.loop();
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopped) {
        const next = this.db.jobs.find({ status: 'queued' }).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) break;
        await this.runWhisperJob(next);
        this.onJobFinished?.();
      }
    } finally {
      this.running = false;
    }
  }

  private setStage(job: Job, stage: string, progress: number | null = null): void {
    job.stage = stage;
    job.progress = progress;
    this.db.jobs.saveQuiet(job);
  }

  private async runWhisperJob(job: Job): Promise<void> {
    const episode = this.db.episodes.get(job.episodeId);
    const started = now();
    Object.assign(job, { status: 'running', startedAt: started, stage: 'Starting', progress: 0, error: null });
    this.db.jobs.saveQuiet(job);
    if (!episode) {
      this.fail(job, 'Episode no longer exists');
      return;
    }
    const ctl = new AbortController();
    this.active.set(job.id, ctl);
    const root = path.join(this.config.dataDir, 'tmp');
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(path.join(root, 'job-'));
    try {
      const model = this.settings.get().whisperModel;
      const modelPath = resolveModelPath(this.config, model);
      if (!existsSync(modelPath)) await this.fetchModel(model, modelPath, ctl.signal, job);

      this.setStage(job, 'Downloading audio', 0);
      const audio = path.join(dir, 'audio.bin');
      let bytes: number;
      try {
        bytes = await safeDownloadToFile(episode.audioUrl, audio, { maxBytes: AUDIO_MAX_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS, signal: ctl.signal, allowPrivate: this.config.allowPrivateNetworks });
      } catch (e) {
        if (ctl.signal.aborted) throw e;
        const msg = e instanceof Error ? e.message : 'download failed';
        throw new Error(/timeout|UND_ERR_(HEADERS|BODY|CONNECT)/i.test(msg) ? `Audio download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000} s` : `Audio download failed: ${msg}`);
      }
      this.usage.add(job.requestedBy, 'transcribeBytes', bytes);

      this.setStage(job, 'Converting audio', 0);
      const wav = path.join(dir, 'audio.wav');
      let seconds = 0;
      const ff = await runProcess(this.config.ffmpegBin, ['-nostdin', '-y', '-i', audio, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], {
        timeoutMs: FFMPEG_TIMEOUT_MS,
        signal: ctl.signal,
        cwd: dir,
        onLine: (l) => {
          const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(l);
          if (m) seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        },
      });
      if (ff.code !== 0) throw new Error(`ffmpeg failed (exit ${ff.code}): ${ff.stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`);
      if (seconds > 0) {
        job.audioSeconds = Math.round(seconds);
        this.db.jobs.saveQuiet(job);
      }

      this.setStage(job, 'Transcribing', 0);
      const outBase = path.join(dir, 'out');
      const lang = model.includes('.en') ? 'en' : 'auto';
      const wh = await runProcess(this.config.whisperBin, ['-m', modelPath, '-f', wav, '-oj', '-of', outBase, '-pp', '-l', lang], {
        timeoutMs: WHISPER_TIMEOUT_MS,
        signal: ctl.signal,
        cwd: dir,
        onLine: (l) => {
          const m = /progress\s*=\s*(\d+)%/.exec(l);
          if (m) {
            const pct = Math.min(100, Number(m[1]));
            if (pct !== job.progress) {
              job.progress = pct;
              this.db.jobs.saveQuiet(job);
            }
          }
        },
      });
      if (wh.code !== 0) throw new Error(`whisper failed (exit ${wh.code}): ${wh.stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`);
      const out = JSON.parse(await readFile(`${outBase}.json`, 'utf8')) as { transcription?: { offsets: { from: number; to: number }; text: string }[] };
      const segments: TranscriptSegment[] = (out.transcription ?? [])
        .map((s) => ({ startMs: s.offsets.from, endMs: s.offsets.to, text: s.text.replace(/\s+/g, ' ').trim() }))
        .filter((s) => s.text && s.text !== '[BLANK_AUDIO]');
      if (!segments.length) throw new Error('Whisper produced no text');
      this.usage.add(job.requestedBy, 'transcriptMinutes', Math.round((job.audioSeconds ?? episode.durationSec) / 60));
      this.complete(job, episode, segments, 'whisper', model);
    } catch (e) {
      if (ctl.signal.aborted && !this.stopped) {
        Object.assign(job, { status: 'cancelled', stage: null, finishedAt: now(), durationMs: now() - started });
        this.db.jobs.saveQuiet(job);
      } else if (this.stopped) {
        Object.assign(job, { status: 'queued', stage: null, progress: null, startedAt: null });
        this.db.jobs.saveQuiet(job);
      } else {
        this.fail(job, e instanceof Error ? e.message : 'Transcription failed');
      }
    } finally {
      this.active.delete(job.id);
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Download a standard whisper.cpp model on first use (names only; custom paths must already exist). */
  private async fetchModel(model: string, modelPath: string, signal: AbortSignal, job: Job): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) || model.endsWith('.bin')) throw new Error(`Whisper model not found: ${modelPath}`);
    this.setStage(job, `Downloading model ${model}`, null);
    this.log.info({ model }, 'downloading whisper model');
    await mkdir(path.dirname(modelPath), { recursive: true });
    const tmp = `${modelPath}.part`;
    try {
      await safeDownloadToFile(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`, tmp, { maxBytes: 4 * 1024 ** 3, timeoutMs: 60_000, signal });
      await rename(tmp, modelPath);
    } catch (e) {
      await rm(tmp, { force: true });
      if (signal.aborted) throw e;
      throw new Error(`Whisper model not found and could not be downloaded: ${modelPath} (${e instanceof Error ? e.message : 'error'})`);
    }
  }

  private fail(job: Job, error: string): void {
    const t = now();
    Object.assign(job, { status: 'failed', error: error.slice(0, 400), stage: null, progress: null, finishedAt: t, durationMs: t - (job.startedAt ?? t) });
    this.db.jobs.saveQuiet(job);
    this.audit.log({ action: 'job.failed', target: job.id, targetLabel: this.db.episodes.get(job.episodeId)?.title ?? null, actorId: job.requestedBy === SYSTEM_USER ? null : job.requestedBy, detail: job.error });
    this.log.warn({ job: job.id, error }, 'transcript job failed');
  }

  /** Delete finished job rows after 30 days. */
  prune(): void {
    const cutoff = now() - 30 * 86_400_000;
    this.db.jobs.removeWhere((j) => (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') && (j.finishedAt ?? j.createdAt) < cutoff);
  }
}
