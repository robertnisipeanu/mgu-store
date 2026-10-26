'use strict';
/**
 * Offline check of the renderer screens: src/store_ui.js's values and
 * src/store_frame.js's frames for every screen of tools/fixture.js, in
 * iDrive 7's boxes (the compact layout) and iDrive 8's (the design, scaled):
 * drawn without an element error, inside the box, what can
 * be pressed in focus order with its press, the texts each state shows,
 * scrolling that follows the focus, touch hits, package pictures. Node 8+.
 *
 *   node tools/test_screens.js
 */
const assert = require('assert');
const path = require('path');
const { frame, hit, placement } = require(path.join(__dirname, '..', 'src', 'store_frame.js'));
const SCREENS = require(path.join(__dirname, '..', 'src', 'am_screens.js'));
const fixture = require('./fixture.js');

let checks = 0;
const eq = (got, want, msg) => { checks += 1; assert.deepStrictEqual(got, want, msg); };
const ok = (cond, msg) => { checks += 1; assert(cond, msg); };
const UNITS = { 'iDrive 7 embed': placement(1796, 632), 'iDrive 7 layer': placement(1790, 638), 'iDrive 8': placement(2880, 764) };
const ID7 = UNITS['iDrive 7 embed'];
const RING = 11;                // the focus ring's reach outside an item (8 out, 5 wide)

function screen(name, over, stOver) {
    const s = fixture.screens().find((x) => x[0] === name);
    const st = s[2] || stOver ? Object.assign(fixture.state(), s[2] || {}, stOver || {}) : undefined;
    const m = fixture.model(Object.assign({}, s[1], over || {}), st);
    const f = frame(m, { textScale: ID7.scale, focus: m.focus, scroll: {}, layout: ID7.layout });
    f.labels = f.items.map((i) => i.label);
    return f;
}
const own = (f) => f.labels.slice(0, -4);      // a page's items before its side menu
const text = (f, el) => (f.values[el] || {}).text;

const I8 = UNITS['iDrive 8'];
ok(I8.scale > 1 && I8.scale < 1.02 && !I8.layout, 'iDrive 8: the design scaled into its box');
[['iDrive 7 embed', 1796, 632], ['iDrive 7 layer', 1790, 638]].forEach(([unit, w, h]) => {
    const p = UNITS[unit];
    const vp = p.viewport;
    eq([p.scale, p.ox, p.oy, vp, p.layout.design], [1, 0, 0, { x: 0, y: 0, w, h }, { w, h }], `${unit}: its own layout for the box at scale 1`);
    SCREENS.screens.forEach((def) => {
        const own = p.layout.screens.find((s) => s.name === def.name);
        eq(own.components.map((c) => c.name).sort(), def.components.map((c) => c.name).sort(), `${unit} ${def.name}: the design's elements`);
        own.components.forEach((c) => ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= vp.w && c.y + c.h <= vp.h,
            `${unit} ${def.name}.${c.name} inside the box: ${JSON.stringify([c.x, c.y, c.w, c.h])}`));
    });
    const grid = p.layout.screens.find((s) => s.name === 'store').components.find((c) => c.name === 'grid');
    eq(Math.floor(grid.h / grid.opts.tileH), 3, `${unit}: three rows of tiles`);
});
Object.keys(UNITS).forEach((unit) => fixture.screens().forEach(([name, over, stOver]) => {
    const p = UNITS[unit];
    const vp = p.viewport;
    const ring = p.layout ? RING : 0;
    const st = stOver ? Object.assign(fixture.state(), stOver) : undefined;
    const m = fixture.model(over, st);
    const f = frame(m, { textScale: p.scale, focus: m.focus, scroll: {}, layout: p.layout });
    ok(!f.rec.errors, `${unit} ${name}: every element draws (${f.rec.errors})`);
    ok(f.items.length && f.items.every((it) => it.label && it.act), `${unit} ${name}: every item has a label and a press`);
    const out = f.items.filter((it) => !it.reveal && !(it.x - ring >= vp.x - 1 && it.x + it.w + ring <= vp.x + vp.w + 1 &&
        (!p.layout || (it.y - ring >= vp.y && it.y + it.h + ring <= vp.y + vp.h))));
    eq(out.map((it) => it.label), [], `${unit} ${name}: items and their focus ring in view`);
}));

// the Store tab: side menu, filters, a tile per component with its state
let f = screen('store');
eq(f.labels.slice(0, 7), ['Store', 'Installed', 'USB', 'Settings', 'All', 'Apps', 'Tools']);
eq(f.labels.length, 7 + fixture.state().components.length, 'a tile per component');
eq(f.items[7].act, { do: 'open', page: { name: 'app', id: 'robertn_store' } });
const subs = f.values.grid.items.map((t) => t.sub);
['Downloading 42 %', 'Not for this head unit', 'Update a1b2c3d', 'Waiting', 'Restart pending', 'Failed', 'Installed', '2.1.0 · 402 KB']
    .forEach((s) => ok(subs.indexOf(s) >= 0, `a tile says ${s}`));
