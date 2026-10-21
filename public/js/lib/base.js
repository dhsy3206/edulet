// App base path. "" when the app is served from a domain root (npm start, Docker); "/edulet" on GitHub Pages.
// demo/boot.js (only present in the Pages build) sets window.EDULET_BASE / EDULET_DEMO before the app starts.
const w = typeof window !== 'undefined' ? window : {};

export const BASE = (w.EDULET_BASE ? String(w.EDULET_BASE) : '').replace(/\/+$/, '');
/** True in the static Pages build: the "server" is a service worker and data lives in this browser. */
export const DEMO = !!w.EDULET_DEMO;

const isAppAbsolute = (p) => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//');

/** '/b/x' → '/edulet/b/x' (idempotent; leaves anything that is not an app-absolute path alone). */
export const withBase = (p) => (BASE && isAppAbsolute(p) && p !== BASE && !p.startsWith(BASE + '/') ? BASE + p : p);

/** '/edulet/b/x' → '/b/x'. */
export const stripBase = (p) => (BASE && (p === BASE || p.startsWith(BASE + '/')) ? p.slice(BASE.length) || '/' : p);
