/**
 * store - the Store: the apps and head-unit tools of every source, each
 * with its state, the progress of the running install, the sources, and
 * the phone page.
 *
 * The app holds no install logic. mgu-updater (native/mgu-updater), the
 * root daemon, reads the sources' catalogs, downloads and installs; this app
 * shows the state it streams over its socket and sends it requests: "check"
 * (Check for updates), "install <id>" (a row whose component is not
 * installed, has an update, or failed), "reboot" (Restart head unit, once
 * confirmed), and the privileged ones, which carry the secret the updater
 * leaves in this app's data folder: "uninstall" (a removable installed
 * component, once confirmed), "source-remove", "login-start" /
 * "login-cancel" (GitHub sign-in of a source) and "web" (Phone access on or
 * off).
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
 * Sources lists each source with its status and opens its page (Account,
 * Components, Sign in with GitHub, Remove). The head unit has no text entry,
 * so a source is added on the phone page (Add source opens Phone access) or
 * by plugging in a USB stick, whose sources the updater lists by itself.
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
const { UpdaterClient } = require('./client.js');
const { qrPng } = require('./qr.js');
const { PHASE, percent, rowState, rowAction, groupState, statusLine, sourceLabel, sourceState,
    sourcesState, sourceActions, sourceAccount, loginStatus, loginCode, phoneState,
    phoneUrl } = require('./store_view.js');

const logger = logging.getSDKLogger();

const SOCKET = '/dev/shm/mgu-updater/updater.sock';
/* The updater writes the privileged secret here (owner this app's uid,
 * 0400); it is read again for every privileged request. */
const SECRET_FILE = path.join(__dirname, '..', '..', 'data', 'updater-secret');
const RECONNECT_MS = 2000;
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const ROW_KEY = 2;                      // a press's row in a raw userEvent's parameterMap
const QR_PREFIX = 'qr_';

/* tools/gen_rhmi.js */
const S = {
    main: 'ST_OnlineApps_Store',
    restart: 'ST_OnlineApps_StoreRestart',
    sources: 'ST_OnlineApps_StoreSources',
    source: 'ST_OnlineApps_StoreSource',
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
    sourceList: 'storeSourceList', sourceAdd: 'storeSourceAdd',
    srcStatus: 'storeSrcStatus', srcAccount: 'storeSrcAccount', srcComponents: 'storeSrcComponents',
    srcError: 'storeSrcError', srcSignIn: 'storeSrcSignIn', srcRemove: 'storeSrcRemove',
    loginQr: 'storeLoginQr', loginCode: 'storeLoginCode', loginUrl: 'storeLoginUrl',
    loginStatus: 'storeLoginStatus', loginCancel: 'storeLoginCancel',
    srcRemoveCancel: 'storeSrcRemoveCancel', srcRemoveConfirm: 'storeSrcRemoveConfirm',
    removeName: 'storeRemoveName', removeCancel: 'storeRemoveCancel', removeConfirm: 'storeRemoveConfirm',
    phoneToggle: 'storePhoneToggle', phoneQr: 'storePhoneQr', phoneUrl: 'storePhoneUrl',
    phoneError: 'storePhoneError' };
/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

function readSecret() {
    try {
        return fs.readFileSync(SECRET_FILE, 'utf8').trim() || null;
    } catch (e) {
        return null;
    }
}

