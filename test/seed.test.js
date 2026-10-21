import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, PNG, makeUser, startApp } from './helpers.js';
import { applySeed, loadSeedSpecs, resetDemo, runSeed } from '../server/seed.js';
import { createApp } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('seeding with the real seed/*.json', () => {
  let app;
  let anon;
  before(async () => {
    app = await startApp({ seed: 'auto' }); // empty DB -> seeds the repository's seed/ folder
    anon = new Client(app);
  });
  after(async () => { await app.close(); });

  it('creates both boards on first start', () => {
    assert.deepEqual(app.seeded.map((s) => [s.slug, s.created]).sort(), [['demo-board', true], ['practice', true]]);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM boards').n, 2);
  });

  it('demo-board: rows format, comment link access, 3 sections, 17 posts, 2 comments on "네 번째 카드"', async () => {
    const r = await anon.get('/api/boards/demo-board');
    assert.equal(r.status, 200, 'readable without logging in');
    const { board, sections, posts, role, isOwner } = r.json;
    assert.equal(board.format, 'rows');
    assert.equal(board.linkAccess, 'comment');
    assert.equal(board.visibility, 'link');
    assert.equal(board.wallpaper, 'green');
    assert.equal(board.title, '연수 예시 보드');
    assert.equal(board.owner.displayName, '게시자');
    assert.equal(board.settings.newPostPosition, 'bottom');
    assert.equal(role, 'comment');
    assert.equal(isOwner, false);
    assert.equal(sections.length, 3);
    assert.deepEqual(sections.map((s) => s.rank), [1, 2, 3]);
    assert.deepEqual(sections.map((s) => s.title), ['1부: 시작하기', '2부: 둘러보기', '3부: 마무리']);
    assert.equal(posts.length, 17);
    const drive = posts.filter((p) => p.title === '네 번째 카드');
    assert.equal(drive.length, 1);
    assert.equal(drive[0].commentCount, 2);
    assert.equal(posts.reduce((n, p) => n + p.commentCount, 0), 2, 'no other post has comments');
    const comments = (await anon.get(`/api/posts/${drive[0].id}/comments`)).json.comments;
    assert.equal(comments.length, 2);
    assert.equal(comments[0].body, '네 번째 카드\nhttps://example.com/a');
    assert.equal(comments[1].body, '스튜디오\nhttps://example.com/b');
    assert.equal(comments[0].author.id, board.owner.id, 'no author given -> the owner');
    // sections hold 7 / 8 / 2 posts, in listing order (newPostPosition=bottom -> rank grows)
    const per = sections.map((s) => posts.filter((p) => p.sectionId === s.id).sort((a, b) => a.rank - b.rank).map((p) => p.title));
    assert.deepEqual(per.map((l) => l.length), [7, 8, 2]);
    assert.equal(per[0][0], '첫 번째 카드');
    assert.equal(per[0][3], '네 번째 카드');
    assert.equal(per[2][1], '마지막 카드');
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
    assert.equal((await u.patch('/api/boards/demo-board', { title: 'hacked' })).status, 403);
    assert.equal((await u.del('/api/boards/demo-board')).status, 403);
  });

  it('ageDays: board created ~31 days ago, posts +60s apart in list order, comments +1h', async () => {
    const { board, posts } = (await anon.get('/api/boards/demo-board')).json;
    const age = (Date.now() - board.createdAt) / 86400000;
    assert.ok(age > 30.9 && age < 31.1, `age ${age}`);
    const byRank = [...posts].sort((a, b) => a.createdAt - b.createdAt);
    assert.equal(byRank[0].createdAt, board.createdAt);
    assert.equal(byRank[1].createdAt - byRank[0].createdAt, 60000);
    assert.equal(byRank[16].createdAt - byRank[0].createdAt, 16 * 60000);
    const drive = posts.find((p) => p.title === '네 번째 카드');
    const cs = (await anon.get(`/api/posts/${drive.id}/comments`)).json.comments;
    assert.ok(cs.every((c) => c.createdAt === drive.createdAt + 3600000));
    const practice = (await anon.get('/api/boards/practice')).json.board;
    assert.ok(Math.abs((Date.now() - practice.createdAt) / 86400000 - 1) < 0.1);
  });

  it('seed images are copied into uploads and served (image / file / link-preview thumbnails)', async () => {
    const { posts } = (await anon.get('/api/boards/demo-board')).json;
    const image = posts.find((p) => p.title === '첫 번째 카드');
    assert.equal(image.attachment.kind, 'image');
    assert.equal(image.attachment.mime, 'image/jpeg');
    assert.equal(image.attachment.name, 'sample.jpg');
    assert.equal(image.attachment.size, fs.statSync(path.join(ROOT, 'seed', 'img', 'sample.jpg')).size);
    assert.match(image.attachment.url, /^\/uploads\/[0-9a-f]{32}\/sample\.jpg$/);
    const got = await fetch(app.url + image.attachment.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), fs.readFileSync(path.join(ROOT, 'seed', 'img', 'sample.jpg')));
    // png / webp keep their real types
    assert.equal(posts.find((p) => p.title === '이미지 카드').attachment.mime, 'image/png');
    // file attachment with preview thumbnail; Korean/space file name percent-encoded in the URL
    const file = posts.find((p) => p.title === '파일 카드');
    assert.equal(file.attachment.kind, 'file');
    assert.equal(file.attachment.name, 'sample.pdf');
    assert.equal(file.attachment.mime, 'application/pdf');
    assert.match(file.attachment.url, /^\/uploads\/[0-9a-f]{32}\/sample\.pdf$/);
    assert.equal(file.attachment.size, fs.statSync(path.join(ROOT, 'seed', 'img', 'sample.pdf')).size);
    assert.match(file.attachment.preview.image, /^\/uploads\/[0-9a-f]{32}\/sample-preview\.png$/);
    const pdf = await fetch(app.url + file.attachment.url);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /^attachment/);
    assert.equal((await pdf.arrayBuffer()).byteLength, file.attachment.size);
    const thumb = await fetch(app.url + file.attachment.preview.image);
    assert.equal(thumb.headers.get('content-type'), 'image/png');
    await thumb.arrayBuffer();
    // link previews are stored verbatim, imageFile -> local upload URL, no network involved
    const labs = posts.find((p) => p.title === '링크 카드');
    assert.equal(labs.attachment.kind, 'link');
    assert.equal(labs.attachment.url, 'https://example.com/');
    assert.equal(labs.attachment.preview.title, 'example.com');
    assert.equal(labs.attachment.preview.description, "Example description");
    assert.equal(labs.attachment.preview.site, 'example.com');
    assert.match(labs.attachment.preview.image, /^\/uploads\/[0-9a-f]{32}\/sample\.webp$/);
    assert.equal(labs.attachment.preview.imageFile, undefined);
    const lt = await fetch(app.url + labs.attachment.preview.image);
    assert.equal(lt.headers.get('content-type'), 'image/webp');
    await lt.arrayBuffer();
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
    const again = runSeed(app.app, { mode: 'on', dir: path.join(ROOT, 'seed') });
    assert.deepEqual(again.map((s) => s.created), [false, false]);
    assert.deepEqual({ ...counts() }, before);
    assert.equal(fs.readdirSync(path.join(app.dir, 'uploads')).length, app.db.get('SELECT COUNT(*) AS n FROM uploads').n, 'no duplicate files either');
  });
});

