'use strict';
/**
 * Builds an OAP app from its source package: links the app's modules
 * against the oap-sdk modules of a donor bundle and packs the flat OAP tgz
 * (tools/oap_pack.js). The build machine (apps/<id>/tools/build.js) and the
 * head unit (the deploy tool, which ships this file) use the same code.
 * Node 8; no dependencies.
 *
 * A source package is an app folder, or a tgz of one, with mgu-app.json at
 * its root:
 *
 *   { "schema": 1, "id": "robertn_store", "version": "0.4.0",
 *     "tree": "robertn_store@0.4.0",          the staged package tree, without javascript/app.js
 *     "modules": ["src/store.js", ...],      the entry first; bundle ids 10000 up
 *     "sdk": ["oap-sdk/src/core/OnlineApp.js", ...],   require names the donor resolves
 *     "internet": true }                     optional: package.json gets "mguInternet": true
 *
 * The app's modules require each other as './<file name>'; any other name
 * is a Node builtin (resolved by the entry point's require) or one of `sdk`.
 *
 * The package's entry point, the file its package.json "main" names
 * (javascript/<file>.js), comes from the tree when it ships one. When it
 * does not, the build copies the entry point of a donor's own package (its
 * package.json "main"; the donor that supplies the sdk first), with a
 * runnerConfig.json beside it naming the app's bundle and data folder; with
 * no donor entry point it writes LOADER.
 *
 * A donor is a browserify bundle that carries the oap-sdk: a .js file, or an
 * OAP .tgz whose javascript/*.js files are tried in name order. The module
 * map handed to the browserify prelude is
 * evaluated to capture module functions and dependency tables without
 * calling the modules. Root runs split in an unprivileged child process;
 * the parent receives only JSON with function source text. The first donor
 * that resolves every `sdk` name to exactly one module id, with its whole
 * closure present, is used; that closure is copied with the donor's own ids.
 *
 * That is the "bundle" link mode, for our apps. The "module" mode serves
 * OAP packages built elsewhere whose code calls require('oap-sdk') and that
 * ship without node_modules/oap-sdk: preparePackage() generates that
 * module from the first donor holding the oap-sdk core (OnlineApp,
 * someipBuilders): the closure of the public API modules (SDK_API) with the
 * donor's ids, behind the browserify prelude, and one getter per API name
 * that loads its module on first use. The idea and the export shape follow
 * extract_sdk.js of github.com/cauliflowermossgrape/idrive7-apps (MIT); this
 * is a separate implementation.
 *
 *   const link = require('<repo>/tools/oap_link.js');
 *   link.build(srcDir, outFile, { donors: [path...], epoch, interfaces })
 *                                                              -> { file, donor, moduleCount, bytes, certification, unknown }
 *   link.packSource(appDir, outFile)                           -> the packed paths
 *   link.preparePackage(pkgDir, outFile, { donors, interfaces }) -> { file, sdk: null | { donor, api }, shrinkwrap,
 *                                                                 permissions, certification, unknown }
 *   link.needsSdk(pkgDir)                                      -> whether preparePackage generates oap-sdk
 *   link.needsCertification(pkgDir)                            -> whether its SOME/IP manifest lacks the certification service
 *   link.completePermissions(pkgDir)                           -> the ACL tables added to permissions.json
 *   link.completeCertification(pkgDir)                         -> the SOME/IP manifest the certification service was added to, or null
 *   link.unknownInterfaces(pkgDir, known)                      -> the interfaces its SOME/IP manifest names that known lacks
 *   link.dropUnknownInterfaces(pkgDir, known)                  -> null | { manifest, dropped }: those taken out of it
 *   link.sdkModule(donors)                                     -> module mode's donor and the oap-sdk module made from it
 *   link.unitDonors(mainappDir, oapDir, opts)                   -> the head unit's donors, in search order
 */
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');
/* Node before 8.10 (the 2019 MGU's 8.9.4) has no module.builtinModules; the
 * natives binding minus internal/ is the list Node 8.10 makes it from. */
