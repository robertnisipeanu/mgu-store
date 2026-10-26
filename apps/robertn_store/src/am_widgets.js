'use strict';
/*
 * App-style widgets for renderer screens: buttons, switches, sliders, tabs, tiles, cards, rows, menus, colour
 * picker, ... Drawn with the kit's canvas API only (kit/canvas.js / kit/record.js), so the same calls record
 * for mgu-renderd and play back in software. No builder code in here: a car app can draw screens.json with it.
 * Every widget: (cv, t, b, o) - surface, kit theme, box { x, y, w, h } in design pixels, options.
 * Icons: none of the HMI's (see icon()); the store's widgets draw kit_vicons.js vector icons and package pictures.
 */
const { withAlpha, mix } = require('./kit_canvas.js');
const png = require('./kit_png.js');
const { makeImage, dropImage } = require('./kit_record.js');

// The Store takes no HMI icons (his kit/fonts/icon.json is baked from the HMI's own and stays out): an element
// naming one draws nothing there, as with an unknown name.
const ICONS = [];
const HUES = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'];

const C = (t, c, d) => (c ? t[c] || c : d);
const isNum = (x) => typeof x === 'number' && isFinite(x);
const fmt = (v, d) => (isNum(v) ? v.toFixed(d || 0) : '--');
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const frac = (o) => {
    const lo = isNum(o.min) ? o.min : 0, hi = isNum(o.max) ? o.max : 100;
    return hi > lo && isNum(o.value) ? Math.max(0, Math.min(1, (o.value - lo) / (hi - lo))) : 0;
};
const mid = (cv, s, x, cy, size, c, opts) => cv.text(String(s), x, cy + size * 0.36, size, c, opts);   // text centred on cy

/** An HMI icon: none in the Store (see ICONS); false, as for an unknown name. */
function icon() {
    return false;
}

/** Chevron centred on (cx, cy), s across; dir right | left | up | down. */
function chevron(cv, cx, cy, s, dir, width, c) {
    const d = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] }[dir] || [1, 0];
    const h = s / 2, q = s / 4, tx = cx + d[0] * q, ty = cy + d[1] * q, bx = cx - d[0] * q, by = cy - d[1] * q;
    cv.line(bx - d[1] * h, by + d[0] * h, tx, ty, width, c);
    cv.line(bx + d[1] * h, by - d[0] * h, tx, ty, width, c);
}

/** s as it is when it fits w, else cut with … (text never runs out of its box) */
function fit(cv, s, w, size, font) {
    s = String(s);
    if (cv.textWidth(s, size, { font }) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, m) + '…', size, { font }) <= w) lo = m; else hi = m - 1; }
    return s.slice(0, lo).replace(/\s+$/, '') + '…';
}

/** Words wrapped into w, from top y; at most max lines (the last one cut with …). Returns the lines drawn. */
function wrap(cv, s, x, y, w, size, c, max, font) {
    let line = '', n = 0;
    const put = (l) => cv.text(fit(cv, l, w, size, font), x, y + size * 0.95 + n++ * size * 1.25, size, c, { font });
    for (const word of String(s || '').split(/\s+/).filter(Boolean)) {
        const next = line ? line + ' ' + word : word;
        if (line && cv.textWidth(next, size, { font }) > w) { if (n === max - 1) { put(line + '…'); return n; } put(line); line = word; } else line = next;
    }
    if (line) put(line);
    return n;
}

/** Card background in the app style; sel = highlighted (accent edge, tint and glow). */
function surface(cv, t, x, y, w, h, r, sel, acc) {
    if (sel) for (let k = 3; k >= 1; k--) cv.strokeRoundRect(x - k * 3, y - k * 3, w + k * 6, h + k * 6, r + k * 3, 3, withAlpha(acc, 0.06 * (4 - k)));
    cv.card(x, y, w, h, r, sel ? [[0, mix(t.panelTop, acc, 0.2)], [1, mix(t.panelBottom, acc, 0.06)]] : [[0, t.panelTop], [1, t.panelBottom]]);
    cv.strokeRoundRect(x, y, w, h, r, sel ? 2.5 : 1.5, sel ? acc : t.panelEdge);
}

/** icon + text centred on (cx, cy) */
function content(cv, cx, cy, ic, text, sz, c, font) {
    const is = ic && CP.has(String(ic).toUpperCase()) ? Math.round(sz * 1.35) : 0, gap = is && text ? sz * 0.4 : 0;
    const tw = text ? cv.textWidth(text, sz, { font }) : 0, x0 = cx - (is + gap + tw) / 2;
    if (is) icon(cv, ic, x0, cy - is / 2, is, c);
    if (text) mid(cv, text, x0 + is + gap, cy, sz, c, { font });
}

