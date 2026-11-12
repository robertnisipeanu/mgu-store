#!/usr/bin/env node
'use strict';
/**
 * Builds the provisioning-fallback copy of the app manager's main.js
 * from the stock file as it stands now:
 *
 *   node fallback_build.js <stock main.js> <copy out> [custom_apps.json [in-place request file]]
 *
 * The copy carries one fallback in ProvisioningNotifier, from
 * custom_apps.json, a map of appId to its provisioning flags
 * ("-enabled", "-allowed", "-appStartType", "-userLoginRequired",
 * "-updateMechanism"; one it leaves out is "true" for "-enabled" and
 * "-allowed", else as mgu-deploy writes it):
 *  - an app with no entry in MainApp's installable_apps list takes one
 *    ({"#text": appId, ...flags}, the shape modifyInstallableApps handles);
 *  - an app whose own provisioning section is missing or empty takes its
 *    flags as that section, which gives it its tile and start type.
 * An app provisioning names keeps its provisioned entry and section; an
 * app in neither list is unchanged.
 *
 * It also carries the in-place install hook (inplaceSource): once MainApp
 * has initialized, the running manager installs or updates one app from
 * its preinstalled package, or uninstalls one, on request, through its own
 * install(), update() or uninstall(), so only that app stops and starts
 * (or stops and goes, its tile with it). The request file defaults
 * to /var/opt/mgu-deploy/inplace/request.json; the manager answers in
 * mgu-deploy-inplace.json beside custom_apps.json.
 *
 * Both fallback anchors must occur exactly once in the stock file. Any
 * other count refuses the build: exit 3, nothing written, so the boot unit
 * logs the refusal and leaves the stock file in effect. The hook's anchor
 * is optional: when it does not occur exactly once, the copy is built
 * without the hook, and says so on stdout. Exit 2 is a usage error, exit
 * 1 any other failure. Runs under Node 8.
 *
 * iDrive 8's MainApp-21 (its provisioning anchor ID8.hookAnchor) takes
 * its own variant: the fallback only gives a listed app whose own section
 * is missing or empty its flags (MainApp-21 asks provisioning for the
 * section of every app it has registered), and lists nothing in
 * installable_apps, so MainApp-21 never installs an app because of it; the
 * hook calls install(app, {requestSource: "PREINSTALLED"}) and
 * update(app, {updateType: "PLATFORM", requestSource: "PREINSTALLED"}),
 * so neither asks the backend. Every edit runs inside try/catch, and all
 * three anchors must occur exactly once (exit 3 otherwise).
 *
 * On iDrive 7 the copy also puts our apps first in MainApp's install queue
 * (firstSources): an install or update of an app custom_apps.json lists
 * goes right behind the one running, ahead of the others waiting, and
 * starts without the network-retry delay others left. Without
 * ConnectedDrive, MainApp tries each of BMW's online apps again at every
 * start; each fails after its network retries and goes back to the end of
 * the queue, and the delay between tries doubles from 40 s for every app
 * behind them. Its two anchors are
 * optional, as the hook's: when either does not occur exactly once, the
 * copy is built without it, and says so on stdout.
 *
 * On iDrive 7 every edit of the copy also waits on its guard (guardSource7):
 * when a manager mgu-deploy restarted died within the watch after its
 * start, the copy runs as the stock file for the rest of the boot.
 *
 * On iDrive 7 the copy also keeps a registry entry whose app's init failed
 * at the manager's start (keepFactory). App.init does far more than read
 * package.json (proxies, services, ACLs), and any failure of it makes the
 * stock manager delete the entry, keeping the folder, and install the app
 * afresh under a new uid, the old uid staying taken by the folder's quota.
 * An entry whose folder holds that app's package stays; the app waits out
 * this start without a fresh install and takes further tries. The copy
 * records each such failure in mgu-deploy-init-failures.json beside
 * custom_apps.json. Its three anchors are optional, as the hook's.
 */
var fs = require('fs');
var path = require('path');

var MARK = '/* mgu-deploy provisioning fallback */';
var CLASS_ANCHOR = 'class ProvisioningNotifier ';
var HOOK_ANCHOR = 'isMainapp&&section===mainAppSection&&(newProvisioning.';
var INPLACE_MARK = '/* mgu-deploy in-place install */';
var INPLACE_ANCHOR = 'mainApp.init()}).then(()=>{';
var FIRST_MARK = '/* mgu-deploy apps first */';
/* the end of MainApp's own makeMethodQueued module (utils/makeMethodQueued, the one the
 * controller requires; oap-sdk's copy of it is another module), where its queues are in scope */
