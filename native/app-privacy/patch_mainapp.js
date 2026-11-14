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
 *   patch_mainapp.js check  [--json] [--unit ID7|ID8] [--main PATH] [--appmanagement PATH] [--record PATH]
 *   patch_mainapp.js apply  [--json] [--unit ID7|ID8] [--main PATH] [--appmanagement PATH] [--record PATH]
 *   patch_mainapp.js revert [--json] [--unit ID7|ID8] [--main PATH] [--appmanagement PATH] [--record PATH]
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
 * restartNeeded, files, edits, skipped, unit, mainapp, mainappVersion,
 * fingerprint}, for check also record; restartNeeded is true while a
 * running MainApp started before the bundles were last written, and
 * mainapp names the MainApp release whose edits the bundles take (null on
 * a mismatch). Runs on the unit's own bundles write the record
 * (RECORD_FILE); --record PATH writes it there for any bundles.
 */
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.7.1';
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

/* Each edit's identity, as --json and the record name it: id, the same
 * for an edit's counterpart in every MainApp release; helper, the id of
 * the predicate copy its code calls (a predicate copy has none). The
 * patch arrays themselves stay [anchor, replacement, expected anchor
 * occurrences]. An edit without an entry is required and needs every
 * predicate copy of its file (plan). */
const EDIT_INFO = new Map();
function edit(id, helper, patch) {
    EDIT_INFO.set(patch, { id, helper });
    return patch;
}

/* A copy of the predicate at the head of the bundle module that anchor
 * opens; id names the module. */
function helperInjection(id, anchor, helper) {
    return edit('helper:' + id, null, [anchor, (helper || HELPER_JS) + anchor, 1]);
}

/* Edits our apps cannot install, run or keep their data safely without:
 * every other edit only keeps them out of a backend report or query. A
 * required edit must fit exactly, an optional one whose anchor MainApp
 * lacks is left out (README.md, "Required and optional edits"). */
const REQUIRED_EDITS = ['crash-gate', 'crash-count', 'package-source', 'keychain-time'];
const EDIT_TITLES = {
    'backend-inventory': 'backend app inventory',
    'backend-update-all': 'backend update of every app',
    'provider-inventory': 'backend app inventory (AppManagement)',
    'provider-update-all': 'backend update of every app (AppManagement)',
    'update-availability-sweep': 'update-availability sweep',
    'analytics-install': 'install analytics',
    'analytics-install-failed': 'failed-install analytics',
    'analytics-start': 'app start analytics',
    'analytics-stop': 'app stop analytics',
    'crash-gate': 'crash recovery',
    'crash-count': 'crash restart count',
    'corrupt-app-report': 'corrupt-app report',
    'corrupt-package-report': 'corrupt-package report',
    'autoupdate-all': 'automatic update of every app',
    'user-update-all': 'user update of every app',
    'release-notes': 'release notes request',
    'repository-version-query': 'repository version query',
    'repository-version-info': 'repository version info query',
    'package-source': 'package source',
    'keychain-time': 'keychain time limit',
    'diag-app-list': 'diagnostic app list',
    'diag-crash-status': 'diagnostic crash status',
    'diag-entries': 'diagnostic entries',
    'diag-entry-values': 'diagnostic entry values'
};

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
// unit shuts down, except on 6.4.8, which restarts an app then too; a
// failed restart does count): after CRASH_RESTARTS of
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
// At the restart, after MainApp's head-unit-shutdown check (6.4.8 has none).
const CRASH_COUNT_JS = 'appCorruptInfo.localOnlyRestarts&&(appCorruptInfo.recoveryAttemptsSinceCorruption=0,' +
    'appCorruptInfo.localOnlyRestarts.push(Date.now())),';
const CRASH_EDITS = [
    edit('crash-gate', 'helper:CorruptAppsHandler', ins(CRASH_GATE_BEFORE, CRASH_GATE_JS, 'buildAnalyticsService()', 1)),
    edit('crash-count', 'helper:CorruptAppsHandler',
        ins('appCorruptInfo.recoveryAttemptsSinceCorruption++,', CRASH_COUNT_JS, 'app.updateStartableCouncil(', 1))
];

const KEEP_APP = '.filter(app=>!isLocalOnlyApp(app.getAppId()))';
const KEEP_APP_ID = '.filter(appId=>!isLocalOnlyApp(appId))';

