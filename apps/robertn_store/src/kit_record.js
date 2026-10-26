'use strict';
/**
 * record.js - the drawing surface apps draw on: same methods as canvas.js, but every call is
 * recorded as a compact command (32-bit words, see kit/renderd/src/proto.h) instead of being
 * rasterised in JavaScript.
 *
 * A recording is then either
 *   - sent to mgu-renderd, which draws it on the GPU straight onto the screen (60 fps), or
 *   - played back into a canvas.js Canvas (play()) and handed to the HMI as a PNG - the
 *     fallback when the renderer is not running, and what the PC preview uses.
 *
 * Recording a whole frame costs well under a millisecond; nothing here touches pixels.
 */
const { Canvas, rgba } = require('./kit_canvas.js');
const fonts = require('./kit_fonts.js');

const OP = {
    CLEAR: 1, RECT: 2, GRAD: 3, RRECT: 4, RSTROKE: 5, CARD: 6, RAMPRECT: 7, ARC: 8, LINE: 9,
    TRIS: 10, GLYPHS: 11, LAYER: 12, CLIP: 13, NOCLIP: 14, QUAD: 15, ALPHA: 16, XF: 17, IMAGE: 18,
};

/* ---------- colours: 0xRRGGBBAA ---------- */
const packCache = new Map();
function pack(c) {
    if (typeof c === 'number') return c >>> 0;
    if (typeof c === 'string') {
        let v = packCache.get(c);
        if (v === undefined) { const a = rgba(c); v = (((a[0] & 255) << 24) | ((a[1] & 255) << 16) | ((a[2] & 255) << 8) | (a[3] & 255)) >>> 0; packCache.set(c, v); }
        return v;
    }
    const a = rgba(c);
    return ((((Math.round(a[0]) & 255) << 24) | ((Math.round(a[1]) & 255) << 16) | ((Math.round(a[2]) & 255) << 8) | (Math.round(a[3]) & 255)) >>> 0);
}
function unpack(v) { return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }

/* ---------- registries shared by recorders and the transports ---------- */
// colour ramps: stops array -> id
const rampIds = new Map(), rampList = [];
function rampId(stops) {
    const key = stops.join(',');
    let id = rampIds.get(key);
    if (id === undefined) { id = rampList.length + 1; rampIds.set(key, id); rampList[id] = stops.map((s) => (typeof s === 'string' ? s : rgba(s))); }
    return id;
}
// glyph atlases: font object (family+size) -> id
const atlasIds = new Map(), atlasList = [];
function atlasId(f, family) {
    let id = atlasIds.get(f);
    if (id === undefined) {
        // stable across runs and apps (the daemon shares atlases by id): family + size
        id = 0;
        const k = family + '@' + f.size;
        for (let i = 0; i < k.length; i++) id = (Math.imul(id, 31) + k.charCodeAt(i)) >>> 0;
        id = (id | 1) >>> 0;
        atlasIds.set(f, id); atlasList.push({ id, f });
    }
    return id;
}
function atlasById(id) { const a = atlasList.find((x) => x.id === id); return a ? a.f : null; }

// cached layers (static parts of widgets): drawn once, used by id
let layerSeq = 0;
const layerById = new Map();

// pictures (png.js decode): kept here as straight RGBA, uploaded by the transport when a frame uses them
let imageSeq = 0;
const imageById = new Map();
function makeImage(w, h, data) {
    // the renderer drops an app that sends a bad picture: refuse it here instead
    if (!(Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1 && w <= 1024 && h <= 1024 && data && data.length === w * h * 4)) throw new Error(`makeImage: ${w} x ${h} px (1..1024) with ${data && data.length} bytes`);
    const img = { imageId: ++imageSeq, w, h, data };
    imageById.set(img.imageId, img);
    return img;
}
function dropImage(img) { imageById.delete(img.imageId); }

