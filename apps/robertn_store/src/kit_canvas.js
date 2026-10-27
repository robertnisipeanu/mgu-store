'use strict';
/**
 * canvas.js - tiny anti-aliased RGBA canvas that encodes to PNG.
 *
 * Pure JavaScript (node 8 on the head unit has no native canvas). Apps draw
 * their gauges into a Canvas, write the PNG into rhmiData/ and hand the file
 * to the HMI (see mgu.js Screen.setImage). Coordinates are pixels, angles are
 * degrees clockwise from 12 o'clock (gauge convention).
 */
const zlib = require('zlib');
const fonts = require('./kit_fonts.js');

/* ---------- colours ---------- */
const cache = Object.create(null);
function rgba(c) {
    if (Array.isArray(c)) return c.length === 4 ? c : [c[0], c[1], c[2], 255];
    if (cache[c]) return cache[c];
    let s = String(c).replace('#', '');
    if (s.length === 3) s = s.split('').map((x) => x + x).join('');
    const v = [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16),
        s.length >= 8 ? parseInt(s.slice(6, 8), 16) : 255];
    cache[c] = v;
    return v;
}
function mix(a, b, t) {
    a = rgba(a); b = rgba(b);
    return [0, 1, 2, 3].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}
function withAlpha(c, a) { const v = rgba(c); return [v[0], v[1], v[2], Math.round(a * 255)]; }

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Signed distance from (dx, dy) (relative to the centre) to a rounded rect of half size hw, hh, radius r. */
function rrDist(dx, dy, hw, hh, r) {
    const qx = Math.abs(dx) - (hw - r), qy = Math.abs(dy) - (hh - r);
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Colour at position f (0..1) of a ramp [c0, c1, ...] (evenly spaced stops). */
function ramp(stops, f) {
    if (stops.length === 1) return rgba(stops[0]);
    const x = clamp01(f) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x));
    return mix(stops[i], stops[i + 1], x - i);
}
const RAD = Math.PI / 180;

class Canvas {
    constructor(w, h) {
        this.w = w | 0; this.h = h | 0;
        this.d = new Uint8Array(this.w * this.h * 4);
    }

    clear(c) {
        const v = rgba(c || [0, 0, 0, 0]);
        // one pixel, then doubling copies: a few memcpys instead of 4 writes per pixel
        const d = this.d, n = d.length;
        if (!n) return this;
        d[0] = v[0]; d[1] = v[1]; d[2] = v[2]; d[3] = v[3];
        for (let len = 4; len < n; len *= 2) d.copyWithin(len, 0, Math.min(len, n - len));
        return this;
    }

    /**
     * Draw another canvas (a pre-drawn layer) at (x, y), alpha-blended. Fully
     * transparent pixels are skipped and opaque ones copied, so blitting a cached
     * layer costs far less than drawing it again.
     */
    blit(src, x, y) {
        x = Math.round(x); y = Math.round(y);
        const sw = src.w, d = this.d, s = src.d;
        const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(this.w, x + sw), y1 = Math.min(this.h, y + src.h);
        const px = [0, 0, 0, 255];
        for (let py = y0; py < y1; py++) {
            let si = ((py - y) * sw + (x0 - x)) * 4, di = (py * this.w + x0) * 4;
            for (let qx = x0; qx < x1; qx++, si += 4, di += 4) {
                const a = s[si + 3];
                if (a === 0) continue;
                if (a === 255) { d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = 255; continue; }
                // translucent over an opaque pixel (panels over the background - most of every frame):
                // _blend's maths with da = 1, inlined - same result without a call per pixel
                if (d[di + 3] === 255) {
                    const sa = a / 255, k = 1 - sa;
                    d[di] = s[si] * sa + d[di] * k; d[di + 1] = s[si + 1] * sa + d[di + 1] * k; d[di + 2] = s[si + 2] * sa + d[di + 2] * k;
                    continue;
                }
                px[0] = s[si]; px[1] = s[si + 1]; px[2] = s[si + 2]; px[3] = a;
                this._blend(qx, py, px, 1);
            }
        }
        return this;
    }

