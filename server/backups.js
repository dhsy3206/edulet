// 저장하기·불러오기(백업) 라우트. CONTRACT §5 "저장하기·불러오기". 백업 만들기 자체는 backup.js, 되돌려 넣기는 restore.js.
//
// 이 파일의 규칙:
//  - 모든 라우트는 backupGate 를 먼저 지난다 — 서버를 켠 PC 의 localhost 로 연 사람만, 그리고 교사 계정이 있다면 그 계정으로 로그인한 사람만.
//  - 백업 폴더는 읽기 전용으로만 다룬다(읽기·lstat 뿐). SQLite 는 항상 OS 임시 폴더의 사본에서 연다 — 백업 폴더 안에서 열면 -wal/-shm 이 생겨 백업이 바뀐다.
//  - 응답에 절대 경로를 넣지 않는다. 폴더 id 는 ^edulet-YYYYMMDD-HHMMSS(-n)?$ 만 받는다(경로를 만들 수 없다).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BACKUP_ID, BACKUP_KINDS, BackupError, backupData } from './backup.js';
import { HttpError, bad, clientIp } from './http.js';
import { disposeCopy, missingUploads, peekCounts, prepareCopy, restoreBackup, scrubPaths } from './restore.js';
import { localOperator } from './share.js';

const MAX_ITEMS = 200;
const LEGACY_SUMMARIES_PER_REQUEST = 20; // old backups (no backup.json) are opened to count their rows; at most this many per request
const SAVE_PER_MINUTE = 6;
const PREVIEW_PER_MINUTE = 20;
const RESTORE_PER_MINUTE = 3;
const UPLOAD_NAME = /^[0-9a-f]{32}$/;

const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const regularFile = (p) => { const st = lstatOrNull(p); return !!st && st.isFile() && !st.isSymbolicLink(); };

/**
 * The door to every route here (CONTRACT §5): 1) the request must come from the server PC's operator; 2) once any real (non-guest) account
 * exists, the caller must be signed in as one. 403 for both — NOT 401: the front end treats a 401 as "session expired" and signs the user out.
 */
export function backupGate(app, c) {
  if (!localOperator(app, c.req)) {
    throw new HttpError(403, 'backup_local_only', '저장하기·불러오기는 서버를 켠 PC 에서 localhost 주소로 열었을 때만 쓸 수 있어요.');
  }
  if (app.db.get('SELECT 1 AS x FROM users WHERE is_guest = 0 LIMIT 1') && (!c.user || c.user.is_guest)) {
    throw new HttpError(403, 'member_required', '계정으로 로그인한 뒤에 쓸 수 있어요.');
  }
}

const busy = () => new HttpError(409, 'busy', '다른 저장·불러오기가 진행 중이에요.');
const tooOften = (app, key, what) => {
  const wait = Math.max(1, Math.ceil(app.rate.retryAfterMs(key) / 1000));
  return new HttpError(429, 'rate_limited', `${what} 요청이 너무 잦아요. 잠시 뒤에 다시 해 주세요.`, { 'Retry-After': String(wait) });
};
const whoKey = (app, c) => (c.user ? `u${c.user.id}` : `ip${clientIp(app, c.req)}`);

// ---- reading the backup folder (read-only) --------------------------------------------------------------------------------

