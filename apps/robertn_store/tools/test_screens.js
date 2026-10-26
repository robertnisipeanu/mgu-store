'use strict';
/**
 * Offline check of the renderer screens: src/store_ui.js's values and
 * src/store_frame.js's frames for every screen of tools/fixture.js, at
 * iDrive 7's and iDrive 8's scale: drawn without an element error, what can
 * be pressed in focus order with its press, the texts each state shows,
 * scrolling that follows the focus, touch hits, package pictures. Node 8+.
 *
 *   node tools/test_screens.js
 */
const assert = require('assert');
const path = require('path');
const { frame, hit, placement, VIEWPORT } = require(path.join(__dirname, '..', 'src', 'store_frame.js'));
const fixture = require('./fixture.js');

let checks = 0;
const eq = (got, want, msg) => { checks += 1; assert.deepStrictEqual(got, want, msg); };
const ok = (cond, msg) => { checks += 1; assert(cond, msg); };
const SCALES = { 'iDrive 7': placement(1796, 632).scale, 'iDrive 8': placement(2880, 764).scale };

function screen(name, over, stOver) {
    const s = fixture.screens().find((x) => x[0] === name);
    const st = s[2] || stOver ? Object.assign(fixture.state(), s[2] || {}, stOver || {}) : undefined;
    const m = fixture.model(Object.assign({}, s[1], over || {}), st);
    const f = frame(m, { textScale: SCALES['iDrive 7'], focus: m.focus, scroll: {} });
    f.labels = f.items.map((i) => i.label);
    return f;
}
const own = (f) => f.labels.slice(0, -4);      // a page's items before its side menu
const text = (f, el) => (f.values[el] || {}).text;

ok(SCALES['iDrive 7'] > 0.64 && SCALES['iDrive 7'] < 0.66 && SCALES['iDrive 8'] > 1 && SCALES['iDrive 8'] < 1.02,
    `the design's content scaled into each box: ${JSON.stringify(SCALES)}`);
Object.keys(SCALES).forEach((unit) => fixture.screens().forEach(([name, over, stOver]) => {
    const st = stOver ? Object.assign(fixture.state(), stOver) : undefined;
    const m = fixture.model(over, st);
    const f = frame(m, { textScale: SCALES[unit], focus: m.focus, scroll: {} });
    ok(!f.rec.errors, `${unit} ${name}: every element draws (${f.rec.errors})`);
    ok(f.items.length && f.items.every((it) => it.label && it.act), `${unit} ${name}: every item has a label and a press`);
    ok(f.items.filter((it) => !it.reveal).every((it) => it.x >= VIEWPORT.x - 1 && it.x + it.w <= VIEWPORT.x + VIEWPORT.w + 1),
        `${unit} ${name}: items in view`);
}));

// the Store tab: side menu, filters, a tile per component with its state
let f = screen('store');
eq(f.labels.slice(0, 7), ['Store', 'Installed', 'USB', 'Settings', 'All', 'Apps', 'Tools']);
eq(f.labels.length, 7 + fixture.state().components.length, 'a tile per component');
eq(f.items[7].act, { do: 'open', page: { name: 'app', id: 'robertn_store' } });
const subs = f.values.grid.items.map((t) => t.sub);
['Downloading 42 %', 'For iDrive 8', 'Update a1b2c3d', 'Waiting', 'Restart pending', 'Failed', 'Installed', '2.1.0 · 402 KB']
    .forEach((s) => ok(subs.indexOf(s) >= 0, `a tile says ${s}`));
eq(f.values.nav.items.map((i) => i.badge), ['', '3', '2', ''], 'badges: updates, new on the stick');
eq(f.values.online.items[0].text, 'Online');
eq(text(f, 'subtitle'), 'Downloading 42 % · DOOM');
ok(screen('store-apps').values.grid.items.every((t) => t.kind === 'app'), 'Apps leaves the tools out');

