import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, makeBoard, makePost, makeUser, startApp } from './helpers.js';
import { CLIENT_ID, CLIENT_SECRET, beginGoogle, beginLink, finishGoogle, newJar, readFlowCookie, signFlowCookie, startMockGoogle, walkGoogle } from './google-mock.js';
import { loadConfig } from '../server/config.js';
import { safeNext } from '../server/google.js';

const HANDLE = /^g-[0-9a-f]{12}$/;
const userCount = (app, sub) => app.db.get('SELECT COUNT(*) AS n FROM users WHERE google_sub = ?', sub).n;
const sidClient = (app, sid) => new Client(app, `edulet_sid=${sid}`);
const PW = 'correct-horse-9';
let seq = 0;
/** A real password account (registered through the API, so it has a password hash): { c, id, sid, username }. */
async function passwordUser(app, label = 'pw') {
  const c = new Client(app);
  const username = `${label}${++seq}${Math.random().toString(36).slice(2, 6)}`;
  const r = await c.post('/api/auth/register', { username, password: PW, displayName: label });
  assert.equal(r.status, 201, r.text);
  return { c, id: r.json.user.id, sid: c.cookie.slice('edulet_sid='.length), username };
}

describe('google sign-in', () => {
  let mock;
  let app;
  before(async () => {
    mock = await startMockGoogle();
    app = await startApp({ config: mock.config(), googleEndpoints: mock.endpoints(400) });
  });
  after(async () => { await app.close(); await mock.close(); });
  beforeEach(() => { mock.reset(); });

  it('/api/config says whether Google sign-in is on (and never leaks the client id)', async () => {
    const cfg = (await new Client(app).get('/api/config')).json;
    assert.equal(cfg.google, true);
    assert.deepEqual(cfg.googleDomains, []);
    assert.doesNotMatch(JSON.stringify(cfg), /apps\.googleusercontent|GOCSPX/);
  });

  it('start redirects to Google with state, nonce and an S256 PKCE challenge, and keeps the secrets in an HttpOnly cookie on /api/auth/google', async () => {
    const b = await beginGoogle(app, { next: '/b/x' });
    const q = Object.fromEntries(new URL(b.authUrl).searchParams);
    assert.equal(q.client_id, CLIENT_ID);
    assert.equal(q.redirect_uri, `${app.url}/api/auth/google/callback`);
    assert.equal(q.response_type, 'code');
    assert.equal(q.scope, 'openid email profile');
    assert.equal(q.code_challenge_method, 'S256');
    assert.equal(q.prompt, 'select_account');
    assert.ok(q.state.length >= 20 && q.nonce.length >= 20 && q.code_challenge.length >= 40);
    assert.equal(q.hd, undefined, 'no domain hint without a domain rule');
    const sc = b.jar.raw[0];
    assert.match(sc, /^edulet_oauth=/);
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
    assert.match(sc, /Path=\/api\/auth\/google(;|$)/);
    assert.match(sc, /Max-Age=600/);
    assert.doesNotMatch(sc, /Secure/i);
    // the cookie is base64url(JSON) + "." + HMAC: look inside it — the client secret must never reach the browser (it only keys the
    // HMAC), nor the PKCE verifier Google's URL
    const inside = Buffer.from(b.jar.get('edulet_oauth').split('.')[0], 'base64url').toString('utf8');
    const f = JSON.parse(inside);
    assert.equal(b.jar.get('edulet_oauth').split('.').length, 2);
    assert.equal(b.jar.get('edulet_oauth'), signFlowCookie(f), 'signed with HMAC-SHA256 keyed by the client secret');
    assert.doesNotMatch(inside + sc + b.authUrl, /GOCSPX/, 'the client secret never goes to the browser');
    assert.ok(!b.authUrl.includes(f.v), 'only the PKCE challenge goes to Google, the verifier stays in the cookie');
    assert.equal(f.r, q.redirect_uri, 'the redirect address of the exchange is the one Google was given');
    assert.deepEqual(Object.keys(f).sort(), ['e', 'm', 'n', 'r', 's', 'v', 'x']);
  });

  it('a first sign-in creates an account (random @g- handle, no password) and starts a session', async () => {
    const r = await walkGoogle(app);
    assert.equal(r.location, '/');
    assert.equal(r.flash, 'google_new');
    assert.ok(r.sid);
    const sess = r.jar.raw.find((s) => s.startsWith('edulet_sid='));
    assert.match(sess, /HttpOnly/i);
    assert.match(sess, /SameSite=Lax/i);
    assert.ok(!r.jar.has('edulet_oauth'), 'the flow cookie is spent');
    assert.match(r.jar.raw.find((s) => s.startsWith('edulet_flash=')), /Max-Age=60/);
    assert.ok(!/HttpOnly/i.test(r.jar.raw.find((s) => s.startsWith('edulet_flash='))), 'the page has to read the flash cookie');

    const me = (await sidClient(app, r.sid).get('/api/auth/me')).json.user;
    assert.equal(me.displayName, '김하나');
    assert.equal(me.isGuest, false);
    assert.match(me.username, HANDLE);
    assert.equal(me.hasPassword, false);
    assert.equal(me.googleEmail, 'hana@example.com');
    assert.match(me.avatarColor, /^#[0-9a-f]{6}$/i);
    const row = app.db.get('SELECT * FROM users WHERE id = ?', me.id);
    assert.equal(row.google_sub, mock.profile.sub);
    assert.equal(row.password_hash, null);
    // the mock only hands out a token for a correct code + client secret + redirect_uri + PKCE verifier
    assert.equal(mock.tokenCalls.length, 1);
  });

  it('signing in again finds the same account (no duplicate), keeps a renamed display name and follows a changed e-mail', async () => {
    const first = await walkGoogle(app);
    const me1 = (await sidClient(app, first.sid).get('/api/auth/me')).json.user;
    assert.equal((await sidClient(app, first.sid).patch('/api/auth/me', { displayName: '하나쌤' })).status, 200);

    mock.profile = { ...mock.profile, name: 'Someone Else', email: 'hana.kim@example.com' };
    const again = await walkGoogle(app);
    assert.equal(again.flash, 'google_ok');
    const me2 = (await sidClient(app, again.sid).get('/api/auth/me')).json.user;
    assert.equal(me2.id, me1.id);
    assert.equal(me2.displayName, '하나쌤');
    assert.equal(me2.googleEmail, 'hana.kim@example.com');
    assert.equal(userCount(app, mock.profile.sub), 1);
  });

  it('a Google account cannot be entered with a password, and has no password to change', async () => {
    const r = await walkGoogle(app);
    const c = sidClient(app, r.sid);
    const me = (await c.get('/api/auth/me')).json.user;
    const login = await new Client(app).post('/api/auth/login', { username: me.username, password: 'anything-at-all-123' });
    assert.equal(login.status, 401);
    assert.equal(login.json.error.code, 'bad_credentials');
    const pw = await c.patch('/api/auth/me', { currentPassword: 'x', newPassword: 'new-password-123' });
    assert.equal(pw.status, 403);
  });

  it('a sign-in replaces the visitor\'s guest session', async () => {
    const guest = new Client(app);
    await guest.guest('손님');
    const guestSid = guest.cookie.slice('edulet_sid='.length);
    const r = await walkGoogle(app, { sid: guestSid });
    assert.notEqual(r.sid, guestSid);
    assert.equal((await sidClient(app, guestSid).get('/api/auth/me')).json.user, null, 'the old guest session is gone');
    assert.equal((await sidClient(app, r.sid).get('/api/auth/me')).json.user.displayName, '김하나');
  });

  it('goes back to the page it came from — and only to a path of this site', async () => {
    assert.equal((await walkGoogle(app, { next: '/b/abc/p/12?x=1' })).location, '/b/abc/p/12?x=1');
    for (const evil of ['//evil.example', 'https://evil.example/', '/\\evil.example', '/\\/evil.example', 'javascript:alert(1)', '/api/auth/me', '/uploads/x/y', '/a\r\nSet-Cookie: x=1', '/a\nb', '/' + 'a'.repeat(600), '', 'b/x']) {
      assert.equal((await walkGoogle(app, { next: evil })).location, '/', JSON.stringify(evil));
    }
    assert.equal((await walkGoogle(app)).location, '/', 'no next at all');
    for (const sneaky of ['/./api/auth/me', '/%2e/api/auth/me', '/%2E%2e/api/x', '/a/../api/x', '/api?x=1', '/API/x', '/./uploads/x/y']) {
      assert.equal((await walkGoogle(app, { next: sneaky })).location, '/', sneaky);
      mock.reset();
    }
    assert.equal(safeNext('/apiary'), '/apiary');
    assert.equal(safeNext('/b/api/x'), '/b/api/x');
    // a character outside printable ASCII used to blow up the redirect AFTER the account and session were created
    for (const odd of ['/b/한글', '/b/\u00ff', '/a b', '/b/\u2028x']) {
      const before = app.db.get('SELECT COUNT(*) AS n FROM users').n;
      const r = await walkGoogle(app, { next: odd });
      assert.equal(r.location, '/', JSON.stringify(odd));
      assert.ok(r.sid, 'the sign-in still completes: ' + JSON.stringify(odd));
      assert.ok(app.db.get('SELECT COUNT(*) AS n FROM users').n >= before);
      mock.reset();
    }
    assert.equal((await walkGoogle(app, { next: '/b/%ED%95%9C?q=%20x' })).location, '/b/%ED%95%9C?q=%20x', 'percent-encoded is fine');
    // the same rule as a unit
    assert.equal(safeNext('/b/한글'), '/');
    assert.equal(safeNext('/b/%ED%95%9C'), '/b/%ED%95%9C');
    assert.equal(safeNext('/b/x'), '/b/x');
    assert.equal(safeNext(undefined), '/');
    assert.equal(safeNext(['/b/x']), '/');
  });

  it('pressing Cancel on Google ends in a message, not an account', async () => {
    mock.deny = true;
    const r = await walkGoogle(app, { next: '/dashboard' });
    assert.equal(r.location, '/dashboard');
    assert.equal(r.flash, 'google_denied');
    assert.equal(r.sid, null);
    assert.ok(!r.jar.has('edulet_oauth'));
  });

  describe('a forged or stale callback', () => {
    it('a wrong state is refused (login CSRF)', async () => {
      const b = await beginGoogle(app);
      const u = new URL(b.callbackUrl);
      u.searchParams.set('state', 'attacker-chosen');
      const r = await finishGoogle(b.jar, u.href);
      assert.equal(r.flash, 'google_state');
      assert.equal(r.sid, null);
    });

    it('a callback without the flow cookie (another browser, or a stale link) is refused', async () => {
      const b = await beginGoogle(app);
      b.jar.delete('edulet_oauth');
      const r = await finishGoogle(b.jar, b.callbackUrl);
      assert.equal(r.flash, 'google_state');
      assert.equal(r.sid, null);
      const bare = await finishGoogle(newJar(), `${app.url}/api/auth/google/callback?code=x&state=y`);
      assert.equal(bare.flash, 'google_state');
      assert.equal(bare.location, '/');
    });

    it('an expired (but genuinely signed) or structurally wrong flow cookie is refused', async () => {
      const b = await beginGoogle(app);
      const f = readFlowCookie(b.jar.get('edulet_oauth'));
      b.jar.set('edulet_oauth', signFlowCookie({ ...f, e: Date.now() - 1 }));
      assert.equal((await finishGoogle(b.jar, b.callbackUrl)).flash, 'google_state');
      const c = await beginGoogle(app);
      c.jar.set('edulet_oauth', 'not-base64-json!!');
      assert.equal((await finishGoogle(c.jar, c.callbackUrl)).flash, 'google_state');
      const d = await beginGoogle(app);
      d.jar.set('edulet_oauth', signFlowCookie({ ...readFlowCookie(d.jar.get('edulet_oauth')), x: 42 }));
      assert.equal((await finishGoogle(d.jar, d.callbackUrl)).flash, 'google_state');
      const e = await beginGoogle(app);
      e.jar.set('edulet_oauth', signFlowCookie({ ...readFlowCookie(e.jar.get('edulet_oauth')), m: 'link' })); // link without a user id
      assert.equal((await finishGoogle(e.jar, e.callbackUrl)).flash, 'google_state');
    });

    it('a flow cookie the browser made up is refused before Google is contacted — no client secret is spent on it', async () => {
      const b = await beginGoogle(app);
      const f = readFlowCookie(b.jar.get('edulet_oauth'));
      const calls = mock.tokenCalls.length;
      const forged = [
        Buffer.from(JSON.stringify({ ...f, r: 'https://evil.example/cb', v: 'attacker-verifier' })).toString('base64url') + '.' + b.jar.get('edulet_oauth').split('.')[1], // edited, old signature
        Buffer.from(JSON.stringify(f)).toString('base64url'), // no signature at all
        Buffer.from(JSON.stringify(f)).toString('base64url') + '.',
        signFlowCookie(f, 'a-different-secret'), // signed by someone who does not know the secret
        '.' + b.jar.get('edulet_oauth').split('.')[1],
      ];
      for (const value of forged) {
        const jar = newJar();
        jar.set('edulet_oauth', value);
        const r = await finishGoogle(jar, b.callbackUrl);
        assert.equal(r.flash, 'google_state', value.slice(0, 40));
        assert.equal(r.sid, null);
      }
      assert.equal(mock.tokenCalls.length, calls, 'the token endpoint was never called');
      // and the same cookie, genuinely signed, is accepted: the check is about the signature, not about something else
      const ok = newJar();
      ok.set('edulet_oauth', signFlowCookie(f));
      assert.ok((await finishGoogle(ok, b.callbackUrl)).sid);
    });

    it('one /start buys one answer: replaying the callback — even with a saved copy of the cookie and a new code — signs nobody in and never reaches Google', async () => {
      const b = await beginGoogle(app);
      const kept = b.jar.get('edulet_oauth');
      const ok = await finishGoogle(b.jar, b.callbackUrl);
      assert.ok(ok.sid);
      const calls = mock.tokenCalls.length;
      assert.equal((await finishGoogle(b.jar, b.callbackUrl)).flash, 'google_state', 'cookie was cleared');
      for (const code of [new URL(b.callbackUrl).searchParams.get('code'), 'a-brand-new-made-up-code']) {
        const replay = newJar();
        replay.set('edulet_oauth', kept); // the browser kept a copy
        const u = new URL(b.callbackUrl);
        u.searchParams.set('code', code);
        const r = await finishGoogle(replay, u.href);
        assert.equal(r.flash, 'google_state');
        assert.equal(r.sid, null);
      }
      assert.equal(mock.tokenCalls.length, calls, 'Google (and our client secret) was not used for the replays');
    });

    it('a denied flow is spent too', async () => {
      mock.deny = true;
      const b = await beginGoogle(app);
      const kept = b.jar.get('edulet_oauth');
      assert.equal((await finishGoogle(b.jar, b.callbackUrl)).flash, 'google_denied');
      const replay = newJar();
      replay.set('edulet_oauth', kept);
      assert.equal((await finishGoogle(replay, b.callbackUrl)).flash, 'google_state');
    });

    it('missing, empty or oversized code / an error from Google are refused', async () => {
      const b = await beginGoogle(app);
      const u = new URL(b.callbackUrl);
      u.searchParams.delete('code');
      assert.equal((await finishGoogle(b.jar, u.href)).flash, 'google_failed');
      const c = await beginGoogle(app);
      const v = new URL(c.callbackUrl);
      v.searchParams.set('code', 'x'.repeat(3000));
      assert.equal((await finishGoogle(c.jar, v.href)).flash, 'google_failed');
      const d = await beginGoogle(app);
      const w = new URL(d.callbackUrl);
      w.searchParams.delete('code');
      w.searchParams.set('error', 'server_error');
      assert.equal((await finishGoogle(d.jar, w.href)).flash, 'google_failed');
    });
  });

  describe('the ID token claims', () => {
    const fails = async (claims, flash = 'google_failed') => {
      mock.claims = claims;
      const r = await walkGoogle(app);
      assert.equal(r.flash, flash, JSON.stringify(claims));
      assert.equal(r.sid, null);
      assert.equal(userCount(app, mock.profile.sub), 0, 'no account was created');
    };
    const t = () => Math.floor(Date.now() / 1000);

    it('wrong audience, issuer, nonce, expired, or without sub / e-mail are refused', async () => {
      await fails({ aud: 'someone-elses-client' });
      await fails({ iss: 'https://evil.example' });
      await fails({ nonce: 'not-the-one-we-sent' });
      await fails({ nonce: undefined });
      await fails({ exp: t() - 3600 });
      await fails({ exp: undefined });
      await fails({ sub: undefined });
      await fails({ sub: 'x'.repeat(300) });
      await fails({ email: undefined });
      await fails({ email: 'not an address' });
    });

    it('an unverified e-mail is refused with its own message', async () => {
      await fails({ email_verified: false }, 'google_unverified');
      await fails({ email_verified: undefined }, 'google_unverified');
      await fails({ email_verified: 'false' }, 'google_unverified');
    });

    it('accepts the two spellings of Google\'s issuer, a string "true", a minute of clock skew; no name gets a neutral one', async () => {
      for (const claims of [{ iss: 'accounts.google.com' }, { email_verified: 'true' }, { exp: t() - 30 }]) {
        mock.reset();
        mock.profile = { ...mock.profile, sub: 'sub-' + Math.random() };
        mock.claims = claims;
        const r = await walkGoogle(app);
        assert.ok(r.sid, JSON.stringify(claims));
      }
      mock.reset();
      mock.profile = { sub: 'sub-noname', email: 'Taro.Yamada@Example.com', email_verified: true };
      const r = await walkGoogle(app);
      const me = (await sidClient(app, r.sid).get('/api/auth/me')).json.user;
      assert.equal(me.displayName, '구글 사용자', 'no name from Google: a neutral name, never the e-mail\'s local part (often a student number)');
      assert.equal(me.googleEmail, 'taro.yamada@example.com');
    });

    it('a long or messy name is cleaned and clamped like any display name', async () => {
      mock.profile = { ...mock.profile, sub: 'sub-longname', name: '  가'.repeat(60) + '\u0000\n' };
      const r = await walkGoogle(app);
      const me = (await sidClient(app, r.sid).get('/api/auth/me')).json.user;
      assert.ok([...me.displayName].length <= 40);
      assert.doesNotMatch(me.displayName, /[\u0000-\u001f]/);
    });

    it('garbage instead of an ID token, and failures of the token endpoint itself, end in "failed"', async () => {
      for (const bad of ['', 'abc', 'a.b', 'a..c', 'x.' + Buffer.from('[1,2]').toString('base64url') + '.z', 'x.' + Buffer.from('nope').toString('base64url') + '.z']) {
        mock.idToken = bad;
        const r = await walkGoogle(app);
        assert.equal(r.flash, 'google_failed', JSON.stringify(bad));
        assert.equal(r.sid, null);
      }
      mock.idToken = null;
      for (const status of [400, 401, 500]) {
        mock.tokenStatus = status;
        assert.equal((await walkGoogle(app)).flash, 'google_failed', 'HTTP ' + status);
      }
      mock.tokenStatus = 200;
      mock.tokenDelayMs = 1500; // the app waits 400 ms for Google
      const slow = await walkGoogle(app);
      assert.equal(slow.flash, 'google_failed');
      assert.equal(slow.sid, null);
    });
  });

  describe('linking Google to an existing account (the password is asked first)', () => {
    it('adds Google to a password account: same account afterwards, session untouched', async () => {
      const u = await passwordUser(app, 'linker');
      const r = await walkGoogle(app, { sid: u.sid, mode: 'link', password: PW, next: '/dashboard' });
      assert.equal(r.flash, 'google_linked');
      assert.equal(r.location, '/dashboard');
      assert.equal(r.sid, u.sid, 'no new session, no new account');
      assert.equal(app.db.get('SELECT google_sub AS s FROM users WHERE id = ?', u.id).s, mock.profile.sub);
      const me = (await u.c.get('/api/auth/me')).json.user;
      assert.equal(me.googleEmail, 'hana@example.com');
      assert.equal(me.hasPassword, true);
      const via = await walkGoogle(app);
      assert.equal(via.flash, 'google_ok');
      assert.equal((await sidClient(app, via.sid).get('/api/auth/me')).json.user.id, u.id, 'Google now opens the old account');
      assert.equal(userCount(app, mock.profile.sub), 1);
    });

    it('a session alone is not enough: without the right password nothing is linked and Google is not even asked', async () => {
      const victim = await passwordUser(app, 'victim');
      const stolen = victim.sid; // somebody holds the cookie but not the password
      for (const password of [undefined, '', 'wrong-password-1', 12345]) {
        const r = await beginLink(app, { sid: stolen, password });
        assert.equal(r.rejected.status, 401, String(password));
        assert.equal(r.rejected.json.error.code, 'bad_credentials');
        assert.ok(!r.jar.has('edulet_oauth'), 'no flow cookie is issued');
      }
      assert.equal(mock.authCalls.length, 0);
      assert.equal(app.db.get('SELECT google_sub AS s FROM users WHERE id = ?', victim.id).s, null);
    });

    it('guessing the password through this door is throttled like the password change (per account, 429)', async () => {
      const u = await passwordUser(app, 'guesser');
      for (let i = 0; i < 10; i++) assert.equal((await beginLink(app, { sid: u.sid, password: 'nope-nope-' + i })).rejected.status, 401);
      const locked = await beginLink(app, { sid: u.sid, password: PW }); // even the right one is refused now
      assert.equal(locked.rejected.status, 429);
      assert.equal(app.db.get('SELECT google_sub AS s FROM users WHERE id = ?', u.id).s, null);
    });

    it('one Google account belongs to one user', async () => {
      const a = await passwordUser(app, 'first');
      const b = await passwordUser(app, 'second');
      assert.equal((await walkGoogle(app, { sid: a.sid, mode: 'link', password: PW })).flash, 'google_linked');
      const r = await walkGoogle(app, { sid: b.sid, mode: 'link', password: PW });
      assert.equal(r.flash, 'google_taken');
      assert.equal(app.db.get('SELECT google_sub AS s FROM users WHERE id = ?', b.id).s, null);
    });

    it('an account that already has Google cannot link another one (409, before Google is asked)', async () => {
      const a = await passwordUser(app, 'already');
      assert.equal((await walkGoogle(app, { sid: a.sid, mode: 'link', password: PW })).flash, 'google_linked');
      const asked = mock.authCalls.length;
      const r = await beginLink(app, { sid: a.sid, password: PW });
      assert.equal(r.rejected.status, 409);
      assert.equal(r.rejected.json.error.code, 'google_already_linked');
      assert.equal(mock.authCalls.length, asked);
    });

    it('only a signed-in password account may link — anonymous, guest and passwordless accounts are refused', async () => {
      assert.equal((await beginLink(app, { password: PW })).rejected.status, 401);
      const g = makeUser(app, 'visitor', { guest: true });
      assert.equal((await beginLink(app, { sid: g.cookie.slice(11), password: PW })).rejected.status, 403);
      const nopw = makeUser(app, 'nopw'); // a named account without a password (e.g. the seed owner)
      assert.equal((await beginLink(app, { sid: nopw.cookie.slice(11), password: PW })).rejected.status, 403);
      assert.equal(mock.authCalls.length, 0);
    });

    it('is a same-origin POST (a page on another site cannot start it for a visitor)', async () => {
      const u = await passwordUser(app, 'csrf');
      const r = await beginLink(app, { sid: u.sid, password: PW, headers: { origin: 'https://evil.example' } });
      assert.equal(r.rejected.status, 403);
      assert.equal(r.rejected.json.error.code, 'bad_origin');
      assert.equal(app.db.get('SELECT google_sub AS s FROM users WHERE id = ?', u.id).s, null);
    });

    it('GET /start has no link mode any more: mode=link is just a sign-in flow that carries no user', async () => {
      const u = await passwordUser(app, 'plain');
      const first = await fetch(`${app.url}/api/auth/google/start?mode=link`, { redirect: 'manual', headers: { cookie: `edulet_sid=${u.sid}` } });
      assert.equal(first.status, 302);
      const flow = readFlowCookie(/edulet_oauth=([^;]+)/.exec(first.headers.getSetCookie()[0])[1]);
      assert.equal(flow.m, 'login');
      assert.equal(flow.u, undefined);
    });

    it('the callback needs the same user that started the link — also when the session changes halfway', async () => {
      const a = await passwordUser(app, 'startedhere');
      const other = await passwordUser(app, 'swapped');
      const b = await beginLink(app, { sid: a.sid, password: PW });
      b.jar.set('edulet_sid', other.sid); // someone else is signed in when Google sends the browser back
      assert.equal((await finishGoogle(b.jar, b.callbackUrl)).flash, 'google_need_login');
      const c = await beginLink(app, { sid: a.sid, password: PW });
      c.jar.delete('edulet_sid'); // signed out meanwhile
      assert.equal((await finishGoogle(c.jar, c.callbackUrl)).flash, 'google_need_login');
      assert.equal(app.db.get('SELECT COUNT(*) AS n FROM users WHERE google_sub IS NOT NULL AND id IN (?, ?)', a.id, other.id).n, 0);
    });
  });

  describe('unlinking Google again', () => {
    const linked = async () => {
      const u = await passwordUser(app, 'unl');
      assert.equal((await walkGoogle(app, { sid: u.sid, mode: 'link', password: PW })).flash, 'google_linked');
      return u;
    };

    it('needs the password; then Google no longer opens the account and the address is forgotten', async () => {
      const u = await linked();
      const sub = mock.profile.sub;
      for (const body of [{}, { currentPassword: '' }, { currentPassword: 'wrong-password-1' }]) {
        const bad = await u.c.post('/api/auth/google/unlink', body);
        assert.equal(bad.status, 401);
      }
      assert.equal(app.db.get('SELECT google_sub AS s FROM users WHERE id = ?', u.id).s, sub, 'still linked');
      const ok = await u.c.post('/api/auth/google/unlink', { currentPassword: PW });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.user.googleEmail, null);
      assert.equal(ok.json.user.hasPassword, true);
      const row = app.db.get('SELECT google_sub AS s, google_email AS e FROM users WHERE id = ?', u.id);
      assert.deepEqual([row.s, row.e], [null, null]);
      const again = await walkGoogle(app); // the same Google account now makes a NEW account
      assert.equal(again.flash, 'google_new');
      assert.notEqual((await sidClient(app, again.sid).get('/api/auth/me')).json.user.id, u.id);
      // and can be linked again
      assert.equal((await walkGoogle(app, { sid: u.sid, mode: 'link', password: PW })).flash, 'google_taken', 'taken by the account made just now');
    });

    it('refuses the cases that make no sense or would lock the owner out', async () => {
      const plain = await passwordUser(app, 'never');
      assert.equal((await plain.c.post('/api/auth/google/unlink', { currentPassword: PW })).status, 409, 'nothing linked');
      assert.equal((await new Client(app).post('/api/auth/google/unlink', { currentPassword: PW })).status, 401);
      const g = makeUser(app, 'visitor', { guest: true });
      assert.equal((await g.post('/api/auth/google/unlink', { currentPassword: PW })).status, 403);
      const only = await walkGoogle(app); // a Google-only account has no password to fall back on
      const r = await sidClient(app, only.sid).post('/api/auth/google/unlink', { currentPassword: PW });
      assert.equal(r.status, 403);
      assert.equal(app.db.get('SELECT google_sub AS s FROM users WHERE google_sub = ?', mock.profile.sub).s, mock.profile.sub);
    });

    it('is throttled like every other password check', async () => {
      const u = await linked();
      for (let i = 0; i < 10; i++) assert.equal((await u.c.post('/api/auth/google/unlink', { currentPassword: 'nope-nope-' + i })).status, 401);
      assert.equal((await u.c.post('/api/auth/google/unlink', { currentPassword: PW })).status, 429);
    });

    it('guesses made at the same moment are counted too: no more than the allowed number get through to the hash', async () => {
      const u = await linked();
      const tries = await Promise.all(Array.from({ length: 30 }, (_, i) => new Client(app, u.c.cookie).post('/api/auth/google/unlink', { currentPassword: 'nope-nope-' + i })));
      const by = (code) => tries.filter((r) => r.status === code).length;
      assert.equal(by(401), 10, 'LOGIN_FAIL_MAX guesses were checked');
      assert.equal(by(429), 20, 'the rest were refused before any hashing');
    });

    it('unlinking signs every other session of the account out (and the link itself needs the password, so a stolen session cannot do it)', async () => {
      const u = await linked();
      const second = new Client(app);
      const login = await second.post('/api/auth/login', { username: u.username, password: PW });
      assert.equal(login.status, 200);
      assert.equal((await second.get('/api/auth/me')).json.user.id, u.id);
      assert.equal((await u.c.post('/api/auth/google/unlink', { currentPassword: PW })).status, 200);
      assert.equal((await second.get('/api/auth/me')).json.user, null, 'the other session is gone');
      assert.equal((await u.c.get('/api/auth/me')).json.user.id, u.id, 'the session that unlinked stays');
    });
  });

  it('what others see of a Google user: name and avatar, never the e-mail or the Google id', async () => {
    const r = await walkGoogle(app);
    const g = sidClient(app, r.sid);
    const owner = makeUser(app, 'owner');
    const board = await makeBoard(owner, { title: '공개 보드', linkAccess: 'write', settings: { showAuthor: true } });
    await makePost(g, board, { title: 'Google 글', body: 'hello' });
    const watcher = new Client(app);
    const view = [
      await watcher.get(`/api/boards/${board.slug}`),
      await watcher.get(`/api/boards/${board.slug}/export?format=json`),
      await owner.get(`/api/boards/${board.slug}`),
      await owner.get(`/api/boards/${board.slug}/members`),
    ];
    for (const v of view) {
      assert.ok(v.status === 200, v.status + v.text.slice(0, 80));
      assert.ok(!v.text.includes(mock.profile.sub), 'the Google id stays private');
      assert.doesNotMatch(v.text, /hana@example\.com|hasPassword|googleEmail|google_sub/);
    }
    assert.match(view[0].text, /Google 글/);
  });

  it('the redirect address comes from EDULET_PUBLIC_URL, or from the proxy headers when the proxy is trusted', async () => {
    const pub = await startApp({ config: mock.config({ publicUrl: 'https://edulet.example.com' }), googleEndpoints: mock.endpoints() });
    try {
      const b = await beginGoogle(pub);
      assert.equal(new URL(b.authUrl).searchParams.get('redirect_uri'), 'https://edulet.example.com/api/auth/google/callback');
    } finally { await pub.close(); }

    const proxied = await startApp({ config: mock.config({ trustProxy: true }), googleEndpoints: mock.endpoints() });
    try {
      const b = await beginGoogle(proxied, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'edulet.school.example' } });
      assert.equal(new URL(b.authUrl).searchParams.get('redirect_uri'), 'https://edulet.school.example/api/auth/google/callback');
      assert.match(b.jar.raw[0], /; Secure/, 'https → the flow cookie is Secure');
      // a Host header that is not a host name is not turned into a redirect address
      const bad = await beginGoogle(proxied, { headers: { 'x-forwarded-host': 'evil.example/path?x=1' } });
      assert.equal(bad.done.flash, 'google_failed');
    } finally { await proxied.close(); }

    const direct = await startApp({ config: mock.config(), googleEndpoints: mock.endpoints() }); // proxy headers are ignored unless trusted
    try {
      const b = await beginGoogle(direct, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' } });
      assert.equal(new URL(b.authUrl).searchParams.get('redirect_uri'), `${direct.url}/api/auth/google/callback`);
    } finally { await direct.close(); }
  });
});

