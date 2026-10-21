// Sections (shelf columns / rows lines). CONTRACT §5 "섹션".
import { LIMITS, atLeast } from './constants.js';
import { bad, notFound, unauthorized } from './http.js';
import { effectiveRole, denied, needBoard, postAudience } from './access.js';
import { bodyId, needLine, now, toId } from './util.js';
import { getPostJson, sectionJson, touchBoard } from './views.js';
import { planPlacement } from './rank.js';

export function registerSections(app) {
  const { db, router } = app;

  /** Load a section, require moderate on its board (404 if the board is not viewable). */
  function needSection(c, id) {
    const section = db.get('SELECT * FROM sections WHERE id = ?', toId(id));
    const board = section && db.get('SELECT * FROM boards WHERE id = ?', section.board_id);
    const acc = board && effectiveRole(db, board, c.user?.id ?? null);
    if (!acc) throw notFound('섹션을 찾을 수 없어요.');
    if (!c.user) throw unauthorized();
    if (!atLeast(acc.role, 'moderate')) throw denied(c);
    return { section, board };
  }

  /** Place section before `beforeId` (null = end); renumbers the board's sections when the gap collapses. */
  function place(boardId, sectionId, beforeId) {
    const others = db.all('SELECT id, rank FROM sections WHERE board_id = ? AND id != ? ORDER BY rank, id', boardId, sectionId);
    if (beforeId === sectionId) {
      // "before itself" = keep position
      const all = db.all('SELECT id FROM sections WHERE board_id = ? ORDER BY rank, id', boardId);
      const i = all.findIndex((s) => s.id === sectionId);
      beforeId = all[i + 1]?.id ?? null;
    }
    const plan = planPlacement(others, beforeId, sectionId);
    if (plan.order) plan.order.forEach((id, i) => db.run('UPDATE sections SET rank = ? WHERE id = ?', i + 1, id));
    else db.run('UPDATE sections SET rank = ? WHERE id = ?', plan.rank, sectionId);
    return plan.order;
  }

  router.add('POST', '/boards/:slug/sections', async (c) => {
    const { board } = needBoard(c, c.params.slug, 'moderate');
    const b = await c.body();
    const title = needLine(b.title, '섹션 이름', 1, LIMITS.sectionTitle);
    const beforeId = b.beforeId == null ? null : bodyId(b.beforeId, 'beforeId');
    const { id, renumbered } = db.tx(() => {
      const nid = db.run('INSERT INTO sections (board_id, title, rank) VALUES (?,?,0)', board.id, title).id;
      const order = place(board.id, nid, beforeId);
      touchBoard(db, board.id);
      return { id: nid, renumbered: order };
    });
    const section = sectionJson(db.get('SELECT * FROM sections WHERE id = ?', id));
    c.emit(board.id, 'section.created', { section });
    for (const sid of renumbered ?? []) if (sid !== id) c.emit(board.id, 'section.moved', { section: sectionJson(db.get('SELECT * FROM sections WHERE id = ?', sid)) });
    return c.json({ section }, 201);
  });

  router.add('PATCH', '/sections/:id', async (c) => {
    const { section, board } = needSection(c, c.params.id);
    const b = await c.body();
    const title = needLine(b.title, '섹션 이름', 1, LIMITS.sectionTitle);
    db.run('UPDATE sections SET title = ? WHERE id = ?', title, section.id);
    const out = sectionJson(db.get('SELECT * FROM sections WHERE id = ?', section.id));
    c.emit(board.id, 'section.updated', { section: out });
    return { section: out };
  });

  router.add('POST', '/sections/:id/move', async (c) => {
    const { section, board } = needSection(c, c.params.id);
    const b = await c.body();
    if (!('beforeId' in b)) throw bad('bad_request', 'beforeId 가 필요해요.');
    const beforeId = b.beforeId == null ? null : bodyId(b.beforeId, 'beforeId');
    const order = db.tx(() => {
      const o = place(board.id, section.id, beforeId);
      touchBoard(db, board.id);
      return o;
    });
    const out = sectionJson(db.get('SELECT * FROM sections WHERE id = ?', section.id));
    c.emit(board.id, 'section.moved', { section: out });
    for (const sid of order ?? []) if (sid !== section.id) c.emit(board.id, 'section.moved', { section: sectionJson(db.get('SELECT * FROM sections WHERE id = ?', sid)) });
    return { section: out };
  });

  router.add('DELETE', '/sections/:id', async (c) => {
    const { section, board } = needSection(c, c.params.id);
    const mode = c.query.posts === 'delete' ? 'delete' : c.query.posts === undefined || c.query.posts === 'move' ? 'move' : null;
    if (!mode) throw bad('bad_request', 'posts 는 delete 또는 move 여야 해요.');
    const affected = db.tx(() => {
      const posts = db.all('SELECT id, status, author_id FROM posts WHERE section_id = ? ORDER BY rank, id', section.id);
      if (mode === 'move') {
        const target = db.get('SELECT id FROM sections WHERE board_id = ? AND id != ? ORDER BY rank, id LIMIT 1', board.id, section.id);
        const targetId = target?.id ?? null;
        let rank = db.get('SELECT MAX(rank) AS m FROM posts WHERE board_id = ? AND section_id IS ? AND (section_id IS NULL OR section_id != ?)', board.id, targetId, section.id).m ?? 0;
        for (const p of posts) db.run('UPDATE posts SET section_id = ?, rank = ?, updated_at = ? WHERE id = ?', targetId, ++rank, now(), p.id);
      } else {
        db.run('DELETE FROM posts WHERE section_id = ?', section.id);
      }
      db.run('DELETE FROM sections WHERE id = ?', section.id);
      touchBoard(db, board.id);
      return posts;
    });
    c.emit(board.id, 'section.deleted', { id: section.id, mode });
    for (const p of affected) {
      if (mode === 'delete') c.emit(board.id, 'post.deleted', { id: p.id }, postAudience(p));
      else {
        const post = getPostJson(db, p.id);
        c.emit(board.id, 'post.updated', { post }, postAudience(post));
      }
    }
    return { ok: true };
  });
}
