'use strict';
const { t: tr } = require('./i18n.js');
/**
 * What the renderer screens (src/am_screens.js) show, from mgu-updater's
 * state: view(model) -> { screen, values: { element: opts } } for the page on
 * top. No I/O, so tools/test_screens.js checks every page offline. Based on
 * IterioDev's App Manager 2 view (mgu-app-store apps/oap-appmanager/
 * javascript/store_ui.js), fed from the
 * updater's components, sources, accounts, sign-in and phone page.
 *
 * model: { st (the updater's state or null), connected, secret (whether the
 * updater secret is there), version (this Store's), stack (pages; the first
 * { name: 'main' }), tab (store, installed, usb, settings), filter (all,
 * app, tool), note (the Sources status line), login ({ waiting, refusal }),
 * webText (the web-url file), accountsNote ({ text, error }: the Accounts
 * status line), pick (the GitHub repo being added: { repo, probe (the
 * updater's answer, null while it looks), tokenNote (Add token's status
 * belongs on its page) }, or null), uplinkNote (the uplink's refusal of the
 * last Wi-Fi or preferred-connection request), held (the Installed lists'
 * rows to keep in this order: { apps, services } ids, and restart: whether
 * its Restart now shows; or null) }.
 *
 * What a press does rides on the values as `act`: on a button's opts, on
 * each nav, grid and list item, on each filter cell (acts). The acts:
 * { do: 'tab', tab }, { do: 'filter', filter }, { do: 'open', page },
 * { do: 'back' }, { do: 'check' }, { do: 'install', id }, { do: 'update-all' },
 * { do: 'remove', id, tools? }, { do: 'restart' },
 * { do: 'source-remove', id }, { do: 'account-remove', id }, { do: 'add-source' },
 * { do: 'add-token' }, { do: 'sign-in' }, { do: 'sign-in-cancel' }, { do: 'phone' },
 * { do: 'pick', channel }, { do: 'pick-retry' }, { do: 'pick-add-token' }, { do: 'key', key } (typeKey),
 * { do: 'wifi-power' }, { do: 'wifi-5ghz' }, { do: 'wifi-scan' }, { do: 'wifi-join', ssid }, { do: 'wifi-password', ssid },
 * { do: 'wifi-forget', ssid }, { do: 'uplink-prefer', kind }, { do: 'proxy-toggle' }, { do: 'proxy-edit' }.
 *
 * The type page ({ name: 'type', title, text, shift, sym, layout, symbols,
 * go, secret, max, min, label }) is text typed on the drawn keyboard: layout 'url'
 * (URLs and tokens, the default) or 'text' (words; with symbols its '#+='
 * page has every printable ASCII symbol), go the Enter key's text, secret
 * shows only the last 4 characters ('password': none), max the length (300), min the length
 * its Enter key takes, label the text box's caption.
 *
 * The Wi-Fi page (wifi) and the preferred connection (prefer) show the
 * uplink's state (state.uplink: mgu-uplink 0.7.0's status.json through the
 * updater) and are there only with its Wi-Fi.
 *
 * The proxy (state.proxy: { on, kind, address, error }, an updater from
 * 0.8.27) is a row in Settings and its page (proxy): on or off, and its
 * address; model.proxyNote is the refusal of the last change.
 */
const { PHASE, percent, rowAction, statusLine, sourceLabel, sourceState, sourceActions, sourceChannel, sourceAccount,
    tokenLabel, tokenState, tokenSources, accountsState, loginStatus, loginCode, phoneState, phoneAddress, hmiNames,
    notForUnit, removable, requiredAlone, undoable, pickOptions, probeStatus, sourceNames, listed, startPending } = require('./store_view.js');

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
const plural = (n, word) => tr(`{0} ${word}${n === 1 ? '' : 's'}`, n);
const isTool = (c) => c.kind !== 'app';
/* The version a row would install: a branch's new commit, else its version. */
const target = (c) => (c.revision && c.version === c.installed ? c.revision : c.version);

const rawComps = (m) => (m.connected && m.st && Array.isArray(m.st.components) ? m.st.components : []);
/* The components the Store lists (store_view.js listed). */
function comps(m) {
    return rawComps(m).filter(listed);
}
/* Its title, with its source's name where another listed row has the same title (two sources' DOOM). */
function named(m, c) {
    const name = sourceNames(comps(m), sources(m))(c);
    return name && comps(m).some((o) => o !== c && o.title === c.title) ? `${c.title} (${name})` : c.title;
}
/* A component's page: its row, else (its row's id changed with an install)
 * the row of the same source and listed id, else (its source turned to a
 * stick copying it, or back) the row of its id. */
