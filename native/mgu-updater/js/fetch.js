'use strict';
/**
 * One HTTPS download, or a set of them, run by the updater as a child
 * process under the fetch uid (uids.js): the only identity the apps-only
 * uplink lets out, and one that can write nothing but its download folder.
 * Node 8.
 *
 * stdin: one JSON job
 *   { url, headers, dest, maxBytes, dns: ["1.2.3.4", ...], lease, ca, method, body, keep,
 *     connectMs, idleMs, retryMs, proxy, immutable, fresh, files, parallel }
 *   files: GETs of several files, [{ url, dest, maxBytes }, ...], each
 *   with the job's other settings, at most parallel (4) at a time over
 *   connections kept open for the next file of the same host. Each file's
 *   events carry its index as file; after its done the next starts. A
 *   file's error ends the job with that error (and its file); { done: true }
 *   ends it once every file is done.
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
 *   retryMs: the first wait before trying again (1 s). proxy: the updater's
 *   proxy setting (tunnel.js); every connection, a redirect's too, goes
 *   through it, dns then looks up only the proxy's own name, and its
 *   connection and answer count in connectMs. immutable: the URL's bytes
 *   never change (a file at a commit) and the caller checks them, so a cut
 *   download goes on from where it stopped even without a validator.
 *   fresh: never go on from a cut, each try starts over.
 * stdout: one JSON line per event
 *   { progress: <bytes>, total: <bytes|null> }  while downloading
 *   { done: true, bytes, status, headers, resumed }  dest complete (headers: those kept;
 *                                               resumed: part of it came from a later try)
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
 * after 1, 2, 4 and 8 s: up to 4 times in a row without getting the file
 * further than it has been; a try that does starts the count and the wait over, so a slow,
 * flaky link goes on for as long as the file grows. When the server takes
 * byte ranges (Accept-Ranges: bytes), the next try asks for the rest
 * (Range) and appends it: with the answer's strong ETag, else its
 * Last-Modified, in If-Range; with neither, only for an immutable job. A
 * try that gets no answer leaves the next to ask for the same rest. A
 * server that answers with the whole file instead, or the rest in another
 * Content-Encoding, starts it over, and a server that takes no ranges
 * (codeload.github.com's archives) has each try start over; those tries
 * count as not getting further. The size and sha256
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
 * roots are Node's own, or ca's. Through a proxy TLS runs inside its
 * tunnel, to the origin, with the same checks; the proxy is sent only its
 * own user name and password.
 */
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const tls = require('tls');
const https = require('https');
const { URL } = require('url');
const certs = require('./certs');
const tunnel = require('./tunnel');

const MAX_REDIRECTS = 5;
// a network that has moved on leaves a connection silent, never reset: these bound each wait
const CONNECT_MS = 15000;
const IDLE_MS = 30000;
const RETRIES = 4;             // tries in a row that get no further, after the first
const RETRY_MS = 1000;         // the wait before the first of them, doubled for each after
const RETRY_STATUS = [500, 502, 503, 504];
const PARALLEL = 4;          // a set's files under way at once
const NO_SUCH_NAME = ['ENOTFOUND', 'ENODATA'];
const DATE_ERRORS = ['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED'];

function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

/* An event of job's: of its file, in a set of files. */
function tell(job, obj) {
    emit(job.file === undefined ? obj : Object.assign({ file: job.file }, obj));
}

/* Connections for a job's requests, kept open for the next request to the
 * same host. Each is made by connect() with the dns the job's try set last;
 * its failure carries connectFailed. Node 8 counts a connection only once
 * it is made, so the job itself bounds how many requests run at once. */
class Connections extends https.Agent {
    constructor(job) {
        super({ keepAlive: true });
        this.job = job;
        this.dns = job.dns;
    }