function button(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), r = Math.min(o.radius == null ? 16 : o.radius, b.h / 2), sz = o.size || Math.round(b.h * 0.36);
    let fg = t.text;
    if (o.style === 'primary') { cv.card(b.x, b.y, b.w, b.h, r, [[0, mix(acc, '#ffffff', 0.12)], [1, mix(acc, '#000000', 0.22)]]); fg = '#ffffff'; }
    else if (o.style === 'secondary') { cv.roundRect(b.x, b.y, b.w, b.h, r, withAlpha(t.panelTop, 0.9)); cv.strokeRoundRect(b.x, b.y, b.w, b.h, r, 2, t.panelEdge); }
    else if (o.style === 'outline') { cv.roundRect(b.x, b.y, b.w, b.h, r, withAlpha(acc, 0.08)); cv.strokeRoundRect(b.x, b.y, b.w, b.h, r, 2, acc); fg = acc; }
    else fg = acc;                                                                                   // ghost: text only
    content(cv, b.x + b.w / 2, b.y + b.h / 2, o.icon, o.text, sz, fg, 'bold');
}

function roundButton(cv, t, b, o) {
    const r = Math.min(b.w, b.h) / 2, cx = b.x + b.w / 2, cy = b.y + b.h / 2, acc = C(t, o.color, t.accent);
    if (o.glow) {
        cv.circle(cx, cy, r * 1.25, withAlpha(acc, 0.07));
        for (let k = 1; k <= 3; k++) cv.arc(cx, cy, r * (1 + 0.18 * k) - 1.5, r * (1 + 0.18 * k), 0, 360, withAlpha(acc, 0.45 / k));
    }
    let fg = t.text;
    if (o.style === 'filled') { cv.circle(cx, cy, r, acc); fg = '#ffffff'; }
    else if (o.style === 'tinted') { cv.circle(cx, cy, r, withAlpha(acc, 0.22)); fg = acc; }
    else if (o.style === 'ring') { cv.circle(cx, cy, r, withAlpha(acc, 0.18)); cv.arc(cx, cy, r - 3, r, 0, 360, acc); }
    else cv.arc(cx, cy, r - 2, r, 0, 360, t.dim);                                                  // outline
    const is = Math.round(r * 1.1);
    if (!icon(cv, o.icon, cx - is / 2, cy - is / 2, is, fg)) chevron(cv, cx + r * 0.08, cy, r * 0.62, 'right', Math.max(2.5, r * 0.09), fg);
}

function toggle(cv, t, b, o) {
    const h = Math.min(b.h, b.w / 1.8), w = h * 1.8, x = b.x, y = b.y + (b.h - h) / 2, acc = C(t, o.color, t.accent);
    if (o.on) cv.card(x, y, w, h, h / 2, [[0, mix(acc, '#ffffff', 0.1)], [1, mix(acc, '#000000', 0.15)]]);
    else { cv.roundRect(x, y, w, h, h / 2, t.track); cv.strokeRoundRect(x, y, w, h, h / 2, 1.5, t.panelEdge); }
    cv.circle(o.on ? x + w - h / 2 : x + h / 2, y + h / 2, h / 2 - Math.max(3, h * 0.1), o.on ? '#ffffff' : mix(t.text, t.track, 0.3));
}

/** Slider track x, w (knob centre runs along it), knob radius, value text + its size and room. */
function sliderTrack(cv, b, o) {
    const vs = Math.round(b.h * 0.45), txt = fmt(o.value, o.decimals) + (o.unit || '');
    const tw = o.showValue ? Math.max(b.h * 1.6, cv.textWidth(txt, vs) + b.h * 0.4) : 0, kr = b.h * 0.27;
    return { x: b.x + kr, w: b.w - tw - 2 * kr, kr, vs, txt, tw };
}

function slider(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), f = frac(o), { x, w, kr, vs, txt, tw } = sliderTrack(cv, b, o);
    const th = Math.max(4, b.h * 0.13), cy = b.y + b.h / 2;
    cv.roundRect(x, cy - th / 2, w, th, th / 2, t.track);
    cv.roundRect(x, cy - th / 2, Math.max(th, w * f), th, th / 2, acc);
    cv.circle(x + w * f, cy + 2, kr + 1, withAlpha('#000000', 0.35));
    cv.circle(x + w * f, cy, kr, '#ffffff');
    if (tw) mid(cv, txt, b.x + b.w, cy, vs, t.text, { align: 'right' });
}

