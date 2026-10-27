'use strict';
/**
 * Offline check of src/qr.js: the PNG's structure and size, and the
 * caption font. With zbarimg on the PATH (or ZBARIMG set), each picture is
 * also decoded back to its text. Node 8+.
 *
 *   node tools/test_qr.js
 */
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { qrPng, captionPixels, crc32 } = require('../src/qr.js');

function chunks(png) {
    assert.strictEqual(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
    const out = [];
    for (let o = 8; o < png.length;) {
        const len = png.readUInt32BE(o);
        const type = png.slice(o + 4, o + 8).toString('ascii');
        const data = png.slice(o + 8, o + 8 + len);
        assert.strictEqual(png.readUInt32BE(o + 8 + len), crc32(png.slice(o + 4, o + 8 + len)), `${type} crc`);
        out.push({ type, data });
        o += 12 + len;
    }
    return out;
}

const URL_LOGIN = 'https://github.com/login/device';
const URL_PHONE = 'http://172.16.222.97:8470/#t=0123456789abcdef0123456789abcdef';
const pictures = [
    [URL_LOGIN, qrPng(URL_LOGIN, { caption: 'ABCD-1234' })],
    [URL_PHONE, qrPng(URL_PHONE)]
];
pictures.forEach(([text, r]) => {
    const c = chunks(r.png);
    assert.deepStrictEqual(c.map((x) => x.type), ['IHDR', 'IDAT', 'IEND']);
    assert.strictEqual(c[0].data.readUInt32BE(0), r.width);
    assert.strictEqual(c[0].data.readUInt32BE(4), r.height);
    assert(r.height <= 320, `${text}: ${r.height} px high`);
    assert.strictEqual(zlib.inflateSync(c[1].data).length, (r.width * 4 + 1) * r.height);
});
assert(pictures[0][1].width > pictures[0][1].height, 'the caption widens the picture');
assert.strictEqual(pictures[1][1].width, pictures[1][1].height, 'no caption: square');

// every character a GitHub user code uses has a glyph
'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'.split('').forEach((ch) =>
    assert(captionPixels(ch).length > 0, `glyph ${ch}`));
assert.strictEqual(captionPixels('-').length, 5);
assert.strictEqual(captionPixels('I').length, 2 * 3 + 5);

const zbar = process.env.ZBARIMG || 'zbarimg';
let decoded = 0;
if (cp.spawnSync(zbar, ['--version']).status === 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-qr-'));
    pictures.forEach(([text, r], i) => {
        const file = path.join(dir, `${i}.png`);
        fs.writeFileSync(file, r.png);
        const out = cp.execFileSync(zbar, ['--raw', '-q', file], { encoding: 'utf8' }).trim();
        assert.strictEqual(out, text);
        decoded += 1;
    });
}
console.log(`qr: ${pictures.length} pictures pass${decoded ? `, ${decoded} decoded` : ' (zbarimg not found: not decoded)'}`);
