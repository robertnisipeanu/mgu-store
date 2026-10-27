'use strict';
/**
 * png.js - PNG -> { w, h, data } (RGBA, straight alpha, rows top-down) in plain JavaScript (node 8 on the head unit
 * has no image library). 8-bit grey, grey + alpha, RGB, RGBA; palette at 1/2/4/8 bits (+ tRNS); not interlaced;
 * 1..1024 px a side. Anything else throws an Error that says why.
 *
 *   decodeAsync(buf, cb)  inflates as a stream and stops once the data passes the size the header promises, so a
 *                         hostile file can't eat the memory on any node - for pictures from outside the app
 *   decode(buf)           synchronous; bounded the same way where node has maxOutputLength (node 12.19+, the PC),
 *                         unbounded on node 8 - there only for pictures the app ships itself
 *   fit(img, max)         box-filter a picture down so neither side is over max px (memory per picture stays small)
 */
const zlib = require('zlib');

const MAX = 1024;
const SIG = '89504e470d0a1a0a';
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// does this node honour maxOutputLength? (node 8 ignores the option and inflates the 2 bytes)
const BOUNDED = (() => { try { zlib.inflateSync(zlib.deflateSync(Buffer.alloc(2)), { maxOutputLength: 1 }); return false; } catch (e) { return true; } })();

/** Chunks and header -> what the pixel step needs; size = bytes the inflated data must have. */
function parse(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.toString('hex', 0, 8) !== SIG) throw new Error('png: not a PNG file');
    let off = 8, ihdr = null, plte = null, trns = null, end = false;
    const idat = [];
    while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), d = off + 8;
        if (d + len + 4 > buf.length) throw new Error(`png: ${type} chunk cut off`);
        const body = buf.slice(d, d + len);
        if (type === 'IHDR') ihdr = body;
        else if (type === 'PLTE') plte = body;
        else if (type === 'tRNS') trns = body;
        else if (type === 'IDAT') idat.push(body);
        else if (type === 'IEND') { end = true; break; }
        off = d + len + 4;
    }
    if (!ihdr || ihdr.length < 13 || !idat.length || !end) throw new Error('png: IHDR, IDAT or IEND missing');
    const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4), depth = ihdr[8], type = ihdr[9], ch = CHANNELS[type];
    if (!(w >= 1 && w <= MAX && h >= 1 && h <= MAX)) throw new Error(`png: ${w} x ${h} px (1..${MAX} a side)`);
    if (ihdr[12] !== 0) throw new Error('png: interlaced');
    if (!ch || !(depth === 8 || (type === 3 && (depth === 1 || depth === 2 || depth === 4)))) throw new Error(`png: colour type ${type} at ${depth} bit`);
    if (type === 3 && (!plte || plte.length < 3)) throw new Error('png: palette missing');
    const bits = ch * depth, stride = Math.ceil((w * bits) / 8);
    return { w, h, type, depth, plte, trns, stride, bpp: Math.max(1, bits >> 3), z: Buffer.concat(idat), size: h * (stride + 1) };
}

/** One unfiltered row -> RGBA at row y of out. */
function expand(p, row, out, y) {
    const { w, type, depth, plte, trns } = p;
    let o = y * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
        let r, g, b, a = 255;
        if (type === 6) { r = row[x * 4]; g = row[x * 4 + 1]; b = row[x * 4 + 2]; a = row[x * 4 + 3]; }
        else if (type === 2) {
            r = row[x * 3]; g = row[x * 3 + 1]; b = row[x * 3 + 2];
            if (trns && trns.length >= 6 && r === trns[1] && g === trns[3] && b === trns[5]) a = 0;
        } else if (type === 4) { r = g = b = row[x * 2]; a = row[x * 2 + 1]; }
        else if (type === 0) { r = g = b = row[x]; if (trns && trns.length >= 2 && r === trns[1]) a = 0; }
        else {
            const i = depth === 8 ? row[x] : (row[(x * depth) >> 3] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
            if (i * 3 + 2 >= plte.length) throw new Error(`png: colour ${i} not in the palette`);
            r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2];
            if (trns && i < trns.length) a = trns[i];
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
}

/** Inflated scanlines -> picture (undoes the filters in place). */
function pixels(p, raw) {
    if (raw.length !== p.size) throw new Error(`png: image data is ${raw.length} bytes, the header says ${p.size}`);
    const { w, h, stride, bpp } = p, out = new Uint8Array(w * h * 4);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const ft = raw[y * (stride + 1)], cur = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        if (ft > 4) throw new Error(`png: filter ${ft}`);
        if (ft) {
            for (let i = 0; i < stride; i++) {
                const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
                let v;
                if (ft === 1) v = a;
                else if (ft === 2) v = b;
                else if (ft === 3) v = (a + b) >> 1;
                else { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
                cur[i] = (cur[i] + v) & 255;
            }
        }
        expand(p, cur, out, y);
        prev = cur;
    }
    return { w, h, data: out };
}

function decode(buf) {
    const p = parse(buf);
    let raw;
    try { raw = zlib.inflateSync(p.z, BOUNDED ? { maxOutputLength: p.size } : {}); } catch (e) {
        throw new Error(e instanceof RangeError ? 'png: image data larger than the header says' : `png: ${e.message}`);
    }
    return pixels(p, raw);
}

function decodeAsync(buf, cb) {
    let p;
    try { p = parse(buf); } catch (e) { setImmediate(cb, e); return; }
    const inf = zlib.createInflate(), parts = [];
    let n = 0, done = false;
    const finish = (e, img) => { if (!done) { done = true; cb(e, img); } };
    inf.on('data', (d) => {
        n += d.length;
        if (n > p.size) { inf.destroy(); finish(new Error('png: image data larger than the header says')); return; }
        parts.push(d);
    });
    inf.on('error', (e) => finish(new Error(`png: ${e.message}`)));
    inf.on('end', () => {
        let img;
        try { img = pixels(p, Buffer.concat(parts, n)); } catch (e) { finish(e); return; }
        finish(null, img);
    });
    inf.end(p.z);
}

// ponytail: whole-pixel boxes (no fractional weights) - plenty for icons going down 2-8x
function fit(img, max) {
    const { w, h, data } = img, k = max / Math.max(w, h);
    if (k >= 1) return img;
    const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k)), out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
        const y0 = Math.floor((y * h) / nh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
        for (let x = 0; x < nw; x++) {
            const x0 = Math.floor((x * w) / nw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const i = (sy * w + sx) * 4, al = data[i + 3];       // weighted by alpha: no dark fringes
                    r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++;
                }
            }
            const o = (y * nw + x) * 4;
            if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
            out[o + 3] = Math.round(a / n);
        }
    }
    return { w: nw, h: nh, data: out };
}

module.exports = { decode, decodeAsync, fit, MAX, BOUNDED };
