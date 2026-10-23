// Safe rich-text renderer: a deliberately small subset, built from DOM nodes (never innerHTML).
//   paragraphs / line breaks · **bold** · *italic* · `code` · "- " lists · auto-linked http(s) URLs
import { h } from './h.js';

// Only ASCII URL characters: Korean text glued to a URL stays outside the link.
const TOKEN = /(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|(`[^`\n]+`)|(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g;

// A URL longer than this is not made a link (text instead) — checked BEFORE trimming, so the trimming below can never be fed a huge tail.
// (Keep in step with public/js/lib/export-html.js, which writes the same rules as strings.)
const URL_MAX = 2048;
const URL_TAIL = new Set(['.', ',', ';', ':', '!', '?', "'", '"', ')', ']']);
// Punctuation that ends a sentence rather than the address is cut off the end — in ONE pass (the brackets are counted once and given up one
// by one; a ")" is kept while the address still has more "(" than ")" left, e.g. a Wikipedia title). Same rule as always, linear in the length.
export function trimUrl(url) {
  let end = url.length;
  let open = 0;
  let close = 0;
  for (let i = 0; i < end; i++) {
    const ch = url.charCodeAt(i);
    if (ch === 40) open++;
    else if (ch === 41) close++;
  }
  while (end > 0 && URL_TAIL.has(url[end - 1])) {
    if (url[end - 1] === ')') {
      if (open >= close) break;
      close--;
    }
    end--;
  }
  return [url.slice(0, end), url.slice(end)];
}

export function linkEl(url, label) {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow ugc', class: 'rich-link' }, label ?? url);
}

function inline(text) {
  const out = [];
  let last = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('strong', null, m[1].slice(2, -2)));
    else if (m[2]) out.push(h('em', null, m[2].slice(1, -1)));
    else if (m[3]) out.push(h('code', null, m[3].slice(1, -1)));
    else if (m[4]) {
      if (m[4].length > URL_MAX) out.push(m[4]);
      else {
        const [u, tail] = trimUrl(m[4]);
        out.push(linkEl(u));
        if (tail) out.push(tail);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderRich(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let para = null; // current <p>
  let list = null; // current <ul>
  const flush = () => {
    para = null;
    list = null;
  };
  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const li = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (li) {
      para = null;
      if (!list) frag.appendChild((list = h('ul', { class: 'rich-list' })));
      list.appendChild(h('li', null, inline(li[1])));
      continue;
    }
    list = null;
    if (!para) frag.appendChild((para = h('p', { class: 'rich-p' })));
    else para.appendChild(h('br'));
    for (const n of inline(line)) para.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
  }
  return frag;
}

/** Plain text (markers stripped) — for search and short snippets. */
export function plainText(text) {
  return String(text ?? '')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/\*([^*\n]+?)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
}
