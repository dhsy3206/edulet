// Server-Sent Events hub. CONTRACT §6.
import { atLeast } from './constants.js';
import { effectiveRole } from './access.js';
import { HttpError, clientIp } from './http.js';
import { parseSettings, shapeBoard, shapeComment, shapePost } from './views.js';

const MAX_BUFFERED = 2 * 1024 * 1024;
const PRESENCE_MAX = 50; // users listed in `hello` / `presence` (the rest is only counted in `more`)

const bump = (map, key, by) => {
  const n = (map.get(key) ?? 0) + by;
  if (n > 0) map.set(key, n); else map.delete(key);
  return n;
};

export class Hub {
  constructor(app, { pingMs = 25000, presenceMinMs = 1000 } = {}) {
    this.app = app;
    /** boardId -> { conns:Set<conn>, users:Map<userId, connCount>, lastPresenceAt, timer } */
    this.boards = new Map();
    this.byUser = new Map(); // userId -> open streams (all boards)
    this.byIp = new Map(); // client address -> open streams
    this.presenceMinMs = presenceMinMs;
    this.timer = setInterval(() => this.ping(), pingMs);
    this.timer.unref();
  }

  /** Refuse (429 too_many_connections) before the response is taken over when a user/address holds too many streams. */
  admit(c) {
    const cfg = this.app.config;
    const ip = clientIp(this.app, c.req);
    const uid = c.user?.id ?? null;
    if ((uid != null && (this.byUser.get(uid) ?? 0) >= cfg.sseMaxPerUser) || (this.byIp.get(ip) ?? 0) >= cfg.sseMaxPerIp) {
      throw new HttpError(429, 'too_many_connections', '열려 있는 실시간 연결이 너무 많아요. 다른 창을 닫고 다시 해 주세요.', { 'Retry-After': '10' });
    }
    return ip;
  }

  /** Take over the response of an authorised events request. */
  connect(c, board, acc) {
    const ip = this.admit(c);
    const { req, res } = c;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    const conn = {
      res,
      boardId: board.id,
      userId: c.user?.id ?? null,
      ip,
      tokenHash: c.tokenHash,
      role: acc.role,
      canMod: atLeast(acc.role, 'moderate'),
      isAdmin: atLeast(acc.role, 'admin'),
      closed: false,
    };
    let room = this.boards.get(board.id);
    if (!room) { room = { conns: new Set(), users: new Map(), lastPresenceAt: 0, timer: null }; this.boards.set(board.id, room); }
    room.conns.add(conn);
    bump(this.byIp, ip, 1);
    let newUser = false;
    if (conn.userId != null) {
      bump(this.byUser, conn.userId, 1);
      newUser = bump(room.users, conn.userId, 1) === 1;
    }
    res.write('retry: 3000\n\n');
    this.write(conn, this.frame('hello', this.presenceInfo(board.id)));
    if (newUser) this.emitPresence(board.id, conn);
    req.on('close', () => this.drop(conn));
    c.done = true;
    return conn;
  }

  frame(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  write(conn, payload) {
    if (conn.closed) return;
    if (conn.res.writableLength > MAX_BUFFERED) { this.close(conn); return; }
    try { conn.res.write(payload); } catch { this.drop(conn); }
  }

  /**
   * Send an event to a board's connections. Payloads that carry people (post / comment authors, the board owner) are
   * shaped per connection (CONTRACT §5 User, §4 showAuthor): login names only for admins and the user themself, authors
   * of other people hidden from readers below `moderate` when the board hides authors. At most a handful of distinct
   * payload variants are serialised per event, not one per connection.
   */
  emit(boardId, type, data, only) {
    const room = this.boards.get(boardId);
    if (!room) return;
    const people = data.post || data.comment || data.board;
    if (!people) {
      const payload = this.frame(type, data);
      for (const conn of [...room.conns]) if (!only || only(conn)) this.write(conn, payload);
      return;
    }
    const hide = data.board ? false : this.#hidesAuthors(boardId);
    const selfIds = [data.post?.author?.id, data.comment?.author?.id, data.board?.owner?.id];
    const variants = new Map();
    for (const conn of [...room.conns]) {
      if (only && !only(conn)) continue;
      const view = { userId: conn.userId, admin: conn.isAdmin, anonymize: hide && !conn.canMod };
      const key = `${view.admin ? 1 : 0}${view.anonymize ? 1 : 0}:${conn.userId != null && selfIds.includes(conn.userId) ? conn.userId : 0}`;
      let payload = variants.get(key);
      if (payload === undefined) {
        const shaped = { ...data };
        if (data.post) shaped.post = shapePost(data.post, view);
        if (data.comment) shaped.comment = shapeComment(data.comment, view);
        if (data.board) shaped.board = shapeBoard(data.board, view);
        payload = this.frame(type, shaped);
        variants.set(key, payload);
      }
      this.write(conn, payload);
    }
  }

  #hidesAuthors(boardId) {
    const row = this.app.db.get('SELECT settings FROM boards WHERE id = ?', boardId);
    return !!row && parseSettings(row.settings).showAuthor === false;
  }

