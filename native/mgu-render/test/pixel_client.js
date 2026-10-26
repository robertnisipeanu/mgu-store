'use strict';
/*
 * A game-like native client for the emulator and the car: a 320x200 INDEX8 pixmap redrawn in
 * regions at 35 Hz (as DOOM does), its palette cycled, a touch claim over the picture.
 *
 *   node pixel_client.js [--mode embed|layer] [--seconds N] [--socket PATH]
 *
 * Logs READY's offer, every state change and touch, and the presented rate each second
 * (one line: "fps <ticks per second> stats <renderer fps/avg us>").
 */
const { RenderClient, imageOp } = require('../js/mgu_render_client');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const mode = arg('--mode', 'embed'), seconds = Number(arg('--seconds', 0));
const log = { info: (m) => console.log(m), warn: (m) => console.log('warn: ' + m) };
const W = 320, H = 200;
const px = Buffer.alloc(W * H);
const pal = Buffer.alloc(768);
for (let i = 0; i < 256; i++) { pal[i * 3] = i; pal[i * 3 + 1] = (i * 3) & 255; pal[i * 3 + 2] = 255 - i; }

const gpu = new RenderClient('pixel_client', log, { mode, socket: arg('--socket') });
let box = null, ticks = 0, frame = 0, scale = 1;
gpu.on('ready', (screen, info) => {
    console.log('ready ' + JSON.stringify({ screen, info }));
    if (!info) { console.log('not mgu-render: stopping'); process.exit(1); }
    if (gpu.mode() === 'embed' && info.modes.indexOf('embed') < 0) { console.log('embed not offered: layer'); gpu.mode('layer'); }
    box = gpu.mode() === 'embed' ? info.embedBox : info.appArea;
    scale = Math.min(box.w / W, box.h / H);
    gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, ox: 0, oy: 0 });
    gpu.pixmap(1, W, H, 'index8', 'nearest');
    gpu.palette(1, pal);
    gpu.pixels(1, [{ x: 0, y: 0, w: W, h: H }], px);
    gpu.claim([{ x: (box.w - W * scale) / 2, y: (box.h - H * scale) / 2, w: W * scale, h: H * scale }]);
    gpu.show(true);
});
gpu.on('state', (s) => console.log('state ' + JSON.stringify(s)));
gpu.on('touch', (phase, x, y) => console.log(`touch ${phase} ${x.toFixed(1)},${y.toFixed(1)}`));
gpu.on('closed', () => console.log('closed'));
gpu.on('renderer-error', (e) => console.log('error ' + e));
gpu.on('tick', () => { ticks++; });

/* the game tic: a band scrolls (two regions change), the palette rotates every 35 tics */
setInterval(() => {
    if (!box) return;
    frame++;
    const y0 = frame % (H - 20);
    for (let y = y0; y < y0 + 20; y++) for (let x = 0; x < W; x++) px[y * W + x] = (x + frame * 3) & 255;
    const yb = (y0 + 100) % (H - 10);
    for (let y = yb; y < yb + 10; y++) for (let x = 40; x < 280; x++) px[y * W + x] = (frame * 5 + y) & 255;
    gpu.pixels(1, [{ x: 0, y: y0, w: W, h: 20 }, { x: 40, y: yb, w: 240, h: 10 }], px);
    if (frame % 35 === 0) { pal.copyWithin(0, 3); gpu.palette(1, pal); }
    const w = W * scale, h = H * scale;
    gpu.frameWords(new Uint32Array([1, 0x000000ff].concat(Array.from(imageOp(1, (box.w - w) / 2, (box.h - h) / 2, w, h, 0)))));
}, 1000 / 35);
setInterval(() => {
    console.log(`fps ${ticks} stats ${gpu.stats ? gpu.stats.fps + '/' + gpu.stats.avgUs + 'us' : '-'}`);
    ticks = 0;
}, 1000);
if (seconds) setTimeout(() => { gpu.close(); process.exit(0); }, seconds * 1000);
gpu.connect();
