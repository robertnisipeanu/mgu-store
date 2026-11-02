'use strict';
/**
 * Offline tests of mgu-updater on the head unit's Node 8.16.2, as root
 * (test/run.sh runs them in Docker):
 *  - catalog: parsing (schema 1 and 2), rejection of malformed entries, the plan;
 *  - a version 1 App Manager index read again and again: only the newest
 *    package of each id kept, what each one is remembered, the cap;
 *  - build folders removed as the uid that owns each part (root's too, after
 *    a build and at a start), and a build's output in the log bounded;
 *  - fetch.js: HTTPS through a given DNS server, redirects that drop the
 *    token, size limits, running as the fetch uid;
 *  - the daemon under its supervisor, against an HTTPS catalog and a stand-in
 *    deploy tool: install an app, update itself, return to the previous
 *    version when a new one crashes or never comes up, refuse a download
 *    that does not match the catalog, report a failed install, offline;
 *    what an install and a build cut short left removed at start;
 *  - the reboot request: refused while an install runs or waits, the
 *    command run once, its failure and a unit that stays up reported;
 *  - the uplink's requests relayed to a fake ctl.sock (the secret, only
 *    their own fields, a password exact and never logged) and its
 *    status.json in the state;
 *  - sources (an updater in this process, against a fake GitHub on the same
 *    HTTPS server): several sources and id collisions, tokens of their own
 *    (one reaching two private repos, a second for a third, a public repo
 *    read without one, removal, tokens the deploy tool writes, per-source
 *    files of 0.2 converted), GitHub device sign-in, catalog / releases / repo-tree
 *    layouts on the releases, branch and tags channels, a branch commit
 *    that moves, repo build scripts (built, failing, too slow, writing
 *    outside), requirements installed first, uninstall, USB media, the
 *    privileged requests and their secret files, a first start without
 *    sources.json, and the Store 0.3's view of the state;
 *  - the head unit and compatibility (mguHmi), root-service packages and
 *    apps from an App Manager index (https), and two tools providing one
 *    capability (installed side by side, uninstalled one after the other);
 *  - an App Manager index version 2 listed without downloads, its packages
 *    checked on install, and the icons it, a folder catalog and a repo's
 *    mgu-store.json name, and those a package carries (a stick, a version 1 index);
 *  - a repo whose apps a pattern lists and Python builds (mgu-python
 *    installed first, the oap-sdk module and the declared output), a build
 *    that downloads through its proxy (and fails without the uplink), a
 *    service tool and a preload tool with the capability it needs.
 *    MGU_TEST_PROXY_OPEN lets that proxy reach the tests' local servers.
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
// a started Store that does not say hello by then has its update undone
process.env.MGU_UPDATER_STORE_HELLO_MS = '1500';
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

/* The pids of fn() (a list) still running: a zombie is not, it has ended.
 * A killed process ends a few ms after kill() returns and stays a zombie
 * until its parent reaps it (an orphan's parent is PID 1: in Docker, the
 * shell or node itself). Polls until none is, for at most 5 s; resolves
 * with what still runs. */
function stillRunning(fn) {
    const end = Date.now() + 5000;
    const live = () => fn().filter((pid) => {
        try {
            return !/^[ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, ''));
        } catch (e) {
            return false;
        }
    });
    const poll = () => {
        const left = live();
        return left.length === 0 || Date.now() > end ? Promise.resolve(left) : sleep(20).then(poll);
    };
    return poll();
}

function uidPids(uid) {
    return sh(`pgrep -u ${uid} || true`).trim().split('\n').filter(Boolean);
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
        printf 'subjectAltName=DNS:updates.test,DNS:other.test,DNS:api.github.com,DNS:github.com,DNS:codeload.github.com,DNS:raw.githubusercontent.com\\n' > ext &&
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
        const known = /\.test$|(^|\.)github\.com$|(^|\.)githubusercontent\.com$/.test(labels.join('.'));
        const header = Buffer.from([q[0], q[1], 0x81, known ? 0x80 : 0x83, 0, 1, 0, known ? 1 : 0, 0, 0, 0, 0]);
        const answer = known ? Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]) : Buffer.alloc(0);
        s.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
    });
    return new Promise((r) => s.bind(DNS_PORT, '127.0.0.1', () => r(s)));
}

const seen = [];

/* ---- a fake GitHub (api.github.com, github.com, codeload.github.com, raw.githubusercontent.com) -- */

const API = `https://api.github.com:${HTTPS_PORT}`;
const GH_WEB = `https://github.com:${HTTPS_PORT}`;
const RAW = `https://raw.githubusercontent.com:${HTTPS_PORT}`;
const CODELOAD = `https://codeload.github.com:${HTTPS_PORT}`;
// webLimited: github.com answers 429; assetNotModified: 304s of a release asset's storage
const gh = { repos: {}, users: { 'tok-all': 'tester', 'tok-third': 'other-acct', 'tok-device': 'tester' }, polls: 0, refreshes: 0, device: null,
    deviceExpired: false, rateLimited: false, anonLimited: false, webLimited: false, notModified: 0, assetNotModified: 0 };

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

/* A repo's releases with their tags (the catalog release is a release too). */
function ghReleases(repo) {
    return (repo.catalog ? [{ tag: 'catalog', assets: [{ name: 'catalog.json', data: repo.catalog }] }] : [])
        .concat(repo.releases.map((r, i) => Object.assign({ tag: `v${i}` }, r)));
}

/* The bytes of a release asset by its release's tag and its name; a
 * catalog's artifacts and icons (repo.files) under any tag. */
function ghAsset(repo, tag, name) {
    const r = ghReleases(repo).find((x) => x.tag === tag);
    const a = r && r.assets.find((x) => x.name === name);
    return a ? a.data : (repo.files && repo.files[name]) || null;
}

/* The refs a repo advertises to git (info/refs?service=git-upload-pack):
 * HEAD on its default branch, its branches and its tags (an annotated one
 * with its peeled commit). */
function ghRefs(repo) {
    const pkt = (line) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
    const head = repo.branches[repo.default_branch] || '0'.repeat(40);
    const lines = [`${head} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/${repo.default_branch} agent=git/fake\n`]
        .concat(Object.keys(repo.branches).sort().map((b) => `${repo.branches[b]} refs/heads/${b}\n`))
        .concat([].concat(...repo.tags.map((t) => (t.annotated ? [`${sha256(Buffer.from(t.name)).slice(0, 40)} refs/tags/${t.name}\n`,
            `${t.sha} refs/tags/${t.name}^{}\n`] : [`${t.sha} refs/tags/${t.name}\n`]))));
    return Buffer.from(`${pkt('# service=git-upload-pack\n')}0000${lines.map(pkt).join('')}0000`);
}

/* github.com's GETs: a release asset's download, a redirect to its storage
 * (other.test, which answers its ETag with a 304), and the refs a repo
 * advertises to git. A private repo is not there for them. */
function ghWebGet(req, res) {
    const u = new URL(req.url, GH_WEB);
    const answer = (code, body, headers) => {
        const data = Buffer.from(body || '');
        res.writeHead(code, Object.assign({ 'Content-Length': data.length }, headers || {}));
        res.end(data);
    };
    if (gh.webLimited) {
        answer(429, 'Too Many Requests', { 'Retry-After': '60' });
        return;
    }
    let m = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) {
        const repo = gh.repos[m[1]];
        const found = repo && !repo.private && ghAsset(repo, decodeURIComponent(m[2]), decodeURIComponent(m[3]));
        answer(found ? 302 : 404, found ? '' : 'Not Found', found ? { Location: `https://other.test:${HTTPS_PORT}/gh-asset${u.pathname}` } : {});
        return;
    }
    m = /^\/([^/]+\/[^/]+)\.git\/info\/refs$/.exec(u.pathname);
    const repo = m && gh.repos[m[1]];
    if (m && u.searchParams.get('service') === 'git-upload-pack') {
        if (!repo || repo.private) {
            answer(401, '', { 'WWW-Authenticate': 'Basic realm="GitHub"' });
        } else {
            res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
            res.end(ghRefs(repo));
        }
        return;
    }
    answer(404, 'Not Found');
}

/* A release asset from its storage (where github.com's download redirects). */
function ghAssetStore(req, res) {
    const m = /^\/gh-asset\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(req.url);
    const repo = m && gh.repos[m[1]];
    const data = repo && ghAsset(repo, decodeURIComponent(m[2]), decodeURIComponent(m[3]));
    if (!data) {
        res.writeHead(404);
        res.end();
        return;
    }
    const etag = `"0x${sha256(data).slice(0, 15).toUpperCase()}"`;
    if (req.headers['if-none-match'] === etag) {
        gh.assetNotModified += 1;
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
    }
    res.writeHead(200, { 'Content-Length': data.length, ETag: etag });
    res.end(data);
}

/* raw.githubusercontent.com: a public repo's file at a commit. */
function ghRaw(req, res) {
    const m = /^\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(req.url);
    const repo = m && gh.repos[m[1]];
    const f = repo && !repo.private && repo.trees[m[2]] && repo.trees[m[2]][decodeURIComponent(m[3])];
    res.writeHead(f ? 200 : 404, { 'Content-Length': f ? f[0].length : 0 });
    res.end(f ? f[0] : '');
}

function ghApi(req, res, auth) {
    const u = new URL(req.url, API);
    // a 200 carries an ETag of its body (and of the token's account, as GitHub's varies with it); asked with it, a 304
    const send = (code, body, headers) => {
        const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const etag = code === 200 ? `"${sha256(Buffer.concat([data, Buffer.from(String(auth))])).slice(0, 32)}"` : null;
        if (etag && req.headers['if-none-match'] === etag) {
            gh.notModified += 1;
            res.writeHead(304, { ETag: etag });
            res.end();
            return;
        }
        res.writeHead(code, Object.assign({ 'Content-Length': data.length }, etag ? { ETag: etag } : {}, headers || {}));
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
    if (gh.rateLimited || (gh.anonLimited && !auth)) {
        send(403, { message: 'API rate limit exceeded' }, { 'X-RateLimit-Remaining': '0' });
        return;
    }
    // a refusal that is no rate limit (an organisation's SSO) for a token
    if (repo.forbid && auth && repo.forbid.indexOf(auth.replace(/^Bearer /, '')) >= 0) {
        send(403, { message: 'Resource protected by organization SAML enforcement' });
        return;
    }
    const rest = m[2] || '';
    const assetUrl = (name) => `${API}/repos/${m[1]}/releases/assets/${encodeURIComponent(name)}`;
    // an asset's upload time: its bytes' hash stands for it
    const updated = (data) => sha256(Buffer.from(data)).slice(0, 16);
    if (!rest) {
        send(200, { full_name: m[1], default_branch: repo.default_branch, private: repo.private });
    } else if (rest === '/releases/tags/catalog') {
        if (repo.catalog) {
            send(200, { assets: [{ name: 'catalog.json', url: assetUrl('catalog.json'), size: repo.catalog.length, updated_at: updated(repo.catalog) }] });
        } else {
            send(404, { message: 'Not Found' });
        }
    } else if (rest.indexOf('/releases/assets/') === 0) {
        // forbidOnly: those asset names alone
        if (repo.forbidAssets && auth && repo.forbidAssets.indexOf(auth.replace(/^Bearer /, '')) >= 0 &&
            (!repo.forbidOnly || repo.forbidOnly.indexOf(decodeURIComponent(rest.slice('/releases/assets/'.length))) >= 0)) {
            send(403, { message: 'Resource not accessible by integration' });
            return;
        }
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
        send(200, ghReleases(repo).slice(0, n).map((r) => ({ tag_name: r.tag, draft: !!r.draft, prerelease: !!r.prerelease,
            assets: r.assets.map((x) => ({ name: x.name, size: x.data.length, url: assetUrl(x.name), updated_at: updated(x.data) })) })));
    } else if (rest.indexOf('/commits/') === 0) {
        const sha = repo.branches[decodeURIComponent(rest.slice('/commits/'.length))];
        // the sha media type: the sha alone
        const bare = req.headers.accept === 'application/vnd.github.sha';
        send(sha ? 200 : 422, sha ? (bare ? sha : { sha }) : { message: 'No commit found' });
    } else if (rest === '/tags') {
        send(200, repo.tags.map((t) => ({ name: t.name, commit: { sha: t.sha } })));
    } else if (rest === '/branches') {
        // sorted by name, as GitHub lists them; per_page at most 100
        const n = Math.min(100, Number(u.searchParams.get('per_page')) || 30);
        const page = Number(u.searchParams.get('page')) || 1;
        send(200, Object.keys(repo.branches).sort().slice((page - 1) * n, page * n).map((name) => ({ name, commit: { sha: repo.branches[name] } })));
    } else if (rest.indexOf('/contents/') === 0) {
        // a read that fails once (a server error), as a passing outage does
        if (repo.failOnce === decodeURIComponent(rest.slice('/contents/'.length))) {
            repo.failOnce = null;
            send(502, { message: 'Server Error' });
            return;
        }
        const tree = repo.trees[u.searchParams.get('ref')];
        const rel = decodeURIComponent(rest.slice('/contents/'.length));
        const f = tree && tree[rel];
        // a folder: its entries, as GitHub lists them
        const names = tree && !f ? Object.keys(tree).filter((k) => k.indexOf(`${rel}/`) === 0).map((k) => k.slice(rel.length + 1)) : [];
        if (names.length) {
            const items = [];
            names.forEach((n) => {
                const name = n.split('/')[0];
                if (!items.some((i) => i.name === name)) {
                    items.push({ name, type: n.indexOf('/') >= 0 ? 'dir' : 'file' });
                }
            });
            send(200, items);
            return;
        }
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
                if (req.method === 'GET') {
                    ghWebGet(req, res);
                } else {
                    ghWeb(req, res, body);
                }
                return;
            }
            if (host === 'raw.githubusercontent.com') {
                ghRaw(req, res);
                return;
            }
            if (host === 'other.test' && req.url.indexOf('/gh-asset/') === 0) {
                ghAssetStore(req, res);
                return;
            }
            if (host === 'codeload.github.com') {
                // the API's tarball redirect, or codeload's own address of a commit
                const m = /^\/([^/]+\/[^/]+)\/(?:legacy\.tar\.gz|tar\.gz)\/([0-9a-f]+)$/.exec(req.url);
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
        // the scripts it runs as children
        (text.match(/path\.join\((?:HERE|__dirname), '([a-z_]+\.js)'\)/g) || []).forEach((r) => needed.push(/'([a-z_]+\.js)'/.exec(r)[1]));
    });
    ok('shipped: component.json installs every module the updater loads or runs (the phone page\'s web.js is optional)',
        needed.filter((n) => n !== 'web.js').every((n) => shipped.indexOf(n) >= 0) && needed.indexOf('proxy.js') >= 0, JSON.stringify(needed));
    ok('shipped: component.json installs each file it names (web.js once the phone page is in this tree)',
        component.files.every((f) => f.path === 'web.js' || fs.existsSync(path.join(ROOT, f.from))) && shipped.indexOf('web.js') >= 0);
    ok('shipped: the mgu-store GitHub App\'s client id and page', conf.github_client_id === 'Iv23li9nab1iob4a6eyC' &&
        conf.github_app_url === 'https://github.com/apps/mgu-store');
    const { Updater } = require('../js/updater');
    const dir = fs.mkdtempSync(path.join(T, 'shipped-'));
    const shippedState = new Updater(Object.assign({}, conf, { state_dir: dir, credentials_dir: path.join(dir, 'cred'),
        sources: path.join(dir, 'sources.json'), lease: path.join(dir, 'lease.json'), log_file: '' })).state();
    ok('shipped: GitHub sign-in is offered, with the App\'s install page', shippedState.signin === true &&
        JSON.stringify(shippedState.signinApp) === JSON.stringify({ installUrl: 'https://github.com/apps/mgu-store/installations/new' }));
    ok('shipped: no catalog key and no signing settings',
        !shipped.some((f) => /\.pem$/.test(f)) && conf.public_key === undefined && conf.catalog === undefined &&
        !fs.readdirSync(ROOT).some((f) => /\.pem$/.test(f)));
    ok('shipped: sources, credentials and the secrets have their places; the service uids are picked on the unit',
        conf.sources === '/var/opt/mgu-updater/sources.json' && conf.credentials_dir === '/var/opt/mgu-updater/credentials' &&
        ['build', 'fetch', 'web'].every((r) => conf[`${r}_uid`] === undefined && conf[`${r}_gid`] === undefined) &&
        conf.socket_group === 'tm_oap_app' && conf.web_port === '8470' &&
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
    const described = catalogLib.plan([r(Object.assign({}, good.components[0], { description: 'Plays DOOM' }))], [])[0];
    ok('plan: a row carries the catalog\'s description', described.description === 'Plays DOOM' && rows[0].description === '');
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
        .then((refused) => ok('build: refused with a build_uid another part uses (it is killed wholesale)', refused && !fs.existsSync(path.join(T, 'nobuild'))))
        .then(() => {
            // a Python that is there but cannot start (its loader missing: ENOENT)
            const py = path.join(T, 'badpy', 'python3');
            mkdirp(path.dirname(py));
            fs.writeFileSync(py, '#!/nonexistent/loader\n', { mode: 0o755 });
            return require('../js/build').runBuild({ conf: { build_uid: '12990', build_gid: '12990', fetch_uid: '12991', web_uid: '12996',
                state_dir: path.join(T, 'badpy', 'state'), python: py, build_max_bytes: String(1 << 20), build_timeout_s: '20' },
            entry: { id: 'x', version: '1.0.0', script: { python: 'b.py', args: [] } },
            files: [{ name: 'b.py', data: Buffer.from('print(1)\n'), mode: 0o644 }], donor: '', log: () => {} })
                .then(() => '', (e) => e.message);
        })
        .then((msg) => ok('build: a Python that cannot start says so and names mgu-python', /^Python \(.*python3\) cannot start \(ENOENT\): update mgu-python$/.test(msg), msg));
}

/* A version 1 index read again and again (a reader with a stand-in network
 * that counts downloads): only the newest package of each id is kept, what
 * each listed package is is remembered, and the kept packages stay within
 * their cap. */
function testIndexV1Cache() {
    const tar = require('../js/tar');
    const sourcesLib = require('../js/sources');
    const cacheDir = path.join(T, 'v1cache');
    const files = {};
    const pkg = (name, version, extra) => {
        const b = tar.tgz([{ name: 'package/package.json', data: Buffer.from(JSON.stringify({ name, version, mguHmi: ['ID7'] })), mode: 0o644 }]
            .concat(extra || []), 1);
        files[`${name}@${version}.tgz`] = b;
        return { url: `${name}@${version}.tgz`, sha256: sha256(b) };
    };
    const many = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0'].map((v) => pkg('v1many', v));
    const other = pkg('v1other', '2.0.0');
    const bad = pkg('v1bad', 'latest');
    const gets = [];
    const net = {
        get: (url) => {
            const name = url.split('/').pop();
            gets.push(name);
            return files[name] ? Promise.resolve(files[name]) : Promise.reject(new Error(`${name}: 404`));
        }
    };
    const index = (list) => {
        files['index.json'] = Buffer.from(JSON.stringify({ packages: list }));
    };
    const read = (version) => {
        gets.length = 0;
        return sourcesLib.reader({ id: 'v1', type: 'https', url: 'https://updates.test/index.json' },
            { net, version: version || '0.7.2', cacheDir, maxBuildBytes: 8 << 20 }).catalog();
    };
    const kept = () => fs.readdirSync(path.join(cacheDir, 'v1')).sort();
    const tgz = (p) => `${p.sha256}.tgz`;
    const listed = (cat) => cat.components.map((c) => `${c.id}@${c.version}`).join(' ');
    let first;
    index(many.concat([other, bad]));
    return read()
        .then((cat) => {
            first = cat;
            ok('index v1: the newest of each id is listed, a package that does not read is said why',
                listed(cat) === 'v1many@1.5.0 v1other@2.0.0' && /v1bad@latest\.tgz: package\.json needs/.test(cat.skipped.join()), JSON.stringify(cat.skipped));
            ok('index v1: each package downloaded once; only the newest of each id kept, with what each one is',
                gets.filter((n) => n !== 'index.json').length === 8 &&
                JSON.stringify(kept()) === JSON.stringify([tgz(many[5]), tgz(other), 'index.json'].sort()), JSON.stringify([gets, kept()]));
            return read();
        })
        .then((cat) => {
            ok('index v1: read again, no package is downloaded, the one that does not read included', JSON.stringify(gets) === '["index.json"]', JSON.stringify(gets));
            ok('index v1: read again, the listing is the same', JSON.stringify(cat) === JSON.stringify(first));
            index(many.slice(0, 5).concat([other]));
            return read();
        })
        .then((cat) => {
            const top = cat.components[0];
            ok('index v1: with the newest gone from the index, the one before it is listed without a download, and none of v1many is kept',
                listed(cat) === 'v1many@1.4.0 v1other@2.0.0' && JSON.stringify(gets) === '["index.json"]' &&
                JSON.stringify(kept()) === JSON.stringify([tgz(other), 'index.json'].sort()) &&
                top.artifact.sha256 === many[4].sha256 && /v1many@1\.4\.0\.tgz$/.test(top.artifact.url), JSON.stringify([gets, kept(), top.artifact]));
            gets.length = 0;
            return sourcesLib.reader({ id: 'v1', type: 'https', url: 'https://updates.test/index.json' },
                { net, version: '0.7.2', cacheDir, maxBuildBytes: 8 << 20 }).artifact(top).then((b) => ({ b, top }));
        })
        .then(({ b, top }) => {
            ok('index v1: its install downloads it, checked, and keeps it', sha256(b) === top.artifact.sha256 && JSON.stringify(gets) === '["v1many@1.4.0.tgz"]' &&
                kept().indexOf(tgz(many[4])) >= 0, JSON.stringify([gets, kept()]));
            index(many.concat([other, bad]));
            return read('0.7.3');
        })
        .then((cat) => {
            ok('index v1: another updater version downloads again what did not read and what the index lists again; what it knows, kept or not, it does not',
                listed(cat) === 'v1many@1.5.0 v1other@2.0.0' && JSON.stringify(gets) === '["index.json","v1many@1.5.0.tgz","v1bad@latest.tgz"]' &&
                JSON.stringify(kept()) === JSON.stringify([tgz(many[5]), tgz(other), 'index.json'].sort()), JSON.stringify([gets, kept()]));
            // other sources' kept packages fill the cap (a sparse file)
            mkdirp(path.join(cacheDir, 'full'));
            fs.writeFileSync(path.join(cacheDir, 'full', 'x.tgz'), '');
            fs.truncateSync(path.join(cacheDir, 'full', 'x.tgz'), 128 << 20);
            index(many.concat([other, pkg('v1many', '1.6.0')]));
            return read('0.7.3');
        })
        .then((cat) => {
            ok('index v1: past the cap a new package is listed, not kept', listed(cat) === 'v1many@1.6.0 v1other@2.0.0' &&
                JSON.stringify(kept()) === JSON.stringify([tgz(other), 'index.json'].sort()), JSON.stringify(kept()));
            // room for 100 KiB under the cap; four older versions of 30 KiB come before the newest
            const capDir = path.join(T, 'v1cap');
            mkdirp(path.join(capDir, 'full'));
            fs.writeFileSync(path.join(capDir, 'full', 'x.tgz'), '');
            fs.truncateSync(path.join(capDir, 'full', 'x.tgz'), (128 << 20) - (100 << 10));
            const big = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0'].map((v) => pkg('v1big', v,
                [{ name: 'package/blob', data: crypto.randomBytes(30 << 10), mode: 0o644 }]));
            index(big.concat([other]));
            const capRead = () => {
                gets.length = 0;
                return sourcesLib.reader({ id: 'cap', type: 'https', url: 'https://updates.test/index.json' },
                    { net, version: '0.7.3', cacheDir: capDir, maxBuildBytes: 8 << 20 }).catalog();
            };
            const capKept = () => fs.readdirSync(path.join(capDir, 'cap')).sort();
            return capRead().then((c) => ({ c, capDir, capRead, capKept, big }));
        })
        .then(({ c, capDir, capRead, capKept, big }) => {
            ok('index v1: older versions take no room under the cap: the newest of each id is kept',
                listed(c) === 'v1big@1.4.0 v1other@2.0.0' &&
                JSON.stringify(capKept()) === JSON.stringify([tgz(big[4]), tgz(other), 'index.json'].sort()), JSON.stringify(capKept()));
            // index.json cannot be written (a folder at its name)
            fs.unlinkSync(path.join(capDir, 'cap', 'index.json'));
            fs.mkdirSync(path.join(capDir, 'cap', 'index.json'));
            return capRead().then((again) => again, (e) => ({ failed: e.message }));
        })
        .then((cat) => {
            ok('index v1: an index.json that cannot be written still lists the components', !cat.failed &&
                listed(cat) === 'v1big@1.4.0 v1other@2.0.0', JSON.stringify(cat.failed || cat.skipped));
            const big = ['1.2.0', '1.3.0', '1.4.0'].map((v) => ({ url: `v1big@${v}.tgz`, sha256: sha256(files[`v1big@${v}.tgz`]) }));
            const at = (id) => {
                const dir = path.join(T, `v1${id}`);
                const r = () => {
                    gets.length = 0;
                    return sourcesLib.reader({ id, type: 'https', url: 'https://updates.test/index.json' },
                        { net, version: '0.7.3', cacheDir: dir, maxBuildBytes: 8 << 20 }).catalog();
                };
                return { r, kept: () => fs.readdirSync(path.join(dir, id)).sort() };
            };
            const dup = at('dup');
            const ooo = at('ooo');
            const want = JSON.stringify([tgz(big[2]), tgz(other), 'index.json'].sort());
            const twice = (s) => s.r().then(() => s.kept()).then((first) => s.r().then(() => [first, s.kept(), gets.slice()]));
            // one package under two URLs
            index([big[2], { url: 'copy/v1big@1.4.0.tgz', sha256: big[2].sha256 }, other]);
            return twice(dup)
                .then(([first, second]) => {
                    ok('index v1: a package the index lists twice stays kept, read after read',
                        JSON.stringify(first) === want && JSON.stringify(second) === want, JSON.stringify([first, second]));
                    index([big[2], big[1], big[0], other]);
                    return twice(ooo);
                })
                .then(([first, second, again]) => {
                    ok('index v1: the newest listed first is kept, the older ones after it are not, read after read',
                        JSON.stringify(first) === want && JSON.stringify(second) === want && JSON.stringify(again) === '["index.json"]',
                        JSON.stringify([first, second, again]));
                });
        });
}

/* Build folders and their log: a folder root never handed to the build uid
 * removed by root, after the build and at a start; a build's output in the
 * log bounded by bytes. */
