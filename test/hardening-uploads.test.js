// Hardening: streamed uploads and their limits (H2), re-authorisation after the body (L2), orphan clean-up (L1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { PNG, addMember, makeBoard, makeUser, sleep, slowUpload, startApp } from './helpers.js';

// `gc()` without --expose-gc: lets the test tell live buffers (what we are after) from garbage that V8 has not collected yet
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const putBytes = (c, slug, name, body, type = 'application/octet-stream') =>
  c.put(`/api/uploads?board=${slug}&name=${encodeURIComponent(name)}`, body, { raw: true, headers: { 'content-type': type } });
const upDir = (a) => path.join(a.dir, 'uploads');
const files = (a) => fs.readdirSync(upDir(a));
const exists = (a, id) => fs.existsSync(path.join(upDir(a), id));
const rows = (a) => a.db.get('SELECT COUNT(*) AS n FROM uploads').n;
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(15); }
  return false;
};
const attach = (c, slug, up, extra = {}) => c.post(`/api/boards/${slug}/posts`, { title: 't', attachment: { kind: up.kind, uploadId: up.id }, ...extra });

describe('H2: the body is streamed to a temp file, not buffered', () => {
  it('a 20 MB upload lands byte-exact while live memory stays far below the body size', async () => {
    const app = await startApp({ config: { maxUploadMb: 64, uploadQuotaMb: 1000, uploadRateMax: 1000 } });
    try {
      const u = makeUser(app, 'big');
      const b = await makeBoard(u, { title: 'b' });
      const chunk = Buffer.alloc(256 * 1024);
      for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) & 255;
      const send = (n) => new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const req = http.request(`${app.url}/api/uploads?board=${b.slug}&name=big.bin`, {
          method: 'PUT', headers: { cookie: u.cookie, 'content-type': 'application/octet-stream', 'content-length': chunk.length * n },
        }, (res) => { const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(parts).toString()), sha: hash.digest('hex') })); });
        req.on('error', reject);
        let i = 0;
        const pump = () => {
          while (i < n) {
            i++;
            hash.update(chunk);
            if (!req.write(chunk)) { req.once('drain', pump); return; }
          }
          req.end();
        };
        pump();
      });
      await send(8); // warm-up (JIT, allocator)
      gc();
      const base = process.memoryUsage().arrayBuffers;
      let peak = base;
      const sampler = setInterval(() => { gc(); peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 10);
      const r = await send(80); // 20 MB
      clearInterval(sampler);
      assert.equal(r.status, 201);
      assert.equal(r.json.size, chunk.length * 80);
      const onDisk = path.join(upDir(app), r.json.id);
      assert.equal(fs.statSync(onDisk).size, chunk.length * 80);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(onDisk)).digest('hex'), r.sha, 'content is byte-exact');
      const growthMb = (peak - base) / 1048576;
      // live buffer memory (garbage collected continuously): the old code held ~2x the body (40 MB for this upload)
      assert.ok(growthMb < 8, `buffers grew ${growthMb.toFixed(1)} MB while receiving 20 MB`);
      assert.equal(files(app).filter((n) => n.endsWith('.part')).length, 0);
    } finally { await app.close(); }
  });

  it('magic-byte validation and Range serving still work on streamed files', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const u = makeUser(app, 'm');
      const b = await makeBoard(u, { title: 'b' });
      const png = (await putBytes(u, b.slug, 'a.png', PNG, 'application/octet-stream')).json;
      assert.equal(png.mime, 'image/png');
      assert.equal(png.kind, 'image');
      const fake = await putBytes(u, b.slug, 'a.png', Buffer.from('not an image'), 'image/png');
      assert.equal(fake.status, 400);
      assert.equal(fake.json.error.code, 'unsupported_image');
      const txt = (await putBytes(u, b.slug, 'r.txt', Buffer.from('0123456789'), 'text/plain')).json;
      const r = await fetch(app.url + txt.url, { headers: { range: 'bytes=2-4' } });
      assert.equal(r.status, 206);
      assert.equal(await r.text(), '234');
      assert.equal((await putBytes(u, b.slug, 'e.txt', Buffer.alloc(0), 'text/plain')).status, 400);
      assert.equal(files(app).filter((n) => n.endsWith('.part')).length, 0, 'rejected uploads leave no temp file');
      assert.equal(files(app).length, 2);
    } finally { await app.close(); }
  });

  it('oversize (declared or streamed) and aborted uploads leave neither rows nor temp files, and free their slot', async () => {
    const app = await startApp({ config: { maxUploadMb: 0.01, uploadMaxPerUser: 1, uploadRateMax: 1000 } }); // 10,485 bytes
    try {
      const u = makeUser(app, 'o');
      const b = await makeBoard(u, { title: 'b' });
      assert.equal((await putBytes(u, b.slug, 'big.bin', Buffer.alloc(20000))).status, 413);
      const s = slowUpload(app, u, b.slug, { first: Buffer.alloc(8000) });
      await sleep(60);
      const over = await s.finish(Buffer.alloc(8000)); // 16,000 > limit, no Content-Length
      assert.ok(over.error || over.status === 413, JSON.stringify(over.status ?? String(over.error)));
      const aborted = slowUpload(app, u, b.slug, { first: Buffer.alloc(5000) });
      await sleep(60);
      aborted.abort();
      await aborted.result;
      assert.ok(await waitFor(() => files(app).length === 0), `left over: ${files(app)}`);
      assert.equal(rows(app), 0);
      assert.equal((await putBytes(u, b.slug, 'ok.txt', Buffer.from('x'), 'text/plain')).status, 201, 'the single per-user slot was released');
    } finally { await app.close(); }
  });

  it('a stalled body is abandoned (408) and its slot is freed', async () => {
    const app = await startApp({ uploadIdleMs: 150, config: { uploadMaxPerUser: 1, uploadRateMax: 1000 } });
    try {
      const u = makeUser(app, 'idle');
      const b = await makeBoard(u, { title: 'b' });
      const s = slowUpload(app, u, b.slug);
      const r = await s.result;
      assert.ok(r.error || r.status === 408, JSON.stringify(r.status ?? String(r.error)));
      if (r.status) assert.equal(r.json.error.code, 'request_timeout');
      assert.ok(await waitFor(() => files(app).length === 0));
      assert.equal((await putBytes(u, b.slug, 'next.txt', Buffer.from('x'), 'text/plain')).status, 201);
    } finally { await app.close(); }
  });
});