const pageOf = (c) => ({ name: 'app', id: c.id, source: c.source, listed: c.listedId || c.id });
function rowOf(m, page) {
    // a stick that copies a source offers its rows in turn with it
    const usb = (id) => (sources(m) || []).some((s) => s.id === id && s.usb);
    // a component removed on its page stays there, though no longer listed
    const all = comps(m).concat(rawComps(m).filter((c) => !listed(c)));
    return all.find((c) => c.id === page.id && (!page.source || c.source === page.source)) ||
        all.find((c) => page.source && c.source === page.source && (c.listedId || c.id) === page.listed) ||
        all.find((c) => c.id === page.id && (usb(c.source) || usb(page.source))) || null;
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

/* Restart now on Store and Installed while a listed component waits for a
 * restart (an installed tool, or an iDrive 8 app change queued for the next
 * start) and the updater can restart the unit: it opens Restart head unit's
 * confirm step. It stays while an install runs, so the rows after it keep
 * their place (the focus is their index). keep: shown or not as drawn
 * (Installed's held rows). */
function restartNow(m, keep) {
    return m.connected && m.st && m.st.rebooting === false && (typeof keep === 'boolean' ? keep : comps(m).some((c) => c.pendingReboot))
        ? button(tr("Restart now"), { do: 'open', page: { name: 'confirm', kind: 'restart' } }, { vicon: 'refresh', style: 'primary', color: BLUE })
        : hidden;
}

/* Why the last restart failed or was refused, beside Restart head unit. */
function restartFailed(m) {
    const st = m.connected ? m.st : null;
    return st && st.rebootError && !st.busy ? tr("Restart failed: {0}", st.rebootError) : null;
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
        return { sub: p >= 0 ? tr("Downloading {0} %", p) : tr(PHASE[busy.phase] || 'Installing'), subColor: BLUE, badge: '',
            progress: p >= 0 ? p / 100 : 1 };
    }
    if (c.queued) {
        return { sub: tr("Waiting"), subColor: AMBER, badge: 'queued', progress: -1 };
    }
    if (notForUnit(c)) {
        return { sub: tr("Not for this head unit"), subColor: AMBER, badge: c.installed ? 'installed' : '', progress: -1 };
    }
    if (c.blocked) {
        return c.installed ? { sub: tr("Installed"), subColor: GREEN, badge: 'installed', progress: -1 }
            : { sub: tr("Not installable"), subColor: AMBER, badge: '', progress: -1 };
    }
    if (c.error) {
        return { sub: tr("Failed"), subColor: RED, badge: '', progress: -1 };
    }
    if (startPending(c)) {
        return { sub: tr("Restart pending"), subColor: AMBER, badge: c.installed ? 'installed' : '', progress: -1 };
    }
    if (c.status === 'update') {
        return { sub: tr("Update {0}", target(c)), subColor: BLUE, badge: 'update', progress: -1 };
    }
    if (c.installed && c.repair) {
        return { sub: tr("Not working"), subColor: AMBER, badge: 'installed', progress: -1 };
    }
    if (c.status === 'available') {
        return { sub: [c.version, size(c.size)].filter(Boolean).join(' · '), subColor: DIM, badge: '', progress: -1 };
    }
    if (c.pendingReboot) {
        return { sub: tr("Restart pending"), subColor: AMBER, badge: 'installed', progress: -1 };
    }
    return { sub: tr("Installed"), subColor: GREEN, badge: 'installed', progress: -1 };
}

/* Whether something runs or waits on the component, as tileState tells it:
 * its install or removal, a queued one, a failure, a restart pending or an
 * update. */
function pending(c, busy) {
    if ((busy && busy.id === c.id) || c.queued) {
        return true;
    }
    return !notForUnit(c) && !c.blocked && !!(c.error || startPending(c) || c.status === 'update' || c.pendingReboot);
}

/* A tile; name: its screen's sourceNames. */
function tile(m, c, busy, name) {
    return Object.assign(iconOf(c), { id: c.id, title: c.title, src: name(c), act: { do: 'open', page: pageOf(c) } }, tileState(c, busy));
}

function nav(m, sel) {
    const updates = comps(m).filter((c) => c.status === 'update' && !notForUnit(c) && !c.blocked && !startPending(c)).length;
    const usbIds = (sources(m) || []).filter((s) => s.usb).map((s) => s.id);
    const usbNew = comps(m).filter((c) => usbIds.indexOf(c.source) >= 0 && (c.status === 'available' || c.status === 'update') &&
        !notForUnit(c) && !c.blocked && !startPending(c)).length;
    return { sel, items: [[tr("Store"), 'grid', ''], [tr("Installed"), 'check', updates || ''], ['USB', 'usb', usbNew || ''], [tr("Settings"), 'gear', '']]
        .map(([label, vicon, badge], i) => ({ id: TABS[i], label, vicon, badge: String(badge), act: { do: 'tab', tab: TABS[i] } })) };
}

const hidden = { hidden: true };
const button = (text, act, extra) => Object.assign({ hidden: false, disabled: false, text, act, vicon: '' }, extra);

/* ---- the tabs ---- */

