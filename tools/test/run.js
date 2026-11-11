'use strict';
/**
 * Tests of tools/oap_link.js and tools/oap_pack.js on the head unit's
 * Node 8.16.2 (tools/test/run.sh runs them in Docker), against the made-up
 * donor in synthetic_donor.js.
 *
 *   node tools/test/run.js
 *
 * With real donors on this machine (never copied into the repository):
 *   MGU_TEST_DONORS=<donor>[:<donor>...]  donors (.tgz or .js) that carry
 *       one oap-sdk build with the same module ids (x_call@4.25.3.tgz and
 *       the oap-sdk 24.10.2 bundle do): each links the Store into the same
 *       javascript/app.js, and gives every require('oap-sdk') name it holds
 *       the first donor's module id; the first holds all 17
 *   MGU_TEST_THIRDPARTY=<dir>             OAP packages built elsewhere
 *       (*.tgz, *.mgu, without node_modules/oap-sdk) prepare with the
 *       first donor
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const link = require('../oap_link.js');
const { tgz } = require('../oap_pack.js');
const donor = require('./synthetic_donor.js');

const REPO = path.join(__dirname, '..', '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-link-test-'));
let n = 0;
let failed = 0;

function check(name, cond, detail) {
    n += 1;
    if (cond) {
        console.log(`ok ${n} - ${name}`);
    } else {
        failed += 1;
        console.log(`not ok ${n} - ${name}${detail ? `\n  # ${String(detail).split('\n').join('\n  # ')}` : ''}`);
    }
}

function write(p, data) {
    p.split(path.sep).slice(1, -1).reduce((d, part) => {
        const next = `${d}${path.sep}${part}`;
        if (!fs.existsSync(next)) {
            fs.mkdirSync(next);
        }
        return next;
    }, '');
    fs.writeFileSync(p, data);
}

function tmp(name) {
    return fs.mkdtempSync(path.join(T, `${name}-`));
}

/* The members of a tgz, as { name: Buffer }. */
function members(file) {
    const out = {};
    link.untar(fs.readFileSync(file)).forEach((m) => { out[m.name] = m.data; });
    return out;
}

function extract(file) {
    const dir = tmp('x');
    const m = members(file);
    Object.keys(m).forEach((name) => write(path.join(dir, name), m[name]));
    return dir;
}

/* The module ids of a bundle's map, in order. */
function ids(text) {
    const out = [];
    const re = /[{,\n](\d+):\[function\(require,module,exports\)\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        out.push(Number(m[1]));
    }
    return out;
}

function throws(fn) {
    try {
        fn();
    } catch (e) {
        return e;
    }
    return null;
}

/* A source package folder: modules src/app.js (entry) and lib/view.js. */
function sourceApp(extra) {
    const dir = tmp('src');
    const m = Object.assign({ schema: 1, id: 'robertn_demo', version: '1.2.3', tree: 'robertn_demo@1.2.3',
        modules: ['src/app.js', 'lib/view.js'], sdk: ['oap-sdk/src/core/OnlineApp.js'] }, extra);
    write(path.join(dir, 'mgu-app.json'), JSON.stringify(m));
    write(path.join(dir, 'src', 'app.js'), "'use strict';\nconst { OnlineApp } = require('oap-sdk/src/core/OnlineApp.js');\n" +
        "const view = require('./view.js');\nprocess.stdout.write(view.text(new OnlineApp('demo')));\n");
    write(path.join(dir, 'lib', 'view.js'), "'use strict';\nconst EventEmitter = require('events');\n" +
        "exports.text = (app) => `${app.name} ${typeof app.log.info} ${typeof EventEmitter}`;\n");
    write(path.join(dir, m.tree, 'package.json'), JSON.stringify({ name: m.id, version: m.version, files: ['javascript', 'package.json'] }));
    write(path.join(dir, m.tree, 'javascript', 'runner.js'), '// runner\n');
    write(path.join(dir, m.tree, 'javascript', 'app.js'), '// a stale build, never packed\n');
    return dir;
}

function testBundleMode() {
    const donorTgz = donor.tgz(path.join(tmp('donor'), 'donor_app@1.0.0.tgz'));
    const src = sourceApp({ internet: true });
    const out = path.join(tmp('out'), 'robertn_demo@1.2.3.tgz');
    const r = link.build(src, out, { donors: [donorTgz], epoch: 1700000000 });
    check('bundle: build names the donor bundle and the module count',
        r.donor === 'donor_app@1.0.0.tgz:javascript/app.js' && r.moduleCount === 5, JSON.stringify(r));
    const m = members(out);
    const app = m['javascript/app.js'].toString();
    check('bundle: the closure of the sdk names with the donor\'s ids, then the app from 10000',
        /^\/\*/.test(app) && ids(app).join(' ') === '2 3 5 10000 10001' && /\{\},\[10000\]\);\n$/.test(app), ids(app).join(' '));
    const dir = extract(out);
    const run = cp.spawnSync(process.execPath, [path.join(dir, 'javascript', 'app.js')], { encoding: 'utf8' });
    check('bundle: the linked app runs, the sdk and builtins resolved', run.status === 0 && run.stdout === 'demo function function',
        run.stdout + run.stderr);
    const pkg = JSON.parse(m['package.json']);
    check('bundle: package.json marked local-only, and mguInternet from "internet"', pkg.mguLocalOnly === true && pkg.mguInternet === true);
    const bj = JSON.parse(m['javascript/build.json']);
    check('bundle: build.json', bj.name === 'robertn_demo' && bj.version === '1.2.3' && bj.buildTimestamp === 1700000000000 &&
        bj.bundle.entryModule === 10000 && bj.bundle.moduleCount === 5 && bj.bundle.appModules === 2 &&
        bj.bundle.sdkModulesFrom === r.donor, JSON.stringify(bj));
    check('bundle: the package is flat, its files[] packed, the source folder unchanged',
        Object.keys(m).sort().join(' ') === 'javascript/app.js javascript/build.json javascript/runner.js package.json' &&
        fs.readFileSync(path.join(src, 'robertn_demo@1.2.3', 'javascript', 'app.js'), 'utf8') === '// a stale build, never packed\n');
    const again = path.join(tmp('out'), 'again.tgz');
    link.build(src, again, { donors: [donorTgz], epoch: 1700000000 });
    check('bundle: the same inputs give the same bytes', fs.readFileSync(again).equals(fs.readFileSync(out)));

    const js = path.join(tmp('donor'), 'bundle.js');
    fs.writeFileSync(js, donor.bundle());
    const other = path.join(tmp('donor'), 'other.js');
    fs.writeFileSync(other, '/* not a donor */\n');
    const r2 = link.build(src, path.join(tmp('out'), 'b.tgz'), { donors: [other, path.join(T, 'missing.tgz'), js], epoch: 1700000000 });
    check('bundle: donors are tried in order, a .js donor links the same bundle', r2.donor === 'bundle.js' &&
        members(path.join(path.dirname(r2.file), 'b.tgz'))['javascript/app.js'].equals(m['javascript/app.js']), r2.donor);

    const e = throws(() => link.build(sourceApp({ sdk: ['oap-sdk/src/core/Nope.js'] }), path.join(tmp('out'), 'x.tgz'),
        { donors: [other, donorTgz] }));
    check('bundle: no donor resolving a name fails, saying what each one lacked', e && e.noDonor &&
        /no donor holds oap-sdk\/src\/core\/Nope\.js/.test(e.message) && e.message.indexOf('other.js: does not name') >= 0, e && e.message);
    const bad = sourceApp();
    fs.writeFileSync(path.join(bad, 'lib', 'view.js'), "require('left-pad');\n");
    const e2 = throws(() => link.build(bad, path.join(tmp('out'), 'y.tgz'), { donors: [donorTgz] }));
    check('bundle: a require that is no module, builtin or sdk name fails', e2 && /requires "left-pad"/.test(e2.message), e2 && e2.message);
    const syntax = sourceApp();
    fs.writeFileSync(path.join(syntax, 'lib', 'view.js'), 'exports.text = (;\n');
    const e3 = throws(() => link.build(syntax, path.join(tmp('out'), 'z.tgz'), { donors: [donorTgz] }));
    check('bundle: a module that does not compile fails node --check', e3 && /node --check view\.js/.test(e3.message), e3 && e3.message);
    [[{ version: '1.2' }, 'version is not x.y.z'], [{ tree: '../x' }, 'tree ../x has no package.json'],
        [{ modules: ['src/nope.js'] }, 'modules must name'], [{ version: '1.2.4' }, 'is robertn_demo@1.2.3, not robertn_demo@1.2.4']]
        .forEach(([edit, why]) => {
            const dir = sourceApp();
            const file = path.join(dir, 'mgu-app.json');
            fs.writeFileSync(file, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(file, 'utf8')), edit)));
            const err = throws(() => link.readManifest(dir));
            check(`bundle: mgu-app.json refused: ${why}`, err && err.message.indexOf(why) >= 0, err && err.message);
        });
}

