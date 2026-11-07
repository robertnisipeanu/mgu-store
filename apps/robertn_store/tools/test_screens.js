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
eq(f.labels.slice(0, 8), ['Store', 'Installed', 'USB', 'Settings', 'Restart now', 'All', 'Apps', 'Tools']);
eq(f.labels.length, 8 + fixture.state().components.length - 1, 'a tile per component but the one for another head unit only');
ok(f.labels.indexOf('Car Data') < 0, 'Car Data (iDrive 8 only, not installed) is not listed');
eq(f.items[8].act, { do: 'open', page: { name: 'app', id: 'robertn_store', source: 'mgu-store', listed: 'robertn_store' } });
const subs = f.values.grid.items.map((t) => t.sub);
['Downloading 42 %', 'Update a1b2c3d', 'Waiting', 'Restart pending', 'Failed', 'Installed', '2.1.0 · 402 KB']
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
const T = 8;                    // the first tile: after the side menu, Restart now and the filters
const scroll = {};
f = frame(fixture.model({}, many), { textScale: 1, focus: T + 40, scroll, layout: ID7.layout });
ok(scroll['store.grid'] > 0 && !f.items[T + 40].reveal, 'the focused tile scrolled into view');
eq(hit(f.items, f.items[T + 40].x + 5, f.items[T + 40].y + 5), T + 40);
ok(f.items[T].reveal, 'the first tiles out of view now');
eq(hit(f.items, f.items[T].x + 5, f.items[T].y + 5), -1, 'and not hit');

// a drag scrolls by the pixel: a grid stops part way through a row, both part-shown rows draw and take a tap
const half = { 'store.grid': 0.5 };
f = frame(fixture.model({}, many), { textScale: 1, focus: -1, scroll: half, layout: ID7.layout });
const g = f.regions.find((r) => r.key === 'store.grid');
eq(f.items[T].y, g.y - g.step / 2, 'the first row half scrolled out');
eq(hit(f.items, f.items[T].x + 5, g.y + 5), T, 'its shown half takes a tap');
eq(hit(f.items, f.items[T].x + 5, f.items[T].y + 5), -1, 'its hidden half does not');
const low = f.items.findIndex((it) => it.y < g.y + g.h && it.y + it.h > g.y + g.h);
ok(low > T && f.items[low].reveal && hit(f.items, f.items[low].x + 5, g.y + g.h - 2) === low, 'the part-shown last row takes a tap');
ok(g.max % 1 !== 0, 'the grid scrolls to its last row flush with the bottom');

// a component's page: its install, update, or nothing; Remove
f = screen('app-update');
eq(own(f), ['Update to a1b2c3d', 'Remove', 'Back'], 'a page: its buttons, Back, the side menu');
eq(text(f, 'author'), 'by robertn · from cauliflower/idrive7-apps');
eq(f.items[1].act, { do: 'open', page: { name: 'confirm', kind: 'remove', id: 'gauges' } });
ok(/^Speed, revs/.test(text(f, 'desc')), 'the description');
eq(f.values.facts.items.map((c) => c.text), ['Version 1.2.0', 'Commit a1b2c3d', 'App', 'iDrive 7 and iDrive 8']);
// Undo update: on the page of a component the updater offers it for, then its confirm step
f = screen('tool-undo');
eq(own(f), ['Undo update', 'Remove', 'Back'], 'Undo update beside Remove');
eq(f.items[0].act, { do: 'open', page: { name: 'confirm', kind: 'undo', id: 'mgu-uplink' } });
f = screen('confirm-undo');
eq([text(f, 'title'), f.labels], ['Back to Network driver 0.3.2?', ['Cancel', 'Undo update']], 'its dialog');
eq(f.items[1].act, { do: 'undo', id: 'mgu-uplink' });
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
// two sources' Doom: two tiles, each named with its source's author; a page follows its row when the install gives it another id
two.sources = [{ id: 'idrive7-apps', label: 'cauliflowermossgrape/idrive7-apps' }, { id: 'iterio', label: 'https://apps.example.org/index.json' }];
eq(frame(fixture.model({}, two), { textScale: 1, focus: 0, scroll: {} }).values.grid.items.map((t) => [t.title, t.src]),
    [['DOOM', 'cauliflowermossgrape'], ['DOOM', 'apps.example.org']]);