describe('google sign-in: switched off', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  it('is off without a client id AND secret, and says so instead of redirecting to Google', async () => {
    assert.equal((await new Client(app).get('/api/config')).json.google, false);
    const r = await walkGoogle(app, { next: '/b/x' });
    assert.equal(r.location, '/b/x');
    assert.equal(r.flash, 'google_disabled');
    const cb = await finishGoogle(newJar(), `${app.url}/api/auth/google/callback?code=x&state=y`);
    assert.equal(cb.flash, 'google_disabled');
    const half = await startApp({ config: { googleClientId: CLIENT_ID } });
    try {
      assert.equal((await new Client(half).get('/api/config')).json.google, false);
    } finally { await half.close(); }
  });

  it('link and unlink are JSON endpoints: 404 google_disabled / 401, not redirects', async () => {
    const r = await new Client(app).post('/api/auth/google/link', { currentPassword: 'x' });
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'google_disabled');
    assert.equal((await new Client(app).post('/api/auth/google/unlink', { currentPassword: 'x' })).status, 401);
  });

  it('other endpoints still return the usual JSON errors', async () => {
    assert.equal((await new Client(app).post('/api/auth/google/start', {})).status, 405);
    assert.equal((await new Client(app).get('/api/auth/google/nope')).status, 404);
  });
});