function dropdown(cv, t, b, o) {
    const r = Math.min(14, b.h / 2), sz = o.size || Math.round(b.h * 0.4);
    cv.roundRect(b.x, b.y, b.w, b.h, r, withAlpha(t.panelBottom, 0.92));
    cv.strokeRoundRect(b.x, b.y, b.w, b.h, r, 1.5, t.panelEdge);
    let x = b.x + b.h * 0.35;
    if (icon(cv, o.icon, x, b.y + b.h * 0.2, b.h * 0.6, t.dim)) x += b.h * 0.75;
    mid(cv, o.text, x, b.y + b.h / 2, sz, t.text);
    chevron(cv, b.x + b.w - b.h * 0.5, b.y + b.h / 2, b.h * 0.24, o.open ? 'up' : 'down', 2.5, t.dim);
}

/** Tab cells: count, gap between them, cell width. */
function tabCells(b, o) {
    const n = list(o.items).length || 1, gap = o.style === 'chips' ? Math.round(b.h * 0.25) : 0;
    return { n, gap, cw: (b.w - gap * (n - 1)) / n };
}

function tabs(cv, t, b, o) {
    const items = list(o.items), acc = C(t, o.color, t.accent), sz = o.size || Math.round(b.h * 0.34);
    const style = o.style || 'joined', { gap, cw } = tabCells(b, o), r = Math.min(12, b.h / 2);
    if (style === 'joined') { cv.roundRect(b.x, b.y, b.w, b.h, r, withAlpha(t.panelBottom, 0.92)); cv.strokeRoundRect(b.x, b.y, b.w, b.h, r, 1.5, t.panelEdge); }
    if (style === 'underline') cv.fillRect(b.x, b.y + b.h - 2, b.w, 2, t.panelEdge);
    items.forEach((s, i) => {
        const x = b.x + i * (cw + gap), on = i === (o.sel | 0);
        if (style === 'chips' && !on) { cv.roundRect(x, b.y, cw, b.h, r, withAlpha(t.panelTop, 0.9)); cv.strokeRoundRect(x, b.y, cw, b.h, r, 1.5, t.panelEdge); }
        if (on && style === 'underline') cv.roundRect(x + cw * 0.15, b.y + b.h - 5, cw * 0.7, 5, 2.5, acc);
        else if (on) { cv.card(x, b.y, cw, b.h, r, [[0, withAlpha(acc, 0.32)], [1, withAlpha(acc, 0.12)]]); cv.strokeRoundRect(x, b.y, cw, b.h, r, 2, acc); }
        else if (style === 'joined' && i) cv.fillRect(x, b.y + b.h * 0.22, 1.5, b.h * 0.56, t.panelEdge);
        mid(cv, s, x + cw / 2, b.y + b.h / 2, sz, on ? t.text : t.dim, { align: 'center', font: on ? 'bold' : 'label' });
    });
}

/** Text box: o.label = small label inside, top; caret = typing cursor; focus = accent edge. */
function field(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), r = Math.min(14, b.h / 2), sz = o.size || Math.round(b.h * (o.label ? 0.3 : 0.36)), p = Math.round(b.h * 0.25);
    cv.roundRect(b.x, b.y, b.w, b.h, r, withAlpha(t.panelBottom, 0.92));
    cv.strokeRoundRect(b.x, b.y, b.w, b.h, r, o.focus ? 2 : 1.5, o.focus ? acc : t.panelEdge);
    const al = o.align === 'center' ? 'center' : 'left', ax = al === 'center' ? b.x + b.w / 2 : b.x + p;
    let base = b.y + b.h / 2 + sz * 0.36;
    if (o.label) { const ls = Math.max(16, Math.round(sz * 0.62)); cv.text(o.label, ax, b.y + p * 0.5 + ls, ls, t.dim, { align: al }); base = b.y + b.h - p * 0.7; }
    const w = cv.text(String(o.text || ''), ax, base, sz, t.text, { align: al });
    if (o.caret) cv.fillRect((al === 'center' ? ax + w / 2 : ax + w) + 4, base - sz * 0.8, 2.5, sz * 0.95, acc);
}

function card(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), r = o.radius == null ? 20 : o.radius, ts = o.size || 34, p = 28, cy = b.y + p + ts * 0.45;
    surface(cv, t, b.x, b.y, b.w, b.h, r, o.selected, acc);
    if (o.title) {
        const tw = mid(cv, o.title, b.x + p, cy, ts, t.text, { font: 'bold' });
        if (o.badge) {
            const bs = Math.round(ts * 1.05), bw = Math.max(bs, cv.textWidth(o.badge, ts * 0.6, { font: 'bold' }) + 20), bx = b.x + p + tw + 16;
            cv.roundRect(bx, cy - bs / 2, bw, bs, bs / 2, acc);
            mid(cv, o.badge, bx + bw / 2, cy, Math.round(ts * 0.6), '#ffffff', { align: 'center', font: 'bold' });
        }
    }
    if (o.link) {
        const ls = Math.round(ts * 0.7);
        chevron(cv, b.x + b.w - p - ls * 0.15, cy, ls * 0.6, 'right', 2.5, t.dim);
        mid(cv, o.link, b.x + b.w - p - ls * 0.7, cy, ls, t.dim, { align: 'right' });
    }
}

