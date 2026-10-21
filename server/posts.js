// Posts: create / update / delete / move / approve. CONTRACT §5 "게시물".
import { ATTACH_KINDS, IMAGE_MIMES, LIMITS, POST_COLORS, atLeast, isSectioned } from './constants.js';
import { HttpError, bad } from './http.js';
import { needBoard, needPost, needPostEdit, postAudience, denied, canSeePost, limitWrites, recheckSession } from './access.js';
import { bodyId, finite, normalizeUrl, now, optBlock, optLine, oneOf, uploadUrl } from './util.js';
import { getPostJson, parseSettings, touchBoard, viewerFor } from './views.js';
import { edgeRank, planPlacement } from './rank.js';
import { releaseUploads, uploadIdsOfPosts } from './uploads.js';

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
    // never throws, never blocks saving; the preview service enforces the per-user / per-host / in-flight limits itself
    const pv = await app.preview.safeResolve(url, { userId: c.user.id });
    return {
      ...NO_ATT,
      att_kind: kind === 'link' && pv.kind === 'video' ? 'video' : kind,
      att_url: url,
      att_preview: JSON.stringify(pickPreview(pv)),
    };
  }

  /** @returns {number|null|undefined} section id, null (not sectioned), undefined = "no section given, caller decides" */
  function sectionOf(board, sectionId) {
    if (!isSectioned(board.format)) return null;
    if (sectionId == null) return undefined;
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

  /** Re-run the authorisation of an edit/move after an await: the post may be gone, hidden, or the role/session changed. */
  const reauthorize = (c) => {
    const acc = needPost(c, c.params.id, 'read');
    needPostEdit(c, acc);
    recheckSession(c);
    return acc;
  };

  router.add('POST', '/boards/:slug/posts', async (c) => {
    const first = needBoard(c, c.params.slug, 'write');
    limitWrites(c);
    const b = await c.body();
    const title = optLine(b.title, '제목', LIMITS.postTitle);
    const body = optBlock(b.body, '내용', LIMITS.postBody);
    const color = validColor(b.color);
    const geo = {};
    geometry(b, geo);
    sectionOf(first.board, b.sectionId); // fail fast on a bad section before any slow work
    const att = await resolveAttachment(c, first.board, b.attachment);
    if (!title && !body && !att.att_kind) throw bad('empty_post', '제목, 내용, 첨부 중 하나는 있어야 해요.');
    const t = now();
    const { id, board, role } = db.tx(() => {
      // The awaits above can take seconds (slow body, link preview): authorise again against the CURRENT state.
      const cur = needBoard(c, c.params.slug, 'write'); // 404 when the board is gone, 403/404 when the member was removed
      recheckSession(c);
      const { board: bd, role: rl } = cur;
      const settings = parseSettings(bd.settings);
      if (db.get('SELECT COUNT(*) AS n FROM posts WHERE board_id = ?', bd.id).n >= app.config.boardMaxPosts) {
        throw new HttpError(409, 'board_full', '이 보드에는 더 이상 게시물을 올릴 수 없어요.');
      }
      let sectionId = sectionOf(bd, b.sectionId);
      if (sectionId === undefined) {
        sectionId = db.get('SELECT id FROM sections WHERE board_id = ? ORDER BY rank, id LIMIT 1', bd.id)?.id ?? null;
      }
      const r = db.get('SELECT MIN(rank) AS lo, MAX(rank) AS hi FROM posts WHERE board_id = ? AND section_id IS ?', bd.id, sectionId);
      const rank = edgeRank(r.lo, r.hi, settings.newPostPosition);
      const status = settings.approval && rl === 'write' ? 'pending' : 'published';
      const pid = db.run(
        `INSERT INTO posts (board_id, section_id, author_id, title, body, color, pinned, status, rank, x, y, w,
                            att_kind, att_url, att_name, att_mime, att_size, att_preview, created_at, updated_at)
         VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        bd.id, sectionId, c.user.id, title, body, color, status, rank, geo.x ?? null, geo.y ?? null, geo.w ?? null,
        att.att_kind, att.att_url, att.att_name, att.att_mime, att.att_size, att.att_preview, t, t,
      ).id;
      touchBoard(db, bd.id, t);
      return { id: pid, board: bd, role: rl };
    });
    sendPost(c, 'post.created', getPostJson(db, id));
    return c.json({ post: getPostJson(db, id, c.user.id, viewerFor(board, role, c.user.id)) }, 201);
  });

  router.add('PATCH', '/posts/:id', async (c) => {
    const acc = needPost(c, c.params.id, 'read');
    needPostEdit(c, acc);
    limitWrites(c);
    const b = await c.body();
    const want = {};
    if (b.title !== undefined) want.title = optLine(b.title, '제목', LIMITS.postTitle);
    if (b.body !== undefined) want.body = optBlock(b.body, '내용', LIMITS.postBody);
    if (b.color !== undefined) want.color = validColor(b.color);
    if (b.pinned !== undefined) {
      if (typeof b.pinned !== 'boolean') throw bad('bad_request', '고정 값이 올바르지 않아요.');
      if (!atLeast(acc.role, 'moderate')) throw denied(c);
      want.pinned = b.pinned ? 1 : 0;
    }
    geometry(b, want);
    if (b.sectionId !== undefined && b.sectionId !== null && isSectioned(acc.board.format)) sectionOf(acc.board, b.sectionId); // fail fast
    const att = b.attachment !== undefined ? await resolveAttachment(c, acc.board, b.attachment) : undefined;

    const out = db.tx(() => {
      const { post, board, role } = reauthorize(c); // after the awaits: the world may have changed
      const sets = { ...want };
      if ('pinned' in sets && !atLeast(role, 'moderate')) throw denied(c);
      let moveTo;
      if (b.sectionId !== undefined && isSectioned(board.format)) {
        moveTo = b.sectionId === null ? null : sectionOf(board, b.sectionId);
        if (moveTo === post.section_id) moveTo = undefined;
      }
      if (att) Object.assign(sets, att);
      const nextTitle = sets.title ?? post.title;
      const nextBody = sets.body ?? post.body;
      const nextAtt = 'att_kind' in sets ? sets.att_kind : post.att_kind;
      if (!nextTitle && !nextBody && !nextAtt) throw bad('empty_post', '제목, 내용, 첨부 중 하나는 있어야 해요.');
      // Approval boards: a content edit by someone below `moderate` sends the post back to review. Position, colour,
      // pin, section and reactions do not.
      const contentChanged =
        (sets.title !== undefined && sets.title !== post.title) ||
        (sets.body !== undefined && sets.body !== post.body) ||
        (att !== undefined && (att.att_kind !== post.att_kind || att.att_url !== post.att_url || att.att_name !== post.att_name));
      const repending = parseSettings(board.settings).approval && !atLeast(role, 'moderate') && contentChanged && post.status === 'published';
      if (repending) sets.status = 'pending';
      if (moveTo !== undefined) {
        const m = db.get('SELECT MAX(rank) AS hi FROM posts WHERE board_id = ? AND section_id IS ? AND id != ?', board.id, moveTo, post.id);
        sets.section_id = moveTo;
        sets.rank = (m.hi ?? 0) + 1;
      }
      sets.updated_at = now();
      const cols = Object.keys(sets);
      db.run(`UPDATE posts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => sets[k]), post.id);
      touchBoard(db, board.id);
      return { post, board, role, repending };
    });
    const { post, board, role, repending } = out;
    const json = getPostJson(db, post.id);
    if (repending) {
      // Hidden from everyone but moderators and the author, exactly like a new pending post: they learn of the edit,
      // all other connections learn that the card is gone.
      const privileged = postAudience({ status: 'pending', author_id: post.author_id });
      c.emit(board.id, 'post.updated', { post: json }, privileged);
      c.emit(board.id, 'post.deleted', { id: post.id }, (conn) => !privileged(conn));
    } else {
      sendPost(c, 'post.updated', json);
    }
    // a replaced attachment may have been the last reference to an uploaded file
    if (att !== undefined) releaseUploads(app, uploadIdsOfPosts([post]));
    return { post: getPostJson(db, post.id, c.user.id, viewerFor(board, role, c.user.id)) };
  });

  router.add('DELETE', '/posts/:id', async (c) => {
    const acc = needPost(c, c.params.id, 'read');
    needPostEdit(c, acc);
    limitWrites(c);
    const { post, board } = acc;
    db.tx(() => {
      db.run('DELETE FROM posts WHERE id = ?', post.id);
      touchBoard(db, board.id);
    });
    c.emit(board.id, 'post.deleted', { id: post.id }, postAudience(post));
    releaseUploads(app, uploadIdsOfPosts([post]));
    return { ok: true };
  });

  router.add('POST', '/posts/:id/move', async (c) => {
    const acc0 = needPost(c, c.params.id, 'read');
    needPostEdit(c, acc0);
    limitWrites(c);
    const b = await c.body();
    const out = db.tx(() => {
      const { post, board, role } = reauthorize(c);
      let target = post.section_id;
      if ('sectionId' in b) {
        if (!isSectioned(board.format)) target = null;
        else if (b.sectionId === null) target = null;
        else target = sectionOf(board, b.sectionId);
      }
      let beforeId = b.beforeId == null ? null : bodyId(b.beforeId, 'beforeId');
      const list = db.all('SELECT id, rank, status, author_id FROM posts WHERE board_id = ? AND section_id IS ? ORDER BY rank, id', board.id, target);
      // A neighbour the caller cannot see (someone else's pending post) must look exactly like one that does not exist.
      if (beforeId != null && beforeId !== post.id && !list.some((p) => p.id === beforeId && canSeePost(p, role, c.user.id))) {
        throw bad('bad_request', '기준 위치를 찾을 수 없어요.');
      }
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
      return { post, board, role, renumbered: plan.order ? plan.order.filter((pid) => pid !== post.id) : [] };
    });
    const { post, board, role, renumbered } = out;
    sendPost(c, 'post.moved', getPostJson(db, post.id));
    for (const pid of renumbered) sendPost(c, 'post.updated', getPostJson(db, pid));
    return { post: getPostJson(db, post.id, c.user.id, viewerFor(board, role, c.user.id)) };
  });

  router.add('POST', '/posts/:id/approve', async (c) => {
    const acc = needPost(c, c.params.id, 'moderate');
    limitWrites(c);
    const { post, board, role } = acc;
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
    return { post: getPostJson(db, post.id, c.user.id, viewerFor(board, role, c.user.id)) };
  });
}
