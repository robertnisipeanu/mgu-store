'use strict';
/*
 * Tests for patch_mainapp.js. Run on the head unit's Node with
 * `sh test/run.sh`, or on any Node with `node test/test_patch_mainapp.js`.
 *
 * The firmware cases run when a decoded oap-mainapp is available
 * (FIRMWARE_MAINAPP_DIR names iDrive 7's folder, FIRMWARE_MAINAPP21_DIR
 * iDrive 8's MainApp-21, 9.3.4 or 9.2.15, FIRMWARE_MAINAPP_8_1_1_DIR
 * iDrive 7's MainApp 8.1.1); each is skipped otherwise.
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

// sha256 of JSON.stringify(PATCH_SETS) as shipped by 1.5.0, and of the
// earlier entries of EARLIER_PATCH_SETS.
const PATCH_SETS_SHA256 = '6598d28199d4003fed2494ff6381c777206a85a1f3d7cdcd865196e2f8912ce0';
const EARLIER_SETS_SHA256 = {
    '1.4.0': 'a83ed0b557ee2ab52871388768f6e06bad255fbcb08c947e378db2872a310eed',
    '1.2.2': 'd494bf13326a07a6275f762b25d0639efb6eb12258718289000bb05ecbca5d8c',
    '1.1.0': '65fdf5a71cb95d465b37811cb2f326495686d4edcbd33566c07bad6c3ddc484e'
};
// What check names as the release whose edits a bundle carries, for each
// earlier release's edits: none when this release keeps them; 1.2.2's
// AppManagement.js edits are 1.4.0's.
const PATCHED_BY = {
    '1.4.0': { main: null, appmanagement: '1.4.0' },
    '1.2.2': { main: '1.2.2', appmanagement: '1.4.0' },
    '1.1.0': { main: '1.1.0', appmanagement: '1.1.0' }
};
// sha256 of the reference firmware bundles as each release patches them:
// the current edits (1.5.0), 1.4.0's (and 1.3.0's), 1.2.2's (and 1.2.0's,
// 1.2.1's) and 1.1.0's (and 1.0.0's).
const PATCHED_SHA256 = {
    current: {
        main: '51d714ea0cd3e1127924fd1779b3cac82938715ee89c9e89e83351c80f347c8e',
        appmanagement: 'fbd85004e927f2ff28f33bef15540fb677026dda53e85cc4a07a98ab284bbc2a'
    },
    '1.4.0': {
        main: '51d714ea0cd3e1127924fd1779b3cac82938715ee89c9e89e83351c80f347c8e',
        appmanagement: '4582ab2a6a674a9fb6e1d544dd10674f9785d0906d4478b1dae625734d609997'
    },
    '1.2.2': {
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

// sha256 of JSON.stringify(PATCH_SETS_21) as shipped by 1.4.0, and of
// MainApp-21's reference bundles (I-step 036.010.004) as it patches them.
const PATCH_SETS_21_SHA256 = '44b92e5de169297798163bd2b9a31728027f78b3db793f08de810c9d911b0f5a';
const PATCHED_21_SHA256 = {
    main: '10c59be5b5e75bfa21f5d5fae806e6c85ffa4ed8b5b83f980a178f1cec64bba3',
    appmanagement: 'b8ad9c0d6acce898f783a0bfa7bf51c363754b4b4c92c3a7680c0feb59a1ceb8'
};

test('the MainApp-21 patch set is recorded', () => {
    const sha = setsSha(patcher.PATCH_SETS_21);
    assert.strictEqual(sha, PATCH_SETS_21_SHA256,
        'PATCH_SETS_21 differs from the released one: keep the released sets as MainApp-21\'s earlier release ' +
        '(UNITS.ID8.mainapps[0].sets.earlier) and bump the version; then record ' + sha + ' here');
});

// sha256 of JSON.stringify(PATCH_SETS_8_1_1) as shipped by 1.6.0, and of
// MainApp 8.1.1's bundles (HU software 16.20.4) as it patches them.
const PATCH_SETS_8_1_1_SHA256 = '7e7423729624348add147bd7ba7c17782cd8b0561dacd493e10dcac3ad67c18f';
const PATCHED_8_1_1_SHA256 = {
    main: '09131f38cb0ad5dd82a64cb89301a3105eae08b0177f2a39ff185909d216d098',
    appmanagement: 'fe43f739a9d43d19a11bbd00791b3c418daaeb67a1790d5cb12e9e8eb9e383d5'
};

test('the MainApp 8.1.1 patch set is recorded', () => {
    const sha = setsSha(patcher.PATCH_SETS_8_1_1);
    assert.strictEqual(sha, PATCH_SETS_8_1_1_SHA256,
        'PATCH_SETS_8_1_1 differs from the released one: keep the released sets as 8.1.1\'s earlier release ' +
        '(its UNITS.ID7.mainapps entry\'s sets.earlier) and bump the version; then record ' + sha + ' here');
});

// sha256 of JSON.stringify(PATCH_SETS_21_9_2_15) as shipped by 1.6.1, and of
// MainApp-21 9.2.15's bundles as it patches them.
const PATCH_SETS_21_9_2_15_SHA256 = '9ada4eaecdba9320ee00d699758d84960e59bee09a1b37aca29c0cb1d4cdc03f';
const PATCHED_21_9_2_15_SHA256 = {
    main: '223d7e196c9821651b2744b92b18643c46b7abb91683749712fd57ae031d230c',
    appmanagement: '75f24a41ce95219e44e0bf913343302c90d3e2bba011a7201df83c0f65139f04'
};

test('the MainApp-21 9.2.15 patch set is recorded', () => {
    const sha = setsSha(patcher.PATCH_SETS_21_9_2_15);
    assert.strictEqual(sha, PATCH_SETS_21_9_2_15_SHA256,
        'PATCH_SETS_21_9_2_15 differs from the released one: keep the released sets as 9.2.15\'s earlier release ' +
        '(its UNITS.ID8.mainapps entry\'s sets.earlier) and bump the version; then record ' + sha + ' here');
});

// sha256 of JSON.stringify(PATCH_SETS_8_2_8) as shipped by 1.6.2.
const PATCH_SETS_8_2_8_SHA256 = 'b42b04bb1293905464536ec29ff54f2de82f746195478bd3b906c8a269bf627b';

test('the MainApp 8.2.8 patch set is recorded', () => {
    const sha = setsSha(patcher.PATCH_SETS_8_2_8);
    assert.strictEqual(sha, PATCH_SETS_8_2_8_SHA256,
        'PATCH_SETS_8_2_8 differs from the released one: keep the released sets as 8.2.8\'s earlier release ' +
        '(its UNITS.ID7.mainapps entry\'s sets.earlier) and bump the version; then record ' + sha + ' here');
});

/* Synthetic bundles of one release's anchors as the given MainApp release. */
function withReleaseBundles(unit, sets, fn) {
    const dir = tmpdir();
    const paths = {};
    Object.keys(sets).forEach((kind) => {
        paths[kind] = path.join(dir, kind + '.js');
        fs.writeFileSync(paths[kind], syntheticBundle(sets[kind]));
    });
    const args = (command) => [command, '--json', '--unit', unit, '--main', paths.main, '--appmanagement', paths.appmanagement];
    const read = (kind) => fs.readFileSync(paths[kind], 'utf8');
    try {
        fn({ dir, paths, args, read });
    } finally {
        rmrf(dir);
    }
}

