/**
 * store - the Store: the apps and head-unit tools of every source, each
 * with its state, the progress of the running install, the sources, and
 * the phone page.
 *
 * Two sets of screens show the same: the ones mgu-render draws
 * (src/store_drawn.js, src/store_frame.js, src/store_ui.js), while it runs and speaks
 * mgu-render/1, and the HMI's own widgets otherwise (below), which take
 * over whenever the renderer goes away (while the Store installs or
 * updates it) and hand back when it is there again. The tile opens the
 * entry state of the screens in use: mapEntryState follows the renderer.
 *
 * The app holds no install logic. mgu-updater (native/mgu-updater), the
 * root daemon, reads the sources' catalogs, downloads and installs; this app
 * shows the state it streams over its socket and sends it requests: "check"
 * (Check for updates), "install <id>" (a row whose component is not
 * installed, has an update, or failed), "reboot" (Restart head unit, once
 * confirmed), and the privileged ones, which carry the secret the updater
 * leaves in this app's data folder: "uninstall" (a removable installed
 * component, once confirmed), "source-add", "source-probe", "source-remove", "token-add",
 * "token-remove" (an account, once confirmed), "login-start" / "login-cancel" (GitHub
 * sign-in, which adds an account) and "web" (Phone access on or off).
 *
 * The start screen has the status line, Check for updates, the progress of
 * the running install, the rows Apps and Head-unit tools, which open their
 * lists, Sources and Phone access (shown when the updater reports them),
 * and Restart head unit, which opens its confirm step (Cancel, Restart). A
 * list is one component with a row per catalog component of that kind:
 *
 *   DOOM                        Update 1.0.1      (installed 1.0.0)
 *   Vehicle control             Installed 1.0.0
 *   Extended dashboard          42%               (downloading)
 *
 * Sources has a status line (a source typed wrong, the updater's refusal to
 * add or remove one), lists each source with its status or the account that
 * reads it and opens its page (Channel, Account, Components, Remove). Add
 * source opens the HMI's speller (src/speller.js) for owner/repo, a
 * github.com address of a repo (.../tree/<branch>: that branch) or another
 * https address (a catalog), and adds it. A repo without a branch is first
 * asked about ("source-probe"): it is added on the one thing it has, else
 * its page lists what it has (Releases, Tags, its branches) to pick from,
 * or, while no account reaches it, Sign in with GitHub and Add token. A USB
 * stick's sources the updater lists by itself. Accounts has a status line (a token being checked, added
 * or refused), lists the updater's tokens, each with the sources it reads; a
 * press opens its Remove confirm step. Sign in with GitHub adds one, and so
 * does Add token, which takes a token typed in the speller. The updater picks
 * the account for each source itself. Phone access is linked from Sources
 * too.
 *
 * An app install runs in place, or else restarts MainApp's app processes,
 * this one included; the updater carries on, and the Store shows the result
 * when opened again.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const { UpdaterClient } = require('./client.js');
const { qrPng } = require('./qr.js');
const { spell } = require('./speller.js');
const { Drawn } = require('./store_drawn.js');
const { PHASE, percent, rowState, rowAction, groupState, statusLine, sourceLabel, sourceState,
    sourcesState, sourceActions, sourceChannel, sourceAccount, tokenLabel, tokenState, tokenSources, accountsState,
    loginStatus, loginCode, phoneState, phoneAddress, parseSource, pickOptions, probeStatus, sourcesMessage, tokenMessage,
    removable } = require('./store_view.js');

const logger = logging.getSDKLogger();

const SOCKET = '/dev/shm/mgu-updater/updater.sock';
/* The updater writes the privileged secret, and while the phone page is on
 * its access URL, into this app's data folder (owner this app's uid, 0400);
 * both are read again on every use. */
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, 'updater-secret');
const WEB_URL_FILE = path.join(DATA_DIR, 'web-url');
const RECONNECT_MS = 2000;
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const WEB_URL_POLL_MS = 1000;           // web-url re-read while Phone access is open and on
const ROW_KEY = 2;                      // a press's row in a raw userEvent's parameterMap
const VALUE_KEY = 0;                    // a focus event's value
const QR_PREFIX = 'qr_';
const RENDERER_WAIT_MS = 1500;          // at start, how long the renderer may take to answer
const TOKEN_ADD_MS = 30000;             // how long Add token says "Checking token" without an answer
const FOCUS_BACK_MS = 2000;             // how long a page waits for the HMI to give the focus back from the speller
const IF_FRONTCCU = 'de.bmw.infotainment.controlelements.FrontCCU';

/* The drawn screens' host states and their proxies (tools/gen_rhmi.js). */
const PROXIES = [48, 24, 12];
const HOST_NAMES = { layer: 'Layer', embed: 'Embed' };
const hostName = (mode, depth) => `ST_OnlineApps_Store${HOST_NAMES[mode]}${depth}`;
const proxyName = (mode, depth, i) => `store${HOST_NAMES[mode]}${depth}P${i}`;
/* The entry state of each set of screens. */
const ROOTS = { widgets: 'ST_OnlineApps_Store', layer: hostName('layer', 1), embed: hostName('embed', 1) };

/* iDrive 8's widgets name their cells differently (LT_Button_MediaEntry_1Row). */
const ID8_CELLS = { Text: 'PrimaryText', Text1stCol: 'PrimaryText', Text2ndCol: 'FrequencyText', TextLeft: 'PrimaryText',
    TextRight: 'FrequencyText' };
const ID8_LABELS = new Set(['storeStatus', 'storeSourcesStatus', 'storeSrcError', 'storeAccountsStatus', 'storeAccountName',
    'storeAccountSources', 'storeLoginCode', 'storeLoginUrl', 'storeLoginStatus', 'storeRemoveName', 'storePhoneUrl',
    'storePhoneError', 'storeSrcAppLabel', 'storeSrcAppUrl', 'storePickStatus']);

