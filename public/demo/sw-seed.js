/* Edulet demo server — seeding (server/seed.js, CONTRACT §7).
 * Reads <scope>seed/*.json (copied there by tools/build-pages.mjs) on the first start and builds the same boards the Node server
 * seeds. Seed images/files stay static files (<scope>seed/img/…): each becomes an upload row `seed-<n>` flagged `static`, and the
 * bytes are cached in the blob store so the demo also works offline afterwards. */
(function (E) {
  'use strict';
  const { C, isSectioned, uploadUrl, sniffImage } = E;
  const { q, insert } = E.db;

  const SEED_FILES = ['practice.json']; // order = board creation order (ids match the Node server's)
  const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.mp4': 'video/mp4',
  };
  const DAY = 86400000;
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const extOf = (rel) => { const m = /\.[^./]*$/.exec(rel); return m ? m[0].toLowerCase() : ''; };
  const staticUrl = (rel) => new URL(rel, self.registration.scope);
  /** fetch with a deadline: a hung request must not keep the worker from ever becoming ready */
  async function fetchT(url, init = {}, ms = 20000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(timer); }
  }

  /** Every static file a seed spec points at (seed-relative paths). */
  function filesOf(spec) {
    const out = new Set();
    for (const p of spec.posts || []) {
      if (p.image) out.add(p.image);
      const a = p.attachment;
      if (!a) continue;
      if (a.file) out.add(a.file);
      if (a.previewImageFile) out.add(a.previewImageFile);
      if (a.preview?.imageFile) out.add(a.preview.imageFile);
    }
    return out;
  }
  /** rel → Uint8Array | null (null when the file could not be fetched: the row is still created, served from the static URL later). */
  async function loadFiles(rels) {
    const map = new Map();
    await Promise.all([...rels].map(async (rel) => {
      try {
        const r = await fetchT(staticUrl('seed/' + rel));
        map.set(rel, r.ok ? new Uint8Array(await r.arrayBuffer()) : null);
      } catch {
        map.set(rel, null);
      }
    }));
    return map;
  }

  /** Build one seed board synchronously from an already-fetched spec. Returns the blobs still to be stored. */
  function applySeed(spec, files) {
    const b = spec.board;
    const blobs = [];
    const t0 = Date.now() - Math.max(0, Number(b.ageDays) || 0) * DAY;
    let lastTime = t0;
    let colorIdx = 0;
    const newUser = (displayName, avatarColor, guest = 0) => insert('users', {
      username: null, display_name: String(displayName).slice(0, 40), password_hash: null,
      avatar_color: avatarColor || C.AVATAR_COLORS[colorIdx++ % C.AVATAR_COLORS.length], is_guest: guest, created_at: t0,
    }).id;

    const ownerId = newUser(spec.owner?.displayName || 'Edulet', /^#[0-9a-fA-F]{6}$/.test(spec.owner?.avatarColor || '') ? spec.owner.avatarColor : null, 0);
    const settings = E.parseSettings(JSON.stringify(b.settings || {}));
    const format = pick(b.format, C.FORMATS, 'wall');
    const board = insert('boards', {
      slug: b.slug, owner_id: ownerId, title: b.title.trim().slice(0, 120), description: String(b.description || '').slice(0, 1000), format,
      wallpaper: pick(b.wallpaper, C.WALLPAPERS, 'green'), font: pick(b.font, C.FONTS, 'sans'), color_scheme: pick(b.colorScheme, C.SCHEMES, 'light'),
      visibility: pick(b.visibility, C.VISIBILITY, 'link'), link_access: pick(b.linkAccess, C.LINK_ACCESS, 'comment'),
      settings: JSON.stringify(settings), created_at: t0, updated_at: t0,
    });

    // sections: array order = rank
    const sectionIds = new Map();
    (spec.sections || []).forEach((s, i) => {
      sectionIds.set(s.key ?? String(i), insert('sections', { board_id: board.id, title: String(s.title).slice(0, 80), rank: i + 1 }).id);
    });
    const firstSection = sectionIds.size ? [...sectionIds.values()][0] : null;

    const copyUpload = (rel, { name, mime } = {}) => {
      const buf = files.get(rel) || null;
      const id = `seed-${++E.db.state.counters.seedUploads}`;
      const fileName = (name || rel.split('/').pop()).slice(0, 100);
      const type = (buf && sniffImage(buf)) || mime || MIME_BY_EXT[extOf(rel)] || 'application/octet-stream';
      E.db.state.uploads[id] = { id, user_id: ownerId, board_id: board.id, name: fileName, mime: type, size: buf ? buf.length : 0, created_at: t0, static: 'seed/' + rel };
      if (buf) blobs.push({ id, rec: { blob: new Blob([buf], { type }), mime: type, name: fileName } });
      return { id, name: fileName, mime: type, size: buf ? buf.length : 0, url: uploadUrl(id, fileName) };
    };

    const named = new Map(); // commenter display name -> user id
    const commenter = (name) => {
      if (!name) return ownerId;
      if (!named.has(name)) named.set(name, newUser(name, null, 1));
      return named.get(name);
    };
    (spec.commenters || []).forEach((n) => commenter(String(n)));

    const pool = [];
    const reactor = (i) => {
      while (pool.length <= i) pool.push(newUser(`참여자 ${pool.length + 1}`, null, 1));
      return pool[i];
    };
    const addReaction = (postId, userId, key, value = 1) => {
      const k = `${postId}:${userId}:${key}`;
      if (!E.db.state.reactions[k]) E.db.state.reactions[k] = { post_id: postId, user_id: userId, key, value };
    };

    const attachmentCols = (p) => {
      const cols = { att_kind: null, att_url: null, att_name: null, att_mime: null, att_size: null, att_preview: null };
      if (p.image) {
        const up = copyUpload(p.image);
        return { ...cols, att_kind: 'image', att_url: up.url, att_name: up.name, att_mime: up.mime, att_size: up.size };
      }
      const a = p.attachment;
      if (!a) return cols;
      if (a.kind === 'file') {
        const up = copyUpload(a.file, { name: a.name, mime: a.mime });
        const preview = a.previewImageFile ? { image: copyUpload(a.previewImageFile).url } : null;
        return {
          ...cols, att_kind: 'file', att_url: up.url, att_name: up.name, att_mime: a.mime || up.mime, att_size: up.size,
          att_preview: preview ? JSON.stringify(preview) : null,
        };
      }
      if (a.kind === 'image') {
        if (a.file) {
          const up = copyUpload(a.file, { name: a.name });
          return { ...cols, att_kind: 'image', att_url: up.url, att_name: up.name, att_mime: up.mime, att_size: up.size };
        }
        return { ...cols, att_kind: 'image', att_url: a.url, att_name: a.name ?? null };
      }
      // link / video: preview stored verbatim (imageFile -> upload URL), never fetched
      const preview = { ...(a.preview || {}) };
      if (preview.imageFile) {
        preview.image = copyUpload(preview.imageFile).url;
        delete preview.imageFile;
      }
      return {
        ...cols, att_kind: a.kind === 'video' ? 'video' : 'link', att_url: a.url, att_name: a.name ?? null,
        att_preview: Object.keys(preview).length ? JSON.stringify(preview) : null,
      };
    };

    // posts: list order in the seed file is the display order
    const counters = new Map(); // section id (or null) -> items so far
    (spec.posts || []).forEach((p, i) => {
      const sid = isSectioned(format) ? (sectionIds.get(p.section) ?? firstSection) : null;
      const n = counters.get(sid) ?? 0;
      counters.set(sid, n + 1);
      const created = t0 + i * 60000;
      const att = attachmentCols(p);
      const post = insert('posts', {
        board_id: board.id, section_id: sid, author_id: ownerId, title: String(p.title || '').slice(0, 200), body: String(p.body || '').slice(0, 10000),
        color: C.POST_COLORS.includes(p.color ?? null) ? (p.color ?? null) : null, pinned: p.pinned ? 1 : 0, status: 'published', rank: n + 1,
        x: null, y: null, w: null, ...att, created_at: created, updated_at: created,
      });
      lastTime = Math.max(lastTime, created);
      for (const cm of p.comments || []) {
        insert('comments', { post_id: post.id, author_id: commenter(cm.author), body: String(cm.body || '').slice(0, 2000), created_at: created + 3600000 });
        lastTime = Math.max(lastTime, created + 3600000);
      }
      const rx = p.reactions || {};
      for (const key of ['like', 'vote', 'star']) {
        for (let k = 0; k < (Number(rx[key]) || 0); k++) addReaction(post.id, reactor(k), key);
      }
      if (Array.isArray(rx.grade)) rx.grade.forEach((v, k) => addReaction(post.id, reactor(k), 'grade', Math.min(10, Math.max(1, Number(v) || 1))));
      for (const [emoji, count] of Object.entries(rx.emoji || {})) {
        for (let k = 0; k < (Number(count) || 0); k++) addReaction(post.id, reactor(k), 'emoji:' + emoji);
      }
    });
    board.updated_at = lastTime;
    return blobs;
  }

  /** Create every seed board that does not exist yet (idempotent per slug). Throws when a seed file cannot be fetched. */
  async function seedAll() {
    const specs = await Promise.all(SEED_FILES.map(async (f) => {
      const r = await fetchT(staticUrl('seed/' + f), { cache: 'no-cache' });
      if (!r.ok) throw new Error(`seed ${f}: HTTP ${r.status}`);
      return r.json();
    }));
    for (const spec of specs) {
      if (!spec?.board?.slug || typeof spec.board.title !== 'string') throw new Error('seed: board.slug / board.title missing');
      if (q.boardBySlug(spec.board.slug)) continue;
      const files = await loadFiles(filesOf(spec));
      const blobs = applySeed(spec, files);
      await Promise.all(blobs.map((x) => E.db.putBlob(x.id, x.rec)));
    }
    E.db.state.seeded = true;
  }

  E.seedAll = seedAll;
})((self.EDU = self.EDU || {}));
