// 불러오기(복원)의 핵심: 백업 하나를 서버가 켜진 채로 살아 있는 DB 에 되돌려 넣는다. CONTRACT §5 "저장하기·불러오기".
//
// 안전 규칙 (순서가 곧 안전이다):
//  1. 백업 폴더는 읽기 전용으로만 다룬다 — 그 안에서 SQLite 를 열면 -wal/-shm 이 생겨 백업이 바뀐다. DB 는 OS 임시 폴더로 복사해서만 연다.
//  2. 어느 단계에서 실패하든 서버의 현재 데이터는 그대로다. 현재 데이터를 건드리는 단계는 맨 끝의 swapDatabase 하나뿐이고, 그것도 한 트랜잭션이다.
//  3. 교체 직전에 현재 상태를 안전 저장(kind 'before-restore')하고, 그 사이에 DB 에 쓰기가 있었으면(total_changes 가 달라짐) 안전 저장이
//     최신이 아니므로 다시 한다. 마지막 검사와 교체 사이에는 await 가 없다 — 데이터 손실을 막는 마지막 방어선이다.
//  4. 연결을 닫고 다시 열지 않는다: 다른 모듈이 `const { db } = app` 래퍼와 그 안의 준비된 문장을 붙잡고 있다. 같은 연결에서 ATTACH + 표 복사로 바꾼다.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackupError, backupData, removeOwnBackup } from './backup.js';
import { SCHEMA_VERSION, openDb } from './db.js';
import { HttpError } from './http.js';
import { DatabaseSync } from './sqlite.js';
import { uploadsDir } from './uploads.js';

const UPLOAD_ID = /^[0-9a-f]{32}$/;
const ALIAS = 'edulet_backup'; // the attached copy while swapping
const SAFETY_TRIES = 3;
const SHOW_IDS = 5;
const MAX_COUNTER = Math.floor(Number.MAX_SAFE_INTEGER / 2); // biggest AUTOINCREMENT counter / id a backup may carry (about 4.5e15)

const invalid = (message) => new HttpError(422, 'backup_invalid', message);
const dataChanged = () => new HttpError(409, 'data_changed', '그동안 다른 변경이 있어 중단했어요. 다시 해 주세요.');
const q = (name) => `"${String(name).replace(/"/g, '""')}"`; // table / column names come from sqlite_master, still quoted properly
const some = (ids) => (ids.length > SHOW_IDS ? `${ids.slice(0, SHOW_IDS).join(', ')} …외 ${ids.length - SHOW_IDS}개` : ids.join(', '));
const oneLine = (s) => String(s ?? '').split(/\r?\n/)[0].slice(0, 300);

// ---- schema helpers ------------------------------------------------------------------------------------------------

const userTables = (raw, schema) => raw
  .prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' ORDER BY name`).all()
  .map((r) => String(r.name)).filter((n) => !n.startsWith('sqlite_'));
const columnsOf = (raw, schema, table) => raw.prepare(`PRAGMA ${schema}.table_info(${q(table)})`).all().map((r) => String(r.name));

let expected = null;
/** table -> columns of the schema this server creates (every migration applied to an in-memory database): what a backup must contain. */
export function expectedSchema() {
  if (expected) return expected;
  const db = openDb(':memory:');
  try {
    const m = new Map();
    for (const t of userTables(db.raw, 'main')) m.set(t, columnsOf(db.raw, 'main', t));
    expected = m;
  } finally {
    db.close();
  }
  return expected;
}

/** Parents before children (foreign keys), so DELETE can go in reverse and INSERT forwards. A cycle (there is none) is broken arbitrarily. */
function fkOrder(raw, tables) {
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const t of tables) {
    for (const r of raw.prepare(`PRAGMA main.foreign_key_list(${q(t)})`).all()) {
      const parent = String(r.table);
      if (parent !== t && deps.has(parent)) deps.get(t).add(parent);
    }
  }
  const out = [];
  const done = new Set();
  while (out.length < tables.length) {
    const left = tables.filter((t) => !done.has(t));
    const ready = left.filter((t) => [...deps.get(t)].every((p) => done.has(p)));
    for (const t of ready.length ? ready : left.slice(0, 1)) { out.push(t); done.add(t); }
  }
  return out;
}

