'use strict';
/**
 * mgu-updater: installs, updates and removes apps and head-unit tools from
 * its sources, and serves the Store app and the phone page. Node 8, as root.
 *
 *   node updater.js daemon              the service (started by the mgu-updater supervisor)
 *   node updater.js status [--json]     installed versions against the sources
 *   node updater.js check               read every source now
 *   node updater.js install <id>        install <id>, or update it to its source's version
 *
 * The daemon reads its sources (sources.json, USB media; sources.js),
 * compares what they list with what is installed (apps: MainApp's
 * registry; tools: /var/opt/<id>/current/component.json), downloads through
 * an unprivileged child (fetch.js), builds what a repo builds on the unit
 * (build.js) and installs with the deploy tool's `install --artifact`, the
 * same path every install takes. Updating itself, it hands over to the new
 * version through the supervisor, which returns to the previous one if the
 * new one does not come up (README.md). On the Store's request it restarts
 * the head unit with the `reboot` command.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const util = require('util');
const { URL } = require('url');
const catalogLib = require('./catalog');
const sourcesLib = require('./sources');
const { DeviceLogin } = require('./login');
const { Tokens, TOKEN } = require('./tokens');
const { runBuild, cleanBuilds } = require('./build');
const { ServiceUids, retireOld } = require('./uids');
const { UpdaterClient } = require('./client');

const ID = catalogLib.ID;

const HERE = __dirname;
const SELF = 'mgu-updater';
const HANDOVER_EXIT = 75;
// How long a version on trial keeps trying to reach the catalog. The last
// attempt, its refresh and the deploy tool's answer take up to about 3 min
// more, within the supervisor's TRIAL_S (360 s, bin/mgu-updater).
const TRIAL_WAIT_MS = Number(process.env.MGU_UPDATER_TRIAL_WAIT_MS || 120000);
// A restart the unit has not carried out by then is reported as failed.
const REBOOT_WAIT_MS = Number(process.env.MGU_UPDATER_REBOOT_WAIT_MS || 180000);
// how long after the start that put an app in place (iDrive 8) MainApp may take to list it
const PLACED_GRACE_MS = 5 * 60 * 1000;
// A Store this new or newer says hello when it connects; its update stands once it has (storeTrial).
const STORE_HELLO_SINCE = '0.9.14';
// How long a started Store has to say hello before its update counts as failed.
const STORE_HELLO_MS = Number(process.env.MGU_UPDATER_STORE_HELLO_MS || 120000);
// The uplink takes up a new fetch uid within its 5 s rescan of uids.d.
const UPLINK_RESCAN_MS = Number(process.env.MGU_UPDATER_UPLINK_RESCAN_MS || 6000);

/* ---- configuration ------------------------------------------------------ */

function readConf(file, into) {
    if (!fs.existsSync(file)) {
        return into;
    }
    fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
        const m = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && line.trim()[0] !== '#') {
            into[m[1]] = m[2];
        }
    });
    return into;
}

/* The install page of the GitHub App at url (https://github.com/apps/<slug>), or null. */
function appInstall(url) {
    const m = /^(https:\/\/[^/\s?#]+\/apps\/[A-Za-z0-9-]+)\/?$/.exec(String(url || '').trim());
    return m ? { installUrl: `${m[1]}/installations/new` } : null;
}

/* updater.conf next to this file (in the repo: one folder up), then the
 * unit's own overrides. */
function loadConf() {
    const own = path.join(HERE, 'updater.conf');
    const file = fs.existsSync(own) ? own : path.join(HERE, '..', 'updater.conf');
    const conf = readConf(file, {});
    readConf(process.env.MGU_UPDATER_CONF || conf.local_conf || '/var/opt/mgu-updater/updater.local.conf', conf);
    // relative paths in either file are relative to updater.conf
    ['ca_file'].forEach((k) => {
        if (conf[k]) {
            conf[k] = path.resolve(path.dirname(file), conf[k]);
        }
    });
    return conf;
}

function selfComponent() {
    try {
        return JSON.parse(fs.readFileSync(path.join(HERE, 'component.json'), 'utf8'));
    } catch (e) {
        return {};
    }
}

function selfVersion() {
    return selfComponent().version || 'dev';
}

/* ---- log file ------------------------------------------------------------ */

/* The daemon's journal is root's alone. Every line it logs also goes to
 * log_file with its time, readable by others, for diagnostics that read
 * up to about 192 KiB from a file's start, so the file is renamed to
 * <log_file>.1 past 128 KiB. /tmp is everyone's: the
 * file is opened without following a link or blocking on a FIFO and used
 * only while it is root's own regular file; anything else at that name but
 * a folder is removed first (a folder there leaves the journal alone). */
const LOG_MAX_BYTES = 128 * 1024;

function fileLog(file) {
    let fd = null;
    let bytes = 0;
    const own = (st) => st.isFile() && st.uid === process.getuid() && st.nlink === 1;
    const open = () => {
        let st = null;
        try {
            st = fs.lstatSync(file);
        } catch (e) { /* none yet */ }
        if (st && !own(st)) {
            fs.unlinkSync(file);
        }
        const umask = process.umask(0o022);
        try {
            // O_NONBLOCK: a FIFO put there fails the open instead of blocking it
            fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
                fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o644);
        } finally {
            process.umask(umask);
        }
        st = fs.fstatSync(fd);
        if (!own(st)) {
            fs.closeSync(fd);
            fd = null;
            throw new Error(`${file} is not root's own file`);
        }
        bytes = st.size;
    };
    return (line) => {
        try {
            if (fd === null) {
                open();
            }
            if (bytes > LOG_MAX_BYTES) {
                try {
                    fs.renameSync(file, `${file}.1`);
                    fs.closeSync(fd);
                    fd = null;
                    open();
                } catch (e) {
                    if (fd === null) {
                        throw e; // renamed, not reopened: the next line opens it
                    }
                    // something at <log_file>.1 that a file cannot replace: start the file over
                    fs.ftruncateSync(fd, 0);
                    bytes = 0;
                }
            }
            const text = `${new Date().toISOString()} ${line}\n`;
            fs.writeSync(fd, text);
            bytes += Buffer.byteLength(text);
        } catch (e) {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch (e2) { /* gone */ }
            }
            fd = null; // the next line tries again
        }
    };
}

/* console.log and console.error, each line also to log_file */
function logToFile(file) {
    if (!file) {
        return;
    }
    const write = fileLog(file);
    ['log', 'error'].forEach((k) => {
        const orig = console[k].bind(console);
        console[k] = (...args) => {
            orig(...args);
            util.format(...args).split('\n').forEach(write);
        };
    });
}

/* ---- small helpers (Node 8) --------------------------------------------- */

/* Creates dir with mode, and any missing parents 0755. */
function mkdirp(dir, mode) {
    if (fs.existsSync(dir)) {
        return;
    }
    mkdirp(path.dirname(dir), 0o755);
    fs.mkdirSync(dir, mode);
    fs.chmodSync(dir, mode);
}

function isLink(p) {
    try {
        return fs.lstatSync(p).isSymbolicLink();
    } catch (e) {
        return false;
    }
}

/* Points /var/opt/<id>/current at versions/<v> by rename, as the deploy
 * tool and the supervisor do. */
function switchCurrent(toolDir, target) {
    const tmp = path.join(toolDir, 'current.switch');
    try {
        fs.unlinkSync(tmp);
    } catch (e) { /* none left */ }
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, path.join(toolDir, 'current'));
}

function rmIfThere(file) {
    try {
        fs.unlinkSync(file);
    } catch (e) { /* not there */ }
}

function writeAtomic(file, text) {
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function groupId(name) {
    if (/^\d+$/.test(name)) {
        return Number(name);
    }
    const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.split(':')[0] === name);
    if (!line) {
        throw new Error(`no group ${name}`);
    }
    return Number(line.split(':')[2]);
}

/* ---- what is installed -------------------------------------------------- */

/* A small file of an app's own tree (at most max bytes), read without following a link. */
function readAppFile(file, max) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > max) {
            throw new Error(`${file}: not a small file`);
        }
        const buf = Buffer.alloc(st.size);
        fs.readSync(fd, buf, 0, st.size, 0);
        return buf;
    } finally {
        fs.closeSync(fd);
    }
}

function readAppJson(file) {
    return JSON.parse(readAppFile(file, 262144).toString('utf8'));
}

/* The en_GB text of an installed app's first entry point, or null. */
function appTitle(home) {
    try {
        // MainApp keeps an installed app's RHMI in its home, the texts as strings/<language>.json
        const app = readAppJson(path.join(home, 'rhmiData', 'application.json')).application;
        const textId = app.entryPoints && app.entryPoints[0] && app.entryPoints[0].textId;
        const text = textId && readAppJson(path.join(home, 'rhmiData', 'strings', 'en_GB.json'))[textId];
        return typeof text === 'string' && text ? text : null;
    } catch (e) {
        return null;
    }
}

/* An app's home, from the uid MainApp's registry names for it; throws without one. */
function appHome(conf, id) {
    const entry = readJson(path.join(conf.oap_root, `oap_${conf.mainapp_uid}`, 'data', 'apps', `${id}.json`));
    return path.join(conf.oap_root, `oap_${entry.userId}`);
}

/* An app is installed when MainApp's registry names its uid and that uid's
 * source tree holds its package.json. wantTitle: also its entry point's
 * en_GB text, for a source that names none. */
function installedApp(conf, id, wantTitle) {
    try {
        const home = appHome(conf, id);
        const pkg = readAppJson(path.join(home, 'source', 'package.json'));
        if (pkg.name !== id) {
            return null;
        }
        const title = wantTitle ? appTitle(home) : null;
        return Object.assign({ id, kind: 'app', version: pkg.version }, title ? { title } : {});
    } catch (e) {
        return null;
    }
}

/* What the deploy tool installed (status --json): its tools, and the apps
 * it marked local (mguLocalOnly), not the firmware's own. */
function ownInstalled(conf, st) {
    return ((st && st.components) || []).filter((c) => c && typeof c.id === 'string' && ID.test(c.id) && (c.kind === 'tool' ||
        (c.kind === 'app' && (() => {
            try {
                const entry = readJson(path.join(conf.oap_root, `oap_${conf.mainapp_uid}`, 'data', 'apps', `${c.id}.json`));
                return readAppJson(path.join(conf.oap_root, `oap_${entry.userId}`, 'source', 'package.json')).mguLocalOnly === true;
            } catch (e) {
                return false;
            }
        })()))).map((c) => c.id);
}

function installedTool(conf, id) {
    try {
        const c = readJson(path.join(conf.tool_root, id, 'current', 'component.json'));
        return c.id === id ? Object.assign({ id, kind: 'tool', version: c.version }, typeof c.title === 'string' && c.title ? { title: c.title } : {}) : null;
    } catch (e) {
        return null;
    }
}

/* What an installed tool says is wrong, one line from its status.json
 * ({ "problem": "..." }, mgu-render's page template), else null. */
function toolProblem(conf, id) {
    try {
        const p = readJson(path.join(conf.tool_root, id, 'status.json')).problem;
        return typeof p === 'string' && p ? p.slice(0, 200) : null;
    } catch (e) {
        return null;
    }
}

/* The deploy tool's status --json, or null when it does not answer with it. */
function deployStatus(conf) {
    return new Promise((resolve) => {
        cp.execFile(conf.deploy, ['status', '--json'], { timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout) => {
            try {
                resolve(err ? null : JSON.parse(stdout));
            } catch (e) {
                resolve(null);
            }
        });
    });
}

/* The deploy tool's list of components waiting for a reboot. */
function pendingReboot(conf) {
    return deployStatus(conf).then((st) => pendingOf(st));
}

function pendingOf(st) {
    return ((st && st.pending_reboot) || []).map((p) => (p && p.id) || p);
}

/* iDrive 8's app changes queued for the next start, by id: 'install' or
 * 'remove' (the deploy tool's pending_reboot reasons). */
const NEXT_START = { 'installs at the next start': 'install', 'removed at the next start': 'remove' };
function nextStartOf(st) {
    const out = {};
    ((st && st.pending_reboot) || []).forEach((p) => {
        if (p && NEXT_START[p.reason]) {
            out[p.id] = NEXT_START[p.reason];
        }
    });
    return out;
}

/* What the last start applied (the deploy tool's last_apply, iDrive 8):
 * { at, failed: { <id>: { op: 'install'|'remove', why } }, installed: [ids] }. */
function lastApplyOf(st) {
    const la = st && st.last_apply;
    const failed = {};
    const installed = [];
    ((la && Array.isArray(la.results)) ? la.results : []).forEach((r) => {
        if (!r || typeof r.id !== 'string') {
            return;
        }
        const op = r.action === 'remove' ? 'remove' : 'install';
        if (!r.ok) {
            failed[r.id] = { op, why: `${op === 'remove' ? 'the removal' : 'the install'} at the start of the head unit failed` +
                `${r.error ? `: ${r.error}` : ''}` };
        } else if (op === 'install') {
            installed.push(r.id);
        }
    });
    return { at: (la && la.at) || null, failed, installed };
}

/* The version each installed component would go back to (the deploy
 * tool's rollback), by id. */
function previousOf(st) {
    const out = {};
    ((st && st.components) || []).forEach((c) => {
        if (c && typeof c.id === 'string' && typeof c.previous === 'string' && catalogLib.SEMVER.test(c.previous)) {
            out[c.id] = c.previous;
        }
    });
    return out;
}

/* The tools the last start's check found not working (the deploy tool's
 * last_verify), by id: { version, previous, rolledBack, why }. */
function lastVerifyOf(st) {
    const lv = st && st.last_verify;
    const out = {};
    ((lv && Array.isArray(lv.results)) ? lv.results : []).forEach((r) => {
        if (r && typeof r.id === 'string' && r.ok === false && typeof r.version === 'string') {
            out[r.id] = { version: r.version, previous: typeof r.previous === 'string' ? r.previous : null,
                rolledBack: r.rolledBack === true, why: String(r.error || 'its check failed') };
        }
    });
    return out;
}

/* The head unit (deploy tool's status: { hmi: "ID7"|"ID8"|null, firmware }),
 * null when the deploy tool does not say. */
function unitOf(st) {
    const u = st && st.unit;
    return u && typeof u === 'object' ? { hmi: catalogLib.HMIS.indexOf(u.hmi) >= 0 ? u.hmi : null,
        firmware: typeof u.firmware === 'string' ? u.firmware : null } : null;
}

/* The installed tools providing each capability: { <capability>: [{ id, version }, ...] }. */
function providersOf(st) {
    const out = {};
    ((st && st.components) || []).forEach((c) => {
        if (c && c.kind === 'tool' && typeof c.provides === 'string' && c.provides) {
            (out[c.provides] = out[c.provides] || []).push({ id: c.id, version: c.version });
        }
    });
    return out;
}

/* The app-privacy patch's state (native/app-privacy/INTEGRATION.md §5):
 * patched (in effect), restart-needed (patched, but the running MainApp
 * started before the bundles were written), unpatched, mismatch, unknown
 * (the tool gave no answer), or null without the tool. */
function privacyState(conf) {
    if (!conf.privacy_tool || !fs.existsSync(conf.privacy_tool)) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        cp.execFile(process.execPath, [conf.privacy_tool, 'check', '--json'], { timeout: 60000, maxBuffer: 1 << 20 },
            (err, stdout) => {
                try {
                    const r = JSON.parse(String(stdout).trim().split('\n').pop());
                    resolve(r.state === 'patched' && r.restartNeeded ? 'restart-needed' : r.state || 'unknown');
                } catch (e) {
                    resolve('unknown');
                }
            });
    });
}

/* ---- downloads ------------------------------------------------------------ */

/* The uplink publishes its lease while it is up; without one there is no
 * internet. With `lease` empty the system resolver and routes are used. */
function readLease(conf) {
    if (!conf.lease) {
        return { online: true, dns: [] };
    }
    try {
        const lease = readJson(conf.lease);
        return { online: true, dns: lease.dns || [] };
    } catch (e) {
        return { online: false, dns: [] };
    }
}

const CACHE_BYTES = 2 << 20;
const CACHE_ONE = 256 << 10;

/* Downloads run in a child as the fetch uid, each into a folder of its own
 * that root makes in state_dir and hands to that uid. Root reads the result
 * only through a descriptor opened without following links and checked to
 * be a regular file of bounded size, and removes the folder's contents as
 * the fetch uid, so nothing that uid plants there leads root anywhere. */
class Fetcher {
    constructor(conf) {
        this.conf = conf;
        this.state = conf.state_dir;
        this.ca = conf.ca_file ? fs.readFileSync(conf.ca_file, 'utf8') : null;
        // url -> { etag, body }: the answers cached() asks for again, oldest first
        this.etags = new Map();
        this.etagBytes = 0;
    }

    // the conf's: a re-picked fetch uid applies to the next download
    get uid() {
        return Number(this.conf.fetch_uid);
    }

    get gid() {
        return Number(this.conf.fetch_gid);
    }

    asFetchUid(opts) {
        return process.getuid() === 0 ? Object.assign(opts, { uid: this.uid, gid: this.gid }) : opts;
    }

    retire(dir) {
        cp.spawn('rm', ['-rf', dir], this.asFetchUid({ stdio: 'ignore' }))
            .on('error', () => { /* no process: the next start retries */ })
            .on('close', () => {
                try {
                    fs.rmdirSync(dir);
                } catch (e) { /* gone, or refilled since: the next start retries */ }
            });
    }

