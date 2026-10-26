'use strict';
/**
 * The kit's fonts API (get, measure) over the Store's own glyph atlases:
 * Inter (SIL OFL 1.1, src/LICENSE-Inter.txt), baked by tools/bake_fonts.py
 * into src/font_regular.js and src/font_semibold.js. The kit's family
 * names map onto them: label and light the regular face, bold, num and gear
 * the semibold one.
 */
const zlib = require('zlib');

const FACES = { regular: require('./font_regular.js'), semibold: require('./font_semibold.js') };
const FAMILY = { label: 'regular', light: 'regular', bold: 'semibold', num: 'semibold', gear: 'semibold' };
const families = Object.create(null);

function family(name) {
    const face = FAMILY[name] || 'regular';
    if (!families[face]) {
        families[face] = FACES[face].sizes.map((s) => ({
            size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
            glyphs: s.glyphs, _alpha: s.alpha, alpha: null
        }));
    }
    return families[face];
}

/** Smallest baked size >= requested (downscaling looks better), else largest. */
function get(name, size) {
    const fam = family(name);
    let best = null;
    for (const f of fam) {
        if (f.size >= size && (!best || f.size < best.size)) {
            best = f;
        }
    }
    if (!best) {
        best = fam[fam.length - 1];
    }
    if (!best.alpha) {
        best.alpha = zlib.inflateSync(Buffer.from(best._alpha, 'base64'));
    }
    return best;
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
