'use strict';
/**
 * Phone page tests (js/web.js), on the unit's Node (8.16.2), as root:
 *   docker run --rm -v "$PWD:/w:ro" -w /w node:8.16.2-stretch node test/test_web.js
 * A fake updater socket, `nft` and `journalctl` stand-ins on PATH, and the
 * container's eth0 address standing in for the hotspot's.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const assert = require('assert');

const WEB_UID = 12996;
const WEB_GID = 12202;
const PORT = 8470;

process.env.MGU_WEB_POLL_MS = '200';
process.env.MGU_WEB_RULE_MS = '300';
process.env.MGU_WEB_RESTART_MS = '300';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webtest-'));
fs.chmodSync(tmp, 0o755);
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
process.env.PATH = `${bin}:${process.env.PATH}`;

/* nft stand-in: the unit's ip filter input chain in a JSON file. */
const nftState = path.join(tmp, 'nft.json');
const nftCalls = path.join(tmp, 'nft.calls');
fs.writeFileSync(path.join(bin, 'nft'), `#!${process.execPath}
const fs = require('fs');
const file = ${JSON.stringify(nftState)};
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(nftCalls)}, a.join(' ') + '\\n');
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const chain = a.indexOf('ip') >= 0 && a.indexOf('filter') >= 0 && a.indexOf('input') >= 0;
if (!st.present || !chain) { process.stderr.write('Error: No such file or directory\\n'); process.exit(1); }
if (a[0] === '-a' && a[1] === 'list') {
  let out = 'table ip filter {\\n\\tchain input {\\n\\t\\ttype filter hook input priority 0; policy accept;\\n';
  st.rules.forEach((r) => { out += '\\t\\t' + r.text + ' # handle ' + r.handle + '\\n'; });
  process.stdout.write(out + '\\t}\\n}\\n');
} else if (a[0] === 'insert') {
  st.rules.unshift({ handle: st.next++, text: a.slice(5).join(' ') });
} else if (a[0] === 'delete') {
  const h = Number(a[a.length - 1]);
  const n = st.rules.length;
  st.rules = st.rules.filter((r) => r.handle !== h);
  if (st.rules.length === n) { process.stderr.write('Error: no rule\\n'); process.exit(1); }
} else { process.exit(1); }
fs.writeFileSync(file, JSON.stringify(st));
`, { mode: 0o755 });
const setNft = (st) => fs.writeFileSync(nftState, JSON.stringify(st));
const nftRules = () => JSON.parse(fs.readFileSync(nftState, 'utf8')).rules;

fs.writeFileSync(path.join(bin, 'journalctl'), '#!/bin/sh\necho "journal $*"\n', { mode: 0o755 });

/* The updater's side: socket, web secret, log file. */
const sockPath = path.join(tmp, 'updater.sock');
const secretFile = path.join(tmp, 'web-secret');
fs.writeFileSync(secretFile, 'websecret123\n', { mode: 0o400 });
fs.chownSync(secretFile, WEB_UID, WEB_GID);
const logFile = path.join(tmp, 'mgu-updater.log');
fs.writeFileSync(`${logFile}.1`, 'older line\n', { mode: 0o644 });
fs.writeFileSync(logFile, 'newest line\n', { mode: 0o644 });

const STATE = {
    type: 'state', updater: { version: '9.9.9' }, online: true, busy: null,
    sources: [{ id: 'mgu-store', type: 'github', label: 'o/r', builtin: true, status: 'ok', channel: 'releases' }],
    components: [{ id: 'doom', title: 'DOOM <b>', version: '1.0.1', installed: '1.0.0', status: 'update', revision: 'abc1234' }]
};
const received = [];
let clients = [];
const fake = net.createServer((s) => {
    clients.push(s);
    s.on('close', () => { clients = clients.filter((c) => c !== s); });
    s.on('error', () => {});
    s.write(JSON.stringify(STATE) + '\n');
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const req = JSON.parse(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
            received.push(req);
            // a state push before the direct reply, as the updater may send one
            s.write(JSON.stringify(STATE) + '\n');
            let msg;
            if (req.secret !== 'websecret123') {
                msg = { type: 'error', op: req.op, error: 'forbidden' };
            } else if (req.op === 'logs') {
                msg = { type: 'logs', unit: req.unit, text: `log of ${req.unit}` };
            } else if (req.op === 'source-remove' && req.id === 'mgu-store') {
                msg = { type: 'error', op: req.op, error: 'built in' };
            } else {
                msg = Object.assign({}, STATE);
            }
            s.write(JSON.stringify(Object.assign(msg, { rid: req.rid })) + '\n');
        }
    });
});

