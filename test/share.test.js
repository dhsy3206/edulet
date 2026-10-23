// GET /config -> share { origin, lan } (CONTRACT §5). Hermetic: the machine's NICs are always injected (createApp({ networkInterfaces })),
// and the server listens on 127.0.0.1 — config.host is switched in memory to stand for "0.0.0.0" so nothing binds a real network address.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { announce } from '../server/index.js';
import { isLoopbackHostHeader, isLoopbackIp, lanOrigins, shareInfo, startupLanLine } from '../server/share.js';
import { startApp } from './helpers.js';

const nic = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', cidr: null, mac: '00:00:00:00:00:00', ...extra });
const v6 = (address) => ({ address, family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', cidr: null, mac: '00:00:00:00:00:00', scopeid: 0 });

/** A typical teacher PC: Wi-Fi, a wired port, WSL, VirtualBox, loopback and junk that must be filtered out. */
const TYPICAL = () => ({
  'Loopback Pseudo-Interface 1': [nic('127.0.0.1', { internal: true }), v6('::1')],
  'Wi-Fi': [v6('fe80::1234'), nic('192.168.0.12')],
  Ethernet: [nic('10.0.0.5'), nic('169.254.7.7')],
  'vEthernet (WSL)': [nic('172.20.0.1')],
  'VirtualBox Host-Only Network': [nic('192.168.56.1')],
});

let running;
let nics;
/** A request as the server sees it; a key that is present (even as undefined/null) is taken as given, a missing one defaults to "from this PC". */
const fakeReq = (o = {}) => {
  const host = 'host' in o ? o.host : 'localhost:3000';
  return {
    headers: host === null ? { ...o.headers } : { host, ...o.headers },
    socket: { remoteAddress: 'remote' in o ? o.remote : '127.0.0.1', localPort: 'port' in o ? o.port : 3000 },
  };
};

/** GET /api/config on the test server with a Host header of our choosing (fetch() does not let you set one). */
function getConfig({ host, headers = {} } = {}) {
  const h = { host: host ?? `localhost:${running.port}`, ...headers };
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: running.port, path: '/api/config', headers: h }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
    }).on('error', reject);
  });
}