function testBuildDisk() {
    const { runBuild, cleanBuilds } = require('../js/build');
    const state = path.join(T, 'buildstate');
    const conf = { build_uid: '12995', build_gid: '12995', fetch_uid: '12990', web_uid: '12996', state_dir: state,
        build_max_bytes: String(1 << 20), build_timeout_s: '30' };
    const builds = () => (fs.existsSync(state) ? fs.readdirSync(state).filter((n) => /^build-/.test(n)) : []);
    const entry = { id: 'chatty', version: '1.0.0', script: { node: 'b.js', args: [] } };
    // 400 lines of 1 KiB, then the package
    const script = "for (let i = 0; i < 400; i++) console.log(String(i).padStart(1024, 'x'));\n" +
        "require('fs').writeFileSync(process.env.MGU_OUT + '/chatty@1.0.0.tgz', 'pkg');\n";
    const logged = [];
    return runBuild({ conf, entry, donor: '', log: () => {},
        files: [{ name: 'b.js', data: Buffer.from('x'), mode: 0o644 }, { name: 'big', data: Buffer.alloc(2 << 20), mode: 0o644 }] })
        .then(() => false, (e) => /more than/.test(e.message))
        .then((refused) => {
            ok('build: a build that fails before root hands it the repo leaves no folder', refused && builds().length === 0, builds().join(' '));
            const left = path.join(state, 'build-0123456789ab');
            mkdirp(path.join(left, 'repo', 'src'));
            fs.writeFileSync(path.join(left, 'repo', 'src', 'a.js'), 'x');
            fs.chmodSync(path.join(left, 'repo'), 0o700);
            mkdirp(path.join(left, 'tmp'));
            fs.writeFileSync(path.join(left, 'tmp', 'b'), 'x');
            sh(`chown -R 12995:12995 ${path.join(left, 'tmp')}`);
            return cleanBuilds(conf);
        })
        .then(() => {
            ok('build: a start removes build folders an earlier run left, root\'s and the build uid\'s', builds().length === 0, builds().join(' '));
            return runBuild({ conf, entry, donor: '', log: (l) => logged.push(l), files: [{ name: 'b.js', data: Buffer.from(script), mode: 0o644 }] });
        })
        .then((b) => sleep(300).then(() => {
            const own = logged.filter((l) => /^build chatty: /.test(l));
            const cut = own.filter((l) => /^build chatty: the rest of its output is left out of the log$/.test(l));
            const bytes = own.filter((l) => cut.indexOf(l) < 0).reduce((n, l) => n + Buffer.byteLength(l), 0);
            ok('build: at most 256 KiB of its output goes to the log, then one line says the rest is left out',
                b.toString() === 'pkg' && bytes <= 256 << 10 && bytes > 200 << 10 && cut.length === 1 && own[own.length - 1] === cut[0],
                `${bytes} ${own.length}`);
        }));
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

/* The updater's own uids in a running Updater (uids.js): picked with no
 * overrides, picked again only while nothing runs as them, downloads held
 * until the uplink reads a new fetch uid, the phone page moved. */
function testUidsDaemon() {
    const updaterJs = require('../js/updater');
    const { Updater } = updaterJs;
    const dir = path.join(T, 'uids-daemon');
    const p = (rel) => path.join(dir, rel);
    const put = (rel, text) => {
        mkdirp(path.dirname(p(rel)));
        fs.writeFileSync(p(rel), text);
    };
    put('etc/passwd', 'root:x:0:0::/root:/bin/sh\ncns_12701:x:12701:12701::/:/bin/false\n');
    put('etc/group', 'root:x:0:\ntm_oap_app:x:12202:\n');
    mkdirp(p('proc'));
    put('mainapp/config/base.json', JSON.stringify({ usableUidsAndGids: { min: 12203, max: 12450 },
        usableUidsAndGidsRse: { right: { min: 12453, max: 12700 } }, mainAppUids: [12201, 12451] }));
    put('oap/oap_12201/data/apps/store.json', JSON.stringify({ userId: 12205 }));
    put('opt/mgu-uplink/versions/0.5.3/component.json', '{"version":"0.5.3"}');
    fs.symlinkSync('versions/0.5.3', p('opt/mgu-uplink/current'));
    mkdirp(p('run'));
    const conf = { state_dir: p('state'), tool_root: p('opt'), oap_root: p('oap'), mainapp_uid: '12201', uplink_tool: 'mgu-uplink',
        socket_group: 'tm_oap_app', etc_dir: p('etc'), proc_dir: p('proc'), mainapp_config: p('mainapp/config/base.json'),
        web_secret: p('run/web-secret'), store_app: 'robertn_store' };
    const calls = [];
    const stub = { UNITS: [], setEnabled(c, on) { calls.push({ on, uid: c.web_uid, gid: c.web_gid }); return Promise.resolve(); },
        state() { return { enabled: false, urls: [], error: null }; }, accessUrls() { return []; }, journal(u, l, cb) { cb(null, ''); } };
    updaterJs._setWeb(stub);
    const u = new Updater(conf);
    u.secret = 'a'.repeat(64);
    ok('uids: a start without overrides picks all three above MainApp\'s ranges',
        conf.build_uid === '12702' && conf.fetch_uid === '12703' && conf.web_uid === '12704' && conf.web_gid === '12202' &&
        !(u.fetcher.notBefore > Date.now()), JSON.stringify(conf));
    // a tool installed since holds the fetch and web uids
    put('opt/mgu-uplink/uids.d/net-tool', '12703\n12704\n');
    u.webEnabled = true;
    u.fetcher.active = 1;
    return u.checkUids()
        .then(() => {
            ok('uids: not picked again while a download runs', conf.fetch_uid === '12703' && u.uidsPending === true);
            u.fetcher.active = 0;
            u.building = true;
            return u.checkUids();
        })
        .then(() => {
            ok('uids: nor while a build runs', conf.fetch_uid === '12703' && u.uidsPending === true);
            u.building = false;
            return u.checkUids();
        })
        .then(() => {
            ok('uids: picked again once nothing runs as them', conf.fetch_uid === '12705' && conf.web_uid === '12706' &&
                u.uidsPending === false && fs.readFileSync(p('opt/mgu-uplink/uids.d/mgu-updater'), 'utf8') === '12705\n',
                JSON.stringify(conf));
            ok('uids: downloads wait for the uplink to read the new fetch uid', u.fetcher.notBefore - Date.now() > 5000);
            ok('uids: the phone page restarts as the new web uid', calls.length === 1 && calls[0].on && calls[0].uid === '12706');
            if (process.getuid() === 0) {
                ok('uids: its secret is the new web uid\'s', fs.statSync(p('run/web-secret')).uid === 12706);
            }
            // the wait itself
            u.fetcher.notBefore = Date.now() + 400;
            const t0 = Date.now();
            return u.fetcher.request({ url: 'https://example.invalid/x', headers: {}, name: 'x', maxBytes: 10 })
                .catch(() => null)
                .then(() => ok('uids: a download waits until then', Date.now() - t0 >= 380 && u.fetcher.active === 0));
        })
        .then(() => {
            // queue: what needs a newer updater waits for the updater's own update
            const order = [];
            u.src = new Map([['s', { components: [{ id: 'mgu-uplink', requires: { 'mgu-updater': '99.0.0' } },
                { id: 'mgu-updater', requires: {} }, { id: 'other', requires: {} }] }]]);
            u.install = (item) => {
                order.push(item.id);
                return Promise.resolve(item.id === 'mgu-updater');
            };
            u.queue = [{ op: 'install', id: 'mgu-uplink', source: 's' }, { op: 'install', id: 'other', source: 's' },
                { op: 'install', id: 'mgu-updater', source: 's' }];
            let handed = null;
            u.handover = function () {
                handed = this.queue.slice();
            };
            u.next();
            return new Promise((r) => setTimeout(r, 50)).then(() => {
                ok('queue: others first, then the updater before what needs it', order.join() === 'other,mgu-updater' &&
                    handed && handed.map((q) => q.id).join() === 'mgu-uplink', order.join());
            });
        })
        .then(() => {
            // the queue across the restart: handover writes it, the kept version takes it up
            const exit = process.exit;
            let code = null;
            process.exit = (c) => {
                code = c;
            };
            const v = Object.create(Updater.prototype);
            Object.assign(v, { conf, queue: [{ op: 'install', id: 'mgu-uplink', source: 's' }], clients: [], server: { close() {} } });
            try {
                Updater.prototype.handover.call(v);
            } finally {
                process.exit = exit;
            }
            const file = path.join(conf.state_dir, 'queue.json');
            ok('queue: what is left is kept for the new version', code !== null && JSON.parse(fs.readFileSync(file, 'utf8'))[0].id === 'mgu-uplink');
            u.queue = [];
            u.errors = {};
            u.busy = null;
            u.takeQueue();
            ok('queue: the kept new version queues it again', u.queue.map((q) => q.id).join() === 'mgu-uplink' && !fs.existsSync(file));
            updaterJs._setWeb(fs.existsSync(path.join(ROOT, 'js', 'web.js')) ? require('../js/web') : null);
        })
        .catch((e) => ok('uids in the daemon', false, e.stack));
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
    // what an installed tool says is wrong (mgu-render's page template)
    fs.writeFileSync(path.join(opt, 'mgu-updater', 'status.json'), JSON.stringify({ template: 'failed', problem: 'In-page drawing unavailable: x' }));
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
        'first_check_s = 0', 'check_interval_s = 3600', `privacy_tool = ${privacyTool}`, 'default_sources =',
        `log_file = ${path.join(T, 'tmp', 'mgu-updater.log')}`, `reboot = ${rebootScript(path.join(T, 'daemon-reboot'))} reboot`,
        // the unit's uids as overrides (picking them: testUidsDaemon)
        `fetch_uid = ${FETCH_UID}`, 'build_uid = 12995', 'web_uid = 12996',
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
    // what an install and a build cut short left: a checked artifact, and a
    // build folder root made and never handed to the build uid
    mkdirp(path.join(T, 'state', 'verified'));
    fs.writeFileSync(path.join(T, 'state', 'verified', 'cut_app@1.0.0.tgz'), 'x');
    const rootBuild = path.join(T, 'state', 'build-0123456789ab');
    mkdirp(path.join(rootBuild, 'repo', 'src'));
    fs.writeFileSync(path.join(rootBuild, 'repo', 'src', 'a.js'), 'x');
    fs.chmodSync(path.join(rootBuild, 'repo'), 0o700);
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
            ok('daemon: serves its state and checks the catalog at start', version(st) === '0.1.0' && st.components.filter((c) => c.source === 'mgu-store').length === 2,
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
            ok('daemon: a start removes the checked artifacts an install cut short left',
                !fs.existsSync(path.join(T, 'state', 'verified', 'cut_app@1.0.0.tgz')));
            ok('daemon: a start removes a build folder still root\'s', !fs.existsSync(rootBuild));
            ok('daemon: online while the uplink lease exists', st.online === true);
            ok('daemon: an installed tool\'s problem from its status.json, none for an app',
                row(st, 'mgu-updater').problem === 'In-page drawing unavailable: x' && row(st, 'demo_app').problem === null,
                JSON.stringify(st.components.map((c) => [c.id, c.problem])));
            fs.unlinkSync(path.join(opt, 'mgu-updater', 'status.json'));
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
                /malformed/.test(st.catalog.error) && st.components.filter((c) => c.source === 'mgu-store').length === 2 && st.sources[0].status === 'error', st.catalog.error);
            publish(pubDir, [entry(app1, 'app', 'Demo'), entry(kit2, 'tool', 'Updater')], { signature: { alg: 'ecdsa-p256-sha256', value: 'AAAA' } });
            client.check();
            return waitFor(client, (s) => !s.catalog.error && !s.catalog.checking, 15000, 'the catalog with a signature field');
        })
        .then((st) => {
            ok('catalog: a signature field is not looked at', st.components.filter((c) => c.source === 'mgu-store').length === 2 && st.sources[0].status === 'ok');
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
            // an app on it that needs that version: installing it updates the updater first
            const stickApp = Object.assign(entry(appTgz(stick, 'stick_app', '0.1.0'), 'app', 'Stick App'), { requires: { 'mgu-updater': '0.8.0' } });
            publish(stick, [entry(updaterKit(stick, '0.8.0'), 'tool', 'Updater'), stickApp]);
            // written by mgu-install.js usb-repo from the built-in source
            fs.writeFileSync(path.join(stick, 'mgu-copy.json'), JSON.stringify({ copyOf: 'https://updates.test:8443/catalog.json' }));
            fs.writeFileSync(path.join(T, 'no-mounts'), `/dev/sdz1 ${stick} vfat ro 0 0\n`);
            return waitFor(client, (s) => row(s, 'mgu-updater').version === '0.8.0' && row(s, 'mgu-updater').status === 'update' &&
                row(s, 'mgu-updater').source === 'usb:SELFSTICK', 20000, 'the stick\'s updater offered offline')
                .then(() => {
                    // the shipped first check: the new version's first full check comes long after it starts
                    fs.writeFileSync(conf, confText('first_check_s = 60'));
                    restarting();
                    client.install('stick_app');
                    return sleep(3000).then(() => waitFor(client, (s) => version(s) === '0.8.0' && !fs.existsSync(trialFile) &&
                        !s.busy && !row(s, 'stick_app').queued, 60000, 'the stick\'s updater kept offline'));
                })
                .then((st) => {
                    ok('trial: a version from a USB stick is kept without internet',
                        current() === 'versions/0.8.0' && !fs.existsSync(path.join(opt, 'mgu-updater', 'trial-local')));
                    ok('trial: the app queued behind it installs from the stick once the new version runs',
                        row(st, 'stick_app').installed === '0.1.0' && !row(st, 'stick_app').error, JSON.stringify(row(st, 'stick_app')));
                    fs.writeFileSync(conf, confText());
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
                    fs.writeFileSync(path.join(stick, 'mgu-copy.json'), JSON.stringify({ copyOf: 'https://updates.test:8443/catalog.json' }));
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
    publish(second, [Object.assign(entry(appTgz(second, 'dup_app', '2.0.0'), 'app', 'Dup two'), { uninstallable: true })]);
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
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: 'Iv1.test', github_app_url: 'https://github.com/apps/mgu-store/', builtin_repo: 'robertnisipeanu/mgu-store',
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
            ok('collision: an id two sources list is a row for each, the first source\'s under the id, the other\'s beside it',
                comp('dup_app').source === 'mgu-store' && comp('dup_app').version === '1.0.0' && comp('dup_app@second').version === '2.0.0' &&
                comp('dup_app@second').installAs === 'dup_app' && comp('dup_app@second').blocked === null, JSON.stringify(s.components.filter((c) => /dup_app/.test(c.id))));
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
            ok('login: offered with a GitHub App client id configured', st().signin === true);
            ok('login: the GitHub App\'s install page from github_app_url',
                JSON.stringify(st().signinApp) === JSON.stringify({ installUrl: 'https://github.com/apps/mgu-store/installations/new' }));
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
            ok('uninstall: privileged; refused while something installed requires it, when not installed, and for a tool its source does not mark',
                errs[0] === 'forbidden' && /Needs needs base_tool/.test(errs[1]) && errs[2] === 'robertn_demo is not installed' && /cannot be removed/.test(errs[3]),
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
            // another source's row of an id whose install it queued for the next start (iDrive 8)
            process.env.FAKE_PENDING = 'dup_app=installs at the next start';
            u.origins.dup_app = { source: 'second', commit: null };
            fs.writeFileSync(deployLog, '');
            return u.refresh().then(() => {
                ok('pending: only the row of the origin that queued an id shows it pending', comp('dup_app@second').nextStart === 'install' &&
                    comp('dup_app@second').pendingReboot === true && comp('dup_app').nextStart === null && comp('dup_app').pendingReboot === false,
                    JSON.stringify([comp('dup_app'), comp('dup_app@second')]));
                return priv({ op: 'uninstall', id: 'dup_app' });
            }).then((err) => {
                ok('uninstall: another origin\'s row cannot remove an id queued from another', err === 'dup_app cannot be removed' && !deployed().length, err);
                return priv({ op: 'uninstall', id: 'dup_app@second' });
            }).then((err) => until(st, () => !st().busy && !comp('dup_app@second').queued, 20000, 'dup_app@second removed').then(() => err));
        })
        .then((err) => {
            ok('pending: another source\'s row of a queued install removes it, under the id it is queued as',
                err === null && deployed().join() === 'uninstall dup_app --yes' && comp('dup_app@second').error === null,
                JSON.stringify([err, deployed(), comp('dup_app@second')]));
            delete process.env.FAKE_PENDING;
            return u.refresh().then(() => ask(sock, { op: 'install', id: 'dup_app' })).then(() => installed('dup_app'));
        })
        .then(() => {
            ok('collision: only the source that installed an id updates it; another source\'s newer one is beside it, not installable',
                comp('dup_app').source === 'mgu-store' && comp('dup_app').status === 'installed' && comp('dup_app@second').version === '2.0.0' &&
                /^dup_app is already installed from /.test(comp('dup_app@second').blocked || ''), JSON.stringify(comp('dup_app@second')));
            fs.writeFileSync(deployLog, '');
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
        .then(() => stillRunning(() => uidPids(12995)))
        .then((left) => {
            ok('build: a script past build_timeout_s is stopped, its processes too', /took longer than 3 s/.test(comp('b_slow').error) && !left.length,
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
        .then(() => stillRunning(() => uidPids(12995)))
        .then((left) => {
            ok('build: a process the script leaves running outside its group is killed', !left.length, `${left}`);
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
            // source-probe: what a repo can be added on
            ghRepo('third/forks', { default_branch: 'dev', branches: { feature: 'a', master: 'b', dev: 'c', main: 'd', 'with space': 'e' } });
            ghRepo('third/many', { default_branch: 'zz-default' });
            for (let i = 0; i < 305; i++) {
                gh.repos['third/many'].branches[`b${String(i).padStart(3, '0')}`] = 'f';
            }
            ghRepo('owner/secret', { private: true, branches: { main: 'a' } });
            // a default branch no channel takes, and nothing else: no choice
            ghRepo('probe/oddbranch', { default_branch: 'with space', branches: { 'with space': 'a' } });
            // refused (403, no rate limit) for every stored token, readable without one
            ghRepo('probe/sso', { forbid: Object.keys(gh.users), branches: { main: 'a' } });
            ghRepo('probe/rel', { releases: [{ assets: [] }], tags: [{ name: 'nightly', sha: 'a' }], branches: { main: 'a' } });
            ghRepo('probe/tags', { tags: [{ name: 'nightly', sha: 'a' }, { name: 'v1.0.0', sha: 'a' }], branches: { main: 'a' } });
            // readable with the token that reads the private source
            ghRepo('probe/private', { private: true, tokens: [u.tokens.text(src('private').auth.token)], releases: [{ assets: [] }], branches: { main: 'a' } });
            const probe = (repo) => askRaw(sock, { op: 'source-probe', repo, secret, rid: `p-${repo}` });
            return Promise.all(['probe/rel', 'probe/tags', 'third/forks', 'third/many', 'probe/private', 'owner/secret', 'no/such']
                .map(probe).concat([probe('third/plain'), probe('bad repo'), askRaw(sock, { op: 'source-probe', repo: 'third/forks', rid: 'x' }),
                    probe('probe/oddbranch'), probe('probe/sso')]));
        })
        .then((r) => {
            const [rel, tagged, forks, many, priv2, secretRepo, none, plain, bad, noSecret, odd, sso] = r;
            ok('source-probe: a default branch no channel takes is left out', odd.status === 'ok' && odd.defaultBranch === null &&
                JSON.stringify(odd.branches) === '[]', JSON.stringify(odd));
            ok('source-probe: a 403 that is no rate limit tries the next token, then none', sso.status === 'ok' &&
                JSON.stringify(sso.branches) === '["main"]', JSON.stringify(sso));
            ok('source-probe: releases, no x.y.z tag, the default branch', rel.type === 'probe' && rel.repo === 'probe/rel' && rel.name === 'probe/rel' && rel.status === 'ok' &&
                rel.releases === true && rel.tags === false && rel.defaultBranch === 'main' && JSON.stringify(rel.branches) === '["main"]' && rel.more === false,
                JSON.stringify(rel));
            ok('source-probe: x.y.z tags, no release', tagged.status === 'ok' && tagged.releases === false && tagged.tags === true, JSON.stringify(tagged));
            ok('source-probe: main, master, the default branch, then the rest; a name no channel takes left out',
                JSON.stringify(forks.branches) === '["main","master","dev","feature"]' && forks.defaultBranch === 'dev' &&
                forks.releases === false && forks.tags === false, JSON.stringify(forks));
            ok('source-probe: at most 300 branches, the default one first even past them', many.branches.length === 301 &&
                many.branches[0] === 'zz-default' && many.branches[1] === 'b000' && many.branches[300] === 'b299' && many.more === true,
                JSON.stringify(many).slice(0, 200));
            ok('source-probe: a private repo, with the token that reaches it', priv2.status === 'ok' && priv2.releases === true, JSON.stringify(priv2));
            ok('source-probe: a private repo no token reaches, or none there: auth-needed', secretRepo.status === 'auth-needed' &&
                none.status === 'auth-needed', JSON.stringify([secretRepo, none]));
            ok('source-probe: refused for a source already there, a bad repo, without the secret', plain.type === 'error' &&
                /already a source/.test(plain.error) && bad.type === 'error' && /owner/.test(bad.error) && noSecret.error === 'forbidden',
                JSON.stringify([plain, bad, noSecret]));
            gh.rateLimited = true;
            return askRaw(sock, { op: 'source-probe', repo: 'third/forks', secret, rid: 'rl' });
        })
        .then((rl) => {
            gh.rateLimited = false;
            ok('source-probe: a spent rate limit', rl.status === 'rate-limited', JSON.stringify(rl));
            fs.renameSync(conf.lease, `${conf.lease}.away`);
            return askRaw(sock, { op: 'source-probe', repo: 'third/forks', secret, rid: 'off' });
        })
        .then((off) => {
            fs.renameSync(`${conf.lease}.away`, conf.lease);
            ok('source-probe: offline', off.status === 'offline', JSON.stringify(off));
            ok('source-probe: ordering', JSON.stringify(require('../js/sources').orderBranches(['a', 'master', 'trunk'], 'trunk')) ===
                '["master","trunk","a"]' && JSON.stringify(require('../js/sources').orderBranches(['x'], null)) === '["x"]');
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
            // written by usb-repo from mgu-store: besides its own app, a newer base_tool (installed from mgu-store) and robertn_demo at
            // mgu-store's version
            fs.writeFileSync(path.join(one, 'mgu-copy.json'), JSON.stringify({ copyOf: 'github:robertnisipeanu/mgu-store' }));
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
            pkgTgz(path.join(oapDir, 'Gauges v1.0.9.tgz'), true, { name: 'oap-gauges', version: '1.0.9', productName: 'Gauges' }, 'Apps');
            pkgTgz(path.join(oapDir, 'older-gauges.tar.gz'), true, { name: 'oap-gauges', version: '1.0.2' }, null);
            pkgTgz(path.join(oapDir, 'flat.TGZ'), false, { name: 'flat_app', version: '2.0.0', productName: 'Flat' }, null);
            // a newer package of an app another source installed
            pkgTgz(path.join(oapDir, 'rel.tgz'), false, { name: 'rel_app', version: '9.0.0' }, null);
            pkgTgz(path.join(oapDir, 'renderer.tgz'), true, { name: 'mgu-renderd', version: '1.0.0', mguService: 'renderer' }, null);
            pkgTgz(path.join(oapDir, 'odd-service.tgz'), true, { name: 'odd', version: '1.0.0', mguService: { unit: 'x' } }, null);
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
                        comp('oap-gauges').version === '1.0.9' && comp('oap-gauges').title === 'Apps' &&
                        comp('flat_app').title === 'Flat' && comp('loose_mgu').version === '0.2.0' && comp('oap-gauges').source === 'usb:STICK/oap',
                        JSON.stringify(st().components.filter((c) => /usb:STICK\/oap/.test(c.source))));
                    ok('usb oap/: every app can be removed', comp('flat_app').uninstallable === true && comp('loose_mgu').uninstallable === true);
                    ok('usb oap/: a root-service package is the tool it installs as; an unknown service, links and files that are not packages are left out',
                        comp('mgu-renderd').kind === 'tool' && comp('mgu-renderd').provides === 'renderer' && comp('rel_app').source === 'rel' &&
                        src('usb:STICK/oap').components === 5 && /broken\.tgz/.test(src('usb:STICK/oap').error || '') &&
                        /odd-service\.tgz: unknown mguService/.test(src('usb:STICK/oap').error || '') &&
                        !/renderer\.tgz|README|linked/.test(src('usb:STICK/oap').error || ''),
                        JSON.stringify(src('usb:STICK/oap')));
                    fs.writeFileSync(deployLog, '');
                    return ask(sock, { op: 'install', id: 'oap-gauges' });
                })
                .then(() => installed('oap-gauges'))
                .then(() => {
                    ok('usb oap/: a package installs under its id and version', /oap-gauges@1\.0\.9\.tgz --yes/.test(deployed()[0]), deployed()[0]);
                    ok('usb: a package of an installed id from a stick that is no copy of its source is beside it, not installable',
                        comp('rel_app').source === 'rel' && comp('rel_app@usb:STICK/oap').version === '9.0.0' &&
                        /^rel_app is already installed from /.test(comp('rel_app@usb:STICK/oap').blocked || ''), JSON.stringify(comp('rel_app@usb:STICK/oap')));
                    ok('usb: a newer version in a stick folder usb-repo wrote from a source is an update of a component it installed',
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
                    ok('usb: the update installs from the stick; the source it is a copy of stays its origin',
                        /base_tool@1\.1\.0\.tgz --yes/.test(deployed()[0]) && comp('base_tool').installed === '1.1.0' &&
                        JSON.parse(fs.readFileSync(path.join(state, 'origins.json'), 'utf8')).base_tool.source === 'mgu-store',
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
            ok('usb: a stick taken out is no longer a source; an app installed from it keeps a row for its Remove',
                !st().sources.some((x) => x.usb) && comp('usb_app').installed === '0.1.0' && comp('usb_app').uninstallable === true &&
                comp('usb_app').status === 'installed', JSON.stringify(comp('usb_app')));
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

/* The head unit, compatibility, root-service packages from an App Manager
 * index, and a capability two tools provide (an updater in this process,
 * the index served by the HTTPS server from pubDir). */
function testUnitServices(certs, pubDir) {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'mu');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const state = path.join(M, 'state');
    const cat = path.join(M, 'cat');
    [M, opt, oap, state, cat, path.join(M, 'shm'), path.join(M, 'media')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog });
    delete process.env.FAKE_LEASE;
    delete process.env.FAKE_PENDING;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    const deployed = () => fs.readFileSync(deployLog, 'utf8').split('\n').filter((l) => /^(install|uninstall)/.test(l));
    // the deploy tool that installs service packages
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.4.0'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.4.0', 'component.json'), JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '0.4.0' }));
    fs.symlinkSync('versions/0.4.0', path.join(opt, 'mgu-deploy', 'current'));
    // npm-format packages the App Manager's way
    const npmPkg = (name, pkg, files) => {
        const d = path.join(T, 'src', `idx-${name}`);
        mkdirp(path.join(d, 'package'));
        fs.writeFileSync(path.join(d, 'package', 'package.json'), JSON.stringify(pkg));
        Object.keys(files || {}).forEach((f) => {
            mkdirp(path.dirname(path.join(d, 'package', f)));
            fs.writeFileSync(path.join(d, 'package', f), files[f]);
        });
        const out = path.join(pubDir, name);
        cp.execFileSync('tar', ['-czf', out, '-C', d, 'package']);
        return { url: name, sha256: sha256(fs.readFileSync(out)) };
    };
    const renderer = npmPkg('mgu-renderd@1.1.0.tgz', { name: 'mgu-renderd', version: '1.1.0', productName: 'GPU renderer', mguService: 'renderer' },
        { 'mgu-renderd': 'ELF' });
    const id8 = npmPkg('oap-cardash@1.1.4.tgz', { name: 'oap-cardash', version: '1.1.4', productName: 'Car Data' },
        { 'rhmiData/application.json': JSON.stringify({ application: { name: 'oap-cardash', uiDescriptions: [{ hmi: ['ID8'] }] } }),
            'rhmiData/uiDescriptions/ID8/application.xml': '<x/>' });
    const both = npmPkg('both_app@1.0.0.tgz', { name: 'both_app', version: '1.0.0', mguHmi: ['ID7', 'ID8'] });
    fs.writeFileSync(path.join(pubDir, 'index.json'), JSON.stringify({ packages: [renderer, id8, both,
        { url: 'gone.tgz', sha256: '0'.repeat(64) }, { url: 'oap-cardash@1.1.4.tgz', sha256: '1'.repeat(64) },
        { url: 'a%zz.tgz', sha256: 'a'.repeat(64) }] }));
    // a catalog with another renderer, as a tool kit
    publish(cat, [Object.assign(entry(toolKit(cat, 'my-render', '0.1.0', { 'r.sh': ['#!/bin/sh\n', 0o755] }, { mguProvides: 'renderer' }), 'tool', 'My renderer'),
        { mguProvides: 'renderer', uninstallable: true })], { schema: 2 });
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [
        { id: 'mgu-store', type: 'file', path: path.join(M, 'empty'), builtin: true },
        { id: 'idx', type: 'https', url: `https://updates.test:${HTTPS_PORT}/index.json` },
        { id: 'cat', type: 'file', path: cat }
    ] }));
    mkdirp(path.join(M, 'empty'));
    publish(path.join(M, 'empty'), []);
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: state, tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'),
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: 'Iv1.test', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    fs.writeFileSync(conf.mounts, '');
    const u = new Updater(conf);
    const st = () => u.state();
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    const sock = conf.socket;
    const priv = (req) => ask(sock, Object.assign({ secret: u.secret }, req));
    const settled = () => until(st, (s) => !s.busy && !s.components.some((c) => c.queued) && !s.sources.some((x) => x.status === 'checking'), 60000, 'settled');
    const cached = (sha) => path.join(state, 'index', 'idx', `${sha}.tgz`);
    // the deploy tool's last_apply: both_app's install (or removal) at, ok or not
    const apply = (at, ok, action) => JSON.stringify({ at, results: [{ id: 'both_app', action: action || 'install', version: '1.0.0', ok,
        error: ok ? undefined : 'package checksum mismatch at /x', log: [] }, { id: 'oap-cardash', action: 'remove', ok: true, log: [] }] });
    const seenFile = path.join(state, 'apply-seen.json');
    return u.serve()
        .then(() => u.check())
        .then(() => {
            const s = st();
            ok('login: no install page without github_app_url', s.signinApp === null);
            ok('unit: the state names the head unit the deploy tool reports', JSON.stringify(s.unit) === JSON.stringify({ hmi: 'ID7', firmware: 'test firmware' }),
                JSON.stringify(s.unit));
            ok('index: an https URL serving {packages: [{url, sha256}]} is read as an App Manager index',
                s.sources.find((x) => x.id === 'idx').status === 'ok' && comp('mgu-renderd').source === 'idx' && comp('oap-cardash').source === 'idx' &&
                comp('both_app').version === '1.0.0', JSON.stringify(s.sources));
            ok('index: a package that is missing or does not match its sha256 is left out, said why',
                /gone\.tgz/.test(s.sources.find((x) => x.id === 'idx').error || '') &&
                /does not match the sha256/.test(s.sources.find((x) => x.id === 'idx').error || '') &&
                /URI malformed/.test(s.sources.find((x) => x.id === 'idx').error || ''), s.sources.find((x) => x.id === 'idx').error);
            ok('index: each package is kept by its sha256, root\'s alone', fs.existsSync(cached(renderer.sha256)) &&
                (fs.statSync(cached(renderer.sha256)).mode & 0o777) === 0o600);
            ok('service: a renderer package is listed as a tool providing renderer, compatibility unknown',
                comp('mgu-renderd').kind === 'tool' && comp('mgu-renderd').provides === 'renderer' && comp('mgu-renderd').service === 'renderer' &&
                comp('mgu-renderd').compat === 'unknown' && comp('mgu-renderd').uninstallable === true && comp('mgu-renderd').title === 'GPU renderer' &&
                u.src.get('idx').components.find((c) => c.id === 'mgu-renderd').requires['mgu-deploy'] === '0.4.0',
                JSON.stringify(comp('mgu-renderd')));
            ok('compat: an app whose rhmiData is iDrive 8 only is not for this iDrive 7; one declaring both is',
                JSON.stringify(comp('oap-cardash').mguHmi) === '["ID8"]' && comp('oap-cardash').compat === 'no' && comp('both_app').compat === 'yes',
                JSON.stringify([comp('oap-cardash'), comp('both_app')]));
            fs.unlinkSync(path.join(pubDir, 'mgu-renderd@1.1.0.tgz'));
            // the last start's apply (iDrive 8 last_apply): a failed install shows on its row
            process.env.FAKE_LAST_APPLY = apply('2026-10-28T08:00:00.000Z', false);
            return u.refresh();
        })
        .then(() => {
            ok('apply: a change the last start failed to apply shows its reason on the row',
                comp('both_app').error === 'the install at the start of the head unit failed: package checksum mismatch at /x' &&
                comp('both_app').applyFailed === 'install' && comp('oap-cardash').error === null && comp('oap-cardash').applyFailed === null,
                JSON.stringify(comp('both_app')));
            return priv({ op: 'uninstall', id: 'both_app' });
        })
        .then((err) => {
            ok('apply: removing an app whose first install failed at the start puts the failure aside, the deploy tool not asked',
                err === null && !comp('both_app').busy && comp('both_app').error === null && comp('both_app').applyFailed === null &&
                !comp('both_app').queued && !deployed().length, JSON.stringify([err, comp('both_app'), deployed()]));
            const again = new Updater(conf);
            return again.refresh().then(() => again);
        })
        .then((again) => {
            ok('apply: a failure put aside stays aside after a restart of the updater',
                again.applyError('both_app') === null && JSON.parse(fs.readFileSync(seenFile, 'utf8')).both_app === '2026-10-28T08:00:00.000Z',
                fs.existsSync(seenFile) && fs.readFileSync(seenFile, 'utf8'));
            process.env.FAKE_LAST_APPLY = apply('2026-10-28T09:00:00.000Z', false, 'remove');
            return u.refresh();
        })
        .then(() => {
            ok('apply: a failed removal shows as such', comp('both_app').applyFailed === 'remove' &&
                /^the removal at the start of the head unit failed/.test(comp('both_app').error || ''), JSON.stringify(comp('both_app')));
            // an install the deploy tool queued for the next start: pending before it is installed, and can be dropped
            process.env.FAKE_PENDING = 'both_app=installs at the next start';
            return u.refresh();
        })
        .then(() => {
            ok('pending: an app the deploy tool reports pending is pendingReboot before it is installed',
                comp('both_app').status === 'available' && !comp('both_app').installed && comp('both_app').pendingReboot === true &&
                comp('both_app').nextStart === 'install' && comp('mgu-renderd').pendingReboot === false && comp('mgu-renderd').nextStart === null,
                JSON.stringify(comp('both_app')));
            return priv({ op: 'uninstall', id: 'both_app' });
        })
        .then((err) => {
            ok('pending: a queued install can be removed: the deploy tool drops it', err === null, err);
            return settled();
        })
        .then(() => {
            ok('pending: removed through the deploy tool; the asked removal puts the failed apply aside',
                deployed().indexOf('uninstall both_app --yes') >= 0 && comp('both_app').error === null, JSON.stringify([deployed(), comp('both_app')]));
            fs.writeFileSync(deployLog, '');
            process.env.FAKE_PENDING = 'both_app=removed at the next start';
            return u.refresh();
        })
        .then(() => {
            ok('pending: a removal queued for the next start', comp('both_app').nextStart === 'remove' && comp('both_app').pendingReboot === true);
            // a newer start's apply that failed shows again
            delete process.env.FAKE_PENDING;
            process.env.FAKE_LAST_APPLY = apply('2026-10-29T08:00:00.000Z', false);
            return u.refresh();
        })
        .then(() => {
            ok('apply: a newer start\'s failure shows', /^the install at the start of the head unit failed/.test(comp('both_app').error || ''));
            // this start (began 2 min ago) put both_app in place a minute ago
            u.bootAt = () => Date.now() - 120000;
            process.env.FAKE_LAST_APPLY = apply(new Date(Date.now() - 60000).toISOString(), true);
            return u.refresh();
        })
        .then(() => {
            ok('apply: an app this start put in place stays pending until MainApp lists it', comp('both_app').pendingReboot === true &&
                comp('both_app').nextStart === 'install' && comp('both_app').status === 'available' && comp('both_app').error === null,
                JSON.stringify(comp('both_app')));
            return priv({ op: 'uninstall', id: 'both_app' }).then((err) => settled().then(() => err));
        })
        .then((err) => {
            ok('apply: an app put in place can be removed through the deploy tool', err === null && deployed().join() === 'uninstall both_app --yes',
                JSON.stringify([err, deployed()]));
            fs.writeFileSync(deployLog, '');
            // MainApp lists it: the state goes out again, installed
            let sent = 0;
            const changed = u.changed;
            u.changed = () => { sent += 1; changed.call(u); };
            u.watchPlaced();
            sent = 0;
            const reg = path.join(oap, 'oap_12201', 'data', 'apps', 'both_app.json');
            mkdirp(path.dirname(reg));
            fs.writeFileSync(reg, JSON.stringify({ userId: 13077 }));
            mkdirp(path.join(oap, 'oap_13077', 'source'));
            fs.writeFileSync(path.join(oap, 'oap_13077', 'source', 'package.json'), JSON.stringify({ name: 'both_app', version: '1.0.0' }));
            u.watchPlaced();
            ok('apply: the state goes out again once MainApp lists an app put in place', sent === 1 && comp('both_app').installed === '1.0.0' &&
                comp('both_app').pendingReboot === false, JSON.stringify([sent, comp('both_app')]));
            u.changed = changed;
            fs.unlinkSync(reg);
            // put in place 10 min ago and still not listed: a failed install, with Try again and Remove
            u.bootAt = () => Date.now() - 11 * 60000;
            process.env.FAKE_LAST_APPLY = apply(new Date(Date.now() - 10 * 60000).toISOString(), true);
            return u.refresh();
        })
        .then(() => {
            ok('apply: an app put in place but not listed within the grace is a failed install', comp('both_app').pendingReboot === false &&
                comp('both_app').nextStart === null && comp('both_app').applyFailed === 'install' &&
                comp('both_app').error === 'put in place at the last start but not registered', JSON.stringify(comp('both_app')));
            // one an earlier start put in place: the same
            u.bootAt = () => Date.now() - 60000;
            process.env.FAKE_LAST_APPLY = apply(new Date(Date.now() - 120000).toISOString(), true);
            return u.refresh();
        })
        .then(() => {
            ok('apply: an app an earlier start put in place, not listed, is a failed install', comp('both_app').pendingReboot === false &&
                comp('both_app').applyFailed === 'install', JSON.stringify(comp('both_app')));
            return priv({ op: 'uninstall', id: 'both_app' }).then((err) => settled().then(() => err));
        })
        .then((err) => {
            ok('apply: its Remove goes to the deploy tool, which takes the package out', err === null && deployed().join() === 'uninstall both_app --yes' &&
                comp('both_app').error === null, JSON.stringify([err, deployed(), comp('both_app')]));
            fs.writeFileSync(deployLog, '');
            delete process.env.FAKE_LAST_APPLY;
            return u.refresh();
        })
        .then(() => {
            ok('pending, apply: neither once the deploy tool reports none', comp('both_app').pendingReboot === false &&
                comp('both_app').nextStart === null && comp('both_app').error === null, JSON.stringify(comp('both_app')));
            return ask(sock, { op: 'install', id: 'oap-cardash' });
        })
        .then((err) => {
            ok('compat: installing it is refused with the reason, the deploy tool never asked',
                err === 'Car Data is for iDrive 8; this head unit is iDrive 7' && comp('oap-cardash').error === err && !deployed().length, err);
            return ask(sock, { op: 'install', id: 'mgu-renderd' });
        })
        .then((err) => until(st, () => !st().busy && comp('mgu-renderd').status === 'installed', 30000, 'renderer installed').then(() => err))
        .then((err) => {
            ok('service: it installs from the kept package (no longer served) through the deploy tool',
                err === null && /mgu-renderd@1\.1\.0\.tgz --yes/.test(deployed()[0]), `${err} ${deployed()}`);
            ok('provides: the state names the installed provider',
                JSON.stringify(st().allProviders) === '{"renderer":[{"id":"mgu-renderd","version":"1.1.0"}]}' &&
                JSON.stringify(st().providers) === '{"renderer":{"id":"mgu-renderd","version":"1.1.0"}}' &&
                comp('my-render').provides === 'renderer' && !('replaces' in comp('my-render')),
                JSON.stringify([st().allProviders, st().providers, comp('my-render')]));
            ok('requires: a requirement providing what another installed tool provides counts as met, another one not',
                u.requirementMet('my-render', '0.1.0') && !u.requirementMet('both_app', '9.0.0'));
            return ask(sock, { op: 'install', id: 'my-render' });
        })
        .then((err) => until(st, () => !st().busy && comp('my-render').status === 'installed', 30000, 'my-render installed').then(() => err))
        .then((err) => {
            ok('provides: a second renderer installs beside the first, without --replace', err === null &&
                /^install --artifact .*my-render@0\.1\.0\.tgz --yes$/.test(deployed()[1]) && comp('mgu-renderd').status === 'installed' &&
                JSON.stringify(st().allProviders) === '{"renderer":[{"id":"mgu-renderd","version":"1.1.0"},{"id":"my-render","version":"0.1.0"}]}' &&
                JSON.stringify(st().providers) === '{"renderer":{"id":"mgu-renderd","version":"1.1.0"}}' &&
                u.origins['mgu-renderd'] && u.origins['my-render'].source === 'cat', `${err} ${deployed()} ${JSON.stringify(st().allProviders)}`);
            return priv({ op: 'uninstall', id: 'my-render' });
        })
        .then(() => until(st, () => !st().busy && comp('my-render').status === 'available', 30000, 'my-render removed'))
        .then(() => {
            ok('provides: after its uninstall the first renderer is the one provider',
                JSON.stringify(st().allProviders) === '{"renderer":[{"id":"mgu-renderd","version":"1.1.0"}]}', JSON.stringify(st().allProviders));
            return priv({ op: 'uninstall', id: 'mgu-renderd' });
        })
        .then(() => until(st, () => !st().busy && comp('mgu-renderd').status === 'available', 30000, 'mgu-renderd removed'))
        .then(() => {
            ok('provides: after both uninstalls no tool provides it', JSON.stringify(st().allProviders) === '{}' && JSON.stringify(st().providers) === '{}');
            process.env.FAKE_UNIT_HMI = 'ID8';
            return u.refresh();
        })
        .then(() => {
            ok('compat: on iDrive 8 the iDrive 8 app is', comp('oap-cardash').compat === 'yes' && st().unit.hmi === 'ID8');
            delete process.env.FAKE_UNIT_HMI;
            fs.writeFileSync(path.join(pubDir, 'index.json'), JSON.stringify({ packages: [both] }));
            return u.check();
        })
        .then(() => settled())
        .then(() => {
            ok('index: a package the index no longer lists is no longer kept', !fs.existsSync(cached(renderer.sha256)) &&
                fs.existsSync(cached(both.sha256)) && !comp('oap-cardash').id);
            u.server.close();
        });
}

/* Requirements across sources (another repository's catalog and mgu-store's): an
 * app that requires a tool of its own catalog, which requires a renderer
 * there and a newer deploy tool from mgu-store's. Installing the app
 * installs, in order, the deploy tool update, the renderer, the tool and
 * the app; the tool whose install the deploy tool reports restart-pending
 * shows so. Removing them: the tool is refused while the app that needs it
 * is installed; the app, then the tool, go through the deploy tool; the
 * renderer and the deploy tool stay. */
function testCrossSource(certs) {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'xs');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const state = path.join(M, 'state');
    const store = path.join(M, 'store');
    const apps = path.join(M, 'apps');
    [M, opt, oap, state, store, apps, path.join(M, 'shm'), path.join(M, 'media')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog, FAKE_PENDING: 'hooked-tool' });
    delete process.env.FAKE_LEASE;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    const deployed = () => fs.readFileSync(deployLog, 'utf8').split('\n').filter((l) => /^(install|uninstall)/.test(l));
    // the deploy tool installed, a version before the one that runs install hooks
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.6.9'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.6.9', 'component.json'), JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '0.6.9' }));
    fs.symlinkSync('versions/0.6.9', path.join(opt, 'mgu-deploy', 'current'));
    const kit = (dir, id, version, extra) => toolKit(dir, id, version, { [`${id}.sh`]: ['#!/bin/sh\n', 0o755] }, extra);
    publish(store, [entry(kit(store, 'mgu-deploy', '0.7.0'), 'tool', 'Deploy tool')], { schema: 2 });
    const hooks = { activate: ['node', 'hook.js', 'activate'], deactivate: ['node', 'hook.js', 'deactivate'] };
    const tool = { requires: { 'mgu-deploy': '0.7.0', 'lib-tool': '0.1.0' }, mguHmi: ['ID7'] };
    publish(apps, [
        Object.assign(entry(kit(apps, 'lib-tool', '0.1.0', { mguHmi: ['ID7'] }), 'tool', 'Library tool'), { mguHmi: ['ID7'] }),
        Object.assign(entry(kit(apps, 'hooked-tool', '0.5.0', Object.assign({}, tool, hooks)), 'tool', 'Hooked tool'), tool, { uninstallable: true }),
        Object.assign(entry(appTgz(apps, 'robertn_hooked_app', '0.3.0'), 'app', 'Hooked app'), { requires: { 'hooked-tool': '0.5.0' }, uninstallable: true })
    ], { schema: 2 });
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [
        { id: 'mgu-store', type: 'file', path: store, builtin: true },
        { id: 'other-repo', type: 'file', path: apps }
    ] }));
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: state, tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'),
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: 'Iv1.test', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    fs.writeFileSync(conf.mounts, '');
    const u = new Updater(conf);
    const st = () => u.state();
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    const priv = (req) => ask(conf.socket, Object.assign({ secret: u.secret }, req));
    const idle = (what) => until(st, () => !st().busy && !st().components.some((c) => c.queued), 60000, what);
    return u.serve()
        .then(() => u.check())
        .then(() => {
            ok('cross-source: the tool lists its requirements and hooks\' iDrive', JSON.stringify(comp('hooked-tool').mguHmi) === '["ID7"]' &&
                comp('lib-tool').source === 'other-repo' && comp('mgu-deploy').source === 'mgu-store', JSON.stringify(st().components));
            return ask(conf.socket, { op: 'install', id: 'robertn_hooked_app' });
        })
        .then((err) => until(st, () => !st().busy && !st().components.some((c) => c.queued) &&
            comp('robertn_hooked_app').status === 'installed', 60000, 'the app installed').then(() => err))
        .then((err) => {
            const order = deployed().map((l) => (/([a-z_-]+)@(\d+\.\d+\.\d+)\.tgz/.exec(l) || [])[0]);
            ok('cross-source: installing the app installs the deploy tool update, the renderer, the tool, then the app',
                err === null && JSON.stringify(order) === JSON.stringify(['mgu-deploy@0.7.0.tgz', 'lib-tool@0.1.0.tgz',
                    'hooked-tool@0.5.0.tgz', 'robertn_hooked_app@0.3.0.tgz']), `${err} ${JSON.stringify(deployed())}`);
            ok('cross-source: each from its own source', u.origins['mgu-deploy'].source === 'mgu-store' &&
                u.origins['lib-tool'].source === 'other-repo' && u.origins['hooked-tool'].source === 'other-repo', JSON.stringify(u.origins));
            ok('cross-source: the tool the deploy tool reports restart-pending shows so, the others do not',
                comp('hooked-tool').pendingReboot === true && comp('lib-tool').pendingReboot === false &&
                comp('robertn_hooked_app').pendingReboot === false, JSON.stringify(st().components.map((c) => [c.id, c.pendingReboot])));
            delete process.env.FAKE_PENDING;
            fs.writeFileSync(deployLog, '');
            return Promise.all([priv({ op: 'uninstall', id: 'hooked-tool' }), priv({ op: 'uninstall', id: 'lib-tool' })]);
        })
        .then((errs) => {
            ok('cross-source removal: the tool is refused while the app needs it; the renderer is not removable',
                errs[0] === 'Hooked app needs hooked-tool' && errs[1] === 'lib-tool cannot be removed' && !deployed().length,
                JSON.stringify(errs));
            return priv({ op: 'uninstall', id: 'robertn_hooked_app' });
        })
        .then((err) => idle('the app removed').then(() => err))
        .then((err) => {
            ok('cross-source removal: the app goes first', err === null && comp('robertn_hooked_app').status === 'available' &&
                comp('hooked-tool').status === 'installed', `${err} ${JSON.stringify(deployed())}`);
            return priv({ op: 'uninstall', id: 'hooked-tool' });
        })
        .then((err) => idle('the tool removed').then(() => err))
        .then((err) => {
            ok('cross-source removal: then the tool, through the deploy tool, the renderer and the deploy tool stay',
                err === null && JSON.stringify(deployed()) === JSON.stringify(['uninstall robertn_hooked_app --yes', 'uninstall hooked-tool --yes']) &&
                comp('hooked-tool').status === 'available' && comp('lib-tool').status === 'installed' &&
                comp('mgu-deploy').installed === '0.7.0', `${err} ${JSON.stringify(deployed())} ${JSON.stringify(st().components.map((c) => [c.id, c.status]))}`);
            u.server.close();
        });
}