    /* Download folders an earlier run left. */
    clean() {
        mkdirp(this.state, 0o755);
        fs.readdirSync(this.state).filter((n) => /^dl-/.test(n)).forEach((n) => this.retire(path.join(this.state, n)));
    }

    /* The downloaded file's bytes: a regular file of at most maxBytes. */
    collect(file, maxBytes) {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const st = fs.fstatSync(fd);
            if (!st.isFile() || st.size > maxBytes) {
                throw new Error('download is not a file of the expected size');
            }
            const buf = Buffer.alloc(st.size);
            let off = 0;
            while (off < st.size) {
                const n = fs.readSync(fd, buf, off, st.size - off, off);
                if (!n) {
                    break;
                }
                off += n;
            }
            return buf.slice(0, off);
        } finally {
            fs.closeSync(fd);
        }
    }

    get(url, headers, name, maxBytes, onProgress) {
        return this.request({ url, headers, name, maxBytes, onProgress });
    }

    /* get() for an answer that carries an ETag: asked for again with
     * If-None-Match, a 304 (unchanged; GitHub does not count it against a
     * token's rate limit) gives the body kept from before. Bodies of at most
     * CACHE_ONE are kept, CACHE_BYTES in all, the least recently used going
     * first. */
    cached(url, headers, name, maxBytes) {
        const have = this.etags.get(url);
        const ask = have ? Object.assign({}, headers, { 'If-None-Match': have.etag }) : headers;
        return this.request({ url, headers: ask, name, maxBytes, keep: ['etag'] }).then((b) => {
            if (b.notModified && !have) {
                throw new Error(`${name}: 304 with nothing kept`);
            }
            const keep = b.notModified ? have : b.headers.etag && b.length <= CACHE_ONE ? { etag: b.headers.etag, body: b } : null;
            if (this.etags.get(url)) {
                this.etagBytes -= this.etags.get(url).body.length;
                this.etags.delete(url);
            }
            if (keep) {
                this.etags.set(url, keep);
                this.etagBytes += keep.body.length;
                while (this.etagBytes > CACHE_BYTES) {
                    const oldest = this.etags.keys().next().value;
                    this.etagBytes -= this.etags.get(oldest).body.length;
                    this.etags.delete(oldest);
                }
            }
            return b.notModified ? have.body : b;
        });
    }

    /* Downloads url (method GET, or POST with body); resolves with its bytes,
     * the response headers named in job.keep as their .headers. A failure
     * carries the HTTP status as err.status when the server answered. */
    /* Downloads wait for notBefore (a new fetch uid the uplink has not
     * read yet); active counts those under way. */
    request(job) {
        this.active = (this.active || 0) + 1;
        const done = () => {
            this.active--;
        };
        return new Promise((resolve) => setTimeout(resolve, Math.max(0, (this.notBefore || 0) - Date.now())))
            .then(() => this.requestNow(job))
            .then((bytes) => {
                done();
                return bytes;
            }, (err) => {
                done();
                throw err;
            });
    }

    requestNow(job) {
        const { url, headers, name, maxBytes, onProgress } = job;
        if (process.getuid() === 0 && !(this.uid > 0)) {
            return Promise.reject(new Error('no fetch uid (the log says why)'));
        }
        const lease = readLease(this.conf);
        if (!lease.online) {
            return Promise.reject(new Error('no internet (the uplink is down)'));
        }
        mkdirp(this.state, 0o755);
        const dir = path.join(this.state, `dl-${crypto.randomBytes(6).toString('hex')}`);
        fs.mkdirSync(dir, 0o700);
        if (process.getuid() === 0) {
            fs.chownSync(dir, this.uid, this.gid);
        }
        const dest = path.join(dir, name);
        return new Promise((resolve, reject) => {
            const child = cp.spawn(process.execPath, [path.join(HERE, 'fetch.js')],
                this.asFetchUid({ stdio: ['pipe', 'pipe', 'inherit'], cwd: dir, env: {} }));
            let result = null;
            let buf = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (d) => {
                buf += d;
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    let ev;
                    try {
                        ev = JSON.parse(line);
                    } catch (e) {
                        continue;
                    }
                    if (ev.progress !== undefined && onProgress) {
                        onProgress(ev.progress, ev.total || maxBytes || null);
                    } else if (ev.done || ev.error || ev.notModified) {
                        result = ev;
                    }
                }
            });
            child.on('error', reject);
            child.on('close', () => {
                if (result && result.notModified) {
                    resolve(Object.assign(Buffer.alloc(0), { headers: result.headers || {}, notModified: true }));
                } else if (result && result.done) {
                    try {
                        resolve(Object.assign(this.collect(dest, maxBytes), { headers: result.headers || {} }));
                    } catch (err) {
                        reject(err);
                    }
                } else {
                    reject(Object.assign(new Error(result && result.error || 'download failed'),
                        result && result.status ? { status: result.status } : {}, result && result.rateLimited ? { rateLimited: true } : {},
                        result && result.tooBig ? { tooBig: true } : {}));
                }
            });
            child.stdin.end(JSON.stringify({ url, headers, dest, maxBytes, dns: lease.dns, ca: this.ca,
                method: job.method || 'GET', body: job.body, keep: job.keep || [] }));
        }).then((bytes) => {
            this.retire(dir);
            return bytes;
        }, (err) => {
            this.retire(dir);
            throw err;
        });
    }
}

/* ---- the daemon ----------------------------------------------------------- */

const SELF_SOURCE_ID = 'mgu-store';

/* IterioDev's App Manager and its iPhone tether: the Store and mgu-uplink
 * replace them, so whichever source lists them, they are not installed
 * (README.md, "IterioDev's App Manager"). */
const APP_MANAGER = 'oap-appmanager';
const REPLACED = { [APP_MANAGER]: 'Replaced by Store', 'ipheth-tether': 'Replaced by mgu-uplink' };
// the origin of an app the App Manager installed from no source the updater reads
const IMPORTED = 'imported';
// the repository whose own installer (deploy/mgu-app-install.sh) the deploy tool recognises
const IDRIVE7_REPO = 'cauliflowermossgrape/idrive7-apps';

/* entry as it installs under id, its own id as listedId (Updater.place). */
function under(entry, id) {
    return Object.assign({}, entry, { id, listedId: entry.id, artifact: Object.assign({}, entry.artifact, { name: `${id}@${entry.version}.tgz` }) });
}
// Requests only the Store and the phone page may make (they hold the secret).
const PRIVILEGED = ['uninstall', 'rollback', 'source-add', 'source-probe', 'source-remove', 'login-start', 'login-cancel', 'token-add', 'token-remove', 'web', 'logs',
    'uplink-prefer', 'wifi-enable', 'wifi-scan', 'wifi-connect', 'wifi-forget'];

/* The uplink's requests (native/mgu-uplink ctl.sock) the Store makes through
 * the updater (README.md, "The uplink"): each one's ctl.sock request, built
 * from the Store's fields only (never the secret), or why it is refused. */
const SSID_OK = (s) => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= 32;
const UPLINK_OPS = {
    'uplink-prefer': (r) => (typeof r.kind === 'string' && /^[a-z]{0,16}$/.test(r.kind) ? { op: 'prefer', kind: r.kind }
        : 'uplink-prefer needs a kind ("" for none)'),
    'wifi-enable': (r) => (typeof r.on === 'boolean' ? { op: 'wifi-enable', on: r.on } : 'wifi-enable needs on: true or false'),
    'wifi-scan': () => ({ op: 'wifi-scan' }),
    'wifi-connect': (r) => (!SSID_OK(r.ssid) ? 'a network name is 1 to 32 bytes'
        // a WPA passphrase: 8 to 63 printable ASCII characters; none for a saved or an open network
        : r.psk !== undefined && r.psk !== '' && !(typeof r.psk === 'string' && /^[\x20-\x7e]{8,63}$/.test(r.psk))
            ? 'a Wi-Fi password is 8 to 63 letters, digits and symbols'
            : Object.assign({ op: 'wifi-connect', ssid: r.ssid }, r.psk ? { psk: r.psk } : {})),
    'wifi-forget': (r) => (SSID_OK(r.ssid) ? { op: 'wifi-forget', ssid: r.ssid } : 'a network name is 1 to 32 bytes')
};
const UPLINK_WAIT_MS = 12000;           // the uplink answers within its own 10 s deadline

/* The phone page (web.js, README.md "Phone page"), when this version has it. */
let web = fs.existsSync(path.join(HERE, 'web.js')) ? require('./web') : null;

/* The Store's uid, from MainApp's registry, or null while it is not installed. */
function storeUid(conf) {
    try {
        const uid = readJson(path.join(conf.oap_root, `oap_${conf.mainapp_uid}`, 'data', 'apps', `${conf.store_app}.json`)).userId;
        return Number.isInteger(uid) && uid > 0 ? uid : null;
    } catch (e) {
        return null;
    }
}

/* The Store's tile shows: its registry entry's provisioning flags enable
 * and allow it (as the deploy tool reads them). */
function storeTileShows(conf) {
    try {
        const cache = readJson(path.join(conf.oap_root, `oap_${conf.mainapp_uid}`, 'data', 'apps', `${conf.store_app}.json`)).provisioningCache || {};
        return cache['-enabled'] === 'true' && cache['-allowed'] === 'true';
    } catch (e) {
        return false;
    }
}

/* A process of the Store runs: one whose command line names its home's source. */
function storeRunning(conf) {
    const uid = storeUid(conf);
    const proc = conf.proc || '/proc';
    if (!uid) {
        return false;
    }
    const mark = `/oap_${uid}/source`;
    let pids = [];
    try {
        pids = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n));
    } catch (e) {
        return false;
    }
    return pids.some((pid) => {
        try {
            return fs.readFileSync(path.join(proc, pid, 'cmdline'), 'utf8').indexOf(mark) >= 0;
        } catch (e) {
            return false;
        }
    });
}

/* Writes text to file as uid:gid with groups as its only other groups, 0400,
 * by rename, in a child that takes those ids before it touches the file (no
 * text: removes file): a link in a folder the uid owns leads the write
 * nowhere it could not write itself. spawn's own uid option would leave the
 * child no supplementary groups. */
const WRITE_AS = 'const fs = require("fs"); const f = process.argv[1]; const ids = process.argv[2] && JSON.parse(process.argv[2]);' +
    'if (ids) { process.setgroups(ids.groups); process.setgid(ids.gid); process.setuid(ids.uid); } let s = "";' +
    'process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => {' +
    'if (!s) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== "ENOENT") throw e; } return; }' +
    'const t = `${f}.${process.pid}`; try { fs.unlinkSync(t); } catch (e) {}' +
    'const fd = fs.openSync(t, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o400);' +
    'fs.writeSync(fd, s); fs.closeSync(fd); fs.renameSync(t, f); });';

function writeAs(file, text, uid, gid, groups) {
    return new Promise((resolve, reject) => {
        const ids = process.getuid() === 0 ? [JSON.stringify({ uid, gid, groups: groups || [gid] })] : [];
        const child = cp.spawn(process.execPath, ['-e', WRITE_AS, file].concat(ids), { stdio: ['pipe', 'ignore', 'pipe'], env: {} });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', reject);
        // the thrown error's own line, not the stack under it
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.split('\n').find((l) => /^\w*Error\b/.test(l)) || `exit ${code}`))));
        child.stdin.end(text);
    });
}

class Updater {
    constructor(conf) {
        this.conf = conf;
        this.version = selfVersion();
        this.uids = new ServiceUids(conf, (l) => console.log(l));
        const picked = this.uids.ensure();
        this.fetcher = new Fetcher(conf);
        if (picked.some((c) => c.role === 'fetch')) {
            this.fetcher.notBefore = Date.now() + UPLINK_RESCAN_MS;
        }
        this.tokens = new Tokens(conf.credentials_dir || path.join(conf.state_dir, 'credentials'));
        this.ctx = {
            net: this.fetcher,
            // the token picked for a source (checkSource), its text read when used
            tokenFor: (id) => {
                const rt = this.src.get(id);
                return rt && rt.tokenId ? this.tokens.text(rt.tokenId) : '';
            },
            version: this.version,
            githubApi: conf.github_api || 'https://api.github.com',
            // a public repo without a token is read from these (sources.js githubReader)
            githubWeb: conf.github_web || 'https://github.com',
            githubRaw: conf.github_raw || 'https://raw.githubusercontent.com',
            githubCodeload: conf.github_codeload || 'https://codeload.github.com',
            maxRepoBytes: Number(conf.repo_max_bytes) || 64 << 20,
            maxBuildBytes: Number(conf.build_max_bytes) || 200 << 20,
            // an index source's packages, kept by their sha256
            cacheDir: path.join(conf.state_dir, 'index')
        };
        this.stored = [];
        this.usb = [];
        this.src = new Map();
        this.origins = {};
        this.busy = null;
        this.queue = [];
        this.errors = {};
        this.pending = [];
        // iDrive 8: the app changes the deploy tool queued for the next start, by id ('install' or 'remove')
        this.nextStart = {};
        // the deploy tool's last start's apply (last_apply, lastApplyOf); and, by id, the apply whose
        // failure an install or removal asked for since put aside (apply-seen.json)
        this.lastApply = { at: null, failed: {}, installed: [] };
        this.applySeen = {};
        // by id: the version the deploy tool's rollback returns to (status --json previous)
        this.previous = {};
        // by id: what the last start's check found not working (last_verify)
        this.lastVerify = {};
        // the Store update waiting for the new Store to say hello: { version, tileBefore, seenAt, since } (store-trial.json)
        this.storeTrial = null;
        this.unit = null;
        this.providers = {};
        // the deploy tool's word on IterioDev's App Manager (status --json appmanager)
        this.appmanager = null;
        // the deploy tool's appmanager adopt runs once per start
        this.adoptTried = false;
        this.privacy = null;
        this.clients = new Set();
        this.checking = null;
        this.sendTimer = null;
        this.rebooting = false;
        this.rebootError = null;
        this.secret = crypto.randomBytes(32).toString('hex');
        // the uplink's status.json as read last (readUplink)
        this.uplinkText = null;
        this.uplink = null;
        this.readUplink();
        this.storeSecretUid = null;
        this.webUrl = null;
        this.webEnabled = false;
        this.login = new DeviceLogin({
            net: this.fetcher,
            clientId: conf.github_client_id || '',
            web: conf.github_web || 'https://github.com',
            api: this.ctx.githubApi,
            version: this.version,
            changed: () => this.changed(),
            log: (l) => console.log(l),
            done: (token, meta) => this.signedIn(token, meta)
        });
        try {
            this.origins = readJson(path.join(conf.state_dir, 'origins.json'));
        } catch (e) { /* none yet */ }
        try {
            const trial = readJson(path.join(conf.state_dir, 'store-trial.json'));
            this.storeTrial = catalogLib.SEMVER.test(trial.version) ? { version: trial.version, tileBefore: trial.tileBefore === true,
                seenAt: 0, since: 0 } : null;
        } catch (e) { /* no Store update on trial */ }
        // { "<origin>:<id its source lists>": "<id it is installed under>" } (README.md, "Ids")
        this.aliases = {};
        try {
            this.aliases = readJson(path.join(conf.state_dir, 'aliases.json'));
        } catch (e) { /* none yet */ }
        // what was taken over from IterioDev's App Manager: { at, imported: [ids] }
        this.adopted = { at: null, imported: [] };
        try {
            this.adopted = Object.assign(this.adopted, readJson(path.join(conf.state_dir, 'appmanager.json')));
        } catch (e) { /* none */ }
        try {
            this.webEnabled = readJson(path.join(conf.state_dir, 'web.json')).enabled === true;
        } catch (e) { /* off */ }
        try {
            const seen = readJson(path.join(conf.state_dir, 'apply-seen.json'));
            this.applySeen = seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {};
        } catch (e) { /* none */ }
        if (conf.sources) {
            this.loadSources();
            this.addDefaultSources();
            // the per-source tokens of an earlier version, as tokens
            const was = this.tokens.convert(this.stored, (l) => console.log(l));
            Object.keys(was).forEach((id) => {
                const rt = this.src.get(id);
                if (rt && !rt.tokenId) {
                    rt.tokenId = was[id];
                }
            });
        }
    }

    builtin() {
        return { id: SELF_SOURCE_ID, type: 'github', repo: this.conf.builtin_repo || 'robertnisipeanu/mgu-store', builtin: true };
    }

    /* sources.json (seeded by the installers, then written by the updater);
     * without it, the built-in source alone. The built-in source is always
     * there. A file that cannot be read leaves the built-in source alone and
     * says why. */
    loadSources() {
        let list;
        try {
            list = sourcesLib.load(this.conf.sources) || [];
        } catch (e) {
            console.log(`sources: ${e.message}`);
            this.sourcesError = e.message;
            list = [];
        }
        if (!list.some((s) => s.builtin)) {
            list.unshift(this.builtin());
        }
        this.stored = list;
        list.forEach((def) => this.addRuntime(def));
    }

    /* A source id from want (a repo's name) when it is free, else s-<random>. */
    freeSourceId(want) {
        const taken = (id) => this.stored.some((s) => s.id === id);
        return want && ID.test(want) && !taken(want) ? want : `s-${crypto.randomBytes(2).toString('hex')}`;
    }