/* The HMI reads pictures as another user: QR codes live in a world-readable
 * folder in RAM (docs/OAP_APP_DEV_GUIDE.md §10 in mgu-apps). */
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
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._rows = { app: [], tool: [], source: [] };
        this._sizing = {};              // lists whose row count is being set
        this._sourceId = null;          // the source whose page is open
        this._removeId = null;          // the component the Remove confirm step names
        this._qr = { login: { key: null, file: null, chain: Promise.resolve() },
            phone: { key: null, file: null, chain: Promise.resolve() } };
        this._st = null;
        this._connected = false;
        this._client = new UpdaterClient(SOCKET, { reconnectMs: RECONNECT_MS });
        this._client.on('state', (st) => {
            this._connected = true;
            this._st = st;
            this._render();
        });
        this._client.on('down', () => {
            if (this._connected) {
                logger.info('updater unreachable; reconnecting');
            }
            this._connected = false;
            this._render();
        });
        this._client.on('reply-error', (msg) => logger.warn(`updater refused: ${msg}`));

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

    /* ---- RHMI ---- */

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
        const names = Object.values(C);
        KINDS.forEach((kind) => names.push(LISTS[kind].nav, LISTS[kind].list));
        names.forEach((name) => {
            this._components[name] = rhmi.getByName(name);
            if (!this._components[name]) {
                logger.warn(`BIND MISS: ${name} not found in uiDescription`);
            }
        });
        removeStaleQr();
        this._bind(C.check, () => this._client.check());
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
        this._bind(C.sourceAdd, () => this._openState(S.phone));
        this._bind(C.srcSignIn, () => this._signIn());
        this._bind(C.srcRemove, () => this._openState(S.sourceRemove));
        this._bind(C.srcRemoveCancel, () => this._closeState(S.sourceRemove));
        this._bind(C.srcRemoveConfirm, () => this._removeSource());
        this._bind(C.loginCancel, () => this._cancelSignIn());
        this._bind(C.navPhone, () => this._openState(S.phone));
        this._bind(C.phoneToggle, () => this._togglePhone());
        // Presses also arrive as the application's raw 'userEvent'; both paths
        // land in _press, which keeps a press delivered twice to one.
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler, Number((ev.parameterMap || {})[ROW_KEY]) || 0);
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
        stateNames.forEach((name) => this._states[name].on('visible', (event) => {
            if (isTrue(event && event.visible)) {
                this._visibleStates.add(name);
                this._sawForeground = true;
                this._setVisible(true);
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
        this._closeState(S.restart);
        logger.info('restart head unit');
        this._client.reboot();
    }

    /* Sends a request that needs the updater's secret; without the secret
     * file nothing is sent. */
    _privileged(req) {
        const secret = readSecret();
        if (!secret) {
            logger.warn(`${req.op}: no updater secret in ${SECRET_FILE}`);
            return false;
        }
        return this._client.send(Object.assign({}, req, { secret }));
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

    _onRow(kind, i) {
        const row = this._component(this._rows[kind][i]);
        if (!row) {
            return;
        }
        const action = rowAction(row, this._st.busy);
        if (action === 'install') {
            logger.info(`install ${row.id} ${row.version}`);
            this._client.install(row.id);
        } else if (action === 'remove') {
            this._removeId = row.id;
            this._openState(S.remove);
        }
    }

    /* The Remove confirm step's Remove. */
    _remove() {
        this._closeState(S.remove);
        const row = this._component(this._removeId);
        if (row && rowAction(row, this._st.busy) === 'remove') {
            logger.info(`uninstall ${row.id}`);
            this._privileged({ op: 'uninstall', id: row.id });
        }
    }

    _onSource(i) {
        const src = this._source(this._rows.source[i]);
        if (src) {
            this._sourceId = src.id;
            this._openState(S.source);
        }
    }

    _signIn() {
        const src = this._source(this._sourceId);
        if (src && sourceActions(src).signIn && this._privileged({ op: 'login-start', source: src.id })) {
            logger.info(`GitHub sign-in for ${src.id}`);
            this._openState(S.login);
        }
    }

    _cancelSignIn() {
        this._privileged({ op: 'login-cancel' });
        this._closeState(S.login);
    }

    /* The source Remove confirm step's Remove: back to the Sources list. */
    _removeSource() {
        const src = this._source(this._sourceId);
        this._closeState(S.sourceRemove).then(() => this._closeState(S.source));
        if (src && sourceActions(src).remove) {
            logger.info(`remove source ${src.id}`);
            this._privileged({ op: 'source-remove', id: src.id });
        }
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
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
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
        this._set(C.status, 'Text', connected ? statusLine(st, true) : statusLine(null, false), 'Text');
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
        const removing = this._component(this._removeId);
        this._text(C.removeName, removing ? `${removing.title} ${removing.installed}` : '');

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
        this._show(C.sourceAdd, !!web);
        this._renderSource(this._source(this._sourceId));
        this._renderLogin(connected ? st.login : null);
        this._renderPhone(web);
    }

    _renderSource(src) {
        const actions = src ? sourceActions(src) : {};
        if (src) {
            this._set(C.srcStatus, 'Text1stCol', sourceLabel(src), 'Text');
            this._set(C.srcStatus, 'Text2ndCol', sourceState(src), 'Text');
            this._set(C.srcAccount, 'Text2ndCol', sourceAccount(src), 'Text');
            this._set(C.srcComponents, 'Text2ndCol',
                typeof src.components === 'number' ? String(src.components) : '', 'Text');
        }
        this._show(C.srcStatus, !!src);
        this._show(C.srcAccount, !!(src && sourceAccount(src)));
        this._show(C.srcComponents, !!src);
        this._text(C.srcError, src && src.error ? String(src.error) : '');
        this._show(C.srcSignIn, !!actions.signIn);
        this._show(C.srcRemove, !!actions.remove);
    }

    /* The sign-in page of the open source; it closes itself once signed in. */
    _renderLogin(login) {
        const source = this._sourceId;
        const code = loginCode(login, source);
        this._set(C.loginStatus, 'Text', loginStatus(login, source), 'Text');
        this._text(C.loginCode, code);
        this._text(C.loginUrl, code ? login.url : '');
        this._showQr('login', C.loginQr, code ? login.url : '', code);
        if (login && login.source === source && login.status === 'done' && this._visibleStates.has(S.login)) {
            this._visibleStates.delete(S.login);
            this._closeState(S.login);
        }
    }

    _renderPhone(web) {
        const url = web ? phoneUrl(web) : '';
        if (web) {
            this._set(C.phoneToggle, 'Text2ndCol', phoneState(web), 'Text');
        }
        this._text(C.phoneUrl, url);
        this._text(C.phoneError, web && web.error ? String(web.error) : '');
        this._showQr('phone', C.phoneQr, url, '');
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
            q.file = null;
            if (!text) {
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
                });
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
        logger.info(`screen ${visible ? 'visible' : 'hidden'}`);
        if (visible) {
            this._forgetWritten();
            this._render();
            if (this._connected) {
                // opening the Store is a good moment to look
                this._client.check();
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
        this._client.close();
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