/* An App Manager index version 2 (listed from the index alone, icons kept by
 * the updater), and icons a catalog in a folder and a repo's mgu-store.json
 * name (an updater in this process; the index served from pubDir). */
function testIndexV2(certs, pubDir) {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'v2');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const state = path.join(M, 'state');
    const cat = path.join(M, 'cat');
    [M, opt, oap, state, cat, path.join(M, 'shm'), path.join(M, 'media'), path.join(M, 'empty')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog });
    delete process.env.FAKE_LEASE;
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_UNIT_HMI;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    const deployed = () => fs.readFileSync(deployLog, 'utf8').split('\n').filter((l) => /^(install|uninstall)/.test(l));
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.4.0'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.4.0', 'component.json'), JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '0.4.0' }));
    fs.symlinkSync('versions/0.4.0', path.join(opt, 'mgu-deploy', 'current'));
    const png = (n, fill) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(n, fill)]);
    const pkg = (file, pj) => {
        const d = path.join(T, 'src', `v2-${file}`);
        mkdirp(path.join(d, 'package'));
        fs.writeFileSync(path.join(d, 'package', 'package.json'), JSON.stringify(pj));
        const out = path.join(pubDir, file);
        cp.execFileSync('tar', ['-czf', out, '-C', d, 'package']);
        const data = fs.readFileSync(out);
        return { url: file, sha256: sha256(data), size: data.length };
    };
    const icon = (name, data) => {
        fs.writeFileSync(path.join(pubDir, name), data);
        return { icon: `icons/${name}`, iconSha256: sha256(data) };
    };
    const appIcon = png(300, 1);
    const item = (file, pj, meta) => Object.assign(pkg(file, pj), { id: pj.name, version: pj.version, kind: pj.mguService || 'app',
        title: pj.productName, author: 'IterioDev', description: `About ${pj.name}`, updated: '2026-10-26', renderer: false }, meta);
    const index = { version: 2, name: 'car-apps', packages: [
        item('v2app@1.0.0.tgz', { name: 'v2app', version: '1.0.0', productName: 'V2 App' }, Object.assign({ renderer: true }, icon('v2app.png', appIcon))),
        item('v2render@1.1.1.tgz', { name: 'v2render', version: '1.1.1', productName: 'GPU renderer', mguService: 'renderer' },
            { icon: 'icons/v2render.png' }),
        item('v2both@1.0.0.tgz', { name: 'v2both', version: '1.0.0', productName: 'Both' },
            Object.assign({ mguHmi: ['ID7', 'ID8'] }, icon('v2both.png', png(10, 2)), { iconSha256: 'f'.repeat(64) })),
        item('v2liar@1.0.0.tgz', { name: 'someone-else', version: '1.0.0', productName: 'Liar' }, { id: 'v2liar', mguHmi: ['ID7'] }),
        item('v2big@1.0.0.tgz', { name: 'v2big', version: '1.0.0', productName: 'Big' }, icon('v2big.png', png(200 << 10, 3))),
        item('v2odd@1.0.0.tgz', { name: 'v2odd', version: '1.0.0', productName: 'Odd' }, { kind: 'widget' })] };
    // another id naming v2both's package
    index.packages.push(Object.assign({}, index.packages[2], { id: 'v2twin', title: 'Twin', icon: undefined, iconSha256: undefined }));
    fs.writeFileSync(path.join(pubDir, 'v2render.png'), png(40, 4));
    fs.writeFileSync(path.join(pubDir, 'v2-index.json'), JSON.stringify(index));
    // a catalog in a folder, its icon beside it
    publish(cat, [Object.assign(entry(appTgz(cat, 'cat_app', '1.0.0'), 'app', 'Catalog App'), { icon: 'cat_app.png', author: 'Me' })], { schema: 2 });
    fs.writeFileSync(path.join(cat, 'cat_app.png'), png(20, 5));
    // a repo's releases, mgu-store.json naming an asset as the icon
    const relIcon = png(30, 6);
    ghRepo('pub/v2rel', { releases: [{ assets: [{ name: 'rel2@1.0.0.tgz', data: fs.readFileSync(appTgz(path.join(M, 'empty'), 'rel2', '1.0.0')) },
        { name: 'rel2.png', data: relIcon },
        { name: 'mgu-store.json', data: Buffer.from(JSON.stringify({ apps: { rel2: { title: 'Release Two', author: 'Pub', icon: 'rel2.png', iconSha256: sha256(relIcon) } } })) }] }] });
    publish(path.join(M, 'empty'), []);
    // packages carrying the store's data: icon.png, author, store.description (on a stick's oap/, in a version 1 index)
    const storePkg = (out, pj, iconData) => {
        const d = path.join(T, 'src', `store-${path.basename(out)}`);
        mkdirp(path.join(d, 'package'));
        fs.writeFileSync(path.join(d, 'package', 'package.json'), JSON.stringify(pj));
        if (iconData) {
            fs.writeFileSync(path.join(d, 'package', 'icon.png'), iconData);
        }
        cp.execFileSync('tar', ['-czf', out, '-C', d, 'package']);
        return out;
    };
    const stickIcon = png(50, 7);
    const v1Icon = png(60, 8);
    const stick = path.join(M, 'media', 'STICK');
    mkdirp(path.join(stick, 'oap'));
    storePkg(path.join(stick, 'oap', 'usb store app.tgz'), { name: 'usb_store', version: '1.0.0', productName: 'USB Store App',
        author: { name: 'IterioDev' }, description: 'npm text', store: { description: 'Store text' } }, stickIcon);
    storePkg(path.join(stick, 'oap', 'plain.tgz'), { name: 'usb_plain', version: '1.0.0', author: 'Someone', description: 'Plain text', store: { description: '' } },
        png(20 + (130 << 10), 9));
    // one without icon.png: its entry point's icon, in its variant group's resources
    const entryIconData = png(55, 10);
    const ep = path.join(T, 'src', 'store-entry', 'package');
    mkdirp(path.join(ep, 'rhmiData', 'variantGroups', 'Common', 'images'));
    fs.writeFileSync(path.join(ep, 'package.json'), JSON.stringify({ name: 'usb_entry', version: '1.0.0' }));
    fs.writeFileSync(path.join(ep, 'rhmiData', 'application.json'), JSON.stringify({ application: {
        entryPoints: [{ icon: 'usb_entry_icon.png' }], variantGroups: [{ resourcesPath: './variantGroups/Common/images' }] } }));
    fs.writeFileSync(path.join(ep, 'rhmiData', 'variantGroups', 'Common', 'images', 'usb_entry_icon.png'), entryIconData);
    cp.execFileSync('tar', ['-czf', path.join(stick, 'oap', 'entry.tgz'), '-C', path.dirname(ep), 'package']);
    fs.writeFileSync(path.join(M, 'mounts'), `/dev/sda1 ${stick} vfat rw 0 0\n`);
    const v1 = fs.readFileSync(storePkg(path.join(pubDir, 'v1store@1.0.0.tgz'), { name: 'v1store', version: '1.0.0', author: 'V1',
        store: { description: 'From a v1 index' } }, v1Icon));
    fs.writeFileSync(path.join(pubDir, 'v1-index.json'), JSON.stringify({ packages: [{ url: 'v1store@1.0.0.tgz', sha256: sha256(v1) }] }));
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [
        { id: 'mgu-store', type: 'file', path: path.join(M, 'empty'), builtin: true },
        { id: 'car-apps', type: 'https', url: `https://updates.test:${HTTPS_PORT}/v2-index.json` },
        { id: 'v1', type: 'https', url: `https://updates.test:${HTTPS_PORT}/v1-index.json` },
        { id: 'cat', type: 'file', path: cat },
        { id: 'rel', type: 'github', repo: 'pub/v2rel', channel: 'releases' }
    ] }));
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: state, tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'),
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    const u = new Updater(conf);
    const st = () => u.state();
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    const sock = conf.socket;
    const asked = (re) => seen.filter((x) => re.test(x.url)).length;
    const from = seen.length;
    const iconDir = path.join(state, 'icons');
    let iconAsks = 0;
    // icons are fetched in the background after each source is read
    const checked = () => u.check().then(() => until(() => Array.from(u.src.values()).map((rt) => !!rt.icons), (l) => l.every((x) => !x), 30000, 'icons fetched'));
    return u.serve()
        .then(() => checked())
        .then(() => {
            const s = st();
            const src = s.sources.find((x) => x.id === 'car-apps');
            ok('index v2: listed from the index alone, no package downloaded', src.status === 'ok' && src.components === 6 &&
                !seen.slice(from).some((x) => /^\/v2[a-z]*@/.test(x.url)), JSON.stringify(src));
            ok('index v2: an unknown kind is left out, said why', /v2odd: unknown kind widget/.test(src.error || '') && !comp('v2odd').id, src.error);
            const a = comp('v2app');
            ok('index v2: an app with title, author, description; no mguHmi: iDrive 8, not for this iDrive 7',
                a.kind === 'app' && a.title === 'V2 App' && a.author === 'IterioDev' && a.description === 'About v2app' && a.version === '1.0.0' &&
                a.size === index.packages[0].size && JSON.stringify(a.mguHmi) === '["ID8"]' && a.compat === 'no' && a.uninstallable === true, JSON.stringify(a));
            const r = comp('v2render');
            ok('index v2: kind renderer is a tool providing renderer, needing the deploy tool that installs service packages',
                r.kind === 'tool' && r.provides === 'renderer' && r.service === 'renderer' && r.compat === 'unknown' &&
                u.src.get('car-apps').components.find((c) => c.id === 'v2render').requires['mgu-deploy'] === '0.4.0', JSON.stringify(r));
            ok('index v2: mguHmi in an entry counts', comp('v2both').compat === 'yes');
            ok('icons: kept by their sha256 under the state folder, readable by anyone, the bytes the index names',
                a.icon === path.join(iconDir, `${sha256(appIcon)}.png`) && fs.readFileSync(a.icon).equals(appIcon) &&
                (fs.statSync(a.icon).mode & 0o777) === 0o644 && (fs.statSync(iconDir).mode & 0o777) === 0o755, a.icon);
            ok('icons: one without a sha256 is kept too', r.icon && fs.readFileSync(r.icon).equals(png(40, 4)), r.icon);
            ok('icons: one that does not match its sha256, or is too big, is not kept', comp('v2both').icon === null && comp('v2big').icon === null &&
                fs.readdirSync(iconDir).length === 7, fs.readdirSync(iconDir).join());
            ok('icons: a folder catalog\'s icon beside it, with its author', comp('cat_app').icon && fs.readFileSync(comp('cat_app').icon).equals(png(20, 5)) &&
                comp('cat_app').author === 'Me', JSON.stringify(comp('cat_app')));
            ok('icons: a release asset mgu-store.json names', comp('rel2').icon && fs.readFileSync(comp('rel2').icon).equals(relIcon) &&
                comp('rel2').title === 'Release Two' && comp('rel2').author === 'Pub', JSON.stringify(comp('rel2')));
            ok('icons: none for a component that names none', comp('v2liar').icon === null && comp('v2liar').author === 'IterioDev');
            const us = comp('usb_store');
            ok('package: a stick\'s package gives its icon.png, author.name and store.description', us.source === 'usb:STICK/oap' &&
                us.icon === path.join(iconDir, `${sha256(stickIcon)}.png`) && fs.readFileSync(us.icon).equals(stickIcon) &&
                us.author === 'IterioDev' && us.description === 'Store text', JSON.stringify(us));
            ok('package: author as a string, description under an empty store.description, an icon.png over 128 KiB left out',
                comp('usb_plain').author === 'Someone' && comp('usb_plain').description === 'Plain text' && comp('usb_plain').icon === null,
                JSON.stringify(comp('usb_plain')));
            ok('package: without icon.png, a package gives its entry point\'s icon', comp('usb_entry').icon &&
                fs.readFileSync(comp('usb_entry').icon).equals(entryIconData), JSON.stringify(comp('usb_entry')));
            ok('package: a version 1 index\'s package gives them too', comp('v1store').icon && fs.readFileSync(comp('v1store').icon).equals(v1Icon) &&
                comp('v1store').author === 'V1' && comp('v1store').description === 'From a v1 index', JSON.stringify(comp('v1store')));
            iconAsks = asked(/\.png$/);
            return checked();
        })
        .then(() => {
            ok('icons: kept ones are not fetched again, nor failed ones within a day', asked(/\.png$/) === iconAsks, `${asked(/\.png$/)} ${iconAsks}`);
            // a day later: a too-big icon and one that does not match its sha256 are not asked for again
            Object.keys(u.iconFailed).forEach((k) => {
                u.iconFailed[k].at -= 2 * 86400000;
            });
            iconAsks = asked(/\.png$/);
            return checked();
        })
        .then(() => {
            ok('icons: a day later, a too-big icon and a mismatched one are still not asked for again (that version)',
                asked(/\.png$/) === iconAsks && comp('v2big').icon === null && comp('v2both').icon === null, `${asked(/\.png$/)} ${iconAsks}`);
            // the index gives v2both's icon its right sha256: a new icon is asked for once
            const both = index.packages.find((x) => x.id === 'v2both');
            both.iconSha256 = sha256(fs.readFileSync(path.join(pubDir, 'v2both.png')));
            fs.writeFileSync(path.join(pubDir, 'v2-index.json'), JSON.stringify(index));
            iconAsks = asked(/\.png$/);
            return checked();
        })
        .then(() => {
            ok('icons: an icon with a new sha256 is asked for again, once', asked(/v2both\.png$/) >= 1 && asked(/\.png$/) === iconAsks + 1 &&
                comp('v2both').icon && fs.readFileSync(comp('v2both').icon).equals(png(10, 2)), `${asked(/\.png$/)} ${iconAsks}`);
            return ask(sock, { op: 'install', id: 'v2both' });
        })
        .then((err) => until(st, () => !st().busy && comp('v2both').status !== 'available', 30000, 'v2both installed').then(() => err))
        .then((err) => {
            const b = index.packages[2];
            ok('index v2: an install downloads the package, checks it and keeps it by its sha256',
                err === null && comp('v2both').status === 'installed' && /v2both@1\.0\.0\.tgz --yes/.test(deployed()[0] || '') &&
                fs.existsSync(path.join(state, 'index', 'car-apps', `${b.sha256}.tgz`)), `${err} ${deployed()} ${JSON.stringify(comp('v2both'))}`);
            return ask(sock, { op: 'install', id: 'v2liar' });
        })
        .then(() => until(st, () => !st().busy && !comp('v2liar').queued, 30000, 'v2liar refused'))
        .then(() => {
            ok('index v2: a package that is not what the index says is not installed', /someone-else@1\.0\.0, not what the index says/.test(comp('v2liar').error || '') &&
                deployed().length === 1, `${comp('v2liar').error} ${deployed()}`);
            return ask(sock, { op: 'install', id: 'v2twin' });
        })
        .then(() => until(st, () => !st().busy && !comp('v2twin').queued, 30000, 'v2twin refused'))
        .then(() => {
            ok('index v2: nor is a kept package another entry names', /v2both@1\.0\.0, not what the index says/.test(comp('v2twin').error || '') &&
                deployed().length === 1, `${comp('v2twin').error} ${deployed()}`);
            index.packages = index.packages.filter((p) => p.id !== 'v2app');
            fs.writeFileSync(path.join(pubDir, 'v2-index.json'), JSON.stringify(index));
            return checked();
        })
        .then(() => {
            ok('icons: one no component names any more goes', !fs.existsSync(path.join(iconDir, `${sha256(appIcon)}.png`)) && !comp('v2app').id &&
                comp('v2render').icon, fs.readdirSync(iconDir).join());
            u.server.close();
        });
}