const MAIN_PATCHES = [
    // Predicate, one copy per bundle module that uses it.
    helperInjection('AppManagementFfProviderImpl', 'var AppManagementFfProviderImplOptions;'),
    helperInjection('AppManagementController', 'class AppManagementController{'),
    helperInjection('CorruptAppsHandler', 'class CorruptAppsHandler{'),
    helperInjection('AppsAutoupdater', 'class AppsAutoupdater{'),
    helperInjection('MainApp', 'class MainApp{'),
    helperInjection('DiagOapProvider', 'class DiagOapProvider{'),
    // Backend inventory (AppManagement_ff.getAllInstalledApps) and the
    // backend-triggered update of every app (updateAllApps).
    edit('backend-inventory', 'helper:AppManagementFfProviderImpl',
        ins('installedApps=this._appRegistry.getAll()', KEEP_APP, ';', 1)),
    edit('backend-update-all', 'helper:AppManagementFfProviderImpl', ins('getAllAppIds()', KEEP_APP_ID, ',resultArgs=', 1)),
    // Update-availability sweep against the app repository.
    edit('update-availability-sweep', 'helper:AppManagementController',
        ins('this.appRegistry.getAll()', KEEP_APP, ',app=>{const appId', 1)),
    // Platform analytics APP_INSTALL events, success and failure.
    edit('analytics-install', 'helper:AppManagementController',
        ins('appId&&', '!isLocalOnlyApp(appId)&&', 'AnalyticsServiceBuilders_1', 2)),
    // Crash recovery, and no APP_CRASH analytics event for local-only apps.
    CRASH_EDITS[0],
    CRASH_EDITS[1],
    // The corrupt-app report.
    edit('corrupt-app-report', 'helper:CorruptAppsHandler', ins('()=>', 'isLocalOnlyApp(appId)?Promise.resolve():',
        'this._backendTransport.reportCorruptApp(appId,version', 1)),
    // Periodic autonomous update of every app, and the user-triggered
    // update of every app.
    edit('autoupdate-all', 'helper:AppsAutoupdater', ins('!appsUpdated.includes(entry)', '&&!isLocalOnlyApp(entry)', ')', 1)),
    edit('user-update-all', 'helper:MainApp',
        ins('getAllAppIds()', KEEP_APP_ID, ';return logger.info(`${logPrefix} Trying', 1)),
    // Diagnostic readout (DiagOap StatusOap).
    edit('diag-app-list', 'helper:DiagOapProvider', ins('getAllAppIds())', KEEP_APP_ID, ';', 2)),
    edit('diag-crash-status', 'helper:DiagOapProvider',
        ins('data){const logPrefix=`${this.CLASS_NAME}::persistCrashedStartingRunning`;',
            'if(isLocalOnlyApp(data.name))return Promise.resolve();', '', 1)),
    edit('diag-entries', 'helper:DiagOapProvider',
        ins('for(const entry of entries', '.filter(_e=>!isLocalOnlyApp(_e.name))', ')', 1)),
    edit('diag-entry-values', 'helper:DiagOapProvider',
        ins('entryValue=entries', '.filter(_e=>!isLocalOnlyApp(_e.appId))', '.map(', 1))
];

const APPMANAGEMENT_PATCHES = [
    helperInjection('AppManager', 'class AppManager{'),
    helperInjection('NpmPackageManager', 'class NpmPackageManager{'),
    // Repository version query: local-only apps resolve from ./preinstalled.
    edit('repository-version-query', 'helper:NpmPackageManager', ins('logPrefix),', 'isLocalOnlyApp(appId)?' +
        'Promise.reject(new OAPError(`${logPrefix} ${appId} is local-only; ' +
        'the app repository is not queried.`,"LOCAL_ONLY_APP")):', 'this._npmClient.view(appId)', 1)),
    // Package download: local-only apps never use the repository, so a
    // package missing from the preinstalled folder is never replaced by
    // one the repository serves under the app's name.
    edit('package-source', 'helper:NpmPackageManager',
        ins('ignoreNpmRegistry=!1){const logPrefix="NpmPackageManager::download";',
            'isLocalOnlyApp(appId)&&(ignoreNpmRegistry=!0);', '', 1)),
    // Corrupt-app report on package verification failure.
    edit('corrupt-package-report', 'helper:AppManager',
        ins('vin=>{', 'isLocalOnlyApp(appId)||', 'this._backendTransport.reportCorruptApp(', 1))
];
// MainApp kills CertificateManager.js, which has the head unit's
// certificate service create an app's keychain, after 35 s. A local-only
// app's gets CERT_KILL_S: the deploy tool's copy of the script waits up to
// 120 s and, when it gives up, says why on stderr, which MainApp puts in
// the install's error.
const CERT_KILL_S = 125;
function certEdit(n) {
    return edit('keychain-time', 'helper:AppManager',
        ins('config.get("certificateManagerGids")),', 'isLocalOnlyApp(appId)?' + CERT_KILL_S + ':', '35)', n));
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
    helperInjection('AppManagementFfProviderImpl', 'class AppManagementFfProviderImpl{'),
    helperInjection('CorruptAppsHandler', 'class CorruptAppsHandler{'),
    helperInjection('AppsAutoupdater', 'class AppsAutoupdater{'),
    helperInjection('MainApp', 'class MainApp{'),
    edit('backend-inventory', 'helper:AppManagementFfProviderImpl',
        ins('installedApps=this._appRegistry.getAll()', KEEP_APP, ';', 1)),
    edit('backend-update-all', 'helper:AppManagementFfProviderImpl',
        ins('getAllAppIds()', KEEP_APP_ID, ';const resultArgs=', 1)),
    edit('crash-gate', 'helper:CorruptAppsHandler',
        ins(CRASH_GATE_BEFORE, crashGateJs('CorruptAppsHandler::_tryRecoverApp', '', ''), 'let recoveryAction=', 1)),
    CRASH_EDITS[1],
    edit('corrupt-app-report', 'helper:CorruptAppsHandler', ins('()=>', 'isLocalOnlyApp(appId)?Promise.resolve():',
        'this._backendTransport.reportCorruptApp(appId,version', 1)),
    edit('autoupdate-all', 'helper:AppsAutoupdater',
        ins('getAllAppIds()', KEEP_APP_ID, '.forEach(appId=>{this._appManager.update(appId,', 1)),
    edit('user-update-all', 'helper:MainApp',
        ins('getAllAppIds()', KEEP_APP_ID, ';return logger.info(`${logPrefix} Trying', 1))
];
const PATCH_SETS_8_1_1 = { main: MAIN_PATCHES_8_1_1, appmanagement: APPMANAGEMENT_PATCHES_1_4_0.concat([certEdit(1)]) };

