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
 */
var fs = require('fs');
var path = require('path');

var MARK = '/* mgu-deploy provisioning fallback */';
var CLASS_ANCHOR = 'class ProvisioningNotifier ';
var HOOK_ANCHOR = 'isMainapp&&section===mainAppSection&&(newProvisioning.';
var INPLACE_MARK = '/* mgu-deploy in-place install */';
var INPLACE_ANCHOR = 'mainApp.init()}).then(()=>{';

/* The flags an entry does not name: idrive7-apps' installer lists its apps
 * in the same file with "-appStartType" and "-userLoginRequired" alone. */
var DEFAULT_FLAGS = { '-enabled': 'true', '-allowed': 'true', '-appStartType': 'manually',
    '-userLoginRequired': 'false', '-updateMechanism': 'PLATFORM' };

function helperSource(listPath) {
    return MARK +
        'const __mguDeployFallbackList=()=>{try{' +
        'const c=JSON.parse(require("fs").readFileSync(' + JSON.stringify(listPath) + ',"utf8"));' +
        'return c&&typeof c==="object"?Object.keys(c).reduce((o,id)=>(o[id]=Object.assign({},' +
        JSON.stringify(DEFAULT_FLAGS) + ',c[id]),o),{}):{}}catch(e){return{}}};' +
        'const __mguDeployFallbackApps=()=>{const c=__mguDeployFallbackList();' +
        'return Object.keys(c).map(id=>Object.assign({"#text":id,"-supportedECUs":"HU,RSE_LEFT,RSE_RIGHT"},c[id]))};';
}
var HOOK = 'if(isMainapp&&section===mainAppSection){' +
    'const __have=((newProvisioning.installable_apps||{}).app||[]);' +
    'const __haveList=Array.isArray(__have)?__have:[__have];' +
    'const __missing=__mguDeployFallbackApps().filter(a=>!__haveList.some(h=>h["#text"]===a["#text"]));' +
    '__missing.length&&(newProvisioning.installable_apps={app:__haveList.concat(__missing)})}' +
    'else if(isMainapp&&(!newProvisioning||typeof newProvisioning!=="object"||!Object.keys(newProvisioning).length)){' +
    'const __own=__mguDeployFallbackList()[section];' +
    '__own&&typeof __own==="object"&&(newProvisioning=Object.assign({},__own))}' +
    MARK + ';';

/* Runs in the app manager once MainApp has initialized, with main.js's own
 * appManager (AppManagementController), appRegistry and logger. It writes
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
 * It also traces the manager's installer (AppManagerStub, appManager's
 * own appManager): each install, update or uninstall it queues ("q") and
 * each call it runs in its AppManagement child ("run", with
 * getLatestAvailableVersion), with app, start, end and error: the last 12
 * of the requested app's and of the others' each; and when it started
 * that child (early: a start already under way when the hook came up). While a request runs, the status file
 * carries that trace each second, with the manager's network-retry count
 * and whether a retry delay or an NSM resume is pending. */
function inplaceSource(requestPath, statusPath) {
    return INPLACE_MARK + 'try{(function(mgr,registry,log){' +
        'const fs=require("fs"),REQ=' + JSON.stringify(requestPath) +
        ',DIR=' + JSON.stringify(path.dirname(requestPath)) + ',OUT=' + JSON.stringify(statusPath) +
        ',start=Date.now()-Math.round(1e3*process.uptime());let last=null,busy=!1,cur=null;' +
        'const stub=mgr&&mgr.appManager,ops=[],reqOps=[],tr={fork:null},' +
        'cap=a=>{if(a.length>12){const i=a.findIndex(x=>x.end);a.splice(i<0?0:i,1)}},' +
        'add=o=>{const a=busy&&cur&&o.app===cur.app?reqOps:ops;return a.push(o),cap(a),o},' +
        'end=(o,p)=>(Promise.resolve(p).then(()=>{o.end=Date.now()},e=>{o.end=Date.now(),' +
        'o.err=String(e&&(e.reason||e.message)||e)}),p),' +
        'trace=()=>({ops:reqOps.concat(ops).sort((a,b)=>a.t-b.t),fork:tr.fork,child:!!(stub&&stub._childProcess),retries:mgr&&mgr.retries,' +
        'backoff:!!(mgr&&mgr.clearBackOff),resuming:!!(stub&&stub._resumePromise)});' +
        'if(stub&&"function"==typeof stub._callMethod){' +
        '["install","update","uninstall"].forEach(m=>{const f=stub[m];"function"==typeof f&&(stub[m]=' +
        'function(app){return end(add({k:"q",m:m,app:String(app),t:Date.now()}),f.apply(this,arguments))})});' +
        'const cm=stub._callMethod;stub._callMethod=function(m,app){' +
        'return end(add({k:"run",m:String(m),app:String(app),t:Date.now()}),cm.apply(this,arguments))};' +
        'const fk=stub._fork;"function"==typeof fk&&(stub._fork=function(){' +
        'const fresh=!this._forkPromise&&!this._childProcess,p=fk.apply(this,arguments);' +
        'return fresh?end(tr.fork={t:Date.now()},p):p});' +
        'stub._forkPromise&&(tr.fork={t:Date.now(),early:!0},end(tr.fork,stub._forkPromise))}' +
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
        'Promise.resolve().then(()=>"update"===r.action?mgr.update(r.app,"PLATFORM"):' +
        '"uninstall"===r.action?mgr.uninstall(r.app):mgr.install(r.app))' +
        '.then(()=>{busy=!1,tell(r,"done")},e=>{busy=!1,tell(r,"failed",String(e&&(e.reason||e.message)||e))})};' +
        'put({state:"ready"}),setInterval(()=>{try{poll(),busy&&cur&&put(Object.assign({trace:trace()},cur))}catch(e){}},1e3)' +
        '})(appManager,appRegistry,logger)}catch(e){}' + INPLACE_MARK + ';';
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
    if (src.indexOf(MARK) >= 0 || src.indexOf(INPLACE_MARK) >= 0) {
        process.stderr.write('fallback_build: input already carries the fallback; refusing to build\n');
        return 3;
    }
    var h = once(src, HOOK_ANCHOR, 'the installable_apps hook');
    src = src.slice(0, h) + HOOK + src.slice(h);
    var c = once(src, CLASS_ANCHOR, 'the ProvisioningNotifier class');
    src = src.slice(0, c) + helperSource(listPath) + src.slice(c);
    var p = src.indexOf(INPLACE_ANCHOR), hook = p >= 0 && src.indexOf(INPLACE_ANCHOR, p + 1) < 0;
    if (hook) {
        p += INPLACE_ANCHOR.length;
        src = src.slice(0, p) + inplaceSource(requestPath,
            path.join(path.dirname(listPath), 'mgu-deploy-inplace.json')) + src.slice(p);
    }
    var tmp = outFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, src);
    fs.renameSync(tmp, outFile);
    process.stdout.write('fallback copy built: ' + outFile + '\n');
    if (!hook) {
        process.stdout.write('fallback_build: anchor for the in-place install hook not found exactly once; ' +
            'the copy has no hook, so app installs bounce the manager\n');
    }
    return 0;
}

try {
    process.exit(main());
} catch (e) {
    process.stderr.write('fallback_build: ' + e.message + '\n');
    process.exit(1);
}
