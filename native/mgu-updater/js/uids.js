'use strict';
/**
 * The uids the updater runs its parts as: build (a repo's build script),
 * fetch (downloads; the one the uplink lets out) and web (the phone page).
 * None has an account; each is a number nothing else on the unit holds,
 * picked on the unit and kept in <state_dir>/uids.json.
 *
 * Taken: every uid and gid in /etc/passwd and /etc/group, every OAP app's
 * (oap_<uid> folders, MainApp's registry and uids.txt), the uids other
 * components gave the uplink (its uids.d), MainApp's own (mainAppUids) and,
 * when picking, those of running processes. MainApp gives apps the uids of
 * the ranges its config/base.json names (usableUidsAndGids, and
 * usableUidsAndGidsRse for the rear-seat screens), so a pick is the lowest
 * free number above them, never inside one. The config is that of the
 * MainApp the unit runs: the one folder of /usr/lib/oap-mainapp (iDrive 7)
 * and oap-mainapp21 (iDrive 8) that has one, else the running HMI's.
 * Without it nothing is picked: kept uids stay in use, a role without one
 * has none (its downloads, builds or page fail, saying so) until the
 * config can be read or updater.conf names one.
 *
 * A kept uid that is taken since is picked again (ensure() names the roles
 * that changed and their old uids, for the caller to retire). updater.conf's
 * build_uid, fetch_uid and web_uid are used as they are. The build and
 * fetch gids are their uids' numbers, the web gid socket_group's (the
 * phone page uses the updater socket); build_gid, fetch_gid and web_gid
 * override them.
 *
 * The fetch uid is also written to <state_dir>/internet-uids, which the
 * deploy tool copies into the uplink's uids.d/mgu-updater on its installs
 * (component.json "uids"), and straight into that drop-in while the uplink
 * is installed. An uplink older than 0.4.0 reads no uids.d and lets out
 * only 12990: while one runs, downloads run as 12990.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SELF = 'mgu-updater';
const ROLES = ['build', 'fetch', 'web'];
const MAX_UID = 60000; // login.defs UID_MAX
const MAINAPPS = [{ root: '/usr/lib/oap-mainapp', hmi: 'HmiMain3D' }, { root: '/usr/lib/oap-mainapp21', hmi: 'Hmi8' }];
// the fetch uid of uplinks before 0.4.0, which have no uids.d
const LEGACY_FETCH = 12990;
const UIDS_D_SINCE = [0, 4, 0];

function lines(file) {
    try {
        return fs.readFileSync(file, 'utf8').split('\n');
    } catch (e) {
        return [];
    }
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

function list(dir) {
    try {
        return fs.readdirSync(dir);
    } catch (e) {
        return [];
    }
}

function mkdirp(dir) {
    if (!fs.existsSync(dir)) {
        mkdirp(path.dirname(dir));
        fs.mkdirSync(dir, 0o755);
    }
}

function isId(n) {
    return n > 0 && n === Math.floor(n);
}

/* The running MainApp's config/base.json, or null when it cannot be told. */
function mainappFile(conf) {
    if (conf.mainapp_config) {
        return conf.mainapp_config;
    }
    const roots = conf.mainapp_roots ? conf.mainapp_roots.split(/\s+/).map((r, i) => ({ root: r, hmi: MAINAPPS[i].hmi })) : MAINAPPS;
    const have = roots.filter((m) => fs.existsSync(path.join(m.root, 'config', 'base.json')));
    if (have.length > 1) {
        const proc = conf.proc_dir || '/proc';
        const running = list(proc).filter((n) => /^\d+$/.test(n)).map((n) => (lines(path.join(proc, n, 'comm'))[0] || '').trim());
        const which = have.filter((m) => running.indexOf(m.hmi) >= 0);
        return which.length === 1 ? path.join(which[0].root, 'config', 'base.json') : null;
    }
    return have.length ? path.join(have[0].root, 'config', 'base.json') : null;
}

