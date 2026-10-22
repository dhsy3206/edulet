// Safe online backup of the Edulet data folder (edulet.db + uploads/) — works while the server is running.
//
//   node tools/backup.mjs [--data <dir>] [--out <dir>]        (or double-click backup.cmd)
//
// Why not "copy the data folder": while the server runs, recent work lives in edulet.db-wal and edulet.db itself is a STALE file
// (empty, or missing the recent work), so copying edulet.db alone saves an old or EMPTY database. `VACUUM INTO` writes one
// consistent single-file snapshot that includes everything in the WAL, with other connections (the server) still reading and writing.
//
// Invariants (see docs/CONTRACT.md §1):
//   1. The original data is never modified: the source database is opened READ-ONLY and only `VACUUM INTO` runs on it (no
//      migration, no `openDb`, no checkpoint, no write). The uploads folder is only read.
//   2. The snapshot includes the WAL. Uploads are copied AFTER the snapshot and only the files that the snapshot's `uploads` rows
//      point at, so the copy is consistent with the database (a file uploaded a moment later is not in the snapshot nor copied).
//   3. A backup either completes (verified: integrity_check = ok, counts read) or its folder is removed again. The work happens in
//      `edulet-….partial` and only a finished, verified backup is renamed to its real name — so a folder with a normal name always
//      holds a complete backup, even when the run was killed half way (Ctrl+C, closed console, power cut: a `.partial` is left).
//   4. An incomplete backup must not look like a complete one: the CLI exits 2 (not 0) when anything was skipped or warned about.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite prints an ExperimentalWarning on load; filter just that one (same trick as server/db.js, which we must not import).
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite/i.test(msg)) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = origEmit;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repository root = the folder of this file's parent (NOT the current folder — unlike the server's `./data`). */
export const ROOT = path.resolve(HERE, '..');

const PARTIAL = '.partial';
const BACKUP_NAME = /^edulet-\d{8}-\d{6}(?:-\d+)?(?:\.partial)?$/;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const SHOW_IDS = 5; // how many file ids a warning lists before "…and N more"
/** Error codes of "somebody else has the file open / locked it" (antivirus, a backup agent, an editor). Retried briefly, then skipped. */
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RETRY_TRIES = 3;
const RETRY_DELAY_MS = 200;
const MAX_PATIENT_GIVEUPS = 5; // after this many files gave up, further locked files get one attempt only (a locked folder must not take hours)

