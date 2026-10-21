// Staging area for one attachment (upload with progress, or link/video preview) — shared by the composer
// and the chat input. It owns no input controls: callers trigger pickFile()/addFile()/addLink().
import { h } from '../lib/h.js';
import { icon, toast, formatBytes } from '../lib/ui.js';
import { store } from '../lib/store.js';
import { attachmentEl } from './attachments.js';
import { safeUrl, hostOf } from './util.js';

/** "example.com/a" → "https://example.com/a"; returns null when it isn't an http(s) address. */
export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (/^[^\s/]+\.[^\s/]+/.test(s)) s = 'https://' + s;
    else return null;
  }
  return safeUrl(s);
}

/**
 * createAttachField(ctx, { initial, onChange }) → {
 *   el, value(), hasAttachment(), busy(), pickFile(accept), addFile(file), addLink(url), clear(), snapshot(), restore(s), destroy()
 * }
 * value(): undefined = leave as is (omit from the request) · null = remove · {kind, uploadId|url} = set.
 */
export function createAttachField(ctx, { initial = null, onChange } = {}) {
  let staged = initial ? { ...initial, unchanged: true } : null;
  let removed = false;
  let uploading = null;
  let linking = false;
  let dead = false;
  const el = h('div', { class: 'b-attach-field', 'aria-live': 'polite' });
  const fileInput = h('input', { type: 'file', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', 'data-role': 'file-input' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) addFile(f);
  });
  let bar = null;

  function changed() {
    render();
    if (onChange) onChange();
  }

  function render() {
    const kids = [fileInput];
    if (uploading) {
      bar = h('progress', { class: 'b-progress', max: 100, 'aria-label': `${uploading.name} 올리는 중` });
      bar.value = Math.round(uploading.p * 100);
      kids.push(h('div', { class: 'b-att-progress' }, icon('paperclip', { size: 16 }), h('span', { class: 'truncate' }, `${uploading.name} 올리는 중…`), bar));
    } else if (linking) {
      kids.push(h('div', { class: 'b-att-progress' }, h('span', { class: 'spinner b-spin-sm' }), h('span', null, '링크 미리보기를 가져오는 중…')));
    } else if (staged) {
      const a = { kind: staged.kind, url: staged.url, name: staged.name, mime: staged.mime, size: staged.size, preview: staged.preview };
      const node = attachmentEl(ctx, { id: null, title: '', attachment: a }, { onOpen: () => {} });
      kids.push(h('div', { class: 'b-staged' }, node || h('span', null, staged.name || '첨부'),
        h('button', { type: 'button', class: 'b-staged-x btn-icon sm', 'aria-label': '첨부 삭제', title: '첨부 삭제', onClick: clear }, icon('x', { size: 16 }))));
    }
    el.replaceChildren(...kids);
    el.hidden = kids.length === 1;
  }

  function clear() {
    if (uploading || linking) return;
    if (staged && staged.unchanged) removed = true;
    staged = null;
    changed();
  }

  async function addFile(file) {
    if (uploading || linking) {
      toast('앞의 첨부를 올리는 중이에요. 잠시만 기다려 주세요.', 'info');
      return;
    }
    const max = store.config && store.config.maxUploadMb;
    if (max && file.size > max * 1024 * 1024) {
      toast(`파일이 너무 커요. ${max}MB 이하만 올릴 수 있어요. (${formatBytes(file.size)})`, 'error');
      return;
    }
    uploading = { name: file.name || '파일', p: 0 };
    changed();
    try {
      const r = await ctx.ctl.upload(file, (p) => {
        if (uploading && bar) {
          uploading.p = p;
          bar.value = Math.round(p * 100);
        }
      });
      if (dead) return;
      staged = { kind: r.kind, name: r.name, url: r.url, mime: r.mime, size: r.size, uploadId: r.uploadId };
      removed = false;
    } catch (e) {
      ctx.fail(e);
    } finally {
      uploading = null;
      if (!dead) changed();
    }
  }

  async function addLink(raw) {
    if (uploading || linking) return false;
    const url = normalizeUrl(raw);
    if (!url) {
      toast('http:// 또는 https:// 로 시작하는 주소를 입력해 주세요.', 'error');
      return false;
    }
    linking = true;
    changed();
    let ok = false;
    try {
      let pv = null;
      try {
        pv = await ctx.ctl.linkPreview(url);
      } catch (e) {
        if (e && e.code === 'cancelled') return false;
        if (e && (e.status === 401 || e.status === 429 || e.status === 0)) toast(e.message || '미리보기를 가져오지 못했어요.', 'info');
        else toast('미리보기를 가져오지 못했지만 링크는 붙였어요.', 'info');
      }
      if (dead) return false;
      const kind = pv && pv.kind === 'video' ? 'video' : 'link';
      staged = {
        kind, linkUrl: url, url: (pv && safeUrl(pv.url)) || url, name: (pv && pv.title) || hostOf(url),
        preview: { title: (pv && pv.title) || hostOf(url), description: (pv && pv.description) || '', image: (pv && pv.image) || '', site: (pv && pv.site) || hostOf(url), embedUrl: pv && pv.embedUrl },
      };
      removed = false;
      ok = true;
    } finally {
      linking = false;
      if (!dead) changed();
    }
    return ok;
  }

  function pickFile(accept) {
    if (uploading || linking) return;
    if (accept) fileInput.setAttribute('accept', accept);
    else fileInput.removeAttribute('accept');
    fileInput.click();
  }

  function value() {
    if (!staged) return removed ? null : undefined;
    if (staged.unchanged) return undefined;
    if (staged.uploadId) return { kind: staged.kind, uploadId: staged.uploadId };
    return { kind: staged.kind, url: staged.linkUrl || staged.url };
  }

  render();
  return {
    el,
    value,
    hasAttachment: () => !!staged,
    busy: () => !!(uploading || linking),
    pickFile,
    addFile,
    addLink,
    clear,
    /** Draft support (composer keeps an unsent draft in memory). */
    snapshot: () => (staged && !staged.unchanged ? { ...staged } : null),
    restore(s) {
      if (!s) return;
      staged = { ...s };
      removed = false;
      changed();
    },
    destroy() {
      dead = true;
    },
  };
}
