// 404 page for unknown URLs.
import { h, mount } from '../lib/h.js';
import { icon } from '../lib/ui.js';
import { appHeader } from './shell.js';

export function notFoundPage(root) {
  document.title = '페이지를 찾을 수 없어요 · Edulet';
  const header = appHeader();
  mount(root, h('div', { class: 'app-page' }, header.el,
    h('main', { class: 'app-state', id: 'main' },
      h('span', { class: 'app-state-ico' }, icon('alert', { size: 28 })),
      h('h1', { class: 'app-state-title' }, '페이지를 찾을 수 없어요'),
      h('p', { class: 'muted' }, '주소가 잘못되었거나 사라진 페이지예요.'),
      h('div', { class: 'row app-state-actions' }, h('a', { class: 'btn btn-primary', href: '/', 'data-link': true }, '처음으로')))));
  return () => header.destroy();
}