// oap-mainapp 6.5.5. Its main.js and AppManagement.js are bytecode-loader
// stubs that run main.bundle.js and AppManagement.bundle.js; its bundles
// take 8.1.1's edits.
const KNOWN_SHA256_6_5_5 = {
    main: '78a37fcafdb780771226e9710de9911ffc9608e3be2a394360874f0ec16faa25',
    appmanagement: 'f53e7e8a9775c36a136f38de89cebd8eec58cb88e079ce3ca5d4f1b1447b8200'
};

// oap-mainapp 6.4.8. Laid out as 6.5.5 (bytecode-loader stubs, edits in
// main.bundle.js and AppManagement.bundle.js); its AppManagement bundle takes
// 8.1.1's edits. Its main bundle differs from 8.1.1's in three places:
// - besides AppManagementFfProviderImpl it has AppManagementProviderImpl,
//   also a joynr provider registered out-car (outCarProviderQos), with its
//   own getAllInstalledApps and updateAllApps: both are filtered as the
//   AppManagement_ff ones are, so the backend inventory anchor is pinned to
//   the _ff one by what follows it;
// - its crash recovery has no StartableCouncil: the restart counted is the
//   one after app.disableStart();
// - its autonomous update of every app calls update(appId) alone.
const KNOWN_SHA256_6_4_8 = {
    main: '44f1fe1e0ff589984b9812d3cbff25671e01d2e21fd3ff9d4f8d9d193962738c',
    appmanagement: '68df36d7b37ee7180c7863331f9616e5e6641e056c982374167f42fc2916c00c'
};
const MAIN_PATCHES_6_4_8 = [
    helperInjection('AppManagementFfProviderImpl', 'class AppManagementFfProviderImpl{'),
    helperInjection('AppManagementProviderImpl', 'class AppManagementProviderImpl{'),
    helperInjection('CorruptAppsHandler', 'class CorruptAppsHandler{'),
    helperInjection('AppsAutoupdater', 'class AppsAutoupdater{'),
    helperInjection('MainApp', 'class MainApp{'),
    edit('backend-inventory', 'helper:AppManagementFfProviderImpl',
        ins('installedApps=this._appRegistry.getAll()', KEEP_APP, ';logger.debug(`${logPrefix} retrieved', 1)),
    edit('backend-update-all', 'helper:AppManagementFfProviderImpl',
        ins('getAllAppIds()', KEEP_APP_ID, ';const resultArgs=', 1)),
    edit('provider-inventory', 'helper:AppManagementProviderImpl',
        ins('installedApps=this._appRegistry.getAll()', KEEP_APP, ';return logger.debug(`${logPrefix} retrieved', 1)),
    edit('provider-update-all', 'helper:AppManagementProviderImpl',
        ins('getAllAppIds()', KEEP_APP_ID, ';return Promise.mapSeries(installedAppIds,appId=>this.updateApp(', 1)),
    edit('crash-gate', 'helper:CorruptAppsHandler',
        ins(CRASH_GATE_BEFORE, crashGateJs('CorruptAppsHandler::_tryRecoverApp', '', ''), 'let recoveryAction=', 1)),
    edit('crash-count', 'helper:CorruptAppsHandler',
        ins('appCorruptInfo.recoveryAttemptsSinceCorruption++,', CRASH_COUNT_JS, 'app.disableStart();', 1)),
    edit('corrupt-app-report', 'helper:CorruptAppsHandler', ins('()=>', 'isLocalOnlyApp(appId)?Promise.resolve():',
        'this._backendTransport.reportCorruptApp(appId,version', 1)),
    edit('autoupdate-all', 'helper:AppsAutoupdater',
        ins('getAllAppIds()', KEEP_APP_ID, '.forEach(appId=>{this._appManager.update(appId)})', 1)),
    edit('user-update-all', 'helper:MainApp',
        ins('getAllAppIds()', KEEP_APP_ID, ';return logger.info(`${logPrefix} Trying', 1))
];
const PATCH_SETS_6_4_8 = { main: MAIN_PATCHES_6_4_8, appmanagement: PATCH_SETS_8_1_1.appmanagement };

