'use strict';
/*
 * The store's widgets (App Manager 2) for renderer screens: app icons, app grid, lists with pictures, chips, side
 * menu, buttons, on-screen keyboard, sheet. Every icon here is drawn by the renderer - kit/vicons.js vector icons or
 * pictures an app hands over (ScreenApp.setImage -> 'key:<name>') - never the HMI's glyph icons, which differ between
 * iDrive 7 and 8 (widgets.js icon()). Same signature as widgets.js: (cv, t, b, o).
 * Taps reach the app as ScreenApp 'change' events: o.tap = { id, part, n } / o.key = { text, n }, n counting up so a
 * second tap on the same thing is a change too.
 */
const { withAlpha, mix, rgba: rgbaOf } = require('./kit_canvas.js');
const { vicon } = require('./kit_vicons.js');
const W = require('./am_widgets.js');
const { t: tr } = require('./i18n.js');

const GREEN = '#35d07f', BLUE = '#2a7fff', AMBER = '#ffb020', RED = '#ff5a5f';
const C = (t, c, d) => (c ? t[c] || c : d);
const mid = (cv, s, x, cy, size, c, opts) => cv.text(String(s), x, cy + size * 0.36, size, c, opts);
const lines = (s) => String(s || '').split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((l) => l[0]);
const pair = (s, d) => { const p = String(s || '').split(',').map((x) => x.trim()).filter(Boolean); return p.length >= 2 ? p : d; };
const tapped = (o, id, part) => { o.tapN = (o.tapN || 0) + 1; o.tap = { id, part, n: o.tapN }; };
// A row's state as a pill: two cells in a black ring, its colour in the left one with an icon, its words in white on
// a dark face in the right one; a light line along the top of each. pillBox: where it is, its right edge at xr.
const PILL_ICON = { [BLUE]: 'arrowDown', [AMBER]: 'clock', [RED]: 'warning', [GREEN]: 'check' };
const pillWidth = (cv, text, k) => cv.textWidth(text, 23 * k) + 50 * k + 30 * k + 4.5;
function pill(cv, t, text, xr, cy, k, color, glyph) {
    const h = 50 * k, w = pillWidth(cv, text, k), x = xr - w, y = cy - h / 2, r = 13 * k, e = 1.5, ih = h - 2 * e, ri = r - e;
    const tone = color || mix(t.panelTop, '#ffffff', 0.22), c = rgbaOf(tone), light = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 165;
    const lx = x + e + ih + e, lw = x + w - e - lx;
    cv.roundRect(x, y, w, h, r, '#000000');
    // each cell rounded on its outer side only: a rounded box, its inner corners squared off (the ring shows between)
    cv.roundRect(x + e, y + e, ih, ih, ri, tone); cv.fillRect(x + e + ih - ri, y + e, ri, ih, tone);
    cv.fillRect(x + e + ri, y + e, ih - ri, 1.5, withAlpha('#ffffff', 0.3));
    const face = mix(t.panelTop, t.bg, 0.25);
    cv.roundRect(lx, y + e, lw, ih, ri, face); cv.fillRect(lx, y + e, ri, ih, face);
    cv.fillRect(lx, y + e, lw - ri, 1.5, withAlpha('#ffffff', W.HAIR));
    const g = ih * 0.56, gx = x + e + (ih - g) / 2, gy = cy - g / 2;
    if (!light) vicon(cv, glyph, gx, gy + Math.max(1, g * 0.05), g, withAlpha('#000000', 0.45));
    vicon(cv, glyph, gx, gy, g, light ? withAlpha('#000000', 0.82) : '#ffffff');
    const ts = 23 * k, tx = lx + 14 * k, ty = cy + ts * 0.36;
    cv.text(text, tx, ty + 1.5, ts, withAlpha('#000000', 0.85));
    cv.text(text, tx, ty, ts, withAlpha('#ffffff', 0.92));
}
const BADGE = { installed: [GREEN, 'check'], update: [BLUE, 'arrowDown'], queued: [AMBER, 'clock'] };

/**
 * App icon in the s x s square at (x, y): the picture a.icon names, else a gradient (a.colors) with the vector glyph
 * a.vicon, else the title's first letter. Apps: rounded square (corner radius rad, its own when absent); system services (a.kind 'service' or a service kind):
 * round. a.badge: installed | update | queued; a.progress 0..1: the icon dimmed under a ring (downloading). bg: the colour behind the badge.
 */