var QUEUE_ANCHOR = 'module.exports={makeMethodQueued:makeMethodQueued,unqueueMethodCall:unqueueMethodCall,' +
    'getCurrentOperationPromise:getCurrentOperationPromise,onQueueIdle:onQueueIdle,configureQueue:configureQueue};';
/* AppManagementController's constructor, which queues its installs and updates */
/* AppRegistry's class and its answer to a failed App.init, and the
 * AppManagerStub's calls into its AppManagement child. */
var KEEP_MARK = '/* mgu-deploy keeps an entry */';
var KEEP_CLASS_ANCHOR = 'class AppRegistry extends events.EventEmitter{';
var KEEP_ANCHOR = 'app.unpersist().catch(()=>logger.debug("No persistency file to delete, ignoring."))';
var KEEP_STUB_ANCHOR = 'this[methodName]=((...args)=>this._callMethod(methodName,...args))';
var CONTROLLER_ANCHOR = 'this.queuedRecursiveRetry=makeMethodQueued_1.makeMethodQueued(this,this.queuedRecursiveRetry,!0)';

/* The flags an entry does not name: idrive7-apps' installer lists its apps
 * in the same file with "-appStartType" and "-userLoginRequired" alone. */
var DEFAULT_FLAGS = { '-enabled': 'true', '-allowed': 'true', '-appStartType': 'manually',
    '-userLoginRequired': 'false', '-updateMechanism': 'PLATFORM' };

/* Runs in the app manager, as global.__mguDeployKeep. A failed app whose
 * entry names a uid whose folder holds the app's own package stays
 * registered on disk: it is held (the stub answers an install of it as
 * already installed, which allocates no uid), and a new App instance tries
 * again after each delay, without holding up the manager's start. The next
 * start loads the entry anyway. Anything else is dropped as the stock
 * manager drops it. */
function keepFactory(dir) {
    return function (registry, app, err, log) {
        var fs = require('fs'), path = require('path'), id = app.getAppId();
        var held = global.__mguDeployHeld || (global.__mguDeployHeld = {});
        var delays = (process.env.MGU_DEPLOY_KEEP_RETRY_MS || '10000,30000,60000').split(',').map(Number);
        function proven() {
            try {
                var uid = JSON.parse(fs.readFileSync(path.join(dir, 'apps', id + '.json'), 'utf8')).userId;
                if (typeof uid !== 'number' || uid % 1 !== 0 || uid <= 0) return 0;
                var pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(dir)), 'oap_' + uid, 'source',
                    'package.json'), 'utf8'));
                return pkg.name === id ? uid : 0;
            } catch (e) { return 0; }
        }
        function note(uid, what, e) {
            try {
                var file = path.join(dir, 'mgu-deploy-init-failures.json'), list = [];
                try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (x) { /* none yet */ }
                if (!Array.isArray(list)) list = [];
                list.push({ at: new Date().toISOString(), app: id, uid: uid, what: what,
                    error: e ? String(e.message || e).slice(0, 400) : null });
                fs.writeFileSync(file + '.tmp', JSON.stringify(list.slice(-40)));
                fs.renameSync(file + '.tmp', file);
            } catch (x) { /* the record never stops the manager */ }
        }
        /* what App.init started; App.shutdown would delete the entry */
        function release(a) {
            [function () { a.removeAllListeners(); },
                function () { return a._appHeartbeatMonitor && a._appHeartbeatMonitor.shutdown(); },
                function () { return a._appStatusProxy && a._appStatusProxy.shutdown(); },
                function () { return a._wodControl && a._wodControl.shutdown(); },
                function () { return a._appUpdateImpl && a._appUpdateImpl.stopService(); }
            ].forEach(function (step) {
                try { Promise.resolve(step()).catch(function () {}); } catch (e) { /* not started */ }
            });
        }
        var uid = proven();
        if (!uid) {
            note(0, 'dropped', err);
            app.unpersist().catch(function () {});
            return;
        }
        held[id] = true;
        note(uid, 'kept', err);
        release(app);
        (function attempt(n) {
            if (n >= delays.length) {
                log.warn('mgu-deploy: ' + id + ' stays held until the next start; its entry is kept');
                return;
            }
            setTimeout(function () {
                var next;
                try { next = registry._appFactory.create(id); } catch (e) { note(uid, 'retry failed', e); attempt(n + 1); return; }
                next.init().then(function () { return next.getUserId(); }).then(function (u) {
                    registry._apps[u] = next;
                    delete held[id];
                    note(u, 'recovered');
                    try { registry.register(id); } catch (e) { log.warn('mgu-deploy: registering ' + id + ': ' + e); }
                    return registry.writeUidAppNameMappingFile();
                }).catch(function (e) {
                    if (!held[id]) { log.warn('mgu-deploy: ' + id + ' recovered, then: ' + e); return; }
                    note(uid, 'retry failed', e);
                    release(next);
                    attempt(n + 1);
                });
            }, delays[n]);
        })(0);
    };
}
function keepSource(listPath) {
    return KEEP_MARK + 'global.__mguDeployKeep=(' + keepFactory.toString() + ')(' +
        JSON.stringify(path.dirname(listPath)) + ');';
}
var KEEP_STUB = 'this[methodName]=((...args)=>"install"===methodName&&global.__mguDeployHeld&&global.__mguDeployHeld[args[0]]?' +
    'Promise.reject(Object.assign(new Error("mgu-deploy: "+args[0]+" has a registry entry"),' +
    '{reason:"APP_ALREADY_INSTALLED",code:"APP_ALREADY_INSTALLED"})):this._callMethod(methodName,...args))';