/** A failure with a message that is meant for the person running the tool (the CLI prints it without a stack trace). */
export class BackupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'BackupError';
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const human = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const some = (ids) => (ids.length > SHOW_IDS ? `${ids.slice(0, SHOW_IDS).join(', ')} …외 ${ids.length - SHOW_IDS}개` : ids.join(', '));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** realpath of the deepest existing ancestor + the not-yet-existing rest, so a folder that is not created yet can be compared. */
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** true when `child` is `parent` itself or lies below it (symlinks/junctions resolved, case-insensitive where the OS is). */
function isInside(child, parent) {
  const rel = path.relative(realish(parent), realish(child));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** Remove a backup folder that THIS run created — and only if it is a direct child of <out> named edulet-YYYYMMDD-HHMMSS[-n][.partial]. */
export function removeOwnBackup(outAbs, dir) {
  const name = path.basename(dir);
  if (!BACKUP_NAME.test(name) || path.relative(outAbs, dir) !== name) return false;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return true;
}

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/**
 * Create the working folder `<out>/edulet-YYYYMMDD-HHMMSS[-n].partial` (n = 2, 3, … when the name is taken). A name is taken when
 * EITHER the finished folder OR a `.partial` (a run in progress, or one that was cut off) exists — nothing is ever reused or
 * overwritten. mkdir without `recursive` fails on EEXIST, so two runs never share a folder.
 */
function createBackupDir(outAbs, now) {
  try {
    fs.mkdirSync(outAbs, { recursive: true });
  } catch (e) {
    throw new BackupError(`백업을 만들 폴더를 준비하지 못했어요: ${outAbs} (${e.message})`, { cause: e });
  }
  const base = `edulet-${stamp(now)}`;
  for (let n = 1; n < 10000; n++) {
    const finalDir = path.join(outAbs, n === 1 ? base : `${base}-${n}`);
    if (exists(finalDir)) continue;
    const partialDir = finalDir + PARTIAL;
    try {
      fs.mkdirSync(partialDir);
      return { partialDir, finalDir };
    } catch (e) {
      if (e.code !== 'EEXIST') throw new BackupError(`백업 폴더를 만들지 못했어요: ${partialDir} (${e.message})`, { cause: e });
    }
  }
  throw new BackupError(`백업 폴더 이름을 정하지 못했어요: ${path.join(outAbs, base)}`);
}

/** The last step: give the finished, verified folder its real name (retried a little: antivirus may hold a file for a moment). */
async function finishBackupDir(partialDir, finalDir) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(partialDir, finalDir);
      return;
    } catch (e) {
      if (!LOCKED.has(e.code) || i >= 5) throw new BackupError(`백업 폴더의 이름을 확정하지 못했어요: ${finalDir} (${e.message})`, { cause: e });
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/** Open a database read-only (never creates, never migrates, never checkpoints). */
function openReadOnly(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * The original -wal: does it exist, and when was it last written? Read through an OPEN handle (fstat) — a directory listing can
 * show a stale time on Windows. Looked at before SQLite opens the database (a read-only open may create an empty -wal itself).
 */
function walInfo(walFile) {
  let fd;
  try {
    fd = fs.openSync(walFile, 'r');
  } catch (e) {
    return { exists: e.code !== 'ENOENT', modifiedAt: null };
  }
  try {
    return { exists: true, modifiedAt: fs.fstatSync(fd).mtimeMs };
  } catch {
    return { exists: true, modifiedAt: null };
  } finally {
    try { fs.closeSync(fd); } catch { /* nothing to do */ }
  }
}

/** VACUUM INTO: one consistent single-file snapshot of the SOURCE, WAL content included. The source is only read. */
function snapshotDatabase(sourceFile, targetFile) {
  let src;
  try {
    src = openReadOnly(sourceFile);
    src.prepare('VACUUM INTO ?').run(targetFile);
  } catch (e) {
    throw new BackupError(`데이터베이스를 복사하지 못했어요(${e.message}). 서버가 켜져 있어도 되지만 edulet.db 가 읽을 수 있는 파일이어야 해요: ${sourceFile}`, { cause: e });
  } finally {
    try { src?.close(); } catch { /* nothing to do */ }
  }
}

/** Open the snapshot, run integrity_check, read the counts, the newest post time and the upload rows. Throws BackupError when anything is wrong. */
export function verifySnapshot(file) {
  let db;
  try {
    // The snapshot is OUR OWN fresh file (journal_mode = delete), never the server's database, so it is opened normally here: measured on
    // SQLite 3.49, a READ-ONLY connection skips the CHECK-constraint part of integrity_check (a violating row reads "ok") while a normal
    // connection reports it. Nothing is written — integrity_check and SELECTs only. (The ORIGINAL is still only ever opened read-only.)
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    const check = db.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r)[0]));
    if (check.length !== 1 || check[0] !== 'ok') throw new Error(`integrity_check: ${check.slice(0, 3).join(' / ')}`);
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    const counts = { boards: count('boards'), posts: count('posts'), users: count('users') };
    const newest = Object.values(db.prepare('SELECT MAX(created_at) FROM posts').get())[0];
    const latestPostAt = newest == null ? null : Number(newest);
    const uploadRows = db.prepare('SELECT id, size FROM uploads ORDER BY created_at, id').all().map((r) => ({ id: String(r.id), size: Number(r.size) }));
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    return { counts, latestPostAt, uploadRows, userVersion };
  } catch (e) {
    throw new BackupError(`만든 백업이 올바른지 확인하지 못했어요(${e.message}).`, { cause: e });
  } finally {
    try { db?.close(); } catch { /* nothing to do */ }
  }
}

/** Run `fn`; when the error says "locked" (EBUSY/EPERM/EACCES) try again shortly. Throws the last error when it stays locked. */
async function retryLocked(fn, state) {
  const tries = state.giveUps >= MAX_PATIENT_GIVEUPS ? 1 : RETRY_TRIES;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!LOCKED.has(e.code)) throw e;
      if (i >= tries) { state.giveUps++; throw e; }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Copy the files the snapshot's upload rows point at.
 *  - The uploads FOLDER itself may be a symlink/junction (moved to another drive): that is followed (like the data folder), with a warning.
 *  - A link INSIDE it (one upload file) is never followed: skipped, counted as missing, reported.
 *  - A file that vanished (the server's clean-up may delete one while we copy) or that someone has locked (after a few short
 *    retries) is counted as missing and reported — not a failure of the whole backup.
 * Anything else that goes wrong (disk full, I/O error) throws, and the caller removes the half-made folder.
 */
