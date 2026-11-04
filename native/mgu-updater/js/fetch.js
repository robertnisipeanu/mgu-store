'use strict';
/**
 * One HTTPS download, run by the updater as a child process under the
 * fetch uid (uids.js): the only identity the apps-only
 * uplink lets out, and one that can write nothing but its download folder.
 * Node 8.
 *
 * stdin: one JSON job
 *   { url, headers, dest, maxBytes, dns: ["1.2.3.4", ...], lease, ca, method, body, keep,
 *     connectMs, idleMs, retryMs }
 *   dns: resolve host names through these servers (the uplink lease's);
 *   empty: the system resolver. lease: the uplink's lease file, read again
 *   for each try: its dns servers replace dns, and a try without one fails
 *   as having no connection (the uplink is down, or between networks). ca:
 *   PEM roots to trust instead of Node's bundled ones (a self-hosted catalog
 *   with its own CA). method: GET (default) or POST, with body (a string)
 *   sent as it is. keep: the response headers (lower case) to report with
 *   done. connectMs: how long the name lookup, the TCP connection and the
 *   TLS handshake may take together (15 s); idleMs: how long the answer's
 *   headers, and then each part of its body, may take to come (30 s);
 *   retryMs: the first wait before trying again (1 s).
 * stdout: one JSON line per event
 *   { progress: <bytes>, total: <bytes|null> }  while downloading
 *   { done: true, bytes, status, headers }      dest complete (headers: those kept)
 *   { notModified: true, status: 304, headers } a conditional request's answer:
 *                                               unchanged, nothing at dest
 *   { retry: <try>, error, from, after }        try <try> failed with error; the next
 *                                               starts in <after> ms, at byte <from>
 *   { certDates: "<host>", error: "<code>" }   host's certificate checked out but
 *                                               for its dates (CERT_NOT_YET_VALID,
 *                                               CERT_HAS_EXPIRED), which were ignored
 *   { error: "<reason>", status, rateLimited, tooBig }  nothing usable at dest
 *                                               (status: the HTTP answer, if any;
 *                                               rateLimited: a 429, or a 403 with
 *                                               x-ratelimit-remaining 0 or retry-after)
 * Exactly one of done, notModified and error ends the output.
 *
 * A GET whose connection fails (cut mid-download, no data for idleMs, a
 * reset, no connection within connectMs) or that gets a 500, 502, 503 or 504 is tried again,
 * after 1, 2, 4 and 8 s: up to 4 times in a row without getting further, 200
 * tries in all. When the server takes byte ranges (Accept-Ranges: bytes,
 * with a strong ETag), the next try asks for the rest (Range, with that
 * ETag in If-Range) and appends it; a try that gets no answer leaves the
 * next to ask for the same rest. A server that answers with the whole file
 * instead starts it over. The size and sha256
 * the source states are checked on the whole file by the updater. A POST,
 * a refused certificate, a name the DNS server does not know, any other
 * HTTP answer and a size over maxBytes are not tried again.
 *
 * Redirects of a GET are followed (up to 5, https only); the request headers
 * go to the first host only, so a token never reaches a redirect target such
 * as GitHub's asset storage: only User-Agent, If-None-Match,
 * If-Modified-Since, Range and If-Range go along. A POST is not redirected.
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
// a network that has moved on leaves a connection silent, never reset: these bound each wait
const CONNECT_MS = 15000;
const IDLE_MS = 30000;
const RETRIES = 4;             // tries in a row that get no further, after the first
const RETRY_MS = 1000;         // the wait before the first of them, doubled for each after
const MAX_TRIES = 200;
const RETRY_STATUS = [500, 502, 503, 504];
const NO_SUCH_NAME = ['ENOTFOUND', 'ENODATA'];
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
            clearTimeout(timer);
            cb(err, sock);
        }
    };
    const host = target.hostname;
    const connectMs = job.connectMs || CONNECT_MS;
    // a timer of its own: Node 8's socket timeout can fire at up to twice its time
    const timer = setTimeout(() => sock.destroy(new Error(`no connection in ${Math.round(connectMs / 1000)} s`)), connectMs);
    const sock = tls.connect({
        host,
        port: Number(target.port) || 443,
        servername: net.isIP(host) ? undefined : host,
        lookup: lookupVia(job.dns),
        ca: job.ca || undefined,
        rejectUnauthorized: false
    }, () => {
        if (sock.authorized) {
            finish(null, sock);
            return;
        }
        const code = sock.authorizationError;
        const why = DATE_ERRORS.indexOf(code) < 0 ? code : refusedButForDates(sock, host, job.ca);
        if (why) {
            sock.destroy();
            finish(Object.assign(new Error(why === code ? code : `${code}, and ${why}`), { refused: true }));
            return;
        }
        emit({ certDates: host, error: code });
        finish(null, sock);
    });
    sock.on('error', finish);
}

function get(job, url, headers, hops, from, finish) {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
        finish({ error: `refusing ${target.protocol} URL` });
        return;
    }
    connect(job, target, (err, sock) => {
        if (err) {
            finish({ error: `${target.hostname}: ${err.code || err.message}`, retry: !err.refused && NO_SUCH_NAME.indexOf(err.code) < 0 });
            return;
        }
        request(job, url, target, headers, hops, sock, from, finish);
    });
}

/* What lets a cut download ask for the rest: the response's strong ETag, when
 * it says it takes byte ranges; null otherwise. */
