'use strict';
/**
 * mgu-updater: installs and updates our apps and head-unit tools from the
 * published catalog, and serves the Store app. Node 8, as root.
 *
 *   node updater.js daemon              the service (started by the mgu-updater supervisor)
 *   node updater.js status [--json]     installed versions against the catalog
 *   node updater.js check               fetch the catalog now
 *   node updater.js install <id>        install <id>, or update it to the catalog's version
 *
 * The daemon reads the catalog through the source in updater.conf, compares
 * it with what is installed (apps: MainApp's registry; tools:
 * /var/opt/<id>/current/component.json), downloads an artifact through an
 * unprivileged child (fetch.js) and installs it with the deploy tool's
 * `install --artifact`, the same path every install takes. Updating itself,
 * it hands over to the new version through the supervisor, which returns to
 * the previous one if the new one does not come up (README.md). On the
 * Store's request it restarts the head unit with the `reboot` command.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const util = require('util');
const { URL } = require('url');
const catalogLib = require('./catalog');
const { UpdaterClient } = require('./client');

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

/* updater.conf next to this file (in the repo: one folder up), then the
 * unit's own overrides. */
function loadConf() {
    const own = path.join(HERE, 'updater.conf');
    const file = fs.existsSync(own) ? own : path.join(HERE, '..', 'updater.conf');
    const conf = readConf(file, {});
    readConf(process.env.MGU_UPDATER_CONF || conf.local_conf || '/var/opt/mgu-updater/updater.local.conf', conf);
    // relative paths in either file are relative to updater.conf
    ['public_key', 'ca_file'].forEach((k) => {
        if (conf[k]) {
            conf[k] = path.resolve(path.dirname(file), conf[k]);
        }
    });
    return conf;
}

function selfVersion() {
    try {
        return JSON.parse(fs.readFileSync(path.join(HERE, 'component.json'), 'utf8')).version;
    } catch (e) {
        return 'dev';
    }
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

/* An app is installed when MainApp's registry names its uid and that uid's
 * source tree holds its package.json. */
function installedApp(conf, id) {
    const oap = conf.oap_root;
    try {
        const entry = readJson(path.join(oap, `oap_${conf.mainapp_uid}`, 'data', 'apps', `${id}.json`));
        const pkg = readJson(path.join(oap, `oap_${entry.userId}`, 'source', 'package.json'));
        return pkg.name === id ? { id, kind: 'app', version: pkg.version } : null;
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
    return deployStatus(conf).then((st) => ((st && st.pending_reboot) || []).map((p) => (p && p.id) || p));
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

    /* Downloads url; resolves with its bytes. */
    get(url, headers, name, maxBytes, onProgress) {
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
                        resolve(this.collect(dest, maxBytes));
                    } catch (err) {
                        reject(err);
                    }
                } else {
                    reject(new Error(result && result.error || 'download failed'));
                }
            });
            child.stdin.end(JSON.stringify({ url, headers, dest, maxBytes, dns: lease.dns, ca: this.ca }));
        }).then((bytes) => {
            this.retire(dir);
            return bytes;
        }, (err) => {
            this.retire(dir);
            throw err;
        });
    }
}

/* ---- catalog sources -------------------------------------------------------- */

/* github:<owner>/<repo>: GitHub Releases (release/publish.js), read with
 * the token in token_file. https://…/catalog.json: a static host, artifact
 * URLs relative to it. file:///…/catalog.json: a local folder. */