function storeView(m) {
    const busy = busyOf(m);
    const busyRow = busy && find(comps(m), busy.id);
    // the status line names a row as the tiles tell it apart
    const st = m.st && Object.assign({}, m.st, { components: m.st.components.map((c) => (listed(c) ? Object.assign({}, c, { title: named(m, c) }) : c)) });
    const list = comps(m).filter((c) => m.filter === 'all' || (m.filter === 'app' ? !isTool(c) : isTool(c)));
    const name = sourceNames(list, sources(m));
    const checking = !!(m.connected && m.st && m.st.catalog && m.st.catalog.checking);
    const online = m.connected && m.st && m.st.online;
    return {
        title: { text: tr("Store") },
        subtitle: busyRow ? { text: `${busy.phase === 'download' ? tr("Downloading {0} %", percent(busy)) : tr(PHASE[busy.phase] || 'Installing')} · ${named(m, busyRow)}`, color: BLUE }
            : { text: m.connected ? statusLine(st, true) : statusLine(null, false, m.secret), color: DIM },
        filter: { sel: Math.max(0, FILTERS.indexOf(m.filter)), acts: FILTERS.map((f) => ({ do: 'filter', filter: f })) },
        online: { items: !m.connected ? [] : checking ? [{ text: tr("Checking"), color: BLUE, dot: true }]
            : online ? [{ text: tr("Online"), color: GREEN, dot: true }] : [{ text: tr("Offline"), color: AMBER, dot: true }] },
        restartNow: restartNow(m),
        grid: { items: list.map((c) => tile(m, c, busy, name)), empty: m.connected ? tr("Nothing here") : '' }
    };
}

function installedView(m) {
    const busy = busyOf(m);
    // the ones something runs or waits on first, each part in the catalog's order; the rows held (m.held) where they were drawn
    const installed = comps(m).filter((c) => c.installed);
    const all = installed.filter((c) => pending(c, busy)).concat(installed.filter((c) => !pending(c, busy)));
    const keep = (list, ids) => (!ids ? list : list.filter((c) => ids.indexOf(c.id) >= 0).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
        .concat(list.filter((c) => ids.indexOf(c.id) < 0)));
    const apps = keep(all.filter((c) => !isTool(c)), m.held && m.held.apps);
    const tools = keep(all.filter(isTool), m.held && m.held.services);
    const updates = all.filter((c) => c.status === 'update' && rowAction(c, busy) === 'install');
    const name = sourceNames(all, sources(m));
    const item = (c) => {
        const s = tileState(c, busy);
        const up = c.status === 'update' && s.badge === 'update';
        const open = { do: 'open', page: pageOf(c) };
        return Object.assign(iconOf(c), { id: c.id, title: c.title, act: open,
            sub: [up ? `${c.installed} → ${target(c)}` : `${c.installed}${isTool(c) ? tr(' · tool') : ''}`, name(c)].filter(Boolean).join(' · '), subColor: up ? BLUE : DIM,
            right: up ? 'chip:' + tr('Update') : s.sub !== tr("Installed") ? `chip:${s.sub}` : 'chevron', chipColor: up ? BLUE : s.subColor,
            chipAct: up ? { do: 'install', id: c.id } : null });
    };
    return {
        title: { text: tr("Installed") },
        subtitle: { text: `${plural(apps.length, 'app')} · ${plural(tools.length, 'tool')}` },
        updateAll: updates.length ? button(tr("Update all ({0})", updates.length), { do: 'update-all' }, { vicon: 'arrowDown', style: 'primary', color: BLUE }) : hidden,
        apps: { items: apps.map(item), empty: tr("None") },
        restartNow: restartNow(m, m.held ? m.held.restart : undefined),
        services: { items: tools.map(item), empty: tr("None"), rowH: 120 }
    };
}

function usbView(m) {
    const busy = busyOf(m);
    const usb = (sources(m) || []).filter((s) => s.usb);
    const ids = usb.map((s) => s.id);
    const list = comps(m).filter((c) => ids.indexOf(c.source) >= 0);
    const name = sourceNames(list, sources(m));
    return {
        title: { text: 'USB' },
        subtitle: { text: usb.length ? `${usb.map(sourceLabel).join(', ')} · ${plural(list.length, 'package')}` : '' },
        grid: { items: list.map((c) => tile(m, c, busy, name)), empty: usb.length ? tr("Nothing here") : tr("No USB stick") }
    };
}

function sourceRow(s) {
    const status = sourceState(s);
    const bad = [tr("Sign in"), tr("Error"), tr("Offline")].indexOf(status) >= 0;
    const line = [sourceChannel(s), sourceAccount(s), typeof s.components === 'number' ? plural(s.components, 'component') : '']
        .filter(Boolean).join(' · ');
    return { id: s.id, title: sourceLabel(s), sub: bad || status === tr("Checking") ? status : line || status,
        subColor: bad ? AMBER : status === tr("Checking") ? BLUE : DIM, plain: true,
        vicon: bad ? 'warning' : s.usb ? 'usb' : s.auth ? 'lock' : 'unlock', iconColor: bad ? AMBER : GREEN,
        right: 'chevron', act: { do: 'open', page: { name: 'source', id: s.id } } };
}

