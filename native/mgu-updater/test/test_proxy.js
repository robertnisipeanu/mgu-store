'use strict';
/**
 * The proxy setting (js/tunnel.js) on the head unit's Node 8.16.2
 * (test/run.sh): fetch.js through a local HTTP CONNECT proxy and a local
 * SOCKS5 proxy, each with and without a user name and password, against an
 * HTTPS origin with its own CA:
 *  - a download, a redirect to another host and a resume (Range) through
 *    each, the target names looked up by the proxy only (the job's name
 *    server knows none);
 *  - a token reaches the origin's first host only: never the proxy, never a
 *    redirect target;
 *  - a wrong password (407, SOCKS5 refusal), a proxy that is down and one
 *    that never answers end with an error naming the proxy by host:port;
 *  - a setting that is not a proxy address is refused, never ignored;
 *  - the build proxy (proxy.js) reaches its upstreams through the proxy;
 *  - without a proxy, nothing changes.
 *
 *   node test/test_proxy.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const https = require('https');
const crypto = require('crypto');
const cp = require('child_process');
const tunnel = require('../js/tunnel');

const ROOT = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-proxy-test-'));
const TOKEN = 'tok-never-to-a-proxy';
let failed = 0;
let passed = 0;

function ok(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`ok   ${name}`);
    } else {
        failed++;
        console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
    }
}

function certs() {
    cp.execSync(`cd ${T} && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=proxy-test-ca -keyout ca.key -out ca.pem 2>&1 &&
        openssl req -newkey rsa:2048 -nodes -subj /CN=origin.test -keyout srv.key -out srv.csr 2>&1 &&
        printf 'subjectAltName=DNS:origin.test,DNS:assets.test,DNS:localhost\\n' > ext &&
        openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile ext -out srv.pem 2>&1`);
    return { ca: fs.readFileSync(path.join(T, 'ca.pem'), 'utf8'), key: fs.readFileSync(path.join(T, 'srv.key')),
        cert: fs.readFileSync(path.join(T, 'srv.pem')) };
}

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));

/* The origin: /file (ranges, a strong ETag), /cut (its first answer stops
 * part way), /redirect (to assets.test's /file). seen: { host, url, auth, range }. */
function origin(pki, payload) {
    const cuts = {};
    const srv = https.createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
        srv.seen.push({ host: String(req.headers.host).replace(/:\d+$/, ''), url: req.url, auth: req.headers.authorization || null,
            range: req.headers.range || null });
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: `https://assets.test:${srv.address().port}/file` });
            res.end();
            return;
        }
        if (req.url !== '/file' && req.url !== '/cut') {
            res.writeHead(404);
            res.end();
            return;
        }
        const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
        const from = m && req.headers['if-range'] === '"v1"' ? Number(m[1]) : 0;
        const body = payload.slice(from);
        res.writeHead(from ? 206 : 200, Object.assign({ 'Content-Length': body.length, 'Accept-Ranges': 'bytes', ETag: '"v1"' },
            from ? { 'Content-Range': `bytes ${from}-${payload.length - 1}/${payload.length}` } : {}));
        if (req.url === '/cut' && !cuts[req.url]) {
            cuts[req.url] = true;
            res.write(body.slice(0, 80000), () => res.socket.destroy());
            return;
        }
        res.end(body);
    });
    srv.seen = [];
    return srv;
}

/* An HTTP CONNECT proxy that sends every name to 127.0.0.1. auth:
 * "user:pass" it asks for. log: { target, auth, bytes (all the client sent) }. */
function httpProxy(auth) {
    const srv = http.createServer((req, res) => {
        res.writeHead(405);
        res.end();
    });
    srv.log = [];
    srv.on('connect', (req, socket) => {
        const entry = { target: req.url, auth: req.headers['proxy-authorization'] || null, bytes: '' };
        srv.log.push(entry);
        socket.on('data', (d) => { entry.bytes += d.toString('latin1'); });
        socket.on('error', () => {});
        if (auth && entry.auth !== `Basic ${Buffer.from(auth).toString('base64')}`) {
            socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            return;
        }
        const up = net.connect(Number(req.url.split(':').pop()), '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
            socket.pipe(up).pipe(socket);
        });
        up.on('error', () => socket.destroy());
    });
    return srv;
}

