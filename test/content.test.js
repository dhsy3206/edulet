import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PNG, addMember, makeBoard, makePost, makeUser, startApp } from './helpers.js';

let app;
let owner;
before(async () => { app = await startApp(); owner = makeUser(app, 'owner'); });
after(async () => { await app.close(); });

const snapshot = async (c, b) => (await c.get(`/api/boards/${b.slug}`)).json;
const sectionTitles = async (b) => (await snapshot(owner, b)).sections.map((s) => s.title);
const postOrder = async (b) => (await snapshot(owner, b)).posts.map((p) => p.title);
const rankOf = (b, id) => app.db.get('SELECT rank FROM posts WHERE id = ?', id).rank;

describe('sections', () => {
  it('create appends; beforeId inserts in the middle; validation', async () => {
    const b = await makeBoard(owner, { template: 'training' });
    const secs = (await snapshot(owner, b)).sections;
    const r = await owner.post(`/api/boards/${b.slug}/sections`, { title: '  3부  ' });
    assert.equal(r.status, 201);
    assert.equal(r.json.section.title, '3부');
    assert.equal(r.json.section.boardId, b.id);
    assert.equal(r.json.section.rank, 3);
    const mid = await owner.post(`/api/boards/${b.slug}/sections`, { title: '1.5부', beforeId: secs[1].id });
    assert.equal(mid.json.section.rank, 1.5);
    const first = await owner.post(`/api/boards/${b.slug}/sections`, { title: '0부', beforeId: secs[0].id });
    assert.equal(first.json.section.rank, 0);
    assert.deepEqual(await sectionTitles(b), ['0부', '1부', '1.5부', '2부', '3부']);
    assert.equal((await owner.post(`/api/boards/${b.slug}/sections`, { title: '' })).status, 400);
    assert.equal((await owner.post(`/api/boards/${b.slug}/sections`, { title: 'x'.repeat(81) })).status, 400);
    assert.equal((await owner.post(`/api/boards/${b.slug}/sections`, { title: 'x'.repeat(80) })).status, 201);
    const other = await makeBoard(owner, { template: 'training' });
    const foreign = (await snapshot(owner, other)).sections[0].id;
    assert.equal((await owner.post(`/api/boards/${b.slug}/sections`, { title: 'bad', beforeId: foreign })).status, 400);
    assert.equal((await owner.post(`/api/boards/${b.slug}/sections`, { title: 'bad', beforeId: 'abc' })).status, 400);
  });

  it('rename', async () => {
    const b = await makeBoard(owner, { template: 'kwl' });
    const [s1] = (await snapshot(owner, b)).sections;
    const r = await owner.patch(`/api/sections/${s1.id}`, { title: '새 이름' });
    assert.equal(r.json.section.title, '새 이름');
    assert.equal(r.json.section.id, s1.id);
    assert.equal((await owner.patch(`/api/sections/${s1.id}`, { title: '' })).status, 400);
    assert.equal((await owner.patch('/api/sections/99999999', { title: 'x' })).status, 404);
    assert.equal((await owner.patch('/api/sections/abc', { title: 'x' })).status, 404);
  });

  it('move: before another / to the end / before itself is a no-op', async () => {
    const b = await makeBoard(owner, { template: 'kwl' });
    const [a, bb, c] = (await snapshot(owner, b)).sections;
    let r = await owner.post(`/api/sections/${c.id}/move`, { beforeId: a.id });
    assert.equal(r.json.section.rank, 0);
    assert.deepEqual(await sectionTitles(b), ['배운 것', '알고 있는 것', '알고 싶은 것']);
    r = await owner.post(`/api/sections/${a.id}/move`, { beforeId: null });
    assert.equal(r.json.section.rank, 3, 'null = end (max + 1)');
    assert.deepEqual(await sectionTitles(b), ['배운 것', '알고 싶은 것', '알고 있는 것']);
    r = await owner.post(`/api/sections/${bb.id}/move`, { beforeId: a.id });
    assert.equal(r.json.section.rank, (0 + 3) / 2, 'mid-point of its new neighbours (itself excluded)');
    const before = await sectionTitles(b);
    await owner.post(`/api/sections/${bb.id}/move`, { beforeId: bb.id });
    assert.deepEqual(await sectionTitles(b), before);
    assert.equal((await owner.post(`/api/sections/${bb.id}/move`, {})).status, 400, 'beforeId is required (null allowed)');
    assert.equal((await owner.post(`/api/sections/${bb.id}/move`, { beforeId: 999999 })).status, 400);
  });

  it('move: repeated moves collapse the gap -> list is renumbered 1..n', async () => {
    const b = await makeBoard(owner, { template: 'training' }); // 1부, 2부
    const [x, y] = (await snapshot(owner, b)).sections;
    const z1 = (await owner.post(`/api/boards/${b.slug}/sections`, { title: 'Z1' })).json.section;
    const z2 = (await owner.post(`/api/boards/${b.slug}/sections`, { title: 'Z2' })).json.section;
    let renumbered = false;
    for (let i = 0; i < 30; i++) {
      const z = i % 2 === 0 ? z1 : z2;
      await owner.post(`/api/sections/${z.id}/move`, { beforeId: y.id });
      const ranks = (await snapshot(owner, b)).sections.map((s) => s.rank);
      if (ranks.every(Number.isInteger) && ranks.join() === '1,2,3,4') renumbered = true;
    }
    assert.ok(renumbered, 'ranks were renumbered 1..n at least once');
    const snap = (await snapshot(owner, b)).sections;
    assert.equal(snap[0].id, x.id);
    assert.equal(snap[3].id, y.id);
    assert.deepEqual(snap.slice(1, 3).map((s) => s.title).sort(), ['Z1', 'Z2']);
    const ranks = snap.map((s) => s.rank);
    for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] - ranks[i - 1] >= 1e-6);
  });

  it('delete: posts move to the first other section by default; =delete removes them; last section -> sectionId null', async () => {
    const b = await makeBoard(owner, { template: 'kwl' });
    const [s1, s2, s3] = (await snapshot(owner, b)).sections;
    await makePost(owner, b, { title: 'p1', sectionId: s1.id });
    await makePost(owner, b, { title: 'p2', sectionId: s2.id });
    await makePost(owner, b, { title: 'p3', sectionId: s2.id });
    const r = await owner.del(`/api/sections/${s2.id}`);
    assert.deepEqual(r.json, { ok: true });
    let snap = await snapshot(owner, b);
    assert.deepEqual(snap.sections.map((s) => s.id), [s1.id, s3.id]);
    const moved = Object.fromEntries(snap.posts.map((p) => [p.title, p]));
    assert.equal(moved.p2.sectionId, s1.id, 'moved to the first other section');
    assert.equal(moved.p3.sectionId, s1.id);
    assert.equal(moved.p1.sectionId, s1.id);
    const ranks = [moved.p1.rank, moved.p2.rank, moved.p3.rank];
    assert.equal(new Set(ranks).size, 3, 'moved posts get distinct ranks');
    // posts=delete
    const q = await makePost(owner, b, { title: 'q', sectionId: s3.id });
    assert.equal((await owner.del(`/api/sections/${s3.id}?posts=delete`)).status, 200);
    snap = await snapshot(owner, b);
    assert.ok(!snap.posts.some((p) => p.id === q.id));
    assert.equal(snap.posts.length, 3);
    // last section: posts get no section
    assert.equal((await owner.del(`/api/sections/${s1.id}`)).status, 200);
    snap = await snapshot(owner, b);
    assert.equal(snap.sections.length, 0);
    assert.ok(snap.posts.length === 3 && snap.posts.every((p) => p.sectionId === null));
    assert.equal((await owner.del(`/api/sections/${s1.id}`)).status, 404);
    assert.equal((await owner.del(`/api/sections/${s1.id}?posts=maybe`)).status, 404);
  });

  it('delete with an invalid mode is 400', async () => {
    const b = await makeBoard(owner, { template: 'kwl' });
    const [s1] = (await snapshot(owner, b)).sections;
    assert.equal((await owner.del(`/api/sections/${s1.id}?posts=maybe`)).status, 400);
  });
});

