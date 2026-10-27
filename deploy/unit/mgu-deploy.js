#!/usr/bin/env node
'use strict';
/**
 * mgu-deploy: installs, updates and removes our head-unit tools and OAP
 * apps, with a snapshot before every change and a verified restore.
 * Runs as root under the unit's Node 8, invoked through mgu-deploy.sh.
 *
 *   mgu-deploy.sh check [--artifact <file>...]
 *   mgu-deploy.sh install [--artifact <file>...] [--yes]
 *   mgu-deploy.sh status [--json]
 *   mgu-deploy.sh uninstall <id> [--yes]
 *   mgu-deploy.sh rollback <id> [--yes]
 *   mgu-deploy.sh restore [name] [--yes]
 *   mgu-deploy.sh backups
 *   mgu-deploy.sh fallback <on|off|status|migrate> [--yes]
 *   mgu-deploy.sh updater-token | updater-token --list [--json] | updater-token --remove <id>   (a token on stdin)
 *   mgu-deploy.sh updater-sources            (sources.json on stdin)
 *   mgu-deploy.sh sdk-donor [--json]
 *   mgu-deploy.sh apply-pending              (iDrive 8, at boot: queued app changes)
 *   mgu-deploy.sh appmanager [--json] | appmanager adopt [--yes]   (IterioDev's App Manager)
 *   mgu-deploy.sh help
 *
 * Exit codes: 0 done, 1 failed (rolled back where applicable),
 * 2 preflight refused (nothing changed).
 *
 * Without --artifact, install takes every *.tgz in ./artifacts beside
 * this script, tools before apps, the app-privacy tool first. A tool
 * artifact carries component.json at its root with files/ and units/
 * payloads. An app artifact is an OAP package (package.json
 * at its root or under package/, or a .mgu with source/), or a source
 * package (mgu-app.json), which is built here with oap_link.js.
 *
 * Every absolute root and external command can be overridden through
 * MGU_DEPLOY_* environment variables (see CFG below).
 * MGU_DEPLOY_FAKE_ROOT=1 runs against plain directories: no mount
 * remounts, no bind mounts, no chown to unit uids; the app manager is
 * whatever MGU_DEPLOY_PS and MGU_DEPLOY_KILL show and kill. The
 * production paths are the defaults.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

/* deploy/component.json's version; bumped when a file under deploy/unit/
 * changes. */
var VERSION = '0.5.1';
var HERE = __dirname;
var MGR_UID = Number(process.env.MGU_DEPLOY_MAINAPP_UID || 12201);

function env(name, dflt) { return process.env[name] ? process.env[name] : dflt; }

var CFG = {
    varOpt: env('MGU_DEPLOY_VAR_OPT', '/var/opt'),
    systemd: env('MGU_DEPLOY_SYSTEMD', '/etc/systemd/system'),
    recmgr: env('MGU_DEPLOY_RECMGR', '/etc/recmgr-restartlist.conf'),
    mainapp: env('MGU_DEPLOY_MAINAPP', '/usr/lib/oap-mainapp'),
    mainapp21: env('MGU_DEPLOY_MAINAPP21', '/usr/lib/oap-mainapp21'),
    // Hmi8's built-in applets: its RHMI applets' manifests (its -ro data) and its native applets
    hmi8Data: env('MGU_DEPLOY_HMI8_DATA', '/mnt/dataro/data/hmi8'),
    hmi8Applets: env('MGU_DEPLOY_HMI8_APPLETS', '/usr/lib/hmi8/applet'),
    prov: env('MGU_DEPLOY_PROV', '/usr/share/tm/prov'),
    vminput: env('MGU_DEPLOY_VMINPUT', '/usr/bin/vminput'),
    oap: env('MGU_DEPLOY_OAP', '/var/opt/public/oap'),
    etc: env('MGU_DEPLOY_ETC', '/etc'),
    proc: env('MGU_DEPLOY_PROC', '/proc'),
    procStat: env('MGU_DEPLOY_PROC_STAT', '/proc/stat'),
    procMounts: env('MGU_DEPLOY_PROC_MOUNTS', '/proc/mounts'),
    bootId: env('MGU_DEPLOY_BOOT_ID', '/proc/sys/kernel/random/boot_id'),
    systemctl: env('MGU_DEPLOY_SYSTEMCTL', 'systemctl'),
    journalctl: env('MGU_DEPLOY_JOURNALCTL', 'journalctl'),
    mount: env('MGU_DEPLOY_MOUNT', 'mount'),
    umount: env('MGU_DEPLOY_UMOUNT', 'umount'),
    ps: env('MGU_DEPLOY_PS', 'ps'),
    kill: env('MGU_DEPLOY_KILL', ''),
    tar: env('MGU_DEPLOY_TAR', 'tar'),
    df: env('MGU_DEPLOY_DF', 'df'),
    setquota: env('MGU_DEPLOY_SETQUOTA', 'setquota'),
    sh: env('MGU_DEPLOY_SH', '/bin/sh'),
    run: env('MGU_DEPLOY_RUN', '/run/mgu-deploy'),
    node: env('MGU_DEPLOY_NODE', '/usr/bin/node'),
    socketPath: env('MGU_DEPLOY_BRIDGE_SOCKET', '/dev/shm/display-bridge/bridge.sock'),
    watchTimeoutMs: Number(env('MGU_DEPLOY_WATCH_TIMEOUT_MS', '600000')),
    watchPollMs: Number(env('MGU_DEPLOY_WATCH_POLL_MS', '5000')),
    inplaceAckMs: Number(env('MGU_DEPLOY_INPLACE_ACK_MS', '20000')),
    inplaceReportMs: Number(env('MGU_DEPLOY_INPLACE_REPORT_MS', '15000')),
    bounceTimeoutMs: Number(env('MGU_DEPLOY_BOUNCE_TIMEOUT_MS', '30000')),
    healthMs: Number(env('MGU_DEPLOY_HEALTH_MS', '10000')),
    bounceMinUpS: Number(env('MGU_DEPLOY_BOUNCE_MIN_UP_S', '60')),
    lockWaitMs: Number(env('MGU_DEPLOY_LOCK_WAIT_MS', '3600000')),
    migrateSettleMs: Number(env('MGU_DEPLOY_MIGRATE_SETTLE_MS', '45000'))
};
var FAKE = process.env.MGU_DEPLOY_FAKE_ROOT === '1';
var DEPLOY_DIR = path.join(CFG.varOpt, 'mgu-deploy');
var STATE_FILE = path.join(DEPLOY_DIR, 'state.json');
var BACKUPS_DIR = path.join(DEPLOY_DIR, 'backups');
var KEEP_BACKUPS = 10;
var LOCK_FILE = path.join(DEPLOY_DIR, 'lock');
var RECMGR_AT_BOOT = path.join(DEPLOY_DIR, 'recmgr-at-boot.json');
var FALLBACK_UNIT = 'mgu-app-fallback.service';
var FALLBACK_NAME = 'mgu-app-fallback';
var FALLBACK_COPY = path.join(DEPLOY_DIR, 'main.js');
var FALLBACK_BUILD_INSTALLED = path.join(DEPLOY_DIR, 'current', 'fallback_build.js');
var INPLACE_DIR = path.join(DEPLOY_DIR, 'inplace');
var INPLACE_REQUEST = path.join(INPLACE_DIR, 'request.json');
var SHIM = path.join(DEPLOY_DIR, 'mgu-deploy.sh');
/* This tool's own manifest, as deploy/component.json has it. */
var SELF_TITLE = 'Deploy tool';
var SELF_DESCRIPTION = 'Installs, updates, rolls back and removes our tools and apps on the head unit, ' +
    'with a snapshot before every change';
var SELF_FILES = [{ path: 'mgu-deploy.js', mode: '0644' }, { path: 'mgu-deploy.sh', mode: '0755' },
    { path: 'fallback_build.js', mode: '0644' }, { path: 'mgu-app-fallback.service', mode: '0644' },
    { path: 'mgu-deploy-apply.service', mode: '0644' },
    { path: 'oap_link.js', mode: '0644' }, { path: 'oap_pack.js', mode: '0644' }];
/* A file of this tool: beside the script, or in the repository's tools/
 * (the linker and packer, when it runs from deploy/unit/). */
function selfFile(name) {
    var p = path.join(HERE, name);
    return fs.existsSync(p) ? p : path.join(HERE, '..', '..', 'tools', name);
}
function linker() { return require(selfFile('oap_link.js')); }

function privacyTool() {
    return env('MGU_DEPLOY_PRIVACY',
        path.join(CFG.varOpt, 'app-privacy', 'current', 'patch_mainapp.js'));
}
function mainJs() { return path.join(CFG.mainapp, 'src', 'main.js'); }
function appManagementJs() { return path.join(CFG.mainapp, 'src', 'AppManagement', 'AppManagement.js'); }
function baseJson() { return path.join(CFG.mainapp, 'config', 'base.json'); }
/* MainApp's own folder: oap-mainapp on iDrive 7, oap-mainapp21 on iDrive 8. */
function mainappRoot() { return unitInfo().hmi === 'ID8' ? CFG.mainapp21 : CFG.mainapp; }
function preinstalledDir() { return path.join(mainappRoot(), 'preinstalled_apps'); }
function mgrHome() { return path.join(CFG.oap, 'oap_' + MGR_UID); }
function appsDir() { return path.join(mgrHome(), 'data', 'apps'); }
function customAppsFile() { return path.join(mgrHome(), 'data', 'custom_apps.json'); }
function localOnlyFile() { return path.join(mgrHome(), 'data', 'local-only-apps.json'); }
function inplaceStatusFile() { return path.join(mgrHome(), 'data', 'mgu-deploy-inplace.json'); }
function appEntryFile(id) { return path.join(appsDir(), id + '.json'); }
function appHome(uid) { return path.join(CFG.oap, 'oap_' + uid); }
function updaterDir() { return path.join(CFG.varOpt, 'mgu-updater'); }
function sourcesFile() { return path.join(updaterDir(), 'sources.json'); }
function credentialsDir() { return path.join(updaterDir(), 'credentials'); }
var SOURCE_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
function uplinkDropIns(id) {
    var root = path.join(CFG.varOpt, 'mgu-uplink');
    return [path.join(root, 'uids.d', id), path.join(root, 'apps.d', id)];
}

/* ---- small helpers (Node 8) ------------------------------------------- */

function fail(msg) { var e = new Error(msg); e.code = 1; return e; }
function refuse(msg) { var e = new Error(msg); e.code = 2; return e; }
function isRefusal(e) { return !!e && e.code === 2; }
function say(m) { process.stdout.write(m + '\n'); }
function warn(m) { process.stdout.write('warning: ' + m + '\n'); }

function mkdirp(dir, mode) {
    if (fs.existsSync(dir)) return;
    mkdirp(path.dirname(dir), 0o755);
    fs.mkdirSync(dir, mode || 0o755);
    try { fs.chmodSync(dir, mode || 0o755); } catch (e) { /* mode set on create */ }
}
function rmrf(p) {
    var st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory() && !st.isSymbolicLink()) {
        fs.readdirSync(p).forEach(function (n) { rmrf(path.join(p, n)); });
        fs.rmdirSync(p);
    } else {
        fs.unlinkSync(p);
    }
}
function lstatOrNull(p) { try { return fs.lstatSync(p); } catch (e) { return null; } }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function readJsonOrNull(p) { try { return readJson(p); } catch (e) { return null; } }
function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function sha256Buf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function writeAtomic(file, data, mode) {
    mkdirp(path.dirname(file));
    var tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, data);
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
}
function copyFileMode(src, dest, mode) {
    mkdirp(path.dirname(dest));
    var tmp = dest + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, fs.readFileSync(src));
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, dest);
}
function chownMaybe(p, uid, gid) {
    if (FAKE) return;
    fs.chownSync(p, uid, gid);
}
function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function run(cmd, args, opts) {
    opts = opts || {};
    var r = cp.spawnSync(cmd, args, {
        encoding: 'utf8', timeout: opts.timeout || 120000, maxBuffer: 16 << 20
    });
    if (r.error && !opts.allowFail) throw fail(cmd + ': ' + r.error.message);
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}
function runOk(cmd, args, opts) {
    var r = run(cmd, args, opts);
    if (r.status !== 0) {
        throw fail(cmd + ' ' + args.join(' ') + ' exited ' + r.status +
            (r.stderr ? ': ' + r.stderr.trim() : ''));
    }
    return r;
}
function which(cmd) {
    if (cmd.indexOf('/') >= 0) return fs.existsSync(cmd);
    var r = run(CFG.sh, ['-c', 'command -v ' + cmd], { allowFail: true });
    return r.status === 0;
}
function shQuote(s) { return "'" + String(s).split("'").join("'\\''") + "'"; }
function octalMode(s) {
    if (typeof s !== 'string' || !/^[0-7]{3,4}$/.test(s)) return null;
    return parseInt(s, 8);
}
function semverParts(v) {
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) return null;
    return v.split('.').map(Number);
}
function semverCmp(a, b) {
    var pa = semverParts(a), pb = semverParts(b), i;
    if (!pa || !pb) return null;
    for (i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1; }
    return 0;
}
function walk(dir, base, out) {
    fs.readdirSync(dir).forEach(function (n) {
        var p = path.join(dir, n), rel = base ? base + '/' + n : n, st = fs.lstatSync(p);
        out.push({ path: p, rel: rel, stat: st });
        if (st.isDirectory() && !st.isSymbolicLink()) walk(p, rel, out);
    });
    return out;
}
function timestamp() {
    return new Date().toISOString().split(':').join('').split('-').join('').replace('.', '');
}

/* ---- state -------------------------------------------------------------- */

function loadState() {
    var s = readJsonOrNull(STATE_FILE);
    if (!s || typeof s !== 'object') s = {};
    if (!s.apps || typeof s.apps !== 'object') s.apps = {};
    if (!Array.isArray(s.pending_reboot)) s.pending_reboot = [];
    /* A pending entry holds until the next boot. */
    var boot = bootId();
    s.pending_reboot = s.pending_reboot.filter(function (p) { return p.boot === boot; });
    return s;
}
function saveState(s) {
    mkdirp(DEPLOY_DIR);
    var lb = lastBounceAt();
    if (lb) s.lastBounceAt = lb;
    writeAtomic(STATE_FILE, JSON.stringify(s, null, 2) + '\n', 0o644);
}
/* When the app manager's node child was last killed by this tool, in
 * epoch seconds: the record every later bounce, from any invocation,
 * keeps its distance from. Written to state.json at each bounce. */
var LAST_BOUNCE = 0;
function lastBounceAt() {
    var s = readJsonOrNull(STATE_FILE), disk = s && typeof s.lastBounceAt === 'number' ? s.lastBounceAt : 0;
    return Math.max(disk, LAST_BOUNCE);
}
function recordBounce(t) {
    LAST_BOUNCE = Math.max(LAST_BOUNCE, t);
    var s = readJsonOrNull(STATE_FILE);
    if (!s || typeof s !== 'object') s = {};
    s.lastBounceAt = Math.max(typeof s.lastBounceAt === 'number' ? s.lastBounceAt : 0, LAST_BOUNCE);
    mkdirp(DEPLOY_DIR);
    writeAtomic(STATE_FILE, JSON.stringify(s, null, 2) + '\n', 0o644);
}
function addPending(state, id, reason) {
    var found = state.pending_reboot.some(function (p) { return p.id === id && p.reason === reason; });
    if (!found) state.pending_reboot.push({ id: id, reason: reason, boot: bootId() });
}

/* Folders this tool created (a target's .wants folder, the updater's
 * config folder) are removed again once a removal leaves them empty. */
function noteCreatedDir(state, d) {
    if (!Array.isArray(state.created_dirs)) state.created_dirs = [];
    if (state.created_dirs.indexOf(d) < 0) state.created_dirs.push(d);
}
function pruneCreatedDirs(state) {
    var keep = [], rootOps = [];
    (state.created_dirs || []).forEach(function (d) {
        var st = lstatOrNull(d);
        if (!st) return;
        if (!st.isDirectory() || fs.readdirSync(d).length) { keep.push(d); return; }
        if (isRootfsPath(d)) rootOps.push({ type: 'rmdir', path: d });
        else fs.rmdirSync(d);
        say('removed empty folder ' + d);
    });
    if (rootOps.length) rootfsWindow(rootOps);
    state.created_dirs = keep;
}

/* ---- system facts --------------------------------------------------------- */

function rootMountMode() {
    try {
        var lines = fs.readFileSync(CFG.procMounts, 'utf8').split('\n'), i, f;
        for (i = lines.length - 1; i >= 0; i--) {
            f = lines[i].split(' ');
            if (f[1] === '/') return (f[3] || '').split(',')[0];
        }
    } catch (e) { /* no mounts table readable */ }
    return 'unknown';
}
function bootTime() {
    try {
        var m = /^btime (\d+)$/m.exec(fs.readFileSync(CFG.procStat, 'utf8'));
        return m ? Number(m[1]) : null;
    } catch (e) { return null; }
}
function bootId() {
    try { return fs.readFileSync(CFG.bootId, 'utf8').trim(); } catch (e) { return null; }
}
/* Which head unit this is: hmi "ID7" (iDrive 7) or "ID8" (iDrive 8), null
 * when nothing tells, and the firmware's build string. MainApp's folder
 * decides: /usr/lib/oap-mainapp on iDrive 7, /usr/lib/oap-mainapp21 on
 * iDrive 8. With both or neither, the running HMI decides: HmiMain3D on
 * iDrive 7, Hmi8 on iDrive 8. The firmware: the first line of
 * /etc/os-release-id-dlt ("BMW MGU P18_23w44.2-1-3 mgu-high"), else
 * os-release's PRETTY_NAME. `basis` says what decided, for status. */
var UNIT_INFO = null;
function hmiProcess() {
    var found = null;
    try {
        fs.readdirSync(CFG.proc).some(function (n) {
            if (!/^\d+$/.test(n)) return false;
            var comm = '';
            try { comm = fs.readFileSync(path.join(CFG.proc, n, 'comm'), 'utf8').trim(); } catch (e) { return false; }
            if (comm === 'HmiMain3D') found = 'ID7';
            else if (comm === 'Hmi8') found = 'ID8';
            return !!found;
        });
    } catch (e) { /* no process list */ }
    return found;
}
function firmwareString() {
    var t = '', m;
    try { t = fs.readFileSync(path.join(CFG.etc, 'os-release-id-dlt'), 'utf8').split('\n')[0].trim(); } catch (e) { /* none */ }
    if (!t) {
        try {
            m = /^PRETTY_NAME=["']?([^"'\n]*)/m.exec(fs.readFileSync(path.join(CFG.etc, 'os-release'), 'utf8'));
            t = m ? m[1].trim() : '';
        } catch (e) { /* none */ }
    }
    return t ? t.slice(0, 120) : null;
}
function unitInfo() {
    if (UNIT_INFO) return UNIT_INFO;
    var id7 = fs.existsSync(CFG.mainapp), id8 = fs.existsSync(CFG.mainapp21), hmi = null, basis;
    if (id7 !== id8) { hmi = id8 ? 'ID8' : 'ID7'; basis = id8 ? CFG.mainapp21 : CFG.mainapp; }
    else {
        hmi = hmiProcess();
        basis = hmi ? (hmi === 'ID8' ? 'Hmi8' : 'HmiMain3D') + ' running' : (id7 ? 'both MainApp folders' : 'no MainApp folder') + ', no HMI running';
    }
    UNIT_INFO = { hmi: hmi, firmware: firmwareString(), basis: basis };
    return UNIT_INFO;
}
var HMI_NAMES = { ID7: 'iDrive 7', ID8: 'iDrive 8' };
function hmiName(h) { return HMI_NAMES[h] || h; }
function parseColonFile(file) {
    try { return fs.readFileSync(file, 'utf8').split('\n').filter(function (l) { return l; }); }
    catch (e) { return []; }
}
function groupExists(name) {
    return parseColonFile(path.join(CFG.etc, 'group')).some(function (l) { return l.split(':')[0] === name; });
}
function systemctl(args, opts) { return run(CFG.systemctl, args, opts || { allowFail: true }); }
function unitState(unit, verb) {
    var r = systemctl([verb, unit]);
    return (r.stdout || '').trim() || 'unknown';
}
/* Full command lines: busybox's "ps w" cuts them at 131 columns, before
 * the app manager's main.js path. */
function psLines() {
    var r = run(CFG.ps, ['ww'], { allowFail: true });
    if (r.status !== 0) r = run(CFG.ps, ['auxww'], { allowFail: true });
    return (r.stdout || '').split('\n');
}
/* The PID column is where the header names it: first in busybox's ps,
 * second in "ps aux". */
function managerPid() {
    var lines = psLines(), col = (lines[0] || '').trim().split(/\s+/).indexOf('PID'), i, pid;
    if (col < 0) return null;
    for (i = 1; i < lines.length; i++) {
        if (lines[i].indexOf(path.basename(mainappRoot()) + '/src/main.js') < 0) continue;
        pid = Number(lines[i].trim().split(/\s+/)[col]);
        if (pid > 0 && pid !== process.pid) return pid;
    }
    return null;
}
function nowS() { return Date.now() / 1000; }
function monoS() { var t = process.hrtime(); return t[0] + t[1] / 1e9; }
/* A process's start in epoch seconds: /proc/<pid>/stat field 22
 * (clock ticks after boot, USER_HZ 100) plus the boot time, to the 10 ms
 * of /proc/uptime (btime, whole seconds, when that is unreadable). */
function processStart(pid) {
    var bt = bootTime(), text, rest, up;
    try { up = parseFloat(fs.readFileSync(path.join(CFG.proc, 'uptime'), 'utf8')); } catch (e) { up = 0; }
    if (up > 0) bt = nowS() - up;
    if (bt === null) return null;
    try { text = fs.readFileSync(path.join(CFG.proc, String(pid), 'stat'), 'utf8'); } catch (e) { return null; }
    rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
    var ticks = Number(rest[19]);
    return isFinite(ticks) && rest.length > 19 ? bt + ticks / 100 : null;
}
/* oapcontroller counts every death of the app manager's node child as a
 * crash and forgets the count only once the respawned child has stayed up
 * past its alive timer (about 33 s after the respawn). A third death inside
 * that window runs its corrupt-MainApp handling, which deletes every
 * installed app and its data. So a bounce waits until the running child
 * has been up bounceMinUpS and the last bounce (state.json, any
 * invocation) is as long ago; it never refuses, it waits. The same child
 * watched for bounceMinUpS by this process also qualifies, which covers
 * an unreadable start time or a clock that jumped. */
function bounceWait() {
    var min = CFG.bounceMinUpS, watchedPid = null, watchedFrom = 0;
    for (;;) {
        var pid = managerPid();
        if (!pid) return null;
        var t = nowS(), need = 0, why = [], started, lb, w;
        if (pid !== watchedPid) { watchedPid = pid; watchedFrom = monoS(); }
        if (monoS() - watchedFrom >= min) return pid;
        started = processStart(pid);
        if (started === null) { need = min; why.push('its start time is unreadable'); }
        else if (started + min > t) {
            need = started + min - t;
            why.push('it has been up ' + Math.max(0, Math.floor(t - started)) + 's');
        }
        lb = lastBounceAt();
        if (lb && lb + min > t) {
            w = lb + min - t;
            if (w > need) need = w;
            why.push('the last bounce was ' + Math.max(0, Math.floor(t - lb)) + 's ago');
        }
        if (need <= 0) return pid;
        need = Math.min(Math.ceil(need), min);
        say('waiting ' + need + 's before bouncing the app manager (pid ' + pid + '): ' + why.join(', ') +
            '; a bounce needs ' + min + 's of both, since oapcontroller wipes every app on a third crash inside that window');
        sleepMs(need * 1000);
    }
}
/* Bouncing the app manager is killing its node child; oapcontroller
 * respawns it. oapcontroller itself is never stopped or restarted. Every
 * bounce goes through here. */
function bounceManager() {
    var old = bounceWait(), waited = 0, cur;
    if (!old) { warn('app manager node child not found; nothing to bounce'); return false; }
    say('bouncing the app manager node child (pid ' + old + ')');
    recordBounce(Math.ceil(nowS()));
    if (CFG.kill) runOk(CFG.kill, [String(old)]);
    else {
        try { process.kill(old); } catch (e) { throw fail('kill ' + old + ': ' + e.message); }
    }
    while (waited <= CFG.bounceTimeoutMs) {
        cur = managerPid();
        if (cur && cur !== old) { say('app manager respawned (pid ' + cur + ')'); return true; }
        sleepMs(250); waited += 250;
    }
    throw fail('app manager node child did not respawn; check oapcontroller');
}
function bindMounted(file) {
    try {
        return fs.statSync(file).dev !== fs.statSync(path.dirname(file)).dev;
    } catch (e) { return false; }
}

/* ---- recmgr --------------------------------------------------------------- */
/* The restart list is read only at boot. A service can be stopped or
 * restarted only when recmgr loaded its entry (recmgrLoaded); anything else
 * waits for a reboot. Unknown lines and sections round-trip unchanged. */

function recmgrSections(text) {
    var sections = {}, current = null;
    text.split('\n').forEach(function (line) {
        var m = /^\s*\[([^\]]+)\]\s*$/.exec(line), name;
        if (m) { current = m[1]; if (!sections[current]) sections[current] = []; return; }
        name = line.trim();
        if (current && name && name[0] !== '#' && name[0] !== ';') sections[current].push(name);
    });
    return sections;
}
function recmgrText() {
    try { return fs.readFileSync(CFG.recmgr, 'utf8'); } catch (e) { return ''; }
}
function recmgrHas(name, text) {
    var s = recmgrSections(text === undefined ? recmgrText() : text);
    return (s.Whitelist || []).indexOf(name) >= 0 &&
        (s.WhitelistExitSuccess || []).indexOf(name) >= 0;
}
/* A unit without the list (none is known on iDrive 8) has no recmgr to
 * restart it: nothing is written there, and every unit counts as loaded. */
function recmgrPresent() { return !!lstatOrNull(CFG.recmgr); }
/* The rootfs op that writes the list, or null when it is unchanged. */
function recmgrOp(text) {
    return !recmgrPresent() || text === recmgrText() ? null : { type: 'copy', data: text, path: CFG.recmgr, mode: 0o644 };
}
function recmgrPredatesBoot() {
    var bt = bootTime(), st;
    if (bt === null) return FAKE;
    try { st = fs.statSync(CFG.recmgr); } catch (e) { return false; }
    return Math.floor(st.mtime.getTime() / 1000) < bt;
}
/* recmgr loaded the list as it stood at boot: the file itself while it
 * predates the boot, else the copy taken before this boot's first write
 * (rootfsWindow). With neither, nothing counts as loaded. */
function recmgrLoaded(name) {
    if (!recmgrPresent()) return true;
    if (!recmgrHas(name)) return false;
    // The at-boot copy is authoritative whenever it names this boot: the list was
    // changed after recmgr loaded it, so decide from the copy alone. The mtime
    // shortcut applies only when no copy for this boot exists (review M2: btime
    // moves when the clock is corrected, which could otherwise let a list written
    // after recmgr loaded it pass as "loaded").
    var at = readJsonOrNull(RECMGR_AT_BOOT);
    if (at && at.boot === bootId() && typeof at.text === 'string') return recmgrHas(name, at.text);
    return recmgrPredatesBoot();
}
function noteRecmgrAtBoot() {
    if (!recmgrPredatesBoot()) return;
    var at = readJsonOrNull(RECMGR_AT_BOOT);
    if (at && at.boot === bootId()) return;
    writeAtomic(RECMGR_AT_BOOT, JSON.stringify({ boot: bootId(), text: recmgrText() }) + '\n');
}
function recmgrWith(text, addNames, removeNames) {
    var lines = text ? text.split('\n') : [], out = [], current = null, seen = {};
    function flushMissing(section) {
        addNames.forEach(function (n) {
            if (!seen[section + ':' + n]) { out.push(n); seen[section + ':' + n] = true; }
        });
    }
    lines.forEach(function (line) {
        var m = /^\s*\[([^\]]+)\]\s*$/.exec(line), name = line.trim();
        if (m) {
            if (current === 'Whitelist' || current === 'WhitelistExitSuccess') flushMissing(current);
            current = m[1]; out.push(line); return;
        }
        if ((current === 'Whitelist' || current === 'WhitelistExitSuccess') && name) {
            if (removeNames.indexOf(name) >= 0) return;
            seen[current + ':' + name] = true;
        }
        out.push(line);
    });
    if (current === 'Whitelist' || current === 'WhitelistExitSuccess') flushMissing(current);
    ['Whitelist', 'WhitelistExitSuccess'].forEach(function (sec) {
        var missing = addNames.filter(function (n) { return !seen[sec + ':' + n]; });
        if (missing.length && !recmgrSections(text)[sec]) {
            out.push('[' + sec + ']');
            missing.forEach(function (n) { out.push(n); });
        }
    });
    return out.join('\n');
}


