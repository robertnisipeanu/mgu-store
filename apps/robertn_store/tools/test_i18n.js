'use strict';
/**
 * Offline check of the Store's languages (src/i18n.js, locales/*.json and
 * src/locales.js written from them): every translation has the same
 * {n} placeholders as its English; every word the Store shows (the
 * src/*.js tr() calls, the layouts' own words, the widget screens' string
 * ids, the phases, source states, connection groups and counted words) has
 * a translation, and every translation is one of them; src/locales.js and
 * the RHMI text files are as the tools write them; the HMI's display
 * language picks the locale (every HMI language English or one locale's,
 * with the oap-sdk's text file names), English for any other; a word a
 * language lacks is its English; the drawn screens show English for a
 * language they cannot lay out; a component's catalog texts in the
 * language, else its base language's, else English; each language's
 * characters, its words' and catalog texts', can be drawn; the language
 * follows a change. Node 8+.
 *
 *   node tools/test_i18n.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const SRC = path.join(HERE, 'src');
const TREE = path.join(HERE, fs.readdirSync(HERE).find((n) => /^robertn_store@/.test(n)));
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
// the oap-sdk's text file of each HMI display language (CommonTypesConverters LANGUAGE_SOMEIP_TO_TS_MAP)
const SDK_TEXTS = {
    ARABISCH: 'ar_AE', CHINESISCH_SIMPLE: 'zh_CN', CHINESISCH_TRADITIONELL: 'zh_TW', DAENISCH: 'da_DK', DEUTSCH: 'de_DE',
    ENGLISCH__UK: 'en_GB', ENGLISCH__US: 'en_US', FINNISCH: 'fi_FI', FLAEMISCH: 'nl_BE', FRANZOESISCH: 'fr_FR',
    FRANZOESISCH__CA: 'fr_CA', GRIECHISCH: 'el_GR', HEBRAEISCH_IVRIT: 'he_IL', INDONESISCH: 'id_ID', ITALIENISCH: 'it_IT',
    JAPANISCH: 'ja_JP', KANTONESISCH_SIMPLE: 'zh_yue_Hans_CN', KANTONESISCH_TRADITIONELL: 'zh_yue_Hant_CN', KOREANISCH: 'ko_KR',
    NIEDERLAENDISCH: 'nl_NL', NORWEGISCH: 'no_NO', POLNISCH: 'pl_PL', PORTUGIESISCH: 'pt_PT', PORTUGIESISCH__BR: 'pt_BR',
    RUMAENISCH: 'ro_RO', RUSSISCH: 'ru_RU', SCHWEDISCH: 'sv_SE', SLOWAKISCH: 'sk_SK', SLOWENISCH: 'sl_SI', SPANISCH: 'es_ES',
    SPANISCH__US: 'es_MX', THAI: 'th_TH', TSCHECHISCH: 'cs_CZ', TUERKISCH: 'tr_TR', UKRAINISCH: 'uk_UA', UNGARISCH: 'hu_HU',
    VIETNAMESISCH: 'vi_VN'
};
const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort();
const all = locales.read();
ok(all.length > 0, 'a locale');
eq(fs.readFileSync(locales.OUT, 'utf8'), locales.source(), 'src/locales.js as tools/gen_locales.js writes it');
eq(i18n.codes(), all.map((l) => l.code), 'every locale in the Store');
all.forEach((l) => {
    const n = `${l.code}.json`;
    ok(Array.isArray(l.hmiLanguages) && l.hmiLanguages.length && l.hmiLanguages.every((h) => /^[A-Z_]+$/.test(h)), `${n}: hmiLanguages`);
    eq(l.rhmiTexts, l.hmiLanguages.map((h) => SDK_TEXTS[h]), `${n}: rhmiTexts, the oap-sdk's file of each of its HMI languages`);
    ok(l.drawn === undefined || l.drawn === false, `${n}: drawn`);
    ok(l.words && typeof l.words === 'object', `${n}: words`);
    Object.keys(l.words).forEach((k) => {
        ok(typeof l.words[k] === 'string' && l.words[k].trim() !== '', `${n}: "${k}" is translated`);
        eq(placeholders(l.words[k]), placeholders(k), `${n}: "${k}" has the placeholders of its English`);
        ok(!/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(l.words[k]), `${n}: "${k}" has no hidden characters`);
        eq(l.words[k], l.words[k].normalize('NFC'), `${n}: "${k}" is NFC`);
        eq(l.words[k].split(/\S/).length > 1 && /^\s|\s$/.test(k) ? [/^\s/.test(l.words[k]), /\s$/.test(l.words[k])] : null,
            /^\s|\s$/.test(k) && l.words[k].split(/\S/).length > 1 ? [/^\s/.test(k), /\s$/.test(k)] : null, `${n}: "${k}" keeps its outer spaces`);
    });
    const orphans = Object.keys(l.words).filter((k) => !used.has(k));
    eq(orphans, [], `${n}: translations of words the Store does not show`);
    const missing = Array.from(used).filter((k) => !Object.prototype.hasOwnProperty.call(l.words, k));
    eq(missing, [], `${n}: words without a translation`);
    // its RHMI text files: the widget screens' words in them
    l.rhmiTexts.forEach((name) => {
        const file = path.join(TREE, 'rhmiData', 'variantGroups', 'Common', 'texts', `${name}.json`);
        eq(JSON.parse(fs.readFileSync(file, 'utf8')), texts()[`${name}.json`], `${file}: as tools/gen_rhmi.js writes it`);
        eq(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), Object.keys(en), `${name}.json: the ids of en_GB.json`);
    });
});
['en_GB', 'en_US'].forEach((name) => eq(JSON.parse(fs.readFileSync(path.join(TREE, 'rhmiData', 'variantGroups', 'Common', 'texts', `${name}.json`), 'utf8')), en,
    `${name}.json: as tools/gen_rhmi.js writes it`));
// every HMI display language: English or one locale's
const covered = ['ENGLISCH__UK', 'ENGLISCH__US'].concat(...all.map((l) => l.hmiLanguages));
eq(covered.slice().sort(), Object.keys(SDK_TEXTS).sort(), 'every HMI display language, once');
eq(fs.readdirSync(path.join(TREE, 'rhmiData', 'variantGroups', 'Common', 'texts')).sort(),
    Object.keys(SDK_TEXTS).map((h) => `${SDK_TEXTS[h]}.json`).sort(), 'a text file for each HMI display language, no other');
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
['ENGLISCH__UK', 'ENGLISCH__US', 'SIGNAL_UNGUELTIG', 'KEINE_SPRACHE', 'KLINGONISCH', 11, null, undefined, {}].forEach((v, i) => {
    i18n.setHmiLanguage('CHINESISCH_SIMPLE');
    ok(i18n.setHmiLanguage(v), `${JSON.stringify(v)}: a change`);
    eq([i18n.language(), i18n.font()], ['en', null], `${JSON.stringify(v)}: English`);
    eq(i18n.t('Store'), 'Store', `${JSON.stringify(v)}: English words (${i})`);
});

/* ---- a word a language lacks: its English ---- */
const de = all.find((l) => l.code === 'de');
const kept = de.words['Check now'];
delete de.words['Check now'];
const LOCALES = require(path.join(SRC, 'locales.js'));
const live = LOCALES.find((l) => l.code === 'de');
const liveKept = live.words['Check now'];
delete live.words['Check now'];
i18n.setHmiLanguage('DEUTSCH');
eq([i18n.t('Check now'), i18n.t('Cancel')], ['Check now', 'Abbrechen'], 'a missing word: English, the others translated');
live.words['Check now'] = liveKept;
de.words['Check now'] = kept;

