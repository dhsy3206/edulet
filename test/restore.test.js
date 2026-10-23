// 저장하기 / 불러오기 (server/backups.js, server/restore.js, CONTRACT §5). Hermetic: temp data folders, temp backup folders, random good ports —
// nothing here looks at the real ./data or ./backups folder or at port 3000 (startApp gives every server a temp backupDir).
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, PNG, makeBoard, makePost, makeUser, openSse, startApp } from './helpers.js';
import { createSession } from '../server/auth.js';
import { sha256 } from '../server/util.js';
import { backupData } from '../server/backup.js';
import { SCHEMA_VERSION, openDb } from '../server/db.js';
import { disposeCopy, prepareCopy, scrubPaths, swapDatabase } from '../server/restore.js';
import { localOperator } from '../server/share.js';

const { DatabaseSync } = await import('node:sqlite');
const SERVER_DIR = fileURLToPath(new URL('../server', import.meta.url));

// ---- helpers --------------------------------------------------------------------------------------------------------

const made = [];
/** A new temp folder (Korean + a space in the name on purpose). */
function tmpDir(label = 'x') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `edulet-rs 복원-${label}-`));
  made.push(d);
  return d;
}
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

const names = (d) => fs.readdirSync(d).sort();
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Every entry below `root` with size + sha256 of every file: equal before/after = not changed by a single byte, nothing added (no -wal/-shm). */
function treeOf(root) {
  const out = {};
  const walk = (dir, rel) => {
    out[rel || '.'] = { dir: fs.readdirSync(dir).sort() };
    for (const n of fs.readdirSync(dir)) {
      const full = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else out[r] = { size: fs.statSync(full).size, sha: sha(full) };
    }
  };
  walk(root, '');
  return out;
}

/** A request with a Host header and extra headers of our choosing (fetch() does not let you set Host, and normalises odd paths). */
function rawRequest(running, method, urlPath, { host, headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: host ?? `127.0.0.1:${running.port}`, ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: running.port, method, path: urlPath, headers: h }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const withTimeout = (p, ms = 8000, what = 'a promise') => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), ms))]);

const putFile = (c, slug, name, body, type) =>
  c.put(`/api/uploads?board=${slug}&name=${encodeURIComponent(name)}`, body, { raw: true, headers: { 'content-type': type } });

/** Everything a restore must put back exactly (ids included). */
const digest = (r) => JSON.stringify({
  users: r.db.all('SELECT id, username, display_name, is_guest, created_at, google_sub FROM users ORDER BY id'),
  boards: r.db.all('SELECT id, slug, title, owner_id, updated_at FROM boards ORDER BY id'),
  members: r.db.all('SELECT * FROM board_members ORDER BY board_id, user_id'),
  sections: r.db.all('SELECT * FROM sections ORDER BY id'),
  posts: r.db.all('SELECT id, board_id, title, body, att_url FROM posts ORDER BY id'),
  comments: r.db.all('SELECT * FROM comments ORDER BY id'),
  reactions: r.db.all('SELECT * FROM reactions ORDER BY post_id, user_id, key'),
  uploads: r.db.all('SELECT id, name, size FROM uploads ORDER BY id'),
});
const counts = (r) => ({
  boards: r.db.get('SELECT COUNT(*) AS n FROM boards').n,
  posts: r.db.get('SELECT COUNT(*) AS n FROM posts').n,
  users: r.db.get('SELECT COUNT(*) AS n FROM users').n,
});

const freshLimits = (r) => r.app.rate.m.clear();

/** No folder of this machine in an answer. JSON doubles every backslash, so the escaped form is looked for as well (the plain form alone would never match). */
function assertNoPaths(app, text, label = 'the answer') {
  for (const p of [app.dir, app.backupDir, os.tmpdir(), 'C:\\Users']) {
    assert.ok(!text.includes(p) && !text.includes(JSON.stringify(p).slice(1, -1)), `${label} leaks ${p}: ${text.slice(0, 240)}`);
  }
}

/** A server with a teacher, two boards, three posts (one with a photo), a comment, a reaction and a second user. */
async function scenario(opts = {}) {
  const app = await startApp({ config: { writeRateMax: 100000, uploadRateMax: 100000 }, ...opts });
  const owner = makeUser(app, 'teacher');
  makeUser(app, 'student');
  const board = await makeBoard(owner, { title: '수업 보드' });
  const board2 = await makeBoard(owner, { title: '두 번째 보드' });
  const up = (await putFile(owner, board.slug, '사진.png', PNG, 'image/png')).json;
  assert.ok(up?.id, 'fixture upload');
  const p1 = await makePost(owner, board, { title: '사진 글', body: '하나', attachment: { kind: 'image', uploadId: up.id } });
  const p2 = await makePost(owner, board, { title: '둘째 글' });
  const p3 = await makePost(owner, board2, { title: '다른 보드의 글' });
  assert.equal((await owner.post(`/api/posts/${p1.id}/comments`, { body: '첫 댓글' })).status, 201);
  assert.equal((await owner.put(`/api/posts/${p2.id}/reactions`, { kind: 'like' })).status, 200);
  return { app, owner, board, board2, up, p1, p2, p3 };
}

async function save(app, owner) {
  freshLimits(app);
  const r = await owner.post('/api/backups');
  assert.equal(r.status, 201, r.text);
  return r.json.item;
}
async function restore(app, owner, id) {
  freshLimits(app);
  return owner.post(`/api/backups/${id}/restore`, { confirm: true });
}

/** Do the kind of damage a day of teaching does: another post, a deleted photo post, a deleted board, an id handed out and deleted again. */
async function messUp(s) {
  assert.equal((await s.owner.del(`/api/posts/${s.p1.id}`)).status, 200); // its photo row + file go away at once
  assert.equal((await s.owner.del(`/api/boards/${s.board2.slug}`)).status, 200);
  await makePost(s.owner, s.board, { title: '저장 뒤에 쓴 글' });
  const gone = await makePost(s.owner, s.board, { title: '쓰고 지운 글' });
  assert.equal((await s.owner.del(`/api/posts/${gone.id}`)).status, 200);
  return gone.id;
}

/** Open a backup's database in place (test SETUP only — before any server reads it), run `fn`, close. */
function editBackup(dir, fn) {
  const db = new DatabaseSync(path.join(dir, 'edulet.db'));
  try { fn(db); } finally { db.close(); }
}
const backupPath = (app, id) => path.join(app.backupDir, id);

/** A copy of the finished backup folder under another valid name (a crafted variant). */
function clone(app, id, name) {
  fs.cpSync(backupPath(app, id), path.join(app.backupDir, name), { recursive: true });
  return name;
}

/** Hold the next restore at one of its steps; `reached` resolves when it gets there, `release()` lets it go on. */
function holdAt(app, step) {
  let release;
  let entered;
  const gate = new Promise((r) => { release = r; });
  const reached = new Promise((r) => { entered = r; });
  app.app.backupHooks = { [step]: async () => { entered(); await gate; } };
  return { reached, release };
}
const clearHooks = (app) => { app.app.backupHooks = null; };

// ---- the gate -------------------------------------------------------------------------------------------------------

describe('저장하기·불러오기: the gate', () => {
  let s;
  let bk;
  before(async () => { s = await scenario(); bk = (await save(s.app, s.owner)).id; });
  after(async () => { await s.app.close(); });

  const ENDPOINTS = () => [
    ['GET', '/api/backups'],
    ['GET', `/api/backups/${bk}`],
    ['POST', '/api/backups', {}],
    ['POST', `/api/backups/${bk}/restore`, { confirm: true }],
  ];

  it('GET /config tells backup.available to the server PC only', async () => {
    assert.deepEqual((await s.owner.get('/api/config')).json.backup, { available: true });
    const cases = [
      ['another host name', { host: 'school.example.com' }],
      ['a LAN address as host', { host: '192.168.0.5:3000' }],
      ['look-alike host', { host: 'localhost.evil.com' }],
      ['X-Forwarded-For (a proxy in front)', { headers: { 'x-forwarded-for': '203.0.113.9' } }],
      ['Forwarded', { headers: { forwarded: 'for=203.0.113.9' } }],
      ['Via', { headers: { via: '1.1 proxy' } }],
      ['CF-Connecting-IP', { headers: { 'cf-connecting-ip': '203.0.113.9' } }],
    ];
    for (const [label, o] of cases) assert.deepEqual((await rawRequest(s.app, 'GET', '/api/config', o)).json.backup, { available: false }, label);
    s.app.app.config.publicUrl = 'https://edulet.example.com';
    try {
      assert.deepEqual((await s.owner.get('/api/config')).json.backup, { available: false }, 'a public address is configured: the menu is off, even on this PC');
    } finally { s.app.app.config.publicUrl = ''; }
    s.app.app.config.publicUrl = 'http://localhost:3000'; // names this PC itself (a way to try Google sign-in): not a public address
    try { assert.deepEqual((await s.owner.get('/api/config')).json.backup, { available: true }); } finally { s.app.app.config.publicUrl = ''; }
  });

  it('localOperator: a spoofed "Host: localhost" from a non-loopback address is refused (unit level, the address is the truth)', () => {
    const req = (remote, headers = {}) => ({ headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress: remote } });
    assert.equal(localOperator(s.app.app, req('127.0.0.1')), true);
    assert.equal(localOperator(s.app.app, req('::1')), true);
    assert.equal(localOperator(s.app.app, req('::ffff:127.0.0.1')), true);
    assert.equal(localOperator(s.app.app, req('192.168.0.9')), false);
    assert.equal(localOperator(s.app.app, req('203.0.113.9')), false);
    assert.equal(localOperator(s.app.app, req('127.0.0.1', { 'x-real-ip': '203.0.113.9' })), false);
    assert.equal(localOperator(s.app.app, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }), false, 'no Host header');
  });

  it('every endpoint answers 403 backup_local_only to anything but the server PC — even to a signed-in teacher — and changes nothing', async () => {
    const before = { names: names(s.app.backupDir), digest: digest(s.app), tree: treeOf(s.app.backupDir) };
    const variants = [
      { host: 'school.example.com' },
      { host: '192.168.0.5:3000' },
      { headers: { 'x-forwarded-for': '203.0.113.9' } },
    ];
    for (const v of variants) {
      for (const [method, url, body] of ENDPOINTS()) {
        for (const cookie of [s.owner.cookie, undefined]) {
          const r = await rawRequest(s.app, method, url, { ...v, body, cookie });
          assert.equal(r.status, 403, `${method} ${url} ${JSON.stringify(v)}`);
          assert.equal(r.json.error.code, 'backup_local_only');
          assert.match(r.json.error.message, /서버를 켠 PC/);
        }
      }
    }
    s.app.app.config.publicUrl = 'https://edulet.example.com';
    try {
      for (const [method, url, body] of ENDPOINTS()) {
        const r = await rawRequest(s.app, method, url, { body, cookie: s.owner.cookie });
        assert.equal(r.json?.error?.code, 'backup_local_only', `PUBLIC_URL set: ${method} ${url}`);
      }
    } finally { s.app.app.config.publicUrl = ''; }
    assert.deepEqual(names(s.app.backupDir), before.names, 'nothing was created');
    assert.deepEqual(treeOf(s.app.backupDir), before.tree);
    assert.equal(digest(s.app), before.digest, 'nothing was restored');
  });

  it('with a teacher account in the database only a signed-in teacher gets in: 403 member_required (never 401), guests included', async () => {
    const anon = new Client(s.app);
    const guest = new Client(s.app);
    assert.equal((await guest.guest('학생')).status, 201);
    const before = { names: names(s.app.backupDir), digest: digest(s.app) };
    for (const who of [anon, guest]) {
      for (const [method, url, body] of ENDPOINTS()) {
        const r = await who.req(method, url, body);
        assert.equal(r.status, 403, `${method} ${url}`);
        assert.equal(r.json.error.code, 'member_required');
        assert.match(r.json.error.message, /계정으로 로그인한 뒤에/);
        assert.ok(!/교사/.test(r.json.error.message), 'the rule is "a signed-up account", not "a teacher"');
      }
    }
    assert.deepEqual(names(s.app.backupDir), before.names);
    assert.equal(digest(s.app).includes('학생'), true, 'the guest still exists: nothing was replaced');
    assert.equal((await s.owner.get('/api/backups')).status, 200);
  });

  it('a request that is neither local nor signed in hears about the PC first', async () => {
    const r = await rawRequest(s.app, 'GET', '/api/backups', { host: 'school.example.com' });
    assert.equal(r.json.error.code, 'backup_local_only');
  });

  it('a server with no teacher account yet (a new PC) needs no sign-in — until one exists', async () => {
    const fresh = await startApp();
    try {
      const anon = new Client(fresh);
      const g = new Client(fresh);
      await g.guest('손님'); // guests do not count
      assert.equal((await anon.get('/api/backups')).status, 200);
      const saved = await anon.post('/api/backups');
      assert.equal(saved.status, 201, saved.text);
      makeUser(fresh, 'teacher');
      const r = await anon.get('/api/backups');
      assert.equal(r.status, 403);
      assert.equal(r.json.error.code, 'member_required');
    } finally { await fresh.close(); }
  });

  it('a new PC with the DEFAULT practice board is not account-free: the seeded owner counts, so a teacher signs up first (docs/server-mode.html §4 says so)', async () => {
    // every other test starts with seed:false; the real first start of a real new PC plants the practice board whose owner is a non-guest without a login
    const fresh = await startApp({ seed: 'auto' });
    try {
      assert.ok(fresh.db.get('SELECT 1 AS x FROM boards'), 'the practice board was planted');
      const anon = new Client(fresh);
      const r = await anon.get('/api/backups');
      assert.equal(r.status, 403);
      assert.equal(r.json.error.code, 'member_required');
      const reg = await anon.post('/api/auth/register', { username: 'teacher', password: 'password-123' });
      assert.equal(reg.status, 201, reg.text);
      assert.equal((await anon.get('/api/backups')).status, 200, 'signed up and signed in: the list opens');
    } finally { await fresh.close(); }
  });

  it('a POST must come from the same origin (the existing check still applies)', async () => {
    const before = names(s.app.backupDir);
    for (const [url, body] of [['/api/backups', {}], [`/api/backups/${bk}/restore`, { confirm: true }]]) {
      const r = await s.owner.post(url, body, { headers: { origin: 'https://evil.example' } });
      assert.equal(r.status, 403, url);
      assert.equal(r.json.error.code, 'bad_origin');
    }
    assert.deepEqual(names(s.app.backupDir), before);
  });
});