function appIcon(cv, t, a, x, y, s, bg, rad) {
    const cx = x + s / 2, cy = y + s / 2, round = a.kind && a.kind !== 'app', c = pair(a.colors, ['#3a4352', '#232a35']);
    const img = a.icon ? W.picture(a.icon) : null;
    if (img) cv.image(img, x, y, s, s, round ? s / 2 : rad == null ? s * 0.24 : rad);
    else {
        // a flat fill inside a thin border that runs from lighter at the top to darker at the bottom
        const fill = mix(c[0], c[1], 0.45), bw = Math.max(2, s * 0.035), r = round ? s / 2 : rad == null ? s * 0.16 : rad;
        cv.card(x, y, s, s, r, [[0, mix(fill, '#ffffff', 0.5)], [1, mix(fill, '#000000', 0.4)]]);
        cv.roundRect(x + bw, y + bw, s - 2 * bw, s - 2 * bw, r - bw, fill);
    }
    if (!img) {
        // the glyph or letter in white over a tight shadow of itself, just below
        const g = s * 0.56, d = Math.max(1.5, s * 0.025), shade = withAlpha('#000000', 0.4);
        if (a.vicon && vicon(cv, a.vicon, cx - g / 2, cy - g / 2 + d, g, shade)) vicon(cv, a.vicon, cx - g / 2, cy - g / 2, g, '#ffffff');
        else {
            const letter = (String(a.letter || a.title || '?').trim()[0] || '?').toUpperCase(), ls = Math.round(s * 0.5);
            cv.text(letter, cx, cy + s * 0.18 + d, ls, shade, { align: 'center', font: 'bold' });
            cv.text(letter, cx, cy + s * 0.18, ls, '#ffffff', { align: 'center', font: 'bold' });
        }
    }
    if (typeof a.progress === 'number' && a.progress >= 0) {
        // the icon dimmed, the progress as a white ring inside it
        const r0 = s * 0.3, r1 = s * 0.37;
        cv.roundRect(x, y, s, s, round ? s / 2 : rad == null ? s * (img ? 0.24 : 0.16) : rad, withAlpha('#000000', 0.6));
        cv.arc(cx, cy, r0, r1, 0, 360, withAlpha('#ffffff', 0.25));
        if (a.progress > 0) cv.arc(cx, cy, r0, r1, 0, 360 * Math.min(1, a.progress), '#ffffff', { round: true });
    }
    const bd = BADGE[a.badge];
    if (bd) {
        const br = s * 0.17, bx = x + s - br * 0.6, by = y + br * 0.6, gs = br * 1.3;
        cv.circle(bx, by, br + Math.max(2, s * 0.03), bg || t.bg);
        cv.circle(bx, by, br, bd[0]);
        vicon(cv, bd[1], bx - gs / 2, by - gs / 2, gs, '#ffffff');
    }
}

/** Pill with optional dot; returns its width. x = right edge when right. */
function chip(cv, text, x, y, h, c, dot, right) {
    const s = Math.round(h * 0.44), d = h * 0.16, w = cv.textWidth(text, s) + h * 0.9 + (dot ? d * 3 : 0), x0 = right ? x - w : x;
    cv.roundRect(x0, y, w, h, h / 2, withAlpha(c, 0.14));
    cv.strokeRoundRect(x0, y, w, h, h / 2, 2, withAlpha(c, 0.55));
    let tx = x0 + h * 0.45;
    if (dot) { cv.circle(tx + d, y + h / 2, d, c); tx += d * 3; }
    cv.text(text, tx, y + h / 2 + s * 0.36, s, c);
    return w;
}
const chipItems = (items) => (Array.isArray(items) ? items
    : String(items || '').split(';').map((s) => s.split('|').map((x) => x.trim())).filter((p) => p[0])
        .map((p) => ({ text: p[0], color: p[1], dot: p[2] === 'dot' })));

function chips(cv, t, b, o) {
    const items = chipItems(o.items), gap = b.h * 0.25;
    if (o.radius) {         // (the Store) a state in a box of the header controls' height and corners, as wide as its element: a
        // quiet face, its colour in the dot, the dot and the words in its middle (the words smaller when long)
        const it = items[0], s = o.size || Math.round(b.h * 0.4), d = s * 0.3, lead = it && it.dot ? d * 2 + s * 0.45 : 0;
        if (!it) return;
        const room = b.w - 28 - lead, ts = W.shrink(cv, it.text, room, s), text = W.fit(cv, it.text, room, ts);
        const x0 = b.x + (b.w - lead - cv.textWidth(text, ts)) / 2;
        W.lit(cv, b.x, b.y, b.w, b.h, o.radius, mix(t.panelTop, t.bg, 0.35));
        if (it.dot) cv.circle(x0 + d, b.y + b.h / 2, d, C(t, it.color, t.text));
        cv.text(text, x0 + lead, b.y + b.h / 2 + ts * 0.36, ts, t.text);
        return;
    }
    if (o.align === 'right') {
        let x = b.x + b.w;
        for (let i = items.length - 1; i >= 0; i--) x -= chip(cv, items[i].text, x, b.y, b.h, C(t, items[i].color, t.text), items[i].dot, true) + gap;
    } else {
        let x = b.x;
        for (const it of items) x += chip(cv, it.text, x, b.y, b.h, C(t, it.color, t.text), it.dot) + gap;
    }
}

