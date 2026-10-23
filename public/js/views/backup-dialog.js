// 저장하기 / 불러오기 dialogs. The server side is CONTRACT §5 "저장하기·불러오기" (server/backups.js); this file is only the screens.
//
//   openSaveDialog()     "지금 저장" -> the result (what was saved, warnings) -> shortcut to the restore dialog
//   openRestoreDialog()  list of saved copies (newest first) -> preview + comparison with now -> confirmation -> result -> full page reload
//
// Rules this file keeps (the reasons are in CLAUDE.md "저장하기·불러오기"):
//  - Everything goes through api.js, but no error here is ever a 401: the server answers 403 (`member_required`, `backup_local_only`), because
//    api.js treats a 401 as "your session ended" and signs the user out.
//  - A restore changes all the data at once, so the page's own state is stale afterwards: the dialog ends with a HARD navigation
//    (location.assign), never a router.go().
//  - While a request that changes the server runs, the dialog cannot be closed (Esc, backdrop, X are off) and no button can be pressed twice.
//  - Only server-made names are shown (the copy's folder id); absolute paths never reach the page.
import { h } from '../lib/h.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { withBase } from '../lib/base.js';
import { backupState } from '../lib/backup-state.js';
import { modal, icon, toast, timeAgo, formatBytes } from '../lib/ui.js';
import { errorMessage } from '../board/util.js';
import { openAuthModal } from './auth.js';

const enc = encodeURIComponent;
const LONG = { timeout: 10 * 60 * 1000 }; // a big database is copied twice (the safety copy + the replacement): more than api.js's 20 s default
const AUTO_MOVE_MS = 4500; // how long the "불러왔어요" screen waits before it reloads by itself (only when there is nothing to read)
const moveMs = () => (typeof window !== 'undefined' && window.__EDULET_BACKUP_MOVE_MS) || AUTO_MOVE_MS; // the page can override it (e2e looks at the result first)

/** The server says (GET /config) that this browser is the server PC's operator. Anything else hides the menus. */
export const backupAvailable = () => !!(store.config && store.config.backup && store.config.backup.available === true);

/* ───────── wording helpers ───────── */
const num = (n) => Number(n || 0).toLocaleString('ko-KR');

