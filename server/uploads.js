// Uploads: streamed raw-body PUT + public read-only serving with Range, abuse limits, orphan clean-up.
// CONTRACT §5 "업로드·링크" and §1 (limits).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { IMAGE_MIMES } from './constants.js';
import { HttpError, bad, discardBody, sendText, tooLargeError } from './http.js';
import { needBoard, recheckSession } from './access.js';
import { now, randomHex, sniffImage, uploadUrl } from './util.js';

const SAFE_SERVE = /^(image\/(png|jpeg|gif|webp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/(pdf|zip|json)|text\/(plain|csv)|application\/vnd\.[\w.+-]+|application\/msword|application\/x-hwp[\w.+-]*|application\/haansoft[\w.+-]*)$/;

const DAY_MS = 24 * 3600 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const IDLE_MS = 30 * 1000; // a body that stalls this long is abandoned (and its upload slot freed)
const STRAY_PART_MS = 3600 * 1000;
const UPLOAD_ID = /\/uploads\/([0-9a-f]{32})\//g;

export function normalizeFileName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  try { s = decodeURIComponent(s); } catch { /* use as-is */ }
  s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').replace(/[\\/]/g, '').replace(/\.\.+/g, '.').replace(/^\.+/, '').trim();
  if (s.length > 100) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 100 - ext.length) + ext;
  }
  return s || 'file';
}

function declaredMime(req) {
  const m = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(m) ? m : 'application/octet-stream';
}

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const star = encodeURIComponent(name).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

export const uploadsDir = (app) => path.join(app.config.dataDir, 'uploads');

// ---- references & clean-up (L1) ----------------------------------------------------------------

function idsIn(text, into) {
  if (text) for (const m of String(text).matchAll(UPLOAD_ID)) into.add(m[1]);
}

/** Upload ids mentioned in the given strings (URLs / JSON). */
export function uploadIdsIn(...texts) {
  const ids = new Set();
  for (const t of texts) idsIn(t, ids);
  return ids;
}

/** Upload ids found in the given post rows ({att_url, att_preview}) — what those posts keep alive. */
export function uploadIdsOfPosts(rows) {
  const ids = new Set();
  for (const r of rows) { idsIn(r.att_url, ids); idsIn(r.att_preview, ids); }
  return ids;
}

/** Every upload id that a post attachment/preview image or a board wallpaper points at. One pass over the tables. */
export function referencedUploadIds(db) {
  const ids = uploadIdsOfPosts(db.all("SELECT att_url, att_preview FROM posts WHERE att_url LIKE '/uploads/%' OR att_preview LIKE '%/uploads/%'"));
  for (const r of db.all("SELECT wallpaper FROM boards WHERE wallpaper LIKE '/uploads/%'")) idsIn(r.wallpaper, ids);
  return ids;
}

function isReferenced(db, id) {
  const needle = `/uploads/${id}/`;
  return !!(
    db.get('SELECT 1 AS x FROM posts WHERE instr(att_url, ?) > 0 OR instr(att_preview, ?) > 0 LIMIT 1', needle, needle) ||
    db.get('SELECT 1 AS x FROM boards WHERE instr(wallpaper, ?) > 0 LIMIT 1', needle)
  );
}

function removeUpload(app, id) {
  app.db.run('DELETE FROM uploads WHERE id = ?', id);
  try { fs.rmSync(path.join(uploadsDir(app), id), { force: true }); } catch { /* best effort */ }
}

/**
 * Call AFTER deleting the posts/boards/wallpapers that referenced `ids`: every upload that nothing references any more
 * loses its row and its file. Still-referenced ones (a duplicated board shares files) stay; if their row still points at
 * `detachFromBoard` (a board that was just deleted) it is detached so the row does not dangle.
 * @returns {number} how many uploads were removed
 */
export function releaseUploads(app, ids, { detachFromBoard = null } = {}) {
  let removed = 0;
  for (const id of ids) {
    if (isReferenced(app.db, id)) {
      if (detachFromBoard != null) app.db.run('UPDATE uploads SET board_id = NULL WHERE id = ? AND board_id = ?', id, detachFromBoard);
      continue;
    }
    removeUpload(app, id);
    removed++;
  }
  return removed;
}

