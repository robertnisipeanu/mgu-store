'use strict';
/**
 * mgu_render_client.js - an app's connection to mgu-render (PROTOCOL.md), the native dialect
 * (mgu-render/1). Node 8; needs only net, fs and events.
 *
 *   // RenderClient: this module's; kit (optional): a kit's record.js. No literal require
 *   // names here: the OAP linker (tools/oap_link.js) reads them as the module's own.
 *   const gpu = new RenderClient('my_app', log, { kit });
 *   gpu.on('ready', (screen, info) => {
 *       gpu.mode(info.modes.indexOf('embed') >= 0 ? 'embed' : 'layer');
 *       const box = gpu.mode() === 'embed' ? info.embedBox : info.appArea;
 *       gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, ox: 0, oy: 0 });
 *   });
 *   gpu.on('tick', () => gpu.frame(recorder));        // or gpu.frameWords(Uint32Array of draw ops)
 *   gpu.show(true);
 *
 * Modes: 'layer' (own layer over the HMI, placed in screen pixels) or 'embed' (inside the app's HMI
 * page on the page template LT_State_A4A_WelcomeApp; placement x, y are the box's, w, h its size).
 * The app picks one; info.modes lists what the renderer offers now.
 *
 * Pixel apps (a game, a software-drawn canvas; kept and sent again after a reconnect or a new size): pixmap(id, w, h, 'index8' | 'rgba' | 'rgbx', 'nearest' |
 * 'linear'), then pixels(id, rects, data) for the regions that changed, palette(id, rgb768) for INDEX8,
 * and draw it with an IMAGE op (x y w h r id) in each frame - imageOp() builds one.
 *
 * Events: ready (screen, info), tick (n, ms), touch (phase, x, y), closed, state ({ mode, onScreen,
 * front }), ccu ({ seq, knob, press, tilt, raw }), stats, close. With `kit` (idrive7-apps / IterioDev
 * record.js), frame(recorder) uploads the fonts, ramps, layers and pictures a recording uses once per
 * connection; least-recently-used pictures are dropped to stay in the renderer's limits.
 *
 * From IterioDev's kit renderd.js (idrive7-apps kit/runtime/renderd.js, MIT, Copyright (c) 2026
 * cauliflowermossgrape, with IterioDev's touch and pictures, ported with permission).
 */
const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');

const SOCKET = process.env.MGU_RENDERD_SOCKET || '/run/mgu-renderd/renderd.sock';
const M = { HELLO: 1, PLACE: 2, SHOW: 3, ATLAS: 4, RAMP: 5, LAYER: 6, FRAME: 7, DROP_LAYER: 8, CLAIM: 9, IMAGE: 10, DROP_IMAGE: 11 };
const X = { MODE: 0x4d520001, GRAB: 0x4d520002, PIXMAP: 0x4d520003, PIXELS: 0x4d520004, PALETTE: 0x4d520005,
    READY: 0x4d520101, STATE: 0x4d520102, CCU: 0x4d520103 };
const E = { READY: 101, TICK: 102, ERROR: 103, STATS: 104, TOUCH: 105, CLOSED: 106 };
const MODES = { layer: 1, embed: 2 };
const MODE_NAMES = [null, 'layer', 'embed'];
const FORMATS = { rgba: 1, rgbx: 2, index8: 3 };
const CAPS = { touch: 1, controller: 2, frontGate: 4, pixmap: 8 };
const PHASES = [null, 'down', 'move', 'up'];
const IMG_MAX = 64, IMG_BYTES = 32 << 20;
const OP_IMAGE = 18;