class Recorder {
    /**
     * w, h: logical size. opts.textScale: device pixels per logical pixel (text then uses the
     * glyph size it will really be shown at, so scaled-up text stays sharp).
     */
    constructor(w, h, opts) {
        this.w = w | 0; this.h = h | 0;
        this.textScale = (opts && opts.textScale) || 1;
        this.buf = new ArrayBuffer(65536);
        this.f = new Float32Array(this.buf);
        this.u = new Uint32Array(this.buf);
        this.n = 0;
        this.layersUsed = null;      // Set of layer ids this recording draws
        this.atlases = new Set();    // glyph atlases and colour ramps it uses (uploaded once by the transport)
        this.ramps = new Set();
        this.images = null;          // Set of picture ids it draws, and the word index of each OP.IMAGE
        this.imageAt = null;
        this.recording = true;
    }
    reset() {
        this.n = 0; if (this.layersUsed) this.layersUsed.clear(); this.atlases.clear(); this.ramps.clear();
        this.images = this.imageAt = null;
        return this;
    }
    _grow(k) {
        if (this.n + k <= this.u.length) return;
        let len = this.u.length * 2;
        while (len < this.n + k) len *= 2;
        const nb = new ArrayBuffer(len * 4);
        new Uint32Array(nb).set(this.u.subarray(0, this.n));
        this.buf = nb; this.f = new Float32Array(nb); this.u = new Uint32Array(nb);
    }
    /** the recorded words (a view, valid until the next draw call) */
    words() { return this.u.subarray(0, this.n); }

    /* ---------- canvas.js API ---------- */
    clear(c) { this._grow(2); this.u[this.n++] = OP.CLEAR; this.u[this.n++] = pack(c || [0, 0, 0, 0]); return this; }

