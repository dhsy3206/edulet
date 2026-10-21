// Node 22 resolves `node --test test/` as a module path (it is no longer a directory walk), so this entry
// makes the documented command (`npm test`) work: it simply loads every *.test.js in this folder, in order.
// Running a single file directly (`node --test test/auth.test.js`) works too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.js')).sort()) {
  await import(pathToFileURL(path.join(dir, f)).href);
}