    /* The default sources (default_sources: <owner>/<repo>[:<channel>] ...),
     * each added once: on the first start of an updater that names it,
     * unless a source of that repo is there. state/default-sources.json
     * records each one, so one the owner removes stays removed. */
    addDefaultSources() {
        const want = String(this.conf.default_sources || '').split(/\s+/).filter(Boolean);
        if (!want.length || this.sourcesError) {
            return;
        }
        const file = path.join(this.conf.state_dir, 'default-sources.json');
        let added = [];
        try {
            added = readJson(file).added || [];
        } catch (e) { /* none yet */ }
        const fresh = want.filter((w) => added.indexOf(w.split(':')[0].toLowerCase()) < 0);
        if (!fresh.length) {
            return;
        }
        let list = this.stored;
        const defs = [];
        fresh.forEach((w) => {
            const i = w.indexOf(':');
            const repo = i < 0 ? w : w.slice(0, i);
            if (!list.some((s) => s.type === 'github' && s.repo.toLowerCase() === repo.toLowerCase())) {
                const def = { id: this.freeSourceId(repo.split('/')[1] && repo.split('/')[1].toLowerCase()), type: 'github', repo };
                if (i >= 0) {
                    def.channel = w.slice(i + 1);
                }
                try {
                    sourcesLib.checkStored(def);
                } catch (e) {
                    console.log(`default_sources: ${w}: ${e.message}`);
                    return;
                }
                list = list.concat([def]);
                defs.push(def);
            }
            added.push(repo.toLowerCase());
        });
        try {
            if (defs.length) {
                this.saveSources(list);
            }
        } catch (e) {
            console.log(`default sources: ${e.message}`);
            return;
        }
        defs.forEach((def) => {
            this.addRuntime(def);
            console.log(`source ${def.id}: added as a default source (${sourcesLib.label(def)}${def.channel ? `, ${def.channel}` : ''})`);
        });
        try {
            mkdirp(this.conf.state_dir, 0o755);
            writeAtomic(file, JSON.stringify({ added }, null, 1));
        } catch (e) {
            console.log(`default sources: ${e.message}`);
        }
    }

    cacheFile(id) {
        return path.join(this.conf.state_dir, 'sources', `${id}.json`);
    }

    /* A source's runtime state, with the components it listed when last read,
     * the token that read it (tokenId), whether its repo said it is public,
     * and what the listing was made from (memo: a commit, a catalog.json or
     * release assets, as the GitHub reader keys it), so an unchanged one is
     * not read again; one an earlier updater version made is not used. */
    addRuntime(def) {
        const rt = { def, reader: sourcesLib.reader(def, this.ctx), status: 'ok', error: null, checkedAt: null,
            channel: def.channel || null, mode: null, commit: null, components: [], checking: null, answered: false,
            tokenId: null, public: false, memo: null };
        if (def.type !== 'usb') {
            try {
                const c = readJson(this.cacheFile(def.id));
                Object.assign(rt, { mode: c.mode, channel: c.channel || rt.channel, commit: c.commit, components: c.components, checkedAt: c.checkedAt,
                    tokenId: c.token || null, public: c.public === true });
                if (c.memo && typeof c.memo.key === 'string' && c.memo.version === this.version) {
                    rt.memo = { key: c.memo.key, cat: { mode: c.mode, commit: c.commit, components: c.components, skipped: c.memo.skipped || [], memoKey: c.memo.key } };
                }
            } catch (e) { /* not read yet */ }
        }
        this.src.set(def.id, rt);
        return rt;
    }

    defs() {
        return this.stored.concat(this.usb);
    }

    /* The source the installed component of id came from (origins.json),
     * else null. */
    holder(id) {
        const o = this.origins[id];
        return o && this.installedOf(id) ? o.source : null;
    }

    /* The origin a source stands for: a stick folder mgu-install.js
     * usb-repo wrote from a stored source (its copyOf, mgu-copy.json:
     * github:<owner>/<repo> or the catalog's URL) stands for that source;
     * any other source for itself. */
    originOf(id) {
        const rt = this.src.get(id);
        const copy = rt && rt.def.type === 'usb' && rt.copyOf ? rt.copyOf.toLowerCase() : null;
        const def = copy && this.stored.find((d) => (d.type === 'github' ? `github:${d.repo}` : d.url || '').toLowerCase() === copy);
        const folder = !copy && /^usb:[^/]*\/mgu-repo\/([^/]+)$/.exec(id);
        return def ? def.id : folder && this.stored.some((d) => d.id === folder[1]) ? folder[1] : id;
    }

    sourceLabel(id) {
        const def = this.defs().find((d) => d.id === id);
        return def ? sourcesLib.label(def) : id;
    }

    /* The origin that updates an installed id whose own origin lists it no
     * more, or that has none (installed from outside the updater, imported),
     * of the origins listing it that hold no other id for it (aside): the
     * one whose listing has the installed one's title (an app's en_GB
     * entry-point text, a tool's component.json title), or, for one with
     * no recorded origin, the only one listing it. Else none: two of that
     * title, or none of it. */
    openLead(id, origins, recorded) {
        const have = installedApp(this.conf, id, true) || installedTool(this.conf, id);
        const titled = origins.filter((g) => have.title && g.best.entry.title === have.title);
        return !recorded && origins.length === 1 ? origins[0] : titled.length === 1 ? titled[0] : null;
    }

    /* Of one origin's listings of an id, the one it offers: the highest
     * version; of equal versions the source that installed it, then USB
     * media, then sources.json order. Without internet, a network source's
     * last listing counts only when no reachable source of the origin
     * lists the id. */
    best(list) {
        const o = this.origins[list[0].entry.id];
        const rank = (c) => (o && o.source === c.source ? 0 : c.usb ? 1 : 2);
        const pool = list.some((c) => c.reachable) ? list.filter((c) => c.reachable) : list;
        return pool.reduce((a, c) => {
            const cmp = catalogLib.compareVersions(c.entry.version, a.entry.version);
            return cmp > 0 || (cmp === 0 && (rank(c) < rank(a) || (rank(c) === rank(a) && c.order < a.order))) ? c : a;
        });
    }

    /* The ids the updater never removes: itself, the deploy tool, the Store
     * and what the updater requires. */
    kept() {
        return [SELF, this.conf.deploy_tool, this.conf.store_app].concat(Object.keys(selfComponent().requires || {}));
    }

    /* The row of an installed component no listing stands for: its id
     * belongs to no origin that lists it (source: its origin, imported, or
     * null). It is shown, and can be removed (what the updater never removes
     * not, nor a tool whose own component.json does not say it can be), but nothing
     * installs over it. A tool's requirements are its component.json's. */
    originless(id, source) {
        const i = installedApp(this.conf, id, true) || installedTool(this.conf, id);
        let c = {};
        try {
            c = i.kind === 'tool' ? readJson(path.join(this.conf.tool_root, id, 'current', 'component.json')) : {};
        } catch (e) { /* none */ }
        const kept = this.kept();
        const requires = c.requires && typeof c.requires === 'object' && !Array.isArray(c.requires) ?
            Object.keys(c.requires).filter((k) => ID.test(k) && k !== id && catalogLib.SEMVER.test(c.requires[k]))
                .reduce((o, k) => Object.assign(o, { [k]: c.requires[k] }), {}) : {};
        return { entry: catalogLib.checkExtras({ id, kind: i.kind, version: i.version, title: i.title || id, requires,
            uninstallable: kept.indexOf(id) < 0 && (i.kind !== 'tool' || c.uninstallable === true),
            mguProvides: i.kind === 'tool' && typeof c.mguProvides === 'string' ? c.mguProvides : null,
            artifact: { name: '', size: null, sha256: null }, unlisted: true }),
        source: source || (this.adopted.imported.indexOf(id) >= 0 ? IMPORTED : null) };
    }

    /* Every component each origin lists, once per origin (README.md,
     * "Ids"), keyed by the row's id. An installed id is its origin's: that
     * origin's listing is the row of that id, and only it updates it; an
     * id that is not installed goes to the first origin listing a package it
     * cannot build under another id (a package built elsewhere, a tool),
     * else to the first. Each other origin's listing is beside it: one the
     * updater builds under the id it was installed under before
     * (aliases.json), else the first free <id>2, <id>3, ... (the entry as
     * that id, its own as listedId); any other keyed <id>@<source>,
     * installing as <id> (installAs), blocked while another origin's <id> is
     * installed. An installed id without an origin, or whose origin lists it
     * no more, is a row of its own (unlisted). */
    resolved() {
        const online = readLease(this.conf).online;
        const groups = new Map();
        const taken = new Set(Object.keys(this.aliases).map((k) => this.aliases[k]));
        this.defs().forEach((def, order) => {
            const rt = this.src.get(def.id);
            (rt ? rt.components : []).forEach((entry) => {
                taken.add(entry.id);
                const list = groups.get(entry.id) || [];
                list.push({ entry, source: def.id, origin: this.originOf(def.id), order, usb: def.type === 'usb', reachable: online || !rt.reader.network });
                groups.set(entry.id, list);
            });
        });
        const free = (id) => {
            for (let n = 2; n < 100; n += 1) {
                const alias = `${id}${n}`;
                if (ID.test(alias) && !taken.has(alias) && !this.installedOf(alias)) {
                    taken.add(alias);
                    return alias;
                }
            }
            return null;
        };
        const map = new Map();
        groups.forEach((list, id) => {
            const holder = this.holder(id);
            const installed = !!this.installedOf(id);
            const origins = [];
            list.forEach((c) => {
                const g = origins.find((x) => x.origin === c.origin) || origins[origins.push({ origin: c.origin, list: [] }) - 1];
                g.list.push(c);
            });
            origins.forEach((g) => {
                g.best = this.best(g.list);
                g.aside = sourcesLib.renameable(g.best.entry) && !!this.aliases[`${g.origin}:${id}`];
            });
            const lead = installed ? origins.find((g) => holder && g.origin === this.originOf(holder)) || this.openLead(id, origins.filter((g) => !g.aside), !!holder) :
                origins.find((g) => !g.aside && !sourcesLib.renameable(g.best.entry)) || origins.find((g) => !g.aside);
            if (lead) {
                map.set(id, { entry: lead.best.entry, source: lead.best.source });
            } else if (installed) {
                map.set(id, this.originless(id, holder));
            }
            origins.filter((g) => g !== lead).forEach((g) => {
                const { entry, source } = g.best;
                const alias = sourcesLib.renameable(entry) && (this.aliases[`${g.origin}:${id}`] || free(id));
                if (alias && !map.has(alias)) {
                    map.set(alias, { entry: under(entry, alias), source });
                    return;
                }
                const key = `${id}@${source}`;
                map.set(key, { entry: Object.assign({}, entry, { id: key, listedId: id, installAs: id,
                    blocked: installed ? `${id} is already installed${holder ? ` from ${this.sourceLabel(holder)}` : ''}` : null }), source });
            });
        });
        this.unlisted().forEach((r) => {
            if (!map.has(r.entry.id)) {
                map.set(r.entry.id, r);
            }
        });
        // installed, ours, and no source lists its id: kept for its Remove
        Object.keys(this.origins).concat(this.own || []).forEach((id) => {
            if (!map.has(id) && this.installedOf(id)) {
                map.set(id, this.originless(id, this.origins[id] ? this.origins[id].source : null));
            }
        });
        // what the Store and mgu-uplink replace is never installed, from whichever source; an app can
        // be removed whatever its source says, and what the updater never removes cannot
        const kept = this.kept();
        map.forEach((r, key) => {
            const why = REPLACED[r.entry.installAs || r.entry.listedId || r.entry.id];
            const uninstallable = kept.indexOf(r.entry.installAs || r.entry.id) < 0 && (r.entry.kind === 'app' || r.entry.uninstallable === true);
            if (why || uninstallable !== r.entry.uninstallable) {
                map.set(key, { entry: Object.assign({}, r.entry, why ? { blocked: why } : {}, { uninstallable }), source: r.source });
            }
        });
        return map;
    }

    amPresent() {
        return !!(this.appmanager && this.appmanager.present);
    }

    /* Rows for what no source lists: the App Manager's app while it is on
     * the unit (for its Remove), and the installed apps it put there from
     * no source the updater reads (origin imported). */
    unlisted() {
        const row = (id, title, extra) => ({ source: IMPORTED, entry: Object.assign({ id, kind: 'app', title, version: null,
            requires: {}, artifact: {}, uninstallable: true }, extra) });
        const out = [];
        const am = this.appmanager;
        const mine = installedApp(this.conf, APP_MANAGER);
        if (mine || this.amPresent()) {
            out.push(row(APP_MANAGER, 'App Manager', { version: mine ? mine.version : am.app || am.version, author: 'IterioDev',
                blocked: REPLACED[APP_MANAGER] }));
        }
        this.adopted.imported.forEach((id) => {
            const i = installedApp(this.conf, id, true);
            if (i) {
                out.push(row(id, i.title || id, { version: i.version }));
            }
        });
        return out;
    }

    /* The last start's failed apply of id ({ op, why, unlisted }), until an
     * install or removal of id is asked for (or a newer start applies), else
     * null. An app it put in place that MainApp has not listed by the end of
     * PLACED_GRACE_MS counts as a failed install (unlisted). */
    applyError(id) {
        const unlisted = this.lastApply.installed.indexOf(id) >= 0 && !this.placed(id, 'app') && !this.installedOf(id);
        const f = this.lastApply.failed[id] ||
            (unlisted ? { op: 'install', why: 'put in place at the last start but not registered', unlisted } : null);
        return f && this.applySeen[id] !== this.lastApply.at ? f : null;
    }

    /* When this start of the head unit began (ms). */
    bootAt() {
        try {
            return Date.now() - Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
        } catch (e) {
            return 0;
        }
    }

    /* An app this start put in place (iDrive 8) that MainApp does not list
     * yet, within PLACED_GRACE_MS of it. */
    placed(id, kind) {
        const at = Date.parse(this.lastApply.at || '');
        return kind === 'app' && this.lastApply.installed.indexOf(id) >= 0 && at >= this.bootAt() &&
            Date.now() - at < PLACED_GRACE_MS && !this.installedOf(id, kind);
    }

    /* The state goes out again when an app the last start put in place is
     * listed by MainApp, or its time to be listed runs out. */
    watchPlaced() {
        const now = this.lastApply.installed.map((id) => `${id}:${!!this.installedOf(id, 'app')}:${this.placed(id, 'app')}`).join();
        if (now !== this.placedSeen) {
            this.placedSeen = now;
            this.changed();
        }
    }

    /* Puts aside the last start's failed apply of id, also across restarts. */
    putAside(id) {
        if (!this.applyError(id)) {
            return;
        }
        const at = this.lastApply.at;
        this.applySeen = Object.keys(this.applySeen).filter((k) => this.applySeen[k] === at)
            .reduce((o, k) => Object.assign(o, { [k]: at }), { [id]: at });
        mkdirp(this.conf.state_dir, 0o755);
        writeAtomic(path.join(this.conf.state_dir, 'apply-seen.json'), JSON.stringify(this.applySeen));
    }

    installedOf(id, kind, wantTitle) {
        if (kind === 'app') {
            return installedApp(this.conf, id, wantTitle);
        }
        if (kind === 'tool') {
            return installedTool(this.conf, id);
        }
        return installedApp(this.conf, id) || installedTool(this.conf, id);
    }

    sourceState(def) {
        const rt = this.src.get(def.id);
        const token = rt.tokenId && rt.status !== 'auth-needed' ? this.tokens.get(rt.tokenId) : null;
        return {
            id: def.id,
            type: def.type,
            label: sourcesLib.label(def),
            builtin: !!def.builtin,
            usb: def.type === 'usb',
            channel: def.type === 'github' ? rt.channel || def.channel || null : null,
            status: rt.status,
            error: rt.error,
            auth: token ? { kind: 'github', token: token.id, login: token.login || null } : null,
            checkedAt: rt.checkedAt,
            components: rt.components.length
        };
    }