/* tools/gen_rhmi.js */
const S = {
    main: 'ST_OnlineApps_Store',
    restart: 'ST_OnlineApps_StoreRestart',
    sources: 'ST_OnlineApps_StoreSources',
    source: 'ST_OnlineApps_StoreSource',
    pick: 'ST_OnlineApps_StoreSourcePick',
    accounts: 'ST_OnlineApps_StoreAccounts',
    accountRemove: 'ST_OnlineApps_StoreAccountRemove',
    login: 'ST_OnlineApps_StoreLogin',
    sourceRemove: 'ST_OnlineApps_StoreSourceRemove',
    remove: 'ST_OnlineApps_StoreRemove',
    phone: 'ST_OnlineApps_StorePhone'
};
const LISTS = {
    app: { state: 'ST_OnlineApps_StoreApps', nav: 'storeNavApps', list: 'storeAppList' },
    tool: { state: 'ST_OnlineApps_StoreTools', nav: 'storeNavTools', list: 'storeToolList' }
};
const KINDS = Object.keys(LISTS);
const C = { status: 'storeStatus', check: 'storeCheck', progress: 'storeProgress', restart: 'storeRestart',
    navSources: 'storeNavSources', navPhone: 'storeNavPhone',
    restartCancel: 'storeRestartCancel', restartConfirm: 'storeRestartConfirm',
    sourcesStatus: 'storeSourcesStatus', sourceList: 'storeSourceList', sourceAdd: 'storeSourceAdd',
    sourcePhone: 'storeSourcePhone', sourceAccounts: 'storeSourceAccounts',
    srcStatus: 'storeSrcStatus', srcChannel: 'storeSrcChannel', srcAccount: 'storeSrcAccount', srcComponents: 'storeSrcComponents',
    srcError: 'storeSrcError', srcRemove: 'storeSrcRemove',
    pickStatus: 'storePickStatus', pickList: 'storePickList', pickSignIn: 'storePickSignIn', pickAddToken: 'storePickAddToken',
    pickRetry: 'storePickRetry',
    accountsStatus: 'storeAccountsStatus', accountList: 'storeAccountList', accountSignIn: 'storeAccountSignIn',
    accountAddToken: 'storeAccountAddToken', accountName: 'storeAccountName',
    accountSources: 'storeAccountSources', accountRemoveCancel: 'storeAccountRemoveCancel', accountRemoveConfirm: 'storeAccountRemoveConfirm',
    loginQr: 'storeLoginQr', loginCode: 'storeLoginCode', loginUrl: 'storeLoginUrl',
    loginStatus: 'storeLoginStatus', loginCancel: 'storeLoginCancel',
    srcRemoveCancel: 'storeSrcRemoveCancel', srcRemoveConfirm: 'storeSrcRemoveConfirm',
    removeName: 'storeRemoveName', removeCancel: 'storeRemoveCancel', removeConfirm: 'storeRemoveConfirm',
    srcAppLabel: 'storeSrcAppLabel', srcAppQr: 'storeSrcAppQr', srcAppUrl: 'storeSrcAppUrl',
    phoneToggle: 'storePhoneToggle', phoneQr: 'storePhoneQr', phoneUrl: 'storePhoneUrl',
    phoneError: 'storePhoneError' };
/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

const isPage = (name) => (p) => p.name === name;
const isConfirm = (kind) => (p) => p.name === 'confirm' && p.kind === kind;

function readFile(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (e) {
        return '';
    }
}

function readSecret() {
    return readFile(SECRET_FILE).trim() || null;
}

/* The HMI reads pictures as another user: QR codes live in a world-readable
 * folder in RAM. */
function qrDir() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'x';
    return path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), `robertn_store_qr_${uid}`);
}

function removeStaleQr() {
    const dir = qrDir();
    try {
        fs.readdirSync(dir).filter((n) => n.indexOf(QR_PREFIX) === 0)
            .forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* not ours */ } });
    } catch (e) {
        /* no folder yet */
    }
}

