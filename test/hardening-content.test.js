// Hardening: write limits (M6), showAuthor (M7), login-name visibility, approval on edits (M8), members (M9),
// re-authorisation after awaits (L2), existence oracles (L3, L4).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, addMember, makeBoard, makePost, makeUser, openSse, parseCsv, sleep, startApp } from './helpers.js';

const ANON = { id: 0, username: null, displayName: '익명', avatarColor: '#94a3b8', isGuest: true };
const html = (title) => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<title>${title}</title>`) });
const snap = async (c, b) => (await c.get(`/api/boards/${b.slug}`)).json;
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(10); }
  return false;
};

describe('M6: per-user write rate limit and per-board post cap', () => {
  it('writes (posts, comments, reactions, sections, edits) share one per-user budget -> 429 rate_limited', async () => {
    const app = await startApp({ config: { writeRateMax: 6 } });
    try {
      const o = makeUser(app, 'o');
      const b = await makeBoard(o, { title: 'b', linkAccess: 'write', template: 'kwl' });
      const u = makeUser(app, 'u');
      const p1 = await makePost(u, b, { title: 'one' }); // 1
      await makePost(u, b, { title: 'two' }); // 2
      assert.equal((await u.post(`/api/posts/${p1.id}/comments`, { body: 'c' })).status, 201); // 3
      assert.equal((await u.put(`/api/posts/${p1.id}/reactions`, { kind: 'like' })).status, 200); // 4
      assert.equal((await u.patch(`/api/posts/${p1.id}`, { title: 'edited' })).status, 200); // 5
      assert.equal((await u.post(`/api/posts/${p1.id}/move`, { beforeId: null })).status, 200); // 6
      for (const probe of [
        () => u.post(`/api/boards/${b.slug}/posts`, { title: 'x' }),
        () => u.post(`/api/posts/${p1.id}/comments`, { body: 'x' }),
        () => u.put(`/api/posts/${p1.id}/reactions`, { kind: 'like' }),
        () => u.patch(`/api/posts/${p1.id}`, { title: 'y' }),
        () => u.del(`/api/posts/${p1.id}`),
      ]) {
        const r = await probe();
        assert.equal(r.status, 429);
        assert.equal(r.json.error.code, 'rate_limited');
        assert.ok(r.headers.get('retry-after'));
      }
      assert.equal((await u.get(`/api/boards/${b.slug}`)).status, 200, 'reads are free');
      assert.equal((await o.post(`/api/boards/${b.slug}/sections`, { title: 'new' })).status, 201, 'budgets are per user');
      const secs = (await o.get(`/api/boards/${b.slug}`)).json.sections;
      for (let i = 0; i < 5; i++) assert.equal((await o.patch(`/api/sections/${secs[0].id}`, { title: `t${i}` })).status, 200);
      assert.equal((await o.patch(`/api/sections/${secs[0].id}`, { title: 'over' })).status, 429, 'sections count too');
    } finally { await app.close(); }
  });

  it('the default budget is 240 writes per minute', async () => {
    const app = await startApp();
    try {
      const b = await makeBoard(makeUser(app, 'o'), { title: 'b', linkAccess: 'write' });
      const u = makeUser(app, 'u');
      const p = await makePost(u, b, { title: 'x' });
      const rs = [];
      for (let i = 0; i < 250; i += 25) rs.push(...await Promise.all(Array.from({ length: 25 }, (_, j) => u.post(`/api/posts/${p.id}/comments`, { body: `c${i + j}` }))));
      assert.equal(rs.filter((r) => r.status === 201).length, 239, 'one write was spent on the post');
      assert.equal(rs.filter((r) => r.status === 429).length, 11);
    } finally { await app.close(); }
  });

  it('a board holds at most boardMaxPosts posts (default 5000) -> 409 board_full; deleting frees room', async () => {
    const app = await startApp({ config: { boardMaxPosts: 3 } });
    try {
      const o = makeUser(app, 'o');
      const b = await makeBoard(o, { title: 'b', linkAccess: 'write', settings: { approval: true } });
      const w = makeUser(app, 'w');
      const posts = [await makePost(w, b, { title: '1' }), await makePost(w, b, { title: '2' }), await makePost(o, b, { title: '3' })];
      assert.equal(posts[0].status, 'pending', 'pending posts count toward the cap');
      const full = await w.post(`/api/boards/${b.slug}/posts`, { title: '4' });
      assert.equal(full.status, 409);
      assert.equal(full.json.error.code, 'board_full');
      assert.match(full.json.error.message, /[가-힣]/);
      assert.equal((await o.post(`/api/boards/${b.slug}/posts`, { title: '4' })).status, 409);
      assert.equal((await o.del(`/api/posts/${posts[2].id}`)).status, 200);
      assert.equal((await o.post(`/api/boards/${b.slug}/posts`, { title: '4' })).status, 201);
      assert.equal((await o.patch(`/api/posts/${posts[0].id}`, { title: 'edit still fine' })).status, 200);
      const other = await makeBoard(o, { title: 'other' });
      assert.equal((await o.post(`/api/boards/${other.slug}/posts`, { title: 'x' })).status, 201, 'the cap is per board');
    } finally { await app.close(); }
  });
});

describe('M7: settings.showAuthor=false is enforced by the server', () => {
  let app;
  let o; let mod; let w1; let w2; let plain;
  let board;
  let P0; let P1; let P2; let C1; let C2;
  before(async () => {
    app = await startApp();
    o = makeUser(app, 'own'); mod = makeUser(app, 'mod'); w1 = makeUser(app, 'wone'); w2 = makeUser(app, 'wtwo'); plain = makeUser(app, 'plain');
    board = await makeBoard(o, { title: 'anon board', linkAccess: 'comment', settings: { showAuthor: false } });
    await addMember(o, board, mod, 'moderate');
    await addMember(o, board, w1, 'write');
    await addMember(o, board, w2, 'write');
    P0 = await makePost(o, board, { title: 'by owner' });
    P1 = await makePost(w1, board, { title: 'by w1' });
    P2 = await makePost(w2, board, { title: 'by w2' });
    C1 = (await w1.post(`/api/posts/${P1.id}/comments`, { body: 'w1 says' })).json.comment;
    C2 = (await w2.post(`/api/posts/${P1.id}/comments`, { body: 'w2 says' })).json.comment;
  });
  after(async () => { await app.close(); });

  const byTitle = (posts) => Object.fromEntries(posts.map((p) => [p.title, p]));
  const authorOf = (posts, title) => byTitle(posts)[title].author;

  it('anonymous readers and commenters see every author as 익명 (snapshot, comments, export)', async () => {
    for (const viewer of [new Client(app), plain]) {
      const s = await snap(viewer, board);
      for (const p of s.posts) assert.deepEqual(p.author, ANON, p.title);
      const cs = (await viewer.get(`/api/posts/${P1.id}/comments`)).json.comments;
      assert.equal(cs.length, 2);
      for (const c of cs) assert.deepEqual(c.author, ANON);
      const json = (await viewer.get(`/api/boards/${board.slug}/export?format=json`)).json;
      for (const p of json.posts) {
        assert.deepEqual(p.author, ANON);
        for (const c of p.comments) assert.deepEqual(c.author, ANON);
      }
      const csv = parseCsv((await viewer.get(`/api/boards/${board.slug}/export?format=csv`)).text.replace(/^﻿/, ''));
      assert.deepEqual(csv.slice(1).map((r) => r[1]), ['익명', '익명', '익명']);
      assert.ok(!JSON.stringify(json).includes(w1.displayName), 'no real name anywhere in the export');
    }
  });

  it('writers see their own items under their real name and everybody else as 익명', async () => {
    const s = await snap(w1, board);
    assert.equal(authorOf(s.posts, 'by w1').id, w1.id);
    assert.equal(authorOf(s.posts, 'by w1').displayName, w1.displayName);
    assert.equal(authorOf(s.posts, 'by w1').username, w1.username, 'your own login name is yours to see');
    assert.deepEqual(authorOf(s.posts, 'by w2'), ANON);
    assert.deepEqual(authorOf(s.posts, 'by owner'), ANON);
    const cs = (await w1.get(`/api/posts/${P1.id}/comments`)).json.comments;
    assert.equal(cs.find((c) => c.id === C1.id).author.id, w1.id);
    assert.deepEqual(cs.find((c) => c.id === C2.id).author, ANON);
    const csv = parseCsv((await w1.get(`/api/boards/${board.slug}/export?format=csv`)).text.replace(/^﻿/, ''));
    assert.deepEqual(csv.slice(1).map((r) => r[1]).sort(), [w1.displayName, '익명', '익명'].sort());
  });

  it('responses to your own writes carry your real author; a non-moderator never gets others\' names back', async () => {
    const mine = await makePost(w1, board, { title: 'fresh by w1' });
    assert.equal(mine.author.id, w1.id);
    const edited = (await w1.patch(`/api/posts/${mine.id}`, { color: 'red' })).json.post;
    assert.equal(edited.author.id, w1.id);
    const moved = (await w1.post(`/api/posts/${mine.id}/move`, { beforeId: null })).json.post;
    assert.equal(moved.author.id, w1.id);
    const cm = (await w2.post(`/api/posts/${P1.id}/comments`, { body: 'again' })).json.comment;
    assert.equal(cm.author.id, w2.id);
    assert.equal((await w1.del(`/api/posts/${mine.id}`)).status, 200);
  });

  it('moderators and admins see real authors; login names only for admins', async () => {
    for (const viewer of [mod, o]) {
      const s = await snap(viewer, board);
      assert.equal(authorOf(s.posts, 'by w1').id, w1.id);
      assert.equal(authorOf(s.posts, 'by w2').displayName, w2.displayName);
      const cs = (await viewer.get(`/api/posts/${P1.id}/comments`)).json.comments;
      assert.deepEqual([...new Set(cs.map((c) => c.author.id))].sort(), [w1.id, w2.id].sort());
    }
    assert.equal(authorOf((await snap(mod, board)).posts, 'by w1').username, null, 'a moderator is not an admin');
    assert.equal(authorOf((await snap(o, board)).posts, 'by w1').username, w1.username);
    const modMove = (await mod.post(`/api/posts/${P2.id}/move`, { beforeId: null })).json.post;
    assert.equal(modMove.author.id, w2.id, 'the mover is a moderator: real author');
    const csv = parseCsv((await mod.get(`/api/boards/${board.slug}/export?format=csv`)).text.replace(/^﻿/, ''));
    assert.ok(csv.slice(1).every((r) => r[1] !== '익명'));
  });

  it('duplicating a board that hides authors does not leak them: below moderate the copier owns the copied posts', async () => {
    const asPlain = (await plain.post(`/api/boards/${board.slug}/duplicate`, { withPosts: true })).json.board;
    const copied = (await snap(plain, asPlain)).posts;
    assert.ok(copied.length >= 3);
    for (const p of copied) assert.equal(p.author.id, plain.id, 'attribution is dropped, not revealed');
    const asMod = (await mod.post(`/api/boards/${board.slug}/duplicate`, { withPosts: true })).json.board;
    assert.deepEqual([...new Set((await snap(mod, asMod)).posts.map((p) => p.author.id))].sort(), [o.id, w1.id, w2.id].sort(), 'moderators may keep authors');
  });

  it('realtime: events are shaped per connection (post.* and comment.created); own items stay real', async () => {
    const open = [];
    try {
      const [sAnon, sW1, sMod, sOwner] = [await openSse(app, board.slug), await openSse(app, board.slug, w1), await openSse(app, board.slug, mod), await openSse(app, board.slug, o)];
      open.push(sAnon, sW1, sMod, sOwner);
      const p = await makePost(w2, board, { title: 'live by w2' });
      const created = (s) => s.waitFor('post.created', (d) => d.post.id === p.id).then((e) => e.data.post.author);
      assert.deepEqual(await created(sAnon), ANON);
      assert.deepEqual(await created(sW1), ANON);
      assert.equal((await created(sMod)).id, w2.id);
      assert.equal((await created(sMod)).username, null, 'moderators: no login name');
      assert.equal((await created(sOwner)).username, w2.username, 'admins get login names');
      const mine = await makePost(w1, board, { title: 'live by w1' });
      assert.equal((await sW1.waitFor('post.created', (d) => d.post.id === mine.id)).data.post.author.id, w1.id, 'own post: real author');
      assert.deepEqual((await sAnon.waitFor('post.created', (d) => d.post.id === mine.id)).data.post.author, ANON);
      await w2.patch(`/api/posts/${p.id}`, { title: 'live edit' });
      assert.deepEqual((await sAnon.waitFor('post.updated', (d) => d.post.id === p.id)).data.post.author, ANON);
      await o.post(`/api/posts/${p.id}/move`, { beforeId: null });
      assert.deepEqual((await sW1.waitFor('post.moved', (d) => d.post.id === p.id)).data.post.author, ANON);
      const cm = (await w2.post(`/api/posts/${P0.id}/comments`, { body: 'live comment' })).json.comment;
      const cev = (s) => s.waitFor('comment.created', (d) => d.comment.id === cm.id).then((e) => e.data.comment.author);
      assert.deepEqual(await cev(sAnon), ANON);
      assert.deepEqual(await cev(sW1), ANON);
      assert.equal((await cev(sMod)).id, w2.id);
      const own = (await w1.post(`/api/posts/${P0.id}/comments`, { body: 'mine' })).json.comment;
      assert.equal((await sW1.waitFor('comment.created', (d) => d.comment.id === own.id)).data.comment.author.id, w1.id);
      assert.deepEqual((await sAnon.waitFor('comment.created', (d) => d.comment.id === own.id)).data.comment.author, ANON);
      // no real identity in any post/comment event the anonymous stream received (presence still lists who is online)
      const content = JSON.stringify(sAnon.events.filter((e) => /^(post|comment)\./.test(e.type)));
      assert.ok(!content.includes(w1.displayName) && !content.includes(w2.displayName) && !content.includes(w1.username), content.slice(0, 300));
    } finally { for (const s of open) s.close?.(); }
  });

  it('turning showAuthor back on reveals names again (REST and events)', async () => {
    const o2 = makeUser(app, 'own2');
    const w = makeUser(app, 'ww');
    const b = await makeBoard(o2, { title: 'toggle', linkAccess: 'write', settings: { showAuthor: false } });
    const p = await makePost(w, b, { title: 'x' });
    const anon = new Client(app);
    assert.deepEqual((await snap(anon, b)).posts[0].author, ANON);
    const s = await openSse(app, b.slug);
    try {
      await o2.patch(`/api/boards/${b.slug}`, { settings: { showAuthor: true } });
      assert.equal((await snap(anon, b)).posts[0].author.id, w.id);
      await o2.patch(`/api/posts/${p.id}`, { title: 'y' });
      assert.equal((await s.waitFor('post.updated', (d) => d.post.id === p.id)).data.post.author.id, w.id);
    } finally { s.close(); }
  });
});

describe('login names (User.username) are for the user themself and board admins only', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  it('snapshot, comments, export and the dashboard', async () => {
    const o = makeUser(app, 'own');
    const adm = makeUser(app, 'adm');
    const mod = makeUser(app, 'mod');
    const w = makeUser(app, 'wri');
    const reader = makeUser(app, 'rdr');
    const b = await makeBoard(o, { title: 'names', linkAccess: 'comment' });
    await addMember(o, b, adm, 'admin');
    await addMember(o, b, mod, 'moderate');
    await addMember(o, b, w, 'write');
    const p = await makePost(w, b, { title: 'post by w' });
    await w.post(`/api/posts/${p.id}/comments`, { body: 'c' });

    for (const viewer of [new Client(app), reader, mod]) {
      const s = await snap(viewer, b);
      assert.equal(s.board.owner.username, null);
      assert.equal(s.board.owner.displayName, o.displayName);
      assert.equal(s.posts[0].author.username, null);
      assert.equal(s.posts[0].author.displayName, w.displayName);
      assert.equal((await viewer.get(`/api/posts/${p.id}/comments`)).json.comments[0].author.username, null);
      const ex = (await viewer.get(`/api/boards/${b.slug}/export?format=json`)).json;
      assert.equal(ex.board.owner.username, null);
      assert.equal(ex.posts[0].author.username, null);
      assert.equal(ex.posts[0].comments[0].author.username, null);
      assert.equal(s.members, undefined);
    }
    for (const viewer of [o, adm]) {
      const s = await snap(viewer, b);
      assert.equal(s.board.owner.username, o.username);
      assert.equal(s.posts[0].author.username, w.username);
      assert.equal((await viewer.get(`/api/posts/${p.id}/comments`)).json.comments[0].author.username, w.username);
      assert.equal((await viewer.get(`/api/boards/${b.slug}/export?format=json`)).json.posts[0].author.username, w.username);
    }
    // your own login name is always visible to you
    assert.equal((await snap(w, b)).posts[0].author.username, w.username);
    assert.equal((await w.get(`/api/posts/${p.id}/comments`)).json.comments[0].author.username, w.username);
    assert.equal((await w.get('/api/auth/me')).json.user.username, w.username);
    // the dashboard: owner JSON carries the login name only when you may see it
    const mine = (await o.get('/api/boards')).json.boards.find((x) => x.slug === b.slug);
    assert.equal(mine.owner.username, o.username);
    assert.equal((await adm.get('/api/boards')).json.boards.find((x) => x.slug === b.slug).owner.username, o.username);
    assert.equal((await w.get('/api/boards')).json.boards.find((x) => x.slug === b.slug).owner.username, null);
    // the response to creating / duplicating a board (you are the owner)
    const created = (await o.post('/api/boards', { title: 'mine' })).json.board;
    assert.equal(created.owner.username, o.username);
    const copy = (await w.post(`/api/boards/${b.slug}/duplicate`, {})).json.board;
    assert.equal(copy.owner.username, w.username);
  });

  it('admins keep seeing usernames in the members list and the snapshot member list; others get 403', async () => {
    const o = makeUser(app, 'own');
    const adm = makeUser(app, 'adm');
    const m = makeUser(app, 'mem');
    const b = await makeBoard(o, { title: 'members' });
    const added = await addMember(o, b, adm, 'admin');
    assert.equal(added.user.username, adm.username);
    await addMember(o, b, m, 'read');
    for (const viewer of [o, adm]) {
      const list = (await viewer.get(`/api/boards/${b.slug}/members`)).json.members;
      assert.deepEqual(list.map((x) => x.user.username).sort(), [o.username, adm.username, m.username].sort());
      assert.deepEqual((await snap(viewer, b)).members.map((x) => x.user.username).sort(), [o.username, adm.username, m.username].sort());
    }
    assert.equal((await m.get(`/api/boards/${b.slug}/members`)).status, 403);
    assert.equal((await snap(m, b)).members, undefined);
    const patched = (await o.patch(`/api/boards/${b.slug}/members/${m.id}`, { role: 'write' })).json.member;
    assert.equal(patched.user.username, m.username);
  });

  it('realtime: usernames only reach admin connections (and the author\'s own)', async () => {
    const o = makeUser(app, 'own');
    const w = makeUser(app, 'wri');
    const r = makeUser(app, 'rdr');
    const b = await makeBoard(o, { title: 'sse names', linkAccess: 'write' });
    const open = [];
    try {
      const [sOwner, sW, sR] = [await openSse(app, b.slug, o), await openSse(app, b.slug, w), await openSse(app, b.slug, r)];
      open.push(sOwner, sW, sR);
      const p = await makePost(w, b, { title: 'live' });
      assert.equal((await sOwner.waitFor('post.created', (d) => d.post.id === p.id)).data.post.author.username, w.username);
      assert.equal((await sW.waitFor('post.created', (d) => d.post.id === p.id)).data.post.author.username, w.username, 'the author sees their own');
      assert.equal((await sR.waitFor('post.created', (d) => d.post.id === p.id)).data.post.author.username, null);
      assert.equal((await sR.waitFor('post.created', (d) => d.post.id === p.id)).data.post.author.displayName, w.displayName);
      await o.patch(`/api/boards/${b.slug}`, { title: 'renamed' });
      assert.equal((await sOwner.waitFor('board.updated')).data.board.owner.username, o.username);
      assert.equal((await sR.waitFor('board.updated')).data.board.owner.username, null);
      const people = JSON.stringify(sR.events.filter((e) => /^(post|comment|board)\./.test(e.type)));
      assert.ok(!people.includes('"username":"'), 'no login name in any event this reader received');
    } finally { for (const s of open) s.close?.(); }
  });
});

describe('M8: on approval boards a content edit by someone below moderate sends the post back to review', () => {
  let app;
  let o; let w; let w2; let mod; let b;
  let so; let sw; let sw2; let sm; let sanon;
  const open = [];
  const count = (s, type, id) => s.events.filter((e) => e.type === type && (e.data.post?.id === id || e.data.id === id)).length;
  before(async () => {
    app = await startApp();
    o = makeUser(app, 'own'); w = makeUser(app, 'wri'); w2 = makeUser(app, 'wri2'); mod = makeUser(app, 'mod');
    b = await makeBoard(o, { title: 'approval', linkAccess: 'write', settings: { approval: true }, format: 'canvas' });
    await addMember(o, b, mod, 'moderate');
    [so, sw, sw2, sm, sanon] = [await openSse(app, b.slug, o), await openSse(app, b.slug, w), await openSse(app, b.slug, w2), await openSse(app, b.slug, mod), await openSse(app, b.slug)];
    open.push(so, sw, sw2, sm, sanon);
  });
  after(async () => { for (const s of open) s.close?.(); await app.close(); });

  async function published() {
    const p = await makePost(w, b, { title: 'v1', body: 'text' });
    assert.equal(p.status, 'pending');
    assert.equal((await mod.post(`/api/posts/${p.id}/approve`)).json.post.status, 'published');
    await sanon.waitFor('post.created', (d) => d.post.id === p.id);
    return p;
  }
  const titles = async (c) => (await snap(c, b)).posts.map((p) => p.title);

  it('title/body edits make it pending again: hidden from others, still visible to the author and moderators', async () => {
    const p = await published();
    assert.ok((await titles(w2)).includes('v1'));
    const r = await w.patch(`/api/posts/${p.id}`, { title: 'v2' });
    assert.equal(r.status, 200);
    assert.equal(r.json.post.status, 'pending');
    assert.equal(r.json.post.title, 'v2');
    for (const viewer of [w2, new Client(app)]) assert.ok(!(await titles(viewer)).includes('v2'), 'hidden like a new pending post');
    for (const viewer of [w, mod, o]) assert.ok((await titles(viewer)).includes('v2'));
    assert.equal((await w2.get(`/api/posts/${p.id}/comments`)).status, 404);
    // realtime: privileged connections get post.updated, everybody else a post.deleted — and nothing else about the edit
    for (const s of [so, sw, sm]) await s.waitFor('post.updated', (d) => d.post.id === p.id && d.post.status === 'pending');
    for (const s of [sw2, sanon]) await s.waitFor('post.deleted', (d) => d.id === p.id);
    await sleep(60);
    for (const s of [sw2, sanon]) assert.equal(count(s, 'post.updated', p.id), 0, 'the edited text never reached them');
    for (const s of [so, sw, sm]) assert.equal(count(s, 'post.deleted', p.id), 0);
    // a second edit while pending stays pending; approving publishes the latest text to everyone
    assert.equal((await w.patch(`/api/posts/${p.id}`, { body: 'text 2' })).json.post.status, 'pending');
    assert.equal((await mod.post(`/api/posts/${p.id}/approve`)).json.post.status, 'published');
    for (const s of [sw2, sanon]) {
      const ev = await s.waitFor('post.created', (d) => d.post.id === p.id && d.post.status === 'published' && d.post.title === 'v2');
      assert.equal(ev.data.post.body, 'text 2');
    }
    for (const s of [so, sw, sm]) await s.waitFor('post.updated', (d) => d.post.id === p.id && d.post.status === 'published');
  });

  it('body edits and attachment changes re-trigger; identical values, position, colour, section and reactions do not', async () => {
    const p = await published();
    const same = await w.patch(`/api/posts/${p.id}`, { title: 'v1', body: 'text' });
    assert.equal(same.json.post.status, 'published', 'nothing changed');
    assert.equal((await w.patch(`/api/posts/${p.id}`, { x: 10, y: 20, w: 300 })).json.post.status, 'published', 'canvas position');
    assert.equal((await w.patch(`/api/posts/${p.id}`, { color: 'red' })).json.post.status, 'published', 'colour');
    assert.equal((await w.post(`/api/posts/${p.id}/move`, { beforeId: null })).json.post.status, 'published', 'move');
    assert.equal((await w2.put(`/api/posts/${p.id}/reactions`, { kind: 'like' })).status, 200);
    assert.equal((await snap(w2, b)).posts.find((x) => x.id === p.id).status, 'published');
    const body = await w.patch(`/api/posts/${p.id}`, { body: 'changed' });
    assert.equal(body.json.post.status, 'pending');
    assert.equal((await mod.post(`/api/posts/${p.id}/approve`)).json.post.status, 'published');
    const att = await w.patch(`/api/posts/${p.id}`, { attachment: { kind: 'link', url: 'https://example.org/page' } });
    assert.equal(att.json.post.status, 'pending');
    assert.equal((await mod.post(`/api/posts/${p.id}/approve`)).json.post.status, 'published');
    const sameAtt = await w.patch(`/api/posts/${p.id}`, { attachment: { kind: 'link', url: 'https://example.org/page' } });
    assert.equal(sameAtt.json.post.status, 'published', 'same attachment again is not a change');
    const rm = await w.patch(`/api/posts/${p.id}`, { attachment: null });
    assert.equal(rm.json.post.status, 'pending', 'removing the attachment is a content change');
  });

  it('moderators and the owner edit freely; approval=false boards never re-review; non-approval status is untouched', async () => {
    const p = await published();
    assert.equal((await mod.patch(`/api/posts/${p.id}`, { title: 'mod edit' })).json.post.status, 'published');
    assert.equal((await o.patch(`/api/posts/${p.id}`, { body: 'owner edit' })).json.post.status, 'published');
    const own = await makePost(mod, b, { title: 'mod own' });
    assert.equal(own.status, 'published');
    assert.equal((await mod.patch(`/api/posts/${own.id}`, { title: 'again' })).json.post.status, 'published');
    // turning approval off: edits by writers stay published
    const p2 = await published();
    await o.patch(`/api/boards/${b.slug}`, { settings: { approval: false } });
    assert.equal((await w.patch(`/api/posts/${p2.id}`, { title: 'free edit' })).json.post.status, 'published');
    await o.patch(`/api/boards/${b.slug}`, { settings: { approval: true } });
  });
});

describe('M9: members can leave; lookups are rate limited', () => {
  let app;
  before(async () => { app = await startApp({ config: { memberRateMax: 6 } }); });
  after(async () => { await app.close(); });

  it('every member role may remove itself; the board stays reachable only as far as the link allows', async () => {
    for (const role of ['read', 'comment', 'write', 'moderate', 'admin']) {
      const o = makeUser(app, 'own');
      const m = makeUser(app, `m${role}`);
      const pub = await makeBoard(o, { title: 'pub', linkAccess: 'read' });
      const priv = await makeBoard(o, { title: 'priv', visibility: 'private' });
      await addMember(o, pub, m, role);
      await addMember(o, priv, m, role);
      assert.ok((await m.get('/api/boards')).json.boards.some((x) => x.slug === priv.slug));
      const left = await m.del(`/api/boards/${priv.slug}/members/${m.id}`);
      assert.equal(left.status, 200, role);
      assert.deepEqual(left.json, { ok: true });
      assert.equal((await m.get(`/api/boards/${priv.slug}`)).status, 404, 'private: gone');
      assert.ok(!(await m.get('/api/boards')).json.boards.some((x) => x.slug === priv.slug));
      assert.equal((await m.del(`/api/boards/${pub.slug}/members/${m.id}`)).status, 200);
      const after = await snap(m, pub);
      assert.equal(after.role, 'read', 'public: back to the link role');
      assert.equal((await o.get(`/api/boards/${pub.slug}/members`)).json.members.length, 1, 'only the owner is left');
      assert.equal((await m.del(`/api/boards/${pub.slug}/members/${m.id}`)).status, 404, 'no membership any more');
    }
  });

  it('leaving ends the member\'s stream on a private board and announces members.updated', async () => {
    const o = makeUser(app, 'own');
    const m = makeUser(app, 'mem');
    const b = await makeBoard(o, { title: 'priv', visibility: 'private' });
    await addMember(o, b, m, 'write');
    const so = await openSse(app, b.slug, o);
    const sm = await openSse(app, b.slug, m);
    try {
      await m.del(`/api/boards/${b.slug}/members/${m.id}`);
      await so.waitFor('members.updated');
      await sm.waitFor('members.updated');
      await sm.waitClosed();
      assert.equal(so.closed, false);
    } finally { so.close(); sm.close(); }
  });

  it('the owner cannot leave (409 owner_cannot_leave); non-admins still cannot remove others; strangers and anonymous get 404/401', async () => {
    const o = makeUser(app, 'own');
    const m = makeUser(app, 'mem');
    const m2 = makeUser(app, 'mem2');
    const stranger = makeUser(app, 'str');
    const b = await makeBoard(o, { title: 'b', linkAccess: 'comment' });
    await addMember(o, b, m, 'write');
    await addMember(o, b, m2, 'moderate');
    const r = await o.del(`/api/boards/${b.slug}/members/${o.id}`);
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'owner_cannot_leave');
    assert.match(r.json.error.message, /[가-힣]/);
    assert.equal((await snap(o, b)).isOwner, true);
    for (const who of [m, m2]) {
      const rr = await who.del(`/api/boards/${b.slug}/members/${who === m ? m2.id : m.id}`);
      assert.equal(rr.status, 403, 'only admins remove other people');
      assert.equal(rr.json.error.code, 'forbidden');
    }
    assert.equal((await m.del(`/api/boards/${b.slug}/members/${o.id}`)).status, 403, 'nobody removes the owner');
    assert.equal((await stranger.del(`/api/boards/${b.slug}/members/${stranger.id}`)).status, 404, 'not a member');
    assert.equal((await new Client(app).del(`/api/boards/${b.slug}/members/${m.id}`)).status, 401);
    const priv = await makeBoard(o, { title: 'p', visibility: 'private' });
    assert.equal((await stranger.del(`/api/boards/${priv.slug}/members/${stranger.id}`)).status, 404);
    assert.equal((await o.del(`/api/boards/${b.slug}/members/${m.id}`)).status, 200, 'admins still remove members');
  });

  it('adding members (= username lookup) is limited per user: 429 rate_limited; the answers themselves are unchanged for admins', async () => {
    const o = makeUser(app, 'own');
    const b = await makeBoard(o, { title: 'b' });
    const m = makeUser(app, 'mem');
    assert.equal((await o.post(`/api/boards/${b.slug}/members`, { username: 'nobody_here', role: 'read' })).json.error.code, 'user_not_found');
    assert.equal((await o.post(`/api/boards/${b.slug}/members`, { username: m.username, role: 'read' })).status, 201);
    assert.equal((await o.post(`/api/boards/${b.slug}/members`, { username: m.username, role: 'read' })).json.error.code, 'already_member');
    assert.equal((await o.post(`/api/boards/${b.slug}/members`, { username: o.username, role: 'read' })).json.error.code, 'already_owner');
    for (let i = 0; i < 2; i++) assert.equal((await o.post(`/api/boards/${b.slug}/members`, { username: `guess_${i}_x`, role: 'read' })).status, 404);
    const r = await o.post(`/api/boards/${b.slug}/members`, { username: 'guess_more', role: 'read' });
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'rate_limited');
    assert.ok(r.headers.get('retry-after'));
    assert.equal((await makeUser(app, 'p').post(`/api/boards/${b.slug}/members`, { username: 'x', role: 'read' })).status, 403, 'non-admins learn nothing');
    const o2 = makeUser(app, 'own2');
    const b2 = await makeBoard(o2, { title: 'b2' });
    assert.equal((await o2.post(`/api/boards/${b2.slug}/members`, { username: 'nobody_here', role: 'read' })).status, 404, 'budgets are per user');
  });
});

describe('L2: permissions are re-checked after the awaits of a post request', () => {
  const gate = () => {
    let release;
    const p = new Promise((r) => { release = r; });
    return { wait: p, release };
  };

  it('a member removed while the link preview was loading cannot save the post (403; 404 on a private board)', async () => {
    const g = gate();
    const app = await startApp({ previewFetcher: async () => { await g.wait; return html('Slow'); } });
    try {
      const o = makeUser(app, 'o');
      const m = makeUser(app, 'm');
      const pub = await makeBoard(o, { title: 'pub', linkAccess: 'read' });
      const priv = await makeBoard(o, { title: 'priv', visibility: 'private' });
      await addMember(o, pub, m, 'write');
      await addMember(o, priv, m, 'write');
      const link = (slug, n) => m.post(`/api/boards/${slug}/posts`, { title: 'hello', attachment: { kind: 'link', url: `https://slow.example/${n}` } });
      const a = link(pub.slug, 1);
      const b = link(priv.slug, 2);
      await sleep(100);
      await o.del(`/api/boards/${pub.slug}/members/${m.id}`);
      await o.del(`/api/boards/${priv.slug}/members/${m.id}`);
      g.release();
      assert.equal((await a).status, 403);
      assert.equal((await b).status, 404);
      assert.equal(app.db.get('SELECT COUNT(*) AS n FROM posts').n, 0, 'nothing was saved');
    } finally { g.release(); await app.close(); }
  });

  it('a board deleted while the link preview was loading answers 404 (not 500)', async () => {
    const g = gate();
    const app = await startApp({ previewFetcher: async () => { await g.wait; return html('Slow'); } });
    try {
      const o = makeUser(app, 'o');
      const b = await makeBoard(o, { title: 'doomed' });
      const pending = o.post(`/api/boards/${b.slug}/posts`, { attachment: { kind: 'link', url: 'https://slow.example/x' } });
      await sleep(100);
      assert.equal((await o.del(`/api/boards/${b.slug}`)).status, 200);
      g.release();
      const r = await pending;
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, 'not_found');
    } finally { g.release(); await app.close(); }
  });

  it('the same for PATCH: post deleted, role lowered or session revoked while the preview loaded', async () => {
    const g = gate();
    const app = await startApp({ previewFetcher: async () => { await g.wait; return html('Slow'); } });
    try {
      const o = makeUser(app, 'o');
      const m = makeUser(app, 'm');
      const b = await makeBoard(o, { title: 'b', linkAccess: 'read' });
      await addMember(o, b, m, 'write');
      const mk = () => makePost(m, b, { title: 'orig' });
      const [p1, p2, p3] = [await mk(), await mk(), await mk()];
      const patch = (p) => m.patch(`/api/posts/${p.id}`, { title: 'changed', attachment: { kind: 'link', url: `https://slow.example/${p.id}` } });
      const [r1, r2, r3] = [patch(p1), patch(p2), patch(p3)];
      await sleep(100);
      await o.del(`/api/posts/${p1.id}`);
      await o.patch(`/api/boards/${b.slug}/members/${m.id}`, { role: 'read' });
      app.db.run('DELETE FROM sessions WHERE user_id = ?', m.id);
      g.release();
      const out = [await r1, await r2, await r3];
      assert.equal(out[0].status, 404, 'post gone');
      assert.ok([401, 403].includes(out[1].status), `p2 -> ${out[1].status}`);
      assert.ok([401, 403].includes(out[2].status), `p3 -> ${out[2].status}`);
      assert.deepEqual(app.db.all('SELECT title FROM posts ORDER BY id').map((r) => r.title), ['orig', 'orig'], 'nothing was changed');
    } finally { g.release(); await app.close(); }
  });
});

