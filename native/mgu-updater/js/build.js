'use strict';
/**
 * A repo's own app build on the unit (mgu-repo.json `"build": {"node" or
 * "python": "<script>", "args": [...]}`; README.md, "Building on the unit").
 * Node 8.
 *
 * The repo's files are written to a folder of their own in state_dir and
 * handed to the build uid (uids.js: no account, not in the uplink's
 * lists, so no network); the script runs there as that uid, under this Node
 * or conf `python` (the mgu-python tool), cwd = the repo copy, with
 *   MGU_SDK_DONOR  the SDK donor bundle the deploy tool names (read-only)
 *   MGU_OUT        an empty folder, where it leaves <id>@<version>.tgz,
 *                  unless the build names its `output` in the repo
 * HOME and TMPDIR point into its folder too, and this Node's and Python's
 * folders are on PATH. A build with `sdk` finds the oap-sdk module the
 * deploy tool generates from the donor (index.js, package.json) in that
 * folder of the repo copy. A build with `network` gets the internet through
 * an HTTP proxy the fetch uid runs for it alone (proxy.js; http_proxy and
 * https_proxy), and fails without the uplink. It is stopped past
 * build_timeout_s, or once its folder holds more than build_max_bytes.
 * Every process of the build uid is killed before a build starts (and
 * before root hands it the repo copy) and after it ends, so nothing a
 * script left running, in its process group or not, reaches the next
 * build. Root reads the result only as a regular file inside MGU_OUT,
 * bounded, and removes the folder's contents as the build uid.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const MAX_LOG_LINES = 2000;

/* node -e COPY_OUTPUT <from> <to> <max bytes>: copies a regular file of at
 * most that size, opened without following a link and without blocking (a
 * FIFO is no file). */
const COPY_OUTPUT = `
const fs = require('fs');
const [from, to, max] = process.argv.slice(1);
let fd;
try {
    fd = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
} catch (e) {
    process.stderr.write(e.code === 'ENOENT' ? 'the build left no such file' : 'not a file the build left (' + e.code + ')');
    process.exit(1);
}
const st = fs.fstatSync(fd);
if (!st.isFile() || st.size > Number(max)) {
    process.stderr.write(st.isFile() ? 'more than ' + max + ' bytes' : 'not a regular file');
    process.exit(1);
}
try {
    const outFd = fs.openSync(to, 'wx', 0o644);
    const buf = Buffer.alloc(1 << 20);
    let total = 0;
    for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        total += n;
        if (total > Number(max)) { process.stderr.write('more than ' + max + ' bytes'); process.exit(1); }
        for (let off = 0; off < n;) off += fs.writeSync(outFd, buf, off, n - off);
    }
    fs.closeSync(outFd);
} catch (e) {
    process.stderr.write('cannot copy it (' + (e.code || e.message) + ')');
    process.exit(1);
}
`;

function mkdirp(dir, mode) {
    if (!fs.existsSync(dir)) {
        mkdirp(path.dirname(dir), mode);
        fs.mkdirSync(dir, mode);
    }
}

/* Bytes under dir (du -sk), or 0 when du cannot tell. */
function usage(dir) {
    try {
        return Number(cp.execFileSync('du', ['-sk', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s/)[0]) * 1024;
    } catch (e) {
        return 0;
    }
}

/* Kills every process of the build uid (kill(-1) as that uid, which spares
 * only the caller). Not as root (tests): there is no build uid then. */
function killAll(uid, gid) {
    if (process.getuid() !== 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const k = cp.spawn(process.execPath, ['-e', 'try { process.kill(-1, "SIGKILL"); } catch (e) { /* none */ }'],
            { uid, gid, stdio: 'ignore', env: {} });
        k.on('error', () => resolve());
        k.on('close', () => resolve());
    });
}

/* The proxy for a network build, as the fetch uid: resolves with
 * { url, stop() } once it listens. lease: { online, dns }. */
function startProxy(conf, lease, log, id) {
    if (!lease.online) {
        return Promise.reject(new Error('needs internet to build (the uplink is down)'));
    }
    const token = crypto.randomBytes(16).toString('hex');
    const asRoot = process.getuid() === 0;
    return new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [path.join(__dirname, 'proxy.js')], Object.assign({
            stdio: ['pipe', 'pipe', 'inherit'], env: {}
        }, asRoot ? { uid: Number(conf.fetch_uid), gid: Number(conf.fetch_gid) } : {}));
        let buf = '';
        let up = false;
        const stop = () => {
            try {
                child.kill('SIGKILL');
            } catch (e) { /* gone */ }
        };
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
                if (ev.listening && !up) {
                    up = true;
                    resolve({ url: `http://mgu:${token}@127.0.0.1:${ev.listening}`, stop });
                } else if (ev.request) {
                    log(`build ${id}: internet: ${ev.request}`);
                } else if (ev.refused) {
                    log(`build ${id}: internet refused: ${ev.refused}`);
                }
            }
        });
        child.on('error', reject);
        child.on('exit', () => {
            if (!up) {
                reject(new Error('the build\'s proxy did not start'));
            }
        });
        child.stdin.end(JSON.stringify({ token, uid: asRoot ? Number(conf.build_uid) : process.getuid(), dns: lease.dns,
            maxBytes: Number(conf.build_max_bytes), idleMs: 60000, open: process.env.MGU_TEST_PROXY_OPEN === '1' }));
    });
}