/** Menu tile: icon, title, text, arrow button. layout side (icon left) | stacked (icon above). */
function tile(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), p = Math.round(Math.min(b.w, b.h) * 0.12), ar = Math.round(Math.min(b.w, b.h) * 0.1);
    const ts = o.size || Math.round(Math.min(b.h * 0.13, b.w * 0.07));
    surface(cv, t, b.x, b.y, b.w, b.h, 24, o.selected, acc);
    let tx, ty;
    if (o.layout === 'stacked') {
        const is = Math.round(b.h * 0.34);
        icon(cv, o.icon, b.x + p, b.y + p, is, acc);
        tx = b.x + p; ty = b.y + p + is + ts * 1.3;
    } else {
        const is = Math.round(Math.min(b.h - 2 * p, b.w * 0.34));
        icon(cv, o.icon, b.x + p * 0.8, b.y + (b.h - is) / 2, is, acc);
        tx = b.x + p * 1.4 + is; ty = b.y + p + ts;
    }
    cv.text(String(o.title || ''), tx, ty, ts, t.text, { font: 'bold' });
    if (o.sub) wrap(cv, o.sub, tx, ty + ts * 0.35, b.x + b.w - p - tx - (o.layout === 'stacked' ? 2 * ar : 0), Math.round(ts * 0.72), t.dim, 2);
    if (o.arrow) roundButton(cv, t, { x: b.x + b.w - p * 0.8 - 2 * ar, y: b.y + b.h - p * 0.8 - 2 * ar, w: 2 * ar, h: 2 * ar }, { style: 'tinted', color: o.color });
}

/** Choice card (one of a few options): icon, big title, text; selected = highlighted. */
function choice(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), cx = b.x + b.w / 2, is = Math.round(b.h * 0.46), ts = o.size || Math.round(b.h * 0.15);
    surface(cv, t, b.x, b.y, b.w, b.h, 22, o.selected, acc);
    icon(cv, o.icon, cx - is / 2, b.y + b.h * 0.07, is, o.selected ? acc : t.dim);
    const ty = b.y + b.h * 0.07 + is + ts * 0.95;
    cv.text(String(o.title || ''), cx, ty, ts, t.text, { align: 'center', font: 'bold' });
    if (o.sub) cv.text(o.sub, cx, ty + ts * 0.85, Math.round(ts * 0.5), t.dim, { align: 'center' });
}

/** Box of a settings row's slider control. */
function rowSlider(b, o) {
    const h = b.h, R = b.x + b.w - (o.boxed ? Math.round(h * 0.22) : 8);
    return { x: R - b.w * 0.45, y: b.y + h / 2 - h * 0.25, w: b.w * 0.45, h: h * 0.5 };
}

/** Settings row: icon, text (+ small line), a control on the right. */
function row(cv, t, b, o) {
    const sz = o.size || Math.round(b.h * 0.3), cy = b.y + b.h / 2, h = b.h, p = Math.round(h * 0.22);
    if (o.boxed) surface(cv, t, b.x, b.y, b.w, b.h, 16, false, t.accent);
    else if (o.divider) cv.fillRect(b.x, b.y + b.h - 1.5, b.w, 1.5, t.panelEdge);
    let x = b.x + (o.boxed ? p : 8);
    const is = Math.round(h * 0.5);
    if (icon(cv, o.icon, x, cy - is / 2, is, t.dim)) x += is + p;
    if (o.sub) { cv.text(String(o.label || ''), x, cy - sz * 0.15, sz, t.text); cv.text(o.sub, x, cy + sz, Math.round(sz * 0.78), C(t, o.subColor, t.dim)); }
    else mid(cv, o.label || '', x, cy, sz, t.text);
    const R = b.x + b.w - (o.boxed ? p : 8);
    if (o.control === 'toggle') toggle(cv, t, { x: R - h * 0.9, y: cy - h * 0.25, w: h * 0.9, h: h * 0.5 }, o);
    else if (o.control === 'dropdown') dropdown(cv, t, { x: R - b.w * 0.3, y: cy - h * 0.32, w: b.w * 0.3, h: h * 0.64 }, { text: o.text });
    else if (o.control === 'slider') slider(cv, t, rowSlider(b, o), Object.assign({}, o, { showValue: true }));
    else if (o.control === 'value') mid(cv, o.text || '', R, cy, sz, t.dim, { align: 'right' });
    else if (o.control === 'chevron') {
        chevron(cv, R - sz * 0.3, cy, sz * 0.6, 'right', 3, t.dim);
        if (o.text) mid(cv, o.text, R - sz * 1.1, cy, sz, t.dim, { align: 'right' });
    } else if (o.control === 'button') roundButton(cv, t, { x: R - h * 0.64, y: cy - h * 0.32, w: h * 0.64, h: h * 0.64 }, { icon: o.buttonIcon, style: 'outline' });
}