async function copyUploads(srcDir, dstDir, rows, warnings) {
  await fsp.mkdir(dstDir);
  const out = { files: 0, bytes: 0, missing: 0 };
  const gone = [];
  const locked = [];
  const links = [];
  const odd = [];
  const wrongSize = [];
  const state = { giveUps: 0 };

  let src = srcDir;
  let problem = null;
  try {
    const st = await fsp.lstat(srcDir);
    if (st.isSymbolicLink()) {
      try {
        const real = await fsp.realpath(srcDir);
        if ((await fsp.stat(real)).isDirectory()) {
          src = real;
          warnings.push(`원본 uploads 가 바로가기(심볼릭 링크·정션)라 ${real} 을(를) 따라갔어요.`);
        } else {
          problem = `원본 uploads 바로가기가 폴더를 가리키지 않아요: ${srcDir}`;
        }
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
        problem = `원본 uploads 바로가기가 가리키는 곳이 없어요: ${srcDir}`;
      }
    } else if (!st.isDirectory()) {
      problem = `원본 uploads 가 폴더가 아니에요: ${srcDir}`;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    problem = rows.length ? `원본에 uploads 폴더가 없어요: ${srcDir}` : '';
  }
  if (problem !== null) {
    out.missing = rows.length;
    if (problem) warnings.push(`${problem} — 업로드 파일 ${rows.length}개가 백업에 없어요.`);
    return out;
  }

  for (const row of rows) {
    if (!UPLOAD_ID.test(row.id)) { out.missing++; odd.push(row.id.slice(0, 40)); continue; }
    const from = path.join(src, row.id);
    const to = path.join(dstDir, row.id);
    try {
      const st = await retryLocked(() => fsp.lstat(from), state);
      if (st.isSymbolicLink()) { out.missing++; links.push(row.id); continue; }
      if (!st.isFile()) { out.missing++; odd.push(row.id); continue; }
      await retryLocked(async () => {
        await fsp.rm(to, { force: true }); // a failed attempt may have left a stub; COPYFILE_EXCL below would trip over it
        await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      }, state);
    } catch (e) {
      if (e.code === 'ENOENT') { out.missing++; gone.push(row.id); continue; }
      if (LOCKED.has(e.code)) {
        out.missing++;
        locked.push(row.id);
        await fsp.rm(to, { force: true }).catch(() => {});
        continue;
      }
      throw e;
    }
    const size = (await fsp.stat(to)).size;
    out.files++;
    out.bytes += size;
    if (size !== row.size) wrongSize.push(row.id);
  }

  if (gone.length) warnings.push(`업로드 파일 ${gone.length}개가 원본 uploads 폴더에 없어서 백업에 못 담았어요(복사하는 동안 정리됐거나 이미 없던 파일): ${some(gone)}`);
  if (locked.length) warnings.push(`업로드 파일 ${locked.length}개는 다른 프로그램이 잠그고 있어(사용 중) 복사하지 못했어요: ${some(locked)}`);
  if (links.length) warnings.push(`업로드 파일 ${links.length}개는 바로가기(심볼릭 링크·정션)라 따라가지 않고 건너뛰었어요: ${some(links)}`);
  if (odd.length) warnings.push(`업로드 항목 ${odd.length}개는 일반 파일이 아니거나 이름이 올바르지 않아 건너뛰었어요: ${some(odd)}`);
  if (wrongSize.length) warnings.push(`업로드 파일 ${wrongSize.length}개는 데이터베이스에 적힌 크기와 달라요(손상됐을 수 있어요): ${some(wrongSize)}`);
  return out;
}

const walText = (wal) => (wal.exists ? (wal.modifiedAt == null ? '알 수 없음' : human(new Date(wal.modifiedAt))) : 'WAL 없음');
const postText = (ms) => (ms == null ? '없음' : human(new Date(ms)));

function infoText({ now, dataAbs, dir, counts, latestPostAt, wal, uploads, dbBytes, userVersion, warnings }) {
  const lines = [
    'Edulet 백업',
    '',
    `만든 시각   : ${human(now)} (이 PC 의 시각)`,
    `원본 폴더   : ${dataAbs}`,
    `백업 폴더   : ${dir}`,
    `내용        : 보드 ${counts.boards}개 · 글 ${counts.posts}개 · 사용자 ${counts.users}명`,
    `가장 최근 글: ${postText(latestPostAt)}  (원본 WAL 마지막 수정: ${walText(wal)})`,
    `업로드 파일 : ${uploads.files}개 (${fmtBytes(uploads.bytes)})${uploads.missing ? ` — 백업에 못 담은 파일 ${uploads.missing}개` : ''}`,
    `데이터베이스: edulet.db ${fmtBytes(dbBytes)} (스키마 버전 ${userVersion}, integrity_check = ok)`,
  ];
  if (warnings.length) {
    lines.push('', '경고 (백업은 만들어졌지만 일부가 빠졌거나 확인이 필요해요)');
    for (const w of warnings) lines.push(`  - ${w}`);
  }
  lines.push(
    '',
    '이 폴더에는 edulet.db(하나의 파일 — 서버가 켜져 있을 때 WAL 에 있던 최신 작업까지 담겨 있어요)와 uploads 폴더가 들어 있어요.',
    '',
    '복원하는 방법',
    '  * BACKUP-INFO.txt 가 있는 정상 이름(edulet-날짜-시간)의 폴더만 쓰세요. 이름 끝에 .partial 이 붙은 폴더는',
    '    백업이 중간에 끊긴 것이니 쓰지 말고 지워도 됩니다.',
    '  1. 서버를 끕니다(서버 창을 닫기).',
    '  2. 지금의 data 폴더를 따로 옮겨 둡니다(지우지 말고 이름만 바꾸거나 다른 곳으로).',
    '  3. 새 data 폴더를 만들고, 이 폴더의 edulet.db 와 uploads 폴더를 그 안에 복사합니다.',
    '  4. 새 data 폴더에 옛 edulet.db-wal · edulet.db-shm 파일이 있으면 반드시 지웁니다.',
    '     (남아 있으면 다른 데이터베이스의 WAL 이 복원본에 다시 적용돼 데이터가 망가질 수 있어요.)',
    '  5. run.cmd 로 서버를 켭니다. 다른 위치의 data 폴더를 쓰려면 환경변수 EDULET_DATA_DIR 로 그 폴더를 지정하세요.',
    '',
  );
  return '\uFEFF' + lines.join('\r\n');
}

/**
 * Make a backup of `dataDir` (edulet.db + uploads/) into a new folder `<outDir>/edulet-YYYYMMDD-HHMMSS[-n]`.
 * Safe while the server runs; never changes the original. The work happens in `<name>.partial`, which is renamed to `<name>` as the
 * very last step; on any failure the folder created by THIS call is removed again (a killed run leaves a `.partial`, never a
 * normal-looking folder).
 * @param {{ dataDir: string, outDir: string, now?: Date }} o
 * @returns {Promise<{ dir: string, dataDir: string, dbBytes: number, uploads: { files: number, bytes: number, missing: number }, counts: { boards: number, posts: number, users: number }, latestPostAt: number|null, wal: { exists: boolean, modifiedAt: number|null }, warnings: string[] }>}
 *   `warnings` non-empty or `uploads.missing > 0` = the backup was made but may be incomplete.
 * @throws {BackupError} with a message for the person running the tool
 */
export async function backupData({ dataDir, outDir, now = new Date() } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new BackupError('dataDir 가 필요해요.');
  if (typeof outDir !== 'string' || !outDir.trim()) throw new BackupError('outDir 가 필요해요.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new BackupError('now 는 올바른 Date 여야 해요.');
  const dataAbs = path.resolve(dataDir);
  const outAbs = path.resolve(outDir);
  const dbFile = path.join(dataAbs, 'edulet.db');

  let isFile = false;
  try { isFile = fs.statSync(dbFile).isFile(); } catch { /* not there */ }
  if (!isFile) throw new BackupError(`data 폴더를 찾을 수 없어요: ${dataAbs} (서버를 켠 폴더의 data 인지 확인)`);
  if (isInside(outAbs, dataAbs)) throw new BackupError(`백업을 data 폴더 안에 만들 수는 없어요(백업이 백업을 다시 복사하게 돼요): ${outAbs}`);

  const { partialDir, finalDir } = createBackupDir(outAbs, now);
  const warnings = [];
  try {
    const wal = walInfo(path.join(dataAbs, 'edulet.db-wal'));
    const dbCopy = path.join(partialDir, 'edulet.db');
    snapshotDatabase(dbFile, dbCopy);
    const { counts, latestPostAt, uploadRows, userVersion } = verifySnapshot(dbCopy);
    const dbBytes = fs.statSync(dbCopy).size;
    const uploads = await copyUploads(path.join(dataAbs, 'uploads'), path.join(partialDir, 'uploads'), uploadRows, warnings);
    fs.writeFileSync(path.join(partialDir, 'BACKUP-INFO.txt'), infoText({ now, dataAbs, dir: finalDir, counts, latestPostAt, wal, uploads, dbBytes, userVersion, warnings }), 'utf8');
    await finishBackupDir(partialDir, finalDir);
    return { dir: finalDir, dataDir: dataAbs, dbBytes, uploads, counts, latestPostAt, wal, warnings };
  } catch (e) {
    let removed = false;
    try { removed = removeOwnBackup(outAbs, partialDir); } catch { /* reported below */ }
    if (!removed && e && typeof e === 'object') e.message += ` (만들다 만 백업 폴더를 지우지 못했어요 — 직접 지워 주세요: ${partialDir})`;
    throw e;
  }
}

// ---- command line ---------------------------------------------------------------------------------------------------

const USAGE = `사용법: node tools/backup.mjs [--data <폴더>] [--out <폴더>]
  --data  백업할 data 폴더 (기본: 환경변수 EDULET_DATA_DIR, 없으면 이 저장소의 data — 서버처럼 현재 폴더 기준이 아니에요)
  --out   백업을 만들 폴더 (기본: 이 저장소의 backups)
서버가 켜져 있어도 안전해요. 원본은 읽기만 하고 고치지 않아요.
종료 코드: 0 = 완전한 백업, 1 = 실패(만들던 폴더는 지움), 2 = 백업은 만들었지만 경고가 있어요(일부가 빠졌을 수 있어요).`;

function parseArgs(argv) {
  const o = { data: undefined, out: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    const eq = /^(--[a-z]+)=(.*)$/.exec(a);
    if (eq) { a = eq[1]; inline = eq[2]; }
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    if (a === '--data' || a === '--out') {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v === '' || (inline === undefined && v.startsWith('--'))) throw new BackupError(`${a} 뒤에 폴더 이름이 필요해요.\n${USAGE}`);
      o[a.slice(2)] = v;
      continue;
    }
    throw new BackupError(`알 수 없는 옵션이에요: ${argv[i]}\n${USAGE}`);
  }
  return o;
}

/** Defaults: data = $EDULET_DATA_DIR or <repo>/data (file-location based, NOT the current folder like the server), out = <repo>/backups. */
export function defaultPaths(env = process.env) {
  const fromEnv = env.EDULET_DATA_DIR;
  return {
    dataDir: fromEnv !== undefined && fromEnv !== '' ? path.resolve(fromEnv) : path.join(ROOT, 'data'),
    outDir: path.join(ROOT, 'backups'),
  };
}

/** Exit codes: 0 complete, 1 failed (nothing left behind), 2 made but incomplete/with warnings (the folder is kept). */
export async function main(argv = process.argv.slice(2), log = console.log, err = console.error) {
  try {
    const args = parseArgs(argv);
    if (args.help) { log(USAGE); return 0; }
    const d = defaultPaths();
    const r = await backupData({ dataDir: args.data ?? d.dataDir, outDir: args.out ?? d.outDir });
    const incomplete = r.warnings.length > 0 || r.uploads.missing > 0;
    if (incomplete) log('주의: 백업을 만들었지만 일부가 빠졌을 수 있어요');
    log(`백업을 만들었어요: ${r.dir}`);
    log(`원본: ${r.dataDir}`);
    log(`가장 최근 글: ${postText(r.latestPostAt)} · 원본 WAL 마지막 수정: ${walText(r.wal)}`);
    log(`보드 ${r.counts.boards}개 · 글 ${r.counts.posts}개 · 사용자 ${r.counts.users}명 · 업로드 파일 ${r.uploads.files}개(${fmtBytes(r.uploads.bytes)}) · 데이터베이스 ${fmtBytes(r.dbBytes)}`);
    if (r.counts.posts === 0) log('⚠ 글이 하나도 없어요 — 서버를 켠 폴더의 data 가 맞는지 확인하세요');
    for (const w of r.warnings) err(`경고: ${w}`);
    log('복원 방법은 그 폴더의 BACKUP-INFO.txt 에 있어요.');
    return incomplete ? 2 : 0;
  } catch (e) {
    const message = e instanceof BackupError ? e.message : String((e && e.message) || e).split(/\r?\n/)[0];
    err(`백업에 실패했어요: ${message}`);
    if (!(e instanceof BackupError) && process.env.EDULET_DEBUG) err((e && e.stack) || String(e));
    err('원본 data 는 고치지 않았어요.');
    return 1;
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const a = real(fileURLToPath(import.meta.url));
  const b = real(process.argv[1]);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (isMain) process.exitCode = await main();
