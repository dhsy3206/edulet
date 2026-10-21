// A small floating panel anchored to an element, for custom popover content (swatches, emoji, grades).
// (ui.popover only does menu lists.) One open at a time; closes on outside press / Esc / scroll / resize.
import { h } from '../lib/h.js';
import { focusables } from '../lib/ui.js';

let current = null;

/**
 * floating(anchor, content, { align, label, onClose }) → { el, close }
 * content: Node. Escape closes and is swallowed so overlays underneath stay open.
 */
export function floating(anchor, content, { align = 'start', label = '', onClose, className = '' } = {}) {
  if (current) current.close();
  const el = h('div', { class: ['b-float', className], role: 'dialog', 'aria-label': label || null, tabindex: '-1' }, content);
  el.style.visibility = 'hidden';
  document.body.appendChild(el);

  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.visibility = '';

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onScroll, true);
    el.remove();
    if (current && current.el === el) current = null;
    if (onClose) onClose();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      if (anchor.focus && document.contains(anchor)) anchor.focus();
    } else if (e.key === 'Tab') {
      const f = focusables(el);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  function onDown(e) {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close();
  }
  function onScroll(e) {
    if (!el.contains(e.target)) close();
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', onScroll, true);
  current = { el, close };
  const first = focusables(el)[0];
  if (first) first.focus();
  return { el, close };
}