function appIconEl(cv, t, b, o) {
    const s = Math.min(b.w, b.h);
    appIcon(cv, t, o, b.x + (b.w - s) / 2, b.y + (b.h - s) / 2, s);
}

// ---- app grid: tiles in rows, scrolled by the pixel (o.top: rows scrolled, fractional) -------------------------
const gridItems = (o) => (Array.isArray(o.items) ? o.items
    : lines(o.items).map((l, i) => ({ id: `item${i}`, title: l[0], sub: l[1] || '', vicon: l[2] || '', colors: l[3] ? `${l[3]},${l[4] || l[3]}` : '' })));
function gridView(b, o) {
    const cols = Math.max(1, o.cols | 0 || 5), th = o.tileH || 274, all = gridItems(o), rows = Math.ceil(all.length / cols);
    const shown = b.h / th, max = Math.max(0, rows - shown), top = Math.max(0, Math.min(max, +o.top || 0));
    return { cols, th, tw: b.w / cols, all, rows, shown, max, top, first: Math.floor(top), end: Math.min(rows, Math.ceil(top + shown)) };
}
/** The ids of the tiles on screen (the app decodes only their icons). */
function visibleIds(b, o) {
    const g = gridView(b, o);
    return g.all.slice(g.first * g.cols, g.end * g.cols).map((a) => a.id);
}
// a source line too long for its tile keeps its repo name whole and shortens the owner
function fitSource(cv, s, w, size) {
    const i = s.lastIndexOf('/');
    if (i < 0 || cv.textWidth(s, size) <= w) return W.fit(cv, s, w, size);
    const repo = s.slice(i);
    return W.fit(cv, s.slice(0, i), Math.max(0, w - cv.textWidth(repo, size)), size) + repo;
}
// (the Store: o.iconK, o.titleSize, o.subSize size a smaller tile's icon and texts; the defaults are the design's.
// Tiles with a source line (item.src, dim, under the title) set the three lines closer and take the icon that
// leaves them, descenders included, above the tile's bottom 8 px, where the focus rings are drawn: store_frame.js.)
function appGrid(cv, t, b, o) {
    const g = gridView(b, o), k = g.th / 274;
    const ts = o.titleSize || 40, ss = o.subSize || 30, rs = Math.round(ss * 0.9), top = 12 * k;
    const src = g.all.some((a) => a.src);
    const gap = src ? [ts * 1.2, rs * 1.25, ss * 1.25] : [ts * 1.45, 0, ss * 1.4];
    const s = src ? Math.floor(Math.min(g.th * (o.iconK || 0.5), g.th - 8 - top - gap[0] - gap[1] - gap[2] - ss * 0.25))
        : Math.round(g.th * (o.iconK || 0.5));
    cv.clip(b.x, b.y, b.w, b.h);
    g.all.slice(g.first * g.cols, g.end * g.cols).forEach((a, i) => {
        const x = b.x + (i % g.cols) * g.tw, y = b.y + (g.first + Math.floor(i / g.cols) - g.top) * g.th;
        appIcon(cv, t, a, x + (g.tw - s) / 2, y + top, s);
        const ny = y + top + s + gap[0], sy = ny + gap[1];
        cv.text(W.fit(cv, String(a.title || ''), g.tw - 16, ts, 'bold'), x + g.tw / 2, ny, ts, t.text, { align: 'center', font: 'bold' });
        if (a.src) cv.text(fitSource(cv, String(a.src), g.tw - 16, rs), x + g.tw / 2, sy, rs, t.dim, { align: 'center' });
        if (a.sub) cv.text(W.fit(cv, String(a.sub), g.tw - 16, ss), x + g.tw / 2, sy + gap[2], ss, C(t, a.subColor, t.dim), { align: 'center' });
    });
    cv.noclip();
    if (!g.all.length && o.empty) mid(cv, o.empty, b.x + b.w / 2, b.y + b.h / 2, 36, t.dim, { align: 'center' });
    if (g.max > 0 && o.bar !== false) { // scroll bar (o.bar false: none, store_frame.js's drag rows)
        const h = b.h * g.shown / g.rows, y = b.y + (b.h - h) * g.top / g.max;
        cv.roundRect(b.x + b.w - 6, y, 6, h, 3, withAlpha(t.text, 0.25));
    }
}

