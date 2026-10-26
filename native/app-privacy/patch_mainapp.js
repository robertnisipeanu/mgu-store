#!/usr/bin/env node
'use strict';
/*
 * Keeps local-only apps out of oap-mainapp's off-car reporting.
 *
 * oap-mainapp (the Online Apps Platform manager) reports the installed-app
 * inventory and per-app events to BMW's backend and queries BMW's app
 * repository by app name. This tool patches its two bundles so that every
 * such path skips local-only apps; genuine backend-delivered apps are
 * reported exactly as before.
 *
 * An app is local-only when its installed package.json carries
 * "mguLocalOnly": true (stamped by this repository's packaging, see
 * stampPackage), or when its appId is in the optional override list
 * OVERRIDE_FILE. An app MainApp has not registered yet (one it is about
 * to install) is local-only when its package in PREINSTALLED_DIR carries
 * the marker. The patched bundles decide at runtime, per app.
 *
 * Runs on the head unit as root with its Node 8; no dependencies.
 *
 *   patch_mainapp.js --version
 *   patch_mainapp.js check  [--json] [--main PATH] [--appmanagement PATH]
 *   patch_mainapp.js apply  [--json] [--main PATH] [--appmanagement PATH]
 *   patch_mainapp.js revert [--json] [--main PATH] [--appmanagement PATH]
 *   patch_mainapp.js boot
 *   patch_mainapp.js check-apps APPS_DIR [APPS_DIR ...]
 *
 * A bundle carrying an earlier version's edits (EARLIER_PATCH_SETS) is
 * unpatched for this version: apply replaces those edits with this
 * version's, and revert removes them.
 *
 * check exits 0 patched, 1 unpatched, 2 mismatch. apply and revert exit 0
 * when the files end in the requested state (changed or not), 2 when they
 * refuse (mismatch; nothing written) and 1 on an error while writing.
 * boot is apply for the boot unit and always exits 0. With --json the last
 * stdout line is one JSON object: {version, command, state, changed,
 * restartNeeded, files}; restartNeeded is true while a running MainApp
 * started before the bundles were last written.
 */
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.2.2';
const MARKER_KEY = 'mguLocalOnly';
const OAP_ROOT = '/var/opt/public/oap/';
const OVERRIDE_FILE = OAP_ROOT + 'oap_12201/data/local-only-apps.json';
// MainApp's localPackageSource: the packages it installs from offline.
const PREINSTALLED_DIR = '/usr/lib/oap-mainapp/preinstalled_apps/';
const DEFAULT_PATHS = {
    main: '/usr/lib/oap-mainapp/src/main.js',
    appmanagement: '/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js'
};

