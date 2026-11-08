'use strict';
/**
 * Certificate dates (js/certs.js and fetch.js): a valid chain is accepted at
 * any clock, and nothing but the dates is let go. A local PKI made with
 * openssl, one HTTPS server per chain on localhost; each chain is fetched
 * through fetch.js and checked with verifyChain directly, so a refusal never
 * rests on which error OpenSSL happened to report first.
 *
 *   node test/test_certs.js [dir]   (test/run.sh runs it on the unit's Node)
 *   dir: the PKI's folder, kept; its certificates are made only where
 *   missing, so a folder made elsewhere serves a unit without openssl's
 *   key generation
 *
 * Downloads cut mid-transfer (cut()): fetch.js tries again and asks for the
 * rest where the server takes ranges, through a redirect to a host whose
 * dates are let go too; the file comes out whole. Connections that go
 * quiet (testStalls()): no answer to the handshake or to the request, and a
 * name server that never answers; each try ends in
 * time, asks the lease as it is then, and the download comes out whole.
 *
 * With MGU_TEST_PYTHON naming a Python 3.6 or newer (mgu-python on the
 * unit), each chain is also fetched by that Python's own TLS (urllib, the
 * test root as its only CA): with js/py/ on PYTHONPATH, as a build runs, the
 * same chains are taken and refused; without it, a chain whose dates
 * don't fit the clock is refused too.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const net = require('net');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');
const certs = require('../js/certs');

const ROOT = path.join(__dirname, '..');
const T = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'certs-'));
const DAY = 86400000;
let failed = 0;

function ok(name, cond, detail) {
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail === undefined ? '' : `: ${detail}`}`);
    if (!cond) {
        failed++;
    }
}

function sh(cmd) {
    return cp.execSync(cmd, { cwd: T, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/* openssl ca's date form, days from now. */
function at(days) {
    return new Date(Date.now() + days * DAY).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
}

if (!fs.existsSync(T)) {
    fs.mkdirSync(T);
}
fs.writeFileSync(path.join(T, 'ca.cnf'), `[ca]
default_ca = d
[d]
database = ${T}/index.txt
new_certs_dir = ${T}
serial = ${T}/serial
default_md = sha256
policy = p
unique_subject = no
[p]
commonName = supplied
[ca_ext]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
[noca_ext]
basicConstraints = CA:FALSE
[leaf_ext]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost
[wrong_ext]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:wrong.test
[client_ext]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = clientAuth
subjectAltName = DNS:localhost
[ns_client_ext]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
nsCertType = client
subjectAltName = DNS:localhost
[self_ext]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,digitalSignature,keyEncipherment
subjectAltName = DNS:localhost
`);
if (!fs.existsSync(path.join(T, 'serial'))) {
    fs.writeFileSync(path.join(T, 'index.txt'), '');
    fs.writeFileSync(path.join(T, 'serial'), '1000\n');
}

/* Makes <name>.key and <name>.pem: CN cn (name), signed by issuer (null: by
 * itself), valid from `from` to `to` days from now; with key, <key>.key's
 * key rather than a new one. */
function issue(name, issuer, ext, from, to, cn, key) {
    if (fs.existsSync(path.join(T, `${name}.pem`))) {
        return;
    }
    if (key) {
        fs.copyFileSync(path.join(T, `${key}.key`), path.join(T, `${name}.key`));
    }
    sh(`openssl req -new ${key ? `-key ${name}.key` : '-newkey rsa:2048 -nodes -keyout ' + name + '.key'} -subj /CN=${cn || name} -out ${name}.csr 2>&1`);
    const by = issuer ? `-cert ${issuer}.pem -keyfile ${issuer}.key` : `-selfsign -keyfile ${name}.key`;
    sh(`openssl ca -batch -config ca.cnf -notext ${by} -extensions ${ext} -startdate ${at(from)} -enddate ${at(to)} ` +
        `-in ${name}.csr -out ${name}.pem 2>&1`);
}

const pem = (name) => fs.readFileSync(path.join(T, `${name}.pem`), 'utf8');
const der = (name) => certs.pemCerts(pem(name))[0];