/* A source package whose tree ships no entry point: package.json main
 * javascript/runner.js, no file there. */
function entrylessApp() {
    const dir = sourceApp();
    const tree = path.join(dir, 'robertn_demo@1.2.3');
    fs.unlinkSync(path.join(tree, 'javascript', 'runner.js'));
    write(path.join(tree, 'package.json'), JSON.stringify({ name: 'robertn_demo', version: '1.2.3', main: 'javascript/runner.js',
        files: ['javascript', 'package.json'] }));
    return dir;
}

function runMain(file) {
    const dir = extract(file);
    return cp.spawnSync(process.execPath, [path.join(dir, 'javascript', 'runner.js')], { encoding: 'utf8' });
}

function testEntryPoint() {
    const withEntry = donor.tgz(path.join(tmp('donor'), 'donor_app@1.0.0.tgz'), { main: './javascript/entry.js' });
    const out = path.join(tmp('out'), 'e.tgz');
    const r = link.build(entrylessApp(), out, { donors: [withEntry], epoch: 1700000000 });
    let m = members(out);
    check('entry: the donor package\'s main is copied as the tree\'s main, with runnerConfig.json',
        r.entry === 'donor_app@1.0.0:javascript/entry.js' && m['javascript/runner.js'].toString() === donor.ENTRY &&
        JSON.stringify(JSON.parse(m['javascript/runnerConfig.json'])) ===
            '{"DATA_RELATIVE_PATH":"../../data","JS_RELATIVE_PATH":"./app.js"}', JSON.stringify(r));
    check('entry: build.json names it', JSON.stringify(JSON.parse(m['javascript/build.json']).main) ===
        '{"path":"javascript/runner.js","from":"donor_app@1.0.0:javascript/entry.js"}');
    let run = runMain(out);
    check('entry: the built app runs through it', run.status === 0 && run.stdout === 'demo function function', run.stdout + run.stderr);

    const plain = donor.tgz(path.join(tmp('donor'), 'plain.tgz'));
    const r2 = link.build(entrylessApp(), path.join(tmp('out'), 'f.tgz'), { donors: [plain, withEntry], epoch: 1700000000 });
    check('entry: from the next donor\'s package when the sdk donor\'s has none',
        r2.donor === 'plain.tgz:javascript/app.js' && r2.entry === 'donor_app@1.0.0:javascript/entry.js', JSON.stringify(r2));

    const loaderOut = path.join(tmp('out'), 'g.tgz');
    const bundleMain = donor.tgz(path.join(tmp('donor'), 'bundle_main.tgz'), { main: 'javascript/app.js' });
    const r3 = link.build(entrylessApp(), loaderOut, { donors: [plain, bundleMain], epoch: 1700000000 });
    m = members(loaderOut);
    run = runMain(loaderOut);
    check('entry: no donor entry point (none, or a main that is a bundle): the loader, no runnerConfig.json',
        r3.entry === 'loader' && m['javascript/runner.js'].toString() === link.LOADER && !m['javascript/runnerConfig.json'],
        JSON.stringify(r3));
    check('entry: the built app runs through the loader', run.status === 0 && run.stdout === 'demo function function',
        run.stdout + run.stderr);

    const home = tmp('home');
    write(path.join(home, 'package.json'), JSON.stringify({ name: 'stock_app', version: '2.0.0', main: 'javascript/entry.js' }));
    write(path.join(home, 'javascript', 'app.js'), donor.bundle());
    write(path.join(home, 'javascript', 'entry.js'), donor.ENTRY);
    const r4 = link.build(entrylessApp(), path.join(tmp('out'), 'h.tgz'), { donors: [path.join(home, 'javascript', 'app.js')] });
    check('entry: a .js donor\'s entry point is its package\'s main beside its javascript/',
        r4.entry === 'stock_app@2.0.0:javascript/entry.js', JSON.stringify(r4));

    const shipped = sourceApp();
    write(path.join(shipped, 'robertn_demo@1.2.3', 'package.json'), JSON.stringify({ name: 'robertn_demo', version: '1.2.3',
        main: 'javascript/runner.js', files: ['javascript', 'package.json'] }));
    const r5 = link.build(shipped, path.join(tmp('out'), 'i.tgz'), { donors: [withEntry] });
    check('entry: a tree that ships its main keeps it', r5.entry === null &&
        members(r5.file)['javascript/runner.js'].toString() === '// runner\n', JSON.stringify(r5));

    const odd = entrylessApp();
    write(path.join(odd, 'robertn_demo@1.2.3', 'package.json'), JSON.stringify({ name: 'robertn_demo', version: '1.2.3',
        main: 'lib/start.js' }));
    const e = throws(() => link.build(odd, path.join(tmp('out'), 'j.tgz'), { donors: [withEntry] }));
    check('entry: a missing main outside javascript/ fails', e && /main lib\/start\.js is not javascript\/<file>\.js/.test(e.message),
        e && e.message);
}

