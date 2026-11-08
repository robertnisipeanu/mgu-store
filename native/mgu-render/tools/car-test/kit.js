#!/usr/bin/env node
'use strict';
/*
 * install-test.sh's JSON work, on the Mac.
 *
 *   node kit.js versions <status.json>                       the tracked components' versions
 *   node kit.js plan <repo> <status.json> <catalog.json>     what install puts on the unit (JSON);
 *                                                            exit 2 with the reason when it must not
 *   node kit.js verify <before-status.json> <after-status.json>
 *                                                            exit 1 when a tracked version differs
 */
const fs = require('fs');
const path = require('path');

const TRACKED = ['mgu-deploy', 'mgu-render', 'robertn_store'];

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function cmp(a, b) {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
    }
    return 0;
}
function installed(status) {
    const out = {};
    (status.components || []).forEach((c) => { out[c.id] = c.version; });
    return out;
}
function refuse(why) {
    console.error(why);
    process.exit(2);
}

function versions(statusFile) {
    const s = readJson(statusFile), v = installed(s);
    TRACKED.forEach((id) => console.log(`${id} ${v[id] || '-'}`));
    (s.pending_reboot || []).forEach((p) => console.log(`pending ${p.id}: ${p.reason}`));
}

function plan(repo, statusFile, catalogFile) {
    let status;
    try {
        status = readJson(statusFile);
    } catch (e) {
        refuse(`the unit's status could not be read (${e.message}); nothing is installed`);
    }
    const have = installed(status);
    TRACKED.forEach((id) => {
        if (!have[id]) refuse(`${id} is not installed on the unit; the test needs the published ${id} in place to restore it`);
    });
    const catalog = readJson(catalogFile);
    const published = {};
    (catalog.components || []).forEach((c) => { published[c.id] = c; });
    ['mgu-render', 'robertn_store'].forEach((id) => {
        if (!published[id]) refuse(`${id} is not in the published catalog`);
        if (published[id].version !== have[id]) {
            refuse(`the unit has ${id} ${have[id]}, the published one is ${published[id].version}: update it ` +
                'from the Store first, so that restore puts back exactly what is installed');
        }
    });
    const comps = require(path.join(repo, 'release', 'release.js')).components(repo);
    const branch = {};
    comps.forEach((c) => { branch[c.id] = c; });
    // what this branch has newer than the unit; the same version stays as it is
    const ids = [];
    const notes = [];
    ['mgu-render', 'robertn_store'].forEach((id) => {
        const c = cmp(branch[id].version, have[id]);
        if (c > 0) ids.push(id);
        else if (c === 0) notes.push(`${id} ${branch[id].version} on this branch is the installed version: it stays as it is`);
        else refuse(`this branch has ${id} ${branch[id].version}, older than the installed ${have[id]}`);
    });
    if (!ids.length) refuse('this branch has nothing newer than the unit has; nothing is installed');
    // each requirement met by the unit, or by a component this install brings
    ids.forEach((id) => {
        const req = branch[id].requires || {};
        Object.keys(req).forEach((r) => {
            // the next release of a component this install does not bring is not on the unit yet
            if (req[r] === 'next' && ids.indexOf(r) < 0) {
                refuse(`${id} ${branch[id].version} requires the next release of ${r}; test in the emulator`);
            }
            const by = ids.indexOf(r) >= 0 ? branch[r].version : have[r];
            if (!by || cmp(by, req[r]) < 0) {
                refuse(`${id} ${branch[id].version} requires ${r} ${req[r]}; the unit has ${have[r] || 'none'}. ` +
                    'Install that through the Store first, or test in the emulator');
            }
        });
    });
    const out = {
        install: ids.map((id) => ({ id, version: branch[id].version, artifact: `${id}@${branch[id].version}.tgz` })),
        restore: ids.map((id) => ({ id, version: published[id].version, artifact: published[id].artifact.name,
            sha256: published[id].artifact.sha256 })),
        before: have,
        notes
    };
    console.log(JSON.stringify(out, null, 2));
}

function verify(beforeFile, afterFile) {
    const b = installed(readJson(beforeFile)), a = installed(readJson(afterFile));
    let ok = true;
    TRACKED.forEach((id) => {
        const same = b[id] === a[id];
        ok = ok && same;
        console.log(`${same ? 'same    ' : 'DIFFERS '} ${id}: before ${b[id] || '-'}, now ${a[id] || '-'}`);
    });
    process.exit(ok ? 0 : 1);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'versions' && args.length === 1) versions(args[0]);
else if (cmd === 'plan' && args.length === 3) plan(args[0], args[1], args[2]);
else if (cmd === 'verify' && args.length === 2) verify(args[0], args[1]);
else {
    console.error('usage: node kit.js versions <status.json> | plan <repo> <status.json> <catalog.json> | verify <before> <after>');
    process.exit(2);
}
