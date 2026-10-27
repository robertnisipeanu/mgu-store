'use strict';
/**
 * Packs an app's staged tree into its flat OAP tgz: the package.json files[]
 * expansion at the archive root (no package/ prefix), regular files only,
 * sorted, ustar headers with owner 0:0, mode 0644 and one fixed mtime, gzip
 * with no name, no time and the OS byte set to Unix. The bytes depend only
 * on the tree (and the zlib build), not on the machine or the time, and the
 * archive cannot carry macOS extended attributes, which the head unit's tar
 * refuses. Finder metadata (.DS_Store, ._*) is never packed. Node 8; the
 * deploy tool ships this file to build source packages on the head unit.
 *
 *   const { pack } = require('<repo>/tools/oap_pack.js');
 *   pack(stagedDir, outFile)   // -> the packed paths
 *
 * tgz(entries, mtime) is the same writer for any list of
 * { name, data, mode } (deploy/hu packs tool artifacts with it).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MTIME = Math.floor(Date.UTC(2026, 9, 18) / 1000);
const GZIP_OS_BYTE = 9;
const GZIP_OS_UNIX = 3;

function members(pkgDir, pkg) {
    const out = [];
    const skip = (name) => name === '.DS_Store' || name.startsWith('._');
    pkg.files.forEach((entry) => {
        const full = path.join(pkgDir, entry);
        if (!fs.existsSync(full)) {
            throw new Error(`${pkgDir}: package.json files[] names ${entry}, which is missing`);
        }
        if (fs.statSync(full).isFile()) {
            out.push(entry);
            return;
        }
        (function walk(dir) {
            fs.readdirSync(dir).sort().forEach((name) => {
                if (skip(name)) {
                    return;
                }
                const p = path.join(dir, name);
                if (fs.statSync(p).isDirectory()) {
                    walk(p);
                } else {
                    out.push(path.relative(pkgDir, p).split(path.sep).join('/'));
                }
            });
        }(full));
    });
    return [...new Set(out)].sort();
}

function header(name, size, mode, mtime) {
    const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
    const h = Buffer.alloc(512);
    let prefix = '';
    let base = name;
    if (Buffer.byteLength(name) > 100) {
        const cut = name.lastIndexOf('/', 155);
        prefix = name.slice(0, cut);
        base = name.slice(cut + 1);
    }
    h.write(base, 0, 100, 'utf8');
    h.write(octal(mode, 8), 100);
    h.write(octal(0, 8), 108);
    h.write(octal(0, 8), 116);
    h.write(octal(size, 12), 124);
    h.write(octal(mtime, 12), 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
        sum += h[i];
    }
    h.write(octal(sum, 7) + ' ', 148);
    return h;
}

/* A gzipped ustar archive of entries ({ name, data, mode }) in the given
 * order, every one owned 0:0 with the same mtime. */
function tgz(entries, mtime) {
    const parts = [];
    entries.forEach((e) => {
        parts.push(header(e.name, e.data.length, e.mode, mtime), e.data);
        const pad = (512 - (e.data.length % 512)) % 512;
        if (pad) {
            parts.push(Buffer.alloc(pad));
        }
    });
    parts.push(Buffer.alloc(1024));
    const out = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
    out[GZIP_OS_BYTE] = GZIP_OS_UNIX;
    return out;
}

/* Every app packed here is ours: "mguLocalOnly": true in its package.json
 * keeps it out of the head unit's backend app reporting (native/app-privacy). */
function stampPackage(pkgDir) {
    const file = path.join(pkgDir, 'package.json');
    const raw = fs.readFileSync(file, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg.mguLocalOnly !== true) {
        pkg.mguLocalOnly = true;
        fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    }
    return pkg;
}

function pack(pkgDir, outFile) {
    const pkg = stampPackage(pkgDir);
    const files = members(pkgDir, pkg);
    const entries = files.map((rel) => ({ name: rel, data: fs.readFileSync(path.join(pkgDir, rel)), mode: 0o644 }));
    fs.writeFileSync(outFile, tgz(entries, MTIME));
    return files;
}

module.exports = { pack, tgz, stampPackage, MTIME };