/* oapcontroller wipes every app at the third MainApp death inside its alive
 * window, and a bounce by mgu-deploy is the first. mgu-deploy records each
 * bounce in the guard file ({boot, bounce: {at, pid, watchMs}}, and the
 * manager it watches after it as watch: {pid, start}); the first load after
 * the bounce claims it (first: {pid, start}). A later load whose process
 * started within watchMs of that claimed or watched manager's start means
 * it died there: the guard, evaluated once as the copy loads, is off and
 * says so in the file (off), and the copy runs as the stock file for the
 * rest of the boot. Without a bounce in this boot, or when the guard
 * cannot read or write its file, it is on. */
function guardSource7(guardPath) {
    return 'const __mguDeployGuard=(()=>{try{const fs=require("fs"),G=' + JSON.stringify(guardPath) +
        ',boot=fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),' +
        'start=Date.now()-Math.round(1e3*process.uptime());let g=null;' +
        'try{g=JSON.parse(fs.readFileSync(G,"utf8"))}catch(e){}' +
        'if(!g||g.boot!==boot)return{on:!0,why:null};' +
        'const b=g.bounce,save=()=>{fs.writeFileSync(G+".tmp",JSON.stringify(g)+"\\n"),fs.renameSync(G+".tmp",G)},' +
        'gone=[g.first,g.watch].filter(m=>m&&m.pid!==process.pid&&b&&start<m.start+b.watchMs)[0];' +
        'let why=g.off||(gone?`MainApp restarted ${Math.round((start-gone.start)/1e3)}s after mgu-deploy restarted it`:null);' +
        'why?g.off||(g.off=why,save()):b&&!g.first&&start>=b.at-2e3&&(g.first={pid:process.pid,start:start},save());' +
        'return{on:!why,why:why}}catch(e){return{on:!0,why:null}}})();global.__mguDeployGuard=__mguDeployGuard;';
}
function helperSource(listPath) {
    return MARK + guardSource7(path.join(path.dirname(listPath), 'mgu-deploy-guard.json')) +
        'const __mguDeployFallbackList=()=>{try{' +
        'const c=JSON.parse(require("fs").readFileSync(' + JSON.stringify(listPath) + ',"utf8"));' +
        'return c&&typeof c==="object"?Object.keys(c).reduce((o,id)=>(o[id]=Object.assign({},' +
        JSON.stringify(DEFAULT_FLAGS) + ',c[id]),o),{}):{}}catch(e){return{}}};' +
        'const __mguDeployFallbackApps=()=>{const c=__mguDeployFallbackList();' +
        'return Object.keys(c).map(id=>Object.assign({"#text":id,"-supportedECUs":"HU,RSE_LEFT,RSE_RIGHT"},c[id]))};';
}
var HOOK = 'if(!__mguDeployGuard.on);else if(isMainapp&&section===mainAppSection){' +
    'const __have=((newProvisioning.installable_apps||{}).app||[]);' +
    'const __haveList=Array.isArray(__have)?__have:[__have];' +
    'const __missing=__mguDeployFallbackApps().filter(a=>!__haveList.some(h=>h["#text"]===a["#text"]));' +
    '__missing.length&&(newProvisioning.installable_apps={app:__haveList.concat(__missing)})}' +
    'else if(isMainapp&&(!newProvisioning||typeof newProvisioning!=="object"||!Object.keys(newProvisioning).length)){' +
    'const __own=__mguDeployFallbackList()[section];' +
    '__own&&typeof __own==="object"&&(newProvisioning=Object.assign({},__own))}' +
    MARK + ';';

