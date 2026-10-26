'use strict';
/**
 * Offline check of src/store.js's flows against stand-ins: the oap-sdk
 * (OnlineApp, logging), the RHMI (components from the generated
 * uiDescription.json), the updater client (records what is sent), the HMI
 * speller (a fake use case factory answering with scripted text, Back or
 * OK) and mgu-render's client (records placement, frames, claims). The
 * widget screens first, then the drawn ones: the renderer coming and
 * going, proxies and focus, presses, touch, BACK, the confirm steps. The
 * app runs from a copy of src/ in a temp folder, whose data/ holds
 * updater-secret and web-url. STORE_HMI=ID8 runs it on iDrive 8's
 * description. Node 8+.
 *
 *   node tools/gen_rhmi.js && node tools/test_store.js && STORE_HMI=ID8 node tools/test_store.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { ID7, ID8 } = require('./gen_rhmi.js');
const HMI = process.env.STORE_HMI === 'ID8' ? 'ID8' : 'ID7';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
const SRC = path.join(ROOT, 'app', 'src');
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(path.join(ROOT, 'app'));
fs.mkdirSync(SRC);
fs.mkdirSync(DATA);
fs.readdirSync(path.join(__dirname, '..', 'src')).forEach((n) =>
    fs.copyFileSync(path.join(__dirname, '..', 'src', n), path.join(SRC, n)));
fs.copyFileSync(path.join(__dirname, '..', 'lib', 'mgu_render_client.js'), path.join(SRC, 'mgu_render_client.js'));

const writes = [];                     // cell writes, under iDrive 7's cell names
const rawWrites = [];                  // as written
const states = [];
const sent = [];
const spellerAnswers = [];              // per speller: text (OK), null (Back) or Error
const spellerTitles = [];

/* iDrive 8's cells under iDrive 7's names, so one set of checks reads both. */
const ID7_CELL = { FrequencyText: 'Text2ndCol' };
class Comp extends EventEmitter {
    constructor(name, id, row) {
        super();
        this.name = name;
        this.id = id;
        this.twoCols = !!(row && row.FrequencyVisible && row.FrequencyVisible.value);
    }
    getId() { return this.id; }
    setValue(r, c, v) {
        rawWrites.push(`${this.name}.${r}.${c}=${v}`);
        const c7 = c === 'PrimaryText' ? (this.twoCols ? 'Text1stCol' : 'Text') : ID7_CELL[c] || c;
        writes.push(`${this.name}.${r}.${c7}=${v}`);
        return Promise.resolve();
    }
    setProperty(p, v) { writes.push(`${this.name}.${p}=${v}`); return Promise.resolve(); }
    setRowCount(n) { writes.push(`${this.name}.rows=${n}`); return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}
const ui = JSON.parse(fs.readFileSync(path.join(HMI === 'ID8' ? ID8 : ID7, 'uiDescription.json'), 'utf8'));
const byName = {};
Object.keys(ui.containers).forEach((cid) => {
    const c = ui.containers[cid];
    byName[c.name] = new Comp(c.name, cid);
    Object.keys(c.components).forEach((id) => {
        const comp = c.components[id];
        byName[comp.name] = new Comp(comp.name, id, comp.rows && comp.rows[0]);
    });
});

class Rhmi extends EventEmitter {
    getByName(n) { return byName[n]; }
    openState(n) { states.push(`open ${typeof n === 'string' ? n : n.name}`); return Promise.resolve(); }
    closeState(n) { states.push(`close ${typeof n === 'string' ? n : n.name}`); return Promise.resolve(); }
    mapEntryState(uuid, st) { states.push(`map ${st.name}`); return Promise.resolve(); }
    openEntryState() { states.push('open entry'); return Promise.resolve(); }
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
/* mgu-render's client: what the Store asks of it. */
const gpuLog = [];
let fpsAsked = null;
const frames = [];
class RenderClient extends EventEmitter {
    constructor() {
        super();
        this.ready = false;
        this.visible = false;
        this.waiting = false;
        this.claims = [];
        this.grabbing = false;
    }
    connect() { gpuLog.push('connect'); }
    close() { gpuLog.push('close'); this.emit('close'); }
    mode(m) { if (m) { gpuLog.push(`mode ${m}`); this.wantMode = m; } return this.wantMode; }
    place(p) { gpuLog.push(`place ${p.x},${p.y} ${p.w}x${p.h} ${p.scale.toFixed(3)}`); this.placement = p; }
    show(on) { this.visible = on; gpuLog.push(`show ${on}`); }
    claim(r) { this.claims = r; }
    fps(n) { fpsAsked = n; }
    grab(on) { this.grabbing = on; }
    frame(rec) { frames.push(rec); return true; }
}
// FrontCCU: the sample callback the app subscribes with
let frontCcu = null;
const someipBuilders = {
    buildTypedProxy: (iface, instance) => Promise.resolve({
        iface, instance,
        init: () => Promise.resolve(),
        waitUntilAvailable: () => Promise.resolve(),
        statusRotaryEncoderState: { subscribe: (cb) => { frontCcu = cb; return Promise.resolve(); } }
    })
};
const stubs = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/someip/someipBuilders': someipBuilders,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => quiet },
    './client.js': { UpdaterClient: Client },
    './mgu_render_client.js': { RenderClient }
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
            auth: { kind: 'github', token: '3f9a01c2', login: 'rn' }, components: 5, channel: 'releases' },
        { id: 'idrive7-apps', type: 'github', label: 'someone/idrive7-apps', builtin: false, usb: false,
            status: 'auth-needed', error: 'sign in', auth: null, components: 0 }],
    tokens: [{ id: '3f9a01c2', kind: 'github', label: 'rn', login: 'rn', addedAt: 0, rejected: false, usedBy: ['mgu-store'] },
        { id: '0badc0de', kind: 'github', label: null, login: null, addedAt: 0, rejected: true, usedBy: [] }],
    login: null,
    web: { enabled: false, urls: [], error: null }
});
const last = (re) => writes.filter((w) => re.test(w)).pop();
const reset = () => { writes.length = 0; states.length = 0; sent.length = 0; spellerTitles.length = 0; };
const secretless = (req) => { const r = Object.assign({}, req); delete r.secret; return r; };
let checks = 0;
const eq = (got, want, msg) => { checks += 1; assert.deepStrictEqual(got, want, msg); };

