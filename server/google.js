// Sign in with Google: OAuth 2.0 authorization-code flow + PKCE, run entirely on the server. CONTRACT §5 "Google 로그인".
// The page loads no Google script. It only navigates to /api/auth/google/start; Google sends the browser back to
// /api/auth/google/callback; the server trades the one-time code for an ID token over TLS (so the token needs no signature check,
// only its claims) and then starts the usual session cookie. Every failure ends as a redirect back to the page the user came from,
// carrying a short-lived `edulet_flash` cookie with a machine code that the front end turns into a message.
import crypto from 'node:crypto';
import { LIMITS } from './constants.js';
import { HttpError, clientIp, forbidden, parseCookies, unauthorized } from './http.js';
import { cleanLine, now, randomToken } from './util.js';
import { confirmPassword, cookieSecure, createSession, publicUser, randomAvatar, sessionCookie } from './auth.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FLOW_COOKIE = 'edulet_oauth'; // state + nonce + PKCE verifier of the sign-in in progress; HttpOnly, only sent to /api/auth/google/*
const FLASH_COOKIE = 'edulet_flash'; // read (and cleared) by the front end: google_ok | google_new | google_linked | google_<error>
const FLOW_PATH = '/api/auth/google';
const FLOW_TTL_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 10000;
const EXCHANGES_PER_MINUTE = 1200; // all clients together: one budget for every token exchange (a call made with OUR client secret); test-only override: googleEndpoints.exchangesPerMinute
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const GMAIL = new Set(['gmail.com', 'googlemail.com']); // consumer accounts carry no `hd` claim

export const googleEnabled = (app) => !!(app.config.googleClientId && app.config.googleClientSecret);

/** A failure the user should be told about: becomes a redirect with a flash cookie, never a JSON error page. */
class FlowError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const flow = (code) => new FlowError(code);

/**
 * A same-site path to return to; anything else (other hosts, //host, \host, control characters, /api/…) becomes "/".
 * Printable ASCII only: a browser percent-encodes everything else, and a header value with a character above U+00FF would make
 * the redirect throw AFTER the account and session were already created.
 */
export function safeNext(v) {
  if (typeof v !== 'string' || v.length > 500) return '/';
  if (!/^\/(?![/\\])[\x21-\x5b\x5d-\x7e]*$/.test(v)) return '/';
  const path = new URL(v, 'http://site.invalid').pathname.toLowerCase(); // what the browser will request: "/./api", "/%2e/api" are /api
  if (path === '/api' || path.startsWith('/api/') || path.startsWith('/uploads/')) return '/';
  return v;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const cookieTail = (app, req, maxAge) => `SameSite=Lax; Max-Age=${maxAge}${cookieSecure(app, req) ? '; Secure' : ''}`;
const flowCookie = (app, req, value, maxAge) => `${FLOW_COOKIE}=${value}; Path=${FLOW_PATH}; HttpOnly; ${cookieTail(app, req, maxAge)}`;
const flashCookie = (app, req, code) => `${FLASH_COOKIE}=${code}; Path=/; ${cookieTail(app, req, 60)}`;

function redirect(c, location, cookies = []) {
  c.res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Set-Cookie': cookies });
  c.res.end();
  c.done = true;
}

/** Where Google must send the browser back to: EDULET_PUBLIC_URL, else this request's own origin (behind a proxy only if it is trusted). */
function originOf(app, req) {
  if (app.config.publicUrl) return app.config.publicUrl;
  const trust = app.config.trustProxy;
  const fwdHost = trust ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const host = (fwdHost || String(req.headers.host || '')).toLowerCase();
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/.test(host)) throw flow('google_failed');
  const proto = trust && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

// The flow cookie is `base64url(JSON).base64url(HMAC-SHA256(client secret, "edulet-oauth-flow|" + base64url(JSON)))`: the browser can
// carry it but not forge it, so nobody can make the server call Google's token endpoint with a redirect_uri / verifier of their choice.
const signFlow = (app, payload) => crypto.createHmac('sha256', app.config.googleClientSecret).update('edulet-oauth-flow|' + payload).digest('base64url');
const encodeFlow = (app, f) => {
  const payload = Buffer.from(JSON.stringify(f)).toString('base64url');
  return payload + '.' + signFlow(app, payload);
};

function decodeFlow(app, raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2500) return null;
  const dot = raw.indexOf('.');
  if (dot < 1 || !safeEqual(raw.slice(dot + 1), signFlow(app, raw.slice(0, dot)))) return null;
  let f;
  try { f = JSON.parse(Buffer.from(raw.slice(0, dot), 'base64url').toString('utf8')); } catch { return null; }
  if (!f || typeof f !== 'object') return null;
  const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!(str(f.s, 100) && str(f.n, 100) && str(f.v, 200) && str(f.r, 300) && str(f.x, 500)
    && (f.m === 'login' || f.m === 'link') && Number.isFinite(f.e))) return null;
  if (f.m === 'link' && !Number.isSafeInteger(f.u)) return null;
  return f;
}

