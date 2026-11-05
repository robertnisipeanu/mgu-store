'use strict';
/**
 * The app manager's node child with the in-place hook, for the deploy
 * tests: node fake_inplace.js <fallback copy>. It becomes the running
 * manager (its pid in $FAKE_MGR_PIDFILE and $FAKE_MGR_PIDFILE.inplace,
 * /proc/<pid>/stat started now) and runs the copy's start() with an
 * appManager whose install, update and uninstall are fake_manager.js's, an
 * appRegistry that reads the registry entries, and a logger writing to
 * $FAKE_MGR_LOG. It runs until killed (a bounce kills it).
 *
 * $FAKE_INPLACE: "fail" rejects every install, update and uninstall (with
 * $FAKE_INPLACE_ERROR as the error's text when set, else a reason,
 * $FAKE_INPLACE_REASON or FAKE_FAILURE), "hang"
 * never settles them, "refuse" has the registry name every app (an install is
 * refused), "self" starts installing an app custom_apps.json lists by
 * itself when the hook first looks it up, registered but without its
 * installationSource, which it sets 1.5 s later (the hook refuses the
 * install meanwhile), "failafter" installs or updates and then rejects
 * with $FAKE_INPLACE_REASON, "reject" has the installer reject each
 * install and update as MainApp's does when generateSomeipInterfaces
 * refuses the manifest: an update after it unregistered the app and
 * removed its folders (fake_manager.js rejectedUpdate), an install with
 * nothing left, both with $FAKE_INPLACE_REASON or UPDATE_FAILED, "blink"
 * leaves the pid file empty for 400 ms at the start of each install or
 * update (no manager in ps), "respawn" puts another pid in the pid file at
 * the start of each install or update (oapcontroller respawned the
 * manager) and never settles it, "deaf" announces the hook but never reads
 * a request, "late" announces it 1.5 s after the start.
 * $FAKE_MGR_PASS_MS: the start-up provisioning pass that many ms after the
 * start (fake_manager.js startupPass).
 * $FAKE_INPLACE_PROVISIONED: an update of an app that neither
 * custom_apps.json nor $FAKE_MGR_SECTIONS listed at this start is refused
 * as MainApp refuses a disabled app's.
 *
 * On a fake iDrive 8 ($FAKE_MGR_DIR oap-mainapp21) it is MainApp-21: the
 * stub's members have no underscore, and the controller takes install(id,
 * {requestSource}) and update(id, {updateType, requestSource}), failing
 * any call that does not ask for the preinstalled package.
 */
const fs = require('fs');
const path = require('path');
const fake = require('./fake_manager.js');

const env = process.env;
const mode = env.FAKE_INPLACE || '';
const btime = Number(/btime (\d+)/.exec(fs.readFileSync(env.MGU_DEPLOY_PROC_STAT, 'utf8'))[1]);
const stat = path.join(env.MGU_DEPLOY_PROC, String(process.pid), 'stat');
fs.mkdirSync(path.dirname(stat), { recursive: true });
fs.writeFileSync(stat, `${process.pid} (node) S 1 ${process.pid} ${process.pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ` +
    `${Math.round((Date.now() / 1000 - btime) * 100)} 0 0\n`);
fs.writeFileSync(`${env.FAKE_MGR_PIDFILE}.inplace`, String(process.pid));
fs.writeFileSync(env.FAKE_MGR_PIDFILE, String(process.pid));

const data = path.join(env.MGU_DEPLOY_OAP, 'oap_12201', 'data');
const entry = (id) => path.join(data, 'apps', `${id}.json`);
const listed = (id) => {
    try { return id in JSON.parse(fs.readFileSync(path.join(data, 'custom_apps.json'), 'utf8')); } catch (e) { return false; }
};
const listedAtStart = (() => {
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { return {}; } };
    return Object.assign({}, env.FAKE_MGR_SECTIONS ? read(env.FAKE_MGR_SECTIONS) : {}, read(path.join(data, 'custom_apps.json')));
})();
const appRegistry = {
    getById: (id) => {
        if (mode === 'self' && !fs.existsSync(entry(id)) && listed(id) && fake.install(id, ' on its own', null)) {
            setTimeout(() => {
                const e = JSON.parse(fs.readFileSync(entry(id), 'utf8'));
                fs.writeFileSync(entry(id), JSON.stringify(Object.assign(e, { installationSource: 'PREINSTALLED' })));
                fake.log(`finished ${id} on its own`);
            }, 1500);
        }
        return mode === 'refuse' || fs.existsSync(entry(id)) ? { id } : null;
    }
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (fn) => {
    if (mode === 'fail') {
        return Promise.reject(env.FAKE_INPLACE_ERROR ? new Error(env.FAKE_INPLACE_ERROR) :
            Object.assign(new Error('fake failure'), { reason: env.FAKE_INPLACE_REASON || 'FAKE_FAILURE' }));
    }
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'respawn') {
        const pid = process.pid + 900000;
        fs.mkdirSync(path.join(env.MGU_DEPLOY_PROC, String(pid)), { recursive: true });
        fs.writeFileSync(path.join(env.MGU_DEPLOY_PROC, String(pid), 'stat'), `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ` +
            `${Math.round((Date.now() / 1000 - btime) * 100)} 0 0\n`);
        fs.writeFileSync(env.FAKE_MGR_PIDFILE, String(pid));
        return new Promise(() => {});
    }
    if (mode === 'reject') {
        return delay(100).then(fn).then(() => {
            throw Object.assign(new Error('fake rejection'), { reason: env.FAKE_INPLACE_REASON || 'UPDATE_FAILED' });
        });
    }
    if (mode === 'blink') {
        fs.writeFileSync(env.FAKE_MGR_PIDFILE, '');
        return delay(400).then(() => fs.writeFileSync(env.FAKE_MGR_PIDFILE, String(process.pid))).then(fn);
    }
    if (mode === 'failafter') {
        return delay(100).then(fn).then(() => {
            throw Object.assign(new Error('fake failure after the install'), { reason: env.FAKE_INPLACE_REASON });
        });
    }
    return delay(100).then(fn);
};
/* The installer, as MainApp's AppManagerStub: install, update and
 * uninstall are queued, and run through _callMethod in an AppManagement child that
 * _fork starts ($FAKE_INPLACE_FORK_MS). */