describe('H2: concurrency cap, rate limit and quota', () => {
  it('uploads in flight are capped per user (2) and globally -> 429 busy; slots come back when an upload ends', async () => {
    const app = await startApp({ config: { uploadMaxPerUser: 2, uploadMaxConcurrent: 3, uploadRateMax: 1000 } });
    try {
      const b = await makeBoard(makeUser(app, 'o'), { title: 'b', linkAccess: 'write' });
      const [a, bb, c] = [makeUser(app, 'a'), makeUser(app, 'b'), makeUser(app, 'c')];
      const a1 = slowUpload(app, a, b.slug);
      const a2 = slowUpload(app, a, b.slug);
      await sleep(100);
      const third = await putBytes(a, b.slug, 'x.txt', Buffer.from('x'), 'text/plain');
      assert.equal(third.status, 429);
      assert.equal(third.json.error.code, 'busy');
      assert.ok(third.headers.get('retry-after'));
      const b1 = slowUpload(app, bb, b.slug);
      await sleep(100);
      const global = await putBytes(c, b.slug, 'x.txt', Buffer.from('x'), 'text/plain');
      assert.equal(global.status, 429, 'three in flight server-wide');
      assert.equal(global.json.error.code, 'busy');
      assert.equal((await a1.finish(Buffer.from('end'))).status, 201);
      assert.equal((await putBytes(c, b.slug, 'x.txt', Buffer.from('x'), 'text/plain')).status, 201, 'a slot is free again');
      assert.equal((await a2.finish()).status, 201);
      assert.equal((await b1.finish()).status, 201);
      assert.equal(files(app).length, 4);
    } finally { await app.close(); }
  });

  it('rate limit: N uploads per user per 10 minutes (failed ones count) -> 429 rate_limited', async () => {
    const app = await startApp({ config: { uploadRateMax: 3 } });
    try {
      const b = await makeBoard(makeUser(app, 'o'), { title: 'b', linkAccess: 'write' });
      const u = makeUser(app, 'u');
      assert.equal((await putBytes(u, b.slug, 'a.txt', Buffer.from('x'), 'text/plain')).status, 201);
      assert.equal((await putBytes(u, b.slug, 'a.png', Buffer.from('nope'), 'image/png')).status, 400);
      assert.equal((await putBytes(u, b.slug, 'c.txt', Buffer.from('x'), 'text/plain')).status, 201);
      const r = await putBytes(u, b.slug, 'd.txt', Buffer.from('x'), 'text/plain');
      assert.equal(r.status, 429);
      assert.equal(r.json.error.code, 'rate_limited');
      assert.ok(r.headers.get('retry-after'));
      assert.match(r.json.error.message, /[가-힣]/);
      assert.equal((await putBytes(makeUser(app, 'v'), b.slug, 'a.txt', Buffer.from('x'), 'text/plain')).status, 201, 'other users are unaffected');
    } finally { await app.close(); }
  });

  it('byte quota per user per 24 h -> 429 quota_exceeded (declared size and streamed size), old rows stop counting', async () => {
    const app = await startApp({ config: { uploadQuotaMb: 0.0005, uploadRateMax: 1000 } }); // 524 bytes
    try {
      const b = await makeBoard(makeUser(app, 'o'), { title: 'b', linkAccess: 'write' });
      const u = makeUser(app, 'u');
      assert.equal((await putBytes(u, b.slug, 'a.bin', Buffer.alloc(400))).status, 201);
      const declared = await putBytes(u, b.slug, 'b.bin', Buffer.alloc(400));
      assert.equal(declared.status, 429);
      assert.equal(declared.json.error.code, 'quota_exceeded');
      assert.match(declared.json.error.message, /[가-힣]/);
      const streamed = await slowUpload(app, u, b.slug, { first: Buffer.alloc(300) }).finish(Buffer.alloc(300)); // no Content-Length
      assert.equal(streamed.status, 429);
      assert.equal(streamed.json.error.code, 'quota_exceeded');
      assert.equal(files(app).length, 1, 'the over-quota upload left nothing behind');
      assert.equal((await putBytes(makeUser(app, 'w'), b.slug, 'a.bin', Buffer.alloc(400))).status, 201, 'quota is per user');
      app.db.run('UPDATE uploads SET created_at = ? WHERE user_id = ?', Date.now() - 25 * 3600 * 1000, u.id);
      assert.equal((await putBytes(u, b.slug, 'c.bin', Buffer.alloc(400))).status, 201, 'uploads older than 24 h no longer count');
    } finally { await app.close(); }
  });
});

