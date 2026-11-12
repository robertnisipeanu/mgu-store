'use strict';
const i18n = require('./i18n.js');

const tr = i18n.t;
/**
 * The Store's texts, from mgu-updater's state (native/mgu-updater/js/updater.js
 * state()): the status line, each row's second column, what a press on a
 * row does, and the Sources, Accounts, sign-in and Phone access pages. No I/O, so
 * tools/test_view.js runs it offline. A field an older updater does not
 * report hides what depends on it.
 */

const PHASE = { download: 'Downloading', verify: 'Verifying', build: 'Building', install: 'Installing',
    uninstall: 'Removing', check: 'Checking' };

/* Minutes the HMI's clock is ahead of UTC, modulo a day (setClusterTime),
 * null while the instrument cluster reports no valid time. */
let clockOffset = null;

const DAY_MS = 86400000;
const QUARTER_MS = 900000;
const CLUSTER_UNFILLED = 15;

/* The HMI's clock is the instrument cluster's display time (KombiIF
 * statusShowTimeDate): its time zone and summer time are the ones set on
 * the head unit. The offset is its time of day less UTC's, in quarter
 * hours; times show as hours and minutes only, so the date does not
 * matter. The HMI shows the time while statusDisplayClockTimeDate is odd
 * and --:-- while it is even; 15 (unfilled) leaves the clock as it is.
 * Returns whether the offset changed. */
function setClusterTime(show, now) {
    const status = show && show.statusDisplayClockTimeDate;
    if (status === CLUSTER_UNFILLED || typeof status !== 'number') {
        return false;
    }
    let offset = null;
    if (status % 2 === 1 && show.displayHour < 24 && show.displayMinute < 60) {
        const sec = show.displaySecond < 60 ? show.displaySecond : 0;
        const diff = ((((show.displayHour * 60 + show.displayMinute) * 60 + sec) * 1000 - now) % DAY_MS + DAY_MS) % DAY_MS;
        offset = (Math.round(diff / QUARTER_MS) * 15) % 1440;
    }
    const changed = offset !== clockOffset;
    clockOffset = offset;
    return changed;
}

/* A time as the HMI's clock shows it: in the head unit's time zone once
 * the cluster reports it, else the system's. */