describe('GET /config share', () => {
  before(async () => { running = await startApp({ networkInterfaces: () => nics }); });
  after(async () => { await running.close(); });
  beforeEach(() => {
    nics = TYPICAL();
    // config.port is a decoy: after listen(0) it still says 0 (or whatever was asked for) — the socket port is the truth
    Object.assign(running.app.config, { host: '0.0.0.0', publicUrl: '', trustProxy: false, port: 3000 });
  });

  it('adds share { origin, lan } and leaves the other /config fields alone', async () => {
    const r = await getConfig();
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['allowRegister', 'backup', 'google', 'googleDomains', 'linkPreview', 'maxUploadMb', 'share', 'version']);
    assert.equal(r.json.allowRegister, true);
    assert.equal(r.json.maxUploadMb, 20);
    assert.equal(r.json.linkPreview, true);
    assert.equal(r.json.google, false);
    assert.deepEqual(r.json.googleDomains, []);
    assert.equal(typeof r.json.version, 'string');
    assert.deepEqual(Object.keys(r.json.share).sort(), ['lan', 'origin']);
    assert.equal(r.json.share.origin, null);
  });

  it('a localhost request on an all-interfaces server gets the LAN addresses, sorted, with the port of the socket it came in on', async () => {
    assert.notEqual(running.port, 3000, 'the decoy config.port must differ from the real one');
    const { json } = await getConfig();
    const p = running.port;
    assert.deepEqual(json.share.lan, [`http://192.168.0.12:${p}`, `http://10.0.0.5:${p}`, `http://192.168.56.1:${p}`, `http://172.20.0.1:${p}`]);
  });

  it('127.x and [::1] hosts count as localhost too (any case, with or without a port)', async () => {
    const p = running.port;
    for (const host of [`127.0.0.1:${p}`, '127.0.0.1', `127.5.6.7:${p}`, `[::1]:${p}`, '[::1]', `LocalHost:${p}`, 'LOCALHOST']) {
      assert.equal((await getConfig({ host })).json.share.lan.length, 4, host);
    }
  });

  it('condition 1: a public URL wins — origin is it, lan is empty', async () => {
    running.app.config.publicUrl = 'https://edulet.example.com';
    const { json } = await getConfig();
    assert.deepEqual(json.share, { origin: 'https://edulet.example.com', lan: [] });
  });

  it('a PUBLIC_URL that names this PC (localhost, 127.x, [::1]) is no public address: origin stays null and the LAN list still works', async () => {
    for (const publicUrl of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://localhost']) {
      running.app.config.publicUrl = publicUrl;
      const { json } = await getConfig();
      assert.equal(json.share.origin, null, publicUrl);
      assert.equal(json.share.lan.length, 4, publicUrl);
    }
    // ... while a real public host, even one that merely starts like localhost, keeps winning
    for (const publicUrl of ['https://edulet.example.com', 'http://localhost.example.com:3000', 'http://192.168.0.12:3000']) {
      running.app.config.publicUrl = publicUrl;
      assert.deepEqual((await getConfig()).json.share, { origin: publicUrl, lan: [] }, publicUrl);
    }
  });

  it('PUBLIC_URL really flows from the config loader (not just the in-memory switch)', async () => {
    const app = await startApp({ config: { publicUrl: 'https://edulet.example.com' }, networkInterfaces: () => TYPICAL() });
    try {
      app.app.config.host = '0.0.0.0';
      const r = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: app.port, path: '/api/config', headers: { host: `localhost:${app.port}` } }, (res) => {
          let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
        }).on('error', reject);
      });
      assert.deepEqual(r.share, { origin: 'https://edulet.example.com', lan: [] });
    } finally { await app.close(); }
  });

  it('condition 2: a loopback-only server tells nobody a LAN address', async () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.2', 'LOCALHOST']) {
      running.app.config.host = host;
      assert.deepEqual((await getConfig()).json.share.lan, [], host);
    }
    for (const host of ['0.0.0.0', '::']) {
      running.app.config.host = host;
      assert.equal((await getConfig()).json.share.lan.length, 4, host);
    }
  });

  it('condition 3: only a Host header naming localhost qualifies (other devices, domains, look-alikes get nothing)', async () => {
    const p = running.port;
    const hosts = [
      `192.168.0.12:${p}`, '10.0.0.5', 'edulet.example.com', `edulet.example.com:${p}`, 'localhost.evil.com', '127.0.0.1.evil.com',
      'evil.com:80', `0.0.0.0:${p}`, 'localhost:99999999', 'localhost@evil.com', '127.0.0.1:80@evil.com', 'xlocalhost', 'localhost:', '[::1]x', '[::2]',
      '128.0.0.1', '127.0.0.256', '127.0.0', '1270.0.0.1',
    ];
    for (const host of hosts) {
      const r = await getConfig({ host });
      assert.equal(r.status, 200, host);
      assert.deepEqual(r.json.share.lan, [], `Host: ${host}`);
    }
  });

  it('condition 3 + 4: a spoofed "Host: localhost" from outside learns nothing (the client address is not loopback)', () => {
    for (const remote of ['192.168.0.50', '10.0.0.9', '203.0.113.7', '::ffff:192.168.0.50', '2001:db8::1', 'unknown', '', undefined]) {
      assert.deepEqual(shareInfo(running.app, fakeReq({ host: 'localhost:3000', remote })).lan, [], String(remote));
    }
    // and the same request from this PC is answered, in every spelling of "this PC"
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.5', '::FFFF:127.0.0.1']) {
      assert.equal(shareInfo(running.app, fakeReq({ remote })).lan.length, 4, remote);
    }
  });

  it('condition 4 with TRUST_PROXY: a forwarded address that is not loopback hides the list, and so does any proxy header', async () => {
    const p = running.port;
    const lan = async (headers) => (await getConfig({ headers })).json.share.lan;
    for (const trustProxy of [false, true]) {
      running.app.config.trustProxy = trustProxy;
      // TRUST_PROXY=1 is the operator's statement "a proxy sits in front": nobody is then known to sit at the screen (CONTRACT §5)
      assert.equal((await lan({})).length, trustProxy ? 0 : 4, `no proxy headers, trustProxy=${trustProxy}`);
      const proxied = [
        { 'x-forwarded-for': '203.0.113.9' },
        { 'x-forwarded-for': '127.0.0.1' }, // a "loopback" claim is no proof either
        { 'x-forwarded-for': '' },
        { 'x-forwarded-host': 'edulet.example.com' },
        { 'x-forwarded-proto': 'https' },
        { 'x-forwarded-port': '443' },
        { forwarded: 'for=203.0.113.9;proto=https' },
        { 'x-real-ip': '203.0.113.9' },
        { 'cf-connecting-ip': '203.0.113.9' },
        { 'true-client-ip': '203.0.113.9' },
        { 'x-client-ip': '203.0.113.9' },
        { 'x-cluster-client-ip': '203.0.113.9' },
        { 'fastly-client-ip': '203.0.113.9' },
        { 'x-azure-clientip': '203.0.113.9' },
        { 'x-original-forwarded-for': '203.0.113.9' },
        { via: '1.1 proxy.example' },
        { 'client-ip': '203.0.113.9' },
        { 'x-originating-ip': '203.0.113.9' },
        { 'fly-client-ip': '203.0.113.9' },
        { 'x-envoy-external-address': '203.0.113.9' },
        { 'cf-ray': 'abc' },
        { 'x-amzn-trace-id': 'Root=1-abc' },
        { 'x-appengine-user-ip': '203.0.113.9' },
        { 'x-vercel-forwarded-for': '203.0.113.9' },
        { 'x-cluster-client-ip': '203.0.113.9' },
        { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': `localhost:${p}` },
      ];
      for (const headers of proxied) assert.deepEqual(await lan(headers), [], `trustProxy=${trustProxy} ${JSON.stringify(headers)}`);
    }
  });

  it('condition 4 on its own: the client address is the socket peer — and with TRUST_PROXY nobody is known to sit at the screen', () => {
    running.app.config.trustProxy = false;
    assert.deepEqual(shareInfo(running.app, fakeReq({ remote: '192.168.0.50' })).lan, []);
    assert.equal(shareInfo(running.app, fakeReq({ remote: '127.0.0.1' })).lan.length, 4);
    // a LAN device on the socket: still no
    assert.deepEqual(shareInfo(running.app, fakeReq({ remote: '10.0.0.77' })).lan, []);
    // TRUST_PROXY=1: the peer is the proxy (it may run on this very PC and relay a stranger as 127.0.0.1) — even a loopback peer gets nothing
    running.app.config.trustProxy = true;
    for (const remote of ['127.0.0.1', '::1', '192.168.0.50']) assert.deepEqual(shareInfo(running.app, fakeReq({ remote })).lan, [], `trustProxy, peer ${remote}`);
  });

  it('a request without a Host header, or without a usable socket port, gets nothing', () => {
    assert.deepEqual(shareInfo(running.app, fakeReq({ host: null })).lan, []);
    for (const port of [0, undefined, null, NaN, 70000, -1, '3000']) {
      assert.deepEqual(shareInfo(running.app, fakeReq({ port })).lan, [], String(port));
    }
    assert.deepEqual(shareInfo(running.app, fakeReq({ port: 4321 })).lan.slice(0, 1), ['http://192.168.0.12:4321'], 'the port is the socket port');
  });

  it('origin is the configured public URL (or null), whatever the other conditions say', () => {
    assert.equal(shareInfo(running.app, fakeReq({ remote: '8.8.8.8' })).origin, null);
    running.app.config.publicUrl = 'https://edulet.example.com';
    assert.equal(shareInfo(running.app, fakeReq({ remote: '8.8.8.8' })).origin, 'https://edulet.example.com');
    running.app.config.host = '127.0.0.1';
    assert.equal(shareInfo(running.app, fakeReq()).origin, 'https://edulet.example.com');
  });
});