// focus on a tile out of view scrolls it in; hit() takes only what is in view
const many = fixture.state();
for (let i = 0; i < 30; i++) {
    many.components.push(Object.assign({}, many.components[3], { id: `x${i}`, title: `Extra ${i}` }));
}
const scroll = {};
f = frame(fixture.model({}, many), { textScale: 1, focus: 7 + 40, scroll });
ok(scroll['store.grid'] > 0 && !f.items[47].reveal, 'the focused tile scrolled into view');
eq(hit(f.items, f.items[47].x + 5, f.items[47].y + 5), 47);
ok(f.items[7].reveal, 'the first tiles out of view now');
eq(hit(f.items, f.items[7].x + 5, f.items[7].y + 5), -1, 'and not hit');

// a component's page: its install, update, replace, or nothing; Remove
f = screen('app-update');
eq(own(f), ['Update to a1b2c3d', 'Remove', 'Back'], 'a page: its buttons, Back, the side menu');
eq(f.items[1].act, { do: 'open', page: { name: 'confirm', kind: 'remove', id: 'raluca' } });
ok(/^Voice assistant/.test(text(f, 'desc')), 'the description');
eq(f.values.facts.items.map((c) => c.text), ['Version 1.2.0', 'Commit a1b2c3d', 'App', 'iDrive 7 and iDrive 8']);
f = screen('app-incompatible');
eq(own(f), ['Back'], 'not for this unit: nothing to press');
eq([text(f, 'note1'), text(f, 'note2')], ['For iDrive 8', 'This head unit: iDrive 7']);
f = screen('app-replace');
eq(own(f), ['Replace GPU renderer', 'Back']);
eq(f.items[0].act, { do: 'open', page: { name: 'confirm', kind: 'replace', id: 'mgu-render' } });
eq(text(f, 'note1'), 'Replaces GPU renderer');
f = screen('app-downloading');
eq(own(f), ['Back'], 'nothing to press while it downloads');
eq([f.values.progress.label, f.values.progress.right, f.values.icon.progress], ['Downloading', '42 %', 0.42]);

// confirm steps: Cancel first
f = screen('confirm-replace');
eq(f.items.map((i) => [i.label, i.act]), [['Cancel', { do: 'back' }], ['Replace', { do: 'replace', id: 'mgu-render' }]]);
eq(text(f, 'title'), 'Replace GPU renderer with Renderer 0.1.0?');
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

// Accounts: Sign in with GitHub only with state.signin
eq(own(screen('accounts')), ['robertn', '0badc0de', 'Sign in with GitHub', 'Back']);
eq(own(screen('accounts', {}, { signin: false })), ['robertn', '0badc0de', 'Back']);

// sign-in, phone, channel, no updater
f = screen('login');
eq([text(f, 'code'), text(f, 'status'), f.values.qr.text], ['WDJB-MJHT', 'Waiting for sign-in', 'https://github.com/login/device']);
eq(own(f), ['Cancel', 'Back']);
f = screen('phone');
eq(own(f), ['Phone access', 'Back']);
ok(/#t=6f1c/.test(f.values.qr.text), 'the access URL as QR code');
eq(screen('channel').items.slice(0, 3).map((i) => i.act), [{ do: 'channel', channel: 'releases' },
    { do: 'channel', channel: 'tags' }, { do: 'channel', channel: 'branch' }]);
eq(text(screen('offline'), 'subtitle'), 'Restart the head unit to finish setup');

// package pictures: components[].icon is drawn from that file
f = screen('store', {}, { components: [Object.assign(fixture.state().components[1], { icon: '/run/mgu-updater/icons/doom.png' })] });
eq([f.values.grid.items[0].icon, f.icons], ['key:/run/mgu-updater/icons/doom.png', ['/run/mgu-updater/icons/doom.png']]);

console.log(`screens: ${fixture.screens().length} screens at 2 scales, ${checks} checks pass`);
