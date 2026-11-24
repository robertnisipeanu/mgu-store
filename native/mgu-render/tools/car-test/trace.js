'use strict';
/**
 * The per-frame trace of one drag as a latency breakdown, on the Mac:
 *
 *   node trace.js <render trace> <store trace> [app]       (app: robertn_store)
 *
 * mgu-render's lines ("<us> R <step> <n> <app>", /run/mgu-render/trace.log) and the Store's ("<us> S <step> <n>
 * <kind>", /dev/shm/robertn_store-trace.log), both on the unit's CLOCK_MONOTONIC. <n> numbers the frames the app
 * sent (build-start, build-end, send; frame-rx, draw-start, draw-end, commit, callback: the frame drawn or shown;
 * frame-same: the picture on screen again, not drawn) and the touches it had (touch-in, touch-fwd; touch), counted
 * from its connection on both sides. Each step's
 * median and p90 (ms) over the frames sent; what a frame waited for before its build (the renderer's TICK or a
 * touch); and the frames sent but never drawn.
 */
const fs = require('fs');

function read(file, side) {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.split(' ')).filter((w) => w[1] === side && w.length >= 4)
        .map((w) => ({ us: Number(w[0]), step: w[2], n: Number(w[3]), rest: w.slice(4).join(' ') }));
}

/* the run of one connection: what follows the earlier connection's last step, the step whose count starts again
 * at 1 */
function lastRun(evs, step) {
    let first = -1;
    evs.forEach((e, i) => { if (e.step === step && e.n === 1) first = i; });
    let from = 0;
    for (let i = first - 1; i >= 0; i--) {
        if (evs[i].step === step) { from = i + 1; break; }
    }
    return first < 0 ? evs : evs.slice(from);
}

function quantile(xs, q) {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
}

function analyse(render, store) {
    const by = (evs, step) => {
        const m = new Map();
        evs.filter((e) => e.step === step).forEach((e) => { if (!m.has(e.n)) m.set(e.n, e); });
        return m;
    };
    const S = { start: by(store, 'build-start'), end: by(store, 'build-end'), send: by(store, 'send'), touch: by(store, 'touch') };
    const R = { rx: by(render, 'frame-rx'), ds: by(render, 'draw-start'), de: by(render, 'draw-end'), commit: by(render, 'commit'),
        cb: by(render, 'callback'), same: by(render, 'frame-same'), tin: by(render, 'touch-in'), tfwd: by(render, 'touch-fwd') };
    const ticks = store.filter((e) => e.step === 'tick');
    const touches = store.filter((e) => e.step === 'touch');
    const steps = [
        ['wait: trigger to build', []], ['build', []], ['build end to send', []], ['send to frame-rx (socket)', []],
        ['frame-rx to draw-start', []], ['draw', []], ['draw-end to commit', []], ['commit to HMI callback', []],
        ['frame to next frame (send to send)', []]];
    const add = (i, a, b) => { if (a && b && b.us >= a.us) steps[i][1].push((b.us - a.us) / 1000); };
    const trig = { tick: 0, touch: 0, none: 0 };
    let notDrawn = 0, same = 0, offClock = 0;
    const sent = [...S.send.keys()].sort((a, b) => a - b);
    sent.forEach((n, k) => {
        const st = S.start.get(n), en = S.end.get(n), se = S.send.get(n), rx = R.rx.get(n);
        // the last TICK or touch the Store had before this build started
        const before = (list) => { let last = null; for (const e of list) { if (st && e.us <= st.us) last = e; else break; } return last; };
        const t = before(ticks), u = before(touches);
        const prev = k ? S.send.get(sent[k - 1]) : null;
        const trigger = [t, u].filter((e) => e && (!prev || e.us >= prev.us)).sort((a, b) => b.us - a.us)[0];
        trig[trigger ? trigger.step : 'none']++;
        add(0, trigger, st);
        add(1, st, en);
        add(2, en, se);
        if (se && rx && rx.us < se.us) offClock++;
        add(3, se, rx);
        if (R.same.has(n)) { same++; return; }
        if (!R.ds.has(n)) { notDrawn++; return; }
        add(4, rx, R.ds.get(n));
        add(5, R.ds.get(n), R.de.get(n));
        add(6, R.de.get(n), R.commit.get(n));
        add(7, R.commit.get(n), R.cb.get(n));
        if (prev) add(8, prev, se);
    });
    const touch = [];
    [...R.tin.keys()].forEach((n) => { const a = R.tin.get(n), b = S.touch.get(n); if (b && b.us >= a.us) touch.push((b.us - a.us) / 1000); });
    const tickIpc = [];
    const rticks = by(render, 'tick');
    ticks.forEach((e) => { const r = rticks.get(e.n); if (r && e.us >= r.us) tickIpc.push((e.us - r.us) / 1000); });
    // per touch: its first drag frame's build, and the Store's work at the release (settle) and ahead (prebuild)
    const builds = (kind) => sent.filter((n) => S.start.has(n) && S.end.has(n) && S.start.get(n).rest === kind)
        .map((n) => (S.end.get(n).us - S.start.get(n).us) / 1000);
    const downs = touches.filter((e) => e.rest === 'down');
    const firstDrag = [];
    downs.forEach((d, i) => {
        const until = i + 1 < downs.length ? downs[i + 1].us : Infinity;
        const n = sent.find((k) => { const s = S.start.get(k); return s && s.rest === 'drag' && s.us >= d.us && s.us < until; });
        if (n !== undefined) firstDrag.push((S.end.get(n).us - S.start.get(n).us) / 1000);
    });
    const pairs = (a, b) => {
        const out = [];
        let open = null;
        store.forEach((e) => {
            if (e.step === a) open = e;
            else if (e.step === b && open) { out.push((e.us - open.us) / 1000); open = null; }
        });
        return out;
    };
    const work = [['whole page builds', builds('whole')], ['drag frames', builds('drag')],
        ['a touch\'s first drag frame', firstDrag], ['release (settle)', pairs('settle-start', 'settle-end')],
        ['drag layers made ahead', pairs('prebuild-start', 'prebuild-end')]];
    return { sent: sent.length, notDrawn, same, offClock, trig, steps, touch, tickIpc, work, touches: downs.length,
        seconds: sent.length > 1 ? (S.send.get(sent[sent.length - 1]).us - S.send.get(sent[0]).us) / 1e6 : 0 };
}

