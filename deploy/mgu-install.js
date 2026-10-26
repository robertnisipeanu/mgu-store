#!/usr/bin/env node
'use strict';
/**
 * mgu-install: sets up the Store on a head unit over SSH, and makes USB
 * sticks the Store installs and updates from without internet. One file,
 * no dependencies: Node 18 or newer and the system's OpenSSH client, on
 * Windows, macOS or Linux (deploy/README.md, "mgu-install").
 *
 *   node mgu-install.js first-install [--with-uplink] [--token] [<ssh options>]
 *   node mgu-install.js token [--list | --remove <id>] [<ssh options>]
 *   node mgu-install.js usb-repo <stick folder> [<input>...]
 *
 * first-install downloads the newest published mgu-store release (the
 * deploy tool, app-privacy, the updater, the Store's source package; with
 * --with-uplink the internet uplink), checks each file against the
 * catalog's size and sha256, sends them to the unit and installs them with
 * the release's own deploy tool, which builds the Store on the unit. Newer
 * installed components are kept; running it again is safe. --token adds a
 * GitHub token for the updater afterwards.
 *
 * token adds a GitHub token for the updater (no option), lists the tokens
 * (--list) or removes one (--remove <id>). A token is read from a hidden
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
 * SSH options: --host <address> (172.16.222.97, the car's hotspot),
 * --port <n> (22), --user <name> (root), --identity <key file>, and
 * --ssh-opt <option> (repeatable, passed as ssh -o <option>).
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

const STORE_REPO = 'robertnisipeanu/mgu-store';
const GITHUB_API = process.env.MGU_INSTALL_GITHUB_API || 'https://api.github.com';
const HOTSPOT_IP = '172.16.222.97';
/* the updater's sources first-install seeds when it has none (deploy/sources.json) */
const SOURCES = { schema: 1, sources: [{ id: 'mgu-store', type: 'github', repo: STORE_REPO, builtin: true }] };
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