    createConnection(options, cb) {
        connect(Object.assign({}, this.job, { dns: this.dns }), { hostname: options.host, port: options.port }, (err, sock) => {
            cb(err ? Object.assign(err, { connectFailed: true }) : null, sock);
        });
    }
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

/* A TLS connection to target whose certificate checks out (dates aside), or
 * an error; through job.proxy's tunnel when there is one, the proxy's own
 * connection and its answer counted in connectMs. */
function connect(job, target, cb) {
    let done = false;
    let sock = null;        // the connection under way: to the proxy, then TLS
    let proxy = null;       // the proxy, while its tunnel is not open yet
    const finish = (err, s) => {
        if (!done) {
            done = true;
            clearTimeout(timer);
            cb(err, s);
        }
    };
    const host = target.hostname;
    const port = Number(target.port) || 443;
    const connectMs = job.connectMs || CONNECT_MS;
    // a timer of its own: Node 8's socket timeout can fire at up to twice its time
    const timer = setTimeout(() => {
        const why = `no connection in ${Math.round(connectMs / 1000)} s`;
        finish(proxy ? tunnel.failure(proxy, why) : new Error(why));
        if (sock) {
            sock.destroy();
        }
    }, connectMs);
    const secure = (opts) => {
        sock = tls.connect(Object.assign({
            host,
            port,
            servername: net.isIP(host) ? undefined : host,
            ca: job.ca || undefined,
            rejectUnauthorized: false
        }, opts), () => {
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
    };
    if (!job.proxy) {
        secure({ lookup: lookupVia(job.dns) });
        return;
    }
    try {
        proxy = tunnel.parse(job.proxy);
    } catch (e) {
        finish(Object.assign(new Error(`proxy setting: ${e.message}`), { proxy: true, refused: true }));
        return;
    }
    sock = tunnel.open(proxy, host, port, lookupVia(job.dns), (err, raw) => {
        if (err) {
            finish(err);
            return;
        }
        proxy = null;
        secure({ socket: raw });
    });
}

function get(job, url, headers, hops, from, validator, finish) {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
        finish({ error: `refusing ${target.protocol} URL` });
        return;
    }
    request(job, url, target, headers, hops, from, validator, finish);
}

/* What lets a cut download ask for the rest, when the response says it
 * takes byte ranges: { ifRange: its strong ETag, else its Last-Modified,
 * else (an immutable job's) null; encoding: its Content-Encoding }. null
 * when it cannot go on. */
function validatorOf(job, res) {
    if (job.fresh || res.headers['accept-ranges'] !== 'bytes') {
        return null;
    }
    const etag = res.headers.etag;
    const ifRange = etag && !/^W\//.test(etag) ? etag : res.headers['last-modified'] || null;
    return ifRange || job.immutable ? { ifRange, encoding: res.headers['content-encoding'] || '' } : null;
}

function request(job, url, target, headers, hops, from, validator, settle) {
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
        agent: job.agent
    }, (res) => {
        wait();
        if (!post && [301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
            res.resume();
            clearTimeout(timer);
            stop = () => {};   // the next host's request answers from here
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
            get(job, new URL(res.headers.location, url).toString(), along, hops + 1, from, validator, settle);
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
            // the rest of the same bytes: a gzipped answer's ranges are of its gzipped bytes
            if (!range || Number(range[1]) !== from || Number(range[2]) + 1 !== Number(range[3]) ||
                (res.headers['content-encoding'] || '') !== validator.encoding) {
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
        const resumeWith = partial ? validator : validatorOf(job, res);
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
                tell(job, { progress: bytes, total });
            }
        });
        // Node before 8.10 (the 2019 MGU's 8.9.4) also says aborted when the connection
        // closes after the whole answer while the file has not taken all of it yet
        res.on('aborted', () => {
            if (!res.complete) {
                stop({ error: 'connection closed mid-download', retry: true });
            }
        });
        res.pipe(out);
        out.on('close', () => {
            if (!failure && total !== null && bytes !== total) {
                failure = { error: 'connection closed mid-download', retry: true };
            }
            if (failure) {
                finish(Object.assign(failure, failure.retry ? (resumeWith ? { resumeWith } : { restart: true }) : {}));
            } else {
                finish(Object.assign({ done: true, bytes, status: res.statusCode, headers: kept(job, res) }, partial ? { resumed: true } : {}));
            }
        });
        out.on('error', (err) => {
            failure = failure || { error: `cannot write ${job.dest}: ${err.message}` };
            res.unpipe(out);
            req.abort();
            finish(failure);
        });
    });
    req.on('error', (err) => {
        if (!err.connectFailed) {
            lost(`${host}: ${err.code || err.message}`);
            return;
        }
        // a proxy's error names the proxy
        finish({ error: err.proxy ? err.message : `${host}: ${err.code || err.message}`,
            retry: !err.refused && NO_SUCH_NAME.indexOf(err.code) < 0 });
    });
    // the connection has connectMs of its own
    req.on('socket', wait);
    req.end(body || undefined);
}

