/* Edulet demo server — the "database": one JSON document in IndexedDB + a blob store for uploads.
 *
 *   IndexedDB 'edulet-demo'   store 'kv'    key 'state'  → the whole state (rows shaped like the SQL tables of docs/CONTRACT.md §3)
 *                             store 'blobs' key upload id → { blob, mime, name }
 *
 * The state is loaded on every service-worker start and re-written (`save()`) before every mutating request is answered, so the
 * worker can be killed at any moment without losing an acknowledged write. */
(function (E) {
  'use strict';

  /* ───────── IndexedDB plumbing ───────── */
  let dbp = null;
  let persistent = true; // false = IndexedDB unusable (some private modes): the demo then lives in memory only
  function openDb() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open('edulet-demo', 1);
        r.onupgradeneeded = () => {
          for (const name of ['kv', 'blobs']) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
        };
        r.onsuccess = () => {
          r.result.onversionchange = () => { r.result.close(); dbp = null; };
          r.result.onclose = () => { dbp = null; };
          resolve(r.result);
        };
        r.onerror = () => { dbp = null; reject(r.error); };
        r.onblocked = () => { dbp = null; reject(new Error('indexedDB blocked')); };
      });
    }
    return dbp;
  }
  async function idb(store, mode, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        const d = await openDb();
        return await new Promise((resolve, reject) => {
          const t = d.transaction(store, mode);
          let out;
          const req = fn(t.objectStore(store));
          if (req) req.onsuccess = () => { out = req.result; };
          t.oncomplete = () => resolve(out);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error('transaction aborted'));
        });
      } catch (e) {
        dbp = null;
        if (attempt >= 1) throw e; // one retry covers a connection that was closed under us
      }
    }
  }
  const idbGet = (store, key) => idb(store, 'readonly', (s) => s.get(key));
  const idbPut = (store, key, value) => idb(store, 'readwrite', (s) => s.put(value, key));
  const idbDelete = (store, key) => idb(store, 'readwrite', (s) => s.delete(key));
  const idbClear = (store) => idb(store, 'readwrite', (s) => s.clear());

  /* ───────── the state document ───────── */
  const TABLES = ['users', 'sessions', 'boards', 'members', 'sections', 'posts', 'comments', 'reactions', 'uploads'];
  function emptyState() {
    return {
      v: 1,
      seeded: false,
      counters: { users: 0, boards: 0, sections: 0, posts: 0, comments: 0, seedUploads: 0 },
      users: {}, // id → { id, username, display_name, password_hash, avatar_color, is_guest, created_at }
      sessions: {}, // sha256(token) → { token_hash, user_id, expires_at, created_at }
      boards: {}, // id → { id, slug, owner_id, title, description, format, wallpaper, font, color_scheme, visibility, link_access, settings(JSON text), created_at, updated_at }
      members: {}, // `${board_id}:${user_id}` → { board_id, user_id, role }
      sections: {}, // id → { id, board_id, title, rank }
      posts: {}, // id → { id, board_id, section_id, author_id, title, body, color, pinned, status, rank, x, y, w, att_*, created_at, updated_at }
      comments: {}, // id → { id, post_id, author_id, body, created_at }
      reactions: {}, // `${post_id}:${user_id}:${key}` → { post_id, user_id, key, value }
      uploads: {}, // id → { id, user_id, board_id, name, mime, size, created_at, static? }
    };
  }
  let state = emptyState();

  const pendingIo = []; // blob deletions that save() must wait for
  const memBlobs = new Map(); // blobs when IndexedDB is unavailable
  const blobCache = new Map(); // small in-memory cache so repeated image loads do not hit IndexedDB every time

  async function load() {
    let saved = null;
    try {
      saved = await idbGet('kv', 'state');
      persistent = true;
    } catch (e) {
      persistent = false;
      console.warn('[edulet-demo] IndexedDB unavailable, data will not survive a restart', e);
    }
    state = saved && saved.v === 1 ? saved : emptyState();
    for (const t of TABLES) state[t] ||= {};
    state.counters = Object.assign(emptyState().counters, state.counters);
    const t = Date.now();
    for (const [k, s] of Object.entries(state.sessions)) if (s.expires_at <= t) delete state.sessions[k];
  }

  // Coalescing writer: every caller's promise settles only after a write that STARTED after its mutation has finished.
  let writing = null;
  let dirty = false;
  function save() {
    dirty = true;
    if (!writing) {
      writing = (async () => {
        try {
          while (dirty) {
            dirty = false;
            await Promise.all(pendingIo.splice(0));
            if (persistent) await idbPut('kv', 'state', state);
          }
        } finally {
          writing = null;
        }
      })();
    }
    return writing;
  }

  /** Wipe everything (kv + blobs) and start from an empty state; the caller seeds again. */
  async function reset() {
    try { await writing; } catch { /* ignore */ }
    await Promise.all(pendingIo.splice(0).map((p) => p.catch(() => {})));
    if (persistent) {
      await idbClear('kv');
      await idbClear('blobs');
    }
    memBlobs.clear();
    blobCache.clear();
    state = emptyState();
  }

  /* ───────── blobs ───────── */
  function remember(id, rec) { // small files only: big ones are read from IndexedDB when needed
    if (rec.blob.size > 2 * 1024 * 1024) return;
    if (blobCache.size >= 64) blobCache.delete(blobCache.keys().next().value);
    blobCache.set(id, rec);
  }
  async function putBlob(id, rec) {
    if (persistent) await idbPut('blobs', id, rec);
    else memBlobs.set(id, rec);
    remember(id, rec);
  }
  async function getBlob(id) {
    const hit = blobCache.get(id) || memBlobs.get(id);
    if (hit) return hit;
    if (!persistent) return null;
    const rec = await idbGet('blobs', id);
    if (rec) remember(id, rec);
    return rec || null;
  }
  /** Blobs whose upload row never made it into the saved state (worker killed between the two writes) are garbage. */
  async function pruneBlobs() {
    if (!persistent) return 0;
    const keys = await idb('blobs', 'readonly', (s) => s.getAllKeys());
    let n = 0;
    for (const k of keys) if (!state.uploads[k]) { dropBlob(k); n++; }
    return n;
  }
  /** Fire-and-forget removal; save() waits for it. */
  function dropBlob(id) {
    blobCache.delete(id);
    memBlobs.delete(id);
    if (persistent) pendingIo.push(idbDelete('blobs', id).catch(() => {}));
  }

  /* ───────── tiny query layer (what the SQL did) ───────── */
  const vals = (o) => Object.values(o);
  const byRankId = (a, b) => a.rank - b.rank || a.id - b.id;
  const q = {
    get state() { return state; },
    user: (id) => (id == null ? null : state.users[id] || null),
    userByName: (name) => vals(state.users).find((u) => u.username === name) || null,
    board: (id) => state.boards[id] || null,
    boardBySlug: (slug) => vals(state.boards).find((b) => b.slug === String(slug)) || null,
    section: (id) => state.sections[id] || null,
    sectionsOf: (boardId) => vals(state.sections).filter((s) => s.board_id === boardId).sort(byRankId),
    post: (id) => state.posts[id] || null,
    postsOf: (boardId) => vals(state.posts).filter((p) => p.board_id === boardId),
    /** Posts of one section of a board (sectionId null = the section-less list), ordered by rank. */
    postsIn: (boardId, sectionId) => vals(state.posts).filter((p) => p.board_id === boardId && p.section_id === sectionId).sort(byRankId),
    comment: (id) => state.comments[id] || null,
    commentsOf: (postId) => vals(state.comments).filter((c) => c.post_id === postId).sort((a, b) => a.created_at - b.created_at || a.id - b.id),
    member: (boardId, userId) => state.members[`${boardId}:${userId}`] || null,
    membersOf: (boardId) => vals(state.members).filter((m) => m.board_id === boardId),
    upload: (id) => state.uploads[id] || null,
    byRankId,
  };

  /** Insert a row into an id-keyed table (users, boards, sections, posts, comments); returns the stored row. */
  function insert(table, row) {
    const id = ++state.counters[table];
    const stored = { id, ...row };
    state[table][id] = stored;
    return stored;
  }
  /** Undo an insert made in this very request (the SQL transaction would have rolled back, ids included). */
  function uninsert(table, row) {
    delete state[table][row.id];
    if (state.counters[table] === row.id) state.counters[table]--;
  }
  const setMember = (boardId, userId, role) => { state.members[`${boardId}:${userId}`] = { board_id: boardId, user_id: userId, role }; };
  const delMember = (boardId, userId) => delete state.members[`${boardId}:${userId}`];

  /** Delete posts with their comments and reactions (ON DELETE CASCADE). */
  function deletePosts(ids) {
    const set = new Set(ids);
    if (!set.size) return;
    for (const [k, c] of Object.entries(state.comments)) if (set.has(c.post_id)) delete state.comments[k];
    for (const [k, r] of Object.entries(state.reactions)) if (set.has(r.post_id)) delete state.reactions[k];
    for (const id of set) delete state.posts[id];
  }

  E.db = {
    load, save, reset, q, insert, uninsert, setMember, delMember, deletePosts, putBlob, getBlob, dropBlob, pruneBlobs,
    get state() { return state; },
    get persistent() { return persistent; },
  };
})((self.EDU = self.EDU || {}));
