// Fractional ranking helpers (CONTRACT §3): mid-point between neighbours, renumber 1..n when the gap collapses.
import { bad } from './http.js';

const MIN_GAP = 1e-6;

/**
 * Decide the rank for `movingId` placed right before `beforeId` (null = end) among `others`
 * (rows {id, rank} sorted by rank, NOT containing the moving item).
 * @returns {{rank: number, order: number[] | null}} when `order` is set the whole list must be
 *   renumbered i+1 in that id order (the moving id included); otherwise just use `rank`.
 */
export function planPlacement(others, beforeId, movingId) {
  if (beforeId == null) {
    return { rank: others.length ? others[others.length - 1].rank + 1 : 1, order: null };
  }
  const idx = others.findIndex((o) => o.id === beforeId);
  if (idx < 0) throw bad('bad_request', '기준 위치를 찾을 수 없어요.');
  const next = others[idx];
  const prev = idx > 0 ? others[idx - 1] : null;
  if (!prev) return { rank: next.rank - 1, order: null };
  if (next.rank - prev.rank < MIN_GAP) {
    const order = others.map((o) => o.id);
    order.splice(idx, 0, movingId);
    return { rank: idx + 1, order };
  }
  return { rank: (prev.rank + next.rank) / 2, order: null };
}

/** Rank for a brand-new item: min-1 (top) / max+1 (bottom) / 1 when the list is empty. */
export function edgeRank(lo, hi, position) {
  if (lo == null || hi == null) return 1;
  return position === 'bottom' ? hi + 1 : lo - 1;
}
