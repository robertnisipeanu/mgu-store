'use strict';
/**
 * The app manager for the deploy tests, run as the deploy tool's kill
 * command: node fake_manager.js <pid>. It kills the node child named in
 * $FAKE_MGR_PIDFILE and respawns it (next pid, /proc/<pid>/stat started
 * now), then does what the manager does at start:
 *
 * - App::init for every registry entry: an app whose someipInterfaces/
 *   acl.json is missing fails to start and its entry is unpersisted;
 * - provisioning, with the fallback active (its copy and unit present):
 *   every app in custom_apps.json without a registry entry gets a fresh
 *   install from its preinstalled package, as the lowest uid in base.json's
 *   range with no registry entry (getFreeUserId): source, acl.json,
 *   keychain, a uids.txt line, then the entry; an app listed without a
 *   package is asked of the backend;
 * - update: an entry whose installationSource is null takes a newer
 *   preinstalled package.
 *
 * When the killed child is fake_inplace.js (its pid in
 * $FAKE_MGR_PIDFILE.inplace), that process is killed too, and the
 * respawned child's pid is 900000 above it rather than the next one,
 * which the deploy tool's own process often has.
 * With $FAKE_MGR_HOOK set, the respawned child is fake_inplace.js on the
 * fallback copy when the fallback is active and its copy has the hook.
 * With $FAKE_MGR_STAY_DOWN_AT set to n, the n-th kill respawns nothing.
 * With $FAKE_MGR_NO_KEYCHAIN set, a fresh install writes no keychain. The
 * JSON object in $FAKE_MGR_SECTIONS, when that file exists, holds
 * provisioning's own sections by app id: such an app's provisioningCache
 * is that section, not the fallback's flags.
 *
 * When the JSON array in $FAKE_MGR_RETIRED exists, it names the apps the
 * retired installer's edit lists while main.js carries that edit ("retired
 * edit" in it), with their flags forced, and the manager provisions every
 * registered app: an app listed by nothing (no section, not in the active
 * fallback's list, not in the edit) loses its tile (-enabled and -allowed
 * "false"), and a hidden app listed again gets that listing's flags back.
 * Every step is appended to $FAKE_MGR_LOG, one line each, the kill with
 * its time in ms and the app homes present at that moment.
 *
 * install(id), update(id) and uninstall(id) are the manager's install,
 * update and uninstall of one app, for fake_inplace.js.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const env = process.env;
const log = (line) => fs.appendFileSync(env.FAKE_MGR_LOG, `${line}\n`);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

const oap = env.MGU_DEPLOY_OAP;
const mgr = path.join(oap, 'oap_12201');
const appsDir = path.join(mgr, 'data', 'apps');
const pre = path.join(env.MGU_DEPLOY_MAINAPP, 'preinstalled_apps');
const entries = () => (fs.existsSync(appsDir) ? fs.readdirSync(appsDir) : [])
    .filter((n) => n.endsWith('.json')).map((n) => ({ id: n.slice(0, -5), file: path.join(appsDir, n), entry: readJson(path.join(appsDir, n)) }));
const home = (uid) => path.join(oap, `oap_${uid}`);
const packageOf = (id) => fs.readdirSync(pre).filter((n) => n.startsWith(`${id}@`) && n.endsWith('.tgz'))
    .map((n) => ({ file: path.join(pre, n), version: n.slice(id.length + 1, -4) }))[0] || null;
const newer = (a, b) => {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if (x[i] !== y[i]) return x[i] > y[i];
    }
    return false;
};
function unpack(file, source) {
    fs.rmSync(source, { recursive: true, force: true });
    fs.mkdirSync(source, { recursive: true });
    cp.execFileSync('tar', ['-xzf', file, '-C', source]);
}
const fallbackActive = () => fs.existsSync(path.join(env.MGU_DEPLOY_VAR_OPT, 'mgu-deploy', 'main.js')) &&
    fs.existsSync(path.join(env.MGU_DEPLOY_SYSTEMD, 'mgu-app-fallback.service'));
const customApps = () => (fallbackActive() ? (readJson(path.join(mgr, 'data', 'custom_apps.json')) || {}) : {});
const sectionsOf = () => (env.FAKE_MGR_SECTIONS && readJson(env.FAKE_MGR_SECTIONS)) || {};

/* A fresh install of id from its preinstalled package, as the lowest free
 * uid; the uid, or null when there is no package (a backend query). The
 * entry's installationSource is source when given (null: the install has
 * not set it yet). */
