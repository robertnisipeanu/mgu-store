'use strict';
/**
 * The updater's sources (README.md, "Sources"): the stored list
 * (sources.json), the USB media mounted now, and for each one how to read
 * its components and fetch one of them. Node 8.
 *
 * A source reads as one of these layouts:
 *  - catalog   a published catalog.json (release/README.md): a GitHub
 *              release `catalog`, an https URL, or catalog.json in a folder;
 *  - repo      mgu-repo.json at a repo's or folder's root, naming component
 *              folders; a component is packed from its folder on install
 *              (an app as a source package, a tool as a tool kit);
 *  - releases  a GitHub repo with neither: its releases' assets named
 *              <id>@<x.y.z>.tgz or .mgu, the newest version of each id.
 *  - loose     a USB stick's oap/ folder of packages under any name
 *              (the community App Manager's), each read for its own
 *              package.json: apps, and root-service packages (mguService)
 *              as the tools the deploy tool makes of them;
 *  - index     an https URL serving IterioDev's App Manager index:
 *              version 2 lists each package's id, kind, version, title,
 *              author, description and icon, read as they are (a package is
 *              downloaded on install); version 1, {"packages": [{url,
 *              sha256}]}, has each package downloaded once (kept by its
 *              sha256) and read like a loose one.
 *
 * Network reads go through `net` (the updater's Fetcher: fetch.js as the
 * fetch uid). A GitHub source is read with the token the updater picked for
 * it (ctx.tokenFor; tokens.js), which goes to the API host (api.github.com)
 * only, and fetch.js drops on a redirect; an https source is read without
 * one. Folders (a `file` source, a USB stick) are read without
 * following links, regular files only, every size bounded, never written.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const catalogLib = require('./catalog');
const tar = require('./tar');

const ID = catalogLib.ID;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const PACKAGE = /^([a-z0-9][a-z0-9_-]{0,63})@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.(tgz|mgu)$/;
const CHANNEL = /^(releases|tags|branch|branch:[A-Za-z0-9._][A-Za-z0-9._\/-]{0,199})$/;
const SMALL = 1 << 20; // a JSON file of a source: catalog part, mgu-repo.json, component.json
const ICON_BYTES = 128 << 10; // a component's icon (PNG)
// a root-service package's mguService: the capability the tool made of it provides
const SERVICE_KINDS = ['renderer', 'tether'];
// Packed components carry one fixed mtime: the same tree gives the same bytes.
const MTIME = Math.floor(Date.UTC(2026, 9, 18) / 1000);

/* An HTTP answer that says the source needs a token that reaches it. */
function authError(message) {
    return Object.assign(new Error(message), { auth: true });
}

/* ---- sources.json -------------------------------------------------------------- */

function readJsonFile(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* Writes a root-only file by rename: no reader sees it half written. */
function writePrivate(file, text) {
    const tmp = `${file}.tmp`;
    try {
        fs.unlinkSync(tmp);
    } catch (e) { /* none */ }
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
        fs.writeSync(fd, text);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

function mkdirPrivate(dir) {
    if (!fs.existsSync(dir)) {
        mkdirPrivate(path.dirname(dir));
        fs.mkdirSync(dir, 0o700);
        fs.chmodSync(dir, 0o700);
    }
}

/* One stored source, checked; throws with the reason it is unusable. */
function checkStored(s) {
    if (!s || !ID.test(s.id) || ['github', 'https', 'file'].indexOf(s.type) < 0) {
        throw new Error(`source ${s && s.id}: needs an id and a type github, https or file`);
    }
    if (s.type === 'github' && !REPO.test(s.repo || '')) {
        throw new Error(`source ${s.id}: repo must be <owner>/<repo>`);
    }
    if (s.channel !== undefined && !(s.type === 'github' && CHANNEL.test(s.channel))) {
        throw new Error(`source ${s.id}: channel must be releases, tags, branch or branch:<name>, for a github source`);
    }
    if (s.type === 'https' && !/^https:\/\/[^/\s]+\/\S*$/.test(s.url || '')) {
        throw new Error(`source ${s.id}: url must be https://`);
    }
    if (s.type === 'file' && !(typeof s.path === 'string' && path.isAbsolute(s.path))) {
        throw new Error(`source ${s.id}: path must be an absolute folder`);
    }
    const out = { id: s.id, type: s.type };
    ['repo', 'channel', 'url', 'path'].forEach((k) => {
        if (s[k] !== undefined) {
            out[k] = s[k];
        }
    });
    if (s.builtin) {
        out.builtin = true;
    }
    return out;
}

/* The stored sources, in order, or null when sources.json does not exist. */
function load(file) {
    if (!fs.existsSync(file)) {
        return null;
    }
    const doc = readJsonFile(file);
    if (!doc || doc.schema !== 1 || !Array.isArray(doc.sources)) {
        throw new Error(`${file}: schema is not 1`);
    }
    const seen = new Set();
    return doc.sources.map(checkStored).filter((s) => !seen.has(s.id) && seen.add(s.id));
}

function save(file, list) {
    mkdirPrivate(path.dirname(file));
    writePrivate(file, JSON.stringify({ schema: 1, sources: list.map(checkStored) }, null, 2) + '\n');
}

/* ---- folders (file sources, USB media) ----------------------------------------- */

/* lstat of each part of rel under root: folders only, no links. */
function safePath(root, rel) {
    const parts = rel.split('/').filter(Boolean);
    if (parts.some((p) => p === '..' || p === '.') || rel[0] === '/' || rel.indexOf('\\') >= 0) {
        throw new Error(`${rel}: not a path inside the source`);
    }
    let at = root;
    [''].concat(parts.slice(0, -1)).forEach((p) => {
        at = p ? path.join(at, p) : at;
        const st = fs.lstatSync(at);
        if (!st.isDirectory()) {
            throw new Error(`${path.relative(root, at) || '.'}: not a folder`);
        }
    });
    return path.join(root, ...parts);
}

/* A regular file inside root, at most max bytes, read without following a link. */
function readInside(root, rel, max) {
    const file = safePath(root, rel);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) {
            throw new Error(`${rel}: not a file`);
        }
        if (st.size > max) {
            throw new Error(`${rel}: more than ${max} bytes`);
        }
        const buf = Buffer.alloc(st.size);
        let off = 0;
        while (off < st.size) {
            const n = fs.readSync(fd, buf, off, st.size - off, off);
            if (!n) {
                break;
            }
            off += n;
        }
        return buf.slice(0, off);
    } finally {
        fs.closeSync(fd);
    }
}

