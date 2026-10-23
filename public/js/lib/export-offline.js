// Browser side of the offline HTML export: reads the board's export JSON, fetches the uploaded pictures/files it points at (a few at a
// time), cleans and shrinks pictures, then hands everything to the pure builder (export-html.js) and saves the result as ONE .html file.
// Works the same on the server and in the static demo — only /api/boards/:slug/export and /uploads/… are used, so nothing the
// viewer could not already see is read, and no server code is involved (docs/CONTRACT.md §5).
import { api } from './api.js';
import { withBase } from './base.js';
import {
  buildOfflinePartsAsync, collectUploadRefs, summarizeFiles, offlineFilename, estimateTextBytes, ExportTooLargeError,
  Budget, EXPORT_LIMITS, MB, SKIP_TEXT,
} from './export-html.js';
import { planImage, FALLBACK_MAX } from './image-bytes.js';

const enc = encodeURIComponent;
const MAX_IMAGE_DOWNLOAD = 60 * MB; // a picture is shrunk after download, so it may be bigger than a file limit — but not without end

const aborted = () => new DOMException('취소했어요.', 'AbortError');
export const isAbort = (e) => !!e && e.name === 'AbortError';
const check = (signal) => {
  if (signal && signal.aborted) throw aborted();
};

/**
 * A sentence for the screen. Our own messages and the server's are Korean and shown as they are; anything else (an engine's English
 * exception text) is not shown — the fallback is. Aborts read "취소했어요.".
 */
export function exportErrorText(e, fallback = 'HTML 파일을 만들지 못했어요. 다시 시도해 주세요.') {
  if (isAbort(e)) return '취소했어요.';
  let m = e && typeof e.message === 'string' ? e.message : '';
  if (!/[가-힣]/.test(m)) return fallback;
  const wait = Number(e && e.retryAfter);
  if (wait > 0 && !/\d+\s*초/.test(m)) m += ` (${Math.ceil(wait)}초 뒤에 다시 할 수 있어요)`;
  return m;
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(blob);
  });
}
const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));

// Decoding costs memory in proportion to the picture's pixels (a 40-megapixel photo is a 160 MB bitmap), so ONE picture is decoded at a time
// while the downloads still run three at a time.
let decodeChain = Promise.resolve();
export function decodeSerial(fn) {
  const run = decodeChain.then(() => fn());
  decodeChain = run.catch(() => {});
  return run;
}

/** Draw the picture onto a canvas no larger than `max` px on its long side and encode it (WebP; JPEG/PNG where WebP cannot be written). Rotation is baked in; every kind of metadata is gone. */
function reencode(blob, max, alpha, signal) {
  return decodeSerial(async () => {
    check(signal);
    if (typeof createImageBitmap !== 'function') throw new Error('no createImageBitmap');
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    try {
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const tw = Math.max(1, Math.round(bmp.width * scale));
      const th = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      if (!alpha) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, tw, th);
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, tw, th);
      let out = null;
      for (const type of alpha ? ['image/webp', 'image/png'] : ['image/webp', 'image/jpeg']) {
        const o = await toBlob(canvas, type, 0.86);
        if (o && o.type === type) {
          out = o;
          break;
        }
      }
      canvas.width = canvas.height = 0; // let go of the pixels now
      if (!out) throw new Error('no encoder');
      return { blob: out, width: tw, height: th };
    } finally {
      bmp.close();
    }
  });
}

/**
 * Decide from the file's HEADER what a picture needs (image-bytes.js — before anything is decoded), then do it.
 *   max = 0 → the original bytes (the "원본 크기" option: metadata such as GPS stays in, animations keep moving)
 *   else    → a decompression bomb is skipped; a JPEG/PNG loses its metadata (the location!) either through a canvas or, when no
 *             re-encoding is needed, by cutting the segments out; an animated PNG/WebP becomes a still picture; GIF stays as it is.
 * → { blob, width, height } | { skip: reason }
 */