// two sources of the same repo name: each one's author
two.sources = [{ id: 'idrive7-apps', label: 'one/apps' }, { id: 'iterio', label: 'two/apps' }];
eq(frame(fixture.model({}, two), { textScale: 1, focus: 0, scroll: {} }).values.grid.items.map((t) => t.src), ['one', 'two']);
// one author's two repos' DOOM: owner/repo on those tiles and rows, the author alone on the rest; on a page, from owner/repo
const same = Object.assign({}, two, { sources: [{ id: 'idrive7-apps', label: 'robertnisipeanu/mgu-store' }, { id: 'iterio', label: 'robertnisipeanu/idrive-apps' }],
    components: two.components.map((c) => Object.assign({}, c, { blocked: null, installed: '1.0.0', status: 'installed' }))
        .concat([Object.assign({}, two.components[0], { id: 'quake', title: 'Quake', listedId: null, installAs: null, installed: '1.0.0', status: 'installed' })]) });
eq(frame(fixture.model({}, same), { textScale: 1, focus: 0, scroll: {} }).values.grid.items.map((t) => t.src),
    ['robertnisipeanu/mgu-store', 'robertnisipeanu/idrive-apps', 'robertnisipeanu']);
eq(frame(fixture.model({ tab: 'installed' }, same), { textScale: 1, focus: 0, scroll: {} }).values.apps.items.map((t) => t.sub),
    ['1.0.0 · robertnisipeanu/mgu-store', '1.0.0 · robertnisipeanu/idrive-apps', '1.0.0 · robertnisipeanu']);
eq(text(frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'quake' }] }, same), { textScale: 1, focus: 0, scroll: {} }), 'author'),
    'from robertnisipeanu/mgu-store');
// the fixture's tiles, rows and USB tiles: the author, a stick's label
f = screen('store');
eq(f.values.grid.items.slice(0, 2).map((t) => t.src), ['robertnisipeanu', 'cauliflower'], 'tiles: the author');
eq(screen('usb').values.grid.items.map((t) => t.src), ['USB STICK', 'USB STICK'], 'USB: the stick');
// the status line names the source of a row whose title another row has: downloading, and a failure
const sub = (st) => text(frame(fixture.model({}, st), { textScale: 1, focus: 0, scroll: {} }), 'subtitle');
two.sources = [{ id: 'idrive7-apps', label: 'cauliflowermossgrape/idrive7-apps' }, { id: 'iterio', label: 'someone/other-apps' }];
const dooms = (o) => Object.assign({}, two, { components: [Object.assign({}, two.components[0], o), Object.assign({}, two.components[1], { blocked: null })] });
eq(sub(Object.assign(dooms({}), { busy: { id: 'doom2', op: 'install', phase: 'download', progress: 42, total: 100 } })),
    'Downloading 42 % · DOOM (cauliflowermossgrape)');
eq(sub(dooms({ error: 'the build failed (exit 3)' })), 'DOOM (cauliflowermossgrape): the build failed (exit 3)');
// Remove? names which of two installed DOOMs; with one DOOM, its title alone
const confirmOf = (st) => text(frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom2' }, { name: 'confirm', kind: 'remove', id: 'doom2' }] }, st),
    { textScale: 1, focus: 0, scroll: {} }), 'title');
const both = dooms({ installed: '1.0.0', status: 'installed' });
both.components[1] = Object.assign({}, both.components[1], { installed: '1.0.1', status: 'installed' });
eq(confirmOf(both), 'Remove DOOM (cauliflowermossgrape) 1.0.0?');
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
eq([f.items.map((i) => i.label).slice(0, -4), text(f, 'note1')], [['Restart head unit', 'Back'], 'Restart pending'], 'first install');
eq(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }).items.map((i) => i.label).slice(0, -4),
    ['Restart head unit', 'Remove', 'Back'], 'update of an installed app');
f = laterOf({});
eq([f.values.grid.items.map((t) => [t.id, t.sub, t.badge]), f.values.nav.items[1].badge],
    [[['car_vitals', 'Restart pending', ''], ['doom', 'Restart pending', 'installed']], ''], 'tiles; not counted as an update');
f = laterOf({ tab: 'installed' });
eq([f.values.apps.items.map((i) => [i.id, i.right, i.chipAct]), f.values.updateAll.hidden], [[['doom', 'chip:Restart pending', null]], true]);
// installed, and the deploy tool says it does not work until it is set up again: Not working, why on its page
const notWorking = Object.assign(fixture.state(), { busy: null });
notWorking.components = [Object.assign({}, notWorking.components[1], { status: 'installed', installed: '1.0.1', repair: 'installed under firmware old',
    problem: 'Not working: installed under firmware old' })];