/* A SOCKS5 proxy (RFC 1928, user/password RFC 1929) that sends every name to
 * 127.0.0.1. log: { host, port, atyp, user, pass, bytes }. */
function socksProxy(user, pass) {
    const srv = net.createServer((c) => {
        const entry = { bytes: '' };
        srv.log.push(entry);
        let buf = Buffer.alloc(0);
        let stage = 'hello';
        c.on('error', () => {});
        const onData = (d) => {
            entry.bytes += d.toString('latin1');
            buf = Buffer.concat([buf, d]);
            if (stage === 'hello' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
                const methods = Array.from(buf.slice(2, 2 + buf[1]));
                buf = buf.slice(2 + buf[1]);
                const want = user ? 2 : 0;
                if (methods.indexOf(want) < 0) {
                    c.end(Buffer.from([5, 0xff]));
                    return;
                }
                c.write(Buffer.from([5, want]));
                stage = user ? 'auth' : 'request';
            }
            if (stage === 'auth' && buf.length >= 2 && buf.length >= 3 + buf[1] && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
                const ul = buf[1];
                entry.user = buf.slice(2, 2 + ul).toString();
                entry.pass = buf.slice(3 + ul, 3 + ul + buf[2 + ul]).toString();
                buf = buf.slice(3 + ul + buf[2 + ul]);
                if (entry.user !== user || entry.pass !== pass) {
                    c.end(Buffer.from([1, 1]));
                    return;
                }
                c.write(Buffer.from([1, 0]));
                stage = 'request';
            }
            if (stage === 'request' && buf.length >= 5) {
                const atyp = buf[3];
                const len = atyp === 1 ? 4 : 1 + buf[4];
                if (buf.length < 4 + len + 2) {
                    return;
                }
                entry.atyp = atyp;
                entry.host = atyp === 1 ? Array.from(buf.slice(4, 8)).join('.') : buf.slice(5, 5 + buf[4]).toString();
                entry.port = buf.readUInt16BE(4 + len);
                stage = 'open';
                c.removeListener('data', onData);
                c.on('data', (x) => { entry.bytes += x.toString('latin1'); });
                if (/^refused\./.test(entry.host)) {
                    c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
                    return;
                }
                const up = net.connect(entry.port, '127.0.0.1', () => {
                    c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                    c.pipe(up).pipe(c);
                });
                up.on('error', () => c.destroy());
            }
        };
        c.on('data', onData);
    });
    srv.log = [];
    return srv;
}

function runFetch(job) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = cp.spawn(process.execPath, [path.join(ROOT, 'js', 'fetch.js')], { stdio: ['pipe', 'pipe', 'inherit'], env: {} });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('close', (code) => {
            const events = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
            const file = job.dest && fs.existsSync(job.dest) ? fs.readFileSync(job.dest) : null;
            resolve({ code, events, last: events[events.length - 1] || {}, file, ms: Date.now() - t0 });
        });
        child.stdin.end(JSON.stringify(job));
    });
}