const railItems = (o) => String(o.items || '').split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((l) => l[0]);

/** Side (or bottom) menu: o.items = lines "Label, icon"; sel = highlighted item. */
function navRail(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), vert = o.direction !== 'horizontal';
    const its = railItems(o), n = its.length || 1;
    if (o.panel) {
        cv.fillRect(b.x, b.y, b.w, b.h, withAlpha(t.panelBottom, 0.85));
        if (vert) cv.fillRect(b.x + b.w - 1.5, b.y, 1.5, b.h, t.panelEdge); else cv.fillRect(b.x, b.y, b.w, 1.5, t.panelEdge);
    }
    its.forEach(([label, ic], i) => {
        const c = vert ? { x: b.x, y: b.y + i * b.h / n, w: b.w, h: b.h / n } : { x: b.x + i * b.w / n, y: b.y, w: b.w / n, h: b.h };
        const on = i === (o.sel | 0), m = 8;
        if (on) {
            cv.card(c.x + m, c.y + m, c.w - 2 * m, c.h - 2 * m, 14, [[0, withAlpha(acc, 0.26)], [1, withAlpha(acc, 0.06)]]);
            if (vert) cv.roundRect(c.x + m, c.y + c.h * 0.22, 5, c.h * 0.56, 2.5, acc);
            else cv.roundRect(c.x + c.w * 0.25, c.y + c.h - m - 5, c.w * 0.5, 5, 2.5, acc);
        }
        const sz = o.size || Math.round(Math.min(c.h * 0.15, c.w * 0.13)), is = Math.round(Math.min(c.h * 0.36, c.w * 0.4));
        const top = c.y + (c.h - is - sz * 1.5) / 2;
        icon(cv, ic, c.x + (c.w - is) / 2, top, is, on ? acc : t.dim);
        cv.text(label, c.x + c.w / 2, top + is + sz * 1.3, sz, on ? acc : t.dim, { align: 'center' });
    });
}

/** App title bar: page title, right text. */
function titleBar(cv, t, b, o) {
    const ts = o.size || Math.round(b.h * 0.34), cy = b.y + b.h / 2, p = 40;
    if (o.line) cv.fillRect(b.x, b.y + b.h - 2, b.w, 2, t.panelEdge);
    if (o.title) mid(cv, o.title, b.x + p, cy, ts, t.text);
    if (o.right) mid(cv, o.right, b.x + b.w - p, cy, Math.round(ts * 0.9), t.text, { align: 'right' });
}

/** Metric card: icon + label, big value + unit, optional bar with its top value. */
function metric(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), p = Math.round(Math.min(b.w, b.h) * 0.1), ls = Math.max(18, Math.round(b.h * 0.11));
    surface(cv, t, b.x, b.y, b.w, b.h, 18, false, acc);
    const ly = b.y + p + ls, is = Math.round(ls * 1.6);
    let lx = b.x + p;
    if (icon(cv, o.icon, lx, ly - ls * 0.36 - is / 2, is, t.dim)) lx += is + 10;
    cv.text(String(o.label || ''), lx, ly, ls, t.dim);
    const vs = o.size || Math.round(b.h * (o.bar ? 0.3 : 0.4)), vy = ly + ls * 0.5 + vs * 0.85;
    const vw = cv.text(fmt(o.value, o.decimals), b.x + p, vy, vs, t.text, { font: 'num' });
    if (o.unit) cv.text(o.unit, b.x + p + vw + vs * 0.1, vy, Math.round(vs * 0.42), t.dim);
    if (o.bar) {
        const bh = Math.max(5, Math.round(b.h * 0.035)), by = b.y + b.h - p - ls * 0.9, bw = b.w - 2 * p;
        cv.roundRect(b.x + p, by, bw, bh, bh / 2, t.track);
        cv.roundRect(b.x + p, by, Math.max(bh, bw * frac(o)), bh, bh / 2, acc);
        cv.text(fmt(o.max, o.decimals) + (o.unit ? ' ' + o.unit : ''), b.x + b.w - p, by + bh + ls * 0.95, Math.round(ls * 0.8), t.dim, { align: 'right' });
    }
}

