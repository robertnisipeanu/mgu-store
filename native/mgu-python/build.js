#!/usr/bin/env node
'use strict';
/**
 * mgu-python's build (component.json "build"): a CPython for the head unit,
 * for repositories whose apps build with Python (README.md).
 *
 *   node build.js        -> build/python/ (the files component.json lists)
 *
 * Takes one pinned python-build-standalone release (x86_64-unknown-linux-gnu,
 * install_only_stripped: an interpreter with libpython and its libraries
 * built in, which needs the system's glibc 2.17 or newer; the unit has
 * 2.27), checked by sha256, and keeps:
 *   bin/python3                          the interpreter, its loader set to
 *                                        the unit's /lib/ld-linux-x86-64.so.2
 *                                        (the unit has no /lib64)
 *   lib/python312.zip                    the standard library's .py and .pyc files,
 *                                        without the GUI, test, packaging and
 *                                        IDE parts (Python imports from it)
 *   lib/python3.12/lib-dynload/.empty    the folder Python looks for its
 *                                        extension modules in (all built in)
 *   ssl/cacert.pem                       certifi's CA bundle, for builds that
 *                                        download (SSL_CERT_FILE)
 *   LICENSES.txt                         the licences of CPython, of every
 *                                        library built into it (from the same
 *                                        release's full distribution, whose
 *                                        python/licenses/ the install_only one
 *                                        lacks) and of certifi
 * The downloads are kept in build/download/ and reused while their sha256
 * matches. Node 10 or newer, the system's tar (with zstd) and a Python 3.12
 * (PY312, uv or PATH) to precompile the .pyc.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const crypto = require('crypto');
const cp = require('child_process');

const RELEASE = '20261003';
const NAME = 'cpython-3.12.15+20261003-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz';
const SHA256 = '731af898886c5f821890dc901eca3c651cca8e51fa7308c159d12a1194aeac91';
const FULL = 'cpython-3.12.15+20261003-x86_64-unknown-linux-gnu-pgo+lto-full.tar.zst';
const FULL_SHA256 = 'aaeeeeea4f98a41c7acd7379229a374c201aee45c1954be5788c18af83733d2b';
const url = (name) => `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${encodeURIComponent(name)}`;
const STDLIB = 'python3.12';
const ZIP = 'python312.zip';
const LOADER = '/lib/ld-linux-x86-64.so.2';

/* Left out of the zip: the standard library's top-level entries a build
 * script has no use for (GUI, IDE, tests, pip, 2to3, docs), and every test
 * folder. */
const DROP = ['site-packages', 'idlelib', 'tkinter', 'turtledemo', 'turtle.py', 'ensurepip', 'lib2to3', 'pydoc_data',
    `config-3.12-x86_64-linux-gnu`, 'venv', 'lib-dynload', 'test', '__phello__', 'antigravity.py', 'this.py', 'LICENSE.txt'];
const DROP_DIRS = ['test', 'tests', 'idle_test'];

const HERE = __dirname;
const BUILD = path.join(HERE, 'build');
const OUT = path.join(BUILD, 'python');

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rmrf(p) {
    let st;
    try {
        st = fs.lstatSync(p);
    } catch (e) {
        return;
    }
    if (st.isDirectory()) {
        fs.readdirSync(p).forEach((n) => rmrf(path.join(p, n)));
        fs.rmdirSync(p);
    } else {
        fs.unlinkSync(p);
    }
}

function mkdirp(dir) {
    if (!fs.existsSync(dir)) {
        mkdirp(path.dirname(dir));
        fs.mkdirSync(dir);
    }
}

function get(url, file, redirects) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'mgu-python-build' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
                res.resume();
                resolve(get(new (require('url').URL)(res.headers.location, url).toString(), file, redirects + 1));
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`${url}: HTTP ${res.statusCode}`));
                return;
            }
            const out = fs.createWriteStream(file);
            res.pipe(out);
            out.on('finish', () => resolve());
            out.on('error', reject);
        }).on('error', reject);
    });
}

