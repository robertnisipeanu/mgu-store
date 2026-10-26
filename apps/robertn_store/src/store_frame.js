'use strict';
/**
 * One frame of the Store's renderer screens: the page on top's screen
 * (src/am_screens.js) with its values (src/store_ui.js), drawn by am_gpu.js
 * in design pixels, and what on it can be pressed, in focus order, with
 * where it is: the controller's proxies (src/store_drawn.js), touch and the
 * focus ring use the same list. No I/O (tools/test_screens.js).
 *
 *   frame(model, { textScale, focus, scroll, layout }) -> { screen, rec, items, regions, icons }
 *
 * layout: placement()'s; the iDrive 8 design when null.
 *
 * items: { x, y, w, h, r, label, act, reveal? }; an item scrolled out of view
 * carries reveal { key, top }: the scroll that shows it. regions: the
 * scrolling grids and lists, { key, x, y, w, h, step, max }. scroll ({ key:
 * first row }) is kept by the caller and follows the focus.
 */
const SCREENS = require('./am_screens.js');
const { record } = require('./am_gpu.js');
const { Recorder } = require('./kit_record.js');
const { view, icons } = require('./store_ui.js');
const { tabCells } = require('./am_widgets.js');
const { gridView, listView, navItems, rightBoxes } = require('./am_store_widgets.js');
const { compact } = require('./store_compact.js');

/* The part of the design the renderer's box shows: the screens' content
 * (the side menu at x 126 to the right edge, the title at y 114 to the
 * bottom at 840), with a margin. */
const VIEWPORT = { x: 106, y: 100, w: 2754, h: 756 };
const COMPACT_H = 700;                    // a box lower than this gets src/store_compact.js's layout
const FOCUS = '#ffffff';
const SIZES = ['rowH', 'tileH', 'size'];  // a layout's own sizes: kept over the values' (made for the design)
const measure = new Recorder(1, 1);       // text widths, as drawn

/* The layout for box w x h and its placement: the scale and offset
 * (device = logical * scale + o) and the part of the layout it shows
 * (viewport, logical px). A box under COMPACT_H high (iDrive 7) gets the
 * compact layout made for it at scale 1; a higher one (iDrive 8) the
 * design's VIEWPORT fitted in, centred, on whole device pixels. */
function placement(w, h) {
    if (h < COMPACT_H) {
        return { scale: 1, ox: 0, oy: 0, viewport: { x: 0, y: 0, w, h }, layout: compact(w, h) };
    }
    const scale = Math.min(w / VIEWPORT.w, h / VIEWPORT.h);
    return { scale, ox: Math.round((w - VIEWPORT.w * scale) / 2 - VIEWPORT.x * scale),
        oy: Math.round((h - VIEWPORT.h * scale) / 2 - VIEWPORT.y * scale), viewport: VIEWPORT, layout: null };
}

/* The components in focus order: on a tab its side menu first; on a page
 * its own items, then Back, then the side menu; a confirm step only its
 * buttons, Cancel first. */
function ordered(st, page) {
    const cs = st.components;
    if (st.name === 'confirm') {
        return ['later', 'now'].map((n) => cs.find((c) => c.name === n)).filter(Boolean);
    }
    if (!page) {
        return cs;
    }
    const by = (n) => cs.filter((c) => c.name === n);
    return cs.filter((c) => c.name !== 'nav' && c.name !== 'back').concat(by('back'), by('nav'));
}