export async function processImage(blob, max, signal) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const plan = planImage(bytes, { max });
  if (plan.skip) return { skip: plan.skip };
  const { info } = plan;
  // a photo marked "rotated" (EXIF orientation 5–8) is shown with its sides swapped — the page reserves room for that shape
  const turned = info.orientation >= 5 && info.orientation <= 8;
  const [width, height] = turned ? [info.height, info.width] : [info.width, info.height];
  const cleaned = () => ({ blob: plan.clean === bytes ? blob : new Blob([plan.clean], { type: blob.type }), width, height });
  if (plan.original) return { blob, width, height };
  if (!plan.canvas) return cleaned();
  let out = null;
  try {
    out = await reencode(blob, max, info.type === 'png' || info.type === 'webp', signal);
  } catch (e) {
    if (isAbort(e) || (signal && signal.aborted)) throw aborted();
  }
  if (out) {
    const forced = plan.scale < 1 || info.animated || !plan.clean;
    if (!forced && plan.clean.length <= out.blob.size) return cleaned(); // re-encoding did not help: the cleaned original is smaller
    return out;
  }
  // the picture would not decode here: its cleaned bytes go in as they are — small files only, and never a file whose metadata could not be cut out
  if (plan.clean && plan.clean.length <= FALLBACK_MAX) return cleaned();
  return { skip: 'undecodable' };
}

const fetchUpload = (url, signal) => fetch(withBase(url), { signal, credentials: 'same-origin' });

/**
 * Run `worker(item, index)` over `items`, `n` at a time. The worker deals with the failure of ITS file itself (that file is skipped, the rest
 * go on); whatever still escapes it is fatal: no new item is started, the workers in flight are waited for (nothing runs on after we return),
 * then the first error is thrown.
 */