// Runs inside oap-mainapp (uid 12201), which owns its registry and every
// app folder. A registered app is decided by its installed package.json;
// its registry entry names its uid. An app with no registry entry is one
// MainApp is installing (or has not installed): it is decided by its
// packages in PREINSTALLED_DIR, named as MainApp names them
// (<appId>@<version>.tgz or <appId>-<version>.tgz), whose package.json
// (flat or under package/) carries the marker. Each package is read once
// per size and mtime. Any read or parse failure means "not local-only", so
// an unmarked app is reported as before.
const HELPER_JS =
    'function isLocalOnlyApp(appId){' +
    'var fs=require("fs"),root=' + JSON.stringify(OAP_ROOT) + ',entry=null;' +
    'try{var listed=JSON.parse(fs.readFileSync(' + JSON.stringify(OVERRIDE_FILE) +
    ',"utf8"));if(Array.isArray(listed)&&listed.indexOf(appId)>=0)return!0}catch(e){}' +
    'if(typeof appId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appId))return!1;' +
    'try{entry=fs.readFileSync(root+"oap_12201/data/apps/"+appId+".json","utf8")}' +
    'catch(e){if(e.code!=="ENOENT")return!1}' +
    'if(entry!==null){try{var uid=JSON.parse(entry).userId;' +
    'if(typeof uid!=="number"||uid%1!==0)return!1;' +
    'return JSON.parse(fs.readFileSync(root+"oap_"+uid+"/source/package.json","utf8"))' +
    '.' + MARKER_KEY + '===!0}catch(e){return!1}}' +
    'var dir=' + JSON.stringify(PREINSTALLED_DIR) + ',' +
    'read=isLocalOnlyApp.read||(isLocalOnlyApp.read={});' +
    'try{return fs.readdirSync(dir).some(function(file){' +
    'var m=/^(.+)[@-](\\d+\\..+)\\.tgz$/.exec(file);if(!m||m[1]!==appId)return!1;' +
    'var st=fs.statSync(dir+file),key=file+":"+st.size+":"+st.mtime.getTime();' +
    'if(!(key in read))read[key]=packageMarked(dir+file);return read[key]})}catch(e){return!1}' +
    'function packageMarked(file){var t,o=0;' +
    'try{t=require("zlib").gunzipSync(fs.readFileSync(file));' +
    'while(o+512<=t.length&&t[o]!==0){' +
    'var name=field(o,100).replace(/^\\.\\//,""),size=parseInt(field(o+124,12).trim(),8)||0;' +
    'if(name==="package.json"||name==="package/package.json")' +
    'return JSON.parse(t.toString("utf8",o+512,o+512+size)).' + MARKER_KEY + '===!0;' +
    'o+=512+Math.ceil(size/512)*512}}catch(e){}return!1;' +
    'function field(at,len){var s=t.toString("latin1",at,at+len),' +
    'end=s.indexOf(String.fromCharCode(0));return end<0?s:s.slice(0,end)}}}';

// The predicate as 1.0.0 and 1.1.0 shipped it: registered apps only.
const HELPER_JS_1_1_0 =
    'function isLocalOnlyApp(appId){' +
    'var fs=require("fs"),root=' + JSON.stringify(OAP_ROOT) + ';' +
    'try{var listed=JSON.parse(fs.readFileSync(' + JSON.stringify(OVERRIDE_FILE) +
    ',"utf8"));if(Array.isArray(listed)&&listed.indexOf(appId)>=0)return!0}catch(e){}' +
    'try{if(typeof appId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appId))return!1;' +
    'var uid=JSON.parse(fs.readFileSync(root+"oap_12201/data/apps/"+appId+".json","utf8")).userId;' +
    'if(typeof uid!=="number"||uid%1!==0)return!1;' +
    'return JSON.parse(fs.readFileSync(root+"oap_"+uid+"/source/package.json","utf8"))' +
    '.' + MARKER_KEY + '===!0}catch(e){}return!1}';

// Firmware fingerprints the anchors were derived from (oap-mainapp
// 8.3.2-pr-847.1, HU software P18_23w44.2-1-3). A mismatch is a note; the
// per-anchor occurrence checks decide whether patching is safe.
const KNOWN_SHA256 = {
    main: '7981d717124b927aa9ebd9bf95c29238f7e475fb5770d52e60e9a866efa046ca',
    appmanagement: '73a4645586d4e1e67d2d477e6276207134246dfc5dfaa555f64644197d9fdc71'
};

function helperInjection(anchor) {
    return [anchor, HELPER_JS + anchor, 1];
}

/* An edit that inserts `insert` between the stock text `before` and
 * `after`, as [anchor, replacement, expected anchor occurrences]. Each
 * anchor is the shortest readable stock text that pins its insertion point
 * in the reference bundles and names the stock bindings the inserted code
 * assigns or reads beyond the function's appId. */
function ins(before, insert, after, n) {
    return [before + after, before + insert + after, n];
}

const KEEP_APP = '.filter(app=>!isLocalOnlyApp(app.getAppId()))';
const KEEP_APP_ID = '.filter(appId=>!isLocalOnlyApp(appId))';

