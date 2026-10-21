// Posts: create / update / delete / move / approve. CONTRACT §5 "게시물".
import { ATTACH_KINDS, IMAGE_MIMES, LIMITS, POST_COLORS, atLeast, isSectioned } from './constants.js';
import { bad } from './http.js';
import { needBoard, needPost, needPostEdit, postAudience, denied } from './access.js';
import { bodyId, finite, normalizeUrl, now, optBlock, optLine, oneOf, uploadUrl } from './util.js';
import { getPostJson, parseSettings, touchBoard } from './views.js';
import { edgeRank, planPlacement } from './rank.js';

function pickPreview(pv) {
  const out = { title: pv.title };
  if (pv.description) out.description = pv.description;
  if (pv.image) out.image = pv.image;
  if (pv.site) out.site = pv.site;
  if (pv.embedUrl) out.embedUrl = pv.embedUrl;
  return out;
}

const NO_ATT = { att_kind: null, att_url: null, att_name: null, att_mime: null, att_size: null, att_preview: null };

export function registerPosts(app) {
  const { db, router } = app;

  async function resolveAttachment(c, board, input) {
    if (input == null) return NO_ATT;
    if (typeof input !== 'object' || Array.isArray(input)) throw bad('bad_attachment', '첨부 형식이 올바르지 않아요.');
    const kind = oneOf(input.kind, ATTACH_KINDS, '첨부 종류');
    if (input.uploadId != null) {
      if (kind !== 'image' && kind !== 'file') throw bad('bad_attachment', '첨부 형식이 올바르지 않아요.');
      const up = db.get('SELECT * FROM uploads WHERE id = ?', String(input.uploadId));
      if (!up || !(up.user_id === c.user.id || up.board_id === board.id)) throw bad('bad_upload', '올린 파일을 찾을 수 없어요.');
      if (kind === 'image' && !IMAGE_MIMES.includes(up.mime)) throw bad('bad_attachment', '이미지 파일이 아니에요.');
      return {
        att_kind: kind, att_url: uploadUrl(up.id, up.name), att_name: up.name, att_mime: up.mime, att_size: up.size, att_preview: null,
      };
    }
    const url = normalizeUrl(input.url);
    if (kind === 'file') throw bad('bad_attachment', '파일은 먼저 올려야 해요.');
    if (kind === 'image') {
      let name = null;
      try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').slice(0, 100) || null; } catch { name = null; }
      return { ...NO_ATT, att_kind: 'image', att_url: url, att_name: name };
    }
    const pv = await app.preview.safeResolve(url); // never throws, never blocks saving
    return {
      ...NO_ATT,
      att_kind: kind === 'link' && pv.kind === 'video' ? 'video' : kind,
      att_url: url,
      att_preview: JSON.stringify(pickPreview(pv)),
    };
  }

  function sectionOf(board, sectionId) {
    if (!isSectioned(board.format)) return null;
    if (sectionId == null) return undefined; // caller decides the default
    const s = db.get('SELECT id FROM sections WHERE id = ? AND board_id = ?', bodyId(sectionId, 'sectionId'), board.id);
    if (!s) throw bad('bad_section', '섹션을 찾을 수 없어요.');
    return s.id;
  }

  function validColor(v) {
    if (v == null) return null;
    if (!POST_COLORS.includes(v)) throw bad('bad_request', '색 값이 올바르지 않아요.');
    return v;
  }

  function geometry(b, into) {
    if (b.x !== undefined) into.x = b.x === null ? null : finite(b.x, 'x', -100000, 100000);
    if (b.y !== undefined) into.y = b.y === null ? null : finite(b.y, 'y', -100000, 100000);
    if (b.w !== undefined) into.w = b.w === null ? null : finite(b.w, 'w', 80, 4000);
  }

  function sendPost(c, type, post) {
    c.emit(post.boardId, type, { post }, postAudience(post));
  }

  router.add('POST', '/boards/:slug/posts', async (c) => {
    const { board, role } = needBoard(c, c.params.slug, 'write');
    const b = await c.body();
    const settings = parseSettings(board.settings);
    const title = optLine(b.title, '제목', LIMITS.postTitle);
    const body = optBlock(b.body, '내용', LIMITS.postBody);
    const color = validColor(b.color);
    const geo = {};
    geometry(b, geo);
    let sectionId = sectionOf(board, b.sectionId);
    const att = await resolveAttachment(c, board, b.attachment);
    if (!title && !body && !att.att_kind) throw bad('empty_post', '제목, 내용, 첨부 중 하나는 있어야 해요.');
    const status = settings.approval && role === 'write' ? 'pending' : 'published';
    const t = now();
    const id = db.tx(() => {
      if (sectionId === undefined) {
        sectionId = db.get('SELECT id FROM sections WHERE board_id = ? ORDER BY rank, id LIMIT 1', board.id)?.id ?? null;
      }
      const r = db.get('SELECT MIN(rank) AS lo, MAX(rank) AS hi FROM posts WHERE board_id = ? AND section_id IS ?', board.id, sectionId);
      const rank = edgeRank(r.lo, r.hi, settings.newPostPosition);
      const pid = db.run(
        `INSERT INTO posts (board_id, section_id, author_id, title, body, color, pinned, status, rank, x, y, w,
                            att_kind, att_url, att_name, att_mime, att_size, att_preview, created_at, updated_at)
         VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        board.id, sectionId, c.user.id, title, body, color, status, rank, geo.x ?? null, geo.y ?? null, geo.w ?? null,
        att.att_kind, att.att_url, att.att_name, att.att_mime, att.att_size, att.att_preview, t, t,
      ).id;
      touchBoard(db, board.id, t);
      return pid;
    });
    sendPost(c, 'post.created', getPostJson(db, id));
    return c.json({ post: getPostJson(db, id, c.user.id) }, 201);
  });

  router.add('PATCH', '/posts/:id', async (c) => {
    const acc = needPost(c, c.params.id, 'read');
    needPostEdit(c, acc);
    const { post, board, role } = acc;
    const b = await c.body();
    const sets = {};
    if (b.title !== undefined) sets.title = optLine(b.title, '제목', LIMITS.postTitle);
    if (b.body !== undefined) sets.body = optBlock(b.body, '내용', LIMITS.postBody);
    if (b.color !== undefined) sets.color = validColor(b.color);
    if (b.pinned !== undefined) {
      if (typeof b.pinned !== 'boolean') throw bad('bad_request', '고정 값이 올바르지 않아요.');
      if (!atLeast(role, 'moderate')) throw denied(c);
      sets.pinned = b.pinned ? 1 : 0;
    }
    geometry(b, sets);
    let moveTo;
    if (b.sectionId !== undefined && isSectioned(board.format)) {
      moveTo = b.sectionId === null ? null : sectionOf(board, b.sectionId);
      if (moveTo === post.section_id) moveTo = undefined;
    }
    if (b.attachment !== undefined) Object.assign(sets, await resolveAttachment(c, board, b.attachment));
    const nextTitle = sets.title ?? post.title;
    const nextBody = sets.body ?? post.body;
    const nextAtt = 'att_kind' in sets ? sets.att_kind : post.att_kind;
    if (!nextTitle && !nextBody && !nextAtt) throw bad('empty_post', '제목, 내용, 첨부 중 하나는 있어야 해요.');
    db.tx(() => {
      if (moveTo !== undefined) {
        const m = db.get('SELECT MAX(rank) AS hi FROM posts WHERE board_id = ? AND section_id IS ? AND id != ?', board.id, moveTo, post.id);
        sets.section_id = moveTo;
        sets.rank = (m.hi ?? 0) + 1;
      }
      sets.updated_at = now();
      const cols = Object.keys(sets);
      db.run(`UPDATE posts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => sets[k]), post.id);
      touchBoard(db, board.id);
    });
    sendPost(c, 'post.updated', getPostJson(db, post.id));
    return { post: getPostJson(db, post.id, c.user.id) };
  });

  router.add('DELETE', '/posts/:id', async (c) => {
    const acc = needPost(c, c.params.id, 'read');
    needPostEdit(c, acc);
    const { post, board } = acc;
    db.tx(() => {
      db.run('DELETE FROM posts WHERE id = ?', post.id);
      touchBoard(db, board.id);
    });
    c.emit(board.id, 'post.deleted', { id: post.id }, postAudience(post));
    return { ok: true };
  });

  router.add('POST', '/posts/:id/move', async (c) => {
    const acc = needPost(c, c.params.id, 'read');
    needPostEdit(c, acc);
    const { post, board } = acc;
    const b = await c.body();
    let target = post.section_id;
    if ('sectionId' in b) {
      if (!isSectioned(board.format)) target = null;
      else if (b.sectionId === null) target = null;
      else target = sectionOf(board, b.sectionId);
    }
    let beforeId = b.beforeId == null ? null : bodyId(b.beforeId, 'beforeId');
    const renumbered = db.tx(() => {
      const list = db.all('SELECT id, rank FROM posts WHERE board_id = ? AND section_id IS ? ORDER BY rank, id', board.id, target);
      if (beforeId === post.id) {
        // "before itself": keep the slot (only meaningful inside the same section)
        const i = list.findIndex((p) => p.id === post.id);
        if (i < 0) throw bad('bad_request', '기준 위치를 찾을 수 없어요.');
        beforeId = list[i + 1]?.id ?? null;
      }
      const others = list.filter((p) => p.id !== post.id);
      const plan = planPlacement(others, beforeId, post.id);
      const t = now();
      if (plan.order) plan.order.forEach((pid, i) => db.run('UPDATE posts SET rank = ?, section_id = ?, updated_at = ? WHERE id = ?', i + 1, target, t, pid));
      else db.run('UPDATE posts SET rank = ?, section_id = ?, updated_at = ? WHERE id = ?', plan.rank, target, t, post.id);
      touchBoard(db, board.id, t);
      return plan.order ? plan.order.filter((pid) => pid !== post.id) : [];
    });
    sendPost(c, 'post.moved', getPostJson(db, post.id));
    for (const pid of renumbered) sendPost(c, 'post.updated', getPostJson(db, pid));
    return { post: getPostJson(db, post.id, c.user.id) };
  });

  router.add('POST', '/posts/:id/approve', async (c) => {
    const acc = needPost(c, c.params.id, 'moderate');
    const { post, board } = acc;
    if (post.status === 'pending') {
      db.tx(() => {
        db.run("UPDATE posts SET status = 'published', updated_at = ? WHERE id = ?", now(), post.id);
        touchBoard(db, board.id);
      });
      const json = getPostJson(db, post.id);
      const knew = postAudience({ status: 'pending', author_id: post.author_id });
      // Moderators and the author already hold the pending card -> update; everyone else learns of it now.
      c.emit(board.id, 'post.updated', { post: json }, knew);
      c.emit(board.id, 'post.created', { post: json }, (conn) => !knew(conn));
    }
    return { post: getPostJson(db, post.id, c.user.id) };
  });
}
