// node server/seed-cli.js [--reset-demo]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { loadSeedSpecs, resetDemo, runSeed } from './seed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedDir = path.join(root, 'seed');
const reset = process.argv.includes('--reset-demo');

const config = loadConfig({});
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
const db = openDb(path.join(config.dataDir, 'edulet.db'));
const app = { config, db };
try {
  if (reset) resetDemo(app, seedDir);
  const results = runSeed(app, { mode: 'on', dir: seedDir });
  if (!loadSeedSpecs(seedDir).length) console.log(`No seed files found in ${seedDir}`);
  const base = `http://localhost:${config.port}`;
  for (const r of results) console.log(`${r.created ? 'created' : 'exists '}  ${base}/b/${r.slug}`);
} finally {
  db.close();
}
