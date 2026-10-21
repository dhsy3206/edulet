// Landing page.
import { h, mount } from '../lib/h.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { icon } from '../lib/ui.js';
import { FORMATS, FORMAT_LABELS } from '../lib/constants.js';
import { FORMAT_ICON, isMember, redirect } from './common.js';
import { openAuthModal } from './auth.js';
import { appHeader } from './shell.js';

const FEATURES = [
  { icon: 'users', title: '함께 쓰는 실시간 보드', text: '한 사람이 올리면 모두의 화면에 바로 나타나요. 새로고침이 필요 없어요.' },
  { icon: 'share', title: '링크·QR 하나로 공유', text: '주소를 보내거나 QR을 띄우면 끝. 게스트는 이름만 입력하면 참여해요.' },
  { icon: 'lock', title: '권한을 나눠서', text: '보기·댓글·글쓰기·관리 권한을 보드마다, 사람마다 정할 수 있어요.' },
  { icon: 'image', title: '사진·파일·링크·영상', text: '이미지와 문서를 올리고, 링크는 미리보기로, 유튜브는 그 자리에서 재생해요.' },
];

/** A decorative, static mini board for the hero. */
function heroArt() {
  const col = (title, cards) => h('div', { class: 'home-art-col' },
    h('div', { class: 'home-art-tab' }, title),
    cards.map((c) => h('div', { class: ['home-art-card', c.img && 'has-img', c.tint && 'tint-' + c.tint] },
      c.img ? h('div', { class: 'home-art-img', style: { background: c.img } }) : null,
      h('div', { class: 'home-art-line w80' }), h('div', { class: 'home-art-line w50' }))));
  return h('div', { class: 'home-art wp-green', 'aria-hidden': 'true' },
    col('알고 있는 것', [{ tint: 'yellow' }, { img: 'linear-gradient(135deg,#7dd3fc,#38bdf8)' }]),
    col('알고 싶은 것', [{ img: 'linear-gradient(135deg,#fda4af,#fb7185)' }, { tint: 'blue' }]),
    col('배운 것', [{ tint: 'pink' }, { tint: 'green' }, {}]));
}

export function homePage(root) {
  document.title = 'Edulet — 함께 쓰는 실시간 보드';
  // Signed-in users go straight to their boards (deferred: we are inside the router's resolve()).
  if (isMember(store.me)) {
    redirect('/dashboard');
    return () => {};
  }

  const header = appHeader();
  let pendingCreate = false;

  async function startCreate() {
    pendingCreate = true;
    try {
      const user = await openAuthModal({ tab: 'register', message: '보드를 만들려면 로그인이 필요해요. 가입은 1분이면 끝나요.' });
      if (user && isMember(user)) router.go('/dashboard?new=1');
    } finally {
      pendingCreate = false;
    }
  }

  const unsub = store.subscribe('me', () => {
    if (isMember(store.me) && !pendingCreate) redirect('/dashboard');
  });

  const hero = h('section', { class: 'home-hero' },
    h('div', { class: 'home-hero-copy' },
      h('p', { class: 'home-eyebrow' }, '수업 · 연수 · 회의를 위한 보드'),
      h('h1', { class: 'home-title' }, '생각을 모으는 가장 쉬운 방법'),
      h('p', { class: 'home-lead' }, '링크 하나로 모두가 함께 글과 사진, 링크를 올리는 실시간 보드예요. 설치도 필요 없고, 참여하는 사람은 가입하지 않아도 돼요.'),
      h('div', { class: 'home-cta' },
        h('button', { type: 'button', class: 'btn btn-primary btn-lg', onClick: startCreate }, icon('plus', { size: 20 }), '보드 만들기'),
        h('a', { class: 'btn btn-secondary btn-lg', href: '/b/practice', 'data-link': true }, '연습장 열어 보기'),
        h('a', { class: 'btn btn-ghost btn-lg', href: '/b/demo-board', 'data-link': true }, '연수 예시 보기')),
      h('p', { class: 'home-note' }, '연습장과 예시 보드는 로그인 없이 바로 열려요.')),
    heroArt());

  const features = h('section', { class: 'home-section', 'aria-labelledby': 'home-feat' },
    h('h2', { class: 'home-h2 sr-only', id: 'home-feat' }, '주요 기능'),
    h('div', { class: 'home-features' }, FEATURES.map((f) => h('div', { class: 'home-feature' },
      h('span', { class: 'home-feature-ico' }, icon(f.icon, { size: 22 })),
      h('h3', null, f.title), h('p', null, f.text)))));

  const formats = h('section', { class: 'home-section', 'aria-labelledby': 'home-fmt' },
    h('h2', { class: 'home-h2', id: 'home-fmt' }, '일곱 가지 보드 형식'),
    h('p', { class: 'home-sub' }, '활동에 맞는 모양을 고르고, 쓰는 도중에도 바꿀 수 있어요.'),
    h('div', { class: 'home-formats' }, FORMATS.map((f) => h('div', { class: 'home-format' },
      h('span', { class: 'home-format-ico' }, icon(FORMAT_ICON[f], { size: 24 })),
      h('strong', null, FORMAT_LABELS[f].name), h('span', { class: 'muted' }, FORMAT_LABELS[f].desc)))));

  const footer = h('footer', { class: 'app-footer' }, 'Edulet · 교실과 연수를 위한 실시간 보드');

  mount(root, h('div', { class: 'app-page' }, header.el, h('main', { class: 'home', id: 'main' }, hero, features, formats), footer));

  return () => {
    unsub();
    header.destroy();
  };
}
