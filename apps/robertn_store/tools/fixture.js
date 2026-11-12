'use strict';
/**
 * An updater state with one of everything the Store shows (a running
 * download, an update, a branch's new commit, a queued install, a failure,
 * a restart pending, a component for the other head unit, a second
 * renderer, a USB stick, a source that needs a sign-in, accounts, the phone
 * page, the uplink's Wi-Fi), and the Store's drawn screens over it (the keyboard's and Wi-Fi's pages too), for tools/test_screens.js
 * and tools/shots.js.
 */

const comp = (o) => Object.assign({ kind: 'app', installed: null, size: null, status: 'available', source: 'mgu-store',
    build: null, optional: false, uninstallable: true, revision: null, mguHmi: ['ID7', 'ID8'], compat: 'yes', provides: null,
    service: null, pendingReboot: false, queued: false, error: null }, o);

/* An updater error of about 200 characters. */
const LONG_ERROR = 'the build failed (exit 1): no oap-sdk donor among the installed apps carries OnlineApp.js, ' +
    'so robertn_doom@1.0.1 cannot be linked; install any stock app again, or another app that ships the SDK';

function state() {
    return {
        type: 'state', updater: { version: '0.4.0' }, online: true, privacy: 'patched',
        unit: { hmi: 'ID7', firmware: 'BMW MGU P18_23w44.2-1-3 mgu-high' },
        allProviders: { renderer: [{ id: 'mgu-renderd', version: '1.1.0' }] },
        catalog: { commit: 'x', checkedAt: Date.UTC(2026, 9, 26, 12, 2), checking: false, error: null },
        sources: [
            { id: 'mgu-store', type: 'github', label: 'robertnisipeanu/mgu-store', builtin: true, usb: false, channel: 'releases',
                status: 'ok', error: null, auth: { kind: 'github', token: '3f9a01c2', login: 'robertn' }, checkedAt: 1, components: 6 },
            { id: 'idrive7-apps', type: 'github', label: 'cauliflower/idrive7-apps', builtin: false, usb: false, channel: 'branch:main',
                status: 'ok', error: null, auth: null, checkedAt: 1, components: 4 },
            { id: 'car-apps', type: 'github', label: 'IterioDev/car-apps', builtin: false, usb: false, channel: 'releases',
                status: 'auth-needed', error: 'no account reaches IterioDev/car-apps', auth: null, checkedAt: 1, components: 0 },
            { id: 'usb:STICK', type: 'usb', label: 'USB STICK', builtin: false, usb: true, channel: null,
                status: 'ok', error: null, auth: null, checkedAt: 1, components: 2 }
        ],
        tokens: [
            { id: '3f9a01c2', kind: 'github', label: 'robertn', login: 'robertn', addedAt: 1, rejected: false, usedBy: ['mgu-store'] },
            { id: '0badc0de', kind: 'github', label: null, login: null, addedAt: 1, rejected: true, usedBy: [] }
        ],
        signin: true,
        signinApp: { installUrl: 'https://github.com/apps/mgu-store/installations/new' },
        login: null,
        web: { enabled: false, urls: [], error: null },
        proxy: { on: false, kind: null, address: null, auth: false, error: null },
        uplink: { device: { kind: 'wifi', name: 'Mario iPhone' }, state: 'online', error: null, preferred: 'wifi', usbPhone: true,
            wifi: { enabled: true, link: 'online', ssid: 'Mario iPhone', ip: '172.20.10.3', signal: -52, scanning: false, error: null, allow5ghz: false,
                networks: [{ ssid: 'Mario iPhone', signal: -52, secure: true, saved: true, current: true },
                    { ssid: 'FRITZ!Box 7590 XY', signal: -58, secure: true, saved: false, current: false },
                    { ssid: 'Cafe Free WiFi', signal: -70, secure: false, saved: false, current: false },
                    { ssid: 'Telekom_FON', signal: -81, secure: false, saved: false, current: false }],
                saved: ['Mario iPhone', 'Home'] } },
        busy: { id: 'doom', op: 'install', phase: 'download', progress: 874512, total: 2080457 },
        rebooting: false,
        rebootError: null,
        components: [
            comp({ id: 'robertn_store', title: 'Store', version: '0.7.0', installed: '0.7.0', status: 'installed', uninstallable: false }),
            comp({ id: 'doom', title: 'DOOM', version: '1.0.1', installed: '1.0.0', status: 'update', size: 2080457, source: 'idrive7-apps' }),
            comp({ id: 'gauges', title: 'Gauges', version: '1.2.0', installed: '1.2.0', status: 'update', revision: 'a1b2c3d',
                source: 'idrive7-apps', build: 'unit', author: 'robertn', description: 'Speed, revs, temperatures and boost as gauges, ' +
                'laid out the way you pick.' }),
            comp({ id: 'car_vitals', title: 'M Vitals', version: '2.1.0', status: 'available', size: 412000, source: 'idrive7-apps' }),
            comp({ id: 'extended_dashboard', title: 'Extended dashboard', version: '1.3.0', installed: '1.2.0', status: 'update',
                queued: true, source: 'idrive7-apps' }),
            comp({ id: 'oap-cardash', title: 'Car Data', version: '1.1.4', status: 'available', mguHmi: ['ID8'], compat: 'no',
                source: 'usb:STICK', size: 920000 }),
            comp({ id: 'drive_recorder', title: 'Drive Recorder', version: '1.0.6', status: 'available', source: 'usb:STICK', size: 210000 }),
            comp({ id: 'vehicle_control', title: 'Vehicle control', version: '1.0.0', installed: '1.0.0', status: 'installed',
                error: 'the build failed (exit 3)', source: 'mgu-store' }),
            comp({ id: 'mgu-updater', kind: 'tool', title: 'Updater', version: '0.4.0', installed: '0.4.0', status: 'installed',
                uninstallable: false }),
            comp({ id: 'mgu-uplink', kind: 'tool', title: 'Network driver', version: '0.4.0', installed: '0.4.0', status: 'installed',
                optional: true, previous: '0.3.2' }),
            comp({ id: 'mgu-render', kind: 'tool', title: 'Renderer', version: '0.1.0', status: 'available', optional: true,
                provides: 'renderer', size: 140000 }),
            comp({ id: 'mgu-renderd', kind: 'tool', title: 'GPU renderer', version: '1.1.0', installed: '1.1.0', status: 'installed',
                provides: 'renderer', source: 'usb:STICK' }),
            comp({ id: 'display-bridge', kind: 'tool', title: 'Display bridge', version: '0.2.3', installed: '0.2.3', status: 'installed',
                pendingReboot: true })
        ]
    };
}