const builtinModules = require('module').builtinModules ||
    Object.keys(process.binding('natives')).filter((name) => !/^internal\//.test(name));
const { pack, tgz, stampPackage, MTIME } = require('./oap_pack.js');

const ENTRY_ID = 10000;
const PRELUDE_END = 'return r})()';
const PRELUDE_END_MIN = 'return o}}()';
const SEMVER = /^\d+\.\d+\.\d+$/;
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/* written by the build, never part of a source package */
const BUILT = ['javascript/app.js', 'javascript/build.json'];
/* require('oap-sdk')'s public API: name -> module path inside oap-sdk */
const SDK_API = {
    OnlineApp: 'src/core/OnlineApp.js',
    NsmProxy: 'src/core/NsmProxy.js',
    config: 'src/config/config.js',
    logging: 'src/logging/logging.js',
    loggingLevel: 'src/logging/loggingLevel.js',
    SDKError: 'src/errors/SDKError.js',
    someipBuilders: 'src/someip/someipBuilders.js',
    RhmiApplication: 'src/rhmi/RhmiApplication.js',
    RhmiResourcesLocator: 'src/rhmi/RhmiResourcesLocator.js',
    telephony: 'src/telephony/telephony.js',
    getVin: 'src/utils/getVin.js',
    runtimeVariant: 'src/utils/runtimeVariant.js',
    appstart: 'src-gen/joynr-includes/telematics/appstart.js',
    guidance: 'src/navigation/guiding/guidance.js',
    map: 'src/navigation/map/map.js',
    MapKmlContentTypeConverters: 'src/navigation/map/MapKmlContentTypeConverters.js',
    poi: 'src/navigation/poi/poi.js'
};
const SDK_CORE = ['OnlineApp', 'someipBuilders'];

function safeRel(p) {
    return typeof p === 'string' && p !== '' && p[0] !== '/' && p.split('/').indexOf('..') < 0 &&
        p.indexOf('\\') < 0;
}

function skipped(name) {
    return name === '.DS_Store' || name.indexOf('._') === 0;
}

/* Files below dir as sorted '/'-separated relative paths. */
function filesBelow(dir) {
    const out = [];
    (function walk(d, rel) {
        fs.readdirSync(d).sort().forEach((name) => {
            if (skipped(name)) {
                return;
            }
            const p = path.join(d, name);
            const r = rel ? `${rel}/${name}` : name;
            if (fs.statSync(p).isDirectory()) {
                walk(p, r);
            } else {
                out.push(r);
            }
        });
    }(dir, ''));
    return out;
}

/* ---- donors ---------------------------------------------------------------- */

/* Regular files of a (gzipped) ustar archive, as { name, data }. */
function untar(buf) {
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        buf = zlib.gunzipSync(buf);
    }
    const out = [];
    let off = 0;
    let longName = null;
    while (off + 512 <= buf.length) {
        const h = buf.slice(off, off + 512);
        if (h.every((b) => b === 0)) {
            break;
        }
        const field = (start, len) => {
            const b = h.slice(start, start + len);
            const z = b.indexOf(0);
            return b.slice(0, z < 0 ? len : z).toString('utf8');
        };
        const size = parseInt(field(124, 12).trim() || '0', 8);
        const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
        let name = field(0, 100);
        if (field(257, 5) === 'ustar' && field(345, 155)) {
            name = `${field(345, 155)}/${name}`;
        }
        off += 512;
        const data = buf.slice(off, off + size);
        off += Math.ceil(size / 512) * 512;
        if (type === 'L') {
            longName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
        } else if (type === 'x') {
            const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
            longName = m ? m[1] : longName;
        } else {
            if (longName !== null) {
                name = longName;
                longName = null;
            }
            if (type === '0' || type === '7') {
                out.push({ name: name.replace(/^\.\//, ''), data });
            }
        }
    }
    return out;
}

/* The bundles a donor file offers, as { label, text, sdkVersion }: the
 * oap-sdk version is the one a donor package's package.json depends on. */
function donorSources(file) {
    if (/\.tgz$/.test(file)) {
        const members = untar(fs.readFileSync(file));
        let sdkVersion = null;
        members.filter((m) => /^(?:package\/)?package\.json$/.test(m.name)).forEach((m) => {
            try {
                sdkVersion = String((JSON.parse(m.data.toString('utf8')).dependencies || {})['oap-sdk'] || '')
                    .replace(/^[^\d]*/, '') || null;
            } catch (e) { /* no version */ }
        });
        let js = members.filter((m) => /^(?:package\/)?javascript\/[^/]+\.js$/.test(m.name));
        if (!js.length) {
            /* MainApp 6.5.5 preinstalled apps (e.g. x_call@3.7.2.tgz) keep
             * bundle.js and <id>.js at the package root rather than under
             * javascript/. */
            js = members.filter((m) => /^(?:package\/)?[^/]+\.js$/.test(m.name));
        }
        return js
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((m) => ({ label: `${path.basename(file)}:${m.name}`, text: m.data.toString('utf8'), sdkVersion }));
    }
    return [{ label: path.basename(file), text: fs.readFileSync(file, 'utf8'), sdkVersion: null }];
}

/* A browserify bundle's prelude and module map { id: [sourceText, deps] }.
 * Root never evaluates donor code: a bounded child runs as the split uid
 * and gid and returns JSON. Its stdin carries the bundle; a readable
 * scratch copy holds only the worker code. */
const SPLIT_TIMEOUT = 30000;
const SPLIT_MAX = 64 << 20;

function splitIdentity(name) {
    const value = process.env[name] || '65534';
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 0x7fffffff) {
        throw new Error(`${name} must be an unprivileged numeric id`);
    }
    return Number(value);
}

function splitBundle(text) {
    if (process.getuid && process.getuid() === 0) {
        const uid = splitIdentity('MGU_DEPLOY_SPLIT_UID');
        const gid = splitIdentity('MGU_DEPLOY_SPLIT_GID');
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-split-'));
        try {
            /* Kit/staging parents can be 0700. Only our worker code is
             * copied here; the donor stays on stdin. */
            ['oap_link.js', 'oap_pack.js'].forEach((name) => {
                const file = path.join(work, name);
                fs.writeFileSync(file, fs.readFileSync(path.join(__dirname, name)), { mode: 0o644 });
                fs.chmodSync(file, 0o644);
            });
            fs.chmodSync(work, 0o755);
            const r = cp.spawnSync(process.execPath, [path.join(work, 'oap_link.js'), 'split'], {
                input: text, encoding: 'utf8', uid, gid, timeout: SPLIT_TIMEOUT,
                killSignal: 'SIGKILL', maxBuffer: SPLIT_MAX, cwd: '/', env: {}
            });
            if (r.error || r.status !== 0) {
                throw new Error(`donor split failed: ${r.error ? r.error.message : r.signal || r.stderr.trim()}`);
            }
            return JSON.parse(r.stdout);
        } finally {
            rmrf(work);
        }
    }
    return splitInProcess(text);
}

/* The browserify prelude at the start of text ({ end, prelude }), or null:
 * unminified bundles end with 'return r})()'; 6.5.5 UglifyJS-minified
 * bundles (!function(){return function r(e,n,t){...return o}}()) end with
 * 'return o}}()', parenthesized so var x = <prelude>(...) returns o. */
function findPrelude(text) {
    const idx = text.indexOf(PRELUDE_END);
    if (idx >= 0) {
        const end = idx + PRELUDE_END.length;
        return { end, prelude: text.slice(0, end) };
    }
    const min = text.indexOf(PRELUDE_END_MIN);
    if (min >= 0 && /^\s*(?:\/\*[\s\S]*?\*\/\s*)?!function\(\)\{return function r\(e,n,t\)\{/.test(text)) {
        const end = min + PRELUDE_END_MIN.length;
        const raw = text.slice(0, end);
        return { end, prelude: raw.replace(/^(\s*(?:\/\*[\s\S]*?\*\/\s*)?)!(function\([\s\S]*\})\(\)$/, '$1($2)()') };
    }
    return null;
}

/* The context owns capture. No host function is exposed to donor code.
 * Anonymous function spacing is normalized for identical Node 8/host
 * bundles. Only string/number dependency ids survive serialization. */
function splitInProcess(text) {
    const found = findPrelude(text);
    if (!found) {
        throw new Error('no browserify prelude');
    }
    const sandbox = Object.create(null);
    vm.runInNewContext(`var mods; function capture(m) { mods = m; }\ncapture${text.slice(found.end).replace(/;\s*$/, '')}`,
        sandbox, { timeout: SPLIT_TIMEOUT });
    if (!sandbox.mods || typeof sandbox.mods !== 'object') {
        throw new Error('no module map');
    }
    const tight = /^\(\{\s*"?\d+"?:\[function\(/.test(text.slice(found.end, found.end + 64));
    const mods = Object.create(null);
    Object.keys(sandbox.mods).forEach((id) => {
        const m = sandbox.mods[id];
        if (!/^\d+$/.test(id) || !Array.isArray(m) || typeof m[0] !== 'function') {
            throw new Error('invalid module ' + id);
        }
        const source = Function.prototype.toString.call(m[0]);
        mods[id] = [tight ? source.replace(/^function \(/, 'function(') : source,
            JSON.parse(serializeDeps(m[1]))];
    });
    return { prelude: found.prelude, mods, tight };
}

/* The one module id a require name has in the donor's dependency tables. */
function resolveName(mods, name) {
    const ids = new Set();
    Object.keys(mods).forEach((id) => {
        const deps = mods[id] && mods[id][1];
        if (deps && Object.prototype.hasOwnProperty.call(deps, name) && typeof deps[name] === 'number') {
            ids.add(deps[name]);
        }
    });
    if (ids.size !== 1) {
        throw new Error(`"${name}" resolves to ${ids.size ? `[${[...ids].join(', ')}]` : 'nothing'}`);
    }
    return [...ids][0];
}

function closureOf(mods, roots) {
    const seen = new Set();
    const stack = roots.slice();
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) {
            continue;
        }
        if (!mods[id]) {
            throw new Error(`module ${id} is referenced but missing`);
        }
        seen.add(id);
        const deps = mods[id][1] || {};
        Object.keys(deps).forEach((k) => {
            if (typeof deps[k] === 'number') {
                stack.push(deps[k]);
            }
        });
    }
    return [...seen].sort((a, b) => a - b);
}

/* Bundle mode: every require name resolves to exactly one module id. */
function namesPick(names) {
    return (mods) => {
        const ids = {};
        names.forEach((n) => { ids[n] = resolveName(mods, n); });
        return ids;
    };
}

/* Module mode: the module ids of the public API names. A module has a
 * path inside oap-sdk when some module requires it as 'oap-sdk/<path>',
 * or relative to a module with a path; an API name whose path is no
 * module, or more than one, is left out. The core names are required. */
function apiPick(mods) {
    const norm = (p) => `${path.posix.normalize(p).replace(/\.js$/, '')}.js`;
    const pathOf = {};
    const queue = [];
    const name = (id, p) => {
        if (pathOf[id] === undefined) {
            pathOf[id] = p;
            queue.push(id);
        }
    };
    const depsOf = (id) => (mods[id] && mods[id][1]) || {};
    Object.keys(mods).forEach((id) => {
        const deps = depsOf(id);
        Object.keys(deps).forEach((k) => {
            if (k.indexOf('oap-sdk/') === 0 && typeof deps[k] === 'number') {
                name(deps[k], norm(k.slice('oap-sdk/'.length)));
            }
        });
    });
    while (queue.length) {
        const id = queue.shift();
        const deps = depsOf(id);
        Object.keys(deps).forEach((k) => {
            if (k[0] === '.' && typeof deps[k] === 'number') {
                const p = norm(path.posix.join(path.posix.dirname(pathOf[id]), k));
                if (p.indexOf('..') !== 0) {
                    name(deps[k], p);
                }
            }
        });
    }
    const byPath = {};
    Object.keys(pathOf).forEach((id) => { (byPath[pathOf[id]] = byPath[pathOf[id]] || []).push(Number(id)); });
    const ids = {};
    Object.keys(SDK_API).forEach((api) => {
        const found = byPath[SDK_API[api]];
        if (found && found.length === 1) {
            ids[api] = found[0];
        }
    });
    const missing = SDK_CORE.filter((api) => ids[api] === undefined);
    if (missing.length) {
        throw new Error(`no oap-sdk ${missing.join(', ')}`);
    }
    return ids;
}

/* The first donor bundle that names every string in `mustName` and that
 * pick(mods) accepts (returning { key: module id }), with the closure of
 * those ids. */
function findDonor(files, mustName, pick, what) {
    const tried = [];
    for (let i = 0; i < files.length; i += 1) {
        let sources;
        try {
            sources = donorSources(files[i]);
        } catch (e) {
            tried.push(`${path.basename(files[i])}: ${e.message}`);
            continue;
        }
        if (!sources.length) {
            tried.push(`${path.basename(files[i])}: no javascript/*.js`);
        }
        for (let j = 0; j < sources.length; j += 1) {
            const s = sources[j];
            const missing = mustName.filter((n) => s.text.indexOf(n) < 0);
            if (missing.length) {
                tried.push(`${s.label}: does not name ${missing[0]}`);
                continue;
            }
            try {
                const split = splitBundle(s.text);
                const ids = pick(split.mods);
                const closure = closureOf(split.mods, Object.keys(ids).map((k) => ids[k]));
                return { file: files[i], label: s.label, text: s.text, sdkVersion: s.sdkVersion, prelude: split.prelude,
                    mods: split.mods, ids, closure };
            } catch (e) {
                tried.push(`${s.label}: ${e.message}`);
            }
        }
    }
    const e = new Error(`no donor holds ${what}${tried.length ? `; tried: ${tried.join('; ')}` : ' (no donor found)'}`);
    e.noDonor = true;
    throw e;
}

/* Only stock BMW packages supply SDK code. Packages carrying the local
 * marker (even false), named in either manager list, or in opts.exclude
 * (on iDrive 8 the apps provisioning lists as preinstalled custom apps),
 * are excluded from both the preinstalled and installed searches. Missing/malformed package
 * metadata cannot establish a stock donor. */
function unitDonors(mainappDir, oapDir, opts) {
    opts = opts || {};
    const data = path.join(oapDir, 'oap_12201', 'data');
    const read = (file, absent) => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (e) { if (e.code === 'ENOENT') return absent; throw e; }
    };
    const local = read(opts.localOnlyFile || path.join(data, 'local-only-apps.json'), []);
    const custom = read(opts.customAppsFile || path.join(data, 'custom_apps.json'), {});
    if (!Array.isArray(local) || !custom || typeof custom !== 'object' || Array.isArray(custom)) {
        throw new Error('invalid donor exclusion lists');
    }
    const exclude = Array.isArray(opts.exclude) ? opts.exclude : [];
    const stock = (pkg) => pkg && typeof pkg.name === 'string' && pkg.name &&
        !Object.prototype.hasOwnProperty.call(pkg, 'mguLocalOnly') && local.indexOf(pkg.name) < 0 &&
        exclude.indexOf(pkg.name) < 0 &&
        !Object.prototype.hasOwnProperty.call(custom, pkg.name);
    const list = (dir, re) => {
        try {
            return fs.readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n));
        } catch (e) {
            return [];
        }
    };
    const out = list(path.join(mainappDir, 'preinstalled_apps'), /\.tgz$/).filter((file) => {
        try {
            const pkg = untar(fs.readFileSync(file)).filter((m) => /^(?:package\/)?package\.json$/.test(m.name));
            return pkg.length === 1 && stock(JSON.parse(pkg[0].data.toString('utf8')));
        } catch (e) { return false; }
    });
    list(oapDir, /^oap_\d+$/).forEach((home) => {
        let pkg;
        try { pkg = read(path.join(home, 'source', 'package.json'), null); }
        catch (e) { return; }
        if (stock(pkg)) {
            const js = list(path.join(home, 'source', 'javascript'), /\.js$/);
            (js.length ? js : list(path.join(home, 'source'), /\.js$/)).forEach((f) => out.push(f));
        }
    });
    return out;
}

/* ---- entry point ------------------------------------------------------------ */

/* The paths a stock entry point reads from the runnerConfig.json beside it:
 * the bundle beside it and the app home's data folder. */
const RUNNER_CONFIG = { DATA_RELATIVE_PATH: '../../data', JS_RELATIVE_PATH: './app.js' };
const LOADER = "'use strict';\n/* Entry point: runs the app bundle beside this file. */\nrequire('./app.js');\n";

/* The entry point of a donor file's package, { label, text }, or null: the
 * file its package.json "main" names (a .tgz's member, or beside a .js
 * donor's javascript/ folder), when it is no bundle and reads
 * runnerConfig.json. */
function packageEntry(file) {
    try {
        let pkg;
        let read;
        if (/\.tgz$/.test(file)) {
            const members = untar(fs.readFileSync(file));
            const meta = members.filter((m) => /^(?:package\/)?package\.json$/.test(m.name))[0];
            const root = meta.name.slice(0, -'package.json'.length);
            pkg = JSON.parse(meta.data.toString('utf8'));
            read = (rel) => members.filter((m) => m.name === root + rel).map((m) => m.data.toString('utf8'))[0];
        } else {
            const dir = path.dirname(file);
            const root = fs.existsSync(path.join(dir, 'package.json')) ? dir : path.join(dir, '..');
            pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
            read = (rel) => (fs.lstatSync(path.join(root, rel)).isFile() ? fs.readFileSync(path.join(root, rel), 'utf8') : null);
        }
        const main = typeof pkg.main === 'string' ? path.posix.normalize(pkg.main) : '';
        const text = safeRel(main) && /\.js$/.test(main) ? read(main) : null;
        return text && !findPrelude(text) && text.indexOf('runnerConfig.json') >= 0 ?
            { label: `${pkg.name}@${pkg.version}:${main}`, text } : null;
    } catch (e) {
        return null;
    }
}

/* Writes the entry point at main (javascript/<file>.js) in the scratch tree
 * work and its runnerConfig.json, from the first of the donor files whose
 * package has one, else LOADER; returns its label. */
function supplyEntry(work, main, files) {
    if (!/^javascript\/[^/]+\.js$/.test(main)) {
        throw new Error(`package.json main ${main || '(none)'} is not javascript/<file>.js`);
    }
    const entry = files.map(packageEntry).filter(Boolean)[0];
    fs.writeFileSync(path.join(work, main), entry ? entry.text : LOADER);
    const config = path.join(work, 'javascript', 'runnerConfig.json');
    if (entry && !fs.existsSync(config)) {
        fs.writeFileSync(config, JSON.stringify(RUNNER_CONFIG) + '\n');
    }
    return entry ? entry.label : 'loader';
}

/* ---- linking ----------------------------------------------------------------- */

function requiresOf(source) {
    const names = new Set();
    const re = /require\('([^']+)'\)/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        names.add(m[1]);
    }
    return [...names];
}

function moduleEntry(donor, id) {
    return `${id}:[${donor.mods[id][0]},${serializeDeps(donor.mods[id][1])}]`;
}

function serializeDeps(deps) {
    const out = {};
    Object.keys(deps || {}).forEach((name) => {
        if (typeof deps[name] === 'number' || typeof deps[name] === 'string') {
            out[name] = deps[name];
        }
    });
    return JSON.stringify(out);
}

/* The bundle text: the donor's closure with its ids, then the app modules
 * ({ name: './x.js', file, source }) from ENTRY_ID. */
function link(donor, modules, sdk) {
    const ids = {};
    modules.forEach((m, i) => {
        if (ids[m.name] !== undefined) {
            throw new Error(`two app modules are named ${m.name}`);
        }
        ids[m.name] = ENTRY_ID + i;
    });
    const app = modules.map((m, i) => {
        const deps = {};
        requiresOf(m.source).forEach((name) => {
            if (ids[name] !== undefined) {
                deps[name] = ids[name];
            } else if (sdk.indexOf(name) >= 0) {
                deps[name] = donor.ids[name];
            } else if (builtinModules.indexOf(name) < 0) {
                throw new Error(`${m.file} requires "${name}": not an app module, a Node builtin or an sdk name in mgu-app.json`);
            }
        });
        return `${ENTRY_ID + i}:[function(require,module,exports){\n${m.source}\n},${JSON.stringify(deps)}]`;
    });
    const parts = donor.closure.map((id) =>
        moduleEntry(donor, id)).concat(app);
    return '/* app modules (entry ' + ENTRY_ID + ') linked against the oap-sdk modules\n' +
        ' * of the donor named in build.json, by tools/oap_link.js. */\n' +
        `${donor.prelude}({${parts.join(',')}},{},[${ENTRY_ID}]);\n`;
}

/* ---- source packages ----------------------------------------------------------- */

function readManifest(srcDir) {
    let m;
    try {
        m = JSON.parse(fs.readFileSync(path.join(srcDir, 'mgu-app.json'), 'utf8'));
    } catch (e) {
        throw new Error(`mgu-app.json: ${e.code === 'ENOENT' ? 'missing' : 'does not parse'}`);
    }
    const bad = (why) => new Error(`mgu-app.json: ${why}`);
    if (!m || m.schema !== 1) throw bad('schema is not 1');
    if (!APP_ID.test(m.id || '')) throw bad(`bad id ${m.id}`);
    if (!SEMVER.test(m.version || '')) throw bad(`version is not x.y.z: ${m.version}`);
    if (!safeRel(m.tree) || !fs.existsSync(path.join(srcDir, m.tree, 'package.json'))) {
        throw bad(`tree ${m.tree} has no package.json`);
    }
    if (!Array.isArray(m.modules) || !m.modules.length || !m.modules.every((f) => safeRel(f) &&
        /\.js$/.test(f) && fs.existsSync(path.join(srcDir, f)))) {
        throw bad('modules must name the app\'s .js files, the entry first');
    }
    if (!Array.isArray(m.sdk) || !m.sdk.length || !m.sdk.every((n) => typeof n === 'string' && n)) {
        throw bad('sdk must list the require names the donor resolves');
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, m.tree, 'package.json'), 'utf8'));
    if (pkg.name !== m.id || pkg.version !== m.version) {
        throw bad(`${m.tree}/package.json is ${pkg.name}@${pkg.version}, not ${m.id}@${m.version}`);
    }
    return m;
}

