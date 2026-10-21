// Server-Sent Events hub. CONTRACT §6.
import { atLeast } from './constants.js';
import { effectiveRole } from './access.js';

const MAX_BUFFERED = 2 * 1024 * 1024;

export class Hub {
  constructor(app, { pingMs = 25000 } = {}) {
    this.app = app;
    this.boards = new Map(); // boardId -> Set<conn>
    this.timer = setInterval(() => this.ping(), pingMs);
    this.timer.unref();
  }

  /** Take over the response of an authorised events request. */
  connect(c, board, acc) {
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
      tokenHash: c.tokenHash,
      role: acc.role,
      canMod: atLeast(acc.role, 'moderate'),
      closed: false,
    };
    let set = this.boards.get(board.id);
    if (!set) { set = new Set(); this.boards.set(board.id, set); }
    const newUser = conn.userId != null && ![...set].some((o) => o.userId === conn.userId);
    set.add(conn);
    res.write('retry: 3000\n\n');
    this.write(conn, this.frame('hello', { presence: this.presence(board.id) }));
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

  emit(boardId, type, data, only) {
    const set = this.boards.get(boardId);
    if (!set) return;
    const payload = this.frame(type, data);
    for (const conn of [...set]) {
      if (only && !only(conn)) continue;
      this.write(conn, payload);
    }
  }

  presence(boardId) {
    const set = this.boards.get(boardId);
    if (!set) return [];
    const ids = [];
    for (const conn of set) if (conn.userId != null && !ids.includes(conn.userId)) ids.push(conn.userId);
    if (!ids.length) return [];
    const rows = this.app.db.all(
      `SELECT id, display_name, avatar_color FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.filter((id) => byId.has(id)).map((id) => {
      const r = byId.get(id);
      return { id, displayName: r.display_name, avatarColor: r.avatar_color };
    });
  }

  emitPresence(boardId, except) {
    const payload = this.frame('presence', { presence: this.presence(boardId) });
    const set = this.boards.get(boardId);
    if (!set) return;
    for (const conn of [...set]) if (conn !== except) this.write(conn, payload);
  }

  drop(conn) {
    if (conn.closed) return;
    conn.closed = true;
    const set = this.boards.get(conn.boardId);
    if (set) {
      set.delete(conn);
      if (!set.size) this.boards.delete(conn.boardId);
      else if (conn.userId != null && ![...set].some((o) => o.userId === conn.userId)) this.emitPresence(conn.boardId);
    }
  }

  close(conn) {
    if (conn.closed) return;
    try { conn.res.end(); } catch { /* socket already gone */ }
    this.drop(conn);
  }

  /** Re-evaluate roles after a board/member change; connections without access are closed. */
  refresh(boardId) {
    const set = this.boards.get(boardId);
    if (!set) return;
    const board = this.app.db.get('SELECT * FROM boards WHERE id = ?', boardId);
    for (const conn of [...set]) {
      const acc = board && effectiveRole(this.app.db, board, conn.userId);
      if (!acc) { this.close(conn); continue; }
      conn.role = acc.role;
      conn.canMod = atLeast(acc.role, 'moderate');
    }
  }

  closeBoard(boardId) {
    const set = this.boards.get(boardId);
    if (set) for (const conn of [...set]) this.close(conn);
  }

  closeSession(tokenHash) {
    for (const set of [...this.boards.values()]) {
      for (const conn of [...set]) if (conn.tokenHash === tokenHash) this.close(conn);
    }
  }

  userChanged(userId) {
    for (const [boardId, set] of this.boards) {
      if ([...set].some((c) => c.userId === userId)) this.emitPresence(boardId);
    }
  }

  ping() {
    for (const set of this.boards.values()) for (const conn of [...set]) this.write(conn, ': ping\n\n');
  }

  closeAll() {
    clearInterval(this.timer);
    for (const set of [...this.boards.values()]) for (const conn of [...set]) this.close(conn);
  }
}
