'use strict';
// Renders a QR code as a crisp SVG using the vendored MIT-licensed encoder.
const QRCode = require('../vendor/QRCode');
const ErrorLevel = require('../vendor/QRCode/QRErrorCorrectLevel');

function qrSvg(text, { quiet = 4, dark = '#0b1424', light = '#ffffff' } = {}) {
  const qr = new QRCode(-1, ErrorLevel.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + quiet * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (qr.isDark(r, c)) {
        let start = c;
        while (c < n && qr.isDark(r, c)) c++;
        path += `M${start + quiet} ${r + quiet}h${c - start}v1h-${c - start}z`;
      } else {
        c++;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

module.exports = { qrSvg };
