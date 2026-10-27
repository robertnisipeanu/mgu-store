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

/* What a component needs that another one provides: Python for a
 * "python" build, the deploy tool that hands a build the oap-sdk module
 * ("sdk") and installs drop-ins (a preload tool, a tool with dropins), and
 * the one that knows capabilities (mguProvides). */
const PYTHON_TOOL = 'mgu-python';
const PYTHON_MIN = '1.0.0';
const DEPLOY_SDK_MIN = '0.3.2';
const DEPLOY_PROVIDES_MIN = '0.4.0';

/* {id}, {version} and {dir} (the app's folder) in a build's strings; any
 * other brace is refused. */
function fill(text, vars) {
    const out = text.replace(/\{(id|version|dir)\}/g, (m, k) => vars[k]);
    if (/[{}]/.test(out)) {
        throw new Error(`${text}: only {id}, {version} and {dir} can be filled in`);
    }
    return out;
}

/* A build entry: { node | python: <script relative to the repo root>, args,
 * output (the package the build leaves, else MGU_OUT), sdk (the folder the
 * oap-sdk module goes to before the build), network (true, or the ids of
 * the apps whose build downloads) }, its strings filled in for one app. */
function checkScript(b, vars) {
    const strings = (a) => a === undefined || (Array.isArray(a) && a.length <= 64 && a.every((x) => typeof x === 'string'));
    const network = b && (b.network === undefined || typeof b.network === 'boolean' ||
        (Array.isArray(b.network) && b.network.every((x) => typeof x === 'string')));
    if (!b || typeof b !== 'object' || (b.node === undefined) === (b.python === undefined) || !safeRel(b.node || b.python) ||
        !strings(b.args) || !network ||
        (b.output !== undefined && typeof b.output !== 'string') || (b.sdk !== undefined && !safeRel(b.sdk))) {
        throw new Error('build must be {"node" or "python": "<script in the repo>", "args": [...], "output", "sdk", "network"}');
    }
    const output = b.output === undefined ? null : fill(b.output, vars);
    if (output !== null && !safeRel(output)) {
        throw new Error(`build output ${output} is not a path in the repo`);
    }
    return {
        [b.node ? 'node' : 'python']: b.node || b.python,
        args: (b.args || []).map((a) => fill(a, vars)),
        output,
        sdk: b.sdk || null,
        network: Array.isArray(b.network) ? b.network.indexOf(vars.id) >= 0 : !!b.network
    };
}

/* A service tool of mgu-repo.json: a committed program the updater makes a
 * tool kit of, with the systemd unit its fields describe (packComponent).
 *   { exec, args, user: "root" | "dynamic", groups, environment,
 *     runtimeDirectory, after, wantedBy }
 * Every value goes into the unit as it is, so each is one word of a
 * narrow alphabet; "{app_gid}" in args is the apps' group (tm_oap_app). */
const APP_GID = 12202;
// a file name in the tool's folder: it goes into units and the guard script as it is
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
/* The title as one line for a generated file's comment or Description=:
 * control characters and systemd's % specifiers become spaces. */
function oneLine(text) {
    return String(text).replace(/[\x00-\x1f\x7f%]/g, ' ');
}
const WORD = /^[A-Za-z0-9_.@:\/=,+%-]{1,200}$/;
const UNIT = /^[A-Za-z0-9_.@-]{1,100}\.(service|target|socket|mount|path)$/;
// a drop-in for a unit the tool does not own (deploy tool 0.3.2)
const DROPIN_UNIT = /^[A-Za-z0-9_.@-]{1,100}\.(service|socket|target|mount|path|timer)$/;
const DROPIN_NAME = /^[A-Za-z0-9_.@-]{1,100}\.conf$/;
function checkService(sv) {
    const words = (a, re) => a === undefined || (Array.isArray(a) && a.length <= 32 && a.every((x) => typeof x === 'string' && re.test(x)));
    const env = sv && sv.environment;
    if (!sv || typeof sv !== 'object' || !FILE_NAME.test(sv.exec || '') ||
        !words(sv.args ? sv.args.map((a) => a.replace(/\{app_gid\}/g, String(APP_GID))) : undefined, WORD) ||
        ['root', 'dynamic', undefined].indexOf(sv.user) < 0 || !words(sv.groups, /^[a-z_][a-z0-9_-]{0,31}$/) ||
        (env !== undefined && (typeof env !== 'object' || Array.isArray(env) ||
            Object.keys(env).some((k) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(k) || typeof env[k] !== 'string' || !WORD.test(env[k])))) ||
        (sv.runtimeDirectory !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(sv.runtimeDirectory)) ||
        !words(sv.after, UNIT) || (sv.wantedBy !== undefined && !UNIT.test(sv.wantedBy))) {
        throw new Error('service must be {"exec": "<file in its path>", "args", "user": "root" or "dynamic", "groups", ' +
            '"environment", "runtimeDirectory", "after", "wantedBy"}, each value one plain word');
    }
    return {
        exec: sv.exec, args: (sv.args || []).map((a) => a.replace(/\{app_gid\}/g, String(APP_GID))),
        user: sv.user || 'root', groups: sv.groups || [], environment: env || {},
        runtimeDirectory: sv.runtimeDirectory || null, after: sv.after || [], wantedBy: sv.wantedBy || 'multi-user.target'
    };
}

/* A preload tool of mgu-repo.json: a committed library a stock unit's
 * process loads (LD_PRELOAD) from the next head-unit start, behind a boot
 * guard (packPreload).
 *   { library, unit: "hmi.service", process: "HmiMain3D", strikes: 2,
 *     checkAfterSeconds: 120, healthySeconds: 60 } */
