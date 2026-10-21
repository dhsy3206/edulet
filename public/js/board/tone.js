// Colour helpers shared by the board shell and the board canvas (contrast maths, wallpaper tone, avatar initials).
// Pure browser code, no dependencies.

/* ───────── WCAG maths ───────── */
const lin = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** Relative luminance of [r,g,b] (0-255). */
export const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** "#rgb", "#rrggbb", "rgb(r, g, b)" or "rgba(…)" → [r,g,b], or null. */
export function parseColor(str) {
  const s = String(str || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

const INK = '#0f172a';
/** Dark ink or white — whichever reads better on `bg` ([r,g,b]). */
export function readableOn(bg) {
  return contrast(bg, [255, 255, 255]) >= contrast(bg, [15, 23, 42]) ? '#ffffff' : INK;
}

/* ───────── avatar initials (UX-15) ─────────
   The avatar colours come from a server palette of pastels, so white initials fail 4.5:1. ui.js builds the avatar
   and cannot know that, so every `.avatar` that enters the page gets the better of white / dark ink here. */
function fixAvatar(el) {
  const bg = parseColor(el.style.backgroundColor || el.style.background);
  if (!bg) return;
  const ink = readableOn(bg);
  if (el.style.color !== ink) el.style.color = ink;
}
let avatarObserver = null;
export function installAvatarContrast() {
  if (avatarObserver || typeof MutationObserver === 'undefined') return;
  document.querySelectorAll('.avatar').forEach(fixAvatar);
  avatarObserver = new MutationObserver((records) => {
    for (const rec of records) {
      for (const n of rec.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList.contains('avatar')) fixAvatar(n);
        else if (n.firstElementChild) n.querySelectorAll('.avatar').forEach(fixAvatar);
      }
    }
  });
  avatarObserver.observe(document.body, { childList: true, subtree: true });
}

/* ───────── wallpaper tone (UX-06) ─────────
   A custom wallpaper can be anything. Look at the band of the image that sits behind the board header and decide
   whether the chrome should be light-on-dark or dark-on-light. Any failure falls back to 'dark' (white text + scrim). */
const toneCache = new Map(); // url → 'light' | 'dark'
const toneJobs = new Map();
const LIGHT_ABOVE = 0.32; // mean relative luminance of the header band above which the image counts as light

export const cachedTone = (url) => toneCache.get(url) || null;

export function loadTone(url) {
  if (toneCache.has(url)) return Promise.resolve(toneCache.get(url));
  if (toneJobs.has(url)) return toneJobs.get(url);
  const job = new Promise((resolve) => {
    const done = (tone) => {
      toneCache.set(url, tone);
      toneJobs.delete(url);
      resolve(tone);
    };
    try {
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous'; // /uploads is same-origin; this also keeps a CORS-enabled remote image untainted
      img.onload = () => {
        try {
          const W = 48;
          const Hh = 48;
          const cv = document.createElement('canvas');
          cv.width = W;
          cv.height = Hh;
          const g = cv.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, W, Hh); // downscaled copy: cheap and an average by construction
          const data = g.getImageData(0, 0, W, Math.ceil(Hh * 0.45)).data; // top 45%: the header band
          let sum = 0;
          let n = 0;
          for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3] / 255;
            // transparent pixels show the #334155 fallback colour behind the image
            const r = data[i] * a + 0x33 * (1 - a);
            const gg = data[i + 1] * a + 0x41 * (1 - a);
            const b = data[i + 2] * a + 0x55 * (1 - a);
            sum += luminance([r, gg, b]);
            n++;
          }
          done(n && sum / n > LIGHT_ABOVE ? 'light' : 'dark');
        } catch {
          done('dark'); // tainted canvas or a decode problem
        }
      };
      img.onerror = () => done('dark');
      img.src = url;
    } catch {
      done('dark');
    }
  });
  toneJobs.set(url, job);
  return job;
}
