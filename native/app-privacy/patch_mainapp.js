#!/usr/bin/env node
'use strict';
/*
 * Keeps local-only apps out of oap-mainapp's off-car reporting and its
 * crash recovery.
 *
 * oap-mainapp (the Online Apps Platform manager) reports the installed-app
 * inventory and per-app events to BMW's backend and queries BMW's app
 * repository by app name. This tool patches its two bundles so that every
 * such path skips local-only apps; genuine backend-delivered apps are
 * reported exactly as before. A crashed local-only app is only restarted
 * (CRASH_GATE_JS), never wiped, reinstalled or disabled. iDrive 7 runs
 * /usr/lib/oap-mainapp, iDrive 8 MainApp-21 (/usr/lib/oap-mainapp21), each
 * with its own edits (UNITS); the unit is the one the kernel command line
 * names (unitOf). A unit's MainApp releases each have their edits; the
 * bundles take those of the release whose edits fit both of them.
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
 *   patch_mainapp.js check  [--json] [--unit ID7|ID8] [--main PATH] [--appmanagement PATH]
 *   patch_mainapp.js apply  [--json] [--unit ID7|ID8] [--main PATH] [--appmanagement PATH]
 *   patch_mainapp.js revert [--json] [--unit ID7|ID8] [--main PATH] [--appmanagement PATH]
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
 * restartNeeded, files, unit, mainapp}; restartNeeded is true while a
 * running MainApp started before the bundles were last written, and
 * mainapp names the MainApp release whose edits the bundles take (null on
 * a mismatch).
 */
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.6.2';
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
function helperJs(preinstalledDir) {
    return 'function isLocalOnlyApp(appId){' +
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
        'var dir=' + JSON.stringify(preinstalledDir) + ',' +
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
}
const HELPER_JS = helperJs(PREINSTALLED_DIR);

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

function helperInjection(anchor, helper) {
    return [anchor, (helper || HELPER_JS) + anchor, 1];
}

/* An edit that inserts `insert` between the stock text `before` and
 * `after`, as [anchor, replacement, expected anchor occurrences]. Each
 * anchor is the shortest readable stock text that pins its insertion point
 * in the reference bundles and names the stock bindings the inserted code
 * assigns or reads beyond the function's appId. */
function ins(before, insert, after, n) {
    return [before + after, before + insert + after, n];
}

// MainApp's CorruptAppsHandler restarts a crashed app, then wipes its data,
// then uninstalls and reinstalls it, then blocks it and disables its tile.
// For a local-only app every crash takes the first step, a plain restart:
// the handler's counter stays at 0 between crashes. An app found local-only
// once stays so for that MainApp's life (its localOnlyRestarts list), so a
// failed read of its files cannot send its next crash down the ladder.
// Only restarts MainApp goes on to make count (not a death while the head
// unit shuts down; a failed restart does count): after CRASH_RESTARTS of
// them within CRASH_WINDOW_MS, the next crash leaves the app stopped,
// installed, its data kept and its tile enabled. Starting it again (its
// tile, MainApp's own start of an app it keeps running, a reboot) runs it,
// and a crash loop ends after a few starts. The gate logs through MainApp's
// logger when that binding is there, else the console.
const CRASH_RESTARTS = 5;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const CRASH_GATE_BEFORE =
    'appCorruptInfo=_.defaults(this._appIdToCorruptAppInfo[appId],{recoveryAttemptsSinceCorruption:0});';
/* giveUp: MainApp code run just before the app is left stopped. The gate
 * ends in `else `, so a local-only app skips the stock statement it
 * precedes (the APP_CRASH analytics event); after replaces that ending
 * where the gate precedes nothing to skip. */