/* name's certificate with the last byte of its signature changed. */
function tampered(name) {
    const d = Buffer.from(der(name));
    d[d.length - 1] ^= 0x01;
    const b64 = d.toString('base64').replace(/.{64}/g, '$&\n');
    fs.writeFileSync(path.join(T, `${name}-bad.pem`), `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`);
    fs.copyFileSync(path.join(T, `${name}.key`), path.join(T, `${name}-bad.key`));
}

// the trusted root and its intermediates
issue('root', null, 'ca_ext', -30, 3650);
issue('inter', 'root', 'ca_ext', -30, 365);
issue('inter-future', 'root', 'ca_ext', 2, 365);
issue('inter-expired', 'root', 'ca_ext', -60, -1);
issue('not-ca', 'root', 'noca_ext', -30, 365);
// an untrusted root and intermediate named like the trusted ones
issue('other-root', null, 'ca_ext', -30, 3650, 'root');
issue('other-inter', 'other-root', 'ca_ext', -30, 365, 'inter');
// server certificates
issue('now', 'inter', 'leaf_ext', -1, 90);
issue('future', 'inter-future', 'leaf_ext', 2, 90);
issue('future-leaf', 'inter', 'leaf_ext', 2, 90);
issue('expired', 'inter', 'leaf_ext', -90, -1);
issue('self-future', null, 'self_ext', 2, 90);
issue('self-now', null, 'self_ext', -1, 90);
issue('untrusted-future', 'other-inter', 'leaf_ext', 2, 90);
issue('untrusted-now', 'other-inter', 'leaf_ext', -1, 90);
issue('badsig-ca-expired', 'inter-expired', 'leaf_ext', 2, 90);
tampered('badsig-ca-expired');
issue('badsig-future', 'inter', 'leaf_ext', 2, 90);
tampered('badsig-future');
issue('badsig-now', 'inter', 'leaf_ext', -1, 90);
tampered('badsig-now');
issue('wrong-future', 'inter', 'wrong_ext', 2, 90);
issue('wrong-now', 'inter', 'wrong_ext', -1, 90);
issue('from-not-ca', 'not-ca', 'leaf_ext', 2, 90);
issue('client-future', 'inter', 'client_ext', 2, 90);
issue('ns-client-future', 'inter', 'ns_client_ext', 2, 90);
// 12 untrusted CAs that each sign the others (one key, one name), under a server certificate
const LOOP = [];
for (let i = 0; i < 12; i++) {
    LOOP.push(`loop-${i}`);
    issue(`loop-${i}`, null, 'ca_ext', -30, 3650, 'loop', i ? 'loop-0' : null);
}
issue('loop-future', 'loop-0', 'leaf_ext', 2, 90);

/* Each case: the server certificate, the chain it presents above it,
 * whether fetch.js takes it, and the error a refusal reports. */
const CASES = [
    { name: 'a valid chain at the right clock', leaf: 'now', chain: ['inter'], accept: true },
    { name: 'a valid chain not yet valid (clock behind)', leaf: 'future', chain: ['inter-future'], accept: true, dates: 'CERT_NOT_YET_VALID' },
    { name: 'a valid chain with only the server certificate not yet valid', leaf: 'future-leaf', chain: ['inter'], accept: true,
        dates: 'CERT_NOT_YET_VALID' },
    { name: 'a valid chain expired (clock ahead)', leaf: 'expired', chain: ['inter'], accept: true, dates: 'CERT_HAS_EXPIRED' },
    { name: 'a self-signed certificate not yet valid', leaf: 'self-future', chain: [] },
    { name: 'a self-signed certificate at the right clock', leaf: 'self-now', chain: [] },
    { name: 'a chain to an untrusted root, not yet valid', leaf: 'untrusted-future', chain: ['other-inter', 'other-root'] },
    { name: 'a chain to an untrusted root at the right clock', leaf: 'untrusted-now', chain: ['other-inter', 'other-root'] },
    { name: 'a bad server signature under an expired CA', leaf: 'badsig-ca-expired-bad', chain: ['inter-expired'] },
    { name: 'a bad server signature, not yet valid', leaf: 'badsig-future-bad', chain: ['inter'] },
    { name: 'a bad server signature at the right clock', leaf: 'badsig-now-bad', chain: ['inter'] },
    { name: 'a wrong host name, not yet valid', leaf: 'wrong-future', chain: ['inter'] },
    { name: 'a wrong host name at the right clock', leaf: 'wrong-now', chain: ['inter'] },
    { name: 'an issuer that is not a CA, not yet valid', leaf: 'from-not-ca', chain: ['not-ca'] },
    { name: 'a certificate not for TLS servers, not yet valid', leaf: 'client-future', chain: ['inter'] },
    { name: 'a Netscape cert type without SSL server, not yet valid', leaf: 'ns-client-future', chain: ['inter'] },
    { name: 'a chain of 12 CAs that sign one another, not yet valid', leaf: 'loop-future', chain: LOOP, quick: true }
];

