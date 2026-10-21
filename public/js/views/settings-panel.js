// Board settings drawer (admin only). Every change saves at once through ctl.updateBoard.
import { h } from '../lib/h.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { icon, toast, formatBytes } from '../lib/ui.js';
import {
  FORMATS, FORMAT_LABELS, WALLPAPERS, WALLPAPER_LABELS, FONTS, FONT_LABELS, REACTIONS, REACTION_LABELS, LIMITS,
} from '../lib/constants.js';
import { FORMAT_ICON, pickGroup, deferred, reportError, wallpaperProps } from './common.js';
import { deleteBoardFlow } from './board-actions.js';

let current = null; // the open drawer, if any

function section(title, ...kids) {
  return h('section', { class: 'bp-set-sec' }, h('h3', { class: 'bp-set-h' }, title), ...kids);
}

/** A labelled on/off row. */
function switchRow(label, hint, name) {
  const input = h('input', { type: 'checkbox', role: 'switch', name });
  const el = h('label', { class: 'bp-set-row' },
    h('span', { class: 'bp-set-row-text' }, h('span', null, label), hint ? h('span', { class: 'hint' }, hint) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'track' })));
  return { el, input };
}

/* ───────── sections: each returns { el, sync(board), flush?() } ───────── */
function textSection({ ctl, save, setStatus }) {
  const title = h('input', { class: 'input', type: 'text', name: 'title', maxlength: LIMITS.boardTitle, 'aria-label': '보드 제목' });
  const desc = h('textarea', { class: 'input', name: 'description', rows: 3, maxlength: LIMITS.boardDescription, 'aria-label': '보드 설명', placeholder: '보드를 소개해 주세요 (선택)' });
  const saveTitle = deferred(() => {
    const v = title.value.trim();
    if (!v) return setStatus('warn', '제목을 입력해 주세요.');
    if (v !== ctl.state.board.title) save({ title: v });
    else setStatus('idle');
  });
  const saveDesc = deferred(() => {
    const v = desc.value.trim();
    if (v !== ctl.state.board.description) save({ description: v });
    else setStatus('idle');
  });
  title.addEventListener('input', () => { setStatus('saving'); saveTitle.call(); });
  desc.addEventListener('input', () => { setStatus('saving'); saveDesc.call(); });
  title.addEventListener('blur', () => saveTitle.flush());
  desc.addEventListener('blur', () => saveDesc.flush());
  return {
    el: section('제목과 설명', h('div', { class: 'field' }, title), h('div', { class: 'field' }, desc)),
    sync(b) {
      if (document.activeElement !== title && !saveTitle.pending) title.value = b.title;
      if (document.activeElement !== desc && !saveDesc.pending) desc.value = b.description || '';
    },
    flush() { saveTitle.flush(); saveDesc.flush(); },
  };
}

function formatSection({ save }) {
  const group = pickGroup({
    label: '보드 형식', dataKey: 'format', value: null, className: 'app-picker-2',
    options: FORMATS.map((f) => ({ value: f, label: FORMAT_LABELS[f].name, desc: FORMAT_LABELS[f].desc, icon: FORMAT_ICON[f] })),
    onPick: (f) => save({ format: f }),
  });
  return { el: section('형식', group.el, h('p', { class: 'hint' }, '형식을 바꿔도 글은 그대로 남아요.')), sync: (b) => group.set(b.format) };
}

