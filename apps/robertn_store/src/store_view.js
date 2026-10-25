'use strict';
/**
 * The Store's texts, from mgu-updater's state (native/mgu-updater/js/updater.js
 * state()): the status line, each row's second column, and what a press on a
 * row does. No I/O, so tools/test_view.js runs it offline.
 */

const PHASE = { download: 'Downloading', verify: 'Verifying', install: 'Installing', check: 'Checking' };

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
    case 'update': return `Update ${row.version}`;
    case 'available': return `Install ${row.version}`;
    default: return row.pendingReboot ? 'Restart pending' : `Installed ${row.installed}`;
    }
}

/* What a press on the row does: install, or nothing. */
function rowAction(row, busy) {
    if ((busy && busy.id === row.id) || row.queued) {
        return null;
    }
    return row.status === 'update' || row.status === 'available' || row.error ? 'install' : null;
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

module.exports = { PHASE, percent, rowState, rowAction, groupState, statusLine };