const id8 = env.FAKE_MGR_DIR === 'oap-mainapp21';
const u = id8 ? '' : '_';
const preinstalled = (opts) => !id8 || (opts && opts.requestSource === 'PREINSTALLED');
let stubQueue = Promise.resolve();
const work = {
    install: (id, opts) => settle(() => {
        if (mode === 'reject') return;
        if (!preinstalled(opts) || fake.install(id, ' in place') === null) throw new Error(`no package for ${id}`);
    }),
    update: (id, mechanism) => settle(() => {
        if (env.FAKE_INPLACE_PROVISIONED && !(id in listedAtStart)) {
            throw new Error(`AppManagerStub::_callMethod appManager.update(${id}, PLATFORM,) failed due to Error: ` +
                `AppManager::update (${id}, PLATFORM, null) ${id} has been disabled (enabled = false / allowed = false)..`);
        }
        if (mode === 'reject') {
            fake.rejectedUpdate(id);
            return;
        }
        const platform = id8 ? preinstalled(mechanism) && mechanism.updateType === 'PLATFORM' : mechanism === 'PLATFORM';
        if (!platform || !fake.update(id, ' in place')) throw new Error(`no update for ${id}`);
    }),
    uninstall: (id) => settle(() => {
        if (!fake.uninstall(id, ' in place')) throw Object.assign(new Error(`${id} not installed`), { reason: 'APP_NOT_INSTALLED' });
    }),
    other: () => delay(Number(env.FAKE_INPLACE_AHEAD_MS || 0))
};
const stub = {};
stub[`${u}childProcess`] = null;
stub[`${u}forkPromise`] = null;
stub[`${u}fork`] = function () {
    if (this[`${u}childProcess`]) return Promise.resolve();
    if (!this[`${u}forkPromise`]) {
        this[`${u}forkPromise`] = delay(Number(env.FAKE_INPLACE_FORK_MS || 0)).then(() => {
            this[`${u}childProcess`] = {};
            this[`${u}forkPromise`] = null;
        });
    }
    return this[`${u}forkPromise`];
};
stub[`${u}callMethod`] = function (m, id, ...args) {
    return this[`${u}fork`]().then(() => work[m](id, ...args));
};
['install', 'update', 'uninstall', 'other'].forEach((m) => {
    stub[m] = function (id, ...args) {
        const p = stubQueue.then(() => this[`${u}callMethod`](m, id, ...args));
        stubQueue = p.catch(() => {});
        return p;
    };
});
/* The controller: $FAKE_INPLACE_AHEAD_MS puts another app's operation
 * ahead of the first request in the installer's queue. */
let ahead = Number(env.FAKE_INPLACE_AHEAD_MS || 0) > 0;
const appManager = {
    appManager: stub,
    install: (id, opts) => stub.install(id, opts),
    update: (id, mechanism) => {
        if (ahead) {
            ahead = false;
            stub.other('stock_app');
        }
        return stub.update(id, mechanism);
    },
    uninstall: (id) => stub.uninstall(id)
};
const logger = { info: (m) => fake.log(`hook ${m}`) };
setInterval(() => {}, 1 << 30);
if (env.FAKE_MGR_PASS_MS) setTimeout(fake.startupPass, Number(env.FAKE_MGR_PASS_MS));
if (mode === 'deaf') global.setInterval = () => null;
setTimeout(() => require(path.resolve(process.argv[2])).start(appManager, appRegistry, logger),
    mode === 'late' ? 1500 : 0);
