'use strict';
/**
 * What the renderer screens (src/am_screens.js) show, from mgu-updater's
 * state: view(model) -> { screen, values: { element: opts } } for the page on
 * top. No I/O, so tools/test_screens.js checks every page offline. Based on
 * IterioDev's App Manager 2 view (mgu-app-store apps/oap-appmanager/
 * javascript/store_ui.js, reused with his permission), fed from the
 * updater's components, sources, accounts, sign-in and phone page.
 *
 * model: { st (the updater's state or null), connected, secret (whether the
 * updater secret is there), version (this Store's), stack (pages; the first
 * { name: 'main' }), tab (store, installed, usb, settings), filter (all,
 * app, tool), note (the Sources status line), login ({ waiting, refusal }),
 * webText (the web-url file), accountsNote ({ text, error }: the Accounts
 * status line) }.
 *
 * What a press does rides on the values as `act`: on a button's opts, on
 * each nav, grid and list item, on each filter cell (acts). The acts:
 * { do: 'tab', tab }, { do: 'filter', filter }, { do: 'open', page },
 * { do: 'back' }, { do: 'check' }, { do: 'install', id }, { do: 'update-all' },
 * { do: 'remove', id }, { do: 'restart' },
 * { do: 'source-remove', id }, { do: 'account-remove', id }, { do: 'add-source' },
 * { do: 'add-token' }, { do: 'sign-in' }, { do: 'sign-in-cancel' }, { do: 'phone' }.
 */
const { PHASE, percent, rowAction, statusLine, sourceLabel, sourceState, sourceActions, sourceChannel, sourceAccount,
    tokenLabel, tokenState, tokenSources, accountsState, loginStatus, loginCode, phoneState, phoneAddress, hmiNames,
    notForUnit, removable } = require('./store_view.js');

const GREEN = '#35d07f';
const BLUE = '#3d9bff';
const AMBER = '#ffb020';
const RED = '#ff5a5f';
const TEAL = '#36e0c0';
const DIM = 'dim';
const PALETTE = [['#2d7fd6', '#16588e'], ['#ff4b55', '#a8101c'], ['#ffc24d', '#c77700'], ['#5fb4ff', '#1f5fd0'],
    ['#b48cff', '#6a3fd0'], ['#36e0c0', '#118c78'], ['#5be38e', '#1f9a52'], ['#ff8a4c', '#c4501a']];
const TABS = ['store', 'installed', 'usb', 'settings'];
const FILTERS = ['all', 'app', 'tool'];

