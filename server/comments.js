// Comments. CONTRACT §5.
import { HttpError, bad, unauthorized } from './http.js';
import { atLeast, LIMITS } from './constants.js';
import { denied, needPost, postAudience } from './access.js';
import { optBlock, now, toId } from './util.js';
import { COMMENT_SELECT, commentCount, commentJson, parseSettings } from './views.js';

export function registerComments(app) {
  const { db, router } = app;

  router.add('GET', '/posts/:id/comments', async (c) => {
    const { post } = needPost(c, c.params.id, 'read');
    const rows = db.all(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.created_at ASC, c.id ASC`, post.id);
    return { comments: rows.map(commentJson) };
  });

  router.add('POST', '/posts/:id/comments', async (c) => {
    const { post, board } = needPost(c, c.params.id, 'comment');
    if (parseSettings(board.settings).comments === 'off') throw new HttpError(403, 'comments_disabled', '이 보드는 댓글을 쓸 수 없어요.');
    const b = await c.body();
    const body = optBlock(b.body, '댓글', LIMITS.comment);
    if (!body) throw bad('empty_comment', '댓글 내용을 써 주세요.');
    const id = db.run('INSERT INTO comments (post_id, author_id, body, created_at) VALUES (?,?,?,?)', post.id, c.user.id, body, now()).id;
    const comment = commentJson(db.get(`${COMMENT_SELECT} WHERE c.id = ?`, id));
    const count = commentCount(db, post.id);
    c.emit(board.id, 'comment.created', { postId: post.id, comment, commentCount: count }, postAudience(post));
    return c.json({ comment, commentCount: count }, 201);
  });

  router.add('DELETE', '/comments/:id', async (c) => {
    const cm = db.get('SELECT * FROM comments WHERE id = ?', toId(c.params.id));
    if (!cm) throw new HttpError(404, 'not_found', '댓글을 찾을 수 없어요.');
    const acc = needPost(c, cm.post_id, 'read');
    if (!c.user) throw unauthorized();
    const own = cm.author_id === c.user.id;
    if (!own && !atLeast(acc.role, 'moderate')) throw denied(c);
    db.run('DELETE FROM comments WHERE id = ?', cm.id);
    const count = commentCount(db, cm.post_id);
    c.emit(acc.board.id, 'comment.deleted', { postId: cm.post_id, id: cm.id, commentCount: count }, postAudience(acc.post));
    return { commentCount: count };
  });
}
