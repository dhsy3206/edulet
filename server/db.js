// SQLite (node:sqlite) wrapper + sequential migrations (PRAGMA user_version).
// node:sqlite prints an ExperimentalWarning on load; filter just that one.
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite/i.test(msg)) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = origEmit;

const MIGRATIONS = [
  /* v1 */ `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  avatar_color TEXT NOT NULL,
  is_guest INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE TABLE boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'wall',
  wallpaper TEXT NOT NULL DEFAULT 'green',
  font TEXT NOT NULL DEFAULT 'sans',
  color_scheme TEXT NOT NULL DEFAULT 'light',
  visibility TEXT NOT NULL DEFAULT 'link',
  link_access TEXT NOT NULL DEFAULT 'comment',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE board_members (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX idx_members_user ON board_members(user_id);
CREATE TABLE sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  rank REAL NOT NULL
);
CREATE INDEX idx_sections_board ON sections(board_id, rank);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  color TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  rank REAL NOT NULL,
  x REAL, y REAL, w REAL,
  att_kind TEXT, att_url TEXT, att_name TEXT, att_mime TEXT, att_size INTEGER, att_preview TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_posts_board_section_rank ON posts(board_id, section_id, rank);
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_comments_post ON comments(post_id);
CREATE TABLE reactions (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (post_id, user_id, key)
);
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  board_id INTEGER,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_uploads_board ON uploads(board_id);
`,
  /* v2: per-user upload quota (SUM of the last 24 h) and the orphan sweep */ `
CREATE INDEX idx_uploads_user ON uploads(user_id, created_at);
`,
  /* v3: "Sign in with Google" — the Google account (stable "sub" id + the e-mail shown back to its owner) linked to a user */ `
ALTER TABLE users ADD COLUMN google_sub TEXT;
ALTER TABLE users ADD COLUMN google_email TEXT;
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
`,
];

const norm = (p) => p.map((v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v));

export function openDb(file) {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  const ver = raw.prepare('PRAGMA user_version').get().user_version;
  for (let v = ver; v < MIGRATIONS.length; v++) {
    raw.exec('BEGIN');
    try {
      raw.exec(MIGRATIONS[v]);
      raw.exec(`PRAGMA user_version = ${v + 1}`);
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  }

  const cache = new Map();
  const st = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;
  return {
    raw,
    get: (sql, ...p) => st(sql).get(...norm(p)),
    all: (sql, ...p) => st(sql).all(...norm(p)),
    run: (sql, ...p) => {
      const r = st(sql).run(...norm(p));
      return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
    },
    exec: (sql) => raw.exec(sql),
    /** Synchronous transaction. Never await inside fn. */
    tx(fn) {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const r = fn();
        raw.exec('COMMIT');
        return r;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      } finally {
        depth--;
      }
    },
    close() {
      cache.clear();
      raw.close();
    },
  };
}
