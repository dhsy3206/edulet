/* Edulet demo server — uploads (PUT /api/uploads, GET /uploads/<id>/<name>), upload lifetime, link-preview endpoint.
 * Port of server/uploads.js. Files live as Blobs in IndexedDB; seed images are static files fetched on demand. */
(function (E) {
  'use strict';
  const { C, HttpError, bad, now, randomHex, uploadUrl, normalizeUrl, sniffImage, normalizeFileName } = E;
  const { q } = E.db;
  const { router } = E;

  const SAFE_SERVE = /^(image\/(png|jpeg|gif|webp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/(pdf|zip|json)|text\/(plain|csv)|application\/vnd\.[\w.+-]+|application\/msword|application\/x-hwp[\w.+-]*|application\/haansoft[\w.+-]*)$/;
  const DAY_MS = 24 * 3600 * 1000;
  const UPLOAD_ID = /\/uploads\/([0-9a-f]{32}|seed-\d+)\//g;

  /* ───────── references & clean-up (server/uploads.js "L1") ───────── */
  function idsIn(text, into) {
    if (text) for (const m of String(text).matchAll(UPLOAD_ID)) into.add(m[1]);
  }
  /** Upload ids mentioned in the given strings (URLs / JSON). */
  function uploadIdsIn(...texts) {
    const ids = new Set();
    for (const t of texts) idsIn(t, ids);
    return ids;
  }
  /** Upload ids found in the given post rows ({att_url, att_preview}) — what those posts keep alive. */
  function uploadIdsOfPosts(rows) {
    const ids = new Set();
    for (const r of rows) { idsIn(r.att_url, ids); idsIn(r.att_preview, ids); }
    return ids;
  }
  function referencedUploadIds() {
    const ids = uploadIdsOfPosts(Object.values(E.db.state.posts));
    for (const b of Object.values(E.db.state.boards)) idsIn(b.wallpaper, ids);
    return ids;
  }
  function isReferenced(id) {
    const needle = `/uploads/${id}/`;
    return Object.values(E.db.state.posts).some((p) => (p.att_url || '').includes(needle) || (p.att_preview || '').includes(needle)) ||
      Object.values(E.db.state.boards).some((b) => (b.wallpaper || '').includes(needle));
  }
  function removeUpload(id) {
    delete E.db.state.uploads[id];
    E.db.dropBlob(id);
  }
  /**
   * Call AFTER deleting the posts/boards/wallpapers that referenced `ids`: every upload nothing references any more loses its
   * row and its blob. Still-referenced ones (a duplicated board shares files) stay. Static seed files are never removed.
   */
  function releaseUploads(ids, { detachFromBoard = null } = {}) {
    let removed = 0;
    for (const id of ids) {
      const up = q.upload(id);
      if (!up || up.static) continue;
      if (isReferenced(id)) {
        if (detachFromBoard != null && up.board_id === detachFromBoard) up.board_id = null;
        continue;
      }
      removeUpload(id);
      removed++;
    }
    return removed;
  }
  /** Uploads older than 24 h that no post attachment/preview image and no wallpaper references (never attached / post gone). */
  function gcUploads({ now: t = Date.now(), maxAgeMs = DAY_MS } = {}) {
    const refs = referencedUploadIds();
    let removed = 0;
    for (const up of Object.values(E.db.state.uploads)) {
      if (up.static || up.created_at >= t - maxAgeMs || refs.has(up.id)) continue;
      removeUpload(up.id);
      removed++;
    }
    return removed;
  }

  /* ───────── receiving ───────── */
  const tooLarge = () => new HttpError(413, 'too_large', '파일이 너무 커요.');
  function declaredMime(req) {
    const m = String(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(m) ? m : 'application/octet-stream';
  }

  router.add('PUT', '/uploads', async (c) => {
    const slug = c.query.board;
    if (!slug) throw bad('bad_request', 'board 가 필요해요.');
    E.needBoard(c, slug, 'write');
    const max = C.MAX_UPLOAD_MB * 1024 * 1024;
    const declared = Number(c.req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) throw tooLarge();
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.length > max) throw tooLarge();
    if (!buf.length) throw bad('empty_file', '빈 파일이에요.');
    const name = normalizeFileName(c.query.name);
    const declaredType = declaredMime(c.req);
    const sniffed = sniffImage(buf.subarray(0, 16));
    let mime;
    if (sniffed) mime = sniffed;
    else if (declaredType.startsWith('image/')) throw bad('unsupported_image', 'PNG, JPEG, GIF, WebP 이미지만 올릴 수 있어요.');
    else mime = declaredType;
    const kind = C.IMAGE_MIMES.includes(mime) ? 'image' : 'file';
    // The body took a while: permissions may have changed (kicked member, deleted board, revoked session) — check again.
    E.recheckSession(c);
    const fresh = E.needBoard(c, slug, 'write').board;
    const id = randomHex(16);
    try {
      await E.db.putBlob(id, { blob: new Blob([buf], { type: mime }), mime, name });
    } catch (e) {
      console.warn('[edulet-demo] blob write failed', e);
      throw new HttpError(413, 'too_large', '브라우저의 저장 공간이 부족해요. 다른 파일을 지우고 다시 해 주세요.');
    }
    E.db.state.uploads[id] = { id, user_id: c.user.id, board_id: fresh.id, name, mime, size: buf.length, created_at: now() };
    c.json({ id, url: uploadUrl(id, name), name, mime, size: buf.length, kind }, 201);
  });

  /* ───────── serving ───────── */
  function contentDisposition(kind, name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const star = encodeURIComponent(name).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
    return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
  }
  const text = (status, body, headers) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

  /** The blob of an upload row; seed files that are not cached yet are fetched from their static URL once. */
  async function blobOf(row) {
    const rec = await E.db.getBlob(row.id);
    if (rec) return rec;
    if (!row.static) return null;
    try {
      const r = await fetch(new URL(row.static, self.registration.scope));
      if (!r.ok) return null;
      const copy = { blob: new Blob([await r.arrayBuffer()], { type: row.mime }), mime: row.mime, name: row.name };
      await E.db.putBlob(row.id, copy);
      return copy;
    } catch {
      return null;
    }
  }

  /** GET/HEAD <scope>uploads/<id>/<name> — public (the id is an unguessable secret). `rel` = path inside the scope, e.g. /uploads/<id>/<name>. */
  async function serveUpload(req, rel) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    const m = /^\/uploads\/([0-9a-f]{32}|seed-\d+)(?:\/[^/]*)?$/.exec(rel);
    const row = m && q.upload(m[1]);
    const rec = row && (await blobOf(row));
    if (!row || !rec) return text(404, 'Not Found');
    const size = rec.blob.size;
    const isImage = C.IMAGE_MIMES.includes(row.mime);
    const headers = {
      'Content-Type': SAFE_SERVE.test(row.mime) ? row.mime : 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': contentDisposition(isImage ? 'inline' : 'attachment', row.name),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${row.id}"`,
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.get('range');
    if (range && /^bytes=/.test(range) && !range.includes(',')) {
      const mm = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!mm || (mm[1] === '' && mm[2] === '')) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      if (mm[1] === '') start = Math.max(0, size - Number(mm[2]));
      else { start = Number(mm[1]); if (mm[2] !== '') end = Math.min(end, Number(mm[2])); }
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    const body = req.method === 'HEAD' || size === 0 ? null : rec.blob.slice(start, end + 1, rec.blob.type);
    return new Response(body, { status, headers });
  }

  /* ───────── link preview endpoint ───────── */
  router.add('POST', '/link-preview', async (c) => {
    if (!c.user) throw new HttpError(401, 'unauthorized', '로그인이 필요해요.');
    c.volatile = true;
    const b = await c.body();
    return E.preview.resolve(normalizeUrl(b.url)); // throws 400 blocked_url for credentials / localhost / private IPs
  });

  Object.assign(E, { uploadIdsIn, uploadIdsOfPosts, releaseUploads, gcUploads, serveUpload });
})((self.EDU = self.EDU || {}));
