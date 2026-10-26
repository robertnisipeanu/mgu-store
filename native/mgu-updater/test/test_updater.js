'use strict';
/**
 * Offline tests of mgu-updater on the head unit's Node 8.16.2, as root
 * (test/run.sh runs them in Docker):
 *  - catalog: parsing (schema 1 and 2), rejection of malformed entries, the plan;
 *  - fetch.js: HTTPS through a given DNS server, redirects that drop the
 *    token, size limits, running as the fetch uid;
 *  - the daemon under its supervisor, against an HTTPS catalog and a stand-in
 *    deploy tool: install an app, update itself, return to the previous
 *    version when a new one crashes or never comes up, refuse a download
 *    that does not match the catalog, report a failed install, offline;
 *  - the reboot request: refused while an install runs or waits, the
 *    command run once, its failure and a unit that stays up reported;
 *  - sources (an updater in this process, against a fake GitHub on the same
 *    HTTPS server): several sources and id collisions, tokens of their own
 *    (one reaching two private repos, a second for a third, a public repo
 *    read without one, removal, tokens the deploy tool writes, per-source
 *    files of 0.2 converted), GitHub device sign-in, catalog / releases / repo-tree
 *    layouts on the releases, branch and tags channels, a branch commit
 *    that moves, repo build scripts (built, failing, too slow, writing
 *    outside), requirements installed first, uninstall, USB media, the
 *    privileged requests and their secret files, a first start without
 *    sources.json, and the Store 0.3's view of the state.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const https = require('https');
const crypto = require('crypto');
const cp = require('child_process');
const { URL } = require('url');
const catalogLib = require('../js/catalog');
const { UpdaterClient } = require('../js/client');

const ROOT = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-updater-test-'));
fs.chmodSync(T, 0o755); // the fetch uid reaches its folder through it, as through /var/opt
const FETCH_UID = 12990;
const HTTPS_PORT = 8443;
const DNS_PORT = 5300;
// a restart the unit has not carried out by then is reported as failed
process.env.MGU_UPDATER_REBOOT_WAIT_MS = '3000';
let failures = 0;
let passes = 0;

function ok(name, cond, detail) {
    if (cond) {
        passes += 1;
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
    }
}

function sh(cmd) {
    return cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function mkdirp(d) {
    if (!fs.existsSync(d)) {
        mkdirp(path.dirname(d));
        fs.mkdirSync(d);
    }
}

/* ---- fixtures ---------------------------------------------------------------- */

function makeCerts() {
    const d = path.join(T, 'pki');
    mkdirp(d);
    sh(`cd ${d} && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=test-ca -keyout ca.key -out ca.pem 2>&1 &&
        openssl req -newkey rsa:2048 -nodes -subj /CN=updates.test -keyout srv.key -out srv.csr 2>&1 &&
        printf 'subjectAltName=DNS:updates.test,DNS:other.test,DNS:api.github.com,DNS:github.com,DNS:codeload.github.com\\n' > ext &&
        openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile ext -out srv.pem 2>&1`);
    return { ca: fs.readFileSync(path.join(d, 'ca.pem'), 'utf8'), key: fs.readFileSync(path.join(d, 'srv.key')), cert: fs.readFileSync(path.join(d, 'srv.pem')) };
}

/* A DNS server that answers A queries for *.test and the GitHub names with 127.0.0.1. */
function startDns() {
    const s = dgram.createSocket('udp4');
    s.on('message', (q, rinfo) => {
        let i = 12;
        const labels = [];
        while (q[i]) {
            labels.push(q.slice(i + 1, i + 1 + q[i]).toString());
            i += q[i] + 1;
        }
        const question = q.slice(12, i + 5);
        const known = /\.test$|(^|\.)github\.com$/.test(labels.join('.'));
        const header = Buffer.from([q[0], q[1], 0x81, known ? 0x80 : 0x83, 0, 1, 0, known ? 1 : 0, 0, 0, 0, 0]);
        const answer = known ? Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]) : Buffer.alloc(0);
        s.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
    });
    return new Promise((r) => s.bind(DNS_PORT, '127.0.0.1', () => r(s)));
}

const seen = [];

/* ---- a fake GitHub (api.github.com, github.com, codeload.github.com) ---------- */

const API = `https://api.github.com:${HTTPS_PORT}`;
const GH_WEB = `https://github.com:${HTTPS_PORT}`;
const gh = { repos: {}, users: { 'tok-all': 'tester', 'tok-third': 'other-acct', 'tok-device': 'tester' }, polls: 0, refreshes: 0, device: null,
    deviceExpired: false };

/* A repo: private ones answer only to one of their tokens (404 without, 401
 * with a wrong one). trees: commit sha -> { path: [data, mode] }. */
function ghRepo(name, opts) {
    gh.repos[name] = Object.assign({ private: false, tokens: [], default_branch: 'main', catalog: null, releases: [],
        branches: {}, tags: [], trees: {} }, opts);
    return gh.repos[name];
}

/* A commit of files ({ path: content | [content, mode] }); returns its sha. */
function ghCommit(repo, files) {
    const tree = {};
    Object.keys(files).forEach((p) => {
        const f = Array.isArray(files[p]) ? files[p] : [files[p], 0o644];
        tree[p] = [Buffer.from(f[0]), f[1]];
    });
    const sha = sha256(Buffer.from(JSON.stringify(Object.keys(tree)) + Math.random())).slice(0, 40);
    gh.repos[repo].trees[sha] = tree;
    return sha;
}

function ghTarball(repo, sha) {
    const top = `${repo.replace('/', '-')}-${sha.slice(0, 7)}`;
    const dir = path.join(T, 'gh-tar', sha);
    if (fs.existsSync(`${dir}.tgz`)) {
        return fs.readFileSync(`${dir}.tgz`);
    }
    const tree = gh.repos[repo].trees[sha];
    Object.keys(tree).forEach((p) => {
        mkdirp(path.dirname(path.join(dir, top, p)));
        fs.writeFileSync(path.join(dir, top, p), tree[p][0]);
        fs.chmodSync(path.join(dir, top, p), tree[p][1]);
    });
    // a link in the repo goes nowhere
    fs.symlinkSync('/etc/passwd', path.join(dir, top, 'link-out'));
    sh(`tar -czf ${dir}.tgz -C ${dir} ${top}`);
    return fs.readFileSync(`${dir}.tgz`);
}

function ghApi(req, res, auth) {
    const u = new URL(req.url, API);
    const send = (code, body, headers) => {
        const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        res.writeHead(code, Object.assign({ 'Content-Length': data.length }, headers || {}));
        res.end(data);
    };
    if (u.pathname === '/user') {
        const token = auth && auth.replace(/^Bearer /, '');
        // an expired sign-in token is refused until it is renewed
        const login = token && !(token === 'tok-device' && gh.deviceExpired) && gh.users[token];
        // a classic token's scopes; a GitHub App's (device flow) has none
        send(login ? 200 : 401, login ? { login } : { message: 'Bad credentials' }, login && token !== 'tok-device' ? { 'X-OAuth-Scopes': 'repo' } : {});
        return;
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
    const repo = m && gh.repos[m[1]];
    if (!repo) {
        send(404, { message: 'Not Found' });
        return;
    }
    // a token GitHub does not know: 401; one without access to a private repo: 404, as GitHub answers
    const known = auth && gh.users[auth.replace(/^Bearer /, '')];
    if (auth && !known) {
        send(401, { message: 'Bad credentials' });
        return;
    }
    if (repo.private && !(auth && repo.tokens.indexOf(auth.replace(/^Bearer /, '')) >= 0)) {
        send(404, { message: 'Not Found' });
        return;
    }
    const rest = m[2] || '';
    const assetUrl = (name) => `${API}/repos/${m[1]}/releases/assets/${encodeURIComponent(name)}`;
    if (!rest) {
        send(200, { full_name: m[1], default_branch: repo.default_branch, private: repo.private });
    } else if (rest === '/releases/tags/catalog') {
        if (repo.catalog) {
            send(200, { assets: [{ name: 'catalog.json', url: assetUrl('catalog.json'), size: repo.catalog.length }] });
        } else {
            send(404, { message: 'Not Found' });
        }
    } else if (rest.indexOf('/releases/assets/') === 0) {
        const name = decodeURIComponent(rest.slice('/releases/assets/'.length));
        let data = name === 'catalog.json' ? repo.catalog : null;
        repo.releases.forEach((r) => r.assets.forEach((x) => {
            if (x.name === name) {
                data = x.data;
            }
        }));
        if (!data && repo.files && repo.files[name]) {
            data = repo.files[name];
        }
        send(data ? 200 : 404, data || { message: 'Not Found' });
    } else if (rest === '/releases') {
        const n = Number(u.searchParams.get('per_page')) || 30;
        // the catalog release is a release too
        const all = (repo.catalog ? [{ assets: [{ name: 'catalog.json', data: repo.catalog }] }] : []).concat(repo.releases);
        send(200, all.slice(0, n).map((r) => ({ draft: !!r.draft, prerelease: !!r.prerelease,
            assets: r.assets.map((x) => ({ name: x.name, size: x.data.length, url: assetUrl(x.name) })) })));
    } else if (rest.indexOf('/commits/') === 0) {
        const sha = repo.branches[decodeURIComponent(rest.slice('/commits/'.length))];
        send(sha ? 200 : 422, sha ? { sha } : { message: 'No commit found' });
    } else if (rest === '/tags') {
        send(200, repo.tags.map((t) => ({ name: t.name, commit: { sha: t.sha } })));
    } else if (rest.indexOf('/contents/') === 0) {
        const tree = repo.trees[u.searchParams.get('ref')];
        const f = tree && tree[decodeURIComponent(rest.slice('/contents/'.length))];
        // the raw media type gets the bytes; anything else the JSON object around them, as GitHub does
        const rawWanted = /^application\/vnd\.github(\.v3)?\.raw/.test(req.headers.accept || '');
        send(f ? 200 : 404, !f ? { message: 'Not Found' } : rawWanted ? f[0] : { type: 'file', encoding: 'base64', content: f[0].toString('base64') });
    } else if (rest.indexOf('/tarball/') === 0) {
        const sha = rest.slice('/tarball/'.length);
        // GitHub refuses a tarball request that accepts only application/octet-stream
        if (/^application\/octet-stream$/.test(req.headers.accept || '')) {
            send(415, { message: 'Unsupported \'Accept\' header' });
            return;
        }
        send(302, '', { Location: `https://codeload.github.com:${HTTPS_PORT}/${m[1]}/legacy.tar.gz/${sha}` });
    } else {
        send(404, { message: 'Not Found' });
    }
}

/* github.com: the device flow. A code is pending, then slow_down, then the token. */
function ghWeb(req, res, body) {
    const f = {};
    body.split('&').filter(Boolean).forEach((kv) => {
        const [k, v] = kv.split('=');
        f[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    let out;
    if (req.method === 'POST' && req.url === '/login/device/code' && f.client_id === 'Iv1.test') {
        gh.polls = 0;
        out = { device_code: 'dc-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 };
    } else if (req.method === 'POST' && req.url === '/login/oauth/access_token' && f.client_id === 'Iv1.test' &&
        f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && f.device_code === 'dc-1') {
        gh.polls += 1;
        out = gh.device || (gh.polls === 1 ? { error: 'authorization_pending' } : gh.polls === 2 ? { error: 'slow_down', interval: 1 } :
            { access_token: 'tok-device', token_type: 'bearer', expires_in: 28800, refresh_token: 'refresh-1', refresh_token_expires_in: 15811200 });
    } else if (req.method === 'POST' && req.url === '/login/oauth/access_token' && f.grant_type === 'refresh_token' && f.refresh_token === 'refresh-1') {
        gh.refreshes += 1;
        gh.deviceExpired = false;
        out = { access_token: 'tok-device', expires_in: 28800, refresh_token: 'refresh-1' };
    } else {
        out = { error: 'bad_request' };
    }
    const data = Buffer.from(JSON.stringify(out));
    res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': 'application/json' });
    res.end(data);
}

function startHttps(certs, dir) {
    const srv = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const host = String(req.headers.host).replace(/:\d+$/, '');
            const auth = req.headers.authorization || null;
            seen.push({ host: req.headers.host, url: req.url, auth, method: req.method });
            if (host === 'api.github.com') {
                // a repo's delayMs holds its answers back: a read stays under way
                const m = /^\/repos\/([^/]+\/[^/?]+)/.exec(req.url);
                setTimeout(() => ghApi(req, res, auth), (m && gh.repos[m[1]] && gh.repos[m[1]].delayMs) || 0);
                return;
            }
            if (host === 'github.com') {
                ghWeb(req, res, body);
                return;
            }
            if (host === 'codeload.github.com') {
                const m = /^\/([^/]+\/[^/]+)\/legacy\.tar\.gz\/([0-9a-f]+)$/.exec(req.url);
                const data = m && gh.repos[m[1]] && gh.repos[m[1]].trees[m[2]] ? ghTarball(m[1], m[2]) : null;
                res.writeHead(data ? 200 : 404, { 'Content-Length': data ? data.length : 0 });
                res.end(data || '');
                return;
            }
            if (req.url === '/redirect') {
                res.writeHead(302, { Location: `https://other.test:${HTTPS_PORT}/payload.bin` });
                res.end();
                return;
            }
            if (req.url.indexOf('/private/') === 0 && auth !== 'Bearer tok-https') {
                res.writeHead(401);
                res.end();
                return;
            }
            const file = path.join(dir, path.basename(req.url));
            if (!fs.existsSync(file)) {
                res.writeHead(404);
                res.end();
                return;
            }
            const data = fs.readFileSync(file);
            res.writeHead(200, { 'Content-Length': data.length });
            res.end(data);
        });
    });
    return new Promise((r) => srv.listen(HTTPS_PORT, '127.0.0.1', () => r(srv)));
}

/* A flat OAP app tgz: package.json at the root. */
function appTgz(dir, id, version) {
    const src = path.join(T, 'src', `${id}@${version}`);
    mkdirp(src);
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: id, version }));
    const out = path.join(dir, `${id}@${version}.tgz`);
    cp.execFileSync('tar', ['-czf', out, '-C', src, 'package.json']);
    return out;
}

/* A tool kit tgz in the deploy tool's layout: component.json + files/. */
function updaterKit(dir, version, variant) {
    const src = path.join(T, 'src', `mgu-updater@${version}`);
    const files = path.join(src, 'files');
    mkdirp(files);
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'component.json'), 'utf8'));
    c.version = version;
    c.files = c.files.filter((f) => fs.existsSync(path.join(ROOT, f.from)));
    c.files.forEach((f) => {
        fs.copyFileSync(path.join(ROOT, f.from), path.join(files, f.path));
        f.sha256 = sha256(fs.readFileSync(path.join(files, f.path)));
        delete f.from;
    });
    if (variant === 'crash') {
        fs.writeFileSync(path.join(files, 'updater.js'), 'process.exit(1);\n');
    } else if (variant === 'hang') {
        fs.writeFileSync(path.join(files, 'updater.js'), 'setInterval(() => {}, 1000);\n');
    } else if (variant === 'nofetch') {
        fs.writeFileSync(path.join(files, 'fetch.js'), 'process.exit(1);\n');
    }
    fs.writeFileSync(path.join(src, 'component.json'), JSON.stringify(c, null, 2));
    const out = path.join(dir, `mgu-updater@${version}.tgz`);
    sh(`tar -czf ${out} -C ${src} component.json files`);
    return out;
}

/* A tool kit with the given files ({path: [content, mode]}) and component.json fields. */
function toolKit(dir, id, version, files, extra) {
    const src = path.join(T, 'src', `${id}@${version}`);
    mkdirp(path.join(src, 'files'));
    const c = Object.assign({ id, kind: 'tool', version, files: [] }, extra || {});
    Object.keys(files).forEach((p) => {
        const [content, mode] = files[p];
        fs.writeFileSync(path.join(src, 'files', p), content);
        fs.chmodSync(path.join(src, 'files', p), mode);
        c.files.push({ path: p, mode: mode.toString(8).padStart(4, '0'), sha256: sha256(Buffer.from(content)) });
    });
    fs.writeFileSync(path.join(src, 'component.json'), JSON.stringify(c, null, 2));
    const out = path.join(dir, `${id}@${version}.tgz`);
    sh(`tar -czf ${out} -C ${src} component.json files`);
    return out;
}

