// Boards: CRUD, snapshot, duplicate, members, export, SSE entry point. CONTRACT §5 "보드".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FONTS, FORMATS, LIMITS, LINK_ACCESS, REACTIONS, ROLES, SCHEMES, TEMPLATES, TEMPLATE_DEFS, VISIBILITY, WALLPAPERS,
  atLeast, isSectioned,
} from './constants.js';
import { HttpError, bad, forbidden, notFound } from './http.js';
import { boardBySlug, needBoard, needUser, canSeePost, postAudience } from './access.js';
import { cpLen, needLine, now, oneOf, optBlock, toId } from './util.js';
import {
  COMMENT_SELECT, POST_SELECT, boardJson, buildPosts, commentJson, getPostJson, getUserRow, parseSettings,
  sectionJson, userJson,
} from './views.js';

const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newSlug(db) {
  for (let i = 0; i < 20; i++) {
    let s = '';
    for (let j = 0; j < 10; j++) s += SLUG_ALPHABET[crypto.randomInt(SLUG_ALPHABET.length)];
    if (!boardBySlug(db, s)) return s;
  }
  throw new Error('slug generation failed');
}

export function insertSections(db, boardId, titles) {
  return titles.map((title, i) => db.run('INSERT INTO sections (board_id, title, rank) VALUES (?,?,?)', boardId, title, i + 1).id);
}

/** Posts of a board that this viewer may see (pending: moderators + author only), with `mine` for the viewer. */
export function snapshotPosts(db, board, role, userId) {
  const rows = db
    .all(POST_SELECT + ' WHERE p.board_id = ? ORDER BY p.pinned DESC, p.rank ASC, p.id ASC', board.id)
    .filter((r) => canSeePost(r, role, userId));
  return buildPosts(db, rows, { boardId: board.id }, userId, true);
}

function memberRows(db, board) {
  const owner = getUserRow(db, board.owner_id);
  const rows = db.all(
    `SELECT m.role, u.id, u.username, u.display_name, u.avatar_color, u.is_guest
       FROM board_members m JOIN users u ON u.id = m.user_id WHERE m.board_id = ? ORDER BY u.display_name COLLATE NOCASE, u.id`,
    board.id,
  );
  return [
    { user: userJson(owner), role: 'admin', isOwner: true },
    ...rows.map((r) => ({ user: userJson(r), role: r.role })),
  ];
}

function validateSettings(input, current) {
  if (input === undefined) return current;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw bad('bad_request', '설정 형식이 올바르지 않아요.');
  const s = { ...current };
  if ('reactions' in input) s.reactions = oneOf(input.reactions, REACTIONS, '반응');
  if ('comments' in input) s.comments = oneOf(input.comments, ['on', 'off'], '댓글');
  if ('approval' in input) { if (typeof input.approval !== 'boolean') throw bad('bad_request', '승인 설정이 올바르지 않아요.'); s.approval = input.approval; }
  if ('showAuthor' in input) { if (typeof input.showAuthor !== 'boolean') throw bad('bad_request', '작성자 표시 설정이 올바르지 않아요.'); s.showAuthor = input.showAuthor; }
  if ('newPostPosition' in input) s.newPostPosition = oneOf(input.newPostPosition, ['top', 'bottom'], '새 글 위치');
  return s;
}

