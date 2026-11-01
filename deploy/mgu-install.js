#!/usr/bin/env node
'use strict';
/**
 * mgu-install: sets up the Store on a head unit over SSH, and makes USB
 * sticks the Store installs and updates from without internet. One file,
 * no dependencies: Node 18 or newer and the system's OpenSSH client, on
 * Windows, macOS or Linux (deploy/README.md, "mgu-install").
 *
 *   node mgu-install.js first-install [--from <folder>] [--no-renderer] [--no-uplink] [--token] [<ssh options>]
 *   node mgu-install.js token [--list [--json] | --remove <id>] [<ssh options>]
 *   node mgu-install.js usb-repo <stick folder> [<input>...]
 *
 * first-install downloads the newest published mgu-store release (the
 * deploy tool, app-privacy, the updater, the Store's source package, the
 * renderer the Store draws its screens with and the internet uplink;
 * --no-renderer and --no-uplink leave those two out, and one the deploy tool
 * refuses is left out), checks each file against the
 * catalog's size and sha256, sends them to the unit and installs them with
 * the release's own deploy tool, which builds the Store on the unit. Newer
 * installed components are kept; running it again is safe. --token adds a
 * GitHub token for the updater afterwards.
 *
 * first-install --from <folder> installs from a folder usb-repo wrote
 * (<folder>/mgu-repo/mgu-store) instead of GitHub, each file checked
 * against its catalog the same way: download at home, install at the car
 * without internet.
 *
 * token adds a GitHub token for the updater (no option), lists the tokens
 * (--list: id, label, account; --json as JSON) or removes one (--remove
 * <id>, an id --list names). A token is read from a hidden
 * prompt, or from stdin when stdin is not a terminal; it is never an
 * argument, never printed.
 *
 * usb-repo writes a local repository onto a stick: one folder
 * mgu-repo/<name>/ per input, which the updater reads as a source while the
 * stick is in. Inputs: github:<owner>/<repo>, an https:// catalog.json URL,
 * a folder holding catalog.json or mgu-repo.json, or package files (*.tgz,
 * *.mgu: apps, source packages, tool kits; together in mgu-repo/local/).
 * Without inputs: github:robertnisipeanu/mgu-store.
 *
 * Without --host or --port it finds the head unit itself: the
 * car's hotspot (172.16.222.97) when its SSH answers, else over ENET (an
 * interface with a 169.254.x.x address) the address the vehicle gateway
 * reports for the head unit (DID 22 17 2A, read without changing any
 * session), or the last ENET address that answered. ssh then binds to
 * that interface's address (ssh -b). --ssh-opt options apply either way.
 *
 * SSH options: --host <address>, --port <n> (22), --user <name> (root),
 * --identity <key file>, and --ssh-opt <option> (repeatable, passed as
 * ssh -o <option>).
 *
 * It also runs from stdin: curl -fsSL <url> | node - first-install ...
 *
 * Downloads from a private GitHub repository take a token: the one given
 * with --token, else `gh auth token` when the GitHub CLI is signed in, else
 * a hidden prompt. Exit status: 0 done, 1 failed, 2 refused or bad usage.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const cp = require('child_process');
const net = require('net');
const dgram = require('dgram');
const tty = require('tty');

const STORE_REPO = 'robertnisipeanu/mgu-store';
const GITHUB_API = process.env.MGU_INSTALL_GITHUB_API || 'https://api.github.com';
const HOTSPOT_IP = '172.16.222.97';
/* the hotspot address detection tries first (<host>[:<port>]; the tests point it elsewhere) */
const HOTSPOT = process.env.MGU_INSTALL_HOTSPOT || HOTSPOT_IP;
/* HSFZ (diagnostics over IP) to the ENET gateway: identification on UDP
 * 6811, UDS on TCP 6801, from tester 0xF4 to the head unit 0x63 */
const HSFZ_IDENT_PORT = 6811;
const HSFZ_DIAG_PORT = 6801;
const TESTER = 0xf4;
const HEAD_UNIT = 0x63;
/* the head unit's last ENET address that answered (deploy/transport keeps the same file) */
const LAST_ENET = path.join(os.homedir(), '.cache', 'mgu-store', 'last_hu_enet_ip');
/* run as `node -` with the script on stdin */
const FROM_STDIN = __filename === '[stdin]';
/* the updater's sources first-install seeds when it has none (deploy/sources.json) */
const SOURCES = { schema: 1, sources: [{ id: 'mgu-store', type: 'github', repo: STORE_REPO, builtin: true },
    { id: 'idrive7-apps', type: 'github', repo: 'cauliflowermossgrape/idrive7-apps', channel: 'branch' },
    { id: 'idrive-apps', type: 'github', repo: 'robertnisipeanu/idrive-apps', channel: 'releases' },
    { id: 'car-apps', type: 'github', repo: 'IterioDev/car-apps', channel: 'tags' }] };
/* the installed deploy tool */
const DEPLOY = '/var/opt/mgu-deploy/mgu-deploy.sh';
const UPDATER_JS = '/var/opt/mgu-updater/current/updater.js';
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ASSET = /^([a-z0-9][a-z0-9_-]{0,63})@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.(tgz|mgu)$/;
const TOKEN = /^[\x21-\x7e]{1,512}$/;
const MAX_ARTIFACT = 512 << 20;
/* what the updater reads from a stick (native/mgu-updater/js/sources.js) */
const STICK_JSON_MAX = 1 << 20;
const STICK_REPO_MAX = 200 << 20;
const STICK_REPO_FILES = 20000;

class Usage extends Error {}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function say(line) {
    process.stdout.write(`${line}\n`);
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) {
            return pa[i] < pb[i] ? -1 : 1;
        }
    }
    return 0;
}

/* ---- tar ------------------------------------------------------------------------- */