/**
 * Delete upload rows + files older than `maxAgeMs` that no post attachment/preview image and no board wallpaper
 * references (orphans: uploaded but never attached, or whose post is gone), plus stale `.part` temp files.
 * `now` / `maxAgeMs` are injectable for tests.
 */
export function gcUploads(app, { now: t = Date.now(), maxAgeMs = DAY_MS } = {}) {
  const { db } = app;
  const refs = referencedUploadIds(db);
  let removed = 0;
  for (const { id } of db.all('SELECT id FROM uploads WHERE created_at < ?', t - maxAgeMs)) {
    if (refs.has(id)) continue;
    removeUpload(app, id);
    removed++;
  }
  let strays = 0;
  const dir = uploadsDir(app);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* folder missing: nothing to do */ }
  for (const name of names) {
    if (!/^\.[0-9a-f]{32}\.part$/.test(name)) continue;
    try {
      const f = path.join(dir, name);
      if (fs.statSync(f).mtimeMs < t - STRAY_PART_MS) { fs.rmSync(f, { force: true }); strays++; }
    } catch { /* raced with a finishing upload */ }
  }
  return { removed, strays };
}

// ---- receiving -----------------------------------------------------------------------------------

/**
 * Stream the request body into `file` (created exclusively, mode 600) while counting bytes. Memory stays at one chunk plus
 * the write buffer, never the whole body. Aborts (and deletes the file) on: > limit bytes (413), no data for `idleMs` (408),
 * client abort (400), write error. @returns {{size:number, head:Buffer}} head = the first 16 bytes (magic-byte check)
 */
