'use strict';
/**
 * The Store's own renderer element, beside App Manager 2's (am_widgets.js,
 * am_store_widgets.js), same signature (cv, t, b, o): a QR code of o.text on
 * a white card in the square of b, its modules as rectangles (one per run
 * of dark modules in a row), so it needs no picture upload.
 */
const { qrModules } = require('./qr.js');

function qr(cv, t, b, o) {
    if (!o.text) {
        return;
    }
    const q = qrModules(String(o.text));
    const n = q.size + 8;
    const s = Math.min(b.w, b.h);
    // whole device pixels per module: no seams between neighbouring rectangles
    const ts = cv.textScale || 1;
    const m = Math.max(1, Math.floor((s * ts) / n)) / ts;
    cv.roundRect(b.x, b.y, s, s, Math.round(s * 0.04), '#ffffff');
    for (let r = 0; r < q.size; r++) {
        let run = -1;
        for (let c = 0; c <= q.size; c++) {
            const dark = c < q.size && q.dark(c, r);
            if (dark && run < 0) {
                run = c;
            } else if (!dark && run >= 0) {
                cv.fillRect(b.x + (4 + run) * m, b.y + (4 + r) * m, (c - run) * m, m, '#000000');
                run = -1;
            }
        }
    }
}

module.exports = { DRAW: { qr } };
