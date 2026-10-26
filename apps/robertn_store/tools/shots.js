'use strict';
/**
 * Screenshots of every drawn screen (tools/fixture.js), without a head unit:
 * each screen goes through lib/mgu_render_client.js into a recorded session
 * (its file sink), which mgu-render draws offscreen (`--replay`) with Mesa
 * in its test image; the result is written as PNG.
 *
 *   (cd native/mgu-render && make test)          # once: the image and build/host/mgu-render
 *   node apps/robertn_store/tools/shots.js <out dir> [<screen name>...]
 *
 * Each screen in iDrive 7's page box (1796x632) and iDrive 8's app area
 * (2880x764), placed as the Store places it: <out>/<unit>-<screen>.png.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const HERE = path.join(__dirname, '..');
const RENDER = path.join(HERE, '..', '..', 'native', 'mgu-render');
const { RenderClient } = require(path.join(HERE, 'lib', 'mgu_render_client.js'));
const kit = require(path.join(HERE, 'src', 'kit_record.js'));
const { frame, placement } = require(path.join(HERE, 'src', 'store_frame.js'));
const fixture = require('./fixture.js');
const { crc32 } = require(path.join(HERE, 'src', 'qr.js'));

const UNITS = [{ name: 'id7', w: 1796, h: 632 }, { name: 'id8', w: 2880, h: 764 }];

function png(w, h, rgba) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function session(file, unit, m) {
    return new Promise((resolve) => {
        const gpu = new RenderClient('robertn_store', { warn() {}, info() {} }, { file, kit, mode: 'embed' });
        gpu.on('ready', () => {
            const p = placement(unit.w, unit.h);
            gpu.place({ x: 0, y: 0, w: unit.w, h: unit.h, scale: p.scale, ox: p.ox, oy: p.oy });
            gpu.frame(frame(m, { textScale: p.scale, focus: m.focus, scroll: {} }).rec);
            gpu.close();
            resolve();
        });
        gpu.connect();
    });
}

async function main() {
    const out = path.resolve(process.argv[2] || 'shots');
    const only = process.argv.slice(3);
    fs.mkdirSync(path.join(out, 'sessions'), { recursive: true });
    const jobs = [];
    for (const unit of UNITS) {
        for (const [name, over, stOver] of fixture.screens()) {
            if (only.length && only.indexOf(name) < 0) {
                continue;
            }
            const base = `${unit.name}-${name}`;
            const st = stOver ? Object.assign(fixture.state(), stOver) : undefined;
            const m = fixture.model(over, st);
            if (unit.name === 'id8' && m.st) {
                m.st.unit = { hmi: 'ID8', firmware: 'BMW MGU-21 example' };
            }
            await session(path.join(out, 'sessions', `${base}.bin`), unit, m);
            jobs.push(base);
        }
    }
    const script = jobs.map((b) => `build/host/mgu-render --replay /out/sessions/${b}.bin --out /out/sessions/${b}.pam`).join(' && ');
    const r = cp.spawnSync('docker', ['run', '--rm', '-v', `${RENDER}:/w`, '-v', `${out}:/out`, '-w', '/w', '-u',
        `${process.getuid()}:${process.getgid()}`, 'mgu-render-test', 'sh', '-c', script], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) {
        throw new Error('mgu-render --replay failed');
    }
    jobs.forEach((b) => {
        const pam = fs.readFileSync(path.join(out, 'sessions', `${b}.pam`));
        const end = pam.indexOf('ENDHDR\n') + 7;
        const head = pam.slice(0, end).toString();
        const w = Number(/WIDTH (\d+)/.exec(head)[1]);
        const h = Number(/HEIGHT (\d+)/.exec(head)[1]);
        fs.writeFileSync(path.join(out, `${b}.png`), png(w, h, pam.slice(end)));
    });
    console.log(`${jobs.length} screenshots in ${out}`);
}

main().catch((e) => {
    console.error(`shots: ${e.message}`);
    process.exitCode = 1;
});
