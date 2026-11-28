'use strict';
// js/hmi_template.js against a stand-in identifier table (each name's number from its hash): the page box's template
// is the one the generator wrote before the whole-screen template came, byte for byte; the whole-screen one is the
// template tried on a car; write() writes both and their boxes, or the page box's alone when HmiMain3D lacks a name
// only the whole-screen one needs.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../js/hmi_template.js');

const number = (n) => {
    let h = 2166136261;
    for (const ch of n) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return h % 100000 + 1;
};
const ids = (lacking) => ({ has: (n) => n !== lacking, get: number });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let pass = 0;
const ok = (what, f) => { f(); pass++; console.log(`ok   ${what}`); };

// sha-256 of the template the generator wrote before (mgu-render 0.6.26's js/hmi_template.js) for surface 0x500
const PAGE = '997d4a7b95bc023e5f7e555e405f3f19d62f1ca8477146b0c85a9d520209150a';
// the whole-screen template tried on a car (title bar box 0 high, surface 1920x720 at 0,0) for surface 0x501
const FULL = 'ade725b4a84300e595383c0e475660138a6189ebf8414ddd6608bd605c9729d0';

ok('the page box\'s template is the one written before, byte for byte', () =>
    assert.strictEqual(sha(t.template(ids(), 0x500, false)), PAGE));
ok('the whole-screen template is the one tried on a car', () =>
    assert.strictEqual(sha(t.template(ids(), 0x501, true)), FULL));
ok('the two are different templates', () => assert.notStrictEqual(t.TEMPLATE, t.FULL_TEMPLATE));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-template-'));
const base = (name) => `${name.replace('eGfxIdWidgetType_', '')}.pbw`;
try {
    const lines = t.write(ids(), dir, 0x500, 0x501);
    ok('write: both templates and their boxes', () => {
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['boxes', base(t.TEMPLATE), base(t.FULL_TEMPLATE)].sort());
        assert.strictEqual(sha(fs.readFileSync(path.join(dir, base(t.TEMPLATE)))), PAGE);
        assert.deepStrictEqual(lines, ['content 0x500 104 88 1796 632', 'full 0x501 0 0 1920 720']);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'boxes'), 'utf8'), lines.join('\n') + '\n');
    });
    fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
    const err = console.error;
    console.error = () => {};
    let page;
    try { page = t.write(ids(t.FULL_TEMPLATE), dir, 0x500, 0x501); } finally { console.error = err; }
    ok('write: a HmiMain3D without the whole-screen template\'s name gets the page box\'s template alone', () => {
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['boxes', base(t.TEMPLATE)].sort());
        assert.deepStrictEqual(page, ['content 0x500 104 88 1796 632']);
    });
    ok('write: a HmiMain3D without a name the page box\'s template needs fails as before', () =>
        assert.throws(() => t.write(ids('eGfxIdParameter_titlebarH_ID7'), dir, 0x500, 0x501), (e) => e.hmi === true));
} finally {
    fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
    fs.rmdirSync(dir);
}
console.log(`test_template: ${pass} checks pass`);
