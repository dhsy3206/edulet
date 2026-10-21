// Hardening: per-account login throttle (L10), PATCH /auth/me limits (M2), revoked sessions lose their streams (M3).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, makeBoard, makePost, makeUser, openSse, sleep, startApp } from './helpers.js';

const register = async (app, username, password = 'correct-horse-1') => {
  const c = new Client(app);
  const r = await c.post('/api/auth/register', { username, password, displayName: username });
  assert.equal(r.status, 201, r.text);
  return c;
};
const login = (app, username, password) => new Client(app).post('/api/auth/login', { username, password });

describe('L10: failed logins are throttled per account (uniformly, whether or not the account exists)', () => {
  it('N failures lock the name for everyone: 429 rate_limited, even for the right password; other names are unaffected', async () => {
    const app = await startApp({ config: { loginFailMax: 2 } });
    try {
      await register(app, 'victim_user');
      await register(app, 'bystander_user');
      for (let i = 0; i < 2; i++) assert.equal((await login(app, 'victim_user', 'wrong-password-1')).status, 401);
      const locked = await login(app, 'victim_user', 'correct-horse-1');
      assert.equal(locked.status, 429);
      assert.equal(locked.json.error.code, 'rate_limited');
      assert.ok(Number(locked.headers.get('retry-after')) > 0);
      assert.equal((await login(app, 'VICTIM_USER', 'correct-horse-1')).status, 429, 'user names are case-insensitive');
      assert.equal((await login(app, 'bystander_user', 'correct-horse-1')).status, 200);
      // the lock does not reveal whether an account exists: an unknown name behaves exactly the same
      for (let i = 0; i < 2; i++) assert.equal((await login(app, 'no_such_account', 'wrong-password-1')).status, 401);
      const ghost = await login(app, 'no_such_account', 'wrong-password-1');
      assert.equal(ghost.status, 429);
      assert.deepEqual(ghost.json, locked.json);
      // the window ends
      app.app.rate.clear('loginfail:victim_user');
      assert.equal((await login(app, 'victim_user', 'correct-horse-1')).status, 200);
    } finally { await app.close(); }
  });

  it('a successful login resets the failure counter', async () => {
    const app = await startApp({ config: { loginFailMax: 2 } });
    try {
      await register(app, 'resetter_user');
      for (let round = 0; round < 3; round++) { // without the reset the second failure would lock the name
        assert.equal((await login(app, 'resetter_user', 'wrong-password-1')).status, 401);
        assert.equal((await login(app, 'resetter_user', 'correct-horse-1')).status, 200);
      }
    } finally { await app.close(); }
  });

  it('the default is 10 failures per 15 minutes', async () => {
    const app = await startApp();
    try {
      await register(app, 'default_user');
      for (let i = 0; i < 10; i++) assert.equal((await login(app, 'default_user', 'wrong-password-1')).status, 401, `attempt ${i + 1}`);
      assert.equal((await login(app, 'default_user', 'correct-horse-1')).status, 429);
    } finally { await app.close(); }
  });
});