/* A unit that runs IterioDev's App Manager (the deploy tool's status names
 * it): adopted once; the apps it installed get the source of its public
 * repository (added as one) or imported; its app and tether are replaced,
 * listed but not installed from any source; its app's Remove is the deploy
 * tool's uninstall. */
function testAppManager(certs, pubDir) {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'am');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const state = path.join(M, 'state');
    [M, opt, oap, state, path.join(M, 'shm'), path.join(M, 'media'), path.join(M, 'empty')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog, FAKE_UNIT_HMI: 'ID8' });
    delete process.env.FAKE_LEASE;
    delete process.env.FAKE_PENDING;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    const calls = () => fs.readFileSync(deployLog, 'utf8').split('\n').filter(Boolean);
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.5.0'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.5.0', 'component.json'), JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '0.5.0' }));
    fs.symlinkSync('versions/0.5.0', path.join(opt, 'mgu-deploy', 'current'));
    // what MainApp-21 installed for the App Manager
    const installed = (id, version, uid) => {
        mkdirp(path.join(oap, 'oap_12201', 'data', 'apps'));
        mkdirp(path.join(oap, `oap_${uid}`, 'source'));
        fs.writeFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${id}.json`), JSON.stringify({ userId: uid }));
        fs.writeFileSync(path.join(oap, `oap_${uid}`, 'source', 'package.json'), JSON.stringify({ name: id, version }));
    };
    installed('oap-appmanager', '2.0.3', 13001);
    installed('oap-cardash', '1.1.4', 13002);
    installed('oap-usbapp', '1.0.0', 13003);
    installed('oap-private', '1.0.0', 13004);
    // his repository's index (index v2), with his app, his tether and a newer Car Data
    const pkg = (file, pj) => {
        const d = path.join(T, 'src', `am-${file}`);
        mkdirp(path.join(d, 'package'));
        fs.writeFileSync(path.join(d, 'package', 'package.json'), JSON.stringify(pj));
        const out = path.join(pubDir, file);
        cp.execFileSync('tar', ['-czf', out, '-C', d, 'package']);
        const data = fs.readFileSync(out);
        return { url: file, sha256: sha256(data), size: data.length, id: pj.name, version: pj.version, kind: pj.mguService || 'app',
            title: pj.productName, author: 'IterioDev' };
    };
    const index = `https://updates.test:${HTTPS_PORT}/am-index.json`;
    fs.writeFileSync(path.join(pubDir, 'am-index.json'), JSON.stringify({ version: 2, name: 'car-apps', packages: [
        pkg('oap-appmanager@2.0.4.tgz', { name: 'oap-appmanager', version: '2.0.4', productName: 'App Manager' }),
        pkg('oap-cardash@1.1.5.tgz', { name: 'oap-cardash', version: '1.1.5', productName: 'Car Data' }),
        pkg('ipheth-tether@1.0.1.tgz', { name: 'ipheth-tether', version: '1.0.1', productName: 'iPhone tether', mguService: 'tether' })] }));
    fs.writeFileSync(`${deployLog}.appmanager`, JSON.stringify({ present: true, version: '2.0.3', app: '2.0.3', daemon: 'active', record: null }));
    fs.writeFileSync(`${deployLog}.amrecord`, JSON.stringify({ at: '2026-10-26T10:00:00.000Z', version: '2.0.3', app: '2.0.3', renderer: '1.1.2', tether: '1.0.1',
        apps: [{ id: 'oap-cardash', version: '1.1.4', from: null }, { id: 'oap-usbapp', version: '1.0.0', from: null },
            { id: 'oap-private', version: '1.0.0', from: 'github.com/me/priv' }],
        repos: [{ url: 'github.com/IterioDev/car-apps', index, private: false, enabled: true, isDefault: true, lists: ['oap-appmanager', 'oap-cardash'] },
            { url: 'github.com/me/priv', index: 'https://api.github.com/repos/me/priv/contents/index.json', private: true, enabled: true, isDefault: false, lists: [] }] }));
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'file', path: path.join(M, 'empty'), builtin: true }] }));
    publish(path.join(M, 'empty'), []);
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: state, tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'),
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    fs.writeFileSync(conf.mounts, 'proc /proc proc rw 0 0\n');
    let u = new Updater(conf);
    const st = () => u.state();
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    const adopts = () => calls().filter((l) => l === 'appmanager adopt --yes').length;
    return u.serve()
        .then(() => u.refresh())
        .then(() => until(() => u.adopted.at, (at) => !!at && !u.busy, 30000, 'App Manager adopted'))
        .then(() => u.check())
        .then(() => {
            const src = u.stored.find((d) => d.type === 'https' && d.url === index);
            ok('appmanager: adopted once through the deploy tool', adopts() === 1, calls().join('; '));
            ok('appmanager: his public repository becomes a source named after it', src && src.id === 'car-apps' &&
                JSON.parse(fs.readFileSync(sources, 'utf8')).sources.some((d) => d.id === 'car-apps'), JSON.stringify(u.stored));
            ok('appmanager: an app his store lists keeps that repository as its origin; a stick\'s and a private repository\'s are imported',
                u.origins['oap-cardash'] && u.origins['oap-cardash'].source === 'car-apps' && !u.origins['oap-usbapp'] && !u.origins['oap-private'] &&
                JSON.stringify(JSON.parse(fs.readFileSync(path.join(state, 'appmanager.json'), 'utf8')).imported) === '["oap-usbapp","oap-private"]',
                JSON.stringify(u.origins));
            const am = comp('oap-appmanager');
            ok('appmanager: his app is listed as replaced by the Store, installed, with a Remove', am.blocked === 'Replaced by Store' &&
                am.installed === '2.0.3' && am.uninstallable === true, JSON.stringify(am));
            ok('appmanager: his tether is replaced by mgu-uplink', comp('ipheth-tether').blocked === 'Replaced by mgu-uplink', JSON.stringify(comp('ipheth-tether')));
            ok('appmanager: Car Data updates from his repository', comp('oap-cardash').status === 'update' && comp('oap-cardash').source === 'car-apps' &&
                !comp('oap-cardash').blocked, JSON.stringify(comp('oap-cardash')));
            const imp = comp('oap-usbapp');
            ok('appmanager: an imported app no source lists keeps a row, installed and removable', imp.source === 'imported' &&
                imp.status === 'installed' && imp.installed === '1.0.0' && imp.uninstallable === true, JSON.stringify(imp));
            return Promise.all([ask(conf.socket, { op: 'install', id: 'oap-appmanager' }), ask(conf.socket, { op: 'install', id: 'ipheth-tether' }),
                ask(conf.socket, { op: 'install', id: 'oap-usbapp' })]);
        })
        .then(([a, t, i]) => {
            ok('appmanager: his app and his tether are not installed from any source', a === 'Replaced by Store' && t === 'Replaced by mgu-uplink' &&
                !calls().some((l) => /^install .*(oap-appmanager|ipheth-tether)/.test(l)), `${a} ${t}`);
            ok('appmanager: an imported app is not installed from nowhere', /oap-usbapp is in no source/.test(i || ''), i);
            return ask(conf.socket, { op: 'install', id: 'oap-cardash' });
        })
        .then(() => until(st, () => !st().busy && comp('oap-cardash').status === 'installed', 30000, 'oap-cardash updated'))
        .then(() => {
            ok('appmanager: his app updates through the Store from his repository', calls().some((l) => /^install --artifact .*oap-cardash@1\.1\.5\.tgz --yes$/.test(l)) &&
                u.origins['oap-cardash'].source === 'car-apps', calls().join('; '));
            return ask(conf.socket, { op: 'uninstall', id: 'oap-appmanager', secret: u.secret });
        })
        .then(() => until(st, () => !st().busy && !comp('oap-appmanager').installed, 30000, 'App Manager removed'))
        .then(() => {
            ok('appmanager: Remove App Manager is the deploy tool\'s uninstall of oap-appmanager', calls().includes('uninstall oap-appmanager --yes') &&
                u.appmanager.present === false, calls().join('; '));
            u.server.close();
            // a restart: the record is taken over once
            u = new Updater(conf);
            return u.serve().then(() => u.refresh()).then(() => sleep(300));
        })
        .then(() => {
            ok('appmanager: a later start does not adopt again', adopts() === 1 && u.adopted.at === '2026-10-26T10:00:00.000Z' &&
                u.origins['oap-cardash'].source === 'car-apps', calls().join('; '));
            u.server.close();
            // install.sh run again, without his app: his service alone
            const am = JSON.parse(fs.readFileSync(`${deployLog}.appmanager`, 'utf8'));
            fs.writeFileSync(`${deployLog}.appmanager`, JSON.stringify(Object.assign(am, { present: true, app: null, daemon: 'active' })));
            fs.writeFileSync(`${deployLog}.amrecord`, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(`${deployLog}.amrecord`, 'utf8')),
                { at: '2026-10-27T10:00:00.000Z' })));
            u = new Updater(conf);
            return u.serve().then(() => u.refresh()).then(() => until(() => u.adopted.at, (at) => at === '2026-10-27T10:00:00.000Z' && !u.busy,
                30000, 'the reinstalled App Manager adopted'));
        })
        .then(() => {
            const am = comp('oap-appmanager');
            ok('appmanager: one installed again after its removal is adopted again', adopts() === 2, calls().join('; '));
            ok('appmanager: its service alone keeps a Remove', am.blocked === 'Replaced by Store' && am.installed === '2.0.3' &&
                am.uninstallable === true, JSON.stringify(am));
            return ask(conf.socket, { op: 'uninstall', id: 'oap-appmanager', secret: u.secret });
        })
        .then((err) => until(st, () => !st().busy && u.appmanager.present === false, 30000, 'the service removed').then(() => err))
        .then((err) => {
            ok('appmanager: and that Remove is the deploy tool\'s uninstall of oap-appmanager', err === null &&
                calls().filter((l) => l === 'uninstall oap-appmanager --yes').length === 2, `${err} ${calls().join('; ')}`);
            u.server.close();
            delete process.env.FAKE_UNIT_HMI;
        });
}

/* Apps idrive7-apps' own installer put on the unit (the deploy tool's status
 * idrive7): an app its repository (the default source) lists gets that
 * source as origin, with its update, once it has been read; one it does not
 * list is imported; with that source removed by the owner, each is imported
 * and the source stays removed. */
function testIdrive7(certs) {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'i7');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const state = path.join(M, 'state');
    [M, opt, oap, state, path.join(M, 'shm'), path.join(M, 'media'), path.join(M, 'empty')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog });
    delete process.env.FAKE_LEASE;
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_UNIT_HMI;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.5.0'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.5.0', 'component.json'), JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '0.5.0' }));
    fs.symlinkSync('versions/0.5.0', path.join(opt, 'mgu-deploy', 'current'));
    const installed = (id, version, uid) => {
        mkdirp(path.join(oap, 'oap_12201', 'data', 'apps'));
        mkdirp(path.join(oap, `oap_${uid}`, 'source'));
        fs.writeFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${id}.json`), JSON.stringify({ userId: uid, installationSource: 'PREINSTALLED' }));
        fs.writeFileSync(path.join(oap, `oap_${uid}`, 'source', 'package.json'), JSON.stringify({ name: id, version }));
    };
    installed('car_vitals', '2.13.0', 12450);
    installed('my_kitapp', '0.1.0', 12449);
    // an app the repository lists without uninstallable, put there by its installer
    installed('redline', '1.0.0', 12451);
    // the icon the car's app list shows: the installed package's first entry point's, under rhmiData/resources
    const png = (n, fill) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(n, fill)]);
    const carIcon = png(70, 1);
    mkdirp(path.join(oap, 'oap_12450', 'rhmiData', 'resources'));
    fs.writeFileSync(path.join(oap, 'oap_12450', 'rhmiData', 'application.json'), JSON.stringify({ application: {
        entryPoints: [{ name: 'CAR_VITALS_ENTRY', icon: 'car_vitals_icon.png' }] } }));
    fs.writeFileSync(path.join(oap, 'oap_12450', 'rhmiData', 'resources', 'car_vitals_icon.png'), carIcon);
    const repoIcon = png(80, 2);
    const gforceIcon = png(90, 3);
    const srcIcon = png(95, 4);
    // GitHub requests that read an icon (or the application.json naming a source package's)
    // a public repo read without a token: its files from raw.githubusercontent.com, none through the API
    const iconReads = (from) => seen.slice(from).filter((x) => (/^raw\.githubusercontent\.com/.test(x.host) || /\/contents\//.test(x.url)) &&
        /(icon\.png|application\.json)(\?|$)/.test(x.url)).map((x) => `${/^raw\./.test(x.host) ? 'raw' : 'api'}:${x.url.split('?')[0]}`);
    let mark = seen.length;
    fs.writeFileSync(`${deployLog}.idrive7`, JSON.stringify([{ id: 'car_vitals', version: '2.13.0' }, { id: 'my_kitapp', version: '0.1.0' },
        { id: 'redline', version: '1.0.0' }]));
    ghRepo('cauliflowermossgrape/idrive7-apps');
    gh.repos['cauliflowermossgrape/idrive7-apps'].branches.main = ghCommit('cauliflowermossgrape/idrive7-apps', {
        'mgu-repo.json': JSON.stringify({ schema: 1, components: [{ id: 'car_vitals', kind: 'app', path: 'apps/car_vitals', mguHmi: ['ID7'],
            uninstallable: true, build: { node: 'tools/build.js', args: ['car_vitals'] } },
        { id: 'gforce', kind: 'app', path: 'more/gforce', build: { node: 'tools/build.js', args: ['gforce'] } },
        { id: 'redline', kind: 'app', path: 'more/redline', build: { node: 'tools/build.js', args: ['redline'] } },
        { id: 'srcpkg', kind: 'app', path: 'pkg' }] }),
        'pkg/mgu-app.json': JSON.stringify({ schema: 1, id: 'srcpkg', version: '1.0.0', tree: 'srcpkg@1.0.0' }),
        'pkg/srcpkg@1.0.0/rhmiData/application.json': JSON.stringify({ application: { entryPoints: [{ icon: 'srcpkg_icon.png' }],
            variantGroups: [{ resourcesPath: './variantGroups/ID8/images' }, { resourcesPath: './variantGroups/Common/images' }] } }),
        'pkg/srcpkg@1.0.0/rhmiData/variantGroups/Common/images/srcpkg_icon.png': srcIcon,
        'apps/car_vitals/app.json': JSON.stringify({ id: 'car_vitals', title: 'M Vitals', version: '2.14.0' }),
        'apps/car_vitals/icon.png': repoIcon,
        'more/gforce/app.json': JSON.stringify({ id: 'gforce', title: 'G-Force', version: '1.4.1' }),
        'more/gforce/icon.png': gforceIcon,
        'more/redline/app.json': JSON.stringify({ id: 'redline', title: 'Redline', version: '1.0.0' }),
        'tools/build.js': '// not run here\n'
    });
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'file', path: path.join(M, 'empty'), builtin: true }] }));
    publish(path.join(M, 'empty'), []);
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: state, tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'),
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: '', default_sources: 'cauliflowermossgrape/idrive7-apps:branch'
    };
    fs.writeFileSync(conf.mounts, 'proc /proc proc rw 0 0\n');
    let u = new Updater(conf);
    const comp = (id) => u.state().components.find((c) => c.id === id) || {};
    return u.serve()
        .then(() => u.refresh())
        .then(() => {
            ok('idrive7: no origin before the default source is read', !u.origins.car_vitals && u.adopted.imported.length === 0, JSON.stringify(u.origins));
            return u.check();
        })
        .then(() => until(() => u.origins.car_vitals, (o) => !!o, 30000, 'car_vitals adopted'))
        .then(() => {
            ok('idrive7: an app the repository lists gets it as origin; one it does not is imported',
                u.origins.car_vitals.source === 'idrive7-apps' && !u.origins.my_kitapp &&
                JSON.stringify(JSON.parse(fs.readFileSync(path.join(state, 'appmanager.json'), 'utf8')).imported) === '["my_kitapp"]',
                JSON.stringify(u.origins));
            const cv = comp('car_vitals');
            ok('idrive7: its app shows installed from that source, with the newer version as its update', cv.source === 'idrive7-apps' &&
                cv.status === 'update' && cv.installed === '2.13.0' && cv.version === '2.14.0' && !cv.blocked, JSON.stringify(cv));
            const mine = comp('my_kitapp');
            ok('idrive7: an imported app keeps a row, installed and removable', mine.source === 'imported' && mine.status === 'installed' &&
                mine.uninstallable === true, JSON.stringify(mine));
            const rl = comp('redline');
            ok('idrive7: an installed app the repository lists without uninstallable is removable', rl.source === 'idrive7-apps' &&
                rl.installed === '1.0.0' && rl.uninstallable === true, JSON.stringify(rl));
            return ask(conf.socket, { op: 'uninstall', id: 'redline', secret: u.secret })
                .then((err) => until(() => comp('redline'), (r) => !u.busy && r.status === 'available', 30000, 'redline removed').then(() => err));
        })
        .then((err) => {
            ok('idrive7: its Remove runs the deploy tool\'s uninstall; it shows not installed', err === null &&
                /^uninstall redline --yes$/m.test(fs.readFileSync(deployLog, 'utf8')) && !comp('redline').installed, `${err} ${JSON.stringify(comp('redline'))}`);
            return until(() => u.src.get('idrive7-apps').icons, (x) => !x, 30000, 'icons fetched');
        })
        .then(() => {
            const iconOf = (id) => comp(id).icon && fs.readFileSync(comp(id).icon);
            ok('icons: an installed app shows its installed package\'s entry-point icon, kept readable by its sha256',
                comp('car_vitals').icon === path.join(state, 'icons', `${sha256(carIcon)}.png`) && iconOf('car_vitals').equals(carIcon) &&
                (fs.statSync(comp('car_vitals').icon).mode & 0o777) === 0o644, comp('car_vitals').icon);
            ok('icons: an app a repo tree lists, not installed, shows the icon.png of its folder at the listed commit',
                iconOf('gforce') && iconOf('gforce').equals(gforceIcon), comp('gforce').icon);
            ok('icons: none for a repo-tree app without icon.png, nor for an installed app without an entry-point icon',
                comp('redline').id && comp('redline').icon === null && comp('my_kitapp').icon === null,
                `${comp('redline').icon} ${comp('my_kitapp').icon}`);
            u.pruneIcons();
            ok('icons: an installed app\'s icon is kept by the clean-up', fs.existsSync(comp('car_vitals').icon) && iconOf('gforce'));
            ok('icons: a source package shows the icon its entry point names, from the variant group that has it', iconOf('srcpkg') && iconOf('srcpkg').equals(srcIcon), comp('srcpkg').icon);
            const first = iconReads(mark);
            ok('requests: a new listing reads each app\'s icon once (a source package\'s through its application.json, ' +
                'then each place it names until one is there), none for an app installed with its own',
            first.length === 5 && !first.some((u) => /car_vitals/.test(u)) && first.every((u) => /^raw:/.test(u)), first.join(' '));
            mark = seen.length;
            return u.check().then(() => until(() => u.src.get('idrive7-apps').icons, (x) => !x, 30000, 'icons fetched'));
        })
        .then(() => {
            ok('requests: a check of an unchanged source reads no icon, kept or missing', iconReads(mark).length === 0, iconReads(mark).join(' '));
            u.server.close();
            u = new Updater(conf);
            mark = seen.length;
            return u.serve().then(() => u.refresh()).then(() => u.check())
                .then(() => until(() => u.src.get('idrive7-apps').icons, (x) => !x, 30000, 'icons fetched'));
        })
        .then(() => {
            ok('requests: nor does a restarted updater: a missing icon is remembered', iconReads(mark).length === 0 && comp('gforce').icon,
                iconReads(mark).join(' '));
            // a new commit: gforce 1.4.2 with a new icon, the rest as they were
            const repo = gh.repos['cauliflowermossgrape/idrive7-apps'];
            const tree = Object.assign({}, repo.trees[repo.branches.main]);
            const files = {};
            Object.keys(tree).forEach((k) => {
                files[k] = [tree[k][0], tree[k][1]];
            });
            files['more/gforce/app.json'] = [JSON.stringify({ id: 'gforce', title: 'G-Force', version: '1.4.2' }), 0o644];
            files['more/gforce/icon.png'] = [png(99, 5), 0o644];
            repo.branches.main = ghCommit('cauliflowermossgrape/idrive7-apps', files);
            mark = seen.length;
            return u.check().then(() => until(() => u.src.get('idrive7-apps').icons, (x) => !x, 30000, 'icons fetched'));
        })
        .then(() => {
            const reads = iconReads(mark);
            ok('requests: a new commit reads only the icon of the app with a new version, once', reads.length === 1 &&
                /more\/gforce\/icon\.png$/.test(reads[0]) && fs.readFileSync(comp('gforce').icon).equals(png(99, 5)), reads.join(' '));
            u.server.close();
            u = new Updater(conf);
            return u.serve().then(() => u.refresh());
        })
        .then(() => {
            ok('idrive7: a later start keeps what was decided', u.origins.car_vitals.source === 'idrive7-apps' &&
                u.adopted.imported.join() === 'my_kitapp' && u.stored.filter((d) => d.id === 'idrive7-apps').length === 1, JSON.stringify(u.stored));
            u.server.close();
            // the owner removed the default source: a newly found app is imported, the source not added again
            installed('dyno', '1.2.4', 12448);
            fs.writeFileSync(`${deployLog}.idrive7`, JSON.stringify([{ id: 'car_vitals', version: '2.13.0' }, { id: 'my_kitapp', version: '0.1.0' },
                { id: 'dyno', version: '1.2.4' }]));
            fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'file', path: path.join(M, 'empty'), builtin: true }] }));
            u = new Updater(conf);
            return u.serve().then(() => u.refresh());
        })
        .then(() => {
            ok('idrive7: with its source removed by the owner, an app is imported and the source stays removed',
                u.adopted.imported.indexOf('dyno') >= 0 && !u.origins.dyno && !u.stored.some((d) => d.id === 'idrive7-apps') &&
                comp('dyno').source === 'imported' && comp('dyno').status === 'installed', `${JSON.stringify(u.stored)} ${JSON.stringify(comp('dyno'))}`);
            u.server.close();
        });
}

/* Icons of installed apps and of folder sources: an app installed from
 * outside the updater that two sources list, an app home with a link in
 * it, and an app that goes away. */
function testIcons() {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'icons');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const state = path.join(M, 'state');
    [M, opt, oap, state, path.join(M, 'shm'), path.join(M, 'media'), path.join(M, 'empty')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog });
    delete process.env.FAKE_LEASE;
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_UNIT_HMI;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.5.0'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.5.0', 'component.json'), JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '0.5.0' }));
    fs.symlinkSync('versions/0.5.0', path.join(opt, 'mgu-deploy', 'current'));
    const png = (n, fill) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(n, fill)]);
    const installed = (id, uid, icon) => {
        mkdirp(path.join(oap, 'oap_12201', 'data', 'apps'));
        mkdirp(path.join(oap, `oap_${uid}`, 'source'));
        fs.writeFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${id}.json`), JSON.stringify({ userId: uid }));
        fs.writeFileSync(path.join(oap, `oap_${uid}`, 'source', 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
        mkdirp(path.join(oap, `oap_${uid}`, 'rhmiData', 'resources'));
        fs.writeFileSync(path.join(oap, `oap_${uid}`, 'rhmiData', 'application.json'), JSON.stringify({ application: {
            entryPoints: [{ icon: `${id}_icon.png` }] } }));
        fs.writeFileSync(path.join(oap, `oap_${uid}`, 'rhmiData', 'resources', `${id}_icon.png`), icon);
    };
    const twinIcon = png(41, 1);
    installed('twin', 12460, twinIcon);
    // an app home whose resources folder is a link elsewhere
    installed('linked', 12461, png(42, 2));
    const elsewhere = path.join(M, 'elsewhere');
    mkdirp(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'linked_icon.png'), png(43, 3));
    fs.renameSync(path.join(oap, 'oap_12461', 'rhmiData', 'resources'), path.join(M, 'was-resources'));
    fs.symlinkSync(elsewhere, path.join(oap, 'oap_12461', 'rhmiData', 'resources'));
    // two folder sources listing twin (no title of its own: neither updates it), each with its icon
    const folder = (name, icon) => {
        const d = path.join(M, name);
        mkdirp(path.join(d, 'twin'));
        fs.writeFileSync(path.join(d, 'mgu-repo.json'), JSON.stringify({ schema: 1, components: [
            { id: 'twin', kind: 'app', path: 'twin', build: { node: 'build.js', args: [] } }] }));
        fs.writeFileSync(path.join(d, 'twin', 'app.json'), JSON.stringify({ id: 'twin', title: `Twin ${name}`, version: '1.1.0' }));
        fs.writeFileSync(path.join(d, 'twin', 'icon.png'), icon);
        fs.writeFileSync(path.join(d, 'build.js'), '// not run here\n');
        return d;
    };
    const aIcon = png(44, 4);
    const bIcon = png(45, 5);
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'file', path: path.join(M, 'empty'), builtin: true },
        { id: 'fa', type: 'file', path: folder('fa', aIcon) }, { id: 'fb', type: 'file', path: folder('fb', bIcon) }] }));
    publish(path.join(M, 'empty'), []);
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: state, tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: '',
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    fs.writeFileSync(conf.mounts, 'proc /proc proc rw 0 0\n');
    const u = new Updater(conf);
    const rows = () => u.state().components.filter((c) => c.id === 'twin' || c.installAs === 'twin' || c.listedId === 'twin');
    return u.serve()
        .then(() => u.check())
        .then(() => u.iconPass)
        .then(() => {
            const r = rows();
            const bytes = (c) => (c && c.icon ? fs.readFileSync(c.icon) : null);
            const mine = r.find((c) => c.installed);
            const others = r.filter((c) => !c.installed);
            ok('icons: of an app two sources list, the installed row shows its installed package\'s, each other row its source\'s',
                mine && bytes(mine).equals(twinIcon) && others.length >= 1 &&
                others.every((c) => bytes(c) && bytes(c).equals(c.source === 'fa' ? aIcon : bIcon)),
                JSON.stringify(r.map((c) => [c.id, c.source, !!c.installed, c.icon])));
            ok('icons: none through a link in an app\'s home', u.installedIcon('linked') === null);
            // fb can no longer be read: the icon pass after a check leaves its icons alone
            const fbRow = others.find((c) => c.source === 'fb');
            fs.unlinkSync(fbRow.icon);
            u.iconFailed = {};
            fs.renameSync(path.join(M, 'fb', 'mgu-repo.json'), path.join(M, 'fb-mgu-repo.json'));
            return u.check().then(() => u.iconPass).then(() => ({ mine, fbFile: fbRow.icon }));
        })
        .then(({ mine, fbFile }) => {
            ok('icons: the pass after a check skips a source that could not be read', u.src.get('fb').status === 'error' &&
                !fs.existsSync(fbFile), `${u.src.get('fb').status} ${fs.existsSync(fbFile)}`);
            // twin goes away: its kept icon and its entry go with the clean-up
            const file = mine && mine.icon;
            fs.unlinkSync(path.join(oap, 'oap_12201', 'data', 'apps', 'twin.json'));
            u.pruneIcons();
            ok('icons: an app no longer installed drops its icon at the clean-up', !u.appIcons.has('twin') && file && !fs.existsSync(file),
                `${Array.from(u.appIcons.keys())} ${file}`);
            u.server.close();
        });
}

