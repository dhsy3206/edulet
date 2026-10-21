// Hardening: SSE connection caps (M5), presence coalescing and capping (M4).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, makeBoard, makeUser, openSse, sleep, startApp } from './helpers.js';

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(10); }
  return false;
};

describe('M5: caps on event streams', () => {
  it('per signed-in user (default 10): the next stream is refused with 429 too_many_connections until one closes', async () => {
    const app = await startApp({ config: { sseMaxPerUser: 2, sseMaxPerIp: 1000 } });
    const open = [];
    try {
      const o = makeUser(app, 'o');
      const b = await makeBoard(o, { title: 'b' });
      const u = makeUser(app, 'u');
      open.push(await openSse(app, b.slug, u), await openSse(app, b.slug, u));
      const refused = await openSse(app, b.slug, u);
      assert.equal(refused.status, 429);
      assert.equal(JSON.parse(refused.body).error.code, 'too_many_connections');
      assert.match(JSON.parse(refused.body).error.message, /[가-힣]/);
      assert.equal((await openSse(app, b.slug, makeUser(app, 'v'))).status, 200, 'other users are unaffected');
      open[0].close();
      // abrupt client close frees the slot
      let ok;
      assert.ok(await waitFor(async () => { ok = await openSse(app, b.slug, u); if (ok.status === 200) { open.push(ok); return true; } return false; }));
      // the cap counts across boards
      const b2 = await makeBoard(o, { title: 'b2' });
      assert.equal((await openSse(app, b2.slug, u)).status, 429);
    } finally { for (const s of open) s.close?.(); await app.close(); }
  });

  it('per client address (default 60): anonymous and signed-in streams share it', async () => {
    const app = await startApp({ config: { sseMaxPerIp: 3, sseMaxPerUser: 100 } });
    const open = [];
    try {
      const b = await makeBoard(makeUser(app, 'o'), { title: 'b' });
      for (let i = 0; i < 3; i++) open.push(await openSse(app, b.slug));
      const anon = await openSse(app, b.slug);
      assert.equal(anon.status, 429);
      assert.equal(JSON.parse(anon.body).error.code, 'too_many_connections');
      assert.equal((await openSse(app, b.slug, makeUser(app, 'u'))).status, 429, 'same address');
      open[0].close();
      assert.ok(await waitFor(async () => { const s = await openSse(app, b.slug); if (s.status === 200) { open.push(s); return true; } return false; }));
    } finally { for (const s of open) s.close?.(); await app.close(); }
  });

  it('closing streams from the server side (board deleted, access lost) frees their slots too', async () => {
    const app = await startApp({ config: { sseMaxPerUser: 1, sseMaxPerIp: 1000 } });
    const open = [];
    try {
      const o = makeUser(app, 'o');
      const m = makeUser(app, 'm');
      const b = await makeBoard(o, { title: 'b', visibility: 'private' });
      await o.post(`/api/boards/${b.slug}/members`, { username: m.username, role: 'read' });
      const s = await openSse(app, b.slug, m);
      open.push(s);
      await o.del(`/api/boards/${b.slug}/members/${m.id}`);
      await s.waitClosed();
      const b2 = await makeBoard(o, { title: 'again' });
      assert.ok(await waitFor(async () => { const n = await openSse(app, b2.slug, m); if (n.status === 200) { open.push(n); return true; } return false; }));
    } finally { for (const s of open) s.close?.(); await app.close(); }
  });

  it('the http server gets explicit limits: maxConnections and timeouts', async () => {
    const app = await startApp();
    try {
      assert.equal(app.server.maxConnections, 2000);
      assert.equal(app.server.requestTimeout, 600000);
      assert.equal(app.server.headersTimeout, 20000);
    } finally { await app.close(); }
    const small = await startApp({ config: { maxConnections: 50 } });
    try { assert.equal(small.server.maxConnections, 50); } finally { await small.close(); }
  });
});