const sequences = (raw, schema) => {
  const has = raw.prepare(`SELECT 1 AS x FROM ${schema}.sqlite_master WHERE name = 'sqlite_sequence'`).get();
  const m = new Map();
  if (has) for (const r of raw.prepare(`SELECT name, seq FROM ${schema}.sqlite_sequence`).all()) m.set(String(r.name), Number(r.seq));
  return m;
};

// ---- looking at a backup's database (only ever a COPY in the OS temp folder) -----------------------------------------------

/** Run `fn(db)` on a normal connection to `file`; HttpError passes through, anything SQLite throws becomes "not a usable Edulet database". */
function withCopy(file, fn) {
  let db;
  try {
    db = new DatabaseSync(file);
    // The file is somebody else's input: nothing in its schema may run code of its own (functions in views/triggers/CHECKs), and we only read.
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA query_only = ON');
    return fn(db);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw invalid('저장본의 데이터베이스를 읽을 수 없어요(손상됐거나 Edulet 의 파일이 아니에요).');
  } finally {
    try { db?.close(); } catch { /* nothing to do */ }
  }
}

/**
 * Edulet's database holds tables and indexes, nothing else. A view or trigger in a backup is not ours: a view named `boards` made of a
 * 30-million-row recursive query would make every `SELECT COUNT(*) FROM boards` (the list, the preview) run for minutes. Refuse before
 * anything is counted; boards/posts/users must be real tables (every Edulet version has them).
 */
export function assertPlainSchema(db) {
  const objects = db.prepare('SELECT type, name FROM sqlite_master').all();
  const odd = objects.find((o) => o.type !== 'table' && o.type !== 'index');
  if (odd) throw invalid(`저장본에 Edulet 이 만들지 않은 항목(${String(odd.type).replace(/[^a-z]/g, '')})이 들어 있어서 불러올 수 없어요.`);
  for (const t of ['boards', 'posts', 'users']) {
    if (!objects.some((o) => o.type === 'table' && o.name === t)) throw invalid(`저장본에 '${t}' 표가 없어요(필수 정보가 빠진 파일이에요).`);
  }
}

/** boards/posts/users/latest post of a database file (a COPY), or null when it cannot be used. For the list of older backups: cheap, never throws. */
export function peekCounts(file) {
  try {
    return withCopy(file, (db) => {
      assertPlainSchema(db);
      const n = (sql) => Number(Object.values(db.prepare(sql).get())[0]);
      const newest = Object.values(db.prepare('SELECT MAX(created_at) FROM posts').get())[0];
      return { boards: n('SELECT COUNT(*) FROM boards'), posts: n('SELECT COUNT(*) FROM posts'), users: n('SELECT COUNT(*) FROM users'), latestPostAt: newest == null ? null : Number(newest) };
    });
  } catch {
    return null;
  }
}

/** Is the file a sound SQLite database of a version this server knows? (No table checks yet — an old version has fewer tables.) */
function probe(file) {
  return withCopy(file, (db) => {
    // a NORMAL connection: a read-only one skips the CHECK-constraint part of integrity_check (CLAUDE.md "함정")
    const rows = db.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r)[0]));
    if (rows.length !== 1 || rows[0] !== 'ok') throw invalid(`저장본의 데이터베이스가 손상됐어요(${oneLine(rows[0])}).`);
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (version > SCHEMA_VERSION) throw invalid(`더 새로운 Edulet(데이터 형식 ${version})로 만든 저장본이에요. 이 Edulet 을 최신으로 바꾼 뒤에 불러오세요.`);
    if (version < 1) throw invalid('Edulet 의 저장본이 아니에요(데이터 형식 정보가 없어요).');
    assertPlainSchema(db); // before anything migrates or counts it
    return { version };
  });
}