/* ---- backups ------------------------------------------------------------ */
/* A snapshot covers every file an operation touches: unit files,
 * enablement links, the recmgr list, preinstalled packages, registry
 * entries, this tool's state and installed files, each tool's current
 * link, and the app manager's main.js as a record (path, checksum,
 * bind-mounted) only. Tool version directories stay in place under the
 * prune rule and app source trees reinstall from their artifacts, so
 * neither is copied into a snapshot. The first snapshot ever taken is
 * also kept as "stock" and never overwritten. */

function snapshotEntry(p) {
    var st = lstatOrNull(p);
    if (!st) return { path: p, kind: 'absent' };
    if (st.isSymbolicLink()) {
        return { path: p, kind: 'symlink', target: fs.readlinkSync(p),
            mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
    }
    if (st.isFile()) {
        return { path: p, kind: 'file', mode: st.mode & 0o7777, uid: st.uid,
            gid: st.gid, sha256: sha256File(p), stored: null };
    }
    return { path: p, kind: 'other', mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
}
/* Stored copies and manifests are root's alone. */
function writeSnapshot(dir, command, paths) {
    var filesDir = path.join(dir, 'files'), manifest = [], n = 0;
    mkdirp(filesDir, 0o700);
    paths.forEach(function (p) {
        /* the copy bound over main.js is not main.js: a snapshot copies
         * main.js only while nothing is bound over it */
        if (p === mainJs() && !FAKE && bindMounted(p)) return;
        var e = snapshotEntry(p);
        if (e.kind === 'file') {
            e.stored = 'files/' + n;
            fs.writeFileSync(path.join(dir, e.stored), fs.readFileSync(p), { mode: 0o600 });
            fs.chmodSync(path.join(dir, e.stored), 0o600);
            n++;
        }
        manifest.push(e);
    });
    var rec = snapshotEntry(mainJs());
    manifest.push({ path: mainJs(), kind: 'record',
        sha256: rec.kind === 'file' ? rec.sha256 : null,
        bind_mounted: bindMounted(mainJs()) });
    writeAtomic(path.join(dir, 'manifest.json'),
        JSON.stringify({ command: command, created: new Date().toISOString(), entries: manifest }, null, 2) + '\n');
    return dir;
}
/* Every snapshot also records the files any command may leave changed:
 * this tool's state, the fallback's unit, link, copy and app list, the
 * recmgr list. The updater owns its sources and credentials. */
function alwaysSnapshotted() {
    return [STATE_FILE, CFG.recmgr, customAppsFile(), FALLBACK_COPY,
        path.join(CFG.systemd, FALLBACK_UNIT),
        path.join(CFG.systemd, 'multi-user.target.wants', FALLBACK_UNIT)];
}
/* The deploy tool's own versions/ and current: no snapshot holds them, so a
 * restore never removes the tool that holds the backups. */
function selfPath(p) {
    return p === path.join(DEPLOY_DIR, 'current') || p.indexOf(path.join(DEPLOY_DIR, 'versions') + '/') === 0;
}
/* Source and credential changes survive every restore, including older
 * manifests that recorded them. */
function updaterStatePath(p) {
    p = path.resolve(p);
    return p === sourcesFile() || p === credentialsDir() || p.indexOf(credentialsDir() + '/') === 0;
}
function snapshotPaths(paths) {
    var uniq = [], seen = {};
    paths.concat(alwaysSnapshotted()).forEach(function (p) {
        if (!seen[p] && !selfPath(p) && !updaterStatePath(p)) { seen[p] = true; uniq.push(p); }
    });
    return uniq;
}
/* The first snapshot ever is also kept as "stock". A command that takes
 * several snapshots (one per artifact) writes stock first, over all of
 * them. */
function ensureStock(command, paths) {
    mkdirp(BACKUPS_DIR, 0o700);
    fs.chmodSync(BACKUPS_DIR, 0o700);
    var stock = path.join(BACKUPS_DIR, 'stock');
    if (fs.existsSync(stock)) return;
    writeSnapshot(stock, command, snapshotPaths(paths));
    say('stock snapshot: ' + stock);
}
function takeSnapshot(command, paths) {
    ensureStock(command, paths);
    var base = path.join(BACKUPS_DIR, timestamp() + '-' + command), dir = base, n = 1;
    while (fs.existsSync(dir)) dir = base + '-' + (++n);
    snapshotsTaken.push(path.basename(dir));
    dir = writeSnapshot(dir, command, snapshotPaths(paths));
    say('backup: ' + dir);
    return dir;
}
function isRootfsPath(p) {
    if (FAKE) return false;
    return p.indexOf(CFG.varOpt + '/') !== 0 && p !== CFG.varOpt;
}
function putBackEntry(dir, e) {
    if (e.kind === 'record' || e.kind === 'other') return;
    if (e.kind === 'absent') { rmrf(e.path); return; }
    mkdirp(path.dirname(e.path));
    rmrf(e.path);
    if (e.kind === 'symlink') { fs.symlinkSync(e.target, e.path); return; }
    fs.writeFileSync(e.path, fs.readFileSync(path.join(dir, e.stored)), { mode: 0o600 });
    fs.chmodSync(e.path, e.mode);
    chownMaybe(e.path, e.uid, e.gid);
}
function entryMatches(e) {
    var now = snapshotEntry(e.path);
    if (e.kind !== now.kind) return false;
    if (e.kind === 'absent') return true;
    if (e.kind === 'symlink') return e.target === now.target;
    if (e.kind === 'file') return e.sha256 === now.sha256 && e.mode === now.mode && (FAKE || e.uid === now.uid);
    return true;
}
/* Rootfs entries go back through one trapped window; the rest directly.
 * An entry already as recorded is left alone, so a snapshot of an
 * unchanged state restores without opening the window. The bounce record
 * outlives the restore. */
function restoreSnapshot(dir) {
    var data = readJson(path.join(dir, 'manifest.json'));
    var rootEntries = [], plain = [], lb = lastBounceAt();
    /* A snapshot holding main.js itself compares and restores the file
     * under the fallback copy; the caller binds the copy again. */
    if (!FAKE && bindMounted(mainJs()) &&
        data.entries.some(function (e) { return e.path === mainJs() && e.kind === 'file'; })) {
        runOk(CFG.umount, [mainJs()]);
    }
    data.entries.forEach(function (e) {
        if (e.kind === 'record' || selfPath(e.path) || updaterStatePath(e.path) || entryMatches(e)) return;
        (isRootfsPath(e.path) ? rootEntries : plain).push(e);
    });
    plain.forEach(function (e) { putBackEntry(dir, e); });
    if (rootEntries.length) {
        var ops = rootEntries.map(function (e) {
            if (e.kind === 'absent') return { type: 'delete', path: e.path };
            if (e.kind === 'symlink') return { type: 'symlink', path: e.path, target: e.target };
            return { type: 'copy', src: path.join(dir, e.stored), path: e.path, mode: e.mode, uid: e.uid, gid: e.gid };
        });
        rootfsWindow(ops);
    }
    if (lb) recordBounce(lb);
    return data;
}
function verifySnapshot(dir) {
    var data = readJson(path.join(dir, 'manifest.json')), bad = [];
    data.entries.forEach(function (e) {
        /* rewritten after every restore: the state, and the fallback copy
         * rebuilt from the stock file */
        if (e.path === STATE_FILE || e.path === FALLBACK_COPY || selfPath(e.path) || updaterStatePath(e.path)) return;
        if (e.kind === 'file') {
            try { if (sha256File(e.path) !== e.sha256) bad.push(e.path); }
            catch (err) { bad.push(e.path); }
        } else if (e.kind === 'absent' && fs.existsSync(e.path)) bad.push(e.path);
        else if (e.kind === 'symlink') {
            try { if (fs.readlinkSync(e.path) !== e.target) bad.push(e.path); }
            catch (err) { bad.push(e.path); }
        }
    });
    return bad;
}

/* Runs when the command ends, after any rollback from its snapshots. The
 * run's own snapshots stay even when the clock has gone back behind older
 * names. */
var snapshotsTaken = [];
function pruneBackups() {
    var older = fs.readdirSync(BACKUPS_DIR).filter(function (n) {
        return n !== 'stock' && snapshotsTaken.indexOf(n) < 0;
    }).sort();
    older.slice(0, Math.max(0, older.length - Math.max(0, KEEP_BACKUPS - snapshotsTaken.length))).forEach(function (n) {
        rmrf(path.join(BACKUPS_DIR, n));
    });
}

/* ---- one run at a time ------------------------------------------------------ */
/* A changing command waits for the lock, which names its holder's pid and
 * boot; a holder that is gone, from an earlier boot, or this pid no longer
 * holds it. The lock appears whole (linked from a written file), and only
 * the holder of LOCK_BREAK removes a stale one, after reading it again. */
var LOCK_BREAK = LOCK_FILE + '.break';
function lockState() {
    var f;
    try { f = fs.readFileSync(LOCK_FILE, 'utf8').trim().split(' '); } catch (e) { return { free: true }; }
    var pid = Number(f[0]), live = !!pid && pid !== process.pid && f[1] === String(bootId());
    if (live) { try { process.kill(pid, 0); } catch (e) { live = e.code === 'EPERM'; } }
    return { pid: pid, live: live };
}
function breakStaleLock() {
    try { fs.writeFileSync(LOCK_BREAK, String(process.pid), { flag: 'wx' }); }
    catch (e) {
        if (e.code !== 'EEXIST') throw e;
        var brk = lstatOrNull(LOCK_BREAK);
        if (brk && Date.now() - brk.mtime.getTime() > 30000) rmrf(LOCK_BREAK);
        return;
    }
    try {
        var st = lockState();
        if (!st.free && !st.live) fs.unlinkSync(LOCK_FILE);
    } finally { rmrf(LOCK_BREAK); }
}
function acquireLock() {
    var waited = 0, said = false, mine = LOCK_FILE + '.' + process.pid, st;
    mkdirp(DEPLOY_DIR);
    fs.writeFileSync(mine, process.pid + ' ' + bootId() + '\n', { mode: 0o600 });
    try {
        for (;;) {
            try { fs.linkSync(mine, LOCK_FILE); return; } catch (e) { if (e.code !== 'EEXIST') throw e; }
            st = lockState();
            if (st.free) continue;
            if (!st.live) { breakStaleLock(); sleepMs(100); continue; }
            if (waited >= CFG.lockWaitMs) throw refuse('another mgu-deploy run (pid ' + st.pid + ') is still changing the unit');
            if (!said) { say('waiting for the mgu-deploy run with pid ' + st.pid + ' to finish'); said = true; }
            sleepMs(1000); waited += 1000;
        }
    } finally { rmrf(mine); }
}
/* Files a killed run left: its staging, rootfs-window and temp files (named
 * after its pid, gone now), its in-place request, and a deploy/hu kit
 * folder a day old. */
var RUN_TEMP = /^(?:stage-|window-|main\.fallback-|lock\.|\.mgu-deploy-probe-)(\d+)(?:\.sh|\.js)?$|^write-(\d+)-\d+$|\.(?:tmp|partial|old)-(\d+)$/;
function pidAlive(pid) {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function cleanStale() {
    var dirs = [CFG.varOpt, DEPLOY_DIR, INPLACE_DIR, updaterDir(), credentialsDir(), path.dirname(customAppsFile())];
    rmrf(INPLACE_REQUEST);
    fs.readdirSync(CFG.varOpt).forEach(function (n) {
        if (n !== 'public' && fs.existsSync(path.join(CFG.varOpt, n, 'versions'))) dirs.push(path.join(CFG.varOpt, n, 'versions'));
    });
    dirs.forEach(function (d) {
        if (!fs.existsSync(d)) return;
        fs.readdirSync(d).forEach(function (n) {
            var m = RUN_TEMP.exec(n), pid = m && Number(m[1] || m[2] || m[3]);
            if (pid && !pidAlive(pid)) rmrf(path.join(d, n));
        });
    });
    fs.readdirSync(CFG.varOpt).forEach(function (n) {
        var p = path.join(CFG.varOpt, n), st = /^mgu-deploy-kit-\d+$/.test(n) && p !== HERE && lstatOrNull(p);
        if (st && Date.now() - st.mtime.getTime() > 86400000) rmrf(p);
    });
}
function releaseLock() {
    try { if (fs.readFileSync(LOCK_FILE, 'utf8').split(' ')[0] === String(process.pid)) fs.unlinkSync(LOCK_FILE); }
    catch (e) { /* not held */ }
}

/* ---- trapped rootfs window ------------------------------------------------ */
/* One sh script per operation remounts / read-write, applies the staged
 * writes, and remounts read-only on any exit. A root filesystem found
 * read-write stays read-write. In fake-root mode the writes are plain. */

/* An op with `data` instead of `src` is staged under DEPLOY_DIR for the
 * window and removed after it. */
function rootfsWindow(ops) {
    var staged = [];
    if (ops.some(function (op) { return op.path === CFG.recmgr; })) noteRecmgrAtBoot();
    ops.forEach(function (op, i) {
        if (op.data === undefined) return;
        mkdirp(DEPLOY_DIR);
        op.src = path.join(DEPLOY_DIR, 'write-' + process.pid + '-' + i);
        fs.writeFileSync(op.src, op.data);
        staged.push(op.src);
    });
    try { rootfsWindowRun(ops); }
    finally { staged.forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { /* staged */ } }); }
}
function rootfsWindowRun(ops) {
    if (!ops.length) return;
    if (FAKE) {
        ops.forEach(function (op) {
            if (op.type === 'delete') rmrf(op.path);
            else if (op.type === 'mkdir') mkdirp(op.path, op.mode || 0o755);
            else if (op.type === 'rmdir') fs.rmdirSync(op.path);
            else if (op.type === 'symlink') { mkdirp(path.dirname(op.path)); rmrf(op.path); fs.symlinkSync(op.target, op.path); }
            else if (op.type === 'copy') { mkdirp(path.dirname(op.path)); fs.writeFileSync(op.path, fs.readFileSync(op.src)); if (op.mode !== undefined) fs.chmodSync(op.path, op.mode); }
        });
        return;
    }
    var before = rootMountMode(), lines = ['set -e'];
    if (before === 'rw') {
        say('/ is read-write; leaving it as found');
    } else {
        lines.push("trap 'sync; " + CFG.mount + " -o remount,ro /' EXIT INT TERM HUP");
        lines.push(CFG.mount + ' -o remount,rw /');
    }
    ops.forEach(function (op) {
        var d = shQuote(path.dirname(op.path)), p = shQuote(op.path);
        if (op.type === 'delete') lines.push('rm -rf ' + p);
        else if (op.type === 'mkdir') lines.push('mkdir -p ' + p);
        else if (op.type === 'rmdir') lines.push('rmdir ' + p);
        else if (op.type === 'symlink') lines.push('mkdir -p ' + d + '; rm -rf ' + p + '; ln -s ' + shQuote(op.target) + ' ' + p);
        else if (op.type === 'copy') {
            lines.push('mkdir -p ' + d + '; cat ' + shQuote(op.src) + ' > ' + p + '.tmp-' + process.pid);
            if (op.mode !== undefined) lines.push('chmod ' + (op.mode & 0o7777).toString(8) + ' ' + p + '.tmp-' + process.pid);
            if (op.uid !== undefined) lines.push('chown ' + op.uid + ':' + op.gid + ' ' + p + '.tmp-' + process.pid);
            lines.push('mv ' + p + '.tmp-' + process.pid + ' ' + p);
        }
    });
    lines.push('sync');
    var stage = path.join(DEPLOY_DIR, 'window-' + process.pid + '.sh');
    mkdirp(DEPLOY_DIR);
    fs.writeFileSync(stage, lines.join('\n') + '\n');
    try { runOk(CFG.sh, [stage]); }
    finally { try { fs.unlinkSync(stage); } catch (e) { /* staged script */ } }
    if (before !== 'rw' && rootMountMode() !== 'ro') {
        throw fail('/ is NOT read-only after the rootfs window; run: mount -o remount,ro /');
    }
}

/* ---- artifacts ------------------------------------------------------------ */

function stageDir() {
    var d = path.join(DEPLOY_DIR, 'stage-' + process.pid);
    rmrf(d); mkdirp(d);
    return d;
}
function safeRel(p) {
    return typeof p === 'string' && p && p[0] !== '/' && p !== '.' &&
        p.split('/').indexOf('..') < 0 && p.indexOf('\\') < 0;
}
/* Extracts and validates one artifact without changing anything outside
 * the staging directory. Returns a tool or app descriptor. */
function validateArtifact(file, stage) {
    if (!fs.existsSync(file)) throw refuse('artifact not found: ' + file);
    var list = run(CFG.tar, ['-tzf', file], { allowFail: true });
    if (list.status !== 0) throw refuse('unreadable tgz: ' + file);
    list.stdout.split('\n').forEach(function (n) {
        // "./": the archive's own root, as tar -C <dir> . packs it
        if (n && n !== './' && !safeRel(n.replace(/\/$/, ''))) throw refuse('unsafe path in ' + file + ': ' + n);
    });
    var dir = path.join(stage, 'a' + Math.floor(Math.random() * 1e9));
    mkdirp(dir);
    var x = run(CFG.tar, ['-xzf', file, '-C', dir], { allowFail: true });
    // its listing read the whole archive: this is the unit's failure (space, I/O)
    if (x.status !== 0) throw fail('cannot extract ' + file + ': ' + (x.stderr || '').trim());
    walk(dir, '', []).forEach(function (e) {
        if (e.stat.isSymbolicLink()) throw refuse('symlink in artifact: ' + e.rel);
        if (!e.stat.isFile() && !e.stat.isDirectory()) throw refuse('special file in artifact: ' + e.rel);
        if (e.stat.isFile() && e.stat.nlink > 1) throw refuse('hardlink in artifact: ' + e.rel);
    });
    if (fs.existsSync(path.join(dir, 'component.json'))) return validateTool(file, dir, readJsonOrNull(path.join(dir, 'component.json')));
    if (fs.existsSync(path.join(dir, 'mgu-app.json'))) return validateSource(file, dir);
    if (fs.existsSync(path.join(dir, 'package.json'))) return validateApp(file, dir, dir);
    /* an npm-format package, its files under package/ */
    if (fs.existsSync(path.join(dir, 'package', 'package.json'))) return validateApp(file, dir, path.join(dir, 'package'));
    /* a .mgu: meta.json, the package as source/ (with its rhmiData), the
     * installed rhmiData/ and oapgen/, which the manager makes itself */
    if (fs.existsSync(path.join(dir, 'meta.json')) && fs.existsSync(path.join(dir, 'source', 'package.json'))) {
        var a = validateApp(file, dir, path.join(dir, 'source')), meta = readJsonOrNull(path.join(dir, 'meta.json'));
        if (!meta || meta.id !== a.id || meta.version !== a.version) {
            throw refuse(file + ': meta.json names ' + (meta ? meta.id + ' ' + meta.version : 'nothing readable') +
                ', source/package.json ' + a.id + ' ' + a.version);
        }
        return a;
    }
    throw refuse(file + ': no component.json, mgu-app.json, package.json, package/package.json or .mgu layout at its root');
}
function validateTool(file, dir, c) {
    if (!c || typeof c !== 'object') throw refuse(file + ': component.json does not parse');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id || '')) throw refuse(file + ': bad id ' + c.id);
    if (!semverParts(c.version)) throw refuse(file + ': version is not x.y.z: ' + c.version);
    if (c.kind !== 'tool') throw refuse(file + ': kind is not "tool"');
    if (!Array.isArray(c.files)) throw refuse(file + ': files[] missing');
    c.files.forEach(function (f) {
        if (!safeRel(f.path)) throw refuse(file + ': bad files[].path ' + f.path);
        if (octalMode(f.mode) === null) throw refuse(file + ': bad mode for ' + f.path);
        if (!/^[0-9a-f]{64}$/.test(f.sha256 || '')) throw refuse(file + ': missing sha256 for ' + f.path);
        var payload = path.join(dir, 'files', f.path);
        if (!lstatOrNull(payload) || !lstatOrNull(payload).isFile()) throw refuse(file + ': payload missing files/' + f.path);
        if (sha256File(payload) !== f.sha256) throw refuse(file + ': sha256 mismatch for ' + f.path);
    });
    (c.units || []).forEach(function (u) {
        if (!safeRel(u.name) || u.name.indexOf('/') >= 0) throw refuse(file + ': bad unit name ' + u.name);
        if (!fs.existsSync(path.join(dir, 'units', u.name))) throw refuse(file + ': payload missing units/' + u.name);
    });
    (c.enable || []).forEach(function (en) {
        if (!safeRel(en.unit) || !safeRel(en.target)) throw refuse(file + ': bad enable entry');
    });
    if (c.dropins !== undefined && !Array.isArray(c.dropins)) throw refuse(file + ': dropins is not a list');
    (c.dropins || []).forEach(function (d) {
        if (!d || !DROPIN_UNIT.test(d.unit || '') || !DROPIN_NAME.test(d.name || '')) throw refuse(file + ': bad dropins entry');
        if (!fs.existsSync(path.join(dir, 'dropins', d.unit + '.d', d.name))) {
            throw refuse(file + ': payload missing dropins/' + d.unit + '.d/' + d.name);
        }
    });
    if (c.internet !== undefined && (c.internet !== true || !Array.isArray(c.uids) || !c.uids.length ||
        !c.uids.every(function (u) { return u === Math.floor(u) && u > 0; }))) {
        throw refuse(file + ': "internet": true needs "uids", the tool\'s numeric uids');
    }
    (c.recmgr || []).concat(c.restart || []).forEach(function (n) {
        if (typeof n !== 'string' || !n) throw refuse(file + ': bad recmgr/restart entry');
        if (n === 'oapcontroller' || n === 'oapcontroller.service') throw refuse(file + ': oapcontroller is never restarted');
    });
    if (c.mguProvides !== undefined && !PROVIDES.test(c.mguProvides)) {
        throw refuse(file + ': mguProvides is one lower-case name, e.g. "renderer"');
    }
    if (c.keepRunning !== undefined && typeof c.keepRunning !== 'boolean') throw refuse(file + ': keepRunning is true or false');
    return { kind: 'tool', file: file, dir: dir, component: c, id: c.id, version: c.version,
        hmi: hmiList(c.mguHmi, file + ' component.json'), hmiFrom: c.mguHmi ? 'declared' : null,
        provides: c.mguProvides || null };
}
/* An OAP package in pkgDir, or a root-service package (mguService). An app
 * that is not the flat tgz the manager installs as it is (files at the
 * root, "mguLocalOnly": true, no require('oap-sdk') left unanswered) is
 * prepared first (prepareApp). */
function validateApp(file, dir, pkgDir) {
    var pkg;
    try { pkg = readJson(path.join(pkgDir, 'package.json')); }
    catch (e) { throw refuse(file + ': package.json does not parse'); }
    if (pkg && pkg.mguService !== undefined) return validateService(file, dir, pkgDir, pkg);
    if (pkg && pkg.name === AM.app) throw refuse(file + ': ' + AM.app + " is IterioDev's App Manager, which the Store replaces");
    checkPkg(file, pkg);
    var a = { kind: 'app', file: file, dir: dir, pkgDir: pkgDir, pkg: pkg, id: pkg.name, version: pkg.version };
    a.prepare = pkgDir !== dir || pkg.mguLocalOnly !== true || linker().needsSdk(pkgDir) ? 'package' : null;
    appHmi(a, file, pkg.mguHmi, [path.join(pkgDir, 'rhmiData'), path.join(dir, 'rhmiData')]);
    return a;
}

/* ---- compatibility (mguHmi) ----------------------------------------------------- */
/* A component may say which head units it is for: "mguHmi": ["ID7"],
 * ["ID8"] or both, in an app's package.json or mgu-app.json, or a tool's
 * component.json. An app that does not say is taken to be for the HMIs its
 * rhmiData has a UI for. Installing one that is not for this unit is
 * refused; one that says nothing either way installs. */
var HMIS = ['ID7', 'ID8'];
function hmiList(v, where) {
    if (v === undefined) return null;
    if (!Array.isArray(v) || !v.length || v.some(function (h, i) { return HMIS.indexOf(h) < 0 || v.indexOf(h) !== i; })) {
        throw refuse(where + ': mguHmi must list "ID7" and/or "ID8"');
    }
    return v.slice().sort();
}
/* The HMIs an rhmiData folder has a UI for: application.json's
 * uiDescriptions[].hmi, else the folders under uiDescriptions/; null when
 * it names none. */
function rhmiHmis(rhmiDir) {
    var out = [], app = readJsonOrNull(path.join(rhmiDir, 'application.json'));
    var uis = app && app.application && Array.isArray(app.application.uiDescriptions) ? app.application.uiDescriptions : [];
    uis.forEach(function (u) {
        (u && Array.isArray(u.hmi) ? u.hmi : []).forEach(function (h) { if (HMIS.indexOf(h) >= 0 && out.indexOf(h) < 0) out.push(h); });
    });
    if (!out.length) {
        try {
            fs.readdirSync(path.join(rhmiDir, 'uiDescriptions')).forEach(function (n) {
                var st = lstatOrNull(path.join(rhmiDir, 'uiDescriptions', n));
                if (HMIS.indexOf(n) >= 0 && st && st.isDirectory()) out.push(n);
            });
        } catch (e) { /* no uiDescriptions */ }
    }
    return out.length ? out.sort() : null;
}
function appHmi(a, file, declared, rhmiDirs) {
    a.hmi = hmiList(declared, file);
    a.hmiFrom = a.hmi ? 'declared' : null;
    for (var i = 0; !a.hmi && i < rhmiDirs.length; i++) {
        a.hmi = rhmiHmis(rhmiDirs[i]);
        if (a.hmi) a.hmiFrom = 'rhmiData';
    }
}
/* Why a is not for this unit, or null. */
function incompatible(a) {
    var unit = unitInfo().hmi;
    if (!a.hmi || !unit || a.hmi.indexOf(unit) >= 0) return null;
    return a.id + ' ' + a.version + ' is for ' + a.hmi.map(hmiName).join(' and ') +
        (a.hmiFrom === 'rhmiData' ? ' (its rhmiData)' : '') + '; this head unit is ' + hmiName(unit);
}

/* ---- capabilities (mguProvides) --------------------------------------------------- */
/* A tool may say which capability it provides, such as "renderer"; a
 * service package provides its kind. Providers of one capability install
 * side by side (each renderer keeps to its own socket and ivi ids, and
 * mgu-render leaves the community socket to another installed renderer). */
var PROVIDES = /^[a-z0-9][a-z0-9-]{0,31}$/;
/* A tool's drop-in for a unit it does not own (component.json "dropins":
 * [{unit, name}], payload dropins/<unit>.d/<name>): it goes to
 * <systemd>/<unit>.d/<name>, a folder the tool creates when missing. */
var DROPIN_UNIT = /^[A-Za-z0-9_.@-]{1,100}\.(service|socket|target|mount|path|timer)$/;
var DROPIN_NAME = /^[A-Za-z0-9_.@-]{1,100}\.conf$/;
function dropinPath(d) { return path.join(CFG.systemd, d.unit + '.d', d.name); }
/* A unit of c that is on the unit but that no installed tool of ours
 * lists, such as IterioDev's App Manager's mgu-renderd.service: a tool
 * that writes it would fight that manager over it. */
function foreignUnit(c) {
    var tools = installedTools();
    var unit = (c.units || []).map(function (u) { return u.name; }).filter(function (name) {
        var p = path.join(CFG.systemd, name);
        return lstatOrNull(p) && !i7Written(p) && !tools.some(function (t) {
            return (t.component.units || []).some(function (u) { return u.name === name; });
        });
    })[0];
    var dropin = (c.dropins || []).filter(function (d) {
        return lstatOrNull(dropinPath(d)) && !i7Written(dropinPath(d)) && !tools.some(function (t) {
            return (t.component.dropins || []).some(function (x) { return x.unit === d.unit && x.name === d.name; });
        });
    })[0];
    return unit || (dropin ? d2s(dropin) : null);
}
function d2s(d) { return d.unit + '.d/' + d.name; }

/* ---- idrive7-apps' own installer -------------------------------------------------- */
/* idrive7-apps' installer (deploy/mgu-app-install.sh in that repository)
 * starts every unit and drop-in it writes with I7_MARK. It installs:
 *   renderer  /var/opt/mgu-renderd/mgu-renderd, mgu-renderd.service enabled
 *             for oapcontroller.service, serving /run/mgu-renderd/renderd.sock
 *   gate      mgu-inputgate-guard.service, mgu-inputgate-check.service,
 *             hmi.service.d/zz-mgu-inputgate.conf, and in /var/opt/mgu-renderd
 *             mgu-inputgate.so, inputgate-guard.sh, inputgate.env,
 *             inputgate.strikes
 * A tool of ours takes them over: one with a unit or drop-in of the same
 * name writes over it, and its gate files go with it; one whose unit serves
 * the community socket's folder (RuntimeDirectory=mgu-renderd) replaces the
 * renderer, which runs on until the next boot. */