// ---- list rows with a picture / vector icon and a control on the right ---------------------------------------
const rowItems = (o) => (Array.isArray(o.items) ? o.items
    : lines(o.items).map((l, i) => ({ id: `row${i}`, title: l[0], sub: l[1] || '', right: l[2] || 'chevron', vicon: l[3] || '' })));
// (the Store: o.fit, rows that do not all fit at o.rowH share the box as one group, each on one line: its title, and
// its sub on the right)
function listView(b, o) {
    const all = rowItems(o), line = !!o.fit && all.length * (o.rowH || 120) > b.h + 1e-6, rh = line ? b.h / all.length : o.rowH || 120;
    const n = b.h / rh, max = Math.max(0, all.length - n), top = Math.max(0, Math.min(max, +o.top || 0));
    // the gap between rows keeps the focus ring (8 px out from a row) off the next one
    const gap = Math.max(9, Math.round(rh * 0.13));
    return { rh, gap, all, n, max, top, line, first: Math.floor(top), end: Math.min(all.length, Math.ceil(top + n)) };
}
// the right-hand controls of a row ("toggle:on+trash": laid out from the right) -> [{ kind, arg, x, w }]
const RIGHT_W = { chevron: 60, trash: 80, toggle: 122 };
// (the Store: c scales the controls of a smaller row, o.ctlK)
function rightBoxes(b, it, cv, c) {
    let x = b.x + b.w;
    const k = c || 1;
    return String(it.right || '').split('+').filter(Boolean).reverse().map((r) => {
        const kind = r.split(':')[0], arg = r.slice(kind.length + 1);
        const w = (kind === 'chip' ? pillWidth(cv, arg, k) : (RIGHT_W[kind] || 0) * k) + 24 * k;
        x -= w;
        return { kind, arg, x, w };
    });
}
// (the Store: o.titleSize, o.subSize and o.ctlK size a smaller row's texts and controls; the defaults are the design's)
function appList(cv, t, b, o) {
    const v = listView(b, o), gap = v.gap, q = o.ctlK || 1, ts = o.titleSize || 40, ss = o.subSize || 30;
    cv.clip(b.x, b.y, b.w, b.h);
    v.all.slice(v.first, v.end).forEach((it, k) => {
        const y = b.y + (v.first + k - v.top) * v.rh, h = v.rh - gap, s = Math.round(h * 0.73);
        // a row is a card, its edge lit; rows sharing a box (v.line) are one group, a hairline between them
        if (!v.line) {
            W.lit(cv, b.x, y, b.w, h, 22 * q, [[0, t.panelTop], [1, mix(t.panelTop, t.panelBottom, 0.72)]]);
        } else if (v.first + k > 0) cv.fillRect(b.x + 6 * q, y - gap / 2 - 0.75, b.w - 12 * q, 1.5, withAlpha('#ffffff', W.HAIR));
        const left = v.line ? 6 * q : 28 * q;
        let tx = b.x + left;
        if (it.icon || it.vicon || it.colors || it.letter) {
            if (it.plain && it.vicon) {
                vicon(cv, it.vicon, b.x + left, y + (h - s) / 2, s, C(t, it.iconColor, t.text));
                if (it.mark) {          // a character over the icon's bottom right corner, on a tight shadow of itself
                    const ms = Math.round(s * 0.62), mx = b.x + left + s * 1.04, my = y + (h + s) / 2 + s * 0.02, d = Math.max(1.5, ms * 0.07);
                    cv.text(String(it.mark), mx, my + d, ms, withAlpha('#000000', 0.75), { align: 'right', font: 'bold' });
                    cv.text(String(it.mark), mx, my, ms, C(t, it.iconColor, t.text), { align: 'right', font: 'bold' });
                }
            }
            // the icon the same distance from the row's left, top and bottom, its corners concentric with the row's
            else appIcon(cv, t, it, b.x + (h - s) / 2, y + (h - s) / 2, s, t.panelTop, Math.max(2, 22 * q - (h - s) / 2));
            tx = v.line ? b.x + left + s + 20 * q : b.x + 22 * q + s + 32 * q;
        }
        const boxes = rightBoxes(b, it, cv, q), room = (boxes.length ? boxes[boxes.length - 1].x : b.x + b.w) - tx - 8;
        if (v.line) {
            // the title on the left, its value against the control on the right
            const title = W.fit(cv, String(it.title || ''), room, ts, 'bold'), sx = tx + cv.textWidth(title, ts, { font: 'bold' }) + 24 * q;
            cv.text(title, tx, y + h / 2 + ts * 0.36, ts, t.text, { font: 'bold' });
            const sw = tx + room - sx, sz = it.sub ? W.shrink(cv, it.sub, sw, ss, undefined, 0.85) : ss;
            if (it.sub && sw > 0) cv.text(W.fit(cv, String(it.sub), sw, sz), tx + room, y + h / 2 + ts * 0.36, sz, C(t, it.subColor, t.dim), { align: 'right' });
        } else {
            cv.text(W.fit(cv, String(it.title || ''), room, ts, 'bold'), tx, it.sub ? y + h * 0.47 : y + h / 2 + ts * 0.36, ts, t.text, { font: 'bold' });
            if (it.sub) cv.text(W.fit(cv, String(it.sub), room, ss), tx, y + h * 0.83, ss, C(t, it.subColor, t.dim));
        }
        const cy = y + h / 2;
        for (const rb of boxes) {
            const re = rb.x + rb.w - 24 * q;                // the control's right edge
            if (rb.kind === 'chevron') W.chevron(cv, re - 28 * q, cy, 22 * q, 'right', 4 * q, t.dim);
            else if (rb.kind === 'trash') vicon(cv, 'trash', re - 66 * q, cy - 30 * q, 60 * q, t.dim);
            else if (rb.kind === 'toggle') {
                const on = rb.arg === 'on', tw = 122 * q, th = 62 * q, tx0 = re - tw;
                // a rounded box with a weak edge, its knob a rounded square in a lighter shade of the box's colour
                const tr0 = th * 0.26, in0 = 5 * q, face = on ? BLUE : '#232a35', kw = (tw - 2 * in0) * 0.48;
                cv.roundRect(tx0, cy - th / 2, tw, th, tr0, face);
                cv.strokeRoundRect(tx0 + 1, cy - th / 2 + 1, tw - 2, th - 2, tr0 - 1, 1.5, on ? mix(BLUE, '#ffffff', 0.3) : withAlpha('#ffffff', 0.12));
                cv.roundRect(on ? tx0 + tw - in0 - kw : tx0 + in0, cy - th / 2 + in0, kw, th - 2 * in0, tr0 - in0 * 0.6, on ? mix(BLUE, '#ffffff', 0.78) : '#5d6778');
            } else if (rb.kind === 'chip') {
                const pc = it.chipColor && it.chipColor !== 'dim' ? it.chipColor : null;
                pill(cv, t, rb.arg, re, cy, q, pc, it.chipIcon || PILL_ICON[pc] || 'trash');
            }
        }
    });
    cv.noclip();
    if (!v.all.length && o.empty) mid(cv, o.empty, b.x + b.w / 2, b.y + b.h / 2, 36, t.dim, { align: 'center' });
}

