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
const { view } = require(path.join(__dirname, '..', 'src', 'store_ui.js'));

let checks = 0;
const eq = (got, want, msg) => { checks += 1; assert.deepStrictEqual(got, want, msg); };
const ok = (cond, msg) => { checks += 1; assert(cond, msg); };
const UNITS = { 'iDrive 7 embed': placement(1796, 632), 'iDrive 7 layer': placement(1790, 638), 'iDrive 7 full screen': placement(1836, 720, true),
    'iDrive 8': placement(2880, 764) };
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
// a component page's version chip (it opens the changelog) is checked on its own
const notVersion = (l) => !/^Version /.test(l);
const own = (f) => f.labels.slice(0, -4).filter(notVersion);      // a page's items before its side menu
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
    eq([grid.opts.cols, grid.h / grid.opts.tileH > 2.3 && grid.h / grid.opts.tileH < 2.5], [4, true], `${unit}: four tiles a row, under two and a half rows in view`);
    // the iDrive 7 look's layout: the same elements, in the box, the menu along the bottom under everything else
    SCREENS.screens.forEach((def) => {
        const own = p.layout.id7.screens.find((s) => s.name === def.name);
        eq(own.components.map((c) => c.name).sort(), def.components.map((c) => c.name).sort(), `${unit} ${def.name} (id7): the design's elements`);
        const nav = own.components.find((c) => c.name === 'nav');
        ok(nav.w > nav.h && nav.y + nav.h <= vp.h && own.components.every((c) => c === nav || c.y + c.h <= nav.y),
            `${unit} ${def.name} (id7): the menu along the bottom, under the rest`);
    });
});
// every screen in both looks (Settings), in every box
Object.keys(UNITS).forEach((unit) => ['id7', 'id8'].forEach((look) => fixture.screens().forEach(([n, over, stOver]) => {
    const p = UNITS[unit];
    const vp = p.viewport;
    const ring = p.layout ? RING : 0;
    const name = `${n} (${look} look)`;
    const st = stOver ? Object.assign(fixture.state(), stOver) : undefined;
    const m = Object.assign(fixture.model(over, st), { look });
    const f = frame(m, { textScale: p.scale, focus: m.focus, scroll: {}, layout: p.layout });
    ok(!f.rec.errors, `${unit} ${name}: every element draws (${f.rec.errors})`);
    ok(f.items.length && f.items.every((it) => it.label && it.act), `${unit} ${name}: every item has a label and a press`);
    const out = f.items.filter((it) => !it.reveal && !(it.x - ring >= vp.x - 1 && it.x + it.w + ring <= vp.x + vp.w + 1 &&
        (!p.layout || (it.y - ring >= vp.y && it.y + it.h + ring <= vp.y + vp.h))));
    eq(out.map((it) => it.label), [], `${unit} ${name}: items and their focus ring in view`);
})));

// the Store tab: side menu, filters, a tile per component with its state
let f = screen('store');
eq(f.labels.slice(0, 7), ['Store', 'Installed', 'USB', 'Settings', 'All', 'Apps', 'Tools']);
eq(f.labels.length, 7 + fixture.state().components.length - 1, 'a tile per component but the one for another head unit only');
ok(f.labels.indexOf('Car Data') < 0, 'Car Data (iDrive 8 only, not installed) is not listed');
// what is not on the car first
eq(f.items[7].act, { do: 'open', page: { name: 'app', id: 'car_vitals', source: 'idrive7-apps', listed: 'car_vitals' } });
ok(f.values.grid.items.findIndex((t) => t.badge === 'installed') > f.values.grid.items.findIndex((t) => t.id === 'car_vitals'), 'not installed before installed');
const subs = f.values.grid.items.map((t) => t.sub);
['Downloading 42 %', 'Update 1.2.0', 'Waiting', 'Restart pending', 'Failed', 'Installed', '2.1.0 · 402 KB']
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

// a drag scrolls by the pixel: a grid stops part way through a row, both part-shown rows draw and take a tap
const half = { 'store.grid': 0.5 };
f = frame(fixture.model({}, many), { textScale: 1, focus: -1, scroll: half, layout: ID7.layout });
const g = f.regions.find((r) => r.key === 'store.grid');
eq(f.items[7].y, g.y - g.step / 2, 'the first row half scrolled out');
eq(hit(f.items, f.items[7].x + 5, g.y + 5), 7, 'its shown half takes a tap');
eq(hit(f.items, f.items[7].x + 5, f.items[7].y + 5), -1, 'its hidden half does not');
const low = f.items.findIndex((it) => it.y < g.y + g.h && it.y + it.h > g.y + g.h);
ok(low > 7 && f.items[low].reveal && hit(f.items, f.items[low].x + 5, g.y + g.h - 2) === low, 'the part-shown last row takes a tap');
ok(g.max % 1 !== 0, 'the grid scrolls to its last row flush with the bottom');

