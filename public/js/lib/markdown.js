// Safe rich-text renderer: a deliberately small subset, built from DOM nodes (never innerHTML).
//   paragraphs / line breaks · **bold** · *italic* · `code` · "- " lists · auto-linked http(s) URLs
import { h } from './h.js';

// Only ASCII URL characters: Korean text glued to a URL stays outside the link.
const TOKEN = /(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|(`[^`\n]+`)|(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g;

function trimUrl(url) {
  let u = url;
  let tail = '';
  while (/[.,;:!?'")\]]$/.test(u)) {
    // keep a closing paren that balances an opening one inside the URL
    if (u.endsWith(')') && (u.match(/\(/g) || []).length >= (u.match(/\)/g) || []).length) break;
    tail = u.slice(-1) + tail;
    u = u.slice(0, -1);
  }
  return [u, tail];
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
      const [u, tail] = trimUrl(m[4]);
      out.push(linkEl(u));
      if (tail) out.push(tail);
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
