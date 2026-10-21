// JSON serializers (DB rows -> API shapes). See CONTRACT §5.
import { DEFAULT_SETTINGS, REACTIONS } from './constants.js';

export function userJson(r, p = '') {
  return {
    id: r[p + 'id'],
    username: r[p + 'username'] ?? null,
    displayName: r[p + 'display_name'],
    avatarColor: r[p + 'avatar_color'],
    isGuest: !!r[p + 'is_guest'],
  };
}

export function getUserRow(db, id) {
  return db.get('SELECT id, username, display_name, avatar_color, is_guest FROM users WHERE id = ?', id);
}

export function parseSettings(text) {
  let raw = {};
  try { raw = JSON.parse(text || '{}') || {}; } catch { raw = {}; }
  const s = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in raw && typeof raw[k] === typeof DEFAULT_SETTINGS[k]) s[k] = raw[k];
  if (!REACTIONS.includes(s.reactions)) s.reactions = DEFAULT_SETTINGS.reactions;
  if (!['on', 'off'].includes(s.comments)) s.comments = 'on';
  if (!['top', 'bottom'].includes(s.newPostPosition)) s.newPostPosition = 'top';
  return s;
}

export function boardJson(db, b) {
  const owner = getUserRow(db, b.owner_id);
  return {
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
  };
}

export const sectionJson = (s) => ({ id: s.id, boardId: s.board_id, title: s.title, rank: s.rank });

export function touchBoard(db, boardId, t = Date.now()) {
  db.run('UPDATE boards SET updated_at = ? WHERE id = ?', t, boardId);
}

export const POST_SELECT =
  'SELECT p.*, u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name, ' +
  'u.avatar_color AS a_avatar_color, u.is_guest AS a_is_guest FROM posts p JOIN users u ON u.id = p.author_id';

const round2 = (n) => Math.round(n * 100) / 100;

function blankReactions(withMine) {
  const r = {
    like: { count: 0 }, vote: { count: 0 }, star: { count: 0 },
    grade: { count: 0, avg: 0 }, emoji: {},
  };
  if (withMine) {
    r.like.mine = false; r.vote.mine = false; r.star.mine = false; r.grade.mine = 0;
  }
  return r;
}

function reactionMap(db, scope, viewerId, withMine = viewerId != null) {
  const map = new Map();
  const get = (id) => {
    let r = map.get(id);
    if (!r) { r = blankReactions(withMine); map.set(id, r); }
    return r;
  };
  for (const a of db.all(`SELECT post_id, key, COUNT(*) AS n, AVG(value) AS a FROM reactions WHERE post_id ${scope[0]} GROUP BY post_id, key`, scope[1])) {
    const r = get(a.post_id);
    if (a.key === 'grade') { r.grade.count = a.n; r.grade.avg = round2(a.a); }
    else if (a.key.startsWith('emoji:')) r.emoji[a.key.slice(6)] = withMine ? { count: a.n, mine: false } : { count: a.n };
    else if (a.key in r) r[a.key].count = a.n;
  }
  if (viewerId != null) {
    for (const m of db.all(`SELECT post_id, key, value FROM reactions WHERE user_id = ? AND post_id ${scope[0]}`, viewerId, scope[1])) {
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
  return {
    id: r.id,
    boardId: r.board_id,
    sectionId: r.section_id,
    author: userJson(r, 'a_'),
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
 * rows: POST_SELECT rows. scope: { boardId } (all posts of the board) or { postId }.
 * viewerId: whose `mine` to report. `mine` is included when a viewer is given (or `withMine` forces it, e.g. the
 * snapshot for an anonymous reader) and omitted for event payloads (viewerId null).
 */
export function buildPosts(db, rows, scope, viewerId = null, withMine = viewerId != null) {
  if (!rows.length) return [];
  const sc = scope.boardId != null
    ? ['IN (SELECT id FROM posts WHERE board_id = ?)', scope.boardId]
    : ['= ?', scope.postId];
  const counts = new Map(
    db.all(`SELECT post_id, COUNT(*) AS n FROM comments WHERE post_id ${sc[0]} GROUP BY post_id`, sc[1]).map((r) => [r.post_id, r.n]),
  );
  const reacts = reactionMap(db, sc, viewerId, withMine);
  return rows.map((r) => postJson(r, counts.get(r.id) ?? 0, reacts.get(r.id) ?? blankReactions(withMine)));
}

export function getPostJson(db, id, viewerId = null) {
  const row = db.get(POST_SELECT + ' WHERE p.id = ?', id);
  return row ? buildPosts(db, [row], { postId: id }, viewerId)[0] : null;
}

export function reactionsOf(db, postId, viewerId = null) {
  return (reactionMap(db, ['= ?', postId], viewerId).get(postId)) ?? blankReactions(viewerId != null);
}

export const COMMENT_SELECT =
  'SELECT c.*, u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name, ' +
  'u.avatar_color AS a_avatar_color, u.is_guest AS a_is_guest FROM comments c JOIN users u ON u.id = c.author_id';

export const commentJson = (r) => ({
  id: r.id,
  postId: r.post_id,
  author: userJson(r, 'a_'),
  body: r.body,
  createdAt: r.created_at,
});

export function commentCount(db, postId) {
  return db.get('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?', postId).n;
}
