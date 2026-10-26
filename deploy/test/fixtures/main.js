"use strict";
// Stand-in for the app manager's main.js: each fallback anchor once, around
// a provisioning handler reduced to what the hook sees: a section and its
// parsed provisioning (undefined when provisioning has no such section).
// The tests require the built copy and call handle(), or start(): start-up
// reduced to the step after the manager's init, with its appManager,
// appRegistry and logger.
const isMainapp=!0,mainAppSection="main_app";
class ProvisioningNotifier {
handle(section,newProvisioning){isMainapp&&section===mainAppSection&&(newProvisioning.installable_apps=newProvisioning.installable_apps||{app:[]});return newProvisioning}}
function start(appManager,appRegistry,logger){const mainApp={init:()=>Promise.resolve()};
return Promise.resolve().then(()=>{return mainApp.init()}).then(()=>{})}
module.exports=ProvisioningNotifier;module.exports.start=start;