/* ---- variants and the languages the drawn screens cannot show ---- */
[['FLAEMISCH', 'nl'], ['KANTONESISCH_SIMPLE', 'zh-CN'], ['KANTONESISCH_TRADITIONELL', 'zh-TW'], ['PORTUGIESISCH__BR', 'pt-BR'],
    ['SPANISCH__US', 'es-US'], ['FRANZOESISCH__CA', 'fr-CA']].forEach(([h, code]) => {
    i18n.setHmiLanguage(h);
    eq(i18n.language(), code, `${h}: ${code}`);
});
i18n.setHmiLanguage('ARABISCH');
eq([i18n.language(), i18n.t('Cancel')], ['ar', 'إلغاء'], 'Arabic on the widget screens');
ok(i18n.useDrawn(true), 'the drawn screens: Arabic\'s words change');
eq([i18n.language(), i18n.font(), i18n.t('Cancel')], ['en', null, 'Cancel'], 'Arabic on the drawn screens: English');
ok(!i18n.useDrawn(true), 'still drawn: no change');
i18n.setHmiLanguage('DEUTSCH');
eq(i18n.t('Cancel'), 'Abbrechen', 'German on the drawn screens');
ok(!i18n.useDrawn(false), 'German: the same words on either set of screens');
i18n.setHmiLanguage('ARABISCH');
eq(i18n.t('Cancel'), 'إلغاء', 'Arabic on the widget screens again');