// a component's page: its install, update, or nothing; Remove
f = screen('app-update');
eq(own(f), ['Update to 1.2.0', 'Remove', 'Back'], 'a page: its buttons, Back, the side menu');
eq(f.items.find((i) => i.label === 'Version 1.2.0').act, { do: 'open', page: { name: 'changelog', id: 'gauges' } }, 'the version opens the changelog');
eq(text(f, 'author'), 'by robertn · from cauliflowermossgrape/idrive7-apps');
eq(f.items[1].act, { do: 'open', page: { name: 'confirm', kind: 'remove', id: 'gauges' } });
ok(/^Speed, revs/.test(text(f, 'desc')), 'the description');
eq(f.values.facts.items.map((c) => c.text), ['Version 1.2.0', 'App', 'iDrive 7 and iDrive 8']);
// the changelog page: each version, then its notes in lines, none of them cut
f = screen('changelog-renderer');
const cl = f.values.list.items;
eq([text(f, 'title'), cl[0].title, cl[0].right], ['Renderer changelog', 'Version 0.4.0', 'chip:New']);
ok(cl.filter((i) => i.note).length >= 3 && cl.filter((i) => i.note).every((i) => i.title.length <= 110), 'notes in lines');
ok(cl.some((i) => i.title === 'Version 0.3.3'), 'the older version too');
f = screen('app-incompatible');
eq(own(f), ['Back'], 'not for this unit: nothing to press but its changelog');
eq([text(f, 'note1'), text(f, 'note2')], ['Not for this head unit', 'For iDrive 8']);
// an installed component whose new version is not for this unit: installed, no update offered, Remove stays
const st = Object.assign(fixture.state(), { busy: null });
st.components = [Object.assign({}, st.components[1], { compat: 'no', mguHmi: ['ID8'] })];
f = frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }, st), { textScale: 1, focus: 0, scroll: {} });
eq([f.items.map((i) => i.label).slice(0, -4).filter(notVersion), text(f, 'note1')], [['Remove', 'Back'], 'Not for this head unit']);
f = frame(fixture.model({}, st), { textScale: 1, focus: 0, scroll: {} });
eq([f.values.grid.items[0].sub, f.values.grid.items[0].badge, f.values.nav.items[1].badge], ['Not for this head unit', 'installed', ''],
    'says so, installed, not counted as an update');
// for another head unit only: listed while installed, under every filter, in either unit's box; unknown is listed
Object.keys(UNITS).forEach((unit) => ['all', 'app'].forEach((filter) => {
    const g = frame(fixture.model({ filter }, st), { textScale: UNITS[unit].scale, focus: 0, scroll: {}, layout: UNITS[unit].layout });
    eq(g.values.grid.items.map((t) => t.id), ['doom'], `${unit} ${filter}: installed, listed`);
}));
const gone = Object.assign({}, st, { components: [Object.assign({}, st.components[0], { installed: null, status: 'available' }),
    Object.assign({}, st.components[0], { id: 'quake', title: 'Quake', compat: 'unknown', mguHmi: null })] });
Object.keys(UNITS).forEach((unit) => {
    const g = frame(fixture.model({}, gone), { textScale: UNITS[unit].scale, focus: 0, scroll: {}, layout: UNITS[unit].layout });
    eq([g.values.grid.items.map((t) => t.id), g.values.nav.items[1].badge], [['quake'], '1'], `${unit}: removed, no longer listed; unknown listed`);
});
// its page, open while it is removed, stays on it
f = frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }, gone), { textScale: 1, focus: 0, scroll: {} });
eq([text(f, 'name'), text(f, 'note1')], ['DOOM', 'Not for this head unit']);
// an app installed beside another source's app of its id shows the id it has; one built elsewhere cannot install
const two = Object.assign(fixture.state(), { busy: null });
two.components = [Object.assign({}, two.components[1], { id: 'doom2', listedId: 'doom', installAs: 'doom2', status: 'available', installed: null,
    error: null, source: 'idrive7-apps' }),
    Object.assign({}, two.components[1], { id: 'doom@iterio', listedId: 'doom', installAs: 'doom', status: 'available', installed: null, error: null,
        blocked: 'doom is already installed from robertnisipeanu/mgu-apps', source: 'iterio' })];
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
// two sources' Doom: two tiles, each named with its source; a page follows its row when the install gives it another id
two.sources = [{ id: 'idrive7-apps', label: 'cauliflowermossgrape/idrive7-apps' }, { id: 'iterio', label: 'https://apps.example.org/index.json' }];
eq(frame(fixture.model({}, two), { textScale: 1, focus: 0, scroll: {} }).values.grid.items.map((t) => [t.title, t.src]),
    [['DOOM', 'idrive7-apps'], ['DOOM', 'apps.example.org']]);