/* MainApp's app uid ranges [{min, max}] and its own uids, or null. */
function mainappConfig(conf) {
    const file = mainappFile(conf);
    const c = file && readJson(file);
    if (!c) {
        return null;
    }
    const rse = c.usableUidsAndGidsRse || {};
    const ranges = [c.usableUidsAndGids].concat(Object.keys(rse).map((k) => rse[k]))
        .filter((r) => r && isId(Number(r.min)) && Number(r.max) >= Number(r.min))
        .map((r) => ({ min: Number(r.min), max: Number(r.max) }));
    return ranges.length ? { ranges, own: (Array.isArray(c.mainAppUids) ? c.mainAppUids : []).map(Number).filter(isId) } : null;
}

/* Every uid and gid in use (a Set). */
function taken(conf, cfg, withProcs) {
    const ids = new Set();
    const add = (s) => {
        const n = Number(s);
        if (String(s).trim() !== '' && isId(n)) {
            ids.add(n);
        }
    };
    const etc = conf.etc_dir || '/etc';
    lines(path.join(etc, 'passwd')).forEach((l) => {
        const f = l.split(':');
        add(f[2] || '');
        add(f[3] || '');
    });
    lines(path.join(etc, 'group')).forEach((l) => add(l.split(':')[2] || ''));
    const oap = conf.oap_root || '/var/opt/public/oap';
    list(oap).forEach((n) => {
        const m = /^oap_(\d+)$/.exec(n);
        if (m) {
            add(m[1]);
        }
    });
    const mgr = path.join(oap, `oap_${conf.mainapp_uid || 12201}`);
    list(path.join(mgr, 'data', 'apps')).forEach((n) => {
        const e = readJson(path.join(mgr, 'data', 'apps', n));
        add(e && e.userId !== undefined ? e.userId : '');
    });
    lines(path.join(mgr, 'security', 'uids.txt')).forEach((l) => add(l.split('=')[0]));
    const dropins = path.join(conf.tool_root || '/var/opt', conf.uplink_tool || 'mgu-uplink', 'uids.d');
    list(dropins).filter((n) => n !== SELF && !/^\./.test(n)).forEach((n) => {
        lines(path.join(dropins, n)).forEach((l) => l.split('#')[0].split(/[\s,]+/).forEach(add));
    });
    (cfg ? cfg.own : []).forEach(add);
    if (withProcs) {
        const proc = conf.proc_dir || '/proc';
        list(proc).filter((n) => /^\d+$/.test(n)).forEach((pid) => {
            lines(path.join(proc, pid, 'status')).forEach((l) => {
                const m = /^[UG]id:\s+(.*)$/.exec(l);
                if (m) {
                    m[1].split(/\s+/).forEach(add);
                }
            });
        });
    }
    return ids;
}

/* The gid of the group named name in /etc/group, or null. */
function groupGid(conf, name) {
    const line = lines(path.join(conf.etc_dir || '/etc', 'group')).find((l) => l.split(':')[0] === name);
    const gid = line ? Number(line.split(':')[2]) : NaN;
    return isId(gid) ? gid : null;
}

/* The uplink in use reads no uids.d: the version its running process
 * was started from (an update can be pending a restart), else the
 * installed one. */
function legacyUplink(conf) {
    const dir = path.join(conf.tool_root || '/var/opt', conf.uplink_tool || 'mgu-uplink');
    const proc = conf.proc_dir || '/proc';
    let version = null;
    list(proc).filter((n) => /^\d+$/.test(n)).some((n) => {
        let exe = '';
        try {
            exe = fs.readlinkSync(path.join(proc, n, 'exe'));
        } catch (e) {
            return false;
        }
        const m = exe.indexOf(`${dir}/versions/`) === 0 && /^([^/]+)\/[^/]+$/.exec(exe.slice(dir.length + 10));
        version = m ? m[1] : null;
        return !!version;
    });
    if (!version) {
        const c = readJson(path.join(dir, 'current', 'component.json'));
        version = c && c.version;
    }
    const v = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
    if (!v) {
        return false;
    }
    for (let i = 0; i < 3; i++) {
        if (Number(v[i + 1]) !== UIDS_D_SINCE[i]) {
            return Number(v[i + 1]) < UIDS_D_SINCE[i];
        }
    }
    return false;
}