function settingsView(m) {
    const st = m.st;
    const srcs = sources(m);
    const toks = tokens(m);
    const web = m.connected && st && st.web && typeof st.web === 'object' ? st.web : null;
    const access = [];
    const w = wifiOf(m);
    if (w) {
        const s = wifiState(w);
        const paused = pausedLine(w);
        const sub = paused || [s[0], bandOf(w)].filter(Boolean).join(' · ');
        access.push({ id: 'wifi', title: 'Wi-Fi', sub, subColor: paused ? DIM : s[1], plain: true, vicon: 'wifi', iconColor: s[1] === DIM ? 'text' : s[1],
            right: 'chevron', act: { do: 'open', page: { name: 'wifi' } } });
    }
    if (toks) {
        access.push({ id: 'accounts', title: tr("Accounts"), sub: accountsState(toks), plain: true, vicon: 'lock', iconColor: 'text',
            right: 'chevron', act: { do: 'open', page: { name: 'accounts' } } });
    }
    const px = proxyOf(m);
    if (px) {
        access.push({ id: 'proxy', title: tr("Proxy"), sub: !px.on ? tr("Off") : px.error ? tr("Error") : px.address,
            subColor: px.error ? AMBER : DIM, plain: true, vicon: 'route', iconColor: px.error ? AMBER : 'text',
            right: 'chevron', act: { do: 'open', page: { name: 'proxy' } } });
    }
    if (web) {
        access.push({ id: 'phone', title: tr("Phone access"), sub: phoneState(web), plain: true, vicon: 'phone', iconColor: 'text',
            right: 'chevron', act: { do: 'open', page: { name: 'phone' } } });
    }
    const unit = st && st.unit;
    const renderers = st && st.allProviders && Array.isArray(st.allProviders.renderer) ? st.allProviders.renderer : [];
    return {
        note: { text: m.note || (restartFailed(m) || '') },
        repos: srcs ? { items: srcs.map(sourceRow), empty: tr("None") } : { items: [], empty: '' },
        addRepo: srcs ? button(tr("Add source"), { do: 'add-source' }, { vicon: 'plus', style: 'tinted', color: BLUE }) : hidden,
        access: { items: access },
        connLabel: { text: access.length ? tr("ACCESS") : tr("HEAD UNIT") },
        unit: { text: unit && unit.hmi ? [hmiNames([unit.hmi]), unit.firmware].filter(Boolean).join(' · ') : '' },
        versions: { text: [st && st.updater ? tr("Updater {0}", st.updater.version) : '', m.version ? tr("Store {0}", m.version) : '',
            renderers.length ? tr("Renderer {0}", renderers.map((r) => `${r.id} ${r.version}`).join(', ')) : ''].filter(Boolean).join(' · ') },
        checkNow: m.connected ? button(st.catalog && st.catalog.checking ? tr("Checking") : tr("Check now"), { do: 'check' },
            { vicon: 'refresh', style: 'outline', size: 26 }) : hidden,
        restart: canRestart(m) ? button(tr("Restart head unit"), { do: 'open', page: { name: 'confirm', kind: 'restart' } },
            { vicon: 'refresh', style: 'outline', size: 26 }) : hidden
    };
}

/* ---- pages ---- */

