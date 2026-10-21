// Accounts, sessions, scrypt password hashing. CONTRACT §5 "인증".
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

function cookieSecure(app, req) {
  const mode = app.config.cookieSecure;
  if (mode === '1' || mode === 'true' || mode === 'on') return true;
  if (mode === '0' || mode === 'false' || mode === 'off') return false;
  return !!app.config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(app, c, token) {
  const maxAge = app.config.sessionDays * 86400;
  const secure = cookieSecure(app, c.req) ? '; Secure' : '';
  c.res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
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

const publicUser = (row) => userJson(row);

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
    const row = username ? db.get('SELECT * FROM users WHERE username = ?', username) : null;
    // Always run one scrypt so timing does not reveal whether the user exists.
    const ok = await verifyPassword(password, row?.password_hash || (await dummy()));
    if (!row || !row.password_hash || !ok) throw new HttpError(401, 'bad_credentials', '사용자명 또는 비밀번호가 맞지 않아요.');
    if (c.tokenHash) db.run('DELETE FROM sessions WHERE token_hash = ?', c.tokenHash);
    const { token } = createSession(app, row.id);
    setSessionCookie(app, c, token);
    return { user: publicUser(row) };
  });

  router.add('POST', '/auth/guest', async (c) => {
    limitAuth(app, c);
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
      if (typeof b.currentPassword !== 'string' || !(await verifyPassword(b.currentPassword.slice(0, LIMITS.passwordMax), c.user.password_hash))) {
        throw new HttpError(401, 'bad_credentials', '현재 비밀번호가 맞지 않아요.');
      }
      newHash = await hashPassword(b.newPassword);
      sets.push('password_hash = ?'); vals.push(newHash);
    }
    if (sets.length) db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, c.user.id);
    if (newHash) db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', c.user.id, c.tokenHash);
    app.hub.userChanged(c.user.id);
    return { user: publicUser(db.get('SELECT * FROM users WHERE id = ?', c.user.id)) };
  });
}