/** Labelled progress bar: label, right text, small line, bar, percent. */
function progress(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), sz = o.size || Math.round(b.h * 0.24), f = frac(o);
    cv.text(String(o.label || ''), b.x, b.y + sz, sz, t.text);
    if (o.right) cv.text(o.right, b.x + b.w, b.y + sz, Math.round(sz * 0.9), t.dim, { align: 'right' });
    if (o.sub) cv.text(o.sub, b.x, b.y + sz * 2.3, Math.round(sz * 0.8), t.dim);
    const bh = Math.max(6, Math.round(b.h * 0.1)), by = b.y + b.h - bh - sz * 0.2, ps = Math.round(sz * 0.9);
    const w = b.w - (o.percent ? cv.textWidth('100%', ps) + 24 : 0);
    cv.roundRect(b.x, by, w, bh, bh / 2, t.track);
    if (f > 0) cv.rampRect(b.x, by, Math.max(bh, w * f), bh, bh / 2, [mix(acc, '#000000', 0.35), acc], b.x, w);
    if (o.percent) mid(cv, Math.round(f * 100) + '%', b.x + b.w, by + bh / 2, ps, t.text, { align: 'right' });
}

/** Swatch circles: colours, diameter, first centre x, step to the next one. */
function swatchRow(b, o) {
    const cs = list(o.colors), n = cs.length + (o.add ? 1 : 0);
    const d = Math.min(b.h - 12, b.w / Math.max(1, n) / 1.3), step = n > 1 ? Math.min(d * 1.6, (b.w - d - 12) / (n - 1)) : 0;
    return { cs, d, x0: b.x + 6 + d / 2, step };
}

function swatches(cv, t, b, o) {
    const { cs, d, x0, step } = swatchRow(b, o), cy = b.y + b.h / 2;
    let cx = x0;
    cs.forEach((c, i) => {
        if (i === o.sel) { cv.arc(cx, cy, d / 2 + 2, d / 2 + 5, 0, 360, t.text); cv.circle(cx, cy, d / 2 - 2, C(t, c, '#ffffff')); } else cv.circle(cx, cy, d / 2, C(t, c, '#ffffff'));
        cx += step;
    });
    if (o.add) {
        const s = d * 0.18;
        cv.arc(cx, cy, d / 2 - 2, d / 2, 0, 360, t.panelEdge);
        cv.line(cx - s, cy, cx + s, cy, 2.5, t.dim); cv.line(cx, cy - s, cx, cy + s, 2.5, t.dim);
    }
}

function hsv(hex) {
    const v = parseInt(hex, 16), r = (v >> 16 & 255) / 255, g = (v >> 8 & 255) / 255, b = (v & 255) / 255;
    const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
    const h = !d ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, mx ? d / mx : 0, mx];
}
const pureHue = (h) => [5, 3, 1].map((n) => { const k = (n + h / 60) % 6; return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)))); }).concat(255);

/** Colour picker showing o.value: saturation / brightness square, hue bar, R G B + hex boxes and a swatch. */
function colorPicker(cv, t, b, o) {
    const hex = /^#?[0-9a-f]{6}$/i.test(o.value || '') ? o.value.replace('#', '') : '783cfe', [h, s, v] = hsv(hex), col = '#' + hex;
    const fh = o.fields ? Math.round(Math.max(56, b.h * 0.12)) : 0, hb = Math.round(Math.max(16, b.h * 0.035)), gap = Math.round(Math.max(16, b.h * 0.05));
    const sh = b.h - hb - gap - (fh ? fh + gap : 0), r = 14;
    cv.rampRect(b.x, b.y, b.w, sh, r, ['#ffffff', pureHue(h)]);
    cv.card(b.x, b.y, b.w, sh, r, [[0, '#00000000'], [1, '#000000']]);
    const kx = b.x + s * b.w, ky = b.y + (1 - v) * sh;
    cv.arc(kx, ky, 12, 16, 0, 360, '#ffffff'); cv.circle(kx, ky, 12, col);
    const hy = b.y + sh + gap, hx = b.x + b.w * h / 360;
    cv.rampRect(b.x, hy, b.w, hb, hb / 2, HUES);
    cv.circle(hx, hy + hb / 2, hb, '#ffffff'); cv.circle(hx, hy + hb / 2, hb - 4, pureHue(h));
    if (!fh) return;
    const fy = hy + hb + gap, g = 14, cw = (b.w - fh - 4 * g) / 5;
    ['R', 'G', 'B'].forEach((k, i) => field(cv, t, { x: b.x + i * (cw + g), y: fy, w: cw, h: fh },
        { label: k, text: String(parseInt(hex.slice(i * 2, i * 2 + 2), 16)), align: 'center' }));
    field(cv, t, { x: b.x + 3 * (cw + g), y: fy, w: cw * 2, h: fh }, { text: '#' + hex.toUpperCase(), align: 'center' });
    cv.roundRect(b.x + b.w - fh, fy, fh, fh, 12, col);
}