function appView(m, page) {
    const c = rowOf(m, page);
    if (!c) {
        return { name: { text: tr("Not listed") }, author: { text: '' }, facts: { items: [] }, desc: { text: '' }, icon: { letter: '?' },
            instValue: { text: '' }, availLabel: { text: '' }, availValue: { text: '' }, problem: { text: '' }, note1: { text: '' }, note2: { text: '' },
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
        author: { text: [c.author && tr("by {0}", c.author), c.source && tr("from {0}", src ? sourceLabel(src) : c.source)].filter(Boolean).join(' · ') },
        facts: { items: [{ text: tr("Version {0}", c.version) }, c.revision && { text: tr("Commit {0}", c.revision) }, c.size && { text: size(c.size) },
            // installed under another id than its source's
            c.listedId && !c.blocked && (c.installAs || c.id) !== c.listedId && { text: `Id ${c.installAs || c.id}` },
            { text: isTool(c) ? tr("Tool") : tr("App"), color: isTool(c) ? TEAL : BLUE }, c.mguHmi && c.mguHmi.length && { text: hmiNames(c.mguHmi) },
            c.provides && { text: c.provides }].filter(Boolean) },
        // a failure in full, above the description
        desc: { text: c.description || '', lead: c.error && !mine ? tr("Failed: {0}", c.error) : '', leadColor: RED },
        // what an installed tool says is wrong (the updater's problem: mgu-render's page template)
        problem: { text: c.problem || '' },
        instLabel: { text: tr("Installed") },
        instValue: { text: c.installed || '–' },
        availLabel: { text: avail ? tr("Available") : '' },
        availValue: { text: avail ? target(c) : '', color: notForUnit(c) ? AMBER : c.status === 'update' ? BLUE : 'text' }
    };
    const notes = [];
    if (notForUnit(c)) {
        notes.push([tr("Not for this head unit"), AMBER]);
        if (c.mguHmi && c.mguHmi.length) {
            notes.push([tr("For {0}", hmiNames(c.mguHmi)), AMBER]);
        }
    }
    if (c.blocked) {
        notes.push([c.blocked, AMBER]);
    }
    if (c.pendingReboot) {
        notes.push([tr("Restart pending"), AMBER]);
        const failed = restartFailed(m);
        if (failed) {
            notes.push([failed, AMBER]);
        }
    }
    ['note1', 'note2', 'note3'].forEach((k, i) => {
        v[k] = notes[i] ? { text: String(notes[i][0]).slice(0, 80), color: notes[i][1] } : { text: '' };
    });
    v.progress = mine ? { hidden: false, label: tr(PHASE[busy.phase] || 'Installing'), value: busy.phase === 'download' ? percent(busy) : 100,
        right: busy.phase === 'download' ? `${percent(busy)} %` : '',
        sub: busy.phase === 'download' && busy.total ? tr("{0} of {1}", size(busy.progress), size(busy.total)) : '' }
        : c.queued ? { hidden: false, label: tr("Waiting"), value: 0, right: '', sub: '' } : hidden;
    const action = rowAction(c, busy);
    const retryRemove = action === 'remove' && !!c.error;
    if (retryRemove) {
        v.primary = button(tr("Try again"), { do: 'open', page: { name: 'confirm', kind: 'remove', id: c.id } },
            { vicon: 'refresh', style: 'primary', color: BLUE });
    } else if (action === 'install') {
        v.primary = button(c.error ? tr("Try again") : c.status === 'update' ? tr("Update to {0}", target(c)) : tr("Install"), { do: 'install', id: c.id },
            { vicon: c.error ? 'refresh' : 'arrowDown', style: 'primary', color: BLUE });
    } else if (c.pendingReboot && canRestart(m)) {
        v.primary = button(tr("Restart head unit"), { do: 'open', page: { name: 'confirm', kind: 'restart' } },
            { vicon: 'refresh', style: 'primary', color: BLUE });
    } else if (undoable(c, busy)) {
        v.primary = button(tr("Undo update"), { do: 'open', page: { name: 'confirm', kind: 'undo', id: c.id } },
            { vicon: 'back', style: 'outline' });
    } else {
        v.primary = hidden;
    }
    v.secondary = removable(c, busy) && !retryRemove ? button(tr("Remove"), { do: 'open', page: { name: 'confirm', kind: 'remove', id: c.id } },
        { vicon: 'trash', style: 'outline' }) : hidden;
    return v;
}

function confirmView(m, page) {
    const all = comps(m);
    const c = find(all, page.id);
    const icon = c ? iconOf(c) : { vicon: { restart: 'refresh', 'account-remove': 'lock', 'wifi-forget': 'wifi' }[page.kind] || 'warning',
        kind: 'service', colors: '#3a4352,#232a35' };
    let title = '';
    let line = '';
    let now = null;
    let also = hidden;
    if (page.kind === 'remove') {
        title = c ? tr("Remove {0} {1}?", named(m, c), c.installed || '').replace(' ?', '?') : tr("Remove?");
        now = button(tr("Remove"), { do: 'remove', id: page.id }, { vicon: 'trash', style: 'primary', color: RED });
        const tools = c ? requiredAlone(all, c) : [];
        if (tools.length) {
            line = tr("Tools only it uses: {0}", tools.map((t) => `${named(m, t)} ${t.installed}`).join(', '));
            also = button(tr("Remove all"), { do: 'remove', id: page.id, tools: tools.map((t) => t.id) }, { vicon: 'trash', style: 'outline' });
        }
    } else if (page.kind === 'undo') {
        title = c ? tr("Back to {0} {1}?", named(m, c), c.previous || '').replace(' ?', '?') : tr("Undo update");
        now = button(tr("Undo update"), { do: 'undo', id: page.id }, { vicon: 'back', style: 'primary', color: BLUE });
    } else if (page.kind === 'restart') {
        title = tr("Restart head unit?");
        // as Restart head unit, while the updater takes a restart
        now = button(tr("Restart"), { do: 'restart' }, { vicon: 'refresh', style: 'primary', color: BLUE, disabled: !canRestart(m) });
    } else if (page.kind === 'source-remove') {
        const s = find(sources(m), page.id);
        title = tr("Remove source?");
        line = s ? sourceLabel(s) : page.id;
        now = button(tr("Remove"), { do: 'source-remove', id: page.id }, { vicon: 'trash', style: 'primary', color: RED });
    } else if (page.kind === 'account-remove') {
        const t = find(tokens(m), page.id);
        title = tr("Remove account?");
        line = t ? [tokenLabel(t), tokenSources(t, sources(m))].filter(Boolean).join(' · ') : page.id;
        now = button(tr("Remove"), { do: 'account-remove', id: page.id }, { vicon: 'trash', style: 'primary', color: RED });
    } else if (page.kind === 'wifi-forget') {
        title = tr("Forget network?");
        line = page.ssid;
        now = button(tr("Forget"), { do: 'wifi-forget', ssid: page.ssid }, { vicon: 'trash', style: 'primary', color: RED });
    }
    return { icon, title: { text: title }, text: { text: line }, now, also, later: button(tr("Cancel"), { do: 'back' }, { vicon: 'back', style: 'outline' }),
        note: { text: '' } };
}

function sourceView(m, id) {
    const s = find(sources(m), id);
    if (!s) {
        return { name: { text: tr("Not listed") }, state: { text: '' }, facts: { items: [] }, desc: { text: '' }, appLabel: { text: '' },
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
        appLabel: { text: installUrl ? tr("Install on GitHub") : '' },
        appQr: { text: installUrl },
        appUrl: { text: installUrl },
        remove: sourceActions(s).remove ? button(tr("Remove"), { do: 'open', page: { name: 'confirm', kind: 'source-remove', id: s.id } },
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
            act: { do: 'open', page: { name: 'confirm', kind: 'account-remove', id: t.id } } })), empty: tr("None") },
        // Sign in with GitHub only with the updater's GitHub App (state.signin)
        signIn: m.st && m.st.signin === true ? button(tr("Sign in with GitHub"), { do: 'sign-in' }, { vicon: 'plus', style: 'primary', color: BLUE }) : hidden,
        addToken: m.connected && m.st ? button(tr("Add token"), { do: 'add-token' }, { vicon: 'plus', style: 'outline' }) : hidden
    };
}

