import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client, startApp, makeUser, makeBoard } from './helpers.js';

describe('auth', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  it('GET /api/health and /api/config', async () => {
    const c = new Client(app);
    assert.deepEqual((await c.get('/api/health')).json, { ok: true });
    const cfg = (await c.get('/api/config')).json;
    assert.equal(cfg.allowRegister, true);
    assert.equal(cfg.maxUploadMb, 20);
    assert.equal(cfg.linkPreview, true);
    assert.equal(typeof cfg.version, 'string');
  });

  it('me is null when anonymous', async () => {
    assert.deepEqual((await new Client(app).get('/api/auth/me')).json, { user: null });
  });

  it('register -> user JSON + cookie with HttpOnly, SameSite=Lax, Path=/ (no Secure by default)', async () => {
    const c = new Client(app);
    const r = await c.post('/api/auth/register', { username: 'Alice_01', password: 'correct horse', displayName: '앨리스' });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json.user).sort(), ['avatarColor', 'displayName', 'id', 'isGuest', 'username']);
    assert.equal(r.json.user.username, 'alice_01', 'username is lower-cased');
    assert.equal(r.json.user.displayName, '앨리스');
    assert.equal(r.json.user.isGuest, false);
    assert.match(r.json.user.avatarColor, /^#[0-9a-f]{6}$/i);
    const sc = r.res.headers.getSetCookie()[0];
    assert.match(sc, /^edulet_sid=[\w-]{40,}/);
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
    assert.match(sc, /Path=\//);
    assert.doesNotMatch(sc, /Secure/i);
    assert.match(sc, /Max-Age=\d+/);
    const me = await c.get('/api/auth/me');
    assert.equal(me.json.user.username, 'alice_01');
    assert.equal(me.json.user.password_hash, undefined);
    assert.equal(JSON.stringify(me.json).includes('scrypt'), false);
  });

  it('stores the password as scrypt$N$r$p$salt$hash (N >= 2^15) and the session token only as SHA-256', async () => {
    const c = new Client(app);
    await c.post('/api/auth/register', { username: 'bob_scrypt', password: 'hunter2hunter2', displayName: 'Bob' });
    const row = app.db.get('SELECT * FROM users WHERE username = ?', 'bob_scrypt');
    const [alg, N, r, p, salt, hash] = row.password_hash.split('$');
    assert.equal(alg, 'scrypt');
    assert.ok(Number(N) >= 2 ** 15);
    assert.equal(Number(r), 8);
    assert.equal(Number(p), 1);
    assert.equal(Buffer.from(salt, 'base64').length, 16);
    assert.ok(Buffer.from(hash, 'base64').length >= 32);
    assert.ok(!row.password_hash.includes('hunter2'));
    const token = /edulet_sid=([^;]+)/.exec(c.cookie)[1];
    const sess = app.db.all('SELECT token_hash FROM sessions WHERE user_id = ?', row.id);
    assert.equal(sess.length, 1);
    assert.equal(sess[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.notEqual(sess[0].token_hash, token);
    // two users with the same password get different salts/hashes
    await new Client(app).post('/api/auth/register', { username: 'carol_scrypt', password: 'hunter2hunter2', displayName: 'C' });
    const other = app.db.get('SELECT password_hash FROM users WHERE username = ?', 'carol_scrypt');
    assert.notEqual(other.password_hash, row.password_hash);
  });

  it('rejects duplicate (case-insensitive), bad usernames and short passwords', async () => {
    const c = new Client(app);
    await c.post('/api/auth/register', { username: 'dupe_user', password: 'password1', displayName: 'D' });
    const dup = await new Client(app).post('/api/auth/register', { username: 'DUPE_USER', password: 'password1', displayName: 'D2' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'username_taken');
    for (const username of ['ab', 'has space', 'UPPER$', 'x'.repeat(31), '한글이름', '']) {
      const r = await new Client(app).post('/api/auth/register', { username, password: 'password1', displayName: 'x' });
      assert.equal(r.status, 400, `username ${JSON.stringify(username)}`);
    }
    const weak = await new Client(app).post('/api/auth/register', { username: 'weakpw_user', password: '1234567', displayName: 'x' });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error.code, 'weak_password');
    const noName = await new Client(app).post('/api/auth/register', { username: 'noname_user', password: 'password1', displayName: '   ' });
    assert.equal(noName.status, 400);
  });

  it('login: success, and identical 401 for wrong password / unknown user / non-loginable user', async () => {
    await new Client(app).post('/api/auth/register', { username: 'login_user', password: 'secret-pass-1', displayName: 'L' });
    const c = new Client(app);
    const ok = await c.post('/api/auth/login', { username: 'LOGIN_USER', password: 'secret-pass-1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.username, 'login_user');
    assert.ok(c.cookie);
    const wrong = await new Client(app).post('/api/auth/login', { username: 'login_user', password: 'nope-nope-nope' });
    const unknown = await new Client(app).post('/api/auth/login', { username: 'nobody_here', password: 'nope-nope-nope' });
    const fixture = makeUser(app, 'nologin'); // username set, password NULL
    const nologin = await new Client(app).post('/api/auth/login', { username: fixture.username, password: 'whatever12' });
    for (const r of [wrong, unknown, nologin]) {
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, 'bad_credentials');
    }
    assert.equal(wrong.json.error.message, unknown.json.error.message);
    assert.equal(wrong.json.error.message, nologin.json.error.message);
  });

  it('login timing: an unknown user costs one scrypt too (no user enumeration by response time)', async () => {
    await new Client(app).post('/api/auth/register', { username: 'timing_user', password: 'secret-pass-1', displayName: 'T' });
    const time = async (username) => {
      const t0 = process.hrtime.bigint();
      await new Client(app).post('/api/auth/login', { username, password: 'wrong-password-1' });
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const known = med([await time('timing_user'), await time('timing_user'), await time('timing_user')]);
    const unknown = med([await time('timing_nobody'), await time('timing_nobody'), await time('timing_nobody')]);
    assert.ok(unknown > known * 0.5, `unknown ${unknown.toFixed(1)}ms vs known ${known.toFixed(1)}ms`);
    assert.ok(unknown > 20, 'a real scrypt ran');
  });

  it('guest: creates a guest account, second call only renames', async () => {
    const c = new Client(app);
    const r = await c.post('/api/auth/guest', { displayName: '지나가던 학생' });
    assert.equal(r.status, 201);
    assert.equal(r.json.user.isGuest, true);
    assert.equal(r.json.user.username, null);
    assert.equal(r.json.user.displayName, '지나가던 학생');
    const again = await c.post('/api/auth/guest', { displayName: '새 이름' });
    assert.equal(again.status, 200);
    assert.equal(again.json.user.id, r.json.user.id);
    assert.equal(again.json.user.displayName, '새 이름');
    const bad = await new Client(app).post('/api/auth/guest', { displayName: '' });
    assert.equal(bad.status, 400);
    const row = app.db.get('SELECT * FROM users WHERE id = ?', r.json.user.id);
    assert.equal(row.password_hash, null);
    assert.equal(row.is_guest, 1);
  });

  it('guests cannot create boards (403 guest_cannot_create)', async () => {
    const c = new Client(app);
    await c.guest('손님');
    const r = await c.post('/api/boards', { title: '게스트 보드' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'guest_cannot_create');
  });

  it('logout clears the cookie and invalidates the session server-side', async () => {
    const c = new Client(app);
    await c.post('/api/auth/register', { username: 'logout_user', password: 'password-9', displayName: 'O' });
    const old = c.cookie;
    const r = await c.post('/api/auth/logout');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.match(r.res.headers.getSetCookie()[0], /Max-Age=0/);
    assert.equal(c.cookie, null);
    const replay = new Client(app, old);
    assert.deepEqual((await replay.get('/api/auth/me')).json, { user: null });
    assert.equal((await new Client(app).post('/api/auth/logout')).status, 200, 'logout without session is fine');
  });

  it('expired sessions are rejected', async () => {
    const u = makeUser(app, 'expiry');
    assert.ok((await u.get('/api/auth/me')).json.user);
    app.db.run('UPDATE sessions SET expires_at = ? WHERE user_id = ?', Date.now() - 1000, u.id);
    assert.equal((await u.get('/api/auth/me')).json.user, null);
  });

  it('PATCH /auth/me: name, avatar color, password change', async () => {
    const c = new Client(app);
    await c.post('/api/auth/register', { username: 'patch_user', password: 'old-password-1', displayName: 'P' });
    const r = await c.patch('/api/auth/me', { displayName: '새이름', avatarColor: '#112233' });
    assert.equal(r.json.user.displayName, '새이름');
    assert.equal(r.json.user.avatarColor, '#112233');
    assert.equal((await c.patch('/api/auth/me', { avatarColor: 'red' })).status, 400);
    assert.equal((await c.patch('/api/auth/me', { displayName: '' })).status, 400);
    // password change needs the current password
    assert.equal((await c.patch('/api/auth/me', { newPassword: 'new-password-2' })).status, 401);
    assert.equal((await c.patch('/api/auth/me', { currentPassword: 'wrong-password', newPassword: 'new-password-2' })).status, 401);
    assert.equal((await c.patch('/api/auth/me', { currentPassword: 'old-password-1', newPassword: 'short' })).status, 400);
    assert.equal((await c.patch('/api/auth/me', { currentPassword: 'old-password-1', newPassword: 'new-password-2' })).status, 200);
    assert.equal((await new Client(app).post('/api/auth/login', { username: 'patch_user', password: 'old-password-1' })).status, 401);
    assert.equal((await new Client(app).post('/api/auth/login', { username: 'patch_user', password: 'new-password-2' })).status, 200);
    assert.equal((await new Client(app).patch('/api/auth/me', { displayName: 'x' })).status, 401);
  });

  it('guests cannot change a password', async () => {
    const c = new Client(app);
    await c.guest('g');
    const r = await c.patch('/api/auth/me', { currentPassword: 'x'.repeat(8), newPassword: 'y'.repeat(8) });
    assert.equal(r.status, 403);
  });

  it('CSRF: write with a foreign Origin header is 403 bad_origin; same origin and no Origin pass', async () => {
    const u = makeUser(app, 'csrf');
    const evil = await u.post('/api/boards', { title: 'x' }, { headers: { origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error.code, 'bad_origin');
    const nullOrigin = await u.post('/api/boards', { title: 'x' }, { headers: { origin: 'null' } });
    assert.equal(nullOrigin.status, 403);
    const same = await u.post('/api/boards', { title: 'x' }, { headers: { origin: app.url } });
    assert.equal(same.status, 201);
    const none = await u.post('/api/boards', { title: 'y' });
    assert.equal(none.status, 201);
    const ro = await u.get('/api/boards', { headers: { origin: 'http://evil.example' } });
    assert.equal(ro.status, 200, 'reads are not subject to the Origin check');
    const del = await u.del('/api/boards/zzzzzzzzzz', { headers: { origin: 'http://evil.example' } });
    assert.equal(del.status, 403);
  });

  it('write bodies must be JSON (415) and valid JSON (400)', async () => {
    const u = makeUser(app, 'ctype');
    const t = await u.req('POST', '/api/boards', 'title=x', { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(t.status, 415);
    const j = await u.req('POST', '/api/boards', '{not json', { raw: true, headers: { 'content-type': 'application/json' } });
    assert.equal(j.status, 400);
    assert.equal(j.json.error.code, 'bad_json');
    const arr = await u.req('POST', '/api/boards', '[1]', { raw: true, headers: { 'content-type': 'application/json' } });
    assert.equal(arr.status, 400);
  });

  it('errors use the { error: { code, message } } envelope; unknown /api paths are JSON 404', async () => {
    const c = new Client(app);
    const r = await c.get('/api/nope/at/all');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'not_found');
    assert.equal(typeof r.json.error.message, 'string');
    const anon = await c.get('/api/boards');
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error.code, 'unauthorized');
    assert.equal((await c.del('/api/health')).status, 405);
  });

  it('API responses are not cacheable and carry the security headers', async () => {
    const r = await new Client(app).get('/api/health');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.ok(r.headers.get('permissions-policy'));
    const csp = r.headers.get('content-security-policy');
    for (const part of [
      "default-src 'self'", "img-src 'self' data: https:", "media-src 'self' https:",
      'frame-src https://www.youtube-nocookie.com https://player.vimeo.com', "style-src 'self' 'unsafe-inline'",
      "script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'",
    ]) assert.ok(csp.includes(part), `CSP has ${part}`);
  });

  it('boards require login for listing, and deleting a missing board is 404', async () => {
    const u = makeUser(app, 'misc');
    assert.equal((await u.del('/api/boards/doesnotexist')).status, 404);
    const b = await makeBoard(u);
    assert.equal((await u.get('/api/boards')).json.boards[0].slug, b.slug);
  });
});

describe('auth: rate limit and proxy cookies', () => {
  it('IP rate limit: 20 auth attempts per minute, then 429 rate_limited', async () => {
    const app = await startApp({ authRateLimit: 20 });
    try {
      const c = new Client(app);
      for (let i = 0; i < 20; i++) {
        const r = await c.post('/api/auth/guest', { displayName: `g${i}` });
        assert.ok(r.status === 201 || r.status === 200, `attempt ${i + 1}: ${r.status}`);
      }
      const r = await new Client(app).post('/api/auth/login', { username: 'someone', password: 'password1' });
      assert.equal(r.status, 429);
      assert.equal(r.json.error.code, 'rate_limited');
      assert.ok(r.headers.get('retry-after'));
      assert.equal((await new Client(app).post('/api/auth/register', { username: 'zzzzz', password: 'password1', displayName: 'z' })).status, 429);
      assert.equal((await new Client(app).get('/api/auth/me')).status, 200, 'non-auth endpoints are unaffected');
    } finally { await app.close(); }
  });

  it('login failures count against the limit too', async () => {
    const app = await startApp({ authRateLimit: 3 });
    try {
      const c = new Client(app);
      for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/auth/login', { username: 'a_b_c', password: 'x'.repeat(8) })).status, 401);
      assert.equal((await c.post('/api/auth/login', { username: 'a_b_c', password: 'x'.repeat(8) })).status, 429);
    } finally { await app.close(); }
  });

  it('Secure cookie only behind a trusted https proxy', async () => {
    const app = await startApp({ config: { trustProxy: true } });
    try {
      const plain = await new Client(app).post('/api/auth/guest', { displayName: 'a' });
      assert.doesNotMatch(plain.res.headers.getSetCookie()[0], /Secure/i);
      const proxied = await new Client(app).post('/api/auth/guest', { displayName: 'b' }, { headers: { 'x-forwarded-proto': 'https' } });
      assert.match(proxied.res.headers.getSetCookie()[0], /; Secure/i);
    } finally { await app.close(); }
    const app2 = await startApp(); // TRUST_PROXY off: the header is ignored
    try {
      const r = await new Client(app2).post('/api/auth/guest', { displayName: 'c' }, { headers: { 'x-forwarded-proto': 'https' } });
      assert.doesNotMatch(r.res.headers.getSetCookie()[0], /Secure/i);
    } finally { await app2.close(); }
    const app3 = await startApp({ config: { cookieSecure: '1' } });
    try {
      const r = await new Client(app3).post('/api/auth/guest', { displayName: 'd' });
      assert.match(r.res.headers.getSetCookie()[0], /; Secure/i);
    } finally { await app3.close(); }
  });

  it('ALLOW_REGISTER=0 blocks sign-up but not login', async () => {
    const app = await startApp({ config: { allowRegister: false } });
    try {
      const r = await new Client(app).post('/api/auth/register', { username: 'closed_reg', password: 'password1', displayName: 'x' });
      assert.equal(r.status, 403);
      assert.equal(r.json.error.code, 'register_disabled');
      assert.equal((await new Client(app).get('/api/config')).json.allowRegister, false);
    } finally { await app.close(); }
  });
});