function crashGateJs(logPrefix, giveUp, after) {
    return 'if(appCorruptInfo.localOnlyRestarts||isLocalOnlyApp(appId)){const now=Date.now(),' +
        'restarts=appCorruptInfo.localOnlyRestarts=(appCorruptInfo.localOnlyRestarts||[])' +
        '.filter(at=>now-at<' + CRASH_WINDOW_MS + ');' +
        'if(restarts.length>=' + CRASH_RESTARTS + '){' + (giveUp || '') +
        'const log=typeof logger==="object"&&logger&&typeof logger.warn==="function"?logger:console;' +
        'return log.warn(`' + logPrefix + ' ${appId} is local-only ' +
        'and was restarted ' + CRASH_RESTARTS + ' times in ' + CRASH_WINDOW_MS / 60000 + ' minutes; ' +
        'left stopped until it is started again.`),Promise.resolve()}' +
        'appCorruptInfo.recoveryAttemptsSinceCorruption=0}' + (after === undefined ? 'else ' : after);
}
const CRASH_GATE_JS = crashGateJs('CorruptAppsHandler::_tryRecoverApp');
// At the restart, after MainApp's head-unit-shutdown check.
const CRASH_COUNT_JS = 'appCorruptInfo.localOnlyRestarts&&(appCorruptInfo.recoveryAttemptsSinceCorruption=0,' +
    'appCorruptInfo.localOnlyRestarts.push(Date.now())),';
const CRASH_EDITS = [
    ins(CRASH_GATE_BEFORE, CRASH_GATE_JS, 'buildAnalyticsService()', 1),
    ins('appCorruptInfo.recoveryAttemptsSinceCorruption++,', CRASH_COUNT_JS, 'app.updateStartableCouncil(', 1)
];

const KEEP_APP = '.filter(app=>!isLocalOnlyApp(app.getAppId()))';
const KEEP_APP_ID = '.filter(appId=>!isLocalOnlyApp(appId))';
// AppManagementController.getAvailableUpdatesFromBackend's sweep.
const SWEEP_EDIT = ins('this.appRegistry.getAll()', KEEP_APP, ',app=>{const appId', 1);

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
    SWEEP_EDIT,
    // Platform analytics APP_INSTALL events, success and failure.
    ins('appId&&', '!isLocalOnlyApp(appId)&&', 'AnalyticsServiceBuilders_1', 2),
    // Crash recovery, and no APP_CRASH analytics event for local-only apps.
    CRASH_EDITS[0],
    CRASH_EDITS[1],
    // The corrupt-app report.
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
// MainApp kills CertificateManager.js, which has the head unit's
// certificate service create an app's keychain, after 35 s. A local-only
// app's gets CERT_KILL_S: the deploy tool's copy of the script waits up to
// 120 s and, when it gives up, says why on stderr, which MainApp puts in
// the install's error.
const CERT_KILL_S = 125;
function certEdit(n) {
    return ins('config.get("certificateManagerGids")),', 'isLocalOnlyApp(appId)?' + CERT_KILL_S + ':', '35)', n);
}
const APPMANAGEMENT_PATCHES_1_4_0 = APPMANAGEMENT_PATCHES.slice();
APPMANAGEMENT_PATCHES.push(certEdit(2));

const PATCH_SETS = { main: MAIN_PATCHES, appmanagement: APPMANAGEMENT_PATCHES };

// Patch sets of earlier releases whose edits differ from PATCH_SETS, as
// { version, main, appmanagement }, newest first. A release that changes the
// text an edit writes or HELPER_JS moves the outgoing sets here under the
// last version that shipped them; an anchor that pins the same insertion
// point needs no entry (tests: "the patch set is recorded", and the
// reference firmware case). 1.4.0 (and 1.3.0) differs from this release in
// the CertificateManager kill time only; 1.2.2 (and 1.2.0, 1.2.1) also in
// the crash-recovery edit; 1.1.0 (and 1.0.0) in those and the helper.
function withHelper(patches, helper) {
    return patches.map((p) => [p[0], p[1].split(HELPER_JS).join(helper), p[2]]);
}
const MAIN_PATCHES_1_2_2 = MAIN_PATCHES.filter((p) => p !== CRASH_EDITS[1]).map((p) => p === CRASH_EDITS[0] ?
    ins('Corruption:0});', 'isLocalOnlyApp(appId)||', 'buildAnalyticsService()', 1) : p);