/* The source package of an app folder: mgu-app.json, the modules and the
 * staged tree (without what the build writes), sorted, one mtime. */
function packSource(appDir, outFile) {
    const m = readManifest(appDir);
    const names = ['mgu-app.json'].concat(m.modules)
        .concat(filesBelow(path.join(appDir, m.tree)).filter((f) => BUILT.indexOf(f) < 0).map((f) => `${m.tree}/${f}`));
    const sorted = [...new Set(names)].sort();
    fs.writeFileSync(outFile, tgz(sorted.map((name) =>
        ({ name, data: fs.readFileSync(path.join(appDir, name)), mode: 0o644 })), MTIME));
    return sorted;
}

function copyTree(from, to) {
    filesBelow(from).forEach((rel) => {
        if (BUILT.indexOf(rel) >= 0) {
            return;
        }
        const dest = path.join(to, rel);
        rel.split('/').slice(0, -1).reduce((d, part) => {
            const next = path.join(d, part);
            if (!fs.existsSync(next)) {
                fs.mkdirSync(next);
            }
            return next;
        }, to);
        fs.writeFileSync(dest, fs.readFileSync(path.join(from, rel)));
    });
}

/* Whether file compiles as a CommonJS module, judged as `node --check file`
 * judges it (shebang line, then BOM, stripped; the module wrapper around
 * it; compiled, never run), in this process: a Node per file costs a third
 * of a second each on the unit. */