function isFileInside(root, rel) {
    try {
        return fs.lstatSync(safePath(root, rel)).isFile();
    } catch (e) {
        return false;
    }
}

const SKIP = (name) => name === '.git' || name === '.DS_Store' || name.indexOf('._') === 0;

/* The regular files under root/rel, { name (relative to rel), data, mode };
 * links are left out, at most maxBytes in all. */
function walkInside(root, rel, maxBytes) {
    const out = [];
    let total = 0;
    const base = safePath(root, rel);
    if (!fs.lstatSync(base).isDirectory()) {
        throw new Error(`${rel}: not a folder`);
    }
    (function walk(dir, prefix) {
        fs.readdirSync(dir).sort().forEach((name) => {
            if (SKIP(name)) {
                return;
            }
            const st = fs.lstatSync(path.join(dir, name));
            const relName = prefix ? `${prefix}/${name}` : name;
            if (st.isDirectory()) {
                walk(path.join(dir, name), relName);
            } else if (st.isFile()) {
                total += st.size;
                if (total > maxBytes || out.length >= 20000) {
                    throw new Error(`${rel}: more than ${maxBytes} bytes`);
                }
                out.push({ name: relName, data: readInside(root, path.posix.join(rel, relName), st.size), mode: st.mode & 0o777 });
            }
        });
    }(base, ''));
    return out;
}

/* ---- repo trees ------------------------------------------------------------------ */

function parseJson(buf, what) {
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch (e) {
        throw new Error(`${what} is not JSON`);
    }
}

function safeRel(p) {
    return typeof p === 'string' && p !== '' && p[0] !== '/' && p.indexOf('\\') < 0 &&
        p.split('/').every((s) => s !== '..' && s !== '.' && s !== '');
}

/* A build script entry: { node: <script relative to the repo root>, args }. */
function checkScript(b) {
    if (!b || typeof b !== 'object' || !safeRel(b.node) ||
        (b.args !== undefined && !(Array.isArray(b.args) && b.args.length <= 64 && b.args.every((a) => typeof a === 'string')))) {
        throw new Error('build must be {"node": "<script in the repo>", "args": [...]}');
    }
    return { node: b.node, args: b.args || [] };
}

/* The components of a repo tree at commit (null: a folder). readFile(rel)
 * resolves with a file's bytes (rejecting with err.missing when it is not
 * there). An app is built on the unit: from mgu-app.json in its folder (a
 * source package, built by the deploy tool), or by the repo's own build
 * script (`build.node`; version and title from app.json or package.json in
 * its folder). A tool is its folder's component.json and needs no build.
 * revision: the short commit shown for a component (a branch channel).
 * Components that cannot be used are left out, each reason in `skipped`. */
