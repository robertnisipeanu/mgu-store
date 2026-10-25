'use strict';
/**
 * Builds and packages the store OAP app.
 *
 *   node tools/build.js
 *
 * Steps:
 *  0. Write the RHMI files from tools/gen_rhmi.js.
 *  1. Build javascript/app.js: a browserify-style bundle that links the app
 *     entry (src/store.js, module 10000), its texts (src/store_view.js,
 *     10001) and mgu-updater's socket client (native/mgu-updater/js/client.js,
 *     10002) against the oap-sdk
 *     modules carried in the shared SDK bundle (sdk/oap_sdk_bundle.js,
 *     oap-sdk 24.10.2). The donor is split without executing it: the
 *     browserify prelude is evaluated with a capture function in place of
 *     the registry call, yielding every module function and its dependency
 *     table; the transitive closure of the SDK modules the app requires is
 *     copied with the stock module ids. Node builtins (net, events) have no
 *     table entry and resolve through the runner's require.
 *  2. node --check every app module and the emitted bundle.
 *  3. Write javascript/build.json and bundle_inventory.json.
 *  4. Package the flat .tgz (files at the root, no package/ prefix, no
 *     macOS metadata) at robertn_store@0.3.2.tgz.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const builtinModules = require('module').builtinModules;

const HERE = path.join(__dirname, '..');
const REPO = path.join(HERE, '..', '..');
const { pack } = require(path.join(REPO, 'tools', 'oap_pack.js'));
const PKG_DIR = path.join(HERE, 'robertn_store@0.3.2');
const STOCK_BUNDLE = path.join(REPO, 'sdk', 'oap_sdk_bundle.js');
const UPDATER_JS = path.join(REPO, 'native', 'mgu-updater', 'js');
const OUT_PATH = path.join(PKG_DIR, 'javascript', 'app.js');
const BUILD_JSON = path.join(PKG_DIR, 'javascript', 'build.json');
const TGZ_PATH = path.join(HERE, 'robertn_store@0.3.2.tgz');
const ENTRY_ID = 10000;

/* App modules in id order, the entry first; required as './<name>'. */
const APP_MODULES = [
    path.join(HERE, 'src', 'store.js'),
    path.join(HERE, 'src', 'store_view.js'),
    path.join(UPDATER_JS, 'client.js')
];

function captureRegistry(bundlePath) {
    const src = fs.readFileSync(bundlePath, 'utf8');
    const marker = 'return r})()';
    const idx = src.indexOf(marker);
    if (idx < 0) {
        throw new Error('browserify prelude marker not found in donor bundle');
    }
    const head = src.slice(0, idx + marker.length);
    const argsSrc = src.slice(idx + marker.length);
    let mods = null;
    function capture(m) { mods = m; }
    eval(head); // eslint-disable-line no-eval
    eval('capture' + argsSrc.replace(/;\s*$/, '')); // eslint-disable-line no-eval
    if (!mods) {
        throw new Error('module map capture failed');
    }
    return { mods, prelude: head };
}

function resolveModuleId(mods, requireName) {
    const ids = new Set();
    Object.values(mods).forEach(([, deps]) => {
        if (deps && Object.prototype.hasOwnProperty.call(deps, requireName) &&
            typeof deps[requireName] === 'number') {
            ids.add(deps[requireName]);
        }
    });
    if (ids.size !== 1) {
        throw new Error(`require "${requireName}" resolves to [${[...ids]}], expected exactly one`);
    }
    return [...ids][0];
}

function closureOf(mods, roots) {
    const seen = new Set();
    const stack = [...roots];
    while (stack.length > 0) {
        const id = stack.pop();
        if (seen.has(id)) {
            continue;
        }
        if (!mods[id]) {
            throw new Error(`module ${id} referenced but not present in donor bundle`);
        }
        seen.add(id);
        Object.values(mods[id][1] || {}).forEach((dep) => {
            if (typeof dep === 'number') {
                stack.push(dep);
            }
        });
    }
    return seen;
}

function serializeDepMap(deps) {
    const out = {};
    Object.entries(deps || {}).forEach(([name, dep]) => {
        if (typeof dep === 'number' || typeof dep === 'string') {
            out[name] = dep;
        }
    });
    return JSON.stringify(out);
}

function requiresOf(source) {
    const names = new Set();
    const re = /require\('([^']+)'\)/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        names.add(m[1]);
    }
    return [...names];
}