/** "edulet-20261023-003843[-2]" -> epoch ms of that wall-clock time on this PC (the name is made from the local time). */
function idTime(id) {
  const m = /^edulet-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  if (!m) return 0;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Newest first: by the date-time in the name, then by the `-n` suffix as a NUMBER (-10 after -9). */
function newestFirst(a, b) {
  const ka = /^edulet-(\d{8}-\d{6})(?:-(\d+))?$/.exec(a);
  const kb = /^edulet-(\d{8}-\d{6})(?:-(\d+))?$/.exec(b);
  if (ka[1] !== kb[1]) return ka[1] < kb[1] ? 1 : -1;
  return Number(kb[2] ?? 1) - Number(ka[2] ?? 1);
}

/** A finished, usable backup folder (a direct child of backupDir; not a link; with a regular edulet.db and BACKUP-INFO.txt) or null. */
function findBackup(app, id) {
  if (!BACKUP_ID.test(id)) return null;
  const dir = path.join(app.config.backupDir, id);
  const st = lstatOrNull(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
  if (!regularFile(path.join(dir, 'edulet.db')) || !regularFile(path.join(dir, 'BACKUP-INFO.txt'))) return null;
  return { id, dir };
}

function needBackup(app, id) {
  if (typeof id !== 'string' || id.length > 40 || !BACKUP_ID.test(id)) throw bad('bad_request', '저장본 이름이 올바르지 않아요.');
  const entry = findBackup(app, id);
  if (!entry) throw new HttpError(404, 'backup_not_found', '그 저장본을 찾을 수 없어요.');
  return entry;
}

/** The finished backups of backupDir, newest first, at most MAX_ITEMS. `.partial` folders and anything not named like a backup are silently left out. */
function scanBackups(app) {
  let names;
  try { names = fs.readdirSync(app.config.backupDir); } catch { return []; } // no folder yet = no backups, not an error
  const out = [];
  for (const name of names.filter((n) => BACKUP_ID.test(n)).sort(newestFirst)) {
    const entry = findBackup(app, name);
    if (entry) out.push(entry);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** backup.json, validated — or null (absent: an older backup; unreadable/unknown shape: treated the same, never trusted). */
function readMeta(dir) {
  const f = path.join(dir, 'backup.json');
  const st = lstatOrNull(f);
  if (!st || st.isSymbolicLink() || !st.isFile() || st.size > 64 * 1024) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; }
  const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!j || typeof j !== 'object' || j.format !== 1 || !BACKUP_KINDS.includes(j.kind) || !num(j.createdAt)) return null;
  const c = j.counts;
  const u = j.uploads;
  if (!c || !num(c.boards) || !num(c.posts) || !num(c.users) || !u || !num(u.files) || !num(j.dbBytes) || !num(j.warnings)) return null;
  if (j.latestPostAt !== null && !num(j.latestPostAt)) return null;
  return { kind: j.kind, createdAt: j.createdAt, counts: c, latestPostAt: j.latestPostAt, uploadFiles: u.files, warnings: j.warnings };
}

/** "경고" lines of an old backup's BACKUP-INFO.txt (the only place an old backup says it had warnings). */
function warningsInInfo(dir) {
  try {
    const f = path.join(dir, 'BACKUP-INFO.txt');
    if (fs.statSync(f).size > 256 * 1024) return 0;
    let n = 0;
    let inside = false;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (line.startsWith('경고 (')) { inside = true; continue; }
      if (!inside) continue;
      if (/^ {2}- /.test(line)) n++;
      else if (line.trim() === '') break;
    }
    return n;
  } catch { return 0; }
}

function countUploadFiles(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'uploads'), { withFileTypes: true }).filter((d) => d.isFile() && UPLOAD_NAME.test(d.name)).length;
  } catch { return 0; }
}

