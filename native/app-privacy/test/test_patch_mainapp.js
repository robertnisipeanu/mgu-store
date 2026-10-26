'use strict';
/*
 * Tests for patch_mainapp.js. Run on the head unit's Node with
 * `sh test/run.sh`, or on any Node with `node test/test_patch_mainapp.js`.
 *
 * The firmware case runs when a decoded oap-mainapp is available
 * (FIRMWARE_MAINAPP_DIR, or the maintainer's local decode).
 */
const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const TOOL = path.join(__dirname, '..', 'patch_mainapp.js');
const patcher = require(TOOL);

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'app-privacy-'));
}

function rmrf(dir) {
    fs.readdirSync(dir).forEach((name) => {
        const p = path.join(dir, name);
        if (fs.lstatSync(p).isDirectory()) {
            rmrf(p);
        } else {
            fs.unlinkSync(p);
        }
    });
    fs.rmdirSync(dir);
}

function syntheticBundle(patches) {
    const parts = [];
    patches.forEach((p, index) => {
        for (let copy = 0; copy < p[2]; copy += 1) {
            parts.push('filler' + index + '(' + copy + ');\n' + p[0]);
        }
    });
    return parts.join('\n');
}

function runTool(args) {
    const r = childProcess.spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function lastJson(stdout) {
    const lines = stdout.split('\n').filter((l) => l.trim());
    return JSON.parse(lines[lines.length - 1]);
}

function withBundles(fn) {
    const dir = tmpdir();
    const paths = {};
    Object.keys(patcher.PATCH_SETS).forEach((kind) => {
        paths[kind] = path.join(dir, kind + '.js');
        fs.writeFileSync(paths[kind], syntheticBundle(patcher.PATCH_SETS[kind]));
    });
    const args = (command) => [command, '--main', paths.main, '--appmanagement', paths.appmanagement];
    const read = (kind) => fs.readFileSync(paths[kind], 'utf8');
    try {
        fn({ dir, paths, args, read });
    } finally {
        rmrf(dir);
    }
}

test('--version names the component version', () => {
    const r = runTool(['--version']);
    assert.strictEqual(r.code, 0);
    const component = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'component.json'), 'utf8'));
    assert.strictEqual(r.stdout.trim(), 'app-privacy ' + component.version);
    assert.strictEqual(patcher.VERSION, component.version);
});

test('component.json: versionFiles names the one VERSION line; restart is empty', () => {
    const component = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'component.json'), 'utf8'));
    assert.deepStrictEqual(component.versionFiles, ['patch_mainapp.js']);
    const source = fs.readFileSync(path.join(__dirname, '..', 'patch_mainapp.js'), 'utf8');
    assert.strictEqual(source.split("VERSION = '" + component.version + "'").length, 2);
    assert.deepStrictEqual(component.restart, []);
});

test('check, apply, apply again, revert round trip', () => withBundles((b) => {
    const original = { main: b.read('main'), appmanagement: b.read('appmanagement') };
    let r = runTool(b.args('check').concat('--json'));
    assert.strictEqual(r.code, 1, r.stdout);
    assert.strictEqual(lastJson(r.stdout).state, 'unpatched');

    r = runTool(b.args('apply').concat('--json'));
    assert.strictEqual(r.code, 0, r.stdout);
    let result = lastJson(r.stdout);
    assert.strictEqual(result.state, 'patched');
    assert.strictEqual(result.changed, true);
    Object.keys(b.paths).forEach((kind) => {
        assert.strictEqual(patcher.classify(b.read(kind), patcher.PATCH_SETS[kind]), 'patched');
    });

    r = runTool(b.args('apply').concat('--json'));
    assert.strictEqual(r.code, 0, r.stdout);
    result = lastJson(r.stdout);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.state, 'patched');

    r = runTool(b.args('check'));
    assert.strictEqual(r.code, 0, r.stdout);

    r = runTool(b.args('revert').concat('--json'));
    assert.strictEqual(r.code, 0, r.stdout);
    assert.strictEqual(lastJson(r.stdout).changed, true);
    assert.strictEqual(b.read('main'), original.main);
    assert.strictEqual(b.read('appmanagement'), original.appmanagement);

    r = runTool(b.args('revert').concat('--json'));
    assert.strictEqual(r.code, 0, r.stdout);
    assert.strictEqual(lastJson(r.stdout).changed, false);
    assert.deepStrictEqual(fs.readdirSync(b.dir).sort(), ['appmanagement.js', 'main.js']);
}));

