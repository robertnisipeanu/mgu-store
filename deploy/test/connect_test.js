'use strict';
/**
 * Offline tests of how mgu-install.js finds the head unit: the detection
 * order with stand-ins, the interface choice, HSFZ framing and the DID 22 17
 * 2A answer (the vectors of transport_test.py), and the SSH banner check,
 * HSFZ identification and the DID read against servers on 127.0.0.1. No car
 * address is contacted.
 *
 * Prints one "ok <name>" / "not ok <name>" line per check; deploy/test/run.js collects them.
 */
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const mi = require(path.join(__dirname, '..', 'mgu-install.js'));

let failed = 0;

function check(name, cond, detail) {
    if (cond) {
        console.log(`ok ${name}`);
    } else {
        failed += 1;
        console.log(`not ok ${name}${detail !== undefined ? `\n  # ${String(detail).split('\n').join('\n  # ')}` : ''}`);
    }
}

/* 62 17 2A 00 <address>, as the unit answers DID 22 17 2A */
function did(ip) {
    return Buffer.concat([Buffer.from('62172a00', 'hex'), Buffer.from(ip.split('.').map(Number))]);
}

/* An HSFZ frame from the head unit to the tester. */
function fromUnit(control, uds) {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(2 + uds.length, 0);
    h.writeUInt16BE(control, 4);
    h[6] = 0x63;
    h[7] = 0xf4;
    return Buffer.concat([h, uds]);
}

function tcpServer(onConn) {
    return new Promise((resolve) => {
        const srv = net.createServer(onConn);
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

/* Stand-ins for the network: the answering addresses, a gateway and DID answer per interface address. */
function fakeNet({ answering = [], closed = [], gateways = {}, dids = {}, last = null, ifaces = [], platform = 'darwin' }) {
    const log = [];
    return {
        log,
        platform,
        banner: async (host, port, local) => {
            log.push(`banner ${host}:${port}${local ? ` from ${local}` : ''}`);
            return answering.includes(host) ? 'SSH-2.0-fake' : closed.includes(host) ? false : null;
        },
        interfaces: () => ifaces,
        gateway: async (local) => {
            log.push(`gateway ${local}`);
            return gateways[local] || null;
        },
        huAddress: async (gw, local) => {
            log.push(`did ${gw} from ${local}`);
            return dids[local] || null;
        },
        last: () => last,
        save: (ip) => log.push(`save ${ip}`)
    };
}

const EN = { name: 'en7', address: '169.254.10.20' };

async function testOrder() {
    let d = fakeNet({ answering: ['172.16.222.97', '169.254.1.2'], ifaces: [EN], gateways: { [EN.address]: '169.254.0.8' },
        dids: { [EN.address]: '169.254.1.2' } });
    let u = await mi.findUnit(d);
    check('find: the hotspot first when its SSH answers; no ENET lookup', u && u.host === '172.16.222.97' && u.port === '22' && !u.bind &&
        d.log.join('|') === 'banner 172.16.222.97:22', `${JSON.stringify(u)} ${d.log}`);

    d = fakeNet({ answering: ['169.254.1.2', '169.254.9.9'], ifaces: [EN], gateways: { [EN.address]: '169.254.0.8' },
        dids: { [EN.address]: '169.254.1.2' }, last: '169.254.9.9' });
    u = await mi.findUnit(d);
    check('find: no hotspot -> ENET, the address the gateway reports, reached from the interface\'s address',
        u && u.host === '169.254.1.2' && u.bind === EN.address && /ENET on en7/.test(u.via) &&
        d.log.includes(`banner 169.254.1.2:22 from ${EN.address}`) && d.log.includes('did 169.254.0.8 from 169.254.10.20'), `${JSON.stringify(u)} ${d.log}`);
    check('find: the ENET address that answered is remembered', d.log.includes('save 169.254.1.2'), d.log);

    d = fakeNet({ answering: ['169.254.9.9'], ifaces: [EN], last: '169.254.9.9' });
    u = await mi.findUnit(d);
    check('find: no gateway answer -> the last address that answered', u && u.host === '169.254.9.9' && u.bind === EN.address &&
        /the last that answered/.test(u.via), `${JSON.stringify(u)} ${d.log}`);

    d = fakeNet({ answering: ['169.254.9.9'], ifaces: [EN], gateways: { [EN.address]: '169.254.0.8' }, dids: { [EN.address]: '169.254.1.2' },
        last: '169.254.9.9' });
    u = await mi.findUnit(d);
    check('find: a reported address without SSH -> the last one, each checked for a banner first',
        u && u.host === '169.254.9.9' && d.log.indexOf(`banner 169.254.1.2:22 from ${EN.address}`) < d.log.indexOf(`banner 169.254.9.9:22 from ${EN.address}`),
        `${JSON.stringify(u)} ${d.log}`);

    const other = { name: 'en9', address: '169.254.77.1' };
    d = fakeNet({ answering: ['169.254.1.2'], ifaces: [other, EN], gateways: { [EN.address]: '169.254.0.8' }, dids: { [EN.address]: '169.254.1.2' } });
    u = await mi.findUnit(d);
    check('find: of several link-local interfaces, one at a time, the one whose gateway answers', u && u.bind === EN.address &&
        !d.log.some((l) => l.startsWith('banner') && l.endsWith(other.address)) &&
        d.log.filter((l) => l.startsWith('gateway')).join('|') === `gateway ${other.address}|gateway ${EN.address}`, `${JSON.stringify(u)} ${d.log}`);

    d = fakeNet({ ifaces: [EN], gateways: { [EN.address]: '169.254.0.8' }, dids: { [EN.address]: '169.254.1.2' }, last: '169.254.9.9' });
    u = await mi.findUnit(d);
    check('find: the gateway reports the head unit but its SSH does not answer -> found closed there, nothing remembered',
        u && u.closed === '169.254.1.2' && !u.host && !d.log.some((l) => l.startsWith('save')), `${JSON.stringify(u)} ${d.log}`);

    d = fakeNet({ ifaces: [EN], last: '169.254.9.9', closed: ['169.254.9.9'] });
    u = await mi.findUnit(d);
    check('find: only the last address, without SSH -> none (no proof it is the head unit)', u === null, `${JSON.stringify(u)} ${d.log}`);

    d = fakeNet({ closed: ['172.16.222.97'] });
    u = await mi.findUnit(d);
    check('find: the hotspot address answers port 22 without SSH -> found closed there', u && u.closed === '172.16.222.97', JSON.stringify(u));

    d = fakeNet({ closed: ['172.16.222.97'], answering: ['169.254.1.2'], ifaces: [EN], gateways: { [EN.address]: '169.254.0.8' },
        dids: { [EN.address]: '169.254.1.2' } });
    u = await mi.findUnit(d);
    check('find: hotspot closed but ENET answers -> ENET', u && u.host === '169.254.1.2', JSON.stringify(u));

    for (const net of [{ closed: ['172.16.222.97'] }, { ifaces: [EN], gateways: { [EN.address]: '169.254.0.8' }, dids: { [EN.address]: '169.254.1.2' } }]) {
        d = fakeNet(net);
        let e = null;
        await mi.reach(mi.parse(['status']), d).catch((x) => {
            e = x;
        });
        const at = net.closed ? '172.16.222.97' : '169.254.1.2';
        check(`reach: found at ${at} with SSH closed says so, not the no-car text`, e &&
            e.message === `found the head unit at ${at}, but its SSH is closed: enable root SSH first, then run this again`, e && e.message);
    }

    d = fakeNet({});
    u = await mi.findUnit(d);
    check('find: no hotspot and no link-local interface -> none', u === null && d.log.join('|') === 'banner 172.16.222.97:22', d.log);

    d = fakeNet({});
    let err = null;
    await mi.reach(mi.parse(['first-install']), d).catch((e) => {
        err = e;
    });
    check('reach: nothing found says what to check', err && err.message.startsWith('no head unit answered SSH. Join the car\'s Wi-Fi hotspot') &&
        /ENET/.test(err.message) && /--host/.test(err.message), err && err.message);

    d = fakeNet({ platform: 'linux' });
    err = null;
    await mi.reach(mi.parse(['first-install']), d).catch((e) => {
        err = e;
    });
    check('reach: on Linux without a link-local interface, says how to give the ENET adapter one',
        err && /nmcli con mod <its connection> ipv4\.method link-local/.test(err.message), err && err.message);
    d = fakeNet({ platform: 'linux', ifaces: [EN, { name: 'eth2', address: '169.254.5.5' }] });
    err = null;
    await mi.reach(mi.parse(['first-install']), d).catch((e) => {
        err = e;
    });
    check('reach: on Linux with several link-local interfaces, names them and says to unplug the others or give --host',
        err && /en7, eth2: unplug the others, or give --host/.test(err.message) && !/nmcli/.test(err.message), err && err.message);
    d = fakeNet({ platform: 'darwin', ifaces: [EN, { name: 'en9', address: '169.254.5.5' }] });
    err = null;
    await mi.reach(mi.parse(['first-install']), d).catch((e) => {
        err = e;
    });
    check('reach: elsewhere neither Linux line', err && !/Linux/.test(err.message), err && err.message);

    for (const args of [['--host', '10.0.0.9'], ['--port', '2222']]) {
        d = fakeNet({});
        const o = mi.parse(['first-install'].concat(args));
        await mi.reach(o, d);
        check(`reach: ${args[0]} names the target, no detection`, !d.log.length && o.host === (args[0] === '--host' ? '10.0.0.9' : '172.16.222.97'),
            `${d.log} ${o.host}`);
    }

    d = fakeNet({ answering: ['169.254.1.2'], ifaces: [EN], gateways: { [EN.address]: '169.254.0.8' }, dids: { [EN.address]: '169.254.1.2' } });
    const o = mi.parse(['first-install', '--identity', 'k', '--ssh-opt', 'StrictHostKeyChecking=accept-new']);
    await mi.reach(o, d);
    const a = mi.sshArgs(o, 'true');
    check('reach: --ssh-opt still finds the unit, and over ENET ssh binds to the interface\'s address (-b), with the option, to the unit\'s :22',
        d.log.length > 1 && a.slice(0, 6).join(' ') === `-p 22 -b ${EN.address} -o StrictHostKeyChecking=accept-new` &&
        a[a.length - 2] === 'root@169.254.1.2', a.join(' '));
}

function testInterfaces() {
    const got = mi.enetInterfaces({
        lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }, { family: 'IPv4', address: '169.254.3.3', internal: true }],
        en0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
        en7: [{ family: 'IPv6', address: 'fe80::2', internal: false }, { family: 'IPv4', address: '169.254.10.20', internal: false }],
        eth1: [{ family: 4, address: '169.254.200.1', internal: false }]
    });
    check('interfaces: the non-loopback ones with a 169.254.x.x IPv4 address, in order',
        JSON.stringify(got) === JSON.stringify([{ name: 'en7', address: '169.254.10.20' }, { name: 'eth1', address: '169.254.200.1' }]), JSON.stringify(got));
}

function testFraming() {
    check('hsfz: 22 17 2A framed as deploy/transport sends it (length, control 1, F4 -> 63)',
        mi.hsfzFrame(Buffer.from('22172a', 'hex')).toString('hex') === '000000050001f46322172a');
    const ack = fromUnit(0x0002, Buffer.from('22172a', 'hex'));
    const pending = fromUnit(0x0001, Buffer.from('7f2278', 'hex'));
    const final = fromUnit(0x0001, did('169.254.1.2'));
    const all = Buffer.concat([ack, pending, final]);
    const part = mi.hsfzFrames(all.slice(0, all.length - 3));
    check('hsfz: complete frames parsed, a partial one kept for the next read',
        part.frames.length === 2 && part.frames[0].control === 2 && part.frames[1].payload.toString('hex') === '7f2278' && part.rest.length === final.length - 3,
        JSON.stringify(part));
    const whole = mi.hsfzFrames(all);
    check('hsfz: the payload is the UDS without the address bytes', whole.frames.length === 3 && whole.rest.length === 0 &&
        whole.frames[2].payload.equals(did('169.254.1.2')));
    check('did: 62 17 2A 00 A9 FE 01 02 is 169.254.1.2', mi.didAddress(did('169.254.1.2')) === '169.254.1.2');
    check('did: a negative or short answer is none', mi.didAddress(Buffer.from('7f2231', 'hex')) === null &&
        mi.didAddress(Buffer.from('62172a00a9fe', 'hex')) === null && mi.didAddress(Buffer.from('62f190', 'hex')) === null);
}

async function testBanner() {
    const greet = (text) => tcpServer((c) => {
        c.on('error', () => {});
        c.write(text);
    });
    const ssh = await greet('SSH-2.0-OpenSSH_7.8\r\n');
    const http = await greet('HTTP/1.1 400 Bad Request\r\n\r\n');
    const silent = await tcpServer((c) => c.on('error', () => {}));
    const closed = await tcpServer(() => {});
    const closedPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    check('banner: an SSH server\'s first line', await mi.sshBanner('127.0.0.1', ssh.address().port, '127.0.0.1') === 'SSH-2.0-OpenSSH_7.8');
    check('banner: another service is an answer without SSH (false)', await mi.sshBanner('127.0.0.1', http.address().port) === false);
    check('banner: a refused port is an answer without SSH (false)', await mi.sshBanner('127.0.0.1', closedPort) === false);
    const t0 = Date.now();
    check('banner: a silent port is none after the timeout', await mi.sshBanner('127.0.0.1', silent.address().port, null, 300) === null &&
        Date.now() - t0 < 3000);
    [ssh, http, silent].forEach((s) => s.close());
}

async function testHsfzNetwork() {
    const seen = [];
    const answers = { ok: [fromUnit(2, Buffer.from('22172a', 'hex')), fromUnit(1, Buffer.from('7f2278', 'hex')), fromUnit(1, did('169.254.1.2'))],
        negative: [fromUnit(1, Buffer.from('7f2231', 'hex'))] };
    let mode = 'ok';
    const srv = await tcpServer((c) => {
        c.on('error', () => {});
        c.once('data', (d) => {
            seen.push(d.toString('hex'));
            // the answer in pieces, as TCP may deliver it
            const out = Buffer.concat(answers[mode]);
            c.write(out.slice(0, 5));
            setTimeout(() => c.write(out.slice(5)), 20);
        });
    });
    const port = srv.address().port;
    check('did read: the reported address, acks and "response pending" skipped',
        await mi.hsfzHuAddress('127.0.0.1', '127.0.0.1', { port }) === '169.254.1.2');
    check('did read: sends 22 17 2A alone (no session change, no routine)', seen.join('|') === '000000050001f46322172a', seen);
    mode = 'negative';
    check('did read: a negative answer is none', await mi.hsfzHuAddress('127.0.0.1', null, { port }) === null);
    srv.close();

    const freePort = () => new Promise((resolve) => {
        const x = dgram.createSocket('udp4');
        x.bind(0, '127.0.0.1', () => {
            const p = x.address().port;
            x.close(() => resolve(p));
        });
    });
    const gateway = async (answer) => {
        const udp = dgram.createSocket('udp4');
        const got = [];
        await new Promise((r) => udp.bind(0, '127.0.0.1', r));
        const listen = await freePort();
        udp.on('message', (m, r) => {
            got.push({ data: m.toString('hex'), port: r.port });
            answer(udp, r, listen);
        });
        const gw = await mi.hsfzGateway('127.0.0.1', { to: ['127.0.0.1'], port: udp.address().port, from: 0, listen, timeout: 1500 });
        udp.close();
        return { gw, got };
    };
    const reply = Buffer.from('000000320004', 'hex');
    let g = await gateway((u, r) => u.send(reply, r.port, r.address));
    check('gateway: HSFZ identification (00 00 00 00 00 11), sent from the interface\'s address, answered names the gateway',
        g.gw === '127.0.0.1' && g.got[0] && g.got[0].data === '000000000011', JSON.stringify(g));
    g = await gateway((u, r, listen) => u.send(reply, listen, '127.0.0.1'));
    check('gateway: an answer to the gateway\'s port on all addresses (as a broadcast answer arrives) is heard',
        g.gw === '127.0.0.1', JSON.stringify(g));
    g = await gateway((u, r, listen) => u.send(Buffer.from('000000000011', 'hex'), listen, '127.0.0.1'));
    check('gateway: the request itself coming back is no answer', g.gw === null, JSON.stringify(g));
    const none = await mi.hsfzGateway('127.0.0.1', { to: ['127.0.0.1'], port: 9, from: 0, listen: await freePort(), timeout: 300 });
    check('gateway: no answer is none', none === null);
}

(async () => {
    testInterfaces();
    testFraming();
    await testOrder();
    await testBanner();
    await testHsfzNetwork();
    console.log(`connect_test: ${failed ? `${failed} failed` : 'done'}`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log(`not ok connect_test ran to the end\n  # ${e.stack}`);
    process.exit(1);
});