    state() {
        const resolved = Array.from(this.resolved().values());
        const installed = resolved.map((r) => this.installedOf(r.entry.id, r.entry.kind, r.entry.title === r.entry.id)).filter(Boolean);
        const rows = catalogLib.plan(resolved, installed).map((row, i) => {
            const entry = resolved[i].entry;
            const unit = entry.installAs || entry.id;
            const failed = this.applyError(unit);
            // not installed: only the row of the origin that queued it (or put it in place) is pending
            const rec = this.origins[unit];
            const ours = !!row.installed || (rec ? rec.source === this.originOf(resolved[i].source) : row.id === unit);
            const placed = ours && !row.installed && this.placed(unit, entry.kind);
            const o = this.origins[row.id];
            // a branch's new commit of the same version
            if (row.status === 'installed' && entry.revision && o && o.source === row.source && o.commit && o.commit !== entry.commit) {
                row.status = 'update';
            }
            const icon = entry.icon ? this.iconFile(resolved[i].source, entry) : null;
            // an installed app shows the icon of the package it runs, as the car's app list does
            const own = row.installed && entry.kind === 'app' ? this.installedIcon(entry.installAs || entry.id) : null;
            // the App Manager's service alone is enough for its Remove
            if (row.id === APP_MANAGER && !row.installed && this.amPresent()) {
                row.installed = this.appmanager.version;
            }
            return Object.assign(row, {
                // the kept icon (a PNG anyone may read), null without one
                icon: own || (icon && fs.existsSync(icon) ? icon : null),
                compat: catalogLib.compat(row.mguHmi, this.unit && this.unit.hmi),
                revision: entry.revision || null,
                // the id its source lists, when the row's id is another
                listedId: entry.listedId || null,
                // the id it is, or would be, installed under
                installAs: entry.installAs || entry.id,
                // why it cannot be installed: another origin's component has its id
                blocked: entry.blocked || null,
                // also an install queued for the next start (iDrive 8), not installed until then
                pendingReboot: placed || (ours && this.pending.indexOf(unit) >= 0),
                problem: row.installed && entry.kind === 'tool' ? toolProblem(this.conf, unit) : null,
                nextStart: (ours && this.nextStart[unit]) || (placed ? 'install' : null),
                queued: this.queue.some((q) => q.id === row.id),
                // the version Undo update returns to, only where it is offered
                previous: row.installed && ours ? this.undoTo(unit) : null,
                error: this.errors[row.id] || (failed && failed.why) || this.verifyError(unit) || null,
                // what the last start failed to apply, while its error shows
                applyFailed: !this.errors[row.id] && failed ? failed.op : null
            });
        });
        const sources = this.defs().map((d) => this.sourceState(d));
        const tokens = this.tokens.all().map((t) => ({ id: t.id, kind: t.kind, label: t.label || null, login: t.login || null,
            addedAt: t.addedAt || null, rejected: t.rejected === true,
            usedBy: sources.filter((x) => x.auth && x.auth.token === t.id).map((x) => x.id) }));
        const st = {
            type: 'state',
            updater: { version: this.version },
            unit: this.unit,
            // the installed tools providing each capability
            allProviders: this.providers,
            // one of them each, for clients that know a single provider (the Store 0.7)
            providers: Object.keys(this.providers).reduce((o, cap) => Object.assign(o, { [cap]: this.providers[cap][0] }), {}),
            online: readLease(this.conf).online,
            // the uplink's device, preferred group and Wi-Fi (its status.json), null while it does not run
            uplink: this.uplink,
            privacy: this.privacy,
            // one line for clients that know a single catalog (the Store 0.3)
            catalog: {
                commit: (this.src.get(SELF_SOURCE_ID) || {}).commit || null,
                checkedAt: sources.reduce((m, s) => Math.max(m, s.checkedAt || 0), 0) || null,
                checking: !!this.checking || sources.some((s) => s.status === 'checking'),
                error: this.catalogError()
            },
            sources,
            tokens,
            // GitHub sign-in is offered only with a GitHub App client id configured
            signin: !!this.conf.github_client_id,
            // the App's install page, for a repo its sign-in does not reach yet
            signinApp: appInstall(this.conf.github_app_url),
            login: this.login.state(),
            busy: this.busy,
            rebooting: this.rebooting,
            rebootError: this.rebootError,
            components: rows
        };
        if (web) {
            st.web = web.state();
        }
        return st;
    }

    /* The first source that could not be read, as one line. */
    catalogError() {
        if (this.sourcesError) {
            return `sources.json: ${this.sourcesError}`;
        }
        const bad = this.defs().map((d) => this.src.get(d.id)).find((rt) => rt.status === 'error' || rt.status === 'auth-needed');
        return bad ? `${sourcesLib.label(bad.def)}: ${bad.error}` : null;
    }

    /* Sends the state to every client, at most every 250 ms. */
    changed() {
        if (this.sendTimer) {
            return;
        }
        this.sendTimer = setTimeout(() => {
            this.sendTimer = null;
            const line = JSON.stringify(this.state()) + '\n';
            this.clients.forEach((s) => s.write(line));
        }, 250);
    }

    /* Tokens that have run out get new ones from their refresh tokens; one
     * renewal at a time serves every source read meanwhile. */
    freshTokens() {
        if (!this.renewing) {
            const due = this.tokens.all().filter((t) => t.expiresAt && t.expiresAt <= Date.now() + 60000 && t.refreshToken);
            this.renewing = due.reduce((p, t) => p.then(() => this.login.refresh(t)).then((r) => {
                if (r) {
                    this.tokens.setText(t.id, r.token, Object.assign({}, r.meta, { rejected: false }));
                    console.log(`token ${t.id}: renewed`);
                }
            }), Promise.resolve()).catch((e) => console.log(`tokens: ${e.message}`)).then(() => {
                this.renewing = null;
            });
        }
        return this.renewing;
    }

    /* The tokens to read a GitHub source with, in order: the one that read it
     * last, then the others GitHub accepts, and no token (null) after them,
     * for a public repo too (GitHub allows a token 5000 requests an hour, an
     * address without one 60). Tokens GitHub rejects come before no token,
     * or after it for a repo known to be public. */
    candidates(rt) {
        const ids = this.tokens.all().map((t) => t.id);
        const order = (ids.indexOf(rt.tokenId) >= 0 ? [rt.tokenId] : []).concat(ids.filter((id) => id !== rt.tokenId));
        const good = order.filter((id) => !this.tokens.get(id).rejected);
        const rejected = order.filter((id) => this.tokens.get(id).rejected);
        return rt.public ? good.concat([null], rejected) : good.concat(rejected, [null]);
    }

    /* A source's listing. A GitHub source is read with each candidate token
     * in turn (a reader of its own per token) until one reaches the repo;
     * that one is kept for it (rt.tokenId), and its downloads use it. The
     * listing, or the error, carries apiRequests: the GitHub API requests
     * the read made. */
    readSource(rt) {
        if (rt.def.type !== 'github') {
            return rt.reader.catalog();
        }
        const cands = this.candidates(rt);
        let requests = 0;
        const attempt = (i) => {
            const text = cands[i] ? this.tokens.text(cands[i]) : '';
            const reader = sourcesLib.reader(rt.def, Object.assign({}, this.ctx, { tokenFor: () => text,
                reuse: (key) => (rt.memo && rt.memo.key === key ? JSON.parse(JSON.stringify(rt.memo.cat)) : null) }));
            return reader.catalog().then((cat) => {
                rt.tokenId = cands[i];
                rt.public = cat.public === true;
                return Object.assign(cat, { apiRequests: requests + reader.apiRequests() });
            }, (err) => {
                requests += reader.apiRequests();
                if (err.auth && i + 1 < cands.length) {
                    return attempt(i + 1);
                }
                if (err.auth) {
                    rt.tokenId = null;
                }
                throw Object.assign(err, { apiRequests: requests });
            });
        };
        return attempt(0);
    }

    /* Reads one source: ok, auth-needed (a GitHub repo no stored token
     * reaches: it answers 401/404), offline (no uplink), or error. A source
     * that cannot be read keeps the components it listed last. */
    checkSource(id) {
        const rt = this.src.get(id);
        if (!rt) {
            return Promise.resolve();
        }
        if (rt.checking) {
            return rt.checking;
        }
        if (rt.reader.network && !readLease(this.conf).online) {
            rt.status = 'offline';
            rt.answered = false;
            this.changed();
            return Promise.resolve();
        }
        rt.status = 'checking';
        this.changed();
        rt.checking = this.freshTokens()
            .then(() => this.readSource(rt))
            .then((cat) => {
                Object.assign(rt, { components: cat.components, mode: cat.mode, channel: cat.channel || rt.channel, commit: cat.commit || null,
                    copyOf: typeof cat.copyOf === 'string' ? cat.copyOf : null,
                    memo: cat.memoKey ? { key: cat.memoKey, cat: JSON.parse(JSON.stringify(cat)) } : null,
                    status: 'ok', error: cat.skipped && cat.skipped.length ? `left out: ${cat.skipped.join('; ')}` : null,
                    checkedAt: Date.now(), answered: true });
                if (rt.def.type !== 'usb') {
                    mkdirp(path.dirname(this.cacheFile(id)), 0o700);
                    writeAtomic(this.cacheFile(id), JSON.stringify({ mode: rt.mode, channel: rt.channel, commit: rt.commit,
                        components: rt.components, checkedAt: rt.checkedAt, token: rt.tokenId, public: rt.public,
                        memo: rt.memo && { key: rt.memo.key, skipped: cat.skipped || [], version: this.version } }));
                }
                console.log(`source ${id}${rt.channel ? ` (${rt.channel})` : ''}${rt.tokenId ? ` with token ${rt.tokenId}` : ''}: ` +
                    `${rt.mode}${rt.commit ? ` ${rt.commit.slice(0, 7)}` : ''}, ` +
                    `${cat.components.map((c) => `${c.id}@${c.version}`).join(' ') || 'nothing'}${rt.error ? `; ${rt.error}` : ''}` +
                    `${cat.apiRequests !== undefined ? `; ${cat.apiRequests} GitHub API requests` : ''}`);
                // in the background: a slow icon host holds up no check
                this.fetchIcons(rt);
            }, (err) => {
                rt.status = err.auth ? 'auth-needed' : 'error';
                rt.error = err.message;
                rt.answered = err.status !== undefined || !!err.auth;
                console.log(`source ${id}: ${rt.status}: ${err.message}` +
                    `${err.apiRequests !== undefined ? `; ${err.apiRequests} GitHub API requests` : ''}`);
            })
            .then(() => {
                rt.checking = null;
                this.changed();
                if (rt.tokensChanged) {
                    rt.tokensChanged = false;
                    if (rt.status === 'auth-needed' || (rt.tokenId && !this.tokens.get(rt.tokenId))) {
                        rt.tokenId = this.tokens.get(rt.tokenId) ? rt.tokenId : null;
                        this.checkSource(id);
                    }
                }
            });
        return rt.checking;
    }

    /* Where an entry's icon is kept: <state_dir>/icons/<sha256>.png, named by
     * the sha256 its source gives, else by source, id, version and URL. */
    iconFile(source, entry) {
        const key = entry.icon.sha256 || sha256(`${source}\0${entry.listedId || entry.id}\0${entry.version}\0${entry.icon.ref}`);
        return path.join(this.conf.state_dir, 'icons', `${key}.png`);
    }

    /* What a failed fetch of an entry's icon is recorded under: source, id,
     * version, URL and sha256, so a new version or a new icon is asked for. */
    iconFailureKey(source, entry) {
        return sha256(`${source}\0${entry.listedId || entry.id}\0${entry.version}\0${entry.icon.ref}\0${entry.icon.sha256 || ''}`);
    }

    /* Writes a checked icon's bytes as file (world-readable, by rename). */
    keepIcon(file, b) {
        mkdirp(path.dirname(file), 0o755);
        fs.writeFileSync(`${file}.tmp`, b, { mode: 0o644 });
        fs.chmodSync(`${file}.tmp`, 0o644);
        fs.renameSync(`${file}.tmp`, file);
    }

    /* Fetches the icons a source's components name that are not kept yet,
     * one source's at a time: a PNG of at most ICON_BYTES, matching its
     * sha256 when the source gives one, kept world-readable for the Store.
     * The component whose row is an installed app with its own icon
     * (installedIcon) has its source's icon fetched only once it has none.
     * An icon that is missing, too big, not a PNG or not its sha256 is not
     * asked for again for that version of the component (and that icon);
     * one that could not be fetched is asked for again a day later; both are
     * kept in state/icon-failures.json across restarts. The component is
     * listed without it. */
    fetchIcons(rt) {
        if (rt.icons) {
            return rt.icons;
        }
        const failed = this.iconFailures();
        // the components of this source whose row is the installed app, showing its own icon (state())
        const shown = new Set();
        this.resolved().forEach((r) => {
            if (r.source === rt.def.id && r.entry.kind === 'app' && this.installedOf(r.entry.id, 'app') &&
                this.installedIcon(r.entry.installAs || r.entry.id)) {
                shown.add(r.entry.listedId || r.entry.id);
            }
        });
        const due = (c) => {
            const f = failed[this.iconFailureKey(rt.def.id, c)];
            return !fs.existsSync(this.iconFile(rt.def.id, c)) && !(f && (f.missing || f.at > Date.now() - 86400000)) &&
                !(c.kind === 'app' && shown.has(c.id));
        };
        rt.icons = rt.components.filter((c) => c.icon && due(c)).reduce((p, c) => p
            .then(() => rt.reader.icon(c))
            .then((b) => {
                if (!sourcesLib.isIcon(b)) {
                    throw Object.assign(new Error(`not a PNG of at most ${sourcesLib.ICON_BYTES} bytes`), { missing: true });
                }
                if (c.icon.sha256 && sha256(b) !== c.icon.sha256) {
                    throw Object.assign(new Error('does not match its sha256'), { missing: true });
                }
                this.keepIcon(this.iconFile(rt.def.id, c), b);
                this.changed();
            })
            .catch((err) => {
                failed[this.iconFailureKey(rt.def.id, c)] = { at: Date.now(),
                    missing: !!(err.missing || err.tooBig || err.status === 404 || err.code === 'ENOENT') };
                this.saveIconFailures();
                console.log(`source ${rt.def.id}: icon of ${c.id}: ${err.message}`);
            }), Promise.resolve()).then(() => {
            rt.icons = null;
        });
        return rt.icons;
    }

    /* The icons that could not be fetched, by iconFailureKey: { at, missing }. */
    iconFailures() {
        if (!this.iconFailed) {
            try {
                this.iconFailed = readJson(path.join(this.conf.state_dir, 'icon-failures.json'));
            } catch (e) {
                this.iconFailed = {};
            }
        }
        return this.iconFailed;
    }

    saveIconFailures() {
        try {
            mkdirp(this.conf.state_dir, 0o755);
            writeAtomic(path.join(this.conf.state_dir, 'icon-failures.json'), JSON.stringify(this.iconFailed));
        } catch (e) {
            console.log(`icon-failures.json: ${e.message}`);
        }
    }

    /* The icon an installed app's package shows on the car's app list (its
     * rhmiData's first entry point's, sourcesLib.entryIcons), kept as
     * <state_dir>/icons/<sha256>.png for the Store; null without a PNG of
     * at most ICON_BYTES. Every folder on the way is a folder, not a link,
     * and no file is read through one. Read again only when its
     * application.json or the icon file changes. */
    installedIcon(id) {
        this.appIcons = this.appIcons || new Map();
        try {
            const home = appHome(this.conf, id);
            const inside = (rel) => sourcesLib.safePath(home, `rhmiData/${rel}`);
            const stamp = (f) => {
                const st = fs.lstatSync(f);
                return `${st.size}:${st.mtime.getTime()}:${st.ino}`;
            };
            const app = inside('application.json');
            const appStamp = `${app}:${stamp(app)}`;
            const kept = this.appIcons.get(id);
            if (kept && kept.app === appStamp && (!kept.ref || kept.from === `${kept.ref}:${stamp(kept.ref)}`) &&
                (!kept.file || fs.existsSync(kept.file))) {
                return kept.file;
            }
            const ref = sourcesLib.entryIcons(readAppJson(app).application, '').map((r) => {
                try {
                    const f = inside(r);
                    return fs.lstatSync(f).isFile() ? f : null;
                } catch (e) {
                    return null;
                }
            }).find(Boolean) || null;
            const from = ref ? `${ref}:${stamp(ref)}` : null;
            const b = ref ? readAppFile(ref, sourcesLib.ICON_BYTES) : null;
            let file = null;
            if (b && sourcesLib.isIcon(b)) {
                file = path.join(this.conf.state_dir, 'icons', `${sha256(b)}.png`);
                if (!fs.existsSync(file)) {
                    this.keepIcon(file, b);
                }
            }
            this.appIcons.set(id, { app: appStamp, ref, from, file });
            return file;
        } catch (e) {
            this.appIcons.delete(id);
            return null;
        }
    }

    /* Removes the kept icons no source's components name and no installed
     * app shows, and the failures of icons no component names. */
    pruneIcons() {
        const dir = path.join(this.conf.state_dir, 'icons');
        (this.appIcons || new Map()).forEach((k, id) => {
            if (!installedApp(this.conf, id)) {
                this.appIcons.delete(id);
            }
        });
        const keep = Array.from((this.appIcons || new Map()).values()).filter((k) => k.file).map((k) => path.basename(k.file));
        const keys = [];
        this.defs().forEach((d) => {
            const rt = this.src.get(d.id);
            (rt ? rt.components : []).filter((c) => c.icon).forEach((c) => {
                keep.push(path.basename(this.iconFile(d.id, c)));
                keys.push(this.iconFailureKey(d.id, c));
            });
        });
        try {
            fs.readdirSync(dir).filter((n) => keep.indexOf(n) < 0).forEach((n) => rmIfThere(path.join(dir, n)));
        } catch (e) { /* none yet */ }
        const failed = this.iconFailures();
        const gone = Object.keys(failed).filter((k) => keys.indexOf(k) < 0);
        if (gone.length) {
            gone.forEach((k) => delete failed[k]);
            this.saveIconFailures();
        }
    }

    /* The USB media mounted now (README.md, "USB media"). Returns true when
     * the list changed; new ones are read. */
    scanUsb() {
        const found = sourcesLib.usbSources(this.conf.mounts || '/proc/mounts', String(this.conf.usb_roots || '/media').split(/[\s,]+/).filter(Boolean))
            .map((u) => Object.assign({ id: u.id, type: 'usb', label: u.label, root: u.root }, u.loose ? { loose: true } : {}));
        const key = (l) => l.map((u) => `${u.id}\0${u.root}\0${!!u.loose}`).join('\n');
        if (key(found) === key(this.usb)) {
            return false;
        }
        this.usb.forEach((u) => this.src.delete(u.id));
        this.usb = found;
        found.forEach((u) => {
            this.addRuntime(u);
            console.log(`usb: ${u.id} at ${u.root}`);
            this.checkSource(u.id);
        });
        this.changed();
        return true;
    }

