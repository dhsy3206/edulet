// Safe online backup of the Edulet data folder (edulet.db + uploads/) — the command line.
//
//   node tools/backup.mjs [--data <dir>] [--out <dir>]        (or double-click backup.cmd)
//
// The backup itself (backupData, verifySnapshot, BackupError, removeOwnBackup, ...) lives in server/backup.js: the server uses it for the
// "저장하기" / "불러오기" menu, and the Docker image has no tools/ folder. This file is only the command line plus a re-export of the
// names that used to be defined here (test/backup.test.js and anything else that imports tools/backup.mjs keep working). The invariants
// (original never modified, .partial -> rename, exit codes 0/1/2) are documented in server/backup.js and CONTRACT §1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupError, backupData, fmtBytes, postText, walText } from '../server/backup.js';

export { BackupError, backupData, removeOwnBackup, verifySnapshot } from '../server/backup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repository root = the folder of this file's parent (NOT the current folder — unlike the server's `./data`). */
export const ROOT = path.resolve(HERE, '..');

// ---- command line ---------------------------------------------------------------------------------------------------

const USAGE = `사용법: node tools/backup.mjs [--data <폴더>] [--out <폴더>]
  --data  백업할 data 폴더 (기본: 환경변수 EDULET_DATA_DIR, 없으면 이 저장소의 data — 서버처럼 현재 폴더 기준이 아니에요)
  --out   백업을 만들 폴더 (기본: 환경변수 EDULET_BACKUP_DIR, 없으면 이 저장소의 backups — 서버 화면의 '저장하기'와 같은 폴더)
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

/**
 * Defaults: data = $EDULET_DATA_DIR or <repo>/data (file-location based, NOT the current folder like the server),
 * out = $EDULET_BACKUP_DIR or <repo>/backups — the same folder the server's 저장하기/불러오기 menu uses (server/config.js reads the same variable).
 */
export function defaultPaths(env = process.env) {
  const set = (v) => v !== undefined && v !== '';
  return {
    dataDir: set(env.EDULET_DATA_DIR) ? path.resolve(env.EDULET_DATA_DIR) : path.join(ROOT, 'data'),
    outDir: set(env.EDULET_BACKUP_DIR) ? path.resolve(env.EDULET_BACKUP_DIR) : path.join(ROOT, 'backups'),
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