/* Remove on iDrive 8: an installed app its catalog does not mark
 * uninstallable, and one whose install waits for the next start, can be
 * removed; the Store, the updater and the deploy tool never. */
function testAppRemove() {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'appremove');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const state = path.join(M, 'state');
    const cat = path.join(M, 'cat');
    [M, opt, oap, state, cat, path.join(M, 'shm'), path.join(M, 'media')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog, FAKE_UNIT_HMI: 'ID8',
        FAKE_PENDING: 'next_app=installs at the next start' });
    delete process.env.FAKE_LEASE;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    const tool = (id, version) => {
        mkdirp(path.join(opt, id, 'versions', version));
        fs.writeFileSync(path.join(opt, id, 'versions', version, 'component.json'), JSON.stringify({ id, kind: 'tool', version }));
        fs.symlinkSync(`versions/${version}`, path.join(opt, id, 'current'));
    };
    tool('mgu-deploy', '0.6.0');
    tool('mgu-updater', '0.8.0');
    const installed = (id, version, uid) => {
        mkdirp(path.join(oap, 'oap_12201', 'data', 'apps'));
        mkdirp(path.join(oap, `oap_${uid}`, 'source'));
        fs.writeFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${id}.json`), JSON.stringify({ userId: uid }));
        fs.writeFileSync(path.join(oap, `oap_${uid}`, 'source', 'package.json'), JSON.stringify({ name: id, version }));
    };
    installed('robertn_store', '0.9.0', 12470);
    installed('cat_app', '1.0.0', 12471);
    // listed without uninstallable, as the built-in catalog lists them
    publish(cat, [entry(appTgz(cat, 'robertn_store', '0.9.0'), 'app', 'Store'), entry(appTgz(cat, 'cat_app', '1.0.0'), 'app', 'Cat'),
        entry(appTgz(cat, 'next_app', '1.0.0'), 'app', 'Next'), entry(toolKit(cat, 'mgu-deploy', '0.6.0', {}), 'tool', 'Deploy tool'),
        entry(toolKit(cat, 'mgu-updater', '0.8.0', {}), 'tool', 'Updater')].map((e) => Object.assign(e, { mguHmi: ['ID7', 'ID8'] })), { schema: 2 });
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'file', path: cat, builtin: true }] }));
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: state, tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: '',
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    fs.writeFileSync(conf.mounts, 'proc /proc proc rw 0 0\n');
    const u = new Updater(conf);
    const comp = (id) => u.state().components.find((c) => c.id === id) || {};
    const remove = (id) => ask(conf.socket, { op: 'uninstall', id, secret: u.secret });
    const done = () => {
        delete process.env.FAKE_UNIT_HMI;
        delete process.env.FAKE_PENDING;
        u.server.close();
    };
    return u.serve()
        .then(() => u.refresh())
        .then(() => u.check())
        .then(() => {
            const c = comp('cat_app');
            ok('iDrive 8: an installed app its catalog does not mark uninstallable is removable', u.unit.hmi === 'ID8' &&
                c.installed === '1.0.0' && c.uninstallable === true, JSON.stringify(c));
            const n = comp('next_app');
            ok('iDrive 8: so is one whose install waits for the next start', n.nextStart === 'install' && n.uninstallable === true, JSON.stringify(n));
            ok('the Store, the updater and the deploy tool are never removable', comp('robertn_store').installed === '0.9.0' &&
                ['robertn_store', 'mgu-updater', 'mgu-deploy'].every((id) => comp(id).uninstallable === false),
                JSON.stringify(['robertn_store', 'mgu-updater', 'mgu-deploy'].map(comp)));
            return Promise.all(['robertn_store', 'mgu-updater', 'mgu-deploy'].map(remove));
        })
        .then((errs) => {
            ok('their Remove is refused', errs.every((e) => /cannot be removed/.test(e || '')) && !/^uninstall/m.test(fs.readFileSync(deployLog, 'utf8')),
                JSON.stringify(errs));
            return remove('cat_app');
        })
        .then((err) => until(() => comp('cat_app'), (r) => !u.busy && !r.queued && r.status === 'available', 30000, 'cat_app removed').then(() => err))
        .then((err) => {
            ok('iDrive 8: the app\'s Remove runs the deploy tool\'s uninstall', err === null &&
                /^uninstall cat_app --yes$/m.test(fs.readFileSync(deployLog, 'utf8')) && !comp('cat_app').installed, `${err} ${JSON.stringify(comp('cat_app'))}`);
            done();
        }, (e) => {
            done();
            throw e;
        });
}

/* Undo update: what offers it (the deploy tool keeps the version before,
 * nothing strands), the rollback op, the last start's failed check, and
 * the Store's update undone when the new Store starts but never says hello. */
function testUndo() {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'undo');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const state = path.join(M, 'state');
    const cat = path.join(M, 'cat');
    const proc = path.join(M, 'proc');
    [M, opt, oap, state, cat, proc, path.join(M, 'shm'), path.join(M, 'media')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    fs.writeFileSync(`${deployLog}.previous`, JSON.stringify({ robertn_store: '0.9.13', cat_app: '1.0.0' }));
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog,
        FAKE_LAST_VERIFY: JSON.stringify({ at: '2026-10-30T10:00:00Z', results: [{ id: 'mgu-uplink', version: '0.7.4', ok: false,
            error: 'mgu-uplink.service is not healthy', previous: '0.7.3', rolledBack: true }] }) });
    delete process.env.FAKE_LEASE;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    const tool = (id, version, kept) => {
        [version].concat(kept || []).forEach((v) => {
            mkdirp(path.join(opt, id, 'versions', v));
            fs.writeFileSync(path.join(opt, id, 'versions', v, 'component.json'), JSON.stringify({ id, kind: 'tool', version: v }));
        });
        fs.symlinkSync(`versions/${version}`, path.join(opt, id, 'current'));
    };
    tool('mgu-deploy', '0.6.8', ['0.6.7']);
    tool('mgu-updater', '0.8.7', ['0.8.6']);
    tool('mgu-render', '0.6.8', ['0.6.2']);
    tool('fx-tool', '2.0.0', ['1.0.0']);
    tool('mgu-uplink', '0.7.3');
    const installed = (id, version, uid) => {
        mkdirp(path.join(oap, 'oap_12201', 'data', 'apps'));
        mkdirp(path.join(oap, `oap_${uid}`, 'source'));
        fs.writeFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${id}.json`), JSON.stringify({ userId: uid }));
        fs.writeFileSync(path.join(oap, `oap_${uid}`, 'source', 'package.json'), JSON.stringify({ name: id, version, mguLocalOnly: true }));
    };
    installed('robertn_store', '0.9.14', 12470);
    installed('cat_app', '1.1.0', 12471);
    installed('needy_app', '1.0.0', 12472);
    publish(cat, [entry(appTgz(cat, 'robertn_store', '0.9.14'), 'app', 'Store'), entry(appTgz(cat, 'cat_app', '1.1.0'), 'app', 'Cat'),
        Object.assign(entry(appTgz(cat, 'needy_app', '1.0.0'), 'app', 'Needy'), { requires: { 'fx-tool': '2.0.0' } }),
        entry(toolKit(cat, 'mgu-deploy', '0.6.8', {}), 'tool', 'Deploy tool'), entry(toolKit(cat, 'mgu-updater', '0.8.7', {}), 'tool', 'Updater'),
        entry(toolKit(cat, 'mgu-render', '0.6.8', {}), 'tool', 'Renderer'), entry(toolKit(cat, 'fx-tool', '2.0.0', {}), 'tool', 'Fx'),
        entry(toolKit(cat, 'mgu-uplink', '0.7.4', {}), 'tool', 'Uplink')], { schema: 2 });
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'file', path: cat, builtin: true }] }));
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: state, tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: '',
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: '', proc
    };
    fs.writeFileSync(conf.mounts, 'proc /proc proc rw 0 0\n');
    const u = new Updater(conf);
    const comp = (id) => u.state().components.find((c) => c.id === id) || {};
    const undo = (id, secret) => ask(conf.socket, { op: 'rollback', id, secret });
    const idle = (what) => until(() => u, (x) => !x.busy && !x.queue.length, 30000, what);
    const trialFile = path.join(state, 'store-trial.json');
    const done = () => {
        delete process.env.FAKE_LAST_VERIFY;
        u.server.close();
    };
    return u.serve()
        .then(() => u.refresh())
        .then(() => u.check())
        .then(() => {
            ok('undo: offered for an app and a tool whose version before is kept', comp('cat_app').previous === '1.0.0' &&
                comp('mgu-render').previous === '0.6.2', JSON.stringify([comp('cat_app'), comp('mgu-render')]));
            ok('undo: never for the Store, the updater or the deploy tool, though kept',
                ['robertn_store', 'mgu-updater', 'mgu-deploy'].every((id) => comp(id).installed && comp(id).previous === null),
                JSON.stringify(['robertn_store', 'mgu-updater', 'mgu-deploy'].map(comp)));
            ok('undo: not below what an installed component requires', comp('fx-tool').installed === '2.0.0' && comp('fx-tool').previous === null,
                JSON.stringify(comp('fx-tool')));
            ok('undo: not with nothing kept', comp('mgu-uplink').installed === '0.7.3' && comp('mgu-uplink').previous === null);
            ok('the last start\'s failed check shows while the version before runs',
                comp('mgu-uplink').error === '0.7.4 did not work after the restart (mgu-uplink.service is not healthy); 0.7.3 is back',
                JSON.stringify(comp('mgu-uplink')));
            return Promise.all([undo('robertn_store', u.secret), undo('mgu-updater', u.secret), undo('fx-tool', u.secret), undo('cat_app', 'wrong')]);
        })
        .then((errs) => {
            ok('undo: refused where it is not offered, and without the secret',
                errs.slice(0, 3).every((e) => /cannot go back to an earlier version/.test(e || '')) && errs[3] === 'forbidden' &&
                !/^rollback/m.test(fs.readFileSync(deployLog, 'utf8')), JSON.stringify(errs));
            return undo('cat_app', u.secret).then((e) => idle('cat_app back').then(() => e));
        })
        .then((err) => {
            ok('undo: an app goes back through the deploy tool\'s rollback', err === null &&
                /^rollback cat_app --yes$/m.test(fs.readFileSync(deployLog, 'utf8')) && comp('cat_app').installed === '1.0.0' &&
                comp('cat_app').previous === null && !comp('cat_app').error, `${err} ${JSON.stringify(comp('cat_app'))}`);
            return undo('mgu-render', u.secret).then((e) => idle('mgu-render back').then(() => e));
        })
        .then((err) => {
            ok('undo: a tool goes back too, and then offers no undo to the newer version it keeps',
                err === null && comp('mgu-render').installed === '0.6.2' && comp('mgu-render').previous === null, `${err} ${JSON.stringify(comp('mgu-render'))}`);
            // the Store's update on trial: not started yet, nothing happens
            u.startStoreTrial('0.9.14');
            u.watchStoreTrial();
            ok('Store trial: written, and waiting while no Store process runs', fs.existsSync(trialFile) && u.storeTrial.seenAt === 0);
            u.storeHello({ op: 'hello', id: 'robertn_store', version: '0.9.13' });
            ok('Store trial: another version\'s hello does not end it', fs.existsSync(trialFile));
            u.storeHello({ op: 'hello', id: 'robertn_store', version: '0.9.14' });
            ok('Store trial: the new Store\'s hello ends it', !fs.existsSync(trialFile) && u.storeTrial === null);
            return ask(conf.socket, { op: 'install', id: 'robertn_store' }).then(() => idle('the same Store again'));
        })
        .then(() => {
            ok('Store trial: an install of the version installed starts none', !fs.existsSync(trialFile) && u.storeTrial === null &&
                /^install --artifact .*robertn_store@0\.9\.14\.tgz/m.test(fs.readFileSync(deployLog, 'utf8')));
            // started, silent: undone
            u.startStoreTrial('0.9.14');
            mkdirp(path.join(proc, '4242'));
            fs.writeFileSync(path.join(proc, '4242', 'cmdline'), `node\0${oap}/oap_12470/source/javascript/app.js\0`);
            u.watchStoreTrial();
            ok('Store trial: a Store process is seen', u.storeTrial && u.storeTrial.seenAt > 0);
            return sleep(1700);
        })
        .then(() => {
            u.watchStoreTrial();
            return idle('the Store back');
        })
        .then(() => {
            const s = comp('robertn_store');
            ok('Store trial: a Store that started and never said hello goes back to the version before, and says why',
                /^rollback robertn_store --yes$/m.test(fs.readFileSync(deployLog, 'utf8')) && s.installed === '0.9.13' &&
                s.error === '0.9.14 did not start; 0.9.13 is back' && !fs.existsSync(trialFile), JSON.stringify(s));
            // a tile that showed and does not show after the update: undone too
            fs.unlinkSync(path.join(proc, '4242', 'cmdline'));
            fs.writeFileSync(`${deployLog}.previous`, JSON.stringify({ robertn_store: '0.9.12' }));
            return u.refresh();
        })
        .then(() => {
            const reg = path.join(oap, 'oap_12201', 'data', 'apps', 'robertn_store.json');
            const flags = (on) => fs.writeFileSync(reg, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(reg, 'utf8')),
                { provisioningCache: { '-enabled': on ? 'true' : 'false', '-allowed': 'true' } })));
            flags(true);
            u.startStoreTrial('0.9.13');
            u.watchStoreTrial();
            flags(false);
            u.watchStoreTrial();
            ok('Store trial: a hidden tile is given its time', !!u.storeTrial && !u.queue.length);
            return sleep(1700);
        })
        .then(() => {
            u.watchStoreTrial();
            return idle('the Store back again');
        })
        .then(() => {
            const s = comp('robertn_store');
            ok('Store trial: a Store whose tile showed and does not show after its update goes back',
                s.installed === '0.9.12' && s.error === '0.9.13\'s tile does not show; 0.9.12 is back', JSON.stringify(s));
            done();
        }, (e) => {
            done();
            throw e;
        });
}

/* A repo whose apps build with Python, listed by a pattern (mgu-repo.json
 * "apps"), with a service tool and a preload tool: requirements, the oap-sdk
 * module, the declared output, the build proxy, the service tool's kit, and
 * the capability the preload tool needs. The Python
 * here is this Node behind a shell script: the plumbing is what is tested. */