var I7_MARK = '# added by mgu-app-install.sh';
var I7_DIR = path.join(CFG.varOpt, 'mgu-renderd');
var I7_RENDERER_UNIT = 'mgu-renderd.service';
var I7_GATE_UNIT = 'mgu-inputgate-guard.service';
var I7_GATE_FILES = ['mgu-inputgate.so', 'inputgate-guard.sh', 'inputgate.env', 'inputgate.strikes'];
function i7Written(p) {
    var st = lstatOrNull(p), fd, b = Buffer.alloc(I7_MARK.length);
    if (!st || !st.isFile()) return false;
    try { fd = fs.openSync(p, 'r'); fs.readSync(fd, b, 0, b.length, 0); } catch (e) { return false; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return b.toString('utf8') === I7_MARK;
}
/* The apps idrive7-apps' installer put on the unit. status --json names
 * them (idrive7) for the updater, which gives them their origin. */
function i7Apps(state) {
    var custom = readCustomApps(), ours = (state && state.apps) || {};
    return installedApps().filter(function (a) {
        return Object.prototype.hasOwnProperty.call(custom, a.id) && !ours[a.id] &&
            fs.existsSync(path.join(appHome(a.uid), 'source', 'javascript', 'kit', 'app-spec.json'));
    }).map(function (a) { return { id: a.id, version: a.version }; });
}
/* What installing tool a takes over: { paths } it changes, { units }
 * of theirs it removes, { files } in I7_DIR it removes. */
function i7Takeover(a) {
    var c = a.component, out = { units: [], files: [], paths: [] };
    if (!c || a.kind !== 'tool') return out;
    var serves = (c.units || []).some(function (u) {
        try { return /^RuntimeDirectory=mgu-renderd\s*$/m.test(fs.readFileSync(path.join(a.dir, 'units', u.name), 'utf8')); }
        catch (e) { return false; }
    });
    var ours = function (name) { return (c.units || []).some(function (u) { return u.name === name; }); };
    if (serves && i7Written(path.join(CFG.systemd, I7_RENDERER_UNIT))) {
        /* a unit of the same name is written over; its enablement goes */
        if (!ours(I7_RENDERER_UNIT)) out.units.push(I7_RENDERER_UNIT);
        out.units.push('oapcontroller.service.wants/' + I7_RENDERER_UNIT);
        out.files.push('mgu-renderd');
    }
    if (ours(I7_GATE_UNIT) && i7Written(path.join(CFG.systemd, I7_GATE_UNIT))) out.files = out.files.concat(I7_GATE_FILES);
    out.files = out.files.filter(function (f) { return !!lstatOrNull(path.join(I7_DIR, f)); });
    out.units = out.units.filter(function (u) { return !!lstatOrNull(path.join(CFG.systemd, u)); });
    out.paths = out.units.map(function (u) { return path.join(CFG.systemd, u); })
        .concat(out.files.map(function (f) { return path.join(I7_DIR, f); }));
    return out;
}

/* ---- root-service packages (mguService) ------------------------------------------ */
/* IterioDev's App Manager installs two root services as packages
 * (github.com/IterioDev/mgu-app-store, appmanager-service/services.js and
 * pkg.js): an npm-format tgz holding package.json { name, version,
 * mguService } and the program under its name, an x86-64 program.
 *   renderer  mgu-renderd: draws renderer apps' screens over the HMI;
 *             enabled, runs from boot
 *   tether    ipheth-tether: iPhone USB tether; refused, mgu-uplink drives
 *             the iPhone
 * A renderer package becomes a tool here: the program and package.json in
 * /var/opt/<name>/versions/<version>/, the unit his App Manager writes
 * (root, as there) running current/<name>, its recmgr entry, and the
 * tool rules for starting, updating and removing it. */
var SERVICES = {
    renderer: { name: 'mgu-renderd', title: 'GPU renderer' },
    tether: { name: 'ipheth-tether', title: 'iPhone tether' }
};
var SERVICE_MAX = 16 << 20;
/* The renderer's touch routing takes the HMI's touch PDUs on iDrive 8
 * (UDP 30567 into Hmi8), the app area there being 0,76,2880,764; on any
 * other unit it runs without touch routing. */
function serviceUnit(bin) {
    var touch = unitInfo().hmi === 'ID8' ?
        ' --touch ' + (fs.existsSync(CFG.vminput) ? 'vm' : 'car') + ' --touch-area 0,76,2880,764' : '';
    return ['# GPU renderer for custom apps (mgu-renderd), installed by mgu-deploy: draws renderer apps\' screens over the HMI.',
        '[Unit]', 'Description=GPU renderer for custom apps (mgu-renderd)', 'RequiresMountsFor=/var/opt', 'After=winston.service', '',
        '[Service]', 'Environment=XDG_RUNTIME_DIR=/run/wayland WAYLAND_DISPLAY=wayland-0',
        'ExecStartPre=/bin/sh -c \'i=0; while [ ! -S /run/wayland/wayland-0 ]; do i=$$((i+1)); [ $$i -gt 120 ] && exit 1; sleep 1; done\'',
        'ExecStart=' + bin + ' --socket /run/mgu-renderd/renderd.sock' + touch]
        .concat(touch ? ['ExecStopPost=-/bin/sh -c \'nft delete table ip touchroute 2>/dev/null; true\''] : [])
        .concat(['RuntimeDirectory=mgu-renderd', 'RuntimeDirectoryMode=0755', 'Restart=always', 'RestartSec=3',
            'TimeoutStartSec=150', 'TimeoutStopSec=5', '', '[Install]', 'WantedBy=late.target', '']).join('\n');
}
function validateService(file, dir, pkgDir, pkg) {
    var s = SERVICES[pkg.mguService], kind = pkg.mguService;
    if (!s) throw refuse(file + ': unknown mguService ' + String(kind).slice(0, 40) + ' (renderer or tether)');
    if (pkg.name !== s.name) throw refuse(file + ': a ' + kind + ' package is named ' + s.name + ', not ' + pkg.name);
    if (kind === 'tether') throw refuse(file + ': the iPhone tether is replaced by mgu-uplink, which drives the iPhone');
    if (!semverParts(pkg.version)) throw refuse(file + ': version is not x.y.z: ' + pkg.version);
    var bin = path.join(pkgDir, s.name), st = lstatOrNull(bin), head = Buffer.alloc(64), fd;
    if (!st || !st.isFile()) throw refuse(file + ': no ' + s.name + ' program beside its package.json');
    if (st.size > SERVICE_MAX) throw refuse(file + ': ' + s.name + ' is over ' + (SERVICE_MAX >> 20) + ' MiB');
    fd = fs.openSync(bin, 'r');
    try { fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
    if (st.size < 64 || head.readUInt32BE(0) !== 0x7f454c46 || head[4] !== 2 || head.readUInt16LE(18) !== 0x3e) {
        throw refuse(file + ': ' + s.name + ' is not an x86-64 program');
    }
    var hmi = hmiList(pkg.mguHmi, file + ' package.json'), unit = s.name + '.service';
    var kit = path.join(path.dirname(dir), 'svc' + Math.floor(Math.random() * 1e9));
    mkdirp(path.join(kit, 'files')); mkdirp(path.join(kit, 'units'));
    fs.writeFileSync(path.join(kit, 'files', s.name), fs.readFileSync(bin));
    fs.writeFileSync(path.join(kit, 'files', 'package.json'), fs.readFileSync(path.join(pkgDir, 'package.json')));
    fs.writeFileSync(path.join(kit, 'units', unit), serviceUnit(path.join(CFG.varOpt, s.name, 'current', s.name)));
    var c = { id: s.name, kind: 'tool', version: pkg.version,
        title: typeof pkg.productName === 'string' && pkg.productName ? pkg.productName : s.title,
        description: typeof pkg.description === 'string' ? pkg.description : '', mguService: kind,
        files: [{ path: s.name, mode: '0755', sha256: sha256File(path.join(kit, 'files', s.name)) },
            { path: 'package.json', mode: '0644', sha256: sha256File(path.join(kit, 'files', 'package.json')) }],
        units: [{ name: unit }], enable: [{ unit: unit, target: 'late.target' }],
        recmgr: [s.name], restart: [unit], mguProvides: kind,
        /* as his App Manager does: a running renderer is not stopped by an update */
        keepRunning: true };
    if (hmi) c.mguHmi = hmi;
    fs.writeFileSync(path.join(kit, 'component.json'), JSON.stringify(c, null, 2) + '\n');
    var a = validateTool(file, kit, c);
    a.service = kind;
    return a;
}
function checkPkg(file, pkg) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg.name || '')) throw refuse(file + ': bad app name ' + pkg.name);
    if (!semverParts(pkg.version)) throw refuse(file + ': version is not x.y.z: ' + pkg.version);
    if (pkg.mguAppStartType !== undefined && START_TYPES.indexOf(pkg.mguAppStartType) < 0) {
        throw refuse(file + ': mguAppStartType is not one of ' + START_TYPES.join(', ') + ': ' + pkg.mguAppStartType);
    }
}
/* A source package: built into an OAP package by prepareApp. */
function validateSource(file, dir) {
    var m;
    try { m = linker().readManifest(dir); } catch (e) { throw refuse(file + ': ' + e.message); }
    var pkg = readJson(path.join(dir, m.tree, 'package.json'));
    checkPkg(file, pkg);
    var a = { kind: 'app', file: file, dir: dir, pkgDir: null, pkg: pkg, id: m.id, version: m.version, prepare: 'build' };
    var raw = readJsonOrNull(path.join(dir, 'mgu-app.json')) || {};
    appHmi(a, file, raw.mguHmi !== undefined ? raw.mguHmi : pkg.mguHmi, [path.join(dir, m.tree, 'rhmiData')]);
    return a;
}
/* The donor bundles on this unit, in search order (oap_link.js). */
function unitDonors() {
    return linker().unitDonors(mainappRoot(), CFG.oap,
        { localOnlyFile: localOnlyFile(), customAppsFile: customAppsFile(), exclude: isId8() ? dasApps() : [] });
}
/* Turns a source package or a package that is not ready into the flat,
 * marked OAP tgz in the staging folder, and validates that as the app.
 * Nothing outside the staging folder changes; a package that cannot be
 * prepared (no donor holds the oap-sdk it needs, a module that does not
 * compile) is refused. */
/* System errors that are the unit's (space, I/O, limits), not a package's. */
var ENV_ERRORS = ['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EMFILE', 'ENFILE', 'ENOMEM', 'EACCES', 'EPERM', 'EBUSY'];
function prepareApp(a, stage) {
    if (!a.prepare) return a;
    var out = path.join(stage, 'built-' + a.id + '@' + a.version + '.tgz'), r, link = linker();
    try {
        if (a.prepare === 'build') {
            r = link.build(a.dir, out, { donors: unitDonors(), workDir: stage });
            say('built ' + a.id + ' ' + a.version + ' from its source package (' + r.moduleCount +
                ' modules, oap-sdk from ' + r.donor + (r.entry ? ', main from ' + r.entry : '') + ')');
        } else {
            r = link.preparePackage(a.pkgDir, out, { donors: unitDonors() });
            say('prepared ' + a.id + ' ' + a.version + ': marked local-only' +
                (r.sdk ? ', node_modules/oap-sdk generated from ' + r.sdk.donor + ' (' + r.sdk.api.join(', ') + ')' : '') +
                (r.shrinkwrap ? ', npm-shrinkwrap.json added' : '') +
                (r.permissions.length ? ', ' + r.permissions.join(' and ') + ' added to permissions.json' : ''));
        }
    } catch (e) {
        if (ENV_ERRORS.indexOf(e.code) >= 0) throw e;
        throw refuse(a.file + ': cannot ' + (a.prepare === 'build' ? 'build ' : 'prepare ') + a.id + ' ' + a.version +
            ' on this unit: ' + e.message);
    }
    var b = validateArtifact(out, stage);
    if (b.kind !== 'app' || b.prepare || b.id !== a.id || b.version !== a.version) {
        throw refuse(a.file + ': the prepared package is not ' + a.id + ' ' + a.version);
    }
    b.file = out;
    b.from = a.file;
    return b;
}
function kitArtifacts() {
    var d = env('MGU_DEPLOY_ARTIFACTS', path.join(HERE, 'artifacts'));
    if (!fs.existsSync(d)) throw refuse('no --artifact given and no kit artifacts directory at ' + d);
    var found = fs.readdirSync(d).filter(function (n) { return /\.(tgz|mgu)$/.test(n); }).sort()
        .map(function (n) { return path.join(d, n); });
    if (!found.length) throw refuse('no *.tgz or *.mgu in ' + d);
    return found;
}
function orderArtifacts(list) {
    var tools = list.filter(function (a) { return a.kind === 'tool'; });
    var apps = list.filter(function (a) { return a.kind === 'app'; });
    tools.sort(function (a, b) {
        if (a.id === 'app-privacy') return -1;
        if (b.id === 'app-privacy') return 1;
        return a.id < b.id ? -1 : 1;
    });
    return tools.concat(apps);
}

/* ---- installed components --------------------------------------------------- */

function installedTools() {
    var out = [];
    if (!fs.existsSync(CFG.varOpt)) return out;
    fs.readdirSync(CFG.varOpt).sort().forEach(function (id) {
        if (id === 'public') return;
        var c = readJsonOrNull(path.join(CFG.varOpt, id, 'current', 'component.json'));
        if (c && c.id === id) out.push({ id: id, kind: 'tool', version: c.version, component: c,
            root: path.join(CFG.varOpt, id) });
    });
    return out;
}
function registryEntries() {
    var out = [];
    if (!fs.existsSync(appsDir())) return out;
    fs.readdirSync(appsDir()).sort().forEach(function (n) {
        if (!/\.json$/.test(n)) return;
        var id = n.replace(/\.json$/, '');
        var entry = readJsonOrNull(path.join(appsDir(), n));
        out.push({ id: id, entry: entry, unreadable: !entry });
    });
    return out;
}
function installedApp(id) {
    var entry = readJsonOrNull(appEntryFile(id));
    if (!entry || !entry.userId) return null;
    var pkg = readJsonOrNull(path.join(appHome(entry.userId), 'source', 'package.json'));
    if (!pkg || pkg.name !== id) return null;
    return { id: id, kind: 'app', version: pkg.version, uid: entry.userId,
        installationSource: entry.installationSource === undefined ? null : entry.installationSource,
        entry: entry, pkg: pkg };
}
function installedApps() {
    return registryEntries().map(function (r) { return installedApp(r.id); })
        .filter(function (a) { return a; });
}
function appRunning(uid) {
    return psLines().some(function (l) { return l.indexOf('oap_' + uid + '/source') >= 0; });
}
/* Tile visibility source: the registry entry's provisioningCache is the
 * copy the app manager persists of the flags it applied to the app, so
 * "-enabled"/"-allowed" there state whether the tile shows. The fallback
 * supplies them only for an app provisioning does not name: provisioning's
 * own section for the same id (BMW's "store", say) wins and can hide it. */
function tileFlags(entry) {
    var cache = (entry && entry.provisioningCache) || {};
    return { visible: cache['-enabled'] === 'true' && cache['-allowed'] === 'true',
        allowed: cache['-allowed'], enabled: cache['-enabled'] };
}
function tileState(app, fb) {
    var visible = tileFlags(app.entry).visible, listed = !!(fb.active && fb.apps.indexOf(app.id) >= 0);
    return { provisioned: visible && !listed, fallback: visible && listed, visible: visible };
}

/* ---- internet for selected components ------------------------------------------ */
/* A tool whose component.json says "internet": true has its uids in
 * /var/opt/mgu-uplink/uids.d/<id>, an app whose package.json says
 * "mguInternet": true its id in apps.d/<id>; mgu-uplink reads both folders
 * besides its conf. They are written while mgu-uplink is installed (its
 * own install writes every one) and removed with the component. */
function wantedDropIns() {
    var want = {};
    installedTools().forEach(function (t) {
        if (t.component.internet === true && Array.isArray(t.component.uids)) {
            want[uplinkDropIns(t.id)[0]] = t.component.uids.join('\n') + '\n';
        }
    });
    installedApps().forEach(function (app) {
        if (app.pkg.mguInternet === true) want[uplinkDropIns(app.id)[1]] = app.id + '\n';
    });
    return want;
}
function syncDropIns() {
    var root = path.join(CFG.varOpt, 'mgu-uplink');
    if (!lstatOrNull(path.join(root, 'current'))) return;
    var want = wantedDropIns();
    ['uids.d', 'apps.d'].forEach(function (sub) {
        var d = path.join(root, sub);
        if (fs.existsSync(d)) {
            fs.readdirSync(d).forEach(function (n) {
                var p = path.join(d, n);
                if (!(p in want) && !/\.tmp-\d+$/.test(n)) { rmrf(p); say('internet: removed ' + p); }
            });
        }
    });
    Object.keys(want).forEach(function (p) {
        if (bytesEqualFile(Buffer.from(want[p]), p)) return;
        mkdirp(path.dirname(p), 0o755);
        writeAtomic(p, want[p], 0o644);
        say('internet: ' + p);
    });
}

/* ---- tool paths --------------------------------------------------------------- */

function bytesEqualFile(buf, p) {
    try { return fs.readFileSync(p).equals(buf); } catch (e) { return false; }
}
/* The deploy tool's own current link is kept out of snapshots: a restore
 * never removes the tool that holds the backups. */
function toolTouched(c) {
    if (c.id === 'mgu-deploy') return [];
    var paths = [path.join(CFG.varOpt, c.id, 'current'), CFG.recmgr];
    (c.units || []).forEach(function (u) { paths.push(path.join(CFG.systemd, u.name)); });
    (c.enable || []).forEach(function (en) {
        paths.push(path.join(CFG.systemd, en.target + '.wants', en.unit));
    });
    (c.dropins || []).forEach(function (d) { paths.push(dropinPath(d)); });
    return paths;
}
function recmgrBase(unit) { return unit.replace(/\.(service|socket|target)$/, ''); }
var PENDING_RECMGR = 'recmgr entry takes effect after reboot';
var PENDING_BOOT = 'starts at the next boot';
var PENDING_NEXT_START = 'the new version runs from its next start';

/* ---- restarts and their health ---------------------------------------------- */

function unitShow(unit) {
    var r = systemctl(['show', '-p', 'ActiveState', '-p', 'NRestarts', unit]), m = {};
    (r.stdout || '').split('\n').forEach(function (l) {
        var i = l.indexOf('=');
        if (i > 0) m[l.slice(0, i)] = l.slice(i + 1).trim();
    });
    return { active: m.ActiveState || 'unknown', nrestarts: m.NRestarts === undefined ? null : Number(m.NRestarts) };
}
/* A unit this tool restarted or started must still be active, with its
 * NRestarts unchanged, healthMs later. A oneshot that stays active
 * (RemainAfterExit) passes; a failed one does not. Returns null when all
 * are healthy, else what failed. */
function healthCheck(units) {
    if (!units.length) return null;
    var first = {}, i, now;
    units.forEach(function (u) { first[u] = unitShow(u); });
    say('health check: watching ' + units.join(', ') + ' for ' + Math.round(CFG.healthMs / 1000) + 's');
    sleepMs(CFG.healthMs);
    for (i = 0; i < units.length; i++) {
        now = unitShow(units[i]);
        if (now.active !== 'active' || now.nrestarts !== first[units[i]].nrestarts) {
            return units[i] + ' is not healthy (ActiveState=' + now.active + ', NRestarts ' +
                first[units[i]].nrestarts + ' -> ' + now.nrestarts + ')';
        }
    }
    say('healthy: ' + units.join(', '));
    return null;
}
/* A component's restart[] units. A running one restarts when recmgr has
 * loaded its entry, else it keeps running until a reboot (pending). One
 * not running is started on a fresh install under the same rule, else it
 * starts at the next boot (pending). Enabled sockets follow the same rule
 * (installTool), and a service its own socket activates is left to it.
 * Returns the units restarted or started, for the health check. */
function applyRestarts(c, state, fresh) {
    var out = [];
    (c.restart || []).forEach(function (unit) {
        if (/\.socket$/.test(unit)) return;
        var socketActivated = (c.enable || []).some(function (en) {
            return /\.socket$/.test(en.unit) && recmgrBase(en.unit) === recmgrBase(unit);
        });
        var loaded = recmgrLoaded(recmgrBase(unit));
        if (unitState(unit, 'is-active') === 'active') {
            if (c.keepRunning) {
                addPending(state, c.id, PENDING_NEXT_START);
                say(unit + ' keeps running the version it started with; the new one runs from its next start');
            } else if (loaded) { runOk(CFG.systemctl, ['restart', unit]); say('restarted ' + unit); out.push(unit); }
            else {
                addPending(state, c.id, PENDING_RECMGR);
                say(unit + ' keeps running the previous version until a reboot' + (socketActivated ? ' (socket is live)' : ''));
            }
        } else if (fresh && !socketActivated) {
            if (loaded) { runOk(CFG.systemctl, ['start', unit]); say('started ' + unit); out.push(unit); }
            else { addPending(state, c.id, PENDING_BOOT); say(unit + ' ' + PENDING_BOOT); }
        }
    });
    return out;
}
function restartAgain(units, what) {
    if (!units.length) return;
    units.forEach(function (u) { runOk(CFG.systemctl, ['restart', u]); say('restarted ' + u); });
    var bad = healthCheck(units);
    say(bad ? what + ' is not healthy either: ' + bad : what + ' is healthy');
}
/* app-privacy's apply after its own install or rollback, with the bounce
 * rule of INTEGRATION.md §2. */
function privacyApplyAndBounce() {
    var tool = privacyTool();
    if (!fs.existsSync(tool)) return { ok: false, why: 'tool missing at ' + tool };
    var r = run(CFG.node, [tool, 'apply', '--json'], { allowFail: true, timeout: 120000 });
    var result = lastJsonLine(r.stdout);
    if (r.status !== 0 || !result) return { ok: false, why: 'apply exited ' + r.status + (result ? '' : ' with no result') };
    say('app-privacy: ' + (result.state || 'applied') + (result.changed ? ' (applied now)' : ''));
    if ((result.changed || result.restartNeeded) && managerPid()) bounceManager();
    return { ok: true };
}

/* ---- tool install ------------------------------------------------------------ */

/* Installs one tool artifact; tx records what was there before, for
 * rollbackTool. A failed health check or app-privacy apply throws with
 * e.health / e.privacy set. Versions other than the new one and the one
 * current pointed to are pruned only once it is up. */
function installTool(a, state, tx) {
    var c = a.component, root = path.join(CFG.varOpt, c.id);
    var versions = path.join(root, 'versions');
    var dest = path.join(versions, c.version);
    var before = currentTarget(root);
    var prev = before ? readJsonOrNull(path.join(versions, before, 'component.json')) : null;
    var i7 = i7Takeover(a);
    tx.root = root; tx.before = before; tx.rootExisted = fs.existsSync(root);
    tx.versionExisted = fs.existsSync(dest); tx.socketsActive = {};
    (c.enable || []).forEach(function (en) {
        if (/\.socket$/.test(en.unit)) tx.socketsActive[en.unit] = unitState(en.unit, 'is-active') === 'active';
    });
    /* The manifest holds every file's checksum: the same version with the
     * same manifest is the running payload. */
    var samePayload = before === c.version &&
        bytesEqualFile(fs.readFileSync(path.join(a.dir, 'component.json')), path.join(dest, 'component.json'));
    say('installing tool ' + c.id + ' ' + c.version);
    if (!samePayload) {
        var partial = dest + '.partial-' + process.pid, aside = dest + '.old-' + process.pid;
        mkdirp(versions);
        rmrf(partial); mkdirp(partial);
        c.files.forEach(function (f) {
            var d = path.join(partial, f.path);
            mkdirp(path.dirname(d));
            fs.writeFileSync(d, fs.readFileSync(path.join(a.dir, 'files', f.path)));
            fs.chmodSync(d, octalMode(f.mode));
        });
        walk(partial, '', []).forEach(function (e) { if (e.stat.isDirectory()) fs.chmodSync(e.path, 0o755); });
        fs.chmodSync(partial, 0o755);
        fs.writeFileSync(path.join(partial, 'component.json'),
            fs.readFileSync(path.join(a.dir, 'component.json')));
        if (fs.existsSync(dest)) fs.renameSync(dest, aside);
        fs.renameSync(partial, dest);
        rmrf(aside);
    }
    if (before !== c.version) switchCurrent(root, c.version);
    /* systemd units, enablement and the recmgr list change in one window,
     * and only when the desired bytes differ. */
    var ops = [], unitChanged = false, changed = [];
    (c.units || []).forEach(function (u) {
        var src = path.join(a.dir, 'units', u.name), destUnit = path.join(CFG.systemd, u.name);
        if (!bytesEqualFile(fs.readFileSync(src), destUnit)) {
            ops.push({ type: 'copy', src: src, path: destUnit, mode: 0o644 }); unitChanged = true; changed.push(u.name);
        }
    });
    (c.enable || []).forEach(function (en) {
        var link = path.join(CFG.systemd, en.target + '.wants', en.unit), cur = null;
        try { cur = fs.readlinkSync(link); } catch (e) { /* not enabled */ }
        if (cur !== '../' + en.unit) {
            if (!fs.existsSync(path.dirname(link))) noteCreatedDir(state, path.dirname(link));
            ops.push({ type: 'mkdir', path: path.dirname(link) });
            ops.push({ type: 'symlink', path: link, target: '../' + en.unit }); unitChanged = true;
        }
    });
    (c.dropins || []).forEach(function (d) {
        var src = path.join(a.dir, 'dropins', d.unit + '.d', d.name), dest = dropinPath(d);
        if (!bytesEqualFile(fs.readFileSync(src), dest)) {
            if (!fs.existsSync(path.dirname(dest))) noteCreatedDir(state, path.dirname(dest));
            ops.push({ type: 'mkdir', path: path.dirname(dest) });
            ops.push({ type: 'copy', src: src, path: dest, mode: 0o644 }); unitChanged = true;
        }
    });
    /* a drop-in the version it replaces had and this one has not */
    ((prev && prev.dropins) || []).filter(function (d) {
        return !(c.dropins || []).some(function (x) { return x.unit === d.unit && x.name === d.name; }) && lstatOrNull(dropinPath(d));
    }).forEach(function (d) { ops.push({ type: 'delete', path: dropinPath(d) }); unitChanged = true; });
    i7.units.forEach(function (u) { ops.push({ type: 'delete', path: path.join(CFG.systemd, u) }); unitChanged = true; });
    var rec = recmgrOp(recmgrWith(recmgrText(), c.recmgr || [], []));
    if (rec) { ops.push(rec); unitChanged = true; }
    if (ops.length) rootfsWindow(ops);
    if (unitChanged) runOk(CFG.systemctl, ['daemon-reload']);
    if (i7.paths.length) {
        i7.files.forEach(function (f) { rmrf(path.join(I7_DIR, f)); });
        try { fs.rmdirSync(I7_DIR); } catch (e) { /* not empty, or gone */ }
        say(c.id + " takes over from idrive7-apps' installer: " + i7.paths.join(', ') +
            (i7.units.indexOf(I7_RENDERER_UNIT) >= 0 ? ' (its renderer runs until the next boot)' : ''));
    }
    /* An enabled socket starts once recmgr has loaded its entry: the
     * service it activates can stop like any other. A running socket whose
     * unit changed listens as the new unit says only once it restarts,
     * which systemd refuses while its service runs: it restarts now when
     * its service is stopped, else with the next boot. */
    (c.enable || []).forEach(function (en) {
        if (!/\.socket$/.test(en.unit)) return;
        var base = recmgrBase(en.unit);
        if (unitState(en.unit, 'is-active') === 'active') {
            if (changed.indexOf(en.unit) < 0) return;
            if (unitState(base + '.service', 'is-active') === 'active' || !recmgrLoaded(base)) {
                addPending(state, c.id, PENDING_NEXT_START); say(en.unit + ' changes with the next boot');
                return;
            }
            if (systemctl(['restart', en.unit]).status === 0) say('restarted ' + en.unit);
            else warn('could not restart ' + en.unit);
            return;
        }
        if (!recmgrLoaded(base)) { addPending(state, c.id, PENDING_BOOT); say(en.unit + ' ' + PENDING_BOOT); return; }
        var r = systemctl(['start', en.unit]);
        if (r.status === 0) say('started ' + en.unit);
        else warn('could not start ' + en.unit);
    });
    var touched = samePayload && !unitChanged ? [] : applyRestarts(c, state, before === null);
    var bad = healthCheck(touched), e;
    if (bad) { e = fail(c.id + ' ' + c.version + ': ' + bad); e.health = touched; throw e; }
    if (c.id === 'mgu-deploy') ensureShim();
    if (c.id === 'app-privacy') {
        var pr = privacyApplyAndBounce();
        if (!pr.ok) { e = fail('app-privacy ' + c.version + ': ' + pr.why); e.privacy = true; throw e; }
    }
    fs.readdirSync(versions).forEach(function (v) {
        if (v !== c.version && v !== before) rmrf(path.join(versions, v));
    });
    say(c.id + ' ' + c.version + ' installed');
}
/* Undoes one failed tool install. With no version to return to, a tool
 * that failed its health check or its app-privacy apply stays current,
 * reported as such. Otherwise current returns to the previous version,
 * the snapshot puts units and the recmgr list back, a version folder this
 * install created goes, a socket it started whose unit is gone again is
 * stopped, and units it restarted restart on the previous version. */