/* A gzipped ustar archive of entries { name, data, mode }, owner 0:0. */
function tgz(entries, mtime) {
    const blocks = [];
    entries.forEach((e) => {
        const name = Buffer.from(e.name);
        if (name.length > 100) {
            throw new Error(`tar: name over 100 bytes: ${e.name}`);
        }
        const h = Buffer.alloc(512);
        name.copy(h, 0);
        const num = (v, off, len) => h.write(`${v.toString(8).padStart(len - 1, '0')}\0`, off, len, 'ascii');
        num(e.mode & 0o7777, 100, 8);
        num(0, 108, 8);
        num(0, 116, 8);
        num(e.data.length, 124, 12);
        num(mtime, 136, 12);
        h.fill(' ', 148, 156);
        h.write('0', 156, 1, 'ascii');
        h.write('ustar\0', 257, 6, 'ascii');
        h.write('00', 263, 2, 'ascii');
        let sum = 0;
        for (let i = 0; i < 512; i += 1) {
            sum += h[i];
        }
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
        blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
    });
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

/* The regular files of gzipped tar bytes: [{ name, data, mode }] (ustar,
 * pax and GNU long names; "./" prefixes dropped). */
function untgz(buf, max) {
    const tar = zlib.gunzipSync(buf, { maxOutputLength: max || MAX_ARTIFACT });
    const out = [];
    const str = (b) => b.toString('utf8').replace(/\0.*$/s, '');
    let off = 0;
    let longName = null;
    while (off + 512 <= tar.length) {
        const h = tar.slice(off, off + 512);
        if (h.every((x) => x === 0)) {
            break;
        }
        const size = parseInt(str(h.slice(124, 136)).trim() || '0', 8);
        const type = String.fromCharCode(h[156] || 48);
        const data = tar.slice(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;
        if (type === 'x') {
            const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
            longName = m ? m[1] : longName;
            continue;
        }
        if (type === 'L') {
            longName = str(data);
            continue;
        }
        const prefix = str(h.slice(345, 500));
        let name = longName || (prefix ? `${prefix}/${str(h.slice(0, 100))}` : str(h.slice(0, 100)));
        longName = null;
        name = name.replace(/^(\.\/)+/, '');
        if ((type === '0' || type === '\0') && name) {
            out.push({ name, data: Buffer.from(data), mode: parseInt(str(h.slice(100, 108)).trim() || '644', 8) });
        }
    }
    return out;
}

/* ---- downloads --------------------------------------------------------------------- */

/* https only; plain http to this machine for tests. */
function checkUrl(u) {
    const url = new URL(u);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        return url;
    }
    throw new Usage(`not an https URL: ${u}`);
}

/* GET url's body, at most max bytes. A token goes to the GitHub API host
 * only, never to a host a redirect leads to. */
async function get(url, { token, accept, max } = {}) {
    const apiHost = new URL(GITHUB_API).host;
    let u = checkUrl(url);
    for (let hop = 0; hop < 8; hop += 1) {
        const headers = { 'User-Agent': 'mgu-install', Accept: accept || '*/*' };
        if (token && u.host === apiHost) {
            headers.Authorization = `Bearer ${token}`;
        }
        let res;
        try {
            res = await fetch(u, { headers, redirect: 'manual' });
        } catch (e) {
            throw new Error(`${u.origin}${u.pathname}: ${e.cause ? e.cause.message : e.message}`);
        }
        if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
            u = checkUrl(new URL(res.headers.get('location'), u));
            continue;
        }
        if (!res.ok) {
            throw Object.assign(new Error(`${u.origin}${u.pathname}: HTTP ${res.status}`), { status: res.status });
        }
        const chunks = [];
        let total = 0;
        for await (const chunk of res.body) {
            total += chunk.length;
            if (total > (max || MAX_ARTIFACT)) {
                throw new Error(`${u.origin}${u.pathname}: more than ${max || MAX_ARTIFACT} bytes`);
            }
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    throw new Error(`${url}: too many redirects`);
}

/* An artifact's bytes, checked against the size and sha256 its catalog
 * lists (or that the release asset states). */
function checked(name, data, size, hash) {
    if (data.length !== size) {
        throw new Error(`${name}: ${data.length} bytes, the source lists ${size}; not used`);
    }
    if (hash && sha256(data) !== hash) {
        throw new Error(`${name}: sha256 does not match the source's; not used`);
    }
    return data;
}

/* ---- tokens -------------------------------------------------------------------------- */

function readAll(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

/* The terminal to prompt at: stdin, or the terminal device when the
 * script itself came on stdin; null when there is none. */
function terminal() {
    if (process.stdin.isTTY) {
        return process.stdin;
    }
    if (!FROM_STDIN || process.platform === 'win32') {
        return null;
    }
    try {
        return new tty.ReadStream(fs.openSync('/dev/tty', 'r'));
    } catch (e) {
        return null;
    }
}

/* A line typed at the terminal, not echoed. */
function promptHidden(question, input) {
    return new Promise((resolve, reject) => {
        process.stderr.write(question);
        input.setRawMode(true);
        input.setEncoding('utf8');
        input.resume();
        let text = '';
        const end = (err) => {
            input.removeListener('data', onData);
            input.setRawMode(false);
            input.pause();
            if (input !== process.stdin) {
                input.destroy();
            }
            process.stderr.write(os.EOL);
            if (err) {
                reject(err);
            } else {
                resolve(text);
            }
        };
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    end(null);
                    return;
                }
                if (ch === '\u0003' || ch === '\u0004') {
                    end(new Usage('cancelled'));
                    return;
                }
                if (ch === '\u007f' || ch === '\b') {
                    text = text.slice(0, -1);
                } else if (ch >= ' ') {
                    text += ch;
                }
            }
        };
        input.on('data', onData);
    });
}

let stdinTaken = false;

/* A GitHub token: a hidden prompt at a terminal, else stdin (once). */
async function readToken(question, term = terminal()) {
    let text;
    if (term) {
        text = await promptHidden(question, term);
    } else if (FROM_STDIN) {
        throw new Usage('a token is needed and there is no terminal to type it at; run the downloaded file with node instead');
    } else if (!stdinTaken) {
        stdinTaken = true;
        text = (await readAll(process.stdin)).toString('utf8');
    } else {
        throw new Usage('a token is needed and stdin was read already; run it at a terminal');
    }
    text = text.trim();
    if (!TOKEN.test(text)) {
        throw new Usage(text ? 'a token is 1 to 512 printable characters without spaces' : 'no token given');
    }
    return text;
}

/* The GitHub CLI's token, when it is installed and signed in. */
function ghToken() {
    const r = cp.spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const t = r.status === 0 ? String(r.stdout).trim() : '';
    return TOKEN.test(t) ? t : null;
}

/* ---- GitHub ---------------------------------------------------------------------------- */

/* A repo through the REST API, read with the first of: no token, the
 * given one, the GitHub CLI's, a prompted one, that reaches it. */
async function githubRepo(repo, given) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
        throw new Usage(`not a GitHub repository: ${repo}`);
    }
    const base = `${GITHUB_API.replace(/\/+$/, '')}/repos/${repo}`;
    const tries = [() => null, () => given || null, ghToken,
        () => {
            const term = terminal();
            return term ? readToken(`GitHub token for ${repo} (input hidden): `, term) : null;
        }];
    let token = null;
    let reached = false;
    let last = null;
    for (let i = 0; i < tries.length; i += 1) {
        const t = await tries[i]();
        if (i > 0 && !t) {
            continue;
        }
        try {
            await get(base, { token: t, accept: 'application/vnd.github+json', max: 1 << 20 });
            token = t;
            reached = true;
            break;
        } catch (e) {
            last = e;
            if (![401, 403, 404].includes(e.status)) {
                throw e;
            }
        }
    }
    if (!reached) {
        throw new Error(`${repo}: no access (${last && last.message}); give a token with access to it`);
    }
    const json = async (rel) => JSON.parse((await get(`${base}${rel}`, { token, accept: 'application/vnd.github+json', max: 8 << 20 })).toString('utf8'));
    const asset = (a, max) => get(a.url, { token, accept: 'application/octet-stream', max });
    return { repo, json, asset };
}

/* A GitHub repo's published components: its `catalog` release's
 * catalog.json, else the newest <id>@<x.y.z>.tgz (or .mgu) asset of each
 * id in its releases. [{ entry, fetch() }] */
