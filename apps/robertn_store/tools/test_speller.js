'use strict';
/**
 * Offline check of src/speller.js against a fake use case factory that
 * behaves as the HMI's speller did in the emulator: notify parameters as a
 * Map-like object (not a Map of this realm), 101 states, 102 with every
 * keystroke, 105 on OK. Node 8+.
 *
 *   node tools/test_speller.js
 */
const assert = require('assert');
const { spell } = require('../src/speller.js');

function params(entries) {
    const m = new Map(entries);
    return { has: (k) => m.has(k), get: (k) => m.get(k) };
}

/* A fake factory; `script(emit)` runs after start and drives notify. */
function fakeApp(script, opts) {
    const o = opts || {};
    const log = { created: [], started: null, unsubscribed: [] };
    const proxy = {
        init: () => Promise.resolve(),
        waitUntilAvailable: () => Promise.resolve(),
        notify: {
            subscribe: (cb) => {
                log.cb = cb;
                return Promise.resolve(7);
            },
            unsubscribe: (id) => {
                log.unsubscribed.push(id);
                return Promise.resolve();
            }
        },
        interactionState: { getValue: () => Promise.resolve(o.state || 'READY') },
        start: (args) => {
            log.started = args;
            setTimeout(() => script((state, entries) => log.cb({ interactionState: state, interactionParameters: params(entries) })), 1);
            return Promise.resolve({ UseCaseError: 'STATUS_OK' });
        }
    };
    const app = {
        getUseCaseFactory: () => (o.noFactory ? new Promise(() => {}) : Promise.resolve({
            create: (id) => {
                log.created.push(id);
                return Promise.resolve({ proxy, token: 'tok-1' });
            }
        }))
    };
    return { app, log };
}

const cases = [];

// OK after typing: the text of the last 102, resolved on 105
cases.push((() => {
    const f = fakeApp((emit) => {
        emit('AWAITING_RESPONSE', [[101, 'Started']]);
        emit('AWAITING_RESPONSE', [[102, 'o'], [104, '1']]);
        emit('AWAITING_RESPONSE', [[102, 'owner/repo '], [104, '11']]);
        emit('COMPLETED', [[105, true]]);
    });
    return spell(f.app, 'Add source').then((text) => {
        assert.strictEqual(text, 'owner/repo ');
        assert.deepStrictEqual(f.log.created, ['02076b22-d19b-4aef-9e8c-0d7305d8b88c']);
        assert.strictEqual(f.log.started.token, 'tok-1');
        assert.strictEqual(f.log.started.startParameters.get(4), 'Add source');
        assert.deepStrictEqual(f.log.unsubscribed, [7]);
        return 'ok';
    });
})());

// 105 with 102 in the same notify
cases.push((() => {
    const f = fakeApp((emit) => emit('AWAITING_RESPONSE', [[102, 'main'], [105, true]]));
    return spell(f.app, 'Branch').then((text) => assert.strictEqual(text, 'main'));
})());

// OK with nothing typed
cases.push((() => {
    const f = fakeApp((emit) => emit('COMPLETED', [[105, true]]));
    return spell(f.app, 'Add source').then((text) => assert.strictEqual(text, ''));
})());

// left without OK: ABORTED (Back) and FAILED resolve null, typing or not
['ABORTED', 'FAILED', 'COMPLETED'].forEach((final) => cases.push((() => {
    const f = fakeApp((emit) => {
        emit('AWAITING_RESPONSE', [[102, 'half']]);
        emit(final, [[101, 'Hidden']]);
    });
    return spell(f.app, 'Add source').then((text) => {
        assert.strictEqual(text, null, final);
        assert.deepStrictEqual(f.log.unsubscribed, [7]);
    });
})()));

// a speller that is not READY is not started
cases.push((() => {
    const f = fakeApp(() => assert.fail('started'), { state: 'BUSY' });
    return spell(f.app, 'Add source').then(() => assert.fail('resolved'), (err) => {
        assert(/BUSY/.test(err.message));
        assert.strictEqual(f.log.started, null);
        assert.deepStrictEqual(f.log.unsubscribed, [7]);
    });
})());

// no factory: rejects after the timeout (shortened through a fake clock)
cases.push((() => {
    const realSetTimeout = setTimeout;
    global.setTimeout = (fn, ms) => realSetTimeout(fn, ms >= 10000 ? 5 : ms);
    const f = fakeApp(() => {}, { noFactory: true });
    const p = spell(f.app, 'Add source');
    global.setTimeout = realSetTimeout;
    return p.then(() => assert.fail('resolved'), (err) => assert(/timed out/.test(err.message)));
})());

Promise.all(cases).then(() => console.log(`speller: ${cases.length} cases pass`), (err) => {
    console.error(err);
    process.exit(1);
});
