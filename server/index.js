// Edulet server entry. `createApp()` is also what the tests use; `npm start` runs it directly.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Context, HttpError, RateLimiter, Router, sendJson, sendText } from './http.js';
import { authenticate, hashPassword, registerAuth } from './auth.js';
import { googleEnabled, registerGoogle } from './google.js';
import { Hub } from './realtime.js';
import { registerBoards } from './boards.js';
import { registerSections } from './sections.js';
import { registerPosts } from './posts.js';
import { registerComments } from './comments.js';
import { registerReactions } from './reactions.js';
import { registerUploads } from './uploads.js';
import { registerBackups } from './backups.js';
import { PreviewService, registerPreview } from './preview.js';
import { defaultNetworkInterfaces, localOperator, shareInfo, startupLanLine } from './share.js';
import { serveStatic } from './static.js';
import { loadSeedSpecs, runSeed } from './seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  'frame-src https://www.youtube-nocookie.com https://player.vimeo.com',
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

function readVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

function sendError(app, req, res, err) {
  let status = 500;
  let body = { error: { code: 'server_error', message: '서버에서 문제가 생겼어요. 잠시 뒤에 다시 해 주세요.' } };
  let headers;
  if (err instanceof HttpError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message } };
    headers = err.headers;
  } else if (!app.quiet) {
    // the Google callback's query holds a one-time code and the state: keep them out of the log
    let where = req.url;
    try {
      const path = new URL(req.url, 'http://localhost').pathname; // "/api/auth/./google/callback" is the callback too
      if (path.startsWith('/api/auth/')) where = path;
    } catch { /* keep the raw url */ }
    console.error(`[edulet] ${req.method} ${where}`, err);
  }
  if (res.headersSent) { res.destroy(); return; }
  sendJson(res, status, body, headers);
}

function sameOrigin(app, req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  const want = new Set([String(req.headers.host || '').toLowerCase()]);
  if (app.config.trustProxy && req.headers['x-forwarded-host']) {
    for (const h of String(req.headers['x-forwarded-host']).split(',')) want.add(h.trim().toLowerCase());
  }
  return want.has(host);
}

async function handleApi(app, req, res, url) {
  const m = app.router.match(req.method, url.pathname.slice(4) || '/');
  if (!m) return sendJson(res, 404, { error: { code: 'not_found', message: '없는 주소예요.' } });
  if (m.methodNotAllowed) return sendJson(res, 405, { error: { code: 'method_not_allowed', message: '허용되지 않는 요청이에요.' } });
  // 점검 모드(저장본을 불러오는 동안, CONTRACT §5): reads and event streams carry on, every change waits. This comes before authenticate()
  // (which may delete an expired session row) and before any permission check, so nothing writes to the database while it is being replaced.
  // /api/backups* is not held up here: it meets the mutex instead (a second restore gets 409 `busy`).
  // (`GET /api/auth/google/*` is a GET that writes — it creates users and sessions — so it waits too.)
  if (app.maintenance && !/^\/api\/backups(?:\/|$)/.test(url.pathname)
    && ((req.method !== 'GET' && req.method !== 'HEAD') || /^\/api\/auth\/google(?:\/|$)/.test(url.pathname))) {
    throw new HttpError(503, 'busy', '지금 저장본을 불러오는 중이에요. 잠시 뒤에 다시 해 주세요.', { 'Retry-After': '3' });
  }
  const c = new Context(app, req, res, url, m.params);
  const session = authenticate(app, req);
  if (session) { c.user = session.user; c.tokenHash = session.tokenHash; }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(app, req)) {
    throw new HttpError(403, 'bad_origin', '허용되지 않는 출처의 요청이에요.');
  }
  const out = await m.handler(c);
  if (!c.done && !res.headersSent && out !== undefined) sendJson(res, 200, out);
}

