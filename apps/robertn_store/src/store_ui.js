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
 * rows to keep in this order: { apps, services } ids, or null) }.
 *
 * What a press does rides on the values as `act`: on a button's opts, on
 * each nav, grid and list item, on each filter cell (acts). The acts:
 * { do: 'tab', tab }, { do: 'filter', filter }, { do: 'open', page },
 * { do: 'back' }, { do: 'check' }, { do: 'install', id }, { do: 'update-all' },
 * { do: 'remove', id }, { do: 'restart' },
 * { do: 'source-remove', id }, { do: 'account-remove', id }, { do: 'add-source' },
 * { do: 'add-token' }, { do: 'sign-in' }, { do: 'sign-in-cancel' }, { do: 'phone' },
 * { do: 'pick', channel }, { do: 'pick-retry' }, { do: 'pick-add-token' }, { do: 'key', key } (typeKey),
 * { do: 'wifi-power' }, { do: 'wifi-scan' }, { do: 'wifi-join', ssid }, { do: 'wifi-password', ssid },
 * { do: 'wifi-forget', ssid }, { do: 'uplink-prefer', kind }.
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
 */
const { PHASE, percent, rowAction, statusLine, sourceLabel, sourceState, sourceActions, sourceChannel, sourceAccount,
    tokenLabel, tokenState, tokenSources, accountsState, loginStatus, loginCode, phoneState, phoneAddress, hmiNames,
    notForUnit, removable, undoable, pickOptions, probeStatus, sourceNames, listed, startPending } = require('./store_view.js');

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
const target = (c) => c.version;

const rawComps = (m) => (m.connected && m.st && Array.isArray(m.st.components) ? m.st.components : []);
/* The components the Store lists (store_view.js listed). */
function comps(m) {
    return rawComps(m).filter(listed);
}
const srcName = (m, c) => (c.source && sourceNames(sources(m))[c.source]) || '';
/* Its title, with its source's short name where another listed row has the same title (two sources' DOOM). */
const named = (m, c) => (srcName(m, c) && comps(m).some((o) => o !== c && o.title === c.title) ? `${c.title} (${srcName(m, c)})` : c.title);
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

/* Why the last restart failed or was refused, beside Restart head unit. */
function restartFailed(m) {
    const st = m.connected ? m.st : null;
    return st && st.rebootError && !st.busy ? tr("Restart failed: {0}", st.rebootError) : null;
}

/* The icon fields of a component: its picture (components[].icon, a file
 * the Store reads), else a letter tile; tools round. */
/* The head-unit tools' logos (kit_vicons.js), where a tool brings no picture of its own. */
const TOOL_ICONS = { 'mgu-render': 'layers', 'idrive7-renderd': 'layers', 'mgu-renderd': 'layers', 'mgu-updater': 'refresh',
    'mgu-deploy': 'box', 'mgu-python': 'python', 'mgu-uplink': 'tether', 'app-privacy': 'shield', 'mgu-inputgate': 'knob',
    'carplay-multitouch': 'touch', 'display-bridge': 'display' };
