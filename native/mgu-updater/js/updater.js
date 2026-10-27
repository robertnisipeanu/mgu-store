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
 * log_file with its time, readable by others: raluca-car's diag `file` op
 * reads /tmp over the tailnet, up to about 192 KiB from a file's start, so
 * the file is renamed to <log_file>.1 past 128 KiB. /tmp is everyone's: the
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

/* A small JSON file of an app's own tree, read without following a link. */
function readAppJson(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > 262144) {
            throw new Error(`${file}: not a small file`);
        }
        const buf = Buffer.alloc(st.size);
        fs.readSync(fd, buf, 0, st.size, 0);
        return JSON.parse(buf.toString('utf8'));
    } finally {
        fs.closeSync(fd);
    }
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

/* An app is installed when MainApp's registry names its uid and that uid's
 * source tree holds its package.json. wantTitle: also its entry point's
 * en_GB text, for a source that names none. */
function installedApp(conf, id, wantTitle) {
    const oap = conf.oap_root;
    try {
        const entry = readJson(path.join(oap, `oap_${conf.mainapp_uid}`, 'data', 'apps', `${id}.json`));
        const home = path.join(oap, `oap_${entry.userId}`);
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

function installedTool(conf, id) {
    try {
        const c = readJson(path.join(conf.tool_root, id, 'current', 'component.json'));
        return c.id === id ? { id, kind: 'tool', version: c.version } : null;
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

/* Downloads run in a child as the fetch uid, each into a folder of its own
 * that root makes in state_dir and hands to that uid. Root reads the result
 * only through a descriptor opened without following links and checked to
 * be a regular file of bounded size, and removes the folder's contents as
 * the fetch uid, so nothing that uid plants there leads root anywhere. */
class Fetcher {
    constructor(conf) {
        this.conf = conf;
        this.state = conf.state_dir;
        this.uid = Number(conf.fetch_uid);
        this.gid = Number(conf.fetch_gid);
        this.ca = conf.ca_file ? fs.readFileSync(conf.ca_file, 'utf8') : null;
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

    /* Downloads url (method GET, or POST with body); resolves with its bytes,
     * the response headers named in job.keep as their .headers. A failure
     * carries the HTTP status as err.status when the server answered. */
    request(job) {
        const { url, headers, name, maxBytes, onProgress } = job;
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
                    } else if (ev.done || ev.error) {
                        result = ev;
                    }
                }
            });
            child.on('error', reject);
            child.on('close', () => {
                if (result && result.done) {
                    try {
                        resolve(Object.assign(this.collect(dest, maxBytes), { headers: result.headers || {} }));
                    } catch (err) {
                        reject(err);
                    }
                } else {
                    reject(Object.assign(new Error(result && result.error || 'download failed'),
                        result && result.status ? { status: result.status } : {}, result && result.rateLimited ? { rateLimited: true } : {}));
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

/* The origin a source stands for: a stick's mgu-repo/<name>, which
 * mgu-install.js usb-repo writes from the source of that name, stands for
 * that source; any other source for itself. */
function originOf(sourceId) {
    const m = /^usb:[^/]*\/mgu-repo\/([^/]+)$/.exec(sourceId);
    return m ? m[1] : sourceId;
}

/* entry as it installs under id, its own id as listedId (Updater.place). */
function under(entry, id) {
    return Object.assign({}, entry, { id, listedId: entry.id, artifact: Object.assign({}, entry.artifact, { name: `${id}@${entry.version}.tgz` }) });
}
// Requests only the Store and the phone page may make (they hold the secret).
const PRIVILEGED = ['uninstall', 'source-add', 'source-probe', 'source-remove', 'login-start', 'login-cancel', 'token-add', 'token-remove', 'web', 'logs'];

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
        this.fetcher = new Fetcher(conf);
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
     * the token that read it (tokenId) and whether its repo said it is
     * public. */
    addRuntime(def) {
        const rt = { def, reader: sourcesLib.reader(def, this.ctx), status: 'ok', error: null, checkedAt: null,
            channel: def.channel || null, mode: null, commit: null, components: [], checking: null, answered: false,
            tokenId: null, public: false };
        if (def.type !== 'usb') {
            try {
                const c = readJson(this.cacheFile(def.id));
                Object.assign(rt, { mode: c.mode, channel: c.channel || rt.channel, commit: c.commit, components: c.components, checkedAt: c.checkedAt,
                    tokenId: c.token || null, public: c.public === true });
            } catch (e) { /* not read yet */ }
        }
        this.src.set(def.id, rt);
        return rt;
    }

    defs() {
        return this.stored.concat(this.usb);
    }

    /* The source an installed app's id belongs to, when the updater
     * installed it (origins.json), else null. */
    holder(id) {
        const o = this.origins[id];
        return o && installedApp(this.conf, id) ? o.source : null;
    }

    sourceLabel(id) {
        const def = this.defs().find((d) => d.id === id);
        return def ? sourcesLib.label(def) : id;
    }

    /* Where a source's entry goes on the unit (README.md, "Ids"). An app
     * whose id an installed app of another origin holds goes under the id
     * it was installed under before (aliases.json), else, when the updater
     * builds it, under the first free <id>2, <id>3, ...: the entry as that
     * id, its own id as listedId. A package built elsewhere keeps its id
     * and is blocked, keyed <id>@<source> beside the installed one's row;
     * when the installed one's origin lists that id no more, it is that row
     * (the installed app stays shown and removable). taken: ids no new
     * alias may have (every listed id, every alias). */
    place(source, entry, taken) {
        if (REPLACED[entry.id]) {
            return Object.assign({}, entry, { blocked: REPLACED[entry.id] });
        }
        if (entry.kind !== 'app') {
            return entry;
        }
        const alias = this.aliases[`${originOf(source)}:${entry.id}`];
        if (alias && sourcesLib.renameable(entry)) {
            return under(entry, alias);
        }
        const holder = this.holder(entry.id);
        if (!holder || originOf(holder) === originOf(source)) {
            return entry;
        }
        for (let n = 2; sourcesLib.renameable(entry) && n < 100; n += 1) {
            const id = `${entry.id}${n}`;
            if (ID.test(id) && !taken.has(id) && !this.installedOf(id)) {
                taken.add(id);
                return under(entry, id);
            }
        }
        const listed = this.defs().some((d) => originOf(d.id) === originOf(holder) &&
            (this.src.get(d.id) || { components: [] }).components.some((c) => c.id === entry.id));
        return Object.assign({}, entry, { id: listed ? `${entry.id}@${source}` : entry.id, listedId: entry.id,
            blocked: `${entry.id} is already installed from ${this.sourceLabel(holder)}` });
    }

    /* Each component id once: the highest version a source lists; of equal
     * versions, the source that installed it (origins.json), then USB media,
     * then sources.json order. Without internet, a network source's last
     * listing counts only for ids no other source lists. An app another
     * origin's app holds the id of is placed beside it (place). */
    resolved() {
        const online = readLease(this.conf).online;
        const found = new Map();
        const taken = new Set(Object.keys(this.aliases).map((k) => this.aliases[k]));
        this.defs().forEach((def) => (this.src.get(def.id) || { components: [] }).components.forEach((e) => taken.add(e.id)));
        this.defs().forEach((def, order) => {
            const rt = this.src.get(def.id);
            (rt ? rt.components : []).forEach((own) => {
                const entry = this.place(def.id, own, taken);
                const list = found.get(entry.id) || [];
                list.push({ entry, source: def.id, order, usb: def.type === 'usb', reachable: online || !rt.reader.network });
                found.set(entry.id, list);
            });
        });
        const map = new Map();
        found.forEach((list, id) => {
            const o = this.origins[id];
            const rank = (c) => (o && o.source === c.source ? 0 : c.usb ? 1 : 2);
            const pool = list.some((c) => c.reachable) ? list.filter((c) => c.reachable) : list;
            const best = pool.reduce((a, c) => {
                const cmp = catalogLib.compareVersions(c.entry.version, a.entry.version);
                return cmp > 0 || (cmp === 0 && (rank(c) < rank(a) || (rank(c) === rank(a) && c.order < a.order))) ? c : a;
            });
            map.set(id, { entry: best.entry, source: best.source });
        });
        this.unlisted().forEach((r) => {
            if (!map.has(r.entry.id)) {
                map.set(r.entry.id, r);
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
            const o = this.origins[row.id];
            // a branch's new commit of the same version
            if (row.status === 'installed' && entry.revision && o && o.source === row.source && o.commit && o.commit !== entry.commit) {
                row.status = 'update';
            }
            const icon = entry.icon ? this.iconFile(resolved[i].source, entry) : null;
            // the App Manager's service alone is enough for its Remove
            if (row.id === APP_MANAGER && !row.installed && this.amPresent()) {
                row.installed = this.appmanager.version;
            }
            return Object.assign(row, {
                // the kept icon (a PNG anyone may read), null without one
                icon: icon && fs.existsSync(icon) ? icon : null,
                compat: catalogLib.compat(row.mguHmi, this.unit && this.unit.hmi),
                revision: entry.revision || null,
                // the id its source lists, when it is (or would be) installed under another one
                listedId: entry.listedId || null,
                // why it cannot be installed: another origin's app holds its id
                blocked: entry.blocked || null,
                pendingReboot: this.pending.indexOf(row.id) >= 0,
                queued: this.queue.some((q) => q.id === row.id),
                error: this.errors[row.id] || null
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
     * last, then the others (those GitHub rejects last); no token (null)
     * first for a repo known to be public, else last. */
    candidates(rt) {
        const ids = this.tokens.all().filter((t) => !t.rejected).concat(this.tokens.all().filter((t) => t.rejected)).map((t) => t.id);
        const order = (ids.indexOf(rt.tokenId) >= 0 ? [rt.tokenId] : []).concat(ids.filter((id) => id !== rt.tokenId));
        return rt.public ? [null].concat(order) : order.concat([null]);
    }

    /* A source's listing. A GitHub source is read with each candidate token
     * in turn (a reader of its own per token) until one reaches the repo;
     * that one is kept for it (rt.tokenId), and its downloads use it. */
    readSource(rt) {
        if (rt.def.type !== 'github') {
            return rt.reader.catalog();
        }
        const cands = this.candidates(rt);
        const attempt = (i) => {
            const text = cands[i] ? this.tokens.text(cands[i]) : '';
            const reader = sourcesLib.reader(rt.def, Object.assign({}, this.ctx, { tokenFor: () => text }));
            return reader.catalog().then((cat) => {
                rt.tokenId = cands[i];
                rt.public = cat.public === true;
                return cat;
            }, (err) => {
                if (err.auth && i + 1 < cands.length) {
                    return attempt(i + 1);
                }
                if (err.auth) {
                    rt.tokenId = null;
                }
                throw err;
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
                    status: 'ok', error: cat.skipped && cat.skipped.length ? `left out: ${cat.skipped.join('; ')}` : null,
                    checkedAt: Date.now(), answered: true });
                if (rt.def.type !== 'usb') {
                    mkdirp(path.dirname(this.cacheFile(id)), 0o700);
                    writeAtomic(this.cacheFile(id), JSON.stringify({ mode: rt.mode, channel: rt.channel, commit: rt.commit,
                        components: rt.components, checkedAt: rt.checkedAt, token: rt.tokenId, public: rt.public }));
                }
                console.log(`source ${id}${rt.channel ? ` (${rt.channel})` : ''}${rt.tokenId ? ` with token ${rt.tokenId}` : ''}: ` +
                    `${rt.mode}${rt.commit ? ` ${rt.commit.slice(0, 7)}` : ''}, ` +
                    `${cat.components.map((c) => `${c.id}@${c.version}`).join(' ') || 'nothing'}${rt.error ? `; ${rt.error}` : ''}`);
                // in the background: a slow icon host holds up no check
                this.fetchIcons(rt);
            }, (err) => {
                rt.status = err.auth ? 'auth-needed' : 'error';
                rt.error = err.message;
                rt.answered = err.status !== undefined || !!err.auth;
                console.log(`source ${id}: ${rt.status}: ${err.message}`);
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

    /* Fetches the icons a source's components name that are not kept yet,
     * one source's at a time: a PNG of at most ICON_BYTES, matching its
     * sha256 when the source gives one, kept world-readable for the Store.
     * A missing or bad icon is logged and asked for again a day later; the
     * component is listed without it. */
    fetchIcons(rt) {
        if (rt.icons) {
            return rt.icons;
        }
        const dir = path.join(this.conf.state_dir, 'icons');
        this.iconFailed = this.iconFailed || new Map();
        const due = (file) => !fs.existsSync(file) && !(this.iconFailed.get(file) > Date.now() - 86400000);
        rt.icons = rt.components.filter((c) => c.icon && due(this.iconFile(rt.def.id, c))).reduce((p, c) => p
            .then(() => rt.reader.icon(c))
            .then((b) => {
                if (b.length > sourcesLib.ICON_BYTES || b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
                    throw new Error(`not a PNG of at most ${sourcesLib.ICON_BYTES} bytes`);
                }
                if (c.icon.sha256 && sha256(b) !== c.icon.sha256) {
                    throw new Error('does not match its sha256');
                }
                mkdirp(dir, 0o755);
                const file = this.iconFile(rt.def.id, c);
                fs.writeFileSync(`${file}.tmp`, b, { mode: 0o644 });
                fs.chmodSync(`${file}.tmp`, 0o644);
                fs.renameSync(`${file}.tmp`, file);
                this.changed();
            })
            .catch((err) => {
                this.iconFailed.set(this.iconFile(rt.def.id, c), Date.now());
                console.log(`source ${rt.def.id}: icon of ${c.id}: ${err.message}`);
            }), Promise.resolve()).then(() => {
            rt.icons = null;
        });
        return rt.icons;
    }

    /* Removes the kept icons no source's components name. */
    pruneIcons() {
        const dir = path.join(this.conf.state_dir, 'icons');
        const keep = [];
        this.defs().forEach((d) => {
            const rt = this.src.get(d.id);
            (rt ? rt.components : []).filter((c) => c.icon).forEach((c) => keep.push(path.basename(this.iconFile(d.id, c))));
        });
        try {
            fs.readdirSync(dir).filter((n) => keep.indexOf(n) < 0).forEach((n) => rmIfThere(path.join(dir, n)));
        } catch (e) { /* none yet */ }
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
        this.scanUsb();
        this.scanTokens();
        this.validateTokens();
        this.checking = Promise.all(this.defs().map((d) => this.checkSource(d.id)))
            .then(() => this.pruneIcons())
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

    /* An entry of dep at least min: from source first, else any source in order. */
    findRequirement(dep, min, source) {
        const order = [source].concat(this.defs().map((d) => d.id).filter((id) => id !== source));
        for (let i = 0; i < order.length; i += 1) {
            const rt = this.src.get(order[i]);
            const e = rt && rt.components.find((c) => c.id === dep && catalogLib.compareVersions(c.version, min) >= 0);
            if (e) {
                return { entry: e, source: order[i] };
            }
        }
        return null;
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
        steps.push(Object.assign({ id: r.entry.id, source: r.source }, r.entry.listedId ? { listed: r.entry.listedId } : {}));
        return steps;
    }

    /* Why item cannot be queued (the other operation on that id is queued
     * or running), or null. */
    conflict(item) {
        const same = this.queue.find((q) => q.id === item.id) || (this.busy && this.busy.id === item.id ? { op: this.busy.op || 'install' } : null);
        return same && same.op !== item.op ? `${item.id}: ${same.op === 'uninstall' ? 'a removal' : 'an install'} is queued or running` : null;
    }

    /* Queues item unless the same is queued or running; returns why it
     * cannot be queued, or null. */
    enqueue(item) {
        const refused = this.conflict(item);
        if (refused || this.queue.some((q) => q.id === item.id) || (this.busy && this.busy.id === item.id)) {
            return refused;
        }
        delete this.errors[item.id];
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
        // the updater installs last and restarts into its new version, which
        // ends the queue: what needs it waits for that, asked for again
        const self = steps.find((s) => s.id === SELF);
        if (self && id !== SELF) {
            steps = [self];
            this.errors[id] = `needs a newer ${SELF}: it installs first, then ${id} can be installed`;
        }
        const items = steps.map((s) => Object.assign({ op: 'install', id: s.id, source: s.source }, s.listed ? { listed: s.listed } : {}));
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

    /* Queues a removal of id: one its source marks uninstallable, installed,
     * that nothing installed, nor the updater itself, requires. */
    requestUninstall(id) {
        if (this.rebooting) {
            return 'the head unit is restarting';
        }
        const all = this.resolved();
        const r = all.get(id);
        if (!r) {
            return `${id} is not in any source`;
        }
        if (!r.entry.uninstallable || id === SELF || id === this.conf.deploy_tool ||
            (selfComponent().requires || {})[id]) {
            return `${id} cannot be removed`;
        }
        if (!this.installedVersion(id, r.entry.kind) && !(id === APP_MANAGER && this.amPresent())) {
            return `${id} is not installed`;
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
        const refused = this.enqueue({ op: 'uninstall', id });
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

    /* Takes the next request; the updater's own update goes last, since it
     * restarts the daemon and a queue does not survive that. */
    next() {
        const other = this.queue.findIndex((q) => q.id !== SELF);
        const item = this.queue.splice(other >= 0 ? other : 0, 1)[0];
        if (!item) {
            this.busy = null;
            this.changed();
            return;
        }
        (item.op === 'uninstall' ? this.uninstall(item) : item.op === 'adopt' ? this.adopt() : this.install(item)).then((handover) => {
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
            return this.sdkDonor()
                .then((donor) => runBuild({ conf: this.conf, entry: made.entry, files: made.files, donor: donor.path, sdk: donor.module,
                    lease: readLease(this.conf), log: (l) => console.log(l) }))
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
        const id = item.id;
        const rt = this.src.get(item.source);
        const own = rt && rt.components.find((c) => c.id === (item.listed || id));
        if (!own) {
            this.errors[id] = 'no longer in its source';
            return Promise.resolve(false);
        }
        const entry = item.listed ? under(own, id) : own;
        // an uplink installed without internet (from a stick) has none to give back
        const wasOnline = readLease(this.conf).online;
        this.busy = { id, op: 'install', phase: 'download', progress: 0, total: entry.artifact.size || null };
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
                // an app of another origin holds the id (it was placed so since it was asked for)
                const holder = entry.kind === 'app' ? this.holder(id) : null;
                if (holder && originOf(holder) !== originOf(item.source)) {
                    throw new Error(`${id} is already installed from ${this.sourceLabel(holder)}`);
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
                return this.deploy(verified);
            })
            .then((code) => {
                if (code !== 0) {
                    const why = this.deployError;
                    throw new Error(code === 2 ? `${why || 'refused by the deploy tool'}; nothing changed` :
                        `install failed${why ? ': ' + why : ''}; the previous version was kept`);
                }
                console.log(`installed ${id}@${entry.version}`);
                this.origins[id] = { source: item.source, commit: entry.commit || null };
                this.saveOrigins();
                if (entry.listedId) {
                    this.aliases[`${originOf(item.source)}:${entry.listedId}`] = id;
                    this.saveAliases();
                }
                return this.bootstrapCheck(entry, toolDir, before, wasOnline);
            })
            .then(() => self)
            .catch((err) => {
                console.log(`${id}@${entry.version}: ${err.message}`);
                this.errors[id] = err.message;
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
        const id = item.id;
        this.busy = { id, op: 'uninstall', phase: 'uninstall' };
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
                this.errors[id] = err.message;
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
            if (st) {
                this.unit = unitOf(st);
                this.providers = providersOf(st);
                this.appmanager = st.appmanager && typeof st.appmanager === 'object' ? st.appmanager : null;
                this.idrive7 = st.idrive7 && Array.isArray(st.idrive7.apps) ? st.idrive7.apps : [];
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
        return this.deployTool(['install', '--artifact', file, '--yes']);
    }

    /* Runs the deploy tool; resolves with its exit status. deployError keeps
     * the reason it gave for its last failure ("mgu-deploy: <reason>"). */
    deployTool(args) {
        this.deployError = null;
        return new Promise((resolve) => {
            const child = cp.spawn(this.conf.deploy, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const log = (d) => d.toString().split('\n').filter(Boolean).forEach((l) => {
                console.log(`deploy: ${l}`);
                const m = /^mgu-deploy: (.+)/.exec(l);
                if (m) {
                    this.deployError = m[1];
                }
            });
            child.stdout.on('data', log);
            child.stderr.on('data', log);
            child.on('error', () => resolve(1));
            child.on('close', (code) => resolve(code));
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
        Object.keys(this.origins).forEach((c) => {
            if (this.origins[c].source === id) {
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
        case 'source-add': return this.sourceAdd(req);
        case 'source-probe': return this.sourceProbe(req, reply);
        case 'source-remove': return this.sourceRemove(req.id);
        case 'login-start': return this.login.start();
        case 'login-cancel': this.login.cancel(); return null;
        case 'token-add': return this.tokenAdd(req, reply);
        case 'token-remove': return this.tokenRemove(req.id);
        case 'web': return this.setWeb(req.enable === true);
        case 'logs': return this.logs(req, reply);
        default: return `unknown op ${req.op}`;
        }
    }

    /* The new version is in place: the supervisor starts it once we exit. */
    handover() {
        console.log('handing over to the new version');
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
        const attempt = () => (!needsCatalog ? Promise.resolve() : (readLease(this.conf).online ? this.check() : Promise.resolve())
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
                    this.next();
                    return;
                }
                const reason = fetched() ? 'the deploy tool does not answer it' :
                    !readLease(this.conf).online ? 'there was no internet to check it with' :
                        `it cannot fetch the catalog (${this.catalogError()})`;
                console.log(`${this.version} not kept: ${reason}`);
                writeAtomic(path.join(this.conf.tool_root, SELF, 'trial-reason'), `${reason}\n`);
                process.exit(1);
            });
    }

    run() {
        return this.serve().then(() => {
            this.fetcher.clean();
            cleanBuilds(this.conf);
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
            // USB media: nothing announces a stick, so the mounts are looked
            // at; the token files too (the deploy tool changes them)
            setInterval(() => {
                this.scanUsb();
                this.scanTokens();
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