// two sources of the same repo name: owner/repo on each
two.sources = [{ id: 'idrive7-apps', label: 'one/apps' }, { id: 'iterio', label: 'two/apps' }];
eq(frame(fixture.model({}, two), { textScale: 1, focus: 0, scroll: {} }).values.grid.items.map((t) => t.src), ['one/apps', 'two/apps']);
// the status line names the source of a row whose title another row has: downloading, and a failure
const sub = (st) => text(frame(fixture.model({}, st), { textScale: 1, focus: 0, scroll: {} }), 'subtitle');
two.sources = [{ id: 'idrive7-apps', label: 'cauliflowermossgrape/idrive7-apps' }, { id: 'iterio', label: 'someone/other-apps' }];
const dooms = (o) => Object.assign({}, two, { components: [Object.assign({}, two.components[0], o), Object.assign({}, two.components[1], { blocked: null })] });
eq(sub(Object.assign(dooms({}), { busy: { id: 'doom2', op: 'install', phase: 'download', progress: 42, total: 100 } })),
    'Downloading 42 % · DOOM (idrive7-apps)');
eq(sub(dooms({ error: 'the build failed (exit 3)' })), 'DOOM (idrive7-apps): the build failed (exit 3)');
// Remove? names which of two installed DOOMs; with one DOOM, its title alone
const confirmOf = (st) => text(frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom2' }, { name: 'confirm', kind: 'remove', id: 'doom2' }] }, st),
    { textScale: 1, focus: 0, scroll: {} }), 'title');
const both = dooms({ installed: '1.0.0', status: 'installed' });
both.components[1] = Object.assign({}, both.components[1], { installed: '1.0.1', status: 'installed' });
eq(confirmOf(both), 'Remove DOOM (idrive7-apps) 1.0.0?');
eq(confirmOf(Object.assign({}, both, { components: [both.components[0]] })), 'Remove DOOM 1.0.0?');
// one DOOM listed: its title alone
eq(sub(Object.assign({}, dooms({}), { components: [dooms({}).components[0]], busy: { id: 'doom2', op: 'install', phase: 'download', progress: 42, total: 100 } })),
    'Downloading 42 % · DOOM');
const moved = Object.assign({}, two, { components: [Object.assign({}, two.components[1], { id: 'doom', listedId: null, blocked: null,
    status: 'installed', installed: two.components[1].version })] });
const followed = frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom@iterio', source: 'iterio', listed: 'doom' }] }, moved),
    { textScale: 1, focus: 0, scroll: {} });
eq(text(followed, 'instValue'), two.components[1].version, 'the page shows the row it became');
f = screen('app-renderer');
eq(own(f), ['Install', 'Back'], 'a second renderer installs beside the first');
eq(f.items[0].act, { do: 'install', id: 'mgu-render' });
eq([text(f, 'note1'), f.values.facts.items.map((c) => c.text).pop()], ['', 'renderer']);
const broken = fixture.state();
broken.components = broken.components.map((c) => c.id === 'mgu-render' ? Object.assign({}, c, { installed: '0.1.0', status: 'installed',
    problem: 'In-page drawing unavailable: no identifier table in HmiMain3D' }) : c);
f = screen('app-renderer', {}, broken);
eq([text(f, 'problem'), text(f, 'note1')], ['In-page drawing unavailable: no identifier table in HmiMain3D', ''], 'an installed tool\'s problem');
f = screen('app-downloading');
eq(own(f), ['Back'], 'nothing to press while it downloads');
eq([f.values.progress.label, f.values.progress.right, f.values.icon.progress], ['Downloading', '42 %', 0.42]);
// an app install queued for the next start (iDrive 8): Restart pending and Restart head unit, no Install or Update
const later = Object.assign(fixture.state(), { busy: null });
later.components = [Object.assign({}, later.components[3], { pendingReboot: true }), Object.assign({}, later.components[1], { pendingReboot: true })];
const laterOf = (over) => frame(fixture.model(over, later), { textScale: 1, focus: 0, scroll: {} });
f = laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'car_vitals' }] });
eq([f.items.map((i) => i.label).slice(0, -4).filter(notVersion), text(f, 'note1')], [['Restart head unit', 'Back'], 'Restart pending'], 'first install');
eq(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }).items.map((i) => i.label).slice(0, -4).filter(notVersion),
    ['Restart head unit', 'Remove', 'Back'], 'update of an installed app');
f = laterOf({});
eq([f.values.grid.items.map((t) => [t.id, t.sub, t.badge]), f.values.nav.items[1].badge],
    [[['car_vitals', 'Restart pending', ''], ['doom', 'Restart pending', 'installed']], ''], 'tiles; not counted as an update');
f = laterOf({ tab: 'installed' });
eq([f.values.apps.items.map((i) => [i.id, i.right, i.chipAct]), f.values.updateAll.text], [[['doom', 'chip:Restart pending', null]], 'Check for updates'],
    'a pending restart is no update to install');
// with the updater's nextStart: a queued first install has Remove (drops it), a queued removal none; a failed apply shows why
later.components = [Object.assign({}, later.components[0], { nextStart: 'install' }),
    Object.assign({}, later.components[1], { status: 'installed', installed: '1.0.1', nextStart: 'remove' })];
eq(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'car_vitals' }] }).items.map((i) => i.label).slice(0, -4).filter(notVersion),
    ['Restart head unit', 'Remove', 'Back'], 'a queued first install can be removed');