/* A GitHub repo being added: what it can be added on; while no token
 * reaches it, Sign in with GitHub and Add token (whose status shows here). */
function pickView(m) {
    const pick = m.pick || { repo: '', probe: null };
    const probe = pick.probe;
    const auth = !!probe && probe.status === 'auth-needed';
    const note = m.accountsNote || { text: '', error: false };
    const status = auth && pick.tokenNote && note.text ? note.text : probeStatus(probe);
    const failed = !!probe && probe.status !== 'ok' && !auth;
    return {
        title: { text: (probe && probe.name) || pick.repo },
        status: { text: status, color: !probe ? BLUE : probe.status === 'ok' && !status ? DIM : AMBER },
        list: { items: pickOptions(probe).map((o) => ({ id: o.channel, title: o.label, sub: o.sub, plain: true,
            vicon: o.channel === 'releases' ? 'arrowDown' : o.channel === 'tags' ? 'clock' : 'route', iconColor: 'text',
            right: 'chevron', act: { do: 'pick', channel: o.channel } })), empty: '' },
        signIn: auth && m.st && m.st.signin === true ? button(tr("Sign in with GitHub"), { do: 'sign-in' }, { vicon: 'plus', style: 'primary', color: BLUE }) : hidden,
        addToken: auth && m.connected ? button(tr("Add token"), { do: 'pick-add-token' }, { vicon: 'plus', style: 'outline' }) : hidden,
        retry: failed ? button(tr("Try again"), { do: 'pick-retry' }, { vicon: 'refresh', style: 'outline' }) : hidden
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
        status: { text: status, color: (m.login && m.login.refusal) || (login && login.status !== 'pending' && login.status !== 'done') ? AMBER : DIM },
        cancel: button(tr("Cancel"), { do: 'sign-in-cancel' }, { style: 'outline' })
    };
}

const masked = (t, kind) => (kind === 'password' ? '·'.repeat(Math.min(24, t.length))
    : t.length <= 4 ? t : '·'.repeat(Math.min(24, t.length - 4)) + t.slice(-4));

function typeView(m, page) {
    const text = page.text || '';
    const short = page.min && text.length < page.min ? tr(" · at least {0} characters", page.min) : '';
    return {
        title: { text: page.title || '' },
        field: { text: page.secret ? masked(text, page.secret) : text, label: page.label ? page.label + short : '' },
        keyboard: { layout: page.layout || 'url', shift: !!page.shift, symbols: !!page.symbols, sym: !!page.sym, go: page.go || 'OK' }
    };
}

/* A key pressed on the type page: its text, Shift and the symbols page
 * follow it; true for the Enter key once the text has min characters. */
function typeKey(page, key) {
    if (key === (page.go || 'OK')) {
        return (page.text || '').length >= (page.min || 0);
    }
    if (key === 'Shift') {
        page.shift = !page.shift;
    } else if (key === '#+=' || key === 'abc') {
        page.sym = key === '#+=';
    } else if (key === 'Delete') {
        page.text = (page.text || '').slice(0, -1);
    } else {
        // a key that would go past max types nothing (the URL keys type several characters)
        const text = page.text || '', add = key === 'Space' ? ' ' : key;
        if (text.length + add.length <= (page.max || 300)) {
            page.text = text + add;
        }
    }
    return false;
}

function phoneView(m) {
    const web = m.connected && m.st && m.st.web && typeof m.st.web === 'object' ? m.st.web : null;
    const address = web ? phoneAddress(web, m.webText) : { qr: '', text: '' };
    return {
        toggleRow: { items: web ? [{ id: 'phone', title: tr("Phone access"), sub: phoneState(web), plain: true, vicon: 'phone', iconColor: 'text',
            right: `toggle:${web.enabled ? 'on' : 'off'}`, act: { do: 'phone' } }] : [] },
        url: { text: address.text },
        error: { text: web && web.error ? String(web.error) : '' },
        qr: { text: address.qr }
    };
}

/* The updater's proxy setting, null with an updater before 0.8.27. */
function proxyOf(m) {
    const p = m.connected && m.st && m.st.proxy;
    return p && typeof p === 'object' ? p : null;
}

function proxyView(m) {
    const p = proxyOf(m) || { on: false };
    return {
        rows: { items: [
            { id: 'proxy', title: tr("Proxy"), sub: '', plain: true, vicon: 'route', iconColor: 'text',
                right: `toggle:${p.on ? 'on' : 'off'}`, act: { do: 'proxy-toggle' } },
            { id: 'address', title: tr("Address"), sub: p.on && p.address ? `${p.kind}://${p.address}` : tr("None"), plain: true,
                vicon: 'wrench', iconColor: 'text', right: 'chevron', act: { do: 'proxy-edit' } }], empty: '' },
        error: { text: String(m.proxyNote || p.error || '').slice(0, 200) }
    };
}

