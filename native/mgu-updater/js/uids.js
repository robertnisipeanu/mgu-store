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
 * free number above them, never inside one; without that file, the lowest
 * free number MARGIN above the highest app uid found.
 *
 * A kept uid that is taken since is picked again (ensure() names the roles
 * that changed, for the caller to move what used them). updater.conf's
 * build_uid, fetch_uid and web_uid are used as they are. The build and
 * fetch gids are their uids' numbers, the web gid socket_group's (the
 * phone page uses the updater socket); build_gid, fetch_gid and web_gid
 * override them.
 *
 * The fetch uid is also written to <state_dir>/internet-uids, which the
 * deploy tool copies into the uplink's uids.d/mgu-updater on its installs
 * (component.json "uids"), and straight into that drop-in while the uplink
 * is installed.
 */
const fs = require('fs');
const path = require('path');

const SELF = 'mgu-updater';
const ROLES = ['build', 'fetch', 'web'];
const MARGIN = 500;
const MAX_UID = 60000; // login.defs UID_MAX
const MAINAPP_CONFIGS = ['/usr/lib/oap-mainapp/config/base.json', '/usr/lib/oap-mainapp21/config/base.json'];

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

/* MainApp's app uid ranges [{min, max}] and its own uids, from the first
 * config/base.json there is. */
function mainappConfig(conf) {
    const files = conf.mainapp_config ? [conf.mainapp_config] : MAINAPP_CONFIGS;
    for (let i = 0; i < files.length; i++) {
        const c = readJson(files[i]);
        if (c) {
            const rse = c.usableUidsAndGidsRse || {};
            const ranges = [c.usableUidsAndGids].concat(Object.keys(rse).map((k) => rse[k]))
                .filter((r) => r && isId(Number(r.min)) && Number(r.max) >= Number(r.min))
                .map((r) => ({ min: Number(r.min), max: Number(r.max) }));
            return { ranges, own: (Array.isArray(c.mainAppUids) ? c.mainAppUids : []).map(Number).filter(isId) };
        }
    }
    return { ranges: [], own: [] };
}

/* { ids: Set of every uid and gid in use, apps: the app uids found }. */
function taken(conf, withProcs) {
    const ids = new Set();
    const apps = [];
    const add = (s, app) => {
        const n = Number(s);
        if (String(s).trim() !== '' && isId(n)) {
            ids.add(n);
            if (app) {
                apps.push(n);
            }
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
            add(m[1], true);
        }
    });
    const mgr = path.join(oap, `oap_${conf.mainapp_uid || 12201}`);
    list(path.join(mgr, 'data', 'apps')).forEach((n) => {
        const e = readJson(path.join(mgr, 'data', 'apps', n));
        add(e && e.userId !== undefined ? e.userId : '', true);
    });
    lines(path.join(mgr, 'security', 'uids.txt')).forEach((l) => add(l.split('=')[0], true));
    const dropins = path.join(conf.tool_root || '/var/opt', conf.uplink_tool || 'mgu-uplink', 'uids.d');
    list(dropins).filter((n) => n !== SELF && !/^\./.test(n)).forEach((n) => {
        lines(path.join(dropins, n)).forEach((l) => l.split('#')[0].split(/[\s,]+/).forEach((s) => add(s)));
    });
    mainappConfig(conf).own.forEach((u) => add(u));
    if (withProcs) {
        const proc = conf.proc_dir || '/proc';
        list(proc).filter((n) => /^\d+$/.test(n)).forEach((pid) => {
            lines(path.join(proc, pid, 'status')).forEach((l) => {
                const m = /^[UG]id:\s+(.*)$/.exec(l);
                if (m) {
                    m[1].split(/\s+/).forEach((s) => add(s));
                }
            });
        });
    }
    return { ids, apps };
}

/* The gid of the group named name in /etc/group, or null. */
function groupGid(conf, name) {
    const line = lines(path.join(conf.etc_dir || '/etc', 'group')).find((l) => l.split(':')[0] === name);
    const gid = line ? Number(line.split(':')[2]) : NaN;
    return isId(gid) ? gid : null;
}

function writeIfChanged(file, text) {
    try {
        if (fs.readFileSync(file, 'utf8') === text) {
            return;
        }
    } catch (e) { /* not there yet */ }
    fs.writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
    fs.renameSync(`${file}.tmp`, file);
}

