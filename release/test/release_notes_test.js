'use strict';
// Optional notes survive stamping and catalog publication; invalid history
// cannot silently disappear from a maintainer's release.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const release = require('../release.js');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-release-notes-'));
const repo = path.join(temp, 'repo');
process.env.MGU_RELEASE_LABELS = 'off';
try {
    cp.execFileSync('git', ['clone', '-q', '--shared', root, repo]);
    const file = path.join(repo, 'release/notes.json');
    const original = release.components(repo);
    const updater = original.find((c) => c.id === 'mgu-updater');
    const notes = {
        'mgu-updater': [{ version: 'next', changes: ['Read concise release notes before updating.'] },
            { version: updater.version, changes: ['Keep existing update behavior.'] }]
    };
    fs.writeFileSync(file, JSON.stringify(notes));
    const all = release.components(repo);
    const steps = release.plan(all, ['mgu-updater', 'robertn_store'], repo);
    release.writePlan(repo, steps);
    const stamped = JSON.parse(fs.readFileSync(file));
    const current = release.components(repo).find((c) => c.id === 'mgu-updater');
    assert.strictEqual(stamped['mgu-updater'][0].version, current.version);
    assert.deepStrictEqual(current.releaseNotes, stamped['mgu-updater']);
    const artifact = path.join(temp, 'example.tgz');
    fs.writeFileSync(artifact, 'fixture');
    assert.deepStrictEqual(release.catalogEntry(current, artifact).releaseNotes, current.releaseNotes);
    stamped['mgu-updater'][0].changes = ['x'.repeat(121)];
    fs.writeFileSync(file, JSON.stringify(stamped));
    assert.throws(() => release.components(repo), /notes/);
    fs.unlinkSync(file);
    assert(release.components(repo).every((c) => c.releaseNotes === undefined));
    console.log('release notes: stamping, catalog, invalid notes and absent notes pass');
} finally {
    cp.execFileSync('rm', ['-rf', temp]);
}