/* Runs in the app manager once MainApp has initialized, with main.js's own
 * appManager (AppManagementController; on MainApp 6.5.5, which has none,
 * the AppManagerStub itself), appRegistry and logger. It writes
 * the status file {pid, start, at, state: "ready"} and polls the request
 * file each second. A request, {id, app, action: "install"|"update"|"uninstall",
 * notAfter}, counts only in a folder and file owned by root (or the
 * manager) that no group or other user can write. One runs at a time:
 * the status file answers it with its id, "running" and then "done" or
 * "failed"; "refused" when it is past notAfter, malformed, or the app's
 * registration does not match the action. It runs the manager's own
 * install(app), update(app, "PLATFORM"), which takes a newer package from
 * preinstalled_apps, or uninstall(app), which stops the app, unregisters
 * it (its tile goes) and removes its folders; each touches only that app.
 * Nothing in it throws into the manager.
 *
 * It also traces the manager's installer (AppManagerStub: appManager's
 * own appManager, or appManager itself): each install, update or uninstall it queues ("q") and
 * each call it runs in its AppManagement child ("run", with
 * getLatestAvailableVersion), with app, start, end and error: the last 12
 * of the requested app's and of the others' each; and when it started
 * that child (early: a start already under way when the hook came up). While a request runs, the status file
 * carries that trace each second, with the manager's network-retry count
 * and whether a retry delay or an NSM resume is pending. */
/* iDrive 7: the AppManagerStub is the controller's appManager, or on
 * MainApp 6.5.5, which has no controller (ID7_NO_CONTROLLER), the hook's
 * appManager itself. */
var ID7 = { start: 'const g=global.__mguDeployGuard;if(g&&!g.on)return void put({state:"off",why:g.why});', stub: '_', installer: 'mgr&&mgr.appManager', run: '"update"===r.action?mgr.update(r.app,"PLATFORM"):' +
    '"uninstall"===r.action?mgr.uninstall(r.app):mgr.install(r.app)', args: '(appManager,appRegistry,logger)' };
var ID7_NO_CONTROLLER = Object.assign({}, ID7, { installer: 'mgr&&(mgr.appManager||mgr)' });
/* MainApp-21: its provisioning handler's anchor, the hook's (the start-up's
 * init, whose resolution the hook follows), the AppManagerStub's member
 * names without the underscore, the controller's calls with their options,
 * and its appManager and appRegistry from MainApp itself. The hook comes up
 * only while the guard (guardSource) lets it, else it writes the status
 * file {state: "off", why} and takes no request. */
var ID8 = { hookAnchor: 'this.isMainapp&&section===this.mainappSection&&(newProvisioning.',
    inplaceAnchor: 'Promise.all([mainApp.init()])', stub: '', installer: 'mgr&&mgr.appManager',
    start: 'const g=global.__mguDeployGuard;if(!g||!g.on)return void put({state:"off",why:g?g.why:"no guard"});setTimeout(g.ready,6e4);',
    run: '"update"===r.action?mgr.update(r.app,{updateType:"PLATFORM",requestSource:"PREINSTALLED"}):' +
        '"uninstall"===r.action?mgr.uninstall(r.app):mgr.install(r.app,{requestSource:"PREINSTALLED"})',
    args: '(mainApp.appManager,mainApp.appRegistry,logger)' };