f = frame(fixture.model({}, notWorking), { textScale: 1, focus: 0, scroll: {} });
eq(f.values.grid.items.map((t) => [t.id, t.sub, t.badge]), [['doom', 'Not working', 'installed']], 'a component that does not work');
f = frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }, notWorking), { textScale: 1, focus: 0, scroll: {} });
eq(text(f, 'problem'), 'Not working: installed under firmware old', 'why it does not work, on its page');
// a tool whose install step waits after a firmware update: Needs setup, and Set up on its page, which asks the updater
const setup = Object.assign(fixture.state(), { busy: null });
setup.components = [Object.assign({}, setup.components[1], { kind: 'tool', status: 'installed', installed: '1.0.1', needsSetup: 'installed under firmware old' })];
f = frame(fixture.model({}, setup), { textScale: 1, focus: 0, scroll: {} });
eq(f.values.grid.items.map((t) => [t.id, t.sub, t.badge]), [['doom', 'Needs setup', 'installed']], 'a tool that needs setup');
f = frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }, setup), { textScale: 1, focus: 0, scroll: {} });
eq([f.items[0].label, JSON.stringify(f.items[0].act)], ['Set up', JSON.stringify({ do: 'setup', id: 'doom' })], 'Set up on its page');
setup.components[0].pendingReboot = true;
f = frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }, setup), { textScale: 1, focus: 0, scroll: {} });
eq([text(f, 'note1'), f.items[0].label], ['Needs setup', 'Set up'], 'its page says Needs setup, also with a restart pending');
setup.components[0].error = 'setup failed: activate exited 3';
f = frame(fixture.model({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }, setup), { textScale: 1, focus: 0, scroll: {} });
eq([f.items[0].label, JSON.stringify(f.items[0].act)], ['Try again', JSON.stringify({ do: 'setup', id: 'doom' })], 'a failed Set up: Try again sets it up again');
// with the updater's nextStart: a queued first install has Remove (drops it), a queued removal none; a failed apply shows why
later.components = [Object.assign({}, later.components[0], { nextStart: 'install' }),
    Object.assign({}, later.components[1], { status: 'installed', installed: '1.0.1', nextStart: 'remove' })];
eq(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'car_vitals' }] }).items.map((i) => i.label).slice(0, -4),
    ['Restart head unit', 'Remove', 'Back'], 'a queued first install can be removed');
eq(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] }).items.map((i) => i.label).slice(0, -4),
    ['Restart head unit', 'Back'], 'a queued removal: not offered again');
eq(text(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'car_vitals' }, { name: 'confirm', kind: 'remove', id: 'car_vitals' }] }), 'title'),
    'Remove M Vitals?');
later.components = [Object.assign({}, later.components[0], { pendingReboot: false, nextStart: null,
    error: 'the install at the start of the head unit failed: package checksum mismatch at /x' })];
f = laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'car_vitals' }] });
eq([f.items.map((i) => i.label).slice(0, -4), f.values.desc.lead],
    [['Try again', 'Back'], 'Failed: the install at the start of the head unit failed: package checksum mismatch at /x']);
// with the updater's applyFailed: a failed first install also has Remove (clears it); a failed removal's Try again removes
later.components[0].applyFailed = 'install';
eq(laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'car_vitals' }] }).items.map((i) => i.label).slice(0, -4),
    ['Try again', 'Remove', 'Back'], 'a failed first install can be cleared');
later.components = [Object.assign({}, fixture.state().components[1], { status: 'installed', installed: '1.0.1', applyFailed: 'remove',
    error: 'the removal at the start of the head unit failed: x' })];
f = laterOf({ stack: [{ name: 'main' }, { name: 'app', id: 'doom' }] });
eq([f.items.map((i) => i.label).slice(0, -4), f.items[0].act], [['Try again', 'Back'], { do: 'open', page: { name: 'confirm', kind: 'remove', id: 'doom' } }],
    'a failed removal is tried again');

// an error of about 200 characters is drawn in full, in either unit's box: on a component's page above its description,
// on a source's page
const { Recorder } = require(path.join(__dirname, '..', 'src', 'kit_record.js'));
const LONG = fixture.LONG_ERROR;
Object.keys(UNITS).forEach((unit) => {
    const p = UNITS[unit];
    const shown = (name) => {
        const s = fixture.screens().find((x) => x[0] === name);
        const m = fixture.model(s[1], Object.assign(fixture.state(), s[2] || {}));
        const texts = [];
        const draw = Recorder.prototype.text;
        Recorder.prototype.text = function (str) { texts.push(str); return draw.apply(this, arguments); };
        try {
            return Object.assign(frame(m, { textScale: p.scale, focus: -1, scroll: {}, layout: p.layout }), { texts: texts.join(' ') });
        } finally {
            Recorder.prototype.text = draw;
        }
    };
    let e = shown('app-failed');
    ok(e.texts.indexOf(`Failed: ${LONG}`) >= 0, `${unit}: the page's failure in full (${e.texts})`);
    eq([text(e, 'note1'), e.items[0].label], ['', 'Try again'], `${unit}: not cut into the panel's notes`);
    e = shown('source-failed');
    ok(e.texts.indexOf(LONG) >= 0, `${unit}: the source's error in full (${e.texts})`);
});