function validatorOf(res) {
    const etag = res.headers.etag;
    return res.headers['accept-ranges'] === 'bytes' && etag && !/^W\//.test(etag) ? etag : null;
}

function request(job, url, target, headers, hops, sock, from, settle) {
    const host = target.hostname;
    const post = hops === 0 && job.method === 'POST';
    const body = post ? Buffer.from(String(job.body || '')) : null;
    let stop = null;   // ends the body under way, once there is one
    const lost = (why) => (stop ? stop({ error: why, retry: true }) : finish({ error: why, retry: true }));
    // the headers, then each part of the body, within idleMs
    const idleMs = job.idleMs || IDLE_MS;
    let timer = null;
    const finish = (r) => {
        clearTimeout(timer);
        settle(r);
    };
    const wait = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            lost(`${host}: no data for ${Math.round(idleMs / 1000)} s`);
            req.abort();
        }, idleMs);
    };
    const req = https.request({
        method: post ? 'POST' : 'GET',
        hostname: host,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers: post ? Object.assign({}, headers, { 'Content-Length': body.length }) : headers,
        createConnection: () => sock
    }, (res) => {
        wait();
        if (!post && [301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
            res.resume();
            clearTimeout(timer);
            stop = () => {};   // the next host's request answers from here
            sock.destroy();
            if (hops >= MAX_REDIRECTS) {
                finish({ error: 'too many redirects' });
                return;
            }
            // first-host headers stay behind; only a user agent, a conditional request's
            // validators and a resume's range go along (a release asset's ETag is its storage host's)
            const along = {};
            ['User-Agent', 'If-None-Match', 'If-Modified-Since', 'Range', 'If-Range'].forEach((h) => {
                if (headers[h] !== undefined) {
                    along[h] = headers[h];
                }
            });
            get(job, new URL(res.headers.location, url).toString(), along, hops + 1, from, settle);
            return;
        }
        if (res.statusCode === 304) {
            res.resume();
            finish({ notModified: true, status: 304, headers: kept(job, res) });
            return;
        }
        const partial = from > 0 && res.statusCode === 206;
        if (res.statusCode !== 200 && !partial) {
            res.resume();
            const limited = res.statusCode === 429 || (res.statusCode === 403 &&
                (res.headers['x-ratelimit-remaining'] === '0' || res.headers['retry-after'] !== undefined));
            finish(Object.assign({ error: `HTTP ${res.statusCode} from ${host}`, status: res.statusCode,
                retry: RETRY_STATUS.indexOf(res.statusCode) >= 0 || (from > 0 && res.statusCode === 416),
                restart: res.statusCode === 416 },
            limited ? { rateLimited: true } : {}));
            return;
        }
        let total = Number(res.headers['content-length']) || null;
        let bytes = 0;
        if (partial) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers['content-range'] || '');
            if (!range || Number(range[1]) !== from || Number(range[2]) + 1 !== Number(range[3])) {
                res.resume();
                finish({ error: `${host}: not the rest of the file asked for`, retry: true, restart: true });
                return;
            }
            bytes = from;
            total = Number(range[3]);
        }
        if (job.maxBytes && total && total > job.maxBytes) {
            res.resume();
            finish({ error: `${total} bytes is more than the expected ${job.maxBytes}`, tooBig: true });
            return;
        }
        // a cut 206 asks again with the validator it was asked with
        const resumeWith = partial ? headers['If-Range'] : validatorOf(res);
        const out = fs.createWriteStream(job.dest, { mode: 0o600, flags: partial ? 'a' : 'w' });
        let failure = null;
        let last = 0;
        // what was written stays on disk for the next try to go on from
        stop = (r) => {
            if (!failure) {
                failure = r;
                res.unpipe(out);
                req.abort();
                out.end();
            }
        };
        res.on('data', (chunk) => {
            if (failure) {
                return;
            }
            wait();
            bytes += chunk.length;
            if (job.maxBytes && bytes > job.maxBytes) {
                stop({ error: `more than the expected ${job.maxBytes} bytes`, tooBig: true });
                return;
            }
            if (Date.now() - last > 250) {
                last = Date.now();
                emit({ progress: bytes, total });
            }
        });
        res.on('aborted', () => stop({ error: 'connection closed mid-download', retry: true }));
        res.pipe(out);
        out.on('close', () => {
            if (!failure && total !== null && bytes !== total) {
                failure = { error: 'connection closed mid-download', retry: true };
            }
            if (failure) {
                finish(Object.assign(failure, failure.retry ? (resumeWith ? { resumeWith } : { restart: true }) : {}));
            } else {
                finish({ done: true, bytes, status: res.statusCode, headers: kept(job, res) });
            }
        });
        out.on('error', (err) => {
            failure = failure || { error: `cannot write ${job.dest}: ${err.message}` };
            res.unpipe(out);
            req.abort();
            finish(failure);
        });
    });
    req.on('error', (err) => lost(`${host}: ${err.code || err.message}`));
    req.end(body || undefined);
    wait();
}