describe('google sign-in: closed registration', () => {
  let mock;
  let app;
  before(async () => {
    mock = await startMockGoogle();
    app = await startApp({ config: mock.config({ allowRegister: false }), googleEndpoints: mock.endpoints() });
  });
  after(async () => { await app.close(); await mock.close(); });

  it('no new account through Google, but an existing Google account still gets in', async () => {
    const r = await walkGoogle(app);
    assert.equal(r.flash, 'google_register_closed');
    assert.equal(r.sid, null);
    assert.equal(userCount(app, mock.profile.sub), 0);
    app.db.run('INSERT INTO users (username, display_name, password_hash, avatar_color, is_guest, created_at, google_sub, google_email) VALUES (?,?,NULL,?,0,?,?,?)',
      'g-000000000001', '기존', '#4fc3f7', Date.now(), mock.profile.sub, 'hana@example.com');
    const again = await walkGoogle(app);
    assert.equal(again.flash, 'google_ok');
    assert.ok(again.sid);
  });
});

describe('google sign-in: only some Google Workspace domains', () => {
  let mock;
  let app;
  before(async () => {
    mock = await startMockGoogle();
    app = await startApp({ config: mock.config({ googleDomains: ['school.ac.kr', 'gmail.com'] }), googleEndpoints: mock.endpoints() });
  });
  after(async () => { await app.close(); await mock.close(); });
  beforeEach(() => { mock.reset(); });

  const attempt = async (profile) => {
    mock.profile = { sub: 'sub-' + Math.random(), email_verified: true, name: '학생', ...profile };
    return walkGoogle(app);
  };

  it('admits the listed domains (by the hd claim, case-insensitively) and consumer Gmail when listed', async () => {
    assert.ok((await attempt({ email: 'a@school.ac.kr', hd: 'school.ac.kr' })).sid);
    assert.ok((await attempt({ email: 'b@school.ac.kr', hd: 'SCHOOL.AC.KR' })).sid);
    assert.ok((await attempt({ email: 'c@gmail.com' })).sid);
  });

  it('turns everyone else away — an e-mail that merely looks right is not enough', async () => {
    for (const p of [
      { email: 'd@other.example', hd: 'other.example' },
      { email: 'e@school.ac.kr' }, // no hd claim: a consumer account that claims a school address
      { email: 'f@school.ac.kr', hd: 'other.example' },
      { email: 'g@evil.example' },
    ]) {
      const r = await attempt(p);
      assert.equal(r.flash, 'google_domain', JSON.stringify(p));
      assert.equal(r.sid, null);
    }
  });

  it('config tells the page which domains; a single domain is also sent to Google as a hint', async () => {
    assert.deepEqual((await new Client(app).get('/api/config')).json.googleDomains, ['school.ac.kr', 'gmail.com']);
    assert.equal(new URL((await beginGoogle(app)).authUrl).searchParams.get('hd'), null, 'several domains: no single hint');
    const one = await startApp({ config: mock.config({ googleDomains: ['school.ac.kr'] }), googleEndpoints: mock.endpoints() });
    try {
      assert.equal(new URL((await beginGoogle(one)).authUrl).searchParams.get('hd'), 'school.ac.kr');
    } finally { await one.close(); }
  });

  it('the rule also covers linking', async () => {
    const u = await passwordUser(app, 'teacher');
    mock.profile = { sub: 'sub-link-domain', email: 'x@other.example', email_verified: true, name: 'X', hd: 'other.example' };
    assert.equal((await walkGoogle(app, { sid: u.sid, mode: 'link', password: PW })).flash, 'google_domain');
    assert.equal(app.db.get('SELECT google_sub AS s FROM users WHERE id = ?', u.id).s, null);
  });

  it('gmail.com as the only entry sends no hd hint (a Gmail account has no hosted domain to hint at)', async () => {
    const g = await startApp({ config: mock.config({ googleDomains: ['gmail.com'] }), googleEndpoints: mock.endpoints() });
    try {
      assert.equal(new URL((await beginGoogle(g)).authUrl).searchParams.get('hd'), null);
    } finally { await g.close(); }
  });
});

