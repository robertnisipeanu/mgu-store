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
 *   { token, uid, dns: ["1.2.3.4", ...], lease, maxBytes, connectMs, idleMs, open, proxy }
 *   token: the password every request carries (Proxy-Authorization: Basic,
 *   any user name); uid: the only uid whose connections are served (read
 *   from /proc/net/tcp; not checked where that file is missing); dns: the
 *   uplink lease's servers (empty: the system resolver); lease: the uplink's
 *   lease file, read again for each connection: its dns servers replace dns,
 *   and without one the connection is refused (the uplink is down, or
 *   between networks); maxBytes: the most that may pass, both ways, in all;
 *   connectMs: how long the name lookup and the TCP connection may take
 *   together (15 s); idleMs: how long a connection may go without data;
 *   open (the tests only): any port and address; proxy: the updater's proxy
 *   setting (tunnel.js), which every connection goes through.
 * stdout: one JSON line per event
 *   { listening: <port> }
 *   { request: "CONNECT host:443" | "GET http://host/..." }
 *   { refused: "<why>" }
 *
 * Served: CONNECT to port 443, and plain http GET/HEAD to port 80, to host
 * names that resolve to public IPv4 addresses (no address literal, nothing
 * private, loopback, link-local or shared); through a proxy, also to
 * names the lease's servers cannot look up. It runs until the updater stops
 * it.
 */
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { leaseDns, lookupVia, CONNECT_MS } = require('./fetch');
const tunnel = require('./tunnel');

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

/* lookup(host, cb) -> cancel(): host's first public IPv4 address, through
 * the servers of the uplink's lease as it is then (job.lease), else job.dns:
 * a network joined since the build started has its own. cb(err, ip,
 * servers); err.refused: host is not to be reached at all (not a host
 * name, no uplink, only addresses that are not public). */
function resolver(job) {
    const refused = (why) => Object.assign(new Error(why), { refused: true });
    return (host, cb) => {
        if (!HOST.test(host)) {
            cb(refused(`${host}: not a host name`));
            return () => {};
        }
        const servers = job.lease ? leaseDns(job.lease) : job.dns;
        if (!servers) {
            cb(refused('no internet (the uplink is down)'));
            return () => {};
        }
        const r = new dns.Resolver();
        if (servers.length) {
            r.setServers(servers);
        }
        r.resolve4(host, (err, addrs) => {
            const ok = !err && addrs.filter((a) => job.open || isPublic(a));
            if (err) {
                cb(err, null, servers);
            } else if (!ok.length) {
                cb(refused(`${host}: no public address`));
            } else {
                cb(null, ok[0], servers);
            }
        });
        return () => r.cancel();
    };
}

/* A connection to host:port within connectMs: a network the uplink has
 * left answers neither the lookup nor the connection. A timer of its own:
 * Node 8's socket timeout can fire at up to twice its time on a socket that
 * has not connected yet. Through job.proxy (the updater's proxy setting,
 * tunnel.js) when there is one, which looks host up itself: a name the
 * lease's servers give only addresses that are not public is refused all
 * the same, one they cannot look up is left to the proxy. Else to host's
 * address from lookup. cb(err, sock) once; the function returned stops
 * waiting and closes a connection still opening. */
function connectTo(job, lookup, connectMs, host, port, cb) {
    let done = false;
    let sock = null;
    let proxy = null;
    const finish = (err, s) => {
        if (!done) {
            done = true;
            clearTimeout(timer);
            cb(err, s);
        }
    };
    const timer = setTimeout(() => {
        const why = `no connection in ${Math.round(connectMs / 1000)} s`;
        finish(new Error(proxy ? tunnel.failure(proxy, why).message : `${host}: ${why}`));
        cancel();
        if (sock) {
            sock.destroy();
        }
    }, connectMs);
    const cancel = lookup(host, (err, ip, servers) => {
        if (done) {
            return;
        }
        if (err && (err.refused || !job.proxy)) {
            finish(err);
        } else if (!job.proxy) {
            sock = net.connect(port, ip);
            sock.once('connect', () => finish(null, sock));
            sock.once('error', finish);
        } else {
            try {
                proxy = tunnel.parse(job.proxy);
            } catch (e) {
                finish(new Error(`proxy setting: ${e.message}`));
                return;
            }
            // the tunnel leaves the socket paused; its reader here is the caller's, attached at once
            sock = tunnel.open(proxy, host, port, lookupVia(servers), (e, s) => finish(e, s && s.resume()));
        }
    });
    return () => {
        const opening = !done;
        done = true;
        clearTimeout(timer);
        cancel();
        if (opening && sock) {
            sock.destroy();
        }
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
    const lookup = resolver(job);
    const connectMs = job.connectMs || CONNECT_MS;
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
        let refused = false;
        const refuse = (code, text) => {
            if (refused) {
                return;
            }
            refused = true;
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
        const stop = connectTo(job, lookup, connectMs, target.hostname, Number(target.port) || 80, (err, sock) => {
            if (err) {
                refuse(502, err.message);
                return;
            }
            const headers = Object.assign({}, req.headers);
            delete headers['proxy-authorization'];
            delete headers['proxy-connection'];
            headers.host = target.host;
            // one request a connection: nothing reuses the upstream socket, so it closes with the answer
            headers.connection = 'close';
            const up = http.request({ method: req.method, path: target.pathname + target.search, headers, createConnection: () => sock }, (r) => {
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
        res.on('close', stop);
    });
    server.on('connect', (req, socket, head) => {
        // the client's socket from now on is ours, errors too (a reset while the name resolves)
        let up = null;
        let stop = () => {};
        socket.on('error', () => {
            socket.destroy();
            if (up) {
                up.destroy();
            }
        });
        socket.on('close', () => stop());
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
        stop = connectTo(job, lookup, connectMs, m[1], Number(m[2]), (err, s) => {
            if (err) {
                refuse(502, err.message);
                return;
            }
            up = s;
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
            [up, socket].forEach((x) => x.setTimeout(idleMs, () => {
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
