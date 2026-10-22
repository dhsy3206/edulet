// tools/backup.mjs — the safe online backup. Hermetic: temp folders and random-port servers only; nothing here ever looks at the
// real ./data folder or at port 3000 (every CLI run passes --data/--out or sets EDULET_DATA_DIR to a temp folder).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, PNG, createAppOnGoodPort, makeBoard, makePost, makeUser, sleep, startApp } from './helpers.js';
import { BackupError, ROOT, backupData, defaultPaths, main, removeOwnBackup, verifySnapshot } from '../tools/backup.mjs';

const { DatabaseSync } = await import('node:sqlite');
const CLI = fileURLToPath(new URL('../tools/backup.mjs', import.meta.url));

// ---- helpers --------------------------------------------------------------------------------------------------------

const made = [];
/** A new temp folder; the name has a space and Korean on purpose (paths with spaces/Korean must work). */
function tmpDir(label = 'x') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `edulet-bk 백업-${label}-`));
  made.push(d);
  return d;
}
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

const p2 = (n) => String(n).padStart(2, '0');
/** local "YYYY-MM-DD HH:MM:SS" — written independently of the tool, so a wrong format there fails the tests. */
const fmt = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const hashFile = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
const names = (d) => fs.readdirSync(d).sort();

/**
 * Every entry below `root`: folders (their mtime — it moves when a file is created or removed in them — and their entry names)
 * and files (size, mtime, sha256). Compare before/after a backup to prove the original was not touched: no new file in the data
 * root, no touched upload. `edulet.db-shm` is left out (SQLite's volatile index — any reader may rewrite it).
 */
function treeOf(root, skip = ['edulet.db-shm']) {
  const out = {};
  const walk = (dir, rel) => {
    const st = fs.statSync(dir);
    const entries = fs.readdirSync(dir).filter((n) => !(rel === '' && skip.includes(n))).sort();
    out[rel || '.'] = { kind: 'dir', mtimeMs: st.mtimeMs, entries };
    for (const n of entries) {
      const full = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      const s = fs.statSync(full);
      if (s.isDirectory()) walk(full, r);
      else out[r] = { kind: 'file', size: s.size, mtimeMs: s.mtimeMs, sha: hashFile(full) };
    }
  };
  walk(root, '');
  return out;
}

function withDb(file, fn, { readOnly = true } = {}) {
  const db = new DatabaseSync(file, { readOnly });
  try { return fn(db); } finally { db.close(); }
}
const one = (db, sql) => Object.values(db.prepare(sql).get())[0];
/** boards/posts/users of a database file, or null when it cannot be read as an Edulet database. */
function countsOf(file) {
  try {
    return withDb(file, (db) => ({ boards: Number(one(db, 'SELECT COUNT(*) FROM boards')), posts: Number(one(db, 'SELECT COUNT(*) FROM posts')), users: Number(one(db, 'SELECT COUNT(*) FROM users')) }));
  } catch { return null; }
}
const liveCounts = (running) => ({
  boards: running.db.get('SELECT COUNT(*) AS n FROM boards').n,
  posts: running.db.get('SELECT COUNT(*) AS n FROM posts').n,
  users: running.db.get('SELECT COUNT(*) AS n FROM users').n,
});