function repoCatalog(readFile, commit, revision) {
    return readFile('mgu-repo.json').then((buf) => {
        const doc = parseJson(buf, 'mgu-repo.json');
        if (!doc || doc.schema !== 1 || !Array.isArray(doc.components)) {
            throw new Error('mgu-repo.json: schema is not 1');
        }
        const skipped = [];
        const seen = new Set();
        const firstOf = (names) => names.reduce((p, n) => p.catch((err) => {
            if (!err.missing) {
                throw err;
            }
            return readFile(n).then((b) => ({ name: n, data: b }));
        }), Promise.reject(Object.assign(new Error('none'), { missing: true })));
        return doc.components.reduce((p, rc) => p.then((list) => {
            if (!rc || !ID.test(rc.id) || ['app', 'tool'].indexOf(rc.kind) < 0 || !safeRel(rc.path) || seen.has(rc.id)) {
                skipped.push(`${rc && rc.id}: needs a unique id, kind app or tool and a path`);
                return list;
            }
            seen.add(rc.id);
            const scripted = rc.kind === 'app' && rc.build !== undefined && rc.build !== 'unit';
            const names = rc.kind === 'tool' ? ['component.json'] : scripted ? ['app.json', 'package.json'] : ['mgu-app.json'];
            return Promise.resolve()
                .then(() => {
                    if (rc.kind === 'tool' && rc.build !== undefined) {
                        throw new Error('a tool in a repo tree needs no build step');
                    }
                    return firstOf(names.map((n) => `${rc.path}/${n}`));
                })
                .then((own) => {
                    const c = parseJson(own.data, own.name);
                    if (!c || (c.id !== undefined && c.id !== rc.id) || (!scripted && c.id !== rc.id) ||
                        !catalogLib.SEMVER.test(c.version || '')) {
                        throw new Error(`${own.name} needs id ${rc.id} and an x.y.z version`);
                    }
                    if (rc.kind === 'tool' && (c.kind !== 'tool' || c.build)) {
                        throw new Error('a tool in a repo tree is kind "tool" and needs no build step');
                    }
                    const pick = (k) => (rc[k] !== undefined ? rc[k] : c[k]);
                    return list.concat([catalogLib.checkExtras({
                        id: rc.id, kind: rc.kind, version: c.version, title: pick('title'), description: pick('description'),
                        build: rc.kind === 'app' ? 'unit' : null, requires: pick('requires'),
                        optional: pick('optional'), uninstallable: pick('uninstallable'),
                        mguHmi: pick('mguHmi'), mguProvides: rc.kind === 'tool' ? pick('mguProvides') : undefined,
                        artifact: { name: `${rc.id}@${c.version}.tgz`, size: null, sha256: null },
                        path: rc.path, script: scripted ? checkScript(rc.build) : null,
                        commit: commit || null, revision: revision || null
                    })]);
                })
                .catch((err) => {
                    skipped.push(`${rc.id}: ${err.missing ? `${names.map((n) => `${rc.path}/${n}`).join(' or ')} is missing` : err.message}`);
                    return list;
                });
        }), Promise.resolve([])).then((components) => ({ mode: 'repo', commit, components, skipped }));
    });
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/* A repo-tree component packed from its folder's files ({ name relative to
 * the component folder, data, mode }): an app as its source package (the
 * folder as it is, mgu-app.json at the root), a tool as a tool kit in the
 * deploy tool's layout (component.json with each file's sha256, files/,
 * units/), as deploy/hu artifact packs one. */
function packComponent(entry, files) {
    const byPath = new Map(files.map((f) => [f.name, f]));
    if (entry.kind === 'app') {
        const own = byPath.get('mgu-app.json');
        const c = own && parseJson(own.data, 'mgu-app.json');
        if (!c || c.id !== entry.id || c.version !== entry.version) {
            throw new Error(`${entry.path}/mgu-app.json does not name ${entry.id}@${entry.version}`);
        }
        return tar.tgz(files.map((f) => ({ name: f.name, data: f.data, mode: f.mode & 0o111 ? 0o755 : 0o644 })).sort(byName), MTIME);
    }
    const own = byPath.get('component.json');
    const c = own && parseJson(own.data, 'component.json');
    if (!c || c.id !== entry.id || c.version !== entry.version || c.kind !== 'tool' || c.build) {
        throw new Error(`${entry.path}/component.json does not name ${entry.id}@${entry.version}, a tool without a build step`);
    }
    const entries = [];
    const take = (from, what) => {
        const f = safeRel(from) && byPath.get(from);
        if (!f) {
            throw new Error(`${entry.id}: ${what} ${from} is missing`);
        }
        return f.data;
    };
    const manifest = Object.assign({}, c, {
        files: (c.files || []).map((f) => {
            if (!safeRel(f.path) || !/^[0-7]{3,4}$/.test(f.mode || '')) {
                throw new Error(`${entry.id}: bad files[] entry ${JSON.stringify(f)}`);
            }
            const data = take(f.from || f.path, 'file');
            entries.push({ name: `files/${f.path}`, data, mode: parseInt(f.mode, 8) });
            return { path: f.path, mode: f.mode, sha256: crypto.createHash('sha256').update(data).digest('hex') };
        }),
        units: (c.units || []).map((u) => {
            if (!safeRel(u.name) || u.name.indexOf('/') >= 0) {
                throw new Error(`${entry.id}: bad unit name ${u.name}`);
            }
            entries.push({ name: `units/${u.name}`, data: take(u.from || u.name, 'unit'), mode: 0o644 });
            return { name: u.name };
        })
    });
    delete manifest.build;
    entries.push({ name: 'component.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o644 });
    return tar.tgz(entries.sort(byName), MTIME);
}

/* The files under rel of a repo's files, named relative to rel. */
function subtree(files, rel) {
    const prefix = `${rel}/`;
    return files.filter((f) => f.name.indexOf(prefix) === 0)
        .map((f) => ({ name: f.name.slice(prefix.length), data: f.data, mode: f.mode }));
}

/* ---- the source readers ----------------------------------------------------------- */

function ua(version) {
    return { 'User-Agent': `mgu-updater/${version}` };
}

function missing(err) {
    return err.status === 404 || err.code === 'ENOENT' || err.missing;
}

/* Every reader has: network (it needs the internet); catalog() -> { mode,
 * channel, commit, components, skipped }; artifact(entry, onProgress) -> a
 * catalog or releases entry's bytes; icon(entry) -> its icon's bytes (at most
 * ICON_BYTES); files(commit, onProgress, under) -> the
 * repo's files ({ name relative to the repo root, data, mode }) for a
 * repo-tree entry, those under the folder `under` when it is given. */

/* A folder source: catalog.json or mgu-repo.json at root. */
function folderReader(root, ctx) {
    const readFile = (rel) => Promise.resolve().then(() => readInside(root, rel, SMALL)).catch((err) => {
        throw Object.assign(err, { missing: err.code === 'ENOENT' });
    });
    return {
        network: false,
        catalog: () => Promise.resolve().then(() => {
            if (!fs.lstatSync(root).isDirectory()) {
                throw new Error(`${root} is not a folder`);
            }
            if (isFileInside(root, 'catalog.json')) {
                return readFile('catalog.json').then((b) => Object.assign({ mode: 'catalog' }, catalogLib.parse(b.toString('utf8'))));
            }
            if (isFileInside(root, 'mgu-repo.json')) {
                return repoCatalog(readFile, null, null).then((cat) => {
                    // a repo tree's icons are not read
                    cat.components.forEach((c) => { c.icon = null; });
                    return cat;
                });
            }
            throw new Error('no catalog.json or mgu-repo.json');
        }),
        artifact: (entry, onProgress) => {
            const url = entry.artifact.url || entry.artifact.name;
            if (/^https:\/\//.test(url)) {
                return ctx.net.get(url, ua(ctx.version), entry.artifact.name, entry.artifact.size, onProgress);
            }
            return Promise.resolve().then(() => readInside(root, url.replace(/^\.\//, ''), entry.artifact.size));
        },
        files: (commit, onProgress, under) => Promise.resolve().then(() => walkInside(root, under || '', ctx.maxBuildBytes)
            .map((f) => (under ? Object.assign(f, { name: `${under}/${f.name}` }) : f))),
        // an https URL, else a path in the folder
        icon: (entry) => (/^https:\/\//.test(entry.icon.ref) ? ctx.net.get(entry.icon.ref, ua(ctx.version), 'icon.png', ICON_BYTES)
            : Promise.resolve().then(() => {
                if (!safeRel(entry.icon.ref)) {
                    throw new Error('an icon path stays inside the folder');
                }
                return readInside(root, entry.icon.ref, ICON_BYTES);
            }))
    };
}

const INDEX_PACKAGES = 50;
const INDEX_PACKAGE_BYTES = 32 << 20;
// an index version 2 kind: an app, or a root-service package (packageEntry)
const INDEX_KINDS = ['app'].concat(SERVICE_KINDS);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/* An index version 2 package's catalog entry, from the index alone. An app
 * that names no mguHmi is for iDrive 8, the App Manager's head unit. */
function indexEntry(item, url) {
    const kind = item.kind;
    if (!ID.test(item.id || '') || !catalogLib.SEMVER.test(item.version || '')) {
        throw new Error('needs an id and an x.y.z version');
    }
    if (INDEX_KINDS.indexOf(kind) < 0) {
        throw new Error(`unknown kind ${String(kind).slice(0, 40)}`);
    }
    if (!(item.size > 0 && item.size <= INDEX_PACKAGE_BYTES)) {
        throw new Error(`needs a size of at most ${INDEX_PACKAGE_BYTES} bytes`);
    }
    const service = kind === 'app' ? null : kind;
    return catalogLib.checkExtras({
        id: item.id, kind: service ? 'tool' : 'app', version: item.version,
        title: text(item.title, 80), description: text(item.description, 1000), author: text(item.author, 80),
        mguHmi: item.mguHmi !== undefined ? item.mguHmi : service ? undefined : ['ID8'],
        mguProvides: service || undefined, service,
        requires: service ? { 'mgu-deploy': '0.3.0' } : undefined,
        icon: item.icon, iconSha256: item.iconSha256,
        artifact: { name: `${item.id}@${item.version}.tgz`, size: item.size, sha256: String(item.sha256).toLowerCase(), url, index: 2 },
        uninstallable: true
    });
}

/* An https source: catalog.json at a URL, artifacts absolute or relative
 * to it; or an App Manager index there, {"packages": [{url, sha256}]}
 * (index mode): each package, https, absolute or relative to the index,
 * downloaded once and kept in <cacheDir>/<source id>/<sha256>.tgz (root's,
 * 0600; the ones the index no longer lists go), checked against its
 * sha256 and read for what it is (packageEntry). */
function httpsReader(s, ctx) {
    const cache = ctx.cacheDir ? path.join(ctx.cacheDir, s.id) : null;
    const cached = (sha) => (cache ? path.join(cache, `${sha}.tgz`) : null);
    const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
    // a version 2 index: one entry per package from the index itself; the
    // packages kept from an earlier read that it still lists stay
    const fromIndex2 = (doc) => {
        const skipped = [];
        const newest = new Map();
        doc.packages.slice(0, INDEX_PACKAGES).forEach((item) => {
            const name = String((item && (item.id || item.url)) || '?').slice(0, 100);
            try {
                const url = new URL(String((item && item.url) || ''), s.url).toString();
                if (!/^https:\/\//.test(url) || !catalogLib.SHA256.test(String(item.sha256).toLowerCase())) {
                    throw new Error('needs an https url and a sha256');
                }
                const entry = indexEntry(item, url);
                const have = newest.get(entry.id);
                if (!have || catalogLib.compareVersions(entry.version, have.version) > 0) {
                    newest.set(entry.id, entry);
                }
            } catch (err) {
                skipped.push(`${name}: ${err.message}`);
            }
        });
        const keep = Array.from(newest.values()).map((e) => `${e.artifact.sha256}.tgz`);
        if (cache && fs.existsSync(cache)) {
            fs.readdirSync(cache).filter((n) => keep.indexOf(n) < 0).forEach((n) => fs.unlinkSync(path.join(cache, n)));
        }
        return { mode: 'index', commit: null, skipped, components: Array.from(newest.values()).sort((a, b) => (a.id < b.id ? -1 : 1)) };
    };
    const fromIndex = (doc) => {
        const skipped = [];
        const newest = new Map();
        const keep = [];
        return doc.packages.slice(0, INDEX_PACKAGES).reduce((p, item) => p.then(() => {
            const sha = String((item && item.sha256) || '').toLowerCase();
            let url = null;
            try {
                url = new URL(String((item && item.url) || ''), s.url).toString();
            } catch (e) { /* refused below */ }
            let name = '?';
            return Promise.resolve()
                .then(() => {
                    name = url ? decodeURIComponent(url.split('?')[0].split('/').pop() || '').slice(0, 100) : name;
                    if (!/^[0-9a-f]{64}$/.test(sha) || !url || !/^https:\/\//.test(url)) {
                        throw new Error('needs an https url and a sha256');
                    }
                    const file = cached(sha);
                    if (file && fs.existsSync(file)) {
                        return fs.readFileSync(file);
                    }
                    return ctx.net.get(url, ua(ctx.version), name, INDEX_PACKAGE_BYTES).then((b) => {
                        if (sha256(b) !== sha) {
                            throw new Error('does not match the sha256 in the index');
                        }
                        if (file) {
                            mkdirPrivate(cache);
                            writePrivate(file, b);
                        }
                        return b;
                    });
                })
                .then((data) => {
                    keep.push(`${sha}.tgz`);
                    return tar.untgz(data, ctx.maxBuildBytes).then((members) => {
                        const entry = packageEntry(members, data, { url }, 'tgz');
                        const have = newest.get(entry.id);
                        if (!have || catalogLib.compareVersions(entry.version, have.version) > 0) {
                            newest.set(entry.id, entry);
                        }
                    });
                })
                .catch((err) => {
                    skipped.push(`${name}: ${err.message}`);
                });
        }), Promise.resolve()).then(() => {
            if (cache && fs.existsSync(cache)) {
                fs.readdirSync(cache).filter((n) => keep.indexOf(n) < 0).forEach((n) => fs.unlinkSync(path.join(cache, n)));
            }
            return { mode: 'index', commit: null, skipped, components: Array.from(newest.values()).sort((a, b) => (a.id < b.id ? -1 : 1)) };
        });
    };
    return {
        network: true,
        catalog: () => ctx.net.get(s.url, ua(ctx.version), 'catalog.json', 4 << 20).then((b) => {
            const text = b.toString('utf8');
            let doc = null;
            try {
                doc = JSON.parse(text);
            } catch (e) { /* parse says so */ }
            if (doc && doc.schema === undefined && Array.isArray(doc.packages)) {
                return doc.version === 2 ? fromIndex2(doc) : fromIndex(doc);
            }
            return Object.assign({ mode: 'catalog' }, catalogLib.parse(text));
        }),
        artifact: (entry, onProgress) => {
            const file = entry.artifact.sha256 && cached(entry.artifact.sha256);
            if (file && fs.existsSync(file)) {
                const b = fs.readFileSync(file);
                if (sha256(b) === entry.artifact.sha256) {
                    return Promise.resolve(b);
                }
            }
            const url = new URL(entry.artifact.url || entry.artifact.name, s.url).toString();
            const got = ctx.net.get(url, ua(ctx.version), entry.artifact.name, entry.artifact.size, onProgress);
            if (entry.artifact.index !== 2) {
                return got;
            }
            // what a version 2 index says of a package is the package's own word
            return got.then((b) => {
                if (sha256(b) !== entry.artifact.sha256) {
                    throw new Error('download does not match the catalog (size or sha256)');
                }
                return tar.untgz(b, ctx.maxBuildBytes).then((members) => {
                    const own = packageEntry(members, b, {}, 'tgz');
                    if (own.id !== entry.id || own.version !== entry.version || own.service !== entry.service) {
                        throw new Error(`the package is ${own.id}@${own.version}${own.service ? ` (${own.service})` : ''}, not what the index says`);
                    }
                    if (file) {
                        mkdirPrivate(cache);
                        writePrivate(file, b);
                    }
                    return b;
                });
            });
        },
        icon: (entry) => {
            const url = new URL(entry.icon.ref, s.url).toString();
            if (!/^https:\/\//.test(url)) {
                return Promise.reject(new Error('an icon needs an https url'));
            }
            return ctx.net.get(url, ua(ctx.version), 'icon.png', ICON_BYTES);
        },
        files: () => Promise.reject(new Error('an https source has no repo tree'))
    };
}

const SEMVER_TAG = /^(?:v|[a-z0-9][a-z0-9_-]{0,63}@)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

/* A GitHub repo through the REST API at conf github_api, on its channel:
 *  releases       the `catalog` release's catalog.json, else the packages
 *                 attached to its releases (releases layout);
 *  branch:<name>  mgu-repo.json at the branch's head commit;
 *  branch         the same, on the repo's default branch;
 *  tags           mgu-repo.json at the highest x.y.z tag (v1.2.3, 1.2.3, <id>@1.2.3).
 * No channel: releases when the repo has a release, else its default branch.
 * catalog()'s `public` is the repo's own word (`private: false`). */
function githubReader(s, ctx) {
    const api = ctx.githubApi.replace(/\/+$/, '');
    const repoUrl = `${api}/repos/${s.repo}`;
    const headers = (url, accept) => {
        const token = ctx.tokenFor(s.id);
        // the token goes to the API host only
        const auth = token && new URL(url).hostname === 'api.github.com' ? { Authorization: `Bearer ${token}` } : {};
        return Object.assign({ Accept: accept }, auth, ua(ctx.version));
    };
    const json = (url, name) => ctx.net.get(url, headers(url, 'application/vnd.github+json'), name, 4 << 20)
        .then((b) => parseJson(b, url));
    const raw = (url, name, max, onProgress) => ctx.net.get(url, headers(url, 'application/octet-stream'), name, max, onProgress);
    // the tarball endpoint redirects to codeload for its JSON media type; octet-stream is refused (415)
    const tarball = (commit, onProgress) => ctx.net.get(`${repoUrl}/tarball/${commit}`, headers(repoUrl, 'application/vnd.github+json'),
        `${s.repo.replace('/', '-')}.tgz`, ctx.maxRepoBytes, onProgress);
    // a file's own bytes from the contents API (else it answers with JSON around them)
    const content = (url, name, max) => ctx.net.get(url, headers(url, 'application/vnd.github.raw+json'), name, max);
    const encode = (rel) => rel.split('/').map(encodeURIComponent).join('/');
    // an icon named by a release asset's name is that asset; an https URL stays
    const assetIcon = (c, assets) => {
        if (c.icon && !/^https:\/\//.test(c.icon.ref)) {
            const a = assets.find((x) => x && x.name === c.icon.ref && typeof x.url === 'string');
            c.icon = a ? Object.assign(c.icon, { ref: a.url }) : null;
        }
        return c;
    };

    const fromCatalog = (release) => {
        const asset = (release.assets || []).find((a) => a.name === 'catalog.json');
        if (!asset) {
            throw new Error('the catalog release has no catalog.json');
        }
        return raw(asset.url, 'catalog.json', 4 << 20).then((b) => {
            const cat = Object.assign({ mode: 'catalog' }, catalogLib.parse(b.toString('utf8')));
            cat.components.forEach((c) => assetIcon(c, release.assets || []));
            return cat;
        });
    };

    const fromReleases = (releases) => {
        const newest = new Map();
        let meta = null;
        const assets = [];
        releases.filter((r) => r && !r.draft && !r.prerelease).forEach((r) => {
            (r.assets || []).forEach((a) => {
                assets.push(a);
                if (a.name === 'mgu-store.json' && !meta) {
                    meta = a;
                }
                const m = PACKAGE.exec(a.name || '');
                if (!m || !(a.size > 0) || typeof a.url !== 'string') {
                    return;
                }
                const have = newest.get(m[1]);
                const cmp = have ? catalogLib.compareVersions(m[2], have.version) : 1;
                // the newest version; of one version, the .tgz
                if (cmp > 0 || (cmp === 0 && m[3] === 'tgz' && have.ext !== 'tgz')) {
                    newest.set(m[1], { id: m[1], version: m[2], ext: m[3], asset: a });
                }
            });
        });
        if (!newest.size) {
            throw new Error('no catalog release and no <id>@<x.y.z>.tgz or .mgu in its releases');
        }
        const titles = meta ? raw(meta.url, 'mgu-store.json', SMALL)
            .then((b) => (parseJson(b, 'mgu-store.json') || {}).apps || {}, () => ({})) : Promise.resolve({});
        return titles.then((apps) => ({
            mode: 'releases',
            commit: null,
            components: Array.from(newest.values()).sort((a, b) => (a.id < b.id ? -1 : 1)).map((n) => {
                const t = apps && typeof apps[n.id] === 'object' && apps[n.id] ? apps[n.id] : {};
                return assetIcon(catalogLib.checkExtras({
                    id: n.id, kind: 'app', version: n.version,
                    title: typeof t.title === 'string' ? t.title : undefined,
                    description: typeof t.description === 'string' ? t.description : undefined,
                    author: t.author, icon: t.icon, iconSha256: t.iconSha256,
                    artifact: { name: n.asset.name, size: n.asset.size, sha256: null, url: n.asset.url },
                    // nothing in this layout can say so: the owner removes what it installed
                    uninstallable: true
                }), assets);
            })
        }));
    };

    const releasesList = (n) => json(`${repoUrl}/releases?per_page=${n}`, 'releases.json').then((r) => (Array.isArray(r) ? r : []));

    const atCommit = (sha, revision) => {
        if (!/^[0-9a-f]{40}$/.test(sha || '')) {
            throw new Error('no commit to read');
        }
        const readFile = (rel) => content(`${repoUrl}/contents/${encode(rel)}?ref=${sha}`, path.posix.basename(rel), SMALL)
            .catch((e) => {
                throw Object.assign(e, { missing: e.status === 404 });
            });
        return repoCatalog(readFile, sha, revision ? sha.slice(0, 7) : null).then((cat) => {
            // a repo tree's icons are not read
            cat.components.forEach((c) => { c.icon = null; });
            return cat;
        }, (e) => {
            throw e.missing ? new Error(`no mgu-repo.json at ${sha.slice(0, 7)}`) : e;
        });
    };

    const onChannel = (channel) => {
        if (channel === 'releases') {
            return json(`${repoUrl}/releases/tags/catalog`, 'release.json').then(fromCatalog, (err) => {
                if (!missing(err)) {
                    throw err;
                }
                return releasesList(100).then(fromReleases);
            });
        }
        if (channel === 'tags') {
            return json(`${repoUrl}/tags?per_page=100`, 'tags.json').then((tags) => {
                let best = null;
                (Array.isArray(tags) ? tags : []).forEach((t) => {
                    const m = SEMVER_TAG.exec((t && t.name) || '');
                    if (m && t.commit && (!best || catalogLib.compareVersions(m[1], best.version) > 0)) {
                        best = { version: m[1], sha: t.commit.sha };
                    }
                });
                if (!best) {
                    throw new Error('no x.y.z tag');
                }
                return atCommit(best.sha, false);
            });
        }
        const branch = channel.slice('branch:'.length);
        return json(`${repoUrl}/commits/${encodeURIComponent(branch)}`, 'commit.json').then((c) => atCommit(c.sha, true), (err) => {
            throw err.status === 404 || err.status === 422 ? new Error(`no branch ${branch}`) : err;
        });
    };

    return {
        network: true,
        catalog: () => json(repoUrl, 'repo.json')
            .catch((err) => {
                throw err.status === 401 || err.status === 404 ? authError(err.message) : err;
            })
            .then((repo) => {
                const branch = `branch:${repo.default_branch || 'main'}`;
                return Promise.resolve(s.channel ? (s.channel === 'branch' ? branch : s.channel) :
                    releasesList(1).then((r) => (r.length ? 'releases' : branch)))
                    .then((channel) => onChannel(channel).then((c) => Object.assign(c, { channel, public: repo.private === false })));
            }),
        artifact: (entry, onProgress) => raw(entry.artifact.url, entry.artifact.name, entry.artifact.size, onProgress),
        icon: (entry) => (/^https:\/\//.test(entry.icon.ref) ? raw(entry.icon.ref, 'icon.png', ICON_BYTES)
            : Promise.reject(new Error('an icon is a release asset or an https url'))),
        files: (commit, onProgress, under) => tarball(commit, onProgress)
            .then((buf) => tar.untgz(buf, ctx.maxBuildBytes))
            // the tarball's one top folder (<owner>-<repo>-<sha>/) is left off
            .then((members) => members.map((m) => ({ name: m.name.slice(m.name.indexOf('/') + 1), data: m.data, mode: m.mode }))
                .filter((m) => m.name && !m.name.split('/').some(SKIP) && (!under || m.name.indexOf(`${under}/`) === 0)))
    };
}

/* ---- USB media ---------------------------------------------------------------------- */

/* /proc/mounts escapes space, tab, newline and backslash as \ooo. */
function unescapeMount(s) {
    return s.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
}

/* The mount points under one of roots (udisks mounts a stick at /media/<label>). */
function mountPoints(mountsFile, roots) {
    let text = '';
    try {
        text = fs.readFileSync(mountsFile, 'utf8');
    } catch (e) {
        return [];
    }
    const out = [];
    text.split('\n').forEach((line) => {
        const f = line.split(' ');
        if (f.length < 3) {
            return;
        }
        const mp = unescapeMount(f[1]);
        if (roots.some((r) => path.dirname(mp) === r.replace(/\/+$/, '')) && out.indexOf(mp) < 0) {
            out.push(mp);
        }
    });
    return out.sort();
}

/* The folders on the mounted media that are sources: the stick's root,
 * mgu-repo/ or mgu-repo/<name>/, each holding catalog.json or mgu-repo.json.
 * [{ id: "usb:<label>[/<path>]", label, root }] */
function usbSources(mountsFile, roots) {
    const out = [];
    mountPoints(mountsFile, roots).forEach((mp) => {
        const label = path.basename(mp);
        const isSource = (rel) => isFileInside(mp, rel ? `${rel}/catalog.json` : 'catalog.json') ||
            isFileInside(mp, rel ? `${rel}/mgu-repo.json` : 'mgu-repo.json');
        const add = (rel, loose) => out.push(Object.assign({ id: `usb:${label}${rel ? `/${rel}` : ''}`,
            label: `${label}${rel ? `/${rel}` : ''}`, root: rel ? path.join(mp, rel) : mp }, loose ? { loose: true } : {}));
        const isDir = (rel) => {
            try {
                return fs.lstatSync(path.join(mp, rel)).isDirectory();
            } catch (e) {
                return false;
            }
        };
        try {
            if (isSource('')) {
                add('');
            }
            if (isSource('mgu-repo')) {
                add('mgu-repo');
            }
            if (isDir('mgu-repo')) {
                fs.readdirSync(path.join(mp, 'mgu-repo')).sort().slice(0, 64).forEach((name) => {
                    if (!SKIP(name) && isSource(`mgu-repo/${name}`)) {
                        add(`mgu-repo/${name}`);
                    }
                });
            }
            // the community App Manager's folder of packages
            if (isDir('oap') && fs.readdirSync(path.join(mp, 'oap')).some((n) => LOOSE.test(n) && isFileInside(mp, `oap/${n}`))) {
                add('oap', true);
            }
        } catch (e) { /* not readable */ }
    });
    return out;
}

/* ---- loose packages (a stick's oap/) --------------------------------------------- */

const LOOSE = /^[^.].*\.(tgz|tar\.gz|mgu)$/i;

/* An app package's package.json and en_GB entry-point text, from its
 * members: an OAP tgz flat or under package/, or an .mgu (source/,
 * rhmiData/ beside it). */
function packageInfo(members) {
    const byName = new Map(members.map((m) => [m.name.replace(/^\.\//, ''), m.data]));
    const base = ['package/', '', 'source/'].find((b) => byName.has(`${b}package.json`));
    if (base === undefined) {
        throw new Error('no package.json');
    }
    const pkg = parseJson(byName.get(`${base}package.json`), 'package.json');
    let title = null;
    const rhmi = base === 'source/' ? 'rhmiData/' : `${base}rhmiData/`;
    // the HMIs its rhmiData has a UI for: application.json's uiDescriptions[].hmi, else its uiDescriptions/<hmi>/ folders
    const hmi = [];
    try {
        const uis = parseJson(byName.get(`${rhmi}application.json`), 'application.json').application.uiDescriptions || [];
        uis.forEach((u) => (u && Array.isArray(u.hmi) ? u.hmi : []).forEach((h) => {
            if (catalogLib.HMIS.indexOf(h) >= 0 && hmi.indexOf(h) < 0) {
                hmi.push(h);
            }
        }));
    } catch (e) { /* no application.json */ }
    if (!hmi.length) {
        byName.forEach((data, name) => {
            const m = name.slice(0, rhmi.length) === rhmi && /^uiDescriptions\/([^/]+)\//.exec(name.slice(rhmi.length));
            if (m && catalogLib.HMIS.indexOf(m[1]) >= 0 && hmi.indexOf(m[1]) < 0) {
                hmi.push(m[1]);
            }
        });
    }
    try {
        const app = parseJson(byName.get(`${rhmi}application.json`), 'application.json').application;
        const textId = app.entryPoints && app.entryPoints[0] && app.entryPoints[0].textId;
        const groups = (app.variantGroups || []).map((g) => String(g.stringsPath || '').replace(/^\.\//, ''));
        ['variantGroups/Common/texts'].concat(groups).some((dir) => {
            const t = byName.get(`${rhmi}${dir}/en_GB.json`);
            const text = t && textId && parseJson(t, 'en_GB.json')[textId];
            title = typeof text === 'string' && text ? text : null;
            return !!title;
        });
    } catch (e) { /* no entry-point text */ }
    return { pkg, title, hmi: hmi.length ? hmi.sort() : null };
}


/* A package's catalog entry from its own members: an app, or a root-service
 * package (mguService: renderer or tether) as the tool the deploy tool
 * makes of it, which provides its kind and needs mgu-deploy 0.3.0 or
 * newer to install. An app that names no mguHmi is
 * for the HMIs its rhmiData has a UI for. */
function packageEntry(members, data, artifact, ext) {
    const { pkg, title, hmi } = packageInfo(members);
    if (!ID.test(pkg.name || '') || !catalogLib.SEMVER.test(pkg.version || '')) {
        throw new Error('package.json needs a lower-case name and an x.y.z version');
    }
    const service = pkg.mguService === undefined ? null : pkg.mguService;
    if (service !== null && SERVICE_KINDS.indexOf(service) < 0) {
        throw new Error(`unknown mguService ${String(service).slice(0, 40)}`);
    }
    return catalogLib.checkExtras({
        id: pkg.name, kind: service ? 'tool' : 'app', version: pkg.version,
        title: title || (typeof pkg.productName === 'string' && pkg.productName) || pkg.name,
        description: typeof pkg.description === 'string' ? pkg.description : '',
        mguHmi: pkg.mguHmi !== undefined ? pkg.mguHmi : service ? undefined : hmi,
        mguProvides: service || undefined, service,
        // the deploy tool that installs a service package as a tool
        requires: service ? { 'mgu-deploy': '0.3.0' } : undefined,
        artifact: Object.assign({ name: `${pkg.name}@${pkg.version}.${ext}`, size: data.length,
            sha256: crypto.createHash('sha256').update(data).digest('hex') }, artifact),
        uninstallable: true
    });
}

/* A stick's oap/ folder: each package file (any name, .tgz, .tar.gz or
 * .mgu) one component, its id, version and title from the package itself
 * (packageEntry); the newest of an id wins. sha256 is taken as the
 * listing reads the file. */
function looseReader(root, ctx) {
    const list = () => {
        const skipped = [];
        const newest = new Map();
        // regular files only: a link is not followed
        return fs.readdirSync(root).filter((n) => LOOSE.test(n) && isFileInside(root, n)).sort().slice(0, 256).reduce((p, name) => p.then(() => {
            let data;
            return Promise.resolve()
                .then(() => {
                    data = readInside(root, name, ctx.maxRepoBytes);
                    return tar.untgz(data, ctx.maxBuildBytes);
                })
                .then((members) => {
                    const entry = packageEntry(members, data, { url: name }, /\.mgu$/i.test(name) ? 'mgu' : 'tgz');
                    const have = newest.get(entry.id);
                    if (!have || catalogLib.compareVersions(entry.version, have.version) > 0) {
                        newest.set(entry.id, entry);
                    }
                })
                .catch((err) => {
                    skipped.push(`${name}: ${err.message}`);
                });
        }), Promise.resolve()).then(() => ({ mode: 'catalog', commit: null, skipped,
            components: Array.from(newest.values()).sort((a, b) => (a.id < b.id ? -1 : 1)) }));
    };
    const folder = folderReader(root, ctx);
    return { network: false, catalog: list, artifact: folder.artifact, files: folder.files,
        icon: () => Promise.reject(new Error('a loose package has no icon')) };
}

/* ---- one source --------------------------------------------------------------------- */

/* A reader for a stored source or a USB folder. ctx: { net, tokenFor(source
 * id) -> the token text for it or '', version, githubApi, maxRepoBytes (a tarball download), maxBuildBytes (a
 * repo's files) }. */
function reader(s, ctx) {
    if (s.type === 'github') {
        return githubReader(s, ctx);
    }
    if (s.type === 'https') {
        return httpsReader(s, ctx);
    }
    if (s.type === 'usb' && s.loose) {
        return looseReader(s.root, ctx);
    }
    return folderReader(s.type === 'usb' ? s.root : s.path, ctx);
}

function label(s) {
    return s.type === 'github' ? s.repo : s.type === 'https' ? s.url : s.type === 'file' ? s.path : s.label;
}

module.exports = {
    load, save, checkStored, writePrivate, mkdirPrivate, reader, label, usbSources, mountPoints,
    repoCatalog, packComponent, subtree, packageInfo, packageEntry, readInside, walkInside, authError, REPO, CHANNEL, PACKAGE, ICON_BYTES
};