    check() {
        if (this.checking) {
            return this.checking;
        }
        this.changed();
        this.rebootError = null;
        const uids = this.checkUids();
        this.scanUsb();
        this.scanTokens();
        this.validateTokens();
        this.checking = uids.then(() => Promise.all(this.defs().map((d) => this.checkSource(d.id))))
            .then(() => {
                // with every source read, which row is the installed one is settled: once the
                // fetches under way are through, the icons of each source read now are looked at again
                // (in the background); one that could not be read (offline, a refused token) is left alone
                const rts = this.defs().map((d) => this.src.get(d.id)).filter((rt) => rt && rt.status === 'ok');
                this.iconPass = Promise.all(rts.map((rt) => rt.icons)).then(() => Promise.all(rts.map((rt) => this.fetchIcons(rt))));
                return this.pruneIcons();
            })
            .then(() => this.refresh())
            .then(() => {
                this.checking = null;
                this.changed();
            });
        return this.checking;
    }

    /* The version installed of id, or null. */
    installedVersion(id, kind) {
        const i = this.installedOf(id, kind);
        return i ? i.version : null;
    }

    /* dep at least min is installed, or dep provides a capability that
     * another installed tool provides: the owner's choice of that provider
     * stands (a component that needs the renderer installs beside another
     * renderer). */
    requirementMet(dep, min) {
        const have = this.installedVersion(dep);
        if (have && catalogLib.compareVersions(have, min) >= 0) {
            return true;
        }
        const r = this.resolved().get(dep);
        const cap = r && r.entry.mguProvides;
        return !!cap && this.providerIds(cap).some((p) => p !== dep);
    }

    /* The row of dep at least min: of source first, else of any source in
     * order. An installed dep only from its own row, the origin that
     * updates it (resolved). */
    findRequirement(dep, min, source) {
        const installed = !!this.installedOf(dep);
        const rows = Array.from(this.resolved().values()).filter((r) => (installed ? r.entry.id === dep : (r.entry.installAs || r.entry.id) === dep) &&
            !r.entry.unlisted && !r.entry.blocked && this.src.get(r.source) && catalogLib.compareVersions(r.entry.version, min) >= 0);
        const order = [source].concat(this.defs().map((d) => d.id));
        return order.map((id) => rows.find((r) => r.source === id)).filter(Boolean)[0] || null;
    }

    /* What installing r takes, requirements first: [{ id, source }]. */
    installPlan(r, chain) {
        const steps = [];
        Object.keys(r.entry.requires).forEach((dep) => {
            const min = r.entry.requires[dep];
            if (chain.indexOf(dep) >= 0) {
                throw new Error(`${r.entry.id} and ${dep} require each other`);
            }
            if (this.requirementMet(dep, min)) {
                return;
            }
            const found = this.findRequirement(dep, min, r.source);
            if (!found) {
                throw new Error(`needs ${dep} ${min} or newer, which no source has`);
            }
            const bad = this.incompatible(found.entry);
            if (bad) {
                throw new Error(`needs ${dep}, but ${bad}`);
            }
            this.installPlan(found, chain.concat([r.entry.id])).forEach((s) => {
                if (!steps.some((x) => x.id === s.id)) {
                    steps.push(s);
                }
            });
        });
        steps.push(Object.assign({ id: r.entry.id, source: r.source }, r.entry.listedId ? { listed: r.entry.listedId } : {},
            r.entry.installAs ? { unit: r.entry.installAs } : {}));
        return steps;
    }

    /* Why item cannot be queued (the other operation on that id is queued
     * or running), or null. */
    conflict(item) {
        const same = this.queue.find((q) => q.id === item.id) || (this.busy && this.busy.id === item.id ? { op: this.busy.op || 'install' } : null);
        const what = { uninstall: 'a removal', rollback: 'a return to the version before' };
        return same && same.op !== item.op ? `${item.id}: ${what[same.op] || 'an install'} is queued or running` : null;
    }

    /* Queues item unless the same is queued or running; returns why it
     * cannot be queued, or null. */
    enqueue(item) {
        const refused = this.conflict(item);
        if (refused || this.queue.some((q) => q.id === item.id) || (this.busy && this.busy.id === item.id)) {
            return refused;
        }
        delete this.errors[item.id];
        this.putAside(item.unit || item.id);
        this.queue.push(item);
        return null;
    }

    /* Why entry is not for this head unit (its mguHmi), or null. */
    incompatible(entry) {
        const hmi = this.unit && this.unit.hmi;
        if (catalogLib.compat(entry.mguHmi, hmi) !== 'no') {
            return null;
        }
        const name = (h) => (h === 'ID7' ? 'iDrive 7' : h === 'ID8' ? 'iDrive 8' : h);
        return `${entry.title} is for ${entry.mguHmi.map(name).join(' and ')}; this head unit is ${name(hmi)}`;
    }

    /* Queues an install of id, after the requirements it lacks. One that
     * is not for this head unit is refused. */
    request(id) {
        if (this.rebooting) {
            return 'the head unit is restarting';
        }
        const r = this.resolved().get(id);
        if (!r) {
            return `${id} is not in any source`;
        }
        if (r.entry.blocked) {
            return r.entry.blocked;
        }
        if (r.entry.unlisted) {
            return `${id} is installed, and no source of its own lists it`;
        }
        if (!this.src.get(r.source)) {
            return `${id} is in no source`;
        }
        const bad = this.incompatible(r.entry);
        if (bad) {
            this.errors[id] = bad;
            this.changed();
            return bad;
        }
        // a capability it needs: some installed tool provides it
        const lacking = (r.entry.mguNeeds || []).filter((cap) => !this.providerIds(cap).length)[0];
        if (lacking) {
            const offer = Array.from(this.resolved().values()).filter((o) => o.entry.mguProvides === lacking).map((o) => o.entry.title);
            const why = `${r.entry.title} needs a ${lacking}: install ${offer.length ? offer.join(' or ') : 'one'} first`;
            this.errors[id] = why;
            this.changed();
            return why;
        }
        let steps;
        try {
            steps = this.installPlan(r, []);
        } catch (e) {
            this.errors[id] = e.message;
            this.changed();
            return null;
        }
        const items = steps.map((s) => Object.assign({ op: 'install', id: s.id, source: s.source }, s.listed ? { listed: s.listed } : {},
            s.unit ? { unit: s.unit } : {}));
        const refused = items.map((i) => this.conflict(i)).filter(Boolean)[0];
        if (refused) {
            return refused;
        }
        items.forEach((i) => this.enqueue(i));
        this.changed();
        if (!this.busy) {
            this.next();
        }
        return null;
    }

    /* The ids of the installed tools providing cap. */
    providerIds(cap) {
        return (this.providers[cap] || []).map((x) => x.id);
    }

    /* The version id goes back to with Undo update, or null where it is not
     * offered: the deploy tool keeps one, and going back strands nothing.
     * The updater, the deploy tool and the Store never go back this way
     * (the Store goes back by itself when its update does not start), nor
     * a version below what an installed component or the updater requires. */
    undoTo(id) {
        const prev = this.previous[id];
        if (!prev || this.kept().indexOf(id) >= 0) {
            return null;
        }
        const needed = Array.from(this.resolved().values()).some((o) => {
            const min = (o.entry.requires || {})[id];
            return min && o.entry.id !== id && this.installedVersion(o.entry.installAs || o.entry.id, o.entry.kind) &&
                catalogLib.compareVersions(prev, min) < 0;
        });
        return needed ? null : prev;
    }

    /* Queues id's return to its version before (undoTo). */
    requestRollback(id) {
        if (this.rebooting) {
            return 'the head unit is restarting';
        }
        const r = this.resolved().get(id);
        if (!r) {
            return `${id} is not in any source`;
        }
        const unit = r.entry.installAs || id;
        if (!this.installedVersion(unit, r.entry.kind) || !this.undoTo(unit)) {
            return `${id} cannot go back to an earlier version`;
        }
        const refused = this.enqueue(Object.assign({ op: 'rollback', id }, unit !== id ? { unit } : {}));
        if (refused) {
            return refused;
        }
        this.changed();
        if (!this.busy) {
            this.next();
        }
        return null;
    }

    /* The deploy tool's rollback of a component to its version before. why:
     * the reason it goes back (the Store's update that did not start), kept
     * as its error with the outcome. */
    rollback(item) {
        const key = item.id;
        const id = item.unit || item.id;
        const from = this.installedVersion(id);
        this.busy = { id: key, op: 'rollback', phase: 'install' };
        this.changed();
        console.log(`${id}: back to ${this.previous[id] || 'its version before'}`);
        return this.deployTool(['rollback', id, '--yes'])
            .then((code) => {
                if (code !== 0) {
                    const why = this.deployError;
                    throw new Error(code === 2 ? `${why || 'refused by the deploy tool'}; nothing changed` :
                        `going back failed${why ? ': ' + why : ''}`);
                }
                const now = this.installedVersion(id);
                console.log(`${id}: ${from} -> ${now}`);
                if (item.why) {
                    this.errors[key] = `${item.why}; ${now} is back`;
                }
            })
            .catch((err) => {
                console.log(`${id}: ${err.message}`);
                this.errors[key] = item.why ? `${item.why}; ${err.message}` : err.message;
            })
            .then(() => this.refresh())
            .then(() => {
                this.writeSecrets();
                this.busy = null;
                this.changed();
                return false;
            });
    }

    /* What the last start's check found wrong with id, while that is still
     * so: the version rolled back to, or the one that failed, installed. */
    verifyError(id) {
        const v = this.lastVerify[id];
        const have = v && this.installedVersion(id);
        if (!have) {
            return null;
        }
        if (v.rolledBack && have === v.previous) {
            return `${v.version} did not work after the restart (${v.why}); ${v.previous} is back`;
        }
        return !v.rolledBack && have === v.version ? `${v.version} did not work after the restart: ${v.why}` : null;
    }

    /* ---- the Store's update stands once the new Store starts ---- */

    /* A new Store version installs: once it is installed, its tile must
     * show if it did before, and the Store must say hello once it runs. */
    startStoreTrial(version) {
        this.storeTrial = { version, tileBefore: storeTileShows(this.conf), seenAt: 0, since: 0 };
        mkdirp(this.conf.state_dir, 0o755);
        writeAtomic(path.join(this.conf.state_dir, 'store-trial.json'), JSON.stringify({ version, tileBefore: this.storeTrial.tileBefore }));
    }

    endStoreTrial() {
        this.storeTrial = null;
        rmIfThere(path.join(this.conf.state_dir, 'store-trial.json'));
    }

    /* {op: "hello", id, version}: a client says what it is. The Store on
     * trial saying it ends the trial. Nothing is answered. */
    storeHello(req) {
        const t = this.storeTrial;
        if (t && req.id === this.conf.store_app && req.version === t.version) {
            console.log(`${req.id}@${t.version}: started and connected`);
            this.endStoreTrial();
        }
    }

    /* While the Store's update is on trial and that version is installed:
     * a tile that showed before must show again within STORE_HELLO_MS, and
     * once a process of the Store runs, it has STORE_HELLO_MS to say hello;
     * else it goes back to its version before (or, with none kept, says why). */
    watchStoreTrial() {
        const t = this.storeTrial;
        const id = this.conf.store_app;
        if (!t || this.busy || this.queue.length || this.installedVersion(id, 'app') !== t.version) {
            return;
        }
        t.since = t.since || Date.now();
        let why = null;
        if (t.tileBefore && !storeTileShows(this.conf) && Date.now() - t.since >= STORE_HELLO_MS) {
            why = `${t.version}'s tile does not show`;
        } else if (!t.seenAt) {
            if (storeRunning(this.conf)) {
                t.seenAt = Date.now();
                console.log(`${id}@${t.version}: started; waiting for it to connect`);
            }
            return;
        } else if (Date.now() - t.seenAt >= STORE_HELLO_MS) {
            why = `${t.version} did not start`;
        }
        if (!why) {
            return;
        }
        console.log(`${id}@${t.version}: ${why}`);
        this.endStoreTrial();
        if (!this.previous[id]) {
            this.errors[id] = why;
            this.changed();
            return;
        }
        this.enqueue({ op: 'rollback', id, why });
        this.errors[id] = why;
        this.changed();
        this.next();
    }

    /* Queues a removal of id: one its row marks uninstallable, installed
     * (or its install queued for the next start), that nothing installed,
     * nor the updater itself, requires. Of one not installed whose change
     * the last start failed to apply, it puts the failure aside. */
    requestUninstall(id) {
        if (this.rebooting) {
            return 'the head unit is restarting';
        }
        const all = this.resolved();
        const r = all.get(id);
        if (!r) {
            return `${id} is not in any source`;
        }
        const unit = r.entry.installAs || id;
        // the row of the origin that installed (or queued) the id decides
        const rec = this.origins[unit];
        const owner = this.installedOf(unit, r.entry.kind) ? all.get(unit) || r :
            rec ? Array.from(all.values()).find((o) => (o.entry.installAs || o.entry.id) === unit && this.originOf(o.source) === rec.source) || r : r;
        if (owner !== r || !r.entry.uninstallable || id === SELF || id === this.conf.deploy_tool ||
            (selfComponent().requires || {})[id]) {
            return `${id} cannot be removed`;
        }
        // an install queued for the next start (iDrive 8) is dropped from the deploy tool's queue
        if (!this.installedVersion(unit, r.entry.kind) && !(id === APP_MANAGER && this.amPresent()) && this.nextStart[unit] !== 'install' &&
            !this.placed(unit, r.entry.kind)) {
            const failed = this.applyError(unit);
            if (failed && !failed.unlisted && !this.queue.some((q) => q.id === id) && !(this.busy && this.busy.id === id)) {
                console.log(`${unit}: the failed ${failed.op} at the start put aside`);
                this.putAside(unit);
                this.changed();
                return null;
            }
            if (!failed || !failed.unlisted) {
                return `${id} is not installed`;
            }
        }
        const needs = Array.from(all.values()).find((o) => o.entry.requires[id] && this.installedVersion(o.entry.id, o.entry.kind));
        if (needs) {
            return `${needs.entry.title} needs ${id}`;
        }
        // the last provider of a capability an installed component needs stays
        const cap = r.entry.mguProvides;
        const needer = cap && !this.providerIds(cap).some((p) => p !== id) &&
            Array.from(all.values()).find((o) => (o.entry.mguNeeds || []).indexOf(cap) >= 0 && this.installedVersion(o.entry.id, o.entry.kind));
        if (needer) {
            return `${needer.entry.title} needs a ${cap}: remove it first, or install another ${cap}`;
        }
        const refused = this.enqueue(Object.assign({ op: 'uninstall', id }, unit !== id ? { unit } : {}));
        if (refused) {
            return refused;
        }
        this.changed();
        if (!this.busy) {
            this.next();
        }
        return null;
    }

