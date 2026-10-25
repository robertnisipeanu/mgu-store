'use strict';
/**
 * Offline tests of mgu-updater on the head unit's Node 8.16.2, as root
 * (test/run.sh runs them in Docker):
 *  - catalog: parsing, rejection of malformed entries, signatures, the plan;
 *  - fetch.js: HTTPS through a given DNS server, redirects that drop the
 *    token, size limits, running as the fetch uid;
 *  - the daemon under its supervisor, against an HTTPS catalog and a stand-in
 *    deploy tool: install an app, update itself, return to the previous
 *    version when a new one crashes or never comes up, refuse a download
 *    that does not match the catalog, report a failed install, offline;
 *  - the reboot request: refused while an install runs or waits, the
 *    command run once, its failure and a unit that stays up reported.
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
        printf 'subjectAltName=DNS:updates.test,DNS:other.test\\n' > ext &&
        openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile ext -out srv.pem 2>&1`);
    return { ca: fs.readFileSync(path.join(d, 'ca.pem'), 'utf8'), key: fs.readFileSync(path.join(d, 'srv.key')), cert: fs.readFileSync(path.join(d, 'srv.pem')) };
}

/* A DNS server that answers A queries for *.test with 127.0.0.1. */
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
        const known = /\.test$/.test(labels.join('.'));
        const header = Buffer.from([q[0], q[1], 0x81, known ? 0x80 : 0x83, 0, 1, 0, known ? 1 : 0, 0, 0, 0, 0]);
        const answer = known ? Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]) : Buffer.alloc(0);
        s.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
    });
    return new Promise((r) => s.bind(DNS_PORT, '127.0.0.1', () => r(s)));
}

const seen = [];
function startHttps(certs, dir) {
    const srv = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
        seen.push({ host: req.headers.host, url: req.url, auth: req.headers.authorization || null });
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: `https://other.test:${HTTPS_PORT}/payload.bin` });
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
    return new Promise((r) => srv.listen(HTTPS_PORT, '127.0.0.1', () => r(srv)));
}

/* A flat OAP app tgz: package.json at the root. */
function appTgz(dir, id, version) {
    const src = path.join(T, 'src', `${id}@${version}`);
    mkdirp(src);
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: id, version }));
    const out = path.join(dir, `${id}@${version}.tgz`);
    sh(`tar -czf ${out} -C ${src} package.json`);
    return out;
}

/* A tool kit tgz in the deploy tool's layout: component.json + files/. */
function updaterKit(dir, version, variant) {
    const src = path.join(T, 'src', `mgu-updater@${version}`);
    const files = path.join(src, 'files');
    mkdirp(files);
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'component.json'), 'utf8'));
    c.version = version;
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

/* The daemon's catalogs are signed with this key unless a test says otherwise
 * (key null: unsigned). */
const TEST_KEY = sh('openssl ecparam -name prime256v1 -genkey -noout');
const TEST_PUB = path.join(T, 'test-key.pub.pem');
fs.writeFileSync(TEST_PUB, sh(`printf '%s' '${TEST_KEY}' | openssl ec -pubout 2>/dev/null`));

function publish(dir, entries, key = TEST_KEY) {
    let catalog = { schema: 1, commit: 'test', components: entries };
    if (key) {
        const value = crypto.createSign('SHA256').update(JSON.stringify(catalog)).sign(key).toString('base64');
        catalog = Object.assign(catalog, { signature: { alg: 'ecdsa-p256-sha256', value } });
    }
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2));
}

/* ---- catalog ------------------------------------------------------------------ */

