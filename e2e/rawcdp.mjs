// A second DevTools connection to a browser that tools/cdp.mjs launched (same port), for the things the page helper does not
// expose: browser-level commands (downloads), and per-tab event streams (network, console, CSP violations).
//
//   const raw = await connectBrowser(browser.port);
//   await raw.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, browserContextId: ctx.id, eventsEnabled: true });
//   const tab = await raw.attach(page.targetId);          // { send(method, params), on(method, fn), events(method) }
//   await tab.send('Network.enable');
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connectBrowser(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const handlers = new Map(); // `${sessionId}|${method}` → fn[]
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`)); else p.resolve(m.result);
    } else if (m.method) {
      for (const fn of handlers.get(`${m.sessionId || ''}|${m.method}`) || []) fn(m.params);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  const on = (method, fn, sessionId = '') => {
    const k = `${sessionId}|${method}`;
    if (!handlers.has(k)) handlers.set(k, []);
    handlers.get(k).push(fn);
  };
  return {
    send,
    on: (method, fn) => on(method, fn),
    /** Attach to a tab (page.targetId) and get its own send/on. Events are collected from this moment on. */
    async attach(targetId) {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      return {
        sessionId,
        send: (method, params) => send(method, params, sessionId),
        on: (method, fn) => on(method, fn, sessionId),
      };
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * Let a browser context save downloads into `dir` and wait for the next one to finish.
 *   const dl = await watchDownloads(raw, ctx.id, dir);   const file = await dl.next(() => page.click(...));
 * → { path, name, bytes } (the finished file; Chrome writes `<name>.crdownload` while it works).
 */
export async function watchDownloads(raw, browserContextId, dir) {
  const begun = [];
  const done = new Map();
  raw.on('Browser.downloadWillBegin', (p) => begun.push(p));
  raw.on('Browser.downloadProgress', (p) => { if (p.state !== 'inProgress') done.set(p.guid, p.state); });
  await raw.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, browserContextId, eventsEnabled: true });
  return {
    begun,
    /** Run `trigger` (which starts a download) and resolve once it is saved; rejects after `timeout` ms. */
    async next(trigger, { timeout = 30000 } = {}) {
      const before = begun.length;
      const had = new Map(readdirSync(dir).map((n) => [n, statSync(join(dir, n)).mtimeMs])); // a repeated name may overwrite the old file, so changed files count too
      await trigger();
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (begun.length > before) {
          const b = begun[begun.length - 1];
          const state = done.get(b.guid);
          if (state === 'canceled') throw new Error('download canceled: ' + b.suggestedFilename);
          if (state === 'completed') {
            // the file that appeared or was rewritten
            let name = null;
            for (let i = 0; i < 40 && !name; i++) {
              name = readdirSync(dir).find((n) => !n.endsWith('.crdownload') && (!had.has(n) || statSync(join(dir, n)).mtimeMs > had.get(n))) || null;
              if (!name) await sleep(50);
            }
            if (!name) throw new Error('download finished but no new file in ' + dir + ' (had: ' + [...had.keys()].join(',') + '; now: ' + readdirSync(dir).join(',') + '; suggested: ' + b.suggestedFilename + ')');
            const path = join(dir, name);
            return { path, name, suggested: b.suggestedFilename, bytes: statSync(path).size, url: b.url };
          }
        }
        await sleep(60);
      }
      throw new Error('no download finished within ' + timeout + ' ms (saw ' + begun.length + ', files: ' + readdirSync(dir).join(',') + ')');
    },
  };
}