function msg(type, payload) {
    const len = payload ? payload.length : 0;
    const b = Buffer.alloc(8 + len + ((4 - (len & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4);
    if (len) payload.copy(b, 8);
    return b;
}
function words(u32) { return Buffer.from(u32.buffer, u32.byteOffset, u32.byteLength); }
function u32msg(type, arr) { return msg(type, words(new Uint32Array(arr))); }
function premultiply(d) {
    const b = Buffer.allocUnsafe(d.length);
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        b[i] = (d[i] * a + 127) / 255; b[i + 1] = (d[i + 1] * a + 127) / 255; b[i + 2] = (d[i + 2] * a + 127) / 255; b[i + 3] = a;
    }
    return b;
}
function rect(b, at) { return { x: b.readInt32LE(at), y: b.readInt32LE(at + 4), w: b.readInt32LE(at + 8), h: b.readInt32LE(at + 12) }; }

/** The words of one IMAGE op: picture or pixmap `id` over x, y, w, h (logical px), corner radius r. */
function imageOp(id, x, y, w, h, r) {
    const f = new Float32Array([x, y, w, h, r || 0]);
    const u = new Uint32Array(7);
    u[0] = OP_IMAGE; u.set(new Uint32Array(f.buffer), 1); u[6] = id;
    return u;
}

class RenderClient extends EventEmitter {
    constructor(appId, log, opts) {
        super();
        this.appId = appId;
        this.log = log || console;
        this.opts = opts || {};
        this.kit = this.opts.kit || null;
        this.sock = null;
        this.connected = false;
        this.ready = false;
        this.native = false;          // the renderer speaks mgu-render/1 (X_READY came)
        this.info = null;
        this.screen = { w: 1920, h: 720 };
        this.placement = null;
        this.visible = false;
        this.wantMode = this.opts.mode || 'layer';
        this.claims = [];
        this.grabbing = false;
        this.inbuf = Buffer.alloc(0);
        this.sent = { atlas: new Set(), ramp: new Set(), layer: new Set(), image: new Map() };
        this.imageBytes = 0;
        this.useSeq = 0;
        this.pixmaps = new Map();     // id -> { w, h, format, filter, palette, last }
        this.waiting = false;
        this.retry = null;
        this.closed = false;
        this.fd = null;               // file sink (opts.file): every message, for mgu-render --replay
    }

    static available(path) { try { return fs.statSync(path || SOCKET).isSocket(); } catch (e) { return false; } }

    connect() {
        const hello = msg(M.HELLO, Buffer.concat([Buffer.from(this.appId), Buffer.from([0]), Buffer.from('proto=mgu-render/1')]));
        if (this.opts.file) {
            this.fd = fs.openSync(this.opts.file, 'w');
            this.connected = this.ready = this.native = true;
            this._write(hello);
            this._write(u32msg(X.MODE, [MODES[this.wantMode]]));
            setImmediate(() => this.emit('ready', this.screen, null));
            return this;
        }
        const s = net.createConnection(this.opts.socket || SOCKET);
        this.sock = s;
        s.on('connect', () => {
            this.connected = true;
            this._reset();
            s.setNoDelay(true);
            this._write(hello);
        });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => { if (!this.errLogged) { this.errLogged = true; this.log.warn('mgu-render: ' + e.message); } });
        s.on('close', () => {
            const was = this.ready;
            this.connected = this.ready = this.native = false; this.sock = null; this.waiting = false;
            if (was) { this.log.warn('mgu-render: connection closed'); this.emit('close'); }
            if (!this.closed) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 3000);
        });
        return this;
    }
    close() {
        this.closed = true;
        if (this.retry) clearTimeout(this.retry);
        if (this.grabTimer) clearInterval(this.grabTimer);
        if (this.sock) this.sock.destroy();
        if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
    }
    _reset() {
        this.sent.atlas.clear(); this.sent.ramp.clear(); this.sent.layer.clear(); this.sent.image.clear();
        this.imageBytes = 0; this.waiting = false;
    }
    _write(b) {
        if (this.fd !== null) { fs.writeSync(this.fd, b); return true; }
        return this.sock && this.connected ? this.sock.write(b) : false;
    }

    _data(d) {
        this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
        while (this.inbuf.length >= 8) {
            const type = this.inbuf.readUInt32LE(0), len = this.inbuf.readUInt32LE(4);
            if (this.inbuf.length < 8 + len) break;
            const p = this.inbuf.slice(8, 8 + len);
            this.inbuf = this.inbuf.slice(8 + len);
            this._event(type, p);
        }
    }
    _event(type, p) {
        if (type === X.READY && p.length >= 52) {
            const modes = [], caps = p.readUInt32LE(8);
            if (p.readUInt32LE(4) & 1) modes.push('layer');
            if (p.readUInt32LE(4) & 2) modes.push('embed');
            this.native = true;
            this.info = {
                version: p.readUInt32LE(0), modes, embedBox: rect(p, 12), appArea: rect(p, 28),
                pixmapSide: p.readUInt32LE(44), refreshMhz: p.readUInt32LE(48),
                touch: !!(caps & CAPS.touch), controller: !!(caps & CAPS.controller),
                frontGate: !!(caps & CAPS.frontGate), pixmap: !!(caps & CAPS.pixmap),
            };
        } else if (type === E.READY) {
            this.ready = true; this.errLogged = false;
            this.screen = { w: p.readUInt32LE(4), h: p.readUInt32LE(8) };
            if (!this.native) {
                this.log.warn('mgu-render: the renderer does not speak mgu-render/1');
                this.info = null;
            } else {
                this._write(u32msg(X.MODE, [MODES[this.wantMode]]));
                if (this.placement) this._sendPlace();
                this._sendPixmaps();
                if (this.claims.length) this._sendClaim();
                if (this.visible) this._write(u32msg(M.SHOW, [1]));
                if (this.grabbing) this._write(u32msg(X.GRAB, [1]));
            }
            this.emit('ready', this.screen, this.info);
        } else if (type === E.TOUCH) {
            if (PHASES[p.readUInt32LE(0)]) this.emit('touch', PHASES[p.readUInt32LE(0)], p.readFloatLE(4), p.readFloatLE(8));
        } else if (type === E.CLOSED) {
            this.visible = false;
            this.emit('closed');
        } else if (type === X.STATE) {
            this.emit('state', { mode: MODE_NAMES[p.readUInt32LE(0)], onScreen: !!p.readUInt32LE(4), front: !!p.readUInt32LE(8) });
        } else if (type === X.CCU && p.length >= 5) {
            this.emit('ccu', { seq: p[0], knob: p.readUInt16BE(1), press: p[3], tilt: p[4], raw: Buffer.from(p) });
        } else if (type === E.TICK) {
            this.waiting = false;
            this.emit('tick', p.readUInt32LE(0), p.readUInt32LE(4));
        } else if (type === E.STATS) {
            this.stats = { fps: p.readUInt32LE(0), avgUs: p.readUInt32LE(4), maxUs: p.readUInt32LE(8) };
            this.emit('stats', this.stats);
        } else if (type === E.ERROR) {
            this.log.warn('mgu-render error: ' + p.toString());
            this.emit('renderer-error', p.toString());
        }
    }

    /** 'layer' | 'embed' (or no argument: the mode asked for). */
    mode(m) {
        if (m === undefined) return this.wantMode;
        if (!MODES[m]) throw new Error('mode: layer or embed');
        if (m === this.wantMode) return m;
        this.wantMode = m;
        if (this.ready && this.native) this._write(u32msg(X.MODE, [MODES[m]]));
        return m;
    }

    place(pl) {
        const resize = !this.placement || pl.w !== this.placement.w || pl.h !== this.placement.h;
        if (this.placement && !resize && ['x', 'y', 'scale', 'ox', 'oy'].every((k) => pl[k] === this.placement[k])) return;
        const scaleChanged = this.placement && this.placement.scale !== pl.scale;
        this.placement = Object.assign({}, pl);
        if (resize || scaleChanged) this._reset();
        if (!this.ready || !this.native) return;
        this._sendPlace();
        if (resize) this._sendPixmaps();       // the renderer dropped them with the old size
    }
    _sendPlace() {
        const p = this.placement, b = Buffer.alloc(28);
        b.writeInt32LE(p.x | 0, 0); b.writeInt32LE(p.y | 0, 4); b.writeInt32LE(p.w | 0, 8); b.writeInt32LE(p.h | 0, 12);
        b.writeFloatLE(p.scale || 1, 16); b.writeFloatLE(p.ox || 0, 20); b.writeFloatLE(p.oy || 0, 24);
        this._write(msg(M.PLACE, b));
    }
    show(on) {
        on = !!on;
        if (on === this.visible) return;
        this.visible = on;
        if (this.ready && this.native) this._write(u32msg(M.SHOW, [on ? 1 : 0]));
    }
    /** Touch areas, logical px ([] = none): while shown, touch there is this app's. */
    claim(rects) {
        this.claims = (rects || []).slice(0, 16);
        if (this.ready && this.native) this._sendClaim();
    }
    _sendClaim() {
        const b = Buffer.alloc(4 + this.claims.length * 16);
        b.writeUInt32LE(this.claims.length, 0);
        this.claims.forEach((r, i) => [r.x, r.y, r.w, r.h].forEach((v, k) => b.writeFloatLE(v, 4 + i * 16 + k * 4)));
        this._write(msg(M.CLAIM, b));
    }
    /** The iDrive controller to this app while it is shown (needs the HMI's controller gate: info.controller). */
    grab(on) {
        on = !!on;
        if (on === this.grabbing) return;
        this.grabbing = on;
        if (this.grabTimer) { clearInterval(this.grabTimer); this.grabTimer = null; }
        if (on) this.grabTimer = setInterval(() => { if (this.ready && this.native) this._write(u32msg(X.GRAB, [1])); }, 500);
        if (this.ready && this.native) this._write(u32msg(X.GRAB, [on ? 1 : 0]));
    }

    /* ---- pixel images ---- */
    pixmap(id, w, h, format, filter) {
        const pm = { w, h, format: FORMATS[format || 'rgba'], filter: filter === 'linear' ? 1 : 0, palette: null };
        if (!pm.format) throw new Error('pixmap format: rgba, rgbx or index8');
        this.pixmaps.set(id, pm);
        if (this.ready && this.native) this._sendPixmap(id, pm);
    }
    _sendPixmaps() { this.pixmaps.forEach((pm, id) => this._sendPixmap(id, pm)); }
    _sendPixmap(id, pm) {
        this._write(u32msg(X.PIXMAP, [id, pm.w, pm.h, pm.format, pm.filter]));
        if (pm.palette) this._write(msg(X.PALETTE, Buffer.concat([words(new Uint32Array([id])), pm.palette])));
        if (pm.last) this.pixels(id, [{ x: 0, y: 0, w: pm.w, h: pm.h }], pm.last);
    }
    /**
     * Regions of pixmap id: rects [{ x, y, w, h }], data = the whole picture (w*h*bpp, rows top-down)
     * from which the rects are cut. Returns false when not connected.
     */
    pixels(id, rects, data) {
        const pm = this.pixmaps.get(id);
        if (!pm) throw new Error('pixels: no pixmap ' + id);
        pm.last = data;
        if (!this.ready || !this.native) return false;
        const bpp = pm.format === FORMATS.index8 ? 1 : 4;
        const rs = rects.slice(0, 64), parts = [];
        const head = new Uint32Array(2 + rs.length * 4);
        head[0] = id; head[1] = rs.length;
        rs.forEach((r, i) => {
            head.set([r.x, r.y, r.w, r.h], 2 + i * 4);
            for (let y = 0; y < r.h; y++) {
                const at = ((r.y + y) * pm.w + r.x) * bpp;
                parts.push(Buffer.from(data.buffer, data.byteOffset + at, r.w * bpp));
            }
        });
        return this._write(msg(X.PIXELS, Buffer.concat([words(head)].concat(parts))));
    }
    /** INDEX8 colours: 768 bytes RGB. */
    palette(id, rgb) {
        const pm = this.pixmaps.get(id);
        if (!pm) throw new Error('palette: no pixmap ' + id);
        pm.palette = Buffer.from(rgb.buffer ? Buffer.from(rgb.buffer, rgb.byteOffset, 768) : rgb);
        if (this.ready && this.native) this._write(msg(X.PALETTE, Buffer.concat([words(new Uint32Array([id])), pm.palette])));
    }

    /* ---- kit resources (record.js) ---- */
    _ensureAtlas(id) {
        if (this.sent.atlas.has(id)) return;
        const f = this.kit.atlasById(id);
        if (!f) return;
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeUInt32LE(f.atlasW, 4); head.writeUInt32LE(f.atlasH, 8);
        this._write(msg(M.ATLAS, Buffer.concat([head, f.alpha])));
        this.sent.atlas.add(id);
    }
    _ensureRamp(id) {
        if (this.sent.ramp.has(id)) return;
        const stops = this.kit.rampList[id];
        if (!stops) return;
        const u = new Uint32Array(2 + stops.length);
        u[0] = id; u[1] = stops.length;
        stops.forEach((c, i) => { u[2 + i] = this.kit.pack(c); });
        this._write(msg(M.RAMP, words(u)));
        this.sent.ramp.add(id);
    }
    _ensureRes(r) {
        if (!this.kit) return;
        if (r.atlases) r.atlases.forEach((id) => this._ensureAtlas(id));
        if (r.ramps) r.ramps.forEach((id) => this._ensureRamp(id));
        if (r.images) r.images.forEach((id) => this._ensureImage(id, r.images));
        if (r.layersUsed || r.sublayers) (r.layersUsed || r.sublayers).forEach((id) => this._ensureLayer(id));
    }
    _ensureLayer(id) {
        if (this.sent.layer.has(id)) return;
        const L = this.kit.layerById.get(id);
        if (!L) return;
        this._ensureRes(L);
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeFloatLE(L.w, 4); head.writeFloatLE(L.h, 8);
        this._write(msg(M.LAYER, Buffer.concat([head, words(L.words)])));
        this.sent.layer.add(id);
    }
    dropLayer(id) {
        if (this.sent.layer.delete(id) && this.ready) this._write(u32msg(M.DROP_LAYER, [id]));
    }
    _ensureImage(id, keep) {
        const have = this.sent.image.get(id);
        if (have) { have.used = this.useSeq; return; }
        const img = this.kit.imageById && this.kit.imageById.get(id);
        if (!img) return;
        const bytes = img.w * img.h * 4;
        while (this.sent.image.size >= IMG_MAX || this.imageBytes + bytes > IMG_BYTES) {
            let old = null;
            for (const [k, v] of this.sent.image) {
                if (!keep.has(k) && !(this.frameImages && this.frameImages.has(k)) && (!old || v.used < old[1].used)) old = [k, v];
            }
            if (!old) return;            // all held pictures are on this frame: this one draws nothing
            this._dropSent(old[0]);
        }
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeUInt32LE(img.w, 4); head.writeUInt32LE(img.h, 8);
        this._write(msg(M.IMAGE, Buffer.concat([head, premultiply(img.data)])));
        this.sent.image.set(id, { bytes, used: this.useSeq });
        this.imageBytes += bytes;
    }
    _dropSent(id) {
        const s = this.sent.image.get(id);
        if (!s) return;
        this.sent.image.delete(id); this.imageBytes -= s.bytes;
        if (this.ready) this._write(u32msg(M.DROP_IMAGE, [id]));
    }
    dropImage(img) { this._dropSent(img.imageId); }

    /** Send a recorded frame (record.js Recorder). Returns false if not connected. */
    frame(r) {
        if (!this.ready || !this.native || !this.placement) return false;
        this.useSeq++;
        this.frameImages = r.images;
        this._ensureRes(r);
        this.frameImages = null;
        return this.frameWords(r.words());
    }
    /** Send a frame of draw op words (Uint32Array). */
    frameWords(u32) {
        if (!this.ready || !this.native || !this.placement) return false;
        this.waiting = true;
        return this._write(msg(M.FRAME, words(u32)));
    }
}

module.exports = { RenderClient, SOCKET, imageOp, OP_IMAGE };