function clock(ms) {
    if (clockOffset === null) {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    const d = new Date(ms + clockOffset * 60000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function percent(busy) {
    return busy.total ? Math.min(100, Math.floor((100 * busy.progress) / busy.total)) : 0;
}

const HMI_NAMES = { ID7: 'iDrive 7', ID8: 'iDrive 8' };

function hmiNames(list) {
    return (list || []).map((h) => HMI_NAMES[h] || h).join(tr(' and '));
}

/* A version the updater says is not for this head unit (compat "no"): it
 * would refuse to install it. */
function notForUnit(row) {
    return row.compat === 'no' && (row.status === 'update' || row.status === 'available');
}

/* Whether the Store lists the component: not one for another head unit
 * only (compat "no") unless it is installed, so it can be removed. */
function listed(row) {
    return row.compat !== 'no' || !!row.installed;
}

/* An app install queued for the next start (iDrive 8: MainApp takes it
 * only then): the updater reports it pending (nextStart "install", an
 * updater before 0.8.2 reports no nextStart: an app pending a restart that
 * would update) while the car still lists the old version, or none. Not
 * offered again. */
function startPending(row) {
    return row.nextStart !== undefined ? row.nextStart === 'install'
        : !!row.pendingReboot && row.kind === 'app' && (row.status === 'update' || row.status === 'available');
}

/* Where a source's components come from, as their rows show it: a GitHub
 * repo's owner, an https source's host, a USB stick's label. */
function sourceAuthor(src) {
    const label = String(src.label || src.id);
    if (src.usb || src.type === 'usb') {
        return label;
    }
    if (/^https:\/\//.test(label)) {
        return label.replace(/^https:\/\/([^/]+).*$/, '$1');
    }
    return label.indexOf('/') > 0 ? label.slice(0, label.indexOf('/')) : label;
}

/* The source name of each of a screen's rows (row -> text): its source's
 * author, or its whole owner/repo where another of the rows has the same
 * title and the same author from another source (one owner's two repos'
 * DOOM). '' for a row of no known source. */
function sourceNames(rows, sources) {
    const of = (r) => (r && r.source && (sources || []).find((s) => s.id === r.source)) || null;
    const author = (r) => (of(r) ? sourceAuthor(of(r)) : '');
    return (r) => {
        const s = of(r);
        if (!s) {
            return '';
        }
        const twin = (rows || []).some((o) => o !== r && o.title === r.title && o.source !== r.source && author(o) === author(r));
        return twin && !(s.usb || s.type === 'usb') ? String(s.label || s.id).replace(/^https:\/\//, '') : author(r);
    };
}

/* The updater's state with each component's title and description in the
 * display language (its catalog "texts", src/i18n.js text). */
function localized(st) {
    if (!st || !Array.isArray(st.components) || !st.components.some((c) => c && c.texts)) {
        return st;
    }
    return Object.assign({}, st, { components: st.components.map((c) => (c && c.texts
        ? Object.assign({}, c, { title: i18n.text(c, 'title'), description: i18n.text(c, 'description') }) : c)) });
}

/* The components, each titled with its source's name (sourceNames). */
function withSources(rows, sources) {
    const name = sourceNames(rows, sources);
    return (rows || []).map((r) => (name(r) ? Object.assign({}, r, { title: `${r.title} (${name(r)})` }) : r));
}

/* The second column of a component's row. */
function rowState(row, busy) {
    if (busy && busy.id === row.id) {
        return busy.phase === 'download' ? `${percent(busy)}%` : tr(PHASE[busy.phase] || 'Installing');
    }
    if (row.queued) {
        return tr("Waiting");
    }
    if (notForUnit(row)) {
        return tr("Not for this head unit");
    }
    if (row.blocked) {
        return row.installed ? tr("Installed {0}", row.installed) : tr("Not installable");
    }
    if (row.error) {
        return tr("Failed, retry");
    }
    if (startPending(row)) {
        return tr("Restart pending");
    }
    if (row.installed && row.repair && row.status !== 'update') {
        return tr("Not working");
    }
    if (setupable(row, busy)) {
        return tr("Needs setup");
    }
    switch (row.status) {
    case 'update': return tr("Update {0}", row.revision && row.version === row.installed ? row.revision : row.version);
    case 'available': return tr("Install {0}", row.version);
    default: return row.pendingReboot ? tr("Restart pending") : tr("Installed {0}", row.installed);
    }
}

/* What a press on the row does: install, set up (a tool's install step,
 * setupable), remove (after a confirm step), or nothing. A removal the last
 * start failed to apply is tried again. */
function rowAction(row, busy) {
    if ((busy && busy.id === row.id) || row.queued) {
        return null;
    }
    if (row.error && row.applyFailed === 'remove') {
        return removable(row, busy) ? 'remove' : null;
    }
    /* a failed Set up, with no update offered: tried again from the kept copy */
    if (row.error && setupable(Object.assign({}, row, { error: null }), busy)) {
        return 'setup';
    }
    if (!notForUnit(row) && !row.blocked && (((row.status === 'update' || row.status === 'available') && !startPending(row)) || row.error)) {
        return 'install';
    }
    if (setupable(row, busy)) {
        return 'setup';
    }
    return removable(row, busy) ? 'remove' : null;
}

/* Whether the installed tool's install step waits for Set up (the
 * updater's needsSetup), with no update of it offered, and it is neither
 * blocked nor for another head unit. */
function setupable(row, busy) {
    return !!row.installed && !!row.needsSetup && row.status !== 'update' && !row.error && !row.queued && !row.blocked &&
        row.compat !== 'no' && !(busy && busy.id === row.id);
}

/* Whether the component can be removed now (after a confirm step): one
 * installed, whose install is queued for the next start (the removal
 * drops it), or whose change the last start failed to apply (the removal
 * clears the failure); not one whose removal is queued already. */
function removable(row, busy) {
    return row.uninstallable === true && (!!row.installed || row.nextStart === 'install' || !!row.applyFailed) &&
        row.nextStart !== 'remove' && !row.queued && !(busy && busy.id === row.id);
}

/* The installed tools only this app requires (the updater's
 * requiredAlone), which its removal may take along. */
function requiredAlone(rows, row) {
    return (Array.isArray(row.requiredAlone) ? row.requiredAlone : []).map((id) => rows.find((r) => r.id === id)).filter((r) => r && r.installed);
}

/* Whether the component can go back to its version before now (after a
 * confirm step): the updater offers it (previous), and nothing is running,
 * queued or waiting for a restart for it. */
function undoable(row, busy) {
    return typeof row.previous === 'string' && !!row.previous && !!row.installed && !row.queued && !row.pendingReboot &&
        !row.nextStart && !(busy && busy.id === row.id);
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
        return tr("Failed");
    }
    const updates = rows.filter((r) => r.status === 'update' && !notForUnit(r) && !r.blocked && !startPending(r)).length;
    return updates ? (updates > 1 ? tr('{0} updates', updates) : tr('{0} update', updates)) : '';
}

/* The start screen's status line. Unreachable, the updater has either run
 * since this Store was installed (it left its secret here: secret true) or
 * not yet, which after the first install over SSH is until the next start. */
function statusLine(st, connected, secret) {
    if (!connected) {
        return secret ? tr("Updater not running") : tr("Restart the head unit to finish setup");
    }
    if (st.rebooting) {
        return tr("Restarting");
    }
    if (st.safeMode) {
        return tr("Safe mode");
    }
    if (st.privacy && st.privacy !== 'patched') {
        return tr("App privacy patch not in effect");
    }
    const failed = st.components.find((c) => c.error && listed(c));
    if (failed && !st.busy) {
        return `${failed.title}: ${failed.error}`;
    }
    if (st.rebootError && !st.busy) {
        return tr("Restart failed: {0}", st.rebootError);
    }
    if (st.mainappGuard) {
        return tr("Restart head unit to install apps");
    }
    const hidden = st.components.find((c) => c.tileHidden && c.installed);
    if (hidden) {
        return tr("Restart head unit to show {0}", hidden.title);
    }
    if (st.catalog.checking) {
        return tr("Checking for updates");
    }
    const checked = st.catalog.checkedAt ? tr("checked {0}", clock(st.catalog.checkedAt)) : tr("not checked yet");
    if (!st.online) {
        return tr("Offline, {0}", checked);
    }
    if (st.catalog.error) {
        return tr("Check failed: {0}", st.catalog.error);
    }
    const updates = st.components.filter((c) => c.status === 'update' && !notForUnit(c) && !c.blocked && !startPending(c)).length;
    return `${updates ? (updates > 1 ? tr('{0} updates', updates) : tr('{0} update', updates)) : tr("Up to date")}, ${checked}`;
}

/* ---- sources ---- */

const SOURCE_STATE = { checking: 'Checking', error: 'Error', 'auth-needed': 'Sign in', offline: 'Offline' };

function sourceLabel(src) {
    return src.label || src.id;
}

/* The second column of a source's row: what needs the owner, else the
 * account that reads it. */
function sourceState(src) {
    return (SOURCE_STATE[src.status] && tr(SOURCE_STATE[src.status])) || (src.usb ? 'USB' : sourceAccount(src) || 'OK');
}

/* The second column of the start screen's Sources row: what needs the
 * owner. */
function sourcesState(sources) {
    if (sources.some((s) => s.status === 'auth-needed')) {
        return tr("Sign in");
    }
    return sources.some((s) => s.status === 'error') ? tr("Error") : '';
}

function sourceActions(src) {
    return { remove: !src.builtin && !src.usb };
}

/* A GitHub source's channel: releases, a branch's head, or the newest tag. */
function sourceChannel(src) {
    const channel = src.channel || '';
    if (channel.indexOf('branch:') === 0) {
        return tr("Branch {0}", channel.slice(7));
    }
    return { releases: tr("Releases"), tags: tr("Tags"), branch: tr("Branch") }[channel] || '';
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
        return tr("Rejected");
    }
    const n = (token.usedBy || []).length;
    return n ? (n > 1 ? tr('{0} sources', n) : tr('{0} source', n)) : tr("Unused");
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
    return tokens.length ? tr("{0} accounts", tokens.length) : tr("None");
}

/* The sign-in page's status line, or the updater's refusal to start it. */
function loginStatus(login, refusal) {
    if (refusal) {
        return tr("Sign-in failed: {0}", refusal);
    }
    if (!login) {
        return tr("Starting");
    }
    switch (login.status) {
    case 'pending': return tr("Waiting for sign-in");
    case 'done': return tr("Signed in");
    case 'expired': return tr("Code expired");
    default: return login.error ? tr("Sign-in failed: {0}", login.error) : tr("Sign-in failed");
    }
}

/* The login's code while it can still be entered. */
function loginCode(login) {
    return login && login.status === 'pending' && login.code ? login.code : '';
}

/* ---- phone access ---- */

function phoneState(web) {
    return web.enabled ? tr("On") : tr("Off");
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
    return (probe.releases ? [{ label: tr("Releases"), sub: '', channel: 'releases' }] : [])
        .concat(probe.tags ? [{ label: tr("Tags"), sub: '', channel: 'tags' }] : [])
        .concat((Array.isArray(probe.branches) ? probe.branches : []).filter((b) => branchName(b) === b)
            .map((b) => ({ label: b, sub: b === probe.defaultBranch ? tr("Default branch") : tr("Branch"), channel: `branch:${b}` })));
}

/* The repo picker's status: '' once there is something to pick. */
function probeStatus(probe) {
    if (!probe) {
        return tr("Checking");
    }
    switch (probe.status) {
    case 'ok': return '';
    case 'auth-needed': return tr("Not found or private");
    case 'offline': return tr("Offline");
    case 'rate-limited': return tr("GitHub limit reached. Try later or sign in.");
    default: return probe.error ? String(probe.error) : tr("Failed");
    }
}

/* Why text is not a proxy address the updater takes (its tunnel.js parse:
 * http:// or socks5://, a host, an optional port and user name and
 * password, nothing after them); null when it is one. */
function proxyUrlError(text) {
    const m = /^(?:http|socks5h?):\/\/(?:([^\s@/?#]*)@)?(\[[0-9a-f:.]+\]|[^\s:@/?#[\]]+)(?::(\d{1,5}))?\/?$/i.exec(String(text || '').trim());
    // a % in a user name or password starts an escape (%40 for @)
    const escapes = !m || !m[1] || /^(?:[^%]|%[0-9a-f]{2})*$/i.test(m[1]);
    return m && escapes && (!m[3] || (Number(m[3]) > 0 && Number(m[3]) < 65536)) ? null : tr("Use http://host:port or socks5://host:port");
}

/* The Accounts page's status line: Add token's progress or refusal. */
function tokenMessage(m) {
    switch (m.kind) {
    case 'checking': return tr("Checking token");
    case 'added': return tr("Added {0}", m.label);
    case 'speller': return tr("Text entry failed: {0}", m.error);
    case 'refused': return tr("Add token failed: {0}", m.error);
    default: return '';
    }
}

/* The title of the component the updater's refusal of a Remove names as
 * needing it (its keptBy: "<title> needs <id>", or "<title> needs a
 * <capability>: ..."), or null for any other refusal. */
function neededBy(msg) {
    const m = /^(.+) needs (?:a [^:]+: .*|\S+)$/.exec(String(msg));
    return m ? m[1] : null;
}

/* Why the updater refused a Remove (note: { error, by: the id of the
 * component that needs it, when known }), for the component's page:
 * "Needed by <its title in rows>", else the refusal as it is. */
function removeRefusal(note, rows) {
    const title = neededBy(note.error);
    const by = title && note.by && rows.find((r) => r.id === note.by);
    return title ? tr("Needed by {0}", by ? by.title : title) : String(note.error);
}

/* The Sources page's status line. */
function sourcesMessage(m) {
    switch (m.kind) {
    case 'invalid-source': return tr("Not owner/repo or https://host/path: {0}", m.text);
    case 'checking': return tr("Checking {0}", m.repo);
    case 'speller': return tr("Text entry failed: {0}", m.error);
    case 'refused': return tr("{0} failed: {1}", m.op === 'source-remove' ? tr("Remove") : tr("Add source"), m.error);
    default: return '';
    }
}

module.exports = { setClusterTime, clock, setupable, proxyUrlError, localized, listed, startPending, sourceAuthor, sourceNames, withSources, removable, requiredAlone, undoable, hmiNames, notForUnit, parseSource, pickOptions, probeStatus, neededBy, removeRefusal, sourcesMessage, tokenMessage, PHASE, percent, rowState, rowAction, groupState, statusLine, sourceLabel, sourceState,
    sourcesState, sourceActions, sourceChannel, sourceAccount, tokenLabel, tokenState, tokenSources, accountsState, loginStatus, loginCode,
    phoneState, phoneAddress };
