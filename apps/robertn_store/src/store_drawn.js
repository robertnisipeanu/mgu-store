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
const { frame, hit, placement } = require('./store_frame.js');

const DEPTHS = 3;
const ICON_BYTES = 128 * 1024;          // a package picture: at most this big
const ICONS_KEPT = 48;                  // decoded pictures kept, the most recently shown
const FPS = 30;                         // frames a second at most: the screens move little
const KEEPALIVE_MS = 1000;              // the renderer hides an app silent for 3 s
const CLOSED_RESHOW_MS = 700;           // a touch outside that left the page where it was
const DRAG_PX = 14;
const STATS_LOG = '/run/mgu-render/stats-log';  // mgu-render's per-second stats switch: the Store's own then too
const STATS_OUT = '/dev/shm/robertn_store-stats.log';   // where they go (an OAP app's own log goes to DLT)
const STATS_OUT_MAX = 1024 * 1024;              // bytes kept; past it the file starts again
// FrontCCU frontRotaryEncoderPushButton pushed (short, long): by name or ordinal
const PUSHED = ['DREHGEBER_KURZ_GEDRUECKT', 'DREHGEBER_LANG_GEDRUECKT', 1, 2];
const RELEASED = ['KEINE_BETAETIGUNG', 0];
const DIAL_MAX_STEP = 24;

const msNow = () => { const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; };

/* While mgu-render's stats-log is on, once a second a line into out: the frames built and sent, their build and send
 * times, the touch events and the time they took, and the process's CPU, so its share outside drawing shows. */
