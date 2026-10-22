import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, PNG, makeUser, startApp } from './helpers.js';
import { FX, makeSeedFixture } from './seed-fixture.js';
import { applySeed, loadSeedSpecs, resetDemo, runSeed } from '../server/seed.js';
import { createApp } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// These tests never look at the repository's seed/ folder as a whole (it may carry extra local boards on a developer PC).
// They seed a temporary folder = a copy of the real seed/practice.json + the own fixture board in test/seed-fixture.js.
// Only the seed-cli test at the end runs against the repository's seed/ (the CLI has that folder built in) and says only
// what holds for practice.json.

describe('seeding a seed folder (copy of seed/practice.json + own fixture board)', () => {
  let app;
  let anon;
  let fx;
  before(async () => {
    fx = makeSeedFixture();
    app = await startApp({ seed: 'auto', seedDir: fx.dir }); // empty DB -> seeds the temp folder
    anon = new Client(app);
  });
  after(async () => { await app.close(); fx.cleanup(); });

  it('creates both boards on first start (and only those: the temp folder is what was seeded)', () => {
    assert.equal(app.app.seedDir, fx.dir);
    assert.deepEqual(app.seeded.map((s) => [s.slug, s.created]).sort(), [[FX.slug, true], ['practice', true]]);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM boards').n, 2);
  });

  it('fixture board: rows format, comment link access, 3 sections, 17 posts, 2 comments on the 4th card', async () => {
    const r = await anon.get(`/api/boards/${FX.slug}`);
    assert.equal(r.status, 200, 'readable without logging in');
    const { board, sections, posts, role, isOwner } = r.json;
    assert.equal(board.format, 'rows');
    assert.equal(board.linkAccess, 'comment');
    assert.equal(board.visibility, 'link');
    assert.equal(board.wallpaper, 'green');
    assert.equal(board.title, FX.title);
    assert.equal(board.owner.displayName, FX.ownerName);
    assert.equal(board.settings.newPostPosition, 'bottom');
    assert.equal(role, 'comment');
    assert.equal(isOwner, false);
    assert.equal(sections.length, 3);
    assert.deepEqual(sections.map((s) => s.rank), [1, 2, 3]);
    assert.deepEqual(sections.map((s) => s.title), FX.sectionTitles);
    assert.equal(posts.length, 17);
    const commented = posts.filter((p) => p.title === FX.cards.commented);
    assert.equal(commented.length, 1);
    assert.equal(commented[0].commentCount, 2);
    assert.equal(posts.reduce((n, p) => n + p.commentCount, 0), 2, 'no other post has comments');
    const comments = (await anon.get(`/api/posts/${commented[0].id}/comments`)).json.comments;
    assert.equal(comments.length, 2);
    assert.equal(comments[0].body, FX.commentBodies[0]);
    assert.equal(comments[1].body, FX.commentBodies[1]);
    assert.equal(comments[0].author.id, board.owner.id, 'no author given -> the owner');
    // sections hold 7 / 8 / 2 posts, in listing order (newPostPosition=bottom -> rank grows)
    const per = sections.map((s) => posts.filter((p) => p.sectionId === s.id).sort((a, b) => a.rank - b.rank).map((p) => p.title));
    assert.deepEqual(per.map((l) => l.length), [7, 8, 2]);
    assert.deepEqual(per.flat(), FX.cards.all, 'display order = listing order');
    assert.equal(per[0][0], FX.cards.first);
    assert.equal(per[0][3], FX.cards.commented);
    assert.equal(per[2][1], FX.cards.last, 'a title with "&" arrives as written');
    assert.ok(posts.every((p) => p.status === 'published' && p.author.id === board.owner.id));
  });

  it('practice: wall format, write link access, 3 posts in file order', async () => {
    const r = await anon.get('/api/boards/practice');
    assert.equal(r.status, 200);
    const { board, posts, sections } = r.json;
    assert.equal(board.format, 'wall');
    assert.equal(board.linkAccess, 'write');
    assert.equal(board.wallpaper, 'sunrise');
    assert.equal(board.owner.displayName, 'Edulet 도우미');
    assert.equal(r.json.role, 'write');
    assert.equal(sections.length, 0);
    assert.equal(posts.length, 3);
    assert.deepEqual(posts.map((p) => p.color).sort(), ['blue', 'yellow', null].sort());
    const link = posts.find((p) => p.attachment?.kind === 'link');
    assert.equal(link.attachment.url, 'https://developer.mozilla.org/ko/');
    assert.deepEqual(link.attachment.preview, { title: 'MDN Web Docs', description: '웹 개발자를 위한 자료', site: 'developer.mozilla.org' });
    // the seed file's list order is the display order (rank ascending), also on `top` boards
    assert.deepEqual([...posts].sort((a, b) => a.rank - b.rank).map((p) => p.title), ['여기에 첫 글을 남겨 보세요', '형식을 바꿔 보세요', '링크도 붙일 수 있어요']);
  });

  it('owners are non-loginable accounts (no username, no password) and cannot be reached via login', async () => {
    const owners = app.db.all('SELECT u.* FROM users u JOIN boards b ON b.owner_id = u.id');
    assert.equal(owners.length, 2);
    for (const u of owners) {
      assert.equal(u.username, null);
      assert.equal(u.password_hash, null);
      assert.equal(u.is_guest, 0);
    }
    assert.equal((await new Client(app).post('/api/auth/login', { username: '', password: 'x'.repeat(8) })).status, 401);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM sessions').n, 0, 'seeding creates no sessions');
    // a visitor with a session cannot administrate the demo board
    const u = makeUser(app, 'visitor');
    assert.equal((await u.patch(`/api/boards/${FX.slug}`, { title: 'hacked' })).status, 403);
    assert.equal((await u.del(`/api/boards/${FX.slug}`)).status, 403);
  });

  it('ageDays: board created ~31 days ago, posts +60s apart in list order, comments +1h', async () => {
    const { board, posts } = (await anon.get(`/api/boards/${FX.slug}`)).json;
    const age = (Date.now() - board.createdAt) / 86400000;
    assert.ok(age > 30.9 && age < 31.1, `age ${age}`);
    const byRank = [...posts].sort((a, b) => a.createdAt - b.createdAt);
    assert.equal(byRank[0].createdAt, board.createdAt);
    assert.equal(byRank[1].createdAt - byRank[0].createdAt, 60000);
    assert.equal(byRank[16].createdAt - byRank[0].createdAt, 16 * 60000);
    const commented = posts.find((p) => p.title === FX.cards.commented);
    const cs = (await anon.get(`/api/posts/${commented.id}/comments`)).json.comments;
    assert.ok(cs.every((c) => c.createdAt === commented.createdAt + 3600000));
    const practice = (await anon.get('/api/boards/practice')).json.board;
    assert.ok(Math.abs((Date.now() - practice.createdAt) / 86400000 - 1) < 0.1);
  });

  it('seed images are copied into uploads and served (image / file / link-preview thumbnails)', async () => {
    const onDisk = (rel) => fs.readFileSync(path.join(fx.dir, rel));
    const { posts } = (await anon.get(`/api/boards/${FX.slug}`)).json;
    const image = posts.find((p) => p.title === FX.cards.first);
    assert.equal(image.attachment.kind, 'image');
    assert.equal(image.attachment.mime, 'image/jpeg');
    assert.equal(image.attachment.name, FX.image.name);
    assert.equal(image.attachment.size, fs.statSync(path.join(fx.dir, FX.image.file)).size);
    assert.match(image.attachment.url, /^\/uploads\/[0-9a-f]{32}\/sample-photo\.jpg$/);
    const got = await fetch(app.url + image.attachment.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), onDisk(FX.image.file));
    // png / webp keep their real types
    const png = posts.find((p) => p.title === FX.cards.last);
    assert.equal(png.attachment.kind, 'image');
    assert.equal(png.attachment.mime, 'image/png');
    assert.equal(png.attachment.name, FX.png.name);
    const pngGot = await fetch(app.url + png.attachment.url);
    assert.equal(pngGot.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await pngGot.arrayBuffer()), onDisk(FX.png.file));
    // file attachment with preview thumbnail; Korean/space file name percent-encoded in the URL
    const file = posts.find((p) => p.title === FX.cards.file);
    assert.equal(file.attachment.kind, 'file');
    assert.equal(file.attachment.name, FX.pdf.name);
    assert.equal(file.attachment.mime, 'application/pdf');
    assert.match(file.attachment.url, /^\/uploads\/[0-9a-f]{32}\/%EC%98%88%EC%8B%9C%20%EC%9E%90%EB%A3%8C%20-%201\.pdf$/);
    assert.equal(file.attachment.url.endsWith(`/${encodeURIComponent(FX.pdf.name)}`), true);
    assert.equal(file.attachment.size, fs.statSync(path.join(fx.dir, FX.pdf.file)).size);
    assert.match(file.attachment.preview.image, /^\/uploads\/[0-9a-f]{32}\/handout-preview\.png$/);
    const pdf = await fetch(app.url + file.attachment.url);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /^attachment/);
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBytes.byteLength, file.attachment.size);
    assert.deepEqual(pdfBytes, onDisk(FX.pdf.file));
    const thumb = await fetch(app.url + file.attachment.preview.image);
    assert.equal(thumb.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), onDisk(FX.pdf.previewFile));
    // link previews are stored verbatim, imageFile -> local upload URL, no network involved
    const link = posts.find((p) => p.title === FX.cards.link);
    assert.equal(link.attachment.kind, 'link');
    assert.equal(link.attachment.url, FX.link.url);
    assert.equal(link.attachment.preview.title, FX.link.title);
    assert.equal(link.attachment.preview.description, FX.link.description);
    assert.equal(link.attachment.preview.site, FX.link.site);
    assert.match(link.attachment.preview.image, /^\/uploads\/[0-9a-f]{32}\/link-thumb\.webp$/);
    assert.equal(link.attachment.preview.imageFile, undefined);
    const lt = await fetch(app.url + link.attachment.preview.image);
    assert.equal(lt.headers.get('content-type'), 'image/webp');
    assert.deepEqual(Buffer.from(await lt.arrayBuffer()), onDisk(FX.link.imageFile));
    // exactly the five files of the fixture board became uploads (nothing else in the temp folder was picked up)
    assert.equal(posts.filter((p) => p.attachment).length, 4);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM uploads').n, 5);
    // every uploaded file referenced by a post exists on disk
    for (const p of posts) {
      for (const url of [p.attachment?.url, p.attachment?.preview?.image]) {
        if (!url?.startsWith('/uploads/')) continue;
        const id = url.split('/')[2];
        assert.ok(fs.existsSync(path.join(app.dir, 'uploads', id)), url);
      }
    }
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM uploads').n, fs.readdirSync(path.join(app.dir, 'uploads')).length);
  });

  it('is idempotent: re-running with mode on creates nothing new', async () => {
    const counts = () => app.db.all('SELECT (SELECT COUNT(*) FROM boards) b, (SELECT COUNT(*) FROM posts) p, (SELECT COUNT(*) FROM comments) c, (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM uploads) f, (SELECT COUNT(*) FROM sections) s')[0];
    const before = { ...counts() };
    const again = runSeed(app.app, { mode: 'on', dir: fx.dir });
    assert.deepEqual(again.map((s) => s.created), [false, false]);
    assert.deepEqual({ ...counts() }, before);
    assert.equal(fs.readdirSync(path.join(app.dir, 'uploads')).length, app.db.get('SELECT COUNT(*) AS n FROM uploads').n, 'no duplicate files either');
  });
});