describe('M2: PATCH /auth/me', () => {
  it('password changes are throttled per account after repeated wrong current passwords; profile edits still work', async () => {
    const app = await startApp({ config: { loginFailMax: 3 } });
    try {
      const c = await register(app, 'pw_throttle');
      for (let i = 0; i < 3; i++) {
        assert.equal((await c.patch('/api/auth/me', { currentPassword: 'wrong-password-1', newPassword: 'brand-new-pass-1' })).status, 401);
      }
      const r = await c.patch('/api/auth/me', { currentPassword: 'correct-horse-1', newPassword: 'brand-new-pass-1' });
      assert.equal(r.status, 429);
      assert.equal(r.json.error.code, 'rate_limited');
      assert.equal((await c.patch('/api/auth/me', { displayName: '새 이름' })).status, 200, 'non-password edits are not blocked');
      app.app.rate.clear(`pwfail:${(await c.get('/api/auth/me')).json.user.id}`);
      assert.equal((await c.patch('/api/auth/me', { currentPassword: 'correct-horse-1', newPassword: 'brand-new-pass-1' })).status, 200);
    } finally { await app.close(); }
  });

  it('password changes share the per-IP auth budget (they run scrypt)', async () => {
    const app = await startApp({ authRateLimit: 4 });
    try {
      const c = await register(app, 'ip_budget'); // 1
      for (let i = 0; i < 3; i++) assert.equal((await c.patch('/api/auth/me', { currentPassword: 'wrong-password-1', newPassword: 'brand-new-pass-1' })).status, 401); // 2..4
      const r = await c.patch('/api/auth/me', { currentPassword: 'wrong-password-1', newPassword: 'brand-new-pass-1' });
      assert.equal(r.status, 429);
      assert.equal(r.json.error.code, 'rate_limited');
      assert.equal((await c.patch('/api/auth/me', { displayName: 'x' })).status, 200, 'a plain profile edit does not use the IP budget');
    } finally { await app.close(); }
  });

  it('profile edits are limited per user (30/min)', async () => {
    const app = await startApp();
    try {
      const u = makeUser(app, 'prof');
      for (let i = 0; i < 30; i++) assert.equal((await u.patch('/api/auth/me', { displayName: `n${i}` })).status, 200);
      const r = await u.patch('/api/auth/me', { displayName: 'one too many' });
      assert.equal(r.status, 429);
      assert.equal(r.json.error.code, 'rate_limited');
      assert.equal((await makeUser(app, 'other').patch('/api/auth/me', { displayName: 'fine' })).status, 200);
    } finally { await app.close(); }
  });
});

describe('M3: revoked or expired sessions lose their realtime streams', () => {
  it('changing the password closes the other sessions\' streams, keeps the current one, and the old cookie is dead', async () => {
    const app = await startApp();
    const open = [];
    try {
      const owner = makeUser(app, 'o');
      const b = await makeBoard(owner, { title: 'b', linkAccess: 'write' });
      const first = await register(app, 'sse_pw_user');
      const other = new Client(app); // a second session of the same account
      assert.equal((await other.post('/api/auth/login', { username: 'sse_pw_user', password: 'correct-horse-1' })).status, 200);
      const s1 = await openSse(app, b.slug, first);
      const s2 = await openSse(app, b.slug, other);
      const s3 = await openSse(app, b.slug, other);
      open.push(s1, s2, s3);
      const changed = await first.patch('/api/auth/me', { currentPassword: 'correct-horse-1', newPassword: 'brand-new-pass-1' });
      assert.equal(changed.status, 200);
      await s2.waitClosed();
      await s3.waitClosed();
      assert.equal(s1.closed, false, 'the session that changed the password stays connected');
      await makePost(owner, b, { title: 'after' });
      await s1.waitFor('post.created', (d) => d.post.title === 'after');
      assert.equal((await other.get('/api/auth/me')).json.user, null, 'the other session is gone');
    } finally { for (const s of open) s.close?.(); await app.close(); }
  });

  it('pings re-check the session: an expired or deleted session ends its stream, anonymous streams stay', async () => {
    const app = await startApp({ pingMs: 40 });
    const open = [];
    try {
      const owner = makeUser(app, 'o');
      const b = await makeBoard(owner, { title: 'b' });
      const expiring = makeUser(app, 'exp');
      const revoked = makeUser(app, 'rev');
      const fine = makeUser(app, 'fine');
      const [se, sr, sf, sa] = [await openSse(app, b.slug, expiring), await openSse(app, b.slug, revoked), await openSse(app, b.slug, fine), await openSse(app, b.slug)];
      open.push(se, sr, sf, sa);
      app.db.run('UPDATE sessions SET expires_at = ? WHERE user_id = ?', Date.now() - 1000, expiring.id);
      app.db.run('DELETE FROM sessions WHERE user_id = ?', revoked.id);
      await se.waitClosed();
      await sr.waitClosed();
      await sleep(120);
      assert.equal(sf.closed, false);
      assert.equal(sa.closed, false);
    } finally { for (const s of open) s.close?.(); await app.close(); }
  });
});