async function githubComponents(gh) {
    let release = null;
    try {
        release = await gh.json('/releases/tags/catalog');
    } catch (e) {
        if (e.status !== 404) {
            throw e;
        }
    }
    if (release) {
        const a = (release.assets || []).find((x) => x.name === 'catalog.json');
        if (!a) {
            throw new Error(`${gh.repo}: the catalog release has no catalog.json`);
        }
        const catalog = parseCatalog((await gh.asset(a, 4 << 20)).toString('utf8'), `${gh.repo} catalog.json`);
        return { commit: catalog.commit, components: catalog.components.map((entry) => ({
            entry, fetch: () => gh.asset({ url: entry.artifact.url }, entry.artifact.size)
                .then((d) => checked(entry.artifact.name, d, entry.artifact.size, entry.artifact.sha256))
        })) };
    }
    const releases = await gh.json('/releases?per_page=100');
    const newest = new Map();
    let meta = null;
    (Array.isArray(releases) ? releases : []).filter((r) => r && !r.draft && !r.prerelease).forEach((r) => {
        (r.assets || []).forEach((a) => {
            if (a.name === 'mgu-store.json' && !meta) {
                meta = a;
            }
            const m = ASSET.exec(a.name || '');
            if (!m || !(a.size > 0)) {
                return;
            }
            const have = newest.get(m[1]);
            const cmp = have ? compareVersions(m[2], have.version) : 1;
            if (cmp > 0 || (cmp === 0 && m[3] === 'tgz' && have.ext !== 'tgz')) {
                newest.set(m[1], { id: m[1], version: m[2], ext: m[3], asset: a });
            }
        });
    });
    if (!newest.size) {
        throw new Error(`${gh.repo}: no catalog release and no <id>@<x.y.z>.tgz or .mgu in its releases`);
    }
    let titles = {};
    if (meta) {
        try {
            titles = JSON.parse((await gh.asset(meta, 1 << 20)).toString('utf8')).apps || {};
        } catch (e) { /* titles are optional */ }
    }
    return { commit: null, components: Array.from(newest.values()).sort((a, b) => (a.id < b.id ? -1 : 1)).map((n) => {
        const t = titles && typeof titles[n.id] === 'object' && titles[n.id] ? titles[n.id] : {};
        const entry = { id: n.id, kind: 'app', version: n.version,
            title: typeof t.title === 'string' ? t.title : n.id, description: typeof t.description === 'string' ? t.description : '',
            artifact: { name: `${n.id}@${n.version}.tgz`, size: n.asset.size, sha256: null }, uninstallable: true };
        return { entry, file: n.asset.name, fetch: () => gh.asset(n.asset, n.asset.size).then((d) => checked(n.asset.name, d, n.asset.size, null)) };
    }) };
}

/* Checks a catalog (schema 1 or 2, release/README.md) as the updater does. */
function parseCatalog(text, what) {
    let c;
    try {
        c = JSON.parse(text);
    } catch (e) {
        throw new Error(`${what} is not JSON`);
    }
    if (!c || (c.schema !== 1 && c.schema !== 2) || !Array.isArray(c.components)) {
        throw new Error(`${what}: schema is not 1 or 2`);
    }
    const seen = new Set();
    c.components.forEach((e) => {
        const a = e && e.artifact;
        if (!e || !ID.test(e.id) || !['app', 'tool'].includes(e.kind) || !SEMVER.test(e.version) || !a ||
            a.name !== `${e.id}@${e.version}.tgz` || !/^[0-9a-f]{64}$/.test(a.sha256) || !(a.size > 0) || seen.has(e.id)) {
            throw new Error(`${what}: entry ${e && e.id} is malformed`);
        }
        seen.add(e.id);
    });
    return { commit: typeof c.commit === 'string' ? c.commit : null, components: c.components };
}

/* ---- SSH ------------------------------------------------------------------------------- */

function shQuote(s) {
    return `'${String(s).split("'").join("'\\''")}'`;
}

let sshVersion = null;

/* OpenSSH 8.8 and newer leave ssh-rsa out, which the unit's sshd uses. */
function rsaOpts() {
    if (sshVersion === null) {
        const r = cp.spawnSync('ssh', ['-V'], { encoding: 'utf8', windowsHide: true });
        const m = /OpenSSH[^\d]*(\d+)\.(\d+)/.exec(`${r.stderr || ''}${r.stdout || ''}`);
        sshVersion = m ? Number(m[1]) + Number(m[2]) / 100 : 0;
    }
    return sshVersion >= 8.08 ? ['-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa'] : [];
}

/* The unit's host key is neither asked about nor kept: every car's hotspot
 * has the same address, and a unit's key can change. */
const HOST_KEY_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR'];

/* ssh's arguments for one remote command: the owner's -o options first
 * (ssh takes the first value of an option). */
function sshArgs(o, remote) {
    const args = ['-p', String(o.port)].concat(o.bind ? ['-b', o.bind] : []);
    o.sshOpts.forEach((x) => args.push('-o', x));
    if (o.identity) {
        args.push('-i', o.identity, '-o', 'IdentitiesOnly=yes');
    }
    return args.concat(HOST_KEY_OPTS, rsaOpts(), [`${o.user}@${o.host}`, remote]);
}