// confirm steps: Cancel first
f = screen('confirm-remove');
eq(f.labels, ['Cancel', 'Remove']);
eq(text(f, 'title'), 'Remove Gauges 1.2.0?');
// an app with tools only it requires: they are listed, and Remove all takes the installed ones along
f = screen('confirm-remove-tools');
eq(f.labels, ['Cancel', 'Remove', 'Remove all']);
eq(text(f, 'text'), 'Tools only it uses: Display bridge 0.2.3, GPU renderer 1.1.0, Network driver 0.4.0');
eq([f.items[1].act, f.items[2].act], [{ do: 'remove', id: 'gauges' }, { do: 'remove', id: 'gauges', tools: ['display-bridge', 'mgu-renderd', 'mgu-uplink'] }]);
[['iDrive 7', ID7.layout], ['iDrive 8', SCREENS]].forEach(([unit, lay]) => {
    const cs = lay.screens.find((x) => x.name === 'confirm').components;
    const line = cs.find((c) => c.name === 'text');
    const also = cs.find((c) => c.name === 'also');
    ok(line.opts.wrap && line.h >= 2 * line.opts.size * 1.25 && also.y >= line.y + line.h, `${unit}: the confirm step's line wraps over two lines above Remove all`);
});
eq(screen('confirm-restart').items[1].act, { do: 'restart' });
f = screen('confirm-account');
eq(f.items[1].act, { do: 'account-remove', id: '3f9a01c2' });
eq(text(f, 'text'), 'robertn · robertnisipeanu/mgu-store');

// Installed: Update all for what can update now; a row's chip updates it
f = screen('installed');
eq(f.labels[4], 'Update all (1)', 'DOOM downloads and Extended dashboard waits: one update left');
eq(f.items.find((i) => i.label === 'Update').act, { do: 'install', id: 'gauges' });
ok(f.labels.indexOf('Display bridge') >= 0 && f.labels.indexOf('M Vitals') < 0, 'installed ones only');
eq(f.values.apps.items.filter((i) => i.id === 'gauges' || i.id === 'robertn_store').map((i) => i.sub),
    ['1.2.0 → a1b2c3d · cauliflower', '0.7.0 · robertnisipeanu'], 'a row names its source\'s author');
// Installed: what runs or waits first (downloading, an update, queued, failed, restart pending), each part in the catalog's order
const ids = (g) => [g.values.apps.items.map((i) => i.id), g.values.services.items.map((i) => i.id)];
eq(ids(f), [['doom', 'gauges', 'extended_dashboard', 'vehicle_control', 'robertn_store'],
    ['display-bridge', 'mgu-updater', 'mgu-uplink', 'mgu-renderd']], 'what runs or waits first');
const sorted = (fn, busy) => {
    const s = fixture.state();
    s.busy = busy === undefined ? s.busy : busy;
    s.components = s.components.map((c) => Object.assign({}, c, fn(c) || {}));
    return ids(frame(fixture.model({ tab: 'installed' }, s), { textScale: 1, focus: -1, scroll: {} }));
};
eq(sorted((c) => (c.id === 'doom' ? { status: 'installed', installed: '1.0.1' } : c.id === 'display-bridge' ? { pendingReboot: false } : null), null),
    [['gauges', 'extended_dashboard', 'vehicle_control', 'robertn_store', 'doom'], ['mgu-updater', 'mgu-uplink', 'mgu-renderd', 'display-bridge']],
    'a finished update and a restart done: back in the catalog\'s order');
eq(sorted((c) => (c.id === 'mgu-renderd' ? { status: 'update', version: '1.2.0' } : c.id === 'mgu-uplink' ? { queued: true } : null)),
    [['doom', 'gauges', 'extended_dashboard', 'vehicle_control', 'robertn_store'], ['mgu-uplink', 'mgu-renderd', 'display-bridge', 'mgu-updater']],
    'tools: queued, an update and a restart pending first, in the catalog\'s order');
eq(sorted((c) => (c.id === 'mgu-updater' ? { nextStart: 'remove', pendingReboot: true } : c.id === 'mgu-renderd' ? { applyFailed: 'remove', error: 'x' }
    : null), { id: 'mgu-uplink', op: 'uninstall', phase: 'uninstall' })[1],
    ['mgu-updater', 'mgu-uplink', 'mgu-renderd', 'display-bridge'], 'a removal queued, running or failed first');