var HOOK_21 = 'try{if(__mguDeployGuard.on&&this.isMainapp&&section!==this.mainappSection&&' +
    '(!newProvisioning||typeof newProvisioning!=="object"||!Object.keys(newProvisioning).length)){' +
    'const __own=__mguDeployFallbackList()[section];' +
    '__own&&typeof __own==="object"&&(newProvisioning=Object.assign({},__own),__mguDeployFilled(section))}}catch(__e){}' + MARK + ';';
/* MainApp-21's crash handling (oapcontroller) wipes every app's ACLs and
 * data on the third crash in a row (a MainApp-21 up 30 s ends the row), so
 * a MainApp-21 that restarted on the copy in a way the copy may have caused
 * runs it as the stock file for the rest of the boot: the guard, evaluated
 * once as the copy loads, is off when an earlier load in this boot ended
 * less than a minute after its hook came up (or before), or while an
 * in-place change it had taken was running (the status file says
 * "running", written in this boot by another pid). Off, the fallback
 * and the hook do nothing; the guard file (beside the status file,
 * {boot, loads, ready, off}) keeps it off until the next boot. A guard
 * file missing or unreadable starts the boot over; a guard that cannot
 * write it, or read the boot id, is off. */
function guardSource(guardPath, statusPath) {
    return 'const __mguDeployGuard=(()=>{try{const fs=require("fs"),G=' + JSON.stringify(guardPath) +
        ',boot=fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),' +
        'booted=Date.now()-1e3*require("os").uptime();let g=null,st=null;' +
        'try{g=JSON.parse(fs.readFileSync(G,"utf8"))}catch(e){}' +
        'g&&g.boot===boot||(g={boot:boot,loads:0,ready:0});' +
        'try{st=JSON.parse(fs.readFileSync(' + JSON.stringify(statusPath) + ',"utf8"))}catch(e){}' +
        'const why=g.off||(g.loads>g.ready?"MainApp-21 restarted within a minute of its start":' +
        'st&&"running"===st.state&&st.pid!==process.pid&&st.at>booted?' +
        '`MainApp-21 restarted during the in-place ${st.action} of ${st.app}`:null),' +
        'save=()=>{fs.writeFileSync(G+".tmp",JSON.stringify(g)+"\\n"),fs.renameSync(G+".tmp",G)};' +
        'why?g.off=why:g.loads++,save();' +
        'return{on:!why,why:why,ready:()=>{try{g.ready=g.loads,save()}catch(e){}}}}' +
        'catch(e){return{on:!1,why:"its guard failed ("+e+")",ready:()=>{}}}})();' +
        'global.__mguDeployGuard=__mguDeployGuard;';
}
/* The sections the fallback filled in this MainApp-21, each once, in
 * mgu-deploy-listed.json beside custom_apps.json ({pid, apps}): status
 * reads from it whether an app the provisioning has no section for has
 * its tile. */
function filledSource(recordPath) {
    return 'const __mguDeployFilledApps=[],__mguDeployFilled=s=>{try{if(__mguDeployFilledApps.indexOf(s)>=0)return;' +
        '__mguDeployFilledApps.push(s);const fs=require("fs"),F=' + JSON.stringify(recordPath) + ';' +
        'fs.writeFileSync(F+".tmp",JSON.stringify({pid:process.pid,apps:__mguDeployFilledApps})+"\\n"),fs.renameSync(F+".tmp",F)}catch(e){}};';
}
function helperSource21(listPath, guardPath, statusPath) {
    return MARK + guardSource(guardPath, statusPath) + filledSource(path.join(path.dirname(listPath), 'mgu-deploy-listed.json')) +
        'const __mguDeployFallbackList=()=>{try{' +
        'const c=JSON.parse(require("fs").readFileSync(' + JSON.stringify(listPath) + ',"utf8"));' +
        'return c&&typeof c==="object"?Object.keys(c).reduce((o,id)=>(c[id]&&typeof c[id]==="object"&&' +
        '(o[id]=Object.assign({},' + JSON.stringify(DEFAULT_FLAGS) + ',c[id])),o),{}):{}}catch(e){return{}}};';
}

/* The tracing of the manager's installer (AppManagerStub's members with
 * the prefix s): each install, update or uninstall it queues and each call
 * it runs, and its child's start. */
