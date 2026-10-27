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
 *   { error: "<reason>", status, rateLimited }  nothing usable at dest
 *                                               (status: the HTTP answer, if any;
 *                                               rateLimited: a 429, or a 403 with
 *                                               x-ratelimit-remaining 0 or retry-after)
 *
 * Redirects of a GET are followed (up to 5, https only); the request headers
 * go to the first host only, so a token never reaches a redirect target such
 * as GitHub's asset storage. A POST is not redirected.
 */
const fs = require('fs');
const dns = require('dns');
const https = require('https');
const { URL } = require('url');

const MAX_REDIRECTS = 5;
const IDLE_MS = 30000;

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

function get(job, url, headers, hops) {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
        emit({ error: `refusing ${target.protocol} URL` });
        process.exitCode = 1;
        return;
    }
    const post = hops === 0 && job.method === 'POST';
    const body = post ? Buffer.from(String(job.body || '')) : null;
    const req = https.request({
        method: post ? 'POST' : 'GET',
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers: post ? Object.assign({}, headers, { 'Content-Length': body.length }) : headers,
        lookup: lookupVia(job.dns),
        ca: job.ca || undefined
    }, (res) => {
        if (!post && [301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
            res.resume();
            if (hops >= MAX_REDIRECTS) {
                emit({ error: 'too many redirects' });
                process.exitCode = 1;
                return;
            }
            // first-host headers stay behind; only a user agent goes along
            get(job, new URL(res.headers.location, url).toString(),
                { 'User-Agent': headers['User-Agent'] }, hops + 1);
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
            emit({ error: `${total} bytes is more than the expected ${job.maxBytes}` });
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
                emit({ error: `more than the expected ${job.maxBytes} bytes` });
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