const EARLIER_PATCH_SETS = [
    { version: '1.4.0', main: MAIN_PATCHES, appmanagement: APPMANAGEMENT_PATCHES_1_4_0 },
    { version: '1.2.2', main: MAIN_PATCHES_1_2_2, appmanagement: APPMANAGEMENT_PATCHES_1_4_0 },
    { version: '1.1.0', main: withHelper(MAIN_PATCHES_1_2_2, HELPER_JS_1_1_0),
        appmanagement: withHelper(APPMANAGEMENT_PATCHES_1_4_0, HELPER_JS_1_1_0) }
];

// oap-mainapp 8.1.1 (HU software 16.20.4). It has no platform analytics, no
// update-availability sweep and no DiagOap provider, so those edits, and the
// predicate copies only they use, have no counterpart. Its updateAllApps, its
// autonomous update of every app and its crash recovery read differently
// around the same insertion points; the crash gate precedes no analytics
// event. Its install and update share one CertificateManager call.
const KNOWN_SHA256_8_1_1 = {
    main: '23d24905391f87bd81036aba39aec16d4dd577fef5dfc6bc310db5216d18391b',
    appmanagement: '93b3df8b7dd00e5ae7529b2409d7a7afb062e6f18c2ab3c0344bb9efa06accf0'
};
const MAIN_PATCHES_8_1_1 = [
    helperInjection('class AppManagementFfProviderImpl{'),
    helperInjection('class CorruptAppsHandler{'),
    helperInjection('class AppsAutoupdater{'),
    helperInjection('class MainApp{'),
    ins('installedApps=this._appRegistry.getAll()', KEEP_APP, ';', 1),
    ins('getAllAppIds()', KEEP_APP_ID, ';const resultArgs=', 1),
    ins(CRASH_GATE_BEFORE, crashGateJs('CorruptAppsHandler::_tryRecoverApp', '', ''), 'let recoveryAction=', 1),
    CRASH_EDITS[1],
    ins('()=>', 'isLocalOnlyApp(appId)?Promise.resolve():', 'this._backendTransport.reportCorruptApp(appId,version', 1),
    ins('getAllAppIds()', KEEP_APP_ID, '.forEach(appId=>{this._appManager.update(appId,', 1),
    ins('getAllAppIds()', KEEP_APP_ID, ';return logger.info(`${logPrefix} Trying', 1)
];
const PATCH_SETS_8_1_1 = { main: MAIN_PATCHES_8_1_1, appmanagement: APPMANAGEMENT_PATCHES_1_4_0.concat([certEdit(1)]) };

// oap-mainapp 8.2.8 (a G30 LCI, issue #83). It has no update-availability
// sweep (getAvailableUpdatesFromBackend); its other edits are 8.3.2's, so
// 8.3.2's bundles fit these too and 8.3.2 is tried first. Only its main.js
// has been seen: AppManagement.js has no reference fingerprint yet (the car
// reported that it takes 8.3.2's edits).
const KNOWN_SHA256_8_2_8 = {
    main: 'c503acab2300360b4f29502b7abbf7a27b42e835666dedfa512315cd16d50bb3',
    appmanagement: null
};
const PATCH_SETS_8_2_8 = { main: MAIN_PATCHES.filter((p) => p !== SWEEP_EDIT), appmanagement: APPMANAGEMENT_PATCHES };

// MainApp-21 (iDrive 8). Its predicate decides an app MainApp-21 is
// installing by MainApp-21's own preinstalled_apps; registry, app folders
// and override list are where iDrive 7 has them.
const PREINSTALLED_DIR_21 = '/usr/lib/oap-mainapp21/preinstalled_apps/';
const HELPER_JS_21 = helperJs(PREINSTALLED_DIR_21);

// oap-mainapp 9.3.4-pr-1052.3, HU I-step 036.010.004.
const KNOWN_SHA256_21 = {
    main: 'c96c81653952fd9b24e2718cead75b18c1a1d5be7b336f6f7053ce3c23490b33',
    appmanagement: 'fb9a9b5326264bf68e39db577b6d123b5f7e657b1c8d3abf996511799c1e517a'
};

