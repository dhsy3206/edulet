// Tiny hyperscript helper. User-controlled values must only ever reach the DOM through
// text nodes / attributes created here — never innerHTML.
const SVG_NS = 'http://www.w3.org/2000/svg';
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'xlink:href']);
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'readOnly', 'multiple']);

function safeUrl(v) {
  const s = String(v).trim().toLowerCase().replace(/[\u0000- ]/g, '');
  return !(s.startsWith('javascript:') || s.startsWith('vbscript:') || (s.startsWith('data:') && !s.startsWith('data:image/')));
}

function applyProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') {
      const cls = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      if (cls) el.setAttribute('class', cls);
    } else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv == null || sv === false) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv != null && dv !== false) el.dataset[dk] = String(dv);
    } else if (k === 'ref' && typeof v === 'function') {
      v(el);
    } else if (k.startsWith('on')) {
      if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (PROPS.has(k)) {
      el[k] = v;
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      if (URL_ATTRS.has(k) && !safeUrl(v)) continue;
      el.setAttribute(k, String(v));
    }
  }
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

h.svg = (tag, props, ...children) => {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  append(el, children);
  return el;
};

h.frag = (...children) => {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
};

/** Replace all children of `el` with `children`. */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function qs(sel, root = document) {
  return root.querySelector(sel);
}
export function qsa(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}
