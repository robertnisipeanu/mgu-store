'use strict';
/*
 * Synthetic sessions for test/replay.sh, written to DIR:
 *   upstream-doom.bin       upstream dialect: a 320x200 game picture each frame (IMAGE 9), GRAB 10,
 *                           IMAGE op in upstream's layout, scaled 3x with nearest pixels
 *   iterio-pictures.bin     iterio dialect: CLAIM 9, premultiplied pictures (IMAGE 10) with corner
 *                           radius, DROP_IMAGE 11
 *   iterio-over-bytes.bin   nine 1024x1024 pictures, over an app's 32 MB
 *   native-index8.bin       mgu-render/1 through js/mgu_render_client.js: an INDEX8 pixmap written in
 *                           regions, a palette change, drawn 1:1
 *   native-index8-ref.bin   the same pictures as iterio pictures (expanded here), for comparison
 *   native-rgba.bin / native-rgba-ref.bin   the same with an RGBA pixmap
 *
 *   node test/gen_sessions.js DIR
 */
const fs = require('fs');
const path = require('path');
const { RenderClient, imageOp } = require('../js/mgu_render_client');

const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });

function msg(type, payload) {
    const len = payload ? payload.length : 0;
    const b = Buffer.alloc(8 + len + ((4 - (len & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4);
    if (len) payload.copy(b, 8);
    return b;
}
const u32 = (a) => Buffer.from(new Uint32Array(a).buffer);
const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
const fbits = (v) => new Uint32Array(new Float32Array([v]).buffer)[0];
const place = (x, y, w, h, s) => msg(2, Buffer.concat([u32([x, y, w, h]), f32([s, 0, 0])]));
const OP = { CLEAR: 1, RECT: 2, RRECT: 4, IMAGE: 18 };
const ops = (list) => msg(7, u32(list));

/* a game-like picture: bands that move with the frame number */
function game(f) {
    const px = Buffer.alloc(320 * 200 * 4);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
        const i = (y * 320 + x) * 4, v = (x + y * 2 + f * 7) & 255;
        px[i] = v; px[i + 1] = (x * 3) & 255; px[i + 2] = (y * 5 + f * 11) & 255; px[i + 3] = 255;
    }
    return px;
}

/* upstream */
{
    const out = [msg(1, Buffer.from('doom')), place(0, 0, 960, 600, 1)];
    for (let f = 0; f < 6; f++) {
        out.push(msg(9, Buffer.concat([u32([1, 320, 200]), game(f)])));
        out.push(msg(10, u32([1])));
        out.push(ops([OP.CLEAR, 0x101820ff, OP.IMAGE, 1, f, fbits(0), fbits(0), fbits(960), fbits(600),
            OP.RECT, fbits(10), fbits(10), fbits(100), fbits(20), 0xff0000ff]));
    }
    fs.writeFileSync(path.join(dir, 'upstream-doom.bin'), Buffer.concat(out));
}

/* iterio */
function picture(w, h, seed) {
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, a = (x * 255 / (w - 1)) | 0;
        const r = (y * 4 + seed) & 255, g = (x * 2) & 255, b = 200;
        px[i] = (r * a + 127) / 255; px[i + 1] = (g * a + 127) / 255; px[i + 2] = (b * a + 127) / 255; px[i + 3] = a;
    }
    return px;
}
{
    const claim = msg(9, Buffer.concat([u32([2]), f32([0, 0, 400, 300, 500, 100, 200, 200])]));
    const out = [msg(1, Buffer.from('pictures')), place(0, 0, 800, 480, 1.25), claim,
        msg(10, Buffer.concat([u32([5, 64, 64]), picture(64, 64, 3)])),
        msg(10, Buffer.concat([u32([6, 100, 30]), picture(100, 30, 9)]))];
    const frame = (both) => ops([OP.CLEAR, 0x202830ff, OP.RRECT, fbits(20), fbits(20), fbits(300), fbits(200), fbits(18), 0x3d9bffff,
        OP.IMAGE, fbits(40), fbits(40), fbits(128), fbits(128), fbits(24), 5].concat(both ?
        [OP.IMAGE, fbits(200), fbits(60), fbits(200), fbits(60), fbits(0), 6] : []));
    out.push(frame(true), frame(true), msg(11, u32([6])), frame(true), frame(false));
    fs.writeFileSync(path.join(dir, 'iterio-pictures.bin'), Buffer.concat(out));
    /* nine 1024x1024 pictures: over the 32 MB an app may hold; the frame still draws */
    const over = [msg(1, Buffer.from('over-bytes')), place(0, 0, 200, 100, 1)];
    for (let i = 0; i < 9; i++) over.push(msg(10, Buffer.concat([u32([i + 1, 1024, 1024]), picture(1024, 1024, i)])));
    over.push(ops([OP.CLEAR, 0x000000ff, OP.IMAGE, fbits(0), fbits(0), fbits(200), fbits(100), fbits(0), 1]));
    fs.writeFileSync(path.join(dir, 'iterio-over-bytes.bin'), Buffer.concat(over));
}

/* native pixmaps, and the same pictures as iterio pictures */
function native(name, format) {
    const file = path.join(dir, `native-${name}.bin`);
    const gpu = new RenderClient('native-' + name, { info() {}, warn() {} }, { file });
    gpu.connect();
    gpu.place({ x: 0, y: 0, w: 640, h: 400, scale: 1, ox: 0, oy: 0 });
    const bpp = format === 'index8' ? 1 : 4;
    const data = Buffer.alloc(320 * 200 * bpp);
    let pal = Buffer.alloc(768);
    const setPal = (k) => { for (let i = 0; i < 256; i++) { pal[i * 3] = (i * k) & 255; pal[i * 3 + 1] = 255 - i; pal[i * 3 + 2] = (i * 7) & 255; } };
    const fill = (x0, y0, w, h, f) => {
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
            const v = (x * 3 + y + f * 40) & 255, i = (y * 320 + x) * bpp;
            if (bpp === 1) data[i] = v; else { data[i] = v; data[i + 1] = (255 - v); data[i + 2] = (x + f) & 255; data[i + 3] = 255; }
        }
    };
    const ref = [msg(1, Buffer.from('native-' + name + '-ref')), place(0, 0, 640, 400, 1)];
    const expand = () => {
        const px = Buffer.alloc(320 * 200 * 4);
        for (let i = 0; i < 320 * 200; i++) {
            if (bpp === 1) { const c = data[i] * 3; px[i * 4] = pal[c]; px[i * 4 + 1] = pal[c + 1]; px[i * 4 + 2] = pal[c + 2]; px[i * 4 + 3] = 255; }
            else data.copy(px, i * 4, i * 4, i * 4 + 4);
        }
        return px;
    };
    const frameOps = () => {
        const u = new Uint32Array([OP.CLEAR, 0x000000ff].concat(Array.from(imageOp(1, 160, 100, 320, 200, 0))));
        gpu.frameWords(u);
        ref.push(msg(10, Buffer.concat([u32([1, 320, 200]), expand()])), msg(7, Buffer.from(u.buffer)));
    };
    gpu.pixmap(1, 320, 200, format, 'nearest');
    setPal(1);
    if (bpp === 1) gpu.palette(1, pal);
    fill(0, 0, 320, 200, 0);
    gpu.pixels(1, [{ x: 0, y: 0, w: 320, h: 200 }], data);
    frameOps();
    fill(10, 20, 50, 40, 1); fill(200, 150, 120, 50, 2);
    gpu.pixels(1, [{ x: 10, y: 20, w: 50, h: 40 }, { x: 200, y: 150, w: 120, h: 50 }], data);
    frameOps();
    if (bpp === 1) { pal = Buffer.alloc(768); setPal(5); gpu.palette(1, pal); }
    fill(0, 199, 320, 1, 3);
    gpu.pixels(1, [{ x: 0, y: 199, w: 320, h: 1 }], data);
    frameOps();
    gpu.close();
    fs.writeFileSync(path.join(dir, `native-${name}-ref.bin`), Buffer.concat(ref));
}
native('index8', 'index8');
native('rgba', 'rgba');
console.log('sessions in ' + dir);