function makeSource(conf, fetcher) {
    const ua = { 'User-Agent': `mgu-updater/${selfVersion()}` };
    const spec = conf.catalog;
    const token = () => (conf.token_file && fs.existsSync(conf.token_file) ?
        fs.readFileSync(conf.token_file, 'utf8').trim() : '');
    const text = (buf) => buf.toString('utf8');
    if (/^file:\/\//.test(spec)) {
        const file = new URL(spec).pathname;
        return {
            catalogText: () => Promise.resolve().then(() => fs.readFileSync(file, 'utf8')),
            artifact: (entry) => Promise.resolve().then(() =>
                fs.readFileSync(path.resolve(path.dirname(file), entry.artifact.url || entry.artifact.name)))
        };
    }
    if (/^https:\/\//.test(spec)) {
        return {
            catalogText: () => fetcher.get(spec, ua, 'catalog.json', 4 << 20).then(text),
            artifact: (entry, onProgress) => fetcher.get(new URL(entry.artifact.url || entry.artifact.name, spec).toString(),
                ua, entry.artifact.name, entry.artifact.size, onProgress)
        };
    }
    const gh = /^github:([\w.-]+\/[\w.-]+)$/.exec(spec);
    if (gh) {
        const api = (accept) => Object.assign({ Accept: accept, Authorization: `Bearer ${token()}` }, ua);
        // the token goes to api.github.com only
        const assetHeaders = (url) => (new URL(url).hostname === 'api.github.com' ?
            api('application/octet-stream') : ua);
        return {
            catalogText: () => fetcher.get(`https://api.github.com/repos/${gh[1]}/releases/tags/catalog`,
                api('application/vnd.github+json'), 'release.json', 1 << 20)
                .then((buf) => {
                    const asset = (JSON.parse(text(buf)).assets || []).find((a) => a.name === 'catalog.json');
                    if (!asset) {
                        throw new Error('the catalog release has no catalog.json');
                    }
                    return fetcher.get(asset.url, api('application/octet-stream'), 'catalog.json', 4 << 20);
                })
                .then(text),
            artifact: (entry, onProgress) => fetcher.get(entry.artifact.url, assetHeaders(entry.artifact.url),
                entry.artifact.name, entry.artifact.size, onProgress)
        };
    }
    throw new Error(`catalog = ${spec}: use github:<owner>/<repo>, https://…/catalog.json or file:///…/catalog.json`);
}

/* ---- the daemon ----------------------------------------------------------- */

class Updater {
    constructor(conf) {
        this.conf = conf;
        this.version = selfVersion();
        this.fetcher = new Fetcher(conf);
        this.source = makeSource(conf, this.fetcher);
        // A key that cannot be read refuses every catalog.
        this.publicKey = null;
        this.keyError = null;
        if (conf.public_key) {
            try {
                this.publicKey = fs.readFileSync(conf.public_key, 'utf8');
            } catch (e) {
                this.keyError = `public key ${conf.public_key} unreadable`;
            }
        }
        this.catalogFile = path.join(conf.state_dir, 'catalog.json');
        this.catalog = null;
        this.checkedAt = null;
        this.catalogError = null;
        this.busy = null;
        this.queue = [];
        this.errors = {};
        this.pending = [];
        this.privacy = null;
        this.clients = new Set();
        this.checking = null;
        this.sendTimer = null;
        this.rebooting = false;
        this.rebootError = null;
        try {
            if (this.keyError) {
                throw new Error(this.keyError);
            }
            this.catalog = catalogLib.parse(fs.readFileSync(this.catalogFile, 'utf8'), this.publicKey);
            this.checkedAt = fs.statSync(this.catalogFile).mtime.getTime();
        } catch (e) {
            this.catalog = null;
        }
    }

    installed() {
        const list = [];
        (this.catalog ? this.catalog.components : []).forEach((c) => {
            const i = c.kind === 'app' ? installedApp(this.conf, c.id) : installedTool(this.conf, c.id);
            if (i) {
                list.push(i);
            }
        });
        return list;
    }

