// Ports that fetch() (and Chrome) refuse to talk to — "fetch failed (bad port)" / ERR_UNSAFE_PORT (WHATWG Fetch's "bad ports").
// A port the OS hands out for `listen(0)` lands on one of them now and then (4045 was seen), which made a random test fail on its
// very first request. Used by the tests and the e2e runners; the app itself is not affected (it listens on a port you choose).
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
export const isBadPort = (port) => BAD_PORTS.has(port);

/** Listen on an OS-assigned port that fetch()/Chrome accept (re-rolls the rare bad one). Resolves to the listening server. */
export async function listenOnGoodPort(server, host = '127.0.0.1') {
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => { server.off('error', reject); resolve(); });
    });
    if (!isBadPort(server.address().port)) return server;
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error('no usable port');
}
