'use strict';
/**
 * The Store's screens drawn by mgu-render (native/mgu-render, its own
 * dialect mgu-render/1 through lib/mgu_render_client.js): the connection,
 * the placement, the page stack, the HMI host states and their proxies,
 * touch, the controller and the package pictures. src/store_frame.js makes
 * each frame.
 *
 * Placement: embed (inside the host state's page template, iDrive 7, while
 * the renderer offers it) or layer (the renderer's own layer over the host
 * state, placed on the app area). src/store_frame.js placement() picks the
 * layout for the box: on iDrive 8 the design's, scaled into it; on iDrive 7
 * one made for the box at scale 1. Logical pixels (touch, claims) are the
 * layout's.
 *
 * Pages: the stack's first page is the tabs; each page opened from it is
 * the host state of the next depth (src/store.js hostName), so the HMI's BACK
 * closes it. A host state's proxies are its focusable buttons, one per
 * pressable item of the drawn page in focus order: the HMI's focus on one
 * draws the focus ring there, a press on one presses the item. Touch in the
 * renderer's claimed area hits the items themselves; a drag scrolls. With
 * the HMI's controller gate (the renderer's `controller`), the dial moves
 * the focus and a push presses; in embed mode without it, FrontCCU does.
 *
 * Emits 'mode' (null, 'layer' or 'embed') when what the renderer offers
 * changes (null: the widget screens show), and 'page-focus' (the page) when
 * the HMI gives the top page's host state its focus.
 */
const EventEmitter = require('events');
const { RenderClient } = require('./mgu_render_client.js');
const fs = require('fs');
const kit = require('./kit_record.js');
const png = require('./kit_png.js');
const { setPicture } = require('./am_widgets.js');
const { frame, layoutOf, dragOf, dragFrame, hit, placement } = require('./store_frame.js');
const FULL_X = 84;              // the HMI's back arrow column (x 0..84): kept the HMI's, as the idrive7-apps keep it

const DEPTHS = 3;
const ICON_BYTES = 128 * 1024;          // a package picture: at most this big
const ICONS_KEPT = 48;                  // decoded pictures kept, the most recently shown
const FPS = 60;                         // frames a second at most (mgu-render's fps setting can give another)
const KEEPALIVE_MS = 1000;              // the renderer hides an app silent for 3 s
const CLOSED_RESHOW_MS = 700;           // a touch outside that left the page where it was
const STUCK_MS = 6000;                  // asked to show and off screen this long: the widget screens instead
const RETRY_MS = 30000;                 // after a picture that showed was taken away: the drawn screens tried again
const RETRIES = 3;                      // that often on a timer (30, 60, 120 s); an install or removal ending always retries
const DRAG_PX = 14;
const DRAG_ROWS_PX = 2048;                // a drag's cached rows: at most this high on the device (mgu-render takes 4096)
const PREBUILD_MS = 300;                  // a drag's layers made ahead once the page has stayed this long
const PICTURES_MS = 100;                  // a new page's first frame waits at most this long for its pictures
const STATS_LOG = '/run/mgu-render/stats-log';  // mgu-render's per-second stats switch: the Store's own then too
const STATS_OUT = '/dev/shm/robertn_store-stats.log';   // where they go (an OAP app's own log goes to DLT)
const STATS_OUT_MAX = 1024 * 1024;              // bytes kept; past it the file starts again
const TRACE_OUT = '/dev/shm/robertn_store-trace.log';   // the per-frame trace beside mgu-render's (tools/car-test/trace.js)
const TRACE_MAX = 8 * 1024 * 1024;
// FrontCCU frontRotaryEncoderPushButton pushed (short, long): by name or ordinal
const PUSHED = ['DREHGEBER_KURZ_GEDRUECKT', 'DREHGEBER_LANG_GEDRUECKT', 1, 2];
const RELEASED = ['KEINE_BETAETIGUNG', 0];
const DIAL_MAX_STEP = 24;
// the controller pushed (FrontCCU deflection, short or long; by name or number): N up, E right, S down, W left
const TILT = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W',
    NORD_KURZ_GEDRUECKT: 'N', NORD_LANG_GEDRUECKT: 'N', OST_KURZ_GEDRUECKT: 'E', OST_LANG_GEDRUECKT: 'E',
    SUED_KURZ_GEDRUECKT: 'S', SUED_LANG_GEDRUECKT: 'S', WEST_KURZ_GEDRUECKT: 'W', WEST_LANG_GEDRUECKT: 'W' };

const msNow = () => { const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; };
const usNow = () => { const t = process.hrtime(); return t[0] * 1e6 + Math.floor(t[1] / 1e3); };   // CLOCK_MONOTONIC, as mgu-render's

/* While mgu-render's stats-log is on, once a second a line into out: the frames built and sent, their build and send
 * times, the touch events and the time they took, and the process's CPU, so its share outside drawing shows. */