/* ---- a component's title and description ---- */
const c = { id: 'x', title: 'Renderer', description: 'Draws', texts: { de: { title: 'Renderer-de', description: 'Zeichnet' },
    pt: { title: 'Renderizador' }, 'pt-BR': { description: 'Desenha' }, fr: { title: '' }, it: 'no', es: { title: 7 } } };
const shown = (h) => { i18n.setHmiLanguage(h); return [i18n.text(c, 'title'), i18n.text(c, 'description')]; };
eq(shown('DEUTSCH'), ['Renderer-de', 'Zeichnet'], 'the language\'s texts');
eq(shown('PORTUGIESISCH__BR'), ['Renderizador', 'Desenha'], 'a field the variant lacks: its base language\'s');
eq(shown('PORTUGIESISCH'), ['Renderizador', 'Draws'], 'a field the language lacks: English');
eq(shown('FRANZOESISCH'), ['Renderer', 'Draws'], 'an empty text: English');
eq(shown('ITALIENISCH'), ['Renderer', 'Draws'], 'texts not an object: English');
eq(shown('SPANISCH'), ['Renderer', 'Draws'], 'a title not a string: English');
eq(shown('ENGLISCH__US'), ['Renderer', 'Draws'], 'English');
i18n.setHmiLanguage('DEUTSCH');
eq([i18n.text({ title: 'T' }, 'title'), i18n.text({ title: 'T', texts: null }, 'title'), i18n.text(null, 'title')], ['T', 'T', ''],
    'without texts: its own');
i18n.useDrawn(false);