/* job, tried again while the connection fails, from where the last try
 * stopped when the server takes byte ranges; one result emitted. */
function download(job) {
    const retryMs = job.retryMs || RETRY_MS;
    let tries = 0;
    let misses = 0;
    let from = 0;
    let validator = null;
    const next = () => {
        tries++;
        const headers = Object.assign({}, job.headers || {});
        if (from > 0) {
            // what came before the cut is the answer to a conditional request
            delete headers['If-None-Match'];
            delete headers['If-Modified-Since'];
            headers.Range = `bytes=${from}-`;
            headers['If-Range'] = validator;
        }
        let settled = false;
        const tried = (r) => {
            if (settled) {
                return;
            }
            settled = true;
            if (!r.retry || job.method === 'POST' || tries >= MAX_TRIES) {
                finishAll(r);
                return;
            }
            // a try that got no body leaves the next to ask for the same range
            const was = from;
            if (r.resumeWith) {
                try {
                    from = fs.statSync(job.dest).size;
                    validator = r.resumeWith;
                } catch (e) {
                    from = 0;
                }
            } else if (r.restart) {
                from = 0;
            }
            misses = from > was ? 0 : misses + 1;
            if (misses > RETRIES) {
                finishAll(r);
                return;
            }
            const after = retryMs * Math.pow(2, Math.max(0, misses - 1));
            emit({ retry: tries, error: r.error, from, after });
            setTimeout(next, after);
        };
        // the network's servers now: a network joined since the job started has its own
        const dns = job.lease ? leaseDns(job.lease) : job.dns;
        if (!dns) {
            tried({ error: 'no internet (the uplink is down)', retry: true });
            return;
        }
        get(Object.assign({}, job, { dns }), job.url, headers, 0, from, tried);
    };
    const finishAll = (r) => {
        delete r.retry;
        delete r.resumeWith;
        delete r.restart;
        if (r.error && tries > 1) {
            r.error += ` (${tries} tries)`;
        }
        // a name lookup still under way would keep the process, and the updater waiting, for minutes
        process.stdout.write(JSON.stringify(r) + '\n', () => process.exit(r.error ? 1 : 0));
    };
    next();
}

/* The dns servers of the lease file at file; null without a lease. */
function leaseDns(file) {
    try {
        const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(lease.dns) ? lease.dns : [];
    } catch (e) {
        return null;
    }
}

module.exports = { leaseDns, CONNECT_MS };

if (require.main === module) {
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
        download(job);
    });
}