/** Bring an older copy up to the current schema with the server's own migrations — on the COPY, never on the backup. */
function migrate(file) {
  let db;
  try {
    db = openDb(file);
    db.raw.exec('PRAGMA journal_mode = DELETE'); // no -wal/-shm beside the temp copy
  } catch {
    throw invalid('옛 형식의 저장본을 새 형식으로 바꾸지 못했어요.');
  } finally {
    try { db?.close(); } catch { /* nothing to do */ }
  }
}

/** Tables/columns complete, foreign keys consistent; then the facts the list, the preview and the upload step need. */
function examine(file) {
  return withCopy(file, (db) => {
    const have = new Map(userTables(db, 'main').map((t) => [t, new Set(columnsOf(db, 'main', t))]));
    for (const [t, cols] of expectedSchema()) {
      const h = have.get(t);
      if (!h) throw invalid(`저장본에 '${t}' 표가 없어요(필수 정보가 빠진 파일이에요).`);
      for (const c of cols) if (!h.has(c)) throw invalid(`저장본의 '${t}' 표에 '${c}' 열이 없어요.`);
    }
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) throw invalid(`저장본 안의 데이터가 서로 맞지 않아요(${fk[0].table} 표의 항목이 없는 ${fk[0].parent} 표 항목을 가리켜요).`);
    // AUTOINCREMENT counters (and the ids they stand for) must be sane whole numbers well below 2^53: one near the limit would be carried
    // into the live database (max of both) and every later INSERT would fail or hand out ids JavaScript cannot represent.
    if (db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
      const bad = db.prepare("SELECT name FROM sqlite_sequence WHERE typeof(seq) != 'integer' OR seq < 0 OR seq > ?").get(MAX_COUNTER);
      if (bad) throw invalid('저장본 표의 번호표가 비정상이에요.');
      for (const r of db.prepare('SELECT name FROM sqlite_sequence').all()) {
        if (!have.has(String(r.name))) continue;
        if (db.prepare(`SELECT 1 AS x FROM ${q(r.name)} WHERE typeof(rowid) != 'integer' OR rowid > ? LIMIT 1`).get(MAX_COUNTER)) throw invalid('저장본 표의 번호표가 비정상이에요.');
      }
    }
    const n = (sql) => Number(Object.values(db.prepare(sql).get())[0]);
    const newest = Object.values(db.prepare('SELECT MAX(created_at) FROM posts').get())[0];
    return {
      counts: { boards: n('SELECT COUNT(*) FROM boards'), posts: n('SELECT COUNT(*) FROM posts'), users: n('SELECT COUNT(*) FROM users') },
      latestPostAt: newest == null ? null : Number(newest),
      uploadRows: db.prepare('SELECT id, size FROM uploads ORDER BY created_at, id').all().map((r) => ({ id: String(r.id), size: Number(r.size) })),
      boards: db.prepare(
        'SELECT b.title, b.updated_at, (SELECT COUNT(*) FROM posts p WHERE p.board_id = b.id) AS posts FROM boards b ORDER BY b.updated_at DESC, b.id DESC LIMIT 100',
      ).all().map((r) => ({ title: String(r.title), posts: Number(r.posts), updatedAt: Number(r.updated_at) })),
    };
  });
}

export function disposeCopy(prep) {
  if (!prep) return;
  try { fs.rmSync(prep.tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* the OS cleans its temp folder eventually */ }
}

/**
 * Copy `<backupDir>/edulet.db` into a fresh OS temp folder and check the COPY (the backup folder itself is only read). An older schema is
 * migrated to the current one on the copy. Throws HttpError 422 `backup_invalid` (a one-line Korean reason) when the backup cannot be used.
 * @returns {Promise<{ tmpDir, file, userVersion, migratedFrom: number|null, counts, latestPostAt, uploadRows, boards }>} call disposeCopy() when done
 */
export async function prepareCopy(backupDir) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edulet-restore-'));
  const file = path.join(tmpDir, 'edulet.db');
  const prep = { tmpDir, file };
  try {
    await fsp.copyFile(path.join(backupDir, 'edulet.db'), file);
    const { version } = probe(file);
    let migratedFrom = null;
    if (version < SCHEMA_VERSION) { migrate(file); migratedFrom = version; }
    return Object.assign(prep, { userVersion: version, migratedFrom }, examine(file));
  } catch (e) {
    disposeCopy(prep);
    throw e;
  }
}