function testPackSource() {
    const src = sourceApp();
    const a = path.join(tmp('pkg'), 'a.tgz');
    const b = path.join(tmp('pkg'), 'b.tgz');
    const list = link.packSource(src, a);
    link.packSource(src, b);
    check('source: mgu-app.json, the modules and the tree without the built files, sorted',
        list.join(' ') === 'lib/view.js mgu-app.json robertn_demo@1.2.3/javascript/runner.js robertn_demo@1.2.3/package.json src/app.js',
        list.join(' '));
    check('source: reproducible', fs.readFileSync(a).equals(fs.readFileSync(b)));
    const dir = extract(a);
    const out = path.join(tmp('out'), 'built.tgz');
    check('source: the extracted package builds', link.build(dir, out, { donors: [donor.tgz(path.join(tmp('d'), 'd.tgz'))] }).moduleCount === 5);
}

/* An OAP package built elsewhere: its code calls require('oap-sdk'). */
function thirdParty(opts) {
    opts = opts || {};
    const dir = tmp('tp');
    write(path.join(dir, 'package.json'), JSON.stringify({ name: 'warmup', version: '1.4.3', main: 'javascript/app.js' }));
    write(path.join(dir, 'javascript', 'app.js'), "'use strict';\nconst kit = require('./kit/mgu.js');\nkit.start();\n");
    write(path.join(dir, 'javascript', 'kit', 'mgu.js'), "'use strict';\nconst { OnlineApp, logging, someipBuilders, SDKError } = require(\"oap-sdk\");\n" +
        'exports.start = () => process.stdout.write([new OnlineApp("w").name, typeof logging.getLogger, ' +
        'typeof someipBuilders.emitter().on, typeof SDKError].join(" "));\n');
    if (opts.vendored) {
        write(path.join(dir, 'node_modules', 'oap-sdk', 'index.js'), '// their own\n');
    }
    return dir;
}

