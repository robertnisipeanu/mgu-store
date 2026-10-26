#!/usr/bin/env node
'use strict';
/**
 * Stand-in for the deploy tool's on-unit script in the updater tests:
 *   fake_deploy.js install --artifact <file> --yes
 *   fake_deploy.js uninstall <id> --yes
 *   fake_deploy.js rollback <id> --yes
 *   fake_deploy.js status --json
 *   fake_deploy.js sdk-donor --json       { path: $FAKE_DONOR, module: $FAKE_SDK_MODULE }
 *   fake_deploy.js appmanager adopt --yes
 * $FAKE_DEPLOY_LOG.appmanager holds what status --json says of IterioDev's
 * App Manager (appmanager); adopt sets its record to the JSON in
 * $FAKE_DEPLOY_LOG.amrecord, and uninstall oap-appmanager marks it removed.
 * A tool artifact (component.json at the root) lands in
 * $TOOL_ROOT/<id>/versions/<version>/ with `current` switched by rename,
 * and only the new version and the one `current` pointed to before remain;
 * an app (package.json at the root or under package/, a source package's
 * mgu-app.json, an .mgu's meta.json) is recorded the way MainApp records
 * one: an $OAP_ROOT/oap_12201 registry entry naming its uid (one per app)
 * and that uid's source/package.json. Every call is logged
 * to $FAKE_DEPLOY_LOG; while $FAKE_DEPLOY_LOG.fail exists, install exits
 * with the status it holds, giving "test failure <status>" as its reason.
 * $FAKE_DEPLOY_LOG.pending lists ids (one per line) reported under
 * pending_reboot, whose service counts as not restarted;
 * while $FAKE_DEPLOY_LOG.rollbackfail exists, rollback exits 1.
 * status --json says the head unit is $FAKE_UNIT_HMI (ID7 without it) and
 * lists every installed tool with what it provides (component.json
 * mguProvides). A root-service package (package.json with mguService) is
 * installed as the tool of its name, providing its kind; providers of one
 * capability install side by side.
 * mgu-uplink stands for the internet: once its current version runs, the
 * lease at $FAKE_LEASE exists ($FAKE_LEASE.good copied) unless that
 * version's component.json says "test_broken": true.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const [cmd, , file] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DEPLOY_LOG, `${process.argv.slice(2).join(' ')}\n`);

function mkdirp(d) {
    if (!fs.existsSync(d)) {
        mkdirp(path.dirname(d));
        fs.mkdirSync(d);
    }
}

function pendingIds() {
    try {
        return fs.readFileSync(`${process.env.FAKE_DEPLOY_LOG}.pending`, 'utf8').split('\n').filter(Boolean);
    } catch (e) {
        return [];
    }
}

/* The internet as the running mgu-uplink version gives it. */
function uplinkRuns(root) {
    if (path.basename(root) !== 'mgu-uplink' || pendingIds().indexOf('mgu-uplink') >= 0 || !process.env.FAKE_LEASE) {
        return;
    }
    const c = JSON.parse(fs.readFileSync(path.join(root, 'current', 'component.json'), 'utf8'));
    if (c.test_broken) {
        try {
            fs.unlinkSync(process.env.FAKE_LEASE);
        } catch (e) { /* already offline */ }
    } else {
        fs.copyFileSync(`${process.env.FAKE_LEASE}.good`, process.env.FAKE_LEASE);
    }
}

function switchTo(root, version) {
    try {
        fs.unlinkSync(path.join(root, 'current.new'));
    } catch (e) { /* none */ }
    fs.symlinkSync(`versions/${version}`, path.join(root, 'current.new'));
    fs.renameSync(path.join(root, 'current.new'), path.join(root, 'current'));
}

