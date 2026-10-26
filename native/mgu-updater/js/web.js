'use strict';
/**
 * The phone page: the updater's sources, components and logs, served by the
 * car to a phone on its hotspot (README.md, "Phone page"). Node 8.
 *
 * In the updater (root):
 *
 *   const web = require('./web');
 *   web.setEnabled(conf, enabled, log, onChange)
 *       Once at start with the persisted flag (false too: it removes a
 *       firewall rule an earlier run left), then on each {"op":"web"}.
 *       true: a new access token, the server (re)started, the firewall rule
 *       put in; false: the server stopped and the rule removed. log(line)
 *       logs; onChange() (optional) runs whenever state() changes. Returns a
 *       promise for the firewall work (it never rejects; errors go to state).
 *   web.state()      -> { enabled, urls, error }, for the state stream. urls:
 *                       the hotspot addresses being served
 *                       ("http://172.16.222.97:8470/"), without the token.
 *   web.accessUrls() -> the same URLs with "#t=<token>", for the Store's QR
 *                       code: the updater writes the hotspot one to the
 *                       Store's data folder (web-url). Every OAP app reads
 *                       the state stream and can reach 127.0.0.1:8470, so
 *                       the token is never in it.
 *   web.journal(unit, lines, cb) -> cb(err, text): `journalctl -u <unit> -n
 *                       <lines> --no-pager`, for the privileged `logs` op;
 *                       unit one of web.UNITS, lines clamped to 1..1000.
 *
 * Conf keys (defaults): web_uid (12996), web_gid (12202, tm_oap_app: the
 * group that may use the updater socket), web_port (8470), web_iface
 * (wlan_bridge), web_secret (/run/mgu-updater/web-secret), and the updater's
 * socket and log_file.
 *
 * The server is a child process, `node web.js serve`, as web_uid:web_gid,
 * with no other groups. It listens on 127.0.0.1 and on web_iface's IPv4
 * address while it has one, and exits when its stdin closes (the updater
 * went away). The token reaches it on stdin, never argv or env.
 *   stdin:  {"token","port","socket","secret","logFile","logUid"} first,
 *           then {"addr":"<ipv4>"|null} whenever web_iface's address changes
 *   stdout: {"listening":["127.0.0.1",...],"error":null|"<reason>"},
 *           {"log":"<line>"}
 *
 * The unit's firewall (table ip filter, loaded by firewalldz) drops what
 * its input chain does not accept, so while enabled one rule at the top of
 * that chain accepts web_port from web_iface, tagged with a comment.
 * Every setEnabled removes tagged rules first; the rule is checked every
 * 30 s and put back if a ruleset load (firewalldz at boot) removed it.
 * Replies leave through the output chain's established accept.
 *
 * HTTP: GET / is the page; /api/* needs "Authorization: Bearer <token>":
 *   GET  /api/state            the updater's last state
 *   GET  /api/logs?src=<s>     {text}; s: "updater" (log_file) or one of UNITS
 *   POST /api/op               {op,...}: one of OPS, sent to the updater with
 *                              the web secret; {ok:true} or {error}
 * A client with 10 wrong tokens in a minute gets 429 for the rest of it.
 *
 * Updater socket requests carry "rid"; the updater's direct reply to a
 * request (state, error or logs) carries the same rid.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const url = require('url');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');

const DEFAULTS = {
    web_uid: 12996,
    web_gid: 12202,
    web_port: 8470,
    web_iface: 'wlan_bridge',
    web_secret: '/run/mgu-updater/web-secret'
};
const NFT_COMMENT = 'mgu-updater-web';
const UNITS = ['mgu-updater', 'mgu-uplink', 'mgu-app-fallback'];
const POLL_MS = Number(process.env.MGU_WEB_POLL_MS || 5000);
const RULE_MS = Number(process.env.MGU_WEB_RULE_MS || 30000);
const RESTART_MS = Number(process.env.MGU_WEB_RESTART_MS || 5000);

/* ---- in the updater ------------------------------------------------------- */

let run = null;
let status = { enabled: false, urls: [], error: null };
let nftQueue = Promise.resolve();

function setting(conf, key) {
    return conf[key] !== undefined && conf[key] !== '' ? conf[key] : DEFAULTS[key];
}

