// Auth UI: login/register modal (with Sign in with Google), user menu control, profile modal.
import { h } from '../lib/h.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { modal, popover, avatar, icon, toast } from '../lib/ui.js';
import { LIMITS } from '../lib/constants.js';
import { withBase, stripBase } from '../lib/base.js';
import { isMember } from './common.js';
import { backupAvailable, openSaveDialog, openRestoreDialog } from './backup-dialog.js'; // (backup-dialog.js imports openAuthModal back: only used when called)

export const AVATAR_COLORS = [
  '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#0284c7',
  '#2563eb', '#4f46e5', '#9333ea', '#db2777', '#475569', '#78716c',
];
const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/;

/* ───────── Google ───────── */
const googleOn = () => !!(store.config && store.config.google);

/** The server-side sign-in starts with a plain page navigation; Google sends the browser back to where it was (`next`). */
export function googleStartUrl() {
  return withBase('/api/auth/google/start') + '?' + new URLSearchParams({ next: stripBase(location.pathname) + location.search });
}

// Google's "G" (official multicolour mark, unmodified — see Google's sign-in branding guidelines)
const googleMark = () => h.svg('svg', { class: 'app-google-g', viewBox: '0 0 48 48', width: 18, height: 18, 'aria-hidden': 'true', focusable: 'false' },
  h.svg('path', { fill: '#EA4335', d: 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z' }),
  h.svg('path', { fill: '#4285F4', d: 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z' }),
  h.svg('path', { fill: '#FBBC05', d: 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z' }),
  h.svg('path', { fill: '#34A853', d: 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z' }));

/** The sign-in button of the login dialog (linking an existing account is a password-gated form in the profile dialog). */
function googleButton(label) {
  const btn = h('button', {
    type: 'button', class: 'btn btn-lg app-google-btn', dataset: { role: 'google-login' },
    onClick: () => {
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Google 로 이동하는 중…';
      location.assign(googleStartUrl());
    },
  }, googleMark(), h('span', null, label));
  return btn;
}

const GOOGLE_NOTES = {
  google_ok: ['success', (me) => `${me ? me.displayName + '님, ' : ''}어서 오세요.`],
  google_new: ['success', (me) => `가입했어요. 환영해요${me ? ', ' + me.displayName + '님' : ''}!`],
  google_linked: ['success', () => 'Google 계정을 연결했어요. 이제 Google 로도 로그인할 수 있어요.'],
  google_denied: ['info', () => 'Google 로그인을 취소했어요.'],
  google_state: ['error', () => '로그인 시간이 지났거나 요청이 맞지 않아요. 다시 시도해 주세요.'],
  google_failed: ['error', () => 'Google 로그인을 마치지 못했어요. 잠시 뒤에 다시 시도해 주세요.'],
  google_domain: ['error', () => '이 서버는 허용된 학교·기관의 Google 계정만 쓸 수 있어요. 다른 계정으로 다시 해 보세요.'],
  google_unverified: ['error', () => '이메일 확인이 끝나지 않은 Google 계정이라 쓸 수 없어요.'],
  google_disabled: ['error', () => '이 서버에서는 Google 로그인을 쓸 수 없어요.'],
  google_register_closed: ['error', () => '지금은 새 가입을 받지 않아요. 이미 Google 로 가입한 계정만 로그인할 수 있어요.'],
  google_taken: ['error', () => '이미 다른 계정에 연결된 Google 계정이에요.'],
  google_already_linked: ['info', () => '이미 Google 계정이 연결되어 있어요.'],
  google_need_login: ['error', () => '먼저 로그인한 뒤에 Google 계정을 연결할 수 있어요.'],
  google_rate: ['error', () => '시도가 너무 많아요. 잠시 뒤에 다시 해 주세요.'],
};

/** Google sign-in ends with a redirect + a one-minute `edulet_flash` cookie (the server's answer in a word): say it, once. */
export function showAuthFlash() {
  let code = '';
  try {
    const m = /(?:^|;\s*)edulet_flash=([a-z_]{1,40})(?:;|$)/.exec(document.cookie);
    code = m ? m[1] : '';
    if (code) document.cookie = 'edulet_flash=; Path=/; Max-Age=0; SameSite=Lax';
  } catch {
    return;
  }
  if (!code.startsWith('google_')) return;
  const [kind, text] = GOOGLE_NOTES[code] || ['error', () => 'Google 로그인을 마치지 못했어요. 다시 시도해 주세요.'];
  if (kind === 'success') store.broadcastMe(); // other tabs of this browser learn about the new session too
  toast(text(store.me), kind, kind === 'error' ? 6000 : 3500);
}

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

    const domains = (store.config && store.config.googleDomains) || [];
    const googleBlock = googleOn() ? h('div', { class: 'app-google' },
      googleButton('Google 계정으로 계속하기'),
      domains.length ? h('p', { class: 'hint app-google-hint' }, `${domains.map((d) => '@' + d).join(', ')} 계정만 쓸 수 있어요.`) : null,
      h('div', { class: 'app-divider', role: 'separator' }, h('span', null, '또는 아이디로'))) : null;

    const form = h('form', { class: 'app-auth', novalidate: true, onSubmit: submit },
      tabs, message ? h('p', { class: 'modal-text' }, message) : null, googleBlock, nameField, userField, passField, err, submitBtn, canRegister ? switchLine : null);

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

  // `hasPassword` is absent in older servers: only a definite "no" (a Google-only account) hides the form
  const noPassword = me.hasPassword === false;
  const pwBox = me.isGuest || noPassword ? null : h('details', { class: 'app-details' },
    h('summary', null, '비밀번호 바꾸기'),
    h('label', { class: 'field' }, h('span', { class: 'label' }, '현재 비밀번호'), curPw),
    h('label', { class: 'field' }, h('span', { class: 'label' }, '새 비밀번호'), newPw, h('span', { class: 'hint' }, '8자 이상')));

  // Linking / unlinking Google asks for the password again (the server enforces it): a stolen session must not be able to
  // plant its own Google account as a second way into this one. Neither password is ever part of save()'s patch.
  let m = null; // the profile dialog itself, for the unlink handler below
  const googlePw = h('input', { class: 'input', type: 'password', name: 'googlePassword', autocomplete: 'current-password' });
  const googlePwField = h('label', { class: 'field' }, h('span', { class: 'label' }, '현재 비밀번호'), googlePw);
  googlePw.addEventListener('input', () => { err.textContent = ''; });

  async function linkGoogle(btn) {
    err.textContent = '';
    if (!googlePw.value) { err.textContent = '현재 비밀번호를 입력해 주세요.'; googlePw.focus(); return; }
    btn.disabled = true;
    try {
      location.assign(await store.googleLink(googlePw.value, stripBase(location.pathname) + location.search));
    } catch (e) {
      err.textContent = e.message || 'Google 연결을 시작하지 못했어요. 다시 시도해 주세요.';
      btn.disabled = false;
    }
  }
  async function unlinkGoogle(btn) {
    err.textContent = '';
    if (!googlePw.value) { err.textContent = '현재 비밀번호를 입력해 주세요.'; googlePw.focus(); return; }
    btn.disabled = true;
    try {
      await store.googleUnlink(googlePw.value);
      toast('Google 연결을 풀었어요.', 'success');
      m.close();
      openProfileModal(); // redraw from the new state
    } catch (e) {
      err.textContent = e.message || 'Google 연결을 풀지 못했어요. 다시 시도해 주세요.';
      btn.disabled = false;
    }
  }

  let googleBox = null;
  if (me.googleEmail) {
    const unlinkBtn = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', dataset: { role: 'google-unlink' }, onClick: () => unlinkGoogle(unlinkBtn) }, 'Google 연결 해제');
    googleBox = h('div', { class: 'app-google-box' },
      h('div', { class: 'field app-google-linked', dataset: { role: 'google-linked' } },
        h('span', { class: 'label' }, 'Google 계정'),
        h('span', { class: 'app-google-who' }, googleMark(), h('span', null, me.googleEmail)),
        noPassword ? h('span', { class: 'hint' }, `Google 로 로그인하는 계정이라 비밀번호가 없어요. 보드에 초대받을 때는 아이디 @${me.username} 를 알려 주세요.`) : null),
      noPassword ? null : h('details', { class: 'app-details', dataset: { role: 'google-unlink-box' } },
        h('summary', null, 'Google 연결 해제'),
        h('span', { class: 'hint' }, '해제하면 이 계정에는 아이디와 비밀번호로만 들어올 수 있어요.'),
        googlePwField, unlinkBtn));
  } else if (!me.isGuest && !noPassword && googleOn()) {
    const linkBtn = h('button', { type: 'button', class: 'btn app-google-btn', dataset: { role: 'google-link' }, onClick: () => linkGoogle(linkBtn) },
      googleMark(), h('span', null, 'Google 계정 연결하기'));
    googleBox = h('details', { class: 'app-details', dataset: { role: 'google-link-box' } },
      h('summary', null, 'Google 계정 연결하기'),
      h('span', { class: 'hint' }, '연결하면 Google 로도 이 계정에 로그인할 수 있어요. 보안을 위해 현재 비밀번호를 한 번 더 확인해요. 지금 입력 중인 변경 사항은 저장되지 않아요.'),
      googlePwField, linkBtn);
  }

  const body = h('form', { class: 'app-profile', onSubmit: (e) => e.preventDefault() },
    preview,
    h('label', { class: 'field' }, h('span', { class: 'label' }, '표시 이름'), nameInput),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '프로필 색'), swatches),
    googleBox, pwBox, err);

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

  m = modal({
    title: me.isGuest ? '내 이름' : '프로필', size: 'sm', body,
    actions: [
      { label: '취소', kind: 'secondary' },
      { label: '저장', kind: 'primary', keepOpen: true, onClick: async (close) => { if (await save()) close(); } },
    ],
  });
  return m;
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
    // the server PC's operator only (`/config.backup.available`) — also reachable from a board, which has no header nav
    ...(backupAvailable() ? [
      { separator: true },
      { label: '저장하기', icon: 'save', onClick: () => openSaveDialog({ returnFocus: anchor }) },
      { label: '불러오기', icon: 'history', onClick: () => openRestoreDialog({ returnFocus: anchor }) },
    ] : []),
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
