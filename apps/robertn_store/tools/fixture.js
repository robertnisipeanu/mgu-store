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

function state() {
    return {
        type: 'state', updater: { version: '0.4.0' }, online: true, privacy: 'patched',
        unit: { hmi: 'ID7', firmware: 'BMW MGU P18_23w44.2-1-3 mgu-high' },
        allProviders: { renderer: [{ id: 'mgu-renderd', version: '1.1.0' }] },
        catalog: { commit: 'x', checkedAt: Date.UTC(2026, 9, 26, 12, 2), checking: false, error: null },
        sources: [
            { id: 'mgu-store', type: 'github', label: 'robertnisipeanu/mgu-store', builtin: true, usb: false, channel: 'releases',
                status: 'ok', error: null, auth: { kind: 'github', token: '3f9a01c2', login: 'robertn' }, checkedAt: 1, components: 6 },
            { id: 'idrive7-apps', type: 'github', label: 'cauliflowermossgrape/idrive7-apps', builtin: false, usb: false, channel: 'branch:main',
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
        uplink: { device: { kind: 'wifi', name: 'Mario iPhone' }, state: 'online', error: null, preferred: 'wifi',
            wifi: { enabled: true, link: 'online', ssid: 'Mario iPhone', ip: '172.20.10.3', signal: -52, scanning: false, error: null,
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
                optional: true }),
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
        // the update history: a branch's commits (the newest two not installed yet); a tool's CHANGELOG versions
        ['app-update', { stack: main.concat([{ name: 'app', id: 'gauges' }]), history: { id: 'gauges', status: 'ok', items: [
            { title: 'Gauges: the boost gauge reads in bar or psi', text: '', date: '2026-10-28', rev: '73eab72', new: true },
            { title: 'Gauges: page tabs open their page on a tap', text: '', date: '2026-10-27', rev: 'da63270', new: true },
            { title: 'Gauges: oil temperature on the first page', text: '', date: '2026-10-20', rev: '4b1c9e0', new: false }] } }],
        ['app-history-loading', { stack: main.concat([{ name: 'app', id: 'doom' }]), history: { id: 'doom', status: 'loading', items: [] } }],
        ['app-downloading', { stack: main.concat([{ name: 'app', id: 'doom' }]) }],
        ['app-incompatible', { stack: main.concat([{ name: 'app', id: 'oap-cardash' }]) }],
        ['app-renderer', { stack: main.concat([{ name: 'app', id: 'mgu-render' }]), history: { id: 'mgu-render', status: 'ok', items: [
            { title: '0.4.0', text: 'Video for third-party apps: a player writes decoded frames, the app draws them where its picture goes.',
                date: '', rev: '', new: true },
            { title: '0.3.3', text: 'Another renderer\'s apps are no longer hidden by the foreground gate.', date: '', rev: '', new: false }] } }],
        // the version pressed on its page: every entry in full
        ['changelog-renderer', { stack: main.concat([{ name: 'app', id: 'mgu-render' }, { name: 'changelog', id: 'mgu-render' }]), history: { id: 'mgu-render', status: 'ok', items: [
            { title: '0.4.0', text: '- Video for third-party apps: a player writes decoded frames, the app draws them where its picture goes, and the renderer draws the newest frame each time it draws the app.\n- Another line.', date: '', rev: '', new: true },
            { title: '0.3.3', text: 'Another renderer\'s apps are no longer hidden by the foreground gate.', date: '', rev: '', new: false }] } }],
        ['confirm-remove', { stack: main.concat([{ name: 'app', id: 'gauges' }, { name: 'confirm', kind: 'remove', id: 'gauges' }]),
            focus: 0 }],
        ['installed', { tab: 'installed', stack: main }],
        ['usb', { tab: 'usb', stack: main }],
        ['settings', { tab: 'settings', stack: main }],
        ['confirm-restart', { tab: 'settings', stack: main.concat([{ name: 'confirm', kind: 'restart' }]), focus: 0 },
            { busy: null, components: st.components.map((c) => Object.assign({}, c, { queued: false })) }],
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
        // Wi-Fi (the uplink's): its networks, off, a join that failed; a password; Forget; the preferred connection
        ['wifi', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) }],
        ['wifi-off', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) },
            wifiSt(st, { enabled: false, link: 'off', ssid: '', ip: '', signal: null, networks: [] })],
        ['wifi-failed', { tab: 'settings', stack: main.concat([{ name: 'wifi' }]) },
            wifiSt(st, { link: 'idle', ssid: '', ip: '', signal: null, error: 'could not join "FRITZ!Box 7590 XY" (wrong password, or out of range)',
                networks: st.uplink.wifi.networks.map((n) => Object.assign({}, n, { current: false })) })],
        ['wifi-password', { tab: 'settings', stack: main.concat([{ name: 'wifi' }, { name: 'type', title: 'FRITZ!Box 7590 XY', text: 'sec',
            label: 'Password', layout: 'text', symbols: true, go: 'Connect', min: 8, max: 63, secret: 'password' }]) }],
        ['confirm-wifi-forget', { tab: 'settings', stack: main.concat([{ name: 'wifi' }, { name: 'confirm', kind: 'wifi-forget', ssid: 'Home' }]),
            focus: 0 }],
        ['prefer', { tab: 'settings', stack: main.concat([{ name: 'wifi' }, { name: 'prefer' }]) }],
        ['offline', { tab: 'store', stack: main, connected: false, st: null, secret: false }],
        ['internet', { tab: 'settings', stack: main.concat([{ name: 'internet' }]) }],
        ['internet-offline', { tab: 'settings', stack: main.concat([{ name: 'internet' }]) }, { online: false }],
        ['store-no-internet', { tab: 'store', stack: main }, { online: false, busy: null }]
    ];
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

module.exports = { state, screens, model };