describe('google sign-in: attempt limit', () => {
  let mock;
  let app;
  before(async () => {
    mock = await startMockGoogle();
    app = await startApp({ config: mock.config({ googleRateMax: 4 }), googleEndpoints: mock.endpoints() });
  });
  after(async () => { await app.close(); await mock.close(); });

  it('a client address that hammers it is told to wait; Google is not contacted for those', async () => {
    const flashes = [];
    for (let i = 0; i < 4; i++) flashes.push((await beginGoogle(app).then((b) => ({ flash: b.done?.flash ?? 'started' }))).flash);
    assert.deepEqual(flashes, ['started', 'started', 'started', 'started']);
    const r = await beginGoogle(app);
    assert.equal(r.done.flash, 'google_rate');
    assert.equal(mock.authCalls.length, 4);
  });
});

describe('google sign-in: the shared budget of token exchanges', () => {
  it('every exchange spends the client secret, so all clients together are capped (default 1200/min; 3 here)', async () => {
    const mock = await startMockGoogle();
    const app = await startApp({ config: mock.config(), googleEndpoints: mock.endpoints(3000, { exchangesPerMinute: 3 }) });
    try {
      const flashes = [];
      for (let i = 0; i < 5; i++) {
        mock.profile = { ...mock.profile, sub: 'sub-cap-' + i }; // a different Google account each time (reset() would also clear the call log)
        flashes.push((await walkGoogle(app)).flash);
      }
      assert.deepEqual(flashes, ['google_new', 'google_new', 'google_new', 'google_rate', 'google_rate']);
      assert.equal(mock.tokenCalls.length, 3, 'over the cap Google is not called at all');
    } finally { await app.close(); await mock.close(); }
  });
});