eq(sorted((c) => (c.id === 'mgu-renderd' ? { status: 'update', compat: 'no', pendingReboot: true } : c.id === 'mgu-uplink' ? { blocked: 'x', error: 'y' }
    : c.id === 'display-bridge' ? { pendingReboot: false } : null))[1],
    ['mgu-updater', 'mgu-uplink', 'mgu-renderd', 'display-bridge'], 'one shown as not for this unit or blocked: nothing to wait on');

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
    eq(row0.slice(0, 3).map((t) => t.str), ['Store', 'robertnisipeanu', 'Installed'], `${unit}: title, source, state`);
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
eq(f.labels.slice(4), ['robertnisipeanu/mgu-store', 'cauliflower/idrive7-apps', 'IterioDev/car-apps', 'USB STICK', 'Add source',
    'Wi-Fi', 'Accounts', 'Proxy', 'Phone access', 'Check now']);
eq(text(f, 'unit'), 'iDrive 7 · BMW MGU P18_23w44.2-1-3 mgu-high');
eq(text(f, 'versions'), 'Updater 0.4.0 · Store 0.7.0 · Renderer mgu-renderd 1.1.0');
eq(text(screen('settings', {}, { allProviders: { renderer: [{ id: 'mgu-render', version: '0.2.0' }, { id: 'mgu-renderd', version: '1.1.2' }] } }),
    'versions'), 'Updater 0.4.0 · Store 0.7.0 · Renderer mgu-render 0.2.0, mgu-renderd 1.1.2', 'every installed renderer');
const idle = { busy: null, components: fixture.state().components.map((c) => Object.assign({}, c, { queued: false })) };
ok(screen('settings', {}, idle).labels.indexOf('Restart head unit') >= 0, 'Restart head unit with nothing installing');
const refused = Object.assign({}, idle, { rebootError: 'too soon after start-up, possible in 3 min' });
eq(text(screen('settings', {}, refused), 'note'), 'Restart failed: too soon after start-up, possible in 3 min', 'a refused restart beside Restart head unit');

// Restart now on Store and Installed: while a restart is pending and Restart head unit is offered, it opens that one's
// confirm step; on Installed it sits right of Update all, as wide and as high
const restartAct = { do: 'open', page: { name: 'confirm', kind: 'restart' } };
const shown = (g) => !g.values.restartNow.hidden;
f = screen('store-restart');
eq(f.labels.slice(4, 8), ['Restart now', 'All', 'Apps', 'Tools'], 'Store: Restart now before the filters and the tiles');
eq([f.items[4].act, screen('settings', {}, idle).items.find((it) => it.label === 'Restart head unit').act], [restartAct, restartAct],
    'Restart now opens the confirm step Restart head unit opens');
f = screen('installed-restart');
eq(f.labels.slice(4, 6), ['Update all (3)', 'Restart now'], 'Installed: Restart now after Update all, before the rows');
eq(f.items[5].act, restartAct);
eq(f.values.services.items.map((i) => i.right).filter((r) => /^chip:/.test(r)), ['chip:Restart pending', 'chip:Not working'],
    'Installed: a row restarting and one not working');
eq([shown(screen('installed')), shown(screen('store'))], [true, true], 'kept while an install runs');
const confirmRestart = (st) => frame(fixture.model({ stack: [{ name: 'main' }, { name: 'confirm', kind: 'restart' }] }, st),
    { textScale: 1, focus: 0, scroll: {} }).values.now.disabled;
eq([confirmRestart(idle), confirmRestart({})], [false, true], 'its confirm step\'s Restart: off while an install runs');
const restarted = Object.assign({}, idle, { components: idle.components.map((c) => Object.assign({}, c, { pendingReboot: false })) });
eq([shown(screen('store-restart', {}, restarted)), shown(screen('installed-restart', {}, restarted))], [false, false],
    'hidden with no restart pending');
eq(shown(screen('installed-restart', {}, { rebooting: true })), false, 'hidden while the unit restarts');
eq(shown(screen('installed-restart', {}, { rebooting: undefined })), false, 'hidden with an updater that cannot restart');
const otherUnit = Object.assign({}, restarted, { components: restarted.components.concat([Object.assign({}, idle.components[0],
    { id: 'gone', compat: 'no', installed: null, status: 'available', pendingReboot: true })]) });
