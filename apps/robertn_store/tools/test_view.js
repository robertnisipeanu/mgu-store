'use strict';
/**
 * Offline check of the Store's texts (src/store_view.js) for every row
 * state mgu-updater reports. Node 8+.
 *
 *   node tools/test_view.js
 */
const assert = require('assert');
const { rowState, rowAction, groupState, statusLine } = require('../src/store_view.js');

const row = (o) => Object.assign({ id: 'doom', kind: 'app', title: 'DOOM', version: '1.0.1', installed: '1.0.0',
    status: 'update', queued: false, error: null, pendingReboot: false }, o);
const st = (o) => Object.assign({ online: true, busy: null, components: [],
    catalog: { checking: false, error: null, checkedAt: new Date(2026, 9, 21, 14, 2).getTime() } }, o);
const cases = [
    [rowState(row({}), null), 'Update 1.0.1'],
    [rowState(row({ status: 'available', installed: null }), null), 'Install 1.0.1'],
    [rowState(row({ status: 'installed', installed: '1.0.1' }), null), 'Installed 1.0.1'],
    [rowState(row({ status: 'newer', installed: '1.2.0' }), null), 'Installed 1.2.0'],
    [rowState(row({}), { id: 'doom', phase: 'download', progress: 512, total: 1024 }), '50%'],
    [rowState(row({}), { id: 'doom', phase: 'verify' }), 'Verifying'],
    [rowState(row({}), { id: 'doom', phase: 'install' }), 'Installing'],
    [rowState(row({ kind: 'tool' }), { id: 'doom', phase: 'check' }), 'Checking'],
    [rowState(row({ queued: true }), { id: 'other', phase: 'download' }), 'Waiting'],
    [rowState(row({ error: 'x' }), null), 'Failed, retry'],
    [rowState(row({ kind: 'tool', status: 'installed', pendingReboot: true }), null), 'Restart pending'],
    [rowState(row({ kind: 'tool', status: 'update', pendingReboot: true }), null), 'Update 1.0.1'],
    [rowAction(row({}), null), 'install'],
    [rowAction(row({ status: 'available' }), null), 'install'],
    [rowAction(row({ status: 'installed' }), null), null],
    [rowAction(row({ status: 'installed', error: 'x' }), null), 'install'],
    [rowAction(row({}), { id: 'doom', phase: 'download' }), null],
    [rowAction(row({ queued: true }), null), null],
    [groupState([row({}), row({ id: 'vc', status: 'update' })], null), '2 updates'],
    [groupState([row({}), row({ id: 'vc', status: 'installed' })], null), '1 update'],
    [groupState([row({ status: 'installed' }), row({ id: 'vc', status: 'available' })], null), ''],
    [groupState([row({}), row({ id: 'vc', error: 'x' })], null), 'Failed'],
    [groupState([row({}), row({ id: 'vc' })], { id: 'vc', phase: 'download', progress: 1, total: 4 }), '25%'],
    [groupState([row({})], { id: 'other', phase: 'install' }), '1 update'],
    [groupState([], null), ''],
    [statusLine(null, false), 'Updater not running'],
    [statusLine(st({ components: [row({})] }), true), '1 update, checked 14:02'],
    [statusLine(st({ components: [row({ status: 'installed' })] }), true), 'Up to date, checked 14:02'],
    [statusLine(st({ online: false }), true), 'Offline, checked 14:02'],
    [statusLine(st({ catalog: { checking: true } }), true), 'Checking for updates'],
    [statusLine(st({ components: [row({ error: 'download does not match the catalog (size or sha256)' })] }), true),
        'DOOM: download does not match the catalog (size or sha256)'],
    [statusLine(st({ busy: { id: 'doom', phase: 'install' }, components: [row({})] }), true), '1 update, checked 14:02'],
    [statusLine(st({ privacy: 'mismatch', components: [row({})] }), true), 'App privacy patch not in effect'],
    [statusLine(st({ privacy: 'restart-needed', components: [row({})] }), true), 'App privacy patch not in effect'],
    [statusLine(st({ privacy: 'unknown', components: [row({})] }), true), 'App privacy patch not in effect'],
    [statusLine(st({ privacy: 'patched', components: [row({})] }), true), '1 update, checked 14:02'],
    [statusLine(st({ rebooting: true, components: [row({ error: 'x' })] }), true), 'Restarting'],
    [statusLine(st({ rebootError: 'the head unit did not restart', components: [row({})] }), true),
        'Restart failed: the head unit did not restart']
];
cases.forEach(([got, want], i) => assert.strictEqual(got, want, `case ${i}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`));
console.log(`store_view: ${cases.length} cases pass`);
