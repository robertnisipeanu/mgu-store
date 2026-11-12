"use strict";
// Stand-in for the app manager's main.js around its registry: the fallback
// anchors as in main.js, AppRegistry's load of its entries and the
// AppManagerStub's calls into its child, each reduced to what the edit that
// keeps an entry sees. The tests require it, stock and built.
const isMainapp=!0,mainAppSection="main_app",events=require("events");
const logger={warn:m=>(global.__fixtureLog=global.__fixtureLog||[]).push(m),debug:()=>{}};
class ProvisioningNotifier {
handle(section,newProvisioning){isMainapp&&section===mainAppSection&&(newProvisioning.installable_apps=newProvisioning.installable_apps);return newProvisioning}}
class AppRegistry extends events.EventEmitter{constructor(options){super(),this._appStorage=options.appStorage,this._appFactory=options.appFactory,this._apps=Object.create(null)}
init(){return this._initAppsFromStorage()}
_initAppsFromStorage(){const logPrefix="AppRegistry::_initAppsFromStorage";return this._appStorage.getAllIdentifiers().then(appIdentifiers=>appIdentifiers.map(appId=>this._appFactory.create(appId))).then(restoredApps=>Promise.all(restoredApps.map(app=>app.init().then(()=>app.getUserId()).then(uid=>this._apps[uid]=app).catch(err=>{logger.warn(`${logPrefix} package.json for appId `+`${app.getAppId()} is not readable. Error due to ${err}. `+"Ignoring App"),app.unpersist().catch(()=>logger.debug("No persistency file to delete, ignoring."))}))))}
register(appId){this.emit("registered",appId)}
writeUidAppNameMappingFile(){return Promise.resolve()}}
class AppManagerStub{constructor(call){this._callMethod=call,["install","update","uninstall"].forEach(methodName=>{this[methodName]=((...args)=>this._callMethod(methodName,...args))})}}
module.exports=ProvisioningNotifier;module.exports.AppRegistry=AppRegistry;module.exports.AppManagerStub=AppManagerStub;
