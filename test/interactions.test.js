import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, addMember, makeBoard, makePost, makeUser, startApp } from './helpers.js';

let app;
let owner;
before(async () => { app = await startApp(); owner = makeUser(app, 'owner'); });
after(async () => { await app.close(); });

describe('comments', () => {
  it('create / list (oldest first) / commentCount / author JSON', async () => {
    const b = await makeBoard(owner, { title: '댓글' });
    const p = await makePost(owner, b);
    const u = makeUser(app, 'cm');
    const c1 = await u.post(`/api/posts/${p.id}/comments`, { body: '  첫 댓글  ' });
    assert.equal(c1.status, 201);
    assert.equal(c1.json.comment.body, '첫 댓글');
    assert.equal(c1.json.comment.postId, p.id);
    assert.equal(c1.json.comment.author.id, u.id);
    assert.equal(c1.json.commentCount, 1);
    assert.equal(typeof c1.json.comment.createdAt, 'number');
    const c2 = await owner.post(`/api/posts/${p.id}/comments`, { body: '둘째\n줄바꿈' });
    assert.equal(c2.json.commentCount, 2);
    const list = (await new Client(app).get(`/api/posts/${p.id}/comments`)).json.comments;
    assert.deepEqual(list.map((c) => c.body), ['첫 댓글', '둘째\n줄바꿈']);
    const snap = (await owner.get(`/api/boards/${b.slug}`)).json;
    assert.equal(snap.posts[0].commentCount, 2);
    assert.equal((await owner.get('/api/posts/999999/comments')).status, 404);
  });

  it('validation: empty, too long', async () => {
    const b = await makeBoard(owner, { title: '댓글2' });
    const p = await makePost(owner, b);
    const r = await owner.post(`/api/posts/${p.id}/comments`, { body: '   ' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'empty_comment');
    assert.equal((await owner.post(`/api/posts/${p.id}/comments`, {})).status, 400);
    assert.equal((await owner.post(`/api/posts/${p.id}/comments`, { body: 'x'.repeat(2001) })).status, 400);
    assert.equal((await owner.post(`/api/posts/${p.id}/comments`, { body: 'x'.repeat(2000) })).status, 201);
  });

  it('settings.comments=off blocks writing (403 comments_disabled) but keeps old comments readable', async () => {
    const b = await makeBoard(owner, { title: '댓글3' });
    const p = await makePost(owner, b);
    await owner.post(`/api/posts/${p.id}/comments`, { body: '남아 있는 댓글' });
    await owner.patch(`/api/boards/${b.slug}`, { settings: { comments: 'off' } });
    const r = await owner.post(`/api/posts/${p.id}/comments`, { body: 'x' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'comments_disabled');
    assert.equal((await owner.get(`/api/posts/${p.id}/comments`)).json.comments.length, 1);
  });

  it('delete: own or moderator; returns the new commentCount', async () => {
    const b = await makeBoard(owner, { title: '댓글4' });
    const p = await makePost(owner, b);
    const a = makeUser(app, 'ca');
    const bb = makeUser(app, 'cb');
    const ca = (await a.post(`/api/posts/${p.id}/comments`, { body: 'a' })).json.comment;
    const cb = (await bb.post(`/api/posts/${p.id}/comments`, { body: 'b' })).json.comment;
    assert.equal((await bb.del(`/api/comments/${ca.id}`)).status, 403);
    const own = await a.del(`/api/comments/${ca.id}`);
    assert.deepEqual(own.json, { commentCount: 1 });
    const mod = await owner.del(`/api/comments/${cb.id}`);
    assert.deepEqual(mod.json, { commentCount: 0 });
    assert.equal((await owner.del(`/api/comments/${cb.id}`)).status, 404);
    assert.equal((await owner.del('/api/comments/abc')).status, 404);
  });
});

describe('reactions', () => {
  const boardWith = async (reactions) => {
    const b = await makeBoard(owner, { title: `반응 ${reactions}`, settings: { reactions } });
    const p = await makePost(owner, b);
    return { b, p };
  };
  const react = (c, p, body) => c.put(`/api/posts/${p.id}/reactions`, body);

  it('like toggles; count and mine are per viewer', async () => {
    const { b, p } = await boardWith('like');
    const u = makeUser(app, 'liker');
    let r = await react(u, p, { kind: 'like' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.reactions.like, { count: 1, mine: true });
    r = await react(owner, p, { kind: 'like' });
    assert.deepEqual(r.json.reactions.like, { count: 2, mine: true });
    const snapU = (await u.get(`/api/boards/${b.slug}`)).json.posts[0];
    assert.deepEqual(snapU.reactions.like, { count: 2, mine: true });
    const snapAnon = (await new Client(app).get(`/api/boards/${b.slug}`)).json.posts[0];
    assert.deepEqual(snapAnon.reactions.like, { count: 2, mine: false }, 'anonymous readers get mine:false');
    r = await react(u, p, { kind: 'like' });
    assert.deepEqual(r.json.reactions.like, { count: 1, mine: false }, 'second press removes it');
  });

  it('vote and star behave like like', async () => {
    for (const kind of ['vote', 'star']) {
      const { p } = await boardWith(kind);
      const u = makeUser(app, kind);
      assert.deepEqual((await react(u, p, { kind })).json.reactions[kind], { count: 1, mine: true });
      assert.deepEqual((await react(u, p, { kind })).json.reactions[kind], { count: 0, mine: false });
    }
  });

  it('grade: set 1-10, same value or 0 cancels, other value replaces, avg over raters', async () => {
    const { p } = await boardWith('grade');
    const u1 = makeUser(app, 'g1');
    const u2 = makeUser(app, 'g2');
    let r = await react(u1, p, { kind: 'grade', value: 8 });
    assert.deepEqual(r.json.reactions.grade, { count: 1, avg: 8, mine: 8 });
    r = await react(u2, p, { kind: 'grade', value: 5 });
    assert.deepEqual(r.json.reactions.grade, { count: 2, avg: 6.5, mine: 5 });
    r = await react(u2, p, { kind: 'grade', value: 9 });
    assert.deepEqual(r.json.reactions.grade, { count: 2, avg: 8.5, mine: 9 });
    r = await react(u2, p, { kind: 'grade', value: 9 });
    assert.deepEqual(r.json.reactions.grade, { count: 1, avg: 8, mine: 0 }, 'same value cancels');
    r = await react(u1, p, { kind: 'grade', value: 0 });
    assert.deepEqual(r.json.reactions.grade, { count: 0, avg: 0, mine: 0 }, '0 cancels');
    for (const value of [11, -1, 1.5, 'x']) assert.equal((await react(u1, p, { kind: 'grade', value })).status, 400, String(value));
    assert.equal((await react(u1, p, { kind: 'grade', value: 10 })).status, 200);
    assert.equal((await react(u1, p, { kind: 'grade', value: 1 })).json.reactions.grade.mine, 1);
  });

  it('emoji: several per user, toggle, only the allowed set (variation selector tolerated)', async () => {
    const { b, p } = await boardWith('emoji');
    const u = makeUser(app, 'em');
    let r = await react(u, p, { kind: 'emoji', value: '👍' });
    assert.deepEqual(r.json.reactions.emoji, { '👍': { count: 1, mine: true } });
    r = await react(u, p, { kind: 'emoji', value: '🎉' });
    assert.deepEqual(r.json.reactions.emoji, { '👍': { count: 1, mine: true }, '🎉': { count: 1, mine: true } });
    r = await react(owner, p, { kind: 'emoji', value: '👍' });
    assert.deepEqual(r.json.reactions.emoji['👍'], { count: 2, mine: true });
    r = await react(u, p, { kind: 'emoji', value: '❤' }); // heart without U+FE0F
    assert.deepEqual(r.json.reactions.emoji['❤️'], { count: 1, mine: true });
    r = await react(u, p, { kind: 'emoji', value: '❤️' });
    assert.equal(r.json.reactions.emoji['❤️'], undefined, 'toggled off, unused emoji disappear');
    r = await react(u, p, { kind: 'emoji', value: '👍' });
    assert.deepEqual(r.json.reactions.emoji['👍'], { count: 1, mine: false });
    for (const value of ['🔥', '', undefined, 5, 'like']) assert.equal((await react(u, p, { kind: 'emoji', value })).status, 400, String(value));
    const snap = (await owner.get(`/api/boards/${b.slug}`)).json.posts[0];
    assert.deepEqual(Object.keys(snap.reactions.emoji).sort(), ['🎉', '👍'].sort());
  });

  it('reaction_disabled when the kind differs from settings.reactions, or reactions are none', async () => {
    const { p } = await boardWith('like');
    for (const body of [{ kind: 'vote' }, { kind: 'star' }, { kind: 'grade', value: 3 }, { kind: 'emoji', value: '👍' }]) {
      const r = await react(owner, p, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, 'reaction_disabled');
    }
    const { p: p2 } = await boardWith('none');
    for (const kind of ['like', 'vote', 'star', 'grade', 'emoji']) {
      const r = await react(owner, p2, { kind, value: kind === 'emoji' ? '👍' : 3 });
      assert.equal(r.json.error.code, 'reaction_disabled', kind);
    }
    assert.equal((await react(owner, p, { kind: 'sparkle' })).status, 400);
    assert.equal((await react(owner, p, {})).status, 400);
  });

  it('switching the board reaction type keeps old data stored but out of the way', async () => {
    const { b, p } = await boardWith('like');
    await react(owner, p, { kind: 'like' });
    await owner.patch(`/api/boards/${b.slug}`, { settings: { reactions: 'vote' } });
    assert.equal((await react(owner, p, { kind: 'like' })).status, 400);
    assert.equal((await react(owner, p, { kind: 'vote' })).json.reactions.vote.count, 1);
    assert.equal((await owner.get(`/api/boards/${b.slug}`)).json.posts[0].reactions.like.count, 1);
  });

  it('permissions: comment role needed; read-only members and anonymous visitors cannot react', async () => {
    const b = await makeBoard(owner, { title: '권한', linkAccess: 'read' });
    const p = await makePost(owner, b);
    const reader = makeUser(app, 'rd');
    const commenter = makeUser(app, 'cmr');
    await addMember(owner, b, commenter, 'comment');
    assert.equal((await react(new Client(app), p, { kind: 'like' })).status, 401);
    assert.equal((await react(reader, p, { kind: 'like' })).status, 403);
    assert.equal((await react(commenter, p, { kind: 'like' })).status, 200);
  });

  it('deleting a user-less post reaction cascade: reactions vanish with the post', async () => {
    const { p } = await boardWith('like');
    await react(owner, p, { kind: 'like' });
    await owner.del(`/api/posts/${p.id}`);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?', p.id).n, 0);
  });
});

describe('XSS-ish payloads are stored and returned as inert text', () => {
  const PAYLOADS = [
    '<img src=x onerror=alert(1)>',
    '<script>alert("x")</script>',
    '"><svg/onload=alert(1)>',
    "javascript:alert('x')",
    '[click](javascript:alert(1))',
    '</title><iframe src=//evil></iframe>',
    '${7*7} {{7*7}} %s %n',
  ];

  it('post title/body, comment, board title/description, display names round-trip byte for byte as JSON text', async () => {
    const b = await makeBoard(owner, { title: PAYLOADS[0], description: PAYLOADS[1] });
    assert.equal(b.title, PAYLOADS[0]);
    assert.equal(b.description, PAYLOADS[1]);
    const evil = makeUser(app, 'evil');
    await evil.patch('/api/auth/me', { displayName: PAYLOADS[2] });
    await owner.patch(`/api/boards/${b.slug}`, { linkAccess: 'write' });
    for (const payload of PAYLOADS) {
      const post = await makePost(evil, b, { title: payload.slice(0, 200), body: payload });
      assert.equal(post.title, payload.slice(0, 200));
      assert.equal(post.body, payload);
      assert.equal(post.author.displayName, PAYLOADS[2]);
      const c = await evil.post(`/api/posts/${post.id}/comments`, { body: payload });
      assert.equal(c.json.comment.body, payload);
    }
    const r = await owner.get(`/api/boards/${b.slug}`);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.json.posts.every((p) => PAYLOADS.includes(p.body)));
    // data/javascript URLs cannot be smuggled in as attachments
    for (const url of ["javascript:alert('x')", 'data:text/html;base64,PHNjcmlwdD4=', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)']) {
      assert.equal((await owner.post(`/api/boards/${b.slug}/posts`, { attachment: { kind: 'link', url } })).status, 400, url);
    }
    // the CSV export neutralises them as plain cells too
    const csv = (await owner.get(`/api/boards/${b.slug}/export?format=csv`)).text;
    assert.ok(csv.includes('<img src=x onerror=alert(1)>'), 'kept as text');
  });
});

// ── GET /api/posts/:id/reactions (a second tab catching up) and zero-width-only posts ──────────────────────────────
import { describe as describeExtra, it as itExtra, after as afterExtra } from 'node:test';
import assertExtra from 'node:assert/strict';
import { startApp as startAppExtra, Client as ClientExtra, makeUser as makeUserExtra } from './helpers.js';

describeExtra('catch-up reactions endpoint and invisible-only posts', () => {
  let app;
  const ready = (async () => { app = await startAppExtra(); })();
  afterExtra(async () => { await ready; await app.close(); });

  itExtra('GET /posts/:id/reactions returns counts plus the caller\'s own state, for any viewer', async () => {
    await ready;
    const o = makeUserExtra(app, 'ownerx');
    const oc = new ClientExtra(app, o.cookie);
    const b = (await oc.post('/api/boards', { title: 'r', format: 'wall' })).json.board;
    const p = (await oc.post(`/api/boards/${b.slug}/posts`, { title: 'hi' })).json.post;
    await oc.put(`/api/posts/${p.id}/reactions`, { kind: 'like' });
    const mine = await oc.get(`/api/posts/${p.id}/reactions`);
    assertExtra.equal(mine.status, 200);
    assertExtra.equal(mine.json.reactions.like.count, 1);
    assertExtra.equal(mine.json.reactions.like.mine, true);
    const anon = await new ClientExtra(app).get(`/api/posts/${p.id}/reactions`);
    assertExtra.equal(anon.status, 200, 'link boards are readable by anyone');
    assertExtra.equal(anon.json.reactions.like.count, 1);
    assertExtra.equal(anon.json.reactions.like.mine, false);
    await oc.patch(`/api/boards/${b.slug}`, { visibility: 'private' });
    assertExtra.equal((await new ClientExtra(app).get(`/api/posts/${p.id}/reactions`)).status, 404, 'private boards do not leak');
  });

  itExtra('a title or body made only of zero-width characters is an empty post', async () => {
    await ready;
    const o = makeUserExtra(app, 'ownery');
    const oc = new ClientExtra(app, o.cookie);
    const b = (await oc.post('/api/boards', { title: 'z', format: 'wall' })).json.board;
    const r = await oc.post(`/api/boards/${b.slug}/posts`, { title: '\u200b\u200d\ufeff', body: '\u2060 \u202e' });
    assertExtra.equal(r.status, 400);
    assertExtra.equal(r.json.error.code, 'empty_post');
    const ok = await oc.post(`/api/boards/${b.slug}/posts`, { title: 'visible\u200b' });
    assertExtra.equal(ok.status, 201);
  });
});