test('bundles take the edits of the MainApp release they fit', () => {
    assert.deepStrictEqual(patcher.UNITS.ID7.mainapps.map((m) => m.version), ['8.3.2', '8.2.8', '8.1.1']);
    assert.deepStrictEqual(patcher.UNITS.ID8.mainapps.map((m) => m.version), ['9.3.4', '9.2.15']);
    [['ID7', patcher.PATCH_SETS, '8.3.2'], ['ID7', patcher.PATCH_SETS_8_2_8, '8.2.8'], ['ID7', patcher.PATCH_SETS_8_1_1, '8.1.1'],
        ['ID8', patcher.PATCH_SETS_21, '9.3.4'],
        ['ID8', patcher.PATCH_SETS_21_9_2_15, '9.2.15']].forEach((release) => withReleaseBundles(release[0], release[1], (b) => {
        const stock = { main: b.read('main'), appmanagement: b.read('appmanagement') };
        let r = runTool(b.args('check'));
        assert.strictEqual(r.code, 1, r.stdout);
        assert.strictEqual(lastJson(r.stdout).mainapp, release[2]);
        r = runTool(b.args('apply'));
        assert.strictEqual(r.code, 0, r.stdout);
        assert.strictEqual(lastJson(r.stdout).mainapp, release[2]);
        Object.keys(stock).forEach((kind) => assert.strictEqual(b.read(kind), patcher.applyPatches(stock[kind], release[1][kind])));
        r = runTool(b.args('check'));
        assert.strictEqual(r.code, 0, r.stdout);
        assert.strictEqual(lastJson(r.stdout).mainapp, release[2]);
        assert.strictEqual(runTool(b.args('revert')).code, 0);
        Object.keys(stock).forEach((kind) => assert.strictEqual(b.read(kind), stock[kind]));
    }));
});

test('each iDrive 7 release\'s edits fit only its own bundles', () => {
    const sets = { '8.3.2': patcher.PATCH_SETS, '8.2.8': patcher.PATCH_SETS_8_2_8, '8.1.1': patcher.PATCH_SETS_8_1_1 };
    // 8.2.8's edits are 8.3.2's but for one, so 8.3.2's bundles fit both (8.3.2 is tried first)
    const sharedBy = (mine, other, kind) => mine === '8.3.2' && other === '8.2.8' || sets[mine][kind] === sets[other][kind];
    Object.keys(sets).forEach((mine) => Object.keys(sets).filter((other) => other !== mine).forEach((other) => {
        ['main', 'appmanagement'].filter((kind) => !sharedBy(mine, other, kind)).forEach((kind) => {
            const stock = syntheticBundle(sets[mine][kind]);
            assert.ok(Array.isArray(patcher.classify(stock, sets[other][kind])), mine + ' ' + kind + ' fits ' + other);
            assert.ok(Array.isArray(patcher.classify(patcher.applyPatches(stock, sets[mine][kind]), sets[other][kind])),
                mine + ' ' + kind + ' patched fits ' + other);
        });
    }));
});

test('bundles of two MainApp releases are refused, nothing written', () => withBundles((b) => {
    fs.writeFileSync(b.paths.appmanagement, syntheticBundle(patcher.PATCH_SETS_8_1_1.appmanagement));
    const stock = { main: b.read('main'), appmanagement: b.read('appmanagement') };
    const r = runTool(['apply', '--json', '--main', b.paths.main, '--appmanagement', b.paths.appmanagement]);
    assert.strictEqual(r.code, 2, r.stdout);
    const res = lastJson(r.stdout);
    assert.strictEqual(res.state, 'mismatch');
    assert.strictEqual(res.mainapp, null);
    // 8.3.2's edits are the closest fit: its one problem is reported
    assert.deepStrictEqual(res.files.map((f) => f.problems.length), [0, 1]);
    assert.ok(/certificateManagerGids.*1 occurrence\(s\), expected 2/.test(res.files[1].problems[0]), res.files[1].problems[0]);
    Object.keys(stock).forEach((kind) => assert.strictEqual(b.read(kind), stock[kind]));
}));

/* A CorruptAppsHandler in MainApp 8.1.1's shape (no analytics event after
 * the recovery counter; the recovery ladder bound with let), written for
 * this test around the edits' anchors, patched and run: crashes(ids)
 * returns what each crash did, in order. */
