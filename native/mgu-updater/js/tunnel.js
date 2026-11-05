'use strict';
/**
 * A connection to host:port through the proxy the updater's `proxy` setting
 * names (README.md, "Through a proxy"): http://[user:pass@]host[:port] asks it with
 * HTTP CONNECT, socks5://[user:pass@]host[:port] (or socks5h://) with SOCKS5.
 * The target's name goes to the proxy as it is, and the proxy looks it up
 * (socks5h). Only the proxy's own user name and password go to it;
 * what passes through the tunnel (TLS, the request's headers) is the
 * caller's. Errors name the proxy by host:port alone. Node 8.
 */
const net = require('net');
const { URL } = require('url');

const KINDS = { 'http:': 'http', 'socks5:': 'socks5', 'socks5h:': 'socks5' };
const DEFAULT_PORT = { http: 80, socks5: 1080 };
const HEAD_MAX = 8192;
const NET_ERRORS = { ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset', EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable', ETIMEDOUT: 'timed out', ENOTFOUND: 'name not found', EPIPE: 'connection closed' };
// SOCKS5 replies (RFC 1928 6)
const SOCKS_REPLIES = ['', 'general failure', 'not allowed by its rules', 'network unreachable', 'host unreachable',
    'connection refused', 'TTL expired', 'command not supported', 'address type not supported'];

/* The proxy text names: { kind, host, port, user, pass, label: "host:port" }.
 * Throws an Error saying what is wrong with it. */
function parse(text) {
    let u;
    try {
        // the URL parser would drop tabs and line breaks; a setting has none
        if (/[\s\x00-\x1f\x7f]/.test(String(text).trim())) {
            throw new Error('spaces');
        }
        u = new URL(String(text).trim());
    } catch (e) {
        throw new Error('not a proxy address (http://host:port or socks5://host:port)');
    }
    const kind = KINDS[u.protocol];
    if (!kind) {
        throw new Error('a proxy address starts with http:// or socks5://');
    }
    const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
    if (!host || /[\s/@]/.test(host)) {
        throw new Error('a proxy address names a host');
    }
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
        throw new Error('a proxy address is host and port only');
    }
    const port = u.port ? Number(u.port) : DEFAULT_PORT[kind];
    if (!(port > 0 && port < 65536)) {
        throw new Error('a proxy port is 1 to 65535');
    }
    let user;
    let pass;
    try {
        user = decodeURIComponent(u.username);
        pass = decodeURIComponent(u.password);
    } catch (e) {
        throw new Error('a % in a user name or password is written %25');
    }
    if (kind === 'socks5' && (Buffer.byteLength(user) > 255 || Buffer.byteLength(pass) > 255)) {
        throw new Error('a SOCKS5 user name or password is at most 255 bytes');
    }
    return { kind, host, port, user, pass, label: `${net.isIPv6(host) ? `[${host}]` : host}:${port}` };
}

/* The error of a proxy: "proxy <host:port>: <why>"; refused: not worth another try. */
function failure(proxy, why, refused) {
    return Object.assign(new Error(`proxy ${proxy.label}: ${why}`), { proxy: true, refused: !!refused });
}

/* A connection through proxy (parse's) to host:port: cb(err, sock) once,
 * sock connected to the target, its data not yet read. lookup: how the
 * proxy's own name is looked up (net.connect's). Returns the socket to the
 * proxy, for the caller's timer to destroy. */
function open(proxy, host, port, lookup, cb) {
    let done = false;
    const sock = net.connect({ host: proxy.host, port: proxy.port, lookup });
    const fail = (why, refused) => {
        if (!done) {
            done = true;
            sock.destroy();
            cb(failure(proxy, why, refused));
        }
    };
    const ready = () => {
        if (!done) {
            done = true;
            cb(null, sock);
        }
    };
    // past ready the caller's TLS (or pipe) owns the socket and hears its errors
    sock.on('error', (e) => fail(NET_ERRORS[e.code] || e.code || e.message));
    sock.on('close', () => fail('closed the connection'));
    sock.on('connect', () => (proxy.kind === 'http' ? viaHttp : viaSocks)(proxy, sock, host, port, fail, ready));
    return sock;
}

/* Reads sock's bytes until want(buf) returns how many make the answer
 * (0: not yet); then calls got(answer) with the socket paused and what
 * came after the answer put back. */
function readUntil(sock, want, max, fail, got) {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        const n = want(buf);
        if (!n) {
            if (buf.length > max) {
                sock.removeListener('data', onData);
                fail('answered with too much');
            }
            return;
        }
        sock.removeListener('data', onData);
        sock.pause();
        // what came after the answer is the target's first bytes, the caller's to read
        if (buf.length > n) {
            sock.unshift(buf.slice(n));
        }
        got(buf.slice(0, n));
    };
    sock.on('data', onData);
    sock.resume();
}

function viaHttp(proxy, sock, host, port, fail, ready) {
    const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
    const auth = proxy.user || proxy.pass ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64')}\r\n` : '';
    sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    readUntil(sock, (buf) => {
        const end = buf.indexOf('\r\n\r\n');
        return end < 0 ? 0 : end + 4;
    }, HEAD_MAX, fail, (head) => {
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'));
        const status = m ? Number(m[1]) : 0;
        if (status >= 200 && status < 300) {
            ready();
        } else if (!status) {
            fail('not an HTTP proxy');
        } else {
            // 407: its user name and password; 403, 405: it does not tunnel there; both stay so
            fail(`refused CONNECT (${status})`, [401, 403, 405, 407].indexOf(status) >= 0);
        }
    });
}

function viaSocks(proxy, sock, host, port, fail, ready) {
    const creds = !!(proxy.user || proxy.pass);
    sock.write(Buffer.from(creds ? [5, 2, 0, 2] : [5, 1, 0]));
    const step = (n, got) => readUntil(sock, (buf) => (buf.length >= n ? n : 0), n, fail, got);
    const connect = () => {
        // an IPv4 address as one, anything else as a name for the proxy to look up
        const name = Buffer.from(host);
        const addr = net.isIPv4(host) ? Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))])
            : Buffer.concat([Buffer.from([3, name.length]), name]);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
        // the reply's length depends on its address type
        readUntil(sock, (buf) => {
            if (buf.length < 5) {
                return 0;
            }
            const n = 6 + ({ 1: 4, 4: 16 }[buf[3]] || 1 + buf[4]);
            return buf.length >= n ? n : 0;
        }, 262, fail, (r) => {
            if (r[0] !== 5) {
                fail('not a SOCKS5 proxy');
            } else if (r[1] !== 0) {
                fail(`could not reach ${host}:${port}: ${SOCKS_REPLIES[r[1]] || `reply ${r[1]}`}`, r[1] === 2);
            } else {
                ready();
            }
        });
    };
    step(2, (m) => {
        if (m[0] !== 5) {
            fail('not a SOCKS5 proxy');
        } else if (m[1] === 0) {
            connect();
        } else if (m[1] === 2 && creds) {
            const u = Buffer.from(proxy.user);
            const p = Buffer.from(proxy.pass);
            sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
            step(2, (a) => (a[1] === 0 ? connect() : fail('refused the user name and password', true)));
        } else {
            fail(creds ? 'refused the user name and password' : 'asks for a user name and password', true);
        }
    });
}

module.exports = { parse, open, failure };
