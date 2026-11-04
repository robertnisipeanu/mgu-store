'use strict';
/**
 * The kit's fonts API (get, measure) over the Store's own glyph atlases:
 * Inter (SIL OFL 1.1, src/LICENSE-Inter.txt), baked by tools/bake_fonts.py
 * into src/font_regular.js and src/font_semibold.js. The kit's family
 * names map onto them: label and light the regular face, bold, num and gear
 * the semibold one.
 *
 * While the display language has a font of its own (src/i18n.js font()),
 * text with a character Inter does not have is drawn with it:
 *  - "latin", "greek", "cyrillic", "vietnamese": Inter with those letters,
 *    in the regular and semibold faces as above (tools/bake_inter.py,
 *    src/font_latin.js, font_greek.js, font_cyrillic.js, font_vietnamese.js);
 *  - "chinese", "chinese-tc", "japanese", "korean": Noto Sans SC, TC, JP
 *    and KR (SIL OFL 1.1, src/LICENSE-NotoSans*.txt), every family alike
 *    (tools/bake_cjk.py, src/font_chinese.js, font_chinese_tc.js,
 *    font_japanese.js, font_korean.js).
 * Each is loaded when first used, and its atlases' pixels are let go while
 * another language is in use.
 */
const zlib = require('zlib');
const i18n = require('./i18n.js');

const FACES = { regular: require('./font_regular.js'), semibold: require('./font_semibold.js') };
const FAMILY = { label: 'regular', light: 'regular', bold: 'semibold', num: 'semibold', gear: 'semibold' };
const OWN = {
    latin: () => require('./font_latin.js'),
    greek: () => require('./font_greek.js'),
    cyrillic: () => require('./font_cyrillic.js'),
    vietnamese: () => require('./font_vietnamese.js'),
    chinese: () => require('./font_chinese.js'),
    'chinese-tc': () => require('./font_chinese_tc.js'),
    japanese: () => require('./font_japanese.js'),
    korean: () => require('./font_korean.js')
};
const families = Object.create(null);
const owned = Object.create(null);      // a language font's atlases, by name, once loaded: { all } or by face
let inUse = null;                       // the name of the one whose pixels are held

/* An atlas; its pixels inflated when first asked for, until let go. */
function atlas(s) {
    const f = { size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
        glyphs: s.glyphs, key: s.key, _alpha: s.alpha, _pixels: null };
    Object.defineProperty(f, 'alpha', {
        get() { return this._pixels || (this._pixels = zlib.inflateSync(Buffer.from(this._alpha, 'base64'))); }
    });
    return f;
}

function family(name) {
    const face = FAMILY[name] || 'regular';
    if (!families[face]) {
        families[face] = FACES[face].sizes.map(atlas);
    }
    return families[face];
}

/* A language font's atlases: every face's, or "all" for a font with one set. */
function load(name) {
    const m = OWN[name]();
    if (m.sizes) {
        return { all: m.sizes.map(atlas) };
    }
    const faces = {};
    Object.keys(m.faces).forEach((face) => { faces[face] = m.faces[face].sizes.map(atlas); });
    return faces;
}

/* The atlases of the display language's own font for the family when
 * wanted, else null; the pixels of one no longer the language's are let go. */
function ownSizes(wanted, fam) {
    const name = i18n.font();
    if (inUse && inUse !== name) {
        Object.keys(owned[inUse]).forEach((face) => owned[inUse][face].forEach((f) => { f._pixels = null; }));
        inUse = null;
    }
    if (!wanted || !OWN[name]) {
        return null;
    }
    inUse = name;
    const faces = owned[name] || (owned[name] = load(name));
    return faces.all || faces[FAMILY[fam] || 'regular'];
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
 * characters (else its largest set). */
function get(name, size, text) {
    const fam = family(name);
    const s = text === undefined || text === null ? '' : String(text);
    const sizes = ownSizes(s !== '' && !has(fam[0], s), name);
    if (sizes) {
        const whole = sizes.filter((f) => has(f, s));
        return pick(whole.length ? whole : [sizes.reduce((a, b) => (Object.keys(b.glyphs).length > Object.keys(a.glyphs).length ? b : a))], size);
    }
    return pick(fam, size);
}

function measure(f, s) {
    let w = 0;
    for (const ch of s) {
        const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63];
        if (g) {
            w += g[6];
        }
    }
    return w;
}

module.exports = { get, measure };