/* A NpmPackageManager method's first statement: a local-only app's
 * request is refused before it reaches the app repository. */
function refuseLocalOnly(method) {
    return 'if(params&&isLocalOnlyApp(params.packageName))return PromiseExt_1.default.reject(' +
        'new OAPError_1.default(`NpmPackageManager::' + method + ' ${params.packageName} is local-only; ' +
        'the app repository is not queried.`,"LOCAL_ONLY_APP"));';
}

const MAIN_PATCHES_21 = [
    // Predicate, one copy per bundle module that uses it.
    helperInjection('class AppManagementFfProviderImpl{', HELPER_JS_21),
    helperInjection('let AppManagementController=AppManagementController_1=class', HELPER_JS_21),
    helperInjection('let CorruptAppsHandler=class', HELPER_JS_21),
    helperInjection('let AppsAutoupdater=class', HELPER_JS_21),
    helperInjection('let MainApp=class', HELPER_JS_21),
    helperInjection('class DiagOapProvider21{', HELPER_JS_21),
    helperInjection('class NpmPackageManager{', HELPER_JS_21),
    helperInjection('let AnalyticsAppStartStopEvents=class', HELPER_JS_21),
    helperInjection('let AppReleaseNotesControl=class', HELPER_JS_21),
    // Backend inventory (AppManagement_ff.getAllInstalledApps) and the
    // backend-triggered update of every app (updateAllApps).
    ins('installedApps=this._appRegistry.getAll()', KEEP_APP, ';', 1),
    ins('getAllAppIds()', KEEP_APP_ID, ',resultArgs=', 1),
    // Update-availability sweep against the app repository.
    ins('this.appRegistry.getAll()', KEEP_APP, ',(app=>{const appId', 1),
    // Platform analytics APP_INSTALL events, success and failure.
    ins('const settings=app.getSettings();', 'isLocalOnlyApp(entry.appId)||', '(0,AnalyticsServiceBuilders_1', 1),
    ins('entry.appId&&', '!isLocalOnlyApp(entry.appId)&&', '(0,AnalyticsServiceBuilders_1', 1),
    // Crash recovery (after MainApp-21's head-unit-shutdown check), and no
    // APP_CRASH analytics event for local-only apps. A local-only app never
    // reaches MainApp-21's later rungs (the forced update, the data wipe,
    // the disable); its 48 h reset clears the stock counters only.
    // MainApp-21 holds a crashed app unstartable (NOT_IN_CORRUPT_APPS_HANDLING)
    // until its recovery ends; an app left stopped is released, so its tile
    // starts it again.
    ins('Promise.resolve();', crashGateJs('CorruptAppsHandler::tryRecoverApp',
        'app.updateStartableCouncil(StartableCouncil_1.default.NOT_IN_CORRUPT_APPS_HANDLING,!0);'),
    '(0,AnalyticsServiceBuilders_1', 1),
    ins('appCorruptInfo.recoveryAttemptsSinceCorruption++,', CRASH_COUNT_JS, 'app.updateStartableCouncil(', 1),
    // The corrupt-app report.
    ins('return ', 'isLocalOnlyApp(appId)?Promise.resolve():', 'this.backendTransport.reportCorruptApp(appId,version', 1),
    // Platform analytics APP_START and APP_STOP events.
    ins('sendStopEvent(payload){', 'if(isLocalOnlyApp(payload.appName))return;', 'const logPrefix=', 1),
    ins('sendStartEvent(payload){', 'if(isLocalOnlyApp(payload.appName))return;', 'const logPrefix=', 1),
    // Periodic autonomous update of every app, and the user-triggered
    // update of every app.
    ins('!appsUpdated.includes(entry)', '&&!isLocalOnlyApp(entry)', ')', 1),
    ins('getAllAppIds()', KEEP_APP_ID, ',reSortedList=', 1),
    // Release notes request for updated apps.
    ins('apps:updatedAppsMetadata', '.filter(metadata=>!isLocalOnlyApp(metadata.appId))', '.map(', 1),
    // App-repository version queries and package downloads (also the
    // predownload before a software update).
    ins('download(params){', refuseLocalOnly('download'), 'const logPrefix="NpmPackageManager::download";', 1),
    ins('getLatestAppVersion(params){', refuseLocalOnly('getLatestAppVersion'), 'const logPrefix=', 1),
    ins('getLatestAppVersionInfo(params){', refuseLocalOnly('getLatestAppVersionInfo'), 'const logPrefix=', 1),
    // Diagnostic readout (DiagOap StatusOap); provisioning lists our apps
    // as installable too.
    ins('_.union(this.installableApps,this.appRegistry.getAllAppIds())', KEEP_APP_ID, ';', 2),
    ins('data){const logPrefix=`${this.CLASS_NAME}::persistCrashedStartingRunning`;',
        'if(isLocalOnlyApp(data.name))return Promise.resolve();', '', 1),
    ins('for(const entry of entries', '.filter(_e=>!isLocalOnlyApp(_e.name))', ')', 1),
    ins('entryValue=entries', '.filter(_e=>!isLocalOnlyApp(_e.appId))', '.map(', 1)
];