describe('L3 / L4: no existence oracles', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  it('move: a beforeId that is someone else\'s pending post answers exactly like one that does not exist', async () => {
    const o = makeUser(app, 'own');
    const w = makeUser(app, 'wri');
    const w2 = makeUser(app, 'wri2');
    const mod = makeUser(app, 'mod');
    const b = await makeBoard(o, { title: 'b', linkAccess: 'write', settings: { approval: true, newPostPosition: 'bottom' } });
    await addMember(o, b, mod, 'moderate');
    const q1 = await makePost(o, b, { title: 'q1' });
    const hidden = await makePost(w, b, { title: 'pending of w' });
    const mine = await makePost(w2, b, { title: 'pending of w2' });
    assert.equal(hidden.status, 'pending');
    const probe = (id) => w2.post(`/api/posts/${mine.id}/move`, { beforeId: id });
    const [h, none] = [await probe(hidden.id), await probe(987654)];
    assert.equal(h.status, 400);
    assert.deepEqual(h.json, none.json);
    assert.equal((await probe(q1.id)).status, 200, 'visible neighbours work');
    assert.equal((await w.post(`/api/posts/${hidden.id}/move`, { beforeId: q1.id })).status, 200);
    assert.equal((await w.post(`/api/posts/${q1.id}/move`, { beforeId: hidden.id })).status, 403, 'not their post');
    assert.equal((await mod.post(`/api/posts/${q1.id}/move`, { beforeId: hidden.id })).status, 200, 'moderators see pending posts');
    // the author may also anchor on their own pending post
    const own2 = await makePost(w, b, { title: 'second pending of w' });
    assert.equal((await w.post(`/api/posts/${own2.id}/move`, { beforeId: hidden.id })).status, 200);
  });

  it('DELETE /comments/:id: a comment in a board you cannot see answers exactly like a missing one', async () => {
    const o = makeUser(app, 'own');
    const stranger = makeUser(app, 'str');
    const priv = await makeBoard(o, { title: 'p', visibility: 'private' });
    const post = await makePost(o, priv, { title: 'secret' });
    const cid = app.db.run('INSERT INTO comments (post_id, author_id, body, created_at) VALUES (?,?,?,?)', post.id, o.id, 'hidden', Date.now()).id;
    const pubBoard = await makeBoard(o, { title: 'pending board', linkAccess: 'write', settings: { approval: true } });
    const w = makeUser(app, 'w');
    const pend = await makePost(w, pubBoard, { title: 'pending' });
    const pcid = app.db.run('INSERT INTO comments (post_id, author_id, body, created_at) VALUES (?,?,?,?)', pend.id, w.id, 'hidden too', Date.now()).id;
    for (const who of [stranger, new Client(app)]) {
      const missing = await who.del('/api/comments/987654');
      const hiddenPrivate = await who.del(`/api/comments/${cid}`);
      assert.equal(missing.status, 404);
      assert.deepEqual(hiddenPrivate.json, missing.json);
      assert.equal(hiddenPrivate.status, 404);
    }
    const other = makeUser(app, 'other');
    const hiddenPending = await other.del(`/api/comments/${pcid}`);
    assert.equal(hiddenPending.status, 404);
    assert.deepEqual(hiddenPending.json, (await other.del('/api/comments/987654')).json);
    assert.equal((await o.del(`/api/comments/${cid}`)).status, 200, 'authorised users still delete');
  });
});
