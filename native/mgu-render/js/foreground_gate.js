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
 * manager keeps it (INTERFACES, the first there; some iDrive 7 firmware has
 * none of them, and then the copy of the iDrive 7 one MainApp's installer
 * writes into <apps>/oap_<uid>/someipInterfaces/ for each app whose manifest
 * names the interface, the one with the most instances). Without any, it
 * prints one line, "unavailable", and exits. The instance's uuid
 * field is the app's RHMI uuid, and its applicationStack field has a ROOT_APP
 * entry while the app's screen is in front. Installed apps live in
 * <apps>/oap_<uid>/, which only the app manager creates, with the RHMI uuid in
 * rhmiData/application.json. The app may rewrite that file, so a uuid that
 * more than one folder claims goes to the one the app manager has registered
 * and is ignored without exactly one, and the file is read only if it is a
 * regular file of at most 64 KiB. Each change prints one line:
 *
 *   foreground [uid ...]
 *
 * An app in front is covered while the HMI shows something over it that
 * takes the input: a popup, the header menu, the voice assistant, or
 * another screen opened from there. The HMI then takes the focus from the
 * app's states (its notify event: FOCUS false for the state's id; the
 * states' ids are the ones in its applicationStack and the ones the HMI
 * sends VISIBLE for) and gives it back when that goes. The covered apps in
 * front, on each change:
 *
 *   covered [uid ...]
 *
 * A page opening in the app moves the focus from one of its states to the
 * next in one burst, so an app counts as covered only once no state of it has
 * had the focus for COVER_SETTLE_MS; it is uncovered at once.
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
const COVER_SETTLE_MS = 150;
const MAX_INTERFACE_JSON = 4 << 20;

const ID7_INTERFACE = 'de_bmw_infotainment_hmi_remote_RemoteHmiApplication.json';
const INTERFACES = [
    `/usr/lib/oap-mainapp/src-gen/${ID7_INTERFACE}`,
    '/usr/lib/oap-mainapp21/src-gen/someip/de_bmw_infotainment_hmi_remote2_RemoteHmiApplication2.json',
    `/usr/lib/oap-mainapp/src-gen/someip/${ID7_INTERFACE}`
];
const DEFAULTS = {
    someip: '/usr/lib/someip.node',
    apps: '/var/opt/public/oap'
};

/* The parsed JSON of a regular file of at most max bytes; undefined otherwise. */
function readJson(file, max) {
    let fd = -1;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        const st = fs.fstatSync(fd);
        if (st.isFile() && st.size <= max) {
            const buf = Buffer.alloc(st.size);
            fs.readSync(fd, buf, 0, st.size, 0);
            return JSON.parse(buf.toString('utf8'));
        }
    } catch (e) {
        // missing or not JSON
    } finally {
        if (fd >= 0) {
            fs.closeSync(fd);
        }
    }
    return undefined;
}

function instanceCount(config) {
    return config && config.instances && typeof config.instances === 'object'
        ? Object.keys(config.instances).length : 0;
}

/* The interface description: { file, config }, or null when there is none. */
function findInterface(files, appsDir) {
    for (const file of files) {
        const config = readJson(file, MAX_INTERFACE_JSON);
        if (instanceCount(config)) {
            return { file, config };
        }
    }
    let best = null;
    let names = [];
    try {
        names = fs.readdirSync(appsDir).filter((n) => /^oap_\d+$/.test(n)).sort();
    } catch (e) {
        // no apps
    }
    names.forEach((name) => {
        const file = path.join(appsDir, name, 'someipInterfaces', ID7_INTERFACE);
        const config = readJson(file, MAX_INTERFACE_JSON);
        if (instanceCount(config) > (best ? instanceCount(best.config) : 0)) {
            best = { file, config };
        }
    });
    return best;
}

/* The uids the app manager has registered: its registry, <apps>/oap_12201/data/apps/<appId>.json
 * (its own folder: an app cannot write there), each with the app's userId. */
function registeredUids(dir) {
    const out = new Set();
    let names = [];
    try {
        names = fs.readdirSync(path.join(dir, 'oap_12201', 'data', 'apps'));
    } catch (e) {
        return out;
    }
    names.filter((n) => /\.json$/.test(n)).forEach((n) => {
        const entry = readJson(path.join(dir, 'oap_12201', 'data', 'apps', n), MAX_APP_JSON);
        const uid = entry && entry.userId;
        if (typeof uid === 'number' && uid % 1 === 0) {
            out.add(uid);
        }
    });
    return out;
}