// ---- side menu with vector icons and count badges ------------------------------------------------------------
const navItems = (o) => (Array.isArray(o.items) ? o.items
    : lines(o.items).map((l, i) => ({ id: l[0].toLowerCase(), label: l[0], vicon: l[1] || '', badge: l[2] || '' })));
// (the Store: o.labelSize for a narrower menu; the default is the design's)
function sideNav(cv, t, b, o) {
    const items = navItems(o), ih = b.h / Math.max(1, items.length), is = Math.min(68, ih * 0.38), ls = o.labelSize || 34;
    cv.fillRect(b.x, b.y, b.w, b.h, withAlpha(t.panelBottom, 0.85));
    cv.fillRect(b.x + b.w - 1.5, b.y, 1.5, b.h, t.panelEdge);
    items.forEach((it, i) => {
        const y = b.y + i * ih, on = i === (o.sel | 0), c = on ? t.text : t.dim, iy = y + ih * 0.18;
        if (on) {
            W.lit(cv, b.x + 12, y + 8, b.w - 24, ih - 16, 16, mix(t.panelTop, '#ffffff', 0.05));        // the tab chosen: a card, as the rows are
            cv.roundRect(b.x + 8, y + ih * 0.22, 5, ih * 0.56, 2.5, t.text);        // on the box's left edge, 1 px over it
        }
        vicon(cv, it.vicon, b.x + b.w / 2 - is / 2, iy, is, c);
        const ts = W.shrink(cv, String(it.label), b.w - 24, ls, 'label', 0.6);
        cv.text(W.fit(cv, String(it.label), b.w - 24, ts), b.x + b.w / 2, iy + is + ls * 1.47, ts, c, { align: 'center' });
        if (it.badge && String(it.badge) !== '0') {
            // sized with the menu's labels (k: 1 in the design), and kept inside the menu
            const k = ls / 34, r = 26 * k, bx = b.x + b.w / 2 + is * 0.8, by = iy + 6;
            cv.circle(bx, by, r + 3, t.bg); cv.circle(bx, by, r, BLUE);
            cv.text(String(it.badge), bx, by + 12 * k, Math.round(32 * k), '#ffffff', { align: 'center', font: 'bold' });
        }
    });
}