eq(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }).items.map((i) => i.label).slice(0, -4).filter(notVersion),
    ['Restart head unit', 'Back'], 'a queued removal: not offered again');
eq(text(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'car_vitals' }, { name: 'confirm', kind: 'remove', id: 'car_vitals' }] }), 'title'),
    'Remove M Vitals?');
later.components = [Object.assign({}, later.components[0], { pendingReboot: false, nextStart: null,
    error: 'the install at the start of the head unit failed: package checksum mismatch at /x' })];
f = laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'car_vitals' }] });
eq([f.items.map((i) => i.label).slice(0, -4).filter(notVersion), text(f, 'note1')],
    [['Try again', 'Back'], 'Failed: the install at the start of the head unit failed: package checksum mismatch at /x'.slice(0, 80)]);
// with the updater's applyFailed: a failed first install also has Remove (clears it); a failed removal's Try again removes
later.components[0].applyFailed = 'install';
eq(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'car_vitals' }] }).items.map((i) => i.label).slice(0, -4).filter(notVersion),
    ['Try again', 'Remove', 'Back'], 'a failed first install can be cleared');
later.components = [Object.assign({}, fixture.state().components[1], { status: 'installed', installed: '1.0.1', applyFailed: 'remove',
    error: 'the removal at the start of the head unit failed: x' })];
f = laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] });
eq([f.items.map((i) => i.label).slice(0, -4).filter(notVersion), f.items[0].act], [['Try again', 'Back'], { do: 'open', page: { name: 'confirm', kind: 'remove', id: 'doom' } }],
    'a failed removal is tried again');

// confirm steps: Cancel first
f = screen('confirm-remove');
eq(f.labels, ['Cancel', 'Remove']);
eq(text(f, 'title'), 'Remove Gauges 1.2.0?');
eq(screen('confirm-restart').items[1].act, { do: 'restart' });
f = screen('confirm-account');
eq(f.items[1].act, { do: 'account-remove', id: '3f9a01c2' });
eq(text(f, 'text'), 'robertn · robertnisipeanu/mgu-store');

// Installed: Update all for what can update now; a row's Update chip is no button (the row opens its page)
f = screen('installed');
eq(f.labels[4], 'Install all updates (1)', 'DOOM downloads and Extended dashboard waits: one update left');
const noUp = screen('installed', {}, { components: fixture.state().components.map((c) => Object.assign({}, c, { status: c.installed ? 'installed' : c.status })) });
eq([noUp.values.updateAll.text, noUp.values.updateAll.act], ['Check for updates', { do: 'check' }], 'no update: Check for updates');
eq(screen('installed', { noNet: true }, { components: fixture.state().components.map((c) => Object.assign({}, c, { status: c.installed ? 'installed' : c.status })) }).values.updateAll.text,
    'No internet', 'checked with no internet and no USB stick: says so');
ok(!f.items.some((i) => i.label === 'Update'), 'the Update chip is not pressed on its own');
eq(f.items.find((i) => i.label === 'Extended dashboard' || i.act && i.act.page && i.act.page.id === 'gauges').act.do, 'open', 'its row opens the page');
ok(f.labels.indexOf('Display bridge') >= 0 && f.labels.indexOf('M Vitals') < 0, 'installed ones only');
eq(f.values.apps.items.filter((i) => i.id === 'gauges' || i.id === 'robertn_store').map((i) => i.sub),
    ['1.2.0 · new build · idrive7-apps', '0.7.0 · mgu-store'], 'a row names its source (an update first)');

// a tile's three lines (title, source, state) stay inside it, in either unit's box
const { DRAW } = require(path.join(__dirname, '..', 'src', 'am_store_widgets.js'));
Object.keys(UNITS).forEach((unit) => {
    const p = UNITS[unit];
    const def = (p.layout || SCREENS).screens.find((x) => x.name === 'store').components.find((c) => c.name === 'grid');
    const items = frame(fixture.model({}), { textScale: p.scale, focus: -1, scroll: {}, layout: p.layout }).values.grid.items;
    const texts = [];
    const shapes = [];
    const cv = new Proxy({}, { get: (o, k) => (k === 'text' ? (str, x, y, size) => texts.push({ str, y, size })
        : k === 'textWidth' ? (str, size) => String(str).length * size * 0.55
            : (x, y, w, h) => shapes.push({ y, h: h === undefined ? 0 : h })) });
    DRAW.appGrid(cv, { text: '#fff', dim: '#888' }, { x: def.x, y: def.y, w: def.w, h: def.h }, Object.assign({}, def.opts, { items }));
    const th = def.opts.tileH;
    // the first row's texts but the letter tiles' letters
    const row0 = texts.filter((t) => t.y < def.y + th && t.str.length > 1);
    eq(row0.slice(0, 3).map((t) => t.str), ['M Vitals', 'idrive7-apps', '2.1.0 · 402 KB'], `${unit}: title, source, state (not installed first)`);
    // the tile's bottom 8 px hold the focus rings (store_frame.js): every line, descenders included, ends above them
    ok(row0.every((t) => t.y + 0.25 * t.size <= def.y + th - 8),
        `${unit}: the lines clear of the focus rings (${row0.map((t) => Math.round(t.y + 0.25 * t.size))} of ${def.y + th - 8})`);
    ok(row0[1].size >= (def.opts.subSize || 30) * 0.85, `${unit}: the source line readable (${row0[1].size} px)`);
    // owner/repo too long for the tile: the owner shortened, the repo whole
    texts.length = 0;
    DRAW.appGrid(cv, { text: '#fff', dim: '#888' }, { x: def.x, y: def.y, w: def.w, h: def.h },
        Object.assign({}, def.opts, { items: [Object.assign({}, items[0], { src: 'cauliflowermossgrape-and-friends/idrive7-apps' })] }));
    ok(/^c.*…\/idrive7-apps$/.test(texts.find((t) => /idrive7/.test(t.str)).str), `${unit}: ${texts.map((t) => t.str)}`);
});

