/* Edulet demo server — sections, posts, comments, reactions (server/{sections,posts,comments,reactions}.js). CONTRACT §5.
 * NOTE for porters: state rows are live objects (SQL returned copies) — take a copy before mutating when the old value is needed. */
(function (E) {
  'use strict';
  const { C, atLeast, isSectioned, HttpError, bad, notFound, unauthorized, needLine, now, oneOf, optBlock, optLine, bodyId, finite, toId } = E;
  const { q, insert, deletePosts } = E.db;
  const { router } = E;

  /** Text with zero-width / bidi-control characters removed: a title made only of those is still empty. */
  const visibleText = (s) => String(s ?? '').replace(/[\u200B-\u200F\u2060\uFEFF\u202A-\u202E]/g, '').trim();
  const maxRank = (rows) => (rows.length ? Math.max(...rows.map((r) => r.rank)) : 0); // SQL MAX() of nothing → NULL → 0

  /* ═════════════════════════ sections ═════════════════════════ */
  /** Load a section, require moderate on its board (404 if the board is not viewable). */
  function needSection(c, id) {
    const section = q.section(toId(id));
    const board = section && q.board(section.board_id);
    const acc = board && E.effectiveRole(board, c.user?.id ?? null);
    if (!acc) throw notFound('섹션을 찾을 수 없어요.');
    if (!c.user) throw unauthorized();
    if (!atLeast(acc.role, 'moderate')) throw E.denied(c);
    return { section, board };
  }

  /** Place section before `beforeId` (null = end); renumbers the board's sections when the gap collapses. */
  function place(boardId, sectionId, beforeId) {
    const others = q.sectionsOf(boardId).filter((s) => s.id !== sectionId);
    if (beforeId === sectionId) {
      const all = q.sectionsOf(boardId); // "before itself" = keep position
      const i = all.findIndex((s) => s.id === sectionId);
      beforeId = all[i + 1]?.id ?? null;
    }
    const plan = E.planPlacement(others, beforeId, sectionId);
    if (plan.order) plan.order.forEach((id, i) => { q.section(id).rank = i + 1; });
    else q.section(sectionId).rank = plan.rank;
    return plan.order;
  }

  router.add('POST', '/boards/:slug/sections', async (c) => {
    const { board } = E.needBoard(c, c.params.slug, 'moderate');
    const b = await c.body();
    const title = needLine(b.title, '섹션 이름', 1, C.LIMITS.sectionTitle);
    const beforeId = b.beforeId == null ? null : bodyId(b.beforeId, 'beforeId');
    const sec = insert('sections', { board_id: board.id, title, rank: 0 });
    let order;
    try {
      order = place(board.id, sec.id, beforeId);
    } catch (e) {
      E.db.uninsert('sections', sec); // a bad beforeId must not leave the half-made section behind (nor use up an id, like a rolled-back SQL insert)
      throw e;
    }
    E.touchBoard(board.id);
    const section = E.sectionJson(sec);
    c.emit(board.id, 'section.created', { section });
    for (const sid of order ?? []) if (sid !== sec.id) c.emit(board.id, 'section.moved', { section: E.sectionJson(q.section(sid)) });
    c.json({ section }, 201);
  });

  router.add('PATCH', '/sections/:id', async (c) => {
    const { section, board } = needSection(c, c.params.id);
    const b = await c.body();
    section.title = needLine(b.title, '섹션 이름', 1, C.LIMITS.sectionTitle);
    const out = E.sectionJson(section);
    c.emit(board.id, 'section.updated', { section: out });
    return { section: out };
  });

  router.add('POST', '/sections/:id/move', async (c) => {
    const { section, board } = needSection(c, c.params.id);
    const b = await c.body();
    if (!('beforeId' in b)) throw bad('bad_request', 'beforeId 가 필요해요.');
    const beforeId = b.beforeId == null ? null : bodyId(b.beforeId, 'beforeId');
    const order = place(board.id, section.id, beforeId);
    E.touchBoard(board.id);
    const out = E.sectionJson(section);
    c.emit(board.id, 'section.moved', { section: out });
    for (const sid of order ?? []) if (sid !== section.id) c.emit(board.id, 'section.moved', { section: E.sectionJson(q.section(sid)) });
    return { section: out };
  });

  router.add('DELETE', '/sections/:id', async (c) => {
    const { section, board } = needSection(c, c.params.id);
    const mode = c.query.posts === 'delete' ? 'delete' : c.query.posts === undefined || c.query.posts === 'move' ? 'move' : null;
    if (!mode) throw bad('bad_request', 'posts 는 delete 또는 move 여야 해요.');
    const posts = q.postsOf(board.id).filter((p) => p.section_id === section.id).sort(q.byRankId);
    const affected = posts.map((p) => ({ ...p })); // pre-image: ids, status, author, attachments
    if (mode === 'move') {
      const target = q.sectionsOf(board.id).find((s) => s.id !== section.id);
      const targetId = target?.id ?? null;
      let rank = maxRank(q.postsIn(board.id, targetId));
      for (const p of posts) { p.section_id = targetId; p.rank = ++rank; p.updated_at = now(); }
    } else {
      deletePosts(posts.map((p) => p.id));
    }
    delete E.db.state.sections[section.id];
    E.touchBoard(board.id);
    c.emit(board.id, 'section.deleted', { id: section.id, mode });
    for (const p of affected) {
      if (mode === 'delete') c.emit(board.id, 'post.deleted', { id: p.id }, E.postAudience(p));
      else {
        const post = E.getPostJson(p.id);
        c.emit(board.id, 'post.updated', { post }, E.postAudience(post));
      }
    }
    if (mode === 'delete') E.releaseUploads(E.uploadIdsOfPosts(affected));
    return { ok: true };
  });

  /* ═════════════════════════ posts ═════════════════════════ */
  function pickPreview(pv) {
    const out = { title: pv.title };
    if (pv.description) out.description = pv.description;
    if (pv.image) out.image = pv.image;
    if (pv.site) out.site = pv.site;
    if (pv.embedUrl) out.embedUrl = pv.embedUrl;
    return out;
  }
  const NO_ATT = { att_kind: null, att_url: null, att_name: null, att_mime: null, att_size: null, att_preview: null };

  async function resolveAttachment(c, board, input) {
    if (input == null) return NO_ATT;
    if (typeof input !== 'object' || Array.isArray(input)) throw bad('bad_attachment', '첨부 형식이 올바르지 않아요.');
    const kind = oneOf(input.kind, C.ATTACH_KINDS, '첨부 종류');
    if (input.uploadId != null) {
      if (kind !== 'image' && kind !== 'file') throw bad('bad_attachment', '첨부 형식이 올바르지 않아요.');
      const up = q.upload(String(input.uploadId));
      if (!up || !(up.user_id === c.user.id || up.board_id === board.id)) throw bad('bad_upload', '올린 파일을 찾을 수 없어요.');
      if (kind === 'image' && !C.IMAGE_MIMES.includes(up.mime)) throw bad('bad_attachment', '이미지 파일이 아니에요.');
      return { att_kind: kind, att_url: E.uploadUrl(up.id, up.name), att_name: up.name, att_mime: up.mime, att_size: up.size, att_preview: null };
    }
    const url = E.normalizeUrl(input.url);
    if (kind === 'file') throw bad('bad_attachment', '파일은 먼저 올려야 해요.');
    if (kind === 'image') {
      let name = null;
      try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').slice(0, 100) || null; } catch { name = null; }
      return { ...NO_ATT, att_kind: 'image', att_url: url, att_name: name };
    }
    // never throws, never blocks saving
    const pv = await E.preview.safeResolve(url);
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
    const s = q.section(bodyId(sectionId, 'sectionId'));
    if (!s || s.board_id !== board.id) throw bad('bad_section', '섹션을 찾을 수 없어요.');
    return s.id;
  }
  function validColor(v) {
    if (v == null) return null;
    if (!C.POST_COLORS.includes(v)) throw bad('bad_request', '색 값이 올바르지 않아요.');
    return v;
  }
  function geometry(b, into) {
    if (b.x !== undefined) into.x = b.x === null ? null : finite(b.x, 'x', -100000, 100000);
    if (b.y !== undefined) into.y = b.y === null ? null : finite(b.y, 'y', -100000, 100000);
    if (b.w !== undefined) into.w = b.w === null ? null : finite(b.w, 'w', 80, 4000);
  }
  const sendPost = (c, type, post) => c.emit(post.boardId, type, { post }, E.postAudience(post));

  /** Re-run the authorisation of an edit/move after an await: the post may be gone, hidden, or the role/session changed. */
  function reauthorize(c) {
    const acc = E.needPost(c, c.params.id, 'read');
    E.needPostEdit(c, acc);
    E.recheckSession(c);
    return acc;
  }

  router.add('POST', '/boards/:slug/posts', async (c) => {
    const first = E.needBoard(c, c.params.slug, 'write');
    const b = await c.body();
    const title = optLine(b.title, '제목', C.LIMITS.postTitle);
    const body = optBlock(b.body, '내용', C.LIMITS.postBody);
    const color = validColor(b.color);
    const geo = {};
    geometry(b, geo);
    sectionOf(first.board, b.sectionId); // fail fast on a bad section before any slow work
    const att = await resolveAttachment(c, first.board, b.attachment);
    if (!visibleText(title) && !visibleText(body) && !att.att_kind) throw bad('empty_post', '제목, 내용, 첨부 중 하나는 있어야 해요.');
    const t = now();
    // The await above can take seconds (link preview): authorise again against the CURRENT state.
    const cur = E.needBoard(c, c.params.slug, 'write');
    E.recheckSession(c);
    const { board: bd, role: rl } = cur;
    const settings = E.parseSettings(bd.settings);
    if (q.postsOf(bd.id).length >= C.BOARD_MAX_POSTS) throw new HttpError(409, 'board_full', '이 보드에는 더 이상 게시물을 올릴 수 없어요.');
    let sectionId = sectionOf(bd, b.sectionId);
    if (sectionId === undefined) sectionId = q.sectionsOf(bd.id)[0]?.id ?? null;
    const inList = q.postsIn(bd.id, sectionId);
    const rank = E.edgeRank(inList.length ? Math.min(...inList.map((p) => p.rank)) : null, inList.length ? Math.max(...inList.map((p) => p.rank)) : null, settings.newPostPosition);
    const status = settings.approval && rl === 'write' ? 'pending' : 'published';
    const row = insert('posts', {
      board_id: bd.id, section_id: sectionId, author_id: c.user.id, title, body, color, pinned: 0, status, rank,
      x: geo.x ?? null, y: geo.y ?? null, w: geo.w ?? null, ...att, created_at: t, updated_at: t,
    });
    E.touchBoard(bd.id, t);
    sendPost(c, 'post.created', E.getPostJson(row.id));
    c.json({ post: E.getPostJson(row.id, c.user.id, E.viewerFor(bd, rl, c.user.id)) }, 201);
  });

  router.add('PATCH', '/posts/:id', async (c) => {
    const acc = E.needPost(c, c.params.id, 'read');
    E.needPostEdit(c, acc);
    const b = await c.body();
    const want = {};
    if (b.title !== undefined) want.title = optLine(b.title, '제목', C.LIMITS.postTitle);
    if (b.body !== undefined) want.body = optBlock(b.body, '내용', C.LIMITS.postBody);
    if (b.color !== undefined) want.color = validColor(b.color);
    if (b.pinned !== undefined) {
      if (typeof b.pinned !== 'boolean') throw bad('bad_request', '고정 값이 올바르지 않아요.');
      if (!atLeast(acc.role, 'moderate')) throw E.denied(c);
      want.pinned = b.pinned ? 1 : 0;
    }
    geometry(b, want);
    if (b.sectionId !== undefined && b.sectionId !== null && isSectioned(acc.board.format)) sectionOf(acc.board, b.sectionId); // fail fast
    const att = b.attachment !== undefined ? await resolveAttachment(c, acc.board, b.attachment) : undefined;

    const { post, board, role } = reauthorize(c); // after the await: the world may have changed
    const pre = { ...post }; // old attachment / title / status — the row is updated in place below
    const sets = { ...want };
    if ('pinned' in sets && !atLeast(role, 'moderate')) throw E.denied(c);
    let moveTo;
    if (b.sectionId !== undefined && isSectioned(board.format)) {
      moveTo = b.sectionId === null ? null : sectionOf(board, b.sectionId);
      if (moveTo === post.section_id) moveTo = undefined;
    }
    if (att) Object.assign(sets, att);
    const nextTitle = sets.title ?? post.title;
    const nextBody = sets.body ?? post.body;
    const nextAtt = 'att_kind' in sets ? sets.att_kind : post.att_kind;
    if (!visibleText(nextTitle) && !visibleText(nextBody) && !nextAtt) throw bad('empty_post', '제목, 내용, 첨부 중 하나는 있어야 해요.');
    // Approval boards: a content edit by someone below `moderate` sends the post back to review. Position, colour, pin,
    // section and reactions do not.
    const contentChanged =
      (sets.title !== undefined && sets.title !== post.title) ||
      (sets.body !== undefined && sets.body !== post.body) ||
      (att !== undefined && (att.att_kind !== post.att_kind || att.att_url !== post.att_url || att.att_name !== post.att_name));
    const repending = E.parseSettings(board.settings).approval && !atLeast(role, 'moderate') && contentChanged && post.status === 'published';
    if (repending) sets.status = 'pending';
    if (moveTo !== undefined) {
      sets.section_id = moveTo;
      sets.rank = maxRank(q.postsIn(board.id, moveTo).filter((p) => p.id !== post.id)) + 1;
    }
    sets.updated_at = now();
    Object.assign(post, sets);
    E.touchBoard(board.id);

    const json = E.getPostJson(post.id);
    if (repending) {
      // Hidden from everyone but moderators and the author, exactly like a new pending post: they learn of the edit, all
      // other streams learn that the card is gone.
      const privileged = E.postAudience({ status: 'pending', author_id: post.author_id });
      c.emit(board.id, 'post.updated', { post: json }, privileged);
      c.emit(board.id, 'post.deleted', { id: post.id }, (conn) => !privileged(conn));
    } else {
      sendPost(c, 'post.updated', json);
    }
    // a replaced attachment may have been the last reference to an uploaded file
    if (att !== undefined) E.releaseUploads(E.uploadIdsOfPosts([pre]));
    return { post: E.getPostJson(post.id, c.user.id, E.viewerFor(board, role, c.user.id)) };
  });

  router.add('DELETE', '/posts/:id', async (c) => {
    const acc = E.needPost(c, c.params.id, 'read');
    E.needPostEdit(c, acc);
    const { post, board } = acc;
    const pre = { ...post };
    deletePosts([post.id]);
    E.touchBoard(board.id);
    c.emit(board.id, 'post.deleted', { id: post.id }, E.postAudience(pre));
    E.releaseUploads(E.uploadIdsOfPosts([pre]));
    return { ok: true };
  });

  router.add('POST', '/posts/:id/move', async (c) => {
    const acc0 = E.needPost(c, c.params.id, 'read');
    E.needPostEdit(c, acc0);
    const b = await c.body();
    const { post, board, role } = reauthorize(c);
    let target = post.section_id;
    if ('sectionId' in b) {
      if (!isSectioned(board.format)) target = null;
      else if (b.sectionId === null) target = null;
      else target = sectionOf(board, b.sectionId);
    }
    let beforeId = b.beforeId == null ? null : bodyId(b.beforeId, 'beforeId');
    const list = q.postsIn(board.id, target);
    // A neighbour the caller cannot see (someone else's pending post) must look exactly like one that does not exist.
    if (beforeId != null && beforeId !== post.id && !list.some((p) => p.id === beforeId && E.canSeePost(p, role, c.user.id))) {
      throw bad('bad_request', '기준 위치를 찾을 수 없어요.');
    }
    if (beforeId === post.id) {
      // "before itself": keep the slot (only meaningful inside the same section)
      const i = list.findIndex((p) => p.id === post.id);
      if (i < 0) throw bad('bad_request', '기준 위치를 찾을 수 없어요.');
      beforeId = list[i + 1]?.id ?? null;
    }
    const others = list.filter((p) => p.id !== post.id);
    const plan = E.planPlacement(others, beforeId, post.id);
    const t = now();
    if (plan.order) {
      plan.order.forEach((pid, i) => { const r = q.post(pid); r.rank = i + 1; r.section_id = target; r.updated_at = t; });
    } else {
      post.rank = plan.rank;
      post.section_id = target;
      post.updated_at = t;
    }
    E.touchBoard(board.id, t);
    const renumbered = plan.order ? plan.order.filter((pid) => pid !== post.id) : [];
    sendPost(c, 'post.moved', E.getPostJson(post.id));
    for (const pid of renumbered) sendPost(c, 'post.updated', E.getPostJson(pid));
    return { post: E.getPostJson(post.id, c.user.id, E.viewerFor(board, role, c.user.id)) };
  });

  router.add('POST', '/posts/:id/approve', async (c) => {
    const acc = E.needPost(c, c.params.id, 'moderate');
    const { post, board, role } = acc;
    if (post.status === 'pending') {
      post.status = 'published';
      post.updated_at = now();
      E.touchBoard(board.id);
      const json = E.getPostJson(post.id);
      const knew = E.postAudience({ status: 'pending', author_id: post.author_id });
      // Moderators and the author already hold the pending card -> update; everyone else learns of it now.
      c.emit(board.id, 'post.updated', { post: json }, knew);
      c.emit(board.id, 'post.created', { post: json }, (conn) => !knew(conn));
    }
    return { post: E.getPostJson(post.id, c.user.id, E.viewerFor(board, role, c.user.id)) };
  });

  /* ═════════════════════════ comments ═════════════════════════ */
  router.add('GET', '/posts/:id/comments', async (c) => {
    const { post, board, role } = E.needPost(c, c.params.id, 'read');
    const view = E.viewerFor(board, role, c.user?.id ?? null);
    return { comments: q.commentsOf(post.id).map((r) => E.shapeComment(E.commentJson(r), view)) };
  });

  router.add('POST', '/posts/:id/comments', async (c) => {
    const { post, board, role } = E.needPost(c, c.params.id, 'comment');
    if (E.parseSettings(board.settings).comments === 'off') throw new HttpError(403, 'comments_disabled', '이 보드는 댓글을 쓸 수 없어요.');
    const b = await c.body();
    const body = optBlock(b.body, '댓글', C.LIMITS.comment);
    if (!body) throw bad('empty_comment', '댓글 내용을 써 주세요.');
    const row = insert('comments', { post_id: post.id, author_id: c.user.id, body, created_at: now() });
    const comment = E.commentJson(row);
    const count = E.commentCount(post.id);
    c.emit(board.id, 'comment.created', { postId: post.id, comment, commentCount: count }, E.postAudience(post));
    c.json({ comment: E.shapeComment(comment, E.viewerFor(board, role, c.user.id)), commentCount: count }, 201);
  });

  router.add('DELETE', '/comments/:id', async (c) => {
    const gone = () => new HttpError(404, 'not_found', '댓글을 찾을 수 없어요.');
    const cm = q.comment(toId(c.params.id));
    if (!cm) throw gone();
    let acc;
    try { acc = E.needPost(c, cm.post_id, 'read'); } catch (e) {
      // a comment in a board/post the caller cannot see must look exactly like a comment that does not exist
      throw e instanceof HttpError && e.status === 404 ? gone() : e;
    }
    if (!c.user) throw unauthorized();
    const own = cm.author_id === c.user.id;
    if (!own && !atLeast(acc.role, 'moderate')) throw E.denied(c);
    delete E.db.state.comments[cm.id];
    const count = E.commentCount(cm.post_id);
    c.emit(acc.board.id, 'comment.deleted', { postId: cm.post_id, id: cm.id, commentCount: count }, E.postAudience(acc.post));
    return { commentCount: count };
  });

  /* ═════════════════════════ reactions ═════════════════════════ */
  const strip = (s) => String(s).replace(/\uFE0F/g, '');

  // Current reactions incl. the caller's own state — lets a second tab of the same user catch up after another tab reacted.
  router.add('GET', '/posts/:id/reactions', async (c) => {
    const { post } = E.needPost(c, c.params.id, 'read');
    return { reactions: E.reactionsOf(post.id, c.user ? c.user.id : 0) }; // 0 = nobody: `mine` present but false
  });

  router.add('PUT', '/posts/:id/reactions', async (c) => {
    const { post, board } = E.needPost(c, c.params.id, 'comment');
    const b = await c.body();
    const kind = b.kind;
    if (!['like', 'vote', 'star', 'grade', 'emoji'].includes(kind)) throw bad('bad_request', '반응 종류가 올바르지 않아요.');
    if (E.parseSettings(board.settings).reactions !== kind) throw new HttpError(400, 'reaction_disabled', '이 보드에서는 쓸 수 없는 반응이에요.');
    const uid = c.user.id;
    const rx = E.db.state.reactions;
    const keyOf = (k) => `${post.id}:${uid}:${k}`;
    const toggle = (key, value = 1) => {
      if (rx[keyOf(key)]) delete rx[keyOf(key)];
      else rx[keyOf(key)] = { post_id: post.id, user_id: uid, key, value };
    };
    if (kind === 'grade') {
      const v = b.value === undefined || b.value === null ? 0 : Number(b.value);
      if (!Number.isInteger(v) || v < 0 || v > 10) throw bad('bad_request', '점수는 1–10 사이여야 해요.');
      const cur = rx[keyOf('grade')];
      if (v === 0 || (cur && cur.value === v)) delete rx[keyOf('grade')];
      else if (cur) cur.value = v;
      else rx[keyOf('grade')] = { post_id: post.id, user_id: uid, key: 'grade', value: v };
    } else if (kind === 'emoji') {
      const emoji = typeof b.value === 'string' ? C.EMOJIS.find((e) => strip(e) === strip(b.value)) : null;
      if (!emoji) throw bad('bad_request', '쓸 수 없는 이모지예요.');
      toggle('emoji:' + emoji);
    } else {
      toggle(kind);
    }
    c.emit(board.id, 'reaction.updated', { postId: post.id, reactions: E.reactionsOf(post.id), by: uid }, E.postAudience(post));
    return { reactions: E.reactionsOf(post.id, uid) };
  });
})((self.EDU = self.EDU || {}));
