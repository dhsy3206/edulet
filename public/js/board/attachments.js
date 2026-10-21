// Attachment rendering: compact previews for cards/messages and large media for detail/slideshow.
import { h } from '../lib/h.js';
import { icon, formatBytes } from '../lib/ui.js';
import { safeUrl, isExternalUrl, hostOf, fileExt } from './util.js';

/* Only these embed origins are ever put in an iframe (the server restricts them too). */
const EMBEDS = {
  'www.youtube-nocookie.com': /^\/embed\/[A-Za-z0-9_-]{6,24}$/,
  'player.vimeo.com': /^\/video\/\d{3,14}$/,
};

/** Validated embed URL for a video attachment, or null. */
export function embedUrlOf(att) {
  const raw = att && att.preview && att.preview.embedUrl;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const re = EMBEDS[u.hostname];
    if (!re || !re.test(u.pathname)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function thumbImg(src, alt = '') {
  const img = h('img', { class: 'b-att-img', src, alt, loading: 'lazy', decoding: 'async', draggable: 'false', referrerpolicy: isExternalUrl(src) ? 'no-referrer' : null });
  return img;
}

function titleOf(a, fallback = '') {
  const p = a.preview || {};
  return p.title || a.name || hostOf(a.url) || fallback;
}

/* ───────── compact (card / message / staged) ───────── */

function imageCompact(a, post) {
  const src = safeUrl(a.url);
  if (!src) return null;
  const img = thumbImg(src, a.name || post.title || '첨부 이미지');
  const box = h('div', { class: 'b-att b-att-image' }, img);
  const done = () => {
    if (img.naturalWidth) box.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    box.classList.add('loaded');
  };
  img.addEventListener('load', done);
  img.addEventListener('error', () => box.classList.add('broken'));
  if (img.complete && img.naturalWidth) done();
  return box;
}

function linkCompact(a) {
  const href = safeUrl(a.url);
  const p = a.preview || {};
  const img = p.image && safeUrl(p.image);
  const body = [
    img ? h('div', { class: 'b-att-thumb' }, thumbImg(img)) : null,
    h('div', { class: 'b-att-meta' },
      h('span', { class: 'b-att-site' }, icon('link', { size: 13 }), p.site || hostOf(a.url)),
      h('span', { class: 'b-att-title' }, titleOf(a)),
      p.description ? h('span', { class: 'b-att-desc' }, p.description) : null),
  ];
  if (!href) return h('div', { class: 'b-att b-att-link' }, body);
  return h('a', { class: 'b-att b-att-link', href, target: '_blank', rel: 'noopener noreferrer nofollow ugc', draggable: 'false' }, body);
}

function videoCompact(ctx, a, post, opts) {
  const p = a.preview || {};
  const img = p.image && safeUrl(p.image);
  const open = () => {
    if (opts.onOpen) opts.onOpen();
    else if (post && post.id != null) ctx.ctl.openPost(post.id);
  };
  return h('button', { type: 'button', class: ['b-att', 'b-att-video', !img && 'no-thumb'], 'aria-label': `영상 보기: ${titleOf(a, '영상')}`, onClick: open },
    img ? thumbImg(img) : null,
    h('span', { class: 'b-play', 'aria-hidden': 'true' }, icon('play', { size: 26 })),
    h('span', { class: 'b-att-vtitle' }, titleOf(a, '영상')));
}

function fileCompact(a) {
  const href = safeUrl(a.url);
  const p = a.preview || {};
  const img = p.image && safeUrl(p.image);
  const ext = fileExt(a.name);
  const body = [
    img ? h('div', { class: 'b-att-thumb' }, thumbImg(img)) : null,
    h('div', { class: 'b-att-filerow' },
      h('span', { class: 'b-att-fileicon', 'aria-hidden': 'true' }, icon('file', { size: 22 }), ext ? h('b', null, ext) : null),
      h('span', { class: 'b-att-meta' },
        h('span', { class: 'b-att-title' }, a.name || '파일'),
        h('span', { class: 'b-att-site' }, formatBytes(a.size))),
      href ? h('span', { class: 'b-att-dl', 'aria-hidden': 'true' }, icon('download', { size: 18 })) : null),
  ];
  if (!href) return h('div', { class: 'b-att b-att-file' }, body);
  return h('a', { class: 'b-att b-att-file', href, download: a.name || '', rel: 'noopener noreferrer', 'aria-label': `파일 내려받기: ${a.name || '파일'}`, draggable: 'false' }, body);
}

/** Compact attachment preview. opts.onOpen overrides the video click (staged previews). */
export function attachmentEl(ctx, post, opts = {}) {
  const a = post && post.attachment;
  if (!a) return null;
  switch (a.kind) {
    case 'image': return imageCompact(a, post);
    case 'link': return linkCompact(a);
    case 'video': return videoCompact(ctx, a, post, opts);
    case 'file': return fileCompact(a);
    default: return null;
  }
}

/* ───────── large media (detail / slideshow) ───────── */

function bigCard(a, { actionLabel, actionIcon, download }) {
  const p = a.preview || {};
  const img = p.image && safeUrl(p.image);
  const href = safeUrl(a.url);
  return h('div', { class: 'b-media-card' },
    img ? h('div', { class: 'b-media-card-img' }, thumbImg(img, titleOf(a))) : h('div', { class: 'b-media-card-icon', 'aria-hidden': 'true' }, icon(a.kind === 'file' ? 'file' : 'link', { size: 44 })),
    h('div', { class: 'b-media-card-meta' },
      h('span', { class: 'b-att-site' }, a.kind === 'file' ? [fileExt(a.name), formatBytes(a.size)].filter(Boolean).join(' · ') : p.site || hostOf(a.url)),
      h('h3', { class: 'b-media-card-title' }, titleOf(a)),
      p.description ? h('p', { class: 'b-media-card-desc' }, p.description) : null,
      href ? h('a', Object.assign({ class: 'btn btn-primary', href, rel: 'noopener noreferrer nofollow ugc' }, download ? { download: a.name || '' } : { target: '_blank' }),
        icon(actionIcon, { size: 18 }), actionLabel) : null));
}

/** Large media element for a post, or null when it has no attachment. */
export function mediaEl(ctx, post) {
  const a = post && post.attachment;
  if (!a) return null;
  if (a.kind === 'image') {
    const src = safeUrl(a.url);
    if (!src) return null;
    const img = thumbImg(src, a.name || post.title || '첨부 이미지');
    img.removeAttribute('loading');
    img.className = 'b-media-img';
    return h('div', { class: 'b-media b-media-image' }, img);
  }
  if (a.kind === 'video') {
    const embed = embedUrlOf(a);
    if (embed) {
      const frame = h('iframe', {
        class: 'b-media-frame', src: embed, title: titleOf(a, '영상'),
        sandbox: 'allow-scripts allow-same-origin allow-presentation',
        allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media', allowfullscreen: true,
        referrerpolicy: 'strict-origin-when-cross-origin', loading: 'lazy',
      });
      return h('div', { class: 'b-media b-media-video' }, frame);
    }
    return h('div', { class: 'b-media b-media-link' }, bigCard(a, { actionLabel: '새 탭에서 열기', actionIcon: 'external-link' }));
  }
  if (a.kind === 'link') return h('div', { class: 'b-media b-media-link' }, bigCard(a, { actionLabel: '링크 열기', actionIcon: 'external-link' }));
  if (a.kind === 'file') return h('div', { class: 'b-media b-media-link' }, bigCard(a, { actionLabel: '내려받기', actionIcon: 'download', download: true }));
  return null;
}
