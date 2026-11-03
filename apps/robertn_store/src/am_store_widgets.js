'use strict';
/*
 * The store's widgets (App Manager 2) for renderer screens: app icons, app grid, lists with pictures, chips, side
 * menu, buttons, on-screen keyboard, sheet. Every icon here is drawn by the renderer - kit/vicons.js vector icons or
 * pictures an app hands over (ScreenApp.setImage -> 'key:<name>') - never the HMI's glyph icons, which differ between
 * iDrive 7 and 8 (widgets.js icon()). Same signature as widgets.js: (cv, t, b, o).
 * Taps reach the app as ScreenApp 'change' events: o.tap = { id, part, n } / o.key = { text, n }, n counting up so a
 * second tap on the same thing is a change too.
 */
const { withAlpha, mix } = require('./kit_canvas.js');
const { vicon } = require('./kit_vicons.js');
const W = require('./am_widgets.js');

const GREEN = '#35d07f', BLUE = '#3d9bff', AMBER = '#ffb020';
const C = (t, c, d) => (c ? t[c] || c : d);
const mid = (cv, s, x, cy, size, c, opts) => cv.text(String(s), x, cy + size * 0.36, size, c, opts);
const lines = (s) => String(s || '').split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((l) => l[0]);
const pair = (s, d) => { const p = String(s || '').split(',').map((x) => x.trim()).filter(Boolean); return p.length >= 2 ? p : d; };
const tapped = (o, id, part) => { o.tapN = (o.tapN || 0) + 1; o.tap = { id, part, n: o.tapN }; };
const BADGE = { installed: [GREEN, 'check'], update: [BLUE, 'arrowDown'], queued: [AMBER, 'clock'] };

/**
 * App icon in the s x s square at (x, y): the picture a.icon names, else a gradient (a.colors) with the vector glyph
 * a.vicon, else the title's first letter. Apps: rounded square; system services (a.kind 'service' or a service kind):
 * round. a.badge: installed | update | queued; a.progress 0..1: a ring (downloading). bg: the colour behind the badge.
 */