eq(f.values.nav.items.map((i) => i.badge), ['', '3', '1', ''], 'badges: updates, new on the stick (not one for another head unit)');
eq(f.values.online.items[0].text, 'Online');
eq(text(f, 'subtitle'), 'Downloading 42 % · DOOM');
ok(screen('store-apps').values.grid.items.every((t) => t.kind === 'app'), 'Apps leaves the tools out');

// focus on a tile out of view scrolls it in; hit() takes only what is in view
const many = fixture.state();
for (let i = 0; i < 30; i++) {
    many.components.push(Object.assign({}, many.components[3], { id: `x${i}`, title: `Extra ${i}` }));
}
const scroll = {};
f = frame(fixture.model({}, many), { textScale: 1, focus: 7 + 40, scroll, layout: ID7.layout });
ok(scroll['store.grid'] > 0 && !f.items[47].reveal, 'the focused tile scrolled into view');
eq(hit(f.items, f.items[47].x + 5, f.items[47].y + 5), 47);
ok(f.items[7].reveal, 'the first tiles out of view now');
eq(hit(f.items, f.items[7].x + 5, f.items[7].y + 5), -1, 'and not hit');

// a component's page: its install, update, or nothing; Remove
f = screen('app-update');
eq(own(f), ['Update to a1b2c3d', 'Remove', 'Back'], 'a page: its buttons, Back, the side menu');
eq(text(f, 'author'), 'by robertn · from cauliflower/idrive7-apps');
eq(f.items[1].act, { do: 'open', page: { name: 'confirm', kind: 'remove', id: 'raluca' } });
ok(/^Voice assistant/.test(text(f, 'desc')), 'the description');
eq(f.values.facts.items.map((c) => c.text), ['Version 1.2.0', 'Commit a1b2c3d', 'App', 'iDrive 7 and iDrive 8']);
f = screen('app-incompatible');
eq(own(f), ['Back'], 'not for this unit: nothing to press');
eq([text(f, 'note1'), text(f, 'note2')], ['Not for this head unit', 'For iDrive 8']);
// an installed component whose new version is not for this unit: installed, no update offered, Remove stays
const st = Object.assign(fixture.state(), { busy: null });
st.components = [Object.assign({}, st.components[1], { compat: 'no', mguHmi: ['ID8'] })];
f = frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }, st), { textScale: 1, focus: 0, scroll: {} });
eq([f.items.map((i) => i.label).slice(0, -4), text(f, 'note1')], [['Remove', 'Back'], 'Not for this head unit']);
f = frame(fixture.model({}, st), { textScale: 1, focus: 0, scroll: {} });
eq([f.values.grid.items[0].sub, f.values.grid.items[0].badge, f.values.nav.items[1].badge], ['Not for this head unit', 'installed', ''],
    'says so, installed, not counted as an update');
// an app installed beside another source's app of its id shows the id it has; one built elsewhere cannot install
const two = Object.assign(fixture.state(), { busy: null });
two.components = [Object.assign({}, two.components[1], { id: 'doom2', listedId: 'doom', status: 'available', installed: null, error: null }),
    Object.assign({}, two.components[1], { id: 'doom@iterio', listedId: 'doom', status: 'available', installed: null, error: null,
        blocked: 'doom is already installed from robertnisipeanu/mgu-apps' })];
const page = (id) => {
    const p = frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id }] }, two), { textScale: 1, focus: 0, scroll: {} });
    p.labels = p.items.map((i) => i.label);
    return p;
};
f = page('doom2');
ok(f.values.facts.items.some((c) => c.text === 'Id doom2') && own(f)[0] === 'Install', 'doom2: its id, and Install');
f = page('doom@iterio');
eq([own(f), text(f, 'note1')], [['Back'], 'doom is already installed from robertnisipeanu/mgu-apps'], 'blocked: why, nothing to press');
ok(!f.values.facts.items.some((c) => /^Id /.test(c.text)), 'blocked: no id of its own');
f = frame(fixture.model({}, two), { textScale: 1, focus: 0, scroll: {} });
eq(f.values.grid.items[1].sub, 'Not installable');
f = screen('app-renderer');
eq(own(f), ['Install', 'Back'], 'a second renderer installs beside the first');
eq(f.items[0].act, { do: 'install', id: 'mgu-render' });
eq([text(f, 'note1'), f.values.facts.items.map((c) => c.text).pop()], ['', 'renderer']);
f = screen('app-downloading');
eq(own(f), ['Back'], 'nothing to press while it downloads');
eq([f.values.progress.label, f.values.progress.right, f.values.icon.progress], ['Downloading', '42 %', 0.42]);