function writeIfChanged(file, text) {
    try {
        if (fs.readFileSync(file, 'utf8') === text) {
            return;
        }
    } catch (e) { /* not there yet */ }
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o644);
    try {
        fs.writeSync(fd, text);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try {
        fs.fsyncSync(dir);
    } finally {
        fs.closeSync(dir);
    }
}

class ServiceUids {
    /* conf: the updater's; its build_uid, fetch_uid, web_uid and *_gid as
     * loaded are the overrides. ensure() writes the uids in use into it. */
    constructor(conf, log) {
        this.conf = conf;
        this.log = log || (() => {});
        this.overrides = {};
        this.said = {};
        ROLES.forEach((r) => ['uid', 'gid'].forEach((k) => {
            const v = conf[`${r}_${k}`];
            if (v !== undefined && String(v).trim() !== '') {
                this.overrides[`${r}_${k}`] = Number(v);
            }
        }));
    }

    /* Keeps or picks a uid for every role. Returns [{ role, from }]: the
     * roles whose uid differs from the one in use before (on the first
     * call: the kept one), with that one. */
    ensure() {
        const conf = this.conf;
        const file = path.join(conf.state_dir, 'uids.json');
        const kept = readJson(file) || {};
        const cfg = mainappConfig(conf);
        const inRange = (u) => !!cfg && cfg.ranges.some((r) => u >= r.min && u <= r.max);
        const now = taken(conf, cfg, false);
        const legacy = legacyUplink(conf);
        const chosen = {};
        const need = [];
        ROLES.forEach((role) => {
            const own = this.overrides[`${role}_uid`];
            const k = Number(kept[role]);
            if (own !== undefined) {
                chosen[role] = own;
            } else if (role === 'fetch' && legacy) {
                chosen[role] = LEGACY_FETCH;
            } else if (isId(k) && !now.has(k) && !inRange(k) && ROLES.every((o) => chosen[o] !== k)) {
                chosen[role] = k;
            } else {
                need.push(role);
            }
        });
        if (need.length && !cfg) {
            need.forEach((role) => {
                if (!this.said[role]) {
                    this.said[role] = true;
                    this.log(`uids: no ${role} uid: MainApp's config/base.json (its app uid ranges) cannot be read, ` +
                        `so none is picked; set ${role}_uid in updater.local.conf to use one`);
                }
            });
        } else if (need.length) {
            const all = taken(conf, cfg, true);
            ROLES.forEach((r) => {
                if (chosen[r] !== undefined) {
                    all.add(chosen[r]);
                }
            });
            let u = Math.max.apply(null, cfg.ranges.map((r) => r.max)) + 1;
            need.forEach((role) => {
                while (u <= MAX_UID && (all.has(u) || inRange(u))) {
                    u++;
                }
                if (u > MAX_UID) {
                    this.log(`uids: no free uid for ${role} below ${MAX_UID}`);
                    return;
                }
                chosen[role] = u;
                all.add(u);
                this.said[role] = false;
                this.log(`uids: ${role} is ${u}${isId(Number(kept[role])) ? ` (${kept[role]} is taken)` : ''}`);
            });
        }
        const changed = ROLES.map((r) => ({ role: r, from: Number(this.started ? conf[`${r}_uid`] : kept[r]) }))
            .filter((c) => isId(c.from) && c.from !== chosen[c.role]);
        const save = {};
        ROLES.forEach((r) => {
            const v = r === 'fetch' && legacy && this.overrides.fetch_uid === undefined ? kept.fetch : chosen[r];
            if (isId(Number(v))) {
                save[r] = Number(v);
            }
        });
        if (JSON.stringify(save) !== JSON.stringify(kept)) {
            mkdirp(conf.state_dir);
            writeIfChanged(file, `${JSON.stringify(save)}\n`);
        }
        const web = groupGid(conf, conf.socket_group || 'tm_oap_app');
        const gids = { build: chosen.build, fetch: chosen.fetch, web: web === null ? chosen.web : web };
        ROLES.forEach((r) => {
            const own = this.overrides[`${r}_gid`];
            conf[`${r}_uid`] = chosen[r] === undefined ? undefined : String(chosen[r]);
            conf[`${r}_gid`] = own !== undefined ? String(own) : gids[r] === undefined ? undefined : String(gids[r]);
        });
        this.started = true;
        this.internet();
        return changed;
    }