/* job, tried again while the connection fails, from where the last try
 * stopped when the server takes byte ranges; end(result) once. */
function download(job, end) {
    const retryMs = job.retryMs || RETRY_MS;
    let tries = 0;
    let misses = 0;
    let from = 0;
    let best = 0;      // the furthest the file has got: a try gets further only past it
    let validator = null;
    const next = () => {
        tries++;
        const headers = Object.assign({}, job.headers || {});
        if (from > 0) {
            // what came before the cut is the answer to a conditional request
            delete headers['If-None-Match'];
            delete headers['If-Modified-Since'];
            headers.Range = `bytes=${from}-`;
            if (validator.ifRange) {
                headers['If-Range'] = validator.ifRange;
            }
        }
        let settled = false;
        const tried = (r) => {
            if (settled) {
                return;
            }
            settled = true;
            if (!r.retry || job.method === 'POST') {
                finishAll(r);
                return;
            }
            // a try that got no body leaves the next to ask for the same range
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
            misses = from > best ? 0 : misses + 1;
            best = Math.max(best, from);
            if (misses > RETRIES) {
                finishAll(r);
                return;
            }
            const after = retryMs * Math.pow(2, Math.max(0, misses - 1));
            tell(job, { retry: tries, error: r.error, from, after });
            setTimeout(next, after);
        };
        // the network's servers now: a network joined since the job started has its own
        const dns = job.lease ? leaseDns(job.lease) : job.dns;
        if (!dns) {
            tried({ error: 'no internet (the uplink is down)', retry: true });
            return;
        }
        job.agent.dns = dns;
        get(job, job.url, headers, 0, from, from > 0 ? validator : null, tried);
    };
    const finishAll = (r) => {
        delete r.retry;
        delete r.resumeWith;
        delete r.restart;
        if (r.error && tries > 1) {
            r.error += ` (${tries} tries)`;
        }
        end(r);
    };
    next();
}

/* job's files, at most job.parallel at a time; end(result) once: the first
 * file's error, else { done: true }. */
function downloadAll(job, end) {
    const files = job.files;
    let next = 0;
    let left = files.length;
    let over = !left;
    const one = () => {
        if (over || next >= files.length) {
            return;
        }
        const i = next++;
        download(Object.assign({}, job, files[i], { file: i, files: undefined }), (r) => {
            if (over) {
                return;
            }
            if (r.error) {
                over = true;
                end(Object.assign({ file: i }, r));
                return;
            }
            tell({ file: i }, r);
            left -= 1;
            if (!left) {
                over = true;
                end({ done: true });
                return;
            }
            // the connection is free for the next file once the answer has ended
            setImmediate(one);
        });
    };
    if (over) {
        end({ done: true });
    }
    for (let k = 0; k < Math.max(1, Math.min(job.parallel || PARALLEL, files.length)); k++) {
        one();
    }
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

module.exports = { leaseDns, lookupVia, CONNECT_MS };

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
        job.agent = new Connections(job);
        // a name lookup still under way would keep the process, and the updater waiting, for minutes
        (job.files ? downloadAll : download)(job, (r) => process.stdout.write(JSON.stringify(r) + '\n', () => process.exit(r.error ? 1 : 0)));
    });
}