test('a missing anchor refuses without writing', () => withBundles((b) => {
    const broken = b.read('main').replace(
        'installedApps=this._appRegistry.getAll();', 'installedApps=[];');
    fs.writeFileSync(b.paths.main, broken);
    const r = runTool(b.args('apply').concat('--json'));
    assert.strictEqual(r.code, 2, r.stdout);
    assert.strictEqual(lastJson(r.stdout).state, 'mismatch');
    assert.strictEqual(b.read('main'), broken);
    assert.strictEqual(runTool(b.args('check')).code, 2);
}));

test('a problem in the second file writes neither file', () => withBundles((b) => {
    const mainBefore = b.read('main');
    const broken = b.read('appmanagement').replace('class NpmPackageManager{', 'class RenamedManager{');
    fs.writeFileSync(b.paths.appmanagement, broken);
    const r = runTool(b.args('apply'));
    assert.strictEqual(r.code, 2, r.stdout);
    assert.strictEqual(b.read('main'), mainBefore);
    assert.strictEqual(b.read('appmanagement'), broken);
}));

test('an unreadable file is a mismatch', () => withBundles((b) => {
    fs.unlinkSync(b.paths.appmanagement);
    const r = runTool(b.args('apply').concat('--json'));
    assert.strictEqual(r.code, 2, r.stdout);
    assert.strictEqual(lastJson(r.stdout).state, 'mismatch');
}));

test('a half-applied pair is completed by apply', () => withBundles((b) => {
    const patched = patcher.applyPatches(b.read('main'), patcher.PATCH_SETS.main);
    fs.writeFileSync(b.paths.main, patched);
    let r = runTool(b.args('check').concat('--json'));
    assert.strictEqual(r.code, 1);
    r = runTool(b.args('apply').concat('--json'));
    assert.strictEqual(r.code, 0, r.stdout);
    assert.strictEqual(b.read('main'), patched);
    assert.strictEqual(patcher.classify(b.read('appmanagement'), patcher.PATCH_SETS.appmanagement), 'patched');
}));

test('revert keeps edits made by other patches', () => withBundles((b) => {
    const foreign = (text) => text.replace('filler0(0);', 'filler0(0);otherPatch();') + '\n/*other*/';
    fs.writeFileSync(b.paths.main, foreign(b.read('main')));
    const before = b.read('main');
    assert.strictEqual(runTool(b.args('apply')).code, 0);
    // Another tool edits the patched file afterwards, away from our sites.
    fs.writeFileSync(b.paths.main, b.read('main') + '\n/*later*/');
    assert.strictEqual(runTool(b.args('revert')).code, 0);
    assert.strictEqual(b.read('main'), before + '\n/*later*/');
}));

test('revert refuses an altered patch site', () => withBundles((b) => {
    assert.strictEqual(runTool(b.args('apply')).code, 0);
    const altered = b.read('main').replace(
        '.filter(app=>!isLocalOnlyApp(app.getAppId()));', '.filter(Boolean);');
    fs.writeFileSync(b.paths.main, altered);
    const r = runTool(b.args('revert'));
    assert.strictEqual(r.code, 2, r.stdout);
    assert.strictEqual(b.read('main'), altered);
}));

test('apply keeps the file mode', () => withBundles((b) => {
    fs.chmodSync(b.paths.main, 0o755);
    assert.strictEqual(runTool(b.args('apply')).code, 0);
    assert.strictEqual(fs.statSync(b.paths.main).mode & 0o777, 0o755);
}));

test('boot exits 0 on a mismatch and leaves the files', () => withBundles((b) => {
    fs.writeFileSync(b.paths.main, 'not a bundle');
    const r = runTool(b.args('boot'));
    assert.strictEqual(r.code, 0, r.stdout);
    assert.ok(/app-privacy: mismatch/.test(r.stdout), r.stdout);
    assert.strictEqual(b.read('main'), 'not a bundle');
}));

// sha256 of JSON.stringify(PATCH_SETS) as shipped by 1.2.1, and of the
// 1.1.0 entry of EARLIER_PATCH_SETS.
const PATCH_SETS_SHA256 = 'd494bf13326a07a6275f762b25d0639efb6eb12258718289000bb05ecbca5d8c';
const PATCH_SETS_SHA256_1_1_0 = '65fdf5a71cb95d465b37811cb2f326495686d4edcbd33566c07bad6c3ddc484e';
// sha256 of the reference firmware bundles as each release patches them:
// the current edits (1.2.0 and later) and 1.1.0's (and 1.0.0's).
const PATCHED_SHA256 = {
    current: {
        main: '67419d74a77fa17ec4d13bef88c9deb3fb70c7bd8ba893ba62ad5129b12ff8ad',
        appmanagement: '4582ab2a6a674a9fb6e1d544dd10674f9785d0906d4478b1dae625734d609997'
    },
    '1.1.0': {
        main: 'd10c2fe2c0f67e73bb099e7363bc9155a825791f586df43e97db700a56077fda',
        appmanagement: '4475f13d50922965796cb43ce52b33c57378c890a01136fdce75f8ffb27e2c18'
    }
};

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function setsSha(sets) {
    return crypto.createHash('sha256')
        .update(JSON.stringify({ main: sets.main, appmanagement: sets.appmanagement })).digest('hex');
}