// Each patch: [anchor, replacement, expected anchor occurrences].
const MAIN_PATCHES = [
    // Predicate, one copy per bundle module that uses it.
    helperInjection('var AppManagementFfProviderImplOptions;'),
    helperInjection('class AppManagementController{'),
    helperInjection('class CorruptAppsHandler{'),
    helperInjection('class AppsAutoupdater{'),
    helperInjection('class MainApp{'),
    helperInjection('class DiagOapProvider{'),
    // Backend inventory (AppManagement_ff.getAllInstalledApps) and the
    // backend-triggered update of every app (updateAllApps).
    ins('installedApps=this._appRegistry.getAll()', KEEP_APP, ';', 1),
    ins('getAllAppIds()', KEEP_APP_ID, ',resultArgs=', 1),
    // Update-availability sweep against the app repository.
    ins('this.appRegistry.getAll()', KEEP_APP, ',app=>{const appId', 1),
    // Platform analytics APP_INSTALL events, success and failure.
    ins('appId&&', '!isLocalOnlyApp(appId)&&', 'AnalyticsServiceBuilders_1', 2),
    // Platform analytics APP_CRASH events and the corrupt-app report.
    ins('Corruption:0});', 'isLocalOnlyApp(appId)||', 'buildAnalyticsService()', 1),
    ins('()=>', 'isLocalOnlyApp(appId)?Promise.resolve():', 'this._backendTransport.reportCorruptApp(appId,version', 1),
    // Periodic autonomous update of every app, and the user-triggered
    // update of every app.
    ins('!appsUpdated.includes(entry)', '&&!isLocalOnlyApp(entry)', ')', 1),
    ins('getAllAppIds()', KEEP_APP_ID, ';return logger.info(`${logPrefix} Trying', 1),
    // Diagnostic readout (DiagOap StatusOap).
    ins('getAllAppIds())', KEEP_APP_ID, ';', 2),
    ins('data){const logPrefix=`${this.CLASS_NAME}::persistCrashedStartingRunning`;',
        'if(isLocalOnlyApp(data.name))return Promise.resolve();', '', 1),
    ins('for(const entry of entries', '.filter(_e=>!isLocalOnlyApp(_e.name))', ')', 1),
    ins('entryValue=entries', '.filter(_e=>!isLocalOnlyApp(_e.appId))', '.map(', 1)
];

const APPMANAGEMENT_PATCHES = [
    helperInjection('class AppManager{'),
    helperInjection('class NpmPackageManager{'),
    // Repository version query: local-only apps resolve from ./preinstalled.
    ins('logPrefix),', 'isLocalOnlyApp(appId)?' +
        'Promise.reject(new OAPError(`${logPrefix} ${appId} is local-only; ' +
        'the app repository is not queried.`,"LOCAL_ONLY_APP")):', 'this._npmClient.view(appId)', 1),
    // Package download: local-only apps never use the repository.
    ins('ignoreNpmRegistry=!1){const logPrefix="NpmPackageManager::download";',
        'isLocalOnlyApp(appId)&&(ignoreNpmRegistry=!0);', '', 1),
    // Corrupt-app report on package verification failure.
    ins('vin=>{', 'isLocalOnlyApp(appId)||', 'this._backendTransport.reportCorruptApp(', 1)
];

const PATCH_SETS = { main: MAIN_PATCHES, appmanagement: APPMANAGEMENT_PATCHES };

// Patch sets of earlier releases whose edits differ from PATCH_SETS, as
// { version, main, appmanagement }, newest first. A release that changes the
// text an edit writes or HELPER_JS moves the outgoing sets here under the
// last version that shipped them; an anchor that pins the same insertion
// point needs no entry (tests: "the patch set is recorded", and the
// reference firmware case). 1.1.0 (and 1.0.0) differ from this release in
// the helper only.
function withHelper(patches, helper) {
    return patches.map((p) => [p[0], p[1].split(HELPER_JS).join(helper), p[2]]);
}
const EARLIER_PATCH_SETS = [
    { version: '1.1.0', main: withHelper(MAIN_PATCHES, HELPER_JS_1_1_0),
        appmanagement: withHelper(APPMANAGEMENT_PATCHES, HELPER_JS_1_1_0) }
];

const PREDICATE = 'isLocalOnlyApp';
const HELPER_NAME = 'function ' + PREDICATE + '(';

function count(text, sub) {
    return text.split(sub).length - 1;
}

