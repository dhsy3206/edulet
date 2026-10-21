"""Bundle the MIT-licensed QRCode core (Kazuhiko Arase, as vendored in qrcode-terminal)
into one browser ES module: public/vendor/qrcode.js.   usage: python -I tools/vendor_qrcode.py <qrcode-terminal/vendor/QRCode dir>"""
import os, re, sys

src = sys.argv[1]
order = ["QRMode", "QRErrorCorrectLevel", "QRMaskPattern", "QRMath", "QRPolynomial", "QR8bitByte", "QRBitBuffer", "QRRSBlock", "QRUtil", "index"]
out = ["""// QRCode for JavaScript — Copyright (c) 2009 Kazuhiko Arase (MIT). See LICENSE-qrcode.txt.
// "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
// Bundled by tools/vendor_qrcode.py into one ES module (the original CommonJS sources, unchanged apart from require()).
const __defs = {}, __cache = {};
function __req(n) {
  if (__cache[n]) return __cache[n].exports;
  const m = (__cache[n] = { exports: {} });
  __defs[n](m, m.exports, __req);
  return m.exports;
}
"""]
for name in order:
    code = open(os.path.join(src, name + ".js"), encoding="utf-8").read()
    code = re.sub(r"require\('\./([A-Za-z0-9]+)'\)", r"__req('\1')", code)
    out.append("__defs['%s'] = function (module, exports, __req) {\n%s\n};\n" % (name, code))
out.append("""
const ECL = { L: 1, M: 0, Q: 3, H: 2 };

/** Returns { size, isDark(r, c) } for the text, or null when it does not fit. */
export function qrMatrix(text, level = 'M') {
  const QRCode = __req('index');
  try {
    const q = new QRCode(-1, ECL[level]);
    q.addData(String(text));
    q.make();
    const size = q.getModuleCount();
    return { size, isDark: (r, c) => q.isDark(r, c) };
  } catch (e) {
    return null;
  }
}

/** SVG markup (string of trusted, generated content) for the text, with a 4-module quiet zone. */
export function qrSvg(text, { level = 'M', fg = '#000', bg = '#fff' } = {}) {
  const m = qrMatrix(text, level);
  if (!m) return null;
  const q = 4, n = m.size + q * 2;
  let d = '';
  for (let r = 0; r < m.size; r++)
    for (let c = 0; c < m.size; c++)
      if (m.isDark(r, c)) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges">' +
    '<rect width="' + n + '" height="' + n + '" fill="' + bg + '"/><path d="' + d + '" fill="' + fg + '"/></svg>';
}
""")
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "vendor", "qrcode.js"), "w", encoding="utf-8", newline="\n").write("".join(out))
print("ok")