/* opts: { conf, entry, files: [{ name, data, mode }] (the repo, relative to
 * its root), donor, sdk (the folder holding the generated oap-sdk module,
 * for a build with `sdk`), lease ({ online, dns }, for a network build),
 * log }. Resolves with the package's bytes. */
function runBuild(opts) {
    const { conf, entry, files, donor, sdk, log } = opts;
    const python = !!entry.script.python;
    const interpreter = python ? conf.python : process.execPath;
    let proxy = null;
    const uid = Number(conf.build_uid);
    const gid = Number(conf.build_gid);
    const maxBytes = Number(conf.build_max_bytes);
    const timeoutMs = Number(conf.build_timeout_s) * 1000;
    const asRoot = process.getuid() === 0;
    // every process of the build uid is killed: it must be the builds' alone
    if (!(uid >= 1000) || [conf.fetch_uid, conf.web_uid].map(Number).indexOf(uid) >= 0) {
        return Promise.reject(new Error(`build_uid ${conf.build_uid} is not a uid of the builds' own`));
    }
    const dir = path.join(conf.state_dir, `build-${crypto.randomBytes(6).toString('hex')}`);
    const repo = path.join(dir, 'repo');
    const out = path.join(dir, 'out');
    const tmp = path.join(dir, 'tmp');
    const name = `${entry.id}@${entry.version}.tgz`;
    const retire = () => killAll(uid, gid).then(() => new Promise((resolve) => {
        if (proxy) {
            proxy.stop();
        }
        const rm = cp.spawn('rm', ['-rf', repo, out, tmp], Object.assign({ stdio: 'ignore' }, asRoot ? { uid, gid } : {}));
        rm.on('error', () => resolve());
        rm.on('close', () => {
            [repo, out, tmp, dir].forEach((d) => {
                try {
                    fs.rmdirSync(d);
                } catch (e) { /* not empty: the next start retries */ }
            });
            resolve();
        });
    }));
    return killAll(uid, gid)
        .then(() => {
            const script = entry.script.node || entry.script.python;
            if (!files.some((f) => f.name === script)) {
                throw new Error(`the build script ${script} is not in the repo`);
            }
            if (python && !fs.existsSync(interpreter)) {
                throw new Error(`needs Python (${interpreter}): install mgu-python`);
            }
            let total = 0;
            mkdirp(conf.state_dir, 0o755);
            fs.mkdirSync(dir, 0o755);
            [repo, out, tmp].forEach((d) => fs.mkdirSync(d, 0o700));
            files.forEach((f) => {
                total += f.data.length;
                if (total > maxBytes) {
                    throw new Error(`the repo is more than ${maxBytes} bytes`);
                }
                const to = path.join(repo, f.name);
                mkdirp(path.dirname(to), 0o755);
                fs.writeFileSync(to, f.data, { mode: f.mode & 0o111 ? 0o755 : 0o644 });
            });
            if (entry.script.sdk) {
                if (!sdk) {
                    throw new Error('no oap-sdk module for the build (needs mgu-deploy 0.3.2 or newer)');
                }
                const to = path.join(repo, entry.script.sdk);
                mkdirp(to, 0o755);
                ['index.js', 'package.json'].forEach((n) => fs.writeFileSync(path.join(to, n), fs.readFileSync(path.join(sdk, n)), { mode: 0o644 }));
            }
            if (asRoot) {
                cp.execFileSync('chown', ['-R', `${uid}:${gid}`, repo, out, tmp]);
            }
            log(`build ${entry.id}@${entry.version}: ${python ? 'python' : 'node'} ${[script].concat(entry.script.args).join(' ')}` +
                `${entry.script.network ? ' (with internet)' : ''}`);
            return entry.script.network ? startProxy(conf, opts.lease || { online: false }, log, entry.id).then((p) => {
                proxy = p;
            }) : null;
        })
        .then(() => {
            const script = entry.script.node || entry.script.python;
            const env = { MGU_SDK_DONOR: donor, MGU_OUT: out, HOME: tmp, TMPDIR: tmp,
                PATH: [path.dirname(process.execPath)].concat(python ? [path.dirname(interpreter)] : [], ['/usr/bin', '/bin']).join(':') };
            if (python) {
                // the CA bundle mgu-python carries: the unit's own may be missing
                Object.assign(env, { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
                    SSL_CERT_FILE: path.join(path.dirname(path.dirname(interpreter)), 'ssl', 'cacert.pem') });
            }
            if (proxy) {
                Object.assign(env, { http_proxy: proxy.url, https_proxy: proxy.url, HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url,
                    no_proxy: 'localhost,127.0.0.1', NO_PROXY: 'localhost,127.0.0.1' });
            }
            return new Promise((resolve, reject) => {
                const child = cp.spawn(interpreter, [script].concat(entry.script.args), Object.assign({
                    cwd: repo,
                    detached: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env
                }, asRoot ? { uid, gid } : {}));
                let lines = 0;
                let stopped = null;
                const onLine = (d) => d.toString().split('\n').filter(Boolean).forEach((l) => {
                    lines += 1;
                    if (lines <= MAX_LOG_LINES) {
                        log(`build ${entry.id}: ${l}`);
                    }
                });
                child.stdout.on('data', onLine);
                child.stderr.on('data', onLine);
                const stop = (why) => {
                    if (!stopped) {
                        stopped = why;
                        try {
                            process.kill(-child.pid, 'SIGKILL');
                        } catch (e) { /* gone */ }
                        killAll(uid, gid);
                    }
                };
                const timer = setTimeout(() => stop(`took longer than ${conf.build_timeout_s} s`), timeoutMs);
                const watch = setInterval(() => {
                    if (usage(dir) > maxBytes) {
                        stop(`wrote more than ${maxBytes} bytes`);
                    }
                }, 2000);
                child.on('error', (err) => {
                    clearTimeout(timer);
                    clearInterval(watch);
                    reject(err);
                });
                // exit, not close: a process the script started may hold its output open
                child.on('exit', (code, signal) => {
                    clearTimeout(timer);
                    clearInterval(watch);
                    // whatever the script left running, before root reads MGU_OUT
                    try {
                        process.kill(-child.pid, 'SIGKILL');
                    } catch (e) { /* gone */ }
                    killAll(uid, gid).then(() => {
                        if (stopped) {
                            reject(new Error(`the build ${stopped}`));
                        } else if (code !== 0) {
                            reject(new Error(`the build failed (${signal || `exit ${code}`})`));
                        } else {
                            resolve();
                        }
                    });
                });
            });
        })
        .then(() => {
            if (!entry.script.output) {
                return null;
            }
            // the declared package, copied to MGU_OUT as the build uid (it can copy only what it
            // can read): a regular file, not reached through a link, bounded in size and time
            return new Promise((resolve, reject) => {
                const c = cp.spawn(process.execPath, ['-e', COPY_OUTPUT, path.join(repo, entry.script.output), path.join(out, name), String(maxBytes)],
                    Object.assign({ stdio: ['ignore', 'ignore', 'pipe'], env: {} }, asRoot ? { uid, gid } : {}));
                let why = '';
                c.stderr.on('data', (d) => { why += d; });
                const timer = setTimeout(() => c.kill('SIGKILL'), 60000);
                c.on('error', reject);
                c.on('close', (code) => {
                    clearTimeout(timer);
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`${entry.script.output}: ${why.trim() || 'not copied within 60 s'}`));
                    }
                });
            });
        })
        .then(() => {
            const left = fs.readdirSync(out);
            if (left.length !== 1 || left[0] !== name) {
                throw new Error(`the build left ${left.length ? left.join(', ') : 'nothing'} in MGU_OUT, not ${name} alone`);
            }
            const fd = fs.openSync(path.join(out, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            try {
                const st = fs.fstatSync(fd);
                if (!st.isFile() || st.size > maxBytes || st.size === 0) {
                    throw new Error(`${name} is not a file of at most ${maxBytes} bytes`);
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
                log(`build ${entry.id}@${entry.version}: ${name}, ${off} bytes`);
                return buf.slice(0, off);
            } finally {
                fs.closeSync(fd);
            }
        })
        .then((bytes) => retire().then(() => bytes), (err) => retire().then(() => {
            throw err;
        }));
}

/* Build folders an earlier run left, emptied as the build uid. */
function cleanBuilds(conf) {
    try {
        fs.readdirSync(conf.state_dir).filter((n) => /^build-/.test(n)).forEach((n) => {
            const dir = path.join(conf.state_dir, n);
            const parts = ['repo', 'out', 'tmp'].map((p) => path.join(dir, p));
            const rm = cp.spawn('rm', ['-rf'].concat(parts), Object.assign({ stdio: 'ignore' },
                process.getuid() === 0 ? { uid: Number(conf.build_uid), gid: Number(conf.build_gid) } : {}));
            rm.on('error', () => {});
            rm.on('close', () => parts.concat([dir]).forEach((d) => {
                try {
                    fs.rmdirSync(d);
                } catch (e) { /* the next start retries */ }
            }));
        });
    } catch (e) { /* no state_dir yet */ }
}

module.exports = { runBuild, cleanBuilds, startProxy };