async function dispatch(app, req, res) {
  securityHeaders(res);
  let url;
  try {
    if (!req.url || req.url[0] !== '/') throw new Error('bad url');
    url = new URL('http://localhost' + req.url);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  const p = url.pathname;
  try {
    if (p === '/api' || p.startsWith('/api/')) return await handleApi(app, req, res, url);
    if (p.startsWith('/uploads/')) return await app.serveUpload(req, res, p);
    return await serveStatic(app, req, res, p);
  } catch (err) {
    sendError(app, req, res, err);
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir] @param {number} [opts.port] @param {string} [opts.host]
 * @param {boolean|string|number} [opts.seed] auto | on | off
 * Internal / test-only (never read from env or HTTP): config, quiet, publicDir, seedDir, authRateLimit, pingMs, presenceMinMs,
 * allowPrivatePreviewHosts (true | ['host:port']), previewFetcher, previewDnsLookup, previewLimits, uploadIdleMs, uploadGcMaxAgeMs,
 * googleEndpoints ({ auth, token, timeoutMs, exchangesPerMinute } — a stand-in for Google's two OAuth addresses),
 * networkInterfaces (a function shaped like os.networkInterfaces — fake NICs for the `share.lan` list of GET /config),
 * backupHooks ({ afterValidate({copy}), afterStage(), afterSafetySave(n) } — async functions server/restore.js awaits between its steps, so a
 * test can write to the database or hold the restore at that point; CONTRACT §5 "저장하기·불러오기").
 * `backupDir` (also EDULET_BACKUP_DIR) is where 저장하기 writes and 불러오기 reads (default: backups/ in the repository root) — tests always pass a temp folder.
 */
export async function createApp(opts = {}) {
  const config = loadConfig(opts);
  fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
  const db = openDb(path.join(config.dataDir, 'edulet.db'));

  const app = {
    config,
    db,
    router: new Router(),
    rate: new RateLimiter(),
    authRateLimit: opts.authRateLimit ?? 20,
    quiet: !!opts.quiet,
    version: readVersion(),
    publicDir: path.resolve(opts.publicDir ?? path.join(ROOT, 'public')),
    seedDir: path.resolve(opts.seedDir ?? path.join(ROOT, 'seed')),
    hub: null,
    preview: null,
    serveUpload: null,
    uploadIdleMs: opts.uploadIdleMs, // test-only: how long an upload body may stall (default 30 s)
    googleEndpoints: opts.googleEndpoints ?? null, // test-only: where "Google" lives (default: the real accounts.google.com / oauth2.googleapis.com)
    networkInterfaces: typeof opts.networkInterfaces === 'function' ? opts.networkInterfaces : defaultNetworkInterfaces, // test-only: this machine's NICs
    backupBusy: false, // mutex: one 저장하기 / 불러오기 at a time (server/backups.js)
    maintenance: false, // true while a restore replaces the data: changing /api requests get 503 (handleApi), the timers below rest
    backupHooks: opts.backupHooks ?? null, // test-only: see the createApp doc above
  };
  app.hub = new Hub(app, { pingMs: opts.pingMs ?? 25000, presenceMinMs: opts.presenceMinMs ?? 1000 });
  app.preview = new PreviewService({
    enabled: config.linkPreview,
    allowPrivate: opts.allowPrivatePreviewHosts ?? false,
    fetcher: opts.previewFetcher ?? null,
    timeoutMs: opts.previewTimeoutMs ?? 5000,
    dnsLookup: opts.previewDnsLookup ?? undefined,
    ...(opts.previewLimits ?? {}),
  });

  app.router.add('GET', '/health', async () => ({ ok: true }));
  app.router.add('GET', '/config', async (c) => ({
    allowRegister: config.allowRegister,
    maxUploadMb: config.maxUploadMb,
    linkPreview: config.linkPreview,
    google: googleEnabled(app),
    googleDomains: googleEnabled(app) ? config.googleDomains : [],
    share: shareInfo(app, c.req),
    backup: { available: localOperator(app, c.req) }, // the 저장하기·불러오기 menu is for the person at the server PC only (server/backups.js)
    version: app.version,
  }));
  registerAuth(app);
  registerGoogle(app);
  registerBoards(app);
  registerSections(app);
  registerPosts(app);
  registerComments(app);
  registerReactions(app);
  registerUploads(app);
  registerPreview(app);
  registerBackups(app);

  await hashPassword('warm-up'); // primes the scrypt thread pool so the first login is not slower than the rest
  db.run('DELETE FROM sessions WHERE expires_at <= ?', Date.now());
  // both housekeeping jobs rest while a restore replaces the data (app.maintenance) — they write to the database; exposed on `app` for the tests
  app.sweepSessions = () => { if (!app.maintenance) db.run('DELETE FROM sessions WHERE expires_at <= ?', Date.now()); };
  const sweeper = setInterval(app.sweepSessions, 3600000);
  sweeper.unref();

  const seeded = runSeed(app, { mode: config.seed, dir: app.seedDir });

  // Orphaned uploads (never attached, or whose post is gone) are removed after 24 h — on start and every 6 h.
  const gcOpts = opts.uploadGcMaxAgeMs != null ? { maxAgeMs: opts.uploadGcMaxAgeMs } : {};
  const runGc = app.runGc = () => { if (app.maintenance) return; try { app.gcUploads(gcOpts); } catch (e) { if (!app.quiet) console.error('[edulet] upload gc failed', e); } };
  runGc();
  const gcTimer = setInterval(runGc, 6 * 3600000);
  gcTimer.unref();

  const server = http.createServer((req, res) => { dispatch(app, req, res); });
  server.maxConnections = config.maxConnections;
  // explicit instead of node's defaults: slow-header clients are dropped early, a request (an upload at most) gets 10 minutes
  server.headersTimeout = 20000;
  server.requestTimeout = 600000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const port = server.address().port;
  const hostName = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const url = `http://${hostName}:${port}`;

  let closed = false;
  return {
    url,
    port,
    db,
    app,
    server,
    seeded,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      clearInterval(gcTimer);
      app.hub.closeAll();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(fileURLToPath(import.meta.url));
  const b = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

/** What `npm start` prints: the local address, the LAN hint (when the server is reachable beyond this PC), the seed boards. */
export function announce(running, log = console.log) {
  log(`Edulet is running at ${running.url}`);
  const lan = startupLanLine(running.app, running.port);
  if (lan) log(lan);
  const slugs = loadSeedSpecs(running.app.seedDir).map((s) => s.spec.board.slug);
  for (const slug of slugs) {
    if (running.db.get('SELECT 1 AS x FROM boards WHERE slug = ?', slug)) log(`  ${running.url}/b/${slug}`);
  }
}

if (isMain) {
  const running = await createApp();
  announce(running);
  const stop = async () => { await running.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
