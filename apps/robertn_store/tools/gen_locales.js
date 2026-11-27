'use strict';
/**
 * Writes src/locales.js (the compact language index) and package/locales/
 * <code>.json (each language's runtime word map, loaded on demand by
 * src/i18n.js) from locales/<code>.json (one file per language; README.md,
 * "Languages"):
 *
 *   { "hmiLanguages": ["CHINESISCH_SIMPLE", "KANTONESISCH_SIMPLE"],
 *                                               the HMI's display languages it is for
 *                                               (CommonTypes.Language, HMIContext)
 *     "rhmiTexts": ["zh_CN", "zh_yue_Hans_CN"], its RHMI text files (tools/gen_rhmi.js), named
 *                                               as the oap-sdk names those languages
 *     "font": "chinese",                        optional: the glyphs it is drawn with
 *     "drawn": false,                           optional: the drawn screens stay English
 *                                               (a script mgu-render cannot lay out)
 *     "words": { "<English>": "<translation>" } }
 *
 *   node tools/gen_locales.js
 */
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const DIR = path.join(HERE, 'locales');
const OUT = path.join(HERE, 'src', 'locales.js');
const PKG_DIR = path.join(HERE, require('../mgu-app.json').tree, 'locales');

/* The locales, by file name: { code, hmiLanguages, rhmiTexts, font, words }. */
function read() {
    return fs.readdirSync(DIR).filter((n) => /\.json$/.test(n)).sort().map((n) => {
        const l = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
        if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(n.slice(0, -5)) || !Array.isArray(l.hmiLanguages) ||
            !Array.isArray(l.rhmiTexts) || !l.words || typeof l.words !== 'object') {
            throw new Error(`locales/${n}: not a locale (hmiLanguages, rhmiTexts, words)`);
        }
        return Object.assign({ code: n.slice(0, -5) }, l);
    });
}

/* Runtime metadata index only; words live in package/locales/<code>.json and rhmiTexts are build-time only. */
function index() {
    return read().map((l) => {
        const meta = { code: l.code, hmiLanguages: l.hmiLanguages };
        if (l.font) {
            meta.font = l.font;
        }
        if (l.drawn === false) {
            meta.drawn = false;
        }
        return meta;
    });
}

function source() {
    return "'use strict';\n/* The Store's language index, written by tools/gen_locales.js from locales/*.json. */\n" +
        `module.exports = ${JSON.stringify(index(), null, 1)};\n`;
}

function write() {
    const all = read();
    fs.writeFileSync(OUT, source());
    fs.mkdirSync(PKG_DIR, { recursive: true });
    const keep = new Set(all.map((l) => `${l.code}.json`));
    fs.readdirSync(PKG_DIR).filter((n) => /\.json$/.test(n) && !keep.has(n))
        .forEach((n) => fs.unlinkSync(path.join(PKG_DIR, n)));
    all.forEach((l) => fs.writeFileSync(path.join(PKG_DIR, `${l.code}.json`), JSON.stringify(l.words)));
}

if (require.main === module) {
    write();
    console.log(`wrote ${path.relative(process.cwd(), OUT)} and ${path.relative(process.cwd(), PKG_DIR)}: ${read().map((l) => l.code).join(', ')}`);
}

module.exports = { read, index, source, write, DIR, OUT, PKG_DIR };
