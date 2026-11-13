'use strict';
/* The foreground gate's interface description: the files it is found in, in order, and none; which apps it
 * reports in front and covered for the HMI's events. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findInterface, readApps, startGate, COVER_SETTLE_MS } = require('../js/foreground_gate.js');

const ID7 = 'de_bmw_infotainment_hmi_remote_RemoteHmiApplication.json';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
const files = [`${root}/src-gen/${ID7}`, `${root}/id8/RemoteHmiApplication2.json`, `${root}/src-gen/someip/${ID7}`];
const apps = `${root}/oap`;
const desc = (n, tag) => {
    const instances = {};
    for (let i = 1; i <= n; i++) instances[`RemoteHmiApplicationInst${i}`] = 127 + i;
    return { name: 'RemoteHmiApplication', serviceId: 64680, tag, instances };
};
const put = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};
const app = (uid) => `${apps}/oap_${uid}/someipInterfaces/${ID7}`;
const found = () => {
    const f = findInterface(files, apps);
    return f && { file: f.file, tag: f.config.tag };
};
let checks = 0;
const check = (name, got, want) => { checks++; assert.deepStrictEqual(got, want, name); };

check('none anywhere', findInterface(files, apps), null);
fs.mkdirSync(apps);
put(`${apps}/oap_12203/rhmiData/application.json`, { application: { uuid: 'x' } });
check('apps without copies', findInterface(files, apps), null);

put(app(12203), desc(256, 'app 12203'));
put(app(12204), desc(512, 'app 12204'));
put(app(12205), '{ not json');
put(`${apps}/not_an_app/someipInterfaces/${ID7}`, desc(1024, 'not an app'));
check('an app\'s copy, the one with the most instances', found(), { file: app(12204), tag: 'app 12204' });

put(files[2], desc(512, 'src-gen/someip'));
check('src-gen/someip before the apps\' copies', found(), { file: files[2], tag: 'src-gen/someip' });

put(files[1], desc(512, 'iDrive 8'));
check('the iDrive 8 one before src-gen/someip', found(), { file: files[1], tag: 'iDrive 8' });

put(files[0], '');
check('an empty src-gen file is passed over', found(), { file: files[1], tag: 'iDrive 8' });
put(files[0], { name: 'RemoteHmiApplication', instances: {} });
check('one without instances is passed over', found(), { file: files[1], tag: 'iDrive 8' });

put(files[0], desc(512, 'src-gen'));
check('src-gen first, as on current firmware', found(), { file: files[0], tag: 'src-gen' });

// the RHMI uuid each app folder claims; a uuid claimed twice goes to the registered install
const claim = (uid, uuid) => put(`${apps}/oap_${uid}/rhmiData/application.json`, { application: { uuid } });
const register = (id, uid) => put(`${apps}/oap_12201/data/apps/${id}.json`, { appId: id, userId: uid });
const logged = [];
const mapped = () => [...readApps(apps, (s) => logged.push(s))].filter(([uuid]) => uuid !== 'x').sort();
claim(12210, 'store');
claim(12211, 'other');
check('one folder a uuid', mapped(), [['other', 12211], ['store', 12210]]);
claim(12246, 'store');
check('two folders, none registered: left out', mapped(), [['other', 12211]]);
check('and logged', /uuid store is claimed by uids 12210, 12246/.test(logged.join('\n')), true);
register('robertn_store', 12246);
register('other', 12211);
check('two folders, one registered: the registered one', mapped(), [['other', 12211], ['store', 12246]]);
register('robertn_store_copy', 12210);
check('two folders, both registered: left out', mapped(), [['other', 12211]]);
fs.rmSync(`${apps}/oap_12201/data/apps/robertn_store_copy.json`);
put(`${apps}/oap_12201/data/apps/broken.json`, '{ not json');
check('a broken registry entry is passed over', mapped(), [['other', 12211], ['store', 12246]]);

// in front and covered, for the HMI's events as an iDrive 7 sends them (instance 10: the Store, uuid 'store')
const subs = {};
const someip = {
    buildProxy: (cfg, name) => Promise.resolve({
        init: () => Promise.resolve(),
        subscribeToAvailability: () => {},
        subscribe: (s) => { subs[`${name} ${s.name}`] = s.onReceive; return Promise.resolve(); },
        getValue: () => Promise.resolve(name === 'RemoteHmiApplicationInst10' ? 'store' : 'none')
    })
};
const lines = [];
startGate({ someip, interfaceConfig: { instances: { RemoteHmiApplicationInst10: 1, RemoteHmiApplicationInst11: 2 } },
    appsDir: apps, write: (l) => lines.push(l.trim()), log: () => {} });
const stack = (ids) => subs['RemoteHmiApplicationInst10 applicationStack'](new Map(ids ? [['ROOT_APP', ids]] : []));
const ev = (eventType, sourceId, value) => subs['RemoteHmiApplicationInst10 notify'](
    { eventType, sourceId, parameterMap: new Map([[0, { booleanValue: value }]]) });
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms === undefined ? COVER_SETTLE_MS + 50 : ms));
const since = (n) => lines.splice(0).slice(n);

(async () => {
    await settle(0);
    check('nothing in front at start', since(0), ['foreground']);
    ev('VISIBLE', 54, true); ev('FOCUS', 54, true); stack([54]);
    await settle();
    check('the Store opened', since(0), ['foreground 12246']);
    ev('FOCUS', 54, false); ev('VISIBLE', 55, true); ev('FOCUS', 55, true); stack([54, 55]);
    await settle();
    check('a page opening in it does not cover it', since(0), []);
    ev('FOCUS', 1300, false);
    ev('FOCUS', 55, false);
    await settle(COVER_SETTLE_MS / 3);
    check('a popup: not yet', since(0), []);
    await settle();
    check('a popup covers it once it stays', since(0), ['covered 12246']);
    ev('FOCUS', 55, true);
    check('the popup gone: uncovered at once', since(0), ['covered']);
    ev('FOCUS', 55, false); ev('FOCUS', 55, true);
    await settle();
    check('focus back within the settle time: no report', since(0), []);
    ev('FOCUS', 55, false);
    await settle();
    since(0);
    ev('VISIBLE', 55, false); ev('VISIBLE', 54, false); stack([55]); stack();
    await settle();
    check('it leaves while covered: neither in front nor covered', since(0), ['foreground', 'covered']);
    ev('VISIBLE', 54, true); ev('FOCUS', 54, true); stack([54]);
    await settle();
    check('back again, not covered', since(0), ['foreground 12246']);
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`test_gate.js: ${checks} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
