// grid (auto-fill ~256px columns) and stream (single centered column ≤680px): a plain ordered list of cards.
import { h } from '../../lib/h.js';
import { reconcile } from '../util.js';
import { createEmpty } from '../empty.js';

export function createList(ctx, type) {
  const { ctl } = ctx;
  const el = h('div', { class: ['b-list', 'b-' + type] });
  const empty = createEmpty(ctx);
  const items = () => ctl.sortedPosts().map((p) => ({ id: p.id, el: ctx.cards.get(p.id) && ctx.cards.get(p.id).el })).filter((i) => i.el);
  const unzone = ctx.dnd.zone(el, { kind: 'post', axis: type === 'grid' ? 'x' : 'y', items });

  function sync() {
    const posts = ctl.sortedPosts();
    const els = posts.map((p) => ctx.itemFor(p).el);
    ctx.prune(posts);
    empty.update(!posts.length);
    reconcile(el, posts.length ? els : [empty.el]);
  }

  return {
    el,
    sync,
    destroy() {
      unzone();
      el.remove();
    },
  };
}
