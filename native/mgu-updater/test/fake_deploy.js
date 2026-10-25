#!/usr/bin/env node
'use strict';
/**
 * Stand-in for the deploy tool's on-unit script in the updater tests:
 *   fake_deploy.js install --artifact <file.tgz> --yes
 *   fake_deploy.js rollback <id> --yes
 *   fake_deploy.js status --json
 * A tool artifact (component.json at the root) lands in
 * $TOOL_ROOT/<id>/versions/<version>/ with `current` switched by rename,
 * and only the new version and the one `current` pointed to before remain;
 * an app is recorded the way MainApp records one ($OAP_ROOT/oap_12201
 * registry entry plus the app's source/package.json). Every call is logged
 * to $FAKE_DEPLOY_LOG; while $FAKE_DEPLOY_LOG.fail exists, install exits
 * with the status it holds, giving "test failure <status>" as its reason.
 * $FAKE_DEPLOY_LOG.pending lists ids (one per line) reported under
 * pending_reboot, whose service counts as not restarted;
 * while $FAKE_DEPLOY_LOG.rollbackfail exists, rollback exits 1.
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
if (cmd === 'status') {
    const pending = (process.env.FAKE_PENDING || '').split(',').filter(Boolean).concat(pendingIds());
    console.log(JSON.stringify({ components: [], pending_reboot: pending.map((id) => ({ id, reason: 'test' })) }));
    process.exit(0);
}
if (fs.existsSync(`${process.env.FAKE_DEPLOY_LOG}.fail`)) {
    const status = Number(fs.readFileSync(`${process.env.FAKE_DEPLOY_LOG}.fail`, 'utf8'));
    process.stderr.write(`mgu-deploy: test failure ${status}\n`);
    process.exit(status);
}
const tmp = fs.mkdtempSync('/tmp/fake-deploy-');
cp.execFileSync('tar', ['-xzf', file, '-C', tmp]);
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
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    const oap = process.env.OAP_ROOT;
    mkdirp(path.join(oap, 'oap_12201', 'data', 'apps'));
    mkdirp(path.join(oap, 'oap_13000', 'source'));
    fs.writeFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${pkg.name}.json`), JSON.stringify({ userId: 13000 }));
    fs.copyFileSync(path.join(tmp, 'package.json'), path.join(oap, 'oap_13000', 'source', 'package.json'));
    console.log(`${pkg.name} ${pkg.version} installed`);
}
