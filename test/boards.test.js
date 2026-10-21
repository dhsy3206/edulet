import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, PNG, addMember, makeBoard, makePost, makeUser, parseCsv, startApp } from './helpers.js';

describe('boards', () => {
  let app;
  let owner;
  before(async () => { app = await startApp(); owner = makeUser(app, 'owner'); });
  after(async () => { await app.close(); });

  it('create: defaults, owner JSON, settings defaults', async () => {
    const r = await owner.post('/api/boards', { title: '  첫 보드  ', description: '설명입니다' });
    assert.equal(r.status, 201);
    const b = r.json.board;
    assert.match(b.slug, /^[a-z0-9]{10}$/);
    assert.equal(b.title, '첫 보드');
    assert.equal(b.description, '설명입니다');
    assert.equal(b.format, 'wall');
    assert.equal(b.wallpaper, 'green');
    assert.equal(b.font, 'sans');
    assert.equal(b.colorScheme, 'light');
    assert.equal(b.visibility, 'link');
    assert.equal(b.linkAccess, 'comment');
    assert.deepEqual(b.settings, { reactions: 'like', comments: 'on', approval: false, showAuthor: true, newPostPosition: 'top' });
    assert.equal(b.owner.id, owner.id);
    assert.equal(typeof b.createdAt, 'number');
    const snap = (await owner.get(`/api/boards/${b.slug}`)).json;
    assert.deepEqual(snap.sections, []);
  });

  it('create: validation', async () => {
    assert.equal((await owner.post('/api/boards', {})).status, 400);
    assert.equal((await owner.post('/api/boards', { title: '' })).status, 400);
    assert.equal((await owner.post('/api/boards', { title: 'x'.repeat(121) })).status, 400);
    assert.equal((await owner.post('/api/boards', { title: 'ok', description: 'x'.repeat(1001) })).status, 400);
    assert.equal((await owner.post('/api/boards', { title: 'ok', format: 'carousel' })).status, 400);
    assert.equal((await owner.post('/api/boards', { title: 'ok', template: 'nope' })).status, 400);
    assert.equal((await new Client(app).post('/api/boards', { title: 'anon' })).status, 401);
    assert.equal((await owner.post('/api/boards', { title: 'x'.repeat(120) })).status, 201);
  });

  const secTitles = async (slug) => (await owner.get(`/api/boards/${slug}`)).json.sections.map((s) => s.title);

  it('templates: blank / kwl / retro / training (+ explicit format wins)', async () => {
    const blank = await makeBoard(owner, { template: 'blank' });
    assert.equal(blank.format, 'wall');
    assert.deepEqual(await secTitles(blank.slug), []);
    const kwl = await makeBoard(owner, { template: 'kwl' });
    assert.equal(kwl.format, 'shelf');
    assert.deepEqual(await secTitles(kwl.slug), ['알고 있는 것', '알고 싶은 것', '배운 것']);
    const retro = await makeBoard(owner, { template: 'retro' });
    assert.equal(retro.format, 'shelf');
    assert.deepEqual(await secTitles(retro.slug), ['잘한 점', '아쉬운 점', '시도할 점']);
    const training = await makeBoard(owner, { template: 'training' });
    assert.equal(training.format, 'rows');
    assert.deepEqual(await secTitles(training.slug), ['1부', '2부']);
    const override = await makeBoard(owner, { template: 'kwl', format: 'grid' });
    assert.equal(override.format, 'grid');
    const shelfNoTemplate = await makeBoard(owner, { format: 'rows' });
    assert.deepEqual(await secTitles(shelfNoTemplate.slug), ['섹션 1'], 'a sectioned format never starts without a section');
    const ranks = (await owner.get(`/api/boards/${kwl.slug}`)).json.sections.map((s) => s.rank);
    assert.deepEqual(ranks, [1, 2, 3]);
  });

  it('list: mine (owned + member), role, counts, updatedAt DESC, login required', async () => {
    const a = makeUser(app, 'lister');
    const other = makeUser(app, 'otherlister');
    const b1 = await makeBoard(a, { title: '하나' });
    const b2 = await makeBoard(a, { title: '둘' });
    const foreign = await makeBoard(other, { title: '남의 것' });
    await addMember(other, foreign, a, 'write');
    await makePost(a, b1);
    await makePost(a, b1);
    app.db.run('UPDATE boards SET updated_at = updated_at - 100000 WHERE id = ?', b2.id);
    const list = (await a.get('/api/boards')).json.boards;
    assert.deepEqual(list.map((b) => b.title).sort(), ['남의 것', '둘', '하나']);
    const byTitle = Object.fromEntries(list.map((b) => [b.title, b]));
    assert.equal(byTitle['하나'].role, 'admin');
    assert.equal(byTitle['하나'].postCount, 2);
    assert.equal(byTitle['하나'].memberCount, 1);
    assert.equal(byTitle['남의 것'].role, 'write');
    assert.equal(byTitle['남의 것'].memberCount, 2);
    assert.ok(list.findIndex((b) => b.title === '하나') < list.findIndex((b) => b.title === '둘'));
    assert.equal((await makeUser(app, 'emptylist').get('/api/boards')).json.boards.length, 0);
  });

  it('snapshot shape; members only for admins; anonymous reads a link board', async () => {
    const b = await makeBoard(owner, { title: '스냅샷' });
    const viewer = makeUser(app, 'viewer');
    const snap = (await viewer.get(`/api/boards/${b.slug}`)).json;
    assert.deepEqual(Object.keys(snap).sort(), ['board', 'isOwner', 'posts', 'presence', 'role', 'sections']);
    assert.equal(snap.role, 'comment');
    assert.equal(snap.isOwner, false);
    const own = (await owner.get(`/api/boards/${b.slug}`)).json;
    assert.equal(own.role, 'admin');
    assert.equal(own.isOwner, true);
    assert.equal(own.members.length, 1);
    assert.equal(own.members[0].isOwner, true);
    const anon = await new Client(app).get(`/api/boards/${b.slug}`);
    assert.equal(anon.status, 200);
    assert.equal(anon.json.role, 'comment');
    assert.equal(anon.json.members, undefined);
    assert.equal((await new Client(app).get('/api/boards/nonexistent')).status, 404);
  });

  it('PATCH: fields, settings merge, validation, admin only', async () => {
    const b = await makeBoard(owner, { title: '설정' });
    const r = await owner.patch(`/api/boards/${b.slug}`, {
      title: '새 제목', description: '새 설명', wallpaper: 'night', font: 'serif', colorScheme: 'dark', format: 'grid',
      settings: { reactions: 'vote', approval: true, bogus: 1 },
    });
    assert.equal(r.status, 200);
    const nb = r.json.board;
    assert.equal(nb.title, '새 제목');
    assert.equal(nb.wallpaper, 'night');
    assert.equal(nb.font, 'serif');
    assert.equal(nb.colorScheme, 'dark');
    assert.equal(nb.format, 'grid');
    assert.deepEqual(nb.settings, { reactions: 'vote', comments: 'on', approval: true, showAuthor: true, newPostPosition: 'top' });
    const r2 = await owner.patch(`/api/boards/${b.slug}`, { settings: { comments: 'off' } });
    assert.deepEqual(r2.json.board.settings, { reactions: 'vote', comments: 'off', approval: true, showAuthor: true, newPostPosition: 'top' }, 'settings merge');
    assert.ok(r2.json.board.updatedAt >= nb.updatedAt);
    for (const bad of [
      { format: 'x' }, { wallpaper: 'rainbow' }, { wallpaper: '/uploads/short/x.png' }, { font: 'comic' }, { colorScheme: 'sepia' }, { visibility: 'public' },
      { linkAccess: 'admin' }, { title: '' }, { settings: { reactions: 'love' } }, { settings: { approval: 'yes' } }, { settings: 'x' },
    ]) assert.equal((await owner.patch(`/api/boards/${b.slug}`, bad)).status, 400, JSON.stringify(bad));
    const wp = '/uploads/0123456789abcdef0123456789abcdef/bg.png';
    assert.equal((await owner.patch(`/api/boards/${b.slug}`, { wallpaper: wp })).json.board.wallpaper, wp);
    const writer = makeUser(app, 'writer');
    await addMember(owner, b, writer, 'moderate');
    assert.equal((await writer.patch(`/api/boards/${b.slug}`, { title: 'x' })).status, 403);
    assert.equal((await new Client(app).patch(`/api/boards/${b.slug}`, { title: 'x' })).status, 401);
  });

  it('PATCH format -> shelf/rows: 0 sections creates "섹션 1" and rehomes loose posts', async () => {
    const b = await makeBoard(owner, { title: '전환' });
    const p1 = await makePost(owner, b, { title: 'a' });
    const p2 = await makePost(owner, b, { title: 'b' });
    assert.equal(p1.sectionId, null);
    const r = await owner.patch(`/api/boards/${b.slug}`, { format: 'shelf' });
    assert.equal(r.status, 200);
    const snap = (await owner.get(`/api/boards/${b.slug}`)).json;
    assert.deepEqual(snap.sections.map((s) => s.title), ['섹션 1']);
    assert.deepEqual(snap.posts.map((p) => p.sectionId), [snap.sections[0].id, snap.sections[0].id]);
    assert.deepEqual(snap.posts.map((p) => p.id).sort(), [p1.id, p2.id].sort());
    // switching back to wall keeps everything; switching to rows again does not add sections
    await owner.patch(`/api/boards/${b.slug}`, { format: 'wall' });
    await owner.patch(`/api/boards/${b.slug}`, { format: 'rows' });
    assert.equal((await owner.get(`/api/boards/${b.slug}`)).json.sections.length, 1);
  });

  it('DELETE: owner only, removes data and upload files', async () => {
    const o = makeUser(app, 'deleter');
    const admin = makeUser(app, 'adminmember');
    const b = await makeBoard(o, { title: '삭제' });
    await addMember(o, b, admin, 'admin');
    const up = await o.put(`/api/uploads?board=${b.slug}&name=a.png`, PNG, { raw: true, headers: { 'content-type': 'image/png' } });
    assert.equal(up.status, 201);
    const file = path.join(app.dir, 'uploads', up.json.id);
    assert.ok(fs.existsSync(file));
    await makePost(o, b, { attachment: { kind: 'image', uploadId: up.json.id } });
    assert.equal((await admin.del(`/api/boards/${b.slug}`)).status, 403, 'admin member is not the owner');
    assert.equal((await new Client(app).del(`/api/boards/${b.slug}`)).status, 401);
    const r = await o.del(`/api/boards/${b.slug}`);
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await o.get(`/api/boards/${b.slug}`)).status, 404);
    assert.equal(fs.existsSync(file), false);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM posts WHERE board_id = ?', b.id).n, 0);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM uploads WHERE board_id = ?', b.id).n, 0);
    assert.equal((await (await fetch(`${app.url}${up.json.url}`)).status), 404);
  });

  it('duplicate: without posts / with posts; keeps authors, drops comments+reactions, shares upload files', async () => {
    const o = makeUser(app, 'dupowner');
    const w = makeUser(app, 'dupwriter');
    const b = await makeBoard(o, { title: '원본', template: 'kwl', linkAccess: 'write' });
    const secs = (await o.get(`/api/boards/${b.slug}`)).json.sections;
    const up = await o.put(`/api/uploads?board=${b.slug}&name=pic.png`, PNG, { raw: true, headers: { 'content-type': 'image/png' } });
    const p1 = await makePost(o, b, { title: '사진', sectionId: secs[1].id, attachment: { kind: 'image', uploadId: up.json.id } });
    const p2 = await makePost(w, b, { title: '남의 글', sectionId: secs[0].id });
    await w.post(`/api/posts/${p2.id}/comments`, { body: '댓글' });
    await w.put(`/api/posts/${p2.id}/reactions`, { kind: 'like' });
    const copier = makeUser(app, 'copier');

    const lite = await copier.post(`/api/boards/${b.slug}/duplicate`, {});
    assert.equal(lite.status, 201);
    assert.equal(lite.json.board.title, '원본 사본');
    assert.equal(lite.json.board.owner.id, copier.id);
    assert.notEqual(lite.json.board.slug, b.slug);
    const liteSnap = (await copier.get(`/api/boards/${lite.json.board.slug}`)).json;
    assert.deepEqual(liteSnap.sections.map((s) => s.title), ['알고 있는 것', '알고 싶은 것', '배운 것']);
    assert.equal(liteSnap.posts.length, 0);

    const full = await copier.post(`/api/boards/${b.slug}/duplicate`, { withPosts: true });
    const fullSnap = (await copier.get(`/api/boards/${full.json.board.slug}`)).json;
    assert.equal(fullSnap.posts.length, 2);
    const copy1 = fullSnap.posts.find((p) => p.title === '사진');
    const copy2 = fullSnap.posts.find((p) => p.title === '남의 글');
    assert.equal(copy2.author.id, w.id, 'author preserved');
    assert.equal(copy1.author.id, o.id);
    assert.equal(copy2.commentCount, 0);
    assert.equal(copy2.reactions.like.count, 0);
    assert.equal(copy1.attachment.url, p1.attachment.url, 'upload attachment shares the same file URL');
    assert.equal(fullSnap.sections.find((s) => s.id === copy1.sectionId).title, '알고 싶은 것');
    assert.notEqual(copy1.id, p1.id);
    // original untouched
    assert.equal((await o.get(`/api/boards/${b.slug}`)).json.posts.length, 2);
    // deleting the original keeps the copy's shared image alive
    await o.del(`/api/boards/${b.slug}`);
    assert.equal((await fetch(app.url + copy1.attachment.url)).status, 200);
    // anonymous / guest cannot duplicate
    assert.equal((await new Client(app).post(`/api/boards/${full.json.board.slug}/duplicate`, {})).status, 401);
    const g = makeUser(app, 'guesty', { guest: true });
    assert.equal((await g.post(`/api/boards/${full.json.board.slug}/duplicate`, {})).status, 403);
  });

  it('duplicate: long titles stay within 120 characters; pending posts are not copied', async () => {
    const o = makeUser(app, 'duplong');
    const w = makeUser(app, 'duplongw');
    const b = await makeBoard(o, { title: '가'.repeat(120), linkAccess: 'write' });
    await o.patch(`/api/boards/${b.slug}`, { settings: { approval: true } });
    await makePost(o, b, { title: '공개' });
    const pending = await makePost(w, b, { title: '대기' });
    assert.equal(pending.status, 'pending');
    const d = await o.post(`/api/boards/${b.slug}/duplicate`, { withPosts: true });
    assert.equal(Array.from(d.json.board.title).length, 120);
    assert.ok(d.json.board.title.endsWith(' 사본'));
    const snap = (await o.get(`/api/boards/${d.json.board.slug}`)).json;
    assert.deepEqual(snap.posts.map((p) => p.title), ['공개']);
  });

  it('members: add / list / change role / remove, owner first, validation', async () => {
    const o = makeUser(app, 'mowner');
    const u1 = makeUser(app, 'member1');
    const u2 = makeUser(app, 'member2');
    const b = await makeBoard(o, { title: '구성원', visibility: 'private' });
    assert.equal((await u1.get(`/api/boards/${b.slug}`)).status, 404);
    const add = await o.post(`/api/boards/${b.slug}/members`, { username: u1.username.toUpperCase(), role: 'write' });
    assert.equal(add.status, 201);
    assert.equal(add.json.member.role, 'write');
    assert.equal(add.json.member.user.id, u1.id);
    assert.equal((await u1.get(`/api/boards/${b.slug}`)).json.role, 'write');
    assert.equal((await o.post(`/api/boards/${b.slug}/members`, { username: u1.username, role: 'read' })).json.error.code, 'already_member');
    assert.equal((await o.post(`/api/boards/${b.slug}/members`, { username: o.username, role: 'read' })).json.error.code, 'already_owner');
    assert.equal((await o.post(`/api/boards/${b.slug}/members`, { username: 'no_such_user', role: 'read' })).json.error.code, 'user_not_found');
    assert.equal((await o.post(`/api/boards/${b.slug}/members`, { username: u2.username, role: 'owner' })).status, 400);
    await o.post(`/api/boards/${b.slug}/members`, { username: u2.username, role: 'read' });
    const list = (await o.get(`/api/boards/${b.slug}/members`)).json.members;
    assert.equal(list.length, 3);
    assert.deepEqual([list[0].isOwner, list[0].role, list[0].user.id], [true, 'admin', o.id]);
    assert.deepEqual(list.slice(1).map((m) => m.user.id).sort(), [u1.id, u2.id].sort());
    assert.equal((await u1.get(`/api/boards/${b.slug}/members`)).status, 403);
    const patch = await o.patch(`/api/boards/${b.slug}/members/${u1.id}`, { role: 'moderate' });
    assert.equal(patch.json.member.role, 'moderate');
    assert.equal((await u1.get(`/api/boards/${b.slug}`)).json.role, 'moderate');
    assert.equal((await o.patch(`/api/boards/${b.slug}/members/${u1.id}`, { role: 'god' })).status, 400);
    assert.equal((await o.patch(`/api/boards/${b.slug}/members/999999`, { role: 'read' })).status, 404);
    const snapMembers = (await o.get(`/api/boards/${b.slug}`)).json.members;
    assert.equal(snapMembers.length, 3);
    assert.deepEqual((await o.del(`/api/boards/${b.slug}/members/${u1.id}`)).json, { ok: true });
    assert.equal((await u1.get(`/api/boards/${b.slug}`)).status, 404, 'removed member loses a private board');
    assert.equal((await o.del(`/api/boards/${b.slug}/members/${u1.id}`)).status, 404);
  });

  it('export JSON: board, sections, posts with comments; read access suffices; attachment header', async () => {
    const o = makeUser(app, 'exporter');
    const b = await makeBoard(o, { title: '내보내기', template: 'retro' });
    const secs = (await o.get(`/api/boards/${b.slug}`)).json.sections;
    const p = await makePost(o, b, { title: '첫째', sectionId: secs[1].id });
    await o.patch(`/api/boards/${b.slug}`, { settings: { comments: 'on' } });
    await o.post(`/api/posts/${p.id}/comments`, { body: '좋아요' });
    const r = await o.get(`/api/boards/${b.slug}/export?format=json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="edulet-.*\.json"/);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.json.board.slug, b.slug);
    assert.equal(r.json.sections.length, 3);
    assert.equal(r.json.posts.length, 1);
    assert.equal(r.json.posts[0].comments[0].body, '좋아요');
    assert.equal((await new Client(app).get(`/api/boards/${b.slug}/export?format=json`)).status, 200);
    assert.equal((await o.get(`/api/boards/${b.slug}/export?format=xml`)).status, 400);
    const priv = await makeBoard(o, { title: '비공개', visibility: 'private' });
    assert.equal((await new Client(app).get(`/api/boards/${priv.slug}/export?format=csv`)).status, 404);
  });

  it('export CSV: BOM, columns, quoting and formula-injection guard', async () => {
    const o = makeUser(app, 'csvowner');
    const b = await makeBoard(o, { title: 'CSV', template: 'kwl' });
    const secs = (await o.get(`/api/boards/${b.slug}`)).json.sections;
    await makePost(o, b, { title: '=HYPERLINK("http://evil","x")', body: '+1+1', sectionId: secs[0].id });
    await makePost(o, b, { title: '-2+3', body: '@SUM(A1)', sectionId: secs[0].id });
    await makePost(o, b, { title: '쉼표, 그리고 "따옴표"', body: '첫 줄\n둘째 줄', sectionId: secs[1].id, attachment: { kind: 'link', url: 'https://example.com/page' } });
    const r = await o.get(`/api/boards/${b.slug}/export?format=csv`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="edulet-.*\.csv"/);
    assert.deepEqual([...r.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
    const text = r.text.replace(/^\uFEFF/, '');
    assert.ok(text.startsWith('섹션,작성자,제목,본문,첨부,링크,좋아요,댓글수,작성시각\r\n'));
    assert.ok(text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), 'leading = neutralised with \' and quoted');
    assert.ok(text.includes(",'+1+1,"));
    assert.ok(text.includes(",'-2+3,"));
    assert.ok(text.includes(",'@SUM(A1),"));
    assert.ok(text.includes('"쉼표, 그리고 ""따옴표"""'));
    assert.ok(text.includes('"첫 줄\n둘째 줄"'));
    assert.ok(text.includes('https://example.com/page'));
    const table = parseCsv(text);
    assert.equal(table.length, 4);
    for (const row of table) {
      assert.equal(row.length, 9);
      for (const cell of row) assert.doesNotMatch(cell, /^[=+\-@]/, `formula starter in ${cell}`);
    }
    assert.deepEqual(table.slice(1).map((r) => r[2]).sort(), [`'-2+3`, `'=HYPERLINK("http://evil","x")`, '쉼표, 그리고 "따옴표"'].sort());
  });
});

describe('static files', () => {
  let app;
  let pub;
  before(async () => {
    pub = fs.mkdtempSync(path.join(os.tmpdir(), 'edulet-pub-'));
    fs.mkdirSync(path.join(pub, 'js'));
    fs.mkdirSync(path.join(pub, 'assets'));
    fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>Edulet</title>');
    fs.writeFileSync(path.join(pub, 'js', 'main.mjs'), 'export const x = 1;');
    fs.writeFileSync(path.join(pub, 'js', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(pub, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(pub, 'assets', 'f.woff2'), 'x');
    fs.writeFileSync(path.join(pub, 'assets', 'p.webp'), 'x');
    fs.writeFileSync(path.join(pub, '.secret'), 'nope');
    fs.writeFileSync(path.join(os.tmpdir(), 'edulet-outside-secret.txt'), 'outside');
    app = await startApp({ publicDir: pub });
  });
  after(async () => {
    await app.close();
    fs.rmSync(pub, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'edulet-outside-secret.txt'), { force: true });
  });

  const raw = (p, headers = {}) => fetch(app.url + p, { headers });

  it('serves files with content types and security headers', async () => {
    const cases = {
      '/index.html': 'text/html', '/js/main.mjs': 'text/javascript', '/js/app.js': 'text/javascript',
      '/assets/logo.svg': 'image/svg+xml', '/assets/f.woff2': 'font/woff2', '/assets/p.webp': 'image/webp',
    };
    for (const [p, type] of Object.entries(cases)) {
      const r = await raw(p);
      assert.equal(r.status, 200, p);
      assert.ok(r.headers.get('content-type').startsWith(type), `${p}: ${r.headers.get('content-type')}`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));
      assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      await r.arrayBuffer();
    }
    assert.equal(await (await raw('/js/app.js')).text(), 'console.log(1)');
  });

  it('SPA fallback for extensionless non-API paths, 404 for missing files and unknown /api', async () => {
    for (const p of ['/', '/b/some-board', '/b/some-board/p/12', '/dashboard']) {
      const r = await raw(p);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /<title>Edulet<\/title>/);
    }
    assert.equal((await raw('/js/missing.js')).status, 404);
    assert.equal((await raw('/nothing.png')).status, 404);
    const api = await raw('/api/zzz');
    assert.equal(api.status, 404);
    assert.match(api.headers.get('content-type'), /json/);
    assert.equal((await raw('/uploads/' + '0'.repeat(32) + '/x.png')).status, 404);
  });

  it('path traversal and dotfiles are refused', async () => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/js/..%5c..%5cindex.html', '/.secret',
      '/%2e%2e%2f%2e%2e%2fedulet-outside-secret.txt', '/js/../../edulet-outside-secret.txt', '/..%252f..%252fpackage.json', '/C:/Windows/win.ini', '/assets/logo.svg::$DATA']) {
      const r = await raw(p);
      assert.ok([400, 404].includes(r.status) || (r.status === 200 && (await r.clone().text()).includes('<title>Edulet</title>')), `${p} -> ${r.status}`);
      const body = await r.text();
      assert.ok(!body.includes('outside') && !body.includes('"name": "edulet"') && !body.includes('nope'), `${p} leaked`);
    }
    // raw (non-normalised) request line
    const net = await import('node:net');
    const status = await new Promise((resolve, reject) => {
      const s = net.connect(new URL(app.url).port, '127.0.0.1', () => s.write('GET /../../package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = '';
      s.on('data', (d) => { data += d; });
      s.on('end', () => resolve(data));
      s.on('error', reject);
    });
    assert.ok(!status.includes('"name": "edulet"'));
  });

  it('ETag / Last-Modified revalidation -> 304; HEAD has no body; non-GET is 405', async () => {
    const first = await raw('/js/app.js');
    const etag = first.headers.get('etag');
    const lm = first.headers.get('last-modified');
    assert.ok(etag && lm);
    await first.arrayBuffer();
    const r304 = await raw('/js/app.js', { 'If-None-Match': etag });
    assert.equal(r304.status, 304);
    assert.equal((await r304.arrayBuffer()).byteLength, 0);
    assert.equal((await raw('/js/app.js', { 'If-Modified-Since': lm })).status, 304);
    assert.equal((await raw('/js/app.js', { 'If-None-Match': '"other"' })).status, 200);
    const head = await fetch(app.url + '/js/app.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String('console.log(1)'.length));
    assert.equal((await fetch(app.url + '/js/app.js', { method: 'POST', body: 'x' })).status, 405);
  });
});
