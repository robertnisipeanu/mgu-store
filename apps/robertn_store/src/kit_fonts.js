'use strict';
/**
 * The kit's fonts API (get, measure, glyph) over the Store's own glyph atlases:
 * Inter (SIL OFL 1.1, src/LICENSE-Inter.txt), baked by tools/bake_fonts.py
 * into src/font_regular.js and src/font_semibold.js. The kit's family
 * names map onto them: label and light the regular face, bold, num and gear
 * the semibold one.
 *
 * While the display language has a font of its own (src/i18n.js font()),
 * text with a character Inter does not have is drawn with it:
 *  - "latin", "greek", "cyrillic", "vietnamese": Inter with those letters,
 *    in the regular and semibold faces as above (tools/bake_inter.py);
 *  - "chinese", "chinese-tc", "japanese", "korean": Noto Sans SC, TC, JP
 *    and KR (SIL OFL 1.1, src/LICENSE-NotoSans*.txt), every family alike
 *    (tools/bake_cjk.py).
 * They are the package's fonts/<name>.json (glyph metadata) and
 * fonts/<name>.bin (zlib-compressed alpha slices), outside the app's bundle. Each is
 * loaded when first used, and let go when another language is in use.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const i18n = require('./i18n.js');

const FACES = { regular: require('./font_regular.js'), semibold: require('./font_semibold.js') };
const FAMILY = { label: 'regular', light: 'regular', bold: 'semibold', num: 'semibold', gear: 'semibold' };
const OWN = ['latin', 'greek', 'cyrillic', 'vietnamese', 'chinese', 'chinese-tc', 'japanese', 'korean'];
// Drawn with the plain character when an atlas lacks them: ‘ ’ “ ” and the no-break space.
const PLAIN = { 0x2018: 0x27, 0x2019: 0x27, 0x201c: 0x22, 0x201d: 0x22, 0xa0: 0x20 };
const families = Object.create(null);
let owned = null;                       // the language font in use: its name and atlases ({ all } or by face)

/* An embedded Inter atlas; its pixels are inflated on first access and its
 * compressed base64 string is released once inflated. */
function atlas(s) {
    const raw = s.alpha;
    s.alpha = null;
    const f = { size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
        glyphs: s.glyphs, glyphCount: Object.keys(s.glyphs).length, key: s.key, _alpha: raw, _pixels: null };
    Object.defineProperty(f, 'alpha', {
        get() {
            if (!this._pixels) {
                this._pixels = zlib.inflateSync(Buffer.from(this._alpha, 'base64'));
                this._alpha = null;
            }
            return this._pixels;
        }
    });
    return f;
}

function readBin(file, offset, length) {
    const buf = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, 'r');
    try {
        let got = 0;
        while (got < length) {
            const n = fs.readSync(fd, buf, got, length - got, offset + got);
            if (!n) {
                break;
            }
            got += n;
        }
    } finally {
        fs.closeSync(fd);
    }
    return buf;
}

function copyRows(src, srcW, srcH, dst, dstW, dstY) {
    if (srcW === dstW) {
        src.copy(dst, dstY * dstW);
        return;
    }
    for (let r = 0; r < srcH; r++) {
        src.copy(dst, (dstY + r) * dstW, r * srcW, (r + 1) * srcW);
    }
}

function readAtlasBin(file, s) {
    const raw = readBin(file, s.offset, s.length || s.atlasW * s.atlasH);
    return s.length ? zlib.inflateSync(raw) : raw;
}

/* An external language atlas backed by compressed alpha slices in binFile; when base
 * is given (Inter language fonts), the bundled Inter glyphs of the same face
 * and size sit in the top rows and the language's own glyphs sit below them. */
function binAtlas(s, binFile, base) {
    if (!base) {
        const f = { size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
            glyphs: s.glyphs, glyphCount: Object.keys(s.glyphs).length, key: s.key, _pixels: null };
        Object.defineProperty(f, 'alpha', {
            get() {
                if (!this._pixels) {
                    this._pixels = readAtlasBin(binFile, s);
                }
                return this._pixels;
            }
        });
        return f;
    }
    const atlasW = Math.max(base.atlasW, s.atlasW);
    const atlasH = base.atlasH + s.atlasH;
    const glyphs = Object.create(null);
    Object.keys(base.glyphs).forEach((cp) => { glyphs[cp] = base.glyphs[cp]; });
    Object.keys(s.glyphs).forEach((cp) => {
        const g = s.glyphs[cp];
        glyphs[cp] = [g[0], g[1] + base.atlasH, g[2], g[3], g[4], g[5], g[6]];
    });
    const f = { size: s.size, ascent: s.ascent, descent: s.descent, atlasW, atlasH,
        glyphs, glyphCount: Object.keys(glyphs).length, key: s.key, _pixels: null };
    Object.defineProperty(f, 'alpha', {
        get() {
            if (!this._pixels) {
                const out = Buffer.alloc(atlasW * atlasH);
                copyRows(base.alpha, base.atlasW, base.atlasH, out, atlasW, 0);
                copyRows(readAtlasBin(binFile, s), s.atlasW, s.atlasH, out, atlasW, base.atlasH);
                this._pixels = out;
            }
            return this._pixels;
        }
    });
    return f;
}