describe('L2: authorisation is re-checked after the body arrived', () => {
  it('a member removed while uploading gets 403/404 and nothing is stored', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const o = makeUser(app, 'o');
      const m = makeUser(app, 'm');
      const pub = await makeBoard(o, { title: 'pub', linkAccess: 'read' });
      const priv = await makeBoard(o, { title: 'priv', visibility: 'private' });
      await addMember(o, pub, m, 'write');
      await addMember(o, priv, m, 'write');
      const s1 = slowUpload(app, m, pub.slug);
      const s2 = slowUpload(app, m, priv.slug);
      await sleep(100);
      await o.del(`/api/boards/${pub.slug}/members/${m.id}`);
      await o.del(`/api/boards/${priv.slug}/members/${m.id}`);
      assert.equal((await s1.finish(Buffer.from('rest'))).status, 403, 'public board: demoted to the link role (read)');
      assert.equal((await s2.finish(Buffer.from('rest'))).status, 404, 'private board: no longer visible');
      assert.equal(rows(app), 0);
      assert.equal(files(app).length, 0);
    } finally { await app.close(); }
  });

  it('a board deleted while uploading answers 404 (not 500) and stores nothing', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const o = makeUser(app, 'o');
      const b = await makeBoard(o, { title: 'b' });
      const s = slowUpload(app, o, b.slug);
      await sleep(100);
      await o.del(`/api/boards/${b.slug}`);
      const r = await s.finish(Buffer.from('rest'));
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, 'not_found');
      assert.equal(rows(app), 0);
      assert.equal(files(app).length, 0);
    } finally { await app.close(); }
  });

  it('a session revoked while uploading is refused (401)', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const b = await makeBoard(makeUser(app, 'o'), { title: 'b', linkAccess: 'write' });
      const u = makeUser(app, 'u');
      const s = slowUpload(app, u, b.slug);
      await sleep(100);
      app.db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      const r = await s.finish(Buffer.from('rest'));
      assert.equal(r.status, 401);
      assert.equal(files(app).length, 0);
    } finally { await app.close(); }
  });
});

