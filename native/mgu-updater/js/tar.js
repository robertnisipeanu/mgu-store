'use strict';
/**
 * Gzipped tar in memory, for the updater's repo-tree sources. Node 8; no I/O.
 *
 *   untgz(buf, maxBytes) -> Promise<[{ name, data, mode }]>
 *       the regular files of a .tar.gz (ustar, pax and GNU long names);
 *       links, devices and folders are left out; refuses an archive that
 *       unpacks to more than maxBytes or names a path with `..` or `/` first
 *   tgz(entries, mtime) -> Buffer
 *       entries ({ name, data, mode }) as a gzipped ustar archive in the given
 *       order, owner 0:0, one mtime (tools/oap_pack.js writes the same);
 *       throws for a name ustar cannot hold (over 100 bytes after the last
 *       '/' that leaves at most 155 before it)
 */
const zlib = require('zlib');

/* Gunzips at most maxBytes; rejects past that without holding more. */
function gunzipBounded(buf, maxBytes) {
    return new Promise((resolve, reject) => {
        const z = zlib.createGunzip();
        const parts = [];
        let total = 0;
        let failed = false;
        z.on('data', (d) => {
            total += d.length;
            if (total > maxBytes) {
                failed = true;
                z.destroy();
                reject(new Error(`unpacks to more than ${maxBytes} bytes`));
                return;
            }
            parts.push(d);
        });
        z.on('error', (err) => {
            if (!failed) {
                failed = true;
                reject(new Error(`not a gzip archive (${err.message})`));
            }
        });
        z.on('end', () => {
            if (!failed) {
                resolve(Buffer.concat(parts, total));
            }
        });
        z.end(buf);
    });
}

function field(h, off, len) {
    const s = h.slice(off, off + len);
    const nul = s.indexOf(0);
    return s.slice(0, nul < 0 ? len : nul).toString('utf8');
}

function octal(h, off, len) {
    const s = field(h, off, len).trim();
    return s ? parseInt(s, 8) : 0;
}

/* The path records of a pax extended header ("<len> path=<value>\n"). */
function paxPath(data) {
    const text = data.toString('utf8');
    let i = 0;
    let found = null;
    while (i < text.length) {
        const sp = text.indexOf(' ', i);
        const len = parseInt(text.slice(i, sp), 10);
        if (!(len > 0) || sp < 0) {
            break;
        }
        const rec = text.slice(sp + 1, i + len - 1);
        const eq = rec.indexOf('=');
        if (rec.slice(0, eq) === 'path') {
            found = rec.slice(eq + 1);
        }
        i += len;
    }
    return found;
}

function safeName(name) {
    return name !== '' && name[0] !== '/' && name.indexOf('\\') < 0 && name.split('/').indexOf('..') < 0;
}

function untar(tar) {
    const out = [];
    let off = 0;
    let longName = null;
    while (off + 512 <= tar.length) {
        const h = tar.slice(off, off + 512);
        if (h.every((b) => b === 0)) {
            break;
        }
        const size = octal(h, 124, 12);
        const type = String.fromCharCode(h[156] || 48);
        const data = tar.slice(off + 512, off + 512 + size);
        if (data.length !== size) {
            throw new Error('the archive ends inside a member');
        }
        off += 512 + Math.ceil(size / 512) * 512;
        if (type === 'x') {
            longName = paxPath(data);
            continue;
        }
        if (type === 'L') {
            longName = field(data, 0, data.length);
            continue;
        }
        if (type === 'g') {
            continue;
        }
        const prefix = field(h, 345, 155);
        let name = longName || (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
        longName = null;
        name = name.replace(/^\.\//, '');
        if (type !== '0' && type !== '7') {
            continue; // folders, links, devices
        }
        if (!safeName(name)) {
            throw new Error(`the archive names ${name}`);
        }
        out.push({ name, data, mode: octal(h, 100, 8) & 0o777 });
    }
    return out;
}

function untgz(buf, maxBytes) {
    return gunzipBounded(buf, maxBytes).then(untar);
}

function header(name, size, mode, mtime) {
    const oct = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
    const h = Buffer.alloc(512);
    let prefix = '';
    let base = name;
    if (Buffer.byteLength(name) > 100) {
        // the split at a '/' with at most 155 bytes before it and 100 after
        let cut = -1;
        for (let i = name.indexOf('/'); i >= 0; i = name.indexOf('/', i + 1)) {
            if (Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) {
                cut = i;
                break;
            }
        }
        if (cut < 0) {
            throw new Error(`${name}: too long a path to pack`);
        }
        prefix = name.slice(0, cut);
        base = name.slice(cut + 1);
    }
    h.write(base, 0, 100, 'utf8');
    h.write(oct(mode, 8), 100);
    h.write(oct(0, 8), 108);
    h.write(oct(0, 8), 116);
    h.write(oct(size, 12), 124);
    h.write(oct(mtime, 12), 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
        sum += h[i];
    }
    h.write(oct(sum, 7) + ' ', 148);
    return h;
}

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
    out[9] = 3; // OS: Unix
    return out;
}

module.exports = { untgz, tgz, gunzipBounded };