function crashHandler811(localOnly) {
    const patches = patcher.PATCH_SETS_8_1_1.main.filter((p) =>
        p[0] === 'class CorruptAppsHandler{' || p[0].indexOf('recoveryAttemptsSinceCorruption') >= 0);
    assert.strictEqual(patches.length, 3);
    const stock = 'const _={defaults:(o,d)=>(Object.keys(d).forEach(k=>{void 0===o[k]&&(o[k]=d[k])}),o)};' +
        'class CorruptAppsHandler{constructor(){this._appIdToCorruptAppInfo={},this.done=[]}' +
        '_tryRecoverApp(app){const appId=app.getAppId();' +
        '_.defaults(this._appIdToCorruptAppInfo,{[appId]:{}});' +
        'const appCorruptInfo=_.defaults(this._appIdToCorruptAppInfo[appId],{recoveryAttemptsSinceCorruption:0});' +
        'let recoveryAction={0:()=>"restart",1:()=>"wipe",2:()=>"reinstall"}[appCorruptInfo.recoveryAttemptsSinceCorruption];' +
        'if(!recoveryAction)return appCorruptInfo.recoveryAttemptsSinceCorruption=0,this.done.push([appId,"irrecoverable"]),Promise.resolve();' +
        'return appCorruptInfo.recoveryAttemptsSinceCorruption++,app.updateStartableCouncil("CorruptAppsHandler",!1),' +
        'this.done.push([appId,recoveryAction()]),Promise.resolve()}}module.exports=CorruptAppsHandler;';
    const source = patcher.applyPatches(stock, patches);
    assert.strictEqual(patcher.classify(source, patches), 'patched');
    const warnings = [];
    const module = { exports: null };
    const fakeFs = { readFileSync: (file) => {
        if (file === patcher.OVERRIDE_FILE) {
            return JSON.stringify(localOnly);
        }
        const e = new Error('ENOENT: ' + file);
        e.code = 'ENOENT';
        throw e;
    }, readdirSync: () => [] };
    vm.runInNewContext(source, { require: (name) => { assert.strictEqual(name, 'fs'); return fakeFs; }, module,
        logger: { warn: (m) => warnings.push(m) }, Date, Promise, Object, Array, JSON });
    const handler = new module.exports();
    const app = (id) => ({ getAppId: () => id, updateStartableCouncil() {} });
    return {
        warnings,
        crashes: (ids) => ids.reduce((p, id) => p.then(() => handler._tryRecoverApp(app(id))), Promise.resolve())
            .then(() => JSON.parse(JSON.stringify(handler.done)))
    };
}

test('MainApp 8.1.1 shape: a local-only app is only restarted, a stock app keeps its recovery', () => {
    const h = crashHandler811(['ours']);
    return h.crashes(['ours', 'ours', 'ours', 'ours', 'ours', 'stock', 'stock', 'stock', 'stock', 'ours']).then((done) => {
        assert.deepStrictEqual(done, [['ours', 'restart'], ['ours', 'restart'], ['ours', 'restart'], ['ours', 'restart'],
            ['ours', 'restart'], ['stock', 'restart'], ['stock', 'wipe'], ['stock', 'reinstall'], ['stock', 'irrecoverable']]);
        assert.deepStrictEqual(h.warnings, ['CorruptAppsHandler::_tryRecoverApp ours is local-only and was restarted ' +
            '5 times in 10 minutes; left stopped until it is started again.']);
    });
});

test('the kernel command line picks the MainApp', () => {
    assert.strictEqual(patcher.unitOf('root=/dev/x hwtype=MGU hwgen=21 hwvariant=HIGH'), 'ID8');
    assert.strictEqual(patcher.unitOf('hwgen=22'), 'ID8');
    assert.strictEqual(patcher.unitOf('hwgen=18 quiet'), 'ID7');
    assert.strictEqual(patcher.unitOf('xhwgen=21'), 'ID7');
    assert.strictEqual(patcher.unitOf(''), 'ID7');
    assert.strictEqual(patcher.UNITS.ID8.paths.main, '/usr/lib/oap-mainapp21/src/main.js');
    assert.strictEqual(patcher.UNITS.ID7.paths.main, '/usr/lib/oap-mainapp/src/main.js');
});

test('--unit ID8 checks, applies and reverts MainApp-21\'s edits', () => {
    const dir = tmpdir();
    try {
        const paths = {};
        Object.keys(patcher.PATCH_SETS_21).forEach((kind) => {
            paths[kind] = path.join(dir, kind + '.js');
            fs.writeFileSync(paths[kind], syntheticBundle(patcher.PATCH_SETS_21[kind]));
        });
        const stock = { main: fs.readFileSync(paths.main, 'utf8'), appmanagement: fs.readFileSync(paths.appmanagement, 'utf8') };
        const args = (command) => [command, '--json', '--unit', 'ID8', '--main', paths.main, '--appmanagement', paths.appmanagement];
        let r = runTool(args('check'));
        assert.strictEqual(r.code, 1, r.stdout);
        assert.strictEqual(lastJson(r.stdout).unit, 'ID8');
        r = runTool(args('apply'));
        assert.strictEqual(r.code, 0, r.stdout);
        assert.strictEqual(fs.readFileSync(paths.main, 'utf8'), patcher.applyPatches(stock.main, patcher.PATCH_SETS_21.main));
        // iDrive 7's edits do not fit MainApp-21: refused, nothing written
        r = runTool(['apply', '--unit', 'ID7', '--main', paths.main, '--appmanagement', paths.appmanagement]);
        assert.strictEqual(r.code, 2, r.stdout);
        assert.strictEqual(runTool(args('check')).code, 0);
        assert.strictEqual(runTool(args('revert')).code, 0);
        Object.keys(paths).forEach((kind) => assert.strictEqual(fs.readFileSync(paths[kind], 'utf8'), stock[kind]));
    } finally {
        rmrf(dir);
    }
});