test('the patch set is recorded', () => {
    const sha = setsSha(patcher.PATCH_SETS);
    assert.strictEqual(sha, PATCH_SETS_SHA256,
        'PATCH_SETS differs from the released one: when the text an edit writes or HELPER_JS changes, add the ' +
        'released sets to EARLIER_PATCH_SETS under the last version that shipped them and bump the version; ' +
        'then record ' + sha + ' here (the reference firmware case checks the edits\' output)');
});

test('the earlier release\'s patch set is recorded', () => {
    const earlier = patcher.EARLIER_PATCH_SETS.filter((s) => s.version === '1.1.0')[0];
    assert.ok(earlier, 'EARLIER_PATCH_SETS has no 1.1.0 entry');
    assert.strictEqual(setsSha(earlier), PATCH_SETS_SHA256_1_1_0);
});

/* A later release whose helper and inventory filter differ from this
 * one's, with this one's sets as its earlier release; AppManagement.js
 * keeps the same edits. */
const NEXT_HELPER = patcher.HELPER_JS.replace('isLocalOnlyApp(appId){', 'isLocalOnlyApp(appId){/*next*/');
const NEXT_SETS = {
    current: {
        main: patcher.PATCH_SETS.main.map((p) => [p[0], p[0] === 'installedApps=this._appRegistry.getAll();' ?
            'installedApps=this._appRegistry.getAll().filter(app=>!isLocalOnlyApp(app.getAppId())&&!0);' :
            p[1].split(patcher.HELPER_JS).join(NEXT_HELPER), p[2]]),
        appmanagement: patcher.PATCH_SETS.appmanagement
    },
    earlier: [{ version: patcher.VERSION, main: patcher.PATCH_SETS.main,
        appmanagement: patcher.PATCH_SETS.appmanagement }]
};
const NO_PROC = '/nonexistent-proc';
const quiet = () => {};

test('apply replaces an earlier release\'s edits, revert removes them', () => withBundles((b) => {
    const stock = { main: b.read('main'), appmanagement: b.read('appmanagement') };
    assert.strictEqual(patcher.run('apply', b.paths, quiet, NO_PROC).code, 0);
    const earlier = { main: b.read('main'), appmanagement: b.read('appmanagement') };

    let r = patcher.run('check', b.paths, quiet, NO_PROC, NEXT_SETS);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.result.state, 'unpatched');
    assert.deepStrictEqual(r.result.files.map((f) => [f.state, f.patchedBy]),
        [['unpatched', patcher.VERSION], ['patched', null]]);

    r = patcher.run('apply', b.paths, quiet, NO_PROC, NEXT_SETS);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.result.state, 'patched');
    assert.strictEqual(r.result.changed, true);
    assert.deepStrictEqual(r.result.files.map((f) => f.patchedBy), [null, null]);
    assert.strictEqual(b.read('main'), patcher.applyPatches(stock.main, NEXT_SETS.current.main));
    assert.strictEqual(b.read('appmanagement'), earlier.appmanagement);

    r = patcher.run('apply', b.paths, quiet, NO_PROC, NEXT_SETS);
    assert.strictEqual(r.result.changed, false);

    assert.strictEqual(patcher.run('revert', b.paths, quiet, NO_PROC, NEXT_SETS).code, 0);
    assert.strictEqual(b.read('main'), stock.main);
    assert.strictEqual(b.read('appmanagement'), stock.appmanagement);

    // Straight from the earlier release's edits back to stock.
    fs.writeFileSync(b.paths.main, earlier.main);
    fs.writeFileSync(b.paths.appmanagement, earlier.appmanagement);
    r = patcher.run('revert', b.paths, quiet, NO_PROC, NEXT_SETS);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.result.changed, true);
    assert.strictEqual(b.read('main'), stock.main);
    assert.strictEqual(b.read('appmanagement'), stock.appmanagement);
}));

