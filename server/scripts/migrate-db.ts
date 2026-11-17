/**
 * Copies a Homecast database from one storage engine to the other.
 *
 *   npx tsx scripts/migrate-db.ts --data-dir ./data --to sqlite
 *   npx tsx scripts/migrate-db.ts --data-dir ./data --to loki
 *
 * Stop the server first. The source file is left untouched. It refuses to overwrite an existing destination
 * database. The server also imports the JSON database by itself the first time it starts with DB_ENGINE=sqlite,
 * so this is mainly for going back, or for doing the copy ahead of time.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { copyDatabase, Database, type EngineName } from '../src/db/index.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = path.resolve(opt('data-dir') ?? process.env.DATA_DIR ?? './data');
const to = opt('to') as EngineName | undefined;
if (to !== 'loki' && to !== 'sqlite') {
  console.error('Usage: migrate-db.ts --data-dir <dir> --to <loki|sqlite>');
  process.exit(2);
}
const from: EngineName = to === 'sqlite' ? 'loki' : 'sqlite';
const files = { loki: path.join(dataDir, 'homecast.db.json'), sqlite: path.join(dataDir, 'homecast.db.sqlite') };

if (!existsSync(files[from])) {
  console.error(`No ${from} database found at ${files[from]}`);
  process.exit(1);
}
if (existsSync(files[to])) {
  console.error(`${files[to]} already exists. Move it away first if you want to replace it.`);
  process.exit(1);
}

const total = (db: Database) => [...db.collections.values()].reduce((a, r) => a + r.count(), 0);
let n: number;
if (to === 'sqlite') {
  // Opening a fresh SQLite database next to a JSON one imports it (see Database.open).
  const dst = await Database.open({ dataDir, engine: 'sqlite' });
  n = total(dst);
  await dst.save();
  await dst.close();
} else {
  const src = await Database.open({ dataDir, engine: 'sqlite' });
  const dst = await Database.open({ dataDir, engine: 'loki', autosaveMs: 0 });
  n = copyDatabase(src, dst);
  await dst.save();
  await src.close();
  await dst.close();
}
console.log(`Copied ${n} records from ${files[from]} to ${files[to]}. Start the server with DB_ENGINE=${to}.`);