/* The stand-in deploy tool as an installed tool: its mgu-deploy.sh runs fake_deploy.js. */
const DEPLOY_SH = `#!/bin/sh\nexec ${process.execPath} ${path.join(__dirname, 'fake_deploy.js')} "$@"\n`;
const BROKEN_DEPLOY_SH = '#!/bin/sh\nexit 3\n';

function entry(file, kind, title) {
    const name = path.basename(file);
    const [id, version] = name.replace(/\.tgz$/, '').split('@');
    const data = fs.readFileSync(file);
    return { id, kind, title, version, artifact: { name, size: data.length, sha256: sha256(data) } };
}

/* A catalog.json of entries in dir; extra: more top-level fields. */
function publish(dir, entries, extra) {
    const catalog = Object.assign({ schema: 1, commit: 'test', components: entries }, extra || {});
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2));
}

/* ---- catalog ------------------------------------------------------------------ */

/* What the updater ships: every module it loads, and no catalog key. */
function testShipped() {
    const { loadConf } = require('../js/updater');
    process.env.MGU_UPDATER_CONF = path.join(T, 'no-local.conf'); // the shipped defaults alone
    const conf = loadConf();
    delete process.env.MGU_UPDATER_CONF;
    const component = JSON.parse(fs.readFileSync(path.join(ROOT, 'component.json'), 'utf8'));
    const shipped = component.files.map((f) => f.path);
    const needed = [];
    fs.readdirSync(path.join(ROOT, 'js')).forEach((f) => {
        const text = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
        (text.match(/require\('\.\/([a-z_]+)'\)/g) || []).forEach((r) => needed.push(`${/'\.\/([a-z_]+)'/.exec(r)[1]}.js`));
    });
    ok('shipped: component.json installs every module the updater loads (the phone page\'s web.js is optional)',
        needed.filter((n) => n !== 'web.js').every((n) => shipped.indexOf(n) >= 0), JSON.stringify(needed));
    ok('shipped: component.json installs each file it names (web.js once the phone page is in this tree)',
        component.files.every((f) => f.path === 'web.js' || fs.existsSync(path.join(ROOT, f.from))) && shipped.indexOf('web.js') >= 0);
    ok('shipped: no catalog key and no signing settings',
        !shipped.some((f) => /\.pem$/.test(f)) && conf.public_key === undefined && conf.catalog === undefined &&
        !fs.readdirSync(ROOT).some((f) => /\.pem$/.test(f)));
    ok('shipped: sources, credentials, the build uid and the secrets have their places',
        conf.sources === '/var/opt/mgu-updater/sources.json' && conf.credentials_dir === '/var/opt/mgu-updater/credentials' &&
        conf.build_uid === '12995' && conf.web_uid === '12996' && conf.web_gid === '12202' && conf.web_port === '8470' &&
        conf.web_iface === 'wlan_bridge' && conf.web_secret === '/run/mgu-updater/web-secret' &&
        conf.usb_roots === '/media' && conf.store_app === 'robertn_store' && 'github_client_id' in conf);
}

function testCatalog() {
    const good = { schema: 1, commit: 'c', components: [
        { id: 'doom', kind: 'app', title: 'DOOM', version: '1.0.1', artifact: { name: 'doom@1.0.1.tgz', size: 3, sha256: 'a'.repeat(64) } },
        { id: 'mgu-uplink', kind: 'tool', title: 'Uplink', version: '0.2.0', artifact: { name: 'mgu-uplink@0.2.0.tgz', size: 3, sha256: 'b'.repeat(64) } }
    ] };
    ok('catalog: a well-formed catalog parses', catalogLib.parse(JSON.stringify(good)).components.length === 2);
    const parses = (mut) => {
        const c = JSON.parse(JSON.stringify(good));
        mut(c);
        try {
            return catalogLib.parse(JSON.stringify(c));
        } catch (e) {
            return null;
        }
    };
    const bad = (mut, name) => ok(`catalog: rejects ${name}`, parses(mut) === null);
    bad((c) => { c.schema = 3; }, 'an unknown schema');
    bad((c) => { c.components[0].version = '1.0'; }, 'a non-semver version');
    bad((c) => { c.components[0].artifact.name = '../../etc/passwd'; }, 'an artifact name that is not <id>@<version>.tgz');
    bad((c) => { c.components[0].artifact.sha256 = 'zz'; }, 'a malformed sha256');
    bad((c) => { c.components[1].id = 'doom'; }, 'a duplicate id');
    bad((c) => { c.components[0].kind = 'firmware'; }, 'an unknown kind');
    bad((c) => { c.components[0].id = '../x'; }, 'an id with a path');
    bad((c) => { c.schema = 2; c.components[0].requires = { 'mgu-uplink': '1.0' }; }, 'a requirement without an x.y.z version');
    bad((c) => { c.schema = 2; c.components[0].requires = { doom: '1.0.0' }; }, 'a component requiring itself');
    bad((c) => { c.schema = 2; c.components[1].build = 'unit'; }, 'a tool built on the unit');
    bad((c) => { c.schema = 2; c.components[0].optional = 'yes'; }, 'optional that is not true or false');
    const two = parses((c) => {
        c.schema = 2;
        Object.assign(c.components[0], { build: 'unit', requires: { 'mgu-uplink': '0.2.0' }, uninstallable: true });
        c.components[1].optional = true;
    });
    ok('catalog: schema 2 carries build, requires, optional and uninstallable', two &&
        two.components[0].build === 'unit' && two.components[0].requires['mgu-uplink'] === '0.2.0' &&
        two.components[0].uninstallable && !two.components[0].optional && two.components[1].optional && two.components[1].build === null);
    ok('catalog: a signature field is ignored', !!parses((c) => { c.signature = { alg: 'ecdsa-p256-sha256', value: 'not a signature' }; }));

    const r = (c) => ({ entry: catalogLib.checkExtras(Object.assign({}, c)), source: 's' });
    const rows = catalogLib.plan(good.components.map(r), [{ id: 'doom', kind: 'app', version: '1.0.0' }]);
    ok('plan: an older installed version is an update', rows[0].status === 'update' && rows[0].installed === '1.0.0');
    ok('plan: a missing component is available', rows[1].status === 'available' && rows[1].installed === null);
    ok('plan: a row names its source', rows[0].source === 's' && rows[0].build === null && rows[0].optional === false);
    ok('plan: same version is installed', catalogLib.plan(good.components.map(r), [{ id: 'doom', version: '1.0.1' }])[0].status === 'installed');
    ok('plan: a local build ahead of the catalog is newer', catalogLib.plan(good.components.map(r), [{ id: 'doom', version: '1.2.0' }])[0].status === 'newer');
    ok('versions compare numerically', catalogLib.compareVersions('1.10.0', '1.9.9') === 1);
}