function replaceAll(text, from, to) {
    return text.split(from).join(to);
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function short(anchor) {
    return JSON.stringify(anchor.slice(0, 60) + '...');
}

/* 'patched', 'unpatched', or a list of problems. Stock bundles never name
 * the predicate: patched means every occurrence of it is one of these
 * edits, unpatched means there is none. */
function classify(text, patches) {
    const helpersExpected = patches.filter((p) => p[1].indexOf(HELPER_NAME) === 0)
        .reduce((n, p) => n + p[2], 0);
    const helpers = count(text, HELPER_NAME);
    const problems = [];
    if (helpers === helpersExpected) {
        patches.forEach((p) => {
            const n = count(text, p[1]);
            if (n !== p[2]) {
                problems.push('replacement for ' + short(p[0]) + ': ' + n +
                    ' occurrence(s), expected ' + p[2]);
            }
        });
        const stray = problems.length ? 0 : count(removePatches(text, patches), PREDICATE);
        if (stray) {
            problems.push(stray + ' occurrence(s) of ' + PREDICATE + ' outside these edits');
        }
        return problems.length ? problems : 'patched';
    }
    if (helpers === 0) {
        patches.forEach((p) => {
            const n = count(text, p[0]);
            if (n !== p[2]) {
                problems.push('anchor ' + short(p[0]) + ': ' + n +
                    ' occurrence(s), expected ' + p[2]);
            }
        });
        const stray = count(text, PREDICATE);
        if (stray) {
            problems.push(stray + ' occurrence(s) of ' + PREDICATE + ' without its helper');
        }
        return problems.length ? problems : 'unpatched';
    }
    return ['helper defined ' + helpers + ' time(s), expected 0 or ' + helpersExpected];
}

function applyPatches(text, patches) {
    patches.forEach((p) => {
        text = replaceAll(text, p[0], p[1]);
    });
    return text;
}

/* Removes exactly this tool's edits, leaving any other change to the file
 * in place; the result must patch back to the input byte for byte. */
function removePatches(text, patches) {
    for (let i = patches.length - 1; i >= 0; i -= 1) {
        text = replaceAll(text, patches[i][1], patches[i][0]);
    }
    return text;
}

/* One bundle's state for sets = { current, earlier }: { state } for the
 * current set; for an earlier release's edits { state: 'unpatched',
 * patchedBy, base } with base the bundle without them; else { problems }.
 * Except for revert, base must take the current set's edits. */
function examine(text, kind, sets, command) {
    const current = sets.current[kind];
    const state = classify(text, current);
    if (!Array.isArray(state)) {
        return { state };
    }
    for (let i = 0; i < sets.earlier.length; i += 1) {
        const patches = sets.earlier[i][kind];
        if (classify(text, patches) !== 'patched') {
            continue;
        }
        const base = removePatches(text, patches);
        if (classify(base, patches) === 'unpatched' && applyPatches(base, patches) === text &&
                (command === 'revert' || classify(base, current) === 'unpatched')) {
            return { state: 'unpatched', patchedBy: sets.earlier[i].version, base };
        }
    }
    return { problems: state };
}

/* A file bind-mounted over the bundle path sits on another device than
 * its directory; it is written in place, the mount stays. */
function isMountedFile(file) {
    return fs.statSync(file).dev !== fs.statSync(path.dirname(file)).dev;
}

/* Writes all of data at position 0 and syncs; a short write continues
 * until every byte is written or the write throws (e.g. ENOSPC). */
function writeAll(fd, data) {
    let done = 0;
    while (done < data.length) {
        done += fs.writeSync(fd, data, done, data.length - done, done);
    }
    fs.fsyncSync(fd);
}

function writeText(file, text) {
    const data = Buffer.from(text, 'utf8');
    if (isMountedFile(file)) {
        writeInPlace(file, data);
        return;
    }
    const tmp = file + '.app-privacy.tmp';
    const st = fs.statSync(file);
    try {
        const fd = fs.openSync(tmp, 'w', st.mode & 0o7777);
        try {
            writeAll(fd, data);
        } finally {
            fs.closeSync(fd);
        }
        fs.chmodSync(tmp, st.mode & 0o7777);
        if (process.getuid() === 0) {
            fs.chownSync(tmp, st.uid, st.gid);
        }
        fs.renameSync(tmp, file);
    } catch (e) {
        try {
            fs.unlinkSync(tmp);
        } catch (ignored) {
            // no temporary file to remove
        }
        if (e.code !== 'EBUSY') {
            throw e;
        }
        writeInPlace(file, data);
    }
}

function writeInPlace(file, data) {
    const fd = fs.openSync(file, 'r+');
    try {
        fs.ftruncateSync(fd, 0);
        writeAll(fd, data);
    } finally {
        fs.closeSync(fd);
    }
}

const USER_HZ = 100;

/* Whether argv runs MainApp: node with DEFAULT_PATHS.main as its script
 * (the first argument that is not a node option), relative to cwd. */
function runsMainapp(argv, cwd) {
    if (!/(^|\/)node$/.test(argv[0])) {
        return false;
    }
    const script = argv.slice(1).filter((arg) => arg && arg[0] !== '-')[0];
    return script !== undefined && path.resolve(cwd, script) === DEFAULT_PATHS.main;
}

/* Start times (ms since the epoch) of running MainApp processes. */
function mainappStarts(procRoot) {
    const uptime = parseFloat(fs.readFileSync(path.join(procRoot, 'uptime'), 'utf8').split(' ')[0]);
    const now = Date.now();
    const starts = [];
    fs.readdirSync(procRoot).forEach((pid) => {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) {
            return;
        }
        try {
            const argv = fs.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8').split('\0');
            if (!runsMainapp(argv, fs.readlinkSync(path.join(procRoot, pid, 'cwd')))) {
                return;
            }
            const stat = fs.readFileSync(path.join(procRoot, pid, 'stat'), 'utf8');
            const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
            starts.push(now - (uptime - ticks / USER_HZ) * 1000);
        } catch (e) {
            // exited while it was read, or not readable by this user
        }
    });
    return starts;
}

