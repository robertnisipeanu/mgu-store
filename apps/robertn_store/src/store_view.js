'use strict';
/**
 * The Store's texts, from mgu-updater's state (native/mgu-updater/js/updater.js
 * state()): the status line, each row's second column, what a press on a
 * row does, and the Sources, Accounts, sign-in and Phone access pages. No I/O, so
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

const HMI_NAMES = { ID7: 'iDrive 7', ID8: 'iDrive 8' };

function hmiNames(list) {
    return (list || []).map((h) => HMI_NAMES[h] || h).join(' and ');
}

/* A version the updater says is not for this head unit (compat "no"): it
 * would refuse to install it. */
function notForUnit(row) {
    return row.compat === 'no' && (row.status === 'update' || row.status === 'available');
}

/* The second column of a component's row. */
function rowState(row, busy) {
    if (busy && busy.id === row.id) {
        return busy.phase === 'download' ? `${percent(busy)}%` : PHASE[busy.phase] || 'Installing';
    }
    if (row.queued) {
        return 'Waiting';
    }
    if (notForUnit(row)) {
        return 'Not for this head unit';
    }
    if (row.blocked) {
        return row.installed ? `Installed ${row.installed}` : 'Not installable';
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
    if (!notForUnit(row) && !row.blocked && (row.status === 'update' || row.status === 'available' || row.error)) {
        return 'install';
    }
    return row.uninstallable === true && row.installed ? 'remove' : null;
}

/* Whether the component can be removed now (after a confirm step). */
function removable(row, busy) {
    return row.uninstallable === true && !!row.installed && !row.queued && !(busy && busy.id === row.id);
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
    const updates = rows.filter((r) => r.status === 'update' && !notForUnit(r) && !r.blocked).length;
    return updates ? `${updates} update${updates > 1 ? 's' : ''}` : '';
}

/* The start screen's status line. Unreachable, the updater has either run
 * since this Store was installed (it left its secret here: secret true) or
 * not yet, which after the first install over SSH is until the next start. */
function statusLine(st, connected, secret) {
    if (!connected) {
        return secret ? 'Updater not running' : 'Restart the head unit to finish setup';
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
    const updates = st.components.filter((c) => c.status === 'update' && !notForUnit(c) && !c.blocked).length;
    return `${updates ? `${updates} update${updates > 1 ? 's' : ''}` : 'Up to date'}, ${checked}`;
}

/* ---- sources ---- */

const SOURCE_STATE = { checking: 'Checking', error: 'Error', 'auth-needed': 'Sign in', offline: 'Offline' };

function sourceLabel(src) {
    return src.label || src.id;
}

/* The second column of a source's row: what needs the owner, else the
 * account that reads it. */
function sourceState(src) {
    return SOURCE_STATE[src.status] || (src.usb ? 'USB' : sourceAccount(src) || 'OK');
}

/* The second column of the start screen's Sources row: what needs the
 * owner. */
function sourcesState(sources) {
    if (sources.some((s) => s.status === 'auth-needed')) {
        return 'Sign in';
    }
    return sources.some((s) => s.status === 'error') ? 'Error' : '';
}

function sourceActions(src) {
    return { remove: !src.builtin && !src.usb };
}

/* A GitHub source's channel: releases, a branch's head, or the newest tag. */
function sourceChannel(src) {
    const channel = src.channel || '';
    if (channel.indexOf('branch:') === 0) {
        return `Branch ${channel.slice(7)}`;
    }
    return { releases: 'Releases', tags: 'Tags', branch: 'Branch' }[channel] || '';
}

function sourceAccount(src) {
    return (src.auth && src.auth.login) || '';
}

/* ---- accounts (the updater's tokens) ---- */

function tokenLabel(token) {
    return token.label || token.login || token.id;
}

/* The second column of an account's row. */
function tokenState(token) {
    if (token.rejected) {
        return 'Rejected';
    }
    const n = (token.usedBy || []).length;
    return n ? `${n} source${n > 1 ? 's' : ''}` : 'Unused';
}

/* The sources an account reads, by label. */
function tokenSources(token, sources) {
    return (token.usedBy || []).map((id) => {
        const src = (sources || []).find((s) => s.id === id);
        return src ? sourceLabel(src) : id;
    }).join(', ');
}

/* The second column of the Sources page's Accounts row. */
function accountsState(tokens) {
    if (tokens.length === 1) {
        return tokenLabel(tokens[0]);
    }
    return tokens.length ? `${tokens.length} accounts` : 'None';
}

/* The sign-in page's status line, or the updater's refusal to start it. */
function loginStatus(login, refusal) {
    if (refusal) {
        return `Sign-in failed: ${refusal}`;
    }
    if (!login) {
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
function loginCode(login) {
    return login && login.status === 'pending' && login.code ? login.code : '';
}

/* ---- phone access ---- */

function phoneState(web) {
    return web.enabled ? 'On' : 'Off';
}

/* What the Phone access page shows while the page is on: the QR code and
 * text of the access URL (with its token) the updater leaves in the app's
 * data folder (`web-url`, its first line), or, without one, the token-free
 * address of the state as text only. */
function phoneAddress(web, fileText) {
    if (!web.enabled) {
        return { qr: '', text: '' };
    }
    const line = String(fileText || '').split('\n')[0].trim();
    if (/^https?:\/\/\S+$/.test(line)) {
        return { qr: line, text: line };
    }
    return { qr: '', text: (web.urls && web.urls[0]) || '' };
}

/* ---- adding a source ---- */

/* As mgu-updater's sources.js checks them. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const HTTPS = /^https:\/\/[^/\s]+\/\S*$/;
const GITHUB_HOST = /^(?:https?:\/\/)?(?:www\.)?github\.com(?:\/|$)/i;
const GITHUB_REPO = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\/tree\/(\S+?))?\/?$/i;

/* A branch name as git takes it, or null. */
function branchName(text) {
    let b;
    try {
        b = decodeURIComponent(String(text || '')).trim();
    } catch (e) {
        return null;
    }
    return BRANCH.test(b) && b.indexOf('..') < 0 && !/\/$|\.lock$/.test(b) ? b : null;
}

/* The source typed in the speller: { type: 'github', repo, channel? } for
 * owner/repo or a github.com address of a repo (with or without https://,
 * .git or a trailing slash; .../tree/<branch> gives the channel
 * branch:<branch>), { type: 'https', url } for any other https address with
 * a path (the scheme in lower case), null for anything else. A repo
 * without a channel is offered on what it has (pickOptions). */
function parseSource(text) {
    const t = String(text || '').trim();
    const gh = GITHUB_REPO.exec(t);
    if (gh) {
        const branch = gh[2] === undefined ? '' : branchName(gh[2]);
        if (!REPO.test(gh[1]) || branch === null) {
            return null;
        }
        return Object.assign({ type: 'github', repo: gh[1] }, branch ? { channel: `branch:${branch}` } : {});
    }
    if (GITHUB_HOST.test(t)) {
        return null;
    }
    const repo = t.replace(/\/$/, '').replace(/\.git$/i, '');
    if (REPO.test(repo)) {
        return { type: 'github', repo };
    }
    const url = t.replace(/^https:\/\//i, 'https://');
    return HTTPS.test(url) && url.length <= 2048 ? { type: 'https', url } : null;
}

/* What a GitHub repo can be added on, from the updater's source-probe
 * answer, in the order offered: Releases, Tags (each only when the repo has
 * them), then its branches as the updater orders them (main, master, the
 * default branch, the rest). Each: { label, sub, channel }. */
function pickOptions(probe) {
    if (!probe || probe.status !== 'ok') {
        return [];
    }
    return (probe.releases ? [{ label: 'Releases', sub: '', channel: 'releases' }] : [])
        .concat(probe.tags ? [{ label: 'Tags', sub: '', channel: 'tags' }] : [])
        .concat((Array.isArray(probe.branches) ? probe.branches : []).filter((b) => branchName(b) === b)
            .map((b) => ({ label: b, sub: b === probe.defaultBranch ? 'Default branch' : 'Branch', channel: `branch:${b}` })));
}

/* The repo picker's status: '' once there is something to pick. */
function probeStatus(probe) {
    if (!probe) {
        return 'Checking';
    }
    switch (probe.status) {
    case 'ok': return '';
    case 'auth-needed': return 'Not found or private';
    case 'offline': return 'Offline';
    case 'rate-limited': return 'GitHub rate limit reached';
    default: return probe.error ? String(probe.error) : 'Failed';
    }
}

/* The Accounts page's status line: Add token's progress or refusal. */
function tokenMessage(m) {
    switch (m.kind) {
    case 'checking': return 'Checking token';
    case 'added': return `Added ${m.label}`;
    case 'speller': return `Text entry failed: ${m.error}`;
    case 'refused': return `Add token failed: ${m.error}`;
    default: return '';
    }
}

/* The Sources page's status line. */
function sourcesMessage(m) {
    switch (m.kind) {
    case 'invalid-source': return `Not owner/repo or https://host/path: ${m.text}`;
    case 'checking': return `Checking ${m.repo}`;
    case 'speller': return `Text entry failed: ${m.error}`;
    case 'refused': return `${m.op === 'source-remove' ? 'Remove' : 'Add source'} failed: ${m.error}`;
    default: return '';
    }
}

module.exports = { removable, hmiNames, notForUnit, parseSource, pickOptions, probeStatus, sourcesMessage, tokenMessage, PHASE, percent, rowState, rowAction, groupState, statusLine, sourceLabel, sourceState,
    sourcesState, sourceActions, sourceChannel, sourceAccount, tokenLabel, tokenState, tokenSources, accountsState, loginStatus, loginCode,
    phoneState, phoneAddress };