function appIcon(cv, t, a, x, y, s, bg) {
    const cx = x + s / 2, cy = y + s / 2, round = a.kind && a.kind !== 'app', c = pair(a.colors, ['#3a4352', '#232a35']);
    const img = a.icon ? W.picture(a.icon) : null;
    if (img) cv.image(img, x, y, s, s, round ? s / 2 : s * 0.24);
    else if (round) {
        cv.circle(cx, cy, s / 2, c[1]); cv.circle(cx, cy, s / 2 - s * 0.06, c[0]); cv.circle(cx, cy, s / 2 - s * 0.12, withAlpha(c[1], 0.55));
    } else {
        cv.card(x, y, s, s, s * 0.24, [[0, c[0]], [1, c[1]]]);
        cv.card(x, y, s, s * 0.5, s * 0.24, [[0, withAlpha('#ffffff', 0.18)], [1, withAlpha('#ffffff', 0)]]);
    }
    if (!img) {
        const g = s * 0.56;
        if (!(a.vicon && vicon(cv, a.vicon, cx - g / 2, cy - g / 2, g, '#ffffff'))) {
            const letter = String(a.letter || a.title || '?').trim()[0] || '?';
            cv.text(letter.toUpperCase(), cx, cy + s * 0.18, Math.round(s * 0.5), '#ffffff', { align: 'center', font: 'bold' });
        }
    }
    if (typeof a.progress === 'number' && a.progress >= 0) {
        const r0 = s / 2 + s * 0.06, r1 = s / 2 + s * 0.1;
        cv.arc(cx, cy, r0, r1, 0, 360, withAlpha('#ffffff', 0.15));
        if (a.progress > 0) cv.arc(cx, cy, r0, r1, 0, 360 * Math.min(1, a.progress), BLUE);
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
    if (o.align === 'right') {
        let x = b.x + b.w;
        for (let i = items.length - 1; i >= 0; i--) x -= chip(cv, items[i].text, x, b.y, b.h, C(t, items[i].color, t.text), items[i].dot, true) + gap;
    } else {
        let x = b.x;
        for (const it of items) x += chip(cv, it.text, x, b.y, b.h, C(t, it.color, t.text), it.dot) + gap;
    }
}

// o.glow: a soft halo of the icon's colour (a picture's: dim) around it; the badge's cut-out takes the halo's colour
function appIconEl(cv, t, b, o) {
    const s = Math.min(b.w, b.h), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let bg = t.bg;
    if (o.glow) {
        const c = o.icon ? t.dim : pair(o.colors, ['#3a4352'])[0], n = 16, a = 0.022, r0 = 0.82, dr = 0.02;
        for (let i = 0; i < n; i++) cv.circle(cx, cy, s * (r0 - i * dr), withAlpha(c, a));
        const d = s * 0.56;                                 // the badge's distance from the centre (appIcon)
        const under = Math.max(0, Math.min(n, Math.ceil((r0 - d / s) / dr)));
        bg = mix(t.bg, c, 1 - Math.pow(1 - a, under));
    }
    appIcon(cv, t, o, cx - s / 2, cy - s / 2, s, bg);
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
        const x = b.x + (i % g.cols) * g.tw, y = b.y + (g.first + Math.floor(i / g.cols) - g.top) * g.th, room = g.tw - 40;
        // each tile on a card in the focus ring's box (store_frame.js), lit from the top by its icon's colour
        const tint = mix(t.panelTop, a.icon ? t.panelEdge : pair(a.colors, ['#3a4352'])[0], 0.22);
        cv.card(x + 8, y, g.tw - 16, g.th - 8, 24, [[0, tint], [0.55, t.panelBottom], [1, t.panelBottom]]);
        cv.strokeRoundRect(x + 8, y, g.tw - 16, g.th - 8, 24, 1.5, t.panelEdge);
        appIcon(cv, t, a, x + (g.tw - s) / 2, y + top, s, tint);
        const ny = y + top + s + gap[0], sy = ny + gap[1];
        cv.text(W.fit(cv, String(a.title || ''), room, ts, 'bold'), x + g.tw / 2, ny, ts, t.text, { align: 'center', font: 'bold' });
        if (a.src) cv.text(fitSource(cv, String(a.src), room, rs), x + g.tw / 2, sy, rs, t.dim, { align: 'center' });
        if (a.sub) cv.text(W.fit(cv, String(a.sub), room, ss), x + g.tw / 2, sy + gap[2], ss, C(t, a.subColor, t.dim), { align: 'center' });
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
function listView(b, o) {
    const rh = o.rowH || 120, all = rowItems(o), n = b.h / rh, max = Math.max(0, all.length - n), top = Math.max(0, Math.min(max, +o.top || 0));
    return { rh, all, n, max, top, first: Math.floor(top), end: Math.min(all.length, Math.ceil(top + n)) };
}
// the right-hand controls of a row ("toggle:on+trash": laid out from the right) -> [{ kind, arg, x, w }]
const RIGHT_W = { chevron: 60, trash: 80, toggle: 150 };
// (the Store: c scales the controls of a smaller row, o.ctlK)
function rightBoxes(b, it, cv, c) {
    let x = b.x + b.w;
    const k = c || 1;
    return String(it.right || '').split('+').filter(Boolean).reverse().map((r) => {
        const kind = r.split(':')[0], arg = r.slice(kind.length + 1);
        const w = (kind === 'chip' ? cv.textWidth(arg, 26 * k) + 54 * k : (RIGHT_W[kind] || 0) * k) + 24 * k;
        x -= w;
        return { kind, arg, x, w };
    });
}
// (the Store: o.titleSize, o.subSize and o.ctlK size a smaller row's texts and controls; the defaults are the design's)
function appList(cv, t, b, o) {
    const v = listView(b, o), gap = Math.round(v.rh * 0.13), q = o.ctlK || 1, ts = o.titleSize || 40, ss = o.subSize || 30;
    cv.clip(b.x, b.y, b.w, b.h);
    v.all.slice(v.first, v.end).forEach((it, k) => {
        const y = b.y + (v.first + k - v.top) * v.rh, h = v.rh - gap, s = Math.round(h * 0.73);
        cv.card(b.x, y, b.w, h, 22 * q, [[0, t.panelTop], [1, t.panelBottom]]);
        let tx = b.x + 28 * q;
        if (it.icon || it.vicon || it.colors || it.letter) {
            if (it.plain && it.vicon) vicon(cv, it.vicon, b.x + 28 * q, y + (h - s) / 2, s, C(t, it.iconColor, t.text));
            else appIcon(cv, t, it, b.x + 22 * q, y + (h - s) / 2, s, t.panelTop);
            tx = b.x + 22 * q + s + 32 * q;
        }
        const boxes = rightBoxes(b, it, cv, q), room = (boxes.length ? boxes[boxes.length - 1].x : b.x + b.w) - tx - 8;
        cv.text(W.fit(cv, String(it.title || ''), room, ts, 'bold'), tx, it.sub ? y + h * 0.47 : y + h / 2 + ts * 0.36, ts, t.text, { font: 'bold' });
        if (it.sub) cv.text(W.fit(cv, String(it.sub), room, ss), tx, y + h * 0.83, ss, C(t, it.subColor, t.dim));
        const cy = y + h / 2;
        for (const rb of boxes) {
            const re = rb.x + rb.w - 24 * q;                // the control's right edge
            if (rb.kind === 'chevron') W.chevron(cv, re - 28 * q, cy, 22 * q, 'right', 4 * q, t.dim);
            else if (rb.kind === 'trash') vicon(cv, 'trash', re - 66 * q, cy - 30 * q, 60 * q, t.dim);
            else if (rb.kind === 'toggle') {
                const on = rb.arg === 'on', tw = 150 * q, th = 76 * q, tx0 = re - tw;
                cv.roundRect(tx0, cy - th / 2, tw, th, th / 2, on ? GREEN : '#3a4352');
                cv.circle(on ? tx0 + tw - th / 2 : tx0 + th / 2, cy, th / 2 - 8 * q, '#ffffff');
            } else if (rb.kind === 'chip') chip(cv, rb.arg, re, cy - 30 * q, 60 * q, C(t, it.chipColor, BLUE), it.chipDot, true);
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
            cv.card(b.x + 8, y + 8, b.w - 24, ih - 16, 16, [[0, withAlpha('#ffffff', 0.16)], [1, withAlpha('#ffffff', 0.04)]]);
            cv.roundRect(b.x + 8, y + ih * 0.22, 6, ih * 0.56, 3, t.text);
        }
        vicon(cv, it.vicon, b.x + b.w / 2 - is / 2, iy, is, c);
        cv.text(String(it.label), b.x + b.w / 2, iy + is + ls * 1.47, ls, c, { align: 'center' });
        if (it.badge && String(it.badge) !== '0') {
            const bx = b.x + b.w / 2 + is * 0.97, by = iy + 6;
            cv.circle(bx, by, 30, t.bg); cv.circle(bx, by, 26, BLUE);
            cv.text(String(it.badge), bx, by + 12, 32, '#ffffff', { align: 'center', font: 'bold' });
        }
    });
}

// ---- button with a vector icon -------------------------------------------------------------------------------
function vbutton(cv, t, b, o) {
    const c = C(t, o.color, BLUE), s = o.size || Math.round(b.h * 0.34), is = Math.round(b.h * 0.4), r = Math.min(18, b.h / 2);
    const off = o.disabled;
    if (o.style === 'round') {                       // an icon on a soft disc (back, close)
        const d = Math.min(b.w, b.h), g = d * 0.55;
        cv.circle(b.x + b.w / 2, b.y + b.h / 2, d / 2, withAlpha(off ? t.dim : c, 0.14));
        vicon(cv, o.vicon, b.x + (b.w - g) / 2, b.y + (b.h - g) / 2, g, off ? t.dim : c);
        return;
    }
    if (o.style === 'primary') cv.card(b.x, b.y, b.w, b.h, r, off ? [[0, '#2a3341'], [1, '#232a35']] : [[0, c], [1, withAlpha(c, 0.78)]]);
    else cv.strokeRoundRect(b.x, b.y, b.w, b.h, r, 3, off ? t.panelEdge : o.style === 'outline' ? withAlpha(t.text, 0.6) : withAlpha(c, 0.6));
    const fg = off ? t.dim : o.style === 'primary' ? '#ffffff' : o.style === 'outline' ? t.text : c;
    const hasIcon = !!o.vicon, tw = cv.textWidth(String(o.text || ''), s, { font: 'bold' }) + (hasIcon ? is + 18 : 0), x1 = b.x + (b.w - tw) / 2;
    if (hasIcon) vicon(cv, o.vicon, x1, b.y + (b.h - is) / 2, is, fg);
    cv.text(String(o.text || ''), x1 + (hasIcon ? is + 18 : 0), b.y + b.h / 2 + s * 0.36, s, fg, { font: 'bold' });
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
function keyboard(cv, t, b, o) {
    keyBoxes(b, o).forEach((k, i) => {
        const press = i === o.pressed;
        const fill = k.kind === 'go' ? [[0, '#5fb4ff'], [1, '#1f5fd0']] : press ? [[0, '#4a5568'], [1, '#3a4352']]
            : k.kind === 'mod' ? (k.text === 'Shift' && o.shift ? [[0, '#3d4a5e'], [1, '#2e3949']] : [[0, '#232b38'], [1, '#18202b']]) : [[0, '#2a3341'], [1, '#1d2430']];
        cv.card(k.x, k.y, k.w, k.h, 18, fill);
        const label = shown(k, o);
        cv.text(label, k.x + k.w / 2, k.y + k.h / 2 + 17, label.length > 2 ? 38 : 48, '#ffffff', { align: 'center', font: k.kind ? 'bold' : 'label' });
    });
}

// ---- sheet: dims the app area, a card on top (other elements sit on it) --------------------------------------
function sheet(cv, t, b, o) {
    const a = o.area || { x: 0, y: 0, w: 2880, h: 960 };
    cv.fillRect(a.x, a.y, a.w, a.h, withAlpha('#000000', o.dim == null ? 0.55 : o.dim));
    cv.card(b.x, b.y, b.w, b.h, o.radius == null ? 32 : o.radius, [[0, '#1e2632'], [1, '#121820']]);
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