/* the container's eth0 address stands in for the hotspot's */
const eth0 = (os.networkInterfaces().eth0 || []).filter((a) => a.family === 'IPv4')[0];
assert(eth0, 'the container has an eth0 IPv4 address');
const HOT = eth0.address;
let hotspotUp = false;

const web = require('../js/web');
web._interfaces = () => (hotspotUp ? { wlan_bridge: [{ family: 'IPv4', address: HOT, internal: false }] } : {});

const conf = { socket: sockPath, log_file: logFile, web_secret: secretFile };
const logs = [];
const log = (l) => logs.push(l);
let changes = 0;
const onChange = () => { changes++; };

function request(host, method, p, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
        const headers = Object.assign({}, opts.headers || {});
        if (opts.token) {
            headers.Authorization = `Bearer ${opts.token}`;
        }
        let body = opts.body;
        if (body !== undefined && typeof body !== 'string') {
            body = JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
        }
        const req = http.request({ host, port: PORT, method, path: p, headers, agent: false }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { text += d; });
            res.on('end', () => {
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch (e) { /* html */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}
const get = (p, opts, host) => request(host || '127.0.0.1', 'GET', p, opts);
const post = (p, opts, host) => request(host || '127.0.0.1', 'POST', p, opts);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function until(what, fn, ms) {
    const end = Date.now() + (ms || 5000);
    const loop = () => Promise.resolve().then(fn).catch(() => false).then((ok) => {
        if (ok) {
            return ok;
        }
        if (Date.now() > end) {
            throw new Error(`timed out waiting for ${what}`);
        }
        return delay(50).then(loop);
    });
    return loop();
}
const tokenOf = () => {
    const u = web.accessUrls()[0];
    return u ? /#t=([0-9a-f]+)$/.exec(u)[1] : null;
};
function serverPids() {
    return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((pid) => {
        try {
            return /web\.js\0serve/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
        } catch (e) {
            return false;
        }
    });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let token = null;

test('enable: stale rule removed, one tagged rule put in, server as the web uid', () => {
    setNft({ present: true, next: 10, rules: [
        { handle: 3, text: 'iifname "wlan_bridge" tcp dport 8470 accept comment "mgu-updater-web"' },
        { handle: 4, text: 'iifname lo accept' }] });
    return web.setEnabled(conf, true, log, onChange).then(() => {
        const rules = nftRules();
        assert.deepStrictEqual(rules.map((r) => r.text), [
            'iifname "wlan_bridge" tcp dport 8470 accept comment "mgu-updater-web"', 'iifname lo accept']);
        assert.notStrictEqual(rules[0].handle, 3);
        return until('the server on 127.0.0.1', () => get('/').then((r) => r.status === 200));
    }).then(() => {
        const pids = serverPids();
        assert.strictEqual(pids.length, 1);
        const status = fs.readFileSync(`/proc/${pids[0]}/status`, 'utf8');
        assert(new RegExp(`\\nUid:\\s+${WEB_UID}\\s+${WEB_UID}\\s+${WEB_UID}\\s+${WEB_UID}\\n`).test(status), status);
        assert(new RegExp(`\\nGid:\\s+${WEB_GID}\\s+${WEB_GID}\\s+${WEB_GID}\\s+${WEB_GID}\\n`).test(status), status);
        assert(/\nGroups:\s*\n/.test(status), 'no other groups');
        assert.deepStrictEqual(web.state(), { enabled: true, urls: [], error: null });
        assert.deepStrictEqual(web.accessUrls(), []);
    });
});

test('hotspot address appearing later is served, url in state without the token', () => {
    const before = changes;
    hotspotUp = true;
    return until('the hotspot url', () => web.state().urls.length === 1).then(() => {
        assert.deepStrictEqual(web.state(), { enabled: true, urls: [`http://${HOT}:${PORT}/`], error: null });
        assert(changes > before, 'onChange called');
        token = tokenOf();
        assert(/^[0-9a-f]{32}$/.test(token));
        assert.strictEqual(web.accessUrls()[0], `http://${HOT}:${PORT}/#t=${token}`);
        const pid = serverPids()[0];
        assert(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').indexOf(token) < 0, 'token not in argv');
        return get('/', {}, HOT);
    }).then((r) => {
        assert.strictEqual(r.status, 200);
        assert(/Scan the code in the Store/.test(r.text));
        assert(/script-src 'sha256-[A-Za-z0-9+/=]+'/.test(r.headers['content-security-policy']));
        assert.strictEqual(r.headers['cache-control'], 'no-store');
        assert(!/<(script|link|img|iframe)[^>]*\s(src|href)=|@import|url\(/i.test(r.text), 'no external resources');
    });
});

test('the inline script matches its CSP hash and parses', () => get('/').then((r) => {
    const m = /<script>([\s\S]*)<\/script>/.exec(r.text);
    const h = require('crypto').createHash('sha256').update(m[1]).digest('base64');
    assert(r.headers['content-security-policy'].indexOf(`'sha256-${h}'`) >= 0);
    new Function(m[1]); // eslint-disable-line no-new-func
}));

test('api without, or with a wrong, token: 401', () => get('/api/state').then((r) => {
    assert.strictEqual(r.status, 401);
    return get('/api/state', { token: 'ab'.repeat(16) });
}).then((r) => {
    assert.strictEqual(r.status, 401);
    return get('/api/state', { headers: { Authorization: `Basic ${token}` } });
}).then((r) => assert.strictEqual(r.status, 401)));

test('state with the token, on both addresses', () => get('/api/state', { token }).then((r) => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.updater.version, '9.9.9');
    return get('/api/state', { token }, HOT);
}).then((r) => assert.strictEqual(r.status, 200)));

test('no paths beyond the fixed ones', () => Promise.all(
    ['/../../etc/passwd', '/index.html', '/api/../etc/passwd', '/api/state/x', '/%2e%2e/etc/passwd']
        .map((p) => get(p, { token }))).then((rs) => rs.forEach((r) => assert.strictEqual(r.status, 404, r.text))));

test('ops go to the updater with the web secret and only their own fields', () => {
    received.length = 0;
    return post('/api/op', { token, body: { op: 'source-add', type: 'github', repo: 'a/b', channel: 'branch:main', extra: 1 } })
        .then((r) => {
            assert.deepStrictEqual(r.json, { ok: true });
            const q = received[0];
            assert.strictEqual(q.secret, 'websecret123');
            assert(typeof q.rid === 'string');
            delete q.rid;
            delete q.secret;
            assert.deepStrictEqual(q, { op: 'source-add', type: 'github', repo: 'a/b', channel: 'branch:main' });
            return post('/api/op', { token, body: { op: 'source-add', type: 'https', url: 'https://x.org/catalog.json' } });
        })
        .then((r) => {
            assert.deepStrictEqual(r.json, { ok: true });
            return post('/api/op', { token, body: { op: 'token-set', source: 'mgu-apps', token: ' ghp_x \n' } });
        })
        .then((r) => {
            assert.deepStrictEqual(r.json, { ok: true });
            assert.strictEqual(received[received.length - 1].token, 'ghp_x');
            return post('/api/op', { token, body: { op: 'source-remove', id: 'mgu-store' } });
        })
        .then((r) => {
            assert.strictEqual(r.status, 422);
            assert.strictEqual(r.json.error, 'built in');
        });
});

test('requests the page cannot make are refused before the updater', () => {
    received.length = 0;
    const bad = [
        { op: 'web', enable: false }, { op: 'reboot' }, { op: 'install', id: 'doom' },
        { op: 'source-add', type: 'github', repo: 'a/b' },
        { op: 'source-add', type: 'github', repo: 'a/b', channel: 3 },
        { op: 'source-add', type: 'https' },
        { op: 'source-add', type: 'file', path: '/' }, { op: 'token-set', source: 'x' }, { op: 'toString' }, ['x']];
    return Promise.all(bad.map((body) => post('/api/op', { token, body }))).then((rs) => {
        rs.forEach((r) => assert.strictEqual(r.status, 400, r.text));
        assert.strictEqual(received.length, 0);
        return post('/api/op', { token, body: 'op=check', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    }).then((r) => assert.strictEqual(r.status, 415));
});

test('a body over 16 KiB: 413', () => post('/api/op', { token, body: { op: 'token-set', source: 'x', token: 'a'.repeat(20000) } })
    .then((r) => assert.strictEqual(r.status, 413)).catch((e) => assert(/ECONNRESET|EPIPE/.test(e.code), e.message)));

test('logs: the log file tail and the journals through the updater', () => get('/api/logs?src=updater', { token })
    .then((r) => {
        assert.strictEqual(r.json.text, 'older line\nnewest line\n');
        return get('/api/logs?src=mgu-uplink', { token });
    })
    .then((r) => {
        assert.strictEqual(r.json.text, 'log of mgu-uplink');
        const q = received[received.length - 1];
        assert.strictEqual(q.op, 'logs');
        assert.strictEqual(q.lines, 300);
        return get('/api/logs?src=../../etc/shadow', { token });
    })
    .then((r) => assert.strictEqual(r.status, 400)));

test('a log file that is not the updater\'s is not read', () => {
    fs.chownSync(logFile, WEB_UID, WEB_GID);
    return get('/api/logs?src=updater', { token }).then((r) => {
        assert.strictEqual(r.json.text, 'older line\n');
        fs.chownSync(logFile, 0, 0);
    });
});

test('journal(): fixed units only, lines clamped', () => new Promise((resolve) => {
    web.journal('mgu-uplink', 5000, (err, text) => {
        assert.ifError(err);
        assert.strictEqual(text, 'journal -u mgu-uplink -n 1000 --no-pager\n');
        web.journal('sshd', 10, (err2) => {
            assert(err2);
            resolve();
        });
    });
}));

test('the updater going away and coming back', () => {
    clients.forEach((c) => c.destroy());
    return until('503', () => get('/api/state', { token }).then((r) => r.status === 503))
        .then(() => until('state again', () => get('/api/state', { token }).then((r) => r.status === 200)));
});

test('a removed rule is put back', () => {
    setNft({ present: true, next: 50, rules: [{ handle: 1, text: 'iifname lo accept' }] });
    return until('the rule back', () => nftRules().length === 2 && /mgu-updater-web/.test(nftRules()[0].text));
});

test('a server that dies is started again', () => {
    const pid = serverPids()[0];
    process.kill(Number(pid), 'SIGKILL');
    return until('a new server', () => serverPids().length === 1 && serverPids()[0] !== pid)
        .then(() => until('serving', () => get('/api/state', { token }).then((r) => r.status === 200)))
        .then(() => assert.strictEqual(web.state().error, null));
});

test('re-enabling rotates the token', () => {
    const old = token;
    return web.setEnabled(conf, true, log, onChange)
        .then(() => until('the hotspot url', () => web.state().urls.length === 1 && tokenOf()))
        .then(() => {
            token = tokenOf();
            assert.notStrictEqual(token, old);
            return until('the new server', () => get('/api/state', { token }).then((r) => r.status === 200));
        })
        .then(() => get('/api/state', { token: old }))
        .then((r) => {
            assert.strictEqual(r.status, 401);
            assert.strictEqual(serverPids().length, 1);
            assert.strictEqual(nftRules().filter((x) => /mgu-updater-web/.test(x.text)).length, 1);
        });
});

test('10 wrong tokens in a minute: 429, the right one too; requests without one do not count', () => {
    const tries = []; // the old token above was the first
    for (let i = 0; i < 12; i++) {
        tries.push(get('/api/state'));
    }
    for (let i = 0; i < 9; i++) {
        tries.push(get('/api/state', { token: 'cd'.repeat(16) }));
    }
    return Promise.all(tries).then((rs) => {
        rs.forEach((r) => assert.strictEqual(r.status, 401));
        return get('/api/state', { token });
    }).then((r) => {
        assert.strictEqual(r.status, 429);
        return get('/api/state');
    }).then((r) => {
        assert.strictEqual(r.status, 429);
        return get('/api/state', { token }, HOT); // another client address
    }).then((r) => assert.strictEqual(r.status, 200));
});

test('hotspot address going away stops serving it', () => {
    hotspotUp = false;
    return until('no url', () => web.state().urls.length === 0)
        .then(() => get('/api/state', { token }, HOT).then(() => false, () => true))
        .then((refused) => assert(refused, 'nothing on the hotspot address'));
});

test('without the unit\'s chain: no rule, no error', () => {
    setNft({ present: false, next: 1, rules: [] });
    return web.setEnabled(conf, true, log, onChange)
        .then(() => delay(400))
        .then(() => assert.strictEqual(web.state().error, null));
});

test('a failing rule insert shows in state', () => {
    fs.writeFileSync(path.join(bin, 'nft.real'), fs.readFileSync(path.join(bin, 'nft')));
    fs.writeFileSync(path.join(bin, 'nft'), '#!/bin/sh\ncase "$1" in -a) echo "table ip filter {"; exit 0;; esac\necho "Error: Operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
    return web.setEnabled(conf, true, log, onChange)
        .then(() => until('the error', () => /Operation not permitted/.test(web.state().error || '')))
        .then(() => {
            fs.renameSync(path.join(bin, 'nft.real'), path.join(bin, 'nft'));
            fs.chmodSync(path.join(bin, 'nft'), 0o755);
            setNft({ present: true, next: 1, rules: [] });
            return until('the error cleared', () => web.state().error === null && nftRules().length === 1);
        });
});

test('disable: server stopped, rule removed', () => {
    setNft({ present: true, next: 70, rules: [
        { handle: 5, text: 'iifname "wlan_bridge" tcp dport 8470 accept comment "mgu-updater-web"' },
        { handle: 6, text: 'iifname lo accept' }] });
    return web.setEnabled(conf, false, log, onChange).then(() => {
        assert.deepStrictEqual(nftRules().map((r) => r.text), ['iifname lo accept']);
        assert.deepStrictEqual(web.state(), { enabled: false, urls: [], error: null });
        assert.deepStrictEqual(web.accessUrls(), []);
        return until('no server', () => serverPids().length === 0);
    }).then(() => get('/').then(() => false, () => true)).then((refused) => assert(refused));
});

test('the server exits when the updater does', () => {
    const { spawn } = require('child_process');
    const script = `const web = require(${JSON.stringify(path.resolve(__dirname, '../js/web.js'))});
        web.setEnabled(${JSON.stringify(Object.assign({ web_port: 8471 }, conf))}, true);
        setTimeout(() => process.exit(0), 1500);`;
    let pid = null;
    return new Promise((resolve) => {
        const p = spawn(process.execPath, ['-e', script], { stdio: 'inherit' });
        until('the server', () => (pid = serverPids()[0])).catch(() => {});
        p.on('exit', resolve);
    }).then(() => {
        assert(pid, 'a server ran');
        return until('it exits', () => !fs.existsSync(`/proc/${pid}`) || /State:\s+Z/.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')));
    });
});

fake.listen(sockPath, () => {
    fs.chownSync(sockPath, 0, WEB_GID);
    fs.chmodSync(sockPath, 0o660);
    let failed = 0;
    tests.reduce((p, t) => p.then(() => t.fn()).then(() => console.log(`ok   ${t.name}`), (err) => {
        failed++;
        console.log(`FAIL ${t.name}\n     ${err.stack}`);
    }), Promise.resolve()).then(() => {
        web.setEnabled(conf, false);
        console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
        if (failed) {
            console.log(logs.join('\n'));
        }
        setTimeout(() => process.exit(failed ? 1 : 0), 300);
    });
});