function nft(args) {
    return new Promise((resolve, reject) => {
        cp.execFile('nft', args, { timeout: 15000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`nft ${args.join(' ')}: ${(stderr || err.message).trim()}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

/* Handles of the tagged rules in ip filter input; null without that chain. */
function ruleHandles() {
    return nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']).then((out) => out.split('\n')
        .filter((line) => line.indexOf(`comment "${NFT_COMMENT}"`) >= 0)
        .map((line) => /# handle (\d+)\s*$/.exec(line))
        .filter(Boolean)
        .map((m) => m[1]), () => null);
}

function removeRules() {
    return ruleHandles().then((hs) => (hs || []).reduce((p, h) =>
        p.then(() => nft(['delete', 'rule', 'ip', 'filter', 'input', 'handle', h])), Promise.resolve()));
}

function ensureRule(iface, port) {
    return ruleHandles().then((hs) => {
        if (!hs || hs.length) {
            return undefined; // no unit firewall here, or the rule is in
        }
        return nft(['insert', 'rule', 'ip', 'filter', 'input', 'iifname', `"${iface}"`,
            'tcp', 'dport', String(port), 'accept', 'comment', `"${NFT_COMMENT}"`]);
    });
}

/* Firewall changes one at a time, in the order asked. */
function queued(fn) {
    nftQueue = nftQueue.then(fn, fn);
    return nftQueue;
}

function ifaceAddr(name) {
    const list = module.exports._interfaces()[name] || [];
    const a = list.filter((x) => x.family === 'IPv4' && !x.internal)[0];
    return a ? a.address : null;
}

function update(r, patch) {
    if (r !== run) {
        return;
    }
    Object.assign(r, patch);
    const urls = r.listening.filter((a) => a !== '127.0.0.1').map((a) => `http://${a}:${r.port}/`);
    const next = { enabled: true, urls, error: r.serveError || r.ruleError || null };
    if (JSON.stringify(next) !== JSON.stringify(status)) {
        status = next;
        r.onChange();
    }
}

function send(r, msg) {
    if (r.child && r.child.stdin.writable) {
        r.child.stdin.write(JSON.stringify(msg) + '\n');
    }
}

function spawnChild(r) {
    const opts = { stdio: ['pipe', 'pipe', 'inherit'], cwd: '/', env: {} };
    if (process.getuid() === 0) {
        Object.assign(opts, { uid: r.uid, gid: r.gid });
    }
    const child = cp.spawn(process.execPath, [__filename, 'serve'], opts);
    r.child = child;
    child.stdin.on('error', () => { /* the child is gone: 'exit' follows */ });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            let msg;
            try {
                msg = JSON.parse(line);
            } catch (e) {
                continue;
            }
            if (msg.log !== undefined) {
                r.log(`web: ${msg.log}`);
            } else if (Array.isArray(msg.listening)) {
                update(r, { listening: msg.listening, serveError: msg.error || null });
            }
        }
    });
    const gone = (why) => {
        if (r.child !== child) {
            return;
        }
        r.child = null;
        if (r !== run) {
            return;
        }
        r.log(`web: the server stopped (${why}); starting it again`);
        update(r, { listening: [], serveError: `the server stopped (${why})` });
        r.restart = setTimeout(() => {
            if (r === run) {
                spawnChild(r);
            }
        }, RESTART_MS);
    };
    child.on('error', (err) => gone(err.message));
    child.on('exit', (code, signal) => gone(signal || `exit ${code}`));
    send(r, {
        token: r.token,
        port: r.port,
        socket: r.conf.socket,
        secret: setting(r.conf, 'web_secret'),
        logFile: r.conf.log_file || null,
        logUid: process.getuid()
    });
    send(r, { addr: r.addr });
}

function stop() {
    const r = run;
    run = null;
    if (!r) {
        return;
    }
    r.timers.forEach(clearInterval);
    clearTimeout(r.restart);
    if (r.child) {
        r.child.stdin.end();
        r.child.kill('SIGTERM');
    }
}

function setEnabled(conf, enabled, log, onChange) {
    stop();
    log = log || (() => {});
    const port = Number(setting(conf, 'web_port'));
    const iface = String(setting(conf, 'web_iface'));
    status = { enabled: !!enabled, urls: [], error: null };
    if (!enabled) {
        if (onChange) {
            onChange();
        }
        return queued(removeRules).catch((err) => log(`web: ${err.message}`));
    }
    const r = {
        conf,
        log,
        onChange: onChange || (() => {}),
        token: crypto.randomBytes(16).toString('hex'),
        uid: Number(setting(conf, 'web_uid')),
        gid: Number(setting(conf, 'web_gid')),
        port,
        iface,
        addr: null,
        child: null,
        restart: null,
        listening: [],
        serveError: null,
        ruleError: null,
        timers: []
    };
    run = r;
    r.onChange();
    if (!/^[A-Za-z0-9_.-]{1,15}$/.test(iface) || !(port > 0 && port < 65536)) {
        update(r, { ruleError: `web_iface ${iface} or web_port ${port} is not valid` });
        return Promise.resolve();
    }
    r.addr = ifaceAddr(iface);
    spawnChild(r);
    r.timers.push(setInterval(() => {
        const addr = ifaceAddr(iface);
        if (addr !== r.addr) {
            r.addr = addr;
            send(r, { addr });
        }
    }, POLL_MS));
    const rule = () => queued(() => (r === run ? ensureRule(iface, port) : undefined))
        .then(() => update(r, { ruleError: null }), (err) => {
            if (r.ruleError !== err.message) {
                r.log(`web: ${err.message}`);
            }
            update(r, { ruleError: err.message });
        });
    r.timers.push(setInterval(rule, RULE_MS));
    return queued(removeRules).catch((err) => log(`web: ${err.message}`)).then(rule);
}

function state() {
    return { enabled: status.enabled, urls: status.urls.slice(), error: status.error };
}

function accessUrls() {
    return run ? status.urls.map((u) => `${u}#t=${run.token}`) : [];
}

function journal(unit, lines, cb) {
    if (UNITS.indexOf(unit) < 0) {
        cb(new Error(`no journal for ${unit}`));
        return;
    }
    const n = Math.max(1, Math.min(1000, Math.floor(Number(lines)) || 300));
    cp.execFile('journalctl', ['-u', unit, '-n', String(n), '--no-pager'],
        { timeout: 15000, maxBuffer: 2 << 20 }, (err, stdout, stderr) => {
            if (err) {
                cb(new Error((stderr || err.message).trim()));
            } else {
                cb(null, stdout);
            }
        });
}

/* ---- the server (child) ---------------------------------------------------- */

const BODY_MAX = 16 * 1024;
const LOG_TAIL = 64 * 1024;
const FAIL_MAX = 10;
const FAIL_WINDOW_MS = 60000;
const RETRY_MS = 5000;
const ASK_MS = 20000;

/* Requests the page may send, each reduced to the fields it may carry; the
 * updater checks their values. */
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const OPS = {
    'source-add': (b) => {
        if (b.type === 'github' && str(b.repo, 256) && str(b.channel, 256)) {
            return { type: 'github', repo: b.repo, channel: b.channel };
        }
        if (b.type === 'https' && str(b.url, 2048)) {
            return { type: 'https', url: b.url };
        }
        return null;
    },
    'source-remove': (b) => (str(b.id, 256) ? { id: b.id } : null),
    'login-start': () => ({}),
    'login-cancel': () => ({}),
    'token-add': (b) => (str(b.token, 4096) && (b.label === undefined || str(b.label, 64)) ?
        Object.assign({ token: b.token.trim() }, b.label ? { label: b.label.trim() } : {}) : null),
    'token-remove': (b) => (str(b.id, 64) ? { id: b.id } : null)
};

function serve() {
    const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
    const say = (line) => emit({ log: line });
    let cfg = null;
    let tokenHash = null;
    const hash = (s) => crypto.createHash('sha256').update(s).digest();

    /* -- updater socket: one connection, state cached, replies by rid -- */
    let upd = null;
    let lastState = null;
    let rid = 0;
    const pending = new Map();
    const connectUpdater = () => {
        let buf = '';
        const sock = net.connect(cfg.socket);
        sock.setEncoding('utf8');
        sock.on('connect', () => { upd = sock; });
        sock.on('data', (d) => {
            buf += d;
            if (buf.length > (8 << 20)) {
                sock.destroy();
                return;
            }
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch (e) {
                    continue;
                }
                if (msg.type === 'state') {
                    lastState = msg;
                }
                const p = msg.rid !== undefined && pending.get(msg.rid);
                if (p) {
                    pending.delete(msg.rid);
                    clearTimeout(p.timer);
                    p.resolve(msg);
                }
            }
        });
        sock.on('error', () => { /* 'close' follows */ });
        sock.on('close', () => {
            upd = null;
            lastState = null;
            pending.forEach((p) => {
                clearTimeout(p.timer);
                p.reject(new Error('the updater went away'));
            });
            pending.clear();
            setTimeout(connectUpdater, 2000);
        });
    };
    const ask = (req) => new Promise((resolve, reject) => {
        if (!upd) {
            reject(new Error('the updater is not running'));
            return;
        }
        let secret;
        try {
            secret = fs.readFileSync(cfg.secret, 'utf8').trim();
        } catch (e) {
            reject(new Error('no web secret from the updater'));
            return;
        }
        const id = `w${++rid}`;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('the updater did not answer'));
        }, ASK_MS);
        pending.set(id, { resolve, reject, timer });
        upd.write(JSON.stringify(Object.assign({}, req, { secret, rid: id })) + '\n');
    });

    /* -- the updater's log file, root's own regular file only -- */
    const tail = (file, max) => {
        let fd;
        try {
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        } catch (e) {
            return '';
        }
        try {
            const st = fs.fstatSync(fd);
            if (!st.isFile() || st.uid !== cfg.logUid) {
                return '';
            }
            const n = Math.min(st.size, max);
            const b = Buffer.alloc(n);
            const got = n ? fs.readSync(fd, b, 0, n, st.size - n) : 0;
            return b.slice(0, got).toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    };
    const updaterLog = () => {
        if (!cfg.logFile) {
            return '';
        }
        const now = tail(cfg.logFile, LOG_TAIL);
        const before = now.length < LOG_TAIL ? tail(`${cfg.logFile}.1`, LOG_TAIL - now.length) : '';
        return before + now;
    };

    /* -- HTTP -- */
    const fails = new Map();
    const limited = (ip) => {
        const f = fails.get(ip);
        return !!f && Date.now() - f.since < FAIL_WINDOW_MS && f.n >= FAIL_MAX;
    };
    const failed = (ip) => {
        let f = fails.get(ip);
        if (!f || Date.now() - f.since >= FAIL_WINDOW_MS) {
            if (fails.size >= 1024) {
                fails.clear();
            }
            f = { n: 0, since: Date.now() };
            fails.set(ip, f);
        }
        f.n++;
    };
    const authorised = (req) => {
        const m = /^Bearer ([0-9a-f]{1,128})$/.exec(req.headers.authorization || '');
        return !!m && crypto.timingSafeEqual(hash(m[1]), tokenHash);
    };
    const pageCsp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${
        crypto.createHash('sha256').update(PAGE_SCRIPT).digest('base64')}'; connect-src 'self'; ` +
        "img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    const reply = (res, code, type, body, extra) => {
        res.writeHead(code, Object.assign({
            'Content-Type': type,
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer'
        }, extra || {}));
        res.end(body);
    };
    const json = (res, code, obj) => reply(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
    const readBody = (req, cb) => {
        let size = 0;
        const parts = [];
        let done = false;
        req.on('data', (c) => {
            size += c.length;
            if (size > BODY_MAX && !done) {
                done = true;
                cb(new Error('too large'));
                req.destroy();
                return;
            }
            parts.push(c);
        });
        req.on('end', () => {
            if (!done) {
                done = true;
                cb(null, Buffer.concat(parts).toString('utf8'));
            }
        });
    };

    const handle = (req, res) => {
        const u = url.parse(req.url, true);
        if (u.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
            reply(res, 200, 'text/html; charset=utf-8', PAGE, { 'Content-Security-Policy': pageCsp });
            return;
        }
        if (!/^\/api\/(state|logs|op)$/.test(u.pathname)) {
            json(res, 404, { error: 'not found' });
            return;
        }
        const ip = req.socket.remoteAddress;
        if (limited(ip)) {
            json(res, 429, { error: 'too many attempts' });
            return;
        }
        if (!authorised(req)) {
            if (req.headers.authorization) {
                failed(ip); // a wrong token; a request without one guesses nothing
            }
            json(res, 401, { error: 'scan the code in the Store' });
            return;
        }
        const fail = (err) => json(res, 502, { error: err.message });
        if (u.pathname === '/api/state' && req.method === 'GET') {
            if (lastState) {
                json(res, 200, lastState);
            } else {
                json(res, 503, { error: 'the updater is not running' });
            }
        } else if (u.pathname === '/api/logs' && req.method === 'GET') {
            const src = String(u.query.src || '');
            if (src === 'updater') {
                json(res, 200, { text: updaterLog() });
            } else if (UNITS.indexOf(src) >= 0) {
                ask({ op: 'logs', unit: src, lines: 300 }).then((msg) => (msg.type === 'logs' ?
                    json(res, 200, { text: String(msg.text || '') }) : json(res, 502, { error: msg.error || 'no log' })), fail);
            } else {
                json(res, 400, { error: 'unknown log' });
            }
        } else if (u.pathname === '/api/op' && req.method === 'POST') {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
                json(res, 415, { error: 'JSON only' });
                return;
            }
            readBody(req, (err, text) => {
                if (err) {
                    json(res, 413, { error: 'request too large' });
                    return;
                }
                let body;
                try {
                    body = JSON.parse(text);
                } catch (e) {
                    body = null;
                }
                const shape = body && typeof body === 'object' && OPS.hasOwnProperty(body.op) ? OPS[body.op] : null;
                const fields = shape && shape(body);
                if (!fields) {
                    json(res, 400, { error: 'not a request the page can make' });
                    return;
                }
                ask(Object.assign({ op: body.op }, fields)).then((msg) => (msg.type === 'error' ?
                    json(res, 422, { error: msg.error || 'refused' }) : json(res, 200, { ok: true })), fail);
            });
        } else {
            json(res, 405, { error: 'method not allowed' });
        }
    };

    /* -- listening: 127.0.0.1 always, the hotspot address while there is one -- */
    const servers = new Map(); // host -> { server, up }
    let want = ['127.0.0.1'];
    let bindError = null;
    let retry = null;
    const report = () => emit({
        listening: want.filter((h) => servers.has(h) && servers.get(h).up),
        error: bindError
    });
    const sync = () => {
        clearTimeout(retry);
        retry = null;
        servers.forEach((s, host) => {
            if (want.indexOf(host) < 0) {
                servers.delete(host);
                s.server.close();
            }
        });
        bindError = null;
        want.forEach((host) => {
            if (servers.has(host)) {
                return;
            }
            const server = http.createServer(handle);
            const entry = { server, up: false };
            servers.set(host, entry);
            server.maxConnections = 32;
            server.keepAliveTimeout = 5000;
            server.setTimeout(30000);
            server.on('clientError', (err, s) => s.destroy());
            server.on('error', (err) => {
                if (servers.get(host) === entry) {
                    servers.delete(host);
                }
                bindError = `cannot listen on ${host}:${cfg.port}: ${err.code || err.message}`;
                say(bindError);
                report();
                if (!retry) {
                    retry = setTimeout(sync, RETRY_MS);
                }
            });
            server.listen({ host, port: cfg.port }, () => {
                entry.up = true;
                say(`listening on ${host}:${cfg.port}`);
                report();
            });
        });
        report();
    };

    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
        input += d;
        let nl;
        while ((nl = input.indexOf('\n')) >= 0) {
            const line = input.slice(0, nl);
            input = input.slice(nl + 1);
            let msg;
            try {
                msg = JSON.parse(line);
            } catch (e) {
                continue;
            }
            if (!cfg) {
                cfg = msg;
                tokenHash = hash(cfg.token);
                connectUpdater();
                sync();
            } else if (msg.addr !== undefined) {
                want = ['127.0.0.1'].concat(msg.addr ? [msg.addr] : []);
                sync();
            }
        }
    });
    process.stdin.on('end', () => process.exit(0));
}

