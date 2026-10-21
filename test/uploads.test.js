import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client, PNG, addMember, makeBoard, makeUser, startApp } from './helpers.js';

let app;
let owner;
let board;
before(async () => {
  app = await startApp({ config: { maxUploadMb: 0.05 } }); // 52,428 bytes
  owner = makeUser(app, 'owner');
  board = await makeBoard(owner, { title: '업로드', linkAccess: 'comment' });
});
after(async () => { await app.close(); });

const put = (c, name, body, type, slug = board.slug) =>
  c.put(`/api/uploads?board=${slug}&name=${encodeURIComponent(name)}`, body, { raw: true, headers: { 'content-type': type } });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(30)]);

describe('upload: images', () => {
  it('png/jpeg/gif/webp are accepted and the MIME comes from the magic bytes', async () => {
    const cases = [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [GIF, 'image/gif'], [WEBP, 'image/webp']];
    for (const [buf, mime] of cases) {
      // declared type is wrong / generic on purpose
      for (const declared of [mime, 'application/octet-stream', 'image/jpeg', '']) {
        const r = await put(owner, 'pic.bin', buf, declared || 'application/octet-stream');
        assert.equal(r.status, 201, `${mime} declared ${declared}: ${r.text}`);
        assert.equal(r.json.mime, mime);
        assert.equal(r.json.kind, 'image');
        assert.equal(r.json.size, buf.length);
      }
    }
  });

  it('response shape and stored record', async () => {
    const r = await put(owner, 'my photo.png', PNG, 'image/png');
    assert.deepEqual(Object.keys(r.json).sort(), ['id', 'kind', 'mime', 'name', 'size', 'url']);
    assert.match(r.json.id, /^[0-9a-f]{32}$/);
    assert.equal(r.json.url, `/uploads/${r.json.id}/my%20photo.png`);
    assert.equal(r.json.name, 'my photo.png');
    const row = app.db.get('SELECT * FROM uploads WHERE id = ?', r.json.id);
    assert.deepEqual([row.user_id, row.board_id, row.mime, row.size], [owner.id, board.id, 'image/png', PNG.length]);
    assert.ok(fs.existsSync(path.join(app.dir, 'uploads', r.json.id)));
  });

  it('SVG is rejected (any declared image type that is not a real raster image)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    for (const type of ['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/x-icon']) {
      const r = await put(owner, 'x.svg', svg, type);
      assert.equal(r.status, 400, type);
      assert.equal(r.json.error.code, 'unsupported_image');
    }
    const fake = await put(owner, 'fake.png', Buffer.from('this is not a png at all'), 'image/png');
    assert.equal(fake.status, 400);
    const truncated = await put(owner, 'x.png', PNG.subarray(0, 5), 'image/png');
    assert.equal(truncated.status, 400);
  });

  it('inline image serving: nosniff, sandbox CSP, immutable cache, Accept-Ranges', async () => {
    const up = (await put(owner, '한글 사진.png', PNG, 'image/png')).json;
    const r = await fetch(app.url + up.url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.match(r.headers.get('content-disposition'), /^inline/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-security-policy'), 'sandbox');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-length'), String(PNG.length));
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
    // public: no cookie needed, name part is cosmetic
    assert.equal((await fetch(`${app.url}/uploads/${up.id}/whatever.png`)).status, 200);
    assert.equal((await fetch(`${app.url}/uploads/${up.id}`)).status, 200);
  });
});

