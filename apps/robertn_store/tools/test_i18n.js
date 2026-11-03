'use strict';
/**
 * Offline check of the Store's languages (src/i18n.js, locales/*.json and
 * src/locales.js written from them): every translation has the same
 * {n} placeholders as its English; every word the Store shows (the
 * src/*.js tr() calls, the layouts' own words, the widget screens' string
 * ids, the phases, source states, connection groups and counted words) has
 * a translation, and every translation is one of them; src/locales.js and
 * the RHMI text files are as the tools write them; the HMI's display
 * language picks the locale,
 * English for any other; each language's characters can be drawn; the
 * language follows a change. Node 8+.
 *
 *   node tools/test_i18n.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const SRC = path.join(HERE, 'src');
const TREE = path.join(HERE, fs.readdirSync(HERE).find((n) => /^robertn_store@/.test(n) && fs.statSync(path.join(HERE, n)).isDirectory()));
const i18n = require(path.join(SRC, 'i18n.js'));
const { texts, sid } = require('./gen_rhmi.js');
const locales = require('./gen_locales.js');

let checks = 0;
const ok = (cond, msg) => { checks += 1; assert(cond, msg); };
const eq = (got, want, msg) => { checks += 1; assert.deepStrictEqual(got, want, msg); };

/* ---- the words the Store shows ---- */
const sources = fs.readdirSync(SRC).filter((n) => /\.js$/.test(n) && !/^font_/.test(n) && n !== 'locales.js')
    .map((n) => fs.readFileSync(path.join(SRC, n), 'utf8'));