/** "10월 23일 (금) 오전 12:38" — with the year when it is not this year. */
export function whenText(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '시각을 알 수 없어요';
  const o = { month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  try {
    return d.toLocaleString('ko-KR', o);
  } catch {
    return d.toISOString();
  }
}

/** "보드 3개 · 글 11개 · 사용자 2명 · 사진·파일 4개" (summary can be null: the copy could not be read). */
export function countsText(summary, uploadFiles) {
  if (!summary) return '내용은 미리보기에서 확인해요'; // an old copy (no backup.json) that could not be counted: the preview says what is wrong, if anything
  const parts = [`보드 ${num(summary.boards)}개`, `글 ${num(summary.posts)}개`, `사용자 ${num(summary.users)}명`];
  if (uploadFiles != null) parts.push(`사진\u2060·\u2060파일 ${num(uploadFiles)}개`); // (word joiners: do not break the line at the ·)
  return parts.join(' · ');
}

/** What the user should be told about a failed request, and what the dialog can offer next. kind: login | local | gone | lost | busy | plain */
export function explain(e) {
  const code = e && e.code;
  if (code === 'member_required') return { kind: 'login', text: '계정으로 로그인한 뒤에 쓸 수 있어요.' };
  if (code === 'backup_local_only') return { kind: 'local', text: '저장하기·불러오기는 서버를 켠 PC 에서 localhost 주소로 열었을 때만 쓸 수 있어요.' };
  if (code === 'busy') return { kind: 'busy', text: '다른 저장·불러오기가 진행 중이에요. 잠시 뒤에 다시 해 주세요.' };
  if (code === 'data_changed') return { kind: 'plain', text: '그동안 다른 변경이 있어 중단했어요. 지금 데이터는 그대로예요. 한 번 더 해 주세요.' };
  if (code === 'backup_not_found') return { kind: 'gone', text: '그 저장본을 찾을 수 없어요. 목록을 새로 고쳐 다시 골라 주세요.' };
  if (code === 'backup_invalid') return { kind: 'plain', text: `이 저장본은 불러올 수 없어요. ${(e && e.message) || ''}`.trim() };
  if (code === 'confirm_required') return { kind: 'plain', text: '확인 단계가 빠졌어요(화면 오류). 페이지를 새로 고친 뒤 다시 해 주세요.' };
  if (code === 'network' || code === 'timeout') return { kind: 'lost', text: '서버와 연결이 끊겼어요. 서버가 켜져 있는지 확인해 주세요.' };
  return { kind: 'plain', text: errorMessage(e, '처리하지 못했어요. 다시 시도해 주세요.') }; // 429 gets its wait; 500s carry a Korean reason
}

const ERROR_TITLE = {
  login: '로그인이 필요해요', local: '이 주소에서는 쓸 수 없어요', busy: '잠시 뒤에 다시 해 주세요', lost: '서버와 연결이 끊겼어요', gone: '저장본이 없어졌어요', plain: '처리하지 못했어요',
};

/* ───────── small pieces ───────── */
const spinnerLine = (text) => h('p', { class: 'bk-working', dataset: { role: 'backup-working' } }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, text));
const factList = (rows) => h('dl', { class: 'bk-facts' }, rows.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
const note = (tone, ...kids) => h('div', { class: ['bk-box', tone && 'is-' + tone], role: tone === 'error' ? 'alert' : null }, kids);
const heading = (text) => h('h3', { class: 'bk-h', tabindex: '-1' }, text);
const warnList = (lines, lead) => note('warn', h('strong', null, lead), h('ul', { class: 'bk-warn-list' }, lines.map((w) => h('li', null, String(w)))));
const kindChip = (item) => item.kind === 'before-restore'
  ? h('span', { class: 'chip bk-chip-auto', title: '불러오기 직전에 지금 데이터를 자동으로 저장해 둔 것이에요' }, '자동 저장')
  : h('span', { class: 'chip', title: '저장하기로 만든 저장본이에요' }, '직접 저장');

/* ───────── the dialog frame ───────── */
/**
 * One modal whose body is swapped view by view. `persistent` is on (so Esc/backdrop do nothing by themselves) and the frame closes them
 * itself — except while `lock(true)` is on (a request that changes the server is running).
 * view(name, nodes, { actions, focus }) -> { [role]: button }
 */
function createPanel({ title, mode, returnFocus }) {
  let locked = false;
  let closed = false;
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const content = h('div', { class: 'bk-content' });
  const bar = h('div', { class: 'modal-actions bk-actions' });
  const panel = { onClosed: null, get closed() { return closed; } };

  function onKey(e) {
    if (e.key !== 'Escape' || locked) return;
    const all = document.querySelectorAll('.modal-backdrop');
    if (all[all.length - 1] !== backdrop) return; // a dialog opened on top of this one (sign-in) takes the key
    e.stopPropagation();
    m.close();
  }
  const m = modal({
    title, size: 'md', body: content, persistent: true,
    onClose: () => {
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
      if (panel.onClosed) panel.onClosed();
    },
  });
  const backdrop = m.el.parentElement;
  m.el.classList.add('bk');
  m.el.dataset.role = 'backup-dialog';
  m.el.dataset.mode = mode;
  m.el.append(bar, live);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && !locked) m.close(); });
  document.addEventListener('keydown', onKey, true);

  panel.say = (text) => { live.textContent = text; };
  panel.lock = (on) => {
    locked = !!on;
    m.el.classList.toggle('bk-locked', locked);
    m.el.setAttribute('aria-busy', String(locked));
  };
  panel.close = () => { if (!locked) m.close(); };
  panel.view = (name, nodes, { actions = [], focus } = {}) => {
    m.el.dataset.view = name;
    content.replaceChildren(...[].concat(nodes).filter(Boolean));
    bar.replaceChildren();
    const buttons = {};
    for (const a of actions) {
      const b = h('button', { type: 'button', class: ['btn', 'btn-' + (a.kind || 'secondary')], disabled: !!a.disabled, dataset: { role: a.role }, onClick: a.onClick },
        a.busy ? h('span', { class: 'spinner sm', 'aria-hidden': 'true' }) : null, a.label);
      bar.appendChild(b);
      buttons[a.role] = b;
    }
    bar.hidden = actions.length === 0;
    const scroller = m.el.querySelector('.modal-body');
    if (scroller) scroller.scrollTop = 0;
    requestAnimationFrame(() => {
      if (closed) return;
      const target = (typeof focus === 'function' ? focus() : focus) || content.querySelector('.bk-h') || m.el;
      target.focus();
    });
    return buttons;
  };
  return panel;
}

