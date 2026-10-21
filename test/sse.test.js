import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, addMember, makeBoard, makePost, makeUser, openSse, sleep, startApp } from './helpers.js';

let app;
const open = [];
before(async () => { app = await startApp({ pingMs: 40 }); });
after(async () => { for (const s of open) s.close?.(); await app.close(); });

async function connect(board, client = null, opts) {
  const s = await openSse(app, board.slug, client, opts);
  open.push(s);
  return s;
}
const ids = (presence) => presence.map((u) => u.id).sort((a, b) => a - b);
let n = 0;
/** Owner publishes a marker post; once `sse` has seen it, everything sent before it has provably arrived. */
async function settle(owner, board, ...streams) {
  const title = `__marker_${++n}`;
  await owner.post(`/api/boards/${board.slug}/posts`, { title });
  for (const s of streams) await s.waitFor('post.created', (d) => d.post.title === title);
}
const count = (s, type, pred = () => true) => s.events.filter((e) => e.type === type && pred(e.data)).length;

describe('SSE basics', () => {
  it('connects with the right headers, a retry hint, hello (with presence) and periodic pings', async () => {
    const o = makeUser(app, 'o');
    const b = await makeBoard(o);
    const s = await connect(b, o);
    assert.equal(s.status, 200);
    assert.match(s.headers['content-type'], /^text\/event-stream/);
    assert.match(s.headers['cache-control'], /no-cache/);
    assert.ok(s.raw.startsWith('retry: 3000\n\n'));
    assert.equal(s.events[0].type, 'hello');
    assert.deepEqual(s.events[0].data.presence.map((u) => u.id), [o.id]);
    assert.deepEqual(Object.keys(s.events[0].data.presence[0]).sort(), ['avatarColor', 'displayName', 'id']);
    for (let i = 0; i < 50 && !s.raw.includes(': ping'); i++) await sleep(20);
    assert.ok(s.raw.includes(': ping\n\n'), 'ping comment arrives');
    // …and as a named event, so a browser EventSource (which never sees comments) can detect a silently dead link
    for (let i = 0; i < 50 && !s.events.some((e) => e.type === 'ping'); i++) await sleep(20);
    assert.ok(s.events.some((e) => e.type === 'ping'), 'named ping event arrives');
  });

  it('anonymous visitors can connect to a link board; private boards answer 404 like missing ones', async () => {
    const o = makeUser(app, 'o');
    const b = await makeBoard(o);
    const anon = await connect(b);
    assert.equal(anon.status, 200);
    assert.deepEqual(anon.events[0].data.presence, [], 'anonymous connections are not listed');
    await o.patch(`/api/boards/${b.slug}`, { visibility: 'private' });
    await anon.waitClosed();
    const stranger = await openSse(app, b.slug, makeUser(app, 'x'));
    assert.equal(stranger.status, 404);
    assert.equal(JSON.parse(stranger.body).error.code, 'not_found');
    const missing = await openSse(app, 'nosuchboardxx', null);
    assert.equal(missing.status, 404);
    assert.equal(stranger.body, missing.body);
    const member = await connect(b, o);
    assert.equal(member.status, 200);
  });

  it('write requests echo X-Client-Id as `origin` (invalid ids are dropped)', async () => {
    const o = makeUser(app, 'o');
    const b = await makeBoard(o);
    const s = await connect(b, o);
    o.clientId = 'client-abc_123';
    const r = await makePost(o, b, { title: 'echo' });
    const ev = await s.waitFor('post.created', (d) => d.post.id === r.id);
    assert.equal(ev.data.origin, 'client-abc_123');
    o.clientId = null;
    const r2 = await makePost(o, b, { title: 'no header' });
    assert.equal((await s.waitFor('post.created', (d) => d.post.id === r2.id)).data.origin, null);
    o.clientId = 'bad id with spaces <script>';
    const r3 = await makePost(o, b, { title: 'bad header' });
    assert.equal((await s.waitFor('post.created', (d) => d.post.id === r3.id)).data.origin, null);
  });
});

