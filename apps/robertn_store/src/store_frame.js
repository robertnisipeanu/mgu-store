'use strict';
/**
 * One frame of the Store's renderer screens: the page on top's screen
 * (src/am_screens.js) with its values (src/store_ui.js), drawn by am_gpu.js
 * in design pixels, and what on it can be pressed, in focus order, with
 * where it is: the controller's proxies (src/store_drawn.js), touch and the
 * focus ring use the same list. No I/O (tools/test_screens.js).
 *
 *   frame(model, { textScale, focus, scroll, layout }) -> { screen, rec, items, regions, icons }
 *   layoutOf(model, frame()'s options) -> its items, regions and icons, without drawing (a focus out of view
 *   scrolls as in frame())
 *   dragOf(model, { textScale, scroll, layout }, key) -> what a drag of grid or list key draws (store_drawn.js)
 *   dragFrame(drag, baseLayer, rowsLayer, from, top, textScale) -> one frame of that drag
 *   toward(items, i, dir) -> the item the controller's tilt dir ('N', 'E', 'S', 'W') moves the focus to from item i
 *
 * layout: placement()'s; the iDrive 8 design when null.
 *
 * items: { x, y, w, h, r, label, act, reveal?, box? }; an item of a grid or
 * list carries box: its grid's or list's box, which bounds where it takes a
 * touch, and while not wholly in view reveal { key, top }: the scroll that
 * shows it.
 * regions: the scrolling grids and lists, { key, x, y, w, h, step, max }.
 * scroll ({ key: rows scrolled, fractional }) is kept by the caller and
 * follows the focus.
 */
const SCREENS = require('./am_screens.js');
const { record } = require('./am_gpu.js');
const { Recorder } = require('./kit_record.js');
const { withAlpha } = require('./kit_canvas.js');
const { theme: kitTheme } = require('./kit_themes.js');
const { view, icons } = require('./store_ui.js');
const { tabCells } = require('./am_widgets.js');
const { gridView, listView, navItems, rightBoxes, keyBoxes, shown } = require('./am_store_widgets.js');
const { compact } = require('./store_compact.js');
const { t } = require('./i18n.js');

/* The part of the design the renderer's box shows: the screens' content
 * (the side menu at x 126 to the right edge, the title at y 114 to the
 * bottom at 840), with a margin. */
const VIEWPORT = { x: 106, y: 100, w: 2754, h: 756 };
const COMPACT_H = 700;                    // a box lower than this gets src/store_compact.js's layout
const FOCUS = '#ffffff';
const EPS = 1e-6;                         // rows: a scrolled row this close to the edge counts as shown
const SIZES = ['rowH', 'tileH', 'size'];  // a layout's own sizes: kept over the values' (made for the design)
const measure = new Recorder(1, 1);       // text widths, as drawn
const WORDS = ['text', 'title', 'label', 'empty', 'items'];   // a layout's own words, in the display language
const AFTER_GAP = 24;                     // a text placed after another (opts.after): the room between them

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
        return ['later', 'now', 'also'].map((n) => cs.find((c) => c.name === n)).filter(Boolean);
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
            regions.push({ key, x: b.x, y: b.y, w: b.w, h: b.h, step: g.th, max: g.max });
            g.all.forEach((it, k) => {
                const row = Math.floor(k / g.cols);
                const item = { x: b.x + (k % g.cols) * g.tw + 8, y: b.y + (row - g.top) * g.th, w: g.tw - 16, h: g.th - 8, r: 24,
                    label: it.title, act: it.act, box: b };
                if (row < g.top || row + 1 > g.top + g.shown + EPS) {
                    item.reveal = { key, top: row < g.top ? row : row + 1 - g.shown };
                }
                items.push(item);
            });
        } else if (c.gpu === 'appList') {
            const v = listView(b, o);
            const key = `${st.name}.${c.name}`;
            const gap = v.gap;
            regions.push({ key, x: b.x, y: b.y, w: b.w, h: b.h, step: v.rh, max: v.max });
            v.all.forEach((it, k) => {
                const y = b.y + (k - v.top) * v.rh;
                const out = k < v.top || k + 1 > v.top + v.n + EPS;
                const reveal = out ? { key, top: k < v.top ? k : k + 1 - v.n } : undefined;
                items.push({ x: b.x, y, w: b.w, h: v.rh - gap, r: 22, label: it.title, act: it.act, reveal, box: b, list: key });
                if (it.chipAct) {
                    const chip = rightBoxes({ x: b.x, y, w: b.w, h: v.rh - gap }, it, measure, o.ctlK).find((rb) => rb.kind === 'chip');
                    if (chip) {
                        const ch = 72 * (o.ctlK || 1);
                        items.push({ x: chip.x, y: y + (v.rh - gap - ch) / 2, w: chip.w - 12, h: ch, r: ch / 2, label: chip.arg, act: it.chipAct, reveal, box: b,
                            list: key });
                    }
                }
            });
        } else if (c.gpu === 'keyboard') {
            // each key presses what it types now (Shift: capitals, the symbols page: its symbols)
            keyBoxes(b, o).forEach((k) => {
                const key = shown(k, o);
                items.push({ x: k.x, y: k.y, w: k.w, h: k.h, r: 18, label: key, act: { do: 'key', key } });
            });
        }
    });
    return { items: items.filter((it) => it.act), regions };
}

