/* Edulet DEMO MODE — this service worker is the server.
 *
 * GitHub Pages only serves files, so for https://<user>.github.io/edulet/ the frontend (public/js/**, unchanged) talks to this
 * worker instead of the Node server: it answers <scope>api/** and <scope>uploads/**, keeps all data in the visitor's own
 * browser (IndexedDB) and pushes realtime events to the open tabs through BroadcastChannel. Nothing leaves the browser.
 *
 *   demo/sw-core.js     constants, errors, validation, ranks, PBKDF2        (server/{constants,util,http,rank}.js)
 *   demo/sw-store.js    IndexedDB state document + blob store + queries      (server/db.js)
 *   demo/sw-views.js    JSON serializers, access rules                       (server/{views,access}.js)
 *   demo/sw-hub.js      streams, presence, per-stream event shaping          (server/realtime.js)
 *   demo/sw-preview.js  link previews (host-only + video embeds)             (server/preview.js)
 *   demo/sw-http.js     router, request context, /api pipeline               (server/{http,index}.js)
 *   demo/sw-files.js    uploads, upload lifetime, /uploads serving           (server/uploads.js)
 *   demo/sw-auth.js / sw-boards.js / sw-posts.js   the REST routes           (server/{auth,boards,sections,posts,comments,reactions}.js)
 *   demo/sw-seed.js     first-start seed boards from <scope>seed/*.json      (server/seed.js)
 *
 * Page side (EventSource shim, demo badge, boot): demo/boot.js. The worker may be killed at any time: state is loaded from
 * IndexedDB on every start and saved before every mutating request is answered; only stream registrations live in memory and
 * the page re-registers them when a ping says `known:false`. */
'use strict';

importScripts(
  'demo/sw-core.js', 'demo/sw-store.js', 'demo/sw-views.js', 'demo/sw-hub.js', 'demo/sw-preview.js', 'demo/sw-http.js',
  'demo/sw-files.js', 'demo/sw-auth.js', 'demo/sw-boards.js', 'demo/sw-posts.js', 'demo/sw-seed.js',
);

const E = self.EDU;
const SCOPE_PATH = new URL(self.registration.scope).pathname; // "/edulet/"

/* ───────── start-up: load state (and seed on the very first start); never rejects ───────── */
async function init() {
  try {
    await E.db.load();
    if (!E.db.state.seeded) {
      try {
        await E.seedAll();
        await E.db.save();
      } catch (e) {
        console.warn('[edulet-demo] seeding failed (retried on the next start)', e);
      }
    }
    const gone = E.gcUploads() + (await E.db.pruneBlobs().catch(() => 0));
    if (gone > 0) await E.db.save();
  } catch (e) {
    console.error('[edulet-demo] start-up failed', e);
  }
}
let ready = init();

/** Wipe IndexedDB, seed again, tell every tab to reload. */
async function resetDemo() {
  const job = (async () => {
    await ready;
    E.hub.reset();
    await E.db.reset();
    try { await E.seedAll(); } catch (e) { console.warn('[edulet-demo] seeding failed', e); }
    await E.db.save();
  })();
  ready = job.catch(() => {}); // requests arriving meanwhile wait for the new state
  await job;
  E.hub.broadcastReset();
}

/* ───────── demo-only routes (the EventSource shim and the badge dialog use them) ───────── */
const { bad } = E;
E.router.add('POST', '/_demo/stream', async (c) => {
  c.volatile = true; // stream registrations live in memory only
  const b = await c.body();
  const sid = typeof b.sid === 'string' && /^[\w.-]{8,64}$/.test(b.sid) ? b.sid : null;
  if (!sid) throw bad('bad_request', 'sid 가 필요해요.');
  const { board, role } = E.needBoard(c, b.slug, 'read'); // 404 when the board is not viewable (the shim then reports an error)
  return { hello: E.hub.register({ sid, board, acc: { role }, userId: c.user?.id ?? null, tokenHash: c.tokenHash }) };
});
E.router.add('POST', '/_demo/stream/ping', async (c) => {
  c.volatile = true;
  const b = await c.body();
  return E.hub.ping(String(b.sid));
});
E.router.add('POST', '/_demo/stream/close', async (c) => { // sendBeacon: sid in the query, no body
  c.volatile = true;
  E.hub.drop(String(c.query.sid));
  return { ok: true };
});
E.router.add('POST', '/_demo/reset', async (c) => {
  await resetDemo();
  c.sessionHeader = ''; // the old session token is gone with the data
  return { ok: true };
});
E.router.add('GET', '/_demo/status', async () => ({
  demo: true, persistent: E.db.persistent, streams: E.hub.count(), boards: Object.keys(E.db.state.boards).length,
}));

/* ───────── lifecycle ───────── */
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(Promise.all([self.clients.claim(), ready])));

/* ───────── fetch: only <scope>api/** and <scope>uploads/** of our own origin; everything else is untouched ───────── */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  const rel = url.pathname.slice(SCOPE_PATH.length - 1); // "/api/…" | "/uploads/…" | other
  if (rel === '/api' || rel.startsWith('/api/')) {
    event.respondWith(respond(() => E.http.handleApi(req, url, rel.slice(4) || '/')));
  } else if (rel.startsWith('/uploads/')) {
    event.respondWith(respond(() => E.serveUpload(req, rel)));
  }
});

async function respond(run) {
  try {
    await ready;
    E.hub.reap(); // streams that stopped pinging are dropped lazily on every request
    return await run();
  } catch (err) {
    return E.http.errorResponse(err);
  }
}