/** Sign in (a real account exists on this server, so it wants one), then run `again`. Resolves whether the user signed in. */
async function askLogin(again) {
  const user = await openAuthModal({ tab: 'login', message: '저장하기·불러오기는 계정으로 로그인해야 쓸 수 있어요.' });
  if (user && again) again();
  return !!user;
}

const guardAvailable = () => {
  if (backupAvailable()) return true;
  toast('저장하기·불러오기는 서버를 켠 PC 에서 localhost 주소로 열었을 때만 쓸 수 있어요.', 'error', 5000);
  return false;
};

/* ═════════════════════════ 저장하기 ═════════════════════════ */
export function openSaveDialog({ returnFocus } = {}) {
  if (!guardAvailable()) return null;
  const p = createPanel({ title: '저장하기', mode: 'save', returnFocus });
  let dirName = 'backups';
  let last; // undefined: still asking · null: nothing saved yet / unknown · item
  let lastUnknown = false;
  let busy = false;
  let problem = null; // { kind, text } of the last failed attempt

  const lastText = () => {
    if (last === undefined) return '마지막으로 저장한 때를 확인하는 중…';
    if (last) return `${whenText(last.createdAt)} (${timeAgo(last.createdAt)}) · ${countsText(last.summary)}`;
    return lastUnknown ? '마지막으로 저장한 때는 알 수 없어요.' : '아직 직접 저장한 적이 없어요.';
  };

  function idle() {
    const err = h('div', { class: 'bk-problem', dataset: { role: 'backup-problem' } });
    if (problem) {
      err.append(note('error', h('span', null, problem.text)));
      if (problem.kind === 'login') err.append(h('button', { type: 'button', class: 'btn btn-primary btn-sm bk-inline-btn', dataset: { role: 'login' }, onClick: () => askLogin(() => { problem = null; load(); save(); }) }, '로그인'));
    }
    const nodes = [
      heading('지금 상태를 저장해 둘까요?'),
      h('p', { class: 'bk-lead' }, '지금 서버에 있는 모든 보드·글·그림을 백업 폴더에 안전하게 저장해요. 수업 중에도 괜찮아요.'),
      h('p', { class: 'hint' }, '글과 사진이 아주 많으면 몇 초 걸릴 수 있어요. 그동안 서버가 잠깐 느려질 수 있어요.'),
      problem && (problem.kind === 'login' || problem.kind === 'local') ? null
        : h('p', { class: 'bk-last', dataset: { role: 'last-saved' } }, h('span', { class: 'bk-last-k' }, '마지막 저장'), h('span', null, lastText())),
      busy ? spinnerLine('저장하는 중이에요. 잠시만 기다려 주세요…') : null,
      err,
    ];
    let btns = null;
    btns = p.view('idle', nodes, {
      actions: [
        { label: '닫기', role: 'close', disabled: busy, onClick: () => p.close() },
        { label: busy ? '저장하는 중…' : '지금 저장', kind: 'primary', role: 'save-now', busy, disabled: busy || (problem && problem.kind === 'login'), onClick: save },
      ],
      focus: () => (busy ? null : btns && btns['save-now']),
    });
  }

  async function load() {
    try {
      const r = await api.get('/backups');
      if (p.closed) return;
      dirName = r.backupDirName || dirName;
      last = (r.items || []).find((i) => i.kind === 'manual') || null;
      lastUnknown = false;
    } catch (e) {
      if (p.closed) return;
      last = null;
      lastUnknown = true;
      const x = explain(e);
      if (x.kind === 'login' || x.kind === 'local') problem = x;
      if (x.kind === 'local') store.refreshConfig();
    }
    if (!busy) idle();
  }

  async function save() {
    if (busy) return;
    busy = true;
    problem = null;
    p.lock(true);
    p.say('저장하는 중이에요. 잠시만 기다려 주세요.');
    idle();
    try {
      const r = await api.post('/backups', {}, LONG);
      busy = false;
      p.lock(false);
      if (p.closed) return;
      saved(r);
    } catch (e) {
      busy = false;
      p.lock(false);
      if (p.closed) return;
      problem = explain(e);
      if (problem.kind === 'local') store.refreshConfig();
      idle();
    }
  }

  function saved(r) {
    const it = r.item || {};
    const warnings = Array.isArray(r.warnings) ? r.warnings : [];
    p.say('저장했어요.');
    p.view('result', [
      h('div', { class: 'bk-done', dataset: { role: 'save-result' } }, icon('check_circle', { size: 30 }), heading('저장했어요')),
      factList([
        ['저장한 때', whenText(it.createdAt)],
        ['들어 있는 것', countsText(it.summary, it.uploadFiles)],
        ['저장 위치', `서버 PC 의 ‘${dirName}’ 폴더 안 ${it.id}`],
      ]),
      warnings.length ? warnList(warnings, `알려 드릴 점이 ${warnings.length}개 있어요. 저장은 끝났지만 아래 내용을 확인해 주세요.`) : null,
      h('p', { class: 'bk-lead' }, '‘불러오기’에서 이 저장본을 골라 언제든 지금처럼 되돌릴 수 있어요.'),
    ], {
      actions: [
        { label: '닫기', role: 'close', onClick: () => p.close() },
        { label: '불러오기 열기', kind: 'primary', role: 'open-restore', onClick: () => { p.close(); openRestoreDialog({ returnFocus }); } },
      ],
    });
  }

  idle();
  load();
  return p;
}

