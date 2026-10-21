/* Edulet demo server — boards: CRUD, snapshot, duplicate, members, export (server/boards.js). CONTRACT §5 "보드".
 * NOTE for porters: state rows are live objects (SQL returned copies) — take a copy before mutating when the old value is needed. */
(function (E) {
  'use strict';
  const { C, atLeast, isSectioned, HttpError, bad, forbidden, notFound, cpLen, needLine, now, oneOf, optBlock, toId } = E;
  const { q, insert, setMember, delMember, deletePosts } = E.db;
  const { router } = E;

  const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  function newSlug() {
    for (let i = 0; i < 20; i++) {
      let s = '';
      for (let j = 0; j < 10; j++) s += SLUG_ALPHABET[E.randomInt(SLUG_ALPHABET.length)];
      if (!q.boardBySlug(s)) return s;
    }
    throw new Error('slug generation failed');
  }

  /** Board snapshot posts: what this viewer may see (pending: moderators + author only), `mine` for the viewer, authors shaped. */
  function snapshotPosts(board, role, userId) {
    const view = E.viewerFor(board, role, userId);
    const rows = q.postsOf(board.id)
      .sort((a, b) => b.pinned - a.pinned || a.rank - b.rank || a.id - b.id)
      .filter((r) => E.canSeePost(r, role, userId));
    return E.buildPosts(rows, userId, true).map((p) => E.shapePost(p, view));
  }
  /** The viewer of a board's creator/admin: sees login names, nothing is anonymised. */
  const adminView = (userId) => ({ userId, admin: true, anonymize: false });

  const byName = (a, b) => {
    const x = a.display_name.toLowerCase();
    const y = b.display_name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.id - b.id;
  };
  function memberRows(board) {
    const owner = q.user(board.owner_id);
    const rows = q.membersOf(board.id).map((m) => ({ m, u: q.user(m.user_id) })).filter((r) => r.u).sort((a, b) => byName(a.u, b.u));
    return [{ user: E.userJson(owner), role: 'admin', isOwner: true }, ...rows.map((r) => ({ user: E.userJson(r.u), role: r.m.role }))];
  }

  function validateSettings(input, current) {
    if (input === undefined) return current;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw bad('bad_request', '설정 형식이 올바르지 않아요.');
    const s = { ...current };
    if ('reactions' in input) s.reactions = oneOf(input.reactions, C.REACTIONS, '반응');
    if ('comments' in input) s.comments = oneOf(input.comments, ['on', 'off'], '댓글');
    if ('approval' in input) { if (typeof input.approval !== 'boolean') throw bad('bad_request', '승인 설정이 올바르지 않아요.'); s.approval = input.approval; }
    if ('showAuthor' in input) { if (typeof input.showAuthor !== 'boolean') throw bad('bad_request', '작성자 표시 설정이 올바르지 않아요.'); s.showAuthor = input.showAuthor; }
    if ('newPostPosition' in input) s.newPostPosition = oneOf(input.newPostPosition, ['top', 'bottom'], '새 글 위치');
    return s;
  }
  function validWallpaper(v) {
    if (typeof v === 'string' && (C.WALLPAPERS.includes(v) || /^\/uploads\/[0-9a-f]{32}\/[^/?#]{1,300}$/.test(v))) return v;
    throw bad('bad_request', '배경 값이 올바르지 않아요.');
  }

  /** After switching to a sectioned format: guarantee one section and rehome section-less posts. */
  function ensureSectionLayout(board) {
    const secs = q.sectionsOf(board.id);
    let created = null;
    let first = secs[0];
    if (!first) {
      first = insert('sections', { board_id: board.id, title: '섹션 1', rank: 1 });
      created = E.sectionJson(first);
    }
    const orphans = q.postsIn(board.id, null);
    if (orphans.length) {
      const inFirst = q.postsIn(board.id, first.id);
      let rank = inFirst.length ? Math.max(...inFirst.map((p) => p.rank)) : 0; // SQL MAX() of nothing is NULL → 0
      for (const o of orphans) { o.section_id = first.id; o.rank = ++rank; o.updated_at = now(); }
    }
    return { created, moved: orphans.map((o) => o.id) };
  }

  /** Delete a board (posts, sections, comments… cascade) and every uploaded file nothing else references. */
  function deleteBoard(boardId) {
    const board = q.board(boardId);
    const posts = q.postsOf(boardId);
    const ids = E.uploadIdsOfPosts(posts);
    for (const id of E.uploadIdsIn(board?.wallpaper)) ids.add(id);
    for (const u of Object.values(E.db.state.uploads)) if (u.board_id === boardId) ids.add(u.id);
    deletePosts(posts.map((p) => p.id));
    for (const s of q.sectionsOf(boardId)) delete E.db.state.sections[s.id];
    for (const m of q.membersOf(boardId)) delMember(boardId, m.user_id);
    delete E.db.state.boards[boardId];
    E.releaseUploads(ids, { detachFromBoard: boardId });
  }

  /* ───────── export helpers ───────── */
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function attachDisposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  /* ───────── routes ───────── */
  router.add('GET', '/boards', async (c) => {
    const me = E.needUser(c);
    const rows = Object.values(E.db.state.boards)
      .map((b) => ({ b, role: b.owner_id === me.id ? 'admin' : q.member(b.id, me.id)?.role }))
      .filter((r) => r.role)
      .sort((x, y) => y.b.updated_at - x.b.updated_at || y.b.id - x.b.id);
    return {
      boards: rows.map(({ b, role }) => ({
        ...E.boardJson(b, { userId: me.id, admin: role === 'admin', anonymize: false }),
        role,
        isOwner: b.owner_id === me.id,
        postCount: q.postsOf(b.id).filter((p) => p.status === 'published').length,
        memberCount: q.membersOf(b.id).length + 1,
      })),
    };
  });

  router.add('POST', '/boards', async (c) => {
    const me = E.needUser(c);
    if (me.is_guest) throw forbidden('게스트는 보드를 만들 수 없어요. 가입하면 만들 수 있어요.', 'guest_cannot_create');
    const b = await c.body();
    const title = needLine(b.title, '제목', 1, C.LIMITS.boardTitle);
    const description = optBlock(b.description, '설명', C.LIMITS.boardDesc);
    const template = b.template == null ? 'blank' : oneOf(b.template, C.TEMPLATES, '템플릿');
    const def = C.TEMPLATE_DEFS[template];
    const format = b.format == null ? def.format : oneOf(b.format, C.FORMATS, '형식');
    const t = now();
    const board = insert('boards', {
      slug: newSlug(), owner_id: me.id, title, description, format, wallpaper: 'green', font: 'sans', color_scheme: 'light',
      visibility: 'link', link_access: 'comment', settings: JSON.stringify(E.parseSettings('{}')), created_at: t, updated_at: t,
    });
    const titles = def.sections.length ? def.sections : isSectioned(format) ? ['섹션 1'] : [];
    titles.forEach((st, i) => insert('sections', { board_id: board.id, title: st, rank: i + 1 }));
    c.json({ board: E.boardJson(board, adminView(me.id)) }, 201);
  });

  router.add('GET', '/boards/:slug', async (c) => {
    const { board, role, isOwner } = E.needBoard(c, c.params.slug, 'read');
    const uid = c.user?.id ?? null;
    const out = {
      board: E.boardJson(board, E.viewerFor(board, role, uid)),
      role,
      isOwner,
      sections: q.sectionsOf(board.id).map(E.sectionJson),
      posts: snapshotPosts(board, role, uid),
    };
    if (atLeast(role, 'admin')) out.members = memberRows(board);
    out.presence = E.hub.presence(board.id); // capped at 50; the `more` count arrives with the hello/presence events
    return out;
  });

  router.add('PATCH', '/boards/:slug', async (c) => {
    const { board } = E.needBoard(c, c.params.slug, 'admin');
    const b = await c.body();
    const sets = {};
    if (b.title !== undefined) sets.title = needLine(b.title, '제목', 1, C.LIMITS.boardTitle);
    if (b.description !== undefined) sets.description = optBlock(b.description, '설명', C.LIMITS.boardDesc);
    if (b.format !== undefined) sets.format = oneOf(b.format, C.FORMATS, '형식');
    if (b.wallpaper !== undefined) sets.wallpaper = validWallpaper(b.wallpaper);
    if (b.font !== undefined) sets.font = oneOf(b.font, C.FONTS, '글꼴');
    if (b.colorScheme !== undefined) sets.color_scheme = oneOf(b.colorScheme, C.SCHEMES, '카드 색');
    if (b.visibility !== undefined) sets.visibility = oneOf(b.visibility, C.VISIBILITY, '공개 범위');
    if (b.linkAccess !== undefined) sets.link_access = oneOf(b.linkAccess, C.LINK_ACCESS, '링크 권한');
    if (b.settings !== undefined) sets.settings = JSON.stringify(validateSettings(b.settings, E.parseSettings(board.settings)));
    sets.updated_at = now();

    const oldWallpaper = board.wallpaper;
    Object.assign(board, sets);
    const layout = isSectioned(board.format) && b.format !== undefined ? ensureSectionLayout(board) : null;
    const json = E.boardJson(board, E.FULL_VIEW); // the hub shapes the owner per stream
    c.emit(board.id, 'board.updated', { board: json });
    if (layout?.created) c.emit(board.id, 'section.created', { section: layout.created });
    for (const id of layout?.moved ?? []) {
      const post = E.getPostJson(id);
      c.emit(board.id, 'post.moved', { post }, E.postAudience(post));
    }
    if (b.visibility !== undefined || b.linkAccess !== undefined) c.defer(() => E.hub.refresh(board.id));
    if (b.wallpaper !== undefined) E.releaseUploads(E.uploadIdsIn(oldWallpaper)); // a replaced uploaded wallpaper may be unused now
    return { board: E.boardJson(board, adminView(c.user.id)) };
  });

  router.add('DELETE', '/boards/:slug', async (c) => {
    const { board, isOwner } = E.needBoard(c, c.params.slug, 'admin');
    if (!isOwner) throw forbidden('보드는 만든 사람만 지울 수 있어요.');
    const id = board.id;
    deleteBoard(id);
    c.emit(id, 'board.deleted', {});
    c.defer(() => E.hub.closeBoard(id));
    return { ok: true };
  });

  router.add('POST', '/boards/:slug/duplicate', async (c) => {
    const { board, role } = E.needBoard(c, c.params.slug, 'read');
    const me = E.needUser(c);
    if (me.is_guest) throw forbidden('게스트는 보드를 만들 수 없어요. 가입하면 만들 수 있어요.', 'guest_cannot_create');
    const b = await c.body();
    const withPosts = b.withPosts === true;
    // A board that hides authors must not give them away through a copy: below `moderate` the copier owns every copied post.
    const hideAuthors = E.viewerFor(board, role, me.id).anonymize;
    const suffix = ' 사본';
    const title = cpLen(board.title + suffix) <= C.LIMITS.boardTitle
      ? board.title + suffix
      : Array.from(board.title).slice(0, C.LIMITS.boardTitle - cpLen(suffix)).join('') + suffix;
    const t = now();
    const copy = insert('boards', {
      slug: newSlug(), owner_id: me.id, title, description: board.description, format: board.format, wallpaper: board.wallpaper,
      font: board.font, color_scheme: board.color_scheme, visibility: board.visibility, link_access: board.link_access,
      settings: board.settings, created_at: t, updated_at: t,
    });
    const secMap = new Map();
    for (const s of q.sectionsOf(board.id)) secMap.set(s.id, insert('sections', { board_id: copy.id, title: s.title, rank: s.rank }).id);
    if (withPosts) {
      const posts = q.postsOf(board.id).filter((p) => p.status === 'published').sort((x, y) => x.id - y.id);
      for (const p of posts) {
        insert('posts', {
          board_id: copy.id, section_id: p.section_id == null ? null : (secMap.get(p.section_id) ?? null),
          author_id: hideAuthors ? me.id : p.author_id, title: p.title, body: p.body, color: p.color, pinned: p.pinned, status: 'published',
          rank: p.rank, x: p.x, y: p.y, w: p.w, att_kind: p.att_kind, att_url: p.att_url, att_name: p.att_name, att_mime: p.att_mime,
          att_size: p.att_size, att_preview: p.att_preview, created_at: p.created_at, updated_at: p.updated_at,
        });
      }
    }
    c.json({ board: E.boardJson(copy, adminView(me.id)) }, 201);
  });

  /* ───────── members ───────── */
  const memberJson = (boardId, userId) => ({ user: E.userJson(q.user(userId)), role: q.member(boardId, userId).role });
  const changed = (c, boardId) => {
    c.emit(boardId, 'members.updated', {});
    c.defer(() => E.hub.refresh(boardId));
  };

  router.add('GET', '/boards/:slug/members', async (c) => {
    const { board } = E.needBoard(c, c.params.slug, 'admin');
    return { members: memberRows(board) };
  });

  router.add('POST', '/boards/:slug/members', async (c) => {
    const { board } = E.needBoard(c, c.params.slug, 'admin');
    const b = await c.body();
    const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
    const role = oneOf(b.role, C.ROLES, '역할');
    const user = username ? q.userByName(username) : null;
    if (!user) throw new HttpError(404, 'user_not_found', '그 사용자명을 찾을 수 없어요.');
    if (user.id === board.owner_id) throw new HttpError(409, 'already_owner', '이 보드를 만든 사람이에요.');
    if (q.member(board.id, user.id)) throw new HttpError(409, 'already_member', '이미 구성원이에요.');
    setMember(board.id, user.id, role);
    changed(c, board.id);
    c.json({ member: memberJson(board.id, user.id) }, 201);
  });

  router.add('PATCH', '/boards/:slug/members/:userId', async (c) => {
    const { board } = E.needBoard(c, c.params.slug, 'admin');
    const uid = toId(c.params.userId);
    const b = await c.body();
    const role = oneOf(b.role, C.ROLES, '역할');
    const m = q.member(board.id, uid);
    if (!m) throw notFound('구성원을 찾을 수 없어요.');
    m.role = role;
    changed(c, board.id);
    return { member: memberJson(board.id, uid) };
  });

  // Admins remove anyone; every member may remove THEMSELVES (leave the board). The owner can never leave.
  router.add('DELETE', '/boards/:slug/members/:userId', async (c) => {
    const { board, role, isOwner } = E.needBoard(c, c.params.slug, 'read');
    const me = E.needUser(c);
    const uid = toId(c.params.userId);
    if (uid !== me.id) {
      if (!atLeast(role, 'admin')) throw E.denied(c);
    } else if (isOwner) {
      throw new HttpError(409, 'owner_cannot_leave', '보드를 만든 사람은 나갈 수 없어요. 보드를 지우거나 다른 사람에게 맡길 수 없어요.');
    }
    if (!q.member(board.id, uid)) throw notFound('구성원을 찾을 수 없어요.');
    delMember(board.id, uid);
    changed(c, board.id);
    return { ok: true };
  });

  /* ───────── export ───────── */
  router.add('GET', '/boards/:slug/export', async (c) => {
    const { board, role } = E.needBoard(c, c.params.slug, 'read');
    const fmt = c.query.format === 'csv' ? 'csv' : c.query.format === 'json' || c.query.format === undefined ? 'json' : null;
    if (!fmt) throw bad('bad_request', 'format 은 json 또는 csv 여야 해요.');
    const sections = q.sectionsOf(board.id);
    const secRank = new Map(sections.map((s, i) => [s.id, i]));
    const secTitle = new Map(sections.map((s) => [s.id, s.title]));
    const view = E.viewerFor(board, role, c.user?.id ?? null);
    let posts = snapshotPosts(board, role, c.user?.id ?? null);
    if (board.format === 'backchannel') posts.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    else {
      posts = [...posts].sort((a, b) => {
        const sa = a.sectionId == null ? 1e9 : (secRank.get(a.sectionId) ?? 1e9);
        const sb = b.sectionId == null ? 1e9 : (secRank.get(b.sectionId) ?? 1e9);
        return sa - sb || Number(b.pinned) - Number(a.pinned) || a.rank - b.rank || a.id - b.id;
      });
    }
    let body;
    if (fmt === 'json') {
      const cmts = new Map();
      const postIds = new Set(q.postsOf(board.id).map((p) => p.id));
      const rows = Object.values(E.db.state.comments).filter((r) => postIds.has(r.post_id)).sort((a, b) => a.created_at - b.created_at || a.id - b.id);
      for (const r of rows) {
        if (!cmts.has(r.post_id)) cmts.set(r.post_id, []);
        cmts.get(r.post_id).push(E.shapeComment(E.commentJson(r), view));
      }
      body = JSON.stringify({
        exportedAt: new Date().toISOString(),
        board: E.boardJson(board, view),
        sections: sections.map(E.sectionJson),
        posts: posts.map((p) => ({ ...p, comments: cmts.get(p.id) ?? [] })),
      }, null, 2);
    } else {
      body = '\uFEFF' + [
        ['섹션', '작성자', '제목', '본문', '첨부', '링크', '좋아요', '댓글수', '작성시각'],
        ...posts.map((p) => {
          const a = p.attachment;
          const isUpload = a?.url?.startsWith('/uploads/');
          return [
            p.sectionId == null ? '' : (secTitle.get(p.sectionId) ?? ''),
            p.author.displayName, p.title, p.body,
            a ? (a.name || a.preview?.title || a.kind) : '',
            a && !isUpload ? a.url : '',
            p.reactions.like.count, p.commentCount, new Date(p.createdAt).toISOString(),
          ];
        }),
      ].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    }
    c.respond(new Response(body, {
      status: 200,
      headers: {
        'Content-Type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': attachDisposition(`edulet-${board.slug}.${fmt}`),
        'Cache-Control': 'no-store',
      },
    }));
  });

  // The Node server streams events here. In the demo the page's EventSource shim uses /api/_demo/stream instead.
  router.add('GET', '/boards/:slug/events', async (c) => {
    E.needBoard(c, c.params.slug, 'read');
    throw notFound('데모 모드에서는 이 주소를 쓰지 않아요.');
  });

  Object.assign(E, { newSlug, snapshotPosts, deleteBoard });
})((self.EDU = self.EDU || {}));