export function registerBackups(app) {
  const { router } = app;
  const legacyCache = new Map(); // `${id}|${mtimeMs}|${size}` -> summary | null — an old backup never changes, so it is read once

  /** The summary of an old backup (no backup.json): copy its database to the temp folder and count. At most `budget.left` per request. */
  async function legacySummary(entry, budget) {
    const st = fs.statSync(path.join(entry.dir, 'edulet.db'));
    const key = `${entry.id}|${st.mtimeMs}|${st.size}`;
    if (legacyCache.has(key)) return legacyCache.get(key);
    if (budget.left <= 0) return null; // over this request's allowance: not cached — the next request carries on
    budget.left--;
    let value = null;
    let tmp = null;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edulet-peek-'));
      const file = path.join(tmp, 'edulet.db');
      await fsp.copyFile(path.join(entry.dir, 'edulet.db'), file);
      value = peekCounts(file); // null when the file is not a plain Edulet database (a view or trigger inside, damaged, ...)
    } catch { value = null; } finally {
      if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp folder */ } }
    }
    if (legacyCache.size > 2000) legacyCache.clear();
    legacyCache.set(key, value);
    return value;
  }

  /** item = { id, createdAt, kind, dbBytes, uploadFiles, warnings, summary } (CONTRACT §5). `summary` is given when the caller already read the database. */
  async function buildItem(entry, { budget = { left: LEGACY_SUMMARIES_PER_REQUEST }, summary } = {}) {
    const meta = readMeta(entry.dir);
    const dbBytes = fs.statSync(path.join(entry.dir, 'edulet.db')).size;
    if (meta) {
      return {
        id: entry.id, createdAt: meta.createdAt, kind: meta.kind, dbBytes, uploadFiles: meta.uploadFiles, warnings: meta.warnings,
        summary: { boards: meta.counts.boards, posts: meta.counts.posts, users: meta.counts.users, latestPostAt: meta.latestPostAt },
      };
    }
    return {
      id: entry.id, createdAt: idTime(entry.id), kind: 'manual', dbBytes, uploadFiles: countUploadFiles(entry.dir), warnings: warningsInInfo(entry.dir),
      summary: summary ?? (await legacySummary(entry, budget)),
    };
  }

  const current = () => {
    const n = (sql) => app.db.get(sql).n;
    return { boards: n('SELECT COUNT(*) AS n FROM boards'), posts: n('SELECT COUNT(*) AS n FROM posts'), users: n('SELECT COUNT(*) AS n FROM users'), latestPostAt: app.db.get('SELECT MAX(created_at) AS n FROM posts').n ?? null };
  };

  router.add('GET', '/backups', async (c) => {
    backupGate(app, c);
    const budget = { left: LEGACY_SUMMARIES_PER_REQUEST };
    const items = [];
    for (const entry of scanBackups(app)) {
      try { items.push(await buildItem(entry, { budget })); } catch { /* the folder vanished or changed while listing: leave it out, list the rest */ }
    }
    items.sort((a, b) => b.createdAt - a.createdAt); // stable: the name order breaks ties
    return { items, current: current(), backupDirName: path.basename(app.config.backupDir) };
  });

  router.add('GET', '/backups/:id', async (c) => {
    backupGate(app, c);
    const key = `preview:${whoKey(app, c)}`;
    if (!app.rate.hit(key, PREVIEW_PER_MINUTE)) throw tooOften(app, key, '미리보기');
    const entry = needBackup(app, c.params.id);
    let prep = null;
    try {
      prep = await prepareCopy(entry.dir); // 422 backup_invalid when it cannot be used
      const warnings = [];
      if (prep.migratedFrom != null) warnings.push(`옛 형식(데이터 형식 ${prep.migratedFrom})으로 만든 저장본이에요. 불러올 때 새 형식으로 자동으로 바꿔요.`);
      const up = await missingUploads(entry.dir, prep.uploadRows);
      if (!up.folder && prep.uploadRows.length) warnings.push(`저장본에 uploads 폴더가 없어요. 불러오면 사진·파일 ${prep.uploadRows.length}개는 보이지 않을 수 있어요.`);
      else if (up.missing) warnings.push(`사진·파일 ${up.missing}개가 저장본에 없어요. 불러오면 그 사진·파일은 보이지 않을 수 있어요.`);
      const item = await buildItem(entry, { summary: { ...prep.counts, latestPostAt: prep.latestPostAt } });
      return { item, boards: prep.boards, warnings, newerThanApp: false };
    } finally {
      disposeCopy(prep);
    }
  });

  router.add('POST', '/backups', async (c) => {
    backupGate(app, c);
    if (app.backupBusy) throw busy();
    app.backupBusy = true;
    try {
      const key = `backup:${whoKey(app, c)}`;
      if (!app.rate.hit(key, SAVE_PER_MINUTE)) throw tooOften(app, key, '저장');
      let r;
      try {
        r = await backupData({ dataDir: app.config.dataDir, outDir: app.config.backupDir });
      } catch (e) {
        if (e instanceof BackupError) throw new HttpError(500, 'backup_failed', scrubPaths(app, e.message).split(/\r?\n/)[0]);
        throw e; // unexpected: the generic 500 (logged, nothing internal leaves the server)
      }
      const item = await buildItem({ id: path.basename(r.dir), dir: r.dir });
      return c.json({ item, warnings: r.warnings.map((w) => scrubPaths(app, w)) }, 201);
    } finally {
      app.backupBusy = false;
    }
  });

  router.add('POST', '/backups/:id/restore', async (c) => {
    backupGate(app, c);
    const b = await c.body();
    if (b.confirm !== true) throw bad('confirm_required', '정말 불러올지 확인이 필요해요.');
    if (app.backupBusy) throw busy();
    app.backupBusy = true;
    try {
      const key = `restore:${whoKey(app, c)}`;
      if (!app.rate.hit(key, RESTORE_PER_MINUTE)) throw tooOften(app, key, '불러오기');
      const entry = needBackup(app, c.params.id);
      const r = await restoreBackup(app, entry, { tokenHash: c.tokenHash });
      // the data HAS been replaced by now: describing the two folders must not turn that into an error
      const describe = async (e) => { try { return await buildItem(e); } catch { return null; } };
      const safetyId = path.basename(r.safetyDir);
      return {
        ok: true,
        restored: await describe(entry),
        safety: await describe(findBackup(app, safetyId) ?? { id: safetyId, dir: r.safetyDir }),
        keptSession: r.keptSession,
        warnings: r.warnings,
      };
    } finally {
      app.backupBusy = false;
    }
  });
}
