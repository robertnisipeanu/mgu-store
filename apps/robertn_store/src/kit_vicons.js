'use strict';
// The Store's icons, drawn by the renderer itself - the same on iDrive 7 and 8, no HMI glyphs: Lucide (ISC,
// src/LICENSE-Lucide.txt) baked into glyph atlases (src/font_icons.js, tools/bake_icons.py), an icon one
// glyph of the kit's 'icon' font. vicon(cv, name, x, y, s, color) draws `name` in the s x s box at (x, y); false
// for a name it has no icon for.
const FONT = require('./font_icons.js');
const ICONS = FONT.icons;

function vicon(cv, name, x, y, s, c) {
    const code = ICONS[name];
    if (!code) return false;
    cv.text(String.fromCodePoint(code), x, y + s * FONT.baseline, s, c, { font: 'icon' });
    return true;
}
module.exports = { vicon, ICONS };
