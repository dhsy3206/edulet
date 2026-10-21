// Reactions (like / vote / star / grade / emoji). CONTRACT §5.
import { EMOJIS } from './constants.js';
import { HttpError, bad } from './http.js';
import { limitWrites, needPost, postAudience } from './access.js';
import { parseSettings, reactionsOf } from './views.js';

const strip = (s) => String(s).replace(/️/g, '');

export function registerReactions(app) {
  const { db, router } = app;

  router.add('PUT', '/posts/:id/reactions', async (c) => {
    const { post, board } = needPost(c, c.params.id, 'comment');
    limitWrites(c);
    const b = await c.body();
    const kind = b.kind;
    if (!['like', 'vote', 'star', 'grade', 'emoji'].includes(kind)) throw bad('bad_request', '반응 종류가 올바르지 않아요.');
    if (parseSettings(board.settings).reactions !== kind) throw new HttpError(400, 'reaction_disabled', '이 보드에서는 쓸 수 없는 반응이에요.');
    const uid = c.user.id;

    db.tx(() => {
      const toggle = (key, value = 1) => {
        const has = db.get('SELECT 1 AS x FROM reactions WHERE post_id = ? AND user_id = ? AND key = ?', post.id, uid, key);
        if (has) db.run('DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND key = ?', post.id, uid, key);
        else db.run('INSERT INTO reactions (post_id, user_id, key, value) VALUES (?,?,?,?)', post.id, uid, key, value);
      };
      if (kind === 'grade') {
        const v = b.value === undefined || b.value === null ? 0 : Number(b.value);
        if (!Number.isInteger(v) || v < 0 || v > 10) throw bad('bad_request', '점수는 1–10 사이여야 해요.');
        const cur = db.get('SELECT value FROM reactions WHERE post_id = ? AND user_id = ? AND key = ?', post.id, uid, 'grade');
        if (v === 0 || (cur && cur.value === v)) db.run('DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND key = ?', post.id, uid, 'grade');
        else if (cur) db.run('UPDATE reactions SET value = ? WHERE post_id = ? AND user_id = ? AND key = ?', v, post.id, uid, 'grade');
        else db.run('INSERT INTO reactions (post_id, user_id, key, value) VALUES (?,?,?,?)', post.id, uid, 'grade', v);
      } else if (kind === 'emoji') {
        const emoji = typeof b.value === 'string' ? EMOJIS.find((e) => strip(e) === strip(b.value)) : null;
        if (!emoji) throw bad('bad_request', '쓸 수 없는 이모지예요.');
        toggle('emoji:' + emoji);
      } else {
        toggle(kind);
      }
    });

    c.emit(board.id, 'reaction.updated', { postId: post.id, reactions: reactionsOf(db, post.id), by: uid }, postAudience(post));
    return { reactions: reactionsOf(db, post.id, uid) };
  });
}