test('the earlier releases\' patch sets are recorded', () => {
    assert.deepStrictEqual(patcher.EARLIER_PATCH_SETS.map((s) => s.version), Object.keys(EARLIER_SETS_SHA256));
    patcher.EARLIER_PATCH_SETS.forEach((s) => assert.strictEqual(setsSha(s), EARLIER_SETS_SHA256[s.version], s.version));
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
const MAINAPP21 = { argv: ['/usr/bin/node', '--expose-gc', '/usr/lib/oap-mainapp21/src/main.js'], cwd: '/' };
// as the emulator starts it: a module preloaded with -r
const MAINAPP21_EMU = { argv: ['/usr/bin/node', '-r', '/usr/local/libexec/emu/emu-dlt-print.js', '--expose-gc',
    '/usr/lib/oap-mainapp21/src/main.js'], cwd: '/' };
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
    rmrf(path.join(b.dir, 'proc'));
    // MainApp-21 counts for iDrive 8 only
    assert.strictEqual(patcher.run('check', b.paths, quiet, fakeProc(b.dir, 600, MAINAPP21)).result.restartNeeded, false);
    assert.strictEqual(patcher.run('check', b.paths, quiet, path.join(b.dir, 'proc'), patcher.UNITS.ID7.mainapps[0].sets, 'ID8')
        .result.nextStart, true);
}));

/* The helper as injected into oap-mainapp, evaluated against a fake
 * unit filesystem: files maps a path to its content (a string, or a
 * Buffer for a package); reads collects every path read. Returns the
 * appIds reported, or with no appIds the helper itself. */
