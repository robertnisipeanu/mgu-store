'use strict';
/**
 * The phone page's add-source form (js/web.js PAGE_SCRIPT) against a fake
 * DOM and API: a repository is asked about on leaving the box or on the
 * first Add, never per keystroke; Add waits for the answer and sends the
 * channel picked, the repo as GitHub spells it; a /tree/ address and a
 * catalog URL are added at once. Node 8+.
 *
 *   node test/test_page.js
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'web.js'), 'utf8');
const m = /const PAGE_SCRIPT = `([\s\S]*?)`;\n/.exec(src);
const js = eval('`' + m[1] + '`');
const els = {};
const el = (id) => els[id] || (els[id] = { id, value: '', hidden: false, textContent: '', disabled: false, children: [], style: {},
    appendChild(c) { this.children.push(c); }, set textContent_(v) {}, removeAttribute() {}, scrollTop: 0 });
['addType', 'addValue', 'addChannel', 'addNote', 'addForm', 'addSubmit', 'app', 'locked', 'status', 'stateErr', 'err', 'down', 'busy',
    'busyText', 'busyBar', 'loginStart', 'sources', 'tokens', 'components', 'login', 'loginCode', 'loginUrl', 'loginStatus', 'loginCancel',
    'tokenForm', 'tokenValue', 'logForm', 'logSrc', 'log'].forEach(el);
els.addType.value = 'github';
// a select's textContent = '' drops its options
Object.defineProperty(els.addChannel, 'textContent', { set() { this.children = []; }, get() { return ''; } });
Object.defineProperty(els.addChannel, 'value', { get() { return this.children[0] ? this.children[0].value : ''; }, set() {} });
const sent = [];
let answer = null;
const pending = [];
global.document = { getElementById: el, createElement: () => ({ value: '', textContent: '', appendChild() {} }) };
global.location = { hash: '#t=abc', pathname: '/', reload() {} };
global.history = { replaceState() {} };
global.sessionStorage = { setItem() {}, getItem: () => 'abc', removeItem() {} };
global.window = { addEventListener() {} };
global.confirm = () => true;
global.setInterval = () => 0;
global.fetch = (path, o) => {
    const body = o && o.body ? JSON.parse(o.body) : null;
    if (body) { sent.push(body); }
    const reply = body && body.op === 'source-probe' ? new Promise((r) => pending.push(r)) :
        Promise.resolve({ updater: { version: 'x' }, online: true, sources: [], tokens: [], components: [] });
    return reply.then((j) => ({ status: 200, ok: true, json: () => Promise.resolve(j || { ok: true }) }));
};
new Function(js)();
const tick = () => new Promise((r) => setTimeout(r, 5));
const submit = () => els.addForm.onsubmit({ preventDefault() {} });
const assert = require('assert');
(async () => {
    await tick();
    // pasted and Add tapped at once: lists first, adds nothing
    els.addValue.value = 'O/R';
    els.addValue.oninput();
    submit();
    await tick();
    assert.deepStrictEqual(sent.map((b) => b.op), ['source-probe'], 'first Add asks');
    assert.strictEqual(els.addSubmit.disabled, true, 'Add waits');
    submit();
    await tick();
    assert.strictEqual(sent.length, 1, 'nothing added while checking');
    pending.shift()({ repo: 'O/R', name: 'o/r', status: 'ok', releases: false, tags: true, defaultBranch: 'main', branches: ['main'] });
    await tick();
    assert.strictEqual(els.addSubmit.disabled, false);
    assert.strictEqual(els.addChannel.hidden, false);
    submit();
    await tick();
    assert.deepStrictEqual(sent[1], { op: 'source-add', type: 'github', repo: 'o/r', channel: 'tags' });
    // typing: no probe per keystroke; leaving the box asks once
    sent.length = 0;
    for (const v of ['a', 'a/', 'a/b', 'a/bc']) { els.addValue.value = v; els.addValue.oninput(); }
    await tick();
    assert.strictEqual(sent.length, 0, 'no probe while typing');
    els.addValue.onchange();
    els.addValue.onchange();
    await tick();
    assert.deepStrictEqual(sent, [{ op: 'source-probe', repo: 'a/bc' }], 'once on leaving the box');
    // nothing listed: added with no channel, no note
    pending.shift()({ repo: 'a/bc', status: 'ok', releases: false, tags: false, defaultBranch: null, branches: [] });
    await tick();
    assert.strictEqual(els.addNote.textContent, '');
    submit();
    await tick();
    assert.deepStrictEqual(sent[1], { op: 'source-add', type: 'github', repo: 'a/bc' });
    // a /tree/ address adds that branch on the first Add, no probe
    sent.length = 0;
    els.addValue.value = 'https://github.com/x/y/tree/dev';
    els.addValue.oninput();
    submit();
    await tick();
    assert.deepStrictEqual(sent, [{ op: 'source-add', type: 'github', repo: 'x/y', channel: 'branch:dev' }]);
    // a catalog URL is added at once
    sent.length = 0;
    els.addType.value = 'https';
    els.addValue.value = 'https://example.org/catalog.json';
    els.addValue.oninput();
    submit();
    await tick();
    assert.deepStrictEqual(sent, [{ op: 'source-add', type: 'https', url: 'https://example.org/catalog.json' }]);
    console.log("page: all pass");
})().catch((e) => { console.error(e); process.exit(1); });