test('an earlier release\'s edits with an altered site are refused', () => withBundles((b) => {
    assert.strictEqual(patcher.run('apply', b.paths, quiet, NO_PROC).code, 0);
    const altered = b.read('main').replace(
        'entries.filter(_e=>!isLocalOnlyApp(_e.appId))', 'entries');
    fs.writeFileSync(b.paths.main, altered);
    const r = patcher.run('apply', b.paths, quiet, NO_PROC, NEXT_SETS);
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.result.state, 'mismatch');
    assert.strictEqual(b.read('main'), altered);
    assert.strictEqual(patcher.run('revert', b.paths, quiet, NO_PROC, NEXT_SETS).code, 2);
    assert.strictEqual(b.read('main'), altered);
}));

/* An earlier release with one more site than this one, in a module whose
 * helper this release keeps. */
const EXTRA_SITE = ['filler3(0);', 'filler3(0);isLocalOnlyApp(null);', 1];
const WITH_EXTRA = { version: '0.9.0', main: patcher.PATCH_SETS.main.concat([EXTRA_SITE]),
    appmanagement: patcher.PATCH_SETS.appmanagement };

test('apply and revert remove a site the current release dropped', () => withBundles((b) => {
    const stock = { main: b.read('main'), appmanagement: b.read('appmanagement') };
    const sets = { current: patcher.PATCH_SETS, earlier: [WITH_EXTRA] };
    const earlier = patcher.applyPatches(stock.main, WITH_EXTRA.main);
    fs.writeFileSync(b.paths.main, earlier);

    let r = patcher.run('check', b.paths, quiet, NO_PROC, sets);
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(r.result.files.map((f) => f.patchedBy), ['0.9.0', null]);

    r = patcher.run('apply', b.paths, quiet, NO_PROC, sets);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(b.read('main'), patcher.applyPatches(stock.main, patcher.PATCH_SETS.main));

    fs.writeFileSync(b.paths.main, earlier);
    assert.strictEqual(patcher.run('revert', b.paths, quiet, NO_PROC, sets).code, 0);
    assert.strictEqual(b.read('main'), stock.main);

    // Without the earlier set, the extra site is refused, not left behind.
    fs.writeFileSync(b.paths.main, earlier);
    r = patcher.run('revert', b.paths, quiet, NO_PROC);
    assert.strictEqual(r.code, 2);
    assert.strictEqual(b.read('main'), earlier);
}));

test('a bundle is matched to the earlier release that wrote all its edits', () => withBundles((b) => {
    const stock = b.read('main');
    const sets = { current: NEXT_SETS.current, earlier: [NEXT_SETS.earlier[0], WITH_EXTRA] };
    fs.writeFileSync(b.paths.main, patcher.applyPatches(stock, WITH_EXTRA.main));
    const r = patcher.run('apply', b.paths, quiet, NO_PROC, sets);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(b.read('main'), patcher.applyPatches(stock, NEXT_SETS.current.main));
}));

test('revert removes an earlier release\'s edits where the current ones do not fit', () => withBundles((b) => {
    const dropped = 'entryValue=entries.map(';
    const older = { version: '0.9.0', main: patcher.PATCH_SETS.main.filter((p) => p[0] !== dropped),
        appmanagement: patcher.PATCH_SETS.appmanagement };
    const sets = { current: patcher.PATCH_SETS, earlier: [older] };
    const firmware = b.read('main').replace(dropped, '');
    const earlier = patcher.applyPatches(firmware, older.main);
    fs.writeFileSync(b.paths.main, earlier);
    assert.strictEqual(patcher.run('apply', b.paths, quiet, NO_PROC, sets).code, 2);
    assert.strictEqual(b.read('main'), earlier);
    assert.strictEqual(patcher.run('revert', b.paths, quiet, NO_PROC, sets).code, 0);
    assert.strictEqual(b.read('main'), firmware);
}));

test('a predicate call without its helper is a mismatch', () => withBundles((b) => {
    const stray = b.read('main') + '\nisLocalOnlyApp(null);';
    fs.writeFileSync(b.paths.main, stray);
    assert.strictEqual(runTool(b.args('check')).code, 2);
    assert.strictEqual(runTool(b.args('apply')).code, 2);
    assert.strictEqual(b.read('main'), stray);
}));

/* A /proc with MainApp started secondsAgo (as the emulator starts it,
 * relative to its folder, or with a node option, as given), and a process
 * that only names main.js in its arguments. */