// USB: the stick's components
f = screen('usb');
eq(f.labels.slice(4), ['Drive Recorder', 'GPU renderer'], 'not the one for another head unit only');
eq(text(f, 'subtitle'), 'USB STICK · 2 packages');

// Settings: sources, Add source, Wi-Fi, Accounts, Phone access, the unit; no restart while busy
f = screen('settings');
eq(f.labels.slice(4), ['iDrive 7', 'iDrive 8', 'robertnisipeanu/mgu-store', 'cauliflowermossgrape/idrive7-apps', 'IterioDev/car-apps', 'USB STICK',
    'Add source', 'Wi-Fi', 'Internet', 'Accounts', 'Phone access', 'Information', 'Check now']);
// the look: the head unit's own until one is picked; each pick is a press
eq(f.items.filter((i) => /^iDrive/.test(i.label)).map((i) => i.act), [{ do: 'look', look: 'id7' }, { do: 'look', look: 'id8' }]);
eq(view(fixture.model({ tab: 'settings' })).look, 'id7', 'an iDrive 7 unit: the iDrive 7 look');
eq(view(fixture.model({ tab: 'settings' }, { unit: { hmi: 'ID8' } })).look, 'id8', 'an iDrive 8 unit: the iDrive 8 look');
eq(view(fixture.model({ tab: 'settings', look: 'id8' })).values.look.sel, 1, 'the picked look is selected');
// the head unit's line on the Information row; its page lists the head unit and every version
const infoRow = f.values.access.items.find((i) => i.id === 'info');
eq([infoRow.title, infoRow.sub, infoRow.act], ['Information', 'iDrive 7 · BMW MGU P18_23w44.2-1-3 mgu-high', { do: 'open', page: { name: 'information' } }]);
const info = view(fixture.model({ tab: 'settings', stack: [{ name: 'main' }, { name: 'information' }] })).values.list.items;
eq(info.slice(0, 3).map((i) => [i.title, i.right]), [['iDrive 7', ''], ['Store', 'chip:0.7.0'], ['Updater', 'chip:0.4.0']], 'Information: the head unit, the Store, the updater');
ok(info.some((i) => i.id === 'mgu-renderd' && i.right === 'chip:1.1.0'), 'Information: an installed renderer and its version');
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

// a repo being added: only what it has, then Back; Sign in and Add token while no account reaches it, Try again after a failure
f = screen('pick');
eq(own(f), ['Releases', 'main', 'develop', 'feature/gauges', 'redline', 'Back']);
eq([text(f, 'title'), text(f, 'status')], ['cauliflowermossgrape/idrive7-apps', '']);
eq(f.items[2].act, { do: 'pick', channel: 'branch:develop' });
f = screen('pick-private');
eq(own(f), ['Sign in with GitHub', 'Add token', 'Back']);
eq(text(f, 'status'), 'Not found or private');
eq(text(screen('pick-private', { accountsNote: { text: 'Checking token', error: false },
    pick: { repo: 'someone/private-apps', probe: { status: 'auth-needed' }, tokenNote: true } }), 'status'), 'Checking token',
'Add token pressed on the page: its status there');
eq(text(screen('pick-private', { accountsNote: { text: 'Added octo', error: false } }), 'status'), 'Not found or private',
    'an Add token from elsewhere: not');
eq(screen('pick-private').items[1].act, { do: 'pick-add-token' });
f = screen('pick-offline');
eq([own(f), text(f, 'status')], [['Try again', 'Back'], 'Offline']);
eq(f.items[0].act, { do: 'pick-retry' });
eq(text(screen('pick', { pick: { repo: 'o/r', probe: null } }), 'status'), 'Checking');