// ---- uploads --------------------------------------------------------------------------------------------------------------

/** Rows of the backup's `uploads` whose file is not in the backup's uploads folder (a preview warning; read-only). */
export async function missingUploads(backupDir, rows) {
  const dir = path.join(backupDir, 'uploads');
  try {
    const st = await fsp.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { folder: false, missing: rows.length };
  } catch {
    return { folder: false, missing: rows.length };
  }
  let missing = 0;
  for (const r of rows) {
    if (!UPLOAD_ID.test(r.id)) { missing++; continue; } // the pattern first: an id from a database is never joined to a path before it passed
    try {
      const st = await fsp.lstat(path.join(dir, r.id));
      if (st.isSymbolicLink() || !st.isFile()) missing++;
    } catch { missing++; }
  }
  return { folder: true, missing };
}

/**
 * Step 4: copy the files the backup's upload rows point at into data/uploads. A file already there is NEVER touched (same size: skipped,
 * different size: left alone + a warning). Only regular, non-link files of the backup are read. New files appear atomically (.part, then
 * rename) and are remembered in `created`, so a failure later on can take them away again. Missing/odd files only warn.
 */
async function stageUploads(app, backupDir, rows, warnings, created) {
  const src = path.join(backupDir, 'uploads');
  const dst = uploadsDir(app);
  try {
    const st = await fsp.lstat(src);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      if (rows.length) warnings.push(`저장본의 uploads 가 폴더가 아니거나 바로가기라 사진·파일 ${rows.length}개를 가져오지 않았어요.`);
      return;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (rows.length) warnings.push(`저장본에 uploads 폴더가 없어서 사진·파일 ${rows.length}개를 가져오지 못했어요. 글은 그대로 불러오지만 그 사진·파일은 보이지 않을 수 있어요.`);
    return;
  }
  await fsp.mkdir(dst, { recursive: true });
  const gone = [];
  const odd = [];
  const links = [];
  const differ = [];
  for (const row of rows) {
    if (!UPLOAD_ID.test(row.id)) { odd.push(row.id.slice(0, 40)); continue; }
    const from = path.join(src, row.id);
    const to = path.join(dst, row.id);
    let st;
    try { st = await fsp.lstat(from); } catch { gone.push(row.id); continue; }
    if (st.isSymbolicLink() || !st.isFile()) { links.push(row.id); continue; }
    let have = null;
    try { have = await fsp.lstat(to); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (have) {
      if (!(have.isFile() && !have.isSymbolicLink() && have.size === st.size)) differ.push(row.id);
      continue; // already there: never touched
    }
    const part = path.join(dst, `.${row.id}.part`);
    try {
      await fsp.rm(part, { force: true }); // a leftover of an earlier, interrupted run would make COPYFILE_EXCL fail with EEXIST
      await fsp.copyFile(from, part, fs.constants.COPYFILE_EXCL);
      await fsp.rename(part, to);
      created.push(to);
    } catch (e) {
      await fsp.rm(part, { force: true }).catch(() => {});
      if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code)) { gone.push(row.id); continue; }
      throw e; // disk full, I/O error: the whole restore stops (and removes what it copied)
    }
  }
  if (gone.length) warnings.push(`사진·파일 ${gone.length}개가 저장본에 없거나 읽을 수 없어서 가져오지 못했어요: ${some(gone)}`);
  if (links.length) warnings.push(`사진·파일 ${links.length}개는 바로가기이거나 일반 파일이 아니라 건너뛰었어요: ${some(links)}`);
  if (odd.length) warnings.push(`사진·파일 ${odd.length}개는 이름이 올바르지 않아 건너뛰었어요: ${some(odd)}`);
  if (differ.length) warnings.push(`같은 이름의 사진·파일 ${differ.length}개가 이미 서버에 있고 크기가 달라요. 서버에 있는 것을 그대로 두었어요: ${some(differ)}`);
}

