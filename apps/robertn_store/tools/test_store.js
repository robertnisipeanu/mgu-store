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
const HIDE_MS = 800;                    // src/store.js HIDE_SETTLE_MS
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

        // owner/repo: the updater says what it has; its page opens once the focus is back from the speller
        reset();
        spellerAnswers.push(' robertnisipeanu/new-repo ');
        app._addSource();
        return tick();
    }).then(() => {
        eq(spellerTitles, ['Add source']);
        eq(sent.map(secretless), [{ op: 'source-probe', repo: 'robertnisipeanu/new-repo' }]);
        eq(sent[0].secret, 'deadbeef');
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Checking robertnisipeanu/new-repo');
        app._client.emit('probe', { type: 'probe', repo: 'robertnisipeanu/new-repo', status: 'ok', releases: true, tags: false,
            defaultBranch: 'dev', branches: ['main', 'dev', 'feature'], more: false });
        return tick();
    }).then(() => {
        eq(states, [], 'no page before the focus is back');
        app._states.ST_OnlineApps_StoreSources.emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(states, ['open ST_OnlineApps_StoreSourcePick'], 'then the picker');
        eq(last(/storeSourcesStatus\.Visible/), 'storeSourcesStatus.Visible=0', 'status cleared');
        eq(last(/storePickStatus\.0\.Text/), 'storePickStatus.0.Text=robertnisipeanu/new-repo');
        eq(last(/storePickList\.rows/), 'storePickList.rows=4');
        eq([0, 1, 2, 3].map((i) => [last(new RegExp(`storePickList\\.${i}\\.Text1stCol`)), last(new RegExp(`storePickList\\.${i}\\.Text2ndCol`))]
            .map((w) => w.split('=')[1]).join('|')), ['Releases|', 'main|Branch', 'dev|Default branch', 'feature|Branch'],
            'Releases (no Tags), then main, the default branch, the rest');
        eq(['storePickSignIn', 'storePickAddToken', 'storePickRetry'].map((n) => app._written[`${n}.visible`]), [false, false, false]);
        reset();
        app._components.storePickList.emit('action', { row: 2 });
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'source-add', type: 'github', repo: 'robertnisipeanu/new-repo', channel: 'branch:dev' }]);
        eq(states, ['close ST_OnlineApps_StoreSourcePick'], 'a pick adds it and closes the page');
        eq(app._pick, null);
        // the updater's refusal shows in the status line
        app._client.emit('reply-error', 'robertnisipeanu/new-repo is already a source', 'source-add');
        return tick();
    }).then(() => {
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Add source failed: robertnisipeanu/new-repo is already a source');

        // a github.com address, with a branch
        reset();
        spellerAnswers.push('https://github.com/o/r/tree/dev');
        app._addSource();
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'source-add', type: 'github', repo: 'o/r', channel: 'branch:dev' }], '.../tree/<branch>: added at once');

        // one thing to add it on: added on it, no page
        reset();
        spellerAnswers.push('o/one');
        app._addSource();
        return tick();
    }).then(() => {
        app._states.ST_OnlineApps_StoreSources.emit('focus', { focus: true });
        app._client.emit('probe', { type: 'probe', repo: 'o/one', status: 'ok', releases: false, tags: false, defaultBranch: 'trunk',
            branches: ['trunk'], more: false });
        return tick();
    }).then(() => {
        eq(sent.map(secretless).slice(-1), [{ op: 'source-add', type: 'github', repo: 'o/one', channel: 'branch:trunk' }]);
        eq(states, [], 'no page for one choice');

        // offline: the status line says so; an answer for another repo is not this one's
        reset();
        spellerAnswers.push('o/off');
        app._addSource();
        return tick();
    }).then(() => {
        app._client.emit('probe', { type: 'probe', repo: 'o/other', status: 'ok', releases: true, branches: ['main'] });
        app._client.emit('probe', { type: 'probe', repo: 'o/off', status: 'offline' });
        // no focus event: the page waits FOCUS_BACK_MS at most
        app._pick.timer._onTimeout();
        return tick();
    }).then(() => {
        eq(states, []);
        eq(sent.map(secretless), [{ op: 'source-probe', repo: 'o/off' }]);
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Add source failed: Offline');
        // an updater without source-probe: added as typed
        reset();
        spellerAnswers.push('o/old');
        app._addSource();
        return tick();
    }).then(() => {
        app._client.emit('reply-error', 'unknown op source-probe', 'source-probe');
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'source-probe', repo: 'o/old' }, { op: 'source-add', type: 'github', repo: 'o/old' }]);
        eq([states, app._pick], [[], null]);
        // already a source: the updater refuses the probe
        reset();
        spellerAnswers.push('someone/idrive7-apps');
        app._addSource();
        return tick();
    }).then(() => {
        app._client.emit('reply-error', 'someone/idrive7-apps is already a source', 'source-probe');
        app._states.ST_OnlineApps_StoreSources.emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Add source failed: someone/idrive7-apps is already a source');
        eq(states, []);

        // a private repo no account reaches: its page offers Sign in and Add token; a token added asks again
        reset();
        spellerAnswers.push('https://github.com/o/priv');
        app._addSource();
        return tick();
    }).then(() => {
        app._client.emit('probe', { type: 'probe', repo: 'o/priv', status: 'auth-needed' });
        app._states.ST_OnlineApps_StoreSources.emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(states, ['open ST_OnlineApps_StoreSourcePick']);
        eq(last(/storePickStatus\.0\.Text/), 'storePickStatus.0.Text=o/priv: Not found or private');
        eq(['storePickAddToken', 'storePickRetry', 'storePickList'].map((n) => app._written[`${n}.visible`]), [true, false, false]);
        app._states.ST_OnlineApps_StoreSourcePick.emit('visible', { visible: true });
        app._states.ST_OnlineApps_StoreSourcePick.emit('focus', { focus: true });
        reset();
        spellerAnswers.push('ghp_priv');
        app._components.storePickAddToken.emit('action', {});
        return tick();
    }).then(() => {
        eq(spellerTitles, ['GitHub token']);
        eq(sent.map(secretless), [{ op: 'token-add', token: 'ghp_priv' }]);
        eq(last(/storePickStatus\.0\.Text/), 'storePickStatus.0.Text=o/priv: Checking token');
        // the speller closed: the focus back on the picker, which stays
        app._states.ST_OnlineApps_StoreSourcePick.emit('focus', { focus: true });
        app._client.emit('state', Object.assign({}, ST, { tokens: ST.tokens.concat([{ id: 'cc33dd44', kind: 'github', label: 'priv',
            login: 'priv', addedAt: 1, rejected: false, usedBy: [] }]) }));
        return tick();
    }).then(() => {
        eq(sent.map(secretless).slice(-1), [{ op: 'source-probe', repo: 'o/priv' }], 'asked again with the new account');
        eq(states.filter((x) => /StoreSourcePick/.test(x)), [], 'the picker stays open');
        app._client.emit('probe', { type: 'probe', repo: 'o/priv', status: 'ok', releases: false, tags: true, defaultBranch: 'main',
            branches: ['main'], more: false });
        return tick();
    }).then(() => {
        eq(last(/storePickList\.rows/), 'storePickList.rows=2', 'Tags and main');
        eq(last(/storePickStatus\.0\.Text/), 'storePickStatus.0.Text=o/priv');
        reset();
        app._components.storePickList.emit('action', { row: 0 });
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'source-add', type: 'github', repo: 'o/priv', channel: 'tags' }]);
        eq(states, ['close ST_OnlineApps_StoreSourcePick']);
        app._client.emit('state', ST);
        app._endTokenAdd(null);

        // Add token's status from elsewhere does not show on a repo's page; one from the page shows until the next answer
        reset();
        app._accountNote({ kind: 'added', label: 'earlier' });
        spellerAnswers.push('o/stale');
        app._addSource();
        return tick();
    }).then(() => {
        app._client.emit('probe', { type: 'probe', repo: 'o/stale', status: 'auth-needed' });
        app._states.ST_OnlineApps_StoreSources.emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(last(/storePickStatus\.0\.Text/), 'storePickStatus.0.Text=o/stale: Not found or private', 'no stale Add token status');
        app._states.ST_OnlineApps_StoreSourcePick.emit('visible', { visible: true });
        reset();
        spellerAnswers.push('ghp_other');
        // the handler itself: a second press of the same button within 400 ms counts once
        app._pickAddToken();
        return tick();
    }).then(() => {
        eq(last(/storePickStatus\.0\.Text/), 'storePickStatus.0.Text=o/stale: Checking token', 'Add token from the page: its status there');
        app._client.emit('state', Object.assign({}, ST, { tokens: ST.tokens.concat([{ id: 'ab12cd34', kind: 'github', label: 'other',
            login: 'other', addedAt: 1, rejected: false, usedBy: [] }]) }));
        return tick();
    }).then(() => {
        eq(sent.map(secretless).slice(-1), [{ op: 'source-probe', repo: 'o/stale' }]);
        app._client.emit('probe', { type: 'probe', repo: 'o/stale', status: 'auth-needed' });
        return tick();
    }).then(() => {
        eq(last(/storePickStatus\.0\.Text/), 'storePickStatus.0.Text=o/stale: Not found or private', 'an account that does not reach it');
        // BACK leaves the page: the repo is no longer being added, and an account change asks nothing
        reset();
        app._states.ST_OnlineApps_StoreSourcePick.emit('visible', { visible: false });
        app._states.ST_OnlineApps_StoreSources.emit('visible', { visible: true });
        return tick(HIDE_MS + 100);
    }).then(() => {
        eq(app._pick, null, 'BACK ends it');
        app._client.emit('state', ST);
        return tick();
    }).then(() => {
        eq(sent.filter((r) => r.op === 'source-probe'), [], 'nothing asked after BACK');
        app._endTokenAdd(null);

        // nothing a channel takes (a branch named so no channel takes it): added as typed
        reset();
        spellerAnswers.push('o/odd');
        app._addSource();
        return tick();
    }).then(() => {
        app._client.emit('probe', { type: 'probe', repo: 'o/odd', name: 'O/odd', status: 'ok', releases: false, tags: false,
            defaultBranch: null, branches: [], more: false });
        app._states.ST_OnlineApps_StoreSources.emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(sent.map(secretless).slice(-1), [{ op: 'source-add', type: 'github', repo: 'O/odd' }]);
        eq(states, []);

        // no answer: the status line says so after PROBE_MS; the updater going away says so at once
        reset();
        spellerAnswers.push('o/slow');
        app._addSource();
        return tick();
    }).then(() => {
        app._pick.answerTimer._onTimeout();
        app._states.ST_OnlineApps_StoreSources.emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Add source failed: the updater did not answer');
        eq(app._pick, null);
        reset();
        spellerAnswers.push('o/gone');
        app._addSource();
        return tick();
    }).then(() => {
        app._states.ST_OnlineApps_StoreSources.emit('focus', { focus: true });
        app._client.emit('down');
        return tick();
    }).then(() => {
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Add source failed: updater not running');
        app._client.emit('state', ST);
        // on an open page: Try again
        reset();
        spellerAnswers.push('o/page');
        app._addSource();
        return tick();
    }).then(() => {
        app._client.emit('probe', { type: 'probe', repo: 'o/page', status: 'auth-needed' });
        app._states.ST_OnlineApps_StoreSources.emit('focus', { focus: true });
        return tick();
    }).then(() => {
        app._states.ST_OnlineApps_StoreSourcePick.emit('visible', { visible: true });
        app._client.emit('state', Object.assign({}, ST, { tokens: ST.tokens.slice(0, 1) }));
        return tick();
    }).then(() => {
        eq(sent.map(secretless).slice(-1), [{ op: 'source-probe', repo: 'o/page' }]);
        app._client.emit('down');
        return tick();
    }).then(() => {
        eq([last(/storePickStatus\.0\.Text/), app._written['storePickRetry.visible']], ['storePickStatus.0.Text=o/page: updater not running', true]);
        app._client.emit('state', ST);
        reset();
        app._components.storePickRetry.emit('action', {});
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'source-probe', repo: 'o/page' }], 'Try again asks again');
        app._client.emit('probe', { type: 'probe', repo: 'o/page', status: 'ok', releases: false, tags: false, defaultBranch: null,
            branches: [], more: false });
        return tick();
    }).then(() => {
        eq(sent.map(secretless).slice(-1), [{ op: 'source-add', type: 'github', repo: 'o/page' }], 'nothing listed on the page: added as typed');
        eq(states.slice(-1), ['close ST_OnlineApps_StoreSourcePick']);
        app._states.ST_OnlineApps_StoreSourcePick.emit('visible', { visible: false });

        // what is neither: the status line says so
        reset();
        spellerAnswers.push('https://github.com/o');
        app._addSource();
        return tick();
    }).then(() => {
        eq(sent, []);
        eq(last(/storeSourcesStatus\.0\.Text/), 'storeSourcesStatus.0.Text=Not owner/repo or https://host/path: https://github.com/o');

        // Add token: the speller, token-add, Checking token, then the account it added
        reset();
        spellerAnswers.push(' ghp_x1 ');
        app._addToken();
        return tick();
    }).then(() => {
        eq(spellerTitles, ['GitHub token']);
        eq(sent.map(secretless), [{ op: 'token-add', token: 'ghp_x1' }]);
        eq(last(/storeAccountsStatus\.0\.Text/), 'storeAccountsStatus.0.Text=Checking token');
        app._client.emit('state', Object.assign({}, ST, { tokens: ST.tokens.concat([{ id: 'aa11bb22', kind: 'github', label: 'octo',
            login: 'octo', addedAt: 1, rejected: false, usedBy: [] }]) }));
        return tick();
    }).then(() => {
        eq(last(/storeAccountsStatus\.0\.Text/), 'storeAccountsStatus.0.Text=Added octo');
        eq(app._tokenAdding, null);
        app._client.emit('state', ST);
        // one GitHub refuses
        reset();
        spellerAnswers.push('bad');
        app._addToken();
        return tick();
    }).then(() => {
        app._client.emit('reply-error', 'GitHub does not accept this token', 'token-add');
        return tick();
    }).then(() => {
        eq(last(/storeAccountsStatus\.0\.Text/), 'storeAccountsStatus.0.Text=Add token failed: GitHub does not accept this token');
        eq(app._tokenAdding, null);
        // left without OK: nothing sent
        reset();
        spellerAnswers.push(null);
        app._addToken();
        return tick();
    }).then(() => {
        eq(sent, []);
        eq(last(/storeAccountsStatus\.Visible/), 'storeAccountsStatus.Visible=0', 'status cleared');
        // a token the updater had already: no new account; the timeout clears the line, a visibility change in between or not
        reset();
        spellerAnswers.push('ghp_known');
        app._addToken();
        return tick();
    }).then(() => {
        eq(last(/storeAccountsStatus\.0\.Text/), 'storeAccountsStatus.0.Text=Checking token');
        app._client.emit('state', ST);
        app._setVisible(false);
        app._setVisible(true);
        eq(app._tokenAdding.timer._destroyed, false, 'the timeout still runs');
        app._tokenAdding.timer._onTimeout();
        return tick();
    }).then(() => {
        eq([app._tokenAdding, last(/storeAccountsStatus\.Visible/)], [null, 'storeAccountsStatus.Visible=0']);
        // the updater down: nothing sent, the line says so
        app._client.emit('down');
        reset();
        spellerAnswers.push('ghp_x2');
        app._addToken();
        return tick();
    }).then(() => {
        eq(sent, []);
        eq(last(/storeAccountsStatus\.0\.Text/), 'storeAccountsStatus.0.Text=Add token failed: updater not running');
        eq(app._tokenAdding, null);
        app._client.emit('state', ST);

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

/* The widget screens: compatibility, a second renderer, Sign in with GitHub, the GitHub App's install page. */
function runWidgetsExtra() {
    const renderer = comp({ id: 'mgu-render', kind: 'tool', title: 'Renderer', version: '0.1.0', installed: null, status: 'available',
        provides: 'renderer' });
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
        eq([states, sent], [[], [{ op: 'install', id: 'mgu-render' }]], 'a second renderer installs beside the first, no confirm step');
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
            comp({ id: 'gauges', title: 'Gauges', version: '1.2.0', installed: null, status: 'available' }),
            comp({ id: 'mgu-render', kind: 'tool', title: 'Renderer', version: '0.1.0', installed: null, status: 'available',
                provides: 'renderer' }),
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
        eq(gpuLog.slice(0, 2), [`mode ${mode}`, mode === 'embed' ? 'place 104,88 1796x632 1.000' : 'place 108,82 1790x638 1.000'],
            'iDrive 7: the compact layout, at scale 1');
        eq(states.slice(0, 2), [`map ${host(1)}`, `open ${host(1)}`], 'the tile maps to the drawn screens; the Store on screen moves there');
        app._states[host(1)].emit('visible', { visible: true });
        return tick();
    }).then(() => {
        eq(gpu.visible, true, 'shown with its host state');
        eq(gpu.claims, [mode === 'embed' ? { x: 0, y: 0, w: 1796, h: 632 } : { x: 0, y: 0, w: 1790, h: 638 }], 'touch claimed: the box');
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
        eq({ name: drawn.top().name, id: drawn.top().id }, { name: 'app', id: 'doom' });
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
        // touch: a tap on Renderer's tile opens it; Install installs it beside the other renderer
        reset();
        const tile = drawn.items.find((i) => i.label === 'Renderer');
        gpu.emit('touch', 'down', tile.x + 10, tile.y + 10);
        gpu.emit('touch', 'up', tile.x + 10, tile.y + 10);
        return tick();
    }).then(() => {
        eq({ name: drawn.top().name, id: drawn.top().id }, { name: 'app', id: 'mgu-render' }, 'a tap opens the tile');
        const install = drawn.items.find((i) => i.label === 'Install');
        eq(!!install && !drawn.items.some((i) => /Replace/.test(i.label || '')), true, 'Install on a second renderer\'s page, no Replace');
        reset();
        app._act(install.act);
        return tick();
    }).then(() => {
        eq(sent, [{ op: 'install', id: 'mgu-render' }]);
        // a drag scrolls without pressing
        reset();
        app._act({ do: 'tab', tab: 'settings' });
        const row = drawn.items.find((i) => i.label === 'Accounts');
        app._act(row.act);
        return tick();
    }).then(() => {
        eq(drawn.top(), { name: 'accounts' });
        eq(drawn.items.some((i) => i.label === 'Sign in with GitHub'), true, 'Sign in with GitHub with state.signin');
        eq(drawn.items.find((i) => i.label === 'Add token').act, { do: 'add-token' });
        // the speller hides the renderer's picture while it is up (Add source)
        drawn.setTab('settings');
        spellerAnswers.push('o/r');
        app._act({ do: 'add-source' });
        eq(gpu.visible, false, 'hidden under the speller');
        return tick();
    }).then(() => {
        eq(gpu.visible, true, 'back after it');
        eq(sent.slice(-1).map(secretless), [{ op: 'source-probe', repo: 'o/r' }], 'owner/repo: what it has, asked');
        // as the HMI reports it: the updater answers while the speller still closes; then the focus comes back to Settings
        app._client.emit('probe', { type: 'probe', repo: 'o/r', status: 'auth-needed' });
        return tick();
    }).then(() => {
        eq(drawn.stack.length, 1, 'no page opened under the closing speller');
        reset();
        app._states[host(1)].emit('visible', { visible: true });
        app._states[host(1)].emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(states, [`open ${host(2)}`], 'the picker once the focus is back');
        eq(drawn.top(), { name: 'pick' });
        app._states[host(1)].emit('focus', { focus: false });
        app._states[host(2)].emit('visible', { visible: true });
        app._states[host(2)].emit('focus', { focus: true });
        return tick();
    }).then(() => {
        eq(drawn.items.map((i) => i.label).filter((l) => /Sign in|Add token|Try again/.test(l)), ['Sign in with GitHub', 'Add token'],
            'a repo no account reaches: Sign in, Add token');
        // Add token from the picker: the speller, then the focus back on the picker, which stays
        reset();
        spellerAnswers.push('ghp_drawn');
        app._act(drawn.items.find((i) => i.label === 'Add token').act);
        app._states[host(2)].emit('focus', { focus: false });
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'token-add', token: 'ghp_drawn' }]);
        app._states[host(2)].emit('visible', { visible: true });
        app._states[host(2)].emit('focus', { focus: true });
        app._client.emit('state', Object.assign({}, st, { tokens: st.tokens.concat([{ id: 'ee55ff66', kind: 'github', label: 'drawn',
            login: 'drawn', addedAt: 1, rejected: false, usedBy: [] }]) }));
        return tick();
    }).then(() => {
        eq(drawn.top(), { name: 'pick' }, 'the picker survives the speller');
        eq(sent.map(secretless).slice(-1), [{ op: 'source-probe', repo: 'o/r' }], 'asked again with the new account');
        app._client.emit('probe', { type: 'probe', repo: 'o/r', name: 'Owner/R', status: 'ok', releases: true, tags: true, defaultBranch: 'main',
            branches: ['main', 'dev'], more: false });
        return tick();
    }).then(() => {
        const labels = drawn.items.map((i) => i.label);
        eq(['Releases', 'Tags', 'main', 'dev'].every((l) => labels.indexOf(l) >= 0), true, `the choices: ${labels}`);
        reset();
        app._components[proxy(2, labels.indexOf('dev'))].emit('action', {});
        return tick();
    }).then(() => {
        eq(sent.map(secretless), [{ op: 'source-add', type: 'github', repo: 'Owner/R', channel: 'branch:dev' }],
            'the pick adds it, as GitHub spells it');
        eq(states, [`close ${host(2)}`]);
        eq(drawn.stack.length, 1);
        app._client.emit('state', st);
        app._endTokenAdd(null);
        // embed: FrontCCU's dial moves the focus and its push presses (the template's buttons get neither)
        eq(typeof frontCcu, mode === 'embed' ? 'function' : 'object', 'FrontCCU subscribed for embed only');
        if (mode === 'embed') {
            const ccu = (op, push, seq) => frontCcu({ frontRotaryEncoderOperation: op, frontSequenceNumberOperatingElement: seq || 0,
                frontRotaryEncoderPushButton: push || 'KEINE_BETAETIGUNG' });
            eq(drawn.embedProxies, true, 'the stand-in HMI pressed an embed proxy above');
            ccu(0);
            drawn.focus = 5;
            ccu(2);
            eq(drawn.focus, 5, 'FrontCCU stands down while the HMI drives the embed proxies');
            drawn.embedProxies = false;
            drawn.setTab('store');
            ccu(65534);
            drawn.focus = 5;
            ccu(1);
            eq(drawn.focus, 8, 'three detents over the counter\'s wrap');
            ccu(65535);
            ccu(0);
            eq(drawn.focus, 7, 'an invalid counter keeps the last valid one');
            ccu(100);
            eq(drawn.focus, 7, 'a jump past 24 detents is ignored');
            ccu(99);
            eq(drawn.focus, 6);
            drawn.focusLost = true;
            ccu(100);
            eq(drawn.focus, 6, 'nothing while an HMI popup has the focus');
            drawn.focusLost = false;
            ccu(101);
            eq(drawn.focus, 7);
            reset();
            ccu(101, 'DREHGEBER_KURZ_GEDRUECKT');
            ccu(101, 'DREHGEBER_KURZ_GEDRUECKT');
            ccu(101, 'SIGNAL_UNGUELTIG', 5);
            ccu(101, 'DREHGEBER_KURZ_GEDRUECKT');
            eq({ name: drawn.top().name, id: drawn.top().id }, { name: 'app', id: 'doom' }, 'a push presses the focused tile (DOOM)');
            eq(states.length, 1, 'once while held, an invalid sample in between');
            ccu(101);
            drawn.pop();
            drawn.focus = 7;
            reset();
            ccu(101, 'DREHGEBER_KURZ_GEDRUECKT', 1);
            drawn.pop();
            drawn.focus = 7;
            ccu(101, 'DREHGEBER_KURZ_GEDRUECKT', 2);
            eq(states.filter((x) => x.indexOf('open') === 0).length, 2, 'a new sequence number while pushed is a new push');
            ccu(101);
            drawn.pop();
            drawn.focus = 5;
            drawn.controller = true;
            ccu(103);
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
