// Board-level actions used from several places (dashboard menu, share panel, settings panel).
import { h } from '../lib/h.js';
import { api } from '../lib/api.js';
import { router } from '../lib/router.js';
import { modal, toast, confirmDialog, copyText } from '../lib/ui.js';
import { exportBoardAsHtml, describeResult, exportErrorText, formatSize, isAbort } from '../lib/export-offline.js';
import { requireLogin } from './auth.js';
import { boardPath, boardUrl } from './common.js';

export async function copyBoardLink(slug) {
  const ok = await copyText(boardUrl(slug));
  if (ok) toast('링크를 복사했어요.', 'success');
  else toast('복사하지 못했어요. 주소를 직접 선택해 복사해 주세요.', 'error');
  return ok;
}

/** POST /boards/:slug/duplicate, then open the copy. Throws ApiError on failure. */
export async function duplicateBoard(slug, withPosts) {
  const r = await api.post(`/boards/${encodeURIComponent(slug)}/duplicate`, { withPosts: !!withPosts });
  toast('내 보드로 복제했어요.', 'success');
  router.go(boardPath(r.board.slug));
  return r.board;
}

/**
 * Save a board as one offline .html file with the default options (pictures shrunk to 1600 px, attachments included) — for menus
 * without a settings dialog. Progress is a toast. One export per board at a time.
 */
const exporting = new Set();
export async function exportBoardHtmlFlow(board) {
  if (exporting.has(board.slug)) return toast('이 보드는 지금 내보내는 중이에요.', 'info');
  exporting.add(board.slug);
  const progress = toast(`“${board.title}” HTML 파일을 만드는 중…`, 'info', 10 * 60 * 1000);
  try {
    const r = await exportBoardAsHtml(board.slug, { onProgress: (p) => progress.update(p.label) });
    const d = describeResult(r.summary);
    toast(`HTML 파일을 내려받았어요 (${formatSize(r.summary.size)}). ${d.skippedText}`.trim(), r.summary.skipped.length ? 'info' : 'success', r.summary.skipped.length ? 8000 : 3500);
  } catch (e) {
    if (!isAbort(e)) toast(exportErrorText(e), 'error', 6000);
  } finally {
    progress();
    exporting.delete(board.slug);
  }
}

/** Ask whether to copy posts too, then duplicate (login required). */
export async function duplicateBoardFlow(board) {
  const user = await requireLogin({ message: '보드를 복제하려면 로그인이 필요해요.' });
  if (!user) return;
  const withPosts = h('input', { type: 'checkbox', name: 'withPosts', checked: true });
  modal({
    title: '내 보드로 복제', size: 'sm',
    body: h('div', null,
      h('p', { class: 'modal-text' }, `“${board.title}” 보드를 내 보드로 복사해요.`),
      h('label', { class: 'checkbox' }, withPosts, h('span', null, '글도 함께 복사'))),
    actions: [
      { label: '취소', kind: 'secondary' },
      { label: '복제하기', kind: 'primary', onClick: () => duplicateBoard(board.slug, withPosts.checked) },
    ],
  });
}

/** Confirm + DELETE. Resolves true when the board is gone. */
export async function deleteBoardFlow(board) {
  const ok = await confirmDialog({
    title: '보드를 삭제할까요?',
    message: `“${board.title}” 보드와 안에 있는 글·댓글·파일이 모두 사라지고, 되돌릴 수 없어요.`,
    confirmLabel: '삭제', danger: true,
  });
  if (!ok) return false;
  await api.del(`/boards/${encodeURIComponent(board.slug)}`);
  toast('보드를 삭제했어요.', 'success');
  return true;
}

/**
 * A member (not the owner) leaves a board: confirm, then DELETE /boards/:slug/members/:myId.
 * Resolves true when the user is no longer a member. Server refusals (owner_cannot_leave, rate_limited …) throw ApiError.
 */
export async function leaveBoardFlow(board, myUserId) {
  const ok = await confirmDialog({
    title: '보드에서 나갈까요?',
    message: `“${board.title}” 보드의 구성원에서 빠져요. 이 보드가 비공개라면 다시 초대받기 전에는 열 수 없어요.`,
    confirmLabel: '나가기', danger: true,
  });
  if (!ok) return false;
  await api.del(`/boards/${encodeURIComponent(board.slug)}/members/${encodeURIComponent(myUserId)}`);
  toast('보드에서 나갔어요.', 'success');
  return true;
}