function install(id, how, source) {
    const pkg = packageOf(id);
    if (!pkg) {
        log(`backend-query ${id}`);
        return null;
    }
    const range = readJson(path.join(env.MGU_DEPLOY_MAINAPP, 'config', 'base.json')).usableUidsAndGids;
    const used = new Set(entries().map((e) => e.entry && e.entry.userId));
    let uid = range.min;
    while (used.has(uid)) uid += 1;
    const h = home(uid);
    unpack(pkg.file, path.join(h, 'source'));
    write(path.join(h, 'someipInterfaces', 'acl.json'), '{}\n');
    if (!env.FAKE_MGR_NO_KEYCHAIN) {
        write(path.join(h, 'security', 'joynrKeyChain.json'), '{"fake":true}\n');
    }
    fs.appendFileSync(path.join(mgr, 'security', 'uids.txt'), `${uid}=${id}\n`);
    write(path.join(appsDir, `${id}.json`), JSON.stringify({ userId: uid,
        installationSource: source === undefined ? 'PREINSTALLED' : source,
        provisioningCache: sectionsOf()[id] || customApps()[id], configStateQueueIndex: null }));
    log(`install ${id} ${pkg.version} uid ${uid}${how || ''}`);
    return uid;
}

/* The update of a registered app to a newer preinstalled package, its uid
 * kept; whether it updated. */
function update(id, how) {
    const e = entries().find((x) => x.id === id);
    const pkg = packageOf(id);
    if (!e || !e.entry || !pkg) return false;
    const source = path.join(home(e.entry.userId), 'source');
    const have = readJson(path.join(source, 'package.json'));
    if (!have || !newer(pkg.version, have.version)) return false;
    unpack(pkg.file, source);
    fs.writeFileSync(e.file, JSON.stringify(Object.assign(e.entry, { installationSource: 'PREINSTALLED' })));
    log(`update ${id} ${pkg.version} uid ${e.entry.userId}${how || ''}`);
    return true;
}

/* The uninstall of a registered app: its entry, its home and its
 * uids.txt line go; whether it was registered. */
function uninstall(id, how) {
    const e = entries().find((x) => x.id === id);
    if (!e || !e.entry || !e.entry.userId) return false;
    fs.rmSync(home(e.entry.userId), { recursive: true, force: true });
    fs.unlinkSync(e.file);
    const uids = path.join(mgr, 'security', 'uids.txt');
    fs.writeFileSync(uids, fs.readFileSync(uids, 'utf8').split('\n').filter((l) => l !== `${e.entry.userId}=${id}`).join('\n'));
    log(`uninstall ${id} uid ${e.entry.userId}${how || ''}`);
    return true;
}

