'use strict';
/**
 * Offline check that the Store's words fit its drawn screens in every
 * language: each screen of tools/fixture.js, in iDrive 7's and iDrive 8's
 * boxes, drawn in each language the drawn screens show; a text cut with …
 * there that is a translation of one of the Store's words, where the same
 * screen in English shows that word whole, is reported, and so is a screen
 * with more texts cut than in English. Node 8+.
 *
 *   node tools/test_fit.js [<code>...]
 */
const assert = require('assert');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const i18n = require(path.join(SRC, 'i18n.js'));
const LOCALES = require(path.join(SRC, 'locales.js'));
const { Recorder } = require(path.join(SRC, 'kit_record.js'));
const { frame, placement } = require(path.join(SRC, 'store_frame.js'));
const fixture = require('./fixture.js');
const { sourceAuthor } = require(path.join(SRC, 'store_view.js'));

const UNITS = { 'iDrive 7': placement(1796, 632), 'iDrive 8': placement(2880, 764) };

/* Every text drawn on each screen, by unit and screen. */
function drawn() {
    const out = {};
    const text = Recorder.prototype.text;
    let seen = null;
    Recorder.prototype.text = function (str, ...rest) {
        seen.push(String(str));
        return text.call(this, str, ...rest);
    };
    try {
        Object.keys(UNITS).forEach((u) => fixture.screens().forEach(([name, over, stOver]) => {
            seen = [];
            const st = stOver ? Object.assign(fixture.state(), stOver) : undefined;
            const m = fixture.model(over, st);
            m.language = i18n.language();
            frame(m, { textScale: UNITS[u].scale, focus: m.focus, scroll: {}, layout: UNITS[u].layout });
            out[`${u} ${name}`] = seen;
        }));
    } finally {
        Recorder.prototype.text = text;
    }
    return out;
}

/* The words whose text is cut in texts: a cut text is its start and …. */
function cutWords(texts, words) {
    const whole = new Set(Object.keys(words).map((k) => words[k]));
    const cut = texts.filter((s) => /…$/.test(s) && !whole.has(s)).map((s) => s.slice(0, -1).replace(/\s+$/, ''));
    return Object.keys(words).filter((k) => {
        const w = words[k].replace(/\{\d+\}.*$/, '');
        return w.length > 1 && cut.some((c) => c.length < w.length && w.indexOf(c) === 0 && c.length >= Math.min(2, w.length));
    });
}

const only = process.argv.slice(2);
const english = drawn();
const enWords = {};
LOCALES[0] && Object.keys(LOCALES[0].words).forEach((k) => { enWords[k] = k; });
const problems = [];
const authors = fixture.state().sources.map(sourceAuthor);
LOCALES.filter((l) => l.drawn !== false && (!only.length || only.indexOf(l.code) >= 0)).forEach((l) => {
    i18n.setHmiLanguage(l.hmiLanguages[0]);
    i18n.useDrawn(true);
    const shown = drawn();
    Object.keys(shown).forEach((screen) => {
        const enCut = new Set(cutWords(english[screen], enWords));
        cutWords(shown[screen], l.words).filter((k) => !enCut.has(k))
            .forEach((k) => problems.push(`${l.code} ${screen}: "${l.words[k]}" (${k})`));
        // texts with values in them: no more cut than in English, but for a network's name after its state
        // or a row's source author at its end
        const tails = ['Online{0}', 'Connected{0}', 'Connecting{0}'].map((k) => l.words[k].replace('{0}', ' · '));
        const author = (s) => { const a = / · ([^·]+)…$/.exec(s); return !!a && authors.some((n) => n.indexOf(a[1]) === 0); };
        const cut = (texts) => texts.filter((s) => /…$/.test(s) && !Object.keys(l.words).some((k) => l.words[k] === s) &&
            !tails.some((tl) => s.indexOf(tl) === 0) && !author(s));
        if (cut(shown[screen]).length > cut(english[screen]).length) {
            problems.push(`${l.code} ${screen}: ${cut(shown[screen]).join(' | ')}`);
        }
    });
    i18n.useDrawn(false);
});
i18n.setHmiLanguage(null);
assert.deepStrictEqual(problems, [], `words cut where English fits:\n${problems.join('\n')}`);
console.log(`fit: ${LOCALES.length} locale(s), ${Object.keys(english).length} screens, nothing cut that English shows whole`);