    state() {
        const rows = catalogLib.plan(this.catalog, this.installed()).map((r) => Object.assign(r, {
            pendingReboot: this.pending.indexOf(r.id) >= 0,
            queued: this.queue.indexOf(r.id) >= 0,
            error: this.errors[r.id] || null
        }));
        return {
            type: 'state',
            updater: { version: this.version },
            online: readLease(this.conf).online,
            privacy: this.privacy,
            catalog: {
                commit: this.catalog ? this.catalog.commit : null,
                checkedAt: this.checkedAt,
                checking: !!this.checking,
                error: this.catalogError
            },
            busy: this.busy,
            rebooting: this.rebooting,
            rebootError: this.rebootError,
            components: rows
        };
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

    check() {
        if (this.checking) {
            return this.checking;
        }
        this.changed();
        this.rebootError = null;
        this.checking = Promise.resolve()
            .then(() => {
                if (this.keyError) {
                    throw new Error(this.keyError);
                }
                return this.source.catalogText();
            })
            .then((text) => {
                const catalog = catalogLib.parse(text, this.publicKey);
                mkdirp(this.conf.state_dir, 0o755);
                fs.writeFileSync(`${this.catalogFile}.tmp`, text);
                fs.renameSync(`${this.catalogFile}.tmp`, this.catalogFile);
                this.catalog = catalog;
                this.catalogError = null;
                this.checkedAt = Date.now();
                console.log(`catalog ${catalog.commit}: ${catalog.components.map((c) => `${c.id}@${c.version}`).join(' ')}`);
            })
            .catch((err) => {
                this.catalogError = err.message;
                console.log(`catalog check failed: ${err.message}`);
            })
            .then(() => this.refresh())
            .then(() => {
                this.checking = null;
                this.changed();
            });
        return this.checking;
    }

    request(id) {
        if (this.rebooting) {
            return 'the head unit is restarting';
        }
        const entry = this.catalog && this.catalog.components.find((c) => c.id === id);
        if (!entry) {
            return `${id} is not in the catalog`;
        }
        if ((this.busy && this.busy.id === id) || this.queue.indexOf(id) >= 0) {
            return null;
        }
        delete this.errors[id];
        this.queue.push(id);
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
        const other = this.queue.findIndex((q) => q !== SELF);
        const id = this.queue.splice(other >= 0 ? other : 0, 1)[0];
        if (!id) {
            this.busy = null;
            this.changed();
            return;
        }
        const entry = this.catalog && this.catalog.components.find((c) => c.id === id);
        if (!entry) {
            this.errors[id] = 'no longer in the catalog';
            this.next();
            return;
        }
        this.install(entry).then((handover) => {
            if (handover) {
                this.handover();
                return;
            }
            this.next();
        });
    }

    /* Downloads, verifies and installs one catalog entry. Resolves true when
     * the updater installed a new version of itself. */
    install(entry) {
        const id = entry.id;
        this.busy = { id, phase: 'download', progress: 0, total: entry.artifact.size };
        this.changed();
        console.log(`${id}@${entry.version}: download (${entry.artifact.size} bytes)`);
        const verifiedDir = path.join(this.conf.state_dir, 'verified');
        const verified = path.join(verifiedDir, entry.artifact.name);
        const trial = path.join(this.conf.tool_root, SELF, 'trial');
        const self = id === SELF;
        const toolDir = path.join(this.conf.tool_root, id);
        let before = null;
        return Promise.resolve()
            .then(() => this.source.artifact(entry, (bytes) => {
                this.busy.progress = bytes;
                this.changed();
            }))
            .then((bytes) => {
                this.busy.phase = 'verify';
                this.changed();
                console.log(`${id}@${entry.version}: verify`);
                if (bytes.length !== entry.artifact.size || sha256(bytes) !== entry.artifact.sha256) {
                    throw new Error('download does not match the catalog (size or sha256)');
                }
                // the checked bytes, root's alone, are what the deploy tool reads
                mkdirp(verifiedDir, 0o700);
                fs.writeFileSync(verified, bytes, { mode: 0o600 });
                if (!fs.existsSync(this.conf.deploy)) {
                    throw new Error(`deploy tool missing (${this.conf.deploy})`);
                }
                this.busy.phase = 'install';
                this.changed();
                console.log(`${id}@${entry.version}: install`);
                try {
                    before = fs.readlinkSync(path.join(toolDir, 'current'));
                } catch (e) { /* not installed yet */ }
                if (self) {
                    // the version to return to if the new one does not come up
                    rmIfThere(path.join(this.conf.tool_root, SELF, 'trial-local'));
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
                return this.bootstrapCheck(entry, toolDir, before);
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
                    console.log(`${id}@${entry.version}: done`);
                    this.busy = null;
                    this.changed();
                    return handover;
                });
            });
    }