function download(name, want) {
    const dir = path.join(BUILD, 'download');
    const file = path.join(dir, name);
    if (fs.existsSync(file) && sha256(file) === want) {
        return Promise.resolve(file);
    }
    mkdirp(dir);
    process.stderr.write(`mgu-python: downloading ${url(name)}\n`);
    return get(url(name), `${file}.part`, 0).then(() => {
        const got = sha256(`${file}.part`);
        if (got !== want) {
            throw new Error(`${name}: sha256 ${got}, expected ${want}`);
        }
        fs.renameSync(`${file}.part`, file);
        return file;
    });
}

/* An x86-64 ELF executable's loader (its PT_INTERP) set to `loader`, in
 * place: the segment keeps its size, the rest of it zeros. */
function setLoader(buf, loader) {
    if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 2 || buf[5] !== 1 || buf.readUInt16LE(18) !== 62) {
        throw new Error('not an x86-64 ELF');
    }
    const u64 = (at) => buf.readUInt32LE(at) + buf.readUInt32LE(at + 4) * 0x100000000;
    const phoff = u64(32);
    const phentsize = buf.readUInt16LE(54);
    for (let i = 0; i < buf.readUInt16LE(56); i += 1) {
        const ph = phoff + i * phentsize;
        if (buf.readUInt32LE(ph) === 3) { // PT_INTERP
            const off = u64(ph + 8);
            const size = u64(ph + 32);
            if (Buffer.byteLength(loader) + 1 > size) {
                throw new Error(`${loader} does not fit the ${size}-byte loader path`);
            }
            buf.fill(0, off, off + size);
            buf.write(loader, off);
            return buf;
        }
    }
    throw new Error('no loader path (PT_INTERP)');
}

/* ---- a zip of stored paths (deflate, fixed times: the same input, the same bytes) ---- */
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i += 1) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
}

function zip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
    entries.forEach((e) => {
        const name = Buffer.from(e.name);
        const data = zlib.deflateRawSync(e.data, { level: 9 });
        const crc = crc32(e.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        const head = Buffer.alloc(46);
        head.writeUInt32LE(0x02014b50, 0);
        head.writeUInt16LE(0x0314, 4); // made by: Unix
        head.writeUInt16LE(20, 6);
        head.writeUInt16LE(0, 8);
        head.writeUInt16LE(8, 10);
        head.writeUInt16LE(0, 12);
        head.writeUInt16LE(DOS_DATE, 14);
        head.writeUInt32LE(crc, 16);
        head.writeUInt32LE(data.length, 20);
        head.writeUInt32LE(e.data.length, 24);
        head.writeUInt16LE(name.length, 28);
        head.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
        head.writeUInt32LE(offset, 42);
        parts.push(local, name, data);
        central.push(head, name);
        offset += local.length + name.length + data.length;
    });
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat(parts.concat([cd, end]));
}

/* The .py files under dir (relative names, sorted), the dropped parts left out. */
function stdlibFiles(dir) {
    const out = [];
    const walk = (rel) => {
        fs.readdirSync(path.join(dir, rel)).sort().forEach((n) => {
            const r = rel ? `${rel}/${n}` : n;
            const st = fs.lstatSync(path.join(dir, r));
            if ((!rel && DROP.indexOf(n) >= 0) || n === '__pycache__') {
                return;
            }
            if (st.isDirectory()) {
                if (DROP_DIRS.indexOf(n) < 0) {
                    walk(r);
                }
            } else if (st.isFile() && /\.py$/.test(n)) {
                out.push(r);
            }
        });
    };
    walk('');
    return out;
}

