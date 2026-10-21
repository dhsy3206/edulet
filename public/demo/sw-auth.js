/* Edulet demo server — config, health, accounts and sessions (server/auth.js + the config part of server/index.js).
 * Differences from the Node server: PBKDF2 instead of scrypt, session token in a header instead of a cookie, no rate limits. */
(function (E) {
  'use strict';
  const { C, HttpError, bad, forbidden, unauthorized, needLine, now } = E;
  const { q, insert } = E.db;
  const { createSession } = E.http;
  const { router } = E;

  function normUsername(v) {
    const u = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (!new RegExp(`^[a-z0-9_.-]{${C.LIMITS.usernameMin},${C.LIMITS.usernameMax}}$`).test(u)) {
      throw bad('bad_username', `사용자명은 영문 소문자·숫자·_ . - 로 ${C.LIMITS.usernameMin}–${C.LIMITS.usernameMax}자여야 해요.`);
    }
    return u;
  }
  function needPassword(v) {
    if (typeof v !== 'string' || v.length < C.LIMITS.passwordMin) throw bad('weak_password', `비밀번호는 ${C.LIMITS.passwordMin}자 이상이어야 해요.`);
    if (v.length > C.LIMITS.passwordMax) throw bad('bad_request', '비밀번호가 너무 길어요.');
    return v;
  }
  const publicUser = (row) => E.userJson(row);

  router.add('GET', '/health', async () => ({ ok: true }));
  router.add('GET', '/config', async () => ({
    allowRegister: true, maxUploadMb: C.MAX_UPLOAD_MB, linkPreview: true, version: C.VERSION, demo: true,
  }));

  router.add('POST', '/auth/register', async (c) => {
    const b = await c.body();
    const username = normUsername(b.username);
    const password = needPassword(b.password);
    const displayName = b.displayName == null ? username : needLine(b.displayName, '표시 이름', 1, C.LIMITS.displayName);
    if (q.userByName(username)) throw new HttpError(409, 'username_taken', '이미 쓰고 있는 사용자명이에요.');
    const hash = await E.hashPassword(password);
    if (q.userByName(username)) throw new HttpError(409, 'username_taken', '이미 쓰고 있는 사용자명이에요.'); // two sign-ups raced
    const user = insert('users', { username, display_name: displayName, password_hash: hash, avatar_color: E.randomAvatar(), is_guest: 0, created_at: now() });
    if (c.tokenHash) delete E.db.state.sessions[c.tokenHash];
    c.sessionHeader = await createSession(user.id);
    c.json({ user: publicUser(user) }, 201);
  });

  router.add('POST', '/auth/login', async (c) => {
    const b = await c.body();
    const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password.slice(0, C.LIMITS.passwordMax) : '';
    const row = username ? q.userByName(username) : null;
    // always run one hash so timing does not reveal whether the user exists
    const ok = await E.verifyPassword(password, row?.password_hash || (await E.dummyHash()));
    if (!row || !row.password_hash || !ok) throw new HttpError(401, 'bad_credentials', '사용자명 또는 비밀번호가 맞지 않아요.');
    if (c.tokenHash) delete E.db.state.sessions[c.tokenHash];
    c.sessionHeader = await createSession(row.id);
    return { user: publicUser(row) };
  });

  router.add('POST', '/auth/guest', async (c) => {
    const b = await c.body();
    const displayName = needLine(b.displayName, '이름', 1, C.LIMITS.displayName);
    if (c.user) {
      c.user.display_name = displayName;
      const uid = c.user.id;
      c.defer(() => E.hub.userChanged(uid));
      return { user: publicUser(c.user) };
    }
    const user = insert('users', { username: null, display_name: displayName, password_hash: null, avatar_color: E.randomAvatar(), is_guest: 1, created_at: now() });
    c.sessionHeader = await createSession(user.id);
    c.json({ user: publicUser(user) }, 201);
  });

  router.add('POST', '/auth/logout', async (c) => {
    if (c.tokenHash) {
      const th = c.tokenHash;
      delete E.db.state.sessions[th];
      c.defer(() => E.hub.closeSession(th));
    }
    c.sessionHeader = ''; // clear the browser's copy
    return { ok: true };
  });

  router.add('GET', '/auth/me', async (c) => ({ user: c.user ? publicUser(c.user) : null }));

  router.add('PATCH', '/auth/me', async (c) => {
    if (!c.user) throw unauthorized();
    const b = await c.body();
    const sets = {};
    if (b.displayName !== undefined) sets.display_name = needLine(b.displayName, '표시 이름', 1, C.LIMITS.displayName);
    if (b.avatarColor !== undefined) {
      if (typeof b.avatarColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.avatarColor)) throw bad('bad_request', '색 형식이 올바르지 않아요.');
      sets.avatar_color = b.avatarColor.toLowerCase();
    }
    let newHash = null;
    if (b.newPassword !== undefined) {
      if (c.user.is_guest || !c.user.password_hash) throw forbidden('이 계정은 비밀번호를 바꿀 수 없어요.');
      needPassword(b.newPassword);
      if (typeof b.currentPassword !== 'string' || !(await E.verifyPassword(b.currentPassword.slice(0, C.LIMITS.passwordMax), c.user.password_hash))) {
        throw new HttpError(401, 'bad_credentials', '현재 비밀번호가 맞지 않아요.');
      }
      newHash = await E.hashPassword(b.newPassword);
      sets.password_hash = newHash;
    }
    Object.assign(c.user, sets);
    const uid = c.user.id;
    if (newHash) {
      // every other session is revoked — and so are its open event streams
      for (const [k, s] of Object.entries(E.db.state.sessions)) {
        if (s.user_id === uid && k !== c.tokenHash) {
          delete E.db.state.sessions[k];
          c.defer(() => E.hub.closeSession(k));
        }
      }
    }
    c.defer(() => E.hub.userChanged(uid));
    return { user: publicUser(c.user) };
  });
})((self.EDU = self.EDU || {}));