function rollbackTool(a, tx, backup, e, state) {
    var c = a.component;
    if ((e.health || e.privacy) && !tx.before) {
        say(c.id + ' ' + c.version + ' stays current: there is no previous version to return to');
        if (e.privacy) {
            say('the app-privacy patch is NOT in effect; app installs are refused until ' +
                privacyTool() + ' apply succeeds');
        }
        return;
    }
    say('rolling back ' + c.id + ' ' + c.version + (tx.before ? ' to ' + tx.before : '') + ' from ' + backup);
    restoreSnapshot(backup);
    if (tx.before) {
        if (currentTarget(tx.root) !== tx.before) switchCurrent(tx.root, tx.before);
        if (!tx.versionExisted && tx.before !== c.version) rmrf(path.join(tx.root, 'versions', c.version));
    } else if (c.id === 'mgu-deploy') {
        rmrf(path.join(tx.root, 'current'));
        rmrf(path.join(tx.root, 'versions', c.version));
    } else if (!tx.rootExisted) {
        rmrf(tx.root);
    } else {
        rmrf(path.join(tx.root, 'current'));
        if (!tx.versionExisted) rmrf(path.join(tx.root, 'versions', c.version));
    }
    Object.keys(tx.socketsActive || {}).forEach(function (u) {
        if (!tx.socketsActive[u] && !fs.existsSync(path.join(CFG.systemd, u))) {
            systemctl(['stop', u]); say('stopped ' + u);
        }
    });
    runOk(CFG.systemctl, ['daemon-reload']);
    pruneCreatedDirs(state);
    if (e.health) restartAgain(e.health, c.id + ' ' + tx.before);
    if (e.privacy) {
        var pr = privacyApplyAndBounce();
        say(pr.ok ? 'app-privacy ' + tx.before + ' applied again' : 'app-privacy ' + tx.before + ' apply failed too: ' + pr.why);
    }
}
/* The deploy tool is a tool like the others: /var/opt/mgu-deploy/
 * versions/<version>/ with its component.json, and current switched by
 * rename. Run from a kit or a staging folder, it installs the files it
 * runs from (unless a newer version is current); run from versions/, it
 * is installed already. state.json, backups/ and the fallback copy stay
 * beside versions/. The shim /var/opt/mgu-deploy/mgu-deploy.sh runs the
 * current version. */
function selfManifest() {
    var src = readJsonOrNull(path.join(HERE, 'component.json'));
    var useSrc = !!(src && src.id === 'mgu-deploy' && src.version === VERSION && Array.isArray(src.files));
    return { id: 'mgu-deploy', kind: 'tool', version: VERSION,
        title: useSrc && src.title ? src.title : SELF_TITLE,
        description: useSrc && src.description ? src.description : SELF_DESCRIPTION,
        files: (useSrc ? src.files : SELF_FILES).map(function (f) {
            return { path: f.path, mode: f.mode, sha256: sha256File(selfFile(f.path)) };
        }),
        units: [], enable: [], recmgr: [], restart: [] };
}
function runningInstalled() {
    try {
        return fs.realpathSync(HERE).indexOf(fs.realpathSync(path.join(DEPLOY_DIR, 'versions')) + path.sep) === 0;
    } catch (e) { return false; }
}
function currentTarget(root) {
    try { return path.basename(fs.readlinkSync(path.join(root, 'current'))); } catch (e) { return null; }
}
function switchCurrent(root, version) {
    var newLink = path.join(root, 'current.new');
    rmrf(newLink);
    fs.symlinkSync('versions/' + version, newLink);
    fs.renameSync(newLink, path.join(root, 'current'));
}
function ensureShim() {
    var text = '#!/bin/sh\n# The installed deploy tool: runs the version current points to.\n' +
        'exec /bin/sh ' + path.join(DEPLOY_DIR, 'current', 'mgu-deploy.sh') + ' "$@"\n';
    if (!bytesEqualFile(Buffer.from(text), SHIM) || (fs.statSync(SHIM).mode & 0o777) !== 0o755) {
        writeAtomic(SHIM, text, 0o755);
    }
}
function selfInstall() {
    mkdirp(DEPLOY_DIR);
    var versions = path.join(DEPLOY_DIR, 'versions'), before = currentTarget(DEPLOY_DIR);
    var cur = readJsonOrNull(path.join(DEPLOY_DIR, 'current', 'component.json'));
    if (runningInstalled()) {
        /* installed already */
    } else if (cur && semverCmp(cur.version, VERSION) > 0) {
        say('deploy tool ' + cur.version + ' stays current (this one is ' + VERSION + ')');
    } else {
        var text = JSON.stringify(selfManifest(), null, 2) + '\n', dest = path.join(versions, VERSION);
        if (!bytesEqualFile(Buffer.from(text), path.join(dest, 'component.json'))) {
            var partial = dest + '.partial-' + process.pid, aside = dest + '.old-' + process.pid;
            rmrf(partial); mkdirp(partial);
            selfManifest().files.forEach(function (f) {
                copyFileMode(selfFile(f.path), path.join(partial, f.path), octalMode(f.mode));
            });
            fs.writeFileSync(path.join(partial, 'component.json'), text);
            fs.chmodSync(path.join(partial, 'component.json'), 0o644);
            fs.chmodSync(partial, 0o755);
            if (fs.existsSync(dest)) fs.renameSync(dest, aside);
            fs.renameSync(partial, dest);
            rmrf(aside);
        }
        if (before !== VERSION) {
            switchCurrent(DEPLOY_DIR, VERSION);
            fs.readdirSync(versions).forEach(function (v) {
                if (v !== VERSION && v !== before) rmrf(path.join(versions, v));
            });
            say('deploy tool ' + VERSION + ' installed in ' + DEPLOY_DIR);
        }
    }
    ensureShim();
    /* the files of the layout before versions/ */
    var legacyJs = path.join(DEPLOY_DIR, 'mgu-deploy.js'), legacyBuild = path.join(DEPLOY_DIR, 'fallback_build.js');
    if (lstatOrNull(legacyJs) && lstatOrNull(legacyJs).isFile()) rmrf(legacyJs);
    if (lstatOrNull(legacyBuild) && lstatOrNull(legacyBuild).isFile() &&
        (!fallbackPresent() || fs.readFileSync(path.join(CFG.systemd, FALLBACK_UNIT), 'utf8').indexOf('/mgu-deploy/fallback_build.js') < 0)) {
        rmrf(legacyBuild);
    }
}

/* ---- app install ------------------------------------------------------------ */
/* The app manager installs our apps itself. A fresh app is one it runs
 * a full install() for: when provisioning newly lists an app it has no
 * registry entry for, it installs that app's package from
 * preinstalled_apps (someip interfaces and their ACLs, the app's folders,
 * its CertificateManager keychain, a uid of its own choosing). Our apps
 * are not provisioned, so the provisioning fallback lists them from
 * custom_apps.json; installing an app turns the fallback on. An update
 * goes through the manager's update(), which takes a newer preinstalled
 * package. The running manager runs either one on request through the
 * fallback copy's in-place hook (installInPlace), so only that app stops
 * and starts; otherwise a bounce makes the restarted manager run it: the
 * install when the fallback lists the app, the update when the registry
 * entry's installationSource is null. */

var APP_FLAGS = { '-enabled': 'true', '-allowed': 'true', '-appStartType': 'manually',
    '-userLoginRequired': 'false', '-updateMechanism': 'PLATFORM' };
/* An app's package.json may name its start type, "mguAppStartType": an
 * autostart app starts with the platform, the manager starts it again when
 * it stops, and never stops it for being inactive in the background. */
var START_TYPES = ['autostart', 'lum', 'manually'];

function filesOwnedBy(uid) {
    if (FAKE) return null;
    var r = run('find', [CFG.varOpt, '-xdev', '-uid', String(uid)], { allowFail: true, timeout: 60000 });
    var first = (r.stdout || '').split('\n').filter(function (l) { return l; })[0];
    return first || null;
}
/* <id>@<version>.tgz and <id>-<version>.tgz: every package of this app. */
function preinstalledFor(id) {
    var d = preinstalledDir(), out = [];
    if (!fs.existsSync(d)) return out;
    fs.readdirSync(d).forEach(function (n) {
        var rest = n.slice(id.length);
        if (n.indexOf(id) === 0 && /^[@-]\d+\.\d+\.\d+.*\.tgz$/.test(rest)) out.push(path.join(d, n));
    });
    return out;
}
function appTouched(a, existing) {
    var paths = [appEntryFile(a.id)];
    preinstalledFor(a.id).forEach(function (p) { paths.push(p); });
    paths.push(path.join(preinstalledDir(), a.id + '@' + a.version + '.tgz'));
    if (existing) paths.push(path.join(appHome(existing.uid), 'source', 'package.json'));
    return paths;
}
function aclFile(uid) { return path.join(appHome(uid), 'someipInterfaces', 'acl.json'); }
function appDecision(a, skipOlder) {
    var existing = installedApp(a.id), entry = readJsonOrNull(appEntryFile(a.id));
    if (entry && !existing) {
        throw refuse(a.id + ': registry entry exists without a matching source; uninstall it first');
    }
    if (!existing) return { action: 'fresh' };
    var cmp = semverCmp(a.version, existing.version);
    if (cmp === 0) return { action: 'current', existing: existing };
    if (cmp < 0 && skipOlder) return { action: 'older', existing: existing };
    if (cmp < 0) throw refuse(a.id + ' ' + existing.version + ' is installed; ' + a.version + ' is a downgrade, uninstall first');
    /* the manager fails to start an app without its ACL file and then
     * forgets it, so an update would never run */
    if (!isId8() && !fs.existsSync(aclFile(existing.uid))) {
        throw refuse(a.id + ': broken install (no ' + aclFile(existing.uid) + '); uninstall then install');
    }
    return { action: 'update', existing: existing };
}
function lastJsonLine(stdout) {
    var lines = (stdout || '').split('\n').filter(function (l) { return l.trim(); });
    try { return JSON.parse(lines[lines.length - 1]); } catch (e) { return null; }
}
/* The app-privacy patch must be in effect before the manager sees an
 * app. A changed or pre-dated manager is bounced first. */
function ensurePrivacy() {
    var pr = privacyApplyAndBounce();
    if (!pr.ok) throw refuse('app-privacy ' + pr.why + '; refusing the app install');
    ensureLocalOnlyListed();
}
/* An app custom_apps.json lists is ours, but one the retired installer put
 * there may run from a package without "mguLocalOnly": app-privacy would
 * then let the manager report it and ask BMW's app repository for it. Such
 * an app goes on app-privacy's override list (local-only-apps.json, a JSON
 * array the manager reads; entries already there stay). The list is in no
 * snapshot: it protects apps other than the one installed, so a rolled-back
 * install keeps it. */
function ensureLocalOnlyListed() {
    var file = localOnlyFile(), cur = readJsonOrNull(file), listed = Array.isArray(cur) ? cur.slice() : [];
    var add = Object.keys(readCustomApps()).filter(function (id) {
        var a = installedApp(id);
        return a && a.pkg.mguLocalOnly !== true && listed.indexOf(id) < 0;
    });
    if (!add.length) return;
    writeAtomic(file, JSON.stringify(listed.concat(add)) + '\n', 0o644);
    chownMaybe(file, MGR_UID, MGR_UID);
    say('app-privacy override lists ' + add.join(', ') + ': installed without the local-only marker');
}
function privacyApplyQuiet(extra) {
    var tool = privacyTool(), args = [tool, 'apply', '--json'];
    if (!fs.existsSync(tool)) return null;
    if (extra) args = [tool, 'apply'].concat(extra).concat(['--json']);
    return run(CFG.node, args, { allowFail: true, timeout: 120000 });
}
/* app-privacy patches the stock bundles in place; removing the tool puts
 * them back first, with its own revert. While the fallback copy is bound
 * over main.js the revert reaches the copy, so it runs again with the copy
 * unbound for the stock main.js under it, which the tool patched whenever
 * it ran with nothing bound. */
function privacyRevert() {
    var tool = privacyTool();
    if (!fs.existsSync(tool)) return false;
    var changed = privacyRevertRun(tool, '');
    if (!FAKE && bindMounted(mainJs())) {
        runOk(CFG.umount, [mainJs()]);
        try { changed = privacyRevertRun(tool, ' (stock main.js under the fallback copy)') || changed; }
        finally { runOk(CFG.mount, ['--bind', FALLBACK_COPY, mainJs()]); }
    }
    return changed;
}
function privacyRevertRun(tool, what) {
    var r = run(CFG.node, [tool, 'revert', '--json'], { allowFail: true, timeout: 120000 });
    if (r.status !== 0) throw refuse('app-privacy revert' + what + ' exited ' + r.status + '; the stock bundles stay patched and app-privacy stays installed');
    var result = lastJsonLine(r.stdout);
    say('app-privacy' + what + ': ' + (result && result.state ? result.state : 'reverted') +
        (result && result.changed ? ' (reverted now)' : ''));
    return !!(result && result.changed);
}
function readCustomApps() {
    var c = readJsonOrNull(customAppsFile());
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}
function writeCustomApps(c) {
    mkdirp(path.dirname(customAppsFile()));
    writeAtomic(customAppsFile(), JSON.stringify(c, null, 2) + '\n', 0o660);
    chownMaybe(customAppsFile(), MGR_UID, MGR_UID);
}
function customAppsPut(id, cache, startType) {
    var c = readCustomApps();
    c[id] = Object.assign({}, APP_FLAGS, cache || {}, startType ? { '-appStartType': startType } : {});
    writeCustomApps(c);
}
function customAppsRemove(id) {
    var c = readCustomApps();
    if (!(id in c)) return false;
    delete c[id];
    writeCustomApps(c);
    return true;
}
function placePreinstalled(a) {
    var dest = path.join(preinstalledDir(), a.id + '@' + a.version + '.tgz');
    var sha = sha256File(a.file), ops = [];
    preinstalledFor(a.id).forEach(function (p) {
        if (p !== dest) ops.push({ type: 'delete', path: p });
    });
    ops.push({ type: 'copy', data: fs.readFileSync(a.file), path: dest, mode: 0o644, uid: 0, gid: 0 });
    rootfsWindow(ops);
    if (sha256File(dest) !== sha) throw fail('preinstalled package checksum mismatch at ' + dest);
}
/* The manager's install of the artifact as it stands: done when its
 * registry entry names a uid and an installationSource, that uid's source
 * is the new version, and its keychain exists (a fresh install writes it
 * last; an update keeps what the app had, so an app installed without one,
 * as idrive7-apps' installer installs them, is updated without one). */
function keychainFile(uid) { return path.join(appHome(uid), 'security', 'joynrKeyChain.json'); }
function installState(a) {
    var entry = readJsonOrNull(appEntryFile(a.id));
    if (!entry || !entry.userId) return { done: false, seen: 'no registry entry' };
    var pkg = readJsonOrNull(path.join(appHome(entry.userId), 'source', 'package.json'));
    var keychain = lstatOrNull(keychainFile(entry.userId));
    return { uid: entry.userId, source: entry.installationSource,
        done: !!(entry.installationSource && pkg && pkg.name === a.id && pkg.version === a.version &&
            ((keychain && keychain.size > 0) || (a.noKeychain && entry.userId === a.noKeychain))),
        seen: 'uid ' + entry.userId + ', installationSource ' + entry.installationSource +
            ', source ' + (pkg ? pkg.version : 'absent') + ', keychain ' + (keychain ? 'present' : 'absent') };
}
function watchInstall(a) {
    var waited = 0, s;
    for (;;) {
        s = installState(a);
        if (s.done) {
            say(a.id + ' ' + a.version + ' installed by the app manager as uid ' + s.uid + ' (source ' + s.source + ')');
            return s.uid;
        }
        if (waited >= CFG.watchTimeoutMs) break;
        sleepMs(CFG.watchPollMs); waited += CFG.watchPollMs;
    }
    throw fail('app manager did not install ' + a.id + ' ' + a.version + ' within ' +
        Math.round(CFG.watchTimeoutMs / 1000) + 's (' + s.seen + ')');
}

/* ---- in-place install ----------------------------------------------------- */
/* The fallback copy's hook (fallback_build.js) has the running manager
 * install, update or uninstall one app on request: INPLACE_REQUEST, root's,
 * {id, app, version, action, notAfter}. The manager answers in its status file with
 * that id (running, then done or failed; or refused) and takes no request
 * after notAfter. */

/* The newest write, in epoch seconds, of the bundles the manager loads:
 * main.js (the fallback copy, when bound) and AppManagement.js. */
function bundlesWritten() {
    return [mainJs(), FALLBACK_COPY, appManagementJs()].reduce(function (newest, p) {
        try { return Math.max(newest, fs.statSync(p).mtime.getTime() / 1000); } catch (e) { return newest; }
    }, 0);
}
/* The running manager, when it runs the hook: it announced itself with its
 * pid and start, and started after the bundles were last written, so it
 * runs the copy bound now. A manager younger than the bounce minimum gets
 * until then to announce itself, as long as a bounce would wait. */
function inplaceManager() {
    var told = false;
    for (;;) {
        var pid = managerPid();
        if (!pid) return { why: 'no app manager is running' };
        var started = processStart(pid), st = readJsonOrNull(inplaceStatusFile());
        if (started === null) return { why: 'its start time is unreadable' };
        if (bundlesWritten() > started) return { why: 'its main.js or AppManagement.js was written after it started' };
        if (st && st.pid === pid && typeof st.start === 'number' && Math.abs(st.start / 1000 - started) < 5) {
            return { pid: pid };
        }
        var left = started + CFG.bounceMinUpS - nowS();
        if (left <= 0) return { why: 'the running app manager has no in-place hook' };
        if (!told) {
            say('waiting up to ' + Math.ceil(left) + 's for the app manager (pid ' + pid + ') to announce its in-place hook');
            told = true;
        }
        sleepMs(Math.min(1000, Math.ceil(left * 1000)));
    }
}
/* What the manager's installer is doing, from the hook's trace, in
 * seconds since the request was taken: this app's queueing in the
 * installer ("q") and its run in the AppManagement child ("run"), what
 * else runs or ran meanwhile, the child's start, and a pending network
 * retry delay or NSM resume. */
function inplaceTrace(st, app) {
    var tr = st.trace, t0 = st.taken, now = Date.now(), out = [];
    if (!tr || !Array.isArray(tr.ops) || typeof t0 !== 'number') return 'no trace from the app manager';
    var s = function (t) { var d = Math.round((t - t0) / 1000); return (d < 0 ? '' : '+') + d + 's'; };
    var mine = function (k) {
        return tr.ops.filter(function (o) {
            return o.k === k && o.app === app && ['install', 'update', 'uninstall'].indexOf(o.m) >= 0 && o.t >= t0 - 1000;
        }).pop();
    };
    var q = mine('q'), run = mine('run');
    if (!q) out.push('not yet handed to the installer');
    else if (!run) out.push('in the installer\'s queue since ' + s(q.t));
    else out.push((run.m === 'uninstall' ? 'uninstalling' : 'installing') + ' since ' + s(run.t) + (run.end ? ', ended ' + s(run.end) + (run.err ? ' (' + run.err + ')' : '') : ''));
    tr.ops.filter(function (o) { return o.app !== app && o.k === 'run' && (!o.end || o.end >= t0); }).forEach(function (o) {
        out.push(o.m + ' ' + o.app + ' ' + (o.end ? 'ran until ' + s(o.end) : 'running for ' +
            Math.round((now - o.t) / 1000) + 's') + (o.err ? ' (' + o.err + ')' : ''));
    });
    if (tr.fork && (!tr.fork.end || tr.fork.end >= t0)) {
        var from = (tr.fork.early ? 'before ' : '') + s(tr.fork.t);
        out.push('AppManagement child ' + (!tr.fork.end ? 'starting since ' + from :
            (tr.fork.err ? 'failed to start (' + from + ' to ' + s(tr.fork.end) + ': ' + tr.fork.err + ')' :
                'started ' + from + ' to ' + s(tr.fork.end))));
    } else if (!tr.child) out.push('no AppManagement child');
    if (tr.backoff) out.push('network retry delay pending (retries ' + tr.retries + ')');
    if (tr.resuming) out.push('waiting for NSM resume');
    return out.join('; ');
}
function inplaceAnswer(id) {
    var st = readJsonOrNull(inplaceStatusFile());
    return st && st.request === id ? st : null;
}
/* Writes the request and waits for the manager to take it: { pid, id, st }
 * with its first answer, or { why } when no running manager has the hook
 * or it did not take the request by notAfter. */
function inplaceAsk(app, version, action) {
    var m = inplaceManager();
    if (!m.pid) return { why: m.why };
    var id = process.pid + '-' + Date.now(), notAfter = Date.now() + CFG.inplaceAckMs, st = null;
    say('asking the running app manager (pid ' + m.pid + ') to ' + action + ' ' + app + (version ? ' ' + version : '') + ' in place');
    mkdirp(INPLACE_DIR, 0o755);
    try {
        writeAtomic(INPLACE_REQUEST, JSON.stringify({ id: id, app: app, version: version, action: action,
            notAfter: notAfter }) + '\n', 0o644);
        /* the manager takes it by notAfter or never */
        while (!(st = inplaceAnswer(id)) && Date.now() < notAfter + 3000) sleepMs(Math.min(CFG.watchPollMs, 250));
    } finally { rmrf(INPLACE_REQUEST); }
    if (!st) return { why: 'the app manager did not take the request within ' + Math.round(CFG.inplaceAckMs / 1000) + 's' };
    return { pid: m.pid, id: id, st: st };
}
/* { uid } when the running manager installed or updated it in place.
 * { why } when the manager never had the install in hand, so a bounce is
 * safe: no hook, the request not taken, refused or failed, or the manager
 * restarted. Once the manager has taken the request, an install not done
 * in time, or a result that does not match the artifact (an update keeps
 * its uid), fails like an install the manager does not finish after a
 * bounce: no bounce, which could cut the manager's install short. A moment
 * with no manager in ps is not a restart. */
function installInPlace(a, existing) {
    var action = existing ? 'update' : 'install', q = inplaceAsk(a.id, a.version, action);
    if (!q.pid) return { why: q.why };
    var m = { pid: q.pid }, id = q.id, st = q.st, poll = Math.min(CFG.watchPollMs, 1000);
    var waited = 0, doneAt = null, t0 = Date.now(), reported = t0, s, cur;
    var secs = function () { return Math.round((Date.now() - t0) / 1000) + 's'; };
    for (;;) {
        if (st.state === 'running' && Date.now() - reported >= CFG.inplaceReportMs) {
            reported = Date.now();
            say('the app manager is on it (' + secs() + '): ' + inplaceTrace(st, a.id));
        }
        s = installState(a);
        cur = managerPid();
        if (cur && cur !== m.pid) return { why: 'the app manager restarted during the in-place ' + action };
        if (st.state === 'failed' || st.state === 'done' && doneAt === null) {
            say('the app manager ' + st.state + ' after ' + secs() + ': ' + inplaceTrace(st, a.id));
        }
        if (st.state === 'refused' || st.state === 'failed') {
            return { why: 'the app manager ' + st.state + ' the in-place ' + action + (st.error ? ' (' + st.error + ')' : ''),
                state: st.state, error: st.error };
        }
        if (st.state === 'done' && s.done && (!existing || s.uid === existing.uid)) {
            say(a.id + ' ' + a.version + ' ' + (existing ? 'updated' : 'installed') + ' in place by the app manager (pid ' +
                m.pid + ') as uid ' + s.uid + ' (source ' + s.source + ')');
            return { uid: s.uid };
        }
        if (doneAt !== null && waited - doneAt >= 2 * CFG.watchPollMs) {
            throw fail('the app manager ' + (existing ? 'updated ' : 'installed ') + a.id + ' in place, but not as ' +
                a.version + ' (' + s.seen + ')');
        }
        if (waited >= CFG.watchTimeoutMs) {
            throw fail('app manager did not ' + action + ' ' + a.id + ' ' + a.version + ' in place within ' +
                Math.round(CFG.watchTimeoutMs / 1000) + 's (' + s.seen + '); not bounced, it may still be installing');
        }
        if (st.state === 'done' && doneAt === null) doneAt = waited;
        sleepMs(poll); waited += poll;
        st = inplaceAnswer(id) || st;
    }
}
/* The uid when the manager has installed or updated the app by itself: a
 * manager restarted during this run (app-privacy's bounce, say) installs
 * it from custom_apps.json at its start, and a provisioning pass updates
 * an app marked PREINSTALLED from the newer package. */
function installedAlready(a, why) {
    var s = installState(a);
    if (!s.done) return null;
    say(a.id + ' ' + a.version + ' installed by the app manager on its own as uid ' + s.uid + ' (source ' + s.source +
        '); ' + why);
    return s.uid;
}

/* Privacy, the package, the app listed by the fallback; then the running
 * manager installs or updates it in place, or else one bounce: the
 * restarted manager installs it fresh, or updates it from its registry
 * entry re-seeded with installationSource null. An app the manager has
 * installed or updated by itself by then needs no bounce. */
function installApp(a, state, decision) {
    var existing = decision.existing || null, entry;
    say('installing app ' + a.id + ' ' + a.version + (existing ? ' (update of ' + existing.version + ')' : ''));
    ensurePrivacy();
    entry = existing ? readJsonOrNull(appEntryFile(a.id)) : null;
    var kc = existing ? lstatOrNull(keychainFile(existing.uid)) : null;
    a.noKeychain = existing && !(kc && kc.size > 0) ? existing.uid : null;
    placePreinstalled(a);
    customAppsPut(a.id, entry ? entry.provisioningCache : null, a.pkg.mguAppStartType || 'manually');
    ensureFallback(state);
    var r = installInPlace(a, existing), uid = r.uid;
    /* A fresh app the manager may be installing by itself: looked at once
     * the bounce's wait is over, unless the manager failed the request for
     * any reason but that install. */
    if (!uid && !existing && !(r.state === 'failed' && r.error !== 'APP_ALREADY_INSTALLED')) {
        bounceWait();
        uid = installedAlready(a, r.why);
    }
    /* An update the manager made by itself first: a provisioning pass
     * updates an app still marked PREINSTALLED from the newer package, and
     * the request then fails as already updated. */
    if (!uid && existing && r.state === 'failed' && r.error === 'APP_ALREADY_UPDATED') {
        uid = installedAlready(a, r.why);
    }
    if (!uid) {
        say('installing ' + a.id + ' through a bounce: ' + r.why);
        entry = existing ? readJsonOrNull(appEntryFile(a.id)) : null;
        if (entry) {
            entry.installationSource = null;
            /* written in place, not renamed: the manager owns the file */
            fs.writeFileSync(appEntryFile(a.id), JSON.stringify(entry));
            say('registry entry re-seeded for the update (uid ' + entry.userId + ')');
        }
        bounceManager();
        uid = watchInstall(a);
        if (existing && uid !== existing.uid) warn(a.id + ' runs as uid ' + uid + ' now; its data stays in ' + appHome(existing.uid));
    }
    var tf = tileFlags(readJsonOrNull(appEntryFile(a.id)));
    if (!tf.visible && (tf.allowed || tf.enabled)) {
        warn(a.id + "'s tile stays hidden: provisioning has its own section for " + a.id + ' (-allowed ' +
            tf.allowed + ', -enabled ' + tf.enabled + '), which the fallback does not override; the app needs an id provisioning does not use');
    }
    if (!state.apps || typeof state.apps !== 'object') state.apps = {};
    state.apps[a.id] = { uid: uid, version: a.version };
}

/* ---- uninstall -------------------------------------------------------------- */

function cleanNpmCache(id) {
    var home = mgrHome(), caches = [];
    if (!fs.existsSync(home)) return;
    (function find(d, depth) {
        if (depth > 3 || !fs.existsSync(d)) return;
        fs.readdirSync(d).forEach(function (n) {
            var p = path.join(d, n), st = lstatOrNull(p);
            if (st && st.isDirectory()) { if (n === '.npm') caches.push(p); else find(p, depth + 1); }
        });
    })(home, 0);
    caches.forEach(function (cache) {
        walk(cache, '', []).forEach(function (e) {
            if (path.basename(e.path).indexOf(id) === 0) { rmrf(e.path); say('removed npm cache entry ' + e.path); }
        });
    });
}
/* The running manager's own uninstall, through the fallback copy's hook:
 * it stops the app, unregisters it, which takes its tile off the HMI at
 * once, and removes its folders. { done } once the hook says done; { why }
 * when the manager did not uninstall it: no hook, the request not taken,
 * refused or failed, not done in time, or the manager restarted. */
