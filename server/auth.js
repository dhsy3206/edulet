// Accounts, sessions, scrypt password hashing. CONTRACT §5 "인증". (Sign in with Google lives in google.js.)
import crypto from 'node:crypto';
import { AVATAR_COLORS, LIMITS } from './constants.js';
import { bad, forbidden, HttpError, parseCookies, clientIp, unauthorized } from './http.js';
import { needLine, now, randomToken, sha256 } from './util.js';
import { userJson } from './views.js';

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64;
const COOKIE = 'edulet_sid';

function scryptAsync(pw, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!(n >= 2 && n <= 2 ** 20 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const want = Buffer.from(parts[5], 'base64');
  const got = await scryptAsync(pw, salt, n, r, p);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

let dummyHash;
const dummy = () => (dummyHash ??= hashPassword('edulet-dummy-password'));

export const randomAvatar = () => AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)];

export function createSession(app, userId) {
  const token = randomToken(32);
  const t = now();
  const expiresAt = t + app.config.sessionDays * 86400000;
  app.db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)', sha256(token), userId, expiresAt, t);
  return { token, expiresAt };
}

export function cookieSecure(app, req) {
  const mode = app.config.cookieSecure;
  if (mode === '1' || mode === 'true' || mode === 'on') return true;
  if (mode === '0' || mode === 'false' || mode === 'off') return false;
  if (/^https:/i.test(String(app.config.publicUrl || ''))) return true; // the address people are told to use is https
  return !!app.config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/** The Set-Cookie line that starts a session (also used by the Google callback, which sets several cookies at once). */
export function sessionCookie(app, req, token) {
  const maxAge = app.config.sessionDays * 86400;
  const secure = cookieSecure(app, req) ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function setSessionCookie(app, c, token) {
  c.res.setHeader('Set-Cookie', sessionCookie(app, c.req, token));
}
function clearSessionCookie(app, c) {
  const secure = cookieSecure(app, c.req) ? '; Secure' : '';
  c.res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

/** Resolve the session cookie -> { user, tokenHash } | null. */
export function authenticate(app, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token || token.length > 200) return null;
  const tokenHash = sha256(token);
  const row = app.db.get(
    'SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', tokenHash,
  );
  if (!row) return null;
  if (row.expires_at <= now()) {
    app.db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
    return null;
  }
  return { user: row, tokenHash };
}

function limitAuth(app, c) {
  if (!app.rate.hit('auth:' + clientIp(app, c.req), app.authRateLimit)) {
    throw new HttpError(429, 'rate_limited', '시도가 너무 많아요. 잠시 뒤에 다시 해 주세요.', { 'Retry-After': '60' });
  }
}

/** Guest sign-ins get their own, much larger bucket: 30 students behind one school IP must all be able to join. */
function limitGuest(app, c) {
  if (!app.rate.hit('guest:' + clientIp(app, c.req), app.config.guestRateMax)) {
    throw new HttpError(429, 'rate_limited', '지금 참여하는 사람이 너무 많아요. 잠시 뒤에 다시 해 주세요.', { 'Retry-After': '30' });
  }
}

const FAIL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Per-account failure throttle for password checks. The key is the SUBMITTED user name (existing or not), so a lock looks
 * the same for every name and says nothing about which accounts exist. While locked, attempts are refused with 429
 * before any password is hashed — even a correct one.
 */
function failKey(kind, id) { return `${kind}:${String(id).slice(0, 64)}`; }
function checkFailures(app, key) {
  if (app.rate.count(key) >= app.config.loginFailMax) {
    const wait = Math.max(1, Math.ceil(app.rate.retryAfterMs(key) / 1000));
    throw new HttpError(429, 'rate_limited', '시도가 너무 많아요. 잠시 뒤에 다시 해 주세요.', { 'Retry-After': String(wait) });
  }
}
const recordFailure = (app, key) => { app.rate.hit(key, app.config.loginFailMax, FAIL_WINDOW_MS); };

function normUsername(v) {
  const u = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!new RegExp(`^[a-z0-9_.-]{${LIMITS.usernameMin},${LIMITS.usernameMax}}$`).test(u)) {
    throw bad('bad_username', `사용자명은 영문 소문자·숫자·_ . - 로 ${LIMITS.usernameMin}–${LIMITS.usernameMax}자여야 해요.`);
  }
  return u;
}
function needPassword(v) {
  if (typeof v !== 'string' || v.length < LIMITS.passwordMin) throw bad('weak_password', `비밀번호는 ${LIMITS.passwordMin}자 이상이어야 해요.`);
  if (v.length > LIMITS.passwordMax) throw bad('bad_request', '비밀번호가 너무 길어요.');
  return v;
}

/** The user as they see themself: `hasPassword` / `googleEmail` are never sent to anyone else (userJson is what others get). */
export const publicUser = (row) => ({ ...userJson(row), hasPassword: !!row.password_hash, googleEmail: row.google_email ?? null });

/**
 * Re-check the signed-in user's password before something that would outlive their session — a password change, or linking /
 * unlinking a Google account (a stolen session must not be able to plant a second way in). Shares the per-IP auth budget and the
 * per-account failure counter of the password change, so guessing here is throttled like everywhere else.
 */
export async function confirmPassword(app, c, given) {
  limitAuth(app, c);
  const fk = failKey('pwfail', c.user.id);
  checkFailures(app, fk);
  // The guess is charged BEFORE the (slow) hash runs and the charge is wiped on success: otherwise N guesses in flight at the same
  // moment would all pass the check above and only be counted afterwards.
  recordFailure(app, fk);
  if (typeof given !== 'string' || !(await verifyPassword(given.slice(0, LIMITS.passwordMax), c.user.password_hash))) {
    throw new HttpError(401, 'bad_credentials', '현재 비밀번호가 맞지 않아요.');
  }
  app.rate.clear(fk);
}

export function registerAuth(app) {
  const { db, router } = app;

  router.add('POST', '/auth/register', async (c) => {
    limitAuth(app, c);
    if (!app.config.allowRegister) throw forbidden('지금은 가입을 받지 않아요.', 'register_disabled');
    const b = await c.body();
    const username = normUsername(b.username);
    const password = needPassword(b.password);
    const displayName = b.displayName == null ? username : needLine(b.displayName, '표시 이름', 1, LIMITS.displayName);
    if (db.get('SELECT 1 AS x FROM users WHERE username = ?', username)) throw new HttpError(409, 'username_taken', '이미 쓰고 있는 사용자명이에요.');
    const hash = await hashPassword(password);
    let id;
    try {
      id = db.run(
        'INSERT INTO users (username, display_name, password_hash, avatar_color, is_guest, created_at) VALUES (?,?,?,?,0,?)',
        username, displayName, hash, randomAvatar(), now(),
      ).id;
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'username_taken', '이미 쓰고 있는 사용자명이에요.');
      throw e;
    }
    if (c.tokenHash) db.run('DELETE FROM sessions WHERE token_hash = ?', c.tokenHash);
    const { token } = createSession(app, id);
    setSessionCookie(app, c, token);
    return c.json({ user: publicUser(db.get('SELECT * FROM users WHERE id = ?', id)) }, 201);
  });

  router.add('POST', '/auth/login', async (c) => {
    limitAuth(app, c);
    const b = await c.body();
    const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password.slice(0, LIMITS.passwordMax) : '';
    const fk = failKey('loginfail', username);
    checkFailures(app, fk);
    const row = username ? db.get('SELECT * FROM users WHERE username = ?', username) : null;
    // Always run one scrypt so timing does not reveal whether the user exists.
    const ok = await verifyPassword(password, row?.password_hash || (await dummy()));
    if (!row || !row.password_hash || !ok) {
      recordFailure(app, fk);
      throw new HttpError(401, 'bad_credentials', '사용자명 또는 비밀번호가 맞지 않아요.');
    }
    app.rate.clear(fk);
    if (c.tokenHash) db.run('DELETE FROM sessions WHERE token_hash = ?', c.tokenHash);
    const { token } = createSession(app, row.id);
    setSessionCookie(app, c, token);
    return { user: publicUser(row) };
  });

  router.add('POST', '/auth/guest', async (c) => {
    limitGuest(app, c);
    const b = await c.body();
    const displayName = needLine(b.displayName, '이름', 1, LIMITS.displayName);
    if (c.user) {
      db.run('UPDATE users SET display_name = ? WHERE id = ?', displayName, c.user.id);
      app.hub.userChanged(c.user.id);
      return { user: publicUser(db.get('SELECT * FROM users WHERE id = ?', c.user.id)) };
    }
    const id = db.run(
      'INSERT INTO users (username, display_name, password_hash, avatar_color, is_guest, created_at) VALUES (NULL,?,NULL,?,1,?)',
      displayName, randomAvatar(), now(),
    ).id;
    const { token } = createSession(app, id);
    setSessionCookie(app, c, token);
    return c.json({ user: publicUser(db.get('SELECT * FROM users WHERE id = ?', id)) }, 201);
  });

  router.add('POST', '/auth/logout', async (c) => {
    if (c.tokenHash) {
      db.run('DELETE FROM sessions WHERE token_hash = ?', c.tokenHash);
      app.hub.closeSession(c.tokenHash);
    }
    clearSessionCookie(app, c);
    return { ok: true };
  });

  router.add('GET', '/auth/me', async (c) => ({ user: c.user ? publicUser(c.user) : null }));

  router.add('PATCH', '/auth/me', async (c) => {
    if (!c.user) throw unauthorized();
    const b = await c.body();
    // Profile edits are cheap but not free; a password change runs scrypt (twice), so it also shares the per-IP budget of
    // the other password endpoints and has its own per-account failure counter.
    if (!app.rate.hit('profile:' + c.user.id, 30)) {
      throw new HttpError(429, 'rate_limited', '잠시 뒤에 다시 해 주세요.', { 'Retry-After': '60' });
    }
    const sets = [];
    const vals = [];
    if (b.displayName !== undefined) { sets.push('display_name = ?'); vals.push(needLine(b.displayName, '표시 이름', 1, LIMITS.displayName)); }
    if (b.avatarColor !== undefined) {
      if (typeof b.avatarColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.avatarColor)) throw bad('bad_request', '색 형식이 올바르지 않아요.');
      sets.push('avatar_color = ?'); vals.push(b.avatarColor.toLowerCase());
    }
    let newHash = null;
    if (b.newPassword !== undefined) {
      if (c.user.is_guest || !c.user.password_hash) throw forbidden('이 계정은 비밀번호를 바꿀 수 없어요.');
      needPassword(b.newPassword);
      await confirmPassword(app, c, b.currentPassword);
      newHash = await hashPassword(b.newPassword);
      sets.push('password_hash = ?'); vals.push(newHash);
    }
    if (sets.length) db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, c.user.id);
    if (newHash) {
      // every other session is revoked — and so are its open event streams (they would otherwise keep receiving events)
      const revoked = db.all('SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash != ?', c.user.id, c.tokenHash);
      db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', c.user.id, c.tokenHash);
      for (const r of revoked) app.hub.closeSession(r.token_hash);
    }
    app.hub.userChanged(c.user.id);
    return { user: publicUser(db.get('SELECT * FROM users WHERE id = ?', c.user.id)) };
  });
}