/* Whether a running MainApp started before a bundle was last written, so
 * it still runs the older code: bounce it. */
function restartNeeded(files, procRoot) {
    let starts;
    try {
        starts = mainappStarts(procRoot);
    } catch (e) {
        return false;
    }
    let newest = 0;
    files.forEach((f) => {
        try {
            newest = Math.max(newest, fs.statSync(f).mtimeMs);
        } catch (e) {
            // reported as a problem by the caller
        }
    });
    return starts.some((s) => s < newest);
}

/* Whether writing file needs / remounted read-write: a rename in a
 * directory of the read-only root filesystem. */
function needsRootRemount(file) {
    if (isMountedFile(file)) {
        return false;
    }
    try {
        fs.accessSync(path.dirname(file), fs.constants.W_OK);
        return false;
    } catch (e) {
        if (e.code !== 'EROFS') {
            throw e;
        }
    }
    if (fs.statSync(path.dirname(file)).dev !== fs.statSync('/').dev) {
        throw new Error(path.dirname(file) + ' is on a read-only filesystem other than /');
    }
    return true;
}

function remountRoot(mode) {
    if (mode === 'ro') {
        childProcess.execFileSync('sync');
    }
    childProcess.execFileSync('mount', ['-o', 'remount,' + mode, '/'], { stdio: 'pipe' });
}

function overallState(files) {
    if (files.some((f) => f.problems.length)) {
        return 'mismatch';
    }
    return files.every((f) => f.state === 'patched') ? 'patched' : 'unpatched';
}

/* Prepares every file before writing any: a problem in one file leaves
 * both untouched. */