class Timing {
    constructor(file, out, traceOut) {
        this.file = file;
        this.out = out;
        this.traceOut = traceOut;
        this.lines = [];                    // trace lines since the last second
        this.sent = 0;                      // frames sent and touches had on this connection
        this.touchesIn = 0;
        this.on = false;
        this._reset();
        this.timer = setInterval(() => this._second(), 1000);
        if (this.timer.unref) this.timer.unref();
    }
    _reset() {
        Object.assign(this, { builds: 0, build: 0, buildMax: 0, model: 0, layout: 0, drags: 0, dragMs: 0, frames: 0, send: 0, touches: 0,
            touchMs: 0 });
        this.cpu = process.cpuUsage();
        this.t0 = msNow();
    }
    /* One step of the trace, "<us> S <step> <n> <kind>": n counts frames sent or touches had on this connection,
     * as mgu-render does. */
    trace(step, n, kind, us) {
        if (this.on) {
            this.lines.push(`${us || usNow()} S ${step} ${n} ${kind || ''}\n`);
        }
    }
    connected() {
        this.sent = 0;
        this.touchesIn = 0;
    }
    _second() {
        fs.access(this.file, (err) => {
            const was = this.on;
            this.on = !err;
            if (this.on && this.lines.length) {
                const text = this.lines.join('');
                fs.stat(this.traceOut, (e, st) => {
                    const write = !e && st.size > TRACE_MAX ? fs.writeFile : fs.appendFile;
                    write(this.traceOut, text, () => { /* a full /dev/shm: the lines are lost */ });
                });
            }
            this.lines = [];
            if (was && this.on && (this.builds || this.drags || this.touches)) {
                const n = this.builds || 1, f = this.frames || 1, c = process.cpuUsage(this.cpu), el = msNow() - this.t0;
                const d = this.drags || 1;
                const line = `${new Date().toISOString()} stats store: ${this.builds} builds avg ${(this.build / n).toFixed(1)} ms ` +
                    `max ${this.buildMax.toFixed(1)} ms (model ${(this.model / n).toFixed(1)}, layout ${(this.layout / n).toFixed(1)}), ` +
                    `${this.drags} drag frames avg ${(this.dragMs / d).toFixed(1)} ms, ${this.frames} frames sent avg ${(this.send / f).toFixed(1)} ms, ` +
                    `${this.touches} touch events ${this.touchMs.toFixed(0)} ms, cpu ${((c.user + c.system) / 10 / el).toFixed(0)} %\n`;
                fs.stat(this.out, (e, st) => {
                    const write = !e && st.size > STATS_OUT_MAX ? fs.writeFile : fs.appendFile;
                    write(this.out, line, () => { /* a full /dev/shm: the line is lost */ });
                });
            }
            this._reset();
        });
    }
    close() { clearInterval(this.timer); }
}

class Drawn extends EventEmitter {
    /**
     * host: { log, model() (the updater's side of store_ui.js's model),
     * act(act) (a press), set(name, text), show(name, on), openState(name),
     * closeState(name), hostName(mode, depth), proxyName(mode, depth, i),
     * proxies (count per depth), modes (the host modes the RHMI has) }.
     */
    constructor(host, opts) {
        super();
        this.host = host;
        this.log = host.log;
        this.opts = opts || {};
        this.stuckMs = opts && opts.stuckMs;
        this.gpu = (opts && opts.client) || new RenderClient('robertn_store', this.log, { kit, mode: 'layer' });
        this.gpu.fps(FPS);
        this.timing = new Timing((opts && opts.statsLog) || STATS_LOG, (opts && opts.statsOut) || STATS_OUT, (opts && opts.traceOut) || TRACE_OUT);
        this.mode = null;
        this.w = 0;
        this.scale = 1;
        this.layout = null;
        this.viewport = null;
        this.stack = [{ name: 'main' }];
        this.tab = 'store';
        this.filter = 'all';
        this.focus = 0;
        this.scroll = {};
        this.items = [];
        this.regions = [];
        this.lists = null;                  // the Installed lists' rows as drawn: { apps, services } (ids), kept under its pages
        this.listsItems = [];               // and the Installed screen's items then
        this.dragHeld = null;               // the rows held as a drag took the focus off them
        this.visibleHosts = new Set();      // depths whose host state is visible
        this.focusLost = false;             // the top host state lost the HMI focus (a popup)
        this.suspended = false;             // the HMI's speller is up
        this.closedHide = false;
        this.on_ = false;
        this.onScreen = false;              // the renderer says the picture is on screen
        this.stuck = false;                 // it never was: widget screens from then on
        this.shownOnce = false;             // the picture was on screen once: a later loss is not for good
        this.lost = false;                  // widget screens for now, after a picture that showed was taken away
        this.info = null;                   // the renderer's last READY info, to try the drawn screens again
        this.retries = 0;
        this.retryTimer = null;
        this.stuckTimer = null;
        this.dirty = false;
        this.sentAt = 0;
        this.keepalive = null;
        this.touch = null;
        this.drag = null;                   // a drag's cached layers (_dragFrame), for the page as at gen
        this.gen = 0;                       // counts changes to what the page draws besides a grid's or list's scroll
        this.drawn = null;                  // the model the page was last built from (JSON), and its focus
        this.drawnFocus = 0;
        this.settleKey = null;              // a released drag's region whose last position is still to be drawn
        this.prebuild = null;
        this.pageAt = 0;                    // when the page last changed (_page)
        this.held = null;                   // a new page's frame held for its pictures
        this.showing = false;               // _updateShow's frame: sent at once
        this.retired = [];                  // layers to drop once the next frame is sent
        this.ccu = null;
        this.fccu = null;
        this.embedProxies = false;          // the HMI routes presses to embed proxies
        this.pics = new Map();              // picture file -> { img, used }
        this.decoding = new Set();
        this.gpu.on('ready', (screen, info) => {
            this.timing.connected();
            this._ready(info);
        });
        this.gpu.on('close', () => this._setMode(null));
        this.gpu.on('tick', (n) => {
            this.timing.trace('tick', n);
            if (this.dirty) {
                if (this.touch && this.touch.drag) {
                    this._dragFrame(this.touch.region.key, this.touch.gen);
                } else if (this.settleKey && this.drag && this.drag.gen === this.gen) {
                    this._dragFrame(this.settleKey, this.gen);
                } else {
                    this.render();
                }
            }
        });
        this.gpu.on('touch', (phase, x, y) => this._touch(phase, x, y));
        this.gpu.on('closed', () => {
            this.closedHide = true;
            this.on_ = false;
            this._dropKept();
            setTimeout(() => {
                this.closedHide = false;
                this._updateShow();
            }, CLOSED_RESHOW_MS);
        });
        this.gpu.on('ccu', (e) => this._ccu(e));
        // the renderer's word that the picture is on screen (X_STATE)
        this.gpu.on('state', (st) => {
            this.onScreen = !!(st && st.onScreen);
            if (this.onScreen) {
                this.shownOnce = true;
                this.retries = 0;
                clearTimeout(this.stuckTimer);
            } else if (this.on_) {
                this._watchStuck();         // taken off screen while the Store still asks for it
            }
        });
    }