/* tar.js: what it packs it reads back; links, `..` and oversize archives are refused or left out. */
function testTar() {
    const tar = require('../js/tar');
    const long = `${'d/'.repeat(70)}file.txt`;
    const packed = tar.tgz([{ name: 'a.txt', data: Buffer.from('A'), mode: 0o644 }, { name: long, data: Buffer.from('L'), mode: 0o755 }], 1);
    const dir = path.join(T, 'tartest');
    mkdirp(path.join(dir, 'x'));
    fs.writeFileSync(path.join(dir, 'x', 'f'), 'F');
    fs.symlinkSync('/etc/passwd', path.join(dir, 'x', 'l'));
    sh(`tar -czf ${dir}.tgz -C ${dir} x`);
    fs.writeFileSync(path.join(T, 'dotdot.tgz'), tar.tgz([{ name: 'x/../../evil', data: Buffer.from('E'), mode: 0o644 }], 1));
    return tar.untgz(packed, 1 << 20)
        .then((m) => {
            ok('tar: reads back what it packs, long names and modes too',
                m.length === 2 && m[0].name === 'a.txt' && m[1].name === long && m[1].mode === 0o755 && m[1].data.toString() === 'L');
            return tar.untgz(fs.readFileSync(`${dir}.tgz`), 1 << 20);
        })
        .then((m) => {
            ok('tar: a system tar\'s archive reads; links are left out', m.length === 1 && m[0].name === 'x/f');
            return tar.untgz(fs.readFileSync(path.join(T, 'dotdot.tgz')), 1 << 20).then(() => false, (e) => /names/.test(e.message));
        })
        .then((refused) => {
            ok('tar: a member naming .. is refused', refused);
            return tar.untgz(require('zlib').gzipSync(Buffer.alloc(4 << 20)), 1 << 20).then(() => false, (e) => /more than/.test(e.message));
        })
        .then((refused) => {
            ok('tar: an archive that unpacks past the limit is refused', refused);
            let threw = false;
            try {
                tar.tgz([{ name: `${'x'.repeat(160)}/${'y'.repeat(20)}`, data: Buffer.from('z'), mode: 0o644 }], 1);
            } catch (e) {
                threw = /too long/.test(e.message);
            }
            ok('tar: a name ustar cannot hold is refused, not cut short', threw);
            return require('../js/build').runBuild({ conf: { build_uid: '12990', build_gid: '12990', fetch_uid: '12990', web_uid: '12996',
                state_dir: path.join(T, 'nobuild') }, entry: { id: 'x', version: '1.0.0', script: { node: 'b.js', args: [] } }, files: [], donor: '', log: () => {} })
                .then(() => false, (e) => /not a uid of the builds' own/.test(e.message));
        })
        .then((refused) => ok('build: refused with a build_uid another part uses (it is killed wholesale)', refused && !fs.existsSync(path.join(T, 'nobuild'))));
}

/* ---- fetch.js ----------------------------------------------------------------- */

function runFetch(job, uid) {
    return new Promise((resolve) => {
        const child = cp.spawn(process.execPath, [path.join(ROOT, 'js', 'fetch.js')],
            { uid, gid: uid, stdio: ['pipe', 'pipe', 'inherit'], env: {} });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('close', (code) => resolve({ code, events: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
        child.stdin.end(JSON.stringify(job));
    });
}

function testFetch(certs, pubDir) {
    const dl = path.join(T, 'dl');
    mkdirp(dl);
    fs.chownSync(dl, FETCH_UID, FETCH_UID);
    fs.chmodSync(dl, 0o700);
    fs.writeFileSync(path.join(pubDir, 'payload.bin'), crypto.randomBytes(300000));
    const base = { dns: [`127.0.0.1:${DNS_PORT}`], ca: certs.ca };
    seen.length = 0;
    return runFetch(Object.assign({}, base, { url: `https://updates.test:${HTTPS_PORT}/payload.bin`,
        headers: { 'User-Agent': 't' }, dest: path.join(dl, 'a.bin'), maxBytes: 300000 }), FETCH_UID)
        .then((r) => {
            const last = r.events[r.events.length - 1];
            ok('fetch: downloads through the given DNS server', last && last.done && last.bytes === 300000, JSON.stringify(last));
            ok('fetch: the file belongs to the fetch uid', fs.existsSync(path.join(dl, 'a.bin')) &&
                fs.statSync(path.join(dl, 'a.bin')).uid === FETCH_UID);
            ok('fetch: reports progress', r.events.some((e) => e.progress !== undefined));
            seen.length = 0;
            return runFetch(Object.assign({}, base, { url: `https://updates.test:${HTTPS_PORT}/redirect`,
                headers: { 'User-Agent': 't', Authorization: 'Bearer secret' }, dest: path.join(dl, 'b.bin') }), FETCH_UID);
        })
        .then((r) => {
            const first = seen.find((s) => s.url === '/redirect');
            const second = seen.find((s) => s.host.indexOf('other.test') === 0);
            ok('fetch: follows a redirect to another host', r.events.some((e) => e.done));
            ok('fetch: the token goes to the first host', first && first.auth === 'Bearer secret');
            ok('fetch: the token does not follow the redirect', second && second.auth === null, JSON.stringify(second));
            return runFetch(Object.assign({}, base, { url: `https://updates.test:${HTTPS_PORT}/payload.bin`,
                headers: {}, dest: path.join(dl, 'c.bin'), maxBytes: 1000 }), FETCH_UID);
        })
        .then((r) => {
            ok('fetch: refuses more bytes than expected', r.code !== 0 && r.events.some((e) => /expected/.test(e.error || '')));
            return runFetch(Object.assign({}, base, { url: `https://nowhere.invalid:${HTTPS_PORT}/x`, headers: {}, dest: path.join(dl, 'd') }), FETCH_UID);
        })
        .then((r) => {
            ok('fetch: a name the DNS server does not know fails cleanly', r.code !== 0 && r.events.some((e) => e.error));
            return runFetch(Object.assign({}, base, { url: `http://updates.test:${HTTPS_PORT}/payload.bin`, headers: {}, dest: path.join(dl, 'e') }), FETCH_UID);
        })
        .then((r) => {
            ok('fetch: refuses plain http', r.code !== 0 && r.events.some((e) => /refusing/.test(e.error || '')));
            return runFetch(Object.assign({}, base, { url: `https://updates.test:${HTTPS_PORT}/payload.bin`, headers: {},
                dest: '/root/forbidden.bin' }), FETCH_UID);
        })
        .then((r) => {
            ok('fetch: the fetch uid cannot write outside its folder', r.code !== 0 && !fs.existsSync('/root/forbidden.bin'));
        });
}

/* Root reads a download only if it is a regular file within the size. */
function testCollect() {
    const { Fetcher } = require('../js/updater');
    const f = new Fetcher({ state_dir: path.join(T, 'collect'), fetch_uid: FETCH_UID, fetch_gid: FETCH_UID });
    const d = path.join(T, 'collect');
    mkdirp(d);
    fs.writeFileSync(path.join(d, 'ok'), 'abc');
    sh(`mkfifo ${path.join(d, 'fifo')}`);
    fs.symlinkSync('/etc/hostname', path.join(d, 'link'));
    const refused = (name, max) => {
        try {
            f.collect(path.join(d, name), max);
            return false;
        } catch (e) {
            return true;
        }
    };
    ok('collect: reads a regular file', f.collect(path.join(d, 'ok'), 10).toString() === 'abc');
    ok('collect: refuses a file over the size', refused('ok', 2));
    ok('collect: refuses a FIFO without blocking', refused('fifo', 10));
    ok('collect: refuses a link', refused('link', 1 << 20));
}

/* ---- reboot ------------------------------------------------------------------------ */

/* The stand-in reboot command: logs its arguments to <dir>/ran; while
 * <dir>/fail exists it exits 1 with an error line, while <dir>/refused
 * exists it exits 0 with nsm_control's line for a request NSM did not take. */
function rebootScript(dir) {
    mkdirp(dir);
    const script = path.join(dir, 'reboot.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho "$*" >> ${path.join(dir, 'ran')}\n` +
        `[ -f ${path.join(dir, 'fail')} ] && { echo 'test failure' >&2; exit 1; }\n` +
        `[ -f ${path.join(dir, 'refused')} ] && echo '2026/10/25 08:40:46.755041    7567538 000 ECU1 NSMC NSMC log info V 1 ` +
        `[Error. ProxyLifecycleControl not available!]'\nexit 0\n`, { mode: 0o755 });
    return script;
}

function rebootRuns(dir) {
    const ran = path.join(dir, 'ran');
    return fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').split('\n').filter(Boolean) : [];
}

function testReboot() {
    const { Updater } = require('../js/updater');
    const dir = path.join(T, 'reboot');
    const script = rebootScript(dir);
    const make = (reboot) => new Updater({ catalog: `file://${path.join(dir, 'catalog.json')}`,
        state_dir: path.join(dir, 'state'), reboot });
    let u = make(`${script} --requestRestart 7`);
    u.busy = { id: 'demo_app', phase: 'download' };
    ok('reboot: refused while an install runs', u.reboot() === 'an install is running' && !u.rebooting);
    u.busy = null;
    u.queue = ['demo_app'];
    ok('reboot: refused while an install waits', u.reboot() === 'an install is running' && !u.rebooting);
    ok('reboot: refused without a command', make('').reboot() === 'no reboot command configured');
    ok('reboot: nothing ran for the refused requests', rebootRuns(dir).length === 0);
    fs.writeFileSync(path.join(dir, 'fail'), '');
    u = make(`${script} --requestRestart 7`);
    ok('reboot: accepted when idle, and the state says restarting', u.reboot() === null && u.state().rebooting === true);
    return sleep(1000)
        .then(() => {
            ok('reboot: a failing command ends the restart with its error',
                !u.rebooting && u.state().rebootError === 'test failure', u.rebootError);
            fs.unlinkSync(path.join(dir, 'fail'));
            fs.writeFileSync(path.join(dir, 'refused'), '');
            u = make(`${script} --requestRestart 7`);
            u.reboot();
            return sleep(1000);
        })
        .then(() => {
            ok('reboot: a request NSM did not take (exit 0, "[Error. …]" printed) ends the restart with the reason',
                !u.rebooting && u.rebootError === 'ProxyLifecycleControl not available!', u.rebootError);
            fs.unlinkSync(path.join(dir, 'refused'));
            u = make(`${script} --requestRestart 7`);
            ok('reboot: a second request while restarting is accepted without a second run',
                u.reboot() === null && u.reboot() === null);
            ok('reboot: an install asked for while restarting is refused', u.request('demo_app') === 'the head unit is restarting');
            return sleep(1000);
        })
        .then(() => {
            const runs = rebootRuns(dir);
            ok('reboot: the command runs once per restart, with its arguments',
                runs.length === 3 && runs[2] === '--requestRestart 7', JSON.stringify(runs));
            ok('reboot: a command that succeeds leaves the restart running', u.rebooting && !u.rebootError);
            return sleep(2500);
        })
        .then(() => ok('reboot: a unit still up after the wait ends the restart as failed',
            !u.rebooting && u.rebootError === 'the head unit did not restart', u.rebootError));
}

/* ---- the daemon --------------------------------------------------------------------- */

function waitFor(client, pred, ms, what) {
    return new Promise((resolve, reject) => {
        let last = null;
        const t = setTimeout(() => {
            client.removeListener('state', on);
            reject(new Error(`timed out waiting for ${what}; last state ${JSON.stringify(last)}`));
        }, ms);
        function on(st) {
            last = st;
            if (pred(st)) {
                clearTimeout(t);
                client.removeListener('state', on);
                resolve(st);
            }
        }
        client.on('state', on);
        client.send({ op: 'status' });
    });
}

function row(st, id) {
    return st.components.find((c) => c.id === id) || {};
}

/* The log file under /tmp's rules: a FIFO at its name neither blocks nor
 * takes the lines, and a folder at <log>.1 does not stop it past its size. */
function testFileLog() {
    const { fileLog } = require('../js/updater');
    const dir = path.join(T, 'filelog');
    mkdirp(dir);
    const file = path.join(dir, 'u.log');
    cp.execFileSync('mkfifo', [file]);
    const t0 = Date.now();
    fileLog(file)('one');
    const st = fs.lstatSync(file);
    ok('log: a FIFO at its name is replaced by root\'s own file, without blocking',
        Date.now() - t0 < 2000 && st.isFile() && /Z one\n$/.test(fs.readFileSync(file, 'utf8')));
    mkdirp(`${file}.1`);
    const write = fileLog(file);
    const big = 'x'.repeat(1024);
    for (let i = 0; i < 140; i += 1) {
        write(big);
    }
    write('last');
    const size = fs.statSync(file).size;
    ok('log: with a folder at <log>.1 it starts over past 128 KiB and keeps logging',
        size < 64 * 1024 && /Z last\n$/.test(fs.readFileSync(file, 'utf8')), `size ${size}`);
}

function testDaemon(certs, pubDir) {
    const opt = path.join(T, 'opt');
    const oap = path.join(T, 'oap');
    const v1 = path.join(opt, 'mgu-updater', 'versions', '0.1.0');
    mkdirp(v1);
    mkdirp(oap);
    // version 0.1.0 installed the deploy tool's way
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'component.json'), 'utf8'));
    c.files.filter((f) => fs.existsSync(path.join(ROOT, f.from))).forEach((f) => fs.copyFileSync(path.join(ROOT, f.from), path.join(v1, f.path)));
    fs.chmodSync(path.join(v1, 'mgu-updater'), 0o755);
    c.version = '0.1.0';
    fs.writeFileSync(path.join(v1, 'component.json'), JSON.stringify(c));
    fs.symlinkSync('versions/0.1.0', path.join(opt, 'mgu-updater', 'current'));
    const d1 = path.join(opt, 'mgu-deploy', 'versions', '1.0.0');
    mkdirp(d1);
    fs.writeFileSync(path.join(d1, 'mgu-deploy.sh'), DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(d1, 'component.json'), JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '1.0.0' }));
    fs.symlinkSync('versions/1.0.0', path.join(opt, 'mgu-deploy', 'current'));
    const sock = path.join(T, 'shm', 'updater.sock');
    const log = path.join(T, 'deploy.log');
    fs.writeFileSync(path.join(T, 'ca.pem'), certs.ca);
    const conf = path.join(T, 'updater.local.conf');
    // stand-in for native/app-privacy's patch_mainapp.js: check --json prints $T/privacy.json
    const privacyTool = path.join(T, 'patch_mainapp.js');
    fs.writeFileSync(privacyTool, `console.log('noise'); console.log(require('fs').readFileSync(${JSON.stringify(path.join(T, 'privacy.json'))}, 'utf8'));\n`);
    const privacy = (state, restartNeeded) => fs.writeFileSync(path.join(T, 'privacy.json'),
        JSON.stringify({ version: '1.0.0', command: 'check', state, restartNeeded }));
    privacy('unpatched', false);
    // the built-in source, at the test catalog
    const sourcesFile = path.join(T, 'sources.json');
    const sourcesAt = (src) => fs.writeFileSync(sourcesFile, JSON.stringify({ schema: 1, sources: [Object.assign({ id: 'mgu-store', builtin: true }, src)] }));
    sourcesAt({ type: 'https', url: `https://updates.test:${HTTPS_PORT}/catalog.json` });
    const confText = (extra) => [
        `sources = ${sourcesFile}`, `credentials_dir = ${path.join(T, 'credentials')}`, `mounts = ${path.join(T, 'no-mounts')}`,
        `ca_file = ${path.join(T, 'ca.pem')}`, 'lease = ' + path.join(T, 'lease.json'),
        `deploy = ${path.join(opt, 'mgu-deploy', 'current', 'mgu-deploy.sh')}`, 'bootstrap_check_s = 6',
        `state_dir = ${path.join(T, 'state')}`,
        `tool_root = ${opt}`, `oap_root = ${oap}`, `socket = ${sock}`, 'socket_group = staff',
        'first_check_s = 0', 'check_interval_s = 3600', `privacy_tool = ${privacyTool}`,
        `log_file = ${path.join(T, 'tmp', 'mgu-updater.log')}`, `reboot = ${rebootScript(path.join(T, 'daemon-reboot'))} reboot`,
        extra || ''].join('\n');
    fs.writeFileSync(conf, confText());
    // a link where the log file goes: the daemon writes its own file, not through it
    const logFile = path.join(T, 'tmp', 'mgu-updater.log');
    mkdirp(path.dirname(logFile));
    fs.writeFileSync(path.join(T, 'log-target'), 'untouched');
    fs.symlinkSync(path.join(T, 'log-target'), logFile);
    fs.writeFileSync(path.join(T, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.copyFileSync(path.join(T, 'lease.json'), path.join(T, 'lease.json.good'));

    const app1 = appTgz(pubDir, 'demo_app', '1.0.0');
    const kit2 = updaterKit(pubDir, '0.2.0');
    publish(pubDir, [entry(app1, 'app', 'Demo'), entry(kit2, 'tool', 'Updater')]);

    // someone else's world-writable folder where the socket goes
    const sockDir = path.join(T, 'shm');
    mkdirp(sockDir);
    fs.chownSync(sockDir, FETCH_UID, FETCH_UID);
    fs.chmodSync(sockDir, 0o777);
    // and leftovers of the fetch uid's that a start must not trip over: a
    // download folder holding a deep tree and a link out of it
    const planted = path.join(T, 'state', 'dl-0123456789ab');
    mkdirp(path.join(planted, 'a', 'b'));
    const precious = path.join(T, 'precious');
    mkdirp(precious);
    fs.writeFileSync(path.join(precious, 'keep'), 'x');
    fs.symlinkSync(precious, path.join(planted, 'a', 'link'));
    sh(`chown -R ${FETCH_UID}:${FETCH_UID} ${planted}`);
    // root's own folder inside: only a remover running as root could empty it
    mkdirp(path.join(planted, 'rootdir'));
    fs.writeFileSync(path.join(planted, 'rootdir', 'rootfile'), 'x');
    const supLog = path.join(T, 'supervisor.log');
    const env = Object.assign({}, process.env, {
        MGU_UPDATER_DIR: path.join(opt, 'mgu-updater'), MGU_UPDATER_CONF: conf, NODE: process.execPath, TRIAL_S: '12',
        MGU_UPDATER_TRIAL_WAIT_MS: '6000',
        TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: log, FAKE_LEASE: path.join(T, 'lease.json')
    });
    const sup = cp.spawn('sh', [path.join(opt, 'mgu-updater', 'current', 'mgu-updater')],
        { env, stdio: ['ignore', fs.openSync(supLog, 'a'), fs.openSync(supLog, 'a')], detached: true });
    const client = new UpdaterClient(sock, { reconnectMs: 300 });
    const version = (st) => st.updater.version;
    // A restarted daemon checks the catalog at once; a check asked for while
    // that one runs joins it, so a test publishes only after it has finished.
    let restartedAt = 0;
    const restarting = () => { restartedAt = Date.now(); };
    const settled = (st) => !st.catalog.checking && st.catalog.checkedAt >= restartedAt;
    let step = Promise.resolve();
    const deadline = (p, name) => p.catch((e) => ok(name, false, e.message));
    const trialFile = path.join(opt, 'mgu-updater', 'trial');
    const current = () => fs.readlinkSync(path.join(opt, 'mgu-updater', 'current'));
    // the running daemon: the supervisor's node child
    const daemonPid = () => sh(`pgrep -P ${sup.pid} -f 'updater[.]js daemon'`).trim().split('\n')[0];

    step = step.then(() => new Promise((r) => setTimeout(r, 1500)))
        .then(() => {
            client.connect();
            return waitFor(client, (st) => st.catalog.checkedAt && !st.catalog.checking, 15000, 'the first catalog check');
        })
        .then((st) => {
            ok('daemon: serves its state and checks the catalog at start', version(st) === '0.1.0' && st.components.length === 2,
                JSON.stringify(st.catalog));
            const mode = fs.statSync(sock).mode & 0o777;
            ok('daemon: the socket is 0660 in the configured group', mode === 0o660 && fs.statSync(sock).gid === 50);
            const dirSt = fs.lstatSync(path.dirname(sock));
            ok('daemon: a socket folder someone else made is replaced by root\'s own 0755',
                dirSt.uid === 0 && (dirSt.mode & 0o777) === 0o755 &&
                fs.readdirSync(T).some((n) => /^shm\.untrusted-/.test(n)));
            ok('daemon: a start clears what the fetch uid left in earlier download folders',
                !fs.existsSync(path.join(planted, 'a')));
            ok('daemon: clearing them follows no link out', fs.existsSync(path.join(precious, 'keep')));
            ok('daemon: clearing them runs as the fetch uid (root\'s own files stay)',
                fs.existsSync(path.join(planted, 'rootdir', 'rootfile')));
            ok('daemon: online while the uplink lease exists', st.online === true);
            const files = (pid) => fs.readdirSync(`/proc/${pid}/fd`).map((fd) => {
                try {
                    return fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
                } catch (e) {
                    return '';
                }
            });
            ok('supervisor: runs its script from /run and keeps no file of a version folder open',
                fs.readFileSync(`/proc/${sup.pid}/cmdline`, 'utf8').split('\0').indexOf('/run/mgu-updater/supervisor') >= 0 &&
                files(sup.pid).concat(files(daemonPid())).every((f) => f.indexOf(opt) !== 0),
                JSON.stringify(files(sup.pid)));
            ok('privacy: an unpatched MainApp is reported', st.privacy === 'unpatched', st.privacy);
            privacy('patched', true);
            client.check();
            return waitFor(client, (s) => s.privacy === 'restart-needed', 15000, 'restart-needed after a check');
        })
        .then((st) => {
            ok('privacy: patched but not yet loaded by MainApp is restart-needed, re-read with each check',
                st.privacy === 'restart-needed');
            privacy('patched', false);
            client.check();
            return waitFor(client, (s) => s.privacy === 'patched' && !s.catalog.checking, 15000, 'patched');
        })
        .then((st) => {
            ok('privacy: patched and loaded is patched', st.privacy === 'patched');
            // a catalog that does not parse is refused; the last good one stays
            fs.writeFileSync(path.join(pubDir, 'catalog.json'), '{ "schema": 1, "components": [ { "id": "x" } ] }');
            client.check();
            return waitFor(client, (s) => s.catalog.error && !s.catalog.checking, 15000, 'the malformed catalog refused');
        })
        .then((st) => {
            ok('catalog: a malformed catalog is refused and the last good one kept',
                /malformed/.test(st.catalog.error) && st.components.length === 2 && st.sources[0].status === 'error', st.catalog.error);
            publish(pubDir, [entry(app1, 'app', 'Demo'), entry(kit2, 'tool', 'Updater')], { signature: { alg: 'ecdsa-p256-sha256', value: 'AAAA' } });
            client.check();
            return waitFor(client, (s) => !s.catalog.error && !s.catalog.checking, 15000, 'the catalog with a signature field');
        })
        .then((st) => {
            ok('catalog: a signature field is not looked at', st.components.length === 2 && st.sources[0].status === 'ok');
            fs.writeFileSync(path.join(T, 'privacy.json'), 'not json');
            client.check();
            return waitFor(client, (s) => s.privacy === 'unknown' && !s.catalog.checking, 15000, 'unknown');
        })
        .then((st) => {
            ok('privacy: a tool that gives no answer is unknown, not absent', st.privacy === 'unknown');
            ok('plan: the app is available, the updater has an update',
                row(st, 'demo_app').status === 'available' && row(st, 'mgu-updater').status === 'update');
            client.install('demo_app');
            return waitFor(client, (s) => row(s, 'demo_app').status === 'installed' && !s.busy, 20000, 'demo_app installed');
        })
        .then(() => {
            ok('install: an app goes through the deploy tool as one artifact',
                /install --artifact .*demo_app@1\.0\.0\.tgz --yes/.test(fs.readFileSync(log, 'utf8')));
            ok('install: the verified copy is removed afterwards', !fs.existsSync(path.join(T, 'state', 'verified', 'demo_app@1.0.0.tgz')));
            restarting();
            client.install('mgu-updater');
            return waitFor(client, (s) => version(s) === '0.2.0' && settled(s), 30000, 'the updater running 0.2.0');
        })
        .then((st) => {
            ok('self-update: the new version runs and is committed', !fs.existsSync(trialFile) && current() === 'versions/0.2.0');
            ok('self-update: it reports itself installed', row(st, 'mgu-updater').status === 'installed');
            ok('self-update: the supervisor kept running', sup.exitCode === null);
            // a new version that crashes at start
            const kit3 = updaterKit(pubDir, '0.3.0', 'crash');
            publish(pubDir, [entry(app1, 'app', 'Demo'), entry(kit3, 'tool', 'Updater')]);
            client.check();
            return waitFor(client, (s) => row(s, 'mgu-updater').version === '0.3.0' && !s.catalog.checking, 15000, 'catalog with 0.3.0');
        })
        .then(() => {
            restarting();
            client.install('mgu-updater');
            return sleep(3000).then(() => waitFor(client, (s) => version(s) === '0.2.0' && !fs.existsSync(trialFile) && settled(s), 30000, 'rollback to 0.2.0'));
        })
        .then((st) => {
            ok('rollback: a new version that crashes returns to the previous one', current() === 'versions/0.2.0' &&
                /back to versions\/0\.2\.0/.test(fs.readFileSync(supLog, 'utf8')));
            ok('rollback: the version that crashed is removed',
                !fs.existsSync(path.join(opt, 'mgu-updater', 'versions', '0.3.0')));
            ok('rollback: the update shows as still available', row(st, 'mgu-updater').status === 'update');
            ok('rollback: the Store is told which version did not start',
                /0\.3\.0 did not start; 0\.2\.0 kept/.test(row(st, 'mgu-updater').error || ''), row(st, 'mgu-updater').error);
            // a second failing version: the deploy tool keeps the version current pointed to before
            const kit31 = updaterKit(pubDir, '0.3.1', 'crash');
            publish(pubDir, [entry(app1, 'app', 'Demo'), entry(kit31, 'tool', 'Updater')]);
            client.check();
            return waitFor(client, (s) => row(s, 'mgu-updater').version === '0.3.1' && !s.catalog.checking, 15000, 'catalog with 0.3.1');
        })
        .then(() => {
            restarting();
            client.install('mgu-updater');
            return sleep(3000).then(() => waitFor(client, (s) => version(s) === '0.2.0' && !fs.existsSync(trialFile) && settled(s), 30000, 'rollback to 0.2.0 again'));
        })
        .then(() => {
            ok('rollback: a second failed version still returns to the one that ran',
                current() === 'versions/0.2.0' && fs.existsSync(path.join(opt, 'mgu-updater', 'versions', '0.2.0', 'updater.js')));
            const kit4 = updaterKit(pubDir, '0.4.0', 'hang');
            publish(pubDir, [entry(app1, 'app', 'Demo'), entry(kit4, 'tool', 'Updater')]);
            client.check();
            return waitFor(client, (s) => row(s, 'mgu-updater').version === '0.4.0' && !s.catalog.checking, 15000, 'catalog with 0.4.0');
        })
        .then(() => {
            restarting();
            client.install('mgu-updater');
            return sleep(3000).then(() => waitFor(client, (s) => version(s) === '0.2.0' && !fs.existsSync(trialFile) && settled(s), 40000, 'rollback from a hang'));
        })
        .then(() => {
            ok('rollback: a new version that never serves returns to the previous one', current() === 'versions/0.2.0');
            // a new version that serves its socket but cannot download
            const kit5 = updaterKit(pubDir, '0.5.0', 'nofetch');
            publish(pubDir, [entry(app1, 'app', 'Demo'), entry(kit5, 'tool', 'Updater')]);
            client.check();
            return waitFor(client, (s) => row(s, 'mgu-updater').version === '0.5.0' && !s.catalog.checking, 15000, 'catalog with 0.5.0');
        })
        .then(() => {
            restarting();
            client.install('mgu-updater');
            return sleep(3000).then(() => waitFor(client, (s) => version(s) === '0.2.0' && !fs.existsSync(trialFile) && settled(s), 40000,
                'rollback from a version that cannot download'));
        })
        .then((st) => {
            ok('rollback: a new version that serves but cannot fetch the catalog returns to the previous one',
                current() === 'versions/0.2.0' && /0\.5\.0 not kept: it cannot fetch the catalog/.test(row(st, 'mgu-updater').error || ''),
                row(st, 'mgu-updater').error);
            // a trial naming a version that is gone: the supervisor keeps current
            fs.writeFileSync(trialFile, 'versions/0.0.9\n');
            restarting();
            process.kill(Number(daemonPid()), 'SIGKILL');
            return sleep(3000).then(() => waitFor(client, (s) => version(s) === '0.2.0' && settled(s), 30000, 'restart after a bad trial'));
        })
        .then(() => {
            ok('rollback: a trial naming a missing version leaves current as it is', current() === 'versions/0.2.0' &&
                !fs.existsSync(trialFile) && /is not on disk/.test(fs.readFileSync(supLog, 'utf8')));
            // a trial naming the version that runs (a reinstall of it): nothing is removed
            fs.writeFileSync(trialFile, 'versions/0.2.0\n');
            restarting();
            process.kill(Number(daemonPid()), 'SIGKILL');
            return sleep(3000).then(() => waitFor(client, (s) => version(s) === '0.2.0' && settled(s), 30000, 'restart after a same-version trial'));
        })
        .then(() => {
            ok('rollback: a failed reinstall of the running version keeps it on disk', current() === 'versions/0.2.0' &&
                fs.existsSync(path.join(opt, 'mgu-updater', 'versions', '0.2.0', 'updater.js')));
        })
        .then(() => {
            // a good new version that starts while the uplink is down: it waits for the
            // lease, and is rolled back only when the internet stays away
            const lease = path.join(T, 'lease.json');
            const selfUpdate = (v, restoreAfterMs) => {
                const kit = updaterKit(pubDir, v);
                publish(pubDir, [entry(app1, 'app', 'Demo'), entry(kit, 'tool', 'Updater')]);
                client.check();
                return waitFor(client, (s) => row(s, 'mgu-updater').version === v && !s.catalog.checking, 15000, `catalog with ${v}`)
                    .then(() => {
                        restarting();
                        client.install('mgu-updater');
                        // the download is done once trial is written; then the uplink goes
                        return new Promise((resolve) => {
                            const t = setInterval(() => {
                                if (fs.existsSync(trialFile)) {
                                    clearInterval(t);
                                    fs.unlinkSync(lease);
                                    if (restoreAfterMs !== null) {
                                        setTimeout(() => fs.copyFileSync(`${lease}.good`, lease), restoreAfterMs);
                                    }
                                    resolve();
                                }
                            }, 50);
                        });
                    });
            };
            return selfUpdate('0.6.0', null)
                .then(() => sleep(3000))
                .then(() => waitFor(client, (s) => version(s) === '0.2.0' && !fs.existsSync(trialFile), 40000, 'rollback while offline'))
                .then((st) => {
                    ok('trial: a version that never gets internet to check it with is rolled back, saying so',
                        current() === 'versions/0.2.0' &&
                        /0\.6\.0 not kept: there was no internet to check it with; 0\.2\.0 kept/.test(row(st, 'mgu-updater').error || ''),
                        row(st, 'mgu-updater').error);
                    fs.copyFileSync(`${lease}.good`, lease);
                    return sleep(16000).then(() => selfUpdate('0.6.1', 2500));
                })
                .then(() => waitFor(client, (s) => version(s) === '0.6.1' && !fs.existsSync(trialFile) && settled(s), 40000,
                    'commit after the uplink returns'))
                .then(() => {
                    ok('trial: a version that starts before the uplink is up waits for it and is kept', current() === 'versions/0.6.1');
                });
        })
        .then(() => {
            // the local installer puts a new version there while the car is offline
            const kit = updaterKit(pubDir, '0.7.0');
            fs.unlinkSync(path.join(T, 'lease.json'));
            restarting();
            cp.execFileSync(path.join(opt, 'mgu-deploy', 'current', 'mgu-deploy.sh'), ['install', '--artifact', kit, '--yes'],
                { env, stdio: 'ignore' });
            return sleep(3000).then(() => waitFor(client, (s) => version(s) === '0.7.0' && !fs.existsSync(trialFile), 60000,
                'the local install taken up offline'));
        })
        .then(() => {
            ok('trial: a version the local installer puts there is kept without internet',
                current() === 'versions/0.7.0' && !fs.existsSync(path.join(opt, 'mgu-updater', 'trial-local')));
            // still offline: a newer version on a USB stick
            const stick = path.join('/media', 'SELFSTICK');
            mkdirp(stick);
            publish(stick, [entry(updaterKit(stick, '0.8.0'), 'tool', 'Updater')]);
            fs.writeFileSync(path.join(T, 'no-mounts'), `/dev/sdz1 ${stick} vfat ro 0 0\n`);
            return waitFor(client, (s) => row(s, 'mgu-updater').version === '0.8.0' && row(s, 'mgu-updater').status === 'update' &&
                row(s, 'mgu-updater').source === 'usb:SELFSTICK', 20000, 'the stick\'s updater offered offline')
                .then(() => {
                    restarting();
                    client.install('mgu-updater');
                    return sleep(3000).then(() => waitFor(client, (s) => version(s) === '0.8.0' && !fs.existsSync(trialFile) && settled(s), 60000,
                        'the stick\'s updater kept offline'));
                })
                .then(() => {
                    ok('trial: a version from a USB stick is kept without internet',
                        current() === 'versions/0.8.0' && !fs.existsSync(path.join(opt, 'mgu-updater', 'trial-local')));
                    fs.unlinkSync(path.join(T, 'no-mounts'));
                    cp.execFileSync('rm', ['-rf', stick]);
                    fs.copyFileSync(path.join(T, 'lease.json.good'), path.join(T, 'lease.json'));
                });
        })
        .then(() => {
            // a download that does not match the catalog
            const app2 = appTgz(pubDir, 'demo_app', '1.1.0');
            const e = entry(app2, 'app', 'Demo');
            e.artifact.sha256 = 'f'.repeat(64);
            publish(pubDir, [e]);
            client.check();
            return waitFor(client, (s) => row(s, 'demo_app').version === '1.1.0' && !s.catalog.checking, 15000, 'catalog with demo 1.1.0');
        })
        .then(() => {
            client.install('demo_app');
            return waitFor(client, (s) => row(s, 'demo_app').error && !s.busy, 20000, 'the mismatch error');
        })
        .then((st) => {
            ok('verify: a download that does not match the catalog is not installed',
                /does not match/.test(row(st, 'demo_app').error) && row(st, 'demo_app').installed === '1.0.0');
            // the deploy tool failing
            publish(pubDir, [entry(path.join(pubDir, 'demo_app@1.1.0.tgz'), 'app', 'Demo')]);
            client.check();
            return waitFor(client, (s) => !s.catalog.checking && row(s, 'demo_app').version === '1.1.0', 15000, 'fixed catalog');
        })
        .then(() => {
            fs.writeFileSync(`${log}.fail`, '1');
            client.install('demo_app');
            return waitFor(client, (s) => row(s, 'demo_app').error && !s.busy, 20000, 'the deploy failure');
        })
        .then((st) => {
            ok('install: a failed deploy is reported with its reason and the old version stays',
                row(st, 'demo_app').error === 'install failed: test failure 1; the previous version was kept' &&
                row(st, 'demo_app').installed === '1.0.0');
            fs.writeFileSync(`${log}.fail`, '2');
            client.install('demo_app');
            return waitFor(client, (s) => /failure 2/.test(row(s, 'demo_app').error || '') && !s.busy, 20000, 'the deploy refusal');
        })
        .then((st) => {
            ok('install: a refusal is reported with the deploy tool\'s reason',
                row(st, 'demo_app').error === 'test failure 2; nothing changed');
            fs.unlinkSync(`${log}.fail`);
            client.install('demo_app');
            return waitFor(client, (s) => row(s, 'demo_app').status === 'installed' && !s.busy, 20000, 'demo_app 1.1.0');
        })
        .then((st) => {
            ok('update: an installed app updates to the catalog version', row(st, 'demo_app').installed === '1.1.0');
            const logText = fs.readFileSync(logFile, 'utf8');
            const ls = fs.lstatSync(logFile);
            ok('log: the daemon\'s lines, timed, in a 0644 file of its own, not through a link put there',
                ls.isFile() && (ls.mode & 0o777) === 0o644 && fs.readFileSync(path.join(T, 'log-target'), 'utf8') === 'untouched' &&
                /^\d{4}-\d\d-\d\dT[\d:.]+Z demo_app@1\.1\.0: download from mgu-store \(\d+ bytes\)$/m.test(logText) &&
                /Z demo_app@1\.1\.0: install \(sha256 [0-9a-f]{12}\)$/m.test(logText) && /Z deploy: /m.test(logText) &&
                /Z installed demo_app@1\.1\.0\n.*Z demo_app@1\.1\.0: done$/m.test(logText), logText.slice(-2000));
            // the deploy tool updates itself; a new version that does not run is put back
            const demo = entry(path.join(pubDir, 'demo_app@1.1.0.tgz'), 'app', 'Demo');
            const deploy11 = entry(toolKit(pubDir, 'mgu-deploy', '1.1.0', { 'mgu-deploy.sh': [DEPLOY_SH, 0o755] }), 'tool', 'Deploy tool');
            publish(pubDir, [demo, deploy11]);
            client.check();
            return waitFor(client, (s) => row(s, 'mgu-deploy').version === '1.1.0' && !s.catalog.checking, 15000, 'catalog with mgu-deploy 1.1.0')
                .then(() => {
                    client.install('mgu-deploy');
                    return waitFor(client, (s) => row(s, 'mgu-deploy').status === 'installed' && !s.busy, 20000, 'mgu-deploy 1.1.0');
                });
        })
        .then(() => {
            const link = () => fs.readlinkSync(path.join(opt, 'mgu-deploy', 'current'));
            ok('bootstrap: the deploy tool installs its new version, which then answers', link() === 'versions/1.1.0');
            const deploy12 = entry(toolKit(pubDir, 'mgu-deploy', '1.2.0', { 'mgu-deploy.sh': [BROKEN_DEPLOY_SH, 0o755] }), 'tool', 'Deploy tool');
            publish(pubDir, [entry(path.join(pubDir, 'demo_app@1.1.0.tgz'), 'app', 'Demo'), deploy12]);
            client.check();
            return waitFor(client, (s) => row(s, 'mgu-deploy').version === '1.2.0' && !s.catalog.checking, 15000, 'catalog with mgu-deploy 1.2.0')
                .then(() => {
                    client.install('mgu-deploy');
                    return waitFor(client, (s) => row(s, 'mgu-deploy').error && !s.busy, 90000, 'the broken deploy tool put back');
                })
                .then((st) => {
                    ok('bootstrap: a deploy tool that does not run is put back to the one that ran',
                        link() === 'versions/1.1.0' && /1\.2\.0 does not run; 1\.1\.0 kept/.test(row(st, 'mgu-deploy').error),
                        row(st, 'mgu-deploy').error);
                    ok('bootstrap: the deploy tool version that does not run is removed',
                        !fs.existsSync(path.join(opt, 'mgu-deploy', 'versions', '1.2.0')));
                });
        })
        .then(() => {
            // the uplink: a new version must give the internet back, or it is rolled back
            const uplink = (v, broken) => entry(toolKit(pubDir, 'mgu-uplink', v, { 'mgu-uplink': ['#!/bin/sh\n', 0o755] },
                broken ? { test_broken: true } : {}), 'tool', 'Internet uplink');
            const others = () => [entry(path.join(pubDir, 'demo_app@1.1.0.tgz'), 'app', 'Demo')];
            const uplinkLink = () => fs.readlinkSync(path.join(opt, 'mgu-uplink', 'current'));
            const installUplink = (e, done, what) => {
                publish(pubDir, others().concat([e]));
                client.check();
                return waitFor(client, (s) => row(s, 'mgu-uplink').version === e.version && !s.catalog.checking, 15000,
                    `catalog with mgu-uplink ${e.version}`)
                    .then(() => {
                        client.install('mgu-uplink');
                        return sleep(500).then(() => waitFor(client, (s) => done(row(s, 'mgu-uplink')) && !s.busy, 60000, what));
                    });
            };
            return installUplink(uplink('0.2.0', false), (r) => r.status === 'installed', 'mgu-uplink 0.2.0')
                .then((st) => {
                    ok('bootstrap: the uplink installs and the internet is there after it', uplinkLink() === 'versions/0.2.0' &&
                        st.online && !row(st, 'mgu-uplink').error);
                    return installUplink(uplink('0.2.1', true), (r) => !!r.error, 'the broken uplink rolled back');
                })
                .then((st) => {
                    ok('bootstrap: an uplink version that gives no internet is rolled back and the internet returns',
                        uplinkLink() === 'versions/0.2.0' && fs.existsSync(path.join(T, 'lease.json')) &&
                        /0\.2\.1 gives no internet; 0\.2\.0 kept/.test(row(st, 'mgu-uplink').error) &&
                        /rollback mgu-uplink/.test(fs.readFileSync(log, 'utf8')), row(st, 'mgu-uplink').error);
                    // an update the deploy tool leaves for the next boot is not checked: nothing restarted
                    fs.writeFileSync(`${log}.pending`, 'mgu-uplink\n');
                    return installUplink(uplink('0.2.2', true), (r) => r.pendingReboot, 'the pending uplink update');
                })
                .then((st) => {
                    const r = row(st, 'mgu-uplink');
                    ok('bootstrap: an uplink update pending a reboot is not checked or rolled back',
                        uplinkLink() === 'versions/0.2.2' && r.pendingReboot && !r.error &&
                        (fs.readFileSync(log, 'utf8').match(/rollback mgu-uplink/g) || []).length === 1, JSON.stringify(r));
                    fs.unlinkSync(`${log}.pending`);
                    // a rollback the deploy tool reports as failed is not reported as kept
                    fs.writeFileSync(`${log}.rollbackfail`, '');
                    return installUplink(uplink('0.2.3', true), (r) => !!r.error, 'the failed rollback');
                })
                .then((st) => {
                    ok('bootstrap: a failed uplink rollback is reported as failed',
                        /0\.2\.3 gives no internet; going back to 0\.2\.2 failed \(exit 1\)/.test(row(st, 'mgu-uplink').error),
                        row(st, 'mgu-uplink').error);
                    fs.unlinkSync(`${log}.rollbackfail`);
                    // still without internet: an uplink from a USB stick has none to give back, and is kept
                    const stick = path.join('/media', 'UPLSTICK');
                    mkdirp(stick);
                    publish(stick, [entry(toolKit(stick, 'mgu-uplink', '0.2.4', { 'mgu-uplink': ['#!/bin/sh\n', 0o755] }, { test_broken: true }),
                        'tool', 'Internet uplink')]);
                    fs.writeFileSync(path.join(T, 'no-mounts'), `/dev/sdz1 ${stick} vfat ro 0 0\n`);
                    return waitFor(client, (x) => x.online === false && row(x, 'mgu-uplink').source === 'usb:UPLSTICK', 30000, 'the stick\'s uplink offered offline');
                })
                .then(() => {
                    client.install('mgu-uplink');
                    return sleep(500).then(() => waitFor(client, (x) => row(x, 'mgu-uplink').installed === '0.2.4' && !x.busy, 60000, 'the stick\'s uplink'));
                })
                .then((st) => {
                    ok('bootstrap: an uplink installed from a stick without internet is kept, not checked',
                        uplinkLink() === 'versions/0.2.4' && !row(st, 'mgu-uplink').error &&
                        (fs.readFileSync(log, 'utf8').match(/rollback mgu-uplink/g) || []).length === 2, JSON.stringify(row(st, 'mgu-uplink')));
                    fs.unlinkSync(path.join(T, 'no-mounts'));
                    cp.execFileSync('rm', ['-rf', '/media/UPLSTICK']);
                    fs.copyFileSync(path.join(T, 'lease.json.good'), path.join(T, 'lease.json'));
                });
        })
        .then(() => {
            fs.unlinkSync(path.join(T, 'lease.json'));
            return sleep(16000).then(() => waitFor(client, (s) => s.online === false, 5000, 'offline'));
        })
        .then(() => {
            const app3 = appTgz(pubDir, 'demo_app', '1.2.0');
            publish(pubDir, [entry(app3, 'app', 'Demo')]);
            fs.writeFileSync(path.join(T, 'state', 'catalog.json'), fs.readFileSync(path.join(pubDir, 'catalog.json')));
            client.install('demo_app');
            return waitFor(client, (s) => row(s, 'demo_app').error && !s.busy, 15000, 'offline error');
        })
        .then((st) => {
            ok('offline: no lease means no download', /no internet/.test(row(st, 'demo_app').error));
            fs.writeFileSync(path.join(T, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
            fs.writeFileSync(sourcesFile, '{ not json');
            process.kill(Number(daemonPid()), 'SIGTERM');
            return sleep(8000).then(() => waitFor(client, (s) => s.catalog.error, 15000, 'a failed check'));
        })
        .then((st) => {
            ok('robust: a sources.json that does not parse leaves the built-in source and says so',
                /sources\.json/.test(st.catalog.error) && st.sources.length === 1 && st.sources[0].builtin, st.catalog.error);
            sourcesAt({ type: 'file', path: path.join(T, 'missing') });
            process.kill(Number(daemonPid()), 'SIGTERM');
            return sleep(8000).then(() => waitFor(client, (s) => s.catalog.error && !/sources\.json/.test(s.catalog.error), 15000, 'missing folder'));
        })
        .then((st) => {
            ok('robust: a missing folder is a failed check, not a crash', /ENOENT/.test(st.catalog.error), st.catalog.error);
            return new Promise((resolve) => {
                client.once('reply-error', (msg) => {
                    ok('requests: an id no source lists is refused', /not in any source/.test(msg));
                    resolve();
                });
                client.install('nope');
            });
        })
        .then(() => {
            client.reboot();
            return waitFor(client, (s) => s.rebooting === true, 5000, 'restarting');
        })
        .then(() => new Promise((resolve) => {
            client.once('reply-error', (msg) => {
                ok('reboot: the socket refuses an install while restarting', /restarting/.test(msg), msg);
                resolve();
            });
            client.install('nope');
        }))
        .then(() => waitFor(client, (s) => s.rebooting === false, 10000, 'the restart given up'))
        .then((st) => {
            ok('reboot: the state reports a unit that did not restart', st.rebootError === 'the head unit did not restart',
                st.rebootError);
            ok('reboot: the socket\'s reboot request ran the configured command once',
                rebootRuns(path.join(T, 'daemon-reboot')).join() === 'reboot');
            client.check();
            return waitFor(client, (s) => s.rebootError === null, 10000, 'the restart error cleared by a check');
        })
        .then((st) => ok('reboot: the next catalog check clears the restart error and leaves no restart running',
            st.rebootError === null && st.rebooting === false));
    return deadline(step, 'daemon scenario').then(() => {
        client.close();
        try {
            process.kill(-sup.pid, 'SIGTERM');
        } catch (e) { /* gone */ }
    });
}

/* ---- sources ------------------------------------------------------------------------- */

/* Polls fn (a state) until pred holds. */
function until(fn, pred, ms, what) {
    const end = Date.now() + ms;
    return new Promise((resolve, reject) => {
        const t = setInterval(() => {
            const st = fn();
            if (pred(st)) {
                clearInterval(t);
                resolve(st);
            } else if (Date.now() > end) {
                clearInterval(t);
                reject(new Error(`timed out waiting for ${what}; last ${JSON.stringify(st).slice(0, 3000)}`));
            }
        }, 200);
    });
}

/* One request with a rid on a fresh connection: resolves with the message
 * that carries the rid. */
function askRaw(sock, req) {
    return new Promise((resolve) => {
        const s = net.connect(sock);
        let buf = '';
        let sent = false;
        s.setEncoding('utf8');
        s.on('data', (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const msg = JSON.parse(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                if (!sent) {
                    sent = true;
                    s.write(JSON.stringify(req) + '\n');
                } else if (msg.rid !== undefined) {
                    s.end();
                    resolve(msg);
                }
            }
        });
    });
}

/* One request on a fresh connection: resolves with the error the updater
 * answered it with, or null. */
function ask(sock, req) {
    return new Promise((resolve) => {
        const s = net.connect(sock);
        let buf = '';
        let sent = false;
        let error = null;
        s.setEncoding('utf8');
        s.on('data', (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const msg = JSON.parse(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                if (!sent) {
                    sent = true;
                    s.write(JSON.stringify(req) + '\n');
                    setTimeout(() => {
                        s.end();
                        resolve(error);
                    }, 400);
                } else if (msg.type === 'error' && msg.op === req.op && error === null) {
                    error = msg.error;
                }
            }
        });
    });
}

function testSources(certs) {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'ms');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const state = path.join(M, 'state');
    const media = path.join(M, 'media');
    [M, opt, oap, state, media, path.join(M, 'run'), path.join(M, 'shm')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog, FAKE_DONOR: path.join(M, 'donor.js') });
    delete process.env.FAKE_LEASE;
    fs.writeFileSync(path.join(M, 'donor.js'), '// the SDK donor bundle\n');
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    const deployed = () => fs.readFileSync(deployLog, 'utf8').split('\n').filter((l) => /^(install|uninstall)/.test(l));
    // the Store (uid 13050) and a link put where its secret goes
    mkdirp(path.join(oap, 'oap_12201', 'data', 'apps'));
    fs.writeFileSync(path.join(oap, 'oap_12201', 'data', 'apps', 'robertn_store.json'), JSON.stringify({ userId: 13050 }));
    const storeData = path.join(oap, 'oap_13050', 'data');
    mkdirp(storeData);
    // the unit's modes: apps reach oap_root only through its group (mgu_persist), their home through their own
    sh(`chown 0:903 ${oap} && chmod 0710 ${oap} && chown 12201:13050 ${path.join(oap, 'oap_13050')} ${storeData} && ` +
        `chmod 0750 ${path.join(oap, 'oap_13050')} && chmod 0770 ${storeData}`);
    fs.writeFileSync(path.join(M, 'victim'), 'untouched');
    fs.symlinkSync(path.join(M, 'victim'), path.join(storeData, 'updater-secret'));
    sh(`chown -h 13050:13050 ${path.join(storeData, 'updater-secret')}`);
    // a folder the build uid must not write to
    mkdirp(path.join(M, 'outside'));
    const mounts = path.join(M, 'mounts');
    fs.writeFileSync(mounts, 'proc /proc proc rw 0 0\n');

    /* -- the fake GitHub's repos -- */
    const assetsOf = (repo, files) => {
        gh.repos[repo].files = {};
        return files.map((f) => {
            gh.repos[repo].files[path.basename(f.file)] = fs.readFileSync(f.file);
            const e = entry(f.file, f.kind, f.title);
            e.artifact.url = `${API}/repos/${repo}/releases/assets/${encodeURIComponent(path.basename(f.file))}`;
            return Object.assign(e, f.extra || {});
        });
    };
    const pub = path.join(M, 'pub');
    mkdirp(pub);
    ghRepo('robertnisipeanu/mgu-store');
    const storeEntries = assetsOf('robertnisipeanu/mgu-store', [
        { file: appTgz(pub, 'robertn_demo', '1.0.0'), kind: 'app', title: 'Demo' },
        { file: toolKit(pub, 'base_tool', '1.0.0', { 'base.sh': ['#!/bin/sh\n', 0o755] }), kind: 'tool', title: 'Base', extra: { uninstallable: true } },
        { file: appTgz(pub, 'needs_app', '1.0.0'), kind: 'app', title: 'Needs', extra: { requires: { base_tool: '1.0.0' }, uninstallable: true } },
        { file: appTgz(pub, 'dup_app', '1.0.0'), kind: 'app', title: 'Dup one' },
        { file: toolKit(pub, 'opt_tool', '1.0.0', { 'opt.sh': ['#!/bin/sh\n', 0o755] }), kind: 'tool', title: 'Optional', extra: { optional: true } },
        { file: appTgz(pub, 'lonely_app', '1.0.0'), kind: 'app', title: 'Lonely', extra: { requires: { missing_dep: '1.0.0' } } }
    ]);
    gh.repos['robertnisipeanu/mgu-store'].catalog = Buffer.from(JSON.stringify({ schema: 2, commit: 'c0ffee', components: storeEntries }));
    // a second source: a folder with the same id at another version
    const second = path.join(M, 'second');
    mkdirp(second);
    publish(second, [entry(appTgz(second, 'dup_app', '2.0.0'), 'app', 'Dup two')]);
    // a private repo with its own catalog
    ghRepo('owner/private', { private: true, tokens: ['tok-all', 'tok-device'] });
    gh.repos['owner/private'].catalog = Buffer.from(JSON.stringify({ schema: 1, components:
        assetsOf('owner/private', [{ file: appTgz(pub, 'priv_app', '1.0.0'), kind: 'app', title: 'Private' }]) }));
    // a second private repo the same token reaches, and a third only another token reaches
    ghRepo('owner/private2', { private: true, tokens: ['tok-all'] });
    gh.repos['owner/private2'].catalog = Buffer.from(JSON.stringify({ schema: 1, components: [] }));
    ghRepo('other/third', { private: true, tokens: ['tok-third'] });
    gh.repos['other/third'].catalog = Buffer.from(JSON.stringify({ schema: 1, components: [] }));
    // releases layout: packages attached to releases, the newest of each id
    const relDir = path.join(M, 'rel');
    mkdirp(relDir);
    const asset = (file) => ({ name: path.basename(file), data: fs.readFileSync(file) });
    const mgu = (id, version) => {
        const src = path.join(T, 'src', `${id}@${version}.mgu`);
        mkdirp(path.join(src, 'source'));
        fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ id, version, title: id, kit: 1 }));
        fs.writeFileSync(path.join(src, 'source', 'package.json'), JSON.stringify({ name: id, version }));
        mkdirp(path.join(src, 'rhmiData', 'variantGroups', 'Common', 'texts'));
        fs.writeFileSync(path.join(src, 'rhmiData', 'application.json'), JSON.stringify({ application: { name: id, entryPoints: [{ textId: 'SID_T' }] } }));
        fs.writeFileSync(path.join(src, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), JSON.stringify({ SID_T: `${id} entry` }));
        sh(`tar -czf ${path.join(relDir, `${id}@${version}.mgu`)} -C ${src} meta.json source rhmiData`);
        return path.join(relDir, `${id}@${version}.mgu`);
    };
    ghRepo('third/rel', { releases: [
        { draft: true, assets: [asset(appTgz(relDir, 'rel_app', '9.9.9'))] },
        { prerelease: true, assets: [asset(appTgz(relDir, 'rel_app', '5.0.0'))] },
        { assets: [asset(appTgz(relDir, 'rel_app', '1.1.0')), asset(mgu('rel_app', '1.1.0')),
            { name: 'mgu-store.json', data: Buffer.from(JSON.stringify({ apps: { rel_app: { title: 'Release App', description: 'd' } } })) }] },
        { assets: [asset(appTgz(relDir, 'rel_app', '1.0.0')), asset(mgu('mgu_only', '0.1.0')), { name: 'notes.txt', data: Buffer.from('x') }] }
    ] });
    // a repo built on the unit, on a branch
    const buildJs = [
        "const fs = require('fs'); const path = require('path'); const cp = require('child_process');",
        'const [mode, id, where] = process.argv.slice(2);',
        "if (mode === 'fail') { console.log('failing on purpose'); process.exit(3); }",
        "if (mode === 'slow') { setInterval(() => {}, 1000); }",
        "if (mode === 'escape') { fs.writeFileSync(where, 'x'); }",
        "if (mode === 'detach') { cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' }).unref(); }",
        "if (mode === 'ok' || mode === 'detach') {",
        "  const app = JSON.parse(fs.readFileSync(path.join('apps', id, 'app.json'), 'utf8'));",
        "  const dir = path.join(process.env.TMPDIR, 'pkg'); fs.mkdirSync(dir);",
        "  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: id, version: app.version,",
        "    donor: fs.readFileSync(process.env.MGU_SDK_DONOR, 'utf8'), uid: process.getuid(), cwd: process.cwd() }));",
        "  cp.execFileSync('tar', ['-czf', path.join(process.env.MGU_OUT, `${id}@${app.version}.tgz`), '-C', dir, 'package.json']);",
        "  console.log('built');",
        '}'
    ].join('\n');
    const tTool = { id: 't_tool', kind: 'tool', version: '1.0.0', title: 'Tree tool',
        files: [{ path: 't.sh', from: 'bin/t.sh', mode: '0755' }], units: [{ name: 't.service', from: 'systemd/t.service' }], internet: true };
    const branchFiles = (pVersion) => ({
        'mgu-repo.json': JSON.stringify({ schema: 1, components: [
            { id: 'p_app', kind: 'app', path: 'apps/p_app', build: 'unit', uninstallable: true },
            { id: 't_tool', kind: 'tool', path: 'native/t_tool' },
            { id: 'b_ok', kind: 'app', path: 'apps/b_ok', build: { node: 'tools/build.js', args: ['ok', 'b_ok'] } },
            { id: 'b_fail', kind: 'app', path: 'apps/b_fail', build: { node: 'tools/build.js', args: ['fail', 'b_fail'] } },
            { id: 'b_slow', kind: 'app', path: 'apps/b_slow', build: { node: 'tools/build.js', args: ['slow', 'b_slow'] } },
            { id: 'b_escape', kind: 'app', path: 'apps/b_escape', build: { node: 'tools/build.js', args: ['escape', 'b_escape', path.join(M, 'outside', 'x')] } },
            { id: 'b_detach', kind: 'app', path: 'apps/b_detach', build: { node: 'tools/build.js', args: ['detach', 'b_detach'] } },
            { id: 'bad_tool', kind: 'tool', path: 'native/bad_tool' }
        ] }),
        'apps/p_app/mgu-app.json': JSON.stringify({ schema: 1, id: 'p_app', version: pVersion, title: 'Package app', tree: `p_app@${pVersion}`, modules: ['src/p.js'], sdk: [] }),
        [`apps/p_app/p_app@${pVersion}/package.json`]: JSON.stringify({ name: 'p_app', version: pVersion }),
        'apps/p_app/src/p.js': 'module.exports = 1;\n',
        'native/t_tool/component.json': JSON.stringify(tTool),
        'native/t_tool/bin/t.sh': ['#!/bin/sh\necho t\n', 0o755],
        'native/t_tool/systemd/t.service': '[Service]\nExecStart=/bin/true\n',
        'native/bad_tool/component.json': JSON.stringify({ id: 'bad_tool', kind: 'tool', version: '1.0.0', build: ['make'], files: [] }),
        'apps/b_ok/app.json': JSON.stringify({ id: 'b_ok', version: '1.0.0', title: 'Built here' }),
        'apps/b_fail/app.json': JSON.stringify({ id: 'b_fail', version: '1.0.0' }),
        'apps/b_slow/package.json': JSON.stringify({ name: 'b_slow', version: '1.0.0' }),
        'apps/b_escape/app.json': JSON.stringify({ id: 'b_escape', version: '1.0.0' }),
        'apps/b_detach/app.json': JSON.stringify({ id: 'b_detach', version: '1.0.0' }),
        'tools/build.js': buildJs
    });
    ghRepo('third/branchy');
    const c1 = ghCommit('third/branchy', branchFiles('1.0.0'));
    gh.repos['third/branchy'].branches.main = c1;
    // a repo on its tags
    ghRepo('third/tagged');
    const tagTree = (v) => ghCommit('third/tagged', {
        'mgu-repo.json': JSON.stringify({ schema: 1, components: [{ id: 'tag_tool', kind: 'tool', path: 'tool' }] }),
        'tool/component.json': JSON.stringify({ id: 'tag_tool', kind: 'tool', version: v, files: [{ path: 'x', mode: '0644' }] }),
        'tool/x': v
    });
    gh.repos['third/tagged'].tags = [{ name: 'v1.0.0', sha: tagTree('1.0.0') }, { name: 'tag_tool@1.2.0', sha: tagTree('1.2.0') },
        { name: '1.1.0', sha: tagTree('1.1.0') }, { name: 'nightly', sha: tagTree('9.0.0') }];
    // a repo without releases: its default branch
    ghRepo('third/plain', { default_branch: 'trunk' });
    gh.repos['third/plain'].branches.trunk = ghCommit('third/plain', {
        'mgu-repo.json': JSON.stringify({ schema: 1, components: [{ id: 'plain_tool', kind: 'tool', path: 'pt' }] }),
        'pt/component.json': JSON.stringify({ id: 'plain_tool', kind: 'tool', version: '0.0.1', files: [] })
    });

    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [
        { id: 'mgu-store', type: 'github', repo: 'robertnisipeanu/mgu-store', builtin: true },
        { id: 'second', type: 'file', path: second },
        { id: 'private', type: 'github', repo: 'owner/private' },
        { id: 'rel', type: 'github', repo: 'third/rel' },
        { id: 'branchy', type: 'github', repo: 'third/branchy', channel: 'branch' },
        { id: 'hp', type: 'https', url: `https://updates.test:${HTTPS_PORT}/private/catalog.json` }
    ] }));
    fs.writeFileSync(path.join(pub, 'catalog.json'), JSON.stringify({ schema: 1, components: [] }));
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: state, tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'),
        github_api: API, github_web: GH_WEB, github_client_id: 'Iv1.test', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts, usb_roots: media, web_secret: path.join(M, 'run', 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    const u = new Updater(conf);
    const st = () => u.state();
    const src = (id) => st().sources.find((s) => s.id === id) || {};
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    const sock = conf.socket;
    let secret = null;
    const priv = (req) => ask(sock, Object.assign({ secret }, req));
    const installed = (id) => until(st, (s) => !s.busy && !s.components.some((c) => c.queued) && comp(id).status === 'installed', 60000, `${id} installed`);
    const settled = () => until(st, (s) => !s.busy && !s.components.some((c) => c.queued) && !s.sources.some((x) => x.status === 'checking'), 60000, 'settled');
    const authLeaks = () => seen.filter((x) => x.auth && !/^api\.github\.com/.test(x.host) && !/^updates\.test/.test(x.host));

    return u.serve()
        .then(() => u.writeSecrets())
        .then(() => {
            const file = path.join(storeData, 'updater-secret');
            const fst = fs.lstatSync(file);
            ok('secret: the Store\'s copy is its uid\'s own 0400 file in its data folder, written over a link put there',
                fst.isFile() && fst.uid === 13050 && (fst.mode & 0o777) === 0o400 && fs.readFileSync(file, 'utf8') === u.secret &&
                fs.readFileSync(path.join(M, 'victim'), 'utf8') === 'untouched');
            const wst = fs.statSync(conf.web_secret);
            ok('secret: the phone page\'s copy is the web uid\'s 0400 file', wst.uid === 12996 && wst.gid === 12202 &&
                (wst.mode & 0o777) === 0o400 && fs.readFileSync(conf.web_secret, 'utf8') === u.secret);
            ok('secret: 32 random bytes per start', /^[0-9a-f]{64}$/.test(u.secret) && new Updater({ state_dir: state }).secret !== u.secret);
            secret = fs.readFileSync(file, 'utf8');
            ok('secret: the Store\'s copy is seen as present', u.storeSecretGone() === false);
            fs.unlinkSync(file);
            ok('secret: ...and as gone once its data folder is emptied (MainApp\'s crash recovery)', u.storeSecretGone() === true);
            return u.writeSecrets();
        })
        .then(() => {
            const file = path.join(storeData, 'updater-secret');
            ok('secret: written again, the same', fs.readFileSync(file, 'utf8') === secret && !u.storeSecretGone());
            return Promise.all([ask(sock, { op: 'source-add', type: 'github', repo: 'a/b' }),
                ask(sock, { op: 'source-remove', id: 'second', secret: 'f'.repeat(64) }),
                ask(sock, { op: 'token-add', token: 'tok-all', secret: secret.slice(1) })]);
        })
        .then((errs) => {
            ok('privileged: without the secret, or with a wrong one, a request is forbidden',
                errs.every((e) => e === 'forbidden') && u.stored.length === 6 && u.tokens.all().length === 0, JSON.stringify(errs));
            return u.check();
        })
        .then(() => {
            const s = st();
            ok('sources: each is read and reported', ['mgu-store', 'second', 'rel', 'branchy'].every((id) => src(id).status === 'ok') &&
                src('mgu-store').components === 6 && src('rel').channel === 'releases' && src('branchy').channel === 'branch:main' &&
                src('mgu-store').builtin && !src('second').builtin && src('second').label === second, JSON.stringify(s.sources));
            ok('sources: a private repo without a token needs auth', src('private').status === 'auth-needed' && src('private').auth === null,
                JSON.stringify(src('private')));
            ok('sources: a public repo is read without a token', src('mgu-store').auth === null && s.tokens.length === 0);
            ok('sources: an https source is read without a token; one answering 401 is an error', src('hp').status === 'error' &&
                /401/.test(src('hp').error) && !seen.some((x) => x.url.indexOf('/private/') === 0 && x.auth), JSON.stringify(src('hp')));
            ok('collision: an id two sources list is shown once, at the highest version any lists',
                s.components.filter((c) => c.id === 'dup_app').length === 1 && comp('dup_app').source === 'second' && comp('dup_app').version === '2.0.0');
            ok('state: rows carry their source and schema-2 fields', comp('needs_app').uninstallable === true && comp('opt_tool').optional === true &&
                comp('robertn_demo').build === null && comp('p_app').build === 'unit' && comp('robertn_demo').revision === null);
            ok('releases: the newest package of each id, drafts and prereleases left out, the .tgz over the .mgu',
                comp('rel_app').version === '1.1.0' && comp('rel_app').title === 'Release App' && comp('mgu_only').version === '0.1.0' &&
                comp('mgu_only').title === 'mgu_only' && src('rel').components === 2, JSON.stringify([comp('rel_app'), comp('mgu_only')]));
            ok('releases: every app can be removed', comp('rel_app').uninstallable === true && comp('mgu_only').uninstallable === true);
            ok('repo: a branch lists its components, with their revision, leaving out what cannot be used and saying why',
                comp('p_app').revision === c1.slice(0, 7) && comp('t_tool').version === '1.0.0' && comp('b_ok').title === 'Built here' &&
                comp('b_slow').version === '1.0.0' && !comp('bad_tool').id && /bad_tool: .*no build step/.test(src('branchy').error || ''),
                JSON.stringify(src('branchy')));
            ok('state: the Store 0.3\'s catalog line names the failing source', /owner\/private|updates\.test/.test(s.catalog.error || ''), s.catalog.error);
            ok('github: no token went anywhere but the API host', authLeaks().length === 0);
            return priv({ op: 'token-add', token: 'tok-wrong' });
        })
        .then((err) => {
            ok('token-add: a token GitHub rejects is refused, nothing stored', /does not accept/.test(err || '') && u.tokens.all().length === 0 &&
                !fs.existsSync(path.join(M, 'cred', 'tokens.json')), err);
            return priv({ op: 'token-add', token: ' tok-all\n', label: '' });
        })
        .then((err) => until(st, () => src('private').status === 'ok', 20000, 'the private repo read').then(() => err))
        .then((err) => {
            const t = st().tokens;
            const id = t[0] && t[0].id;
            const list = JSON.parse(fs.readFileSync(path.join(M, 'cred', 'tokens.json'), 'utf8'));
            ok('token-add: stored as its own token, labelled with its account', err === null && t.length === 1 && t[0].login === 'tester' &&
                t[0].label === 'tester' && t[0].kind === 'github' && /^[0-9a-f]{8}$/.test(id) &&
                fs.readFileSync(path.join(M, 'cred', `token-${id}`), 'utf8') === 'tok-all\n' &&
                (fs.statSync(path.join(M, 'cred', `token-${id}`)).mode & 0o777) === 0o600 && (fs.statSync(path.join(M, 'cred', 'tokens.json')).mode & 0o777) === 0o600 &&
                list[0].id === id && list[0].scopes === 'repo', JSON.stringify([err, t, list]));
            ok('token: the source that needed one is read with it; the account shows', src('private').auth && src('private').auth.token === id &&
                src('private').auth.login === 'tester' && comp('priv_app').version === '1.0.0' && t[0].usedBy.join() === 'private', JSON.stringify(src('private')));
            ok('token: a public repo stays read without one', src('mgu-store').auth === null);
            ok('token: never in the state', JSON.stringify(st()).indexOf('tok-all') < 0);
            seen.length = 0;
            return priv({ op: 'source-add', type: 'github', repo: 'owner/private2' });
        })
        .then((err) => until(st, () => src('private2').status === 'ok', 20000, 'the second private repo read').then(() => err))
        .then((err) => {
            const id = st().tokens[0].id;
            ok('token: a repo added later is read with a stored token that reaches it', err === null && src('private2').auth.token === id &&
                st().tokens[0].usedBy.sort().join() === 'private,private2' && st().tokens.length === 1, JSON.stringify(st().tokens));
            return priv({ op: 'source-add', type: 'github', repo: 'other/third' });
        })
        .then(() => until(st, () => src('third').status === 'auth-needed', 20000, 'the third repo refused'))
        .then(() => {
            ok('token: a repo no stored token reaches needs auth', src('third').auth === null);
            // a token the deploy tool writes (its file and its entry) while the repo is being read with
            // the tokens there were, and just before a write of the updater's own: picked up without a
            // request, and the repo read again once that read is done
            seen.length = 0;
            gh.repos['other/third'].delayMs = 1500;
            u.checkSource('third');
            return until(() => seen.some((x) => /\/repos\/other\/third/.test(x.url)), (x) => x, 10000, 'the read under way');
        })
        .then(() => {
            const list = JSON.parse(fs.readFileSync(path.join(M, 'cred', 'tokens.json'), 'utf8'));
            fs.writeFileSync(path.join(M, 'cred', 'token-0badc0de'), 'tok-third\n', { mode: 0o600 });
            list.push({ id: '0badc0de', kind: 'github', addedAt: Date.now() });
            fs.writeFileSync(path.join(M, 'cred', 'tokens.json'), JSON.stringify(list));
            u.tokens.update(list[0].id, { label: 'tester' });
            ok('token files: a change is noticed, also after a write of the updater\'s own', src('third').status === 'checking' &&
                u.scanTokens() === true && u.scanTokens() === false);
            gh.repos['other/third'].delayMs = 0;
            return until(st, () => src('third').status === 'ok' && (st().tokens.find((t) => t.id === '0badc0de') || {}).login === 'other-acct',
                20000, 'the third repo read with the new token');
        })
        .then(() => {
            ok('token files: a token the deploy tool adds reads the repo that needed it, and is checked with GitHub',
                src('third').auth.token === '0badc0de' && src('private').auth.token !== '0badc0de' && st().tokens.length === 2);
            return priv({ op: 'token-add', token: 'tok-all' });
        })
        .then((err) => {
            ok('token-add: the same token again is not stored twice', err === null && st().tokens.length === 2 &&
                fs.readdirSync(path.join(M, 'cred')).filter((n) => /^token-/.test(n)).length === 2);
            return Promise.all([priv({ op: 'token-remove', id: '0badc0de' }), priv({ op: 'token-remove', id: 'nope' })]);
        })
        .then((errs) => until(st, () => src('third').status === 'auth-needed', 20000, 'the third repo without its token').then(() => errs))
        .then((errs) => {
            ok('token-remove: the repo only it reached needs auth again; the others keep theirs', errs[0] === null && /no token nope/.test(errs[1]) &&
                !fs.existsSync(path.join(M, 'cred', 'token-0badc0de')) && src('private').status === 'ok' && src('private2').status === 'ok' &&
                !JSON.parse(fs.readFileSync(path.join(M, 'cred', 'tokens.json'), 'utf8')).some((t) => t.id === '0badc0de'), JSON.stringify(errs));
            return priv({ op: 'source-remove', id: 'third' });
        })
        .then(() => {
            seen.length = 0;
            return priv({ op: 'login-start' });
        })
        .then((err) => {
            ok('login: started', err === null, err);
            return until(st, (s) => s.login && s.login.code === 'ABCD-1234', 10000, 'a device code');
        })
        .then((s) => {
            ok('login: the code and address show', s.login.url === 'https://github.com/login/device' && s.login.status === 'pending' && !('source' in s.login));
            return until(st, (x) => x.login && x.login.status === 'done', 20000, 'signed in');
        })
        .then(() => {
            const dev = st().tokens.find((t) => t.id !== st().tokens[0].id);
            const entry = JSON.parse(fs.readFileSync(path.join(M, 'cred', 'tokens.json'), 'utf8')).find((t) => dev && t.id === dev.id) || {};
            ok('login: the device flow\'s token is a token of its own, labelled with the account, after pending and slow_down',
                dev && dev.label === 'tester' && fs.readFileSync(path.join(M, 'cred', `token-${dev.id}`), 'utf8') === 'tok-device\n' && gh.polls === 3 &&
                entry.refreshToken === 'refresh-1' && entry.device === true && entry.scopes === undefined, JSON.stringify([st().tokens, entry]));
            ok('login: github.com gets no token', seen.filter((x) => /^github\.com/.test(x.host)).every((x) => x.auth === null) &&
                seen.some((x) => /^github\.com/.test(x.host)) && authLeaks().length === 0);
            // an expired token is renewed with its refresh token before the next read
            const list = JSON.parse(fs.readFileSync(path.join(M, 'cred', 'tokens.json'), 'utf8'));
            list.find((t) => t.id === dev.id).expiresAt = Date.now() - 1000;
            fs.writeFileSync(path.join(M, 'cred', 'tokens.json'), JSON.stringify(list));
            u.scanTokens();
            return u.checkSource('private').then(() => dev.id);
        })
        .then((devId) => {
            ok('login: an expired token is renewed from its refresh token', gh.refreshes === 1 && src('private').status === 'ok' &&
                JSON.parse(fs.readFileSync(path.join(M, 'cred', 'tokens.json'), 'utf8')).find((t) => t.id === devId).expiresAt > Date.now());
            // checking the tokens with GitHub renews an expired one first
            const list = JSON.parse(fs.readFileSync(path.join(M, 'cred', 'tokens.json'), 'utf8'));
            list.find((t) => t.id === devId).expiresAt = Date.now() - 1000;
            fs.writeFileSync(path.join(M, 'cred', 'tokens.json'), JSON.stringify(list));
            gh.deviceExpired = true;
            u.scanTokens();
            return u.validateTokens().then(() => devId);
        })
        .then((devId) => {
            const t = st().tokens.find((x) => x.id === devId);
            ok('tokens: an expired sign-in token is renewed before GitHub is asked about it, not rejected', gh.refreshes === 2 &&
                t.rejected === false && t.login === 'tester', JSON.stringify(t));
            // the token that reads both private repos goes: the device token reaches one of them
            return priv({ op: 'token-remove', id: st().tokens.find((t) => t.id !== devId).id }).then(() => devId);
        })
        .then((devId) => until(st, () => src('private').status === 'ok' && src('private').auth && src('private').auth.token === devId &&
            src('private2').status === 'auth-needed', 20000, 'the sources re-read').then(() => devId))
        .then((devId) => {
            ok('token-remove: each source falls back to another token that reaches it, else needs auth',
                st().tokens.length === 1 && st().tokens[0].usedBy.join() === 'private' && src('private2').auth === null);
            gh.device = { error: 'access_denied' };
            return priv({ op: 'login-start' });
        })
        .then(() => until(st, (s) => s.login && s.login.status === 'error', 10000, 'a denied sign-in'))
        .then((s) => {
            ok('login: a sign-in denied on GitHub is an error', /cancelled/.test(s.login.error));
            gh.device = null;
            return priv({ op: 'login-cancel' });
        })
        .then(() => {
            ok('login: cancelled, gone from the state', st().login === null);
            return priv({ op: 'source-remove', id: 'private2' });
        })
        .then(() => {
            // requirements first
            fs.writeFileSync(deployLog, '');
            return ask(sock, { op: 'install', id: 'needs_app' });
        })
        .then((err) => {
            ok('install: unprivileged, as for the Store 0.3', err === null, err);
            return installed('needs_app');
        })
        .then(() => {
            const lines = deployed();
            ok('requires: a missing requirement installs first', lines.length === 2 && /base_tool@1\.0\.0/.test(lines[0]) &&
                /needs_app@1\.0\.0/.test(lines[1]) && comp('base_tool').status === 'installed', JSON.stringify(lines));
            const origins = JSON.parse(fs.readFileSync(path.join(state, 'origins.json'), 'utf8'));
            ok('origins: the source each was installed from', origins.needs_app.source === 'mgu-store' && origins.base_tool.source === 'mgu-store');
            return ask(sock, { op: 'install', id: 'lonely_app' });
        })
        .then(() => until(st, () => comp('lonely_app').error, 10000, 'the missing requirement'))
        .then(() => {
            ok('requires: a requirement no source has is the row\'s error, and nothing installs',
                /needs missing_dep 1\.0\.0 or newer, which no source has/.test(comp('lonely_app').error) && deployed().length === 2, comp('lonely_app').error);
            return Promise.all([ask(sock, { op: 'uninstall', id: 'needs_app' }), priv({ op: 'uninstall', id: 'base_tool' }),
                priv({ op: 'uninstall', id: 'robertn_demo' }), priv({ op: 'uninstall', id: 'opt_tool' })]);
        })
        .then((errs) => {
            ok('uninstall: privileged; refused while something installed requires it, for what its source does not mark, and when not installed',
                errs[0] === 'forbidden' && /Needs needs base_tool/.test(errs[1]) && /cannot be removed/.test(errs[2]) && /cannot be removed/.test(errs[3]),
                JSON.stringify(errs));
            const phases = [];
            const t = setInterval(() => {
                if (u.busy && u.busy.id === 'needs_app' && phases.indexOf(u.busy.phase) < 0) {
                    phases.push(u.busy.phase);
                }
            }, 5);
            return priv({ op: 'uninstall', id: 'needs_app' })
                .then((err) => until(st, () => !st().busy && comp('needs_app').status === 'available', 20000, 'needs_app removed')
                    .then(() => {
                        clearInterval(t);
                        return { err, phases };
                    }));
        })
        .then(({ err, phases }) => {
            ok('uninstall: busy.phase is uninstall', phases.join() === 'uninstall', phases.join());
            ok('uninstall: through the deploy tool\'s uninstall; the row is available again', err === null &&
                /^uninstall needs_app --yes$/m.test(fs.readFileSync(deployLog, 'utf8')) &&
                !JSON.parse(fs.readFileSync(path.join(state, 'origins.json'), 'utf8')).needs_app);
            // collision: a higher version wins over the source that installed an id
            fs.writeFileSync(deployLog, '');
            u.origins.dup_app = { source: 'mgu-store', commit: null };
            ok('collision: a newer version elsewhere is offered over the source that installed it',
                comp('dup_app').source === 'second' && comp('dup_app').version === '2.0.0');
            delete u.origins.dup_app;
            return ask(sock, { op: 'install', id: 'rel_app' });
        })
        .then(() => installed('rel_app'))
        .then(() => {
            ok('releases: a release package installs, its sha256 taken on download', /install --artifact .*rel_app@1\.1\.0\.tgz --yes/.test(deployed()[0]));
            return ask(sock, { op: 'install', id: 'mgu_only' });
        })
        .then(() => installed('mgu_only'))
        .then(() => {
            ok('releases: an .mgu goes to the deploy tool as it is', /mgu_only@0\.1\.0\.mgu --yes/.test(deployed()[1]));
            ok('releases: an installed app without a listed title shows its entry point\'s en_GB text', comp('mgu_only').title === 'mgu_only entry',
                comp('mgu_only').title);
            fs.writeFileSync(deployLog, '');
            return ask(sock, { op: 'install', id: 'p_app' });
        })
        .then(() => installed('p_app'))
        .then(() => {
            const pkg = JSON.parse(fs.readFileSync(path.join(oap, `oap_${JSON.parse(fs.readFileSync(path.join(oap, 'oap_12201', 'data', 'apps', 'p_app.json'))).userId}`, 'source', 'package.json')));
            ok('repo: an app with mgu-app.json goes to the deploy tool as a source package of its folder', pkg.built === true && pkg.tree === 'p_app@1.0.0');
            ok('origins: a branch install records its commit', JSON.parse(fs.readFileSync(path.join(state, 'origins.json'), 'utf8')).p_app.commit === c1);
            return ask(sock, { op: 'install', id: 't_tool' });
        })
        .then(() => installed('t_tool'))
        .then(() => {
            const dir = path.join(opt, 't_tool', 'current');
            const c = JSON.parse(fs.readFileSync(path.join(dir, 'component.json'), 'utf8'));
            ok('repo: a tool is packed as a tool kit, each file with its sha256, the rest of component.json kept',
                c.files[0].path === 't.sh' && c.files[0].sha256 === sha256(Buffer.from('#!/bin/sh\necho t\n')) && !c.files[0].from &&
                c.units[0].name === 't.service' && c.internet === true && fs.readFileSync(path.join(dir, 't.sh'), 'utf8') === '#!/bin/sh\necho t\n');
            ok('github: the tarball came from codeload without the token', seen.some((x) => /^codeload/.test(x.host) && x.auth === null) && authLeaks().length === 0);
            // the branch moves on, same versions
            const c2 = ghCommit('third/branchy', branchFiles('1.0.0'));
            gh.repos['third/branchy'].branches.main = c2;
            return u.checkSource('branchy').then(() => c2);
        })
        .then((c2) => {
            ok('branch: a new commit of the same version is an update, with its short commit',
                comp('p_app').status === 'update' && comp('p_app').revision === c2.slice(0, 7) && comp('t_tool').status === 'update', JSON.stringify(comp('p_app')));
            return ask(sock, { op: 'install', id: 'p_app' }).then(() => installed('p_app')).then(() => c2);
        })
        .then((c2) => {
            ok('branch: installed at the new commit', JSON.parse(fs.readFileSync(path.join(state, 'origins.json'), 'utf8')).p_app.commit === c2);
            gh.repos['third/branchy'].branches.main = ghCommit('third/branchy', branchFiles('1.1.0'));
            return u.checkSource('branchy');
        })
        .then(() => {
            ok('branch: a new version is an update', comp('p_app').status === 'update' && comp('p_app').version === '1.1.0');
            const phases = [];
            const t = setInterval(() => {
                const b = u.busy;
                if (b && b.id === 'b_ok' && phases[phases.length - 1] !== b.phase) {
                    phases.push(b.phase);
                }
            }, 5);
            return ask(sock, { op: 'install', id: 'b_ok' }).then(() => until(st, () => !st().busy && (comp('b_ok').status === 'installed' || comp('b_ok').error), 60000, 'b_ok built')
                .then(() => {
                    clearInterval(t);
                    ok('build: busy.phase is build while the script runs', /^download,build,(verify,)?install$/.test(phases.join()), phases.join());
                }));
        })
        .then(() => {
            const reg = JSON.parse(fs.readFileSync(path.join(oap, 'oap_12201', 'data', 'apps', 'b_ok.json')));
            const pkg = JSON.parse(fs.readFileSync(path.join(oap, `oap_${reg.userId}`, 'source', 'package.json')));
            ok('build: the repo\'s script runs as the build uid in a copy of the repo, with the donor, and its package installs',
                comp('b_ok').status === 'installed' && pkg.uid === 12995 && pkg.donor === '// the SDK donor bundle\n' &&
                /\/state\/build-[0-9a-f]+\/repo$/.test(pkg.cwd), JSON.stringify([comp('b_ok').error, pkg]));
            return ask(sock, { op: 'install', id: 'b_fail' });
        })
        .then(() => until(st, () => !st().busy && comp('b_fail').error, 30000, 'b_fail'))
        .then(() => {
            ok('build: a failing script is the row\'s error, nothing installed', /the build failed \(exit 3\)/.test(comp('b_fail').error) &&
                comp('b_fail').status === 'available', comp('b_fail').error);
            return ask(sock, { op: 'install', id: 'b_slow' });
        })
        .then(() => until(st, () => !st().busy && comp('b_slow').error, 30000, 'b_slow'))
        .then(() => {
            let left = '';
            try {
                left = sh('pgrep -u 12995 || true').trim();
            } catch (e) { /* none */ }
            ok('build: a script past build_timeout_s is stopped, its processes too', /took longer than 3 s/.test(comp('b_slow').error) && left === '',
                `${comp('b_slow').error} ${left}`);
            return ask(sock, { op: 'install', id: 'b_escape' });
        })
        .then(() => until(st, () => !st().busy && comp('b_escape').error, 30000, 'b_escape'))
        .then(() => sleep(1500))
        .then(() => {
            ok('build: a script cannot write outside its folder', !fs.existsSync(path.join(M, 'outside', 'x')) && /the build failed/.test(comp('b_escape').error),
                comp('b_escape').error);
            ok('build: build folders are removed afterwards', fs.readdirSync(state).filter((n) => /^build-/.test(n)).length === 0,
                fs.readdirSync(state).join(' '));
            return ask(sock, { op: 'install', id: 'b_detach' }).then(() => installed('b_detach'));
        })
        .then(() => {
            ok('build: a process the script leaves running outside its group is killed', sh('pgrep -u 12995 || true').trim() === '');
            // tags, and a repo without releases, added through the socket
            return Promise.all([priv({ op: 'source-add', type: 'github', repo: 'third/tagged', channel: 'tags' }),
                priv({ op: 'source-add', type: 'github', repo: 'third/plain' }),
                priv({ op: 'source-add', type: 'github', repo: 'Third/Tagged' }),
                priv({ op: 'source-add', type: 'github', repo: 'x/y', channel: 'nightly' }),
                priv({ op: 'source-add', type: 'https', url: 'http://plain.test/catalog.json' })]);
        })
        .then((errs) => {
            ok('source-add: github with a channel, without; refused twice, with a bad channel, or not https',
                errs[0] === null && errs[1] === null && /already a source/.test(errs[2]) && /channel/.test(errs[3]) && /https/.test(errs[4]), JSON.stringify(errs));
            return until(st, () => src('tagged').status === 'ok' && src('plain').status === 'ok', 20000, 'the added sources read');
        })
        .then(() => {
            const saved = JSON.parse(fs.readFileSync(sources, 'utf8')).sources;
            ok('source-add: written to sources.json, root-only', saved.some((x) => x.id === 'tagged' && x.channel === 'tags') &&
                saved.some((x) => x.id === 'plain' && x.channel === undefined) && (fs.statSync(sources).mode & 0o777) === 0o600);
            ok('tags: the highest x.y.z tag (v, plain or <id>@) is read', comp('tag_tool').version === '1.2.0' && comp('tag_tool').revision === null &&
                src('tagged').channel === 'tags', JSON.stringify(comp('tag_tool')));
            ok('channel: a repo without releases follows its default branch', src('plain').channel === 'branch:trunk' && comp('plain_tool').id === 'plain_tool');
            return Promise.all([priv({ op: 'source-remove', id: 'mgu-store' }), priv({ op: 'source-remove', id: 'second' })]);
        })
        .then((errs) => {
            ok('source-remove: the built-in source stays; another goes', /cannot be removed/.test(errs[0]) && errs[1] === null &&
                !st().sources.some((x) => x.id === 'second') && comp('dup_app').source === 'mgu-store');
            // USB media
            const stick = path.join(media, 'STICK');
            mkdirp(path.join(stick, 'usbtool'));
            fs.writeFileSync(path.join(stick, 'mgu-repo.json'), JSON.stringify({ schema: 1, components: [
                { id: 'usb_tool', kind: 'tool', path: 'usbtool' }, { id: 'leak_tool', kind: 'tool', path: 'leak' }] }));
            fs.writeFileSync(path.join(stick, 'usbtool', 'component.json'), JSON.stringify({ id: 'usb_tool', kind: 'tool', version: '0.3.0',
                files: [{ path: 'u.sh', mode: '0755' }] }));
            fs.writeFileSync(path.join(stick, 'usbtool', 'u.sh'), '#!/bin/sh\n');
            fs.symlinkSync('/etc', path.join(stick, 'leak'));
            fs.symlinkSync('/etc', path.join(stick, 'mgu-repo'));
            const spaced = path.join(media, 'My Stick');
            mkdirp(path.join(spaced, 'mgu-repo', 'one'));
            const one = path.join(spaced, 'mgu-repo', 'one');
            const copyInto = (dir, file) => {
                fs.copyFileSync(file, path.join(dir, path.basename(file)));
                return path.join(dir, path.basename(file));
            };
            // besides its own app: a newer base_tool (installed from mgu-store) and robertn_demo at mgu-store's version
            publish(one, [entry(appTgz(one, 'usb_app', '0.1.0'), 'app', 'From USB'),
                entry(copyInto(one, toolKit(path.join(T, 'src'), 'base_tool', '1.1.0', { 'base.sh': ['#!/bin/sh\n', 0o755] })), 'tool', 'Base'),
                entry(appTgz(one, 'robertn_demo', '1.0.0'), 'app', 'Demo')]);
            // the App Manager's folder: packages under any name, npm package/ prefix or flat, .mgu, a root service
            const oapDir = path.join(stick, 'oap');
            mkdirp(oapDir);
            const pkgTgz = (file, prefix, pkg, rhmi) => {
                const d = path.join(T, 'src', `loose-${path.basename(file)}`);
                const top = prefix ? path.join(d, 'package') : d;
                mkdirp(path.join(top, 'rhmiData', 'variantGroups', 'Common', 'texts'));
                fs.writeFileSync(path.join(top, 'package.json'), JSON.stringify(pkg));
                if (rhmi) {
                    fs.writeFileSync(path.join(top, 'rhmiData', 'application.json'), JSON.stringify({ application: {
                        name: pkg.name, entryPoints: [{ textId: 'SID_TITLE' }], variantGroups: [{ stringsPath: './variantGroups/Common/texts' }] } }));
                    fs.writeFileSync(path.join(top, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), JSON.stringify({ SID_TITLE: rhmi }));
                }
                cp.execFileSync('tar', ['-czf', file, '-C', d, prefix ? 'package' : '.']);
            };
            pkgTgz(path.join(oapDir, 'App Manager v1.0.9.tgz'), true, { name: 'oap-appmanager', version: '1.0.9', productName: 'App Manager' }, 'Apps');
            pkgTgz(path.join(oapDir, 'older-manager.tar.gz'), true, { name: 'oap-appmanager', version: '1.0.2' }, null);
            pkgTgz(path.join(oapDir, 'flat.TGZ'), false, { name: 'flat_app', version: '2.0.0', productName: 'Flat' }, null);
            pkgTgz(path.join(oapDir, 'renderer.tgz'), true, { name: 'mgu-renderd', version: '1.0.0', mguService: { unit: 'x' } }, null);
            fs.copyFileSync(mgu('loose_mgu', '0.2.0'), path.join(oapDir, 'thing.mgu'));
            fs.writeFileSync(path.join(oapDir, 'README.txt'), 'not a package');
            fs.writeFileSync(path.join(oapDir, 'broken.tgz'), 'not gzip');
            fs.symlinkSync(path.join(relDir, 'rel_app@1.0.0.tgz'), path.join(oapDir, 'linked.tgz'));
            const evil = path.join(media, 'EVIL');
            mkdirp(evil);
            fs.writeFileSync(path.join(M, 'elsewhere.json'), JSON.stringify({ schema: 1, components: [] }));
            fs.symlinkSync(path.join(M, 'elsewhere.json'), path.join(evil, 'catalog.json'));
            fs.writeFileSync(mounts, `proc /proc proc rw 0 0\n/dev/sda1 ${stick} vfat rw 0 0\n/dev/sdb1 ${media}/My\\040Stick exfat rw 0 0\n` +
                `/dev/sdc1 ${evil} vfat rw 0 0\n/dev/sdd1 /mnt/other vfat rw 0 0\n`);
            const before = sh(`find ${media} -exec stat -c '%n %s %Y %a' {} +`);
            ok('usb: mounts under the media folder are found', u.scanUsb() === true);
            return until(st, () => src('usb:STICK').status === 'ok' && src('usb:My Stick/mgu-repo/one').status === 'ok', 20000, 'the sticks read')
                .then(() => ask(sock, { op: 'install', id: 'usb_tool' }))
                .then(() => installed('usb_tool'))
                .then(() => ask(sock, { op: 'install', id: 'usb_app' }))
                .then(() => installed('usb_app'))
                .then(() => until(st, () => src('usb:STICK/oap').status === 'ok', 20000, 'the oap folder read'))
                .then(() => {
                    ok('usb oap/: each package by its own package.json, the newest of an id, titles from rhmiData else productName',
                        comp('oap-appmanager').version === '1.0.9' && comp('oap-appmanager').title === 'Apps' &&
                        comp('flat_app').title === 'Flat' && comp('loose_mgu').version === '0.2.0' && comp('oap-appmanager').source === 'usb:STICK/oap',
                        JSON.stringify(st().components.filter((c) => /usb:STICK\/oap/.test(c.source))));
                    ok('usb oap/: every app can be removed', comp('flat_app').uninstallable === true && comp('loose_mgu').uninstallable === true);
                    ok('usb oap/: root-service packages, links and files that are not packages are left out',
                        !comp('mgu-renderd').id && comp('rel_app').source === 'rel' && src('usb:STICK/oap').components === 3 &&
                        /broken\.tgz/.test(src('usb:STICK/oap').error || '') && !/renderer|README|linked/.test(src('usb:STICK/oap').error || ''),
                        JSON.stringify(src('usb:STICK/oap')));
                    fs.writeFileSync(deployLog, '');
                    return ask(sock, { op: 'install', id: 'oap-appmanager' });
                })
                .then(() => installed('oap-appmanager'))
                .then(() => {
                    ok('usb oap/: a package installs under its id and version', /oap-appmanager@1\.0\.9\.tgz --yes/.test(deployed()[0]), deployed()[0]);
                    ok('usb: a newer version on a stick is an update of a component installed from a GitHub source',
                        JSON.parse(fs.readFileSync(path.join(state, 'origins.json'), 'utf8')).base_tool.source === 'mgu-store' &&
                        comp('base_tool').status === 'update' && comp('base_tool').version === '1.1.0' &&
                        comp('base_tool').source === 'usb:My Stick/mgu-repo/one', JSON.stringify(comp('base_tool')));
                    ok('usb: of equal versions a stick comes before a stored source', comp('robertn_demo').source === 'usb:My Stick/mgu-repo/one');
                    u.origins.robertn_demo = { source: 'mgu-store', commit: null };
                    ok('usb: ...and the source that installed it before a stick', comp('robertn_demo').source === 'mgu-store');
                    delete u.origins.robertn_demo;
                    fs.writeFileSync(deployLog, '');
                    return ask(sock, { op: 'install', id: 'base_tool' });
                })
                .then(() => installed('base_tool'))
                .then(() => {
                    ok('usb: the update installs from the stick, which becomes its origin',
                        /base_tool@1\.1\.0\.tgz --yes/.test(deployed()[0]) && comp('base_tool').installed === '1.1.0' &&
                        JSON.parse(fs.readFileSync(path.join(state, 'origins.json'), 'utf8')).base_tool.source === 'usb:My Stick/mgu-repo/one',
                        JSON.stringify(deployed()));
                    return before;
                });
        })
        .then((before) => {
            const usb = st().sources.filter((x) => x.usb);
            ok('usb: a stick\'s root and mgu-repo/<name> are sources; a link is not followed',
                usb.map((x) => x.id).join() === 'usb:My Stick/mgu-repo/one,usb:STICK,usb:STICK/oap' &&
                /leak_tool: leak: not a folder/.test(src('usb:STICK').error || '') && !usb.some((x) => /EVIL/.test(x.id)), JSON.stringify(usb));
            ok('usb: a repo-tree tool and a catalog app install from them', comp('usb_tool').installed === '0.3.0' && comp('usb_app').installed === '0.1.0' &&
                comp('usb_tool').source === 'usb:STICK');
            ok('usb: nothing on the stick changes', sh(`find ${media} -exec stat -c '%n %s %Y %a' {} +`) === before);
            fs.writeFileSync(mounts, 'proc /proc proc rw 0 0\n');
            u.scanUsb();
            ok('usb: a stick taken out is no longer a source', !st().sources.some((x) => x.usb) && !comp('usb_app').id);
            ok('usb: with the stick out, a component it installed follows the stored source again',
                comp('base_tool').source === 'mgu-store' && comp('base_tool').installed === '1.1.0' && comp('base_tool').status === 'newer',
                JSON.stringify(comp('base_tool')));
            return fs.existsSync(path.join(ROOT, 'js', 'web.js')) ? null : priv({ op: 'web', enable: true });
        })
        .then((err) => {
            if (!fs.existsSync(path.join(ROOT, 'js', 'web.js'))) {
                ok('web: without web.js the op says so and the state has no web', /no phone page/.test(err || '') && !('web' in st()), err);
            }
            return askRaw(sock, { op: 'status', rid: 'r-1' }).then((msg) => {
                ok('rid: the direct answer to a request carries its rid', msg.type === 'state' && msg.rid === 'r-1');
                return askRaw(sock, { op: 'logs', unit: 'mgu-updater', rid: 7 });
            }).then((msg) => ok('rid: a refused request\'s error carries it too', msg.type === 'error' && msg.error === 'forbidden' && msg.rid === 7));
        })
        .then(() => {
            // the Store 0.3's texts from this state
            const view = require('./fixtures/store_view_0.3.js');
            const s = st();
            const rows = s.components;
            const upd = rows.find((r) => r.status === 'update');
            const avail = rows.find((r) => r.status === 'available' && !r.error);
            const inst = rows.find((r) => r.status === 'installed' && !r.error);
            ok('old client: the Store 0.3 shows rows and offers installs from this state',
                /^Update /.test(view.rowState(upd, null)) && view.rowAction(upd, null) === 'install' &&
                /^Install /.test(view.rowState(avail, null)) && view.rowAction(avail, null) === 'install' &&
                /^Installed /.test(view.rowState(inst, null)) && view.rowAction(inst, null) === null &&
                view.rowState(upd, { id: upd.id, phase: 'build' }) === 'Installing' && typeof view.statusLine(s, true) === 'string' &&
                typeof view.groupState(rows.filter((r) => r.kind === 'app'), null) === 'string',
                JSON.stringify([upd, avail, inst].map((r) => r && r.id)));
        })
        .then(() => {
            // the phone page's address with its token, in the Store's data folder while it is on
            const real = fs.existsSync(path.join(ROOT, 'js', 'web.js')) ? require('../js/web') : null;
            const stub = { urls: [], onChange: null, enabled: false, UNITS: ['mgu-updater'],
                setEnabled(c, on, log, onChange) { this.enabled = on; this.onChange = onChange; return Promise.resolve(); },
                state() { return { enabled: this.enabled, urls: this.urls.map((x) => x.replace(/#.*/, '')), error: null }; },
                accessUrls() { return this.enabled ? this.urls : []; },
                journal(unit, lines, cb) { cb(null, `journal of ${unit}, ${lines} lines`); } };
            require('../js/updater')._setWeb(stub);
            const file = path.join(storeData, 'web-url');
            stub.urls = ['http://127.0.0.1:8470/#t=aaa', 'http://172.16.222.97:8470/#t=aaa'];
            return priv({ op: 'web', enable: true })
                .then(() => until(st, () => fs.existsSync(file), 5000, 'web-url written'))
                .then(() => {
                    const fst = fs.statSync(file);
                    ok('web-url: the hotspot address with the token, the Store\'s own 0400 file', fs.readFileSync(file, 'utf8') === 'http://172.16.222.97:8470/#t=aaa\n' &&
                        fst.uid === 13050 && (fst.mode & 0o777) === 0o400 && st().web.urls[1] === 'http://172.16.222.97:8470/' &&
                        JSON.stringify(st()).indexOf('#t=aaa') < 0 && JSON.parse(fs.readFileSync(path.join(state, 'web.json'))).enabled === true);
                    stub.urls = ['http://172.16.222.98:8470/#t=bbb'];
                    stub.onChange();
                    return until(st, () => fs.readFileSync(file, 'utf8') === 'http://172.16.222.98:8470/#t=bbb\n', 5000, 'web-url rewritten');
                })
                .then(() => {
                    ok('web-url: rewritten when the address changes', true);
                    return askRaw(sock, { op: 'logs', unit: 'mgu-updater', lines: 20, secret, rid: 'l1' });
                })
                .then((msg) => {
                    ok('logs: a unit\'s journal for the phone page, with the rid', msg.type === 'logs' && msg.unit === 'mgu-updater' &&
                        msg.text === 'journal of mgu-updater, 20 lines' && msg.rid === 'l1', JSON.stringify(msg));
                    return askRaw(sock, { op: 'logs', unit: 'sshd', secret, rid: 'l2' });
                })
                .then((msg) => {
                    ok('logs: only the units the page may read', msg.type === 'error' && /no journal/.test(msg.error) && msg.rid === 'l2');
                    return priv({ op: 'web', enable: false });
                })
                .then(() => until(st, () => !fs.existsSync(file), 5000, 'web-url removed'))
                .then(() => {
                    ok('web-url: removed when the page is turned off', !st().web.enabled);
                    require('../js/updater')._setWeb(real);
                });
        })
        .then(() => settled())
        .then(() => {
            u.server.close();
            return testFirstStart(state);
        });
}

/* A first start without sources.json, and one this version cannot read. */
function testFirstStart() {
    const { Updater } = require('../js/updater');
    const D = path.join(T, 'first');
    mkdirp(D);
    const conf = () => ({ state_dir: path.join(D, 'state'), sources: path.join(D, 'sources.json'), credentials_dir: path.join(D, 'cred') });
    // no sources.json: the built-in source alone, and the file is left for the installers to seed
    let u = new Updater(conf());
    ok('sources: without sources.json, the built-in source alone and nothing written', u.stored.length === 1 && u.stored[0].builtin &&
        u.stored[0].repo === 'robertnisipeanu/mgu-store' && !fs.existsSync(path.join(D, 'sources.json')));
    u.saveSources(u.stored.concat([{ id: 'idrive7-apps', type: 'github', repo: 'someone/idrive7-apps' }]));
    const saved = JSON.parse(fs.readFileSync(path.join(D, 'sources.json'), 'utf8'));
    ok('sources: a change writes sources.json, root-only, the built-in source first', saved.sources.map((x) => `${x.id}:${!!x.builtin}`).join() ===
        'mgu-store:true,idrive7-apps:false' && (fs.statSync(path.join(D, 'sources.json')).mode & 0o777) === 0o600, JSON.stringify(saved));
    // a sources.json this version cannot read (a newer one's) is not overwritten
    const newer = JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'github', repo: 'robertnisipeanu/mgu-store', builtin: true },
        { id: 'future', type: 'ipfs', cid: 'x' }] });
    fs.writeFileSync(path.join(D, 'sources.json'), newer);
    u = new Updater(conf());
    let refused = null;
    try {
        refused = u.handle({ op: 'source-add', type: 'github', repo: 'a/b', secret: u.secret });
    } catch (e) {
        refused = e.message;
    }
    ok('sources: a sources.json that cannot be read is left as it is', /cannot be read/.test(refused || '') &&
        fs.readFileSync(path.join(D, 'sources.json'), 'utf8') === newer && u.stored.length === 1, refused);
    // one operation per id at a time
    u.queue.push({ op: 'install', id: 'foo' });
    ok('queue: a removal of an id with an install queued is refused, not dropped', /an install is queued/.test(u.enqueue({ op: 'uninstall', id: 'foo' }) || '') &&
        u.enqueue({ op: 'install', id: 'foo' }) === null && u.queue.length === 1);
    testConversion();
    return Promise.resolve();
}