function testParse() {
    const p = (t) => {
        try {
            return tunnel.parse(t);
        } catch (e) {
            return e.message;
        }
    };
    const a = p('socks5://user:p%40ss@192.168.8.1:7891');
    ok('parse: socks5 with a user name and password', a.kind === 'socks5' && a.host === '192.168.8.1' && a.port === 7891 &&
        a.user === 'user' && a.pass === 'p@ss' && a.label === '192.168.8.1:7891', JSON.stringify(a));
    const b = p('http://proxy.lan:7890');
    ok('parse: http, a host name', b.kind === 'http' && b.host === 'proxy.lan' && b.port === 7890 && !b.user, JSON.stringify(b));
    ok('parse: socks5h is socks5, default ports', p('socks5h://10.0.0.1').port === 1080 && p('socks5h://10.0.0.1').kind === 'socks5' &&
        p('http://10.0.0.1').port === 80);
    ok('parse: an IPv6 address', p('http://[fd00::1]:3128').label === '[fd00::1]:3128', JSON.stringify(p('http://[fd00::1]:3128')));
    ok('parse: a bare % in a password is said as such', p('socks5://u:p%zz@h:1') === 'a % in a user name or password is written %25');
    const bad = ['', 'ftp://h:1', 'https://h:1', 'socks4://h:1', 'http://h:1/path', 'http://h:1?x', 'http://h:99999', 'h:1', 'http://h :1', 'http://h:1\nx = y'];
    const refused = bad.map((t) => [t, p(t)]).filter((x) => typeof x[1] !== 'string');
    ok('parse: anything else is refused with a reason', refused.length === 0, JSON.stringify(refused));
}

