'use strict';
/**
 * The drawn screens after the renderer takes the Store's picture off screen
 * (store_drawn.js _watchStuck, retry): a picture that showed and was taken
 * away (an app install restarts the app manager, which closes the Store's
 * screen meanwhile) gives the widget screens for now, and the drawn screens
 * come back on a timer or when the install ends; one that never showed gives
 * the widget screens until the Store restarts. A fake renderer, short timers.
 *
 *   node tools/test_lost.js
 */
const assert = require('assert');
const path = require('path');
const EventEmitter = require('events');

const Module = require('module');

const HERE = path.join(__dirname, '..');
// the renderer's client is copied beside the sources by the build: the test passes its own (opts.client)
const load = Module._load;
Module._load = function (req) {
    return req === './mgu_render_client.js' ? { RenderClient: class {} } : load.apply(this, arguments);
};
const { Drawn } = require(path.join(HERE, 'src', 'store_drawn.js'));
Module._load = load;
const fixture = require('./fixture.js');

let checks = 0;
const ok = (cond, msg) => { checks += 1; assert(cond, msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* waits until cond() holds (true) or ms have passed (false) */
async function until(cond, ms) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) return false;
        await wait(5);
    }
    return true;
}

/* mgu-render's client: puts the picture on screen when asked, unless the test holds it off. */
class Gpu extends EventEmitter {
    constructor() { super(); this.ready = true; this.visible = false; this.waiting = false; this.off = false; }
    connect() {}
    close() {}
    fps() {}
    mode(m) { if (m) this.wantMode = m; return this.wantMode; }
    place() {}
    claim() {}
    grab() {}
    bridge() {}
    dropLayer() {}
    frame() { return true; }
    show(on) { this.visible = on; setImmediate(() => this.emit('state', { onScreen: on && !this.off })); }
    takeOff() { this.off = true; this.emit('state', { onScreen: false }); }
    putBack() { this.off = false; if (this.visible) this.emit('state', { onScreen: true }); }
}

const INFO = { modes: ['layer'], appArea: { x: 108, y: 82, w: 1790, h: 638 } };

function store(stuckMs, retryMs) {
    const gpu = new Gpu();
    const modes = [];
    const host = {
        log: { info() {}, warn() {}, error() {} },
        model: () => fixture.model({ tab: 'store' }),
        act() {}, set() {}, show() {}, openState() {}, closeState() {},
        hostName: (mode, d) => `host${d}`, proxyName: (mode, d, i) => `p${d}_${i}`, proxies: [1, 1, 1, 1], modes: ['layer']
    };
    const drawn = new Drawn(host, { client: gpu, stuckMs, retryMs, statsLog: '/nonexistent', statsOut: '/dev/null', traceOut: '/dev/null' });
    // the Store maps its tile to the drawn screens on a mode and the HMI then shows their host state
    drawn.on('mode', (m) => { modes.push(m); if (m) setImmediate(() => drawn.hostVisible(1, true)); });
    gpu.emit('ready', { w: 1920, h: 720 }, INFO);
    return { drawn, gpu, modes };
}

async function main() {
    // a picture that showed, taken away: the widget screens for now, the drawn screens again when the install ends
    let s = store(60, 10000);
    ok(await until(() => s.drawn.mode === 'layer' && s.drawn.onScreen, 2000), 'drawn screens on screen');
    s.gpu.takeOff();
    await wait(100);
    ok(s.drawn.mode === null && s.drawn.lost && !s.drawn.stuck, 'taken off screen: widget screens for now, not for good');
    s.gpu.putBack();
    s.drawn.retry();                                    // the install ended (store.js on the updater's state)
    ok(await until(() => s.drawn.mode === 'layer' && s.drawn.onScreen && !s.drawn.lost, 2000), 'the install ended: drawn screens again');
    s.drawn.close();

    // the same on the timer, and a retry that does not show falls back again
    s = store(60, 80);
    await until(() => s.drawn.onScreen, 2000);
    s.gpu.takeOff();
    await wait(100);
    ok(s.drawn.mode === null && s.drawn.lost, 'taken off screen again');
    await wait(160);                                    // the retry (at 80 ms) comes, the picture still off: back to the widget screens
    ok(s.drawn.retries === 1 && s.drawn.mode === null && s.drawn.lost, 'a retry that does not show: widget screens again');
    s.gpu.putBack();                                    // the next retry (twice the wait, 160 ms) shows
    ok(await until(() => s.drawn.mode === 'layer' && s.drawn.onScreen && s.drawn.retries === 0, 2000), 'the next retry shows: drawn screens, retries reset');
    s.drawn.close();

    // a picture that never showed: the widget screens until the Store restarts, no retry
    s = store(60, 50);
    s.gpu.off = true;
    await wait(120);
    ok(s.drawn.mode === null && s.drawn.stuck && !s.drawn.lost, 'never on screen: widget screens for good');
    s.gpu.off = false;
    s.drawn.retry();
    await wait(100);
    ok(s.drawn.mode === null, 'no retry for a picture that never showed');
    s.drawn.close();

    console.log(`lost: ${checks} checks pass`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
