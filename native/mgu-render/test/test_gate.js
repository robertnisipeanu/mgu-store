'use strict';
/* The foreground gate's interface description: the files it is found in, in order, and none. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findInterface } = require('../js/foreground_gate.js');

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

fs.rmSync(root, { recursive: true, force: true });
console.log(`test_gate.js: ${checks} checks passed`);