/* ---- the page ------------------------------------------------------------------- */

const PAGE_SCRIPT = `
(function () {
'use strict';
var KEY = 'mgu-web-token';
var $ = function (id) { return document.getElementById(id); };
var m = /^#t=([0-9a-f]+)$/.exec(location.hash);
var token = m ? m[1] : null;
try {
  if (m) { sessionStorage.setItem(KEY, m[1]); } else { token = sessionStorage.getItem(KEY); }
} catch (e) { /* private mode: the token lives in this page only */ }
if (m) { history.replaceState(null, '', location.pathname); }
// a code scanned again in a tab showing the page changes only the fragment
window.addEventListener('hashchange', function () {
  if (/^#t=[0-9a-f]+$/.test(location.hash)) { location.reload(); }
});
var STATUS = { ok: 'OK', checking: 'Checking', error: 'Error', 'auth-needed': 'Sign-in needed', offline: 'Offline',
  installed: 'Installed', update: 'Update', available: 'Available', newer: 'Newer' };
var PHASE = { download: 'Downloading', verify: 'Verifying', install: 'Installing', check: 'Checking', build: 'Building' };

function locked() {
  try { sessionStorage.removeItem(KEY); } catch (e) { /* none */ }
  token = null;
  $('app').hidden = true;
  $('locked').hidden = false;
}
function api(method, path, body) {
  var headers = { Authorization: 'Bearer ' + token };
  if (body) { headers['Content-Type'] = 'application/json'; }
  return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
    .then(function (r) {
      if (r.status === 401) { locked(); throw new Error(''); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }
        return j;
      });
    });
}
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) { e.className = cls; }
  if (text !== undefined && text !== null) { e.textContent = String(text); }
  return e;
}
function button(label, fn) {
  var b = el('button', null, label);
  b.type = 'button';
  b.onclick = fn;
  return b;
}
function showError(e) {
  if (!e.message) { return; }
  $('err').textContent = e.message;
  $('err').hidden = false;
}
function op(body) {
  $('err').hidden = true;
  return api('POST', '/api/op', body).then(poll, showError);
}
function channelLabel(c) {
  if (c === 'releases') { return 'Releases'; }
  if (c === 'tags') { return 'Tags'; }
  if (c === 'branch') { return 'Branch'; }
  return /^branch:/.test(c) ? 'Branch ' + c.slice(7) : c;
}
function confirmRemove(s) {
  if (confirm('Remove ' + s.label + '?')) { op({ op: 'source-remove', id: s.id }); }
}
function tokenName(t) { return t.label || t.login || t.id; }
function confirmRemoveToken(t) {
  if (confirm('Remove token ' + tokenName(t) + '?')) { op({ op: 'token-remove', id: t.id }); }
}

var last = {};
function changed(key, value) {
  var s = JSON.stringify(value);
  if (last[key] === s) { return false; }
  last[key] = s;
  return true;
}
function renderSources(sources) {
  var box = $('sources');
  box.textContent = '';
  sources.forEach(function (s) {
    var row = el('div', 'row');
    var main = el('div', 'grow');
    main.appendChild(el('div', null, s.label || s.id));
    var meta = [s.type];
    if (s.channel) { meta.push(channelLabel(s.channel)); }
    meta.push(STATUS[s.status] || s.status);
    if (s.auth) { meta.push(s.auth.login || s.auth.token); }
    if (s.components !== undefined && s.components !== null) { meta.push(s.components + ' components'); }
    main.appendChild(el('div', 'mut', meta.join(' · ')));
    if (s.error) { main.appendChild(el('div', 'bad', s.error)); }
    row.appendChild(main);
    if (!s.builtin && !s.usb) {
      row.appendChild(button('Remove', function () { confirmRemove(s); }));
    }
    box.appendChild(row);
  });
}
function renderTokens(tokens, sources) {
  var box = $('tokens');
  box.textContent = '';
  tokens.forEach(function (t) {
    var row = el('div', 'row');
    var main = el('div', 'grow');
    main.appendChild(el('div', null, tokenName(t)));
    var meta = [t.id];
    if (t.login && t.login !== t.label) { meta.push(t.login); }
    var used = (t.usedBy || []).map(function (id) {
      var s = sources.filter(function (x) { return x.id === id; })[0];
      return s ? (s.label || s.id) : id;
    });
    meta.push(used.length ? used.join(', ') : 'Unused');
    main.appendChild(el('div', 'mut', meta.join(' · ')));
    if (t.rejected) { main.appendChild(el('div', 'bad', 'Rejected by GitHub')); }
    row.appendChild(main);
    row.appendChild(button('Remove', function () { confirmRemoveToken(t); }));
    box.appendChild(row);
  });
}
function renderComponents(list) {
  var box = $('components');
  box.textContent = '';
  list.forEach(function (c) {
    var row = el('div', 'row');
    var main = el('div', 'grow');
    main.appendChild(el('div', null, c.title || c.id));
    var meta = [c.id, (c.installed || '-') + ' → ' + (c.version || '-') + (c.revision ? ' (' + c.revision + ')' : ''),
      STATUS[c.status] || c.status];
    if (c.source) { meta.push(c.source); }
    if (c.pendingReboot) { meta.push('Restart pending'); }
    if (c.provides) { meta.push(c.provides); }
    if (c.compat === 'no') { meta.push('Not for this head unit'); }
    if (c.blocked) { meta.push('Not installable'); }
    main.appendChild(el('div', 'mut', meta.join(' · ')));
    if (c.blocked) { main.appendChild(el('div', 'bad', c.blocked)); }
    if (c.error) { main.appendChild(el('div', 'bad', c.error)); }
    row.appendChild(main);
    box.appendChild(row);
  });
}
function renderLogin(l) {
  $('login').hidden = !l;
  if (!l) { return; }
  $('loginCode').textContent = l.code || '';
  var a = $('loginUrl');
  var href = /^https:\\/\\//.test(l.url || '') ? l.url : '';
  a.textContent = href;
  if (href) { a.href = href; } else { a.removeAttribute('href'); }
  var st = { pending: 'Waiting', done: 'Signed in', error: 'Failed', expired: 'Expired' }[l.status] || l.status;
  $('loginStatus').textContent = st + (l.error ? ': ' + l.error : '');
  $('loginCancel').hidden = l.status !== 'pending';
}
function render(st) {
  $('locked').hidden = true;
  $('app').hidden = false;
  var line = ['Updater ' + ((st.updater && st.updater.version) || '?'), st.online ? 'Online' : 'Offline'];
  if (st.catalog && st.catalog.checking) { line.push('Checking'); }
  $('status').textContent = line.join(' · ');
  var errs = [];
  if (st.catalog && st.catalog.error) { errs.push(st.catalog.error); }
  if (st.rebootError) { errs.push(st.rebootError); }
  $('stateErr').textContent = errs.join('\\n');
  $('stateErr').hidden = !errs.length;
  var b = st.busy;
  $('busy').hidden = !b;
  if (b) {
    $('busyText').textContent = (PHASE[b.phase] || b.phase) + ' ' + b.id;
    var bar = $('busyBar');
    if (b.total) { bar.max = b.total; bar.value = b.progress || 0; } else { bar.removeAttribute('value'); }
  }
  $('loginStart').hidden = !st.signin;
  if (changed('sources', st.sources || [])) { renderSources(st.sources || []); }
  if (changed('tokens', [st.tokens || [], st.sources || []])) { renderTokens(st.tokens || [], st.sources || []); }
  if (changed('components', st.components || [])) { renderComponents(st.components || []); }
  renderLogin(st.login);
}

var inflight = false;
function poll() {
  if (!token || inflight) { return; }
  inflight = true;
  api('GET', '/api/state').then(function (st) {
    inflight = false;
    $('down').hidden = true;
    render(st);
  }, function (e) {
    inflight = false;
    if (e.message) { $('down').textContent = e.message; $('down').hidden = false; $('app').hidden = false; }
  });
}

function addFields() {
  var gh = $('addType').value === 'github';
  $('addValue').placeholder = gh ? 'owner/repo' : 'https://…/catalog.json';
  $('addChannel').hidden = !gh;
  $('addBranch').hidden = !gh || $('addChannel').value !== 'branch';
}
$('addType').onchange = addFields;
$('addChannel').onchange = addFields;
$('addForm').onsubmit = function (ev) {
  ev.preventDefault();
  var v = $('addValue').value.trim();
  if (!v) { return; }
  var body = { op: 'source-add', type: 'https', url: v };
  if ($('addType').value === 'github') {
    var ch = $('addChannel').value;
    var br = $('addBranch').value.trim();
    // no name: the repository's default branch
    if (ch === 'branch' && br) { ch = 'branch:' + br; }
    body = { op: 'source-add', type: 'github', repo: v, channel: ch };
  }
  op(body).then(function () { $('addValue').value = ''; $('addBranch').value = ''; });
};
$('tokenForm').onsubmit = function (ev) {
  ev.preventDefault();
  var v = $('tokenValue').value.trim();
  if (!v) { return; }
  op({ op: 'token-add', token: v }).then(function () { $('tokenValue').value = ''; });
};
$('loginStart').onclick = function () { op({ op: 'login-start' }); };
$('loginCancel').onclick = function () { op({ op: 'login-cancel' }); };
$('logForm').onsubmit = function (ev) {
  ev.preventDefault();
  var pre = $('log');
  pre.hidden = false;
  pre.textContent = '…';
  api('GET', '/api/logs?src=' + encodeURIComponent($('logSrc').value)).then(function (j) {
    pre.textContent = j.text || '(empty)';
    pre.scrollTop = pre.scrollHeight;
  }, function (e) { pre.textContent = e.message; });
};

if (!token) { locked(); return; }
poll();
setInterval(poll, 2000);
})();
`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Store</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#151515;--mut:#666;--line:#e2e2e2;--card:#f4f4f5;--acc:#1c64f2;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececec;--mut:#9a9a9a;--line:#2c2c30;--card:#1c1c1f;--acc:#6ea8fe;--bad:#ff7070}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:12px 16px 48px}
h1{font-size:22px;margin:8px 0 4px}
h2{font-size:15px;margin:24px 0 4px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--line)}
.grow{flex:1 1 200px;min-width:0;overflow-wrap:anywhere}
.mut{color:var(--mut);font-size:13px}
.bad{color:var(--bad);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
button,input,select{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
button{cursor:pointer}
button.pri{background:var(--acc);border-color:var(--acc);color:#fff}
input{flex:1 1 160px;min-width:0}
form{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
.code{font:600 30px/1.2 ui-monospace,Menlo,monospace;letter-spacing:3px;margin:6px 0}
.card{background:var(--card);border-radius:12px;padding:12px;margin:12px 0}
.card button{background:var(--bg)}
progress{width:100%;height:8px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.4 ui-monospace,Menlo,monospace;background:var(--card);padding:10px;border-radius:8px;max-height:60vh;overflow:auto}
a{color:var(--acc)}
[hidden]{display:none!important}
</style></head><body><main>
<section id="locked" hidden><h1>Store</h1><p>Scan the code in the Store.</p></section>
<section id="app" hidden>
<h1>Store</h1>
<div id="status" class="mut"></div>
<p id="down" class="bad" hidden></p>
<p id="stateErr" class="bad" hidden></p>
<p id="err" class="bad" hidden></p>
<div id="busy" class="card" hidden><div id="busyText"></div><progress id="busyBar"></progress></div>
<div id="login" class="card" hidden>
<div>GitHub sign-in</div>
<div class="code" id="loginCode"></div>
<div><a id="loginUrl" target="_blank" rel="noreferrer noopener"></a></div>
<div id="loginStatus" class="mut"></div>
<button id="loginCancel" type="button">Cancel</button>
</div>
<h2>Sources</h2>
<div id="sources"></div>
<form id="addForm"><select id="addType" aria-label="Type"><option value="github">GitHub</option><option value="https">URL</option></select><input id="addValue" aria-label="Source" placeholder="owner/repo" autocapitalize="off" autocorrect="off" spellcheck="false"><select id="addChannel" aria-label="Channel"><option value="releases">Releases</option><option value="branch">Branch</option><option value="tags">Tags</option></select><input id="addBranch" aria-label="Branch" placeholder="Default branch" autocapitalize="off" autocorrect="off" spellcheck="false" hidden><button class="pri">Add</button></form>
<h2>Tokens</h2>
<div id="tokens"></div>
<form id="tokenForm"><input id="tokenValue" type="password" aria-label="Token" placeholder="Token" autocomplete="off"><button class="pri">Add token</button><button id="loginStart" type="button" hidden>Sign in with GitHub</button></form>
<h2>Components</h2>
<div id="components"></div>
<h2>Logs</h2>
<form id="logForm"><select id="logSrc" aria-label="Log"><option value="updater">mgu-updater.log</option>${
    UNITS.map((u) => `<option value="${u}">${u} journal</option>`).join('')}</select><button>Show</button></form>
<pre id="log" hidden></pre>
</section></main>
<script>${PAGE_SCRIPT}</script>
</body></html>
`;

module.exports = { setEnabled, state, accessUrls, journal, UNITS, _interfaces: () => os.networkInterfaces() };

if (require.main === module && process.argv[2] === 'serve') {
    serve();
}