/* ---- the fonts ---- */
i18n.setHmiLanguage('CHINESISCH_SIMPLE');
const fonts = require(path.join(SRC, 'kit_fonts.js'));
const { atlasId } = require(path.join(SRC, 'kit_record.js'));
const inter = fonts.get('label', 28, 'Store');
all.filter((l) => l.drawn !== false).forEach((l) => {
    const n = `${l.code}.json`;
    i18n.setHmiLanguage(l.hmiLanguages[0]);
    Object.keys(l.words).forEach((k) => ['label', 'bold'].forEach((fam) => [20, 28, 50, 72].forEach((size) => {
        const f = fonts.get(fam, size, l.words[k]);
        const lost = Array.from(l.words[k]).filter((ch) => !f.glyphs[ch.codePointAt(0)]);
        eq(lost, [], `${n}: "${l.words[k]}" drawn whole at ${fam} ${size}`);
    })));
});
// the catalog's titles and descriptions in each language (release/texts)
all.filter((l) => l.drawn !== false).forEach((l) => {
    const file = path.join(HERE, '..', '..', 'release', 'texts', `${l.code}.json`);
    ok(fs.existsSync(file), `release/texts/${l.code}.json`);
    i18n.setHmiLanguage(l.hmiLanguages[0]);
    const texts = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.keys(texts).forEach((id) => ['title', 'description'].forEach((k) => ['label', 'bold'].forEach((fam) => {
        const v = texts[id][k];
        const f = fonts.get(fam, 22, v);
        eq(Array.from(v).filter((ch) => !f.glyphs[ch.codePointAt(0)]), [], `release/texts/${l.code}.json: ${id} ${k} drawn whole`);
    })));
});
// mgu-render's glyph texture (src/gfx.c gfx_atlas): two 1024-px columns of 4096 rows, shared by every app
// and never emptied; Inter's atlases and any one language's leave a quarter for other apps
const rows = (m) => (m.sizes || [].concat(...Object.keys(m.faces).map((k) => m.faces[k].sizes))).map((a) => a.atlasH);
const shelves = (heights) => heights.reduce((col, h) => {
    const c = col[0] <= col[1] ? 0 : 1;
    col[c] += h + 1;
    return col;
}, [0, 0]);
const interRows = rows(require(path.join(SRC, 'font_regular.js'))).concat(rows(require(path.join(SRC, 'font_semibold.js'))));
Array.from(new Set(all.map((l) => l.font).filter(Boolean))).forEach((name) => {
    const file = { 'chinese-tc': 'font_chinese_tc.js' }[name] || `font_${name}.js`;
    const col = shelves(interRows.concat(rows(require(path.join(SRC, file)))));
    ok(Math.max(...col) <= 4096 && col[0] + col[1] <= 8192 * 0.75, `${name}: Inter's and its atlases in the glyph texture (${col})`);
});
i18n.setHmiLanguage('CHINESISCH_SIMPLE');
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
// accented Latin, Greek and Cyrillic: Inter's own faces with those letters
i18n.setHmiLanguage('DEUTSCH');
const deBold = fonts.get('bold', 44, 'Löschen');
const deLabel = fonts.get('label', 41, 'Löschen');
ok(/^Inter semibold latin@44@/.test(deBold.key) && /^Inter regular latin@41@/.test(deLabel.key), 'German: the semibold and regular faces with ö');
eq(fonts.get('bold', 44, 'Store'), fonts.get('bold', 44), 'German ASCII: Inter');
ok(ui48._pixels === null, 'another language: the Chinese pixels let go');
[['RUMAENISCH', 'ŐőȘșȚțİıĞğŁłŽžÅåØøÆæßÑñ'], ['TUERKISCH', 'İıĞğŞşÇçÖöÜü'], ['GRIECHISCH', 'ΆάΰΐΩωΣσς'],
    ['RUSSISCH', 'ЁёЙйЪъ'], ['UKRAINISCH', 'ЇїҐґЄєІі'], ['VIETNAMESISCH', 'ẠạỹƯưƠơĐđĂăỆệ']].forEach(([h, w]) => {
    i18n.setHmiLanguage(h);
    eq(Array.from(w).filter((ch) => !fonts.get('label', 30, w).glyphs[ch.codePointAt(0)]), [], `${h}: its alphabet's letters`);
});
// Japanese, Korean and Traditional Chinese: their own fonts, a name from a source in the common set
[['JAPANISCH', 'アップデート', '東京駅の案内'], ['KOREANISCH', '업데이트', '서울역 안내'], ['CHINESISCH_TRADITIONELL', '應用程式', '臺灣鐵路導航']].forEach(([h, ui, common]) => {
    i18n.setHmiLanguage(h);
    const f = fonts.get('label', 22, common);
    eq(Array.from(common).filter((ch) => !f.glyphs[ch.codePointAt(0)]), [], `${h}: a name drawn whole`);
    ok(fonts.get('bold', 50, ui).size === 48, `${h}: its words from the sharp set`);
});
i18n.setHmiLanguage('ENGLISCH__UK');
ok(fonts.get('label', 28, '应用商店') === inter && ui48._pixels === null, 'English: Inter, the Chinese pixels let go');
ok(fonts.get('label', 28, 'Store') === inter, 'English: Inter');

console.log(`i18n: ${all.length} locale(s), ${used.size} words, ${checks} checks pass`);