function testPythonRepo() {
    const { Updater } = require('../js/updater');
    const sourcesLib = require('../js/sources');
    const { startProxy } = require('../js/build');
    const { isPublic } = require('../js/proxy');
    const M = path.join(T, 'py');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const repo = path.join(M, 'repo');
    const tools = path.join(M, 'tools');
    const sdkDir = path.join(M, 'sdk');
    [M, opt, oap, repo, tools, sdkDir, path.join(M, 'shm')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog, FAKE_DONOR: path.join(M, 'donor.js'),
        FAKE_SDK_MODULE: sdkDir, MGU_TEST_PROXY_OPEN: '1' });
    delete process.env.FAKE_LEASE;
    fs.writeFileSync(path.join(M, 'donor.js'), '// the SDK donor bundle\n');
    fs.writeFileSync(path.join(sdkDir, 'index.js'), '// the generated oap-sdk module\n');
    fs.writeFileSync(path.join(sdkDir, 'package.json'), '{"name":"oap-sdk","version":"9.8.7"}\n');
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    // the deploy tool that hands out the module and installs providers side by side is installed
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.4.0'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.4.0', 'component.json'), JSON.stringify({ id: 'mgu-deploy', version: '0.4.0' }));
    fs.symlinkSync('versions/0.4.0', path.join(opt, 'mgu-deploy', 'current'));
    const lease = path.join(M, 'lease.json');
    const leaseText = JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] });
    fs.writeFileSync(path.join(T, 'pub', 'py-asset.txt'), 'downloaded data\n');
    const write = (root, files) => Object.keys(files).forEach((rel) => {
        mkdirp(path.dirname(path.join(root, rel)));
        const [data, mode] = Array.isArray(files[rel]) ? files[rel] : [files[rel], 0o644];
        fs.writeFileSync(path.join(root, rel), data, { mode });
    });
    // the "build.py": an app's package from apps/<id>/app.json, the oap-sdk folder beside it, and for
    // netapp a download through the proxy the build is given (CONNECT, then TLS)
    const buildPy = [
        "const fs = require('fs'); const path = require('path'); const cp = require('child_process');",
        "const http = require('http'); const tls = require('tls'); const { URL } = require('url');",
        'const id = process.argv[2];',
        "const app = JSON.parse(fs.readFileSync(path.join('apps', id, 'app.json'), 'utf8'));",
        "const done = (fetched) => {",
        "  const dir = path.join('dist', id); fs.mkdirSync('dist', { recursive: false }); fs.mkdirSync(dir);",
        "  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: id, version: app.version, uid: process.getuid(),",
        "    sdk: fs.readFileSync('oap-sdk/index.js', 'utf8'), proxy: process.env.https_proxy || null, fetched,",
        "    path: process.env.PATH, cert: process.env.SSL_CERT_FILE }));",
        "  cp.execFileSync('tar', ['-czf', path.join('dist', `${id}@${app.version}.tgz`), '-C', dir, 'package.json']);",
        "  console.log('built ' + id);",
        '};',
        "if (id === 'fifoapp') { fs.mkdirSync('dist'); cp.execFileSync('mkfifo', [path.join('dist', `${id}@${app.version}.tgz`)]); process.exit(0); }",
        "if (id === 'zeroapp') { fs.mkdirSync('dist'); fs.symlinkSync('/dev/zero', path.join('dist', `${id}@${app.version}.tgz`)); process.exit(0); }",
        "if (id === 'bothapp') { done(null); fs.writeFileSync(path.join(process.env.MGU_OUT, `${id}@${app.version}.tgz`), 'not the declared output'); process.exit(0); }",
        "if (id !== 'netapp') { done(null); } else {",
        '  const p = new URL(process.env.https_proxy);',
        "  const auth = 'Basic ' + Buffer.from(`${p.username}:${p.password}`).toString('base64');",
        `  const req = http.request({ host: p.hostname, port: p.port, method: 'CONNECT', path: 'updates.test:${HTTPS_PORT}',`,
        "    headers: { 'Proxy-Authorization': auth } });",
        "  req.on('connect', (res, socket) => {",
        "    if (res.statusCode !== 200) { console.log('proxy said ' + res.statusCode); process.exit(4); }",
        "    const t = tls.connect({ socket, servername: 'updates.test', rejectUnauthorized: false }, () => {",
        "      t.write('GET /py-asset.txt HTTP/1.0\\r\\nHost: updates.test\\r\\n\\r\\n');",
        '    });',
        "    let body = ''; t.on('data', (d) => { body += d; }); t.on('end', () => done(body.split('\\r\\n\\r\\n')[1]));",
        '  });',
        "  req.on('error', (e) => { console.log('no proxy: ' + e.message); process.exit(5); });",
        '  req.end();',
        '}'
    ].join('\n');
    write(repo, {
        'mgu-repo.json': JSON.stringify({ schema: 1,
            apps: { path: 'apps/*', manifest: 'app.json', exclude: ['skipme'],
                build: { python: 'kit/build.py', args: ['{id}'], sdk: 'oap-sdk', output: 'dist/{id}@{version}.tgz', network: ['netapp'] } },
            tools: [
                { id: 'svc', path: 'prebuilt', version: '1.0.0', title: 'Test renderer', provides: 'renderer',
                    service: { exec: 'svc-bin', args: ['--group', '{app_gid}'], user: 'dynamic', groups: ['video', 'tm_oap_app'],
                        environment: { XDG_RUNTIME_DIR: '/run/wayland' }, runtimeDirectory: 'svc', after: ['winston.service'],
                        wantedBy: 'oapcontroller.service' } },
                { id: 'evil_svc', path: 'prebuilt', version: '1.0.0', service: { exec: 'svc-bin', args: ['x\nExecStartPre=/bin/evil'] } },
                { id: 'gate', path: 'prebuilt', version: '1.0.0', title: 'Gate', needs: ['renderer'],
                    preload: { library: 'gate.so', unit: 'hmi.service', process: 'HmiMain3D' } },
                { id: 'shell_gate', path: 'prebuilt', version: '1.0.0', preload: { library: 'g$(reboot).so', unit: 'hmi.service', process: 'HmiMain3D' } },
                { id: 'never_gate', path: 'prebuilt', version: '1.0.0',
                    preload: { library: 'gate.so', unit: 'hmi.service', process: 'HmiMain3D', checkAfterSeconds: 60, healthySeconds: 300 } },
                { id: 'title_svc', path: 'prebuilt', version: '1.0.0', title: 'T\n[Service]\nExecStartPre=/bin/evil %h',
                    service: { exec: 'svc-bin' } }
            ] }),
        'apps/a1/app.json': JSON.stringify({ id: 'a1', version: '1.2.0', title: 'App one', description: 'first' }),
        'apps/netapp/app.json': JSON.stringify({ id: 'netapp', version: '2.0.0', title: 'Downloads' }),
        'apps/skipme/app.json': JSON.stringify({ id: 'skipme', version: '1.0.0' }),
        'apps/fifoapp/app.json': JSON.stringify({ id: 'fifoapp', version: '1.0.0' }),
        'apps/zeroapp/app.json': JSON.stringify({ id: 'zeroapp', version: '1.0.0' }),
        'apps/bothapp/app.json': JSON.stringify({ id: 'bothapp', version: '1.0.0' }),
        'apps/notanapp/readme.txt': 'not an app\n',
        'kit/build.py': buildPy,
        'prebuilt/svc-bin': ['#!/bin/sh\nexec sleep 1000\n', 0o755],
        'prebuilt/gate.so': 'ELF stand-in\n'
    });
    // the Python tool, from a source of its own
    write(tools, {
        'mgu-repo.json': JSON.stringify({ schema: 1, components: [{ id: 'mgu-python', kind: 'tool', path: 'py' }] }),
        'py/component.json': JSON.stringify({ id: 'mgu-python', kind: 'tool', version: '1.0.2', optional: true,
            files: [{ path: 'bin/python3', mode: '0755' }, { path: 'ssl/cacert.pem', mode: '0644' }] }),
        'py/bin/python3': [`#!/bin/sh\nexec ${process.execPath} "$@"\n`, 0o755],
        'py/ssl/cacert.pem': 'roots\n'
    });
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [
        { id: 'pyrepo', type: 'file', path: repo }, { id: 'pytools', type: 'file', path: tools }] }));
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: path.join(M, 'state'), tool_root: opt, oap_root: oap,
        mainapp_uid: '12201', store_app: 'robertn_store', deploy: deploySh, lease, ca_file: '', github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD,
        github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store', fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID),
        build_uid: '12995', build_gid: '12995', build_timeout_s: '20', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        python: path.join(opt, 'mgu-python', 'current', 'bin', 'python3'),
        mounts: '/nonexistent', usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    // a unit with mgu-python 1.0.1, whose interpreter names a loader the unit lacks
    mkdirp(path.join(opt, 'mgu-python', 'versions', '1.0.1'));
    fs.writeFileSync(path.join(opt, 'mgu-python', 'versions', '1.0.1', 'component.json'),
        JSON.stringify({ id: 'mgu-python', kind: 'tool', version: '1.0.1' }));
    fs.symlinkSync('versions/1.0.1', path.join(opt, 'mgu-python', 'current'));
    const u = new Updater(conf);
    const st = () => u.state();
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    const src = (id) => st().sources.find((s) => s.id === id) || {};
    const entryOf = (id) => u.src.get('pyrepo').components.find((c) => c.id === id);
    const pkgOf = (id) => {
        const reg = JSON.parse(fs.readFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${id}.json`)));
        return JSON.parse(fs.readFileSync(path.join(oap, `oap_${reg.userId}`, 'source', 'package.json'), 'utf8'));
    };
    const settle = (id) => until(st, (s) => !s.busy && !s.components.some((c) => c.queued) &&
        (comp(id).status === 'installed' || !!comp(id).error), 60000, `${id} settled`);
    const deployed = () => fs.readFileSync(deployLog, 'utf8').split('\n').filter((l) => /^install/.test(l));

    ok('proxy: public IPv4 addresses only', isPublic('140.82.121.4') && !isPublic('127.0.0.1') && !isPublic('10.1.2.3') &&
        !isPublic('172.20.0.1') && !isPublic('192.168.1.1') && !isPublic('169.254.0.1') && !isPublic('100.64.0.1') &&
        !isPublic('0.0.0.0') && !isPublic('224.0.0.1') && !isPublic('::1') && !isPublic('example.com'));
    return u.serve()
        .then(() => u.check())
        .then(() => {
            const a1 = comp('a1');
            ok('pattern: every folder holding the manifest is an app, its id the folder\'s, title and version from app.json',
                a1.version === '1.2.0' && a1.title === 'App one' && a1.build === 'unit' && comp('netapp').version === '2.0.0' &&
                !st().components.some((c) => c.id === 'skipme' || c.id === 'notanapp'), JSON.stringify(st().components));
            ok('pattern: a python build with sdk requires mgu-python and the deploy tool that hands out the module',
                JSON.stringify(entryOf('a1').requires) === JSON.stringify({ 'mgu-python': '1.0.2', 'mgu-deploy': '0.3.2' }) &&
                entryOf('a1').script.python === 'kit/build.py' && entryOf('a1').script.args[0] === 'a1' &&
                entryOf('a1').script.output === 'dist/a1@1.2.0.tgz' && entryOf('a1').script.network === false &&
                entryOf('netapp').script.network === true, JSON.stringify(entryOf('a1')));
            ok('service: listed as an optional, removable tool providing its capability; a unit field with a line break is refused',
                comp('svc').kind === 'tool' && comp('svc').optional === true && comp('svc').uninstallable === true &&
                entryOf('svc').mguProvides === 'renderer' && JSON.stringify(entryOf('svc').requires) === '{"mgu-deploy":"0.4.0"}' && !comp('evil_svc').id && /evil_svc: service must be/.test(src('pyrepo').error || ''),
                JSON.stringify([comp('svc'), src('pyrepo').error]));
            const titled = sourcesLib.serviceUnit(entryOf('title_svc'));
            const gated = sourcesLib.preloadFiles(Object.assign({}, entryOf('gate'), { title: 'G\nExecStartPre=/bin/evil' }));
            ok('generated files: a title is one line without % specifiers; a library name that is not a plain file name, and a ' +
                'check that cannot see the process healthy, leave the tool out',
                titled.split('\n').filter((l) => /^(ExecStartPre|\[Service\])/.test(l)).length === 1 && titled.indexOf('%') < 0 &&
                [gated.guardSh, gated.guardUnit, gated.checkUnit, gated.dropin].every((t) => !/^ExecStartPre/m.test(t)) &&
                /shell_gate: preload must be/.test(src('pyrepo').error || '') && /never_gate: preload must be/.test(src('pyrepo').error || ''),
                JSON.stringify([titled, src('pyrepo').error]));
            const unit = sourcesLib.serviceUnit(entryOf('svc'));
            ok('service: its unit runs the program from current/ with the declared user, groups, environment and target', [
                'DynamicUser=yes', 'SupplementaryGroups=video tm_oap_app', 'Environment=XDG_RUNTIME_DIR=/run/wayland',
                'RuntimeDirectory=svc', 'After=winston.service', 'ExecStart=/var/opt/svc/current/svc-bin --group 12202',
                'Restart=always', 'WantedBy=oapcontroller.service'].every((l) => unit.split('\n').indexOf(l) >= 0), unit);
            fs.writeFileSync(lease, leaseText);
            return ask(conf.socket, { op: 'install', id: 'a1' }).then(() => settle('a1'));
        })
        .then(() => {
            const pkg = comp('a1').status === 'installed' ? pkgOf('a1') : {};
            const order = deployed();
            ok('python build: mgu-python 1.0.1 (whose loader the unit lacks) updated first, then the app built by the build uid, ' +
                'under Python, with the oap-sdk module',
                order.length === 2 && /mgu-python@1\.0\.2/.test(order[0]) && /a1@1\.2\.0/.test(order[1]) && pkg.uid === 12995 &&
                pkg.sdk === '// the generated oap-sdk module\n' && pkg.proxy === null &&
                pkg.cert === path.join(opt, 'mgu-python', 'current', 'ssl', 'cacert.pem') &&
                pkg.path.split(':')[0] === path.dirname(process.execPath), JSON.stringify([comp('a1'), order, pkg]));
            fs.unlinkSync(lease);
            return ask(conf.socket, { op: 'install', id: 'netapp' }).then(() => settle('netapp'));
        })
        .then(() => {
            ok('network build: without the uplink it fails, saying it needs internet', comp('netapp').status !== 'installed' &&
                /needs internet to build/.test(comp('netapp').error || ''), JSON.stringify(comp('netapp')));
            fs.writeFileSync(lease, leaseText);
            return ask(conf.socket, { op: 'install', id: 'netapp' }).then(() => settle('netapp'));
        })
        .then(() => {
            const pkg = comp('netapp').status === 'installed' ? pkgOf('netapp') : {};
            ok('network build: downloads through the proxy the fetch uid runs for it', comp('netapp').status === 'installed' &&
                pkg.fetched === 'downloaded data\n' && /^http:\/\/mgu:[0-9a-f]{32}@127\.0\.0\.1:\d+$/.test(pkg.proxy || '') &&
                seen.some((x) => x.url === '/py-asset.txt'), JSON.stringify([comp('netapp'), pkg]));
            const t0 = Date.now();
            return ask(conf.socket, { op: 'install', id: 'fifoapp' }).then(() => settle('fifoapp'))
                .then(() => ask(conf.socket, { op: 'install', id: 'zeroapp' })).then(() => settle('zeroapp'))
                .then(() => {
                    ok('output: a FIFO or a link (to /dev/zero) at the declared output is refused at once, nothing installed',
                        /fifoapp@1\.0\.0\.tgz: not a regular file/.test(comp('fifoapp').error || '') &&
                        /zeroapp@1\.0\.0\.tgz: not a file the build left \(ELOOP\)/.test(comp('zeroapp').error || '') &&
                        comp('fifoapp').status !== 'installed' && comp('zeroapp').status !== 'installed' && Date.now() - t0 < 30000,
                        JSON.stringify([comp('fifoapp').error, comp('zeroapp').error, Date.now() - t0]));
                    return ask(conf.socket, { op: 'install', id: 'bothapp' }).then(() => settle('bothapp'));
                });
        })
        .then(() => {
            const pkg = comp('bothapp').status === 'installed' ? pkgOf('bothapp') : {};
            ok('output: a build that also leaves its package in MGU_OUT installs the declared output',
                comp('bothapp').status === 'installed' && pkg.name === 'bothapp', JSON.stringify([comp('bothapp'), pkg]));
            return ask(conf.socket, { op: 'install', id: 'gate' });
        })
        .then((why) => {
            ok('preload: listed with what it needs; refused while no installed tool provides it, naming one that does',
                comp('gate').kind === 'tool' && JSON.stringify(entryOf('gate').mguNeeds) === '["renderer"]' &&
                entryOf('gate').requires['mgu-deploy'] === '0.3.2' && why === 'Gate needs a renderer: install Test renderer first',
                JSON.stringify([why, entryOf('gate')]));
            return ask(conf.socket, { op: 'install', id: 'svc' }).then(() => settle('svc'));
        })
        .then(() => {
            let c = {};
            try {
                c = JSON.parse(fs.readFileSync(path.join(opt, 'svc', 'current', 'component.json'), 'utf8'));
            } catch (e) { /* checked below */ }
            ok('service: installed as a tool kit: its program, unit, recmgr entry, restart, capability, kept running by updates', comp('svc').status === 'installed' &&
                c.mguProvides === 'renderer' && c.keepRunning === true && JSON.stringify(c.units) === '[{"name":"svc.service"}]' &&
                JSON.stringify(c.enable) === '[{"unit":"svc.service","target":"oapcontroller.service"}]' &&
                JSON.stringify(c.recmgr) === '["svc"]' && JSON.stringify(c.restart) === '["svc.service"]' &&
                fs.statSync(path.join(opt, 'svc', 'current', 'svc-bin')).mode & 0o100, JSON.stringify([comp('svc'), c]));
            return u.check().then(() => ask(conf.socket, { op: 'install', id: 'gate' })).then((why) => settle('gate').then(() => why));
        })
        .then((why) => {
            const dir = path.join(opt, 'gate', 'current');
            let c = {};
            try {
                c = JSON.parse(fs.readFileSync(path.join(dir, 'component.json'), 'utf8'));
            } catch (e) { /* checked below */ }
            const guard = fs.existsSync(path.join(dir, 'guard.sh')) ? fs.readFileSync(path.join(dir, 'guard.sh'), 'utf8') : '';
            const f = sourcesLib.preloadFiles(entryOf('gate'));
            ok('preload: with a renderer installed, it installs: library, guard, its two units and the drop-in, nothing started',
                why === null && comp('gate').status === 'installed' && fs.readFileSync(path.join(dir, 'gate.so'), 'utf8') === 'ELF stand-in\n' &&
                JSON.stringify(c.units) === '[{"name":"gate-guard.service"},{"name":"gate-check.service"}]' &&
                JSON.stringify(c.dropins) === '[{"unit":"hmi.service","name":"zz-gate.conf"}]' && JSON.stringify(c.restart) === '[]' &&
                JSON.stringify(c.recmgr) === '[]' && guard.indexOf('SO=$D/current/gate.so') >= 0 && /MAX=2/.test(guard) && /sleep 120/.test(guard) &&
                f.dropin.indexOf('EnvironmentFile=-/run/gate.env') >= 0 && f.dropin.indexOf('Wants=gate-guard.service gate-check.service') >= 0 &&
                f.guardUnit.indexOf('Before=hmi.service') >= 0 && f.checkUnit.indexOf('After=hmi.service') >= 0, JSON.stringify([why, comp('gate'), c]));
            const sh = cp.spawnSync('sh', ['-n', path.join(dir, 'guard.sh')], { encoding: 'utf8' });
            ok('preload: the guard script parses', sh.status === 0, sh.stderr);
            return ask(conf.socket, { op: 'uninstall', id: 'svc', secret: u.secret });
        })
        .then((why) => {
            ok('preload: the renderer it needs cannot be removed while it is installed',
                why === 'Gate needs a renderer: remove it first, or install another renderer', why);
            // with renderers side by side (the deploy tool lists each provider), one of two can go
            const reported = u.providers;
            u.providers = { renderer: [{ id: 'svc', version: '1.0.0' }, { id: 'other-renderer', version: '1.0.0' }] };
            ok('preload: with another renderer installed, the one it used can be removed', u.providerIds('renderer').length === 2 &&
                u.requestUninstall('svc') === null, JSON.stringify(u.queue));
            u.providers = reported;
            // the proxy serves the build uid alone, with its password
            const logs = [];
            return startProxy(conf, { online: true, dns: [`127.0.0.1:${DNS_PORT}`] }, (l) => logs.push(l), 'probe').then((p) => {
                const url = new URL(p.url);
                const connect = (password) => new Promise((resolve) => {
                    const headers = password === null ? {} : { 'Proxy-Authorization': `Basic ${Buffer.from(`mgu:${password}`).toString('base64')}` };
                    const req = require('http').request({ host: '127.0.0.1', port: url.port, method: 'CONNECT',
                        path: `updates.test:${HTTPS_PORT}`, headers });
                    req.on('connect', (res, socket) => {
                        socket.destroy();
                        resolve(res.statusCode);
                    });
                    req.on('response', (res) => resolve(res.statusCode));
                    req.on('error', () => resolve(0));
                    req.end();
                });
                return Promise.all([connect(url.password), connect('wrong'), connect(null)]).then((codes) => {
                    p.stop();
                    ok('proxy: a connection from another uid, a wrong password and none are all refused (407)',
                        codes.every((c) => c === 407) && logs.some((l) => /connection from uid 0/.test(l)), JSON.stringify([codes, logs]));
                });
            });
        })
        .then(() => {
            delete process.env.MGU_TEST_PROXY_OPEN;
            delete process.env.FAKE_SDK_MODULE;
            return null;
        });
}

/* Ids two origins share (README.md, "Ids"): mgu-apps' doom is installed
 * from a catalog; a repo laid out as idrive7-apps (an apps pattern, a
 * Python build taking {id}, deriving the package name and its UUIDs from
 * it, and downloading for doom) lists its own doom, which builds and
 * installs as doom2, and updates there; a package built elsewhere of that id
 * is blocked; a source package installs under another id made over to it. */
function testIdClash() {
    const { Updater } = require('../js/updater');
    const sourcesLib = require('../js/sources');
    const M = path.join(T, 'clash');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const mguApps = path.join(M, 'mgu-apps');
    const repo = path.join(M, 'idrive7-apps');
    const iterio = path.join(M, 'iterio');
    const tools = path.join(M, 'tools');
    const sdkDir = path.join(M, 'sdk');
    [M, opt, oap, mguApps, repo, iterio, tools, sdkDir, path.join(M, 'shm')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog, FAKE_DONOR: path.join(M, 'donor.js'),
        FAKE_SDK_MODULE: sdkDir });
    delete process.env.FAKE_LEASE;
    fs.writeFileSync(path.join(M, 'donor.js'), '// the SDK donor bundle\n');
    fs.writeFileSync(path.join(sdkDir, 'index.js'), '// the generated oap-sdk module\n');
    fs.writeFileSync(path.join(sdkDir, 'package.json'), '{"name":"oap-sdk","version":"9.8.7"}\n');
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.3.2'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.3.2', 'component.json'), JSON.stringify({ id: 'mgu-deploy', version: '0.3.2' }));
    fs.symlinkSync('versions/0.3.2', path.join(opt, 'mgu-deploy', 'current'));
    const lease = path.join(M, 'lease.json');
    fs.writeFileSync(lease, JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    const write = (root, files) => Object.keys(files).forEach((rel) => {
        mkdirp(path.dirname(path.join(root, rel)));
        const [data, mode] = Array.isArray(files[rel]) ? files[rel] : [files[rel], 0o644];
        fs.writeFileSync(path.join(root, rel), data, { mode });
    });
    // mgu-apps: prebuilt packages in a catalog
    const pub = (id, version) => entry(appTgz(mguApps, id, version), 'app', id.toUpperCase());
    publish(mguApps, [pub('doom', '1.1.2'), pub('stubborn', '1.0.0'), pub('shared', '1.0.0')].map((e) => Object.assign(e, { uninstallable: true })),
        { schema: 2 });
    // idrive7-apps' layout. Its build.py takes the id as argv, reads apps/<id>/app.json (whose id
    // must be that one), names the package and derives the RHMI UUIDs from it; doom downloads
    const buildPy = [
        "const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');",
        'const id = process.argv[2];',
        "const spec = JSON.parse(fs.readFileSync(path.join('apps', id, 'app.json'), 'utf8'));",
        "if ((spec.id || id) !== id) { console.log('app.json is ' + spec.id + ', not ' + id); process.exit(3); }",
        "if (spec.assets && !process.env.https_proxy) { console.log('no proxy for the assets'); process.exit(4); }",
        "const u = (what) => crypto.createHash('sha1').update(id + ':' + what).digest('hex').slice(0, 32);",
        "const name = spec.packageName || id; const dir = path.join('dist', id, 'package'); const src = path.join('dist', id);",
        "fs.mkdirSync('dist'); fs.mkdirSync(src); fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'rhmiData'));",
        "fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: spec.version, specId: spec.id,",
        "  folders: fs.readdirSync('apps').sort(), proxied: !!process.env.https_proxy }));",
        "fs.writeFileSync(path.join(dir, 'rhmiData', 'application.json'), JSON.stringify({ application: { name: id, uuid: u('app'),",
        "  entryPoints: [{ name: id.toUpperCase() + '_ENTRY', uuid: u('entry') }] } }));",
        "cp.execFileSync('tar', ['-czf', path.join('dist', `${id}@${spec.version}.tgz`), '-C', src, 'package']);",
        "console.log('built ' + name);"
    ].join('\n');
    const doomJson = (version) => JSON.stringify({ id: 'doom', title: 'Doom', version, description: 'Freedoom on the iDrive',
        assets: [{ file: 'freedoom1.wad' }] }, null, 2);
    write(repo, {
        'mgu-repo.json': JSON.stringify({ schema: 1, apps: { path: 'apps/*', manifest: 'app.json', mguHmi: ['ID7'], uninstallable: true,
            build: { python: 'kit/tools/build.py', args: ['{id}'], sdk: 'oap-sdk', output: 'dist/{id}@{version}.tgz', network: ['doom'] } },
        components: [{ id: 'shared', kind: 'app', path: 'pkgs/shared', uninstallable: true }] }),
        'apps/doom/app.json': doomJson('1.4.1'),
        'apps/doom/main.js': '// the game\n',
        'apps/warmup/app.json': JSON.stringify({ id: 'warmup', title: 'Warm-up', version: '1.0.0' }),
        'apps/stubborn/app.json': JSON.stringify({ id: 'stubborn', title: 'Stubborn', version: '2.0.0', packageName: 'stubborn' }),
        'kit/tools/build.py': buildPy,
        'pkgs/shared/mgu-app.json': JSON.stringify({ schema: 1, id: 'shared', version: '1.0.0', tree: 'shared@1.0.0', modules: ['src/main.js'],
            sdk: ['oap-sdk'] }),
        'pkgs/shared/src/main.js': "const ENTRY = '8fe6023a-c19a-498a-8f2a-818806578b4f';\n",
        'pkgs/shared/shared@1.0.0/package.json': JSON.stringify({ name: 'shared', version: '1.0.0' }),
        'pkgs/shared/shared@1.0.0/rhmiData/application.json': JSON.stringify({ application: { uuid: '3dadae8f-1b43-46d8-be8a-f1f99ad601e9',
            name: 'shared', entryPoints: [{ name: 'shared', uuid: '8FE6023A-C19A-498A-8F2A-818806578B4F' }] } })
    });
    write(tools, {
        'mgu-repo.json': JSON.stringify({ schema: 1, components: [{ id: 'mgu-python', kind: 'tool', path: 'py' }] }),
        'py/component.json': JSON.stringify({ id: 'mgu-python', kind: 'tool', version: '1.0.2', optional: true,
            files: [{ path: 'bin/python3', mode: '0755' }, { path: 'ssl/cacert.pem', mode: '0644' }] }),
        'py/bin/python3': [`#!/bin/sh\nexec ${process.execPath} "$@"\n`, 0o755],
        'py/ssl/cacert.pem': 'roots\n'
    });
    const sources = path.join(M, 'sources.json');
    // the Store's own source, read like the others
    const store = path.join(M, 'store');
    mkdirp(store);
    publish(store, []);
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'file', path: store, builtin: true },
        { id: 'mgu-apps', type: 'file', path: mguApps },
        { id: 'idrive7-apps', type: 'file', path: repo }, { id: 'iterio', type: 'file', path: iterio }, { id: 'pytools', type: 'file', path: tools }] }));
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: path.join(M, 'state'), tool_root: opt, oap_root: oap,
        mainapp_uid: '12201', store_app: 'robertn_store', deploy: deploySh, lease, ca_file: '', github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD,
        github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store', fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID),
        build_uid: '12995', build_gid: '12995', build_timeout_s: '20', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        python: path.join(opt, 'mgu-python', 'current', 'bin', 'python3'),
        mounts: '/nonexistent', usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    // idrive7-apps and the other prebuilt doom come once mgu-apps' doom is installed
    const later = { 'mgu-repo.json': fs.readFileSync(path.join(repo, 'mgu-repo.json')) };
    fs.renameSync(path.join(repo, 'mgu-repo.json'), path.join(M, 'held-mgu-repo.json'));
    const u = new Updater(conf);
    const st = () => u.state();
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    const pkgOf = (id) => {
        const reg = JSON.parse(fs.readFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${id}.json`)));
        return JSON.parse(fs.readFileSync(path.join(oap, `oap_${reg.userId}`, 'source', 'package.json'), 'utf8'));
    };
    const settle = (id) => until(st, (s) => !s.busy && !s.components.some((c) => c.queued) &&
        (comp(id).status === 'installed' || !!comp(id).error), 60000, `${id} settled`);
    const deployed = () => fs.readFileSync(deployLog, 'utf8').split('\n').filter((l) => /^(install|uninstall)/.test(l));
    const aliases = () => JSON.parse(fs.readFileSync(path.join(conf.state_dir, 'aliases.json'), 'utf8'));
    const priv = (req) => ask(conf.socket, Object.assign(req, { secret: u.secret }));

    // a source package made over to another id, alone
    const files = [
        { name: 'mgu-app.json', data: Buffer.from(JSON.stringify({ schema: 1, id: 'shared', version: '1.0.0', tree: 'shared@1.0.0',
            modules: ['src/main.js'] })), mode: 0o644 },
        { name: 'src/main.js', data: Buffer.from("const ENTRY = '8fe6023a-c19a-498a-8f2a-818806578b4f';\n"), mode: 0o644 },
        { name: 'shared@1.0.0/package.json', data: Buffer.from('{"name":"shared","version":"1.0.0"}'), mode: 0o644 },
        { name: 'shared@1.0.0/npm-shrinkwrap.json', data: Buffer.from('{"name":"shared","version":"1.0.0"}'), mode: 0o644 },
        { name: 'shared@1.0.0/config/base.json', data: Buffer.from('{"settings":{"shared":{"a":1}}}'), mode: 0o644 },
        { name: 'shared@1.0.0/rhmiData/application.json', data: Buffer.from(JSON.stringify({ application: {
            uuid: '3dadae8f-1b43-46d8-be8a-f1f99ad601e9', name: 'shared', stringBundleUuid: '3f03953a-a173-4653-94ec-e1f97cae5c76',
            entryPoints: [{ name: 'shared', uuid: '8FE6023A-C19A-498A-8F2A-818806578B4F' }] } })), mode: 0o644 }
    ];
    const made = sourcesLib.renameApp({ id: 'shared', kind: 'app', version: '1.0.0', path: 'pkgs/shared',
        artifact: { name: 'shared@1.0.0.tgz' } }, files, 'shared2');
    const at = (name) => (made.files.find((f) => f.name === name) || { data: Buffer.from('{}') }).data.toString('utf8');
    const app = JSON.parse(at('shared2@1.0.0/rhmiData/application.json')).application;
    const entryUuid = sourcesLib.uuid5('shared2:8fe6023a-c19a-498a-8f2a-818806578b4f');
    ok('rename, source package: id, tree, package and shrinkwrap names, settings key, RHMI names and every UUID, in the code too',
        made.entry.id === 'shared2' && made.entry.artifact.name === 'shared2@1.0.0.tgz' &&
        JSON.parse(at('mgu-app.json')).id === 'shared2' && JSON.parse(at('mgu-app.json')).tree === 'shared2@1.0.0' &&
        JSON.parse(at('shared2@1.0.0/package.json')).name === 'shared2' && JSON.parse(at('shared2@1.0.0/npm-shrinkwrap.json')).name === 'shared2' &&
        JSON.stringify(JSON.parse(at('shared2@1.0.0/config/base.json'))) === '{"settings":{"shared2":{"a":1}}}' &&
        app.name === 'shared2' && app.entryPoints[0].name === 'shared2' && app.entryPoints[0].uuid === entryUuid &&
        app.uuid === sourcesLib.uuid5('shared2:3dadae8f-1b43-46d8-be8a-f1f99ad601e9') && app.stringBundleUuid !== '3f03953a-a173-4653-94ec-e1f97cae5c76' &&
        at('src/main.js').indexOf(entryUuid) >= 0 && !made.files.some((f) => /^shared@/.test(f.name)),
        JSON.stringify(made.files.map((f) => [f.name, f.data.toString('utf8')])));
    ok('uuid5: the name-based UUID form, one per name', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entryUuid) &&
        entryUuid !== sourcesLib.uuid5('shared3:8fe6023a-c19a-498a-8f2a-818806578b4f'));
    return u.serve()
        .then(() => u.check())
        .then(() => Promise.all(['doom', 'stubborn', 'shared'].map((id) => ask(conf.socket, { op: 'install', id }))))
        .then(() => settle('shared'))
        .then(() => {
            ok('clash: mgu-apps\' packages install under their ids', ['doom', 'stubborn', 'shared'].every((id) => comp(id).status === 'installed') &&
                JSON.parse(fs.readFileSync(path.join(conf.state_dir, 'origins.json'), 'utf8')).doom.source === 'mgu-apps',
                JSON.stringify(st().components));
            fs.writeFileSync(path.join(repo, 'mgu-repo.json'), later['mgu-repo.json']);
            publish(iterio, [Object.assign(entry(appTgz(iterio, 'doom', '9.0.0'), 'app', 'DOOM (App Manager)'), { uninstallable: true })]);
            return u.check();
        })
        .then(() => {
            const d2 = comp('doom2');
            ok('clash: a repo\'s doom, built here, is listed as doom2 under its own title, its id as listedId',
                d2.listedId === 'doom' && d2.title === 'Doom' && d2.source === 'idrive7-apps' && d2.status === 'available' && d2.version === '1.4.1' &&
                d2.blocked === null && comp('doom').source === 'mgu-apps' && comp('doom').listedId === null && comp('doom').status === 'installed',
                JSON.stringify([d2, comp('doom')]));
            const other = comp(`doom@iterio`);
            ok('clash: a package built elsewhere keeps its id and is blocked, and does not stand for the installed doom\'s update',
                other.blocked === `doom is already installed from ${mguApps}` && other.listedId === 'doom' && other.version === '9.0.0' &&
                comp('doom').version === '1.1.2', JSON.stringify([other, comp('doom')]));
            ok('clash: ids nobody else holds are their own', comp('warmup').listedId === null && comp('warmup').source === 'idrive7-apps');
            // nothing of the id installed: each origin's row, the package that cannot be built under another id under the id itself
            const bare = new Updater(conf);
            Object.assign(bare, { src: u.src, origins: {}, aliases: {}, installedOf: () => null });
            const rows = bare.resolved();
            ok('ids: with nothing installed every origin\'s doom is listed: mgu-apps\' package as doom, the repo\'s build as doom2, ' +
                'the other package beside them, installable', rows.get('doom').source === 'mgu-apps' && rows.get('doom2').entry.listedId === 'doom' &&
                rows.get('doom2').source === 'idrive7-apps' && rows.get('doom@iterio').entry.installAs === 'doom' && rows.get('doom@iterio').entry.blocked === null,
                JSON.stringify(Array.from(rows.keys())));
            // installed from outside the updater, or imported: the origin listing it under its title updates it
            const home = (id) => path.join(oap, `oap_${JSON.parse(fs.readFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${id}.json`))).userId}`);
            const titled = (id, title) => {
                mkdirp(path.join(home(id), 'rhmiData', 'strings'));
                fs.writeFileSync(path.join(home(id), 'rhmiData', 'application.json'), JSON.stringify({ application: { entryPoints: [{ textId: 'T' }] } }));
                fs.writeFileSync(path.join(home(id), 'rhmiData', 'strings', 'en_GB.json'), JSON.stringify({ T: title }));
            };
            const view = (origins, adopted, aliases) => {
                const x = new Updater(conf);
                Object.assign(x, { src: u.src, origins, aliases: aliases || {} }, adopted ? { adopted } : {});
                return x.resolved();
            };
            titled('doom', 'DOOM');
            let got = view({});
            ok('ids: an app installed from outside is updated by the origin whose listing has its title (DOOM: mgu-apps, not Doom or ' +
                'DOOM (App Manager)); the others are beside it', got.get('doom').source === 'mgu-apps' && !got.get('doom').entry.unlisted &&
                got.get('doom2').entry.listedId === 'doom' && got.get('doom@iterio').entry.blocked === 'doom is already installed',
                JSON.stringify(Array.from(got.keys())));
            got = view({}, { at: null, imported: ['doom'] });
            ok('ids: ...an imported one too', got.get('doom').source === 'mgu-apps' && !got.get('doom').entry.blocked);
            got = view({ doom: { source: 'usb:OLD/mgu-repo/mgu-apps', commit: null } });
            ok('ids: an origin recorded as a stick\'s mgu-repo/<name> is the stored source <name>', got.get('doom').source === 'mgu-apps' &&
                !got.get('doom@mgu-apps'));
            got = view({ doom: { source: 'gone', commit: null } });
            ok('ids: ...and one whose origin is gone (a source removed) is updated by the listing with its title', got.get('doom').source === 'mgu-apps');
            titled('doom', 'Something else');
            got = view({});
            ok('ids: without a listing of its title it is a row of its own, removable, that nothing installs over; the others beside it',
                got.get('doom').entry.unlisted === true && got.get('doom').source === null && got.get('doom').entry.uninstallable === true &&
                got.get('doom@mgu-apps').entry.blocked === 'doom is already installed' && got.get('doom2').entry.listedId === 'doom',
                JSON.stringify(Array.from(got.keys())));
            // the origin that holds doom2 never updates doom, even with doom's title
            titled('doom', 'Doom');
            got = view({}, null, { 'idrive7-apps:doom': 'doom2' });
            ok('ids: an origin holding an id of its own for an app (doom2) is not the one that updates that app\'s id (doom)',
                got.get('doom2').entry.listedId === 'doom' && got.get('doom2').source === 'idrive7-apps' && got.get('doom').source !== 'idrive7-apps',
                JSON.stringify(Array.from(got.entries()).filter(([k]) => /^doom/.test(k)).map(([k, r]) => [k, r.source])));
            got = view({ doom: { source: 'gone', commit: null } }, null, { 'idrive7-apps:doom': 'doom2' });
            ok('ids: ...nor when the source that installed doom is removed', got.get('doom2').entry.listedId === 'doom' &&
                got.get('doom').source !== 'idrive7-apps');
            // of several listers the one with its title; one lister whatever its title; two of the title, or none, none
            titled('stubborn', 'Stubborn');
            got = view({});
            ok('ids: of two sources listing an id, the one whose listing has the installed title updates it',
                got.get('stubborn').source === 'idrive7-apps' && got.get('stubborn@mgu-apps').entry.blocked === 'stubborn is already installed',
                JSON.stringify(Array.from(got.keys()).filter((k) => /stubborn/.test(k))));
            titled('stubborn', 'Something else');
            got = view({});
            ok('ids: ...and with neither title it has no update: a row of its own', got.get('stubborn').entry.unlisted === true);
            titled('doom', 'DOOM');
            // a car offline: what an installer put there (no origin) updates from a stick, its folders mgu-repo/<name> and oap/
            const media = path.join(M, 'media');
            const car = path.join(media, 'CAR');
            const mountsFile = path.join(M, 'mounts');
            fs.writeFileSync(mountsFile, `/dev/sdx1 ${car} vfat ro 0 0\n`);
            mkdirp(path.join(opt, 'mgu-uplink', 'versions', '0.5.0'));
            fs.writeFileSync(path.join(opt, 'mgu-uplink', 'versions', '0.5.0', 'component.json'),
                JSON.stringify({ id: 'mgu-uplink', kind: 'tool', version: '0.5.0', title: 'Internet uplink' }));
            fs.symlinkSync('versions/0.5.0', path.join(opt, 'mgu-uplink', 'current'));
            const storeCopy = path.join(car, 'mgu-repo', 'mgu-store');
            mkdirp(storeCopy);
            publish(storeCopy, [entry(toolKit(storeCopy, 'mgu-uplink', '0.5.1', { 'mgu-uplink': ['#!/bin/sh\n', 0o755] }), 'tool', 'Internet uplink')]);
            // a checkout of idrive7-apps (usb-repo writes no catalog for it: the unit builds it), warmup newer
            const co = path.join(car, 'mgu-repo', 'idrive7-apps');
            cp.execFileSync('cp', ['-R', repo, co]);
            fs.writeFileSync(path.join(co, 'apps', 'warmup', 'app.json'), JSON.stringify({ id: 'warmup', title: 'Warm-up', version: '1.1.0' }));
            // the App Manager's oap/ folder with a newer Car Data
            const oapDir = path.join(car, 'oap');
            const pkg = (dir, file, name, version, title) => {
                const d = fs.mkdtempSync(path.join(M, 'pkg-'));
                mkdirp(path.join(d, 'rhmiData', 'variantGroups', 'Common', 'texts'));
                fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version }));
                fs.writeFileSync(path.join(d, 'rhmiData', 'application.json'), JSON.stringify({ application: { name, entryPoints: [{ textId: 'S' }],
                    variantGroups: [{ stringsPath: './variantGroups/Common/texts' }] } }));
                fs.writeFileSync(path.join(d, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), JSON.stringify({ S: title }));
                mkdirp(dir);
                cp.execFileSync('tar', ['-czf', path.join(dir, file), '-C', d, '.']);
                return path.join(dir, file);
            };
            pkg(oapDir, 'Car Data 1.1.5.tgz', 'cardata', '1.1.5', 'Car Data');
            // Car Data 1.1.4, put there by the App Manager from a stick: imported
            cp.execFileSync(deploySh, ['install', '--artifact', pkg(path.join(M, 'am'), 'cardata.tgz', 'cardata', '1.1.4', 'Car Data'), '--yes'],
                { stdio: 'ignore' });
            titled('cardata', 'Car Data');
            u.adopted = { at: null, imported: ['cardata'] };
            return ask(conf.socket, { op: 'install', id: 'warmup' }).then(() => settle('warmup')).then(() => {
                const was = { mounts: u.conf.mounts, lease: u.conf.lease };
                Object.assign(u.conf, { mounts: mountsFile, usb_roots: media });
                fs.unlinkSync(lease);
                u.scanUsb();
                return until(st, () => ['usb:CAR/mgu-repo/mgu-store', 'usb:CAR/mgu-repo/idrive7-apps', 'usb:CAR/oap']
                    .every((id) => (st().sources.find((x) => x.id === id) || {}).status === 'ok'), 20000, 'the car\'s stick read').then(() => was);
            }).then((was) => {
                const up = comp('mgu-uplink');
                ok('offline: the uplink an installer put there (no origin) is an update from a stick\'s copy of mgu-store',
                    !st().online && up.status === 'update' && up.version === '0.5.1' && up.source === 'usb:CAR/mgu-repo/mgu-store', JSON.stringify(up));
                ok('offline: what idrive7-apps installed updates from a stick holding a checkout of it',
                    comp('warmup').status === 'update' && comp('warmup').version === '1.1.0' && comp('warmup').source === 'usb:CAR/mgu-repo/idrive7-apps' &&
                    !comp('warmup2').id, JSON.stringify(comp('warmup')));
                ok('imported: Car Data from the App Manager is an update from his oap/ stick',
                    comp('cardata').status === 'update' && comp('cardata').version === '1.1.5' && comp('cardata').source === 'usb:CAR/oap',
                    JSON.stringify(comp('cardata')));
                fs.writeFileSync(deployLog, '');
                return ask(conf.socket, { op: 'install', id: 'cardata' }).then(() => until(st, () => !u.busy && (comp('cardata').installed === '1.1.5' ||
                    !!comp('cardata').error), 30000, 'cardata updated')).then(() => was);
            }).then((was) => {
                ok('imported: the update installs over it and records the stick as its origin', comp('cardata').installed === '1.1.5' &&
                    u.origins.cardata.source === 'usb:CAR/oap' && /cardata@1\.1\.5/.test(deployed().join()), JSON.stringify([comp('cardata'), deployed()]));
                // idrive7-apps removed and added again: its apps are imported, and it updates them again
                const own = u.origins.warmup;
                delete u.origins.warmup;
                u.adopted = { at: null, imported: ['warmup'] };
                const back = u.resolved();
                ok('imported: an idrive7-apps app is updated by idrive7-apps added again, no warmup2 beside it',
                    ['idrive7-apps', 'usb:CAR/mgu-repo/idrive7-apps'].indexOf(back.get('warmup').source) >= 0 && !back.get('warmup2'),
                    JSON.stringify(Array.from(back.keys()).filter((k) => /warmup/.test(k))));
                u.origins.warmup = own;
                fs.writeFileSync(mountsFile, 'proc /proc proc rw 0 0\n');
                u.scanUsb();
                Object.assign(u.conf, { mounts: was.mounts });
                fs.writeFileSync(lease, JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
                ok('a stick taken out: Car Data, installed from it, keeps a row for its Remove', comp('cardata').installed === '1.1.5' &&
                    comp('cardata').uninstallable === true && comp('cardata').source === 'usb:CAR/oap', JSON.stringify(comp('cardata')));
                // tools and apps of ours no source lists: rows for their Remove, as their own manifests allow
                const tool = (id, extra) => {
                    mkdirp(path.join(opt, id, 'versions', '1.0.0'));
                    fs.writeFileSync(path.join(opt, id, 'versions', '1.0.0', 'component.json'), JSON.stringify(Object.assign({ id, kind: 'tool', version: '1.0.0' }, extra)));
                    fs.symlinkSync('versions/1.0.0', path.join(opt, id, 'current'));
                };
                const py = path.join(opt, 'mgu-python', 'current', 'component.json');
                const pyWas = fs.readFileSync(py, 'utf8');
                fs.writeFileSync(py, JSON.stringify(Object.assign(JSON.parse(pyWas), { title: 'Python runtime' })));
                const lone = new Updater(conf);
                Object.assign(lone, { src: u.src, origins: {}, aliases: {} });
                const py1 = lone.resolved().get('mgu-python');
                ok('ids: one source listing an id updates it whatever its title', py1.source === 'pytools' && !py1.entry.unlisted, JSON.stringify(py1));
                Object.assign(lone, { origins: { 'mgu-python': { source: 'gone', commit: null } } });
                const py2 = lone.resolved().get('mgu-python');
                ok('ids: ...unless its own origin is gone: then only a listing with its title updates it', py2.entry.unlisted === true,
                    JSON.stringify(py2));
                fs.writeFileSync(py, pyWas);
                tool('plain-tool', { title: 'Plain', uninstallable: true });
                tool('bare-tool', { mguProvides: 'widget' });
                tool('kept-tool', { uninstallable: false, requires: { 'plain-tool': '1.0.0' } });
                cp.execFileSync(deploySh, ['install', '--artifact', appTgz(M, 'loose_one', '1.0.0'), '--yes'], { stdio: 'ignore' });
                return u.refresh().then(() => {
                    ok('unlisted: a tool and an app of ours no source lists have rows; a tool removable as its component.json says, with its ' +
                        'requirements; the updater, the deploy tool and Python never removable', comp('plain-tool').uninstallable === true &&
                        comp('bare-tool').uninstallable === false && u.resolved().get('bare-tool').entry.mguProvides === 'widget' &&
                        comp('plain-tool').title === 'Plain' && comp('kept-tool').uninstallable === false && comp('loose_one').uninstallable === true &&
                        comp('loose_one').installed === '1.0.0' && comp('mgu-deploy').installed === '0.3.2' && comp('mgu-deploy').uninstallable === false &&
                        u.requestUninstall('plain-tool') === 'kept-tool needs plain-tool',
                        JSON.stringify(['plain-tool', 'bare-tool', 'kept-tool', 'loose_one', 'mgu-deploy'].map(comp)));
                    return ask(conf.socket, { op: 'install', id: 'doom@iterio' });
                });
            });
        })
        .then((why) => {
            ok('clash: installing the blocked package is refused with its reason', why === `doom is already installed from ${mguApps}`, why);
            fs.writeFileSync(deployLog, '');
            return ask(conf.socket, { op: 'install', id: 'doom2' }).then(() => settle('doom2'));
        })
        .then(() => {
            const pkg = comp('doom2').status === 'installed' ? pkgOf('doom2') : {};
            ok('clash: doom2 is built from a copy of apps/doom made over to doom2 (with its download), and installed as doom2',
                pkg.name === 'doom2' && pkg.specId === 'doom2' && pkg.version === '1.4.1' && pkg.proxied === true &&
                JSON.stringify(pkg.folders) === '["doom","doom2","stubborn","warmup"]' &&
                comp('mgu-python').installed === '1.0.2' && /doom2@1\.4\.1\.tgz --yes/.test(deployed().pop()),
                JSON.stringify([comp('doom2'), pkg, deployed()]));
            const reg = (id) => JSON.parse(fs.readFileSync(path.join(oap, 'oap_12201', 'data', 'apps', `${id}.json`))).userId;
            ok('clash: mgu-apps\' doom is untouched, beside it', pkgOf('doom').version === '1.1.2' && reg('doom') !== reg('doom2') &&
                comp('doom').status === 'installed');
            ok('clash: the id it installed under is kept for its source, and the source as its origin',
                aliases()['idrive7-apps:doom'] === 'doom2' && JSON.parse(fs.readFileSync(path.join(conf.state_dir, 'origins.json'), 'utf8')).doom2.source === 'idrive7-apps',
                JSON.stringify(aliases()));
            const again = new Updater(conf);
            again.src = u.src;
            ok('clash: a later start places it there again', again.resolved().get('doom2').entry.listedId === 'doom' && !again.resolved().get('doom3'));
            fs.writeFileSync(path.join(repo, 'apps', 'doom', 'app.json'), doomJson('1.4.2'));
            return u.check();
        })
        .then(() => {
            ok('clash: a new version of the repo\'s doom is an update of doom2', comp('doom2').status === 'update' && comp('doom2').version === '1.4.2' &&
                !comp('doom3').id, JSON.stringify(comp('doom2')));
            fs.writeFileSync(deployLog, '');
            return ask(conf.socket, { op: 'install', id: 'doom2' }).then(() => until(st, () => !u.busy && comp('doom2').installed === '1.4.2' || !!comp('doom2').error,
                60000, 'doom2 updated'));
        })
        .then(() => {
            ok('clash: the update lands on doom2', /doom2@1\.4\.2\.tgz --yes/.test(deployed()[0]) && deployed().length === 1 && pkgOf('doom2').version === '1.4.2' &&
                pkgOf('doom').version === '1.1.2', JSON.stringify([deployed(), comp('doom2')]));
            return ask(conf.socket, { op: 'install', id: 'stubborn2' }).then(() => settle('stubborn2'));
        })
        .then(() => {
            ok('clash: a build that comes out under the id it was not to have is refused, nothing installed',
                /the build of stubborn as stubborn2 made stubborn: it cannot install beside stubborn/.test(comp('stubborn2').error || '') &&
                !deployed().some((l) => /stubborn/.test(l)) && pkgOf('stubborn').version === '1.0.0', JSON.stringify(comp('stubborn2')));
            return ask(conf.socket, { op: 'install', id: 'shared2' }).then(() => settle('shared2'));
        })
        .then(() => {
            ok('clash: a source package installs as shared2 beside shared', comp('shared2').listedId === 'shared' &&
                comp('shared2').status === 'installed' && pkgOf('shared2').built === true && pkgOf('shared').version === '1.0.0' &&
                deployed().some((l) => /shared2@1\.0\.0\.tgz --yes/.test(l)), JSON.stringify([comp('shared2'), deployed()]));
            u.origins.doom.source = 'iterio';
            ok('clash: the origin of an installed id updates it as usual; another origin\'s package is the one blocked',
                comp('doom').source === 'iterio' && comp('doom').status === 'update' && comp('doom').version === '9.0.0' &&
                comp('doom@mgu-apps').blocked === `doom is already installed from ${iterio}` && comp('doom2').listedId === 'doom',
                JSON.stringify(st().components.map((c) => [c.id, c.source, c.blocked])));
            // a stick that installed doom is gone: the listing with its title (DOOM: mgu-apps) updates it, the others beside it
            u.origins.doom.source = 'usb:GONE';
            const held = comp('doom');
            ok('clash: an installed app whose origin lists it no more is updated by the listing with its title, the others beside it',
                held.installed === '1.1.2' && held.status === 'installed' && held.source === 'mgu-apps' && held.blocked === null &&
                comp('doom@iterio').blocked === 'doom is already installed from usb:GONE' && comp('doom2').listedId === 'doom',
                JSON.stringify(st().components.filter((c) => /^doom/.test(c.id))));
            u.origins.doom.source = 'mgu-apps';
            const tar = require('../js/tar');
            const pj = (name) => Buffer.from(JSON.stringify({ name, version: '1.0.0' }));
            return Promise.all([
                sourcesLib.packageId(tar.tgz([{ name: 'package.json', data: pj('doom'), mode: 0o644 },
                    { name: 'package/package.json', data: pj('doom2'), mode: 0o644 }], 0), 1 << 20),
                sourcesLib.packageId(tar.tgz([{ name: 'component.json', data: pj('doom2'), mode: 0o644 },
                    { name: 'package/package.json', data: pj('doom2'), mode: 0o644 }], 0), 1 << 20)
            ]).then((ids) => {
                ok('package id: read in the deploy tool\'s order (a flat package.json first; a tool kit is no app)',
                    ids[0] === 'doom' && ids[1] === null, JSON.stringify(ids));
                return priv({ op: 'uninstall', id: 'doom2' });
            }).then(() => until(st, () => !u.busy && comp('doom2').status === 'available', 30000, 'doom2 removed'));
        })
        .then(() => {
            ok('clash: removing doom2 removes it alone, and the id kept for it',
                deployed().some((l) => /^uninstall doom2 --yes$/.test(l)) && !aliases()['idrive7-apps:doom'] && pkgOf('doom').version === '1.1.2' &&
                comp('doom2').listedId === 'doom', JSON.stringify([deployed(), aliases()]));
            u.server.close();
            delete process.env.FAKE_SDK_MODULE;
            return null;
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
    // a sources.json that cannot be read gets no default source
    u = new Updater(Object.assign(conf(), { default_sources: 'cauliflowermossgrape/idrive7-apps:branch' }));
    ok('default sources: none added while sources.json cannot be read', u.stored.length === 1 &&
        fs.readFileSync(path.join(D, 'sources.json'), 'utf8') === newer && !fs.existsSync(path.join(D, 'state', 'default-sources.json')));
    testDefaultSources();
    testConversion();
    return Promise.resolve();
}

/* Default sources: added once to a unit's sources, never again once removed,
 * not doubled where the repo is a source already. */
function testDefaultSources() {
    const { Updater } = require('../js/updater');
    const D = path.join(T, 'defaults');
    mkdirp(D);
    const file = path.join(D, 'sources.json');
    const conf = () => ({ state_dir: path.join(D, 'state'), sources: file, credentials_dir: path.join(D, 'cred'),
        default_sources: 'cauliflowermossgrape/idrive7-apps:branch' });
    const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).sources;
    // a unit with the Store's source and one of the owner's, whose id is the repo's name
    fs.writeFileSync(file, JSON.stringify({ schema: 1, sources: [
        { id: 'mgu-store', type: 'github', repo: 'robertnisipeanu/mgu-store', builtin: true },
        { id: 'idrive7-apps', type: 'github', repo: 'someone/idrive7-apps' }] }));
    let u = new Updater(conf());
    const added = stored()[2] || {};
    ok('default sources: added at the next start, after the sources there, under a free id', stored().length === 3 &&
        added.repo === 'cauliflowermossgrape/idrive7-apps' && added.channel === 'branch' && /^s-[0-9a-f]{4}$/.test(added.id) &&
        u.src.has(added.id) && u.stored.length === 3, JSON.stringify(stored()));
    u = new Updater(conf());
    ok('default sources: added once', stored().length === 3 && u.stored.length === 3);
    ok('default sources: one is removable', u.handle({ op: 'source-remove', id: added.id, secret: u.secret }) === null &&
        stored().length === 2, JSON.stringify(stored()));
    u = new Updater(conf());
    ok('default sources: one the owner removed is not added again', stored().length === 2 && u.stored.length === 2 &&
        JSON.parse(fs.readFileSync(path.join(D, 'state', 'default-sources.json'), 'utf8')).added.join() === 'cauliflowermossgrape/idrive7-apps');
    // a unit the installers seeded with it (as deploy/sources.json): recorded, not doubled
    fs.unlinkSync(path.join(D, 'state', 'default-sources.json'));
    fs.writeFileSync(file, JSON.stringify({ schema: 1, sources: [
        { id: 'mgu-store', type: 'github', repo: 'robertnisipeanu/mgu-store', builtin: true },
        { id: 'idrive7-apps', type: 'github', repo: 'cauliflowermossgrape/idrive7-apps', channel: 'branch' }] }));
    u = new Updater(conf());
    ok('default sources: one the installers seeded is kept as it is and recorded', stored().map((s) => s.id).join() === 'mgu-store,idrive7-apps' &&
        fs.existsSync(path.join(D, 'state', 'default-sources.json')), JSON.stringify(stored()));
    // one the owner added by hand under another id, on another channel, the repo in other case: kept as it is, not doubled
    fs.unlinkSync(path.join(D, 'state', 'default-sources.json'));
    fs.writeFileSync(file, JSON.stringify({ schema: 1, sources: [
        { id: 'mgu-store', type: 'github', repo: 'robertnisipeanu/mgu-store', builtin: true },
        { id: 's-1a2b', type: 'github', repo: 'CauliflowerMossGrape/IDrive7-Apps', channel: 'releases' }] }));
    u = new Updater(conf());
    ok('default sources: one the owner added by hand is kept as it is and recorded, not doubled',
        JSON.stringify(stored()) === JSON.stringify([{ id: 'mgu-store', type: 'github', repo: 'robertnisipeanu/mgu-store', builtin: true },
            { id: 's-1a2b', type: 'github', repo: 'CauliflowerMossGrape/IDrive7-Apps', channel: 'releases' }]) && u.stored.length === 2 &&
        JSON.parse(fs.readFileSync(path.join(D, 'state', 'default-sources.json'), 'utf8')).added.join() === 'cauliflowermossgrape/idrive7-apps',
        JSON.stringify(stored()));
    // no sources.json: written with the built-in source and the default one
    fs.unlinkSync(file);
    fs.unlinkSync(path.join(D, 'state', 'default-sources.json'));
    u = new Updater(conf());
    ok('default sources: without sources.json, written with the built-in source first', stored().map((s) => `${s.id}:${s.repo}`).join() ===
        'mgu-store:robertnisipeanu/mgu-store,idrive7-apps:cauliflowermossgrape/idrive7-apps', JSON.stringify(stored()));
}