    fillRect(x, y, w, h, c) {
        if (!(w > 0 && h > 0)) return this;
        this._grow(6); const f = this.f, i = this.n;
        this.u[i] = OP.RECT; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; this.u[i + 5] = pack(c);
        this.n += 6; return this;
    }
    gradientRect(x, y, w, h, stops) { return this._grad(OP.GRAD, x, y, w, h, 0, stops); }
    card(x, y, w, h, r, stops) { return this._grad(OP.CARD, x, y, w, h, r, stops); }
    _grad(op, x, y, w, h, r, stops) {
        const k = stops.length, card = op === OP.CARD;
        this._grow(7 + k * 2); const f = this.f; let i = this.n;
        this.u[i++] = op; f[i++] = x; f[i++] = y; f[i++] = w; f[i++] = h;
        if (card) f[i++] = r;
        this.u[i++] = k;
        for (const s of stops) { f[i++] = s[0]; this.u[i++] = pack(s[1]); }
        this.n = i; return this;
    }
    roundRect(x, y, w, h, r, c) {
        if (!(w > 0 && h > 0)) return this;
        this._grow(7); const f = this.f, i = this.n;
        this.u[i] = OP.RRECT; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; f[i + 5] = r; this.u[i + 6] = pack(c);
        this.n += 7; return this;
    }
    strokeRoundRect(x, y, w, h, r, width, c) {
        this._grow(8); const f = this.f, i = this.n;
        this.u[i] = OP.RSTROKE; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; f[i + 5] = r; f[i + 6] = width; this.u[i + 7] = pack(c);
        this.n += 8; return this;
    }
    rampRect(x, y, w, h, r, stops, spanX, spanW) {
        if (!(w > 0 && h > 0)) return this;
        this._grow(9); const f = this.f, i = this.n;
        this.u[i] = OP.RAMPRECT; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; f[i + 5] = r;
        const rid = rampId(stops); this.ramps.add(rid);
        this.u[i + 6] = rid; f[i + 7] = spanX == null ? x : spanX; f[i + 8] = spanW == null ? w : spanW;
        this.n += 9; return this;
    }
    circle(cx, cy, r, c) { return this.arc(cx, cy, 0, r, 0, 360, c); }
    arc(cx, cy, r0, r1, a0, a1, c, opts) {
        this._grow(12); const f = this.f, i = this.n;
        const ramp = opts && opts.ramp;
        let flags = opts && opts.round ? 1 : 0, rf = 0, rt = 0, rid = 0;
        if (ramp) {
            flags |= 2; rid = rampId(ramp); this.ramps.add(rid);
            rf = opts.rampFrom == null ? Math.min(a0, a1) : opts.rampFrom;
            rt = opts.rampTo == null ? Math.max(a0, a1) : opts.rampTo;
        }
        this.u[i] = OP.ARC; f[i + 1] = cx; f[i + 2] = cy; f[i + 3] = r0; f[i + 4] = r1; f[i + 5] = a0; f[i + 6] = a1;
        this.u[i + 7] = pack(c || [0, 0, 0, 0]); this.u[i + 8] = flags; this.u[i + 9] = rid; f[i + 10] = rf; f[i + 11] = rt;
        this.n += 12; return this;
    }
    line(xa, ya, xb, yb, width, c) {
        this._grow(7); const f = this.f, i = this.n;
        this.u[i] = OP.LINE; f[i + 1] = xa; f[i + 2] = ya; f[i + 3] = xb; f[i + 4] = yb; f[i + 5] = width; this.u[i + 6] = pack(c);
        this.n += 7; return this;
    }
    polyline(pts, width, c) {
        const col = pack(c);
        for (let i = 1; i < pts.length; i++) this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], width, col);
        return this;
    }
    /** Filled convex quad (anti-aliased), points in order: [[x,y] x4] */
    quad(pts, c) {
        this._grow(10); const f = this.f; let i = this.n;
        this.u[i++] = OP.QUAD;
        for (let k = 0; k < 4; k++) { f[i++] = pts[k][0]; f[i++] = pts[k][1]; }
        this.u[i++] = pack(c);
        this.n = i; return this;
    }
    /** Area under a trace down to baseY (two triangles per segment). */
    fillUnder(pts, baseY, c) {
        if (pts.length < 2) return this;
        const col = pack(c), k = (pts.length - 1) * 2;
        this._grow(2 + k * 9); const f = this.f, u = this.u; let i = this.n;
        u[i++] = OP.TRIS; u[i++] = k;
        for (let s = 1; s < pts.length; s++) {
            const xa = pts[s - 1][0], ya = pts[s - 1][1], xb = pts[s][0], yb = pts[s][1];
            f[i++] = xa; f[i++] = ya; u[i++] = col; f[i++] = xb; f[i++] = yb; u[i++] = col; f[i++] = xb; f[i++] = baseY; u[i++] = col;
            f[i++] = xa; f[i++] = ya; u[i++] = col; f[i++] = xb; f[i++] = baseY; u[i++] = col; f[i++] = xa; f[i++] = baseY; u[i++] = col;
        }
        this.n = i; return this;
    }
    /** Global opacity (0..1) for what follows; 1 to end. */
    alpha(a) { this._grow(2); this.u[this.n++] = OP.ALPHA; this.f[this.n++] = a; return this; }
    /**
     * Transform for what follows: device px = v * s + (ox, oy); xf() = back to the placement's.
     * Used by the display for the screen chrome (header, menu bar) drawn in screen pixels.
     */
    xf(s, ox, oy) { this._grow(4); const f = this.f, i = this.n; this.u[i] = OP.XF; f[i + 1] = s || 0; f[i + 2] = ox || 0; f[i + 3] = oy || 0; this.n += 4; return this; }
    /** Append another recording (its fonts, ramps and layers come along). */
    append(r) {
        const w = r.words(), at = this.n;
        this._grow(w.length); this.u.set(w, this.n); this.n += w.length;
        r.atlases.forEach((a) => this.atlases.add(a)); r.ramps.forEach((a) => this.ramps.add(a));
        if (r.layersUsed) r.layersUsed.forEach((id) => (this.layersUsed || (this.layersUsed = new Set())).add(id));
        if (r.images) {
            r.images.forEach((id) => (this.images || (this.images = new Set())).add(id));
            r.imageAt.forEach((i) => (this.imageAt || (this.imageAt = [])).push(at + i));
        }
        return this;
    }
    clip(x, y, w, h) { this._grow(5); const f = this.f, i = this.n; this.u[i] = OP.CLIP; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; this.n += 5; return this; }
    noclip() { this._grow(1); this.u[this.n++] = OP.NOCLIP; return this; }

    /** Text; y is the baseline. Returns the width in logical px (as canvas.js). */
    text(str, x, y, size, c, opts) {
        opts = opts || {};
        const family = opts.font || 'label';
        const f = fonts.get(family, size * this.textScale);
        if (!f) return 0;
        const s = String(str), sc = size / f.size, sp = opts.spacing || 0;
        const w = fonts.measure(f, s) * sc + sp * Math.max(0, s.length - 1);
        let pen = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x;
        let cnt = 0;
        const head = this.n;
        this._grow(4 + s.length * 8);
        const fl = this.f, u = this.u;
        let i = head + 4;
        for (const ch of s) {
            const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63];
            if (!g) continue;
            const gx = g[0], gy = g[1], gw = g[2], gh = g[3];
            if (gw && gh) {
                fl[i++] = pen + g[4] * sc; fl[i++] = y + g[5] * sc; fl[i++] = gw * sc; fl[i++] = gh * sc;
                fl[i++] = gx; fl[i++] = gy; fl[i++] = gx + gw; fl[i++] = gy + gh;
                cnt++;
            }
            pen += g[6] * sc + sp;
        }
        if (cnt) {
            const aid = atlasId(f, family); this.atlases.add(aid);
            u[head] = OP.GLYPHS; u[head + 1] = aid; u[head + 2] = pack(c); u[head + 3] = cnt;
            this.n = i;
        }
        return w;
    }
    textWidth(str, size, opts) {
        const f = fonts.get((opts && opts.font) || 'label', size * this.textScale);
        const s = String(str);
        return f ? fonts.measure(f, s) * (size / f.size) + ((opts && opts.spacing) || 0) * Math.max(0, s.length - 1) : 0;
    }

    /** Picture (makeImage) stretched over x, y, w, h; corner radius r (0 = square). Renderer protocol 3. */
    image(img, x, y, w, h, r) {
        if (!img || img.imageId === undefined || !(w > 0 && h > 0)) return this;
        this._grow(7); const f = this.f, i = this.n;
        // same layout as OP.RRECT (x y w h r colour): for an older renderer the transport swaps in a plain tile
        this.u[i] = OP.IMAGE; f[i + 1] = x; f[i + 2] = y; f[i + 3] = w; f[i + 4] = h; f[i + 5] = r || 0; this.u[i + 6] = img.imageId;
        this.n += 7;
        (this.images || (this.images = new Set())).add(img.imageId);
        (this.imageAt || (this.imageAt = [])).push(i);
        return this;
    }

    /** Draw a cached layer (see layer()) at x, y. Canvas layers (old code) are not supported. */
    blit(L, x, y) {
        if (!L || L.layerId === undefined) throw new Error('Recorder.blit: not a layer');
        this._grow(4); const i = this.n;
        this.u[i] = OP.LAYER; this.u[i + 1] = L.layerId; this.f[i + 2] = Math.round(x); this.f[i + 3] = Math.round(y);
        this.n += 4;
        (this.layersUsed || (this.layersUsed = new Set())).add(L.layerId);
        return this;
    }
}