function validWallpaper(v) {
  if (typeof v === 'string' && (WALLPAPERS.includes(v) || /^\/uploads\/[0-9a-f]{32}\/[^/?#]{1,300}$/.test(v))) return v;
  throw bad('bad_request', '배경 값이 올바르지 않아요.');
}

/** After switching to a sectioned format: guarantee one section and rehome section-less posts. */
function ensureSectionLayout(c, board) {
  const { db } = c;
  const secs = db.all('SELECT * FROM sections WHERE board_id = ? ORDER BY rank, id', board.id);
  let created = null;
  let first = secs[0];
  if (!first) {
    const id = db.run('INSERT INTO sections (board_id, title, rank) VALUES (?,?,1)', board.id, '섹션 1').id;
    first = db.get('SELECT * FROM sections WHERE id = ?', id);
    created = sectionJson(first);
  }
  const orphans = db.all('SELECT id FROM posts WHERE board_id = ? AND section_id IS NULL ORDER BY rank, id', board.id);
  if (orphans.length) {
    let rank = db.get('SELECT MAX(rank) AS m FROM posts WHERE board_id = ? AND section_id = ?', board.id, first.id).m ?? 0;
    for (const o of orphans) db.run('UPDATE posts SET section_id = ?, rank = ?, updated_at = ? WHERE id = ?', first.id, ++rank, now(), o.id);
  }
  return { created, moved: orphans.map((o) => o.id) };
}

export function deleteBoardFiles(app, boardId) {
  const { db } = app;
  const dir = path.join(app.config.dataDir, 'uploads');
  const toRemove = [];
  for (const u of db.all('SELECT id FROM uploads WHERE board_id = ?', boardId)) {
    const needle = `/uploads/${u.id}/`;
    const shared =
      db.get('SELECT 1 AS x FROM posts WHERE board_id != ? AND (instr(att_url, ?) > 0 OR instr(att_preview, ?) > 0) LIMIT 1', boardId, needle, needle) ||
      db.get('SELECT 1 AS x FROM boards WHERE id != ? AND instr(wallpaper, ?) > 0 LIMIT 1', boardId, needle);
    if (shared) db.run('UPDATE uploads SET board_id = NULL WHERE id = ?', u.id);
    else toRemove.push(u.id);
  }
  return () => {
    for (const id of toRemove) {
      try { fs.rmSync(path.join(dir, id), { force: true }); } catch { /* best effort */ }
    }
  };
}

// ---- export helpers -------------------------------------------------------

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function attachDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerBoards(app) {
  const { db, router } = app;

  router.add('GET', '/boards', async (c) => {
    const me = needUser(c);
    const rows = db.all(
      `SELECT b.*, CASE WHEN b.owner_id = ? THEN 'admin' ELSE m.role END AS my_role,
              (SELECT COUNT(*) FROM posts p WHERE p.board_id = b.id AND p.status = 'published') AS post_count,
              (SELECT COUNT(*) FROM board_members bm WHERE bm.board_id = b.id) + 1 AS member_count
         FROM boards b LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = ?
        WHERE b.owner_id = ? OR m.user_id IS NOT NULL
        ORDER BY b.updated_at DESC, b.id DESC`,
      me.id, me.id, me.id,
    );
    return {
      boards: rows.map((r) => ({
        ...boardJson(db, r), role: r.my_role, isOwner: r.owner_id === me.id, postCount: r.post_count, memberCount: r.member_count,
      })),
    };
  });

  router.add('POST', '/boards', async (c) => {
    const me = needUser(c);
    if (me.is_guest) throw forbidden('게스트는 보드를 만들 수 없어요. 가입하면 만들 수 있어요.', 'guest_cannot_create');
    const b = await c.body();
    const title = needLine(b.title, '제목', 1, LIMITS.boardTitle);
    const description = optBlock(b.description, '설명', LIMITS.boardDesc);
    const template = b.template == null ? 'blank' : oneOf(b.template, TEMPLATES, '템플릿');
    const def = TEMPLATE_DEFS[template];
    const format = b.format == null ? def.format : oneOf(b.format, FORMATS, '형식');
    const t = now();
    const board = db.tx(() => {
      const id = db.run(
        `INSERT INTO boards (slug, owner_id, title, description, format, settings, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        newSlug(db), me.id, title, description, format, JSON.stringify(parseSettings('{}')), t, t,
      ).id;
      const titles = def.sections.length ? def.sections : isSectioned(format) ? ['섹션 1'] : [];
      insertSections(db, id, titles);
      return db.get('SELECT * FROM boards WHERE id = ?', id);
    });
    return c.json({ board: boardJson(db, board) }, 201);
  });

  router.add('GET', '/boards/:slug', async (c) => {
    const { board, role, isOwner } = needBoard(c, c.params.slug, 'read');
    const uid = c.user?.id ?? null;
    const out = {
      board: boardJson(db, board),
      role,
      isOwner,
      sections: db.all('SELECT * FROM sections WHERE board_id = ? ORDER BY rank, id', board.id).map(sectionJson),
      posts: snapshotPosts(db, board, role, uid),
    };
    if (atLeast(role, 'admin')) out.members = memberRows(db, board);
    out.presence = app.hub.presence(board.id);
    return out;
  });

  router.add('PATCH', '/boards/:slug', async (c) => {
    const { board } = needBoard(c, c.params.slug, 'admin');
    const b = await c.body();
    const sets = [];
    const vals = [];
    const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    if (b.title !== undefined) set('title', needLine(b.title, '제목', 1, LIMITS.boardTitle));
    if (b.description !== undefined) set('description', optBlock(b.description, '설명', LIMITS.boardDesc));
    if (b.format !== undefined) set('format', oneOf(b.format, FORMATS, '형식'));
    if (b.wallpaper !== undefined) set('wallpaper', validWallpaper(b.wallpaper));
    if (b.font !== undefined) set('font', oneOf(b.font, FONTS, '글꼴'));
    if (b.colorScheme !== undefined) set('color_scheme', oneOf(b.colorScheme, SCHEMES, '카드 색'));
    if (b.visibility !== undefined) set('visibility', oneOf(b.visibility, VISIBILITY, '공개 범위'));
    if (b.linkAccess !== undefined) set('link_access', oneOf(b.linkAccess, LINK_ACCESS, '링크 권한'));
    if (b.settings !== undefined) set('settings', JSON.stringify(validateSettings(b.settings, parseSettings(board.settings))));
    set('updated_at', now());

    const result = db.tx(() => {
      db.run(`UPDATE boards SET ${sets.join(', ')} WHERE id = ?`, ...vals, board.id);
      const fresh = db.get('SELECT * FROM boards WHERE id = ?', board.id);
      const layout = isSectioned(fresh.format) && b.format !== undefined ? ensureSectionLayout(c, fresh) : null;
      return { fresh, layout };
    });
    const json = boardJson(db, result.fresh);
    c.emit(board.id, 'board.updated', { board: json });
    if (result.layout?.created) c.emit(board.id, 'section.created', { section: result.layout.created });
    for (const id of result.layout?.moved ?? []) {
      const post = getPostJson(db, id);
      c.emit(board.id, 'post.moved', { post }, postAudience(post));
    }
    if (b.visibility !== undefined || b.linkAccess !== undefined) app.hub.refresh(board.id);
    return { board: json };
  });

  router.add('DELETE', '/boards/:slug', async (c) => {
    const { board, isOwner } = needBoard(c, c.params.slug, 'admin');
    if (!isOwner) throw forbidden('보드는 만든 사람만 지울 수 있어요.');
    const cleanup = deleteBoardFiles(app, board.id);
    db.tx(() => {
      db.run('DELETE FROM uploads WHERE board_id = ?', board.id);
      db.run('DELETE FROM boards WHERE id = ?', board.id);
    });
    c.emit(board.id, 'board.deleted', {});
    app.hub.closeBoard(board.id);
    cleanup();
    return { ok: true };
  });

  router.add('POST', '/boards/:slug/duplicate', async (c) => {
    const { board } = needBoard(c, c.params.slug, 'read');
    const me = needUser(c);
    if (me.is_guest) throw forbidden('게스트는 보드를 만들 수 없어요. 가입하면 만들 수 있어요.', 'guest_cannot_create');
    const b = await c.body();
    const withPosts = b.withPosts === true;
    const suffix = ' 사본';
    const title = cpLen(board.title + suffix) <= LIMITS.boardTitle
      ? board.title + suffix
      : Array.from(board.title).slice(0, LIMITS.boardTitle - cpLen(suffix)).join('') + suffix;
    const t = now();
    const copy = db.tx(() => {
      const id = db.run(
        `INSERT INTO boards (slug, owner_id, title, description, format, wallpaper, font, color_scheme, visibility, link_access, settings, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newSlug(db), me.id, title, board.description, board.format, board.wallpaper, board.font, board.color_scheme,
        board.visibility, board.link_access, board.settings, t, t,
      ).id;
      const secMap = new Map();
      for (const s of db.all('SELECT * FROM sections WHERE board_id = ? ORDER BY rank, id', board.id)) {
        secMap.set(s.id, db.run('INSERT INTO sections (board_id, title, rank) VALUES (?,?,?)', id, s.title, s.rank).id);
      }
      if (withPosts) {
        const posts = db.all("SELECT * FROM posts WHERE board_id = ? AND status = 'published' ORDER BY id", board.id);
        for (const p of posts) {
          db.run(
            `INSERT INTO posts (board_id, section_id, author_id, title, body, color, pinned, status, rank, x, y, w,
                                att_kind, att_url, att_name, att_mime, att_size, att_preview, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,'published',?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, p.section_id == null ? null : (secMap.get(p.section_id) ?? null), p.author_id, p.title, p.body, p.color, p.pinned,
            p.rank, p.x, p.y, p.w, p.att_kind, p.att_url, p.att_name, p.att_mime, p.att_size, p.att_preview, p.created_at, p.updated_at,
          );
        }
      }
      return db.get('SELECT * FROM boards WHERE id = ?', id);
    });
    return c.json({ board: boardJson(db, copy) }, 201);
  });

  // ---- members ------------------------------------------------------------
  const memberJson = (board, userId) => {
    const m = db.get('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?', board.id, userId);
    return { user: userJson(getUserRow(db, userId)), role: m.role };
  };
  const changed = (c, board) => {
    c.emit(board.id, 'members.updated', {});
    app.hub.refresh(board.id);
  };

  router.add('GET', '/boards/:slug/members', async (c) => {
    const { board } = needBoard(c, c.params.slug, 'admin');
    return { members: memberRows(db, board) };
  });

  router.add('POST', '/boards/:slug/members', async (c) => {
    const { board } = needBoard(c, c.params.slug, 'admin');
    const b = await c.body();
    const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
    const role = oneOf(b.role, ROLES, '역할');
    const user = username ? db.get('SELECT id FROM users WHERE username = ?', username) : null;
    if (!user) throw new HttpError(404, 'user_not_found', '그 사용자명을 찾을 수 없어요.');
    if (user.id === board.owner_id) throw new HttpError(409, 'already_owner', '이 보드를 만든 사람이에요.');
    if (db.get('SELECT 1 AS x FROM board_members WHERE board_id = ? AND user_id = ?', board.id, user.id)) {
      throw new HttpError(409, 'already_member', '이미 구성원이에요.');
    }
    db.run('INSERT INTO board_members (board_id, user_id, role) VALUES (?,?,?)', board.id, user.id, role);
    changed(c, board);
    return c.json({ member: memberJson(board, user.id) }, 201);
  });

  router.add('PATCH', '/boards/:slug/members/:userId', async (c) => {
    const { board } = needBoard(c, c.params.slug, 'admin');
    const uid = toId(c.params.userId);
    const b = await c.body();
    const role = oneOf(b.role, ROLES, '역할');
    if (!db.run('UPDATE board_members SET role = ? WHERE board_id = ? AND user_id = ?', role, board.id, uid).changes) throw notFound('구성원을 찾을 수 없어요.');
    changed(c, board);
    return { member: memberJson(board, uid) };
  });

  router.add('DELETE', '/boards/:slug/members/:userId', async (c) => {
    const { board } = needBoard(c, c.params.slug, 'admin');
    const uid = toId(c.params.userId);
    if (!db.run('DELETE FROM board_members WHERE board_id = ? AND user_id = ?', board.id, uid).changes) throw notFound('구성원을 찾을 수 없어요.');
    changed(c, board);
    return { ok: true };
  });

  // ---- export -------------------------------------------------------------
  router.add('GET', '/boards/:slug/export', async (c) => {
    const { board, role } = needBoard(c, c.params.slug, 'read');
    const fmt = c.query.format === 'csv' ? 'csv' : c.query.format === 'json' || c.query.format === undefined ? 'json' : null;
    if (!fmt) throw bad('bad_request', 'format 은 json 또는 csv 여야 해요.');
    const sections = db.all('SELECT * FROM sections WHERE board_id = ? ORDER BY rank, id', board.id);
    const secRank = new Map(sections.map((s, i) => [s.id, i]));
    const secTitle = new Map(sections.map((s) => [s.id, s.title]));
    let posts = snapshotPosts(db, board, role, c.user?.id ?? null);
    if (board.format === 'backchannel') posts.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    else {
      posts = [...posts].sort((a, b) => {
        const sa = a.sectionId == null ? 1e9 : (secRank.get(a.sectionId) ?? 1e9);
        const sb = b.sectionId == null ? 1e9 : (secRank.get(b.sectionId) ?? 1e9);
        return sa - sb || Number(b.pinned) - Number(a.pinned) || a.rank - b.rank || a.id - b.id;
      });
    }
    const body = fmt === 'json'
      ? (() => {
        const cmts = new Map();
        for (const r of db.all(`${COMMENT_SELECT} WHERE c.post_id IN (SELECT id FROM posts WHERE board_id = ?) ORDER BY c.created_at, c.id`, board.id)) {
          if (!cmts.has(r.post_id)) cmts.set(r.post_id, []);
          cmts.get(r.post_id).push(commentJson(r));
        }
        return JSON.stringify({
          exportedAt: new Date().toISOString(),
          board: boardJson(db, board),
          sections: sections.map(sectionJson),
          posts: posts.map((p) => ({ ...p, comments: cmts.get(p.id) ?? [] })),
        }, null, 2);
      })()
      : '\uFEFF' + [
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
    const filename = `edulet-${board.slug}.${fmt}`;
    const buf = Buffer.from(body, 'utf8');
    c.res.writeHead(200, {
      'Content-Type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Length': buf.length,
      'Content-Disposition': attachDisposition(filename),
      'Cache-Control': 'no-store',
    });
    c.res.end(buf);
    c.done = true;
  });

  // ---- realtime -----------------------------------------------------------
  router.add('GET', '/boards/:slug/events', async (c) => {
    const acc = needBoard(c, c.params.slug, 'read');
    app.hub.connect(c, acc.board, acc);
  });

}