function run() {
    return app._setupRhmi().then(() => app._setupController()).then(() => {
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
        eq(last(/storeSourceAccounts\.Visible/), 'storeSourceAccounts.Visible=0', 'Accounts hidden');
        app._client.emit('state', ST);
        return tick();
    }).then(() => {
        eq(last(/storeSourceAdd\.Visible/), 'storeSourceAdd.Visible=1', 'Add source shown');
        eq(last(/storeSourcePhone\.Visible/), 'storeSourcePhone.Visible=1', 'Phone access linked from Sources');
        eq(last(/storeSourcesStatus\.Visible/), 'storeSourcesStatus.Visible=0', 'no Sources status');
        // each source with the account that reads it, or what it needs
        eq([last(/storeSourceList\.0\.Text2ndCol/), last(/storeSourceList\.1\.Text2ndCol/)],
            ['storeSourceList.0.Text2ndCol=rn', 'storeSourceList.1.Text2ndCol=Sign in']);
        // Accounts: one row per token, with the sources it reads
        eq(last(/storeSourceAccounts\.Visible/), 'storeSourceAccounts.Visible=1');
        eq(last(/storeSourceAccounts\.0\.Text2ndCol/), 'storeSourceAccounts.0.Text2ndCol=2 accounts');
        eq(writes.filter((w) => /^storeAccountList\.[01]\./.test(w)).slice(-4), ['storeAccountList.0.Text1stCol=rn',
            'storeAccountList.0.Text2ndCol=1 source', 'storeAccountList.1.Text1stCol=0badc0de', 'storeAccountList.1.Text2ndCol=Rejected']);
        eq(writes.filter((w) => /storeSrcSignIn/.test(w)), [], 'no sign-in on a source');

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
            return tick(40).then(() => {
                app._chooseChannel('branch');
                return tick(40);
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
        // the refused source's page closes once the confirm step gives it the focus back: Sources has the message
        app._states.ST_OnlineApps_StoreSource.emit('visible', { visible: true });
        app._states.ST_OnlineApps_StoreSource.emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(states, ['close ST_OnlineApps_StoreSourceRemove', 'close ST_OnlineApps_StoreSource'], 'refused: back to Sources');
        // removed: the page closes once the updater's state no longer lists the source
        reset();
        app._sourceId = 'idrive7-apps';
        app._client.emit('state', ST);
        app._states.ST_OnlineApps_StoreSource.emit('visible', { visible: true });
        app._states.ST_OnlineApps_StoreSourceRemove.emit('focus', { focus: true });
        app._removeSource();
        app._client.emit('state', Object.assign({}, ST, { sources: ST.sources.slice(0, 1) }));
        return tick();
    }).then(() => {
        eq(states, ['close ST_OnlineApps_StoreSourceRemove'], 'removed while the confirm step still closes: the page waits');
        app._states.ST_OnlineApps_StoreSource.emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(states, ['close ST_OnlineApps_StoreSourceRemove', 'close ST_OnlineApps_StoreSource'], 'removed: back to Sources once the page has the focus');
        // removed after the page has the focus back
        reset();
        app._client.emit('state', ST);
        app._states.ST_OnlineApps_StoreSource.emit('visible', { visible: true });
        app._removeSource();
        app._states.ST_OnlineApps_StoreSource.emit('focus', { focus: true });
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
        app._states.ST_OnlineApps_StoreSource.emit('focus', { focus: true });
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
        app._states.ST_OnlineApps_StoreSource.emit('focus', { focus: true });
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

        // an account: its row opens the confirm step naming it and its sources; Remove sends token-remove
        reset();
        app._onAccount(0);
        return tick();
    }).then(() => {
        eq(states, ['open ST_OnlineApps_StoreAccountRemove']);
        eq(last(/storeAccountName\.0\.Text/), 'storeAccountName.0.Text=rn');
        eq(last(/storeAccountSources\.0\.Text/), 'storeAccountSources.0.Text=robertnisipeanu/mgu-store');
        app._removeAccount();
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'token-remove', id: '3f9a01c2' }]);
        eq(states.slice(1), ['close ST_OnlineApps_StoreAccountRemove']);
        // an unused account names no sources
        reset();
        app._onAccount(1);
        return tick();
    }).then(() => {
        eq(last(/storeAccountSources\.Visible/), 'storeAccountSources.Visible=0');
        app._closeState('ST_OnlineApps_StoreAccountRemove');

        // sign-in (Accounts): a refusal shows; an earlier done does not close a new page
        reset();
        app._signIn();
        app._client.emit('reply-error', 'forbidden');
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'login-start' }], 'a sign-in names no source');
        eq(last(/storeLoginStatus/), 'storeLoginStatus.0.Text=Sign-in failed: forbidden');
        reset();
        app._signIn();
        app._visibleStates.add('ST_OnlineApps_StoreLogin');
        app._client.emit('state', Object.assign({}, ST, { login: { status: 'done' } }));
        return tick();
    }).then(() => {
        eq(states, ['open ST_OnlineApps_StoreLogin'], 'stale done ignored');
        app._client.emit('state', Object.assign({}, ST, { login: { url: 'https://github.com/login/device',
            code: 'WXYZ-0000', status: 'pending' } }));
        return tick();
    }).then(() => {
        eq(last(/storeLoginCode\.0\.Text/), 'storeLoginCode.0.Text=WXYZ-0000');
        app._client.emit('state', Object.assign({}, ST, { login: { status: 'done' } }));
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

/* The widget screens: compatibility, Replace, Sign in with GitHub, the GitHub App's install page. */
function runWidgetsExtra() {
    const renderer = comp({ id: 'mgu-render', kind: 'tool', title: 'Renderer', version: '0.1.0', installed: null, status: 'available',
        provides: 'renderer', replaces: 'mgu-renderd' });
    const held = comp({ id: 'mgu-renderd', kind: 'tool', title: 'GPU renderer', version: '1.1.0', installed: '1.1.0', provides: 'renderer' });
    const id8only = comp({ id: 'cardash', title: 'Car Data', version: '1.1.4', installed: null, status: 'available', mguHmi: ['ID8'],
        compat: 'no' });
    const st = Object.assign({}, ST, { unit: { hmi: 'ID7' }, components: [comp({}), id8only, renderer, held], signin: false,
        signinApp: { installUrl: 'https://github.com/apps/mgu-store/installations/new' } });
    reset();
    app._forgetWritten();
    app._client.emit('state', st);
    return tick().then(() => {
        eq(last(/storeAppList\.1\.Text2ndCol/), 'storeAppList.1.Text2ndCol=Not for this head unit', 'not for this unit: says so');
        app._onRow('app', 1);
        eq(sent, [], 'and is not installed');
        eq(last(/storeAccountSignIn\.Visible/), 'storeAccountSignIn.Visible=0', 'no Sign in with GitHub without state.signin');
        app._onRow('tool', 0);
        return tick();
    }).then(() => {
        eq(states, ['open ST_OnlineApps_StoreReplace'], 'a second renderer asks Replace?');
        eq(last(/storeReplaceName\.0\.Text/), 'storeReplaceName.0.Text=GPU renderer with Renderer 0.1.0');
        app._replace();
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'install', id: 'mgu-render', replace: true }], 'Replace installs it with replace');
        eq(sent[0].secret, 'deadbeef');
        eq(states.slice(1), ['close ST_OnlineApps_StoreReplace']);
        reset();
        app._client.emit('state', Object.assign({}, st, { signin: true }));
        return tick();
    }).then(() => {
        eq(last(/storeAccountSignIn\.Visible/), 'storeAccountSignIn.Visible=1', 'Sign in with GitHub with state.signin');
        // a private source no account reaches, with an account signed in: the App's install page
        reset();
        app._sourceId = 'idrive7-apps';
        app._forgetWritten();
        app._client.emit('state', st);
        return tick(50);
    }).then(() => {
        eq(last(/storeSrcAppLabel\.Visible/), 'storeSrcAppLabel.Visible=1');
        eq(last(/storeSrcAppUrl\.0\.Text/), 'storeSrcAppUrl.0.Text=https://github.com/apps/mgu-store/installations/new');
        eq(last(/storeSrcAppQr\.Visible/), 'storeSrcAppQr.Visible=1');
        reset();
        app._client.emit('state', Object.assign({}, st, { signinApp: null }));
        return tick(50);
    }).then(() => {
        eq(last(/storeSrcAppLabel\.Visible/), 'storeSrcAppLabel.Visible=0', 'none without the App');
        app._sourceId = null;
        if (HMI === 'ID8') {
            eq(rawWrites.some((w) => /^storeSourceList\.0\.FrequencyText=/.test(w)) &&
                !rawWrites.some((w) => /Text[12](st|nd)Col/.test(w)), true, 'iDrive 8: MediaEntry cells');
        }
    });
}