describe('google sign-in: the exchange budget cannot be burned by a saved cookie or a spoofed address', () => {
  it('a saved flow cookie replayed many times spends nothing: one exchange only, and honest sign-ins still get through', async () => {
    const mock = await startMockGoogle();
    const app = await startApp({ config: mock.config({ googleRateMax: 100000 }), googleEndpoints: mock.endpoints(3000, { exchangesPerMinute: 3 }) });
    try {
      const b = await beginGoogle(app);
      const kept = b.jar.get('edulet_oauth');
      assert.ok((await finishGoogle(b.jar, b.callbackUrl)).sid);
      for (let i = 0; i < 20; i++) {
        const jar = newJar();
        jar.set('edulet_oauth', kept);
        const u = new URL(b.callbackUrl);
        u.searchParams.set('code', 'junk-' + i);
        assert.equal((await finishGoogle(jar, u.href)).flash, 'google_state');
      }
      assert.equal(mock.tokenCalls.length, 1);
      for (let i = 0; i < 2; i++) {
        mock.profile = { ...mock.profile, sub: 'honest-' + i };
        assert.equal((await walkGoogle(app)).flash, 'google_new', 'budget left for honest people: ' + i);
      }
    } finally { await app.close(); await mock.close(); }
  });

  it('a client address cannot be spelled so that it lands on the shared budget (X-Forwarded-For behind a trusted proxy)', async () => {
    const mock = await startMockGoogle();
    const app = await startApp({ config: mock.config({ trustProxy: true, googleRateMax: 2 }), googleEndpoints: mock.endpoints(3000, { exchangesPerMinute: 2 }) });
    try {
      for (let i = 0; i < 6; i++) await fetch(`${app.url}/api/auth/google/callback?code=x&state=y`, { redirect: 'manual', headers: { 'x-forwarded-for': 'google-exchange-all' } });
      for (let i = 0; i < 6; i++) await fetch(`${app.url}/api/auth/google/callback?code=x&state=y`, { redirect: 'manual', headers: { 'x-forwarded-for': 'exchange' } });
      const r = await walkGoogle(app, { headers: { 'x-forwarded-for': '203.0.113.9' } });
      assert.equal(r.flash, 'google_new');
    } finally { await app.close(); await mock.close(); }
  });
});