function nodeCheck(file) {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charAt(0) === '#' && text.charAt(1) === '!') {
        const nl = text.slice(2).search(/[\r\n]/);
        text = nl < 0 ? '' : text.slice(nl + 2);
    }
    if (text.charCodeAt(0) === 0xFEFF) {
        text = text.slice(1);
    }
    try {
        new vm.Script(require('module').wrap(text), { filename: file, displayErrors: true });
    } catch (e) {
        throw new Error(`node --check ${path.basename(file)}: ${String(e.stack || e).split('\n    at ')[0].trim()}`);
    }
}

/* Builds the source package in srcDir into the OAP tgz outFile, in a
 * scratch copy of its tree (opts.workDir, default the system's). opts.donors
 * lists donor files in search order; opts.epoch (seconds) is build.json's
 * buildTimestamp, the time of the build without it. The certification
 * proxy the tree's SOME/IP manifest lacks is added; `certification` names
 * that manifest when the package carries it. With opts.interfaces (the
 * unit's interface ids), the interfaces the manifest names and the unit
 * lacks are taken out; `unknown` is dropUnknownInterfaces' answer. */
function build(srcDir, outFile, opts) {
    opts = opts || {};
    const m = readManifest(srcDir);
    const modules = m.modules.map((f) => ({ name: `./${path.basename(f)}`, file: f,
        source: fs.readFileSync(path.join(srcDir, f), 'utf8') }));
    m.modules.forEach((f) => nodeCheck(path.join(srcDir, f)));
    const donor = findDonor(opts.donors || [], m.sdk, namesPick(m.sdk), m.sdk.join(', '));
    const bundle = link(donor, modules, m.sdk);
    const work = fs.mkdtempSync(path.join(opts.workDir || os.tmpdir(), 'oap-link-'));
    try {
        copyTree(path.join(srcDir, m.tree), work);
        if (!fs.existsSync(path.join(work, 'javascript'))) {
            fs.mkdirSync(path.join(work, 'javascript'));
        }
        const pkgFile = path.join(work, 'package.json');
        const raw = fs.readFileSync(pkgFile, 'utf8');
        const pkg = JSON.parse(raw);
        const main = typeof pkg.main === 'string' ? path.posix.normalize(pkg.main) : '';
        let entry = null;
        if (main && main !== 'javascript/app.js' && !(safeRel(main) && fs.existsSync(path.join(work, main)))) {
            entry = supplyEntry(work, main, [donor.file].concat((opts.donors || []).filter((f) => f !== donor.file)));
            nodeCheck(path.join(work, main));
        }
        const appJs = path.join(work, 'javascript', 'app.js');
        fs.writeFileSync(appJs, bundle);
        nodeCheck(appJs);
        if (m.internet === true && pkg.mguInternet !== true) {
            pkg.mguInternet = true;
            fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + (/\n$/.test(raw) ? '\n' : ''));
        }
        const completed = completeCertification(work);
        const unknown = dropUnknownInterfaces(work, opts.interfaces || null);
        const moduleCount = donor.closure.length + modules.length;
        fs.writeFileSync(path.join(work, 'javascript', 'build.json'), JSON.stringify({
            name: m.id,
            version: m.version,
            buildTimestamp: opts.epoch ? Number(opts.epoch) * 1000 : Date.now(),
            bundle: { entryModule: ENTRY_ID, moduleCount, appModules: modules.length, sdkModulesFrom: donor.label },
            main: entry ? { path: main, from: entry } : undefined
        }, null, 2) + '\n');
        const packed = pack(work, outFile);
        const certification = completed && packed.indexOf(completed.split(path.sep).join('/')) >= 0 ? completed : null;
        return { file: outFile, id: m.id, version: m.version, donor: donor.label, entry, moduleCount,
            bytes: Buffer.byteLength(bundle), certification, unknown };
    } finally {
        rmrf(work);
    }
}

