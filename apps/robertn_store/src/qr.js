/**
 * A QR code as a PNG for the sign-in and Phone access pages: the text
 * encoded at error correction level M (raised when it fits) by the vendored
 * qrcodegen (LICENSE-qrcodegen.txt), drawn black on white with the standard
 * 4-module quiet zone, each module an integer number of pixels so the
 * picture stays sharp at most maxPx high. A caption (the GitHub sign-in
 * code: A-Z, 0-9, '-') is drawn large to the right of the code in a 5x7
 * pixel font. The PNG is RGBA, deflated, as the HMI shows the app's other
 * pictures.
 */
'use strict';

const zlib = require('zlib');
const qrcodegen = require('./qrcodegen.js');

const QUIET = 4;
const MAX_PX = 320;
const CAPTION_PX = 64;                  // caption glyph height

/* 5x7 glyphs, one hex byte per row, the low 5 bits left to right. */
const FONT = {
    0: '0e11131519110e', 1: '040c040404040e', 2: '0e11010204081f', 3: '1f02040201110e',
    4: '02060a121f0202', 5: '1f101e0101110e', 6: '0608101e11110e', 7: '1f010204080808',
    8: '0e11110e11110e', 9: '0e11110f01020c', A: '0e1111111f1111', B: '1e11111e11111e',
    C: '0e11101010110e', D: '1c12111111121c', E: '1f10101e10101f', F: '1f10101e101010',
    G: '0e11101711110f', H: '1111111f111111', I: '0e04040404040e', J: '0702020202120c',
    K: '11121418141211', L: '1010101010101f', M: '111b1515111111', N: '11111915131111',
    O: '0e11111111110e', P: '1e11111e101010', Q: '0e11111115120d', R: '1e11111e141211',
    S: '0f10100e01011e', T: '1f040404040404', U: '1111111111110e', V: '11111111110a04',
    W: '1111111515150a', X: '11110a040a1111', Y: '1111110a040404', Z: '1f01020408101f',
    '-': '0000001f000000'
};

const CRC_TABLE = (() => {
    const t = [];
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t.push(c >>> 0);
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/** { size, dark(x, y) } for text. */
function qrModules(text) {
    const code = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
    return { size: code.size, version: code.version, dark: (x, y) => code.getModule(x, y) };
}

/* The caption's dark pixels as [x, y] in font units (6 columns a glyph). */
function captionPixels(caption) {
    const out = [];
    String(caption).toUpperCase().split('').forEach((ch, i) => {
        const glyph = FONT[ch];
        for (let y = 0; glyph && y < 7; y += 1) {
            const bits = parseInt(glyph.substr(2 * y, 2), 16);
            for (let x = 0; x < 5; x += 1) {
                if (bits & (0x10 >> x)) {
                    out.push([6 * i + x, y]);
                }
            }
        }
    });
    return out;
}

/** { png: Buffer, width, height, modules, scale } for text, with an
 * optional caption to the right of the code. */
function qrPng(text, opts) {
    const o = opts || {};
    const m = qrModules(text);
    const modules = m.size + 2 * QUIET;
    const scale = Math.max(1, Math.floor((o.maxPx || MAX_PX) / modules));
    const side = modules * scale;
    const caption = o.caption ? String(o.caption) : '';
    const unit = Math.floor(CAPTION_PX / 7);
    const captionWidth = caption ? (6 * caption.length + 2) * unit : 0;
    const width = side + captionWidth;
    const height = side;
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height, 255);
    const dark = (x, y) => {
        const p = y * stride + 1 + x * 4;
        raw[p] = 0;
        raw[p + 1] = 0;
        raw[p + 2] = 0;
    };
    for (let y = 0; y < height; y += 1) {
        raw[y * stride] = 0;
        const my = Math.floor(y / scale) - QUIET;
        for (let mx = 0; mx < m.size; mx += 1) {
            if (my >= 0 && my < m.size && m.dark(mx, my)) {
                const x0 = (mx + QUIET) * scale;
                for (let x = x0; x < x0 + scale; x += 1) {
                    dark(x, y);
                }
            }
        }
    }
    const top = Math.floor((height - 7 * unit) / 2);
    captionPixels(caption).forEach(([fx, fy]) => {
        for (let y = top + fy * unit; y < top + (fy + 1) * unit; y += 1) {
            for (let x = side + (fx + 1) * unit; x < side + (fx + 2) * unit; x += 1) {
                dark(x, y);
            }
        }
    });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
    return { png, width, height, modules, scale };
}

module.exports = { qrPng, qrModules, captionPixels, crc32 };