/** Google Workspace domain rule: `hd` is the only claim to trust for it (an e-mail's domain alone is not enough). */
function domainAllowed(list, claims, email) {
  if (!list.length) return true;
  const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '';
  if (hd) return list.includes(hd);
  const d = email.slice(email.lastIndexOf('@') + 1);
  return GMAIL.has(d) && list.includes(d);
}

function parseIdToken(idToken) {
  const parts = typeof idToken === 'string' ? idToken.split('.') : [];
  if (parts.length !== 3 || !parts[1]) throw flow('google_failed');
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (claims && typeof claims === 'object' && !Array.isArray(claims)) return claims;
  } catch { /* fall through */ }
  throw flow('google_failed');
}

/** Claims of an ID token that came straight from Google's token endpoint → { sub, email, name } or a FlowError. */
function checkClaims(app, claims, nonce) {
  const cfg = app.config;
  const exp = claims.exp;
  if (!ISSUERS.has(claims.iss) || claims.aud !== cfg.googleClientId) throw flow('google_failed');
  if (typeof exp !== 'number' || exp * 1000 <= now() - 60000) throw flow('google_failed'); // a minute of clock skew is fine
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)) throw flow('google_failed');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw flow('google_failed');
  const email = typeof claims.email === 'string' ? cleanLine(claims.email).toLowerCase().slice(0, 254) : '';
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw flow('google_failed');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw flow('google_unverified');
  if (!domainAllowed(cfg.googleDomains, claims, email)) throw flow('google_domain');
  const clamp = (s) => [...cleanLine(s)].slice(0, LIMITS.displayName).join('').trim();
  // no fallback to the e-mail's local part: at a school that is often a student number, and a display name is public
  const name = clamp(typeof claims.name === 'string' ? claims.name : '') || '구글 사용자';
  return { sub: claims.sub, email, name };
}

async function exchangeCode(app, code, f) {
  const cfg = app.config;
  const ep = app.googleEndpoints;
  const body = new URLSearchParams({
    code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, redirect_uri: f.r, grant_type: 'authorization_code', code_verifier: f.v,
  });
  let json;
  try {
    const res = await fetch(ep?.token ?? TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(ep?.timeoutMs ?? TOKEN_TIMEOUT_MS),
    });
    json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // what Google says ("invalid_client", "redirect_uri_mismatch", …) is the operator's only clue; it holds no secret
      if (!app.quiet) console.error(`[edulet] Google token exchange failed: HTTP ${res.status} ${String(json.error || '').slice(0, 60)} ${String(json.error_description || '').slice(0, 160)}`);
      throw flow('google_failed');
    }
  } catch (e) {
    if (e instanceof FlowError) throw e;
    if (!app.quiet) console.error('[edulet] Google token exchange failed:', e && e.message);
    throw flow('google_failed');
  }
  return parseIdToken(json.id_token);
}

function createUser(app, p) {
  const { db } = app;
  for (let i = 0; i < 5; i++) {
    // The invite handle (@g-…) is random on purpose: the e-mail address never becomes a public name.
    const handle = 'g-' + crypto.randomBytes(6).toString('hex');
    try {
      const id = db.run(
        'INSERT INTO users (username, display_name, password_hash, avatar_color, is_guest, created_at, google_sub, google_email) VALUES (?,?,NULL,?,0,?,?,?)',
        handle, p.name, randomAvatar(), now(), p.sub, p.email,
      ).id;
      return db.get('SELECT * FROM users WHERE id = ?', id);
    } catch (e) {
      if (!/UNIQUE.*users\.username/i.test(String(e.message))) throw e;
    }
  }
  throw flow('google_failed');
}

