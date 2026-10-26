'use strict';
// Vector icons drawn by the renderer itself (kit primitives only: lines, arcs, circles, round rects, quads) - the same
// on iDrive 7 and 8, no HMI glyphs. vicon(cv, name, x, y, s, color) draws `name` in the s x s box at (x, y).
// Arc angles: degrees, 0 = up, clockwise (kit canvas).
const P = (x, y, s) => (u, v) => [x + u * s, y + v * s];          // unit square -> box
const { withAlpha } = require('./kit_canvas.js');
const faint = (c) => withAlpha(c, 0.45);

const ICONS = {
    grid(cv, x, y, s, c) { const g = s * 0.36, m = s * 0.1, r = s * 0.08;
        for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) cv.roundRect(x + m + i * (g + s * 0.08), y + m + j * (g + s * 0.08), g, g, r, c); },
    check(cv, x, y, s, c) { const p = P(x, y, s); cv.polyline([p(0.16, 0.52), p(0.4, 0.75), p(0.86, 0.26)], s * 0.11, c); },
    arrowDown(cv, x, y, s, c) { const p = P(x, y, s), w = s * 0.1;
        cv.line(...p(0.5, 0.12), ...p(0.5, 0.66), w, c); cv.polyline([p(0.26, 0.44), p(0.5, 0.68), p(0.74, 0.44)], w, c); cv.line(...p(0.2, 0.86), ...p(0.8, 0.86), w, c); },
    clock(cv, x, y, s, c) { const cx = x + s / 2, cy = y + s / 2, w = s * 0.09;
        cv.arc(cx, cy, s * 0.4 - w, s * 0.4, 0, 360, c); cv.line(cx, cy, cx, cy - s * 0.22, w, c); cv.line(cx, cy, cx + s * 0.16, cy + s * 0.08, w, c); },
    back(cv, x, y, s, c) { const p = P(x, y, s); cv.polyline([p(0.6, 0.2), p(0.3, 0.5), p(0.6, 0.8)], s * 0.11, c); },
    chevron(cv, x, y, s, c) { const p = P(x, y, s); cv.polyline([p(0.4, 0.2), p(0.7, 0.5), p(0.4, 0.8)], s * 0.1, c); },
    plus(cv, x, y, s, c) { const p = P(x, y, s), w = s * 0.11; cv.line(...p(0.5, 0.18), ...p(0.5, 0.82), w, c); cv.line(...p(0.18, 0.5), ...p(0.82, 0.5), w, c); },
    trash(cv, x, y, s, c) { const p = P(x, y, s), w = s * 0.08;
        cv.line(...p(0.18, 0.24), ...p(0.82, 0.24), w, c); cv.line(...p(0.4, 0.13), ...p(0.6, 0.13), w, c);
        cv.polyline([p(0.27, 0.3), p(0.32, 0.88), p(0.68, 0.88), p(0.73, 0.3)], w, c);
        cv.line(...p(0.43, 0.4), ...p(0.44, 0.76), w * 0.8, c); cv.line(...p(0.57, 0.4), ...p(0.56, 0.76), w * 0.8, c); },
    lock(cv, x, y, s, c) { const w = s * 0.09;
        cv.arc(x + s / 2, y + s * 0.42, s * 0.2 - w, s * 0.2, -90, 90, c);
        cv.line(x + s * 0.3 + w / 2, y + s * 0.42, x + s * 0.3 + w / 2, y + s * 0.5, w, c); cv.line(x + s * 0.7 - w / 2, y + s * 0.42, x + s * 0.7 - w / 2, y + s * 0.5, w, c);
        cv.roundRect(x + s * 0.2, y + s * 0.48, s * 0.6, s * 0.4, s * 0.07, c); },
    unlock(cv, x, y, s, c) { const w = s * 0.09, cx = x + s * 0.62;      // shackle open, swung to the right
        cv.arc(cx, y + s * 0.34, s * 0.18 - w, s * 0.18, -90, 90, c);
        cv.line(cx + s * 0.18 - w / 2, y + s * 0.34, cx + s * 0.18 - w / 2, y + s * 0.46, w, c);
        cv.roundRect(x + s * 0.14, y + s * 0.48, s * 0.56, s * 0.4, s * 0.07, c); },
    warning(cv, x, y, s, c) { const p = P(x, y, s), w = s * 0.09;
        cv.polyline([p(0.5, 0.12), p(0.9, 0.84), p(0.1, 0.84), p(0.5, 0.12)], w, c);
        cv.line(...p(0.5, 0.38), ...p(0.5, 0.6), w, c); cv.circle(...p(0.5, 0.72), w * 0.7, c); },
    gear(cv, x, y, s, c) { const cx = x + s / 2, cy = y + s / 2, w = s * 0.09;
        for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, d = [Math.sin(a), -Math.cos(a)], q = [d[1], -d[0]];
            const r0 = s * 0.28, r1 = s * 0.44, h = s * 0.07;
            cv.quad([[cx + d[0] * r0 + q[0] * h, cy + d[1] * r0 + q[1] * h], [cx + d[0] * r1 + q[0] * h, cy + d[1] * r1 + q[1] * h],
                [cx + d[0] * r1 - q[0] * h, cy + d[1] * r1 - q[1] * h], [cx + d[0] * r0 - q[0] * h, cy + d[1] * r0 - q[1] * h]], c); }
        cv.arc(cx, cy, s * 0.17, s * 0.33, 0, 360, c); },
    usb(cv, x, y, s, c) { const p = P(x, y, s), w = s * 0.075;
        cv.line(...p(0.5, 0.2), ...p(0.5, 0.82), w, c); cv.circle(...p(0.5, 0.86), s * 0.07, c);
        cv.quad([p(0.5, 0.06), p(0.6, 0.2), p(0.5, 0.2), p(0.4, 0.2)], c);
        cv.polyline([p(0.5, 0.62), p(0.28, 0.48), p(0.28, 0.36)], w, c); cv.circle(...p(0.28, 0.32), s * 0.06, c);
        cv.polyline([p(0.5, 0.54), p(0.72, 0.42), p(0.72, 0.32)], w, c); cv.roundRect(...p(0.66, 0.22), s * 0.12, s * 0.1, 1, c); },
    refresh(cv, x, y, s, c) { const cx = x + s / 2, cy = y + s / 2, r = s * 0.34, w = s * 0.09;
        cv.arc(cx, cy, r - w, r, 40, 330, c); const p = P(x, y, s); cv.quad([p(0.5, 0.06), p(0.68, 0.18), p(0.5, 0.3), p(0.5, 0.3)], c); },
    // app identity icons
    gauge(cv, x, y, s, c) { const cx = x + s / 2, cy = y + s * 0.56, r = s * 0.4, w = s * 0.08;
        cv.arc(cx, cy, r - w, r, -125, 125, c);
        for (let k = -2; k <= 2; k++) { const a = k * 50 * Math.PI / 180; cv.line(cx + Math.sin(a) * r * 0.62, cy - Math.cos(a) * r * 0.62, cx + Math.sin(a) * r * 0.74, cy - Math.cos(a) * r * 0.74, w * 0.6, c); }
        cv.line(cx, cy, cx + r * 0.5, cy - r * 0.42, w * 0.9, c); cv.circle(cx, cy, w * 1.1, c); },
    stopwatch(cv, x, y, s, c) { const cx = x + s / 2, cy = y + s * 0.56, r = s * 0.34, w = s * 0.08;
        cv.arc(cx, cy, r - w, r, 0, 360, c); cv.roundRect(cx - s * 0.08, y + s * 0.08, s * 0.16, s * 0.08, 2, c);
        cv.line(cx, cy - r, cx, y + s * 0.16, w, c); cv.line(cx, cy, cx + r * 0.45, cy - r * 0.5, w, c); cv.circle(cx, cy, w * 0.9, c); },
    camera(cv, x, y, s, c) { const w = s * 0.08;
        cv.strokeRoundRect(x + s * 0.12, y + s * 0.28, s * 0.76, s * 0.52, s * 0.08, w, c);
        cv.roundRect(x + s * 0.34, y + s * 0.18, s * 0.32, s * 0.12, s * 0.04, c);
        cv.arc(x + s / 2, y + s * 0.54, s * 0.15 - w, s * 0.15, 0, 360, c); cv.circle(x + s * 0.76, y + s * 0.38, s * 0.035, c); },
    // the iPhone tether: a globe (the internet) with the USB sign in it; the globe's lines fainter than the sign
    tether(cv, x, y, s, c) { const cx = x + s / 2, cy = y + s / 2, r = s * 0.46, w = s * 0.06, f = faint(c);
        cv.arc(cx, cy, r - w, r, 0, 360, c);
        const ell = (rx) => { const pts = []; for (let k = 0; k <= 24; k++) { const a = k * Math.PI / 12; pts.push([cx + Math.sin(a) * rx, cy - Math.cos(a) * (r - w / 2)]); } return pts; };
        cv.polyline(ell(r * 0.5), w * 0.7, f);
        for (const v of [-0.5, 0.5]) { const h = Math.sqrt(1 - v * v) * (r - w / 2); cv.line(cx - h, cy + v * r, cx + h, cy + v * r, w * 0.7, f); }
        ICONS.usb(cv, cx - s * 0.3, cy - s * 0.3, s * 0.6, c); },
    phone(cv, x, y, s, c) { const w = s * 0.08;
        cv.strokeRoundRect(x + s * 0.3, y + s * 0.1, s * 0.4, s * 0.8, s * 0.08, w, c); cv.line(x + s * 0.44, y + s * 0.78, x + s * 0.56, y + s * 0.78, w * 0.8, c); },
    display(cv, x, y, s, c) { const w = s * 0.08;
        cv.strokeRoundRect(x + s * 0.1, y + s * 0.18, s * 0.8, s * 0.5, s * 0.06, w, c);
        cv.line(x + s * 0.5, y + s * 0.68, x + s * 0.5, y + s * 0.8, w, c); cv.line(x + s * 0.32, y + s * 0.84, x + s * 0.68, y + s * 0.84, w, c); },
    route(cv, x, y, s, c) { const p = P(x, y, s), w = s * 0.08;
        cv.line(...p(0.3, 0.88), ...p(0.44, 0.12), w, c); cv.line(...p(0.7, 0.88), ...p(0.56, 0.12), w, c);
        for (const v of [0.2, 0.45, 0.7]) cv.line(...p(0.5, v), ...p(0.5, v + 0.12), w * 0.8, c); },
    wrench(cv, x, y, s, c) { const p = P(x, y, s);                    // open-end wrench: C-shaped head + handle
        cv.line(...p(0.2, 0.8), ...p(0.52, 0.48), s * 0.14, c);
        cv.arc(...p(0.64, 0.36), s * 0.08, s * 0.21, 85, 365, c); },
};

function vicon(cv, name, x, y, s, c) { const f = ICONS[name]; if (f) f(cv, x, y, s, c); return !!f; }
module.exports = { vicon, ICONS };