export async function runPool(items, n, worker, signal) {
  let next = 0;
  let fatal = null;
  const run = async () => {
    while (next < items.length && !fatal) {
      try {
        check(signal);
        await worker(items[next], next++);
      } catch (e) {
        if (!fatal) fatal = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  if (fatal) throw fatal;
}

/**
 * Build the offline page of a board.
 *   opts.imageMax      long side of a picture in px; 0 = keep the original files (default EXPORT_LIMITS.imageMax)
 *   opts.includeFiles  also embed attached files such as PDFs (default true; pictures are always embedded)
 *   opts.signal        AbortSignal — rejects with an AbortError
 *   opts.onProgress    ({ phase: 'read'|'files'|'build', label, done, total }) — `label` is a ready Korean sentence, done/total count every file.
 *                      It is never called after the build has finished, failed or been cancelled.
 *   opts.limits        { fileBytes, totalBytes, textBytes } (default EXPORT_LIMITS)
 * → { blob, filename, summary: { posts, comments, images, files, bytes, size, skipped: [{ name, reason }] } }
 * Too much text for one page (ExportTooLargeError) or a cancel make NO file — never a half-finished one.
 */
export async function buildBoardHtml(slug, opts = {}) {
  const { imageMax = EXPORT_LIMITS.imageMax, includeFiles = true, signal, onProgress, limits, now = new Date() } = opts;
  let live = true;
  const say = (p) => {
    if (!live || !onProgress) return;
    try {
      onProgress(p);
    } catch { /* a broken progress callback must not break the export */ }
  };
  try {
    check(signal);
    say({ phase: 'read', label: '보드 내용을 읽는 중…', done: 0, total: 0 });
    const data = await api.get(`/boards/${enc(slug)}/export?format=json`);
    check(signal);

    const lim = { fileBytes: EXPORT_LIMITS.fileBytes, totalBytes: EXPORT_LIMITS.totalBytes, textBytes: EXPORT_LIMITS.textBytes, ...limits };
    // too much text for a page? say so now, before a single picture is fetched
    const est = estimateTextBytes(data);
    if (est > lim.textBytes) throw new ExportTooLargeError(est, lim.textBytes);

    const refs = collectUploadRefs(data);
    const budget = new Budget(lim);
    const files = new Map();
    const isPic = (r) => r.role !== 'file';
    const totals = { pic: refs.filter(isPic).length, file: refs.filter((r) => !isPic(r)).length };
    const done = { pic: 0, file: 0 };
    const skip = (r, reason) => files.set(r.url, { name: r.name, mime: r.mime, size: r.size, dataUrl: null, skipped: reason });

    const embed = async (r) => {
      if (!r.ok) return skip(r, 'failed'); // an /uploads/… address of a shape we do not fetch: reported, not requested
      if (r.role === 'file' && !includeFiles) return skip(r, 'excluded');
      if (r.role === 'file' && r.size != null && r.size > lim.fileBytes) return skip(r, 'too_large'); // known from the card: do not even download it
      if (budget.left <= 0) return skip(r, 'budget');
      const res = await fetchUpload(r.url, signal);
      if (!res.ok) return skip(r, 'failed');
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > (isPic(r) ? MAX_IMAGE_DOWNLOAD : lim.fileBytes)) {
        try { await res.body.cancel(); } catch { /* ignore */ }
        return skip(r, 'too_large');
      }
      let blob = await res.blob();
      check(signal);
      let mime;
      let width;
      let height;
      if (isPic(r)) {
        const max = r.role === 'wallpaper' && imageMax ? Math.min(imageMax, EXPORT_LIMITS.wallpaperMax) : imageMax;
        const p = await processImage(blob, max, signal);
        if (p.skip) return skip(r, p.skip);
        blob = p.blob;
        width = p.width;
        height = p.height;
        mime = blob.type;
      } else {
        mime = (r.mime || blob.type || 'application/octet-stream').toLowerCase();
        blob = new Blob([blob], { type: 'application/octet-stream' }); // never typed as something a browser would render
      }
      const reason = budget.take(blob.size);
      if (reason) return skip(r, reason);
      const dataUrl = await readAsDataUrl(blob);
      check(signal);
      files.set(r.url, { name: r.name, mime, size: blob.size, dataUrl, width, height });
    };

    async function one(r) {
      const kind = isPic(r) ? 'pic' : 'file';
      say({ phase: 'files', kind, done: done.pic + done.file, total: refs.length, label: `${kind === 'pic' ? '그림' : '파일'} ${done[kind] + 1}/${totals[kind]} 담는 중…` });
      try {
        await embed(r);
      } catch (e) {
        if (isAbort(e) || (signal && signal.aborted)) throw aborted();
        skip(r, 'failed'); // this file only: whatever went wrong, the others go on
      } finally {
        done[kind]++;
      }
    }

    await runPool(refs, EXPORT_LIMITS.concurrency, one, signal);
    check(signal);

    say({ phase: 'build', label: '파일을 만드는 중…', done: refs.length, total: refs.length });
    let parts = await buildOfflinePartsAsync({ data, files, now, options: { textBytes: lim.textBytes } }, { signal });
    check(signal);
    const blob = new Blob(parts, { type: 'text/html;charset=utf-8' });
    parts = null;
    const sum = summarizeFiles(files);
    files.clear();
    const posts = Array.isArray(data.posts) ? data.posts : [];
    return {
      blob,
      filename: offlineFilename(slug, now),
      summary: {
        posts: posts.length,
        comments: posts.reduce((n, p) => n + (Array.isArray(p.comments) ? p.comments.length : 0), 0),
        images: sum.images,
        files: sum.files,
        bytes: sum.bytes,
        size: blob.size,
        skipped: sum.skipped.map((s) => ({ name: s.name, reason: s.reason })),
      },
    };
  } finally {
    live = false;
  }
}

/** Save a Blob through a temporary link (works the same in the static demo). */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Build and save. Resolves to the same value as buildBoardHtml. */
export async function exportBoardAsHtml(slug, opts = {}) {
  const r = await buildBoardHtml(slug, opts);
  saveBlob(r.blob, r.filename);
  return r;
}

export function formatSize(n) {
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** Plain-language result of an export (what went in, what did not). → { text, skippedText, big } */
export function describeResult(s) {
  const bits = [`글 ${s.posts}개`, `댓글 ${s.comments}개`];
  if (s.images) bits.push(`그림 ${s.images}개`);
  if (s.files) bits.push(`파일 ${s.files}개`);
  const text = `${bits.join(', ')}를 담았어요. (${formatSize(s.size)})`;
  let skippedText = '';
  if (s.skipped.length) {
    const why = [...new Set(s.skipped.map((x) => SKIP_TEXT[x.reason] || SKIP_TEXT.failed))].join(' / ');
    skippedText = `담지 못한 파일이 ${s.skipped.length}개 있어요 (${why}). 어떤 파일인지는 내려받은 파일 안에 적어 두었어요.`;
  }
  return { text, skippedText, big: s.size > 20 * MB };
}