function buildBundle() {
    const { mods, prelude } = captureRegistry(STOCK_BUNDLE);
    const ids = {};
    APP_MODULES.forEach((file, i) => { ids[`./${path.basename(file)}`] = ENTRY_ID + i; });

    const sdkRequires = {};
    const builtins = new Set();
    const appModules = APP_MODULES.map((file, i) => {
        const source = fs.readFileSync(file, 'utf8');
        const deps = {};
        requiresOf(source).forEach((name) => {
            if (ids[name] !== undefined) {
                deps[name] = ids[name];
            } else if (name.startsWith('oap-sdk/')) {
                sdkRequires[name] = sdkRequires[name] || resolveModuleId(mods, name);
                deps[name] = sdkRequires[name];
            } else if (builtinModules.indexOf(name) >= 0) {
                builtins.add(name);
            } else {
                throw new Error(`${file} requires "${name}", which is neither bundled nor a Node builtin`);
            }
        });
        return { file: path.relative(REPO, file), id: ENTRY_ID + i, source, deps };
    });

    const closure = closureOf(mods, Object.values(sdkRequires));
    const parts = [];
    [...closure].sort((a, b) => a - b).forEach((id) => {
        parts.push(`${id}:[${mods[id][0].toString()},${serializeDepMap(mods[id][1])}]`);
    });
    appModules.forEach((m) => {
        parts.push(`${m.id}:[function(require,module,exports){\n${m.source}\n},${JSON.stringify(m.deps)}]`);
    });

    const header =
        '/* store bundle: app modules (entry ' + ENTRY_ID + ') linked against\n' +
        ' * oap-sdk modules from the donor bundle named in build.json.\n' +
        ' * Built by tools/build.js; see CHANGELOG.md. */\n';
    const bundle = `${header}${prelude}({${parts.join(',')}},{},[${ENTRY_ID}]);\n`;
    fs.writeFileSync(OUT_PATH, bundle);

    const externals = new Set(builtins);
    closure.forEach((id) => {
        Object.entries(mods[id][1] || {}).forEach(([name, dep]) => {
            if (typeof dep === 'string' || dep === undefined) {
                externals.add(name);
            }
        });
    });
    const inventory = {
        donorBundle: 'sdk/oap_sdk_bundle.js (oap-sdk 24.10.2)',
        entryModule: ENTRY_ID,
        appModules: appModules.map((m) => ({ file: m.file, id: m.id, deps: m.deps })),
        sdkRequires,
        moduleCount: closure.size + appModules.length,
        extractedModuleIds: [...closure].sort((a, b) => a - b),
        externals: [...externals].sort(),
        bundleBytes: Buffer.byteLength(bundle)
    };
    fs.writeFileSync(path.join(HERE, 'bundle_inventory.json'),
        JSON.stringify(inventory, null, 2) + '\n');
    return inventory;
}

function nodeCheck(file) {
    cp.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

function writeBuildJson(inventory) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
    const buildJson = {
        name: pkg.name,
        version: pkg.version,
        // release builds set SOURCE_DATE_EPOCH (release/README.md)
        buildTimestamp: process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now(),
        bundle: {
            entryModule: inventory.entryModule,
            moduleCount: inventory.moduleCount,
            appModules: inventory.appModules.length,
            sdkModulesFrom: 'sdk/oap_sdk_bundle.js',
            oapSdkVersion: '24.10.2'
        }
    };
    fs.writeFileSync(BUILD_JSON, JSON.stringify(buildJson, null, 2) + '\n');
}

/* The flat, reproducible tgz (tools/oap_pack.js). */
function packageTgz() {
    pack(PKG_DIR, TGZ_PATH);
    return TGZ_PATH;
}

function main() {
    require('./gen_rhmi.js').write();
    const inventory = buildBundle();
    APP_MODULES.forEach(nodeCheck);
    nodeCheck(OUT_PATH);
    writeBuildJson(inventory);
    const tgz = packageTgz();
    console.log(JSON.stringify({
        appModules: inventory.appModules.map((m) => `${m.id}=${m.file}`),
        bundleModules: inventory.moduleCount,
        bundleBytes: inventory.bundleBytes,
        externals: inventory.externals,
        tgz: path.relative(HERE, tgz),
        tgzBytes: fs.statSync(tgz).size
    }, null, 2));
}

main();