const APPMANAGEMENT_PATCHES_21 = [
    helperInjection('class AppManager{', HELPER_JS_21),
    // Corrupt-app report on package verification failure.
    ins('vin=>{', 'isLocalOnlyApp(appId)||', 'this.backendTransport.reportCorruptApp(', 1)
];

const PATCH_SETS_21 = { main: MAIN_PATCHES_21, appmanagement: APPMANAGEMENT_PATCHES_21 };

// oap-mainapp 9.2.15-pr-867.1, an earlier iDrive 8 release. Its bundles are
// minified without parentheses around a lone arrow parameter; its crash
// recovery marks the app recovering and sends APP_CRASH first and checks
// for a head-unit shutdown further down, so the gate goes before that mark
// (a local-only app skips only the event); its corrupt-app report and
// release-notes request read differently around the same insertion points.
// Its other edits are 9.3.4's.
const KNOWN_SHA256_21_9_2_15 = {
    main: 'd5bb67a997a8c1e3f4bee9716356c2f0fa07b4788418d35d420425812aa43581',
    appmanagement: 'd73a7e7a38c21eeba2ba0402090f39b43ccdc7d0279b05773b1928a542c95a16'
};
const CRASH_GATE_BEFORE_9_2_15 = '{recoveryAttemptsSinceCorruption:0});';
const CRASH_EVENT_9_2_15 = 'appCorruptInfo.isRecovering=!0,';
const MAIN_EDITS_21_9_2_15 = {
    'this.appRegistry.getAll(),(app=>{const appId': ins('this.appRegistry.getAll()', KEEP_APP, ',app=>{const appId', 1),
    'Promise.resolve();(0,AnalyticsServiceBuilders_1': [
        CRASH_GATE_BEFORE_9_2_15 + CRASH_EVENT_9_2_15 + '(0,AnalyticsServiceBuilders_1',
        CRASH_GATE_BEFORE_9_2_15 + crashGateJs('CorruptAppsHandler::tryRecoverApp',
            'app.updateStartableCouncil(StartableCouncil_1.default.NOT_IN_CORRUPT_APPS_HANDLING,!0);', '') +
        CRASH_EVENT_9_2_15 + 'appCorruptInfo.localOnlyRestarts||(0,AnalyticsServiceBuilders_1', 1],
    'return this.backendTransport.reportCorruptApp(appId,version':
        ins('then(()=>', 'isLocalOnlyApp(appId)?Promise.resolve():', 'this.backendTransport.reportCorruptApp(appId,version', 1),
    'apps:updatedAppsMetadata.map(':
        ins('apps:metadataAboutUpdates', '.filter(metadata=>!isLocalOnlyApp(metadata.appId))', '.map(', 1)
};
const PATCH_SETS_21_9_2_15 = {
    main: MAIN_PATCHES_21.map((p) => MAIN_EDITS_21_9_2_15[p[0]] || p),
    appmanagement: APPMANAGEMENT_PATCHES_21
};