  /** `{ presence:[{id,displayName,avatarColor}] (first 50, join order), more }` — `more` counts the users not listed. */
  presenceInfo(boardId) {
    const room = this.boards.get(boardId);
    if (!room || !room.users.size) return { presence: [], more: 0 };
    const all = [...room.users.keys()];
    const ids = all.slice(0, PRESENCE_MAX);
    const rows = this.app.db.all(
      `SELECT id, display_name, avatar_color FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const presence = ids.filter((id) => byId.has(id)).map((id) => {
      const r = byId.get(id);
      return { id, displayName: r.display_name, avatarColor: r.avatar_color };
    });
    return { presence, more: all.length - presence.length };
  }

  presence(boardId) {
    return this.presenceInfo(boardId).presence;
  }

  /**
   * Announce a presence change. Coalesced: at most one broadcast per `presenceMinMs` per board — the first change goes out
   * at once, later ones within the window are folded into a single trailing broadcast carrying the latest state.
   */
  emitPresence(boardId, except = null) {
    const room = this.boards.get(boardId);
    if (!room || room.timer) return; // a trailing broadcast is already scheduled and will carry the latest list
    const wait = room.lastPresenceAt + this.presenceMinMs - Date.now();
    if (wait <= 0) { this.#sendPresence(boardId, room, except); return; }
    room.timer = setTimeout(() => {
      room.timer = null;
      this.#sendPresence(boardId, room, null);
    }, wait);
    room.timer.unref();
  }

  #sendPresence(boardId, room, except) {
    if (!room.conns.size) return;
    const payload = this.frame('presence', this.presenceInfo(boardId));
    let sent = 0;
    for (const conn of [...room.conns]) {
      if (conn === except) continue;
      this.write(conn, payload);
      sent++;
    }
    if (sent) room.lastPresenceAt = Date.now();
  }

  drop(conn) {
    if (conn.closed) return;
    conn.closed = true;
    bump(this.byIp, conn.ip, -1);
    if (conn.userId != null) bump(this.byUser, conn.userId, -1);
    const room = this.boards.get(conn.boardId);
    if (!room) return;
    room.conns.delete(conn);
    if (!room.conns.size) {
      clearTimeout(room.timer);
      this.boards.delete(conn.boardId);
    } else if (conn.userId != null && bump(room.users, conn.userId, -1) === 0) {
      this.emitPresence(conn.boardId);
    }
  }

  close(conn) {
    if (conn.closed) return;
    try { conn.res.end(); } catch { /* socket already gone */ }
    this.drop(conn);
  }

  /** Re-evaluate roles after a board/member change; connections without access are closed. */
  refresh(boardId) {
    const room = this.boards.get(boardId);
    if (!room) return;
    const board = this.app.db.get('SELECT * FROM boards WHERE id = ?', boardId);
    for (const conn of [...room.conns]) {
      const acc = board && effectiveRole(this.app.db, board, conn.userId);
      if (!acc) { this.close(conn); continue; }
      conn.role = acc.role;
      conn.canMod = atLeast(acc.role, 'moderate');
      conn.isAdmin = atLeast(acc.role, 'admin');
    }
  }

  closeBoard(boardId) {
    const room = this.boards.get(boardId);
    if (room) for (const conn of [...room.conns]) this.close(conn);
  }

  closeSession(tokenHash) {
    for (const room of [...this.boards.values()]) {
      for (const conn of [...room.conns]) if (conn.tokenHash === tokenHash) this.close(conn);
    }
  }

  userChanged(userId) {
    for (const [boardId, room] of this.boards) {
      if (room.users.has(userId)) this.emitPresence(boardId);
    }
  }

  /** Keep-alive comment every tick; also ends streams whose session was revoked or has expired. */
  ping() {
    const t = Date.now();
    const valid = new Map(); // tokenHash -> still usable
    for (const room of [...this.boards.values()]) {
      for (const conn of [...room.conns]) {
        if (conn.tokenHash) {
          let ok = valid.get(conn.tokenHash);
          if (ok === undefined) {
            const row = this.app.db.get('SELECT expires_at FROM sessions WHERE token_hash = ?', conn.tokenHash);
            ok = !!row && row.expires_at > t;
            valid.set(conn.tokenHash, ok);
          }
          if (!ok) { this.close(conn); continue; }
        }
        // a comment for proxies plus a named event so EventSource clients can notice a silently dead link
        this.write(conn, ': ping\n\nevent: ping\ndata: {}\n\n');
      }
    }
  }

  closeAll() {
    clearInterval(this.timer);
    for (const room of [...this.boards.values()]) {
      clearTimeout(room.timer);
      for (const conn of [...room.conns]) this.close(conn);
    }
  }
}