function runCommand(command, paths, log, sets) {
    const jobs = Object.keys(paths).map((kind) => {
        const file = paths[kind];
        const patches = sets.current[kind];
        const job = { kind, path: file, sha256: null, reference: false,
            state: null, patchedBy: null, problems: [], target: null };
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (e) {
            job.problems.push('cannot read: ' + e.message);
            return job;
        }
        job.sha256 = sha256(text);
        job.reference = job.sha256 === KNOWN_SHA256[kind];
        const found = examine(text, kind, sets, command);
        if (found.problems) {
            job.problems = found.problems;
            return job;
        }
        const state = found.state;
        job.state = state;
        job.patchedBy = found.patchedBy || null;
        if (command === 'apply' && state === 'unpatched') {
            const patched = applyPatches(found.base || text, patches);
            if (classify(patched, patches) !== 'patched') {
                job.problems.push('patched output does not verify');
            } else {
                job.target = patched;
            }
        } else if (command === 'revert' && found.base) {
            job.target = found.base;
        } else if (command === 'revert' && state === 'patched') {
            const original = removePatches(text, patches);
            if (classify(original, patches) !== 'unpatched' ||
                    applyPatches(original, patches) !== text) {
                job.problems.push('the patch cannot be removed exactly');
            } else {
                job.target = original;
            }
        }
        return job;
    });

    jobs.forEach((job) => {
        log(job.path + ' (' + job.kind + '): ' +
            (job.sha256 ? 'sha256 ' + job.sha256 +
                (job.reference ? '' : ' (not the reference fingerprint)') : 'unreadable'));
        job.problems.forEach((p) => log('  PROBLEM: ' + p));
        if (job.state) {
            log('  state: ' + job.state + (job.patchedBy ? ' (patched by ' + job.patchedBy + ')' : ''));
        }
    });

    const result = { version: VERSION, command, state: overallState(jobs), changed: false,
        files: jobs.map((j) => ({ kind: j.kind, path: j.path, sha256: j.sha256,
            reference: j.reference, state: j.state, patchedBy: j.patchedBy, problems: j.problems })) };
    if (command === 'check') {
        return { result, code: { patched: 0, unpatched: 1, mismatch: 2 }[result.state] };
    }
    if (result.state === 'mismatch') {
        log('refused; nothing written');
        return { result, code: 2 };
    }
    const writes = jobs.filter((j) => j.target !== null);
    if (!writes.length) {
        log('already ' + (command === 'apply' ? 'patched' : 'unpatched') + '; nothing written');
        return { result, code: 0 };
    }
    let remounted = false;
    try {
        if (writes.some((j) => needsRootRemount(j.path))) {
            remountRoot('rw');
            remounted = true;
        }
        writes.forEach((j) => {
            writeText(j.path, j.target);
            j.sha256 = sha256(j.target);
            j.state = command === 'apply' ? 'patched' : 'unpatched';
            j.patchedBy = null;
            result.changed = true;
            log('  ' + (command === 'apply' ? 'patched ' : 'reverted ') + j.path +
                '; sha256 ' + j.sha256);
        });
    } catch (e) {
        log('ERROR: ' + e.message);
        result.error = e.message;
        return { result: refresh(result, jobs), code: 1 };
    } finally {
        if (remounted) {
            try {
                remountRoot('ro');
            } catch (e) {
                log('ERROR: / did not return to read-only: ' + e.message);
                result.error = (result.error ? result.error + '; ' : '') +
                    '/ did not return to read-only';
            }
        }
    }
    if (result.error) {
        return { result: refresh(result, jobs), code: 1 };
    }
    return { result: refresh(result, jobs), code: 0 };
}

/* runCommand, plus whether MainApp must be bounced to load the files. */
function run(command, paths, log, procRoot, sets) {
    const r = runCommand(command, paths, log,
        sets || { current: PATCH_SETS, earlier: EARLIER_PATCH_SETS });
    r.result.restartNeeded = restartNeeded(r.result.files.map((f) => f.path), procRoot || '/proc');
    if (r.result.restartNeeded) {
        log('MainApp started before the bundles were last written; bounce its node child');
    }
    return r;
}

function refresh(result, jobs) {
    jobs.forEach((j, i) => {
        result.files[i].sha256 = j.sha256;
        result.files[i].reference = j.sha256 === KNOWN_SHA256[j.kind];
        result.files[i].state = j.state;
        result.files[i].patchedBy = j.patchedBy;
    });
    result.state = overallState(jobs);
    return result;
}

/* Build side: every app this repository packs carries the marker in its
 * package.json. Adds it to the staged tree's package.json when missing. */
