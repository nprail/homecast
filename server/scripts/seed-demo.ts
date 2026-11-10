/**
 * Fills a data directory with demo data for local development, so the admin dashboard looks populated.
 *   DATA_DIR=./data-demo npx tsx scripts/seed-demo.ts   (run with the server stopped)
 * Sign in as demo / demo-password-123.
 */
import { loadConfig } from '../src/config.js';
import { Database } from '../src/db/index.js';
import { hashPassword } from '../src/security/passwords.js';
import { SettingsService } from '../src/services/settings.js';
import { dayKey, sha256 } from '../src/util/misc.js';

const config = loadConfig();
const db = await Database.open({ dataDir: config.dataDir });
if (db.users.count() > 0) {
  console.error(`${config.dataDir} already has users; refusing to seed.`);
  process.exit(1);
}
new SettingsService(db, config);
const H = 3_600_000;
const D = 24 * H;
const now = Date.now();
const pw = await hashPassword('demo-password-123');

const mk = (username: string, role: 'admin' | 'user', lastActiveAgo: number, disabled = false) =>
  db.users.insert({ username, usernameKey: username.toLowerCase(), passwordHash: pw, role, createdAt: now - 60 * D, disabled, lastActiveAt: now - lastActiveAgo });
const demoAdmin = mk('demo', 'admin', 0);
const maya = mk('Maya', 'user', 3 * H);
const eli = mk('Eli', 'user', 2 * D);
const priya = mk('Priya', 'user', 9 * D);
const dana = mk('Dana', 'user', 12 * D);
const sam = mk('Sam', 'user', 34 * D, true);
const users = [demoAdmin, maya, eli, priya, dana, sam];

const sessions: Record<string, number> = { demo: 3, Maya: 2, Eli: 1, Priya: 2, Dana: 1, Sam: 0 };
for (const u of users) {
  for (let i = 0; i < (sessions[u.username] ?? 0); i++) {
    db.refreshTokens.insert({ userId: u.id, tokenHash: sha256(`${u.id}${i}`), previousTokenHash: null, deviceName: ['Pixel 9', 'iPhone 16', 'Firefox on macOS'][i] ?? 'Device', createdAt: now - 5 * D, lastUsedAt: now - H, expiresAt: now + 80 * D, revokedAt: null, ip: null });
  }
}

const feeds: [string, number, number | null, string | null, number | null][] = [
  ['Signal & Noise', 5, 12, null, 1200], ['Field Notes Daily', 4, 12, null, 900], ['Quiet Hours', 3, 41, null, 800],
  ['The Long Way Round', 2, 3 * 24 * 60, 'HTTP 410 Gone', 400], ['Kitchen Table Tech', 1, 12, null, 8200],
];
const podcasts = feeds.map(([title, , minsAgo, error, ms], i) =>
  db.podcasts.insert({
    feedUrl: `https://example.com/feeds/${i}.xml`, isPrivate: false, hiddenFromDiscover: false, title, author: 'Demo', imageUrl: null, description: `About ${title}`,
    createdAt: now - 40 * D, lastFetchedAt: now - (minsAgo ?? 0) * 60_000, lastFetchMs: ms, etag: null, lastModified: null, fetchError: error, failureCount: error ? 3 : 0, nextFetchAt: now + 20 * 60_000, createdBy: demoAdmin.id,
  }),
);
feeds.forEach(([, subs], i) => {
  for (let s = 0; s < subs; s++) db.subscriptions.insert({ userId: users[s % users.length]!.id, podcastId: podcasts[i]!.id, autoDownload: { mode: 'off' }, newEpisodeNotify: true, clientUpdatedAt: now });
});
const eps = podcasts.flatMap((p, pi) =>
  Array.from({ length: 6 }, (_, i) => db.episodes.insert({ podcastId: p.id, guid: `${pi}-${i}`, title: ['Why Every Network Eventually Gets Congested', 'What a Router Actually Remembers', 'A Map of the Quiet Parts', 'Three Minutes on Tide Tables', 'Night Shift at the Water Plant', 'Ham Radio for the Impatient'][i]!, description: '', audioUrl: `https://example.com/a/${pi}-${i}.mp3`, mimeType: 'audio/mpeg', durationSec: [3360, 3120, 3840, 180, 2160, 2460][i]!, releasedAt: now - i * D, createdAt: now - (i < 2 ? H * (i + 1) : (i + 5) * D), transcriptUrl: null, transcriptType: null })),
);

