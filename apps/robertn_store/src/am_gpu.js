'use strict';
/*
 * Renderer screens (mgu-renderd, the idrive7-apps GPU overlay): drawn with the kit (kit/, MIT) the way an
 * app on the car draws them. One recording (kit/record.js draw commands) is
 *   - played back in software here (the renderer's own fallback path) -> PNG for the builder's preview
 *   - sent to the emulator's real mgu-renderd by emulator.js -> on the live HMI at the screen's resolution
 *
 * screen = { kind: 'gpu', name, theme: kit theme id, bg: 'theme' | 'none' | '#rrggbb',
 *            bgArea?: 'app' (bg fills only the head unit's app area, GPU.appArea: the HMI's menus show through),
 *            components: [ { name, rtype: 'gpu', gpu: <public/gpu-elements.js type>, x, y, w, h, opts: {...} } ] }
 * Positions are design pixels (iDrive 8, 2880 x 960). Other head units get the whole recording scaled
 * (renderer placement / browser): GPU.viewScale.
 */
const { Recorder, play } = require('./kit_record.js');
const { Canvas, withAlpha } = require('./kit_canvas.js');
const { theme: kitTheme } = require('./kit_themes.js');
const E = require('./am_elements.js');
const W = require('./am_widgets.js');
const S = require('./am_store_widgets.js');
const Q = require('./store_elements.js');

const isNum = (x) => typeof x === 'number' && isFinite(x);
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// element box -> kit call. o = options with defaults filled in (colour '' = the template's own)
const DRAW = {
    text: (cv, t, b, o) => {
        const c = t[o.color] || o.color || t.text;
        if (!o.wrap) return cv.text(W.fit(cv, o.text, b.w, o.size, o.font), o.align === 'center' ? b.x + b.w / 2 : o.align === 'right' ? b.x + b.w : b.x,
            b.y + o.size * 0.8, o.size, c, { font: o.font, align: o.align });
        // wrapped (left aligned): each line of the text a paragraph, as many lines as the box holds
        let y = b.y;
        for (const para of String(o.text).split('\n')) {
            const room = Math.floor((b.y + b.h - y) / (o.size * 1.25));
            if (room < 1) break;
            y += Math.max(1, W.wrap(cv, para, b.x, y, b.w, o.size, c, room, o.font)) * o.size * 1.25;
        }
    },
    rect: (cv, t, b, o) => cv.roundRect(b.x, b.y, b.w, b.h, Math.min(o.radius || 0, b.w / 2, b.h / 2), t[o.color] || o.color || t.panelTop),
    line: (cv, t, b, o) => cv.line(b.x, b.y, b.x + b.w, b.y + b.h, o.width || 2, t[o.color] || o.color || t.dim),
    ...W.DRAW,
    ...S.DRAW,
    ...Q.DRAW,
};

/**
 * Record one frame of a renderer screen. opts: { time (s, animate), textScale (device px per design px),
 * view (head unit 'id8' | 'id7': where its app area is), design ({ w, h }: the layout's size, the
 * design's when absent), area (the app area there, view's when absent) }.
 * Preview frames show the given values at once; animated ones glide with the kit's smoothing.
 */
function record(st, opts = {}) {
    const tg = opts.design || E.DESIGN, t = kitTheme(st.theme), area = opts.area || E.appArea(opts.view);
    const rec = new Recorder(tg.w, tg.h, { textScale: opts.textScale || 1 });
    rec.clear([0, 0, 0, 0]);
    if (st.bg !== 'none') {
        const a = st.bgArea === 'app' ? area : { x: 0, y: 0, w: tg.w, h: tg.h };
        rec.fillRect(a.x, a.y, a.w, a.h, st.bg && st.bg !== 'theme' ? st.bg : t.bg);
    }
    (st.components || []).forEach((c, i) => {
        const def = E.ELEMENTS[c.gpu];
        if (!def || !DRAW[c.gpu] || (c.opts && c.opts.hidden)) return;       // hidden: the app's set(name, { hidden: true })
        const o = Object.assign(E.defaults(c.gpu), c.opts || {});
        for (const f of def.fields) if (f.kind === 'color' && !o[f.key]) delete o[f.key];
        o.smooth = false;
        o.area = area;                          // the head unit's app area (a sheet dims only that, never the HMI's menus)
        const b = { x: c.x || 0, y: c.y || 0, w: c.w || 0, h: c.h || 0 };
        try { DRAW[c.gpu](rec, t, b, o); } catch (e) {
            rec.errors = (rec.errors || []).concat(`${c.name}: ${e.message}`);
            rec.strokeRoundRect(b.x, b.y, Math.max(b.w, 40), Math.max(b.h, 40), 4, 3, '#ff3030');
            rec.text(`${c.name}: ${e.message}`, b.x + 8, b.y + 30, 22, '#ff3030');
        }
    });
    return rec;
}