// confirm steps: Cancel first
f = screen('confirm-remove');
eq(f.labels, ['Cancel', 'Remove']);
eq(text(f, 'title'), 'Remove Raluca 1.2.0?');
eq(screen('confirm-restart').items[1].act, { do: 'restart' });
f = screen('confirm-account');
eq(f.items[1].act, { do: 'account-remove', id: '3f9a01c2' });
eq(text(f, 'text'), 'robertn · robertnisipeanu/mgu-store');

// Installed: Update all for what can update now; a row's chip updates it
f = screen('installed');
eq(f.labels[4], 'Update all (1)', 'DOOM downloads and Extended dashboard waits: one update left');
eq(f.items.find((i) => i.label === 'Update').act, { do: 'install', id: 'raluca' });
ok(f.labels.indexOf('Display bridge') >= 0 && f.labels.indexOf('M Vitals') < 0, 'installed ones only');

// USB: the stick's components
f = screen('usb');
eq(f.labels.slice(4), ['Car Data', 'Drive Recorder', 'GPU renderer']);
eq(text(f, 'subtitle'), 'USB STICK · 3 packages');

// Settings: sources, Add source, Accounts, Phone access, the unit; no restart while busy
f = screen('settings');
eq(f.labels.slice(4), ['robertnisipeanu/mgu-store', 'cauliflower/idrive7-apps', 'IterioDev/car-apps', 'USB STICK', 'Add source',
    'Accounts', 'Phone access', 'Check now']);
eq(text(f, 'unit'), 'iDrive 7 · BMW MGU P18_23w44.2-1-3 mgu-high');
eq(text(f, 'versions'), 'Updater 0.4.0 · Store 0.7.0 · Renderer mgu-renderd 1.1.0');
eq(text(screen('settings', {}, { allProviders: { renderer: [{ id: 'mgu-render', version: '0.2.0' }, { id: 'mgu-renderd', version: '1.1.2' }] } }),
    'versions'), 'Updater 0.4.0 · Store 0.7.0 · Renderer mgu-render 0.2.0, mgu-renderd 1.1.2', 'every installed renderer');
const idle = { busy: null, components: fixture.state().components.map((c) => Object.assign({}, c, { queued: false })) };
ok(screen('settings', {}, idle).labels.indexOf('Restart head unit') >= 0, 'Restart head unit with nothing installing');

// a source: Remove; the GitHub App's install page while a sign-in does not reach it
f = screen('source');
eq(own(f), ['Remove', 'Back']);
eq([f.values.appQr.text, f.values.panel.hidden], ['', true], 'a source that reads needs no install page');
f = screen('source-install-app');
eq([f.values.appLabel.text, f.values.appQr.text], ['Install on GitHub', 'https://github.com/apps/mgu-store/installations/new']);
eq(screen('source-install-app', {}, { signinApp: null }).values.appQr.text, '', 'none without the App');
eq(screen('source-install-app', {}, { tokens: [] }).values.appQr.text, '', 'none before a sign-in');

// Accounts: Sign in with GitHub only with state.signin; Add token; Add token's status line
eq(own(screen('accounts')), ['robertn', '0badc0de', 'Sign in with GitHub', 'Add token', 'Back']);
eq(own(screen('accounts', {}, { signin: false })), ['robertn', '0badc0de', 'Add token', 'Back']);
eq(screen('accounts').items[3].act, { do: 'add-token' });
f = screen('accounts-token-refused');
eq([text(f, 'status'), f.values.status.color], ['Add token failed: GitHub does not accept this token', '#ffb020']);

// sign-in, phone, no updater
f = screen('login');
eq([text(f, 'code'), text(f, 'status'), f.values.qr.text], ['WDJB-MJHT', 'Waiting for sign-in', 'https://github.com/login/device']);
eq(own(f), ['Cancel', 'Back']);
f = screen('phone');
eq(own(f), ['Phone access', 'Back']);
ok(/#t=6f1c/.test(f.values.qr.text), 'the access URL as QR code');
eq(text(screen('offline'), 'subtitle'), 'Restart the head unit to finish setup');

// package pictures: components[].icon is drawn from that file
f = screen('store', {}, { components: [Object.assign(fixture.state().components[1], { icon: '/run/mgu-updater/icons/doom.png' })] });
eq([f.values.grid.items[0].icon, f.icons], ['key:/run/mgu-updater/icons/doom.png', ['/run/mgu-updater/icons/doom.png']]);

console.log(`screens: ${fixture.screens().length} screens in ${Object.keys(UNITS).length} boxes, ${checks} checks pass`);
