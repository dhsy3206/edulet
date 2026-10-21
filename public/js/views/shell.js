// Page chrome for the non-board pages (landing, dashboard, 404).
import { h } from '../lib/h.js';
import { store } from '../lib/store.js';
import { userControl } from './auth.js';
import { isMember, logoMark } from './common.js';

const homeHref = () => (isMember(store.me) ? '/dashboard' : '/');

/** Logo link (text logo + mark). `cls` lets the board page reuse it with its own styling. */
export function logoLink(cls = 'app-logo') {
  return h('a', { class: cls, href: homeHref(), 'data-link': true, 'aria-label': 'Edulet 홈' },
    logoMark(26), h('span', { class: cls + '-text' }, 'Edulet'));
}

/** Header with logo, "내 보드" link and the user control. Returns { el, destroy }. */
export function appHeader() {
  const uc = userControl();
  const logo = logoLink('app-logo');
  const nav = h('nav', { class: 'app-nav', 'aria-label': '주요 메뉴' });
  function paint() {
    logo.setAttribute('href', homeHref());
    nav.replaceChildren(...(isMember(store.me) ? [h('a', { class: 'app-nav-link', href: '/dashboard', 'data-link': true }, '내 보드')] : []));
  }
  const unsub = store.subscribe('me', paint);
  paint();
  const el = h('header', { class: 'app-header' }, h('div', { class: 'app-header-in' }, logo, nav, h('span', { class: 'spacer' }), uc.el));
  return { el, destroy() { unsub(); uc.destroy(); } };
}