function uninstallInPlace(id, version) {
    var q = inplaceAsk(id, version, 'uninstall');
    if (!q.pid) return { why: q.why };
    var st = q.st, waited = 0, t0 = Date.now(), reported = t0, poll = Math.min(CFG.watchPollMs, 1000), cur;
    var secs = function () { return Math.round((Date.now() - t0) / 1000) + 's'; };
    for (;;) {
        if (st.state === 'running' && Date.now() - reported >= CFG.inplaceReportMs) {
            reported = Date.now();
            say('the app manager is on it (' + secs() + '): ' + inplaceTrace(st, id));
        }
        cur = managerPid();
        if (cur && cur !== q.pid) return { why: 'the app manager restarted during the in-place uninstall' };
        if (st.state === 'failed' || st.state === 'done') {
            say('the app manager ' + st.state + ' after ' + secs() + ': ' + inplaceTrace(st, id));
        }
        if (st.state === 'refused' || st.state === 'failed') {
            return { why: 'the app manager ' + st.state + ' the in-place uninstall' + (st.error ? ' (' + st.error + ')' : '') };
        }
        if (st.state === 'done') {
            say(id + ' uninstalled in place by the app manager (pid ' + q.pid + ')');
            return { done: true };
        }
        if (waited >= CFG.watchTimeoutMs) {
            return { why: 'the app manager did not uninstall ' + id + ' in place within ' + Math.round(CFG.watchTimeoutMs / 1000) + 's' };
        }
        sleepMs(poll); waited += poll;
        st = inplaceAnswer(q.id) || st;
    }
}
/* The fallback stops listing the app before anything else goes, so the
 * manager does not install it again meanwhile. The running manager then
 * uninstalls it in place; whatever it leaves goes after. Without that, one
 * bounce comes last, so the manager never sees the app listed without its
 * package (it would ask the backend for it) nor reinstalls it in between. */
function uninstallApp(id, state) {
    var entry = readJsonOrNull(appEntryFile(id));
    if (!entry || !entry.userId) throw refuse(id + ': no registry entry');
    var uid = entry.userId, home = appHome(uid);
    var pkg = readJsonOrNull(path.join(home, 'source', 'package.json'));
    var ownDir = !!(pkg && pkg.name === id), leftovers = [];
    say('uninstalling app ' + id + ' (uid ' + uid + ')');
    if (customAppsRemove(id)) say('removed ' + id + ' from ' + customAppsFile());
    /* the manager's uninstall removes the uid's folders, so only a home that is provably the app's */
    var r = ownDir ? uninstallInPlace(id, typeof pkg.version === 'string' ? pkg.version : null)
        : { why: 'its home is not provably ' + id + "'s" };
    rmrf(appEntryFile(id));
    rmrf(appEntryFile(id) + '.tmp');
    if (ownDir) rmrf(home);
    else if (fs.existsSync(home)) leftovers.push(home + ' left in place: not provably ' + id + "'s; inspect manually");
    var ops = preinstalledFor(id).map(function (p) { return { type: 'delete', path: p }; });
    if (ops.length) rootfsWindow(ops);
    if (fallbackPresent()) rebuildFallback();
    cleanNpmCache(id);
    if (!FAKE) {
        if (which(CFG.setquota)) {
            var q = run(CFG.setquota, ['-u', String(uid), '0', '0', '0', '0', CFG.varOpt], { allowFail: true });
            if (q.status !== 0) leftovers.push('could not clear quota for uid ' + uid);
        } else leftovers.push('setquota unavailable; any quota for uid ' + uid + ' stays set');
        var owned = filesOwnedBy(uid);
        if (owned) leftovers.push('files still owned by uid ' + uid + ' (e.g. ' + owned + ')');
    }
    if (!r.done) {
        leftovers.push('uid ' + uid + ': the manager\'s own ACL/UI/status records for it stay in place');
        say('uninstalling ' + id + ' through a bounce: ' + r.why);
        bounceManager();
    }
    if (fs.existsSync(appEntryFile(id))) throw fail('registry entry still present');
    if (ownDir && fs.existsSync(home)) throw fail('app home still present');
    if (state.apps) delete state.apps[id];
    leftovers.forEach(function (l) { say('leftover: ' + l); });
    say(id + ' uninstalled');
}
function uninstallTool(id, state) {
    var tools = installedTools().filter(function (t) { return t.id === id; });
    if (!tools.length) throw refuse(id + ': no installed tool with that id');
    var c = tools[0].component, root = tools[0].root;
    say('uninstalling tool ' + id + ' ' + c.version);
    /* the stock bundles go back first; a failed revert keeps the tool */
    if (id === 'app-privacy' && privacyRevert() && managerPid()) bounceManager();
    (c.units || []).forEach(function (u) {
        if (unitState(u.name, 'is-active') !== 'active') return;
        if (recmgrLoaded(recmgrBase(u.name))) { runOk(CFG.systemctl, ['stop', u.name]); say('stopped ' + u.name); }
        else { addPending(state, id, PENDING_RECMGR); warn(u.name + ' left running until a reboot'); }
    });
    var ops = [], removeRec = (c.recmgr || []).filter(function (n) {
        return !installedTools().some(function (t) { return t.id !== id && (t.component.recmgr || []).indexOf(n) >= 0; });
    });
    (c.units || []).forEach(function (u) { ops.push({ type: 'delete', path: path.join(CFG.systemd, u.name) }); });
    (c.enable || []).forEach(function (en) {
        ops.push({ type: 'delete', path: path.join(CFG.systemd, en.target + '.wants', en.unit) });
    });
    (c.dropins || []).forEach(function (d) { ops.push({ type: 'delete', path: dropinPath(d) }); });
    var rec = recmgrOp(recmgrWith(recmgrText(), [], removeRec));
    if (rec) ops.push(rec);
    if (ops.length) rootfsWindow(ops);
    if (ops.length) runOk(CFG.systemctl, ['daemon-reload']);
    pruneCreatedDirs(state);
    var own = fs.readdirSync(root).filter(function (n) { return ['versions', 'current', 'current.new'].indexOf(n) < 0; });
    if (own.length) say('removing ' + id + "'s own files beside its versions: " + own.sort().join(', '));
    rmrf(root);
    say(id + ' uninstalled');
}
/* An app on iDrive 8: its removal queued for the next start (or a queued
 * install dropped), in a snapshot of the boot unit's files. */
function uninstallQueuedId8(id, state) {
    var backup = takeSnapshot('uninstall', applyTouched());
    try {
        uninstallAppId8(id, state);
        saveState(state); selfInstall();
    } catch (e) {
        if (e.code !== 2) {
            process.stderr.write('uninstall failed, rolling back from ' + backup + '\n');
            try { restoreSnapshot(backup); pruneCreatedDirs(state); } catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        }
        throw e;
    }
    return 0;
}
function touchedForUninstall(id) {
    var tool = installedTools().filter(function (t) { return t.id === id; })[0];
    if (tool) return toolTouched(tool.component).concat(uplinkDropIns(id));
    var paths = [appEntryFile(id), customAppsFile()].concat(uplinkDropIns(id));
    preinstalledFor(id).forEach(function (p) { paths.push(p); });
    return paths;
}

/* ---- iDrive 8: app changes at the next start ------------------------------------------ */
/* MainApp-21 (iDrive 8) installs an app it finds in its preinstalled_apps
 * when provisioning, the six das files under /usr/share/tm/prov, lists it,
 * at its start. It does not update a preinstalled app in place, and nothing
 * of an app is removed while it runs. So an app install or uninstall on
 * iDrive 8 is queued (id8/pending.json, the package in id8/queue/) and
 * applied at the next start by mgu-deploy-apply.service, before
 * oapcontroller, the way IterioDev's App Manager does
 * (github.com/IterioDev/mgu-app-store, appmanager-service/oap.js):
 *   install    the installed version uninstalled first (its data goes),
 *              the package as preinstalled_apps/<id>@<version>.tgz, the
 *              app's two lines in every das file;
 *   uninstall  its registry entry, home and personal copies, vsomeip
 *              policy folder, uids.txt line and diag status entries; then
 *              its packages and das lines.
 * What goes is moved to id8/trash/<time>/ (the 3 newest kept). The
 * package is installed in npm format (files under package/), with what
 * MainApp-21 needs and it lacks added (id8Complete). */
var ID8_DIR = path.join(DEPLOY_DIR, 'id8');
var ID8_PENDING = path.join(ID8_DIR, 'pending.json');
var ID8_QUEUE = path.join(ID8_DIR, 'queue');
var ID8_TRASH = path.join(ID8_DIR, 'trash');
var ID8_LAST = path.join(ID8_DIR, 'last-apply.json');
var APPLY_UNIT = 'mgu-deploy-apply.service';
var APPLY_NAME = 'mgu-deploy-apply';
var APPLY_WANTS = 'late.target.wants';
var ID8_INSTALLS = 'installs at the next start';
var ID8_REMOVES = 'removed at the next start';
var DAS = ['das_000', 'das_001', 'das_002', 'das_003', 'das_004', 'das_005'];
/* stock apps: their das lines look like ours; never changed */
var ID8_PROTECTED = ['oap-mainapp21', 'main_app', 'oapcontroller', 'secure_time', 'cdc_jobmanager', 'x_call',
    'ts_diagnostic_service', 'oap-cdc-2018', 'trigger_service'];
function isId8() { return unitInfo().hmi === 'ID8'; }
function dasAppLine(id) { return '<app supportedECUs="HU" initialPreferPreinstalled="true">' + id + '</app>'; }
function dasEnableLine(id) {
    return '<' + id + ' enabled="true" allowed="true" appStartType="autostart" userLoginRequired="false"/>';
}
function dasFile(d) { return path.join(CFG.prov, d + '.xml'); }
function applyUnitSource() { return path.join(HERE, APPLY_UNIT); }
function applyTouched() {
    return [path.join(CFG.systemd, APPLY_UNIT), path.join(CFG.systemd, APPLY_WANTS, APPLY_UNIT), CFG.recmgr];
}
function readPending() {
    var p = readJsonOrNull(ID8_PENDING);
    return p && Array.isArray(p.changes) ? p.changes : [];
}
function writePending(changes) {
    if (!changes.length) { rmrf(ID8_PENDING); return; }
    mkdirp(ID8_DIR, 0o700);
    writeAtomic(ID8_PENDING, JSON.stringify({ changes: changes }, null, 2) + '\n', 0o600);
}
/* The apps provisioning lists with the preinstalled marker line: ours and
 * the App Manager's, waiting for MainApp or installed. */
function dasApps() {
    var ids = [];
    DAS.forEach(function (d) {
        var x = '', re = /<app supportedECUs="HU" initialPreferPreinstalled="true">([^<]+)<\/app>/g, m;
        try { x = fs.readFileSync(dasFile(d), 'utf8'); } catch (e) { return; }
        while ((m = re.exec(x))) if (ID8_PROTECTED.indexOf(m[1]) < 0 && ids.indexOf(m[1]) < 0) ids.push(m[1]);
    });
    return ids;
}
/* The boot unit that applies the queue: written, enabled and listed in
 * recmgr (where the unit has the list) with the first change queued. */
function ensureApplyUnit(state) {
    if (!fs.existsSync(applyUnitSource())) throw refuse(APPLY_UNIT + ' missing beside mgu-deploy.js');
    selfInstall(); // the unit runs the installed tool through its shim
    var unitDest = path.join(CFG.systemd, APPLY_UNIT), link = path.join(CFG.systemd, APPLY_WANTS, APPLY_UNIT), cur = null, ops = [];
    if (!bytesEqualFile(fs.readFileSync(applyUnitSource()), unitDest)) {
        ops.push({ type: 'copy', src: applyUnitSource(), path: unitDest, mode: 0o644 });
    }
    try { cur = fs.readlinkSync(link); } catch (e) { /* not enabled */ }
    if (cur !== '../' + APPLY_UNIT) {
        if (!fs.existsSync(path.dirname(link))) noteCreatedDir(state, path.dirname(link));
        ops.push({ type: 'mkdir', path: path.dirname(link) });
        ops.push({ type: 'symlink', path: link, target: '../' + APPLY_UNIT });
    }
    var rec = recmgrOp(recmgrWith(recmgrText(), [APPLY_NAME], []));
    if (rec) ops.push(rec);
    if (ops.length) {
        rootfsWindow(ops);
        runOk(CFG.systemctl, ['daemon-reload']);
        say(APPLY_UNIT + ' installed: queued app changes apply at the next start');
    }
}
/* MainApp-21 gives an app a tile, and lets it start, only when its
 * rhmiData/application.json has an appletId. The app's tile registers with
 * the HMI at appletId + 1000, its start widget at + 2000 and its own RHMI
 * application at + 0 or + 3000 (by its oap-sdk). Hmi8 takes these only in
 * HMI_APPLET_IDS (a check in its binary; nothing on the unit names it), each
 * once, so two appletIds 0, 1000, 2000 or 3000 apart clash. The ids in use
 * differ from car to car and are read from the unit each time: every OAP
 * app's, MainApp-21's, the packages in preinstalled_apps and in our queue,
 * those given in this run, and Hmi8's built-in applets'. A source that
 * cannot be read fails the install (the unit's failure, not the package's)
 * rather than leave an id out; a package of another app that cannot be read
 * is passed over, warning. */
var HMI_APPLET_IDS = [20000, 29999];
var id8Assigned = {}; // appletIds given in this run, by app id
function appletIdOf(appJson) {
    var a = appJson && appJson.application;
    return a && typeof a.appletId === 'number' ? a.appletId : null;
}
function parseJsonText(t) { return JSON.parse(t.replace(/^﻿/, '')); }
function idReadFailure(what, e) { return fail('cannot read ' + what + ' for the appletIds in use: ' + (e && e.message || e)); }
/* fs.statSync (symlinks followed), null only when the path does not exist. */
function statIfThere(p) {
    try { return fs.statSync(p); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw idReadFailure(p, e);
    }
}
/* An application.json's appletId: null without the file or the id. */
function fileAppletId(f) {
    if (!statIfThere(f)) return null;
    try { return appletIdOf(parseJsonText(fs.readFileSync(f, 'utf8'))); } catch (e) { throw idReadFailure(f, e); }
}
/* A package's appletId; one that cannot be read is passed over (null). */
function tgzAppletId(file) {
    var j = null;
    try {
        var members = linker().untar(fs.readFileSync(file));
        if (!members.length) throw new Error('no files in it');
        members.forEach(function (m) {
            if (/^(\.\/)?(package\/)?rhmiData\/application\.json$/.test(m.name)) j = parseJsonText(m.data.toString('utf8'));
        });
    } catch (e) {
        warn('the appletId of ' + file + ' is not known, passed over: ' + e.message);
        return null;
    }
    return appletIdOf(j);
}
/* The files below dir, symlinks followed (depth-bounded against loops). */
function filesBelow(dir, depth) {
    var out = [];
    fs.readdirSync(dir).forEach(function (n) {
        var p = path.join(dir, n), st = statIfThere(p);
        if (!st) return; // a link to nothing
        if (st.isDirectory()) { if (depth < 8) out = out.concat(filesBelow(p, depth + 1)); }
        else if (st.isFile()) out.push(p);
    });
    return out;
}
/* Hmi8's built-in applets' appletIds: <appletId> of each RHMI applet's
 * manifest under its data's applet/, AppletId of each native applet. Its
 * data folder must be there; an applets folder a unit does not have holds
 * none. An empty id is passed over; ids are decimal or 0x hex. */
function builtinAppletIds() {
    var ids = [], read = function (f) {
        try { return fs.readFileSync(f, 'utf8'); } catch (e) { throw idReadFailure(f, e); }
    }, list = function (d, ext) {
        if (!statIfThere(d)) return [];
        try { return filesBelow(d, 0).filter(function (f) { return f.slice(-ext.length) === ext; }); } catch (e) {
            throw e.code === 1 ? e : idReadFailure('the HMI\'s applets in ' + d, e);
        }
    }, add = function (f, v) {
        if (v === '') return;
        if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(v)) throw idReadFailure(f, 'appletId ' + v + ' is not a number');
        ids.push(Number(v));
    };
    if (!statIfThere(CFG.hmi8Data)) throw idReadFailure('the HMI\'s data', CFG.hmi8Data + ' is missing');
    list(path.join(CFG.hmi8Data, 'applet'), '.manifest').forEach(function (f) {
        var m = /<appletId>\s*([^<]*?)\s*<\/appletId>/.exec(read(f));
        if (m) add(f, m[1]);
    });
    list(CFG.hmi8Applets, '.xml').forEach(function (f) {
        var re = /key="AppletId"\s+value="\s*([^"]*?)\s*"/g, m, x = read(f);
        while ((m = re.exec(x))) add(f, m[1]);
    });
    return ids;
}
/* The appletIds on this unit, as { others: [...], own: id's or null }. */
function id8AppletIds(id) {
    var entry = readJsonOrNull(appEntryFile(id)), ownHome = entry && entry.userId ? 'oap_' + entry.userId : null;
    var others = builtinAppletIds(), own = null, add = function (v, mine) {
        if (v === null) return;
        if (mine) own = v; else others.push(v);
    };
    add(fileAppletId(path.join(mainappRoot(), 'rhmiData', 'application.json')), false);
    if (!statIfThere(CFG.oap)) throw idReadFailure('the apps\' homes', CFG.oap + ' is missing');
    var homes;
    try { homes = fs.readdirSync(CFG.oap); } catch (e) { throw idReadFailure(CFG.oap, e); }
    homes.forEach(function (n) {
        if (/^oap_\d+$/.test(n)) add(fileAppletId(path.join(CFG.oap, n, 'rhmiData', 'application.json')), n === ownHome);
    });
    var mine = preinstalledFor(id), pre = [];
    try { pre = statIfThere(preinstalledDir()) ? fs.readdirSync(preinstalledDir()) : []; } catch (e) { throw e.code === 1 ? e : idReadFailure(preinstalledDir(), e); }
    pre.forEach(function (n) {
        var f = path.join(preinstalledDir(), n);
        if (/\.tgz$/.test(n)) add(tgzAppletId(f), mine.indexOf(f) >= 0);
    });
    readPending().forEach(function (c) { if (c.file && c.id !== id) add(tgzAppletId(c.file), false); });
    Object.keys(id8Assigned).forEach(function (k) { if (k !== id) add(id8Assigned[k], false); });
    return { others: others, own: own };
}
/* The appletId app id gets: its installed version's, else the one its
 * package declares, while free; else the lowest free one. */
function freeAppletId(id, declared) {
    var ids = id8AppletIds(id), lo = HMI_APPLET_IDS[0], hi = HMI_APPLET_IDS[1] - 3000, free = function (v) {
        return v >= lo && v <= hi && ids.others.every(function (o) { return [0, 1000, 2000, 3000].indexOf(Math.abs(v - o)) < 0; });
    };
    if (ids.own !== null && free(ids.own)) return ids.own;
    if (declared !== null && free(declared)) return declared;
    for (var v = lo; v <= hi; v++) if (free(v)) return v;
    throw refuse(id + ': no appletId free on this unit');
}
/* What MainApp-21 needs of a package and it may lack, added in pkgDir: the
 * ACL tables permissions.json lacks (aclManager.js fails the install
 * without either), empty, and an appletId. Returns what was added. */
function id8Complete(a) {
    var added = linker().completePermissions(a.pkgDir).map(function (t) { return t + ' added to permissions.json'; });
    var f = path.join(a.pkgDir, 'rhmiData', 'application.json'), j = null;
    try { j = parseJsonText(fs.readFileSync(f, 'utf8')); } catch (e) { /* no RHMI app, or none that parses */ }
    if (j && j.application && typeof j.application === 'object') {
        var declared = appletIdOf(j), v = id8Assigned[a.id] = freeAppletId(a.id, declared);
        if (v !== declared) {
            j.application.appletId = v;
            fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
            added.push(declared === null ? 'appletId ' + v + ' added to rhmiData/application.json' :
                'appletId ' + v + ' in rhmiData/application.json in place of ' + declared + ', which this unit cannot take');
        }
    }
    return added;
}
/* The package MainApp-21 installs, in npm format (files under package/):
 * one published so, as it is unless id8Complete adds to it; a source
 * package built here; any other one (flat, .mgu) repacked. */
function id8Package(a, stage) {
    if (a.prepare === 'build') a = prepareApp(a, stage);
    var npm = a.pkgDir === path.join(a.dir, 'package'), added = id8Complete(a);
    if (npm && !added.length) return a;
    var out = path.join(stage, 'id8-' + a.id + '@' + a.version + '.tgz');
    var entries = walk(a.pkgDir, '', []).filter(function (e) { return e.stat.isFile(); }).map(function (e) {
        return { name: 'package/' + e.rel, data: fs.readFileSync(e.path), mode: e.stat.mode & 0o777 };
    });
    var pack = require(selfFile('oap_pack.js'));
    fs.writeFileSync(out, pack.tgz(entries, pack.MTIME));
    say('repacked ' + a.id + ' ' + a.version + (npm ? '' : ' in npm format (files under package/)') +
        (added.length ? ': ' + added.join(', ') : ''));
    return Object.assign({}, a, { file: out, from: a.from || a.file });
}
function queueId8(change) {
    var keep = [];
    readPending().forEach(function (c) {
        if (c.id !== change.id) keep.push(c);
        else if (c.file && c.file !== change.file) rmrf(c.file);
    });
    writePending(change.action ? keep.concat([change]) : keep);
}
function installAppId8(a, state, decision) {
    var existing = decision.existing || null, file = path.join(ID8_QUEUE, a.id + '@' + a.version + '.tgz');
    say('queueing app ' + a.id + ' ' + a.version + (existing ? ' (update of ' + existing.version + ')' : '') + ' for the next start');
    ensureApplyUnit(state);
    mkdirp(ID8_QUEUE, 0o700);
    copyFileMode(a.file, file, 0o600);
    queueId8({ action: 'install', id: a.id, version: a.version, file: file, sha256: sha256File(file) });
    say(a.id + ' ' + a.version + ' ' + ID8_INSTALLS + ' of the head unit' +
        (existing ? '; ' + existing.version + ' is uninstalled first, and its data with it' : ''));
}
function uninstallAppId8(id, state) {
    if (ID8_PROTECTED.indexOf(id) >= 0) throw refuse(id + ' is a system app');
    var queued = readPending().filter(function (c) { return c.id === id; })[0];
    var present = !!readJsonOrNull(appEntryFile(id)) || dasApps().indexOf(id) >= 0 || preinstalledFor(id).length > 0;
    if (!present && !queued) throw refuse(id + ': not installed');
    if (!present) { queueId8({ id: id }); say('the queued install of ' + id + ' is dropped'); return; }
    ensureApplyUnit(state);
    queueId8({ action: 'remove', id: id });
    say(id + ' is ' + ID8_REMOVES + ' of the head unit');
}
function copyTree(src, dst) {
    var st = fs.lstatSync(src);
    mkdirp(path.dirname(dst));
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
    else if (st.isDirectory()) {
        fs.mkdirSync(dst, st.mode & 0o7777);
        fs.readdirSync(src).forEach(function (n) { copyTree(path.join(src, n), path.join(dst, n)); });
    } else fs.writeFileSync(dst, fs.readFileSync(src), { mode: st.mode & 0o7777 });
    if (!FAKE) { try { fs.lchownSync(dst, st.uid, st.gid); } catch (e) { /* kept as root's */ } }
}
/* Moves p into bin under its own path (/var/opt/x -> <bin>/var/opt/x). A
 * path on the read-only root is copied here and deleted in the rootfs
 * window (ops). */
function trashPath(p, bin, ops, log) {
    if (!lstatOrNull(p)) return false;
    var dst = path.join(bin, p);
    if (isRootfsPath(p)) { copyTree(p, dst); ops.push({ type: 'delete', path: p }); }
    else {
        mkdirp(path.dirname(dst));
        try { fs.renameSync(p, dst); } catch (e) {
            if (e.code !== 'EXDEV') throw e;
            copyTree(p, dst); rmrf(p);
        }
    }
    log(p);
    return true;
}
/* Everything of an installed app but its package and das lines. */
function uninstallId8(id, bin, ops, log) {
    var entry = readJsonOrNull(appEntryFile(id)), uid = entry && Number(entry.userId) > 0 ? entry.userId : null;
    trashPath(appEntryFile(id), bin, ops, log);
    if (uid) {
        trashPath(appHome(uid), bin, ops, log);
        var personal = path.join(CFG.varOpt, 'personal');
        (fs.existsSync(personal) ? fs.readdirSync(personal) : []).forEach(function (pr) {
            trashPath(path.join(personal, pr, 'oap', 'oap_' + uid), bin, ops, log);
        });
        trashPath(path.join(CFG.etc, 'vsomeip', uid + '_' + uid), bin, ops, log);
    }
    var uids = path.join(mgrHome(), 'security', 'uids.txt');
    if (fs.existsSync(uids)) {
        var lines = fs.readFileSync(uids, 'utf8').split('\n');
        var keep = lines.filter(function (l) { return l.split('=')[1] !== id; });
        if (keep.length !== lines.length) { fs.writeFileSync(uids, keep.join('\n')); log(uids + ' -' + id); }
    }
    ['diagOapInstallationStatus.json', 'diagOapDownloadStatus.json'].forEach(function (n) {
        var f = path.join(mgrHome(), 'data', n), j = readJsonOrNull(f), changed = 0;
        if (!j || typeof j !== 'object') return;
        Object.keys(j).forEach(function (k) {
            if (k === id) { delete j[k]; changed++; }
            else if (Array.isArray(j[k])) {
                var b = j[k].length;
                j[k] = j[k].filter(function (e) { return !(e && (e.appId === id || e.name === id)); });
                changed += b - j[k].length;
            }
        });
        if (changed) { fs.writeFileSync(f, JSON.stringify(j)); log(f + ' -' + id); }
    });
}
/* Each das file with the app's two lines added (add) or taken out:
 * [{ path, text, st }] of the files that change. */
function dasEdits(id, add) {
    var out = [];
    DAS.forEach(function (d) {
        var f = dasFile(d), st = lstatOrNull(f), lines, keep, i, indent;
        if (!st) return;
        lines = fs.readFileSync(f, 'utf8').split('\n');
        var has = function (s) { return lines.some(function (l) { return l.trim() === s; }); };
        if (add) {
            keep = lines.slice();
            if (!has(dasAppLine(id))) {
                i = keep.map(function (l) { return l.trim(); }).indexOf('</installable_apps>');
                if (i < 0) throw fail(d + ': no </installable_apps>');
                indent = /^\s*/.exec(keep[i - 1] || '')[0];
                keep.splice(i, 0, indent + dasAppLine(id));
            }
            if (!has(dasEnableLine(id))) {
                i = -1;
                keep.some(function (l, j) { if (/^\s*<x_call enabled=/.test(l)) { i = j; return true; } return false; });
                if (i < 0) throw fail(d + ': no <x_call enabled=...> line');
                keep.splice(i + 1, 0, /^\s*/.exec(keep[i])[0] + dasEnableLine(id));
            }
        } else {
            keep = lines.filter(function (l) { return l.trim() !== dasAppLine(id) && l.trim() !== dasEnableLine(id); });
        }
        if (keep.join('\n') !== lines.join('\n')) out.push({ path: f, text: keep.join('\n'), st: st });
    });
    return out;
}
function dasOps(edits) {
    return edits.map(function (e) {
        return { type: 'copy', data: e.text, path: e.path, mode: e.st.mode & 0o7777, uid: e.st.uid, gid: e.st.gid };
    });
}
function rootFreeKB() {
    if (FAKE) return Infinity;
    var r = run(CFG.df, ['-k', '/'], { allowFail: true });
    var f = (r.stdout || '').trim().split('\n').pop().split(/\s+/);
    return r.status === 0 && Number(f[3]) >= 0 ? Number(f[3]) : Infinity;
}
/* One queued change, at boot with MainApp not running. The das edits are
 * worked out before anything moves, so a das file without its anchors
 * fails the change with nothing changed. */