function itemsOf(st, page) {
    const items = [];
    const regions = [];
    ordered(st, page).forEach((c) => {
        const o = c.opts || {};
        const b = { x: c.x, y: c.y, w: c.w, h: c.h };
        if (o.hidden) {
            return;
        }
        if (c.gpu === 'sideNav') {
            const list = navItems(o);
            const ih = b.h / Math.max(1, list.length);
            list.forEach((it, i) => items.push({ x: b.x + 8, y: b.y + i * ih + 8, w: b.w - 24, h: ih - 16, r: 16, label: it.label, act: it.act }));
        } else if (c.gpu === 'vbutton') {
            if (o.act && !o.disabled) {
                const round = o.style === 'round';
                items.push({ x: b.x, y: b.y, w: b.w, h: b.h, r: round ? b.w / 2 : Math.min(18, b.h / 2), label: o.text || 'Back', act: o.act });
            }
        } else if (c.gpu === 'tabs') {
            const t = tabCells(b, o);
            String(o.items).split(',').forEach((label, i) => items.push({ x: b.x + i * (t.cw + t.gap), y: b.y, w: t.cw, h: b.h, r: 14,
                label: label.trim(), act: (o.acts || [])[i] }));
        } else if (c.gpu === 'appGrid') {
            const g = gridView(b, o);
            const key = `${st.name}.${c.name}`;
            regions.push({ key, x: b.x, y: b.y, w: b.w, h: b.h, step: g.th, max: Math.max(0, g.rows - g.shown) });
            g.all.forEach((it, k) => {
                const row = Math.floor(k / g.cols);
                const item = { x: b.x + (k % g.cols) * g.tw + 8, y: b.y + (row - g.top) * g.th, w: g.tw - 16, h: g.th - 8, r: 24,
                    label: it.title, act: it.act };
                if (row < g.top || row >= g.top + g.shown) {
                    item.reveal = { key, top: row < g.top ? row : row - g.shown + 1 };
                }
                items.push(item);
            });
        } else if (c.gpu === 'appList') {
            const v = listView(b, o);
            const key = `${st.name}.${c.name}`;
            const gap = Math.round(v.rh * 0.13);
            regions.push({ key, x: b.x, y: b.y, w: b.w, h: b.h, step: v.rh, max: Math.max(0, v.all.length - v.n) });
            v.all.forEach((it, k) => {
                const y = b.y + (k - v.top) * v.rh;
                const out = k < v.top || k >= v.top + v.n;
                const reveal = out ? { key, top: k < v.top ? k : k - v.n + 1 } : undefined;
                items.push({ x: b.x, y, w: b.w, h: v.rh - gap, r: 22, label: it.title, act: it.act, reveal });
                if (it.chipAct) {
                    const chip = rightBoxes({ x: b.x, y, w: b.w, h: v.rh - gap }, it, measure, o.ctlK).find((rb) => rb.kind === 'chip');
                    if (chip) {
                        const ch = 72 * (o.ctlK || 1);
                        items.push({ x: chip.x, y: y + (v.rh - gap - ch) / 2, w: chip.w - 12, h: ch, r: ch / 2, label: chip.arg, act: it.chipAct, reveal });
                    }
                }
            });
        }
    });
    return { items: items.filter((it) => it.act), regions };
}

/* The screen object am_gpu.js draws: the layout's components with the
 * values over their own options (a layout's own SIZES kept) and the kept
 * scroll. */
function screenOf(v, scroll, layout) {
    const def = (layout || SCREENS).screens.find((s) => s.name === v.screen);
    return { kind: 'gpu', name: def.name, theme: def.theme, bg: 'theme',
        components: def.components.map((c) => {
            const opts = Object.assign({}, c.opts, v.values[c.name] || {});
            if (layout) {
                SIZES.filter((k) => c.opts[k] !== undefined).forEach((k) => { opts[k] = c.opts[k]; });
            }
            if (c.gpu === 'appGrid' || c.gpu === 'appList') {
                opts.top = scroll[`${def.name}.${c.name}`] || 0;
            }
            return Object.assign({}, c, { opts });
        }) };
}

function frame(m, opts) {
    const o = opts || {};
    const scroll = o.scroll || {};
    const v = view(m);
    const page = m.stack.length > 1;
    const layout = o.layout || null;
    let st = screenOf(v, scroll, layout);
    let laid = itemsOf(st, page);
    const it = laid.items[o.focus];
    if (it && it.reveal) {
        scroll[it.reveal.key] = it.reveal.top;
        st = screenOf(v, scroll, layout);
        laid = itemsOf(st, page);
    }
    const rec = record(st, layout ? { textScale: o.textScale || 1, design: layout.design,
        area: { x: 0, y: 0, w: layout.design.w, h: layout.design.h } } : { textScale: o.textScale || 1, view: 'id8' });
    const f = laid.items[o.focus];
    if (f && !f.reveal) {
        rec.strokeRoundRect(f.x - 8, f.y - 8, f.w + 16, f.h + 16, f.r + 8, 5, FOCUS);
    }
    return { screen: v.screen, rec, items: laid.items, regions: laid.regions, icons: icons(v), values: v.values };
}

/* The visible item under (x, y) (design px), or -1. */
function hit(items, x, y) {
    for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (!it.reveal && x >= it.x && x < it.x + it.w && y >= it.y && y < it.y + it.h) {
            return i;
        }
    }
    return -1;
}

module.exports = { frame, hit, placement };