// ---- button with a vector icon -------------------------------------------------------------------------------
/* A raised control: a dark edge around it with a small drop below, a flat face, a light line along its top, a dark
 * one along its bottom and a soft glow just inside its edge. hi: how light the top line is (a share of white).
 * soft: a quieter one, its lines half as wide and its bottom line and drop lighter (the menu's own buttons). */
function raised(cv, x, y, w, h, r, face, hi, soft) {
    const l = Math.max(soft ? 1.5 : 2, Math.min(w, h) * (soft ? 0.02 : 0.04));            // the lines' width, with the control's size
    cv.roundRect(x - 1.5, y - 1.5, w + 3, h + 3 + l, r + 1.5, withAlpha('#000000', soft ? 0.4 : 0.6));
    cv.roundRect(x, y, w, h, r, mix(face, '#000000', soft ? 0.25 : 0.42));
    cv.roundRect(x, y, w, h - l, r, mix(face, '#ffffff', hi));
    cv.roundRect(x, y + l, w, h - 2 * l, r, face);
    cv.strokeRoundRect(x + 1, y + 1, w - 2, h - 2, r - 1, 1.5, withAlpha('#ffffff', hi * 0.3));
}
function vbutton(cv, t, b, o) {
    const c = C(t, o.color, BLUE), s = o.size || Math.round(b.h * 0.34), is = Math.round(b.h * 0.4), r = Math.min(18, b.h / 2);
    const off = o.disabled, plain = mix(t.panelTop, '#ffffff', 0.07), shade = withAlpha('#000000', 0.35);
    if (o.style === 'round') {                       // an icon on a raised rounded square (back, close)
        const d = Math.min(b.w, b.h), g = d * 0.55, sd = Math.max(1.5, g * 0.05);
        raised(cv, b.x + (b.w - d) / 2, b.y + (b.h - d) / 2, d, d, d * 0.28, plain, 0.1, true);
        vicon(cv, o.vicon, b.x + (b.w - g) / 2, b.y + (b.h - g) / 2 + sd, g, shade);
        vicon(cv, o.vicon, b.x + (b.w - g) / 2, b.y + (b.h - g) / 2, g, off ? t.dim : c);
        return;
    }
    // primary: the accent as its face; the others the menu's own face, their label in the text's or the accent's colour;
    // one that is off lies flat
    if (off) cv.roundRect(b.x, b.y, b.w, b.h, r, o.style === 'primary' ? '#232a35' : withAlpha(t.panelTop, 0.6));
    else if (o.style === 'primary') raised(cv, b.x, b.y, b.w, b.h, r, c, 0.42);
    else raised(cv, b.x, b.y, b.w, b.h, r, plain, 0.1, true);
    const fg = off ? t.dim : o.style === 'primary' ? '#ffffff' : o.style === 'outline' ? t.text : c;
    const hasIcon = !!o.vicon, room = b.w - 2 * r - (hasIcon ? is + 18 : 0);
    const ts = W.shrink(cv, String(o.text || ''), room, s, 'bold'), text = W.fit(cv, String(o.text || ''), room, ts, 'bold');
    const tw = cv.textWidth(text, ts, { font: 'bold' }) + (hasIcon ? is + 18 : 0), x1 = b.x + (b.w - tw) / 2;
    // the icon and the label over a tight shadow of themselves, just below
    const sd = Math.max(1.5, ts * 0.06), tx = x1 + (hasIcon ? is + 18 : 0), ty = b.y + b.h / 2 + ts * 0.36;
    if (hasIcon && !off) vicon(cv, o.vicon, x1, b.y + (b.h - is) / 2 + sd, is, shade);
    if (hasIcon) vicon(cv, o.vicon, x1, b.y + (b.h - is) / 2, is, fg);
    if (!off && o.style === 'primary') cv.text(text, tx, ty + 2 * sd, ts, withAlpha('#000000', 0.18), { font: 'bold' });       // and a fainter one further down
    if (!off) cv.text(text, tx, ty + sd, ts, shade, { font: 'bold' });
    cv.text(text, tx, ty, ts, fg, { font: 'bold' });
}