// the type page (iDrive 8's text entry): the text, the keyboard's keys in focus order, each pressing what it types
const { typeKey } = require(path.join(__dirname, '..', 'src', 'store_ui.js'));
f = screen('type');
eq([text(f, 'title'), text(f, 'field')], ['Add source', 'robertnisipeanu/mgu-store']);
eq(own(f).slice(0, 11), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'q']);
eq(own(f).slice(-8), ['https://', 'github.com/', '.com', '-', '_', ':', 'OK', 'Back'], 'App Manager 2\'s URL keys, OK, Back');
eq(f.items[0].act, { do: 'key', key: '1' });
ok(own(f).indexOf('#+=') < 0, 'the URL keys have no symbols page');
f = screen('type-token');
eq(text(f, 'field'), '········3c4d', 'a token: its last 4 characters');
ok(own(f).indexOf('Q') >= 0 && own(f).indexOf('q') < 0, 'Shift: capitals');
eq(own(screen('type-symbols')).slice(10, 20), ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'], 'the symbols page');
/* Presses keys by what they show on the page's frame in unit's box; true once its Enter key was pressed. */
function typeOn(unit, page, keys) {
    const p = UNITS[unit];
    let done = false;
    keys.forEach((label) => {
        const items = frame(fixture.model({ tab: 'settings', stack: [{ name: 'main' }, page] }),
            { textScale: p.scale, focus: -1, scroll: {}, layout: p.layout }).items;
        const k = items.find((i) => i.label === label);
        ok(k && k.act.do === 'key', `${unit}: a key ${label} (${items.map((i) => i.label)})`);
        done = typeKey(page, k.act.key) || done;
    });
    return done;
}
Object.keys(UNITS).forEach((unit) => {
    let page = { name: 'type', title: 'Add source', text: '' };
    ok(!typeOn(unit, page, ['github.com/', 'Shift', 'O', 'Shift', '/', 'r', '_', '1', 'Delete', '2']), `${unit}: not done while typing`);
    eq(page.text, 'github.com/O/r_2', `${unit}: URL keys, Shift, Delete`);
    ok(typeOn(unit, page, ['OK']) && page.text === 'github.com/O/r_2', `${unit}: OK gives the text`);
    page = { name: 'type', title: 'Password', text: '', layout: 'text', symbols: true, go: 'Connect' };
    typeOn(unit, page, ['Shift', 'W', 'Shift', 'i', '#+=', '-', '\\', '"', '`', 'abc', 'Space', 'x', 'Delete', '!']);
    eq(page.text, 'Wi-\\"` !', `${unit}: Shift, the symbols page and back, Space, Delete`);
    ok(typeOn(unit, page, ['Connect']), `${unit}: its Enter key says Connect`);
});
// the word keys with their symbols page type every printable ASCII character
const reach = new Set();
[{ shift: false }, { shift: true }, { sym: true }].forEach((o) => own(screen('type-text',
    { stack: [{ name: 'main' }, Object.assign({ name: 'type', layout: 'text', symbols: true, go: 'Connect' }, o)] }))
    .forEach((l) => reach.add(l === 'Space' ? ' ' : l)));
eq(Array.from({ length: 95 }, (x, i) => String.fromCharCode(32 + i)).filter((c) => !reach.has(c)), [], 'ASCII 32 to 126');
const capped = { name: 'type', text: '', max: 3 };
typeOn('iDrive 8', capped, ['a', 'b', 'c', 'd']);
eq(capped.text, 'abc', 'no more than max');
const near = { name: 'type', text: '', max: 10 };
typeOn('iDrive 8', near, ['a', 'github.com/', '.com', 'b']);
eq(near.text, 'a.comb', 'a key that would go past max types nothing');

// Wi-Fi (the uplink's, state.uplink.wifi): Settings' row with its state, only with the uplink's Wi-Fi
f = screen('settings');
eq([f.values.access.items[0].title, f.values.access.items[0].sub], ['Wi-Fi', 'Online · Mario iPhone']);
eq(f.items.find((i) => i.label === 'Wi-Fi').act, { do: 'open', page: { name: 'wifi' } });
ok(screen('settings', {}, { uplink: null }).labels.indexOf('Wi-Fi') < 0, 'no Wi-Fi without the uplink (an updater before 0.8.0)');
ok(screen('settings', {}, { uplink: { device: null, state: 'searching', error: null, preferred: '', wifi: null } }).labels.indexOf('Wi-Fi') < 0,
    'nor with an uplink without Wi-Fi (before 0.7.0, or not on auto)');
const wifiSub = (w) => screen('settings', {}, { uplink: Object.assign({}, fixture.state().uplink, { wifi: Object.assign({}, fixture.state().uplink.wifi, w) }) })
    .values.access.items[0].sub;
eq([{ link: 'connected' }, { link: 'connecting', ssid: 'Cafe' }, { enabled: false, link: 'off', ssid: '' },
    { link: 'unavailable', ssid: '', error: 'wlan1 is in access point mode' },
    { link: 'failed', ssid: '', error: 'wpa_supplicant ended (exit status 1)' }, { link: 'idle', ssid: '', error: 'could not join Cafe' },
    { link: 'idle', ssid: '' }].map(wifiSub),
['Connected · Mario iPhone', 'Connecting · Cafe', 'Not used', 'Unavailable', 'Failed', 'Error', 'Not connected']);
// the page: the network joined first, then the scan's, then saved ones out of range; a tap joins a saved or open one and asks a
// secured one's password; a saved one has Forget; Don't use Wi-Fi, Scan, the preferred connection
f = screen('wifi');
eq(own(f), ['Forget', 'FRITZ!Box 7590 XY', 'Cafe Free WiFi', 'Telekom_FON', 'Forget', "Don't use Wi-Fi", 'Scan', 'Preferred: Wi-Fi', 'Back']);
eq(f.values.networks.items.map((n) => n.sub), ['Online · Strong', 'Secured · Strong', 'Open · Good', 'Open · Weak', 'Saved · not in range']);
eq([text(f, 'subtitle'), text(f, 'state'), text(f, 'info')], ['5 networks', 'Online · Mario iPhone', 'IP 172.20.10.3 · -52 dBm']);
eq(f.items.slice(0, 5).map((i) => i.act), [{ do: 'open', page: { name: 'confirm', kind: 'wifi-forget', ssid: 'Mario iPhone' } },
    { do: 'wifi-password', ssid: 'FRITZ!Box 7590 XY' }, { do: 'wifi-join', ssid: 'Cafe Free WiFi' }, { do: 'wifi-join', ssid: 'Telekom_FON' },
    { do: 'open', page: { name: 'confirm', kind: 'wifi-forget', ssid: 'Home' } }]);
eq(f.items.slice(5, 8).map((i) => i.act), [{ do: 'wifi-power' }, { do: 'wifi-scan' }, { do: 'open', page: { name: 'prefer' } }]);
f = screen('wifi-off');
eq([own(f), f.values.networks.empty, text(f, 'state')], [['Use Wi-Fi', 'Preferred: Wi-Fi', 'Back'], 'Not used', 'Not used'],
    'not used: no networks, no Scan');
// failed: the reason shown, no Scan
f = screen('wifi', {}, { uplink: Object.assign({}, fixture.state().uplink, { wifi: { enabled: true, link: 'failed', networks: [], saved: [],
    scanning: false, error: 'wpa_supplicant ended (exit status 1) (trying again in 30s)' } }) });
eq([text(f, 'state'), text(f, 'note'), f.values.scan.disabled], ['Failed', 'wpa_supplicant ended (exit status 1) (trying again in 30s)', true]);
// the uplink's state missing (it restarts): waiting, nothing to press but Back
f = screen('wifi', {}, { uplink: null });
eq([text(f, 'state'), f.values.networks.empty, own(f)], ['Waiting', 'Waiting', ['Back']]);
f = screen('wifi-failed');
eq([text(f, 'state'), text(f, 'note')], ['Error', 'could not join "FRITZ!Box 7590 XY" (wrong password, or out of range)']);
eq(f.items[0].act, { do: 'wifi-join', ssid: 'Mario iPhone' }, 'a saved network not joined: a tap joins it');
eq(text(screen('wifi', { uplinkNote: 'needs mgu-uplink 0.7.0 or newer, running' }), 'note'), 'needs mgu-uplink 0.7.0 or newer, running',
    'the updater\'s or uplink\'s refusal');
ok(own(screen('wifi', {}, { uplink: Object.assign({}, fixture.state().uplink, { wifi: Object.assign({}, fixture.state().uplink.wifi,
    { scanning: true }) }) })).indexOf('Scan') < 0, 'no Scan while it scans');
// the password: word keys and symbols, Connect only from 8 characters
f = screen('wifi-password');
eq([text(f, 'title'), text(f, 'field'), f.values.field.label], ['FRITZ!Box 7590 XY', '···', 'Password · at least 8 characters']);
ok(own(f).indexOf('Connect') >= 0 && own(f).indexOf('#+=') >= 0, 'word keys with the symbols page, Connect');
const pass = { name: 'type', title: 'FRITZ!Box 7590 XY', text: '', label: 'Password', layout: 'text', symbols: true, go: 'Connect', min: 8, max: 63 };
ok(!typeOn('iDrive 8', pass, ['s', 'e', 'c', 'r', 'e', 't', '1', 'Connect']), 'Connect does nothing under 8 characters');
ok(typeOn('iDrive 8', pass, ['#+=', '!', 'Connect']) && pass.text === 'secret1!', 'then gives the password');
// Forget asks first
f = screen('confirm-wifi-forget');
eq([f.labels, text(f, 'title'), text(f, 'text'), f.items[1].act], [['Cancel', 'Forget'], 'Forget network?', 'Home', { do: 'wifi-forget', ssid: 'Home' }]);
// the preferred connection: Automatic and the uplink's three groups; the preferred one marked, the others a tap away
f = screen('prefer');
eq(own(f), ['Automatic', 'USB', 'Phone', 'Back']);
eq([text(f, 'status'), f.values.list.items[1].right, f.values.list.items[1].sub], ['Online through Wi-Fi', 'chip:Preferred', 'In use']);
eq([f.items[0].act, f.items[2].act], [{ do: 'uplink-prefer', kind: '' }, { do: 'uplink-prefer', kind: 'phone' }]);
f = screen('prefer', {}, { uplink: Object.assign({}, fixture.state().uplink, { device: { kind: 'iphone', name: 'iPhone' }, preferred: 'usb' }) });
eq([text(f, 'status'), f.values.list.items[3].sub, f.values.list.items[2].right], ['Online through Phone', 'In use', 'chip:Preferred']);
// unavailable: the reason shown, no Scan
f = screen('wifi', {}, { uplink: Object.assign({}, fixture.state().uplink, { wifi: { enabled: true, link: 'unavailable', networks: [], saved: [],
    scanning: false, error: 'wlan1 is in access point mode' } }) });
eq([text(f, 'state'), text(f, 'note'), f.values.networks.empty, f.values.scan.disabled, text(f, 'subtitle')],
    ['Unavailable', 'wlan1 is in access point mode', 'Unavailable', true, '']);

// sign-in, phone, no updater
f = screen('login');
eq([text(f, 'code'), text(f, 'status'), f.values.qr.text], ['WDJB-MJHT', 'Waiting for sign-in', 'https://github.com/login/device']);
eq(own(f), ['Cancel', 'Back']);
f = screen('phone');
eq(own(f), ['Phone access', 'Back']);
ok(/#t=6f1c/.test(f.values.qr.text), 'the access URL as QR code');
eq(text(screen('offline'), 'subtitle'), 'Restart the head unit to finish setup');

// internet: the page says whether the car is online and how to connect it; offline, the Store points to it
f = screen('internet');
eq([own(f), text(f, 'status')], [['Back'], 'Connected']);
eq(f.values.ways.items.map((w) => [w.vicon, w.title]), [['wifi', 'Wi-Fi'], ['iphone', 'iPhone'], ['android', 'Android phone'], ['lteStick', 'USB LTE stick']], 'the ways to connect, a card each');
ok(/USB tethering/.test(f.values.ways.items[2].text) && /Personal Hotspot/.test(f.values.ways.items[1].text), 'how, on the phones');
eq(f.values.ways.items[0].text.length, 3, 'Wi-Fi: the hotspot, Scan, the network and its password, as steps');
eq(text(screen('internet-offline'), 'status'), 'Not connected');
eq(text(screen('store-no-internet'), 'subtitle'), 'No internet: Settings > Internet shows how to connect the car');
// every character on these screens is in the baked fonts (tools/bake_fonts.py TEXT); others draw as '?'
const BAKED = new Set(Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).concat(Array.from('·…→–—°×\n')));
['internet', 'store-no-internet'].forEach((name) => ['steps', 'subtitle'].forEach((k) => {
    const t = text(screen(name), k) || '';
    const missing = Array.from(t).filter((c) => !BAKED.has(c));
    eq(`${name} ${k}: ${missing.join('')}`, `${name} ${k}: `);
}));
f = screen('settings');
eq(f.items[f.labels.indexOf('Internet')].act, { do: 'open', page: { name: 'internet' } });

// package pictures: components[].icon is drawn from that file
f = screen('store', {}, { components: [Object.assign(fixture.state().components[1], { icon: '/run/mgu-updater/icons/doom.png' })] });
eq([f.values.grid.items[0].icon, f.icons], ['key:/run/mgu-updater/icons/doom.png', ['/run/mgu-updater/icons/doom.png']]);

console.log(`screens: ${fixture.screens().length} screens in ${Object.keys(UNITS).length} boxes, ${checks} checks pass`);

// iDrive 7 full screen: the HMI's status icons (the title strip's right end) stay visible - nothing drawn there
{
    const { play } = require(path.join(__dirname, '..', 'src', 'kit_record.js'));
    const { Canvas } = require(path.join(__dirname, '..', 'src', 'kit_canvas.js'));
    const full = UNITS['iDrive 7 full screen'];
    ['store', 'installed', 'settings'].forEach((tab) => {
        const fr = frame(fixture.model({ look: 'id7', tab }), { textScale: 1, focus: -1, scroll: {}, layout: full.layout });
        const cv = new Canvas(fr.rec.w, fr.rec.h);
        play(fr.rec.words(), cv);
        const alpha = (x, y) => cv.d[(y * cv.w + x) * 4 + 3];
        eq([alpha(1500, 30), alpha(1800, 60), alpha(300, 30)], [0, 0, 255], `full screen ${tab}: the status icons' corner see-through, the header drawn`);
        const px = (x, y) => Array.from(cv.d.slice((y * cv.w + x) * 4, (y * cv.w + x) * 4 + 4));
        eq([alpha(1500, 76), px(1500, 79)], [255, px(100, 79)],
            `full screen ${tab}: the HMI's strip edge under the status icons covered, the header's edge the whole width`);
    });
}

// iDrive 7 full screen: the header tabs take touch (the Store's claims: the strip up to the status icons, the page)
eq(UNITS['iDrive 7 full screen'].layout.claims, [{ x: 0, y: 80, w: 1836, h: 640 }, { x: 0, y: 0, w: 996, h: 80 }], 'full screen: touch claimed for the header tabs too');