/* ═════════════════════════ 불러오기 ═════════════════════════ */
function compareTable(saved, now) {
  const rows = [['보드', 'boards', '개'], ['글', 'posts', '개'], ['사용자', 'users', '명']];
  const delta = (a, b, unit) => {
    const d = a - b;
    if (d === 0) return h('span', { class: 'bk-delta' }, '그대로');
    return h('span', { class: ['bk-delta', d < 0 ? 'is-less' : 'is-more'] }, d < 0 ? `${num(-d)}${unit} 줄어요` : `${num(d)}${unit} 늘어요`);
  };
  return h('table', { class: 'bk-cmp', dataset: { role: 'compare' } },
    h('caption', { class: 'sr-only' }, '저장본과 지금 서버의 비교'),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, '항목')), h('th', { scope: 'col' }, '저장본'), h('th', { scope: 'col' }, '지금'), h('th', { scope: 'col' }, '불러오면'))),
    h('tbody', null, rows.map(([label, key, unit]) => h('tr', { dataset: { key } },
      h('th', { scope: 'row' }, label), h('td', null, `${num(saved[key])}${unit}`), h('td', null, `${num(now[key])}${unit}`), h('td', null, delta(saved[key], now[key], unit))))));
}

/** One sentence that says what a restore would do to the counts (the example in the brief: 글 11개 ↔ 글 14개 — 3개 적어져요). */
function headline(saved, now) {
  const parts = [];
  for (const [label, subject, key, unit] of [['글', '글이', 'posts', '개'], ['보드', '보드가', 'boards', '개']]) {
    const d = saved[key] - now[key];
    if (d === 0) continue;
    parts.push(`저장본 ${label} ${num(saved[key])}${unit} ↔ 지금 ${label} ${num(now[key])}${unit} — 불러오면 지금보다 ${subject} ${num(Math.abs(d))}${unit} ${d < 0 ? '적어져요' : '많아져요'}.`);
  }
  return parts.length ? parts.join(' ') : '보드·글 개수는 지금과 같아요. 그래도 내용은 다를 수 있어요.';
}