function runNode(args, { env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const runCli = (args, o) => runNode(['--disable-warning=ExperimentalWarning', CLI, ...args], o);

/** A copy of a LIVE server's data (edulet.db + -wal + -shm + uploads), taken while it is idle: what a crash would leave behind. */
function crashImage(running, label = 'img') {
  const img = tmpDir(label);
  for (const n of ['edulet.db', 'edulet.db-wal', 'edulet.db-shm']) {
    const from = path.join(running.dir, n);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(img, n));
  }
  fs.cpSync(path.join(running.dir, 'uploads'), path.join(img, 'uploads'), { recursive: true });
  return img;
}

const putFile = (c, slug, name, body, type) =>
  c.put(`/api/uploads?board=${slug}&name=${encodeURIComponent(name)}`, body, { raw: true, headers: { 'content-type': type } });

/** What the backup folder must look like: the database, the uploads and the info file — no WAL/journal leftovers. */
const BACKUP_ENTRIES = ['BACKUP-INFO.txt', 'edulet.db', 'uploads'];

// ---- the main scenario: the server stays ON ---------------------------------------------------------------------------

describe('backup while the server is running', () => {
  let app;
  let owner;
  let board;
  let up1;
  let up2;
  const titles = [];
  const out = tmpDir('out');

  before(async () => {
    app = await startApp({ config: { writeRateMax: 100000, uploadRateMax: 100000 } });
    // Deterministic: keep everything in the WAL (the default auto-checkpoint is 1000 pages, far above what these tests write).
    app.db.raw.exec('PRAGMA wal_autocheckpoint = 0');
    owner = makeUser(app, 'teacher');
    board = await makeBoard(owner, { title: '백업 시험 보드' });
    await makeBoard(owner, { title: '두 번째 보드' });
    makeUser(app, 'student');
    makeUser(app, 'student'); // 3 users, 2 boards, 6 posts: every count differs, so a swapped table cannot pass
    up1 = (await putFile(owner, board.slug, '사진 하나.png', PNG, 'image/png')).json;
    up2 = (await putFile(owner, board.slug, 'a b.txt', Buffer.from('안녕 hello'), 'text/plain')).json;
    assert.ok(up1?.id && up2?.id, 'fixture uploads');
    const first = await makePost(owner, board, { title: '첫 글', body: '본문 하나', attachment: { kind: 'image', uploadId: up1.id } });
    titles.push('첫 글');
    for (let i = 2; i <= 6; i++) { await makePost(owner, board, { title: `글 ${i}`, body: `본문 ${i}` }); titles.push(`글 ${i}`); }
    const c = await owner.post(`/api/posts/${first.id}/comments`, { body: '첫 댓글입니다' });
    assert.equal(c.status, 201);
  });
  after(async () => { await app.close(); });

  it('precondition: the work really sits in the WAL and edulet.db alone is (nearly) empty', () => {
    const main = path.join(app.dir, 'edulet.db');
    const wal = path.join(app.dir, 'edulet.db-wal');
    assert.ok(fs.existsSync(wal) && fs.statSync(wal).size > 0, 'a WAL with content exists');
    assert.ok(fs.statSync(wal).size > fs.statSync(main).size, 'the WAL is bigger than the main file');
  });

  it('1. snapshot holds everything that is only in the WAL; copying edulet.db alone does not', async () => {
    const r = await backupData({ dataDir: app.dir, outDir: out });
    assert.deepEqual(names(r.dir), BACKUP_ENTRIES, 'database + uploads + info, no -wal/-shm/-journal');
    assert.deepEqual(r.counts, liveCounts(app));
    assert.deepEqual(r.counts, { boards: 2, posts: 6, users: 3 });
    assert.equal(r.dbBytes, fs.statSync(path.join(r.dir, 'edulet.db')).size);
    assert.deepEqual(r.warnings, []);
    withDb(path.join(r.dir, 'edulet.db'), (db) => {
      assert.equal(one(db, 'PRAGMA integrity_check'), 'ok');
      assert.deepEqual(db.prepare('SELECT title FROM boards').all().map((x) => x.title), ['백업 시험 보드', '두 번째 보드']);
      assert.deepEqual(db.prepare('SELECT title FROM posts ORDER BY id').all().map((x) => x.title), titles);
      assert.deepEqual(db.prepare('SELECT body FROM comments').all().map((x) => x.body), ['첫 댓글입니다']);
      assert.equal(one(db, 'SELECT COUNT(*) FROM uploads'), 2);
    });

    // contrast: what the old advice ("copy edulet.db") would have saved while the server is on
    const naive = path.join(tmpDir('naive'), 'edulet.db');
    fs.copyFileSync(path.join(app.dir, 'edulet.db'), naive);
    const got = countsOf(naive);
    assert.ok(got === null || got.posts < r.counts.posts, `a bare edulet.db copy must be missing the work (got ${JSON.stringify(got)})`);
  });

  it('2. uploads are copied (only what the snapshot points at) and match the upload rows', async () => {
    // a stray file without a row and a half-received .part file are not part of the database: not copied
    const strayId = 'f'.repeat(32);
    fs.writeFileSync(path.join(app.dir, 'uploads', strayId), 'stray');
    fs.writeFileSync(path.join(app.dir, 'uploads', `.${'e'.repeat(32)}.part`), 'partial');
    try {
      const r = await backupData({ dataDir: app.dir, outDir: out });
      const rows = app.db.all('SELECT id, size FROM uploads ORDER BY id');
      assert.equal(rows.length, 2);
      assert.deepEqual(names(path.join(r.dir, 'uploads')), rows.map((x) => x.id).sort());
      assert.deepEqual(r.uploads, { files: 2, bytes: rows.reduce((s, x) => s + x.size, 0), missing: 0 });
      assert.ok(fs.readFileSync(path.join(r.dir, 'uploads', up1.id)).equals(PNG));
      assert.equal(fs.readFileSync(path.join(r.dir, 'uploads', up2.id), 'utf8'), '안녕 hello');
      assert.deepEqual(r.warnings, []);
    } finally {
      fs.rmSync(path.join(app.dir, 'uploads', strayId));
      fs.rmSync(path.join(app.dir, 'uploads', `.${'e'.repeat(32)}.part`));
    }
  });

  it('3. the original is untouched (whole data tree: file list, sizes, mtimes, hashes) and the server keeps working', async () => {
    const watched = ['edulet.db', 'edulet.db-wal'].map((n) => path.join(app.dir, n));
    const before = watched.map(hashFile);
    const tree = treeOf(app.dir);
    assert.ok(Object.keys(tree).some((k) => k.startsWith('uploads/')), 'the tree includes the uploads');
    const r = await backupData({ dataDir: app.dir, outDir: out });
    assert.deepEqual(watched.map(hashFile), before, 'edulet.db / edulet.db-wal bytes are the same after the backup');
    assert.deepEqual(treeOf(app.dir), tree, 'no file created in the data root, no upload touched, no mtime moved');
    assert.equal(r.counts.posts, 6);

    const w = await makePost(owner, board, { title: '백업 뒤의 글', body: '서버는 멀쩡' });
    assert.ok(w.id);
    titles.push('백업 뒤의 글');
    const list = await owner.get(`/api/boards/${board.slug}`);
    assert.equal(list.status, 200);
    assert.equal(list.json.posts.length, 7);
    const again = await backupData({ dataDir: app.dir, outDir: out });
    assert.equal(again.counts.posts, 7, 'the next backup sees the write made after the first one');
  });

  it('4. restore: the snapshot dropped into a new data folder serves boards, posts, sessions and uploads', async () => {
    const r = await backupData({ dataDir: app.dir, outDir: out });
    const info = fs.readFileSync(path.join(r.dir, 'BACKUP-INFO.txt'), 'utf8');
    for (const needle of ['edulet.db-wal', 'edulet.db-shm', 'run.cmd', 'uploads', '보드 2개', '글 7개', '사용자 3명']) assert.ok(info.includes(needle), `BACKUP-INFO mentions ${needle}`);

    // what BACKUP-INFO says: new data folder <- edulet.db + uploads (no old -wal/-shm there)
    const restored = tmpDir('restored');
    fs.copyFileSync(path.join(r.dir, 'edulet.db'), path.join(restored, 'edulet.db'));
    fs.cpSync(path.join(r.dir, 'uploads'), path.join(restored, 'uploads'), { recursive: true });
    const srv = await createAppOnGoodPort({ dataDir: restored, port: 0, host: '127.0.0.1', seed: 'off', quiet: true, authRateLimit: 100000 });
    try {
      const c = new Client(srv, owner.cookie); // the session row came along with the database
      const got = await c.get(`/api/boards/${board.slug}`);
      assert.equal(got.status, 200, got.text);
      assert.equal(got.json.board.title, '백업 시험 보드');
      assert.deepEqual(got.json.posts.map((p) => p.title).sort(), [...titles].sort());
      const img = await c.get(up1.url);
      assert.equal(img.status, 200);
      assert.ok(img.buf.equals(PNG));
      const txt = await c.get(up2.url);
      assert.equal(txt.text, '안녕 hello');
      const w = await makePost(c, got.json.board, { title: '복원 뒤의 글' });
      assert.ok(w.id, 'the restored server accepts writes');
    } finally {
      await srv.close();
    }
  });

  it('4b. BACKUP-INFO.txt: UTF-8 BOM, CRLF only, the .partial note, every restore step, and the facts that expose a stale source', async () => {
    const r = await backupData({ dataDir: app.dir, outDir: out });
    const raw = fs.readFileSync(path.join(r.dir, 'BACKUP-INFO.txt'));
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM (old Notepad)');
    const body = raw.toString('utf8').replace(/^\uFEFF/, '');
    assert.ok(!/(^|[^\r])\n/.test(body) && !/\r(?!\n)/.test(body), 'every line break is CRLF');
    const lines = body.split('\r\n');
    const step = (n) => lines.find((l) => l.startsWith(`  ${n}. `)) ?? '';
    assert.match(step(1), /서버를 끕니다/);
    assert.match(step(2), /data 폴더를 따로 옮겨 둡니다/);
    assert.match(step(3), /edulet\.db 와 uploads 폴더를 그 안에 복사/);
    assert.match(step(4), /edulet\.db-wal · edulet\.db-shm 파일이 있으면 반드시 지웁니다/);
    assert.match(step(5), /run\.cmd 로 서버를 켭니다/);
    assert.ok(lines.indexOf(step(1)) < lines.indexOf(step(2)) && lines.indexOf(step(4)) < lines.indexOf(step(5)), 'steps in order');
    assert.match(body, /BACKUP-INFO\.txt 가 있는 정상 이름\(edulet-날짜-시간\)의 폴더만 쓰세요/);
    assert.match(body, /\.partial 이 붙은 폴더는\r\n\s*백업이 중간에 끊긴 것이니 쓰지 말고 지워도 됩니다/);
    assert.ok(body.indexOf('.partial') < body.indexOf('  1. 서버를 끕니다'), 'the note comes first in the restore section');
    // the facts a person can check against reality
    assert.ok(body.includes(`원본 폴더   : ${app.dir}`));
    const newest = app.db.get('SELECT MAX(created_at) AS m FROM posts').m;
    const walMtime = (() => { const fd = fs.openSync(path.join(app.dir, 'edulet.db-wal'), 'r'); try { return fs.fstatSync(fd).mtimeMs; } finally { fs.closeSync(fd); } })();
    assert.ok(body.includes(`가장 최근 글: ${fmt(newest)}  (원본 WAL 마지막 수정: ${fmt(walMtime)})`), body);
  });

  it('1b. a crash image (WAL left behind, no server): the snapshot has the WAL content and the source WAL is NOT checkpointed away', async () => {
    const img = crashImage(app, 'crash');
    const wal = path.join(img, 'edulet.db-wal');
    assert.ok(fs.statSync(wal).size > 0);
    const before = { db: hashFile(path.join(img, 'edulet.db')), wal: hashFile(wal) };
    const r = await backupData({ dataDir: img, outDir: out });
    assert.equal(r.counts.posts, liveCounts(app).posts);
    assert.equal(hashFile(path.join(img, 'edulet.db')), before.db, 'edulet.db untouched (a read-write open+close would checkpoint into it)');
    assert.equal(hashFile(wal), before.wal, 'the WAL is still there, byte for byte');
  });
});

// ---- server OFF -------------------------------------------------------------------------------------------------------

describe('backup while the server is off', () => {
  it('works on a cleanly stopped data folder, leaves edulet.db byte-identical, and the server starts again with everything', async () => {
    const dataDir = tmpDir('off');
    const mk = () => createAppOnGoodPort({ dataDir, port: 0, host: '127.0.0.1', seed: false, quiet: true, authRateLimit: 100000, config: { writeRateMax: 100000 } });
    const a = await mk();
    const teacher = makeUser(a, 'teacher');
    const b = await makeBoard(teacher, { title: '꺼진 서버' });
    await makeBoard(teacher, { title: '둘째' });
    await makePost(teacher, b, { title: '꺼지기 전의 글' });
    await makePost(teacher, b, { title: '또 하나' });
    await makePost(teacher, b, { title: '그리고 또' });
    await a.close();
    const dbHash = hashFile(path.join(dataDir, 'edulet.db'));
    const treeBefore = treeOf(dataDir);

    const r = await backupData({ dataDir, outDir: tmpDir('off-out') });
    assert.deepEqual(r.counts, { boards: 2, posts: 3, users: 1 });
    assert.deepEqual(r.wal, { exists: false, modifiedAt: null }, 'no WAL: reported as such (looked at before SQLite can create an empty one)');
    assert.equal(hashFile(path.join(dataDir, 'edulet.db')), dbHash, 'edulet.db unchanged');
    // the whole tree: everything that was there is untouched; the only thing that may appear is SQLite's own empty -wal (-shm is skipped)
    const treeAfter = treeOf(dataDir);
    for (const [k, v] of Object.entries(treeBefore)) if (k !== '.') assert.deepEqual(treeAfter[k], v, `${k} untouched`);
    const added = Object.keys(treeAfter).filter((k) => !(k in treeBefore));
    assert.ok(added.every((k) => k === 'edulet.db-wal' && treeAfter[k].size === 0), `only an empty -wal may appear (got ${added})`);

    const a2 = await mk(); // SQLite may leave an empty -wal/-shm after a read-only open: the server must start fine regardless
    try {
      const c = new Client(a2, teacher.cookie);
      const got = await c.get(`/api/boards/${b.slug}`);
      assert.equal(got.status, 200);
      assert.deepEqual(got.json.posts.map((p) => p.title).sort(), ['그리고 또', '꺼지기 전의 글', '또 하나']);
      assert.ok((await makePost(c, got.json.board, { title: '다시 켠 뒤' })).id);
    } finally {
      await a2.close();
    }
  });
});

// ---- concurrent writes ----------------------------------------------------------------------------------------------

describe('backup while writes keep coming in', () => {
  let app;
  before(async () => { app = await startApp({ config: { writeRateMax: 100000 } }); });
  after(async () => { await app.close(); });

  it('5. a snapshot taken by a separate process during a write storm is consistent (integrity ok, a contiguous prefix of the serial writer)', async (t) => {
    const owner = makeUser(app, 'owner');
    const board = await makeBoard(owner, { title: '쓰기 폭풍', linkAccess: 'write' });
    const clients = [owner, makeUser(app, 'w'), makeUser(app, 'w'), makeUser(app, 'w'), makeUser(app, 'w')];
    const out = tmpDir('storm-out');
    const stats = { acked: 0, serial: 0 };
    let stop = false;
    const loop = async (client, tag, serial) => {
      for (let i = 0; !stop && i < 3000; i++) {
        const r = await client.post(`/api/boards/${board.slug}/posts`, { title: `${tag}${i}`, body: '본문' });
        if (r.status !== 201) throw new Error(`write failed ${r.status} ${r.text}`);
        stats.acked++;
        if (serial) stats.serial++;
      }
    };
    const loops = clients.map((c, i) => loop(c, i === 0 ? 's' : `p${i}-`, i === 0).then(() => null, (e) => e));
    while (stats.acked < 40) await sleep(5);

    for (let round = 1; round <= 3; round++) {
      const ackedAtStart = stats.acked;
      const serialAtStart = stats.serial;
      const run = await runCli(['--data', app.dir, '--out', out]);
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.ok(stats.acked > ackedAtStart, 'writes were still going while the backup ran');
      const dir = /백업을 만들었어요: (.+)/.exec(run.stdout)?.[1].trim();
      assert.ok(dir && fs.existsSync(dir), run.stdout);

      withDb(path.join(dir, 'edulet.db'), (db) => {
        assert.equal(one(db, 'PRAGMA integrity_check'), 'ok');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        const posts = Number(one(db, 'SELECT COUNT(*) FROM posts'));
        assert.ok(posts >= ackedAtStart, `every write acknowledged before the backup started is in it (${posts} >= ${ackedAtStart})`);
        const nowPosts = app.db.get('SELECT COUNT(*) AS n FROM posts').n;
        t.diagnostic(`round ${round}: ${ackedAtStart} writes acknowledged when the backup started, ${posts} posts in the snapshot, ${nowPosts} on the server afterwards`);
        assert.ok(posts <= nowPosts, 'never more than the server has');
        const serial = db.prepare("SELECT title FROM posts WHERE title GLOB 's[0-9]*'").all().map((x) => Number(x.title.slice(1))).sort((a, b) => a - b);
        assert.deepEqual(serial, serial.map((_, i) => i), 'the serial writer shows up as an unbroken prefix (a snapshot of ONE moment)');
        assert.ok(serial.length >= serialAtStart);
      });
    }
    stop = true;
    assert.deepEqual((await Promise.all(loops)).filter(Boolean), [], 'no write failed while backups ran');
    assert.ok(stats.acked >= 100, `a real storm (${stats.acked} writes)`);
    // the server is fine afterwards and the original database is healthy
    assert.equal(one(app.db.raw, 'PRAGMA integrity_check'), 'ok');
  });
});

// ---- edge cases: uploads ----------------------------------------------------------------------------------------------

describe('backup: uploads edge cases', () => {
  let app;
  let up;
  before(async () => {
    app = await startApp({ config: { writeRateMax: 100000, uploadRateMax: 100000 } });
    const owner = makeUser(app, 'teacher');
    const board = await makeBoard(owner, { title: '업로드 경계' });
    up = [];
    for (let i = 0; i < 3; i++) {
      const r = await putFile(owner, board.slug, `f${i}.txt`, Buffer.from(`file ${i}`), 'text/plain');
      up.push(r.json);
    }
    await makePost(owner, board, { title: '글' });
  });
  after(async () => { await app.close(); });

  it('a file that vanished (cleaned up while copying) is counted as missing with a warning — not a failure', async () => {
    const img = crashImage(app, 'vanish');
    fs.rmSync(path.join(img, 'uploads', up[1].id));
    const r = await backupData({ dataDir: img, outDir: tmpDir('v-out') });
    assert.deepEqual(r.uploads, { files: 2, bytes: 'file 0'.length + 'file 2'.length, missing: 1 });
    assert.equal(r.warnings.length, 1);
    assert.ok(r.warnings[0].includes(up[1].id));
    assert.deepEqual(names(path.join(r.dir, 'uploads')), [up[0].id, up[2].id].sort());
    assert.ok(fs.readFileSync(path.join(r.dir, 'BACKUP-INFO.txt'), 'utf8').includes(up[1].id), 'the info file lists the warning');
  });

  it('a file whose size differs from its row gets a warning', async () => {
    const img = crashImage(app, 'size');
    fs.appendFileSync(path.join(img, 'uploads', up[0].id), ' more');
    const r = await backupData({ dataDir: img, outDir: tmpDir('s-out') });
    assert.equal(r.uploads.files, 3);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /크기/);
  });

  it('an upload row with a path-like id never reads or writes outside uploads/', async () => {
    const img = crashImage(app, 'evil');
    fs.writeFileSync(path.join(img, 'secret.txt'), 'top secret');
    withDb(path.join(img, 'edulet.db'), (db) => {
      db.prepare("INSERT INTO uploads (id, user_id, board_id, name, mime, size, created_at) VALUES ('../secret.txt', 1, NULL, 'x', 'text/plain', 10, 1)").run();
    }, { readOnly: false });
    const out = tmpDir('e-out');
    const r = await backupData({ dataDir: img, outDir: out });
    assert.equal(r.uploads.missing, 1);
    assert.equal(r.uploads.files, 3);
    assert.equal(r.warnings.length, 1);
    assert.ok(!fs.existsSync(path.join(r.dir, 'secret.txt')) && !fs.existsSync(path.join(r.dir, 'uploads', 'secret.txt')));
    assert.deepEqual(names(out), [path.basename(r.dir)], 'nothing was written next to the backup folder either');
  });

  it('a symlinked upload file is skipped, not followed (counted as missing, with a warning)', async (t) => {
    const img = crashImage(app, 'link');
    const target = path.join(tmpDir('link-target'), 'elsewhere.txt');
    fs.writeFileSync(target, 'outside');
    const file = path.join(img, 'uploads', up[2].id);
    fs.rmSync(file);
    try { fs.symlinkSync(target, file, 'file'); } catch (e) { t.skip(`cannot create symlinks here (${e.code})`); return; }
    const r = await backupData({ dataDir: img, outDir: tmpDir('l-out') });
    assert.deepEqual(r.uploads, { files: 2, bytes: 'file 0'.length + 'file 1'.length, missing: 1 });
    assert.ok(!fs.existsSync(path.join(r.dir, 'uploads', up[2].id)));
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /바로가기/);
  });

  it('an uploads FOLDER that is a junction/symlink (moved to another drive) IS followed — with one warning naming the target', async () => {
    const img = crashImage(app, 'ujunction');
    const real = path.join(tmpDir('u-real'), 'files');
    fs.renameSync(path.join(img, 'uploads'), real);
    fs.symlinkSync(real, path.join(img, 'uploads'), 'junction');
    const before = treeOf(real);
    const r = await backupData({ dataDir: img, outDir: tmpDir('u-out') });
    assert.deepEqual(r.uploads, { files: 3, bytes: 'file 0'.length * 3, missing: 0 }, 'the photos/files are in the backup');
    assert.deepEqual(names(path.join(r.dir, 'uploads')), up.map((x) => x.id).sort());
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /uploads 가 바로가기.*따라갔어요/);
    assert.ok(r.warnings[0].includes(fs.realpathSync.native(real)), 'the warning names where it went');
    assert.deepEqual(treeOf(real), before, 'the real upload files were only read');
  });

  it('a symlinked uploads folder whose target is gone or is not a folder: nothing copied, loud warning, no crash', async () => {
    const img = crashImage(app, 'ubroken');
    const holder = tmpDir('u-broken');
    fs.rmSync(path.join(img, 'uploads'), { recursive: true });
    const target = path.join(holder, 'gone');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(img, 'uploads'), 'junction');
    fs.rmdirSync(target);
    const r = await backupData({ dataDir: img, outDir: tmpDir('ub-out') });
    assert.deepEqual(r.uploads, { files: 0, bytes: 0, missing: 3 });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /가리키는 곳이 없어요/);
  });

  it('a source without any uploads folder is fine when there are no upload rows (no warning, an empty uploads/ in the backup)', async () => {
    const dataDir = tmpDir('nouploads');
    const schema = await backupData({ dataDir: crashImage(app, 'schema'), outDir: tmpDir('schema-out') }); // a database with the real schema
    fs.copyFileSync(path.join(schema.dir, 'edulet.db'), path.join(dataDir, 'edulet.db'));
    withDb(path.join(dataDir, 'edulet.db'), (d) => d.exec('DELETE FROM uploads'), { readOnly: false });
    assert.ok(!fs.existsSync(path.join(dataDir, 'uploads')));
    const r = await backupData({ dataDir, outDir: tmpDir('nouploads-out') });
    assert.deepEqual(r.uploads, { files: 0, bytes: 0, missing: 0 });
    assert.deepEqual(r.warnings, []);
    assert.ok(fs.statSync(path.join(r.dir, 'uploads')).isDirectory());
  });
});