// ---- the list -------------------------------------------------------------------------------------------------------

describe('저장하기·불러오기: GET /backups', () => {
  let s;
  before(async () => { s = await scenario(); });
  after(async () => { await s.app.close(); });
  beforeEach(() => { for (const n of fs.readdirSync(s.app.backupDir)) fs.rmSync(path.join(s.app.backupDir, n), { recursive: true, force: true }); });

  const list = async () => (await s.owner.get('/api/backups')).json;
  /** a finished backup of the live data made at a chosen wall-clock time */
  const backupAt = async (when) => path.basename((await backupData({ dataDir: s.app.dir, outDir: s.app.backupDir, now: when })).dir);
  /** a cheap extra folder that looks like `id` under another name: the big files are hard links (copied where the OS cannot link) */
  function lookalike(id, name, { withMeta = true } = {}) {
    const from = backupPath(s.app, id);
    const to = path.join(s.app.backupDir, name);
    fs.mkdirSync(path.join(to, 'uploads'), { recursive: true });
    for (const f of ['edulet.db', 'BACKUP-INFO.txt']) {
      try { fs.linkSync(path.join(from, f), path.join(to, f)); } catch { fs.copyFileSync(path.join(from, f), path.join(to, f)); }
    }
    if (withMeta) fs.copyFileSync(path.join(from, 'backup.json'), path.join(to, 'backup.json'));
    return name;
  }

  it('a missing or empty backup folder is an empty list, not an error; current describes the live data', async () => {
    const r = await s.owner.get('/api/backups');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items, []);
    assert.deepEqual(r.json.current, { ...counts(s.app), latestPostAt: s.app.db.get('SELECT MAX(created_at) AS n FROM posts').n });
    assert.equal(r.json.backupDirName, path.basename(s.app.backupDir));
    const real = s.app.app.config.backupDir;
    s.app.app.config.backupDir = path.join(tmpDir('nobody'), 'does-not-exist');
    try {
      const none = await s.owner.get('/api/backups');
      assert.equal(none.status, 200);
      assert.deepEqual(none.json.items, []);
      s.app.app.config.backupDir = path.join(real, 'nope', 'deeper');
      assert.deepEqual((await s.owner.get('/api/backups')).json.items, []);
    } finally { s.app.app.config.backupDir = real; }
  });

  it('item: id, createdAt, kind, dbBytes, uploadFiles, warnings, summary — from backup.json; and nothing absolute leaves the server', async () => {
    const when = new Date(2026, 0, 2, 3, 4, 5);
    const id = await backupAt(when);
    assert.equal(id, 'edulet-20260102-030405');
    const r = await s.owner.get('/api/backups');
    assert.equal(r.json.items.length, 1);
    const it1 = r.json.items[0];
    assert.deepEqual(Object.keys(it1).sort(), ['createdAt', 'dbBytes', 'id', 'kind', 'summary', 'uploadFiles', 'warnings']);
    assert.equal(it1.id, id);
    assert.equal(it1.createdAt, when.getTime());
    assert.equal(it1.kind, 'manual');
    assert.equal(it1.dbBytes, fs.statSync(path.join(backupPath(s.app, id), 'edulet.db')).size);
    assert.equal(it1.uploadFiles, 1);
    assert.equal(it1.warnings, 0);
    assert.deepEqual(it1.summary, { ...counts(s.app), latestPostAt: s.app.db.get('SELECT MAX(created_at) AS n FROM posts').n });
    assert.deepEqual(it1.summary, { boards: 2, posts: 3, users: 2, latestPostAt: it1.summary.latestPostAt });
    assertNoPaths(s.app, r.text, 'GET /backups');
  });

  it('an older backup (no backup.json) is listed too: createdAt from the folder name, summary read from a temp copy, the folder untouched', async () => {
    const when = new Date(2026, 0, 2, 3, 4, 5);
    const id = await backupAt(when);
    fs.rmSync(path.join(backupPath(s.app, id), 'backup.json'));
    const before = treeOf(backupPath(s.app, id));
    const r = await s.owner.get('/api/backups');
    const it1 = r.json.items[0];
    assert.equal(it1.id, id);
    assert.equal(it1.createdAt, when.getTime(), 'the wall-clock time in the name, as this PC reads it');
    assert.equal(it1.kind, 'manual');
    assert.equal(it1.uploadFiles, 1);
    assert.deepEqual(it1.summary, { boards: 2, posts: 3, users: 2, latestPostAt: s.app.db.get('SELECT MAX(created_at) AS n FROM posts').n });
    assert.deepEqual(treeOf(backupPath(s.app, id)), before, 'no -wal/-shm, not a byte changed: the database was only read from a copy');
  });

  it('an older backup that was unreadable has summary null (and is still listed); its BACKUP-INFO warnings are counted', async () => {
    const id = await backupAt(new Date(2026, 0, 2, 3, 4, 5));
    fs.rmSync(path.join(backupPath(s.app, id), 'backup.json'));
    const info = path.join(backupPath(s.app, id), 'BACKUP-INFO.txt');
    fs.writeFileSync(info, `${fs.readFileSync(info, 'utf8')}\r\n경고 (백업은 만들어졌지만 일부가 빠졌거나 확인이 필요해요)\r\n  - 하나\r\n  - 둘\r\n\r\n끝\r\n`);
    fs.writeFileSync(path.join(backupPath(s.app, id), 'edulet.db'), crypto.randomBytes(3000));
    const it1 = (await list()).items[0];
    assert.equal(it1.summary, null);
    assert.equal(it1.warnings, 2);
  });

  it('leaves out .partial folders, odd names, links and folders that are not complete backups — silently', async () => {
    const id = await backupAt(new Date(2026, 0, 2, 3, 4, 5));
    const dir = backupPath(s.app, id);
    const bad = [
      'edulet-20260102-030406.partial', 'edulet-1', 'edulet-20260102-030405x', 'edulet_20260102-030405', 'backup', ' edulet-20260102-030407', 'edulet-20260102-030408-',
    ];
    for (const n of bad) fs.cpSync(dir, path.join(s.app.backupDir, n), { recursive: true });
    fs.writeFileSync(path.join(s.app.backupDir, 'edulet-20260102-030409'), 'a file, not a folder');
    fs.cpSync(dir, path.join(s.app.backupDir, 'edulet-20260102-030410'), { recursive: true });
    fs.rmSync(path.join(s.app.backupDir, 'edulet-20260102-030410', 'BACKUP-INFO.txt'));
    fs.cpSync(dir, path.join(s.app.backupDir, 'edulet-20260102-030411'), { recursive: true });
    fs.rmSync(path.join(s.app.backupDir, 'edulet-20260102-030411', 'edulet.db'));
    fs.cpSync(dir, path.join(s.app.backupDir, 'edulet-20260102-030412'), { recursive: true });
    fs.rmSync(path.join(s.app.backupDir, 'edulet-20260102-030412', 'edulet.db'));
    fs.mkdirSync(path.join(s.app.backupDir, 'edulet-20260102-030412', 'edulet.db')); // a folder where the database should be
    let linked = true;
    try { fs.symlinkSync(dir, path.join(s.app.backupDir, 'edulet-20260102-030413'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
    fs.cpSync(dir, path.join(s.app.backupDir, 'edulet-20260102-030414'), { recursive: true });
    try {
      fs.rmSync(path.join(s.app.backupDir, 'edulet-20260102-030414', 'edulet.db'));
      fs.symlinkSync(path.join(dir, 'edulet.db'), path.join(s.app.backupDir, 'edulet-20260102-030414', 'edulet.db'), 'file');
    } catch { fs.rmSync(path.join(s.app.backupDir, 'edulet-20260102-030414'), { recursive: true, force: true }); } // no symlink right on this PC
    const r = await s.owner.get('/api/backups');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items.map((x) => x.id), [id], `only the real one (linked folder tried: ${linked})`);
    for (const n of [...bad, 'edulet-20260102-030409', 'edulet-20260102-030410', 'edulet-20260102-030411', 'edulet-20260102-030412', 'edulet-20260102-030413', 'edulet-20260102-030414']) {
      const p = await s.owner.get(`/api/backups/${encodeURIComponent(n)}`);
      assert.ok([400, 404].includes(p.status), `${n} cannot be previewed (${p.status})`);
      freshLimits(s.app);
      const q = await s.owner.post(`/api/backups/${encodeURIComponent(n)}/restore`, { confirm: true });
      assert.ok([400, 404].includes(q.status), `${n} cannot be restored (${q.status})`);
    }
  });

  it('newest first — by date-time, then by the -n suffix as a number (-10 is newer than -9) — and at most 200', async () => {
    const base = await backupAt(new Date(2025, 4, 5, 5, 5, 5));
    const ids = [base, lookalike(base, `${base}-2`), lookalike(base, `${base}-9`), lookalike(base, `${base}-10`)];
    const newer = lookalike(base, 'edulet-20260101-000000');
    const older = lookalike(base, 'edulet-20240101-000000');
    assert.deepEqual((await list()).items.map((x) => x.id), [newer, `${base}-10`, `${base}-9`, `${base}-2`, base, older]);
    assert.ok(ids.length === 4);
    for (let i = 0; i < 205; i++) {
      const t = new Date(2026, 5, 1, 0, 0, 0).getTime() + i * 1000;
      const d = new Date(t);
      const p2 = (n) => String(n).padStart(2, '0');
      lookalike(base, `edulet-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`);
    }
    const items = (await list()).items;
    assert.equal(items.length, 200);
    assert.equal(items[0].id, 'edulet-20260601-000324', 'the newest of the 205');
    assert.ok(items.every((x, i) => i === 0 || items[i - 1].id > x.id), 'strictly newest first');
  });

  it('older backups are opened at most 20 per request, and what was read is cached', async () => {
    const base = await backupAt(new Date(2025, 0, 1, 0, 0, 0));
    fs.rmSync(path.join(backupPath(s.app, base), 'backup.json'));
    for (let i = 1; i < 25; i++) lookalike(base, `edulet-20250101-00${String(i).padStart(2, '0')}00`, { withMeta: false });
    const first = (await list()).items;
    assert.equal(first.length, 25);
    assert.equal(first.filter((x) => x.summary !== null).length, 20, 'the allowance of one request');
    const second = (await list()).items;
    assert.equal(second.filter((x) => x.summary !== null).length, 25, 'the rest were read now; the first twenty came from the cache');
    assert.ok(second.every((x) => x.summary.posts === 3));
  });
});

// ---- the preview ----------------------------------------------------------------------------------------------------

describe('저장하기·불러오기: GET /backups/:id (preview)', () => {
  let s;
  let bk;
  before(async () => { s = await scenario(); bk = (await save(s.app, s.owner)).id; });
  after(async () => { await s.app.close(); });

  it('item, boards (title, posts, updatedAt — newest first), warnings [], newerThanApp false; the backup folder is not changed by a byte', async () => {
    const before = treeOf(backupPath(s.app, bk));
    const r = await s.owner.get(`/api/backups/${bk}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['boards', 'item', 'newerThanApp', 'warnings']);
    assert.equal(r.json.item.id, bk);
    assert.equal(r.json.newerThanApp, false);
    assert.deepEqual(r.json.warnings, []);
    const want = s.app.db.all('SELECT b.title, b.updated_at AS updatedAt, (SELECT COUNT(*) FROM posts p WHERE p.board_id = b.id) AS posts FROM boards b ORDER BY b.updated_at DESC, b.id DESC')
      .map((b) => ({ title: b.title, posts: b.posts, updatedAt: b.updatedAt }));
    assert.deepEqual(r.json.boards, want);
    assert.equal(r.json.boards.length, 2);
    assert.deepEqual(r.json.boards.map((b) => b.title).sort(), ['두 번째 보드', '수업 보드']);
    for (let i = 0; i < 3; i++) assert.equal((await s.owner.get(`/api/backups/${bk}`)).status, 200);
    assert.deepEqual(treeOf(backupPath(s.app, bk)), before, 'no -wal, no -shm, no journal: only a temp copy was opened');
    assertNoPaths(s.app, r.text, 'GET /backups/:id');
  });

  it('an unknown (but well-formed) id is 404 backup_not_found', async () => {
    const r = await s.owner.get('/api/backups/edulet-19990101-000000');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'backup_not_found');
  });

  // crafted variants: each is a copy of the good backup with one thing wrong in its database
  const BROKEN = [
    ['garbage instead of a database', (dir) => fs.writeFileSync(path.join(dir, 'edulet.db'), crypto.randomBytes(8192)), /읽을 수 없|손상/],
    ['an empty database file', (dir) => fs.writeFileSync(path.join(dir, 'edulet.db'), ''), /Edulet 의 저장본이 아니에요|읽을 수 없/],
    ['a truncated database', (dir) => { const f = path.join(dir, 'edulet.db'); fs.truncateSync(f, Math.floor(fs.statSync(f).size / 2)); }, /읽을 수 없|손상/],
    ['a damaged table page (integrity_check fails)', (dir) => {
      const f = path.join(dir, 'edulet.db');
      let root;
      let size;
      editBackup(dir, (db) => { root = Number(db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'posts'").get().rootpage); size = Number(db.prepare('PRAGMA page_size').get().page_size); });
      const buf = fs.readFileSync(f);
      buf.fill(0xff, (root - 1) * size + 8, root * size);
      fs.writeFileSync(f, buf);
    }, /손상|읽을 수 없/],
    ['a damaged index page that no query touches (only integrity_check sees it)', (dir) => {
      const f = path.join(dir, 'edulet.db');
      let root;
      let size;
      editBackup(dir, (db) => { root = Number(db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'idx_members_user'").get().rootpage); size = Number(db.prepare('PRAGMA page_size').get().page_size); });
      const buf = fs.readFileSync(f);
      buf[(root - 1) * size] = 0x00; // not a b-tree page type
      fs.writeFileSync(f, buf);
    }, /데이터베이스가 손상됐어요/],
    ['made by a NEWER Edulet (user_version beyond ours)', (dir) => editBackup(dir, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 96}`)), /더 새로운 Edulet/],
    ['no version at all', (dir) => editBackup(dir, (db) => db.exec('PRAGMA user_version = 0')), /저장본이 아니에요/],
    ['a required table is missing', (dir) => editBackup(dir, (db) => db.exec('DROP TABLE comments')), /'comments' 표가 없어요/],
    ['a required column is missing', (dir) => editBackup(dir, (db) => db.exec('ALTER TABLE posts DROP COLUMN pinned')), /'posts' 표에 'pinned' 열이 없어요/],
    ['a row pointing at nothing (foreign_key_check)', (dir) => editBackup(dir, (db) => db.exec("PRAGMA foreign_keys = OFF; INSERT INTO comments (post_id, author_id, body, created_at) VALUES (999999, 1, 'x', 1)")), /서로 맞지 않아요/],
  ];

  it('a backup that cannot be used is 422 backup_invalid with a one-line reason — preview and restore alike — and nothing changes anywhere', async () => {
    let n = 0;
    for (const [label, damage, reason] of BROKEN) {
      const id = `edulet-20250202-0000${String(++n).padStart(2, '0')}`;
      clone(s.app, bk, id);
      damage(backupPath(s.app, id));
      const before = { tree: treeOf(backupPath(s.app, id)), names: names(s.app.backupDir), digest: digest(s.app) };
      freshLimits(s.app);
      const p = await s.owner.get(`/api/backups/${id}`);
      assert.equal(p.status, 422, `${label}: ${p.text}`);
      assert.equal(p.json.error.code, 'backup_invalid', label);
      assert.match(p.json.error.message, reason, label);
      assert.ok(!/\n/.test(p.json.error.message) && !p.text.includes('at '), `${label}: one line, no stack`);
      freshLimits(s.app);
      const q = await s.owner.post(`/api/backups/${id}/restore`, { confirm: true });
      assert.equal(q.status, 422, `${label}: ${q.text}`);
      assert.equal(q.json.error.code, 'backup_invalid', label);
      assert.deepEqual(treeOf(backupPath(s.app, id)), before.tree, `${label}: the damaged backup was not touched either`);
      assert.deepEqual(names(s.app.backupDir), before.names, `${label}: no safety copy, nothing created`);
      assert.equal(digest(s.app), before.digest, `${label}: the live data is as it was`);
      assert.equal(s.app.app.maintenance, false, label);
      assert.equal(s.app.app.backupBusy, false, label);
    }
  });

  it('warnings of the check itself: a missing uploads folder / missing photo files / an older format', async () => {
    const noFolder = clone(s.app, bk, 'edulet-20250303-000001');
    fs.rmSync(path.join(backupPath(s.app, noFolder), 'uploads'), { recursive: true });
    const a = await s.owner.get(`/api/backups/${noFolder}`);
    assert.equal(a.status, 200);
    assert.equal(a.json.warnings.length, 1);
    assert.match(a.json.warnings[0], /uploads 폴더가 없어요/);

    const noFile = clone(s.app, bk, 'edulet-20250303-000002');
    for (const f of fs.readdirSync(path.join(backupPath(s.app, noFile), 'uploads'))) fs.rmSync(path.join(backupPath(s.app, noFile), 'uploads', f));
    const b = await s.owner.get(`/api/backups/${noFile}`);
    assert.equal(b.json.warnings.length, 1);
    assert.match(b.json.warnings[0], /사진·파일 1개가 저장본에 없어요/);
    assert.equal(b.json.item.uploadFiles, 1, 'the item still says what backup.json says');

    const v1 = clone(s.app, bk, 'edulet-20250303-000003');
    editBackup(backupPath(s.app, v1), (db) => db.exec('DROP INDEX idx_users_google_sub; ALTER TABLE users DROP COLUMN google_sub; ALTER TABLE users DROP COLUMN google_email; DROP INDEX idx_uploads_user; PRAGMA user_version = 1'));
    const before = treeOf(backupPath(s.app, v1));
    const c = await s.owner.get(`/api/backups/${v1}`);
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.warnings.length, 1);
    assert.match(c.json.warnings[0], /옛 형식\(데이터 형식 1\)/);
    assert.deepEqual(treeOf(backupPath(s.app, v1)), before, 'the older database was migrated on a COPY only');
  });

  it('the backup folder is only ever READ: a database in WAL mode that somebody else holds open is not touched by list, preview or restore (-wal/-shm included)', async () => {
    const id = clone(s.app, bk, 'edulet-20250808-000001');
    const dir = backupPath(s.app, id);
    fs.rmSync(path.join(dir, 'backup.json')); // an older backup: the list has to look inside it
    const holder = new DatabaseSync(path.join(dir, 'edulet.db'));
    try {
      holder.exec('PRAGMA journal_mode = WAL');
      holder.prepare('SELECT COUNT(*) FROM boards').get(); // -wal and -shm exist and stay (this connection is still open)
      const before = treeOf(dir);
      assert.ok(before['edulet.db-shm'] && before['edulet.db-wal'], 'precondition: the folder has -wal and -shm of its own');
      assert.equal((await s.owner.get('/api/backups')).json.items.find((x) => x.id === id).summary.posts, 3);
      assert.equal((await s.owner.get(`/api/backups/${id}`)).status, 200);
      freshLimits(s.app);
      assert.equal((await s.owner.post(`/api/backups/${id}/restore`, { confirm: true })).status, 200);
      assert.deepEqual(treeOf(dir), before, 'a SQLite connection of the server inside this folder would have moved -shm');
    } finally { holder.close(); }
  });

  it('nothing in the server opens the backup database in place: with another connection holding it EXCLUSIVELY (readers would get "locked"), list, preview and restore still work — they read a copy', async () => {
    const id = clone(s.app, bk, 'edulet-20250808-000002');
    const dir = backupPath(s.app, id);
    fs.rmSync(path.join(dir, 'backup.json')); // an older backup: the list has to look inside it
    const holder = new DatabaseSync(path.join(dir, 'edulet.db'));
    try {
      holder.exec('BEGIN EXCLUSIVE');
      const t0 = Date.now();
      const listed = (await s.owner.get('/api/backups')).json.items.find((x) => x.id === id);
      assert.deepEqual(listed.summary && listed.summary.posts, 3, 'the list could count it');
      assert.equal((await s.owner.get(`/api/backups/${id}`)).status, 200);
      freshLimits(s.app);
      assert.equal((await s.owner.post(`/api/backups/${id}/restore`, { confirm: true })).status, 200);
      assert.ok(Date.now() - t0 < 4000, 'and nobody waited for a lock');
    } finally { holder.exec('ROLLBACK'); holder.close(); }
  });

  it('a backup made by an older Edulet but without backup.json shows its counts in the preview item too', async () => {
    const old = clone(s.app, bk, 'edulet-20250304-000001');
    fs.rmSync(path.join(backupPath(s.app, old), 'backup.json'));
    const r = await s.owner.get(`/api/backups/${old}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.item.summary, { boards: 2, posts: 3, users: 2, latestPostAt: r.json.item.summary.latestPostAt });
    assert.equal(r.json.item.kind, 'manual');
  });
});

// ---- saving ---------------------------------------------------------------------------------------------------------

describe('저장하기·불러오기: POST /backups (저장하기)', () => {
  let s;
  before(async () => { s = await scenario(); });
  after(async () => { await s.app.close(); });
  beforeEach(() => { freshLimits(s.app); s.app.app.backupBusy = false; });

  it('201 { item, warnings }: a backup folder with the database, the uploads, BACKUP-INFO.txt and backup.json', async () => {
    const started = Date.now();
    const r = await s.owner.post('/api/backups');
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['item', 'warnings']);
    assert.deepEqual(r.json.warnings, []);
    assertNoPaths(s.app, r.text, 'POST /backups');
    const it1 = r.json.item;
    assert.match(it1.id, /^edulet-\d{8}-\d{6}(-\d+)?$/);
    assert.equal(it1.kind, 'manual');
    assert.deepEqual(it1.summary, { boards: 2, posts: 3, users: 2, latestPostAt: s.app.db.get('SELECT MAX(created_at) AS n FROM posts').n });
    assert.ok(it1.createdAt >= started - 1000 && it1.createdAt <= Date.now() + 1000);
    const dir = backupPath(s.app, it1.id);
    assert.deepEqual(names(dir), ['BACKUP-INFO.txt', 'backup.json', 'edulet.db', 'uploads']);
    assert.deepEqual(names(path.join(dir, 'uploads')), [s.up.id]);
    const raw = fs.readFileSync(path.join(dir, 'backup.json'));
    assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'no BOM');
    const meta = JSON.parse(raw.toString('utf8'));
    assert.deepEqual(Object.keys(meta).sort(), ['counts', 'createdAt', 'dbBytes', 'format', 'kind', 'latestPostAt', 'uploads', 'userVersion', 'warnings']);
    assert.equal(meta.format, 1);
    assert.equal(meta.kind, 'manual');
    assert.equal(meta.createdAt, it1.createdAt);
    assert.deepEqual(meta.counts, { boards: 2, posts: 3, users: 2 });
    assert.deepEqual(meta.uploads, { files: 1, bytes: PNG.length, missing: 0 });
    assert.equal(meta.dbBytes, fs.statSync(path.join(dir, 'edulet.db')).size);
    assert.equal(meta.userVersion, SCHEMA_VERSION);
    assert.equal(meta.warnings, 0);
    const info = fs.readFileSync(path.join(dir, 'BACKUP-INFO.txt'), 'utf8');
    assert.match(info, /\[가\] 화면에서 하기.*'불러오기'/, 'the screen way comes first in the restore section');
    assert.ok(info.indexOf('[가] 화면에서 하기') < info.indexOf('[나] 화면을 쓸 수 없을 때'));
    assert.match(info, /\[나\] 화면을 쓸 수 없을 때/);
    assert.match(info, /\r\n {2}1\. 서버를 끕니다/, 'the hand way is still all there');
    const listed = (await s.owner.get('/api/backups')).json.items.find((x) => x.id === it1.id);
    assert.deepEqual(listed, it1, 'the list says the same as the save');
  });

  it('a later save sees the later work', async () => {
    await makePost(s.owner, s.board, { title: '저장 사이의 글' });
    const r = await s.owner.post('/api/backups');
    assert.equal(r.status, 201);
    assert.equal(r.json.item.summary.posts, 4);
    assert.equal((await s.owner.get('/api/backups')).json.items[0].id, r.json.item.id, 'newest first');
  });

  it('a save while another save/restore runs is 409 busy (and the mutex is released afterwards)', async () => {
    s.app.app.backupBusy = true;
    const before = names(s.app.backupDir);
    const r = await s.owner.post('/api/backups');
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'busy');
    assert.match(r.json.error.message, /진행 중/);
    assert.deepEqual(names(s.app.backupDir), before);
    s.app.app.backupBusy = false;
    assert.equal((await s.owner.post('/api/backups')).status, 201);
    assert.equal(s.app.app.backupBusy, false);
  });

  it('6 saves per minute per user, the 7th is 429 rate_limited with Retry-After', async () => {
    freshLimits(s.app);
    for (let i = 1; i <= 6; i++) assert.equal((await s.owner.post('/api/backups')).status, 201, `save ${i}`);
    const before = names(s.app.backupDir).length;
    const r = await s.owner.post('/api/backups');
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'rate_limited');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(names(s.app.backupDir).length, before, 'nothing was made');
    assert.equal(s.app.app.backupBusy, false, 'the mutex was released');
    freshLimits(s.app);
    assert.equal((await s.owner.post('/api/backups')).status, 201);
  });

  it('a failed save is 500 backup_failed with a Korean reason, no stack and no absolute path; the mutex is released', async () => {
    const real = s.app.app.config.backupDir;
    s.app.app.config.backupDir = path.join(s.app.app.config.dataDir, 'inside');
    try {
      const r = await s.owner.post('/api/backups');
      assert.equal(r.status, 500);
      assert.equal(r.json.error.code, 'backup_failed');
      assert.match(r.json.error.message, /data 폴더 안에/);
      assertNoPaths(s.app, r.text, 'a failed save');
      assert.ok(!/\bat \w/.test(r.text) && !r.json.error.message.includes('\n'));
      assert.match(r.json.error.message, /data/, 'the folder is named plainly instead');
      assert.equal(s.app.app.backupBusy, false);
    } finally { s.app.app.config.backupDir = real; }
    assert.equal(fs.existsSync(path.join(s.app.dir, 'inside')), false, 'nothing was created inside data');
    freshLimits(s.app);
    assert.equal((await s.owner.post('/api/backups')).status, 201);
  });
});

// ---- the round trip -------------------------------------------------------------------------------------------------

describe('저장하기·불러오기: restoring (the round trip)', () => {
  let s;
  beforeEach(async () => { s = await scenario(); });
  afterEach(async () => { await s.app.close(); });

  it('save, wreck, restore: the data, the photo and the ids are back; the safety copy holds the wrecked state and can undo the restore', async () => {
    const bk = await save(s.app, s.owner);
    const s0 = digest(s.app);
    const c0 = counts(s.app);
    const bkTree = treeOf(backupPath(s.app, bk.id));
    const burnedId = await messUp(s);
    const s1 = digest(s.app);
    assert.notEqual(s1, s0);
    assert.equal(fs.existsSync(path.join(s.app.dir, 'uploads', s.up.id)), false, 'the photo is really gone from the server');
    const strayId = (await putFile(s.owner, s.board.slug, 'später.txt', Buffer.from('uploaded after the backup'), 'text/plain')).json.id;
    const s1b = digest(s.app);
    const c1 = counts(s.app);
    const wasOpen = new Client(s.app, s.owner.cookie);

    freshLimits(s.app);
    const r = await s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['keptSession', 'ok', 'restored', 'safety', 'warnings']);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.restored.id, bk.id);
    assert.deepEqual(r.json.restored, bk, 'the backup itself is described as before');
    assert.equal(r.json.safety.kind, 'before-restore');
    assert.deepEqual(r.json.safety.summary, { boards: c1.boards, posts: c1.posts, users: c1.users, latestPostAt: r.json.safety.summary.latestPostAt }, 'the safety copy is the state BEFORE the restore');
    assert.deepEqual(r.json.warnings, []);
    assert.equal(r.json.keptSession, true);
    assertNoPaths(s.app, r.text, 'POST restore');

    assert.equal(digest(s.app), s0, 'every row, every id: as saved');
    assert.deepEqual(counts(s.app), c0);
    assert.equal(fs.readFileSync(path.join(s.app.dir, 'uploads', s.up.id)).equals(PNG), true, 'the photo file is back');
    const img = await s.owner.get(s.up.url);
    assert.equal(img.status, 200);
    assert.ok(img.buf.equals(PNG));
    const snap = await s.owner.get(`/api/boards/${s.board.slug}`);
    assert.equal(snap.status, 200);
    assert.equal(snap.json.posts.find((p) => p.id === s.p1.id).attachment.url, s.up.url);
    assert.equal(snap.json.posts.find((p) => p.id === s.p1.id).commentCount, 1);
    assert.equal(snap.json.posts.find((p) => p.id === s.p2.id).reactions.like.count, 1);
    assert.equal(fs.existsSync(path.join(s.app.dir, 'uploads', strayId)), true, 'a file the backup does not know is left alone (the 24-hour sweep decides later)');
    assert.deepEqual(treeOf(backupPath(s.app, bk.id)), bkTree, 'the backup folder itself: not a byte changed');
    assert.equal((await wasOpen.get('/api/auth/me')).json.user.id, s.owner.id, 'the teacher is still signed in');

    // ids never go backwards: the burned id and everything before it is not handed out again
    const next = await makePost(s.owner, s.board, { title: '복원 뒤의 첫 글' });
    assert.ok(next.id > burnedId, `new id ${next.id} must be beyond the id ${burnedId} that was handed out and deleted before the restore`);
    const nb = await makeBoard(s.owner, { title: '복원 뒤의 보드' });
    assert.ok(nb.id > s.board2.id);

    // foreign keys are enforced again
    assert.equal(s.app.db.get('PRAGMA foreign_keys').foreign_keys, 1);
    assert.throws(() => s.app.db.run("INSERT INTO comments (post_id, author_id, body, created_at) VALUES (999999, 1, 'x', 1)"), /FOREIGN KEY/);
    assert.equal(s.app.app.maintenance, false);
    assert.equal(s.app.app.backupBusy, false);
    assert.equal((await s.owner.post(`/api/boards/${s.board.slug}/posts`, { title: '쓰기도 된다' })).status, 201);

    // the safety copy is a real backup of the wrecked state: restoring IT is "undo"
    const safetyDir = backupPath(s.app, r.json.safety.id);
    assert.deepEqual(names(safetyDir), ['BACKUP-INFO.txt', 'backup.json', 'edulet.db', 'uploads']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(safetyDir, 'backup.json'), 'utf8')).kind, 'before-restore');
    assert.match(fs.readFileSync(path.join(safetyDir, 'BACKUP-INFO.txt'), 'utf8'), /불러오기 직전/);
    assert.equal((await s.owner.get('/api/backups')).json.items.find((x) => x.id === r.json.safety.id).kind, 'before-restore');
    const back = await restore(s.app, s.owner, r.json.safety.id);
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.restored.kind, 'before-restore');
    assert.deepEqual(counts(s.app), c1, 'what was written after the first restore is gone again (it is in the newest safety copy)');
    assert.equal(digest(s.app), s1b, 'every row of the wrecked state, exactly');
    assert.ok(digest(s.app).includes('저장 뒤에 쓴 글'));
    assert.ok(!digest(s.app).includes('사진 글'), 'the wrecked state really has no photo post');
    assert.equal(fs.existsSync(path.join(s.app.dir, 'uploads', strayId)), true);
  });

  it('an older backup without backup.json is restored the same way', async () => {
    const bk = await save(s.app, s.owner);
    fs.rmSync(path.join(backupPath(s.app, bk.id), 'backup.json'));
    const s0 = digest(s.app);
    await makePost(s.owner, s.board, { title: '이 글은 사라진다' });
    const r = await restore(s.app, s.owner, bk.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(digest(s.app), s0);
    assert.equal(r.json.restored.kind, 'manual');
    assert.equal(r.json.restored.summary.posts, counts(s.app).posts);
  });

  it('confirm must be exactly true (400 confirm_required), and nothing happens without it', async () => {
    const bk = await save(s.app, s.owner);
    const before = { d: digest(s.app), n: names(s.app.backupDir) };
    for (const body of [undefined, {}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }, { confirm: null }]) {
      freshLimits(s.app);
      const r = body === undefined ? await s.owner.req('POST', `/api/backups/${bk.id}/restore`) : await s.owner.post(`/api/backups/${bk.id}/restore`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, 'confirm_required');
    }
    assert.equal(digest(s.app), before.d);
    assert.deepEqual(names(s.app.backupDir), before.n, 'no safety copy either');
  });

  it('3 restores per minute per user, the 4th is 429 rate_limited', async () => {
    const bk = await save(s.app, s.owner);
    freshLimits(s.app);
    for (let i = 1; i <= 3; i++) assert.equal((await s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true })).status, 200, `restore ${i}`);
    const r = await s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true });
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'rate_limited');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(s.app.app.backupBusy, false);
  });

  it('files the server already has are never touched; missing/odd files in the backup only warn', async () => {
    const bk = await save(s.app, s.owner);
    const dir = backupPath(s.app, bk.id);
    const upFile = path.join(s.app.dir, 'uploads', s.up.id);
    const keep = (name) => path.join(s.app.dir, 'uploads', name);

    // (a) same size, different content: skipped silently, content untouched
    assert.equal((await s.owner.del(`/api/posts/${s.p1.id}`)).status, 200);
    assert.equal(fs.existsSync(upFile), false);
    const sameSize = Buffer.alloc(PNG.length, 7);
    fs.writeFileSync(upFile, sameSize);
    let r = await restore(s.app, s.owner, bk.id);
    assert.equal(r.status, 200, r.text);
    assert.ok(fs.readFileSync(upFile).equals(sameSize), 'same size: not overwritten');
    assert.deepEqual(r.json.warnings, []);

    // (b) a different size: untouched, and it says so
    assert.equal((await s.owner.del(`/api/posts/${s.p1.id}`)).status, 200);
    fs.writeFileSync(upFile, Buffer.from('a longer file with other content'));
    r = await restore(s.app, s.owner, bk.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(fs.readFileSync(upFile, 'utf8'), 'a longer file with other content');
    assert.equal(r.json.warnings.length, 1);
    assert.match(r.json.warnings[0], new RegExp(`크기가 달라요.*${s.up.id}`));

    // (c) the backup lacks the file: a warning, the restore still happens
    assert.equal((await s.owner.del(`/api/posts/${s.p1.id}`)).status, 200);
    fs.rmSync(upFile, { force: true });
    fs.rmSync(path.join(dir, 'uploads', s.up.id));
    r = await restore(s.app, s.owner, bk.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.warnings.length, 1);
    assert.match(r.json.warnings[0], new RegExp(`저장본에 없거나 읽을 수 없어서.*${s.up.id}`));
    assert.equal(fs.existsSync(upFile), false);
    assert.equal(counts(s.app).posts, 3, 'the data came back anyway');

    // (d) an upload row whose id is a path ("../escape"): never followed outside uploads/, only a warning
    fs.writeFileSync(path.join(dir, 'escape'), 'must not travel');
    editBackup(dir, (db) => db.prepare("INSERT INTO uploads (id, user_id, board_id, name, mime, size, created_at) VALUES ('../escape', ?, NULL, 'x', 'text/plain', 15, 1)").run(s.owner.id));
    r = await restore(s.app, s.owner, bk.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(fs.existsSync(path.join(s.app.dir, 'escape')), false, 'nothing escaped uploads/');
    assert.ok(r.json.warnings.some((w) => /이름이 올바르지 않아/.test(w)), r.json.warnings.join(' | '));
    assert.ok(!fs.readdirSync(s.app.dir).includes('escape'));
    assert.equal(fs.existsSync(keep('escape')), false);
  });

  it('a backup whose uploads folder is missing or a link restores the data and warns (never follows the link)', async () => {
    const bk = await save(s.app, s.owner);
    const noFolder = clone(s.app, bk.id, 'edulet-20250505-000001');
    fs.rmSync(path.join(backupPath(s.app, noFolder), 'uploads'), { recursive: true });
    assert.equal((await s.owner.del(`/api/posts/${s.p1.id}`)).status, 200);
    let r = await restore(s.app, s.owner, noFolder);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.warnings.some((w) => /uploads 폴더가 없어서/.test(w)));
    assert.equal(counts(s.app).posts, 3);

    const linked = clone(s.app, bk.id, 'edulet-20250505-000002');
    const decoy = tmpDir('decoy');
    fs.copyFileSync(path.join(backupPath(s.app, bk.id), 'uploads', s.up.id), path.join(decoy, s.up.id));
    fs.rmSync(path.join(backupPath(s.app, linked), 'uploads'), { recursive: true });
    let canLink = true;
    try { fs.symlinkSync(decoy, path.join(backupPath(s.app, linked), 'uploads'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { canLink = false; }
    if (canLink) {
      assert.equal((await s.owner.del(`/api/posts/${s.p1.id}`)).status, 200);
      r = await restore(s.app, s.owner, linked);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.warnings.some((w) => /폴더가 아니거나 바로가기/.test(w)), r.json.warnings.join(' | '));
      assert.equal(fs.existsSync(path.join(s.app.dir, 'uploads', s.up.id)), false, 'the link was not followed');
      fs.rmSync(path.join(backupPath(s.app, linked), 'uploads'), { recursive: true, force: true });
    }

    // one upload file inside the backup is itself a link: skipped (and said so), never read through
    const fileLinked = clone(s.app, bk.id, 'edulet-20250505-000003');
    const inner = path.join(backupPath(s.app, fileLinked), 'uploads', s.up.id);
    fs.rmSync(inner);
    let canFileLink = true;
    try { fs.symlinkSync(path.join(decoy, s.up.id), inner, 'file'); } catch { canFileLink = false; }
    if (canFileLink) {
      assert.equal((await s.owner.del(`/api/posts/${s.p1.id}`)).status, 200);
      r = await restore(s.app, s.owner, fileLinked);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.warnings.some((w) => /바로가기이거나 일반 파일이 아니라/.test(w)), r.json.warnings.join(' | '));
      assert.equal(fs.existsSync(path.join(s.app.dir, 'uploads', s.up.id)), false, 'the linked file was not copied');
      assert.equal(counts(s.app).posts, 3, 'the data came back anyway');
    }
  });
});

// ---- sessions -------------------------------------------------------------------------------------------------------

describe('저장하기·불러오기: sessions', () => {
  let s;
  before(async () => { s = await scenario(); });
  after(async () => { await s.app.close(); });

  it("this server's own backup: the teacher stays signed in, a guest from before stays, a guest from after is signed out, the backup's old tokens are dead", async () => {
    // a second teacher session that exists when the backup is made …
    const old = createSession(s.app.app, s.owner.id);
    const oldCookie = `edulet_sid=${old.token}`;
    const before = new Client(s.app);
    await before.guest('저장 전 게스트');
    const bk = await save(s.app, s.owner);
    // … and is logged out afterwards; a new guest arrives
    assert.equal((await new Client(s.app, oldCookie).post('/api/auth/logout')).status, 200);
    assert.equal((await new Client(s.app, oldCookie).get('/api/auth/me')).json.user, null);
    const after1 = new Client(s.app);
    await after1.guest('저장 후 게스트');

    const r = await restore(s.app, s.owner, bk.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.keptSession, true);
    assert.equal((await s.owner.get('/api/auth/me')).json.user.id, s.owner.id, 'the teacher: still in');
    assert.equal((await before.get('/api/auth/me')).json.user.displayName, '저장 전 게스트', 'a guest who is in the backup: still in');
    assert.equal((await after1.get('/api/auth/me')).json.user, null, 'a guest who is not in the backup: out');
    assert.equal((await new Client(s.app, oldCookie).get('/api/auth/me')).json.user, null, "the backup's own old session was NOT brought back");
    assert.equal(s.app.db.get('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', sha256(old.token)).n, 0);
    assert.ok(s.app.db.get('SELECT COUNT(*) AS n FROM sessions').n >= 2);
  });

  it("another PC's backup (other people behind the same ids): the teacher is signed out, and signs in as someone from the backup", async () => {
    const other = await startApp();
    try {
      const principal = makeUser(other, 'principal');
      const board = await makeBoard(principal, { title: '다른 PC 의 보드' });
      await makePost(principal, board, { title: '다른 PC 의 글' });
      assert.equal(principal.id, s.owner.id, 'the same id 1 is a different person there');
      const made1 = await backupData({ dataDir: other.dir, outDir: s.app.backupDir });
      const id = path.basename(made1.dir);
      const guestBefore = new Client(s.app);
      await guestBefore.guest('이쪽 게스트');
      const wrecked = digest(s.app);
      assert.notEqual(wrecked, '');

      const r = await restore(s.app, s.owner, id);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.keptSession, false);
      assert.equal(r.json.safety.kind, 'before-restore');
      assert.equal((await s.owner.get('/api/auth/me')).json.user, null, 'signed out');
      assert.equal((await guestBefore.get('/api/auth/me')).json.user, null);
      assert.deepEqual(s.app.db.all('SELECT title FROM boards ORDER BY id').map((b) => b.title), ['다른 PC 의 보드']);
      assert.equal(s.app.db.get('SELECT COUNT(*) AS n FROM sessions').n, 0, "none of this server's sessions, none of the backup's");
      // sign in as the person from the backup (a session minted directly: the fixture user has no password)
      const token = createSession(s.app.app, principal.id).token;
      const me = await new Client(s.app, `edulet_sid=${token}`).get('/api/auth/me');
      assert.equal(me.json.user.username, principal.username);
      assert.equal((await new Client(s.app, `edulet_sid=${token}`).get('/api/backups')).status, 200, 'and may use the menu again');
      // the safety copy still holds the previous PC state
      const safetyCopy = tmpDir('safety');
      fs.copyFileSync(path.join(backupPath(s.app, r.json.safety.id), 'edulet.db'), path.join(safetyCopy, 'edulet.db'));
      const db = new DatabaseSync(path.join(safetyCopy, 'edulet.db'));
      try { assert.ok(db.prepare("SELECT 1 FROM boards WHERE title = '수업 보드'").get()); } finally { db.close(); }
    } finally { await other.close(); }
  });

  it('a new PC (no teacher yet) may restore without signing in; nobody is signed in afterwards; ids handed out on the old PC are not handed out again', async () => {
    const source = await scenario();
    const fresh = await startApp();
    try {
      // ids burned on the old PC: created and deleted again, so every counter is ahead of the largest id still in use
      let burnedPost = 0;
      for (let i = 0; i < 2; i++) {
        burnedPost = (await makePost(source.owner, source.board, { title: '지운 글' })).id;
        assert.equal((await source.owner.del(`/api/posts/${burnedPost}`)).status, 200);
      }
      const burnedBoard = await makeBoard(source.owner, { title: '지운 보드' });
      assert.equal((await source.owner.del(`/api/boards/${burnedBoard.slug}`)).status, 200);
      assert.ok(burnedPost > source.app.db.get('SELECT MAX(id) AS n FROM posts').n);
      const copied = await backupData({ dataDir: source.app.dir, outDir: fresh.backupDir });
      const id = path.basename(copied.dir);
      const anon = new Client(fresh);
      const r = await anon.post(`/api/backups/${id}/restore`, { confirm: true });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.keptSession, false);
      assert.equal(digest(fresh), digest(source.app));
      assert.equal(fresh.db.get('SELECT COUNT(*) AS n FROM sessions').n, 0);
      assert.equal((await anon.get('/api/backups')).json.error.code, 'member_required', 'now there are teachers: the door is closed');
      // the counters came along (max of this PC's and the backup's): nothing the old PC already used is used again
      const teacher = new Client(fresh, `edulet_sid=${createSession(fresh.app, source.owner.id).token}`);
      const np = await makePost(teacher, source.board, { title: '새 PC 의 첫 글' });
      assert.ok(np.id > burnedPost, `post id ${np.id} must be beyond ${burnedPost}`);
      const nb = await makeBoard(teacher, { title: '새 PC 의 첫 보드' });
      assert.ok(nb.id > burnedBoard.id, `board id ${nb.id} must be beyond ${burnedBoard.id}`);
    } finally { await fresh.close(); await source.app.close(); }
  });
});

// ---- maintenance mode -----------------------------------------------------------------------------------------------

describe('저장하기·불러오기: 점검 모드', () => {
  let s;
  let bk;
  before(async () => { s = await scenario(); bk = await save(s.app, s.owner); });
  after(async () => { clearHooks(s.app); await s.app.close(); });

  it('while a restore runs, changing requests get 503 busy (Retry-After 3), reads and event streams carry on, other backups meet the mutex; afterwards all is free', async () => {
    freshLimits(s.app);
    const h = holdAt(s.app, 'afterValidate');
    const d0 = digest(s.app);
    const first = s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true });
    await withTimeout(h.reached, 8000, 'the restore to reach afterValidate');
    try {
      assert.equal(s.app.app.maintenance, true);
      assert.equal(s.app.app.backupBusy, true);
      // reads and the live stream go on
      assert.equal((await s.owner.get('/api/boards')).status, 200);
      assert.equal((await s.owner.get('/api/config')).status, 200);
      assert.equal((await s.owner.get(`/api/boards/${s.board.slug}`)).status, 200);
      assert.equal((await s.owner.get(`/api/backups/${bk.id}`)).status, 200, 'the preview works');
      const sse = await openSse(s.app, s.board.slug, s.owner);
      assert.equal(sse.status, 200);
      sse.close();
      // everything that changes something waits
      const writes = [
        ['POST', '/api/boards', { title: '막혀야 해요' }],
        ['POST', `/api/boards/${s.board.slug}/posts`, { title: '막혀야 해요' }],
        ['PATCH', '/api/auth/me', { displayName: '막힘' }],
        ['DELETE', `/api/posts/${s.p2.id}`],
        ['PUT', `/api/posts/${s.p2.id}/reactions`, { kind: 'like' }],
        ['POST', '/api/auth/guest', { displayName: '손님' }],
        ['POST', '/api/auth/login', { username: 'nobody', password: 'wrong-password' }],
        ['POST', '/api/auth/logout', {}],
      ];
      for (const [method, url, body] of writes) {
        const r = await s.owner.req(method, url, body);
        assert.equal(r.status, 503, `${method} ${url}`);
        assert.equal(r.json.error.code, 'busy');
        assert.equal(r.headers.get('retry-after'), '3');
        assert.match(r.json.error.message, /불러오는 중/);
      }
      const up = await putFile(s.owner, s.board.slug, 'x.png', PNG, 'image/png');
      assert.equal(up.status, 503, 'uploads too');
      const anon = await new Client(s.app).post('/api/auth/guest', { displayName: '익명' });
      assert.equal(anon.status, 503, 'even before any permission check');
      // the other backup operations meet the mutex, not the maintenance answer
      freshLimits(s.app);
      const second = await withTimeout(s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true }), 6000, 'the second restore to be refused');
      assert.equal(second.status, 409, 'a second restore: only one at a time');
      assert.equal(second.json.error.code, 'busy');
      assert.match(second.json.error.message, /진행 중/);
      const saveMeanwhile = await s.owner.post('/api/backups');
      assert.equal(saveMeanwhile.status, 409);
      assert.equal(digest(s.app), d0, 'nothing was written meanwhile');
    } finally {
      h.release();
      clearHooks(s.app);
    }
    const done = await first;
    assert.equal(done.status, 200, done.text);
    assert.equal(s.app.app.maintenance, false);
    assert.equal(s.app.app.backupBusy, false);
    freshLimits(s.app);
    assert.equal((await s.owner.post('/api/boards', { title: '풀렸어요' })).status, 201);
    assert.equal((await new Client(s.app).post('/api/auth/guest', { displayName: '이제 돼요' })).status, 201);
  });

  it('the housekeeping timers (expired sessions, orphan uploads) rest during maintenance and do their work again afterwards', () => {
    const stale = 'e'.repeat(64);
    const orphan = 'a'.repeat(32);
    s.app.db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, 1, 1)', stale, s.owner.id);
    s.app.db.run('INSERT INTO uploads (id, user_id, board_id, name, mime, size, created_at) VALUES (?, ?, NULL, ?, ?, 1, 1)', orphan, s.owner.id, 'o.txt', 'text/plain');
    fs.writeFileSync(path.join(s.app.dir, 'uploads', orphan), 'x');
    const has = () => ({
      session: !!s.app.db.get('SELECT 1 AS x FROM sessions WHERE token_hash = ?', stale),
      row: !!s.app.db.get('SELECT 1 AS x FROM uploads WHERE id = ?', orphan),
      file: fs.existsSync(path.join(s.app.dir, 'uploads', orphan)),
    });
    s.app.app.maintenance = true;
    try {
      s.app.app.sweepSessions();
      s.app.app.runGc();
      assert.deepEqual(has(), { session: true, row: true, file: true }, 'nothing was swept while the data is being replaced');
    } finally { s.app.app.maintenance = false; }
    s.app.app.sweepSessions();
    s.app.app.runGc();
    assert.deepEqual(has(), { session: false, row: false, file: false }, 'and the next round does it');
  });

  it('maintenance and the mutex are released when the restore fails, whatever the step', async () => {
    for (const hook of ['afterValidate', 'afterStage', 'afterSafetySave']) {
      s.app.app.backupHooks = { [hook]: async () => { throw new Error(`boom at ${hook}`); } };
      const before = digest(s.app);
      freshLimits(s.app);
      const r = await s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true });
      clearHooks(s.app);
      assert.equal(r.status, 500, `${hook}: ${r.text}`);
      assert.equal(r.json.error.code, 'restore_failed');
      assert.equal(s.app.app.maintenance, false, hook);
      assert.equal(s.app.app.backupBusy, false, hook);
      assert.equal(digest(s.app), before, `${hook}: nothing changed`);
      assert.equal((await s.owner.post('/api/boards', { title: `다시 쓰기 ${hook}` })).status, 201);
    }
  });
});

// ---- atomicity ------------------------------------------------------------------------------------------------------

describe('저장하기·불러오기: nothing changes unless everything works', () => {
  let s;
  let bk;
  beforeEach(async () => {
    s = await scenario();
    bk = await save(s.app, s.owner);
    // the photo post goes away, so the restore has a photo to copy back (and so something to clean up when it fails)
    assert.equal((await s.owner.del(`/api/posts/${s.p1.id}`)).status, 200);
  });
  const tidy = async () => { clearHooks(s.app); await s.app.close(); };

  /** run a restore with `hook`; assert it fails as `status`/`code` and that the live system is exactly as before */
  async function failsCleanly(hooks, status, code) {
    const before = { digest: digest(s.app), names: names(s.app.backupDir), uploads: names(path.join(s.app.dir, 'uploads')), sessions: s.app.db.all('SELECT token_hash FROM sessions ORDER BY token_hash') };
    s.app.app.backupHooks = hooks;
    freshLimits(s.app);
    const r = await s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true });
    clearHooks(s.app);
    assert.equal(r.status, status, r.text);
    assert.equal(r.json.error.code, code);
    assert.ok(!/\bat \w+ \(|node_modules|\.js:\d+/.test(r.text), 'no stack');
    assertNoPaths(s.app, r.text, 'a failed restore');
    assert.equal(digest(s.app), before.digest, 'the data is exactly as it was');
    assert.deepEqual(s.app.db.all('SELECT token_hash FROM sessions ORDER BY token_hash'), before.sessions, 'sessions untouched');
    assert.deepEqual(names(s.app.backupDir), before.names, 'no safety copy is left behind');
    assert.deepEqual(names(path.join(s.app.dir, 'uploads')), before.uploads, 'the photos copied for the restore were taken away again');
    assert.equal(s.app.db.get('PRAGMA foreign_keys').foreign_keys, 1, 'foreign_keys is back ON');
    assert.throws(() => s.app.db.run("INSERT INTO comments (post_id, author_id, body, created_at) VALUES (999999, 1, 'x', 1)"), /FOREIGN KEY/);
    assert.equal(s.app.app.maintenance, false);
    assert.equal(s.app.app.backupBusy, false);
    assert.deepEqual(s.app.db.all('PRAGMA database_list').map((d) => d.name), ['main'], 'the temp copy is detached again');
    assert.equal((await s.owner.get('/api/auth/me')).json.user.id, s.owner.id, 'still signed in');
    assert.equal((await s.owner.post(`/api/boards/${s.board.slug}/posts`, { title: '이어서 쓰기' })).status, 201, 'and the server keeps working');
    return r;
  }
  const touchCopy = (sql, { fkOff = false } = {}) => async ({ copy }) => {
    const db = new DatabaseSync(copy);
    try { if (fkOff) db.exec('PRAGMA foreign_keys = OFF'); db.exec(sql); } finally { db.close(); }
  };

  it('a table that disappears from the copy after the check: 422, rolled back', async () => {
    try {
      const r = await failsCleanly({ afterValidate: touchCopy('DROP TABLE comments') }, 422, 'backup_invalid');
      assert.match(r.json.error.message, /'comments' 표가 없어요/);
    } finally { await tidy(); }
  });

  it('a column that disappears: 422, rolled back', async () => {
    try {
      const r = await failsCleanly({ afterValidate: touchCopy('ALTER TABLE reactions DROP COLUMN value') }, 422, 'backup_invalid');
      assert.match(r.json.error.message, /'reactions' 표에 'value' 열이 없어요/);
    } finally { await tidy(); }
  });

  it('a foreign-key violation found only at the end (after every table was copied): 422, rolled back, foreign_keys back ON', async () => {
    try {
      const r = await failsCleanly({ afterValidate: touchCopy("INSERT INTO comments (post_id, author_id, body, created_at) VALUES (999999, 1, 'orphan', 1)", { fkOff: true }) }, 422, 'backup_invalid');
      assert.match(r.json.error.message, /서로 맞지 않아요/);
    } finally { await tidy(); }
  });

  it('an SQL error in the middle of the copy (a UNIQUE clash): 500 restore_failed, rolled back', async () => {
    try {
      const r = await failsCleanly({
        afterValidate: touchCopy("DROP INDEX idx_users_google_sub; UPDATE users SET google_sub = 'same', google_email = 'x@example.org' WHERE id IN (SELECT id FROM users ORDER BY id LIMIT 2)"),
      }, 500, 'restore_failed');
      assert.match(r.json.error.message, /바뀌지 않았어요/);
    } finally { await tidy(); }
  });

  it('the safety copy cannot be made: 500 backup_failed, rolled back, the copied photos removed', async () => {
    try {
      const real = s.app.app.config.backupDir;
      let staged = false;
      const r = await failsCleanly({
        afterStage: async () => {
          staged = fs.existsSync(path.join(s.app.dir, 'uploads', s.up.id)); // the photo was copied back in step 4 …
          s.app.app.config.backupDir = path.join(s.app.app.config.dataDir, 'inside'); // … and now the backup cannot be written
        },
      }, 500, 'backup_failed').finally(() => { s.app.app.config.backupDir = real; });
      assert.equal(staged, true, 'the photo had really been staged');
      assert.match(r.json.error.message, /안전 저장을 만들지 못해서/);
    } finally { await tidy(); }
  });

  it('data_changed: something writes to the database during the safety copy — three tries, then stop (409), nothing replaced, no safety copies left', async () => {
    try {
      let tries = 0;
      const r = await failsCleanlyAllowingHookWrites({
        afterSafetySave: async (n) => { tries = n; s.app.db.run('UPDATE boards SET title = ? WHERE id = ?', `hook ${n}`, s.board.id); },
      });
      assert.equal(tries, 3);
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'data_changed');
      assert.match(r.json.error.message, /그동안 다른 변경이 있어 중단했어요/);
      assert.equal(s.app.db.get('SELECT title FROM boards WHERE id = ?', s.board.id).title, 'hook 3', 'the hook wrote, the restore did not');
      assert.equal(counts(s.app).posts, 2, 'the backup (3 posts) was not applied');
    } finally { await tidy(); }
  });

  /** like failsCleanly, but the hook itself changes the database, so only the structure is compared */
  async function failsCleanlyAllowingHookWrites(hooks) {
    const names0 = names(s.app.backupDir);
    s.app.app.backupHooks = hooks;
    freshLimits(s.app);
    const r = await s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true });
    clearHooks(s.app);
    assert.deepEqual(names(s.app.backupDir), names0, 'no safety copy is left behind');
    assert.equal(s.app.app.maintenance, false);
    assert.equal(s.app.app.backupBusy, false);
    assert.equal(s.app.db.get('PRAGMA foreign_keys').foreign_keys, 1);
    return r;
  }

  it('data_changed once, then it works: the restore goes through and keeps ONE safety copy — the one taken after the write', async () => {
    try {
      s.app.app.backupHooks = {
        afterSafetySave: async (n) => { if (n === 1) s.app.db.run('UPDATE boards SET title = ? WHERE id = ?', '쓰는 중', s.board.id); },
      };
      freshLimits(s.app);
      const r = await s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true });
      clearHooks(s.app);
      assert.equal(r.status, 200, r.text);
      const safeties = names(s.app.backupDir).filter((n) => n !== bk.id);
      assert.deepEqual(safeties, [r.json.safety.id], 'the first, stale safety copy was removed');
      const tmp = tmpDir('safe');
      fs.copyFileSync(path.join(backupPath(s.app, r.json.safety.id), 'edulet.db'), path.join(tmp, 'edulet.db'));
      const db = new DatabaseSync(path.join(tmp, 'edulet.db'));
      try { assert.equal(db.prepare('SELECT title FROM boards WHERE id = ?').get(s.board.id).title, '쓰는 중', 'the surviving safety copy includes the late write'); } finally { db.close(); }
      assert.equal(counts(s.app).posts, 3, 'and the backup was applied');
    } finally { await tidy(); }
  });
});

// ---- older and newer formats ----------------------------------------------------------------------------------------

describe('저장하기·불러오기: older and newer schema versions', () => {
  let s;
  let bk;
  before(async () => { s = await scenario(); bk = await save(s.app, s.owner); });
  after(async () => { await s.app.close(); });

  it('a version-1 backup is migrated (on a copy) and restored; the live schema stays current; the backup folder is untouched', async () => {
    const v1 = clone(s.app, bk.id, 'edulet-20250606-000001');
    editBackup(backupPath(s.app, v1), (db) => db.exec('DROP INDEX idx_users_google_sub; ALTER TABLE users DROP COLUMN google_sub; ALTER TABLE users DROP COLUMN google_email; DROP INDEX idx_uploads_user; PRAGMA user_version = 1'));
    const folder = treeOf(backupPath(s.app, v1));
    const d0 = digest(s.app);
    await makePost(s.owner, s.board, { title: '버려질 글' });
    const r = await restore(s.app, s.owner, v1);
    assert.equal(r.status, 200, r.text);
    assert.equal(digest(s.app), d0);
    assert.equal(s.app.db.get('PRAGMA user_version').user_version, SCHEMA_VERSION);
    assert.ok(s.app.db.all('PRAGMA table_info(users)').some((c) => c.name === 'google_sub'), 'the live table still has its Google columns');
    assert.ok(s.app.db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'idx_users_google_sub'"));
    assert.deepEqual(treeOf(backupPath(s.app, v1)), folder, 'the old backup is exactly as it was');
    assert.equal((await s.owner.get('/api/auth/me')).json.user.id, s.owner.id);
  });

  it('a backup from a newer Edulet is refused (422) and nothing changes', async () => {
    const newer = clone(s.app, bk.id, 'edulet-20250606-000002');
    editBackup(backupPath(s.app, newer), (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));
    const d0 = digest(s.app);
    const p = await s.owner.get(`/api/backups/${newer}`);
    assert.equal(p.status, 422);
    assert.match(p.json.error.message, /더 새로운 Edulet/);
    const r = await restore(s.app, s.owner, newer);
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'backup_invalid');
    assert.equal(digest(s.app), d0);
  });
});

// ---- realtime -------------------------------------------------------------------------------------------------------

describe('저장하기·불러오기: realtime', () => {
  it('every open event stream gets `reset` and is closed; the ping keeps going for new streams', async () => {
    const s = await scenario({ pingMs: 40 });
    try {
      const bk = await save(s.app, s.owner);
      const a = await openSse(s.app, s.board.slug, s.owner);
      const b = await openSse(s.app, s.board2.slug, s.owner);
      const anon = await openSse(s.app, s.board.slug, null);
      assert.equal(a.status, 200);
      const r = await restore(s.app, s.owner, bk.id);
      assert.equal(r.status, 200, r.text);
      for (const sse of [a, b, anon]) {
        const ev = await sse.waitFor('reset');
        assert.deepEqual(ev.data, {});
        await sse.waitClosed();
      }
      assert.match(a.raw, /event: reset\ndata: \{\}\n\n/);
      assert.equal(s.app.app.hub.boards.size, 0, 'no room left over');
      assert.equal(s.app.app.hub.byIp.size, 0);
      assert.equal(s.app.app.hub.byUser.size, 0);
      const c = await openSse(s.app, s.board.slug, s.owner);
      await c.waitFor('ping', () => true, 3000); // the hub's timer was not stopped (closeAll would have)
      c.close();
    } finally { await s.app.close(); }
  });
});

// ---- ids from outside -----------------------------------------------------------------------------------------------

describe('저장하기·불러오기: ids from outside', () => {
  let s;
  let bk;
  before(async () => { s = await scenario(); bk = await save(s.app, s.owner); });
  after(async () => { await s.app.close(); });

  it('anything that is not exactly edulet-YYYYMMDD-HHMMSS[-n] is 400 bad_request — nothing on disk is looked at', async () => {
    const outside = tmpDir('outside');
    fs.cpSync(backupPath(s.app, bk.id), path.join(outside, 'edulet-20250101-000000'), { recursive: true });
    const d0 = digest(s.app);
    const before = names(s.app.backupDir);
    const rel = path.relative(s.app.backupDir, path.join(outside, 'edulet-20250101-000000')).split(path.sep).map(encodeURIComponent).join('%2F');
    const ids = [
      '..%2F..%2Fdata', '..%5C..%5Cdata', '%2e%2e%2f', rel, 'C%3A%5CWindows', 'C%3A', encodeURIComponent(path.join(outside, 'edulet-20250101-000000')),
      'edulet-20250101-000000.partial', 'edulet-2025', 'edulet-20250101-000000%2F', 'edulet-20250101-000000%2F..', 'edulet-20250101-000000%00',
      'edulet-20250101-000000-', 'edulet-20250101-000000-x', 'x'.repeat(300), `edulet-20250101-000000-${'9'.repeat(300)}`, encodeURIComponent('edulet-２０２５０１０１-０００００'), '%E3%81%82', 'edulet-20250101-000000%20',
    ];
    for (const id of ids) {
      for (const [method, suffix, body] of [['GET', '', undefined], ['POST', '/restore', { confirm: true }]]) {
        freshLimits(s.app);
        const r = await rawRequest(s.app, method, `/api/backups/${id}${suffix}`, { body, cookie: s.owner.cookie });
        assert.equal(r.status, 400, `${method} ${id.slice(0, 60)}: ${r.text.slice(0, 120)}`);
        assert.equal(r.json.error.code, 'bad_request');
      }
    }
    // a dot segment is resolved away by the URL parser before it reaches us: it is some other route (404), never a backup
    for (const id of ['%2e%2e', '..']) {
      const r = await rawRequest(s.app, 'GET', `/api/backups/${id}`, { cookie: s.owner.cookie });
      assert.ok([400, 404].includes(r.status) && r.json?.error?.code !== undefined, `${id}: ${r.status}`);
      assert.ok(!r.json.items && !r.json.item, `${id} is not a listing or an item`);
    }
    assert.deepEqual(names(s.app.backupDir), before);
    assert.equal(digest(s.app), d0);
  });

  it('a well-formed id of something that is not a backup folder here is 404 backup_not_found', async () => {
    freshLimits(s.app);
    for (const id of ['edulet-20990101-000000', 'edulet-20990101-000000-7']) {
      const g = await s.owner.get(`/api/backups/${id}`);
      assert.equal(g.status, 404);
      assert.equal(g.json.error.code, 'backup_not_found');
      const p = await s.owner.post(`/api/backups/${id}/restore`, { confirm: true });
      assert.equal(p.status, 404);
      assert.equal(p.json.error.code, 'backup_not_found');
    }
  });
});

// ---- hardening (findings of the adversarial review R1) ---------------------------------------------------------------------

describe('저장하기·불러오기: hardening — the gate', () => {
  let s;
  before(async () => { s = await scenario(); await save(s.app, s.owner); });
  after(async () => { s.app.app.config.trustProxy = false; await s.app.close(); });
  beforeEach(() => { freshLimits(s.app); s.app.app.config.trustProxy = false; });

  it('H1: with TRUST_PROXY=1 nobody is "the server PC" — not even a plain loopback request without any proxy header', async () => {
    const req = { headers: { host: 'localhost:3000' }, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(localOperator(s.app.app, req), true, 'control: without TRUST_PROXY this request is the operator');
    s.app.app.config.trustProxy = true;
    assert.equal(localOperator(s.app.app, req), false);
    assert.deepEqual((await s.owner.get('/api/config')).json.backup, { available: false });
    const before = digest(s.app);
    for (const [method, url, body] of [['GET', '/api/backups'], ['GET', '/api/backups/edulet-20250101-000000'], ['POST', '/api/backups', {}], ['POST', '/api/backups/edulet-20250101-000000/restore', { confirm: true }]]) {
      const r = await s.owner.req(method, url, body);
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal(r.json.error.code, 'backup_local_only');
    }
    assert.equal(digest(s.app), before);
  });

  it('H1: the usual proxy / CDN / tunnel headers each close the door — and the front end\'s own headers do not', async () => {
    const closing = [
      'client-ip', 'x-originating-ip', 'fly-client-ip', 'proxy-client-ip', 'x-remote-ip', 'x-remote-addr', 'x-envoy-external-address', 'x-envoy-original-path',
      'cf-ray', 'cf-ipcountry', 'cf-visitor', 'x-amzn-trace-id', 'x-amz-cf-id', 'x-azure-ref', 'x-azure-clientip', 'x-appengine-user-ip', 'x-vercel-id', 'x-vercel-forwarded-for',
      'x-cluster-client-ip', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'via', 'x-real-ip', 'x-client-ip', 'true-client-ip', 'fastly-client-ip', 'x-original-forwarded-for',
      'ngrok-trace-id', 'x-ngrok-trace', 'cdn-loop', 'x-arr-log-id',
    ];
    for (const h of closing) {
      const r = await rawRequest(s.app, 'GET', '/api/config', { headers: { [h]: 'x' } });
      assert.deepEqual(r.json.backup, { available: false }, h);
      const g = await rawRequest(s.app, 'GET', '/api/backups', { headers: { [h]: 'x' }, cookie: s.owner.cookie });
      assert.equal(g.json.error.code, 'backup_local_only', h);
    }
    const plain = await rawRequest(s.app, 'GET', '/api/config', { headers: { 'x-client-id': 'c1a2b3', 'accept-language': 'ko-KR', 'user-agent': 'Mozilla/5.0', accept: '*/*' } });
    assert.deepEqual(plain.json.backup, { available: true }, 'the headers a browser and the Edulet front end send');
  });

  it('M1: the door says "an account", not "a teacher" — the rule is a signed-up (non-guest) account', async () => {
    const r = await new Client(s.app).get('/api/backups');
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'member_required');
    assert.ok(!/교사/.test(r.json.error.message), r.json.error.message);
    assert.match(r.json.error.message, /계정으로 로그인/);
    // a second, ordinary signed-up account (a student on a shared PC) passes just the same: that is the documented trust model (CONTRACT §5)
    const student = makeUser(s.app, 'pupil');
    assert.equal((await student.get('/api/backups')).status, 200);
  });

  it('M6: the preview (it copies a database and runs integrity_check) is rate limited per user: 20 a minute, then 429 with Retry-After', async () => {
    const id = (await s.owner.get('/api/backups')).json.items[0].id;
    freshLimits(s.app);
    for (let i = 1; i <= 20; i++) assert.equal((await s.owner.get(`/api/backups/${id}`)).status, 200, `preview ${i}`);
    const r = await s.owner.get(`/api/backups/${id}`);
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'rate_limited');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal((await s.owner.get('/api/backups')).status, 200, 'the list is not part of that budget');
  });
});

describe('저장하기·불러오기: hardening — older backups are somebody else\'s input', () => {
  let s;
  let bk;
  before(async () => { s = await scenario(); bk = (await save(s.app, s.owner)).id; });
  after(async () => { await s.app.close(); });
  beforeEach(() => freshLimits(s.app));

  function craft(name, sql) {
    const dir = path.join(s.app.backupDir, name);
    fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'BACKUP-INFO.txt'), 'Edulet 백업\r\n');
    const db = new DatabaseSync(path.join(dir, 'edulet.db'));
    try { db.exec(`${sql}; PRAGMA user_version = ${SCHEMA_VERSION}`); } finally { db.close(); }
    return name;
  }
  const HEAVY = 200000000; // rows of the recursive view: minutes of work if anything ever counts it

  it('H2: a `boards` that is a 200-million-row view is refused at once — list: summary null in milliseconds; preview and restore: 422; nothing runs the view', async () => {
    const id = craft('edulet-20240101-000000', `CREATE VIEW boards AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${HEAVY}) SELECT x AS id FROM c;
      CREATE TABLE posts(id INTEGER PRIMARY KEY, created_at INTEGER); CREATE TABLE users(id INTEGER PRIMARY KEY);`);
    const d0 = digest(s.app);
    const t0 = Date.now();
    const r = await s.owner.get('/api/backups');
    assert.ok(Date.now() - t0 < 2500, `the list took ${Date.now() - t0} ms`);
    assert.equal(r.status, 200);
    assert.equal(r.json.items.find((x) => x.id === id).summary, null);
    assert.ok(r.json.items.find((x) => x.id === bk).summary.posts >= 3, 'the good backup next to it is listed normally');
    const t1 = Date.now();
    const p = await s.owner.get(`/api/backups/${id}`);
    assert.equal(p.status, 422);
    assert.equal(p.json.error.code, 'backup_invalid');
    assert.match(p.json.error.message, /만들지 않은 항목/);
    assert.equal((await s.owner.post(`/api/backups/${id}/restore`, { confirm: true })).status, 422);
    assert.ok(Date.now() - t1 < 2500, 'preview and restore were quick as well');
    assert.equal(digest(s.app), d0);
  });

  it('H2: a trigger (or any view / odd object) in an older backup is refused the same way; the tables must be real tables', async () => {
    const good = clone(s.app, bk, 'edulet-20240102-000000');
    fs.rmSync(path.join(backupPath(s.app, good), 'backup.json'));
    editBackup(backupPath(s.app, good), (db) => db.exec('CREATE TRIGGER sneaky AFTER INSERT ON posts BEGIN SELECT 1; END'));
    const view = clone(s.app, bk, 'edulet-20240103-000000');
    fs.rmSync(path.join(backupPath(s.app, view), 'backup.json'));
    editBackup(backupPath(s.app, view), (db) => db.exec('CREATE VIEW everything AS SELECT * FROM posts'));
    const notTable = craft('edulet-20240104-000000', 'CREATE VIEW boards AS SELECT 1 AS id; CREATE VIEW posts AS SELECT 1 AS id, 1 AS created_at; CREATE VIEW users AS SELECT 1 AS id');
    const d0 = digest(s.app);
    const items = (await s.owner.get('/api/backups')).json.items;
    for (const id of [good, view, notTable]) {
      assert.equal(items.find((x) => x.id === id).summary, null, `${id}: no summary`);
      freshLimits(s.app);
      assert.equal((await s.owner.get(`/api/backups/${id}`)).status, 422, `${id}: preview`);
      assert.equal((await s.owner.post(`/api/backups/${id}/restore`, { confirm: true })).status, 422, `${id}: restore`);
    }
    assert.equal(digest(s.app), d0);
  });

  it('M2: a counter near 2^53 (or text, or negative) and an id near the limit are refused (422 "번호표"); a big but sane counter is carried over and new rows can still be written', async () => {
    const d0 = digest(s.app);
    const cases = [
      ['a counter near 2^53', "UPDATE sqlite_sequence SET seq = 9007199254740990 WHERE name = 'posts'"],
      ['a counter just over half of 2^53', 'UPDATE sqlite_sequence SET seq = 4503599627370496 WHERE name = \'posts\''],
      ['a counter that is text', "UPDATE sqlite_sequence SET seq = 'abc' WHERE name = 'boards'"],
      ['a negative counter', "UPDATE sqlite_sequence SET seq = -5 WHERE name = 'users'"],
      ['a real-number counter', "UPDATE sqlite_sequence SET seq = 12.5 WHERE name = 'comments'"],
      ['an id near the limit under a small counter', "INSERT INTO posts (id, board_id, author_id, title, body, rank, created_at, updated_at) VALUES (4611686018427387904, 1, 1, 'x', 'x', 1, 1, 1); UPDATE sqlite_sequence SET seq = 5 WHERE name = 'posts'"],
    ];
    let n = 0;
    for (const [label, sql] of cases) {
      const id = clone(s.app, bk, `edulet-20240201-0000${String(++n).padStart(2, '0')}`);
      editBackup(backupPath(s.app, id), (db) => db.exec(sql));
      freshLimits(s.app);
      const p = await s.owner.get(`/api/backups/${id}`);
      assert.equal(p.status, 422, `${label}: ${p.text}`);
      assert.match(p.json.error.message, /번호표/, label);
      const r = await s.owner.post(`/api/backups/${id}/restore`, { confirm: true });
      assert.equal(r.status, 422, label);
      assert.equal(r.json.error.code, 'backup_invalid');
    }
    assert.equal(digest(s.app), d0, 'nothing changed');
    const big = clone(s.app, bk, 'edulet-20240202-000000');
    editBackup(backupPath(s.app, big), (db) => db.exec("UPDATE sqlite_sequence SET seq = 2251799813685248 WHERE name = 'posts'")); // 2^51
    freshLimits(s.app);
    const r = await s.owner.post(`/api/backups/${big}/restore`, { confirm: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(s.app.db.get("SELECT typeof(seq) AS t, seq FROM sqlite_sequence WHERE name = 'posts'").t, 'integer', 'written as an integer');
    const np = await s.owner.post(`/api/boards/${s.board.slug}/posts`, { title: '큰 번호표 뒤의 글', body: 'x' });
    assert.equal(np.status, 201, np.text);
    assert.equal(np.json.post.id, 2251799813685249);
    assert.equal((await s.owner.get(`/api/boards/${s.board.slug}`)).status, 200);
  });
});

describe('저장하기·불러오기: hardening — another connection or process writes during the restore', () => {
  const otherConnection = (t, sql, ...args) => {
    const o = new DatabaseSync(path.join(t.app.dir, 'edulet.db'));
    try { o.exec('PRAGMA busy_timeout = 3000'); o.prepare(sql).run(...args); } finally { o.close(); }
  };

  it('M3: a commit by ANOTHER connection (total_changes of ours does not move) during the safety copy: three tries, then 409 data_changed; nothing replaced, no safety copy left', async () => {
    const t = await scenario();
    try {
      const bk = await save(t.app, t.owner);
      const names0 = names(t.app.backupDir);
      let tries = 0;
      t.app.app.backupHooks = { afterSafetySave: async (n) => { tries = n; otherConnection(t, 'UPDATE boards SET title = ? WHERE id = ?', `other ${n}`, t.board.id); } };
      const tc = t.app.db.get('SELECT total_changes() AS n').n;
      const r = await restore(t.app, t.owner, bk.id);
      clearHooks(t.app);
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.error.code, 'data_changed');
      assert.equal(tries, 3);
      assert.equal(t.app.db.get('SELECT total_changes() AS n').n, tc, 'precondition: the connection of the server never counted those writes');
      assert.equal(t.app.db.get('SELECT title FROM boards WHERE id = ?', t.board.id).title, 'other 3');
      assert.deepEqual(names(t.app.backupDir), names0, 'no safety copy is left behind');
      assert.equal(t.app.app.maintenance, false);
      assert.equal(t.app.db.get('PRAGMA foreign_keys').foreign_keys, 1);
    } finally { clearHooks(t.app); await t.app.close(); }
  });

  it('M3: one commit by another connection, then quiet: the restore goes through and keeps the safety copy that includes it', async () => {
    const t = await scenario();
    try {
      const bk = await save(t.app, t.owner);
      t.app.app.backupHooks = { afterSafetySave: async (n) => { if (n === 1) otherConnection(t, 'UPDATE boards SET title = ? WHERE id = ?', '다른 연결의 쓰기', t.board.id); } };
      const r = await restore(t.app, t.owner, bk.id);
      clearHooks(t.app);
      assert.equal(r.status, 200, r.text);
      const tmp = tmpDir('other-conn');
      fs.copyFileSync(path.join(backupPath(t.app, r.json.safety.id), 'edulet.db'), path.join(tmp, 'edulet.db'));
      const db = new DatabaseSync(path.join(tmp, 'edulet.db'));
      try { assert.equal(db.prepare('SELECT title FROM boards WHERE id = ?').get(t.board.id).title, '다른 연결의 쓰기'); } finally { db.close(); }
      assert.equal(t.app.db.get('SELECT title FROM boards WHERE id = ?', t.board.id).title, '수업 보드', 'and the backup was applied');
    } finally { clearHooks(t.app); await t.app.close(); }
  });

  it('M3: the swap itself checks again once it holds the write lock: a commit after the last check and before the lock is 409 data_changed, rolled back', async () => {
    const t = await scenario();
    let prep;
    try {
      const bk = await save(t.app, t.owner);
      assert.equal((await t.owner.del(`/api/posts/${t.p2.id}`)).status, 200);
      prep = await prepareCopy(backupPath(t.app, bk.id));
      const raw = t.app.db.raw;
      const dv = () => Number(raw.prepare('PRAGMA data_version').get().data_version);
      const stale = dv();
      otherConnection(t, 'UPDATE boards SET title = ? WHERE id = ?', '지나가던 쓰기', t.board.id);
      assert.notEqual(dv(), stale, 'precondition: the other commit is visible as a new data_version');
      const before = digest(t.app);
      assert.throws(() => swapDatabase(raw, prep.file, { dataVersion: stale }), (e) => e.status === 409 && e.code === 'data_changed');
      assert.equal(digest(t.app), before, 'rolled back: the live data is as it was');
      assert.equal(t.app.db.get('PRAGMA foreign_keys').foreign_keys, 1);
      assert.deepEqual(t.app.db.all('PRAGMA database_list').map((d) => d.name), ['main']);
      swapDatabase(raw, prep.file, { dataVersion: dv() }); // with the current version it goes through
      assert.equal(counts(t.app).posts, 3);
    } finally { disposeCopy(prep); await t.app.close(); }
  });
});

describe('저장하기·불러오기: hardening — messages never carry a folder of this PC', () => {
  it('M4: scrubPaths turns the data/backup folders into names and every other absolute path (drive, UNC, \\\\?\\, /home …) into <경로>', () => {
    const app = { config: { dataDir: 'C:\\Users\\alice\\edulet\\data', backupDir: 'D:\\saves\\edulet-backups' } };
    const cases = [
      ['쓸 수 없어요: C:\\Users\\alice\\edulet\\data\\uploads\\x', '쓸 수 없어요: data\\uploads\\x'],
      ['원본: D:\\saves\\edulet-backups\\edulet-20260101-000000', '원본: backups\\edulet-20260101-000000'],
      ['따라갔어요 E:\\Photos\\2026\\a.png 을(를)', '따라갔어요 <경로> 을(를)'],
      ['따라갔어요 (ENOENT: C:\\x\\y)', '따라갔어요 (ENOENT: <경로>)'],
      ['share \\\\fileserver\\share\\edulet and more', 'share <경로> and more'],
      ['long \\\\?\\C:\\Users\\bob\\very\\long\\path ok', 'long <경로> ok'],
      ['unix /home/bob/edulet/data/x.db failed', 'unix <경로> failed'],
      ['mac /Users/bob/Library/x, then', 'mac <경로>, then'],
      ['/var/tmp/edulet-restore-abc/edulet.db.', '<경로>.'],
      ['nothing to hide, /api/backups is a url and 10/3 a fraction', 'nothing to hide, /api/backups is a url and 10/3 a fraction'],
    ];
    for (const [input, want] of cases) assert.equal(scrubPaths(app, input), want, input);
  });

  it('M4: the answer of a save with problems carries warnings without any path — also when uploads is a junction to somewhere else', async () => {
    const t = await scenario();
    const ext = tmpDir('uploads-elsewhere');
    try {
      // uploads folder removed: the rows point at files that cannot be there
      const upDir = path.join(t.app.dir, 'uploads');
      fs.rmSync(upDir, { recursive: true, force: true });
      let r = await t.owner.post('/api/backups');
      assert.equal(r.status, 201, r.text);
      assert.ok(r.json.warnings.length >= 1, 'a warning about the missing folder');
      assertNoPaths(t.app, r.text, 'save without an uploads folder');
      // uploads as a junction to a folder outside the data folder
      let canLink = true;
      try { fs.symlinkSync(ext, upDir, process.platform === 'win32' ? 'junction' : 'dir'); } catch { canLink = false; }
      if (canLink) {
        freshLimits(t.app);
        r = await t.owner.post('/api/backups');
        assert.equal(r.status, 201, r.text);
        assert.ok(r.json.warnings.some((w) => /<경로>/.test(w)), `the target folder is named <경로>: ${r.json.warnings.join(' | ')}`);
        assertNoPaths(t.app, r.text, 'save with an uploads junction');
        assert.ok(!r.text.includes(path.basename(ext)), 'not even the name of the target folder');
        fs.rmSync(upDir, { recursive: true, force: true });
      }
    } finally { await t.app.close(); }
  });
});

describe('저장하기·불러오기: hardening — leftovers and locks', () => {
  it('M5: a database that fails to migrate is closed again (its file can be deleted at once); failed previews leave no temp folder behind', async () => {
    const s = await scenario();
    const priv = tmpDir('private-temp-m5');
    const vars = ['TMPDIR', 'TMP', 'TEMP'];
    const saved = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
    try {
      const bk = await save(s.app, s.owner);
      // unit: openDb on a current-schema file that claims version 1 — migration v2 fails ("index already exists")
      const f = path.join(tmpDir('m5-unit'), 'x.db');
      fs.copyFileSync(path.join(backupPath(s.app, bk.id), 'edulet.db'), f);
      const db = new DatabaseSync(f);
      db.exec('PRAGMA user_version = 1');
      db.close();
      assert.throws(() => openDb(f), /already exists/);
      fs.rmSync(f); // a handle left open would make this fail with EBUSY on Windows
      assert.equal(fs.existsSync(f), false);
      // through the API: the same kind of backup, previewed several times
      const liar = clone(s.app, bk.id, 'edulet-20250909-000001');
      fs.rmSync(path.join(backupPath(s.app, liar), 'backup.json'));
      editBackup(backupPath(s.app, liar), (d) => d.exec('PRAGMA user_version = 1'));
      for (const v of vars) process.env[v] = priv;
      for (let i = 0; i < 3; i++) {
        freshLimits(s.app);
        const p = await s.owner.get(`/api/backups/${liar}`);
        assert.equal(p.status, 422, p.text);
        assert.match(p.json.error.message, /새 형식으로 바꾸지 못했어요/);
      }
      freshLimits(s.app);
      assert.equal((await s.owner.post(`/api/backups/${liar}/restore`, { confirm: true })).status, 422);
      assert.deepEqual(fs.readdirSync(priv), [], 'no edulet-restore-* folder left behind');
    } finally {
      for (const v of vars) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
      await s.app.close();
    }
  });

  it('L4: a stale .part of an earlier, interrupted restore does not stop the file from being copied', async () => {
    const s = await scenario();
    try {
      const bk = await save(s.app, s.owner);
      assert.equal((await s.owner.del(`/api/posts/${s.p1.id}`)).status, 200); // its photo goes away
      const stale = path.join(s.app.dir, 'uploads', `.${s.up.id}.part`);
      fs.writeFileSync(stale, 'half a file from a crashed run');
      const r = await restore(s.app, s.owner, bk.id);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.warnings, []);
      assert.ok(fs.readFileSync(path.join(s.app.dir, 'uploads', s.up.id)).equals(PNG), 'the photo is back, whole');
      assert.equal(fs.existsSync(stale), false, 'and the stale temp name is gone');
    } finally { await s.app.close(); }
  });
});

describe('저장하기·불러오기: hardening — maintenance mode and the shared sqlite loader', () => {
  it('L1: during a restore the expired-session clean-up of authenticate() does not write, and the Google sign-in GETs (which write) wait with 503', async () => {
    const s = await scenario();
    try {
      const bk = await save(s.app, s.owner);
      const stale = createSession(s.app.app, s.owner.id).token;
      s.app.db.run('UPDATE sessions SET expires_at = 1 WHERE token_hash = ?', sha256(stale));
      const has = () => !!s.app.db.get('SELECT 1 AS x FROM sessions WHERE token_hash = ?', sha256(stale));
      const h = holdAt(s.app, 'afterValidate');
      freshLimits(s.app);
      const first = s.owner.post(`/api/backups/${bk.id}/restore`, { confirm: true });
      await withTimeout(h.reached, 8000, 'the restore to reach afterValidate');
      try {
        const me = await new Client(s.app, `edulet_sid=${stale}`).get('/api/auth/me');
        assert.equal(me.status, 200);
        assert.equal(me.json.user, null);
        assert.equal(has(), true, 'the expired row was NOT deleted while the data is being replaced');
        for (const url of ['/api/auth/google/start', '/api/auth/google/callback?code=x&state=y', '/api/auth/google/callback']) {
          const r = await new Client(s.app).get(url);
          assert.equal(r.status, 503, url);
          assert.equal(r.json.error.code, 'busy');
        }
        assert.equal((await new Client(s.app).get('/api/auth/me')).status, 200, 'other reads go on');
      } finally { h.release(); clearHooks(s.app); }
      assert.equal((await first).status, 200);
      assert.equal(has(), false, 'the restore replaced the sessions: the expired row is gone with them');
      const again = createSession(s.app.app, s.owner.id).token;
      s.app.db.run('UPDATE sessions SET expires_at = 1 WHERE token_hash = ?', sha256(again));
      assert.equal((await new Client(s.app, `edulet_sid=${again}`).get('/api/auth/me')).json.user, null);
      assert.equal(s.app.db.get('SELECT 1 AS x FROM sessions WHERE token_hash = ?', sha256(again)), undefined, 'after the restore authenticate() cleans up again');
      assert.notEqual((await new Client(s.app).get('/api/auth/google/start')).status, 503, 'and Google sign-in is no longer held back');
    } finally { clearHooks(s.app); await s.app.close(); }
  });

  it('L2: server/sqlite.js mutes node:sqlite\'s ExperimentalWarning and nothing else, and puts process.emitWarning back exactly as it was', async () => {
    const url = pathToFileURL(path.join(SERVER_DIR, 'sqlite.js')).href;
    const code = `
      const before = process.emitWarning;
      const seen = [];
      process.on('warning', (w) => seen.push(w.name + ': ' + w.message));
      const m = await import(${JSON.stringify(url)});
      console.log(JSON.stringify({ restored: process.emitWarning === before, sqlite: typeof m.DatabaseSync }));
      process.emitWarning('a warning about nothing', 'CustomWarning');
      process.emitWarning('SQLite is mentioned here but this is not the experimental notice', 'CustomWarning');
      setImmediate(() => { console.log(JSON.stringify({ seen })); });`;
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
      child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (c) => resolve({ code: c, stdout, stderr }));
    });
    assert.equal(out.code, 0, out.stderr);
    const [first, second] = out.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.deepEqual(first, { restored: true, sqlite: 'function' });
    assert.deepEqual(second.seen, ['CustomWarning: a warning about nothing', 'CustomWarning: SQLite is mentioned here but this is not the experimental notice']);
    assert.ok(!/SQLite is an experimental feature/.test(out.stderr), 'the experimental notice itself was muted');
  });
});

// ---- plumbing -------------------------------------------------------------------------------------------------------

describe('저장하기·불러오기: plumbing', () => {
  it('the server never imports from tools/ (the Docker image has no tools/ folder)', () => {
    for (const f of fs.readdirSync(SERVER_DIR).filter((n) => n.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(SERVER_DIR, f), 'utf8');
      assert.ok(!/(?:from|import)\s*\(?\s*['"][^'"]*\/tools\//.test(text), `${f} imports tools/`);
    }
    const docker = fs.readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8');
    assert.ok(!/^COPY\s+tools\b/m.test(docker), 'the image has no tools/');
    assert.ok(/^COPY\s+server\b/m.test(docker));
  });

  it('config: backupDir defaults to backups/ of the REPOSITORY (not the current folder), EDULET_BACKUP_DIR and createApp({ backupDir }) override it', async () => {
    const { loadConfig } = await import('../server/config.js');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const was = { cwd: process.cwd(), env: process.env.EDULET_BACKUP_DIR };
    try {
      delete process.env.EDULET_BACKUP_DIR;
      const elsewhere = tmpDir('cwd');
      process.chdir(elsewhere);
      assert.equal(path.resolve(loadConfig().backupDir).toLowerCase(), path.resolve(root, 'backups').toLowerCase());
      process.env.EDULET_BACKUP_DIR = path.join(elsewhere, 'mine');
      assert.equal(loadConfig().backupDir, path.join(elsewhere, 'mine'));
      assert.equal(loadConfig({ backupDir: path.join(elsewhere, 'given') }).backupDir, path.join(elsewhere, 'given'));
    } finally {
      process.chdir(was.cwd);
      if (was.env === undefined) delete process.env.EDULET_BACKUP_DIR; else process.env.EDULET_BACKUP_DIR = was.env;
    }
  });

  it('the temp copies made for a preview, a list of older backups and a restore (also a failed one) are all removed again', async () => {
    const s = await scenario();
    // The OS temp folder is shared with every other process (and with parallel test runs): point it at a private folder for the
    // duration, so "nothing left behind" means exactly that and cannot be disturbed by (or disturb) anybody else.
    const priv = tmpDir('private-temp');
    const vars = ['TMPDIR', 'TMP', 'TEMP'];
    const saved = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
    try {
      const bk = await save(s.app, s.owner);
      const legacy = clone(s.app, bk.id, 'edulet-20250707-000001');
      fs.rmSync(path.join(backupPath(s.app, legacy), 'backup.json'));
      const broken = clone(s.app, bk.id, 'edulet-20250707-000002');
      fs.writeFileSync(path.join(backupPath(s.app, broken), 'edulet.db'), crypto.randomBytes(5000));
      for (const v of vars) process.env[v] = priv;
      assert.equal(path.resolve(os.tmpdir()).toLowerCase(), path.resolve(priv).toLowerCase(), 'the private temp folder is the one the server will use');
      assert.equal((await s.owner.get(`/api/backups/${bk.id}`)).status, 200);
      assert.equal((await s.owner.get('/api/backups')).status, 200);
      assert.equal((await restore(s.app, s.owner, bk.id)).status, 200);
      assert.equal((await s.owner.get(`/api/backups/${broken}`)).status, 422);
      assert.equal((await restore(s.app, s.owner, broken)).status, 422);
      s.app.app.backupHooks = { afterStage: async () => { throw new Error('boom'); } };
      assert.equal((await restore(s.app, s.owner, bk.id)).status, 500);
      clearHooks(s.app);
      assert.deepEqual(fs.readdirSync(priv), [], 'no edulet-restore-* / edulet-peek-* folder left behind');
    } finally {
      for (const v of vars) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
      await s.app.close();
    }
  });

  it('the test helper never lets a test server fall back to the real backups/ folder', async () => {
    const s = await startApp();
    try {
      const real = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'backups').toLowerCase();
      assert.notEqual(s.app.config.backupDir.toLowerCase(), real);
      assert.ok(s.app.config.backupDir.startsWith(os.tmpdir()));
    } finally { await s.close(); }
  });
});
