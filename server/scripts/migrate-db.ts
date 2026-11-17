/**
 * Copies a Homecast database from one storage engine to another.
 *
 *   npx tsx scripts/migrate-db.ts --data-dir ./data --to docstore
 *   npx tsx scripts/migrate-db.ts --data-dir ./data --from sqlite --to loki
 *
 * Stop the server first. The source is left untouched, and the destination must not exist: the script refuses to
 * overwrite a database. `--from` defaults to whichever other engine has a database in the data directory. The server also
 * imports another engine's database by itself the first time it starts on a new SQLite or docstore database, so this is
 * mainly for going back, or for doing the copy ahead of time.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { copyDatabase, Database, ENGINES, localPath, type EngineName } from '../src/db/index.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = path.resolve(opt('data-dir') ?? process.env.DATA_DIR ?? './data');
const to = opt('to') as EngineName | undefined;
if (!to || !ENGINES.includes(to)) {
  console.error(`Usage: migrate-db.ts --data-dir <dir> [--from <engine>] --to <${ENGINES.join('|')}>`);
  process.exit(2);
}
const from = (opt('from') as EngineName | undefined) ?? ENGINES.find((e) => e !== to && existsSync(localPath(e, dataDir)));
if (!from || !ENGINES.includes(from) || from === to) {
  console.error(`Could not tell which database to copy from. Pass --from <${ENGINES.filter((e) => e !== to).join('|')}>.`);
  process.exit(2);
}
if (!existsSync(localPath(from, dataDir))) {
  console.error(`No ${from} database found at ${localPath(from, dataDir)}`);
  process.exit(1);
}
if (existsSync(localPath(to, dataDir))) {
  console.error(`${localPath(to, dataDir)} already exists. Move it away first if you want to replace it.`);
  process.exit(1);
}

const open = (engine: EngineName) => Database.open({ dataDir, engine, autosaveMs: 0, noImport: true });
const src = await open(from);
const dst = await open(to);
const n = copyDatabase(src, dst);
await dst.save();
await src.close();
await dst.close();
console.log(`Copied ${n} records from ${from} to ${to}. Start the server with DB_ENGINE=${to}.`);
