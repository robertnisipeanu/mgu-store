'use strict';
/**
 * The updater's own uids (js/uids.js), on the unit's Node (8.16.2), as root:
 *   docker run --rm -v "$PWD:/w:ro" -w /w node:8.16.2-stretch node test/test_uids.js
 * Each case is a fixture unit: /etc, /proc, MainApp's config, the OAP root
 * and the uplink's folder under a temp folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ServiceUids, handOver } = require('../js/uids');

let failures = 0;
function ok(name, cond, detail) {
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail === undefined ? '' : `\n     ${detail}`}`);
    if (!cond) {
        failures++;
    }
}

function write(file, text) {
    mkdirp(path.dirname(file));
    fs.writeFileSync(file, text);
}

function mkdirp(dir) {
    if (!fs.existsSync(dir)) {
        mkdirp(path.dirname(dir));
        fs.mkdirSync(dir);
    }
}

function read(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (e) {
        return null;
    }
}

/* A unit like the car's: MainApp's stock ranges, system accounts around
 * them, MainApp at 12201, the uplink installed. */
function unit(opts) {
    opts = opts || {};
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'uids-'));
    const p = (rel) => path.join(T, rel);
    write(p('etc/passwd'), ['root:x:0:0::/root:/bin/sh', 'tm_12000:x:12000:12000::/:/bin/false',
        'cns_12701:x:12701:12701::/:/bin/false', 'cns_12705:x:12705:12705::/:/bin/false',
        'cia_13001:x:13001:13001::/:/bin/false'].concat(opts.passwd || []).join('\n') + '\n');
    write(p('etc/group'), ['root:x:0:', 'tm_oap_app:x:12202:', 'cns_12702:x:12702:', 'cns_12703:x:12703:',
        'cns_12704:x:12704:'].concat(opts.group || []).join('\n') + '\n');
    mkdirp(p('proc'));
    if (opts.base !== false) {
        write(p('mainapp/config/base.json'), JSON.stringify(opts.base || {
            usableUidsAndGids: { min: 12203, max: 12450 },
            usableUidsAndGidsRse: { left: { min: 12203, max: 12450 }, right: { min: 12453, max: 12700 } },
            mainAppUids: [12201, 12451]
        }));
    }
    const apps = p('oap/oap_12201/data/apps');
    mkdirp(apps);
    (opts.apps || [['store', 12205]]).forEach((a) => {
        write(path.join(apps, `${a[0]}.json`), JSON.stringify({ userId: a[1] }));
        mkdirp(p(`oap/oap_${a[1]}`));
    });
    mkdirp(p('opt/mgu-uplink/versions/0.5.2'));
    fs.symlinkSync('versions/0.5.2', p('opt/mgu-uplink/current'));
    const conf = Object.assign({
        state_dir: p('opt/mgu-updater/state'), tool_root: p('opt'), oap_root: p('oap'), mainapp_uid: '12201',
        uplink_tool: 'mgu-uplink', socket_group: 'tm_oap_app', etc_dir: p('etc'), proc_dir: p('proc'),
        mainapp_config: p('mainapp/config/base.json')
    }, opts.conf || {});
    return { T, p, conf };
}

