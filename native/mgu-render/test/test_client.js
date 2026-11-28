'use strict';
// js/mgu_render_client.js and the whole-screen embed: X_READY offers 'full' with its box only with CAP_EMBED_FULL and
// the longer X_READY; mode('full') asks with X_MODE 2 1, 'embed' and 'layer' with the one word as before.
const assert = require('assert');
const { RenderClient } = require('../js/mgu_render_client');

let pass = 0;
const ok = (what, f) => { f(); pass++; console.log(`ok   ${what}`); };
const X_MODE = 0x4d520001, X_READY = 0x4d520101;
const ready = (caps, full) => {
    const w = [1, 3, caps, 104, 88, 1796, 632, 108, 82, 1790, 638, 4096, 60000].concat(full ? [0, 0, 1920, 720] : []);
    const b = Buffer.alloc(w.length * 4);
    w.forEach((v, i) => b.writeUInt32LE(v, i * 4));
    return b;
};
const client = () => {
    const c = new RenderClient('test_app', { warn() {}, info() {}, error() {} });
    c.sent = [];
    c._write = (b) => c.sent.push(b);
    return c;
};
const modeMsgs = (c) => c.sent.filter((b) => b.readUInt32LE(0) === X_MODE)
    .map((b) => Array.from({ length: b.readUInt32LE(4) / 4 }, (_, i) => b.readUInt32LE(8 + i * 4)));

ok('the whole screen offered: modes and its box', () => {
    const c = client();
    c._event(X_READY, ready(8 | 512, true));
    assert.deepStrictEqual(c.info.modes, ['layer', 'embed', 'full']);
    assert.deepStrictEqual(c.info.fullBox, { x: 0, y: 0, w: 1920, h: 720 });
    assert.deepStrictEqual(c.info.embedBox, { x: 104, y: 88, w: 1796, h: 632 });
});
ok('not offered (an older renderer, or no whole-screen template): no full, no box', () => {
    const c = client();
    c._event(X_READY, ready(8, false));
    assert.deepStrictEqual(c.info.modes, ['layer', 'embed']);
    assert.strictEqual(c.info.fullBox, null);
});
ok('X_MODE: full is 2 1; embed and layer one word, as before', () => {
    const c = client();
    c._event(X_READY, ready(8 | 512, true));
    c.ready = true;
    c.mode('full'); c.mode('embed'); c.mode('layer');
    assert.deepStrictEqual(modeMsgs(c), [[2, 1], [2], [1]]);
    assert.throws(() => c.mode('wide'));
});
console.log(`test_client: ${pass} checks pass`);
