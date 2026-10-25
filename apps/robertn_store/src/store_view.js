'use strict';
/**
 * The Store's texts, from mgu-updater's state (native/mgu-updater/js/updater.js
 * state()): the status line, each row's second column, what a press on a
 * row does, and the Sources, sign-in and Phone access pages. No I/O, so
 * tools/test_view.js runs it offline. A field an older updater does not
 * report hides what depends on it.
 */

const PHASE = { download: 'Downloading', verify: 'Verifying', build: 'Building', install: 'Installing',
    uninstall: 'Removing', check: 'Checking' };

function clock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function percent(busy) {
    return busy.total ? Math.min(100, Math.floor((100 * busy.progress) / busy.total)) : 0;
}

/* The second column of a component's row. */
function rowState(row, busy) {
    if (busy && busy.id === row.id) {
        return busy.phase === 'download' ? `${percent(busy)}%` : PHASE[busy.phase] || 'Installing';
    }
    if (row.queued) {
        return 'Waiting';
    }
    if (row.error) {
        return 'Failed, retry';
    }
    switch (row.status) {
    case 'update': return `Update ${row.revision && row.version === row.installed ? row.revision : row.version}`;
    case 'available': return `Install ${row.version}`;
    default: return row.pendingReboot ? 'Restart pending' : `Installed ${row.installed}`;
    }
}

/* What a press on the row does: install, remove (after a confirm step), or
 * nothing. */
function rowAction(row, busy) {
    if ((busy && busy.id === row.id) || row.queued) {
        return null;
    }
    if (row.status === 'update' || row.status === 'available' || row.error) {
        return 'install';
    }
    return row.uninstallable === true && row.installed ? 'remove' : null;
}

/* The second column of the start screen's Apps and Head-unit tools rows,
 * for the catalog rows of that kind: the running install, a failure, or
 * how many updates there are. */
function groupState(rows, busy) {
    const busyRow = busy && rows.find((r) => r.id === busy.id);
    if (busyRow) {
        return rowState(busyRow, busy);
    }
    if (rows.some((r) => r.error)) {
        return 'Failed';
    }
    const updates = rows.filter((r) => r.status === 'update').length;
    return updates ? `${updates} update${updates > 1 ? 's' : ''}` : '';
}

function statusLine(st, connected) {
    if (!connected) {
        return 'Updater not running';
    }
    if (st.rebooting) {
        return 'Restarting';
    }
    if (st.privacy && st.privacy !== 'patched') {
        return 'App privacy patch not in effect';
    }
    const failed = st.components.find((c) => c.error);
    if (failed && !st.busy) {
        return `${failed.title}: ${failed.error}`;
    }
    if (st.rebootError && !st.busy) {
        return `Restart failed: ${st.rebootError}`;
    }
    if (st.catalog.checking) {
        return 'Checking for updates';
    }
    const checked = st.catalog.checkedAt ? `checked ${clock(st.catalog.checkedAt)}` : 'not checked yet';
    if (!st.online) {
        return `Offline, ${checked}`;
    }
    if (st.catalog.error) {
        return `Check failed: ${st.catalog.error}`;
    }
    const updates = st.components.filter((c) => c.status === 'update').length;
    return `${updates ? `${updates} update${updates > 1 ? 's' : ''}` : 'Up to date'}, ${checked}`;
}

/* ---- sources ---- */

const SOURCE_STATE = { checking: 'Checking', error: 'Error', 'auth-needed': 'Sign in', offline: 'Offline' };

function sourceLabel(src) {
    return src.label || src.id;
}

/* The second column of a source's row. */
function sourceState(src) {
    return SOURCE_STATE[src.status] || (src.usb ? 'USB' : 'OK');
}

/* The second column of the start screen's Sources row: what needs the
 * owner. */
function sourcesState(sources) {
    if (sources.some((s) => s.status === 'auth-needed')) {
        return 'Sign in';
    }
    return sources.some((s) => s.status === 'error') ? 'Error' : '';
}

/* What the source page offers. */
function sourceActions(src) {
    return {
        signIn: src.type === 'github' && !src.usb,
        remove: !src.builtin && !src.usb
    };
}

/* A GitHub source's channel: releases, a branch's head, or the newest tag. */
function sourceChannel(src) {
    const channel = src.channel || '';
    if (channel.indexOf('branch:') === 0) {
        return `Branch ${channel.slice(7)}`;
    }
    return { releases: 'Releases', tags: 'Tags' }[channel] || '';
}

function sourceAccount(src) {
    return (src.auth && src.auth.login) || '';
}

/* The sign-in page's status line for the GitHub login of `sourceId`. */
function loginStatus(login, sourceId) {
    if (!login || login.source !== sourceId) {
        return 'Starting';
    }
    switch (login.status) {
    case 'pending': return 'Waiting for sign-in';
    case 'done': return 'Signed in';
    case 'expired': return 'Code expired';
    default: return login.error ? `Sign-in failed: ${login.error}` : 'Sign-in failed';
    }
}

/* The login's code while it can still be entered. */
function loginCode(login, sourceId) {
    return login && login.source === sourceId && login.status === 'pending' && login.code ? login.code : '';
}

/* ---- phone access ---- */

function phoneState(web) {
    return web.enabled ? 'On' : 'Off';
}

/* The page's address a phone on the car's hotspot can open: the first one
 * that is not the unit's loopback. */
function phoneUrl(web) {
    if (!web.enabled) {
        return '';
    }
    return (web.urls || []).find((u) => !/^https?:\/\/(127\.|localhost[:/])/.test(u)) || '';
}

module.exports = { PHASE, percent, rowState, rowAction, groupState, statusLine, sourceLabel, sourceState,
    sourcesState, sourceActions, sourceChannel, sourceAccount, loginStatus, loginCode, phoneState, phoneUrl };