/* A default source of a repo whose catalog release is read through the API,
 * while the repo is private: it needs a token, the other sources are read;
 * once the repo is public it is read without one, and a tool of its catalog
 * installs with the library tool the same catalog lists. */
function testDefaultPrivate(certs) {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'defpriv');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const store = path.join(M, 'store');
    [M, opt, oap, store, path.join(M, 'shm'), path.join(M, 'media')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog });
    delete process.env.FAKE_LEASE;
    delete process.env.FAKE_PENDING;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.7.0'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.7.0', 'component.json'), JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '0.7.0' }));
    fs.symlinkSync('versions/0.7.0', path.join(opt, 'mgu-deploy', 'current'));
    publish(store, [], { schema: 2 });
    // the repo's catalog release: each artifact a release asset the catalog names by its API URL
    const repo = 'owner/apps-repo';
    const kit = (id, version, extra) => toolKit(M, id, version, { [`${id}.sh`]: ['#!/bin/sh\n', 0o755] }, extra);
    const libExtra = { title: 'Library tool', requires: { 'mgu-deploy': '0.4.0' }, uninstallable: true };
    const toolExtra = { title: 'Hooked tool', requires: { 'mgu-deploy': '0.7.0', 'lib-tool': '0.1.0' }, uninstallable: true };
    const files = [[kit('lib-tool', '0.1.0', libExtra), libExtra], [kit('hooked-tool', '0.5.0', toolExtra), toolExtra]];
    ghRepo('owner/other-repo', { catalog: Buffer.from(JSON.stringify({ schema: 2, commit: 'test', components: [] })) });
    ghRepo(repo, { private: true, tokens: ['tok-all'] });
    gh.repos[repo].releases = [{ assets: files.map(([file]) => ({ name: path.basename(file), data: fs.readFileSync(file) })) }];
    gh.repos[repo].catalog = Buffer.from(JSON.stringify({ schema: 2, commit: 'test', components: files.map(([file, extra]) => {
        const data = fs.readFileSync(file);
        return Object.assign(entry(file, 'tool', extra.title), extra,
            { artifact: { name: path.basename(file), size: data.length, sha256: sha256(data), url: `${API}/repos/${repo}/releases/assets/${path.basename(file)}` } });
    }) }));
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'file', path: store, builtin: true }] }));
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: path.join(M, 'state'), tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'),
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: '', default_sources: 'owner/other-repo:releases owner/apps-repo:releases'
    };
    fs.writeFileSync(conf.mounts, '');
    const u = new Updater(conf);
    const st = () => u.state();
    const src = (id) => st().sources.find((s) => s.id === id) || {};
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    return u.serve()
        .then(() => u.check())
        .then(() => {
            ok('default sources: added under their repos\' names, read from their releases', JSON.stringify(u.stored.map((s) => [s.id, s.repo || null, s.channel || null])) ===
                '[["mgu-store",null,null],["other-repo","owner/other-repo","releases"],["apps-repo","owner/apps-repo","releases"]]', JSON.stringify(u.stored));
            ok('default sources: one of a repo still private needs a token; the others are read', src('apps-repo').status === 'auth-needed' &&
                src('other-repo').status === 'ok' && src('mgu-store').status === 'ok' && !comp('lib-tool').id && !comp('hooked-tool').id,
                JSON.stringify(st().sources));
            gh.repos[repo].private = false;
            return u.check();
        })
        .then(() => {
            ok('default sources: once the repo is public it is read without a token', src('apps-repo').status === 'ok' && src('apps-repo').auth === null &&
                comp('hooked-tool').source === 'apps-repo' && comp('hooked-tool').status === 'available', JSON.stringify([src('apps-repo'), comp('hooked-tool')]));
            return ask(conf.socket, { op: 'install', id: 'hooked-tool' });
        })
        .then((err) => until(st, () => !st().busy && !st().components.some((c) => c.queued) && comp('hooked-tool').status === 'installed',
            60000, 'the tool installed').then(() => err))
        .then((err) => {
            const order = fs.readFileSync(deployLog, 'utf8').split('\n').filter((l) => /^install/.test(l))
                .map((l) => (/([a-z_-]+@\d+\.\d+\.\d+)\.tgz/.exec(l) || [])[1]);
            ok('default sources: a tool of its catalog installs with the library tool the same catalog lists', err === null &&
                JSON.stringify(order) === '["lib-tool@0.1.0","hooked-tool@0.5.0"]' && u.origins['lib-tool'].source === 'apps-repo' &&
                u.origins['hooked-tool'].source === 'apps-repo', `${err} ${JSON.stringify(order)}`);
            u.server.close();
        });
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

/* GitHub requests: a stored token reads public repos too (anonymous reads
 * share 60 an hour per address), none only where the token is refused;
 * each layout's check costs as few requests as it can, unchanged answers
 * are 304s, and a listing is read again only when what it is made of
 * changed, also across a restart. */