/* ---- the uplink: Wi-Fi and the preferred connection (state.uplink, mgu-uplink 0.7.0's status.json) ---- */

/* The uplink's Wi-Fi (status.json's wifi), null without it (an uplink before
 * 0.7.0, or not on auto): the Wi-Fi row, its pages and the preferred
 * connection show only with it. */
function wifiOf(m) {
    const u = m.connected && m.st && m.st.uplink;
    return u && u.wifi && typeof u.wifi === 'object' ? u.wifi : null;
}
/* Its state line: [text, colour]. */
function wifiState(w) {
    const at = w.ssid ? ` · ${w.ssid}` : '';
    if (w.link === 'unavailable') {
        return [tr("Unavailable"), DIM];
    }
    if (w.link === 'failed') {
        return [tr("Failed"), AMBER];
    }
    if (w.error && ['online', 'connected', 'connecting'].indexOf(w.link) < 0) {
        return [tr("Error"), AMBER];
    }
    return { online: [tr("Online{0}", at), GREEN], connected: [tr("Connected{0}", at), BLUE], connecting: [tr("Connecting{0}", at), BLUE],
        off: [tr("Not used"), DIM] }[w.link] || [tr("Not connected"), DIM];
}
const PROJECTION = { carplay: 'CarPlay', 'android-auto': 'Android Auto' };
/* While wireless CarPlay or Android Auto keeps the uplink from searching for
 * its networks by itself (mgu-uplink 0.7.5's wifi.paused) and Wi-Fi is not
 * joined: that line; '' otherwise. */
function pausedLine(w) {
    const name = w.enabled && PROJECTION[w.paused];
    return name && ['online', 'connected', 'connecting'].indexOf(w.link) < 0 ? tr("Paused for wireless {0}", name) : '';
}
/* The band of the access point joined (mgu-uplink 0.7.5's wifi.freq, MHz)
 * while Wi-Fi is joined; '' without it. */
function bandOf(w) {
    const f = w.freq;
    if (['online', 'connected'].indexOf(w.link) < 0 || typeof f !== 'number') {
        return '';
    }
    return f >= 2400 && f < 2500 ? tr("2.4 GHz") : f >= 4900 && f < 5900 ? tr("5 GHz") : '';
}
/* Joined on 5 GHz to a network not seen on 2.4 GHz, with Allow 5 GHz off
 * (mgu-uplink 0.7.6's wifi.fiveOnly): what to do about it; '' otherwise. */
function bandNote(w) {
    if (!w.fiveOnly || ['online', 'connected'].indexOf(w.link) < 0) {
        return '';
    }
    return /iphone/i.test(w.ssid || '') ? tr("On the iPhone, turn on Maximize Compatibility") : tr("This network is 5 GHz only: CarPlay audio may drop");
}
const strength = (dbm) => (typeof dbm !== 'number' ? null : dbm >= -60 ? [tr("Strong"), GREEN] : dbm >= -72 ? [tr("Good"), BLUE] : [tr("Weak"), AMBER]);
const scanningOf = (w) => !!(w.scanning || w.link === 'scanning');

/* The networks while Wi-Fi is on: the one joined first, then the latest
 * scan's (strongest first), then saved ones out of range. */
function wifiNets(w) {
    if (!w.enabled) {
        return [];
    }
    const scan = (Array.isArray(w.networks) ? w.networks : []).filter((n) => n && n.ssid);
    const away = (Array.isArray(w.saved) ? w.saved : []).filter((s) => !scan.some((n) => n.ssid === s)).map((ssid) => ({ ssid, saved: true, away: true }));
    return scan.filter((n) => n.current).concat(scan.filter((n) => !n.current), away);
}

/* A network's row: a tap joins a saved or open one, or asks a secured one's
 * password; a saved one has Forget. */
function netRow(w, n) {
    const q = strength(n.signal);
    const joined = n.current && (w.link === 'connected' || w.link === 'online');
    const status = n.away ? tr("Saved · not in range") : n.current ? { online: tr("Online"), connected: tr("Connected"), connecting: tr("Connecting") }[w.link] || tr("Saved")
        : n.saved ? tr("Saved") : n.secure ? tr("Secured") : tr("Open");
    const act = n.away || joined ? null : n.saved || !n.secure ? { do: 'wifi-join', ssid: n.ssid } : { do: 'wifi-password', ssid: n.ssid };
    return { id: n.ssid, title: n.ssid, sub: [status, q && q[0], joined && bandOf(w)].filter(Boolean).join(' · '), subColor: n.current ? GREEN : DIM, plain: true,
        vicon: n.secure && !n.saved ? 'lock' : 'wifi', iconColor: q ? q[1] : DIM, act,
        right: n.saved ? 'chip:' + tr('Forget') : act ? 'chevron' : '', chipColor: DIM,
        chipAct: n.saved ? { do: 'open', page: { name: 'confirm', kind: 'wifi-forget', ssid: n.ssid } } : null };
}