// oap-mainapp 8.2.10. Its update-availability sweep is
// AppsAutoupdater._areUpdatesAvailable, which reads the registry as
// this._appRegistry; its other edits are 8.3.2's.
const KNOWN_SHA256_8_2_10 = {
    main: 'b56f499d944ff1f9cab5a81f9af8bfb641d1e710fca007f0f7c3a63c2c5af12f',
    appmanagement: '21d8d9a9054860e5e3ec4b2233e73e84bba7b7526c1b654c1f86b8e98cd4884e'
};
const PATCH_SETS_8_2_10 = {
    main: MAIN_PATCHES.map((p) => p[0] === 'this.appRegistry.getAll(),app=>{const appId' ?
        edit('update-availability-sweep', 'helper:AppsAutoupdater',
            ins('this._appRegistry.getAll()', KEEP_APP, ',app=>{const appId', 1)) : p),
    appmanagement: APPMANAGEMENT_PATCHES
};

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
    helperInjection('AppManagementFfProviderImpl', 'class AppManagementFfProviderImpl{', HELPER_JS_21),
    helperInjection('AppManagementController', 'let AppManagementController=AppManagementController_1=class', HELPER_JS_21),
    helperInjection('CorruptAppsHandler', 'let CorruptAppsHandler=class', HELPER_JS_21),
    helperInjection('AppsAutoupdater', 'let AppsAutoupdater=class', HELPER_JS_21),
    helperInjection('MainApp', 'let MainApp=class', HELPER_JS_21),
    helperInjection('DiagOapProvider', 'class DiagOapProvider21{', HELPER_JS_21),
    helperInjection('NpmPackageManager', 'class NpmPackageManager{', HELPER_JS_21),
    helperInjection('AnalyticsAppStartStopEvents', 'let AnalyticsAppStartStopEvents=class', HELPER_JS_21),
    helperInjection('AppReleaseNotesControl', 'let AppReleaseNotesControl=class', HELPER_JS_21),
    // Backend inventory (AppManagement_ff.getAllInstalledApps) and the
    // backend-triggered update of every app (updateAllApps).
    edit('backend-inventory', 'helper:AppManagementFfProviderImpl',
        ins('installedApps=this._appRegistry.getAll()', KEEP_APP, ';', 1)),
    edit('backend-update-all', 'helper:AppManagementFfProviderImpl', ins('getAllAppIds()', KEEP_APP_ID, ',resultArgs=', 1)),
    // Update-availability sweep against the app repository.
    edit('update-availability-sweep', 'helper:AppManagementController',
        ins('this.appRegistry.getAll()', KEEP_APP, ',(app=>{const appId', 1)),
    // Platform analytics APP_INSTALL events, success and failure.
    edit('analytics-install', 'helper:AppManagementController', ins('const settings=app.getSettings();',
        'isLocalOnlyApp(entry.appId)||', '(0,AnalyticsServiceBuilders_1', 1)),
    edit('analytics-install-failed', 'helper:AppManagementController',
        ins('entry.appId&&', '!isLocalOnlyApp(entry.appId)&&', '(0,AnalyticsServiceBuilders_1', 1)),
    // Crash recovery (after MainApp-21's head-unit-shutdown check), and no
    // APP_CRASH analytics event for local-only apps. A local-only app never
    // reaches MainApp-21's later rungs (the forced update, the data wipe,
    // the disable); its 48 h reset clears the stock counters only.
    // MainApp-21 holds a crashed app unstartable (NOT_IN_CORRUPT_APPS_HANDLING)
    // until its recovery ends; an app left stopped is released, so its tile
    // starts it again.
    edit('crash-gate', 'helper:CorruptAppsHandler', ins('Promise.resolve();', crashGateJs('CorruptAppsHandler::tryRecoverApp',
        'app.updateStartableCouncil(StartableCouncil_1.default.NOT_IN_CORRUPT_APPS_HANDLING,!0);'),
    '(0,AnalyticsServiceBuilders_1', 1)),
    edit('crash-count', 'helper:CorruptAppsHandler',
        ins('appCorruptInfo.recoveryAttemptsSinceCorruption++,', CRASH_COUNT_JS, 'app.updateStartableCouncil(', 1)),
    // The corrupt-app report.
    edit('corrupt-app-report', 'helper:CorruptAppsHandler', ins('return ', 'isLocalOnlyApp(appId)?Promise.resolve():',
        'this.backendTransport.reportCorruptApp(appId,version', 1)),
    // Platform analytics APP_START and APP_STOP events.
    edit('analytics-stop', 'helper:AnalyticsAppStartStopEvents',
        ins('sendStopEvent(payload){', 'if(isLocalOnlyApp(payload.appName))return;', 'const logPrefix=', 1)),
    edit('analytics-start', 'helper:AnalyticsAppStartStopEvents',
        ins('sendStartEvent(payload){', 'if(isLocalOnlyApp(payload.appName))return;', 'const logPrefix=', 1)),
    // Periodic autonomous update of every app, and the user-triggered
    // update of every app.
    edit('autoupdate-all', 'helper:AppsAutoupdater', ins('!appsUpdated.includes(entry)', '&&!isLocalOnlyApp(entry)', ')', 1)),
    edit('user-update-all', 'helper:MainApp', ins('getAllAppIds()', KEEP_APP_ID, ',reSortedList=', 1)),
    // Release notes request for updated apps.
    edit('release-notes', 'helper:AppReleaseNotesControl',
        ins('apps:updatedAppsMetadata', '.filter(metadata=>!isLocalOnlyApp(metadata.appId))', '.map(', 1)),
    // App-repository package downloads (also the predownload before a
    // software update): a package missing from the preinstalled folder is
    // never replaced by one the repository serves under the app's name.
    // And the repository version queries.
    edit('package-source', 'helper:NpmPackageManager', ins('download(params){', refuseLocalOnly('download'),
        'const logPrefix="NpmPackageManager::download";', 1)),
    edit('repository-version-query', 'helper:NpmPackageManager',
        ins('getLatestAppVersion(params){', refuseLocalOnly('getLatestAppVersion'), 'const logPrefix=', 1)),
    edit('repository-version-info', 'helper:NpmPackageManager',
        ins('getLatestAppVersionInfo(params){', refuseLocalOnly('getLatestAppVersionInfo'), 'const logPrefix=', 1)),
    // Diagnostic readout (DiagOap StatusOap); provisioning lists our apps
    // as installable too.
    edit('diag-app-list', 'helper:DiagOapProvider',
        ins('_.union(this.installableApps,this.appRegistry.getAllAppIds())', KEEP_APP_ID, ';', 2)),
    edit('diag-crash-status', 'helper:DiagOapProvider',
        ins('data){const logPrefix=`${this.CLASS_NAME}::persistCrashedStartingRunning`;',
            'if(isLocalOnlyApp(data.name))return Promise.resolve();', '', 1)),
    edit('diag-entries', 'helper:DiagOapProvider',
        ins('for(const entry of entries', '.filter(_e=>!isLocalOnlyApp(_e.name))', ')', 1)),
    edit('diag-entry-values', 'helper:DiagOapProvider',
        ins('entryValue=entries', '.filter(_e=>!isLocalOnlyApp(_e.appId))', '.map(', 1))
];

