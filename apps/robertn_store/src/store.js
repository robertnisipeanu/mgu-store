/**
 * store - the Store: our published apps and head-unit tools, each with its
 * state, and the progress of the running install.
 *
 * The app holds no install logic. mgu-updater (native/mgu-updater), the
 * root daemon, reads the catalog, downloads and installs; this app shows the
 * state it streams over its socket and sends it three requests: "check" (the
 * Check for updates button), "install <id>" (a row whose component is
 * not installed, has an update, or failed) and "reboot" (Restart head unit,
 * once confirmed).
 *
 * The start screen has the status line, Check for updates, the progress of
 * the running install, a row each for Apps and Head-unit tools, which
 * open their lists, and Restart head unit, which opens its confirm step
 * (Cancel, Restart). A list is one component with a row per catalog
 * component of that kind:
 *
 *   DOOM                        Update 1.0.1      (installed 1.0.0)
 *   Vehicle control             Installed 1.0.0
 *   Extended dashboard          42%               (downloading)
 *
 * An app install runs in place, or else restarts MainApp's app processes,
 * this one included; the updater carries on, and the Store shows the result
 * when opened again.
 */
'use strict';

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { UpdaterClient } = require('./client.js');
const { PHASE, percent, rowState, rowAction, groupState, statusLine } = require('./store_view.js');

const logger = logging.getSDKLogger();

const SOCKET = '/dev/shm/mgu-updater/updater.sock';
const RECONNECT_MS = 2000;
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const ROW_KEY = 2;                      // a press's row in a raw userEvent's parameterMap

/* tools/gen_rhmi.js */
const MAIN_STATE = 'ST_OnlineApps_Store';
const CONFIRM_STATE = 'ST_OnlineApps_StoreRestart';
const LISTS = {
    app: { state: 'ST_OnlineApps_StoreApps', nav: 'storeNavApps', list: 'storeAppList' },
    tool: { state: 'ST_OnlineApps_StoreTools', nav: 'storeNavTools', list: 'storeToolList' }
};
const KINDS = Object.keys(LISTS);
const C = { status: 'storeStatus', check: 'storeCheck', progress: 'storeProgress', restart: 'storeRestart',
    restartCancel: 'storeRestartCancel', restartConfirm: 'storeRestartConfirm' };
/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
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
        this._rows = { app: [], tool: [] };
        this._sizing = {};              // lists whose row count is being set
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
        const stateNames = [MAIN_STATE].concat(KINDS.map((k) => LISTS[k].state), CONFIRM_STATE);
        for (const name of stateNames) {
            this._states[name] = rhmi.getByName(name);
            if (!this._states[name]) {
                return Promise.reject(new Error(`uiDescription has no ${name}`));
            }
        }
        this._state = this._states[MAIN_STATE];
        const names = Object.values(C);
        KINDS.forEach((kind) => names.push(LISTS[kind].nav, LISTS[kind].list));
        names.forEach((name) => {
            this._components[name] = rhmi.getByName(name);
            if (!this._components[name]) {
                logger.warn(`BIND MISS: ${name} not found in uiDescription`);
            }
        });
        this._bind(C.check, () => this._client.check());
        this._bind(C.restart, () => this._openState(CONFIRM_STATE));
        this._bind(C.restartCancel, () => this._closeConfirm());
        this._bind(C.restartConfirm, () => this._restart());
        KINDS.forEach((kind) => {
            this._bind(LISTS[kind].nav, () => this._openState(LISTS[kind].state));
            this._bind(LISTS[kind].list, (row) => this._onRow(kind, row));
        });
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
            this._written = {};
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
        Promise.resolve(this.rhmiApplication.openState(name))
            .catch((err) => logger.warn(`openState ${name} failed: ${err && err.message}`));
    }

    _closeConfirm() {
        Promise.resolve(this.rhmiApplication.closeState(CONFIRM_STATE))
            .catch((err) => logger.warn(`closeState ${CONFIRM_STATE} failed: ${err && err.message}`));
    }

    /* The confirm step's Restart; the updater refuses it while an install runs. */
    _restart() {
        this._closeConfirm();
        logger.info('restart head unit');
        this._client.reboot();
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

    _onRow(kind, i) {
        const id = this._rows[kind][i];
        const row = this._st && id && this._st.components.find((c) => c.id === id);
        if (!row || !this._connected) {
            return;
        }
        if (rowAction(row, this._st.busy) === 'install') {
            logger.info(`install ${row.id} ${row.version}`);
            this._client.install(row.id);
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
            this._renderList(LISTS[kind].list, rows, busy);
            this._rows[kind] = rows.map((r) => r.id);
        });
    }

    /* A list's row count follows the catalog. A cell written to a row past
     * the count makes the SDK grow the list to that row, which would undo a
     * larger count still being set; so cells wait until the count is set. */
    _renderList(name, rows, busy) {
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
            this._set(name, 'Text1stCol', r.title, 'Text', i);
            this._set(name, 'Text2ndCol', rowState(r, busy), 'Text', i);
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
            this._written = {};
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
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new Store();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`store failed to start: ${err && err.message}`);
});
