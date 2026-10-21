// Zero-dependency headless-Chrome driver over the DevTools protocol (Node ≥ 22 built-in WebSocket).
// Each launch gets its own browser process + temp profile, so parallel users of this helper never interfere.
//
//   import { launchBrowser } from './cdp.mjs';
//   const b = await launchBrowser();                 // { newContext(), close() }
//   const ctx = await b.newContext();                 // isolated cookies/storage (one per simulated user)
//   const page = await ctx.newPage('http://127.0.0.1:3000/');
//   await page.waitFor('.b-card');  await page.click('button[aria-label="공유"]');  await page.screenshot('out.png');
//   await b.close();
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findChrome() {
  return CANDIDATES.find((p) => existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message} (${m.error.code})`)) : resolve(m.result);
      } else if (m.method) {
        for (const fn of this.handlers.get(m.method) || []) fn(m.params, m.sessionId);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
}

export async function launchBrowser({ headless = true, width = 1280, height = 800 } = {}) {
  const exe = findChrome();
  if (!exe) throw new Error('Chrome/Edge not found (set CHROME_PATH)');
  const profile = mkdtempSync(join(tmpdir(), 'edulet-cdp-'));
  const port = await freePort();
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-features=Translate,MediaRouter',
    `--window-size=${width},${height}`, '--lang=ko-KR', '--force-color-profile=srgb', 'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  const proc = spawn(exe, args, { stdio: 'ignore' });
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(100);
    }
  }
  if (!version) {
    proc.kill();
    throw new Error('Chrome did not start');
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new Cdp(ws);

  async function newContext() {
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    return {
      id: browserContextId,
      async newPage(url = 'about:blank', { viewport = { width, height } } = {}) {
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        const page = makePage(cdp, sessionId, targetId, viewport);
        await page.init();
        if (url !== 'about:blank') await page.goto(url);
        return page;
      },
      async close() {
        await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
      },
    };
  }

  async function close() {
    try { ws.close(); } catch { /* ignore */ }
    proc.kill();
    await sleep(300);
    for (let i = 0; i < 5; i++) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
  }
  return { newContext, close, port };
}

function makePage(cdp, sessionId, targetId, viewport) {
  const logs = [];
  const errors = [];
  const send = (m, p) => cdp.send(m, p, sessionId);
  cdp.on('Runtime.consoleAPICalled', (p, sid) => {
    if (sid !== sessionId) return;
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push({ type: p.type, text });
    if (p.type === 'error') errors.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid === sessionId) errors.push('EXCEPTION: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  });
  let loadResolvers = [];
  cdp.on('Page.loadEventFired', (_, sid) => {
    if (sid === sessionId) {
      loadResolvers.forEach((r) => r());
      loadResolvers = [];
    }
  });

  const page = {
    logs, errors, targetId,
    async init() {
      await send('Page.enable');
      await send('Runtime.enable');
      await page.setViewport(viewport.width, viewport.height);
    },
    async setViewport(w, h, mobile = false, scale = 1) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile });
    },
    async goto(url, { timeout = 20000 } = {}) {
      const loaded = new Promise((r) => loadResolvers.push(r));
      await send('Page.navigate', { url });
      await Promise.race([loaded, sleep(timeout)]);
    },
    async reload() {
      const loaded = new Promise((r) => loadResolvers.push(r));
      await send('Page.reload');
      await Promise.race([loaded, sleep(15000)]);
    },
    /** Evaluate an expression (may return a promise). Returns the JSON-serialisable value. */
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    /** Poll until `fn` (selector string or JS expression returning truthy) holds. */
    async waitFor(cond, { timeout = 8000, interval = 80 } = {}) {
      const expr = /^[.#\[a-zA-Z][^()]*$/.test(cond) && !cond.includes('=>') && !cond.includes('document.')
        ? `!!document.querySelector(${JSON.stringify(cond)})` : cond;
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < timeout) {
        try { last = await page.eval(expr); if (last) return last; } catch { /* page navigating */ }
        await sleep(interval);
      }
      throw new Error(`waitFor timed out: ${cond}`);
    },
    async exists(selector) {
      return page.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
    },
    async text(selector) {
      return page.eval(`(document.querySelector(${JSON.stringify(selector)})||{}).innerText ?? null`);
    },
    async count(selector) {
      return page.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    },
    async rect(selector) {
      return page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}})()`);
    },
    /** Real mouse click at the element centre (scrolls it into view first). */
    async click(selector, { button = 'left', clickCount = 1 } = {}) {
      await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e)e.scrollIntoView({block:'center',inline:'center'})})()`);
      const r = await page.rect(selector);
      if (!r) throw new Error('click: not found ' + selector);
      await page.mouse(r.cx, r.cy, { button, clickCount });
    },
    async mouse(x, y, { button = 'left', clickCount = 1 } = {}) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
    },
    /** Real pointer drag (works for pointer-event based drags). */
    async drag(fromX, fromY, toX, toY, steps = 12) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX + ((toX - fromX) * i) / steps, y: fromY + ((toY - fromY) * i) / steps, buttons: 1 });
        await sleep(8);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', clickCount: 1 });
    },
    /** Focus the element and type text (inserts real text, fires input events). */
    async type(selector, text, { clear = false } = {}) {
      await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();${clear ? 'if(e.select)e.select();' : ''}})()`);
      if (clear) await page.key('Backspace');
      await send('Input.insertText', { text });
    },
    async key(key, { modifiers = 0 } = {}) {
      const map = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, ' ': 32, Delete: 46 };
      const code = map[key] ?? key.toUpperCase().charCodeAt(0);
      const base = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
      // Enter and printable keys need a real 'keyDown' carrying `text` (a rawKeyDown does not trigger default actions like form submit).
      const text = key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
      await send('Input.dispatchKeyEvent', text ? { type: 'keyDown', ...base, text, unmodifiedText: text } : { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async screenshot(path, { fullPage = false } = {}) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      return path;
    },
    async setFiles(selector, files) {
      const { root } = await send('DOM.getDocument');
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId, files });
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    },
  };
  return page;
}