/* A layout's options with its words in the display language. */
function translated(opts) {
    const out = Object.assign({}, opts);
    WORDS.filter((k) => typeof out[k] === 'string' && out[k]).forEach((k) => { out[k] = t(out[k]); });
    return out;
}

/* The screen object am_gpu.js draws: the layout's components with the
 * values over their own options (a layout's own SIZES kept) and the kept
 * scroll. A text with opts.after starts at least AFTER_GAP right of the
 * end of that one's text. A shown component with opts.shift ({ name: [dx,
 * dw] }) moves those components right by dx and widens them by dw. */
function screenOf(v, scroll, layout) {
    const def = (layout || SCREENS).screens.find((s) => s.name === v.screen);
    const components = def.components.map((c) => {
        const opts = Object.assign(translated(c.opts), v.values[c.name] || {});
        if (layout) {
            SIZES.filter((k) => c.opts[k] !== undefined).forEach((k) => { opts[k] = c.opts[k]; });
        }
        if (c.gpu === 'appGrid' || c.gpu === 'appList') {
            opts.top = scroll[`${def.name}.${c.name}`] || 0;
        }
        return Object.assign({}, c, { opts });
    });
    const shift = Object.assign({}, ...components.filter((c) => c.opts.shift && !c.opts.hidden).map((c) => c.opts.shift));
    const placed = components.map((c) => (!shift[c.name] ? c
        : Object.assign({}, c, { x: c.x + shift[c.name][0], w: c.w + shift[c.name][1] })));
    return { kind: 'gpu', name: def.name, theme: def.theme, bg: 'theme',
        components: placed.map((c) => {
            const a = c.opts.after && placed.find((o) => o.name === c.opts.after);
            const end = a && a.opts.text ? a.x + measure.textWidth(a.opts.text, a.opts.size, { font: a.opts.font }) + AFTER_GAP : 0;
            return end > c.x ? Object.assign({}, c, { x: Math.round(end), w: Math.max(0, c.w - Math.round(end - c.x)) }) : c;
        }) };
}

/* record()'s options for a layout (null: the iDrive 8 design). */
const recordOpts = (layout, textScale) => (layout ? { textScale: textScale || 1, design: layout.design,
    area: { x: 0, y: 0, w: layout.design.w, h: layout.design.h } } : { textScale: textScale || 1, view: 'id8' });

/* A drag of grid or list key, so a drag frame moves its rows without the
 * frame built again: rec, the frame as it is without the grid's or list's
 * rows (what is behind them shows between them); box, step (a row's
 * height), rows (their count), shown (rows the box holds), max (the
 * largest scroll); bar, the grid's scroll bar colour (null: a list, no
 * bar); and draw(from, n): rows from..from+n drawn from 0, 0, n * step
 * high. null when key is not on the screen or has nothing to scroll. */