function applyId8(c, bin, log) {
    var ops = [], install = c.action === 'install', dest = null, edits;
    if (ID8_PROTECTED.indexOf(c.id) >= 0) throw fail('a system app');
    if (!install && c.action !== 'remove') throw fail('unknown action ' + c.action);
    if (install) {
        if (!fs.existsSync(c.file) || sha256File(c.file) !== c.sha256) throw fail('the queued package is missing or changed');
        if (rootFreeKB() < fs.statSync(c.file).size / 1024 + 5120) throw fail('not enough space on the system partition');
        dest = path.join(preinstalledDir(), c.id + '@' + c.version + '.tgz');
    }
    edits = dasEdits(c.id, install);
    uninstallId8(c.id, bin, ops, log);
    preinstalledFor(c.id).forEach(function (p) { trashPath(p, bin, ops, log); });
    if (install) { ops.push({ type: 'copy', src: c.file, path: dest, mode: 0o644, uid: 0, gid: 0 }); log(dest); }
    rootfsWindow(ops.concat(dasOps(edits)));
    edits.forEach(function (e) { log(e.path + (install ? ' +' : ' -') + c.id); });
    if (install && sha256File(dest) !== c.sha256) throw fail('package checksum mismatch at ' + dest);
}
function cmdApplyPending() {
    if (!isId8()) throw refuse('apply-pending applies queued iDrive 8 app changes; this head unit is ' + hmiName(unitInfo().hmi || 'unknown'));
    var changes = readPending(), results = [];
    if (!changes.length) { say('nothing queued'); return 0; }
    if (managerPid()) throw refuse('the app manager is running; queued changes apply before it starts (' + APPLY_UNIT + ')');
    var bin = path.join(ID8_TRASH, timestamp());
    changes.forEach(function (c) {
        var res = { id: c.id, action: c.action, version: c.version || null, ok: false, log: [] };
        try {
            applyId8(c, bin, function (l) { res.log.push(l); });
            res.ok = true;
            say(c.id + (c.version ? ' ' + c.version : '') + ': ' + (c.action === 'install' ? 'installed for MainApp' : 'removed'));
        } catch (e) {
            res.error = e.message;
            process.stderr.write(c.id + ': ' + c.action + ' failed: ' + e.message + '\n');
        }
        results.push(res);
    });
    writeAtomic(ID8_LAST, JSON.stringify({ at: new Date().toISOString(), results: results }, null, 2) + '\n', 0o644);
    changes.forEach(function (c) { if (c.file) rmrf(c.file); });
    writePending([]);
    if (fs.existsSync(ID8_TRASH)) {
        var old = fs.readdirSync(ID8_TRASH).sort();
        old.slice(0, Math.max(0, old.length - 3)).forEach(function (n) { rmrf(path.join(ID8_TRASH, n)); });
    }
    return results.every(function (r) { return r.ok; }) ? 0 : 1;
}

/* ---- IterioDev's App Manager: replaced by the Store --------------------------------- */
/* IterioDev's App Manager (github.com/IterioDev/mgu-app-store,
 * appmanager-service) is a root service in /var/opt/appmanager (its code in
 * code/current/, 1.0.x in the folder itself; state.json, config.json,
 * catalog.json, apply.log, pending.json and staged/ beside it), run by
 * appmanager.service, with appmanager-apply.service applying its queue at
 * boot; its HMI app oap-appmanager; and the root services it installs:
 * the renderer (renderer/mgu-renderd, mgu-renderd.service) and the iPhone
 * tether (tether/ipheth-tether, ipheth-tether.service). The Store
 * replaces it:
 *   appmanager adopt          its daemon disabled and stopped (where recmgr
 *                             lets it run this boot, the rest waits for the
 *                             next); its queued
 *                             app changes moved to ours (iDrive 8) and its
 *                             boot hook disabled; its tether stopped and
 *                             disabled (mgu-uplink drives the iPhone); its
 *                             renderer the tool mgu-renderd, made from the
 *                             program it runs (a running one keeps running);
 *                             the apps it installed and its repositories
 *                             recorded in appmanager.json for the updater.
 *                             Nothing is reinstalled.
 *   uninstall oap-appmanager  adopts first; its units and boot hook
 *                             removed, /var/opt/appmanager kept as
 *                             appmanager-removed/, its HMI app uninstalled
 *                             (on iDrive 8 at the next start). The apps and
 *                             the renderer stay. */
var AM = { home: path.join(CFG.varOpt, 'appmanager'), app: 'oap-appmanager', daemon: 'appmanager.service',
    apply: 'appmanager-apply.service', tether: 'ipheth-tether.service' };
var AM_RECORD = path.join(DEPLOY_DIR, 'appmanager.json');
var AM_REMOVED = path.join(DEPLOY_DIR, 'appmanager-removed');
var AM_LOG_MAX = 1 << 20;
var AM_NEXT_BOOT = 'adopted at the next boot';
function amFile(rel) { return path.join(AM.home, rel); }
function amUnits() {
    return [AM.daemon, AM.apply].filter(function (u) { return !!lstatOrNull(path.join(CFG.systemd, u)); });
}
/* Its service version: code/current/version.json; 1.0.x kept its code in
 * the folder itself. */
function amVersion() {
    var v = readJsonOrNull(amFile('code/current/version.json'));
    if (v && typeof v.version === 'string') return v.version;
    return fs.existsSync(amFile('appmanager.js')) ? '1.0.x' : null;
}
function amPresent() { return amUnits().length > 0 || !!amVersion(); }
function wantsLinks(unit) {
    if (!fs.existsSync(CFG.systemd)) return [];
    return fs.readdirSync(CFG.systemd).filter(function (n) { return /\.wants$/.test(n); })
        .map(function (n) { return path.join(CFG.systemd, n, unit); })
        .filter(function (p) { return !!lstatOrNull(p); });
}
/* One of his root services: { version, bin } while its program is there. */
function amService(kind, program) {
    var v = readJsonOrNull(amFile(kind + '/version.json')), bin = amFile(kind + '/' + program), st = lstatOrNull(bin);
    return v && typeof v.version === 'string' && st && st.isFile() ? { version: v.version, bin: bin } : null;
}
/* An app on the unit: { version } (null while MainApp has not installed
 * it), or null when it is not there at all. */
function amAppOnUnit(id) {
    var app = installedApp(id);
    if (app) return { version: app.version };
    var pre = preinstalledFor(id).map(function (p) { var m = /@(\d+\.\d+\.\d+)\.tgz$/.exec(p); return m && m[1]; })
        .filter(Boolean)[0];
    if (pre) return { version: pre };
    return isId8() && dasApps().indexOf(id) >= 0 ? { version: null } : null;
}
/* The apps it installed: the ones its store recorded (state.json
 * installedFrom) and the ones its apply.log last shows installed, that are
 * on the unit; not itself, its services or a system app. */
function amApps() {
    var st = readJsonOrNull(amFile('state.json')) || {}, from = st.installedFrom || {}, last = {}, ids = Object.keys(from), text = '';
    try {
        var fd = fs.openSync(amFile('apply.log'), 'r'), size = fs.fstatSync(fd).size, n = Math.min(size, AM_LOG_MAX);
        var b = Buffer.alloc(n);
        try { fs.readSync(fd, b, 0, n, size - n); } finally { fs.closeSync(fd); }
        text = b.toString('utf8');
    } catch (e) { /* no log */ }
    text.split('\n').forEach(function (l) {
        var j = null;
        try { j = JSON.parse(l); } catch (e) { return; }
        ((j && Array.isArray(j.results)) ? j.results : []).forEach(function (r) {
            if (r && r.ok && typeof r.appId === 'string') last[r.appId] = r.action;
        });
    });
    Object.keys(last).forEach(function (id) { if (last[id] === 'install' && ids.indexOf(id) < 0) ids.push(id); });
    return ids.filter(function (id) {
        return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && id !== AM.app && ID8_PROTECTED.indexOf(id) < 0 &&
            Object.keys(SERVICES).every(function (k) { return SERVICES[k].name !== id; });
    }).sort().map(function (id) {
        var on = amAppOnUnit(id);
        return on && { id: id, version: on.version, from: typeof from[id] === 'string' ? from[id] : null };
    }).filter(Boolean);
}
/* Its repositories, without their tokens: { url, index, private, enabled,
 * isDefault, lists: the ids its last catalog fetch saw there }. */
function amRepos() {
    var c = readJsonOrNull(amFile('config.json')) || {}, cat = (readJsonOrNull(amFile('catalog.json')) || {}).repos || {};
    return (Array.isArray(c.repos) ? c.repos : []).filter(function (r) {
        return r && typeof r.url === 'string' && typeof r.index === 'string';
    }).map(function (r) {
        var entries = (cat[r.url] && Array.isArray(cat[r.url].entries)) ? cat[r.url].entries : [];
        return { url: r.url, index: r.index, private: !!r.token, enabled: r.enabled !== false, isDefault: !!r.isDefault,
            lists: entries.map(function (e) { return e && e.id; }).filter(function (id) { return typeof id === 'string'; }) };
    });
}
/* What status --json says of it: null when it was never on this unit. */
function amStatus() {
    var record = readJsonOrNull(AM_RECORD), present = amPresent();
    if (!present && !record) return null;
    var app = amAppOnUnit(AM.app);
    return { present: present, version: amVersion(), app: app ? app.version : null,
        daemon: present ? unitState(AM.daemon, 'is-active') : null, record: record };
}
/* A unit of his stopped: a running one unless recmgr does not list it
 * (stopping it would restart the head unit), one that is not running
 * always (a start the boot has queued is cancelled). -> stopped */
function amStop(unit) {
    var running = ['active', 'activating', 'reloading'].indexOf(unitState(unit, 'is-active')) >= 0;
    if (running && recmgrPresent() && !recmgrLoaded(recmgrBase(unit))) return false;
    systemctl(['stop', unit]);
    if (running) say('stopped ' + unit);
    return true;
}
function amTouched() {
    var paths = [AM_RECORD, ID8_PENDING, amFile('pending.json'), path.join(CFG.systemd, 'mgu-renderd.service')];
    [AM.daemon, AM.apply, AM.tether].forEach(function (u) {
        paths.push(path.join(CFG.systemd, u));
        wantsLinks(u).forEach(function (l) { paths.push(l); });
    });
    wantsLinks('mgu-renderd.service').forEach(function (l) { paths.push(l); });
    return paths.concat(applyTouched());
}
/* His queued app changes, into our queue (iDrive 8, where his apply step
 * installs): an install with its staged package while that still
 * matches, as our install queues it (id8Package), a removal as it is; his
 * own app is not carried over.
 * -> [{ id, version }] of the installs moved */
function amMoveQueue(state, stage) {
    var changes = (readJsonOrNull(amFile('pending.json')) || {}).changes, moved = [];
    if (!isId8() || !Array.isArray(changes) || !changes.length) return moved;
    changes.forEach(function (c) {
        if (!c || typeof c.appId !== 'string' || c.appId === AM.app || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.appId)) return;
        if (c.action === 'install') {
            var staged = amFile('staged/' + c.appId + '@' + c.version + '.tgz');
            if (!semverParts(c.version) || !fs.existsSync(staged) || sha256File(staged) !== c.sha256) {
                say('his queued install of ' + c.appId + ' is dropped: its staged package is missing or changed');
                return;
            }
            // a package that is refused is dropped; the unit's failure rolls the whole command back
            var a = null, why = 'its staged package is not that app';
            try {
                a = validateArtifact(staged, stage);
                a = a.kind === 'app' && a.id === c.appId && a.version === c.version ? id8Package(a, stage) : null;
            } catch (e) {
                if (!isRefusal(e)) throw e;
                a = null; why = e.message;
            }
            if (!a) { say('his queued install of ' + c.appId + ' is dropped: ' + why); return; }
            ensureApplyUnit(state);
            var file = path.join(ID8_QUEUE, c.appId + '@' + c.version + '.tgz');
            mkdirp(ID8_QUEUE, 0o700);
            copyFileMode(a.file, file, 0o600);
            queueId8({ action: 'install', id: c.appId, version: c.version, file: file, sha256: sha256File(file) });
            moved.push({ id: c.appId, version: c.version });
            say(c.appId + ' ' + c.version + ' ' + ID8_INSTALLS + ' (queued by the App Manager)');
        } else if (c.action === 'remove') {
            ensureApplyUnit(state);
            queueId8({ action: 'remove', id: c.appId });
            say(c.appId + ' is ' + ID8_REMOVES + ' (queued by the App Manager)');
        }
    });
    rmrf(amFile('pending.json'));
    return moved;
}
/* His renderer as our tool mgu-renderd, from the program and version it
 * has; installTool writes our unit over his and keeps a running renderer
 * running. With our tool installed first, his App Manager has written
 * its unit over ours: ours goes back, and runs from the next start. */
function amRenderer(state, stage) {
    var r = amService('renderer', 'mgu-renderd'), unit = path.join(CFG.systemd, 'mgu-renderd.service');
    var ours = installedTools().filter(function (t) { return t.id === 'mgu-renderd'; })[0];
    if (ours) {
        var text = serviceUnit(path.join(CFG.varOpt, 'mgu-renderd', 'current', 'mgu-renderd'));
        if (ours.component.mguService === 'renderer' && !bytesEqualFile(Buffer.from(text), unit)) {
            rootfsWindow([{ type: 'copy', data: text, path: unit, mode: 0o644 }]);
            runOk(CFG.systemctl, ['daemon-reload']);
            addPending(state, 'mgu-renderd', PENDING_NEXT_START);
            say('mgu-renderd.service is ours again; it runs ' + ours.version + ' from its next start');
        }
        return null;
    }
    if (!r) return null;
    var dir = path.join(stage, 'am-renderer'), pkgDir = path.join(dir, 'package');
    mkdirp(pkgDir);
    fs.writeFileSync(path.join(pkgDir, 'mgu-renderd'), fs.readFileSync(r.bin));
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'mgu-renderd', version: r.version,
        productName: 'GPU renderer', mguService: 'renderer' }, null, 2) + '\n');
    var a = validateService(r.bin, dir, pkgDir, readJson(path.join(pkgDir, 'package.json'))), tx = {};
    installTool(a, state, tx);
    return r.version;
}
/* Takes over: see the section's comment. Run under the lock, inside the
 * caller's snapshot. His daemon rewrites the renderer's unit while it runs,
 * so with it running past this boot (recmgr) only his units are disabled
 * and the rest waits for the next boot. -> the record, or null then */
function amAdopt(state, stage) {
    var rec = { at: new Date().toISOString(), version: amVersion(), app: (amAppOnUnit(AM.app) || {}).version || null,
        apps: amApps(), repos: amRepos(), renderer: null, tether: null };
    say("adopting IterioDev's App Manager " + (rec.version || '') + ': ' +
        (rec.apps.map(function (x) { return x.id + (x.version ? ' ' + x.version : ''); }).join(', ') || 'no apps'));
    var ops = [];
    [AM.daemon, AM.apply, AM.tether].forEach(function (u) {
        wantsLinks(u).forEach(function (l) { ops.push({ type: 'delete', path: l }); });
    });
    if (ops.length) { rootfsWindow(ops); runOk(CFG.systemctl, ['daemon-reload']); say('disabled ' + [AM.daemon, AM.apply, AM.tether].join(', ')); }
    var held = [AM.daemon, AM.tether].filter(function (u) { return !amStop(u); });
    if (held.length) {
        addPending(state, AM.app, AM_NEXT_BOOT);
        say(held.join(' and ') + ' run until the next boot (recmgr does not list them): the App Manager is adopted then');
        return null;
    }
    var t = amService('tether', 'ipheth-tether');
    if (t) rec.tether = t.version;
    var from = (readJsonOrNull(amFile('state.json')) || {}).installedFrom || {};
    amMoveQueue(state, stage).forEach(function (q) {
        rec.apps = rec.apps.filter(function (x) { return x.id !== q.id; })
            .concat([{ id: q.id, version: q.version, from: typeof from[q.id] === 'string' ? from[q.id] : null }]);
    });
    rec.renderer = amRenderer(state, stage);
    if (rec.renderer) say('the GPU renderer ' + rec.renderer + ' is the tool mgu-renderd');
    var old = readJsonOrNull(AM_RECORD);
    if (old && old.renderer && !rec.renderer) rec.renderer = old.renderer;
    if (old && old.tether && !rec.tether) rec.tether = old.tether;
    mkdirp(DEPLOY_DIR);
    writeAtomic(AM_RECORD, JSON.stringify(rec, null, 2) + '\n', 0o644);
    return rec;
}
/* Removes it: see the section's comment. */
function amRemove(state, stage) {
    var rec = amAdopt(state, stage), ops = [], ourTether = installedTools().some(function (t) { return t.id === 'ipheth-tether'; });
    if (!rec) throw refuse("IterioDev's App Manager runs until the next boot; it can be removed then");
    [AM.daemon, AM.apply].concat(ourTether ? [] : [AM.tether]).forEach(function (u) {
        if (lstatOrNull(path.join(CFG.systemd, u))) ops.push({ type: 'delete', path: path.join(CFG.systemd, u) });
    });
    if (ops.length) { rootfsWindow(ops); runOk(CFG.systemctl, ['daemon-reload']); }
    if (fs.existsSync(AM.home)) {
        rmrf(AM_REMOVED);
        fs.renameSync(AM.home, AM_REMOVED);
        say(AM.home + ' kept as ' + AM_REMOVED);
    }
    if (isId8()) {
        if (amAppOnUnit(AM.app)) uninstallAppId8(AM.app, state);
    } else if (installedApp(AM.app)) uninstallApp(AM.app, state);
    rec.removed = new Date().toISOString();
    writeAtomic(AM_RECORD, JSON.stringify(rec, null, 2) + '\n', 0o644);
    say("IterioDev's App Manager removed; the apps and services it installed stay");
}
/* One changing command around adopt or remove: a snapshot first; on a
 * failure his folder and the snapshot back, a renderer tool it made gone,
 * and his daemon running again when it ran. */
function amCommand(command, fn) {
    if (!amPresent()) throw refuse("IterioDev's App Manager is not on this head unit");
    var state = loadState(), stage = stageDir(), ran = unitState(AM.daemon, 'is-active') === 'active';
    var renderer = path.join(CFG.varOpt, 'mgu-renderd'), hadRenderer = fs.existsSync(renderer);
    var backup = takeSnapshot(command, amTouched());
    try {
        fn(state, stage);
        saveState(state); selfInstall();
    } catch (e) {
        process.stderr.write(command + ' failed, rolling back from ' + backup + '\n');
        try {
            if (!fs.existsSync(AM.home) && fs.existsSync(AM_REMOVED)) fs.renameSync(AM_REMOVED, AM.home);
            restoreSnapshot(backup);
            if (!hadRenderer) rmrf(renderer);
            systemctl(['daemon-reload']);
            if (ran && unitState(AM.daemon, 'is-active') !== 'active') systemctl(['start', AM.daemon]);
            pruneCreatedDirs(state);
        } catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        throw e;
    } finally { rmrf(stage); }
    return 0;
}
function cmdAppManager(args) {
    var sub = args.positional[0];
    if (!sub) {
        var s = amStatus();
        if (args.json) { say(JSON.stringify(s)); return 0; }
        if (!s) { say("IterioDev's App Manager: not on this head unit"); return 0; }
        say("IterioDev's App Manager: " + (s.present ? 'service ' + (s.version || '?') + ', daemon ' + s.daemon : 'removed') +
            (s.app ? ', app ' + s.app : ''));
        if (s.record) say('adopted ' + s.record.at + (s.record.removed ? ', removed ' + s.record.removed : '') + ': ' +
            (s.record.apps.map(function (x) { return x.id; }).join(', ') || 'no apps'));
        return 0;
    }
    if (sub !== 'adopt') throw refuse('appmanager needs adopt, or nothing');
    confirmYes(args, "adopt IterioDev's App Manager");
    return amCommand('adopt', amAdopt);
}

/* ---- provisioning fallback ---------------------------------------------------- */

function fallbackPresent() {
    return fs.existsSync(path.join(CFG.systemd, FALLBACK_UNIT));
}
function fallbackState() {
    var custom = readJsonOrNull(customAppsFile()) || {};
    var bound = bindMounted(mainJs());
    return { unit_present: fallbackPresent(),
        unit_enabled: fallbackPresent() ? unitState(FALLBACK_UNIT, 'is-enabled') : 'absent',
        unit_active: fallbackPresent() ? unitState(FALLBACK_UNIT, 'is-active') : 'absent',
        copy_present: fs.existsSync(FALLBACK_COPY),
        build_present: fs.existsSync(FALLBACK_BUILD_INSTALLED),
        main_bind_mounted: bound,
        active: fallbackPresent() && bound,
        apps: Object.keys(custom).sort() };
}
function fallbackBuildSource() {
    var here = path.join(HERE, 'fallback_build.js');
    return fs.existsSync(here) ? here : FALLBACK_BUILD_INSTALLED;
}
function buildFallbackCopy(dest, input) {
    var build = fallbackBuildSource();
    if (!fs.existsSync(build)) throw refuse('fallback_build.js missing beside mgu-deploy.js');
    var r = run(CFG.node, [build, input || mainJs(), dest, customAppsFile(), INPLACE_REQUEST], { allowFail: true });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) throw refuse('fallback build refused: ' + (r.stderr || '').trim());
}
function fallbackUnitSource() { return path.join(HERE, FALLBACK_UNIT); }
function fallbackTouched() {
    return [path.join(CFG.systemd, FALLBACK_UNIT),
        path.join(CFG.systemd, 'multi-user.target.wants', FALLBACK_UNIT),
        CFG.recmgr, FALLBACK_COPY, customAppsFile()];
}
/* The fallback copy of the stock main.js (or of input) with the
 * app-privacy patch on it, in a temporary file; refused when either
 * refuses. */
function buildPatchedCopy(input) {
    var tmp = path.join(DEPLOY_DIR, 'main.fallback-' + process.pid + '.js');
    mkdirp(DEPLOY_DIR);
    try {
        buildFallbackCopy(tmp, input);
        if (fs.existsSync(privacyTool())) {
            var pr = privacyApplyQuiet(['--main', tmp]);
            if (!pr || pr.status !== 0) throw refuse('app-privacy refused the fallback copy; not binding it');
        }
    } catch (e) { rmrf(tmp); throw e; }
    return tmp;
}
/* Before a change: the copy can be built (main.js not bound yet). */
function preflightFallback() {
    if (!FAKE && bindMounted(mainJs())) return;
    if (!fs.existsSync(fallbackUnitSource())) throw refuse(FALLBACK_UNIT + ' missing beside mgu-deploy.js');
    rmrf(buildPatchedCopy());
}
/* The copy is built from the stock main.js, so a bound copy is unmounted
 * for the build and bound again (the old copy when the build refuses).
 * The copy is written only when its bytes change: a manager that started
 * after it was written runs it (app-privacy's restartNeeded, and the
 * in-place install, go by that time). */
function rebuildFallback() {
    var wasBound = !FAKE && bindMounted(mainJs()), tmp;
    if (wasBound) runOk(CFG.umount, [mainJs()]);
    try {
        tmp = buildPatchedCopy();
    } catch (e) {
        if (wasBound && fs.existsSync(FALLBACK_COPY)) runOk(CFG.mount, ['--bind', FALLBACK_COPY, mainJs()]);
        throw e;
    }
    if (!bytesEqualFile(fs.readFileSync(tmp), FALLBACK_COPY)) copyFileMode(tmp, FALLBACK_COPY, 0o644);
    rmrf(tmp);
    if (!FAKE) runOk(CFG.mount, ['--bind', FALLBACK_COPY, mainJs()]);
    if (fs.existsSync(privacyTool())) privacyApplyQuiet(null);
}
function unbindFallback() {
    var wasBound = !FAKE && bindMounted(mainJs());
    if (wasBound) runOk(CFG.umount, [mainJs()]);
    rmrf(FALLBACK_COPY);
    /* The boot unit binds the copy before app-privacy's boot run, so the
     * stock main.js under it may hold an older patch or none. */
    if (fs.existsSync(privacyTool())) privacyApplyQuiet(null);
}
/* After a restore or a rolled-back change: the copy follows whether the
 * unit is there. */
function settleFallback() {
    if (fallbackPresent()) rebuildFallback(); else unbindFallback();
}
/* Turns the fallback on, or refreshes it: builder, unit, link and recmgr
 * entry where they differ, the copy rebuilt and bound. No bounce: the
 * caller bounces once. */
function ensureFallback(state) {
    var was = fallbackPresent();
    if (!fs.existsSync(fallbackUnitSource())) throw refuse(FALLBACK_UNIT + ' missing beside mgu-deploy.js');
    selfInstall(); // the boot unit runs current/fallback_build.js
    var unitDest = path.join(CFG.systemd, FALLBACK_UNIT);
    var link = path.join(CFG.systemd, 'multi-user.target.wants', FALLBACK_UNIT), cur = null, ops = [];
    if (!bytesEqualFile(fs.readFileSync(fallbackUnitSource()), unitDest)) {
        ops.push({ type: 'copy', src: fallbackUnitSource(), path: unitDest, mode: 0o644 });
    }
    try { cur = fs.readlinkSync(link); } catch (e) { /* not enabled */ }
    if (cur !== '../' + FALLBACK_UNIT) {
        if (!fs.existsSync(path.dirname(link))) noteCreatedDir(state, path.dirname(link));
        ops.push({ type: 'mkdir', path: path.dirname(link) });
        ops.push({ type: 'symlink', path: link, target: '../' + FALLBACK_UNIT });
    }
    var rec = recmgrOp(recmgrWith(recmgrText(), [FALLBACK_NAME], []));
    if (rec) ops.push(rec);
    if (ops.length) {
        rootfsWindow(ops);
        runOk(CFG.systemctl, ['daemon-reload']);
    }
    if (!fs.existsSync(customAppsFile())) writeCustomApps({});
    rebuildFallback();
    if (!was) say('provisioning fallback turned on');
}
function fallbackOn(state) {
    preflightFallback();
    var backup = takeSnapshot('fallback', fallbackTouched());
    try {
        ensureFallback(state);
        bounceManager();
    } catch (e) {
        process.stderr.write('fallback on failed, rolling back from ' + backup + '\n');
        try { restoreSnapshot(backup); settleFallback(); }
        catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        throw e;
    }
    say('provisioning fallback on');
}
function fallbackOff(state, opts) {
    opts = opts || {};
    var backup = opts.backup || takeSnapshot('fallback', fallbackTouched());
    try {
        if (fallbackPresent() && unitState(FALLBACK_UNIT, 'is-active') === 'active') {
            if (recmgrLoaded(FALLBACK_NAME)) runOk(CFG.systemctl, ['stop', FALLBACK_UNIT]);
            else addPending(state, FALLBACK_NAME, PENDING_RECMGR);
        }
        var ops = [{ type: 'delete', path: path.join(CFG.systemd, FALLBACK_UNIT) },
            { type: 'delete', path: path.join(CFG.systemd, 'multi-user.target.wants', FALLBACK_UNIT) }];
        var rec = recmgrOp(recmgrWith(recmgrText(), [], [FALLBACK_NAME]));
        if (rec) ops.push(rec);
        rootfsWindow(ops);
        runOk(CFG.systemctl, ['daemon-reload']);
        unbindFallback();
        pruneCreatedDirs(state);
        bounceManager();
    } catch (e) {
        process.stderr.write('fallback off failed, rolling back from ' + backup + '\n');
        try { restoreSnapshot(backup); settleFallback(); }
        catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        throw e;
    }
    say('provisioning fallback off');
}

/* ---- the retired installer's leftovers ------------------------------------------ */
/* The retired installer listed its apps through an edit of
 * main.js and kept the files it replaced beside the bundles as
 * <bundle>.<letters>bak (deploy/README.md). A backup app-privacy reports as
 * the stock reference is that bundle's verified stock copy. */
var BAK_NAME = /^[a-z]*bak$/;

function retiredBackups() {
    var out = [];
    [{ kind: 'main', bundle: mainJs() }, { kind: 'appmanagement', bundle: appManagementJs() }].forEach(function (b) {
        var dir = path.dirname(b.bundle), base = path.basename(b.bundle) + '.', names = [];
        try { names = fs.readdirSync(dir).sort(); } catch (e) { return; }
        names.forEach(function (n) {
            var st;
            if (n.indexOf(base) !== 0 || !BAK_NAME.test(n.slice(base.length))) return;
            st = lstatOrNull(path.join(dir, n));
            if (st && st.isFile()) out.push({ kind: b.kind, bundle: b.bundle, path: path.join(dir, n) });
        });
    });
    return out;
}
/* app-privacy's verdict on one backup: whether it is the stock bundle of
 * its kind. */
function stockReference(b) {
    var r = run(CFG.node, [privacyTool(), 'check', '--json', '--' + b.kind, b.path], { allowFail: true, timeout: 120000 });
    var result = lastJsonLine(r.stdout), file = null;
    ((result && result.files) || []).forEach(function (f) { if (f.kind === b.kind && f.path === b.path) file = f; });
    return !!(file && file.reference === true);
}
/* base.json with ignoreSignatureFailure set to false: an edit of that one
 * value, refused unless the key occurs exactly once with a boolean value. */