function fakeProc(dir, secondsAgo, mainapp) {
    const proc = path.join(dir, 'proc');
    const uptime = 1000;
    const addProcess = (pid, argv, startedAgo, cwd) => {
        fs.mkdirSync(path.join(proc, pid));
        fs.symlinkSync(cwd, path.join(proc, pid, 'cwd'));
        fs.writeFileSync(path.join(proc, pid, 'cmdline'), argv.join('\0') + '\0');
        const zeros = new Array(18).fill('0').join(' ');
        fs.writeFileSync(path.join(proc, pid, 'stat'),
            pid + ' (node) S ' + zeros + ' ' + (uptime - startedAgo) * 100 + ' 0 0\n');
    };
    fs.mkdirSync(proc);
    fs.writeFileSync(path.join(proc, 'uptime'), uptime + '.00 1500.00\n');
    addProcess('4242', mainapp.argv, secondsAgo, mainapp.cwd);
    addProcess('4343', ['node', 'patch_mainapp.js', 'apply', '--main', '/usr/lib/oap-mainapp/src/main.js'],
        3600, '/usr/lib/oap-mainapp/src');
    addProcess('4444', ['node', 'src/main.js'], 3600, '/var/opt/other');
    return proc;
}

const MAINAPP_EMU = { argv: ['node', 'src/main.js'], cwd: '/usr/lib/oap-mainapp' };
const MAINAPP_OPTS = { argv: ['/usr/bin/node', '--max-old-space-size=256', '/usr/lib/oap-mainapp/src/main.js'], cwd: '/' };

test('restartNeeded while MainApp runs code older than the bundles', () => withBundles((b) => {
    let r = patcher.run('apply', b.paths, quiet, fakeProc(b.dir, 60, MAINAPP_EMU));
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.result.restartNeeded, true);
    // Without a write, a MainApp started before the last write still needs it.
    r = patcher.run('check', b.paths, quiet, path.join(b.dir, 'proc'));
    assert.strictEqual(r.result.restartNeeded, true);
    rmrf(path.join(b.dir, 'proc'));
    const past = (Date.now() - 120 * 1000) / 1000;
    Object.keys(b.paths).forEach((kind) => fs.utimesSync(b.paths[kind], past, past));
    r = patcher.run('apply', b.paths, quiet, fakeProc(b.dir, 60, MAINAPP_OPTS));
    assert.strictEqual(r.result.changed, false);
    assert.strictEqual(r.result.restartNeeded, false);
    rmrf(path.join(b.dir, 'proc'));
    assert.strictEqual(patcher.run('check', b.paths, quiet, fakeProc(b.dir, 600, MAINAPP_OPTS))
        .result.restartNeeded, true);
    assert.strictEqual(patcher.run('check', b.paths, quiet, path.join(b.dir, 'none')).result.restartNeeded, false);
}));

/* The helper as injected into oap-mainapp, evaluated against a fake
 * unit filesystem: files maps a path to its content (a string, or a
 * Buffer for a package); reads collects every path read. Returns the
 * appIds reported, or with no appIds the helper itself. */
function evaluateHelper(files, appIds, reads) {
    const enoent = (file) => {
        const e = new Error('ENOENT: ' + file);
        e.code = 'ENOENT';
        return e;
    };
    const has = (file) => Object.prototype.hasOwnProperty.call(files, file);
    const fakeFs = {
        readFileSync: (file, encoding) => {
            if (!has(file)) {
                throw enoent(file);
            }
            if (reads) {
                reads.push(file);
            }
            const data = files[file];
            return Buffer.isBuffer(data) && encoding ? data.toString(encoding) : data;
        },
        readdirSync: (dir) => {
            const names = Object.keys(files).filter((f) => f.indexOf(dir) === 0 &&
                f.slice(dir.length).indexOf('/') < 0).map((f) => f.slice(dir.length));
            if (!names.length) {
                throw enoent(dir);
            }
            return names;
        },
        statSync: (file) => {
            if (!has(file)) {
                throw enoent(file);
            }
            return { size: files[file].length, mtime: new Date(0) };
        }
    };
    const modules = { fs: fakeFs, zlib: zlib };
    const sandbox = { Buffer: Buffer, require: (name) => {
        assert.ok(modules[name], 'helper requires ' + name);
        return modules[name];
    } };
    vm.runInNewContext(patcher.HELPER_JS + ';this.isLocalOnlyApp=isLocalOnlyApp;', sandbox);
    return appIds ? appIds.filter((id) => !sandbox.isLocalOnlyApp(id)) : sandbox.isLocalOnlyApp;
}