/* ---- module mode: OAP packages built elsewhere ------------------------------------ */

const REQUIRES_SDK = /require\(\s*(['"])oap-sdk\1\s*\)/;
const BROWSERIFIED = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?(?:\(function\(\)\{function r\(e,n,t\)\{|!function\(\)\{return function r\(e,n,t\)\{)/;

/* Whether the package's own javascript calls require('oap-sdk') with no
 * node_modules/oap-sdk to answer it. Browserify bundles resolve their
 * requires themselves. */
function needsSdk(pkgDir) {
    if (fs.existsSync(path.join(pkgDir, 'node_modules', 'oap-sdk'))) {
        return false;
    }
    return filesBelow(pkgDir).some((rel) => {
        if (!/\.js$/.test(rel) || rel.split('/').indexOf('node_modules') >= 0) {
            return false;
        }
        const text = fs.readFileSync(path.join(pkgDir, rel), 'utf8');
        return REQUIRES_SDK.test(text) && !BROWSERIFIED.test(text);
    });
}

function sdkModuleText(donor) {
    return `/* require('oap-sdk'): the public API of the oap-sdk in ${donor.label}, generated
 * by tools/oap_link.js on this head unit. Each name loads its module on first use.
 * After extract_sdk.js of github.com/cauliflowermossgrape/idrive7-apps (MIT). */
var sdkRequire = ${donor.prelude}({${donor.closure.map((id) => moduleEntry(donor, id)).join(',\n')}},{},[]);
var ids = ${JSON.stringify(donor.ids)};
Object.keys(ids).forEach(function (name) {
    Object.defineProperty(module.exports, name, { enumerable: true, configurable: true, get: function () {
        var m = sdkRequire(ids[name]);
        return m && m[name] ? m[name] : m;
    } });
});
`;
}

/* The oap-sdk module module mode generates from the first donor holding
 * the oap-sdk core: { donor (its label), text (its bundle), sdkVersion,
 * api, index (index.js text), pkg (package.json text) }. */
function sdkModule(donors) {
    const donor = findDonor(donors || [], SDK_CORE, apiPick, `the oap-sdk core (${SDK_CORE.join(', ')})`);
    return {
        donor: donor.label, text: donor.text, sdkVersion: donor.sdkVersion || null, api: Object.keys(donor.ids), index: sdkModuleText(donor),
        pkg: JSON.stringify({ name: 'oap-sdk', version: donor.sdkVersion || '0.0.0', main: 'index.js',
            description: `generated from ${donor.label} by tools/oap_link.js` }, null, 2) + '\n'
    };
}

/* MainApp installs a package that has no node_modules/ through its
 * npm-shrinkwrap.json and refuses one that has neither. */
function needsShrinkwrap(pkgDir) {
    return !fs.existsSync(path.join(pkgDir, 'node_modules')) && !fs.existsSync(path.join(pkgDir, 'npm-shrinkwrap.json'));
}

/* MainApp's aclManager.js reads both tables of an app's permissions.json
 * and fails the install when either is missing. */
const ACL_TABLES = ['masterAccessTable', 'masterRegistrationTable'];

/* Adds the ACL tables permissions.json lacks, empty; returns their names.
 * One that does not parse as an object is left as it is. */
function completePermissions(pkgDir) {
    const file = path.join(pkgDir, 'permissions.json');
    let acl = {};
    if (fs.existsSync(file)) {
        try {
            acl = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            return [];
        }
        if (!acl || typeof acl !== 'object' || Array.isArray(acl)) {
            return [];
        }
    }
    const missing = ACL_TABLES.filter((t) => !Array.isArray(acl[t]));
    if (missing.length) {
        missing.forEach((t) => {
            acl[t] = [];
        });
        fs.writeFileSync(file, JSON.stringify(acl, null, 2) + '\n');
    }
    return missing;
}

/* MainApp makes an app's SOME/IP permissions (someipInterfaces/acl.json)
 * from the proxies its SOME/IP manifest names (package.json
 * oapAppSettings.someipManifest, manifest.json by default). Its install has
 * the certification service (cadaemon) create the app's keychain, called as
 * the app's uid, which the car's SOME/IP security lets through only when the
 * app's permissions name that service; without it no answer comes and the
 * install fails. */
const CERTIFICATION = 'de.bmw.infotainment.certification.Certification';
function someipManifestFile(pkgDir) {
    let pkg = null;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch (e) { /* the caller checks package.json */ }
    const name = pkg && pkg.oapAppSettings && typeof pkg.oapAppSettings.someipManifest === 'string' ?
        pkg.oapAppSettings.someipManifest : 'manifest.json';
    const file = path.resolve(pkgDir, name);
    return file.indexOf(path.resolve(pkgDir) + path.sep) === 0 ? file : null;
}
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/* The SOME/IP manifest as { file, manifest }, or null: no manifest, one
 * that does not parse, or one whose proxies are not an object. */
function readSomeipManifest(pkgDir) {
    const file = someipManifestFile(pkgDir);
    let m;
    try {
        m = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
    if (!m || typeof m !== 'object' || Array.isArray(m) || !(m.proxies === undefined || isMap(m.proxies))) {
        return null;
    }
    return { file, manifest: m };
}
/* The manifest object when it lacks the certification proxy, else null (no
 * manifest, one that does not parse, or one that names it). */
function certificationMissing(pkgDir) {
    const r = readSomeipManifest(pkgDir);
    return !r || (r.manifest.proxies && CERTIFICATION in r.manifest.proxies) ? null : r;
}
function needsCertification(pkgDir) {
    return certificationMissing(pkgDir) !== null;
}
/* Adds the certification proxy ("*", as MainApp's own apps name it) to the
 * manifest that lacks it; returns the manifest's name, or null. */
function completeCertification(pkgDir) {
    const miss = certificationMissing(pkgDir);
    if (!miss) {
        return null;
    }
    miss.manifest.proxies = Object.assign({}, miss.manifest.proxies, { [CERTIFICATION]: '*' });
    fs.writeFileSync(miss.file, JSON.stringify(miss.manifest, null, 2) + '\n');
    return path.relative(pkgDir, miss.file);
}

/* MainApp installs an app only when its interface database (the firmware's
 * /etc/oap/someip/someip-interfaces.json on iDrive 7) holds every interface
 * the app's SOME/IP manifest names, as a proxy or a service; older firmware
 * holds fewer. known lists the database's interface ids. The interfaces the
 * manifest names that known lacks, the certification service aside (the
 * install needs it); none when known is null or there is no manifest. */
function unknownInterfaces(pkgDir, known) {
    const r = known ? readSomeipManifest(pkgDir) : null;
    if (!r) {
        return [];
    }
    const has = new Set(known);
    const ids = ['proxies', 'services'].reduce((all, k) => all.concat(isMap(r.manifest[k]) ? Object.keys(r.manifest[k]) : []), []);
    return ids.filter((id, i) => id !== CERTIFICATION && !has.has(id) && ids.indexOf(id) === i);
}
/* Takes the interfaces unknownInterfaces names out of the manifest's proxies
 * and services; returns { manifest: its name, dropped: [id...] }, or null
 * when there is none to take out. */
function dropUnknownInterfaces(pkgDir, known) {
    const dropped = unknownInterfaces(pkgDir, known);
    if (!dropped.length) {
        return null;
    }
    const r = readSomeipManifest(pkgDir);
    ['proxies', 'services'].forEach((k) => {
        if (isMap(r.manifest[k])) {
            dropped.forEach((id) => delete r.manifest[k][id]);
        }
    });
    fs.writeFileSync(r.file, JSON.stringify(r.manifest, null, 2) + '\n');
    return { manifest: path.relative(pkgDir, r.file), dropped };
}

/* An OAP package folder (pkgDir is changed) as the flat tgz the head unit
 * installs: "mguLocalOnly": true in its package.json, node_modules/oap-sdk
 * generated when needsSdk(), an npm-shrinkwrap.json without dependencies
 * when needsShrinkwrap() (the package carries what it runs on; nothing is
 * fetched from npm), the ACL tables permissions.json lacks added empty, the
 * certification proxy its SOME/IP manifest lacks added, the interfaces it
 * names that opts.interfaces (the unit's interface ids) lacks taken out,
 * and every file packed (tools/oap_pack.js format). An oap-sdk the package ships stays as
 * it is. */
function preparePackage(pkgDir, outFile, opts) {
    opts = opts || {};
    let sdk = null;
    if (needsSdk(pkgDir)) {
        const m = sdkModule(opts.donors);
        const dir = path.join(pkgDir, 'node_modules', 'oap-sdk');
        [path.join(pkgDir, 'node_modules'), dir].forEach((d) => {
            if (!fs.existsSync(d)) {
                fs.mkdirSync(d);
            }
        });
        fs.writeFileSync(path.join(dir, 'index.js'), m.index);
        fs.writeFileSync(path.join(dir, 'package.json'), m.pkg);
        nodeCheck(path.join(dir, 'index.js'));
        sdk = { donor: m.donor, api: m.api };
    }
    const shrinkwrap = needsShrinkwrap(pkgDir);
    if (shrinkwrap) {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        fs.writeFileSync(path.join(pkgDir, 'npm-shrinkwrap.json'), JSON.stringify({ name: pkg.name, version: pkg.version,
            lockfileVersion: 1, requires: true, dependencies: {} }, null, 2) + '\n');
    }
    const permissions = completePermissions(pkgDir);
    const certification = completeCertification(pkgDir);
    const unknown = dropUnknownInterfaces(pkgDir, opts.interfaces || null);
    stampPackage(pkgDir);
    fs.writeFileSync(outFile, tgz(filesBelow(pkgDir).map((name) =>
        ({ name, data: fs.readFileSync(path.join(pkgDir, name)), mode: 0o644 })), MTIME));
    return { file: outFile, sdk, shrinkwrap, permissions, certification, unknown };
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

module.exports = { build, packSource, readManifest, preparePackage, completePermissions, completeCertification,
    unknownInterfaces, dropUnknownInterfaces,
    needsCertification, needsSdk, needsShrinkwrap, sdkModule, unitDonors, untar, SDK_API, ENTRY_ID,
    LOADER };

/* Private worker protocol: no donor code runs here with root privileges. */
if (require.main === module) {
    try {
        if (process.argv[2] !== 'split' || (process.getuid && process.getuid() === 0)) {
            throw new Error('split worker requires an unprivileged uid');
        }
        process.stdout.write(JSON.stringify(splitInProcess(fs.readFileSync(0, 'utf8'))));
    } catch (e) {
        process.stderr.write(e.message + '\n');
        process.exitCode = 1;
    }
}