const used = new Set();
const literal = /\btr\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/g;
sources.forEach((s) => {
    let m;
    while ((m = literal.exec(s))) {
        if (m[1] !== '`' || m[2].indexOf('${') < 0) {
            used.add(m[2].replace(/\\'/g, '\''));
        }
    }
});
// the values of the maps and lists tr() is given an element of
const ui = fs.readFileSync(path.join(SRC, 'store_ui.js'), 'utf8');
const view = fs.readFileSync(path.join(SRC, 'store_view.js'), 'utf8');
const mapValues = (src, name) => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(src);
    ok(m, `${name} found`);
    return m[1].match(/'[^']*'/g).map((q) => q.slice(1, -1));
};
Object.values(require(path.join(SRC, 'store_view.js')).PHASE).concat(['Installing']).forEach((w) => used.add(w));
mapValues(view, 'SOURCE_STATE').filter((w) => !/^[a-z-]+$/.test(w)).forEach((w) => used.add(w));
(/const GROUPS = (\[.*\]);/.exec(ui)[1].match(/\['[a-z]*', '[^']+', \[/g) || []).forEach((g) => used.add(/, '([^']+)', \[$/.exec(g)[1]));
(ui.match(/plural\([^,]+, '([a-z]+)'\)/g) || []).forEach((p) => {
    const word = /'([a-z]+)'/.exec(p)[1];
    used.add(`{0} ${word}`);
    used.add(`{0} ${word}s`);
});
// the layouts' own words
const WORDS = ['text', 'title', 'label', 'empty', 'items'];
const layoutWords = (screens) => screens.forEach((s) => s.components.forEach((c) => WORDS.forEach((k) => {
    const v = c.opts && c.opts[k];
    if (typeof v === 'string' && v && !/\n/.test(v)) {
        used.add(v);
    }
})));
layoutWords(require(path.join(SRC, 'am_screens.js')).screens);
layoutWords(require(path.join(SRC, 'store_compact.js')).compact(1796, 632).screens);
// the widget screens' string ids
const en = texts()['en_GB.json'];
Object.keys(en).filter((id) => en[id]).forEach((id) => used.add(en[id]));
// names, not words
['Store, grid\nInstalled, check\nUSB, usb\nSettings, gear', 'USB', 'Wi-Fi'].forEach((w) => used.delete(w));

/* ---- each locale ---- */
const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort();
const all = locales.read();
ok(all.length > 0, 'a locale');
eq(fs.readFileSync(locales.OUT, 'utf8'), locales.source(), 'src/locales.js as tools/gen_locales.js writes it');
eq(i18n.codes(), all.map((l) => l.code), 'every locale in the Store');
all.forEach((l) => {
    const n = `${l.code}.json`;
    ok(Array.isArray(l.hmiLanguages) && l.hmiLanguages.length && l.hmiLanguages.every((h) => /^[A-Z_]+$/.test(h)), `${n}: hmiLanguages`);
    ok(/^[a-z]{2}_[A-Z]{2}$/.test(l.rhmiTexts), `${n}: rhmiTexts`);
    ok(l.words && typeof l.words === 'object', `${n}: words`);
    Object.keys(l.words).forEach((k) => {
        ok(typeof l.words[k] === 'string' && l.words[k].trim() !== '', `${n}: "${k}" is translated`);
        eq(placeholders(l.words[k]), placeholders(k), `${n}: "${k}" has the placeholders of its English`);
        ok(!/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(l.words[k]), `${n}: "${k}" has no hidden characters`);
    });
    const orphans = Object.keys(l.words).filter((k) => !used.has(k));
    eq(orphans, [], `${n}: translations of words the Store does not show`);
    const missing = Array.from(used).filter((k) => !Object.prototype.hasOwnProperty.call(l.words, k));
    eq(missing, [], `${n}: words without a translation`);
    // its RHMI text file: the widget screens' words in it
    const file = path.join(TREE, 'rhmiData', 'variantGroups', 'Common', 'texts', `${l.rhmiTexts}.json`);
    eq(JSON.parse(fs.readFileSync(file, 'utf8')), texts()[`${l.rhmiTexts}.json`], `${file}: as tools/gen_rhmi.js writes it`);
    eq(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), Object.keys(en), `${l.rhmiTexts}.json: the ids of en_GB.json`);
});
eq(JSON.parse(fs.readFileSync(path.join(TREE, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), 'utf8')), en,
    'en_GB.json: as tools/gen_rhmi.js writes it');
eq(sid('Restart head unit?'), 'SID_STORE_RESTART_HEAD_UNIT_Q', 'string id of words');

/* ---- the display language ---- */
eq(i18n.language(), 'en', 'English at first');
eq(i18n.t('Update {0}', '1.0.1'), 'Update 1.0.1', 'English with its arguments');
ok(i18n.setHmiLanguage('CHINESISCH_SIMPLE'), 'Simplified Chinese: a change');
eq(i18n.language(), 'zh-CN', 'CHINESISCH_SIMPLE: zh-CN');
eq(i18n.font(), 'chinese', 'zh-CN draws with its own font');
eq(i18n.t('Update {0}', 'Store/{1}'), '更新 Store/{1}', 'arguments are data');
eq(i18n.t('Not a word the Store has'), 'Not a word the Store has', 'a word without a translation: its English');
ok(!i18n.setHmiLanguage('CHINESISCH_SIMPLE'), 'the same language: no change');
['ENGLISCH__UK', 'DEUTSCH', 'CHINESISCH_TRADITIONELL', 'SIGNAL_UNGUELTIG', 'KEINE_SPRACHE', 11, null, undefined, {}].forEach((v, i) => {
    i18n.setHmiLanguage('CHINESISCH_SIMPLE');
    ok(i18n.setHmiLanguage(v), `${JSON.stringify(v)}: a change`);
    eq([i18n.language(), i18n.font()], ['en', null], `${JSON.stringify(v)}: English`);
    eq(i18n.t('Store'), 'Store', `${JSON.stringify(v)}: English words (${i})`);
});

/* ---- the fonts ---- */
i18n.setHmiLanguage('CHINESISCH_SIMPLE');
const fonts = require(path.join(SRC, 'kit_fonts.js'));
const { atlasId } = require(path.join(SRC, 'kit_record.js'));
const inter = fonts.get('label', 28, 'Store');
all.forEach((l) => {
    const n = `${l.code}.json`;
    i18n.setHmiLanguage(l.hmiLanguages[0]);
    Object.keys(l.words).forEach((k) => ['label', 'bold'].forEach((fam) => [20, 28, 50, 72].forEach((size) => {
        const f = fonts.get(fam, size, l.words[k]);
        const lost = Array.from(l.words[k]).filter((ch) => !f.glyphs[ch.codePointAt(0)]);
        eq(lost, [], `${n}: "${l.words[k]}" drawn whole at ${fam} ${size}`);
    })));
});
const ui48 = fonts.get('bold', 50, '应用商店');
const common = fonts.get('label', 22, '这是一个应用的说明');
ok(ui48 !== common && ui48.size > common.size, 'the Store\'s words sharp, other text from the common set');
ok(ui48.atlasW <= 1024 && common.atlasW <= 1024 && ui48.atlasH <= 4096 && common.atlasH <= 4096, 'atlases within mgu-render\'s limits');
// the renderer shares atlases between apps by id: a key of its own, not family and size
const keyless = (f) => Object.assign({}, f, { key: undefined });
[ui48, common].forEach((f) => {
    ok(atlasId(Object.assign({}, f), 'bold') === atlasId(f, 'label'), `${f.key}: the same id whatever the family`);
    ok(atlasId(f, 'label') !== atlasId(keyless(f), 'label'), `${f.key}: not the id of label@${f.size}`);
});
eq(atlasId(Object.assign({}, inter), 'label'), atlasId(inter, 'label'), 'Inter: its id of family and size');
ok(atlasId(ui48, 'label') !== atlasId(common, 'label'), 'the two Chinese atlases apart');
eq(fonts.get('label', 28, 'Store'), inter, 'Latin text: Inter');
ok(ui48.alpha.length === ui48.atlasW * ui48.atlasH, 'pixels while Chinese is in use');
i18n.setHmiLanguage('ENGLISCH__UK');
ok(fonts.get('label', 28, '应用商店') === inter && ui48._pixels === null, 'English: Inter, the Chinese pixels let go');
ok(fonts.get('label', 28, 'Store') === inter, 'English: Inter');

console.log(`i18n: ${all.length} locale(s), ${used.size} words, ${checks} checks pass`);