function testRequests(certs) {
    const { Updater } = require('../js/updater');
    const M = path.join(T, 'req');
    const pub = path.join(M, 'pub');
    [M, pub, path.join(M, 'state')].forEach(mkdirp);
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    const catalogOf = (repo, version) => {
        const file = appTgz(pub, 'req_cat', version);
        gh.repos[repo].files = { [path.basename(file)]: fs.readFileSync(file) };
        const e = entry(file, 'app', 'Req');
        e.artifact.url = `${API}/repos/${repo}/releases/assets/${encodeURIComponent(path.basename(file))}`;
        gh.repos[repo].catalog = Buffer.from(JSON.stringify({ schema: 1, components: [e] }));
    };
    ghRepo('req/cat');
    catalogOf('req/cat', '1.0.0');
    ghRepo('req/rel', { releases: [{ assets: [{ name: 'req_rel@1.0.0.tgz', data: fs.readFileSync(appTgz(pub, 'req_rel', '1.0.0')) },
        { name: 'mgu-store.json', data: Buffer.from(JSON.stringify({ apps: { req_rel: { title: 'Rel' } } })) }] }] });
    const tree = (version) => ({
        'mgu-repo.json': JSON.stringify({ schema: 1, components: ['a', 'b', 'c'].map((x) => ({ id: `req_${x}`, kind: 'tool', path: x })) }),
        'a/component.json': JSON.stringify({ id: 'req_a', kind: 'tool', version, files: [] }),
        'b/component.json': JSON.stringify({ id: 'req_b', kind: 'tool', version: '1.0.0', files: [] }),
        'c/component.json': JSON.stringify({ id: 'req_c', kind: 'tool', version: '1.0.0', files: [] })
    });
    ghRepo('req/branch');
    gh.repos['req/branch'].branches.main = ghCommit('req/branch', tree('1.0.0'));
    ghRepo('req/tags');
    gh.repos['req/tags'].tags = [{ name: 'v1.0.0', sha: ghCommit('req/tags', tree('1.0.0')) }];
    // public, but refusing the stored token (an organisation's SSO)
    ghRepo('req/sso', { forbid: ['tok-all'] });
    catalogOf('req/sso', '1.0.0');
    fs.writeFileSync(path.join(M, 'sources.json'), JSON.stringify({ schema: 1, sources: [
        { id: 'mgu-store', type: 'github', repo: 'req/cat', builtin: true },
        { id: 'rel', type: 'github', repo: 'req/rel' },
        { id: 'branch', type: 'github', repo: 'req/branch', channel: 'branch' },
        { id: 'tags', type: 'github', repo: 'req/tags', channel: 'tags' },
        { id: 'sso', type: 'github', repo: 'req/sso' }] }));
    const conf = { state_dir: path.join(M, 'state'), sources: path.join(M, 'sources.json'), credentials_dir: path.join(M, 'cred'),
        lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'), github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD,
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID) };
    let u = new Updater(conf);
    u.tokens.add('tok-all', { login: 'tester', label: 'tester' });
    const ids = ['mgu-store', 'rel', 'branch', 'tags'];
    const repoOf = { 'mgu-store': 'req/cat', rel: 'req/rel', branch: 'req/branch', tags: 'req/tags', sso: 'req/sso' };
    const rt = (id) => u.src.get(id);
    const version = (id, c) => (rt(id).components.find((x) => x.id === c) || {}).version;
    // the requests one check of a source makes: [all, file reads (assets, contents)]
    const counted = (id) => {
        const from = seen.length;
        return u.checkSource(id).then(() => {
            const mine = seen.slice(from).filter((x) => x.url.indexOf(`/repos/${repoOf[id]}`) === 0);
            return [mine.length, mine.filter((x) => /\/(releases\/assets|contents)\//.test(x.url)).length];
        });
    };
    const each = () => ids.reduce((p, id) => p.then((out) => counted(id).then((n) => Object.assign(out, { [id]: n }))), Promise.resolve({}));
    const from = seen.length;
    let first;
    return each()
        .then((n) => {
            first = n;
            ok('requests: first check, every layout read', ids.every((id) => rt(id).status === 'ok') &&
                JSON.stringify(n) === JSON.stringify({ 'mgu-store': [3, 1], rel: [4, 1], branch: [6, 4], tags: [6, 4] }), JSON.stringify(n));
            ok('token: public repos are read with the stored token', ids.every((id) => rt(id).tokenId) &&
                seen.slice(from).every((x) => !/^api\.github\.com/.test(x.host) || x.auth === 'Bearer tok-all'));
            gh.notModified = 0;
            return each();
        })
        .then((n) => {
            ok('requests: nothing changed, a check is 2 requests a source (3 for releases), all 304s, no file read',
                JSON.stringify(n) === JSON.stringify({ 'mgu-store': [2, 0], rel: [3, 0], branch: [2, 0], tags: [2, 0] }) && gh.notModified === 8 &&
                ids.every((id) => rt(id).status === 'ok') && version('branch', 'req_a') === '1.0.0' && version('mgu-store', 'req_cat') === '1.0.0',
                JSON.stringify([n, gh.notModified]));
            // changes are seen by the next check
            gh.repos['req/branch'].branches.main = ghCommit('req/branch', tree('1.1.0'));
            gh.repos['req/tags'].tags.push({ name: 'v1.1.0', sha: ghCommit('req/tags', tree('1.1.0')) });
            catalogOf('req/cat', '1.1.0');
            return each();
        })
        .then((n) => {
            ok('requests: a moved branch, a new tag, a new catalog.json are read in the same check',
                version('branch', 'req_a') === '1.1.0' && version('tags', 'req_a') === '1.1.0' && version('mgu-store', 'req_cat') === '1.1.0' &&
                n.branch[1] === 4 && n.tags[1] === 4 && n['mgu-store'][1] === 1, JSON.stringify(n));
            // a component's read fails once: that listing is not kept, the next check reads the commit again
            gh.repos['req/branch'].branches.main = ghCommit('req/branch', tree('1.2.0'));
            gh.repos['req/branch'].failOnce = 'b/component.json';
            return counted('branch');
        })
        .then(() => {
            ok('requests: a component whose read failed is left out, saying why', version('branch', 'req_a') === '1.2.0' &&
                !version('branch', 'req_b') && /req_b: .*502/.test(rt('branch').error || ''), rt('branch').error);
            return counted('branch');
        })
        .then((n) => {
            ok('requests: ...and listed by the next check, the unchanged commit read again', version('branch', 'req_b') === '1.0.0' &&
                rt('branch').error === null && n[1] === 4, JSON.stringify(n));
            // a restart: no ETags kept, the listings are
            u = new Updater(conf);
            return each();
        })
        .then((n) => {
            ok('requests: after a restart, an unchanged commit or catalog.json is not read again',
                JSON.stringify(n) === JSON.stringify({ 'mgu-store': [2, 0], rel: [3, 0], branch: [2, 0], tags: [2, 0] }) &&
                version('branch', 'req_a') === '1.2.0' && rt('branch').components.length === 3, JSON.stringify(n));
            ok('requests: a listing an earlier updater version made is read again', (() => {
                const file = path.join(M, 'state', 'sources', 'branch.json');
                const c = JSON.parse(fs.readFileSync(file, 'utf8'));
                c.memo.version = '0.0.1';
                fs.writeFileSync(file, JSON.stringify(c));
                return new Updater(conf).src.get('branch').memo === null;
            })());
            // the anonymous limit spent: the token still reads; where it is refused, no token, then the limit
            gh.anonLimited = true;
            return Promise.all([u.checkSource('mgu-store'), u.checkSource('sso')]);
        })
        .then(() => {
            ok('token: with the anonymous limit spent, a public repo reads with the token', rt('mgu-store').status === 'ok' && rt('mgu-store').tokenId);
            ok('token: refused for a public repo, no token is tried: its catalog from github.com, past the spent API limit',
                rt('sso').status === 'ok' && rt('sso').tokenId === null && !seen.some((x) => x.url.indexOf('/repos/req/sso') === 0 && x.auth === null) &&
                seen.some((x) => /^github\.com/.test(x.host) && x.url === '/req/sso/releases/download/catalog/catalog.json'), rt('sso').error);
            gh.anonLimited = false;
            return u.checkSource('sso');
        })
        .then(() => {
            ok('token: refused for a public repo, read without it', rt('sso').status === 'ok' && rt('sso').tokenId === null &&
                version('sso', 'req_cat') === '1.0.0', JSON.stringify([rt('sso').status, rt('sso').error]));
            u.tokens.remove(u.tokens.all()[0].id);
            u.tokensChanged();
            gh.anonLimited = true;
            return u.checkSource('rel');
        })
        .then(() => {
            gh.anonLimited = false;
            ok('token: none stored and the anonymous limit spent: a clear error', rt('rel').status === 'error' &&
                rt('rel').error === 'GitHub limit reached. Try later or sign in.', rt('rel').error);
            ok('token: never sent anywhere but the API host', !seen.slice(from).some((x) => x.auth && !/^api\.github\.com/.test(x.host)));
        });
}

/* The deploy tool still running after deploy_timeout_s: it and what it
 * started are stopped, and the run fails with that reason. */
function testDeployTimeout() {
    const { Updater } = require('../js/updater');
    const dir = path.join(T, 'deploy-timeout');
    mkdirp(dir);
    const pidFile = path.join(dir, 'child.pid');
    const tool = path.join(dir, 'hang.sh');
    // a child of its own that ignores nothing, then a wait that never ends
    fs.writeFileSync(tool, `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\necho 'working'\nwait\n`, { mode: 0o755 });
    const u = Object.create(Updater.prototype);
    u.conf = { deploy: tool, deploy_timeout_s: '1' };
    const t0 = Date.now();
    return u.deployTool(['install', '--artifact', 'x', '--yes']).then((code) => {
        ok('deploy timeout: a deploy tool run past deploy_timeout_s fails with that reason',
            code === 1 && u.deployError === 'the deploy tool did not finish within 1 s and was stopped' &&
            Date.now() - t0 < 15000, `${code} ${u.deployError}`);
        return stillRunning(() => [fs.readFileSync(pidFile, 'utf8').trim()]);
    }).then((left) => ok('deploy timeout: what the deploy tool started is stopped with it', !left.length, `${left}`));
}

/* The uplink's requests, relayed for the Store to a fake mgu-uplink ctl.sock
 * (one JSON line in, one out): only with the secret, only the Store's
 * fields, a password passed on exactly as typed and never logged; the
 * uplink's status.json in the state. */
function testUplink() {
    const { Updater } = require('../js/updater');
    const D = path.join(T, 'uplink');
    mkdirp(D);
    const status = path.join(D, 'status.json');
    const ctl = path.join(D, 'ctl.sock');
    const u = new Updater({ state_dir: path.join(D, 'state'), credentials_dir: path.join(D, 'cred'), uplink_status: status, uplink_ctl: ctl });
    ok('uplink: no status.json, no uplink in the state', u.state().uplink === null);
    const wifi = { enabled: true, link: 'online', ssid: 'Car "Hotspot"', ip: '172.20.10.2', signal: -45,
        networks: [{ ssid: 'Car "Hotspot"', signal: -45, secure: true, saved: true, current: true }], saved: ['Car "Hotspot"'], scanning: false, error: null };
    fs.writeFileSync(status, JSON.stringify({ device: { kind: 'wifi', name: 'Car "Hotspot"' }, state: 'online', error: null, preferred: 'wifi', wifi }));
    ok('uplink: status.json read again when it changed', u.readUplink() === true && u.readUplink() === false);
    ok('uplink: its device, preferred kind and Wi-Fi in the state', JSON.stringify(u.state().uplink) === JSON.stringify({
        device: { kind: 'wifi', name: 'Car "Hotspot"' }, state: 'online', error: null, preferred: 'wifi', wifi }), JSON.stringify(u.state().uplink));
    const got = [];
    let answer = { ok: true };
    const server = net.createServer((s) => {
        let buf = '';
        s.setEncoding('utf8');
        s.on('data', (d) => {
            buf += d;
            if (buf.indexOf('\n') >= 0) {
                got.push(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
                s.end(JSON.stringify(answer) + '\n');
            }
        });
    });
    const psk = 'p@ss "w0rd\\ {x}';
    const logged = [];
    const log = console.log;
    // one request: what the updater answered (refused at once: { error }; else the reply), what it logged meanwhile kept
    const send = (req) => new Promise((resolve) => {
        console.log = (...a) => logged.push(a.join(' '));
        const done = (r) => {
            console.log = log;
            resolve(r);
        };
        const now = u.handle(req, done);
        if (now !== undefined) {
            done(now === null ? u.state() : { error: now });
        }
    });
    return send({ op: 'wifi-connect', ssid: 'Cafe', psk, secret: u.secret })
        .then((r) => {
            ok('uplink: needs mgu-uplink 0.7.0 running (no ctl.sock)', r.type === 'error' && r.op === 'wifi-connect' && /0\.7\.0/.test(r.error), JSON.stringify(r));
            return new Promise((resolve) => server.listen(ctl, resolve));
        })
        .then(() => Promise.all(['wifi-connect', 'wifi-enable', 'wifi-scan', 'wifi-forget', 'uplink-prefer'].map((op) => send({ op, ssid: 'x', psk }))))
        .then((rs) => {
            ok('uplink: every request needs the secret', rs.every((r) => r.error === 'forbidden') && got.length === 0, JSON.stringify(rs));
            return send({ op: 'wifi-connect', ssid: 'Cafe', psk, secret: u.secret, extra: 'no' });
        })
        .then((r) => {
            ok('uplink: wifi-connect passes ssid and the password on exactly, and nothing else (no secret)',
                JSON.stringify(got) === JSON.stringify([{ op: 'wifi-connect', ssid: 'Cafe', psk }]), JSON.stringify(got));
            ok('uplink: the state answers it, without the password', r.type === 'state' && JSON.stringify(r).indexOf('w0rd') < 0);
            got.length = 0;
            return send({ op: 'wifi-connect', ssid: 'Saved one', secret: u.secret });
        })
        .then(() => send({ op: 'wifi-enable', on: false, secret: u.secret }))
        .then(() => send({ op: 'wifi-scan', secret: u.secret }))
        .then(() => send({ op: 'wifi-forget', ssid: 'Cafe', secret: u.secret }))
        .then(() => send({ op: 'uplink-prefer', kind: 'iphone', secret: u.secret }))
        .then(() => send({ op: 'uplink-prefer', kind: '', secret: u.secret }))
        .then(() => {
            ok('uplink: each request as the uplink takes it', JSON.stringify(got) === JSON.stringify([{ op: 'wifi-connect', ssid: 'Saved one' },
                { op: 'wifi-enable', on: false }, { op: 'wifi-scan' }, { op: 'wifi-forget', ssid: 'Cafe' }, { op: 'prefer', kind: 'iphone' },
                { op: 'prefer', kind: '' }]), JSON.stringify(got));
            got.length = 0;
            return Promise.all([{ op: 'wifi-connect', ssid: 'Cafe', psk: 'short' }, { op: 'wifi-connect', ssid: 'Cafe', psk: `${psk}\n` },
                { op: 'wifi-connect', ssid: 'x'.repeat(33), psk }, { op: 'wifi-connect', psk }, { op: 'wifi-enable', on: 'yes' },
                { op: 'uplink-prefer', kind: 'Wi-Fi' }, { op: 'uplink-prefer' }, { op: 'wifi-forget', ssid: '' }]
                .map((req) => send(Object.assign(req, { secret: u.secret }))));
        })
        .then((rs) => {
            ok('uplink: a request the uplink could not take is refused here', rs.every((r) => typeof r.error === 'string' && r.error.length) &&
                got.length === 0, JSON.stringify(rs));
            answer = { ok: false, error: 'Wi-Fi needs uplink = auto' };
            return send({ op: 'wifi-scan', secret: u.secret });
        })
        .then((r) => {
            ok('uplink: the uplink\'s refusal is the answer', r.type === 'error' && r.op === 'wifi-scan' && r.error === 'Wi-Fi needs uplink = auto',
                JSON.stringify(r));
            server.close();
            ok('uplink: no password in any log line', logged.some((l) => /wifi-connect "Cafe"/.test(l)) && !logged.some((l) => l.indexOf('w0rd') >= 0),
                JSON.stringify(logged));
        }, (e) => {
            console.log = log;
            server.close();
            throw e;
        });
}

/* Public GitHub repos without a token: read and installed from GitHub's web
 * hosts (github.com's release downloads and git refs,
 * raw.githubusercontent.com, codeload.github.com), no API request in a
 * check or an install; the API where those do not reach (a releases
 * layout's listing, a catalog.json that is not one, a private repo) and
 * with a token; a rate limit said plainly on every path; a download a
 * token is refused for, again without it. */
function testAnonymous(certs) {
    const { Updater } = require('../js/updater');
    const sourcesLib = require('../js/sources');
    const M = path.join(T, 'anon');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const store = path.join(M, 'store');
    [M, opt, oap, store, path.join(M, 'shm'), path.join(M, 'media')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog });
    delete process.env.FAKE_LEASE;
    delete process.env.FAKE_PENDING;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    mkdirp(path.join(opt, 'mgu-deploy', 'versions', '0.7.0'));
    fs.writeFileSync(path.join(opt, 'mgu-deploy', 'versions', '0.7.0', 'component.json'), JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '0.7.0' }));
    fs.symlinkSync('versions/0.7.0', path.join(opt, 'mgu-deploy', 'current'));
    publish(store, [], { schema: 2 });
    const png = (n, fill) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(n, fill)]);
    const icon = png(30, 7);
    const kit = (id, version) => toolKit(M, id, version, { [`${id}.sh`]: ['#!/bin/sh\n', 0o755] });
    // a catalog release and a release <id>@<version> per artifact; the catalog names each by url(repo, tag, name)
    const catalogRepo = (repo, ids, url, opts) => {
        const files = ids.map((id) => kit(id, '1.0.0'));
        ghRepo(repo, Object.assign({ files: { 'cat-icon.png': icon } }, opts || {}));
        gh.repos[repo].releases = files.map((f) => ({ tag: path.basename(f, '.tgz'), assets: [{ name: path.basename(f), data: fs.readFileSync(f) }] }));
        files.forEach((f) => {
            gh.repos[repo].files[path.basename(f)] = fs.readFileSync(f);
        });
        gh.repos[repo].catalog = Buffer.from(JSON.stringify({ schema: 2, commit: 'test', components: files.map((f) => Object.assign(entry(f, 'tool', 'T'),
            { uninstallable: true, icon: 'cat-icon.png', artifact: Object.assign(entry(f, 'tool', 'T').artifact, { url: url(repo, path.basename(f, '.tgz'), path.basename(f)) }) })) }));
    };
    const download = (repo, tag, name) => `${GH_WEB}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    const assetApi = (repo, tag, name) => `${API}/repos/${repo}/releases/assets/${encodeURIComponent(name)}`;
    catalogRepo('anon/cat', ['cat_tool'], download);
    catalogRepo('anon/apiurl', ['api_tool'], assetApi);
    catalogRepo('anon/priv', ['priv_tool'], assetApi, { private: true, tokens: ['tok-all'] });
    // a releases layout: no catalog release
    ghRepo('anon/rel', { releases: [{ tag: 'v1', assets: [{ name: 'rel_tool@1.0.0.tgz', data: fs.readFileSync(appTgz(M, 'rel_tool', '1.0.0')) }] }] });
    // a catalog.json that is not one
    ghRepo('anon/bad', { catalog: Buffer.from('not json') });
    const tree = (version) => ({
        'mgu-repo.json': JSON.stringify({ schema: 1, components: [{ id: 'tree_tool', kind: 'tool', path: 't' }] }),
        't/component.json': JSON.stringify({ id: 'tree_tool', kind: 'tool', version, files: [{ path: 'run.sh', mode: '0755' }] }),
        't/run.sh': ['#!/bin/sh\n', 0o755]
    });
    ghRepo('anon/tree', { default_branch: 'trunk' });
    gh.repos['anon/tree'].branches = { trunk: ghCommit('anon/tree', tree('1.0.0')), other: ghCommit('anon/tree', tree('0.0.1')) };
    ghRepo('anon/tagged');
    gh.repos['anon/tagged'].tags = [{ name: 'v1.1.0', sha: ghCommit('anon/tagged', tree('1.1.0')), annotated: true },
        { name: 'v1.0.0', sha: ghCommit('anon/tagged', tree('1.0.0')) }];
    const sources = path.join(M, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [{ id: 'mgu-store', type: 'file', path: store, builtin: true },
        { id: 'cat', type: 'github', repo: 'anon/cat' }, { id: 'apiurl', type: 'github', repo: 'anon/apiurl', channel: 'releases' },
        { id: 'priv', type: 'github', repo: 'anon/priv' }, { id: 'rel', type: 'github', repo: 'anon/rel' },
        { id: 'bad', type: 'github', repo: 'anon/bad' }, { id: 'tree', type: 'github', repo: 'anon/tree', channel: 'branch' },
        { id: 'tagged', type: 'github', repo: 'anon/tagged', channel: 'tags' }] }));
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: path.join(M, 'state'), tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'),
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: ''
    };
    fs.writeFileSync(conf.mounts, '');
    const u = new Updater(conf);
    const st = () => u.state();
    const src = (id) => st().sources.find((x) => x.id === id) || {};
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    const rt = (id) => u.src.get(id);
    // the API requests about a repo since mark, and the requests to GitHub's other hosts
    const apiOf = (repo, mark) => seen.slice(mark).filter((x) => /^api\.github\.com/.test(x.host) && x.url.indexOf(`/repos/${repo}`) === 0);
    const webOf = (repo, mark) => seen.slice(mark).filter((x) => !/^api\.github\.com/.test(x.host) && x.url.indexOf(`/${repo}`) >= 0);
    const logged = [];
    const log = console.log;
    const quietly = (p) => {
        console.log = (...a) => {
            logged.push(a.join(' '));
            log(...a);
        };
        return p.then((v) => {
            console.log = log;
            return v;
        }, (e) => {
            console.log = log;
            throw e;
        });
    };
    const install = (id) => ask(conf.socket, { op: 'install', id })
        .then((err) => until(st, () => !st().busy && !st().components.some((c) => c.queued), 60000, `${id} done`).then(() => err));
    let mark = seen.length;
    const anonRepos = ['anon/cat', 'anon/tree', 'anon/tagged'];
    return u.serve()
        .then(() => quietly(u.check()))
        .then(() => until(() => rt('cat').icons, (x) => !x, 30000, 'icons fetched'))
        .then(() => {
            ok('anonymous: a public catalog, a branch and tags are read without one API request', ['cat', 'tree', 'tagged'].every((id) => src(id).status === 'ok') &&
                anonRepos.every((r) => apiOf(r, mark).length === 0), JSON.stringify(anonRepos.map((r) => apiOf(r, mark).map((x) => x.url))));
            ok('anonymous: the catalog from github.com\'s release download, its icon from there too', rt('cat').public === true && rt('cat').channel === 'releases' &&
                comp('cat_tool').icon && fs.readFileSync(comp('cat_tool').icon).equals(icon) &&
                webOf('anon/cat', mark).some((x) => x.url === '/anon/cat/releases/download/catalog/catalog.json'), JSON.stringify(comp('cat_tool')));
            ok('anonymous: the branch channel follows the default branch HEAD names; files from raw.githubusercontent.com',
                rt('tree').channel === 'branch:trunk' && comp('tree_tool').version === '1.0.0' &&
                webOf('anon/tree', mark).some((x) => /^raw\./.test(x.host) && /\/t\/component\.json$/.test(x.url)), rt('tree').channel);
            ok('anonymous: tags pick the highest x.y.z tag, an annotated one at its peeled commit', rt('tagged').components[0].version === '1.1.0', JSON.stringify(rt('tagged').components.map((c) => c.version)));
            ok('anonymous: each check logs its GitHub API requests', ['cat', 'tree', 'tagged'].every((id) =>
                logged.some((l) => l.indexOf(`source ${id} `) === 0 && /; 0 GitHub API requests$/.test(l))), logged.filter((l) => /^source /.test(l)).join('\n'));
            ok('fallback: a releases layout (no catalog release) is listed through the API, its packages from github.com',
                src('rel').status === 'ok' && apiOf('anon/rel', mark).length > 0 &&
                rt('rel').components[0].artifact.url === `${GH_WEB}/anon/rel/releases/download/v1/rel_tool%401.0.0.tgz`, JSON.stringify(rt('rel').components));
            ok('fallback: a catalog.json that is no catalog is read through the API, which says why', src('bad').status === 'error' &&
                /not JSON/.test(src('bad').error) && apiOf('anon/bad', mark).some((x) => x.url === '/repos/anon/bad/releases/tags/catalog'), src('bad').error);
            ok('fallback: a private repo without a token needs one (github.com does not reach it; the API says so)', src('priv').status === 'auth-needed', src('priv').status);
            mark = seen.length;
            gh.assetNotModified = 0;
            return u.check();
        })
        .then(() => {
            ok('anonymous: an unchanged catalog.json is a 304 of its storage (the ETag past the redirect), still no API request',
                gh.assetNotModified >= 1 && anonRepos.every((r) => apiOf(r, mark).length === 0) && comp('cat_tool').version === '1.0.0',
                `${gh.assetNotModified} ${JSON.stringify(apiOf('anon/cat', mark))}`);
            mark = seen.length;
            return install('cat_tool').then((err) => install('tree_tool').then((err2) => [err, err2]));
        })
        .then((errs) => {
            ok('anonymous: installs from a github.com release download and a codeload tarball, checked, without an API request',
                errs.every((e) => e === null) && comp('cat_tool').status === 'installed' && comp('tree_tool').status === 'installed' &&
                anonRepos.every((r) => apiOf(r, mark).length === 0) && webOf('anon/tree', mark).some((x) => /^codeload\./.test(x.host) && /\/tar\.gz\//.test(x.url)),
                `${errs} ${JSON.stringify(seen.slice(mark).map((x) => `${x.host}${x.url}`))}`);
            // a catalog naming its artifacts by their API URL, with the address's API limit spent
            gh.anonLimited = true;
            return install('api_tool');
        })
        .then(() => {
            gh.anonLimited = false;
            ok('rate limit: an artifact download the API refuses for it says so', comp('api_tool').error === 'GitHub limit reached. Try later or sign in.',
                comp('api_tool').error);
            gh.webLimited = true;
            return u.checkSource('cat');
        })
        .then(() => {
            gh.webLimited = false;
            ok('rate limit: github.com\'s 429 says so too', src('cat').status === 'error' && src('cat').error === 'GitHub limit reached. Try later or sign in.',
                src('cat').error);
            // a token GitHub accepts for the repo, but whose asset downloads it refuses (a GitHub App not installed there)
            u.tokens.add('tok-all', { login: 'tester', label: 'tester' });
            Object.assign(gh.repos['anon/apiurl'], { forbidAssets: ['tok-all'], forbidOnly: ['api_tool@1.0.0.tgz'] });
            gh.repos['anon/cat'].forbidAssets = ['tok-all'];
            mark = seen.length;
            return Promise.all([u.checkSource('apiurl'), u.checkSource('priv'), u.checkSource('cat')]);
        })
        .then(() => {
            ok('token: a public repo and a private one are read with the token, through the API', rt('apiurl').tokenId && rt('priv').tokenId &&
                src('apiurl').status === 'ok' && src('priv').status === 'ok', JSON.stringify([src('apiurl'), src('priv')]));
            ok('token: a public repo that refuses the token on its catalog.json is read without it, from github.com',
                src('cat').status === 'ok' && rt('cat').tokenId === null && webOf('anon/cat', mark).some((x) => /catalog\.json$/.test(x.url)),
                JSON.stringify(src('cat')));
            mark = seen.length;
            return install('api_tool').then((err) => install('priv_tool').then((err2) => [err, err2]));
        })
        .then((errs) => {
            const asset = seen.slice(mark).filter((x) => /\/repos\/anon\/apiurl\/releases\/assets\//.test(x.url));
            ok('token: an artifact download that refuses the token is downloaded again without it', errs[0] === null &&
                comp('api_tool').status === 'installed' && asset.length === 2 && asset[0].auth === 'Bearer tok-all' && asset[1].auth === null,
                `${errs[0]} ${JSON.stringify(asset)}`);
            ok('token: a private repo is read and installed through the API with its token alone', errs[1] === null && comp('priv_tool').status === 'installed' &&
                webOf('anon/priv', mark).length === 0 && apiOf('anon/priv', mark).every((x) => x.auth === 'Bearer tok-all'), `${errs[1]}`);
            ok('token: never sent anywhere but the API host', !seen.some((x) => x.auth && !/^api\.github\.com|^updates\.test/.test(x.host)));
            let bad = null;
            try {
                sourcesLib.parseRefs(Buffer.from('<!DOCTYPE html>'));
            } catch (e) {
                bad = e.message;
            }
            ok('refs: an answer that is no git ref advertisement is refused', bad === 'not a git ref advertisement', bad);
            u.server.close();
            // a rate limit on an apps pattern's folders or a component's manifest fails the read (the source keeps its listing)
            const limited = () => Promise.reject(Object.assign(new Error('GitHub limit reached. Try later or sign in.'), { status: 403, rateLimited: true }));
            const repoJson = (doc) => (rel) => (rel === 'mgu-repo.json' ? Promise.resolve(Buffer.from(JSON.stringify(doc))) : limited());
            const pattern = { schema: 1, apps: { path: 'apps/*', build: { node: 'b.js' } } };
            const listed = { schema: 1, components: [{ id: 'x_tool', kind: 'tool', path: 'x' }] };
            return Promise.all([sourcesLib.repoCatalog(repoJson(pattern), 'a'.repeat(40), null, limited).then(() => 'listed', (e) => e.message),
                sourcesLib.repoCatalog(repoJson(listed), 'a'.repeat(40), null, limited).then(() => 'listed', (e) => e.message)]);
        })
        .then((why) => {
            ok('rate limit: a repo tree whose folders or manifests the limit refuses is not listed without them',
                why.every((w) => w === 'GitHub limit reached. Try later or sign in.'), JSON.stringify(why));
        });
}

/* The shipped default sources (updater.conf) on an iDrive 7 unit: a copy of
 * IterioDev/car-apps the owner added by hand keeps it from being added
 * again; on a unit without one it is added on its tags channel, read at the
 * newest x.y.z tag without a token (the apps pattern's folders the one API
 * request, for a new tag only), and its apps and tools for iDrive 8 only are
 * not for this unit: none is installed. */
function testCarApps(certs) {
    const { Updater, loadConf } = require('../js/updater');
    process.env.MGU_UPDATER_CONF = path.join(T, 'no-local.conf');
    const shipped = loadConf().default_sources;
    delete process.env.MGU_UPDATER_CONF;
    const M = path.join(T, 'car-apps');
    const opt = path.join(M, 'opt');
    const oap = path.join(M, 'oap');
    const store = path.join(M, 'store');
    [M, opt, oap, store, path.join(M, 'shm'), path.join(M, 'media')].forEach(mkdirp);
    const deployLog = path.join(M, 'deploy.log');
    fs.writeFileSync(deployLog, '');
    Object.assign(process.env, { TOOL_ROOT: opt, OAP_ROOT: oap, FAKE_DEPLOY_LOG: deployLog });
    delete process.env.FAKE_UNIT_HMI;
    delete process.env.FAKE_LEASE;
    delete process.env.FAKE_PENDING;
    const deploySh = path.join(M, 'mgu-deploy.sh');
    fs.writeFileSync(deploySh, DEPLOY_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(M, 'lease.json'), JSON.stringify({ interface: 'vethuplink', dns: [`127.0.0.1:${DNS_PORT}`] }));
    fs.writeFileSync(path.join(M, 'ca.pem'), certs.ca);
    publish(store, [], { schema: 2 });
    // a repo laid out as car-apps: an apps pattern of prebuilt packages and a tool, these for iDrive 8 only
    const tree = (version) => ({
        'mgu-repo.json': JSON.stringify({ schema: 1, apps: { path: 'apps/*', build: { node: 'tools/prebuilt.js', output: '{dir}/{id}@{version}.tgz' },
            mguHmi: ['ID8'], uninstallable: true }, tools: [{ id: 'iteriodev-tailscale', path: 'tools/iteriodev-tailscale' }] }),
        'apps/iteriodev_draggy/app.json': JSON.stringify({ id: 'iteriodev_draggy', version, title: 'Drag Timer' }),
        'tools/prebuilt.js': 'process.exit(0);\n',
        'tools/iteriodev-tailscale/component.json': JSON.stringify({ id: 'iteriodev-tailscale', kind: 'tool', version: '1.104.5', title: 'Tailscale',
            mguHmi: ['ID8'], optional: true, uninstallable: true, files: [] })
    });
    ghRepo('IterioDev/car-apps');
    gh.repos['IterioDev/car-apps'].branches = { main: ghCommit('IterioDev/car-apps', tree('1.0.2')) };
    gh.repos['IterioDev/car-apps'].tags = [{ name: '1.1.0', sha: ghCommit('IterioDev/car-apps', tree('1.0.0')) },
        { name: '1.1.1', sha: ghCommit('IterioDev/car-apps', tree('1.0.1')) }];
    ['cauliflowermossgrape/idrive7-apps', 'robertnisipeanu/idrive-apps'].forEach((r) => {
        if (!gh.repos[r]) {
            ghRepo(r, { catalog: Buffer.from(JSON.stringify({ schema: 2, commit: 'test', components: [] })) });
        }
    });
    const sources = path.join(M, 'sources.json');
    const conf = {
        sources, credentials_dir: path.join(M, 'cred'), state_dir: path.join(M, 'state'), tool_root: opt, oap_root: oap, mainapp_uid: '12201',
        store_app: 'robertn_store', deploy: deploySh, lease: path.join(M, 'lease.json'), ca_file: path.join(M, 'ca.pem'),
        github_api: API, github_web: GH_WEB, github_raw: RAW, github_codeload: CODELOAD, github_client_id: '', builtin_repo: 'robertnisipeanu/mgu-store',
        fetch_uid: String(FETCH_UID), fetch_gid: String(FETCH_UID), build_uid: '12995', build_gid: '12995',
        build_timeout_s: '3', build_max_bytes: String(8 << 20), repo_max_bytes: String(8 << 20),
        mounts: path.join(M, 'mounts'), usb_roots: path.join(M, 'media'), web_secret: path.join(M, 'web-secret'), web_uid: '12996', web_gid: '12202',
        socket: path.join(M, 'shm', 'updater.sock'), socket_group: 'staff', deploy_tool: 'mgu-deploy', uplink_tool: 'mgu-uplink',
        bootstrap_check_s: '6', privacy_tool: '', reboot: '', default_sources: shipped
    };
    fs.writeFileSync(conf.mounts, '');
    const builtin = { id: 'mgu-store', type: 'file', path: store, builtin: true };
    // a unit whose owner added the repo by hand, on its branch, the name in other case; and IterioDev's
    // App Manager's index adopted as an https source named car-apps
    const hand = { id: 's-c4a1', type: 'github', repo: 'iteriodev/CAR-APPS', channel: 'branch' };
    const index = { id: 'car-apps', type: 'https', url: `https://updates.test:${HTTPS_PORT}/gone-index.json` };
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [builtin, hand, index] }));
    let u = new Updater(conf);
    const kept = u.stored.filter((d) => d.type === 'github' && d.repo.toLowerCase() === 'iteriodev/car-apps');
    ok('car-apps: a default source, not doubled where the owner added it by hand', /(^| )IterioDev\/car-apps:tags( |$)/.test(shipped) &&
        kept.length === 1 && kept[0].id === 's-c4a1' && kept[0].channel === 'branch', JSON.stringify(u.stored));
    // a unit without it: added on its tags channel, beside the App Manager's index named car-apps
    fs.writeFileSync(sources, JSON.stringify({ schema: 1, sources: [builtin, index] }));
    fs.unlinkSync(path.join(M, 'state', 'default-sources.json'));
    u = new Updater(conf);
    const def = u.stored.find((d) => d.type === 'github' && d.repo === 'IterioDev/car-apps') || {};
    ok('car-apps: added on its tags channel, beside the index source named car-apps, under a free id', def.channel === 'tags' &&
        /^s-[0-9a-f]{4}$/.test(def.id) && u.stored.some((d) => d.id === 'car-apps' && d.type === 'https'), JSON.stringify(u.stored));
    const st = () => u.state();
    const comp = (id) => st().components.find((c) => c.id === id) || {};
    const apiOf = (mark) => seen.slice(mark).filter((x) => /^api\.github\.com/.test(x.host) && x.url.indexOf('/repos/IterioDev/car-apps') === 0);
    let mark = seen.length;
    let first;
    return u.serve()
        .then(() => u.check())
        .then(() => {
            first = apiOf(mark);
            const rt = u.src.get(def.id);
            ok('car-apps: read at its newest x.y.z tag without a token, its apps folder the one API request', rt.status === 'ok' &&
                comp('iteriodev_draggy').version === '1.0.1' && comp('iteriodev-tailscale').version === '1.104.5' &&
                first.length === 1 && /\/contents\/apps\?ref=/.test(first[0].url), JSON.stringify([rt.status, rt.error, first.map((x) => x.url)]));
            mark = seen.length;
            return u.check();
        })
        .then(() => {
            ok('car-apps: a check of the same tag makes no API request', apiOf(mark).length === 0, JSON.stringify(apiOf(mark).map((x) => x.url)));
            ok('car-apps: on iDrive 7 its apps and tools for iDrive 8 only are not for this head unit', st().unit && st().unit.hmi === 'ID7' &&
                comp('iteriodev_draggy').compat === 'no' && comp('iteriodev-tailscale').compat === 'no', JSON.stringify([st().unit, comp('iteriodev_draggy')]));
            return Promise.all([ask(conf.socket, { op: 'install', id: 'iteriodev_draggy' }), ask(conf.socket, { op: 'install', id: 'iteriodev-tailscale' })]);
        })
        .then((errs) => until(st, () => !st().busy, 30000, 'idle').then(() => errs))
        .then((errs) => {
            ok('car-apps: an install of one is refused, nothing installed', errs.every((e) => /is for iDrive 8; this head unit is iDrive 7/.test(e || '')) &&
                fs.readFileSync(deployLog, 'utf8').split('\n').filter((l) => /^install/.test(l)).length === 0, JSON.stringify(errs));
            u.server.close();
        });
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
        .then(() => testDeployTimeout())
        .then(() => testIndexV1Cache().catch((e) => ok('index v1 cache scenario', false, e.stack)))
        .then(() => testBuildDisk().catch((e) => ok('build folders scenario', false, e.stack)))
        .then(() => testReboot())
        .then(() => testUidsDaemon())
        .then(() => testUplink())
        .then(() => Promise.all([startDns(), startHttps(certs, pubDir)]))
        .then(([dnsSrv, httpsSrv]) => testFetch(certs, pubDir)
            .then(() => testSources(certs).catch((e) => ok('sources scenario', false, e.stack)))
            .then(() => testRequests(certs).catch((e) => ok('requests scenario', false, e.stack)))
            .then(() => testUnitServices(certs, pubDir).catch((e) => ok('unit and services scenario', false, e.stack)))
            .then(() => testIndexV2(certs, pubDir).catch((e) => ok('index v2 scenario', false, e.stack)))
            .then(() => testCrossSource(certs).catch((e) => ok('cross-source requirements scenario', false, e.stack)))
            .then(() => testAppManager(certs, pubDir).catch((e) => ok('App Manager scenario', false, e.stack)))
            .then(() => testIdrive7(certs).catch((e) => ok('idrive7-apps installer scenario', false, e.stack)))
            .then(() => testIcons().catch((e) => ok('icons scenario', false, e.stack)))
            .then(() => testAppRemove().catch((e) => ok('app remove scenario', false, e.stack)))
            .then(() => testUndo().catch((e) => ok('undo scenario', false, e.stack)))
            .then(() => testPythonRepo().catch((e) => ok('python repo scenario', false, e.stack)))
            .then(() => testIdClash().catch((e) => ok('id clash scenario', false, e.stack)))
            .then(() => testDefaultPrivate(certs).catch((e) => ok('default private source scenario', false, e.stack)))
            .then(() => testAnonymous(certs).catch((e) => ok('anonymous GitHub scenario', false, e.stack)))
            .then(() => testCarApps(certs).catch((e) => ok('car-apps default source scenario', false, e.stack)))
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