/* A gzipped ustar archive of { name: content } entries. */
function tgz(entries) {
    const blocks = [];
    Object.keys(entries).forEach((name) => {
        const data = Buffer.from(entries[name]);
        const header = Buffer.alloc(512);
        header.write(name, 0);
        header.write('0000644\0', 100);
        header.write('0000000\0', 108);
        header.write('0000000\0', 116);
        header.write(('00000000000' + data.length.toString(8)).slice(-11) + '\0', 124);
        header.write('00000000000\0', 136);
        header.write('0', 156);
        header.write('ustar\0' + '00', 257);
        header.write('        ', 148);
        let sum = 0;
        for (let i = 0; i < 512; i += 1) {
            sum += header[i];
        }
        header.write(('000000' + sum.toString(8)).slice(-6) + '\0 ', 148);
        blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
    });
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

const ROOT = '/var/opt/public/oap/';
function installed(files, appId, uid, pkg) {
    files[ROOT + 'oap_12201/data/apps/' + appId + '.json'] = JSON.stringify({ userId: uid });
    if (pkg) {
        files[ROOT + 'oap_' + uid + '/source/package.json'] = JSON.stringify(pkg);
    }
    return files;
}

test('marked apps are filtered, genuine apps are reported', () => {
    const files = {};
    installed(files, 'doom', 12225, { name: 'doom', mguLocalOnly: true });
    installed(files, 'renamed_app', 12230, { name: 'renamed_app', mguLocalOnly: true });
    installed(files, 'news', 12210, { name: 'news', version: '3.1.0' });
    installed(files, 'trigger_service', 12211, { name: 'trigger_service' });
    const reported = evaluateHelper(files, ['doom', 'renamed_app', 'news', 'trigger_service']);
    assert.deepStrictEqual(reported, ['news', 'trigger_service']);
});

test('the marker must be exactly true', () => {
    const files = {};
    installed(files, 'a', 12230, { mguLocalOnly: 'true' });
    installed(files, 'b', 12231, { mguLocalOnly: 1 });
    installed(files, 'c', 12232, { mguLocalOnly: true });
    assert.deepStrictEqual(evaluateHelper(files, ['a', 'b', 'c']), ['a', 'b']);
});

test('the override list marks an app without its marker', () => {
    const files = {};
    files[patcher.OVERRIDE_FILE] = JSON.stringify(['legacy_app']);
    installed(files, 'legacy_app', 12224, { name: 'legacy_app' });
    installed(files, 'news', 12210, { name: 'news' });
    assert.deepStrictEqual(evaluateHelper(files, ['legacy_app', 'news', 'not_installed']),
        ['news', 'not_installed']);
});

test('unreadable, malformed or unsafe lookups report the app', () => {
    const files = {};
    files[patcher.OVERRIDE_FILE] = '{"not":"a list"}';
    installed(files, 'no_source', 12240);
    files[ROOT + 'oap_12201/data/apps/bad_json.json'] = '{';
    installed(files, 'string_uid', '12241', { mguLocalOnly: true });
    files[ROOT + 'oap_12241/source/package.json'] = JSON.stringify({ mguLocalOnly: true });
    installed(files, 'float_uid', 12242.5, { mguLocalOnly: true });
    // A path in the appId never reaches the filesystem.
    files[ROOT + 'oap_12201/data/apps/../apps/x.json'] = JSON.stringify({ userId: 12243 });
    files[ROOT + 'oap_12243/source/package.json'] = JSON.stringify({ mguLocalOnly: true });
    const ids = ['no_source', 'bad_json', 'string_uid', 'float_uid', '../apps/x', '', null];
    assert.deepStrictEqual(evaluateHelper(files, ids), ids);
});

const PRE = patcher.PREINSTALLED_DIR;

test('an app being installed is decided by its preinstalled package', () => {
    const files = {};
    files[PRE + 'ours@1.0.0.tgz'] = tgz({ 'CHANGELOG.md': 'x'.repeat(700),
        'package.json': JSON.stringify({ name: 'ours', mguLocalOnly: true }) });
    files[PRE + 'ours_npm-2.0.0.tgz'] = tgz({ 'package/package.json':
        JSON.stringify({ name: 'ours_npm', mguLocalOnly: true }) });
    files[PRE + 'genuine-4.25.3.tgz'] = tgz({ 'package/package.json': JSON.stringify({ name: 'genuine' }) });
    files[PRE + 'string_marker@1.0.0.tgz'] = tgz({ 'package.json': JSON.stringify({ mguLocalOnly: 'true' }) });
    assert.deepStrictEqual(evaluateHelper(files, ['ours', 'ours_npm', 'genuine', 'string_marker', 'absent']),
        ['genuine', 'string_marker', 'absent']);
});

test('an installed app is decided by its installed package, not the preinstalled one', () => {
    const files = {};
    installed(files, 'ours', 12230, { name: 'ours' });
    files[PRE + 'ours@1.0.0.tgz'] = tgz({ 'package.json': JSON.stringify({ name: 'ours', mguLocalOnly: true }) });
    installed(files, 'theirs', 12231, { name: 'theirs', mguLocalOnly: true });
    files[PRE + 'theirs@1.0.0.tgz'] = tgz({ 'package.json': JSON.stringify({ name: 'theirs' }) });
    assert.deepStrictEqual(evaluateHelper(files, ['ours', 'theirs']), ['ours']);
});

test('another app\'s, a misnamed or a corrupt package reports the app', () => {
    const files = {};
    const marked = tgz({ 'package.json': JSON.stringify({ mguLocalOnly: true }) });
    files[PRE + 'ours_extra@1.0.0.tgz'] = marked;
    files[PRE + 'beta@next.tgz'] = marked;
    files[PRE + 'garbage@1.0.0.tgz'] = Buffer.from('not a gzip');
    files[PRE + 'nojson@1.0.0.tgz'] = tgz({ 'package.json': '{' });
    files[PRE + 'nopkg@1.0.0.tgz'] = tgz({ 'manifest.json': '{}' });
    const ids = ['ours', 'beta', 'garbage', 'nojson', 'nopkg'];
    assert.deepStrictEqual(evaluateHelper(files, ids), ids);
});

test('a preinstalled package is read once per size and mtime', () => {
    const files = {}, reads = [];
    const file = PRE + 'ours@1.0.0.tgz';
    files[file] = tgz({ 'package.json': JSON.stringify({ mguLocalOnly: true }) });
    const isLocalOnlyApp = evaluateHelper(files, null, reads);
    assert.strictEqual(isLocalOnlyApp('ours'), true);
    assert.strictEqual(isLocalOnlyApp('ours'), true);
    assert.strictEqual(reads.filter((f) => f === file).length, 1);
    files[file] = tgz({ 'package.json': JSON.stringify({ name: 'ours', version: '1.0.1' }) });
    assert.strictEqual(isLocalOnlyApp('ours'), false);
    assert.strictEqual(reads.filter((f) => f === file).length, 2);
});

function stage(root, appId, pkgExtra, script) {
    const dir = path.join(root, 'apps', appId, appId + '@1.0.0');
    if (!fs.existsSync(path.join(root, 'apps'))) {
        fs.mkdirSync(path.join(root, 'apps'));
    }
    fs.mkdirSync(path.join(root, 'apps', appId));
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, 'javascript'));
    fs.writeFileSync(path.join(dir, 'javascript', 'app.js'), script || "console.log('x');");
    fs.writeFileSync(path.join(dir, 'package.json'),
        JSON.stringify(Object.assign({ name: appId, version: '1.0.0' }, pkgExtra), null, 2) + '\n');
    return dir;
}