/* Runs remote on the unit; input on its stdin; capture: its stdout returned. */
function ssh(o, remote, { input, capture } = {}) {
    const r = cp.spawnSync('ssh', sshArgs(o, remote), {
        input, maxBuffer: 64 << 20, windowsHide: true,
        stdio: [input !== undefined ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit', 'inherit']
    });
    if (r.error) {
        throw new Error(r.error.code === 'ENOENT' ? 'no ssh command found; install the OpenSSH client' : `ssh: ${r.error.message}`);
    }
    if (r.status === 255) {
        throw new Error(`ssh to ${o.user}@${o.host}:${o.port} failed`);
    }
    return { status: r.status === null ? 1 : r.status, stdout: capture ? String(r.stdout) : '' };
}

/* ---- finding the head unit ------------------------------------------------------------- */

/* The SSH banner host:port serves (connecting from local when given), else null. */
function sshBanner(host, port, local, timeout = 4000) {
    return new Promise((resolve) => {
        const s = net.connect(Object.assign({ host, port: Number(port), timeout }, local ? { localAddress: local } : {}));
        let got = Buffer.alloc(0);
        const done = (v) => {
            s.destroy();
            resolve(v);
        };
        s.on('data', (d) => {
            got = Buffer.concat([got, d]);
            const nl = got.indexOf(10);
            if (nl >= 0 || got.length >= 255) {
                const line = got.slice(0, nl >= 0 ? nl : got.length).toString('latin1').trim();
                done(line.startsWith('SSH-') ? line : null);
            }
        });
        s.on('timeout', () => done(null));
        s.on('error', () => done(null));
        s.on('end', () => done(null));
    });
}

/* The interfaces with a link-local (169.254.x.x) IPv4 address, the ENET
 * adapter among them: [{ name, address }]. */
function enetInterfaces(ifaces) {
    const out = [];
    Object.entries(ifaces || os.networkInterfaces()).forEach(([name, addrs]) => (addrs || []).forEach((a) => {
        if ((a.family === 'IPv4' || a.family === 4) && !a.internal && /^169\.254\./.test(a.address)) {
            out.push({ name, address: a.address });
        }
    }));
    return out;
}

/* One HSFZ diagnostic frame: length, control 0x0001, tester, head unit, UDS. */
function hsfzFrame(uds) {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(2 + uds.length, 0);
    h.writeUInt16BE(0x0001, 4);
    h[6] = TESTER;
    h[7] = HEAD_UNIT;
    return Buffer.concat([h, uds]);
}

/* The complete HSFZ frames at the start of buf: { frames: [{ control,
 * payload }] (payload without the two address bytes), rest }. */
function hsfzFrames(buf) {
    const frames = [];
    let off = 0;
    while (buf.length - off >= 6 && buf.length - off >= 6 + buf.readUInt32BE(off)) {
        const len = buf.readUInt32BE(off);
        frames.push({ control: buf.readUInt16BE(off + 4), payload: buf.slice(off + 8, off + 6 + len) });
        off += 6 + len;
    }
    return { frames, rest: buf.slice(off) };
}

/* The head unit's address in a response to 22 17 2A (62 17 2A 00 AA BB CC
 * DD), else null. */
function didAddress(uds) {
    return uds.length >= 8 && uds[0] === 0x62 && uds[1] === 0x17 && uds[2] === 0x2a ? Array.from(uds.slice(4, 8)).join('.') : null;
}

/* The ENET gateway's address: HSFZ identification (00 00 00 00 00 11)
 * broadcast from local (from the gateway's port when it is free), answers
 * heard on that socket and on the gateway's port on all addresses (a
 * gateway may answer by broadcast); the first answer that is not the
 * request itself. null when nothing answers. */
const IDENT = Buffer.from([0, 0, 0, 0, 0, 0x11]);

function hsfzGateway(local, { to = ['169.254.255.255', '255.255.255.255'], port = HSFZ_IDENT_PORT, from = HSFZ_IDENT_PORT,
    listen = HSFZ_IDENT_PORT, timeout = 6000 } = {}) {
    const bind = (address, ports) => new Promise((resolve) => {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.once('error', () => {
            s.close();
            resolve(ports.length > 1 ? bind(address, ports.slice(1)) : null);
        });
        s.bind({ address, port: ports[0] }, () => {
            s.removeAllListeners('error');
            s.on('error', () => {});
            resolve(s);
        });
    });
    return Promise.all([bind(local, [from, 0]), bind('0.0.0.0', [listen])]).then(([send, all]) => new Promise((resolve) => {
        const socks = [send, all].filter(Boolean);
        let tick = null;
        let timer = null;
        const done = (v) => {
            clearTimeout(timer);
            clearInterval(tick);
            socks.forEach((x) => x.close());
            resolve(v);
        };
        if (!send) {
            done(null);
            return;
        }
        socks.forEach((x) => x.on('message', (m, r) => {
            if (!m.equals(IDENT)) {
                socks.forEach((y) => y.removeAllListeners('message'));
                done(r.address);
            }
        }));
        const out = () => to.forEach((dst) => send.send(IDENT, port, dst, () => {}));
        send.setBroadcast(true);
        timer = setTimeout(() => done(null), timeout);
        tick = setInterval(out, 1000);
        out();
    }));
}

/* The head unit's address from the gateway: DID 22 17 2A, sent alone (no
 * session change, no routine). null on a negative, odd or missing answer. */
function hsfzHuAddress(gw, local, { port = HSFZ_DIAG_PORT, timeout = 8000 } = {}) {
    return new Promise((resolve) => {
        const s = net.connect(Object.assign({ host: gw, port, timeout }, local ? { localAddress: local } : {}));
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => done(null), timeout);
        function done(v) {
            clearTimeout(timer);
            s.destroy();
            resolve(v);
        }
        s.on('connect', () => s.write(hsfzFrame(Buffer.from([0x22, 0x17, 0x2a]))));
        s.on('data', (d) => {
            const r = hsfzFrames(Buffer.concat([buf, d]));
            buf = r.rest;
            for (const f of r.frames) {
                const p = f.payload;
                // acks (control 0x0002), empty frames and "response pending" (7F xx 78) are not the answer
                if (f.control !== 0x0001 || !p.length || (p.length >= 3 && p[0] === 0x7f && p[2] === 0x78)) {
                    continue;
                }
                done(didAddress(p));
                return;
            }
        });
        s.on('timeout', () => done(null));
        s.on('error', () => done(null));
        s.on('end', () => done(null));
    });
}

function readLast() {
    try {
        const ip = fs.readFileSync(LAST_ENET, 'utf8').trim();
        return /^169\.254\.\d+\.\d+$/.test(ip) ? ip : null;
    } catch (e) {
        return null;
    }
}

function saveLast(ip) {
    try {
        fs.mkdirSync(path.dirname(LAST_ENET), { recursive: true });
        fs.writeFileSync(LAST_ENET, `${ip}\n`);
    } catch (e) { /* only a hint for next time */ }
}

const NET = { banner: sshBanner, interfaces: () => enetInterfaces(), gateway: (local) => hsfzGateway(local),
    huAddress: (gw, local) => hsfzHuAddress(gw, local), last: readLast, save: saveLast, platform: process.platform };

/* Where the head unit's sshd answers: the hotspot; else, on each ENET
 * interface, the address the gateway reports, then the last one that
 * answered. { host, port, bind, via } or null. */
async function findUnit(d = NET) {
    const [hhost, hport] = HOTSPOT.split(':');
    if (await d.banner(hhost, hport || '22', null)) {
        return { host: hhost, port: hport || '22', bind: null, via: `the car's hotspot (${hhost})` };
    }
    const last = d.last();
    // one interface at a time: an answer on the gateway's port names the interface asked
    for (const i of d.interfaces()) {
        const gw = await d.gateway(i.address);
        const ip = gw ? await d.huAddress(gw, i.address) : null;
        for (const c of [ip, last].filter((x, k, a) => x && a.indexOf(x) === k)) {
            if (await d.banner(c, '22', i.address)) {
                d.save(c);
                return { host: c, port: '22', bind: i.address, via: `ENET on ${i.name} (head unit ${c}${c === ip ? '' : ', the last that answered'})` };
            }
        }
    }
    return null;
}

/* What to check when no head unit answered. */
function notFound(d) {
    const lines = ['no head unit answered SSH. Join the car\'s Wi-Fi hotspot or connect the ENET cable, with the car awake, ' +
        'and run it again;', 'for another route, give --host (and --port).'];
    const ifs = d.interfaces();
    if (d.platform === 'linux' && !ifs.length) {
        lines.push('On Linux the ENET adapter needs a link-local address: nmcli con mod <its connection> ipv4.method link-local, then reconnect it.');
    } else if (d.platform === 'linux' && ifs.length > 1) {
        lines.push(`Linux reaches only one of the link-local interfaces ${ifs.map((i) => i.name).join(', ')}: unplug the others, or give --host.`);
    }
    return lines.join('\n');
}

/* Sets the SSH target: as given, or the head unit findUnit finds; which
 * one on stderr (stdout may be token --list --json). */
async function reach(o, d = NET) {
    if (o.given) {
        o.host = o.host || HOTSPOT_IP;
        process.stderr.write(`connecting to ${o.host}:${o.port} as given\n`);
        return;
    }
    const u = await findUnit(d);
    if (!u) {
        throw new Error(notFound(d));
    }
    Object.assign(o, { host: u.host, port: u.port, bind: u.bind });
    process.stderr.write(`connecting over ${u.via}\n`);
}