    /** Copy an opaque canvas to (x, y) row by row (no blending: memcpy per row), clipped. */
    copyRows(src, x, y) {
        x = Math.round(x); y = Math.round(y);
        const x0 = Math.max(0, x), x1 = Math.min(this.w, x + src.w);
        if (x1 <= x0) return this;
        for (let py = Math.max(0, y); py < Math.min(this.h, y + src.h); py++) {
            const s = ((py - y) * src.w + (x0 - x)) * 4;
            this.d.set(src.d.subarray(s, s + (x1 - x0) * 4), (py * this.w + x0) * 4);
        }
        return this;
    }

    /** src-over blend of colour c with coverage cov (0..1) at integer pixel. */
    _blend(x, y, c, cov) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const sa = (c[3] / 255) * cov;
        if (sa <= 0) return;
        const i = (y * this.w + x) * 4, d = this.d;
        const da = d[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa <= 0) return;
        const k = da * (1 - sa);
        d[i] = (c[0] * sa + d[i] * k) / oa;
        d[i + 1] = (c[1] * sa + d[i + 1] * k) / oa;
        d[i + 2] = (c[2] * sa + d[i + 2] * k) / oa;
        d[i + 3] = oa * 255;
    }

    fillRect(x, y, w, h, c) {
        c = rgba(c);
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
        if (x1 <= x0 || y1 <= y0 || c[3] === 0) return this;
        const d = this.d, W4 = this.w * 4, r = c[0], g = c[1], b = c[2], ca = c[3] / 255;
        // the pixel loop is inlined (no call per pixel); edge pixels get fractional coverage
        for (let py = y0; py < y1; py++) {
            const cy = clamp01(Math.min(py + 1, y + h) - Math.max(py, y));
            let i = py * W4 + x0 * 4;
            for (let px = x0; px < x1; px++, i += 4) {
                const cov = (px === x0 || px === x1 - 1) ? cy * clamp01(Math.min(px + 1, x + w) - Math.max(px, x)) : cy;
                const sa = ca * cov;
                if (sa >= 1) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; continue; }
                if (sa <= 0) continue;
                const da = d[i + 3] / 255, oa = sa + da * (1 - sa), k = da * (1 - sa);
                d[i] = (r * sa + d[i] * k) / oa;
                d[i + 1] = (g * sa + d[i + 1] * k) / oa;
                d[i + 2] = (b * sa + d[i + 2] * k) / oa;
                d[i + 3] = oa * 255;
            }
        }
        return this;
    }

    /** Vertical gradient fill; stops = [[t, colour], ...] with t in 0..1. */
    gradientRect(x, y, w, h, stops) {
        const st = stops.map((s) => [s[0], rgba(s[1])]);
        for (let py = Math.max(0, y | 0); py < Math.min(this.h, y + h); py++) {
            const t = (py - y) / Math.max(1, h - 1);
            let k = 0;
            while (k < st.length - 2 && t > st[k + 1][0]) k++;
            const a = st[k], b = st[Math.min(k + 1, st.length - 1)];
            const tt = b[0] === a[0] ? 0 : clamp01((t - a[0]) / (b[0] - a[0]));
            this.fillRect(x, py, w, 1, mix(a[1], b[1], tt));
        }
        return this;
    }

    /** Anti-aliased rounded rectangle (fill). */
    roundRect(x, y, w, h, r, c) {
        c = rgba(c);
        r = Math.min(r, w / 2, h / 2);
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
        for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
                const cx = px + 0.5, cy = py + 0.5;
                const dist = rrDist(cx - (x + w / 2), cy - (y + h / 2), w / 2, h / 2, r);
                const cov = clamp01(0.5 - dist);
                if (cov > 0) this._blend(px, py, c, cov);
            }
        }
        return this;
    }

    /**
     * Picture src ({ w, h, data } straight RGBA from png.js, or a Canvas) stretched over x, y, w, h with
     * bilinear sampling, corner radius r (0 = square), opacity alpha (0..1).
     */
    image(src, x, y, w, h, r, alpha) {
        const s = src.data || src.d, sw = src.w, sh = src.h, al = alpha == null ? 1 : alpha;
        if (!(w > 0 && h > 0) || !s || al <= 0) return this;
        r = Math.min(r || 0, w / 2, h / 2);
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
        const px = [0, 0, 0, 0], kx = sw / w, ky = sh / h;
        for (let py = y0; py < y1; py++) {
            const v = Math.min(sh - 1, Math.max(0, (py + 0.5 - y) * ky - 0.5)), vy = Math.floor(v), fy = v - vy, vy1 = Math.min(sh - 1, vy + 1);
            for (let qx = x0; qx < x1; qx++) {
                const cov = clamp01(0.5 - rrDist(qx + 0.5 - (x + w / 2), py + 0.5 - (y + h / 2), w / 2, h / 2, r));
                if (cov <= 0) continue;
                const uu = Math.min(sw - 1, Math.max(0, (qx + 0.5 - x) * kx - 0.5)), ux = Math.floor(uu), fx = uu - ux, ux1 = Math.min(sw - 1, ux + 1);
                const i00 = (vy * sw + ux) * 4, i10 = (vy * sw + ux1) * 4, i01 = (vy1 * sw + ux) * 4, i11 = (vy1 * sw + ux1) * 4;
                // weights times alpha: transparent texels don't bleed their colour in
                const w00 = (1 - fx) * (1 - fy) * s[i00 + 3], w10 = fx * (1 - fy) * s[i10 + 3], w01 = (1 - fx) * fy * s[i01 + 3], w11 = fx * fy * s[i11 + 3];
                const a = w00 + w10 + w01 + w11;
                if (a <= 0) continue;
                for (let k = 0; k < 3; k++) px[k] = (s[i00 + k] * w00 + s[i10 + k] * w10 + s[i01 + k] * w01 + s[i11 + k] * w11) / a;
                px[3] = a;
                this._blend(qx, py, px, cov * al);
            }
        }
        return this;
    }

    /** Rounded-rectangle outline of the given stroke width. */
    strokeRoundRect(x, y, w, h, r, width, c) {
        c = rgba(c);
        r = Math.min(r, w / 2, h / 2);
        const x0 = Math.max(0, Math.floor(x - 1)), y0 = Math.max(0, Math.floor(y - 1));
        const x1 = Math.min(this.w, Math.ceil(x + w + 1)), y1 = Math.min(this.h, Math.ceil(y + h + 1));
        for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
                const cx = px + 0.5, cy = py + 0.5;
                const dist = rrDist(cx - (x + w / 2), cy - (y + h / 2), w / 2, h / 2, r);      // <0 inside
                const cov = clamp01(0.5 - dist) * clamp01(dist + width + 0.5);
                if (cov > 0) this._blend(px, py, c, cov);
            }
        }
        return this;
    }

    /**
     * Rounded card with a vertical gradient (stops as gradientRect). Only the
     * corner squares are shaded per pixel, so it costs about as much as a fillRect.
     */
    card(x, y, w, h, r, stops) {
        const st = stops.map((v) => [v[0], rgba(v[1])]);
        r = Math.min(r, w / 2, h / 2);
        const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(this.h, Math.ceil(y + h));
        for (let py = y0; py < y1; py++) {
            const t = (py - y) / Math.max(1, h - 1);
            let k = 0;
            while (k < st.length - 2 && t > st[k + 1][0]) k++;
            const a = st[k], b = st[Math.min(k + 1, st.length - 1)];
            const c = mix(a[1], b[1], b[0] === a[0] ? 0 : clamp01((t - a[0]) / (b[0] - a[0])));
            const cy = py + 0.5;
            const inCorner = cy < y + r || cy > y + h - r;
            if (!inCorner) { this.fillRect(x, py, w, 1, c); continue; }
            const qy = Math.max(Math.abs(cy - (y + h / 2)) - (h / 2 - r), 0);
            const covY = clamp01(Math.min(py + 1, y + h) - Math.max(py, y));
            this.fillRect(x + r, py, w - 2 * r, covY, c);
            for (const [ex0, ex1] of [[x, x + r], [x + w - r, x + w]]) {
                for (let px = Math.max(0, Math.floor(ex0)); px < Math.min(this.w, Math.ceil(ex1)); px++) {
                    const qx = Math.max(Math.abs(px + 0.5 - (x + w / 2)) - (w / 2 - r), 0);
                    const cov = clamp01(0.5 - (Math.sqrt(qx * qx + qy * qy) - r)) * covY;
                    if (cov > 0) this._blend(px, py, rgba(c), cov);
                }
            }
        }
        return this;
    }

    /**
     * Rounded bar filled with a horizontal colour ramp. The ramp spans
     * spanX..spanX+spanW (default the bar itself), so a partly filled bar
     * keeps the colours of its position on the scale.
     */
    rampRect(x, y, w, h, r, stops, spanX, spanW) {
        if (w <= 0 || h <= 0) return this;
        r = Math.min(r, w / 2, h / 2);
        const sx = spanX == null ? x : spanX, sw = Math.max(1, spanW == null ? w : spanW);
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
        const col = [];
        for (let px = x0; px < x1; px++) col.push(ramp(stops, (px + 0.5 - sx) / sw));
        for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
                const cov = clamp01(0.5 - rrDist(px + 0.5 - (x + w / 2), py + 0.5 - (y + h / 2), w / 2, h / 2, r));
                if (cov > 0) this._blend(px, py, col[px - x0], cov);
            }
        }
        return this;
    }

    /** Filled circle. */
    circle(cx, cy, r, c) { return this.arc(cx, cy, 0, r, 0, 360, c); }

    /**
     * Annulus sector (ring segment) from angle a0 to a1 (degrees, clockwise
     * from 12 o'clock), radii r0..r1. opts.round = round end caps.
     * opts.ramp = [c0, c1, ...] colours the ring by angle instead of c, spread
     * over opts.rampFrom..opts.rampTo (default a0..a1; rampTo < rampFrom runs it
     * anticlockwise), so a value arc keeps the
     * colour of its position on the scale.
     */
    arc(cx, cy, r0, r1, a0, a1, c, opts) {
        c = rgba(c);
        let lut = null, rf = 0, rs = 1;
        if (opts && opts.ramp) {
            rf = opts.rampFrom == null ? Math.min(a0, a1) : opts.rampFrom;
            rs = (opts.rampTo == null ? Math.max(a0, a1) : opts.rampTo) - rf;      // signed span
            if (Math.abs(rs) < 1e-6) rs = 1e-6;
            lut = [];
            for (let i = 0; i <= 64; i++) lut.push(ramp(opts.ramp, i / 64));
        }
        if (a1 < a0) { const t = a0; a0 = a1; a1 = t; }
        const full = a1 - a0 >= 360;
        const round = opts && opts.round && !full;
        const rm = (r0 + r1) / 2, hw = (r1 - r0) / 2;
        const capA = [a0 * RAD, a1 * RAD];
        const caps = round ? capA.map((a) => [cx + Math.sin(a) * rm, cy - Math.cos(a) * rm]) : null;
        // bounding box of the sector only (end points + any 90-degree extremes inside it),
        // not the whole circle: a short arc scans a small area
        let bx0 = cx - r1, bx1 = cx + r1, by0 = cy - r1, by1 = cy + r1;
        if (!full) {
            const pts = [];
            [a0, a1].forEach((a) => { const t = a * RAD; [r0, r1].forEach((r) => pts.push([cx + Math.sin(t) * r, cy - Math.cos(t) * r])); });
            for (let k = Math.ceil(a0 / 90) * 90; k <= a1; k += 90) { const t = k * RAD; pts.push([cx + Math.sin(t) * r1, cy - Math.cos(t) * r1]); }
            const pad = round ? (r1 - r0) / 2 + 1 : 1;
            bx0 = Math.min.apply(null, pts.map((p) => p[0])) - pad; bx1 = Math.max.apply(null, pts.map((p) => p[0])) + pad;
            by0 = Math.min.apply(null, pts.map((p) => p[1])) - pad; by1 = Math.max.apply(null, pts.map((p) => p[1])) + pad;
        }
        const x0 = Math.max(0, Math.floor(bx0 - 1)), x1 = Math.min(this.w, Math.ceil(bx1 + 1));
        const y0 = Math.max(0, Math.floor(by0 - 1)), y1 = Math.min(this.h, Math.ceil(by1 + 1));
        const mid = ((a0 + a1) / 2) * RAD, half = ((a1 - a0) / 2) * RAD;
        for (let py = y0; py < y1; py++) {
            const dy = py + 0.5 - cy;
            for (let px = x0; px < x1; px++) {
                const dx = px + 0.5 - cx;
                const dd = Math.sqrt(dx * dx + dy * dy);
                if (dd > r1 + 1 || dd < r0 - 1) continue;
                let cov = clamp01(r1 - dd + 0.5) * (r0 > 0 ? clamp01(dd - r0 + 0.5) : 1);
                if (cov <= 0) continue;
                if (!full) {
                    // angle of the pixel, measured relative to the sector middle
                    let ang = Math.atan2(dx, -dy) - mid;
                    while (ang > Math.PI) ang -= 2 * Math.PI;
                    while (ang < -Math.PI) ang += 2 * Math.PI;
                    const outside = (Math.abs(ang) - half) * Math.max(dd, 1);   // px beyond the edge
                    let v = cov * clamp01(0.5 - outside);
                    if (round && v < 1) {
                        for (const p of caps) {
                            const ex = px + 0.5 - p[0], ey = py + 0.5 - p[1];
                            v = Math.max(v, clamp01(hw - Math.sqrt(ex * ex + ey * ey) + 0.5));
                        }
                    }
                    cov = v;
                }
                if (cov > 0) {
                    if (lut) {
                        // angle travelled from rampFrom in the ramp's direction (0..360)
                        const span = Math.abs(rs);
                        let da = (Math.atan2(dx, -dy) / RAD - rf) * (rs < 0 ? -1 : 1);
                        da = ((da % 360) + 360) % 360;
                        if (da > span + (360 - span) / 2) da -= 360;            // just before the start
                        c = lut[Math.round(clamp01(da / span) * 64)];
                    }
                    this._blend(px, py, c, cov);
                }
            }
        }
        return this;
    }

    /** Anti-aliased thick line with round caps. */
    line(xa, ya, xb, yb, width, c) {
        c = rgba(c);
        const hw = width / 2;
        const x0 = Math.max(0, Math.floor(Math.min(xa, xb) - hw - 1)), x1 = Math.min(this.w, Math.ceil(Math.max(xa, xb) + hw + 1));
        const y0 = Math.max(0, Math.floor(Math.min(ya, yb) - hw - 1)), y1 = Math.min(this.h, Math.ceil(Math.max(ya, yb) + hw + 1));
        const vx = xb - xa, vy = yb - ya, len2 = vx * vx + vy * vy || 1;
        for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
                const qx = px + 0.5 - xa, qy = py + 0.5 - ya;
                const t = clamp01((qx * vx + qy * vy) / len2);
                const ex = qx - vx * t, ey = qy - vy * t;
                const cov = clamp01(hw - Math.sqrt(ex * ex + ey * ey) + 0.5);
                if (cov > 0) this._blend(px, py, c, cov);
            }
        }
        return this;
    }

    /**
     * Filled convex polygon (quad / triangle), anti-aliased: coverage is the product of each
     * edge's distance ramp (as the GPU renderer does it). pts = [[x,y],...] in either order.
     */
    convex(pts, c) {
        c = rgba(c);
        const n = pts.length;
        let area = 0;
        for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
        if (Math.abs(area) < 1e-6) return this;
        const s = area > 0 ? 1 : -1, E = [];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.sqrt(ex * ex + ey * ey);
            if (l > 1e-6) { const nx = -ey / l * s, ny = ex / l * s; E.push([nx, ny, -(nx * a[0] + ny * a[1])]); }
            x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]);
        }
        for (let py = Math.max(0, Math.floor(y0) - 1); py < Math.min(this.h, Math.ceil(y1) + 1); py++) {
            for (let px = Math.max(0, Math.floor(x0) - 1); px < Math.min(this.w, Math.ceil(x1) + 1); px++) {
                const qx = px + 0.5, qy = py + 0.5;
                let cov = 1;
                for (let k = 0; k < E.length && cov > 0; k++) cov *= clamp01(E[k][0] * qx + E[k][1] * qy + E[k][2] + 0.5);
                if (cov > 0) this._blend(px, py, c, cov);
            }
        }
        return this;
    }
    quad(pts, c) { return this.convex(pts, c); }
    triangle(pts, c) { return this.convex(pts, c); }

    /** Polyline (e.g. a history trace). pts = [[x,y],...] */
    polyline(pts, width, c) {
        for (let i = 1; i < pts.length; i++) this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], width, c);
        return this;
    }

    /** Fill the area under a trace down to baseline y (for sparkline glow). */
    fillUnder(pts, baseY, c) {
        c = rgba(c);
        for (let i = 1; i < pts.length; i++) {
            const [xa, ya] = pts[i - 1], [xb, yb] = pts[i];
            for (let px = Math.floor(xa); px < Math.ceil(xb); px++) {
                const t = xb === xa ? 0 : (px + 0.5 - xa) / (xb - xa);
                const top = ya + (yb - ya) * clamp01(t);
                this.fillRect(px, top, 1, baseY - top, c);
            }
        }
        return this;
    }

    /**
     * Text. font = family name baked by kit/tools/bake_fonts.py ('label', 'num').
     * align: 'left' | 'center' | 'right'; y is the BASELINE.
     * Returns the drawn width in px.
     */
    text(str, x, y, size, c, opts) {
        opts = opts || {};
        const f = fonts.get(opts.font || 'label', size);
        if (!f) return 0;
        c = rgba(c);
        const scale = size / f.size;
        const s = String(str);
        const w = fonts.measure(f, s) * scale + (opts.spacing || 0) * Math.max(0, s.length - 1);
        let pen = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x;
        for (const ch of s) {
            const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63];
            if (!g) continue;
            const [gx, gy, gw, gh, ox, oy, adv] = g;
            if (gw && gh) this._blit(f, gx, gy, gw, gh, pen + ox * scale, y + oy * scale, scale, c);
            pen += adv * scale + (opts.spacing || 0);
        }
        return w;
    }

    textWidth(str, size, opts) {
        const f = fonts.get((opts && opts.font) || 'label', size);
        return f ? fonts.measure(f, String(str)) * (size / f.size) + ((opts && opts.spacing) || 0) * Math.max(0, String(str).length - 1) : 0;
    }

    /** Blit an alpha glyph from the atlas, scaled (bilinear) and tinted. */
    _blit(f, gx, gy, gw, gh, dx, dy, scale, c) {
        const A = f.alpha, AW = f.atlasW;
        const tw = gw * scale, th = gh * scale;
        const x0 = Math.floor(dx), y0 = Math.floor(dy);
        for (let py = Math.max(0, y0); py < Math.min(this.h, Math.ceil(dy + th)); py++) {
            const sy = (py + 0.5 - dy) / scale - 0.5;
            for (let px = Math.max(0, x0); px < Math.min(this.w, Math.ceil(dx + tw)); px++) {
                const sx = (px + 0.5 - dx) / scale - 0.5;
                const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
                const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= gw || yy >= gh) ? 0 : A[(gy + yy) * AW + gx + xx];
                const v = scale === 1
                    ? at(Math.round(sx), Math.round(sy))
                    : at(ix, iy) * (1 - fx) * (1 - fy) + at(ix + 1, iy) * fx * (1 - fy) + at(ix, iy + 1) * (1 - fx) * fy + at(ix + 1, iy + 1) * fx * fy;
                if (v > 0) this._blend(px, py, c, v / 255);
            }
        }
    }

    /**
     * Encode as PNG (RGBA, 8 bit). Level 1 (default) is the fastest zlib setting: about
     * half the encode time of level 4 for a slightly larger file.
     */
    png(level) {
        const w = this.w, h = this.h, d = this.d;
        // RGBA rows as they are, copied natively. Packing opaque frames to RGB in a JS loop
        // (832k pixels) took longer on the head unit than the extra quarter of data costs deflate:
        // ~50 ms per frame there; on a PC 9.6 -> 6.1 ms for a 9 % larger file.
        const stride = w * 4 + 1, raw = Buffer.allocUnsafe(stride * h);
        const src = Buffer.from(d.buffer, d.byteOffset, d.length);
        for (let y = 0; y < h; y++) { raw[y * stride] = 0; src.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
        const chunk = (type, body) => {
            const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
            const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
            const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0, 0);
            return Buffer.concat([len, tb, crc]);
        };
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
        ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;             // 8 bit RGBA
        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', ihdr),
            chunk('IDAT', zlib.deflateSync(raw, { level: level == null ? 1 : level })),
            chunk('IEND', Buffer.alloc(0)),
        ]);
    }
}

let CRC_T = null;
function crc32(buf) {
    if (!CRC_T) {
        CRC_T = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_T[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return c ^ -1;
}

module.exports = { Canvas, rgba, mix, ramp, withAlpha, RAD };