describe('presence', () => {
  it('dedupes by user id, announces joins/leaves only when the set of users changes', async () => {
    const o = makeUser(app, 'o');
    const m = makeUser(app, 'm');
    const b = await makeBoard(o);
    await addMember(o, b, m, 'write');
    const a = await connect(b, o);
    assert.deepEqual(ids(a.events[0].data.presence), [o.id]);
    const m1 = await connect(b, m);
    assert.deepEqual(ids(m1.events[0].data.presence), ids([{ id: o.id }, { id: m.id }]));
    const joined = await a.waitFor('presence');
    assert.deepEqual(ids(joined.data.presence), ids([{ id: o.id }, { id: m.id }]));
    assert.equal(count(a, 'presence'), 1);
    // a second tab of the same user: no new presence event, still listed once
    const m2 = await connect(b, m);
    assert.equal(ids(m2.events[0].data.presence).length, 2);
    await settle(o, b, a);
    assert.equal(count(a, 'presence'), 1, 'second connection of the same user is silent');
    assert.equal((await o.get(`/api/boards/${b.slug}`)).json.presence.length, 2);
    // an anonymous visitor does not change presence either
    const anon = await connect(b);
    await settle(o, b, a, anon);
    assert.equal(count(a, 'presence'), 1);
    // closing one of two tabs: silent; closing the last one: presence without m
    m1.close();
    await sleep(60);
    await settle(o, b, a);
    assert.equal(count(a, 'presence'), 1, 'one tab left, user still present');
    m2.close();
    const left = await a.waitFor('presence', (d) => d.presence.length === 1);
    assert.deepEqual(left.data.presence.map((u) => u.id), [o.id]);
    assert.equal(count(a, 'presence'), 2);
    assert.deepEqual((await o.get(`/api/boards/${b.slug}`)).json.presence.map((u) => u.id), [o.id]);
  });

  it('guests count as users; renaming updates presence', async () => {
    const o = makeUser(app, 'o');
    const b = await makeBoard(o, { linkAccess: 'write' });
    const a = await connect(b, o);
    const g = new Client(app);
    await g.guest('손님1');
    const gs = await connect(b, g);
    const ev = await a.waitFor('presence', (d) => d.presence.some((u) => u.displayName === '손님1'));
    assert.equal(ev.data.presence.length, 2);
    await g.post('/api/auth/guest', { displayName: '손님2' });
    await a.waitFor('presence', (d) => d.presence.some((u) => u.displayName === '손님2'));
    gs.close();
    await a.waitFor('presence', (d) => d.presence.length === 1);
  });
});