function tracerSource(s) {
    return '' +
        'if(stub&&"function"==typeof stub.' + s + 'callMethod){' +
        '["install","update","uninstall"].forEach(m=>{const f=stub[m];"function"==typeof f&&(stub[m]=' +
        'function(app){return end(add({k:"q",m:m,app:String(app),t:Date.now()}),f.apply(this,arguments))})});' +
        'const cm=stub.' + s + 'callMethod;stub.' + s + 'callMethod=function(m,app){' +
        'return end(add({k:"run",m:String(m),app:String(app),t:Date.now()}),cm.apply(this,arguments))};' +
        'const fk=stub.' + s + 'fork;"function"==typeof fk&&(stub.' + s + 'fork=function(){' +
        'const fresh=!this.' + s + 'forkPromise&&!this.' + s + 'childProcess,p=fk.apply(this,arguments);' +
        'return fresh?end(tr.fork={t:Date.now()},p):p});' +
        'stub.' + s + 'forkPromise&&(tr.fork={t:Date.now(),early:!0},end(tr.fork,stub.' + s + 'forkPromise))}';
}

function inplaceSource(requestPath, statusPath, v) {
    var s = v.stub;
    return INPLACE_MARK + 'try{(function(mgr,registry,log){' +
        'const fs=require("fs"),REQ=' + JSON.stringify(requestPath) +
        ',DIR=' + JSON.stringify(path.dirname(requestPath)) + ',OUT=' + JSON.stringify(statusPath) +
        ',start=Date.now()-Math.round(1e3*process.uptime());let last=null,busy=!1,cur=null;' +
        'const stub=' + v.installer + ',ops=[],reqOps=[],tr={fork:null},' +
        'cap=a=>{if(a.length>12){const i=a.findIndex(x=>x.end);a.splice(i<0?0:i,1)}},' +
        'add=o=>{const a=busy&&cur&&o.app===cur.app?reqOps:ops;return a.push(o),cap(a),o},' +
        'end=(o,p)=>(Promise.resolve(p).then(()=>{o.end=Date.now()},e=>{o.end=Date.now(),' +
        'o.err=String(e&&(e.reason||e.message)||e)}),p),' +
        'trace=()=>({ops:reqOps.concat(ops).sort((a,b)=>a.t-b.t),fork:tr.fork,child:!!(stub&&stub.' + s + 'childProcess),retries:mgr&&mgr.retries,' +
        'backoff:!!(mgr&&mgr.clearBackOff),resuming:!!(stub&&stub.' + s + 'resumePromise)});' +
        (v.start ? '' : tracerSource(s)) +
        'const put=o=>{try{fs.writeFileSync(OUT+".tmp",JSON.stringify(Object.assign(' +
        '{pid:process.pid,start:start,at:Date.now()},o))+"\\n");fs.renameSync(OUT+".tmp",OUT)}catch(e){}},' +
        'own=(p,dir)=>{const s=fs.lstatSync(p);return(dir?s.isDirectory():s.isFile())&&' +
        '(0===s.uid||s.uid===process.getuid())&&!(18&s.mode)},' +
        'tell=(r,state,why)=>{cur={request:r.id,app:r.app,action:r.action,state:state,error:why||null,' +
        'taken:"running"===state?Date.now():cur&&cur.request===r.id?cur.taken:null};' +
        'put(Object.assign({trace:trace()},cur));' +
        'try{log.info(`mgu-deploy in-place ${r.action} ${r.app}: ${state}${why?" ("+why+")":""}`)}catch(e){}},' +
        'poll=()=>{if(busy)return;let r;try{if(!own(DIR,!0)||!own(REQ,!1))return;' +
        'r=JSON.parse(fs.readFileSync(REQ,"utf8"))}catch(e){return}' +
        'if(!r||"string"!=typeof r.id||r.id===last)return;last=r.id;' +
        'if(!(Date.now()<=r.notAfter))return tell(r,"refused","expired");' +
        'if("string"!=typeof r.app||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.app)||' +
        '"install"!==r.action&&"update"!==r.action&&"uninstall"!==r.action)return tell(r,"refused","malformed");' +
        'if(!registry.getById(r.app)!==("install"===r.action))' +
        'return tell(r,"refused","install"===r.action?"already registered":"not registered");' +
        'busy=!0,reqOps.length=0,tell(r,"running");' +
        'Promise.resolve().then(()=>' + v.run + ')' +
        '.then(()=>{busy=!1,tell(r,"done")},e=>{busy=!1,tell(r,"failed",String(e&&(e.reason||e.message)||e))})};' +
        (v.start ? v.start + tracerSource(s) : '') + 'put({state:"ready"}),setInterval(()=>{try{poll(),busy&&cur&&put(Object.assign({trace:trace()},cur))}catch(e){}},1e3)' +
        '})' + v.args + '}catch(e){}' + INPLACE_MARK + ';';
}

