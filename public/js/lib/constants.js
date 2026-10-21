// Keep in sync with server/constants.js (see docs/CONTRACT.md §2).
export const FORMATS = ['wall', 'grid', 'stream', 'shelf', 'rows', 'canvas', 'backchannel'];
export const SECTIONED = ['shelf', 'rows'];
export const ROLES = ['read', 'comment', 'write', 'moderate', 'admin'];
export const VISIBILITY = ['private', 'link'];
export const LINK_ACCESS = ['read', 'comment', 'write', 'moderate'];
export const REACTIONS = ['none', 'like', 'vote', 'star', 'grade', 'emoji'];
export const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
export const POST_COLORS = [null, 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
export const FONTS = ['sans', 'serif', 'mono', 'rounded'];
export const SCHEMES = ['light', 'dark'];
export const WALLPAPERS = ['green', 'ocean', 'sunset', 'lavender', 'slate', 'paper', 'mint', 'rose', 'night', 'sunrise'];
export const TEMPLATES = ['blank', 'kwl', 'retro', 'training'];
export const LIMITS = { postTitle: 200, postBody: 10000, comment: 2000, boardTitle: 120, boardDescription: 1000, sectionTitle: 80, displayName: 40 };

export const FORMAT_LABELS = {
  wall: { name: '벽', desc: '카드를 벽돌처럼 차곡차곡 쌓아요' },
  grid: { name: '격자', desc: '같은 크기의 카드를 가지런히 놓아요' },
  stream: { name: '스트림', desc: '한 줄로 이어지는 피드예요' },
  shelf: { name: '선반', desc: '섹션별 세로 열로 나눠요' },
  rows: { name: '줄', desc: '섹션별 가로 줄로 나눠요' },
  canvas: { name: '캔버스', desc: '카드를 자유롭게 끌어다 놓아요' },
  backchannel: { name: '채팅', desc: '대화하듯 실시간으로 이어 써요' },
};

export const WALLPAPER_LABELS = {
  green: '초록', ocean: '바다', sunset: '노을', lavender: '라벤더', slate: '슬레이트',
  paper: '종이', mint: '민트', rose: '장미', night: '밤하늘', sunrise: '일출',
};
// Wallpapers whose title text must be light. (Cards stay light unless colorScheme = dark.)
export const DARK_WALLPAPERS = ['green', 'ocean', 'sunset', 'slate', 'night', 'lavender'];

export const POST_COLOR_LABELS = { red: '빨강', orange: '주황', yellow: '노랑', green: '초록', blue: '파랑', purple: '보라', pink: '분홍' };
export const FONT_LABELS = { sans: '고딕', serif: '명조', mono: '고정폭', rounded: '둥근' };

export const ROLE_LABELS = {
  read: '보기만', comment: '댓글 달기', write: '글쓰기', moderate: '관리(편집)', admin: '관리자',
};
export const LINK_ACCESS_LABELS = { read: '보기만', comment: '댓글 달기', write: '글쓰기', moderate: '관리(편집)' };
export const REACTION_LABELS = { none: '반응 없음', like: '좋아요', vote: '투표', star: '별점(별 표시)', grade: '점수(1~10)', emoji: '이모지' };

export const TEMPLATE_LABELS = {
  blank: { name: '빈 보드', desc: '아무것도 없이 시작해요' },
  kwl: { name: 'KWL 표', desc: '알고 있는 것 · 알고 싶은 것 · 배운 것' },
  retro: { name: '돌아보기', desc: '잘한 점 · 아쉬운 점 · 시도할 점' },
  training: { name: '연수 자료', desc: '1부 · 2부 줄로 나눈 자료 모음' },
};