function signatureEdit(text) {
    var n = text.split('"ignoreSignatureFailure"').length - 1;
    if (n !== 1) return { error: baseJson() + ' names ignoreSignatureFailure ' + n + ' times' };
    var m = /("ignoreSignatureFailure"\s*:\s*)(true|false)(?=\s*[,}])/.exec(text), edited, cfg;
    if (!m) return { error: baseJson() + "'s ignoreSignatureFailure is neither true nor false" };
    if (m[2] === 'false') return { text: null };
    edited = text.slice(0, m.index) + m[1] + 'false' + text.slice(m.index + m[0].length);
    try { cfg = JSON.parse(edited); } catch (e) { cfg = null; }
    if (!cfg || !cfg.appManagement || cfg.appManagement.ignoreSignatureFailure !== false) {
        return { error: baseJson() + ': setting ignoreSignatureFailure to false does not read back' };
    }
    return { text: edited };
}
function ourInstalledApps() {
    return installedApps().filter(function (a) { return a.pkg.mguLocalOnly === true; });
}
/* The apps the retired edit lists, marked or not: registered apps whose id
 * is a string literal in main.js as the manager loads it (the fallback copy
 * is built from the edited file) and not in the stock copy. */
var ID_LITERAL = /"([A-Za-z0-9][A-Za-z0-9._-]*)"/g;
function idLiterals(file) {
    var text = fs.readFileSync(file, 'utf8'), out = {}, m;
    ID_LITERAL.lastIndex = 0;
    while ((m = ID_LITERAL.exec(text))) out[m[1]] = true;
    return out;
}
function retiredEditApps(stockMain) {
    var edited = idLiterals(mainJs()), stock = idLiterals(stockMain);
    return installedApps().filter(function (a) { return edited[a.id] && !stock[a.id]; });
}
/* What the migration would do, from the leftovers found now; null when
 * there is nothing to migrate (no verified stock copy). Refusals before any
 * change are thrown as such (exit 2). */
function retiredPlan() {
    var backups = retiredBackups();
    if (!backups.length) return null;
    if (!fs.existsSync(privacyTool())) {
        throw refuse('app-privacy, which tells the stock bundles, is not installed; the retired installer\'s leftovers stay');
    }
    var stock = {}, plan = { restore: [], remove: [], unverified: [], signature: null, apps: [] };
    backups.forEach(function (b) {
        b.stock = stockReference(b);
        if (b.stock && !stock[b.kind]) stock[b.kind] = b;
    });
    backups.forEach(function (b) {
        if (stock[b.kind]) plan.remove.push(b.path); else plan.unverified.push(b.path);
    });
    Object.keys(stock).sort().forEach(function (kind) {
        plan.restore.push({ kind: kind, bundle: stock[kind].bundle, from: stock[kind].path, sha256: sha256File(stock[kind].path) });
    });
    plan.unverified.forEach(function (p) {
        warn(p + ': not app-privacy\'s stock reference, and no backup beside it is; left as it is');
    });
    if (!plan.restore.length) return null;
    var edit = signatureEdit(fs.readFileSync(baseJson(), 'utf8'));
    if (edit.error) throw refuse(edit.error + '; the retired installer\'s leftovers stay');
    if (edit.text !== null) {
        var bst = fs.statSync(baseJson());
        plan.signature = { text: edit.text, mode: bst.mode & 0o7777, uid: bst.uid, gid: bst.gid };
    }
    var listed = readCustomApps(), carried = {};
    var main = plan.restore.filter(function (r) { return r.kind === 'main'; })[0];
    ourInstalledApps().concat(main ? retiredEditApps(main.from) : []).forEach(function (a) {
        if (!(a.id in listed) && !carried[a.id]) { carried[a.id] = true; plan.apps.push(a); }
    });
    return plan;
}
function retiredTouched(plan) {
    return [mainJs(), appManagementJs(), baseJson(), customAppsFile()]
        .concat(plan ? plan.remove.concat(plan.unverified) : retiredBackups().map(function (b) { return b.path; }))
        .concat(fallbackTouched());
}
/* The fallback copy the migration will build, built first: from the stock
 * copy when main.js goes back to it, else as for any app install. */
function preflightMigration(plan) {
    var main = plan.restore.filter(function (r) { return r.kind === 'main'; })[0];
    if (!main) { preflightFallback(); return; }
    if (!fs.existsSync(fallbackUnitSource())) throw refuse(FALLBACK_UNIT + ' missing beside mgu-deploy.js');
    rmrf(buildPatchedCopy(main.from));
}
/* Every registered app: whether its tile shows, and whether it is ours. */
function tileMap() {
    var m = {};
    installedApps().forEach(function (a) { m[a.id] = { visible: tileFlags(a.entry).visible, ours: a.pkg.mguLocalOnly === true }; });
    return m;
}
function privacyCheck() {
    return lastJsonLine(run(CFG.node, [privacyTool(), 'check', '--json'], { allowFail: true, timeout: 120000 }).stdout);
}
/* What is wrong once the manager is back: an app of ours, or any app
 * whose tile showed, gone; a tile that showed hidden; app-privacy not in
 * effect. */
function migrationProblems(before) {
    var now = tileMap(), out = [], res;
    Object.keys(before).sort().forEach(function (id) {
        if (!before[id].visible && !before[id].ours) return;
        if (!(id in now)) out.push(id + ' is no longer installed');
        else if (before[id].visible && !now[id].visible) out.push(id + "'s tile is hidden");
    });
    res = privacyCheck();
    if (!res || res.state !== 'patched' || res.restartNeeded) {
        out.push('app-privacy reports ' + (res ? res.state + (res.restartNeeded ? ', restart needed' : '') : 'no result'));
    }
    return out;
}
function verifyMigration(before) {
    say('watching our apps for ' + Math.round(CFG.migrateSettleMs / 1000) + 's');
    sleepMs(CFG.migrateSettleMs);
    var problems = migrationProblems(before);
    if (problems.length) { sleepMs(CFG.watchPollMs); problems = migrationProblems(before); }
    if (problems.length) throw fail('after the migration: ' + problems.join('; '));
    say('every tile that showed still shows (' + (Object.keys(before).filter(function (id) { return before[id].visible; })
        .sort().join(', ') || 'none') + '); app-privacy patched');
}
function shaOrNull(p) { try { return sha256File(p); } catch (e) { return null; } }
function migrateRetired(state, plan) {
    preflightMigration(plan);
    say("migrating the retired installer's leftovers: stock " + plan.restore.map(function (r) {
        return path.basename(r.bundle) + ' from ' + path.basename(r.from);
    }).join(', ') + '; removing ' + plan.remove.map(function (p) { return path.basename(p); }).join(', ') +
        (plan.signature ? '; ignoreSignatureFailure back to false' : ''));
    var before = tileMap(), fbWas = fallbackPresent(), bounced = false, backup;
    /* what the manager loads: main.js as bound, AppManagement.js, the copy */
    var loads = function () { return [mainJs(), appManagementJs(), FALLBACK_COPY].map(shaOrNull).join(' '); };
    var loadedBefore = loads(), wasBound = !FAKE && bindMounted(mainJs());
    /* the snapshot copies the main.js under the fallback copy */
    if (wasBound) runOk(CFG.umount, [mainJs()]);
    try { backup = takeSnapshot('migrate', retiredTouched(plan)); }
    catch (e) { if (wasBound) runOk(CFG.mount, ['--bind', FALLBACK_COPY, mainJs()]); throw e; }
    try {
        plan.apps.forEach(function (a) {
            customAppsPut(a.id, a.entry.provisioningCache);
            say('listed ' + a.id + ' in ' + customAppsFile() + ' with its registry flags');
        });
        var ops = plan.restore.map(function (r) {
            var st = fs.statSync(r.bundle);
            return { type: 'copy', src: r.from, path: r.bundle, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
        });
        if (plan.signature) {
            ops.push({ type: 'copy', data: plan.signature.text, path: baseJson(),
                mode: plan.signature.mode, uid: plan.signature.uid, gid: plan.signature.gid });
        }
        plan.remove.forEach(function (p) { ops.push({ type: 'delete', path: p }); });
        rootfsWindow(ops);
        plan.restore.forEach(function (r) {
            if (shaOrNull(r.bundle) !== r.sha256) throw fail(r.bundle + ' does not match its stock copy');
            say(r.bundle + ': stock (sha256 ' + r.sha256 + ')');
        });
        var pr = privacyApplyQuiet(null), res = pr ? lastJsonLine(pr.stdout) : null;
        if (!pr || pr.status !== 0 || !res || res.state !== 'patched') {
            throw fail('app-privacy apply on the stock bundles exited ' + (pr ? pr.status : 'missing'));
        }
        say('app-privacy applied to the stock bundles');
        ensureFallback(state);
        var check = privacyCheck();
        if ((loads() !== loadedBefore || (check && check.restartNeeded)) && managerPid()) {
            bounced = true;
            bounceManager();
            verifyMigration(before);
        } else {
            var problems = migrationProblems(before);
            if (problems.length) throw fail('after the migration: ' + problems.join('; '));
        }
    } catch (e) {
        if (e.code === 2) e.code = 1;
        process.stderr.write('migration failed (' + e.message + '), restoring ' + backup + '\n');
        try {
            restoreSnapshot(backup);
            if (fallbackPresent() !== fbWas) runOk(CFG.systemctl, ['daemon-reload']);
            settleFallback();
            pruneCreatedDirs(state);
            if (bounced) bounceManager();
            say("the retired installer's leftovers are back as they were");
        } catch (e2) {
            e.rollbackFailed = true;
            e.message = 'migration failed (' + e.message + ') and its rollback failed too (' + e2.message +
                '); ' + backup + ' holds the state before it';
        }
        throw e;
    }
    say("the retired installer's leftovers are migrated");
}
/* Before an app install, update or uninstall. A failed migration is
 * recorded for this boot, and the next commands of this boot go ahead
 * without it; `fallback migrate` tries again at any time. */
function migrateRetiredFirst(state) {
    var failed = state.retired_migration_failed;
    if (failed && failed.boot === bootId()) {
        if (retiredBackups().length) say("the retired installer's leftovers stay this boot: the migration failed (" + failed.error + ')');
        return;
    }
    var plan;
    try { plan = retiredPlan(); }
    catch (e) { if (e.code === 2) { warn(e.message); return; } throw e; }
    if (!plan) return;
    try {
        migrateRetired(state, plan);
        delete state.retired_migration_failed;
        saveState(state);
    } catch (e) {
        if (e.code === 2) { warn(e.message); return; }
        state.retired_migration_failed = { boot: bootId(), error: e.message };
        saveState(state);
        e.message += (e.rollbackFailed ? '' : '; the leftovers are restored') + '; no app was installed, updated or removed';
        throw e;
    }
}
function fallbackMigrate(state) {
    var plan = retiredPlan();
    if (!plan) {
        say(retiredBackups().length ? "none of the retired installer's backups is a stock bundle; nothing to migrate"
            : 'no leftovers of the retired installer to migrate');
        return false;
    }
    migrateRetired(state, plan);
    delete state.retired_migration_failed;
    return true;
}

/* ---- status and check ------------------------------------------------------- */

/* display-bridge.conf's TODO(on-car) notes: each one from its marker to
 * the end of its comment, on one line, after the key it precedes. */
function bridgeTodoLines() {
    var conf = path.join(CFG.varOpt, 'display-bridge', 'current', 'display-bridge.conf'), lines, out = [], i, j, text, key;
    try { lines = fs.readFileSync(conf, 'utf8').split('\n'); } catch (e) { return []; }
    for (i = 0; i < lines.length; i++) {
        var at = lines[i].indexOf('TODO(on-car)');
        if (at < 0 || !/^\s*#/.test(lines[i]) || lines[i].charAt(at - 1) === '"') continue;
        text = [lines[i].slice(at).trim()];
        for (j = i + 1; j < lines.length && /^\s*#/.test(lines[j]) && lines[j].indexOf('TODO(on-car)') < 0; j++) {
            text.push(lines[j].replace(/^\s*#\s?/, '').trim());
        }
        key = j < lines.length ? /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(lines[j]) : null;
        out.push((key ? key[1] + ': ' : '') + text.join(' '));
    }
    return out;
}
function journalTail(unit) {
    var r = run(CFG.journalctl, ['-u', unit, '-n', '5', '--no-pager', '-o', 'cat'], { allowFail: true });
    return (r.stdout || '').split('\n').filter(function (l) { return l; }).slice(-5);
}
function collectStatus(state) {
    var fb = fallbackState(), components = [], pending = [], seen = {};
    function pend(id, reason) {
        var k = id + ':' + reason;
        if (!seen[k]) { seen[k] = true; pending.push({ id: id, reason: reason }); }
    }
    state.pending_reboot.forEach(function (p) { pend(p.id, p.reason); });
    readPending().forEach(function (c) { pend(c.id, c.action === 'install' ? ID8_INSTALLS : ID8_REMOVES); });
    installedTools().forEach(function (t) {
        var units = (t.component.units || []).map(function (u) {
            return { name: u.name, enabled: unitState(u.name, 'is-enabled'),
                active: unitState(u.name, 'is-active'), journal: journalTail(u.name) };
        });
        if (recmgrPresent()) (t.component.recmgr || []).forEach(function (n) {
            if (recmgrHas(n) && !recmgrLoaded(n)) pend(t.id, PENDING_RECMGR);
            else if (!recmgrHas(n) && (t.component.restart || []).length) pend(t.id, 'recmgr entry missing');
        });
        components.push({ id: t.id, kind: 'tool', version: t.version, units: units, provides: t.component.mguProvides || null });
    });
    installedApps().forEach(function (app) {
        var tile = tileState(app, fb);
        components.push({ id: app.id, kind: 'app', version: app.version, uid: app.uid,
            installationSource: app.installationSource, running: appRunning(app.uid),
            tile_provisioned: tile.provisioned, tile_fallback: tile.fallback, tile_visible: tile.visible });
    });
    var backupCount = 0;
    if (fs.existsSync(BACKUPS_DIR)) backupCount = fs.readdirSync(BACKUPS_DIR).length;
    var unit = unitInfo();
    return { version: VERSION, unit: { hmi: unit.hmi, firmware: unit.firmware }, components: components, pending_reboot: pending,
        last_apply: readJsonOrNull(ID8_LAST),
        display_bridge_socket: fs.existsSync(CFG.socketPath),
        display_bridge_todo_on_car: bridgeTodoLines(),
        fallback: fb, backups: backupCount,
        retired_leftovers: retiredBackups().map(function (b) { return b.path; }),
        updater_tokens: storedTokens().length,
        appmanager: amStatus(),
        idrive7: { apps: i7Apps(state) },
        stock_backup: fs.existsSync(path.join(BACKUPS_DIR, 'stock')) };
}
function cmdStatus(args) {
    var s = collectStatus(loadState());
    if (args.json) { say(JSON.stringify(s)); return 0; }
    say('mgu-deploy ' + VERSION);
    say('head unit: ' + (s.unit.hmi ? hmiName(s.unit.hmi) : 'unknown') + ' (' + unitInfo().basis + '), firmware ' +
        (s.unit.firmware || 'unknown'));
    say('components:');
    s.components.forEach(function (c) {
        if (c.kind === 'tool') {
            say('  tool ' + c.id + ' ' + c.version);
            c.units.forEach(function (u) {
                say('    ' + u.name + ' enabled=' + u.enabled + ' active=' + u.active);
                u.journal.forEach(function (l) { say('      ' + l); });
            });
        } else {
            say('  app ' + c.id + ' ' + c.version + ' uid=' + c.uid + ' source=' + c.installationSource +
                ' running=' + c.running + ' tile=' + (c.tile_provisioned ? 'provisioned' :
                (c.tile_fallback ? 'fallback' : 'hidden')));
        }
    });
    if (!s.components.length) say('  (none)');
    say('display-bridge socket: ' + (s.display_bridge_socket ? 'present' : 'absent'));
    s.display_bridge_todo_on_car.forEach(function (l) { say('  ' + l); });
    say('fallback: ' + (s.fallback.active ? 'active' : 'inactive') +
        ' (unit ' + (s.fallback.unit_present ? 'present' : 'absent') +
        ', bind-mounted ' + s.fallback.main_bind_mounted + ', apps ' +
        (s.fallback.apps.join(', ') || '-') + ')');
    say('backups: ' + s.backups + (s.stock_backup ? ' (stock present)' : ' (no stock)'));
    if (s.retired_leftovers.length) say("retired installer's leftovers: " + s.retired_leftovers.join(', '));
    say('updater tokens: ' + s.updater_tokens);
    if (s.appmanager) {
        say("IterioDev's App Manager: " + (s.appmanager.present ? 'service ' + (s.appmanager.version || '?') + ', daemon ' +
            s.appmanager.daemon + (s.appmanager.record ? ', adopted' : '') : 'removed'));
    }
    s.pending_reboot.forEach(function (p) { say('pending reboot: ' + p.id + ' - ' + p.reason); });
    if (s.last_apply) {
        say('last apply at the start (' + s.last_apply.at + '):');
        s.last_apply.results.forEach(function (r) {
            say('  ' + r.id + ' ' + r.action + ': ' + (r.ok ? 'ok' : 'failed: ' + r.error));
        });
    }
    return 0;
}
function artifactTouched(a) {
    if (a.kind === 'tool') {
        /* the installed version's drop-ins too: an update that drops one removes it */
        var installed = installedTools().filter(function (t) { return t.id === a.id; })[0];
        var gone = ((installed && installed.component.dropins) || []).map(dropinPath);
        return toolTouched(a.component).concat(gone).concat(i7Takeover(a).paths)
            .concat([path.join(CFG.varOpt, a.id, 'versions', a.version)]).concat(uplinkDropIns(a.id));
    }
    if (isId8()) return applyTouched();
    var existing = null;
    try { existing = installedApp(a.id); } catch (e) { /* listed without it */ }
    return appTouched(a, existing).concat(uplinkDropIns(a.id));
}
function cmdCheck(args) {
    var hard = [], notes = [];
    function line(ok, msg, isHard) {
        say((ok ? msg : 'NOT ' + msg));
        if (!ok && isHard) hard.push(msg); else if (!ok) notes.push(msg);
    }
    var isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
    line(FAKE || isRoot, 'running as root' + (FAKE ? ' (fake root)' : ''), !FAKE);
    say('node: ' + process.version);
    say('head unit: ' + (unitInfo().hmi ? hmiName(unitInfo().hmi) : 'unknown') + ' (' + unitInfo().basis + '), firmware ' +
        (unitInfo().firmware || 'unknown'));
    var sv = systemctl(['--version']);
    var svLine = ((sv.stdout || '').split('\n')[0] || 'unknown').trim();
    say('systemd: ' + svLine);
    line(/237/.test(svLine), 'systemd 237 (found: ' + svLine + ')', false);
    say('/ mount: ' + rootMountMode());
    var writable = false;
    try {
        mkdirp(CFG.varOpt);
        var probe = path.join(CFG.varOpt, '.mgu-deploy-probe-' + process.pid);
        fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); writable = true;
    } catch (e) { /* not writable */ }
    line(writable, CFG.varOpt + ' writable', true);
    var df = run(CFG.df, [CFG.varOpt], { allowFail: true });
    if (df.status === 0) say('free space:\n' + (df.stdout || '').trim());
    else say('free space: df unavailable, skipped');
    ['mgu_wayland', 'tm_oap_app'].forEach(function (g) {
        line(groupExists(g), 'group ' + g + ' present', true);
    });
    line(fs.existsSync(path.join(CFG.systemd, 'winston.service')) ||
        fs.existsSync('/lib/systemd/system/winston.service') ||
        fs.existsSync('/usr/lib/systemd/system/winston.service') ||
        fs.existsSync(path.join(path.dirname(CFG.systemd), 'winston.service')),
        'winston.service unit file present', false);
    say('oapcontroller: ' + unitState('oapcontroller.service', 'is-active') +
        '; app manager pid: ' + (managerPid() || 'not found'));
    var cfg = readJsonOrNull(baseJson());
    if (cfg) {
        say('usableUidsAndGids: ' + JSON.stringify(cfg.usableUidsAndGids || null));
        say('ignoreSignatureFailure: ' + JSON.stringify(
            cfg.appManagement && cfg.appManagement.ignoreSignatureFailure));
    } else line(false, 'base.json readable at ' + baseJson(), false);
    var tool = privacyTool();
    if (fs.existsSync(tool)) {
        var r = run(CFG.node, [tool, 'check', '--json'], { allowFail: true });
        var lines = (r.stdout || '').split('\n').filter(function (l) { return l.trim(); });
        say('app-privacy: ' + (lines[lines.length - 1] || ('exit ' + r.status)));
    } else say('app-privacy: not installed (' + tool + ')');
    var stockCopies = 0;
    retiredBackups().forEach(function (b) {
        var verdict = fs.existsSync(tool) ? stockReference(b) : null;
        if (verdict) stockCopies++;
        say("retired installer's backup: " + b.path + (verdict === null ? '' :
            (verdict ? ' (the stock ' : ' (not the stock ') + path.basename(b.bundle) + ')'));
    });
    if (stockCopies) say('the next app install, update or uninstall migrates them, as does fallback migrate');
    say('display-bridge socket unit: ' + unitState('display-bridge.socket', 'is-active') +
        '; service: ' + unitState('display-bridge.service', 'is-active') +
        '; socket file: ' + (fs.existsSync(CFG.socketPath) ? 'present' : 'absent'));
    bridgeTodoLines().forEach(function (l) { say('  ' + l); });
    var fb = fallbackState();
    say('fallback: ' + (fb.active ? 'active' : 'inactive'));
    installedApps().forEach(function (app) {
        var tile = tileState(app, fb);
        say('app ' + app.id + ' ' + app.version + ': tile ' +
            (tile.provisioned ? 'provisioned' : (tile.fallback ? 'via fallback' : 'hidden')) +
            ' (registry provisioningCache)');
    });
    var files = args.artifacts.length ? args.artifacts : [];
    if (!files.length && fs.existsSync(path.join(HERE, 'artifacts'))) {
        try { files = kitArtifacts(); } catch (e) { files = []; }
    }
    if (files.length) {
        var stage = stageDir();
        try {
            files.forEach(function (f) {
                try {
                    var v = validateArtifact(path.resolve(f), stage), why = incompatible(v);
                    if (why) throw refuse(why);
                    var a = v.kind !== 'app' ? v : isId8() ? id8Package(v, stage) : prepareApp(v, stage);
                    say('artifact ' + f + ': ' + (a.service ? 'service ' : '') + a.kind + ' ' + a.id + ' ' + a.version + ' ok' +
                        (a.hmi ? ' (for ' + a.hmi.map(hmiName).join(' and ') + ')' : ''));
                    artifactTouched(a).forEach(function (p) { say('  would touch ' + p); });
                } catch (e) { line(false, 'artifact ' + f + ' valid: ' + e.message, true); }
            });
        } finally { rmrf(stage); }
    }
    return hard.length ? 2 : 0;
}

/* ---- the updater's sources and tokens ------------------------------------------------ */
/* The updater's tokens (native/mgu-updater, "Tokens"), each its own,
 * not a source's: the token's text in /var/opt/mgu-updater/credentials/
 * token-<id> and its entry in credentials/tokens.json, root's alone in a
 * 0700 folder. updater-token reads a token from stdin (never an argument:
 * arguments show in ps) and stores it unless one with that text is stored
 * already; the updater notices the files, asks GitHub whose it is and reads
 * the sources that need it. --list names the tokens (id, label, account),
 * --remove <id> removes one. Tokens are the updater's config: uninstalling
 * mgu-updater removes them with the rest of /var/opt/mgu-updater. Output
 * names a token's length, never its value. */
var TOKEN_MAX = 512;
var TOKEN_ID = /^[0-9a-f]{8}$/;
function tokensFile() { return path.join(credentialsDir(), 'tokens.json'); }
function tokenFile(id) { return path.join(credentialsDir(), 'token-' + id); }
function readStdin(max) {
    var chunks = [], total = 0, buf = Buffer.alloc(4096), n, waited = 0;
    for (;;) {
        try { n = fs.readSync(0, buf, 0, buf.length, null); }
        catch (e) {
            if (e.code === 'EAGAIN' && waited < 30000) { sleepMs(50); waited += 50; continue; }
            if (e.code === 'EOF') break;
            throw e;
        }
        if (!n) break;
        chunks.push(Buffer.from(buf.slice(0, n)));
        total += n;
        if (total > max) break;
    }
    return Buffer.concat(chunks);
}
/* A root-only file written by rename. */
function writePrivate(file, text) {
    var tmp = file + '.tmp-' + process.pid, fd;
    rmrf(tmp);
    fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o600);
    chownMaybe(tmp, 0, 0);
    fs.renameSync(tmp, file);
}
/* The stored tokens: tokens.json's entries whose file is there, then the
 * files it does not name. */
function storedTokens() {
    var names = [], doc = readJsonOrNull(tokensFile()), seen = {}, out = [];
    try { names = fs.readdirSync(credentialsDir()).sort(); } catch (e) { /* none yet */ }
    var ids = names.map(function (n) { var m = /^token-([0-9a-f]{8})$/.exec(n); return m && m[1]; }).filter(Boolean);
    (Array.isArray(doc) ? doc : []).forEach(function (t) {
        if (t && TOKEN_ID.test(t.id) && ids.indexOf(t.id) >= 0 && !seen[t.id]) { seen[t.id] = true; out.push(t); }
    });
    ids.filter(function (id) { return !seen[id]; }).forEach(function (id) { out.push({ id: id, kind: 'github' }); });
    return out;
}
function cmdUpdaterToken(args) {
    var state = loadState(), list = storedTokens();
    if (args.positional.length) throw refuse('updater-token takes the token on stdin, --list or --remove <id>; a token is no source\'s');
    if (args.list) {
        if (args.json) {
            say(JSON.stringify(list.map(function (t) {
                return { id: t.id, label: t.label || null, login: t.login || null, addedAt: t.addedAt || null };
            })));
        } else if (!list.length) {
            say('no updater tokens');
        } else {
            list.forEach(function (t) { say(t.id + '  ' + (t.label || '-') + '  ' + (t.login || '-')); });
        }
        return 0;
    }
    if (args.remove !== null) {
        if (!TOKEN_ID.test(args.remove)) throw refuse('--remove takes a token id (updater-token --list names them)');
        if (!list.some(function (t) { return t.id === args.remove; })) { say('updater token ' + args.remove + ': absent already'); return 0; }
        takeSnapshot('updater-token', [tokenFile(args.remove)]);
        rmrf(tokenFile(args.remove));
        // the entries as they are now: the updater may have written since
        writePrivate(tokensFile(), JSON.stringify(storedTokens(), null, 2) + '\n');
        saveState(state);
        say('updater token ' + args.remove + ' removed');
        return 0;
    }
    if (process.stdin.isTTY) throw refuse('updater-token reads the token from stdin: sh mgu-deploy.sh updater-token < <file>');
    var data = readStdin(TOKEN_MAX + 2);
    if (data.length > TOKEN_MAX + 2) throw refuse('token input is over ' + TOKEN_MAX + ' bytes; nothing written');
    var text = data.toString('utf8').replace(/\r?\n$/, '');
    if (Buffer.byteLength(text) > TOKEN_MAX) throw refuse('token is over ' + TOKEN_MAX + ' bytes; nothing written');
    if (!text) throw refuse('no token on stdin; nothing written');
    if (/[\r\n]/.test(text)) throw refuse('token input has more than one line; nothing written');
    if (/[\s\x00-\x1f\x7f]/.test(text)) throw refuse('token has spaces or control characters; nothing written');
    var same = list.filter(function (t) {
        try { return fs.readFileSync(tokenFile(t.id), 'utf8').trim() === text; } catch (e) { return false; }
    })[0];
    if (same) { say('updater token: stored already as ' + same.id); return 0; }
    var id;
    do { id = crypto.randomBytes(4).toString('hex'); } while (lstatOrNull(tokenFile(id)));
    takeSnapshot('updater-token', [tokenFile(id)]);
    var created = [credentialsDir(), updaterDir()].filter(function (d) { return !fs.existsSync(d); });
    mkdirp(credentialsDir(), 0o700);
    fs.chmodSync(credentialsDir(), 0o700);
    created.forEach(function (d) { noteCreatedDir(state, d); });
    writePrivate(tokenFile(id), text + '\n');
    // the entries as they are now: the updater may have written since
    var now = storedTokens().filter(function (t) { return t.id !== id; });
    now.push({ id: id, kind: 'github', addedAt: Date.now() });
    writePrivate(tokensFile(), JSON.stringify(now, null, 2) + '\n');
    saveState(state);
    say('updater token ' + id + ' written (' + Buffer.byteLength(text) + ' bytes, mode 0600); the updater checks it with GitHub');
    return 0;
}
/* The updater's sources (native/mgu-updater), seeded from stdin by the
 * installers when the updater has none yet: /var/opt/mgu-updater/
 * sources.json, root's, 0600. Sources the owner added since stay: an
 * existing file is never replaced. Nothing is written while mgu-updater is
 * not installed. */
var SOURCES_MAX = 65536;
function cmdUpdaterSources() {
    var file = sourcesFile(), state = loadState();
    if (process.stdin.isTTY) throw refuse('updater-sources reads sources.json from stdin: sh mgu-deploy.sh updater-sources < sources.json');
    var data = readStdin(SOURCES_MAX + 1), doc;
    if (data.length > SOURCES_MAX) throw refuse('sources input is over ' + SOURCES_MAX + ' bytes; nothing written');
    try { doc = JSON.parse(data.toString('utf8')); } catch (e) { throw refuse('sources input is not JSON; nothing written'); }
    var ids = {};
    if (!doc || doc.schema !== 1 || !Array.isArray(doc.sources) || !doc.sources.every(function (src) {
        var ok = src && SOURCE_ID.test(src.id || '') && !ids[src.id] && ['github', 'https', 'file'].indexOf(src.type) >= 0;
        if (ok) ids[src.id] = true;
        return ok;
    })) {
        throw refuse('sources input is not {"schema": 1, "sources": [{id, type}...]} with distinct ids; nothing written');
    }
    if (!lstatOrNull(path.join(updaterDir(), 'current'))) { say('mgu-updater is not installed; sources not written'); return 0; }
    if (lstatOrNull(file)) {
        var cur = readJsonOrNull(file);
        say('updater sources kept: ' + file + ' (' + (cur && Array.isArray(cur.sources) ? cur.sources.length + ' sources' : 'unreadable') + ')');
        return 0;
    }
    takeSnapshot('updater-sources', [file]);
    var tmp = file + '.tmp-' + process.pid, fd;
    rmrf(tmp);
    fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(doc, null, 2) + '\n'); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o600);
    chownMaybe(tmp, 0, 0);
    fs.renameSync(tmp, file);
    saveState(state);
    say('updater sources written to ' + file + ': ' + doc.sources.map(function (src) { return src.id; }).join(', '));
    return 0;
}