const APPMANAGEMENT_PATCHES_21 = [
    helperInjection('AppManager', 'class AppManager{', HELPER_JS_21),
    // Corrupt-app report on package verification failure.
    edit('corrupt-package-report', 'helper:AppManager',
        ins('vin=>{', 'isLocalOnlyApp(appId)||', 'this.backendTransport.reportCorruptApp(', 1))
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
    main: MAIN_PATCHES_21.map((p) => (MAIN_EDITS_21_9_2_15[p[0]] ?
        edit(EDIT_INFO.get(p).id, EDIT_INFO.get(p).helper, MAIN_EDITS_21_9_2_15[p[0]]) : p)),
    appmanagement: APPMANAGEMENT_PATCHES_21
};

function bundlePaths(root) {
    return { main: root + '/src/main.js', appmanagement: root + '/src/AppManagement/AppManagement.js' };
}
/* MainApp 6.5.5 ships <name>.js as a bytecode-loader stub that reads and
 * runs <name>.bundle.js; 8.x and MainApp-21 ship the bundle in <name>.js.
 * The .bundle.js.bytecode cache is left in place: Node 8's V8 rejects
 * cached data made for a source of another length, which every edit
 * changes, and compiles the source; revert restores the bundle byte for
 * byte so the original cache applies again. */
function bundlePathFor(file) {
    const bundle = file.replace(/\.js$/, '.bundle.js');
    return bundle !== file && fs.existsSync(bundle) ? bundle : file;
}
function resolveBundlePaths(paths) {
    const out = {};
    Object.keys(paths).forEach((k) => {
        out[k] = bundlePathFor(paths[k]);
    });
    return out;
}
/* Each unit's MainApp releases, as { version, sets: { current, earlier },
 * known }, the first the one problems are reported for when no release's
 * edits fit. Only 8.3.2's bundles can carry an earlier app-privacy
 * release's edits. */
