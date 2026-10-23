// Page chrome for the non-board pages (landing, dashboard, 404).
import { h } from '../lib/h.js';
import { store } from '../lib/store.js';
import { icon } from '../lib/ui.js';
import { userControl } from './auth.js';
import { isMember, logoMark } from './common.js';
import { backupAvailable, openSaveDialog, openRestoreDialog } from './backup-dialog.js';

const homeHref = () => (isMember(store.me) ? '/dashboard' : '/');

/** Logo link (text logo + mark). `cls` lets the board page reuse it with its own styling. */
export function logoLink(cls = 'app-logo') {
  return h('a', { class: cls, href: homeHref(), 'data-link': true, 'aria-label': 'Edulet 홈' },
    logoMark(26), h('span', { class: cls + '-text' }, 'Edulet'));
}

/** Header with logo, "내 보드" link, 저장하기·불러오기 (server PC only) and the user control. Returns { el, destroy }. */
export function appHeader() {
  const uc = userControl();
  const logo = logoLink('app-logo');
  const nav = h('nav', { class: 'app-nav', 'aria-label': '주요 메뉴' });
  // 저장하기·불러오기 are for the person at the server PC (`/config.backup.available`); they are removed, not just hidden, for everybody else.
  // They do not depend on being signed in (a fresh PC has no account yet when its first backup is restored) and they stay visible, icon-only,
  // on narrow screens where the nav links are dropped.
  const backup = h('div', { class: 'app-backup', role: 'group', 'aria-label': '저장하기와 불러오기', dataset: { role: 'backup-nav' } });
  const backupBtn = (label, ico, role, open) => {
    const btn = h('button', {
      type: 'button', class: 'app-nav-link app-backup-btn', 'aria-label': label, title: label, dataset: { role },
      onClick: () => open({ returnFocus: btn }),
    }, icon(ico, { size: 18 }), h('span', { class: 'app-backup-label' }, label));
    return btn;
  };
  const saveBtn = backupBtn('저장하기', 'save', 'backup-save', openSaveDialog);
  const restoreBtn = backupBtn('불러오기', 'history', 'backup-restore', openRestoreDialog);
  function paint() {
    logo.setAttribute('href', homeHref());
    nav.replaceChildren(...(isMember(store.me) ? [h('a', { class: 'app-nav-link', href: '/dashboard', 'data-link': true }, '내 보드')] : []));
  }
  function paintBackup() {
    backup.replaceChildren(...(backupAvailable() ? [saveBtn, restoreBtn] : []));
  }
  const unsub = store.subscribe('me', paint);
  const unsubCfg = store.subscribe('config', paintBackup);
  paint();
  paintBackup();
  const el = h('header', { class: 'app-header' }, h('div', { class: 'app-header-in' }, logo, nav, backup, h('span', { class: 'spacer' }), uc.el));
  return { el, destroy() { unsub(); unsubCfg(); uc.destroy(); } };
}