/** Voice waveform: bars, taller towards the middle; gap = empty middle part (for a mic button). */
function waveform(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), n = Math.max(4, o.bars | 0), bw = b.w / n, cy = b.y + b.h / 2, ph = o.phase || 0;
    const gap = Math.max(0, Math.min(0.5, +o.gap || 0)), lv = isNum(o.level) ? o.level : 0.8;
    for (let i = 0; i < n; i++) {
        const d = Math.abs((i + 0.5) / n - 0.5);
        if (d < gap / 2) continue;
        const near = 1 - (d - gap / 2) / (0.5 - gap / 2);                       // 1 next to the middle, 0 at the ends
        const k = Math.abs(Math.sin(i * 1.93 + ph) * 0.6 + Math.sin(i * 0.71 - ph * 0.7) * 0.4);
        const hh = Math.max(bw * 0.4, b.h * lv * (0.15 + 0.85 * k) * (0.25 + 0.75 * near));
        cv.roundRect(b.x + i * bw + bw * 0.3, cy - hh / 2, bw * 0.4, hh, bw * 0.2, withAlpha(acc, 0.3 + 0.7 * near));
    }
}

/** List rows: o.items = lines "badge, title, small line" (the small line may hold commas), or the app's [{ badge, title, sub, color }]. */
const listItems = (o) => (Array.isArray(o.items) ? o.items : String(o.items || '').split('\n').filter((l) => l.trim()).map((l) => {
    const [badge, title, ...sub] = l.split(',');
    return { badge: badge.trim(), title: (title || '').trim(), sub: sub.join(',').trim() };
}));
/** A list's row height, rows that fit, rows, the first one shown (o.top, scrolled a row at a time). */
function listView(b, o) {
    const rh = Math.max(40, o.rowH || 104), n = Math.max(1, Math.floor(b.h / rh)), all = listItems(o);
    return { rh, n, all, top: Math.max(0, Math.min(all.length - n, o.top | 0)) };
}

/** Scrolling list: badge (tinted in the row's colour), title + small line, arrow; sel = highlighted row. */
function listBox(cv, t, b, o) {
    const acc = C(t, o.color, t.accent), { rh, n, all, top } = listView(b, o), sz = o.size || Math.round(rh * 0.3);
    if (!all.length) { if (o.empty) wrap(cv, o.empty, b.x + 16, b.y + rh * 0.3, b.w - 32, Math.round(sz * 0.9), t.dim, 3); return; }
    const bw = all.some((r) => r.badge) ? Math.round(rh * 0.95) : 0, more = all.length > n, R = b.x + b.w - (more ? 20 : 0);
    all.slice(top, top + n).forEach((r, k) => {
        const y = b.y + k * rh, cy = y + rh / 2, c = C(t, r.color, acc);
        if (top + k === o.sel) surface(cv, t, b.x, y + 4, R - b.x, rh - 8, 14, true, acc);
        else cv.fillRect(b.x, y + rh - 1.5, R - b.x, 1.5, t.panelEdge);
        let x = b.x + 16;
        if (bw) {
            if (r.badge) {
                cv.roundRect(x, cy - rh * 0.26, bw, rh * 0.52, 12, withAlpha(c, 0.2));
                mid(cv, r.badge, x + bw / 2, cy, Math.round(sz * 0.8), c, { align: 'center', font: 'bold' });
            }
            x += bw + 24;
        }
        const w = R - x - (o.chevron ? sz * 1.6 : 16);
        if (r.sub) { wrap(cv, r.title, x, cy - sz * 1.1, w, sz, t.text, 1); wrap(cv, r.sub, x, cy + sz * 0.26, w, Math.round(sz * 0.78), t.dim, 1); }
        else wrap(cv, r.title, x, cy - sz * 0.59, w, sz, t.text, 1);
        if (o.chevron) chevron(cv, R - sz * 0.8, cy, sz * 0.6, 'right', 3, t.dim);
    });
    if (more) {
        const th = Math.max(40, b.h * n / all.length), ty = b.y + (b.h - th) * top / (all.length - n);
        cv.roundRect(b.x + b.w - 6, b.y, 6, b.h, 3, t.track);
        cv.roundRect(b.x + b.w - 6, ty, 6, th, 3, acc);
    }
}

/** Chart legend ending at xr: a line in each series' colour + its name. */
function legend(cv, t, xr, cy, names, colors, size) {
    let x = xr;
    for (let i = names.length - 1; i >= 0; i--) {
        x -= cv.textWidth(names[i], size);
        mid(cv, names[i], x, cy, size, t.dim);
        x -= 44; cv.line(x, cy, x + 32, cy, 3, C(t, colors[i], t.accent)); x -= 28;
    }
}

