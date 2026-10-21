/* Edulet demo server — JSON serializers (state rows → API shapes) and the "who may see whom" rules.
 * Port of server/views.js + server/access.js (CONTRACT §4, §5). */
(function (E) {
  'use strict';
  const { C, atLeast, notFound, unauthorized, forbidden } = E;
  const { q } = E.db;

  /* ───────── users & settings ───────── */
  function userJson(r, p = '') {
    return {
      id: r[p + 'id'],
      username: r[p + 'username'] ?? null,
      displayName: r[p + 'display_name'],
      avatarColor: r[p + 'avatar_color'],
      isGuest: !!r[p + 'is_guest'],
    };
  }

  function parseSettings(text) {
    let raw = {};
    try { raw = JSON.parse(text || '{}') || {}; } catch { raw = {}; }
    const s = { ...C.DEFAULT_SETTINGS };
    for (const k of Object.keys(C.DEFAULT_SETTINGS)) if (k in raw && typeof raw[k] === typeof C.DEFAULT_SETTINGS[k]) s[k] = raw[k];
    if (!C.REACTIONS.includes(s.reactions)) s.reactions = C.DEFAULT_SETTINGS.reactions;
    if (!['on', 'off'].includes(s.comments)) s.comments = 'on';
    if (!['top', 'bottom'].includes(s.newPostPosition)) s.newPostPosition = 'top';
    return s;
  }

  /* ───────── who may see whom (§5 "User", §4 showAuthor) ───────── */
  /** What a hidden author looks like to readers below `moderate` when `settings.showAuthor` is false. */
  const ANON_AUTHOR = Object.freeze({ id: 0, username: null, displayName: '익명', avatarColor: '#94a3b8', isGuest: true });
  /** A viewer: `userId` (null = anonymous), `admin` (sees login names), `anonymize` (authors of other people are hidden). */
  const PUBLIC_VIEW = Object.freeze({ userId: null, admin: false, anonymize: false });
  /** Unfiltered serialisation, used only for event payloads — the hub shapes them again per stream. */
  const FULL_VIEW = Object.freeze({ userId: null, admin: true, anonymize: false });

  function viewerFor(board, role, userId) {
    const settings = parseSettings(board.settings);
    return { userId: userId ?? null, admin: atLeast(role, 'admin'), anonymize: settings.showAuthor === false && !atLeast(role, 'moderate') };
  }
  /** Any user object that is not a post/comment author (the board owner): login name only for admins and the user themself. */
  function shapeUser(u, v) {
    if (!u || u.username == null || v.admin || u.id === v.userId) return u;
    return { ...u, username: null };
  }
  /** Post/comment author: one's own items stay real; others are anonymised or just lose the login name. */
  function shapeAuthor(u, v) {
    if (!u || u.id === v.userId) return u;
    return v.anonymize ? ANON_AUTHOR : shapeUser(u, v);
  }
  const shapePost = (p, v) => (p ? { ...p, author: shapeAuthor(p.author, v) } : p);
  const shapeComment = (cm, v) => (cm ? { ...cm, author: shapeAuthor(cm.author, v) } : cm);
  const shapeBoard = (b, v) => (b ? { ...b, owner: shapeUser(b.owner, v) } : b);

  /* ───────── boards, sections ───────── */
  function boardJson(b, view = PUBLIC_VIEW) {
    const owner = q.user(b.owner_id);
    return shapeBoard({
      id: b.id,
      slug: b.slug,
      title: b.title,
      description: b.description,
      format: b.format,
      wallpaper: b.wallpaper,
      font: b.font,
      colorScheme: b.color_scheme,
      visibility: b.visibility,
      linkAccess: b.link_access,
      settings: parseSettings(b.settings),
      owner: owner ? userJson(owner) : null,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    }, view);
  }
  const sectionJson = (s) => ({ id: s.id, boardId: s.board_id, title: s.title, rank: s.rank });
  function touchBoard(boardId, t = Date.now()) {
    const b = q.board(boardId);
    if (b) b.updated_at = t;
  }

  /* ───────── posts, reactions, comments ───────── */
  const round2 = (n) => Math.round(n * 100) / 100;
  function blankReactions(withMine) {
    const r = { like: { count: 0 }, vote: { count: 0 }, star: { count: 0 }, grade: { count: 0, avg: 0 }, emoji: {} };
    if (withMine) { r.like.mine = false; r.vote.mine = false; r.star.mine = false; r.grade.mine = 0; }
    return r;
  }

  /** postId → reactions object for the given post ids. `mine` is included when `withMine` (needs viewerId for real values). */
  function reactionMap(postIds, viewerId, withMine) {
    const map = new Map();
    const get = (id) => {
      let r = map.get(id);
      if (!r) { r = blankReactions(withMine); map.set(id, r); }
      return r;
    };
    const groups = new Map(); // `${post}|${key}` → { post, key, n, sum }
    for (const rx of Object.values(E.db.state.reactions)) {
      if (!postIds.has(rx.post_id)) continue;
      const k = `${rx.post_id}|${rx.key}`;
      let g = groups.get(k);
      if (!g) { g = { post: rx.post_id, key: rx.key, n: 0, sum: 0 }; groups.set(k, g); }
      g.n++;
      g.sum += rx.value;
    }
    for (const a of [...groups.values()].sort((x, y) => (x.post - y.post) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))) {
      const r = get(a.post);
      if (a.key === 'grade') { r.grade.count = a.n; r.grade.avg = round2(a.sum / a.n); }
      else if (a.key.startsWith('emoji:')) r.emoji[a.key.slice(6)] = withMine ? { count: a.n, mine: false } : { count: a.n };
      else if (a.key in r) r[a.key].count = a.n;
    }
    if (viewerId != null) {
      for (const m of Object.values(E.db.state.reactions)) {
        if (m.user_id !== viewerId || !postIds.has(m.post_id)) continue;
        const r = get(m.post_id);
        if (m.key === 'grade') r.grade.mine = m.value;
        else if (m.key.startsWith('emoji:')) { const e = r.emoji[m.key.slice(6)]; if (e) e.mine = true; }
        else if (m.key in r) r[m.key].mine = true;
      }
    }
    return map;
  }

  function postJson(r, commentCount, reactions) {
    let attachment = null;
    if (r.att_kind) {
      attachment = { kind: r.att_kind, url: r.att_url, name: r.att_name, mime: r.att_mime, size: r.att_size };
      if (r.att_preview) {
        try { attachment.preview = JSON.parse(r.att_preview); } catch { /* ignore corrupt preview */ }
      }
    }
    const a = q.user(r.author_id);
    return {
      id: r.id,
      boardId: r.board_id,
      sectionId: r.section_id,
      author: userJson(a),
      title: r.title,
      body: r.body,
      color: r.color,
      pinned: !!r.pinned,
      status: r.status,
      rank: r.rank,
      x: r.x,
      y: r.y,
      w: r.w,
      attachment,
      commentCount,
      reactions,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * rows: post rows. `mine` is included when a viewer is given (or `withMine` forces it, e.g. the snapshot for an anonymous
   * reader) and omitted for event payloads (viewerId null).
   */
  function buildPosts(rows, viewerId = null, withMine = viewerId != null) {
    if (!rows.length) return [];
    const ids = new Set(rows.map((r) => r.id));
    const counts = new Map();
    for (const c of Object.values(E.db.state.comments)) if (ids.has(c.post_id)) counts.set(c.post_id, (counts.get(c.post_id) ?? 0) + 1);
    const reacts = reactionMap(ids, viewerId, withMine);
    return rows.map((r) => postJson(r, counts.get(r.id) ?? 0, reacts.get(r.id) ?? blankReactions(withMine)));
  }
  /** Raw post JSON by default (event payloads); pass `view` to shape the author for a REST response. */
  function getPostJson(id, viewerId = null, view = null) {
    const row = q.post(id);
    const json = row ? buildPosts([row], viewerId)[0] : null;
    return view ? shapePost(json, view) : json;
  }
  function reactionsOf(postId, viewerId = null) {
    return reactionMap(new Set([postId]), viewerId, viewerId != null).get(postId) ?? blankReactions(viewerId != null);
  }
  const commentJson = (r) => ({ id: r.id, postId: r.post_id, author: userJson(q.user(r.author_id)), body: r.body, createdAt: r.created_at });
  const commentCount = (postId) => Object.values(E.db.state.comments).filter((c) => c.post_id === postId).length;

  /* ───────── access (server/access.js) ───────── */
  /** @returns {{role: string, isOwner: boolean} | null} */
  function effectiveRole(board, userId) {
    if (userId != null) {
      if (board.owner_id === userId) return { role: 'admin', isOwner: true };
      const m = q.member(board.id, userId);
      if (m) return { role: m.role, isOwner: false };
    }
    if (board.visibility === 'link') return { role: board.link_access, isOwner: false };
    return null;
  }
  /** 401 for anonymous, 403 for signed-in users lacking the role. */
  const denied = (c) => (c.user ? forbidden('이 작업을 할 권한이 없어요.') : unauthorized());

  function needBoard(c, slug, min = 'read') {
    const board = q.boardBySlug(slug);
    const acc = board && effectiveRole(board, c.user?.id ?? null);
    if (!acc) throw notFound('보드를 찾을 수 없어요.');
    if (min !== 'read' && !c.user) throw unauthorized(); // every write needs an account (guests count)
    if (!atLeast(acc.role, min)) throw denied(c);
    return { board, role: acc.role, isOwner: acc.isOwner };
  }
  function needUser(c) {
    if (!c.user) throw unauthorized();
    return c.user;
  }
  /** Pending posts are only visible to moderators and the author. */
  const canSeePost = (post, role, userId) => post.status !== 'pending' || atLeast(role, 'moderate') || (userId != null && post.author_id === userId);

  function needPost(c, id, min = 'read') {
    const post = q.post(E.toId(id));
    if (!post) throw notFound('게시물을 찾을 수 없어요.');
    const board = q.board(post.board_id);
    const acc = board && effectiveRole(board, c.user?.id ?? null);
    if (!acc || !canSeePost(post, acc.role, c.user?.id ?? null)) throw notFound('게시물을 찾을 수 없어요.');
    if (min !== 'read' && !c.user) throw unauthorized();
    if (!atLeast(acc.role, min)) throw denied(c);
    return { post, board, role: acc.role, isOwner: acc.isOwner };
  }
  /** Edit/delete/move rule: own post needs write, someone else's needs moderate. */
  function needPostEdit(c, acc) {
    if (!c.user) throw unauthorized();
    const own = acc.post.author_id === c.user.id;
    if (!atLeast(acc.role, own ? 'write' : 'moderate')) throw denied(c);
    return own;
  }
  /** After an await (request body, link preview, upload): the session may have been revoked or expired meanwhile. */
  function recheckSession(c) {
    const s = c.tokenHash && E.db.state.sessions[c.tokenHash];
    if (c.tokenHash && !(s && s.expires_at > Date.now())) throw unauthorized();
  }
  /** Event audience for a post: everyone, or (pending) moderators + author only. */
  function postAudience(post) {
    if (post.status !== 'pending') return undefined;
    const authorId = post.author_id ?? post.author?.id;
    return (conn) => conn.canMod || (conn.userId != null && conn.userId === authorId);
  }

  Object.assign(E, {
    userJson, parseSettings, ANON_AUTHOR, PUBLIC_VIEW, FULL_VIEW, viewerFor, shapeUser, shapeAuthor, shapePost, shapeComment,
    shapeBoard, boardJson, sectionJson, touchBoard, buildPosts, getPostJson, reactionsOf, commentJson, commentCount,
    effectiveRole, denied, needBoard, needUser, canSeePost, needPost, needPostEdit, recheckSession, postAudience,
  });
})((self.EDU = self.EDU || {}));