function withRoot(fn) {
    const root = tmpdir();
    try {
        fn(root);
    } finally {
        rmrf(root);
    }
}

test('stampPackage adds the marker once and keeps the rest', () => withRoot((root) => {
    const dir = stage(root, 'sample', { files: ['javascript'] });
    assert.strictEqual(patcher.stampPackage(dir), true);
    const text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    assert.deepStrictEqual(JSON.parse(text),
        { name: 'sample', version: '1.0.0', files: ['javascript'], mguLocalOnly: true });
    assert.ok(text.endsWith('}\n'));
    assert.strictEqual(patcher.stampPackage(dir), false);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), text);
}));

test('check-apps passes a marked clean app', () => withRoot((root) => {
    stage(root, 'sample', { mguLocalOnly: true });
    assert.strictEqual(runTool(['check-apps', path.join(root, 'apps')]).code, 0);
}));

test('check-apps fails an unmarked app', () => withRoot((root) => {
    stage(root, 'sample', {});
    const r = runTool(['check-apps', path.join(root, 'apps')]);
    assert.strictEqual(r.code, 1);
    assert.ok(/mguLocalOnly/.test(r.stdout), r.stdout);
}));

test('check-apps fails SDK analytics and an analytics key', () => withRoot((root) => {
    stage(root, 'one', { mguLocalOnly: true }, "require('countly');");
    stage(root, 'two', { mguLocalOnly: true, oapAnalytics: { appKeys: {} } });
    const r = runTool(['check-apps', path.join(root, 'apps')]);
    assert.strictEqual(r.code, 1);
    assert.ok(/countly/.test(r.stdout) && /oapAnalytics/.test(r.stdout), r.stdout);
}));

test('every app in this repository is marked and clean', () => {
    const r = runTool(['check-apps', path.join(__dirname, '..', '..', '..', 'apps')]);
    assert.strictEqual(r.code, 0, r.stdout);
});

function firmwareDir() {
    const candidates = [
        process.env.FIRMWARE_MAINAPP_DIR || '',
        path.join(os.homedir(), 'workspaces/personal/claude-bmw-ecu/mgu18/decoded/oap-mainapp')
    ];
    return candidates.filter((c) => c && fs.existsSync(path.join(c, 'src', 'main.js')) &&
        fs.existsSync(path.join(c, 'src', 'AppManagement', 'AppManagement.js')))[0];
}