function testModuleMode() {
    const donorTgz = donor.tgz(path.join(tmp('donor'), 'donor_app@1.0.0.tgz'), { version: '^24.10.2' });
    const pkg = thirdParty();
    check('module: a package calling require(\'oap-sdk\') without it needs it', link.needsSdk(pkg));
    const out = path.join(tmp('out'), 'warmup@1.4.3.tgz');
    const r = link.preparePackage(pkg, out, { donors: [donorTgz] });
    check('module: generated from the donor with the API names it holds', r.sdk && r.sdk.donor === 'donor_app@1.0.0.tgz:javascript/app.js' &&
        r.sdk.api.slice().sort().join(' ') === 'OnlineApp SDKError logging someipBuilders', JSON.stringify(r.sdk));
    const dir = extract(out);
    const run = cp.spawnSync(process.execPath, [path.join(dir, 'javascript', 'app.js')], { encoding: 'utf8' });
    check('module: the app runs against the generated oap-sdk (class, module, object, nested module)',
        run.status === 0 && run.stdout === 'w function function function', run.stdout + run.stderr);
    const sdkPkg = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'oap-sdk', 'package.json'), 'utf8'));
    check('module: oap-sdk\'s package.json names the donor\'s oap-sdk version', sdkPkg.name === 'oap-sdk' && sdkPkg.version === '24.10.2' &&
        sdkPkg.main === 'index.js');
    const text = fs.readFileSync(path.join(dir, 'node_modules', 'oap-sdk', 'index.js'), 'utf8');
    check('module: only the API\'s closure, with credit to extract_sdk.js', text.indexOf('cauliflowermossgrape/idrive7-apps (MIT)') > 0 &&
        ids(text).join(' ') === '2 3 4 5', ids(text).join(' '));
    check('module: package.json marked local-only, the package flat with every file',
        JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).mguLocalOnly === true &&
        Object.keys(members(out)).sort().join(' ') ===
        'javascript/app.js javascript/kit/mgu.js node_modules/oap-sdk/index.js node_modules/oap-sdk/package.json package.json permissions.json');

    const vendored = thirdParty({ vendored: true });
    check('module: a vendored oap-sdk is not needed', !link.needsSdk(vendored));
    const vr = link.preparePackage(vendored, path.join(tmp('out'), 'v.tgz'), { donors: [] });
    check('module: ...and stays as it is', vr.sdk === null &&
        members(vr.file)['node_modules/oap-sdk/index.js'].toString() === '// their own\n');
    const bundled = tmp('bundled');
    write(path.join(bundled, 'package.json'), JSON.stringify({ name: 'b', version: '1.0.0' }));
    write(path.join(bundled, 'javascript', 'app.js'), '/* x */\n' + donor.bundle().replace('require("oap-sdk/src/core/OnlineApp.js")', 'require("oap-sdk")'));
    check('module: a browserify bundle resolves its own requires', !link.needsSdk(bundled));
    check('shrinkwrap: a package with neither node_modules/ nor npm-shrinkwrap.json needs one', link.needsShrinkwrap(bundled) &&
        !link.needsShrinkwrap(vendored));
    const br = link.preparePackage(bundled, path.join(tmp('out'), 'b.tgz'), { donors: [] });
    const sw = JSON.parse(members(br.file)['npm-shrinkwrap.json'].toString());
    check('shrinkwrap: one without dependencies is added, which MainApp installs from', br.shrinkwrap === true && br.sdk === null &&
        sw.name === 'b' && sw.version === '1.0.0' && sw.lockfileVersion === 1 && JSON.stringify(sw.dependencies) === '{}', JSON.stringify(sw));
    check('shrinkwrap: none for a package with node_modules/', vr.shrinkwrap === false && !members(vr.file)['npm-shrinkwrap.json']);
    const entry = { uid: '${APPNAME}', domain: 'd', interfaceName: 'i/I', operation: '*' };
    const perm = tmp('perm');
    write(path.join(perm, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
    write(path.join(perm, 'javascript', 'app.js'), '/* x */\n');
    write(path.join(perm, 'permissions.json'), JSON.stringify({ masterAccessTable: [entry] }));
    const pr = link.preparePackage(perm, path.join(tmp('out'), 'p.tgz'), { donors: [] });
    const acl = JSON.parse(members(pr.file)['permissions.json'].toString());
    check('permissions: a missing ACL table is added empty, the entries kept', pr.permissions.join(' ') === 'masterRegistrationTable' &&
        JSON.stringify(acl.masterAccessTable) === JSON.stringify([entry]) && JSON.stringify(acl.masterRegistrationTable) === '[]', JSON.stringify(acl));
    check('permissions: both added to a package without permissions.json, none when both are there', br.permissions.length === 2 && vr.permissions.length === 2 &&
        link.preparePackage(perm, path.join(tmp('out'), 'p2.tgz'), { donors: [] }).permissions.length === 0);
    const e = throws(() => link.preparePackage(thirdParty(), path.join(tmp('out'), 'n.tgz'), { donors: [] }));
    check('module: no donor fails before anything is packed', e && e.noDonor && /no donor holds the oap-sdk core/.test(e.message), e && e.message);
    const sd = link.sdkModule([path.join(T, 'none.tgz'), donorTgz]);
    check('module: sdkModule is that donor, its text and oap-sdk version, and the module generated from it',
        sd.donor === 'donor_app@1.0.0.tgz:javascript/app.js' && sd.text === donor.bundle() && sd.sdkVersion === '24.10.2' &&
        /^\/\* require\('oap-sdk'\)/.test(sd.index) && JSON.parse(sd.pkg).version === '24.10.2' && sd.api.indexOf('OnlineApp') >= 0);

    // MainApp 6.5.5 preinstalled donor (e.g. x_call@3.7.2.tgz): bundle.js at package root, UglifyJS-minified prelude
    const minBundle = donor.bundle()
        .replace(/^\(function\(\)\{function r\(e,n,t\)\{/, '!function(){return function r(e,n,t){')
        .replace(/return o\}return r\}\)\(\)/, 'return o}}()');
    const donor655 = path.join(tmp('donor655'), 'x_call@3.7.2.tgz');
    fs.writeFileSync(donor655, tgz([
        { name: 'bundle.js', data: Buffer.from(minBundle), mode: 0o644 },
        { name: 'package.json', data: Buffer.from(JSON.stringify({ name: 'x_call', version: '3.7.2', main: 'x_call.js' })), mode: 0o644 },
        { name: 'x_call.js', data: Buffer.from('#!/usr/bin/node --serialize_eager\nrequire("./bundle.js");\n'), mode: 0o644 }
    ], 1700000000));
    const b655 = path.join(tmp('out655'), 'demo.tgz');
    const r655 = link.build(sourceApp(), b655, { donors: [donor655], epoch: 1700000000 });
    const run655 = cp.spawnSync(process.execPath, [path.join(extract(b655), 'javascript', 'app.js')], { encoding: 'utf8' });
    check('MainApp 6.5.5 donor (root bundle.js, !function...return o}}() prelude): bundle mode links and runs',
        r655.donor === 'x_call@3.7.2.tgz:bundle.js' && run655.status === 0 && run655.stdout === 'demo function function',
        run655.stdout + run655.stderr);
    const tp655 = thirdParty();
    const m655 = path.join(tmp('out655'), 'warmup.tgz');
    const pr655 = link.preparePackage(tp655, m655, { donors: [donor655] });
    const runTp655 = cp.spawnSync(process.execPath, [path.join(extract(m655), 'javascript', 'app.js')], { encoding: 'utf8' });
    check('MainApp 6.5.5 donor: module mode generates a working oap-sdk and recognizes the minified bundle',
        pr655.sdk && pr655.sdk.donor === 'x_call@3.7.2.tgz:bundle.js' && runTp655.status === 0 &&
        runTp655.stdout === 'w function function function', runTp655.stdout + runTp655.stderr);
}

function testUntar() {
    const file = path.join(tmp('tar'), 'p.tgz');
    const long = `package/${'d'.repeat(90)}/${'f'.repeat(40)}.js`;
    fs.writeFileSync(file, tgz([{ name: 'package/package.json', data: Buffer.from('{}'), mode: 0o644 },
        { name: long, data: Buffer.from('x'), mode: 0o644 }], 1700000000));
    const m = members(file);
    check('untar: ustar prefix names and package/ members', Object.keys(m).join(' ') === `package/package.json ${long}` && m[long].toString() === 'x');
}

/* ---- stock donor eligibility and the split boundary -------------------------- */

function testUnitDonors() {
    const root = tmp('unit');
    const main = path.join(root, 'main');
    const oap = path.join(root, 'oap');
    const installed = (uid, pkg) => {
        const js = path.join(oap, `oap_${uid}`, 'source', 'javascript', 'app.js');
        write(js, donor.bundle());
        if (pkg) write(path.join(path.dirname(path.dirname(js)), 'package.json'), JSON.stringify(pkg));
        return js;
    };
    const stock = installed(13000, { name: 'stock', version: '1.0.0' });
    installed(13001, { name: 'ours', mguLocalOnly: true });
    installed(13002, { name: 'marked_false', mguLocalOnly: false });
    installed(13003, { name: 'local_list' });
    installed(13004, { name: 'custom_list' });
    installed(13005, null);
    write(path.join(oap, 'oap_12201', 'data', 'local-only-apps.json'), '["local_list"]');
    write(path.join(oap, 'oap_12201', 'data', 'custom_apps.json'), '{"custom_list":{}}');
    const pre = path.join(main, 'preinstalled_apps', 'stock.tgz');
    write(pre, '');
    donor.tgz(pre);
    ['ours', 'marked_false', 'local_list', 'custom_list'].forEach((name) => {
        const pkg = { name };
        if (name === 'ours' || name === 'marked_false') pkg.mguLocalOnly = name === 'ours';
        write(path.join(path.dirname(pre), `${name}.tgz`), tgz([
            { name: 'package.json', data: Buffer.from(JSON.stringify(pkg)), mode: 0o644 },
            { name: 'javascript/app.js', data: Buffer.from(donor.bundle()), mode: 0o644 }
        ], 1700000000));
    });
    const found = link.unitDonors(main, oap);
    check('donors: only stock packages, preinstalled first; markers and both manager lists exclude every layout',
        found.join(' ') === [pre, stock].join(' '), found.join(' '));
    write(path.join(oap, 'oap_12201', 'data', 'local-only-apps.json'), 'broken');
    check('donors: unreadable exclusion lists fail closed', !!throws(() => link.unitDonors(main, oap)));
}

function testHostileDonor() {
    const dir = tmp('hostile');
    const target = path.join(dir, 'escaped');
    const src = sourceApp();
    ['this.constructor.constructor', 'capture.constructor'].forEach((escape) => {
        const js = path.join(dir, 'hostile.js');
        const attack = `${escape}('return process')().mainModule.require('fs').writeFileSync(${JSON.stringify(target)}, 'escaped')`;
        // The expression is in the captured arguments, outside every module.
        write(js, donor.bundle().replace('({1:', `((${attack}),{1:`));
        const e = throws(() => link.build(src, path.join(tmp('out'), 'hostile.tgz'), { donors: [js] }));
        check(`split: hostile ${escape} cannot write through the deploy process`, e && e.noDonor && !fs.existsSync(target), e && e.message);
    });
    const workerOpts = { input: donor.bundle(), encoding: 'utf8' };
    if (process.getuid && process.getuid() === 0) {
        workerOpts.uid = 65534;
        workerOpts.gid = 65534;
        const js = path.join(dir, 'valid.js');
        write(js, donor.bundle());
        ['MGU_DEPLOY_SPLIT_UID', 'MGU_DEPLOY_SPLIT_GID'].forEach((key) => {
            const before = process.env[key];
            process.env[key] = '0';
            let e;
            try { e = throws(() => link.sdkModule([js])); }
            finally {
                if (before === undefined) delete process.env[key];
                else process.env[key] = before;
            }
            check(`split: ${key}=0 is refused without evaluating the donor`, e && /unprivileged numeric id/.test(e.message), e && e.message);
        });
        const spawn = cp.spawnSync;
        let options;
        cp.spawnSync = (exe, args, opts) => { options = opts; return spawn(exe, args, opts); };
        try { link.sdkModule([js]); } finally { cp.spawnSync = spawn; }
        check('split: root runs the worker with nobody uid/gid, a timeout and an output cap', options &&
            options.uid === 65534 && options.gid === 65534 && options.timeout === 30000 &&
            options.maxBuffer === (64 << 20) && options.killSignal === 'SIGKILL' && options.cwd === '/' &&
            Object.keys(options.env).length === 0);
        write(js, donor.bundle() + 'while (true) {}');
        let e = throws(() => link.sdkModule([js]));
        check('split: a hostile infinite loop is killed at the worker deadline', e && /ETIMEDOUT|Script execution timed out/.test(e.message), e && e.message);
        write(js, donor.bundle() + "mods[1][1].huge = 'x'.repeat(64 << 20);");
        e = throws(() => link.sdkModule([js]));
        check('split: oversized worker JSON is refused at the output cap', e && /ENOBUFS/.test(e.message), e && e.message);
    } else {
        console.log('# skipped: root split uid assertion (Docker runs it as root)');
    }
    const r = cp.spawnSync(process.execPath, [path.join(REPO, 'tools', 'oap_link.js'), 'split'], workerOpts);
    let split;
    try { split = JSON.parse(r.stdout); } catch (e) { /* check below */ }
    check('split: worker returns JSON containing only module source text and dependency ids', r.status === 0 && split &&
        split.tight === true && typeof split.prelude === 'string' && typeof split.mods['2'][0] === 'string' &&
        /^function\(require,module,exports\)/.test(split.mods['2'][0]) && split.mods['2'][1]['../logging/logging'] === 3,
    r.stderr);
}

/* ---- real donors (never part of the repository) -------------------------------- */

function testRealDonors() {
    const donors = (process.env.MGU_TEST_DONORS || '').split(':').filter(Boolean);
    if (!donors.length) {
        console.log('# skipped: real donors (set MGU_TEST_DONORS)');
        return;
    }
    const store = path.join(REPO, 'apps', 'robertn_store');
    const apps = donors.map((d) => {
        const out = path.join(tmp('store'), 'store.tgz');
        const r = link.build(store, out, { donors: [d], epoch: 1700000000 });
        return { d, r, app: members(out)['javascript/app.js'] };
    });
    check(`real: the Store links into one javascript/app.js from every donor (${apps.map((a) => a.r.donor).join(', ')})`,
        apps.every((a) => a.app.equals(apps[0].app)), apps.map((a) => `${a.r.donor} ${a.r.moduleCount}`).join('\n'));
    const apis = donors.map((d) => {
        const pkg = thirdParty();
        link.preparePackage(pkg, path.join(tmp('o'), 'w.tgz'), { donors: [d] });
        return /var ids = (\{.*\});/.exec(fs.readFileSync(path.join(pkg, 'node_modules', 'oap-sdk', 'index.js'), 'utf8'))[1];
    });
    const first = JSON.parse(apis[0]);
    check('real: the first donor gives require(\'oap-sdk\') all 17 names, every other one the same ids for those it holds',
        Object.keys(first).length === Object.keys(link.SDK_API).length &&
        apis.every((a) => { const o = JSON.parse(a); return Object.keys(o).every((k) => o[k] === first[k]); }), apis.join('\n'));
    const dir = process.env.MGU_TEST_THIRDPARTY;
    if (!dir) {
        console.log('# skipped: third-party packages (set MGU_TEST_THIRDPARTY)');
        return;
    }
    fs.readdirSync(dir).filter((f) => /\.(tgz|mgu)$/.test(f)).forEach((f) => {
        const x = extract(path.join(dir, f));
        const pkgDir = fs.existsSync(path.join(x, 'package', 'package.json')) ? path.join(x, 'package') : path.join(x, 'source');
        // a browserify bundle carries its oap-sdk itself
        const needs = link.needsSdk(pkgDir);
        const r = link.preparePackage(pkgDir, path.join(tmp('o'), 'p.tgz'), { donors: [donors[0]] });
        const m = members(r.file);
        check(`real: ${f} prepares: ${needs ? 'oap-sdk generated, ' : ''}flat, marked`,
            (needs ? r.sdk && r.sdk.api.length === Object.keys(link.SDK_API).length && m['node_modules/oap-sdk/index.js'] : r.sdk === null) &&
            JSON.parse(m['package.json']).mguLocalOnly === true && !Object.keys(m).some((k) => /^package\/|^source\//.test(k)),
            JSON.stringify(r.sdk));
    });
}

/* release.js publish: a component's requirements are published or published with it. */
function testReleaseRequires() {
    const { unmetRequires } = require(path.join(__dirname, '..', '..', 'release', 'release.js'));
    const published = new Map([['mgu-updater', { id: 'mgu-updater', version: '0.7.2' }]]);
    const store = (min) => ({ id: 'robertn_store', version: '0.9.2', requires: { 'mgu-updater': min } });
    check('release: a requirement published at that version or newer is met', unmetRequires([store('0.7.2')], published).length === 0);
    check('release: a requirement newer than what is published is unmet',
        /needs mgu-updater 0\.7\.3, but the catalog would have mgu-updater 0\.7\.2/.test(unmetRequires([store('0.7.3')], published).join()));
    check('release: a requirement published in the same run is met',
        unmetRequires([store('0.7.3'), { id: 'mgu-updater', version: '0.7.3', requires: {} }], published).length === 0);
    check('release: a requirement nothing publishes is unmet',
        /which the catalog would not have/.test(unmetRequires([{ id: 'a', version: '1.0.0', requires: { b: '1.0.0' } }], published).join()));
    const kept = new Map([['mgu-updater', { id: 'mgu-updater', version: '0.7.2', requires: { 'mgu-python': '1.0.0' } }]]);
    check('release: an unchanged component whose requirement leaves the catalog is unmet',
        /mgu-updater@0\.7\.2 needs mgu-python 1\.0\.0/.test(unmetRequires([], kept).join()));
    check('release: a component that requires itself is refused',
        /requires itself/.test(unmetRequires([{ id: 'a', version: '1.0.0', requires: { a: '1.0.0' } }], published).join()));
}

/* release.js: each component's texts in other languages from release/texts. */
function testReleaseTexts() {
    const { components, catalogTexts } = require(path.join(__dirname, '..', '..', 'release', 'release.js'));
    const store = components().find((c) => c.id === 'robertn_store');
    check('release: a component lists its texts of every language', store.texts && store.texts.de && store.texts['zh-TW'] &&
        typeof store.texts.de.description === 'string');
    const root = fs.mkdtempSync(path.join(T, 'texts-'));
    fs.mkdirSync(path.join(root, 'release'));
    fs.mkdirSync(path.join(root, 'release', 'texts'));
    const write = (o) => fs.writeFileSync(path.join(root, 'release', 'texts', 'de.json'), JSON.stringify(o));
    write({ a: { title: 'A-de' } });
    check('release: texts by id and language', JSON.stringify(catalogTexts(['a'], root)) === JSON.stringify({ a: { de: { title: 'A-de' } } }));
    [{ b: { title: 'B' } }, { a: { title: 'A', extra: 1 } }, { a: { title: 7 } }, { a: 'A' }].forEach((o) => {
        write(o);
        let thrown = null;
        try {
            catalogTexts(['a'], root);
        } catch (e) {
            thrown = e.message;
        }
        check(`release: texts refused: ${JSON.stringify(o)}`, /release\/texts\/de\.json/.test(thrown || ''));
    });
}

/* release.js: each app's catalog entry names its icon, the PNG its entry point shows. */
function testReleaseIcons() {
    const { components, catalogEntry } = require(path.join(__dirname, '..', '..', 'release', 'release.js'));
    const crypto = require('crypto');
    const all = components();
    const store = all.find((c) => c.id === 'robertn_store');
    const bytes = fs.readFileSync(path.join(REPO, 'apps', 'robertn_store', 'package', 'rhmiData', 'variantGroups', 'Common', 'images', 'store_icon.png'));
    check('release: an app has the icon its entry point names', store.icon && store.icon.file.endsWith('store_icon.png') &&
        store.icon.sha256 === crypto.createHash('sha256').update(bytes).digest('hex'), JSON.stringify(store.icon));
    const tool = all.find((c) => c.kind === 'tool');
    check('release: a tool has none', all.filter((c) => c.kind === 'tool').every((c) => !c.icon));
    const file = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'mgu-icon-')), 'a.tgz');
    fs.writeFileSync(file, 'x');
    const e = catalogEntry(store, file);
    const t = catalogEntry(tool, file);
    check('release: an app\'s catalog entry lists its icon as the asset <id>.png with its sha256, a tool\'s none',
        e.icon === 'robertn_store.png' && e.iconSha256 === store.icon.sha256 && t.icon === undefined && t.iconSha256 === undefined,
        JSON.stringify([e.icon, e.iconSha256, t.icon]));
}