function stampPackage(pkgDir) {
    const file = path.join(pkgDir, 'package.json');
    const raw = fs.readFileSync(file, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg[MARKER_KEY] === true) {
        return false;
    }
    pkg[MARKER_KEY] = true;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    return true;
}

const ANALYTICS_MARKERS = ['analytics', 'countly'];

function walkFiles(dir, out) {
    fs.readdirSync(dir).sort().forEach((name) => {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) {
            walkFiles(p, out);
        } else {
            out.push(p);
        }
    });
    return out;
}

/* Staged app trees carry the marker, no SDK analytics and no analytics key. */
function checkApps(appsDirs, log) {
    let ok = true;
    let checked = 0;
    appsDirs.forEach((appsDir) => {
        fs.readdirSync(appsDir).sort().forEach((app) => {
            const appDir = path.join(appsDir, app);
            if (!fs.statSync(appDir).isDirectory()) {
                return;
            }
            fs.readdirSync(appDir).sort().forEach((name) => {
                const staged = path.join(appDir, name);
                if (name.indexOf('@') < 0 || !fs.statSync(staged).isDirectory()) {
                    return;
                }
                checked += 1;
                walkFiles(staged, []).filter((f) => f.endsWith('.js')).forEach((script) => {
                    const text = fs.readFileSync(script, 'utf8').toLowerCase();
                    ANALYTICS_MARKERS.forEach((marker) => {
                        if (text.indexOf(marker) >= 0) {
                            ok = false;
                            log(script + ': contains ' + JSON.stringify(marker));
                        }
                    });
                });
                const packageJson = path.join(staged, 'package.json');
                if (!fs.existsSync(packageJson)) {
                    ok = false;
                    log(staged + ': missing package.json');
                    return;
                }
                const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
                if ('oapAnalytics' in pkg) {
                    ok = false;
                    log(packageJson + ': declares oapAnalytics');
                }
                if (pkg[MARKER_KEY] !== true) {
                    ok = false;
                    log(packageJson + ': lacks "' + MARKER_KEY + '": true');
                }
            });
        });
    });
    log('checked ' + checked + ' staged app(s)');
    if (checked === 0) {
        log('no staged apps found under: ' + appsDirs.join(', '));
        return 1;
    }
    return ok ? 0 : 1;
}

function usage() {
    return 'usage: patch_mainapp.js --version | check|apply|revert [--json] ' +
        '[--main PATH] [--appmanagement PATH] | boot | check-apps APPS_DIR...';
}

function main(argv) {
    const out = (line) => process.stdout.write(line + '\n');
    if (argv[0] === '--version') {
        out('app-privacy ' + VERSION);
        return 0;
    }
    const command = argv[0];
    if (command === 'check-apps') {
        if (argv.length < 2) {
            out(usage());
            return 2;
        }
        return checkApps(argv.slice(1), out);
    }
    if (['check', 'apply', 'revert', 'boot'].indexOf(command) < 0) {
        out(usage());
        return 2;
    }
    const paths = Object.assign({}, DEFAULT_PATHS);
    let json = false;
    for (let i = 1; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--json') {
            json = true;
        } else if ((arg === '--main' || arg === '--appmanagement') && i + 1 < argv.length) {
            paths[arg.slice(2)] = argv[i + 1];
            i += 1;
        } else {
            out(usage());
            return 2;
        }
    }
    if (command === 'boot') {
        let r;
        try {
            r = run('apply', paths, (line) => out('app-privacy: ' + line));
            out('app-privacy: ' + r.result.state + (r.result.changed ? ' (applied)' : ''));
        } catch (e) {
            out('app-privacy: ERROR: ' + e.message);
        }
        return 0;
    }
    const r = run(command, paths, json ? () => {} : out);
    if (json) {
        out(JSON.stringify(r.result));
    }
    return r.code;
}

module.exports = {
    VERSION, MARKER_KEY, OVERRIDE_FILE, PREINSTALLED_DIR, HELPER_JS, PATCH_SETS, EARLIER_PATCH_SETS, KNOWN_SHA256,
    classify, applyPatches, removePatches, run, stampPackage, checkApps, main
};

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