describe('posts: create', () => {
  it('returns the full Post shape (with mine) and stores authorship', async () => {
    const b = await makeBoard(owner, { title: '글쓰기' });
    const r = await owner.post(`/api/boards/${b.slug}/posts`, { title: '  제목  ', body: '첫 줄\n둘째 줄', color: 'yellow' });
    assert.equal(r.status, 201);
    const p = r.json.post;
    assert.deepEqual(Object.keys(p).sort(), [
      'attachment', 'author', 'body', 'boardId', 'color', 'commentCount', 'createdAt', 'id', 'pinned', 'rank', 'reactions',
      'sectionId', 'status', 'title', 'updatedAt', 'w', 'x', 'y',
    ].sort());
    assert.equal(p.title, '제목');
    assert.equal(p.body, '첫 줄\n둘째 줄');
    assert.equal(p.color, 'yellow');
    assert.equal(p.boardId, b.id);
    assert.equal(p.sectionId, null);
    assert.equal(p.author.id, owner.id);
    assert.equal(p.pinned, false);
    assert.equal(p.status, 'published');
    assert.equal(p.commentCount, 0);
    assert.equal(p.attachment, null);
    assert.deepEqual([p.x, p.y, p.w], [null, null, null]);
    assert.deepEqual(p.reactions, {
      like: { count: 0, mine: false }, vote: { count: 0, mine: false }, star: { count: 0, mine: false },
      grade: { count: 0, avg: 0, mine: 0 }, emoji: {},
    });
    assert.equal(typeof p.createdAt, 'number');
    // the snapshot (viewer = author) carries the same shape
    const snap = await snapshot(owner, b);
    assert.deepEqual(snap.posts[0], p);
  });

  it('validation: empty_post, too long, colour, bad section, bad URLs', async () => {
    const b = await makeBoard(owner, { template: 'kwl' });
    const post = (body) => owner.post(`/api/boards/${b.slug}/posts`, body);
    let r = await post({});
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'empty_post');
    assert.equal((await post({ title: '  ', body: '\n ' })).json.error.code, 'empty_post');
    assert.equal((await post({ title: 'x'.repeat(201) })).status, 400);
    assert.equal((await post({ title: 'x'.repeat(200) })).status, 201);
    assert.equal((await post({ body: 'x'.repeat(10001) })).status, 400);
    assert.equal((await post({ body: 'x'.repeat(10000) })).status, 201);
    assert.equal((await post({ title: 'c', color: 'magenta' })).status, 400);
    assert.equal((await post({ title: 'c', color: null })).status, 201);
    const other = await makeBoard(owner, { template: 'kwl' });
    const foreignSection = (await snapshot(owner, other)).sections[0].id;
    r = await post({ title: 's', sectionId: foreignSection });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'bad_section');
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'ftp://example.com/x', 'file:///etc/passwd', 'vbscript:x', 'example.com', '', '//evil.example/x']) {
      for (const kind of ['link', 'video', 'image']) {
        r = await post({ attachment: { kind, url } });
        assert.equal(r.status, 400, `${kind} ${url}`);
        assert.equal(r.json.error.code, 'bad_url', `${kind} ${url}`);
      }
    }
    assert.equal((await post({ attachment: { kind: 'file', url: 'https://example.com/x.pdf' } })).status, 400, 'files must be uploaded first');
    assert.equal((await post({ attachment: { kind: 'hologram', url: 'https://example.com' } })).status, 400);
    assert.equal((await post({ attachment: 'nope' })).status, 400);
  });

  it('ranks: top = min-1 (default), bottom = max+1; snapshot is sorted pinned DESC, rank ASC', async () => {
    const top = await makeBoard(owner, { title: 'top' });
    const a = await makePost(owner, top, { title: 'a' });
    const b = await makePost(owner, top, { title: 'b' });
    const c = await makePost(owner, top, { title: 'c' });
    assert.deepEqual([a.rank, b.rank, c.rank], [1, 0, -1]);
    assert.deepEqual(await postOrder(top), ['c', 'b', 'a']);
    const bottom = await makeBoard(owner, { title: 'bottom', settings: { newPostPosition: 'bottom' } });
    const x = await makePost(owner, bottom, { title: 'x' });
    const y = await makePost(owner, bottom, { title: 'y' });
    const z = await makePost(owner, bottom, { title: 'z' });
    assert.deepEqual([x.rank, y.rank, z.rank], [1, 2, 3]);
    assert.deepEqual(await postOrder(bottom), ['x', 'y', 'z']);
  });

  it('sectioned boards: default to the first section, explicit section, per-section ranks; ignored on unsectioned boards', async () => {
    const b = await makeBoard(owner, { template: 'kwl', settings: { newPostPosition: 'bottom' } });
    const [s1, s2] = (await snapshot(owner, b)).sections;
    const a = await makePost(owner, b, { title: 'a' });
    const c = await makePost(owner, b, { title: 'c', sectionId: s2.id });
    const d = await makePost(owner, b, { title: 'd', sectionId: s2.id });
    const e = await makePost(owner, b, { title: 'e', sectionId: null });
    assert.equal(a.sectionId, s1.id);
    assert.deepEqual([c.sectionId, d.sectionId], [s2.id, s2.id]);
    assert.equal(e.sectionId, s1.id);
    assert.deepEqual([a.rank, e.rank, c.rank, d.rank], [1, 2, 1, 2]);
    const wall = await makeBoard(owner, { title: '벽' });
    const wp = await makePost(owner, wall, { title: 'w', sectionId: s1.id });
    assert.equal(wp.sectionId, null);
  });

  it('canvas geometry (x, y, w) is stored and validated', async () => {
    const b = await makeBoard(owner, { format: 'canvas' });
    const p = await makePost(owner, b, { title: 'c', x: 120.5, y: 40, w: 300 });
    assert.deepEqual([p.x, p.y, p.w], [120.5, 40, 300]);
    assert.equal((await owner.post(`/api/boards/${b.slug}/posts`, { title: 'c', x: 'a' })).status, 400);
    const up = await owner.patch(`/api/posts/${p.id}`, { x: 10, y: -5, w: 99999 });
    assert.deepEqual([up.json.post.x, up.json.post.y], [10, -5]);
    assert.ok(up.json.post.w <= 4000, 'w is clamped');
  });

  it('attachments: upload (image/file), external image URL, link and video previews', async () => {
    const b = await makeBoard(owner, { title: '첨부' });
    const upImg = await owner.put(`/api/uploads?board=${b.slug}&name=pic.png`, PNG, { raw: true, headers: { 'content-type': 'image/png' } });
    const upFile = await owner.put(`/api/uploads?board=${b.slug}&name=${encodeURIComponent('보고서 최종.txt')}`, Buffer.from('hello'), { raw: true, headers: { 'content-type': 'text/plain' } });
    const img = await makePost(owner, b, { title: '', body: '', attachment: { kind: 'image', uploadId: upImg.json.id } });
    assert.deepEqual(
      { ...img.attachment },
      { kind: 'image', url: upImg.json.url, name: 'pic.png', mime: 'image/png', size: PNG.length },
    );
    const file = await makePost(owner, b, { attachment: { kind: 'file', uploadId: upFile.json.id } });
    assert.equal(file.attachment.kind, 'file');
    assert.equal(file.attachment.name, '보고서 최종.txt');
    assert.equal(file.attachment.url, `/uploads/${upFile.json.id}/${encodeURIComponent('보고서 최종.txt')}`);
    assert.equal(file.attachment.size, 5);
    const ext = await makePost(owner, b, { attachment: { kind: 'image', url: 'https://example.com/a/photo.jpg?x=1' } });
    assert.equal(ext.attachment.kind, 'image');
    assert.equal(ext.attachment.url, 'https://example.com/a/photo.jpg?x=1');
    assert.equal(ext.attachment.preview, undefined);
    const link = await makePost(owner, b, { attachment: { kind: 'link', url: 'https://example.com/article' } });
    assert.equal(link.attachment.kind, 'link');
    assert.equal(link.attachment.url, 'https://example.com/article');
    assert.equal(link.attachment.preview.title, 'Stub Title');
    assert.equal(link.attachment.preview.description, 'Stub description');
    const yt = await makePost(owner, b, { attachment: { kind: 'link', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
    assert.equal(yt.attachment.kind, 'video', 'YouTube links are upgraded to video');
    assert.equal(yt.attachment.preview.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    assert.equal(yt.attachment.preview.image, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    // foreign uploads / wrong kinds are refused
    const stranger = makeUser(app, 'stranger');
    const otherBoard = await makeBoard(stranger, { title: '남의', linkAccess: 'write' });
    const theirs = await stranger.put(`/api/uploads?board=${otherBoard.slug}&name=x.png`, PNG, { raw: true, headers: { 'content-type': 'image/png' } });
    const mine = await owner.post(`/api/boards/${b.slug}/posts`, { attachment: { kind: 'image', uploadId: theirs.json.id } });
    assert.equal(mine.status, 400);
    assert.equal(mine.json.error.code, 'bad_upload');
    assert.equal((await owner.post(`/api/boards/${b.slug}/posts`, { attachment: { kind: 'image', uploadId: upFile.json.id } })).status, 400);
    assert.equal((await owner.post(`/api/boards/${b.slug}/posts`, { attachment: { kind: 'file', uploadId: 'f'.repeat(32) } })).status, 400);
  });
});

describe('posts: update / delete / pin', () => {
  it('PATCH updates fields; empty result is refused; attachment can be removed', async () => {
    const b = await makeBoard(owner, { title: '수정' });
    const p = await makePost(owner, b, { title: '원래', body: '내용', attachment: { kind: 'link', url: 'https://example.com' } });
    const r = await owner.patch(`/api/posts/${p.id}`, { title: '바뀜', body: '새 내용', color: 'blue' });
    assert.equal(r.status, 200);
    assert.equal(r.json.post.title, '바뀜');
    assert.equal(r.json.post.body, '새 내용');
    assert.equal(r.json.post.color, 'blue');
    assert.equal(r.json.post.attachment.kind, 'link', 'untouched');
    assert.ok(r.json.post.updatedAt >= p.updatedAt);
    assert.equal((await owner.patch(`/api/posts/${p.id}`, { color: 'nope' })).status, 400);
    assert.equal((await owner.patch(`/api/posts/${p.id}`, { pinned: 'yes' })).status, 400);
    const r2 = await owner.patch(`/api/posts/${p.id}`, { attachment: null });
    assert.equal(r2.json.post.attachment, null);
    const r3 = await owner.patch(`/api/posts/${p.id}`, { title: '', body: '' });
    assert.equal(r3.status, 400);
    assert.equal(r3.json.error.code, 'empty_post');
    assert.equal((await owner.patch('/api/posts/99999999', { title: 'x' })).status, 404);
  });

  it('pin: moderators only; pinned posts sort first', async () => {
    const b = await makeBoard(owner, { title: '핀', linkAccess: 'write' });
    const writer = makeUser(app, 'pinwriter');
    const a = await makePost(owner, b, { title: 'a' });
    const w = await makePost(writer, b, { title: 'w' });
    await makePost(owner, b, { title: 'c' });
    assert.deepEqual(await postOrder(b), ['c', 'w', 'a']);
    assert.equal((await writer.patch(`/api/posts/${w.id}`, { pinned: true })).status, 403, 'authors cannot pin their own');
    const r = await owner.patch(`/api/posts/${a.id}`, { pinned: true });
    assert.equal(r.json.post.pinned, true);
    assert.deepEqual(await postOrder(b), ['a', 'c', 'w']);
    await owner.patch(`/api/posts/${a.id}`, { pinned: false });
    assert.deepEqual(await postOrder(b), ['c', 'w', 'a']);
  });

  it('PATCH sectionId moves the post to the end of that section', async () => {
    const b = await makeBoard(owner, { template: 'kwl', settings: { newPostPosition: 'bottom' } });
    const [s1, s2] = (await snapshot(owner, b)).sections;
    const a = await makePost(owner, b, { title: 'a', sectionId: s1.id });
    await makePost(owner, b, { title: 'x', sectionId: s2.id });
    const r = await owner.patch(`/api/posts/${a.id}`, { sectionId: s2.id });
    assert.equal(r.json.post.sectionId, s2.id);
    assert.equal(r.json.post.rank, 2);
    assert.equal((await owner.patch(`/api/posts/${a.id}`, { sectionId: 99999 })).status, 400);
  });

  it('DELETE removes the post with its comments and reactions', async () => {
    const b = await makeBoard(owner, { title: '삭제' });
    const p = await makePost(owner, b);
    await owner.post(`/api/posts/${p.id}/comments`, { body: 'c' });
    await owner.put(`/api/posts/${p.id}/reactions`, { kind: 'like' });
    assert.deepEqual((await owner.del(`/api/posts/${p.id}`)).json, { ok: true });
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?', p.id).n, 0);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?', p.id).n, 0);
    assert.equal((await owner.del(`/api/posts/${p.id}`)).status, 404);
    assert.equal((await snapshot(owner, b)).posts.length, 0);
  });
});

describe('posts: move & rank math', () => {
  const wallWith = async (titles) => {
    const b = await makeBoard(owner, { title: '이동', settings: { newPostPosition: 'bottom' } });
    const posts = [];
    for (const t of titles) posts.push(await makePost(owner, b, { title: t }));
    return { b, posts };
  };

  it('mid-point between neighbours, before-first = min-1, end = max+1', async () => {
    const { b, posts: [a, bb, c] } = await wallWith(['A', 'B', 'C']);
    assert.deepEqual([a.rank, bb.rank, c.rank], [1, 2, 3]);
    let r = await owner.post(`/api/posts/${c.id}/move`, { sectionId: null, beforeId: bb.id });
    assert.equal(r.json.post.rank, 1.5);
    assert.deepEqual(await postOrder(b), ['A', 'C', 'B']);
    r = await owner.post(`/api/posts/${c.id}/move`, { sectionId: null, beforeId: a.id });
    assert.equal(r.json.post.rank, 0);
    assert.deepEqual(await postOrder(b), ['C', 'A', 'B']);
    r = await owner.post(`/api/posts/${c.id}/move`, { sectionId: null, beforeId: null });
    assert.equal(r.json.post.rank, 3);
    assert.deepEqual(await postOrder(b), ['A', 'B', 'C']);
    r = await owner.post(`/api/posts/${a.id}/move`, { beforeId: c.id }); // sectionId omitted = unchanged
    assert.equal(r.json.post.rank, 2.5);
    assert.deepEqual(await postOrder(b), ['B', 'A', 'C']);
    const same = await owner.post(`/api/posts/${a.id}/move`, { beforeId: a.id });
    assert.equal(same.json.post.rank, 2.5, 'before itself keeps the slot');
    assert.deepEqual(await postOrder(b), ['B', 'A', 'C']);
  });

  it('collapsed gaps (< 1e-6) renumber the whole list 1..n', async () => {
    const { b, posts: [x, y, z1, z2] } = await wallWith(['X', 'Y', 'Z1', 'Z2']);
    let renumbered = false;
    for (let i = 0; i < 30; i++) {
      const z = i % 2 === 0 ? z1 : z2;
      const r = await owner.post(`/api/posts/${z.id}/move`, { sectionId: null, beforeId: y.id });
      assert.equal(r.status, 200);
      const ranks = [x, y, z1, z2].map((p) => rankOf(b, p.id));
      if (ranks.every(Number.isInteger) && new Set(ranks).size === 4 && Math.min(...ranks) === 1 && Math.max(...ranks) === 4) renumbered = true;
    }
    assert.ok(renumbered, 'renumbering happened');
    const order = await postOrder(b);
    assert.equal(order[0], 'X');
    assert.equal(order[3], 'Y');
    assert.deepEqual(order.slice(1, 3).sort(), ['Z1', 'Z2']);
    const ranks = (await snapshot(owner, b)).posts.map((p) => p.rank);
    for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] - ranks[i - 1] >= 1e-6, 'no collapsed gaps remain');
  });

  it('bad beforeId (unknown / other list / other board) is 400', async () => {
    const { posts: [a] } = await wallWith(['A', 'B']);
    assert.equal((await owner.post(`/api/posts/${a.id}/move`, { beforeId: 999999 })).status, 400);
    assert.equal((await owner.post(`/api/posts/${a.id}/move`, { beforeId: 'x' })).status, 400);
    const other = await makeBoard(owner, { title: '다른' });
    const foreign = await makePost(owner, other);
    assert.equal((await owner.post(`/api/posts/${a.id}/move`, { beforeId: foreign.id })).status, 400);
  });

  it('across sections (shelf): beforeId must live in the target section; section must belong to the board', async () => {
    const b = await makeBoard(owner, { template: 'kwl', settings: { newPostPosition: 'bottom' } });
    const [s1, s2, s3] = (await snapshot(owner, b)).sections;
    const a1 = await makePost(owner, b, { title: 'a1', sectionId: s1.id });
    const a2 = await makePost(owner, b, { title: 'a2', sectionId: s1.id });
    const b1 = await makePost(owner, b, { title: 'b1', sectionId: s2.id });
    const b2 = await makePost(owner, b, { title: 'b2', sectionId: s2.id });
    let r = await owner.post(`/api/posts/${a1.id}/move`, { sectionId: s2.id, beforeId: b2.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.post.sectionId, s2.id);
    assert.equal(r.json.post.rank, 1.5);
    let snap = await snapshot(owner, b);
    const titles = (sid) => snap.posts.filter((p) => p.sectionId === sid).sort((p, q) => p.rank - q.rank).map((p) => p.title);
    assert.deepEqual(titles(s1.id), ['a2']);
    assert.deepEqual(titles(s2.id), ['b1', 'a1', 'b2']);
    r = await owner.post(`/api/posts/${a2.id}/move`, { sectionId: s3.id, beforeId: null });
    assert.equal(r.json.post.rank, 1, 'empty target list starts at 1');
    r = await owner.post(`/api/posts/${a2.id}/move`, { sectionId: s2.id, beforeId: b1.id });
    assert.equal(r.json.post.rank, b1.rank - 1);
    assert.equal((await owner.post(`/api/posts/${a2.id}/move`, { sectionId: s3.id, beforeId: b1.id })).status, 400, 'b1 is not in s3');
    const other = await makeBoard(owner, { template: 'kwl' });
    const foreignSection = (await snapshot(owner, other)).sections[0].id;
    assert.equal((await owner.post(`/api/posts/${a2.id}/move`, { sectionId: foreignSection, beforeId: null })).status, 400);
    r = await owner.post(`/api/posts/${a2.id}/move`, { sectionId: null, beforeId: null });
    assert.equal(r.json.post.sectionId, null);
    snap = await snapshot(owner, b);
    assert.equal(snap.posts.find((p) => p.id === a2.id).sectionId, null);
  });

  it('non-sectioned boards always keep sectionId null', async () => {
    const b = await makeBoard(owner, { title: '벽' });
    const p = await makePost(owner, b);
    const sec = await makeBoard(owner, { template: 'kwl' });
    const sid = (await snapshot(owner, sec)).sections[0].id;
    const r = await owner.post(`/api/posts/${p.id}/move`, { sectionId: sid, beforeId: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.post.sectionId, null);
  });
});

describe('boards: role changes are reflected in access', () => {
  it('member added mid-flight can post; removed member loses write on a read-only link board', async () => {
    const b = await makeBoard(owner, { title: '권한', linkAccess: 'read' });
    const u = makeUser(app, 'later');
    assert.equal((await u.post(`/api/boards/${b.slug}/posts`, { title: 'x' })).status, 403);
    await addMember(owner, b, u, 'write');
    assert.equal((await u.post(`/api/boards/${b.slug}/posts`, { title: 'x' })).status, 201);
    await owner.del(`/api/boards/${b.slug}/members/${u.id}`);
    assert.equal((await u.post(`/api/boards/${b.slug}/posts`, { title: 'y' })).status, 403);
  });
});