// ---- the swap ---------------------------------------------------------------------------------------------------------------

/**
 * Replace the contents of the live database with the copy at `file`, on the SAME connection (`raw` = app.db.raw). Synchronous end to end —
 * nothing else runs in between. Everything is one transaction (BEGIN IMMEDIATE … COMMIT); any error rolls back and the data is as before.
 * `PRAGMA foreign_keys` is OFF only for the duration and is switched back ON in a finally, whatever happened.
 *
 * Sessions: the backup's `sessions` are dropped. Of the sessions alive right now, those whose user is "the same person" in the new
 * user table (id, created_at, is_guest, username, google_sub all equal) are put back; the rest are logged out.
 * `state.committed` becomes true the moment COMMIT succeeded: an error after that point does not mean "nothing changed".
 * `dataVersion` (PRAGMA data_version read before the safety copy): checked again once BEGIN IMMEDIATE holds the write lock — another
 * connection or process that committed in between (after the last check, before the lock) would otherwise be overwritten unseen.
 * @returns {{ keptSession: boolean }} keptSession = the session whose token hash is `tokenHash` survived
 */
export function swapDatabase(raw, file, { tokenHash = null, now = Date.now(), state = {}, dataVersion = null } = {}) {
  let kept = false;
  raw.exec('PRAGMA foreign_keys = OFF'); // a no-op inside a transaction, so it comes first
  try {
    if (Number(raw.prepare('PRAGMA foreign_keys').get().foreign_keys) !== 0) throw new Error('foreign_keys 를 끌 수 없었어요.');
    try { raw.exec(`DETACH DATABASE ${ALIAS}`); } catch { /* not attached: the normal case */ }
    raw.prepare(`ATTACH DATABASE ? AS ${ALIAS}`).run(file);
    try {
      raw.exec('BEGIN IMMEDIATE');
      try {
        if (dataVersion != null && Number(raw.prepare('PRAGMA data_version').get().data_version) !== dataVersion) throw dataChanged();
        // which tables, and does the copy have all of them (and every column we are going to read)?
        const tables = userTables(raw, 'main');
        const theirs = new Set(userTables(raw, ALIAS));
        const cols = new Map();
        for (const t of tables) {
          if (!theirs.has(t)) throw invalid(`저장본에 '${t}' 표가 없어요.`);
          const have = new Set(columnsOf(raw, ALIAS, t));
          const want = columnsOf(raw, 'main', t);
          for (const c of want) if (!have.has(c)) throw invalid(`저장본의 '${t}' 표에 '${c}' 열이 없어요.`);
          cols.set(t, want);
        }
        const order = fkOrder(raw, tables); // parents first

        // (a) what must survive the swap: the live sessions with enough about their users to recognise them afterwards
        const live = raw.prepare(
          `SELECT s.token_hash, s.user_id, s.expires_at, s.created_at, u.created_at AS u_created, u.is_guest AS u_guest, u.username AS u_name, u.google_sub AS u_sub
             FROM main.sessions s JOIN main.users u ON u.id = s.user_id WHERE s.expires_at > ?`,
        ).all(now).map((r) => ({ ...r }));
        const seqBefore = sequences(raw, 'main');

        // (b) children first out, parents first in; the copy's `sessions` are not copied at all (see above)
        for (const t of [...order].reverse()) raw.exec(`DELETE FROM main.${q(t)}`);
        for (const t of order) {
          if (t === 'sessions') continue;
          const list = cols.get(t).map(q).join(', ');
          raw.exec(`INSERT INTO main.${q(t)} (${list}) SELECT ${list} FROM ${ALIAS}.${q(t)}`);
        }

        // (c) AUTOINCREMENT counters never go backwards: a new row must not reuse an id the old data handed out
        const seqCopy = sequences(raw, ALIAS);
        const seqNow = sequences(raw, 'main');
        for (const name of new Set([...seqBefore.keys(), ...seqCopy.keys(), ...seqNow.keys()])) {
          if (!tables.includes(name)) continue;
          const want = Math.max(seqBefore.get(name) ?? 0, seqCopy.get(name) ?? 0, seqNow.get(name) ?? 0);
          if (seqNow.has(name)) raw.prepare('UPDATE main.sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = ?').run(want, name);
          else if (want > 0) raw.prepare('INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))').run(name, want);
        }

        // (d) session policy
        const person = raw.prepare('SELECT id, created_at, is_guest, username, google_sub FROM main.users WHERE id = ?');
        const putBack = raw.prepare('INSERT INTO main.sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)');
        for (const s of live) {
          const u = person.get(s.user_id);
          if (!u) continue;
          const same = Number(u.created_at) === Number(s.u_created) && Number(u.is_guest) === Number(s.u_guest)
            && String(u.username ?? '') === String(s.u_name ?? '') && String(u.google_sub ?? '') === String(s.u_sub ?? '');
          if (!same) continue;
          putBack.run(s.token_hash, s.user_id, s.expires_at, s.created_at);
          if (tokenHash && s.token_hash === tokenHash) kept = true;
        }

        // (e) last check before COMMIT
        const bad = raw.prepare('PRAGMA main.foreign_key_check').all();
        if (bad.length) throw invalid(`저장본 안의 데이터가 서로 맞지 않아요(${bad[0].table} 표의 항목이 없는 ${bad[0].parent} 표 항목을 가리켜요).`);
        raw.exec('COMMIT');
        state.committed = true;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
        throw e;
      }
    } finally {
      try { raw.exec(`DETACH DATABASE ${ALIAS}`); } catch { /* reported by the next restore's own DETACH attempt */ }
    }
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
  return { keptSession: kept };
}

// ---- the whole restore (steps 2 - 7 of CONTRACT §5) -----------------------------------------------------------------------

const totalChanges = (app) => Number(app.db.get('SELECT total_changes() AS n').n);
/** changes committed by ANOTHER connection or process since this connection last looked (its own writes are what total_changes counts) */
const dataVersion = (app) => Number(app.db.get('PRAGMA data_version').data_version);

// absolute paths that are not (or no longer) this server's own folders: a drive path, a UNC / \\?\ path, a path under a typical unix root
const PATHS = [
  /\\\\[^\s"'<>|*]+/g, // first: `\\?\C:\…` and `\\server\share` as a whole
  /[A-Za-z]:[\\/][^\s"'<>|?*]*/g,
  /(?<![\w.:/-])\/(?:home|Users|root|var|tmp|mnt|opt|etc|usr|srv|media|private|Volumes|proc|data|app)\/[^\s"'<>|?*]*/g,
];

/**
 * Messages and warnings for the person at the screen never carry this machine's folders: the configured data/backup folders become
 * `data` / `backups`, and any other absolute path (a junction's target, a temp folder, a path an OS error quotes) becomes `<경로>`.
 */
export function scrubPaths(app, message) {
  let s = String(message ?? '');
  for (const [dir, name] of [[app.config.backupDir, 'backups'], [app.config.dataDir, 'data']].sort((a, b) => b[0].length - a[0].length)) {
    if (dir) s = s.split(dir).join(name);
  }
  for (const re of PATHS) s = s.replace(re, (m) => `<경로>${(/[)\].,;:]+$/.exec(m) || [''])[0]}`);
  return s;
}

function safeRemove(app, dir) {
  try { removeOwnBackup(app.config.backupDir, dir); } catch { /* a leftover folder is only clutter */ }
}

/**
 * Put `entry` (a backup folder, already confirmed to exist) into the live database. The caller holds the mutex (app.backupBusy) and has
 * done the gate and the rate limit. Sets `app.maintenance` for the duration (always cleared).
 * @param {object} app @param {{ id: string, dir: string }} entry @param {{ tokenHash?: string|null }} [o]
 * @returns {Promise<{ safetyDir: string, keptSession: boolean, warnings: string[] }>}
 */
export async function restoreBackup(app, entry, { tokenHash = null } = {}) {
  const hooks = app.backupHooks ?? {};
  const { config } = app;
  const warnings = [];
  const created = []; // upload files this run put into data/uploads
  const safetyDirs = []; // 'before-restore' backups this run made
  let prep = null;
  const state = { committed: false };
  app.maintenance = true;
  try {
    // 3. a checked, current-schema COPY of the backup's database (migrated on the copy when it is older)
    prep = await prepareCopy(entry.dir);
    await hooks.afterValidate?.({ copy: prep.file, prep });

    // 4. the files the backup's rows point at
    await stageUploads(app, entry.dir, prep.uploadRows, warnings, created);
    await hooks.afterStage?.();

    // 5. safety copy of the CURRENT data; any write to the database since it was taken makes it stale -> again
    let safety = null;
    let dvSafe = null;
    for (let attempt = 1; attempt <= SAFETY_TRIES && !safety; attempt++) {
      const tc0 = totalChanges(app);
      const dv0 = dataVersion(app); // same instant as the snapshot: backupData() runs up to and including VACUUM INTO before its first await
      let r;
      try {
        r = await backupData({ dataDir: config.dataDir, outDir: config.backupDir, kind: 'before-restore' });
      } catch (e) {
        if (!(e instanceof BackupError)) throw e;
        throw new HttpError(500, 'backup_failed', `불러오기 직전의 안전 저장을 만들지 못해서 불러오지 않았어요. 지금 데이터는 그대로예요. (${oneLine(scrubPaths(app, e.message))})`);
      }
      safetyDirs.push(r.dir);
      await hooks.afterSafetySave?.(attempt, r);
      if (totalChanges(app) === tc0 && dataVersion(app) === dv0) { safety = r; dvSafe = dv0; } // NO await between this check and swapDatabase below
    }
    if (!safety) throw dataChanged();
    for (const d of safetyDirs) if (d !== safety.dir) safeRemove(app, d); // superseded attempts
    warnings.push(...safety.warnings.map((w) => `안전 저장: ${scrubPaths(app, w)}`));

    // 6. the swap
    let result = { keptSession: false };
    try {
      result = swapDatabase(app.db.raw, prep.file, { tokenHash, state, dataVersion: dvSafe });
    } catch (e) {
      if (!state.committed) throw e; // rolled back: the data is as it was
      warnings.push('불러오기는 끝났지만 마무리하는 중에 문제가 있었어요. 서버를 껐다가 다시 켜 주세요.');
    }

    // 7. every open page must start over from the new data (nothing after COMMIT may fail the request: the data HAS changed)
    try { app.hub.resetAll(); } catch (e) { if (!app.quiet) console.error('[edulet] reset after restore failed', e); }
    return { safetyDir: safety.dir, keptSession: result.keptSession, warnings };
  } catch (e) {
    if (!state.committed) {
      // nothing changed in the database: take away what this run added next to it
      for (const f of created) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
      for (const d of safetyDirs) safeRemove(app, d);
      if (!(e instanceof HttpError)) {
        if (!app.quiet) console.error('[edulet] restore failed', e);
        const why = oneLine(scrubPaths(app, String(e?.message ?? e).split(prep?.tmpDir ?? '(temp)').join('temp')));
        throw new HttpError(500, 'restore_failed', `불러오기에 실패했어요. 지금 데이터는 바뀌지 않았어요. (${why})`);
      }
    }
    throw e;
  } finally {
    app.maintenance = false;
    disposeCopy(prep);
  }
}
