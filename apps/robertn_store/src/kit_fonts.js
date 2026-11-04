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
 *    in the regular and semibold faces as above (tools/bake_inter.py);
 *  - "chinese", "chinese-tc", "japanese", "korean": Noto Sans SC, TC, JP
 *    and KR (SIL OFL 1.1, src/LICENSE-NotoSans*.txt), every family alike
 *    (tools/bake_cjk.py).
 * They are the package's fonts/<name>.json, outside the app's bundle.
 * Each is loaded when first used, and let go when another language is in
 * use.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const i18n = require('./i18n.js');

const FACES = { regular: require('./font_regular.js'), semibold: require('./font_semibold.js') };
const FAMILY = { label: 'regular', light: 'regular', bold: 'semibold', num: 'semibold', gear: 'semibold' };
const OWN = ['latin', 'greek', 'cyrillic', 'vietnamese', 'chinese', 'chinese-tc', 'japanese', 'korean'];
const families = Object.create(null);
let owned = null;                       // the language font in use: its name and atlases ({ all } or by face)

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

/* The package's fonts folder: beside javascript/ in the installed app, in
 * the staged tree in this repository. */
function fontDir() {
    const up = path.join(__dirname, '..');
    if (fs.existsSync(path.join(up, 'fonts'))) {
        return path.join(up, 'fonts');
    }
    return path.join(up, fs.readdirSync(up).find((n) => /^robertn_store@/.test(n) && fs.statSync(path.join(up, n)).isDirectory()), 'fonts');
}

/* A language font's atlases (fonts/<name>.json): every face's, or "all"
 * for a font with one set. Read as data, so nothing of it stays once its
 * atlases are let go. */
function load(name) {
    const m = JSON.parse(fs.readFileSync(path.join(fontDir(), `${name}.json`), 'utf8'));
    if (m.sizes) {
        return { all: m.sizes.map(atlas) };
    }
    const faces = {};
    Object.keys(m.faces).forEach((face) => { faces[face] = m.faces[face].sizes.map(atlas); });
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
        const count = (f) => Object.keys(f.glyphs).length;
        const most = Math.max(...sizes.map(count));
        const whole = sizes.filter((f) => has(f, s));
        return pick(whole.length ? whole : sizes.filter((f) => count(f) === most), size);
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
