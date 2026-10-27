'use strict';
/**
 * Reads a stick the way the updater does (native/mgu-updater/js/sources.js),
 * on the unit's Node: node stick_read.js <media folder>. Prints JSON:
 * { "<source id>": { mode, copyOf, components: [{ id, kind, version, build, ok }],
 * skipped } }, where ok says the artifact (or, for a repo tree, the
 * component's packed folder) reads and matches the listed size and sha256.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sources = require('../../native/mgu-updater/js/sources');

const media = path.resolve(process.argv[2]);
const mounts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stick-')), 'mounts');
fs.writeFileSync(mounts, fs.readdirSync(media).map((n) => `/dev/sdx1 ${path.join(media, n).replace(/ /g, '\\040')} vfat ro 0 0`).join('\n') + '\n');
const ctx = { net: null, credentials: null, version: 'test', maxRepoBytes: 200 << 20, maxBuildBytes: 200 << 20 };
const out = {};
sources.usbSources(mounts, [media]).reduce((p, u) => p.then(() => {
    const r = sources.reader(Object.assign({ type: 'usb' }, u), ctx);
    return r.catalog().then((cat) => Promise.all(cat.components.map((e) => {
        const bytes = cat.mode === 'repo' ?
            r.files(null, null, e.path).then((files) => sources.packComponent(e, sources.subtree(files, e.path))) :
            r.artifact(e, null);
        return bytes.then((b) => b.length === (e.artifact.size || b.length) &&
            (!e.artifact.sha256 || crypto.createHash('sha256').update(b).digest('hex') === e.artifact.sha256), (err) => err.message)
            .then((ok) => ({ id: e.id, kind: e.kind, version: e.version, build: e.build, title: e.title, ok }));
    })).then((components) => {
        out[u.id] = { mode: cat.mode, copyOf: cat.copyOf || null, components, skipped: cat.skipped || [] };
    }), (err) => {
        out[u.id] = { error: err.message };
    });
}), Promise.resolve()).then(() => process.stdout.write(JSON.stringify(out)));