/* ---- the donor for builds outside this tool ------------------------------------------ */
/* The bundle module mode takes the oap-sdk from (oap_link.js), copied where
 * any uid can read it: <run>/sdk-donor/javascript/app.js beside a
 * package.json naming its oap-sdk version, the layout of an app's folder;
 * and in <run>/sdk-donor/oap-sdk/ the module module mode generates from it
 * (index.js, package.json). The updater hands the bundle to a repository's
 * own build (MGU_SDK_DONOR), and the module to a build that asks for it. */
function cmdSdkDonor(args) {
    var m;
    try { m = linker().sdkModule(unitDonors()); } catch (e) { throw refuse(e.message); }
    var dir = path.join(CFG.run, 'sdk-donor'), js = path.join(dir, 'javascript', 'app.js'), mod = path.join(dir, 'oap-sdk');
    var pkg = JSON.stringify({ name: 'sdk-donor', version: '0.0.0', description: 'copied from ' + m.donor,
        dependencies: { 'oap-sdk': m.sdkVersion || '0.0.0' } }, null, 2) + '\n';
    mkdirp(path.join(dir, 'javascript'), 0o755);
    mkdirp(mod, 0o755);
    [CFG.run, dir, path.join(dir, 'javascript'), mod].forEach(function (p) { fs.chmodSync(p, 0o755); });
    if (!bytesEqualFile(Buffer.from(m.text), js)) writeAtomic(js, m.text, 0o644);
    if (!bytesEqualFile(Buffer.from(pkg), path.join(dir, 'package.json'))) writeAtomic(path.join(dir, 'package.json'), pkg, 0o644);
    if (!bytesEqualFile(Buffer.from(m.index), path.join(mod, 'index.js'))) writeAtomic(path.join(mod, 'index.js'), m.index, 0o644);
    if (!bytesEqualFile(Buffer.from(m.pkg), path.join(mod, 'package.json'))) writeAtomic(path.join(mod, 'package.json'), m.pkg, 0o644);
    if (args.json) say(JSON.stringify({ path: js, module: mod, donor: m.donor, sdkVersion: m.sdkVersion }));
    else say(js + ' (from ' + m.donor + ', oap-sdk ' + (m.sdkVersion || 'unknown') + ')');
    return 0;
}


/* ---- commands ----------------------------------------------------------------- */

function confirmYes(args, what) {
    if (args.yes) return;
    if (!process.stdin.isTTY) throw refuse(what + ' requires --yes (stdin is not a TTY)');
    process.stdout.write(what + '. Type YES to continue: ');
    var buf = Buffer.alloc(64), n = 0;
    try { n = fs.readSync(0, buf, 0, 64, null); } catch (e) { /* refused below */ }
    if (buf.toString('utf8', 0, n).trim() !== 'YES') throw refuse('confirmation given was not YES');
}
/* Each artifact is its own transaction: its own snapshot, and on failure
 * only its own changes are undone. Artifacts installed before it in the
 * same call stay installed. */
function cmdInstall(args) {
    var files = args.artifacts.length ? args.artifacts.map(function (f) { return path.resolve(f); })
        : kitArtifacts();
    var stage = stageDir(), state = loadState(), done = [], attempted = false, id8 = isId8();
    try {
        var validated = files.map(function (f) { return validateArtifact(f, stage); });
        validated = orderArtifacts(validated);
        /* a kit (--skip-older) installs what is for this unit and leaves the rest */
        validated = validated.filter(function (a) {
            var why = incompatible(a);
            if (why && !args.skipOlder) throw refuse(why);
            if (why) say(a.id + ' ' + a.version + ' skipped: ' + why);
            return !why;
        });
        validated.forEach(function (a) {
            var foreign = a.kind === 'tool' && (a.service || a.provides || (a.component.dropins || []).length) ? foreignUnit(a.component) : null;
            if (foreign) {
                throw refuse(a.id + ' ' + a.version + ': ' + foreign + ' is installed, but by no tool of ours (another manager runs it); remove it there first');
            }
        });
        if (!unitInfo().hmi) warn('which head unit this is is unknown (' + unitInfo().basis + '): mguHmi is not checked');
        var decisions = {};
        validated.forEach(function (a) {
            if (a.kind === 'app') decisions[a.id] = appDecision(a, args.skipOlder);
            /* the installed version again on iDrive 8: a queued removal of it is dropped */
            if (id8 && a.kind === 'app' && decisions[a.id].action === 'current' &&
                readPending().some(function (c) { return c.id === a.id && c.action === 'remove'; })) {
                queueId8({ id: a.id });
                say('the queued removal of ' + a.id + ' is dropped');
            }
        });
        if (args.skipOlder) {
            var tools = installedTools();
            validated = validated.filter(function (a) {
                var t = a.kind === 'tool' && tools.filter(function (t) { return t.id === a.id; })[0];
                var older = t && semverCmp(a.version, t.version) < 0;
                if (older) say(a.id + ' ' + a.version + ' skipped; ' + t.version + ' is installed');
                return !older;
            });
        }
        var work = validated.filter(function (a) {
            return a.kind !== 'app' || ['current', 'older'].indexOf(decisions[a.id].action) < 0;
        }).map(function (a) { return a.kind !== 'app' ? a : id8 ? id8Package(a, stage) : prepareApp(a, stage); });
        validated.forEach(function (a) {
            if (a.kind === 'app' && decisions[a.id].action === 'older') {
                say(a.id + ' ' + a.version + ' skipped; ' + decisions[a.id].existing.version + ' is installed');
            }
            if (a.kind === 'app' && decisions[a.id].action === 'current') {
                say(a.id + ' ' + a.version + ' already installed; nothing to change');
            }
        });
        var apps = work.some(function (a) { return a.kind === 'app'; }), migrated = id8;
        if (apps && !id8) preflightFallback();
        if (work.length) {
            ensureStock('install', work.reduce(function (all, a) { return all.concat(artifactTouched(a)); },
                apps && !id8 && retiredBackups().length ? retiredTouched(null) : []));
        }
        work.forEach(function (a) {
            /* after the tools, app-privacy among them, before the first app */
            if (a.kind === 'app' && !migrated) {
                migrated = true;
                try { migrateRetiredFirst(state); } catch (e) {
                    if (done.length) say('installed before this failure, and kept: ' + done.join(', '));
                    throw e;
                }
            }
            var tx = {}, backup = takeSnapshot('install', artifactTouched(a));
            attempted = true;
            if (a.kind === 'app' && !id8) beginAppTx(tx);
            try {
                if (a.kind === 'tool') installTool(a, state, tx);
                else if (id8) installAppId8(a, state, decisions[a.id]);
                else installApp(a, state, decisions[a.id]);
                syncDropIns();
                done.push(a.id + ' ' + a.version);
            } catch (e) {
                process.stderr.write(a.id + ' ' + a.version + ' failed: ' + e.message + '\n');
                try {
                    if (a.kind === 'tool') rollbackTool(a, tx, backup, e, state);
                    else if (id8) { restoreSnapshot(backup); pruneCreatedDirs(state); }
                    else rollbackApp(a, tx, backup, state);
                } catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
                if (done.length) {
                    say('installed before this failure, and kept: ' + done.join(', '));
                    if (e.code === 2) e.code = 1;
                }
                throw e;
            }
        });
    } finally {
        try {
            if (done.length) selfInstall();
            if (attempted) saveState(state);
        } finally { rmrf(stage); }
    }
    return 0;
}
/* What an app install may leave behind: app homes the manager created,
 * the fallback app list and the fallback itself. */
function beginAppTx(tx) {
    tx.homes = fs.existsSync(CFG.oap) ? fs.readdirSync(CFG.oap) : [];
    tx.custom = fs.existsSync(customAppsFile()) ? sha256File(customAppsFile()) : null;
    tx.fallback = fallbackPresent();
}
/* The snapshot puts the registry entry, the preinstalled package,
 * custom_apps.json and the fallback back; an app home the manager created
 * for this app during the attempt goes; the fallback copy follows. The
 * app-privacy patch stays applied: app-privacy remains installed. */
function rollbackApp(a, tx, backup, state) {
    say('rolling back ' + a.id + ' ' + a.version + ' from ' + backup);
    restoreSnapshot(backup);
    if (fs.existsSync(CFG.oap)) {
        fs.readdirSync(CFG.oap).forEach(function (n) {
            if (tx.homes.indexOf(n) >= 0 || !/^oap_\d+$/.test(n)) return;
            var pkg = readJsonOrNull(path.join(CFG.oap, n, 'source', 'package.json'));
            if (pkg && pkg.name === a.id) { rmrf(path.join(CFG.oap, n)); say('removed ' + path.join(CFG.oap, n) + ' (partial install)'); }
        });
    }
    var custom = fs.existsSync(customAppsFile()) ? sha256File(customAppsFile()) : null;
    if (fallbackPresent() !== tx.fallback) runOk(CFG.systemctl, ['daemon-reload']);
    if (fallbackPresent() !== tx.fallback || custom !== tx.custom) settleFallback();
    pruneCreatedDirs(state);
    say('the app-privacy patch stays applied (app-privacy remains installed)');
}
/* Our apps: registry entries whose source is marked mguLocalOnly. An
 * entry or source that cannot be read counts as ours. */
function ourApps() {
    return registryEntries().filter(function (r) {
        if (r.unreadable || !r.entry.userId) return true;
        var pkg = readJsonOrNull(path.join(appHome(r.entry.userId), 'source', 'package.json'));
        return !pkg || pkg.mguLocalOnly === true;
    }).map(function (r) { return r.id; });
}
function cmdUninstall(args) {
    var id = args.positional[0];
    if (!id) throw refuse('uninstall needs a component id');
    if (id === 'mgu-deploy') {
        throw refuse('mgu-deploy: the deploy tool does not uninstall itself; restore puts back what it changed, ' +
            'and ' + DEPLOY_DIR + ' (its state and backups) is removed by hand when wanted');
    }
    if (id === AM.app && amPresent()) return amCommand('uninstall', amRemove);
    var state = loadState();
    var isTool = installedTools().some(function (t) { return t.id === id; });
    if (!isTool && isId8()) return uninstallQueuedId8(id, state);
    if (!isTool && !readJsonOrNull(appEntryFile(id))) throw refuse(id + ': not installed');
    if (id === 'app-privacy' && ourApps().length) {
        throw refuse('app-privacy stays while our apps are installed (' + ourApps().join(', ') + '); uninstall them first');
    }
    if (!isTool) {
        if (retiredBackups().length) ensureStock('uninstall', touchedForUninstall(id).concat(retiredTouched(null)));
        migrateRetiredFirst(state);
    }
    var backup = takeSnapshot('uninstall', touchedForUninstall(id));
    try {
        if (isTool) uninstallTool(id, state); else uninstallApp(id, state);
        syncDropIns();
        state.pending_reboot = state.pending_reboot.filter(function (p) { return p.id !== id; });
        saveState(state); selfInstall();
    } catch (e) {
        if (e.code !== 2) {
            process.stderr.write('uninstall failed, rolling back from ' + backup + '\n');
            try { restoreSnapshot(backup); settleFallback(); } catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        }
        throw e;
    }
    return 0;
}
/* rollback <id>: a tool's current back to the one other version kept.
 * Its restart[] units follow the install rules and the health check; a
 * failed check returns current and restarts them again. Unit files stay
 * as the newer version installed them (they run from current/). An app
 * has no rollback: the manager refuses a downgrade. */
function cmdRollback(args) {
    var id = args.positional[0];
    if (!id) throw refuse('rollback needs a tool id');
    var tool = installedTools().filter(function (t) { return t.id === id; })[0];
    if (!tool) {
        if (readJsonOrNull(appEntryFile(id))) {
            throw refuse(id + ' is an app: rollback applies to tools; uninstall it, then install the older artifact');
        }
        throw refuse(id + ': no installed tool with that id');
    }
    var root = tool.root, cur = currentTarget(root);
    var others = fs.readdirSync(path.join(root, 'versions')).filter(function (v) {
        return v !== cur && semverParts(v);
    }).sort();
    if (!others.length) throw refuse(id + ' ' + cur + ': no other version is kept to roll back to');
    if (others.length > 1) throw refuse(id + ': several versions are kept (' + others.join(', ') + '); install the one wanted');
    var target = others[0], tc = readJsonOrNull(path.join(root, 'versions', target, 'component.json'));
    if (!tc || tc.id !== id) throw refuse(id + ': versions/' + target + ' has no readable component.json');
    var state = loadState();
    takeSnapshot('rollback', toolTouched(tool.component));
    say('rolling back ' + id + ' ' + cur + ' -> ' + target);
    switchCurrent(root, target);
    var names = function (c) { return (c.units || []).map(function (u) { return u.name; }).sort().join(', '); };
    if (names(tool.component) !== names(tc)) {
        warn('unit files stay as ' + cur + ' installed them (' + (names(tool.component) || 'none') + '); ' +
            target + ' lists ' + (names(tc) || 'none') + '. Install an artifact to change them.');
    }
    if (id === 'mgu-deploy') {
        ensureShim();
        saveState(state);
        say('mgu-deploy ' + target + ' is current; the shim runs it from the next call');
        return 0;
    }
    try {
        /* a running service started by a keepRunning version stays running either way */
        var keep = Object.assign({}, tc, { keepRunning: tc.keepRunning || tool.component.keepRunning });
        var touched = applyRestarts(keep, state, false), bad = healthCheck(touched);
        if (bad) {
            switchCurrent(root, cur);
            say(cur + ' is current again');
            restartAgain(touched, id + ' ' + cur);
            throw fail(id + ' ' + target + ': ' + bad);
        }
        if (id === 'app-privacy') {
            var pr = privacyApplyAndBounce();
            if (!pr.ok) {
                switchCurrent(root, cur);
                say(cur + ' is current again');
                var again = privacyApplyAndBounce();
                if (!again.ok) say('app-privacy ' + cur + ' apply failed too: ' + again.why);
                throw fail('app-privacy ' + target + ': ' + pr.why);
            }
        }
    } finally { saveState(state); }
    say(id + ' rolled back to ' + target);
    return 0;
}
function cmdRestore(args) {
    var name = args.positional[0] || 'stock';
    var dir = path.join(BACKUPS_DIR, name);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw refuse('no backup named ' + name);
    var data = readJson(path.join(dir, 'manifest.json')), state = loadState();
    preflightRestore(name, dir, data);
    confirmYes(args, 'restore from ' + name + ' and remove components it shows as absent');
    var paths = data.entries.map(function (e) { return e.path; }).concat(fallbackTouched());
    installedTools().forEach(function (t) { paths = paths.concat(toolTouched(t.component)); });
    installedApps().forEach(function (app) { paths.push(appEntryFile(app.id)); });
    /* a backup holding main.js itself is restored, and the state before it
     * snapshotted, with the fallback copy unbound; it is bound again below */
    var unbound = !FAKE && bindMounted(mainJs()) &&
        data.entries.some(function (e) { return e.path === mainJs() && e.kind === 'file'; });
    if (unbound) runOk(CFG.umount, [mainJs()]);
    var backup;
    try { backup = takeSnapshot('restore', paths); }
    catch (e) { if (unbound) runOk(CFG.mount, ['--bind', FALLBACK_COPY, mainJs()]); throw e; }
    var appsBefore = installedApps().map(function (a) { return a.id; });
    try {
        var fbWas = fallbackState();
        var privacyCurrent = path.join(CFG.varOpt, 'app-privacy', 'current'), privacyReverted = false;
        if (data.entries.some(function (e) { return e.path === privacyCurrent && e.kind === 'absent'; }) &&
            lstatOrNull(privacyCurrent)) {
            privacyReverted = privacyRevert();
        }
        var restored = restoreSnapshot(dir);
        restored.entries.forEach(function (e) {
            var tm = new RegExp('^' + CFG.varOpt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([^/]+)/current$').exec(e.path);
            if (e.kind === 'absent' && tm && tm[1] !== 'mgu-deploy') {
                var root = path.join(CFG.varOpt, tm[1]);
                if (tm[1] === 'mgu-updater' && fs.existsSync(root)) {
                    fs.readdirSync(root).forEach(function (n) {
                        var p = path.join(root, n);
                        if (!updaterStatePath(p)) rmrf(p);
                    });
                    try { fs.rmdirSync(root); } catch (err) { if (err.code !== 'ENOTEMPTY') throw err; }
                } else rmrf(root);
            }
            var am = /\/data\/apps\/([^/]+)\.json$/.exec(e.path);
            if (e.kind === 'absent' && am) {
                say('app ' + am[1] + ' was absent in ' + name + '; removing its source tree and package');
                removeAppSources(am[1]);
            }
        });
        runOk(CFG.systemctl, ['daemon-reload']);
        var bad = verifySnapshot(dir);
        if (bad.length) throw fail('restore verification failed for: ' + bad.join(', '));
        if (fbWas.unit_present || fallbackPresent()) settleFallback();
        pruneCreatedDirs(state);
        var removed = appsBefore.filter(function (id) { return !installedApp(id); });
        if (removed.length) {
            bounceManager();
            say('apps removed: ' + removed.join(', ') + ' (manager-side records are not removed)');
        } else if (privacyReverted && managerPid()) bounceManager();
        saveState(state);
    } catch (e) {
        if (e.code !== 2) {
            process.stderr.write('restore failed, rolling back from ' + backup + '\n');
            try { restoreSnapshot(backup); settleFallback(); } catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        } else if (unbound && !bindMounted(mainJs())) {
            runOk(CFG.mount, ['--bind', FALLBACK_COPY, mainJs()]);
        }
        throw e;
    }
    say('restored from ' + name);
    return 0;
}
/* A restore puts back only what the backup recorded. It is refused when
 * that would leave a tool's current on a version no longer kept, or a
 * component installed after the backup without what it runs under: a
 * tool without its recmgr entries, one of our apps without app-privacy, an
 * app that stays registered without the fallback listing it has now,
 * marked or not. Those are uninstalled first. */
function preflightRestore(name, dir, data) {
    var rec = {}, blocked = [];
    data.entries.forEach(function (e) { rec[e.path] = e; });
    function goes(p) { return !!rec[p] && rec[p].kind === 'absent'; }
    function stored(p) {
        var e = rec[p];
        if (!e) return null;
        return e.kind === 'file' ? fs.readFileSync(path.join(dir, e.stored), 'utf8') : '';
    }
    data.entries.forEach(function (e) {
        if (e.kind === 'symlink' && /\/current$/.test(e.path) &&
            !fs.existsSync(path.join(path.dirname(e.path), e.target, 'component.json'))) {
            blocked.push(path.basename(path.dirname(e.path)) + ' ' + path.basename(e.target) + ' is no longer kept');
        }
    });
    var rmText = stored(CFG.recmgr), sections = rmText === null ? null : recmgrSections(rmText);
    installedTools().forEach(function (t) {
        if (!sections || goes(path.join(t.root, 'current'))) return;
        var lost = (t.component.recmgr || []).filter(function (n) {
            return (sections.Whitelist || []).indexOf(n) < 0 || (sections.WhitelistExitSuccess || []).indexOf(n) < 0;
        });
        if (lost.length) blocked.push(t.id + ' would lose its recmgr entries (' + lost.join(', ') + ')');
    });
    var privacyGoes = goes(path.join(CFG.varOpt, 'app-privacy', 'current')) &&
        !!lstatOrNull(path.join(CFG.varOpt, 'app-privacy', 'current'));
    var customText = stored(customAppsFile()), custom = null;
    try { custom = customText ? JSON.parse(customText) : {}; } catch (e) { custom = {}; }
    var ours = ourApps(), listed = readCustomApps();
    registryEntries().forEach(function (r) {
        if (goes(appEntryFile(r.id))) return;
        if (privacyGoes && ours.indexOf(r.id) >= 0) blocked.push(r.id + ' would stay installed without app-privacy');
        else if (customText !== null && (r.id in listed) && !(r.id in custom)) {
            blocked.push(r.id + ' would lose its fallback listing');
        }
    });
    if (blocked.length) {
        throw refuse('restoring ' + name + ': ' + blocked.join('; ') +
            '. Uninstall what was installed after it, or install the artifact wanted, first');
    }
}
function removeAppSources(id) {
    if (fs.existsSync(CFG.oap)) {
        fs.readdirSync(CFG.oap).forEach(function (n) {
            var pkg = readJsonOrNull(path.join(CFG.oap, n, 'source', 'package.json'));
            if (pkg && pkg.name === id) rmrf(path.join(CFG.oap, n));
        });
    }
    var ops = preinstalledFor(id).map(function (p) { return { type: 'delete', path: p }; });
    if (ops.length) rootfsWindow(ops);
}
function cmdBackups() {
    if (!fs.existsSync(BACKUPS_DIR)) { say('no backups'); return 0; }
    fs.readdirSync(BACKUPS_DIR).sort().forEach(function (n) {
        var dir = path.join(BACKUPS_DIR, n), data = readJsonOrNull(path.join(dir, 'manifest.json'));
        if (!data) { say(n + ' (no manifest)'); return; }
        say(n + (n === 'stock' ? ' [stock]' : '') + ': ' + data.created + ', ' + data.command +
            ', ' + data.entries.length + ' entries');
    });
    return 0;
}
function cmdFallback(args) {
    var sub = args.positional[0], state = loadState();
    if (sub === 'status') {
        var s = fallbackState();
        say('unit: ' + (s.unit_present ? 'present, enabled=' + s.unit_enabled + ' active=' + s.unit_active : 'absent'));
        say('copy: ' + (s.copy_present ? FALLBACK_COPY : 'absent'));
        say('main.js bind-mounted: ' + s.main_bind_mounted);
        say('custom apps: ' + (s.apps.join(', ') || '(none)'));
        say('fallback: ' + (s.active ? 'active' : 'inactive'));
        return 0;
    }
    if (['on', 'off', 'migrate'].indexOf(sub) >= 0 && isId8()) {
        throw refuse('the provisioning fallback is for iDrive 7; on iDrive 8 apps are listed in provisioning (' + CFG.prov + ')');
    }
    if (sub === 'on') { fallbackOn(state); saveState(state); return 0; }
    if (sub === 'off') { fallbackOff(state, {}); saveState(state); return 0; }
    if (sub === 'migrate') { if (fallbackMigrate(state)) saveState(state); return 0; }
    throw refuse('fallback needs on, off, status or migrate');
}
var HELP = [
    'mgu-deploy ' + VERSION,
    'usage: mgu-deploy.sh <command> ...',
    '  check [--artifact <file>...]     read-only checks; exits 2 on a hard problem',
    '  install [--artifact <file>...] [--skip-older] [--yes]',
    '                                    install tools/apps (default: ./artifacts/*.tgz)',
    '  status [--json]                  installed components and pending reboots',
    '  uninstall <id> [--yes]           remove one tool or app',
    '  rollback <id> [--yes]            a tool back to its other kept version',
    '  restore [name] [--yes]           restore a backup (default stock); verified',
    '  backups                          list backups (stock marked)',
    '  fallback <on|off|status>         provisioning fallback for our apps',
    '  fallback migrate                 move our apps off the retired installer\'s leftovers onto the fallback',
    '  updater-token                    store a token for the updater from stdin',
    '  updater-token --list [--json]    the updater\'s tokens: id, label, account',
    '  updater-token --remove <id>      remove one',
    '  updater-sources                  seed the updater\'s sources.json from stdin (kept when present)',
    '  sdk-donor [--json]               a readable copy of the oap-sdk donor bundle, and its oap-sdk module',
    '  apply-pending                    iDrive 8: apply the queued app changes (at boot, before MainApp)',
    '  appmanager [--json]              IterioDev\'s App Manager on this unit: its service and what was adopted',
    '  appmanager adopt [--yes]         take over what it installed; uninstall oap-appmanager removes it',
    '  help                             this text',
    'exit codes: 0 done, 1 failed (rolled back), 2 preflight refused'
].join('\n');
function parseArgs(argv) {
    var out = { command: argv[0] || 'help', artifacts: [], positional: [], json: false, yes: false, remove: null,
        list: false }, i;
    for (i = 1; i < argv.length; i++) {
        if (argv[i] === '--artifact') { out.artifacts.push(argv[++i]); }
        else if (argv[i] === '--json') out.json = true;
        else if (argv[i] === '--skip-older') out.skipOlder = true;
        else if (argv[i] === '--yes') out.yes = true;
        else if (argv[i] === '--remove') out.remove = argv[++i] || '';
        else if (argv[i] === '--list') out.list = true;
        else out.positional.push(argv[i]);
    }
    return out;
}
/* A command that ends with nothing to keep leaves no deploy folder
 * behind: a refused or read-only run changes nothing. */
function main() {
    var hadDeployDir = fs.existsSync(DEPLOY_DIR), code = runCommand();
    if (!hadDeployDir) {
        try { fs.rmdirSync(DEPLOY_DIR); } catch (e) { /* holds state or backups */ }
    }
    return code;
}
function runCommand() {
    var args = parseArgs(process.argv.slice(2)), locked = false;
    var rootOnly = ['install', 'uninstall', 'rollback', 'restore', 'fallback', 'updater-token', 'updater-sources', 'apply-pending',
        'appmanager']
        .indexOf(args.command) >= 0;
    try {
        if (!FAKE && typeof process.getuid === 'function' && process.getuid() !== 0 && rootOnly) {
            throw refuse('run as root');
        }
        if (rootOnly && !(args.command === 'fallback' && args.positional[0] === 'status') &&
            !(args.command === 'appmanager' && !args.positional[0])) {
            acquireLock(); locked = true;
            try { cleanStale(); } catch (e) { warn('could not remove a killed run\'s files: ' + e.message); }
        }
        if (args.command === 'help' || args.command === '--help') { say(HELP); return 0; }
        if (args.command === 'check') return cmdCheck(args);
        if (args.command === 'install') return cmdInstall(args);
        if (args.command === 'status') return cmdStatus(args);
        if (args.command === 'uninstall') return cmdUninstall(args);
        if (args.command === 'rollback') return cmdRollback(args);
        if (args.command === 'restore') return cmdRestore(args);
        if (args.command === 'backups') return cmdBackups();
        if (args.command === 'fallback') return cmdFallback(args);
        if (args.command === 'updater-token') return cmdUpdaterToken(args);
        if (args.command === 'updater-sources') return cmdUpdaterSources();
        if (args.command === 'sdk-donor') return cmdSdkDonor(args);
        if (args.command === 'apply-pending') return cmdApplyPending();
        if (args.command === 'appmanager') return cmdAppManager(args);
        throw refuse('unknown command ' + args.command + '\n' + HELP);
    } catch (e) {
        process.stderr.write('mgu-deploy: ' + e.message + '\n');
        return e.code === 2 ? 2 : 1;
    } finally {
        try { if (snapshotsTaken.length) pruneBackups(); }
        catch (e) { warn('could not prune old backups: ' + e.message); }
        if (locked) releaseLock();
    }
}
process.exit(main());