export function openRestoreDialog({ returnFocus } = {}) {
  if (!guardAvailable()) return null;
  const p = createPanel({ title: '불러오기', mode: 'restore', returnFocus });
  const st = { items: [], current: null, dirName: 'backups', loadedAt: 0 };
  const previews = new Map(); // copy id -> answer of GET /backups/:id. A saved copy never changes, and every preview keeps the server busy for a moment: ask once
  let seq = 0; // a late answer of an older request must not repaint a newer screen
  let previewing = false; // one preview request at a time (a double click / key repeat must not queue several)
  let busy = false;

  const closeAction = { label: '닫기', role: 'close', onClick: () => p.close() };

  /* ── generic error screen ── */
  function failed(e, { retry, back } = {}) {
    const x = explain(e);
    if (x.kind === 'local') store.refreshConfig();
    const actions = [];
    if (back) actions.push({ label: '← 뒤로', role: 'back', onClick: back });
    else actions.push(closeAction);
    if (x.kind === 'login') actions.push({ label: '로그인', kind: 'primary', role: 'login', onClick: () => askLogin(retry) });
    else if (x.kind === 'gone') actions.push({ label: '목록 새로 고침', kind: 'primary', role: 'reload-list', onClick: () => loadList() });
    else if (x.kind === 'lost') actions.push({ label: '화면 새로 고치기', kind: 'primary', role: 'reload', onClick: () => location.reload() });
    else if (x.kind !== 'local' && retry) actions.push({ label: '다시 시도', kind: 'primary', role: 'retry', onClick: retry });
    p.view('error', [heading(ERROR_TITLE[x.kind] || ERROR_TITLE.plain), note('error', x.text),
      x.kind === 'lost' ? h('p', { class: 'bk-lead' }, '불러오기를 하던 중이었다면 끝났는지 확실하지 않아요. 화면을 새로 고쳐 저장본이 적용됐는지 확인해 주세요.') : null], { actions });
  }

  /* ── 1. the list ── */
  async function loadList() {
    const my = ++seq;
    p.view('loading', [heading('저장본을 찾는 중이에요'), spinnerLine('목록을 불러오는 중…')], { actions: [closeAction] });
    p.say('저장본 목록을 불러오는 중이에요.');
    try {
      const r = await api.get('/backups');
      if (p.closed || my !== seq) return;
      st.items = r.items || [];
      st.current = r.current || null;
      st.dirName = r.backupDirName || 'backups';
      st.loadedAt = Date.now();
      showList();
    } catch (e) {
      if (p.closed || my !== seq) return;
      failed(e, { retry: loadList });
    }
  }

  function optionRow(item) {
    return h('div', {
      class: ['bk-opt', item.kind === 'before-restore' && 'is-auto'], role: 'option', tabindex: '-1', 'aria-selected': 'false',
      dataset: { role: 'backup-option', id: item.id, kind: item.kind },
    },
    h('div', { class: 'bk-opt-main' },
      h('div', { class: 'bk-opt-top' },
        h('strong', { class: 'bk-opt-when' }, whenText(item.createdAt)),
        h('span', { class: 'muted bk-opt-ago' }, timeAgo(item.createdAt)),
        kindChip(item),
        item.warnings > 0 ? h('span', { class: 'chip warn', title: '저장할 때 알려 드릴 점이 있었어요. 눌러서 확인하세요' }, `알림 ${num(item.warnings)}`) : null),
      h('div', { class: 'bk-opt-sub' },
        item.summary ? countsText(item.summary, item.uploadFiles) : '내용은 미리보기에서 확인해요',
        h('span', { class: 'muted' }, ` · ${formatBytes(item.dbBytes)}`))),
    icon('chevron-right', { size: 18, class: 'bk-opt-go' }));
  }

  function listbox() {
    const el = h('div', { class: 'bk-list', role: 'listbox', 'aria-label': '저장본 목록, 최신 순', dataset: { role: 'backup-list' } });
    const rows = st.items.map(optionRow);
    rows.forEach((r) => el.appendChild(r));
    let cur = 0;
    const mark = (i, focus) => {
      cur = Math.max(0, Math.min(rows.length - 1, i));
      rows.forEach((r, k) => { r.tabIndex = k === cur ? 0 : -1; r.setAttribute('aria-selected', String(k === cur)); });
      if (focus) rows[cur].focus();
    };
    rows.forEach((r, i) => r.addEventListener('click', () => { mark(i, false); openPreview(st.items[i]); }));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') mark(cur + 1, true);
      else if (e.key === 'ArrowUp') mark(cur - 1, true);
      else if (e.key === 'Home') mark(0, true);
      else if (e.key === 'End') mark(rows.length - 1, true);
      else if (e.key === 'Enter' || e.key === ' ') openPreview(st.items[cur]);
      else return;
      e.preventDefault();
    });
    if (rows.length) rows[0].tabIndex = 0;
    return { el, first: () => rows[0] || null };
  }

  function showList() {
    seq++; // an answer still on its way (a preview) must not paint over the list
    p.say(st.items.length ? `저장본 ${st.items.length}개를 찾았어요.` : '저장본이 아직 없어요.');
    const now = st.current;
    const nowLine = now
      ? h('p', { class: 'bk-now', dataset: { role: 'current-state' } }, h('span', { class: 'bk-last-k' }, '지금 서버'),
        h('span', null, `보드 ${num(now.boards)}개 · 글 ${num(now.posts)}개 · 사용자 ${num(now.users)}명${now.latestPostAt ? ` · 가장 최근 글 ${whenText(now.latestPostAt)}` : ''}`))
      : null;
    if (!st.items.length) {
      p.view('empty', [
        heading('아직 저장본이 없어요'),
        nowLine,
        h('p', { class: 'bk-lead' }, '먼저 ‘저장하기’로 지금 상태를 저장해 두면 여기에 나타나요.'),
        h('p', { class: 'hint' }, `저장본은 서버 PC 의 ‘${st.dirName}’ 폴더에 들어 있어요. 다른 PC 에서 복사해 온 저장본 폴더도 그 안에 넣으면 이 목록에 나타나요.`),
      ], {
        actions: [closeAction, { label: '지금 저장하기', kind: 'primary', role: 'open-save', onClick: () => { p.close(); openSaveDialog({ returnFocus }); } }],
      });
      return;
    }
    const lb = listbox();
    const refresh = h('button', { type: 'button', class: 'btn-icon sm', 'aria-label': '목록 새로 고침', title: '목록 새로 고침', dataset: { role: 'refresh-list' }, onClick: () => loadList() }, icon('refresh', { size: 18 }));
    p.view('list', [
      h('div', { class: 'bk-head-row' }, heading('어느 저장본으로 불러올까요?'), refresh),
      nowLine,
      h('p', { class: 'bk-lead' }, '저장본을 누르면 내용을 먼저 보여 줘요. 누른다고 바로 바뀌지는 않아요.'),
      lb.el,
      h('p', { class: 'hint bk-foot' }, `저장본 ${num(st.items.length)}개 · 서버 PC 의 ‘${st.dirName}’ 폴더`),
    ], { actions: [closeAction], focus: lb.first });
  }

  /* ── 2. preview ── */
  async function openPreview(item) {
    if (previewing) return;
    const my = ++seq;
    const stale = Date.now() - st.loadedAt > 60000; // "지금" numbers: re-read them only when the list is old
    const cached = previews.get(item.id);
    p.view('loading', [heading('저장본 내용을 확인하는 중이에요'), spinnerLine('저장본이 온전한지 살펴보고 있어요…')], { actions: [{ label: '← 목록', role: 'back', onClick: showList }] });
    p.say('저장본 내용을 확인하는 중이에요.');
    previewing = true;
    try {
      const [pv, ls] = await Promise.all([cached || api.get(`/backups/${enc(item.id)}`), stale ? api.get('/backups').catch(() => null) : null]);
      if (p.closed || my !== seq) return;
      if (!cached) previews.set(item.id, pv);
      if (ls) { st.items = ls.items || st.items; st.current = ls.current || st.current; st.loadedAt = Date.now(); }
      showPreview(pv.item || item, pv);
    } catch (e) {
      if (p.closed || my !== seq) return;
      previews.delete(item.id);
      if (e && e.code === 'backup_invalid') showPreview(item, null, explain(e).text);
      else if (e && e.code === 'backup_not_found') failed(e);
      else failed(e, { retry: () => openPreview(item), back: showList }); // 429 (a preview can be rate limited too) says how long to wait
    } finally {
      previewing = false;
    }
  }

  function showPreview(item, pv, invalidText) {
    const saved = item.summary;
    const now = st.current;
    const boards = (pv && pv.boards) || [];
    const warnings = (pv && pv.warnings) || [];
    const nodes = [
      h('div', { class: 'bk-head-row' }, heading(whenText(item.createdAt)), kindChip(item)),
      h('p', { class: 'muted bk-sub' }, `${timeAgo(item.createdAt)} 상태 · ${countsText(item.summary, item.uploadFiles)}`),
    ];
    if (invalidText) {
      nodes.push(note('error', h('strong', null, '이 저장본은 불러올 수 없어요.'), h('span', null, ' ' + invalidText.replace(/^이 저장본은 불러올 수 없어요\.\s*/, ''))));
    } else if (saved && now) {
      nodes.push(
        h('p', { class: 'bk-headline', dataset: { role: 'compare-headline' } }, headline(saved, now)),
        compareTable(saved, now),
        h('p', { class: 'hint bk-after' }, '이 저장본을 만든 뒤에 새로 쓰거나 바꾼 내용은 불러오면 사라져요. 그래도 불러오기 직전의 지금 데이터는 자동으로 저장돼서 되돌릴 수 있어요.'),
        saved.latestPostAt || now.latestPostAt ? h('p', { class: 'hint' }, `가장 최근 글 — 저장본: ${saved.latestPostAt ? whenText(saved.latestPostAt) : '없음'} · 지금: ${now.latestPostAt ? whenText(now.latestPostAt) : '없음'}`) : null);
    }
    if (warnings.length) nodes.push(warnList(warnings, '불러오기 전에 알아 두세요'));
    if (!invalidText) {
      nodes.push(h('h4', { class: 'bk-h4' }, `이 저장본의 보드 ${boards.length ? boards.length + '개' : ''}`.trim()));
      nodes.push(boards.length
        ? h('ul', { class: 'bk-boards', dataset: { role: 'preview-boards' } }, boards.map((b) => h('li', null,
          h('span', { class: 'bk-board-t' }, b.title || '(제목 없음)'),
          h('span', { class: 'muted' }, ` · 글 ${num(b.posts)}개${b.updatedAt ? ` · ${timeAgo(b.updatedAt)} 수정` : ''}`))))
        : h('p', { class: 'muted' }, '보드가 하나도 없는 저장본이에요. 불러오면 지금 있는 보드가 모두 사라져요.'));
      if (saved && saved.boards > boards.length && boards.length) nodes.push(h('p', { class: 'hint' }, `…외 ${num(saved.boards - boards.length)}개`));
    }
    p.say(invalidText ? '이 저장본은 불러올 수 없어요.' : '저장본을 확인했어요.');
    p.view('preview', nodes, {
      actions: [
        { label: '← 목록', role: 'back', onClick: showList },
        { label: '이 저장본으로 불러오기…', kind: 'primary', role: 'go-confirm', disabled: !!invalidText, onClick: () => showConfirm(item, pv) },
      ],
    });
  }

  /* ── 3. confirmation ── */
  function showConfirm(item, pv, extra) {
    p.say('불러오기 전에 한 번 더 확인해 주세요.');
    p.view('confirm', [
      heading('이 저장본으로 불러올까요?'),
      note('ok', h('strong', null, whenText(item.createdAt)), h('span', null, ` (${timeAgo(item.createdAt)})`), h('br'), h('span', null, countsText(item.summary, item.uploadFiles))),
      item.summary && st.current ? h('p', { class: 'bk-headline', dataset: { role: 'confirm-headline' } }, headline(item.summary, st.current)) : null,
      extra ? note(extra.tone, extra.text) : null,
      h('ul', { class: 'bk-points' }, [
        h('li', null, h('strong', null, '지금 데이터는 먼저 자동으로 저장돼요. '), '‘자동 저장’으로 목록에 남아서 언제든 다시 되돌릴 수 있어요.'),
        h('li', null, h('strong', null, '계정과 비밀번호도 저장 당시로 돌아가요. '), '그 뒤에 바꾼 비밀번호는 원래대로 돌아가고, 저장본에 있던 계정으로 다시 로그인해야 할 수 있어요.'),
        h('li', null, '지금 이 서버에 접속해 있는 다른 기기의 화면도 함께 새로고침돼요.'),
        h('li', null, '불러오는 동안(데이터가 많으면 몇 초)은 글쓰기·수정이 잠깐 멈추고, 서버가 잠시 느려질 수 있어요.'),
      ]),
    ], {
      actions: [
        { label: '← 뒤로', role: 'back', onClick: () => showPreview(item, pv) },
        { label: '이 저장본으로 불러오기', kind: 'primary', role: 'restore-go', onClick: () => doRestore(item, pv) },
      ],
    });
  }

  /* ── 4. working + result ── */
  async function doRestore(item, pv) {
    if (busy) return;
    busy = true;
    backupState.restoring = true; // this tab started it: its own board connection ignores the `reset` event the server sends
    p.lock(true);
    p.say('불러오는 중이에요. 이 창을 닫지 마세요.');
    p.view('working', [
      heading('불러오는 중이에요'),
      spinnerLine('지금 데이터를 자동 저장하고, 저장본으로 바꾸고 있어요…'),
      h('p', { class: 'hint' }, '이 창을 닫거나 서버를 끄지 마세요. 보통 몇 초면 끝나요.'),
    ], { actions: [{ label: '불러오는 중…', kind: 'primary', role: 'restore-go', busy: true, disabled: true }] });
    try {
      const r = await api.post(`/backups/${enc(item.id)}/restore`, { confirm: true }, LONG);
      busy = false;
      p.lock(false);
      restored(r, item);
    } catch (e) {
      busy = false;
      backupState.restoring = false;
      p.lock(false);
      if (p.closed) return;
      const x = explain(e);
      if (x.kind === 'lost') return failed(e);
      if (x.kind === 'gone') return failed(e);
      if (e && e.code === 'backup_invalid') return showPreview(item, null, x.text);
      if (x.kind === 'local') store.refreshConfig();
      const again = () => showConfirm(item, pv);
      const actions = [{ label: '← 뒤로', role: 'back', onClick: again }];
      if (x.kind === 'login') actions.push({ label: '로그인', kind: 'primary', role: 'login', onClick: () => askLogin(() => showConfirm(item, pv, { tone: 'ok', text: '로그인했어요. 아래 단추를 눌러 불러오기를 이어 가세요.' })) });
      else if (x.kind !== 'local') actions.push({ label: '다시 시도', kind: 'primary', role: 'retry', onClick: () => doRestore(item, pv) });
      p.view('error', [heading('불러오지 못했어요'), note('error', x.text), h('p', { class: 'bk-lead' }, '지금 데이터는 바뀌지 않았어요.')], { actions });
    }
  }

  function restored(r, item) {
    const was = r.restored || item;
    const safety = r.safety || null;
    const warnings = Array.isArray(r.warnings) ? r.warnings : [];
    const lostLogin = r.keptSession === false;
    const needsReading = warnings.length > 0 || lostLogin || (safety && safety.warnings > 0);
    let went = false;
    let timer = null;
    const go = () => {
      if (went) return;
      went = true;
      clearTimeout(timer);
      location.assign(withBase(lostLogin ? '/' : '/dashboard'));
    };
    p.onClosed = go; // the page behind this dialog is out of date now: closing it by any route means "reload"
    p.say(lostLogin ? '불러왔어요. 저장본의 계정으로 다시 로그인해 주세요.' : '불러왔어요.');
    p.view('result', [
      h('div', { class: 'bk-done', dataset: { role: 'restore-result' } }, icon('check_circle', { size: 30 }), heading('불러왔어요')),
      factList([
        ['불러온 저장본', `${whenText(was.createdAt)} (${timeAgo(was.createdAt)})`],
        ['지금 서버', countsText(was.summary, was.uploadFiles)],
      ]),
      safety ? note('ok', h('strong', null, '이전 데이터도 남겨 뒀어요. '), `불러오기 직전의 데이터를 ‘자동 저장’(${whenText(safety.createdAt)})으로 저장했어요. 불러오기 목록에서 언제든 다시 고를 수 있어요.`) : null,
      lostLogin ? note('warn', h('strong', null, '다시 로그인해 주세요. '), '저장본에 들어 있던 계정으로 로그인하면 돼요.') : null,
      safety && safety.warnings > 0 ? note('warn', `자동 저장에 알려 드릴 점이 ${num(safety.warnings)}개 있었어요. 자동 저장본은 목록에서 ‘알림’ 표시로 볼 수 있어요.`) : null,
      warnings.length ? warnList(warnings, '알려 드릴 점') : null,
      h('p', { class: 'bk-lead', dataset: { role: 'restore-next' } }, needsReading ? '내용을 확인했으면 아래 단추로 화면을 새로 고쳐 주세요.' : '곧 화면을 새로 고쳐요.'),
    ], { actions: [{ label: lostLogin ? '홈으로 가기' : '화면 새로 고치기', kind: 'primary', role: 'reload', onClick: go }] });
    if (!needsReading) timer = setTimeout(go, moveMs());
  }

  loadList();
  return p;
}