test('reference firmware bundles patch, upgrade, parse and revert exactly', () => {
    const root = firmwareDir();
    if (!root) {
        return 'skipped: decoded oap-mainapp not available';
    }
    const dir = tmpdir();
    try {
        const paths = {
            main: path.join(dir, 'main.js'),
            appmanagement: path.join(dir, 'AppManagement.js')
        };
        const stock = {
            main: fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8'),
            appmanagement: fs.readFileSync(path.join(root, 'src', 'AppManagement', 'AppManagement.js'), 'utf8')
        };
        Object.keys(paths).forEach((kind) => {
            fs.writeFileSync(paths[kind], stock[kind]);
            assert.strictEqual(sha256(patcher.applyPatches(stock[kind], patcher.PATCH_SETS[kind])),
                PATCHED_SHA256.current[kind], kind + ': the edits differ from the released ones');
            patcher.EARLIER_PATCH_SETS.forEach((earlier) => assert.strictEqual(
                sha256(patcher.applyPatches(stock[kind], earlier[kind])), PATCHED_SHA256[earlier.version][kind],
                kind + ': ' + earlier.version + '\'s edits differ from the released ones'));
        });
        const args = ['--main', paths.main, '--appmanagement', paths.appmanagement];
        let r = runTool(['check', '--json'].concat(args));
        assert.strictEqual(r.code, 1, r.stdout);
        lastJson(r.stdout).files.forEach((f) => assert.strictEqual(f.reference, true));
        r = runTool(['apply'].concat(args));
        assert.strictEqual(r.code, 0, r.stdout);
        Object.keys(paths).forEach((kind) => {
            const check = childProcess.spawnSync(process.execPath, ['--check', paths[kind]], { encoding: 'utf8' });
            assert.strictEqual(check.status, 0, check.stderr);
        });
        r = runTool(['revert'].concat(args));
        assert.strictEqual(r.code, 0, r.stdout);
        Object.keys(paths).forEach((kind) => {
            assert.strictEqual(fs.readFileSync(paths[kind], 'utf8'), stock[kind]);
        });

        // Each earlier release's edits: apply replaces them, revert restores stock.
        patcher.EARLIER_PATCH_SETS.forEach((earlier) => {
            Object.keys(paths).forEach((kind) =>
                fs.writeFileSync(paths[kind], patcher.applyPatches(stock[kind], earlier[kind])));
            r = runTool(['check', '--json'].concat(args));
            assert.strictEqual(r.code, 1, r.stdout);
            lastJson(r.stdout).files.forEach((f) => assert.strictEqual(f.patchedBy, earlier.version));
            r = runTool(['apply'].concat(args));
            assert.strictEqual(r.code, 0, r.stdout);
            Object.keys(paths).forEach((kind) => assert.strictEqual(fs.readFileSync(paths[kind], 'utf8'),
                patcher.applyPatches(stock[kind], patcher.PATCH_SETS[kind])));
            assert.strictEqual(runTool(['revert'].concat(args)).code, 0);
            Object.keys(paths).forEach((kind) => {
                assert.strictEqual(fs.readFileSync(paths[kind], 'utf8'), stock[kind]);
            });
        });

        // A later release's apply over this release's edits, then its revert.
        assert.strictEqual(runTool(['apply'].concat(args)).code, 0);
        const upgraded = patcher.run('apply', paths, quiet, NO_PROC, NEXT_SETS);
        assert.strictEqual(upgraded.code, 0);
        assert.strictEqual(upgraded.result.changed, true);
        Object.keys(paths).forEach((kind) => {
            const check = childProcess.spawnSync(process.execPath, ['--check', paths[kind]], { encoding: 'utf8' });
            assert.strictEqual(check.status, 0, check.stderr);
        });
        assert.strictEqual(patcher.run('revert', paths, quiet, NO_PROC, NEXT_SETS).code, 0);
        Object.keys(paths).forEach((kind) => {
            assert.strictEqual(fs.readFileSync(paths[kind], 'utf8'), stock[kind]);
        });
    } finally {
        rmrf(dir);
    }
    return null;
});

let failed = 0;
tests.forEach((t) => {
    try {
        const note = t.fn();
        console.log('ok   ' + t.name + (typeof note === 'string' ? ' (' + note + ')' : ''));
    } catch (e) {
        failed += 1;
        console.log('FAIL ' + t.name + '\n     ' + (e.stack || e).toString().split('\n').join('\n     '));
    }
});
console.log((tests.length - failed) + '/' + tests.length + ' passed');
process.exitCode = failed ? 1 : 0;