describe('M4: presence is coalesced and capped', () => {
  it('a burst of joins and leaves produces a handful of presence broadcasts, and the last one is the truth', async () => {
    const app = await startApp({ presenceMinMs: 300, config: { sseMaxPerIp: 1000 } });
    const open = [];
    try {
      const o = makeUser(app, 'o');
      const b = await makeBoard(o, { title: 'b', linkAccess: 'read' });
      const watcher = await openSse(app, b.slug, o);
      open.push(watcher);
      const users = Array.from({ length: 14 }, () => makeUser(app, 'p'));
      const streams = [];
      for (const u of users) streams.push(await openSse(app, b.slug, u));
      open.push(...streams);
      assert.ok(await waitFor(() => watcher.ofType('presence').some((e) => e.data.presence.length === 15)), 'everyone ends up listed');
      const joins = watcher.ofType('presence').length;
      assert.ok(joins >= 1 && joins <= 4, `14 joins -> ${joins} broadcasts (was 14)`);
      const before = joins;
      for (const s of streams) s.close();
      assert.ok(await waitFor(() => watcher.ofType('presence').some((e) => e.data.presence.length === 1 && e.data.presence[0].id === o.id)));
      assert.ok(watcher.ofType('presence').length - before <= 4, 'leaves are folded together too');
      const last = watcher.ofType('presence').at(-1).data;
      assert.deepEqual(last.presence.map((p) => p.id), [o.id]);
      assert.equal(last.more, 0);
    } finally { for (const s of open) s.close?.(); await app.close(); }
  });

  it('the first change is sent at once (no added latency for a quiet board); later ones wait for the window', async () => {
    const app = await startApp({ presenceMinMs: 400 });
    const open = [];
    try {
      const o = makeUser(app, 'o');
      const b = await makeBoard(o, { title: 'b', linkAccess: 'read' });
      const watcher = await openSse(app, b.slug, o);
      open.push(watcher);
      const t0 = Date.now();
      open.push(await openSse(app, b.slug, makeUser(app, 'a')));
      await watcher.waitFor('presence', (d) => d.presence.length === 2, 3000);
      assert.ok(Date.now() - t0 < 300, 'leading edge is immediate');
      const t1 = Date.now();
      open.push(await openSse(app, b.slug, makeUser(app, 'b')));
      await watcher.waitFor('presence', (d) => d.presence.length === 3, 3000);
      assert.ok(Date.now() - t1 >= 150, 'the next change waited for the window');
    } finally { for (const s of open) s.close?.(); await app.close(); }
  });

  it('hello / presence / snapshot list at most 50 users and report the rest in `more`', async () => {
    const app = await startApp({ presenceMinMs: 50, config: { sseMaxPerIp: 1000 } });
    const open = [];
    try {
      const o = makeUser(app, 'o');
      const b = await makeBoard(o, { title: 'b', linkAccess: 'read' });
      const watcher = await openSse(app, b.slug, o);
      open.push(watcher);
      assert.deepEqual(Object.keys(watcher.events[0].data).sort(), ['more', 'presence'], 'hello: presence (+ more)');
      assert.equal(watcher.events[0].data.more, 0);
      assert.deepEqual(Object.keys(watcher.events[0].data.presence[0]).sort(), ['avatarColor', 'displayName', 'id']);
      let last;
      for (let i = 0; i < 59; i++) { last = await openSse(app, b.slug, makeUser(app, 'p')); open.push(last); }
      const hello = last.events[0].data;
      assert.equal(hello.presence.length, 50);
      assert.equal(hello.more, 10);
      assert.equal(new Set(hello.presence.map((p) => p.id)).size, 50);
      assert.ok(await waitFor(() => watcher.ofType('presence').some((e) => e.data.more === 10)));
      const ev = watcher.ofType('presence').at(-1).data;
      assert.deepEqual(Object.keys(ev).sort(), ['more', 'presence']);
      assert.equal(ev.presence.length, 50);
      const snap = (await new Client(app).get(`/api/boards/${b.slug}`)).json;
      assert.equal(snap.presence.length, 50);
      assert.deepEqual(Object.keys(snap).sort(), ['board', 'isOwner', 'posts', 'presence', 'role', 'sections'], 'snapshot shape unchanged');
    } finally { for (const s of open) s.close?.(); await app.close(); }
  });
});