/* The configuration the updater ships with names the public key it ships. */
function testShippedKey() {
    const { loadConf } = require('../js/updater');
    process.env.MGU_UPDATER_CONF = path.join(T, 'no-local.conf'); // the shipped defaults alone
    const conf = loadConf();
    delete process.env.MGU_UPDATER_CONF;
    const component = JSON.parse(fs.readFileSync(path.join(ROOT, 'component.json'), 'utf8'));
    const shipped = component.files.find((f) => f.path === path.basename(conf.public_key || ''));
    ok('shipped: updater.conf requires a signed catalog', conf.public_key === path.join(ROOT, 'catalog-key.pub.pem'));
    ok('shipped: component.json installs that key next to updater.conf',
        shipped && path.join(ROOT, shipped.from) === conf.public_key);
    let parses = false;
    try {
        crypto.createVerify('SHA256').update('x').verify(fs.readFileSync(conf.public_key, 'utf8'), Buffer.alloc(72));
        parses = /^-----BEGIN PUBLIC KEY-----/.test(fs.readFileSync(conf.public_key, 'utf8'));
    } catch (e) {
        parses = false;
    }
    ok('shipped: the key is a PEM public key Node 8 can verify with', parses);
}

function testCatalog() {
    const key = sh('openssl ecparam -name prime256v1 -genkey -noout');
    const pub = sh(`printf '%s' '${key}' | openssl ec -pubout 2>/dev/null`);
    const good = { schema: 1, commit: 'c', components: [
        { id: 'doom', kind: 'app', title: 'DOOM', version: '1.0.1', artifact: { name: 'doom@1.0.1.tgz', size: 3, sha256: 'a'.repeat(64) } },
        { id: 'mgu-uplink', kind: 'tool', title: 'Uplink', version: '0.2.0', artifact: { name: 'mgu-uplink@0.2.0.tgz', size: 3, sha256: 'b'.repeat(64) } }
    ] };
    ok('catalog: a well-formed catalog parses', catalogLib.parse(JSON.stringify(good)).components.length === 2);
    const bad = (mut, name) => {
        const c = JSON.parse(JSON.stringify(good));
        mut(c);
        let threw = false;
        try {
            catalogLib.parse(JSON.stringify(c));
        } catch (e) {
            threw = true;
        }
        ok(`catalog: rejects ${name}`, threw);
    };
    bad((c) => { c.schema = 2; }, 'an unknown schema');
    bad((c) => { c.components[0].version = '1.0'; }, 'a non-semver version');
    bad((c) => { c.components[0].artifact.name = '../../etc/passwd'; }, 'an artifact name that is not <id>@<version>.tgz');
    bad((c) => { c.components[0].artifact.sha256 = 'zz'; }, 'a malformed sha256');
    bad((c) => { c.components[1].id = 'doom'; }, 'a duplicate id');
    bad((c) => { c.components[0].kind = 'firmware'; }, 'an unknown kind');
    bad((c) => { c.components[0].id = '../x'; }, 'an id with a path');

    const body = JSON.parse(JSON.stringify(good));
    const signed = Object.assign(body, { signature: { alg: 'ecdsa-p256-sha256',
        value: crypto.createSign('SHA256').update(JSON.stringify(good)).sign(key).toString('base64') } });
    ok('signature: a signed catalog verifies with the key', !!catalogLib.parse(JSON.stringify(signed, null, 2), pub));
    let threw = false;
    try {
        catalogLib.parse(JSON.stringify(good), pub);
    } catch (e) {
        threw = /signature/.test(e.message);
    }
    ok('signature: an unsigned catalog is refused when a key is set', threw);
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.components[0].artifact.sha256 = 'c'.repeat(64);
    threw = false;
    try {
        catalogLib.parse(JSON.stringify(tampered), pub);
    } catch (e) {
        threw = true;
    }
    ok('signature: a changed entry breaks the signature', threw);

    const rows = catalogLib.plan(good, [{ id: 'doom', kind: 'app', version: '1.0.0' }]);
    ok('plan: an older installed version is an update', rows[0].status === 'update' && rows[0].installed === '1.0.0');
    ok('plan: a missing component is available', rows[1].status === 'available' && rows[1].installed === null);
    ok('plan: same version is installed', catalogLib.plan(good, [{ id: 'doom', version: '1.0.1' }])[0].status === 'installed');
    ok('plan: a local build ahead of the catalog is newer', catalogLib.plan(good, [{ id: 'doom', version: '1.2.0' }])[0].status === 'newer');
    ok('versions compare numerically', catalogLib.compareVersions('1.10.0', '1.9.9') === 1);
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
    c.files.forEach((f) => fs.copyFileSync(path.join(ROOT, f.from), path.join(v1, f.path)));
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
    const confText = (extra) => [
        `catalog = https://updates.test:${HTTPS_PORT}/catalog.json`,
        `ca_file = ${path.join(T, 'ca.pem')}`, 'lease = ' + path.join(T, 'lease.json'),
        `deploy = ${path.join(opt, 'mgu-deploy', 'current', 'mgu-deploy.sh')}`, 'bootstrap_check_s = 6',
        `state_dir = ${path.join(T, 'state')}`,
        `tool_root = ${opt}`, `oap_root = ${oap}`, `socket = ${sock}`, 'socket_group = staff',
        'first_check_s = 0', 'check_interval_s = 3600', `privacy_tool = ${privacyTool}`, `public_key = ${TEST_PUB}`,
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
            // an unsigned catalog, and one signed with another key, are refused; the last good one stays
            publish(pubDir, [entry(app1, 'app', 'Demo')], null);
            client.check();
            return waitFor(client, (s) => s.catalog.error && !s.catalog.checking, 15000, 'the unsigned catalog refused');
        })
        .then((st) => {
            ok('signature: an unsigned catalog is refused and the last good one kept',
                /signature/.test(st.catalog.error) && st.components.length === 2, st.catalog.error);
            publish(pubDir, [entry(app1, 'app', 'Demo')], sh('openssl ecparam -name prime256v1 -genkey -noout'));
            client.check();
            return waitFor(client, (s) => !s.catalog.checking, 15000, 'the foreign-key catalog checked');
        })
        .then((st) => {
            ok('signature: a catalog signed with another key is refused', /signature/.test(st.catalog.error) &&
                st.components.length === 2, st.catalog.error);
            publish(pubDir, [entry(app1, 'app', 'Demo'), entry(kit2, 'tool', 'Updater')]);
            client.check();
            return waitFor(client, (s) => !s.catalog.error && !s.catalog.checking, 15000, 'the signed catalog accepted');
        })
        .then((st) => {
            ok('signature: a catalog signed with the configured key is used', st.components.length === 2);
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
            fs.copyFileSync(path.join(T, 'lease.json.good'), path.join(T, 'lease.json'));
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
                /^\d{4}-\d\d-\d\dT[\d:.]+Z demo_app@1\.1\.0: download \(\d+ bytes\)$/m.test(logText) &&
                /Z demo_app@1\.1\.0: install$/m.test(logText) && /Z deploy: /m.test(logText) &&
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
            fs.writeFileSync(conf, confText(['catalog = file://' + path.join(T, 'missing', 'catalog.json'),
                'public_key = /nonexistent.pem'].join('\n')));
            process.kill(Number(daemonPid()), 'SIGTERM');
            return sleep(8000).then(() => waitFor(client, (s) => s.catalog.error, 15000, 'a failed check'));
        })
        .then((st) => {
            ok('fail closed: an unreadable public key refuses the catalog and the daemon keeps running',
                /public key/.test(st.catalog.error) && st.components.length === 0, st.catalog.error);
            fs.writeFileSync(conf, confText('catalog = file://' + path.join(T, 'missing', 'catalog.json')));
            process.kill(Number(daemonPid()), 'SIGTERM');
            return sleep(8000).then(() => waitFor(client, (s) => s.catalog.error && !/public key/.test(s.catalog.error), 15000, 'missing file catalog'));
        })
        .then((st) => {
            ok('robust: a missing catalog file is a failed check, not a crash', /ENOENT/.test(st.catalog.error), st.catalog.error);
            return new Promise((resolve) => {
                client.once('reply-error', (msg) => {
                    ok('requests: an id the catalog does not list is refused', /not in the catalog/.test(msg));
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

/* ---- run ---------------------------------------------------------------------- */

function main() {
    const certs = makeCerts();
    const pubDir = path.join(T, 'pub');
    mkdirp(pubDir);
    testShippedKey();
    testCatalog();
    testCollect();
    testFileLog();
    return testReboot()
        .then(() => Promise.all([startDns(), startHttps(certs, pubDir)]))
        .then(([dnsSrv, httpsSrv]) => testFetch(certs, pubDir)
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