// pictures (element image): decoded once per src. ponytail: the 32 most recent srcs are kept, older ones dropped
// (an edited element leaves its old picture behind; the renderer frees it as least recently used)
const pictures = new Map();          // src -> record.js picture, or null (unreadable)
// pictures an app hands over at run time (ScreenApp.setImage, e.g. store icons): elements name them 'key:<name>'
const keyed = new Map();
function setPicture(key, img) { if (img) keyed.set(key, img); else keyed.delete(key); }
function picture(src) {
    if (/^key:/.test(src)) return keyed.get(src.slice(4)) || null;
    let img = pictures.get(src);
    if (img !== undefined) return img;
    try {
        const m = /^data:image\/png;base64,(.+)$/.exec(src);
        const p = m && png.decode(Buffer.from(m[1], 'base64'));
        img = p ? makeImage(p.w, p.h, p.data) : null;
    } catch (e) { img = null; }
    pictures.set(src, img);
    if (pictures.size > 32) { const [k, old] = pictures.entries().next().value; pictures.delete(k); if (old) dropImage(old); }
    return img;
}

const DRAW = {
    icon: (cv, t, b, o) => { const s = Math.min(b.w, b.h); icon(cv, o.icon, b.x + (b.w - s) / 2, b.y + (b.h - s) / 2, s, C(t, o.color, t.text)); },
    image: (cv, t, b, o) => {
        const img = o.src ? picture(o.src) : null;
        if (img) cv.image(img, b.x, b.y, b.w, b.h, o.radius || 0);
        else cv.strokeRoundRect(b.x, b.y, b.w, b.h, o.radius || 0, 2, withAlpha(t.dim, 0.6));     // none or unreadable
    },
    button, roundButton, toggle, slider, dropdown, tabs, field, card, tile, choice, row, navRail, titleBar, metric, progress,
    swatches, colorPicker, waveform, list: listBox,
};

// Try (the builder's mouse preview, ../gpu.js tryElement): a click (drag: also a move) at p { x, y } changes o
// the way the app would; false = nothing to do there.
const sliderAt = (cv, b, o, p) => {
    const s = sliderTrack(cv, b, o), lo = isNum(o.min) ? o.min : 0, hi = isNum(o.max) ? o.max : 100, k = Math.pow(10, o.decimals | 0);
    o.value = Math.round((lo + (hi - lo) * Math.max(0, Math.min(1, (p.x - s.x) / s.w))) * k) / k;
};
const pick = (o) => { o.selected = true; };
// a list: a drag scrolls it a row at a time, a tap without a drag selects that row (and runs its onTap: up)
let listDrag = null;        // ponytail: one gesture at a time - the renderer routes one finger
const listTry = Object.assign((cv, b, o, p) => {
    const { rh, n, all, top } = listView(b, o);
    if (!p.move) { listDrag = { y0: p.y, top, moved: false }; return false; }
    const d = listDrag, dy = d ? p.y - d.y0 : 0;
    if (!d || (!d.moved && Math.abs(dy) < rh * 0.25)) return false;
    d.moved = true;
    const nt = Math.max(0, Math.min(all.length - n, d.top - Math.round(dy / rh)));
    if (nt === top) return false;
    o.top = nt;
}, {
    drag: true,
    up: (cv, b, o, p) => {
        const d = listDrag, { rh, all, top } = listView(b, o), i = top + Math.floor((p.y - b.y) / rh);
        listDrag = null;
        if (!d || d.moved || i < 0 || i >= all.length) return false;
        o.sel = i;
    },
});
const TRY = {
    list: listTry,
    toggle: (cv, b, o) => { o.on = !o.on; },
    slider: Object.assign(sliderAt, { drag: true }),
    tabs: (cv, b, o, p) => { const { n, gap, cw } = tabCells(b, o); o.sel = Math.max(0, Math.min(n - 1, Math.floor((p.x - b.x) / (cw + gap)))); },
    navRail: (cv, b, o, p) => {
        const n = railItems(o).length || 1, f = o.direction === 'horizontal' ? (p.x - b.x) / b.w : (p.y - b.y) / b.h;
        o.sel = Math.max(0, Math.min(n - 1, Math.floor(f * n)));
    },
    swatches: (cv, b, o, p) => {
        const { cs, x0, step } = swatchRow(b, o), i = step ? Math.round((p.x - x0) / step) : 0;
        if (i < 0 || i >= cs.length) return false;           // the plus button: the app's own
        o.sel = i;
    },
    dropdown: (cv, b, o) => { o.open = !o.open; },
    choice: pick,
    tile: pick,
    row: Object.assign((cv, b, o, p) => {                    // a tap on the row flips its switch; its slider drags
        if (o.control === 'slider') {
            const so = Object.assign({}, o, { showValue: true });
            sliderAt(cv, rowSlider(b, o), so, p);
            o.value = so.value;
            return;
        }
        if (o.control !== 'toggle' || p.move) return false;
        o.on = !o.on;
    }, { drag: true }),
};

module.exports = { DRAW, TRY, ICONS, icon, chevron, legend, surface, wrap, fit, picture, setPicture, tabCells };