/* Our apps first in AppManagementController's queue (iDrive 7). MainApp's
 * own queue module gets global.__mguDeployFirst(controller, queued): it wraps the
 * controller's queued queuedRecursiveRetry, which every install and update
 * goes through (start-up, provisioning, the in-place hook, a failed try
 * queued again). A call for an app custom_apps.json lists (read at each
 * call) has its queue entry moved from the end to right behind the entry
 * running and the ones of ours moved before it (ours keep their order);
 * the entry running is never touched. When it runs, the controller's
 * network-retry count is 0, so it does not wait out the delay another
 * app's failures left (install() and update() clear only a delay already
 * under way). A call that lands first in an empty queue is already
 * started, and reads the count on the next tick, so the count is reset at
 * once. Only a call's first entry moves: one of ours that fails and
 * is queued again (the same options) goes to the end with MainApp's own
 * delay, so it cannot keep the others waiting. Nothing in it throws into the manager: on any error the
 * call stays where MainApp put it. */
function firstSources(listPath) {
    return { queue: 'try{global.__mguDeployFirst=(ctl,queued)=>function(resolve,reject,options){' +
        'const p=queued.apply(this,arguments);' +
        'try{const app=options&&options.appId,g=global.__mguDeployGuard;if("string"!=typeof app||options.__mguDeployFirst||g&&!g.on)return p;' +
        'let ours;try{ours=JSON.parse(require("fs").readFileSync(' + JSON.stringify(listPath) + ',"utf8"))}catch(e){return p}' +
        'if(!ours||"object"!=typeof ours||!Object.prototype.hasOwnProperty.call(ours,app))return p;' +
        'const q=getQueueDataForContext(ctl).queue,i=q.findIndex(x=>x.promise===p);if(i<0)return p;' +
        'const it=q[i],fn=it.fn;let at=1;for(;at<i&&q[at].__mguDeployFirst;)at++;' +
        'options.__mguDeployFirst=!0,it.__mguDeployFirst=!0,it.fn=()=>(ctl.retries=0,fn()),i||(ctl.retries=0),' +
        'at<i&&(q.splice(i,1),q.splice(at,0,it),' +
        'logger.info(`mgu-deploy: ${options.method} ${app} queued ahead of ${i-at} other install(s)`))' +
        '}catch(e){}return p}}catch(e){}' + FIRST_MARK + ';',
        controller: ',global.__mguDeployFirst&&(this.queuedRecursiveRetry=' +
            'global.__mguDeployFirst(this,this.queuedRecursiveRetry))' + FIRST_MARK };
}

function once(src, anchor, what) {
    var i = src.indexOf(anchor);
    if (i < 0 || src.indexOf(anchor, i + 1) >= 0) {
        process.stderr.write('fallback_build: anchor for ' + what +
            ' not found exactly once; refusing to build\n');
        process.exit(3);
    }
    return i;
}

