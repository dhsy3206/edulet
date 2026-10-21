import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, addMember, makeBoard, makePost, makeUser, startApp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const ROLES = ['read', 'comment', 'write', 'moderate', 'admin'];
const idx = (r) => ROLES.indexOf(r);

function insertPost(boardId, authorId, { status = 'published', sectionId = null, title = 'db post' } = {}) {
  const t = Date.now();
  const rank = (app.db.get('SELECT MAX(rank) AS m FROM posts WHERE board_id = ?', boardId).m ?? 0) + 1;
  return app.db.run(
    `INSERT INTO posts (board_id, section_id, author_id, title, body, status, rank, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    boardId, sectionId, authorId, title, '', status, rank, t, t,
  ).id;
}
function insertComment(postId, authorId) {
  return app.db.run('INSERT INTO comments (post_id, author_id, body, created_at) VALUES (?,?,?,?)', postId, authorId, 'db comment', Date.now()).id;
}

/** A board owned by `o`, `actor` is a member with `role`; fresh posts/comments/sections for every probe. */
async function fixture(role, { linkAccess = 'read', settings = { reactions: 'like' } } = {}) {
  const o = makeUser(app, 'own');
  const actor = makeUser(app, `act${role}`);
  const board = await makeBoard(o, { template: 'kwl', linkAccess, settings });
  await addMember(o, board, actor, role);
  const secs = (await o.get(`/api/boards/${board.slug}`)).json.sections;
  return {
    o, actor, board, secs,
    otherPost: () => insertPost(board.id, o.id, { sectionId: secs[0].id }),
    ownPost: () => insertPost(board.id, actor.id, { sectionId: secs[0].id }),
    pendingPost: () => insertPost(board.id, actor.id, { status: 'pending', sectionId: secs[0].id }), // the actor may see it as its author
    otherComment: (pid) => insertComment(pid, o.id),
    ownComment: (pid) => insertComment(pid, actor.id),
  };
}

// action -> [minimal role that may do it, probe(f) => response]
const ACTIONS = {
  'view board': ['read', (f) => f.actor.get(`/api/boards/${f.board.slug}`)],
  'export': ['read', (f) => f.actor.get(`/api/boards/${f.board.slug}/export?format=json`)],
  'list comments': ['read', (f) => f.actor.get(`/api/posts/${f.otherPost()}/comments`)],
  'comment': ['comment', (f) => f.actor.post(`/api/posts/${f.otherPost()}/comments`, { body: 'hi' })],
  'react': ['comment', (f) => f.actor.put(`/api/posts/${f.otherPost()}/reactions`, { kind: 'like' })],
  'create post': ['write', (f) => f.actor.post(`/api/boards/${f.board.slug}/posts`, { title: 't' })],
  'edit own post': ['write', (f) => f.actor.patch(`/api/posts/${f.ownPost()}`, { title: 'x' })],
  'delete own post': ['write', (f) => f.actor.del(`/api/posts/${f.ownPost()}`)],
  'move own post': ['write', (f) => f.actor.post(`/api/posts/${f.ownPost()}/move`, { beforeId: null })],
  'upload': ['write', (f) => f.actor.put(`/api/uploads?board=${f.board.slug}&name=a.txt`, Buffer.from('x'), { raw: true, headers: { 'content-type': 'text/plain' } })],
  "edit someone else's post": ['moderate', (f) => f.actor.patch(`/api/posts/${f.otherPost()}`, { title: 'x' })],
  "delete someone else's post": ['moderate', (f) => f.actor.del(`/api/posts/${f.otherPost()}`)],
  "move someone else's post": ['moderate', (f) => f.actor.post(`/api/posts/${f.otherPost()}/move`, { beforeId: null })],
  'pin': ['moderate', (f) => f.actor.patch(`/api/posts/${f.otherPost()}`, { pinned: true })],
  'pin own post': ['moderate', (f) => f.actor.patch(`/api/posts/${f.ownPost()}`, { pinned: true })],
  'approve': ['moderate', (f) => f.actor.post(`/api/posts/${f.pendingPost()}/approve`)],
  "delete someone else's comment": ['moderate', (f) => f.actor.del(`/api/comments/${f.otherComment(f.otherPost())}`)],
  'create section': ['moderate', (f) => f.actor.post(`/api/boards/${f.board.slug}/sections`, { title: 'new' })],
  'rename section': ['moderate', (f) => f.actor.patch(`/api/sections/${f.secs[0].id}`, { title: 'renamed' })],
  'move section': ['moderate', (f) => f.actor.post(`/api/sections/${f.secs[0].id}/move`, { beforeId: null })],
  'delete section': ['moderate', (f) => f.actor.del(`/api/sections/${f.secs[2].id}`)],
  'change board settings': ['admin', (f) => f.actor.patch(`/api/boards/${f.board.slug}`, { title: 'new title' })],
  'list members': ['admin', (f) => f.actor.get(`/api/boards/${f.board.slug}/members`)],
  'add member': ['admin', (f) => f.actor.post(`/api/boards/${f.board.slug}/members`, { username: makeUser(app, 'cand').username, role: 'read' })],
};

describe('permission matrix (member roles)', () => {
  for (const role of ROLES) {
    it(`role ${role}`, async () => {
      for (const [name, [min, probe]] of Object.entries(ACTIONS)) {
        const f = await fixture(role);
        const r = await probe(f);
        const allowed = idx(role) >= idx(min);
        if (allowed) assert.ok(r.status === 200 || r.status === 201, `${role} should be allowed to "${name}" but got ${r.status} ${r.text}`);
        else {
          assert.equal(r.status, 403, `${role} must not "${name}" (got ${r.status} ${r.text})`);
          assert.equal(r.json.error.code, 'forbidden');
        }
      }
    });
  }

  it('own comments can always be deleted by their author; others need moderate', async () => {
    for (const role of ['comment', 'write', 'moderate']) {
      const f = await fixture(role);
      const p = f.otherPost();
      const own = f.ownComment(p);
      const r = await f.actor.del(`/api/comments/${own}`);
      assert.equal(r.status, 200, role);
      assert.equal(typeof r.json.commentCount, 'number');
    }
    const f = await fixture('write');
    const p = f.otherPost();
    assert.equal((await f.actor.del(`/api/comments/${f.otherComment(p)}`)).status, 403);
  });

  it('the owner is admin; non-owner admin can manage but is not owner', async () => {
    const f = await fixture('admin');
    const snap = (await f.o.get(`/api/boards/${f.board.slug}`)).json;
    assert.deepEqual([snap.role, snap.isOwner], ['admin', true]);
    const mine = (await f.actor.get(`/api/boards/${f.board.slug}`)).json;
    assert.deepEqual([mine.role, mine.isOwner], ['admin', false]);
    assert.ok(mine.members.length >= 2, 'admins receive the members list');
    assert.equal((await f.actor.del(`/api/boards/${f.board.slug}`)).status, 403);
  });
});

describe('anonymous visitors', () => {
  it('read-link board: reading works, every write is 401', async () => {
    const f = await fixture('read', { linkAccess: 'read' });
    const anon = new Client(app);
    const pid = f.otherPost();
    const cid = f.otherComment(pid);
    const pending = f.pendingPost();
    assert.equal((await anon.get(`/api/boards/${f.board.slug}`)).status, 200);
    assert.equal((await anon.get(`/api/boards/${f.board.slug}/export?format=csv`)).status, 200);
    assert.equal((await anon.get(`/api/posts/${pid}/comments`)).status, 200);
    const writes = [
      anon.post(`/api/boards/${f.board.slug}/posts`, { title: 'x' }),
      anon.patch(`/api/posts/${pid}`, { title: 'x' }),
      anon.del(`/api/posts/${pid}`),
      anon.post(`/api/posts/${pid}/move`, { beforeId: null }),
      anon.post(`/api/posts/${pid}/approve`),
      anon.post(`/api/posts/${pid}/comments`, { body: 'x' }),
      anon.del(`/api/comments/${cid}`),
      anon.put(`/api/posts/${pid}/reactions`, { kind: 'like' }),
      anon.post(`/api/boards/${f.board.slug}/sections`, { title: 'x' }),
      anon.patch(`/api/sections/${f.secs[0].id}`, { title: 'x' }),
      anon.post(`/api/sections/${f.secs[0].id}/move`, { beforeId: null }),
      anon.del(`/api/sections/${f.secs[0].id}`),
      anon.patch(`/api/boards/${f.board.slug}`, { title: 'x' }),
      anon.del(`/api/boards/${f.board.slug}`),
      anon.get(`/api/boards/${f.board.slug}/members`),
      anon.post(`/api/boards/${f.board.slug}/members`, { username: 'x', role: 'read' }),
      anon.post(`/api/boards/${f.board.slug}/duplicate`, {}),
      anon.put(`/api/uploads?board=${f.board.slug}&name=a.txt`, Buffer.from('x'), { raw: true, headers: { 'content-type': 'text/plain' } }),
      anon.post('/api/link-preview', { url: 'https://example.com' }),
      anon.get('/api/boards'),
    ];
    for (const r of await Promise.all(writes)) assert.equal(r.status, 401, r.text);
    assert.equal((await anon.get(`/api/posts/${pending}/comments`)).status, 404, 'pending is invisible to anonymous readers');
  });

  it('an anonymous visitor never writes, even when the link grants write or moderate', async () => {
    for (const linkAccess of ['write', 'moderate']) {
      const f = await fixture('read', { linkAccess });
      const anon = new Client(app);
      const pid = f.otherPost();
      const snap = await anon.get(`/api/boards/${f.board.slug}`);
      assert.equal(snap.json.role, linkAccess);
      assert.equal((await anon.post(`/api/boards/${f.board.slug}/posts`, { title: 'x' })).status, 401);
      assert.equal((await anon.patch(`/api/posts/${pid}`, { title: 'x' })).status, 401);
      assert.equal((await anon.del(`/api/posts/${pid}`)).status, 401);
      assert.equal((await anon.post(`/api/posts/${f.pendingPost()}/approve`)).status, linkAccess === 'moderate' ? 401 : 404, 'pending is hidden below moderate');
      assert.equal((await anon.del(`/api/comments/${f.otherComment(pid)}`)).status, 401);
      assert.equal((await anon.post(`/api/boards/${f.board.slug}/sections`, { title: 'x' })).status, 401);
    }
  });

  it('a guest on a write-link board can post; on a comment-link board cannot', async () => {
    const f1 = await fixture('read', { linkAccess: 'write' });
    const g = new Client(app);
    await g.guest('게스트');
    const r = await g.post(`/api/boards/${f1.board.slug}/posts`, { title: '게스트 글' });
    assert.equal(r.status, 201);
    assert.equal(r.json.post.author.isGuest, true);
    const f2 = await fixture('read', { linkAccess: 'comment' });
    assert.equal((await g.post(`/api/boards/${f2.board.slug}/posts`, { title: 'x' })).status, 403);
    assert.equal((await g.post(`/api/posts/${f2.otherPost()}/comments`, { body: 'ok' })).status, 201);
  });

  it('private board: everything is 404 for anonymous visitors and non-members', async () => {
    const f = await fixture('read');
    await f.o.patch(`/api/boards/${f.board.slug}`, { visibility: 'private' });
    const pid = f.otherPost();
    const cid = f.otherComment(pid);
    const stranger = makeUser(app, 'stranger');
    for (const who of [new Client(app), stranger]) {
      const calls = [
        who.get(`/api/boards/${f.board.slug}`),
        who.get(`/api/boards/${f.board.slug}/events`),
        who.get(`/api/boards/${f.board.slug}/export?format=json`),
        who.get(`/api/boards/${f.board.slug}/members`),
        who.post(`/api/boards/${f.board.slug}/posts`, { title: 'x' }),
        who.post(`/api/boards/${f.board.slug}/sections`, { title: 'x' }),
        who.post(`/api/boards/${f.board.slug}/duplicate`, {}),
        who.patch(`/api/boards/${f.board.slug}`, { title: 'x' }),
        who.del(`/api/boards/${f.board.slug}`),
        who.get(`/api/posts/${pid}/comments`),
        who.post(`/api/posts/${pid}/comments`, { body: 'x' }),
        who.put(`/api/posts/${pid}/reactions`, { kind: 'like' }),
        who.patch(`/api/posts/${pid}`, { title: 'x' }),
        who.del(`/api/posts/${pid}`),
        who.post(`/api/posts/${pid}/move`, { beforeId: null }),
        who.del(`/api/comments/${cid}`),
        who.patch(`/api/sections/${f.secs[0].id}`, { title: 'x' }),
        who.put(`/api/uploads?board=${f.board.slug}&name=a.txt`, Buffer.from('x'), { raw: true, headers: { 'content-type': 'text/plain' } }),
      ];
      for (const r of await Promise.all(calls)) {
        assert.equal(r.status, 404, `${r.text}`);
        assert.equal(r.json.error.code, 'not_found');
      }
    }
    // a private board is indistinguishable from a missing one
    const missing = await stranger.get('/api/boards/doesnotexist');
    const hidden = await stranger.get(`/api/boards/${f.board.slug}`);
    assert.deepEqual(hidden.json, missing.json);
    // members still get in
    assert.equal((await f.actor.get(`/api/boards/${f.board.slug}`)).status, 200);
    assert.equal((await f.o.get(`/api/boards/${f.board.slug}`)).status, 200);
  });

  it('logged-in non-member on a read-only link board: 403 (not 404, not 401)', async () => {
    const f = await fixture('read', { linkAccess: 'read' });
    const u = makeUser(app, 'plainuser');
    assert.equal((await u.post(`/api/boards/${f.board.slug}/posts`, { title: 'x' })).status, 403);
    assert.equal((await u.put(`/api/posts/${f.otherPost()}/reactions`, { kind: 'like' })).status, 403);
  });
});

describe('role resolution', () => {
  it('owner > member row > link access (a member row overrides the link role literally)', async () => {
    const o = makeUser(app, 'own');
    const m = makeUser(app, 'memb');
    const outsider = makeUser(app, 'outs');
    const board = await makeBoard(o, { linkAccess: 'write' });
    assert.equal((await outsider.get(`/api/boards/${board.slug}`)).json.role, 'write');
    await addMember(o, board, m, 'read');
    assert.equal((await m.get(`/api/boards/${board.slug}`)).json.role, 'read');
    assert.equal((await m.post(`/api/boards/${board.slug}/posts`, { title: 'x' })).status, 403);
    assert.equal((await outsider.post(`/api/boards/${board.slug}/posts`, { title: 'x' })).status, 201);
    await o.patch(`/api/boards/${board.slug}`, { linkAccess: 'read' });
    assert.equal((await outsider.post(`/api/boards/${board.slug}/posts`, { title: 'y' })).status, 403);
    // owner is always admin, even when the link role is lower
    assert.equal((await o.get(`/api/boards/${board.slug}`)).json.role, 'admin');
  });
});

describe('approval flow (pending posts)', () => {
  async function approvalBoard() {
    const o = makeUser(app, 'own');
    const w = makeUser(app, 'wri');
    const w2 = makeUser(app, 'wri2');
    const mod = makeUser(app, 'mod');
    const board = await makeBoard(o, { linkAccess: 'write', settings: { approval: true } });
    await addMember(o, board, mod, 'moderate');
    return { o, w, w2, mod, board };
  }

  it('writers create pending posts; moderators and the owner publish directly', async () => {
    const { o, w, mod, board } = await approvalBoard();
    const mine = await makePost(w, board, { title: 'w' });
    assert.equal(mine.status, 'pending');
    assert.equal((await makePost(mod, board, { title: 'm' })).status, 'published');
    assert.equal((await makePost(o, board, { title: 'o' })).status, 'published');
    // approval off: writers publish directly
    await o.patch(`/api/boards/${board.slug}`, { settings: { approval: false } });
    assert.equal((await makePost(w, board, { title: 'w2' })).status, 'published');
  });

  it('visibility: only moderators, the owner and the author see pending posts', async () => {
    const { o, w, w2, mod, board } = await approvalBoard();
    const p = await makePost(w, board, { title: '대기 글' });
    const titles = async (c) => (await c.get(`/api/boards/${board.slug}`)).json.posts.map((x) => x.title);
    assert.deepEqual(await titles(w), ['대기 글']);
    assert.deepEqual(await titles(mod), ['대기 글']);
    assert.deepEqual(await titles(o), ['대기 글']);
    assert.deepEqual(await titles(w2), []);
    assert.deepEqual(await titles(new Client(app)), []);
    // direct access is hidden as well
    assert.equal((await w2.get(`/api/posts/${p.id}/comments`)).status, 404);
    assert.equal((await w2.post(`/api/posts/${p.id}/comments`, { body: 'x' })).status, 404);
    assert.equal((await w2.put(`/api/posts/${p.id}/reactions`, { kind: 'like' })).status, 404);
    assert.equal((await w2.patch(`/api/posts/${p.id}`, { title: 'hax' })).status, 404);
    assert.equal((await w2.del(`/api/posts/${p.id}`)).status, 404);
    assert.equal((await new Client(app).get(`/api/posts/${p.id}/comments`)).status, 404);
    // export respects it too
    const exp = async (c) => (await c.get(`/api/boards/${board.slug}/export?format=json`)).json.posts.length;
    assert.deepEqual([await exp(w2), await exp(w), await exp(mod)], [0, 1, 1]);
    // dashboard counters only count published posts
    assert.equal((await o.get('/api/boards')).json.boards.find((b) => b.slug === board.slug).postCount, 0);
  });

  it('approve: moderators only, idempotent, then everyone sees it', async () => {
    const { o, w, w2, mod, board } = await approvalBoard();
    const p = await makePost(w, board, { title: '승인 대상' });
    assert.equal((await w.post(`/api/posts/${p.id}/approve`)).status, 403, 'authors cannot approve themselves');
    assert.equal((await w2.post(`/api/posts/${p.id}/approve`)).status, 404, 'invisible to other writers');
    const r = await mod.post(`/api/posts/${p.id}/approve`);
    assert.equal(r.status, 200);
    assert.equal(r.json.post.status, 'published');
    assert.equal((await mod.post(`/api/posts/${p.id}/approve`)).json.post.status, 'published');
    assert.deepEqual((await w2.get(`/api/boards/${board.slug}`)).json.posts.map((x) => x.title), ['승인 대상']);
    assert.deepEqual((await new Client(app).get(`/api/boards/${board.slug}`)).json.posts.map((x) => x.title), ['승인 대상']);
    assert.equal((await o.get('/api/boards')).json.boards.find((b) => b.slug === board.slug).postCount, 1);
  });

  it('authors can edit and delete their own pending post', async () => {
    const { w, board } = await approvalBoard();
    const p = await makePost(w, board, { title: 'before' });
    const r = await w.patch(`/api/posts/${p.id}`, { title: 'after' });
    assert.equal(r.status, 200);
    assert.equal(r.json.post.status, 'pending');
    assert.equal((await w.del(`/api/posts/${p.id}`)).status, 200);
  });

  it('moderators can comment on a pending post; the author sees the comment', async () => {
    const { w, mod, board } = await approvalBoard();
    const p = await makePost(w, board, { title: 'q' });
    const c = await mod.post(`/api/posts/${p.id}/comments`, { body: '수정해 주세요' });
    assert.equal(c.status, 201);
    assert.equal((await w.get(`/api/posts/${p.id}/comments`)).json.comments[0].body, '수정해 주세요');
  });
});