function iconOf(c) {
    return { icon: c.icon ? `key:${c.icon}` : '', vicon: c.icon ? '' : TOOL_ICONS[c.id] || '', letter: String(c.title || c.id || '?')[0], kind: isTool(c) ? 'service' : 'app',
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

function tile(m, c, busy) {
    return Object.assign(iconOf(c), { id: c.id, title: c.title, src: srcName(m, c), act: { do: 'open', page: pageOf(c) } }, tileState(c, busy));
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
    const shown = comps(m).filter((c) => m.filter === 'all' || (m.filter === 'app' ? !isTool(c) : isTool(c)));
    // what is not on the car yet first, each group in its usual order
    const list = shown.filter((c) => !c.installed).concat(shown.filter((c) => c.installed));
    const checking = !!(m.connected && m.st && m.st.catalog && m.st.catalog.checking);
    const online = m.connected && m.st && m.st.online;
    return {
        title: { text: tr("Store") },
        subtitle: busyRow ? { text: `${busy.phase === 'download' ? tr("Downloading {0} %", percent(busy)) : tr(PHASE[busy.phase] || 'Installing')} · ${named(m, busyRow)}`, color: BLUE }
            : m.connected && !checking && !online ? { text: tr("No internet: Settings > Internet shows how to connect the car"), color: AMBER }
                : { text: m.connected ? statusLine(st, true) : statusLine(null, false, m.secret), color: DIM },
        filter: { sel: Math.max(0, FILTERS.indexOf(m.filter)), acts: FILTERS.map((f) => ({ do: 'filter', filter: f })) },
        online: { items: !m.connected ? [] : checking ? [{ text: tr("Checking"), color: BLUE, dot: true }]
            : online ? [{ text: tr("Online"), color: GREEN, dot: true }] : [{ text: tr("Offline"), color: AMBER, dot: true }] },
        grid: { items: list.map((c) => tile(m, c, busy)), empty: m.connected ? tr("Nothing here") : '' }
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
    const item = (c) => {
        const s = tileState(c, busy);
        const up = c.status === 'update' && s.badge === 'update';
        const open = { do: 'open', page: pageOf(c) };
        return Object.assign(iconOf(c), { id: c.id, title: c.title, act: open,
            sub: [up ? (c.installed === c.version ? `${c.installed} · ${tr('new build')}` : `${c.installed} → ${target(c)}`) : `${c.installed}${isTool(c) ? tr(' · tool') : ''}`, srcName(m, c)].filter(Boolean).join(' · '), subColor: up ? BLUE : DIM,
            // the Update chip only says so: the row opens the page, whose button updates (Update all for all)
            right: up ? 'chip:' + tr('Update') : s.sub !== tr("Installed") ? `chip:${s.sub}` : 'chevron', chipColor: up ? BLUE : s.subColor,
            chipAct: null });
    };
    return {
        title: { text: tr("Installed") },
        subtitle: { text: `${plural(apps.length, 'app')} · ${plural(tools.length, 'tool')}` },
        // updates: install them all; none: look for new ones (the updater's check, as Settings' Check now)
        updateAll: updates.length ? button(tr("Install all updates ({0})", updates.length), { do: 'update-all' }, { vicon: 'arrowDown', style: 'primary', color: BLUE })
            : m.connected && m.st ? button(m.noNet ? tr("No internet") : m.st.catalog && m.st.catalog.checking ? tr("Checking") : tr("Check for updates"), { do: 'check' },
                { vicon: m.noNet ? 'warning' : 'refresh', style: 'outline', color: m.noNet ? AMBER : undefined })
                : hidden,
        apps: { items: apps.map(item), empty: tr("None") },
        services: { items: tools.map(item), empty: tr("None"), rowH: 120 }
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
        grid: { items: list.map((c) => tile(m, c, busy)), empty: usb.length ? tr("Nothing here") : tr("USB not connected") }
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
        access.push({ id: 'wifi', title: 'Wi-Fi', sub: s[0], subColor: s[1], plain: true, vicon: 'wifi', iconColor: s[1] === DIM ? 'text' : s[1],
            right: 'chevron', act: { do: 'open', page: { name: 'wifi' } } });
    }
    if (m.connected && st) {
        access.push({ id: 'internet', title: 'Internet', sub: st.online ? 'Online' : 'Offline', subColor: st.online ? GREEN : AMBER,
            plain: true, vicon: 'tether', iconColor: 'text', right: 'chevron', act: { do: 'open', page: { name: 'internet' } } });
    }
    if (toks) {
        access.push({ id: 'accounts', title: tr("Accounts"), sub: accountsState(toks), plain: true, vicon: 'lock', iconColor: 'text',
            right: 'chevron', act: { do: 'open', page: { name: 'accounts' } } });
    }
    if (web) {
        access.push({ id: 'phone', title: tr("Phone access"), sub: phoneState(web), plain: true, vicon: 'phone', iconColor: 'text',
            right: 'chevron', act: { do: 'open', page: { name: 'phone' } } });
    }
    const unit = st && st.unit;
    access.push({ id: 'info', title: 'Information', sub: unit && unit.hmi ? [hmiNames([unit.hmi]), unit.firmware].filter(Boolean).join(' · ') : 'Versions',
        plain: true, vicon: 'display', iconColor: 'text', right: 'chevron', act: { do: 'open', page: { name: 'information' } } });
    return {
        note: { text: m.note || (restartFailed(m) || '') },
        look: { sel: LOOKS.indexOf(lookOf(m)), acts: LOOKS.map((l) => ({ do: 'look', look: l })) },
        repos: srcs ? { items: srcs.map(sourceRow), empty: tr("None") } : { items: [], empty: '' },
        addRepo: srcs ? button(tr("Add source"), { do: 'add-source' }, { vicon: 'plus', style: 'tinted', color: BLUE }) : hidden,
        access: { items: access },
        connLabel: { text: tr("ACCESS") },
        checkNow: m.connected ? button(st.catalog && st.catalog.checking ? tr("Checking") : tr("Check now"), { do: 'check' },
            { vicon: 'refresh', style: 'outline', size: 26 }) : hidden,
        restart: canRestart(m) ? button(tr("Restart head unit"), { do: 'open', page: { name: 'confirm', kind: 'restart' } },
            { vicon: 'refresh', style: 'outline', size: 26 }) : hidden
    };
}

/* ---- pages ---- */

/* The update history on a component's page (the updater's history answer,
 * newest first): a commit's message with its date, or a
 * version with its notes; what is newer than the installed one marked New. */
function historyView(m, c) {
    const h = m.history && m.history.id === c.id ? m.history : null;
    const empty = !h || h.status === 'loading' ? 'Loading history' : h.status === 'offline' ? 'History needs internet'
        : h.status === 'error' ? 'History not available' : 'No history';
    return { empty, items: (h ? h.items : []).map((it, i) => ({ id: `h${i}`, plain: true,
        title: it.rev ? it.title : `Version ${it.title}`,
        sub: it.rev ? it.date : it.text || '',
        subColor: DIM, right: it.new ? 'chip:New' : '', chipColor: BLUE })) };
}

/* Text cut into lines of at most n characters (at spaces; longer words split). */
function lines(text, n) {
    const out = [];
    String(text || '').split('\n').forEach((para) => {
        const p = para.replace(/\s+$/, '');
        if (!p.trim()) return;
        const bullet = /^\s*[-*] /.test(p), words = p.replace(/^\s*[-*] /, '').split(/\s+/).filter(Boolean);
        let line = bullet ? '- ' : '';           // ('•' is not in the baked fonts)
        const lead = bullet ? '  ' : '';
        words.forEach((w) => {
            while (w.length > n) { if (line.trim()) { out.push(line); line = lead; } out.push(lead + w.slice(0, n)); w = w.slice(n); }
            if ((line + w).length > n && line.trim()) { out.push(line); line = lead; }
            line += (line.trim() ? ' ' : '') + w;
        });
        if (line.trim()) out.push(line);
    });
    return out;
}

/* The changelog page: the component's update history, newest first, each entry in
 * full (a version with all its notes, or a commit with its date). */
function changelogView(m, page) {
    const c = rowOf(m, page);
    const h = c && m.history && m.history.id === c.id ? m.history : null;
    const status = !h || h.status === 'loading' ? 'Loading' : h.status === 'offline' ? 'Needs internet'
        : h.status === 'error' ? 'Not available' : h.items.length ? `Installed ${c.installed || 'none'}` : 'No changelog';
    const n = m.look === 'id7' ? 96 : 110, items = [];
    (h ? h.items : []).forEach((it, i) => {
        items.push({ id: `v${i}`, plain: true, title: it.rev ? it.title : `Version ${it.title}`, sub: it.rev ? it.date : '',
            subColor: DIM, right: it.new ? 'chip:New' : '', chipColor: BLUE });
        lines(it.rev ? '' : it.text, n).forEach((l, j) => items.push({ id: `v${i}.${j}`, note: true, title: l, color: 'dim' }));
    });
    return { title: { text: c ? `${c.title} changelog` : 'Changelog' }, status: { text: status, color: DIM }, list: { items, empty: '' } };
}

function appView(m, page) {
    const c = rowOf(m, page);
    if (!c) {
        return { name: { text: tr("Not listed") }, author: { text: '' }, facts: { items: [] }, desc: { text: '' }, icon: { letter: '?' },
            instValue: { text: '' }, availLabel: { text: '' }, availValue: { text: '' }, problem: { text: '' }, note1: { text: '' }, note2: { text: '' },
            note3: { text: '' }, progress: hidden, primary: hidden, secondary: hidden, history: { items: [], empty: '' } };
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
        // the version opens the changelog (every entry of the update history, in full)
        facts: { items: [{ text: tr("Version {0}", c.version), act: { do: 'open', page: { name: 'changelog', id: c.id } } }, c.size && { text: size(c.size) },
            // installed under another id than its source's
            c.listedId && !c.blocked && (c.installAs || c.id) !== c.listedId && { text: `Id ${c.installAs || c.id}` },
            { text: isTool(c) ? tr("Tool") : tr("App"), color: isTool(c) ? TEAL : BLUE }, c.mguHmi && c.mguHmi.length && { text: hmiNames(c.mguHmi) },
            c.provides && { text: c.provides }].filter(Boolean) },
        // a failure in full, above the description
        desc: { text: c.description || '', lead: c.error && !mine ? tr("Failed: {0}", c.error) : '', leadColor: RED,
            over: c.error && !mine ? 'history' : '' },
        // a failure in full takes the history's place
        history: c.error && !mine ? { items: [], empty: '' } : historyView(m, c),
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
    if (page.kind === 'remove') {
        title = c ? tr("Remove {0} {1}?", named(m, c), c.installed || '').replace(' ?', '?') : tr("Remove?");
        now = button(tr("Remove"), { do: 'remove', id: page.id }, { vicon: 'trash', style: 'primary', color: RED });
    } else if (page.kind === 'undo') {
        title = c ? tr("Back to {0} {1}?", named(m, c), c.previous || '').replace(' ?', '?') : tr("Undo update");
        now = button(tr("Undo update"), { do: 'undo', id: page.id }, { vicon: 'back', style: 'primary', color: BLUE });
    } else if (page.kind === 'restart') {
        title = tr("Restart head unit?");
        now = button(tr("Restart"), { do: 'restart' }, { vicon: 'refresh', style: 'primary', color: BLUE });
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
    return { icon, title: { text: title }, text: { text: line }, now, later: button(tr("Cancel"), { do: 'back' }, { vicon: 'back', style: 'outline' }),
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

/* How the car gets internet: the head unit has none of its own; the uplink
 * gives it through its Wi-Fi or a USB device. */
const INTERNET_WAYS = [
    { vicon: 'wifi', title: 'Wi-Fi', text: ['Turn the phone\'s hotspot on.', 'Here, open Settings > Wi-Fi and tap Scan.',
        'Pick the phone\'s network, type its password and tap Connect.'] },
    { vicon: 'iphone', title: 'iPhone', text: 'Cable it to a USB port, Personal Hotspot on, the phone unlocked; tap Trust when it asks.' },
    { vicon: 'android', title: 'Android phone', text: 'Cable it to a USB port, then on the phone: Settings > Network > Hotspot & tethering > USB tethering on.' },
    { vicon: 'lteStick', title: 'USB LTE stick', text: 'A USB LTE stick with a SIM card that has mobile data (e.g. Huawei E3372h), in a USB port in the car.' }
];
const INTERNET_STEPS = 'Within a minute this page says Connected. No internet at all? Apps on a USB stick show under USB.';

function internetView(m) {
    const online = !!(m.connected && m.st && m.st.online);
    return {
        title: { text: 'Internet' },
        status: { text: !m.connected ? '' : online ? 'Connected' : 'Not connected', color: online ? GREEN : AMBER },
        ways: { items: INTERNET_WAYS },
        steps: { text: INTERNET_STEPS }
    };
}

/* Settings > Information: the head unit, then the version of everything on it (the Store's sources' components that
 * are installed, apps then tools) and what each renderer is. */
function informationView(m) {
    const st = m.connected ? m.st : null;
    const unit = st && st.unit;
    const items = [];
    const row = (id, title, sub, right) => items.push({ id, title, sub, subColor: DIM, plain: true, right: right ? `chip:${right}` : '', chipColor: DIM });
    if (unit) row('unit', unit.hmi ? hmiNames([unit.hmi]) : 'Head unit', unit.firmware || '', '');
    if (m.version) row('store', 'Store', 'robertn_store', m.version);
    if (st && st.updater) row('updater', 'Updater', 'mgu-updater', st.updater.version);
    const on = comps(m).filter((c) => c.installed && c.id !== 'robertn_store' && c.id !== 'mgu-updater');
    on.filter((c) => !isTool(c)).concat(on.filter(isTool)).forEach((c) => row(c.id, c.title, [c.id, isTool(c) ? 'tool' : 'app', srcName(m, c)].filter(Boolean).join(' · '), c.installed));
    return { title: { text: 'Information' }, status: { text: st ? plural(on.length + 2, 'component') : '', color: DIM }, list: { items, empty: m.connected ? '' : 'Not connected' } };
}

/* The Store's looks (Settings): iDrive 7, the idrive7-apps kit's screens,
 * and iDrive 8, App Manager 2's. Without a choice: the head unit's own. */
const LOOKS = ['id7', 'id8'];
function lookOf(m) {
    if (LOOKS.indexOf(m.look) >= 0) {
        return m.look;
    }
    return m.st && m.st.unit && m.st.unit.hmi === 'ID8' ? 'id8' : 'id7';
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
    return { id: n.ssid, title: n.ssid, sub: [status, q && q[0]].filter(Boolean).join(' · '), subColor: n.current ? GREEN : DIM, plain: true,
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
        subtitle: { text: !w.enabled || w.link === 'unavailable' || w.link === 'failed' ? '' : scanning ? tr("Scanning") : plural(nets.length, 'network') },
        networks: { items: nets.map((n) => netRow(w, n)),
            empty: waiting ? tr("Waiting") : !w.enabled ? tr("Not used") : w.link === 'unavailable' ? tr("Unavailable") : scanning ? tr("Scanning") : tr("No networks") },
        icon: { vicon: 'wifi', kind: 'service', colors: LIT[s[1]] || '#7a808a,#3a3f47' },
        state: { text: s[0], color: s[1] },
        info: { text: [w.ip && `IP ${w.ip}`, dbm].filter(Boolean).join(' · ') },
        note: { text: String(m.uplinkNote || w.error || '').slice(0, 160) },
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
    case 'changelog': values = changelogView(m, page); break;
    case 'pick': values = pickView(m); break;
    case 'login': values = loginView(m); break;
    case 'phone': values = phoneView(m); break;
    case 'internet': values = internetView(m); break;
    case 'information': values = informationView(m); break;
    case 'type': values = typeView(m, page); break;
    case 'wifi': values = wifiView(m); break;
    case 'prefer': values = preferView(m); break;
    default: screen = 'store'; values = storeView(m);
    }
    values.nav = nav(m, tabSel);
    if (values.back === undefined) {
        values.back = { act: { do: 'back' } };
    }
    return { screen, values, look: lookOf(m) };
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

module.exports = { view, icons, typeKey, wifiOf, TABS, FILTERS, canRestart };