function main() {
    var inFile = process.argv[2], outFile = process.argv[3];
    var listPath = process.argv[4] || '/var/opt/public/oap/oap_12201/data/custom_apps.json';
    var requestPath = process.argv[5] || '/var/opt/mgu-deploy/inplace/request.json';
    if (!inFile || !outFile) {
        process.stderr.write('usage: node fallback_build.js <stock main.js> <copy out> ' +
            '[custom_apps.json [in-place request file]]\n');
        return 2;
    }
    var src = fs.readFileSync(inFile, 'utf8');
    if (src.indexOf(MARK) >= 0 || src.indexOf(INPLACE_MARK) >= 0 || src.indexOf(FIRST_MARK) >= 0) {
        process.stderr.write('fallback_build: input already carries the fallback; refusing to build\n');
        return 3;
    }
    var statusPath = path.join(path.dirname(listPath), 'mgu-deploy-inplace.json'), hook = true, first = true, keep = true;
    var id8 = src.indexOf(ID8.hookAnchor) >= 0;
    if (id8 && src.indexOf(HOOK_ANCHOR) >= 0) {
        process.stderr.write('fallback_build: both MainApp variants\' anchors occur; refusing to build\n');
        return 3;
    }
    if (id8) {
        var h8 = once(src, ID8.hookAnchor, 'the provisioning hook');
        once(src, CLASS_ANCHOR, 'the ProvisioningNotifier class');
        once(src, ID8.inplaceAnchor, 'the in-place install hook');
        src = src.slice(0, h8) + HOOK_21 + src.slice(h8);
        var c8 = src.indexOf(CLASS_ANCHOR);
        src = src.slice(0, c8) + helperSource21(listPath, path.join(path.dirname(listPath), 'mgu-deploy-guard.json'),
            statusPath) + src.slice(c8);
        var p8 = src.indexOf(ID8.inplaceAnchor) + ID8.inplaceAnchor.length;
        src = src.slice(0, p8) + '.then(__mguInit=>{' + inplaceSource(requestPath, statusPath, ID8) +
            'return __mguInit})' + src.slice(p8);
    } else {
        var h = once(src, HOOK_ANCHOR, 'the installable_apps hook');
        src = src.slice(0, h) + HOOK + src.slice(h);
        var c = once(src, CLASS_ANCHOR, 'the ProvisioningNotifier class');
        src = src.slice(0, c) + helperSource(listPath) + src.slice(c);
        var p = src.indexOf(INPLACE_ANCHOR);
        hook = p >= 0 && src.indexOf(INPLACE_ANCHOR, p + 1) < 0;
        if (hook) {
            p += INPLACE_ANCHOR.length;
            src = src.slice(0, p) + inplaceSource(requestPath, statusPath,
                src.indexOf('class AppManagementController{') >= 0 ? ID7 : ID7_NO_CONTROLLER) + src.slice(p);
        }
        var qa = src.indexOf(QUEUE_ANCHOR), ca = src.indexOf(CONTROLLER_ANCHOR);
        first = qa >= 0 && src.indexOf(QUEUE_ANCHOR, qa + 1) < 0 && ca >= 0 && src.indexOf(CONTROLLER_ANCHOR, ca + 1) < 0;
        if (first) {
            var fs7 = firstSources(listPath);
            /* the later anchor first, so the earlier one's offset holds */
            var edits = [{ at: qa + QUEUE_ANCHOR.length, text: fs7.queue }, { at: ca + CONTROLLER_ANCHOR.length, text: fs7.controller }]
                .sort(function (x, y) { return y.at - x.at; });
            edits.forEach(function (e) { src = src.slice(0, e.at) + e.text + src.slice(e.at); });
        }
        keep = [KEEP_CLASS_ANCHOR, KEEP_ANCHOR, KEEP_STUB_ANCHOR].every(function (a) {
            var at = src.indexOf(a);
            return at >= 0 && src.indexOf(a, at + 1) < 0;
        });
        if (keep) {
            src = src.replace(KEEP_ANCHOR, function () { return 'global.__mguDeployKeep(this,app,err,logger)'; });
            src = src.replace(KEEP_STUB_ANCHOR, function () { return KEEP_STUB; });
            src = src.replace(KEEP_CLASS_ANCHOR, function () { return keepSource(listPath) + KEEP_CLASS_ANCHOR; });
        }
    }
    var tmp = outFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, src);
    fs.renameSync(tmp, outFile);
    process.stdout.write('fallback copy built: ' + outFile + '\n');
    if (!hook) {
        process.stdout.write('fallback_build: anchor for the in-place install hook not found exactly once; ' +
            'the copy has no hook, so app installs bounce the manager\n');
    }
    if (!id8 && !first) {
        process.stdout.write('fallback_build: anchors for our apps first in the install queue not found exactly once; ' +
            'the copy leaves the queue as it is\n');
    }
    if (!id8 && !keep) {
        process.stdout.write('fallback_build: anchors for keeping a registry entry not found exactly once; ' +
            'the copy leaves a failed app to the manager\n');
    }
    return 0;
}

try {
    process.exit(main());
} catch (e) {
    process.stderr.write('fallback_build: ' + e.message + '\n');
    process.exit(1);
}