    /* Restarts the head unit with the `reboot` command (updater.conf), on the
     * Store's request. Refused while an install runs or waits, so a restart
     * never cuts one short; installs asked for afterwards are refused. A
     * command that cannot run, exits non-zero or prints nsm_control's
     * "[Error. <why>]" (it exits 0 then too), or a unit still up after
     * REBOOT_WAIT_MS, ends the restart with rebootError until the next check. */
    reboot() {
        if (this.busy || this.queue.length) {
            return 'an install is running';
        }
        if (this.rebooting) {
            return null;
        }
        const argv = String(this.conf.reboot || '').split(/\s+/).filter(Boolean);
        if (!argv.length) {
            return 'no reboot command configured';
        }
        const failed = (why) => {
            if (!this.rebooting) {
                return;
            }
            clearTimeout(timer);
            this.rebooting = false;
            this.rebootError = why;
            console.log(`restart failed: ${why}`);
            this.changed();
        };
        this.rebooting = true;
        this.rebootError = null;
        this.changed();
        console.log(`restarting the head unit: ${argv.join(' ')}`);
        const timer = setTimeout(() => failed('the head unit did not restart'), REBOOT_WAIT_MS);
        cp.execFile(argv[0], argv.slice(1), { timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
            const refused = /\[Error\.\s*([^\]]*)\]/.exec(stdout);
            if (err || refused) {
                failed(refused ? refused[1] : String(stderr).trim().split('\n').pop() || err.message.split('\n')[0]);
            }
        });
        return null;
    }

    /* Takes the next request: the first that does not need a newer updater
     * than this one; the updater's own update when only those are left (the
     * rest of the queue is kept for the new version, queue.json), else
     * last, since it restarts the daemon. */
    next() {
        const needsSelf = (q) => {
            const rt = q.op === 'install' && q.id !== SELF && this.src.get(q.source);
            const own = rt && rt.components.find((c) => c.id === (q.listed || q.id));
            const min = own && own.requires && own.requires[SELF];
            return !!min && !this.requirementMet(SELF, min);
        };
        let i = this.queue.findIndex((q) => q.id !== SELF && !needsSelf(q));
        if (i < 0) {
            i = Math.max(0, this.queue.findIndex((q) => q.id === SELF));
        }
        const item = this.queue.splice(i, 1)[0];
        if (!item) {
            this.busy = null;
            this.changed();
            return;
        }
        (item.op === 'uninstall' ? this.uninstall(item) : item.op === 'rollback' ? this.rollback(item) :
            item.op === 'adopt' ? this.adopt() : this.install(item)).then((handover) => {
            if (handover) {
                this.handover();
                return;
            }
            this.next();
        });
    }

    saveOrigins() {
        mkdirp(this.conf.state_dir, 0o755);
        writeAtomic(path.join(this.conf.state_dir, 'origins.json'), JSON.stringify(this.origins, null, 1));
    }

    saveAliases() {
        mkdirp(this.conf.state_dir, 0o755);
        writeAtomic(path.join(this.conf.state_dir, 'aliases.json'), JSON.stringify(this.aliases, null, 1));
    }

    /* The deploy tool's SDK donor (`sdk-donor --json`: { path, module }), for
     * a repo's build script: the donor bundle, and the folder of the oap-sdk
     * module generated from it (mgu-deploy 0.3.2 and newer; else null). */
    sdkDonor() {
        return new Promise((resolve, reject) => {
            cp.execFile(this.conf.deploy, ['sdk-donor', '--json'], { timeout: 300000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
                let d = null;
                try {
                    d = JSON.parse(String(stdout).trim().split('\n').pop());
                } catch (e) { /* no answer */ }
                if (err || !d || typeof d.path !== 'string' || !d.path) {
                    const why = /mgu-deploy: (.+)/.exec(String(stderr)) || /mgu-deploy: (.+)/.exec(String(stdout));
                    reject(new Error(`no SDK donor for the build${why ? `: ${why[1]}` : ''}`));
                    return;
                }
                resolve({ path: d.path, module: typeof d.module === 'string' && d.module ? d.module : null });
            });
        });
    }

    /* The bytes to hand the deploy tool for entry: the file a catalog or a
     * release lists, or a repo-tree component packed from the repo's files
     * at its commit (a source package or tool kit), or the package the
     * repo's build script makes. own: the entry as its source lists it;
     * entry: the same under the id it installs as, which for an app placed
     * beside another one's id (place) is built from a copy made over to
     * that id (sourcesLib.renameApp), and must come out as that id. */
    artifact(rt, entry, own) {
        const progress = (bytes, total) => {
            this.busy.progress = bytes;
            if (total && !this.busy.total) {
                this.busy.total = total;
            }
            this.changed();
        };
        if (!entry.path) {
            return rt.reader.artifact(entry, progress);
        }
        // a build script needs the whole repo; packing, the component's folder
        return rt.reader.files(entry.commit, progress, entry.script ? null : entry.path).then((files) => {
            const job = { entry: own, files: entry.script ? files : sourcesLib.subtree(files, entry.path) };
            const made = own.id === entry.id ? job : sourcesLib.renameApp(own, job.files, entry.id);
            if (!entry.script) {
                return sourcesLib.packComponent(made.entry, made.files);
            }
            this.busy.phase = 'build';
            this.changed();
            this.building = true;
            const built = () => {
                this.building = false;
                if (this.uidsPending) {
                    this.checkUids();
                }
            };
            return this.sdkDonor()
                // a network build's proxy runs as the fetch uid: once the uplink lets it out
                .then((donor) => new Promise((resolve) => setTimeout(resolve, Math.max(0, (this.fetcher.notBefore || 0) - Date.now())))
                    .then(() => donor))
                .then((donor) => runBuild({ conf: this.conf, entry: made.entry, files: made.files, donor: donor.path, sdk: donor.module,
                    lease: readLease(this.conf), log: (l) => console.log(l) }))
                .then((bytes) => {
                    built();
                    return bytes;
                }, (err) => {
                    built();
                    throw err;
                })
                .then((bytes) => (own.id === entry.id ? bytes : sourcesLib.packageId(bytes, Number(this.conf.build_max_bytes) || 200 << 20)
                    .then((out) => {
                        if (out !== entry.id) {
                            throw new Error(`the build of ${own.id} as ${entry.id} made ${out}: it cannot install beside ${own.id}`);
                        }
                        return bytes;
                    })));
        });
    }

    /* Downloads (or builds), verifies and installs one component. Resolves
     * true when the updater installed a new version of itself. */
    install(item) {
        // the row's id; the id it installs as
        const key = item.id;
        const id = item.unit || item.id;
        const rt = this.src.get(item.source);
        const own = rt && rt.components.find((c) => c.id === (item.listed || key));
        if (!own) {
            this.errors[key] = 'no longer in its source';
            return Promise.resolve(false);
        }
        const entry = own.id !== id ? under(own, id) : own;
        // an uplink installed without internet (from a stick) has none to give back
        const wasOnline = readLease(this.conf).online;
        this.busy = { id: key, op: 'install', phase: 'download', progress: 0, total: entry.artifact.size || null };
        this.changed();
        console.log(`${id}@${entry.version}: download from ${item.source}${entry.revision ? ` at ${entry.revision}` : ''}` +
            `${entry.artifact.size ? ` (${entry.artifact.size} bytes)` : ''}`);
        const verifiedDir = path.join(this.conf.state_dir, 'verified');
        const verified = path.join(verifiedDir, entry.artifact.name);
        const trial = path.join(this.conf.tool_root, SELF, 'trial');
        const self = id === SELF;
        const toolDir = path.join(this.conf.tool_root, id);
        let before = null;
        return Promise.resolve()
            .then(() => {
                Object.keys(entry.requires).forEach((dep) => {
                    if (!this.requirementMet(dep, entry.requires[dep])) {
                        throw new Error(`needs ${dep} ${entry.requires[dep]} or newer${dep === SELF ? ': update the updater first' : ''}`);
                    }
                });
                // installed (since this was asked for): only the origin that updates it (resolved)
                const lead = this.installedOf(id) ? this.resolved().get(id) : null;
                if (lead && (lead.entry.unlisted || this.originOf(lead.source) !== this.originOf(item.source))) {
                    const holder = this.holder(id);
                    throw new Error(`${id} is already installed${holder ? ` from ${this.sourceLabel(holder)}` : ''}`);
                }
                return this.artifact(rt, entry, own);
            })
            .then((bytes) => {
                this.busy.phase = 'verify';
                this.changed();
                console.log(`${id}@${entry.version}: verify`);
                if ((entry.artifact.size && bytes.length !== entry.artifact.size) ||
                    (entry.artifact.sha256 && sha256(bytes) !== entry.artifact.sha256)) {
                    throw new Error('download does not match the catalog (size or sha256)');
                }
                // the checked bytes, root's alone, are what the deploy tool reads
                mkdirp(verifiedDir, 0o700);
                fs.writeFileSync(verified, bytes, { mode: 0o600 });
                if (!fs.existsSync(this.conf.deploy)) {
                    throw new Error(`deploy tool missing (${this.conf.deploy})`);
                }
                // a source package is built by the deploy tool, then installed
                this.busy.phase = entry.build === 'unit' && !entry.script ? 'build' : 'install';
                this.changed();
                console.log(`${id}@${entry.version}: install (sha256 ${sha256(bytes).slice(0, 12)})`);
                try {
                    before = fs.readlinkSync(path.join(toolDir, 'current'));
                } catch (e) { /* not installed yet */ }
                if (self) {
                    // the version to return to if the new one does not come up; one from
                    // a stick or a folder needs no internet to be kept (commitTrial)
                    const local = path.join(this.conf.tool_root, SELF, 'trial-local');
                    if (rt.reader.network) {
                        rmIfThere(local);
                    } else {
                        writeAtomic(local, '');
                    }
                    writeAtomic(trial, fs.readlinkSync(path.join(this.conf.tool_root, SELF, 'current')) + '\n');
                }
                // a new Store version: on trial from before the install, so a hello as soon as it runs counts
                if (id === this.conf.store_app && entry.kind === 'app' && catalogLib.compareVersions(entry.version, STORE_HELLO_SINCE) >= 0 &&
                    this.installedVersion(id, 'app') !== entry.version) {
                    this.startStoreTrial(entry.version);
                }
                return this.deploy(verified);
            })
            .then((code) => {
                if (code !== 0) {
                    const why = this.deployError;
                    throw new Error(code === 2 ? `${why || 'refused by the deploy tool'}; nothing changed` :
                        `install failed${why ? ': ' + why : ''}; the previous version was kept`);
                }
                console.log(`installed ${id}@${entry.version}`);
                // installed from a stick's copy of a source: that source is its origin
                this.origins[id] = { source: this.originOf(item.source), commit: entry.commit || null };
                this.saveOrigins();
                if (entry.listedId) {
                    this.aliases[`${this.originOf(item.source)}:${entry.listedId}`] = id;
                    this.saveAliases();
                }
                return this.bootstrapCheck(entry, toolDir, before, wasOnline);
            })
            .then(() => self)
            .catch((err) => {
                console.log(`${id}@${entry.version}: ${err.message}`);
                this.errors[key] = err.message;
                if (this.storeTrial && id === this.conf.store_app && this.storeTrial.version === entry.version) {
                    this.endStoreTrial();
                }
                if (self && fs.existsSync(trial)) {
                    fs.unlinkSync(trial);
                }
                return false;
            })
            .then((handover) => {
                if (fs.existsSync(verified)) {
                    fs.unlinkSync(verified);
                }
                return this.refresh().then(() => {
                    this.writeSecrets();
                    console.log(`${id}@${entry.version}: done`);
                    this.busy = null;
                    this.changed();
                    return handover;
                });
            });
    }

    /* Removes a component through the deploy tool's uninstall. */
    uninstall(item) {
        // the row's id; the id it is installed (or queued) under
        const key = item.id;
        const id = item.unit || item.id;
        this.busy = { id: key, op: 'uninstall', phase: 'uninstall' };
        this.changed();
        console.log(`${id}: uninstall`);
        return this.deployTool(['uninstall', id, '--yes'])
            .then((code) => {
                if (code !== 0) {
                    const why = this.deployError;
                    throw new Error(code === 2 ? `${why || 'refused by the deploy tool'}; nothing changed` :
                        `uninstall failed${why ? ': ' + why : ''}`);
                }
                console.log(`uninstalled ${id}`);
                delete this.origins[id];
                this.saveOrigins();
                // the id it was installed under is given again only while it is free
                Object.keys(this.aliases).filter((k) => this.aliases[k] === id).forEach((k) => delete this.aliases[k]);
                this.saveAliases();
            })
            .catch((err) => {
                console.log(`${id}: ${err.message}`);
                this.errors[key] = err.message;
            })
            .then(() => this.refresh())
            .then(() => {
                this.busy = null;
                this.changed();
                return false;
            });
    }

    /* The tools the updater itself runs on: the deploy tool (every install
     * goes through it) and the uplink (every download goes through it). A
     * new version of either must work before the updater relies on it: the
     * deploy tool must answer status, the uplink must give internet again
     * (when there was internet before it).
     * Otherwise the version installed before is put back. The updater
     * itself is checked by commitTrial and its supervisor (bin/mgu-updater). */
    bootstrapCheck(entry, toolDir, before, wasOnline) {
        const kept = before && path.basename(before) !== entry.version ? path.basename(before) : null;
        const failed = (what) => new Error(`${entry.version} ${what}` +
            (kept ? `; ${kept} kept` : '; no earlier version to return to'));
        if (entry.id === this.conf.deploy_tool) {
            this.busy.phase = 'check';
            this.changed();
            return deployStatus(this.conf).then((ok) => {
                if (ok) {
                    return;
                }
                if (kept) {
                    switchCurrent(toolDir, before);
                    // so no later rollback can pick the version that does not run
                    cp.execFileSync('rm', ['-rf', path.join(toolDir, 'versions', entry.version)]);
                }
                throw failed('does not run');
            });
        }
        if (entry.id === this.conf.uplink_tool && wasOnline) {
            return pendingReboot(this.conf).then((pending) => {
                if (pending.indexOf(entry.id) >= 0) {
                    return undefined; // not restarted: the running version is untouched
                }
                this.busy.phase = 'check';
                this.changed();
                return this.online(Number(this.conf.bootstrap_check_s) * 1000).then((ok) => {
                    if (ok) {
                        return undefined;
                    }
                    if (!kept) {
                        throw failed('gives no internet');
                    }
                    return this.deployTool(['rollback', entry.id, '--yes']).then((code) => {
                        if (code !== 0) {
                            throw new Error(`${entry.version} gives no internet; going back to ${kept} failed (exit ${code})`);
                        }
                        return this.online(Number(this.conf.bootstrap_check_s) * 1000).then((back) => {
                            throw new Error(`${entry.version} gives no internet; ${kept} kept` +
                                (back ? '' : ', and gives none either'));
                        });
                    });
                });
            });
        }
        return Promise.resolve();
    }

    /* A network source answers within ms (or there is none): the internet works. */
    online(ms) {
        const deadline = Date.now() + ms;
        const net = this.stored.map((d) => this.src.get(d.id)).filter((rt) => rt.reader.network);
        const attempt = () => Promise.resolve()
            .then(() => {
                if (!readLease(this.conf).online) {
                    throw new Error('no lease');
                }
                if (!net.length) {
                    return undefined;
                }
                return net[0].reader.catalog().catch((err) => {
                    if (err.status === undefined && !err.auth) {
                        throw err;
                    }
                });
            })
            .then(() => true, () => {
                if (Date.now() >= deadline) {
                    return false;
                }
                return new Promise((r) => setTimeout(r, 3000)).then(attempt);
            });
        return attempt();
    }

    /* What only the unit's tools can tell: pending reboots, the head unit,
     * the installed providers, the privacy patch. */
    refresh() {
        return Promise.all([deployStatus(this.conf), privacyState(this.conf)]).then(([st, privacy]) => {
            this.pending = pendingOf(st);
            this.nextStart = nextStartOf(st);
            if (st) {
                this.lastApply = lastApplyOf(st);
                this.previous = previousOf(st);
                this.lastVerify = lastVerifyOf(st);
                this.unit = unitOf(st);
                this.providers = providersOf(st);
                this.appmanager = st.appmanager && typeof st.appmanager === 'object' ? st.appmanager : null;
                this.idrive7 = st.idrive7 && Array.isArray(st.idrive7.apps) ? st.idrive7.apps : [];
                this.own = ownInstalled(this.conf, st);
            }
            this.privacy = privacy;
            this.takeOver();
        });
    }

    /* IterioDev's App Manager on the unit: the deploy tool adopts it once
     * (its daemon stopped, its renderer our tool, its tether retired);
     * then each app it installed gets as origin the source of the
     * repository it came from (a public index, added as a source when
     * none reads it), else imported. Nothing is reinstalled. */
    takeOver() {
        this.takeOverIdrive7();
        const am = this.appmanager;
        if (am && am.present && (!am.record || am.record.removed) && !this.adoptTried) {
            this.adoptTried = true;
            this.queue.unshift({ op: 'adopt', id: APP_MANAGER });
            if (!this.busy) {
                this.next();
            }
            return;
        }
        const rec = am && am.record;
        if (!rec || rec.at === this.adopted.at || this.sourcesError) {
            return;
        }
        const repos = Array.isArray(rec.repos) ? rec.repos : [];
        const imported = [];
        (Array.isArray(rec.apps) ? rec.apps : []).forEach((app) => {
            if (!app || !ID.test(app.id || '') || this.origins[app.id]) {
                return;
            }
            // as the App Manager had it: an app it recorded no repository for updates from its default one
            const url = app.from || (repos.find((r) => r.isDefault && r.enabled && (r.lists || []).indexOf(app.id) >= 0) || {}).url;
            const repo = repos.find((r) => r.url === url);
            const source = repo && !repo.private ? this.indexSource(repo) : null;
            if (source) {
                this.origins[app.id] = { source, commit: null };
            } else {
                imported.push(app.id);
            }
            console.log(`appmanager: ${app.id}${app.version ? `@${app.version}` : ''} adopted, origin ${source || IMPORTED}`);
        });
        this.saveOrigins();
        this.adopted = { at: rec.at, imported: this.adopted.imported.filter((id) => imported.indexOf(id) < 0).concat(imported) };
        mkdirp(this.conf.state_dir, 0o755);
        writeAtomic(path.join(this.conf.state_dir, 'appmanager.json'), JSON.stringify(this.adopted, null, 1));
        this.changed();
    }

    /* The apps idrive7-apps' own installer put on the unit (the deploy
     * tool's status idrive7): each gets as origin the source that reads
     * that repository (a default source, default_sources) once it has read
     * it and lists the app, else imported; with no such source (the owner
     * removed it) each is imported. Nothing is reinstalled. */
    takeOverIdrive7() {
        const apps = (this.idrive7 || []).filter((a) => a && ID.test(a.id || '') && !this.origins[a.id] &&
            this.adopted.imported.indexOf(a.id) < 0);
        if (!apps.length || this.sourcesError) {
            return;
        }
        const def = this.stored.find((d) => d.type === 'github' && d.repo.toLowerCase() === IDRIVE7_REPO);
        const rt = def ? this.src.get(def.id) : null;
        // its listing decides: not read yet, or not readable, a later check does
        if (rt && (!rt.checkedAt || rt.status !== 'ok')) {
            return;
        }
        const imported = [];
        apps.forEach((app) => {
            const listed = rt && rt.components.some((c) => c.kind === 'app' && c.id === app.id);
            if (listed) {
                this.origins[app.id] = { source: def.id, commit: null };
            } else if (rt && rt.error) {
                // a listing that left something out may have left this app out
                return;
            } else {
                imported.push(app.id);
            }
            console.log(`idrive7-apps: ${app.id}${app.version ? `@${app.version}` : ''} adopted, origin ${listed ? def.id : IMPORTED}`);
        });
        this.saveOrigins();
        this.adopted = Object.assign({}, this.adopted, { imported: this.adopted.imported.concat(imported) });
        mkdirp(this.conf.state_dir, 0o755);
        writeAtomic(path.join(this.conf.state_dir, 'appmanager.json'), JSON.stringify(this.adopted, null, 1));
        this.changed();
    }

    /* The source that reads an App Manager repository's index: the stored
     * https source of that URL, else one added for it; null when it is not
     * an https URL. */
    indexSource(repo) {
        const have = this.stored.find((d) => d.type === 'https' && d.url === repo.index);
        if (have) {
            return have.id;
        }
        const want = String(repo.url).split('/').filter(Boolean).pop() || '';
        const err = this.sourceAdd({ type: 'https', url: repo.index }, want.toLowerCase());
        const added = this.stored.find((d) => d.type === 'https' && d.url === repo.index);
        if (err || !added) {
            console.log(`appmanager: ${repo.url} not added as a source${err ? `: ${err}` : ''}`);
            return null;
        }
        return added.id;
    }

    adopt() {
        this.busy = { id: APP_MANAGER, op: 'adopt', phase: 'check' };
        this.changed();
        console.log("appmanager: adopting IterioDev's App Manager");
        return this.deployTool(['appmanager', 'adopt', '--yes'])
            .then((code) => {
                if (code !== 0) {
                    this.errors[APP_MANAGER] = `taking over the App Manager failed${this.deployError ? `: ${this.deployError}` : ''}`;
                    console.log(`appmanager: ${this.errors[APP_MANAGER]}`);
                }
                return this.refresh();
            })
            .then(() => {
                this.busy = null;
                this.changed();
                return false;
            });
    }

    deploy(file) {
        return this.deployTool(['install', '--artifact', file, '--yes']).then((code) => this.checkUids().then(() => code));
    }

    /* Picks a uid again that something else holds now (an install, an
     * account), and moves what used the one before: what it left in its
     * download and build folders is removed as it, new downloads wait for
     * the uplink to read the new fetch uid, the phone page restarts as the
     * new web uid. Not while a download or a build runs as the old one:
     * then it is done once they are over (pending). Resolves when done. */
    checkUids() {
        if (this.fetcher.active || this.building) {
            this.uidsPending = true;
            return Promise.resolve();
        }
        this.uidsPending = false;
        let changed;
        try {
            changed = this.uids.ensure();
        } catch (e) {
            console.log(`uids: ${e.message}`);
            return Promise.resolve();
        }
        const roles = changed.map((c) => c.role);
        if (roles.indexOf('fetch') >= 0) {
            this.fetcher.notBefore = Date.now() + UPLINK_RESCAN_MS;
        }
        if (roles.indexOf('web') >= 0) {
            this.writeSecrets();
            if (web && this.webEnabled) {
                this.applyWeb();
            }
        }
        return this.retireUids();
    }

    /* Removes what earlier build and fetch uids left (retireOld). */
    retireUids() {
        const free = (uid) => this.uids.free(uid);
        return retireOld(this.conf, 'fetch', free).then(() => retireOld(this.conf, 'build', free))
            .catch((e) => console.log(`uids: ${e.message}`));
    }

    /* Runs the deploy tool; resolves with its exit status. deployError keeps
     * the reason it gave for its last failure ("mgu-deploy: <reason>"). It
     * runs in a process group of its own: one still running after
     * deploy_timeout_s is stopped with everything it started (SIGTERM, then
     * SIGKILL 10 s later) and counts as failed. */
    deployTool(args) {
        this.deployError = null;
        const limitS = Number(this.conf.deploy_timeout_s) || 5400;
        const limit = limitS >= 120 ? `${Math.round(limitS / 60)} min` : `${limitS} s`;
        return new Promise((resolve) => {
            const child = cp.spawn(this.conf.deploy, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
            let timedOut = false;
            let kill = null;
            const group = (sig) => {
                try {
                    process.kill(-child.pid, sig);
                } catch (e) { /* gone */ }
            };
            const timer = setTimeout(() => {
                timedOut = true;
                console.log(`deploy: still running after ${limit}; stopping it`);
                group('SIGTERM');
                kill = setTimeout(() => group('SIGKILL'), 10000);
            }, limitS * 1000);
            const log = (d) => d.toString().split('\n').filter(Boolean).forEach((l) => {
                console.log(`deploy: ${l}`);
                const m = /^mgu-deploy: (.+)/.exec(l);
                if (m) {
                    this.deployError = m[1];
                }
            });
            const done = (code) => {
                clearTimeout(timer);
                if (kill) {
                    clearTimeout(kill);
                    group('SIGKILL');
                }
                if (timedOut) {
                    this.deployError = `the deploy tool did not finish within ${limit} and was stopped`;
                    resolve(1);
                    return;
                }
                resolve(code);
            };
            child.stdout.on('data', log);
            child.stderr.on('data', log);
            child.on('error', () => done(1));
            child.on('close', (code) => done(code));
        });
    }

    /* ---- privileged requests ---- */

    /* The per-start secret, for the Store (in its own data folder, its uid's,
     * 0400) and the phone page (web_secret, web_uid's, 0400). Only they can
     * make the privileged requests. */
    writeSecrets() {
        const conf = this.conf;
        if (conf.web_secret) {
            try {
                const dir = path.dirname(conf.web_secret);
                mkdirp(dir, 0o755);
                const st = fs.lstatSync(dir);
                if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o022)) {
                    throw new Error(`${dir} is not root's own folder`);
                }
                const tmp = `${conf.web_secret}.tmp`;
                rmIfThere(tmp);
                const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o400);
                fs.writeSync(fd, this.secret);
                if (process.getuid() === 0) {
                    fs.fchownSync(fd, Number(conf.web_uid), Number(conf.web_gid));
                }
                fs.fchmodSync(fd, 0o400);
                fs.closeSync(fd);
                fs.renameSync(tmp, conf.web_secret);
            } catch (e) {
                console.log(`web secret: ${e.message}`);
            }
        }
        const store = this.storeData();
        if (!store) {
            this.storeSecretUid = null;
            return Promise.resolve();
        }
        this.storeSecretUid = store.uid;
        return writeAs(path.join(store.data, 'updater-secret'), this.secret, store.uid, store.gid, store.groups)
            .catch((e) => {
                this.storeSecretUid = null;
                console.log(`store secret: ${e.message}`);
            })
            .then(() => this.syncWebUrl(true));
    }

    /* The Store has a data folder without the secret in it. */
    storeSecretGone() {
        const store = this.storeData();
        if (!store) {
            return false;
        }
        try {
            fs.lstatSync(path.join(store.data, 'updater-secret'));
            return false;
        } catch (e) {
            return e.code === 'ENOENT';
        }
    }

    /* The Store's uid and data folder, or null while it has none. groups:
     * the folder's group, and the groups of oap_root and the folder above
     * it, through which every app reaches its home (mgu_persist, 0710 and
     * 0770 on the unit); root's group never. */
    storeData() {
        const uid = storeUid(this.conf);
        if (!uid) {
            return null;
        }
        const data = path.join(this.conf.oap_root, `oap_${uid}`, 'data');
        try {
            const gid = fs.statSync(data).gid;
            const groups = [path.dirname(this.conf.oap_root), this.conf.oap_root].map((d) => fs.statSync(d).gid).concat(gid)
                .filter((g, i, all) => g !== 0 && all.indexOf(g) === i);
            return { uid, gid, groups, data };
        } catch (e) {
            return null; // the Store has no data folder yet
        }
    }

    /* While the phone page is on, the Store's data folder holds its address
     * on the hotspot with the access token (web-url, the Store's own 0400
     * file), for the QR code; otherwise there is none. force: write it
     * again even when the address is the same (the Store's uid changed). */
    syncWebUrl(force) {
        // one write at a time, each with the address as it is when it runs
        this.webUrlQueue = (this.webUrlQueue || Promise.resolve()).then(() => {
            const url = web && this.webEnabled ? web.accessUrls().find((u) => !/^https?:\/\/(127\.|localhost)/.test(u)) || null : null;
            if (url === this.webUrl && !force) {
                return undefined;
            }
            this.webUrl = url;
            const store = this.storeData();
            if (!store) {
                return undefined;
            }
            // the Store reads the file when a state arrives: one goes out once it is written
            return writeAs(path.join(store.data, 'web-url'), url ? `${url}\n` : '', store.uid, store.gid, store.groups)
                .then(() => this.changed());
        }).catch((e) => console.log(`web-url: ${e.message}`));
        return this.webUrlQueue;
    }

    /* The phone page on or off (web.js); its changes re-send the state. */
    applyWeb() {
        return web.setEnabled(this.conf, this.webEnabled, (l) => console.log(l), () => {
            this.changed();
            this.syncWebUrl();
        });
    }

    authorized(secret) {
        const a = Buffer.from(String(secret || ''));
        const b = Buffer.from(this.secret);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    /* Writes the stored sources; refused while sources.json could not be
     * read, so the sources in it are not lost (a newer version's file). */
    saveSources(list) {
        if (this.sourcesError) {
            throw new Error(`sources.json cannot be read (${this.sourcesError}); it is left as it is`);
        }
        sourcesLib.save(this.conf.sources, list);
        this.stored = list;
    }

    /* want: the id to give it when that is free (else a random one). */
    sourceAdd(req, want) {
        let def;
        if (req.type === 'github') {
            if (!sourcesLib.REPO.test(req.repo || '')) {
                return 'repo must be <owner>/<repo>';
            }
            if (req.channel !== undefined && req.channel !== null && !sourcesLib.CHANNEL.test(req.channel)) {
                return 'channel must be releases, tags, branch or branch:<name>';
            }
            if (this.stored.some((s) => s.type === 'github' && s.repo.toLowerCase() === req.repo.toLowerCase())) {
                return `${req.repo} is already a source`;
            }
            def = { id: this.freeSourceId(req.repo.split('/')[1].toLowerCase()), type: 'github', repo: req.repo };
            if (req.channel) {
                def.channel = req.channel;
            }
        } else if (req.type === 'https') {
            try {
                def = sourcesLib.checkStored({ id: this.freeSourceId(want || null), type: 'https', url: req.url });
            } catch (e) {
                return 'url must be https://';
            }
            if (this.stored.some((s) => s.url === req.url)) {
                return `${req.url} is already a source`;
            }
        } else {
            return 'type must be github or https';
        }
        this.saveSources(this.stored.concat([def]));
        this.addRuntime(def);
        console.log(`source ${def.id}: added (${sourcesLib.label(def)}${def.channel ? `, ${def.channel}` : ''})`);
        this.checkSource(def.id);
        return null;
    }

    /* What a GitHub repo offers to be added on, read with each token in
     * turn (as a source is, readSource), then without one:
     * {type:"probe", repo, status} with status ok (and name, releases, tags,
     * defaultBranch, branches, more), auth-needed (no token reaches it, or it
     * is not there), offline, rate-limited or error (and error). */
    sourceProbe(req, reply) {
        if (!sourcesLib.REPO.test(req.repo || '')) {
            return 'repo must be <owner>/<repo>';
        }
        if (this.stored.some((s) => s.type === 'github' && s.repo.toLowerCase() === req.repo.toLowerCase())) {
            return `${req.repo} is already a source`;
        }
        const answer = (fields) => reply(Object.assign({ type: 'probe', repo: req.repo }, fields));
        if (!readLease(this.conf).online) {
            answer({ status: 'offline' });
            return undefined;
        }
        const def = { id: null, type: 'github', repo: req.repo };
        const attempt = (cands, i) => {
            const text = cands[i] ? this.tokens.text(cands[i]) : '';
            return sourcesLib.reader(def, Object.assign({}, this.ctx, { tokenFor: () => text })).probe()
                .catch((err) => (err.auth && i + 1 < cands.length ? attempt(cands, i + 1) : Promise.reject(err)));
        };
        this.freshTokens()
            .then(() => attempt(this.candidates({ tokenId: null, public: false }), 0))
            .then((p) => answer(Object.assign({ status: 'ok' }, p)), (err) => {
                console.log(`probe ${req.repo}: ${err.message}`);
                answer(err.auth ? { status: 'auth-needed' } : err.rateLimited ? { status: 'rate-limited' }
                    : { status: 'error', error: err.message });
            });
        return undefined;
    }

    sourceRemove(id) {
        const def = this.stored.find((s) => s.id === id);
        if (!def) {
            return `no source ${id}`;
        }
        if (def.builtin) {
            return 'the Store\'s own source cannot be removed';
        }
        this.saveSources(this.stored.filter((s) => s.id !== id));
        this.src.delete(id);
        rmIfThere(this.cacheFile(id));
        cp.execFileSync('rm', ['-rf', path.join(this.ctx.cacheDir, id)]);
        // what it installed keeps it as its origin: no other source updates that
        Object.keys(this.origins).forEach((c) => {
            if (this.origins[c].source === id && !this.installedOf(c)) {
                delete this.origins[c];
            }
        });
        this.saveOrigins();
        console.log(`source ${id}: removed`);
        this.changed();
        return null;
    }

    /* What GitHub says of each token (login, scopes, rejected), once the
     * expired ones are renewed; quietly nothing without an answer. only:
     * those ids alone. */
    validateTokens(only) {
        if (!readLease(this.conf).online) {
            return Promise.resolve();
        }
        return this.freshTokens().then(() => Promise.all(this.tokens.all().filter((t) => !only || only.indexOf(t.id) >= 0).map((t) => this.login.account(this.tokens.text(t.id)).then((a) => {
            if (a.status === 'unknown' || !this.tokens.get(t.id)) {
                return;
            }
            const fields = a.status === 'ok' ? { login: a.login, scopes: a.scopes, rejected: false } : { rejected: true };
            if (t.checkedAt && Object.keys(fields).every((k) => t[k] === fields[k])) {
                return;
            }
            this.tokens.update(t.id, Object.assign(fields, { checkedAt: Date.now() }));
            console.log(`token ${t.id}: ${fields.rejected ? 'GitHub does not accept it' : `${a.login}${a.scopes ? ` (${a.scopes})` : ''}`}`);
            this.changed();
        })))).catch((e) => console.log(`tokens: ${e.message}`));
    }

    /* Reads the token files again (the deploy tool adds and removes tokens
     * too); on a change, checks what is new and reads the GitHub sources
     * that need a token or lost theirs. */
    scanTokens() {
        if (!this.tokens.scan()) {
            return false;
        }
        this.tokensChanged();
        this.validateTokens(this.tokens.all().filter((t) => !t.checkedAt).map((t) => t.id));
        return true;
    }

    /* A source being read meanwhile tried the tokens as they were: it is
     * read again once done, if it then needs one or lost its own. */
    tokensChanged() {
        this.stored.filter((d) => d.type === 'github').forEach((d) => {
            const rt = this.src.get(d.id);
            if (rt.checking) {
                rt.tokensChanged = true;
                return;
            }
            const gone = rt.tokenId && !this.tokens.get(rt.tokenId);
            if (gone) {
                rt.tokenId = null;
            }
            if (gone || rt.status === 'auth-needed') {
                this.checkSource(d.id);
            }
        });
        this.changed();
    }

    /* Stores a pasted token once GitHub has said whose it is (one GitHub
     * rejects is refused; without an answer it is stored and checked on the
     * next check), then reads the sources that need a token. */
    tokenAdd(req, reply) {
        const text = typeof req.token === 'string' ? req.token.trim() : '';
        if (!TOKEN.test(text)) {
            return 'a token is 1 to 1024 printable characters without spaces';
        }
        if (req.label !== undefined && req.label !== null && !(typeof req.label === 'string' && /^[^\x00-\x1f\x7f]{0,64}$/.test(req.label))) {
            return 'a label is at most 64 characters';
        }
        const label = req.label ? req.label.trim() : '';
        this.login.account(text).then((a) => {
            if (a.status === 'rejected') {
                reply({ type: 'error', op: 'token-add', error: 'GitHub does not accept this token' });
                return;
            }
            let r;
            try {
                const fields = a.status === 'ok' ? { login: a.login, scopes: a.scopes, rejected: false, checkedAt: Date.now() } : {};
                if (label || a.login) {
                    fields.label = label || a.login;
                }
                r = this.tokens.add(text, fields);
            } catch (e) {
                reply({ type: 'error', op: 'token-add', error: e.message });
                return;
            }
            console.log(`token ${r.id}: ${r.added ? 'added' : 'already stored'}${a.login ? ` (${a.login})` : ''}`);
            this.tokensChanged();
            reply(this.state());
        });
        return undefined;
    }

    tokenRemove(id) {
        this.scanTokens();
        if (typeof id !== 'string' || !this.tokens.get(id)) {
            return `no token ${id}`;
        }
        this.tokens.remove(id);
        console.log(`token ${id}: removed`);
        this.tokensChanged();
        return null;
    }

    /* A device sign-in's token: it replaces the earlier sign-in's token of
     * the same account, else it is a new one. */
    signedIn(token, meta) {
        const fields = Object.assign({}, meta, { label: meta.login, device: true, rejected: false, checkedAt: Date.now() });
        const earlier = meta.login && this.tokens.all().find((t) => t.device && t.login === meta.login);
        if (earlier && this.tokens.text(earlier.id) !== token) {
            this.tokens.setText(earlier.id, token, fields);
            console.log(`token ${earlier.id}: renewed by sign-in`);
        } else {
            const r = this.tokens.add(token, fields);
            console.log(`token ${r.id}: added by sign-in`);
        }
        this.tokensChanged();
    }

    setWeb(enabled) {
        if (!web) {
            return 'this updater has no phone page';
        }
        this.webEnabled = enabled;
        mkdirp(this.conf.state_dir, 0o755);
        writeAtomic(path.join(this.conf.state_dir, 'web.json'), JSON.stringify({ enabled }));
        Promise.resolve(this.applyWeb()).then(() => this.syncWebUrl());
        this.syncWebUrl();
        this.changed();
        return null;
    }

    /* A unit's journal for the phone page: {type:"logs", unit, text}. */
    logs(req, reply) {
        if (!web) {
            return 'this updater has no phone page';
        }
        if (web.UNITS.indexOf(req.unit) < 0) {
            return `no journal for ${req.unit}`;
        }
        web.journal(req.unit, req.lines, (err, text) => reply(err ? { type: 'error', op: 'logs', error: err.message } :
            { type: 'logs', unit: req.unit, text }));
        return undefined;
    }

    /* Reads the uplink's status.json (uplink_status): { device, state, error,
     * preferred, wifi }, null without one. True when it changed. One that
     * does not parse is read again next time. */
    readUplink() {
        let text = '';
        try {
            text = this.conf.uplink_status ? fs.readFileSync(this.conf.uplink_status, 'utf8') : '';
        } catch (e) { /* the uplink does not run */ }
        if (text === this.uplinkText) {
            return false;
        }
        let st = null;
        try {
            st = text ? JSON.parse(text) : null;
        } catch (e) {
            return false;
        }
        this.uplinkText = text;
        this.uplink = st && typeof st === 'object' ? { device: st.device || null, state: st.state || null, error: st.error || null,
            preferred: st.preferred || '', wifi: st.wifi && typeof st.wifi === 'object' ? st.wifi : null } : null;
        return true;
    }

    /* A request for the uplink, relayed to its ctl.sock (uplink_ctl, root
     * only): the state once the uplink took it, else its refusal. A Wi-Fi
     * password goes on to the uplink only: never into a log line or a reply. */
    uplinkRequest(req, reply) {
        const msg = UPLINK_OPS[req.op](req);
        if (typeof msg === 'string') {
            return msg;
        }
        console.log(`uplink: ${req.op}${msg.ssid ? ` ${JSON.stringify(msg.ssid)}` : ''}${msg.kind !== undefined ? ` ${JSON.stringify(msg.kind)}` : ''}`);
        let finished = false;
        let buf = '';
        const sock = net.connect(this.conf.uplink_ctl || '/run/mgu-uplink/ctl.sock');
        const done = (error) => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            sock.destroy();
            if (error) {
                console.log(`uplink: ${req.op} refused: ${error}`);
                reply({ type: 'error', op: req.op, error });
                return;
            }
            if (this.readUplink()) {
                this.changed();
            }
            reply(this.state());
        };
        const timer = setTimeout(() => done('the uplink gave no answer'), UPLINK_WAIT_MS);
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
        sock.on('data', (d) => {
            buf += d;
            const nl = buf.indexOf('\n');
            if (nl < 0) {
                if (buf.length > 4096) {
                    done('the uplink gave no answer');
                }
                return;
            }
            let a = null;
            try {
                a = JSON.parse(buf.slice(0, nl));
            } catch (e) { /* not an answer */ }
            done(a && a.ok === true ? null : String((a && a.error) || 'the uplink gave no answer'));
        });
        sock.on('error', (e) => done(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'needs mgu-uplink 0.7.0 or newer, running' : e.message));
        sock.on('close', () => done('the uplink gave no answer'));
        return undefined;
    }

    /* One request; returns the reason it is refused, null when the state
     * answers it, or undefined when it answers later through reply(msg). */
    handle(req, reply) {
        if (PRIVILEGED.indexOf(req.op) >= 0 && !this.authorized(req.secret)) {
            return 'forbidden';
        }
        switch (req.op) {
        case 'status': return null;
        case 'check': this.check(); return null;
        case 'install': return typeof req.id === 'string' ? this.request(req.id) : 'install needs an id';
        case 'reboot': return this.reboot();
        case 'uninstall': return typeof req.id === 'string' ? this.requestUninstall(req.id) : 'uninstall needs an id';
        case 'rollback': return typeof req.id === 'string' ? this.requestRollback(req.id) : 'rollback needs an id';
        case 'hello': this.storeHello(req); return undefined;
        case 'source-add': return this.sourceAdd(req);
        case 'source-probe': return this.sourceProbe(req, reply);
        case 'source-remove': return this.sourceRemove(req.id);
        case 'login-start': return this.login.start();
        case 'login-cancel': this.login.cancel(); return null;
        case 'token-add': return this.tokenAdd(req, reply);
        case 'token-remove': return this.tokenRemove(req.id);
        case 'web': return this.setWeb(req.enable === true);
        case 'logs': return this.logs(req, reply);
        case 'uplink-prefer':
        case 'wifi-enable':
        case 'wifi-scan':
        case 'wifi-connect':
        case 'wifi-forget': return this.uplinkRequest(req, reply);
        default: return `unknown op ${req.op}`;
        }
    }

    /* Queues what the version before left queued (handover). */
    takeQueue() {
        const file = path.join(this.conf.state_dir, 'queue.json');
        let items = [];
        try {
            items = readJson(file);
        } catch (e) { /* none */ }
        rmIfThere(file);
        (Array.isArray(items) ? items : []).filter((q) => q && ID.test(String(q.id)) && ['install', 'uninstall', 'rollback', 'adopt'].indexOf(q.op) >= 0)
            .forEach((q) => this.enqueue(q));
    }

    /* The new version is in place: the supervisor starts it once we exit. */
    handover() {
        console.log('handing over to the new version');
        // the new version takes up what is still queued once it is kept
        if (this.queue.length) {
            mkdirp(this.conf.state_dir, 0o755);
            writeAtomic(path.join(this.conf.state_dir, 'queue.json'), JSON.stringify(this.queue));
        }
        this.clients.forEach((s) => s.end());
        this.server.close();
        try {
            fs.unlinkSync(this.conf.socket);
        } catch (e) { /* already gone */ }
        process.exit(HANDOVER_EXIT);
    }

    serve() {
        const sock = this.conf.socket;
        // The socket's folder may sit in world-writable, sticky /dev/shm. One
        // someone else made or can write to could swap the socket for a link
        // that the chown/chmod below would follow: it is renamed aside and the
        // folder made afresh, and used only once it is root's alone.
        const dir = path.dirname(sock);
        const safe = () => {
            const st = fs.lstatSync(dir);
            return st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o022);
        };
        if (fs.existsSync(dir) || isLink(dir)) {
            if (!safe()) {
                fs.renameSync(dir, `${dir}.untrusted-${Date.now()}`);
            }
        }
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, 0o755);
            fs.chmodSync(dir, 0o755);
        }
        if (!safe()) {
            throw new Error(`${dir} is not a folder only root can write to`);
        }
        try {
            fs.unlinkSync(sock);
        } catch (e) { /* none left */ }
        this.server = net.createServer((s) => this.accept(s));
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(sock, () => {
                if (process.getuid() === 0 && this.conf.socket_group) {
                    fs.chownSync(sock, 0, groupId(this.conf.socket_group));
                }
                fs.chmodSync(sock, 0o660);
                resolve();
            });
        });
    }

    /* One JSON request per line (README.md, "The socket"). Every client gets
     * the full state on connect and whenever it changes; a refused request
     * gets {type:"error", op, error}. The direct answer to a request carries
     * its "rid". */
    accept(s) {
        this.clients.add(s);
        s.on('close', () => this.clients.delete(s));
        s.on('error', () => this.clients.delete(s));
        s.write(JSON.stringify(this.state()) + '\n');
        let buf = '';
        s.setEncoding('utf8');
        s.on('data', (d) => {
            buf += d;
            if (buf.length > 65536) {
                s.destroy();
                return;
            }
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                let req;
                try {
                    req = JSON.parse(line);
                } catch (e) {
                    continue;
                }
                if (!req || typeof req !== 'object') {
                    continue;
                }
                const rid = (typeof req.rid === 'string' && req.rid.length <= 64) || Number.isInteger(req.rid) ? { rid: req.rid } : {};
                const reply = (msg) => {
                    if (!s.destroyed) {
                        s.write(JSON.stringify(Object.assign(msg, rid)) + '\n');
                    }
                };
                let error;
                try {
                    error = this.handle(req, reply);
                } catch (e) {
                    error = e.message;
                }
                if (error !== undefined) {
                    reply(error ? { type: 'error', op: req.op, error } : this.state());
                }
            }
        });
    }

    /* Some network source was reached on the last check (a listing, or an
     * HTTP answer from its server), or there is none. */
    reached() {
        const net = this.stored.map((d) => this.src.get(d.id)).filter((rt) => rt.reader.network);
        return !net.length || net.some((rt) => rt.answered);
    }

    /* A version on trial is kept once it has done its job end to end: a
     * source read through the uplink (a listing, or an HTTP answer from its
     * server: its network path works), and a deploy tool that answers.
     * It keeps trying until TRIAL_WAIT_MS, so a start before the uplink is
     * up (a boot) or a passing network error is not taken for a broken
     * version. Otherwise it exits and the supervisor goes back to the version
     * on record in trial; the reason is left for the version that runs next.
     * A version the local installer put there (trial-local) needs only the
     * deploy tool: the car may have no internet while it is set up.
     * Installs queue meanwhile. */
    commitTrial(trial) {
        const local = path.join(this.conf.tool_root, SELF, 'trial-local');
        const needsCatalog = !fs.existsSync(local);
        const deadline = Date.now() + TRIAL_WAIT_MS;
        const fetched = () => !needsCatalog || (readLease(this.conf).online && this.reached());
        // a local one: the sticks are read before the queue it takes up, which may install from them
        const sticks = () => {
            this.scanUsb();
            return Promise.all(this.usb.map((u) => this.checkSource(u.id)));
        };
        const attempt = () => (!needsCatalog ? sticks() : (readLease(this.conf).online ? this.check() : Promise.resolve())
            .then(() => fetched() || Date.now() >= deadline ? undefined
                : new Promise((r) => setTimeout(r, 3000)).then(attempt)));
        this.busy = { id: SELF, phase: 'check' };
        this.changed();
        return attempt()
            .then(() => deployStatus(this.conf))
            .then((deploy) => {
                if (fetched() && deploy) {
                    fs.unlinkSync(trial);
                    rmIfThere(local);
                    console.log(`running ${this.version}: update committed`);
                    this.tokens.removeLegacy((l) => console.log(l));
                    this.busy = null;
                    this.takeQueue();
                    this.next();
                    return;
                }
                const reason = fetched() ? 'the deploy tool does not answer it' :
                    !readLease(this.conf).online ? 'there was no internet to check it with' :
                        `it cannot fetch the catalog (${this.catalogError()})`;
                console.log(`${this.version} not kept: ${reason}`);
                rmIfThere(path.join(this.conf.state_dir, 'queue.json'));
                writeAtomic(path.join(this.conf.tool_root, SELF, 'trial-reason'), `${reason}\n`);
                process.exit(1);
            });
    }

    run() {
        return this.serve().then(() => {
            // folders earlier uids of theirs left, then their own
            this.retireUids().then(() => {
                this.fetcher.clean();
                cleanBuilds(this.conf);
            });
            // what an install cut short handed the deploy tool: no install resumes from it
            cp.execFileSync('rm', ['-rf', path.join(this.conf.state_dir, 'verified')]);
            this.writeSecrets();
            if (web) {
                // also with false: it removes a firewall rule an earlier run left
                Promise.resolve(this.applyWeb()).then(() => this.syncWebUrl(true));
            }
            const trial = path.join(this.conf.tool_root, SELF, 'trial');
            if (fs.existsSync(trial)) {
                this.commitTrial(trial);
            } else {
                rmIfThere(path.join(this.conf.tool_root, SELF, 'trial-local'));
                // a queue a version that was not kept left
                rmIfThere(path.join(this.conf.state_dir, 'queue.json'));
                console.log(`running ${this.version}`);
                // a version on trial keeps them for the one it may go back to
                this.tokens.removeLegacy((l) => console.log(l));
            }
            // written by the supervisor when a new version did not come up
            const rolledBack = path.join(this.conf.tool_root, SELF, 'rolled-back');
            const why = path.join(this.conf.tool_root, SELF, 'trial-reason');
            if (fs.existsSync(rolledBack)) {
                const failed = fs.readFileSync(rolledBack, 'utf8').trim();
                this.errors[SELF] = fs.existsSync(why) ?
                    `${failed} not kept: ${fs.readFileSync(why, 'utf8').trim()}; ${this.version} kept` :
                    `${failed} did not start; ${this.version} kept`;
                fs.unlinkSync(rolledBack);
            }
            if (fs.existsSync(why)) {
                fs.unlinkSync(why);
            }
            this.refresh().then(() => this.changed());
            let wasOnline = readLease(this.conf).online;
            setTimeout(() => this.check(), Number(this.conf.first_check_s) * 1000);
            setInterval(() => this.check(), Number(this.conf.check_interval_s) * 1000);
            // a Store update on trial: its process looked for each second
            setInterval(() => this.watchStoreTrial(), 1000);
            // USB media: nothing announces a stick, so the mounts are looked
            // at; the token files too (the deploy tool changes them)
            setInterval(() => {
                this.scanUsb();
                this.scanTokens();
                this.watchPlaced();
                if (this.uidsPending) {
                    this.checkUids();
                }
            }, (Number(this.conf.usb_poll_s) || 5) * 1000);
            // A version installed from outside (the deploy tool run from the
            // Mac) is taken up on trial too, with this one to return to; it
            // commits without the catalog (trial-local, commitTrial).
            const current = path.join(this.conf.tool_root, SELF, 'current');
            setInterval(() => {
                // the Store installed or reinstalled gets the secret: under another
                // uid, or emptied by MainApp (its crash recovery reinstalls an app)
                if (storeUid(this.conf) !== this.storeSecretUid || this.storeSecretGone()) {
                    this.writeSecrets();
                }
                let target;
                try {
                    target = fs.realpathSync(current);
                } catch (e) {
                    return;
                }
                if (!this.busy && target !== fs.realpathSync(HERE)) {
                    writeAtomic(path.join(this.conf.tool_root, SELF, 'trial-local'), '');
                    writeAtomic(trial, `${fs.realpathSync(HERE)}\n`);
                    this.handover();
                }
            }, 15000);
            // the uplink's status.json (its Wi-Fi scans and links), for the Store
            setInterval(() => {
                if (this.readUplink()) {
                    this.changed();
                }
            }, (Number(this.conf.uplink_poll_s) || 2) * 1000);
            // the uplink coming up is a good moment to look
            setInterval(() => {
                const online = readLease(this.conf).online;
                if (online !== wasOnline) {
                    wasOnline = online;
                    this.changed();
                    if (online) {
                        this.check();
                    }
                }
            }, 15000);
        });
    }
}

