/* Edulet demo mode — page-side bootstrap (classic script, runs BEFORE js/main.js; see tools/build-pages.mjs).
 *
 *  1. marks the page as demo (window.EDULET_DEMO / EDULET_BASE, read by js/lib/base.js)
 *  2. registers the service worker that acts as the server and exposes window.__edulet_ready (main.js awaits it)
 *  3. replaces window.EventSource for the board event URL with a shim fed by the worker through BroadcastChannel
 *  4. shows the small "데모 모드" badge with an explanation dialog and the "데모 데이터 초기화" button
 *
 * Nothing here depends on the app's modules. */
(function () {
  'use strict';

  const doc = document;
  const BASE = new URL(doc.baseURI).pathname.replace(/\/+$/, ''); // "/edulet" ("" when served from a domain root)
  const SID_KEY = 'edulet_demo_sid'; // session token (js/lib/api.js keeps it in sync with the worker's X-Edulet-Session header)
  const PILL_KEY = 'edulet_demo_pill'; // "collapsed" once the badge was minimised
  const RELOAD_GUARD = 'edulet_demo_sw_reload';
  const README_URL = 'https://github.com/dhsy3206/edulet#빠른-시작';

  window.EDULET_DEMO = true;
  window.EDULET_BASE = BASE;

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } };
  const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* storage blocked */ } };
  const ssDel = (k) => { try { sessionStorage.removeItem(k); } catch { /* storage blocked */ } };
  const onDom = (fn) => (doc.readyState === 'loading' ? doc.addEventListener('DOMContentLoaded', fn, { once: true }) : fn());

  /** Tiny DOM builder (static text only — no innerHTML anywhere in this file). */
  function el(tag, props, ...kids) {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  /* ───────── styles (the page CSP allows inline styles) ───────── */
  const CSS = `
.edulet-demo-pill{position:fixed;left:12px;bottom:12px;z-index:55;display:flex;align-items:center;background:#0f172a;color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:999px;box-shadow:0 2px 12px rgba(0,0,0,.4);font:600 13px/1.2 system-ui,-apple-system,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif}
.edulet-demo-pill button{all:unset;box-sizing:border-box;min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;color:inherit;border-radius:999px;-webkit-tap-highlight-color:transparent}
.edulet-demo-pill button:focus-visible{outline:3px solid #fde047;outline-offset:1px}
.edulet-demo-pill .edp-main{padding:0 6px 0 14px}
.edulet-demo-pill .edp-x{width:40px;padding:0;font-size:18px;opacity:.85}
.edulet-demo-pill .edp-dot{width:8px;height:8px;border-radius:50%;background:#fbbf24;flex:none}
.edulet-demo-pill .edp-i{display:none;font:700 17px/1 Georgia,"Times New Roman",serif}
.edulet-demo-pill.is-collapsed .edp-main{width:40px;padding:0}
.edulet-demo-pill.is-collapsed .edp-dot,.edulet-demo-pill.is-collapsed .edp-label,.edulet-demo-pill.is-collapsed .edp-x{display:none}
.edulet-demo-pill.is-collapsed .edp-i{display:inline}
.edulet-demo-dialog{box-sizing:border-box;width:min(520px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:22px 22px 18px;border:0;border-radius:16px;background:#fff;color:#0f172a;box-shadow:0 12px 48px rgba(0,0,0,.4);font:400 15px/1.6 system-ui,-apple-system,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif}
.edulet-demo-dialog::backdrop{background:rgba(15,23,42,.55)}
.edulet-demo-dialog h2{margin:0 0 10px;font-size:19px;line-height:1.3}
.edulet-demo-dialog ul{margin:0 0 14px;padding-left:20px}
.edulet-demo-dialog li{margin:0 0 6px}
.edulet-demo-dialog a{color:#0b5fd0;font-weight:600}
.edulet-demo-dialog .edd-row{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:center;margin-top:12px}
.edulet-demo-dialog .edd-ask{flex:1 1 100%;margin:0;font-weight:600;color:#b42318}
.edulet-demo-dialog button{min-height:44px;padding:0 16px;border-radius:10px;border:1px solid #cbd5e1;background:#f1f5f9;color:#0f172a;font:600 14px system-ui,"Malgun Gothic",sans-serif;cursor:pointer}
.edulet-demo-dialog button.edd-primary{background:#0e7a4b;border-color:#0e7a4b;color:#fff}
.edulet-demo-dialog button.edd-danger{background:#fff;border-color:#b42318;color:#b42318}
.edulet-demo-dialog button.edd-danger-go{background:#b42318;border-color:#b42318;color:#fff}
.edulet-demo-dialog button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
.edulet-demo-fatal{box-sizing:border-box;max-width:560px;margin:12vh auto 0;padding:24px;font:400 16px/1.7 system-ui,-apple-system,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif;color:#0f172a}
.edulet-demo-fatal h1{margin:0 0 10px;font-size:22px}
.edulet-demo-fatal a{color:#0b5fd0;font-weight:600}
`;
  function injectStyles() {
    if (doc.getElementById('edulet-demo-style')) return;
    doc.head.append(el('style', { id: 'edulet-demo-style' }, CSS));
  }

  /* ───────── friendly failure screen (never a blank page) ───────── */
  function fatal(title, detail) {
    onDom(() => {
      injectStyles();
      const app = doc.getElementById('app') || doc.body;
      app.replaceChildren(el('div', { class: 'edulet-demo-fatal', role: 'alert' },
        el('h1', null, title),
        el('p', null, detail),
        el('p', null, '여러 사람이 함께 쓰는 진짜 서버 버전은 ', el('a', { href: README_URL, target: '_blank', rel: 'noopener noreferrer' }, 'README의 서버 실행 방법'), '을 따라 직접 실행할 수 있어요.')));
    });
  }
  const never = () => new Promise(() => {}); // main.js keeps waiting; the message above stays on screen

  /* ───────── service worker ───────── */
  const swSupported = 'serviceWorker' in navigator;

  function waitForController(ms) {
    return new Promise((resolve) => {
      const sw = navigator.serviceWorker;
      if (sw.controller) return resolve(true);
      let timer;
      const done = (v) => { clearTimeout(timer); sw.removeEventListener('controllerchange', onChange); resolve(v); };
      const onChange = () => { if (sw.controller) done(true); };
      timer = setTimeout(() => done(!!sw.controller), ms);
      sw.addEventListener('controllerchange', onChange);
      onChange();
    });
  }

  async function startWorker() {
    if (!swSupported) {
      fatal('이 브라우저에서는 데모 모드를 쓸 수 없어요', '데모 모드는 브라우저의 서비스 워커로 서버를 흉내 내기 때문에, 서비스 워커를 쓸 수 없는 환경(일부 시크릿·사생활 보호 창, 오래된 브라우저, http 주소)에서는 열리지 않아요. 최신 Chrome·Edge·Safari·Firefox의 일반 창에서 다시 열어 보세요.');
      return never();
    }
    try {
      await navigator.serviceWorker.register(new URL('edulet-sw.js', doc.baseURI).href, { scope: BASE + '/', updateViaCache: 'none' });
    } catch (e) {
      console.error('[edulet-demo] service worker registration failed', e);
      fatal('데모 모드를 시작하지 못했어요', '서비스 워커를 등록하지 못했어요. 브라우저가 이 사이트의 서비스 워커·저장 공간을 막고 있을 수 있어요(사이트 설정 또는 시크릿 창 확인).');
      return never();
    }
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 30000));
    if ((await Promise.race([navigator.serviceWorker.ready, timeout])) === 'timeout') {
      fatal('데모 모드가 시작되지 않아요', '서비스 워커가 30초 안에 준비되지 않았어요. 페이지를 새로고침해 보세요.');
      return never();
    }
    // The worker calls clients.claim(); a hard reload (Ctrl+Shift+R) leaves the page uncontrolled → reload once.
    if (!(await waitForController(8000))) {
      if (!ssGet(RELOAD_GUARD)) {
        ssSet(RELOAD_GUARD, '1');
        location.reload();
      } else {
        fatal('데모 모드를 시작하지 못했어요', '서비스 워커가 이 페이지를 맡지 못했어요. 페이지를 한 번 더 새로고침해 보세요.');
      }
      return never();
    }
    ssDel(RELOAD_GUARD);
    return true;
  }
  window.__edulet_ready = startWorker();

  /* ───────── EventSource shim ───────── */
  const NativeEventSource = window.EventSource;
  const esRe = new RegExp('^' + BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/api/boards/([^/]+)/events/?$');
  const active = new Map(); // sid → DemoEventSource
  let channel = null;
  try { channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('edulet-demo-events'); } catch { channel = null; }

  const makeSid = () => {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return 's' + [...a].map((b) => b.toString(36).padStart(2, '0')).join('');
  };
  function demoHeaders() {
    const h = { 'Content-Type': 'application/json' };
    const s = lsGet(SID_KEY);
    if (s) h['X-Edulet-Session'] = s;
    const c = ssGet('edulet_cid');
    if (c) h['X-Client-Id'] = c;
    return h;
  }
  const closeBeacon = (sid) => {
    try { navigator.sendBeacon(`${BASE}/api/_demo/stream/close?sid=${encodeURIComponent(sid)}`); } catch { /* best effort */ }
  };

  class DemoEventSource extends EventTarget {
    constructor(url, slug) {
      super();
      this.url = url;
      this.withCredentials = false;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this._slug = slug;
      this._sid = makeSid();
      this._closed = false;
      this._busy = false;
      this._pingTimer = null;
      this._localPing = null;
      this._retry = null;
      active.set(this._sid, this);
      this._register(false);
    }

    _fire(ev) {
      this.dispatchEvent(ev);
      const h = this['on' + ev.type];
      if (typeof h === 'function') {
        try { h.call(this, ev); } catch (e) { console.error(e); }
      }
    }
    _event(type, data) {
      this._fire(new MessageEvent(type, { data: JSON.stringify(data === undefined ? {} : data) }));
    }
    _timers(on) {
      clearInterval(this._pingTimer);
      clearInterval(this._localPing);
      this._pingTimer = this._localPing = null;
      if (!on) return;
      // the interval can be shortened from the page (window.__EDULET_DEMO_PING_MS) so e2e tests need not wait, like the controller's own knobs
      this._pingTimer = setInterval(() => this._ping(), window.__EDULET_DEMO_PING_MS || 20000); // keeps the stream alive in the worker
      this._localPing = setInterval(() => this._event('ping', {}), 25000); // the controller's silence watchdog needs events
    }

    /** Register the stream in the worker. `dropped`: the connection was already reported as lost (readyState 0, error fired). */
    async _register(announceDrop, dropped = false) {
      if (this._closed || this._busy) return;
      this._busy = true;
      let res = null;
      let data = {};
      try {
        res = await fetch(`${BASE}/api/_demo/stream`, {
          method: 'POST', headers: demoHeaders(), credentials: 'same-origin', body: JSON.stringify({ slug: this._slug, sid: this._sid }),
        });
        data = await res.json().catch(() => ({}));
      } catch {
        res = null;
      } finally {
        this._busy = false;
      }
      if (this._closed) { closeBeacon(this._sid); return; }
      if (!res) { // worker unreachable: behave like a dropped connection and retry
        if (!dropped) { this.readyState = 0; this._fire(new Event('error')); }
        clearTimeout(this._retry);
        this._retry = setTimeout(() => this._register(false, true), 3000);
        return;
      }
      if (!res.ok) { // not viewable (404) etc.: refused outright, no retry — the controller decides what happens next
        this._timers(false);
        this._closed = true;
        this.readyState = 2;
        active.delete(this._sid);
        this._fire(new Event('error'));
        return;
      }
      if (announceDrop && !dropped) { this.readyState = 0; this._fire(new Event('error')); } // emulate a reconnect: the controller resyncs
      this.readyState = 1;
      this._fire(new Event('open'));
      this._event('hello', data.hello || { presence: [], more: 0 });
      this._timers(true);
    }

    async _ping() {
      if (this._closed || this._busy) return;
      try {
        const r = await fetch(`${BASE}/api/_demo/stream/ping`, {
          method: 'POST', headers: demoHeaders(), credentials: 'same-origin', body: JSON.stringify({ sid: this._sid, slug: this._slug }),
        });
        const d = await r.json().catch(() => ({}));
        if (d && d.known === false && !this._closed) this._register(true); // the worker restarted and forgot this stream
      } catch { /* worker busy/unreachable: the next ping retries */ }
    }

    /** Messages from the worker (BroadcastChannel). */
    _deliver(type, data) {
      if (this._closed || this.readyState !== 1 || !type) return;
      this._event(type, data);
    }
    /** The worker closed the stream (access lost, board deleted, session ended): like a dropped connection, then a reconnect attempt. */
    _serverClosed() {
      if (this._closed) return;
      this._timers(false);
      this.readyState = 0;
      this._fire(new Event('error'));
      clearTimeout(this._retry);
      this._retry = setTimeout(() => this._register(false, true), 1500);
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      this.readyState = 2;
      this._timers(false);
      clearTimeout(this._retry);
      active.delete(this._sid);
      closeBeacon(this._sid);
    }
  }
  for (const target of [DemoEventSource, DemoEventSource.prototype]) {
    Object.defineProperties(target, { CONNECTING: { value: 0 }, OPEN: { value: 1 }, CLOSED: { value: 2 } });
  }

  function EventSourceShim(url, init) {
    let abs;
    try { abs = new URL(String(url), doc.baseURI); } catch { abs = null; }
    const m = abs && abs.origin === location.origin ? esRe.exec(abs.pathname) : null;
    if (m) return new DemoEventSource(abs.href, decodeURIComponent(m[1]));
    return new NativeEventSource(url, init);
  }
  if (NativeEventSource) {
    EventSourceShim.prototype = NativeEventSource.prototype;
    Object.assign(EventSourceShim, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    window.EventSource = EventSourceShim;
  }

  if (channel) {
    channel.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.reset) { lsDel(SID_KEY); location.reload(); return; } // demo data was reset in some tab
      const es = active.get(m.sid);
      if (!es) return;
      if (m.close) es._serverClosed();
      else es._deliver(m.type, m.data);
    };
  }
  window.addEventListener('pagehide', () => { for (const es of [...active.values()]) es.close(); });
  // diagnostics for tests / the console: what the shim currently holds
  window.__edulet_demo = { streams: () => [...active.values()].map((s) => ({ sid: s._sid, slug: s._slug, readyState: s.readyState, closed: s._closed })) };

  /* ───────── the "데모 모드" badge + explanation dialog ───────── */
  async function resetDemoData() {
    const r = await fetch(`${BASE}/api/_demo/reset`, { method: 'POST', headers: demoHeaders(), credentials: 'same-origin', body: '{}' });
    if (!r.ok) throw new Error('reset failed: ' + r.status);
    lsDel(SID_KEY);
    location.reload();
  }

  function openDialog() {
    const status = el('p', { class: 'edd-ask', role: 'status', 'aria-live': 'polite', hidden: true });
    const row = el('div', { class: 'edd-row' });
    const dlg = el('dialog', { class: 'edulet-demo-dialog', 'aria-labelledby': 'edd-title' },
      el('h2', { id: 'edd-title' }, '데모 모드로 실행 중이에요'),
      el('ul', null,
        el('li', null, '서버 없이, 이 브라우저 안에서만 돌아가는 체험판이에요.'),
        el('li', null, '만든 보드·글·계정은 이 브라우저(IndexedDB)에만 저장돼요. 다른 기기나 다른 사람에게는 보이지 않아요.'),
        el('li', null, '같은 브라우저에서 탭을 여러 개 열면 실시간으로 함께 바뀌어요. 두 사람이 쓰는 모습은 탭 두 개로 체험해 보세요.'),
        el('li', null, '브라우저의 사이트 데이터를 지우면 데모 데이터도 사라져요.'),
        el('li', null, '여러 사람이 함께 쓰려면 직접 서버를 실행하세요: ',
          el('a', { href: README_URL, target: '_blank', rel: 'noopener noreferrer' }, 'README의 서버 실행 방법'), '.')),
      status, row);

    const close = () => { dlg.close ? dlg.close() : dlg.removeAttribute('open'); };
    const closeBtn = el('button', { type: 'button', class: 'edd-primary', onclick: close }, '닫기');
    const showRow = (...btns) => row.replaceChildren(...btns);
    const askReset = () => {
      status.hidden = false;
      status.textContent = '이 브라우저의 데모 데이터(만든 보드·글·계정)를 모두 지우고 처음 상태로 되돌릴까요?';
      const yes = el('button', {
        type: 'button', class: 'edd-danger-go', onclick: async () => {
          yes.disabled = true;
          status.textContent = '초기화하는 중…';
          try { await resetDemoData(); } catch { status.textContent = '초기화하지 못했어요. 잠시 뒤에 다시 해 주세요.'; yes.disabled = false; }
        },
      }, '네, 초기화');
      showRow(el('button', { type: 'button', onclick: () => { status.hidden = true; showRow(resetBtn, closeBtn); resetBtn.focus(); } }, '취소'), yes);
      yes.focus();
    };
    const resetBtn = el('button', { type: 'button', class: 'edd-danger', 'data-demo-reset': '', onclick: askReset }, '데모 데이터 초기화');
    showRow(resetBtn, closeBtn);

    dlg.addEventListener('close', () => dlg.remove());
    doc.body.append(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    closeBtn.focus();
    return dlg;
  }

  function installPill() {
    injectStyles();
    const label = el('span', { class: 'edp-label' }, '데모 모드');
    const main = el('button', { type: 'button', class: 'edp-main', 'data-demo-pill-main': '' }, el('span', { class: 'edp-dot' }), label, el('span', { class: 'edp-i', 'aria-hidden': 'true' }, 'i'));
    const x = el('button', { type: 'button', class: 'edp-x', 'aria-label': '데모 모드 표시 줄이기', title: '줄이기' }, '×');
    const pill = el('div', { class: 'edulet-demo-pill', 'data-demo-pill': '' }, main, x);
    const paint = () => {
      const collapsed = lsGet(PILL_KEY) === 'collapsed';
      pill.classList.toggle('is-collapsed', collapsed);
      main.setAttribute('aria-label', collapsed ? '데모 모드 안내 표시 펼치기' : '데모 모드 안내 열기');
      main.setAttribute('aria-haspopup', collapsed ? 'false' : 'dialog');
    };
    main.addEventListener('click', () => {
      if (pill.classList.contains('is-collapsed')) { lsDel(PILL_KEY); paint(); } else openDialog();
    });
    x.addEventListener('click', () => { lsSet(PILL_KEY, 'collapsed'); paint(); main.focus(); });
    paint();
    doc.body.append(pill);
  }
  onDom(installPill);
})();