/* The drawn screens: [name, model overrides, state overrides]. */
function screens() {
    const st = state();
    const signing = Object.assign({}, st, { login: { url: 'https://github.com/login/device', code: 'WDJB-MJHT',
        expiresAt: 0, status: 'pending', error: null } });
    const webOn = Object.assign({}, st, { web: { enabled: true, urls: ['http://172.16.222.97:8470/'], error: null } });
    const main = [{ name: 'main' }];
    return [
        ['store', { tab: 'store', stack: main }],
        ['store-apps', { tab: 'store', filter: 'app', stack: main, focus: 9 }],
        ['app-update', { stack: main.concat([{ name: 'app', id: 'gauges' }]) }],
        ['app-downloading', { stack: main.concat([{ name: 'app', id: 'doom' }]) }],
        ['app-incompatible', { stack: main.concat([{ name: 'app', id: 'oap-cardash' }]) }],
        ['app-renderer', { stack: main.concat([{ name: 'app', id: 'mgu-render' }]) }],
        ['confirm-remove', { stack: main.concat([{ name: 'app', id: 'gauges' }, { name: 'confirm', kind: 'remove', id: 'gauges' }]),
            focus: 0 }],
        ['confirm-remove-tools', { stack: main.concat([{ name: 'app', id: 'gauges' }, { name: 'confirm', kind: 'remove', id: 'gauges' }]),
            focus: 0 }, { components: st.components.map((c) => (c.id === 'gauges' ? Object.assign({}, c, { requiredAlone: ['display-bridge', 'mgu-renderd', 'mgu-uplink', 'mgu-render'] }) : c)) }],
        ['app-remove-refused', { stack: main.concat([{ name: 'app', id: 'mgu-uplink' }]),
            removeNote: { id: 'mgu-uplink', error: 'Vehicle control needs mgu-uplink', by: 'vehicle_control' } }],
        ['tool-undo', { tab: 'installed', stack: main.concat([{ name: 'app', id: 'mgu-uplink' }]) }],
        ['confirm-undo', { tab: 'installed', stack: main.concat([{ name: 'app', id: 'mgu-uplink' }, { name: 'confirm', kind: 'undo', id: 'mgu-uplink' }]),
            focus: 0 }],
        ['installed', { tab: 'installed', stack: main }],
        // nothing installing, a restart pending: Restart now on Store and Installed (with a tool that does not work)
        ['store-restart', { tab: 'store', stack: main }, idleSt(st)],
        ['installed-restart', { tab: 'installed', stack: main }, failedSt(idleSt(st), 'mgu-uplink', { repair: 'installed under firmware 23-07' })],
        ['usb', { tab: 'usb', stack: main }],
        ['settings', { tab: 'settings', stack: main }],
        ['confirm-restart', { tab: 'settings', stack: main.concat([{ name: 'confirm', kind: 'restart' }]), focus: 0 }, idleSt(st)],
        ['source', { tab: 'settings', stack: main.concat([{ name: 'source', id: 'idrive7-apps' }]) }],
        ['source-install-app', { tab: 'settings', stack: main.concat([{ name: 'source', id: 'car-apps' }]) }],
        ['accounts', { tab: 'settings', stack: main.concat([{ name: 'accounts' }]) }],
        ['confirm-account', { tab: 'settings', stack: main.concat([{ name: 'accounts' },
            { name: 'confirm', kind: 'account-remove', id: '3f9a01c2' }]), focus: 1 }],
        ['login', { tab: 'settings', stack: main.concat([{ name: 'accounts' }, { name: 'login' }]) }, signing],
        ['phone', { tab: 'settings', stack: main.concat([{ name: 'phone' }]),
            webText: 'http://172.16.222.97:8470/#t=6f1c0e3d9a2b4c5d8e7f6a5b4c3d2e1f\n' }, webOn],
        ['accounts-token-refused', { tab: 'settings', stack: main.concat([{ name: 'accounts' }]),
            accountsNote: { text: 'Add token failed: GitHub does not accept this token', error: true } }],
        ['pick', { tab: 'settings', stack: main.concat([{ name: 'pick' }]), pick: { repo: 'cauliflowermossgrape/idrive7-apps',
            probe: { status: 'ok', releases: true, tags: false, defaultBranch: 'develop', branches: ['main', 'develop', 'feature/gauges', 'redline'] } } }],
        ['pick-private', { tab: 'settings', stack: main.concat([{ name: 'pick' }]), pick: { repo: 'someone/private-apps',
            probe: { status: 'auth-needed' } } }],
        ['pick-offline', { tab: 'settings', stack: main.concat([{ name: 'pick' }]), pick: { repo: 'someone/apps', probe: { status: 'offline' } } }],
        // the drawn keyboard's pages: URL keys; a token; word keys and their symbols page
        ['type', { tab: 'settings', stack: main.concat([{ name: 'type', title: 'Add source', text: 'robertnisipeanu/mgu-store' }]) }],
        ['type-token', { tab: 'settings', stack: main.concat([{ name: 'accounts' }, { name: 'type', title: 'GitHub token', text: 'ghp_1a2b3c4d',
            secret: true, shift: true }]) }],
        ['type-text', { tab: 'settings', stack: main.concat([{ name: 'type', title: 'Password', text: 'Wi', layout: 'text', symbols: true,
            go: 'Connect' }]) }],
        ['type-symbols', { tab: 'settings', stack: main.concat([{ name: 'type', title: 'Password', text: 'Wi-\\"`', layout: 'text', symbols: true,
            sym: true, go: 'Connect' }]) }],
        // Wi-Fi (the uplink's): its networks, off, a join that failed, paused for wireless Android Auto (and in Settings for
        // CarPlay); a password; Forget; the preferred connection (Settings' row)
        ['wifi', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) }],
        ['wifi-off', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) },
            wifiSt(st, { enabled: false, link: 'off', ssid: '', ip: '', signal: null, networks: [] })],
        ['wifi-failed', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) },
            wifiSt(st, { link: 'idle', ssid: '', ip: '', signal: null, error: 'could not join "FRITZ!Box 7590 XY" (wrong password, or out of range)',
                networks: st.uplink.wifi.networks.map((n) => Object.assign({}, n, { current: false })) })],
        ['wifi-paused', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) },
            wifiSt(st, { link: 'idle', ssid: '', ip: '', signal: null, paused: 'android-auto',
                networks: st.uplink.wifi.networks.map((n) => Object.assign({}, n, { current: false })) })],
        ['settings-wifi-band', { tab: 'settings', stack: main }, wifiSt(st, { freq: 5745 })],
        ['wifi-band', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) }, wifiSt(st, { freq: 2437 })],
        ['wifi-5ghz-only', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) }, wifiSt(st, { fiveOnly: true, freq: 5745 })],
        ['wifi-5ghz-only-ap', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) },
            wifiSt(st, { fiveOnly: true, freq: 5180, ssid: 'FRITZ!Box 7590 XY', networks: [] })],
        ['settings-wifi-paused', { tab: 'settings', stack: main }, wifiSt(st, { link: 'idle', ssid: '', ip: '', signal: null, paused: 'carplay' })],
        ['wifi-password', { tab: 'settings', stack: main.concat([{ name: 'wifi' }, { name: 'type', title: 'FRITZ!Box 7590 XY', text: 'sec',
            label: 'Password', layout: 'text', symbols: true, go: 'Connect', min: 8, max: 63, secret: 'password' }]) }],
        ['confirm-wifi-forget', { tab: 'settings', stack: main.concat([{ name: 'wifi' }, { name: 'confirm', kind: 'wifi-forget', ssid: 'Home' }]),
            focus: 0 }],
        ['prefer', { tab: 'settings', stack: main.concat([{ name: 'prefer' }]) }],
        // the proxy: off, on, failing; its address typed
        ['proxy', { tab: 'settings', stack: main.concat([{ name: 'proxy' }]) }],
        ['proxy-on', { tab: 'settings', stack: main.concat([{ name: 'proxy' }]) }, proxySt({ on: true, kind: 'socks5', address: '192.168.8.1:7891' })],
        ['proxy-error', { tab: 'settings', stack: main.concat([{ name: 'proxy' }]) },
            proxySt({ on: true, kind: 'http', address: '192.168.8.1:7890', error: 'proxy 192.168.8.1:7890: connection refused (5 tries)' })],
        ['settings-proxy-on', { tab: 'settings', stack: main }, proxySt({ on: true, kind: 'socks5', address: '192.168.8.1:7891' })],
        ['type-proxy', { tab: 'settings', stack: main.concat([{ name: 'proxy' }, { name: 'type', title: 'Proxy', label: 'Address',
            text: 'socks5://192.168.8.1:7891', layout: 'text', symbols: true, max: 300 }]) }],
        ['offline', { tab: 'store', stack: main, connected: false, st: null, secret: false }],
        // an error of about 200 characters: on a component's page, a source's page
        ['app-failed', { stack: main.concat([{ name: 'app', id: 'vehicle_control' }]) }, failedSt(st, 'vehicle_control', { error: LONG_ERROR })],
        ['source-failed', { tab: 'settings', stack: main.concat([{ name: 'source', id: 'car-apps' }]) }, sourceFailed(st)]
    ];
}