describe('google sign-in: cookies follow the public address', () => {
  it('with an https EDULET_PUBLIC_URL the flow and session cookies are Secure even without a trusted proxy (COOKIE_SECURE=0 still wins)', async () => {
    const mock = await startMockGoogle();
    const app = await startApp({ config: mock.config({ publicUrl: 'https://edulet.example.com' }), googleEndpoints: mock.endpoints() });
    const plain = await startApp({ config: mock.config({ publicUrl: 'https://edulet.example.com', cookieSecure: '0' }) });
    const http = await startApp({ config: mock.config({ publicUrl: 'http://edulet.local' }) });
    try {
      assert.match((await beginGoogle(app)).jar.raw[0], /; Secure/);
      const reg = await new Client(app).post('/api/auth/register', { username: 'secure01', password: PW, displayName: 's' });
      assert.match(reg.res.headers.getSetCookie()[0], /; Secure/);
      const off = await new Client(plain).post('/api/auth/register', { username: 'secure02', password: PW, displayName: 's' });
      assert.doesNotMatch(off.res.headers.getSetCookie()[0], /Secure/);
      const h = await new Client(http).post('/api/auth/register', { username: 'secure03', password: PW, displayName: 's' });
      assert.doesNotMatch(h.res.headers.getSetCookie()[0], /Secure/, 'an http address does not make cookies Secure');
    } finally { await app.close(); await plain.close(); await http.close(); await mock.close(); }
  });
});