describe('seed lifecycle (temporary data folders)', () => {
  const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'edulet-seedtest-'));
  const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
  let fx; // temp seed folder: practice.json copy + the fixture board (the repository's seed/ is not used here)
  let seedDir;
  before(() => { fx = makeSeedFixture(); seedDir = fx.dir; });
  after(() => { fx.cleanup(); });

  it('auto seeds only an empty database; off never seeds; on seeds even when boards exist', async () => {
    const data = mkdir();
    try {
      let a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'auto', seedDir, quiet: true });
      assert.equal(a.seeded.length, 2);
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM boards').n, 2);
      const total = a.db.get('SELECT COUNT(*) AS n FROM posts').n;
      assert.equal(total, 20);
      await a.close();
      // restart: nothing changes
      a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'auto', seedDir, quiet: true });
      assert.deepEqual(a.seeded, []);
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM posts').n, total);
      // a user board exists and the demo gets deleted -> auto does NOT bring it back (boards exist)
      a.db.run("DELETE FROM boards WHERE slug = 'practice'");
      await a.close();
      a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'auto', seedDir, quiet: true });
      assert.equal(a.db.get("SELECT COUNT(*) AS n FROM boards WHERE slug = 'practice'").n, 0);
      await a.close();
      // on: restores the missing demo board, leaves the existing one alone
      a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 1, seedDir, quiet: true });
      assert.deepEqual(a.seeded.map((s) => [s.slug, s.created]).sort(), [[FX.slug, false], ['practice', true]]);
      await a.close();
      const off = mkdir();
      try {
        const b = await createApp({ dataDir: off, port: 0, host: '127.0.0.1', seed: 0, seedDir, quiet: true });
        assert.equal(b.db.get('SELECT COUNT(*) AS n FROM boards').n, 0);
        await b.close();
      } finally { rm(off); }
    } finally { rm(data); }
  });

  it('EDULET_SEED env value is honoured (auto | 0 | 1)', async () => {
    const data = mkdir();
    const old = process.env.EDULET_SEED;
    try {
      process.env.EDULET_SEED = '0';
      const a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seedDir, quiet: true });
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM boards').n, 0);
      await a.close();
      process.env.EDULET_SEED = '1';
      const b = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seedDir, quiet: true });
      assert.equal(b.db.get('SELECT COUNT(*) AS n FROM boards').n, 2);
      await b.close();
    } finally {
      if (old === undefined) delete process.env.EDULET_SEED; else process.env.EDULET_SEED = old;
      rm(data);
    }
  });

  it('custom seed folder: reactions, commenters, named authors, sections, pinned, colours, bottom/top ranking', async () => {
    const seedDir = mkdir();
    fs.mkdirSync(path.join(seedDir, 'img'));
    fs.writeFileSync(path.join(seedDir, 'img', 'p.png'), PNG);
    fs.writeFileSync(path.join(seedDir, 'img', 'doc.txt'), 'hello');
    fs.writeFileSync(path.join(seedDir, 'custom.json'), JSON.stringify({
      _comment: 'ignored',
      owner: { displayName: '선생님', avatarColor: '#123456' },
      board: { slug: 'custom-demo', title: '커스텀', description: '설명', format: 'shelf', wallpaper: 'ocean', font: 'serif', colorScheme: 'dark', visibility: 'link', linkAccess: 'read', settings: { reactions: 'emoji', newPostPosition: 'bottom', bogus: true } },
      sections: [{ key: 'a', title: 'A열' }, { key: 'b', title: 'B열' }],
      commenters: ['민수', '지영'],
      posts: [
        { section: 'a', title: 'a1', body: '본문', image: 'img/p.png', color: 'yellow', reactions: { like: 3, emoji: { '👍': 2, '🎉': 1 }, grade: [8, 10] } },
        { section: 'a', title: 'a2', color: 'not-a-color', pinned: true, comments: [{ body: '첫 댓글', author: '민수' }, { body: '둘째', author: '새사람' }, { body: '주인 댓글' }] },
        { section: 'b', title: 'b1', attachment: { kind: 'file', file: 'img/doc.txt', name: '자료 1.txt', mime: 'text/plain' } },
        { title: 'no section -> first', attachment: { kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', preview: { title: 'V', embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' } } },
        { section: 'zzz', title: 'unknown section -> first', attachment: { kind: 'image', url: 'https://example.com/x.jpg' } },
      ],
    }));
    const data = mkdir();
    const a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'on', seedDir, quiet: true });
    try {
      assert.deepEqual(a.seeded, [{ slug: 'custom-demo', created: true }]);
      const anon = new Client(a);
      const { board, sections, posts } = (await anon.get('/api/boards/custom-demo')).json;
      assert.deepEqual([board.format, board.wallpaper, board.font, board.colorScheme, board.linkAccess], ['shelf', 'ocean', 'serif', 'dark', 'read']);
      assert.deepEqual(board.settings, { reactions: 'emoji', comments: 'on', approval: false, showAuthor: true, newPostPosition: 'bottom' });
      assert.equal(board.owner.avatarColor, '#123456');
      assert.deepEqual(sections.map((s) => s.title), ['A열', 'B열']);
      const by = Object.fromEntries(posts.map((p) => [p.title, p]));
      assert.equal(by.a1.sectionId, sections[0].id);
      assert.equal(by.b1.sectionId, sections[1].id);
      assert.equal(by['no section -> first'].sectionId, sections[0].id);
      assert.equal(by['unknown section -> first'].sectionId, sections[0].id);
      assert.deepEqual(['a1', 'a2', 'no section -> first', 'unknown section -> first'].map((t) => by[t].rank), [1, 2, 3, 4], 'bottom: rank grows per section in list order');
      assert.equal(by.b1.rank, 1);
      assert.equal(by.a1.color, 'yellow');
      assert.equal(by.a2.color, null);
      assert.equal(by.a2.pinned, true);
      assert.deepEqual(by.a1.reactions.like, { count: 3, mine: false });
      assert.deepEqual(by.a1.reactions.emoji, { '👍': { count: 2, mine: false }, '🎉': { count: 1, mine: false } });
      assert.deepEqual(by.a1.reactions.grade, { count: 2, avg: 9, mine: 0 });
      assert.equal(by.b1.attachment.name, '자료 1.txt');
      assert.equal(by.b1.attachment.url.endsWith(`/${encodeURIComponent('자료 1.txt')}`), true);
      assert.equal(by['no section -> first'].attachment.kind, 'video');
      assert.equal(by['no section -> first'].attachment.preview.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
      assert.equal(by['unknown section -> first'].attachment.url, 'https://example.com/x.jpg');
      const cm = (await anon.get(`/api/posts/${by.a2.id}/comments`)).json.comments;
      assert.deepEqual(cm.map((c) => c.author.displayName), ['민수', '새사람', '선생님']);
      assert.equal(cm[0].author.isGuest, true, 'commenters are guest-like');
      assert.equal(a.db.all("SELECT * FROM users WHERE display_name IN ('민수','지영','새사람') AND (username IS NOT NULL OR password_hash IS NOT NULL)").length, 0);
      assert.equal(a.db.all("SELECT * FROM users WHERE display_name LIKE '참여자%' AND (username IS NOT NULL OR password_hash IS NOT NULL)").length, 0);
      // the owner is not loginable
      assert.equal(a.db.get("SELECT username, password_hash FROM users WHERE display_name = '선생님'").password_hash, null);
    } finally { await a.close(); rm(data); rm(seedDir); }
  });

  it('invalid seed files fail loudly with the file name', () => {
    const dir = mkdir();
    try {
      fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
      assert.throws(() => loadSeedSpecs(dir), /bad\.json/);
      fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ board: { slug: 'Not Valid', title: 'x' } }));
      assert.throws(() => loadSeedSpecs(dir), /slug/);
      fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ board: { slug: 'ok-slug' } }));
      assert.throws(() => loadSeedSpecs(dir), /title/);
      assert.deepEqual(loadSeedSpecs(path.join(dir, 'missing')), []);
    } finally { rm(dir); }
  });

  it('a failing seed rolls back completely and leaves no orphan upload files', async () => {
    const seedDir = mkdir();
    const data = mkdir();
    fs.mkdirSync(path.join(seedDir, 'img'));
    fs.writeFileSync(path.join(seedDir, 'img', 'ok.png'), PNG);
    fs.writeFileSync(path.join(seedDir, 'broken.json'), JSON.stringify({
      board: { slug: 'broken', title: 'Broken' },
      posts: [{ title: 'fine', image: 'img/ok.png' }, { title: 'missing file', image: 'img/does-not-exist.png' }],
    }));
    const a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'off', quiet: true });
    try {
      const spec = loadSeedSpecs(seedDir)[0].spec;
      assert.throws(() => applySeed(a.app, spec, seedDir), /ENOENT/);
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM boards').n, 0);
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM users').n, 0);
      assert.deepEqual(fs.readdirSync(path.join(data, 'uploads')), []);
    } finally { await a.close(); rm(data); rm(seedDir); }
  });

  it('resetDemo removes only the seeded boards (and their files), then the seed can be re-applied', async () => {
    const data = mkdir();
    const a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'auto', seedDir, quiet: true });
    try {
      const u = makeUser(a, 'real');
      const mine = (await u.post('/api/boards', { title: '내 보드' })).json.board;
      await u.post(`/api/boards/${mine.slug}/posts`, { title: '내 글' });
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM uploads').n, 5, 'the fixture board brought its five files');
      resetDemo(a.app, seedDir);
      assert.deepEqual(a.db.all('SELECT slug FROM boards').map((b) => b.slug), [mine.slug]);
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM uploads').n, 0);
      assert.deepEqual(fs.readdirSync(path.join(data, 'uploads')), []);
      assert.equal(a.db.get("SELECT COUNT(*) AS n FROM users WHERE username IS NULL AND is_guest = 0").n, 0, 'orphaned seed owners are removed');
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM posts').n, 1, 'user content untouched');
      const again = runSeed(a.app, { mode: 'on', dir: seedDir });
      assert.deepEqual(again.map((s) => s.created), [true, true]);
      assert.equal((await new Client(a).get(`/api/boards/${FX.slug}`)).json.posts.length, 17);
    } finally { await a.close(); rm(data); }
  });

  // server/seed-cli.js has the repository's seed/ folder built in (no option), so this is the one test that reads it.
  // Other boards may sit there as well (local material on a developer PC) -> only `practice` is asserted.
  it('seed-cli prints board URLs and supports --reset-demo', () => {
    const data = mkdir();
    try {
      const env = { ...process.env, EDULET_DATA_DIR: data, EDULET_PORT: '4567' };
      const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'server', 'seed-cli.js'), ...args], { env, encoding: 'utf8' });
      const first = run();
      assert.match(first, /created\s+http:\/\/localhost:4567\/b\/practice/);
      const second = run();
      assert.match(second, /exists\s+http:\/\/localhost:4567\/b\/practice/);
      assert.doesNotMatch(second, /created/);
      const third = run('--reset-demo');
      assert.match(third, /created\s+http:\/\/localhost:4567\/b\/practice/);
      assert.ok(fs.existsSync(path.join(data, 'edulet.db')));
    } finally { rm(data); }
  });
});