function testFetch(pki) {
    const payload = crypto.randomBytes(300000);
    const sum = (b) => b && crypto.createHash('sha256').update(b).digest('hex');
    const o = origin(pki, payload);
    const proxies = { http: httpProxy(), httpAuth: httpProxy('u:pw'), socks: socksProxy(), socksAuth: socksProxy('u', 'pw') };
    let n = 0;
    // a name server that answers nothing: through a proxy only the proxy looks names up
    const base = () => ({ headers: { 'User-Agent': 't', Authorization: `Bearer ${TOKEN}` }, dest: path.join(T, `dl-${n++}`), ca: pki.ca,
        dns: ['127.0.0.1:9'], maxBytes: payload.length, retryMs: 50, connectMs: 1000, idleMs: 1000 });
    let port;
    const at = (name) => `127.0.0.1:${proxies[name].address().port}`;
    const url = (host, p) => `https://${host}:${port}${p}`;
    const noToken = (srv) => srv.log.every((e) => e.bytes.indexOf(TOKEN) < 0 && String(e.auth || '').indexOf(TOKEN) < 0);
    const tries = (r) => JSON.stringify(r.events.filter((e) => e.progress === undefined));
    return listen(o).then((p) => {
        port = p;
        return Promise.all(Object.keys(proxies).map((k) => listen(proxies[k])));
    }).then(() => {
        const cases = [['http', 'http://'], ['httpAuth', 'http://u:pw@'], ['socks', 'socks5://'], ['socksAuth', 'socks5://u:pw@']];
        return cases.reduce((chain, [name, scheme]) => chain.then(() => {
            const srv = proxies[name];
            srv.log.length = 0;
            o.seen.length = 0;
            return runFetch(Object.assign(base(), { url: url('origin.test', '/file'), proxy: `${scheme}${at(name)}` })).then((r) => {
                ok(`${name}: downloads through the proxy, the name looked up there`, r.last.done && sum(r.file) === sum(payload) &&
                    srv.log.length === 1 && (srv.log[0].target === `origin.test:${port}` || (srv.log[0].host === 'origin.test' && srv.log[0].atyp === 3)),
                tries(r) + JSON.stringify(srv.log.map((e) => [e.target, e.host])));
                ok(`${name}: the origin gets the token, the proxy never`, o.seen.length === 1 && o.seen[0].auth === `Bearer ${TOKEN}` && noToken(srv),
                    JSON.stringify(o.seen));
                if (/Auth$/.test(name)) {
                    ok(`${name}: the proxy gets its own user name and password`, name === 'httpAuth'
                        ? srv.log[0].auth === `Basic ${Buffer.from('u:pw').toString('base64')}` : srv.log[0].user === 'u' && srv.log[0].pass === 'pw');
                }
                srv.log.length = 0;
                o.seen.length = 0;
                return runFetch(Object.assign(base(), { url: url('origin.test', '/redirect'), proxy: `${scheme}${at(name)}` }));
            }).then((r) => {
                const hosts = srv.log.map((e) => e.target || `${e.host}:${e.port}`);
                ok(`${name}: a redirect's target is reached through the proxy too`, r.last.done && sum(r.file) === sum(payload) &&
                    JSON.stringify(hosts) === JSON.stringify([`origin.test:${port}`, `assets.test:${port}`]), tries(r) + JSON.stringify(hosts));
                ok(`${name}: the token stays with the first host`, o.seen.length === 2 && o.seen[0].auth === `Bearer ${TOKEN}` &&
                    o.seen[1].host === 'assets.test' && o.seen[1].auth === null && noToken(srv), JSON.stringify(o.seen));
            });
        }), Promise.resolve());
    }).then(() => {
        o.seen.length = 0;
        proxies.socksAuth.log.length = 0;
        return runFetch(Object.assign(base(), { url: url('origin.test', '/cut'), proxy: `socks5://u:pw@${at('socksAuth')}` }));
    }).then((r) => {
        ok('resume: a download cut through the proxy asks for the rest through it, and comes out whole', r.last.done &&
            sum(r.file) === sum(payload) && o.seen.length === 2 && /^bytes=\d+-$/.test(o.seen[1].range || '') &&
            proxies.socksAuth.log.length === 2, tries(r) + JSON.stringify(o.seen));
        return runFetch(Object.assign(base(), { url: url('origin.test', '/file'), proxy: `http://u:wrong@${at('httpAuth')}` }));
    }).then((r) => {
        ok('http: a wrong password is a 407, said as such and not tried again', r.code === 1 &&
            r.last.error === `proxy ${at('httpAuth')}: refused CONNECT (407)` && !r.events.some((e) => e.retry), tries(r));
        return runFetch(Object.assign(base(), { url: url('origin.test', '/file'), proxy: `socks5://u:wrong@${at('socksAuth')}` }));
    }).then((r) => {
        ok('socks5: a wrong password is refused, said as such and not tried again', r.code === 1 &&
            r.last.error === `proxy ${at('socksAuth')}: refused the user name and password` && !r.events.some((e) => e.retry), tries(r));
        return runFetch(Object.assign(base(), { url: url('origin.test', '/file'), proxy: `socks5://${at('socksAuth')}` }));
    }).then((r) => {
        ok('socks5: a proxy that wants a password, given none, says so', r.code === 1 &&
            r.last.error === `proxy ${at('socksAuth')}: asks for a user name and password`, tries(r));
        return runFetch(Object.assign(base(), { url: url('refused.test', '/file'), proxy: `socks5://${at('socks')}` }));
    }).then((r) => {
        ok('socks5: a target the proxy cannot reach is named, with its reason', r.code === 1 &&
            r.last.error === `proxy ${at('socks')}: could not reach refused.test:${port}: connection refused (5 tries)`, tries(r));
        // a port nothing listens on
        const down = net.createServer();
        return listen(down).then((p) => new Promise((resolve) => down.close(() => resolve(p))));
    }).then((p) => runFetch(Object.assign(base(), { url: url('origin.test', '/file'), proxy: `http://127.0.0.1:${p}` })).then((r) => {
        ok('down: a proxy that is down is named, tried again like any connection', r.code === 1 &&
            r.last.error === `proxy 127.0.0.1:${p}: connection refused (5 tries)` && r.events.filter((e) => e.retry).length === 4, tries(r));
    })).then(() => {
        // accepts and never answers: counted in connectMs
        const mute = net.createServer((c) => c.on('error', () => {}));
        return listen(mute).then((p) => runFetch(Object.assign(base(), { url: url('origin.test', '/file'), proxy: `socks5://127.0.0.1:${p}` }))
            .then((r) => {
                ok('quiet: a proxy that never answers ends each try at connectMs', r.code === 1 &&
                    r.last.error === `proxy 127.0.0.1:${p}: no connection in 1 s (5 tries)` && r.ms < 8000, `${r.ms} ms ${tries(r)}`);
                mute.close();
            }));
    }).then(() => runFetch(Object.assign(base(), { url: url('origin.test', '/file'), proxy: 'socks4://127.0.0.1:1' }))).then((r) => {
        ok('setting: one that is not a proxy address fails the download, never ignored', r.code === 1 &&
            r.last.error === 'proxy setting: a proxy address starts with http:// or socks5://', tries(r));
        o.seen.length = 0;
        Object.keys(proxies).forEach((k) => { proxies[k].log.length = 0; });
        return runFetch(Object.assign(base(), { url: url('localhost', '/redirect').replace('/redirect', '/file'), dns: [] }));
    }).then((r) => {
        ok('none: without a proxy the connection is direct, no proxy asked', r.last.done && sum(r.file) === sum(payload) &&
            o.seen.length === 1 && o.seen[0].auth === `Bearer ${TOKEN}` && Object.keys(proxies).every((k) => proxies[k].log.length === 0), tries(r));
        proxies.http.log.length = 0;
        return runFetch(Object.assign(base(), { url: `https://127.0.0.1:${port}/file`, proxy: `http://${at('http')}` }));
    }).then((r) => {
        ok('tls: through the proxy the origin\'s certificate is checked the same (wrong name refused)', r.code === 1 &&
            /^127\.0\.0\.1: /.test(r.last.error || '') && proxies.http.log.length === 1 && !r.events.some((e) => e.retry), tries(r));
        Object.keys(proxies).forEach((k) => proxies[k].close());
        o.close();
    });
}