if (cmd === 'rollback') {
    if (fs.existsSync(`${process.env.FAKE_DEPLOY_LOG}.rollbackfail`)) {
        process.exit(1);
    }
    const root = path.join(process.env.TOOL_ROOT, process.argv[3]);
    const now = path.basename(fs.readlinkSync(path.join(root, 'current')));
    const other = fs.readdirSync(path.join(root, 'versions')).find((v) => v !== now);
    if (!other) {
        process.exit(1);
    }
    switchTo(root, other);
    uplinkRuns(root);
    console.log(`${path.basename(root)} back to ${other}`);
    process.exit(0);
}
const AM_FILE = `${process.env.FAKE_DEPLOY_LOG}.appmanager`;
const readAm = () => (fs.existsSync(AM_FILE) ? JSON.parse(fs.readFileSync(AM_FILE, 'utf8')) : null);
if (cmd === 'appmanager') {
    const am = readAm();
    if (process.argv[3] !== 'adopt' || !am || !am.present) {
        process.stderr.write('mgu-deploy: IterioDev\'s App Manager is not on this head unit\n');
        process.exit(2);
    }
    am.record = JSON.parse(fs.readFileSync(`${process.env.FAKE_DEPLOY_LOG}.amrecord`, 'utf8'));
    am.daemon = 'inactive';
    fs.writeFileSync(AM_FILE, JSON.stringify(am));
    console.log('adopted');
    process.exit(0);
}
if (cmd === 'sdk-donor') {
    if (!process.env.FAKE_DONOR) {
        process.stderr.write('mgu-deploy: no donor bundle on this unit\n');
        process.exit(1);
    }
    console.log(JSON.stringify(Object.assign({ path: process.env.FAKE_DONOR },
        process.env.FAKE_SDK_MODULE ? { module: process.env.FAKE_SDK_MODULE } : {})));
    process.exit(0);
}
if (cmd === 'uninstall') {
    const id = process.argv[3];
    const am = readAm();
    if (id === 'oap-appmanager' && am && am.present) {
        fs.writeFileSync(AM_FILE, JSON.stringify(Object.assign(am, { present: false, record: Object.assign(am.record || {}, { removed: 'now' }) })));
    }
    if (fs.existsSync(`${process.env.FAKE_DEPLOY_LOG}.fail`)) {
        process.stderr.write('mgu-deploy: test failure\n');
        process.exit(1);
    }
    const reg = path.join(process.env.OAP_ROOT, 'oap_12201', 'data', 'apps', `${id}.json`);
    if (fs.existsSync(reg)) {
        const uid = JSON.parse(fs.readFileSync(reg, 'utf8')).userId;
        fs.unlinkSync(reg);
        cp.execFileSync('rm', ['-rf', path.join(process.env.OAP_ROOT, `oap_${uid}`, 'source')]);
    } else {
        cp.execFileSync('rm', ['-rf', path.join(process.env.TOOL_ROOT, id)]);
    }
    console.log(`${id} removed`);
    process.exit(0);
}
function tools() {
    const root = process.env.TOOL_ROOT;
    return (fs.existsSync(root) ? fs.readdirSync(root) : []).map((id) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(root, id, 'current', 'component.json'), 'utf8'));
        } catch (e) {
            return null;
        }
    }).filter((c) => c && c.id);
}
if (cmd === 'status') {
    const pending = (process.env.FAKE_PENDING || '').split(',').filter(Boolean).concat(pendingIds());
    console.log(JSON.stringify({ unit: { hmi: process.env.FAKE_UNIT_HMI || 'ID7', firmware: 'test firmware' },
        components: tools().map((c) => ({ id: c.id, kind: 'tool', version: c.version, provides: c.mguProvides || null })),
        pending_reboot: pending.map((id) => ({ id, reason: 'test' })), appmanager: readAm() }));
    process.exit(0);
}
if (fs.existsSync(`${process.env.FAKE_DEPLOY_LOG}.fail`)) {
    const status = Number(fs.readFileSync(`${process.env.FAKE_DEPLOY_LOG}.fail`, 'utf8'));
    process.stderr.write(`mgu-deploy: test failure ${status}\n`);
    process.exit(status);
}
const tmp = fs.mkdtempSync('/tmp/fake-deploy-');
cp.execFileSync('tar', ['-xzf', file, '-C', tmp]);
const svc = (() => {
    try {
        const p = JSON.parse(fs.readFileSync(path.join(tmp, 'package', 'package.json'), 'utf8'));
        return p.mguService ? p : null;
    } catch (e) {
        return null;
    }
})();
if (svc) {
    mkdirp(path.join(tmp, 'files'));
    fs.writeFileSync(path.join(tmp, 'component.json'), JSON.stringify({ id: svc.name, kind: 'tool', version: svc.version, mguProvides: svc.mguService }));
}
if (fs.existsSync(path.join(tmp, 'component.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(tmp, 'component.json'), 'utf8'));
    const root = path.join(process.env.TOOL_ROOT, c.id);
    const dest = path.join(root, 'versions', c.version);
    mkdirp(dest);
    cp.execFileSync('cp', ['-a', `${path.join(tmp, 'files')}/.`, dest]);
    fs.copyFileSync(path.join(tmp, 'component.json'), path.join(dest, 'component.json'));
    let before = null;
    try {
        before = path.basename(fs.readlinkSync(path.join(root, 'current')));
    } catch (e) { /* first install */ }
    switchTo(root, c.version);
    fs.readdirSync(path.join(root, 'versions')).filter((v) => v !== c.version && v !== before)
        .forEach((v) => cp.execFileSync('rm', ['-rf', path.join(root, 'versions', v)]));
    uplinkRuns(root);
    console.log(`${c.id} ${c.version} installed`);
} else {
    const read = (p) => JSON.parse(fs.readFileSync(path.join(tmp, p), 'utf8'));
    const own = ['package.json', 'package/package.json', 'mgu-app.json', 'meta.json'].find((p) => fs.existsSync(path.join(tmp, p)));
    const m = read(own);
    const pkg = Object.assign({}, m, { name: m.name || m.id, version: m.version, built: own === 'mgu-app.json', from: own });
    const oap = process.env.OAP_ROOT;
    const apps = path.join(oap, 'oap_12201', 'data', 'apps');
    mkdirp(apps);
    const reg = path.join(apps, `${pkg.name}.json`);
    const uid = fs.existsSync(reg) ? JSON.parse(fs.readFileSync(reg, 'utf8')).userId : 13000 + fs.readdirSync(apps).length;
    mkdirp(path.join(oap, `oap_${uid}`, 'source'));
    fs.writeFileSync(reg, JSON.stringify({ userId: uid }));
    fs.writeFileSync(path.join(oap, `oap_${uid}`, 'source', 'package.json'), JSON.stringify(pkg));
    // MainApp's layout of the app's RHMI: rhmiData/ in its home, its texts as strings/<language>.json
    const rhmi = ['rhmiData', 'package/rhmiData', 'source/rhmiData'].map((d) => path.join(tmp, d))
        .find((d) => fs.existsSync(path.join(d, 'application.json')));
    if (rhmi) {
        const home = path.join(oap, `oap_${uid}`, 'rhmiData');
        mkdirp(path.join(home, 'strings'));
        fs.copyFileSync(path.join(rhmi, 'application.json'), path.join(home, 'application.json'));
        const texts = path.join(rhmi, 'variantGroups', 'Common', 'texts', 'en_GB.json');
        if (fs.existsSync(texts)) {
            fs.copyFileSync(texts, path.join(home, 'strings', 'en_GB.json'));
        }
    }
    console.log(`${pkg.name} ${pkg.version} installed`);
}