describe('upload: other files', () => {
  it('non-images are kind=file and served as attachments with the safest headers', async () => {
    const r = await put(owner, '보고서.pdf', Buffer.from('%PDF-1.4 fake'), 'application/pdf');
    assert.equal(r.status, 201);
    assert.equal(r.json.kind, 'file');
    assert.equal(r.json.mime, 'application/pdf');
    const g = await fetch(app.url + r.json.url);
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'application/pdf');
    assert.match(g.headers.get('content-disposition'), /^attachment; filename="[^"]*"; filename\*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C\.pdf$/);
    assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(g.headers.get('content-security-policy'), 'sandbox');
    await g.arrayBuffer();
  });

  it('active content (html/xml/js) is never served with an executable type', async () => {
    for (const [name, type] of [['a.html', 'text/html'], ['b.xhtml', 'application/xhtml+xml'], ['c.js', 'text/javascript'], ['d.xml', 'text/xml'], ['e.svgz', 'application/octet-stream']]) {
      const r = await put(owner, name, Buffer.from('<script>alert(1)</script>'), type);
      assert.equal(r.status, 201, name);
      assert.equal(r.json.kind, 'file');
      const g = await fetch(app.url + r.json.url);
      assert.equal(g.headers.get('content-type'), 'application/octet-stream', name);
      assert.match(g.headers.get('content-disposition'), /^attachment/);
      assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(g.headers.get('content-security-policy'), 'sandbox');
      await g.arrayBuffer();
    }
  });

  it('names are normalised: no path separators, <= 100 chars, never empty', async () => {
    const cases = ['../../etc/passwd', '..\\..\\win.ini', 'a/b/c.txt', '', '....', 'x'.repeat(300) + '.txt', 'tab\tname\n.txt'];
    for (const n of cases) {
      const r = await put(owner, n, Buffer.from('x'), 'text/plain');
      assert.equal(r.status, 201, JSON.stringify(n));
      assert.ok(!/[\\/]/.test(r.json.name), r.json.name);
      assert.ok(r.json.name.length >= 1 && r.json.name.length <= 100, r.json.name);
      assert.ok(!r.json.name.startsWith('.'));
      assert.ok(!/[\u0000-\u001f]/.test(r.json.name));
      const g = await fetch(app.url + r.json.url);
      assert.equal(g.status, 200);
      await g.arrayBuffer();
    }
    const long = await put(owner, 'x'.repeat(300) + '.txt', Buffer.from('x'), 'text/plain');
    assert.ok(long.json.name.endsWith('.txt'), 'extension survives truncation');
    const noName = await owner.put(`/api/uploads?board=${board.slug}`, Buffer.from('x'), { raw: true, headers: { 'content-type': 'text/plain' } });
    assert.equal(noName.json.name, 'file');
    assert.equal(fs.readdirSync(path.join(app.dir, 'uploads')).every((f) => /^[0-9a-f]{32}$/.test(f)), true, 'files are stored by id only');
  });
});