function report(a) {
    const f = (x) => (x === null ? '     -' : x.toFixed(1).padStart(6));
    const row = (name, xs) => `  ${name.padEnd(36)} ${f(quantile(xs, 0.5))} ${f(quantile(xs, 0.9))}  (${xs.length})`;
    const out = [`${a.sent} frames sent in ${a.seconds.toFixed(1)} s (${a.seconds ? (a.sent / a.seconds).toFixed(1) : '-'} a second), ` +
        `${a.notDrawn} never drawn (a newer one drawn in their place), ${a.same} the picture on screen again (not drawn)`,
    `built after: the renderer's TICK ${a.trig.tick}, a touch ${a.trig.touch}, neither ${a.trig.none}`,
    `  ${'step'.padEnd(36)} median    p90  (frames) ms`];
    a.steps.forEach(([name, xs]) => out.push(row(name, xs)));
    out.push(row('TICK: mgu-render to the Store', a.tickIpc));
    out.push(row('touch: mgu-render to the Store', a.touch));
    out.push(`the Store's work, ${a.touches} touches                  median    p90    max  (times) ms`);
    a.work.forEach(([name, xs]) => out.push(`${row(name, xs).replace(/  \((\d+)\)$/, '')} ${xs.length ? Math.max.apply(null, xs).toFixed(1).padStart(6) : '     -'}  (${xs.length})`));
    if (a.offClock) out.push(`warning: ${a.offClock} frames reached mgu-render before the Store sent them: the two clocks differ`);
    return out.join('\n');
}

if (require.main === module) {
    const [renderFile, storeFile, app] = process.argv.slice(2);
    if (!renderFile || !storeFile) {
        console.error('usage: node trace.js <render trace> <store trace> [app]');
        process.exit(2);
    }
    const name = app || 'robertn_store';
    const render = lastRun(read(renderFile, 'R').filter((e) => e.rest === name), 'frame-rx');
    const store = lastRun(read(storeFile, 'S'), 'send');
    if (!render.length || !store.length) {
        console.log(`no trace lines${render.length ? '' : ` from mgu-render for ${name}`}${store.length ? '' : ' from the Store'} ` +
            '(stats-log off, or a renderer or Store without the trace)');
        process.exit(0);
    }
    const t0 = Math.max(render[0].us, store[0].us);
    console.log(report(analyse(render.filter((e) => e.us >= t0), store.filter((e) => e.us >= t0))));
}

module.exports = { read, lastRun, analyse, report, quantile };