function signIn(app, c, p) {
  const { db } = app;
  let user = db.get('SELECT * FROM users WHERE google_sub = ?', p.sub);
  let created = false;
  if (!user) {
    if (!app.config.allowRegister) throw flow('google_register_closed');
    user = createUser(app, p);
    created = true;
  } else if (user.google_email !== p.email) {
    db.run('UPDATE users SET google_email = ? WHERE id = ?', p.email, user.id);
  }
  if (c.tokenHash) db.run('DELETE FROM sessions WHERE token_hash = ?', c.tokenHash);
  const { token } = createSession(app, user.id);
  return { flash: created ? 'google_new' : 'google_ok', cookies: [sessionCookie(app, c.req, token)] };
}

function linkAccount(app, c, p, f) {
  const { db } = app;
  const me = c.user;
  if (!me || me.is_guest || me.id !== f.u) throw flow('google_need_login');
  if (me.google_sub) throw flow('google_already_linked');
  if (db.get('SELECT 1 AS x FROM users WHERE google_sub = ?', p.sub)) throw flow('google_taken');
  db.run('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?', p.sub, p.email, me.id);
  return { flash: 'google_linked', cookies: [] };
}

export function registerGoogle(app) {
  const { router } = app;

  // A signed flow cookie is stateless, so on its own it could be replayed for its whole 10 minutes — and every replay with a made-up
  // code would cost a real call to Google under our client secret. One /start buys ONE callback: its `state` is remembered here
  // until the cookie would have expired anyway (a restart forgets them; the worst case is one more try inside those 10 minutes).
  const spentStates = new Map(); // state -> expiry
  function spend(state, exp) {
    const t = now();
    if (spentStates.size > 5000) for (const [k, e] of spentStates) if (e <= t) spentStates.delete(k);
    if (spentStates.has(state) || spentStates.size >= 50000) return false;
    spentStates.set(state, exp);
    return true;
  }

  // Attempts per client address, shared by both endpoints. No password is hashed here, so the budget is the generous guest one.
  function limit(c) {
    if (!app.rate.hit('google:' + clientIp(app, c.req), app.config.googleRateMax)) throw flow('google_rate');
  }

  /** Run `fn`; a FlowError becomes "back to `next` with a flash cookie" (plus `cookies`, e.g. the cleared flow cookie). */
  async function guarded(c, next, cookies, fn) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      return redirect(c, next, [...cookies, flashCookie(app, c.req, e.code)]);
    }
  }

  /** Make the one-time flow: Google's authorization address and the cookie that ties the answer to THIS browser. */
  function beginFlow(c, { next, mode, uid }) {
    const f = {
      s: randomToken(24), n: randomToken(24), v: randomToken(48), r: originOf(app, c.req) + FLOW_PATH + '/callback',
      x: next, m: mode, u: uid, e: now() + FLOW_TTL_MS,
    };
    const only = app.config.googleDomains.length === 1 ? app.config.googleDomains[0] : '';
    const url = new URL(app.googleEndpoints?.auth ?? AUTH_URL);
    url.search = new URLSearchParams({
      client_id: app.config.googleClientId,
      redirect_uri: f.r,
      response_type: 'code',
      scope: 'openid email profile',
      state: f.s,
      nonce: f.n,
      code_challenge: crypto.createHash('sha256').update(f.v).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
      ...(only && !GMAIL.has(only) ? { hd: only } : {}), // only a hint (and meaningless for Gmail): checkClaims() is the rule
    }).toString();
    return { url: url.href, cookie: flowCookie(app, c.req, encodeFlow(app, f), FLOW_TTL_MS / 1000) };
  }

  // Sign in / sign up. (Linking is a POST below: it must be preceded by the account's password.)
  router.add('GET', '/auth/google/start', async (c) => {
    const next = safeNext(c.query.next);
    return guarded(c, next, [], () => {
      if (!googleEnabled(app)) throw flow('google_disabled');
      limit(c);
      const { url, cookie } = beginFlow(c, { next, mode: 'login' });
      return redirect(c, url, [cookie]);
    });
  });

  router.add('GET', '/auth/google/callback', async (c) => {
    const f = decodeFlow(app, parseCookies(c.req.headers.cookie)[FLOW_COOKIE]);
    const next = f ? safeNext(f.x) : '/';
    const spent = [flowCookie(app, c.req, '', 0)]; // one-time: gone whether this ends well or not
    return guarded(c, next, spent, async () => {
      if (!googleEnabled(app)) throw flow('google_disabled');
      limit(c);
      const q = c.query;
      if (!f || f.e <= now() || typeof q.state !== 'string' || !safeEqual(q.state, f.s)) throw flow('google_state');
      if (!spend(f.s, f.e)) throw flow('google_state'); // this very flow was already answered once
      if (typeof q.error === 'string') throw flow(q.error === 'access_denied' ? 'google_denied' : 'google_failed');
      if (typeof q.code !== 'string' || !q.code || q.code.length > 2048) throw flow('google_failed');
      if (!app.rate.hit('google-exchange-all', app.googleEndpoints?.exchangesPerMinute ?? EXCHANGES_PER_MINUTE)) throw flow('google_rate'); // (a key no client address can spell: those are 'google:<ip>')
      const profile = checkClaims(app, await exchangeCode(app, q.code, f), f.n);
      const r = f.m === 'link' ? linkAccount(app, c, profile, f) : signIn(app, c, profile);
      return redirect(c, next, [...spent, ...r.cookies, flashCookie(app, c.req, r.flash)]);
    });
  });

  // Attach a Google account to the signed-in password account. A stolen session must not be able to plant its own Google account as
  // a second way in (it would survive the owner's password change), so this asks for the password first. Answers JSON: the page
  // then navigates to `url`; the cookie in this response is what ties Google's answer to this browser.
  router.add('POST', '/auth/google/link', async (c) => {
    if (!googleEnabled(app)) throw new HttpError(404, 'google_disabled', '이 서버에서는 Google 로그인을 쓸 수 없어요.');
    if (!c.user) throw unauthorized();
    if (c.user.is_guest || !c.user.password_hash) throw forbidden('비밀번호로 만든 계정만 Google 계정을 연결할 수 있어요.');
    if (c.user.google_sub) throw new HttpError(409, 'google_already_linked', '이미 Google 계정이 연결되어 있어요.');
    const b = await c.body();
    await confirmPassword(app, c, b.currentPassword);
    let started;
    try {
      started = beginFlow(c, { next: safeNext(b.next), mode: 'link', uid: c.user.id });
    } catch (e) {
      if (e instanceof FlowError) throw new HttpError(400, e.code, '이 주소로는 Google 로그인을 시작할 수 없어요.');
      throw e;
    }
    return c.json({ url: started.url }, 200, { 'Set-Cookie': started.cookie });
  });

  // Detach it again. Only for accounts that still have a password (otherwise the owner would lock themself out).
  router.add('POST', '/auth/google/unlink', async (c) => {
    if (!c.user) throw unauthorized();
    if (c.user.is_guest || !c.user.password_hash) throw forbidden('비밀번호가 없는 계정은 Google 연결을 풀 수 없어요. 풀면 들어올 방법이 없어져요.');
    if (!c.user.google_sub) throw new HttpError(409, 'google_not_linked', '연결된 Google 계정이 없어요.');
    const b = await c.body();
    await confirmPassword(app, c, b.currentPassword);
    app.db.run('UPDATE users SET google_sub = NULL, google_email = NULL WHERE id = ?', c.user.id);
    // unlinking is the recovery move after a suspected takeover: every OTHER session (and its open event streams) goes, like a password change
    const revoked = app.db.all('SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash != ?', c.user.id, c.tokenHash);
    app.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', c.user.id, c.tokenHash);
    for (const r of revoked) app.hub.closeSession(r.token_hash);
    return { user: publicUser(app.db.get('SELECT * FROM users WHERE id = ?', c.user.id)) };
  });
}