/* RHMI uuid -> uid of the installed apps. A uuid more than one folder claims (an earlier
 * install's folder left behind) goes to the one the app manager has registered, when exactly
 * one of them is; else it is left out. */
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
        const desc = readJson(path.join(dir, name, 'rhmiData', 'application.json'), MAX_APP_JSON);
        const uuid = desc && desc.application && desc.application.uuid;
        if (typeof uuid === 'string') {
            claims.set(uuid, (claims.get(uuid) || []).concat(Number(m[1])));
        }
    });
    const apps = new Map();
    let registered = null;
    claims.forEach((uids, uuid) => {
        registered = uids.length > 1 ? registered || registeredUids(dir) : registered;
        const live = uids.length > 1 ? uids.filter((uid) => registered.has(uid)) : uids;
        if (live.length === 1) {
            apps.set(uuid, live[0]);
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

/* The state ids an applicationStack lists, under any key. */
function stackStates(stack) {
    const lists = stack instanceof Map ? [...stack.values()] : Object.keys(stack || {}).map((k) => stack[k]);
    return [].concat(...lists.filter(Array.isArray));
}

/* A notify event's value (parameter 0), when it is a boolean. */
function eventFlag(ev) {
    const params = ev && ev.parameterMap;
    const v = params instanceof Map ? params.get(0) : params && params[0];
    return v && typeof v.booleanValue === 'boolean' ? v.booleanValue : undefined;
}

function startGate(opts) {
    const { someip, interfaceConfig, appsDir, write, log } = opts;
    const front = new Map();   // instance name -> its stack has ROOT_APP
    const shown = new Map();   // instance name in front -> its uuid
    const focus = new Map();   // instance name -> { states, focused (state ids with the HMI focus), lost }
    let apps = readApps(appsDir, log);
    let last = null;
    let lastCovered = 'covered';
    let settle = null;

    const focusOf = (name) => {
        if (!focus.has(name)) {
            focus.set(name, { states: new Set(), focused: new Set(), lost: false });
        }
        return focus.get(name);
    };
    const uidsOf = (names) => {
        const uids = new Set();
        names.forEach((name) => {
            const uuid = shown.get(name);
            if (apps.has(uuid)) {
                uids.add(apps.get(uuid));
            }
        });
        return [...uids].sort((a, b) => a - b);
    };
    const report = () => {
        const line = ['foreground'].concat(uidsOf([...shown.keys()])).join(' ');
        if (line !== last) {
            last = line;
            write(`${line}\n`);
        }
        reportCovered(false);
    };
    /* An app newly covered is reported once it has stayed so for COVER_SETTLE_MS since the last change. */
    const reportCovered = (settled) => {
        const covered = [...shown.keys()].filter((name) => {
            const f = focus.get(name);
            return f && f.lost && f.focused.size === 0;
        });
        const uids = uidsOf(covered);
        const line = ['covered'].concat(uids).join(' ');
        clearTimeout(settle);
        settle = null;
        if (line === lastCovered) {
            return;
        }
        const was = lastCovered.split(' ').slice(1).map(Number);
        if (!settled && uids.some((uid) => !was.includes(uid))) {
            settle = setTimeout(() => {
                settle = null;
                reportCovered(true);
            }, COVER_SETTLE_MS);
            return;
        }
        lastCovered = line;
        write(`${line}\n`);
    };
    const fail = (name) => (e) => log(`${name}: ${e && e.message || e}`);

    /* The stack is subscribed once per instance, whether offered yet or not;
     * the uuid is read each time the instance comes to the front, as an
     * instance number is reused once its app is gone. */
    const watch = (name) => someip.buildProxy(interfaceConfig, name).then((proxy) => proxy.init().then(() => {
        const leave = () => {
            front.set(name, false);
            focus.delete(name);
            if (shown.delete(name)) {
                report();
            }
        };
        proxy.subscribeToAvailability((available) => {
            if (!available) {
                leave();
            }
        });
        proxy.subscribe({
            name: 'notify',
            onReceive: (ev) => {
                const f = focusOf(name);
                const flag = eventFlag(ev);
                if (ev && ev.eventType === 'VISIBLE') {
                    f.states.add(ev.sourceId);
                } else if (ev && ev.eventType === 'FOCUS' && flag !== undefined && f.states.has(ev.sourceId)) {
                    if (flag) {
                        f.focused.add(ev.sourceId);
                        f.lost = false;
                    } else {
                        f.focused.delete(ev.sourceId);
                        f.lost = true;
                    }
                    reportCovered(false);
                }
            }
        });
        return proxy.subscribe({
            name: 'applicationStack',
            onReceive: (stack) => {
                if (!hasRootApp(stack)) {
                    leave();
                    return;
                }
                stackStates(stack).forEach((id) => focusOf(name).states.add(id));
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
    const write = (s) => fs.writeSync(reportFd, s);
    const log = (s) => process.stderr.write(`foreground gate: ${s}\n`);
    const found = opt.interface
        ? { file: opt.interface, config: JSON.parse(fs.readFileSync(opt.interface, 'utf8')) }
        : findInterface(INTERFACES, opt.apps);
    if (!found) {
        log(`no RemoteHmiApplication interface description (${INTERFACES.join(', ')}, ${opt.apps}/oap_*/someipInterfaces/)`);
        write('unavailable\n');
        process.exit(0);
    }
    if (found.file !== INTERFACES[0]) {
        log(`interface: ${found.file}`);
    }
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
    startGate({
        someip: require(opt.someip),
        interfaceConfig: found.config,
        appsDir: opt.apps,
        write,
        log
    });
}

module.exports = { startGate, readApps, hasRootApp, findInterface, INTERFACES, COVER_SETTLE_MS };
