// Seeding (CONTRACT §7). Idempotent per slug, never touches the network, owner is a non-loginable account.
import fs from 'node:fs';
import path from 'node:path';
import { AVATAR_COLORS, FONTS, FORMATS, LINK_ACCESS, POST_COLORS, SCHEMES, VISIBILITY, WALLPAPERS, isSectioned } from './constants.js';
import { deleteBoardFiles } from './boards.js';
import { randomHex, sniffImage, uploadUrl } from './util.js';
import { parseSettings } from './views.js';

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.mp4': 'video/mp4',
};
const DAY = 86400000;

export function loadSeedSpecs(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort()
    .map((f) => {
      let spec;
      try { spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { throw new Error(`seed ${f}: ${e.message}`); }
      if (!spec?.board?.slug || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(spec.board.slug)) throw new Error(`seed ${f}: board.slug is missing or invalid`);
      if (typeof spec.board.title !== 'string' || !spec.board.title.trim()) throw new Error(`seed ${f}: board.title is required`);
      return { file: f, spec };
    });
}

const pick = (v, list, d) => (list.includes(v) ? v : d);

export function applySeed(app, spec, dir) {
  const { db, config } = app;
  const uploadsDir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const b = spec.board;
  if (db.get('SELECT 1 AS x FROM boards WHERE slug = ?', b.slug)) return { slug: b.slug, created: false };

  const written = [];
  try {
    return db.tx(() => {
      const t0 = Date.now() - Math.max(0, Number(b.ageDays) || 0) * DAY;
      let lastTime = t0;
      let colorIdx = 0;
      const newUser = (displayName, avatarColor, guest = 0) => db.run(
        'INSERT INTO users (username, display_name, password_hash, avatar_color, is_guest, created_at) VALUES (NULL,?,NULL,?,?,?)',
        String(displayName).slice(0, 40), avatarColor || AVATAR_COLORS[colorIdx++ % AVATAR_COLORS.length], guest, t0,
      ).id;

      const ownerId = newUser(spec.owner?.displayName || 'Edulet', /^#[0-9a-fA-F]{6}$/.test(spec.owner?.avatarColor || '') ? spec.owner.avatarColor : null, 0);
      const settings = parseSettings(JSON.stringify(b.settings || {}));
      const format = pick(b.format, FORMATS, 'wall');
      const boardId = db.run(
        `INSERT INTO boards (slug, owner_id, title, description, format, wallpaper, font, color_scheme, visibility, link_access, settings, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        b.slug, ownerId, b.title.trim().slice(0, 120), String(b.description || '').slice(0, 1000), format,
        pick(b.wallpaper, WALLPAPERS, 'green'), pick(b.font, FONTS, 'sans'), pick(b.colorScheme, SCHEMES, 'light'),
        pick(b.visibility, VISIBILITY, 'link'), pick(b.linkAccess, LINK_ACCESS, 'comment'), JSON.stringify(settings), t0, t0,
      ).id;

      // sections: array order = rank
      const sectionIds = new Map();
      (spec.sections || []).forEach((s, i) => {
        sectionIds.set(s.key ?? String(i), db.run('INSERT INTO sections (board_id, title, rank) VALUES (?,?,?)', boardId, String(s.title).slice(0, 80), i + 1).id);
      });
      const firstSection = sectionIds.size ? [...sectionIds.values()][0] : null;

      // helpers ---------------------------------------------------------------
      const copyUpload = (rel, { name, mime } = {}) => {
        const src = path.join(dir, rel);
        const buf = fs.readFileSync(src);
        const id = randomHex(16);
        fs.writeFileSync(path.join(uploadsDir, id), buf);
        written.push(id);
        const fileName = (name || path.basename(rel)).slice(0, 100);
        const type = sniffImage(buf) || mime || MIME_BY_EXT[path.extname(rel).toLowerCase()] || 'application/octet-stream';
        db.run('INSERT INTO uploads (id, user_id, board_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', id, ownerId, boardId, fileName, type, buf.length, t0);
        return { id, name: fileName, mime: type, size: buf.length, url: uploadUrl(id, fileName) };
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
        db.run('INSERT OR IGNORE INTO reactions (post_id, user_id, key, value) VALUES (?,?,?,?)', postId, userId, key, value);
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

      // posts -----------------------------------------------------------------
      const bottom = settings.newPostPosition === 'bottom';
      const counters = new Map(); // section id (or 'null') -> items so far
      (spec.posts || []).forEach((p, i) => {
        const sid = isSectioned(format) ? (sectionIds.get(p.section) ?? firstSection) : null;
        const n = counters.get(sid) ?? 0;
        counters.set(sid, n + 1);
        const rank = n + 1; // list order in the seed file is the display order (new user posts still go to `top`/`bottom` per settings)
        const created = t0 + i * 60000;
        const att = attachmentCols(p);
        const postId = db.run(
          `INSERT INTO posts (board_id, section_id, author_id, title, body, color, pinned, status, rank,
                              att_kind, att_url, att_name, att_mime, att_size, att_preview, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,'published',?,?,?,?,?,?,?,?,?)`,
          boardId, sid, ownerId, String(p.title || '').slice(0, 200), String(p.body || '').slice(0, 10000),
          POST_COLORS.includes(p.color ?? null) ? (p.color ?? null) : null, p.pinned ? 1 : 0, rank,
          att.att_kind, att.att_url, att.att_name, att.att_mime, att.att_size, att.att_preview, created, created,
        ).id;
        lastTime = Math.max(lastTime, created);
        for (const cm of p.comments || []) {
          db.run('INSERT INTO comments (post_id, author_id, body, created_at) VALUES (?,?,?,?)',
            postId, commenter(cm.author), String(cm.body || '').slice(0, 2000), created + 3600000);
          lastTime = Math.max(lastTime, created + 3600000);
        }
        const rx = p.reactions || {};
        for (const key of ['like', 'vote', 'star']) {
          for (let k = 0; k < (Number(rx[key]) || 0); k++) addReaction(postId, reactor(k), key);
        }
        if (Array.isArray(rx.grade)) rx.grade.forEach((v, k) => addReaction(postId, reactor(k), 'grade', Math.min(10, Math.max(1, Number(v) || 1))));
        for (const [emoji, count] of Object.entries(rx.emoji || {})) {
          for (let k = 0; k < (Number(count) || 0); k++) addReaction(postId, reactor(k), 'emoji:' + emoji);
        }
      });
      db.run('UPDATE boards SET updated_at = ? WHERE id = ?', lastTime, boardId);
      return { slug: b.slug, created: true };
    });
  } catch (e) {
    for (const id of written) fs.rmSync(path.join(uploadsDir, id), { force: true });
    throw e;
  }
}

/** mode: 'auto' (only when no boards exist) | 'on' (always, idempotent) | 'off'. */
export function runSeed(app, { mode = 'auto', dir } = {}) {
  if (mode === 'off') return [];
  if (mode === 'auto' && app.db.get('SELECT COUNT(*) AS n FROM boards').n > 0) return [];
  return loadSeedSpecs(dir).map(({ spec }) => applySeed(app, spec, dir));
}

/** Delete the seeded demo boards (only the slugs found in seed files) and their orphaned non-loginable users. */
export function resetDemo(app, dir) {
  const { db } = app;
  for (const { spec } of loadSeedSpecs(dir)) {
    const board = db.get('SELECT * FROM boards WHERE slug = ?', spec.board.slug);
    if (!board) continue;
    const cleanup = deleteBoardFiles(app, board.id);
    db.tx(() => {
      db.run('DELETE FROM uploads WHERE board_id = ?', board.id);
      db.run('DELETE FROM boards WHERE id = ?', board.id);
    });
    cleanup();
  }
  db.run(`DELETE FROM users WHERE password_hash IS NULL AND username IS NULL
            AND NOT EXISTS (SELECT 1 FROM boards WHERE owner_id = users.id)
            AND NOT EXISTS (SELECT 1 FROM posts WHERE author_id = users.id)
            AND NOT EXISTS (SELECT 1 FROM comments WHERE author_id = users.id)
            AND NOT EXISTS (SELECT 1 FROM reactions WHERE user_id = users.id)
            AND NOT EXISTS (SELECT 1 FROM sessions WHERE user_id = users.id)
            AND NOT EXISTS (SELECT 1 FROM uploads WHERE user_id = users.id)`);
}

