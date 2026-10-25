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
    check('module: no longer needed once generated', !link.needsSdk(pkg));

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
    check('permissions: none added when both are there', br.permissions.length === 2 && vr.permissions.length === 2 &&
        link.preparePackage(perm, path.join(tmp('out'), 'p2.tgz'), { donors: [] }).permissions.length === 0);
    const e = throws(() => link.preparePackage(thirdParty(), path.join(tmp('out'), 'n.tgz'), { donors: [] }));
    check('module: no donor fails before anything is packed', e && e.noDonor && /no donor holds the oap-sdk core/.test(e.message), e && e.message);
    const sd = link.sdkDonor([path.join(T, 'none.tgz'), donorTgz]);
    check('module: sdkDonor is that donor, its text and oap-sdk version', sd.label === 'donor_app@1.0.0.tgz:javascript/app.js' &&
        sd.text === donor.bundle() && sd.sdkVersion === '24.10.2');
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
            try { e = throws(() => link.sdkDonor([js])); }
            finally {
                if (before === undefined) delete process.env[key];
                else process.env[key] = before;
            }
            check(`split: ${key}=0 is refused without evaluating the donor`, e && /unprivileged numeric id/.test(e.message), e && e.message);
        });
        const spawn = cp.spawnSync;
        let options;
        cp.spawnSync = (exe, args, opts) => { options = opts; return spawn(exe, args, opts); };
        try { link.sdkDonor([js]); } finally { cp.spawnSync = spawn; }
        check('split: root runs the worker with nobody uid/gid, a timeout and an output cap', options &&
            options.uid === 65534 && options.gid === 65534 && options.timeout === 30000 &&
            options.maxBuffer === (64 << 20) && options.killSignal === 'SIGKILL' && options.cwd === '/' &&
            Object.keys(options.env).length === 0);
        write(js, donor.bundle() + 'while (true) {}');
        let e = throws(() => link.sdkDonor([js]));
        check('split: a hostile infinite loop is killed at the worker deadline', e && /ETIMEDOUT|Script execution timed out/.test(e.message), e && e.message);
        write(js, donor.bundle() + "mods[1][1].huge = 'x'.repeat(64 << 20);");
        e = throws(() => link.sdkDonor([js]));
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

try {
    testUntar();
    testUnitDonors();
    testHostileDonor();
    testBundleMode();
    testPackSource();
    testModuleMode();
    testRealDonors();
    check('the suite ran to the end', true);
} catch (e) {
    check('the suite ran to the end', false, e.stack);
}
console.log(failed ? `FAILED: ${n - failed} of ${n} ok` : `all ${n} ok`);
process.exitCode = failed ? 1 : 0;