eq(shown(screen('store-restart', {}, otherUnit)), false, 'a row the Store does not list counts for nothing');
// Installed's held rows keep Restart now as drawn
eq([shown(screen('installed-restart', { held: { apps: [], services: [], restart: false } })),
    shown(screen('installed-restart', { held: { apps: [], services: [], restart: true } }, restarted)),
    shown(screen('installed', { held: { apps: [], services: [], restart: true } }, { rebooting: true }))], [false, true, false],
'Installed\'s held rows: Restart now as drawn, while the unit is not restarting');
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
Object.keys(UNITS).forEach((unit) => {
    const p = UNITS[unit];
    const at = (name, stOver) => {
        const s = fixture.screens().find((x) => x[0] === name);
        const m = fixture.model(s[1], Object.assign(fixture.state(), s[2], stOver || {}));
        return frame(m, { textScale: p.scale, focus: -1, scroll: {}, layout: p.layout });
    };
    const item = (g, label) => g.items.find((it) => it.label === label);
    const both = at('installed-restart');
    const [all, now] = [item(both, 'Update all (3)'), item(both, 'Restart now')];
    eq([now.w, now.h, now.y], [all.w, all.h, all.y], `${unit} Installed: Restart now as wide, high and placed as Update all`);
    ok(all.x + all.w < now.x, `${unit} Installed: Update all, then Restart now, side by side`);
    eq(item(at('installed-restart', { components: idle.components.map((c) => Object.assign({}, c, { status: 'installed' })) }), 'Restart now').x,
        now.x, `${unit} Installed: Restart now alone where it is beside Update all`);
    eq(item(at('installed-restart', restarted), 'Update all (3)').x + all.w, now.x + now.w,
        `${unit} Installed: Update all alone at the right edge`);
    const st = at('store-restart');
    const filters = item(st, 'All');
    ok(item(st, 'Restart now').x + item(st, 'Restart now').w < filters.x, `${unit} Store: Restart now left of the filters`);
    [[both, 'Installed'], [st, 'Store']].forEach(([g, name]) => {
        const it = item(g, 'Restart now');
        eq(g.items.filter((o) => o !== it && !o.box && overlap(it, o)).map((o) => o.label), [], `${unit} ${name}: Restart now overlaps no other button`);
    });
});

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
// wireless CarPlay or Android Auto keeps the uplink from searching: said while not joined
eq([{ link: 'idle', ssid: '', paused: 'carplay' }, { link: 'scanning', ssid: '', paused: 'android-auto' },
    { link: 'online', paused: 'carplay' }, { enabled: false, link: 'off', ssid: '', paused: 'carplay' }, { link: 'idle', ssid: '', paused: 'other' }].map(wifiSub),
['Paused for wireless CarPlay', 'Paused for wireless Android Auto', 'Online · Mario iPhone', 'Not used', 'Not connected']);
eq(screen('settings-wifi-paused').values.access.items[0].sub, 'Paused for wireless CarPlay');
// the band of the access point joined (mgu-uplink 0.7.5's wifi.freq), only while joined and known
eq([{ freq: 5745 }, { link: 'connected', freq: 2437 }, { freq: 2484 }, { freq: 5180 }, { freq: 5825 }].map(wifiSub),
    ['Online · Mario iPhone · 5 GHz', 'Connected · Mario iPhone · 2.4 GHz', 'Online · Mario iPhone · 2.4 GHz', 'Online · Mario iPhone · 5 GHz',
        'Online · Mario iPhone · 5 GHz']);
eq([{}, { freq: undefined }, { freq: 0 }, { freq: null }, { freq: '5745' }, { freq: 60480 }, { freq: -1 }, { freq: NaN }].map(wifiSub),
    ['Online · Mario iPhone', 'Online · Mario iPhone', 'Online · Mario iPhone', 'Online · Mario iPhone', 'Online · Mario iPhone',
        'Online · Mario iPhone', 'Online · Mario iPhone', 'Online · Mario iPhone'], 'no band without a frequency it knows (an older uplink, a read that failed)');
eq([{ link: 'connecting', ssid: 'Cafe', freq: 5745 }, { link: 'idle', ssid: '', freq: 5745 }, { enabled: false, link: 'off', ssid: '', freq: 5745 },
    { link: 'unavailable', ssid: '', error: 'no Wi-Fi radio (wlan1)', freq: 2437 }, { link: 'idle', ssid: '', paused: 'carplay', freq: 2437 }].map(wifiSub),
['Connecting · Cafe', 'Not connected', 'Not used', 'Unavailable', 'Paused for wireless CarPlay'], 'nor while not joined');
eq(screen('settings', {}, { uplink: { device: { kind: 'usbecm', name: 'HUAWEI' }, state: 'online', error: null, preferred: 'usb', wifi: null } })
    .labels.indexOf('Wi-Fi'), -1, 'a USB uplink without Wi-Fi: no row');
