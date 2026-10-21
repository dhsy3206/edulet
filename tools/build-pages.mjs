// Builds the static "demo mode" site for GitHub Pages into dist/.
//   node tools/build-pages.mjs [--base /edulet] [--out dist]
// GitHub Pages only serves files, so the Node server cannot run there. In this build a service worker
// (public/edulet-sw.js) plays the server and the data lives in the visitor's browser (see README "데모 모드").
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const base = arg('base', '/edulet').replace(/\/+$/, '');
const out = resolve(root, arg('out', 'dist'));
if (base && !/^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(base)) throw new Error('--base must look like /edulet');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. the app (everything the Node server would serve), minus dev leftovers
cpSync(join(root, 'public'), out, { recursive: true, filter: (p) => !/[\\/](_dev|\.DS_Store)([\\/]|$)/.test(p) });

// 2. seed boards + their images, read by the service worker on first start
mkdirSync(join(out, 'seed'), { recursive: true });
for (const f of readdirSync(join(root, 'seed'))) {
  const p = join(root, 'seed', f);
  if (f.endsWith('.json')) cpSync(p, join(out, 'seed', f));
}
cpSync(join(root, 'seed', 'img'), join(out, 'seed', 'img'), { recursive: true });

// 3. index.html: relative asset URLs under <base>, demo bootstrap before the app, CSP (Pages cannot send headers)
let html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
html = html.replace(/(href|src)="\/(?!\/)/g, '$1="');
const csp = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", "media-src 'self' blob: https:",
  'frame-src https://www.youtube-nocookie.com https://player.vimeo.com',
  "connect-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
].join('; ');
const headInject = `\n  <base href="${base}/">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`;
// <meta charset> has to stay within the first 1024 bytes, so the injected tags go right after it
const anchor = /<meta charset="[^"]*">/i.test(html) ? /<meta charset="[^"]*">/i : /<head[^>]*>/i;
if (!anchor.test(html)) throw new Error('index.html has no <head>');
html = html.replace(anchor, (m) => m + headInject);
const moduleTag = /<script type="module" src="js\/main\.js"><\/script>/;
if (!moduleTag.test(html)) throw new Error('index.html: module script tag not found (expected src="/js/main.js")');
html = html.replace(moduleTag, (m) => `<script src="demo/boot.js"></script>\n  ${m}`);
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, '404.html'), html); // deep links (/edulet/b/practice) land here on Pages and boot the same app
writeFileSync(join(out, '.nojekyll'), '');

// 4. build info
let commit = process.env.GITHUB_SHA || '';
if (!commit) {
  try {
    commit = execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    commit = 'unknown';
  }
}
writeFileSync(join(out, 'build-info.json'), JSON.stringify({ commit, builtAt: new Date().toISOString(), base, mode: 'demo' }, null, 2) + '\n');

// 5. summary
let files = 0, bytes = 0;
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else { files++; bytes += s.size; }
  }
})(out);
const missing = ['demo/boot.js', 'edulet-sw.js'].filter((f) => !existsSync(join(out, f)));
console.log(`built ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${out}  (base "${base}")`);
if (missing.length) {
  console.error('WARNING: missing ' + missing.join(', ') + ' — the demo cannot start without them');
  process.exitCode = 1;
}