describe('content events', () => {
  let o;
  let m;
  let b;
  let sa;
  let sb;
  before(async () => {
    o = makeUser(app, 'o');
    m = makeUser(app, 'm');
    b = await makeBoard(o, { template: 'kwl', settings: { reactions: 'like' } });
    await addMember(o, b, m, 'write');
    sa = await connect(b, o);
    sb = await connect(b, m);
  });

  it('post.created / post.updated / post.moved / post.deleted reach both clients, without `mine`', async () => {
    const secs = (await o.get(`/api/boards/${b.slug}`)).json.sections;
    const p = await makePost(m, b, { title: '새 글', sectionId: secs[0].id });
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('post.created', (d) => d.post.id === p.id);
      assert.equal(ev.data.post.title, '새 글');
      assert.equal(ev.data.post.author.id, m.id);
      assert.equal(ev.data.origin, m.clientId);
      assert.equal(ev.data.post.reactions.like.mine, undefined, 'event payloads carry no mine');
      assert.ok(!JSON.stringify(ev.data).includes('"mine"'));
    }
    await m.patch(`/api/posts/${p.id}`, { title: '고침' });
    await sa.waitFor('post.updated', (d) => d.post.id === p.id && d.post.title === '고침');
    await o.patch(`/api/posts/${p.id}`, { pinned: true });
    await sb.waitFor('post.updated', (d) => d.post.id === p.id && d.post.pinned === true);
    await o.post(`/api/posts/${p.id}/move`, { sectionId: secs[1].id, beforeId: null });
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('post.moved', (d) => d.post.id === p.id);
      assert.equal(ev.data.post.sectionId, secs[1].id);
      assert.equal(ev.data.origin, o.clientId);
    }
    await m.del(`/api/posts/${p.id}`);
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('post.deleted', (d) => d.id === p.id);
      assert.deepEqual(Object.keys(ev.data).sort(), ['id', 'origin']);
    }
  });

  it('a gap-collapsing move also reports the renumbered neighbours as post.updated', async () => {
    const wall = await makeBoard(o, { settings: { newPostPosition: 'bottom' } });
    const s = await connect(wall, o);
    const posts = [];
    for (const t of ['X', 'Y', 'Z1', 'Z2']) posts.push(await makePost(o, wall, { title: t }));
    for (let i = 0; i < 30; i++) await o.post(`/api/posts/${posts[2 + (i % 2)].id}/move`, { beforeId: posts[1].id });
    await settle(o, wall, s);
    const moved = count(s, 'post.moved');
    const updated = s.events.filter((e) => e.type === 'post.updated').length;
    assert.equal(moved, 30);
    assert.ok(updated >= 3, `renumbering announced ${updated} neighbour updates`);
    // replaying the events yields the server state
    const state = new Map();
    for (const e of s.events) if (e.type === 'post.created' || e.type === 'post.updated' || e.type === 'post.moved') state.set(e.data.post.id, e.data.post.rank);
    const snap = (await o.get(`/api/boards/${wall.slug}`)).json.posts;
    for (const p of snap) assert.equal(state.get(p.id), p.rank, `rank of ${p.title}`);
  });

  it('comment.created / comment.deleted', async () => {
    const p = await makePost(o, b, { title: 'for comments' });
    const c = (await m.post(`/api/posts/${p.id}/comments`, { body: '실시간 댓글' })).json;
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('comment.created', (d) => d.comment.id === c.comment.id);
      assert.deepEqual(Object.keys(ev.data).sort(), ['comment', 'commentCount', 'origin', 'postId']);
      assert.equal(ev.data.postId, p.id);
      assert.equal(ev.data.commentCount, 1);
      assert.equal(ev.data.comment.author.id, m.id);
      assert.equal(ev.data.comment.body, '실시간 댓글');
    }
    await o.del(`/api/comments/${c.comment.id}`);
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('comment.deleted', (d) => d.id === c.comment.id);
      assert.deepEqual([ev.data.postId, ev.data.commentCount], [p.id, 0]);
    }
  });

  it('reaction.updated carries counts, `by` and origin but never `mine`', async () => {
    const p = await makePost(o, b, { title: 'for likes' });
    await m.put(`/api/posts/${p.id}/reactions`, { kind: 'like' });
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('reaction.updated', (d) => d.postId === p.id);
      assert.deepEqual(Object.keys(ev.data).sort(), ['by', 'origin', 'postId', 'reactions']);
      assert.equal(ev.data.by, m.id);
      assert.deepEqual(ev.data.reactions.like, { count: 1 });
      assert.ok(!JSON.stringify(ev.data).includes('"mine"'));
    }
    await o.put(`/api/posts/${p.id}/reactions`, { kind: 'like' });
    await sb.waitFor('reaction.updated', (d) => d.postId === p.id && d.reactions.like.count === 2 && d.by === o.id);
  });

  it('section.created / updated / moved / deleted (+ post.updated for moved posts, post.deleted for deleted ones)', async () => {
    const created = (await o.post(`/api/boards/${b.slug}/sections`, { title: '새 섹션' })).json.section;
    for (const s of [sa, sb]) assert.equal((await s.waitFor('section.created', (d) => d.section.id === created.id)).data.section.title, '새 섹션');
    await o.patch(`/api/sections/${created.id}`, { title: '바뀐 섹션' });
    for (const s of [sa, sb]) await s.waitFor('section.updated', (d) => d.section.id === created.id && d.section.title === '바뀐 섹션');
    const first = (await o.get(`/api/boards/${b.slug}`)).json.sections[0];
    await o.post(`/api/sections/${created.id}/move`, { beforeId: first.id });
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('section.moved', (d) => d.section.id === created.id);
      assert.ok(ev.data.section.rank < first.rank);
    }
    const p = await makePost(o, b, { title: 'in new section', sectionId: created.id });
    const q = await makePost(o, b, { title: 'also', sectionId: created.id });
    await o.del(`/api/sections/${created.id}`);
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('section.deleted', (d) => d.id === created.id);
      assert.equal(ev.data.mode, 'move');
      const upd = await s.waitFor('post.updated', (d) => d.post.id === p.id && d.post.sectionId !== created.id);
      assert.notEqual(upd.data.post.sectionId, created.id);
      await s.waitFor('post.updated', (d) => d.post.id === q.id && d.post.sectionId !== created.id);
    }
    const sec2 = (await o.post(`/api/boards/${b.slug}/sections`, { title: '지울 섹션' })).json.section;
    const r = await makePost(o, b, { title: 'to be deleted', sectionId: sec2.id });
    await o.del(`/api/sections/${sec2.id}?posts=delete`);
    for (const s of [sa, sb]) {
      assert.equal((await s.waitFor('section.deleted', (d) => d.id === sec2.id)).data.mode, 'delete');
      await s.waitFor('post.deleted', (d) => d.id === r.id);
    }
  });

  it('board.updated carries the board; members.updated has only origin; format switch announces section + moved posts', async () => {
    await o.patch(`/api/boards/${b.slug}`, { title: '실시간 제목', wallpaper: 'ocean' });
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('board.updated', (d) => d.board.title === '실시간 제목');
      assert.equal(ev.data.board.wallpaper, 'ocean');
      assert.equal(ev.data.board.slug, b.slug);
      assert.equal(ev.data.origin, o.clientId);
    }
    const stranger = makeUser(app, 'newbie');
    await o.post(`/api/boards/${b.slug}/members`, { username: stranger.username, role: 'read' });
    for (const s of [sa, sb]) {
      const ev = await s.waitFor('members.updated');
      assert.deepEqual(Object.keys(ev.data), ['origin']);
    }
    const wall = await makeBoard(o, { title: '전환 보드' });
    const p = await makePost(o, wall, { title: 'loose' });
    const sw = await connect(wall, o);
    await o.patch(`/api/boards/${wall.slug}`, { format: 'rows' });
    await sw.waitFor('board.updated', (d) => d.board.format === 'rows');
    const sec = await sw.waitFor('section.created');
    assert.equal(sec.data.section.title, '섹션 1');
    const mv = await sw.waitFor('post.moved', (d) => d.post.id === p.id);
    assert.equal(mv.data.post.sectionId, sec.data.section.id);
  });
});