/* The drawn screens: a fake renderer answering, the proxies, presses, touch, BACK, confirm steps, and going away. */
function runDrawn() {
    const drawn = app._drawn;
    const gpu = drawn.gpu;
    const mode = HMI === 'ID8' ? 'layer' : 'embed';
    const host = (d) => `ST_OnlineApps_Store${mode === 'embed' ? 'Embed' : 'Layer'}${d}`;
    const proxy = (d, i) => `store${mode === 'embed' ? 'Embed' : 'Layer'}${d}P${i}`;
    const lastText = (name) => (last(new RegExp(`^${name}\\.0\\.Text=`)) || '').split('=').slice(1).join('=');
    const st = Object.assign({}, ST, { unit: { hmi: HMI }, busy: null, signin: true, rebooting: false,
        components: [comp({ id: 'doom', title: 'DOOM', version: '1.0.1', installed: '1.0.0', status: 'update' }),
            comp({ id: 'raluca', title: 'Raluca', version: '1.2.0', installed: null, status: 'available' }),
            comp({ id: 'mgu-render', kind: 'tool', title: 'Renderer', version: '0.1.0', installed: null, status: 'available',
                provides: 'renderer', replaces: 'mgu-renderd' }),
            comp({ id: 'mgu-renderd', kind: 'tool', title: 'GPU renderer', version: '1.1.0', installed: '1.1.0', provides: 'renderer' })] });
    app._entryUuid = 'entry';
    reset();
    gpuLog.length = 0;
    app._client.emit('state', st);
    gpu.ready = true;
    gpu.emit('ready', { w: 1920, h: 720 }, { version: 1, modes: ['layer', 'embed'], embedBox: { x: 104, y: 88, w: 1796, h: 632 },
        appArea: { x: 108, y: 82, w: 1790, h: 638 }, controller: false, touch: true, pixmap: true });
    return tick().then(() => {
        eq(app._ui, mode, `the renderer offering embed: ${mode} (the host states this HMI has)`);
        eq(fpsAsked, 30, 'at most 30 frames a second');
        eq(gpuLog.slice(0, 2), [`mode ${mode}`, mode === 'embed' ? 'place 104,88 1796x632 0.652' : 'place 108,82 1790x638 0.650']);
        eq(states.slice(0, 2), [`map ${host(1)}`, `open ${host(1)}`], 'the tile maps to the drawn screens; the Store on screen moves there');
        app._states[host(1)].emit('visible', { visible: true });
        return tick();
    }).then(() => {
        eq(gpu.visible, true, 'shown with its host state');
        eq(gpu.claims.length, 1, 'touch claimed');
        eq(frames.length > 0 && drawn.items.some((i) => i.label === 'DOOM'), true, 'the Store tab drawn');
        eq([lastText(proxy(1, 0)), lastText(proxy(1, 3)), lastText(proxy(1, 4)), lastText(proxy(1, 7))],
            ['Store', 'Settings', 'All', 'DOOM'], 'proxies in focus order: side menu, filters, tiles');
        eq(last(new RegExp(`^${proxy(1, 12)}\\.Visible`)), `${proxy(1, 12)}.Visible=0`, 'unused proxies hidden');
        // focus moves with the HMI's
        app._components[proxy(1, 9)].emit('focus', { value: true });
        eq(drawn.focus, 9);
        // a tile press opens its page at depth 2
        reset();
        app._components[proxy(1, 7)].emit('action', {});
        return tick();
    }).then(() => {
        eq(states, [`open ${host(2)}`], 'the app page is the next host state');
        eq(drawn.top(), { name: 'app', id: 'doom' });
        // as the HMI reports it: the state below loses the focus but stays visible
        app._states[host(1)].emit('focus', { focus: false });
        app._states[host(2)].emit('visible', { visible: true });
        app._states[host(2)].emit('focus', { focus: true });
        return tick();
    }).then(() => {
        const labels = drawn.items.map((i) => i.label);
        eq(labels.indexOf('Update to 1.0.1') >= 0 && labels.indexOf('Remove') >= 0, true, 'Update and Remove on the page');
        eq(lastText(proxy(2, labels.indexOf('Update to 1.0.1'))), 'Update to 1.0.1');
        reset();
        app._components[proxy(2, labels.indexOf('Update to 1.0.1'))].emit('action', {});
        return tick();
    }).then(() => {
        eq(sent, [{ op: 'install', id: 'doom' }], 'the page installs');
        // Remove: the confirm dialog at depth 3, Cancel first
        reset();
        app._components[proxy(2, drawn.items.map((i) => i.label).indexOf('Remove'))].emit('action', {});
        return tick();
    }).then(() => {
        eq(states, [`open ${host(3)}`]);
        eq(drawn.items.map((i) => i.label), ['Cancel', 'Remove'], 'the dialog: Cancel, Remove');
        app._states[host(3)].emit('visible', { visible: true });
        reset();
        app._components[proxy(3, 1)].emit('action', {});
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'uninstall', id: 'doom' }], 'Remove removes it');
        eq(states, [`close ${host(3)}`], 'and the dialog closes');
        eq(drawn.stack.length, 2);
        // BACK: as the HMI reports it, the page's state loses the focus and hides, the one below gets the focus
        app._states[host(2)].emit('focus', { focus: false });
        app._states[host(2)].emit('visible', { visible: false });
        app._states[host(1)].emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(drawn.stack.length, 1, 'BACK leaves the page');
        eq(gpu.visible, true, 'and the tabs show');
        eq(drawn.focus, 7, 'the focus back on the tile the page opened from');
        // touch: a tap on Renderer's tile opens it; Replace asks, then installs with replace
        reset();
        const tile = drawn.items.find((i) => i.label === 'Renderer');
        gpu.emit('touch', 'down', tile.x + 10, tile.y + 10);
        gpu.emit('touch', 'up', tile.x + 10, tile.y + 10);
        return tick();
    }).then(() => {
        eq(drawn.top(), { name: 'app', id: 'mgu-render' }, 'a tap opens the tile');
        const replace = drawn.items.find((i) => i.label === 'Replace GPU renderer');
        eq(!!replace, true, 'Replace on a second renderer\'s page');
        app._act(replace.act);
        return tick();
    }).then(() => {
        eq(drawn.top(), { name: 'confirm', kind: 'replace', id: 'mgu-render' });
        reset();
        app._act(drawn.items[1].act);
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'install', id: 'mgu-render', replace: true }]);
        drawn.pop();
        // a drag scrolls without pressing
        reset();
        app._act({ do: 'tab', tab: 'settings' });
        const row = drawn.items.find((i) => i.label === 'Accounts');
        app._act(row.act);
        return tick();
    }).then(() => {
        eq(drawn.top(), { name: 'accounts' });
        eq(drawn.items.some((i) => i.label === 'Sign in with GitHub'), true, 'Sign in with GitHub with state.signin');
        // the speller hides the renderer's picture while it is up (Add source)
        drawn.setTab('settings');
        spellerAnswers.push('o/r');
        app._act({ do: 'add-source' });
        eq(gpu.visible, false, 'hidden under the speller');
        return tick();
    }).then(() => {
        eq(gpu.visible, true, 'back after it');
        eq(drawn.top(), { name: 'channel' }, 'owner/repo: the channel page');
        reset();
        app._act({ do: 'channel', channel: 'tags' });
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ channel: 'tags', op: 'source-add', type: 'github', repo: 'o/r' }]);
        eq(drawn.stack.length, 1);
        // embed: FrontCCU's dial moves the focus and its push presses (the template's buttons get neither)
        eq(typeof frontCcu, mode === 'embed' ? 'function' : 'object', 'FrontCCU subscribed for embed only');
        if (mode === 'embed') {
            const ccu = (op, push) => frontCcu({ frontRotaryEncoderOperation: op, frontSequenceNumberOperatingElement: 0,
                frontRotaryEncoderPushButton: push || 'KEINE_BETAETIGUNG' });
            drawn.setTab('store');
            drawn.focus = 5;
            ccu(65534);
            ccu(1);
            eq(drawn.focus, 8, 'three detents over the counter\'s wrap');
            ccu(0);
            eq(drawn.focus, 7);
            reset();
            ccu(0, 'DREHGEBER_KURZ_GEDRUECKT');
            ccu(0, 'DREHGEBER_KURZ_GEDRUECKT');
            eq(drawn.top(), { name: 'app', id: 'doom' }, 'a push presses the focused tile (DOOM)');
            eq(states.length, 1, 'once while held');
            ccu(0);
            drawn.pop();
            drawn.focus = 5;
            drawn.controller = true;
            ccu(3);
            eq(drawn.focus, 5, 'with the controller gate the renderer\'s dial counts instead');
            drawn.controller = false;
        }
        // a popup over a layer page hides the layer
        if (mode === 'layer') {
            app._states[host(1)].emit('focus', { focus: false });
            eq(gpu.visible, false, 'layer: hidden under an HMI popup');
            app._states[host(1)].emit('focus', { focus: true });
            eq(gpu.visible, true);
        }
        // the renderer goes away (the Store updates it): the widget screens
        reset();
        gpu.emit('close');
        return tick();
    }).then(() => {
        eq(app._ui, 'widgets');
        eq(states.slice(0, 2), ['map ST_OnlineApps_Store', 'open ST_OnlineApps_Store'], 'the tile and the screen back on the widget screens');
        eq(states.slice(2).every((x) => /^close ST_OnlineApps_StoreLayer|^close ST_OnlineApps_StoreEmbed|^close ST_OnlineApps_Store[A-Z]/.test(x)), true,
            'the drawn screens\' states closed');
        eq(gpu.visible, false);
        // the renderer back, then shutting down with a page open: the connection ends, the screens stay
        gpu.emit('ready', { w: 1920, h: 720 }, { version: 1, modes: ['layer', 'embed'], embedBox: { x: 104, y: 88, w: 1796, h: 632 },
            appArea: { x: 108, y: 82, w: 1790, h: 638 }, controller: false });
        return tick();
    }).then(() => {
        eq(app._ui, mode, 'the drawn screens again once the renderer answers');
        drawn.stack.push({ name: 'app', id: 'doom' });
        gpuLog.length = 0;
        drawn.close();
        eq(gpuLog, ['close'], 'close() ends the connection whatever page is open');
        eq(app._ui, mode, 'without switching to the widget screens');
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

run().then(runWidgetsExtra).then(runDrawn).then(() => {
    cleanUp();
    console.log(`store: ${checks} checks pass`);
    process.exit(0);
}, (err) => {
    cleanUp();
    console.error(err);
    process.exit(1);
});