function checkPreload(pl) {
    const num = (v, d, lo, hi) => (v === undefined ? d : (Number.isInteger(v) && v >= lo && v <= hi ? v : NaN));
    const out = pl && typeof pl === 'object' && {
        library: pl.library, unit: pl.unit, process: pl.process,
        strikes: num(pl.strikes, 2, 1, 10), checkAfterSeconds: num(pl.checkAfterSeconds, 120, 10, 3600),
        healthySeconds: num(pl.healthySeconds, 60, 1, 3600)
    };
    if (!out || !FILE_NAME.test(out.library || '') || !/\.so$/.test(out.library) ||
        !DROPIN_UNIT.test(out.unit || '') || !/^[A-Za-z0-9_.-]{1,15}$/.test(out.process || '') ||
        [out.strikes, out.checkAfterSeconds, out.healthySeconds].some((n) => Number.isNaN(n)) ||
        out.healthySeconds >= out.checkAfterSeconds) {
        throw new Error('preload must be {"library": "<file.so in its path>", "unit": "<unit>", "process": "<name>", ' +
            '"strikes", "checkAfterSeconds", "healthySeconds" (less than checkAfterSeconds)}');
    }
    return out;
}

/* The repo's components as mgu-repo.json lists them, its patterns expanded:
 *   components  [{ id, kind, path, build, ... }]  one component each
 *   apps        { path: "<folder>/*", manifest, exclude, build, ... } (or a
 *               list of them): every folder there holding the manifest
 *               (app.json) is an app, its id the folder's name
 *   tools       [{ id, path, version, service, provides, ... }]
 * listDir(rel) resolves with the names of the folders in rel. */
function repoEntries(doc, listDir) {
    const entries = (Array.isArray(doc.components) ? doc.components : []).slice();
    const patterns = doc.apps === undefined ? [] : Array.isArray(doc.apps) ? doc.apps : [doc.apps];
    (Array.isArray(doc.tools) ? doc.tools : []).forEach((t) => entries.push(Object.assign({}, t, { kind: 'tool' })));
    const skipped = [];
    return patterns.reduce((p, pat) => p.then(() => {
        const m = pat && typeof pat.path === 'string' && /^((?:[^*{}]+\/)?)\*$/.exec(pat.path);
        if (!m || (m[1] && !safeRel(m[1].replace(/\/$/, '')))) {
            skipped.push(`apps ${pat && pat.path}: path must be "<folder>/*"`);
            return null;
        }
        const exclude = Array.isArray(pat.exclude) ? pat.exclude : [];
        return listDir(m[1].replace(/\/$/, '')).then((names) => names.sort().forEach((name) => {
            if (exclude.indexOf(name) < 0 && exclude.indexOf(`${m[1]}${name}`) < 0) {
                entries.push(Object.assign({}, pat, { id: name, kind: 'app', path: `${m[1]}${name}`, pattern: true }));
            }
        }), (err) => {
            skipped.push(`apps ${pat.path}: ${err.missing ? 'no such folder' : err.message}`);
        });
    }), Promise.resolve()).then(() => ({ entries, skipped }));
}

/* The components of a repo tree at commit (null: a folder). readFile(rel)
 * resolves with a file's bytes (rejecting with err.missing when it is not
 * there); listDir(rel) with the folders in rel. An app is built on the
 * unit: from mgu-app.json in its folder (a source package, built by the
 * deploy tool), or by the repo's own build script (`build.node` or
 * `build.python`; version and title from its manifest: app.json, else
 * package.json, in its folder). A tool is its folder's component.json, or a
 * service the entry describes; neither has a build step.
 * revision: the short commit shown for a component (a branch channel).
 * Components that cannot be used are left out, each reason in `skipped`. */
