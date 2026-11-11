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
 *   mgu-deploy.sh remove-all [--json] | remove-all --yes   (everything the Store setup put on the unit)
 *   mgu-deploy.sh rollback <id> [--yes]
 *   mgu-deploy.sh restore [name] [--yes]
 *   mgu-deploy.sh backups
 *   mgu-deploy.sh fallback <on|off|status|migrate> [--yes]
 *   mgu-deploy.sh updater-token | updater-token --list [--json] | updater-token --remove <id>   (a token on stdin)
 *   mgu-deploy.sh updater-sources            (sources.json on stdin)
 *   mgu-deploy.sh sdk-donor [--json]
 *   mgu-deploy.sh apply-pending              (iDrive 8, at boot: queued app changes)
 *   mgu-deploy.sh relist                     (iDrive 8, at boot: our apps in custom_apps.json)
 *   mgu-deploy.sh remove-unused              (at boot: files a tool handed over)
 *   mgu-deploy.sh appmanager [--json] | appmanager adopt [--yes]   (IterioDev's App Manager)
 *   mgu-deploy.sh help
 *
 * Exit codes: 0 done, 1 failed (rolled back where applicable),
 * 2 preflight refused (nothing changed), 3 stopped by the MainApp guard
 * (what it changed stays).
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
 * remounts, no bind mounts (but MGU_DEPLOY_FAKE_BINDS's), no chown to unit uids; the app manager is
 * whatever MGU_DEPLOY_PS and MGU_DEPLOY_KILL show and kill. The
 * production paths are the defaults.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var os = require('os');

/* What this tool, and every hook, script and command it runs, creates
 * keeps group and others' read and execute bits, whatever umask the caller
 * had: a hook writing a stock binary run by another user leaves it
 * runnable by that user. Files that are root's alone are written with
 * their mode. */
process.umask(0o022);

/* deploy/component.json's version; the release sets both. */
var VERSION = '0.8.10';
var HERE = __dirname;
var MGR_UID = Number(process.env.MGU_DEPLOY_MAINAPP_UID || 12201);

function env(name, dflt) { return process.env[name] ? process.env[name] : dflt; }

var CFG = {
    varOpt: env('MGU_DEPLOY_VAR_OPT', '/var/opt'),
    systemd: env('MGU_DEPLOY_SYSTEMD', '/etc/systemd/system'),
    recmgr: env('MGU_DEPLOY_RECMGR', '/etc/recmgr-restartlist.conf'),
    crashList: env('MGU_DEPLOY_CRASHLIST', '/etc/crashhandler-restartlist.conf'),
    mainapp: env('MGU_DEPLOY_MAINAPP', '/usr/lib/oap-mainapp'),
    mainapp21: env('MGU_DEPLOY_MAINAPP21', '/usr/lib/oap-mainapp21'),
    // Hmi8's built-in applets: its RHMI applets' manifests (its -ro data) and its native applets
    hmi8Data: env('MGU_DEPLOY_HMI8_DATA', '/mnt/dataro/data/hmi8'),
    hmi8Applets: env('MGU_DEPLOY_HMI8_APPLETS', '/usr/lib/hmi8/applet'),
    prov: env('MGU_DEPLOY_PROV', '/usr/share/tm/prov'),
    vminput: env('MGU_DEPLOY_VMINPUT', '/usr/bin/vminput'),
    oap: env('MGU_DEPLOY_OAP', '/var/opt/public/oap'),
    etc: env('MGU_DEPLOY_ETC', '/etc'),
    // the root file system whose stock files a hook must leave usable (fixStock)
    rootfs: env('MGU_DEPLOY_ROOTFS', '/'),
    proc: env('MGU_DEPLOY_PROC', '/proc'),
    procStat: env('MGU_DEPLOY_PROC_STAT', '/proc/stat'),
    procMounts: env('MGU_DEPLOY_PROC_MOUNTS', '/proc/mounts'),
    coding: env('MGU_DEPLOY_CODING', '/dev/shm/rawcodingdata'),
    bootId: env('MGU_DEPLOY_BOOT_ID', '/proc/sys/kernel/random/boot_id'),
    systemctl: env('MGU_DEPLOY_SYSTEMCTL', 'systemctl'),
    journalctl: env('MGU_DEPLOY_JOURNALCTL', 'journalctl'),
    logger: env('MGU_DEPLOY_LOGGER', 'logger'),
    mount: env('MGU_DEPLOY_MOUNT', 'mount'),
    umount: env('MGU_DEPLOY_UMOUNT', 'umount'),
    ps: env('MGU_DEPLOY_PS', 'ps'),
    kill: env('MGU_DEPLOY_KILL', ''),
    tar: env('MGU_DEPLOY_TAR', 'tar'),
    df: env('MGU_DEPLOY_DF', 'df'),
    setquota: env('MGU_DEPLOY_SETQUOTA', 'setquota'),
    getfacl: env('MGU_DEPLOY_GETFACL', 'getfacl'),
    setfacl: env('MGU_DEPLOY_SETFACL', 'setfacl'),
    // where the firmware's own units and programs are
    stockUnits: env('MGU_DEPLOY_STOCK_UNITS', '/lib/systemd/system:/usr/lib/systemd/system').split(':'),
    stockBins: env('MGU_DEPLOY_STOCK_BINS', '/bin:/sbin:/usr/bin:/usr/sbin').split(':'),
    sync: env('MGU_DEPLOY_SYNC', 'sync'),
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
    postInstallMs: Number(env('MGU_DEPLOY_POST_INSTALL_MS', '300000')),
    checkMs: Number(env('MGU_DEPLOY_CHECK_MS', '300000')),
    hookTimeoutMs: Number(env('MGU_DEPLOY_HOOK_TIMEOUT_MS', '120000')),
    verifyAfterS: Number(env('MGU_DEPLOY_VERIFY_AFTER_S', '150')),
    bounceMinUpS: Number(env('MGU_DEPLOY_BOUNCE_MIN_UP_S', '60')),
    guardWatchS: Number(env('MGU_DEPLOY_GUARD_WATCH_S', '60')),
    idleQuietS: Number(env('MGU_DEPLOY_IDLE_QUIET_S', '5')),
    idleMaxS: Number(env('MGU_DEPLOY_IDLE_MAX_S', '180')),
    lockWaitMs: Number(env('MGU_DEPLOY_LOCK_WAIT_MS', '3600000')),
    migrateSettleMs: Number(env('MGU_DEPLOY_MIGRATE_SETTLE_MS', '45000'))
};
var FAKE = process.env.MGU_DEPLOY_FAKE_ROOT === '1';
/* the owner a folder made by root has (the fake root's tests name their own uid) */
var ROOT_UID = FAKE ? Number(env('MGU_DEPLOY_FAKE_ROOT_UID', '-1')) : 0;
// fake root whose rootfs writes still go through the sh window (the tests' power cuts)
var FAKE_SH_WINDOW = FAKE && process.env.MGU_DEPLOY_FAKE_SH_WINDOW === '1';
var DEPLOY_DIR = path.join(CFG.varOpt, 'mgu-deploy');
var STATE_FILE = path.join(DEPLOY_DIR, 'state.json');
var BACKUPS_DIR = path.join(DEPLOY_DIR, 'backups');
var KEEP_BACKUPS = 10;
var LOCK_FILE = path.join(DEPLOY_DIR, 'lock');
var RECMGR_AT_BOOT = path.join(DEPLOY_DIR, 'recmgr-at-boot.json');
var CRASH_OWNED = path.join(DEPLOY_DIR, 'crash-names.json');
var RECMGR_OWNED = path.join(DEPLOY_DIR, 'recmgr-names.json');
var FALLBACK_UNIT = 'mgu-app-fallback.service';
var FALLBACK_NAME = 'mgu-app-fallback';
var FALLBACK_COPY = path.join(DEPLOY_DIR, 'main.js');
var FALLBACK_BUILD_INSTALLED = path.join(DEPLOY_DIR, 'current', 'fallback_build.js');
var INPLACE_DIR = path.join(DEPLOY_DIR, 'inplace');
var INPLACE_REQUEST = path.join(INPLACE_DIR, 'request.json');
/* fallback_build.js's marker around the in-place hook in the copy */
var INPLACE_MARK = '/* mgu-deploy in-place install */';
var SHIM = path.join(DEPLOY_DIR, 'mgu-deploy.sh');
var CERT_COPY = path.join(DEPLOY_DIR, 'CertificateManager.js');
/* This tool's own manifest, as deploy/component.json has it. */
var SELF_TITLE = 'Deploy tool';
var SELF_DESCRIPTION = 'Installs, updates, rolls back and removes our tools and apps on the head unit, ' +
    'with a snapshot before every change';
var SELF_FILES = [{ path: 'mgu-deploy.js', mode: '0644' }, { path: 'mgu-deploy.sh', mode: '0755' },
    { path: 'fallback_build.js', mode: '0644' }, { path: 'mgu-app-fallback.service', mode: '0644' },
    { path: 'mgu-deploy-apply.service', mode: '0644' }, { path: 'mgu-deploy-verify.service', mode: '0644' },
    { path: 'mgu-deploy-cleanup.service', mode: '0644' },
    { path: 'mgu-app-fallback-id8.service', mode: '0644' },
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
/* MainApp 6.5.5 ships <name>.js as a bytecode-loader stub that runs
 * <name>.bundle.js beside it; 8.x and MainApp-21 ship the bundle in
 * <name>.js. */
function bundlePath(file) {
    var b = file.replace(/\.js$/, '.bundle.js');
    return b !== file && fs.existsSync(b) ? b : file;
}
function mainJs() { return bundlePath(path.join(mainappRoot(), 'src', 'main.js')); }
function bytecodeStubs() { return mainJs() !== path.join(mainappRoot(), 'src', 'main.js'); }
function appManagementJs() { return bundlePath(path.join(mainappRoot(), 'src', 'AppManagement', 'AppManagement.js')); }
function certManagerJs() { return bundlePath(path.join(CFG.mainapp, 'src', 'scripts', 'CertificateManager.js')); }
function baseJson() { return path.join(CFG.mainapp, 'config', 'base.json'); }
/* MainApp's own folder: oap-mainapp on iDrive 7, oap-mainapp21 on iDrive 8. */
function mainappRoot() { return unitInfo().hmi === 'ID8' ? CFG.mainapp21 : CFG.mainapp; }
function preinstalledDir() { return path.join(mainappRoot(), 'preinstalled_apps'); }
function mgrHome() { return path.join(CFG.oap, 'oap_' + MGR_UID); }
function appsDir() { return path.join(mgrHome(), 'data', 'apps'); }
function customAppsFile() { return path.join(mgrHome(), 'data', 'custom_apps.json'); }
function localOnlyFile() { return path.join(mgrHome(), 'data', 'local-only-apps.json'); }
/* The app manager's home and data folder are its own to create, with its
 * owner and modes (after a factory reset, at its first start): this tool
 * never creates them, and writes under them only once they are there. */
function mgrOwnDir(dir) { return dir === mgrHome() || dir === path.join(mgrHome(), 'data'); }
function mgrDataReady() {
    var st = statOrNull(path.join(mgrHome(), 'data'));
    return !!st && st.isDirectory();
}
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
    if (mgrOwnDir(dir)) throw fail(dir + ' is missing: the app manager creates it at its start');
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
function statOrNull(p) { try { return fs.statSync(p); } catch (e) { return null; } }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function readJsonOrNull(p) { try { return readJson(p); } catch (e) { return null; } }
function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function sha256Buf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
/* file replaced by rename, the new file and its folder on disk before it returns */
function writeAtomic(file, data, mode) {
    mkdirp(path.dirname(file));
    var tmp = file + '.tmp-' + process.pid, fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, data);
        if (mode !== undefined) fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
}
function fsyncDir(dir) {
    var fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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
/* Blocks for ms. Node before 8.10 (the 2019 MGU's 8.9.4) has no Atomics:
 * there a sleep child waits, killed at the timeout, so the wait takes no
 * CPU and keeps millisecond precision with BusyBox's whole-second sleep.
 * Only while no child can be started does it spin, 50 ms at a time. */
function sleepMs(ms) {
    if (typeof Atomics === 'object' && typeof SharedArrayBuffer === 'function') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        return;
    }
    var end = monoS() * 1000 + ms;
    for (var left = ms; left > 0; left = end - monoS() * 1000) {
        var r = cp.spawnSync('sleep', [String(Math.ceil(left / 1000) + 1)], { timeout: Math.ceil(left), stdio: 'ignore' });
        if (r.error && r.error.code !== 'ETIMEDOUT') {
            var spinTo = monoS() * 1000 + Math.min(left, 50);
            while (monoS() * 1000 < spinTo) { /* no child: spin this slice */ }
        }
    }
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
    if (restartDeferred && Array.isArray(s.pending_reboot)) {
        s = Object.assign({}, s, { pending_reboot: s.pending_reboot.slice() });
        addPending(s, 'mgu-deploy', PENDING_MANAGER_BUSY);
    }
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
    var r = systemctl(unit ? [verb, unit] : [verb]);
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
 * second in "ps aux". The manager is node running MainApp's main.js as its
 * script (the first argument that is not an option or a -r preload), not a
 * command that only names the file, as the fallback copy's build does. */
function managerPid() {
    return nodePids([path.basename(mainappRoot()) + '/src/main.js'])[0] || null;
}
/* node processes whose script (the first argument past options and -r
 * preloads) ends with one of scripts. */
function nodePids(scripts) {
    var lines = psLines(), head = (lines[0] || '').trim().split(/\s+/), col = head.indexOf('PID'), i, f, a, pid, out = [];
    var cmd = head.indexOf('COMMAND');
    var ends = function (s) { return scripts.some(function (x) { return s.slice(-x.length) === x; }); };
    if (col < 0 || cmd < 0) return out;
    for (i = 1; i < lines.length; i++) {
        f = lines[i].trim().split(/\s+/);
        if (!/(^|\/)node$/.test(f[cmd] || '')) continue;
        for (a = cmd + 1; a < f.length && f[a].charAt(0) === '-'; a++) if (f[a] === '-r' || f[a] === '--require') a++;
        if (!f[a] || !ends(f[a])) continue;
        pid = Number(f[col]);
        if (pid > 0 && pid !== process.pid) out.push(pid);
    }
    return out;
}
/* MainApp's install worker: the node child main.js forks for app installs,
 * updates and removals (src/AppManagement/AppManagement), which exits 30 s
 * after its last one. An update deletes the app's registry entry and writes
 * it again seconds later (up to about 35 s on the car), within the worker's
 * run; a restart of MainApp in between loses the entry, and MainApp then
 * installs the app again from its firmware package under a new uid. */
function workerRunning() {
    var w = path.basename(mainappRoot()) + '/src/AppManagement/AppManagement';
    return nodePids([w, w + '.js']).length > 0;
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
 * bounce goes through here. MainApp-21 (iDrive 8) is never bounced: what
 * it has not taken in place it takes at the next start. */
function bounceManager() {
    if (isId8()) { say('MainApp-21 is not restarted; it takes this at the next start of the head unit'); return false; }
    var off = guardWhy();
    if (off) {
        say('the app manager is not restarted until the next start of the head unit (' + off + ')');
        privacyBounceOwed = false;
        return false;
    }
    if (bounceDeferred) {
        if (!bounceOwed) say('the app manager is restarted once, when the removal is done');
        bounceOwed = true;
        return true;
    }
    if (restartDeferred) return false;
    var old, waited = 0, cur, idleBy = null;
    for (;;) {
        old = bounceWait();
        if (!old) { warn('app manager node child not found; nothing to bounce'); return false; }
        if (idleBy === null) idleBy = monoS() + CFG.idleMaxS;
        if (!idleWait(idleBy)) return deferBounce();
        if (managerPid() === old) break;
    }
    say('bouncing the app manager node child (pid ' + old + ')');
    recordBounce(Math.ceil(nowS()));
    guardBounce(old);
    privacyBounceOwed = false;
    privacyMayWait = false;
    if (CFG.kill) runOk(CFG.kill, [String(old)]);
    else {
        try { process.kill(old); } catch (e) { throw fail('kill ' + old + ': ' + e.message); }
    }
    while (waited <= CFG.bounceTimeoutMs) {
        cur = managerPid();
        if (cur && cur !== old) { say('app manager respawned (pid ' + cur + ')'); guardWatch(cur); return true; }
        sleepMs(100); waited += 100;
    }
    throw fail('app manager node child did not respawn; check oapcontroller');
}
/* remove-all makes the bounces its steps ask for once, at its end. */
var bounceDeferred = false, bounceOwed = false;
/* Until MainApp's install worker has not run for idleQuietS, up to the
 * monotonic time by: true once idle. A worker not running at the first
 * look has been idle 30 s already (it exits 30 s after its last job). */
function idleWait(by) {
    var seen = null, said = false;
    for (;;) {
        if (workerRunning()) seen = monoS();
        else if (seen === null || monoS() - seen >= CFG.idleQuietS) return true;
        if (monoS() >= by) return false;
        if (!said) {
            say('waiting for the app manager to finish installing or updating apps before restarting it (up to ' +
                Math.max(0, Math.ceil(by - monoS())) + 's)');
            said = true;
        }
        sleepMs(Math.min(500, CFG.idleQuietS * 1000));
    }
}
/* MainApp still busy at the bound: not restarted, and no later bounce of
 * this run waits again. The restart is pending for the rest of the boot
 * (saveState keeps the entry), also when a change that needed it is rolled
 * back. */
var restartDeferred = false;
var PENDING_MANAGER_BUSY = 'the app manager takes it at the next start (it was busy installing apps)';
function deferBounce() {
    warn('the app manager is still installing or updating apps after ' + CFG.idleMaxS + 's: it is not restarted, ' +
        'and what needs its restart takes effect at the next start of the head unit');
    restartDeferred = true;
    privacyBounceOwed = false;
    saveState(loadState());
    return false;
}

/* ---- the MainApp guard (iDrive 7) ------------------------------------------- */
/* oapcontroller wipes every app at the third death of the app manager
 * inside its alive window, and a bounce is the first. So the manager a
 * bounce starts is watched until it has been up guardWatchS; when it dies
 * before, the guard is off for the rest of the boot: no bounce and no app
 * change, and main.js and CertificateManager.js are unbound, so the next
 * manager starts on the files under them, as they are (app-privacy's apply
 * after an unbind waits for its run at the next start). The guard file, beside the
 * in-place status file, holds {boot, bounce, watch, off} (watch.done once
 * the watch ended); the fallback copy reads it as it loads and runs as the
 * stock file when a manager the bounce started died within the watch
 * (fallback_build.js guardSource7), which covers the manager oapcontroller
 * starts before this tool sees the death. A run cut short while it watched
 * leaves the watch in the file, for the next run to judge. */
function guardFile() { return path.join(mgrHome(), 'data', 'mgu-deploy-guard.json'); }
function readGuard() {
    var g = readJsonOrNull(guardFile());
    return g && typeof g === 'object' && g.boot === bootId() ? g : { boot: bootId() };
}
/* Written only where MainApp's data folder is: never made by this tool. */
function writeGuard(g) {
    if (!fs.existsSync(path.dirname(guardFile()))) return;
    writeAtomic(guardFile(), JSON.stringify(g) + '\n', 0o644);
    chownMaybe(guardFile(), MGR_UID, MGR_UID);
}
/* Why the guard is off for this boot, or null. A watch left unfinished is
 * judged here: its manager gone, and the one running now started before
 * the watch would have ended, means it died within it. */
function guardWhy() {
    if (isId8()) return null;
    var g = readGuard(), w = g.watch;
    if (g.off) return g.off;
    if (!w || w.done || typeof w.start !== 'number' || !g.bounce) return null;
    var m = managerStart(), endsMs = w.start + g.bounce.watchMs;
    /* no manager running: judged by the start of the one oapcontroller starts next */
    if (!m || (m.pid === w.pid && (m.started === null || Math.abs(m.started * 1000 - w.start) < 2000))) return null;
    if (m.started !== null && m.started * 1000 >= endsMs) return null;
    return 'the app manager stopped within ' + Math.round(g.bounce.watchMs / 1000) + 's of its restart by mgu-deploy';
}
function guardBounce(pid) {
    if (!(CFG.guardWatchS > 0) || isId8()) return;
    writeGuard({ boot: bootId(), bounce: { at: Date.now(), pid: pid, watchMs: CFG.guardWatchS * 1000 } });
}
/* The manager a bounce started, watched until it has been up guardWatchS. */
function guardWatch(pid) {
    if (!(CFG.guardWatchS > 0)) return;
    var started = processStart(pid), from = monoS(), g = readGuard();
    g.watch = { pid: pid, start: Math.round((started === null ? nowS() : started) * 1000) };
    writeGuard(g);
    say('watching the app manager (pid ' + pid + ') for ' + CFG.guardWatchS + 's');
    while (monoS() - from < CFG.guardWatchS) {
        sleepMs(250);
        if (managerPid() === pid) continue;
        sleepMs(500);
        if (managerPid() === pid) continue;
        var why = 'the app manager stopped ' + Math.round(monoS() - from) + 's after mgu-deploy restarted it';
        guardTrip(why);
        guardStop(why);
    }
    g = readGuard();
    if (g.watch && g.watch.pid === pid) { g.watch.done = true; writeGuard(g); }
}
/* The guard off for the rest of the boot: recorded, and main.js and
 * CertificateManager.js unbound, so the next manager starts on the files
 * under them. The fallback's unit binds the copy again at the next start. */
function guardTrip(why) {
    var g = readGuard();
    if (!g.off) {
        g.off = why;
        try { writeGuard(g); } catch (e) { warn('the guard file is not written: ' + e.message); }
        warn(why + ': no app changes and no restart of the app manager until the next start of the head unit');
    }
    /* never throws: a caller's rollback must not follow */
    try {
        while (binds() && bindMounted(mainJs())) {
            runOk(CFG.umount, [mainJs()]);
            say(mainJs() + ' unbound: the app manager starts on it until the next start of the head unit');
        }
    } catch (e) { warn(mainJs() + ' stays bound: ' + e.message); }
    try { unbindCertCopy(); } catch (e) { warn(certManagerJs() + ' stays bound: ' + e.message); }
}
/* A trip ends the run where it is, with exit status 3 (guardExit): what
 * it changed stays, since rolling it back would write / and the app
 * manager's files while the next manager starts; the next start of the head
 * unit, and the updater's reinstall of a lost app, take it up. The steps a
 * run is inside (onGuardStop, innermost first) bring this tool's own
 * records to what they did, and nothing else. */
var guardSteps = [], guardExit = 3;
function onGuardStop(record, body) {
    guardSteps.push(record);
    try { return body(); } finally { guardSteps.pop(); }
}
function guardStop(why) {
    guardSteps.slice().reverse().forEach(function (record) {
        try { record(); } catch (e) { warn('not recorded: ' + e.message); }
    });
    process.stderr.write('mgu-deploy: ' + why + '; stopped here: what this run changed stays, and app changes wait for ' +
        'the next start of the head unit\n');
    releaseLock();
    process.exit(guardExit);
}
/* The app's record (state.json apps) at version, its uid the registry's
 * when it has one, and that version's package kept: a later loss of the
 * app installs that version again. */
function recordApp(id, version, file) {
    var s = loadState(), e = readJsonOrNull(appEntryFile(id));
    s.apps[id] = { uid: e && e.userId ? e.userId : (s.apps[id] || {}).uid || null, version: version };
    saveState(s);
    if (file && !fs.existsSync(keptFile(id, version))) keepPackage({ id: id, version: version, file: file });
}
/* An app removed for good: no record, no kept package, no data folder set aside. */
function forgetApp(state, id) {
    delete state.apps[id];
    forgetStash(state, id);
    rmrf(keptDir(id));
}
function dropAppRecord(id) {
    var s = loadState();
    forgetApp(s, id);
    saveState(s);
}
function guardRefuse(what) {
    var why = guardWhy();
    if (why) throw refuse(what + ' waits for the next start of the head unit: ' + why);
}
/* status, as root: a guard found off with main.js still bound (a run cut
 * short while it watched) is tripped, under the lock when free. */
function syncGuard() {
    var why = guardWhy();
    if (!why || (readGuard().off && !(binds() && (bindMounted(mainJs()) || bindMounted(certManagerJs()))))) return;
    statusStep('guard', function () { guardTrip(why); });
}
/* The app manager's home or data folder owned by root, which stops the
 * manager at its start. */
function mgrHomeRootOwned() {
    return [mgrHome(), path.join(mgrHome(), 'data')].some(function (d) {
        var st = lstatOrNull(d);
        return !!st && st.isDirectory() && st.uid === ROOT_UID;
    });
}
/* Both given back to the app manager with the owner and modes it creates
 * them with, and the repair logged. True when it did. */
function repairMgrHome() {
    if (!mgrHomeRootOwned()) return false;
    [[mgrHome(), 0o3770], [path.join(mgrHome(), 'data'), 0o750]].forEach(function (d) {
        var st = lstatOrNull(d[0]);
        if (!st || !st.isDirectory()) return;
        chownMaybe(d[0], MGR_UID, MGR_UID);
        fs.chmodSync(d[0], d[1]);
    });
    var line = mgrHome() + ' and its data folder were owned by root: given back to uid ' + MGR_UID;
    say(line);
    run(CFG.logger, ['-t', 'mgu-deploy', line], { allowFail: true });
    return true;
}
var PENDING_HOME_REPAIRED = 'the app manager starts again at the next start (its folders were repaired)';
/* status, as root: repairMgrHome, then on iDrive 7 the app manager
 * running again: one oapcontroller starts after the repair, within
 * bounceTimeoutMs, or else one that started before it restarted by
 * bounceManager. Otherwise, and on iDrive 8, a restart is pending. */
function syncMgrHome() {
    if (!mgrHomeRootOwned()) return;
    statusStep('app manager folders', function () {
        if (!repairMgrHome()) return;
        var at = nowS(), waited = 0, pid = null, started, up = false;
        while (!isId8() && waited <= CFG.bounceTimeoutMs) {
            pid = managerPid();
            started = pid ? processStart(pid) : null;
            if (pid && started !== null && started >= at) { say('app manager started (pid ' + pid + ')'); return; }
            sleepMs(1000); waited += 1000;
        }
        try { up = !!pid && managerPid() === pid && bounceManager(); }
        catch (e) { warn(e.message); }
        if (up) return;
        var s = loadState();
        addPending(s, 'mgu-deploy', PENDING_HOME_REPAIRED);
        saveState(s);
    });
}
/* status, as root: the data folders set aside (settleStashes). */
function syncStashes() {
    if (!Object.keys(loadState().data_stash || {}).length) return;
    statusStep('data set aside', function () { var s = loadState(); if (settleStashes(s)) saveState(s); });
}
/* status --read-only: its steps change nothing. */
var statusReadOnly = false;
/* Why a step of status leaves what it would change as it is (read-only,
 * or not run as root), else null. */
function statusHeld() {
    if (statusReadOnly) return 'read-only';
    return !FAKE && process.getuid() !== 0 ? 'status not run as root' : null;
}
/* A step of status run as root, under the lock when free, its lines on
 * stderr (stdout keeps status's own). */
function statusStep(what, fn) {
    var out = process.stdout.write;
    if (statusHeld()) return;
    process.stdout.write = function (x) { return process.stderr.write(x); };
    try {
        if (!statusLock()) return;
        try { fn(); } finally { releaseLock(); }
    } catch (e) { process.stderr.write('mgu-deploy: ' + what + ': ' + e.message + '\n'); }
    finally { process.stdout.write = out; }
}
/* The manager's node child, waited for up to bounceTimeoutMs: oapcontroller
 * respawns a dead one within seconds. */
function managerSoon() {
    var waited = 0, pid;
    while (!(pid = managerPid()) && waited < CFG.bounceTimeoutMs) { sleepMs(1000); waited += 1000; }
    return pid;
}
/* oapcontroller (iDrive 7 and 8) reads the head unit's coding from the
 * segment CodingShmApp publishes (0x1030 bytes; status flags in byte 0x28:
 * 0x08 header valid, 0x01 data available, 0x02 and 0x04 default values) and
 * starts no MainApp when that coding is not valid or is the default values. What it found,
 * or null when the segment is unreadable or holds the car's coding. */
function codingStopsOap() {
    var buf, f;
    try { buf = fs.readFileSync(CFG.coding); } catch (e) { return null; }
    if (buf.length !== 0x1030) return null;
    f = buf[0x28];
    if (!(f & 0x08)) return 'it is not valid';
    return f & 0x06 ? 'it holds default values' : null;
}
function codingMissing(why) {
    return 'The head unit\'s coding is missing: ' + why + '. This often happens after enabling SSH or flashing. ' +
        'Restore the head unit\'s coding from a backup (BimmerCode, E-Sys or ISTA) or have HU_MGU coded to the car, ' +
        'restart the head unit, then run the install again.';
}
/* What tells why no app manager runs, a screen at most. MainApp's uid's
 * processes come from /proc, whatever ps shows; a long line keeps its
 * start and its end, where the script is. */
function managerReport() {
    var out = [], cut = function (l) { l = l.trim(); return l.length > 160 ? l.slice(0, 70) + '...' + l.slice(-87) : l; };
    var pkg = readJsonOrNull(path.join(mainappRoot(), 'package.json')), up = null, dropins = [], mounts = 0;
    out.push('MainApp: ' + mainappRoot() + ' ' + (pkg && pkg.version ? pkg.version : '(no version)') +
        (fs.existsSync(mainJs()) ? '' : ', no src/main.js'));
    var sh = systemctl(['show', '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts', '-p', 'ActiveEnterTimestamp',
        '-p', 'ExecMainStatus', 'oapcontroller.service']);
    out.push('oapcontroller: ' + ((sh.stdout || '').trim().split('\n').join(', ') || 'no state (' + oneLine(sh.stderr || sh.error) + ')'));
    try { dropins = fs.readdirSync(path.join(CFG.systemd, 'oapcontroller.service.d')); } catch (e) { /* none */ }
    if (dropins.length) out.push('oapcontroller drop-ins: ' + dropins.sort().join(', '));
    try { up = Math.floor(parseFloat(fs.readFileSync(path.join(CFG.proc, 'uptime'), 'utf8'))); } catch (e) { /* unreadable */ }
    try {
        mounts = fs.readFileSync(CFG.procMounts, 'utf8').split('\n').filter(function (l) { return l.split(' ')[1] === mainJs(); }).length;
    } catch (e) { /* unreadable */ }
    out.push('head unit up ' + (up === null ? '?' : up + ' s') + ', mounts over main.js: ' + mounts);
    var mine = [];
    try {
        fs.readdirSync(CFG.proc).filter(function (n) { return /^\d+$/.test(n); }).forEach(function (n) {
            try {
                var uid = /\nUid:\s+(\d+)/.exec(fs.readFileSync(path.join(CFG.proc, n, 'status'), 'utf8'));
                if (!uid || Number(uid[1]) !== MGR_UID) return;
                mine.push(n + ' ' + fs.readFileSync(path.join(CFG.proc, n, 'cmdline'), 'utf8').split('\0').join(' ').trim());
            } catch (e) { /* gone meanwhile */ }
        });
    } catch (e) { /* unreadable */ }
    out.push('processes of uid ' + MGR_UID + ' (MainApp\'s):' + (mine.length ? '' : ' none'));
    mine.slice(0, 3).forEach(function (l) { out.push('  ' + cut(l)); });
    var lines = psLines(), head = lines[0] || '';
    var procs = lines.slice(1).filter(function (l) {
        return /(^|[\s\/])node(\s|$)|mainapp|main\.js|oapcontroller|uidrun/i.test(l) && !/mgu-deploy\.js/.test(l);
    });
    var first = procs.filter(function (l) { return /mainapp|main\.js|oapcontroller|uidrun/i.test(l); });
    procs = first.concat(procs.filter(function (l) { return first.indexOf(l) < 0; }));
    out.push('processes (' + (procs.length ? procs.length : 'none') + ' of node, MainApp, oapcontroller):');
    if (procs.length) out.push('  ' + cut(head));
    procs.slice(0, 8).forEach(function (l) { out.push('  ' + cut(l)); });
    if (procs.length > 8) out.push('  (' + (procs.length - 8) + ' more)');
    var j = run(CFG.journalctl, ['-u', 'oapcontroller', '-n', '300', '--no-pager', '-o', 'cat'], { allowFail: true });
    var said = (j.stdout || '').split('\n').filter(function (l) { return /MainApp/.test(l) && !/HeartBeat|AliveTimer|MemoryCpu/.test(l); }).slice(-3);
    said.forEach(function (l) { out.push('oapcontroller said: ' + cut(l.replace(/^.*?\[\d+: /, '').replace(/\]$/, ''))); });
    return out;
}
/* MGU_DEPLOY_FAKE_BINDS (fake root only): the tests' table of bind mounts
 * their mount and umount keep, one "<target>\t<source>\t<inode>" line each;
 * with it, binds are made and looked at as on the unit. */
var FAKE_BINDS = FAKE ? env('MGU_DEPLOY_FAKE_BINDS', '') : '';
function fakeBind(file) {
    var hit = null;
    try {
        fs.readFileSync(FAKE_BINDS, 'utf8').split('\n').forEach(function (l) {
            var f = l.split('\t');
            if (f[0] === file) hit = { source: f[1], ino: Number(f[2]) };
        });
    } catch (e) { /* no binds */ }
    return hit;
}
function binds() { return !FAKE || !!FAKE_BINDS; }
function bindMounted(file) {
    if (FAKE_BINDS) return !!fakeBind(file);
    try {
        return fs.statSync(file).dev !== fs.statSync(path.dirname(file)).dev;
    } catch (e) { return false; }
}

/* ---- recmgr --------------------------------------------------------------- */
/* The restart list is read only at boot. A service can be stopped or
 * restarted only when recmgr loaded its entry (recmgrLoaded); anything else
 * waits for a reboot. Unknown lines and sections round-trip unchanged. */

/* A line of a restart list as recmgr and the crash handler read it: from
 * "#" on a comment, the rest trimmed; "[name]" starts a section, any other
 * text is an entry (exact, case-sensitive). */
function listLine(line) {
    var s = line.split('#')[0].trim(), m = /^\[(.*)\]$/.exec(s);
    return m ? { section: m[1], name: '' } : { section: null, name: s };
}
function recmgrSections(text) {
    var sections = {}, current = null;
    text.split('\n').forEach(function (line) {
        var l = listLine(line);
        if (l.section !== null) { current = l.section; if (!sections[current]) sections[current] = []; return; }
        if (current && l.name) sections[current].push(l.name);
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
/* A unit without the list (iDrive 7 and iDrive 8 both have it) has no recmgr to
 * restart it: nothing is written there, and every unit counts as loaded. */
function recmgrPresent() { return !!lstatOrNull(CFG.recmgr); }
/* The rootfs op that adds addNames to the list and removes removeNames (one
 * list, or one per section), or null when that changes nothing or the unit
 * has no list; its added: the names it puts in. An edit is refused when
 * checkListEdit refuses it. */
function recmgrOp(addNames, removeNames) {
    if (!recmgrPresent()) return null;
    var text = recmgrText(), next = recmgrWith(text, addNames, removeNames);
    if (next === text) return null;
    checkListEdit(CFG.recmgr, RECMGR_LIST, text, next, addNames, removeNames);
    var was = recmgrSections(text);
    return { type: 'copy', data: next, path: CFG.recmgr, mode: 0o644, added: addNames.filter(function (n) {
        return RECMGR_LIST.edited.some(function (sec) { return (was[sec] || []).indexOf(n) < 0; });
    }) };
}
/* ---- the names this tool added to recmgr's list ---- */
/* A tool's names go into the list's sections that lack them, and only the
 * names this tool put there ever come out: RECMGR_OWNED records them, by
 * section, with the firmware they were added under, after every edit of the
 * list for tools' names (and is in every snapshot, so a restore puts it
 * back with the list). A name the stock snapshot's copy of the list has in
 * a section never comes out of it. After a firmware update, which puts the
 * firmware's list back, the record counts for nothing until the next edit.
 * An install from before the record: the names in the list that the stock
 * snapshot's copy of it, taken on this firmware, does not have are ours;
 * without such a copy none are, and a name that would go stays (said). */

/* recmgr's list in the stock snapshot, by section, and whether that
 * snapshot was taken on the firmware running; null without one, or with one
 * this run took. */
function stockRecmgr() {
    if (stockTakenNow) return null;
    var dir = path.join(BACKUPS_DIR, 'stock'), data = readJsonOrNull(path.join(dir, 'manifest.json'));
    var e = data && Array.isArray(data.entries) ? data.entries.filter(function (x) { return x && x.path === CFG.recmgr; })[0] : null;
    if (!e || e.kind !== 'file' || typeof e.stored !== 'string') return null;
    try {
        return { sections: recmgrSections(fs.readFileSync(path.join(dir, e.stored), 'utf8')),
            here: Object.prototype.hasOwnProperty.call(data, 'firmware') && data.firmware === unitInfo().firmware };
    } catch (err) { return null; }
}
/* The names of ours in the list (text), by section, what says so (basis:
 * 'record', 'stock', or null when nothing does), whether the record is from
 * other firmware (moved), and the stock snapshot's list (stockRecmgr). */
function recmgrOwned(text) {
    var o = readJsonOrNull(RECMGR_OWNED), fw = unitInfo().firmware, stock = stockRecmgr(), names = {};
    if (o && o.names && typeof o.names === 'object') {
        var moved = !!(o.firmware && fw && o.firmware !== fw);
        RECMGR_LIST.edited.forEach(function (sec) {
            names[sec] = !moved && Array.isArray(o.names[sec]) ? o.names[sec].filter(function (n) { return typeof n === 'string'; }) : [];
        });
        return { names: names, basis: 'record', moved: moved, stock: stock };
    }
    var now = recmgrSections(text), basis = stock && stock.here ? 'stock' : null;
    RECMGR_LIST.edited.forEach(function (sec) {
        names[sec] = basis ? (now[sec] || []).filter(function (n) { return (stock.sections[sec] || []).indexOf(n) < 0; }) : [];
    });
    return { names: names, basis: basis, moved: false, stock: stock };
}
/* Of names (ones no installed tool has any more), those to take out of
 * each section of the list (text): ours, and not the stock snapshot's.
 * The others there stay, each with why, in one line. */
function recmgrRemovals(names, text) {
    var now = recmgrSections(text), out = {}, kept = [];
    if (!names.length) return out;
    var owned = recmgrOwned(text), stock = owned.stock;
    function why(n, sec) {
        if (stock && (stock.sections[sec] || []).indexOf(n) >= 0) return 'in the stock list';
        if (owned.moved) return "mgu-deploy's record is from other firmware";
        if (owned.basis === 'record') return "not in mgu-deploy's record; an earlier version may have added it";
        return 'no record, and no stock backup from this firmware';
    }
    RECMGR_LIST.edited.forEach(function (sec) {
        out[sec] = names.filter(function (n) {
            if ((now[sec] || []).indexOf(n) < 0) return false;
            var ours = owned.names[sec].indexOf(n) >= 0 && !(stock && (stock.sections[sec] || []).indexOf(n) >= 0);
            if (!ours) {
                var w = why(n, sec), k = kept.filter(function (x) { return x.name === n && x.why === w; })[0];
                if (k) k.secs.push('[' + sec + ']');
                else kept.push({ name: n, why: w, secs: ['[' + sec + ']'] });
            }
            return ours;
        });
    });
    if (kept.length) {
        say('recmgr list: kept ' + kept.map(function (k) { return k.name + ' in ' + k.secs.join(' and ') + ' (' + k.why + ')'; }).join(', '));
    }
    return out;
}
/* After a window that wrote the list, from was (its text before it): the
 * record of the names of ours it has now, those of was and the ones the
 * window added. What says which names of was are ours reads the same here
 * as before the window: the window writes neither the record nor the stock
 * snapshot, and a stock snapshot taken by this run counts for nothing. */
function recmgrOwnedDone(was) {
    var owned = recmgrOwned(was), before = recmgrSections(was), now = recmgrSections(recmgrText()), names = {};
    RECMGR_LIST.edited.forEach(function (sec) {
        names[sec] = (now[sec] || []).filter(function (n, i, all) {
            return all.indexOf(n) === i && (owned.names[sec].indexOf(n) >= 0 || (before[sec] || []).indexOf(n) < 0);
        }).sort();
    });
    var rec = { firmware: unitInfo().firmware, names: names };
    if (JSON.stringify(rec) === JSON.stringify(readJsonOrNull(RECMGR_OWNED))) return;
    mkdirp(DEPLOY_DIR);
    writeAtomic(RECMGR_OWNED, JSON.stringify(rec) + '\n', 0o644);
}
/* Whether the firmware ships a unit recmgr knows by this name. */
function stockUnit(name) {
    return CFG.stockUnits.some(function (d) {
        return ['.service', '.socket'].some(function (ext) { return !!lstatOrNull(path.join(d, name + ext)); });
    });
}
/* A recmgr entry: a unit's name without its suffix, a template's with its "@". */
var RECMGR_NAME = /^[A-Za-z0-9:._+@-]{1,255}$/;
/* The sections an edit adds names to and removes them from. */
var RECMGR_LIST = { edited: ['Whitelist', 'WhitelistExitSuccess'] };
var CRASH_LIST = { edited: ['Whitelist'] };
/* The names an edit takes from section sec: removeNames, one list for every
 * section the edit touches or one per section ({ Whitelist: [...] }). */
function removedFrom(removeNames, sec) {
    return Array.isArray(removeNames) ? removeNames : (removeNames && removeNames[sec]) || [];
}
/* Refuses an edit of a list read at boot (file) unless the list has one of
 * its edited sections at least (an empty or torn file has none) and the
 * edit only adds addNames to and removes removeNames from those sections,
 * every other entry staying. */
function checkListEdit(file, list, text, next, addNames, removeNames) {
    var was = recmgrSections(text), now = recmgrSections(next), why = null;
    function minus(a, b) { return a.filter(function (n) { return b.indexOf(n) < 0; }); }
    if (!list.edited.some(function (sec) { return was[sec]; })) {
        why = 'has no ' + list.edited.map(function (sec) { return '[' + sec + ']'; }).join(' or ') + ' section';
    }
    Object.keys(was).concat(Object.keys(now)).forEach(function (sec) {
        var mine = list.edited.indexOf(sec) >= 0;
        var lost = minus(minus(was[sec] || [], now[sec] || []), mine ? removedFrom(removeNames, sec) : []);
        var gained = minus(minus(now[sec] || [], was[sec] || []), mine ? addNames : []);
        if (!why && !now[sec]) why = 'would lose its [' + sec + '] section';
        if (!why && lost.length) why = 'would lose ' + lost.join(', ') + ' from [' + sec + ']';
        if (!why && gained.length) why = 'would gain ' + gained.join(', ') + ' in [' + sec + ']';
    });
    if (why) throw refuse(file + ' ' + why + '; left as it is');
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
    var lines = text.split('\n'), out = [], current = null, seen = {}, eol = /\r\n/.test(text) ? '\r' : '';
    function flushMissing(section) {
        addNames.forEach(function (n) {
            if (!seen[section + ':' + n]) { out.push(n + eol); seen[section + ':' + n] = true; }
        });
    }
    lines.forEach(function (line) {
        var l = listLine(line), name = l.name;
        if (l.section !== null) {
            if (current === 'Whitelist' || current === 'WhitelistExitSuccess') flushMissing(current);
            current = l.section; out.push(line); return;
        }
        if ((current === 'Whitelist' || current === 'WhitelistExitSuccess') && name) {
            if (removedFrom(removeNames, current).indexOf(name) >= 0) return;
            seen[current + ':' + name] = true;
        }
        out.push(line);
    });
    if (current === 'Whitelist' || current === 'WhitelistExitSuccess') flushMissing(current);
    RECMGR_LIST.edited.forEach(function (sec) {
        var missing = addNames.filter(function (n) { return !seen[sec + ':' + n]; });
        if (missing.length && !recmgrSections(text)[sec]) {
            out.push('[' + sec + ']' + eol);
            missing.forEach(function (n) { out.push(n + eol); });
        }
    });
    return out.join('\n');
}

/* ---- limits for the services tools install -------------------------------- */
/* Every service unit (.service) an installed tool lists gets LIMITS_NAME in
 * its drop-in folder. LimitCORE=1: core_pattern pipes core dumps to the
 * crash handler, which restarts the head unit for a program it does not
 * list, and the kernel writes no piped core dump for a process whose
 * RLIMIT_CORE is 1, so a crash of the service, or of a program it starts
 * (they inherit the limit), stays the service's own. The start limit ends a
 * crash loop: a service that has started LIMITS_BURST times within
 * LIMITS_INTERVAL_S is left failed until the next boot, an
 * install of the tool or its interval has passed, overriding a unit's own
 * StartLimitIntervalSec=0. Units of other components, stock ones included,
 * never get one; a drop-in of this name for a unit no installed tool lists
 * goes, with its folder when nothing else is in it. */
var LIMITS_NAME = 'zz-mgu-deploy-limits.conf';
var LIMITS_INTERVAL_S = 600, LIMITS_BURST = 20;
var LIMITS_TEXT = ['# Written by mgu-deploy for every service a tool installs: a crash leaves no core dump for the',
    '# crash handler, which would restart the head unit, and a service that keeps failing stops.',
    '[Unit]', 'StartLimitIntervalSec=' + LIMITS_INTERVAL_S, 'StartLimitBurst=' + LIMITS_BURST, '',
    '[Service]', 'LimitCORE=1', ''].join('\n');
function limitsPath(unit) { return path.join(CFG.systemd, unit + '.d', LIMITS_NAME); }
function limitedUnits(c) {
    return (c.units || []).map(function (u) { return u.name; }).filter(function (n) { return /\.service$/.test(n); });
}
/* The units with this tool's drop-in now. */
function limitsPresent() {
    var out = [];
    try {
        fs.readdirSync(CFG.systemd).forEach(function (n) {
            var unit = n.replace(/\.d$/, '');
            if (unit !== n && lstatOrNull(limitsPath(unit))) out.push(unit);
        });
    } catch (e) { /* no systemd folder */ }
    return out;
}
/* The rootfs ops that give the given tools' services their drop-in and take
 * it from every other unit, among only (all units when null); changed: the
 * units whose drop-in is written or removed. */
function limitsPlan(tools, only) {
    var want = [], ops = [], changed = [];
    tools.forEach(function (t) {
        limitedUnits(t.component).forEach(function (u) { if (want.indexOf(u) < 0) want.push(u); });
    });
    var scope = only || want.concat(limitsPresent().filter(function (u) { return want.indexOf(u) < 0; }));
    scope.forEach(function (unit) {
        var p = limitsPath(unit), dir = path.dirname(p);
        if (want.indexOf(unit) >= 0) {
            if (bytesEqualFile(Buffer.from(LIMITS_TEXT), p)) return;
            ops.push({ type: 'copy', data: LIMITS_TEXT, path: p, mode: 0o644 });
            changed.push(unit);
        } else if (lstatOrNull(p)) {
            ops.push({ type: 'delete', path: p });
            if (fs.readdirSync(dir).length === 1) ops.push({ type: 'rmdir', path: dir });
            changed.push(unit);
        }
    });
    return { ops: ops, changed: changed, paths: scope.map(limitsPath) };
}
/* The names a tool has in recmgr's list: its `recmgr` names, and the name
 * of each service and socket unit it installs (a template's with its "@",
 * as the stock list has them) unless the firmware has that name (in
 * [ForceRestartList], or a unit of its own). A `recmgr` name outside
 * RECMGR_NAME never reads back from the list, so it is left out. */
function recmgrNamesOf(c) {
    var force = recmgrSections(recmgrText()).ForceRestartList || [];
    var out = (c.recmgr || []).filter(function (n) { return typeof n === 'string' && RECMGR_NAME.test(n); });
    (c.units || []).forEach(function (u) {
        var n = recmgrBase(u.name);
        if (/\.(service|socket)$/.test(u.name) && out.indexOf(n) < 0 && force.indexOf(n) < 0 && !stockUnit(n)) out.push(n);
    });
    return out;
}

/* ---- crash handler's restart whitelist ------------------------------------ */
/* Every core dump goes to the crash handler (dlt-cdh), which reboots the
 * unit unless the file name of the crashed process's executable
 * (/proc/<pid>/exe) is a line of [Whitelist] in its restart list (exact,
 * case-sensitive). The crash handler reads the list when it starts, so a
 * change counts from the next boot. A tool's names go in there while it is
 * installed: its crashNames (a tool whose component.json has none: the
 * names CRASH_NAMES_BUILTIN gives its id), and every ELF file it ships
 * executable unless the firmware has that name (in [ForceRestartList], or
 * a program of its own: stockProgram). A script runs as its interpreter,
 * whose name is not the tool's to add. Only names this tool added
 * (CRASH_OWNED) are ever removed, and other lines and sections round-trip
 * unchanged. A unit without the
 * list has nothing written. A name is a file name of letters, digits and
 * ._+-; a manifest's other entries are passed over. */

var CRASH_NAMES_BUILTIN = {
    'mgu-uplink': ['mgu-uplink'],
    'mgu-render': ['mgu-render'],
    'mgu-python': ['python3']
};
var CRASH_NAME = /^[A-Za-z0-9._+-]{1,255}$/;
/* force: the list's [ForceRestartList]. */
function crashNamesOf(t, force) {
    var c = t.component;
    var builtin = Object.prototype.hasOwnProperty.call(CRASH_NAMES_BUILTIN, c.id) ? CRASH_NAMES_BUILTIN[c.id] : [];
    var programs = (c.files || []).filter(function (f) {
        return (octalMode(f.mode) & 0o111) && isElf(path.join(t.root, 'current', f.path));
    }).map(function (f) { return path.basename(f.path); }).filter(function (n) {
        return force.indexOf(n) < 0 && !stockProgram(n);
    });
    return (Array.isArray(c.crashNames) ? c.crashNames : builtin).concat(programs).filter(function (n) {
        return typeof n === 'string' && CRASH_NAME.test(n);
    });
}
/* Whether the firmware ships a program of this name (a shell, node, a
 * BMW binary): whitelisting it would let the firmware's own crash pass. */
function stockProgram(name) {
    return CFG.stockBins.some(function (d) { return !!lstatOrNull(path.join(d, name)); });
}
function isElf(file) {
    var fd = null, head = Buffer.alloc(4);
    try {
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, head, 0, 4, 0);
    } catch (e) {
        return false;
    } finally {
        if (fd !== null) fs.closeSync(fd);
    }
    return head.toString('latin1') === '\x7fELF';
}
function crashOwned() {
    var o = readJsonOrNull(CRASH_OWNED);
    return o && Array.isArray(o.names) ? o.names : [];
}
/* text with addNames after [Whitelist]'s last entry and removeNames'
 * lines out of it; without [Whitelist], crashListPlan refuses the edit. */
function crashListWith(text, addNames, removeNames) {
    var lines = text.split('\n'), out = [], current = null, at = -1, eol = '';
    lines.forEach(function (line) {
        var l = listLine(line), name = l.name;
        if (l.section !== null) {
            current = l.section; out.push(line);
            if (current === 'Whitelist' && at < 0) at = out.length;
            return;
        }
        if (current === 'Whitelist' && name && removeNames.indexOf(name) >= 0) return;
        out.push(line);
        if (current === 'Whitelist' && name) { at = out.length; eol = /\r$/.test(line) ? '\r' : ''; }
    });
    if (!addNames.length || at < 0) return out.join('\n');
    var add = addNames.map(function (n) { return n + eol; });
    return out.slice(0, at).concat(add, out.slice(at)).join('\n');
}
/* What keeps the list as the given tools want it: the rootfs op (null
 * when the list is unchanged) and the names this tool then owns there;
 * null on a unit without the list. */
function crashListPlan(tools) {
    var st = lstatOrNull(CFG.crashList);
    if (!st || !st.isFile()) return null;
    var text = fs.readFileSync(CFG.crashList, 'utf8'), want = [], owned = crashOwned();
    var sections = recmgrSections(text), force = sections.ForceRestartList || [];
    tools.forEach(function (t) {
        crashNamesOf(t, force).forEach(function (n) { if (want.indexOf(n) < 0) want.push(n); });
    });
    var have = sections.Whitelist || [];
    var add = want.filter(function (n) { return have.indexOf(n) < 0; });
    var remove = owned.filter(function (n) { return want.indexOf(n) < 0 && have.indexOf(n) >= 0; });
    if (add.length && !sections.Whitelist) throw refuse(CFG.crashList + ' has no [Whitelist] section; left as it is');
    var next = crashListWith(text, add, remove);
    if (next !== text) checkListEdit(CFG.crashList, CRASH_LIST, text, next, add, remove);
    return {
        op: next === text ? null : { type: 'copy', data: next, path: CFG.crashList, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid },
        owned: owned.filter(function (n) { return want.indexOf(n) >= 0 && have.indexOf(n) >= 0; }).concat(add).sort(),
        add: add, remove: remove
    };
}
/* After the plan's op went through (remounted: / was remounted for it):
 * the names this tool owns recorded, and one line for a change. */
function crashListDone(plan, remounted) {
    if (!plan) return null;
    if (JSON.stringify(plan.owned) !== JSON.stringify(crashOwned().slice().sort())) {
        mkdirp(DEPLOY_DIR);
        writeAtomic(CRASH_OWNED, JSON.stringify({ names: plan.owned }) + '\n', 0o644);
    }
    if (!plan.op) return null;
    var parts = [];
    if (plan.add.length) parts.push('added ' + plan.add.join(', '));
    if (plan.remove.length) parts.push('removed ' + plan.remove.join(', '));
    if (remounted) parts.push('/ remounted read-write for it and back to read-only');
    var line = parts.join('; ');
    say('crash handler whitelist: ' + line);
    return line;
}
/* What keeps the status sync from remounting /: another writer may be
 * at work on it. app-privacy's boot run remounts / itself, without this
 * tool's lock. Its run is done once the unit is active (RemainAfterExit)
 * or failed, or inactive after the boot has started its units (an
 * install enables it without starting it); any other state, or none
 * readable, counts as ahead. Null when / is free to remount. */
function rootBusy() {
    var mode = rootMountMode();
    if (mode !== 'ro') return '/ is ' + (mode === 'unknown' ? 'in an unknown mount state' : 'read-write') + ': another writer may be at work';
    var privacy = 'app-privacy.service';
    if (lstatOrNull(path.join(CFG.systemd, 'multi-user.target.wants', privacy))) {
        var st = unitState(privacy, 'is-active');
        var done = st === 'active' || st === 'failed' ||
            st === 'inactive' && ['initializing', 'starting'].indexOf(unitState('', 'is-system-running')) < 0;
        if (!done) return privacy + ' is ' + st + ': its boot run may remount /';
    }
    return null;
}
/* The lock for a status step, taken only when free: true when held (the
 * step releases it), false when another run holds it. */
function statusLock() {
    var mine = LOCK_FILE + '.' + process.pid, held = lockState();
    if (!held.free && !held.live) breakStaleLock();
    mkdirp(DEPLOY_DIR);
    fs.writeFileSync(mine, process.pid + ' ' + bootId() + '\n', { mode: 0o600 });
    try { fs.linkSync(mine, LOCK_FILE); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; return false; }
    finally { rmrf(mine); }
}
/* What status brings the lists to: the crash handler's plan (null without
 * the list) and the recmgr op adding the installed tools' missing names,
 * the ops for both, whether the record of names this tool added changes,
 * and why a list is not brought up to date (errors): one list's refusal
 * leaves the other's change in place. */
function bootListsPlan() {
    var tools = installedTools(), names = [], crash = null, rec = null, errors = [];
    tools.forEach(function (t) {
        recmgrNamesOf(t.component).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    });
    try { crash = crashListPlan(tools); } catch (e) { errors.push(e.message); }
    var recText = recmgrText();
    try { rec = recmgrOp(names, []); } catch (e) { errors.push(e.message); }
    return {
        crash: crash, rec: rec, ops: [rec, crash && crash.op].filter(Boolean), errors: errors,
        recText: recText,
        record: !!crash && JSON.stringify(crash.owned) !== JSON.stringify(crashOwned().slice().sort())
    };
}
/* status's step: brings the crash handler's list and recmgr's to what the
 * installed tools want, so a deploy tool update (which the version before
 * it installs) writes them at the updater's status check after it, and a
 * firmware update that put a stock list back is undone. It remounts /
 * only for a change, only while / is read-only and no other writer can be
 * at work (rootBusy), under this tool's lock, with a snapshot first; the
 * window puts / back read-only on any exit. It says one line on stderr
 * per list it changes or does not. Returns { state: ok | changed |
 * pending | error, reason }: pending is tried again at the next status. */
function syncBootLists() {
    var out = process.stdout.write, locked = false;
    function failed(errors, done) {
        errors.forEach(function (m) { process.stderr.write('mgu-deploy: restart lists not updated: ' + m + '\n'); });
        return { state: 'error', reason: done.concat(errors).join('; ') };
    }
    // status --json keeps stdout for its JSON; the step's lines go to stderr
    process.stdout.write = function () { return true; };
    try {
        if (!FAKE && process.getuid() !== 0) return { state: 'pending', reason: 'status not run as root' };
        var plan = bootListsPlan();
        var idle = function () {
            if (plan.errors.length) return failed(plan.errors, []);
            return { state: 'ok', reason: plan.crash ? 'up to date' : 'no crash handler list on this unit' };
        };
        if (!plan.ops.length && !plan.record) return idle();
        if (statusReadOnly) return { state: 'pending', reason: 'read-only' };
        var busy = plan.ops.length && rootBusy();
        if (busy) return { state: 'pending', reason: busy };
        locked = statusLock();
        if (!locked) return { state: 'pending', reason: 'another mgu-deploy run holds the lock' };
        plan = bootListsPlan();
        if (!plan.ops.length && !plan.record) return idle();
        if (!plan.ops.length) {
            crashListDone(plan.crash, false);
            return plan.errors.length ? failed(plan.errors, []) :
                { state: 'ok', reason: 'the record of names this tool added is up to date' };
        }
        busy = rootBusy();
        if (busy) return { state: 'pending', reason: busy };
        takeSnapshot('crash-list', [CFG.crashList, CFG.recmgr, CRASH_OWNED, RECMGR_OWNED]);
        var remounts = rootMountMode() === 'ro';
        rootfsWindow(plan.ops);
        if (plan.rec) recmgrOwnedDone(plan.recText);
        var lines = [], line = crashListDone(plan.crash, remounts);
        if (line) lines.push('crash handler whitelist: ' + line);
        if (plan.rec) lines.push('recmgr list: added ' + plan.rec.added.join(', '));
        lines.forEach(function (l) { process.stderr.write(l + '\n'); });
        pruneBackups();
        if (plan.errors.length) return failed(plan.errors, lines);
        return { state: 'changed', reason: line && !plan.rec ? line : lines.join('; ') };
    } catch (e) {
        process.stderr.write('mgu-deploy: restart lists not updated: ' + e.message + '\n');
        return { state: 'error', reason: e.message };
    } finally {
        if (locked) releaseLock();
        process.stdout.write = out;
    }
}

/* status's step: gives every installed tool's services their limits
 * drop-in and takes it from units no tool lists (limitsPlan), so a deploy
 * tool update covers the tools installed before it at the updater's status
 * check after it, and a restore or firmware update is followed. Same rules
 * for remounting / as the crash list's step; a change is followed by
 * daemon-reload, and a service takes it at its next start. Returns
 * { state: ok | changed | pending | error, reason }. */
function syncLimits() {
    var out = process.stdout.write, locked = false;
    process.stdout.write = function () { return true; };
    try {
        if (!FAKE && process.getuid() !== 0) return { state: 'pending', reason: 'status not run as root' };
        if (!limitsPlan(installedTools(), null).ops.length) return { state: 'ok', reason: 'up to date' };
        if (statusReadOnly) return { state: 'pending', reason: 'read-only' };
        var busy = rootBusy();
        if (busy) return { state: 'pending', reason: busy };
        locked = statusLock();
        if (!locked) return { state: 'pending', reason: 'another mgu-deploy run holds the lock' };
        var plan = limitsPlan(installedTools(), null);
        if (!plan.ops.length) return { state: 'ok', reason: 'up to date' };
        busy = rootBusy();
        if (busy) return { state: 'pending', reason: busy };
        takeSnapshot('service-limits', plan.paths);
        rootfsWindow(plan.ops);
        runOk(CFG.systemctl, ['daemon-reload']);
        var line = 'drop-in ' + plan.changed.join(', ');
        process.stderr.write('service limits: ' + line + '\n');
        pruneBackups();
        return { state: 'changed', reason: line };
    } catch (e) {
        process.stderr.write('mgu-deploy: service limits not updated: ' + e.message + '\n');
        return { state: 'error', reason: e.message };
    } finally {
        if (locked) releaseLock();
        process.stdout.write = out;
    }
}

/* status's step on iDrive 8: turns live app changes on once, when the
 * installed deploy tool can make them, so the updater's status check after
 * a deploy tool update does it with nothing else to do. Once a copy of
 * this MainApp-21's main.js builds, takes app-privacy's patch and parses
 * (preflightFallback), it turns the fallback on (ensureFallback: its boot
 * unit, recmgr entry and copy); the running MainApp-21 keeps the main.js it
 * started with, so app changes are queued until the next start, as without
 * it. The record (id8-live.json) says it was done, which `fallback off` and
 * restores leave alone, or why the copy did not build, keyed by main.js,
 * this tool's version and app-privacy's tool, tried again when one
 * changes. Same rules for remounting / as the crash list's step. Returns
 * { state: ok | changed | pending | error, reason }, null off iDrive 8. */
var ID8_LIVE_RECORD = path.join(DEPLOY_DIR, 'id8-live.json');
function syncLiveId8() {
    if (!isId8()) return null;
    var out = process.stdout.write, locked = false, rec = readJsonOrNull(ID8_LIVE_RECORD) || {};
    var key = [shaOrNull(mainJs()), VERSION, shaOrNull(privacyTool())].join(' ');
    var done = function (why) { writeAtomic(ID8_LIVE_RECORD, JSON.stringify({ on: new Date().toISOString() }) + '\n', 0o644); return why; };
    process.stdout.write = function () { return true; };
    try {
        if (rec.on) return { state: 'ok', reason: fallbackPresent() ? 'on' : 'turned off since it was turned on' };
        if (fallbackPresent()) return { state: 'ok', reason: statusReadOnly ? 'on' : done('on') };
        if (rec.key === key) return { state: 'ok', reason: 'off: ' + rec.why };
        var held = statusHeld();
        if (held) return { state: 'pending', reason: held };
        if (!runningInstalled() && !FAKE) return { state: 'pending', reason: 'this deploy tool is not the installed one' };
        var busy = rootBusy();
        if (busy) return { state: 'pending', reason: busy };
        locked = statusLock();
        if (!locked) return { state: 'pending', reason: 'another mgu-deploy run holds the lock' };
        if (fallbackPresent()) return { state: 'ok', reason: done('on') };
        try { preflightFallback(); } catch (e) {
            if (!isRefusal(e)) throw e;
            writeAtomic(ID8_LIVE_RECORD, JSON.stringify({ key: key, why: e.message }) + '\n', 0o644);
            return { state: 'ok', reason: 'off: ' + e.message };
        }
        busy = rootBusy();
        if (busy) return { state: 'pending', reason: busy };
        var state = loadState();
        takeSnapshot('live-installs', fallbackTouched());
        ensureFallback(state, false);
        saveState(state);
        pruneBackups();
        process.stderr.write('live app installs: on from the next start of the head unit\n');
        return { state: 'changed', reason: done('on from the next start') };
    } catch (e) {
        process.stderr.write('mgu-deploy: live app installs not turned on: ' + e.message + '\n');
        return { state: 'error', reason: e.message };
    } finally {
        if (locked) releaseLock();
        process.stdout.write = out;
    }
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
        if (p === mainJs() && binds() && bindMounted(p)) return;
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
    writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify({ command: command, created: new Date().toISOString(),
        firmware: unitInfo().firmware, entries: manifest }, null, 2) + '\n');
    return dir;
}
/* Every snapshot also records the files any command may leave changed:
 * this tool's state, the fallback's unit, link, copy and app list, the
 * check-at-the-next-start unit and link, the recmgr list and the crash
 * handler's list and the names this tool added to each, the cleanup unit,
 * its link and the files it removes. The updater owns its
 * sources and credentials. */
function alwaysSnapshotted() {
    return [STATE_FILE, CFG.recmgr, CFG.crashList, CRASH_OWNED, RECMGR_OWNED, customAppsFile(), FALLBACK_COPY,
        path.join(CFG.systemd, FALLBACK_UNIT),
        path.join(CFG.systemd, 'multi-user.target.wants', FALLBACK_UNIT),
        path.join(CFG.systemd, VERIFY_UNIT), path.join(CFG.systemd, APPLY_WANTS, VERIFY_UNIT),
        path.join(CFG.systemd, CLEANUP_UNIT), path.join(CFG.systemd, APPLY_WANTS, CLEANUP_UNIT), UNUSED_FILE];
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
/* Whether this run took the stock snapshot: it holds the files as the run
 * found them, which tells nothing of what is stock. */
var stockTakenNow = false;
/* The first snapshot ever is also kept as "stock". A command that takes
 * several snapshots (one per artifact) writes stock first, over all of
 * them. */
function ensureStock(command, paths) {
    mkdirp(BACKUPS_DIR, 0o700);
    fs.chmodSync(BACKUPS_DIR, 0o700);
    var stock = path.join(BACKUPS_DIR, 'stock');
    if (fs.existsSync(stock)) return;
    writeSnapshot(stock, command, snapshotPaths(paths));
    stockTakenNow = true;
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
/* A file of the firmware's root file system: anything outside /var/opt. */
function systemPath(p) { return p.indexOf(CFG.varOpt + '/') !== 0 && p !== CFG.varOpt; }
function isRootfsPath(p) {
    if (FAKE && !FAKE_SH_WINDOW) return false;
    return systemPath(p);
}
function putBackEntry(dir, e) {
    if (e.kind === 'record' || e.kind === 'other') return;
    if (e.kind === 'absent') { rmrf(e.path); return; }
    mkdirp(path.dirname(e.path));
    var st = lstatOrNull(e.path);
    if (e.kind === 'symlink') {
        if (st && st.isDirectory()) rmrf(e.path);
        replaceLink(e.path, e.target);
        return;
    }
    rmrf(e.path);
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
/* The op that adds to a list on disk the names a snapshot's copy of it
 * (entry e) has in the sections an edit touches; null when it adds none
 * or the list on disk cannot be edited. */
function listUnionOp(dir, e) {
    var st = lstatOrNull(e.path);
    if (e.kind !== 'file' || !st || !st.isFile()) return null;
    var crash = e.path === CFG.crashList, kind = crash ? CRASH_LIST : RECMGR_LIST;
    var text = fs.readFileSync(e.path, 'utf8'), was = recmgrSections(text);
    var snap = recmgrSections(fs.readFileSync(path.join(dir, e.stored), 'utf8')), add = [];
    kind.edited.forEach(function (sec) {
        (snap[sec] || []).forEach(function (n) {
            if ((was[sec] || []).indexOf(n) < 0 && add.indexOf(n) < 0) add.push(n);
        });
    });
    var next = crash ? crashListWith(text, add, []) : recmgrWith(text, add, []);
    if (next === text) return null;
    try { checkListEdit(e.path, kind, text, next, add, []); } catch (err) { return null; }
    return { type: 'copy', data: next, path: e.path, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
}
/* Rootfs entries go back through trapped windows; the rest directly.
 * An entry already as recorded is left alone, so a snapshot of an
 * unchanged state restores without opening the window. The bounce record
 * outlives the restore. With only, just the entries of those paths. */
function restoreSnapshot(dir, only) {
    var data = readJson(path.join(dir, 'manifest.json'));
    var rootEntries = [], plain = [], lb = lastBounceAt();
    /* A snapshot holding main.js itself compares and restores the file
     * under the fallback copy; the caller binds the copy again. */
    if (binds() && bindMounted(mainJs()) &&
        data.entries.some(function (e) { return e.path === mainJs() && e.kind === 'file'; })) {
        runOk(CFG.umount, [mainJs()]);
    }
    data.entries.forEach(function (e) {
        if (e.kind === 'record' || selfPath(e.path) || updaterStatePath(e.path) || entryMatches(e)) return;
        if (only && only.indexOf(e.path) < 0) return;
        (isRootfsPath(e.path) ? rootEntries : plain).push(e);
    });
    /* the hooks' marks (noteHook) record hooks that ran, which no snapshot undoes */
    var marks = readJsonOrNull(STATE_FILE);
    plain.forEach(function (e) { putBackEntry(dir, e); });
    if (marks && typeof marks === 'object' && plain.some(function (e) { return e.path === STATE_FILE; })) persistMarks(marks);
    /* The lists' entries cover every unit on disk at each step: entries the
     * snapshot has go in first (added only), the units, links and drop-ins
     * go back, and only then the lists as the snapshot has them. */
    function op(e) {
        if (e.kind === 'absent') return { type: 'delete', path: e.path };
        if (e.kind === 'symlink') return { type: 'symlink', path: e.path, target: e.target };
        return { type: 'copy', src: path.join(dir, e.stored), path: e.path, mode: e.mode, uid: e.uid, gid: e.gid };
    }
    var lists = rootEntries.filter(function (e) { return e.path === CFG.recmgr || e.path === CFG.crashList; });
    var rest = rootEntries.filter(function (e) { return lists.indexOf(e) < 0; });
    rootfsWindow(lists.map(function (e) { return listUnionOp(dir, e); }).filter(Boolean));
    rootfsWindow(rest.map(op));
    rootfsWindow(lists.filter(function (e) { return !entryMatches(e); }).map(op));
    /* a limits drop-in taken out leaves no empty folder */
    var emptied = data.entries.filter(function (e) {
        var st = lstatOrNull(path.dirname(e.path));
        return e.kind === 'absent' && path.basename(e.path) === LIMITS_NAME && st && st.isDirectory() &&
            !fs.readdirSync(path.dirname(e.path)).length;
    }).map(function (e) { return path.dirname(e.path); });
    emptied.filter(function (d) { return !isRootfsPath(d); }).forEach(function (d) { fs.rmdirSync(d); });
    rootfsWindow(emptied.filter(isRootfsPath).map(function (d) { return { type: 'rmdir', path: d }; }));
    /* a copy put back or removed while bound leaves main.js on the file it
     * replaced: the copy there is bound again while its unit is */
    if (dropStaleBind() && fallbackPresent()) bindCopy();
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
var RUN_TEMP = /^(?:stage-|window-|main\.fallback-|CertificateManager\.tmp-|app-home-|lock\.|\.mgu-deploy-probe-)(\d+)(?:\.sh|\.js)?$|^write-(\d+)-\d+$|\.(?:tmp|partial|old)-(\d+)$/;
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
    /* A tool's earlier current folder a killed install moved aside: back as
     * current when nothing replaced it, else gone. */
    fs.readdirSync(CFG.varOpt).forEach(function (n) {
        var root = path.join(CFG.varOpt, n), cur = path.join(root, 'current'), st = lstatOrNull(root);
        if (n === 'public' || !st || !st.isDirectory()) return;
        fs.readdirSync(root).forEach(function (m) {
            var pid = /^current\.legacy-(\d+)$/.exec(m), p = path.join(root, m);
            if (!pid || pidAlive(Number(pid[1]))) return;
            if (lstatOrNull(cur)) rmrf(p);
            else { fs.renameSync(p, cur); say(n + ': the earlier install\'s current folder is back'); }
        });
    });
}
function releaseLock() {
    try { if (fs.readFileSync(LOCK_FILE, 'utf8').split(' ')[0] === String(process.pid)) fs.unlinkSync(LOCK_FILE); }
    catch (e) { /* not held */ }
}

/* ---- trapped rootfs window ------------------------------------------------ */
/* One sh script per operation remounts / read-write, applies the staged
 * writes in their order, and remounts read-only on any exit. A copied file
 * is on disk before it replaces the old one, and the rename is on disk
 * before the next op, so a power cut leaves the old or the new file and
 * every op before it. A root filesystem found read-write stays read-write.
 * In fake-root mode the writes are plain, synced the same way. */

function syncDisks() { runOk(CFG.sync, []); }

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
    if (FAKE && !FAKE_SH_WINDOW) {
        ops.forEach(function (op) {
            if (op.type === 'delete') rmrf(op.path);
            else if (op.type === 'mkdir') mkdirp(op.path, op.mode || 0o755);
            else if (op.type === 'rmdir') fs.rmdirSync(op.path);
            else if (op.type === 'symlink') { mkdirp(path.dirname(op.path)); rmrf(op.path); fs.symlinkSync(op.target, op.path); }
            else if (op.type === 'copy') {
                var tmp = op.path + '.tmp-' + process.pid;
                mkdirp(path.dirname(op.path)); fs.writeFileSync(tmp, fs.readFileSync(op.src));
                if (op.mode !== undefined) fs.chmodSync(tmp, op.mode);
                syncDisks(); fs.renameSync(tmp, op.path); syncDisks();
            }
            else if (op.type === 'tree') { rmrf(op.path); copyTree(op.src, op.path); }
            else if (op.type === 'mode') { if (op.uid !== undefined) fs.chownSync(op.path, op.uid, op.gid); fs.chmodSync(op.path, op.mode); }
        });
        syncDisks();
        return;
    }
    var before = rootMountMode(), lines = ['set -e'];
    if (before === 'rw') {
        say('/ is read-write; leaving it as found');
    } else {
        lines.push("trap '" + CFG.sync + "; " + CFG.mount + " -o remount,ro /' EXIT INT TERM HUP");
        lines.push(CFG.mount + ' -o remount,rw /');
    }
    ops.forEach(function (op) {
        var d = shQuote(path.dirname(op.path)), p = shQuote(op.path);
        if (op.type === 'delete') lines.push('rm -rf ' + p);
        else if (op.type === 'mkdir') lines.push('mkdir -p ' + p);
        else if (op.type === 'rmdir') lines.push('rmdir ' + p);
        else if (op.type === 'tree') lines.push('mkdir -p ' + d + '; rm -rf ' + p + '; cp -a ' + shQuote(op.src) + ' ' + p);
        else if (op.type === 'symlink') lines.push('mkdir -p ' + d + '; rm -rf ' + p + '; ln -s ' + shQuote(op.target) + ' ' + p);
        /* chown first: it clears setuid, which the chmod sets again */
        else if (op.type === 'mode') lines.push((op.uid !== undefined ? 'chown ' + op.uid + ':' + op.gid + ' ' + p + '; ' : '') + 'chmod ' + op.mode.toString(8) + ' ' + p);
        else if (op.type === 'copy') {
            lines.push('mkdir -p ' + d + '; cat ' + shQuote(op.src) + ' > ' + p + '.tmp-' + process.pid);
            if (op.mode !== undefined) lines.push('chmod ' + (op.mode & 0o7777).toString(8) + ' ' + p + '.tmp-' + process.pid);
            if (op.uid !== undefined) lines.push('chown ' + op.uid + ':' + op.gid + ' ' + p + '.tmp-' + process.pid);
            lines.push(shQuote(CFG.sync) + '; mv ' + p + '.tmp-' + process.pid + ' ' + p + '; ' + shQuote(CFG.sync));
        }
    });
    lines.push(shQuote(CFG.sync));
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
    if (c.internet !== undefined && (c.internet !== true || (typeof c.uids === 'string' ? !safeRel(c.uids) :
        !Array.isArray(c.uids) || !c.uids.length || !c.uids.every(function (u) { return u === Math.floor(u) && u > 0; })))) {
        throw refuse(file + ': "internet": true needs "uids", the tool\'s numeric uids or the file under /var/opt/<id> it keeps them in');
    }
    (c.recmgr || []).concat(c.restart || []).forEach(function (n) {
        if (typeof n !== 'string' || !n) throw refuse(file + ': bad recmgr/restart entry');
        if ((c.recmgr || []).indexOf(n) >= 0 && !RECMGR_NAME.test(n)) throw refuse(file + ': bad recmgr entry ' + JSON.stringify(n));
        if (n === 'oapcontroller' || n === 'oapcontroller.service') throw refuse(file + ': oapcontroller is never restarted');
    });
    if (c.crashNames !== undefined && (!Array.isArray(c.crashNames) || !c.crashNames.every(function (n) {
        return typeof n === 'string' && CRASH_NAME.test(n);
    }))) {
        throw refuse(file + ': crashNames is a list of process names, each a file name of letters, digits or ._+-');
    }
    if (c.mguProvides !== undefined && !PROVIDES.test(c.mguProvides)) {
        throw refuse(file + ': mguProvides is one lower-case name, e.g. "renderer"');
    }
    if (c.keepRunning !== undefined && typeof c.keepRunning !== 'boolean') throw refuse(file + ': keepRunning is true or false');
    if (c.postInstall !== undefined && (!Array.isArray(c.postInstall) || !c.postInstall.length ||
        !c.postInstall.every(function (x) { return typeof x === 'string'; }) ||
        !c.files.some(function (f) { return f.path === c.postInstall[0]; }))) {
        throw refuse(file + ': postInstall is a list: one of its files, then its arguments');
    }
    if (c.check !== undefined && (!Array.isArray(c.check) || !c.check.length ||
        !c.check.every(function (x) { return typeof x === 'string'; }) ||
        !c.files.some(function (f) { return f.path === c.check[0]; }))) {
        throw refuse(file + ': check is a list: one of its files, then its arguments');
    }
    ['activate', 'deactivate'].forEach(function (k) {
        if (c[k] !== undefined && !hookOk(c, k)) throw refuse(file + ': ' + k + ' ' + HOOK_SHAPE);
    });
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
    a.prepare = pkgDir !== dir || pkg.mguLocalOnly !== true || linker().needsSdk(pkgDir) ||
        linker().needsCertification(pkgDir) || linker().unknownInterfaces(pkgDir, unitInterfaces()).length ||
        id7PartsEdits(pkgDir).length ? 'package' : null;
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

/* ---- an app's HMI parts (iDrive 7) ------------------------------------------------ */
/* At an install MainApp copies, of the app's rhmiData, the first
 * uiDescriptions entry and the variantGroups whose "hmi" lists the HMI
 * Telematics reports (provisioningAttributes.hmiVersion: 2 ID7, 3 ID8, any
 * other ID7), the groups also only for the brand its coding names
 * (HMI_BRAND: 0 BMW, 1 BMW_I, 2 MINI, 3 RR, any other BMW), into
 * rhmiData/{uiDescription,strings,resources} of the app's home. Some iDrive 7
 * units report 3: MainApp then installs an app's iDrive 8 parts, or none
 * for an app with only iDrive 7 ones, which then has no tile.
 *
 * On such a unit (an iDrive 7 MainApp, unitInfo) an app's package lists
 * the reported HMI in application.json wherever it lists ID7 and nowhere
 * else before MainApp gets it, so MainApp installs the iDrive 7 parts; and
 * status puts the package's iDrive 7 parts in place for an installed app
 * whose installed parts differ from them, which shows from the next start. */
var HMI_REPORTED = { 2: 'ID7', 3: 'ID8' };
var HMI_BRANDS = { 0: 'BMW', 1: 'BMW_I', 2: 'MINI', 3: 'RR' };
var PROVISIONING_JSON = 'de_bmw_infotainment_telematic_provisioning_Provisioning.json';
/* Prints { hmiVersion, brand } as MainApp reads them: its coding module,
 * and the Provisioning field over the SOME/IP binding (argv: interface
 * file, binding, coding module); what it cannot read is left out. */
var HMI_READER = [
    "'use strict';",
    'var a = process.argv, out = {}, done = false;',
    'function end() { if (done) return; done = true; process.stdout.write("\\n" + JSON.stringify(out) + "\\n"); process.exit(0); }',
    'setTimeout(end, 5000);',
    'try { var c = new (require(a[3]).CodingNavigationProxy)(); if (!c.isCodingValid || c.isCodingValid()) out.brand = c.getHMI_BRAND(); } catch (e) {}',
    'try {',
    '    var cfg = JSON.parse(require("fs").readFileSync(a[1], "utf8"));',
    '    require(a[2]).buildProxy(cfg, Object.keys(cfg.instances)[0]).then(function (p) { return p.init().then(function () {',
    '        p.subscribeToAvailability(function (up) {',
    '            if (up) p.getValue("provisioningAttributes").then(function (v) { if (v && v.hmiVersion !== undefined) out.hmiVersion = String(v.hmiVersion); end(); }, end);',
    '        });',
    '    }); }).catch(end);',
    '} catch (e) { end(); }'
].join('\n');
function hmiReadFile() { return path.join(CFG.run, 'hmi-reported.json'); }
var HMI_READ;
/* { hmi, brand } MainApp installs for: hmi null when unread. A read is
 * kept for the rest of this start of the head unit. */
function mainappHmi() {
    if (HMI_READ) return HMI_READ;
    var raw = { hmiVersion: process.env.MGU_DEPLOY_HMI_VERSION || undefined, brand: process.env.MGU_DEPLOY_HMI_BRAND }, boot = bootId();
    if (raw.hmiVersion === undefined && !FAKE) {
        var kept = readJsonOrNull(hmiReadFile());
        if (kept && kept.boot === boot && typeof kept.hmiVersion === 'string') raw = kept;
        else {
            var iface = [path.join(CFG.mainapp, 'src-gen', PROVISIONING_JSON), path.join(CFG.mainapp, 'src-gen', 'someip', PROVISIONING_JSON)]
                .filter(function (f) { return fs.existsSync(f); })[0];
            var r = iface ? run(CFG.node, ['-e', HMI_READER, iface, env('MGU_DEPLOY_SOMEIP', '/usr/lib/someip.node'),
                path.join(CFG.mainapp, 'node_modules', 'codings.node')], { allowFail: true, timeout: 15000 }) : null;
            raw = (r && lastJsonLine(r.stdout)) || {};
            if (typeof raw.hmiVersion === 'string' && !statusReadOnly) {
                try { mkdirp(CFG.run); writeAtomic(hmiReadFile(), JSON.stringify({ boot: boot, hmiVersion: raw.hmiVersion, brand: raw.brand })); }
                catch (e) { /* read again next time */ }
            }
        }
    }
    HMI_READ = { hmi: raw.hmiVersion === undefined ? null : HMI_REPORTED[raw.hmiVersion] || 'ID7',
        brand: HMI_BRANDS[raw.brand] || 'BMW' };
    return HMI_READ;
}
/* The HMI an iDrive 7 unit reports when it is not ID7, else null. */
function otherHmiReported() {
    if (unitInfo().hmi !== 'ID7') return null;
    var h = mainappHmi().hmi;
    return h && h !== 'ID7' ? h : null;
}
function listsId7(e) { return !!e && Array.isArray(e.hmi) && e.hmi.indexOf('ID7') >= 0; }
/* application.json's text with `as` listed wherever ID7 is and nowhere
 * else, or null when that changes nothing or it lists no iDrive 7 UI. */
function id7PartsFor(text, as) {
    var j, changed = false;
    try { j = JSON.parse(text); } catch (e) { return null; }
    var app = j && j.application;
    if (!app || !Array.isArray(app.uiDescriptions) || !app.uiDescriptions.some(listsId7)) return null;
    app.uiDescriptions.concat(Array.isArray(app.variantGroups) ? app.variantGroups : []).forEach(function (e) {
        if (!e || !Array.isArray(e.hmi)) return;
        var has = e.hmi.indexOf(as) >= 0, id7 = e.hmi.indexOf('ID7') >= 0;
        if (id7 && !has) { e.hmi = e.hmi.concat([as]); changed = true; }
        if (!id7 && has) { e.hmi = e.hmi.filter(function (h) { return h !== as; }); changed = true; }
    });
    return changed ? JSON.stringify(j, null, 2) + '\n' : null;
}
/* The edits that make MainApp install a package tree's iDrive 7 parts on
 * this unit: [{ file, text }], none where it reports ID7. */
function id7PartsEdits(tree) {
    var as = otherHmiReported(), out = [];
    if (!as) return out;
    ['rhmiData', 'rhmiDataStartWidget'].forEach(function (d) {
        var f = path.join(tree, d, 'application.json'), t = null;
        try { t = id7PartsFor(fs.readFileSync(f, 'utf8'), as); } catch (e) { /* none */ }
        if (t) out.push({ file: f, text: t });
    });
    return out;
}
function editId7Parts(a, tree) {
    var edits = id7PartsEdits(tree);
    edits.forEach(function (e) { fs.writeFileSync(e.file, e.text); });
    if (edits.length) say(a.id + ' ' + a.version + ': its iDrive 7 HMI parts listed for ' + otherHmiReported() + ', which this head unit reports');
}
/* rel (application.json's "./a/b") inside src, or null. */
function insideRhmi(src, rel) {
    var r = typeof rel === 'string' ? path.normalize(rel) : null;
    return r && safeRel(r) ? path.join(src, r) : null;
}
/* The iDrive 7 parts of the rhmiData folder src for brand, as MainApp
 * merges them: { uiDescription: {name: path}, strings: {name: text},
 * resources: {name: path} }, regular files inside src only, or null when it
 * has no iDrive 7 UI there. */
function id7Parts(src, brand) {
    var app = (readJsonOrNull(path.join(src, 'application.json')) || {}).application;
    var ui = app && Array.isArray(app.uiDescriptions) ? app.uiDescriptions.filter(listsId7)[0] : null;
    var uiFiles = ui ? [insideRhmi(src, ui.applicationFilePath), insideRhmi(src, ui.uiDescriptionFilePath)] : [null];
    var regular = function (p) { var st = p && lstatOrNull(p); return !!st && st.isFile(); };
    if (!uiFiles.every(regular)) return null;
    var out = { uiDescription: {}, strings: {}, resources: {} }, texts = {};
    uiFiles.forEach(function (p) { out.uiDescription[path.basename(p)] = p; });
    (Array.isArray(app.variantGroups) ? app.variantGroups : []).forEach(function (g) {
        if (!listsId7(g) || !Array.isArray(g.brands) || g.brands.indexOf(brand) < 0) return;
        function each(rel, fn) {
            var dir = insideRhmi(src, rel);
            if (!dir) return;
            try {
                fs.readdirSync(dir).sort().forEach(function (n) { if (regular(path.join(dir, n))) fn(n, path.join(dir, n)); });
            } catch (e) { /* none */ }
        }
        each(g.stringsPath, function (n, p) { if (/\.json$/.test(n)) (texts[n] = texts[n] || []).push(p); });
        each(g.resourcesPath, function (n, p) { out.resources[n] = p; });
    });
    Object.keys(texts).forEach(function (n) {
        out.strings[n] = JSON.stringify(Object.assign.apply(null, [{}].concat(texts[n].map(readJson))));
    });
    return out;
}
var PART_MODES = { uiDescription: 0o644, strings: 0o660, resources: 0o644 };
function sameJsonFile(p, text) {
    try { return JSON.stringify(readJson(p)) === text; } catch (e) { return false; }
}
/* The installed HMI files of an app, as a signature of names, sizes and times. */
function partsSignature(uid, pkg) {
    var dir = path.join(appHome(uid), 'rhmiData'), st = statOrNull(pkg), out = [String(st && st.size), String(st && st.mtime.getTime())];
    Object.keys(PART_MODES).forEach(function (k) {
        var names = [];
        try { names = fs.readdirSync(path.join(dir, k)).sort(); } catch (e) { /* none */ }
        names.forEach(function (n) {
            var s = statOrNull(path.join(dir, k, n));
            out.push(k + '/' + n + ':' + (s ? s.size + ':' + s.mtime.getTime() : '-'));
        });
    });
    return out.join('|');
}
/* The installed apps of an iDrive 7 unit whose installed HMI files are not
 * their kept package's iDrive 7 parts: [{ id, version, uid, package, parts:
 * [{ dest, from | text, mode }] }]. Those the last look found right and
 * that have not changed since (state.hmi_parts) are not looked into. */
function id7PartsOff(state, stage) {
    if (unitInfo().hmi !== 'ID7' || !mgrDataReady()) return [];
    var known = state.hmi_parts || {}, seen = {}, todo = [], out = [];
    installedApps().forEach(function (app) {
        var pkg = keptFile(app.id, app.version);
        if (!fs.existsSync(pkg) || !lstatOrNull(path.join(appHome(app.uid), 'rhmiData', 'uiDescription'))) return;
        var sig = app.version + '|' + app.uid + '|' + partsSignature(app.uid, pkg);
        if (known[app.id] === sig) seen[app.id] = sig;
        else todo.push({ app: app, pkg: pkg, sig: sig });
    });
    /* only a unit that reports another HMI: one that reports ID7, or whose
     * report is not read yet, keeps what MainApp installed */
    if (todo.length && !otherHmiReported()) {
        todo.forEach(function (t) { if (known[t.app.id]) seen[t.app.id] = known[t.app.id]; });
        todo = [];
    }
    todo.forEach(function (t) {
        var app = t.app, dir = path.join(stage, app.id), parts = [], want = null;
        try {
            fs.mkdirSync(dir);
            if (run(CFG.tar, ['-xzf', t.pkg, '-C', dir], { allowFail: true }).status !== 0) return;
            var src = ['rhmiData', 'package/rhmiData', 'source/rhmiData'].map(function (r) { return path.join(dir, r); })
                .filter(function (d) { return fs.existsSync(path.join(d, 'application.json')); })[0];
            want = src ? id7Parts(src, mainappHmi().brand) : null;
        } catch (e) {
            warn(app.id + ' ' + app.version + "'s iDrive 7 HMI files are not looked at: " + e.message);
            return;
        }
        if (want) {
            Object.keys(PART_MODES).forEach(function (k) {
                Object.keys(want[k]).forEach(function (n) {
                    var dest = path.join(appHome(app.uid), 'rhmiData', k, n), v = want[k][n];
                    if (k === 'strings' ? sameJsonFile(dest, v) : bytesEqualFile(fs.readFileSync(v), dest)) return;
                    parts.push(k === 'strings' ? { dest: dest, text: v, mode: PART_MODES[k] } : { dest: dest, from: v, mode: PART_MODES[k] });
                });
            });
        }
        if (parts.length) out.push({ id: app.id, version: app.version, uid: app.uid, package: t.pkg, parts: parts });
        else seen[app.id] = t.sig;
    });
    state.hmi_parts = seen;
    return out;
}
var PENDING_HMI_PARTS = 'its tile shows from the next start (its iDrive 7 HMI files were put in place)';
/* status, as root: the installed apps' iDrive 7 HMI files put in place. */
function syncId7Parts() {
    if (unitInfo().hmi !== 'ID7') return;
    statusStep('HMI files', function () {
        var s = loadState(), was = JSON.stringify(s.hmi_parts || {}), stage = stageDir(), off;
        try {
            off = id7PartsOff(s, stage);
            off.forEach(function (app) {
                app.parts.forEach(function (p) {
                    var tmp = p.dest + '.tmp-' + process.pid;
                    fs.writeFileSync(tmp, p.text !== undefined ? p.text : fs.readFileSync(p.from));
                    fs.chmodSync(tmp, p.mode);
                    chownMaybe(tmp, MGR_UID, MGR_UID);
                    fs.renameSync(tmp, p.dest);
                });
                say(app.id + ' ' + app.version + ': ' + app.parts.length + ' iDrive 7 HMI file(s) put in place from its package');
                addPending(s, app.id, PENDING_HMI_PARTS);
            });
            if (off.length) { rmrf(stage); fs.mkdirSync(stage); id7PartsOff(s, stage); }
        } finally { rmrf(stage); }
        if (off.length || JSON.stringify(s.hmi_parts) !== was) saveState(s);
    });
}
/* The installed apps whose iDrive 7 HMI files are not in place, for
 * status to report: [{ id, version, files }]. */
function id7PartsReport() {
    if (unitInfo().hmi !== 'ID7') return [];
    var stage = null;
    try {
        stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-deploy-parts-'));
        return id7PartsOff(loadState(), stage).map(function (a) {
            return { id: a.id, version: a.version, files: a.parts.map(function (p) { return path.relative(appHome(a.uid), p.dest); }) };
        });
    } catch (e) { return []; } finally { if (stage) rmrf(stage); }
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
    var a = { kind: 'app', file: file, dir: dir, pkgDir: null, tree: path.join(dir, m.tree), pkg: pkg, id: m.id, version: m.version,
        prepare: 'build' };
    var raw = readJsonOrNull(path.join(dir, 'mgu-app.json')) || {};
    appHmi(a, file, raw.mguHmi !== undefined ? raw.mguHmi : pkg.mguHmi, [path.join(dir, m.tree, 'rhmiData')]);
    return a;
}
/* The interface ids of iDrive 7's interface database, which MainApp
 * installs an app's SOME/IP manifest against (oap_link.js
 * unknownInterfaces); null on iDrive 8 and without one to read. */
var UNIT_INTERFACES;
function unitInterfaces() {
    if (UNIT_INTERFACES !== undefined) return UNIT_INTERFACES;
    var db = isId8() ? null : readJsonOrNull(path.join(CFG.etc, 'oap', 'someip', 'someip-interfaces.json'));
    UNIT_INTERFACES = db && db.interfaces && typeof db.interfaces === 'object' && !Array.isArray(db.interfaces) ?
        Object.keys(db.interfaces) : null;
    return UNIT_INTERFACES;
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
function unknownSaid(u) {
    return u ? ', ' + u.dropped.join(', ') + ' (not on this unit) taken out of ' + u.manifest : '';
}
function prepareApp(a, stage) {
    if (!a.prepare) return a;
    var out = path.join(stage, 'built-' + a.id + '@' + a.version + '.tgz'), r, link = linker();
    try {
        editId7Parts(a, a.prepare === 'build' ? a.tree : a.pkgDir);
        if (a.prepare === 'build') {
            r = link.build(a.dir, out, { donors: unitDonors(), workDir: stage, interfaces: unitInterfaces() });
            say('built ' + a.id + ' ' + a.version + ' from its source package (' + r.moduleCount +
                ' modules, oap-sdk from ' + r.donor + (r.entry ? ', main from ' + r.entry : '') +
                (r.certification ? ', the certification service added to ' + r.certification : '') + unknownSaid(r.unknown) + ')');
        } else {
            r = link.preparePackage(a.pkgDir, out, { donors: unitDonors(), interfaces: unitInterfaces() });
            say('prepared ' + a.id + ' ' + a.version + ': marked local-only' +
                (r.sdk ? ', node_modules/oap-sdk generated from ' + r.sdk.donor + ' (' + r.sdk.api.join(', ') + ')' : '') +
                (r.shrinkwrap ? ', npm-shrinkwrap.json added' : '') +
                (r.permissions.length ? ', ' + r.permissions.join(' and ') + ' added to permissions.json' : '') +
                (r.certification ? ', the certification service added to ' + r.certification : '') + unknownSaid(r.unknown));
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
/* The flags the manager keeps for the app hide its tile: provisioning
 * withholds it, which a restart does not change. */
function tileWithheld(entry) {
    var t = tileFlags(entry);
    return t.allowed === 'false' || t.enabled === 'false';
}
/* fb: fallbackState() with manager_runs_copy. On iDrive 7 the cache keeps
 * the flags of the last listing the manager applied, so an app only the
 * fallback lists (in custom_apps.json) shows only while the running
 * manager runs the fallback copy. With no manager running (null) no app is
 * listed; a copy whose in-place hook has not announced itself for the
 * running manager counts as not run (false): both report the tile hidden,
 * since neither shows that it is listed. The retired installer's leftovers
 * list apps by themselves, so with them the cache stands. iDrive 8 lists
 * apps from its das files at the manager's start, and its cache is that. */
function tileState(app, fb) {
    var visible = tileFlags(app.entry).visible, listed = fb.apps.indexOf(app.id) >= 0;
    var named = isId8() ? provisioningNames(app.id) : null;
    if (named !== null) {
        visible = visible && (named || (fb.listed_by_manager || []).indexOf(app.id) >= 0);
        return { provisioned: visible && named, fallback: visible && !named, visible: visible };
    }
    if (isId8()) listed = listed && fb.active;
    else if (listed && !retiredBackups().length) visible = visible && fb.manager_runs_copy === true;
    return { provisioned: visible && !listed, fallback: visible && listed, visible: visible, withheld: tileWithheld(app.entry) };
}

/* ---- internet for selected components ------------------------------------------ */
/* A tool whose component.json says "internet": true has its uids (its
 * "uids", or the numbers in the file under /var/opt/<id> that "uids" names,
 * which the tool keeps) in /var/opt/mgu-uplink/uids.d/<id>, an app whose package.json says
 * "mguInternet": true its id in apps.d/<id>; mgu-uplink reads both folders
 * besides its conf. They are written while mgu-uplink is installed (its
 * own install writes every one) and removed with the component. */
function wantedDropIns() {
    var want = {};
    installedTools().forEach(function (t) {
        var uids = t.component.internet === true ? t.component.uids : null;
        if (typeof uids === 'string') {
            uids = parseColonFile(path.join(CFG.varOpt, t.id, uids)).map(Number)
                .filter(function (u) { return u === Math.floor(u) && u > 0; });
        }
        if (Array.isArray(uids) && uids.length) want[uplinkDropIns(t.id)[0]] = uids.join('\n') + '\n';
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
    limitedUnits(c).forEach(function (u) { paths.push(limitsPath(u)); });
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
/* A unit its start limit stopped (LIMITS_BURST starts within
 * LIMITS_INTERVAL_S). When the limit ends a loop of automatic restarts,
 * systemd 237 keeps the first failure's Result (signal, exit-code), so a
 * failed unit with that many restarts counts too. */
function startLimitHit(unit) {
    var r = systemctl(['show', '-p', 'ActiveState', '-p', 'Result', '-p', 'NRestarts', unit]).stdout || '';
    return /^Result=start-limit-hit$/m.test(r) ||
        /^ActiveState=failed$/m.test(r) && Number((/^NRestarts=(\d+)$/m.exec(r) || [])[1]) >= LIMITS_BURST - 1;
}
/* A component's restart[] units. A running one restarts when recmgr has
 * loaded its entry, else it keeps running until a reboot (pending). One
 * not running is started on a fresh install, or when its start limit
 * stopped it (its socket, for a socket-activated one), under the same
 * rule, else it starts at the next boot (pending). Enabled sockets follow the same rule
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
        } else if ((fresh || startLimitHit(unit)) && !socketActivated) {
            if (loaded) {
                systemctl(['reset-failed', unit]);
                runOk(CFG.systemctl, ['start', unit]); say('started ' + unit); out.push(unit);
            }
            else { addPending(state, c.id, PENDING_BOOT); say(unit + ' ' + PENDING_BOOT); }
        } else if (socketActivated && loaded && startLimitHit(unit)) {
            /* its start limit failed the socket too */
            var sock = recmgrBase(unit) + '.socket';
            systemctl(['reset-failed', unit, sock]);
            if (systemctl(['start', sock]).status === 0) say('started ' + sock);
            else warn('could not start ' + sock);
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
function privacyApplyAndBounce(state) {
    var tool = privacyTool(), off = guardWhy();
    if (!fs.existsSync(tool)) return { ok: false, why: 'tool missing at ' + tool };
    /* the boot run of app-privacy.service applies it at the next start */
    if (off) {
        if (state) addPending(state, 'app-privacy', PENDING_NEXT_START);
        say('app-privacy: applied at the next start of the head unit (' + off + ')');
        return { ok: true };
    }
    var r = run(CFG.node, [tool, 'apply', '--json'], { allowFail: true, timeout: 120000 });
    var result = lastJsonLine(r.stdout);
    if (r.status !== 0 || !result) {
        return { ok: false, why: 'apply exited ' + r.status + (result ? privacyMismatch(result) : ' with no result') };
    }
    say('app-privacy: ' + (result.state || 'applied') + (result.changed ? ' (applied now)' : ''));
    var skipped = privacySkipped(result.edits);
    if (skipped && skipped !== privacySkippedSaid) say('app-privacy: ' + (privacySkippedSaid = skipped));
    /* MainApp-21 is never bounced: it loads the bundles at its next start,
     * as it takes app changes (app-privacy reports nextStart) */
    if (isId8()) {
        if (result.nextStart) {
            addPending(state, 'app-privacy', PENDING_NEXT_START);
            say('app-privacy: in effect from the next start of the head unit');
        }
    } else if ((result.changed || result.restartNeeded) && managerPid()) {
        if (!privacyMayWait) bounceManager();
        else if (!privacyBounceOwed) {
            privacyBounceOwed = true;
            say('app-privacy: the app manager loads it at ' + (privacyWaitsRelist ? 'its next restart' : 'the app install\'s restart'));
        }
    }
    return { ok: true };
}
/* An install with an app, on an iDrive 7 unit where the running manager
 * can list no app of ours (no fallback present or bound, none listed in
 * custom_apps.json, none in its registry, no retired installer's edit):
 * app-privacy's bounce waits for the bounce the app's
 * install makes anyway, as the fallback goes on then (the manager runs
 * older code than main.js), so the manager restarts once, with the patch,
 * the fallback and the app. Until then it runs stock code, which knows
 * nothing of the app; a manager that restarts meanwhile loads the patched
 * bundles. A bounce still owed when the install ends is made then. */
var privacyMayWait = false, privacyBounceOwed = false, privacyWaitsRelist = false;
function managerListsNoApp() {
    return !fallbackPresent() && !(binds() && bindMounted(mainJs())) && !Object.keys(readCustomApps()).length && !ourApps().length &&
        !retiredBackups().length;
}
function settlePrivacyBounce() {
    privacyMayWait = false;
    if (!privacyBounceOwed) return;
    privacyBounceOwed = false;
    if (managerPid()) bounceManager();
}
/* The skipped line this run printed last: a run that applies app-privacy
 * once per app names the same skipped edits once. */
var privacySkippedSaid = '';
/* app-privacy's per-edit results (1.7.0 on) in one line, when it left out
 * privacy-only edits whose anchors this MainApp lacks: "11 of 12 privacy
 * edits applied; skipped: <title>, ..."; '' otherwise. */
function privacySkipped(edits) {
    if (!Array.isArray(edits)) return '';
    var privacy = edits.filter(function (e) { return e && !e.required && String(e.id).indexOf('helper:') !== 0; });
    var skipped = privacy.filter(function (e) { return e.result === 'skipped-not-found'; });
    if (!skipped.length) return '';
    return privacy.filter(function (e) { return e.result === 'applied'; }).length + ' of ' + privacy.length +
        ' privacy edits applied; skipped: ' + skipped.map(function (e) { return e.title || e.id; }).join(', ');
}
/* app-privacy's record of its runs (native/app-privacy/README.md,
 * "Record"), null without one. */
function privacyRecord() {
    return readJsonOrNull(path.join(CFG.varOpt, 'app-privacy', 'edit-record.json'));
}
/* app-privacy's JSON result of a refusal: the MainApp bundles do not
 * match its edits (a MainApp version it was not made for, or bundles
 * carrying a newer app-privacy's edits). */
function privacyMismatch(result) {
    if (result.state !== 'mismatch' || !Array.isArray(result.files)) return '';
    var problems = [];
    result.files.forEach(function (f) {
        (f.problems || []).forEach(function (p) { problems.push(path.basename(f.path || f.kind || '') + ': ' + p); });
    });
    var pkg = readJsonOrNull(path.join(mainappRoot(), 'package.json'));
    return ': its edits do not fit this head unit\'s MainApp' + (pkg && pkg.version ? ' ' + pkg.version : '') +
        ' (' + problems.join('; ') + ')';
}
/* Before anything changes: the app-privacy this install brings must fit
 * this head unit's MainApp, else the install is refused and the car stays
 * as it is. */
function preflightPrivacy(artifacts) {
    artifacts.filter(function (a) { return a.kind === 'tool' && a.id === 'app-privacy'; }).forEach(function (a) {
        var tool = env('MGU_DEPLOY_PRIVACY', path.join(a.dir, 'files', 'patch_mainapp.js'));
        if (!fs.existsSync(tool)) return;
        var result = lastJsonLine(run(CFG.node, [tool, 'check', '--json'], { allowFail: true, timeout: 120000 }).stdout);
        if (result && result.state === 'mismatch') {
            throw refuse('app-privacy ' + a.version + privacyMismatch(result) + '; nothing was installed');
        }
    });
}
/* After app-privacy's revert put the stock bundles back. */
function privacyReverted() {
    if (!isId8()) {
        if (managerPid()) bounceManager();
        return;
    }
    say('app-privacy: removed; MainApp-21 runs without it from the next start of the head unit');
}

/* ---- stock files a tool's own code must leave usable ------------------------- */
/* A tool's hooks and postInstall run as root and may write a stock file on /
 * (a patch of carplay). STOCK_NEEDS lists the stock files whose service, run
 * as its own user, fails when that user cannot read or run them, and recmgr
 * then restarts the head unit at every start (a carplay left 0700 root fails
 * carplay.service with 203/EXEC), with the bits for group and others the
 * user needs: read and execute for a program, read for a config. After each
 * hook and postInstall, fixStock adds those bits back to such a file that
 * lacks one, and sets root:root on one owned otherwise, in a rootfs window,
 * with a warning; the rest of its mode stays. Only a regular file on /'s
 * file system is touched: none through a symlink (the file or a folder above
 * it), none another mount covers. */
var STOCK_NEEDS = [
    { path: 'usr/bin/carplay', bits: 0o055 },
    { path: 'usr/bin/aapd', bits: 0o055 },
    { path: 'etc/aapd.conf', bits: 0o044 }
];
/* The mount points in the mounts table. */
function mountPoints() {
    try {
        return fs.readFileSync(CFG.procMounts, 'utf8').split('\n').map(function (l) {
            return (l.split(' ')[1] || '').replace(/\\040/g, ' ');
        }).filter(Boolean);
    } catch (e) { return []; }
}
/* The stock file at rel under the root when fixStock may touch it: its lstat, else null. */
function stockFileStat(rel, top, mounts) {
    var p = CFG.rootfs, parts = rel.split('/'), st = null, i;
    for (i = 0; i < parts.length; i++) {
        p = path.join(p, parts[i]);
        st = lstatOrNull(p);
        if (!st || st.isSymbolicLink() || st.dev !== top.dev ||
            mounts.indexOf(p) >= 0 || mounts.indexOf(path.join('/', path.relative(CFG.rootfs, p))) >= 0) return null;
    }
    return st.isFile() ? st : null;
}
/* Gives each file of STOCK_NEEDS the bits its user needs back, and root:root
 * (prefix starts each line). Throws when the rootfs window does, as when / is
 * not read-only after it. */
function fixStock(prefix) {
    var top = lstatOrNull(CFG.rootfs), mounts = mountPoints(), ops = [];
    if (!top) return;
    STOCK_NEEDS.forEach(function (n) {
        var st = stockFileStat(n.path, top, mounts);
        if (!st) return;
        var mode = st.mode & 0o7777, want = mode | n.bits, own = st.uid !== 0 || st.gid !== 0;
        if (want === mode && !own) return;
        var p = path.join(CFG.rootfs, n.path), op = { type: 'mode', path: p, mode: want };
        if (own) { op.uid = 0; op.gid = 0; }
        warn(prefix + p + ' is ' + modeOwner(mode, st.uid, st.gid) + (want !== mode ? ', which its service\'s user cannot ' +
            (n.bits & 0o011 ? 'run' : 'read') : ', not root\'s') + ': it becomes ' + modeOwner(want, 0, 0));
        ops.push(op);
    });
    if (ops.length) rootfsWindow(ops);
}
function modeOwner(mode, uid, gid) { return ('000' + (mode & 0o7777).toString(8)).slice(-4) + ' ' + uid + ':' + gid; }

/* ---- activate and deactivate ------------------------------------------------- */
/* A tool's "activate" (run once a version is in place) and "deactivate" (run
 * before it is removed), deploy/README.md "Activate and deactivate". The
 * last stdout line, when a JSON object, carries "reboot" (why a head-unit
 * start is needed), "status" and "removeWhenUnused" (handOver). */
var HOOK_SHAPE = 'is ["node", <argument>...] or [<an executable file of the tool>, <argument>...], non-empty strings without ".."';
function hookOk(c, k) {
    var v = c[k];
    return Array.isArray(v) && v.length > 0 && v.every(function (s) {
        return typeof s === 'string' && s !== '' && s.split('/').indexOf('..') < 0;
    }) && (v[0] === 'node' || (c.files || []).some(function (f) { return f && f.path === v[0] && (octalMode(f.mode) & 0o111); }));
}
function runHook(id, dir, c, which, state) {
    var argv = c[which], prefix = id + ' ' + which + ': ';
    var lines = function (s) { return (s || '').split('\n').filter(function (l) { return l.trim(); }); };
    if (!hookOk(c, which)) return { ok: false, why: HOOK_SHAPE };
    say(prefix + argv.join(' '));
    var r = cp.spawnSync(argv[0] === 'node' ? CFG.node : path.join(dir, argv[0]), argv.slice(1), {
        cwd: dir, encoding: 'utf8', timeout: CFG.hookTimeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 << 20
    });
    var stuck = null;
    try { fixStock(prefix); } catch (e) { stuck = 'left a stock file its service cannot use, and fixing it failed: ' + e.message; }
    var out = lines(r.stdout), err = lines(r.stderr), result = null;
    if (!r.error && r.status === 0 && out.length) {
        try { result = JSON.parse(out[out.length - 1]); } catch (e) { result = null; }
        if (result && typeof result === 'object' && !Array.isArray(result)) out.pop();
        else result = null;
    }
    out.concat(err).forEach(function (l) { say(prefix + l); });
    if (r.error || r.status !== 0) {
        var last = (err.length ? err : out).slice(-1)[0];
        var why = r.error && r.error.code === 'ETIMEDOUT' ? 'timed out after ' + Math.round(CFG.hookTimeoutMs / 1000) + ' s'
            : r.error ? 'could not run: ' + r.error.message : r.status === null ? 'was killed (' + r.signal + ')' : 'exited ' + r.status;
        return { ok: false, why: why + (last ? ': ' + last.trim() : '') + (stuck ? '; it ' + stuck : '') };
    }
    if (result && typeof result.status === 'string' && result.status.trim()) say(prefix + oneLine(result.status).trim());
    var reboot = result && typeof result.reboot === 'string' && result.reboot.trim() ? oneLine(result.reboot).trim() : null;
    if (result && result.reboot !== undefined && !reboot) warn(prefix + '"reboot" is not a reason; ignored');
    if (reboot) say(prefix + 'a head-unit restart is pending: ' + reboot);
    noteHook(state, id, c.version, which);
    if (result && result.removeWhenUnused !== undefined) handOver(id, result.removeWhenUnused, state);
    /* it ran, recorded above; a restart it asked for stays pending, on disk
     * at once like the records, when the stock files fail it */
    if (stuck) {
        if (reboot) {
            addPending(state, id, reboot);
            try { var disk = loadState(); addPending(disk, id, reboot); saveState(disk); }
            catch (e) { warn(prefix + 'its restart is not on disk yet: ' + e.message); }
        }
        return { ok: false, why: stuck, reboot: reboot };
    }
    return { ok: true, reboot: reboot };
}
/* Per tool, in state.json: the kept versions whose last hook to run was
 * their deactivate ("deactivated": { <id>: [<version>...] }), which are not
 * deactivated again, and those whose deactivate failed when an install
 * would have removed them ("deactivate_owed"), kept for the tool's next
 * install or removal to run it again; a version made current has neither.
 * which: the hook that ran, "owed", or "gone" for a version no longer kept
 * or made current. */
function noteHook(state, id, version, which) {
    ['deactivated', 'deactivate_owed'].forEach(function (key) {
        var all = state[key] && typeof state[key] === 'object' ? state[key] : (state[key] = {});
        var list = (Array.isArray(all[id]) ? all[id] : []).filter(function (v) { return v !== version; });
        if (which === (key === 'deactivated' ? 'deactivate' : 'owed')) list.push(version);
        if (list.length) all[id] = list;
        else delete all[id];
    });
    /* kept in memory for the command's own save when the disk refuses it */
    try { persistMarks(state); } catch (e) { warn(id + ': the record of its hooks is not on disk yet: ' + e.message); }
}
/* The marks of state (noteHook) written into state.json at once, whatever
 * else the command changes and saves later. */
function persistMarks(state) {
    var disk = readJsonOrNull(STATE_FILE);
    if (!disk || typeof disk !== 'object') disk = {};
    disk.deactivated = state.deactivated;
    disk.deactivate_owed = state.deactivate_owed;
    mkdirp(DEPLOY_DIR);
    writeAtomic(STATE_FILE, JSON.stringify(disk, null, 2) + '\n', 0o644);
}
function noted(state, key, id, version) {
    return !!(state[key] && Array.isArray(state[key][id]) && state[key][id].indexOf(version) >= 0);
}
/* The kept versions of tool id besides current whose deactivate is still to
 * run, oldest first: one newer than current never deactivated (an earlier
 * deploy tool's rollback left it), or one it is owed. */
function deactivateDue(state, id, root, current) {
    var all = [];
    try { all = fs.readdirSync(path.join(root, 'versions')).filter(semverParts); } catch (e) { /* none kept */ }
    return all.filter(function (v) {
        return v !== current && (noted(state, 'deactivate_owed', id, v) || semverCmp(v, current) > 0 && !noted(state, 'deactivated', id, v));
    }).sort(semverCmp);
}

/* ---- files removed once unused ---------------------------------------------- */
/* A file on / a hook hands over ("removeWhenUnused") is one a process may
 * still run: a binary the hook replaced while it ran, kept linked because an
 * unlinked file a process holds keeps / from going read-only. It is removed at
 * once when no process runs it; else it waits in UNUSED_FILE, and
 * mgu-deploy-cleanup.service (enabled and in the recmgr list from then on)
 * removes it at a later start, once nothing runs it. Only a regular file is
 * removed. */
var UNUSED_FILE = path.join(DEPLOY_DIR, 'remove-when-unused.json');
var CLEANUP_UNIT = 'mgu-deploy-cleanup.service', CLEANUP_NAME = 'mgu-deploy-cleanup';
function readUnused() {
    var j = readJsonOrNull(UNUSED_FILE);
    return j && Array.isArray(j.paths) ? j.paths.filter(function (p) { return typeof p === 'string'; }) : [];
}
function writeUnused(paths) {
    if (!paths.length) { rmrf(UNUSED_FILE); return; }
    mkdirp(DEPLOY_DIR);
    writeAtomic(UNUSED_FILE, JSON.stringify({ paths: paths }, null, 2) + '\n', 0o644);
}
function executed(p) {
    var st = statOrNull(p);
    if (!st) return false;
    var pids = [];
    try { pids = fs.readdirSync(CFG.proc).filter(function (n) { return /^\d+$/.test(n); }); } catch (e) { /* no proc */ }
    return pids.some(function (pid) {
        var x = statOrNull(path.join(CFG.proc, pid, 'exe'));
        return !!x && x.ino === st.ino && x.dev === st.dev;
    });
}
function removeUnused(paths) {
    var keep = [], ops = [];
    paths.forEach(function (p) {
        var st = lstatOrNull(p);
        if (!st) return;
        if (!st.isFile()) { warn(p + ' is not a regular file; left as it is'); return; }
        if (executed(p)) keep.push(p);
        else ops.push({ type: 'delete', path: p });
    });
    if (ops.length) {
        rootfsWindow(ops);
        ops.forEach(function (op) { say('removed ' + op.path + ': no process runs it'); });
    }
    return keep;
}
function handOver(id, paths, state) {
    if (!Array.isArray(paths)) { warn(id + ': "removeWhenUnused" is not a list; ignored'); return; }
    var ok = paths.filter(function (p) {
        var good = typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p && p !== '/' && !/\/$/.test(p);
        if (!good) warn(id + ': ' + JSON.stringify(p) + ' is not an absolute file path; ignored');
        return good;
    });
    var keep = removeUnused(ok);
    var queued = readUnused();
    keep.forEach(function (p) { if (queued.indexOf(p) < 0) queued.push(p); });
    writeUnused(queued);
    if (keep.length) {
        ensureBootUnit(state, CLEANUP_UNIT, CLEANUP_NAME);
        say(id + ': ' + keep.join(', ') + ' removed at a later start, once no process runs it');
    }
}
function cmdRemoveUnused() {
    var queued = readUnused();
    if (!queued.length) { say('nothing to remove'); return 0; }
    var keep = removeUnused(queued);
    writeUnused(keep);
    keep.forEach(function (p) { say(p + ' is still run by a process; kept for a later start'); });
    return 0;
}

/* ---- tool install ------------------------------------------------------------ */

/* Installs one tool artifact; tx records what was there before, for
 * rollbackTool. A failed health check, app-privacy apply, activate or check
 * throws with e.health / e.privacy / e.activate / e.check set. Versions other
 * than the new one and the one current pointed to are pruned only once it is
 * up. */
function installTool(a, state, tx) {
    var c = a.component, root = path.join(CFG.varOpt, c.id);
    var versions = path.join(root, 'versions');
    var dest = path.join(versions, c.version);
    var before = currentTarget(root);
    var prev = before ? readJsonOrNull(path.join(versions, before, 'component.json')) : null;
    var i7 = i7Takeover(a);
    tx.root = root; tx.before = before; tx.rootExisted = fs.existsSync(root);
    tx.versionExisted = fs.existsSync(dest); tx.socketsActive = {};
    /* set up under another firmware, no hook of it run on this one: no hook
     * of a version it replaces runs (the firmware put back what they set up) */
    var moved = tx.moved = a.firmwareMoved || toolMoved(state, c.id);
    /* an older version, or one from another source (a.otherSource): the
     * version it replaces runs its deactivate first, with all of it in
     * place, as at its removal; a failed one keeps that version current.
     * Firmware-moved, it is recorded as deactivated instead, so no later
     * install runs it. */
    var replaces = !!prev && !!prev.deactivate && before !== c.version && (a.otherSource || semverCmp(c.version, before) < 0);
    if (replaces && moved) noteHook(state, c.id, before, 'deactivate');
    if (replaces && !moved) {
        tx.deactivated = true;
        var dr = runHook(c.id, path.join(versions, before), prev, 'deactivate', state);
        if (!dr.ok) throw refuse(c.id + ' ' + before + ': deactivate ' + dr.why + '; ' + before + ' stays current');
        if (dr.reboot) addPending(state, c.id, dr.reboot);
    }
    /* a kept version whose deactivate is due (deactivateDue) runs it before
     * the version goes, as at its removal; one that fails refuses the
     * install, the version kept and owed for the tool's next install or
     * removal. A failed install activates the version it replaces again.
     * Any install of the tool after a firmware update, before a hook of it
     * ran on this firmware (toolMoved; a.firmwareMoved, the kept copy laid
     * again: the firmware put the patched files back), leaves them kept and
     * records them as deactivated, so no later install runs them;
     * laying it again for another reason runs them, and one that fails
     * stays kept and owed while the current version is laid again. */
    var due = before ? deactivateDue(state, c.id, root, before).filter(function (v) { return v !== c.version; }) : [];
    tx.keep = moved ? due : [];
    if (moved) due.forEach(function (v) { noteHook(state, c.id, v, 'deactivate'); });
    (moved ? [] : due).forEach(function (v) {
        var vc = readJsonOrNull(path.join(versions, v, 'component.json'));
        if (!vc || vc.id !== c.id || !vc.deactivate) return;
        tx.deactivated = true;
        var hr = runHook(c.id, path.join(versions, v), vc, 'deactivate', state);
        if (!hr.ok) {
            noteHook(state, c.id, v, 'owed');
            if (a.repair) {
                tx.keep.push(v);
                warn(c.id + ' ' + v + ': deactivate ' + hr.why + '; it stays kept and owed, and ' + c.id + ' ' + c.version + ' is laid again');
                return;
            }
            throw refuse(c.id + ' ' + c.version + ': the kept ' + c.id + ' ' + v + ' must be deactivated first, and its deactivate ' +
                hr.why + '; ' + before + ' stays current');
        }
        if (hr.reboot) addPending(state, c.id, hr.reboot);
    });
    /* A current that is no link (a folder an earlier installer left, e.g.
     * app-privacy 1.5.0's) cannot be replaced by rename: it goes aside, and
     * a rollback puts it back. It goes once the install is through. */
    var curStat = lstatOrNull(path.join(root, 'current'));
    tx.legacy = null;
    if (curStat && !curStat.isSymbolicLink()) {
        var legacy = path.join(root, 'current.legacy-' + process.pid);
        fs.renameSync(path.join(root, 'current'), legacy);
        tx.legacy = legacy;
        say(c.id + ': the earlier install\'s current folder moved aside to ' + legacy);
    }
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
        placeVersion(partial, dest, aside);
    }
    if (before !== c.version) switchCurrent(root, c.version);
    /* what the versions it replaces installed and this one does not list
     * goes, its running units stopped first */
    var gone = prev && before !== c.version ? declaredOnly(toolDeclared(root, prev), c) : null;
    tx.stopped = gone ? stopUnits(gone, state) : [];
    /* systemd units, enablement and the boot lists change in one window,
     * and only when the desired bytes differ: the payload and the lists'
     * entries on disk first, so no power cut leaves a unit enabled without
     * them; the units going are out before their entries. */
    var recText = recmgrText(), rec = recmgrOp(recmgrNamesOf(c), []);
    var crash = crashListPlan(installedTools()), remounts = rootMountMode() === 'ro';
    var crashAdd = crash && crash.op && crash.add.length ? crash.op : null, crashRemove = crash && crash.op && !crashAdd ? crash.op : null;
    if (crashAdd && crash.remove.length) {
        crashAdd = Object.assign({}, crash.op, { data: crashListWith(fs.readFileSync(CFG.crashList, 'utf8'), crash.add, []) });
        crashRemove = crash.op;
    }
    var ops = [rec, crashAdd].filter(Boolean), unitChanged = !!rec, changed = [];
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
    i7.units.forEach(function (u) { ops.push({ type: 'delete', path: path.join(CFG.systemd, u) }); unitChanged = true; });
    var del = gone ? deleteOps(gone) : [];
    if (del.length) { ops = ops.concat(del); unitChanged = true; }
    var limits = limitsPlan(installedTools(), limitedUnits(c).concat(gone ? limitedUnits(gone) : []));
    if (limits.ops.length) { ops = ops.concat(limits.ops); unitChanged = true; }
    var recGone = gone && recmgrPresent() ? recmgrNamesGone(gone, installedTools()) : [];
    if (recGone.length) {
        var recWas = rec ? rec.data : recText, recOut = recmgrRemovals(recGone, recWas), recNext = recmgrWith(recWas, [], recOut);
        if (recNext !== recWas) {
            checkListEdit(CFG.recmgr, RECMGR_LIST, recWas, recNext, [], recOut);
            ops.push({ type: 'copy', data: recNext, path: CFG.recmgr, mode: 0o644 });
        }
    }
    if (crashRemove) ops.push(crashRemove);
    if (ops.length) { syncDisks(); rootfsWindow(ops); }
    if (ops.some(function (op) { return op.path === CFG.recmgr; })) recmgrOwnedDone(recText);
    crashListDone(crash, remounts);
    if (unitChanged) runOk(CFG.systemctl, ['daemon-reload']);
    if (del.length) pruneCreatedDirs(state);
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
        /* a service its start limit stopped would refuse the socket's next activation */
        if (startLimitHit(base + '.service')) systemctl(['reset-failed', base + '.service']);
        var r = systemctl(['start', en.unit]);
        if (r.status === 0) say('started ' + en.unit);
        else warn('could not start ' + en.unit);
    });
    var touched = samePayload && !unitChanged ? [] : applyRestarts(c, state, before === null);
    var bad = healthCheck(touched), e;
    if (bad) { e = fail(c.id + ' ' + c.version + ': ' + bad); e.health = touched; throw e; }
    if (c.id === 'mgu-deploy') ensureShim();
    if (c.id === 'app-privacy') {
        /* a trip in its bounce: the version in place recorded as installed */
        var pr = onGuardStop(function () { recordInstalledTool(a, state, versions, before, tx); saveState(state); },
            function () { return privacyApplyAndBounce(state); });
        if (!pr.ok) { e = fail('app-privacy ' + c.version + ': ' + pr.why); e.privacy = true; throw e; }
    }
    if (c.activate) {
        tx.activated = true;
        var hr = runHook(c.id, dest, c, 'activate', state);
        if (!hr.ok) { e = fail(c.id + ' ' + c.version + ': activate ' + hr.why); e.activate = touched; throw e; }
        if (hr.reboot) addPending(state, c.id, hr.reboot);
    }
    if (c.postInstall) postInstall(c, root);
    /* a new version that runs only from the next start is checked then */
    if (before !== c.version && pendingNow(state, c.id)) {
        if (verifyWanted(c)) noteVerify(state, c, before);
    } else if (before !== c.version && c.check) {
        var why = runCheck(c, root);
        if (why) {
            e = fail(c.id + ' ' + c.version + ': ' + why);
            e.check = true;
            e.health = runningServices(c);
            throw e;
        }
    }
    recordInstalledTool(a, state, versions, before, tx);
    say(c.id + ' ' + c.version + ' installed');
}
/* An installed tool's bookkeeping: older versions pruned, its copy kept, its record. */
function recordInstalledTool(a, state, versions, before, tx) {
    var c = a.component;
    fs.readdirSync(versions).forEach(function (v) {
        if (v !== c.version && v !== before && tx.keep.indexOf(v) < 0) { rmrf(path.join(versions, v)); noteHook(state, c.id, v, 'gone'); }
    });
    keepToolCopy(a);
    recordTool(state, c.id, c.version);
    noteHook(state, c.id, c.version, 'gone');
}

/* ---- tools after a firmware update ------------------------------------------ */
/* A firmware update puts the root file system back, keeping /var/opt: a
 * tool's payload stays under /var/opt/<id>, while its systemd units, their
 * enablement and drop-ins, and what its activate hook or postInstall set up
 * outside /var/opt are gone. The installed version's units, drop-ins and
 * component.json are kept beside its payload (kept/<id>/<version>/), so any
 * install lays a tool set up under another firmware, or missing any of
 * them, again from that copy, with no download. A tool installed before
 * that copy is kept is installed again by its source (status says why). */
function keptToolDir(id, version) { return path.join(keptDir(id), version); }
function keepToolCopy(a) {
    var c = a.component, dest = keptToolDir(c.id, c.version);
    if (path.resolve(a.dir) === path.resolve(dest)) return;
    try {
        var tmp = dest + '.partial-' + process.pid;
        rmrf(tmp);
        mkdirp(tmp, 0o700);
        copyFileMode(path.join(a.dir, 'component.json'), path.join(tmp, 'component.json'), 0o600);
        (c.units || []).forEach(function (u) {
            copyFileMode(path.join(a.dir, 'units', u.name), path.join(tmp, 'units', u.name), 0o600);
        });
        (c.dropins || []).forEach(function (d) {
            var rel = path.join('dropins', d.unit + '.d', d.name);
            copyFileMode(path.join(a.dir, rel), path.join(tmp, rel), 0o600);
        });
        rmrf(dest);
        fs.renameSync(tmp, dest);
        /* one for each version kept under /var/opt/<id>/versions */
        fs.readdirSync(keptDir(c.id)).forEach(function (n) {
            if (semverParts(n) && !fs.existsSync(path.join(CFG.varOpt, c.id, 'versions', n))) rmrf(path.join(keptDir(c.id), n));
        });
    } catch (e) { warn(c.id + ' ' + c.version + "'s units are not kept: " + e.message); }
}
/* Lays again from tool t's kept copy the units, enablement links and
 * drop-ins its version lists that are missing (ones a change to another
 * version took out), as an install lays them: its recmgr names first, then
 * those, then their limits, in one rootfs window. Nothing without a copy.
 * Returns the units laid. */
function layMissing(t, state) {
    var kept = keptToolArtifact(t), c = t.component, ops = [];
    if (!kept) return [];
    (c.units || []).forEach(function (u) {
        var dest = path.join(CFG.systemd, u.name);
        if (!lstatOrNull(dest)) ops.push({ type: 'copy', src: path.join(kept.dir, 'units', u.name), path: dest, mode: 0o644 });
    });
    (c.enable || []).forEach(function (en) {
        var link = path.join(CFG.systemd, en.target + '.wants', en.unit);
        if (lstatOrNull(link)) return;
        if (!fs.existsSync(path.dirname(link))) noteCreatedDir(state, path.dirname(link));
        ops.push({ type: 'mkdir', path: path.dirname(link) }, { type: 'symlink', path: link, target: '../' + en.unit });
    });
    (c.dropins || []).forEach(function (d) {
        var dest = dropinPath(d);
        if (lstatOrNull(dest)) return;
        if (!fs.existsSync(path.dirname(dest))) noteCreatedDir(state, path.dirname(dest));
        ops.push({ type: 'mkdir', path: path.dirname(dest) },
            { type: 'copy', src: path.join(kept.dir, 'dropins', d.unit + '.d', d.name), path: dest, mode: 0o644 });
    });
    if (!ops.length) return [];
    var recText = recmgrText(), rec = recmgrOp(recmgrNamesOf(c), []);
    rootfsWindow((rec ? [rec] : []).concat(ops, limitsPlan(installedTools(), limitedUnits(c)).ops));
    if (rec) recmgrOwnedDone(recText);
    runOk(CFG.systemctl, ['daemon-reload']);
    say(t.id + ' ' + t.version + ': laid again from the copy kept here: ' +
        ops.filter(function (op) { return op.type !== 'mkdir'; }).map(function (op) { return path.relative(CFG.systemd, op.path); }).join(', '));
    return ops.filter(function (op) { return op.type === 'copy' && path.dirname(op.path) === CFG.systemd; })
        .map(function (op) { return path.basename(op.path); });
}
/* Tool id's version and the firmware it was installed under, in state.json. */
function recordTool(state, id, version) {
    if (!state.tools || typeof state.tools !== 'object') state.tools = {};
    state.tools[id] = { version: version };
    if (unitInfo().firmware) state.tools[id].firmware = unitInfo().firmware;
}
/* Whether tool t was installed under another firmware than the one running
 * (state.json tools[id].firmware, recordTool, against the unit's build
 * string). */
function firmwareMoved(t, state) {
    var rec = state.tools && state.tools[t.id], fw = unitInfo().firmware;
    return !!(rec && rec.firmware && fw && rec.firmware !== fw);
}
/* Why installed tool t needs laying again, or null. */
function toolStale(t, state) {
    var c = t.component, rec = state.tools && state.tools[t.id];
    var missing = (c.units || []).filter(function (u) { return !lstatOrNull(path.join(CFG.systemd, u.name)); })
        .map(function (u) { return u.name; });
    (c.enable || []).forEach(function (en) {
        var cur = null;
        try { cur = fs.readlinkSync(path.join(CFG.systemd, en.target + '.wants', en.unit)); } catch (e) { /* not enabled */ }
        if (cur !== '../' + en.unit) missing.push(en.target + '.wants/' + en.unit);
    });
    (c.dropins || []).forEach(function (d) { if (!lstatOrNull(dropinPath(d))) missing.push(d2s(d)); });
    if (missing.length) return missing.join(', ') + ' missing';
    return rec && rec.version === t.version && firmwareMoved(t, state) ? 'installed under firmware ' + rec.firmware : null;
}
/* Tool t laid again from its kept copy: the artifact installTool takes, or
 * null without a copy of its installed version. */
function keptToolArtifact(t) {
    var dir = keptToolDir(t.id, t.version), cj = path.join(dir, 'component.json');
    if (!fs.existsSync(cj) || !bytesEqualFile(fs.readFileSync(cj), path.join(t.root, 'versions', t.version, 'component.json'))) return null;
    return { kind: 'tool', file: dir, dir: dir, component: t.component, id: t.id, version: t.version,
        hmi: hmiList(t.component.mguHmi, cj), hmiFrom: t.component.mguHmi ? 'declared' : null, provides: t.component.mguProvides || null };
}
/* ---- tools after a firmware update: files only ------------------------------ */
/* A tool with an install step of its own (activate, postInstall) set up
 * under another firmware, or missing a piece, is not installed again from
 * the copy kept here on its own: that copy may be an old version, and its
 * step may patch the firmware's files. Only its files are laid again: its
 * units, enablement links and drop-ins, their recmgr names and limits, the
 * restart units laid started as at a first install (recmgrs rules). Its
 * record (state.json tools) then holds the firmware it runs under and
 * needsSetup, why its install step is owed, until an install of the tool
 * (its update, the same version again, or setup) runs the step. A tool
 * without such a step is laid again whole, as an install of it. */
function hasInstallStep(c) { return !!(c.activate || c.postInstall); }
function needsSetup(state, id) {
    var rec = state.tools && state.tools[id];
    return rec && typeof rec.needsSetup === 'string' ? rec.needsSetup : null;
}
/* Tool id set up under another firmware than the one running, its install
 * step not run since (relayFiles' afterFirmware). */
function toolMoved(state, id) {
    return firmwareMoved({ id: id }, state) || !!(state.tools && state.tools[id] && state.tools[id].afterFirmware);
}
function relayFiles(t, state, why) {
    var c = t.component;
    takeSnapshot('relay', toolTouched(c));
    var laid = layMissing(t, state), isLaid = function (u) { return laid.indexOf(u) >= 0; };
    applyRestarts(Object.assign({}, c, { restart: (c.restart || []).filter(isLaid) }), state, true);
    var moved = toolMoved(state, t.id);
    recordTool(state, t.id, t.version);
    state.tools[t.id].needsSetup = why;
    /* its setup then leaves the versions kept as after a firmware update (installTool) */
    if (moved) state.tools[t.id].afterFirmware = true;
    say(t.id + ' ' + t.version + ': ' + why + '; its files are laid again, its install step waits for its next install or Set up');
}
/* relay [<id>...] --yes: each stale tool named (none: all) laid again from
 * its kept copy: files only for one with an install step, whole for one
 * without (an install of it). */
function cmdRelay(args) {
    var state = loadState(), done = [], whole = [];
    installedTools().forEach(function (t) {
        if (t.id === 'mgu-deploy' || (args.positional.length && args.positional.indexOf(t.id) < 0)) return;
        var why = toolStale(t, state);
        if (!why) return;
        if (!keptToolArtifact(t)) { say(t.id + ' ' + t.version + ': ' + why + '; no copy of it is kept here'); return; }
        if (!hasInstallStep(t.component)) { whole.push(t.id); return; }
        relayFiles(t, state, why);
        done.push(t.id);
    });
    if (done.length) { syncDropIns(); saveState(state); }
    if (whole.length) return cmdInstall({ artifacts: [], positional: [], setup: whole });
    if (!done.length) say('nothing to lay again');
    return 0;
}
/* setup <id> --yes: the tool laid again from its kept copy with its
 * install step, as an install of it. */
function cmdSetup(args) {
    var id = args.positional[0], state = loadState();
    var t = installedTools().filter(function (x) { return x.id === id; })[0];
    if (!t || id === 'mgu-deploy') throw refuse((id || 'setup') + ': no installed tool to set up');
    if (!needsSetup(state, id) && !toolStale(t, state)) throw refuse(id + ' ' + t.version + ' needs no setup');
    if (!keptToolArtifact(t)) throw refuse(id + ' ' + t.version + ': no copy of it is kept here; install it from its source');
    return cmdInstall({ artifacts: [], positional: [], setup: [id] });
}
/* A tool's postInstall: its script (one of its files) with the arguments
 * after it, run by sh as root from current/ once the install is in place,
 * at every install, for at most postInstallMs. Its output is shown; the
 * install stands whatever it does, but for a stock file it leaves unusable
 * that fixStock cannot fix. */
function postInstall(c, root) {
    var cur = path.join(root, 'current');
    say(c.id + ': ' + c.postInstall.join(' '));
    var r = cp.spawnSync(CFG.sh, [path.join(cur, c.postInstall[0])].concat(c.postInstall.slice(1)), {
        cwd: cur, encoding: 'utf8', timeout: CFG.postInstallMs, killSignal: 'SIGKILL', maxBuffer: 1 << 20
    });
    ((r.stdout || '') + (r.stderr || '')).split('\n').forEach(function (l) { if (l.trim()) say('  ' + l); });
    if (r.error || r.status !== 0) {
        warn(c.id + ': ' + c.postInstall[0] + (r.error ? ': ' + r.error.message : ' exited ' + (r.status === null ? r.signal : r.status)));
    }
    try { fixStock(c.id + ' postInstall: '); }
    catch (e) { throw fail(c.id + ' ' + c.version + ': postInstall left a stock file its service cannot use, and fixing it failed: ' + e.message); }
}

/* ---- a tool's check, and the check at the next start ------------------------- */

/* "check": ["<script>", "<arg>", ...] names one of the tool's files: run
 * from current/ as root (node for a .js file, else sh) once the new
 * version runs, for at most checkMs. Exit 0 says it works. Returns null,
 * or why it does not. */
function runCheck(c, root) {
    var cur = path.join(root, 'current'), script = path.join(cur, c.check[0]);
    say(c.id + ': checking with ' + c.check.join(' '));
    var r = cp.spawnSync(/\.js$/.test(script) ? CFG.node : CFG.sh, [script].concat(c.check.slice(1)), {
        cwd: cur, encoding: 'utf8', timeout: CFG.checkMs, killSignal: 'SIGKILL', maxBuffer: 1 << 20
    });
    var lines = ((r.stdout || '') + (r.stderr || '')).split('\n').filter(function (l) { return l.trim(); });
    lines.forEach(function (l) { say('  ' + l); });
    if (!r.error && r.status === 0) { say(c.id + ' ' + c.version + ' works'); return null; }
    return 'its check ' + (r.error ? (r.error.code === 'ETIMEDOUT' ? 'gave no answer within ' +
        Math.round(CFG.checkMs / 1000) + 's' : 'could not run: ' + r.error.message) :
        'failed' + (lines.length ? ': ' + oneLine(lines[lines.length - 1]) : ' (exit ' + (r.status === null ? r.signal : r.status) + ')'));
}
/* The tool's restart[] services that run now: a check that failed ran
 * against them, so a rollback restarts them on the previous version. */
function runningServices(c) {
    return (c.restart || []).filter(function (u) {
        return !/\.socket$/.test(u) && unitState(u, 'is-active') === 'active';
    });
}
function pendingNow(state, id) {
    return state.pending_reboot.some(function (p) { return p.id === id; });
}
/* Its restart[] services that nothing but systemd starts (socket-activated
 * ones are left to their socket): they must run at the next start. */
function bootServices(c) {
    return (c.restart || []).filter(function (u) {
        return !/\.socket$/.test(u) && !(c.enable || []).some(function (en) {
            return /\.socket$/.test(en.unit) && recmgrBase(en.unit) === recmgrBase(u);
        });
    });
}
function verifyWanted(c) { return !!c.check || bootServices(c).length > 0; }
/* verify.json: { <id>: { version, previous, boot } }, the tools whose new
 * version runs from the next start. mgu-deploy-verify.service checks them
 * at that start and rolls back one that does not work. */
var VERIFY_FILE = path.join(DEPLOY_DIR, 'verify.json');
var VERIFY_LAST = path.join(DEPLOY_DIR, 'last-verify.json');
var VERIFY_UNIT = 'mgu-deploy-verify.service';
var VERIFY_NAME = 'mgu-deploy-verify';
function readVerify() {
    var v = readJsonOrNull(VERIFY_FILE);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function writeVerify(v) {
    if (!Object.keys(v).length) { rmrf(VERIFY_FILE); return; }
    writeAtomic(VERIFY_FILE, JSON.stringify(v, null, 2) + '\n', 0o600);
}
function noteVerify(state, c, before) {
    var v = readVerify();
    v[c.id] = { version: c.version, previous: before, boot: bootId() };
    ensureBootUnit(state, VERIFY_UNIT, VERIFY_NAME);
    writeVerify(v);
    say(c.id + ' ' + c.version + ' is checked at the next start' + (before ? ', and ' + before + ' comes back if it does not work' : ''));
}
function dropVerify(id) {
    var v = readVerify();
    if (v[id]) { delete v[id]; writeVerify(v); }
}
function uptimeS() {
    try { return parseFloat(fs.readFileSync(path.join(CFG.proc, 'uptime'), 'utf8')); } catch (e) { return Infinity; }
}
/* verify: at a start after the install, each tool noted in verify.json
 * whose noted version is current gets its boot services' health check
 * and its check, once the head unit has been up verifyAfterS. One that
 * fails goes back to the version before (its running services restarted,
 * keepRunning or not: they run the version that failed). Every entry
 * goes before anything runs, so nothing is checked or rolled back twice
 * and no start repeats it. The results: last-verify.json, status'
 * last_verify. */
function cmdVerify() {
    var v = readVerify(), boot = bootId(), due = Object.keys(v).filter(function (id) { return v[id].boot !== boot; });
    if (!due.length) { say('nothing to check at this start'); return 0; }
    var wait = CFG.verifyAfterS - uptimeS();
    if (wait > 0) { say('checking ' + due.join(', ') + ' once the head unit has been up ' + CFG.verifyAfterS + 's'); sleepMs(wait * 1000); }
    var left = {};
    Object.keys(v).forEach(function (id) { if (due.indexOf(id) < 0) left[id] = v[id]; });
    writeVerify(left);
    var results = [], at = 0, last = function () {
        writeAtomic(VERIFY_LAST, JSON.stringify({ at: new Date().toISOString(), results: results }, null, 2) + '\n', 0o644);
    };
    /* A rollback the MainApp guard stops leaves what it did, and the unit
     * still ends as succeeded: the tool it was for is reported as it is
     * now, and it (unless back at its version before) and the tools not
     * checked yet stay due for the next start. */
    guardExit = 0;
    guardSteps.push(function () {
        var again = readVerify(), r = results[results.length - 1], id = due[at];
        var now = installedTools().filter(function (x) { return x.id === id; })[0];
        if (r && r.id === id) {
            r.rolledBack = !!now && now.version === v[id].previous;
            r.error += '; the MainApp guard stopped the rollback';
        }
        due.slice(at + (r && r.id === id && r.rolledBack ? 1 : 0)).forEach(function (x) { again[x] = v[x]; });
        writeVerify(again);
        last();
    });
    due.forEach(function (id, i) {
        at = i;
        var e = v[id], t = installedTools().filter(function (x) { return x.id === id; })[0], why;
        if (!t || t.version !== e.version) {
            say(id + ' ' + e.version + ': not current any more; not checked');
            return;
        }
        why = healthCheck(bootServices(t.component)) || (t.component.check ? runCheck(t.component, t.root) : null);
        if (!why) { results.push({ id: id, version: e.version, ok: true }); return; }
        process.stderr.write(id + ' ' + e.version + ' does not work: ' + why + '\n');
        var r = { id: id, version: e.version, ok: false, error: why, previous: e.previous || null, rolledBack: false };
        results.push(r);
        if (!e.previous) { say(id + ' ' + e.version + ' stays: there is no version before it'); return; }
        try {
            cmdRollback({ positional: [id], to: e.previous, restartRunning: true });
            r.rolledBack = true;
        } catch (err) { process.stderr.write(id + ': the rollback to ' + e.previous + ' failed: ' + err.message + '\n'); }
    });
    guardSteps.pop();
    last();
    /* exit 0 either way: the boot unit never reads as failed */
    return 0;
}
/* Undoes one failed tool install. With no version and no earlier current
 * folder to return to, a tool that failed its health check or its
 * app-privacy apply stays current, reported as such. Otherwise current
 * returns to the previous version or the earlier install's folder, the
 * snapshot puts units and the recmgr list back, a version folder this
 * install created goes, a socket it started whose unit is gone again is
 * stopped, and units it restarted restart on what is current again. After a
 * failed activate the units it started or restarted are restarted on what
 * is current again, or stopped when their unit went with the failed version;
 * whenever this install ran a new version's activate, that version's
 * deactivate runs before anything goes back (a failed one keeps it
 * current), and the previous version's activate runs again. */
function rollbackTool(a, tx, backup, e, state) {
    var c = a.component;
    var was = tx.before ? c.id + ' ' + tx.before : tx.legacy ? c.id + '\'s earlier install' : null;
    if ((e.health || e.privacy || e.check) && !was) {
        say(c.id + ' ' + c.version + ' stays current: there is no previous version to return to');
        if (e.privacy) {
            say('the app-privacy patch is NOT in effect; app installs are refused until ' +
                privacyTool() + ' apply succeeds');
        }
        return;
    }
    /* the version going runs its deactivate first, as at its removal; a
     * failed one keeps it current */
    if (tx.activated && c.deactivate && tx.before !== c.version) {
        var dr = runHook(c.id, path.join(tx.root, 'versions', c.version), c, 'deactivate', state);
        if (!dr.ok) {
            say(c.id + ' ' + c.version + ' stays current: deactivate ' + dr.why);
            keepToolCopy(a);
            recordTool(state, c.id, c.version);
            return;
        }
        if (dr.reboot) addPending(state, was ? c.id : 'mgu-deploy', (was ? '' : c.id + ' removed: ') + dr.reboot);
    }
    say('rolling back ' + c.id + ' ' + c.version + (tx.before ? ' to ' + tx.before : tx.legacy ? ' to its earlier install' : '') + ' from ' + backup);
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
        /* a current that is a folder is the earlier install's, never this one's */
        if (currentTarget(tx.root) !== null) rmrf(path.join(tx.root, 'current'));
        rmrf(path.join(tx.root, 'current.new'));
        if (!tx.versionExisted) rmrf(path.join(tx.root, 'versions', c.version));
        if (tx.legacy) {
            try { fs.rmdirSync(path.join(tx.root, 'versions')); } catch (e2) { /* holds other versions */ }
        }
        if (tx.legacy && fs.existsSync(tx.legacy)) {
            fs.renameSync(tx.legacy, path.join(tx.root, 'current'));
            say(c.id + ': the earlier install\'s current folder is back');
        }
    }
    if (!fs.existsSync(path.join(tx.root, 'versions', c.version))) noteHook(state, c.id, c.version, 'gone');
    Object.keys(tx.socketsActive || {}).forEach(function (u) {
        if (!tx.socketsActive[u] && !fs.existsSync(path.join(CFG.systemd, u))) {
            systemctl(['stop', u]); say('stopped ' + u);
        }
    });
    runOk(CFG.systemctl, ['daemon-reload']);
    (tx.stopped || []).forEach(function (u) { runOk(CFG.systemctl, ['start', u]); say('started ' + u); });
    pruneCreatedDirs(state);
    if (e.health) restartAgain(e.health, was);
    if (e.privacy) {
        var pr = onGuardStop(function () { saveState(state); }, function () { return privacyApplyAndBounce(state); });
        say(pr.ok ? was + ' applied again' : was + ' apply failed too: ' + pr.why);
    }
    if (e.activate) {
        var again = e.activate.filter(function (u) { return fs.existsSync(path.join(CFG.systemd, u)); });
        e.activate.forEach(function (u) { if (again.indexOf(u) < 0) { systemctl(['stop', u]); say('stopped ' + u); } });
        restartAgain(again, was || c.id);
    }
    /* the version it replaces again; the same version again only when its
     * activate did not run. Firmware-moved (tx.moved), its files only: it
     * needs setup, as after relayFiles. */
    var back = tx.before && (tx.before !== c.version || !tx.activated) ? path.join(tx.root, 'versions', tx.before) : null;
    if (tx.moved && back && fs.existsSync(path.join(back, 'component.json')) && hasInstallStep(readJson(path.join(back, 'component.json')))) {
        recordTool(state, c.id, tx.before);
        state.tools[c.id].needsSetup = 'the install of ' + c.version + ' failed after a firmware update';
        state.tools[c.id].afterFirmware = true;
        say(c.id + ' ' + tx.before + ': its files are back, its install step waits for its next install or Set up');
    } else if (tx.activated || tx.deactivated) {
        reactivate(c.id, back, state);
    }
}
/* Runs the activate of the version in dir again, after a change that ran
 * another version's activate or the tool's deactivate did not go through. */
function reactivate(id, dir, state) {
    var prev = dir ? readJsonOrNull(path.join(dir, 'component.json')) : null;
    if (!prev) return;
    if (!prev.activate) { noteHook(state, id, prev.version, 'gone'); return; }
    var hr = runHook(id, dir, prev, 'activate', state);
    if (hr.ok && hr.reboot) addPending(state, id, hr.reboot);
    say(hr.ok ? id + ' ' + prev.version + ' activated again' : id + ' ' + prev.version + ' activate failed too: ' + hr.why);
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
/* Puts a version's files, written to partial, in place as dest, the folder
 * current points to or will. One sync puts every file and folder of partial
 * on disk first (no fsync per file), so a power cut never leaves current on
 * files the disk has not got yet; a folder already named dest goes aside.
 * The rename is on disk before it returns. */
function placeVersion(partial, dest, aside) {
    syncDisks();
    if (fs.existsSync(dest)) fs.renameSync(dest, aside);
    fs.renameSync(partial, dest);
    fsyncDir(path.dirname(dest));
    rmrf(aside);
}
/* Link p made to point to target by rename, so it points to the old or the
 * new target at every moment, its folder on disk before it returns. */
function replaceLink(p, target) {
    var newLink = p + '.new';
    rmrf(newLink);
    fs.symlinkSync(target, newLink);
    fs.renameSync(newLink, p);
    fsyncDir(path.dirname(p));
}
/* A tool's current switched to a version on disk: one an install placed
 * (placeVersion) or an earlier one kept. */
function switchCurrent(root, version) { replaceLink(path.join(root, 'current'), 'versions/' + version); }
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
            placeVersion(partial, dest, aside);
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
 * entry's installationSource is null. MainApp 8.1.1 records no
 * installationSource and updates no app at its start: the restarted
 * manager makes the update in place. */

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
function isPackageOf(id, name) {
    return name.indexOf(id) === 0 && /^[@-]\d+\.\d+\.\d+.*\.tgz$/.test(name.slice(id.length));
}
function preinstalledFor(id) {
    var d = preinstalledDir(), out = [];
    if (!fs.existsSync(d)) return out;
    fs.readdirSync(d).forEach(function (n) { if (isPackageOf(id, n)) out.push(path.join(d, n)); });
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
    if (!mgrDataReady()) return;
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
/* Provisioning still lists an app uninstalled in place until the next
 * start, so a MainApp-21 restarted meanwhile would look it up at the
 * backend: app-privacy's override list keeps it from asking. */
function listLocalOnly(id) {
    if (!mgrDataReady()) return;
    var file = localOnlyFile(), cur = readJsonOrNull(file), listed = Array.isArray(cur) ? cur.slice() : [];
    if (listed.indexOf(id) >= 0) return;
    writeAtomic(file, JSON.stringify(listed.concat([id])) + '\n', 0o644);
    chownMaybe(file, MGR_UID, MGR_UID);
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
    dropStaleBind();
    var changed = privacyRevertRun(tool, '');
    if (binds() && bindMounted(mainJs())) {
        runOk(CFG.umount, [mainJs()]);
        try { changed = privacyRevertRun(tool, ' (stock main.js under the fallback copy)') || changed; }
        finally { bindCopy(); }
    }
    return changed;
}
function privacyRevertRun(tool, what) {
    var r = run(CFG.node, [tool, 'revert', '--json'], { allowFail: true, timeout: 120000 });
    if (r.status !== 0) throw refuse('app-privacy revert' + what + ' exited ' + r.status + '; the stock bundles stay patched and app-privacy stays installed');
    var result = lastJsonLine(r.stdout);
    say('app-privacy' + what + ': ' + (result && result.state ? result.state : 'reverted') +
        (result && result.changed ? ' (reverted now)' : ''));
    return !!(result && (result.changed || result.nextStart));
}
function readCustomApps() {
    var c = readJsonOrNull(customAppsFile());
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}
/* False, with nothing written, while the app manager's data folder is
 * missing: a later install lists the app (on iDrive 8 also status and the
 * boot unit's relist). */
function writeCustomApps(c) {
    if (!mgrDataReady()) {
        say(customAppsFile() + ' is written once the app manager has created its data folder');
        return false;
    }
    writeAtomic(customAppsFile(), JSON.stringify(c, null, 2) + '\n', 0o660);
    chownMaybe(customAppsFile(), MGR_UID, MGR_UID);
    return true;
}
function customAppsPut(id, cache, startType) {
    var c = readCustomApps();
    c[id] = Object.assign({}, APP_FLAGS, cache || {}, startType ? { '-appStartType': startType } : {});
    return writeCustomApps(c);
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
/* Whether the app manager records where it installed an app from (its
 * registry entry's installationSource) and
 * updates an app whose record is null at its start: its AppManagement.js
 * names installationSource. MainApp 8.3.2 and MainApp-21 do; MainApp 8.1.1
 * does neither. An unreadable AppManagement.js counts as recording. */
var recordsSource = null;
function managerRecordsSource() {
    if (recordsSource === null) {
        try { recordsSource = isId8() || fs.readFileSync(appManagementJs(), 'utf8').indexOf('"installationSource"') >= 0; }
        catch (e) { recordsSource = true; }
    }
    return recordsSource;
}
/* The manager's install of the artifact as it stands: done when its
 * registry entry names a uid and an installationSource (where the manager
 * records one), that uid's source is the new version, and its keychain
 * exists (a fresh install writes it last; an update keeps what the app
 * had, so an app installed without one, as idrive7-apps' installer
 * installs them, is updated without one). */
function keychainFile(uid) { return path.join(appHome(uid), 'security', 'joynrKeyChain.json'); }
function installState(a) {
    var entry = readJsonOrNull(appEntryFile(a.id));
    if (!entry || !entry.userId) return { done: false, seen: 'no registry entry' };
    var pkg = readJsonOrNull(path.join(appHome(entry.userId), 'source', 'package.json'));
    var keychain = lstatOrNull(keychainFile(entry.userId));
    return { uid: entry.userId, source: entry.installationSource || 'not recorded',
        done: !!((entry.installationSource || !managerRecordsSource()) && pkg && pkg.name === a.id && pkg.version === a.version &&
            ((keychain && keychain.size > 0) || (a.noKeychain && entry.userId === a.noKeychain))),
        seen: 'uid ' + entry.userId + ', installationSource ' + entry.installationSource +
            ', source ' + (pkg ? pkg.version : 'absent') + ', keychain ' + (keychain ? 'present' : 'absent') };
}
function watchInstall(a) {
    var t0 = Date.now(), s;
    for (;;) {
        s = installState(a);
        if (s.done) {
            say(a.id + ' ' + a.version + ' installed by the app manager as uid ' + s.uid + ' (source ' + s.source + ')');
            return s.uid;
        }
        if (Date.now() - t0 >= CFG.watchTimeoutMs) break;
        sleepMs(CFG.watchPollMs);
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
/* The running manager's pid and start in epoch seconds (null when
 * unreadable), or null when none runs. */
function managerStart() {
    var pid = managerPid();
    return pid ? { pid: pid, started: processStart(pid) } : null;
}
/* The in-place hook's code in a fallback copy's text, or null without one. */
function inplaceHookOf(text) {
    var a = text.indexOf(INPLACE_MARK), b = a < 0 ? -1 : text.indexOf(INPLACE_MARK, a + 1);
    return b < 0 ? null : text.slice(a, b);
}
/* A running manager that started before its bundles were last written: it
 * runs older code than the files hold. */
function managerStale() {
    var m = managerStart();
    return !!m && m.started !== null && bundlesWritten() > m.started;
}
/* A manager's start-up runs a provisioning pass once provisioning reaches
 * it, which updates an app marked PREINSTALLED from a newer package while
 * the app's tile may still be going in. MainApp runs it within seconds of
 * its start; nothing on the unit says when it is done, so a manager
 * younger than the bounce minimum (a bounce of this run, app-privacy's
 * among them, or a boot just now) is given until then. */
function waitStartedUp(what) {
    var m = managerStart(), told = 0;
    for (;;) {
        if (!m) return;
        var left = m.started === null ? CFG.bounceMinUpS : m.started + CFG.bounceMinUpS - nowS();
        if (left <= 0) return;
        if (Date.now() - told >= CFG.inplaceReportMs) {
            say('waiting ' + Math.ceil(left) + 's more for the app manager (pid ' + m.pid + '), up ' +
                Math.max(0, Math.floor(CFG.bounceMinUpS - left)) + 's, to finish starting before ' + what +
                ': its start-up provisioning pass would update the app while its tile goes in');
            told = Date.now();
        }
        sleepMs(Math.min(1000, Math.ceil(left * 1000)));
        var now = managerStart();
        if (now && m && now.pid !== m.pid) told = 0;
        m = now;
    }
}
/* The running manager, when it runs the hook: it announced itself with its
 * pid and start, and started after the bundles were last written, so it
 * runs the copy bound now. A manager younger than the bounce minimum gets
 * until then to announce itself, as long as a bounce would wait. */
function inplaceManager() {
    var told = false;
    for (;;) {
        var m = managerStart(), st = readJsonOrNull(inplaceStatusFile());
        if (!m) return { why: 'no app manager is running' };
        var pid = m.pid, started = m.started;
        if (started === null) return { why: 'its start time is unreadable' };
        if (bundlesWritten() > started) return { why: 'its main.js or AppManagement.js was written after it started' };
        if (st && st.pid === pid && typeof st.start === 'number' && Math.abs(st.start / 1000 - started) < 5) {
            /* MainApp-21's hook stays off for the boot after a restart it may have caused */
            return st.state === 'off' ? { why: 'its in-place hook is off until the next start: ' + st.why } : { pid: pid };
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
/* An error's first line: the manager's errors carry their stack. */
function oneLine(e) { return String(e).split('\n')[0]; }
function inplaceTrace(st, app) {
    var tr = st.trace, t0 = st.taken, now = Date.now(), out = [];
    if (!tr || !Array.isArray(tr.ops) || typeof t0 !== 'number') return 'no trace from the app manager';
    var s = function (t) { var d = Math.round((t - t0) / 1000); return (d < 0 ? '' : '+') + d + 's'; };
    var mine = function (k) {
        return tr.ops.filter(function (o) {
            return o.k === k && o.app === app && ['install', 'update', 'uninstall', 'installPackage'].indexOf(o.m) >= 0 && o.t >= t0 - 1000;
        }).pop();
    };
    var q = mine('q'), run = mine('run');
    /* MainApp-21 hands an install or update to its installer as installPackage, unqueued */
    if (!q && run && run.m === 'installPackage') q = run;
    if (!q) out.push('not yet handed to the installer');
    else if (!run) out.push('in the installer\'s queue since ' + s(q.t));
    else out.push((run.m === 'uninstall' ? 'uninstalling' : 'installing') + ' since ' + s(run.t) + (run.end ? ', ended ' + s(run.end) + (run.err ? ' (' + oneLine(run.err) + ')' : '') : ''));
    tr.ops.filter(function (o) { return o.app !== app && o.k === 'run' && (!o.end || o.end >= t0); }).forEach(function (o) {
        out.push(o.m + ' ' + o.app + ' ' + (o.end ? 'ran until ' + s(o.end) : 'running for ' +
            Math.round((now - o.t) / 1000) + 's') + (o.err ? ' (' + oneLine(o.err) + ')' : ''));
    });
    if (tr.fork && (!tr.fork.end || tr.fork.end >= t0)) {
        var from = (tr.fork.early ? 'before ' : '') + s(tr.fork.t);
        out.push('AppManagement child ' + (!tr.fork.end ? 'starting since ' + from :
            (tr.fork.err ? 'failed to start (' + from + ' to ' + s(tr.fork.end) + ': ' + oneLine(tr.fork.err) + ')' :
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
/* The app manager's installer rejected this app's install or update (the
 * hook's trace has the run failing), as opposed to its AppManagement child
 * or the channel to it failing, which a bounce restarts: the stub's own
 * wrapper with no reason from AppManager in it, or a child that did not
 * start. MainApp passes a rejection's reason code (UPDATE_FAILED, an
 * install's reason or code) as the error, else AppManager's message. */
function channelFailed(st) {
    var err = String(st.error || '');
    return /^AppManagerStub::_callMethod /.test(err) && !/AppManager::\w+ Failed due to/.test(err) ||
        !!(st.trace && st.trace.fork && st.trace.fork.err);
}
function ranAndFailed(st, app) {
    if (channelFailed(st)) return false;
    var ops = st.trace && Array.isArray(st.trace.ops) ? st.trace.ops : [];
    return ops.some(function (o) {
        return o.k === 'run' && o.app === app && !!o.err && typeof st.taken === 'number' && o.t >= st.taken - 1000;
    });
}
/* The manager's failure in one line: what the copy of CertificateManager.js
 * said, else its first line without the wrappers of the stub and
 * AppManager around the cause. */
function managerReason(err) {
    var text = String(err || 'no reason given'), line = text.split('\n')[0];
    var told = /keychain of \S+ [^\n]*/.exec(text), m = /uidrun exited with return code (\d+)/.exec(line);
    if (told) return "MainApp's CertificateManager: " + told[0];
    if (/CertificateManager\.js/.test(text)) {
        var killed = /#timeout after (\d+) sec/.exec(text);
        return "MainApp's CertificateManager did not create the app's keychain (" +
            (m ? 'uidrun exited ' + m[1] : killed ? 'killed after ' + killed[1] + ' s' : 'failed') + ')';
    }
    line = line.replace(/^AppManagerStub::_callMethod appManager\.\w+\([^)]*\) failed due to (Error: )?/, '')
        .replace(/^AppManager::\w+ Failed due to \{? ?(Error: )?/, '');
    return line.length > 200 ? line.slice(0, 200) + '...' : line;
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
    var doneAt = null, t0 = Date.now(), reported = t0, s, cur;
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
            return { why: 'the app manager ' + st.state + ' the in-place ' + action + (st.error ? ' (' + oneLine(st.error) + ')' : ''),
                state: st.state, error: st.error,
                ranFailed: st.state === 'failed' && !/^APP_ALREADY_/.test(String(st.error)) && !s.done && ranAndFailed(st, a.id) };
        }
        if (st.state === 'done' && s.done && (!existing || s.uid === existing.uid)) {
            say(a.id + ' ' + a.version + ' ' + (existing ? 'updated' : 'installed') + ' in place by the app manager (pid ' +
                m.pid + ') as uid ' + s.uid + ' (source ' + s.source + ')');
            return { uid: s.uid };
        }
        if (doneAt !== null && Date.now() - doneAt >= 2 * CFG.watchPollMs) {
            throw fail('the app manager ' + (existing ? 'updated ' : 'installed ') + a.id + ' in place, but not as ' +
                a.version + ' (' + s.seen + ')');
        }
        if (Date.now() - t0 >= CFG.watchTimeoutMs) {
            throw fail('app manager did not ' + action + ' ' + a.id + ' ' + a.version + ' in place within ' +
                Math.round(CFG.watchTimeoutMs / 1000) + 's (' + s.seen + '); not bounced, it may still be installing');
        }
        if (st.state === 'done' && doneAt === null) doneAt = Date.now();
        sleepMs(poll);
        st = inplaceAnswer(id) || st;
    }
}
/* The update of an app by the restarted manager in place, for a manager
 * that updates no app at its start (MainApp 8.1.1 and 6.5.5). */
function updateAfterBounce(a, existing) {
    waitStartedUp('updating ' + a.id + ' ' + a.version);
    var r = installInPlace(a, existing);
    if (r.uid) return r.uid;
    throw fail('the app manager could not update ' + a.id + ' ' + a.version + ' after its restart: ' +
        (r.ranFailed ? managerReason(r.error) : r.why));
}
/* The install of a fresh app by the restarted manager, for MainApp 6.5.5:
 * in place when it has not installed the app by itself once started up,
 * else watched. */
function installAfterBounce(a) {
    var s = installState(a);
    if (!s.done && fs.existsSync(FALLBACK_COPY) && inplaceHookOf(fs.readFileSync(FALLBACK_COPY, 'utf8')) !== null) {
        waitStartedUp('installing ' + a.id + ' ' + a.version);
        if (!installState(a).done) {
            var r = installInPlace(a, null);
            if (r.uid) return r.uid;
            if (r.ranFailed) throw fail('the app manager could not install ' + a.id + ' ' + a.version + ': ' + managerReason(r.error));
        }
    }
    return watchInstall(a);
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

/* ---- MainApp's CertificateManager.js --------------------------------------- */
/* MainApp's install of an app runs CertificateManager.js as the app's uid:
 * it has the head unit's certificate service create the app's keychain,
 * gives up after 30 s, and exits 1 with nothing on stderr, which MainApp
 * reports as the install's failure. A copy of it, bound over it, waits
 * CERT_WAIT_S and, when it gives up or cannot write the keychain, writes
 * on stderr the states the service reported and when, the security
 * folder's files before the request (name:uid:size) and its uid (the
 * record is an expression, as the stock call it precedes is); MainApp
 * puts the script's stderr in the install's error. MainApp kills the
 * script after 35 s; app-privacy 1.5.0 gives our apps 125 s. Each
 * edit's anchor must occur once in the stock script and the copy must
 * parse, or no copy is bound and the stock script runs. */
var CERT_WAIT_S = 115;
var CERT_PROBE = '__mgu={t0:Date.now(),states:[],before:(()=>{try{const fs=require("fs"),p=require("path");' +
    'return fs.readdirSync(keyChainPath).map(n=>{const s=fs.lstatSync(p.join(keyChainPath,n));' +
    'return n+":"+s.uid+":"+s.size}).join(" ")||"empty"}catch(e){return String(e&&e.code||e)}})(),' +
    'tell:w=>{try{process.stderr.write("keychain of "+appName+" "+w+"; certificate service states: "+' +
    '(__mgu.states.join(", ")||"none")+"; "+keyChainPath+" before the request: "+__mgu.before+"; uid "+process.getuid()+"\\n")}catch(e){}}},';
var CERT_EDITS = [
    ['TIMEOUT=3e4', 'TIMEOUT=' + CERT_WAIT_S + 'e3'],
    ['function requestKeyChain(process){', 'var __mgu;function requestKeyChain(process){'],
    ['certmgr.setupKeychain(appName,keyChainPath);', CERT_PROBE + 'certmgr.setupKeychain(appName,keyChainPath);'],
    ['handle=certmgr.useKeychain(keyChainPath,(state,_chain)=>{',
        'handle=certmgr.useKeychain(keyChainPath,(state,_chain)=>{__mgu.states.length<30&&' +
        '__mgu.states.push(Math.round((Date.now()-__mgu.t0)/1e3)+"s "+state);'],
    ['logger.error(`${logPrefix} Error while requesting keyChain due to ${e}.`),',
        '__mgu.tell("not written ("+e+")"),logger.error(`${logPrefix} Error while requesting keyChain due to ${e}.`),'],
    ['logger.error(`${logPrefix} Terminating due to ${TIMEOUT}ms timeout.`),',
        '__mgu.tell("not ready after "+TIMEOUT/1e3+"s"),logger.error(`${logPrefix} Terminating due to ${TIMEOUT}ms timeout.`),']
];
function certCopySource(text) {
    for (var i = 0; i < CERT_EDITS.length; i++) {
        if (text.split(CERT_EDITS[i][0]).length !== 2) return null;
        text = text.replace(CERT_EDITS[i][0], function () { return CERT_EDITS[i][1]; });
    }
    return text;
}
/* Built from the stock script (a bound copy is unmounted for the read)
 * and bound over it; written only when its bytes change. It never fails
 * an install: on any error the stock script stays in place. */
function ensureCertCopy() {
    try { bindCertCopy(); } catch (e) {
        try { rmrf(path.join(DEPLOY_DIR, 'CertificateManager.tmp-' + process.pid + '.js')); } catch (e2) { /* left for cleanStale */ }
        warn('the copy of ' + certManagerJs() + ' is not in place (' + e.message + '): MainApp keeps its 30 s keychain wait');
    }
}
function bindCertCopy() {
    var stock = certManagerJs(), wasBound = binds() && bindMounted(stock), built;
    if (!wasBound && !fs.existsSync(stock)) return;
    if (wasBound) runOk(CFG.umount, [stock]);
    try { built = certCopySource(fs.readFileSync(stock, 'utf8')); } catch (e) { built = null; }
    if (built === null) {
        warn(stock + ' is not the script this tool knows: MainApp keeps its 30 s keychain wait, without the diagnosis');
        return;
    }
    if (!bytesEqualFile(Buffer.from(built), CERT_COPY)) {
        var tmp = path.join(DEPLOY_DIR, 'CertificateManager.tmp-' + process.pid + '.js');
        writeAtomic(tmp, built, 0o755);
        if (run(CFG.node, ['--check', tmp], { allowFail: true, timeout: 60000 }).status !== 0) {
            rmrf(tmp);
            rmrf(CERT_COPY);
            warn('the copy of ' + stock + ' does not parse: MainApp keeps its 30 s keychain wait, without the diagnosis');
            return;
        }
        fs.renameSync(tmp, CERT_COPY);
    }
    if (!FAKE) runOk(CFG.mount, ['--bind', CERT_COPY, stock]);
    if (!wasBound) say('keychain wait of MainApp\'s installs: ' + CERT_WAIT_S + ' s, its failures explained (' + CERT_COPY + ')');
}
function unbindCertCopy() {
    if (binds() && bindMounted(certManagerJs())) runOk(CFG.umount, [certManagerJs()]);
    rmrf(CERT_COPY);
}

/* ---- interrupted installs ---------------------------------------------------- */
/* An app install this tool started and that did not finish (the head unit
 * restarted, the run was stopped) leaves the app listed in custom_apps.json
 * with its package in preinstalled_apps, and the manager tries to install
 * it again at every start. Each app install is recorded in state.json
 * until it finishes or is rolled back: inflight names the app and the run,
 * placed[<id>] the version and checksum of the package placed, kept while
 * an interrupted install's leftover is listed. Before the next install, an
 * app that is listed without a registry entry (one that cannot be read
 * counts as there) is unlisted and its package removed only when this tool
 * put both there: the newest snapshot holding the app's registry entry is
 * this tool's install of it, which found the app unlisted, without a
 * registry entry or package; the one package on disk is the one that
 * install placed, with the recorded checksum when there is one; a run
 * inflight names is gone. A snapshot of the listing and
 * the packages is taken first. Anything else stays, said in the output. */
/* The install snapshot that placed id's leftover, as { dir, names: the
 * package names it placed }, or null. */
function placedBy(id) {
    var dirs;
    try { dirs = fs.readdirSync(BACKUPS_DIR).filter(function (n) { return n !== 'stock'; }).sort().reverse(); } catch (e) { return null; }
    for (var i = 0; i < dirs.length; i++) {
        var dir = path.join(BACKUPS_DIR, dirs[i]), man = readJsonOrNull(path.join(dir, 'manifest.json'));
        if (!man || !Array.isArray(man.entries)) return null;
        var own = man.entries.filter(function (e) { return e && e.path === appEntryFile(id); })[0];
        if (!own) continue;
        if (man.command !== 'install' || own.kind !== 'absent') return null;
        var pkgs = man.entries.filter(function (e) {
            return path.dirname(e.path) === preinstalledDir() && isPackageOf(id, path.basename(e.path));
        });
        if (!pkgs.length || pkgs.some(function (e) { return e.kind !== 'absent'; })) return null;
        var list = man.entries.filter(function (e) { return e.path === customAppsFile(); })[0];
        if (!list) return null;
        if (list.kind !== 'absent') {
            var before = list.kind === 'file' && list.stored ? readJsonOrNull(path.join(dir, list.stored)) : null;
            if (!before || typeof before !== 'object' || id in before) return null;
        }
        return { dir: dirs[i], names: pkgs.map(function (e) { return path.basename(e.path); }) };
    }
    return null;
}
function entryPresent(id) {
    try { fs.lstatSync(appEntryFile(id)); return true; } catch (e) { return e.code !== 'ENOENT'; }
}
function endAppRecord(state, id) {
    delete state.inflight;
    if (state.placed) delete state.placed[id];
    if (state.placed && !Object.keys(state.placed).length) delete state.placed;
}
function cleanInterrupted(state) {
    var fl = state.inflight, gone = !!fl && (fl.boot !== bootId() || !pidAlive(fl.pid)), clean = [];
    var placed = state.placed || {}, listed = readCustomApps(), left = {};
    Object.keys(listed).forEach(function (id) {
        if (entryPresent(id)) return;
        left[id] = true;
        if (fl && fl.id === id && !gone) {
            warn(id + ' is being installed by a run of this tool that is still going; left as it is');
            return;
        }
        var rec = placed[id] || (fl && fl.id === id ? fl : null), by = placedBy(id), pkgs = preinstalledFor(id);
        var name = pkgs.length === 1 ? path.basename(pkgs[0]) : null;
        var ours = !!by && !!name && by.names.indexOf(name) >= 0 && (!rec ||
            (name === id + '@' + rec.version + '.tgz' && (!rec.sha256 || sha256File(pkgs[0]) === rec.sha256)));
        if (!ours) {
            warn(id + ' is listed for the app manager without being installed, and this tool cannot show it put it there; left as it is');
            return;
        }
        clean.push({ id: id, pkgs: pkgs, from: by.dir });
    });
    if (clean.length) {
        takeSnapshot('cleanup', clean.reduce(function (all, c) {
            return all.concat([appEntryFile(c.id)], c.pkgs);
        }, [customAppsFile()]));
    }
    clean.forEach(function (c) {
        customAppsRemove(c.id);
        delete left[c.id];
        rootfsWindow(c.pkgs.map(function (p) { return { type: 'delete', path: p }; }));
        say('removed what an interrupted install of ' + c.id + ' left (snapshot ' + c.from + '): its listing and ' +
            c.pkgs.map(function (p) { return path.basename(p); }).join(', ') + ', which the app manager tried to install at every start');
    });
    Object.keys(placed).forEach(function (id) { if (!left[id]) delete placed[id]; });
    if (Object.keys(placed).length) state.placed = placed; else delete state.placed;
    if (gone) delete state.inflight;
}

/* The app is listed enabled and allowed whatever its registry entry
 * cached: an app provisioning once dropped caches both false, and the
 * manager installs no app the listing disables. */
function listApp(a, entry) {
    customAppsPut(a.id, Object.assign({}, entry ? entry.provisioningCache : null, { '-enabled': 'true', '-allowed': 'true' }),
        a.pkg.mguAppStartType || 'manually');
}
/* Privacy, the fallback, the package, the app listed by the fallback; then
 * the running manager installs or updates it in place, or else one bounce:
 * the restarted manager installs it fresh, or updates it from its registry
 * entry re-seeded with installationSource null. An app the manager has
 * installed or updated by itself by then needs no bounce.
 *
 * An update the running manager cannot make in place, as it runs older
 * bundles than the files hold, bounces the manager once the app is listed
 * and before the new package is there: the restarted manager starts the
 * app as it is, and updates it in place. The package of an update waits while the manager is younger
 * than the bounce minimum (waitStartedUp), whatever restarted it. The manager's own update at its
 * start removes and inserts the app's tile again while its start-up insert
 * of that tile may still be under way, which can leave the HMI without the
 * tile until the head unit restarts. */
function installApp(a, state, decision) {
    var existing = decision.existing || null, entry;
    say('installing app ' + a.id + ' ' + a.version + (existing ? ' (update of ' + existing.version + ')' : ''));
    ensurePrivacy();
    ensureCertCopy();
    var kept = ensureFallback(state, true);
    if (existing && managerStale() && fs.existsSync(FALLBACK_COPY) &&
        inplaceHookOf(fs.readFileSync(FALLBACK_COPY, 'utf8')) !== null) {
        say('the app manager runs older code than its main.js or AppManagement.js: restarting it before the update, ' +
            'which it then makes in place');
        /* listed before the restart: the manager provisions apps at its
         * start, and refuses to update one it found unlisted (disabled) */
        listApp(a, readJsonOrNull(appEntryFile(a.id)));
        if (kept) rebuildFallback(false);
        bounceManager();
    }
    if (existing) waitStartedUp('placing ' + a.id + ' ' + a.version);
    entry = existing ? readJsonOrNull(appEntryFile(a.id)) : null;
    var kc = existing ? lstatOrNull(keychainFile(existing.uid)) : null;
    a.noKeychain = existing && !(kc && kc.size > 0) ? existing.uid : null;
    placePreinstalled(a);
    listApp(a, entry);
    var r = installInPlace(a, existing), uid = r.uid;
    /* MainApp's installer rejected the app's install or update: a restarted
     * manager runs the same install, and restarting it stops every app. */
    if (r.ranFailed) {
        throw fail('the app manager could not ' + (existing ? 'update ' : 'install ') + a.id + ' ' + a.version + ': ' +
            managerReason(r.error));
    }
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
    /* Without a manager nothing installs the app: no bounce, no 600 s watch */
    if (!uid && !managerSoon()) {
        say('no app manager is running on this head unit:');
        managerReport().forEach(function (l) { say('  ' + l); });
        throw fail('the app manager is not running, so ' + a.id + ' ' + a.version + ' cannot be installed now: ' +
            'restart the head unit, wait for the home screen, then run the install again');
    }
    if (!uid) {
        say('installing ' + a.id + ' through a bounce: ' + r.why);
        if (kept) rebuildFallback(false);
        entry = existing && managerRecordsSource() ? readJsonOrNull(appEntryFile(a.id)) : null;
        if (entry) {
            entry.installationSource = null;
            /* written in place, not renamed: the manager owns the file */
            fs.writeFileSync(appEntryFile(a.id), JSON.stringify(entry));
            say('registry entry re-seeded for the update (uid ' + entry.userId + ')');
        }
        bounceManager();
        if (restartDeferred) {
            throw fail('the app manager is busy installing or updating apps, so ' + a.id + ' ' + a.version +
                ' cannot be ' + (existing ? 'updated' : 'installed') + ' now: run the install again later');
        }
        uid = existing && !managerRecordsSource() ? updateAfterBounce(a, existing) :
            !existing && bytecodeStubs() ? installAfterBounce(a) : watchInstall(a);
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

/* ---- apps after a firmware update (iDrive 7) ------------------------------- */
/* At its first start after a firmware update (another MGU or MainApp
 * version than it last recorded) MainApp marks every installed app as
 * needing an update ("NO_FORCED_UPDATE_NEEDED": false in its registry
 * entry) and starts none so marked: its tile shows, and a tap does
 * nothing. It updates its own apps from their sources; nothing updates
 * ours. An install of such an app installs it afresh (uninstall, install,
 * its data folder carried over), which gives it a new registry entry and
 * sets it up for the firmware it runs on (SOME/IP interfaces, ACLs,
 * keychain, the oap-sdk of this firmware's donor apps). */
function appStale(app) {
    var entry = app.entry;
    return entry && entry.NO_FORCED_UPDATE_NEEDED === false ? 'the app manager starts it only once it is updated, after a firmware update' : null;
}
/* For a current app a: { why, artifact: the package to install } when the
 * app manager waits for its update, else null. */
function setUpElsewhere(a, existing, stage) {
    var why = appStale(existing);
    return why ? { why: why, artifact: a.prepare ? prepareApp(a, stage) : a } : null;
}
/* Moves the data folder set aside at stash into app id's home as installed
 * now, what was oldUid's (and oldGid's) becoming the new uid's (and the
 * new folder's group). A reinstall's own (fresh true) replaces the data
 * folder the new install has; one recorded earlier goes in only while the
 * app has no data folder or an empty one, else it stays where it is. The
 * home and its data folder are lstat'ed, never followed. True when moved. */
function carryData(id, stash, oldUid, oldGid, fresh) {
    var now = installedApp(id);
    if (!now || !fs.existsSync(stash)) return false;
    var home = appHome(now.uid), dest = path.join(home, 'data'), hs = lstatOrNull(home), cur = lstatOrNull(dest);
    if (!hs || !hs.isDirectory()) return false;
    if (!fresh && cur && !(cur.isDirectory() && !fs.readdirSync(dest).length)) return false;
    /* Under another uid, while the folder is still out of the new home
     * where no process of the new uid reaches it. Links are left alone:
     * chown follows them. */
    var st = cur || hs;
    if (now.uid !== oldUid) {
        walk(stash, '', []).concat([{ path: stash, stat: fs.lstatSync(stash) }]).forEach(function (e) {
            if (e.stat.isSymbolicLink()) return;
            var u = e.stat.uid === oldUid ? now.uid : e.stat.uid, g = e.stat.gid === oldGid ? st.gid : e.stat.gid;
            if (u !== e.stat.uid || g !== e.stat.gid) chownMaybe(e.path, u, g);
        });
    }
    if (fresh) rmrf(dest);
    else if (cur) fs.rmdirSync(dest);
    fs.renameSync(stash, dest);
    say(id + "'s data carried over");
    return true;
}
/* state.json data_stash, {<id>: [{path, uid, gid}, ...]}, oldest first:
 * the data folders this tool set aside for the app and did not put back.
 * The newest goes in when the app is registered again with no data of its
 * own; all of them go only with an explicit removal of the app
 * (forgetStash). A record of one folder ({path, uid, gid}) reads as a list
 * of it. */
function stashesOf(state, id) {
    var d = state.data_stash && state.data_stash[id];
    if (!d) return [];
    if (!Array.isArray(d)) state.data_stash[id] = d = [d];
    return d;
}
function keepStash(id, stash, uid, gid) {
    if (!fs.existsSync(stash)) return;
    var s = loadState(), list = stashesOf(s, id);
    if (!list.some(function (d) { return d.path === stash; })) list.push({ path: stash, uid: uid, gid: gid });
    s.data_stash = Object.assign({}, s.data_stash);
    s.data_stash[id] = list;
    saveState(s);
    say(id + "'s data is kept in " + stash + ' for its next install');
}
var reinstalling = {};
/* The newest folder set aside for app id into its home; not while a
 * reinstall of the app puts the folder it set aside in this run back. True
 * when state changed. */
function takeNewestStash(state, id) {
    var list = stashesOf(state, id), d = list[list.length - 1];
    if (!d || reinstalling[id] || !carryData(id, d.path, d.uid, d.gid, false)) return false;
    list.pop();
    if (!list.length) delete state.data_stash[id];
    return true;
}
function forgetStash(state, id) {
    stashesOf(state, id).forEach(function (d) {
        rmrf(d.path);
        say(id + ': the data folder set aside for it goes (' + d.path + ')');
    });
    if (state.data_stash) delete state.data_stash[id];
}
/* For each app registered again, its newest folder goes in (not while the
 * MainApp guard is off); one whose app has data of its own stays, said
 * once (held). Folders no longer there drop out. True when state changed. */
function settleStashes(state) {
    var changed = false;
    Object.keys(state.data_stash || {}).forEach(function (id) {
        var list = stashesOf(state, id), there = list.filter(function (d) { return d && fs.existsSync(d.path); });
        if (there.length !== list.length) changed = true;
        if (!there.length) { delete state.data_stash[id]; return; }
        state.data_stash[id] = there;
        if (!installedApp(id) || guardWhy()) return;
        if (takeNewestStash(state, id)) { changed = true; return; }
        var d = there[there.length - 1];
        if (!d.held) {
            d.held = true;
            changed = true;
            say(id + ' has data of its own: the data folder set aside for it stays in ' + d.path);
        }
    });
    return changed;
}
/* Uninstalls app (installedApp's), then installs file (at version); its
 * data folder goes to the new install's home. When that install fails,
 * again (a package, or null) is installed instead, the data going there.
 * Returns the failed install's error, or null. A trip on the way keeps the
 * app's record at version, with its kept package, so the next start
 * installs it again, and the data folder: carried over when the app is
 * installed, else recorded (data_stash) for that install. */
function reinstallApp(app, file, again, version) {
    var id = app.id;
    /* beside the homes: the same filesystem as the data folder */
    var data = path.join(appHome(app.uid), 'data'), stash = path.join(CFG.oap, '.mgu-deploy-data-' + id + '-' + process.pid), n = 1;
    /* a name of its own beside the folders kept from earlier runs */
    while (lstatOrNull(stash)) stash = path.join(CFG.oap, '.mgu-deploy-data-' + id + '-' + process.pid + '-' + n++);
    var oldGid = (lstatOrNull(data) || {}).gid;
    if (fs.existsSync(data)) fs.renameSync(data, stash);
    var putBack = function () {
        if (!carryData(id, stash, app.uid, oldGid, true)) keepStash(id, stash, app.uid, oldGid);
    };
    /* the install under way: what a trip records when the app is not registered */
    var target = { version: version, file: file };
    return onGuardStop(function () {
        if (!installedApp(id)) recordApp(id, target.version, fs.existsSync(keptFile(id, target.version)) ? null : target.file);
        putBack();
    }, function () {
        reinstalling[id] = true;
        try { return reinstallBody(); } finally { delete reinstalling[id]; }
    });
    function reinstallBody() {
        try {
            cmdUninstall({ positional: [id], keepPackages: true });
        } catch (e) {
            if (installedApp(id) && fs.existsSync(stash) && !fs.existsSync(data)) fs.renameSync(stash, data);
            else keepStash(id, stash, app.uid, oldGid);
            throw e;
        }
        var err = null;
        try {
            cmdInstall({ artifacts: [file], positional: [] });
        } catch (e) {
            err = e;
            process.stderr.write(id + ' did not install: ' + e.message + '\n');
            if (again && fs.existsSync(again)) {
                say('installing ' + id + ' ' + app.version + ' again');
                target = { version: app.version, file: again };
                try { cmdInstall({ artifacts: [again], positional: [] }); }
                catch (e2) { process.stderr.write(id + ' ' + app.version + ' did not install either: ' + e2.message + '\n'); }
            }
        }
        putBack();
        return err;
    }
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
    var st = q.st, t0 = Date.now(), reported = t0, poll = Math.min(CFG.watchPollMs, 1000), cur;
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
            return { why: 'the app manager ' + st.state + ' the in-place uninstall' + (st.error ? ' (' + oneLine(st.error) + ')' : '') };
        }
        if (st.state === 'done') {
            say(id + ' uninstalled in place by the app manager (pid ' + q.pid + ')');
            return { done: true };
        }
        if (Date.now() - t0 >= CFG.watchTimeoutMs) {
            return { why: 'the app manager did not uninstall ' + id + ' in place within ' + Math.round(CFG.watchTimeoutMs / 1000) + 's' };
        }
        sleepMs(poll);
        st = inplaceAnswer(q.id) || st;
    }
}
/* The fallback stops listing the app before anything else goes, so the
 * manager does not install it again meanwhile. The running manager then
 * uninstalls it in place; whatever it leaves goes after. Without that, one
 * bounce comes last, so the manager never sees the app listed without its
 * package (it would ask the backend for it) nor reinstalls it in between. */
function uninstallApp(id, state, keepPackages) {
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
    if (fallbackPresent()) rebuildFallback(!!r.done);
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
        /* a trip keeps the removal: its record and kept packages go, as at
         * its end, unless they are kept for the install that follows */
        onGuardStop(function () { if (!keepPackages) dropAppRecord(id); }, bounceManager);
    }
    if (fs.existsSync(appEntryFile(id))) throw fail('registry entry still present');
    if (ownDir && fs.existsSync(home)) throw fail('app home still present');
    if (state.apps) delete state.apps[id];
    leftovers.forEach(function (l) { say('leftover: ' + l); });
    say(id + ' uninstalled');
}
/* What tool component c and every other version kept beside it
 * (root/versions/<v>/component.json) install: their units, enablement
 * links, drop-ins and recmgr names together, as one component. */
function toolDeclared(root, c) {
    var all = { id: c.id, units: [], enable: [], dropins: [], recmgr: [] };
    var versions = [];
    try { versions = fs.readdirSync(path.join(root, 'versions')).filter(semverParts); } catch (e) { /* none kept */ }
    [c].concat(versions.map(function (v) { return readJsonOrNull(path.join(root, 'versions', v, 'component.json')); })).forEach(function (v) {
        if (!v || v.id !== c.id) return;
        var add = function (key, same) {
            (Array.isArray(v[key]) ? v[key] : []).forEach(function (x) {
                if (!all[key].some(function (y) { return same(x, y); })) all[key].push(x);
            });
        };
        add('units', function (x, y) { return x.name === y.name; });
        add('enable', function (x, y) { return x.unit === y.unit && x.target === y.target; });
        add('dropins', function (x, y) { return x.unit === y.unit && x.name === y.name; });
        add('recmgr', function (x, y) { return x === y; });
    });
    return all;
}
/* What tool component c installs that keep does not: its units,
 * enablement links and drop-ins keep does not list, and its recmgr names. */
function declaredOnly(c, keep) {
    var none = function (key, same) {
        return (c[key] || []).filter(function (x) { return !(keep[key] || []).some(function (y) { return same(x, y); }); });
    };
    return { id: c.id, recmgr: c.recmgr || [],
        units: none('units', function (x, y) { return x.name === y.name; }),
        enable: none('enable', function (x, y) { return x.unit === y.unit && x.target === y.target; }),
        dropins: none('dropins', function (x, y) { return x.unit === y.unit && x.name === y.name; }) };
}
/* The unit, enablement link and drop-in paths the installed tools other
 * than id list: never stopped or taken out for id. */
function listedElsewhere(id) {
    var out = {};
    installedTools().forEach(function (t) { if (t.id !== id) toolTouched(t.component).forEach(function (p) { out[p] = true; }); });
    return out;
}
/* Stops c's running units recmgr has loaded, before they are taken out;
 * any other keeps running until a reboot (pending). Returns those stopped. */
function stopUnits(c, state) {
    var stopped = [], others = listedElsewhere(c.id);
    (c.units || []).forEach(function (u) {
        if (others[path.join(CFG.systemd, u.name)] || unitState(u.name, 'is-active') !== 'active') return;
        if (recmgrLoaded(recmgrBase(u.name))) { runOk(CFG.systemctl, ['stop', u.name]); say('stopped ' + u.name); stopped.push(u.name); }
        else { addPending(state, c.id, PENDING_RECMGR); leftRunning.push(u.name); warn(u.name + ' left running until a reboot'); }
    });
    return stopped;
}
/* The rootfs ops that take out c's units, enablement links and drop-ins
 * on disk that no other installed tool lists. */
function deleteOps(c) {
    var others = listedElsewhere(c.id);
    return (c.units || []).map(function (u) { return path.join(CFG.systemd, u.name); })
        .concat((c.enable || []).map(function (en) { return path.join(CFG.systemd, en.target + '.wants', en.unit); }))
        .concat((c.dropins || []).map(dropinPath))
        .filter(function (p) { return !others[p] && lstatOrNull(p); }).map(function (p) { return { type: 'delete', path: p }; });
}
/* The recmgr names in c that no tool in rest has. */
function recmgrNamesGone(c, rest) {
    return recmgrNamesOf(c).filter(function (n) {
        return !rest.some(function (t) { return recmgrNamesOf(t.component).indexOf(n) >= 0; });
    });
}
/* Takes out c's units (stopUnits first), enablement links, drop-ins and
 * their limits, then the recmgr names in c that no tool in rest (the tools
 * that stay) has and this tool added (recmgrRemovals) and the crash
 * handler's names rest no longer wants, in one rootfs window: units before
 * list entries. */
function removeToolPieces(c, rest, state) {
    var ops = deleteOps(c).concat(limitsPlan(rest, limitedUnits(c)).ops);
    var recText = recmgrText(), rec = recmgrOp([], recmgrRemovals(recmgrNamesGone(c, rest), recText));
    if (rec) ops.push(rec);
    var unitOps = ops.length;
    var crash = crashListPlan(rest), remounts = rootMountMode() === 'ro';
    if (crash && crash.op) ops.push(crash.op);
    if (ops.length) rootfsWindow(ops);
    if (rec) recmgrOwnedDone(recText);
    crashListDone(crash, remounts);
    if (unitOps) runOk(CFG.systemctl, ['daemon-reload']);
    pruneCreatedDirs(state);
}
/* The version folder whose deactivate ran (or started) in this removal, for
 * cmdUninstall to activate again when the removal does not go through. */
var deactivated = null;
/* The units stopUnits left running until the next start. */
var leftRunning = [];
function uninstallTool(id, state) {
    var tools = installedTools().filter(function (t) { return t.id === id; });
    if (!tools.length) throw refuse(id + ': no installed tool with that id');
    var c = tools[0].component, root = tools[0].root;
    say('uninstalling tool ' + id + ' ' + c.version);
    /* the stock bundles go back first; a failed revert keeps the tool */
    if (id === 'app-privacy' && privacyRevert()) privacyReverted();
    /* the tool's deactivate runs with all of it still in place, then that of
     * each kept version whose deactivate is due (deactivateDue), which
     * reverts what only it set up; a failed one keeps the tool. A restart one asks for is
     * pending under the deploy tool, since the tool's own entries go with it. */
    [currentTarget(root)].concat(deactivateDue(state, id, root, c.version)).forEach(function (v, i) {
        var vc = i ? readJsonOrNull(path.join(root, 'versions', v, 'component.json')) : c;
        if (!vc || vc.id !== id || !vc.deactivate) return;
        var dir = path.join(root, 'versions', v);
        if (!i) deactivated = dir;
        var hr = runHook(id, dir, vc, 'deactivate', state);
        if (!hr.ok) throw refuse(id + ' ' + vc.version + ': deactivate ' + hr.why + '; ' + id + ' stays installed');
        if (hr.reboot) addPending(state, 'mgu-deploy', id + ' removed: ' + hr.reboot);
    });
    var declared = toolDeclared(root, c);
    stopUnits(declared, state);
    removeToolPieces(declared, installedTools().filter(function (t) { return t.id !== id; }), state);
    var own = fs.readdirSync(root).filter(function (n) { return ['versions', 'current', 'current.new'].indexOf(n) < 0; });
    if (own.length) say('removing ' + id + "'s own files beside its versions: " + own.sort().join(', '));
    rmrf(root);
    say(id + ' uninstalled');
}
/* An app on iDrive 8: its removal queued for the next start (or a queued
 * install dropped), in a snapshot of the boot unit's files. */
function uninstallQueuedId8(id, state) {
    var backup = takeSnapshot('uninstall', applyTouched().concat(id8LiveTouched(id, null), uplinkDropIns(id)));
    try {
        uninstallAppId8(id, state);
        saveState(state); selfInstall();
    } catch (e) {
        if (e.code !== 2) {
            process.stderr.write('uninstall failed, rolling back from ' + backup + '\n');
            try { rollbackAppId8(backup, state); } catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        }
        throw e;
    }
    return 0;
}
function touchedForUninstall(id) {
    var tool = installedTools().filter(function (t) { return t.id === id; })[0];
    if (tool) return toolTouched(toolDeclared(tool.root, tool.component)).concat(uplinkDropIns(id));
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
 *   install    the installed version uninstalled first, the package as
 *              preinstalled_apps/<id>@<version>.tgz, the app's two lines
 *              in every das file; the uninstalled version comes back at
 *              the start after, should MainApp-21 not have installed the
 *              new one (confirmId8);
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
function applyTouched() {
    return [path.join(CFG.systemd, APPLY_UNIT), path.join(CFG.systemd, APPLY_WANTS, APPLY_UNIT), CFG.recmgr];
}
function queuedRemoval(id) {
    return isId8() && readPending().some(function (c) { return c.id === id && c.action === 'remove'; });
}
function readPending() {
    var p = readJsonOrNull(ID8_PENDING);
    return p && Array.isArray(p.changes) ? p.changes : [];
}
/* pending.json's unconfirmed: the updates applied at the last start, each
 * with the version it moved out (kept in its trash folder) until MainApp-21
 * has installed the new one. */
function readUnconfirmed() {
    var p = readJsonOrNull(ID8_PENDING);
    return p && Array.isArray(p.unconfirmed) ? p.unconfirmed : [];
}
/* Without unconfirmed, the file's own stay. */
function writePending(changes, unconfirmed) {
    if (!unconfirmed) unconfirmed = readUnconfirmed();
    if (!changes.length && !unconfirmed.length) { rmrf(ID8_PENDING); return; }
    var p = { changes: changes };
    if (unconfirmed.length) p.unconfirmed = unconfirmed;
    mkdirp(ID8_DIR, 0o700);
    writeAtomic(ID8_PENDING, JSON.stringify(p, null, 2) + '\n', 0o600);
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
function ensureApplyUnit(state) { ensureBootUnit(state, APPLY_UNIT, APPLY_NAME); }
/* One of this tool's boot units (beside mgu-deploy.js), run through the
 * shim: written, enabled for late.target and listed in recmgr (where the
 * unit has the list). Each runs only while its condition file exists. */
function ensureBootUnit(state, unit, name) {
    var src = path.join(HERE, unit);
    if (!fs.existsSync(src)) throw refuse(unit + ' missing beside mgu-deploy.js');
    selfInstall(); // the unit runs the installed tool through its shim
    // its recmgr entry on disk before the unit and its link
    var rec = recmgrOp([name], []), ops = rec ? [rec] : [];
    var unitDest = path.join(CFG.systemd, unit), link = path.join(CFG.systemd, APPLY_WANTS, unit), cur = null;
    if (!bytesEqualFile(fs.readFileSync(src), unitDest)) {
        ops.push({ type: 'copy', src: src, path: unitDest, mode: 0o644 });
    }
    try { cur = fs.readlinkSync(link); } catch (e) { /* not enabled */ }
    if (cur !== '../' + unit) {
        if (!fs.existsSync(path.dirname(link))) noteCreatedDir(state, path.dirname(link));
        ops.push({ type: 'mkdir', path: path.dirname(link) });
        ops.push({ type: 'symlink', path: link, target: '../' + unit });
    }
    if (ops.length) {
        syncDisks();
        rootfsWindow(ops);
        runOk(CFG.systemctl, ['daemon-reload']);
        say(unit + ' installed');
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
 * without either), empty, the certification service its SOME/IP manifest
 * lacks (as on iDrive 7, its install has cadaemon create the keychain as
 * the app's uid), and an appletId. Returns what was added. */
function id8Complete(a) {
    var link = linker(), cert = link.completeCertification(a.pkgDir);
    var added = link.completePermissions(a.pkgDir).map(function (t) { return t + ' added to permissions.json'; });
    if (cert) added.push('the certification service added to ' + cert);
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
/* With app-privacy installed its patch must apply, so that MainApp-21
 * starts with it when it installs the app; without it the app installs
 * and MainApp-21 reports it. */
function ensurePrivacyId8(state) {
    if (!fs.existsSync(privacyTool())) {
        warn('app-privacy is not installed: MainApp-21 reports our apps to the backend until it is');
        return;
    }
    var pr = privacyApplyAndBounce(state);
    if (!pr.ok) throw refuse('app-privacy ' + pr.why + '; refusing the app install');
}
function installAppId8(a, state, decision, backup) {
    var existing = decision.existing || null, file = path.join(ID8_QUEUE, a.id + '@' + a.version + '.tgz');
    ensurePrivacyId8(state);
    if (installLiveId8(a, existing, state, backup)) return;
    say('queueing app ' + a.id + ' ' + a.version + (existing ? ' (update of ' + existing.version + ')' : '') + ' for the next start');
    ensureApplyUnit(state);
    mkdirp(ID8_QUEUE, 0o700);
    copyFileMode(a.file, file, 0o600);
    queueId8({ action: 'install', id: a.id, version: a.version, file: file, sha256: sha256File(file) });
    say(a.id + ' ' + a.version + ' ' + ID8_INSTALLS + ' of the head unit' +
        (existing ? '; ' + existing.version + ' is uninstalled first and comes back, with its data, if MainApp-21 does not install ' +
            a.version : ''));
}
function uninstallAppId8(id, state, queueOnly) {
    if (ID8_PROTECTED.indexOf(id) >= 0) throw refuse(id + ' is a system app');
    var queued = readPending().filter(function (c) { return c.id === id; })[0];
    var present = !!readJsonOrNull(appEntryFile(id)) || dasApps().indexOf(id) >= 0 || preinstalledFor(id).length > 0;
    if (!present && !queued) throw refuse(id + ': not installed');
    if (!present) { queueId8({ id: id }); say('the queued install of ' + id + ' is dropped'); return; }
    if (!queueOnly) {
        var r = uninstallLiveId8(id);
        if (r.done) return;
        say(id + ' is not uninstalled in place: ' + r.why);
    }
    ensureApplyUnit(state);
    customAppsRemove(id);
    queueId8({ action: 'remove', id: id });
    say(id + ' is ' + ID8_REMOVES + ' of the head unit');
}
/* ---- iDrive 8: our apps' listing under backend provisioning -------------------------- */
/* Telematics serves the das files until the car's first sync with BMW's
 * backend (Update apps and services); from then on it serves the
 * backend's provisioning (ProvSigned.xml), which has no section for our
 * apps, and MainApp-21 gives an app with no section no tile. The fallback
 * copy gives such an app the flags custom_apps.json lists for it, so every
 * app of ours the das files list (registered, or with its package in
 * place) keeps an entry there with its das line's flags: an install,
 * apply-pending, status (run as root, as the updater does) and the boot
 * unit put a missing one back. An app with a queued removal is left out.
 * The copy records the sections it filled for the running MainApp-21 in
 * mgu-deploy-listed.json beside custom_apps.json. */
function provSignedFile() { return path.join(CFG.varOpt, 'public', 'tm', 'tm_12000', 'data', 'prov', 'ProvSigned.xml'); }
function listedRecordFile() { return path.join(mgrHome(), 'data', 'mgu-deploy-listed.json'); }
function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/* The flags of the app's enable line in the first das file that has one,
 * or null. */
function dasFlags(id) {
    var re = new RegExp('<' + reEscape(id) + '((?:\\s+[\\w-]+="[^"]*")*)\\s*/>'), flags = null;
    DAS.some(function (d) {
        var x = '', m;
        try { x = fs.readFileSync(dasFile(d), 'utf8'); } catch (e) { return false; }
        if (!(m = re.exec(x))) return false;
        flags = {};
        m[1].replace(/([\w-]+)="([^"]*)"/g, function (all, k, v) { flags['-' + k] = v; });
        return true;
    });
    return flags;
}
function id8Unlisted() {
    var listed = readCustomApps(), removing = readPending().filter(function (c) { return c.action === 'remove'; })
        .map(function (c) { return c.id; });
    return dasApps().filter(function (id) {
        return !Object.prototype.hasOwnProperty.call(listed, id) && removing.indexOf(id) < 0 &&
            (!!lstatOrNull(appEntryFile(id)) || preinstalledFor(id).length > 0) && !!dasFlags(id);
    });
}
function relistId8() {
    var ids = mgrDataReady() ? id8Unlisted() : [];
    ids.forEach(function (id) { customAppsPut(id, dasFlags(id)); });
    return ids;
}
/* Whether the provisioning Telematics serves has the app's section: the
 * backend's once the car has it, else the das files'. Null when the
 * backend's cannot be read (not root). */
var provSignedText;
function provisioningNames(id) {
    if (provSignedText === undefined) {
        try { provSignedText = fs.readFileSync(provSignedFile(), 'utf8'); }
        catch (e) { provSignedText = e.code === 'ENOENT' ? null : false; }
    }
    if (provSignedText === false) return null;
    if (provSignedText === null) return !!dasFlags(id);
    return new RegExp('<' + reEscape(id) + '[\\s/>]').test(provSignedText);
}
/* The apps whose missing section the running MainApp-21's copy filled. */
function filledByManager() {
    var r = readJsonOrNull(listedRecordFile()), pid = managerPid();
    return r && pid && r.pid === pid && Array.isArray(r.apps) ? r.apps : [];
}
function fallbackUnitOld() {
    return fallbackPresent() && !bytesEqualFile(fs.readFileSync(fallbackUnitSource()), path.join(CFG.systemd, FALLBACK_UNIT));
}
/* status, run as root: relistId8, and the fallback's boot unit file
 * brought up to date (main.js stays bound as it is); both count from
 * MainApp-21's next start. */
function syncListingId8() {
    if (!isId8()) return null;
    var out = process.stdout.write, locked = false;
    process.stdout.write = function () { return true; };
    try {
        if (!id8Unlisted().length && !fallbackUnitOld()) return { state: 'ok', reason: 'every app of ours is listed' };
        var held = statusHeld();
        if (held) return { state: 'pending', reason: held };
        if (!runningInstalled() && !FAKE) return { state: 'pending', reason: 'this deploy tool is not the installed one' };
        if (!mgrDataReady()) return { state: 'pending', reason: 'the app manager has not created its data folder yet' };
        locked = statusLock();
        if (!locked) return { state: 'pending', reason: 'another mgu-deploy run holds the lock' };
        var ids = relistId8(), done = ids.length ? ['listed ' + ids.join(', ')] : [];
        if (ids.length) process.stderr.write('listed for the provisioning fallback, from the next start: ' + ids.join(', ') + '\n');
        if (fallbackUnitOld()) {
            var busy = rootBusy();
            if (busy) return { state: ids.length ? 'changed' : 'pending', reason: done.concat(['boot unit: ' + busy]).join('; ') };
            takeSnapshot('listing', [path.join(CFG.systemd, FALLBACK_UNIT)]);
            syncDisks();
            rootfsWindow([{ type: 'copy', src: fallbackUnitSource(), path: path.join(CFG.systemd, FALLBACK_UNIT), mode: 0o644 }]);
            runOk(CFG.systemctl, ['daemon-reload']);
            pruneBackups();
            done.push('boot unit brought up to date');
        }
        return { state: 'changed', reason: done.join('; ') };
    } catch (e) {
        process.stderr.write('mgu-deploy: our apps not listed again: ' + e.message + '\n');
        return { state: 'error', reason: e.message };
    } finally {
        if (locked) releaseLock();
        process.stdout.write = out;
    }
}
/* The fallback's boot unit runs it before MainApp-21; another run holding
 * the lock leaves it to status. */
function cmdRelist() {
    if (!isId8()) { say('nothing to list: not iDrive 8'); return 0; }
    if (!statusLock()) { say('another mgu-deploy run holds the lock; status lists them'); return 0; }
    try {
        repairMgrHome();
        if (!mgrDataReady()) { say('the app manager has not created its data folder yet; status lists them'); return 0; }
        var ids = relistId8();
        say(ids.length ? 'listed for the provisioning fallback: ' + ids.join(', ') : 'every app of ours is listed');
        return 0;
    } finally { releaseLock(); }
}
/* ---- iDrive 8: app changes in place ------------------------------------------------- */
/* While the fallback copy (fallback_build.js, MainApp-21's variant) is
 * bound over MainApp-21's main.js and the running MainApp-21 started on it,
 * its hook has MainApp-21 install, update or uninstall one app itself, from
 * the package in preinstalled_apps: only that app stops and starts, its tile
 * comes or goes at once, and nothing waits for the next start. MainApp-21 is
 * never bounced.
 *
 * What makes the app MainApp-21's at every later start goes in first, as
 * the queue puts it at boot: the package in preinstalled_apps and the app's
 * two lines in every das file. Its custom_apps.json entry, with the flags
 * of its das line, is its provisioning section until then: provisioning
 * reads the das files only at its start, and the fallback gives a listed
 * app with an empty section that entry. An install needs the hook running;
 * the first one turns the fallback on, and its boot unit binds the copy at
 * the next start. A change the running MainApp-21 does not take (no hook,
 * the request not taken or refused, MainApp-21 restarted) is queued for
 * the next start as without the hook, with what was placed for it put
 * back. One its installer took and failed fails, rolled back. */
var ID8_START_TYPE = 'autostart'; // dasEnableLine's

/* What an app change on iDrive 8 may touch: the das files, the app's
 * registry entry, packages and custom_apps.json entry, and the fallback. */
function id8LiveTouched(id, version) {
    var pkgs = preinstalledFor(id);
    if (version) pkgs.push(path.join(preinstalledDir(), id + '@' + version + '.tgz'));
    return DAS.map(dasFile).concat([appEntryFile(id)], pkgs, fallbackTouched());
}
/* With an update's saved folders (tx.saved), those MainApp-21 changed go
 * back too: MainApp-21, never restarted here, loads the app from them at
 * its next start, with its uid and data. */
function rollbackAppId8(backup, state, tx) {
    var fb = fallbackPresent();
    restoreSnapshot(backup);
    if (fallbackPresent() !== fb) { runOk(CFG.systemctl, ['daemon-reload']); settleFallback(); }
    pruneCreatedDirs(state);
    if (tx && tx.saved && restoreAppFolders(tx.saved)) {
        say('MainApp-21 unregistered ' + tx.saved.id + ' during the update: ' + tx.saved.id + ' ' + tx.saved.version +
            ' is back from the next start of the head unit');
    }
}
/* The package and the das lines in one rootfs window, the custom_apps.json
 * entry after them; what they replace is in the install's snapshot. */
function placeId8(a) {
    var dest = path.join(preinstalledDir(), a.id + '@' + a.version + '.tgz'), sha = sha256File(a.file);
    if (rootFreeKB() < fs.statSync(a.file).size / 1024 + 5120) throw fail('not enough space on the system partition');
    var ops = preinstalledFor(a.id).filter(function (p) { return p !== dest; }).map(function (p) { return { type: 'delete', path: p }; });
    ops.push({ type: 'copy', src: a.file, path: dest, mode: 0o644, uid: 0, gid: 0 });
    rootfsWindow(ops.concat(dasOps(dasEdits(a.id, true))));
    if (sha256File(dest) !== sha) throw fail('preinstalled package checksum mismatch at ' + dest);
    customAppsPut(a.id, null, ID8_START_TYPE);
}
/* True once the running MainApp-21 installed or updated the app in place;
 * false when it is to be queued instead, with what was placed for it put
 * back from the install's snapshot. Throws when MainApp-21's installer
 * failed it. */
function installLiveId8(a, existing, state, backup) {
    /* a MainApp-21 the copy does not fit takes the app at the next start */
    try { preflightFallback(); ensureFallback(state, true); } catch (e) {
        if (!isRefusal(e)) throw e;
        say(a.id + ' ' + a.version + ' is not installed in place: ' + e.message);
        return false;
    }
    var m = inplaceManager();
    if (!m.pid) { say(a.id + ' ' + a.version + ' is not installed in place: ' + m.why); return false; }
    if (existing) waitStartedUp('updating ' + a.id + ' ' + a.version);
    var kc = existing ? lstatOrNull(keychainFile(existing.uid)) : null;
    a.noKeychain = existing && !(kc && kc.size > 0) ? existing.uid : null;
    var placed = DAS.map(dasFile).concat([customAppsFile()], id8LiveTouched(a.id, a.version)
        .filter(function (p) { return path.dirname(p) === preinstalledDir(); }));
    placeId8(a);
    var r = installInPlace(a, existing), uid = r.uid;
    if (r.ranFailed) {
        throw fail('MainApp-21 could not ' + (existing ? 'update ' : 'install ') + a.id + ' ' + a.version + ': ' +
            managerReason(r.error));
    }
    if (!uid && (r.error === 'APP_ALREADY_INSTALLED' || r.error === 'APP_ALREADY_UPDATED' ||
            r.state === 'refused' && !existing)) {
        waitStartedUp('looking at ' + a.id + ' ' + a.version + ' again');
        uid = installedAlready(a, r.why);
    }
    if (!uid) {
        say(a.id + ' ' + a.version + ' is not installed in place: ' + r.why);
        restoreSnapshot(backup, placed);
        return false;
    }
    queueId8({ id: a.id });
    return true;
}
/* The running MainApp-21's own uninstall: it stops the app, unregisters it
 * (its tile goes) and removes its folders; then its packages, das lines,
 * custom_apps.json entry and what MainApp-21 left of it go. { done }, or
 * { why } when it is to be queued instead. */
function uninstallLiveId8(id) {
    var entry = readJsonOrNull(appEntryFile(id));
    if (!entry || !entry.userId) return { why: 'MainApp-21 has not installed it yet' };
    var home = appHome(entry.userId), pkg = readJsonOrNull(path.join(home, 'source', 'package.json'));
    if (!pkg || pkg.name !== id) return { why: 'its home is not provably ' + id + "'s" };
    say('uninstalling app ' + id + ' (uid ' + entry.userId + ')');
    var r = uninstallInPlace(id, typeof pkg.version === 'string' ? pkg.version : null);
    if (!r.done) return r;
    rootfsWindow(preinstalledFor(id).map(function (p) { return { type: 'delete', path: p }; })
        .concat(dasOps(dasEdits(id, false))));
    customAppsRemove(id);
    rmrf(appEntryFile(id));
    rmrf(appEntryFile(id) + '.tmp');
    rmrf(home);
    queueId8({ id: id });
    writePending(readPending(), readUnconfirmed().filter(function (u) { return u.id !== id; }));
    listLocalOnly(id);
    say(id + ' uninstalled');
    return { done: true };
}
function copyTree(src, dst) {
    var st = fs.lstatSync(src);
    mkdirp(path.dirname(dst));
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
    else if (st.isDirectory()) {
        fs.mkdirSync(dst, st.mode & 0o7777);
        fs.readdirSync(src).forEach(function (n) { copyTree(path.join(src, n), path.join(dst, n)); });
    } else fs.writeFileSync(dst, fs.readFileSync(src), { mode: st.mode & 0o7777 });
    if (st.isSymbolicLink()) {
        /* Node 8 has lchown on macOS only */
        if (!FAKE) run('chown', ['-h', st.uid + ':' + st.gid, dst], { allowFail: true });
        return;
    }
    if (!FAKE) fs.chownSync(dst, st.uid, st.gid);
    /* the mode as it was, whatever the umask took off (after chown, which clears setuid) */
    fs.chmodSync(dst, st.mode & 0o7777);
}
/* An app's home, personal copies and vsomeip policy folder. */
function id8AppFolders(uid) {
    var personal = path.join(CFG.varOpt, 'personal'), out = [appHome(uid)];
    (fs.existsSync(personal) ? fs.readdirSync(personal) : []).forEach(function (pr) {
        out.push(path.join(personal, pr, 'oap', 'oap_' + uid));
    });
    return out.concat([path.join(CFG.etc, 'vsomeip', uid + '_' + uid)]);
}
function moveTree(src, dst) {
    mkdirp(path.dirname(dst));
    try { fs.renameSync(src, dst); } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        copyTree(src, dst); rmrf(src);
    }
}
/* Moves p into bin under its own path (/var/opt/x -> <bin>/var/opt/x),
 * noting it in moved. A path on the read-only root is copied here and
 * deleted in the rootfs window (ops). */
function trashPath(p, bin, ops, log, moved) {
    if (!lstatOrNull(p)) return false;
    var dst = path.join(bin, p);
    if (isRootfsPath(p)) { copyTree(p, dst); ops.push({ type: 'delete', path: p }); }
    else moveTree(p, dst);
    if (moved) moved.push(p);
    log(p);
    return true;
}
/* Everything of an installed app but its package and das lines. */
function uninstallId8(id, bin, ops, log, moved) {
    var entry = readJsonOrNull(appEntryFile(id)), uid = entry && Number(entry.userId) > 0 ? entry.userId : null;
    trashPath(appEntryFile(id), bin, ops, log, moved);
    if (uid) {
        id8AppFolders(uid).forEach(function (p) { trashPath(p, bin, ops, log, moved); });
    }
    var uids = uidsFile();
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
function uidsFile() { return path.join(mgrHome(), 'security', 'uids.txt'); }
/* One queued change, at boot with MainApp not running. The das edits are
 * worked out before anything moves, so a das file without its anchors
 * fails the change with nothing changed. An update returns what it moved
 * out of the installed version (unconfirmed), to put back should
 * MainApp-21 not install the new one. */
function applyId8(c, bin, log) {
    var ops = [], install = c.action === 'install', dest = null, edits, moved = [], kept = null;
    if (ID8_PROTECTED.indexOf(c.id) >= 0) throw fail('a system app');
    if (!install && c.action !== 'remove') throw fail('unknown action ' + c.action);
    if (install) {
        if (!fs.existsSync(c.file) || sha256File(c.file) !== c.sha256) throw fail('the queued package is missing or changed');
        if (rootFreeKB() < fs.statSync(c.file).size / 1024 + 5120) throw fail('not enough space on the system partition');
        dest = path.join(preinstalledDir(), c.id + '@' + c.version + '.tgz');
    }
    edits = dasEdits(c.id, install);
    var entry = install ? readJsonOrNull(appEntryFile(c.id)) : null;
    if (entry && Number(entry.userId) > 0) kept = keepPreviousId8(c, entry.userId, bin);
    uninstallId8(c.id, bin, ops, log, moved);
    preinstalledFor(c.id).forEach(function (p) { trashPath(p, bin, ops, log, moved); });
    if (install) { ops.push({ type: 'copy', src: c.file, path: dest, mode: 0o644, uid: 0, gid: 0 }); log(dest); }
    rootfsWindow(ops.concat(dasOps(edits)));
    edits.forEach(function (e) { log(e.path + (install ? ' +' : ' -') + c.id); });
    if (install && sha256File(dest) !== c.sha256) throw fail('package checksum mismatch at ' + dest);
    if (kept) kept.moved = moved;
    return kept;
}
/* The installed version's uid, uids.txt line and version, and the ACLs of
 * its folders under /var/opt, recorded in bin before an update moves it
 * there. */
function keepPreviousId8(c, uid, bin) {
    var pkg = readJsonOrNull(path.join(appHome(uid), 'source', 'package.json')) || {}, line = uid + '=' + c.id;
    try {
        fs.readFileSync(uidsFile(), 'utf8').split('\n').forEach(function (l) { if (l.split('=')[1] === c.id) line = l; });
    } catch (e) { /* no uids.txt */ }
    var kept = { id: c.id, version: c.version, previous: typeof pkg.version === 'string' ? pkg.version : null,
        uid: uid, line: line, bin: bin };
    var present = id8AppFolders(uid).filter(function (p) { return !isRootfsPath(p) && lstatOrNull(p); });
    if (FAKE || !present.length) return kept;
    mkdirp(bin, 0o700);
    kept.acl = path.join(bin, c.id + '.acl');
    fs.writeFileSync(kept.acl, runOk(CFG.getfacl, ['-R', '-p'].concat(present)).stdout, { mode: 0o600 });
    return kept;
}
/* At the start after an update, before MainApp-21: with no registry entry
 * for the app, MainApp-21 did not install the new version, and the one it
 * replaced goes back as it was: its registry entry, folders (with their
 * ACLs), uids.txt line and package, the new package to the trash. Nothing
 * goes back over an entry, folder or other package that is there again.
 * What is under /var/opt goes back first; in the rootfs window the new
 * package goes after the old one is back. */
function confirmId8(u, bin) {
    if (lstatOrNull(appEntryFile(u.id))) { say(u.id + ' ' + u.version + ': installed by MainApp-21'); return null; }
    var res = { id: u.id, action: 'restore', version: u.previous, rejected: u.version, ok: false, log: [] };
    var log = function (l) { res.log.push(l); };
    try {
        var placed = path.join(preinstalledDir(), u.id + '@' + u.version + '.tgz'), ops = [];
        var other = preinstalledFor(u.id).filter(function (p) { return p !== placed; });
        if (other.length) throw fail('another package of it is in place: ' + other.join(', '));
        (u.moved || []).forEach(function (p) {
            if (!lstatOrNull(path.join(u.bin, p))) throw fail(path.join(u.bin, p) + ' is gone');
            if (!isRootfsPath(p) && lstatOrNull(p)) throw fail(p + ' is there again');
        });
        if (!(u.moved || []).length) throw fail('nothing of it was kept');
        u.moved.forEach(function (p) { if (!isRootfsPath(p)) { moveTree(path.join(u.bin, p), p); log(p); } });
        if (u.acl && lstatOrNull(u.acl)) runOk(CFG.setfacl, ['--restore=' + u.acl]);
        if (fs.existsSync(uidsFile())) {
            var lines = fs.readFileSync(uidsFile(), 'utf8').split('\n').filter(function (l) { return l.split('=')[1] !== u.id; });
            lines.splice(lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, u.line);
            fs.writeFileSync(uidsFile(), lines.join('\n'));
            log(uidsFile() + ' +' + u.line);
        }
        u.moved.forEach(function (p) {
            if (!isRootfsPath(p)) return;
            var from = path.join(u.bin, p);
            ops.push(fs.lstatSync(from).isDirectory() ? { type: 'tree', src: from, path: p } :
                { type: 'copy', src: from, path: p, mode: 0o644, uid: 0, gid: 0 });
            log(p);
        });
        trashPath(placed, bin, ops, log);
        rootfsWindow(ops);
        res.ok = true;
        say(u.id + ' ' + u.version + ' was not installed by MainApp-21 at the last start: ' + (u.previous || 'the version before') +
            ' is back, with its data');
    } catch (e) {
        res.error = e.message;
        process.stderr.write(u.id + ': putting back ' + (u.previous || 'the version before') + ' failed: ' + e.message + '\n');
    }
    return res;
}
function cmdApplyPending() {
    if (!isId8()) throw refuse('apply-pending applies queued iDrive 8 app changes; this head unit is ' + hmiName(unitInfo().hmi || 'unknown'));
    var changes = readPending(), unconfirmed = readUnconfirmed(), results = [], kept = [];
    if (!changes.length && !unconfirmed.length) {
        say('nothing queued');
        if (fs.existsSync(REMOVE_ALL_FILE)) removeSelfAtStart();
        return 0;
    }
    if (managerPid()) throw refuse('the app manager is running; queued changes apply before it starts (' + APPLY_UNIT + ')');
    var bin = path.join(ID8_TRASH, timestamp());
    /* each update is looked at once: its record goes before anything moves */
    if (unconfirmed.length) writePending(changes, []);
    unconfirmed.forEach(function (u) { var r = confirmId8(u, bin); if (r) results.push(r); });
    changes.forEach(function (c) {
        var res = { id: c.id, action: c.action, version: c.version || null, ok: false, log: [] };
        try {
            var k = applyId8(c, bin, function (l) { res.log.push(l); });
            if (k) kept.push(k);
            res.ok = true;
            say(c.id + (c.version ? ' ' + c.version : '') + ': ' + (c.action === 'install' ? 'installed for MainApp' : 'removed'));
        } catch (e) {
            res.error = e.message;
            process.stderr.write(c.id + ': ' + c.action + ' failed: ' + e.message + '\n');
        }
        results.push(res);
    });
    /* a remove-all's start lists nothing: no fallback is left to read it */
    if (!fs.existsSync(REMOVE_ALL_FILE)) {
        try {
            var listedNow = relistId8();
            if (listedNow.length) say('listed for the provisioning fallback: ' + listedNow.join(', '));
        } catch (e) { process.stderr.write('listing for the provisioning fallback failed: ' + e.message + '\n'); }
    }
    if (results.length) writeAtomic(ID8_LAST, JSON.stringify({ at: new Date().toISOString(), results: results }, null, 2) + '\n', 0o644);
    changes.forEach(function (c) { if (c.file) rmrf(c.file); });
    writePending([], kept);
    if (fs.existsSync(ID8_TRASH)) {
        var keep = kept.map(function (k) { return path.basename(k.bin); });
        var old = fs.readdirSync(ID8_TRASH).sort().filter(function (n) { return keep.indexOf(n) < 0; });
        old.slice(0, Math.max(0, old.length - 3)).forEach(function (n) { rmrf(path.join(ID8_TRASH, n)); });
    }
    var ok = results.every(function (r) { return r.ok; });
    /* a remove-all's last step, once its removals went through; after a
     * failed one the deploy tool stays for remove-all to run again */
    if (fs.existsSync(REMOVE_ALL_FILE)) {
        if (ok && !kept.length) removeSelfAtStart();
        else { rmrf(REMOVE_ALL_FILE); process.stderr.write('the deploy tool stays: run the uninstall again\n'); }
    }
    return ok ? 0 : 1;
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
    if (tx.legacy) rmrf(tx.legacy);
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
        if (amAppOnUnit(AM.app)) uninstallAppId8(AM.app, state, true);
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
/* The boot unit, installed as FALLBACK_UNIT: iDrive 8's builds the copy of
 * MainApp-21's main.js and binds it there. */
function fallbackUnitSource() { return path.join(HERE, isId8() ? 'mgu-app-fallback-id8.service' : FALLBACK_UNIT); }
function fallbackTouched() {
    return [path.join(CFG.systemd, FALLBACK_UNIT),
        path.join(CFG.systemd, 'multi-user.target.wants', FALLBACK_UNIT),
        CFG.recmgr, FALLBACK_COPY, customAppsFile()];
}
/* The fallback copy of the stock main.js (or of input) with the
 * app-privacy patch on it, in a temporary file; refused when either
 * refuses or the copy does not parse: MainApp would crash on it at every
 * start. */
function buildPatchedCopy(input) {
    var tmp = path.join(DEPLOY_DIR, 'main.fallback-' + process.pid + '.js');
    mkdirp(DEPLOY_DIR);
    try {
        buildFallbackCopy(tmp, input);
        if (fs.existsSync(privacyTool())) {
            var pr = privacyApplyQuiet(['--main', tmp]);
            if (!pr || pr.status !== 0) throw refuse('app-privacy refused the fallback copy; not binding it');
        }
        var syntax = run(CFG.node, ['--check', tmp], { allowFail: true, timeout: 60000 });
        if (syntax.status !== 0) {
            var why = (syntax.stderr || '').split('\n').filter(function (l) { return /^[A-Za-z]*Error: /.test(l); })[0];
            throw refuse('the fallback copy of ' + (input || mainJs()) + ' does not parse' +
                (why ? ' (' + why.trim() + ')' : '') + '; not binding it, MainApp keeps its own main.js');
        }
    } catch (e) { rmrf(tmp); throw e; }
    return tmp;
}
/* Before a change: the copy can be built (main.js not bound yet). */
function preflightFallback() {
    if (binds() && bindMounted(mainJs())) return;
    if (!fs.existsSync(fallbackUnitSource())) throw refuse(FALLBACK_UNIT + ' missing beside mgu-deploy.js');
    rmrf(buildPatchedCopy());
}
/* The copy is built from the stock main.js, so a bound copy is unmounted
 * for the build and bound again (the old copy when the build refuses).
 * The copy is written only when its bytes change: a manager that started
 * after it was written runs it (app-privacy's restartNeeded, and the
 * in-place install, go by that time).
 *
 * With keepRunning, a copy the running manager runs, with its in-place
 * hook announced (a young one given until the bounce minimum, while the
 * copy is still bound), stays when the new build has the same hook: the manager
 * keeps installing in place, with no bounce, and the boot unit builds the
 * new copy at the next start. True when it stayed. */
function rebuildFallback(keepRunning) {
    var wasBound = binds() && bindMounted(mainJs()), tmp, kept = false;
    /* asked while main.js is still bound: the wait for a young manager never leaves the stock file exposed */
    var running = keepRunning && (FAKE || wasBound) ? inplaceManager().pid || null : null;
    if (wasBound) runOk(CFG.umount, [mainJs()]);
    try {
        tmp = buildPatchedCopy();
    } catch (e) {
        if (wasBound) bindCopy();
        throw e;
    }
    var built = fs.readFileSync(tmp);
    if (!bytesEqualFile(built, FALLBACK_COPY)) {
        kept = !!running && managerPid() === running && sameHook(built.toString('utf8'));
        if (kept) say('the app manager keeps the provisioning fallback it runs; this version\'s takes effect at the next start');
        else copyFileMode(tmp, FALLBACK_COPY, 0o644);
    }
    rmrf(tmp);
    if (binds()) bindCopy();
    if (fs.existsSync(privacyTool()) && !guardWhy()) privacyApplyQuiet(null);
    return kept;
}
/* Whether the fallback copy's in-place hook is the one in built. */
function sameHook(built) {
    var cur;
    try { cur = fs.readFileSync(FALLBACK_COPY, 'utf8'); } catch (e) { return false; }
    var hook = inplaceHookOf(cur);
    return hook !== null && hook === inplaceHookOf(built);
}
/* Whether main.js is bound to the fallback copy as it is now: a bind
 * keeps the file it was made with, so a copy deleted or replaced since
 * leaves main.js on a file that is not the copy. */
function boundToCopy() {
    var copy = statOrNull(FALLBACK_COPY), st;
    if (!copy) return false;
    if (FAKE_BINDS) { st = fakeBind(mainJs()); return !!st && st.ino === copy.ino; }
    st = statOrNull(mainJs());
    return !!st && st.dev === copy.dev && st.ino === copy.ino;
}
/* Binds the fallback copy over main.js; with no copy there, main.js stays
 * the stock file. */
function bindCopy() {
    if (!fs.existsSync(FALLBACK_COPY)) {
        warn('no fallback copy at ' + FALLBACK_COPY + ': ' + mainJs() + ' stays the stock file');
        return;
    }
    var off = guardWhy();
    if (off) { say(mainJs() + ' is bound to the fallback copy at the next start of the head unit (' + off + ')'); return; }
    runOk(CFG.mount, ['--bind', FALLBACK_COPY, mainJs()]);
}
/* Unmounts every bind over main.js that is not the fallback copy as it is
 * now. True when one went. */
function dropStaleBind() {
    var dropped = false;
    while (binds() && bindMounted(mainJs()) && !boundToCopy()) {
        say(mainJs() + ' was bound to a file that is not the fallback copy at ' + FALLBACK_COPY + ': unmounted');
        runOk(CFG.umount, [mainJs()]);
        dropped = true;
    }
    return dropped;
}
function unbindFallback() {
    var wasBound = binds() && bindMounted(mainJs());
    if (wasBound) runOk(CFG.umount, [mainJs()]);
    rmrf(FALLBACK_COPY);
    /* The boot unit binds the copy before app-privacy's boot run, so the
     * stock main.js under it may hold an older patch or none. With the
     * guard off it stays as it is until the next start. */
    if (fs.existsSync(privacyTool()) && !guardWhy()) privacyApplyQuiet(null);
}
/* After a restore or a rolled-back change: the copy follows whether the
 * unit is there. */
function settleFallback() {
    if (fallbackPresent()) rebuildFallback(); else unbindFallback();
}
/* Turns the fallback on, or refreshes it: builder, unit, link and recmgr
 * entry where they differ, the copy rebuilt and bound (keepRunning:
 * rebuildFallback's). No bounce: the caller bounces once. True when the
 * running copy stayed. */
function ensureFallback(state, keepRunning) {
    var was = fallbackPresent();
    if (!fs.existsSync(fallbackUnitSource())) throw refuse(FALLBACK_UNIT + ' missing beside mgu-deploy.js');
    selfInstall(); // the boot unit runs current/fallback_build.js
    // its recmgr entry on disk before the unit and its link
    var rec = recmgrOp([FALLBACK_NAME], []), ops = rec ? [rec] : [];
    var unitDest = path.join(CFG.systemd, FALLBACK_UNIT);
    var link = path.join(CFG.systemd, 'multi-user.target.wants', FALLBACK_UNIT), cur = null;
    if (!bytesEqualFile(fs.readFileSync(fallbackUnitSource()), unitDest)) {
        ops.push({ type: 'copy', src: fallbackUnitSource(), path: unitDest, mode: 0o644 });
    }
    try { cur = fs.readlinkSync(link); } catch (e) { /* not enabled */ }
    if (cur !== '../' + FALLBACK_UNIT) {
        if (!fs.existsSync(path.dirname(link))) noteCreatedDir(state, path.dirname(link));
        ops.push({ type: 'mkdir', path: path.dirname(link) });
        ops.push({ type: 'symlink', path: link, target: '../' + FALLBACK_UNIT });
    }
    if (ops.length) {
        syncDisks();
        rootfsWindow(ops);
        runOk(CFG.systemctl, ['daemon-reload']);
    }
    if (!fs.existsSync(customAppsFile())) writeCustomApps({});
    var kept = rebuildFallback(keepRunning);
    delete state.fallback_refused;
    if (!was) say('provisioning fallback turned on');
    return kept;
}
/* iDrive 7: apps of ours listed in custom_apps.json (what the fallback
 * lists) while the fallback is not active (its unit gone, or main.js not bound to the
 * copy): the running manager provisions none of them, so their tiles stay
 * hidden. The retired installer's leftovers list apps by themselves until
 * an app install migrates them. */
function fallbackLost() {
    if (isId8() || retiredBackups().length) return false;
    if (!Object.keys(readCustomApps()).length) return false;
    return !(fallbackPresent() && (!binds() || boundToCopy()));
}
/* What a restarted app manager needs to initialise: without them it fails
 * its start again and again, and oapcontroller wipes every app at the
 * third failure in a row. */
var PLATFORM_UNITS = ['vsomeipd.service', 'hmi.service'];
/* An install with no app work on a unit where fallbackLost(): the fallback
 * goes on again and the manager restarts once (bounceManager's rules), so
 * the tiles show; with PLATFORM_UNITS not running, the boot unit lists
 * them from the next start instead. A copy that does not build, or a
 * failure, leaves the fallback as it was, recorded in state.json
 * (fallback_refused) for status; the install stands. */
function relistApps(state) {
    var backup = null;
    try {
        preflightFallback();
        backup = takeSnapshot('fallback', fallbackTouched());
        ensureFallback(state, false);
        var down = PLATFORM_UNITS.filter(function (u) { return unitState(u, 'is-active') !== 'active'; });
        if (down.length) {
            say('our apps are listed again from the next start of the head unit (' + down.join(', ') + ' not running, ' +
                'so a restarted app manager could not start)');
            privacyBounceOwed = false;
            return;
        }
        var m = managerStart();
        if (m && fallbackPresent() && hookAnnounced(m)) return;
        say('our apps are listed again: restarting the app manager so their tiles show');
        if (bounceManager() && inplaceHookOf(fs.readFileSync(FALLBACK_COPY, 'utf8')) !== null) inplaceManager();
    } catch (e) {
        warn('our apps\' tiles stay hidden: ' + e.message);
        state.fallback_refused = e.message;
        if (backup) {
            try { restoreSnapshot(backup); runOk(CFG.systemctl, ['daemon-reload']); settleFallback(); }
            catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        }
    }
}
/* Whether the running app manager runs the fallback copy, which is bound:
 * its in-place hook announced itself for this manager; for a copy without
 * the hook, the manager started after the copy was written; or the manager
 * is the one a bounce of this tool started, still younger than the bounce
 * minimum (the hook announces once MainApp has initialised). null without
 * a manager. */
function managerRunsCopy() {
    var m = managerStart();
    if (!m) return null;
    if (!fallbackPresent() || !(!binds() || boundToCopy())) return false;
    var copy = null;
    try { copy = fs.readFileSync(FALLBACK_COPY, 'utf8'); } catch (e) { return false; }
    if (inplaceHookOf(copy) === null) return !managerStale();
    if (hookAnnounced(m)) return true;
    var lb = lastBounceAt();
    return m.started !== null && lb > 0 && m.started >= lb - 1 && m.started + CFG.bounceMinUpS > nowS();
}
/* The copy's in-place hook announced itself for manager m. */
function hookAnnounced(m) {
    var st = readJsonOrNull(inplaceStatusFile());
    return !!st && st.pid === m.pid && st.state !== 'off' && typeof st.start === 'number' && m.started !== null &&
        Math.abs(st.start / 1000 - m.started) < 5;
}
function fallbackOn(state) {
    preflightFallback();
    var backup = takeSnapshot('fallback', fallbackTouched());
    try {
        ensureFallback(state);
        onGuardStop(function () { saveState(state); }, bounceManager);
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
        var rec = recmgrOp([], [FALLBACK_NAME]);
        if (rec) ops.push(rec);
        rootfsWindow(ops);
        runOk(CFG.systemctl, ['daemon-reload']);
        unbindFallback();
        unbindCertCopy();
        pruneCreatedDirs(state);
        onGuardStop(function () { saveState(state); }, bounceManager);
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
    var loadedBefore = loads(), wasBound = binds() && bindMounted(mainJs());
    /* the snapshot copies the main.js under the fallback copy */
    if (wasBound) runOk(CFG.umount, [mainJs()]);
    try { backup = takeSnapshot('migrate', retiredTouched(plan)); }
    catch (e) { if (wasBound) bindCopy(); throw e; }
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
            /* the check needs the restarted manager, also within remove-all */
            var deferred = bounceDeferred;
            bounceDeferred = false;
            try { bounceManager(); } finally { bounceDeferred = deferred; }
            if (restartDeferred) { bounced = false; throw fail('the app manager was not restarted to check it'); }
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
    fb.manager_runs_copy = isId8() ? null : managerRunsCopy();
    if (isId8()) fb.listed_by_manager = filledByManager();
    fb.refused = state.fallback_refused || null;
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
        if (recmgrPresent()) recmgrNamesOf(t.component).forEach(function (n) {
            if (recmgrHas(n) && !recmgrLoaded(n)) pend(t.id, PENDING_RECMGR);
            else if (!recmgrHas(n) && (t.component.restart || []).length) pend(t.id, 'recmgr entry missing');
        });
        var stale = t.id === 'mgu-deploy' ? null : toolStale(t, state);
        components.push({ id: t.id, kind: 'tool', version: t.version, units: units, provides: t.component.mguProvides || null,
            previous: toolPrevious(t), stale: stale, kept: !!keptToolArtifact(t), needs_setup: needsSetup(state, t.id) });
    });
    installedApps().forEach(function (app) {
        var tile = tileState(app, fb);
        components.push({ id: app.id, kind: 'app', version: app.version, uid: app.uid,
            installationSource: app.installationSource, running: appRunning(app.uid),
            tile_provisioned: tile.provisioned, tile_fallback: tile.fallback, tile_visible: tile.visible, tile_withheld: tile.withheld,
            previous: isId8() ? null : (keptPrevious(app.id, app.version) || {}).version || null, stale: appStale(app) });
    });
    var backupCount = 0;
    if (fs.existsSync(BACKUPS_DIR)) backupCount = fs.readdirSync(BACKUPS_DIR).length;
    var unit = unitInfo();
    return { version: VERSION, unit: { hmi: unit.hmi, firmware: unit.firmware }, components: components, pending_reboot: pending,
        last_apply: readJsonOrNull(ID8_LAST),
        last_verify: readJsonOrNull(VERIFY_LAST),
        remove_when_unused: readUnused(),
        display_bridge_socket: fs.existsSync(CFG.socketPath),
        display_bridge_todo_on_car: bridgeTodoLines(),
        fallback: fb, backups: backupCount,
        retired_leftovers: retiredBackups().map(function (b) { return b.path; }),
        updater_tokens: storedTokens().length,
        appmanager: amStatus(),
        idrive7: { apps: i7Apps(state) },
        mainapp_guard: guardWhy(),
        last_bounce_at: lastBounceAt() || null,
        lost_apps: lostApps(state),
        hmi_parts: id7PartsReport(),
        stock_backup: fs.existsSync(path.join(BACKUPS_DIR, 'stock')) };
}
function cmdStatus(args, crashList, live, limits, listing) {
    var s = collectStatus(loadState());
    s.crash_list = crashList;
    s.service_limits = limits;
    if (live) s.live_installs = live;
    if (listing) s.listing = listing;
    s.app_privacy_record = privacyRecord();
    if (args.json) { say(JSON.stringify(s)); return 0; }
    say('crash handler whitelist: ' + crashList.state + ' (' + crashList.reason + ')');
    say('service limits: ' + limits.state + ' (' + limits.reason + ')');
    if (live) say('live app installs: ' + live.state + ' (' + live.reason + ')');
    if (listing) say('our apps listed for the fallback: ' + listing.state + ' (' + listing.reason + ')');
    say('mgu-deploy ' + VERSION);
    say('head unit: ' + (s.unit.hmi ? hmiName(s.unit.hmi) : 'unknown') + ' (' + unitInfo().basis + '), firmware ' +
        (s.unit.firmware || 'unknown'));
    say('components:');
    s.components.forEach(function (c) {
        if (c.kind === 'tool') {
            say('  tool ' + c.id + ' ' + c.version + (c.stale ? ' (not working: ' + c.stale + ')' : '') +
                (c.needs_setup ? ' (needs setup: ' + c.needs_setup + ')' : ''));
            c.units.forEach(function (u) {
                say('    ' + u.name + ' enabled=' + u.enabled + ' active=' + u.active);
                u.journal.forEach(function (l) { say('      ' + l); });
            });
        } else {
            say('  app ' + c.id + ' ' + c.version + ' uid=' + c.uid + ' source=' + c.installationSource +
                ' running=' + c.running + ' tile=' + (c.tile_provisioned ? 'provisioned' :
                (c.tile_fallback ? 'fallback' : 'hidden')) + (c.stale ? ' (not working: ' + c.stale + ')' : ''));
        }
    });
    if (!s.components.length) say('  (none)');
    var runs = s.app_privacy_record && Array.isArray(s.app_privacy_record.latest) ? s.app_privacy_record.latest : [];
    var lastRun = runs[runs.length - 1];
    if (lastRun) {
        var skippedNow = privacySkipped(lastRun.edits);
        say('app-privacy: ' + lastRun.state + ' on MainApp ' + (lastRun.mainappVersion || 'unknown') + ' (' + lastRun.command +
            ' ' + lastRun.time + ')' + (skippedNow ? '; ' + skippedNow : ''));
    }
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
    if (s.mainapp_guard) say('no app changes until the next start of the head unit: ' + s.mainapp_guard);
    s.lost_apps.forEach(function (a) { say('not registered: ' + a.id + ' ' + a.version + ' (its package is at ' + a.package + ')'); });
    s.hmi_parts.forEach(function (a) { say('iDrive 7 HMI files not in place: ' + a.id + ' ' + a.version + ' (' + a.files.join(', ') + ')'); });
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
        /* the installed version's too: what it has and this one has not goes */
        var installed = installedTools().filter(function (t) { return t.id === a.id; })[0];
        var gone = installed ? toolTouched(toolDeclared(installed.root, installed.component)) : [];
        return toolTouched(a.component).concat(gone).concat(i7Takeover(a).paths)
            .concat([path.join(CFG.varOpt, a.id, 'versions', a.version)]).concat(uplinkDropIns(a.id));
    }
    if (isId8()) return applyTouched().concat(id8LiveTouched(a.id, a.version), uplinkDropIns(a.id));
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
        var res = lastJsonLine(r.stdout), sk = res ? privacySkipped(res.edits) : '';
        say('app-privacy: ' + (res ? res.state + (res.mainapp ? ' (MainApp ' + res.mainapp + ' edits)' : '') +
            (sk ? '; ' + sk : '') : 'exit ' + r.status));
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
    fb.manager_runs_copy = isId8() ? null : managerRunsCopy();
    if (isId8()) fb.listed_by_manager = filledByManager();
    say('fallback: ' + (fb.active ? 'active' : 'inactive'));
    installedApps().forEach(function (app) {
        var tile = tileState(app, fb);
        say('app ' + app.id + ' ' + app.version + ': tile ' +
            (tile.provisioned ? 'provisioned' : (tile.fallback ? 'via fallback' : 'hidden')));
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
/* install --leave: the tools a later install of this caller installs, which
 * no install of this run (an app's afresh among them) lays again */
var leaveIds = [];
/* An install, then the current apps it found waiting for an update after a
 * firmware update installed afresh, each with its data folder carried over. */
function cmdInstall(args) {
    if (args.leave) leaveIds = args.leave;
    var afresh = [], failed = [];
    var code = installRun(args, afresh);
    afresh.forEach(function (r) {
        try {
            var app = installedApp(r.id);
            if (!app) return;
            say('installing ' + r.id + ' ' + app.version + ' afresh: ' + r.why);
            var err = reinstallApp(app, r.file, keptFile(r.id, app.version), app.version);
            if (err) failed.push(r.id + ': ' + err.message);
            else say(r.id + ' ' + app.version + ' installed afresh');
        } catch (e) { failed.push(r.id + ': ' + e.message); } finally { rmrf(r.file); }
    });
    if (failed.length) throw fail('installing afresh failed: ' + failed.join('; '));
    return code;
}
/* Each artifact is its own transaction: its own snapshot, and on failure
 * only its own changes are undone. Artifacts installed before it in the
 * same call stay installed. */
function installRun(args, afresh) {
    var files = args.artifacts.length ? args.artifacts.map(function (f) { return path.resolve(f); })
        : args.setup ? [] : kitArtifacts();
    var stage = stageDir(), state = loadState(), done = [], attempted = false, id8 = isId8(), elsewhere = {};
    /* an install after a remove-all keeps the deploy tool */
    rmrf(REMOVE_ALL_FILE);
    try {
        var validated = files.map(function (f) { return validateArtifact(f, stage); });
        if (args.otherSource) validated.forEach(function (a) { a.otherSource = a.kind === 'tool'; });
        validated = orderArtifacts(validated);
        /* a kit (--skip-older) installs what is for this unit and leaves the rest */
        validated = validated.filter(function (a) {
            var why = incompatible(a);
            if (why && !args.skipOlder) throw refuse(why);
            if (why) say(a.id + ' ' + a.version + ' skipped: ' + why);
            return !why;
        });
        /* before app-privacy's check and anything that changes the unit */
        var noOap = codingStopsOap();
        if (noOap && managerPid()) noOap = null;
        if (noOap && validated.some(function (a) {
            return a.kind === 'app' && ['current', 'older'].indexOf(appDecision(a, args.skipOlder).action) < 0;
        })) throw refuse(codingMissing(noOap));
        if (!mgrDataReady() && validated.some(function (a) { return a.kind === 'app'; })) {
            throw refuse('the app manager has not created its data folder yet (it does at its first start after a ' +
                'reset of the head unit); install the app once it runs');
        }
        validated.forEach(function (a) {
            var foreign = a.kind === 'tool' && (a.service || a.provides || (a.component.dropins || []).length) ? foreignUnit(a.component) : null;
            if (foreign) {
                throw refuse(a.id + ' ' + a.version + ': ' + foreign + ' is installed, but by no tool of ours (another manager runs it); remove it there first');
            }
        });
        if (!unitInfo().hmi) warn('which head unit this is is unknown (' + unitInfo().basis + '): mguHmi is not checked');
        if (args.skipOlder) {
            var tools = installedTools();
            validated = validated.filter(function (a) {
                var t = a.kind === 'tool' && tools.filter(function (t) { return t.id === a.id; })[0];
                var older = t && semverCmp(a.version, t.version) < 0;
                if (older) say(a.id + ' ' + a.version + ' skipped; ' + t.version + ' is installed');
                return !older;
            });
        }
        /* installed tools this run does not install: laid again from their
         * kept copy when set up under another firmware or missing a piece;
         * one with an install step, files only (relayFiles), unless this run
         * sets it up */
        var relaid = [];
        installedTools().forEach(function (t) {
            if (t.id === 'mgu-deploy' || validated.some(function (a) { return a.id === t.id; }) || leaveIds.indexOf(t.id) >= 0 ||
                (args.setup && args.setup.indexOf(t.id) < 0)) return;
            var setup = (args.setup || []).indexOf(t.id) >= 0;
            var why = toolStale(t, state) || (setup ? needsSetup(state, t.id) : null), kept = why ? keptToolArtifact(t) : null;
            if (!why) {
                if (!state.tools || !state.tools[t.id]) {
                    recordTool(state, t.id, t.version);
                    attempted = true;
                }
                return;
            }
            if (!kept) {
                say(t.id + ' ' + t.version + ': ' + why + '; no copy of it is kept here, so its source installs it again');
                return;
            }
            if (!setup && hasInstallStep(t.component)) { relaid.push({ t: t, why: why }); return; }
            say(t.id + ' ' + t.version + ': ' + why + '; laid again from the copy kept here');
            kept.repair = why;
            kept.firmwareMoved = toolMoved(state, t.id);
            validated.push(kept);
        });
        validated = orderArtifacts(validated);
        preflightPrivacy(validated);
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
        if (!id8 && !noOap) {
            validated.forEach(function (a) {
                if (a.kind !== 'app' || decisions[a.id].action !== 'current') return;
                var e = null;
                try { e = setUpElsewhere(a, decisions[a.id].existing, stage); }
                catch (err) { warn(a.id + ' ' + a.version + ' is not installed afresh: ' + err.message); }
                if (!e) return;
                if (!managerPid()) {
                    say(a.id + ' ' + a.version + ': ' + e.why + '; an install while the app manager runs installs it afresh');
                    return;
                }
                elsewhere[a.id] = e;
            });
        }
        var work = validated.filter(function (a) {
            return a.kind !== 'app' || ['current', 'older'].indexOf(decisions[a.id].action) < 0;
        }).map(function (a) { return a.kind !== 'app' ? a : id8 ? id8Package(a, stage) : prepareApp(a, stage); });
        validated.forEach(function (a) {
            if (a.kind === 'app' && decisions[a.id].action === 'older') {
                say(a.id + ' ' + a.version + ' skipped; ' + decisions[a.id].existing.version + ' is installed');
            }
            if (a.kind === 'app' && decisions[a.id].action === 'current' && elsewhere[a.id]) {
                say(a.id + ' ' + a.version + ' already installed; ' + elsewhere[a.id].why + ': installed afresh after the rest');
            } else if (a.kind === 'app' && decisions[a.id].action === 'current') {
                say(a.id + ' ' + a.version + ' already installed; nothing to change');
            }
        });
        var apps = work.some(function (a) { return a.kind === 'app'; }), migrated = id8;
        if (apps || Object.keys(elsewhere).length) guardRefuse('an app install');
        if (apps && !id8) preflightFallback();
        /* every app current, the fallback lost: listed again after the
         * tools, with the one bounce app-privacy's waits for */
        var relist = !apps && !noOap && !guardWhy() && fallbackLost();
        privacyMayWait = apps && !id8 && managerListsNoApp() || relist;
        privacyWaitsRelist = relist;
        if (work.length) {
            ensureStock('install', work.reduce(function (all, a) { return all.concat(artifactTouched(a)); },
                apps && !id8 && retiredBackups().length ? retiredTouched(null) : []));
        }
        /* past every refusal: the files only of the tools the loop above left so */
        relaid = relaid.filter(function (x) {
            try { relayFiles(x.t, state, x.why); attempted = true; return true; }
            catch (e) { warn(x.t.id + ' ' + x.t.version + ' is not laid again: ' + e.message); return false; }
        }).map(function (x) { return x.t.id; });
        work.forEach(function (a) {
            /* after the tools, app-privacy among them, before the first app */
            if (a.kind === 'app' && !migrated) {
                migrated = true;
                try { migrateRetiredFirst(state); } catch (e) {
                    if (done.length) say('installed before this failure, and kept: ' + done.join(', '));
                    throw e;
                }
                if (!id8) {
                    try { cleanInterrupted(state); saveState(state); }
                    catch (e) { warn('what interrupted installs left was not looked at: ' + e.message); }
                }
            }
            var tx = {}, backup = takeSnapshot('install', artifactTouched(a));
            attempted = true;
            if (a.kind === 'app' && !id8) {
                beginAppTx(tx, a, decisions[a.id].existing);
                state.inflight = { id: a.id, version: a.version, pid: process.pid, boot: bootId() };
                state.placed = Object.assign({}, state.placed);
                state.placed[a.id] = { version: a.version, sha256: sha256File(a.file) };
                saveState(state);
            } else if (a.kind === 'app' && decisions[a.id].existing) saveAppFolders(tx, a, decisions[a.id].existing);
            try {
                if (a.kind === 'tool') installTool(a, state, tx);
                else if (id8) installAppId8(a, state, decisions[a.id], backup);
                else {
                    keepInstalledPackage(a.id);
                    /* a trip once its package is placed records this version: listed, the
                     * next start installs it, and a later loss installs it again */
                    onGuardStop(function () {
                        /* it stands: no interrupted install for the next run to clean up */
                        endAppRecord(state, a.id);
                        saveState(state);
                        if (fs.existsSync(path.join(preinstalledDir(), a.id + '@' + a.version + '.tgz'))) recordApp(a.id, a.version, a.file);
                    }, function () { installApp(a, state, decisions[a.id]); });
                    keepPackage(a);
                    takeNewestStash(state, a.id);
                }
                syncDropIns();
                /* a tool's earlier current folder stays until here, for a rollback */
                if (tx.legacy) rmrf(tx.legacy);
                if (tx.saved) rmrf(tx.saved.dir);
                endAppRecord(state, a.id);
                done.push(a.id + ' ' + a.version);
            } catch (e) {
                process.stderr.write(a.id + ' ' + a.version + ' failed: ' + e.message + '\n');
                try {
                    if (a.kind === 'tool') rollbackTool(a, tx, backup, e, state);
                    else if (id8) rollbackAppId8(backup, state, tx);
                    else rollbackApp(a, tx, backup, state);
                    endAppRecord(state, a.id);
                    if (tx.saved) rmrf(tx.saved.dir);
                } catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
                /* a tool laid again from its copy: the rest goes on */
                if (a.repair && (args.setup || []).indexOf(a.id) < 0) { warn(a.id + ' ' + a.version + ' is not laid again: ' + e.message); return; }
                if (done.length) say('installed before this failure, and kept: ' + done.join(', '));
                if (relaid.length) say('laid again before this failure, files only, and kept: ' + relaid.join(', '));
                if ((done.length || relaid.length) && e.code === 2) e.code = 1;
                throw e;
            }
        });
        if (relist) { attempted = true; relistApps(state); }
        if (relaid.length) {
            syncDropIns();
            say('needs setup (its install step runs at its next install or update, or with Set up in the Store): ' + relaid.join(', '));
        }
        if (id8 && !noOap) {
            try {
                var listedNow = relistId8();
                if (listedNow.length) say('listed for the provisioning fallback, from the next start of the head unit: ' + listedNow.join(', '));
            } catch (e) { warn('our apps not listed for the provisioning fallback: ' + e.message); }
        }
        settlePrivacyBounce();
        /* out of the staging folder, which goes before they install */
        Object.keys(elsewhere).forEach(function (id) {
            var file = path.join(DEPLOY_DIR, id + '.afresh.tmp-' + process.pid);
            copyFileMode(elsewhere[id].artifact.file, file, 0o600);
            afresh.push({ id: id, why: elsewhere[id].why, file: file });
        });
    } finally {
        try {
            try { settlePrivacyBounce(); }
            catch (e) { warn('the app manager was not restarted for app-privacy: ' + e.message); }
            /* the record of what this run installed is kept even when the
             * deploy tool's own install fails; that failure still fails the run */
            try { if (done.length) selfInstall(); }
            finally { if (attempted) saveState(state); }
        } finally { rmrf(stage); }
    }
    return 0;
}
/* What an app install may leave behind: app homes the manager created,
 * the fallback app list and the fallback itself; for an update, the app's
 * folders MainApp's update removes, copied aside. */
function beginAppTx(tx, a, existing) {
    tx.homes = fs.existsSync(CFG.oap) ? fs.readdirSync(CFG.oap) : [];
    tx.custom = fs.existsSync(customAppsFile()) ? sha256File(customAppsFile()) : null;
    tx.fallback = fallbackPresent();
    tx.fresh = !existing;
    if (existing) saveAppFolders(tx, a, existing);
}
/* MainApp's update of an app unregisters it (its tile goes), deletes its
 * registry entry and removes these folders before it builds the new
 * version's; when its installer then rejects the new version (a manifest
 * generateSomeipInterfaces refuses: UPDATE_FAILED), they stay gone, and
 * at its next start MainApp drops an app without its acl.json. */
var UPDATE_REMOVES = ['source', 'someipInterfaces', 'rhmiData', 'rhmiDataStartWidget'];
function folderDigest(dir) {
    if (!lstatOrNull(dir)) return 'absent';
    return walk(dir, '', []).map(function (e) {
        var st = e.stat;
        return [e.rel, st.mode, st.uid, st.gid, st.size, st.mtime.getTime(),
            st.isSymbolicLink() ? fs.readlinkSync(e.path) : ''].join(':');
    }).sort().join('\n');
}
/* Copied with their owners and modes; their ACLs (MainApp's grants to
 * the HMI's resource group and the app's groups, without which the HMI
 * cannot read the tile's icon) in getfacl's record. */
function saveAppFolders(tx, a, existing) {
    var home = appHome(existing.uid), present = [];
    tx.saved = { id: a.id, uid: existing.uid, version: existing.version,
        dir: path.join(DEPLOY_DIR, 'app-home-' + process.pid), digests: {} };
    rmrf(tx.saved.dir);
    mkdirp(tx.saved.dir, 0o700);
    UPDATE_REMOVES.forEach(function (n) {
        var p = path.join(home, n);
        tx.saved.digests[n] = folderDigest(p);
        if (lstatOrNull(p)) { copyTree(p, path.join(tx.saved.dir, n)); present.push(p); }
    });
    if (FAKE || !present.length) return;
    tx.saved.acl = path.join(tx.saved.dir, 'acl.txt');
    fs.writeFileSync(tx.saved.acl, runOk(CFG.getfacl, ['-R', '-p'].concat(present)).stdout, { mode: 0o600 });
}
/* The saved folders that changed go back; true when any did. */
function restoreAppFolders(saved) {
    var home = appHome(saved.uid), changed = UPDATE_REMOVES.filter(function (n) {
        return folderDigest(path.join(home, n)) !== saved.digests[n];
    });
    changed.forEach(function (n) {
        var p = path.join(home, n), from = path.join(saved.dir, n);
        rmrf(p);
        if (lstatOrNull(from)) copyTree(from, p);
    });
    if (changed.length && saved.acl) runOk(CFG.setfacl, ['--restore=' + saved.acl]);
    if (changed.length) say('put back ' + changed.join(', ') + ' of ' + saved.id + ' ' + saved.version + ' in ' + home);
    return changed.length > 0;
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
    /* a first install the manager stopped after it gave the app a uid
     * leaves that uid's line, as did earlier failed attempts: with no
     * registry entry, every line of the app goes. The file is written in
     * place, so it keeps its owner, mode and ACLs. */
    if (tx.fresh && !lstatOrNull(appEntryFile(a.id)) && fs.existsSync(uidsFile())) {
        var lines = fs.readFileSync(uidsFile(), 'utf8').split('\n');
        var left = lines.filter(function (l) { return l.split('=')[1] === a.id; });
        if (left.length) {
            fs.writeFileSync(uidsFile(), lines.filter(function (l) { return left.indexOf(l) < 0; }).join('\n'));
            say('removed ' + left.join(', ') + ' from ' + uidsFile());
        }
    }
    /* the running manager no longer has the app registered: a restarted
     * one loads it from its registry entry and folders, tile and all */
    if (tx.saved && restoreAppFolders(tx.saved) && managerSoon()) {
        say('the app manager unregistered ' + a.id + ' during the update: restarting it so it loads ' + a.id + ' ' +
            tx.saved.version + ' again');
        bounceManager();
    }
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
        throw refuse('mgu-deploy: the deploy tool goes with remove-all, which removes the Store setup ' +
            '(the installer\'s uninstall)');
    }
    if (id === AM.app && amPresent()) {
        guardRefuse('the removal of IterioDev\'s App Manager');
        return amCommand('uninstall', amRemove);
    }
    if (id === 'app-privacy') guardRefuse('the removal of app-privacy');
    var state = loadState();
    var isTool = installedTools().some(function (t) { return t.id === id; });
    if (!isTool && isId8()) return uninstallQueuedId8(id, state);
    if (!isTool && !readJsonOrNull(appEntryFile(id))) throw refuse(id + ': not installed');
    if (!isTool) guardRefuse('an app removal');
    /* an app whose removal is queued for the next start (iDrive 8) is gone before MainApp-21 starts */
    var staying = ourApps().filter(function (a) { return !queuedRemoval(a); });
    if (id === 'app-privacy' && staying.length) {
        throw refuse('app-privacy stays while our apps are installed (' + staying.join(', ') + '); uninstall them first');
    }
    if (!isTool) {
        if (retiredBackups().length) ensureStock('uninstall', touchedForUninstall(id).concat(retiredTouched(null)));
        migrateRetiredFirst(state);
    }
    var backup = takeSnapshot('uninstall', touchedForUninstall(id));
    try {
        if (isTool) { uninstallTool(id, state); dropVerify(id); } else uninstallApp(id, state, args.keepPackages);
        if (!args.keepPackages) { rmrf(keptDir(id)); forgetStash(state, id); }
        if (isTool && state.tools) delete state.tools[id];
        if (isTool && state.deactivated) delete state.deactivated[id];
        if (isTool && state.deactivate_owed) delete state.deactivate_owed[id];
        syncDropIns();
        state.pending_reboot = state.pending_reboot.filter(function (p) { return p.id !== id; });
        saveState(state); selfInstall();
    } catch (e) {
        if (e.code !== 2) {
            process.stderr.write('uninstall failed, rolling back from ' + backup + '\n');
            try { restoreSnapshot(backup); settleFallback(); } catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        }
        /* the deactivates that ran stay recorded, so none runs twice */
        try {
            var back = loadState();
            back.deactivated = state.deactivated;
            back.deactivate_owed = state.deactivate_owed;
            if (deactivated) reactivate(id, deactivated, back);
            saveState(back);
        } catch (e3) { process.stderr.write(id + ': activating it again failed: ' + e3.message + '\n'); }
        throw e;
    }
    return 0;
}
/* ---- remove-all: the Store setup off the unit ------------------------------------- */
/* remove-all takes off everything the Store setup put on the head unit, in
 * this order, each step with its snapshot and rollback as on its own:
 *   apps       every app this tool installed (its record, the fallback's
 *              list, the local-only marker); on iDrive 8 the ones the
 *              running MainApp-21 does not uninstall in place go at the
 *              next start, from the queue;
 *   tools      every installed tool but app-privacy, a tool another one
 *              requires after it;
 *   fallback   the provisioning fallback: unit, copy, binds, app list;
 *   privacy    app-privacy, its patch reverted;
 *   the rest   this tool's boot units and their recmgr entries, any limits
 *              drop-in and crash handler name it still owns, the app
 *              manager's files it wrote, the updater's sources and tokens,
 *              then this tool, its state and its backups.
 * The lists are edited as they are on the unit now, whatever firmware wrote
 * them; no snapshot is restored. The bounces the steps ask for are made
 * once, at the end, under the usual rules. A step that fails is rolled back
 * and named; what depends on it stays (app-privacy and the fallback while
 * an app of ours is left; this tool while anything is), so running it
 * again finishes the job. On iDrive 8 with removals queued, the queue's
 * boot unit and this tool stay until the next start, which applies them
 * and then removes both. Apps and the renderer adopted from IterioDev's
 * App Manager stay, as `uninstall oap-appmanager` leaves them. */
var REMOVE_ALL_FILE = path.join(DEPLOY_DIR, 'remove-all.json');
var GUARD_FILE_NAME = 'mgu-deploy-guard.json';
/* What IterioDev's App Manager installed: the apps its record names (adopted)
 * and, while it is on the unit, the ones it lists itself. */
function amAdopted() {
    var rec = readJsonOrNull(AM_RECORD) || {};
    var apps = (Array.isArray(rec.apps) ? rec.apps : []).concat(amPresent() ? amApps() : []);
    var ids = [];
    apps.forEach(function (x) { if (x && typeof x.id === 'string' && ids.indexOf(x.id) < 0) ids.push(x.id); });
    return { apps: ids, renderer: !!rec.renderer };
}
/* The apps this tool installed: recorded, listed by the fallback or marked
 * local-only; on iDrive 8 also those with our das lines and queued installs. */
function removalApps(state) {
    var adopted = amAdopted().apps, custom = readCustomApps(), recorded = state.apps || {}, out = {};
    function add(id, version) {
        if (adopted.indexOf(id) >= 0 || ID8_PROTECTED.indexOf(id) >= 0 || id === AM.app) return;
        if (!out[id] || !out[id].version) out[id] = { id: id, version: version || null, next_start: queuedRemoval(id) };
    }
    registryEntries().forEach(function (r) {
        var app = installedApp(r.id);
        if (app && (recorded[r.id] || r.id in custom || app.pkg.mguLocalOnly === true)) add(r.id, app.version);
    });
    if (isId8()) {
        dasApps().forEach(function (id) { add(id, (installedApp(id) || {}).version); });
        readPending().forEach(function (c) { if (c.action === 'install') add(c.id, c.version); });
    }
    return Object.keys(out).sort().map(function (id) { return out[id]; });
}
function removalTools() {
    var keepRenderer = amAdopted().renderer;
    return installedTools().filter(function (t) { return t.id !== 'mgu-deploy' && !(keepRenderer && t.id === 'mgu-renderd'); });
}
/* A tool another remaining tool requires goes after it; else by id. */
function removalOrder(tools) {
    var left = tools.slice(), out = [];
    while (left.length) {
        var next = left.filter(function (t) {
            return !left.some(function (o) { return o !== t && o.component.requires && typeof o.component.requires === 'object' &&
                Object.prototype.hasOwnProperty.call(o.component.requires, t.id); });
        })[0] || left[0];
        out.push(next);
        left.splice(left.indexOf(next), 1);
    }
    return out;
}
function fallbackOnUnit() {
    return fallbackPresent() || fs.existsSync(FALLBACK_COPY) || (binds() && bindMounted(mainJs())) || fs.existsSync(customAppsFile());
}
function removeAllPlan(state) {
    var info = unitInfo(), self = readJsonOrNull(path.join(DEPLOY_DIR, 'current', 'component.json'));
    var sources = readJsonOrNull(sourcesFile()), adopted = amAdopted();
    var kept = adopted.apps.filter(function (id) { return !!readJsonOrNull(appEntryFile(id)) || dasApps().indexOf(id) >= 0; });
    if (adopted.renderer && installedTools().some(function (t) { return t.id === 'mgu-renderd'; })) kept.push('mgu-renderd');
    return {
        unit: { hmi: info.hmi, firmware: info.firmware },
        apps: removalApps(state),
        tools: removalOrder(removalTools()).map(function (t) {
            return { id: t.id, version: t.version, title: t.component.title || t.id };
        }),
        kept: kept,
        privacy_patch: installedTools().some(function (t) { return t.id === 'app-privacy'; }),
        fallback: fallbackOnUnit(),
        sources: sources && Array.isArray(sources.sources) ? sources.sources.length : 0,
        tokens: storedTokens().length,
        deploy_tool: self && self.version ? self.version : VERSION
    };
}
function cmdRemoveAll(args) {
    var plan = removeAllPlan(loadState());
    if (!args.yes) {
        if (args.json) { say(JSON.stringify(plan)); return 0; }
        say('apps: ' + (plan.apps.map(function (a) { return a.id + (a.version ? ' ' + a.version : ''); }).join(', ') || 'none'));
        say('tools: ' + (plan.tools.map(function (t) { return t.id + ' ' + t.version; }).join(', ') || 'none'));
        if (plan.kept.length) say("kept (from IterioDev's App Manager): " + plan.kept.join(', '));
        say('updater: ' + plan.sources + ' sources, ' + plan.tokens + ' tokens');
        say('deploy tool ' + plan.deploy_tool + ', its state and backups');
        say('remove-all --yes removes all of it');
        return 0;
    }
    /* while the MainApp guard is off nothing goes: the next start finishes it */
    var off = guardWhy();
    if (off) {
        process.stderr.write('mgu-deploy: remove-all waits for the next start of the head unit: ' + off + '\n');
        say(JSON.stringify(removeAllLeft(plan, [])));
        return 1;
    }
    /* the steps' lines go to stderr; stdout keeps the result, one JSON line */
    var out = process.stdout.write, result;
    process.stdout.write = function (chunk) { return process.stderr.write(chunk); };
    try { result = removeAll(plan); }
    finally { process.stdout.write = out; }
    say(JSON.stringify(result));
    return result.left.length ? 1 : 0;
}
/* remove-all's result when it stops before its end: what it removed, and
 * the rest left for a run after the next start. */
function removeAllLeft(plan, removed) {
    var left = plan.apps.concat(plan.tools).map(function (c) { return c.id; })
        .filter(function (id) { return removed.indexOf(id) < 0; }).concat(['the deploy tool']);
    return { removed: removed, left: left, restart: true, next_start: [], self: 'kept' };
}
function removeAll(plan) {
    var left = [], removed = [], state;
    function step(what, fn) {
        try { fn(); return true; }
        catch (e) {
            left.push(what);
            process.stderr.write('mgu-deploy: ' + what + ' stays: ' + e.message + '\n');
            return false;
        }
    }
    function uninstall(id) {
        var running = leftRunning.length;
        if (step(id, function () { cmdUninstall({ positional: [id], yes: true }); })) removed.push(id);
        /* a service left running needs the next start, also when a later run finishes the job */
        if (leftRunning.length > running) {
            var s = loadState();
            addPending(s, 'mgu-deploy', id + ' removed; its services run until the next start');
            saveState(s);
        }
    }
    bounceDeferred = true;
    bounceOwed = false;
    leftRunning = [];
    var privacy = plan.tools.some(function (t) { return t.id === 'app-privacy'; });
    try {
        plan.apps.forEach(function (a) {
            if (a.next_start) { removed.push(a.id); return; }
            uninstall(a.id);
        });
        /* apps lost from the registry: their records and the data set aside for them */
        step('the data set aside', function () {
            var s = loadState();
            Object.keys(s.data_stash || {}).concat(Object.keys(s.apps)).forEach(function (id) { if (!installedApp(id)) forgetApp(s, id); });
            saveState(s);
        });
        plan.tools.forEach(function (t) { if (t.id !== 'app-privacy') uninstall(t.id); });
        state = loadState();
        var appsLeft = removalApps(state).filter(function (a) { return !a.next_start; });
        if (appsLeft.length) {
            appsLeft.forEach(function (a) { if (left.indexOf(a.id) < 0) left.push(a.id); });
        } else {
            if (fallbackOnUnit()) {
                step('the provisioning fallback', function () {
                    if (fallbackPresent() || fs.existsSync(FALLBACK_COPY) || (binds() && bindMounted(mainJs()))) fallbackOff(state, {});
                    rmrf(customAppsFile());
                    saveState(state);
                });
            }
            if (privacy) uninstall('app-privacy');
        }
    } finally {
        bounceDeferred = false;
    }
    /* the one bounce, while this tool still keeps its record (state.json) */
    var bounced = true;
    if (bounceOwed && !isId8() && managerPid()) {
        /* stopped by the MainApp guard: the result says what went, on stdout as at the end */
        try {
            onGuardStop(function () { fs.writeSync(1, JSON.stringify(removeAllLeft(plan, removed)) + '\n'); }, bounceManager);
            if (restartDeferred) bounced = false;
        }
        catch (e) { bounced = false; process.stderr.write('mgu-deploy: the app manager was not restarted: ' + e.message + '\n'); }
    }
    var queued = isId8() && readPending().some(function (c) { return c.action === 'remove'; });
    state = loadState();
    var restart = !bounced || leftRunning.length > 0 || state.pending_reboot.some(function (p) { return p.id !== FALLBACK_NAME; }) ||
        (isId8() && (plan.apps.length > 0 || privacy || plan.fallback));
    /* files a removal handed over while a process ran them: gone now, or
     * the cleanup unit and this tool stay to remove them at the next start */
    var busy = [];
    step('the files left for removal when unused', function () { busy = removeUnused(readUnused()); writeUnused(busy); });
    if (busy.length) { left.push('files in use: ' + busy.join(', ')); restart = true; }
    var self = 'kept';
    if (!left.length) {
        if (step('the deploy tool', function () { removeSelf(state, queued); })) self = queued ? 'next-start' : 'removed';
    }
    return { removed: removed, left: left, restart: restart || self === 'next-start',
        next_start: readPending().filter(function (c) { return c.action === 'remove'; }).map(function (c) { return c.id; }),
        self: self };
}
/* The last step: this tool's own pieces outside its folder, then the
 * folder. queued: iDrive 8 removals wait for the next start; the queue's
 * boot unit, its entry and this tool stay for it (REMOVE_ALL_FILE). */
function removeSelf(state, queued) {
    var units = [[VERIFY_UNIT, VERIFY_NAME], [CLEANUP_UNIT, CLEANUP_NAME]].concat(queued ? [] : [[APPLY_UNIT, APPLY_NAME]]);
    var ops = [], names = units.map(function (u) { return u[1]; });
    units.forEach(function (u) {
        [path.join(CFG.systemd, APPLY_WANTS, u[0]), path.join(CFG.systemd, u[0])].forEach(function (p) {
            if (lstatOrNull(p)) ops.push({ type: 'delete', path: p });
        });
    });
    var rec = recmgrOp([], names.concat([FALLBACK_NAME]));
    if (rec) ops.push(rec);
    /* what a kept tool (adopted from the App Manager) still has stays */
    var keep = installedTools().filter(function (t) { return t.id !== 'mgu-deploy'; });
    ops = ops.concat(limitsPlan(keep, null).ops);
    var crash = crashListPlan(keep), remounts = rootMountMode() === 'ro';
    if (crash && crash.op) ops.push(crash.op);
    if (ops.length) {
        rootfsWindow(ops);
        runOk(CFG.systemctl, ['daemon-reload']);
    }
    crashListDone(crash, remounts);
    pruneCreatedDirs(state);
    saveState(state);
    [customAppsFile(), localOnlyFile(), inplaceStatusFile(), listedRecordFile(), path.join(mgrHome(), 'data', GUARD_FILE_NAME)].forEach(rmrf);
    if (!installedTools().some(function (t) { return t.id === 'mgu-updater'; })) rmrf(updaterDir());
    if (queued) {
        writeAtomic(REMOVE_ALL_FILE, JSON.stringify({ at: new Date().toISOString() }) + '\n', 0o644);
        rmrf(BACKUPS_DIR);
        snapshotsTaken.length = 0;
        say('the deploy tool removes itself at the next start, after the queued removals');
        return;
    }
    removeDeployDir();
}
function removeDeployDir() {
    snapshotsTaken.length = 0;
    rmrf(DEPLOY_DIR);
    say('deploy tool removed from ' + DEPLOY_DIR);
}
/* At the next start on iDrive 8, after a remove-all's queued removals went
 * through: the queue's boot unit and its entry, then this tool. */
function removeSelfAtStart() {
    var ops = [path.join(CFG.systemd, APPLY_WANTS, APPLY_UNIT), path.join(CFG.systemd, APPLY_UNIT)]
        .filter(function (p) { return !!lstatOrNull(p); }).map(function (p) { return { type: 'delete', path: p }; });
    var rec = recmgrOp([], [APPLY_NAME]);
    if (rec) ops.push(rec);
    if (ops.length) rootfsWindow(ops);
    var state = loadState();
    pruneCreatedDirs(state);
    [customAppsFile(), listedRecordFile(), path.join(mgrHome(), 'data', GUARD_FILE_NAME)].forEach(rmrf);
    removeDeployDir();
}
/* rollback <id>: a tool's current back to the one other version kept
 * (args.to: that version only). The version going runs its deactivate
 * first (a failed one refuses the rollback), then the units, links,
 * drop-ins and list names it has and the other does not go. The other's
 * restart[] units follow the install rules and the health check; a failed
 * check, app-privacy apply or activate puts the snapshot back and restarts
 * them again, and the version going is activated again. Unit files both
 * list stay as the newer version installed them (they run from
 * current/). With args.restartRunning (the check at
 * a start) running ones restart even when keepRunning. An app goes back
 * to its kept older package (rollbackAppCmd). */
function cmdRollback(args) {
    var id = args.positional[0];
    if (!id) throw refuse('rollback needs a tool or app id');
    var tool = installedTools().filter(function (t) { return t.id === id; })[0];
    if (!tool) {
        if (readJsonOrNull(appEntryFile(id))) return rollbackAppCmd(id);
        throw refuse(id + ': no installed tool or app with that id');
    }
    var root = tool.root, cur = currentTarget(root);
    var others = fs.readdirSync(path.join(root, 'versions')).filter(function (v) {
        return v !== cur && semverParts(v);
    }).sort();
    if (!others.length) throw refuse(id + ' ' + cur + ': no other version is kept to roll back to');
    if (args.to && others.indexOf(args.to) < 0) throw refuse(id + ': ' + args.to + ' is not kept (' + others.join(', ') + ')');
    if (!args.to && others.length > 1) throw refuse(id + ': several versions are kept (' + others.join(', ') + '); install the one wanted');
    var target = args.to || others[0], tc = readJsonOrNull(path.join(root, 'versions', target, 'component.json'));
    if (!tc || tc.id !== id) throw refuse(id + ': versions/' + target + ' has no readable component.json');
    var state = loadState(), cc = tool.component;
    var backup = takeSnapshot('rollback', toolTouched(cc).concat(toolTouched(tc)));
    say('rolling back ' + id + ' ' + cur + ' -> ' + target);
    if (id === 'mgu-deploy') {
        dropVerify(id);
        switchCurrent(root, target);
        ensureShim();
        saveState(state);
        say('mgu-deploy ' + target + ' is current; the shim runs it from the next call');
        return 0;
    }
    var deactivated = false, switched = false, stopped = [], laid = [], started = [], touched = [], step = null;
    try {
        /* the version going runs its deactivate first, with all of it in
         * place, as at its removal; a failed one keeps it current */
        if (cc.deactivate) {
            deactivated = true;
            var dr = runHook(id, path.join(root, 'versions', cur), cc, 'deactivate', state);
            if (!dr.ok) throw refuse(id + ' ' + cur + ': deactivate ' + dr.why + '; ' + cur + ' stays current');
            if (dr.reboot) addPending(state, id, dr.reboot);
        }
        dropVerify(id);
        switchCurrent(root, target);
        switched = true;
        /* what the version going installed and target does not list goes */
        var gone = declaredOnly(cc, tc);
        stopped = stopUnits(gone, state);
        removeToolPieces(gone, installedTools(), state);
        laid = layMissing({ id: id, version: target, root: root, component: tc }, state);
        /* a running service started by a keepRunning version stays running
         * either way; one laid again starts as at a first install */
        var keep = Object.assign({}, tc, { keepRunning: !args.restartRunning && (tc.keepRunning || cc.keepRunning) });
        var isLaid = function (u) { return laid.indexOf(u) >= 0; };
        touched = applyRestarts(Object.assign({}, keep, { restart: (tc.restart || []).filter(function (u) { return !isLaid(u); }) }), state, false)
            .concat(applyRestarts(Object.assign({}, keep, { restart: (tc.restart || []).filter(isLaid) }), state, true));
        started = touched.filter(isLaid);
        (tc.enable || []).forEach(function (en) {
            if (!/\.socket$/.test(en.unit) || !isLaid(en.unit)) return;
            if (!recmgrLoaded(recmgrBase(en.unit))) { addPending(state, id, PENDING_BOOT); say(en.unit + ' ' + PENDING_BOOT); return; }
            if (systemctl(['start', en.unit]).status === 0) { say('started ' + en.unit); started.push(en.unit); }
            else warn('could not start ' + en.unit);
        });
        var bad = healthCheck(touched);
        if (bad) { step = 'restart'; throw fail(id + ' ' + target + ': ' + bad); }
        if (id === 'app-privacy') {
            var pr = onGuardStop(function () { noteHook(state, id, target, 'gone'); saveState(state); },
                function () { return privacyApplyAndBounce(state); });
            if (!pr.ok) { step = 'privacy'; throw fail('app-privacy ' + target + ': ' + pr.why); }
        }
        if (tc.activate) {
            var hr = runHook(id, path.join(root, 'versions', target), tc, 'activate', state);
            if (!hr.ok) { step = 'activate'; throw fail(id + ' ' + target + ': activate ' + hr.why); }
            if (hr.reboot) addPending(state, id, hr.reboot);
        }
        noteHook(state, id, target, 'gone');
    } catch (e) {
        /* a failed activate: the version gone to runs its deactivate before
         * anything goes back, as after a failed install; a failed one keeps
         * it current */
        var stays = false;
        if (step === 'activate' && tc.deactivate) {
            var td = runHook(id, path.join(root, 'versions', target), tc, 'deactivate', state);
            if (!td.ok) { stays = true; say(id + ' ' + target + ' stays current: deactivate ' + td.why); }
            else if (td.reboot) addPending(state, id, td.reboot);
        }
        if (switched && !stays) {
            try {
                restoreSnapshot(backup);
                runOk(CFG.systemctl, ['daemon-reload']);
                stopped.forEach(function (u) { runOk(CFG.systemctl, ['start', u]); say('started ' + u); });
                started.filter(function (u) { return !lstatOrNull(path.join(CFG.systemd, u)); })
                    .forEach(function (u) { systemctl(['stop', u]); say('stopped ' + u); });
                say(cur + ' is current again');
            } catch (e2) { process.stderr.write('putting ' + cur + ' back failed: ' + e2.message + '\n'); }
        }
        if (!stays && (step === 'restart' || step === 'activate')) {
            restartAgain(touched.filter(function (u) { return started.indexOf(u) < 0; }), id + ' ' + cur);
        }
        if (step === 'privacy') {
            var again = onGuardStop(function () { saveState(state); }, function () { return privacyApplyAndBounce(state); });
            if (!again.ok) say('app-privacy ' + cur + ' apply failed too: ' + again.why);
        }
        if (!stays && (deactivated || step === 'activate')) reactivate(id, path.join(root, 'versions', cur), state);
        throw e;
    } finally { saveState(state); }
    /* pieces of its own no copy kept here could lay again */
    var gap = toolStale({ id: id, version: target, component: tc }, state);
    if (gap) warn(id + ' ' + target + ': ' + gap + '; an install of its artifact lays them again');
    say(id + ' rolled back to ' + target);
    return 0;
}
/* The version Undo update returns a tool to: the one other version kept,
 * when it is older. */
function toolPrevious(t) {
    var cur = currentTarget(t.root), others = [];
    try {
        others = fs.readdirSync(path.join(t.root, 'versions')).filter(function (v) { return v !== cur && semverParts(v); });
    } catch (e) { /* no versions folder */ }
    return others.length === 1 && semverCmp(others[0], cur) < 0 ? others[0] : null;
}

/* ---- apps: kept packages and rollback (iDrive 7), unregistered apps ----------- */
/* Apps for the updater to install again from a package on the unit. On
 * iDrive 7, apps this tool installed (state.json apps) that MainApp's
 * registry no longer has, with the package kept for them: what
 * oapcontroller's wipe leaves. An uninstall drops both the record and the
 * packages, so an app removed on purpose is never one. On iDrive 8,
 * unprovisionedId8. None while another run holds the lock (it may be
 * removing one), and none while the app manager has not created its data
 * folder (after a factory reset). */
function lostApps(state) {
    var lock = lockState();
    if ((!lock.free && lock.live) || !mgrDataReady()) return [];
    if (isId8()) return unprovisionedId8();
    return Object.keys(state.apps).map(function (id) {
        var v = state.apps[id] && state.apps[id].version;
        return !lstatOrNull(appEntryFile(id)) && v && fs.existsSync(keptFile(id, v)) ? { id: id, version: v, package: keptFile(id, v) } : null;
    }).filter(Boolean);
}
/* iDrive 8: apps placed at a start (their package in preinstalled_apps,
 * their das lines) that MainApp-21 never installs because Telematics
 * serves the backend's provisioning, which does not list them: each with
 * its package, for the updater to install in place once the running
 * manager runs the hook (as inplaceManager has it). None with a change
 * queued for it, nor an update applied at the start: confirmId8 puts the
 * version before back, with its data, at the next one. Not IterioDev's
 * App Manager, which the Store replaces. */
function unprovisionedId8() {
    var hook = readJsonOrNull(inplaceStatusFile()), m = managerStart(), skip = [AM.app];
    if (!m || m.started === null || !hook || hook.pid !== m.pid || typeof hook.start !== 'number' ||
        Math.abs(hook.start / 1000 - m.started) >= 5 || bundlesWritten() > m.started || hook.state === 'off') return [];
    readPending().concat(readUnconfirmed()).forEach(function (c) { skip.push(c.id); });
    return dasApps().map(function (id) {
        var pkgs = preinstalledFor(id), v = pkgs.length === 1 && /@(\d+\.\d+\.\d+)\.tgz$/.exec(pkgs[0]);
        if (!v || skip.indexOf(id) >= 0 || lstatOrNull(appEntryFile(id)) || provisioningNames(id) !== false) return null;
        return { id: id, version: v[1], package: pkgs[0] };
    }).filter(Boolean);
}
/* The manager takes no older package for an installed app, so an app goes
 * back by uninstall and install. The packages for that are kept here, the
 * installed version's and the newest older one: kept/<id>/<id>@<v>.tgz,
 * root's. */
var KEPT_DIR = path.join(DEPLOY_DIR, 'kept');
function keptDir(id) { return path.join(KEPT_DIR, id); }
function keptFile(id, version) { return path.join(keptDir(id), id + '@' + version + '.tgz'); }
function keptVersions(id) {
    var out = [];
    try {
        fs.readdirSync(keptDir(id)).forEach(function (n) {
            var m = /^(.+)@(\d+\.\d+\.\d+)\.tgz$/.exec(n);
            if (m && m[1] === id) out.push(m[2]);
        });
    } catch (e) { /* none kept */ }
    return out.sort(semverCmp);
}
/* The newest kept package older than version, { version, file }, or null. */
function keptPrevious(id, version) {
    var older = keptVersions(id).filter(function (v) { return semverCmp(v, version) < 0; });
    return older.length ? { version: older[older.length - 1], file: keptFile(id, older[older.length - 1]) } : null;
}
/* Before an update: the installed version's package in preinstalled_apps,
 * kept unless it is already. */
function keepInstalledPackage(id) {
    var app = installedApp(id);
    if (!app || fs.existsSync(keptFile(id, app.version))) return;
    var p = path.join(preinstalledDir(), id + '@' + app.version + '.tgz');
    if (!fs.existsSync(p)) return;
    try { mkdirp(keptDir(id), 0o700); copyFileMode(p, keptFile(id, app.version), 0o600); }
    catch (e) { warn(id + ' ' + app.version + "'s package is not kept: " + e.message); }
}
/* After an install: its package kept, with the newest older one; others go. */
function keepPackage(a) {
    try {
        mkdirp(keptDir(a.id), 0o700);
        copyFileMode(a.file, keptFile(a.id, a.version), 0o600);
        var prev = keptPrevious(a.id, a.version);
        keptVersions(a.id).forEach(function (v) {
            if (v !== a.version && !(prev && v === prev.version)) rmrf(keptFile(a.id, v));
        });
    } catch (e) { warn(a.id + ' ' + a.version + "'s package is not kept: " + e.message); }
}
/* rollback <app>: uninstall, then install the newest kept older package.
 * The app's data folder is carried over to the new install's home. When
 * that install fails, the version that was there is installed again from
 * its kept package. */
function rollbackAppCmd(id) {
    if (isId8()) throw refuse(id + ': apps go back to an earlier version on iDrive 7 only');
    var app = installedApp(id);
    if (!app) throw refuse(id + ': not installed');
    guardRefuse('an app rollback');
    var prev = keptPrevious(id, app.version), cur = keptFile(id, app.version);
    if (!prev) throw refuse(id + ' ' + app.version + ': no earlier version is kept to roll back to');
    say('rolling back ' + id + ' ' + app.version + ' -> ' + prev.version);
    var err = reinstallApp(app, prev.file, cur, prev.version);
    if (err) throw fail(id + ': the rollback to ' + prev.version + ' failed: ' + err.message);
    say(id + ' rolled back to ' + prev.version);
    return 0;
}
function cmdRestore(args) {
    var name = args.positional[0] || 'stock';
    var dir = path.join(BACKUPS_DIR, name);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw refuse('no backup named ' + name);
    guardRefuse('a restore');
    var data = readJson(path.join(dir, 'manifest.json')), state = loadState();
    preflightRestore(name, dir, data);
    confirmYes(args, 'restore from ' + name + ' and remove components it shows as absent');
    var paths = data.entries.map(function (e) { return e.path; }).concat(fallbackTouched());
    installedTools().forEach(function (t) { paths = paths.concat(toolTouched(t.component)); });
    installedApps().forEach(function (app) { paths.push(appEntryFile(app.id)); });
    /* the limits drop-ins follow the tools as the backup has them */
    paths = paths.concat(limitsPresent().map(limitsPath));
    data.entries.forEach(function (e) {
        if (path.dirname(e.path) === CFG.systemd && /\.service$/.test(e.path)) paths.push(limitsPath(path.basename(e.path)));
    });
    dropStaleBind();
    /* a backup holding main.js itself is restored, and the state before it
     * snapshotted, with the fallback copy unbound; it is bound again below */
    var unbound = binds() && bindMounted(mainJs()) &&
        data.entries.some(function (e) { return e.path === mainJs() && e.kind === 'file'; });
    if (unbound) runOk(CFG.umount, [mainJs()]);
    var backup;
    try { backup = takeSnapshot('restore', paths); }
    catch (e) { if (unbound) bindCopy(); throw e; }
    var appsBefore = installedApps().map(function (a) { return a.id; });
    try {
        var fbWas = fallbackState();
        var privacyCurrent = path.join(CFG.varOpt, 'app-privacy', 'current'), reverted = false;
        if (data.entries.some(function (e) { return e.path === privacyCurrent && e.kind === 'absent'; }) &&
            lstatOrNull(privacyCurrent)) {
            reverted = privacyRevert();
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
        var limits = limitsPlan(installedTools(), null);
        if (limits.ops.length) {
            rootfsWindow(limits.ops);
            runOk(CFG.systemctl, ['daemon-reload']);
        }
        if (fbWas.unit_present || fallbackPresent()) settleFallback();
        pruneCreatedDirs(state);
        var removed = appsBefore.filter(function (id) { return !installedApp(id); });
        /* removed as an uninstall removes them, once its bounce is done or
         * stopped: no record, no kept package, no data set aside */
        var finish = function () {
            removed.forEach(function (id) { forgetApp(state, id); });
            if (!lstatOrNull(privacyCurrent)) {
                state.pending_reboot = state.pending_reboot.filter(function (p) { return p.id !== 'app-privacy'; });
            }
            saveState(state);
        };
        onGuardStop(finish, function () {
            if (removed.length) bounceManager();
            else if (reverted) privacyReverted();
        });
        if (removed.length) say('apps removed: ' + removed.join(', ') + ' (manager-side records are not removed)');
        finish();
    } catch (e) {
        if (e.code !== 2) {
            process.stderr.write('restore failed, rolling back from ' + backup + '\n');
            try { restoreSnapshot(backup); settleFallback(); } catch (e2) { process.stderr.write('rollback failed: ' + e2.message + '\n'); }
        } else if (unbound && !bindMounted(mainJs())) {
            bindCopy();
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
    preflightFirmware(name, data);
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
        var lost = recmgrNamesOf(t.component).filter(function (n) {
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
/* A backup holds the system files (/etc's restart lists, units, main.js)
 * of the firmware it was taken on; a firmware update replaces them. A
 * restore that would write system files is refused unless the backup's
 * manifest records the firmware the unit runs now. A backup without that
 * record counts as another firmware's: it may be older than the last
 * firmware update. */
function preflightFirmware(name, data) {
    var now = unitInfo().firmware, recorded = Object.prototype.hasOwnProperty.call(data, 'firmware');
    if (recorded && data.firmware === now) return;
    var writes = data.entries.filter(function (e) {
        return e.kind !== 'record' && e.kind !== 'other' && systemPath(e.path) && !entryMatches(e);
    }).map(function (e) { return e.path; });
    if (!writes.length) return;
    throw refuse('restoring ' + name + ': ' + (recorded ? 'it was taken on firmware ' + (data.firmware || '(unknown)') :
        'it does not record the firmware it was taken on') + ' and this head unit runs ' + (now || '(unknown)') +
        '; it would write system files of that firmware (' + writes.slice(0, 3).join(', ') +
        (writes.length > 3 ? ' and ' + (writes.length - 3) + ' more' : '') + '). ' +
        'To remove the Store setup, run the installer\'s uninstall');
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
    if (sub === 'migrate' && isId8()) throw refuse('fallback migrate is for iDrive 7');
    if (sub === 'migrate') guardRefuse('the migration');
    if (sub === 'on') { fallbackOn(state); saveState(state); return 0; }
    if (sub === 'off') { fallbackOff(state, {}); saveState(state); return 0; }
    if (sub === 'migrate') { if (fallbackMigrate(state)) saveState(state); return 0; }
    throw refuse('fallback needs on, off, status or migrate');
}
var HELP = [
    'mgu-deploy ' + VERSION,
    'usage: mgu-deploy.sh <command> ...',
    '  check [--artifact <file>...]     read-only checks; exits 2 on a hard problem',
    '  install [--artifact <file>...] [--skip-older] [--leave <id>...] [--yes]',
    '                                    install tools/apps (default: ./artifacts/*.tgz)',
    '  status [--json]                  installed components and pending reboots',
    '  status --read-only [--json]      the same, its upkeep left undone: changes nothing',
    '  relay [<id>...] --yes            lay a stale tool\'s files again from the copy kept here, without its install step',
    '  setup <id> --yes                 a tool laid again from the copy kept here, its install step included',
    '  uninstall <id> [--yes]           remove one tool or app',
    '  remove-all [--json]              what the Store setup put on this unit',
    '  remove-all --yes                 remove all of it, this tool last',
    '  rollback <id> [--yes]            a tool back to its other kept version, an app to its kept older package',
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
    '  relist                           iDrive 8: list our das-listed apps in custom_apps.json (at boot, before MainApp)',
    '  verify                           check the tools updated for this start; roll back one that does not work (at boot)',
    '  remove-unused                    remove the files tools handed over that no process runs (at boot)',
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
        else if (argv[i] === '--other-source') out.otherSource = true;
        else if (argv[i] === '--yes') out.yes = true;
        else if (argv[i] === '--remove') out.remove = argv[++i] || '';
        else if (argv[i] === '--list') out.list = true;
        else if (argv[i] === '--read-only') out.readOnly = true;
        else if (argv[i] === '--leave') (out.leave = out.leave || []).push(argv[++i]);
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
    var rootOnly = ['install', 'relay', 'setup', 'uninstall', 'remove-all', 'rollback', 'restore', 'fallback', 'updater-token', 'updater-sources', 'apply-pending',
        'appmanager', 'verify', 'remove-unused']
        .indexOf(args.command) >= 0;
    try {
        if (!FAKE && typeof process.getuid === 'function' && process.getuid() !== 0 && rootOnly) {
            throw refuse('run as root');
        }
        if (rootOnly && !(args.command === 'fallback' && args.positional[0] === 'status') &&
            !(args.command === 'appmanager' && !args.positional[0]) && !(args.command === 'remove-all' && !args.yes)) {
            acquireLock(); locked = true;
            try { cleanStale(); } catch (e) { warn('could not remove a killed run\'s files: ' + e.message); }
            var off = guardWhy();
            if (off) guardTrip(off);
            try { var st0 = loadState(); if (settleStashes(st0)) saveState(st0); }
            catch (e) { warn('the data folders set aside were not looked at: ' + e.message); }
        }
        if (args.command === 'help' || args.command === '--help') { say(HELP); return 0; }
        if (args.command === 'check') return cmdCheck(args);
        if (args.command === 'install') return cmdInstall(args);
        if (args.command === 'status') { statusReadOnly = !!args.readOnly; syncMgrHome(); syncGuard(); syncStashes(); syncId7Parts(); return cmdStatus(args, syncBootLists(), syncLiveId8(), syncLimits(), syncListingId8()); }
        if (args.command === 'relist') {
            if (!FAKE && typeof process.getuid === 'function' && process.getuid() !== 0) throw refuse('run as root');
            return cmdRelist();
        }
        if (args.command === 'uninstall') return cmdUninstall(args);
        if (args.command === 'relay') return cmdRelay(args);
        if (args.command === 'setup') return cmdSetup(args);
        if (args.command === 'remove-all') return cmdRemoveAll(args);
        if (args.command === 'rollback') return cmdRollback(args);
        if (args.command === 'restore') return cmdRestore(args);
        if (args.command === 'backups') return cmdBackups();
        if (args.command === 'fallback') return cmdFallback(args);
        if (args.command === 'updater-token') return cmdUpdaterToken(args);
        if (args.command === 'updater-sources') return cmdUpdaterSources();
        if (args.command === 'sdk-donor') return cmdSdkDonor(args);
        if (args.command === 'apply-pending') return cmdApplyPending();
        if (args.command === 'verify') return cmdVerify();
        if (args.command === 'remove-unused') return cmdRemoveUnused();
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
