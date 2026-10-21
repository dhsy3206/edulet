// Post actions shared by cards, messages and the detail view: the ⋮ menu, color picker, delete, section picker.
import { h } from '../lib/h.js';
import { popover, confirmDialog, copyText, toast } from '../lib/ui.js';
import { POST_COLORS, POST_COLOR_LABELS } from '../lib/constants.js';
import { floating } from './float.js';
import { postUrl } from './util.js';

export function openColorPicker(ctx, anchor, post) {
  const cur = post.color || null;
  const swatches = POST_COLORS.map((c) => h('button', {
    type: 'button', class: ['b-swatch', c && 'pc-' + c, !c && 'is-none', (c || null) === cur && 'on'], 'aria-pressed': String((c || null) === cur),
    'aria-label': c ? POST_COLOR_LABELS[c] : '기본(흰색)', title: c ? POST_COLOR_LABELS[c] : '기본',
    onClick: () => {
      f.close();
      if ((c || null) !== cur) ctx.run(() => ctx.ctl.updatePost(post.id, { color: c || null }));
    },
  }));
  const f = floating(anchor, h('div', { class: 'b-swatch-pop' }, h('div', { class: 'b-float-title' }, '카드 색'), h('div', { class: 'b-swatch-row' }, swatches)), { label: '카드 색 변경' });
  return f;
}

export function confirmDeletePost(ctx, post) {
  return confirmDialog({ title: '카드를 삭제할까요?', message: '삭제한 카드는 되돌릴 수 없어요. 댓글도 함께 사라져요.', confirmLabel: '삭제', danger: true }).then((ok) => {
    if (ok) return ctx.run(() => ctx.ctl.deletePost(post.id));
    return undefined;
  });
}

function listFor(ctx, post) {
  const { ctl } = ctx;
  return (ctl.sectioned ? ctl.postsOf(post.sectionId ?? null) : ctl.sortedPosts()).filter((p) => p.id !== post.id);
}

const ORDERED = new Set(['wall', 'grid', 'stream', 'shelf', 'rows']);

export function openSectionPicker(ctx, anchor, post) {
  const secs = ctx.ctl.sortedSections();
  popover(anchor, [
    { heading: '섹션으로 이동' },
    ...secs.map((s) => ({
      label: s.title || '(이름 없음)', icon: ctx.format() === 'rows' ? 'rows' : 'columns', checked: s.id === post.sectionId,
      onClick: () => (s.id === post.sectionId ? null : ctx.run(() => ctx.ctl.movePost(post.id, { sectionId: s.id, beforeId: null }))),
    })),
  ], { minWidth: 200 });
}

/** The ⋮ menu. Items depend on the viewer's permissions and the board format. */
export function openPostMenu(ctx, anchor, post) {
  const { ctl } = ctx;
  const canEdit = ctl.canEditPost(post);
  const canMod = ctl.can('moderate');
  const canMove = ctl.canMovePost(post);
  const fmt = ctx.format();

  const primary = [];
  if (canEdit) primary.push({ label: '수정', icon: 'edit', onClick: () => ctx.composer.open({ mode: 'edit', post }) });
  if (canMod && post.status === 'pending') primary.push({ label: '승인', icon: 'check', onClick: () => ctx.run(() => ctl.approvePost(post.id)) });
  if (canMod) primary.push({ label: post.pinned ? '고정 해제' : '상단에 고정', icon: 'pin', onClick: () => ctx.run(() => ctl.updatePost(post.id, { pinned: !post.pinned })) });
  if (canEdit) primary.push({ label: '카드 색 변경', icon: 'palette', onClick: () => openColorPicker(ctx, anchor, post) });

  const move = [];
  if (canMove && ORDERED.has(fmt)) {
    const others = listFor(ctx, post);
    const all = (ctl.sectioned ? ctl.postsOf(post.sectionId ?? null) : ctl.sortedPosts());
    const isFirst = all[0] && all[0].id === post.id;
    const isLast = all.length && all[all.length - 1].id === post.id;
    move.push({
      label: '맨 앞으로', icon: 'arrow-up', disabled: isFirst || !others.length,
      onClick: () => ctx.run(() => ctl.movePost(post.id, { sectionId: post.sectionId ?? null, beforeId: others[0].id })),
    });
    move.push({
      label: '맨 뒤로', icon: 'arrow-down', disabled: isLast || !others.length,
      onClick: () => ctx.run(() => ctl.movePost(post.id, { sectionId: post.sectionId ?? null, beforeId: null })),
    });
  }
  if (canMove && ctl.sectioned && ctl.state.sections.length > 0) {
    move.push({ label: '섹션으로 이동…', icon: fmt === 'rows' ? 'rows' : 'columns', onClick: () => openSectionPicker(ctx, anchor, post) });
  }

  const share = [{
    label: '링크 복사', icon: 'link',
    onClick: async () => {
      const ok = await copyText(postUrl(ctl.slug, post.id));
      toast(ok ? '링크를 복사했어요' : '복사하지 못했어요. 주소창의 링크를 사용해 주세요.', ok ? 'success' : 'error');
    },
  }];
  const danger = canEdit ? [{ label: '삭제', icon: 'trash', danger: true, onClick: () => confirmDeletePost(ctx, post) }] : [];

  const items = [];
  for (const g of [primary, move, share, danger]) {
    if (!g.length) continue;
    if (items.length) items.push({ separator: true });
    items.push(...g);
  }
  return popover(anchor, items, { minWidth: 190 });
}