/* The build proxy (proxy.js) with an upstream proxy: a CONNECT and a plain GET go through it. */
function testBuildProxy() {
    const web = http.createServer((req, res) => res.end(`got ${req.headers.host}${req.url}\n`));
    const echo = net.createServer((c) => c.end('through\n'));
    const socks = socksProxy('u', 'pw');
    const hp = httpProxy();
    const lease = path.join(T, 'lease.json');
    fs.writeFileSync(lease, JSON.stringify({ dns: ['127.0.0.1:9'] }));
    const token = 'build-secret';
    const auth = { 'Proxy-Authorization': `Basic ${Buffer.from(`mgu:${token}`).toString('base64')}` };
    const start = (proxy, extra) => new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [path.join(ROOT, 'js', 'proxy.js')], { stdio: ['pipe', 'pipe', 'inherit'], env: {} });
        let buf = '';
        child.stdout.on('data', (d) => {
            buf += d;
            const m = /"listening":(\d+)/.exec(buf);
            if (m && !child.port) {
                child.port = Number(m[1]);
                resolve(child);
            }
        });
        child.on('exit', () => reject(new Error('the build proxy did not start')));
        child.stdin.end(JSON.stringify(Object.assign({ token, uid: process.getuid(), lease, maxBytes: 1 << 20, connectMs: 1000, idleMs: 1000,
            open: true, proxy }, extra)));
    });
    const connect = (child, target) => new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: child.port, method: 'CONNECT', path: target, headers: auth });
        req.on('connect', (res, socket, head) => {
            let body = String(head);
            socket.on('data', (d) => { body += d; });
            socket.on('error', () => {});
            socket.on('close', () => resolve({ code: res.statusCode, text: res.statusMessage, body }));
        });
        req.on('error', (e) => resolve({ code: 0, text: e.message }));
        req.end();
    });
    const get = (child, url) => new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: child.port, path: url, headers: auth }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve({ code: res.statusCode, body }));
        });
        req.on('error', (e) => resolve({ code: 0, body: e.message }));
        req.end();
    });
    let a;
    let b;
    let hpPort;
    return Promise.all([listen(web), listen(echo), listen(socks), listen(hp)])
        .then(() => Promise.all([start(`socks5://u:pw@127.0.0.1:${socks.address().port}`), start(`http://127.0.0.1:${hp.address().port}`)]))
        .then((kids) => {
            [a, b] = kids;
            return Promise.all([connect(a, `up.test:${echo.address().port}`), get(a, `http://web.test:${web.address().port}/x?y`),
                connect(b, `up.test:${echo.address().port}`), get(b, `http://web.test:${web.address().port}/x`)]);
        })
        .then(([c1, g1, c2, g2]) => {
            ok('build proxy: a CONNECT goes through a SOCKS5 upstream, the name looked up there', c1.code === 200 && c1.body === 'through\n' &&
                socks.log.some((e) => e.host === 'up.test' && e.user === 'u'), JSON.stringify([c1, socks.log.map((e) => e.host)]));
            ok('build proxy: an http GET goes through a SOCKS5 upstream', g1.code === 200 && g1.body === `got web.test:${web.address().port}/x?y\n`,
                JSON.stringify(g1));
            ok('build proxy: a CONNECT and an http GET go through an HTTP upstream', c2.code === 200 && c2.body === 'through\n' && g2.code === 200 &&
                hp.log.map((e) => e.target).join(' ') === `up.test:${echo.address().port} web.test:${web.address().port}`,
            JSON.stringify([c2, g2, hp.log.map((e) => e.target)]));
            ok('build proxy: its own password never reaches the upstream', socks.log.concat(hp.log).every((e) => e.bytes.indexOf(token) < 0 &&
                String(e.auth || '').indexOf(Buffer.from(`mgu:${token}`).toString('base64')) < 0));
            hpPort = hp.address().port;
            hp.close();
            return connect(b, `up.test:${echo.address().port}`);
        })
        .then((r) => {
            ok('build proxy: an upstream that is down is refused, naming it (502)', r.code === 502 &&
                r.text === `proxy 127.0.0.1:${hpPort}: connection refused`, JSON.stringify(r));
            fs.unlinkSync(lease);
            return connect(a, `up.test:${echo.address().port}`);
        })
        .then((r) => {
            ok('build proxy: without the uplink a connection is refused as having no internet, proxy or not', r.code === 502 &&
                r.text === 'no internet (the uplink is down)', JSON.stringify(r));
            // a name server that gives every name 127.0.0.1: what the lease's servers place on no public address stays refused
            return new Promise((resolve) => {
                const dns = dgram.createSocket('udp4');
                dns.on('message', (q, rinfo) => {
                    let i = 12;
                    while (q[i]) {
                        i += q[i] + 1;
                    }
                    const header = Buffer.from([q[0], q[1], 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
                    const answer = Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]);
                    dns.send(Buffer.concat([header, q.slice(12, i + 5), answer]), rinfo.port, rinfo.address);
                });
                dns.bind(0, '127.0.0.1', () => resolve(dns));
            });
        })
        .then((dns) => {
            fs.writeFileSync(lease, JSON.stringify({ dns: [`127.0.0.1:${dns.address().port}`] }));
            socks.log.length = 0;
            return start(`socks5://u:pw@127.0.0.1:${socks.address().port}`, { open: false })
                .then((c) => connect(c, 'router.test:443').then((r) => {
                    ok('build proxy: a name the lease\'s servers place on a private address is refused, the proxy not asked', r.code === 502 &&
                        r.text === 'router.test: no public address' && socks.log.length === 0, JSON.stringify([r, socks.log.length]));
                    c.kill('SIGKILL');
                    dns.close();
                }));
        })
        .then(() => {
            [a, b].forEach((k) => k.kill('SIGKILL'));
            [web, echo, socks].forEach((s) => s.close());
        });
}

testParse();
Promise.resolve(certs())
    .then((pki) => testFetch(pki))
    .then(testBuildProxy)
    .catch((e) => {
        failed++;
        console.log(`FAIL ${e.stack}`);
    })
    .then(() => {
        cp.execSync(`rm -rf ${T}`);
        console.log(`${passed} passed, ${failed} failed`);
        process.exit(failed ? 1 : 0);
    });
