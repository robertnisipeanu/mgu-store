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
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const https = require('https');
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
 * itself), valid from `from` to `to` days from now. */
function issue(name, issuer, ext, from, to, cn) {
    if (fs.existsSync(path.join(T, `${name}.pem`))) {
        return;
    }
    sh(`openssl req -new -newkey rsa:2048 -nodes -subj /CN=${cn || name} -keyout ${name}.key -out ${name}.csr 2>&1`);
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
issue('badsig-ca-expired', 'inter-expired', 'leaf_ext', 2, 90);
tampered('badsig-ca-expired');
issue('badsig-future', 'inter', 'leaf_ext', 2, 90);
tampered('badsig-future');
issue('wrong-future', 'inter', 'wrong_ext', 2, 90);
issue('wrong-now', 'inter', 'wrong_ext', -1, 90);
issue('from-not-ca', 'not-ca', 'leaf_ext', 2, 90);
issue('client-future', 'inter', 'client_ext', 2, 90);

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
    { name: 'a bad server signature under an expired CA', leaf: 'badsig-ca-expired-bad', chain: ['inter-expired'] },
    { name: 'a bad server signature, not yet valid', leaf: 'badsig-future-bad', chain: ['inter'] },
    { name: 'a wrong host name, not yet valid', leaf: 'wrong-future', chain: ['inter'] },
    { name: 'a wrong host name at the right clock', leaf: 'wrong-now', chain: ['inter'] },
    { name: 'an issuer that is not a CA, not yet valid', leaf: 'from-not-ca', chain: ['not-ca'] },
    { name: 'a certificate not for TLS servers, not yet valid', leaf: 'client-future', chain: ['inter'] }
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
        const why = certs.verifyChain(chain, anchors);
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

testDirect();
testLogOnce();
testFetch()
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