describe('google sign-in: configuration', () => {
  const withEnv = (env, fn) => {
    const old = {};
    for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
    try { return fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  };

  it('EDULET_GOOGLE_* are read; the public URL is cut down to its origin; domains are normalised', () => {
    const cfg = withEnv({
      EDULET_GOOGLE_CLIENT_ID: ' id.apps.googleusercontent.com ', EDULET_GOOGLE_CLIENT_SECRET: 'sec',
      EDULET_PUBLIC_URL: 'https://Edulet.Example.com/app/?x=1', EDULET_GOOGLE_DOMAINS: '@School.ac.kr, b.org ,,',
    }, () => loadConfig());
    assert.equal(cfg.googleClientId, 'id.apps.googleusercontent.com');
    assert.equal(cfg.googleClientSecret, 'sec');
    assert.equal(cfg.publicUrl, 'https://edulet.example.com');
    assert.deepEqual(cfg.googleDomains, ['school.ac.kr', 'b.org']);
    assert.equal(cfg.googleRateMax, 300);
  });

  it('an unusable EDULET_PUBLIC_URL stops the server at start instead of being ignored', () => {
    for (const v of ['not a url', 'ftp://edulet.example.com', 'javascript:alert(1)', 'edulet.example.com']) {
      assert.throws(() => withEnv({ EDULET_PUBLIC_URL: v }, () => loadConfig()), /EDULET_PUBLIC_URL/, v);
    }
    assert.equal(withEnv({ EDULET_PUBLIC_URL: '' }, () => loadConfig()).publicUrl, '');
  });
});