eq(screen('settings', {}, { uplink: Object.assign({}, fixture.state().uplink, { device: { kind: 'usbecm', name: 'HUAWEI' },
    wifi: Object.assign({}, fixture.state().uplink.wifi, { link: 'connected', freq: 5745 }) }) }).values.access.items[0].sub,
'Connected · Mario iPhone · 5 GHz', 'joined while a USB stick is the uplink');
eq(screen('settings-wifi-band').values.access.items[0].sub, 'Online · Mario iPhone · 5 GHz');
eq(screen('wifi-band').values.networks.items.map((n) => n.sub).slice(0, 2), ['Online · Strong · 2.4 GHz', 'Secured · Strong'],
    'the page: on the joined network\'s row');
eq(screen('wifi').values.networks.items[0].sub, 'Online · Strong', 'the page without a frequency: as before');
f = screen('wifi-paused');
eq([text(f, 'subtitle'), text(f, 'state'), own(f).indexOf('Scan') >= 0], ['Paused for wireless Android Auto', 'Not connected', true],
    'paused: the page says so; Scan stays');
// the page: the network joined first, then the scan's, then saved ones out of range; a tap joins a saved or open one and asks a
// secured one's password; a saved one has Forget; Don't use Wi-Fi, Scan, the preferred connection
f = screen('wifi');
eq(own(f), ['Allow 5 GHz', 'Forget', 'FRITZ!Box 7590 XY', 'Cafe Free WiFi', 'Telekom_FON', 'Forget', "Don't use Wi-Fi", 'Scan', 'Preferred: Wi-Fi', 'Back']);
eq(f.values.networks.items.map((n) => n.sub), ['Online · Strong', 'Secured · Strong', 'Open · Good', 'Open · Weak', 'Saved · not in range']);
eq([text(f, 'subtitle'), text(f, 'state'), text(f, 'info')], ['5 networks', 'Online · Mario iPhone', 'IP 172.20.10.3 · -52 dBm']);
eq([f.items[0].act, f.values.allow5.items[0].right], [{ do: 'wifi-5ghz' }, 'toggle:off'], 'Allow 5 GHz: a switch, off');
eq(f.items.slice(1, 6).map((i) => i.act), [{ do: 'open', page: { name: 'confirm', kind: 'wifi-forget', ssid: 'Mario iPhone' } },
    { do: 'wifi-password', ssid: 'FRITZ!Box 7590 XY' }, { do: 'wifi-join', ssid: 'Cafe Free WiFi' }, { do: 'wifi-join', ssid: 'Telekom_FON' },
    { do: 'open', page: { name: 'confirm', kind: 'wifi-forget', ssid: 'Home' } }]);
eq(f.items.slice(6, 9).map((i) => i.act), [{ do: 'wifi-power' }, { do: 'wifi-scan' }, { do: 'open', page: { name: 'prefer' } }]);
eq(screen('wifi', {}, { uplink: Object.assign({}, fixture.state().uplink, { wifi: Object.assign({}, fixture.state().uplink.wifi,
    { allow5ghz: true }) }) }).values.allow5.items[0].right, 'toggle:on');
eq(screen('wifi', {}, { uplink: Object.assign({}, fixture.state().uplink, { wifi: Object.assign({}, fixture.state().uplink.wifi,
    { allow5ghz: undefined }) }) }).values.allow5.items, [], 'no Allow 5 GHz with an uplink without it (before 0.7.6)');
// joined on 5 GHz to a network without 2.4 GHz: what to do, an iPhone's hotspot by its setting
eq(text(screen('wifi-5ghz-only'), 'note'), 'On the iPhone, turn on Maximize Compatibility');
eq(text(screen('wifi-5ghz-only-ap'), 'note'), 'This network is 5 GHz only: CarPlay audio may drop');
eq(text(screen('wifi'), 'note'), '');
f = screen('wifi-off');
eq([own(f), f.values.networks.empty, text(f, 'state')], [['Use Wi-Fi', 'Preferred: Wi-Fi', 'Back'], 'Not used', 'Not used'],
    'not used: no networks, no Scan, no Allow 5 GHz');
// failed: the reason shown, no Scan
f = screen('wifi', {}, { uplink: Object.assign({}, fixture.state().uplink, { wifi: { enabled: true, link: 'failed', networks: [], saved: [],
    scanning: false, error: 'wpa_supplicant ended (exit status 1) (trying again in 30s)' } }) });