function bundlePaths(root) {
    return { main: root + '/src/main.js', appmanagement: root + '/src/AppManagement/AppManagement.js' };
}
/* Each unit's MainApp releases, as { version, sets: { current, earlier },
 * known }, the first the one problems are reported for when no release's
 * edits fit. Only 8.3.2's bundles can carry an earlier app-privacy
 * release's edits. */
const UNITS = {
    ID7: { paths: DEFAULT_PATHS, mainapps: [
        { version: '8.3.2', sets: { current: PATCH_SETS, earlier: EARLIER_PATCH_SETS }, known: KNOWN_SHA256 },
        { version: '8.2.8', sets: { current: PATCH_SETS_8_2_8, earlier: [] }, known: KNOWN_SHA256_8_2_8 },
        { version: '8.1.1', sets: { current: PATCH_SETS_8_1_1, earlier: [] }, known: KNOWN_SHA256_8_1_1 }
    ] },
    ID8: { paths: bundlePaths('/usr/lib/oap-mainapp21'), mainapps: [
        { version: '9.3.4', sets: { current: PATCH_SETS_21, earlier: [] }, known: KNOWN_SHA256_21 },
        { version: '9.2.15', sets: { current: PATCH_SETS_21_9_2_15, earlier: [] }, known: KNOWN_SHA256_21_9_2_15 }
    ] }
};

/* The head unit whose MainApp oapcontroller starts: iDrive 8's MainApp-21
 * when the kernel command line names hardware generation 21 or later
 * (hwgen=21), else iDrive 7's. */
function unitOf(cmdline) {
    const m = /(?:^|\s)hwgen=(\d+)(?:\s|$)/.exec(cmdline || '');
    return m && Number(m[1]) >= 21 ? 'ID8' : 'ID7';
}

function detectUnit() {
    try {
        return unitOf(fs.readFileSync('/proc/cmdline', 'utf8'));
    } catch (e) {
        return 'ID7';
    }
}

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

/* Whether argv runs MainApp: node with mainJs as its script (the first
 * argument that is not a node option or a module -r preloads), relative
 * to cwd. */
function runsMainapp(argv, cwd, mainJs) {
    if (!/(^|\/)node$/.test(argv[0])) {
        return false;
    }
    let script;
    for (let i = 1; i < argv.length && script === undefined; i += 1) {
        if (argv[i] === '-r' || argv[i] === '--require') {
            i += 1;
        } else if (argv[i] && argv[i][0] !== '-') {
            script = argv[i];
        }
    }
    return script !== undefined && path.resolve(cwd, script) === mainJs;
}

