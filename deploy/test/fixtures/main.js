"use strict";
// Stand-in for the app manager's main.js: each fallback anchor once, around
// ProvisioningNotifier's provisioningHandler reduced to what the hook sees:
// a section and its parsed provisioning (undefined when provisioning has no
// such section). The tests require the built copy and call handle(), or
// start(): main's start-up reduced to the step after MainApp's init, with
// main's appManager, appRegistry and logger.
const events_1={EventEmitter:class{}};const isMainapp=!0,mainAppSection="main_app";
class ProvisioningNotifier extends events_1.EventEmitter{constructor(){super()}
handle(section,newProvisioning){isMainapp&&section===mainAppSection&&(newProvisioning.installable_apps=newProvisioning.installable_apps||{app:[]});return newProvisioning}}
function start(appManager,appRegistry,logger){const kpiLogger={info(){}},mainApp={init:()=>Promise.resolve()};
return Promise.resolve().then(()=>{return kpiLogger.info("MARKER All components instantiated. Initializing."),mainApp.init()}).then(()=>{logger.info("main::main oap-mainapp initialized.")})}
module.exports=ProvisioningNotifier;module.exports.start=start;
