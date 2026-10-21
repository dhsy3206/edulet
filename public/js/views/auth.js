// Auth UI: login/register modal, user menu control, profile modal.
import { h } from '../lib/h.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { modal, popover, avatar, icon, toast } from '../lib/ui.js';
import { LIMITS } from '../lib/constants.js';
import { isMember } from './common.js';

export const AVATAR_COLORS = [
  '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#0284c7',
  '#2563eb', '#4f46e5', '#9333ea', '#db2777', '#475569', '#78716c',
];
const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/;

/** Resolve with the signed-in user (or null if the dialog was dismissed). */
export function requireLogin({ message, tab = 'login' } = {}) {
  if (isMember(store.me)) return Promise.resolve(store.me);
  return openAuthModal({ message, tab });
}

/**
 * Login / register dialog. Resolves to the User on success, or null when closed.
 * opts: { tab: 'login'|'register', message }
 */
export function openAuthModal({ tab = 'login', message = '' } = {}) {
  return new Promise((resolve) => {
    const canRegister = !(store.config && store.config.allowRegister === false);
    let mode = canRegister && tab === 'register' ? 'register' : 'login';
    let settled = false;
    let busy = false;

    // `autofocus` is honoured by modal() once it is on screen (the tab switch below moves focus by hand).
    const displayName = h('input', { class: 'input', type: 'text', name: 'displayName', maxlength: LIMITS.displayName, autocomplete: 'nickname', placeholder: '예: 김하늘', autofocus: mode === 'register' });
    const username = h('input', { class: 'input', type: 'text', name: 'username', maxlength: 30, autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', placeholder: '영문 소문자·숫자', autofocus: mode === 'login' });
    const password = h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: '비밀번호' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const submitBtn = h('button', { class: 'btn btn-primary btn-lg app-auth-submit', type: 'submit', dataset: { role: 'auth-submit' } });

    const nameField = h('label', { class: 'field' }, h('span', { class: 'label' }, '이름'), displayName, h('span', { class: 'hint' }, '글과 댓글에 표시돼요.'));
    const userField = h('label', { class: 'field' }, h('span', { class: 'label' }, '아이디'), username,
      h('span', { class: 'hint', hidden: true }, '영문 소문자·숫자·. _ - 로 3~30자'));
    const passHint = h('span', { class: 'hint', hidden: true }, '8자 이상');
    const passField = h('label', { class: 'field' }, h('span', { class: 'label' }, '비밀번호'), password, passHint);
    const userHint = userField.querySelector('.hint');
    const switchBtn = h('button', { type: 'button', class: 'app-linkbtn', onClick: () => setMode(mode === 'login' ? 'register' : 'login') });
    const switchLine = h('p', { class: 'app-auth-switch' }, switchBtn);
    const tabBtns = {};
    const tabs = canRegister
      ? h('div', { class: 'app-tabs', role: 'tablist' }, ['login', 'register'].map((t) => (tabBtns[t] = h('button', {
          type: 'button', role: 'tab', class: 'app-tab', dataset: { tab: t }, onClick: () => setMode(t),
        }, t === 'login' ? '로그인' : '가입하기'))))
      : null;

    const form = h('form', { class: 'app-auth', novalidate: true, onSubmit: submit },
      tabs, message ? h('p', { class: 'modal-text' }, message) : null, nameField, userField, passField, err, submitBtn, canRegister ? switchLine : null);

    const m = modal({ title: '로그인', size: 'sm', body: form, onClose: () => { if (!settled) resolve(null); } });
    m.el.dataset.role = 'auth';
    const titleEl = m.el.querySelector('.modal-title');

    function paintSubmit() {
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? '처리 중…' : mode === 'register' ? '가입하고 시작하기' : '로그인';
    }
    function clearInvalid() {
      [displayName, username, password].forEach((i) => i.removeAttribute('aria-invalid'));
      err.textContent = '';
    }
    function setMode(next, focus = true) {
      mode = next;
      const reg = mode === 'register';
      titleEl.textContent = reg ? '가입하기' : '로그인';
      nameField.hidden = !reg;
      userHint.hidden = !reg;
      passHint.hidden = !reg;
      password.autocomplete = reg ? 'new-password' : 'current-password';
      switchBtn.textContent = reg ? '이미 계정이 있나요? 로그인' : '계정이 없나요? 가입하기';
      Object.entries(tabBtns).forEach(([t, b]) => {
        b.setAttribute('aria-selected', String(t === mode));
        b.classList.toggle('on', t === mode);
      });
      clearInvalid();
      paintSubmit();
      if (focus) (reg ? displayName : username).focus();
    }

    function validate(u, pw, name) {
      if (mode === 'register') {
        if (!name) return { el: displayName, text: '이름을 입력해 주세요.' };
        if (!USERNAME_RE.test(u)) return { el: username, text: '아이디는 영문 소문자·숫자·. _ - 로 3~30자예요.' };
        if (pw.length < 8) return { el: password, text: '비밀번호는 8자 이상이어야 해요.' };
      } else {
        if (!u) return { el: username, text: '아이디를 입력해 주세요.' };
        if (!pw) return { el: password, text: '비밀번호를 입력해 주세요.' };
      }
      return null;
    }

    async function submit(e) {
      e.preventDefault();
      if (busy) return;
      clearInvalid();
      const u = username.value.trim().toLowerCase();
      const pw = password.value;
      const name = displayName.value.trim();
      const problem = validate(u, pw, name);
      if (problem) {
        err.textContent = problem.text;
        problem.el.setAttribute('aria-invalid', 'true');
        problem.el.focus();
        return;
      }
      busy = true;
      paintSubmit();
      try {
        const user = mode === 'register' ? await store.register(u, pw, name) : await store.login(u, pw);
        settled = true;
        resolve(user);
        m.close(user);
        toast(mode === 'register' ? `가입했어요. 환영해요, ${user.displayName}님!` : `${user.displayName}님, 어서 오세요.`, 'success');
      } catch (ex) {
        err.textContent = ex.message || '요청을 처리하지 못했어요. 다시 시도해 주세요.';
        const bad = ex.code === 'username_taken' ? username : password;
        bad.setAttribute('aria-invalid', 'true');
        bad.focus();
        busy = false;
        paintSubmit();
      }
    }

    [displayName, username, password].forEach((i) => i.addEventListener('input', () => i.removeAttribute('aria-invalid')));
    setMode(mode, false);
  });
}

/* ───────── profile ───────── */
export function openProfileModal() {
  const me = store.me;
  if (!me) return openAuthModal();
  let color = me.avatarColor;
  const nameInput = h('input', { class: 'input', type: 'text', name: 'displayName', maxlength: LIMITS.displayName, value: me.displayName, autocomplete: 'nickname', autofocus: true });
  const preview = h('div', { class: 'app-profile-preview' });
  const swatches = h('div', { class: 'app-swatches', role: 'radiogroup', 'aria-label': '프로필 색' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const curPw = h('input', { class: 'input', type: 'password', name: 'currentPassword', autocomplete: 'current-password' });
  const newPw = h('input', { class: 'input', type: 'password', name: 'newPassword', autocomplete: 'new-password' });

  const paintPreview = () => preview.replaceChildren(avatar({ displayName: nameInput.value || me.displayName, avatarColor: color }, 56), h('span', { class: 'muted' }, me.isGuest ? '게스트' : '@' + me.username));
  const swatchBtns = AVATAR_COLORS.map((c, i) => h('button', {
    type: 'button', role: 'radio', class: 'app-swatch', 'aria-label': `프로필 색 ${i + 1}`, style: { background: c },
    onClick: () => { color = c; paintSwatches(); paintPreview(); },
  }, icon('check', { size: 16 })));
  function paintSwatches() {
    swatchBtns.forEach((b, i) => {
      const on = AVATAR_COLORS[i] === color;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
    });
  }
  swatchBtns.forEach((b) => swatches.appendChild(b));
  nameInput.addEventListener('input', paintPreview);
  paintSwatches();
  paintPreview();

  const pwBox = me.isGuest ? null : h('details', { class: 'app-details' },
    h('summary', null, '비밀번호 바꾸기'),
    h('label', { class: 'field' }, h('span', { class: 'label' }, '현재 비밀번호'), curPw),
    h('label', { class: 'field' }, h('span', { class: 'label' }, '새 비밀번호'), newPw, h('span', { class: 'hint' }, '8자 이상')));

  const body = h('form', { class: 'app-profile', onSubmit: (e) => e.preventDefault() },
    preview,
    h('label', { class: 'field' }, h('span', { class: 'label' }, '표시 이름'), nameInput),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '프로필 색'), swatches),
    pwBox, err);

  async function save() {
    err.textContent = '';
    const patch = {};
    const name = nameInput.value.trim();
    if (!name) { err.textContent = '이름을 입력해 주세요.'; nameInput.focus(); return false; }
    if (name !== me.displayName) patch.displayName = name;
    if (color !== me.avatarColor) patch.avatarColor = color;
    if (newPw.value || curPw.value) {
      if (!curPw.value) { err.textContent = '현재 비밀번호를 입력해 주세요.'; pwBox.open = true; curPw.focus(); return false; }
      if (newPw.value.length < 8) { err.textContent = '새 비밀번호는 8자 이상이어야 해요.'; pwBox.open = true; newPw.focus(); return false; }
      patch.currentPassword = curPw.value;
      patch.newPassword = newPw.value;
    }
    if (!Object.keys(patch).length) return true;
    try {
      await store.updateProfile(patch);
      toast('프로필을 저장했어요.', 'success');
      return true;
    } catch (e) {
      err.textContent = e.message || '저장하지 못했어요. 다시 시도해 주세요.';
      return false;
    }
  }

  return modal({
    title: me.isGuest ? '내 이름' : '프로필', size: 'sm', body,
    actions: [
      { label: '취소', kind: 'secondary' },
      { label: '저장', kind: 'primary', keepOpen: true, onClick: async (close) => { if (await save()) close(); } },
    ],
  });
}

/* ───────── user control (top bar) ───────── */
async function doLogout() {
  await store.logout();
  toast('로그아웃했어요.', 'success');
}

function openUserMenu(anchor) {
  const me = store.me;
  if (!me) return;
  popover(anchor, [
    { heading: me.displayName + (me.isGuest ? ' (게스트)' : '') },
    { label: '내 보드', icon: 'layout', onClick: () => router.go('/dashboard') },
    { label: me.isGuest ? '이름 바꾸기' : '프로필', icon: 'user', onClick: () => openProfileModal() },
    { separator: true },
    { label: '로그아웃', icon: 'logout', onClick: doLogout },
  ]);
}

/** Top-bar identity: login button for anonymous, name + menu for signed in, both for guests. */
export function userControl() {
  const el = h('div', { class: 'app-uc' });
  function render() {
    const me = store.me;
    const kids = [];
    if (me) {
      const btn = h('button', {
        type: 'button', class: 'app-uc-btn', 'aria-label': '사용자 메뉴', 'aria-haspopup': 'menu', title: me.displayName,
        onClick: () => openUserMenu(btn),
      }, avatar(me, 30), h('span', { class: 'app-uc-name' }, me.displayName + (me.isGuest ? ' (게스트)' : '')), icon('chevron-down', { size: 16 }));
      kids.push(btn);
    }
    if (!me || me.isGuest) {
      kids.push(h('button', { type: 'button', class: 'btn btn-primary btn-sm app-uc-login', onClick: () => openAuthModal() }, '로그인'));
    }
    el.replaceChildren(...kids);
  }
  const unsub = store.subscribe('me', render);
  render();
  return { el, destroy: unsub };
}