/* release.js publish: a gated component needs a successful release-check/<id>
 * status on its source commit. */
function testReleaseGate() {
    const { gateProblem } = require(path.join(__dirname, '..', '..', 'release', 'release.js'));
    const c = { id: 'mgu-render', kind: 'tool', version: '0.6.8' };
    const src = 'a'.repeat(40);
    const status = (o) => Object.assign({ context: 'release-check/mgu-render', state: 'success', description: 'c'.repeat(64) }, o);
    check('release gate: a successful status lets it publish', gateProblem(c, status({}), src) === null);
    check('release gate: no status refuses it', /release-check\/mgu-render on aaaaaaaaaaaa is missing/.test(gateProblem(c, null, src)));
    check('release gate: a failed status refuses it', /is failure/.test(gateProblem(c, status({ state: 'failure' }), src)));
    check('release gate: a pending status refuses it', /is pending/.test(gateProblem(c, status({ state: 'pending' }), src)));
    check('release gate: the status names the source; the release picks the version',
        gateProblem(Object.assign({}, c, { version: '0.6.9' }), status({}), src) === null);
    check('release gate: an app is gated too',
        /missing/.test(gateProblem({ id: 'robertn_store', kind: 'app', version: '0.9.15' }, null, src)));
    check('release gate: a component outside the gate needs no status',
        gateProblem({ id: 'mgu-updater', version: '0.8.7' }, null, src) === null);
}