/* ---- first-install ---------------------------------------------------------------------- */

/* The optional components first-install puts on too, unless told not to:
 * each one's flag, the unit that runs it, and its name in the last line. */
const WITH = [
    { id: 'mgu-render', skip: 'noRenderer', unit: 'mgu-render.socket', name: 'the renderer' },
    { id: 'mgu-uplink', skip: 'noUplink', unit: 'mgu-uplink.service', name: 'the uplink' }
];

function sayList(names) {
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

/* On the unit, in the staging folder: the release's deploy tool installs
 * every artifact (itself among them; newer installed ones kept) and seeds
 * the updater's sources when it has none; then each of WITH on its own, so
 * one it refuses (exit 2) is left out and the
 * rest stays; one that fails fails the run. */
const RUN_SH = `set -e
S=$(cd "$(dirname "$0")" && pwd)
set --
for f in "$S"/artifacts/*.tgz; do set -- "$@" --artifact "$f"; done
sh "$S/mgu-deploy.sh" install "$@" --skip-older --yes
sh "$S/mgu-deploy.sh" updater-sources < "$S/sources.json"
for f in "$S"/with/*.tgz; do
    [ -e "$f" ] || continue
    sh "$S/mgu-deploy.sh" install --artifact "$f" --skip-older --yes || { st=$?; [ $st -eq 2 ] || exit $st; echo "first-install: $(basename "$f") left out" >&2; }
done
`;

/* The deploy tool's own files, from its published artifact: component.json
 * (its manifest) and files/<path>, each checked against the manifest. */
function deployToolFiles(artifact) {
    const members = new Map(untgz(artifact).map((m) => [m.name, m]));
    const c = JSON.parse(members.get('component.json').data.toString('utf8'));
    if (c.id !== 'mgu-deploy' || !Array.isArray(c.files)) {
        throw new Error('the mgu-deploy artifact has no deploy tool manifest');
    }
    return c.files.map((f) => {
        const m = members.get(`files/${f.path}`);
        if (!m || sha256(m.data) !== f.sha256 || f.path.includes('/')) {
            throw new Error(`the mgu-deploy artifact's ${f.path} does not match its manifest`);
        }
        return { name: f.path, data: m.data, mode: parseInt(f.mode, 8) };
    }).concat([{ name: 'component.json', data: members.get('component.json').data, mode: 0o644 }]);
}

/* first-install --from: a folder usb-repo wrote (<folder>/mgu-repo/mgu-store). */
function fromFolder(dir) {
    const d = path.resolve(dir);
    if (!fs.existsSync(path.join(d, 'catalog.json'))) {
        const inner = path.join(d, 'mgu-repo', 'mgu-store');
        throw new Usage(fs.existsSync(path.join(inner, 'catalog.json')) ? `--from: no catalog.json in ${d}; use --from ${inner}` :
            `--from: no catalog.json in ${d}; give the folder usb-repo wrote, <folder>/mgu-repo/mgu-store`);
    }
    return d;
}

async function firstInstall(o) {
    // --from: its catalog is read first, so a missing or bad one stops before the token prompt and the unit search
    const from = o.from ? fromFolder(o.from) : null;
    const local = from ? dirComponents(from) : null;
    const label = from || STORE_REPO;
    const token = o.token ? await readToken('GitHub token for the updater (input hidden): ') : null;
    await reach(o);
    const { components } = local || await githubComponents(await githubRepo(STORE_REPO, token));
    const wanted = WITH.filter((w) => !o[w.skip]);
    const chosen = components.filter((c) => !c.entry.optional || wanted.some((w) => w.id === c.entry.id));
    const withs = wanted.filter((w) => chosen.some((c) => c.entry.id === w.id));
    wanted.filter((w) => withs.indexOf(w) < 0).forEach((w) => say(`${label}: the catalog has no ${w.id}; installing without it`));
    if (!chosen.some((c) => c.entry.id === 'mgu-deploy')) {
        throw new Error(`${label}: the catalog has no mgu-deploy`);
    }
    const artifacts = [];
    for (const c of chosen) {
        const data = await c.fetch();
        say(`  ${sha256(data)}  ${c.entry.artifact.name}`);
        artifacts.push({ entry: c.entry, data });
    }
    const deploy = artifacts.find((a) => a.entry.id === 'mgu-deploy');
    const entries = deployToolFiles(deploy.data)
        .concat(artifacts.map((a) => ({ name: `${withs.some((w) => w.id === a.entry.id) ? 'with' : 'artifacts'}/${a.entry.artifact.name}`,
            data: a.data, mode: 0o644 })))
        .concat([{ name: 'run.sh', data: Buffer.from(RUN_SH), mode: 0o755 },
            { name: 'sources.json', data: Buffer.from(`${JSON.stringify(SOURCES, null, 2)}\n`), mode: 0o644 }]);
    // named so the deploy tool removes it a day later if this run is cut short
    const stage = `/var/opt/mgu-deploy-kit-${process.pid}`;
    const q = shQuote(stage);
    say(`installing on ${o.host}:${o.port}`);
    const run = ssh(o, `rm -rf ${q} && umask 077 && mkdir -p ${q} && tar -xzf - -C ${q} && ` +
        `{ sh ${q}/run.sh; st=$?; rm -rf ${q}; exit $st; }`, { input: tgz(entries, Math.floor(Date.now() / 1000)) });
    if (run.status !== 0) {
        say(`first-install: the install on the unit ended with status ${run.status}`);
        return run.status === 2 ? 2 : 1;
    }
    if (token) {
        const t = addToken(o, token);
        if (t !== 0) {
            return t;
        }
    }
    const services = [{ id: 'mgu-updater', unit: 'mgu-updater.service', name: 'the updater' }].concat(withs);
    // the status on stderr, shown as it comes; which services run on stdout (absent: not installed)
    const st = ssh(o, [`sh ${DEPLOY} status >&2`].concat(services.map((s) =>
        `if [ -e /var/opt/${s.id}/current ]; then systemctl is-active ${s.unit} 2>/dev/null || true; else echo absent; fi`)).join('; '),
        { capture: true });
    const down = services.filter((s, i) => ['active', 'absent'].indexOf((st.stdout.split('\n')[i] || '').trim()) < 0).map((s) => s.name);
    say(down.length ? `Restart the head unit to finish setup (a normal ignition cycle does it): ${sayList(down)} ${down.length > 1 ? 'start' : 'starts'} then.` :
        'Setup is done: the Store installs and updates everything from here on.');
    return 0;
}

/* ---- token -------------------------------------------------------------------------------- */

/* Adds a token through the deploy tool (on stdin); a running updater reads
 * its sources again with it. */
function addToken(o, token) {
    const r = ssh(o, `sh ${DEPLOY} updater-token && if systemctl is-active mgu-updater.service >/dev/null 2>&1; then ` +
        `{ /usr/bin/node ${UPDATER_JS} check >/dev/null 2>&1 && echo 'the updater read its sources with it' || ` +
        `echo 'the updater uses it from its next check'; }; else echo 'the updater uses it once it runs'; fi`,
    { input: Buffer.from(`${token}\n`) });
    return r.status;
}

/* --list and --remove need a deploy tool that keeps tokens as their own
 * entries (0.2.3): an older one lists nothing and removes its single token
 * whatever id it is given. */
const TOKENS_DEPLOY = `/usr/bin/node -e "var v=require('/var/opt/mgu-deploy/current/component.json').version.split('.').map(Number);` +
    `process.exit(v[0]>0||v[1]>2||(v[1]===2&&v[2]>=3)?0:3)" || ` +
    `{ echo 'the deploy tool on the unit is older than 0.2.3: install its update from the Store first' >&2; exit 2; }; `;

async function tokenCommand(o) {
    // no stdin: these read no token
    if (o.remove !== null && !/^[0-9a-f]{8}$/.test(o.remove)) {
        throw new Usage(`not a token id: ${o.remove}`);
    }
    const token = o.list || o.remove !== null ? null : await readToken('GitHub token for the updater (input hidden): ');
    await reach(o);
    if (o.list) {
        return ssh(o, `${TOKENS_DEPLOY}sh ${DEPLOY} updater-token --list${o.json ? ' --json' : ''}`, { input: Buffer.alloc(0) }).status;
    }
    if (o.remove !== null) {
        return ssh(o, `${TOKENS_DEPLOY}sh ${DEPLOY} updater-token --remove ${shQuote(o.remove)}`, { input: Buffer.alloc(0) }).status;
    }
    return addToken(o, token);
}

/* ---- usb-repo ------------------------------------------------------------------------------ */

/* A folder name under mgu-repo/: safe on FAT, exFAT and NTFS. */
function folderName(s) {
    const n = String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64) || 'repo';
    // names Windows reserves for devices
    return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/.test(n) ? `${n}-repo` : n;
}