/* ---- command line ----------------------------------------------------------- */

function printState(st) {
    const age = st.catalog.checkedAt ? `${Math.round((Date.now() - st.catalog.checkedAt) / 60000)} min ago` : 'never';
    console.log(`updater ${st.updater.version}, ${st.online ? 'online' : 'offline'}, catalog checked ${age}` +
        `${st.catalog.error ? ` (last check: ${st.catalog.error})` : ''}`);
    st.components.forEach((c) => {
        const what = {
            installed: `${c.installed}`,
            update: `${c.installed} -> ${c.version}`,
            available: `not installed (${c.version})`,
            newer: `${c.installed} (catalog has ${c.version})`
        }[c.status];
        const flags = [c.pendingReboot ? 'takes effect after reboot' : '', c.queued ? 'queued' : '',
            st.busy && st.busy.id === c.id ? st.busy.phase : '', c.error ? `error: ${c.error}` : ''].filter(Boolean);
        console.log(`  ${c.id.padEnd(22)} ${c.kind.padEnd(5)} ${what}${flags.length ? `  [${flags.join(', ')}]` : ''}`);
    });
}

function cli(argv) {
    const conf = loadConf();
    const [cmd, arg] = argv;
    if (cmd === 'daemon') {
        logToFile(conf.log_file);
        new Updater(conf).run().catch((err) => {
            console.error(`cannot start: ${err.message}`);
            process.exit(1);
        });
        return;
    }
    if (['status', 'check', 'install'].indexOf(cmd) < 0 || (cmd === 'install' && !arg)) {
        console.log('usage: updater.js daemon | status [--json] | check | install <id>');
        process.exitCode = 2;
        return;
    }
    const client = new UpdaterClient(conf.socket);
    let sent = false;
    let started = false;
    const done = (code, st) => {
        if (st) {
            if (arg === '--json') {
                console.log(JSON.stringify(st, null, 2));
            } else {
                printState(st);
            }
        }
        client.close();
        process.exitCode = code;
    };
    client.on('error', (err) => {
        console.error(`updater not reachable at ${conf.socket}: ${err.message}`);
        done(1);
    });
    client.on('reply-error', (err) => {
        console.error(err);
        done(1);
    });
    client.on('close', () => {
        // the updater closes every session when it hands over to a new version of itself
        console.log(cmd === 'install' && arg === SELF ? 'installed; the updater restarted into the new version' :
            'the updater closed the connection');
        done(cmd === 'install' && arg === SELF ? 0 : 1);
    });
    client.on('state', (st) => {
        if (cmd === 'status') {
            done(0, st);
        } else if (!sent) {
            sent = true;
            client.send(cmd === 'check' ? { op: 'check' } : { op: 'install', id: arg });
        } else if (cmd === 'check' && !st.catalog.checking) {
            done(st.catalog.error ? 1 : 0, st);
        } else if (cmd === 'install') {
            const row = st.components.find((c) => c.id === arg);
            const active = (st.busy && st.busy.id === arg) || (row && row.queued);
            started = started || active;
            if (started && !active) {
                done(row && row.error ? 1 : 0, st);
            }
        }
    });
    client.connect();
}

if (require.main === module) {
    cli(process.argv.slice(2));
}

module.exports = { Updater, Fetcher, loadConf, installedApp, installedTool, fileLog,
    // tests: a stand-in phone page
    _setWeb: (w) => { web = w; } };
