'use strict';
/**
 * The Store's own renderer element, beside App Manager 2's (am_widgets.js,
 * am_store_widgets.js), same signature (cv, t, b, o): a QR code of o.text on
 * a white card in the square of b, its modules as rectangles (one per run
 * of dark modules in a row), so it needs no picture upload.
 */
const { qrModules } = require('./qr.js');
const { vicon } = require('./kit_vicons.js');
const { withAlpha } = require('./kit_canvas.js');
const W = require('./am_widgets.js');

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

/* Ways to do something, side by side (Settings > Internet): o.items [{ vicon, title, text }], each a card with its logo
 * on a disc at the top, its name and its text wrapped under it (text a list: numbered steps, each from a new line). */
function ways(cv, t, b, o) {
    const items = Array.isArray(o.items) ? o.items : [];
    if (!items.length) return;
    const gap = Math.round(b.w * 0.015), cw = (b.w - gap * (items.length - 1)) / items.length;
    const big = b.h > 600, d = Math.round(Math.min(cw * 0.42, b.h * (big ? 0.26 : 0.3))), ts = o.titleSize || (big ? 40 : 28),
        xs = o.textSize || (big ? 32 : 22);
    items.forEach((it, i) => {
        const x = b.x + i * (cw + gap);
        if (W.id7(t)) W.panel7(cv, t, x, b.y, cw, b.h, true);
        else cv.roundRect(x, b.y, cw, b.h, Math.min(24, cw / 10), t.panelTop);
        const cx = x + cw / 2, cy = b.y + b.h * 0.06 + d / 2 + 10;
        cv.circle(cx, cy, d / 2, withAlpha(t.text, 0.1));
        vicon(cv, it.vicon, cx - d * 0.32, cy - d * 0.32, d * 0.64, t.text);
        const ty = cy + d / 2 + ts * 1.4;
        cv.text(W.fit(cv, String(it.title || ''), cw - 32, ts, 'bold'), cx, ty, ts, t.text, { align: 'center', font: 'bold' });
        const steps = Array.isArray(it.text) ? it.text.map((s, k) => `${k + 1}. ${s}`) : [String(it.text || '')];
        let y = ty + ts * 0.5, left = Math.max(1, Math.floor((b.y + b.h - y - 12) / (xs * 1.25)));
        for (const s of steps) {
            if (left < 1) break;
            const n = W.wrap(cv, s, x + 20, y, cw - 40, xs, t.dim, left);
            y += n * xs * 1.25; left -= n;
        }
    });
}

module.exports = { DRAW: { qr, ways } };
