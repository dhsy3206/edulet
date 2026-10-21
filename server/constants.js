// Shared constants (mirrors public/js/lib/constants.js). Single source: docs/CONTRACT.md §2.
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
export const ATTACH_KINDS = ['image', 'file', 'link', 'video'];
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export const DEFAULT_SETTINGS = Object.freeze({
  reactions: 'like',
  comments: 'on',
  approval: false,
  showAuthor: true,
  newPostPosition: 'top',
});

export const LIMITS = {
  postTitle: 200,
  postBody: 10000,
  comment: 2000,
  boardTitle: 120,
  boardDesc: 1000,
  sectionTitle: 80,
  displayName: 40,
  usernameMin: 3,
  usernameMax: 30,
  passwordMin: 8,
  passwordMax: 200,
  url: 2000,
};

export const TEMPLATE_DEFS = {
  blank: { format: 'wall', sections: [] },
  kwl: { format: 'shelf', sections: ['알고 있는 것', '알고 싶은 것', '배운 것'] },
  retro: { format: 'shelf', sections: ['잘한 점', '아쉬운 점', '시도할 점'] },
  training: { format: 'rows', sections: ['1부', '2부'] },
};

export const AVATAR_COLORS = [
  '#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7',
  '#4db6ac', '#81c784', '#ffb74d', '#a1887f', '#90a4ae',
];

export const roleIndex = (r) => ROLES.indexOf(r);
export const atLeast = (role, min) => role != null && roleIndex(role) >= roleIndex(min);
export const isSectioned = (format) => SECTIONED.includes(format);