function wallpaperSection({ ctl, save }) {
  const grid = h('div', { class: 'bp-swatches', role: 'group', 'aria-label': '배경 선택' });
  const btns = WALLPAPERS.map((id) => h('button', {
    type: 'button', class: ['bp-swatch', 'wp-' + id], 'aria-label': WALLPAPER_LABELS[id], title: WALLPAPER_LABELS[id], 'aria-pressed': 'false',
    dataset: { wallpaper: id }, onClick: () => pick(id),
  }, icon('check', { size: 18, class: 'bp-swatch-check' })));
  // Shows the currently applied uploaded image (selected state only — pick another swatch to leave it).
  const customBtn = h('span', {
    class: 'bp-swatch wp-custom is-current', role: 'img', 'aria-label': '지금 쓰는 배경 이미지', title: '지금 쓰는 배경 이미지', hidden: true,
    dataset: { wallpaper: 'custom' },
  }, icon('check', { size: 18, class: 'bp-swatch-check' }));
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'sr-only', 'aria-label': '배경 이미지 올리기' });
  const uploadLabel = h('span', { class: 'bp-swatch-upload-text' }, '직접 올리기');
  const uploadTile = h('label', { class: 'bp-swatch bp-swatch-upload' }, icon('image', { size: 20 }), uploadLabel, fileInput);

  function paint(wallpaper) {
    const wp = wallpaperProps(wallpaper);
    btns.forEach((b, i) => b.setAttribute('aria-pressed', String(WALLPAPERS[i] === wp.id)));
    customBtn.hidden = wp.id !== 'custom';
    customBtn.style.backgroundImage = wp.id === 'custom' ? wp.style.backgroundImage : '';
  }
  function pick(id) {
    paint(id);
    save({ wallpaper: id });
  }
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('이미지 파일만 배경으로 쓸 수 있어요.', 'error');
    const limit = ((store.config && store.config.maxUploadMb) || 20) * 1024 * 1024;
    if (file.size > limit) return toast(`파일이 너무 커요. ${formatBytes(limit)} 이하만 올릴 수 있어요.`, 'error');
    uploadTile.classList.add('busy');
    uploadLabel.textContent = '올리는 중…';
    try {
      const att = await ctl.upload(file, (p) => (uploadLabel.textContent = `올리는 중 ${Math.round(p * 100)}%`));
      if (att.kind !== 'image') throw Object.assign(new Error('이미지 파일만 배경으로 쓸 수 있어요.'), { code: 'bad_kind' });
      paint(att.url);
      await save({ wallpaper: att.url });
    } catch (e) {
      reportError(e, '이미지를 올리지 못했어요. 다시 시도해 주세요.');
      paint(ctl.state.board.wallpaper);
    } finally {
      uploadTile.classList.remove('busy');
      uploadLabel.textContent = '직접 올리기';
    }
  });
  grid.append(...btns, customBtn, uploadTile);
  return { el: section('배경', grid), sync: (b) => paint(b.wallpaper) };
}

function fontSection({ save }) {
  const group = pickGroup({
    label: '글꼴', dataKey: 'font', value: null, className: 'app-picker-2 app-picker-fonts',
    options: FONTS.map((f) => ({ value: f, label: FONT_LABELS[f], desc: '가나다 Abc 123', cls: 'font-' + f })),
    onPick: (f) => save({ font: f }),
  });
  return { el: section('글꼴', group.el), sync: (b) => group.set(b.font) };
}

function schemeSection({ save }) {
  const group = pickGroup({
    label: '카드 색 계열', dataKey: 'scheme', value: null, className: 'app-picker-2',
    options: [{ value: 'light', label: '밝은 카드', desc: '밝은 배경에 알맞아요' }, { value: 'dark', label: '어두운 카드', desc: '어두운 배경에 알맞아요' }],
    onPick: (v) => save({ colorScheme: v }),
  });
  return { el: section('카드 색 계열', group.el), sync: (b) => group.set(b.colorScheme) };
}

function behaviorSection({ save }) {
  const reactions = h('select', { class: 'select', name: 'reactions', 'aria-label': '반응 종류' }, REACTIONS.map((r) => h('option', { value: r }, REACTION_LABELS[r])));
  reactions.addEventListener('change', () => save({ settings: { reactions: reactions.value } }));
  const comments = switchRow('댓글 허용', '카드마다 댓글을 달 수 있어요', 'comments');
  const approval = switchRow('글 승인 필요', '관리자가 승인해야 다른 사람에게 보여요', 'approval');
  const showAuthor = switchRow('작성자 표시', '카드에 작성자 이름을 보여 줘요', 'showAuthor');
  comments.input.addEventListener('change', () => save({ settings: { comments: comments.input.checked ? 'on' : 'off' } }));
  approval.input.addEventListener('change', () => save({ settings: { approval: approval.input.checked } }));
  showAuthor.input.addEventListener('change', () => save({ settings: { showAuthor: showAuthor.input.checked } }));
  const position = pickGroup({
    label: '새 글 위치', dataKey: 'position', value: null, className: 'app-picker-2',
    options: [{ value: 'top', label: '맨 위', desc: '새 글이 앞쪽에' }, { value: 'bottom', label: '맨 아래', desc: '새 글이 뒤쪽에' }],
    onPick: (v) => save({ settings: { newPostPosition: v } }),
  });
  return {
    el: section('글과 반응',
      h('label', { class: 'field' }, h('span', { class: 'label' }, '반응'), reactions),
      comments.el, approval.el, showAuthor.el,
      h('div', { class: 'field bp-set-gap' }, h('span', { class: 'label' }, '새 글 위치'), position.el)),
    sync(b) {
      const s = b.settings || {};
      reactions.value = s.reactions || 'like';
      comments.input.checked = s.comments !== 'off';
      approval.input.checked = !!s.approval;
      showAuthor.input.checked = s.showAuthor !== false;
      position.set(s.newPostPosition || 'top');
    },
  };
}