/* A line typed at the terminal, not echoed. */
function promptHidden(question) {
    return new Promise((resolve, reject) => {
        const input = process.stdin;
        process.stderr.write(question);
        input.setRawMode(true);
        input.setEncoding('utf8');
        input.resume();
        let text = '';
        const end = (err) => {
            input.removeListener('data', onData);
            input.setRawMode(false);
            input.pause();
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
async function readToken(question) {
    let text;
    if (process.stdin.isTTY) {
        text = await promptHidden(question);
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
        () => (process.stdin.isTTY ? readToken(`GitHub token for ${repo} (input hidden): `) : null)];
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

/* ssh's arguments for one remote command: the owner's -o options first
 * (ssh takes the first value of an option). */
function sshArgs(o, remote) {
    const args = ['-p', String(o.port)];
    o.sshOpts.forEach((x) => args.push('-o', x));
    if (o.identity) {
        args.push('-i', o.identity, '-o', 'IdentitiesOnly=yes');
    }
    return args.concat(rsaOpts(), [`${o.user}@${o.host}`, remote]);
}

/* Runs remote on the unit; input on its stdin; capture: its stdout returned. */
function ssh(o, remote, { input, capture } = {}) {
    const r = cp.spawnSync('ssh', sshArgs(o, remote), {
        input, maxBuffer: 64 << 20, windowsHide: true,
        stdio: [input ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit', 'inherit']
    });
    if (r.error) {
        throw new Error(r.error.code === 'ENOENT' ? 'no ssh command found; install the OpenSSH client' : `ssh: ${r.error.message}`);
    }
    if (r.status === 255) {
        throw new Error(`ssh to ${o.user}@${o.host}:${o.port} failed`);
    }
    return { status: r.status === null ? 1 : r.status, stdout: capture ? String(r.stdout) : '' };
}

/* ---- first-install ---------------------------------------------------------------------- */

/* On the unit, in the staging folder: the release's deploy tool installs
 * every artifact (itself among them; newer installed ones kept) and seeds
 * the updater's sources when it has none. */
const RUN_SH = `set -e
S=$(cd "$(dirname "$0")" && pwd)
set --
for f in "$S"/artifacts/*.tgz; do set -- "$@" --artifact "$f"; done
sh "$S/mgu-deploy.sh" install "$@" --skip-older --yes
sh "$S/mgu-deploy.sh" updater-sources < "$S/sources.json"
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

async function firstInstall(o) {
    const token = o.token ? await readToken('GitHub token for the updater (input hidden): ') : null;
    const gh = await githubRepo(STORE_REPO, token);
    const { components } = await githubComponents(gh);
    const chosen = components.filter((c) => !c.entry.optional || (o.withUplink && c.entry.id === 'mgu-uplink'));
    if (o.withUplink && !chosen.some((c) => c.entry.id === 'mgu-uplink')) {
        throw new Error(`${STORE_REPO}: the catalog has no mgu-uplink`);
    }
    if (!chosen.some((c) => c.entry.id === 'mgu-deploy')) {
        throw new Error(`${STORE_REPO}: the catalog has no mgu-deploy`);
    }
    const artifacts = [];
    for (const c of chosen) {
        const data = await c.fetch();
        say(`  ${sha256(data)}  ${c.entry.artifact.name}`);
        artifacts.push({ entry: c.entry, data });
    }
    const deploy = artifacts.find((a) => a.entry.id === 'mgu-deploy');
    const entries = deployToolFiles(deploy.data)
        .concat(artifacts.map((a) => ({ name: `artifacts/${a.entry.artifact.name}`, data: a.data, mode: 0o644 })))
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
    const services = ['mgu-updater.service'].concat(o.withUplink ? ['mgu-uplink.service'] : []);
    // the status on stderr, shown as it comes; which services run on stdout
    const st = ssh(o, [`sh ${DEPLOY} status >&2`].concat(services.map((s) => `systemctl is-active ${s} 2>/dev/null || true`)).join('; '),
        { capture: true });
    const down = services.filter((s, i) => (st.stdout.split('\n')[i] || '').trim() !== 'active')
        .map((s) => (s === 'mgu-updater.service' ? 'the updater' : 'the uplink'));
    say(down.length ? `Restart the head unit to finish setup (a normal ignition cycle does it): ${down.join(' and ')} ${down.length > 1 ? 'start' : 'starts'} then.` :
        'Setup is done: the Store installs and updates everything from here on.');
    return 0;
}

/* ---- token -------------------------------------------------------------------------------- */

/* Adds a token through the deploy tool (on stdin); a running updater reads
 * its sources again with it. */
function addToken(o, token) {
    const r = ssh(o, `sh ${DEPLOY} updater-token && if systemctl is-active mgu-updater.service >/dev/null 2>&1; then ` +
        `{ /usr/bin/node ${UPDATER_JS} check >/dev/null 2>&1 && echo 'the updater read its sources with it' || ` +
        `echo 'the updater uses it from its next check'; }; fi`,
    { input: Buffer.from(`${token}\n`) });
    return r.status;
}

async function tokenCommand(o) {
    if (o.list) {
        return ssh(o, `sh ${DEPLOY} updater-token --list`).status;
    }
    if (o.remove !== null) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(o.remove)) {
            throw new Usage(`not a token id: ${o.remove}`);
        }
        return ssh(o, `sh ${DEPLOY} updater-token --remove ${shQuote(o.remove)}`).status;
    }
    return addToken(o, await readToken('GitHub token for the updater (input hidden): '));
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
        return { id: tool.id, kind: 'tool', version: tool.version, title: tool.title || tool.id, description: tool.description || '' };
    }
    const src = json('mgu-app.json');
    if (src) {
        if (!ID.test(src.id || '') || !SEMVER.test(src.version || '')) {
            throw new Usage(`${file}: mgu-app.json needs an id and an x.y.z version`);
        }
        const pkg = json(`${src.tree}/package.json`) || {};
        return { id: src.id, kind: 'app', version: src.version, title: title(members, `${src.tree}/`) || pkg.productName || src.id,
            description: typeof pkg.description === 'string' ? pkg.description : '', build: 'unit' };
    }
    const base = ['package/', '', 'source/'].find((b) => members.some((m) => m.name === `${b}package.json`));
    if (base === undefined) {
        throw new Usage(`${file}: no component.json, mgu-app.json or package.json`);
    }
    const pkg = json(`${base}package.json`);
    if (pkg.mguService !== undefined) {
        throw new Usage(`${file}: a root-service package, not an app or a tool kit`);
    }
    if (!ID.test(pkg.name || '') || !SEMVER.test(pkg.version || '')) {
        throw new Usage(`${file}: package.json needs a lower-case name and an x.y.z version`);
    }
    return { id: pkg.name, kind: 'app', version: pkg.version, title: title(members, base) || pkg.productName || pkg.name,
        description: typeof pkg.description === 'string' ? pkg.description : '', mgu: base === 'source/' };
}

/* A catalog entry as the stick lists it: the source's fields, the artifact
 * at `file` beside catalog.json. */
function stickEntry(entry, file, data) {
    const e = Object.assign({}, entry, { artifact: { name: `${entry.id}@${entry.version}.tgz`, size: data.length, sha256: sha256(data), url: file } });
    Object.keys(e).forEach((k) => (e[k] === undefined || e[k] === null) && delete e[k]);
    return e;
}

/* Writes one source folder: files (name -> bytes) and catalog.json last,
 * beside the old folder, then in its place. */
function writeFolder(dest, files, catalog) {
    const parent = path.dirname(dest);
    const tmp = path.join(parent, `.${path.basename(dest)}.partial`);
    const old = path.join(parent, `.${path.basename(dest)}.old`);
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
        const entry = { id: d.id, kind: d.kind, title: d.title, description: d.description, version: d.version,
            build: d.build, uninstallable: d.kind === 'app' ? true : undefined };
        byId.set(d.id, { entry, file: `${d.id}@${d.version}.${d.mgu ? 'mgu' : 'tgz'}`, data });
        say(`  ${d.id} ${d.version}  ${path.basename(file)}`);
    });
    const rows = Array.from(byId.values()).sort((a, b) => (a.entry.id < b.entry.id ? -1 : 1));
    return { files: rows.map((x) => ({ name: x.file, data: x.data })),
        catalog: { schema: 2, components: rows.map((x) => stickEntry(x.entry, x.file, x.data)) } };
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
            writeFolder(path.join(repoDir, name), out.files, out.catalog);
        } else if (/^https?:\/\//.test(input)) {
            const u = checkUrl(input);
            const name = unique(folderName(`${u.hostname}-${path.posix.basename(path.posix.dirname(u.pathname)) || 'catalog'}`));
            say(`${input} -> mgu-repo/${name}/`);
            const { commit, components } = await urlComponents(u.toString());
            const out = await publishedFolder(components, commit, input);
            writeFolder(path.join(repoDir, name), out.files, out.catalog);
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
                writeFolder(path.join(repoDir, name), checkoutFiles(dir), null);
                say('  a repository checkout: the unit builds its components');
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
    say(`${stick}: the Store lists these while the stick is in the car`);
    return 0;
}

/* ---- command line ---------------------------------------------------------------------------- */

const USAGE = fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(3)
    .map((l) => l.replace(/^ \* ?/, '')).join('\n').trimEnd();

function parse(argv) {
    const o = { command: argv[0], host: HOTSPOT_IP, port: '22', user: 'root', identity: null, sshOpts: [],
        withUplink: false, token: false, list: false, remove: null, rest: [] };
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
        else if (a === '--with-uplink' && o.command === 'first-install') o.withUplink = true;
        else if (a === '--token' && o.command === 'first-install') o.token = true;
        else if (a === '--list' && o.command === 'token') o.list = true;
        else if (a === '--remove' && o.command === 'token') o.remove = value(++i, a);
        else if (a.startsWith('--')) throw new Usage(`unknown option ${a} for ${o.command}\n${USAGE}`);
        else o.rest.push(a);
    }
    if (!/^\d+$/.test(o.port)) {
        throw new Usage(`--port needs a number: ${o.port}`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(o.user) || !/^[A-Za-z0-9.:%_[\]-]+$/.test(o.host)) {
        throw new Usage('--user and --host take a plain name or address');
    }
    if (o.list && o.remove !== null) {
        throw new Usage('token takes --list or --remove, not both');
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

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }, (e) => {
        process.stderr.write(`mgu-install: ${e.message}\n`);
        process.exitCode = e instanceof Usage ? 2 : 1;
    });
}

module.exports = { tgz, untgz, sshArgs, shQuote, folderName, plainName, describePackage, parse, RUN_SH, SOURCES };