// ---- failure paths --------------------------------------------------------------------------------------------------

describe('backup: refusals and failures leave nothing behind', () => {
  let app;
  before(async () => {
    app = await startApp();
    const owner = makeUser(app, 'teacher');
    const board = await makeBoard(owner, { title: '실패 경로' });
    await makePost(owner, board, { title: '글' });
  });
  after(async () => { await app.close(); });

  const rejects = async (p, re) => {
    await assert.rejects(p, (e) => { assert.ok(e instanceof BackupError, `BackupError expected, got ${e && e.stack}`); assert.match(e.message, re); return true; });
  };

  it('6a. no data folder / no edulet.db -> refused with the "data 폴더를 찾을 수 없어요" message, nothing created', async () => {
    const root = tmpDir('nodata');
    const out = path.join(root, 'out');
    const missing = path.join(root, 'nope');
    await rejects(backupData({ dataDir: missing, outDir: out }), /data 폴더를 찾을 수 없어요: .*nope.*서버를 켠 폴더의 data/);
    assert.ok(!fs.existsSync(out), 'the out folder was not even created');
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    await rejects(backupData({ dataDir: empty, outDir: out }), /data 폴더를 찾을 수 없어요/);
    assert.deepEqual(names(empty), [], 'an empty data folder stays empty (no database got created)');
    assert.ok(!fs.existsSync(out));
  });

  it('6b. out inside data -> refused (also through ".." and a junction), a similar-looking sibling is fine', async () => {
    const img = crashImage(app, 'guard');
    const before = names(img);
    await rejects(backupData({ dataDir: img, outDir: path.join(img, 'backups') }), /data 폴더 안에/);
    await rejects(backupData({ dataDir: img, outDir: img }), /data 폴더 안에/);
    await rejects(backupData({ dataDir: img, outDir: path.join(img, 'uploads', 'x', 'y') }), /data 폴더 안에/);
    await rejects(backupData({ dataDir: img, outDir: path.join(img, 'sub', '..', 'backups') }), /data 폴더 안에/);
    const hold = tmpDir('guard-link');
    const link = path.join(hold, 'to-data');
    fs.symlinkSync(img, link, 'junction');
    await rejects(backupData({ dataDir: img, outDir: path.join(link, 'backups') }), /data 폴더 안에/);
    await rejects(backupData({ dataDir: link, outDir: path.join(img, 'backups') }), /data 폴더 안에/);
    if (process.platform === 'win32') await rejects(backupData({ dataDir: img, outDir: path.join(img.toUpperCase(), 'backups') }), /data 폴더 안에/);
    assert.deepEqual(names(img), before, 'nothing was created inside the data folder');

    // prefix trap: "<data>-backups" is NOT inside "<data>"
    const sibling = `${img}-backups`;
    made.push(sibling);
    const r = await backupData({ dataDir: img, outDir: sibling });
    assert.ok(fs.existsSync(path.join(r.dir, 'edulet.db')));
  });

  it('6c. the same second twice -> -2, -3 (local-time name), earlier backups are never reused or overwritten', async () => {
    const img = crashImage(app, 'same');
    const out = tmpDir('same-out');
    const now = new Date(2026, 9, 22, 15, 30, 5); // local time on purpose
    const a = await backupData({ dataDir: img, outDir: out, now });
    const infoBefore = hashFile(path.join(a.dir, 'BACKUP-INFO.txt'));
    const b = await backupData({ dataDir: img, outDir: out, now });
    const c = await backupData({ dataDir: img, outDir: out, now });
    assert.deepEqual([a, b, c].map((x) => path.basename(x.dir)), ['edulet-20261022-153005', 'edulet-20261022-153005-2', 'edulet-20261022-153005-3']);
    assert.equal(path.dirname(a.dir), path.resolve(out));
    assert.ok(path.isAbsolute(a.dir));
    assert.equal(hashFile(path.join(a.dir, 'BACKUP-INFO.txt')), infoBefore, 'the first backup was not touched by the later ones');
    assert.deepEqual(names(out), ['edulet-20261022-153005', 'edulet-20261022-153005-2', 'edulet-20261022-153005-3']);
  });

  it('6d. a database that is not an Edulet database fails verification: only THIS run\'s folder is removed, earlier backups stay', async () => {
    const good = crashImage(app, 'good');
    const out = tmpDir('fail-out');
    const keep = await backupData({ dataDir: good, outDir: out, now: new Date(2026, 0, 1, 0, 0, 0) });
    const keepHash = hashFile(path.join(keep.dir, 'edulet.db'));
    fs.writeFileSync(path.join(out, 'my-notes.txt'), 'not a backup');
    const entries = names(out);

    const wrong = tmpDir('wrong');
    withDb(path.join(wrong, 'edulet.db'), (d) => d.exec('CREATE TABLE x(a); INSERT INTO x VALUES (1)'), { readOnly: false });
    await rejects(backupData({ dataDir: wrong, outDir: out, now: new Date(2026, 0, 1, 0, 0, 1) }), /확인하지 못했어요/);
    assert.deepEqual(names(out), entries, 'no half-made folder, nothing else removed');
    assert.equal(hashFile(path.join(keep.dir, 'edulet.db')), keepHash);
  });

  it('6e. a corrupt database fails the same way (no folder left, earlier backups intact)', async () => {
    const out = tmpDir('corrupt-out');
    const keep = await backupData({ dataDir: crashImage(app, 'good2'), outDir: out, now: new Date(2026, 0, 1, 0, 0, 0) });
    const entries = names(out);
    const bad = tmpDir('corrupt');
    fs.writeFileSync(path.join(bad, 'edulet.db'), Buffer.alloc(16384, 7));
    await rejects(backupData({ dataDir: bad, outDir: out }), /데이터베이스를 복사하지 못했어요/);
    assert.deepEqual(names(out), entries);
    assert.ok(fs.existsSync(path.join(keep.dir, 'BACKUP-INFO.txt')));
    // a half-valid file: a real database with its pages damaged
    const damaged = crashImage(app, 'damaged');
    withDb(path.join(damaged, 'edulet.db'), (d) => { d.exec('PRAGMA journal_mode = DELETE'); }, { readOnly: false });
    for (const n of ['edulet.db-wal', 'edulet.db-shm']) fs.rmSync(path.join(damaged, n), { force: true });
    const buf = fs.readFileSync(path.join(damaged, 'edulet.db'));
    for (let off = 4096; off < buf.length; off += 97) buf[off] = (buf[off] + 1) & 0xff;
    fs.writeFileSync(path.join(damaged, 'edulet.db'), buf);
    await assert.rejects(backupData({ dataDir: damaged, outDir: out }), BackupError);
    assert.deepEqual(names(out), entries);
  });

  it('6f. verifySnapshot rejects a database whose integrity_check is not "ok" (every table still reads fine)', () => {
    const dir = tmpDir('verify');
    const file = path.join(dir, 'edulet.db');
    // a row that breaks a CHECK constraint (written with ignore_check_constraints, which even SQLite's "defensive" mode allows — unlike
    // editing sqlite_master, which Node 24 refuses): counting and reading still work, only integrity_check complains
    withDb(file, (d) => {
      d.exec('CREATE TABLE boards(id INTEGER PRIMARY KEY, slug TEXT); CREATE TABLE posts(id INTEGER PRIMARY KEY, t TEXT, created_at INTEGER CHECK (created_at > 0)); CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE uploads(id TEXT, size INTEGER, created_at INTEGER)');
      for (let i = 0; i < 50; i++) d.prepare('INSERT INTO posts (t, created_at) VALUES (?, ?)').run(`row ${i}`, 1000 + i);
    }, { readOnly: false });
    const healthy = verifySnapshot(file);
    assert.equal(healthy.counts.posts, 50, 'a healthy file passes');
    assert.equal(healthy.latestPostAt, 1049, 'the newest post time is read from the snapshot');
    withDb(file, (d) => {
      d.exec('PRAGMA ignore_check_constraints = ON');
      d.exec("INSERT INTO posts (t, created_at) VALUES ('violates the CHECK', -5)");
      d.exec('PRAGMA ignore_check_constraints = OFF');
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 51, 'the damaged table still reads fine');
    }, { readOnly: false });
    assert.throws(() => verifySnapshot(file), (e) => e instanceof BackupError && /integrity_check/.test(e.message));
  });

  it('6h. the cleanup helper only ever deletes a direct edulet-YYYYMMDD-HHMMSS child of <out>', () => {
    const out = tmpDir('guard-rm');
    const mk = (...p) => { const d = path.join(out, ...p); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'keep.txt'), 'x'); return d; };
    const own = mk('edulet-20261022-153005-2');
    const nested = mk('edulet-20261022-153005', 'edulet-20261022-153006');
    const other = mk('important');
    const lookalike = mk('edulet-backup-old');
    const outside = tmpDir('outside-of-out');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    const named = path.join(outside, 'edulet-20261022-153005');
    fs.mkdirSync(named);
    for (const bad of [out, nested, other, lookalike, outside, named, path.join(out, '..', path.basename(outside), 'edulet-20261022-153005'), path.join(out, 'edulet-20261022-153005-2', '..')]) {
      assert.equal(removeOwnBackup(out, bad), false, `must refuse ${bad}`);
    }
    for (const d of [nested, other, lookalike, outside, named]) assert.ok(fs.existsSync(d), `${d} is still there`);
    assert.equal(fs.readFileSync(path.join(nested, 'keep.txt'), 'utf8'), 'x');
    assert.equal(removeOwnBackup(out, own), true);
    assert.ok(!fs.existsSync(own));
    assert.ok(fs.existsSync(other) && fs.existsSync(nested));
    // the working folder name is accepted (that is what a failed run removes) — but still only as a direct child of <out>
    const part = mk('edulet-20261022-153005-3.partial');
    const nestedPart = mk('important', 'edulet-20261022-153005.partial');
    const doubled = mk('edulet-20261022-153005.partial.partial');
    const odd = mk('edulet-20261022-153005.partial2');
    for (const bad of [nestedPart, doubled, odd]) assert.equal(removeOwnBackup(out, bad), false, `must refuse ${bad}`);
    assert.ok(fs.existsSync(nestedPart) && fs.existsSync(doubled) && fs.existsSync(odd));
    assert.equal(removeOwnBackup(out, part), true);
    assert.ok(!fs.existsSync(part));
  });

  it('6i. an out path that is a file (not a folder) is refused without touching it', async () => {
    const img = crashImage(app, 'outfile');
    const f = path.join(tmpDir('outfile-holder'), 'iam-a-file');
    fs.writeFileSync(f, 'precious');
    await rejects(backupData({ dataDir: img, outDir: f }), /준비하지 못했어요/);
    assert.equal(fs.readFileSync(f, 'utf8'), 'precious');
    await rejects(backupData({ dataDir: img, outDir: path.join(f, 'sub') }), /준비하지 못했어요/);
  });

  it('6g. bad arguments are refused', async () => {
    await rejects(backupData({ outDir: tmpDir('a') }), /dataDir/);
    await rejects(backupData({ dataDir: tmpDir('b') }), /outDir/);
    await rejects(backupData({ dataDir: tmpDir('c'), outDir: tmpDir('d'), now: new Date('nope') }), /Date/);
  });
});