class ServiceUids {
    /* conf: the updater's; its build_uid, fetch_uid, web_uid and *_gid as
     * loaded are the overrides. ensure() writes the uids in use into it. */
    constructor(conf, log) {
        this.conf = conf;
        this.log = log || (() => {});
        this.overrides = {};
        ROLES.forEach((r) => ['uid', 'gid'].forEach((k) => {
            const v = conf[`${r}_${k}`];
            if (v !== undefined && String(v).trim() !== '') {
                this.overrides[`${r}_${k}`] = Number(v);
            }
        }));
    }

    /* Picks a uid for every role without a free one and returns the roles
     * whose uid differs from the one in use before (on the first call: the
     * kept one). */
    ensure() {
        const conf = this.conf;
        const file = path.join(conf.state_dir, 'uids.json');
        const kept = readJson(file) || {};
        const cfg = mainappConfig(conf);
        const inRange = (u) => cfg.ranges.some((r) => u >= r.min && u <= r.max);
        const now = taken(conf, false);
        const chosen = {};
        const need = [];
        ROLES.forEach((role) => {
            const own = this.overrides[`${role}_uid`];
            const k = Number(kept[role]);
            if (own !== undefined) {
                chosen[role] = own;
            } else if (isId(k) && !now.ids.has(k) && !inRange(k) && ROLES.every((o) => chosen[o] !== k)) {
                chosen[role] = k;
            } else {
                need.push(role);
            }
        });
        if (need.length) {
            const all = taken(conf, true);
            ROLES.forEach((r) => {
                if (chosen[r] !== undefined) {
                    all.ids.add(chosen[r]);
                }
            });
            let u = cfg.ranges.length ? Math.max.apply(null, cfg.ranges.map((r) => r.max)) + 1 :
                Math.max.apply(null, all.apps.concat([Number(conf.mainapp_uid) || 0])) + MARGIN;
            need.forEach((role) => {
                while (u <= MAX_UID && (all.ids.has(u) || inRange(u))) {
                    u++;
                }
                if (u > MAX_UID) {
                    throw new Error(`no free uid for ${role} below ${MAX_UID}`);
                }
                chosen[role] = u;
                all.ids.add(u);
                this.log(`uids: ${role} is ${u}${isId(Number(kept[role])) ? ` (${kept[role]} is taken)` : ''}`);
            });
        }
        const changed = ROLES.filter((r) => {
            const before = Number(this.started ? conf[`${r}_uid`] : kept[r]);
            return isId(before) && before !== chosen[r];
        });
        if (ROLES.some((r) => Number(kept[r]) !== chosen[r])) {
            mkdirp(conf.state_dir);
            writeIfChanged(file, `${JSON.stringify({ build: chosen.build, fetch: chosen.fetch, web: chosen.web })}\n`);
        }
        const web = groupGid(conf, conf.socket_group || 'tm_oap_app');
        const gid = (role, dflt) => {
            const own = this.overrides[`${role}_gid`];
            return String(own !== undefined ? own : dflt);
        };
        ROLES.forEach((r) => {
            conf[`${r}_uid`] = String(chosen[r]);
        });
        conf.build_gid = gid('build', chosen.build);
        conf.fetch_gid = gid('fetch', chosen.fetch);
        conf.web_gid = gid('web', web === null ? chosen.web : web);
        this.started = true;
        this.internet();
        return changed;
    }

    /* The fetch uid for the uplink: <state_dir>/internet-uids, and its
     * drop-in while the uplink is installed. */
    internet() {
        const conf = this.conf;
        const text = `${conf.fetch_uid}\n`;
        try {
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

/* What an earlier uid of role left in state_dir (dl-* for fetch, build-*
 * for build), handed to its uid now so it can be removed: every folder and
 * file there not root's, opened without following a link. */
function handOver(conf, role) {
    const prefix = { fetch: /^dl-/, build: /^build-/ }[role];
    if (!prefix || process.getuid() !== 0) {
        return;
    }
    const uid = Number(conf[`${role}_uid`]);
    const gid = Number(conf[`${role}_gid`]);
    const give = (p) => {
        let fd;
        try {
            fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        } catch (e) {
            return; // a link, or nothing to open
        }
        try {
            const st = fs.fstatSync(fd);
            if (st.uid !== 0 && (st.uid !== uid || st.gid !== gid)) {
                fs.fchownSync(fd, uid, gid);
            }
            if (st.isDirectory() && st.uid !== 0) {
                list(p).forEach((n) => give(path.join(p, n)));
            }
        } catch (e) { /* gone meanwhile */ }
        fs.closeSync(fd);
    };
    list(conf.state_dir).filter((n) => prefix.test(n)).forEach((n) => give(path.join(conf.state_dir, n)));
}

module.exports = { ServiceUids, handOver, taken, mainappConfig };