function proc(u, pid, uid) {
    write(u.p(`proc/${pid}/status`), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
}

const stateOf = (u) => JSON.parse(read(path.join(u.conf.state_dir, 'uids.json')));
const dropIn = (u) => read(u.p('opt/mgu-uplink/uids.d/mgu-updater'));

/* MainApp's ranges known: the lowest free uids above them, outside every
 * range, past accounts, MainApp's own and running processes. */
{
    const u = unit({ passwd: ['spare:x:12452:12452::/:/bin/false'] });
    proc(u, 77, 12706);
    const changed = new ServiceUids(u.conf).ensure();
    const c = u.conf;
    ok('pick: above MainApp\'s ranges, past accounts, its own uids and processes',
        c.build_uid === '12707' && c.fetch_uid === '12708' && c.web_uid === '12709', JSON.stringify(c));
    ok('pick: build and fetch gids are their uids, web\'s is socket_group\'s',
        c.build_gid === '12707' && c.fetch_gid === '12708' && c.web_gid === '12202', JSON.stringify(c));
    ok('pick: kept in state_dir/uids.json', JSON.stringify(stateOf(u)) === '{"build":12707,"fetch":12708,"web":12709}');
    ok('pick: the first pick changes nothing that used another', changed.length === 0, changed);
    ok('pick: the fetch uid goes to internet-uids and the uplink\'s drop-in',
        read(path.join(c.state_dir, 'internet-uids')) === '12708\n' && dropIn(u) === '12708\n', dropIn(u));
}

/* An app on a previously fixed uid, and no MainApp config: MARGIN above
 * the highest app uid. */
{
    const u = unit({ base: false, apps: [['store', 12205], ['gauges', 12996]] });
    new ServiceUids(u.conf).ensure();
    ok('fallback: without MainApp\'s config, 500 above the highest app uid',
        u.conf.build_uid === '13496' && u.conf.fetch_uid === '13497' && u.conf.web_uid === '13498', JSON.stringify(u.conf));
}

/* Another start: the kept uids, even with processes of them running (ours). */
{
    const u = unit();
    new ServiceUids(u.conf).ensure();
    const fetch = u.conf.fetch_uid;
    proc(u, 90, fetch);
    const again = Object.assign({}, u.conf, { build_uid: undefined, build_gid: undefined, fetch_uid: undefined,
        fetch_gid: undefined, web_uid: undefined, web_gid: undefined });
    const changed = new ServiceUids(again).ensure();
    ok('keep: a later start uses the kept uids', again.fetch_uid === fetch && changed.length === 0, JSON.stringify(again));
}

/* A kept uid taken since: picked again, its dependants moved. */
{
    const u = unit();
    const uids = new ServiceUids(u.conf);
    uids.ensure();
    const before = stateOf(u);
    // a tool installed since gave the uplink the fetch uid; an app got the web uid
    write(u.p('opt/mgu-uplink/uids.d/net-tool'), `${before.fetch}\n`);
    write(u.p('oap/oap_12201/data/apps/late.json'), JSON.stringify({ userId: before.web }));
    const left = path.join(u.conf.state_dir, 'dl-left');
    write(path.join(left, 'part'), 'x');
    write(path.join(left, 'roots'), 'x');
    fs.symlinkSync('/etc/hostname', path.join(left, 'link'));
    if (process.getuid() === 0) {
        [left, path.join(left, 'part')].forEach((f) => fs.chownSync(f, before.fetch, before.fetch));
    }
    const changed = uids.ensure();
    const after = stateOf(u);
    ok('re-pick: the taken fetch and web uids are replaced, build kept',
        changed.join() === 'fetch,web' && after.build === before.build && after.fetch !== before.fetch &&
        after.web !== before.web && after.fetch > before.web, JSON.stringify({ changed, before, after }));
    ok('re-pick: the conf uses the new ones', u.conf.fetch_uid === String(after.fetch) && u.conf.web_uid === String(after.web));
    ok('re-pick: internet-uids and the uplink drop-in name the new fetch uid',
        read(path.join(u.conf.state_dir, 'internet-uids')) === `${after.fetch}\n` && dropIn(u) === `${after.fetch}\n`);
    ok('re-pick: another component\'s drop-in is left alone', read(u.p('opt/mgu-uplink/uids.d/net-tool')) === `${before.fetch}\n`);
    if (process.getuid() === 0) {
        handOver(u.conf, 'fetch');
        const st = fs.statSync(path.join(left, 'part'));
        ok('re-pick: a download folder the old fetch uid left is handed to the new one',
            st.uid === after.fetch && st.gid === after.fetch && fs.statSync(left).uid === after.fetch);
        ok('re-pick: root\'s own files there and what a link points at stay root\'s',
            fs.statSync(path.join(left, 'roots')).uid === 0 && fs.statSync('/etc/hostname').uid === 0);
    }
    // a third start sees the same
    const again = Object.assign({}, u.conf, { build_uid: '', fetch_uid: '', web_uid: '', build_gid: '', fetch_gid: '', web_gid: '' });
    ok('re-pick: kept across starts', new ServiceUids(again).ensure().length === 0 && again.fetch_uid === String(after.fetch));
}

/* A kept uid inside MainApp's range (the config grew): picked again. */
{
    const u = unit();
    write(path.join(u.conf.state_dir, 'uids.json'), '{"build":12300,"fetch":12990,"web":12996}\n');
    const changed = new ServiceUids(u.conf).ensure();
    ok('range: a kept uid MainApp may hand an app is replaced; the others kept',
        changed.join() === 'build' && u.conf.fetch_uid === '12990' && u.conf.web_uid === '12996' &&
        Number(u.conf.build_uid) > 12700, JSON.stringify(u.conf));
}

/* Overrides in updater.conf are used as they are. */
{
    const u = unit({ conf: { fetch_uid: '12990', fetch_gid: '12991', web_gid: '903' } });
    proc(u, 5, 12990);
    const uids = new ServiceUids(u.conf);
    uids.ensure();
    ok('override: fetch_uid and its gid used, the rest picked around them',
        u.conf.fetch_uid === '12990' && u.conf.fetch_gid === '12991' && u.conf.web_gid === '903' &&
        u.conf.build_uid === '12706' && u.conf.web_uid === '12707', JSON.stringify(u.conf));
    ok('override: the drop-in names it', dropIn(u) === '12990\n');
    write(u.p('oap/oap_12201/data/apps/clash.json'), JSON.stringify({ userId: 12990 }));
    ok('override: kept even when taken', uids.ensure().length === 0 && u.conf.fetch_uid === '12990');
}

/* Without the uplink installed: internet-uids only (the deploy tool writes
 * the drop-in when it installs the uplink). */
{
    const u = unit();
    fs.unlinkSync(u.p('opt/mgu-uplink/current'));
    new ServiceUids(u.conf).ensure();
    ok('no uplink: no drop-in, internet-uids written',
        dropIn(u) === null && read(path.join(u.conf.state_dir, 'internet-uids')) === `${u.conf.fetch_uid}\n`);
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
