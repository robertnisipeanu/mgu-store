'use strict';
/**
 * One HTTPS download, run by the updater as a child process under the
 * fetch uid (uids.js): the only identity the apps-only
 * uplink lets out, and one that can write nothing but its download folder.
 * Node 8.
 *
 * stdin: one JSON job
 *   { url, headers, dest, maxBytes, dns: ["1.2.3.4", ...], ca, method, body, keep }
 *   dns: resolve host names through these servers (the uplink lease's);
 *   empty: the system resolver. ca: PEM roots to trust instead of Node's
 *   bundled ones (a self-hosted catalog with its own CA). method: GET
 *   (default) or POST, with body (a string) sent as it is. keep: the
 *   response headers (lower case) to report with done.
 * stdout: one JSON line per event
 *   { progress: <bytes>, total: <bytes|null> }  while downloading
 *   { done: true, bytes, status, headers }      dest complete (headers: those kept)
 *   { notModified: true, status: 304, headers } a conditional request's answer:
 *                                               unchanged, nothing at dest
 *   { certDates: "<host>", error: "<code>" }   host's certificate checked out but
 *                                               for its dates (CERT_NOT_YET_VALID,
 *                                               CERT_HAS_EXPIRED), which were ignored
 *   { error: "<reason>", status, rateLimited, tooBig }  nothing usable at dest
 *                                               (status: the HTTP answer, if any;
 *                                               rateLimited: a 429, or a 403 with
 *                                               x-ratelimit-remaining 0 or retry-after)
 *
 * Redirects of a GET are followed (up to 5, https only); the request headers
 * go to the first host only, so a token never reaches a redirect target such
 * as GitHub's asset storage: only User-Agent, If-None-Match and
 * If-Modified-Since go along. A POST is not redirected.
 *
 * Certificates: the head unit's clock may be days off, so a certificate's
 * validity dates are not held against it. Node checks each connection as
 * usual; when its only complaint can be the dates, the presented chain is
 * checked again without them (certs.js: every signature up to a trusted
 * root, CA constraints, key usages) and the host name with
 * tls.checkServerIdentity. Nothing is sent before that passes. The trusted
 * roots are Node's own, or ca's.
 */
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const tls = require('tls');
const https = require('https');
const { URL } = require('url');
const certs = require('./certs');

const MAX_REDIRECTS = 5;
const IDLE_MS = 30000;
const DATE_ERRORS = ['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED'];

function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

function lookupVia(servers) {
    if (!servers || !servers.length) {
        return undefined;
    }
    const resolver = new dns.Resolver();
    resolver.setServers(servers);
    return (hostname, options, cb) => {
        if (typeof options === 'function') {
            cb = options;
        }
        resolver.resolve4(hostname, (err, addrs) => {
            if (err || !addrs.length) {
                cb(err || new Error(`no address for ${hostname}`));
                return;
            }
            cb(null, addrs[0], 4);
        });
    };
}

/* The response headers job.keep names. */
function kept(job, res) {
    const out = {};
    (job.keep || []).forEach((h) => {
        if (typeof res.headers[h] === 'string') {
            out[h] = res.headers[h];
        }
    });
    return out;
}

/* Why sock's certificate is refused once its dates are left out; null if it is not. */
function refusedButForDates(sock, host, ca) {
    const peer = sock.getPeerCertificate(true);
    const chain = [];
    for (let c = peer; c && c.raw && !chain.some((d) => d.equals(c.raw)); c = c.issuerCertificate) {
        chain.push(c.raw);
    }
    const why = certs.verifyChain(chain, ca ? certs.pemCerts(ca) : certs.nodeRoots());
    if (why) {
        return why;
    }
    const name = tls.checkServerIdentity(host, peer);
    return name ? name.message : null;
}

