import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isBadPort, listenOnGoodPort } from '../tools/ports.mjs';

describe('ports that fetch() refuses', () => {
  it('knows the ones seen in the wild and the WHATWG list ends', () => {
    for (const p of [1, 22, 25, 4045, 5060, 6000, 6665, 6669, 6697, 10080]) assert.equal(isBadPort(p), true, String(p));
    for (const p of [80, 443, 3000, 8080, 40000, 49152, 65535]) assert.equal(isBadPort(p), false, String(p));
  });

  it('listenOnGoodPort re-rolls a bad port the OS hands out (simulated) and keeps the first good one', async () => {
    const handed = [4045, 6000, 41234];
    const closed = [];
    let current = 0;
    const server = {
      once() {}, off() {},
      listen(_port, _host, cb) { current = handed.shift(); queueMicrotask(cb); },
      address() { return { port: current }; },
      close(cb) { closed.push(current); queueMicrotask(cb); },
    };
    assert.equal(await listenOnGoodPort(server), server);
    assert.equal(server.address().port, 41234);
    assert.deepEqual(closed, [4045, 6000], 'each bad port was released');
  });

  it('listenOnGoodPort works on a real server', async () => {
    const server = http.createServer((req, res) => res.end('ok'));
    await listenOnGoodPort(server);
    try {
      const { port } = server.address();
      assert.equal(isBadPort(port), false);
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
    } finally {
      await new Promise((r) => { server.closeAllConnections(); server.close(r); });
    }
  });
});