class Timing {
    constructor(file, out) {
        this.file = file;
        this.out = out;
        this.on = false;
        this._reset();
        this.timer = setInterval(() => this._second(), 1000);
        if (this.timer.unref) this.timer.unref();
    }
    _reset() {
        Object.assign(this, { builds: 0, build: 0, buildMax: 0, frames: 0, send: 0, touches: 0, touchMs: 0 });
        this.cpu = process.cpuUsage();
        this.t0 = msNow();
    }
    _second() {
        fs.access(this.file, (err) => {
            const was = this.on;
            this.on = !err;
            if (was && this.on && (this.builds || this.touches)) {
                const n = this.builds || 1, f = this.frames || 1, c = process.cpuUsage(this.cpu), el = msNow() - this.t0;
                const line = `${new Date().toISOString()} stats store: ${this.builds} builds avg ${(this.build / n).toFixed(1)} ms ` +
                    `max ${this.buildMax.toFixed(1)} ms, ${this.frames} frames sent avg ${(this.send / f).toFixed(1)} ms, ` +
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
        this.gpu = (opts && opts.client) || new RenderClient('robertn_store', this.log, { kit, mode: 'layer' });
        this.gpu.fps(FPS);
        this.timing = new Timing((opts && opts.statsLog) || STATS_LOG, (opts && opts.statsOut) || STATS_OUT);
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
        this.visibleHosts = new Set();      // depths whose host state is visible
        this.focusLost = false;             // the top host state lost the HMI focus (a popup)
        this.suspended = false;             // the HMI's speller is up
        this.closedHide = false;
        this.on_ = false;
        this.dirty = false;
        this.sentAt = 0;
        this.keepalive = null;
        this.touch = null;
        this.ccu = null;
        this.fccu = null;
        this.embedProxies = false;          // the HMI routes presses to embed proxies
        this.pics = new Map();              // picture file -> { img, used }
        this.decoding = new Set();
        this.gpu.on('ready', (screen, info) => this._ready(info));
        this.gpu.on('close', () => this._setMode(null));
        this.gpu.on('tick', () => {
            if (this.dirty) {
                this.render();
            }
        });
        this.gpu.on('touch', (phase, x, y) => this._touch(phase, x, y));
        this.gpu.on('closed', () => {
            this.closedHide = true;
            this.on_ = false;
            setTimeout(() => {
                this.closedHide = false;
                this._updateShow();
            }, CLOSED_RESHOW_MS);
        });
        this.gpu.on('ccu', (e) => this._ccu(e));
    }

    connect() {
        this.gpu.connect();
    }

    /* At shutdown: the connection ends without switching to the widget screens. */
    close() {
        clearInterval(this.keepalive);
        this.timing.close();
        this.gpu.removeAllListeners('close');
        this.gpu.close();
    }

    _ready(info) {
        let mode = null;
        if (info) {
            if (info.modes.indexOf('embed') >= 0 && this.host.modes.indexOf('embed') >= 0) {
                mode = 'embed';
            } else if (info.modes.indexOf('layer') >= 0 && this.host.modes.indexOf('layer') >= 0) {
                mode = 'layer';
            }
        }
        if (mode) {
            const box = mode === 'embed' ? info.embedBox : info.appArea;
            const p = placement(box.w, box.h);
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
        this.visibleHosts.clear();
        this.focusLost = false;
        this.reset();
        this._updateShow();
        this.emit('mode', mode);
    }

    reset() {
        this.stack = [{ name: 'main' }];
        this.focus = 0;
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
        this.render();
        return replaced;
    }

    /* Puts back the page push replaced at DEPTHS, with its focus. */
    restore(page) {
        this.stack[this.stack.length - 1] = page;
        this._backTo();
        this.render();
    }

    pop() {
        if (this.stack.length > 1) {
            const depth = this.stack.length;
            this.stack.pop();
            this._backTo();
            this._bridge();
            this.host.closeState(this.hostOf(depth));
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
        this.render();
    }

    setFilter(filter) {
        this.filter = filter;
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
                this._bridge();
                this.stack.length = depth;
                this._backTo();
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
            this._bridge();
            this.stack.length = depth;
            this._backTo();
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
            this.render();
        }
    }

    proxyPress(depth, i) {
        this._proxyInput();
        if (depth === this.stack.length && this.items[i]) {
            this.focus = i;
            this.host.act(this.items[i].act);
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
     * page over the HMI's box meanwhile, so the box does not go black. */
    _bridge() {
        if (this.mode === 'embed' && this.on_) {
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
        this.gpu.claim(on ? [this.viewport] : []);
        this.gpu.grab(on && !!this.controller);
        if (on) {
            this.render();
        }
        this.gpu.show(on);
        clearInterval(this.keepalive);
        this.keepalive = on ? setInterval(() => this.render(), KEEPALIVE_MS) : null;
    }

    /* Draws the frame (sent while the renderer is ready and the page is
     * shown, one at a time) and writes the top host state's proxies. */
    render() {
        if (!this.mode || !this.w) {
            return;
        }
        const t0 = this.timing.on ? msNow() : 0;
        const m = Object.assign(this.host.model(), { stack: this.stack, tab: this.tab, filter: this.filter });
        const r = frame(m, { textScale: this.scale, focus: this.focus, scroll: this.scroll, layout: this.layout });
        const rec = r.rec;
        this.items = r.items;
        this.regions = r.regions;
        this._proxies();
        this._pictures(r.icons);
        if (t0) {
            const ms = msNow() - t0;
            this.timing.builds++; this.timing.build += ms; this.timing.buildMax = Math.max(this.timing.buildMax, ms);
        }
        if (!this.on_) {
            return;
        }
        const now = Date.now();
        if (this.gpu.waiting && now - this.sentAt < KEEPALIVE_MS) {
            this.dirty = true;
            return;
        }
        this.dirty = false;
        this.sentAt = now;
        const t1 = this.timing.on ? msNow() : 0;
        this.gpu.frame(rec);
        if (t1) { this.timing.frames++; this.timing.send += msNow() - t1; }
    }

    _proxies() {
        const depth = this.stack.length;
        const n = this.host.proxies[depth - 1] || 0;
        for (let i = 0; i < n; i++) {
            const name = this.host.proxyName(this.mode, depth, i);
            const it = this.items[i];
            if (it) {
                this.host.set(name, it.label);
            }
            this.host.show(name, !!it);
        }
    }

    _touch(phase, x, y) {
        const t0 = this.timing.on ? msNow() : 0;
        this._touchEvent(phase, x, y);
        if (t0) { this.timing.touches++; this.timing.touchMs += msNow() - t0; }
    }

    _touchEvent(phase, x, y) {
        if (phase === 'down') {
            this.touch = { x, y, item: hit(this.items, x, y), drag: false, region: this.regions.find((g) =>
                x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h) || null };
            if (this.touch.region) {
                this.touch.from = this.scroll[this.touch.region.key] || 0;
            }
        } else if (this.touch && phase === 'move') {
            const t = this.touch;
            if (!t.drag && t.region && Math.abs(y - t.y) > DRAG_PX) {
                t.drag = true;
            }
            if (t.drag) {
                this.scroll[t.region.key] = Math.max(0, Math.min(t.region.max, t.from + (t.y - y) / t.region.step));
                this.focus = -1;
                if (this.on_ && this.gpu.waiting) {
                    this.dirty = true;          // built on the renderer's TICK
                } else {
                    this.render();
                }
            }
        } else if (this.touch && phase === 'up') {
            const t = this.touch;
            this.touch = null;
            if (!t.drag && t.item >= 0 && hit(this.items, x, y) === t.item) {
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
                    this.render();
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
            seq: PUSHED.indexOf(push) >= 0 ? seq : last && last.seq
        };
        if (last && this.mode === 'embed' && !this.controller && !this.embedProxies && !this.focusLost) {
            this._dial(last.knob, this.fccu.knob, PUSHED.indexOf(push) >= 0 &&
                (!last.press || (seq !== undefined && seq !== last.seq)));
        }
    }

    _ccu(e) {
        const last = this.ccu;
        this.ccu = e;
        if (last) {
            this._dial(last.knob, e.knob, e.press && e.press !== last.press && e.seq !== last.seq);
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
