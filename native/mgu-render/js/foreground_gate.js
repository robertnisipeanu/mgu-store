#!/usr/bin/env node
/*
 * Foreground gate for mgu-render: reports which apps' screens the HMI
 * shows in front, so the renderer shows an app's surface only then. The renderer
 * starts it (foreground_gate) and reads its reports on the descriptor named by
 * MGU_RENDER_REPORT_FD (stdout without it, as when run by hand; the
 * SOME/IP library logs on stdout); it exits when its stdin, held open by the
 * renderer, closes.
 *
 * The HMI serves every app's RHMI as an instance of
 * de.bmw.infotainment.hmi.remote.RemoteHmiApplication (iDrive 7) or
 * remote2.RemoteHmiApplication2 (iDrive 8), described where the unit's app
 * manager keeps it (INTERFACES, the first there). The instance's uuid
 * field is the app's RHMI uuid, and its applicationStack field has a ROOT_APP
 * entry while the app's screen is in front. Installed apps live in
 * <apps>/oap_<uid>/, which only the app manager creates, with the RHMI uuid in
 * rhmiData/application.json. The app may rewrite that file, so a uuid that
 * more than one app claims is ignored, and the file is read only if it is a
 * regular file of at most 64 KiB. Each change prints one line:
 *
 *   foreground [uid ...]
 *
 *   node foreground_gate.js [--someip /usr/lib/someip.node]
 *       [--interface <RemoteHmiApplication interface json>] [--apps /var/opt/public/oap]
 *
 * Runs on the unit's Node 8, as root, with its SOME/IP binding (the one the
 * oap-sdk uses) and the interface description the app manager ships.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_APP_JSON = 65536;

const INTERFACES = [
    '/usr/lib/oap-mainapp/src-gen/de_bmw_infotainment_hmi_remote_RemoteHmiApplication.json',
    '/usr/lib/oap-mainapp21/src-gen/someip/de_bmw_infotainment_hmi_remote2_RemoteHmiApplication2.json'
];
const DEFAULTS = {
    someip: '/usr/lib/someip.node',
    interface: INTERFACES.find((f) => fs.existsSync(f)) || INTERFACES[0],
    apps: '/var/opt/public/oap'
};

/* RHMI uuid -> uid of the installed apps, leaving out uuids claimed twice. */
function readApps(dir, log) {
    const claims = new Map();
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        log(`apps: ${e.message}`);
    }
    names.forEach((name) => {
        const m = /^oap_(\d+)$/.exec(name);
        if (!m) {
            return;
        }
        let uuid;
        let fd = -1;
        try {
            fd = fs.openSync(path.join(dir, name, 'rhmiData', 'application.json'),
                fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
            const st = fs.fstatSync(fd);
            if (st.isFile() && st.size <= MAX_APP_JSON) {
                const buf = Buffer.alloc(st.size);
                fs.readSync(fd, buf, 0, st.size, 0);
                uuid = JSON.parse(buf.toString('utf8')).application.uuid;
            }
        } catch (e) {
            // not a readable app description: no claim
        }
        if (fd >= 0) {
            fs.closeSync(fd);
        }
        if (typeof uuid === 'string') {
            claims.set(uuid, (claims.get(uuid) || []).concat(Number(m[1])));
        }
    });
    const apps = new Map();
    claims.forEach((uids, uuid) => {
        if (uids.length === 1) {
            apps.set(uuid, uids[0]);
        } else {
            log(`uuid ${uuid} is claimed by uids ${uids.join(', ')}; none of them is shown in front`);
        }
    });
    return apps;
}

function hasRootApp(stack) {
    return stack instanceof Map ? stack.has('ROOT_APP')
        : !!stack && Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP');
}

function startGate(opts) {
    const { someip, interfaceConfig, appsDir, write, log } = opts;
    const front = new Map();   // instance name -> its stack has ROOT_APP
    const shown = new Map();   // instance name in front -> its uuid
    let apps = readApps(appsDir, log);
    let last = null;

    const report = () => {
        const uids = new Set();
        shown.forEach((uuid) => {
            if (apps.has(uuid)) {
                uids.add(apps.get(uuid));
            }
        });
        const line = ['foreground'].concat([...uids].sort((a, b) => a - b)).join(' ');
        if (line !== last) {
            last = line;
            write(`${line}\n`);
        }
    };
    const fail = (name) => (e) => log(`${name}: ${e && e.message || e}`);

    /* The stack is subscribed once per instance, whether offered yet or not;
     * the uuid is read each time the instance comes to the front, as an
     * instance number is reused once its app is gone. */
    const watch = (name) => someip.buildProxy(interfaceConfig, name).then((proxy) => proxy.init().then(() => {
        const leave = () => {
            front.set(name, false);
            if (shown.delete(name)) {
                report();
            }
        };
        proxy.subscribeToAvailability((available) => {
            if (!available) {
                leave();
            }
        });
        return proxy.subscribe({
            name: 'applicationStack',
            onReceive: (stack) => {
                if (!hasRootApp(stack)) {
                    leave();
                    return;
                }
                front.set(name, true);
                proxy.getValue('uuid').then((uuid) => {
                    if (front.get(name)) {
                        apps = readApps(appsDir, log);
                        shown.set(name, uuid);
                        report();
                    }
                }).catch(fail(name));
            }
        });
    })).catch(fail(name));

    report();
    Object.keys(interfaceConfig.instances).forEach(watch);
}

if (require.main === module) {
    const opt = Object.assign({}, DEFAULTS);
    for (let i = 2; i + 1 < process.argv.length; i += 2) {
        opt[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
    }
    const reportFd = Number(process.env.MGU_RENDER_REPORT_FD) || 1;
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
    startGate({
        someip: require(opt.someip),
        interfaceConfig: JSON.parse(fs.readFileSync(opt.interface, 'utf8')),
        appsDir: opt.apps,
        write: (s) => fs.writeSync(reportFd, s),
        log: (s) => process.stderr.write(`foreground gate: ${s}\n`)
    });
}

module.exports = { startGate, readApps, hasRootApp };