/** PNG (RGBA, see-through where nothing is drawn) of a renderer screen at the design's pixel size. */
function renderPng(project, stateIndex, view) {
    const st = (project.states || [])[stateIndex];
    if (!st || st.kind !== 'gpu') throw { code: 400, msg: 'not a renderer screen' };
    const rec = record(st, { view }), cv = new Canvas(E.DESIGN.w, E.DESIGN.h);
    play(rec.words(), cv);
    return cv.png();
}

// Touch (the builder's Try mode, and the app on the emulator / car: mgu-renderd --touch, E_TOUCH): a press or drag at p
// (design px) on an element changes its state the way the app would. Kit elements here, the app widgets in
// widgets.js (W.TRY). drag: moves count too. A tap (released on the element) also runs its onTap.
const TRY = {
    ...W.TRY,
    ...S.TRY,
};
const measure = new Recorder(E.DESIGN.w, E.DESIGN.h);     // text widths for TRY, as drawn
// which elements take touch, where a screen claims it, what a tap does: shared with the browser (gpu-elements.js)
const { box, inBox, interactive, elementAt, claims, claimed, tapAction } = E;

/**
 * Touch on element i of screen st: phase 'down' | 'move' | 'up' at p { x, y } (design px).
 * Returns { opts: the screen's new opts (one per element) or null = unchanged, action: tapAction() on a tap or null }.
 */
function touchElement(st, i, phase, p) {
    const c = (st.components || [])[i], h = c && TRY[c.gpu], r = { opts: null, action: null };
    if (!c || !interactive(c)) return r;
    if (phase === 'up') {
        if (h && h.up) {        // its own release: a list selects the row tapped; after a drag (scrolled) no tap at all
            const o = Object.assign(E.defaults(c.gpu), c.opts || {});
            if (h.up(measure, box(c), o, p) === false) return r;
            c.opts = o;
            r.opts = st.components.map((s) => s.opts);
        }
        if (inBox(box(c), p)) r.action = tapAction(c.onTap);
        return r;
    }
    if (!h || (phase === 'move' && !h.drag)) return r;
    const o = Object.assign(E.defaults(c.gpu), c.opts || {});
    if (h(measure, box(c), o, Object.assign({ move: phase === 'move' }, p)) === false) return r;
    c.opts = o;
    // choice cards / tiles: one of a kind is selected on a screen
    if (o.selected) for (const s of st.components) if (s !== c && s.gpu === c.gpu && s.opts) s.opts.selected = false;
    r.opts = st.components.map((s) => s.opts);
    return r;
}

/**
 * Touch at p (design px) on screen st as the renderer routes it: { outside: true } = not in the screen's claims
 * (the HMI gets it and the app closes); else the element it goes to (index, -1 = none) and touchElement's result.
 */
function touchAt(st, view, p) {
    if (!claimed(st, view, p)) return { outside: true, index: -1, opts: null, action: null };
    const index = elementAt(st, p);
    return Object.assign({ index }, index < 0 ? { opts: null, action: null } : touchElement(st, index, 'down', p));
}

// every element type with a touch behaviour here has its description in gpu-elements.js TOUCH (test_export.js)
module.exports = { record, renderPng, touchElement, touchAt, elementAt, claims, tapAction, TRY_TYPES: Object.keys(TRY), ICONS: W.ICONS };
