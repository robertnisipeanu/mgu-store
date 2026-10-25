'use strict';
/**
 * A repo's own app build on the unit (mgu-repo.json `"build": {"node":
 * "<script>", "args": [...]}`; README.md, "Building on the unit"). Node 8.
 *
 * The repo's files are written to a folder of their own in state_dir and
 * handed to the build uid (conf build_uid: no account, not in the uplink's
 * lists, so no network); the script runs there under this Node as that uid,
 * cwd = the repo copy, with
 *   MGU_SDK_DONOR  the SDK donor bundle the deploy tool names (read-only)
 *   MGU_OUT        an empty folder, where it leaves <id>@<version>.tgz
 * HOME and TMPDIR point into its folder too. It is stopped past
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

/* opts: { conf, entry, files: [{ name, data, mode }] (the repo, relative to
 * its root), donor, log }. Resolves with the package's bytes. */
function runBuild(opts) {
    const { conf, entry, files, donor, log } = opts;
    const uid = Number(conf.build_uid);
    const gid = Number(conf.build_gid);
    const maxBytes = Number(conf.build_max_bytes);
    const timeoutMs = Number(conf.build_timeout_s) * 1000;
    const asRoot = process.getuid() === 0;
    const dir = path.join(conf.state_dir, `build-${crypto.randomBytes(6).toString('hex')}`);
    const repo = path.join(dir, 'repo');
    const out = path.join(dir, 'out');
    const tmp = path.join(dir, 'tmp');
    const name = `${entry.id}@${entry.version}.tgz`;
    const retire = () => killAll(uid, gid).then(() => new Promise((resolve) => {
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
            const script = entry.script.node;
            if (!files.some((f) => f.name === script)) {
                throw new Error(`the build script ${script} is not in the repo`);
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
            if (asRoot) {
                cp.execFileSync('chown', ['-R', `${uid}:${gid}`, repo, out, tmp]);
            }
            log(`build ${entry.id}@${entry.version}: node ${[script].concat(entry.script.args).join(' ')}`);
            return new Promise((resolve, reject) => {
                const child = cp.spawn(process.execPath, [script].concat(entry.script.args), Object.assign({
                    cwd: repo,
                    detached: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { MGU_SDK_DONOR: donor, MGU_OUT: out, HOME: tmp, TMPDIR: tmp, PATH: '/usr/bin:/bin' }
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

module.exports = { runBuild, cleanBuilds };