describe('L1: orphaned uploads are garbage-collected, and files go with their last reference', () => {
  it('gcUploads: removes old unreferenced uploads only (post attachment, wallpaper and young uploads stay); clock and threshold are injectable', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const u = makeUser(app, 'u');
      const b = await makeBoard(u, { title: 'b' });
      const orphan = (await putBytes(u, b.slug, 'orphan.png', PNG)).json;
      const attached = (await putBytes(u, b.slug, 'attached.png', PNG)).json;
      const paper = (await putBytes(u, b.slug, 'paper.png', PNG)).json;
      assert.equal((await attach(u, b.slug, attached)).status, 201);
      assert.equal((await u.patch(`/api/boards/${b.slug}`, { wallpaper: paper.url })).status, 200);
      const t = Date.now();
      assert.deepEqual(app.app.gcUploads({ now: t }), { removed: 0, strays: 0 }, 'nothing is 24 h old yet');
      assert.deepEqual(app.app.gcUploads({ now: t + 23 * 3600 * 1000 }), { removed: 0, strays: 0 });
      // stray temp files from a crashed upload: only stale ones go
      const part = path.join(upDir(app), `.${'a'.repeat(32)}.part`);
      fs.writeFileSync(part, 'x');
      assert.equal(app.app.gcUploads({ now: t }).strays, 0, 'a fresh temp file may belong to a running upload');
      const r = app.app.gcUploads({ now: t + 25 * 3600 * 1000 });
      assert.deepEqual(r, { removed: 1, strays: 1 });
      assert.equal(exists(app, orphan.id), false);
      assert.equal(app.db.get('SELECT 1 AS x FROM uploads WHERE id = ?', orphan.id), undefined);
      assert.equal(exists(app, attached.id), true);
      assert.equal(exists(app, paper.id), true);
      assert.equal((await fetch(app.url + orphan.url)).status, 404);
      assert.equal((await fetch(app.url + attached.url)).status, 200);
      // threshold: maxAgeMs 0 treats everything as old — referenced files still survive
      const extra = (await putBytes(u, b.slug, 'extra.png', PNG)).json;
      await sleep(5);
      assert.deepEqual(app.app.gcUploads({ maxAgeMs: 0 }), { removed: 1, strays: 0 });
      assert.equal(exists(app, extra.id), false);
      assert.equal(exists(app, attached.id), true);
    } finally { await app.close(); }
  });

  it('gc also runs when the server starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edulet-gc-'));
    let first;
    let second;
    try {
      first = await startApp({ dataDir: dir, config: { uploadRateMax: 1000 } });
      const u = makeUser(first, 'u');
      const b = await makeBoard(u, { title: 'b' });
      const orphan = (await putBytes(u, b.slug, 'orphan.png', PNG)).json;
      const kept = (await putBytes(u, b.slug, 'kept.png', PNG)).json;
      await attach(u, b.slug, kept);
      await first.close();
      first = null;
      await sleep(5);
      second = await startApp({ dataDir: dir, uploadGcMaxAgeMs: 0 });
      assert.equal(fs.existsSync(path.join(dir, 'uploads', orphan.id)), false);
      assert.equal(fs.existsSync(path.join(dir, 'uploads', kept.id)), true);
      assert.equal(second.db.get('SELECT COUNT(*) AS n FROM uploads').n, 1);
    } finally {
      if (first) await first.close();
      if (second) await second.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('deleting the last referencing post removes the file; a second reference keeps it alive', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const u = makeUser(app, 'u');
      const b = await makeBoard(u, { title: 'b' });
      const up = (await putBytes(u, b.slug, 'shared.png', PNG)).json;
      const p1 = (await attach(u, b.slug, up)).json.post;
      const p2 = (await attach(u, b.slug, up)).json.post;
      assert.equal((await u.del(`/api/posts/${p1.id}`)).status, 200);
      assert.equal(exists(app, up.id), true, 'p2 still uses it');
      assert.equal((await fetch(app.url + up.url)).status, 200);
      assert.equal((await u.del(`/api/posts/${p2.id}`)).status, 200);
      assert.equal(exists(app, up.id), false);
      assert.equal(app.db.get('SELECT 1 AS x FROM uploads WHERE id = ?', up.id), undefined);
      assert.equal((await fetch(app.url + up.url)).status, 404);
    } finally { await app.close(); }
  });

  it('replacing or removing the attachment, and replacing an uploaded wallpaper, releases the old file', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const u = makeUser(app, 'u');
      const b = await makeBoard(u, { title: 'b' });
      const [a1, a2] = [(await putBytes(u, b.slug, 'a1.png', PNG)).json, (await putBytes(u, b.slug, 'a2.png', PNG)).json];
      const p = (await attach(u, b.slug, a1)).json.post;
      assert.equal((await u.patch(`/api/posts/${p.id}`, { title: 'same upload again', attachment: { kind: 'image', uploadId: a1.id } })).status, 200);
      assert.equal(exists(app, a1.id), true, 'unchanged attachment keeps its file');
      assert.equal((await u.patch(`/api/posts/${p.id}`, { attachment: { kind: 'image', uploadId: a2.id } })).status, 200);
      assert.equal(exists(app, a1.id), false);
      assert.equal(exists(app, a2.id), true);
      assert.equal((await u.patch(`/api/posts/${p.id}`, { title: 'keep text', attachment: null })).status, 200);
      assert.equal(exists(app, a2.id), false);
      const [w1, w2] = [(await putBytes(u, b.slug, 'w1.png', PNG)).json, (await putBytes(u, b.slug, 'w2.png', PNG)).json];
      await u.patch(`/api/boards/${b.slug}`, { wallpaper: w1.url });
      await u.patch(`/api/boards/${b.slug}`, { wallpaper: w2.url });
      assert.equal(exists(app, w1.id), false);
      assert.equal(exists(app, w2.id), true);
      await u.patch(`/api/boards/${b.slug}`, { wallpaper: 'ocean' });
      assert.equal(exists(app, w2.id), false);
    } finally { await app.close(); }
  });

  it('a duplicated board shares its files: they go only with the last board that uses them', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const u = makeUser(app, 'u');
      const b = await makeBoard(u, { title: 'orig' });
      const up = (await putBytes(u, b.slug, 'shared.png', PNG)).json;
      const paper = (await putBytes(u, b.slug, 'paper.png', PNG)).json;
      await attach(u, b.slug, up);
      await u.patch(`/api/boards/${b.slug}`, { wallpaper: paper.url });
      const copy = (await u.post(`/api/boards/${b.slug}/duplicate`, { withPosts: true })).json.board;
      assert.equal((await u.del(`/api/boards/${b.slug}`)).status, 200);
      assert.equal(exists(app, up.id), true, 'the copy still shows it');
      assert.equal(exists(app, paper.id), true, 'and uses the wallpaper');
      assert.equal((await fetch(app.url + up.url)).status, 200);
      assert.equal(app.db.get('SELECT board_id FROM uploads WHERE id = ?', up.id).board_id, null, 'detached from the deleted board');
      assert.equal((await u.del(`/api/boards/${copy.slug}`)).status, 200);
      assert.equal(exists(app, up.id), false);
      assert.equal(exists(app, paper.id), false);
      assert.equal(rows(app), 0);
    } finally { await app.close(); }
  });

  it('deleting a section together with its posts releases their files; moving them does not', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const u = makeUser(app, 'u');
      const b = await makeBoard(u, { title: 'b', template: 'kwl' });
      const secs = (await u.get(`/api/boards/${b.slug}`)).json.sections;
      const [keep, drop] = [(await putBytes(u, b.slug, 'keep.png', PNG)).json, (await putBytes(u, b.slug, 'drop.png', PNG)).json];
      await attach(u, b.slug, keep, { sectionId: secs[0].id });
      await attach(u, b.slug, drop, { sectionId: secs[2].id });
      assert.equal((await u.del(`/api/sections/${secs[0].id}?posts=move`)).status, 200); // keep moves to the next section
      assert.equal(exists(app, keep.id), true);
      assert.equal((await u.del(`/api/sections/${secs[2].id}?posts=delete`)).status, 200);
      assert.equal(exists(app, drop.id), false);
      assert.equal(exists(app, keep.id), true);
    } finally { await app.close(); }
  });

  it('link-preview thumbnails stored with a post keep their upload alive too', async () => {
    const app = await startApp({ config: { uploadRateMax: 1000 } });
    try {
      const u = makeUser(app, 'u');
      const b = await makeBoard(u, { title: 'b' });
      const thumb = (await putBytes(u, b.slug, 'thumb.png', PNG)).json;
      const t = Date.now();
      app.db.run(
        "INSERT INTO posts (board_id, author_id, title, body, status, rank, att_kind, att_url, att_preview, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        b.id, u.id, 'seeded link', '', 'published', 1, 'link', 'https://x.example/', JSON.stringify({ title: 'x', image: thumb.url }), t, t,
      );
      app.app.gcUploads({ now: t + 48 * 3600 * 1000 });
      assert.equal(exists(app, thumb.id), true);
    } finally { await app.close(); }
  });
});
