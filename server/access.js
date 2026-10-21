// Board/post access resolution (CONTRACT §4). Non-viewable boards surface as 404, never 403.
import { atLeast } from './constants.js';
import { HttpError, notFound, unauthorized, forbidden } from './http.js';
import { toId } from './util.js';

/** @returns {{role: string, isOwner: boolean} | null} */
export function effectiveRole(db, board, userId) {
  if (userId != null) {
    if (board.owner_id === userId) return { role: 'admin', isOwner: true };
    const m = db.get('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?', board.id, userId);
    if (m) return { role: m.role, isOwner: false };
  }
  if (board.visibility === 'link') return { role: board.link_access, isOwner: false };
  return null;
}

export const boardBySlug = (db, slug) => db.get('SELECT * FROM boards WHERE slug = ?', String(slug));

/** 401 for anonymous, 403 for signed-in users lacking the role. */
export function denied(c) {
  return c.user ? forbidden('이 작업을 할 권한이 없어요.') : unauthorized();
}

export function needBoard(c, slug, min = 'read') {
  const board = boardBySlug(c.db, slug);
  const acc = board && effectiveRole(c.db, board, c.user?.id ?? null);
  if (!acc) throw notFound('보드를 찾을 수 없어요.');
  if (min !== 'read' && !c.user) throw unauthorized(); // every write needs an account (guests count)
  if (!atLeast(acc.role, min)) throw denied(c);
  return { board, role: acc.role, isOwner: acc.isOwner };
}

export function needUser(c) {
  if (!c.user) throw unauthorized();
  return c.user;
}

/** Pending posts are only visible to moderators and the author. */
export function canSeePost(post, role, userId) {
  return post.status !== 'pending' || atLeast(role, 'moderate') || (userId != null && post.author_id === userId);
}

export function needPost(c, id, min = 'read') {
  const post = c.db.get('SELECT * FROM posts WHERE id = ?', toId(id));
  if (!post) throw notFound('게시물을 찾을 수 없어요.');
  const board = c.db.get('SELECT * FROM boards WHERE id = ?', post.board_id);
  const acc = effectiveRole(c.db, board, c.user?.id ?? null);
  if (!acc || !canSeePost(post, acc.role, c.user?.id ?? null)) throw notFound('게시물을 찾을 수 없어요.');
  if (min !== 'read' && !c.user) throw unauthorized();
  if (!atLeast(acc.role, min)) throw denied(c);
  return { post, board, role: acc.role, isOwner: acc.isOwner };
}

/** Edit/delete/move rule: own post needs write, someone else's needs moderate. */
export function needPostEdit(c, acc) {
  if (!c.user) throw unauthorized();
  const own = acc.post.author_id === c.user.id;
  if (!atLeast(acc.role, own ? 'write' : 'moderate')) throw denied(c);
  return own;
}

/** Event audience for a post: everyone, or (pending) moderators + author only. */
export function postAudience(post) {
  if (post.status !== 'pending') return undefined;
  const authorId = post.author_id ?? post.author?.id;
  return (conn) => conn.canMod || (conn.userId != null && conn.userId === authorId);
}

export { HttpError };