describe('upload: limits and access', () => {
  it('too large -> 413 too_large (Content-Length precheck and streamed overflow)', async () => {
    const big = Buffer.alloc(120 * 1024, 7);
    const r = await put(owner, 'big.bin', big, 'application/octet-stream');
    assert.equal(r.status, 413);
    assert.equal(r.json.error.code, 'too_large');
    // chunked body without Content-Length is cut once it passes the limit
    async function* chunks() { for (let i = 0; i < 12; i++) yield Buffer.alloc(10 * 1024, 1); }
    const res = await fetch(`${app.url}/api/uploads?board=${board.slug}&name=c.bin`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', cookie: owner.cookie },
      body: chunks(),
      duplex: 'half',
    }).catch((e) => ({ error: e }));
    if (res.error) assert.ok(/terminated|fetch failed|other side closed|ECONNRESET/i.test(String(res.error.cause || res.error)), 'connection was cut');
    else {
      assert.equal(res.status, 413);
      assert.equal((await res.json()).error.code, 'too_large');
    }
    // exactly at the limit is fine
    const ok = await put(owner, 'limit.bin', Buffer.alloc(52428, 1), 'application/octet-stream');
    assert.equal(ok.status, 201);
    assert.equal((await put(owner, 'limit.bin', Buffer.alloc(52429, 1), 'application/octet-stream')).status, 413);
    // the server is still healthy afterwards
    assert.equal((await owner.get('/api/health')).status, 200);
    const leftovers = app.db.get("SELECT COUNT(*) AS n FROM uploads WHERE name IN ('big.bin','c.bin')").n;
    assert.equal(leftovers, 0);
  });

  it('empty bodies and a missing board parameter are 400', async () => {
    assert.equal((await put(owner, 'e.txt', Buffer.alloc(0), 'text/plain')).status, 400);
    assert.equal((await owner.put('/api/uploads?name=x.txt', Buffer.from('x'), { raw: true, headers: { 'content-type': 'text/plain' } })).status, 400);
  });

  it('needs write: anonymous 401, read/comment members 403, unknown or private boards 404', async () => {
    assert.equal((await put(new Client(app), 'a.txt', Buffer.from('x'), 'text/plain')).status, 401);
    const commenter = makeUser(app, 'cmt');
    assert.equal((await put(commenter, 'a.txt', Buffer.from('x'), 'text/plain')).status, 403);
    await addMember(owner, board, commenter, 'write');
    assert.equal((await put(commenter, 'a.txt', Buffer.from('x'), 'text/plain')).status, 201);
    assert.equal((await put(owner, 'a.txt', Buffer.from('x'), 'text/plain', 'nosuchboard')).status, 404);
    const priv = await makeBoard(owner, { title: 'p', visibility: 'private' });
    assert.equal((await put(makeUser(app, 'x'), 'a.txt', Buffer.from('x'), 'text/plain', priv.slug)).status, 404);
  });

  it('CSRF: cross-origin uploads are refused', async () => {
    const r = await owner.put(`/api/uploads?board=${board.slug}&name=a.txt`, Buffer.from('x'), { raw: true, headers: { 'content-type': 'text/plain', origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'bad_origin');
  });

  it('unknown ids and malformed paths are 404', async () => {
    for (const p of [`/uploads/${'0'.repeat(32)}/x.png`, '/uploads/short/x.png', '/uploads/../package.json', `/uploads/${'g'.repeat(32)}/x`, '/uploads/', '/uploads']) {
      const r = await fetch(app.url + p);
      assert.ok(r.status === 404 || r.status === 200 /* SPA fallback for "/uploads" */, `${p} -> ${r.status}`);
      if (p.startsWith('/uploads/')) assert.equal(r.status, 404, p);
      await r.arrayBuffer();
    }
    assert.equal((await fetch(`${app.url}/uploads/${'0'.repeat(32)}/x`, { method: 'POST', body: 'x' })).status, 405);
  });
});

describe('upload: Range requests', () => {
  let up;
  const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  before(async () => { up = (await put(owner, 'range.txt', data, 'text/plain')).json; });
  const get = (range, extra = {}) => fetch(app.url + up.url, { headers: { range, ...extra } });

  it('bytes=a-b -> 206 with Content-Range', async () => {
    const r = await get('bytes=0-3');
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 0-3/${data.length}`);
    assert.equal(r.headers.get('content-length'), '4');
    assert.equal(await r.text(), '0123');
  });

  it('open-ended, suffix and clamped ranges', async () => {
    let r = await get('bytes=30-');
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 30-35/36`);
    assert.equal(await r.text(), 'uvwxyz');
    r = await get('bytes=-5');
    assert.equal(r.status, 206);
    assert.equal(await r.text(), 'vwxyz');
    r = await get('bytes=10-9999');
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 10-35/36');
    assert.equal((await r.text()).length, 26);
    r = await get('bytes=-9999');
    assert.equal(r.status, 206);
    assert.equal(await r.text(), data.toString());
  });

  it('unsatisfiable or malformed -> 416 with bytes */size', async () => {
    for (const range of ['bytes=100-200', 'bytes=36-', 'bytes=5-2', 'bytes=-', 'bytes=abc']) {
      const r = await get(range);
      assert.equal(r.status, 416, range);
      assert.equal(r.headers.get('content-range'), `bytes */${data.length}`);
      await r.arrayBuffer();
    }
  });

  it('multi-range is ignored (full body), no Range -> 200, HEAD works, If-None-Match -> 304', async () => {
    let r = await get('bytes=0-1,5-6');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), data.toString());
    r = await fetch(app.url + up.url);
    assert.equal(r.status, 200);
    const etag = r.headers.get('etag');
    await r.arrayBuffer();
    r = await fetch(app.url + up.url, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), String(data.length));
    assert.equal((await fetch(app.url + up.url, { headers: { 'if-none-match': etag } })).status, 304);
  });

  it('video-style seeking on a binary file works byte-exactly', async () => {
    const bin = Buffer.alloc(40000);
    for (let i = 0; i < bin.length; i++) bin[i] = i % 251;
    const v = (await put(owner, 'clip.mp4', bin, 'video/mp4')).json;
    const r = await fetch(app.url + v.url, { headers: { range: 'bytes=20000-20999' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bin.subarray(20000, 21000));
  });
});