// ---- on-screen keyboard: URLs and tokens (layout 'url'), or words (layout 'text': a space bar) ----------------
const ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ['Delete', 1.3, 'mod']],
    [['Shift', 1.3, 'mod'], 'z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '/'],
    [['https://', 1.6, 'mod'], ['github.com/', 2.1, 'mod'], ['.com', 1.2, 'mod'], ['-', 0.8], ['_', 0.8], [':', 0.8], ['Next', 1.7, 'go']],
];
const TEXT_ROWS = ROWS.slice(0, 3).concat([
    [['Shift', 1.3, 'mod'], 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.'],
    [['-', 0.8], ["'", 0.8], ['Space', 5.2, 'mod'], ['?', 0.8], ['!', 0.8], ['Next', 1.7, 'go']],
]);
// o.symbols (word keyboard only): a '#+=' key opens the symbols page (o.sym), 'abc' goes back - all the printable ASCII
// symbols (a Wi-Fi password may hold any), the digits stay on top
const SYM_KEY = '#+=', ABC_KEY = 'abc';
const TEXT_SYM_ROWS = TEXT_ROWS.slice(0, 4).concat([[[SYM_KEY, 1.3, 'mod'], ["'", 0.8], ['Space', 4.7, 'mod'], ['?', 0.8], ['!', 0.8], ['Next', 1.7, 'go']]]);
const SYM_ROWS = [ROWS[0],
    ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'],
    ['-', '_', '=', '+', '[', ']', '{', '}', '\\', ['Delete', 1.3, 'mod']],
    [';', ':', '"', "'", ',', '.', '/', '<', '>', '?'],
    [[ABC_KEY, 1.3, 'mod'], ['`', 0.8], ['|', 0.8], ['Space', 4.7, 'mod'], ['~', 0.8], ['Next', 1.7, 'go']]];
/** Every key's box: { text, kind, x, y, w, h } (design px). o.layout 'text': the word keyboard (+ o.symbols, o.sym). */
function keyBoxes(b, o) {
    const rows = o && o.layout === 'text' ? (o.symbols ? (o.sym ? SYM_ROWS : TEXT_SYM_ROWS) : TEXT_ROWS) : ROWS;
    const gap = 16, rh = (b.h - gap * (rows.length - 1)) / rows.length, out = [];
    rows.forEach((r, ri) => {
        const ks = r.map((k) => (Array.isArray(k) ? k : [k, 1])), tw = ks.reduce((a, k) => a + k[1], 0), unit = (b.w - gap * (ks.length - 1)) / tw;
        let kx = b.x;
        ks.forEach(([text, wt, kind]) => { out.push({ text, kind, x: kx, y: b.y + ri * (rh + gap), w: unit * wt, h: rh }); kx += unit * wt + gap; });
    });
    return out;
}
// the Enter key says o.go (e.g. 'Search') and types that; default 'Next'
const shown = (k, o) => (k.kind === 'go' ? o.go || k.text : o.shift && !k.kind && /^[a-z]$/.test(k.text) ? k.text.toUpperCase() : k.text);
// what a key says: Space, Delete and Shift in the display language (the key itself stays the English name)
const keyLabel = (s) => ({ Space: tr("Space"), Delete: tr("Delete"), Shift: tr("Shift") })[s] || s;
// a key's flat face, by what the key is for: letters the plain one, digits a step darker, symbols a cool tint, Space
// lighter, the keys that type a piece of an address teal, Shift and the page keys blue (Shift lit while on), Delete
// red, the Enter key the accent
const KEY_FACE = { letter: '#262d3a', digit: '#1d232d', symbol: '#1f2937', space: '#313a4c', piece: '#17302f', mod: '#1b2640',
    shiftOn: '#2f4a80', del: '#38222b', go: BLUE };
function keyFace(k, o) {
    if (k.kind === 'go') return KEY_FACE.go;
    if (k.kind === 'mod') {
        return k.text === 'Space' ? KEY_FACE.space : k.text === 'Delete' ? KEY_FACE.del : k.text === 'Shift' ? (o.shift ? KEY_FACE.shiftOn : KEY_FACE.mod)
            : k.text === SYM_KEY || k.text === ABC_KEY ? KEY_FACE.mod : KEY_FACE.piece;
    }
    return /^[a-z]$/i.test(k.text) ? KEY_FACE.letter : /^[0-9]$/.test(k.text) ? KEY_FACE.digit : KEY_FACE.symbol;
}
function keyboard(cv, t, b, o) {
    keyBoxes(b, o).forEach((k, i) => {
        const face = keyFace(k, o);
        cv.roundRect(k.x, k.y, k.w, k.h, 18, i === o.pressed ? mix(face, '#ffffff', 0.22) : face);
        const label = keyLabel(shown(k, o));
        const font = k.kind ? 'bold' : 'label', size = W.shrink(cv, label, k.w - 16, label.length > 2 ? 38 : 48, font);
        cv.text(W.fit(cv, label, k.w - 16, size, font), k.x + k.w / 2, k.y + k.h / 2 + 17, size, '#ffffff', { align: 'center', font });
    });
}

// ---- sheet: dims the app area, a card on top (other elements sit on it) --------------------------------------
function sheet(cv, t, b, o) {
    const a = o.area || { x: 0, y: 0, w: 2880, h: 960 };
    cv.fillRect(a.x, a.y, a.w, a.h, withAlpha('#000000', o.dim == null ? 0.55 : o.dim));
    // the card: the rows' face, its lit edge a little stronger than theirs
    W.lit(cv, b.x, b.y, b.w, b.h, o.radius == null ? 32 : o.radius, [[0, t.panelTop], [1, mix(t.panelTop, t.panelBottom, 0.72)]], 0.04);
}

const DRAW = { appIcon: appIconEl, chips, appGrid, appList, sideNav, vbutton, keyboard, sheet };

// ---- touch (gpu.js touchElement: Try mode and the app) -------------------------------------------------------
// a drag scrolls with the finger; a release without a drag is a tap. ponytail: one gesture at a time.
let drag = null;
function scroller(view, rowSize) {
    return Object.assign((cv, b, o, p) => {
        const v = view(b, o);
        if (!p.move) { drag = { y0: p.y, top: v.top, moved: false }; return false; }
        const d = drag, dy = d ? p.y - d.y0 : 0, size = rowSize(v);
        if (!d || (!d.moved && Math.abs(dy) < size * 0.25)) return false;
        d.moved = true;
        const nt = Math.max(0, Math.min(v.max, d.top - dy / size));
        if (nt === v.top) return false;
        o.top = nt;
    }, { drag: true });
}
const gridTry = scroller(gridView, (v) => v.th);
gridTry.up = (cv, b, o, p) => {
    const d = drag, g = gridView(b, o);
    drag = null;
    if (!d || d.moved) return false;
    const col = Math.floor((p.x - b.x) / g.tw), row = Math.floor((p.y - b.y) / g.th + g.top), it = g.all[row * g.cols + col];
    if (!it || col < 0 || col >= g.cols) return false;
    tapped(o, it.id, 'tile');
};
const listTry = scroller(listView, (v) => v.rh);
listTry.up = (cv, b, o, p) => {
    const d = drag, v = listView(b, o);
    drag = null;
    if (!d || d.moved) return false;
    const it = v.all[Math.floor((p.y - b.y) / v.rh + v.top)];
    if (!it) return false;
    const rb = rightBoxes(b, it, cv, o.ctlK).find((x) => p.x >= x.x && p.x < x.x + x.w && ['toggle', 'trash', 'chip'].indexOf(x.kind) >= 0);
    tapped(o, it.id, rb ? rb.kind : 'row');
};
const TRY = {
    appGrid: gridTry,
    appList: listTry,
    sideNav: (cv, b, o, p) => {
        const items = navItems(o), i = Math.max(0, Math.min(items.length - 1, Math.floor((p.y - b.y) / (b.h / Math.max(1, items.length)))));
        if (!items.length) return false;
        o.sel = i;
        tapped(o, items[i].id, 'nav');
    },
    keyboard: Object.assign((cv, b, o, p) => {
        const ks = keyBoxes(b), i = ks.findIndex((k) => p.x >= k.x && p.x < k.x + k.w && p.y >= k.y && p.y < k.y + k.h);
        if (i < 0) return false;
        const text = shown(ks[i], o);
        if (text === 'Shift') o.shift = !o.shift;
        o.pressed = i; o.keyN = (o.keyN || 0) + 1; o.key = { text, n: o.keyN };
    }, { up: (cv, b, o) => { if (o.pressed == null) return false; o.pressed = null; } }),
};

// (the Store: shown is what a key types, store_frame.js's items)
module.exports = { DRAW, TRY, appIcon, chip, visibleIds, keyBoxes, shown, gridView, listView, rightBoxes, navItems, GREEN, BLUE, AMBER };
