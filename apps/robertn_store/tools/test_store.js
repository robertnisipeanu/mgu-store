'use strict';
/**
 * Offline check of src/store.js's flows against stand-ins: the oap-sdk
 * (OnlineApp, logging), the RHMI (components from the generated
 * uiDescription.json), the updater client (records what is sent) and the
 * HMI speller (a fake use case factory answering with scripted text, Back
 * or OK). The app runs from a copy of src/ in a temp folder, whose data/
 * holds updater-secret and web-url. Node 8+.
 *
 *   node tools/gen_rhmi.js && node tools/test_store.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { ID7 } = require('./gen_rhmi.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
const SRC = path.join(ROOT, 'app', 'src');
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(path.join(ROOT, 'app'));
fs.mkdirSync(SRC);
fs.mkdirSync(DATA);
fs.readdirSync(path.join(__dirname, '..', 'src')).forEach((n) =>
    fs.copyFileSync(path.join(__dirname, '..', 'src', n), path.join(SRC, n)));

const writes = [];
const states = [];
const sent = [];
const spellerAnswers = [];              // per speller: text (OK), null (Back) or Error
const spellerTitles = [];

class Comp extends EventEmitter {
    constructor(name, id) {
        super();
        this.name = name;
        this.id = id;
    }
    getId() { return this.id; }
    setValue(r, c, v) { writes.push(`${this.name}.${r}.${c}=${v}`); return Promise.resolve(); }
    setProperty(p, v) { writes.push(`${this.name}.${p}=${v}`); return Promise.resolve(); }
    setRowCount(n) { writes.push(`${this.name}.rows=${n}`); return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}
const ui = JSON.parse(fs.readFileSync(path.join(ID7, 'uiDescription.json'), 'utf8'));
const byName = {};
Object.keys(ui.containers).forEach((cid) => {
    const c = ui.containers[cid];
    byName[c.name] = new Comp(c.name, cid);
    Object.keys(c.components).forEach((id) => { byName[c.components[id].name] = new Comp(c.components[id].name, id); });
});

class Rhmi extends EventEmitter {
    getByName(n) { return byName[n]; }
    openState(n) { states.push(`open ${n}`); return Promise.resolve(); }
    closeState(n) { states.push(`close ${n}`); return Promise.resolve(); }
    getResourceBundle() {
        return { createResourceHandles: () => Promise.resolve(), destroyResourceHandles: () => Promise.resolve() };
    }
    flush() { return Promise.resolve(); }
}

function fakeFactory() {
    return {
        create: () => {
            let cb = null;
            const proxy = {
                init: () => Promise.resolve(),
                waitUntilAvailable: () => Promise.resolve(),
                notify: { subscribe: (f) => { cb = f; return Promise.resolve(1); }, unsubscribe: () => Promise.resolve() },
                interactionState: { getValue: () => Promise.resolve('READY') },
                start: (args) => {
                    spellerTitles.push(args.startParameters.get(4));
                    const answer = spellerAnswers.shift();
                    setTimeout(() => {
                        const m = new Map(answer === null ? [[101, 'Hidden']] : [[102, answer], [105, true]]);
                        cb({ interactionState: answer === null ? 'ABORTED' : 'AWAITING_RESPONSE',
                            interactionParameters: { has: (k) => m.has(k), get: (k) => m.get(k) } });
                    }, 1);
                    return Promise.resolve({});
                }
            };
            return Promise.resolve({ proxy, token: 't' });
        }
    };
}

let app = null;
class OnlineApp extends EventEmitter {
    constructor() {
        super();
        app = this;
        this.rhmiApplication = new Rhmi();
        this._packageJson = { version: 'test' };
    }
    getAppId() { return 'robertn_store'; }
    start() { return Promise.resolve(); }
    getUseCaseFactory() {
        return spellerAnswers[0] instanceof Error ? Promise.reject(spellerAnswers.shift()) : Promise.resolve(fakeFactory());
    }
}
let socketUp = true;
class Client extends EventEmitter {
    connect() {}
    close() {}
    send(req) {
        if (socketUp) {
            sent.push(req);
        }
        return socketUp;
    }
}
const quiet = { info() {}, warn() {}, error() {} };
const stubs = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => quiet },
    './client.js': { UpdaterClient: Client }
};
const load = Module._load;
Module._load = function (req) {
    return stubs[req] || load.apply(this, arguments);
};
require(path.join(SRC, 'store.js'));
Module._load = load;

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));
const comp = (o) => Object.assign({ id: 'doom', kind: 'app', title: 'DOOM', version: '1.0.1', installed: '1.0.1',
    status: 'installed', queued: false, error: null, uninstallable: true }, o);
const base = { type: 'state', online: true, busy: null, rebooting: false, catalog: { checking: false, checkedAt: 1 } };
const ST = Object.assign({}, base, {
    components: [comp({})],
    sources: [
        { id: 'mgu-store', type: 'github', label: 'robertnisipeanu/mgu-store', builtin: true, usb: false, status: 'ok',
            auth: { kind: 'github', login: 'rn' }, components: 5, channel: 'releases' },
        { id: 'idrive7-apps', type: 'github', label: 'someone/idrive7-apps', builtin: false, usb: false,
            status: 'auth-needed', error: 'sign in', auth: null, components: 0 }],
    login: null,
    web: { enabled: false, urls: [], error: null }
});
const last = (re) => writes.filter((w) => re.test(w)).pop();
const reset = () => { writes.length = 0; states.length = 0; sent.length = 0; spellerTitles.length = 0; };
const secretless = (req) => { const r = Object.assign({}, req); delete r.secret; return r; };
let checks = 0;
const eq = (got, want, msg) => { checks += 1; assert.deepStrictEqual(got, want, msg); };

function run() {
    return app._setupRhmi().then(() => {
        app._setVisible(true);
        // no updater yet, and it has not run since this Store was installed: no secret
        app._client.emit('down');
        return tick();
    }).then(() => {
        eq(last(/storeStatus\.\d*\.?Text/).split('=')[1], 'Restart the head unit to finish setup');
        // an updater without sources or web
        app._client.emit('state', Object.assign({}, base, { components: [comp({})] }));
        return tick();
    }).then(() => {
        eq(last(/storeNavSources\.Visible/), 'storeNavSources.Visible=0', 'Sources hidden');
        eq(last(/storeNavPhone\.Visible/), 'storeNavPhone.Visible=0', 'Phone access hidden');
        app._client.emit('state', ST);
        return tick();
    }).then(() => {
        eq(last(/storeSourceAdd\.Visible/), 'storeSourceAdd.Visible=1', 'Add source shown');
        eq(last(/storeSourcePhone\.Visible/), 'storeSourcePhone.Visible=1', 'Phone access linked from Sources');
        eq(last(/storeSourcesStatus\.Visible/), 'storeSourcesStatus.Visible=0', 'no Sources status');

        // without the secret nothing is sent
        reset();
        spellerAnswers.push('https://example.org/c.json');
        app._addSource();
        return tick();
    }).then(() => {
        eq(sent, [], 'nothing sent without the secret');
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Add source failed: no updater secret');
        fs.writeFileSync(path.join(DATA, 'updater-secret'), 'deadbeef\n');
        // the updater has run and is unreachable now
        app._client.emit('down');
        return tick();
    }).then(() => {
        eq(last(/storeStatus\.\d*\.?Text/).split('=')[1], 'Updater not running');
        app._client.emit('state', ST);
        return tick();
    }).then(() => {

        // owner/repo, then Releases
        reset();
        spellerAnswers.push(' robertnisipeanu/new-repo ');
        app._addSource();
        return tick();
    }).then(() => {
        eq(spellerTitles, ['Add source']);
        eq(states, ['open ST_OnlineApps_StoreChannel'], 'chooser opened');
        eq(last(/storeAddRepo\.0\.Text/), 'storeAddRepo.0.Text=robertnisipeanu/new-repo');
        eq(last(/storeSourcesStatus\.Visible/), 'storeSourcesStatus.Visible=0', 'status cleared');
        app._chooseChannel('releases');
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ channel: 'releases', op: 'source-add', type: 'github', repo: 'robertnisipeanu/new-repo' }]);
        eq(sent[0].secret, 'deadbeef');
        eq(states.slice(1), ['close ST_OnlineApps_StoreChannel']);

        // Tags
        reset();
        spellerAnswers.push('o/r');
        app._addSource();
        return tick();
    }).then(() => {
        app._chooseChannel('tags');
        return tick();
    }).then(() => {
        eq(sent.map((r) => r.channel), ['tags']);

        // Branch: a name, empty (default branch), Back, a bad name
        const branch = (answer) => {
            reset();
            spellerAnswers.push('o/r', answer);
            app._addSource();
            return tick().then(() => {
                app._chooseChannel('branch');
                return tick();
            });
        };
        return branch(' dev ')
            .then(() => {
                eq(spellerTitles, ['Add source', 'Branch']);
                eq(sent.map((r) => r.channel), ['branch:dev']);
                eq(states, ['open ST_OnlineApps_StoreChannel', 'close ST_OnlineApps_StoreChannel']);
                return branch('');
            })
            .then(() => {
                eq(sent.map((r) => r.channel), ['branch'], 'empty: the default branch');
                return branch(null);
            })
            .then(() => {
                eq(sent, [], 'Back in the branch speller sends nothing');
                eq(states, ['open ST_OnlineApps_StoreChannel', 'close ST_OnlineApps_StoreChannel'], 'back to Sources');
                return branch('a..b');
            })
            .then(() => {
                eq(sent, []);
                eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Not a branch name: a..b');
                eq(states.slice(-1), ['close ST_OnlineApps_StoreChannel']);
            });
    }).then(() => {
        // a chooser press after the chooser was left does nothing
        reset();
        app._chooseChannel('releases');
        eq(sent, []);

        // an https address is added as it is
        reset();
        spellerAnswers.push('https://example.org/repo/catalog.json');
        app._addSource();
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'source-add', type: 'https', url: 'https://example.org/repo/catalog.json' }]);
        eq(states, [], 'no chooser for https');

        // the updater went away while the speller was up
        reset();
        socketUp = false;
        spellerAnswers.push('https://example.org/c.json');
        app._addSource();
        return tick();
    }).then(() => {
        socketUp = true;
        eq(sent, []);
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Add source failed: updater not running');

        // Back in the first speller, OK with nothing typed
        reset();
        spellerAnswers.push(null, '  ');
        app._addSource();
        return tick().then(() => {
            app._addSource();
            return tick();
        });
    }).then(() => {
        eq(sent, []);
        eq(states, []);

        // invalid input
        reset();
        spellerAnswers.push('foo bar');
        app._addSource();
        return tick();
    }).then(() => {
        eq(sent, []);
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Not owner/repo or https://host/path: foo bar');
        eq(last(/storeSourcesStatus\.Visible/), 'storeSourcesStatus.Visible=1');

        // the speller cannot be opened
        reset();
        spellerAnswers.push(new Error('use case factory timed out'));
        app._addSource();
        return tick();
    }).then(() => {
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Text entry failed: use case factory timed out');

        // the updater's refusal, with and without the op in the reply
        reset();
        spellerAnswers.push('https://example.org/c.json');
        app._addSource();
        return tick();
    }).then(() => {
        app._client.emit('reply-error', 'https://example.org/c.json is already a source', 'source-add');
        return tick();
    }).then(() => {
        eq(last(/storeSourcesStatus\.0\.Text/),
            'storeSourcesStatus.0.Text=Add source failed: https://example.org/c.json is already a source');
        reset();
        app._sourceId = 'idrive7-apps';
        app._removeSource();
        app._client.emit('reply-error', 'forbidden');
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'source-remove', id: 'idrive7-apps' }]);
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Remove failed: forbidden');
        eq(states, ['close ST_OnlineApps_StoreSourceRemove'], 'only the confirm closes');
        // the refused source's page closes once it shows again: Sources has the message
        app._states.ST_OnlineApps_StoreSource.emit('visible', { visible: true });
        return tick();
    }).then(() => {
        eq(states, ['close ST_OnlineApps_StoreSourceRemove', 'close ST_OnlineApps_StoreSource'], 'refused: back to Sources');
        // removed: the page closes once the updater's state no longer lists the source
        reset();
        app._sourceId = 'idrive7-apps';
        app._client.emit('state', ST);
        app._states.ST_OnlineApps_StoreSource.emit('visible', { visible: true });
        app._removeSource();
        return tick();
    }).then(() => {
        eq(states, ['close ST_OnlineApps_StoreSourceRemove'], 'open while the source is listed');
        app._client.emit('state', Object.assign({}, ST, { sources: ST.sources.slice(0, 1) }));
        return tick(300);
    }).then(() => {
        eq(states, ['close ST_OnlineApps_StoreSourceRemove', 'close ST_OnlineApps_StoreSource'], 'removed: back to Sources');
        // a source missing from a state for another reason (a restarted updater has not looked at the sticks yet)
        reset();
        app._sourceId = 'usb:STICK';
        app._states.ST_OnlineApps_StoreSource.emit('visible', { visible: true });
        app._client.emit('state', ST);
        return tick(300);
    }).then(() => {
        eq(states, [], 'a page this Store did not remove stays open');
        // not sent without the secret: back to Sources, which says why
        reset();
        app._sourceId = 'idrive7-apps';
        const secretFile = path.join(DATA, 'updater-secret');
        const secretText = fs.readFileSync(secretFile, 'utf8');
        fs.unlinkSync(secretFile);
        app._removeSource();
        fs.writeFileSync(secretFile, secretText);
        return tick();
    }).then(() => {
        eq(sent, [], 'nothing sent');
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Remove failed: no updater secret');
        eq(states, ['close ST_OnlineApps_StoreSourceRemove', 'close ST_OnlineApps_StoreSource'], 'unsent: back to Sources');
        // opening a source's page again forgets an earlier removal
        reset();
        app._removingSource = 'idrive7-apps';
        app._removalRefused = true;
        app._onSource(1);
        eq([app._removingSource, app._removalRefused], [null, false]);
        app._client.emit('state', ST);
        // a refusal answering an unprivileged request does not land on Sources
        reset();
        app._onRow('app', 0);
        app._remove();
        app._send({ op: 'check' });
        app._client.emit('reply-error', 'busy');
        return tick();
    }).then(() => {
        eq(writes.filter((w) => /storeSourcesStatus/.test(w)), []);

        // sign-in: a refusal shows; an earlier done does not close a new page
        reset();
        app._sourceId = 'idrive7-apps';
        app._signIn();
        app._client.emit('reply-error', 'forbidden');
        return tick();
    }).then(() => {
        eq(last(/storeLoginStatus/), 'storeLoginStatus.0.Text=Sign-in failed: forbidden');
        reset();
        app._signIn();
        app._visibleStates.add('ST_OnlineApps_StoreLogin');
        app._client.emit('state', Object.assign({}, ST, { login: { source: 'idrive7-apps', status: 'done' } }));
        return tick();
    }).then(() => {
        eq(states, ['open ST_OnlineApps_StoreLogin'], 'stale done ignored');
        app._client.emit('state', Object.assign({}, ST, { login: { source: 'idrive7-apps', url: 'https://github.com/login/device',
            code: 'WXYZ-0000', status: 'pending' } }));
        return tick();
    }).then(() => {
        eq(last(/storeLoginCode\.0\.Text/), 'storeLoginCode.0.Text=WXYZ-0000');
        app._client.emit('state', Object.assign({}, ST, { login: { source: 'idrive7-apps', status: 'done' } }));
        return tick();
    }).then(() => {
        eq(states, ['open ST_OnlineApps_StoreLogin', 'close ST_OnlineApps_StoreLogin'], 'closes once done');

        // Phone access: token-free text only, then the web-url file's QR code
        reset();
        const on = Object.assign({}, ST, { web: { enabled: true, urls: ['http://172.16.222.97:8470/'], error: null } });
        app._client.emit('state', on);
        return tick().then(() => {
            eq(last(/storePhoneUrl\.0\.Text/), 'storePhoneUrl.0.Text=http://172.16.222.97:8470/');
            eq(last(/storePhoneQr\.Visible/), undefined, 'no QR without web-url');
            app._states.ST_OnlineApps_StorePhone.emit('visible', { visible: true });
            fs.writeFileSync(path.join(DATA, 'web-url'), 'http://172.16.222.97:8470/#t=tok\n');
            return tick(1200);
        }).then(() => {
            eq(last(/storePhoneUrl\.0\.Text/), 'storePhoneUrl.0.Text=http://172.16.222.97:8470/#t=tok', 'web-url picked up');
            eq(last(/storePhoneQr\.Visible/), 'storePhoneQr.Visible=1');
            app._states.ST_OnlineApps_StorePhone.emit('visible', { visible: false });
            fs.unlinkSync(path.join(DATA, 'web-url'));
            app._client.emit('state', ST);
            return tick();
        }).then(() => {
            eq(last(/storePhoneQr\.Visible/), 'storePhoneQr.Visible=0');
            eq(app._webUrlTimer, null, 'web-url re-read stopped');
        });
    });
}

function rmrf(p) {
    if (fs.lstatSync(p).isDirectory()) {
        fs.readdirSync(p).forEach((n) => rmrf(path.join(p, n)));
        fs.rmdirSync(p);
    } else {
        fs.unlinkSync(p);
    }
}

/* The temp folder, and the QR files the app wrote (src/store.js qrDir). */
function cleanUp() {
    rmrf(ROOT);
    const qr = path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), `robertn_store_qr_${process.getuid()}`);
    try {
        fs.readdirSync(qr).filter((n) => n.indexOf('qr_') === 0).forEach((n) => fs.unlinkSync(path.join(qr, n)));
    } catch (e) {
        /* none written */
    }
}

run().then(() => {
    cleanUp();
    console.log(`store: ${checks} checks pass`);
    process.exit(0);
}, (err) => {
    cleanUp();
    console.error(err);
    process.exit(1);
});
