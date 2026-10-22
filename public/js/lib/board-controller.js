// BoardController — owns one board's client state, keeps it in sync via REST + SSE (docs/CONTRACT.md §6, §8).
import { h } from './h.js';
import { api, ApiError, clientId } from './api.js';
import { store } from './store.js';
import { router } from './router.js';
import { SECTIONED } from './constants.js';
import { BASE } from './base.js';
import { modal, toast } from './ui.js';
import { plainText } from './markdown.js';

// Thresholds can be overridden from the page (window.__EDULET_HIDE_MS / __EDULET_SILENCE_MS) so e2e tests need not wait.
const hideMs = () => (typeof window !== 'undefined' && window.__EDULET_HIDE_MS) || 15000;
const silenceMs = () => (typeof window !== 'undefined' && window.__EDULET_SILENCE_MS) || 70000;

const RANK = { read: 1, comment: 2, write: 3, moderate: 4, admin: 5 };
const EVENTS = [
  'hello', 'ping', 'presence', 'board.updated', 'board.deleted', 'members.updated',
  'section.created', 'section.updated', 'section.moved', 'section.deleted',
  'post.created', 'post.updated', 'post.moved', 'post.deleted',
  'comment.created', 'comment.deleted', 'reaction.updated',
];

export function emptyReactions() {
  return {
    like: { count: 0, mine: false }, vote: { count: 0, mine: false }, star: { count: 0, mine: false },
    grade: { count: 0, avg: 0, mine: 0 }, emoji: {},
  };
}

/** Merge server reactions into old ones. Fields the server omits (`mine`, e.g. in SSE events) keep their old value. */
export function mergeReactions(old, inc) {
  const base = old || emptyReactions();
  const out = emptyReactions();
  inc = inc || {};
  for (const k of ['like', 'vote', 'star']) {
    const i = inc[k] || {};
    out[k] = { count: i.count ?? 0, mine: i.mine !== undefined ? !!i.mine : !!(base[k] && base[k].mine) };
  }
  const g = inc.grade || {};
  out.grade = { count: g.count ?? 0, avg: g.avg ?? 0, mine: g.mine !== undefined ? g.mine : (base.grade && base.grade.mine) || 0 };
  const emo = inc.emoji || {};
  for (const e of Object.keys(emo)) {
    const oldE = base.emoji && base.emoji[e];
    out.emoji[e] = { count: emo[e].count ?? 0, mine: emo[e].mine !== undefined ? !!emo[e].mine : !!(oldE && oldE.mine) };
  }
  return out;
}

export class BoardController {
  constructor(slug) {
    this.slug = slug;
    this.state = {
      status: 'loading', board: null, role: null, isOwner: false, sections: [], posts: [], members: [], presence: [],
      me: store.me, search: '', openPostId: null, slideshow: false, connected: false,
    };
    this._subs = new Set();
    this._es = null;
    this._retry = 0;
    this._timer = null;
    this._destroyed = false;
    this._needResync = false;
    this._reloading = null;
    this._lastEventAt = Date.now();
    this._suspended = false; // stream closed on purpose (tab hidden / page hidden)
    this._hideTimer = null;
    this._pushedDetail = false; // the open post's history entry was pushed by openPost()
    this._wantedPost = null; // post id taken from the URL, applied once the snapshot has arrived
    this._bindLifecycle();
    this._lastMeId = store.me ? store.me.id : null;
    this._unsubMe = store.subscribe('me', () => {
      this.state.me = store.me;
      const id = store.me ? store.me.id : null;
      if (id !== this._lastMeId) {
        this._lastMeId = id;
        this._reload({ reconnect: true });
      } else this._emit('ui');
    });
  }

  /* ───────── lifecycle ───────── */
  async load() {
    // Subscribe first, then fetch: the server registers the stream before it sends `hello`, so anything that
    // changes after the snapshot is read is delivered as an event (no gap between "snapshot" and "connected").
    await this._openStream();
    await this._fetchSnapshot();
    if (this.state.status === 'ready') {
      if (!this._es) this._connect();
    } else if (this._es) {
      this._es.close();
      this._es = null;
    }
  }