const job = (i: number, status: 'running' | 'queued' | 'failed' | 'done', by: typeof demoAdmin, extra: object) => {
  const e = eps[i]!;
  return db.jobs.insert({ type: 'transcript', episodeId: e.id, podcastId: e.podcastId, status, stage: null, progress: null, error: null, requestedBy: by.id, attachedUsers: [by.id], source: null, audioSeconds: e.durationSec, createdAt: now - 2 * H + i * 1000, startedAt: null, finishedAt: null, durationMs: null, ...extra });
};
job(0, 'running', maya, { startedAt: now - 108_000, stage: 'Transcribing', progress: 62 });
job(1, 'queued', demoAdmin, {});
job(2, 'queued', priya, {});
job(9, 'failed', dana, { error: 'Audio download timed out after 60 s', finishedAt: new Date().setHours(9, 12, 0, 0), durationMs: 60000, createdAt: now - 4 * H });
job(10, 'done', eli, { source: 'whisper', finishedAt: now - 5 * H, startedAt: now - 5 * H - 125_000, durationMs: 125_000, createdAt: now - 6 * H });
job(11, 'done', demoAdmin, { source: 'feed', finishedAt: now - 7 * H, startedAt: now - 7 * H, durationMs: 300, createdAt: now - 7 * H });
for (let i = 0; i < 8; i++) job(12 + (i % 6), 'done', maya, { source: 'whisper', finishedAt: now - (8 + i) * H, startedAt: now - (8 + i) * H - 90_000, durationMs: 90_000, createdAt: now - (9 + i) * H });

// 30 days of usage, a typical month of traffic.
const audio = [1.4, 1.2, 1.9, 1.7, 1.5, 2.4, 2.7, 1.3, 1.1, 1.6, 1.5, 1.4, 2.6, 2.8, 1.2, 1.0, 1.8, 1.6, 1.4, 2.5, 2.9, 1.3, 1.1, 1.7, 1.5, 1.3, 2.2, 2.6, 1.2, 1.8];
const trans = [0.2, 0.3, 0.5, 0.4, 0.3, 0.6, 0.8, 0.3, 0.2, 0.4, 0.3, 0.5, 0.7, 0.9, 0.2, 0.3, 0.4, 0.3, 0.6, 0.5, 0.8, 0.3, 0.2, 0.5, 0.4, 0.3, 0.7, 0.6, 0.3, 0.4];
const shares = [[maya, 0.33], [demoAdmin, 0.31], [priya, 0.18], [eli, 0.1], [dana, 0.04]] as const;
const sumA = audio.reduce((a, b) => a + b, 0);
const sumT = trans.reduce((a, b) => a + b, 0);
audio.forEach((a, i) => {
  const day = dayKey(now - (29 - i) * D);
  for (const [u, share] of shares) {
    db.usageStats.insert({ key: `${u.id}|${day}`, userId: u.id, day, proxyBytes: Math.round(((a * 48.2) / sumA) * 1e9 * share), feedBytes: Math.round((0.1 * 1e9) * share), transcribeBytes: Math.round(((trans[i]! * 12.7) / sumT) * 1e9 * share), transcriptMinutes: Math.round(65 * share) });
  }
});

const log = (minsAgo: number, p: { actor?: typeof demoAdmin; actorName?: string; action: string; target?: string; label?: string; ip?: string; detail?: string }) =>
  db.auditLog.insert({ at: now - minsAgo * 60_000, actorId: p.actor?.id ?? null, actorName: p.actor?.username ?? p.actorName ?? null, action: p.action, target: p.target ?? null, targetLabel: p.label ?? null, ip: p.ip ?? null, detail: p.detail ?? null });
log(120, { actor: demoAdmin, action: 'invite.create', label: 'inv_7Hk…' });
log(180, { actor: maya, action: 'login.success', detail: 'Pixel 9' });
log(300, { actorName: 'admin', action: 'login.failed', ip: '203.0.113.9', detail: '4 attempts, locked 15 min' });
log(24 * 60, { actor: eli, action: 'job.done', label: 'Ep. 211' });
const t = new Date();
t.setHours(3, 0, 0, 0);
db.auditLog.insert({ at: t.getTime(), actorId: null, actorName: null, action: 'backup.completed', target: null, targetLabel: null, ip: null, detail: String(84_000_000) });

const mkInvite = (code: string, expiresIn: number, usedBy?: typeof demoAdmin) =>
  db.invites.insert({ codeHash: sha256(code), codePrefix: code.slice(0, 7) + '…', createdBy: demoAdmin.id, createdAt: now - 3 * D, expiresAt: now + expiresIn, usedBy: usedBy?.id ?? null, usedAt: usedBy ? now - 2 * D : null, revokedAt: null });
mkInvite('inv_7Hk0000000', 6 * D);
mkInvite('inv_9Lm0000000', 2 * D, dana);
mkInvite('inv_2Qd0000000', -3 * D);

new SettingsService(db, config).recordBackup(t.getTime(), 84_000_000);
db.snapshot(config.dataDir);
await db.save();
await db.close();
console.log(`Seeded ${config.dataDir}. Sign in as demo / demo-password-123`);