/* A Python 3.12 on the build machine for compileall: $PY312, else uv's, else python3.12 on PATH. */
function hostPython() {
    const cands = [process.env.PY312];
    try { cands.push(cp.execFileSync('uv', ['python', 'find', '3.12'], { encoding: 'utf8' }).trim()); } catch (e) { /* no uv */ }
    cands.push('python3.12');
    for (const c of cands.filter(Boolean)) {
        try {
            if (cp.execFileSync(c, ['-c', 'import sys; print(sys.version_info[:2] == (3, 12))'], { encoding: 'utf8' }).trim() === 'True') return c;
        } catch (e) { /* next */ }
    }
    throw new Error('a host Python 3.12 is needed to precompile the standard library (set PY312)');
}

function main() {
    return Promise.all([download(NAME, SHA256), download(FULL, FULL_SHA256)]).then(([tgz, full]) => {
        const stage = path.join(BUILD, 'stage');
        rmrf(stage);
        rmrf(OUT);
        mkdirp(stage);
        cp.execFileSync('tar', ['-xzf', tgz, '-C', stage]);
        cp.execFileSync('tar', ['-xf', full, '-C', stage, 'python/licenses']);
        const py = path.join(stage, 'python');
        const lib = path.join(py, 'lib', STDLIB);
        const copy = (from, to, mode) => {
            mkdirp(path.dirname(path.join(OUT, to)));
            fs.writeFileSync(path.join(OUT, to), fs.readFileSync(path.join(py, from)), { mode });
        };
        mkdirp(path.join(OUT, 'bin'));
        fs.writeFileSync(path.join(OUT, 'bin', 'python3'), setLoader(fs.readFileSync(path.join(py, 'bin', STDLIB)), LOADER), { mode: 0o755 });
        const files = stdlibFiles(lib);
        // .pyc beside each .py (legacy layout, the one zipimport reads; unchecked hash: no mtime to match), so
        // the unit doesn't compile ~250 stdlib modules at every start (~4 s on its Atom). Needs a host 3.12.
        const host = hostPython();
        cp.execFileSync(host, ['-I', '-m', 'compileall', '-q', '-b', '--invalidation-mode', 'unchecked-hash', '-d', '',
            ...files.map((f) => path.join(lib, f))], { stdio: ['ignore', 'ignore', 'inherit'] });
        const entries = [];
        files.forEach((name) => {
            entries.push({ name, data: fs.readFileSync(path.join(lib, name)) });
            const pyc = path.join(lib, name + 'c');
            if (fs.existsSync(pyc)) entries.push({ name: name + 'c', data: fs.readFileSync(pyc) });
        });
        mkdirp(path.join(OUT, 'lib'));
        fs.writeFileSync(path.join(OUT, 'lib', ZIP), zip(entries));
        mkdirp(path.join(OUT, 'lib', STDLIB, 'lib-dynload'));
        fs.writeFileSync(path.join(OUT, 'lib', STDLIB, 'lib-dynload', '.empty'), '');
        const certifi = `lib/${STDLIB}/site-packages/pip/_vendor/certifi`;
        copy(`${certifi}/cacert.pem`, 'ssl/cacert.pem', 0o644);
        const licences = path.join(py, 'licenses');
        const texts = fs.readdirSync(licences).sort().map((n) => [n, fs.readFileSync(path.join(licences, n))])
            .concat([['LICENSE.certifi.txt (ssl/cacert.pem)', fs.readFileSync(path.join(py, certifi, 'LICENSE'))]]);
        fs.writeFileSync(path.join(OUT, 'LICENSES.txt'), Buffer.concat(texts.map(([n, t]) =>
            Buffer.concat([Buffer.from(`==== ${n} ====\n\n`), t, Buffer.from('\n\n')]))));
        rmrf(stage);
        process.stderr.write(`mgu-python: ${NAME}: ${files.length} stdlib modules in lib/${ZIP}\n`);
    });
}

main().catch((err) => {
    process.stderr.write(`mgu-python: ${err.message}\n`);
    process.exit(1);
});
