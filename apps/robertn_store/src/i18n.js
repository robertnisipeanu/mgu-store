'use strict';
/**
 * The Store's words in the head unit's display language. The English text
 * is the key: t('Update {0}', version) is its translation in the language
 * in use, with {0}, {1} ... replaced by the arguments, or the English where
 * the language has no translation. Arguments are data (names, versions,
 * sources, SSIDs, the updater's errors) and are never translated.
 *
 * The languages are src/locales.js (tools/gen_locales.js, from
 * locales/<code>.json). setHmiLanguage(value) picks the one for the HMI's
 * display language (a CommonTypes.Language name), English for any other,
 * an invalid value or none. A language with "drawn": false (a script the
 * renderer cannot lay out) is English while the drawn screens are in use
 * (useDrawn).
 *
 * text(c, 'title') is a component's title or description in the language,
 * from its "texts" ({ "<code>": { title, description } }, the catalog's):
 * the language's, else that of its base language (pt for pt-BR), else c's
 * own, English.
 */
const LOCALES = require('./locales.js');

let current = null;
let drawn = false;

function codes() {
    return LOCALES.map((l) => l.code);
}

/* Returns whether the language changed. */
function setHmiLanguage(value) {
    const next = LOCALES.find((l) => typeof value === 'string' && l.hmiLanguages.indexOf(value) >= 0) || null;
    if (next === current) {
        return false;
    }
    current = next;
    return true;
}

/* Whether the drawn screens are in use. Returns whether the words changed. */
function useDrawn(on) {
    const before = active();
    drawn = !!on;
    return active() !== before;
}

/* The locale whose words are shown: none for English. */
function active() {
    return current && !(drawn && current.drawn === false) ? current : null;
}

function language() {
    return active() ? active().code : 'en';
}

function font() {
    return (active() && active().font) || null;
}

function text(c, field) {
    const own = c && typeof c[field] === 'string' ? c[field] : '';
    const texts = c && c.texts;
    const code = language();
    if (!texts || typeof texts !== 'object' || code === 'en') {
        return own;
    }
    const pick = (k) => {
        const v = Object.prototype.hasOwnProperty.call(texts, k) && texts[k] && texts[k][field];
        return typeof v === 'string' && v ? v : null;
    };
    return pick(code) || pick(code.split('-')[0]) || own;
}

function t(key, ...args) {
    const words = active() && active().words;
    const text = words && Object.prototype.hasOwnProperty.call(words, key) && typeof words[key] === 'string' ? words[key] : key;
    return text.replace(/\{(\d+)\}/g, (match, i) => (Number(i) < args.length ? String(args[i]) : match));
}

module.exports = { codes, setHmiLanguage, useDrawn, language, font, text, t };