function faceAtlases(face) {
    if (!families[face]) {
        families[face] = FACES[face].sizes.map(atlas);
    }
    return families[face];
}

function family(name) {
    return faceAtlases(FAMILY[name] || 'regular');
}

/* The package's fonts folder: beside javascript/ in the installed app, in
 * the staged tree mgu-app.json names in this repository. */
function fontDir() {
    const up = path.join(__dirname, '..');
    if (fs.existsSync(path.join(up, 'fonts'))) {
        return path.join(up, 'fonts');
    }
    return path.join(up, JSON.parse(fs.readFileSync(path.join(up, 'mgu-app.json'), 'utf8')).tree, 'fonts');
}

/* A language font's atlases (fonts/<name>.json + fonts/<name>.bin): every
 * face's, or "all" for a font with one set. Read as data, so nothing of it
 * stays once its atlases are let go. */
function load(name) {
    const dir = fontDir();
    const binFile = path.join(dir, `${name}.bin`);
    const m = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    const build = (s, face) => {
        if (s.alpha) {
            return atlas(s);
        }
        const base = s.base && face ? faceAtlases(face).find((b) => b.size === s.size) : null;
        return binAtlas(s, binFile, base);
    };
    if (m.sizes) {
        return { all: m.sizes.map((s) => build(s, null)) };
    }
    const faces = {};
    Object.keys(m.faces).forEach((face) => { faces[face] = m.faces[face].sizes.map((s) => build(s, face)); });
    return faces;
}

/* The atlases of the display language's own font for the family when
 * wanted, else null. One no longer the language's is let go whole. */
function ownSizes(wanted, fam) {
    const name = i18n.font();
    if (owned && owned.name !== name) {
        const faces = owned.faces;
        require('./kit_record.js').dropAtlases([].concat(...Object.keys(faces).map((k) => faces[k])));
        owned = null;
    }
    if (!wanted || OWN.indexOf(name) < 0) {
        return null;
    }
    owned = owned || { name, faces: load(name) };
    return owned.faces.all || owned.faces[FAMILY[fam] || 'regular'];
}

/* Smallest baked size >= requested (downscaling looks better), else largest. */
function pick(fam, size) {
    let best = null;
    for (const f of fam) {
        if (f.size >= size && (!best || f.size < best.size)) {
            best = f;
        }
    }
    return best || fam.reduce((a, f) => (f.size > a.size ? f : a));
}

function has(f, s) {
    for (const ch of s) {
        if (!f.glyphs[ch.codePointAt(0)]) {
            return false;
        }
    }
    return true;
}

/** The atlas for text at size: Inter's; for text Inter can't draw, while
 * the language has a font of its own, that font's atlases with all of its
 * characters (else the sizes of its largest set). */
function get(name, size, text) {
    const fam = family(name);
    const s = text === undefined || text === null ? '' : String(text);
    const sizes = ownSizes(s !== '' && !has(fam[0], s), name);
    if (sizes) {
        const whole = sizes.filter((f) => has(f, s));
        if (whole.length) {
            return pick(whole, size);
        }
        const most = Math.max(...sizes.map((f) => f.glyphCount));
        return pick(sizes.filter((f) => f.glyphCount === most), size);
    }
    return pick(fam, size);
}

/** The glyph that draws the character ch in atlas f: its own, its plain
 * stand-in (PLAIN), else "?". */
function glyph(f, ch) {
    const c = ch.codePointAt(0);
    return f.glyphs[c] || f.glyphs[PLAIN[c]] || f.glyphs[63];
}

function measure(f, s) {
    let w = 0;
    for (const ch of s) {
        const g = glyph(f, ch);
        if (g) {
            w += g[6];
        }
    }
    return w;
}

module.exports = { get, measure, glyph };