const size = (b) => (!b ? '' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
function colors(id) {           // a steady colour per component for its letter tile
    let h = 0;
    for (const ch of String(id)) {
        h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    }
    return PALETTE[h % PALETTE.length].join(',');
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isTool = (c) => c.kind !== 'app';
/* The version a row would install: a branch's new commit, else its version. */
const target = (c) => (c.revision && c.version === c.installed ? c.revision : c.version);

function comps(m) {
    return m.connected && m.st && Array.isArray(m.st.components) ? m.st.components : [];
}
function sources(m) {
    return m.connected && m.st && Array.isArray(m.st.sources) ? m.st.sources : null;
}
function tokens(m) {
    return m.connected && m.st && Array.isArray(m.st.tokens) ? m.st.tokens : null;
}
function find(list, id) {
    return (list || []).find((x) => x.id === id) || null;
}
const busyOf = (m) => (m.connected && m.st ? m.st.busy : null);

/* Restart head unit is offered while nothing installs or waits, the updater
 * is there and not restarting the unit (one before 0.1.4 reports no
 * rebooting). */
function canRestart(m) {
    const st = m.st;
    return !!(m.connected && st && !st.busy && st.rebooting === false && !comps(m).some((c) => c.queued));
}

/* The icon fields of a component: its picture (components[].icon, a file
 * the Store reads), else a letter tile; tools round. */
function iconOf(c) {
    return { icon: c.icon ? `key:${c.icon}` : '', vicon: '', letter: String(c.title || c.id || '?')[0], kind: isTool(c) ? 'service' : 'app',
        colors: colors(c.id), badge: '', progress: -1 };
}

/* A tile's second line, its colour, badge and progress. */
function tileState(c, busy) {
    if (busy && busy.id === c.id) {
        const p = busy.phase === 'download' ? percent(busy) : -1;
        return { sub: p >= 0 ? `Downloading ${p} %` : PHASE[busy.phase] || 'Installing', subColor: BLUE, badge: '',
            progress: p >= 0 ? p / 100 : 1 };
    }
    if (c.queued) {
        return { sub: 'Waiting', subColor: AMBER, badge: 'queued', progress: -1 };
    }
    if (notForUnit(c)) {
        return { sub: 'Not for this head unit', subColor: AMBER, badge: c.installed ? 'installed' : '', progress: -1 };
    }
    if (c.blocked) {
        return c.installed ? { sub: 'Installed', subColor: GREEN, badge: 'installed', progress: -1 }
            : { sub: 'Not installable', subColor: AMBER, badge: '', progress: -1 };
    }
    if (c.error) {
        return { sub: 'Failed', subColor: RED, badge: '', progress: -1 };
    }
    if (c.status === 'update') {
        return { sub: `Update ${target(c)}`, subColor: BLUE, badge: 'update', progress: -1 };
    }
    if (c.status === 'available') {
        return { sub: [c.version, size(c.size)].filter(Boolean).join(' · '), subColor: DIM, badge: '', progress: -1 };
    }
    if (c.pendingReboot) {
        return { sub: 'Restart pending', subColor: AMBER, badge: 'installed', progress: -1 };
    }
    return { sub: 'Installed', subColor: GREEN, badge: 'installed', progress: -1 };
}

function tile(c, busy) {
    return Object.assign(iconOf(c), { id: c.id, title: c.title, act: { do: 'open', page: { name: 'app', id: c.id } } }, tileState(c, busy));
}

function nav(m, sel) {
    const updates = comps(m).filter((c) => c.status === 'update' && !notForUnit(c) && !c.blocked).length;
    const usbIds = (sources(m) || []).filter((s) => s.usb).map((s) => s.id);
    const usbNew = comps(m).filter((c) => usbIds.indexOf(c.source) >= 0 && (c.status === 'available' || c.status === 'update') &&
        !notForUnit(c) && !c.blocked).length;
    return { sel, items: [['Store', 'grid', ''], ['Installed', 'check', updates || ''], ['USB', 'usb', usbNew || ''], ['Settings', 'gear', '']]
        .map(([label, vicon, badge], i) => ({ id: TABS[i], label, vicon, badge: String(badge), act: { do: 'tab', tab: TABS[i] } })) };
}

const hidden = { hidden: true };
const button = (text, act, extra) => Object.assign({ hidden: false, disabled: false, text, act, vicon: '' }, extra);

/* ---- the tabs ---- */

function storeView(m) {
    const busy = busyOf(m);
    const busyRow = busy && find(comps(m), busy.id);
    const list = comps(m).filter((c) => m.filter === 'all' || (m.filter === 'app' ? !isTool(c) : isTool(c)));
    const checking = !!(m.connected && m.st && m.st.catalog && m.st.catalog.checking);
    const online = m.connected && m.st && m.st.online;
    return {
        title: { text: 'Store' },
        subtitle: busyRow ? { text: `${busy.phase === 'download' ? `Downloading ${percent(busy)} %` : PHASE[busy.phase] || 'Installing'} · ${busyRow.title}`, color: BLUE }
            : { text: m.connected ? statusLine(m.st, true) : statusLine(null, false, m.secret), color: DIM },
        filter: { sel: Math.max(0, FILTERS.indexOf(m.filter)), acts: FILTERS.map((f) => ({ do: 'filter', filter: f })) },
        online: { items: !m.connected ? [] : checking ? [{ text: 'Checking', color: BLUE, dot: true }]
            : online ? [{ text: 'Online', color: GREEN, dot: true }] : [{ text: 'Offline', color: AMBER, dot: true }] },
        grid: { items: list.map((c) => tile(c, busy)), empty: m.connected ? 'Nothing here' : '' }
    };
}

function installedView(m) {
    const busy = busyOf(m);
    const all = comps(m).filter((c) => c.installed);
    const apps = all.filter((c) => !isTool(c));
    const tools = all.filter(isTool);
    const updates = all.filter((c) => c.status === 'update' && rowAction(c, busy) === 'install');
    const item = (c) => {
        const s = tileState(c, busy);
        const up = c.status === 'update' && s.badge === 'update';
        const open = { do: 'open', page: { name: 'app', id: c.id } };
        return Object.assign(iconOf(c), { id: c.id, title: c.title, act: open,
            sub: up ? `${c.installed} → ${target(c)}` : `${c.installed}${isTool(c) ? ' · tool' : ''}`, subColor: up ? BLUE : DIM,
            right: up ? 'chip:Update' : s.sub !== 'Installed' ? `chip:${s.sub}` : 'chevron', chipColor: up ? BLUE : s.subColor,
            chipAct: up ? { do: 'install', id: c.id } : null });
    };
    return {
        title: { text: 'Installed' },
        subtitle: { text: `${plural(apps.length, 'app')} · ${plural(tools.length, 'tool')}` },
        updateAll: updates.length ? button(`Update all (${updates.length})`, { do: 'update-all' }, { vicon: 'arrowDown', style: 'primary', color: BLUE }) : hidden,
        apps: { items: apps.map(item), empty: 'None' },
        services: { items: tools.map(item), empty: 'None', rowH: 120 }
    };
}

function usbView(m) {
    const busy = busyOf(m);
    const usb = (sources(m) || []).filter((s) => s.usb);
    const ids = usb.map((s) => s.id);
    const list = comps(m).filter((c) => ids.indexOf(c.source) >= 0);
    return {
        title: { text: 'USB' },
        subtitle: { text: usb.length ? `${usb.map(sourceLabel).join(', ')} · ${plural(list.length, 'package')}` : '' },
        grid: { items: list.map((c) => tile(c, busy)), empty: usb.length ? 'Nothing here' : 'No USB stick' }
    };
}

function sourceRow(s) {
    const status = sourceState(s);
    const bad = ['Sign in', 'Error', 'Offline'].indexOf(status) >= 0;
    const line = [sourceChannel(s), sourceAccount(s), typeof s.components === 'number' ? plural(s.components, 'component') : '']
        .filter(Boolean).join(' · ');
    return { id: s.id, title: sourceLabel(s), sub: bad || status === 'Checking' ? status : line || status,
        subColor: bad ? AMBER : status === 'Checking' ? BLUE : DIM, plain: true,
        vicon: bad ? 'warning' : s.usb ? 'usb' : s.auth ? 'lock' : 'unlock', iconColor: bad ? AMBER : GREEN,
        right: 'chevron', act: { do: 'open', page: { name: 'source', id: s.id } } };
}

function settingsView(m) {
    const st = m.st;
    const srcs = sources(m);
    const toks = tokens(m);
    const web = m.connected && st && st.web && typeof st.web === 'object' ? st.web : null;
    const access = [];
    if (toks) {
        access.push({ id: 'accounts', title: 'Accounts', sub: accountsState(toks), plain: true, vicon: 'lock', iconColor: 'text',
            right: 'chevron', act: { do: 'open', page: { name: 'accounts' } } });
    }
    if (web) {
        access.push({ id: 'phone', title: 'Phone access', sub: phoneState(web), plain: true, vicon: 'phone', iconColor: 'text',
            right: 'chevron', act: { do: 'open', page: { name: 'phone' } } });
    }
    const unit = st && st.unit;
    const renderers = st && st.allProviders && Array.isArray(st.allProviders.renderer) ? st.allProviders.renderer : [];
    return {
        note: { text: m.note || '' },
        repos: srcs ? { items: srcs.map(sourceRow), empty: 'None' } : { items: [], empty: '' },
        addRepo: srcs ? button('Add source', { do: 'add-source' }, { vicon: 'plus', style: 'tinted', color: BLUE }) : hidden,
        access: { items: access },
        connLabel: { text: access.length ? 'ACCESS' : 'HEAD UNIT' },
        unit: { text: unit && unit.hmi ? [hmiNames([unit.hmi]), unit.firmware].filter(Boolean).join(' · ') : '' },
        versions: { text: [st && st.updater ? `Updater ${st.updater.version}` : '', m.version ? `Store ${m.version}` : '',
            renderers.length ? `Renderer ${renderers.map((r) => `${r.id} ${r.version}`).join(', ')}` : ''].filter(Boolean).join(' · ') },
        checkNow: m.connected ? button(st.catalog && st.catalog.checking ? 'Checking' : 'Check now', { do: 'check' },
            { vicon: 'refresh', style: 'outline', size: 26 }) : hidden,
        restart: canRestart(m) ? button('Restart head unit', { do: 'open', page: { name: 'confirm', kind: 'restart' } },
            { vicon: 'refresh', style: 'outline', size: 26 }) : hidden
    };
}

/* ---- pages ---- */

function appView(m, id) {
    const c = find(comps(m), id);
    if (!c) {
        return { name: { text: 'Not listed' }, author: { text: '' }, facts: { items: [] }, desc: { text: '' }, icon: { letter: '?' },
            instValue: { text: '' }, availLabel: { text: '' }, availValue: { text: '' }, note1: { text: '' }, note2: { text: '' },
            note3: { text: '' }, progress: hidden, primary: hidden, secondary: hidden };
    }
    const busy = busyOf(m);
    const s = tileState(c, busy);
    const mine = busy && busy.id === c.id;
    const src = find(sources(m), c.source);
    const avail = (c.status === 'update' || c.status === 'available') && !(c.blocked && c.installed);
    const v = {
        icon: Object.assign(iconOf(c), { badge: mine ? '' : s.badge, progress: s.progress }),
        name: { text: c.title },
        author: { text: [c.author && `by ${c.author}`, `from ${src ? sourceLabel(src) : c.source}`].filter(Boolean).join(' · ') },
        facts: { items: [{ text: `Version ${c.version}` }, c.revision && { text: `Commit ${c.revision}` }, c.size && { text: size(c.size) },
            // installed under another id than its source's: another source's app has that one
            c.listedId && !c.blocked && { text: `Id ${c.id}` },
            { text: isTool(c) ? 'Tool' : 'App', color: isTool(c) ? TEAL : BLUE }, c.mguHmi && c.mguHmi.length && { text: hmiNames(c.mguHmi) },
            c.provides && { text: c.provides }].filter(Boolean) },
        desc: { text: c.description || '' },
        instLabel: { text: 'Installed' },
        instValue: { text: c.installed || '–' },
        availLabel: { text: avail ? 'Available' : '' },
        availValue: { text: avail ? target(c) : '', color: notForUnit(c) ? AMBER : c.status === 'update' ? BLUE : 'text' }
    };
    const notes = [];
    if (notForUnit(c)) {
        notes.push(['Not for this head unit', AMBER]);
        if (c.mguHmi && c.mguHmi.length) {
            notes.push([`For ${hmiNames(c.mguHmi)}`, AMBER]);
        }
    }
    if (c.blocked) {
        notes.push([c.blocked, AMBER]);
    }
    if (c.error && !mine) {
        notes.push([`Failed: ${c.error}`, RED]);
    }
    if (c.pendingReboot) {
        notes.push(['Restart pending', AMBER]);
    }
    ['note1', 'note2', 'note3'].forEach((k, i) => {
        v[k] = notes[i] ? { text: String(notes[i][0]).slice(0, 80), color: notes[i][1] } : { text: '' };
    });
    v.progress = mine ? { hidden: false, label: PHASE[busy.phase] || 'Installing', value: busy.phase === 'download' ? percent(busy) : 100,
        right: busy.phase === 'download' ? `${percent(busy)} %` : '',
        sub: busy.phase === 'download' && busy.total ? `${size(busy.progress)} of ${size(busy.total)}` : '' }
        : c.queued ? { hidden: false, label: 'Waiting', value: 0, right: '', sub: '' } : hidden;
    const action = rowAction(c, busy);
    if (action === 'install') {
        v.primary = button(c.error ? 'Try again' : c.status === 'update' ? `Update to ${target(c)}` : 'Install', { do: 'install', id: c.id },
            { vicon: c.error ? 'refresh' : 'arrowDown', style: 'primary', color: BLUE });
    } else if (c.pendingReboot && canRestart(m)) {
        v.primary = button('Restart head unit', { do: 'open', page: { name: 'confirm', kind: 'restart' } },
            { vicon: 'refresh', style: 'primary', color: BLUE });
    } else {
        v.primary = hidden;
    }
    v.secondary = removable(c, busy) ? button('Remove', { do: 'open', page: { name: 'confirm', kind: 'remove', id: c.id } },
        { vicon: 'trash', style: 'outline' }) : hidden;
    return v;
}

function confirmView(m, page) {
    const all = comps(m);
    const c = find(all, page.id);
    const icon = c ? iconOf(c) : { vicon: page.kind === 'restart' ? 'refresh' : page.kind === 'account-remove' ? 'lock' : 'warning',
        kind: 'service', colors: '#3a4352,#232a35' };
    let title = '';
    let line = '';
    let now = null;
    if (page.kind === 'remove') {
        title = c ? `Remove ${c.title} ${c.installed || ''}?`.replace(' ?', '?') : 'Remove?';
        now = button('Remove', { do: 'remove', id: page.id }, { vicon: 'trash', style: 'primary', color: RED });
    } else if (page.kind === 'restart') {
        title = 'Restart head unit?';
        now = button('Restart', { do: 'restart' }, { vicon: 'refresh', style: 'primary', color: BLUE });
    } else if (page.kind === 'source-remove') {
        const s = find(sources(m), page.id);
        title = 'Remove source?';
        line = s ? sourceLabel(s) : page.id;
        now = button('Remove', { do: 'source-remove', id: page.id }, { vicon: 'trash', style: 'primary', color: RED });
    } else if (page.kind === 'account-remove') {
        const t = find(tokens(m), page.id);
        title = 'Remove account?';
        line = t ? [tokenLabel(t), tokenSources(t, sources(m))].filter(Boolean).join(' · ') : page.id;
        now = button('Remove', { do: 'account-remove', id: page.id }, { vicon: 'trash', style: 'primary', color: RED });
    }
    return { icon, title: { text: title }, text: { text: line }, now, later: button('Cancel', { do: 'back' }, { vicon: 'back', style: 'outline' }),
        note: { text: '' } };
}

function sourceView(m, id) {
    const s = find(sources(m), id);
    if (!s) {
        return { name: { text: 'Not listed' }, state: { text: '' }, facts: { items: [] }, desc: { text: '' }, appLabel: { text: '' },
            appQr: { text: '' }, appUrl: { text: '' }, remove: hidden };
    }
    const r = sourceRow(s);
    const app = m.st && m.st.signinApp;
    const signedIn = (tokens(m) || []).some((t) => !t.rejected);
    const installUrl = s.status === 'auth-needed' && app && app.installUrl && signedIn ? String(app.installUrl) : '';
    return {
        icon: { vicon: r.vicon, kind: 'service', colors: r.vicon === 'warning' ? '#ffc04d,#c98a12' : '#3a4352,#232a35' },
        name: { text: sourceLabel(s) },
        state: { text: sourceState(s), color: r.subColor },
        facts: { items: [sourceChannel(s) && { text: sourceChannel(s) }, sourceAccount(s) && { text: sourceAccount(s) },
            typeof s.components === 'number' && { text: plural(s.components, 'component') }].filter(Boolean) },
        desc: { text: s.error ? String(s.error) : '' },
        panel: { hidden: !installUrl },
        appLabel: { text: installUrl ? 'Install on GitHub' : '' },
        appQr: { text: installUrl },
        appUrl: { text: installUrl },
        remove: sourceActions(s).remove ? button('Remove', { do: 'open', page: { name: 'confirm', kind: 'source-remove', id: s.id } },
            { vicon: 'trash', style: 'outline' }) : hidden
    };
}

function accountsView(m) {
    const toks = tokens(m) || [];
    const note = m.accountsNote || { text: '', error: false };
    return {
        status: { text: note.text, color: note.error ? AMBER : DIM },
        list: { items: toks.map((t) => ({ id: t.id, title: tokenLabel(t), sub: tokenState(t), subColor: t.rejected ? RED : DIM,
            letter: tokenLabel(t)[0], colors: colors(t.id), kind: 'service', right: 'chevron',
            act: { do: 'open', page: { name: 'confirm', kind: 'account-remove', id: t.id } } })), empty: 'None' },
        // Sign in with GitHub only with the updater's GitHub App (state.signin)
        signIn: m.st && m.st.signin === true ? button('Sign in with GitHub', { do: 'sign-in' }, { vicon: 'plus', style: 'primary', color: BLUE }) : hidden,
        addToken: m.connected && m.st ? button('Add token', { do: 'add-token' }, { vicon: 'plus', style: 'outline' }) : hidden
    };
}

function loginView(m) {
    const reported = m.connected && m.st ? m.st.login : null;
    const login = m.login && m.login.waiting ? null : reported;
    const code = loginCode(login);
    const status = loginStatus(login, m.login && m.login.refusal);
    return {
        qr: { text: code ? login.url : '' },
        code: { text: code },
        url: { text: code ? login.url : '' },
        status: { text: status, color: /failed|expired/i.test(status) ? AMBER : DIM },
        cancel: button('Cancel', { do: 'sign-in-cancel' }, { style: 'outline' })
    };
}

function phoneView(m) {
    const web = m.connected && m.st && m.st.web && typeof m.st.web === 'object' ? m.st.web : null;
    const address = web ? phoneAddress(web, m.webText) : { qr: '', text: '' };
    return {
        toggleRow: { items: web ? [{ id: 'phone', title: 'Phone access', sub: phoneState(web), plain: true, vicon: 'phone', iconColor: 'text',
            right: `toggle:${web.enabled ? 'on' : 'off'}`, act: { do: 'phone' } }] : [] },
        url: { text: address.text },
        error: { text: web && web.error ? String(web.error) : '' },
        qr: { text: address.qr }
    };
}

/* The screen and its values for the page on top. */
function view(m) {
    const page = m.stack[m.stack.length - 1] || { name: 'main' };
    const tabSel = Math.max(0, TABS.indexOf(m.tab));
    let screen = page.name === 'main' ? m.tab : page.name;
    let values;
    switch (screen) {
    case 'store': values = storeView(m); break;
    case 'installed': values = installedView(m); break;
    case 'usb': values = usbView(m); break;
    case 'settings': values = settingsView(m); break;
    case 'app': values = appView(m, page.id); break;
    case 'confirm': values = confirmView(m, page); break;
    case 'source': values = sourceView(m, page.id); break;
    case 'accounts': values = accountsView(m); break;
    case 'login': values = loginView(m); break;
    case 'phone': values = phoneView(m); break;
    default: screen = 'store'; values = storeView(m);
    }
    values.nav = nav(m, tabSel);
    if (values.back === undefined) {
        values.back = { act: { do: 'back' } };
    }
    return { screen, values };
}

/* The picture files a view shows (components[].icon). */
function icons(v) {
    const out = [];
    const add = (x) => {
        if (x && /^key:/.test(x.icon || '')) {
            out.push(x.icon.slice(4));
        }
    };
    Object.keys(v.values).forEach((k) => {
        const o = v.values[k];
        add(o);
        (o && Array.isArray(o.items) ? o.items : []).forEach(add);
    });
    return out.filter((f, i) => out.indexOf(f) === i);
}

module.exports = { view, icons, TABS, FILTERS, canRestart };
