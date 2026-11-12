'use strict';
/* Loads a registry through argv[2], fixtures/main_keep.js stock or built, in
 * a fake oap root (argv[3], holding oap_12201/data/apps): flaky_app fails its
 * first init, down_app every one, unproven_app fails with no folder of its
 * own; fine_app starts. Prints what became of them, once the retries of
 * MGU_DEPLOY_KEEP_RETRY_MS are over. */
const fs = require('fs');
const path = require('path');
const built = require(path.resolve(process.argv[2]));
const apps = path.join(process.argv[3], 'oap_12201', 'data', 'apps');
const tries = {}, installs = [], registered = [];

class FakeApp {
    constructor(id) { this.id = id; this.released = 0; }
    getAppId() { return this.id; }
    getUserId() { return Promise.resolve(JSON.parse(fs.readFileSync(path.join(apps, `${this.id}.json`), 'utf8')).userId); }
    removeAllListeners() { this.released++; }
    unpersist() {
        fs.unlinkSync(path.join(apps, `${this.id}.json`));
        return Promise.resolve();
    }
    init() {
        tries[this.id] = (tries[this.id] || 0) + 1;
        const fails = this.id === 'down_app' || this.id === 'unproven_app' || (this.id === 'flaky_app' && tries[this.id] === 1);
        return fails ? Promise.reject(new Error(`init of ${this.id} aborted`)) : Promise.resolve();
    }
}

const registry = new built.AppRegistry({
    appStorage: { getAllIdentifiers: () => Promise.resolve(fs.readdirSync(apps).map((n) => n.slice(0, -5))) },
    appFactory: { create: (id) => new FakeApp(id) }
});
registry.on('registered', (id) => registered.push(id));
const stub = new built.AppManagerStub((method, id) => {
    installs.push(`${method} ${id}`);
    return Promise.resolve();
});

registry.init().then(() => {
    const entries = () => fs.readdirSync(apps).map((n) => n.slice(0, -5)).sort();
    const atLoad = entries();
    return stub.install('down_app').then(() => 'installed', (e) => e.reason).then((down) => stub.install('new_app').then(() => {
        setTimeout(() => {
            console.log(JSON.stringify({ atLoad, entries: entries(), down, installs, registered, tries,
                loaded: Object.keys(registry._apps).map((u) => registry._apps[u].id).sort() }));
        }, 200);
    }));
}).catch((e) => console.log(JSON.stringify({ error: String(e && e.stack) })));
