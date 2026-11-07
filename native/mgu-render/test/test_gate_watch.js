'use strict';
/* The foreground gate's watch on a mock SOME/IP: a proxy that fails while the HMI starts is tried
 * again, and an instance that becomes available is read again (its stack sent before, or never). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startGate } = require('../js/foreground_gate.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatew-'));
const put = (uid, uuid) => {
    fs.mkdirSync(`${root}/oap_${uid}/rhmiData`, { recursive: true });
    fs.writeFileSync(`${root}/oap_${uid}/rhmiData/application.json`, JSON.stringify({ application: { uuid } }));
};
put(12240, 'u-a');
put(12244, 'u-b');

const inst = {
    I1: { fails: 2, uuid: 'u-a', stack: { ROOT_APP: [1] } },     // proxy fails twice, then works
    I2: { fails: 0, uuid: 'u-b', stack: { ROOT_APP: [1] } },     // its stack is never sent: read on availability
};
const avail = {};
const someip = {
    buildProxy: (cfg, name) => {
        const i = inst[name];
        if (i.fails > 0) { i.fails--; return Promise.reject(new Error('not offered')); }
        return Promise.resolve({
            init: () => Promise.resolve(),
            subscribeToAvailability: (fn) => { avail[name] = fn; },
            subscribe: () => Promise.resolve(),
            getValue: (k) => Promise.resolve(k === 'uuid' ? i.uuid : i.stack),
        });
    },
};
const lines = [];
const logs = [];
startGate({ someip, interfaceConfig: { instances: { I1: 1, I2: 2 } }, appsDir: root, retryMs: 20,
    write: (s) => lines.push(s.trim()), log: (s) => logs.push(s) });

setTimeout(() => {
    assert.deepStrictEqual(lines, ['foreground'], 'nothing in front before any instance is available');
    avail.I2(true);
    avail.I1(true);
    setTimeout(() => {
        assert.strictEqual(lines[lines.length - 1], 'foreground 12240 12244', lines.join(' | '));
        assert.ok(logs.some((l) => /I1: watched after 2 retries/.test(l)), logs.join(' | '));
        assert.strictEqual(logs.filter((l) => /I1: not offered/.test(l)).length, 1, 'a failing proxy is logged once');
        avail.I1(false);
        assert.strictEqual(lines[lines.length - 1], 'foreground 12244', 'unavailable: out of front');
        fs.rmSync(root, { recursive: true, force: true });
        console.log('test_gate_watch.js: all checks passed');
    }, 30);
}, 120);