function dangerSection(ctl, closeDrawer) {
  const btn = h('button', { type: 'button', class: 'btn btn-danger', onClick: async () => {
    try {
      if (await deleteBoardFlow(ctl.state.board)) {
        closeDrawer();
        router.go('/dashboard');
      }
    } catch (e) {
      reportError(e, '삭제하지 못했어요. 다시 시도해 주세요.');
    }
  } }, icon('trash', { size: 18 }), '이 보드 삭제');
  return { el: section('위험 구역', h('p', { class: 'hint' }, '보드와 안의 글·댓글·파일이 모두 사라져요. 소유자만 할 수 있어요.'), btn), sync() {} };
}

/* ───────── drawer ───────── */
export function toggleSettingsPanel(ctl) {
  if (current) {
    current.close();
    return null;
  }
  return openSettingsPanel(ctl);
}

/** Open the drawer (admin only). Returns { close } or null. */
export function openSettingsPanel(ctl) {
  if (!ctl.can('admin')) return null;
  if (current) return current;
  const prev = document.activeElement;

  /* save status + save wrapper */
  const status = h('span', { class: 'bp-set-status', role: 'status', 'aria-live': 'polite' });
  let statusTimer;
  let inflight = 0;
  function setStatus(kind, text) {
    clearTimeout(statusTimer);
    status.className = 'bp-set-status ' + kind;
    if (kind === 'saving') status.replaceChildren(h('span', { class: 'spinner sm' }), '저장 중…');
    else if (kind === 'saved') {
      status.replaceChildren(icon('check', { size: 14 }), '저장됨');
      statusTimer = setTimeout(() => setStatus('idle'), 2200);
    } else if (kind === 'idle') status.replaceChildren('바뀐 내용은 바로 저장돼요');
    else status.replaceChildren(text || '저장하지 못했어요');
  }
  async function save(patch) {
    inflight++;
    setStatus('saving');
    let ok = true;
    try {
      await ctl.updateBoard(patch);
    } catch (e) {
      ok = false;
      reportError(e, '저장하지 못했어요. 다시 시도해 주세요.');
    }
    inflight--;
    if (!ok) {
      syncAll();
      setStatus('error', '저장하지 못했어요');
    } else if (!inflight) setStatus('saved');
    return ok;
  }

  const cx = { ctl, save, setStatus };
  const parts = [textSection(cx), formatSection(cx), wallpaperSection(cx), fontSection(cx), schemeSection(cx), behaviorSection(cx)];
  if (ctl.can('owner')) parts.push(dangerSection(ctl, () => handle.close()));
  function syncAll() {
    const b = ctl.state.board;
    if (b) parts.forEach((p) => p.sync(b));
  }

  const closeBtn = h('button', { type: 'button', class: 'btn-icon', 'aria-label': '설정 닫기', onClick: () => handle.close() }, icon('x'));
  const panel = h('aside', { class: 'bp-drawer', role: 'dialog', 'aria-label': '보드 설정', tabindex: '-1', dataset: { role: 'settings' } },
    h('div', { class: 'bp-drawer-head' }, h('div', null, h('h2', { class: 'bp-drawer-title' }, '보드 설정'), status), closeBtn),
    h('div', { class: 'bp-drawer-body' }, parts.map((p) => p.el)));

  const unsub = ctl.subscribe((ev) => {
    if (ev.type === 'board' || ev.type === 'snapshot') {
      if (!ctl.can('admin')) return handle.close();
      syncAll();
    }
    // a post detail or the slideshow takes over the screen
    if (ev.type === 'ui' && (ctl.state.slideshow || ctl.state.openPostId != null)) handle.close();
  });
  function onKey(e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('.modal-backdrop') || document.querySelector('.popover')) return;
    handle.close();
  }
  let closed = false;
  const handle = {
    close() {
      if (closed) return;
      closed = true;
      parts.forEach((p) => p.flush && p.flush());
      clearTimeout(statusTimer);
      unsub();
      document.removeEventListener('keydown', onKey);
      panel.classList.add('out');
      setTimeout(() => panel.remove(), 140);
      if (current === handle) current = null;
      if (prev && prev.focus && document.contains(prev)) prev.focus();
    },
  };
  current = handle;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(panel);
  setStatus('idle');
  syncAll();
  panel.focus();
  return handle;
}