    connect() {
        this.gpu.connect();
    }

    /* At shutdown: the connection ends without switching to the widget screens. */
    close() {
        clearInterval(this.keepalive);
        clearTimeout(this.retryTimer);
        clearTimeout(this.prebuild);
        clearTimeout(this.held);
        this.timing.close();
        this.gpu.removeAllListeners('close');
        this.gpu.close();
    }

    _ready(info) {
        this.info = info;
        let mode = null;
        if (info && !this.stuck) {
            if (info.modes.indexOf('embed') >= 0 && this.host.modes.indexOf('embed') >= 0) {
                mode = 'embed';
            } else if (info.modes.indexOf('layer') >= 0 && this.host.modes.indexOf('layer') >= 0) {
                mode = 'layer';
            }
        }
        if (mode) {
            let box = mode === 'embed' ? info.embedBox : info.appArea;
            // iDrive 7 layer mode: the whole screen right of the HMI's back arrow column, the header in its title
            // strip, as the idrive7-apps run (store_compact.js full)
            const scr = this.gpu.screen || {};
            const full = mode === 'layer' && box.h < 700 && scr.w === 1920 && scr.h === 720;
            if (full) box = { x: FULL_X, y: 0, w: scr.w - FULL_X, h: scr.h };
            const p = placement(box.w, box.h, full);
            this.scale = p.scale;
            this.layout = p.layout;
            this.viewport = p.viewport;
            this.w = box.w;
            this.gpu.mode(mode);
            this.gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale: p.scale, ox: p.ox, oy: p.oy });
            this.controller = !!info.controller;
            this.log.info(`renderer: ${mode} ${box.w}x${box.h} at ${box.x},${box.y}, scale ${this.scale.toFixed(3)}`);
        } else {
            this.log.info(`renderer: ${info ? 'no mode the Store has' : 'not mgu-render/1'}; widget screens`);
        }
        this._setMode(mode);
    }

    _setMode(mode) {
        if (mode === this.mode) {
            return;
        }
        this.mode = mode;
        this.touch = null;                  // a gesture the old connection had ends with it
        this._dragEnd();
        this.visibleHosts.clear();
        this.focusLost = false;
        this.reset();
        this._updateShow();
        this.emit('mode', mode);
    }

    reset() {
        this.stack = [{ name: 'main' }];
        this.focus = 0;
        this._page();
    }

    /* Another page: a gesture on the one before ends, and the new page's
     * first frame shows it whole (render: its pictures too). */
    _page() {
        this.pageAt = msNow();
        this.dragHeld = null;
        this.touch = null;
        this.settleKey = null;
    }

    top() {
        return this.stack[this.stack.length - 1];
    }

    hostOf(depth) {
        return this.host.hostName(this.mode, depth);
    }

    /* A page over the current one: the next depth's host state. At DEPTHS
     * it takes the top page's place and returns that page (restore). */
    push(page) {
        if (!this.mode) {
            return null;
        }
        const top = this.top();
        top.focus = this.focus;                 // where the HMI's focus comes back to
        let replaced = null;
        if (this.stack.length >= DEPTHS) {
            replaced = top;
            this.stack[DEPTHS - 1] = page;
        } else {
            this.stack.push(page);
            this._bridge();
            this.host.openState(this.hostOf(this.stack.length));
        }
        this.focus = 0;
        this._page();
        this.render();
        return replaced;
    }

    /* Puts back the page push replaced at DEPTHS, with its focus. */
    restore(page) {
        this.stack[this.stack.length - 1] = page;
        this._backTo();
        this._page();
        this.render();
    }

    pop() {
        if (this.stack.length > 1) {
            const depth = this.stack.length;
            this.stack.pop();
            this._backTo();
            this._bridge();
            this.host.closeState(this.hostOf(depth));
            this._page();
            this.render();
        }
    }

    /* Closes the top page when pred says it is the one. */
    closePage(pred) {
        if (this.stack.length > 1 && pred(this.top())) {
            this.pop();
        }
    }

    _backTo() {
        const f = this.top().focus;
        this.focus = typeof f === 'number' ? f : -1;
    }

    setTab(tab) {
        while (this.stack.length > 1) {
            this.pop();
        }
        this.tab = tab;
        this._page();
        this.render();
    }

    setFilter(filter) {
        this.filter = filter;
        this._page();
        this.render();
    }

    suspend(on) {
        this.suspended = on;
        this._updateShow();
    }

    /* The HMI showed or hid a host state. */
    hostVisible(depth, visible) {
        if (visible) {
            this.visibleHosts.add(depth);
            if (depth < this.stack.length) {
                this.focusLost = false;
                this._bridge();
                this.stack.length = depth;
                this._backTo();
                this._page();
            }
            this.focusLost = false;
            this.render();
        } else {
            this.visibleHosts.delete(depth);
        }
        this._updateShow();
    }

    /* The HMI's focus on a host state. A state under the top one keeps its
     * visibility while pages cover it and gets the focus back when they
     * close (BACK); the top one loses it to an HMI popup. */
    hostFocus(depth, focus) {
        if (focus && depth < this.stack.length) {
            this.focusLost = false;             // BACK: the page below has the focus
            this._bridge();
            this.stack.length = depth;
            this._backTo();
            this._page();
            this.render();
        }
        if (depth === this.stack.length) {
            this.focusLost = !focus;
            if (focus) {
                this.emit('page-focus', this.top());
            } else if (this.mode === 'embed') {
                this.gpu.bridge(false);         // an HMI popup over the page, or BACK (the page below then bridges)
            }
        }
        this._updateShow();
    }

    proxyFocus(depth, i, value) {
        if (depth === this.stack.length && value) {
            this.focus = i;
            this._focusBack();
            this.render();
        }
    }

    proxyPress(depth, i) {
        this._proxyInput();
        if (depth === this.stack.length) {
            this._focusBack();
        }
        if (depth === this.stack.length && this.items[i]) {
            this.focus = i;
            this.host.act(this.items[i].act);
        }
    }

    /* The HMI's focus is on the top page's buttons, so no popup covers it: the HMI does not always
     * say the page has its focus back (after another app was updated in place, the picture stayed
     * hidden behind the page's empty rows). */
    _focusBack() {
        if (this.focusLost) {
            this.focusLost = false;
            this._updateShow();
        }
    }

    /* An HMI that presses the page template's buttons drives embed mode
     * itself: FrontCCU then stands down (frontCcu). */
    _proxyInput() {
        if (this.mode === 'embed') {
            this.embedProxies = true;
        }
    }

    /* The HMI changes the page's host state now: the renderer shows the drawn
     * page over the HMI's box meanwhile, so the box does not go black. Not
     * while an HMI popup has the focus: the layer would cover it. */
    _bridge() {
        if (this.mode === 'embed' && this.on_ && !this.focusLost) {
            this.gpu.bridge(true);
        }
    }

    _shouldShow() {
        return !!this.mode && this.visibleHosts.size > 0 && !this.suspended && !this.closedHide &&
            !(this.mode === 'layer' && this.focusLost);
    }

    _updateShow() {
        const on = this._shouldShow();
        if (on === this.on_ && !(on && !this.gpu.visible)) {
            return;
        }
        this.on_ = on;
        if (!on) {
            this._dropKept();
        }
        // full screen: not the HMI's status icons at the title strip's right end
        this.gpu.claim(on ? (this.layout && this.layout.claims) || [this.viewport] : []);
        this.gpu.grab(on && !!this.controller);
        if (on) {
            // the frame before it shows: at once (a frame the renderer had may draw layers dropped while hidden)
            this.showing = true;
            this.render();
            this.showing = false;
        }
        this.gpu.show(on);
        // a renderer that does not put the picture on screen (seen on some HMI builds) would leave the
        // host state's empty page up: after STUCK_MS the Store goes on with its widget screens
        clearTimeout(this.stuckTimer);
        if (on && !this.onScreen) {
            this._watchStuck();
        }
        clearInterval(this.keepalive);
        this.keepalive = on ? setInterval(() => {
            if (Date.now() - this.sentAt >= KEEPALIVE_MS) {
                this.render(true);
            }
        }, KEEPALIVE_MS) : null;
    }

    /* Asked to show and not on screen for STUCK_MS: the widget screens. A picture that never showed
     * (an HMI build that does not put it on screen): until the Store restarts. One that showed and was
     * taken away (an app install restarts the app manager, which closes the Store's screen meanwhile):
     * for now, and the drawn screens are tried again (retry). */
    _watchStuck() {
        const ms = this.stuckMs || STUCK_MS;
        clearTimeout(this.stuckTimer);
        this.stuckTimer = setTimeout(() => {
            if (this.on_ && !this.onScreen && this.mode) {
                this.log.warn(`renderer: ${this.mode} asked to show, not on screen for ${ms / 1000} s; widget screens${
                    this.shownOnce ? ' until it can show again' : ''}`);
                if (this.shownOnce) {
                    this.lost = true;
                    this._setMode(null);
                    if (this.retries < RETRIES) {
                        clearTimeout(this.retryTimer);
                        this.retryTimer = setTimeout(() => this.retry(), ((this.opts && this.opts.retryMs) || RETRY_MS) * 2 ** this.retries);
                    }
                } else {
                    this.stuck = true;
                    this._setMode(null);
                }
            }
        }, ms);
    }

    /* The drawn screens again after a picture that showed was taken away (lost): on a timer, or when an
     * install or removal has ended. Not on screen again within STUCK_MS: the widget screens once more. */
    retry() {
        clearTimeout(this.retryTimer);
        if (!this.lost || this.mode || !this.info || this.stuck) {
            return;
        }
        this.lost = false;
        this.retries++;
        this.log.info('renderer: drawn screens again');
        this._ready(this.info);
    }

    /* Draws the frame (sent while the renderer is ready and the page is
     * shown, one at a time) and writes the top host state's proxies. same:
     * nothing but a scroll changed since the last build (the keepalive). */
    render(same) {
        if (!this.mode || !this.w) {
            return;
        }
        this.settleKey = null;
        const b0 = this.timing.on ? usNow() : 0;
        const t0 = this.timing.on ? msNow() : 0;
        const m = this._model();
        const json = JSON.stringify(m);
        if (!same || json !== this.drawn) {
            this.gen++;
            same = false;
        }
        this.drawn = json;
        this.drawnFocus = this.focus;
        const tm = t0 ? msNow() : 0;
        const r = frame(m, { textScale: this.scale, focus: this.focus, scroll: this.scroll, layout: this.layout });
        if (t0) { this.timing.model += tm - t0; this.timing.layout += msNow() - tm; }
        const rec = r.rec;
        this.items = r.items;
        this.regions = r.regions;
        if (r.screen === 'installed') {
            this.lists = { apps: r.values.apps.items.map((i) => i.id), services: r.values.services.items.map((i) => i.id) };
            this.listsItems = r.items;
        } else if (this.stack.length === 1) {
            this.lists = null;
        }
        this._proxies();
        this._pictures(r.icons);
        if (this.drag && this.drag.gen !== this.gen) {
            this._dragEnd();                // a drag goes on from this page
        }
        if (!same) {
            this._prebuildSoon();
        }
        if (t0) {
            const ms = msNow() - t0;
            this.timing.builds++; this.timing.build += ms; this.timing.buildMax = Math.max(this.timing.buildMax, ms);
        }
        const b1 = b0 ? usNow() : 0;
        if (!this.on_) {
            return;
        }
        const now = Date.now();
        clearTimeout(this.held);
        this.held = null;
        const since = msNow() - this.pageAt;
        if (!this.showing && since < PICTURES_MS && r.icons.some((f) => this.decoding.has(f))) {
            // a new page: shown once its pictures are decoded (refresh), or as it is at PICTURES_MS
            this.held = setTimeout(() => {
                this.held = null;
                this.render(true);
            }, PICTURES_MS - since);
            return;
        }
        if (!this.showing && this.gpu.waiting && now - this.sentAt < KEEPALIVE_MS) {
            this.dirty = true;
            return;
        }
        this.dirty = false;
        this.sentAt = now;
        this._send(rec, b0, b1, 'whole');
    }

    /* The model may have changed (the updater's state, pictures decoded): built again now, or, while a drag
     * moves cached rows, once the drag ends (its release builds the page); decoded pictures redraw the rows. A
     * state the page was built from already draws nothing; its proxies are written again where they differ. */
    refresh(pictures) {
        const same = !pictures && !!this.mode && JSON.stringify(this._model()) === this.drawn;
        if (this.touch && this.touch.drag) {
            if (!same) {
                this.gen++;
                if (pictures && this.drag) {
                    this.drag.rowsStale = true;
                }
            }
            return;
        }
        if (same && this.focus === this.drawnFocus) {
            this._proxies();                // cells the host asked to be written again
            return;
        }
        this.render();
    }

    /* A drag's layers made ahead for the page's largest scrolling grid or
     * list, once it has stayed PREBUILD_MS, so a drag's first frame is as
     * quick as the rest. */
    _prebuildSoon() {
        clearTimeout(this.prebuild);
        this.prebuild = setTimeout(() => {
            this.prebuild = null;
            if (this.touch) {
                this._prebuildSoon();
                return;
            }
            if (!this.on_ || (this.drag && this.drag.gen === this.gen)) {
                return;
            }
            const g = this.regions.filter((x) => x.max > 0).sort((a, b) => b.w * b.h - a.w * a.h)[0];
            if (!g) {
                return;
            }
            this._dragEnd();
            this.timing.trace('prebuild-start', this.timing.sent);
            this.drag = this._dragStart(g.key, this.gen);
            if (this.drag) {
                this._dragRows(this.drag, this.scroll[g.key] || 0);
            }
            this.timing.trace('prebuild-end', this.timing.sent);
        }, PREBUILD_MS);
        if (this.prebuild.unref) {
            this.prebuild.unref();
        }
    }

    _model() {
        return Object.assign(this.host.model(), { stack: this.stack, tab: this.tab, filter: this.filter, held: this._held() });
    }

    /* The Installed lists' rows as drawn while the focus is on one of them
     * (the HMI's focus stays on its proxy: the rows under it stay where they
     * are; a page opened from one comes back to it), and after a drag took
     * the focus off them until the focus moves; else null. */
    _held() {
        if (!this.lists || this.tab !== 'installed' || this.stack.length > 1) {
            return null;
        }
        const it = this.listsItems[this.focus];
        return it && /^installed\./.test(it.list || '') ? this.lists : this.focus === -1 ? this.dragHeld : null;
    }

    /* Sends a frame (built from b0 to b1, us, when traced), then drops the
     * layers retired before it (none of them drawn by it or any frame after). */
    _send(rec, b0, b1, kind) {
        const t1 = this.timing.on ? msNow() : 0;
        // the frames mgu-render gets: those RenderClient.frame() writes (false from it can also mean the socket's
        // buffer is full, the frame still on its way)
        const written = this.gpu.ready && this.gpu.native && !!this.gpu.placement;
        const ts = this.timing.on ? usNow() : 0;      // before the write: mgu-render may have it before the write returns
        this.gpu.frame(rec);
        if (written) {
            const n = ++this.timing.sent;
            if (b0) {
                this.timing.trace('build-start', n, kind, b0);
                this.timing.trace('build-end', n, kind, b1);
            }
            this.timing.trace('send', n, '', ts);
        }
        if (t1) { this.timing.frames++; this.timing.send += msNow() - t1; }
        this.retired.forEach((L) => {
            kit.dropLayer(L);
            this.gpu.dropLayer(L.layerId);
        });
        this.retired = [];
    }

    /* A frame of a drag (the touch drags a region): the page as it was when
     * the drag started, without the dragged grid's or list's rows, and those
     * rows are cached layers, so a frame is the two, the rows moved, and the
     * grid's scroll bar. The rows are drawn again when the ones shown leave
     * them; both when the page changed (gen) since. key: the grid or list;
     * gen: the page's as the touch started. */
    _dragFrame(key, gen) {
        if (!this.on_) {
            this.render();
            return;
        }
        const now = Date.now();
        if (this.gpu.waiting && now - this.sentAt < KEEPALIVE_MS) {
            this.dirty = true;
            return;
        }
        const b0 = this.timing.on ? usNow() : 0;
        const t0 = this.timing.on ? msNow() : 0;
        if (this.drag && (this.drag.key !== key || this.drag.gen !== gen)) {
            this._dragEnd();
        }
        const d = this.drag || (this.drag = this._dragStart(key, gen));
        if (!d) {
            this.render();
            return;
        }
        const v = d.view, top = this.scroll[key] || 0;
        if (!d.rowsLayer || d.rowsStale || top < d.from || top + v.shown > d.from + d.n + 1e-6) {
            this._dragRows(d, top);
        }
        const r = dragFrame(v, d.baseLayer, d.rowsLayer, d.from, top, this.scale);
        if (t0) { this.timing.drags++; this.timing.dragMs += msNow() - t0; }
        const b1 = b0 ? usNow() : 0;
        this.dirty = false;
        this.settleKey = null;
        this.sentAt = now;
        this._send(r, b0, b1, 'drag');
    }

    _dragStart(key, gen) {
        const view = dragOf(this._model(), { textScale: this.scale, scroll: this.scroll, layout: this.layout }, key);
        if (!view) {
            return null;
        }
        return { key, gen, view, baseLayer: kit.makeLayer(view.rec.w, view.rec.h, (r) => r.append(view.rec), this.scale), rowsLayer: null,
            from: 0, n: 0 };
    }

    /* The rows around top that fit DRAG_ROWS_PX, as the rows' layer; the
     * one before is retired. */
    _dragRows(d, top) {
        const v = d.view;
        const whole = Math.ceil(v.shown) + 1;
        const n = Math.min(v.rows, Math.max(whole, Math.floor(DRAG_ROWS_PX / (v.step * this.scale))));
        const from = Math.max(0, Math.min(v.rows - n, Math.floor(top) - Math.floor((n - whole) / 2)));
        const rec = v.draw(from, n);
        if (d.rowsLayer) {
            this.retired.push(d.rowsLayer);
        }
        d.rowsLayer = kit.makeLayer(v.box.w, n * v.step, (r) => r.append(rec), this.scale);
        d.rowsStale = false;
        d.from = from;
        d.n = n;
    }

    /* Hidden: the drag's layers and those retired dropped now (the next frame, once shown, is built whole). */
    _dropKept() {
        this._dragEnd();
        this.retired.forEach((L) => {
            kit.dropLayer(L);
            this.gpu.dropLayer(L.layerId);
        });
        this.retired = [];
    }

    /* The drag's layers retired: dropped after the next frame sent. */
    _dragEnd() {
        const d = this.drag;
        this.drag = null;
        if (d) {
            this.retired.push(d.baseLayer);
            if (d.rowsLayer) {
                this.retired.push(d.rowsLayer);
            }
        }
    }

    /* A drag ended. The page unchanged since it started: what a press finds where the rows came to rest, and
     * the last position drawn from the drag's layers when it is still to go; else the page built again. */
    _settle(t) {
        if (!this.drag || this.drag.gen !== this.gen || this.drag.key !== t.region.key) {
            this.render();
            return;
        }
        this.timing.trace('settle-start', this.timing.sent);
        const l = layoutOf(this._model(), { focus: this.focus, scroll: this.scroll, layout: this.layout });
        this.drawnFocus = this.focus;
        this.items = l.items;
        this.regions = l.regions;
        this._proxies();
        this.timing.trace('settle-end', this.timing.sent);
        if (this.dirty) {
            this.settleKey = t.region.key;
            if (!this.gpu.waiting) {
                this._dragFrame(this.settleKey, this.gen);
            }
        }
    }

    _proxies() {
        const depth = this.stack.length;
        const n = this.host.proxies[depth - 1] || 0;
        for (let i = 0; i < n; i++) {
            const name = this.host.proxyName(this.mode, depth, i);
            // unlabelled: the HMI shows the host state for a moment when the page opens and closes,
            // before the renderer's picture is over it and after it has gone
            this.host.set(name, ' ');
            this.host.show(name, !!this.items[i]);
        }
    }

    _touch(phase, x, y) {
        this.timing.trace('touch', ++this.timing.touchesIn, phase);
        const t0 = this.timing.on ? msNow() : 0;
        this._touchEvent(phase, x, y);
        if (t0) { this.timing.touches++; this.timing.touchMs += msNow() - t0; }
    }

    _touchEvent(phase, x, y) {
        if (phase === 'down') {
            this.touch = { x, y, item: hit(this.items, x, y), drag: false, region: this.regions.find((g) =>
                x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h) || null };
            this.touch.gen = this.gen;
            if (this.touch.region) {
                this.touch.from = this.scroll[this.touch.region.key] || 0;
            }
        } else if (this.touch && phase === 'move') {
            const t = this.touch;
            if (!t.drag && t.region && Math.abs(y - t.y) > DRAG_PX) {
                t.drag = true;
            }
            if (t.drag) {
                const step = t.region.step;     // whole pixels: the rows' layer lands where the frame built whole draws them
                const top = Math.max(0, Math.min(t.region.max, Math.round(t.from * step + t.y - y) / step));
                if (top === (this.scroll[t.region.key] || 0) && this.focus === -1) {
                    return;
                }
                this.scroll[t.region.key] = top;
                if (this.focus >= 0) {
                    this.dragHeld = this._held();
                }
                this.focus = -1;
                if (this.on_ && this.gpu.waiting) {
                    this.dirty = true;          // drawn on the renderer's TICK
                } else {
                    this._dragFrame(t.region.key, t.gen);
                }
            }
        } else if (this.touch && phase === 'up') {
            const t = this.touch;
            this.touch = null;
            if (t.drag) {
                this._settle(t);
            } else if (t.item >= 0 && hit(this.items, x, y) === t.item) {
                this.host.act(this.items[t.item].act);
            }
        }
    }

    /* The package pictures the frame shows (components[].icon, files the
     * updater leaves readable): decoded once, the ICONS_KEPT most recently
     * shown kept, drawn from the next frame on. A file that is missing, too
     * big or no PNG draws the letter tile. */
    _pictures(files) {
        const now = Date.now();
        files.forEach((f) => {
            const p = this.pics.get(f);
            if (p) {
                p.used = now;
            }
        });
        files.filter((f) => !this.pics.has(f) && !this.decoding.has(f)).forEach((f) => {
            this.decoding.add(f);
            let ok = false;
            try {
                const s = fs.statSync(f);
                ok = s.isFile() && s.size <= ICON_BYTES;
            } catch (e) {
                ok = false;
            }
            (ok ? fs.readFile.bind(fs, f) : (cb) => setImmediate(cb, new Error('not a picture file')))((err, buf) => {
                if (err || buf.length > ICON_BYTES) {
                    this.decoding.delete(f);
                    this.pics.set(f, { img: null, used: Date.now() });
                    if (this.held) {
                        this.render(true);          // a page held for its pictures: none of this one to wait for
                    }
                    return;
                }
                png.decodeAsync(buf, (e, img) => {
                    this.decoding.delete(f);
                    let pic = null;
                    if (!e) {
                        const small = png.fit(img, 256);
                        pic = kit.makeImage(small.w, small.h, small.data);
                        setPicture(f, pic);
                    }
                    this.pics.set(f, { img: pic, used: Date.now() });
                    Array.from(this.pics.entries()).filter(([k]) => files.indexOf(k) < 0).sort((a, b) => a[1].used - b[1].used)
                        .slice(0, Math.max(0, this.pics.size - ICONS_KEPT)).forEach(([k, v]) => {
                            this.pics.delete(k);
                            setPicture(k, null);
                            if (v.img) {
                                this.gpu.dropImage(v.img);
                                kit.dropImage(v.img);
                            }
                        });
                    this.refresh(true);
                });
            });
        });
    }

    /* A FrontCCU.statusRotaryEncoderState sample. In embed mode without the
     * controller gate the dial and push come from here while the page has
     * the HMI's focus, until the HMI presses one of the page template's
     * buttons itself (the emulator's HMI routes them neither focus nor
     * presses). An invalid counter keeps the last valid
     * one; a push value other than pushed or released keeps the last state;
     * a new sequence number while pushed is a new push. */
    frontCcu(s) {
        const last = this.fccu;
        const op = s && s.frontRotaryEncoderOperation;
        const push = s && s.frontRotaryEncoderPushButton;
        const seq = s && s.frontSequenceNumberOperatingElement;
        this.fccu = {
            knob: typeof op === 'number' && op !== 0xffff ? op : (last ? last.knob : 0xffff),
            press: PUSHED.indexOf(push) >= 0 ? true : RELEASED.indexOf(push) >= 0 ? false : !!(last && last.press),
            seq: PUSHED.indexOf(push) >= 0 ? seq : last && last.seq,
            tilt: s && s.frontRotaryEncoderDeflection
        };
        if (last && this.mode === 'embed' && !this.controller && !this.embedProxies && !this.focusLost) {
            this._dial(last.knob, this.fccu.knob, PUSHED.indexOf(push) >= 0 &&
                (!last.press || (seq !== undefined && seq !== last.seq)));
            if (TILT[this.fccu.tilt] && TILT[this.fccu.tilt] !== TILT[last.tilt]) {
                this._tilt(TILT[this.fccu.tilt]);
            }
        }
    }

    _ccu(e) {
        const last = this.ccu;
        this.ccu = e;
        if (last) {
            this._dial(last.knob, e.knob, e.press && e.press !== last.press && e.seq !== last.seq);
            if (TILT[e.tilt] && TILT[e.tilt] !== TILT[last.tilt]) {
                this._tilt(TILT[e.tilt]);
            }
        }
    }

    /* Pushed up, down, left or right: the focus to the nearest item that way, by the items' centres (the
     * distance that way, the sideways one counting double). Left with nothing there: back a page, or out
     * of the Store from its top page. Nothing focused yet: the first item. */
    _tilt(dir) {
        if (!this.on_) {
            return;
        }
        const cur = this.items[this.focus];
        if (!cur) {
            if (dir === 'W') {
                this._leave();
            } else if (this.items.length) {
                this.focus = 0;
                this.render();
            }
            return;
        }
        const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
        let best = -1, score = Infinity;
        this.items.forEach((it, i) => {
            if (i === this.focus) {
                return;
            }
            const dx = it.x + it.w / 2 - cx, dy = it.y + it.h / 2 - cy;
            const ahead = dir === 'E' ? dx : dir === 'W' ? -dx : dir === 'S' ? dy : -dy;
            const side = dir === 'E' || dir === 'W' ? Math.abs(dy) : Math.abs(dx);
            if (ahead > 4 && ahead + 2 * side < score) {
                score = ahead + 2 * side;
                best = i;
            }
        });
        if (best >= 0) {
            this.focus = best;
            this.render();
        } else if (dir === 'W') {
            this._leave();
        }
    }

    /* Back a page, or the Store's top page closed (the HMI goes back where it came from). */
    _leave() {
        if (this.stack.length > 1) {
            this.host.act({ do: 'back' });
        } else {
            this.host.closeState(this.hostOf(1));
        }
    }

    /* The dial counter moves the focus, a push presses the focused item. A
     * jump past DIAL_MAX_STEP detents is a stale or garbage sample. */
    _dial(from, to, pushed) {
        if (!this.on_) {
            return;
        }
        const steps = ((to - from + 0x18000) % 0x10000) - 0x8000;
        if (to !== 0xffff && from !== 0xffff && steps !== 0 && Math.abs(steps) <= DIAL_MAX_STEP) {
            this.focus = Math.max(0, Math.min(this.items.length - 1, (this.focus < 0 ? 0 : this.focus + steps)));
            this.render();
        }
        if (pushed && this.items[this.focus]) {
            this.host.act(this.items[this.focus].act);
        }
    }
}

module.exports = { Drawn, DEPTHS, Timing };