    /* The tools the updater itself runs on: the deploy tool (every install
     * goes through it) and the uplink (every download goes through it). A
     * new version of either must work before the updater relies on it: the
     * deploy tool must answer status, the uplink must give internet again.
     * Otherwise the version installed before is put back. The updater
     * itself is checked by commitTrial and its supervisor (bin/mgu-updater). */
    bootstrapCheck(entry, toolDir, before) {
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
        if (entry.id === this.conf.uplink_tool) {
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

    /* The catalog can be fetched again within ms: the internet works. */
    online(ms) {
        const deadline = Date.now() + ms;
        const attempt = () => Promise.resolve()
            .then(() => (readLease(this.conf).online ? this.source.catalogText() : Promise.reject(new Error('no lease'))))
            .then(() => true, () => {
                if (Date.now() >= deadline) {
                    return false;
                }
                return new Promise((r) => setTimeout(r, 3000)).then(attempt);
            });
        return attempt();
    }

    /* What only the unit's tools can tell: pending reboots, the privacy patch. */
    refresh() {
        return Promise.all([pendingReboot(this.conf), privacyState(this.conf)]).then(([pending, privacy]) => {
            this.pending = pending;
            this.privacy = privacy;
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

    /* One JSON request per line: {op:"status"} | {op:"check"} | {op:"install", id}
     * | {op:"reboot"}. Every client gets the full state on connect and
     * whenever it changes. */
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
                let error = null;
                if (req.op === 'check') {
                    this.check();
                } else if (req.op === 'install' && typeof req.id === 'string') {
                    error = this.request(req.id);
                } else if (req.op === 'reboot') {
                    error = this.reboot();
                } else if (req.op !== 'status') {
                    error = `unknown op ${req.op}`;
                }
                s.write(JSON.stringify(error ? { type: 'error', op: req.op, error } : this.state()) + '\n');
            }
        });
    }

    /* A version on trial is kept once it has done its job end to end: the
     * catalog fetched through the uplink (verified, or an HTTP answer from
     * the server: its network path works), and a deploy tool that answers.
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
        const reached = () => !this.catalogError || /^HTTP \d+ from /.test(this.catalogError);
        const fetched = () => !needsCatalog || (readLease(this.conf).online && reached());
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
                    this.busy = null;
                    this.next();
                    return;
                }
                const reason = fetched() ? 'the deploy tool does not answer it' :
                    !readLease(this.conf).online ? 'there was no internet to check it with' :
                        `it cannot fetch the catalog (${this.catalogError})`;
                console.log(`${this.version} not kept: ${reason}`);
                writeAtomic(path.join(this.conf.tool_root, SELF, 'trial-reason'), `${reason}\n`);
                process.exit(1);
            });
    }

    run() {
        return this.serve().then(() => {
            this.fetcher.clean();
            const trial = path.join(this.conf.tool_root, SELF, 'trial');
            if (fs.existsSync(trial)) {
                this.commitTrial(trial);
            } else {
                rmIfThere(path.join(this.conf.tool_root, SELF, 'trial-local'));
                console.log(`running ${this.version}`);
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
            // A version installed from outside (the deploy tool run from the
            // Mac) is taken up on trial too, with this one to return to; it
            // commits without the catalog (trial-local, commitTrial).
            const current = path.join(this.conf.tool_root, SELF, 'current');
            setInterval(() => {
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

module.exports = { Updater, Fetcher, loadConf, makeSource, installedApp, installedTool, fileLog };