eq([text(f, 'state'), text(f, 'note'), f.values.scan.disabled], ['Failed', 'wpa_supplicant ended (exit status 1) (trying again in 30s)', true]);
// the uplink's state missing (it restarts): waiting, nothing to press but Back
f = screen('wifi', {}, { uplink: null });
eq([text(f, 'state'), f.values.networks.empty, own(f)], ['Waiting', 'Waiting', ['Back']]);
f = screen('wifi-failed');
eq([text(f, 'state'), text(f, 'note')], ['Error', 'could not join "FRITZ!Box 7590 XY" (wrong password, or out of range)']);
eq(f.items[1].act, { do: 'wifi-join', ssid: 'Mario iPhone' }, 'a saved network not joined: a tap joins it');
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
eq(own(f), ['Automatic', 'USB', 'Phone', 'Phone over USB', 'Back']);
eq([text(f, 'status'), f.values.list.items[1].right, f.values.list.items[1].sub], ['Online through Wi-Fi', 'chip:Preferred', 'In use']);
eq([f.items[0].act, f.items[2].act], [{ do: 'uplink-prefer', kind: '' }, { do: 'uplink-prefer', kind: 'phone' }]);
f = screen('prefer', {}, { uplink: Object.assign({}, fixture.state().uplink, { device: { kind: 'iphone', name: 'iPhone' }, preferred: 'usb' }) });
eq([text(f, 'status'), f.values.list.items[3].sub, f.values.list.items[2].right], ['Online through Phone', 'In use', 'chip:Preferred']);
// Phone over USB: a switch below the groups, with an uplink and updater that report it (mgu-uplink 0.7.7, mgu-updater 0.8.32)
f = screen('prefer');
eq([f.values.usbPhone.items.map((i) => [i.title, i.right]), f.items[3].act], [[['Phone over USB', 'toggle:on']], { do: 'usb-phone' }]);
eq(screen('prefer', {}, { uplink: Object.assign({}, fixture.state().uplink, { usbPhone: false }) }).values.usbPhone.items[0].right, 'toggle:off');
eq(screen('prefer', {}, { uplink: Object.assign({}, fixture.state().uplink, { usbPhone: undefined }) }).values.usbPhone.items, [],
    'no Phone over USB with an uplink or updater without it');
eq(screen('prefer', {}, { uplink: null }).values.usbPhone.items, [], 'no Phone over USB while the uplink does not run');
// unavailable: the reason shown, no Scan
f = screen('wifi', {}, { uplink: Object.assign({}, fixture.state().uplink, { wifi: { enabled: true, link: 'unavailable', networks: [], saved: [],
    scanning: false, error: 'wlan1 is in access point mode' } }) });
eq([text(f, 'state'), text(f, 'note'), f.values.networks.empty, f.values.scan.disabled, text(f, 'subtitle')],
    ['Unavailable', 'wlan1 is in access point mode', 'Unavailable', true, '']);

// the proxy (an updater from 0.8.27): a row in Settings' access card; its page turns it on or off and sets its address
f = screen('settings');
eq(f.values.access.items.map((i) => [i.title, i.sub]), [['Wi-Fi', 'Online · Mario iPhone'], ['Accounts', '2 accounts'], ['Proxy', 'Off'],
    ['Phone access', 'Off']]);
eq(f.items.find((i) => i.label === 'Proxy').act, { do: 'open', page: { name: 'proxy' } });
ok(screen('settings', {}, { proxy: undefined }).labels.indexOf('Proxy') < 0, 'no Proxy row with an updater before 0.8.27');
eq(screen('settings-proxy-on').values.access.items[2].sub, '192.168.8.1:7891');
eq([screen('proxy-error').values.access, screen('settings', {}, { proxy: { on: true, kind: 'http', address: '10.0.0.1:3128', error: 'x' } })
    .values.access.items[2].sub], [undefined, 'Error']);
f = screen('proxy');
eq([own(f), f.values.rows.items.map((i) => [i.title, i.sub, i.right]), text(f, 'error')],
    [['Proxy', 'Address', 'Back'], [['Proxy', '', 'toggle:off'], ['Address', 'None', 'chevron']], '']);
eq(f.items.slice(0, 2).map((i) => i.act), [{ do: 'proxy-toggle' }, { do: 'proxy-edit' }]);
f = screen('proxy-on');
eq(f.values.rows.items.map((i) => [i.sub, i.right]), [['', 'toggle:on'], ['socks5://192.168.8.1:7891', 'chevron']]);
eq(text(screen('proxy-error'), 'error'), 'proxy 192.168.8.1:7890: connection refused (5 tries)');
eq(text(screen('proxy-on', { proxyNote: 'cannot save the proxy: EROFS' }), 'error'), 'cannot save the proxy: EROFS', 'a refused change');
f = screen('type-proxy');
eq([text(f, 'title'), text(f, 'field')], ['Proxy', 'socks5://192.168.8.1:7891']);

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