  /** Opens the event stream and resolves on its first open/error (or after 4s) so load() never hangs on it. */
  _openStream() {
    return new Promise((resolve) => {
      this._firstOpen = resolve;
      this._connect();
      setTimeout(resolve, 4000);
    });
  }
  _resolveFirst() {
    const f = this._firstOpen;
    this._firstOpen = null;
    if (f) f();
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._timer);
    this._unbindLifecycle();
    if (this._es) this._es.close();
    this._es = null;
    this._unsubMe && this._unsubMe();
    this._subs.clear();
  }

  /* ───────── connection lifecycle: hidden tabs, silent links, going offline ───────── */
  _bindLifecycle() {
    // A browser allows ~6 connections per host and every open board holds one stream: park the stream of tabs nobody
    // is looking at (otherwise the 6th tab never loads), and catch up when the tab comes back.
    this._onVis = () => {
      clearTimeout(this._hideTimer);
      if (document.hidden) this._hideTimer = setTimeout(() => this._suspend(), hideMs());
      else this._resume();
    };
    this._onHide = () => this._suspend();
    this._onShow = (e) => {
      if (e.persisted || this._suspended) this._resume();
    };
    this._onOnline = () => this._resume(true);
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('pagehide', this._onHide);
    window.addEventListener('pageshow', this._onShow);
    window.addEventListener('online', this._onOnline);
    // Silent-death watchdog: the server sends a named `ping` event every 25 s, so 70 s without any event means the
    // link is dead even though the browser has not noticed.
    this._watchdog = setInterval(() => {
      if (this._suspended || !this._es || this.state.status !== 'ready') return;
      if (Date.now() - this._lastEventAt > silenceMs()) this._restartStream();
    }, 1000);
  }
  _unbindLifecycle() {
    clearInterval(this._watchdog);
    clearTimeout(this._hideTimer);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('pagehide', this._onHide);
    window.removeEventListener('pageshow', this._onShow);
    window.removeEventListener('online', this._onOnline);
  }
  _suspend() {
    if (this._suspended || this._destroyed || this.state.status !== 'ready') return;
    this._suspended = true;
    this._needResync = true;
    clearTimeout(this._timer);
    if (this._es) this._es.close();
    this._es = null;
    this.state.connected = false; // no UI emit: nobody is looking
  }
  _resume(force = false) {
    if (this._destroyed || this.state.status !== 'ready') return;
    if (!force && !this._suspended && this._es) return;
    this._suspended = false;
    this._restartStream();
  }
  _restartStream() {
    if (this._destroyed) return;
    if (this._es) this._es.close();
    this._es = null;
    clearTimeout(this._timer);
    this._needResync = true; // the new stream's onopen refetches the snapshot
    this._lastEventAt = Date.now();
    this.state.connected = false;
    this._emit('ui');
    this._connect();
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit(type, extra) {
    if (this._destroyed) return;
    const ev = { type, ...extra };
    for (const fn of [...this._subs]) {
      try {
        fn(ev);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /* ───────── snapshot / SSE ───────── */
  /** `resync` marks a snapshot fetched to catch up after a reconnect: open detail views reload their comments. */
  async _fetchSnapshot({ resync = false } = {}) {
    try {
      const r = await api.get(`/boards/${encodeURIComponent(this.slug)}`);
      const s = this.state;
      s.board = r.board;
      s.role = r.role;
      s.isOwner = !!r.isOwner;
      s.sections = r.sections || [];
      s.posts = (r.posts || []).map((p) => ({ ...p, reactions: mergeReactions(null, p.reactions) }));
      s.members = r.members || [];
      s.presence = r.presence || s.presence;
      s.status = 'ready';
      if (s.openPostId != null && !s.posts.some((p) => p.id === s.openPostId)) s.openPostId = null;
    } catch (e) {
      this.state.status = e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 401) ? 'notfound' : 'error';
      this.state.error = e;
    }
    this._emit('snapshot', { resync });
    // a post named in the URL before the snapshot existed
    if (this._wantedPost != null && this.state.status === 'ready') {
      const w = this._wantedPost;
      this._wantedPost = null;
      this.syncFromUrl(w);
    }
  }

  _reload({ reconnect = false } = {}) {
    if (this._reloading) return this._reloading;
    this._reloading = (async () => {
      await this._fetchSnapshot({ resync: true });
      if (reconnect) {
        if (this._es) this._es.close();
        this._es = null;
        if (this.state.status === 'ready') this._connect();
      }
    })().finally(() => (this._reloading = null));
    return this._reloading;
  }

  _connect() {
    if (this._destroyed || this._es) return;
    const es = new EventSource(`${BASE}/api/boards/${encodeURIComponent(this.slug)}/events`);
    this._es = es;
    es.onopen = () => {
      this._lastEventAt = Date.now();
      this._everOpened = true;
      this.state.streamRefused = false;
      this.state.connected = true;
      this._retry = 0;
      this._resolveFirst();
      if (this._needResync) {
        this._needResync = false;
        this._fetchSnapshot({ resync: true });
      }
      this._emit('ui');
    };
    es.onerror = () => {
      this.state.connected = false;
      this._needResync = true;
      this._resolveFirst();
      if (es.readyState === 2 /* CLOSED */ && !this._everOpened) this.state.streamRefused = true; // refused outright (cap, 404…)
      this._emit('ui');
      if (es.readyState === 2 /* CLOSED */) {
        this._es = null;
        if (this.state.status !== 'ready') return; // still loading, or not viewable: load() decides what happens next
        const wait = Math.min(15000, 1000 * 2 ** this._retry++);
        clearTimeout(this._timer);
        this._timer = setTimeout(async () => {
          if (this._destroyed) return;
          this._needResync = false;
          await this._fetchSnapshot({ resync: true });
          if (this.state.status === 'ready') this._connect();
        }, wait);
      }
    };
    for (const type of EVENTS) {
      es.addEventListener(type, (ev) => {
        this._lastEventAt = Date.now();
        let data = {};
        try {
          data = JSON.parse(ev.data || '{}');
        } catch {
          return;
        }
        this._onEvent(type, data);
      });
    }
  }

  _onEvent(type, d) {
    const s = this.state;
    switch (type) {
      case 'hello':
      case 'presence':
        s.presence = d.presence || [];
        s.presenceMore = d.more || 0; // the server lists at most 50 people and counts the rest
        return this._emit('presence');
      case 'board.updated': {
        const prev = s.board;
        s.board = d.board;
        this._emit('board');
        // visibility / access changes may change our role or the section structure
        // …or what the server sends us (hidden authors under showAuthor=false, pending edits under approval)
        const ps = (prev && prev.settings) || {}, ns = d.board.settings || {};
        if (prev && (prev.visibility !== d.board.visibility || prev.linkAccess !== d.board.linkAccess || prev.format !== d.board.format || ps.showAuthor !== ns.showAuthor || ps.approval !== ns.approval)) this._reload();
        return;
      }
      case 'board.deleted':
        s.status = 'notfound';
        return this._emit('snapshot');
      case 'members.updated':
        return this._reload();
      case 'section.created':
      case 'section.updated':
      case 'section.moved':
        this._upsertSection(d.section);
        return this._emit('sections');
      case 'section.deleted':
        s.sections = s.sections.filter((x) => x.id !== d.id);
        if (d.mode === 'delete') s.posts = s.posts.filter((p) => p.sectionId !== d.id);
        else s.posts.forEach((p) => p.sectionId === d.id && (p.sectionId = null));
        this._emit('sections');
        return this._emit('posts');
      case 'post.created':
      case 'post.updated':
      case 'post.moved':
        this._upsertPost(d.post);
        return;
      case 'post.deleted':
        return this._removePost(d.id);
      case 'comment.created': {
        const p = this.postById(d.postId);
        if (p) p.commentCount = d.commentCount;
        return this._emit('comments', { postId: d.postId, comment: d.comment, commentCount: d.commentCount, deleted: false });
      }
      case 'comment.deleted': {
        const p = this.postById(d.postId);
        if (p) p.commentCount = d.commentCount;
        return this._emit('comments', { postId: d.postId, commentId: d.id, commentCount: d.commentCount, deleted: true });
      }
      case 'reaction.updated': {
        const p = this.postById(d.postId);
        if (!p) return;
        p.reactions = mergeReactions(p.reactions, d.reactions);
        // I reacted from another tab/device: the event carries counts only, so ask for my own state
        if (d.by && store.me && d.by === store.me.id && d.origin !== clientId) this._refreshMine(d.postId);
        return this._emit('post', { post: p });
      }
    }
  }

  _upsertSection(sec) {
    const i = this.state.sections.findIndex((x) => x.id === sec.id);
    if (i >= 0) this.state.sections[i] = { ...this.state.sections[i], ...sec };
    else this.state.sections.push(sec);
  }

  _upsertPost(p) {
    const s = this.state;
    const i = s.posts.findIndex((x) => x.id === p.id);
    const merged = { ...p, reactions: mergeReactions(i >= 0 ? s.posts[i].reactions : null, p.reactions) };
    if (i >= 0) s.posts[i] = merged;
    else s.posts.push(merged);
    this._emit(i >= 0 ? 'post' : 'posts', { post: merged });
    return merged;
  }

  _removePost(id) {
    const s = this.state;
    const n = s.posts.length;
    s.posts = s.posts.filter((p) => p.id !== id);
    if (s.openPostId === id) this.closePost();
    if (s.posts.length !== n) this._emit('posts');
  }

  /* ───────── permissions ───────── */
  _rank() {
    return RANK[this.state.role] || 0;
  }
  can(action) {
    const s = this.state;
    const r = this._rank();
    switch (action) {
      case 'view': return r >= 1;
      case 'comment': return r >= 2 && !!s.board && s.board.settings.comments !== 'off';
      case 'react': return r >= 2 && !!s.board && s.board.settings.reactions !== 'none';
      case 'post': return r >= 3;
      case 'moderate': return r >= 4;
      case 'admin': return r >= 5;
      case 'owner': return s.isOwner;
      default: return false;
    }
  }
  isMine(post) {
    return !!(store.me && post && post.author && post.author.id === store.me.id);
  }
  canEditPost(post) {
    const r = this._rank();
    return (this.isMine(post) && r >= 3) || r >= 4;
  }
  canMovePost(post) {
    return this.canEditPost(post);
  }

  /* ───────── derived ───────── */
  get sectioned() {
    return !!this.state.board && SECTIONED.includes(this.state.board.format);
  }

  visiblePosts() {
    const s = this.state;
    const mod = this._rank() >= 4;
    const q = s.search.trim().toLowerCase();
    return s.posts.filter((p) => {
      if (p.status === 'pending' && !mod && !this.isMine(p)) return false;
      if (!q) return true;
      const a = p.attachment || {};
      const hay = [p.title, plainText(p.body), p.author && p.author.displayName, a.name, a.preview && a.preview.title, a.preview && a.preview.description, a.url]
        .filter(Boolean).join('\n').toLowerCase();
      return hay.includes(q);
    });
  }

  _sort(list) {
    if (this.state.board && this.state.board.format === 'backchannel') return list.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.rank - b.rank || a.id - b.id);
  }

  /** Posts of one section (null = no section), sorted per CONTRACT §3. */
  postsOf(sectionId) {
    return this._sort(this.visiblePosts().filter((p) => (p.sectionId ?? null) === (sectionId ?? null)));
  }
  /** All visible posts in board order (non-sectioned formats). */
  sortedPosts() {
    return this._sort(this.visiblePosts());
  }
  sortedSections() {
    return [...this.state.sections].sort((a, b) => a.rank - b.rank || a.id - b.id);
  }
  /** Posts in the order used by the detail pager / slideshow ("n / N"). */
  navPosts() {
    if (!this.sectioned) return this.sortedPosts();
    const out = [];
    const known = new Set();
    for (const sec of this.sortedSections()) {
      known.add(sec.id);
      out.push(...this.postsOf(sec.id));
    }
    out.push(...this._sort(this.visiblePosts().filter((p) => p.sectionId == null || !known.has(p.sectionId))));
    return out;
  }
  postById(id) {
    return this.state.posts.find((p) => p.id === id) || null;
  }
  sectionById(id) {
    return this.state.sections.find((x) => x.id === id) || null;
  }
  indexOfPost(id) {
    return this.navPosts().findIndex((p) => p.id === id);
  }

  /* ───────── identity (guests) ───────── */
  /** Make sure we have an identity (guest sign-in prompt when anonymous). Throws ApiError('cancelled') if declined. */
  ensureIdentity() {
    if (store.me) return Promise.resolve(store.me);
    return new Promise((resolve, reject) => {
      let settled = false;
      const input = h('input', { class: 'input', type: 'text', maxlength: 40, placeholder: '예: 김하늘', autofocus: true, autocomplete: 'nickname' });
      const err = h('p', { class: 'form-error', role: 'alert' });
      let inflight = false;
      // secondary way in: no typing, a made-up name ("참여자 1234", four digits so a class of 30 rarely shares one) — so a whole class can open the link and start at once
      const anonBtn = h('button', { type: 'button', class: 'btn btn-secondary guest-anon', dataset: { role: 'guest-anon' }, onClick: () => submit(m.close, `참여자 ${1000 + Math.floor(Math.random() * 9000)}`) }, '이름 없이 바로 참여');
      // `given`: a name decided in code ("이름 없이 바로 참여"); otherwise the typed one
      const submit = async (close, given) => {
        const name = given != null ? given : input.value.trim();
        if (!name) {
          err.textContent = '이름을 입력해 주세요.';
          return false;
        }
        if (inflight) return false; // a double click / Enter must not create two guests
        inflight = true;
        anonBtn.disabled = true;
        try {
          const u = await store.guest(name);
          settled = true;
          clearInterval(countdown);
          resolve(u);
          close();
        } catch (e) {
          if (e.code === 'rate_limited' && e.retryAfter) {
            // a whole class may be joining at once: wait the hinted time and retry automatically
            let left = Math.min(e.retryAfter, 60);
            clearInterval(countdown);
            const tick = () => {
              err.textContent = `지금 참여하는 사람이 많아요. ${left}초 뒤에 자동으로 다시 시도해요.`;
              if (left-- <= 0) {
                clearInterval(countdown);
                err.textContent = '';
                submit(close, given);
              }
            };
            tick();
            countdown = setInterval(tick, 1000);
          } else err.textContent = e.message || '입장하지 못했어요.';
        } finally {
          inflight = false;
          anonBtn.disabled = false;
        }
        return false;
      };
      let countdown = null;
      const m = modal({
        title: '이름을 알려 주세요', size: 'sm',
        body: h('form', { onSubmit: (e) => { e.preventDefault(); submit(m.close); } },
          h('p', { class: 'modal-text' }, '글과 댓글에 표시될 이름이에요. 로그인하지 않아도 참여할 수 있어요.'),
          h('label', { class: 'field' }, h('span', { class: 'label' }, '이름'), input), err,
          anonBtn,
          h('p', { class: 'hint guest-anon-hint' }, '‘참여자 1234’ 같은 임시 이름으로 바로 들어가요.')),
        actions: [
          { label: '취소', kind: 'secondary', onClick: () => {} },
          { label: '참여하기', kind: 'primary', keepOpen: true, onClick: (close) => submit(close) },
        ],
        onClose: () => {
          clearInterval(countdown);
          if (!settled) reject(new ApiError(0, 'cancelled', '취소했어요.'));
        },
      });
    });
  }

  /**
   * ensureIdentity(), then wait for the snapshot reload that a new identity triggers (the role may have changed). Without the wait the
   * snapshot — asked for before the first write, answered by the server before it — can arrive AFTER the write's response and wipe the
   * just-created card from this very screen (the stream does not echo our own events back); easy to hit when a guest joins and posts at once.
   */
  async _identity() {
    const u = await this.ensureIdentity();
    if (this._reloading) {
      try {
        await this._reloading;
      } catch {
        /* a failed reload is reported by the snapshot itself */
      }
    }
    return u;
  }

  /** Run `fn` as a signed-in user; if the session turned out to be gone (signed out in another tab) ask again once. */
  async _auth(fn) {
    await this._identity();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await this._identity();
        return fn();
      }
      throw e;
    }
  }

  /* ───────── post actions ───────── */
  async createPost(data) {
    const r = await this._auth(() => api.post(`/boards/${encodeURIComponent(this.slug)}/posts`, data));
    return this._upsertPost(r.post);
  }

  async _refreshMine(id) {
    try {
      const r = await api.get(`/posts/${id}/reactions`);
      const p = this.postById(id);
      if (!p) return;
      p.reactions = mergeReactions(null, r.reactions);
      this._emit('post', { post: p });
    } catch {
      /* the next snapshot will fix it */
    }
  }

  async updatePost(id, patch) {
    const r = await api.patch(`/posts/${id}`, patch);
    return this._upsertPost(r.post);
  }

  async deletePost(id) {
    await api.del(`/posts/${id}`);
    this._removePost(id);
  }

  async approvePost(id) {
    const r = await api.post(`/posts/${id}/approve`);
    return this._upsertPost(r.post);
  }

  /** Move/reorder. beforeId=null → end of the target section. Optimistic, reverted on failure. */
  async movePost(id, { sectionId = null, beforeId = null } = {}) {
    const p = this.postById(id);
    if (!p) return null;
    const backup = { sectionId: p.sectionId, rank: p.rank };
    const siblings = this._sort(this.state.posts.filter((x) => x.id !== id && (x.sectionId ?? null) === (sectionId ?? null) && x.status !== 'pending'));
    const idx = beforeId == null ? siblings.length : siblings.findIndex((x) => x.id === beforeId);
    const at = idx < 0 ? siblings.length : idx;
    const prev = siblings[at - 1], next = siblings[at];
    p.sectionId = sectionId ?? null;
    p.rank = prev && next ? (prev.rank + next.rank) / 2 : prev ? prev.rank + 1 : next ? next.rank - 1 : 1;
    this._emit('posts', { post: p });
    try {
      const r = await api.post(`/posts/${id}/move`, { sectionId: sectionId ?? null, beforeId });
      return this._upsertPost(r.post);
    } catch (e) {
      p.sectionId = backup.sectionId;
      p.rank = backup.rank;
      this._emit('posts', { post: p });
      throw e;
    }
  }

  /** Canvas drag/resize. Optimistic. */
  async setPostPosition(id, { x, y, w } = {}) {
    const p = this.postById(id);
    if (!p) return null;
    const backup = { x: p.x, y: p.y, w: p.w };
    if (x !== undefined) p.x = x;
    if (y !== undefined) p.y = y;
    if (w !== undefined) p.w = w;
    this._emit('post', { post: p });
    try {
      const patch = {};
      if (x !== undefined) patch.x = x;
      if (y !== undefined) patch.y = y;
      if (w !== undefined) patch.w = w;
      const r = await api.patch(`/posts/${id}`, patch);
      return this._upsertPost(r.post);
    } catch (e) {
      Object.assign(p, backup);
      this._emit('post', { post: p });
      throw e;
    }
  }

  /** kind: like|vote|star|grade|emoji. Optimistic, then confirmed by the response. */
  async react(id, kind, value) {
    await this._identity();
    const p = this.postById(id);
    if (!p) return null;
    const before = p.reactions;
    const r = (p.reactions = mergeReactions(before, before));
    if (kind === 'like' || kind === 'vote' || kind === 'star') {
      const x = r[kind];
      x.mine = !x.mine;
      x.count = Math.max(0, x.count + (x.mine ? 1 : -1));
    } else if (kind === 'grade') {
      const g = r.grade;
      const sum = g.avg * g.count - (g.mine || 0);
      let count = g.count - (g.mine ? 1 : 0);
      const next = !value || value === g.mine ? 0 : value;
      if (next) count += 1;
      g.avg = count ? (sum + next) / count : 0;
      g.count = count;
      g.mine = next;
    } else if (kind === 'emoji') {
      const e = r.emoji[value] || (r.emoji[value] = { count: 0, mine: false });
      e.mine = !e.mine;
      e.count = Math.max(0, e.count + (e.mine ? 1 : -1));
      if (!e.count) delete r.emoji[value];
    }
    this._emit('post', { post: p });
    try {
      const res = await api.put(`/posts/${id}/reactions`, value === undefined ? { kind } : { kind, value });
      p.reactions = mergeReactions(null, res.reactions);
      this._emit('post', { post: p });
      return p.reactions;
    } catch (e) {
      p.reactions = before;
      this._emit('post', { post: p });
      throw e;
    }
  }

  /* ───────── comments ───────── */
  async loadComments(id) {
    const r = await api.get(`/posts/${id}/comments`);
    return r.comments || [];
  }

  async addComment(id, body) {
    const r = await this._auth(() => api.post(`/posts/${id}/comments`, { body }));
    const p = this.postById(id);
    if (p) p.commentCount = r.commentCount;
    this._emit('comments', { postId: id, comment: r.comment, commentCount: r.commentCount, deleted: false, mine: true });
    return r.comment;
  }

  async deleteComment(commentId, postId) {
    const r = await api.del(`/comments/${commentId}`);
    const p = this.postById(postId);
    if (p) p.commentCount = r.commentCount;
    this._emit('comments', { postId, commentId, commentCount: r.commentCount, deleted: true, mine: true });
  }

  /* ───────── sections ───────── */
  async createSection(title, beforeId) {
    const r = await api.post(`/boards/${encodeURIComponent(this.slug)}/sections`, beforeId ? { title, beforeId } : { title });
    this._upsertSection(r.section);
    this._emit('sections');
    return r.section;
  }
  async renameSection(id, title) {
    const r = await api.patch(`/sections/${id}`, { title });
    this._upsertSection(r.section);
    this._emit('sections');
    return r.section;
  }
  async moveSection(id, beforeId = null) {
    const r = await api.post(`/sections/${id}/move`, { beforeId });
    this._upsertSection(r.section);
    this._emit('sections');
    return r.section;
  }
  /** mode: 'move' (posts go to the first other section) | 'delete' */
  async deleteSection(id, mode = 'move') {
    await api.del(`/sections/${id}?posts=${mode}`);
    this.state.sections = this.state.sections.filter((x) => x.id !== id);
    if (mode === 'delete') this.state.posts = this.state.posts.filter((p) => p.sectionId !== id);
    await this._reload();
  }

  /* ───────── attachments ───────── */
  async upload(file, onProgress) {
    const r = await this._auth(() => api.upload(this.slug, file, onProgress));
    return { kind: r.kind, uploadId: r.id, name: r.name, url: r.url, mime: r.mime, size: r.size };
  }
  async linkPreview(url) {
    return this._auth(() => api.post('/link-preview', { url }));
  }

  /* ───────── board ───────── */
  async updateBoard(patch) {
    const before = this.state.board && this.state.board.format;
    const r = await api.patch(`/boards/${encodeURIComponent(this.slug)}`, patch);
    this.state.board = r.board;
    this._emit('board');
    if (patch.format && patch.format !== before) await this._reload();
    return r.board;
  }

  /* ───────── ui state ───────── */
  setSearch(q) {
    this.state.search = q || '';
    this._emit('ui', { search: true });
  }

  _boardUrl() {
    return `/b/${encodeURIComponent(this.slug)}`;
  }
  /** A link pointed at a post that is gone / hidden / not a number: say so and fall back to the board. */
  _missingPost() {
    this.state.openPostId = null;
    this._pushedDetail = false;
    router.replace(this._boardUrl());
    toast('찾을 수 없는 글이에요. 지워졌거나 볼 수 없는 글일 수 있어요.', 'info');
    this._emit('ui', { openPost: true, missingPost: true });
  }

  openPost(id) {
    const s = this.state;
    id = Number(id);
    if (s.status === 'ready' && !this.visiblePosts().some((p) => p.id === id)) return this._missingPost();
    const wasOpen = s.openPostId != null;
    s.openPostId = id;
    const path = `${this._boardUrl()}/p/${id}`;
    if (wasOpen) router.replace(path);
    else {
      router.push(path);
      this._pushedDetail = true; // closing goes back one entry instead of leaving a dead duplicate behind
    }
    this._emit('ui', { openPost: true });
  }
  closePost() {
    if (this.state.openPostId == null) return;
    this.state.openPostId = null;
    this._emit('ui', { openPost: true });
    if (this._pushedDetail) {
      this._pushedDetail = false;
      history.back(); // popstate → router → syncFromUrl(null) is then a no-op
    } else router.replace(this._boardUrl());
  }
  /** Called by the router (back/forward, deep link) — updates state without touching the URL. */
  syncFromUrl(postId) {
    const s = this.state;
    const raw = postId == null || postId === '' ? null : Number(postId);
    if (raw !== null && !Number.isFinite(raw)) return this._missingPost();
    const id = raw;
    if (id !== null && s.status !== 'ready') {
      this._wantedPost = id; // applied when the snapshot arrives
      return;
    }
    if (id !== null && !this.visiblePosts().some((p) => p.id === id)) return this._missingPost();
    // A deep link / back-forward landing: we did not push this entry, so closing must replace the URL, not go back.
    this._pushedDetail = false;
    if (s.openPostId === id) return;
    s.openPostId = id;
    this._emit('ui', { openPost: true });
  }
  openSlideshow() {
    this.state.slideshow = true;
    this._emit('ui', { slideshow: true });
  }
  closeSlideshow() {
    this.state.slideshow = false;
    this._emit('ui', { slideshow: true });
  }
}
