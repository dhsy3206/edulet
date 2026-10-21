// Uploads: raw-body PUT + public read-only serving with Range. CONTRACT §5 "업로드·링크".
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { IMAGE_MIMES } from './constants.js';
import { bad, readBody, sendText } from './http.js';
import { needBoard } from './access.js';
import { now, randomHex, sniffImage, uploadUrl } from './util.js';

const SAFE_SERVE = /^(image\/(png|jpeg|gif|webp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/(pdf|zip|json)|text\/(plain|csv)|application\/vnd\.[\w.+-]+|application\/msword|application\/x-hwp[\w.+-]*|application\/haansoft[\w.+-]*)$/;

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

export function registerUploads(app) {
  const dir = path.join(app.config.dataDir, 'uploads');
  const { db, router } = app;

  router.add('PUT', '/uploads', async (c) => {
    const slug = c.query.board;
    if (!slug) throw bad('bad_request', 'board 가 필요해요.');
    const { board } = needBoard(c, slug, 'write');
    const max = Math.floor(app.config.maxUploadMb * 1024 * 1024);
    const buf = await readBody(c.req, max);
    if (!buf.length) throw bad('empty_file', '빈 파일이에요.');
    const name = normalizeFileName(c.query.name);
    const declared = declaredMime(c.req);
    const sniffed = sniffImage(buf);
    let mime;
    if (sniffed) mime = sniffed;
    else if (declared.startsWith('image/')) throw bad('unsupported_image', 'PNG, JPEG, GIF, WebP 이미지만 올릴 수 있어요.');
    else mime = declared;
    const kind = IMAGE_MIMES.includes(mime) ? 'image' : 'file';
    const id = randomHex(16);
    const file = path.join(dir, id);
    await fsp.writeFile(file, buf);
    try {
      db.run('INSERT INTO uploads (id, user_id, board_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', id, c.user.id, board.id, name, mime, buf.length, now());
    } catch (e) {
      await fsp.rm(file, { force: true });
      throw e;
    }
    return c.json({ id, url: uploadUrl(id, name), name, mime, size: buf.length, kind }, 201);
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

