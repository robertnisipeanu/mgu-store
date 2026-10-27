'use strict';
/**
 * The internet for one repo build that declares it (mgu-repo.json
 * `"network"`; README.md, "Building on the unit"): an HTTP proxy on
 * 127.0.0.1, run by the updater as a child process under the fetch uid
 * (uids.js), the one identity the apps-only uplink lets
 * out. The build itself, as the build uid, has no route out but this.
 * Node 8.
 *
 * stdin: one JSON job
 *   { token, uid, dns: ["1.2.3.4", ...], maxBytes, idleMs, open }
 *   token: the password every request carries (Proxy-Authorization: Basic,
 *   any user name); uid: the only uid whose connections are served (read
 *   from /proc/net/tcp; not checked where that file is missing); dns: the
 *   uplink lease's servers (empty: the system resolver); maxBytes: the most
 *   that may pass, both ways, in all; open (the tests only): any port and
 *   address.
 * stdout: one JSON line per event
 *   { listening: <port> }
 *   { request: "CONNECT host:443" | "GET http://host/..." }
 *   { refused: "<why>" }
 *
 * Served: CONNECT to port 443, and plain http GET/HEAD to port 80, to host
 * names that resolve to public IPv4 addresses (no address literal, nothing
 * private, loopback, link-local or shared). It runs until the updater
 * stops it.
 */
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;

function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

/* Whether a dotted IPv4 address is a public one. */
function isPublic(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) {
        return false;
    }
    const [a, b] = p;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
}

function resolver(servers, open) {
    const r = new dns.Resolver();
    if (servers && servers.length) {
        r.setServers(servers);
    }
    return (host, cb) => {
        if (!HOST.test(host)) {
            cb(new Error(`${host}: not a host name`));
            return;
        }
        r.resolve4(host, (err, addrs) => {
            const ok = !err && addrs.filter((a) => open || isPublic(a));
            if (!ok || !ok.length) {
                cb(err || new Error(`${host}: no public address`));
                return;
            }
            cb(null, ok[0]);
        });
    };
}

/* The uid owning the local end 127.0.0.1:port of a connection to us, from
 * /proc/net/tcp; null where that cannot be read. */
function peerUid(port, ourPort) {
    let text;
    try {
        text = fs.readFileSync('/proc/net/tcp', 'utf8');
    } catch (e) {
        return null;
    }
    const hex = (n) => (`0000${n.toString(16).toUpperCase()}`).slice(-4);
    const local = `0100007F:${hex(port)}`;
    const remote = `0100007F:${hex(ourPort)}`;
    const line = text.split('\n').map((l) => l.trim().split(/\s+/)).find((f) => f[1] === local && f[2] === remote);
    return line ? Number(line[7]) : -1;
}

function main(job) {
    const lookup = resolver(job.dns, job.open);
    const httpPort = job.open ? null : '80';
    const tlsPort = job.open ? null : '443';
    const token = Buffer.from(String(job.token));
    const idleMs = job.idleMs || 60000;
    let passed = 0;
    const count = (n) => {
        passed += n;
        return passed <= job.maxBytes;
    };
    const allowed = (req, socket) => {
        const auth = /^Basic (.+)$/.exec(String(req.headers['proxy-authorization'] || ''));
        const userPass = auth ? Buffer.from(auth[1], 'base64').toString() : '';
        const given = Buffer.from(userPass.slice(userPass.indexOf(':') + 1));
        if (!auth || given.length !== token.length || !crypto.timingSafeEqual(given, token)) {
            return 'no or wrong proxy password';
        }
        const uid = peerUid(socket.remotePort, server.address().port);
        if (uid !== null && uid !== job.uid) {
            return `connection from uid ${uid}`;
        }
        return null;
    };
    const server = http.createServer((req, res) => {
        const why = allowed(req, req.socket);
        let target;
        try {
            target = new URL(req.url);
        } catch (e) {
            target = null;
        }
        const refuse = (code, text) => {
            emit({ refused: text });
            // an answer already under way can only be cut off
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.writeHead(code, { 'Content-Type': 'text/plain' });
            res.end(`${text}\n`);
        };
        res.on('error', () => res.destroy());
        if (why) {
            refuse(407, why);
            return;
        }
        if (!target || target.protocol !== 'http:' || (httpPort && target.port && target.port !== httpPort) ||
            ['GET', 'HEAD'].indexOf(req.method) < 0) {
            refuse(403, `only http GET and HEAD to port 80, and CONNECT to port 443: ${req.method} ${req.url}`);
            return;
        }
        emit({ request: `${req.method} http://${target.hostname}${target.pathname}` });
        lookup(target.hostname, (err, ip) => {
            if (err) {
                refuse(502, err.message);
                return;
            }
            const headers = Object.assign({}, req.headers);
            delete headers['proxy-authorization'];
            delete headers['proxy-connection'];
            headers.host = target.host;
            const up = http.request({ host: ip, port: Number(target.port) || 80, method: req.method, path: target.pathname + target.search, headers }, (r) => {
                res.writeHead(r.statusCode, r.headers);
                r.on('data', (d) => {
                    if (!count(d.length)) {
                        emit({ refused: `more than ${job.maxBytes} bytes` });
                        r.destroy();
                        res.destroy();
                    }
                });
                r.pipe(res);
            });
            up.setTimeout(idleMs, () => up.abort());
            up.on('error', (e) => refuse(502, `${target.hostname}: ${e.code || e.message}`));
            up.end();
        });
    });
    server.on('connect', (req, socket, head) => {
        // the client's socket from now on is ours, errors too (a reset while the name resolves)
        let up = null;
        socket.on('error', () => {
            socket.destroy();
            if (up) {
                up.destroy();
            }
        });
        const why = allowed(req, socket);
        const m = /^([^:\s]+):(\d+)$/.exec(req.url || '');
        const refuse = (code, text) => {
            emit({ refused: text });
            socket.end(`HTTP/1.1 ${code} ${text.replace(/[\r\n]/g, ' ')}\r\n\r\n`);
        };
        if (why) {
            refuse(407, why);
            return;
        }
        if (!m || (tlsPort && m[2] !== tlsPort)) {
            refuse(403, `CONNECT only to port 443: ${req.url}`);
            return;
        }
        emit({ request: `CONNECT ${m[1]}:${m[2]}` });
        lookup(m[1], (err, ip) => {
            if (err || socket.destroyed) {
                if (err) {
                    refuse(502, err.message);
                }
                return;
            }
            up = net.connect(Number(m[2]), ip, () => {
                socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
                if (head && head.length) {
                    up.write(head);
                }
                const meter = (from, to) => from.on('data', (d) => {
                    if (!count(d.length)) {
                        emit({ refused: `more than ${job.maxBytes} bytes` });
                        up.destroy();
                        socket.destroy();
                        return;
                    }
                    to.write(d);
                });
                meter(up, socket);
                meter(socket, up);
                up.on('end', () => socket.end());
                socket.on('end', () => up.end());
            });
            [up, socket].forEach((s) => s.setTimeout(idleMs, () => {
                up.destroy();
                socket.destroy();
            }));
            up.on('error', () => {
                up.destroy();
                socket.destroy();
            });
        });
    });
    server.listen(0, '127.0.0.1', () => emit({ listening: server.address().port }));
}

module.exports = { isPublic };

if (require.main === module) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { input += d; });
    process.stdin.on('end', () => {
        let job;
        try {
            job = JSON.parse(input);
        } catch (e) {
            emit({ refused: 'bad job' });
            process.exitCode = 2;
            return;
        }
        main(job);
    });
}