function evaluateHelper(files, appIds, reads, helper) {
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
    vm.runInNewContext((helper || patcher.HELPER_JS) + ';this.isLocalOnlyApp=isLocalOnlyApp;', sandbox);
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

test('MainApp-21 decides an app being installed by its own preinstalled package', () => {
    const PRE21 = patcher.PREINSTALLED_DIR_21;
    const files = {};
    files[PRE21 + 'ours@1.0.0.tgz'] = tgz({ 'package/package.json': JSON.stringify({ name: 'ours', mguLocalOnly: true }) });
    files[PRE + 'other@1.0.0.tgz'] = tgz({ 'package/package.json': JSON.stringify({ name: 'other', mguLocalOnly: true }) });
    installed(files, 'registered', 12230, { name: 'registered', mguLocalOnly: true });
    assert.deepStrictEqual(evaluateHelper(files, ['ours', 'other', 'registered', 'genuine'], null, patcher.HELPER_JS_21),
        ['other', 'genuine']);
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
    const dir = process.env.FIRMWARE_MAINAPP_DIR;
    return dir && fs.existsSync(path.join(dir, 'src', 'main.js')) &&
        fs.existsSync(path.join(dir, 'src', 'AppManagement', 'AppManagement.js')) ? dir : undefined;
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
            // A bundle whose edits this release keeps is patched already; edits
            // several releases shipped are named by the newest of them.
            lastJson(r.stdout).files.forEach((f) => assert.strictEqual(f.patchedBy,
                PATCHED_BY[earlier.version][f.kind], earlier.version + ' ' + f.kind));
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

/* The reference firmware's CorruptAppsHandler module, patched, run against
 * fake collaborators. apps maps appId to { start } (start(args) returns a
 * promise); local-only apps are named by the override list, which reads
 * as missing while state.unreadable is set. Returns the handler, what it
 * did (events), the clock and state (shuttingDown: the head unit shuts
 * down). */
function crashHandler(root, apps, localOnly) {
    const main = patcher.applyPatches(fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8'),
        patcher.PATCH_SETS.main);
    const source = main.split('\n').filter((l) => l.indexOf('class CorruptAppsHandler{') >= 0)[0];
    const events = [];
    const clock = { now: 1e12 };
    const state = { unreadable: false, shuttingDown: false };
    const log = (kind) => (id) => { events.push([kind, id]); return Promise.resolve(); };
    const fakeFs = { readFileSync: (file) => {
        if (file === patcher.OVERRIDE_FILE && !state.unreadable) {
            return JSON.stringify(localOnly);
        }
        const e = new Error('ENOENT: ' + file);
        e.code = 'ENOENT';
        throw e;
    }, readdirSync: () => [] };
    const logger = { info() {}, debug() {}, warn(m) { events.push(['warn', m.split(' ')[1], m]); } };
    const modules = {
        util: require('util'),
        fs: fakeFs,
        'oap-sdk/src/analytics/AnalyticsServiceBuilders': { buildAnalyticsService: () => ({
            sendPlatformEvent: (e) => events.push(['analytics', e.payload.appName]) }) },
        'oap-sdk/src/analytics/interface/analyticsservice': {
            AnalyticsPlatformEventType: { APP_CRASH: 'APP_CRASH' }, AnalyticsPlatformLogLevel: { ERROR: 'ERROR' } },
        'oap-sdk/src/errors/OAPError': Error,
        'oap-sdk/src/logging/logging': { getLogger: () => logger, logMarker() {} },
        'lodash/defaults': (o, d) => { Object.keys(d).forEach((k) => { if (o[k] === undefined) o[k] = d[k]; }); return o; },
        './StartableCouncil': { NOT_CORRUPTED: 'NOT_CORRUPTED' }
    };
    const registry = {};
    Object.keys(apps).forEach((id) => {
        registry[id] = {
            getAppId: () => id, getSettings: () => ({ version: '1.0.0' }), getUserId: () => Promise.resolve(id),
            unregisterAllParticipantIds: () => Promise.resolve(), isHeadUnitShuttingDown: () => state.shuttingDown,
            council: {}, updateStartableCouncil(k, v) { this.council[k] = v; },
            isStartable() { return Object.keys(this.council).every((k) => this.council[k]); },
            getLastStartArguments: () => [], on() {},
            start: (args) => { events.push(['start', id]); return apps[id].start(args); },
            disableAllEntryPoints: () => log('disable')(id)
        };
    });
    const module = { exports: null };
    vm.runInNewContext(source, { require: (name) => {
        assert.ok(name in modules, 'module requires ' + name);
        return modules[name];
    }, module, Date: { now: () => clock.now }, Promise, Object, Array, JSON, String });
    const Handler = module.exports;
    const handler = new Handler({
        backendTransport: { reportCorruptApp: log('report') },
        appFolderControl: { removeAppPersonalDataFolder: log('wipe'), removeAppDataFolder: log('wipe'),
            removeAppShareFolder: log('wipe'), removeAppKeyValueStorageFolder: log('wipe'),
            createAppDataFolder: log('create'), initializeAppSharedFolders: log('create'),
            createAppKeyValueStorageFolder: log('create') },
        getVin: () => Promise.resolve('VIN'),
        appManager: { uninstall: log('uninstall'), install: log('install') },
        appRegistry: { getAll: () => Object.keys(registry).map((id) => registry[id]), on() {},
            getById: (id) => registry[id] },
        appsRuntimeController: { updateEntryPointStartArguments: (id, args) => args }
    });
    const crash = (id) => handler._handleAppTerminated(registry[id]);
    const kinds = (id) => events.filter((e) => e[1] === id).map((e) => e[0]);
    return { events, clock, state, crash, kinds, registry, handler };
}

/* n crashes of appId, one after the other. */
function crashes(h, id, n) {
    let p = Promise.resolve();
    for (let i = 0; i < n; i += 1) {
        p = p.then(() => h.crash(id));
    }
    return p;
}

test('reference firmware: a local-only app is only restarted, a stock app keeps its recovery', () => {
    const root = firmwareDir();
    if (!root) {
        return 'skipped: decoded oap-mainapp not available';
    }
    const ok = () => Promise.resolve();
    const h = crashHandler(root, { ours: { start: ok }, stock: { start: ok } }, ['ours']);
    return crashes(h, 'ours', 5).then(() => crashes(h, 'stock', 4)).then(() => {
        assert.deepStrictEqual(h.kinds('ours'), ['start', 'start', 'start', 'start', 'start']);
        assert.strictEqual(h.registry.ours.isStartable(), true);
        const stock = h.kinds('stock');
        assert.deepStrictEqual(stock.filter((k) => k !== 'wipe' && k !== 'create'), [
            'analytics', 'start', 'analytics', 'start', 'analytics', 'uninstall', 'install', 'start',
            'analytics', 'disable', 'report']);
        assert.strictEqual(stock.filter((k) => k === 'wipe').length, 8);
        assert.strictEqual(h.registry.stock.isStartable(), false);
        // A sixth crash within ten minutes leaves it stopped, still startable.
        return h.crash('ours');
    }).then(() => {
        assert.strictEqual(h.kinds('ours').filter((k) => k === 'start').length, 5);
        assert.deepStrictEqual(h.events.filter((e) => e[0] === 'warn').map((e) => e[2]), [
            'CorruptAppsHandler::_tryRecoverApp ours is local-only and was restarted 5 times in 10 minutes; ' +
            'left stopped until it is started again.']);
        assert.strictEqual(h.registry.ours.isStartable(), true);
        // Ten minutes after the first restart, a crash is restarted again.
        h.clock.now += 10 * 60 * 1000;
        return h.crash('ours');
    }).then(() => {
        assert.strictEqual(h.kinds('ours').filter((k) => k === 'start').length, 6);
        assert.deepStrictEqual(h.kinds('ours').filter((k) => k !== 'start' && k !== 'warn'), []);
    });
});

test('reference firmware: a local-only app whose restart fails is tried 5 times', () => {
    const root = firmwareDir();
    if (!root) {
        return 'skipped: decoded oap-mainapp not available';
    }
    const h = crashHandler(root, { ours: { start: () => Promise.reject(new Error('no start')) } }, ['ours']);
    return h.crash('ours').then(() => {
        assert.deepStrictEqual(h.kinds('ours'), ['start', 'start', 'start', 'start', 'start', 'warn']);
        assert.strictEqual(h.registry.ours.isStartable(), true);
    });
});

test('reference firmware: a local-only app stays so through a failed read, and shutdown deaths do not count', () => {
    const root = firmwareDir();
    if (!root) {
        return 'skipped: decoded oap-mainapp not available';
    }
    const ok = () => Promise.resolve();
    const h = crashHandler(root, { ours: { start: ok } }, ['ours']);
    const starts = () => h.kinds('ours').filter((k) => k === 'start').length;
    return h.crash('ours').then(() => {
        assert.strictEqual(h.handler.getRecoveryAttempt('ours'), 0);
        h.state.unreadable = true;
        return crashes(h, 'ours', 2);
    }).then(() => {
        assert.strictEqual(starts(), 3);
        h.state.unreadable = false;
        h.state.shuttingDown = true;
        return crashes(h, 'ours', 4);
    }).then(() => {
        assert.strictEqual(starts(), 3);
        h.state.shuttingDown = false;
        return crashes(h, 'ours', 3);
    }).then(() => {
        assert.strictEqual(starts(), 5);
        assert.deepStrictEqual(h.kinds('ours').filter((k) => k !== 'start'), ['warn']);
    });
});

/* MainApp-21's CorruptAppsHandler module (its browserify module, patched),
 * run against fake collaborators as crashHandler runs iDrive 7's. A crash
 * goes the way AppLauncher reports one: the app is held unstartable
 * (NOT_IN_CORRUPT_APPS_HANDLING false), then terminated reaches the
 * handler. The forced update ('update') and the 48 h reset timer are
 * recorded, not waited for. */
function crashHandler21(root, apps, localOnly) {
    const stock = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const release = patcher.UNITS.ID8.mainapps.filter((m) => patcher.classify(stock, m.sets.current.main) === 'unpatched')[0];
    const main = patcher.applyPatches(stock, (release ? release.sets.current : patcher.PATCH_SETS_21).main);
    const at = main.indexOf('let CorruptAppsHandler=class');
    const start = main.lastIndexOf('function(require,module,exports){', at) + 'function(require,module,exports){'.length;
    const source = main.slice(start, main.indexOf('\n},{', at));
    const events = [];
    const clock = { now: 1e12 };
    const state = { unreadable: false, shuttingDown: false };
    const log = (kind) => (id) => { events.push([kind, id]); return Promise.resolve(); };
    const fakeFs = { readFileSync: (file) => {
        if (file === patcher.OVERRIDE_FILE && !state.unreadable) {
            return JSON.stringify(localOnly);
        }
        const e = new Error('ENOENT: ' + file);
        e.code = 'ENOENT';
        throw e;
    }, readdirSync: () => [] };
    const logger = { info() {}, debug() {}, error() {}, warn(m) { events.push(['warn', m.split(' ')[1], m]); } };
    const decorator = () => () => undefined;
    const modules = {
        events: require('events'),
        util: require('util'),
        fs: fakeFs,
        inversify: { inject: decorator, injectable: decorator, named: decorator },
        'lodash/defaults': (o, d) => { Object.keys(d).forEach((k) => { if (o[k] === undefined) o[k] = d[k]; }); return o; },
        'lodash/forIn': (o, f) => Object.keys(o).forEach((k) => f(o[k], k)),
        'oap-sdk/src/analytics/AnalyticsServiceBuilders': { buildAnalyticsService: () => ({
            sendPlatformEvent: (e) => events.push(['analytics', e.payload.appName]) }) },
        'oap-sdk/src/analytics/interface/analyticsservice': {
            AnalyticsPlatformEventType: { APP_CRASH: 'APP_CRASH' }, AnalyticsPlatformLogLevel: { ERROR: 'ERROR' } },
        'oap-sdk/src/config/config': { get: (k) => (k === 'corruptAppsHandler.waitForAppStartable' ? 0 : 172800000) },
        'oap-sdk/src/errors/OAPError': Error,
        'oap-sdk/src/internal/StartReason': { CONFIG_STATE: 'CONFIG_STATE' },
        'oap-sdk/src/logging/logging': { getLogger: () => logger, logMarker() {} },
        'oap-sdk/src/utils/getVin': () => Promise.resolve('VIN'),
        semver: { gt: () => false },
        './AppFolderControl': {}, './AppManagementController': {}, './AppRegistry': {},
        './AppRuntime/AppStartQueue': {}, './AppRuntime/AppsRuntimeController': {}, './BackendTransport': {},
        './StartableCouncil': { NOT_CORRUPTED: 'NOT_CORRUPTED', NOT_IN_CORRUPT_APPS_HANDLING: 'NOT_IN_CORRUPT_APPS_HANDLING' },
        './event/EventBroker': { EventBroker: {} },
        './inversify/types': { TYPES: {}, NAMES: {} }
    };
    const registry = {};
    Object.keys(apps).forEach((id) => {
        registry[id] = {
            getAppId: () => id, getSettings: () => ({ version: '1.0.0' }), getUserId: () => Promise.resolve(id),
            unregisterAllParticipantIds: () => Promise.resolve(), isHeadUnitShuttingDown: () => state.shuttingDown,
            council: {}, updateStartableCouncil(k, v) { this.council[k] = v; },
            isStartable() { return Object.keys(this.council).every((k) => this.council[k]); },
            getLastStartArguments: () => [], getStartReason: () => 'AUTOSTART', getUpdateMechanism: () => 'PLATFORM',
            getAppVariant: () => undefined, on() {}, addListener() {}, removeListener() {},
            disableAllEntryPoints: () => log('disable')(id),
            // 9.2.15 restarts the app itself, 9.3.4 through the start queue
            start: () => { events.push(['start', id]); return apps[id].start(); }, stop: () => Promise.resolve(),
            appControl: { appEvents: { restoreEntryPoints: { next: () => events.push(['restore', id]) } } }
        };
    });
    const module = { exports: {} };
    const sandbox = { require: (name) => {
        assert.ok(name in modules, 'module requires ' + name);
        return modules[name];
    }, module, exports: module.exports, Date: { now: () => clock.now }, Promise, Object, Array, JSON, String,
    Reflect: {}, console,
    setTimeout: (fn, ms) => (ms > 60000 ? (events.push(['timer', ms]), 0) : setTimeout(fn, ms)), clearTimeout() {} };
    vm.runInNewContext('(function(){' + source + '\n}).call(this)', sandbox);
    const Handler = module.exports;
    const handler = new Handler();
    Object.assign(handler, {
        backendTransport: { reportCorruptApp: log('report') },
        appFolderControl: { removeAppPersonalDataFolder: log('wipe'), removeAppDataFolder: log('wipe'),
            removeAppShareFolder: log('wipe'), removeAppKeyValueStorageFolder: log('wipe'),
            createAppDataFolder: log('create'), initializeAppSharedFolders: log('create'),
            createAppKeyValueStorageFolder: log('create') },
        appManager: { update: log('update') },
        appRegistry: { getAll: () => Object.keys(registry).map((id) => registry[id]), on() {},
            getById: (id) => registry[id] },
        appsRuntimeController: { updateEntryPointStartArguments: (id, args) => args },
        appStartQueue: { queuedAppStart: (app) => { events.push(['start', app.getAppId()]);
            return apps[app.getAppId()].start(); } },
        provisioningBroker: { callMethod: () => ({ app_management: {} }) },
        initTimeout: 10000
    });
    const crash = (id) => {
        registry[id].updateStartableCouncil('NOT_IN_CORRUPT_APPS_HANDLING', false);
        return handler.handleAppTerminated(registry[id]);
    };
    const kinds = (id) => events.filter((e) => e[1] === id).map((e) => e[0]);
    return { events, clock, state, crash, kinds, registry, handler, mainapp: release ? release.version : null };
}

function firmware21Dir() {
    const dir = process.env.FIRMWARE_MAINAPP21_DIR;
    return dir && fs.existsSync(path.join(dir, 'src', 'main.js')) ? dir : undefined;
}

test('on iDrive 8 MainApp-21 is never to be bounced: nextStart instead of changed and restartNeeded', () => {
    const dir = tmpdir();
    try {
        const paths = {};
        Object.keys(patcher.PATCH_SETS_21).forEach((kind) => {
            paths[kind] = path.join(dir, kind + '.js');
            fs.writeFileSync(paths[kind], syntheticBundle(patcher.PATCH_SETS_21[kind]));
        });
        const running = fakeProc(dir, 60, MAINAPP21_EMU);
        let r = patcher.run('apply', paths, quiet, running, null, 'ID8');
        assert.strictEqual(r.code, 0);
        assert.strictEqual(r.written, true);
        assert.strictEqual(fs.readFileSync(paths.main, 'utf8').indexOf('function isLocalOnlyApp(') >= 0, true);
        assert.deepStrictEqual([r.result.changed, r.result.restartNeeded, r.result.nextStart], [false, false, true]);
        r = patcher.run('check', paths, quiet, running, null, 'ID8');
        assert.deepStrictEqual([r.result.restartNeeded, r.result.nextStart], [false, true]);
        r = patcher.run('revert', paths, quiet, running, null, 'ID8');
        assert.deepStrictEqual([r.written, r.result.changed, r.result.nextStart], [true, false, true]);
        assert.strictEqual(patcher.run('apply', paths, quiet, path.join(dir, 'none'), null, 'ID8').result.nextStart, false);
    } finally {
        rmrf(dir);
    }
});

test('MainApp-21: a local-only app is only restarted, a stock app keeps its recovery', () => {
    const root = firmware21Dir();
    if (!root) {
        return 'skipped: decoded MainApp-21 not available';
    }
    const ok = () => Promise.resolve();
    const h = crashHandler21(root, { ours: { start: ok }, stock: { start: ok } }, ['ours']);
    return crashes(h, 'ours', 5).then(() => crashes(h, 'stock', 4)).then(() => {
        assert.deepStrictEqual(h.kinds('ours'), ['start', 'start', 'start', 'start', 'start']);
        assert.strictEqual(h.registry.ours.isStartable(), true);
        assert.strictEqual(h.handler.getRecoveryAttempt('ours'), 0);
        // the stock ladder: restart; forced update (its second rung refuses); data wipe; disable and report
        const stock = h.kinds('stock');
        assert.deepStrictEqual(stock.filter((k) => k !== 'wipe' && k !== 'create'), [
            'analytics', 'start', 'analytics', 'analytics', 'update', 'start', 'analytics', 'start',
            'analytics', 'disable', 'report']);
        // 9.2.15 wipes the data again when it gives the app up
        assert.strictEqual(stock.filter((k) => k === 'wipe').length, h.mainapp === '9.2.15' ? 8 : 4);
        assert.strictEqual(h.registry.stock.isStartable(), false);
        return h.crash('ours');
    }).then(() => {
        assert.strictEqual(h.kinds('ours').filter((k) => k === 'start').length, 5);
        assert.deepStrictEqual(h.events.filter((e) => e[0] === 'warn').map((e) => e[2]), [
            'CorruptAppsHandler::tryRecoverApp ours is local-only and was restarted 5 times in 10 minutes; ' +
            'left stopped until it is started again.']);
        assert.strictEqual(h.registry.ours.isStartable(), true);
        // The 48 h reset rehabilitates the stock app; the local-only window stays.
        h.handler.resetRecoveryAttemptsSinceCorruption();
        return new Promise((resolve) => setTimeout(resolve, 10));
    }).then(() => {
        // 9.2.15's reset leaves a given-up stock app as it is
        if (h.mainapp !== '9.2.15') {
            assert.strictEqual(h.registry.stock.isStartable(), true);
            assert.deepStrictEqual(h.kinds('stock').slice(-1), ['restore']);
        }
        return h.crash('ours');
    }).then(() => {
        assert.strictEqual(h.kinds('ours').filter((k) => k === 'start').length, 5);
        h.clock.now += 10 * 60 * 1000;
        return h.crash('ours');
    }).then(() => {
        assert.strictEqual(h.kinds('ours').filter((k) => k === 'start').length, 6);
        assert.deepStrictEqual(h.kinds('ours').filter((k) => k !== 'start' && k !== 'warn'), []);
    });
});

test('MainApp-21: a local-only app whose restart fails is tried 5 times', () => {
    const root = firmware21Dir();
    if (!root) {
        return 'skipped: decoded MainApp-21 not available';
    }
    const h = crashHandler21(root, { ours: { start: () => Promise.reject(new Error('no start')) } }, ['ours']);
    return h.crash('ours').then(() => {
        assert.deepStrictEqual(h.kinds('ours'), ['start', 'start', 'start', 'start', 'start', 'warn']);
        assert.strictEqual(h.registry.ours.isStartable(), true);
    });
});

test('MainApp-21: a local-only app stays so through a failed read, and shutdown deaths do not count', () => {
    const root = firmware21Dir();
    if (!root) {
        return 'skipped: decoded MainApp-21 not available';
    }
    const ok = () => Promise.resolve();
    const h = crashHandler21(root, { ours: { start: ok } }, ['ours']);
    const starts = () => h.kinds('ours').filter((k) => k === 'start').length;
    return h.crash('ours').then(() => {
        h.state.unreadable = true;
        return crashes(h, 'ours', 2);
    }).then(() => {
        assert.strictEqual(starts(), 3);
        h.state.unreadable = false;
        h.state.shuttingDown = true;
        return crashes(h, 'ours', 4);
    }).then(() => {
        assert.strictEqual(starts(), 3);
        h.state.shuttingDown = false;
        return crashes(h, 'ours', 3);
    }).then(() => {
        assert.strictEqual(starts(), 5);
        assert.deepStrictEqual(h.kinds('ours').filter((k) => k !== 'start'), ['warn']);
    });
});

/* Every browserify module that calls the predicate defines it once. */
function helperPerModule(text) {
    text.split(/\],\d+:\[function\(require,module,exports\)\{/).forEach((m, i) => {
        if (m.indexOf('isLocalOnlyApp(') >= 0) {
            assert.strictEqual(m.split('function isLocalOnlyApp(').length - 1, 1, 'module ' + i + ' has no single helper');
        }
    });
}

test('MainApp-21 reference bundles patch, parse and revert exactly', () => {
    const root = process.env.FIRMWARE_MAINAPP21_DIR;
    if (!root || !fs.existsSync(path.join(root, 'src', 'main.js'))) {
        return 'skipped: decoded MainApp-21 not available';
    }
    const dir = tmpdir();
    try {
        const paths = { main: path.join(dir, 'main.js'), appmanagement: path.join(dir, 'AppManagement.js') };
        const stock = {
            main: fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8'),
            appmanagement: fs.readFileSync(path.join(root, 'src', 'AppManagement', 'AppManagement.js'), 'utf8')
        };
        // FIRMWARE_MAINAPP21_DIR may hold any MainApp-21 release app-privacy knows
        const release = patcher.UNITS.ID8.mainapps.filter((m) => sha256(stock.main) === m.known.main)[0];
        assert.ok(release, 'MainApp-21 bundles of no known release');
        const expected = { '9.3.4': PATCHED_21_SHA256, '9.2.15': PATCHED_21_9_2_15_SHA256 }[release.version];
        Object.keys(paths).forEach((kind) => {
            fs.writeFileSync(paths[kind], stock[kind]);
            const patched = patcher.applyPatches(stock[kind], release.sets.current[kind]);
            assert.strictEqual(sha256(patched), expected[kind], kind + ': the edits differ from the released ones');
            helperPerModule(patched);
        });
        const args = ['--unit', 'ID8', '--main', paths.main, '--appmanagement', paths.appmanagement];
        let r = runTool(['check', '--json'].concat(args));
        assert.strictEqual(r.code, 1, r.stdout);
        assert.strictEqual(lastJson(r.stdout).mainapp, release.version);
        lastJson(r.stdout).files.forEach((f) => assert.strictEqual(f.reference, true));
        assert.strictEqual(runTool(['check'].concat(args.slice(2))).code, 2, 'iDrive 7\'s edits must not fit');
        r = runTool(['apply'].concat(args));
        assert.strictEqual(r.code, 0, r.stdout);
        Object.keys(paths).forEach((kind) => {
            const check = childProcess.spawnSync(process.execPath, ['--check', paths[kind]], { encoding: 'utf8' });
            assert.strictEqual(check.status, 0, check.stderr);
        });
        assert.strictEqual(runTool(['revert'].concat(args)).code, 0);
        Object.keys(paths).forEach((kind) => assert.strictEqual(fs.readFileSync(paths[kind], 'utf8'), stock[kind]));
    } finally {
        rmrf(dir);
    }
    return null;
});

test('MainApp 8.1.1 bundles patch, parse and revert exactly', () => {
    const root = process.env.FIRMWARE_MAINAPP_8_1_1_DIR;
    if (!root || !fs.existsSync(path.join(root, 'src', 'main.js'))) {
        return 'skipped: decoded oap-mainapp 8.1.1 not available';
    }
    const dir = tmpdir();
    try {
        const paths = { main: path.join(dir, 'main.js'), appmanagement: path.join(dir, 'AppManagement.js') };
        const stock = {
            main: fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8'),
            appmanagement: fs.readFileSync(path.join(root, 'src', 'AppManagement', 'AppManagement.js'), 'utf8')
        };
        Object.keys(paths).forEach((kind) => {
            fs.writeFileSync(paths[kind], stock[kind]);
            const patched = patcher.applyPatches(stock[kind], patcher.PATCH_SETS_8_1_1[kind]);
            assert.strictEqual(sha256(patched), PATCHED_8_1_1_SHA256[kind], kind + ': the edits differ from the released ones');
            helperPerModule(patched);
        });
        const args = ['--json', '--unit', 'ID7', '--main', paths.main, '--appmanagement', paths.appmanagement];
        let r = runTool(['check'].concat(args));
        assert.strictEqual(r.code, 1, r.stdout);
        assert.strictEqual(lastJson(r.stdout).mainapp, '8.1.1');
        lastJson(r.stdout).files.forEach((f) => assert.strictEqual(f.reference, true));
        r = runTool(['apply'].concat(args));
        assert.strictEqual(r.code, 0, r.stdout);
        Object.keys(paths).forEach((kind) => {
            const check = childProcess.spawnSync(process.execPath, ['--check', paths[kind]], { encoding: 'utf8' });
            assert.strictEqual(check.status, 0, check.stderr);
        });
        assert.strictEqual(runTool(['revert'].concat(args)).code, 0);
        Object.keys(paths).forEach((kind) => assert.strictEqual(fs.readFileSync(paths[kind], 'utf8'), stock[kind]));
    } finally {
        rmrf(dir);
    }
    return null;
});

let failed = 0;
tests.reduce((p, t) => p.then(() => t.fn()).then((note) => {
    console.log('ok   ' + t.name + (typeof note === 'string' ? ' (' + note + ')' : ''));
}, (e) => {
    failed += 1;
    console.log('FAIL ' + t.name + '\n     ' + (e.stack || e).toString().split('\n').join('\n     '));
}), Promise.resolve()).then(() => {
    console.log((tests.length - failed) + '/' + tests.length + ' passed');
    process.exitCode = failed ? 1 : 0;
});
