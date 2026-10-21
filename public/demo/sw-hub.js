/* Edulet demo server — realtime hub (the SSE hub of server/realtime.js, CONTRACT §6).
 *
 * There are no sockets: the page registers a "stream" per open board (POST /api/_demo/stream), keeps it alive with pings,
 * and receives events through BroadcastChannel('edulet-demo-events') as { sid, type, data } — the page-side shim in
 * demo/boot.js turns those into EventSource events. Every event is shaped per stream (login names, hidden authors,
 * pending posts) exactly like the Node hub does per connection. */
(function (E) {
  'use strict';
  const { atLeast } = E;
  const { q } = E.db;

  const PRESENCE_MAX = 50; // users listed in `hello` / `presence` (the rest is only counted in `more`)
  const PRESENCE_MIN_MS = 300; // at most one presence broadcast per board in this window
  const STREAM_TTL_MS = 60000; // a stream that has not pinged for this long is gone
  // Events a stream that just LOST access must still receive (the real hub emits first and closes afterwards).
  const STALE_OK = new Set(['members.updated', 'board.updated', 'board.deleted']);

  const channel = new BroadcastChannel('edulet-demo-events');
  const bump = (map, key, by) => {
    const n = (map.get(key) ?? 0) + by;
    if (n > 0) map.set(key, n); else map.delete(key);
    return n;
  };

  class Hub {
    constructor() {
      /** sid → { sid, boardId, userId, tokenHash, role, canMod, isAdmin, lastPing } */
      this.streams = new Map();
      /** boardId → { sids:Set, users:Map<userId, streamCount>, lastPresenceAt, timer } */
      this.rooms = new Map();
    }

    /** Registered streams of a board — used by the e2e/diagnostics endpoint. */
    count(boardId) {
      return boardId == null ? this.streams.size : (this.rooms.get(boardId)?.sids.size ?? 0);
    }

    /** Open (or re-open) a stream. Returns the `hello` payload. */
    register({ sid, board, acc, userId, tokenHash }) {
      this.drop(sid, { quiet: true });
      const s = {
        sid, boardId: board.id, userId, tokenHash, role: acc.role,
        canMod: atLeast(acc.role, 'moderate'), isAdmin: atLeast(acc.role, 'admin'), lastPing: Date.now(),
      };
      this.streams.set(sid, s);
      let room = this.rooms.get(board.id);
      if (!room) { room = { sids: new Set(), users: new Map(), lastPresenceAt: 0, timer: null }; this.rooms.set(board.id, room); }
      room.sids.add(sid);
      const newUser = userId != null && bump(room.users, userId, 1) === 1;
      if (newUser) this.emitPresence(board.id, sid);
      return this.presenceInfo(board.id);
    }

    /** Heartbeat. `known:false` tells the page this worker restarted and forgot the stream (it re-registers). */
    ping(sid) {
      const s = this.streams.get(sid);
      if (!s) return { known: false };
      if (s.tokenHash) {
        const ses = E.db.state.sessions[s.tokenHash];
        if (!ses || ses.expires_at <= Date.now()) { this.close(sid); return { known: true }; } // revoked/expired session ends its streams
      }
      s.lastPing = Date.now();
      return { known: true };
    }

    /** Page closed the stream (EventSource.close / pagehide). */
    drop(sid, { quiet = false } = {}) {
      const s = this.streams.get(sid);
      if (!s) return;
      this.streams.delete(sid);
      const room = this.rooms.get(s.boardId);
      if (!room) return;
      room.sids.delete(sid);
      if (!room.sids.size) {
        clearTimeout(room.timer);
        this.rooms.delete(s.boardId);
      } else if (!quiet && s.userId != null && bump(room.users, s.userId, -1) === 0) {
        this.emitPresence(s.boardId);
      } else if (quiet && s.userId != null) {
        bump(room.users, s.userId, -1);
      }
    }

    /** Server-side close: the page's shim behaves like a dropped connection (error → reconnect attempt). */
    close(sid) {
      if (!this.streams.has(sid)) return;
      channel.postMessage({ sid, close: true });
      this.drop(sid);
    }

    reap() {
      const t = Date.now();
      for (const s of [...this.streams.values()]) if (t - s.lastPing > STREAM_TTL_MS) this.drop(s.sid);
    }

    reset() {
      for (const room of this.rooms.values()) clearTimeout(room.timer);
      this.streams.clear();
      this.rooms.clear();
    }

    /**
     * Send an event to a board's streams. Payloads that carry people (post / comment authors, the board owner) are shaped per
     * stream: login names only for admins and the user themself, authors of other people hidden from readers below
     * `moderate` when the board hides authors. The role of every stream is re-evaluated for each event.
     */
    emit(boardId, type, data, only) {
      const room = this.rooms.get(boardId);
      if (!room) return;
      const board = q.board(boardId);
      const people = data.post || data.comment || data.board;
      const hide = people && !data.board && board ? E.parseSettings(board.settings).showAuthor === false : false;
      for (const sid of [...room.sids]) {
        const s = this.streams.get(sid);
        if (!s) continue;
        const acc = board ? E.effectiveRole(board, s.userId) : null;
        if (acc) {
          s.role = acc.role;
          s.canMod = atLeast(acc.role, 'moderate');
          s.isAdmin = atLeast(acc.role, 'admin');
        } else if (!STALE_OK.has(type)) continue; // no access any more: refresh() closes it
        if (only && !only(s)) continue;
        let payload = data;
        if (people) {
          const view = { userId: s.userId, admin: s.isAdmin, anonymize: hide && !s.canMod };
          payload = { ...data };
          if (data.post) payload.post = E.shapePost(data.post, view);
          if (data.comment) payload.comment = E.shapeComment(data.comment, view);
          if (data.board) payload.board = E.shapeBoard(data.board, view);
        }
        channel.postMessage({ sid, type, data: payload });
      }
    }

    /** `{ presence:[{id,displayName,avatarColor}] (first 50, join order), more }` — `more` counts the users not listed. */
    presenceInfo(boardId) {
      const room = this.rooms.get(boardId);
      if (!room || !room.users.size) return { presence: [], more: 0 };
      const all = [...room.users.keys()];
      const presence = all.slice(0, PRESENCE_MAX).map((id) => q.user(id)).filter(Boolean)
        .map((u) => ({ id: u.id, displayName: u.display_name, avatarColor: u.avatar_color }));
      return { presence, more: all.length - presence.length };
    }
    presence(boardId) {
      return this.presenceInfo(boardId).presence;
    }

    /** Coalesced: at most one broadcast per PRESENCE_MIN_MS per board; later changes fold into one trailing broadcast. */
    emitPresence(boardId, exceptSid = null) {
      const room = this.rooms.get(boardId);
      if (!room || room.timer) return; // a trailing broadcast is already scheduled and will carry the latest list
      const wait = room.lastPresenceAt + PRESENCE_MIN_MS - Date.now();
      if (wait <= 0) { this._sendPresence(boardId, room, exceptSid); return; }
      room.timer = setTimeout(() => {
        room.timer = null;
        this._sendPresence(boardId, room, null);
      }, wait);
    }
    _sendPresence(boardId, room, exceptSid) {
      if (!room.sids.size) return;
      const data = this.presenceInfo(boardId);
      let sent = 0;
      for (const sid of [...room.sids]) {
        if (sid === exceptSid) continue;
        channel.postMessage({ sid, type: 'presence', data });
        sent++;
      }
      if (sent) room.lastPresenceAt = Date.now();
    }

    /** Re-evaluate roles after a board/member change; streams without access are closed. */
    refresh(boardId) {
      const room = this.rooms.get(boardId);
      if (!room) return;
      const board = q.board(boardId);
      for (const sid of [...room.sids]) {
        const s = this.streams.get(sid);
        if (!s) continue;
        const acc = board && E.effectiveRole(board, s.userId);
        if (!acc) { this.close(sid); continue; }
        s.role = acc.role;
        s.canMod = atLeast(acc.role, 'moderate');
        s.isAdmin = atLeast(acc.role, 'admin');
      }
    }
    closeBoard(boardId) {
      const room = this.rooms.get(boardId);
      if (room) for (const sid of [...room.sids]) this.close(sid);
    }
    closeSession(tokenHash) {
      for (const s of [...this.streams.values()]) if (s.tokenHash === tokenHash) this.close(s.sid);
    }
    userChanged(userId) {
      for (const [boardId, room] of this.rooms) if (room.users.has(userId)) this.emitPresence(boardId);
    }

    /** Tell every page to start over (demo reset). */
    broadcastReset() {
      channel.postMessage({ reset: true });
    }
  }

  E.hub = new Hub();
  setInterval(() => E.hub.reap(), 15000); // also reaped lazily on every request (edulet-sw.js)
})((self.EDU = self.EDU || {}));