class Store extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._states = {};
        this._visibleStates = new Set();
        this._hideTimer = null;
        this._webUrlTimer = null;
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._components = {};
        this._actionById = {};
        this._focusById = {};
        this._lastPress = {};
        this._written = {};
        this._rows = { app: [], tool: [], source: [], token: [], pick: [] };
        this._sizing = {};              // lists whose row count is being set
        this._sourceId = null;          // the source whose page is open
        this._removingSource = null;    // the source this Store asked the updater to remove
        this._removalRefused = false;
        this._focusedPage = null;       // the page the HMI last gave its focus: a widget state, or 'drawn:<page>'
        this._removeId = null;          // the component the Remove confirm step names
        this._tokenId = null;           // the account the Remove account confirm step names
        /* The sign-in this app started: waiting until the updater reports it
         * pending, or the updater's refusal. */
        this._login = { waiting: false, refusal: null };
        this._lastOp = null;            // the last request sent, which a reply without its op answers
        this._spellSeq = 0;             // only the latest speller's text counts
        this._sourcesNote = '';         // the Sources page's status line
        this._accountsNote = { text: '', error: false };   // the Accounts page's status line
        this._tokenAdding = null;       // a token-add sent: { before (the token ids then), timer }
        /* The GitHub repo being added: { repo, probe (the updater's answer,
         * null while it looks), tokens (the token ids it was asked with),
         * back (the HMI has given the focus back from the speller), timer,
         * open (its page was opened) }. */
        this._pick = null;
        this._qr = { login: { key: null, file: null, chain: Promise.resolve() },
            phone: { key: null, file: null, chain: Promise.resolve() }, app: { key: null, file: null, chain: Promise.resolve() } };
        this._hmi = 'ID7';
        this._ui = 'widgets';           // the screens in use: widgets, layer or embed
        this._entryUuid = null;         // the tile's entry point, once registered
        this._hostModes = [];
        this._drawn = new Drawn({
            log: logger,
            model: () => this._drawnModel(),
            act: (act) => this._act(act),
            set: (name, text) => this._set(name, 'Text', text, 'Text'),
            show: (name, on) => this._show(name, on),
            openState: (name) => this._openState(name),
            closeState: (name) => this._closeState(name),
            hostName,
            proxyName,
            proxies: PROXIES,
            modes: this._hostModes
        });
        this._drawn.on('mode', (mode) => this._useUi(mode || 'widgets'));
        this._drawn.on('page-focus', (page) => {
            this._focusedPage = `drawn:${page.name}`;
            this._render();
        });
        this._st = null;
        this._connected = false;
        this._client = new UpdaterClient(SOCKET, { reconnectMs: RECONNECT_MS });
        this._client.on('state', (st) => {
            this._connected = true;
            this._st = st;
            this._tokenAdded(st);
            this._reprobe();
            this._render();
        });
        this._client.on('probe', (answer) => this._probed(answer));
        this._client.on('down', () => {
            if (this._connected) {
                logger.info('updater unreachable; reconnecting');
            }
            this._connected = false;
            this._render();
        });
        this._client.on('reply-error', (msg, op) => {
            // replies come in request order, so one without its op answers the last request
            const forOp = op || this._lastOp;
            this._lastOp = null;
            logger.warn(`updater refused ${forOp}: ${msg}`);
            if (forOp === 'login-start' && this._login.waiting) {
                this._login = { waiting: false, refusal: String(msg) };
                this._render();
            } else if (forOp === 'source-probe' && this._pick && /^unknown op/.test(String(msg))) {
                // an updater before 0.8.0: the repo is added as typed, and the updater picks
                const repo = this._pick.repo;
                this._endPick();
                this._note(null);
                this._sendSource({ type: 'github', repo });
            } else if (forOp === 'source-probe' && this._pick && !this._pick.probe) {
                this._probed({ type: 'probe', repo: this._pick.repo, status: 'refused', error: String(msg) });
            } else if (forOp === 'token-add' && this._tokenAdding) {
                this._endTokenAdd({ kind: 'refused', error: String(msg) });
            } else if (forOp === 'source-add' || forOp === 'source-remove') {
                // a refused removal goes back to Sources, which shows why
                if (forOp === 'source-remove') {
                    this._removalRefused = true;
                }
                this._note({ kind: 'refused', op: forOp, error: String(msg) });
            }
        });

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error(`store init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) {
                this._visibleStates.clear();
                this._setVisible(false);
            }
        });
    }

    _appInitialized() {
        logger.info(`store ${this.getAppId()} v${this._packageJson.version} starting`);
        this._client.connect();
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._setupController())
            .then(() => this._rendererAnswer())
            .then(() => this._registerEntryPoints())
            .then(() => {
                if (foregroundStart) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid &&
                    this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK',
            'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.includes(reason);
    }

    /* The controller for the drawn screens in embed mode (src/store_drawn.js
     * frontCcu). Without it they take touch only. */
    _setupController() {
        if (this._hostModes.indexOf('embed') < 0) {
            return;
        }
        let proxy;
        someipBuilders.buildTypedProxy(IF_FRONTCCU, '1')
            .then((p) => { proxy = p; return proxy.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => proxy.statusRotaryEncoderState.subscribe((s) => this._drawn.frontCcu(s)))
            .then(() => logger.info('FrontCCU controller subscribed'))
            .catch((err) => logger.warn(`FrontCCU controller unavailable: ${err && err.message}`));
    }

    /* ---- RHMI ---- */

    /* At start the renderer's answer decides the first screens, unless it
     * takes longer than RENDERER_WAIT_MS. */
    _rendererAnswer() {
        this._drawn.connect();
        if (!this._hostModes.length) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this._drawn.removeListener('mode', done);
                this._drawn.gpu.removeListener('ready', done);
                resolve();
            };
            const timer = setTimeout(done, RENDERER_WAIT_MS);
            this._drawn.gpu.once('ready', done);
            this._drawn.on('mode', done);
        });
    }

    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        const stateNames = Object.values(S).concat(KINDS.map((k) => LISTS[k].state));
        for (const name of stateNames) {
            this._states[name] = rhmi.getByName(name);
            if (!this._states[name]) {
                return Promise.reject(new Error(`uiDescription has no ${name}`));
            }
        }
        this._state = this._states[S.main];
        this._hmi = rhmi.getByName('storeHmiID8') ? 'ID8' : 'ID7';
        // the drawn screens' host states this HMI's description has (iDrive 8: no embed)
        const hosts = [];
        Object.keys(HOST_NAMES).forEach((mode) => {
            const names = PROXIES.map((n, d) => hostName(mode, d + 1));
            if (names.every((n) => rhmi.getByName(n))) {
                this._hostModes.push(mode);
                names.forEach((n, d) => hosts.push({ name: n, mode, depth: d + 1 }));
            }
        });
        hosts.forEach((h) => {
            this._states[h.name] = rhmi.getByName(h.name);
            stateNames.push(h.name);
            this._states[h.name].on('focus', (ev) => {
                logger.info(`${h.name} focus ${isTrue(ev && ev.focus)}`);
                if (h.mode === this._ui) {
                    this._drawn.hostFocus(h.depth, isTrue(ev && ev.focus));
                }
            });
            for (let i = 0; i < PROXIES[h.depth - 1]; i++) {
                const name = proxyName(h.mode, h.depth, i);
                this._components[name] = rhmi.getByName(name);
                this._bind(name, () => {
                    if (h.mode === this._ui) {
                        this._drawn.proxyPress(h.depth, i);
                    }
                });
                this._bindFocus(name, (value) => {
                    if (h.mode === this._ui) {
                        this._drawn.proxyFocus(h.depth, i, value);
                    }
                });
            }
        });
        this._hosts = hosts;
        const names = Object.values(C);
        KINDS.forEach((kind) => names.push(LISTS[kind].nav, LISTS[kind].list));
        names.forEach((name) => {
            this._components[name] = rhmi.getByName(name);
            if (!this._components[name]) {
                logger.warn(`BIND MISS: ${name} not found in uiDescription`);
            }
        });
        removeStaleQr();
        this._bind(C.check, () => this._send({ op: 'check' }));
        this._bind(C.restart, () => this._openState(S.restart));
        this._bind(C.restartCancel, () => this._closeState(S.restart));
        this._bind(C.restartConfirm, () => this._restart());
        KINDS.forEach((kind) => {
            this._bind(LISTS[kind].nav, () => this._openState(LISTS[kind].state));
            this._bind(LISTS[kind].list, (row) => this._onRow(kind, row));
        });
        this._bind(C.removeCancel, () => this._closeState(S.remove));
        this._bind(C.removeConfirm, () => this._remove());
        this._bind(C.navSources, () => this._openState(S.sources));
        this._bind(C.sourceList, (row) => this._onSource(row));
        this._bind(C.sourceAdd, () => this._addSource());
        this._bind(C.sourcePhone, () => this._openState(S.phone));
        this._bind(C.srcRemove, () => this._openState(S.sourceRemove));
        this._bind(C.sourceAccounts, () => this._openState(S.accounts));
        this._bind(C.accountList, (row) => this._onAccount(row));
        this._bind(C.accountSignIn, () => this._signIn());
        this._bind(C.accountAddToken, () => this._addToken());
        this._bind(C.accountRemoveCancel, () => this._closeState(S.accountRemove));
        this._bind(C.accountRemoveConfirm, () => this._removeAccount());
        this._bind(C.srcRemoveCancel, () => this._closeState(S.sourceRemove));
        this._bind(C.srcRemoveConfirm, () => this._removeSource());
        this._bind(C.loginCancel, () => this._cancelSignIn());
        this._bind(C.pickList, (row) => this._pickChannel(this._rows.pick[row]));
        this._bind(C.pickSignIn, () => this._signIn());
        this._bind(C.pickAddToken, () => this._addToken());
        this._bind(C.pickRetry, () => this._probe());
        this._bind(C.navPhone, () => this._openState(S.phone));
        this._bind(C.phoneToggle, () => this._togglePhone());
        // Presses also arrive as the application's raw 'userEvent'; both paths
        // land in _press, which keeps a press delivered twice to one.
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler, Number((ev.parameterMap || {})[ROW_KEY]) || 0);
            }
            const focus = ev && ev.eventType === 'FOCUS' && this._focusById[Number(ev.sourceId)];
            if (focus) {
                focus(isTrue((ev.parameterMap || {})[VALUE_KEY]));
            }
        });
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._visibleStates.clear();
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            logger.info('RESTORE_HMI: re-pushing page content');
            this._forgetWritten();
            this._render();
        });
        // The app counts as visible while any of its states is: moving between
        // them hides one before showing the next, so a hide only takes effect
        // if nothing became visible meanwhile.
        // the page in focus: a confirm step closing gives it back to the page below
        stateNames.filter((name) => !hosts.some((h) => h.name === name)).forEach((name) => this._states[name].on('focus', (ev) => {
            if (isTrue(ev && ev.focus)) {
                this._focusedPage = name;
                this._render();
            }
        }));
        stateNames.forEach((name) => this._states[name].on('visible', (event) => {
            const host = hosts.find((h) => h.name === name);
            if (host) {
                logger.info(`${name} visible ${isTrue(event && event.visible)}`);
            }
            if (host && host.mode === this._ui) {
                this._drawn.hostVisible(host.depth, isTrue(event && event.visible));
            }
            if (isTrue(event && event.visible)) {
                this._visibleStates.add(name);
                this._sawForeground = true;
                this._setVisible(true);
                this._render();
            } else {
                this._visibleStates.delete(name);
                clearTimeout(this._hideTimer);
                this._hideTimer = setTimeout(() => {
                    if (this._visibleStates.size === 0) {
                        this._setVisible(false);
                    }
                }, HIDE_SETTLE_MS);
            }
        }));
        return Promise.all(stateNames.map((name) => this._states[name].updateResources()));
    }

    /* ---- the screens in use ---- */

    /* The tile opens ui's entry state from now on; a Store on screen moves
     * to it now. */
    _useUi(ui) {
        if (ui === this._ui) {
            return;
        }
        logger.info(`screens: ${ui}`);
        this._ui = ui;
        this._forgetWritten();
        this._render();
        if (!this._entryUuid) {
            return;
        }
        const root = this._states[ROOTS[ui]];
        // the pages of the screens left, top first; the HMI keeps an entry state
        // (INVALID_COMPONENTID), so BACK passes through the one left once
        const roots = Object.keys(ROOTS).map((k) => ROOTS[k]);
        const left = Array.from(this._visibleStates).filter((n) => roots.indexOf(n) < 0).reverse();
        Promise.resolve(this.rhmiApplication.mapEntryState(this._entryUuid, root))
            .catch((err) => logger.warn(`entry state ${ui}: ${err && err.message}`));
        if (this._visible) {
            this._openState(ROOTS[ui]);
            left.forEach((n) => this._closeState(n));
        }
    }

    _drawnUi() {
        return this._ui !== 'widgets';
    }

    /* Opens a page of either set of screens: the widget state named in S,
     * or the drawn page. */
    _openPage(kind, page) {
        if (this._drawnUi()) {
            this._drawn.push(page);
        } else {
            this._openState(S[kind]);
        }
    }

    _closePage(kind, pred) {
        if (this._drawnUi()) {
            this._drawn.closePage(pred);
            return Promise.resolve();
        }
        return this._closeState(S[kind]);
    }

    _pageShown(kind, pred) {
        return this._drawnUi() ? this._drawn.mode !== null && pred(this._drawn.top()) : this._visibleStates.has(S[kind]);
    }

    /* What the drawn screens show besides their own navigation. */
    _drawnModel() {
        const web = this._connected && this._st && this._st.web;
        return { st: this._connected ? this._st : null, connected: this._connected && !!this._st, secret: !!readSecret(),
            version: this._packageJson && this._packageJson.version, note: this._sourcesNote, login: this._login,
            webText: web && web.enabled ? readFile(WEB_URL_FILE) : '', accountsNote: this._accountsNote,
            pick: this._pick && { repo: this._pick.repo, probe: this._pick.probe } };
    }

    /* A press on the drawn screens (src/store_ui.js acts). */
    _act(act) {
        logger.info(`press ${act.do}${act.id ? ` ${act.id}` : ''}`);
        switch (act.do) {
        case 'tab': this._drawn.setTab(act.tab); break;
        case 'filter': this._drawn.setFilter(act.filter); break;
        case 'back': this._drawn.pop(); break;
        case 'check': this._send({ op: 'check' }); break;
        case 'open':
            if (act.page.name === 'source') {
                this._sourceId = act.page.id;
                this._removingSource = null;
                this._removalRefused = false;
            } else if (act.page.name === 'confirm' && act.page.kind === 'account-remove') {
                this._tokenId = act.page.id;
            } else if (act.page.name === 'confirm' && act.page.kind === 'remove') {
                this._removeId = act.page.id;
            }
            this._drawn.push(act.page);
            break;
        case 'install': this._install(act.id); break;
        case 'update-all':
            (this._connected && this._st ? this._st.components : [])
                .filter((c) => c.status === 'update' && rowAction(c, this._st.busy) === 'install')
                .forEach((c) => this._install(c.id));
            break;
        case 'remove': this._removeId = act.id; this._remove(); break;
        case 'restart': this._restart(); break;
        case 'source-remove': this._sourceId = act.id; this._removeSource(); break;
        case 'account-remove': this._tokenId = act.id; this._removeAccount(); break;
        case 'add-source': this._addSource(); break;
        case 'add-token': this._addToken(); break;
        case 'sign-in': this._signIn(); break;
        case 'sign-in-cancel': this._cancelSignIn(); break;
        case 'phone': this._togglePhone(); break;
        case 'pick': this._pickChannel(act.channel); break;
        case 'pick-retry': this._probe(); break;
        default: break;
        }
        this._render();
    }

    _openState(name) {
        if (this._shutdownPromise) {
            return;
        }
        this._render();
        Promise.resolve(this.rhmiApplication.openState(name))
            .catch((err) => logger.warn(`openState ${name} failed: ${err && err.message}`));
    }

    _closeState(name) {
        return Promise.resolve(this.rhmiApplication.closeState(name))
            .catch((err) => logger.warn(`closeState ${name} failed: ${err && err.message}`));
    }

    /* The confirm step's Restart; the updater refuses it while an install runs. */
    _restart() {
        this._closePage('restart', isConfirm('restart'));
        logger.info('restart head unit');
        this._send({ op: 'reboot' });
    }

    /* Sends a request that needs the updater's secret; without the secret
     * file nothing is sent. */
    _privileged(req) {
        const secret = readSecret();
        if (!secret) {
            logger.warn(`${req.op}: no updater secret in ${SECRET_FILE}`);
            return false;
        }
        return this._send(Object.assign({}, req, { secret }));
    }

    _send(req) {
        this._lastOp = req.op;
        return this._client.send(req);
    }

    _bind(name, handler) {
        const comp = this._components[name];
        if (!comp) {
            return;
        }
        let id = null;
        try {
            id = comp.getId();
        } catch (e) {
            id = null;
        }
        if (id !== null) {
            this._actionById[Number(id)] = { name, handler };
        }
        comp.on('action', (ev) => this._press(name, handler, Number(ev && ev.row) || 0));
    }

    /* Focus events of a proxy, from the component or the raw userEvent. */
    _bindFocus(name, handler) {
        const comp = this._components[name];
        if (!comp) {
            return;
        }
        try {
            this._focusById[Number(comp.getId())] = handler;
        } catch (e) {
            /* no id: the component's own events only */
        }
        comp.on('focus', (ev) => handler(isTrue(ev && ev.value)));
    }

    _press(name, handler, row) {
        const now = Date.now();
        const key = `${name}.${row}`;
        if (now - (this._lastPress[key] || 0) < PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[key] = now;
        logger.info(`BUTTON ACTION ${name} row ${row}`);
        try {
            handler(row);
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    _component(id) {
        return (this._connected && this._st && id && this._st.components.find((c) => c.id === id)) || null;
    }

    _source(id) {
        const sources = this._connected && this._st && this._st.sources;
        return (Array.isArray(sources) && id && sources.find((s) => s.id === id)) || null;
    }

    _token(id) {
        const tokens = this._connected && this._st && this._st.tokens;
        return (Array.isArray(tokens) && id && tokens.find((t) => t.id === id)) || null;
    }

    _onRow(kind, i) {
        const row = this._component(this._rows[kind][i]);
        if (!row) {
            return;
        }
        const action = rowAction(row, this._st.busy);
        if (action === 'install') {
            this._install(row.id);
        } else if (action === 'remove') {
            this._removeId = row.id;
            this._openPage('remove', { name: 'confirm', kind: 'remove', id: row.id });
        }
    }

    _install(id) {
        const row = this._component(id);
        if (row && rowAction(row, this._st.busy) === 'install') {
            logger.info(`install ${row.id} ${row.version}`);
            this._send({ op: 'install', id: row.id });
        }
    }

    _remove() {
        this._closePage('remove', isConfirm('remove'));
        const row = this._component(this._removeId);
        if (row && removable(row, this._st.busy)) {
            logger.info(`uninstall ${row.id}`);
            this._privileged({ op: 'uninstall', id: row.id });
        }
    }

    _onSource(i) {
        const src = this._source(this._rows.source[i]);
        if (src) {
            this._sourceId = src.id;
            this._removingSource = null;
            this._removalRefused = false;
            this._openPage('source', { name: 'source', id: src.id });
        }
    }

    _signIn() {
        this._login = { waiting: true, refusal: null };
        if (this._privileged({ op: 'login-start' })) {
            logger.info('GitHub sign-in');
            this._openPage('login', { name: 'login' });
        } else {
            this._login.waiting = false;
        }
    }

    _onAccount(i) {
        const token = this._token(this._rows.token[i]);
        if (token) {
            this._tokenId = token.id;
            this._openPage('accountRemove', { name: 'confirm', kind: 'account-remove', id: token.id });
        }
    }

    /* The Remove account confirm step's Remove; the updater reads the
     * account's sources again with the accounts left. */
    _removeAccount() {
        this._closePage('accountRemove', isConfirm('account-remove'));
        const token = this._token(this._tokenId);
        if (token) {
            logger.info(`remove account ${token.id}`);
            this._privileged({ op: 'token-remove', id: token.id });
        }
    }

    _cancelSignIn() {
        this._privileged({ op: 'login-cancel' });
        this._closePage('login', isPage('login'));
    }

    /* The source Remove confirm step's Remove: back to the source's page,
     * which closes itself once the updater has removed the source or refused
     * to (_leaveRemovedSource). Closing both states here leaves the closed
     * page in the HMI's BACK history. */
    _removeSource() {
        const src = this._source(this._sourceId);
        this._note(null);
        // the page closes once the HMI gives it the focus back (_leaveRemovedSource)
        this._focusedPage = null;
        this._closePage('sourceRemove', isConfirm('source-remove'));
        if (src && sourceActions(src).remove) {
            logger.info(`remove source ${src.id}`);
            this._removingSource = src.id;
            this._removalRefused = false;
            if (!this._privileged({ op: 'source-remove', id: src.id })) {
                this._removalRefused = true;
                const error = readSecret() ? 'updater not running' : 'no updater secret';
                this._note({ kind: 'refused', op: 'source-remove', error });
            }
        }
    }

    /* Closes the page of the source being removed once the HMI has given it
     * the focus back (the confirm step closed): a close sent while the confirm
     * step is still closing is lost. _render calls it again on every focus. */
    _leaveRemovedSource() {
        const focused = this._drawnUi() ? this._focusedPage === 'drawn:source' : this._focusedPage === S.source;
        if (this._removingSource && this._removingSource === this._sourceId && focused && this._pageShown('source', isPage('source'))) {
            this._removingSource = null;
            this._removalRefused = false;
            this._visibleStates.delete(S.source);
            this._closePage('source', isPage('source'));
        }
    }

    _note(m) {
        this._sourcesNote = m ? sourcesMessage(m) : '';
        this._render();
    }

    /* The speller's text; null when the driver left it without OK or it
     * could not be opened (the status line says so); undefined when a newer
     * speller replaced it. */
    _spell(title, note) {
        const seq = ++this._spellSeq;
        // the HMI gives the focus back to a page once the speller has closed (_showPick)
        this._focusedPage = null;
        // the speller is the HMI's: the renderer's layer is not drawn over it
        this._drawn.suspend(true);
        return spell(this, title).then((text) => {
            this._drawn.suspend(false);
            return text;
        }, (err) => {
            this._drawn.suspend(false);
            throw err;
        }).catch((err) => {
            logger.warn(`speller: ${err && err.message}`);
            if (seq === this._spellSeq) {
                (note || ((m) => this._note(m)))({ kind: 'speller', error: err && err.message });
            }
            return null;
        }).then((text) => (seq === this._spellSeq ? text : undefined));
    }

    _addSource() {
        this._note(null);
        this._spell('Add source').then((text) => {
            const typed = (text || '').trim();
            if (!typed) {
                return;
            }
            const source = parseSource(typed);
            if (source && source.type === 'github' && !source.channel) {
                this._startPick(source.repo);
            } else if (source) {
                this._sendSource(source);
            } else {
                this._note({ kind: 'invalid-source', text: typed });
            }
        });
    }

    /* Add token: the speller's text goes to the updater, which asks GitHub
     * whose it is before it stores it; the status line says what came of it. */
    _addToken() {
        this._endTokenAdd(null);
        this._spell('GitHub token', (m) => this._accountNote(m)).then((text) => {
            const token = (text || '').trim();
            if (!token) {
                return;
            }
            logger.info('add token');
            // the tokens it had are what a new one is told from: only with the updater's state at hand
            if (!this._connected || !this._st || !this._privileged({ op: 'token-add', token })) {
                this._accountNote({ kind: 'refused', error: readSecret() ? 'updater not running' : 'no updater secret' });
                return;
            }
            const before = new Set((this._st.tokens || []).map((t) => t.id));
            this._tokenAdding = { before, timer: setTimeout(() => this._endTokenAdd(null), TOKEN_ADD_MS) };
            this._accountNote({ kind: 'checking' });
        });
    }

    /* A state with a token the updater did not have before the token-add
     * ends it. A token it had already brings none: the timeout clears the
     * status line then. */
    _tokenAdded(st) {
        const pending = this._tokenAdding;
        const added = pending && (st.tokens || []).find((t) => !pending.before.has(t.id));
        if (added) {
            this._endTokenAdd({ kind: 'added', label: tokenLabel(added) });
        }
    }

    _endTokenAdd(m) {
        if (this._tokenAdding) {
            clearTimeout(this._tokenAdding.timer);
            this._tokenAdding = null;
        }
        this._accountNote(m);
    }

    _accountNote(m) {
        this._accountsNote = { text: m ? tokenMessage(m) : '', error: !!m && m.kind !== 'checking' && m.kind !== 'added' };
        this._render();
    }

    _sendSource(source) {
        logger.info(`add source ${source.type === 'github' ? source.repo : '(https)'}` +
            `${source.channel ? ` on ${source.channel}` : ''}`);
        if (!this._privileged(Object.assign({ op: 'source-add' }, source))) {
            const error = readSecret() ? 'updater not running' : 'no updater secret';
            this._note({ kind: 'refused', op: 'source-add', error });
        }
    }

    /* A repo typed without a branch: the updater says what it has. Its page
     * opens only once the HMI has given the focus back from the speller (or
     * FOCUS_BACK_MS after it closed): a page opened while the speller is
     * still closing is closed again by the focus coming back below it. */
    _startPick(repo) {
        this._endPick();
        const pick = { repo, probe: null, tokens: '', back: false, open: false };
        pick.timer = setTimeout(() => {
            pick.back = true;
            this._render();
        }, FOCUS_BACK_MS);
        this._pick = pick;
        if (this._probe()) {
            this._note({ kind: 'checking', repo });
        }
    }

    _endPick() {
        if (this._pick) {
            clearTimeout(this._pick.timer);
            this._pick = null;
        }
    }

    /* Asks the updater what the repo being added has. */
    _probe() {
        const pick = this._pick;
        if (!pick) {
            return false;
        }
        pick.probe = null;
        pick.tokens = this._tokenIds();
        logger.info(`probe ${pick.repo}`);
        if (!this._privileged({ op: 'source-probe', repo: pick.repo })) {
            pick.probe = { status: 'refused', error: readSecret() ? 'updater not running' : 'no updater secret' };
        }
        this._render();
        return !pick.probe;
    }

    _tokenIds() {
        return (this._connected && this._st && Array.isArray(this._st.tokens) ? this._st.tokens : []).map((t) => t.id).join(',');
    }

    _probed(answer) {
        const pick = this._pick;
        if (pick && !pick.probe && answer && answer.repo === pick.repo) {
            pick.probe = answer;
            logger.info(`probe ${pick.repo}: ${answer.status}`);
            this._render();
        }
    }

    /* A repo no account reached is asked about again once the accounts change. */
    _reprobe() {
        const pick = this._pick;
        if (pick && pick.open && pick.probe && pick.probe.status === 'auth-needed' && this._tokenIds() !== pick.tokens) {
            this._probe();
        }
    }

    /* Once the updater has answered and the focus is back: a repo with one
     * thing to add it on is added on it; one no account reaches, or with
     * more to pick from, gets its page; anything else goes on the status
     * line. */
    _showPick() {
        const pick = this._pick;
        if (!pick || pick.open || !pick.probe || !(pick.back || this._focusedPage !== null)) {
            return;
        }
        const options = pickOptions(pick.probe);
        if (options.length === 1) {
            this._pickChannel(options[0].channel);
        } else if (options.length > 1 || pick.probe.status === 'auth-needed') {
            pick.open = true;
            clearTimeout(pick.timer);
            this._sourcesNote = '';
            this._openPage('pick', { name: 'pick' });
        } else {
            this._endPick();
            this._note({ kind: 'refused', op: 'source-add', error: probeStatus(pick.probe) });
        }
    }

    _pickChannel(channel) {
        const pick = this._pick;
        if (!pick || !channel) {
            return;
        }
        this._endPick();
        this._note(null);
        if (pick.open) {
            this._closePage('pick', isPage('pick'));
        }
        // the repo as GitHub spells it (the speller types capitals first)
        this._sendSource({ type: 'github', repo: (pick.probe && pick.probe.name) || pick.repo, channel });
    }

    _togglePhone() {
        const web = this._connected && this._st && this._st.web;
        if (web) {
            logger.info(`phone access ${web.enabled ? 'off' : 'on'}`);
            this._privileged({ op: 'web', enable: !web.enabled });
        }
    }

    /* The app manager inserts the public tile from application.json and hands
     * it to the app at start; the SDK emits 'entryPointExecute' on a tap. */
    _registerEntryPoints() {
        const descriptions = (this.appDescription &&
            this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._states[ROOTS[this._ui]]))
            .then(() => { this._entryUuid = description.uuid; })
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(description.textId))
                .then(() => (description.icon ? ours.entryPoint.setIcon(description.icon) : undefined))
                .catch((err) => logger.warn(`entry point text/icon: ${err && err.message}`)))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._sawForeground = true;
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* ---- rendering ---- */

    /* Everything is written again on the next render, QR codes included. */
    _forgetWritten() {
        this._written = {};
        Object.keys(this._qr).forEach((k) => { this._qr[k].key = null; });
    }

    /* Writes a cell only when its value changed, so the state stream (every
     * 250 ms while downloading) costs the HMI one write per changed cell. */
    _set(name, cell, value, type, row = 0) {
        const comp = this._components[name];
        if (this._hmi === 'ID8' && !ID8_LABELS.has(name)) {
            if (cell === 'Progress') {
                return;
            }
            cell = ID8_CELLS[cell] || cell;
        }
        const key = `${name}.${row}.${cell}`;
        if (!comp || this._written[key] === value) {
            return;
        }
        this._written[key] = value;
        Promise.resolve(comp.setValue(row, cell, value, type))
            .catch((err) => logger.warn(`render ${key} failed: ${err && err.message}`));
    }

    _show(name, visible) {
        const comp = this._components[name];
        const key = `${name}.visible`;
        if (!comp || this._written[key] === visible) {
            return;
        }
        this._written[key] = visible;
        Promise.resolve(comp.setProperty('Visible', visible ? 1 : 0, 'UInt'))
            .catch((err) => logger.warn(`visibility ${name} failed: ${err && err.message}`));
    }

    /* A one-line label: shown with its text, hidden when there is none. */
    _text(name, text) {
        if (text) {
            this._set(name, 'Text', text, 'Text');
        }
        this._show(name, !!text);
    }

    _render() {
        if (!this._visible || this._shutdownPromise) {
            return;
        }
        const st = this._st;
        const connected = this._connected && !!st;
        this._set(C.status, 'Text', connected ? statusLine(st, true) : statusLine(null, false, !!readSecret()), 'Text');
        this._set(C.check, 'Text', connected && st.catalog.checking ? 'Checking' : 'Check for updates', 'Text');

        const busy = connected ? st.busy : null;
        const busyRow = busy && st.components.find((c) => c.id === busy.id);
        if (busyRow) {
            const done = busy.phase === 'download' ? percent(busy) / 100 : 1;
            this._set(C.progress, 'TextLeft', `${PHASE[busy.phase] || 'Installing'} ${busyRow.title}`, 'Text');
            this._set(C.progress, 'TextRight', busy.phase === 'download' ? `${percent(busy)}%` : '', 'Text');
            this._set(C.progress, 'Progress', done, 'Float');
        }
        this._show(C.progress, !!busyRow);
        // an updater without the reboot request (before 0.1.4) reports no rebooting
        this._show(C.restart, connected && !busy && st.rebooting === false);

        KINDS.forEach((kind) => {
            const rows = connected ? st.components.filter((c) => c.kind === kind) : [];
            this._set(LISTS[kind].nav, 'Text2ndCol', groupState(rows, busy), 'Text');
            this._show(LISTS[kind].nav, connected);
            this._renderList(LISTS[kind].list, rows.map((r) => [r.title, rowState(r, busy)]));
            this._rows[kind] = rows.map((r) => r.id);
        });
        const removingComponent = this._component(this._removeId);
        this._text(C.removeName, removingComponent ? `${removingComponent.title} ${removingComponent.installed}` : '');

        // an updater that reports no sources or web hides Sources and Phone access
        const sources = connected && Array.isArray(st.sources) ? st.sources : null;
        const web = connected && st.web && typeof st.web === 'object' ? st.web : null;
        if (sources) {
            this._set(C.navSources, 'Text2ndCol', sourcesState(sources), 'Text');
        }
        this._show(C.navSources, !!sources);
        if (web) {
            this._set(C.navPhone, 'Text2ndCol', phoneState(web), 'Text');
        }
        this._show(C.navPhone, !!web);
        this._renderList(C.sourceList, (sources || []).map((s) => [sourceLabel(s), sourceState(s)]));
        this._rows.source = (sources || []).map((s) => s.id);
        this._text(C.sourcesStatus, this._sourcesNote);
        this._show(C.sourceAdd, !!sources);
        this._show(C.sourcePhone, !!web);
        // an updater that reports no tokens hides Accounts
        const tokens = connected && Array.isArray(st.tokens) ? st.tokens : null;
        if (tokens) {
            this._set(C.sourceAccounts, 'Text2ndCol', accountsState(tokens), 'Text');
        }
        this._show(C.sourceAccounts, !!tokens);
        this._renderList(C.accountList, (tokens || []).map((t) => [tokenLabel(t), tokenState(t)]));
        // Sign in with GitHub only with the updater's GitHub App (state.signin)
        this._show(C.accountSignIn, connected && st.signin === true);
        this._show(C.accountAddToken, !!tokens);
        this._text(C.accountsStatus, this._accountsNote.text);
        this._rows.token = (tokens || []).map((t) => t.id);
        const removing = this._token(this._tokenId);
        this._text(C.accountName, removing ? tokenLabel(removing) : '');
        this._text(C.accountSources, removing ? tokenSources(removing, sources) : '');
        this._renderSource(this._source(this._sourceId));
        this._renderPick();
        this._renderLogin(connected ? st.login : null);
        this._renderPhone(web);
        if (this._drawnUi()) {
            this._drawn.render();
        }
    }

    _renderSource(src) {
        const actions = src ? sourceActions(src) : {};
        if ((!src && this._connected) || this._removalRefused) {
            this._leaveRemovedSource();
        }
        if (src) {
            this._set(C.srcStatus, 'Text1stCol', sourceLabel(src), 'Text');
            this._set(C.srcStatus, 'Text2ndCol', sourceState(src), 'Text');
            this._set(C.srcChannel, 'Text2ndCol', sourceChannel(src), 'Text');
            this._set(C.srcAccount, 'Text2ndCol', sourceAccount(src), 'Text');
            this._set(C.srcComponents, 'Text2ndCol',
                typeof src.components === 'number' ? String(src.components) : '', 'Text');
        }
        this._show(C.srcStatus, !!src);
        this._show(C.srcChannel, !!(src && sourceChannel(src)));
        this._show(C.srcAccount, !!(src && sourceAccount(src)));
        this._show(C.srcComponents, !!src);
        this._text(C.srcError, src && src.error ? String(src.error) : '');
        this._show(C.srcRemove, !!actions.remove);
        // a private repo no account reaches after a sign-in: the GitHub App's install page
        const app = src && src.status === 'auth-needed' && this._st && this._st.signinApp;
        const signedIn = Array.isArray(this._st && this._st.tokens) && this._st.tokens.some((t) => !t.rejected);
        const installUrl = app && signedIn && app.installUrl ? String(app.installUrl) : '';
        this._show(C.srcAppLabel, !!installUrl);
        this._text(C.srcAppUrl, installUrl);
        this._showQr('app', C.srcAppQr, installUrl, '');
    }

    _renderPick() {
        const pick = this._pick;
        const probe = pick ? pick.probe : null;
        const options = pickOptions(probe);
        const auth = !!probe && probe.status === 'auth-needed';
        const status = auth && this._accountsNote.text ? this._accountsNote.text : probeStatus(probe);
        this._text(C.pickStatus, pick ? [(probe && probe.name) || pick.repo, status].filter(Boolean).join(': ') : '');
        this._renderList(C.pickList, options.map((o) => [o.label, o.sub]));
        this._rows.pick = options.map((o) => o.channel);
        this._show(C.pickSignIn, auth && this._connected && !!this._st && this._st.signin === true);
        this._show(C.pickAddToken, auth && this._connected);
        this._show(C.pickRetry, !!probe && probe.status !== 'ok' && !auth);
        this._showPick();
    }

    /* The sign-in page; it closes itself once the sign-in it started is
     * done. A login the updater reports before it has taken the new one up
     * is an earlier one. */
    _renderLogin(reported) {
        if (this._login.waiting && reported && reported.status === 'pending') {
            this._login.waiting = false;
        }
        const login = this._login.waiting ? null : reported;
        const code = loginCode(login);
        this._set(C.loginStatus, 'Text', loginStatus(login, this._login.refusal), 'Text');
        this._text(C.loginCode, code);
        this._text(C.loginUrl, code ? login.url : '');
        this._showQr('login', C.loginQr, code ? login.url : '', code);
        if (login && login.status === 'done' && this._pageShown('login', isPage('login'))) {
            this._visibleStates.delete(S.login);
            this._closePage('login', isPage('login'));
        }
    }

    _renderPhone(web) {
        const address = web ? phoneAddress(web, web.enabled ? readFile(WEB_URL_FILE) : '') : { qr: '', text: '' };
        if (web) {
            this._set(C.phoneToggle, 'Text2ndCol', phoneState(web), 'Text');
        }
        this._text(C.phoneUrl, address.text);
        this._text(C.phoneError, web && web.error ? String(web.error) : '');
        this._showQr('phone', C.phoneQr, address.qr, '');
        this._pollWebUrl(!!(web && web.enabled && this._pageShown('phone', isPage('phone'))));
    }

    /* The updater writes web-url after it reports the page on, and again
     * when the page's address changes, with no state change of its own: so
     * while Phone access is open and on, the page is drawn again each
     * WEB_URL_POLL_MS. */
    _pollWebUrl(on) {
        if (on && !this._webUrlTimer) {
            this._webUrlTimer = setInterval(() => this._render(), WEB_URL_POLL_MS);
        } else if (!on && this._webUrlTimer) {
            clearInterval(this._webUrlTimer);
            this._webUrlTimer = null;
        }
    }

    /* A list's row count follows its rows ([1st column, 2nd column]). A cell
     * written to a row past the count makes the SDK grow the list to that
     * row, which would undo a larger count still being set; so cells wait
     * until the count is set. */
    _renderList(name, rows) {
        const comp = this._components[name];
        this._show(name, rows.length > 0);
        if (!comp || this._sizing[name]) {
            return;
        }
        const countKey = `${name}.rows`;
        if (this._written[countKey] !== rows.length) {
            Object.keys(this._written).filter((k) => k.indexOf(`${name}.`) === 0)
                .forEach((k) => delete this._written[k]);
            this._written[countKey] = rows.length;
            this._sizing[name] = true;
            Promise.resolve(comp.setRowCount(rows.length))
                .catch((err) => logger.warn(`row count ${name} failed: ${err && err.message}`))
                .then(() => {
                    this._sizing[name] = false;
                    this._render();
                });
            return;
        }
        rows.forEach((r, i) => {
            this._set(name, 'Text1stCol', r[0], 'Text', i);
            this._set(name, 'Text2ndCol', r[1], 'Text', i);
        });
    }

    /* Shows text's QR code (with a caption) on a picture component, written
     * as a new file per text; hidden and its file retired without text. The
     * text may hold an access token: it never goes into a log line. */
    _showQr(slot, name, text, caption) {
        const q = this._qr[slot];
        const comp = this._components[name];
        const rhmi = this.rhmiApplication;
        const key = text ? `${text}\n${caption}` : '';
        this._show(name, !!text);
        if (q.key === key || !comp || !rhmi) {
            return;
        }
        q.key = key;
        q.chain = q.chain.then(() => {
            const bundle = rhmi.getResourceBundle();
            const old = q.file;
            if (!text) {
                q.file = null;
                return old ? this._retireQr(bundle, old) : undefined;
            }
            const dir = qrDir();
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir);
            }
            fs.chmodSync(dir, 0o755);
            const r = qrPng(text, { caption });
            const file = path.join(dir, `${QR_PREFIX}${slot}_${Date.now()}.png`);
            fs.writeFileSync(file, r.png);
            fs.chmodSync(file, 0o644);
            return Promise.resolve(bundle.createResourceHandles([file]))
                .then(() => comp.setValue(0, 'Graphic', file, 'ResourceId'))
                .then(() => rhmi.flush())
                .then(() => {
                    q.file = file;
                    logger.info(`${slot} QR code ${r.width}x${r.height} px (${r.modules} modules)`);
                    return old ? this._retireQr(bundle, old) : undefined;
                }, (err) => this._retireQr(bundle, file).then(() => { throw err; }));
        }).catch((err) => {
            q.key = null;
            logger.warn(`${slot} QR code failed: ${err && err.message}`);
        });
    }

    _retireQr(bundle, file) {
        return Promise.resolve()
            .then(() => bundle.destroyResourceHandles([file]))
            .catch((err) => logger.warn(`QR handle ${path.basename(file)}: ${err && err.message}`))
            .then(() => {
                try { fs.unlinkSync(file); } catch (e) { /* gone already */ }
            });
    }

    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) {
            return;
        }
        this._visible = visible;
        clearTimeout(this._hideTimer);
        this._pollWebUrl(false);
        logger.info(`screen ${visible ? 'visible' : 'hidden'}`);
        if (visible) {
            this._forgetWritten();
            this._render();
            if (this._connected) {
                // opening the Store is a good moment to look
                this._send({ op: 'check' });
            }
        }
        if (!this._initialized || !this._appStatusService) {
            return;
        }
        const reports = visible ?
            [this.registerActive(), this.registerHmiVisible()] :
            [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((report) => Promise.resolve(report).catch((err) =>
            logger.warn(`app status report failed: ${err && err.message}`)));
    }

    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        logger.info(`store shutting down (${reason})`);
        clearTimeout(this._hideTimer);
        clearTimeout(this._tokenAdding && this._tokenAdding.timer);
        this._endPick();
        this._pollWebUrl(false);
        this._client.close();
        this._drawn.close();
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => removeStaleQr())
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new Store();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`store failed to start: ${err && err.message}`);
});