function serve(c) {
    return new Promise((resolve) => {
        const s = https.createServer({ key: fs.readFileSync(path.join(T, `${c.leaf}.key`)),
            cert: [c.leaf].concat(c.chain).map(pem).join('') }, (req, res) => {
            s.requests++;
            res.end('payload');
        });
        s.requests = 0;
        s.listen(0, () => resolve(s));
    });
}

function runFetch(job) {
    return new Promise((resolve) => {
        const child = cp.spawn(process.execPath, [path.join(ROOT, 'js', 'fetch.js')], { stdio: ['pipe', 'pipe', 'inherit'], env: {} });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('close', (code) => resolve({ code, events: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
        child.stdin.end(JSON.stringify(job));
    });
}

function fetchCase(c, i, ca) {
    return serve(c).then((s) => runFetch({ url: `https://localhost:${s.address().port}/x`, headers: {},
        dest: path.join(T, `dl-${i}-${ca ? 'ca' : 'node'}`), ca, dns: [] })
        .then((r) => {
            s.close();
            return Object.assign(r, { requests: s.requests });
        }));
}

function testDirect() {
    const anchors = [der('root')];
    CASES.forEach((c) => {
        const chain = [c.leaf].concat(c.chain).map(der);
        const t0 = Date.now();
        const why = certs.verifyChain(chain, anchors);
        if (c.quick) {
            ok(`verifyChain: ${c.name}: settled within 2 s`, Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
        }
        // the host name is fetch.js's to check
        const expect = c.accept || /^wrong/.test(c.leaf);
        ok(`verifyChain: ${c.name}: ${expect ? 'accepted' : 'refused'}`, expect ? why === null : why !== null, why);
    });
    ok('verifyChain: an untrusted root named like the trusted one is not an anchor',
        certs.verifyChain([der('now'), der('inter')], [der('other-root')]) !== null);
    ok('verifyChain: a valid chain is refused without its root among the anchors',
        certs.verifyChain([der('now'), der('inter'), der('root')], []) !== null);
    ok('verifyChain: an intermediate given as an anchor is not one', certs.verifyChain([der('now')], [der('inter')]) !== null);
    ok('verifyChain: garbage is refused', certs.verifyChain([Buffer.from('3003020100', 'hex')], anchors) !== null);
    const roots = certs.nodeRoots();
    ok('nodeRoots: the roots built into Node', roots.length > 100 && roots.every((r) => {
        try {
            return certs._parse(r).subject.length > 0;
        } catch (e) {
            return false;
        }
    }), roots.length);
}

function testFetch() {
    const ca = pem('root');
    return CASES.reduce((p, c, i) => p.then(() => fetchCase(c, i, ca)).then((r) => {
        const last = r.events[r.events.length - 1] || {};
        const dates = r.events.filter((e) => e.certDates);
        if (c.accept) {
            ok(`fetch: ${c.name}: downloaded`, last.done && r.requests === 1, JSON.stringify(r.events));
            ok(`fetch: ${c.name}: ${c.dates ? `reports ${c.dates} ignored` : 'reports no dates'}`,
                c.dates ? dates.length === 1 && dates[0].certDates === 'localhost' && dates[0].error === c.dates : dates.length === 0,
                JSON.stringify(dates));
        } else {
            ok(`fetch: ${c.name}: refused before any request`, r.code !== 0 && last.error && r.requests === 0 && !dates.length,
                JSON.stringify(r.events));
        }
    }), Promise.resolve())
        // Node's own roots: the test root is not one of them
        .then(() => fetchCase(CASES[1], 'node', undefined))
        .then((r) => ok('fetch: with Node\'s roots, a chain to an unknown root is refused, dates or not',
            r.code !== 0 && r.requests === 0, JSON.stringify(r.events)));
}

/* python -c PY_FETCH <url> <cafile> [assign]: prints "ok" once the body is read, else "error <why>";
 * with assign, the context's verify_flags are set over after it is made. */
const PY_FETCH = `
import ssl, sys, urllib.request
try:
    ctx = ssl.create_default_context(cafile=sys.argv[2])
    if sys.argv[3:] == ['assign']:
        ctx.verify_flags = ssl.VERIFY_DEFAULT
    urllib.request.urlopen(sys.argv[1], context=ctx, timeout=20).read()
    print('ok')
except Exception as e:
    print('error %s' % e)
`;

/* Each case through Python's TLS, as a build's (py/ on PYTHONPATH) and
 * without it. */
function testPython(python) {
    const run = (url, hook, assign) => new Promise((resolve) => {
        const env = { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' };
        if (hook) {
            env.PYTHONPATH = path.join(ROOT, 'js', 'py');
        }
        cp.execFile(python, ['-c', PY_FETCH, url, path.join(T, 'root.pem')].concat(assign ? ['assign'] : []), { env, encoding: 'utf8' },
            (err, out) => resolve(String(out).trim() || (err && err.message)));
    });
    return CASES.reduce((p, c) => p.then(() => serve(c)).then((s) => {
        const url = `https://localhost:${s.address().port}/x`;
        return run(url, true).then((withHook) => run(url, true, true).then((assigned) => run(url, false).then((without) => {
            s.close();
            const fits = c.accept && !c.dates;
            ok(`python (build): ${c.name}: ${c.accept ? 'downloaded' : 'refused'}`,
                c.accept ? withHook === 'ok' : /^error /.test(withHook), withHook);
            ok(`python (build, verify_flags set over): ${c.name}: ${c.accept ? 'downloaded' : 'refused'}`,
                c.accept ? assigned === 'ok' : /^error /.test(assigned), assigned);
            ok(`python (no hook): ${c.name}: ${fits ? 'downloaded' : 'refused'}`, fits ? without === 'ok' : /^error /.test(without), without);
            ok(`python: ${c.name}: a request only from a fetch taken`, s.requests === (c.accept ? 2 : 0) + (fits ? 1 : 0), s.requests);
        })));
    }), Promise.resolve());
}

function testLogOnce() {
    const { Fetcher } = require('../js/updater');
    const f = new Fetcher({ state_dir: path.join(T, 'state') });
    const lines = [];
    const log = console.log;
    console.log = (l) => lines.push(l);
    try {
        f.datesIgnored('api.github.com', 'CERT_NOT_YET_VALID');
        f.datesIgnored('api.github.com', 'CERT_NOT_YET_VALID');
        f.datesIgnored('codeload.github.com', 'CERT_HAS_EXPIRED');
    } finally {
        console.log = log;
    }
    ok('log: once per host', lines.length === 2 && /api\.github\.com: CERT_NOT_YET_VALID ignored/.test(lines[0]) &&
        /codeload\.github\.com: CERT_HAS_EXPIRED ignored/.test(lines[1]), JSON.stringify(lines));
}

/* A server of leaf's chain whose paths cut their answers (below); each
 * request's path, Range and If-Range in s.seen. */
function cutServer(leaf, chain, payload) {
    return new Promise((resolve) => {
        const s = https.createServer({ key: fs.readFileSync(path.join(T, `${leaf}.key`)),
            cert: [leaf].concat(chain).map(pem).join('') }, (req, res) => {
            const p = req.url.split('?')[0];
            const n = s.seen.filter((x) => x.path === p).length;
            s.seen.push({ path: p, range: req.headers.range || null, ifRange: req.headers['if-range'] || null, method: req.method });
            const ranges = p !== '/cut-norange' && p !== '/cut-always';
            const etag = p === '/changed' && n > 0 ? '"v2"' : '"v1"';
            const body = p === '/changed' && n > 0 ? Buffer.from(payload).reverse() : payload;
            const head = Object.assign({ ETag: etag }, ranges ? { 'Accept-Ranges': 'bytes' } : {});
            if (p === '/redirect') {
                res.writeHead(302, { Location: `https://localhost:${s.next}/cut` });
                res.end();
                return;
            }
            if (p === '/busy' && n === 0) {
                res.writeHead(503);
                res.end();
                return;
            }
            // the resume of /cut-refuse is refused once before it gets an answer
            if (p === '/cut-refuse' && n === 1) {
                res.socket.destroy();
                return;
            }
            // the first request of /hold-head gets no answer at all, its connection kept open
            if (p === '/hold-head' && n === 0) {
                return;
            }
            if (p === '/missing') {
                res.writeHead(404);
                res.end();
                return;
            }
            const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
            if (m && ranges && req.headers['if-range'] === etag) {
                const from = Number(m[1]);
                res.writeHead(206, Object.assign(head, { 'Content-Length': body.length - from,
                    'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` }));
                res.end(body.slice(from));
                return;
            }
            res.writeHead(200, Object.assign(head, { 'Content-Length': body.length }));
            // the first answer of each path (every one of /cut-always) stops part way
            if ((n === 0 && p !== '/busy') || p === '/cut-always') {
                res.write(body.slice(0, 80000), () => {
                    if (p !== '/stall') {
                        res.socket.destroy();
                    }
                });
                return;
            }
            res.end(body);
        });
        s.seen = [];
        s.listen(0, () => resolve(s));
    });
}

function testCuts() {
    const payload = crypto.randomBytes(200000);
    const sum = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const ca = pem('root');
    let a;
    let b;
    let i = 0;
    const fetchCut = (server, p, extra) => {
        const dest = path.join(T, `cut-${i++}`);
        server.seen.length = 0;
        return runFetch(Object.assign({ url: `https://localhost:${server.address().port}${p}`, headers: { 'User-Agent': 't' },
            dest, ca, dns: [], maxBytes: payload.length, retryMs: 50, idleMs: 1000 }, extra || {}))
            .then((r) => Object.assign(r, { last: r.events[r.events.length - 1] || {}, file: fs.existsSync(dest) ? fs.readFileSync(dest) : null,
                seen: server.seen.slice() }));
    };
    return cutServer('now', ['inter'], payload).then((s) => {
        a = s;
        return cutServer('future', ['inter-future'], payload);
    }).then((s) => {
        b = s;
        a.next = b.address().port;
        return fetchCut(a, '/cut');
    }).then((r) => {
        ok('cut: a download cut mid-transfer comes out whole', r.code === 0 && r.last.done && r.file && sum(r.file) === sum(payload),
            JSON.stringify(r.events.filter((e) => e.progress === undefined)));
        ok('cut: the second try asks for the rest, with the ETag in If-Range', r.seen.length === 2 && r.seen[0].range === null &&
            /^bytes=\d+-$/.test(r.seen[1].range || '') && Number(r.seen[1].range.slice(6, -1)) > 0 && r.seen[1].ifRange === '"v1"',
        JSON.stringify(r.seen));
        ok('cut: the try is reported', r.events.some((e) => e.retry === 1 && e.error === 'connection closed mid-download' && e.from > 0),
            JSON.stringify(r.events.filter((e) => e.progress === undefined)));
        return fetchCut(a, '/cut-refuse');
    }).then((r) => {
        ok('cut: a resume that fails before any answer asks for the same rest again', r.last.done && r.file && sum(r.file) === sum(payload) &&
            r.seen.length === 3 && r.seen[1].range && r.seen[2].range === r.seen[1].range, JSON.stringify(r.seen));
        return fetchCut(a, '/cut-norange');
    }).then((r) => {
        ok('cut: without ranges, the file starts over and comes out whole', r.last.done && r.file && sum(r.file) === sum(payload) &&
            r.seen.length === 2 && r.seen[1].range === null, JSON.stringify(r.seen));
        return fetchCut(a, '/changed');
    }).then((r) => {
        ok('cut: a file changed since the cut starts over (If-Range)', r.last.done && r.file && sum(r.file) === sum(Buffer.from(payload).reverse()) &&
            r.seen.length === 2 && r.seen[1].ifRange === '"v1"', JSON.stringify(r.seen));
        return fetchCut(a, '/stall');
    }).then((r) => {
        ok('cut: an answer that stops sending is tried again', r.last.done && r.file && sum(r.file) === sum(payload) &&
            r.events.some((e) => e.retry && /no data for 1 s/.test(e.error)), JSON.stringify(r.events.filter((e) => e.progress === undefined)));
        return fetchCut(a, '/redirect');
    }).then((r) => {
        const there = r.seen.length;
        const onB = b.seen.slice();
        ok('cut: through a redirect to a host whose dates are let go, the file comes out whole', r.last.done && r.file &&
            sum(r.file) === sum(payload) && r.events.some((e) => e.certDates === 'localhost' && e.error === 'CERT_NOT_YET_VALID'),
        JSON.stringify(r.events.filter((e) => e.progress === undefined)));
        ok('cut: the rest is asked for through the redirect, from its target', there === 2 && onB.length === 2 &&
            onB[0].range === null && /^bytes=\d+-$/.test(onB[1].range || '') && onB[1].ifRange === '"v1"', JSON.stringify(onB));
        return fetchCut(a, '/cut-always');
    }).then((r) => {
        ok('cut: a link that always cuts gives up with its reason, after 5 tries', r.code !== 0 &&
            r.last.error === 'connection closed mid-download (5 tries)' && r.seen.length === 5 && r.events.filter((e) => e.error && !e.retry).length === 1,
        JSON.stringify(r.events.filter((e) => e.progress === undefined)));
        return fetchCut(a, '/busy');
    }).then((r) => {
        ok('cut: an HTTP 503 is tried again', r.last.done && r.file && sum(r.file) === sum(payload) && r.seen.length === 2, JSON.stringify(r.seen));
        return fetchCut(a, '/missing');
    }).then((r) => {
        ok('cut: an HTTP 404 is not tried again', r.code !== 0 && r.last.status === 404 && r.seen.length === 1, JSON.stringify(r.seen));
        return fetchCut(a, '/cut', { method: 'POST', body: 'x' });
    }).then((r) => {
        ok('cut: a POST is not tried again', r.code !== 0 && r.last.error && r.seen.length === 1, JSON.stringify(r.seen));
        a.close();
        b.close();
    });
}

/* A network that has gone quiet: nothing answers and nothing resets.
 * Every wait is bounded (connectMs, idleMs: 1 s here), each try asks the
 * lease it finds then, and a download that cannot go on ends at once. */
function testStalls() {
    const payload = crypto.randomBytes(200000);
    const sum = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const ca = pem('root');
    const lease = path.join(T, 'lease.json');
    let i = 0;
    // job's events, with onEvent(ev) told each as it comes; ms: how long it took
    const run = (job, onEvent) => new Promise((resolve) => {
        const dest = path.join(T, `stall-${i++}`);
        const t0 = Date.now();
        const child = cp.spawn(process.execPath, [path.join(ROOT, 'js', 'fetch.js')], { stdio: ['pipe', 'pipe', 'inherit'], env: {} });
        const events = [];
        let buf = '';
        child.stdout.on('data', (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const ev = JSON.parse(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                events.push(ev);
                if (onEvent) {
                    onEvent(ev);
                }
            }
        });
        child.on('close', (code) => resolve({ code, events, ms: Date.now() - t0, last: events[events.length - 1] || {},
            file: fs.existsSync(dest) ? fs.readFileSync(dest) : null }));
        child.stdin.end(JSON.stringify(Object.assign({ headers: { 'User-Agent': 't' }, dest, ca, dns: [], maxBytes: payload.length,
            retryMs: 50, connectMs: 1000, idleMs: 1000 }, job)));
    });
    const tries = (r) => JSON.stringify(r.events.filter((e) => e.progress === undefined));
    let web;
    let quiet;
    let silentDns;
    return cutServer('now', ['inter'], payload).then((s) => {
        web = s;
        // TCP accepted, the TLS handshake never answered, for the first connection; the rest reach web
        return new Promise((resolve) => {
            let conns = 0;
            quiet = net.createServer((c) => {
                c.on('error', () => {});
                if (conns++ === 0) {
                    return;
                }
                const up = net.connect(web.address().port, '127.0.0.1');
                up.on('error', () => c.destroy());
                c.pipe(up).pipe(c);
            });
            quiet.listen(0, '127.0.0.1', resolve);
        });
    }).then(() => new Promise((resolve) => {
        // a DNS server that takes every query and answers none
        silentDns = dgram.createSocket('udp4');
        silentDns.bind(0, '127.0.0.1', resolve);
    })).then(() => run({ url: `https://localhost:${web.address().port}/hold-head` })).then((r) => {
        ok('stall: an answer whose headers never come is tried again after idleMs, and comes out whole',
            r.last.done && r.file && sum(r.file) === sum(payload) && r.events.some((e) => e.retry && /no data for 1 s/.test(e.error)) &&
            r.ms < 4000, `${r.ms} ms ${tries(r)}`);
        return run({ url: `https://localhost:${quiet.address().port}/x` });
    }).then((r) => {
        ok('stall: a connection whose TLS handshake never answers is tried again after connectMs',
            r.last.done && r.file && sum(r.file) === sum(payload) && r.events.some((e) => e.retry && /no connection in 1 s/.test(e.error)) &&
            r.ms < 4000, `${r.ms} ms ${tries(r)}`);
        return run({ url: `https://stalled.test:${web.address().port}/x`, dns: [`127.0.0.1:${silentDns.address().port}`] });
    }).then((r) => {
        // 5 tries of 1 s and 50 + 100 + 200 + 400 ms between: the lookups still under way keep no one waiting
        ok('stall: a name lookup that never answers ends each try at connectMs, and the download fails as soon as the last does',
            r.code === 1 && r.last.error === 'stalled.test: no connection in 1 s (5 tries)' && r.ms < 7500, `${r.ms} ms ${tries(r)}`);
        // the lease names the silent server; after the first try the uplink is on another network
        // (retryMs: time for the lease to change before the next try reads it)
        fs.writeFileSync(lease, JSON.stringify({ dns: [`127.0.0.1:${silentDns.address().port}`] }));
        return run({ url: `https://localhost:${web.address().port}/x`, dns: [`127.0.0.1:${silentDns.address().port}`], lease, retryMs: 500 }, (ev) => {
            if (ev.retry === 1) {
                fs.writeFileSync(lease, JSON.stringify({ dns: [] }));
            }
        });
    }).then((r) => {
        ok('stall: each try resolves through the lease as it is then', r.last.done && r.file && sum(r.file) === sum(payload) &&
            r.events.filter((e) => e.retry).length === 1, tries(r));
        fs.unlinkSync(lease);
        return run({ url: `https://localhost:${web.address().port}/x`, lease, retryMs: 500 }, (ev) => {
            if (ev.retry === 2) {
                fs.writeFileSync(lease, JSON.stringify({ dns: [] }));
            }
        });
    }).then((r) => {
        ok('stall: a try without a lease fails as having no internet, and a lease that comes back is used',
            r.last.done && r.file && sum(r.file) === sum(payload) &&
            r.events.filter((e) => e.retry && e.error === 'no internet (the uplink is down)').length === 2, tries(r));
        web.close();
        quiet.close();
        silentDns.close();
    });
}

testDirect();
testLogOnce();
testFetch()
    .then(testCuts)
    .then(testStalls)
    .then(() => (process.env.MGU_TEST_PYTHON ? testPython(process.env.MGU_TEST_PYTHON) : null))
    .catch((e) => {
        failed++;
        console.log(`FAIL ${e.stack}`);
    })
    .then(() => {
        if (!process.argv[2]) {
            cp.execSync(`rm -rf ${T}`);
        }
        console.log(failed ? `${failed} failed` : 'all passed');
        process.exit(failed ? 1 : 0);
    });