describe('pending posts are filtered per connection', () => {
  let o; let w; let w2; let mod; let b;
  let so; let sw; let sw2; let sm; let sanon;
  before(async () => {
    o = makeUser(app, 'o');
    w = makeUser(app, 'w');
    w2 = makeUser(app, 'w2');
    mod = makeUser(app, 'mod');
    b = await makeBoard(o, { linkAccess: 'write', settings: { approval: true } });
    await addMember(o, b, mod, 'moderate');
    [so, sw, sw2, sm, sanon] = [await connect(b, o), await connect(b, w), await connect(b, w2), await connect(b, mod), await connect(b)];
  });

  it('pending post.created goes to moderators, the owner and the author only', async () => {
    const p = await makePost(w, b, { title: '대기' });
    assert.equal(p.status, 'pending');
    for (const s of [so, sw, sm]) assert.equal((await s.waitFor('post.created', (d) => d.post.id === p.id)).data.post.status, 'pending');
    await settle(o, b, sw2, sanon);
    assert.equal(count(sw2, 'post.created', (d) => d.post.id === p.id), 0);
    assert.equal(count(sanon, 'post.created', (d) => d.post.id === p.id), 0);
    // edits of a pending post: same audience
    await w.patch(`/api/posts/${p.id}`, { title: '대기 수정' });
    for (const s of [so, sw, sm]) await s.waitFor('post.updated', (d) => d.post.id === p.id && d.post.title === '대기 수정');
    // comments and reactions on a pending post: same audience
    await mod.post(`/api/posts/${p.id}/comments`, { body: '보완해 주세요' });
    for (const s of [so, sw, sm]) await s.waitFor('comment.created', (d) => d.postId === p.id);
    await settle(o, b, sw2, sanon);
    assert.equal(count(sw2, 'comment.created'), 0);
    assert.equal(count(sanon, 'comment.created'), 0);
    assert.equal(count(sw2, 'post.updated', (d) => d.post.id === p.id), 0);
  });

  it('approval: audience that knew the card gets post.updated, everyone else post.created', async () => {
    const p = await makePost(w, b, { title: '승인될 글' });
    for (const s of [so, sw, sm]) await s.waitFor('post.created', (d) => d.post.id === p.id);
    await settle(o, b, sw2, sanon);
    assert.equal(count(sw2, 'post.created', (d) => d.post.id === p.id), 0);
    await mod.post(`/api/posts/${p.id}/approve`);
    for (const s of [so, sw, sm]) {
      const ev = await s.waitFor('post.updated', (d) => d.post.id === p.id && d.post.status === 'published');
      assert.equal(ev.data.post.status, 'published');
      assert.equal(count(s, 'post.created', (d) => d.post.id === p.id), 1, 'no duplicate post.created for those who knew it');
    }
    for (const s of [sw2, sanon]) {
      const ev = await s.waitFor('post.created', (d) => d.post.id === p.id);
      assert.equal(ev.data.post.status, 'published');
      assert.equal(count(s, 'post.updated', (d) => d.post.id === p.id), 0);
    }
  });

  it('deleting a pending post is only announced to the privileged audience', async () => {
    const p = await makePost(w, b, { title: '지워질 대기 글' });
    await w.del(`/api/posts/${p.id}`);
    for (const s of [so, sw, sm]) await s.waitFor('post.deleted', (d) => d.id === p.id);
    await settle(o, b, sw2, sanon);
    assert.equal(count(sw2, 'post.deleted', (d) => d.id === p.id), 0);
    assert.equal(count(sanon, 'post.deleted', (d) => d.id === p.id), 0);
  });

  it('a promotion to moderator takes effect on the open connection', async () => {
    await addMember(o, b, w2, 'write');
    const before = count(sw2, 'post.created');
    const p1 = await makePost(w, b, { title: '승진 전' });
    await settle(o, b, sw2);
    assert.equal(count(sw2, 'post.created', (d) => d.post.id === p1.id), 0);
    await o.patch(`/api/boards/${b.slug}/members/${w2.id}`, { role: 'moderate' });
    await sw2.waitFor('members.updated');
    const p2 = await makePost(w, b, { title: '승진 후' });
    await sw2.waitFor('post.created', (d) => d.post.id === p2.id);
    assert.ok(count(sw2, 'post.created') > before);
  });
});