/* A TLS connection to target whose certificate checks out (dates aside), or an error. */
function connect(job, target, cb) {
    let done = false;
    const finish = (err, sock) => {
        if (!done) {
            done = true;
            cb(err, sock);
        }
    };
    const host = target.hostname;
    const sock = tls.connect({
        host,
        port: Number(target.port) || 443,
        servername: net.isIP(host) ? undefined : host,
        lookup: lookupVia(job.dns),
        ca: job.ca || undefined,
        rejectUnauthorized: false
    }, () => {
        sock.setTimeout(0);
        if (sock.authorized) {
            finish(null, sock);
            return;
        }
        const code = sock.authorizationError;
        const why = DATE_ERRORS.indexOf(code) < 0 ? code : refusedButForDates(sock, host, job.ca);
        if (why) {
            sock.destroy();
            finish(new Error(why === code ? code : `${code}, and ${why}`));
            return;
        }
        emit({ certDates: host, error: code });
        finish(null, sock);
    });
    sock.setTimeout(IDLE_MS, () => sock.destroy(new Error('ETIMEDOUT')));
    sock.on('error', finish);
}

function get(job, url, headers, hops) {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
        emit({ error: `refusing ${target.protocol} URL` });
        process.exitCode = 1;
        return;
    }
    connect(job, target, (err, sock) => {
        if (err) {
            emit({ error: `${target.hostname}: ${err.code || err.message}` });
            process.exitCode = 1;
            return;
        }
        request(job, url, target, headers, hops, sock);
    });
}

function request(job, url, target, headers, hops, sock) {
    const post = hops === 0 && job.method === 'POST';
    const body = post ? Buffer.from(String(job.body || '')) : null;
    const req = https.request({
        method: post ? 'POST' : 'GET',
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers: post ? Object.assign({}, headers, { 'Content-Length': body.length }) : headers,
        createConnection: () => sock
    }, (res) => {
        if (!post && [301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
            res.resume();
            if (hops >= MAX_REDIRECTS) {
                emit({ error: 'too many redirects' });
                process.exitCode = 1;
                return;
            }
            // first-host headers stay behind; only a user agent and a conditional request's
            // validators go along (a release asset's ETag is its storage host's)
            const along = {};
            ['User-Agent', 'If-None-Match', 'If-Modified-Since'].forEach((h) => {
                if (headers[h] !== undefined) {
                    along[h] = headers[h];
                }
            });
            get(job, new URL(res.headers.location, url).toString(), along, hops + 1);
            return;
        }
        if (res.statusCode === 304) {
            res.resume();
            emit({ notModified: true, status: 304, headers: kept(job, res) });
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            const limited = res.statusCode === 429 || (res.statusCode === 403 &&
                (res.headers['x-ratelimit-remaining'] === '0' || res.headers['retry-after'] !== undefined));
            emit(Object.assign({ error: `HTTP ${res.statusCode} from ${target.hostname}`, status: res.statusCode },
                limited ? { rateLimited: true } : {}));
            process.exitCode = 1;
            return;
        }
        const total = Number(res.headers['content-length']) || null;
        if (job.maxBytes && total && total > job.maxBytes) {
            res.resume();
            emit({ error: `${total} bytes is more than the expected ${job.maxBytes}`, tooBig: true });
            process.exitCode = 1;
            return;
        }
        const out = fs.createWriteStream(job.dest, { mode: 0o600 });
        let bytes = 0;
        let last = 0;
        res.on('data', (chunk) => {
            bytes += chunk.length;
            if (job.maxBytes && bytes > job.maxBytes) {
                res.destroy();
                out.destroy();
                emit({ error: `more than the expected ${job.maxBytes} bytes`, tooBig: true });
                process.exitCode = 1;
                return;
            }
            if (Date.now() - last > 250) {
                last = Date.now();
                emit({ progress: bytes, total });
            }
        });
        res.on('aborted', () => {
            out.destroy();
            emit({ error: 'connection closed mid-download' });
            process.exitCode = 1;
        });
        res.pipe(out);
        out.on('finish', () => {
            if (!process.exitCode) {
                emit({ done: true, bytes, status: res.statusCode, headers: kept(job, res) });
            }
        });
        out.on('error', (err) => {
            emit({ error: `cannot write ${job.dest}: ${err.message}` });
            process.exitCode = 1;
        });
    });
    req.setTimeout(IDLE_MS, () => req.abort());
    req.on('error', (err) => {
        emit({ error: `${target.hostname}: ${err.code || err.message}` });
        process.exitCode = 1;
    });
    req.end(body || undefined);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
    let job;
    try {
        job = JSON.parse(input);
    } catch (e) {
        emit({ error: 'bad job' });
        process.exitCode = 2;
        return;
    }
    get(job, job.url, job.headers || {}, 0);
});