const UNITS = {
    ID7: { paths: DEFAULT_PATHS, mainapps: [
        { version: '8.3.2', sets: { current: PATCH_SETS, earlier: EARLIER_PATCH_SETS }, known: KNOWN_SHA256 },
        { version: '8.2.10', sets: { current: PATCH_SETS_8_2_10, earlier: [] }, known: KNOWN_SHA256_8_2_10 },
        { version: '8.1.1', sets: { current: PATCH_SETS_8_1_1, earlier: [] }, known: KNOWN_SHA256_8_1_1 },
        { version: '6.5.5', sets: { current: PATCH_SETS_8_1_1, earlier: [] }, known: KNOWN_SHA256_6_5_5 },
        { version: '6.4.8', sets: { current: PATCH_SETS_6_4_8, earlier: [] }, known: KNOWN_SHA256_6_4_8 }
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

/* Where one patch set's edits stand in text: base, the text with every
 * edit of the set taken out (the stock bundle), and per edit its anchor's
 * occurrences in base (found) and whether text carries the edit. problems:
 * an edit text carries only in part, an edit without its predicate copy,
 * the predicate outside these edits, or edits that do not come off
 * exactly. */
function survey(text, patches) {
    const base = removePatches(text, patches);
    const problems = [];
    const edits = patches.map((p) => {
        const info = EDIT_INFO.get(p) || { id: 'untagged:' + p[0].slice(0, 40), helper: null, untagged: true };
        const carried = count(text, p[1]);
        if (carried !== 0 && carried !== p[2]) {
            problems.push('replacement for ' + short(p[0]) + ': ' + carried +
                ' occurrence(s), expected ' + p[2]);
        }
        return { patch: p, id: info.id, helper: info.helper, untagged: !!info.untagged,
            found: count(base, p[0]), carried: carried === p[2] };
    });
    if (!problems.length) {
        edits.forEach((e) => {
            const h = edits.filter((x) => x.id === e.helper)[0];
            if (e.carried && h && !h.carried) {
                problems.push(e.id + ' without its predicate copy ' + h.id);
            }
        });
        const stray = count(base, PREDICATE);
        if (stray) {
            problems.push(stray + ' occurrence(s) of ' + PREDICATE + ' outside these edits');
        } else if (applyPatches(base, edits.filter((e) => e.carried).map((e) => e.patch)) !== text) {
            problems.push('the edits cannot be removed exactly');
        }
    }
    return { base, edits, problems };
}

function isHelper(e) {
    return e.id.indexOf('helper:') === 0;
}

/* Sets each edit's plan by the rules (README.md, "Required and optional
 * edits"): 'apply' when its anchor occurs as expected; with no occurrence
 * 'skipped-not-found', or 'refused-not-found' for a required edit; any
 * other count 'refused-ambiguous'. An edit goes with its predicate copy:
 * one whose copy's anchor is missing is missing too, and a copy no
 * applied edit calls is 'not-applicable'. A copy is required when a
 * required edit calls it. */
function plan(edits) {
    edits.forEach((e) => {
        e.plan = e.found === e.patch[2] ? 'apply' : e.found === 0 ? 'missing' : 'refused-ambiguous';
        e.required = e.untagged || REQUIRED_EDITS.indexOf(e.id) >= 0;
    });
    const untagged = edits.filter((e) => e.untagged);
    const helpers = edits.filter(isHelper);
    edits.filter((e) => !isHelper(e)).forEach((e) => {
        const h = helpers.filter((x) => x.id === e.helper)[0];
        if (e.plan === 'apply' && h && h.plan === 'missing') {
            e.plan = 'missing';
        }
        if (e.plan === 'missing') {
            e.plan = e.required ? 'refused-not-found' : 'skipped-not-found';
        }
    });
    helpers.forEach((h) => {
        const users = edits.filter((e) => e.helper === h.id).concat(untagged);
        h.required = users.some((e) => e.required);
        if (h.plan === 'missing') {
            h.plan = h.required ? 'refused-not-found' : 'skipped-not-found';
        } else if (h.plan === 'apply' && !users.some((e) => e.plan === 'apply')) {
            h.plan = 'not-applicable';
        }
    });
}

function refusal(e) {
    return 'anchor ' + short(e.patch[0]) + ': ' + e.found + ' occurrence(s), expected ' + e.patch[2] +
        ' (' + (e.required ? 'required ' : '') + e.id + ')';
}

/* One bundle's survey for sets = { current, earlier }, planned. A bundle
 * that carries all of an earlier release's edits and not all of this
 * one's (patchedBy) is surveyed without them. */
function examine(text, kind, sets) {
    const current = sets.current[kind];
    let found = survey(text, current);
    let patchedBy = null;
    for (let i = 0; !patchedBy && (found.problems.length || found.edits.some((e) => !e.carried)) &&
            i < sets.earlier.length; i += 1) {
        const patches = sets.earlier[i][kind];
        if (classify(text, patches) !== 'patched') {
            continue;
        }
        const base = removePatches(text, patches);
        if (classify(base, patches) === 'unpatched' && applyPatches(base, patches) === text) {
            const s = survey(base, current);
            if (!s.problems.length) {
                found = s;
                patchedBy = sets.earlier[i].version;
            }
        }
    }
    plan(found.edits);
    found.patchedBy = patchedBy;
    return found;
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

/* Every file's job for one MainApp release's edits. A check or apply
 * refuses a file with a refused edit; a revert only needs the edits to
 * come off exactly. */
function prepare(command, paths, sets, known) {
    return Object.keys(paths).map((kind) => {
        const file = paths[kind];
        const job = { kind, path: file, sha256: null, stockSha256: null, reference: false,
            state: null, patchedBy: null, problems: [], target: null, edits: [], refused: 0, wrote: null };
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (e) {
            job.problems.push('cannot read: ' + e.message);
            return job;
        }
        job.sha256 = sha256(text);
        job.reference = job.sha256 === known[kind];
        const found = examine(text, kind, sets);
        job.edits = found.edits;
        if (found.problems.length) {
            job.problems = found.problems;
            return job;
        }
        job.stockSha256 = sha256(found.base);
        job.patchedBy = found.patchedBy;
        const refused = found.edits.filter((e) => e.plan.indexOf('refused') === 0);
        job.refused = refused.length;
        const applied = found.edits.filter((e) => e.plan === 'apply');
        const patched = applyPatches(found.base, applied.map((e) => e.patch));
        job.state = !refused.length && text === patched ? 'patched' : 'unpatched';
        if (command !== 'revert' && refused.length) {
            job.problems = refused.map(refusal);
            job.state = null;
        } else if (command === 'apply' && text !== patched) {
            const s = survey(patched, sets.current[kind]);
            if (s.problems.length || s.edits.some((e, i) => e.carried !== (found.edits[i].plan === 'apply'))) {
                job.problems.push('patched output does not verify');
                job.state = null;
            } else {
                job.target = patched;
            }
        } else if (command === 'revert' && text !== found.base) {
            job.target = found.base;
        }
        return job;
    });
}

/* An edit the chosen release's anchor does not find, whose counterpart
 * in another release's edits occurs more often than expected (or less but
 * at least once), is ambiguous: it refuses everything as its own anchor
 * would. */
function refuseAmbiguousElsewhere(jobs, others) {
    jobs.forEach((job, k) => skippedEdits([job]).forEach((e) => {
        const elsewhere = others.map((o) => ({ version: o.version, e: o.jobs[k].edits.filter((x) =>
            x.id === e.id && x.plan === 'refused-ambiguous')[0] })).filter((o) => o.e)[0];
        if (elsewhere) {
            e.plan = 'refused-ambiguous';
            e.found = elsewhere.e.found;
            e.patch = elsewhere.e.patch;
            job.refused += 1;
            job.problems.push(refusal(e) + ' as MainApp ' + elsewhere.version + ' has it');
            job.state = null;
            job.target = null;
        }
    }));
}

function skippedEdits(jobs) {
    return [].concat.apply([], jobs.map((j) => j.edits))
        .filter((e) => !isHelper(e) && e.plan === 'skipped-not-found');
}

/* Prepares every file before writing any: a problem in one file leaves
 * both untouched. The files take the edits of the MainApp release whose
 * edits fit both with the fewest skipped, the first (newest) on a tie
 * (when releases share edits, the one whose fingerprint the bundles
 * carry), so a MainApp release this tool does not know takes the newest
 * edits that fit it; when none fit, the problems reported are those of
 * the release with the fewest, the first of them on a tie. */
function runCommand(command, paths, log, mainapps) {
    let chosen = null;
    let jobs = null;
    let best = null;
    const others = [];
    for (let i = 0; i < mainapps.length; i += 1) {
        const tried = prepare(command, paths, mainapps[i].sets, mainapps[i].known);
        const key = [tried.reduce((n, j) => n + j.problems.length, 0), tried.reduce((n, j) => n + j.refused, 0),
            skippedEdits(tried).length];
        others.push({ version: mainapps[i].version, jobs: tried });
        if (!best || (key[0] - best[0] || key[1] - best[1] || key[2] - best[2]) < 0) {
            chosen = mainapps[i];
            jobs = tried;
            best = key;
        }
        if (!key[0] && !key[1] && !key[2]) {
            // A later release with the same edits (6.5.5 takes 8.1.1's)
            // names the bundles when they carry its stock fingerprint,
            // patched or not.
            const twin = mainapps.slice(i + 1).filter((m) => m.sets.current === chosen.sets.current &&
                tried.every((j) => j.stockSha256 === m.known[j.kind]))[0];
            if (twin) {
                chosen = twin;
                jobs = prepare(command, paths, twin.sets, twin.known);
            }
            break;
        }
    }
    if (command !== 'revert') {
        refuseAmbiguousElsewhere(jobs, others.filter((o) => o.jobs !== jobs));
    }
    const known = chosen.known;

    jobs.forEach((job) => {
        log(job.path + ' (' + job.kind + '): ' +
            (job.sha256 ? 'sha256 ' + job.sha256 +
                (job.reference ? '' : ' (not the reference fingerprint)') : 'unreadable'));
        job.problems.forEach((p) => log('  PROBLEM: ' + p));
        if (!job.problems.length) {
            skippedEdits([job]).forEach((e) => log('  skipped, anchor not found: ' + e.id + ' (' + EDIT_TITLES[e.id] + ')'));
        }
        if (job.state) {
            log('  state: ' + job.state + (job.patchedBy ? ' (patched by ' + job.patchedBy + ')' : ''));
        }
    });

    const result = { version: VERSION, command, state: overallState(jobs), changed: false,
        mainapp: jobs.some((j) => j.problems.length) ? null : chosen.version, mainappVersion: mainappVersion(paths.main),
        fingerprint: sha256(jobs.map((j) => j.kind + ':' + (j.stockSha256 || j.sha256)).join('\n')).slice(0, 16),
        files: jobs.map((j) => ({ kind: j.kind, path: j.path, sha256: j.sha256, stockSha256: j.stockSha256,
            reference: j.reference, state: j.state, patchedBy: j.patchedBy, problems: j.problems })) };
    if (command === 'check') {
        return { result: refresh(result, jobs, known), code: { patched: 0, unpatched: 1, mismatch: 2 }[result.state] };
    }
    if (result.state === 'mismatch') {
        log('refused; nothing written');
        return { result: refresh(result, jobs, known), code: 2 };
    }
    const writes = jobs.filter((j) => j.target !== null);
    if (!writes.length) {
        log('already ' + (command === 'apply' ? 'patched' : 'unpatched') + '; nothing written');
        return { result: refresh(result, jobs, known), code: 0 };
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
            j.wrote = command;
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

/* The result as the files now are: each edit as { id, title, file,
 * required, result, found, expected, anchor }, result one of 'applied' (the bundle
 * carries it), 'not-applied' (it fits, the bundle does not carry it),
 * 'skipped-not-found', 'refused-not-found', 'refused-ambiguous' or
 * 'not-applicable'; skipped, the optional edits left out. */
function refresh(result, jobs, known) {
    jobs.forEach((j, i) => {
        result.files[i].sha256 = j.sha256;
        result.files[i].reference = j.sha256 === known[j.kind];
        result.files[i].state = j.state;
        result.files[i].patchedBy = j.patchedBy;
    });
    result.state = overallState(jobs);
    result.edits = [].concat.apply([], jobs.map((j) => j.edits.map((e) => {
        const carried = j.wrote === 'apply' ? e.plan === 'apply' : j.wrote === 'revert' ? false : e.carried;
        return { id: e.id, title: EDIT_TITLES[e.id] || (isHelper(e) ? 'predicate copy in ' + e.id.slice('helper:'.length) : e.id),
            file: j.kind, required: e.required,
            result: carried ? 'applied' : e.plan === 'apply' ? 'not-applied' : e.plan,
            found: e.found, expected: e.patch[2], anchor: e.patch[0].slice(0, 60) };
    })));
    result.skipped = skippedEdits(jobs).map((e) => e.id);
    return result;
}

/* The installed MainApp's own version (its package.json beside src/),
 * null when there is none. */
function mainappVersion(mainJs) {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(mainJs)), 'package.json'), 'utf8')).version;
        return typeof v === 'string' ? v.slice(0, 64) : null;
    } catch (e) {
        return null;
    }
}

/* The record: what the latest apply, check, boot or revert made of each
 * edit, per MainApp fingerprint (the stock bundles' sha256), for the
 * RECORD_FINGERPRINTS fingerprints seen last, and a history of the last
 * RECORD_HISTORY results that differ from the one before. It names
 * versions, paths, sha256s and anchors of MainApp's own code, nothing of
 * the car or its owner. */
const RECORD_FILE = '/var/opt/app-privacy/edit-record.json';
const RECORD_FINGERPRINTS = 8;
const RECORD_HISTORY = 20;

function readRecord(file) {
    try {
        const r = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (r && Array.isArray(r.latest) && Array.isArray(r.history)) {
            return r;
        }
    } catch (e) {
        // none yet, or unreadable: start again
    }
    return { latest: [], history: [] };
}

function writeRecord(file, result, time) {
    const record = readRecord(file);
    const entry = { time, command: result.command, appPrivacy: VERSION, unit: result.unit,
        mainappVersion: result.mainappVersion, patchSet: result.mainapp, fingerprint: result.fingerprint,
        state: result.state, files: result.files.map((f) => ({ kind: f.kind, path: f.path, sha256: f.sha256,
            stockSha256: f.stockSha256 })), edits: result.edits };
    record.latest = record.latest.filter((e) => e && e.fingerprint !== entry.fingerprint)
        .concat([entry]).slice(-RECORD_FINGERPRINTS);
    const brief = { appPrivacy: VERSION, unit: result.unit, mainappVersion: result.mainappVersion,
        fingerprint: result.fingerprint, state: result.state, skipped: result.skipped,
        refused: result.edits.filter((e) => e.result.indexOf('refused') === 0).map((e) => e.id) };
    const last = record.history[record.history.length - 1];
    if (!last || JSON.stringify(Object.assign({}, last, { time: 0, command: 0 })) !==
            JSON.stringify(Object.assign({ time: 0, command: 0 }, brief))) {
        record.history = record.history.concat([Object.assign({ time, command: result.command }, brief)])
            .slice(-RECORD_HISTORY);
    }
    const tmp = file + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o644 });
        fs.renameSync(tmp, file);
    } catch (e) {
        try {
            fs.unlinkSync(tmp);
        } catch (ignored) {
            // nothing written
        }
        throw e;
    }
    return record;
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
        '[--main PATH] [--appmanagement PATH] [--record PATH] | boot | check-apps APPS_DIR...';
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
    let recordFile = null;
    for (let i = 1; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--json') {
            json = true;
        } else if (arg === '--record' && i + 1 < argv.length) {
            recordFile = argv[i + 1];
            i += 1;
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
    const paths = Object.assign({}, resolveBundlePaths(UNITS[unit].paths), given);
    // The unit's own bundles are recorded; others (a copy, a backup) only
    // with --record.
    recordFile = recordFile || (Object.keys(given).length ? null : RECORD_FILE);
    const record = (r, log) => {
        if (!recordFile) {
            return null;
        }
        try {
            return writeRecord(recordFile, Object.assign({}, r.result, { command }), new Date().toISOString());
        } catch (e) {
            log('record not written: ' + e.message);
            return null;
        }
    };
    if (command === 'boot') {
        const log = (line) => out('app-privacy: ' + line);
        let r;
        try {
            r = run('apply', paths, log, null, null, unit);
            record(r, log);
            out('app-privacy: ' + r.result.state + (r.written ? ' (applied)' : '') +
                (r.result.skipped.length ? '; skipped: ' + r.result.skipped.join(', ') : ''));
        } catch (e) {
            out('app-privacy: ERROR: ' + e.message);
        }
        return 0;
    }
    const log = json ? () => {} : out;
    const r = run(command, paths, log, null, null, unit);
    const written = record(r, log);
    if (command === 'check' && recordFile) {
        r.result.record = written || readRecord(recordFile);
    }
    if (json) {
        out(JSON.stringify(r.result));
    }
    return r.code;
}

module.exports = {
    VERSION, MARKER_KEY, OVERRIDE_FILE, PREINSTALLED_DIR, HELPER_JS, PATCH_SETS, EARLIER_PATCH_SETS, KNOWN_SHA256,
    PATCH_SETS_8_1_1, KNOWN_SHA256_8_1_1, KNOWN_SHA256_6_5_5, PATCH_SETS_6_4_8, KNOWN_SHA256_6_4_8, PATCH_SETS_8_2_10, KNOWN_SHA256_8_2_10,
    PREINSTALLED_DIR_21, HELPER_JS_21, PATCH_SETS_21, KNOWN_SHA256_21,
    PATCH_SETS_21_9_2_15, KNOWN_SHA256_21_9_2_15,
    UNITS, unitOf, bundlePathFor, resolveBundlePaths,
    EDIT_INFO, REQUIRED_EDITS, EDIT_TITLES, RECORD_FILE, RECORD_FINGERPRINTS, RECORD_HISTORY,
    classify, applyPatches, removePatches, run, stampPackage, checkApps, main
};

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