/**
 * A cached layer: draw(recorder) once into a w x h recording. Returned object is passed to
 * Recorder.blit(). The transport uploads it to the renderer (drawn into a texture there) or
 * plays it into a Canvas once for the software path.
 */
function makeLayer(w, h, draw, textScale) {
    const r = new Recorder(Math.ceil(w), Math.ceil(h), { textScale });
    draw(r);
    const L = { layerId: ++layerSeq, w: r.w, h: r.h, words: r.words().slice(), soft: null, sublayers: r.layersUsed, atlases: r.atlases, ramps: r.ramps,
        images: r.images, imageAt: r.imageAt };
    layerById.set(L.layerId, L);
    return L;
}
function dropLayer(L) { layerById.delete(L.layerId); }

/* ---------- software playback (canvas.js) ---------- */
function softLayer(L) {
    if (!L.soft) { L.soft = new Canvas(L.w, L.h); play(L.words, L.soft); }
    return L.soft;
}

const NOP = new Proxy({}, { get: () => () => 0 });

/**
 * Execute recorded words onto a canvas.js Canvas. Parts drawn under an xf() transform (the
 * GPU screen chrome, in screen pixels) are skipped: they don't belong on the app's image.
 */
function play(words, real) {
    let cv = real;
    const u = words instanceof Uint32Array ? words : new Uint32Array(words);
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    let alpha = 1;
    const col = (v) => { const a = unpack(v); if (alpha < 1) a[3] = Math.round(a[3] * alpha); return a; };
    let clip = null;
    let i = 0;
    const n = u.length;
    while (i < n) {
        const op = u[i++];
        switch (op) {
        case OP.CLEAR: cv.clear(unpack(u[i])); i += 1; break;
        case OP.RECT: cv.fillRect(f[i], f[i + 1], f[i + 2], f[i + 3], col(u[i + 4])); i += 5; break;
        case OP.GRAD: case OP.CARD: {
            const card = op === OP.CARD, x = f[i], y = f[i + 1], w = f[i + 2], h = f[i + 3], r = card ? f[i + 4] : 0;
            const k = u[i + (card ? 5 : 4)]; i += card ? 6 : 5;
            const st = [];
            for (let s = 0; s < k; s++) st.push([f[i + s * 2], col(u[i + s * 2 + 1])]);
            i += k * 2;
            if (card) cv.card(x, y, w, h, r, st); else cv.gradientRect(x, y, w, h, st);
            break;
        }
        case OP.RRECT: cv.roundRect(f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], col(u[i + 5])); i += 6; break;
        case OP.RSTROKE: cv.strokeRoundRect(f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5], col(u[i + 6])); i += 7; break;
        case OP.RAMPRECT: cv.rampRect(f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], rampList[u[i + 5]] || ['#fff'], f[i + 6], f[i + 7]); i += 8; break;
        case OP.ARC: {
            const flags = u[i + 7];
            const opts = { round: !!(flags & 1) };
            if (flags & 2) { opts.ramp = rampList[u[i + 8]]; opts.rampFrom = f[i + 9]; opts.rampTo = f[i + 10]; }
            cv.arc(f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5], col(u[i + 6]), opts);
            i += 11; break;
        }
        case OP.LINE: cv.line(f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], col(u[i + 5])); i += 6; break;
        case OP.QUAD: cv.quad([[f[i], f[i + 1]], [f[i + 2], f[i + 3]], [f[i + 4], f[i + 5]], [f[i + 6], f[i + 7]]], col(u[i + 8])); i += 9; break;
        case OP.TRIS: {
            const k = u[i++];
            for (let t = 0; t < k; t++) {
                const b = i + t * 9;
                cv.triangle([[f[b], f[b + 1]], [f[b + 3], f[b + 4]], [f[b + 6], f[b + 7]]], col(u[b + 2]));
            }
            i += k * 9; break;
        }
        case OP.GLYPHS: {
            const fo = atlasById(u[i]), c = col(u[i + 1]), k = u[i + 2]; i += 3;
            if (fo) for (let g = 0; g < k; g++) {
                const b = i + g * 8, gw = f[b + 6] - f[b + 4], gh = f[b + 7] - f[b + 5];
                cv._blit(fo, f[b + 4], f[b + 5], gw, gh, f[b], f[b + 1], f[b + 2] / gw, c);
            }
            i += k * 8; break;
        }
        case OP.LAYER: { const L = layerById.get(u[i]); if (L) cv.blit(softLayer(L), f[i + 1], f[i + 2]); i += 3; break; }
        case OP.IMAGE: { const img = imageById.get(u[i + 5]); if (img) cv.image(img, f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], alpha); i += 6; break; }
        case OP.CLIP: clip = [f[i], f[i + 1], f[i + 2], f[i + 3]]; i += 4; break;     // (software path: ignored)
        case OP.NOCLIP: clip = null; break;
        case OP.ALPHA: alpha = f[i]; i += 1; break;
        case OP.XF: cv = f[i] > 0 ? NOP : real; i += 3; break;
        default: return real;
        }
    }
    void clip;
    return real;
}

module.exports = { Recorder, OP, pack, unpack, rampId, rampList, atlasId, atlasList, atlasById, makeLayer, dropLayer, layerById,
    makeImage, dropImage, imageById, play, softLayer };