/* A file name a catalog gives: one plain name, no folder. */
function plainName(s) {
    return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,200}$/.test(s) && !s.includes('..');
}

function title(members, base) {
    const get = (n) => {
        const m = members.find((x) => x.name === n);
        return m ? JSON.parse(m.data.toString('utf8')) : null;
    };
    try {
        const rhmi = base === 'source/' ? 'rhmiData/' : `${base}rhmiData/`;
        const app = get(`${rhmi}application.json`).application;
        const textId = app.entryPoints && app.entryPoints[0] && app.entryPoints[0].textId;
        const dirs = ['variantGroups/Common/texts'].concat((app.variantGroups || []).map((g) => String(g.stringsPath || '').replace(/^\.\//, '')));
        for (const d of dirs) {
            const t = get(`${rhmi}${d}/en_GB.json`);
            if (t && textId && typeof t[textId] === 'string' && t[textId]) {
                return t[textId];
            }
        }
    } catch (e) { /* no entry-point text */ }
    return null;
}

/* What a package file is, from its content: a tool kit (component.json),
 * a source package (mgu-app.json), or an app (package.json flat, under
 * package/, or a .mgu's source/). */
function describePackage(file, data) {
    let members;
    try {
        members = untgz(data);
    } catch (e) {
        throw new Usage(`${file}: not a gzipped tar`);
    }
    const json = (n) => {
        const m = members.find((x) => x.name === n);
        return m ? JSON.parse(m.data.toString('utf8')) : null;
    };
    const tool = json('component.json');
    if (tool) {
        if (tool.kind !== 'tool' || !/^[a-z0-9][a-z0-9-]*$/.test(tool.id || '') || !SEMVER.test(tool.version || '')) {
            throw new Usage(`${file}: component.json is not a tool kit's`);
        }
        return { id: tool.id, kind: 'tool', version: tool.version, title: tool.title || tool.id, description: tool.description || '',
            mguHmi: tool.mguHmi, mguProvides: tool.mguProvides };
    }
    const src = json('mgu-app.json');
    if (src) {
        if (!ID.test(src.id || '') || !SEMVER.test(src.version || '')) {
            throw new Usage(`${file}: mgu-app.json needs an id and an x.y.z version`);
        }
        const pkg = json(`${src.tree}/package.json`) || {};
        return { id: src.id, kind: 'app', version: src.version, title: title(members, `${src.tree}/`) || pkg.productName || src.id,
            description: typeof pkg.description === 'string' ? pkg.description : '', build: 'unit', mguHmi: src.mguHmi || pkg.mguHmi };
    }
    const base = ['package/', '', 'source/'].find((b) => members.some((m) => m.name === `${b}package.json`));
    if (base === undefined) {
        throw new Usage(`${file}: no component.json, mgu-app.json or package.json`);
    }
    const pkg = json(`${base}package.json`);
    // a root-service package (renderer, tether) installs as the tool of its name, providing its kind
    if (pkg.mguService !== undefined && ['renderer', 'tether'].indexOf(pkg.mguService) < 0) {
        throw new Usage(`${file}: a root-service package of an unknown kind (mguService renderer or tether)`);
    }
    if (!ID.test(pkg.name || '') || !SEMVER.test(pkg.version || '')) {
        throw new Usage(`${file}: package.json needs a lower-case name and an x.y.z version`);
    }
    return { id: pkg.name, kind: pkg.mguService ? 'tool' : 'app', version: pkg.version,
        title: title(members, base) || pkg.productName || pkg.name,
        description: typeof pkg.description === 'string' ? pkg.description : '', mgu: base === 'source/',
        mguHmi: pkg.mguHmi, mguProvides: pkg.mguService, service: !!pkg.mguService };
}

/* A catalog entry as the stick lists it: the source's fields, the artifact
 * at `file` beside catalog.json. */
function stickEntry(entry, file, data) {
    const e = Object.assign({}, entry, { artifact: { name: `${entry.id}@${entry.version}.tgz`, size: data.length, sha256: sha256(data), url: file } });
    Object.keys(e).forEach((k) => (e[k] === undefined || e[k] === null) && delete e[k]);
    return e;
}

/* Writes one source folder: files (name -> bytes) and catalog.json last,
 * at the stick's root (where the updater looks for no source), then in
 * the old folder's place. */
function writeFolder(dest, files, catalog) {
    const stick = path.dirname(path.dirname(dest));
    const tmp = path.join(stick, `.mgu-repo-${path.basename(dest)}.partial`);
    const old = path.join(stick, `.mgu-repo-${path.basename(dest)}.old`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    files.forEach((f) => {
        const to = path.join(tmp, ...f.name.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, f.data);
    });
    if (catalog) {
        const text = `${JSON.stringify(catalog, null, 2)}\n`;
        if (Buffer.byteLength(text) > STICK_JSON_MAX) {
            throw new Error(`${path.basename(dest)}: catalog.json over ${STICK_JSON_MAX} bytes, which the updater does not read`);
        }
        fs.writeFileSync(path.join(tmp, 'catalog.json'), text);
    }
    if (fs.existsSync(dest)) {
        fs.renameSync(dest, old);
    }
    fs.renameSync(tmp, dest);
    fs.rmSync(old, { recursive: true, force: true });
}

/* A published source (GitHub repo or catalog URL) as a stick folder. */
async function publishedFolder(components, commit, label) {
    const files = [];
    const entries = [];
    for (const c of components) {
        const data = await c.fetch();
        const file = c.file || c.entry.artifact.name;
        if (!plainName(file)) {
            throw new Error(`${label}: unusable artifact name ${file}`);
        }
        files.push({ name: file, data });
        entries.push(stickEntry(c.entry, file, data));
        say(`  ${c.entry.id} ${c.entry.version}  ${file}`);
    }
    return { files, catalog: Object.assign({ schema: 2 }, commit ? { commit } : {}, { components: entries }) };
}

/* A catalog.json at a URL, artifacts absolute or relative to it. */
async function urlComponents(url) {
    const catalog = parseCatalog((await get(url, { max: 4 << 20 })).toString('utf8'), url);
    return { commit: catalog.commit, components: catalog.components.map((entry) => ({ entry,
        fetch: () => get(new URL(entry.artifact.url || entry.artifact.name, url).toString(), { max: entry.artifact.size })
            .then((d) => checked(entry.artifact.name, d, entry.artifact.size, entry.artifact.sha256)) })) };
}

/* A folder with catalog.json (a dir: publish): its artifacts read beside it. */
function dirComponents(dir) {
    const catalog = parseCatalog(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'), path.join(dir, 'catalog.json'));
    return { commit: catalog.commit, components: catalog.components.map((entry) => {
        const rel = (entry.artifact.url || entry.artifact.name).replace(/^\.\//, '');
        if (/^https?:/.test(rel)) {
            return { entry, fetch: () => get(rel, { max: entry.artifact.size }).then((d) => checked(entry.artifact.name, d, entry.artifact.size, entry.artifact.sha256)) };
        }
        if (!plainName(path.posix.basename(rel)) || rel.split('/').includes('..')) {
            throw new Error(`${dir}: unusable artifact path ${rel}`);
        }
        const read = () => checked(entry.artifact.name, fs.readFileSync(path.join(dir, ...rel.split('/'))), entry.artifact.size, entry.artifact.sha256);
        return { entry, file: path.posix.basename(rel), read, fetch: () => Promise.resolve().then(read) };
    }) };
}

/* A checkout with mgu-repo.json: its files as they are in the repository
 * (git's tracked files when git is there), links and .git left out. */
function checkoutFiles(dir) {
    let names = null;
    if (fs.existsSync(path.join(dir, '.git'))) {
        const r = cp.spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
        names = r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null;
    }
    if (!names) {
        names = [];
        (function walk(rel) {
            fs.readdirSync(path.join(dir, ...rel.split('/').filter(Boolean))).sort().forEach((n) => {
                if (n === '.git' || n === 'node_modules' || n === '.DS_Store' || n.startsWith('._')) {
                    return;
                }
                const r2 = rel ? `${rel}/${n}` : n;
                const st = fs.lstatSync(path.join(dir, ...r2.split('/')));
                if (st.isDirectory()) {
                    walk(r2);
                } else if (st.isFile()) {
                    names.push(r2);
                }
            });
        }(''));
    }
    let total = 0;
    const files = names.filter((n) => {
        const st = fs.lstatSync(path.join(dir, ...n.split('/')), { throwIfNoEntry: false });
        return st && st.isFile() && !n.split('/').some((s) => s === '.DS_Store' || s.startsWith('._'));
    }).map((n) => {
        const data = fs.readFileSync(path.join(dir, ...n.split('/')));
        total += data.length;
        return { name: n, data };
    });
    if (total > STICK_REPO_MAX || files.length > STICK_REPO_FILES) {
        throw new Error(`${dir}: over ${STICK_REPO_MAX} bytes or ${STICK_REPO_FILES} files, more than the updater reads from a folder`);
    }
    return files;
}

/* The stick's mgu-repo/local/ catalog with the given package files added:
 * per id the higher version stays. */
function localFolder(dest, inputs) {
    const byId = new Map();
    if (fs.existsSync(path.join(dest, 'catalog.json'))) {
        try {
            dirComponents(dest).components.forEach((c) => {
                try {
                    byId.set(c.entry.id, { entry: c.entry, file: c.file, data: c.read() });
                } catch (e) {
                    say(`  ${c.entry.id} ${c.entry.version} left out: ${e.message}`);
                }
            });
        } catch (e) {
            say(`  ${path.join(dest, 'catalog.json')}: ${e.message}; written anew`);
        }
    }
    inputs.forEach(({ file, data }) => {
        const d = describePackage(file, data);
        const have = byId.get(d.id);
        if (have && compareVersions(have.entry.version, d.version) > 0) {
            say(`  ${d.id} ${have.entry.version} stays (${path.basename(file)} is ${d.version})`);
            return;
        }
        if (d.mguHmi !== undefined && (!Array.isArray(d.mguHmi) || !d.mguHmi.length ||
            d.mguHmi.some((h, i) => ['ID7', 'ID8'].indexOf(h) < 0 || d.mguHmi.indexOf(h) !== i))) {
            throw new Usage(`${file}: mguHmi must list "ID7" and/or "ID8"`);
        }
        if (d.mguProvides !== undefined && !(d.kind === 'tool' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(d.mguProvides))) {
            throw new Usage(`${file}: mguProvides is one lower-case name, for a tool`);
        }
        const entry = { id: d.id, kind: d.kind, title: d.title, description: d.description, version: d.version,
            build: d.build, uninstallable: d.kind === 'app' || d.service ? true : undefined, mguHmi: d.mguHmi, mguProvides: d.mguProvides,
            // the deploy tool that installs a service package as a tool
            requires: d.service ? { 'mgu-deploy': '0.4.0' } : undefined };
        byId.set(d.id, { entry, file: `${d.id}@${d.version}.${d.mgu ? 'mgu' : 'tgz'}`, data });
        say(`  ${d.id} ${d.version}  ${path.basename(file)}`);
    });
    const rows = Array.from(byId.values()).sort((a, b) => (a.entry.id < b.entry.id ? -1 : 1));
    return { files: rows.map((x) => ({ name: x.file, data: x.data })),
        catalog: { schema: 2, components: rows.map((x) => stickEntry(x.entry, x.file, x.data)) } };
}

/* The marker the updater reads a stick folder's source from: it updates
 * what that source installed (native/mgu-updater/README.md, "Ids"). */
function copyOf(source) {
    return { name: 'mgu-copy.json', data: Buffer.from(`${JSON.stringify({ copyOf: source })}\n`) };
}

/* The GitHub repository a checkout's origin remote names (owner/repo), or null. */
function githubOrigin(dir) {
    const r = cp.spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true });
    const m = r.status === 0 && /github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?\s*$/.exec(r.stdout);
    return m ? m[1] : null;
}

async function usbRepo(o) {
    const stick = path.resolve(o.stick);
    if (!fs.existsSync(stick) || !fs.statSync(stick).isDirectory()) {
        throw new Usage(`not a folder: ${o.stick}`);
    }
    const inputs = o.inputs.length ? o.inputs : [`github:${STORE_REPO}`];
    const repoDir = path.join(stick, 'mgu-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    const names = new Set();
    const unique = (n) => {
        let name = n;
        for (let i = 2; names.has(name) || name === 'local'; i += 1) {
            name = `${n}-${i}`;
        }
        names.add(name);
        return name;
    };
    const packages = [];
    for (const input of inputs) {
        if (input.startsWith('github:')) {
            const repo = input.slice('github:'.length);
            const name = unique(folderName(repo.split('/')[1] || repo));
            say(`${input} -> mgu-repo/${name}/`);
            const gh = await githubRepo(repo, null);
            const { commit, components } = await githubComponents(gh);
            const out = await publishedFolder(components, commit, input);
            writeFolder(path.join(repoDir, name), out.files.concat([copyOf(input)]), out.catalog);
        } else if (/^https?:\/\//.test(input)) {
            const u = checkUrl(input);
            const name = unique(folderName(`${u.hostname}-${path.posix.basename(path.posix.dirname(u.pathname)) || 'catalog'}`));
            say(`${input} -> mgu-repo/${name}/`);
            const { commit, components } = await urlComponents(u.toString());
            const out = await publishedFolder(components, commit, input);
            writeFolder(path.join(repoDir, name), out.files.concat([copyOf(u.toString())]), out.catalog);
        } else if (fs.existsSync(input) && fs.statSync(input).isDirectory()) {
            const dir = path.resolve(input);
            if (dir === stick || dir.startsWith(repoDir + path.sep)) {
                throw new Usage(`${input}: a folder on the stick itself`);
            }
            const name = unique(folderName(path.basename(dir)));
            say(`${input} -> mgu-repo/${name}/`);
            if (fs.existsSync(path.join(dir, 'catalog.json'))) {
                const { commit, components } = dirComponents(dir);
                const out = await publishedFolder(components, commit, input);
                writeFolder(path.join(repoDir, name), out.files, out.catalog);
            } else if (fs.existsSync(path.join(dir, 'mgu-repo.json'))) {
                const gh = githubOrigin(dir);
                writeFolder(path.join(repoDir, name), checkoutFiles(dir).concat(gh ? [copyOf(`github:${gh}`)] : []), null);
                say(`  a repository checkout${gh ? ` of ${gh}` : ''}: the unit builds its components`);
            } else {
                throw new Usage(`${input}: no catalog.json or mgu-repo.json`);
            }
        } else if (fs.existsSync(input) && fs.statSync(input).isFile()) {
            packages.push({ file: input, data: fs.readFileSync(input) });
        } else {
            throw new Usage(`not a github:<owner>/<repo>, an https:// catalog URL, a folder or a package file: ${input}`);
        }
    }
    if (packages.length) {
        say('package files -> mgu-repo/local/');
        const dest = path.join(repoDir, 'local');
        const out = localFolder(dest, packages);
        writeFolder(dest, out.files, out.catalog);
    }
    const folders = fs.readdirSync(repoDir).filter((n) => !n.startsWith('.') && fs.statSync(path.join(repoDir, n)).isDirectory());
    if (folders.length > 64) {
        say(`mgu-repo/ holds ${folders.length} folders; the updater reads the first 64 by name`);
    }
    say(`${stick}: the Store lists these while the stick is in the car`);
    return 0;
}

/* ---- command line ---------------------------------------------------------------------------- */

/* This script's text: the file, the copy a standalone executable carries
 * (deploy/installer), or null from stdin. */
function ownSource() {
    if (FROM_STDIN) {
        return null;
    }
    try {
        const sea = require('node:sea');
        if (sea.isSea()) {
            return sea.getAsset('mgu-install.js', 'utf8');
        }
    } catch (e) {
        // a Node without node:sea runs the file
    }
    return fs.readFileSync(__filename, 'utf8');
}

/* The header comment; from stdin there is no file to read it from. */
const SOURCE = ownSource();
const USAGE = SOURCE === null ? 'usage: deploy/README.md, "mgu-install"' : SOURCE.split('*/')[0].split('\n').slice(3)
    .map((l) => l.replace(/^ \* ?/, '')).join('\n').trimEnd();

function parse(argv) {
    const o = { command: argv[0], host: null, port: '22', bind: null, given: false, user: 'root', identity: null, sshOpts: [],
        noRenderer: false, noUplink: false, token: false, list: false, json: false, remove: null, from: null, rest: [] };
    const value = (i, flag) => {
        if (i >= argv.length) {
            throw new Usage(`${flag} needs a value`);
        }
        return argv[i];
    };
    for (let i = 1; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--host') o.host = value(++i, a);
        else if (a === '--port') o.port = value(++i, a);
        else if (a === '--user') o.user = value(++i, a);
        else if (a === '--identity') o.identity = value(++i, a);
        else if (a === '--ssh-opt') o.sshOpts.push(value(++i, a));
        else if (a === '--no-renderer' && o.command === 'first-install') o.noRenderer = true;
        else if (a === '--no-uplink' && o.command === 'first-install') o.noUplink = true;
        else if (a === '--token' && o.command === 'first-install') o.token = true;
        else if (a === '--from' && o.command === 'first-install') o.from = value(++i, a);
        else if (a === '--list' && o.command === 'token') o.list = true;
        else if (a === '--json' && o.command === 'token') o.json = true;
        else if (a === '--remove' && o.command === 'token') o.remove = value(++i, a);
        else if (a.startsWith('--')) throw new Usage(`unknown option ${a} for ${o.command}\n${USAGE}`);
        else o.rest.push(a);
    }
    // a target named: no detection
    o.given = argv.slice(1).some((a) => ['--host', '--port'].includes(a));
    if (!/^\d+$/.test(o.port)) {
        throw new Usage(`--port needs a number: ${o.port}`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(o.user) || (o.host !== null && !/^[A-Za-z0-9.:%_[\]-]+$/.test(o.host))) {
        throw new Usage('--user and --host take a plain name or address');
    }
    if (o.list && o.remove !== null) {
        throw new Usage('token takes --list or --remove, not both');
    }
    if (o.json && !o.list) {
        throw new Usage('--json goes with token --list');
    }
    return o;
}

async function main(argv) {
    const o = parse(argv);
    if (!o.command || o.command === 'help' || o.command === '--help') {
        say(USAGE);
        return 0;
    }
    if (Number(process.versions.node.split('.')[0]) < 18) {
        throw new Usage(`Node 18 or newer is needed (this is ${process.version})`);
    }
    if (o.command === 'first-install' || o.command === 'token') {
        if (o.rest.length) {
            throw new Usage(`${o.command} takes no ${o.rest[0]}`);
        }
        return o.command === 'first-install' ? firstInstall(o) : tokenCommand(o);
    }
    if (o.command === 'usb-repo') {
        if (!o.rest.length) {
            throw new Usage('usage: node mgu-install.js usb-repo <stick folder> [<input>...]');
        }
        return usbRepo(Object.assign(o, { stick: o.rest[0], inputs: o.rest.slice(1) }));
    }
    throw new Usage(`unknown command ${o.command}\n${USAGE}`);
}

if (require.main === module || FROM_STDIN) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }, (e) => {
        process.stderr.write(`mgu-install: ${e.message}\n`);
        process.exitCode = e instanceof Usage ? 2 : 1;
    });
}

module.exports = { tgz, untgz, sshArgs, folderName, plainName, parse, SOURCES, sshBanner, enetInterfaces, hsfzFrame, hsfzFrames,
    didAddress, hsfzGateway, hsfzHuAddress, findUnit, reach };