/* A unit whose sources each had a token file of their own (mgu-updater 0.2):
 * mgu-store and idrive7-apps with the same token, one from the device flow. */
function testConversion() {
    const { Updater } = require('../js/updater');
    const D = path.join(T, 'convert');
    const cred = path.join(D, 'cred');
    mkdirp(cred);
    fs.writeFileSync(path.join(D, 'sources.json'), JSON.stringify({ schema: 1, sources: [
        { id: 'mgu-store', type: 'github', repo: 'robertnisipeanu/mgu-store', builtin: true },
        { id: 'idrive7-apps', type: 'github', repo: 'someone/idrive7-apps' },
        { id: 'other', type: 'github', repo: 'someone/other' },
        { id: 'cat', type: 'https', url: 'https://example.org/catalog.json' }] }));
    const put = (name, text) => fs.writeFileSync(path.join(cred, name), text, { mode: 0o600 });
    put('mgu-store', 'ghu_same\n');
    put('mgu-store.json', JSON.stringify({ kind: 'github', login: 'someone', expiresAt: 1, refreshToken: 'ghr_1', refreshExpiresAt: 2 }));
    put('idrive7-apps', 'ghu_same\n');
    put('idrive7-apps.json', JSON.stringify({ kind: 'github', login: null }));
    put('other', 'ghp_other\n');
    put('cat', 'catalog-secret\n');
    const conf = { state_dir: path.join(D, 'state'), sources: path.join(D, 'sources.json'), credentials_dir: cred };
    let u = new Updater(conf);
    const list = u.tokens.all();
    const same = list.find((t) => u.tokens.text(t.id) === 'ghu_same');
    const other = list.find((t) => u.tokens.text(t.id) === 'ghp_other');
    ok('convert: one token per distinct text, with what was known of it', list.length === 2 && same && other &&
        same.login === 'someone' && same.label === 'someone' && same.refreshToken === 'ghr_1' && same.expiresAt === 1,
        JSON.stringify(list));
    ok('convert: each source starts with its old token', u.src.get('mgu-store').tokenId === same.id && u.src.get('idrive7-apps').tokenId === same.id &&
        u.src.get('other').tokenId === other.id);
    ok('convert: an https source\'s token is no GitHub token', !list.some((t) => u.tokens.text(t.id) === 'catalog-secret'));
    ok('convert: the old files stay until this version is kept', fs.existsSync(path.join(cred, 'mgu-store')) && fs.existsSync(path.join(cred, 'cat')));
    u = new Updater(conf);
    ok('convert: a start again (a version on trial) adds nothing twice', u.tokens.all().length === 2);
    u.tokens.removeLegacy(() => {});
    ok('convert: then the per-source files go, the tokens stay', fs.readdirSync(cred).sort().join() ===
        [`token-${same.id}`, `token-${other.id}`, 'tokens.json'].sort().join(), fs.readdirSync(cred).join());
    u = new Updater(conf);
    ok('convert: nothing left to convert', u.tokens.all().length === 2 && u.src.get('idrive7-apps').tokenId === null);
}

/* ---- run ---------------------------------------------------------------------- */

function main() {
    const certs = makeCerts();
    const pubDir = path.join(T, 'pub');
    mkdirp(pubDir);
    testShipped();
    testCatalog();
    testCollect();
    testFileLog();
    return testTar()
        .then(() => testReboot())
        .then(() => Promise.all([startDns(), startHttps(certs, pubDir)]))
        .then(([dnsSrv, httpsSrv]) => testFetch(certs, pubDir)
            .then(() => testSources(certs).catch((e) => ok('sources scenario', false, e.stack)))
            .then(() => testDaemon(certs, pubDir))
            .then(() => {
                dnsSrv.close();
                httpsSrv.close();
            }))
        .then(() => {
            console.log(`${passes} passed, ${failures} failed`);
            process.exit(failures ? 1 : 0);
        }, (err) => {
            console.log(`FAIL ${err.stack}`);
            process.exit(1);
        });
}

main();