// ---- CLI ------------------------------------------------------------------------------------------------------------

describe('backup CLI (child process)', () => {
  let app;
  let img;
  let upload;
  before(async () => {
    app = await startApp();
    const owner = makeUser(app, 'teacher');
    const board = await makeBoard(owner, { title: 'CLI 보드' });
    await makeBoard(owner, { title: 'CLI 둘째' });
    for (const t of ['글 하나', '글 둘', '글 셋']) await makePost(owner, board, { title: t });
    upload = (await putFile(owner, board.slug, 'cli.txt', Buffer.from('cli file'), 'text/plain')).json;
    img = crashImage(app, `it's cli`); // an apostrophe + space + Korean in the path
  });
  after(async () => { await app.close(); });

  it('7a. success: exit 0, prints the absolute backup folder and a one-line summary (works with --data/--out and --data=/--out=)', async () => {
    const out = tmpDir('cli (백업)');
    const r = await runCli(['--data', img, '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    const made1 = names(out);
    assert.equal(made1.length, 1);
    assert.match(made1[0], /^edulet-\d{8}-\d{6}$/);
    const dir = path.join(out, made1[0]);
    assert.ok(r.stdout.includes(dir), `stdout names the absolute folder: ${r.stdout}`);
    assert.match(r.stdout, /보드 2개 · 글 3개 · 사용자 1명/);
    assert.deepEqual(names(dir), BACKUP_ENTRIES);

    const out2 = tmpDir('cli2');
    const r2 = await runCli([`--data=${img}`, `--out=${out2}`]);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(names(out2).length, 1);
  });

  it('7b. no --data: EDULET_DATA_DIR is used', async () => {
    const out = tmpDir('cli-env');
    const r = await runCli(['--out', out], { env: { EDULET_DATA_DIR: img }, cwd: tmpDir('cli-cwd') });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(names(out).length, 1);
  });

  it('7c. failure: exit 1 with a clear Korean message and nothing created', async () => {
    const root = tmpDir('cli-fail');
    const missing = await runCli(['--data', path.join(root, 'nope'), '--out', path.join(root, 'out')]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /백업에 실패했어요: data 폴더를 찾을 수 없어요/);
    assert.ok(!fs.existsSync(path.join(root, 'out')));

    const inside = await runCli(['--data', img, '--out', path.join(img, 'backups')]);
    assert.equal(inside.code, 1);
    assert.match(inside.stderr, /data 폴더 안에/);
    assert.ok(!fs.existsSync(path.join(img, 'backups')));

    for (const bad of [['--nope'], ['--data'], ['--out', '--data', img], ['stray']]) {
      const r = await runCli(bad);
      assert.equal(r.code, 1, bad.join(' '));
      assert.match(r.stderr, /사용법/);
    }
  });

  it('7e. a backup that skipped something exits 2 (not 0): the folder is kept, stdout opens with the notice, warnings go to stderr', async () => {
    const broken = crashImage(app, 'cli-warn');
    fs.rmSync(path.join(broken, 'uploads', upload.id));
    const out = tmpDir('cli-warn-out');
    const r = await runCli(['--data', broken, '--out', out]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.ok(r.stdout.startsWith('주의: 백업을 만들었지만 일부가 빠졌을 수 있어요'), r.stdout);
    assert.match(r.stderr, /경고: .*업로드 파일 1개/);
    assert.ok(r.stderr.includes(upload.id));
    assert.equal(names(out).length, 1, 'the backup folder is kept');
    assert.deepEqual(names(path.join(out, names(out)[0])), BACKUP_ENTRIES);
    // a complete one: exit 0 and no notice
    const ok = await runCli(['--data', img, '--out', tmpDir('cli-ok-out')]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(!ok.stdout.includes('주의:'), ok.stdout);
    assert.equal(ok.stderr, '');
  });

  it('7f. plain `node tools/backup.mjs` (without the warning flag) prints no ExperimentalWarning noise', async () => {
    const out = tmpDir('cli-quiet');
    const r = await runNode([CLI, '--data', img, '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!/ExperimentalWarning|SQLite is an experimental/i.test(r.stderr), r.stderr);
  });

  it('7d. --help exits 0 and creates nothing', async () => {
    const r = await runCli(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /사용법/);
  });

  it('defaults do not depend on the current folder (the server uses ./data of the current folder; this tool uses its own location)', async () => {
    const elsewhere = tmpDir('defaults-cwd');
    const code = `import(${JSON.stringify(pathToFileURL(CLI).href)}).then((m) => console.log(JSON.stringify(m.defaultPaths({}))))`;
    const r = await runNode(['--disable-warning=ExperimentalWarning', '-e', code], { cwd: elsewhere, env: { EDULET_DATA_DIR: '' } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { dataDir: path.join(ROOT, 'data'), outDir: path.join(ROOT, 'backups') });
    assert.notEqual(path.resolve(elsewhere, 'data'), path.join(ROOT, 'data'));
  });

  it('defaults: data = $EDULET_DATA_DIR or <repo>/data (file-location based, not the current folder), out = <repo>/backups', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    assert.equal(ROOT, root);
    assert.deepEqual(defaultPaths({}), { dataDir: path.join(root, 'data'), outDir: path.join(root, 'backups') });
    assert.deepEqual(defaultPaths({ EDULET_DATA_DIR: '' }), { dataDir: path.join(root, 'data'), outDir: path.join(root, 'backups') });
    assert.equal(defaultPaths({ EDULET_DATA_DIR: img }).dataDir, path.resolve(img));
    assert.equal(defaultPaths({ EDULET_DATA_DIR: 'rel' }).dataDir, path.resolve('rel'), 'relative values are resolved like the server does');
  });
});

// ---- the .partial working folder, exit codes, what the CLI reports, locked files ----------------------------------------------

/** crashImage + `n` extra upload rows/files (1 byte each) — enough work that a run can be watched (and killed) half way. */
function imageWithUploads(running, n, label) {
  const img = crashImage(running, label);
  const ids = [];
  withDb(path.join(img, 'edulet.db'), (db) => {
    const ins = db.prepare('INSERT INTO uploads (id, user_id, board_id, name, mime, size, created_at) VALUES (?, 1, NULL, ?, ?, 1, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < n; i++) {
      const id = crypto.randomBytes(16).toString('hex');
      ids.push(id);
      ins.run(id, `bulk${i}.bin`, 'application/octet-stream', 1000 + i);
    }
    db.exec('COMMIT');
  }, { readOnly: false });
  for (const id of ids) fs.writeFileSync(path.join(img, 'uploads', id), 'x');
  return { img, ids };
}

describe('backup: the .partial working folder, exit codes, the CLI report, locked files', () => {
  let app;
  let owner;
  let board;
  let up;
  before(async () => {
    app = await startApp({ config: { writeRateMax: 100000, uploadRateMax: 100000 } });
    owner = makeUser(app, 'teacher');
    board = await makeBoard(owner, { title: '부분 폴더' });
    await makeBoard(owner, { title: '둘째 보드' });
    up = [];
    for (let i = 0; i < 3; i++) up.push((await putFile(owner, board.slug, `f${i}.txt`, Buffer.from(`file ${i}`), 'text/plain')).json);
    for (const t of ['글 하나', '글 둘', '글 셋']) await makePost(owner, board, { title: t });
  });
  after(async () => { await app.close(); });

  // -- 1. a normal-looking folder always holds a complete backup ----------------------------------------------------------

  it('while a run is in progress only `<name>.partial` exists; the real name appears only once it is finished (and then the .partial is gone)', async () => {
    const { img } = imageWithUploads(app, 400, 'watch');
    const out = tmpDir('watch-out');
    const listings = [];
    let done = false;
    const run = backupData({ dataDir: img, outDir: out }).finally(() => { done = true; });
    while (!done) {
      listings.push(fs.existsSync(out) ? fs.readdirSync(out).sort() : []);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const r = await run;
    const final = path.basename(r.dir);
    assert.ok(!final.endsWith('.partial'));
    for (const l of listings) {
      assert.ok(l.length === 0 || (l.length === 1 && (l[0] === `${final}.partial` || l[0] === final)), `unexpected listing ${l}`);
    }
    assert.ok(listings.some((l) => l[0] === `${final}.partial`), `the .partial folder was visible during the run (${listings.length} looks)`);
    const firstSeen = listings.find((l) => l.length === 1);
    assert.equal(firstSeen[0], `${final}.partial`, 'the first thing to appear is the .partial, never the real name');
    assert.deepEqual(names(out), [final]);
    assert.deepEqual(names(r.dir), BACKUP_ENTRIES);
    assert.ok(fs.readFileSync(path.join(r.dir, 'BACKUP-INFO.txt'), 'utf8').includes(`백업 폴더   : ${r.dir}`), 'the info file names the final folder, not the .partial');
  });

  it('a run killed half way (SIGKILL) leaves only a .partial — no BACKUP-INFO.txt, nothing that looks finished — and the next run leaves it alone', async () => {
    const { img } = imageWithUploads(app, 2500, 'kill');
    const out = tmpDir('kill-out');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, '--data', img, '--out', out], { windowsHide: true });
    let exitCode = 'running';
    const closed = new Promise((resolve) => child.on('close', (c) => { exitCode = c; resolve(); }));
    let partial = null;
    const deadline = Date.now() + 30000;
    while (exitCode === 'running' && Date.now() < deadline) {
      const found = (fs.existsSync(out) ? fs.readdirSync(out) : []).find((n) => n.endsWith('.partial'));
      if (found) {
        const uploadsDir = path.join(out, found, 'uploads');
        if (fs.existsSync(uploadsDir) && fs.readdirSync(uploadsDir).length > 40) { partial = found; child.kill('SIGKILL'); break; }
      }
      await sleep(2);
    }
    await closed;
    assert.ok(partial, `a .partial folder with uploads being copied was seen before the child ended (exit ${exitCode})`);
    assert.deepEqual(names(out), [partial], 'only the .partial is left — no folder with a normal name');
    assert.ok(!fs.existsSync(path.join(out, partial, 'BACKUP-INFO.txt')));
    const leftover = treeOf(path.join(out, partial));

    const next = await backupData({ dataDir: img, outDir: out });
    assert.equal(next.uploads.missing, 0);
    assert.ok(!path.basename(next.dir).endsWith('.partial'));
    assert.deepEqual(treeOf(path.join(out, partial)), leftover, 'the cut-off folder is not cleaned up automatically (a concurrent run could own it)');
    assert.deepEqual(names(out), [partial, path.basename(next.dir)].sort());
  });

  it('names: a `.partial` or a finished folder of the same second both make the next run take -2, -3, -4 (nothing reused, nothing deleted)', async () => {
    const out = tmpDir('names-out');
    const now = new Date(2026, 9, 22, 15, 30, 5);
    fs.mkdirSync(path.join(out, 'edulet-20261022-153005.partial')); // a cut-off earlier run
    fs.writeFileSync(path.join(out, 'edulet-20261022-153005.partial', 'edulet.db'), 'half');
    const a = await backupData({ dataDir: crashImage(app, 'n1'), outDir: out, now });
    assert.equal(path.basename(a.dir), 'edulet-20261022-153005-2');
    fs.mkdirSync(path.join(out, 'edulet-20261022-153005-3')); // a finished one that is not ours
    fs.writeFileSync(path.join(out, 'edulet-20261022-153005-3', 'BACKUP-INFO.txt'), 'old');
    const b = await backupData({ dataDir: crashImage(app, 'n2'), outDir: out, now });
    assert.equal(path.basename(b.dir), 'edulet-20261022-153005-4');
    assert.equal(fs.readFileSync(path.join(out, 'edulet-20261022-153005.partial', 'edulet.db'), 'utf8'), 'half');
    assert.equal(fs.readFileSync(path.join(out, 'edulet-20261022-153005-3', 'BACKUP-INFO.txt'), 'utf8'), 'old');
    assert.deepEqual(names(out), ['edulet-20261022-153005-2', 'edulet-20261022-153005-3', 'edulet-20261022-153005-4', 'edulet-20261022-153005.partial']);
  });

  it('a failure after the work started removes only this run\'s .partial (a copy error injected into fs.copyFile)', async (t) => {
    const out = tmpDir('fail-partial-out');
    const keep = await backupData({ dataDir: crashImage(app, 'fp0'), outDir: out, now: new Date(2026, 0, 1, 0, 0, 0) });
    const sibling = path.join(out, 'edulet-20250101-000000.partial'); // somebody else's cut-off run: not ours to delete
    fs.mkdirSync(sibling);
    const before = names(out);
    const orig = fsp.copyFile;
    let calls = 0;
    t.mock.method(fsp, 'copyFile', async (...a) => {
      if (++calls === 2) throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
      return orig.apply(fsp, a);
    });
    await assert.rejects(backupData({ dataDir: crashImage(app, 'fp1'), outDir: out }), /ENOSPC/);
    assert.ok(calls >= 2);
    assert.deepEqual(names(out), before, 'no half-made folder (partial or not); the earlier backup and the foreign .partial are untouched');
    assert.ok(fs.existsSync(path.join(keep.dir, 'BACKUP-INFO.txt')));
  });

  // -- 2. an incomplete backup must not look complete ---------------------------------------------------------------------

  it('a symlinked uploads folder is followed by the CLI: exit 2 with the notice, the photos are in the backup, the folder is kept', async () => {
    const img = crashImage(app, 'cli-link');
    const real = path.join(tmpDir('cli-link-real'), 'moved');
    fs.renameSync(path.join(img, 'uploads'), real);
    fs.symlinkSync(real, path.join(img, 'uploads'), 'junction');
    const out = tmpDir('cli-link-out');
    const r = await runCli(['--data', img, '--out', out]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.ok(r.stdout.startsWith('주의: 백업을 만들었지만 일부가 빠졌을 수 있어요'));
    assert.match(r.stderr, /경고: 원본 uploads 가 바로가기.*따라갔어요/);
    const dir = path.join(out, names(out)[0]);
    assert.deepEqual(names(path.join(dir, 'uploads')), up.map((x) => x.id).sort(), 'every upload came along');
  });

  it('exit codes: 0 complete / 1 failed / 2 made-with-warnings — and a skipped file counts even when it is the only warning', async () => {
    const good = crashImage(app, 'ec-good');
    assert.equal((await runCli(['--data', good, '--out', tmpDir('ec-out1')])).code, 0);
    assert.equal((await runCli(['--data', path.join(good, 'nope'), '--out', tmpDir('ec-out2')])).code, 1);
    const lost = crashImage(app, 'ec-lost');
    fs.rmSync(path.join(lost, 'uploads', up[0].id));
    const w = await runCli(['--data', lost, '--out', tmpDir('ec-out3')]);
    assert.equal(w.code, 2);
    assert.match(w.stdout, /업로드 파일 2개/, 'the summary shows how many files made it');
  });

  // -- 3. a stale source must be visible -----------------------------------------------------------------------------------

  it('the CLI prints the source folder, the newest post time and the original WAL\'s last write (read from an open handle)', async () => {
    const img = crashImage(app, 'report');
    const newest = new Date(2026, 2, 4, 5, 6, 7).getTime();
    const walTime = new Date(2026, 1, 3, 4, 5, 6);
    // keep a read-write connection open (= "the server"), make the newest post a known time, and pin the WAL's mtime afterwards
    const live = new DatabaseSync(path.join(img, 'edulet.db'));
    try {
      live.exec('PRAGMA journal_mode = WAL');
      live.prepare('UPDATE posts SET created_at = ? WHERE id = (SELECT MAX(id) FROM posts)').run(newest);
      live.prepare('UPDATE posts SET created_at = ? WHERE id <> (SELECT MAX(id) FROM posts)').run(newest - 86400000);
      const wal = path.join(img, 'edulet.db-wal');
      assert.ok(fs.existsSync(wal) && fs.statSync(wal).size > 0, 'the work is in the WAL');
      fs.utimesSync(wal, walTime, walTime);
      const r = await runCli(['--data', img, '--out', tmpDir('report-out')]);
      assert.equal(r.code, 0, r.stderr);
      const lines = r.stdout.split(/\r?\n/);
      assert.ok(lines.includes(`원본: ${img}`), r.stdout);
      assert.ok(lines.includes(`가장 최근 글: ${fmt(newest)} · 원본 WAL 마지막 수정: ${fmt(walTime.getTime())}`), r.stdout);
      assert.ok(!r.stdout.includes('⚠'), 'a data folder with posts gets no empty-folder warning');
    } finally {
      live.close();
    }
  });

  it('no WAL at all is reported as "WAL 없음"; a data folder without a single post gets the "wrong folder?" warning (exit stays 0)', async () => {
    const clean = await backupData({ dataDir: crashImage(app, 'rep-src'), outDir: tmpDir('rep-src-out') }); // a snapshot is a standalone file: no WAL
    const noWal = tmpDir('no-wal');
    fs.copyFileSync(path.join(clean.dir, 'edulet.db'), path.join(noWal, 'edulet.db'));
    fs.cpSync(path.join(clean.dir, 'uploads'), path.join(noWal, 'uploads'), { recursive: true });
    const a = await runCli(['--data', noWal, '--out', tmpDir('no-wal-out')]);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /원본 WAL 마지막 수정: WAL 없음/);
    assert.match(a.stdout, /가장 최근 글: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d ·/);

    withDb(path.join(noWal, 'edulet.db'), (d) => d.exec('DELETE FROM posts'), { readOnly: false });
    const b = await runCli(['--data', noWal, '--out', tmpDir('empty-out')]);
    assert.equal(b.code, 0, 'only a hint, not an error');
    assert.match(b.stdout, /가장 최근 글: 없음/);
    assert.ok(b.stdout.includes('⚠ 글이 하나도 없어요 — 서버를 켠 폴더의 data 가 맞는지 확인하세요'), b.stdout);
  });

  // -- 4. locked files, one-line errors ---------------------------------------------------------------------------------------

  it('a file that is locked for a moment (EBUSY) is retried and ends up in the backup — no warning', async (t) => {
    const img = crashImage(app, 'busy1');
    const orig = fsp.copyFile;
    const calls = {};
    t.mock.method(fsp, 'copyFile', async (from, to, ...rest) => {
      const id = path.basename(from);
      calls[id] = (calls[id] ?? 0) + 1;
      if (id === up[1].id && calls[id] <= 2) throw Object.assign(new Error('EBUSY: resource busy or locked, copyfile'), { code: 'EBUSY' });
      return orig.call(fsp, from, to, ...rest);
    });
    const r = await backupData({ dataDir: img, outDir: tmpDir('busy1-out') });
    assert.equal(calls[up[1].id], 3, 'tried three times');
    assert.deepEqual(r.uploads, { files: 3, bytes: 18, missing: 0 });
    assert.deepEqual(r.warnings, []);
    assert.equal(fs.readFileSync(path.join(r.dir, 'uploads', up[1].id), 'utf8'), 'file 1');
  });

  it('a file that stays locked (EBUSY / EPERM / EACCES) is skipped after 3 tries: counted as missing + one warning, the backup still succeeds and no stub is left', async (t) => {
    const img = crashImage(app, 'busy2');
    const orig = fsp.copyFile;
    const calls = {};
    const codes = { [up[0].id]: 'EBUSY', [up[2].id]: 'EACCES' };
    t.mock.method(fsp, 'copyFile', async (from, to, ...rest) => {
      const id = path.basename(from);
      calls[id] = (calls[id] ?? 0) + 1;
      if (codes[id]) {
        fs.writeFileSync(to, 'stub'); // a failed copy may leave a stub behind: it must not end up in the backup
        throw Object.assign(new Error(`${codes[id]}: locked`), { code: codes[id] });
      }
      return orig.call(fsp, from, to, ...rest);
    });
    const r = await backupData({ dataDir: img, outDir: tmpDir('busy2-out') });
    assert.equal(calls[up[0].id], 3);
    assert.equal(calls[up[2].id], 3);
    assert.deepEqual(r.uploads, { files: 1, bytes: 6, missing: 2 });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /잠그고 있어/);
    assert.ok(r.warnings[0].includes(up[0].id) && r.warnings[0].includes(up[2].id));
    assert.deepEqual(names(path.join(r.dir, 'uploads')), [up[1].id], 'no stub of a skipped file');
  });

  it('after 5 files gave up, further locked files get one attempt only (a locked folder must not take hours)', async (t) => {
    const { img, ids } = imageWithUploads(app, 7, 'busy3');
    const orig = fsp.copyFile;
    const calls = {};
    t.mock.method(fsp, 'copyFile', async (from, to, ...rest) => {
      const id = path.basename(from);
      if (!ids.includes(id)) return orig.call(fsp, from, to, ...rest);
      calls[id] = (calls[id] ?? 0) + 1;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    const r = await backupData({ dataDir: img, outDir: tmpDir('busy3-out') });
    // the upload rows are copied oldest first: the first 5 get 3 tries each, the other 2 only one
    const attempts = ids.map((id) => calls[id]);
    assert.deepEqual(attempts, [3, 3, 3, 3, 3, 1, 1]);
    assert.equal(r.uploads.missing, 7);
  });

  it('an unexpected failure is ONE Korean line (no stack) — the stack only with EDULET_DEBUG — and exit 1 with nothing left behind', async (t) => {
    const out = tmpDir('oneline-out');
    const orig = fsp.copyFile;
    let n = 0;
    t.mock.method(fsp, 'copyFile', async (...a) => {
      if (++n === 1) throw Object.assign(new Error('ENOSPC: no space left on device, copyfile\nsecond line with details'), { code: 'ENOSPC' });
      return orig.apply(fsp, a);
    });
    const saved = process.env.EDULET_DEBUG;
    try {
      delete process.env.EDULET_DEBUG;
      const lines = [];
      const code = await main(['--data', crashImage(app, 'ol1'), '--out', out], () => {}, (l) => lines.push(l));
      assert.equal(code, 1);
      assert.deepEqual(lines, ['백업에 실패했어요: ENOSPC: no space left on device, copyfile', '원본 data 는 고치지 않았어요.']);
      assert.deepEqual(fs.readdirSync(out), [], 'nothing left behind');

      n = 0;
      process.env.EDULET_DEBUG = '1';
      const dbg = [];
      assert.equal(await main(['--data', crashImage(app, 'ol2'), '--out', out], () => {}, (l) => dbg.push(l)), 1);
      assert.ok(dbg.some((l) => /^\s+at /m.test(l)), 'with EDULET_DEBUG the stack is printed');
      assert.deepEqual(fs.readdirSync(out), []);
    } finally {
      if (saved === undefined) delete process.env.EDULET_DEBUG; else process.env.EDULET_DEBUG = saved;
    }
  });

  it('Windows: a file really locked by another process (FileShare.None) is skipped with the locked warning', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    const img = crashImage(app, 'winlock');
    const target = path.join(img, 'uploads', up[1].id);
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f=[System.IO.File]::Open('${target.replace(/'/g, "''")}','Open','Read','None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 120`], { windowsHide: true });
    try {
      await new Promise((resolve, reject) => {
        let buf = '';
        ps.stdout.setEncoding('utf8').on('data', (d) => { buf += d; if (buf.includes('locked')) resolve(); });
        ps.on('error', reject);
        ps.on('close', () => reject(new Error(`powershell ended early: ${buf}`)));
      });
      const r = await backupData({ dataDir: img, outDir: tmpDir('winlock-out') });
      assert.equal(r.uploads.files, 2);
      assert.equal(r.uploads.missing, 1);
      assert.equal(r.warnings.length, 1);
      assert.match(r.warnings[0], /잠그고 있어/);
    } finally {
      ps.kill();
    }
  });
});

// ---- backup.cmd for real (Windows only) -------------------------------------------------------------------------------------

describe('backup.cmd run by cmd.exe', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  let app;
  let up;
  before(async () => {
    app = await startApp({ config: { writeRateMax: 100000, uploadRateMax: 100000 } });
    const owner = makeUser(app, 'teacher');
    const board = await makeBoard(owner, { title: 'cmd 시험' });
    up = (await putFile(owner, board.slug, 'c.txt', Buffer.from('cmd file'), 'text/plain')).json;
    await makePost(owner, board, { title: '글' });
  });
  after(async () => { await app.close(); });

  /** A throw-away "install" (Korean + space in the path, like D:\앱개발\edulet): backup.cmd + tools\backup.mjs + a data folder next to them. */
  function install(label, { withData = true } = {}) {
    const root = tmpDir(label);
    fs.copyFileSync(path.join(ROOT, 'backup.cmd'), path.join(root, 'backup.cmd'));
    fs.mkdirSync(path.join(root, 'tools'));
    fs.copyFileSync(path.join(ROOT, 'tools', 'backup.mjs'), path.join(root, 'tools', 'backup.mjs'));
    if (withData) fs.cpSync(crashImage(app, `${label}-data`), path.join(root, 'data'), { recursive: true });
    return root;
  }
  // `pause` reads stdin: an empty input ends it at once. cwd is somewhere else on purpose (double-click starts in the file's folder, a shortcut may not).
  const runCmd = (root) => spawnSync('cmd.exe', ['/c', path.join(root, 'backup.cmd')], { cwd: os.tmpdir(), input: '', encoding: 'utf8', env: { ...process.env, EDULET_DATA_DIR: '' } });

  it('complete backup: exit 0, the data folder is found next to the file, backups\\edulet-… is made, the closing line is printed', () => {
    const root = install('cmd-ok');
    const r = runCmd(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Safe to run while the server is on\. Backups are in the backups folder\./);
    assert.ok(!/FAILED|WITH WARNINGS/.test(r.stdout));
    assert.equal(names(path.join(root, 'backups')).length, 1);
    assert.match(r.stdout, /백업을 만들었어요: /);
  });

  it('no data folder: exit 1 and the FAILED line; nothing is created', () => {
    const root = install('cmd-nodata', { withData: false });
    const r = runCmd(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Backup FAILED - see the message above\./);
    assert.match(r.stderr, /data 폴더를 찾을 수 없어요/);
    assert.ok(!fs.existsSync(path.join(root, 'backups')));
    assert.match(r.stdout, /Safe to run while the server is on\./, 'the closing line is always last');
  });

  it('a backup with a warning: exit 2 and the WITH WARNINGS line; the folder is kept', () => {
    const root = install('cmd-warn');
    fs.rmSync(path.join(root, 'data', 'uploads', up.id));
    const r = runCmd(root);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /Backup finished WITH WARNINGS - read the messages above\./);
    assert.ok(!/Backup FAILED/.test(r.stdout));
    assert.match(r.stdout, /주의: 백업을 만들었지만 일부가 빠졌을 수 있어요/);
    assert.equal(names(path.join(root, 'backups')).length, 1);
    assert.ok(r.stdout.trimEnd().split(/\r?\n/).some((l) => /^Safe to run/.test(l)));
  });
});

// ---- repo plumbing --------------------------------------------------------------------------------------------------

describe('backup: repository plumbing', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f));
  it('backups/ is ignored by git and docker (user data must never be committed or baked into an image)', () => {
    assert.match(read('.gitignore').toString('utf8'), /^backups\/\s*$/m);
    assert.match(read('.dockerignore').toString('utf8'), /^backups\s*$/m);
  });
  it('a backup made anywhere in the repo (`--out .`) is ignored too: finished, numbered and .partial folders, at any depth (git check-ignore)', (t) => {
    const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' });
    if (probe.status !== 0) { t.skip('not a git work tree (or no git)'); return; }
    const ignored = (p) => {
      const r = spawnSync('git', ['check-ignore', '-q', '--', p], { cwd: ROOT, encoding: 'utf8' });
      assert.ok(r.status === 0 || r.status === 1, `git check-ignore failed: ${r.stderr}`);
      return r.status === 0;
    };
    for (const p of ['edulet-20261022-153005/edulet.db', 'edulet-20261022-153005-2/BACKUP-INFO.txt', 'edulet-20261022-153005.partial/uploads/x', 'edulet-20261022-153005-12.partial/edulet.db', 'some/where/edulet-20261022-153005/edulet.db', 'backups/edulet-20261022-153005/edulet.db']) {
      assert.ok(ignored(p), `${p} must be git-ignored (it holds password hashes and sessions)`);
    }
    assert.ok(!ignored('edulet-notes/readme.md') && !ignored('tools/backup.mjs') && !ignored('backup.cmd') && !ignored('test/backup.test.js'), 'the pattern does not swallow real files');
    assert.match(read('.dockerignore').toString('utf8'), /^\*\*\/edulet-\?{8}-\?{6}\*\s*$/m);
  });
  it('backup.cmd: CRLF, ASCII only, runs from its own folder, calls the tool, pauses', () => {
    const b = read('backup.cmd');
    assert.ok(b.length > 0);
    assert.ok(![...b].some((x) => x > 126 || (x < 32 && x !== 13 && x !== 10)), 'printable ASCII only (no control characters, no Korean)');
    const text = b.toString('latin1');
    assert.ok(!/(^|[^\r])\n/.test(text), 'every line ends with CRLF');
    assert.match(text, /cd \/d "%~dp0"/);
    assert.match(text, /where node/);
    assert.match(text, /node --disable-warning=ExperimentalWarning tools\\backup\.mjs %\*/);
    assert.match(text, /Safe to run while the server is on\. Backups are in the backups folder\./);
    assert.match(text, /\bpause\b/);
    assert.match(text, /WITH WARNINGS/);
    assert.match(text, /FAILED/);
    assert.match(text, /exit \/b %RC%/);
  });
});