async function receive(req, file, limit, idleMs) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) { discardBody(req, limit); throw tooLargeError(); }
  const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
  const closed = new Promise((resolve) => out.once('close', resolve));
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    await new Promise((resolve, reject) => {
      let idle;
      const stop = () => clearTimeout(idle);
      const arm = () => {
        stop();
        idle = setTimeout(() => { discardBody(req, limit); reject(new HttpError(408, 'request_timeout', '파일이 너무 천천히 올라와요. 다시 해 주세요.', { Connection: 'close' })); }, idleMs);
        idle.unref();
      };
      arm();
      out.on('error', (e) => { stop(); reject(e); });
      req.on('data', (ch) => {
        size += ch.length;
        if (size > limit) { stop(); discardBody(req, limit); reject(tooLargeError()); return; }
        arm();
        if (head.length < 16) head = Buffer.concat([head, ch.subarray(0, 16 - head.length)]);
        if (!out.write(ch)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('end', () => { stop(); out.end(resolve); });
      req.on('error', (e) => { stop(); reject(e); });
      req.on('close', () => { if (!req.complete) { stop(); reject(new HttpError(400, 'aborted', '요청이 중단됐어요.')); } });
    });
  } catch (e) {
    out.destroy();
    await closed;
    await fsp.rm(file, { force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {});
    throw e;
  }
  await closed;
  return { size, head };
}

export function registerUploads(app) {
  const dir = uploadsDir(app);
  const { db, router } = app;
  const cfg = app.config;
  const slots = { total: 0, byUser: new Map() };
  const quotaBytes = () => Math.floor(cfg.uploadQuotaMb * 1024 * 1024);
  const usedBytes = (uid) => db.get('SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE user_id = ? AND created_at > ?', uid, now() - DAY_MS).n;

  app.gcUploads = (o) => gcUploads(app, o);

  router.add('PUT', '/uploads', async (c) => {
    const slug = c.query.board;
    if (!slug) throw bad('bad_request', 'board 가 필요해요.');
    const { board } = needBoard(c, slug, 'write');
    const uid = c.user.id;
    const max = Math.floor(cfg.maxUploadMb * 1024 * 1024);
    const declared = Number(c.req.headers['content-length']);
    // Refusals below happen before the body is read: for a big/unknown-length body also cut the connection so it is not
    // received for nothing; a small body is simply read and dropped by node, so the client still sees the 429.
    const refuse = (code, message, retry) => new HttpError(429, code, message, {
      'Retry-After': String(retry), ...(declared <= max ? {} : { Connection: 'close' }),
    });

    if (slots.total >= cfg.uploadMaxConcurrent || (slots.byUser.get(uid) ?? 0) >= cfg.uploadMaxPerUser) {
      throw refuse('busy', '지금 올라가는 파일이 많아요. 잠시 뒤에 다시 해 주세요.', 5);
    }
    if (!app.rate.hit('upload:' + uid, cfg.uploadRateMax, RATE_WINDOW_MS)) {
      throw refuse('rate_limited', '파일을 너무 자주 올리고 있어요. 잠시 뒤에 다시 해 주세요.', 60);
    }
    const quotaMsg = '하루에 올릴 수 있는 용량을 넘었어요. 내일 다시 해 주세요.';
    if (usedBytes(uid) + (Number.isFinite(declared) ? declared : 0) > quotaBytes()) throw refuse('quota_exceeded', quotaMsg, 3600);

    slots.total++;
    slots.byUser.set(uid, (slots.byUser.get(uid) ?? 0) + 1);
    const id = randomHex(16);
    const tmp = path.join(dir, `.${id}.part`);
    const file = path.join(dir, id);
    try {
      const got = await receive(c.req, tmp, max, app.uploadIdleMs ?? IDLE_MS);
      if (!got.size) throw bad('empty_file', '빈 파일이에요.');
      const name = normalizeFileName(c.query.name);
      const declaredType = declaredMime(c.req);
      const sniffed = sniffImage(got.head);
      let mime;
      if (sniffed) mime = sniffed;
      else if (declaredType.startsWith('image/')) throw bad('unsupported_image', 'PNG, JPEG, GIF, WebP 이미지만 올릴 수 있어요.');
      else mime = declaredType;
      const kind = IMAGE_MIMES.includes(mime) ? 'image' : 'file';
      if (usedBytes(uid) + got.size > quotaBytes()) throw refuse('quota_exceeded', quotaMsg, 3600);
      await fsp.rename(tmp, file);
      try {
        // The body took a while: permissions may have changed (kicked member, deleted board, revoked session) — re-check now.
        recheckSession(c);
        const fresh = needBoard(c, slug, 'write').board;
        db.run('INSERT INTO uploads (id, user_id, board_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', id, uid, fresh.id, name, mime, got.size, now());
      } catch (e) {
        await fsp.rm(file, { force: true });
        throw e;
      }
      return c.json({ id, url: uploadUrl(id, name), name, mime, size: got.size, kind }, 201);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {}); // already gone on most paths
      throw e;
    } finally {
      slots.total--;
      const left = (slots.byUser.get(uid) ?? 1) - 1;
      if (left > 0) slots.byUser.set(uid, left); else slots.byUser.delete(uid);
    }
  });

  /** GET/HEAD /uploads/<id>/<name> — public (the id is an unguessable secret). */
  app.serveUpload = async (req, res, pathname) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    const m = /^\/uploads\/([0-9a-f]{32})(?:\/[^/]*)?$/.exec(pathname);
    const row = m && db.get('SELECT * FROM uploads WHERE id = ?', m[1]);
    let st;
    try { st = row ? await fsp.stat(path.join(dir, row.id)) : null; } catch { st = null; }
    if (!row || !st) return sendText(res, 404, 'Not Found');

    const size = st.size;
    const isImage = IMAGE_MIMES.includes(row.mime);
    const type = SAFE_SERVE.test(row.mime) ? row.mime : 'application/octet-stream';
    const etag = `"${row.id}"`;
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': contentDisposition(isImage ? 'inline' : 'attachment', row.name),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }

    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range && /^bytes=/.test(range) && !range.includes(',')) {
      const mm = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!mm || (mm[1] === '' && mm[2] === '')) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      if (mm[1] === '') { start = Math.max(0, size - Number(mm[2])); }
      else { start = Number(mm[1]); if (mm[2] !== '') end = Math.min(end, Number(mm[2])); }
      if (start >= size || start > end) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    try {
      await pipeline(fs.createReadStream(path.join(dir, row.id), { start, end }), res);
    } catch { res.destroy(); }
  };
}
