'use strict';
/**
 * The HMI's own full-screen free-text speller: the use case x_call opens
 * through the SDK's use case factory (02076b22-d19b-4aef-9e8c-0d7305d8b88c).
 * Needs the usecasemanagement proxies UseCaseInstance, UseCaseProvider and
 * UseCaseRegistry in manifest.json.
 *
 *   spell(onlineApp, 'Add source').then((text) => ...)
 *
 * Resolves with the text the driver confirmed with OK, or null when they
 * left the speller without OK; rejects when it could not be opened. The
 * title shows at most 22 characters. Notify parameters: 102 the text so
 * far (with every keystroke), 105 present once the driver pressed OK.
 */
const SPELLER_USE_CASE = '02076b22-d19b-4aef-9e8c-0d7305d8b88c';
const PARAM = { title: 4, input: 102, confirmed: 105 };
const FINAL = ['ABORTED', 'FAILED', 'COMPLETED'];
const FACTORY_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, what) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
        })
    ]).then((v) => {
        clearTimeout(timer);
        return v;
    }, (err) => {
        clearTimeout(timer);
        throw err;
    });
}

function spell(app, title) {
    return new Promise((resolve, reject) => {
        let inst = null;
        let subscription = null;
        let text = '';
        let done = false;
        const finish = (err, result) => {
            if (done) {
                return;
            }
            done = true;
            Promise.resolve()
                .then(() => (inst && subscription !== null ? inst.proxy.notify.unsubscribe(subscription) : undefined))
                .catch(() => { /* the instance is gone with the speller */ })
                .then(() => (err ? reject(err) : resolve(result)));
        };
        withTimeout(Promise.resolve().then(() => app.getUseCaseFactory()), FACTORY_TIMEOUT_MS, 'use case factory')
            .then((factory) => factory.create(SPELLER_USE_CASE))
            .then((created) => {
                inst = created;
                return inst.proxy.init();
            })
            .then(() => inst.proxy.waitUntilAvailable())
            .then(() => inst.proxy.notify.subscribe((n) => {
                // a Map-like object, not always a Map of this realm
                const p = n && n.interactionParameters;
                const has = (k) => !!p && typeof p.has === 'function' && p.has(k);
                if (has(PARAM.input)) {
                    text = String(p.get(PARAM.input));
                }
                if (has(PARAM.confirmed)) {
                    finish(null, text);
                } else if (n && FINAL.indexOf(n.interactionState) >= 0) {
                    finish(null, null);
                }
            }))
            .then((id) => {
                subscription = id === undefined ? null : id;
                if (done) {
                    subscription = null;
                    return Promise.resolve().then(() => inst.proxy.notify.unsubscribe(id)).catch(() => undefined);
                }
                return Promise.resolve(inst.proxy.interactionState.getValue()).then((state) => {
                    if (state !== 'READY') {
                        throw new Error(`speller is ${state}, not READY`);
                    }
                    return inst.proxy.start({ token: inst.token, startParameters: new Map([[PARAM.title, title]]) });
                });
            })
            .catch((err) => finish(err));
    });
}

module.exports = { spell, SPELLER_USE_CASE };
