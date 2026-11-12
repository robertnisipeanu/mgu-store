'use strict';
/**
 * A drag frame (store_frame.js dragFrame: the frame as the drag started and
 * the rows of the Store tab's grid, the Installed tab's list or Settings'
 * Access list over its panel, two cached layers) against the frame built whole at the
 * same scroll, both drawn by mgu-render --replay (Docker, Mesa; the
 * mgu-render-test image and build/host/mgu-render that `make test` in
 * native/mgu-render leaves), at scrolls of whole design pixels, as a drag
 * makes them. At scale 1 (iDrive 7) every pixel is the same; at another
 * scale (iDrive 8, 1.0106) edges land on another fraction of a pixel, so at
 * most SOFT of the pixels lack their colour within a pixel.
 *
 *   node tools/test_drag.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HERE = path.join(__dirname, '..');
const RENDER = path.join(HERE, '..', '..', 'native', 'mgu-render');
const { RenderClient } = require(path.join(HERE, 'lib', 'mgu_render_client.js'));
const kit = require(path.join(HERE, 'src', 'kit_record.js'));
const { frame, dragOf, dragFrame, placement } = require(path.join(HERE, 'src', 'store_frame.js'));
const fixture = require('./fixture.js');

const UNITS = [{ name: 'id7', w: 1796, h: 632 }, { name: 'id8', w: 2880, h: 764 }];
const SOFT = 0.02;

function session(file, unit, send) {
    return new Promise((resolve) => {
        const gpu = new RenderClient('robertn_store', { warn() {}, info() {} }, { file, kit, mode: 'embed' });
        gpu.on('ready', () => {
            const p = placement(unit.w, unit.h);
            gpu.place({ x: 0, y: 0, w: unit.w, h: unit.h, scale: p.scale, ox: p.ox, oy: p.oy });
            send(gpu, p);
            gpu.close();
            resolve();
        });
        gpu.connect();
    });
}

function pixels(file) {
    const pam = fs.readFileSync(file);
    return pam.slice(pam.indexOf('ENDHDR\n') + 7);
}

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'store-drag-'));
    const many = fixture.state();
    for (let i = 0; i < 30; i++) {
        many.components.push(Object.assign({}, many.components[3], { id: `x${i}`, title: `Extra ${i}`, installed: '1.0.0', status: 'installed' }));
    }
    const jobs = [];
    for (const [tab, key] of [['store', 'store.grid'], ['installed', 'installed.apps'], ['settings', 'settings.access']]) {
        const m = fixture.model({ tab }, many);
        for (const unit of UNITS) {
            const p = placement(unit.w, unit.h);
            const d = dragOf(m, { textScale: p.scale, scroll: {}, layout: p.layout }, key);
            if (!d) {
                throw new Error(`${unit.name}: no ${key} on the screen`);
            }
            for (const top of [Math.min(1.5, d.max), Math.min(1.37, d.max * 0.6)].map((t) => Math.round(t * d.step) / d.step)) {
                const base = `${unit.name}-${key}-${top.toFixed(3)}`;
                await session(path.join(out, `${base}-whole.bin`), unit, (gpu) =>
                    gpu.frame(frame(m, { textScale: p.scale, focus: -1, scroll: { [key]: top }, layout: p.layout }).rec));
                await session(path.join(out, `${base}-drag.bin`), unit, (gpu) => {
                    const n = Math.min(d.rows, Math.ceil(d.shown) + 3);
                    const baseL = kit.makeLayer(d.rec.w, d.rec.h, (r) => r.append(d.rec), p.scale);
                    const rowsL = kit.makeLayer(d.box.w, n * d.step, (r) => r.append(d.draw(0, n)), p.scale);
                    gpu.frame(dragFrame(d, baseL, rowsL, 0, top, p.scale));
                });
                jobs.push(base);
            }
        }
    }
    const script = jobs.map((b) => ['whole', 'drag'].map((k) =>
        `build/host/mgu-render --replay /out/${b}-${k}.bin --out /out/${b}-${k}.pam`).join(' && ')).join(' && ');
    const r = cp.spawnSync('docker', ['run', '--rm', '-v', `${RENDER}:/w`, '-v', `${out}:/out`, '-w', '/w', '-u',
        `${process.getuid()}:${process.getgid()}`, 'mgu-render-test', 'sh', '-c', script], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) {
        throw new Error('mgu-render --replay failed');
    }
    const near = (a, i, c, j) => Math.abs(a[i] - c[j]) <= 8 && Math.abs(a[i + 1] - c[j + 1]) <= 8 && Math.abs(a[i + 2] - c[j + 2]) <= 8;
    let bad = 0;
    jobs.forEach((b) => {
        const unit = UNITS.find((u) => b.startsWith(u.name));
        const exact = placement(unit.w, unit.h).scale === 1;
        const a = pixels(path.join(out, `${b}-whole.pam`)), c = pixels(path.join(out, `${b}-drag.pam`));
        const w = unit.w, h = a.length / 4 / w;
        let diff = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (near(a, i, c, i)) {
                    continue;
                }
                let found = false;
                for (let dy = -1; !exact && !found && dy <= 1; dy++) {
                    for (let dx = -1; !found && dx <= 1; dx++) {
                        const yy = y + dy, xx = x + dx;
                        found = yy >= 0 && yy < h && xx >= 0 && xx < w && near(a, (yy * w + xx) * 4, c, i);
                    }
                }
                diff += found ? 0 : 1;
            }
        }
        const ok = a.length === c.length && (exact ? diff === 0 : diff / (w * h) <= SOFT);
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${b}: ${diff} pixels ${exact ? 'differ' : `(${(diff / (w * h) * 100).toFixed(2)} %) with no colour within a pixel`}`);
        bad += ok ? 0 : 1;
    });
    if (process.env.KEEP) console.log(out); else fs.rmSync(out, { recursive: true, force: true });
    if (bad) {
        throw new Error(`${bad} drag frames differ from the frame built whole`);
    }
    console.log(`drag: ${jobs.length} frames as built whole`);
}

main().catch((e) => {
    console.error(`drag: ${e.message}`);
    process.exitCode = 1;
});