/* The preferred connection's choices (mgu-uplink's groups, in its order) and the device kinds each covers. */
const GROUPS = [['', 'Automatic', []], ['wifi', 'Wi-Fi', ['wifi']], ['usb', 'USB', ['usb', 'usbecm']], ['phone', 'Phone', ['rndis', 'ncm', 'iphone']]];
const groupLabel = (g) => tr((GROUPS.find((x) => x[0] === g) || [g, g])[1]);
const groupOf = (kind) => (GROUPS.find((x) => x[2].indexOf(kind) >= 0) || [kind])[0];
// the Wi-Fi page's picture in its state's colour, grey otherwise
const LIT = { [GREEN]: '#5be38e,#1f9a52', [BLUE]: '#5fb4ff,#1f5fd0', [AMBER]: '#ffc04d,#c98a12' };

function wifiView(m) {
    // without the uplink's state (it restarts) the page waits, its controls off
    const waiting = !wifiOf(m);
    const w = wifiOf(m) || { enabled: false, link: 'off' };
    const s = waiting ? [tr("Waiting"), DIM] : wifiState(w);
    const nets = wifiNets(w);
    const scanning = scanningOf(w);
    const dbm = typeof w.signal === 'number' ? `${w.signal} dBm` : '';
    const preferred = (m.st && m.st.uplink && m.st.uplink.preferred) || '';
    return {
        subtitle: { text: !w.enabled || w.link === 'unavailable' || w.link === 'failed' ? '' : scanning ? tr("Scanning")
            : pausedLine(w) || plural(nets.length, 'network') },
        networks: { items: nets.map((n) => netRow(w, n)),
            empty: waiting ? tr("Waiting") : !w.enabled ? tr("Not used") : w.link === 'unavailable' ? tr("Unavailable") : scanning ? tr("Scanning") : tr("No networks") },
        icon: { vicon: 'wifi', kind: 'service', colors: LIT[s[1]] || '#7a808a,#3a3f47' },
        state: { text: s[0], color: s[1] },
        info: { text: [w.ip && `IP ${w.ip}`, dbm].filter(Boolean).join(' · ') },
        note: { text: String(m.uplinkNote || w.error || bandNote(w)).slice(0, 160) },
        // Allow 5 GHz, with an uplink that has it (mgu-uplink 0.7.6's wifi.allow5ghz)
        allow5: { items: !waiting && w.enabled && typeof w.allow5ghz === 'boolean' ? [{ id: 'allow5', title: tr("Allow 5 GHz"), sub: tr("May cause CarPlay issues"), subColor: DIM, plain: true,
            vicon: 'wifi', iconColor: 'text', right: `toggle:${w.allow5ghz ? 'on' : 'off'}`, act: { do: 'wifi-5ghz' } }] : [] },
        power: w.enabled ? button(tr("Don't use Wi-Fi"), { do: 'wifi-power' }, { vicon: 'wifi', style: 'outline' })
            : button(tr("Use Wi-Fi"), { do: 'wifi-power' }, { vicon: 'wifi', style: 'primary', color: GREEN, disabled: waiting }),
        scan: button(scanning ? tr("Scanning") : tr("Scan"), { do: 'wifi-scan' }, { vicon: 'refresh', style: 'outline',
            disabled: !w.enabled || scanning || w.link === 'unavailable' || w.link === 'failed' }),
        prefer: button(tr("Preferred: {0}", groupLabel(preferred)), { do: 'open', page: { name: 'prefer' } }, { vicon: 'route', style: 'outline',
            disabled: waiting })
    };
}

/* The connection the uplink tries first; the others follow as fallbacks. */
function preferView(m) {
    const u = (m.connected && m.st && m.st.uplink) || {};
    const preferred = u.preferred || '';
    const using = u.device && groupOf(u.device.kind);
    return {
        status: { text: m.uplinkNote || (using ? tr("{0} through {1}", u.state === 'online' ? tr("Online") : tr("Connecting"), groupLabel(using)) : tr("Offline")),
            color: m.uplinkNote ? AMBER : DIM },
        list: { items: GROUPS.map(([group, label]) => ({ id: group || 'auto', title: tr(label), sub: group && group === using ? tr("In use") : '', plain: true,
            vicon: { '': 'route', usb: 'usb', wifi: 'wifi' }[group] || 'phone', iconColor: 'text',
            right: group === preferred ? 'chip:' + tr('Preferred') : '', chipColor: GREEN,
            act: group === preferred ? null : { do: 'uplink-prefer', kind: group } })), empty: '' }
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
    case 'app': values = appView(m, page); break;
    case 'confirm': values = confirmView(m, page); break;
    case 'source': values = sourceView(m, page.id); break;
    case 'accounts': values = accountsView(m); break;
    case 'pick': values = pickView(m); break;
    case 'login': values = loginView(m); break;
    case 'phone': values = phoneView(m); break;
    case 'type': values = typeView(m, page); break;
    case 'wifi': values = wifiView(m); break;
    case 'prefer': values = preferView(m); break;
    case 'proxy': values = proxyView(m); break;
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

module.exports = { view, icons, typeKey, wifiOf, proxyOf, TABS, FILTERS, canRestart };
