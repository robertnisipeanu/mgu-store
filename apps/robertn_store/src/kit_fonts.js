'use strict';
/**
 * The kit's fonts API (get, measure) over the Store's own glyph atlases:
 * Inter (SIL OFL 1.1, src/LICENSE-Inter.txt), baked by tools/bake_fonts.py
 * into src/font_regular.js and src/font_semibold.js. The kit's family
 * names map onto them: label and light the regular face, bold, num and gear
 * the semibold one.
 *
 * While the display language has a font of its own (src/i18n.js font()),
 * text with a character Inter does not have is drawn with it, every family
 * alike: "chinese", Noto Sans SC (SIL OFL 1.1, src/LICENSE-NotoSansSC.txt),
 * baked by tools/bake_chinese.py into src/font_chinese.js; "cyrillic", Inter
 * Medium with the Cyrillic block, baked by tools/bake_cyrillic.py into
 * src/font_cyrillic.js. Each is loaded when first used, and its atlases'
 * pixels are let go while another language is in use.
 */
const zlib = require('zlib');
const i18n = require('./i18n.js');

const FACES = { regular: require('./font_regular.js'), semibold: require('./font_semibold.js') };
const FAMILY = { label: 'regular', light: 'regular', bold: 'semibold', num: 'semibold', gear: 'semibold' };
const OWN = { chinese: () => require('./font_chinese.js'), cyrillic: () => require('./font_cyrillic.js') };
const families = Object.create(null);
const owned = Object.create(null);      // a language font's atlases, by name, once loaded
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

/* The atlases of the display language's own font when wanted, else null;
 * the pixels of one no longer the language's are let go. */
function ownSizes(wanted) {
    const name = i18n.font();
    if (inUse && inUse !== name) {
        owned[inUse].forEach((f) => { f._pixels = null; });
        inUse = null;
    }
    if (!wanted || !OWN[name]) {
        return null;
    }
    inUse = name;
    return owned[name] || (owned[name] = OWN[name]().sizes.map(atlas));
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
    const sizes = ownSizes(s !== '' && !has(fam[0], s));
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