function bounce() {
    const old = Number(fs.readFileSync(env.FAKE_MGR_PIDFILE, 'utf8'));
    const killsBefore = () => (fs.existsSync(env.FAKE_MGR_LOG) ? fs.readFileSync(env.FAKE_MGR_LOG, 'utf8') : '')
        .split('\n').filter((l) => l.startsWith('kill ')).length;
    if (Number(process.argv[2]) !== old) {
        log(`kill of an unknown pid ${process.argv[2]}`);
        process.exit(1);
    }
    const marker = `${env.FAKE_MGR_PIDFILE}.inplace`;
    const real = fs.existsSync(marker) && Number(fs.readFileSync(marker, 'utf8')) === old;
    if (real) {
        try { process.kill(old, 'SIGKILL'); } catch (e) { /* gone already */ }
        fs.unlinkSync(marker);
    }
    const homes = fs.readdirSync(oap).filter((n) => /^oap_\d+$/.test(n)).sort();
    const now = Date.now();
    log(`kill ${old} ${now} homes ${homes.join(',')}`);
    // $FAKE_MGR_STAY_DOWN_AT: the kill, counted from the first, after which no child comes back
    if (env.FAKE_MGR_STAY_DOWN_AT && killsBefore() === Number(env.FAKE_MGR_STAY_DOWN_AT)) {
        fs.writeFileSync(env.FAKE_MGR_PIDFILE, '');
        log('stays down');
        process.exit(0);
    }

    const btime = Number(/btime (\d+)/.exec(fs.readFileSync(env.MGU_DEPLOY_PROC_STAT, 'utf8'))[1]);
    // after a real process, not the next pid: the deploy tool's own may be that one
    const pid = real ? 900000 + old : old + 1;
    const ticks = Math.round((now / 1000 - btime) * 100);
    write(path.join(env.MGU_DEPLOY_PROC, String(pid), 'stat'),
        `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0\n`);
    fs.writeFileSync(env.FAKE_MGR_PIDFILE, String(pid));

    entries().forEach(({ id, file, entry }) => {
        if (!entry || !entry.userId) return;
        const h = home(entry.userId);
        if (fs.existsSync(path.join(h, 'source', 'package.json')) && !fs.existsSync(path.join(h, 'someipInterfaces', 'acl.json'))) {
            fs.unlinkSync(file);
            log(`init-failed ${id}: no acl.json; entry unpersisted`);
        }
    });

    const custom = customApps();
    Object.keys(custom).forEach((id) => {
        if (!entries().some((e) => e.id === id)) install(id);
    });

    const retired = env.FAKE_MGR_RETIRED ? readJson(env.FAKE_MGR_RETIRED) : null;
    if (Array.isArray(retired)) {
        const sections = sectionsOf();
        const edit = fs.readFileSync(path.join(env.MGU_DEPLOY_MAINAPP, 'src', 'main.js'), 'utf8').includes('retired edit');
        const forced = { '-enabled': 'true', '-allowed': 'true', '-appStartType': 'manually',
            '-userLoginRequired': 'false', '-updateMechanism': 'PLATFORM' };
        const shows = (c) => !!c && c['-enabled'] === 'true' && c['-allowed'] === 'true';
        entries().forEach(({ id, file, entry }) => {
            if (!entry || !entry.userId) return;
            const listing = sections[id] || custom[id] || (edit && retired.includes(id) ? forced : null);
            if (!listing && shows(entry.provisioningCache)) {
                entry.provisioningCache = Object.assign({}, entry.provisioningCache, { '-enabled': 'false', '-allowed': 'false' });
                fs.writeFileSync(file, JSON.stringify(entry));
                log(`hidden ${id}: listed by nothing`);
            } else if (listing && !shows(entry.provisioningCache)) {
                entry.provisioningCache = listing;
                fs.writeFileSync(file, JSON.stringify(entry));
                log(`shown ${id}`);
            }
        });
    }

    entries().forEach(({ id, entry }) => {
        if (entry && entry.installationSource === null) update(id);
    });

    // $FAKE_MGR_HOOK: the respawned child runs the fallback copy's in-place hook, as on the unit
    const copy = path.join(env.MGU_DEPLOY_VAR_OPT, 'mgu-deploy', 'main.js');
    if (env.FAKE_MGR_HOOK && fallbackActive() && fs.readFileSync(copy, 'utf8').includes('mgu-deploy in-place install')) {
        cp.spawn(process.execPath, [path.join(__dirname, 'fake_inplace.js'), copy], { detached: true, stdio: 'ignore' }).unref();
        const t0 = Date.now();
        while (fs.readFileSync(env.FAKE_MGR_PIDFILE, 'utf8') === String(pid) && Date.now() - t0 < 10000) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    }
}

module.exports = { install, update, uninstall, log };
if (require.main === module) bounce();