function repoCatalog(readFile, commit, revision, listDir) {
    return readFile('mgu-repo.json').then((buf) => {
        const doc = parseJson(buf, 'mgu-repo.json');
        if (!doc || doc.schema !== 1 || !(Array.isArray(doc.components) || doc.apps !== undefined || Array.isArray(doc.tools))) {
            throw new Error('mgu-repo.json: schema is not 1');
        }
        const list = listDir || (() => Promise.reject(new Error('cannot list folders here')));
        return repoEntries(doc, list).then((r) => ({ doc, entries: r.entries, skipped: r.skipped }));
    }).then(({ entries, skipped }) => {
        const seen = new Set();
        const firstOf = (names) => names.reduce((p, n) => p.catch((err) => {
            if (!err.missing) {
                throw err;
            }
            return readFile(n).then((b) => ({ name: n, data: b }));
        }), Promise.reject(Object.assign(new Error('none'), { missing: true })));
        return entries.reduce((p, rc) => p.then((list) => {
            if (!rc || !ID.test(rc.id) || ['app', 'tool'].indexOf(rc.kind) < 0 || !safeRel(rc.path) || seen.has(rc.id)) {
                skipped.push(`${rc && rc.id}: needs a unique id, kind app or tool and a path`);
                return list;
            }
            seen.add(rc.id);
            const scripted = rc.kind === 'app' && rc.build !== undefined && rc.build !== 'unit';
            const manifest = typeof rc.manifest === 'string' && /^[A-Za-z0-9._-]+$/.test(rc.manifest) ? [rc.manifest] : null;
            const names = rc.kind === 'tool' ? ['component.json'] : manifest || (scripted ? ['app.json', 'package.json'] : ['mgu-app.json']);
            const service = rc.kind === 'tool' && (rc.service !== undefined || rc.preload !== undefined);
            const own = () => (service ? Promise.resolve({ name: 'mgu-repo.json', data: Buffer.from(JSON.stringify(rc)) }) :
                firstOf(names.map((n) => `${rc.path}/${n}`)));
            return Promise.resolve()
                .then(() => {
                    if (rc.kind === 'tool' && rc.build !== undefined) {
                        throw new Error('a tool in a repo tree needs no build step');
                    }
                    if (rc.pattern && !scripted) {
                        throw new Error('an apps pattern needs a build script');
                    }
                    return own();
                })
                .then((o) => {
                    const c = parseJson(o.data, o.name);
                    if (!c || (c.id !== undefined && c.id !== rc.id) || (!scripted && !service && c.id !== rc.id) ||
                        !catalogLib.SEMVER.test(c.version || '')) {
                        throw new Error(`${o.name} needs id ${rc.id} and an x.y.z version`);
                    }
                    if (rc.kind === 'tool' && !service && (c.kind !== 'tool' || c.build)) {
                        throw new Error('a tool in a repo tree is kind "tool" and needs no build step');
                    }
                    const pick = (k) => (rc[k] !== undefined ? rc[k] : c[k]);
                    // checked with the other catalog fields (catalog.js checkExtras)
                    const provides = rc.kind === 'tool' ? pick('provides') || pick('mguProvides') || null : null;
                    const script = scripted ? checkScript(rc.build, { id: rc.id, version: c.version, dir: rc.path }) : null;
                    const needs = {};
                    if (script && script.python) {
                        needs[PYTHON_TOOL] = PYTHON_MIN;
                    }
                    if (provides) {
                        // the deploy tool that installs providers side by side (and all the below)
                        needs['mgu-deploy'] = DEPLOY_PROVIDES_MIN;
                    } else if (script && script.sdk) {
                        needs['mgu-deploy'] = DEPLOY_SDK_MIN;
                    } else if (rc.kind === 'tool' && (rc.preload !== undefined || (!service && c.dropins !== undefined))) {
                        // the deploy tool that installs a drop-in
                        needs['mgu-deploy'] = DEPLOY_SDK_MIN;
                    }
                    const requires = Object.assign(needs, pick('requires') || {});
                    return list.concat([catalogLib.checkExtras({
                        id: rc.id, kind: rc.kind, version: c.version, title: pick('title'), description: pick('description'),
                        build: rc.kind === 'app' ? 'unit' : null, requires: Object.keys(requires).length ? requires : undefined,
                        optional: pick('optional') !== undefined ? pick('optional') : service || undefined,
                        uninstallable: pick('uninstallable') !== undefined ? pick('uninstallable') : service || undefined,
                        mguHmi: pick('mguHmi'), mguProvides: provides || undefined,
                        artifact: { name: `${rc.id}@${c.version}.tgz`, size: null, sha256: null },
                        path: rc.path, script, daemon: rc.kind === 'tool' && rc.service !== undefined ? checkService(rc.service) : null,
                        // what a build under another id is made from (renameApp)
                        buildSpec: script ? rc.build : null, manifest: script ? o.name : null,
                        preload: rc.kind === 'tool' && rc.preload !== undefined ? checkPreload(rc.preload) : null,
                        mguNeeds: pick('needs') !== undefined ? pick('needs') : pick('mguNeeds'),
                        commit: commit || null, revision: revision || null
                    })]);
                })
                .catch((err) => {
                    // a folder a pattern matched that is not an app (no manifest) is no component
                    if (!(rc.pattern && err.missing)) {
                        skipped.push(`${rc.id}: ${err.missing ? `${names.map((n) => `${rc.path}/${n}`).join(' or ')} is missing` : err.message}`);
                    }
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
    if (entry.daemon) {
        return packService(entry, byPath);
    }
    if (entry.preload) {
        return packPreload(entry, byPath);
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
    if (c.dropins !== undefined) {
        manifest.dropins = (Array.isArray(c.dropins) ? c.dropins : [null]).map((d) => {
            if (!d || !DROPIN_UNIT.test(d.unit || '') || !DROPIN_NAME.test(d.name || '')) {
                throw new Error(`${entry.id}: bad dropins entry ${JSON.stringify(d)}`);
            }
            entries.push({ name: `dropins/${d.unit}.d/${d.name}`, data: take(d.from || d.name, 'drop-in'), mode: 0o644 });
            return { unit: d.unit, name: d.name };
        });
    }
    delete manifest.build;
    entries.push({ name: 'component.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o644 });
    return tar.tgz(entries.sort(byName), MTIME);
}

/* The systemd unit of a service tool (checkService), running its program
 * from the tool's current version. */
function serviceUnit(entry) {
    const sv = entry.daemon;
    const title = oneLine(entry.title);
    const lines = [`# ${title} (${entry.id}): a service from its repository's mgu-repo.json, installed by mgu-deploy.`,
        '[Unit]', `Description=${title} (${entry.id})`, 'RequiresMountsFor=/var/opt']
        .concat(sv.after.length ? [`After=${sv.after.join(' ')}`] : [])
        .concat(['StartLimitIntervalSec=0', '', '[Service]'])
        .concat(sv.user === 'dynamic' ? ['DynamicUser=yes'] : [])
        .concat(sv.groups.length ? [`SupplementaryGroups=${sv.groups.join(' ')}`] : [])
        .concat(Object.keys(sv.environment).sort().map((k) => `Environment=${k}=${sv.environment[k]}`))
        .concat(sv.runtimeDirectory ? [`RuntimeDirectory=${sv.runtimeDirectory}`, 'RuntimeDirectoryMode=0755'] : [])
        .concat([`ExecStart=/var/opt/${entry.id}/current/${sv.exec}${sv.args.map((a) => ` ${a}`).join('')}`,
            'Restart=always', 'RestartSec=3', '', '[Install]', `WantedBy=${sv.wantedBy}`, '']);
    return lines.join('\n');
}

/* A service tool's kit: its program, the unit, enabled for wantedBy, its
 * recmgr entry and the capability it provides. */
function packService(entry, byPath) {
    const sv = entry.daemon;
    const bin = byPath.get(sv.exec);
    if (!bin) {
        throw new Error(`${entry.id}: ${entry.path}/${sv.exec} is missing`);
    }
    const unit = `${entry.id}.service`;
    const manifest = {
        id: entry.id, kind: 'tool', version: entry.version, title: entry.title, description: entry.description,
        files: [{ path: sv.exec, mode: '0755', sha256: crypto.createHash('sha256').update(bin.data).digest('hex') }],
        units: [{ name: unit }], enable: [{ unit, target: sv.wantedBy }], recmgr: [entry.id], restart: [unit]
    };
    if (entry.mguProvides) {
        manifest.mguProvides = entry.mguProvides;
    }
    // an update leaves a running renderer running (native/mgu-render/README.md)
    if (entry.mguProvides === 'renderer') {
        manifest.keepRunning = true;
    }
    if (entry.mguHmi) {
        manifest.mguHmi = entry.mguHmi;
    }
    return tar.tgz([
        { name: 'component.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o644 },
        { name: `files/${sv.exec}`, data: bin.data, mode: 0o755 },
        { name: `units/${unit}`, data: Buffer.from(serviceUnit(entry)), mode: 0o644 }
    ].sort(byName), MTIME);
}

/* A preload tool's kit, after the controller gate's installer in
 * idrive7-apps (deploy/mgu-app-install.sh, inputgate): the library and a
 * guard script in its version folder; <id>-guard.service before the unit,
 * which writes /run/<id>.env with LD_PRELOAD (the unit's other preloads,
 * then the library) unless the process failed to come up healthy with it
 * `strikes` starts in a row; <id>-check.service after the unit, which
 * resets the count once the process has run with the library for
 * `healthySeconds`, `checkAfterSeconds` after the start, and never exits;
 * and the unit's drop-in zz-<id>.conf that pulls both in and reads the env
 * file. Nothing starts now: the unit loads it at the next head-unit start.
 * A new version starts the count again; so does removing and installing. */
function preloadFiles(entry) {
    const pl = entry.preload;
    const id = entry.id;
    const title = oneLine(entry.title);
    const D = `/var/opt/${id}`;
    const guard = `${id}-guard.service`;
    const check = `${id}-check.service`;
    const guardSh = `#!/bin/sh
# ${title} (${id}): boot guard for ${pl.library} in ${pl.unit}, from its repository's
# mgu-repo.json, installed by mgu-deploy (after idrive7-apps' deploy/mgu-app-install.sh inputgate).
D=${D}; SO=$D/current/${pl.library}; RUN=/run/${id}.env; N=$D/strikes; MAX=${pl.strikes}
n=$(cat "$N" 2>/dev/null); case "$n" in ''|*[!0-9]*) n=0;; esac
# a version installed since the count was kept starts it again
v=$(readlink "$D/current" 2>/dev/null)
if [ "$(cat "$D/strikes.version" 2>/dev/null)" != "$v" ]; then n=0; echo 0 > "$N"; echo "$v" > "$D/strikes.version"; fi
other_preload() {   # the unit's LD_PRELOAD without ours; the last assignment wins, as in systemd
    systemctl cat ${pl.unit} --no-pager 2>/dev/null | awk '
        /^# \\// { ours = index($0, "${id}") > 0; next }
        ours { next }
        /^[ \\t]*Environment=/ && index($0, "LD_PRELOAD=") {
            v = substr($0, index($0, "LD_PRELOAD=") + 11)
            q = index(v, "\\""); if (q) v = substr(v, 1, q - 1)
            last = v
        }
        END { print last }' | tr ':' ' ' | tr ' ' '\\n' | grep -v '^$' | grep -v '${id}' | tr '\\n' ' ' | sed 's/ $//'
}
case "\${1:-}" in
boot)
    rm -f "$RUN"
    [ -f "$SO" ] || exit 0
    if [ "$n" -ge $MAX ]; then
        echo "${id} left out: ${pl.process} did not come up healthy with it $n times in a row (remove and install it again to retry)"
        exit 0
    fi
    echo $((n + 1)) > "$N"; sync
    other=$(other_preload)
    echo "LD_PRELOAD=\${other:+$other }$SO" > "$RUN"
    ;;
check)   # (${check}, after ${pl.unit}) the process has run with the library long enough
    sleep ${pl.checkAfterSeconds}
    p=$(pidof ${pl.process} 2>/dev/null | cut -d' ' -f1)
    if [ -n "$p" ] && grep -q "${pl.library}" "/proc/$p/maps" 2>/dev/null && systemctl is-active -q ${pl.unit}; then
        up=$(cut -d. -f1 /proc/uptime); st=$(cut -d')' -f2 "/proc/$p/stat" | awk '{print $20}')
        if [ $((up - st / 100)) -ge ${pl.healthySeconds} ]; then echo 0 > "$N"; sync; echo "${id}: ${pl.process} healthy with it"; fi
    fi
    # never exit: the head unit's lifecycle reboots the unit when a service stops
    while :; do sleep 86400; done
    ;;
esac
exit 0
`;
    const guardUnit = `# ${title} (${id}): decides at boot whether ${pl.unit} loads ${pl.library}
[Unit]
Description=${id} boot guard
DefaultDependencies=no
RequiresMountsFor=${D}
Before=${pl.unit}

[Service]
Type=oneshot
# stays "active" after it ran: a service that stops makes the head unit's lifecycle reboot the unit
RemainAfterExit=yes
TimeoutStartSec=10
ExecStart=/bin/sh ${D}/current/guard.sh boot
`;
    const checkUnit = `# ${title} (${id}): ${pl.process} came up healthy with ${pl.library}: reset the guard
[Unit]
Description=${id} check
After=${pl.unit}
RequiresMountsFor=${D}

[Service]
# runs on after the check (never exits): a service that stops makes the head unit reboot
Type=simple
ExecStart=/bin/sh ${D}/current/guard.sh check
`;
    const dropin = `# ${title} (${id}): ${pl.library} in ${pl.unit}, loaded only if ${guard} puts /run/${id}.env there
[Unit]
Wants=${guard} ${check}
After=${guard}

[Service]
EnvironmentFile=-/run/${id}.env
`;
    return { guardSh, guard, guardUnit, check, checkUnit, dropinName: `zz-${id}.conf`, dropin };
}

function packPreload(entry, byPath) {
    const pl = entry.preload;
    const lib = byPath.get(pl.library);
    if (!lib) {
        throw new Error(`${entry.id}: ${entry.path}/${pl.library} is missing`);
    }
    const f = preloadFiles(entry);
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const guardSh = Buffer.from(f.guardSh);
    const manifest = {
        id: entry.id, kind: 'tool', version: entry.version, title: entry.title, description: entry.description,
        files: [{ path: pl.library, mode: '0755', sha256: sha(lib.data) }, { path: 'guard.sh', mode: '0755', sha256: sha(guardSh) }],
        units: [{ name: f.guard }, { name: f.check }], dropins: [{ unit: pl.unit, name: f.dropinName }],
        enable: [], recmgr: [], restart: []
    };
    if (entry.mguHmi) {
        manifest.mguHmi = entry.mguHmi;
    }
    if (entry.mguNeeds) {
        manifest.mguNeeds = entry.mguNeeds;
    }
    return tar.tgz([
        { name: 'component.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o644 },
        { name: `files/${pl.library}`, data: lib.data, mode: 0o755 },
        { name: 'files/guard.sh', data: guardSh, mode: 0o755 },
        { name: `units/${f.guard}`, data: Buffer.from(f.guardUnit), mode: 0o644 },
        { name: `units/${f.check}`, data: Buffer.from(f.checkUnit), mode: 0o644 },
        { name: `dropins/${pl.unit}.d/${f.dropinName}`, data: Buffer.from(f.dropin), mode: 0o644 }
    ].sort(byName), MTIME);
}

/* ---- an app built under another id ---------------------------------------------------- */

/* Whether a repo-tree app can be built under another id (renameApp): a
 * source package, or a build script's app whose folder is named for it. */
function renameable(entry) {
    return entry.kind === 'app' && !!entry.path && (!entry.script || (entry.path.split('/').pop() === entry.id && !!entry.buildSpec && !!entry.manifest));
}

const RENAME_NS = Buffer.from('3f6c8e1a2b7d4c5e9a0b1c2d3e4f5a6b', 'hex');
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/* A name-based (version 5) UUID of name. */
function uuid5(name) {
    const h = crypto.createHash('sha1').update(RENAME_NS).update(name).digest();
    h[6] = (h[6] & 0x0f) | 0x50;
    h[8] = (h[8] & 0x3f) | 0x80;
    const x = h.slice(0, 16).toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const json = (data, what, edit) => {
    const doc = parseJson(data, what);
    edit(doc);
    return Buffer.from(JSON.stringify(doc, null, 2) + '\n');
};

/* A repo-tree app made over to install as unitId beside another app of its
 * own id: { entry, files }, the entry with that id and the files to build
 * or pack. files: the repo's (a build script's app) or the app folder's (a
 * source package).
 *  - build script: a copy of the app's folder named unitId beside it, its
 *    manifest's id (package.json: name) unitId, and the script's {id} and
 *    {dir} filled in for it; whatever the script derives from the id (the
 *    package name, the RHMI names and UUIDs of idrive7-apps' build.py)
 *    follows.
 *  - source package: mgu-app.json's id (and a tree named <id>@<version>),
 *    the tree's package.json and npm-shrinkwrap.json name, its
 *    config/base.json settings key, rhmiData/application.json's name and
 *    entry-point names, and every UUID that application.json holds, made
 *    anew from unitId wherever the folder's text files name it. */
function renameApp(entry, files, unitId) {
    if (!renameable(entry)) {
        throw new Error(`${entry.id} cannot be built under another id`);
    }
    const version = entry.version;
    const artifact = Object.assign({}, entry.artifact, { name: `${unitId}@${version}.tgz` });
    if (entry.script) {
        const dir = entry.path;
        const to = `${dir.slice(0, dir.length - entry.id.length)}${unitId}`;
        if (files.some((f) => f.name.indexOf(`${to}/`) === 0)) {
            throw new Error(`${to} is already in the repo`);
        }
        const manifest = `${to}${entry.manifest.slice(dir.length)}`;
        const copies = files.filter((f) => f.name.indexOf(`${dir}/`) === 0).map((f) => ({
            name: `${to}${f.name.slice(dir.length)}`,
            data: f.name !== entry.manifest ? f.data : json(f.data, entry.manifest, (doc) => {
                doc[/(^|\/)package\.json$/.test(entry.manifest) ? 'name' : 'id'] = unitId;
            }),
            mode: f.mode
        }));
        // the script's network is the app's own, named by its id in the repo
        const script = Object.assign(checkScript(entry.buildSpec, { id: unitId, version, dir: to }), { network: entry.script.network });
        return { entry: Object.assign({}, entry, { id: unitId, path: to, manifest, script, artifact }), files: files.concat(copies) };
    }
    const own = files.find((f) => f.name === 'mgu-app.json');
    const m = own && parseJson(own.data, 'mgu-app.json');
    if (!m || m.id !== entry.id || !safeRel(m.tree || '')) {
        throw new Error(`${entry.path}/mgu-app.json does not name ${entry.id}`);
    }
    const tree = m.tree === `${entry.id}@${version}` ? `${unitId}@${version}` : m.tree;
    const inTree = (name) => (name.indexOf(`${m.tree}/`) === 0 ? `${tree}${name.slice(m.tree.length)}` : name);
    const rhmi = files.find((f) => f.name === `${m.tree}/rhmiData/application.json`);
    const uuids = new Map();
    (rhmi ? rhmi.data.toString('utf8').match(UUID) || [] : []).forEach((u) => uuids.set(u.toLowerCase(), uuid5(`${unitId}:${u.toLowerCase()}`)));
    const edits = {
        'mgu-app.json': (doc) => Object.assign(doc, { id: unitId, tree, modules: (doc.modules || []).map(inTree) }),
        [`${m.tree}/package.json`]: (doc) => { doc.name = unitId; },
        [`${m.tree}/npm-shrinkwrap.json`]: (doc) => { doc.name = doc.name === entry.id ? unitId : doc.name; },
        [`${m.tree}/config/base.json`]: (doc) => {
            if (doc.settings && Object.prototype.hasOwnProperty.call(doc.settings, entry.id)) {
                doc.settings[unitId] = doc.settings[entry.id];
                delete doc.settings[entry.id];
            }
        },
        [`${m.tree}/rhmiData/application.json`]: (doc) => {
            const app = doc.application || {};
            app.name = app.name === entry.id ? unitId : app.name;
            (app.entryPoints || []).forEach((ep) => {
                ep.name = ep && ep.name === entry.id ? unitId : ep.name;
            });
        }
    };
    const out = files.map((f) => {
        let data = edits[f.name] ? json(f.data, f.name, edits[f.name]) : f.data;
        if (uuids.size && /\.(json|js|xml)$/.test(f.name)) {
            data = Buffer.from(data.toString('utf8').replace(UUID, (u) => uuids.get(u.toLowerCase()) || u));
        }
        return { name: inTree(f.name), data, mode: f.mode };
    });
    return { entry: Object.assign({}, entry, { id: unitId, artifact }), files: out };
}

/* The id a built package installs as, read in the deploy tool's order
 * (mgu-deploy.js validateArtifact): a source package's mgu-app.json id, an
 * OAP package's package.json name (flat, under package/, an .mgu's
 * source/); null for a tool kit or anything else. */
function packageId(bytes, maxBytes) {
    return tar.untgz(bytes, maxBytes).then((members) => {
        const byName = new Map(members.map((m) => [m.name.replace(/^\.\//, ''), m.data]));
        if (byName.has('component.json')) {
            return null;
        }
        if (byName.has('mgu-app.json')) {
            return parseJson(byName.get('mgu-app.json'), 'mgu-app.json').id;
        }
        const pkg = ['package.json', 'package/package.json', 'source/package.json'].find((n) => byName.has(n));
        return pkg ? parseJson(byName.get(pkg), pkg).name : null;
    });
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

/* A repo's answer that another token (or none) may get past: 401, 404, or a
 * 403 that is no rate limit (an organisation's SSO, a permission). */
function refused(err) {
    return err.status === 401 || err.status === 404 || (err.status === 403 && !err.rateLimited);
}

function missing(err) {
    return err.status === 404 || err.code === 'ENOENT' || err.missing;
}

/* Every reader has: network (it needs the internet); catalog() -> { mode,
 * channel, commit, components, skipped }; artifact(entry, onProgress) -> a
 * catalog or releases entry's bytes; icon(entry) -> its icon's bytes (at most
 * ICON_BYTES; readers whose entries can name one); files(commit, onProgress, under) -> the
 * repo's files ({ name relative to the repo root, data, mode }) for a
 * repo-tree entry, those under the folder `under` when it is given. */

/* A folder source: catalog.json or mgu-repo.json at root. */
function folderReader(root, ctx) {
    const readFile = (rel) => Promise.resolve().then(() => readInside(root, rel, SMALL)).catch((err) => {
        throw Object.assign(err, { missing: err.code === 'ENOENT' });
    });
    // the folders in rel, none reached through a link
    const listDir = (rel) => Promise.resolve().then(() => {
        const dir = rel ? safePath(root, rel) : root;
        if (!fs.lstatSync(dir).isDirectory()) {
            throw new Error(`${rel}: not a folder`);
        }
        return fs.readdirSync(dir).filter((n) => !SKIP(n) && fs.lstatSync(path.join(dir, n)).isDirectory()).slice(0, 1000);
    }).catch((err) => {
        throw Object.assign(err, { missing: err.code === 'ENOENT' });
    });
    return {
        network: false,
        catalog: () => Promise.resolve().then(() => {
            if (!fs.lstatSync(root).isDirectory()) {
                throw new Error(`${root} is not a folder`);
            }
            // the source a stick folder is a copy of (mgu-install.js usb-repo)
            const copyOf = isFileInside(root, 'mgu-copy.json') ? readFile('mgu-copy.json')
                .then((b) => parseJson(b, 'mgu-copy.json').copyOf).catch(() => null) : Promise.resolve(null);
            if (isFileInside(root, 'catalog.json')) {
                return readFile('catalog.json').then((b) => Object.assign({ mode: 'catalog' }, catalogLib.parse(b.toString('utf8'))))
                    .then((cat) => copyOf.then((c) => Object.assign(cat, { copyOf: typeof c === 'string' ? c : null })));
            }
            if (isFileInside(root, 'mgu-repo.json')) {
                return repoCatalog(readFile, null, null, listDir)
                    .then((cat) => copyOf.then((c) => Object.assign(cat, { copyOf: typeof c === 'string' ? c : null })));
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
        requires: service ? { 'mgu-deploy': '0.4.0' } : undefined,
        icon: item.icon, iconSha256: item.iconSha256,
        artifact: { name: `${item.id}@${item.version}.tgz`, size: item.size, sha256: String(item.sha256).toLowerCase(), url, index: 2 },
        uninstallable: true
    });
}

/* An https source: catalog.json at a URL, artifacts absolute or relative
 * to it; or an App Manager index there (index mode), packages https,
 * absolute or relative to the index, each kept in
 * <cacheDir>/<source id>/<sha256>.tgz (root's, 0600; the ones the index no
 * longer lists go) once downloaded and checked against its sha256. Version
 * 2 lists its entries as they stand, a package downloaded on install and
 * checked to be the one its entry names; version 1, {"packages": [{url,
 * sha256}]}, has each package downloaded and read for what it is
 * (packageEntry). */
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
            // what a version 2 index says of a package is the package's own word
            const own = (b) => (entry.artifact.index !== 2 ? Promise.resolve(b) : tar.untgz(b, ctx.maxBuildBytes).then((members) => {
                const p = packageEntry(members, b, {}, 'tgz');
                if (p.id !== entry.id || p.version !== entry.version || p.service !== entry.service) {
                    throw new Error(`the package is ${p.id}@${p.version}${p.service ? ` (${p.service})` : ''}, not what the index says`);
                }
                return b;
            }));
            if (file && fs.existsSync(file)) {
                const b = fs.readFileSync(file);
                if (sha256(b) === entry.artifact.sha256) {
                    return own(b);
                }
            }
            const url = new URL(entry.artifact.url || entry.artifact.name, s.url).toString();
            const got = ctx.net.get(url, ua(ctx.version), entry.artifact.name, entry.artifact.size, onProgress);
            if (entry.artifact.index !== 2) {
                return got;
            }
            return got.then((b) => {
                if (sha256(b) !== entry.artifact.sha256) {
                    throw new Error('download does not match the catalog (size or sha256)');
                }
                return own(b).then(() => {
                    if (file) {
                        mkdirPrivate(cache);
                        writePrivate(file, b);
                    }
                    return b;
                });
            });
        },
        icon: (entry) => {
            if (entry.icon.packaged) {
                // a version 1 index's package, kept by its sha256
                const file = cached(entry.artifact.sha256);
                return file && fs.existsSync(file) ? packagedIcon(fs.readFileSync(file), entry, ctx.maxBuildBytes)
                    : Promise.reject(new Error('the package is not kept'));
            }
            const url = new URL(entry.icon.ref, s.url).toString();
            if (!/^https:\/\//.test(url)) {
                return Promise.reject(new Error('an icon needs an https url'));
            }
            return ctx.net.get(url, ua(ctx.version), 'icon.png', ICON_BYTES);
        },
        files: () => Promise.reject(new Error('an https source has no repo tree'))
    };
}

const PROBE_PAGES = 3;

/* Branch names in the order they are offered: main and master (those there
 * are), the default branch, then the others as listed. */
function orderBranches(names, defaultBranch) {
    const first = ['main', 'master'].filter((n) => names.indexOf(n) >= 0);
    if (typeof defaultBranch === 'string' && defaultBranch && first.indexOf(defaultBranch) < 0) {
        first.push(defaultBranch);
    }
    return first.concat(names.filter((n) => first.indexOf(n) < 0));
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
    // asked for again with their ETag: an unchanged answer is a 304 and the body kept from before
    const json = (url, name) => ctx.net.cached(url, headers(url, 'application/vnd.github+json'), name, 4 << 20)
        .then((b) => parseJson(b, url));
    // a listing read before from the same commit or the same catalog.json (its memoKey): the updater's copy
    const reuse = (key) => (ctx.reuse ? ctx.reuse(key) : null);
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
        // an asset replaced is a new asset (a new url); one edited in place has a new upload time
        const key = `catalog ${asset.url} ${asset.size} ${asset.updated_at || ''} ${asset.digest || ''}`;
        const known = reuse(key);
        if (known) {
            return Promise.resolve(known);
        }
        return raw(asset.url, 'catalog.json', 4 << 20).then((b) => {
            const cat = Object.assign({ mode: 'catalog', memoKey: key }, catalogLib.parse(b.toString('utf8')));
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
        // the listing follows from the assets alone (mgu-store.json's among them)
        const key = `releases ${crypto.createHash('sha256').update(assets.map((a) => `${a.name} ${a.url} ${a.size} ${a.updated_at || ''}`).join('\n')).digest('hex')}`;
        const known = reuse(key);
        if (known) {
            return Promise.resolve(known);
        }
        const titles = meta ? raw(meta.url, 'mgu-store.json', SMALL)
            .then((b) => (parseJson(b, 'mgu-store.json') || {}).apps || {}, () => null) : Promise.resolve({});
        return titles.then((apps) => ({
            mode: 'releases',
            // a listing without the titles mgu-store.json failed to give is not kept
            memoKey: apps ? key : null,
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
        // what a commit holds does not change
        const key = `repo ${sha} ${revision ? 'revision' : ''}`;
        const known = reuse(key);
        if (known) {
            return Promise.resolve(known);
        }
        const readFile = (rel) => content(`${repoUrl}/contents/${encode(rel)}?ref=${sha}`, path.posix.basename(rel), SMALL)
            .catch((e) => {
                throw Object.assign(e, { missing: e.status === 404 });
            });
        const listDir = (rel) => json(`${repoUrl}/contents/${encode(rel)}?ref=${sha}`, 'contents.json').then((items) => {
            if (!Array.isArray(items)) {
                throw new Error(`${rel}: not a folder`);
            }
            return items.filter((i) => i && i.type === 'dir' && typeof i.name === 'string').map((i) => i.name);
        }, (e) => {
            throw Object.assign(e, { missing: e.status === 404 });
        });
        return repoCatalog(readFile, sha, revision ? sha.slice(0, 7) : null, listDir).then((cat) => Object.assign(cat, { memoKey: key }), (e) => {
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
        // the head commit's sha alone (its media type): the commit's files are read only when it moved
        const url = `${repoUrl}/commits/${encodeURIComponent(branch)}`;
        return ctx.net.cached(url, headers(url, 'application/vnd.github.sha'), 'commit.sha', 1024)
            .then((b) => atCommit(b.toString('utf8').trim(), true), (err) => {
                throw err.status === 404 || err.status === 422 ? new Error(`no branch ${branch}`) : err;
            });
    };

    const branchList = (page, names) => json(`${repoUrl}/branches?per_page=100&page=${page}`, 'branches.json').then((list) => {
        const got = Array.isArray(list) ? list : [];
        const all = names.concat(got.map((b) => b && b.name).filter((n) => typeof n === 'string' && CHANNEL.test(`branch:${n}`)));
        return got.length === 100 && page < PROBE_PAGES ? branchList(page + 1, all) : { names: all, more: got.length === 100 };
    });

    return {
        network: true,
        /* What the repo can be added on: its name as GitHub spells it,
         * whether it has a release and an x.y.z tag, its default branch and
         * its branches (orderBranches). */
        probe: () => json(repoUrl, 'repo.json')
            // a 403 that is no rate limit (an SSO or permission refusal) leaves the repo to another token
            .catch((err) => {
                throw refused(err) ? authError(err.message) : err;
            })
            .then((repo) => Promise.all([releasesList(1), json(`${repoUrl}/tags?per_page=100`, 'tags.json'), branchList(1, [])])
                .then(([releases, tags, branches]) => {
                    const def = typeof repo.default_branch === 'string' && CHANNEL.test(`branch:${repo.default_branch}`) ? repo.default_branch : null;
                    return {
                        name: REPO.test(repo.full_name || '') ? repo.full_name : s.repo,
                        releases: releases.length > 0,
                        tags: (Array.isArray(tags) ? tags : []).some((t) => t && SEMVER_TAG.test(t.name || '')),
                        defaultBranch: def,
                        branches: orderBranches(branches.names, def),
                        more: branches.more
                    };
                })),
        catalog: () => json(repoUrl, 'repo.json')
            .catch((err) => {
                throw refused(err) ? authError(err.message) : err;
            })
            .then((repo) => {
                const branch = `branch:${repo.default_branch || 'main'}`;
                const done = (channel) => (c) => Object.assign(c, { channel, public: repo.private === false });
                if (s.channel) {
                    const channel = s.channel === 'branch' ? branch : s.channel;
                    return onChannel(channel).then(done(channel));
                }
                // no channel: the catalog release, else the releases, else the default branch
                return json(`${repoUrl}/releases/tags/catalog`, 'release.json').then((r) => fromCatalog(r).then(done('releases')), (err) => {
                    if (!missing(err)) {
                        throw err;
                    }
                    return releasesList(100).then((r) => (r.length ? fromReleases(r).then(done('releases')) : onChannel(branch).then(done(branch))));
                });
            })
            .catch((err) => {
                throw err.rateLimited ? Object.assign(new Error('GitHub rate limit reached'), { status: err.status, rateLimited: true }) : err;
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

/* An app package's package.json, en_GB entry-point text, HMIs and icon
 * (icon.png beside package.json), from its members: an OAP tgz flat or
 * under package/, or an .mgu (source/, rhmiData/ beside it). */
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
    // the store's picture (App Manager 2): icon.png beside package.json, a PNG of at most ICON_BYTES
    const ib = byName.get(`${base}icon.png`);
    const icon = ib && ib.length <= ICON_BYTES && ib.slice(0, 8).toString('hex') === '89504e470d0a1a0a'
        ? { ref: `${base}icon.png`, sha256: crypto.createHash('sha256').update(ib).digest('hex'), packaged: true } : null;
    return { pkg, title, hmi: hmi.length ? hmi.sort() : null, icon };
}


/* A package's catalog entry from its own members: an app, or a root-service
 * package (mguService: renderer or tether) as the tool the deploy tool
 * makes of it, which provides its kind and needs mgu-deploy 0.4.0 or
 * newer to install. An app that names no mguHmi is
 * for the HMIs its rhmiData has a UI for. */
function packageEntry(members, data, artifact, ext) {
    const { pkg, title, hmi, icon } = packageInfo(members);
    if (!ID.test(pkg.name || '') || !catalogLib.SEMVER.test(pkg.version || '')) {
        throw new Error('package.json needs a lower-case name and an x.y.z version');
    }
    const service = pkg.mguService === undefined ? null : pkg.mguService;
    if (service !== null && SERVICE_KINDS.indexOf(service) < 0) {
        throw new Error(`unknown mguService ${String(service).slice(0, 40)}`);
    }
    return Object.assign(catalogLib.checkExtras({
        id: pkg.name, kind: service ? 'tool' : 'app', version: pkg.version,
        title: title || (typeof pkg.productName === 'string' && pkg.productName) || pkg.name,
        // App Manager 2's store fields: store.description over description, author or author.name
        description: (pkg.store && typeof pkg.store.description === 'string' && pkg.store.description) ||
            (typeof pkg.description === 'string' ? pkg.description : ''),
        author: pkg.author && typeof pkg.author === 'object' ? pkg.author.name : pkg.author,
        mguHmi: pkg.mguHmi !== undefined ? pkg.mguHmi : service ? undefined : hmi,
        mguProvides: service || undefined, service,
        // the deploy tool that installs a service package as a tool
        requires: service ? { 'mgu-deploy': '0.4.0' } : undefined,
        artifact: Object.assign({ name: `${pkg.name}@${pkg.version}.${ext}`, size: data.length,
            sha256: crypto.createHash('sha256').update(data).digest('hex') }, artifact),
        uninstallable: true
    }), { icon });
}

/* A package's own icon (packageInfo: a member of it, packaged), from its bytes. */
function packagedIcon(data, entry, max) {
    return tar.untgz(data, max).then((members) => {
        // the last of a name, as packageInfo reads it
        const m = members.filter((x) => x.name.replace(/^\.\//, '') === entry.icon.ref).pop();
        if (!m) {
            throw new Error(`no ${entry.icon.ref} in the package`);
        }
        return m.data;
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
        icon: (entry) => Promise.resolve().then(() => packagedIcon(readInside(root, entry.artifact.url, ctx.maxRepoBytes), entry, ctx.maxBuildBytes)) };
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
    repoCatalog, packComponent, serviceUnit, preloadFiles, subtree, packageInfo, packageEntry, readInside, walkInside, authError,
    renameable, renameApp, packageId, uuid5, orderBranches, REPO, CHANNEL, PACKAGE, ICON_BYTES
};