describe('connections that lose access are closed', () => {
  it('private switch: board.updated first, then the stream ends for outsiders and anonymous readers; members stay', async () => {
    const o = makeUser(app, 'o');
    const m = makeUser(app, 'm');
    const reader = makeUser(app, 'reader');
    const b = await makeBoard(o);
    await addMember(o, b, m, 'read');
    const [so, sm, sr, sa] = [await connect(b, o), await connect(b, m), await connect(b, reader), await connect(b)];
    await o.patch(`/api/boards/${b.slug}`, { visibility: 'private' });
    for (const s of [sr, sa]) {
      await s.waitFor('board.updated', (d) => d.board.visibility === 'private');
      await s.waitClosed();
    }
    await sm.waitFor('board.updated');
    await settle(o, b, so, sm);
    assert.equal(sm.closed, false);
    assert.equal(so.closed, false);
    assert.equal((await openSse(app, b.slug, reader)).status, 404, 'reconnecting is refused');
  });

  it('removing a member from a private board ends their stream after members.updated', async () => {
    const o = makeUser(app, 'o');
    const m = makeUser(app, 'm');
    const b = await makeBoard(o, { visibility: 'private' });
    await addMember(o, b, m, 'write');
    const sm = await connect(b, m);
    await o.del(`/api/boards/${b.slug}/members/${m.id}`);
    await sm.waitFor('members.updated');
    await sm.waitClosed();
    const so = await connect(b, o);
    assert.equal(so.status, 200);
  });

  it('tightening linkAccess keeps readers connected but updates their role (pending filter follows)', async () => {
    const o = makeUser(app, 'o');
    const u = makeUser(app, 'u');
    const b = await makeBoard(o, { linkAccess: 'moderate', settings: { approval: true } });
    const w = makeUser(app, 'w');
    await addMember(o, b, w, 'write');
    const su = await connect(b, u);
    const p1 = await makePost(w, b, { title: 'seen as moderator' });
    await su.waitFor('post.created', (d) => d.post.id === p1.id);
    await o.patch(`/api/boards/${b.slug}`, { linkAccess: 'read' });
    await su.waitFor('board.updated', (d) => d.board.linkAccess === 'read');
    const p2 = await makePost(w, b, { title: 'hidden now' });
    await settle(o, b, su);
    assert.equal(count(su, 'post.created', (d) => d.post.id === p2.id), 0);
    assert.equal(su.closed, false);
  });

  it('deleting the board sends board.deleted and closes everyone', async () => {
    const o = makeUser(app, 'o');
    const b = await makeBoard(o);
    const [s1, s2] = [await connect(b, o), await connect(b)];
    await o.del(`/api/boards/${b.slug}`);
    for (const s of [s1, s2]) {
      const ev = await s.waitFor('board.deleted');
      assert.deepEqual(Object.keys(ev.data), ['origin']);
      await s.waitClosed();
    }
  });

  it('logout closes that session\'s streams only', async () => {
    const o = makeUser(app, 'o');
    const b = await makeBoard(o, { linkAccess: 'write' });
    const u = new Client(app);
    await u.post('/api/auth/register', { username: 'sse_logout_user', password: 'password-12', displayName: 'U' });
    const su = await connect(b, u);
    const su2 = await connect(b, u);
    const so = await connect(b, o);
    await u.post('/api/auth/logout');
    await su.waitClosed();
    await su2.waitClosed();
    assert.equal(so.closed, false);
  });

  it('closing the server ends open streams (no hanging sockets)', async () => {
    const local = await startApp();
    const o = makeUser(local, 'o');
    const b = await makeBoard(o);
    const s = await openSse(local, b.slug, o);
    await local.close();
    await s.waitClosed();
  });
});