function dragOf(m, opts, key) {
    const o = opts || {};
    const layout = o.layout || null;
    const st = screenOf(view(m), o.scroll || {}, layout);
    const c = st.components.find((x) => `${st.name}.${x.name}` === key);
    if (!c || (c.gpu !== 'appGrid' && c.gpu !== 'appList') || c.opts.hidden) {
        return null;
    }
    const b = { x: c.x, y: c.y, w: c.w, h: c.h };
    const grid = c.gpu === 'appGrid';
    const g = grid ? gridView(b, c.opts) : listView(b, c.opts);
    if (g.max <= 0) {
        return null;
    }
    const step = grid ? g.th : g.rh;
    const ro = recordOpts(layout, o.textScale);
    const without = Object.assign({}, st, { components: st.components.map((x) => (x === c
        ? Object.assign({}, c, { opts: Object.assign({}, c.opts, { hidden: true }) }) : x)) });
    const draw = (from, n) => record({ kind: 'gpu', name: st.name, theme: st.theme, bg: 'none',
        components: [Object.assign({}, c, { x: 0, y: 0, h: n * step, opts: Object.assign({}, c.opts, { top: from, bar: false }) })] },
    Object.assign({}, ro, { design: { w: b.w, h: n * step }, area: { x: 0, y: 0, w: b.w, h: n * step } }));
    return { rec: record(without, ro), box: b, step, rows: grid ? g.rows : g.all.length, shown: grid ? g.shown : g.n, max: g.max,
        bar: grid ? withAlpha(kitTheme(st.theme).text, 0.25) : null, draw };
}

/* A frame of a drag (dragOf's d): baseLayer, the layer of d.rec, and
 * rowsLayer, the layer of d.draw(from, n), drawn with the rows at scroll
 * top (rows) in the box, and the grid's scroll bar. */
function dragFrame(d, baseLayer, rowsLayer, from, top, textScale) {
    const b = d.box;
    const r = new Recorder(d.rec.w, d.rec.h, { textScale: textScale || 1 });
    r.clear([0, 0, 0, 0]);
    r.blit(baseLayer, 0, 0);
    r.clip(b.x, b.y, b.w, b.h);
    r.blit(rowsLayer, b.x, b.y + (from - top) * d.step);
    r.noclip();
    if (d.bar && d.max > 0) {
        const h = b.h * d.shown / d.rows;
        r.roundRect(b.x + b.w - 6, b.y + (b.h - h) * top / d.max, 6, h, 3, d.bar);
    }
    return r;
}

/* frame() without the drawing: what can be pressed and where, the scrolling
 * regions and the pictures. */
function layoutOf(m, opts) {
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
    return { st, screen: v.screen, items: laid.items, regions: laid.regions, icons: icons(v), values: v.values };
}

function frame(m, opts) {
    const o = opts || {};
    const l = layoutOf(m, o);
    const rec = record(l.st, recordOpts(o.layout || null, o.textScale));
    const f = l.items[o.focus];
    if (f && !f.reveal) {
        rec.strokeRoundRect(f.x - 8, f.y - 8, f.w + 16, f.h + 16, f.r + 8, 5, FOCUS);
    }
    return { screen: l.screen, rec, items: l.items, regions: l.regions, icons: l.icons, values: l.values };
}

const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/* The item under (x, y) (design px), or -1: a scrolled one where its grid or
 * list shows it. */
function hit(items, x, y) {
    for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if ((!it.box || inside(it.box, x, y)) && inside(it, x, y)) {
            return i;
        }
    }
    return -1;
}

/* The item a tilt of the controller moves the focus to from items[i], of those ahead that way: one in line (sharing
 * some of items[i]'s span across the tilt) first, the nearest ahead and of those the nearest to the side; else one at
 * most as far off to the side as ahead, the nearest with the distance to the side counting double. null when none
 * is. Items out of view count where a scroll puts them. */
function toward(items, i, dir) {
    const cur = items[i];
    if (!cur) {
        return null;
    }
    const across = dir === 'E' || dir === 'W';
    const cx = cur.x + cur.w / 2;
    const cy = cur.y + cur.h / 2;
    let best = null;
    let score = Infinity;
    items.forEach((it, k) => {
        const dx = it.x + it.w / 2 - cx;
        const dy = it.y + it.h / 2 - cy;
        const ahead = dir === 'E' ? dx : dir === 'W' ? -dx : dir === 'S' ? dy : -dy;
        const side = across ? Math.abs(dy) : Math.abs(dx);
        const inLine = across ? it.y < cur.y + cur.h && cur.y < it.y + it.h : it.x < cur.x + cur.w && cur.x < it.x + it.w;
        const s = inLine ? ahead * 1e4 + side : 1e12 + ahead + 2 * side;
        if (k !== i && ahead > 4 && (inLine || side <= ahead) && s < score) {
            score = s;
            best = k;
        }
    });
    return best;
}

module.exports = { frame, layoutOf, dragOf, dragFrame, hit, placement, toward };