describe('share: which NIC addresses are listed', () => {
  const app = (nicsFn, host = '0.0.0.0') => ({ config: { host }, networkInterfaces: nicsFn });
  const ips = (a, port = 3000) => lanOrigins(a, port).map((u) => u.replace(/^http:\/\//, '').replace(`:${port}`, ''));

  it('takes IPv4 only, skipping internal, link-local (169.254), loopback, multicast and junk', () => {
    const a = app(() => ({
      lo: [nic('127.0.0.1', { internal: true }), nic('127.0.0.9'), v6('::1')],
      a: [v6('fe80::1'), v6('2001:db8::5'), nic('169.254.1.1'), nic('169.254.255.254'), nic('224.0.0.1'), nic('0.0.0.0'), nic('255.255.255.255')],
      b: [nic('999.1.1.1'), nic('1.2.3'), nic(''), nic('192.168.001.5'), nic('192.168.1.5', { internal: true }), nic('192.168.1.6', { family: 6 }), null, undefined],
      c: [nic('192.168.1.7'), nic('192.168.1.8', { family: 4 })], // old Node reported the family as a number
      d: 'not a list', e: null,
    }));
    assert.deepEqual(ips(a), ['192.168.1.7', '192.168.1.8']);
  });

  it('orders 192.168/16, then 10/8, then 172.16/12, then the rest; the OS order breaks ties; virtual adapters come last', () => {
    const a = app(() => ({
      Public: [nic('203.0.113.9')],
      Hotspot: [nic('100.64.1.1')],
      Lab: [nic('172.31.0.4'), nic('172.15.0.4')],
      'Lan 10': [nic('10.1.1.1')],
      'Wi-Fi': [nic('192.168.0.9')],
      'Second Wi-Fi': [nic('192.168.5.9')],
      'vEthernet (Default Switch)': [nic('192.168.200.1')],
    }));
    assert.deepEqual(ips(a), ['192.168.0.9', '192.168.5.9', '10.1.1.1', '172.31.0.4'], 'the best four of eight, in order');
  });

  it('band by band (three at a time, under the four-address cap), with the virtual adapters after the real ones', () => {
    const mk = (map) => ips(app(() => map));
    assert.deepEqual(mk({ x: [nic('172.20.0.2')], y: [nic('10.0.0.2')], z: [nic('192.168.9.2')] }), ['192.168.9.2', '10.0.0.2', '172.20.0.2']);
    assert.deepEqual(mk({ x: [nic('8.8.4.4')], y: [nic('172.32.0.2')], z: [nic('172.31.0.2')] }), ['172.31.0.2', '8.8.4.4', '172.32.0.2'], '172.32 is not private');
    for (const virtualName of ['vEthernet (WSL)', 'VirtualBox Host-Only Network', 'VMware Network Adapter VMnet8', 'Hyper-V Virtual Ethernet', 'docker0', 'virbr0', 'Tailscale', 'ZeroTier One', 'Bluetooth Network Connection']) {
      assert.deepEqual(mk({ [virtualName]: [nic('192.168.56.1')], 'Wi-Fi': [nic('172.18.0.3')] }), ['172.18.0.3', '192.168.56.1'], virtualName);
    }
    assert.deepEqual(mk({ Ethernet: [nic('192.168.0.2')], 'Wi-Fi': [nic('192.168.0.3')] }), ['192.168.0.2', '192.168.0.3'], 'stable order inside a band');
  });

  it('de-duplicates and keeps at most four', () => {
    const dup = app(() => ({ a: [nic('192.168.0.5')], b: [nic('192.168.0.5')], c: [nic('192.168.0.5'), nic('10.0.0.1')] }));
    assert.deepEqual(ips(dup), ['192.168.0.5', '10.0.0.1']);
    const many = app(() => ({ a: [1, 2, 3, 4, 5, 6].map((i) => nic(`192.168.${i}.1`)) }));
    assert.deepEqual(ips(many), ['192.168.1.1', '192.168.2.1', '192.168.3.1', '192.168.4.1']);
    assert.equal(lanOrigins(many, 8080)[0], 'http://192.168.1.1:8080', 'no trailing slash, the port is part of it');
  });

  it('a NIC lookup that throws or returns nonsense gives an empty list, not a 500', () => {
    assert.deepEqual(lanOrigins(app(() => { throw new Error('uv_interface_addresses returned an error'); }), 3000), []);
    for (const bad of [undefined, null, 'x', 42]) assert.deepEqual(lanOrigins(app(() => bad), 3000), [], String(bad));
  });

  it('config.host as one specific IPv4 address lists only that address (the server answers nowhere else)', () => {
    const a = (host) => app(TYPICAL, host);
    assert.deepEqual(ips(a('10.0.0.5')), ['10.0.0.5']);
    assert.deepEqual(ips(a('192.168.56.1')), ['192.168.56.1']);
    assert.deepEqual(ips(a('10.9.9.9')), [], 'not an address of this machine');
    assert.deepEqual(ips(a('169.254.7.7')), [], 'link-local stays out even when asked for');
    assert.deepEqual(ips(a('my-pc.local')), [], 'a hostname: we cannot tell which NIC, so nothing');
    assert.deepEqual(ips(a('fe80::1234')), [], 'an IPv6 address: nothing');
    assert.equal(ips(a('::')).length, 4);
    assert.equal(ips(a('0.0.0.0')).length, 4);
  });

  it('isLoopbackIp / isLoopbackHostHeader are strict', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.9']) assert.equal(isLoopbackIp(ip), true, ip);
    for (const ip of ['', undefined, null, 'unknown', '128.0.0.1', '10.0.0.1', '::', '::2', '::ffff:10.0.0.1', '127.0.0', '127.0.0.256', '127.0.0.1.5', ' 8.8.8.8']) assert.equal(isLoopbackIp(ip), false, String(ip));
    for (const h of ['localhost', 'localhost:3000', 'LOCALHOST:80', '127.0.0.1:3000', '[::1]', '[::1]:3000']) assert.equal(isLoopbackHostHeader(h), true, h);
    for (const h of ['', undefined, 'localhost.', 'sub.localhost', '0.0.0.0', '::1', '[::1', 'localhost:abc', '127.0.0.1:123456', 'localhost:3000/', 'a localhost', 'localhost\\.evil.com']) assert.equal(isLoopbackHostHeader(h), false, String(h));
  });
});

describe('share: the server-window hint', () => {
  let r;
  before(async () => { r = await startApp({ networkInterfaces: TYPICAL, quiet: false }); });
  after(async () => { await r.close(); });

  it('names the LAN addresses after the local address line, only when the server is reachable beyond this PC', () => {
    r.app.config.host = '0.0.0.0';
    const lines = [];
    announce(r, (l) => lines.push(l));
    assert.match(lines[0], /^Edulet is running at http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(lines[1], `같은 네트워크의 다른 기기에서는: http://192.168.0.12:${r.port} 또는 http://10.0.0.5:${r.port} 또는 http://192.168.56.1:${r.port} 또는 http://172.20.0.1:${r.port}`);
    assert.equal(lines.length, 2, 'no seed board in this app');

    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      r.app.config.host = host;
      const quiet = [];
      announce(r, (l) => quiet.push(l));
      assert.equal(quiet.length, 1, `host ${host}: only the local address`);
      assert.equal(startupLanLine(r.app, r.port), null, host);
    }
  });

  it('prints nothing extra when there is no LAN address, when quiet, or when the host is a name', () => {
    r.app.config.host = '0.0.0.0';
    const none = { config: r.app.config, quiet: false, networkInterfaces: () => ({ lo: [nic('127.0.0.1', { internal: true })] }) };
    assert.equal(startupLanLine(none, 3000), null);
    assert.equal(startupLanLine({ ...r.app, quiet: true }, 3000), null);
    assert.equal(startupLanLine({ ...r.app, config: { ...r.app.config, host: 'my-pc.local' } }, 3000), null);
    assert.match(startupLanLine(r.app, 3000), /^같은 네트워크의 다른 기기에서는: http:\/\/192\.168\.0\.12:3000 /);
  });
});

describe('share: npm start wiring', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Preload for the child process: fake NICs, and whatever address the server is told to bind, the socket stays on 127.0.0.1.
  const PRELOAD = `import os from 'node:os';
import http from 'node:http';
os.networkInterfaces = () => ({ 'Wi-Fi': [{ address: '192.168.0.12', family: 'IPv4', internal: false }] });
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (port, host, ...rest) { return listen.call(this, port, '127.0.0.1', ...rest); };
`;

  /** Start `node server/index.js` with the given EDULET_HOST, return what it printed in its first 600 ms after the address line. */
  async function startAndRead(host, preload) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edulet-start-'));
    const pre = path.join(dir, 'preload.mjs');
    fs.writeFileSync(pre, PRELOAD);
    const args = ['--disable-warning=ExperimentalWarning', ...(preload ? ['--import', pathToFileURL(pre).href] : []), path.join(root, 'server', 'index.js')];
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, EDULET_HOST: host, EDULET_PORT: '0', EDULET_DATA_DIR: path.join(dir, 'data'), EDULET_SEED: '0', EDULET_PUBLIC_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      const deadline = Date.now() + 20000;
      while (!/Edulet is running at/.test(out) && child.exitCode === null && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
      assert.match(out, /^Edulet is running at http:\/\/\S+:\d+/m, `stdout: ${out} stderr: ${err}`);
      await new Promise((res) => setTimeout(res, 600)); // the hint (if any) is written in the same tick; give the pipe time
      return out;
    } finally {
      child.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  it('bound beyond this PC, the real process prints the local address and then the LAN hint', async () => {
    const out = await startAndRead('0.0.0.0', true);
    const port = /Edulet is running at http:\/\/localhost:(\d+)/.exec(out)?.[1];
    assert.ok(port, out);
    assert.ok(out.split('\n').map((l) => l.trim()).includes(`같은 네트워크의 다른 기기에서는: http://192.168.0.12:${port}`), out);
    assert.ok(out.indexOf('Edulet is running') < out.indexOf('같은 네트워크'), 'the hint follows the local address');
  });

  it('bound to 127.0.0.1, it prints the local address and no LAN hint', async () => {
    const out = await startAndRead('127.0.0.1', true); // the fake NIC is there, the bind says nobody else can connect
    assert.match(out, /^Edulet is running at http:\/\/127\.0\.0\.1:\d+/m, out);
    assert.ok(!out.includes('같은 네트워크'), out);
  });
});