describe('seed lifecycle (temporary data folders)', () => {
  const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'edulet-seedtest-'));
  const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

  it('auto seeds only an empty database; off never seeds; on seeds even when boards exist', async () => {
    const data = mkdir();
    try {
      let a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'auto', quiet: true });
      assert.equal(a.seeded.length, 2);
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM boards').n, 2);
      const total = a.db.get('SELECT COUNT(*) AS n FROM posts').n;
      await a.close();
      // restart: nothing changes
      a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'auto', quiet: true });
      assert.deepEqual(a.seeded, []);
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM posts').n, total);
      // a user board exists and the demo gets deleted -> auto does NOT bring it back (boards exist)
      a.db.run("DELETE FROM boards WHERE slug = 'practice'");
      await a.close();
      a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'auto', quiet: true });
      assert.equal(a.db.get("SELECT COUNT(*) AS n FROM boards WHERE slug = 'practice'").n, 0);
      await a.close();
      // on: restores the missing demo board, leaves the existing one alone
      a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 1, quiet: true });
      assert.deepEqual(a.seeded.map((s) => [s.slug, s.created]).sort(), [['demo-board', false], ['practice', true]]);
      await a.close();
      const off = mkdir();
      try {
        const b = await createApp({ dataDir: off, port: 0, host: '127.0.0.1', seed: 0, quiet: true });
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
      const a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', quiet: true });
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM boards').n, 0);
      await a.close();
      process.env.EDULET_SEED = '1';
      const b = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', quiet: true });
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
    const a = await createApp({ dataDir: data, port: 0, host: '127.0.0.1', seed: 'auto', quiet: true });
    try {
      const u = makeUser(a, 'real');
      const mine = (await u.post('/api/boards', { title: '내 보드' })).json.board;
      await u.post(`/api/boards/${mine.slug}/posts`, { title: '내 글' });
      const seedDir = path.join(ROOT, 'seed');
      resetDemo(a.app, seedDir);
      assert.deepEqual(a.db.all('SELECT slug FROM boards').map((b) => b.slug), [mine.slug]);
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM uploads').n, 0);
      assert.deepEqual(fs.readdirSync(path.join(data, 'uploads')), []);
      assert.equal(a.db.get("SELECT COUNT(*) AS n FROM users WHERE username IS NULL AND is_guest = 0").n, 0, 'orphaned seed owners are removed');
      assert.equal(a.db.get('SELECT COUNT(*) AS n FROM posts').n, 1, 'user content untouched');
      const again = runSeed(a.app, { mode: 'on', dir: seedDir });
      assert.deepEqual(again.map((s) => s.created), [true, true]);
      assert.equal((await new Client(a).get('/api/boards/demo-board')).json.posts.length, 17);
    } finally { await a.close(); rm(data); }
  });

  it('seed-cli prints board URLs and supports --reset-demo', () => {
    const data = mkdir();
    try {
      const env = { ...process.env, EDULET_DATA_DIR: data, EDULET_PORT: '4567' };
      const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'server', 'seed-cli.js'), ...args], { env, encoding: 'utf8' });
      const first = run();
      assert.match(first, /created\s+http:\/\/localhost:4567\/b\/demo-board/);
      assert.match(first, /created\s+http:\/\/localhost:4567\/b\/practice/);
      const second = run();
      assert.match(second, /exists\s+http:\/\/localhost:4567\/b\/demo-board/);
      assert.doesNotMatch(second, /created/);
      const third = run('--reset-demo');
      assert.match(third, /created\s+http:\/\/localhost:4567\/b\/demo-board/);
      assert.ok(fs.existsSync(path.join(data, 'edulet.db')));
    } finally { rm(data); }
  });
});