    /* Nothing else on the unit holds uid (one of ours from before, whose
     * leftover processes may then be killed). */
    free(uid) {
        const conf = this.conf;
        return !taken(conf, mainappConfig(conf), false).has(uid) && ROLES.every((r) => Number(conf[`${r}_uid`]) !== uid);
    }

    /* The fetch uid for the uplink: <state_dir>/internet-uids, and its
     * drop-in while the uplink is installed. */
    internet() {
        const conf = this.conf;
        if (conf.fetch_uid === undefined) {
            return;
        }
        const text = `${conf.fetch_uid}\n`;
        try {
            mkdirp(conf.state_dir);
            writeIfChanged(path.join(conf.state_dir, 'internet-uids'), text);
            const uplink = path.join(conf.tool_root || '/var/opt', conf.uplink_tool || 'mgu-uplink');
            if (fs.existsSync(path.join(uplink, 'current'))) {
                mkdirp(path.join(uplink, 'uids.d'));
                writeIfChanged(path.join(uplink, 'uids.d', SELF), text);
            }
        } catch (e) {
            this.log(`uids: the uplink drop-in: ${e.message}`);
        }
    }
}

/* Runs `node -e script` as uid:gid; resolves when it ends. */
function runAs(uid, args) {
    return new Promise((resolve) => {
        const c = cp.spawn(args[0], args.slice(1), { uid, gid: uid, stdio: 'ignore', env: {} });
        c.on('error', () => resolve());
        c.on('close', () => resolve());
    });
}

/* What another uid of role left in state_dir (dl-* for fetch, build-* for
 * build: a folder of that uid, or a root folder holding that uid's
 * folders), removed as that uid, as the fetcher and the builds remove their
 * own: root looks only at the entries of root's folders and follows no
 * link. When free(uid) says nothing else holds it now, its processes are
 * killed first (a build left running). Resolves when done. */
function retireOld(conf, role, free) {
    const prefix = { fetch: /^dl-/, build: /^build-/ }[role];
    if (!prefix || process.getuid() !== 0) {
        return Promise.resolve();
    }
    const own = Number(conf[`${role}_uid`]);
    const byUid = new Map();
    const lst = (p) => {
        try {
            return fs.lstatSync(p);
        } catch (e) {
            return null;
        }
    };
    const note = (p, st) => {
        if (st && st.isDirectory() && st.uid !== 0 && st.uid !== own) {
            byUid.set(st.uid, (byUid.get(st.uid) || []).concat([p]));
        }
    };
    list(conf.state_dir).filter((n) => prefix.test(n)).forEach((n) => {
        const dir = path.join(conf.state_dir, n);
        const st = lst(dir);
        if (st && st.isDirectory() && st.uid === 0) {
            list(dir).forEach((m) => note(path.join(dir, m), lst(path.join(dir, m))));
        } else {
            note(dir, st);
        }
    });
    let chain = Promise.resolve();
    byUid.forEach((dirs, uid) => {
        chain = chain
            .then(() => (free(uid) ? runAs(uid, [process.execPath, '-e', 'try { process.kill(-1, "SIGKILL"); } catch (e) { /* none */ }']) : null))
            .then(() => runAs(uid, ['rm', '-rf'].concat(dirs)))
            .then(() => dirs.forEach((d) => {
                [d, path.dirname(d)].filter((x) => x !== conf.state_dir).forEach((x) => {
                    try {
                        fs.rmdirSync(x);
                    } catch (e) { /* not empty, or gone */ }
                });
            }));
    });
    return chain;
}

module.exports = { ServiceUids, retireOld };