/* A git repository with tools a (1.0.0, with a CHANGELOG) and b (2.0.0,
 * requiring a 1.0.0), mgu-updater (0.8.0) and the app robertn_x (0.4.0, a
 * source package in package/ with a CHANGELOG there), each released
 * (tagged). */
function versionRepo() {
    const root = tmp('versions');
    const g = (args) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false']
        .concat(args), { cwd: root, encoding: 'utf8' }).trim();
    const tool = (id, version, extra) => write(path.join(root, 'native', id, 'component.json'),
        JSON.stringify(Object.assign({ id, kind: 'tool', version, title: id, files: [] }, extra), null, 2) + '\n');
    fs.mkdirSync(path.join(root, 'apps'));
    tool('a', '1.0.0', { versionFiles: ['a.js'] });
    write(path.join(root, 'native', 'a', 'a.js'), "const VERSION = '1.0.0';\n");
    write(path.join(root, 'native', 'a', 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n\nFirst.\n');
    tool('b', '2.0.0', { requires: { a: '1.0.0' } });
    tool('mgu-updater', '0.8.0');
    const app = path.join(root, 'apps', 'robertn_x');
    write(path.join(app, 'release.json'), JSON.stringify({ build: 'true', requires: { 'mgu-updater': '0.8.0' } }, null, 2) + '\n');
    write(path.join(app, 'mgu-app.json'), JSON.stringify({ schema: 1, id: 'robertn_x', version: '0.4.0', tree: 'package', modules: ['src/x.js'] }, null, 2) + '\n');
    write(path.join(app, 'src', 'x.js'), 'module.exports = 1;\n');
    write(path.join(app, 'package', 'package.json'), JSON.stringify({ name: 'robertn_x', version: '0.4.0', mguLocalOnly: true }, null, 2) + '\n');
    write(path.join(app, 'package', 'npm-shrinkwrap.json'), JSON.stringify({ name: 'robertn_x', version: '0.4.0', lockfileVersion: 1 }, null, 2) + '\n');
    write(path.join(app, 'package', 'rhmiData', 'application.json'), JSON.stringify({ application: { name: 'robertn_x', version: '0.4.0',
        entryPoints: [] } }, null, 2) + '\n');
    write(path.join(app, 'package', 'CHANGELOG.md'), '# Changelog\n\n## 0.4.0\n\nFirst.\n');
    g(['init', '-q']);
    g(['add', '.']);
    g(['commit', '-q', '-m', 'one']);
    ['a@1.0.0', 'b@2.0.0', 'mgu-updater@0.8.0', 'robertn_x@0.4.0'].forEach((t) => g(['tag', t]));
    const json = (id) => JSON.parse(fs.readFileSync(path.join(root, 'native', id, 'component.json'), 'utf8'));
    const log = () => fs.readFileSync(path.join(root, 'native', 'a', 'CHANGELOG.md'), 'utf8');
    const change = (rel, text, entry, subject) => {
        fs.writeFileSync(path.join(root, rel), text);
        if (entry) {
            const t = log();
            fs.writeFileSync(path.join(root, 'native', 'a', 'CHANGELOG.md'), t.indexOf('## Unreleased\n') >= 0 ?
                t.replace('## Unreleased\n\n', `## Unreleased\n\n${entry}\n`) : t.replace('# Changelog\n\n', `# Changelog\n\n## Unreleased\n\n${entry}\n\n`));
        }
        g(['add', '.']);
        g(['commit', '-q', '-m', subject || rel]);
        return g(['rev-parse', 'HEAD']);
    };
    const requires = (id, r) => change(`native/${id}/component.json`, JSON.stringify(Object.assign(json(id), { requires: r }), null, 2) + '\n');
    const stamp = (ids) => {
        const steps = rel.plan(rel.components(root), ids || [], root);
        rel.writePlan(root, steps);
        if (g(['status', '--porcelain'])) {
            g(['commit', '-q', '-am', `release: ${steps.map((p) => `${p.c.id}@${p.version}`).join(', ')}`]);
        }
        steps.forEach((p) => g(['tag', '-f', `${p.c.id}@${p.version}`]));
        return steps.map((p) => `${p.c.id}@${p.version}`);
    };
    const rel = require(path.join(REPO, 'release', 'release.js'));
    return { root, g, change, requires, stamp, json, log, rel };
}

/* release.js stamp: release-time versions, the CHANGELOG's Unreleased section, "requires" of "next". */
function testReleaseVersions() {
    const { bumpVersion, releaseChangelog, plan, writePlan, components, prLabels, sourceCommit } = require(path.join(REPO, 'release', 'release.js'));
    process.env.MGU_RELEASE_LABELS = 'off';
    check('versions: patch, minor and major steps', bumpVersion('0.6.2', 'patch') === '0.6.3' &&
        bumpVersion('0.6.2', 'minor') === '0.7.0' && bumpVersion('0.6.2', 'major') === '1.0.0');

    let r = versionRepo();
    check('versions: nothing changed since the tags, nothing to release', plan(components(r.root), [], r.root).length === 0);
    r.change('native/a/run.js', '1\n', 'Fix one.');
    let got = r.stamp();
    check('versions: a changed tool gets a patch; the others keep theirs', got.join() === 'a@1.0.1', got.join());
    check('versions: the version is written into component.json and the version files',
        r.json('a').version === '1.0.1' && fs.readFileSync(path.join(r.root, 'native/a/a.js'), 'utf8') === "const VERSION = '1.0.1';\n");
    check('versions: the Unreleased lines move under the version, an empty Unreleased above',
        r.log().startsWith('# Changelog\n\n## Unreleased\n\n## 1.0.1\n\nFix one.\n\n## 1.0.0\n'), r.log());
    prLabels.set(r.change('native/a/run.js', '2\n', 'New thing.'), ['enhancement', 'release:minor']);
    got = r.stamp();
    check('versions: release:minor gives a minor', got.join() === 'a@1.1.0', got.join());
    prLabels.set(r.change('native/a/run.js', '3\n', 'Breaks.'), ['release:minor', 'release:major']);
    got = r.stamp();
    check('versions: the highest label wins', got.join() === 'a@2.0.0', got.join());
    got = r.stamp(['b']);
    check('versions: a tool named without a change gets a patch of the same content', got.join() === 'b@2.0.1', got.join());

    r = versionRepo();
    r.change('native/a/run.js', '1\n', 'First fix.');
    r.change('native/a/run.js', '2\n', 'Second fix.');
    got = r.stamp();
    check('versions: two changes give one version with both entries',
        got.join() === 'a@1.0.1' && r.log().indexOf('## 1.0.1\n\nSecond fix.\nFirst fix.\n\n## 1.0.0') >= 0, r.log());
    check('versions: released, nothing left', r.stamp().length === 0);

    r = versionRepo();
    r.change('native/a/run.js', '1\n', 'Fix.');
    r.requires('b', { a: 'next' });
    got = r.stamp();
    check('versions: "next" is the version released with it', got.join() === 'a@1.0.1,b@2.0.1' &&
        JSON.stringify(r.json('b').requires) === '{"a":"1.0.1"}', got.join() + JSON.stringify(r.json('b').requires));
    r.change('native/a/run.js', '2\n', 'Fix again.');
    r.requires('b', { a: 'next' });
    got = r.stamp(['b']);
    check('versions: a tool chosen alone brings what it requires "next" along', got.join() === 'a@1.0.2,b@2.0.2' &&
        r.json('b').requires.a === '1.0.2', got.join());

    // the app: its version in mgu-app.json and the package's files, its CHANGELOG in package/
    r = versionRepo();
    const appFile = (rel) => fs.readFileSync(path.join(r.root, 'apps/robertn_x', rel), 'utf8');
    const appLog = () => appFile('package/CHANGELOG.md');
    const appEntry = (entry) => fs.writeFileSync(path.join(r.root, 'apps/robertn_x/package/CHANGELOG.md'),
        appLog().replace('# Changelog\n\n', `# Changelog\n\n## Unreleased\n\n${entry}\n\n`));
    appEntry('Faster.');
    const appSource = r.change('apps/robertn_x/src/x.js', 'module.exports = 2;\n');
    r.change('apps/robertn_x/release.json', JSON.stringify({ build: 'true', requires: { 'mgu-updater': 'next' } }, null, 2) + '\n');
    got = r.stamp(['robertn_x']);
    const x = () => components(r.root).find((c) => c.id === 'robertn_x');
    check('versions: an app gets its version in mgu-app.json and the package\'s package.json, npm-shrinkwrap.json and application.json',
        got.join() === 'robertn_x@0.4.1' && x().version === '0.4.1' && JSON.parse(appFile('mgu-app.json')).version === '0.4.1' &&
        JSON.parse(appFile('package/npm-shrinkwrap.json')).version === '0.4.1' &&
        JSON.parse(appFile('package/rhmiData/application.json')).application.version === '0.4.1' && JSON.parse(appFile('mgu-app.json')).tree === 'package',
        got.join());
    check('versions: an app\'s "next" of an unchanged tool is its version; its CHANGELOG\'s Unreleased lines move under the version',
        JSON.parse(appFile('release.json')).requires['mgu-updater'] === '0.8.0' &&
        appLog().startsWith('# Changelog\n\n## Unreleased\n\n## 0.4.1\n\nFaster.\n\n## 0.4.0\n'), appLog());
    check('versions: an app\'s release commit (versions, "next", the CHANGELOG\'s move) is not its source', sourceCommit(x(), r.root) === appSource);
    got = r.stamp(['robertn_x', 'a']);
    check('versions: a component named with no change gets a patch, "No changes." in its CHANGELOG',
        got.join() === 'robertn_x@0.4.2,a@1.0.1' && appLog().startsWith('# Changelog\n\n## Unreleased\n\n## 0.4.2\n\nNo changes.\n\n## 0.4.1\n') &&
        r.log().startsWith('# Changelog\n\n## Unreleased\n\n## 1.0.1\n\nNo changes.\n\n## 1.0.0\n'), appLog() + r.log());
    check('versions: a release of the same content is not the source either', sourceCommit(x(), r.root) === appSource);
    // a build that rewrites a file the app ships (a copy or a generated file not committed) is refused
    const built = (cmd) => {
        const exp = tmp('export');
        cp.execFileSync('sh', ['-c', 'git archive HEAD | tar -x -C "$1"', 'sh', exp], { cwd: r.root });
        const c = Object.assign(x(), { release: { build: cmd } });
        return throws(() => r.rel.buildIn(c, exp, process.env)) || fs.existsSync(path.join(exp, 'apps/robertn_x/robertn_x@0.4.2'));
    };
    check('versions: an app\'s release build may write what it does not ship, under its staged tree named with its version',
        built('touch robertn_x@0.4.2.src.tgz && test -f robertn_x@0.4.2/package.json && grep -q \'"tree": "robertn_x@0.4.2"\' mgu-app.json') === true);
    check('versions: an app\'s release build that adds a file where it ships is refused',
        /the build wrote apps\/robertn_x\/robertn_x@0\.4\.2\/new\.json/.test(String(built('echo 1 > robertn_x@0.4.2/new.json && touch robertn_x@0.4.2.src.tgz'))));
    check('versions: an app\'s release build that rewrites a file it ships is refused',
        /the build wrote apps\/robertn_x\/src\/x\.js/.test(String(built('echo 3 > src/x.js && touch robertn_x@0.4.2.src.tgz'))));
    fs.renameSync(path.join(r.root, 'apps/robertn_x/package'), path.join(r.root, 'apps/robertn_x/robertn_x@0.4.2'));
    fs.writeFileSync(path.join(r.root, 'apps/robertn_x/mgu-app.json'), appFile('mgu-app.json').replace('"package"', '"robertn_x@0.4.2"'));
    check('versions: an app\'s tree with its version in its name is still read', x().version === '0.4.2' && x().tree === 'robertn_x@0.4.2');

    r = versionRepo();
    r.change('native/a/run.js', '1\n', 'Fix.');
    writePlan(r.root, plan(components(r.root), [], r.root));   // stamped, never tagged: the publish did not happen
    r.g(['commit', '-q', '-am', 'release: a@1.0.1']);
    r.change('native/a/run.js', '2\n', 'Another fix.');
    got = r.stamp();
    check('versions: a version stamped and not released keeps its number; later entries join its section',
        got.join() === 'a@1.0.1' && r.log().startsWith('# Changelog\n\n## Unreleased\n\n## 1.0.1\n\nAnother fix.\n\nFix.\n\n## 1.0.0\n'), r.log());
    check('versions: two Unreleased headings (a union merge) are one section',
        releaseChangelog('# C\n\n## Unreleased\n\nOne.\n\n## Unreleased\n\nTwo.\n\n## 1.0.0\n\nx\n', '1.0.1') ===
        '# C\n\n## Unreleased\n\n## 1.0.1\n\nOne.\n\nTwo.\n\n## 1.0.0\n\nx\n');

    r = versionRepo();
    r.change('native/a/run.js', '1\n');
    check('versions: a change without its Unreleased entry stops the release',
        /Unreleased/.test(String(throws(() => writePlan(r.root, plan(components(r.root), [], r.root))))));
    r.requires('b', { 'mgu-deploy': 'next' });
    check('versions: "next" names a component of this repository only',
        /names a component of this repository only/.test(String(throws(() => components(r.root)))));

    // the gate's source: what the component does, without the release commit that only set its version
    r = versionRepo();
    const content = r.change('native/a/run.js', '1\n', 'Fix.');
    r.stamp();
    const a = () => components(r.root).find((c) => c.id === 'a');
    check('versions: a release commit that only stamped the version is not the source', sourceCommit(a(), r.root) === content);
    r.change('native/a/run.js', '2\n', 'Fix.');
    const mixed = r.change('native/a/component.json', JSON.stringify(Object.assign(r.json('a'), { version: '1.0.2', title: 'A' }), null, 2) + '\n',
        null, 'release: a@1.0.2');
    check('versions: a commit named as a release that changes more than the version is the source', sourceCommit(a(), r.root) === mixed);
    // "requires" on one line, as the repository writes it
    const oneLine = (id, version, req) => `{\n  "id": "${id}",\n  "kind": "tool",\n  "version": "${version}",\n  "title": "${id}",\n` +
        `  "requires": { "a": "${req}", "c": "1.0.0" },\n  "files": []\n}\n`;
    r.change('native/b/component.json', oneLine('b', '2.0.0', 'next'));
    r.stamp(['b']);
    const b = components(r.root).find((c) => c.id === 'b');
    check('versions: "next" resolved in a one-line "requires" is no source change',
        b.version === '2.0.1' && b.requires.a === '1.0.2' && sourceCommit(b, r.root) !== r.g(['rev-parse', 'HEAD']), JSON.stringify(b.requires));
    const raised = r.change('native/b/component.json', oneLine('b', '2.0.1', '1.0.2').replace('"c": "1.0.0"', '"c": "1.1.0"'),
        null, 'release: b@2.0.1');
    check('versions: a release commit raising another requirement is the source', sourceCommit(b, r.root) === raised);
}

try {
    testReleaseRequires();
    testReleaseTexts();
    testReleaseIcons();
    testReleaseGate();
    testReleaseVersions();
    testUntar();
    testUnitDonors();
    testHostileDonor();
    testBundleMode();
    testEntryPoint();
    testPackSource();
    testModuleMode();
    testRealDonors();
    check('the suite ran to the end', true);
} catch (e) {
    check('the suite ran to the end', false, e.stack);
}
console.log(failed ? `FAILED: ${n - failed} of ${n} ok` : `all ${n} ok`);
process.exitCode = failed ? 1 : 0;