/* Start times (ms since the epoch) of running MainApp processes. */
function mainappStarts(procRoot, mainJs) {
    const uptime = parseFloat(fs.readFileSync(path.join(procRoot, 'uptime'), 'utf8').split(' ')[0]);
    const now = Date.now();
    const starts = [];
    fs.readdirSync(procRoot).forEach((pid) => {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) {
            return;
        }
        try {
            const argv = fs.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8').split('\0');
            if (!runsMainapp(argv, fs.readlinkSync(path.join(procRoot, pid, 'cwd')), mainJs)) {
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
function restartNeeded(files, procRoot, mainJs) {
    let starts;
    try {
        starts = mainappStarts(procRoot, mainJs);
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

/* Every file's job for one MainApp release's edits. */
function prepare(command, paths, sets, known) {
    return Object.keys(paths).map((kind) => {
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
        job.reference = job.sha256 === known[kind];
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
}

/* Prepares every file before writing any: a problem in one file leaves
 * both untouched. The files take the edits of the first MainApp release
 * whose edits fit both; when none fit, the problems reported are those of
 * the release with the fewest, the first of them on a tie. */
function runCommand(command, paths, log, mainapps) {
    let chosen = null;
    let jobs = null;
    let fewest = Infinity;
    for (let i = 0; i < mainapps.length; i += 1) {
        const tried = prepare(command, paths, mainapps[i].sets, mainapps[i].known);
        const problems = tried.reduce((n, j) => n + j.problems.length, 0);
        if (problems < fewest) {
            chosen = mainapps[i];
            jobs = tried;
            fewest = problems;
        }
        if (!problems) {
            break;
        }
    }
    const known = chosen.known;

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
        mainapp: fewest ? null : chosen.version,
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
        return { result: refresh(result, jobs, known), code: 1 };
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
        return { result: refresh(result, jobs, known), code: 1 };
    }
    return { result: refresh(result, jobs, known), code: 0 };
}

/* MainApp-21 is never bounced for this patch, whoever calls the tool: on
 * iDrive 8 changed and restartNeeded stay false, and nextStart says the
 * running MainApp-21 has not loaded the files as they are now (it does at
 * its next start). r.written: this call wrote the files. */
function run(command, paths, log, procRoot, sets, unit) {
    const u = UNITS[unit || 'ID7'];
    const r = runCommand(command, paths, log, sets ? [{ version: null, sets, known: u.mainapps[0].known }] : u.mainapps);
    const stale = restartNeeded(r.result.files.map((f) => f.path), procRoot || '/proc', u.paths.main);
    r.written = r.result.changed;
    r.result.unit = unit || 'ID7';
    if (r.result.unit === 'ID8') {
        r.result.changed = false;
        r.result.restartNeeded = false;
        r.result.nextStart = stale;
        if (stale) {
            log('MainApp-21 loads the bundles as they are now at its next start');
        }
        return r;
    }
    r.result.restartNeeded = stale;
    if (stale) {
        log('MainApp started before the bundles were last written; bounce its node child');
    }
    return r;
}

function refresh(result, jobs, known) {
    jobs.forEach((j, i) => {
        result.files[i].sha256 = j.sha256;
        result.files[i].reference = j.sha256 === known[j.kind];
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
    return 'usage: patch_mainapp.js --version | check|apply|revert [--json] [--unit ID7|ID8] ' +
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
    const given = {};
    let json = false;
    let unit = null;
    for (let i = 1; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--json') {
            json = true;
        } else if ((arg === '--main' || arg === '--appmanagement') && i + 1 < argv.length) {
            given[arg.slice(2)] = argv[i + 1];
            i += 1;
        } else if (arg === '--unit' && UNITS[argv[i + 1]]) {
            unit = argv[i + 1];
            i += 1;
        } else {
            out(usage());
            return 2;
        }
    }
    unit = unit || detectUnit();
    const paths = Object.assign({}, UNITS[unit].paths, given);
    if (command === 'boot') {
        let r;
        try {
            r = run('apply', paths, (line) => out('app-privacy: ' + line), null, null, unit);
            out('app-privacy: ' + r.result.state + (r.written ? ' (applied)' : ''));
        } catch (e) {
            out('app-privacy: ERROR: ' + e.message);
        }
        return 0;
    }
    const r = run(command, paths, json ? () => {} : out, null, null, unit);
    if (json) {
        out(JSON.stringify(r.result));
    }
    return r.code;
}

module.exports = {
    VERSION, MARKER_KEY, OVERRIDE_FILE, PREINSTALLED_DIR, HELPER_JS, PATCH_SETS, EARLIER_PATCH_SETS, KNOWN_SHA256,
    PATCH_SETS_8_1_1, KNOWN_SHA256_8_1_1, PATCH_SETS_8_2_8, KNOWN_SHA256_8_2_8, PREINSTALLED_DIR_21, HELPER_JS_21, PATCH_SETS_21, KNOWN_SHA256_21,
    PATCH_SETS_21_9_2_15, KNOWN_SHA256_21_9_2_15,
    UNITS, unitOf,
    classify, applyPatches, removePatches, run, stampPackage, checkApps, main
};

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
