// Slim top bar of the board page: logo, expanding search, slideshow, share, settings, presence, user menu.
import { h, mount } from '../lib/h.js';
import { icon, avatar, toast, debounce } from '../lib/ui.js';
import { userControl } from './auth.js';
import { logoLink } from './shell.js';

const MAX_AVATARS = 4;

function isTyping(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/** Bar for states without a board (loading / not found / error): logo + user control only. */
export function simpleBar() {
  const uc = userControl();
  const el = h('header', { class: 'bp-topbar' }, h('div', { class: 'bp-topbar-in' }, logoLink('bp-logo'), h('span', { class: 'spacer' }), uc.el));
  return { el, destroy: () => uc.destroy() };
}

/**
 * Full bar. Returns { el, update(), updatePresence(), destroy() }.
 * Call update() after snapshots (role may have changed) and updatePresence() on presence events.
 */
export function createTopbar(ctl, { onShare, onSettings }) {
  const uc = userControl();

  /* search: the input itself is the toggle (collapsed = a 36px pill with an icon) */
  const input = h('input', {
    class: 'bp-search-input', type: 'search', name: 'q', placeholder: '검색', 'aria-label': '검색',
    autocomplete: 'off', enterkeyhint: 'search',
  });
  const clearBtn = h('button', {
    type: 'button', class: 'bp-search-clear', 'aria-label': '검색어 지우기', tabindex: '-1',
    onMousedown: (e) => e.preventDefault(), // keep focus so the mobile layout does not collapse mid-click
    onClick: () => { input.value = ''; apply(); input.focus(); },
  }, icon('x', { size: 14 }));
  const search = h('div', { class: 'bp-search' }, icon('search', { size: 18, class: 'bp-search-ico' }), input, clearBtn);
  const push = debounce(() => ctl.setSearch(input.value), 200);
  function apply() {
    search.classList.toggle('has-value', input.value !== '');
    push.cancel();
    ctl.setSearch(input.value);
  }
  input.addEventListener('input', () => {
    search.classList.toggle('has-value', input.value !== '');
    push();
  });
  input.addEventListener('focus', () => bar.classList.add('searching'));
  input.addEventListener('blur', () => bar.classList.remove('searching'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      input.value = '';
      apply();
      input.blur();
    }
  });

  const slideshowBtn = h('button', {
    type: 'button', class: 'bp-btn', 'aria-label': '슬라이드쇼',
    onClick: () => {
      if (!ctl.navPosts().length) return toast('슬라이드쇼로 보여 줄 글이 아직 없어요.', 'info');
      ctl.openSlideshow();
    },
  }, icon('play-circle', { size: 18 }), h('span', { class: 'bp-btn-label' }, '슬라이드쇼'));
  const shareBtn = h('button', { type: 'button', class: 'bp-btn', 'aria-label': '공유', onClick: onShare },
    icon('share', { size: 18 }), h('span', { class: 'bp-btn-label' }, '공유'));
  const settingsBtn = h('button', { type: 'button', class: 'bp-btn bp-btn-icon', 'aria-label': '설정', title: '보드 설정', onClick: onSettings },
    icon('settings', { size: 18 }));
  const presence = h('div', { class: 'bp-presence', role: 'group', dataset: { role: 'presence' } });

  const bar = h('header', { class: 'bp-topbar' },
    // presence sits left of the buttons so avatars joining/leaving never move what you are about to click
    h('div', { class: 'bp-topbar-in' }, logoLink('bp-logo'), h('span', { class: 'spacer' }),
      presence, search, slideshowBtn, shareBtn, uc.el));

  function updatePresence() {
    const list = ctl.state.presence || [];
    const shown = list.slice(0, MAX_AVATARS);
    const rest = list.slice(MAX_AVATARS);
    presence.hidden = list.length === 0;
    presence.setAttribute('aria-label', `접속 중 ${list.length}명: ${list.map((u) => u.displayName).join(', ')}`);
    mount(presence,
      ...shown.map((u) => h('span', { class: 'bp-presence-item', title: u.displayName }, avatar(u, 28))),
      rest.length ? h('span', { class: 'bp-presence-more', title: rest.map((u) => u.displayName).join(', ') }, '+' + rest.length) : null
    );
  }
  function update() {
    // only admins get the button (removed, not just hidden)
    if (!ctl.can('admin')) settingsBtn.remove();
    else if (!settingsBtn.isConnected) shareBtn.after(settingsBtn);
    updatePresence();
  }

  function onKey(e) {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (document.querySelector('.modal-backdrop') || ctl.state.slideshow || ctl.state.openPostId != null) return;
    e.preventDefault();
    input.focus();
    input.select();
  }
  document.addEventListener('keydown', onKey);

  update();
  return {
    el: bar, update, updatePresence,
    destroy() {
      document.removeEventListener('keydown', onKey);
      push.cancel();
      uc.destroy();
    },
  };
}