/* State overrides: nothing installing or waiting. */
function idleSt(st) {
    return { busy: null, components: st.components.map((c) => Object.assign({}, c, { queued: false })) };
}

/* State overrides: nothing installing, component id with o over it. */
function failedSt(st, id, o) {
    return { busy: null, components: st.components.map((c) => (c.id === id ? Object.assign({}, c, o) : c)) };
}

/* State overrides: IterioDev/car-apps could not be read, and the check failed on it. */
function sourceFailed(st) {
    return { catalog: Object.assign({}, st.catalog, { error: `IterioDev/car-apps: ${LONG_ERROR}` }),
        sources: st.sources.map((s) => (s.id === 'car-apps' ? Object.assign({}, s, { status: 'error', error: LONG_ERROR }) : s)) };
}

/* State overrides: the proxy setting p. */
function proxySt(p) {
    return { proxy: Object.assign({ on: false, kind: null, address: null, auth: false, error: null }, p) };
}

/* State overrides: the uplink's Wi-Fi with w over it. */
function wifiSt(st, w) {
    return { uplink: Object.assign({}, st.uplink, { wifi: Object.assign({}, st.uplink.wifi, w) }) };
}

function model(over, stOver) {
    const st = state();
    return Object.assign({ st: stOver && stOver.type ? stOver : Object.assign(st, stOver || {}), connected: true, secret: true,
        version: '0.7.0', stack: [{ name: 'main' }], tab: 'store', filter: 'all', focus: -1, scroll: {}, note: '',
        login: { waiting: false, refusal: null }, webText: '', accountsNote: { text: '', error: false } }, over);
}

module.exports = { state, screens, model, LONG_ERROR };
