#!/usr/bin/env node
'use strict';
/**
 * Offline tests of the deploy tool: deploy/hu artifact, and
 * deploy/unit/mgu-deploy.js against a fake root (MGU_DEPLOY_FAKE_ROOT=1,
 * every root and command pointed into a temporary tree, systemctl,
 * journalctl, ps and app-privacy replaced by the helpers beside this file).
 *
 *   node deploy/test/run.js
 *
 * Prints one "ok"/"not ok" line per check; exits 1 when any check fails.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const cp = require('child_process');
const { tgz } = require('../../tools/oap_pack.js');
const link = require('../../tools/oap_link.js');
const donor = require('../../tools/test/synthetic_donor.js');

const HERE = __dirname;
const HU = path.join(HERE, '..', 'hu');
const UNIT_JS = path.join(HERE, '..', 'unit', 'mgu-deploy.js');
// the Node the unit's code runs under (deploy/test/run.sh: the unit's 8.16.2)
const UNIT_NODE = process.env.MGU_TEST_UNIT_NODE || process.execPath;
const DEPLOY = path.join(HERE, '..');
const VERSION = /var VERSION = '([^']+)'/.exec(fs.readFileSync(UNIT_JS, 'utf8'))[1];
// a deploy tool one patch version newer than this one
const NEXT = VERSION.replace(/\d+$/, (p) => String(Number(p) + 1));
const FIXTURE_TOOL = path.join(HERE, 'fixtures', 'fixture-tool');
const TOOLS = path.join(HERE, '..', '..', 'tools');
// the linker and packer the deploy tool ships (tools/)
const LINK_FILES = ['oap_link.js', 'oap_pack.js'];
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-deploy-test-'));
const MGR = 12201;
const PENDING = 'recmgr entry takes effect after reboot';
const CLASS_ANCHOR = 'class ProvisioningNotifier ';
const HOOK_ANCHOR = 'isMainapp&&section===mainAppSection&&(newProvisioning.';
const INPLACE_ANCHOR = 'mainApp.init()}).then(()=>{';

let n = 0;
let failed = 0;

function check(name, cond, detail) {
    n += 1;
    if (cond) {
        console.log(`ok ${n} - ${name}`);
    } else {
        failed += 1;
        console.log(`not ok ${n} - ${name}${detail ? `\n  # ${String(detail).split('\n').join('\n  # ')}` : ''}`);
    }
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function write(p, data, mode) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    if (mode !== undefined) {
        fs.chmodSync(p, mode);
    }
}

function mode(p) {
    return fs.lstatSync(p).mode & 0o7777;
}

function lstatOrNullT(p) {
    try {
        return fs.lstatSync(p);
    } catch (e) {
        return null;
    }
}

/* Path, type, mode and content of everything below dir, except paths the
 * skip function names; equal hashes mean equal trees. */
function treeHash(dir, skip) {
    const lines = [];
    (function walk(d, rel) {
        if (!fs.existsSync(d)) {
            return;
        }
        fs.readdirSync(d).sort().forEach((name) => {
            const p = path.join(d, name);
            const r = rel ? `${rel}/${name}` : name;
            if (skip && skip(r)) {
                return;
            }
            const st = fs.lstatSync(p);
            if (st.isSymbolicLink()) {
                lines.push(`${r} link ${fs.readlinkSync(p)}`);
            } else if (st.isDirectory()) {
                lines.push(`${r} dir ${(st.mode & 0o7777).toString(8)}`);
                walk(p, r);
            } else {
                lines.push(`${r} file ${(st.mode & 0o7777).toString(8)} ${sha256(fs.readFileSync(p))}`);
            }
        });
    }(dir, ''));
    return { hash: sha256(lines.join('\n')), lines };
}

function treeDiff(a, b) {
    const sa = new Set(a.lines);
    const sb = new Set(b.lines);
    return a.lines.filter((l) => !sb.has(l)).map((l) => `- ${l}`)
        .concat(b.lines.filter((l) => !sa.has(l)).map((l) => `+ ${l}`)).join('\n');
}

/* A gzipped ustar archive whose entries may be symlinks ({ name, link }),
 * for artifacts the packer would never write. */
function rawTgz(entries) {
    const parts = [];
    entries.forEach((e) => {
        const data = e.data || Buffer.alloc(0);
        const h = Buffer.alloc(512);
        const octal = (v, w) => v.toString(8).padStart(w - 1, '0') + '\0';
        h.write(e.name, 0, 100);
        h.write(octal(e.mode || 0o644, 8), 100);
        h.write(octal(0, 8), 108);
        h.write(octal(0, 8), 116);
        h.write(octal(e.link ? 0 : data.length, 12), 124);
        h.write(octal(1700000000, 12), 136);
        h.write('        ', 148);
        h.write(e.link ? '2' : '0', 156);
        if (e.link) {
            h.write(e.link, 157, 100);
        }
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (let i = 0; i < 512; i += 1) {
            sum += h[i];
        }
        h.write(octal(sum, 7) + ' ', 148);
        parts.push(h);
        if (!e.link) {
            parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
        }
    });
    parts.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(parts));
}

/* Members of a tgz as { name: Buffer }. */
function untar(file) {
    const dir = fs.mkdtempSync(path.join(T, 'x-'));
    cp.execFileSync('tar', ['-xzf', file, '-C', dir]);
    const out = {};
    (function walk(d, rel) {
        fs.readdirSync(d).sort().forEach((name) => {
            const p = path.join(d, name);
            const r = rel ? `${rel}/${name}` : name;
            if (fs.statSync(p).isDirectory()) {
                walk(p, r);
            } else {
                out[r] = { data: fs.readFileSync(p), mode: mode(p) };
            }
        });
    }(dir, ''));
    return out;
}

/* Members of gzipped tar bytes, as { name: Buffer }. */
function untarBuf(buf) {
    const out = {};
    link.untar(buf).forEach((m) => { out[m.name] = m.data; });
    return out;
}

function tarList(file) {
    return cp.execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

/* ---- deploy/hu artifact ----------------------------------------------------------- */

function hu(args, env) {
    return cp.spawnSync(process.execPath, [HU].concat(args),
        { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
}

/* A copy of the fixture tool at the given version, in its own folder. */
function fixtureCopy(version, edit) {
    const dir = path.join(fs.mkdtempSync(path.join(T, 'src-')), 'fixture-tool');
    cp.execFileSync('cp', ['-R', FIXTURE_TOOL, dir]);
    const c = readJson(path.join(dir, 'component.json'));
    c.version = version;
    if (edit) {
        edit(c);
    }
    fs.writeFileSync(path.join(dir, 'component.json'), JSON.stringify(c, null, 2) + '\n');
    return dir;
}

const artifactCache = {};
function toolArtifact(version) {
    if (!artifactCache[version]) {
        const out = fs.mkdtempSync(path.join(T, 'art-'));
        const r = hu(['artifact', fixtureCopy(version), '--out', out]);
        if (r.status !== 0) {
            throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
        }
        artifactCache[version] = path.join(out, `fixture-tool@${version}.tgz`);
    }
    return artifactCache[version];
}

function testArtifact() {
    const src = fixtureCopy('0.2.0');
    const runs = ['a', 'b'].map((k) => {
        const out = path.join(T, `det-${k}`);
        const r = hu(['artifact', src, '--out', out]);
        return { r, file: path.join(out, 'fixture-tool@0.2.0.tgz') };
    });
    check('artifact: deploy/hu artifact exits 0', runs.every((x) => x.r.status === 0), runs.map((x) => x.r.stderr).join('\n'));
    const [a, b] = runs.map((x) => sha256(fs.readFileSync(x.file)));
    check('artifact: two builds of one tree are byte-identical', a === b, `${a} vs ${b}`);
    check('artifact: the gzip header names Unix, whatever the build machine',
        fs.readFileSync(runs[0].file)[9] === 3);
    check('artifact: prints its path and sha256', runs[0].r.stdout.includes(runs[0].file) && runs[0].r.stdout.includes(a));
    check('artifact: members sorted, as listed', JSON.stringify(tarList(runs[0].file)) === JSON.stringify([
        'component.json', 'files/bin/fixture-tool', 'files/fixture-tool.conf', 'files/lib/helper.js',
        'units/fixture-tool.service', 'units/fixture-tool.socket']), tarList(runs[0].file).join(' '));
    const m = untar(runs[0].file);
    const c = JSON.parse(m['component.json'].data);
    check('artifact: component.json has sha256 per file and no source paths',
        c.files.every((f) => f.sha256 === sha256(m[`files/${f.path}`].data) && !('from' in f)) &&
        !('build' in c) && JSON.stringify(c.units) === JSON.stringify([{ name: 'fixture-tool.socket' }, { name: 'fixture-tool.service' }]) &&
        c.id === 'fixture-tool' && c.version === '0.2.0' && c.kind === 'tool' && c.restart[0] === 'fixture-tool.service',
        JSON.stringify(c));
    check('artifact: payload modes as listed',
        m['files/bin/fixture-tool'].mode === 0o755 && m['files/lib/helper.js'].mode === 0o644 &&
        m['units/fixture-tool.service'].mode === 0o644 && m['component.json'].mode === 0o644);
    const epoch = ['e1', 'e2'].map((k) => {
        const out = path.join(T, `det-${k}`);
        hu(['artifact', src, '--out', out], { SOURCE_DATE_EPOCH: '1700000000' });
        return sha256(fs.readFileSync(path.join(out, 'fixture-tool@0.2.0.tgz')));
    });
    check('artifact: SOURCE_DATE_EPOCH sets the mtime, reproducibly', epoch[0] === epoch[1] && epoch[0] !== a);
    const noBuild = fixtureCopy('0.2.0', (x) => { x.build = ['sh', '-c', 'true']; });
    const r = hu(['artifact', noBuild, '--out', path.join(T, 'det-missing')]);
    check('artifact: a missing build output fails naming the build command',
        r.status === 1 && r.stderr.includes('build/fixture-tool is missing') && r.stderr.includes('sh -c true'), r.stderr);
    const badId = fixtureCopy('0.2.0', (x) => { x.id = 'Bad_Id'; });
    check('artifact: refuses a component.json with a bad id',
        hu(['artifact', badId, '--out', path.join(T, 'det-badid')]).status === 1);
    const other = fixtureCopy('0.2.0', (x) => { x.id = 'renamed-tool'; });
    const ro = hu(['artifact', other, '--out', path.join(T, 'det-renamed')]);
    check('artifact: takes any folder with a component.json, named by its id',
        ro.status === 0 && fs.existsSync(path.join(T, 'det-renamed', 'renamed-tool@0.2.0.tgz')), ro.stderr);
}

/* ---- fake root ----------------------------------------------------------------------- */

function stockMain() {
    return fs.readFileSync(path.join(HERE, 'fixtures', 'main.js'), 'utf8');
}

/* A fresh fake unit: /etc with passwd, group, systemd and the recmgr list,
 * the app manager's tree with one stock app installed, /proc facts. */
function fakeRoot(opts) {
    opts = opts || {};
    const R = fs.mkdtempSync(path.join(T, 'root-'));
    const p = (rel) => path.join(R, rel);
    write(p('etc/passwd'), 'root:x:0:0::/root:/bin/sh\noapmgr:x:12201:12201::/:/bin/false\n');
    write(p('etc/group'), 'mgu_wayland:x:900:\ntm_oap_app:x:901:\n');
    // opts.recmgr: names recmgr loaded at this boot
    const listed = ['stockd'].concat(opts.recmgr || []).join('\n');
    const btime = opts.btime || Math.floor(Date.now() / 1000) - 3600;
    write(p('etc/recmgr-restartlist.conf'), `[Whitelist]\n${listed}\n\n[WhitelistExitSuccess]\n${listed}\n\n[ForceRestartList]\ndbus\n\n[Other]\nkeepme\n`);
    fs.utimesSync(p('etc/recmgr-restartlist.conf'), btime - 100, btime - 100);
    write(p('etc/systemd/system/stock.service'), '[Service]\nExecStart=/bin/true\n');
    if (!opts.noWants) {
        fs.mkdirSync(p('etc/systemd/system/sockets.target.wants'));
        fs.mkdirSync(p('etc/systemd/system/multi-user.target.wants'));
    }
    write(p('proc/stat'), `cpu 0 0 0 0\nbtime ${btime}\n`);
    write(p('proc/mounts'), 'rootfs / ext4 ro,relatime 0 0\n');
    write(p('proc/boot_id'), 'boot-1\n');
    write(p('usr/lib/oap-mainapp/src/main.js'), opts.main || stockMain());
    write(p('usr/lib/oap-mainapp/config/base.json'), JSON.stringify({
        usableUidsAndGids: { min: 13000, max: 13010 },
        certificateManagerGids: [902, 903],
        accessGroups: { necemaAccessGroup: 904 },
        navi: { resourceAccessGroup: 905 },
        dumm: { resourceAccessGroup: 906 },
        mainAppSourceFolder: '/usr/lib/oap-mainapp/',
        appManagement: { ignoreSignatureFailure: false }
    }, null, 2) + '\n');
    // opts.mainapp811: MainApp 8.1.1 or 8.2.10, whose AppManagement.js names no installationSource
    if (opts.mainapp811) write(p('usr/lib/oap-mainapp/src/AppManagement/AppManagement.js'), 'class AppManager{}\n');
    write(p('usr/lib/oap-mainapp/preinstalled_apps/stock_app@2.0.0.tgz'), 'stock package\n');
    write(p(`var/opt/public/oap/oap_${MGR}/data/apps/stock_app.json`), JSON.stringify({ userId: 13000,
        provisioningCache: { '-enabled': 'true', '-allowed': 'true' }, installationSource: 'PREINSTALLED' }), 0o660);
    write(p('var/opt/public/oap/oap_13000/source/package.json'), JSON.stringify({ name: 'stock_app', version: '2.0.0' }) + '\n');
    write(p('var/opt/public/oap/oap_13000/someipInterfaces/acl.json'), '{}\n');
    write(p('var/opt/public/oap/oap_13000/security/joynrKeyChain.json'), '{}\n');
    write(p(`var/opt/public/oap/oap_${MGR}/security/uids.txt`), '13000=stock_app\n');
    fs.mkdirSync(p('dev/shm'), { recursive: true });
    // the app manager's node child, up since boot unless told otherwise
    const pidFile = `${R}.mgr.pid`;
    fs.writeFileSync(pidFile, opts.noManager ? '' : '4000');
    write(p('proc/4000/stat'), `4000 (node) S 1 4000 4000 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${opts.managerTicks || 0} 0 0\n`);
    const log = p('systemctl.log');
    const units = `${R}.units`;
    fs.mkdirSync(units);
    const env = Object.assign({}, process.env, {
        MGU_DEPLOY_FAKE_ROOT: '1',
        MGU_DEPLOY_VAR_OPT: p('var/opt'),
        MGU_DEPLOY_SYSTEMD: p('etc/systemd/system'),
        MGU_DEPLOY_RECMGR: p('etc/recmgr-restartlist.conf'),
        MGU_DEPLOY_CRASHLIST: p('etc/crashhandler-restartlist.conf'),
        MGU_DEPLOY_MAINAPP: p('usr/lib/oap-mainapp'),
        MGU_DEPLOY_MAINAPP21: p('usr/lib/oap-mainapp21'),
        MGU_DEPLOY_PROV: p('usr/share/tm/prov'),
        MGU_DEPLOY_VMINPUT: p('usr/bin/vminput'),
        MGU_DEPLOY_OAP: p('var/opt/public/oap'),
        MGU_DEPLOY_ETC: p('etc'),
        MGU_DEPLOY_ROOTFS: R,
        MGU_DEPLOY_PROC: p('proc'),
        MGU_DEPLOY_PROC_STAT: p('proc/stat'),
        MGU_DEPLOY_PROC_MOUNTS: p('proc/mounts'),
        MGU_DEPLOY_RUN: p('run/mgu-deploy'),
        MGU_DEPLOY_CODING: p('dev/shm/rawcodingdata'),
        MGU_DEPLOY_BOOT_ID: p('proc/boot_id'),
        MGU_DEPLOY_SYSTEMCTL: path.join(HERE, 'fake_systemctl.sh'),
        MGU_DEPLOY_JOURNALCTL: path.join(HERE, 'fake_journalctl.sh'),
        MGU_DEPLOY_PS: path.join(HERE, 'fake_ps.sh'),
        MGU_DEPLOY_KILL: path.join(HERE, 'fake_kill.sh'),
        MGU_DEPLOY_SYNC: path.join(HERE, 'fake_sync.sh'),
        MGU_DEPLOY_LOGGER: 'true',
        MGU_DEPLOY_STOCK_UNITS: p('lib/systemd/system'),
        MGU_DEPLOY_STOCK_BINS: `${p('bin')}:${p('usr/bin')}`,
        FAKE_SYNC_LOG: `${R}.sync.log`,
        MGU_DEPLOY_BOUNCE_MIN_UP_S: String(opts.minUp || 0),
        MGU_DEPLOY_BOUNCE_TIMEOUT_MS: '3000',
        MGU_DEPLOY_GUARD_WATCH_S: '0',
        MGU_DEPLOY_WATCH_POLL_MS: '20',
        MGU_DEPLOY_WATCH_TIMEOUT_MS: '3000',
        FAKE_MGR_PIDFILE: pidFile,
        FAKE_MGR_LOG: `${R}.manager.log`,
        MGU_DEPLOY_NODE: UNIT_NODE,
        // the stand-ins run on the harness's Node
        FAKE_NODE: process.execPath,
        // opts.privacy false: app-privacy is whatever tool is installed
        MGU_DEPLOY_PRIVACY: opts.privacy === false ? '' : path.join(HERE, 'fake_privacy.js'),
        FAKE_MGR_NO_KEYCHAIN: opts.noKeychain ? '1' : '',
        FAKE_MGR_NO_SOURCE: opts.mainapp811 ? '1' : '',
        FAKE_MGR_SECTIONS: `${R}.sections.json`,
        MGU_DEPLOY_BRIDGE_SOCKET: p('dev/shm/display-bridge/bridge.sock'),
        FAKE_SYSTEMCTL_LOG: log,
        FAKE_PRIVACY_LOG: `${R}.privacy.log`,
        FAKE_ACTIVE: opts.active || '',
        FAKE_UNITS: units,
        FAKE_FAIL: opts.fail || '',
        FAKE_PRIVACY_STOCK_MAIN: path.join(HERE, 'fixtures', 'main.js'),
        FAKE_PRIVACY_STOCK_APPMANAGEMENT: `${R}.stock-appmanagement.js`,
        MGU_DEPLOY_MIGRATE_SETTLE_MS: '50',
        MGU_DEPLOY_HEALTH_MS: '50'
    });
    const root = {
        R, p, env, log,
        run(args, extra) {
            const r = cp.spawnSync(UNIT_NODE, [UNIT_JS].concat(args),
                { encoding: 'utf8', env: Object.assign({}, env, extra || {}), input: '' });
            r.out = `${r.stdout}${r.stderr}`;
            return r;
        },
        status() {
            const r = root.run(['status', '--json']);
            return JSON.parse(r.stdout);
        },
        managerLog() {
            return fs.existsSync(`${R}.manager.log`) ? fs.readFileSync(`${R}.manager.log`, 'utf8').split('\n').filter(Boolean) : [];
        },
        kills() {
            return root.managerLog().filter((l) => l.startsWith('kill ')).map((l) => {
                const f = l.split(' ');
                return { pid: Number(f[1]), at: Number(f[2]), homes: f[4] ? f[4].split(',') : [] };
            });
        },
        managerPid: () => Number(fs.readFileSync(pidFile, 'utf8')),
        setManagerStart(epochS) {
            const pid = root.managerPid();
            const btime = Number(/btime (\d+)/.exec(fs.readFileSync(p('proc/stat'), 'utf8'))[1]);
            write(p(`proc/${pid}/stat`), `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${Math.round((epochS - btime) * 100)} 0 0\n`);
        },
        unitFile: (name) => path.join(units, name),
        systemctlCalls() {
            return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
        },
        hash(skip) {
            return treeHash(R, (rel) => rel === 'systemctl.log' || rel === 'proc' || rel.startsWith('proc/') ||
                (skip ? skip(rel) : false));
        },
        reboot(t) {
            write(p('proc/stat'), `cpu 0 0 0 0\nbtime ${t}\n`);
            write(p('proc/boot_id'), `boot-${t}\n`);
        },
        tool: (id) => p(`var/opt/${id}`),
        entry: (id) => p(`var/opt/public/oap/oap_${MGR}/data/apps/${id}.json`),
        home: (uid) => p(`var/opt/public/oap/oap_${uid}`),
        preinstalled: (id, v) => p(`usr/lib/oap-mainapp/preinstalled_apps/${id}@${v}.tgz`),
        state: () => readJson(p('var/opt/mgu-deploy/state.json'))
    };
    return root;
}

/* A flat OAP app package, packed the way tools/oap_pack.js packs. */
function appArtifact(name, version, marked, extra) {
    const pkg = Object.assign({ name, version, description: 'deploy test app', files: ['javascript'] }, extra);
    if (marked) {
        pkg.mguLocalOnly = true;
    }
    const file = path.join(fs.mkdtempSync(path.join(T, 'app-')), `${name}@${version}.tgz`);
    fs.writeFileSync(file, tgz([
        { name: 'javascript/app.js', data: Buffer.from(`console.log(${JSON.stringify(name + ' ' + version)});\n`), mode: 0o644 },
        { name: 'package.json', data: Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), mode: 0o644 }
    ], 1700000000));
    return file;
}

/* ---- refusals ------------------------------------------------------------------------- */

function rebuild(file, change) {
    const m = untar(file);
    const entries = Object.keys(m).sort().map((name) => ({ name, data: m[name].data, mode: m[name].mode }));
    const out = path.join(fs.mkdtempSync(path.join(T, 'bad-')), path.basename(file));
    fs.writeFileSync(out, change(entries));
    return out;
}

function testRefusals() {
    const good = toolArtifact('0.2.0');
    const withComponent = (edit) => (entries) => tgz(entries.map((e) => {
        if (e.name !== 'component.json') {
            return e;
        }
        const c = JSON.parse(e.data);
        edit(c);
        return Object.assign({}, e, { data: Buffer.from(JSON.stringify(c, null, 2)) });
    }), 1700000000);
    const cases = [
        ['corrupt sha256', rebuild(good, withComponent((c) => { c.files[0].sha256 = '0'.repeat(64); })), 'sha256 mismatch'],
        ['missing sha256', rebuild(good, withComponent((c) => { delete c.files[1].sha256; })), 'missing sha256'],
        ['member path with ..', rebuild(good, (entries) => tgz(entries.concat([{ name: 'files/../../evil', data: Buffer.from('x'), mode: 0o644 }]), 1700000000)), 'unsafe path'],
        ['files[].path with ..', rebuild(good, withComponent((c) => { c.files[0].path = '../bin/fixture-tool'; })), 'bad files[].path'],
        ['symlink entry', rebuild(good, (entries) => rawTgz(entries.concat([{ name: 'files/link', link: '/etc/passwd' }]))), 'symlink in artifact'],
        ['missing files/ payload', rebuild(good, (entries) => tgz(entries.filter((e) => e.name !== 'files/lib/helper.js'), 1700000000)), 'payload missing files/lib/helper.js'],
        ['unknown start type', appArtifact('start_app', '1.0.0', true, { mguAppStartType: 'boot' }), 'mguAppStartType is not one of']
    ];
    cases.forEach(([what, file, why]) => {
        const root = fakeRoot();
        const before = root.hash();
        const r = root.run(['install', '--artifact', file, '--yes']);
        const after = root.hash();
        check(`refusal: install of an artifact with ${what} exits 2 (${why})`, r.status === 2 && r.out.includes(why), r.out);
        check(`refusal: ${what} leaves the fake root unchanged`, before.hash === after.hash, treeDiff(before, after));
        const c = root.run(['check', '--artifact', file]);
        check(`refusal: check reports ${what}, exit 2, nothing changed`, c.status === 2 && c.out.includes(why) &&
            root.hash().hash === before.hash, `${c.out}\n${treeDiff(before, root.hash())}`);
    });
    const root = fakeRoot();
    const before = root.hash();
    const c = root.run(['check', '--artifact', good]);
    check('check: a valid artifact is reported with what it would touch', c.status === 0 &&
        c.stdout.includes('tool fixture-tool 0.2.0 ok') && c.stdout.includes('would touch'), c.out);
    check('check: changes nothing', root.hash().hash === before.hash, treeDiff(before, root.hash()));
}

/* ---- tool install ------------------------------------------------------------------- */

function versionsOf(root) {
    return fs.readdirSync(path.join(root.tool('fixture-tool'), 'versions')).sort();
}

function testToolInstall() {
    const root = fakeRoot();
    const r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('tool: install exits 0', r.status === 0, r.out);
    const dir = root.tool('fixture-tool');
    const v = path.join(dir, 'versions', '0.2.0');
    check('tool: current -> versions/0.2.0', fs.readlinkSync(path.join(dir, 'current')) === 'versions/0.2.0');
    check('tool: component.json in the version folder', readJson(path.join(v, 'component.json')).version === '0.2.0');
    check('tool: file modes as listed, folders 0755',
        mode(path.join(v, 'bin/fixture-tool')) === 0o755 && mode(path.join(v, 'lib/helper.js')) === 0o644 &&
        mode(path.join(v, 'fixture-tool.conf')) === 0o644 && mode(path.join(v, 'bin')) === 0o755 &&
        mode(path.join(v, 'lib')) === 0o755);
    const sys = root.p('etc/systemd/system');
    check('tool: units installed 0644 with the artifact bytes',
        fs.readFileSync(path.join(sys, 'fixture-tool.service'), 'utf8') ===
        fs.readFileSync(path.join(FIXTURE_TOOL, 'systemd/fixture-tool.service'), 'utf8') &&
        mode(path.join(sys, 'fixture-tool.socket')) === 0o644);
    check('tool: socket enabled in sockets.target.wants',
        fs.readlinkSync(path.join(sys, 'sockets.target.wants/fixture-tool.socket')) === '../fixture-tool.socket');
    const rec = fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
    check('tool: recmgr lists it in both sections, other content kept',
        /\[Whitelist\][^[]*fixture-tool/.test(rec) && /\[WhitelistExitSuccess\][^[]*fixture-tool/.test(rec) &&
        /\[Other\]\nkeepme/.test(rec) && (rec.match(/stockd/g) || []).length === 2, rec);
    const calls = root.systemctlCalls();
    const pending = JSON.parse(root.run(['status', '--json']).out).pending_reboot;
    check('tool: daemon-reload; the socket waits for the boot that loads its new recmgr entry',
        calls.indexOf('daemon-reload') >= 0 && !calls.includes('start fixture-tool.socket') &&
        pending.some((p) => p.id === 'fixture-tool' && p.reason === 'starts at the next boot'),
        calls.join('; ') + ' ' + JSON.stringify(pending));
    root.reboot(Math.floor(Date.now() / 1000) + 2);
    const booted = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('tool: after that boot a reinstall starts the socket',
        booted.status === 0 && root.systemctlCalls().includes('start fixture-tool.socket'), booted.out);
    check('tool: the deploy tool installs itself as a tool beside its state',
        fs.readlinkSync(root.p('var/opt/mgu-deploy/current')) === `versions/${VERSION}` &&
        fs.existsSync(root.p(`var/opt/mgu-deploy/versions/${VERSION}/mgu-deploy.js`)) &&
        fs.existsSync(root.p('var/opt/mgu-deploy/state.json')));

    const noBackups = (rel) => rel.startsWith('var/opt/mgu-deploy/backups');
    const before = root.hash(noBackups);
    const callsBefore = root.systemctlCalls().length;
    const again = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const after = root.hash(noBackups);
    check('tool: reinstalling the same artifact exits 0 and changes nothing', again.status === 0 &&
        before.hash === after.hash, `${again.out}\n${treeDiff(before, after)}`);
    check('tool: reinstalling reloads no units', !root.systemctlCalls().slice(callsBefore).includes('daemon-reload'));

    root.run(['install', '--artifact', toolArtifact('0.3.0'), '--yes']);
    check('tool: after 0.3.0, both versions kept', versionsOf(root).join(' ') === '0.2.0 0.3.0', versionsOf(root).join(' '));
    // the supervisor's rollback: current back to the previous version
    fs.unlinkSync(path.join(dir, 'current'));
    fs.symlinkSync('versions/0.2.0', path.join(dir, 'current'));
    const r3 = root.run(['install', '--artifact', toolArtifact('0.3.1'), '--yes']);
    check('tool: after a rollback to 0.2.0, installing 0.3.1 keeps 0.3.1 and 0.2.0',
        r3.status === 0 && versionsOf(root).join(' ') === '0.2.0 0.3.1', `${versionsOf(root).join(' ')}\n${r3.out}`);
    check('tool: current -> versions/0.3.1', fs.readlinkSync(path.join(dir, 'current')) === 'versions/0.3.1');

    const st = root.status();
    const t = st.components.find((c) => c.id === 'fixture-tool');
    check('status: the tool with its version and units', t && t.kind === 'tool' && t.version === '0.3.1' &&
        t.units.length === 2 && t.units[0].journal.length === 1, JSON.stringify(t));
}

/* ---- pending reboot -------------------------------------------------------------------- */

function testPendingReboot() {
    const now = Math.floor(Date.now() / 1000);
    const root = fakeRoot({ btime: now - 1000, active: 'fixture-tool.service' });
    const r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('pending: install exits 0', r.status === 0, r.out);
    check('pending: a recmgr list written after boot restarts nothing',
        !root.systemctlCalls().some((c) => /^(restart|stop) /.test(c)), root.systemctlCalls().join('; '));
    let st = root.status();
    check('pending: status --json lists {id, reason}', st.pending_reboot.some((p) =>
        p.id === 'fixture-tool' && p.reason === PENDING && Object.keys(p).join(',') === 'id,reason'), JSON.stringify(st.pending_reboot));

    // the unit reboots: the recmgr list now predates the boot
    fs.utimesSync(root.p('etc/recmgr-restartlist.conf'), now - 500, now - 500);
    root.reboot(now - 100);
    st = root.status();
    check('pending: after a reboot nothing is pending', st.pending_reboot.length === 0, JSON.stringify(st.pending_reboot));
    const r2 = root.run(['install', '--artifact', toolArtifact('0.3.0'), '--yes']);
    check('pending: with the recmgr list loaded at boot, the service restarts',
        r2.status === 0 && root.systemctlCalls().includes('restart fixture-tool.service'), `${r2.out}\n${root.systemctlCalls().join('; ')}`);
    st = root.status();
    check('pending: and nothing is pending afterwards', st.pending_reboot.length === 0, JSON.stringify(st.pending_reboot));
    const callsBefore = root.systemctlCalls().length;
    const r3 = root.run(['install', '--artifact', toolArtifact('0.3.0'), '--yes']);
    check('pending: reinstalling the running version restarts nothing', r3.status === 0 &&
        !root.systemctlCalls().slice(callsBefore).some((c) => /^(restart|stop) /.test(c)), root.systemctlCalls().slice(callsBefore).join('; '));

    // another tool rewrites the list in this boot: entries loaded at boot still count
    root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    const n = root.systemctlCalls().length;
    const r4 = root.run(['install', '--artifact', toolArtifact('0.3.1'), '--yes']);
    st = root.status();
    check('pending: after another tool rewrote the list this boot, a tool listed at boot still restarts',
        r4.status === 0 && root.systemctlCalls().slice(n).includes('restart fixture-tool.service') &&
        !st.pending_reboot.some((p) => p.id === 'fixture-tool'), `${r4.out}\n${JSON.stringify(st.pending_reboot)}`);
    check('pending: and the tool first listed this boot waits for the next one',
        st.pending_reboot.some((p) => p.id === 'app-privacy' && p.reason === PENDING), JSON.stringify(st.pending_reboot));
}

/* ---- apps ---------------------------------------------------------------------------------- */

function testApps() {
    const root = fakeRoot();
    const base = fs.readFileSync(root.p('usr/lib/oap-mainapp/config/base.json'));
    const sys = root.p('etc/systemd/system');
    const custom = () => readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
    check('app: the fallback starts off', !fs.existsSync(path.join(sys, 'mgu-app-fallback.service')));
    const app = appArtifact('fixture_app', '1.0.0', true);
    const r = root.run(['install', '--artifact', app, '--yes']);
    check('app: fresh install exits 0', r.status === 0, r.out);
    const entry = readJsonOrNull(root.entry('fixture_app')) || {};
    check('app: the manager chose the lowest free uid', entry.userId === 13001, JSON.stringify(entry));
    check('app: installed by the (simulated) app manager',
        entry.installationSource === 'PREINSTALLED' &&
        readJson(path.join(root.home(13001), 'source/package.json')).version === '1.0.0' &&
        fs.existsSync(path.join(root.home(13001), 'source/javascript/app.js')) &&
        root.managerLog().includes('install fixture_app 1.0.0 uid 13001'), `${root.managerLog().join('\n')}\n${r.out}`);
    const kills = root.kills();
    check('app: the tool wrote no app home before the manager did (one bounce, no oap_13001 at it)',
        kills.length === 1 && !kills[0].homes.includes('oap_13001') && kills[0].homes.includes('oap_13000'),
        JSON.stringify(kills));
    check('app: no 0.0.1 seed and no tool-minted credentials',
        !r.out.includes('0.0.1') && !r.out.includes('minting') && !r.out.includes('seeded'), r.out);
    check('app: package placed in preinstalled_apps',
        sha256(fs.readFileSync(root.preinstalled('fixture_app', '1.0.0'))) === sha256(fs.readFileSync(app)));
    check('app: keychain present (written by the manager)', fs.existsSync(path.join(root.home(13001), 'security/joynrKeyChain.json')));
    check('app: installing turned the fallback on, and says so',
        fs.existsSync(path.join(sys, 'mgu-app-fallback.service')) &&
        fs.readlinkSync(path.join(sys, 'multi-user.target.wants/mgu-app-fallback.service')) === '../mgu-app-fallback.service' &&
        fs.existsSync(root.p('var/opt/mgu-deploy/main.js')) && r.out.includes('provisioning fallback turned on'), r.out);
    check('app: custom_apps.json lists the app with its provisioning flags',
        JSON.stringify(Object.keys(custom())) === '["fixture_app"]' && custom().fixture_app['-enabled'] === 'true', JSON.stringify(custom()));
    check('app: deploy state records the app\'s uid and version',
        JSON.stringify(root.state().apps.fixture_app) === JSON.stringify({ uid: 13001, version: '1.0.0' }), JSON.stringify(root.state()));
    let st = root.status();
    const a = st.components.find((c) => c.id === 'fixture_app');
    check('status: the app with version, uid and tile fields', a && a.kind === 'app' && a.version === '1.0.0' &&
        a.uid === 13001 && st.fallback.manager_runs_copy === false && a.tile_provisioned === false && a.tile_fallback === false &&
        a.tile_visible === false &&
        a.installationSource === 'PREINSTALLED', JSON.stringify(a));
    check('app: a unit without the retired installer\'s leftovers has no migration snapshot and reports none',
        !fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).some((d) => d.endsWith('-migrate')) &&
        Array.isArray(st.retired_leftovers) && st.retired_leftovers.length === 0 && !r.out.includes('retired'), r.out);

    const noBackups = (rel) => rel.startsWith('var/opt/mgu-deploy/backups');
    const before = root.hash(noBackups);
    const same = root.run(['install', '--artifact', app, '--yes']);
    check('app: the same version again is already installed, exit 0, nothing changed',
        same.status === 0 && same.stdout.includes('already installed') && root.hash(noBackups).hash === before.hash, same.out);

    const r2 = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('app: update keeps the uid and installs the new version through the manager\'s update', r2.status === 0 &&
        readJson(root.entry('fixture_app')).userId === 13001 &&
        readJson(path.join(root.home(13001), 'source/package.json')).version === '1.1.0' &&
        root.managerLog().includes('update fixture_app 1.1.0 uid 13001'), `${r2.out}\n${root.managerLog().join('\n')}`);
    check('app: update removes the old preinstalled package',
        !fs.existsSync(root.preinstalled('fixture_app', '1.0.0')) && fs.existsSync(root.preinstalled('fixture_app', '1.1.0')));
    check('app: base.json (signature flag) is not written',
        fs.readFileSync(root.p('usr/lib/oap-mainapp/config/base.json')).equals(base));
    const down = root.run(['install', '--artifact', app, '--yes']);
    check('app: a downgrade is refused, exit 2', down.status === 2 && down.out.includes('downgrade'), down.out);

    fs.renameSync(path.join(root.home(13001), 'someipInterfaces/acl.json'), `${root.R}.acl.json`);
    const killsBefore = root.kills().length;
    const broken = root.run(['install', '--artifact', appArtifact('fixture_app', '1.2.0', true), '--yes']);
    check('app: an update of an install without acl.json is refused, exit 2, no bounce',
        broken.status === 2 && broken.out.includes('broken install') && broken.out.includes('uninstall then install') &&
        root.kills().length === killsBefore && !fs.existsSync(root.preinstalled('fixture_app', '1.2.0')), broken.out);
    fs.renameSync(`${root.R}.acl.json`, path.join(root.home(13001), 'someipInterfaces/acl.json'));

    const u = root.run(['uninstall', 'fixture_app', '--yes']);
    check('app: uninstall exits 0', u.status === 0, u.out);
    check('app: uninstall removes the entry, the app home, the package and the custom_apps entry',
        !fs.existsSync(root.entry('fixture_app')) && !fs.existsSync(root.home(13001)) &&
        !fs.existsSync(root.preinstalled('fixture_app', '1.1.0')) && !('fixture_app' in custom()), JSON.stringify(custom()));
    check('app: the manager is bounced once, after the app left custom_apps (no backend query)',
        !root.managerLog().some((l) => l.includes('backend-query')), root.managerLog().join('\n'));
    check('app: the stock app is untouched', fs.existsSync(root.entry('stock_app')) &&
        fs.existsSync(root.preinstalled('stock_app', '2.0.0')));
    check('app: deploy state forgets the app', !('fixture_app' in root.state().apps), JSON.stringify(root.state()));
    root.run(['install', '--artifact', appArtifact('other_app', '1.0.0', true), '--yes']);
    const other = readJsonOrNull(root.entry('other_app'));
    check('app: the next app gets the uid the manager picks (lowest free)', other && other.userId === 13001, JSON.stringify(other));
    check('app: an app that names no start type starts manually', custom().other_app['-appStartType'] === 'manually',
        JSON.stringify(custom()));
    const auto = root.run(['install', '--artifact', appArtifact('other_app', '1.1.0', true, { mguAppStartType: 'autostart' }), '--yes']);
    check('app: an update naming mguAppStartType autostart lists the app as autostart',
        auto.status === 0 && custom().other_app['-appStartType'] === 'autostart' && custom().other_app['-enabled'] === 'true',
        `${auto.out}\n${JSON.stringify(custom())}`);
    root.run(['install', '--artifact', appArtifact('other_app', '1.2.0', true), '--yes']);
    check('app: an update naming no start type lists the app as manually again',
        custom().other_app['-appStartType'] === 'manually', JSON.stringify(custom()));
    st = root.status();
    check('status: the uninstalled app is gone', !st.components.some((c) => c.id === 'fixture_app'));
}

/* Every bounce waits until the running manager has been up the minimum
 * and the last bounce (state.json) is that long ago. */
function testBounceGuard() {
    check('bounce: the default minimum is 60 s',
        fs.readFileSync(UNIT_JS, 'utf8').includes("env('MGU_DEPLOY_BOUNCE_MIN_UP_S', '60')"));
    const MIN = 2;
    const root = fakeRoot({ minUp: MIN });
    let t0 = Date.now();
    const on = root.run(['fallback', 'on', '--yes']);
    check('bounce: an old manager and no earlier bounce: no wait', on.status === 0 && root.kills().length === 1 &&
        !on.out.includes('waiting'), on.out);
    check('bounce: the bounce is recorded in state.json', Math.abs(root.state().lastBounceAt - t0 / 1000) < 3,
        JSON.stringify(root.state()));
    // the respawned manager is made old: only the recorded bounce holds the next one back
    root.setManagerStart(Date.now() / 1000 - 3600);
    const off = root.run(['fallback', 'off', '--yes']);
    let k = root.kills();
    check('bounce: a second invocation right after waits for the recorded bounce',
        off.status === 0 && k.length === 2 && off.out.includes('the last bounce was') && k[1].at - k[0].at >= MIN * 1000,
        `${off.out}\n${JSON.stringify(k)}`);
    // a young manager, no recent bounce
    const st = root.state();
    st.lastBounceAt = Math.floor(Date.now() / 1000) - 3600;
    write(root.p('var/opt/mgu-deploy/state.json'), JSON.stringify(st));
    root.setManagerStart(Date.now() / 1000 - 0.5);
    t0 = Date.now();
    const again = root.run(['fallback', 'on', '--yes']);
    k = root.kills();
    check('bounce: a manager up for less than the minimum is waited out',
        again.status === 0 && k.length === 3 && again.out.includes('it has been up') && k[2].at - t0 >= (MIN - 0.5) * 1000 - 50,
        `${again.out}\n${JSON.stringify(k)}`);
    const st2 = root.state();
    st2.lastBounceAt = Math.floor(Date.now() / 1000) - 3600;
    write(root.p('var/opt/mgu-deploy/state.json'), JSON.stringify(st2));
    root.setManagerStart(Date.now() / 1000 - 3600);
    const late = root.run(['fallback', 'off', '--yes']);
    check('bounce: an old manager and an old bounce: no wait', late.status === 0 && root.kills().length === 4 &&
        !late.out.includes('waiting'), late.out);
    const none = fakeRoot({ minUp: MIN, noManager: true });
    const n0 = Date.now();
    const r = none.run(['fallback', 'on', '--yes']);
    check('bounce: no manager running: no bounce, no wait', r.status === 0 && r.out.includes('not found') &&
        !r.out.includes('waiting') && Date.now() - n0 < MIN * 1000 && none.kills().length === 0, r.out);
}

/* Every bounce waits until MainApp's install worker has not run for
 * idleQuietS, up to idleMaxS; still busy then, nothing is restarted and the
 * change waits for the next start (pending). */
function testIdleWait() {
    const src = fs.readFileSync(UNIT_JS, 'utf8');
    check('idle: the defaults are 5 s quiet and 180 s at most',
        src.includes("env('MGU_DEPLOY_IDLE_QUIET_S', '5')") && src.includes("env('MGU_DEPLOY_IDLE_MAX_S', '180')"));
    const nowS = () => Math.floor(Date.now() / 1000);
    const W = { MGU_DEPLOY_IDLE_QUIET_S: '1', MGU_DEPLOY_IDLE_MAX_S: '30' };

    const idle = fakeRoot();
    const t0 = Date.now();
    const r0 = idle.run(['fallback', 'on', '--yes'], Object.assign({
        FAKE_PS_EXTRA: '  90 root      1000 S    grep /usr/lib/oap-mainapp/src/AppManagement/AppManagement' }, W));
    check('idle: no worker running: the bounce does not wait', r0.status === 0 && idle.kills().length === 1 &&
        !r0.out.includes('waiting for the app manager') && Date.now() - t0 < 5000, r0.out);

    const busy = fakeRoot();
    const until = nowS() + 3;
    const r1 = busy.run(['fallback', 'on', '--yes'], Object.assign({ FAKE_WORKER_UNTIL: String(until) }, W));
    const k1 = busy.kills();
    check('idle: a running worker is waited out, then 1 s of quiet, then the bounce', r1.status === 0 && k1.length === 1 &&
        k1[0].at >= until * 1000 + 400, `${until} ${r1.out}\n${JSON.stringify(k1)}`);
    check('idle: the wait is said once', (r1.out.match(/waiting for the app manager to finish installing or updating apps/g) || []).length === 1,
        r1.out);
    check('idle: nothing pending after a bounce that waited', !busy.status().pending_reboot.length, JSON.stringify(busy.status().pending_reboot));

    const stuck = fakeRoot();
    const t2 = Date.now();
    const r2 = stuck.run(['fallback', 'on', '--yes'], { FAKE_WORKER_UNTIL: String(nowS() + 3600), MGU_DEPLOY_IDLE_QUIET_S: '1',
        MGU_DEPLOY_IDLE_MAX_S: '2' });
    check('idle: still busy at the bound: no bounce, exit 0', r2.status === 0 && stuck.kills().length === 0 &&
        Date.now() - t2 >= 2000, r2.out);
    check('idle: the defer is said', r2.out.includes('still installing or updating apps after 2s: it is not restarted'), r2.out);
    const p2 = stuck.status().pending_reboot;
    check('idle: the restart is pending under mgu-deploy', p2.some((p) => p.id === 'mgu-deploy' && /next start/.test(p.reason)),
        JSON.stringify(p2));
    check('idle: the change itself stays (the fallback is on)', fs.existsSync(stuck.p('etc/systemd/system/mgu-app-fallback.service')), r2.out);

    // an app install through a bounce, MainApp busy past the bound: refused and rolled back
    const app = fakeRoot();
    const custom = () => readJsonOrNull(app.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
    const r3 = app.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'],
        { FAKE_WORKER_UNTIL: String(nowS() + 3600), MGU_DEPLOY_IDLE_QUIET_S: '1', MGU_DEPLOY_IDLE_MAX_S: '2' });
    check('idle: a deferred app install fails with no bounce, and says to run it again', r3.status === 1 && app.kills().length === 0 &&
        r3.out.includes('the app manager is busy installing or updating apps, so fixture_app 1.0.0 cannot be installed now'), r3.out);
    const st3 = app.status();
    check('idle: the deferred app install is rolled back: not placed, listed, recorded or lost; the restart stays pending',
        !fs.existsSync(app.preinstalled('fixture_app', '1.0.0')) && !('fixture_app' in custom()) && !app.state().apps.fixture_app &&
        !st3.lost_apps.length && !st3.pending_reboot.some((p) => p.id === 'fixture_app') &&
        st3.pending_reboot.some((p) => p.id === 'mgu-deploy'),
        `${r3.out}\n${JSON.stringify(st3.pending_reboot)}`);
    const r4 = app.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'], W);
    check('idle: once MainApp is idle the same install goes through', r4.status === 0 && app.kills().length === 1 &&
        app.state().apps.fixture_app.version === '1.0.0', r4.out);
}

/* After every bounce the respawned manager is watched: one that dies within
 * the watch turns the guard off for the boot (no bounce, no app change,
 * main.js unbound), one that dies after it changes nothing, and a run cut
 * short while it watched leaves what the next run or status judges. */
function testMainAppGuard() {
    const W = { MGU_DEPLOY_GUARD_WATCH_S: '2' };
    const guardOf = (root) => readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/mgu-deploy-guard.json`));
    const onWithApp = () => {
        const root = bindRoot(false);
        const r = root.run(['install', '--artifact', privacyArtifact(), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
        if (r.status !== 0 || root.binds().length !== 1) throw new Error(`setup failed: ${r.out}`);
        return root;
    };

    let root = onWithApp();
    let kills = root.kills().length;
    const r = root.run(['fallback', 'on', '--yes'], Object.assign({ FAKE_MGR_CRASH_MS: '400' }, W));
    const crashes = root.managerLog().filter((l) => l.startsWith('crash '));
    check('guard: a manager that dies within the watch after the bounce stops the run (exit 3), saying so',
        r.status === 3 && crashes.length === 1 && r.out.includes('the app manager stopped') &&
        r.out.includes('stopped here: what this run changed stays') && !r.out.includes('rolling back'), r.out);
    check('guard: it is off for this boot in the guard file, and main.js is unbound',
        guardOf(root) && /the app manager stopped/.test(guardOf(root).off) && guardOf(root).boot === 'boot-1' &&
        root.binds().length === 0, `${JSON.stringify(guardOf(root))}\n${JSON.stringify(root.binds())}`);
    check('guard: no further bounce, and nothing binds main.js again',
        root.kills().length === kills + 1 && root.binds().length === 0, `${JSON.stringify(root.kills())}\n${r.out}`);
    kills = root.kills().length;
    const app = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('guard: an app install is refused for the rest of the boot, nothing changed',
        app.status === 2 && app.out.includes('an app install waits for the next start of the head unit') &&
        !fs.existsSync(root.preinstalled('fixture_app', '1.1.0')) && root.kills().length === kills, app.out);
    const un = root.run(['uninstall', 'fixture_app', '--yes']);
    check('guard: so is an app removal', un.status === 2 && un.out.includes('an app removal waits') && fs.existsSync(root.entry('fixture_app')), un.out);
    const again = root.run(['fallback', 'on', '--yes']);
    check('guard: a change that would bounce or bind leaves main.js stock and the manager running',
        root.kills().length === kills && root.binds().length === 0 && again.out.includes('is bound to the fallback copy at the next start'), again.out);
    const tool = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('guard: tools still install', tool.status === 0, tool.out);
    const priv = root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    let st = root.status();
    check('guard: app-privacy is not applied and nothing bounces: its apply waits for the next start, reported pending',
        priv.status === 0 && priv.out.includes('app-privacy: applied at the next start of the head unit') &&
        !/^app-privacy: (patched|unpatched)/m.test(priv.out) && root.kills().length === kills &&
        st.pending_reboot.some((p) => p.id === 'app-privacy'), `${priv.out}\n${JSON.stringify(st.pending_reboot)}`);
    [['restore', 'stock', '--yes'], ['uninstall', 'app-privacy', '--yes']].forEach((args) => {
        const x = root.run(args);
        check(`guard: ${args[0]} ${args[1]} is refused`, x.status === 2 && x.out.includes('waits for the next start of the head unit'), x.out);
    });
    check('guard: status --json says why', st.mainapp_guard === guardOf(root).off, JSON.stringify(st.mainapp_guard));
    root.reboot(Math.floor(Date.now() / 1000) - 100);
    root.setManagerStart(Date.now() / 1000 - 90);
    st = root.status();
    const next = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('guard: the next start of the head unit turns it on again', st.mainapp_guard === null && next.status === 0 &&
        root.binds().length === 1, `${JSON.stringify(st.mainapp_guard)}\n${next.out}`);

    // a death after the watch changes nothing
    root = onWithApp();
    const late = root.run(['fallback', 'on', '--yes'], Object.assign({ FAKE_MGR_CRASH_MS: '3000' }, W));
    sleep(1500);
    st = root.status();
    check('guard: a manager that dies after the watch leaves it on', late.status === 0 &&
        root.managerLog().some((l) => l.startsWith('crash ')) && st.mainapp_guard === null && guardOf(root).watch.done === true &&
        root.binds().length === 1, `${late.out}\n${JSON.stringify(guardOf(root))}`);

    // the deploy tool killed while it watched: the next status judges the watch it left
    root = onWithApp();
    const outFile = `${root.R}.watch.out`;
    const fd = fs.openSync(outFile, 'w');
    const child = cp.spawn(UNIT_NODE, [UNIT_JS, 'fallback', 'on', '--yes'],
        { env: Object.assign({}, root.env, { MGU_DEPLOY_GUARD_WATCH_S: '30' }), stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    const out = () => fs.readFileSync(outFile, 'utf8');
    const t0 = Date.now();
    while (!out().includes('watching the app manager') && Date.now() - t0 < 20000) sleep(100);
    const watched = guardOf(root);
    child.kill('SIGKILL');
    // its lock names a pid that is gone (this harness reaps the killed child only later)
    write(root.p('var/opt/mgu-deploy/lock'), '999999 boot-1\n');
    const pid = root.managerPid();
    // the watched manager gone, none running yet: judged once one runs
    fs.writeFileSync(`${root.R}.mgr.pid`, '');
    check('guard: with no manager running, a watch a killed run left is not judged yet', root.status().mainapp_guard === null &&
        root.binds().length === 1);
    // oapcontroller starts one after the watch would have ended: the watched one outlived it
    fs.writeFileSync(`${root.R}.mgr.pid`, String(pid + 2));
    root.setManagerStart(watched.watch.start / 1000 + 31);
    check('guard: a manager started after the watch would have ended leaves it on', root.status().mainapp_guard === null &&
        root.binds().length === 1);
    // the watched manager died within it: oapcontroller's next one started inside the watch
    fs.writeFileSync(`${root.R}.mgr.pid`, String(pid + 1));
    root.setManagerStart(Date.now() / 1000);
    st = root.status();
    check('guard: a watch a killed run left, whose manager died within it, turns the guard off at the next status, main.js unbound',
        watched && watched.watch && watched.watch.pid === pid && /stopped within 30s/.test(st.mainapp_guard) &&
        /stopped within 30s/.test(guardOf(root).off) && root.binds().length === 0,
        `${out()}\n${JSON.stringify(watched)}\n${JSON.stringify(st.mainapp_guard)}\n${JSON.stringify(root.binds())}`);
    const after = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('guard: and app installs are refused', after.status === 2 && after.out.includes('waits for the next start'), after.out);
}

/* A run the guard stops keeps what it did: nothing through the rootfs
 * window, the registry, custom_apps.json or app folders after the death;
 * a stopped removal drops the app's record and kept packages as a finished
 * one does. A restore that removes an app does the same. */
function testGuardStops() {
    const W = { MGU_DEPLOY_GUARD_WATCH_S: '2', FAKE_MGR_CRASH_MS: '400' };
    const root = bindRoot(false);
    const mountLog = `${root.R}.mount.log`;
    const wrapper = `${root.R}.mount.sh`;
    fs.writeFileSync(wrapper, `#!/bin/sh\necho "$(date +%s%3N) $*" >> '${mountLog}'\nexec '${path.join(HERE, 'fake_mount.sh')}' "$@"\n`, { mode: 0o755 });
    Object.assign(root.env, { MGU_DEPLOY_FAKE_SH_WINDOW: '1', MGU_DEPLOY_MOUNT: wrapper });
    const custom = () => readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
    const rwAfterCrash = () => {
        const crash = root.managerLog().filter((l) => l.startsWith('crash ')).map((l) => Number(l.split(' ')[2])).pop();
        const rw = fs.readFileSync(mountLog, 'utf8').split('\n').filter((l) => / -o remount,rw \/$/.test(l)).map((l) => Number(l.split(' ')[0]));
        return { crash, rw: rw.filter((t) => t >= crash).length, before: rw.filter((t) => t < crash).length };
    };
    const setup = root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    if (setup.status !== 0) throw new Error(setup.out);
    const ins = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'], W);
    let rw = rwAfterCrash();
    check('guard stop: a first install whose bounce\'s manager dies stops (exit 3), keeping the app: its package, listing and registry entry',
        ins.status === 3 && !ins.out.includes('rolling back') && fs.existsSync(root.preinstalled('fixture_app', '1.0.0')) &&
        'fixture_app' in custom() && fs.existsSync(root.entry('fixture_app')), ins.out);
    check('guard stop: that install wrote nothing to / after the death (its own windows came before), and main.js is unbound',
        rw.crash > 0 && rw.before > 0 && rw.rw === 0 && root.binds().length === 0, JSON.stringify(rw));
    const keptFile = (v) => root.p(`var/opt/mgu-deploy/kept/fixture_app/fixture_app@${v}.tgz`);
    check('guard stop: the stopped install records the app and keeps its package, so a later loss is repaired',
        root.state().apps.fixture_app && root.state().apps.fixture_app.version === '1.0.0' && fs.existsSync(keptFile('1.0.0')),
        JSON.stringify(root.state().apps));
    const nextStart = () => {
        root.reboot(Math.floor(Date.now() / 1000) - 100);
        root.setManagerStart(Date.now() / 1000 - 90);
        fs.unlinkSync(`${root.R}.mgr.pid.crashed`);
    };

    // the next start; an update stopped before its package is placed keeps the version installed
    nextStart();
    const pre = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes'],
        Object.assign({ FAKE_MGR_CRASH_AT: String(root.kills().length + 1) }, W));
    check('guard stop: an update stopped before its package is placed keeps the installed version recorded',
        pre.status === 3 && root.state().apps.fixture_app.version === '1.0.0' && !fs.existsSync(root.preinstalled('fixture_app', '1.1.0')),
        `${pre.out}\n${JSON.stringify(root.state().apps)}`);
    // the next start; stopped after its package was placed, it records the new version
    nextStart();
    const upd = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes'],
        Object.assign({ FAKE_MGR_CRASH_AT: String(root.kills().length + 2) }, W));
    check('guard stop: an update stopped after its package was placed records the new version and keeps its package',
        upd.status === 3 && root.state().apps.fixture_app.version === '1.1.0' && fs.existsSync(keptFile('1.1.0')) &&
        fs.existsSync(root.preinstalled('fixture_app', '1.1.0')), `${upd.out}\n${JSON.stringify(root.state().apps)}`);

    // the next start, then a removal through a bounce whose manager dies
    nextStart();
    const kept = root.p('var/opt/mgu-deploy/kept/fixture_app');
    const keptBefore = fs.existsSync(kept);
    const un = root.run(['uninstall', 'fixture_app', '--yes'], W);
    rw = rwAfterCrash();
    const st = root.status();
    check('guard stop: a removal whose bounce\'s manager dies stops (exit 3), the app removed, nothing written to / after the death',
        un.status === 3 && !un.out.includes('rolling back') && !fs.existsSync(root.entry('fixture_app')) &&
        !fs.existsSync(root.preinstalled('fixture_app', '1.1.0')) && !('fixture_app' in custom()) && rw.rw === 0, `${un.out}\n${JSON.stringify(rw)}`);
    check('guard stop: the stopped removal drops the app\'s record and kept packages: not a lost app',
        keptBefore && !fs.existsSync(kept) && !('fixture_app' in root.state().apps) && st.lost_apps.length === 0,
        `${JSON.stringify(root.state().apps)} ${JSON.stringify(st.lost_apps)}`);

    // restore removes an app: its record and kept packages go too, once its bounce is done
    const restoreRoot = () => {
        const x = fakeRoot();
        x.run(['install', '--artifact', privacyArtifact(), '--yes']);
        x.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
        x.snap = fs.readdirSync(x.p('var/opt/mgu-deploy/backups')).filter((d) => /-install$/.test(d)).sort().pop();
        return x;
    };
    const rf = restoreRoot();
    const rfr = rf.run(['restore', rf.snap, '--yes'], { FAKE_MGR_STAY_DOWN_AT: String(rf.kills().length + 1) });
    check('restore: when its bounce fails it rolls back, the app\'s record and kept package with it',
        rfr.status === 1 && fs.existsSync(rf.entry('fixture_app')) && 'fixture_app' in rf.state().apps &&
        fs.existsSync(rf.p('var/opt/mgu-deploy/kept/fixture_app/fixture_app@1.0.0.tgz')), rfr.out);
    const rt = restoreRoot();
    const rtr = rt.run(['restore', rt.snap, '--yes'], W);
    check('restore: when its bounce is stopped by the guard the removal stands, record and kept package gone',
        rtr.status === 3 && !fs.existsSync(rt.entry('fixture_app')) && !('fixture_app' in rt.state().apps) &&
        !fs.existsSync(rt.p('var/opt/mgu-deploy/kept/fixture_app')) && rt.status().lost_apps.length === 0, rtr.out);
    const r2 = fakeRoot();
    r2.run(['install', '--artifact', privacyArtifact(), '--yes']);
    r2.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    // the app install's own snapshot: app-privacy installed, the app absent
    const snap = fs.readdirSync(r2.p('var/opt/mgu-deploy/backups')).filter((d) => /-install$/.test(d)).sort().pop();
    const res = r2.run(['restore', snap, '--yes']);
    const st2 = r2.status();
    check('restore: an app it removes loses its record and kept packages, so it is not a lost app',
        res.status === 0 && !fs.existsSync(r2.entry('fixture_app')) && !('fixture_app' in ((r2.state() || {}).apps || {})) &&
        !fs.existsSync(r2.p('var/opt/mgu-deploy/kept/fixture_app')) && st2.lost_apps.length === 0, `${res.out}\n${JSON.stringify(st2.lost_apps)}`);

    // an uninstall that fails after the home went is rolled back: record, kept package and registry entry stay
    const r3 = fakeRoot();
    r3.run(['install', '--artifact', privacyArtifact(), '--yes']);
    r3.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const f = r3.run(['uninstall', 'fixture_app', '--yes'], { FAKE_MGR_STAY_DOWN_AT: String(r3.kills().length + 1) });
    const st3 = r3.status();
    check('uninstall rolled back: the registry entry is back and the app is no lost app',
        f.status === 1 && fs.existsSync(r3.entry('fixture_app')) && 'fixture_app' in r3.state().apps && st3.lost_apps.length === 0,
        `${f.out}\n${JSON.stringify(st3.lost_apps)}`);
}

/* A trip inside a reinstall (an app rollback, an install afresh): its
 * removal or its install stopped keeps the app's record at the version it
 * was going to, with its kept package, and the data folder: carried over
 * when the app is installed, else recorded for the install the updater
 * makes at the next start, which carries it over. */
function testGuardNested() {
    const W = { MGU_DEPLOY_GUARD_WATCH_S: '2', FAKE_MGR_CRASH_MS: '400' };
    const nested = () => {
        const root = fakeRoot();
        root.run(['install', '--artifact', privacyArtifact(), '--yes']);
        root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
        const up = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
        if (up.status !== 0) throw new Error(up.out);
        const uid = readJson(root.entry('fixture_app')).userId;
        write(path.join(root.home(uid), 'data', 'note.txt'), 'kept data\n');
        root.kept = root.p('var/opt/mgu-deploy/kept/fixture_app/fixture_app@1.0.0.tgz');
        return root;
    };
    const dataOf = (root) => {
        const e = readJsonOrNull(root.entry('fixture_app'));
        const f = e && path.join(root.home(e.userId), 'data', 'note.txt');
        return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    };

    // the rollback's removal stopped
    let root = nested();
    let r = root.run(['rollback', 'fixture_app', '--yes'], Object.assign({ FAKE_MGR_CRASH_AT: String(root.kills().length + 1) }, W));
    let st = root.status();
    const stash = ((root.state().data_stash || {}).fixture_app || [])[0];
    check('guard nested: a rollback whose removal is stopped keeps the record at the version it goes to, with its kept package',
        r.status === 3 && !fs.existsSync(root.entry('fixture_app')) && root.state().apps.fixture_app.version === '1.0.0' &&
        fs.existsSync(root.kept) && st.lost_apps.length === 1 && st.lost_apps[0].version === '1.0.0',
        `${r.out}\n${JSON.stringify(root.state().apps)}\n${JSON.stringify(st.lost_apps)}`);
    check('guard nested: and records where the data folder waits', stash && fs.existsSync(path.join(stash.path, 'note.txt')),
        JSON.stringify(root.state().data_stash));
    // the next start: the updater's reinstall of the lost app, from a copy of its kept package
    root.reboot(Math.floor(Date.now() / 1000) - 100);
    root.setManagerStart(Date.now() / 1000 - 90);
    const copy = path.join(fs.mkdtempSync(path.join(T, 'lost-')), 'fixture_app@1.0.0.tgz');
    fs.copyFileSync(st.lost_apps[0].package, copy);
    r = root.run(['install', '--artifact', copy, '--yes']);
    check('guard nested: the reinstall of the lost app completes the rollback, its data carried over, nothing left recorded',
        r.status === 0 && readJson(path.join(root.home(readJson(root.entry('fixture_app')).userId), 'source/package.json')).version === '1.0.0' &&
        dataOf(root) === 'kept data\n' && !(root.state().data_stash || {}).fixture_app && !fs.existsSync(stash.path) &&
        root.status().lost_apps.length === 0, r.out);

    // the rollback's install stopped: the app registered at the version it goes to
    root = nested();
    r = root.run(['rollback', 'fixture_app', '--yes'], Object.assign({ FAKE_MGR_CRASH_AT: String(root.kills().length + 2) }, W));
    st = root.status();
    check('guard nested: a rollback whose install is stopped keeps the app at that version, its data carried over',
        r.status === 3 && fs.existsSync(root.entry('fixture_app')) && root.state().apps.fixture_app.version === '1.0.0' &&
        fs.existsSync(root.kept) && dataOf(root) === 'kept data\n' && !(root.state().data_stash || {}).fixture_app &&
        st.lost_apps.length === 0, `${r.out}\n${JSON.stringify(root.state())}`);
}

/* The data folders reinstalls set aside and did not put back stay
 * recorded, every one of them: the app registered again takes the newest
 * into an empty data folder, never over data of its own nor through a link,
 * and never one a later reinstall of the app would replace with the folder
 * it sets aside itself; only an uninstall, a restore that removes the app
 * or remove-all removes them, and a folder no record names stays. Also: a
 * reinstall's fallback install stopped records its own version, a hook's
 * mode fix happens before any bounce and never bounces, and remove-all
 * waits while the guard is off. */
function testGuardStash() {
    const W = { MGU_DEPLOY_GUARD_WATCH_S: '2', FAKE_MGR_CRASH_MS: '400' };
    const stashed = () => {
        const root = fakeRoot();
        root.run(['install', '--artifact', privacyArtifact(), '--yes']);
        root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
        root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
        const uid = readJson(root.entry('fixture_app')).userId;
        write(path.join(root.home(uid), 'data', 'note.txt'), 'old note\n');
        write(path.join(root.home(uid), 'data', 'old-only.txt'), 'old only\n');
        const r = root.run(['rollback', 'fixture_app', '--yes'], Object.assign({ FAKE_MGR_CRASH_AT: String(root.kills().length + 1) }, W));
        root.stash = ((root.state().data_stash || {}).fixture_app || [])[0];
        if (r.status !== 3 || !root.stash) throw new Error(`setup: ${r.out}`);
        // the next start
        root.reboot(Math.floor(Date.now() / 1000) - 100);
        root.setManagerStart(Date.now() / 1000 - 90);
        fs.unlinkSync(`${root.R}.mgr.pid.crashed`);
        return root;
    };
    // the app registered again by another way than this tool's install: the manager's own, from a package in place
    const managerInstalls = (root) => {
        fs.copyFileSync(root.p('var/opt/mgu-deploy/kept/fixture_app/fixture_app@1.0.0.tgz'), root.preinstalled('fixture_app', '1.0.0'));
        const r = cp.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(HERE, 'fake_manager.js'))}).install('fixture_app')`],
            { env: root.env, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
        return path.join(root.home(readJson(root.entry('fixture_app')).userId), 'data');
    };
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

    // the app manager installs the lost app itself at the next start, and the app writes data
    let root = stashed();
    let data = managerInstalls(root);
    write(path.join(data, 'note.txt'), 'new note\n');
    let st = root.status();
    check('stash: an app the manager registered again with data of its own keeps it; the folder set aside stays, recorded, said once',
        read(path.join(data, 'note.txt')) === 'new note\n' && read(path.join(data, 'old-only.txt')) === null &&
        (root.state().data_stash || {}).fixture_app && fs.existsSync(path.join(root.stash.path, 'note.txt')) && st.lost_apps.length === 0 &&
        root.state().data_stash.fixture_app[0].held === true, `${JSON.stringify(root.state().data_stash)} ${fs.readdirSync(data)}`);
    const said = root.run(['status', '--json']);
    write(path.join(data, 'note.txt'), 'newest note\n');
    const up = root.run(['install', '--artifact', appArtifact('fixture_app', '1.2.0', true), '--yes']);
    check('stash: neither a later status nor an update moves it over the app\'s data or says it again',
        !said.out.includes('has data of its own') && up.status === 0 && read(path.join(data, 'note.txt')) === 'newest note\n' &&
        read(path.join(data, 'old-only.txt')) === null && !up.out.includes('carried over') && fs.existsSync(root.stash.path), up.out);

    // registered again with an empty data folder: the folder is put in whole, by the next changing run
    root = stashed();
    data = managerInstalls(root);
    const tool = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('stash: a changing run finds the app registered again and carries its folder in whole',
        tool.status === 0 && read(path.join(data, 'note.txt')) === 'old note\n' && !(root.state().data_stash || {}).fixture_app, tool.out);

    // removed on purpose once registered: nothing comes back into a later fresh install
    root = stashed();
    write(path.join(managerInstalls(root), 'own.txt'), 'own\n');
    root.run(['uninstall', 'fixture_app', '--yes']);
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    data = path.join(root.home(readJson(root.entry('fixture_app')).userId), 'data');
    check('stash: after a removal on purpose a fresh install gets none of the old data, nothing left set aside',
        read(path.join(data, 'note.txt')) === null && !(root.state().data_stash || {}).fixture_app &&
        !fs.readdirSync(root.p('var/opt/public/oap')).some((n) => n.startsWith('.mgu-deploy-data-')), fs.readdirSync(root.p('var/opt/public/oap')).join(' '));

    // a stash held beside data of its own, then a reinstall of the app (an update, then its rollback)
    const held = () => {
        const root = stashed();
        const own = managerInstalls(root);
        write(path.join(own, 'own.txt'), 'own data\n');
        root.status();
        const u = root.run(['install', '--artifact', appArtifact('fixture_app', '1.2.0', true), '--yes']);
        if (u.status !== 0 || !root.state().data_stash.fixture_app[0].held) throw new Error(`setup: ${u.out}`);
        root.setManagerStart(Date.now() / 1000 - 90);
        return root;
    };
    const stashPaths = (root) => ((root.state().data_stash || {}).fixture_app || []).map((d) => d.path);
    const appData = (root, f) => read(path.join(root.home(readJson(root.entry('fixture_app')).userId), 'data', f));
    root = held();
    let rb = root.run(['rollback', 'fixture_app', '--yes']);
    check('stash: a held folder through a reinstall that succeeds: still there and recorded, the app has the data it had',
        rb.status === 0 && appData(root, 'own.txt') === 'own data\n' && appData(root, 'note.txt') === null &&
        JSON.stringify(stashPaths(root)) === JSON.stringify([root.stash.path]) && fs.existsSync(path.join(root.stash.path, 'note.txt')),
        `${rb.out}\n${JSON.stringify(root.state().data_stash)}`);
    root = held();
    rb = root.run(['rollback', 'fixture_app', '--yes'], { FAKE_MGR_REJECT: '1' });
    let paths = stashPaths(root);
    check('stash: a held folder through a reinstall that fails: both folders recorded, oldest first, both there',
        rb.status === 1 && paths.length === 2 && paths[0] === root.stash.path && fs.existsSync(path.join(paths[0], 'note.txt')) &&
        fs.readFileSync(path.join(paths[1], 'own.txt'), 'utf8') === 'own data\n', `${rb.out}\n${JSON.stringify(root.state().data_stash)}`);
    root = held();
    rb = root.run(['rollback', 'fixture_app', '--yes'], Object.assign({ FAKE_MGR_CRASH_AT: String(root.kills().length + 1) }, W));
    paths = stashPaths(root);
    check('stash: a held folder through a reinstall the guard stops: both folders recorded, both there',
        rb.status === 3 && paths.length === 2 && paths[0] === root.stash.path && fs.existsSync(path.join(paths[0], 'note.txt')) &&
        fs.readFileSync(path.join(paths[1], 'own.txt'), 'utf8') === 'own data\n', `${rb.out}\n${JSON.stringify(root.state().data_stash)}`);
    // registered again with data of its own, then removed: every folder set aside for it goes
    root.reboot(Math.floor(Date.now() / 1000) - 100);
    root.setManagerStart(Date.now() / 1000 - 90);
    fs.unlinkSync(`${root.R}.mgr.pid.crashed`);
    fs.copyFileSync(root.p('var/opt/mgu-deploy/kept/fixture_app/fixture_app@1.1.0.tgz'), root.preinstalled('fixture_app', '1.1.0'));
    const again = cp.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(HERE, 'fake_manager.js'))}).install('fixture_app')`],
        { env: root.env, encoding: 'utf8' });
    if (again.status !== 0) throw new Error(again.stderr);
    write(path.join(root.home(readJson(root.entry('fixture_app')).userId), 'data', 'newer.txt'), 'newer\n');
    const un = root.run(['uninstall', 'fixture_app', '--yes']);
    check('stash: an uninstall removes every folder set aside for the app, and its record',
        un.status === 0 && paths.every((x) => !fs.existsSync(x)) && !(root.state().data_stash || {}).fixture_app, `${un.out}\n${JSON.stringify(paths)}`);

    // nothing deletes a data folder by inference: one no record names stays
    root = fakeRoot();
    write(root.p('var/opt/public/oap/.mgu-deploy-data-other_app-999999/x'), 'x\n');
    root.status();
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('stash: a set-aside folder no record names stays', fs.existsSync(root.p('var/opt/public/oap/.mgu-deploy-data-other_app-999999/x')));

    // a data folder that is a link when the folder goes in: nothing followed, the folder stays recorded
    root = stashed();
    data = managerInstalls(root);
    const elsewhere = path.join(root.R, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, data);
    root.status();
    check('stash: an app data folder that is a link is not followed: the folder set aside stays, recorded',
        fs.readdirSync(elsewhere).length === 0 && fs.existsSync(path.join(root.stash.path, 'note.txt')) && (root.state().data_stash || {}).fixture_app);

    // remove-all removes the data set aside for a lost app, and its record
    root = stashed();
    const all = root.run(['remove-all', '--yes']);
    check('stash: remove-all removes the data folder set aside for a lost app', !fs.existsSync(root.stash.path) &&
        !fs.readdirSync(root.p('var/opt/public/oap')).some((n) => n.startsWith('.mgu-deploy-data-')), all.out);

    // restore removes an app with a folder set aside for it
    root = fakeRoot();
    root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const snap = fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).filter((d) => /-install$/.test(d)).sort().pop();
    const folder = root.p('var/opt/public/oap/.mgu-deploy-data-fixture_app-999998');
    write(path.join(folder, 'x'), 'x\n');
    const ws = root.state();
    ws.data_stash = { fixture_app: { path: folder, uid: 13005, gid: 13005 } };
    write(root.p('var/opt/mgu-deploy/state.json'), JSON.stringify(ws));
    const res = root.run(['restore', snap, '--yes']);
    check('stash: a restore that removes the app takes the folder set aside for it', res.status === 0 && !fs.existsSync(folder) &&
        !((root.state() || {}).data_stash || {}).fixture_app, res.out);

    // a reinstall whose install fails and whose fallback install is stopped: the fallback's version is recorded
    root = fakeRoot();
    root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    fs.writeFileSync(root.p('var/opt/mgu-deploy/kept/fixture_app/fixture_app@1.0.0.tgz'), 'not a package');
    // the manager restarted by that install's bounce has not installed it yet when it dies
    const fb = root.run(['rollback', 'fixture_app', '--yes'],
        Object.assign({ FAKE_MGR_CRASH_AT: String(root.kills().length + 2), FAKE_MGR_NO_START_INSTALL: '1' }, W));
    check('guard nested: a rollback whose install fails and whose fallback install is stopped records the fallback\'s version',
        fb.status === 3 && !fs.existsSync(root.entry('fixture_app')) && root.state().apps.fixture_app.version === '1.1.0' &&
        fs.existsSync(root.p('var/opt/mgu-deploy/kept/fixture_app/fixture_app@1.1.0.tgz')), `${fb.out}\n${JSON.stringify(root.state().apps)}`);

    // a hook's mode fix and the guard: done before the trip, and never a bounce of its own
    const stockRoot = fakeRoot({ recmgr: ['fixture-tool'] });
    const carplay = stockRoot.p('usr/bin/carplay');
    write(carplay, 'carplay\n', 0o755);
    stockRoot.run(['install', '--artifact', privacyArtifact(), '--yes']);
    const hookEnv = { FAKE_HOOK_LOG: `${stockRoot.R}.hooks.log`, FAKE_HOOK_CHMOD: JSON.stringify([['activate', carplay, '700']]) };
    const both = stockRoot.run(['install', '--artifact', hookArtifact('3.0.0'), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'],
        Object.assign({}, hookEnv, W));
    check('guard and stock files: a tool\'s activate leaving carplay 0700 is fixed before the app install\'s bounce is stopped',
        both.status === 3 && mode(carplay) === 0o755 && both.out.indexOf('it becomes 0755') < both.out.indexOf('bouncing the app manager'), both.out);
    const kills = stockRoot.kills().length;
    write(carplay, 'carplay\n', 0o755);
    const off = stockRoot.run(['install', '--artifact', hookArtifact('3.0.1'), '--yes'], hookEnv);
    check('guard and stock files: with the guard off a tool install\'s mode fix still runs, and nothing bounces',
        off.status === 0 && mode(carplay) === 0o755 && off.out.includes('it becomes 0755') && stockRoot.kills().length === kills, off.out);

    // remove-all waits while the guard is off, and says what is left
    const ra = stockRoot.run(['remove-all', '--yes']);
    let result = null;
    try { result = JSON.parse(ra.stdout.trim().split('\n').pop()); } catch (e) { /* checked below */ }
    check('guard: remove-all removes nothing while the guard is off, its result naming what is left and a restart',
        ra.status === 1 && result && result.removed.length === 0 && result.left.indexOf('fixture_app') >= 0 && result.restart === true &&
        fs.existsSync(stockRoot.entry('fixture_app')) && ra.out.includes('remove-all waits for the next start'), ra.out);
}

/* A trip in a bounce that comes before a command's own bookkeeping (the
 * app-privacy install's and rollback's apply, a restore's, fallback on and
 * off) leaves this tool's records as the same command finished leaves
 * them: run on two identical units, one whose bounce is stopped. */
function testGuardBookkeeping() {
    const W = { MGU_DEPLOY_GUARD_WATCH_S: '2', FAKE_MGR_CRASH_MS: '400' };
    const norm = (root) => {
        const st = readJsonOrNull(root.p('var/opt/mgu-deploy/state.json')) || {};
        delete st.lastBounceAt;
        return JSON.stringify(st).split(root.R).join('R');
    };
    const twin = (what, opts, setup, args) => {
        const make = () => { const r = fakeRoot(opts); setup(r); return r; };
        const a = make(), b = make();
        const ra = a.run(args), rb = b.run(args, W);
        check(`guard bookkeeping: ${what} stopped by the guard leaves state.json as the finished one does`,
            ra.status === 0 && rb.status === 3 && norm(a) === norm(b), `${rb.out}\n${norm(a)}\n${norm(b)}`);
        return { a, b };
    };
    let t = twin('a first app-privacy install', { privacy: false }, () => {}, ['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    check('guard bookkeeping: and its copy is kept', fs.existsSync(t.b.p('var/opt/mgu-deploy/kept/app-privacy/1.0.0/component.json')));
    t = twin('an app-privacy update', { privacy: false }, (r) => {
        r.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
        r.run(['install', '--artifact', privacyTool('1.0.1', 0), '--yes']);
    }, ['install', '--artifact', privacyTool('1.0.2', 0), '--yes']);
    check('guard bookkeeping: the stopped update prunes the version before last, as the finished one',
        fs.readdirSync(path.join(t.b.tool('app-privacy'), 'versions')).sort().join(' ') === '1.0.1 1.0.2' &&
        fs.existsSync(t.b.p('var/opt/mgu-deploy/kept/app-privacy/1.0.2/component.json')),
        fs.readdirSync(path.join(t.b.tool('app-privacy'), 'versions')).join(' '));
    twin('an app-privacy rollback', { privacy: false }, (r) => {
        r.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
        r.run(['install', '--artifact', privacyTool('1.0.1', 0), '--yes']);
    }, ['rollback', 'app-privacy', '--yes']);
    twin('a restore that reverts app-privacy', { privacy: false }, (r) => {
        r.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
        const st = r.state();
        st.pending_reboot.push({ id: 'app-privacy', reason: 'test', boot: 'boot-1' });
        write(r.p('var/opt/mgu-deploy/state.json'), JSON.stringify(st));
    }, ['restore', 'stock', '--yes']);
    twin('fallback on', {}, (r) => {
        const st = readJsonOrNull(r.p('var/opt/mgu-deploy/state.json')) || { apps: {}, pending_reboot: [] };
        st.fallback_refused = 'an earlier build';
        write(r.p('var/opt/mgu-deploy/state.json'), JSON.stringify(st));
    }, ['fallback', 'on', '--yes']);
    twin('fallback off', {}, (r) => r.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']),
        ['fallback', 'off', '--yes']);
}

/* The guard's own failures and boot runs. */
function testGuardEdges() {
    const W = { MGU_DEPLOY_GUARD_WATCH_S: '2', FAKE_MGR_CRASH_MS: '400' };
    // an unmount that fails: still recorded, still stopped with exit 3, nothing rolled back
    const root = bindRoot(false);
    root.run(['install', '--artifact', privacyArtifact(), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    // the unmount fails once the guard is off (the trip's)
    const bad = `${root.R}.umount-fails.sh`;
    fs.writeFileSync(bad, `#!/bin/sh\nif grep -q '"off"' '${root.p(`var/opt/public/oap/oap_${MGR}/data/mgu-deploy-guard.json`)}' 2>/dev/null; then ` +
        `echo "umount: busy" >&2; exit 32; fi\nexec '${path.join(HERE, 'fake_umount.sh')}' "$@"\n`, { mode: 0o755 });
    const r = root.run(['fallback', 'on', '--yes'], Object.assign({ MGU_DEPLOY_UMOUNT: bad }, W));
    const g = readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/mgu-deploy-guard.json`)) || {};
    check('guard edges: an unmount that fails during a trip is said, the guard recorded, the run stopped (exit 3), nothing rolled back',
        r.status === 3 && /stays bound/.test(r.out) && /the app manager stopped/.test(g.off || '') && !r.out.includes('rolling back'), r.out);

    // tile_withheld: only flags that hide the tile
    const t = fakeRoot();
    t.run(['install', '--artifact', privacyArtifact(), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const e = readJson(t.entry('fixture_app'));
    const tile = () => t.status().components.find((c) => c.id === 'fixture_app');
    write(t.entry('fixture_app'), JSON.stringify(Object.assign({}, e, { provisioningCache: undefined })));
    const none = tile();
    write(t.entry('fixture_app'), JSON.stringify(Object.assign({}, e, { provisioningCache: { '-enabled': 'true', '-allowed': 'false' } })));
    const held = tile();
    check('guard edges: tile_withheld only when the kept flags hide the tile, not without flags',
        none.tile_withheld === false && none.tile_visible === false && held.tile_withheld === true, JSON.stringify([none, held]));

    // the boot check whose rollback the guard stops: last-verify written, exit 0
    const v = fakeRoot({ privacy: false });
    const marker = `${v.R}.check-fails`;
    const tool = (version) => {
        const dir = path.join(fs.mkdtempSync(path.join(T, 'vpriv-')), 'app-privacy');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'component.json'), JSON.stringify({ id: 'app-privacy', kind: 'tool', version,
            files: [{ path: 'patch_mainapp.js', from: 'patch_mainapp.js', mode: '0755' }, { path: 'check.js', from: 'check.js', mode: '0644' }],
            units: [], enable: [], recmgr: [], restart: [], check: ['check.js'] }, null, 2));
        fs.writeFileSync(path.join(dir, 'check.js'), `process.exit(require('fs').existsSync(${JSON.stringify(marker)}) ? 1 : 0);\n`);
        fs.writeFileSync(path.join(dir, 'patch_mainapp.js'), "'use strict';\nconsole.log(JSON.stringify({ state: 'patched', " +
            "changed: process.argv[2] === 'apply', restartNeeded: false }));\n");
        const out = fs.mkdtempSync(path.join(T, 'art-'));
        if (hu(['artifact', dir, '--out', out]).status !== 0) throw new Error('artifact');
        return path.join(out, `app-privacy@${version}.tgz`);
    };
    v.run(['install', '--artifact', tool('1.0.0'), '--yes']);
    const v2 = v.run(['install', '--artifact', tool('1.1.0'), '--yes']);
    if (v2.status !== 0) throw new Error(v2.out);
    // it stops working: the boot check rolls it back, and app-privacy's apply then bounces
    fs.writeFileSync(marker, '');
    // a second tool due after it, not checked yet when the guard stops the run
    v.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const due = { 'app-privacy': { version: '1.1.0', previous: '1.0.0', boot: 'an-earlier-boot' },
        'fixture-tool': { version: '0.2.0', previous: null, boot: 'an-earlier-boot' } };
    write(v.p('var/opt/mgu-deploy/verify.json'), JSON.stringify(due));
    const vr = v.run(['verify'], Object.assign({ MGU_DEPLOY_VERIFY_AFTER_S: '0' }, W));
    const last = readJsonOrNull(v.p('var/opt/mgu-deploy/last-verify.json'));
    const r0 = last && last.results.find((x) => x.id === 'app-privacy');
    check('guard edges: a boot check whose rollback the guard stops still ends as succeeded and writes its outcome',
        vr.status === 0 && /stopped here/.test(vr.out) && r0 && r0.ok === false, `${vr.out}\n${JSON.stringify(last)}`);
    check('guard edges: the tool it was rolling back is reported back at its version before, which it is',
        r0 && r0.rolledBack === true && /stopped the rollback/.test(r0.error) &&
        fs.readlinkSync(v.p('var/opt/app-privacy/current')) === 'versions/1.0.0', JSON.stringify(r0));
    const again = readJsonOrNull(v.p('var/opt/mgu-deploy/verify.json')) || {};
    check('guard edges: the tool not checked yet stays due for the next start, the one rolled back does not',
        JSON.stringify(again['fixture-tool']) === JSON.stringify(due['fixture-tool']) && !again['app-privacy'], JSON.stringify(again));
}

/* The guard in a copy of the iDrive 7 fixture, loaded as MainApp loads it,
 * one process per start, after a bounce mgu-deploy recorded. */
function testGuardCopy() {
    const dir = fs.mkdtempSync(path.join(T, 'guard7-'));
    const list = path.join(dir, 'custom_apps.json');
    write(list, JSON.stringify({ our_app: {} }));
    const r = cp.spawnSync(UNIT_NODE, [path.join(DEPLOY, 'unit', 'fallback_build.js'), path.join(HERE, 'fixtures', 'main.js'),
        path.join(dir, 'built.js'), list], { encoding: 'utf8' });
    check('guard copy: builds from the iDrive 7 fixture', r.status === 0, r.stderr);
    const load = () => JSON.parse(cp.spawnSync(UNIT_NODE, ['-e', `const P=require(${JSON.stringify(path.join(dir, 'built.js'))});` +
        'console.log(JSON.stringify({pid:process.pid,on:global.__mguDeployGuard.on,why:global.__mguDeployGuard.why,' +
        'section:new P().handle("our_app",undefined)||null}))'], { encoding: 'utf8' }).stdout);
    const guard = path.join(dir, 'mgu-deploy-guard.json');
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    let l = load();
    check('guard copy: with no bounce recorded it is on and lists our app', l.on && l.section && l.section['-enabled'] === 'true' &&
        !fs.existsSync(guard), JSON.stringify(l));
    const bounce = { at: Date.now() - 500, pid: 1, watchMs: 60000 };
    write(guard, JSON.stringify({ boot, bounce }));
    l = load();
    const first = readJson(guard).first;
    check('guard copy: the first load after a bounce claims it and is on', l.on && first && first.pid === l.pid, JSON.stringify(readJson(guard)));
    l = load();
    check('guard copy: a load within the watch after it is off for the boot, the fallback with it',
        !l.on && /^MainApp restarted \d+s after mgu-deploy restarted it$/.test(l.why) && l.section === null && readJson(guard).off === l.why,
        JSON.stringify(l));
    const traced = JSON.parse(cp.spawnSync(UNIT_NODE, ['-e', `const P=require(${JSON.stringify(path.join(dir, 'built.js'))});` +
        'const cm=function(){},stub={_callMethod:cm,install(){}};' +
        'P.start({appManager:stub},{getById:()=>null},{info(){}}).then(()=>{console.log(JSON.stringify(' +
        '{callMethod:stub._callMethod===cm,status:JSON.parse(require("fs").readFileSync(' +
        JSON.stringify(path.join(dir, 'mgu-deploy-inplace.json')) + ',"utf8")).state}));process.exit(0)})'], { encoding: 'utf8' }).stdout || 'null');
    check('guard copy: off, the in-place hook leaves the installer as it is and says so', traced && traced.callMethod === true &&
        traced.status === 'off', JSON.stringify(traced));
    write(guard, JSON.stringify({ boot, bounce, first: { pid: 1, start: Date.now() - 61000 } }));
    l = load();
    check('guard copy: a load after the watch ended is on', l.on && !readJson(guard).off, JSON.stringify(l));
    write(guard, JSON.stringify({ boot, bounce, watch: { pid: 1, start: Date.now() - 2000 } }));
    l = load();
    check('guard copy: a load within the watch of the manager mgu-deploy watched is off', !l.on, JSON.stringify(l));
    write(guard, JSON.stringify({ boot: 'an-earlier-boot', bounce, off: 'x' }));
    l = load();
    check('guard copy: a new boot starts it over', l.on, JSON.stringify(l));
}

/* No app manager running (MainApp's node child gone, oapcontroller not
 * starting it): an app install fails at once, after the respawn wait, with
 * what tells why on screen, and is rolled back; no bounce, no watch. */
function testNoManagerInstall() {
    const root = fakeRoot({ noManager: true });
    const custom = () => readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
    write(root.p('etc/systemd/system/oapcontroller.service.d/50-other.conf'), '[Service]\n');
    write(root.p('proc/uptime'), '1234.56 100.00\n');
    // a process of MainApp's uid that ps does not show as the manager
    write(root.p('proc/555/status'), `Name:\tnode\nUid:\t${MGR}\t${MGR}\t${MGR}\t${MGR}\n`);
    write(root.p('proc/555/cmdline'), ['/opt/node10/bin/node', '--max-old-space-size', '512', '/usr/lib/oap-mainapp/src/main.js', ''].join('\0'));
    const app = appArtifact('fixture_app', '1.0.0', true);
    const t0 = Date.now();
    const r = root.run(['install', '--artifact', app, '--yes'],
        { MGU_DEPLOY_BOUNCE_TIMEOUT_MS: '1000', MGU_DEPLOY_WATCH_TIMEOUT_MS: '60000',
            FAKE_PS_EXTRA: '  77 root      9000 S    /usr/bin/node /var/opt/mgu-updater/current/updater.js' });
    check('no manager: the app install fails without waiting out the watch', r.status === 1 && Date.now() - t0 < 20000 &&
        !r.out.includes('nothing to bounce') && !r.out.includes('through a bounce') && root.kills().length === 0, r.out);
    check('no manager: says so and what to do', r.out.includes('no app manager is running on this head unit') &&
        r.out.includes('the app manager is not running, so fixture_app 1.0.0 cannot be installed now') &&
        r.out.includes('then run the install again'), r.out);
    check('no manager: shows MainApp, oapcontroller, uptime, mounts and processes',
        r.out.includes(`MainApp: ${root.p('usr/lib/oap-mainapp')}`) && r.out.includes('oapcontroller: ActiveState=inactive') &&
        r.out.includes('oapcontroller drop-ins: 50-other.conf') && r.out.includes('head unit up 1234 s, mounts over main.js:') &&
        r.out.includes(`processes of uid ${MGR} (MainApp's):\n    555 /opt/node10/bin/node --max-old-space-size 512 /usr/lib/oap-mainapp/src/main.js\n`) &&
        r.out.includes('processes (1 of node, MainApp, oapcontroller)') && r.out.includes('/var/opt/mgu-updater/current/updater.js') &&
        root.systemctlCalls().some((l) => l.startsWith('show ') && l.endsWith('oapcontroller.service')), r.out);
    check('no manager: rolled back: not listed, no package, no registry entry', !('fixture_app' in custom()) &&
        !fs.existsSync(root.preinstalled('fixture_app', '1.0.0')) && !fs.existsSync(root.entry('fixture_app')), r.out);
}

/* The head unit's coding segment with the given status flags (byte 0x28). */
function writeCoding(root, flags) {
    const buf = Buffer.alloc(0x1030);
    buf[0x28] = flags;
    write(root.p('dev/shm/rawcodingdata'), buf);
}

/* Default coding values: oapcontroller never starts MainApp, so an app
 * install is refused before anything changes, with what to do. */
function testDefaultCodingInstall() {
    const root = fakeRoot({ noManager: true });
    writeCoding(root, 0x0a);
    const app = appArtifact('fixture_app', '1.0.0', true);
    const r = root.run(['install', '--artifact', app, '--yes']);
    check('default coding: the app install is refused at once', r.status === 2 &&
        r.out.includes('The head unit\'s coding is missing: it holds default values. This often happens after enabling SSH or flashing.') &&
        r.out.includes('Restore the head unit\'s coding from a backup (BimmerCode, E-Sys or ISTA) or have HU_MGU coded to the car') &&
        !r.out.includes('app-privacy') && !r.out.includes('backup:') && !r.out.includes('no app manager is running'), r.out);
    check('default coding: nothing installed or snapshotted', !fs.existsSync(root.preinstalled('fixture_app', '1.0.0')) &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/backups/stock')), r.out);
    const bad = fakeRoot({ noManager: true });
    writeCoding(bad, 0x00);
    const rb = bad.run(['install', '--artifact', app, '--yes']);
    check('invalid coding header: refused the same way', rb.status === 2 && rb.out.includes('coding is missing: it is not valid'), rb.out);
    const first = fakeRoot({ noManager: true });
    writeCoding(first, 0x0a);
    const plog = `${first.R}.privacy.log`;
    const rf = first.run(['install', '--artifact', privacyArtifact(), '--artifact', app, '--yes']);
    check('default coding: refused before app-privacy\'s check and any tool install', rf.status === 2 &&
        rf.out.includes('coding is missing') && !fs.existsSync(plog) && !fs.existsSync(first.p('var/opt/app-privacy/current')) &&
        !fs.existsSync(first.p('var/opt/mgu-deploy')), rf.out);
    const coded = fakeRoot({ noManager: true });
    writeCoding(coded, 0x09);
    const rc = coded.run(['install', '--artifact', app, '--yes'], { MGU_DEPLOY_BOUNCE_TIMEOUT_MS: '1000' });
    check('car coding, no manager: the install goes on to the manager check', rc.status === 1 &&
        !rc.out.includes('coding is missing') && rc.out.includes('no app manager is running on this head unit'), rc.out);
    const running = fakeRoot({});
    writeCoding(running, 0x0a);
    const rr = running.run(['install', '--artifact', app, '--yes']);
    check('default coding with a manager running: the app installs', rr.status === 0 &&
        !rr.out.includes('coding is missing'), rr.out);
    const tools = fakeRoot({ noManager: true });
    writeCoding(tools, 0x0a);
    const rt = tools.run(['install', '--artifact', toolArtifact('1.0.0'), '--yes']);
    check('default coding: a tool installs', rt.status === 0 && !rt.out.includes('coding is missing'), rt.out);
    // iDrive 8: oapcontroller starts no MainApp-21 on such a coding either
    const i8 = id8Root();
    i8.noManager();
    writeCoding(i8, 0x0a);
    const r8 = i8.run(['install', '--artifact', rhmiApp('x8', '1.0.0', ['ID8']), '--yes']);
    check('iDrive 8, default coding: the app install is refused at once, nothing queued', r8.status === 2 &&
        r8.out.includes('coding is missing: it holds default values') && !fs.existsSync(i8.p('var/opt/mgu-deploy')), r8.out);
    const c8 = id8Root();
    c8.noManager();
    writeCoding(c8, 0x09);
    const rc8 = c8.run(['install', '--artifact', rhmiApp('x8', '1.0.0', ['ID8']), '--yes']);
    check('iDrive 8, car coding, no manager: the app is queued', rc8.status === 0 && !rc8.out.includes('coding is missing') &&
        fs.existsSync(c8.p('var/opt/mgu-deploy/id8/queue/x8@1.0.0.tgz')), rc8.out);
}

function readJsonOrNull(p) {
    try {
        return readJson(p);
    } catch (e) {
        return null;
    }
}

/* ---- the bind over main.js ------------------------------------------------------------ */

/* A fake root whose mount and umount keep a table of binds, which the
 * deploy tool reads as /proc would show them. */
function bindRoot(bundle) {
    // bundle: MainApp 6.5.5's shape, main.js a stub that runs main.bundle.js, the target of the bind
    const root = fakeRoot(bundle ? { main: '// bytecode-loader stub\n' } : {});
    if (bundle) {
        write(root.p('usr/lib/oap-mainapp/src/main.bundle.js'), stockMain());
    }
    const table = root.p('binds.tsv');
    Object.assign(root.env, { MGU_DEPLOY_FAKE_BINDS: table, MGU_DEPLOY_MOUNT: path.join(HERE, 'fake_mount.sh'),
        MGU_DEPLOY_UMOUNT: path.join(HERE, 'fake_umount.sh') });
    const stub = root.p('usr/lib/oap-mainapp/src/main.js');
    const main = bundle ? root.p('usr/lib/oap-mainapp/src/main.bundle.js') : stub;
    const copy = root.p('var/opt/mgu-deploy/main.js');
    root.binds = () => (fs.existsSync(table) ? fs.readFileSync(table, 'utf8') : '').split('\n').filter(Boolean)
        .map((l) => l.split('\t')).filter((f) => f[0] === main);
    // nothing bound over main.js, or one bind of the fallback copy as it is now
    root.bindSound = () => {
        const b = root.binds();
        if (bundle && fs.readFileSync(table, 'utf8').split('\n').some((l) => l.split('\t')[0] === stub)) {
            return false;
        }
        return b.length === 0 || (b.length === 1 && b[0][1] === copy && fs.existsSync(copy) &&
            Number(b[0][2]) === fs.statSync(copy).ino);
    };
    root.copy = copy;
    root.main = main;
    return root;
}

function testMainBind() {
    [false, true].forEach((bundle) => mainBindCases(bundle));
}

function mainBindCases(bundle) {
    const c = (name, cond, detail) => check(bundle ? name.replace('main.js bind:', 'main.bundle.js bind:') : name, cond, detail);
    // a first install the manager stops after the uid, before its registry entry, rolled back
    let root = bindRoot(bundle);
    const uids = root.p(`var/opt/public/oap/oap_${MGR}/security/uids.txt`);
    root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    const r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'], { FAKE_MGR_UID_ONLY: '1' });
    c('main.js bind: a rolled-back first install leaves main.js stock or bound to the fallback copy there is',
        r.status !== 0 && r.out.includes('rolling back fixture_app') && root.bindSound(),
        `${r.out}\nbinds: ${JSON.stringify(root.binds())} copy ${fs.existsSync(root.copy)}`);
    c('main.js bind: the rolled-back first install leaves no uids.txt line for the app',
        fs.readFileSync(uids, 'utf8') === '13000=stock_app\n', fs.readFileSync(uids, 'utf8'));
    // a first install the manager rejects, rolled back, then restore stock, with a line an earlier attempt left
    root = bindRoot(bundle);
    const uids2 = root.p(`var/opt/public/oap/oap_${MGR}/security/uids.txt`);
    root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    fs.appendFileSync(uids2, '13007=fixture_app\n');
    const rj = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'], { FAKE_MGR_REJECT: '1' });
    c('main.js bind: a rejected first install, rolled back, leaves main.js stock or bound to the copy there is',
        rj.status !== 0 && root.managerLog().includes('rejected install fixture_app 1.0.0') && root.bindSound(),
        `${rj.out}\nbinds: ${JSON.stringify(root.binds())}`);
    c('main.js bind: the rejected first install takes out the uids.txt line an earlier attempt left',
        fs.readFileSync(uids2, 'utf8') === '13000=stock_app\n' && rj.out.includes('removed 13007=fixture_app'), `${fs.readFileSync(uids2, 'utf8')}\n${rj.out}`);
    const rs = root.run(['restore', 'stock', '--yes']);
    c('main.js bind: restore stock after the rejected install succeeds in one run, main.js stock',
        rs.status === 0 && rs.out.includes('restored from stock') && root.binds().length === 0, rs.out);
    // a failed first install of a second app with the fallback on: the copy it changed is bound again
    root = bindRoot(bundle);
    root.run(['install', '--artifact', privacyArtifact(), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const second = root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes'], { FAKE_MGR_REJECT: '1' });
    c('main.js bind: with the fallback on, a rolled-back install leaves the copy there bound',
        second.status !== 0 && root.binds().length === 1 && root.bindSound(), `${second.out}\nbinds: ${JSON.stringify(root.binds())}`);
    // restore stock in one run from a bind over a fallback copy deleted since
    root = bindRoot(bundle);
    root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    write(root.copy, 'stale copy\n');
    write(root.p('binds.tsv'), `${root.main}\t${root.copy}\t${fs.statSync(root.copy).ino}\n`);
    fs.unlinkSync(root.copy);
    let res = root.run(['restore', 'stock', '--yes']);
    c('main.js bind: restore stock from a bind of a deleted copy succeeds in one run, main.js stock',
        res.status === 0 && res.out.includes('restored from stock') && root.binds().length === 0 &&
        !fs.existsSync(root.tool('app-privacy')), `${res.out}\nbinds: ${JSON.stringify(root.binds())}`);
    // and from a bind of a copy replaced since, with the fallback on
    root = bindRoot(bundle);
    root.run(['install', '--artifact', privacyArtifact(), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const on = root.binds().length === 1 && root.bindSound();
    fs.writeFileSync(`${root.copy}.new`, fs.readFileSync(root.copy));
    fs.renameSync(`${root.copy}.new`, root.copy);
    res = root.run(['restore', 'stock', '--yes']);
    c('main.js bind: restore stock from a bind of a replaced copy succeeds in one run, main.js stock',
        on && res.status === 0 && res.out.includes('restored from stock') && root.binds().length === 0,
        `${on}\n${res.out}\nbinds: ${JSON.stringify(root.binds())}`);
    // uninstalling app-privacy (its revert under the bind) with the copy gone binds nothing missing
    root = bindRoot(bundle);
    root.run(['install', '--artifact', privacyArtifact(), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    root.run(['uninstall', 'fixture_app', '--yes']);
    write(root.copy, 'stale copy\n');
    write(root.p('binds.tsv'), `${root.main}\t${root.copy}\t${fs.statSync(root.copy).ino}\n`);
    fs.unlinkSync(root.copy);
    const un = root.run(['uninstall', 'app-privacy', '--yes']);
    c('main.js bind: app-privacy\'s revert with the bound copy deleted binds no missing copy',
        un.status === 0 && !un.out.includes('does not exist') && root.bindSound(),
        `${un.out}\nbinds: ${JSON.stringify(root.binds())}`);
}

/* ---- backups and restore --------------------------------------------------------------- */

function testRestore() {
    const root = fakeRoot();
    // the manager's own uid records stay (README, restore's boundary)
    const systemTrees = (rel) => rel.endsWith('/security/uids.txt') ||
        !(rel === 'etc' || rel.startsWith('etc/') || rel === 'usr' || rel.startsWith('usr/') ||
        rel === 'var' || rel === 'var/opt' || rel === 'var/opt/public' || rel.startsWith('var/opt/public/'));
    const stock = root.hash(systemTrees);
    const stockDir = root.p('var/opt/mgu-deploy/backups/stock');
    let stockSnap = null;
    [1, 2].forEach((cycle) => {
        const r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--artifact',
            appArtifact('fixture_app', '1.0.0', true), '--yes']);
        check(`restore ${cycle}: tool and app install, exit 0`, r.status === 0 && fs.existsSync(root.entry('fixture_app')) &&
            fs.existsSync(root.tool('fixture-tool')), r.out);
        if (cycle === 1) {
            stockSnap = treeHash(stockDir);
        }
        const b = root.run(['backups']);
        check(`restore ${cycle}: backups lists the stock snapshot`, b.status === 0 && b.stdout.includes('stock [stock]'), b.out);
        const noYes = root.run(['restore']);
        check(`restore ${cycle}: restore without --yes on no TTY is refused`, noYes.status === 2);
        const res = root.run(['restore', 'stock', '--yes']);
        check(`restore ${cycle}: restore stock --yes exits 0 (verified)`, res.status === 0 &&
            res.stdout.includes('restored from stock'), res.out);
        const now = root.hash(systemTrees);
        check(`restore ${cycle}: /etc, the app manager tree and the registry are back to their stock bytes`,
            now.hash === stock.hash, treeDiff(stock, now));
        check(`restore ${cycle}: the tool folder is removed`, !fs.existsSync(root.tool('fixture-tool')));
        check(`restore ${cycle}: the stock snapshot is unchanged`, treeHash(stockDir).hash === stockSnap.hash,
            treeDiff(stockSnap, treeHash(stockDir)));
    });
    const st = root.status();
    check('restore: status shows only the stock app and the deploy tool itself',
        JSON.stringify(st.components.map((c) => c.id)) === '["mgu-deploy","stock_app"]', JSON.stringify(st.components));
}

/* An app-privacy tool: the fixture tool under that id. */
function privacyArtifact() {
    const src = path.join(fs.mkdtempSync(path.join(T, 'src-')), 'app-privacy');
    fs.renameSync(fixtureCopy('1.0.0', (c) => { c.id = 'app-privacy'; c.recmgr = ['app-privacy']; c.restart = []; }), src);
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    const r = hu(['artifact', src, '--out', out]);
    if (r.status !== 0) {
        throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
    }
    return path.join(out, 'app-privacy@1.0.0.tgz');
}

function testPrivacyRevert() {
    const privacyLog = (root) => (fs.existsSync(`${root.R}.privacy.log`) ? fs.readFileSync(`${root.R}.privacy.log`, 'utf8') : '');
    let root = fakeRoot();
    root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    const res = root.run(['restore', 'stock', '--yes']);
    check('privacy: restore stock removing app-privacy runs its revert first', res.status === 0 &&
        privacyLog(root).split('\n').includes('revert') && !fs.existsSync(root.tool('app-privacy')), `${res.out}\n${privacyLog(root)}`);
    root = fakeRoot();
    root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    const un = root.run(['uninstall', 'app-privacy', '--yes']);
    check('privacy: uninstalling app-privacy runs its revert', un.status === 0 &&
        privacyLog(root).split('\n').includes('revert'), `${un.out}\n${privacyLog(root)}`);
    root = fakeRoot();
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    root.run(['restore', 'stock', '--yes']);
    check('privacy: restoring without app-privacy in the change runs no revert', !privacyLog(root).includes('revert'), privacyLog(root));
}

/* ---- status --json ---------------------------------------------------------------------- */

function testStatusJson() {
    const root = fakeRoot();
    [[], ['install', '--artifact', toolArtifact('0.2.0'), '--artifact', appArtifact('fixture_app', '1.0.0', true)]]
        .forEach((setup, i) => {
            if (setup.length) {
                root.run(setup);
            }
            const r = root.run(['status', '--json']);
            let obj = null;
            try {
                obj = JSON.parse(r.stdout);
            } catch (e) { /* checked below */ }
            check(`status --json ${i ? 'after installs' : 'on a fresh unit'}: exactly one JSON object on stdout`,
                r.status === 0 && obj && !Array.isArray(obj) && typeof obj === 'object' &&
                r.stdout.trim().split('\n').length === 1, r.stdout);
            check(`status --json ${i ? 'after installs' : 'on a fresh unit'}: has every field`, obj &&
                ['version', 'components', 'pending_reboot', 'display_bridge_socket', 'display_bridge_todo_on_car', 'fallback',
                    'backups', 'stock_backup', 'updater_tokens'].every((k) => k in obj), obj && Object.keys(obj).join(','));
        });
}

/* ---- provisioning fallback ------------------------------------------------------------- */

function testFallback() {
    const root = fakeRoot();
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const sys = root.p('etc/systemd/system');
    const on = root.run(['fallback', 'on', '--yes']);
    check('fallback on: exits 0', on.status === 0, on.out);
    const copy = root.p('var/opt/mgu-deploy/main.js');
    const built = fs.existsSync(copy) ? fs.readFileSync(copy, 'utf8') : '';
    check('fallback on: the copy carries the fallback and the in-place hook once',
        built.split('/* mgu-deploy provisioning fallback */').length === 3 && built.includes('__mguDeployFallbackApps') &&
        built.split('/* mgu-deploy in-place install */').length === 3);
    check('fallback on: the stock main.js is untouched',
        fs.readFileSync(root.p('usr/lib/oap-mainapp/src/main.js'), 'utf8') === stockMain());
    check('fallback on: unit written and enabled',
        fs.readFileSync(path.join(sys, 'mgu-app-fallback.service'), 'utf8') ===
        fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-app-fallback.service'), 'utf8') &&
        fs.readlinkSync(path.join(sys, 'multi-user.target.wants/mgu-app-fallback.service')) === '../mgu-app-fallback.service');
    check('fallback on: recmgr lists mgu-app-fallback, the builder is installed',
        /\[Whitelist\][^[]*mgu-app-fallback/.test(fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8')) &&
        fs.existsSync(root.p('var/opt/mgu-deploy/current/fallback_build.js')));
    const custom = readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
    check('fallback on: custom_apps.json lists our app only', Object.keys(custom).join(',') === 'fixture_app', JSON.stringify(custom));
    check('fallback: status --json shows the unit', root.status().fallback.unit_present === true);
    const off = root.run(['fallback', 'off', '--yes']);
    check('fallback off: unit, link and copy removed', off.status === 0 && !fs.existsSync(path.join(sys, 'mgu-app-fallback.service')) &&
        !fs.existsSync(path.join(sys, 'multi-user.target.wants/mgu-app-fallback.service')) && !fs.existsSync(copy), off.out);

    testFallbackHook();
    testQueueFirst();

    const main = stockMain();
    [['a duplicated class anchor', main.replace(CLASS_ANCHOR, `${CLASS_ANCHOR}}${CLASS_ANCHOR}`)],
        ['a missing hook anchor', main.replace(HOOK_ANCHOR, 'isMainapp&&(newProvisioning.')]]
        .forEach(([what, text]) => {
            const bad = fakeRoot({ main: text });
            const before = bad.hash();
            const r = bad.run(['fallback', 'on', '--yes']);
            check(`fallback on with ${what}: refused, exit 2`, r.status === 2 && r.out.includes('anchor'), r.out);
            check(`fallback on with ${what}: no unit, no copy, nothing changed`,
                !fs.existsSync(bad.p('etc/systemd/system/mgu-app-fallback.service')) &&
                !fs.existsSync(bad.p('var/opt/mgu-deploy/main.js')) && bad.hash().hash === before.hash,
                treeDiff(before, bad.hash()));
        });

    // the in-place hook's anchor is optional: without it the fallback still works, and installs bounce
    [['no in-place anchor', main.replace(INPLACE_ANCHOR, INPLACE_ANCHOR.replace('=>{', '=> {'))],
        ['a duplicated in-place anchor', `${main}\n(()=>{${INPLACE_ANCHOR}})`]]
        .forEach(([what, text]) => {
            const r0 = fakeRoot({ main: text });
            const r = r0.run(['fallback', 'on', '--yes']);
            const built = fs.existsSync(r0.p('var/opt/mgu-deploy/main.js')) ? fs.readFileSync(r0.p('var/opt/mgu-deploy/main.js'), 'utf8') : '';
            check(`fallback on with ${what}: the copy has the fallback but no in-place hook, and says so`, r.status === 0 &&
                built.split('/* mgu-deploy provisioning fallback */').length === 3 &&
                !built.includes('/* mgu-deploy in-place install */') && r.out.includes('the copy has no hook'), r.out);
            const i = r0.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
            check(`fallback on with ${what}: an install goes through a bounce`, i.status === 0 &&
                r0.kills().length === 2 && i.out.includes('through a bounce') &&
                r0.managerLog().includes('install fixture_app 1.0.0 uid 13001'), i.out);
        });

    // each anchor once, but where the fallback's statements cannot go: the copy does not parse
    const unparsable = main.replace(CLASS_ANCHOR, `var PN=${CLASS_ANCHOR}`);
    [['fallback on', ['fallback', 'on', '--yes']],
        ['an app install', ['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']]]
        .forEach(([what, args]) => {
            const bad = fakeRoot({ main: unparsable });
            const before = bad.hash();
            const r = bad.run(args);
            check(`${what} with a fallback copy that does not parse: refused, exit 2, naming why`,
                r.status === 2 && r.out.includes('does not parse (SyntaxError') && r.out.includes('not binding it'), r.out);
            check(`${what} with a fallback copy that does not parse: no unit, no copy, nothing changed`,
                !fs.existsSync(bad.p('etc/systemd/system/mgu-app-fallback.service')) &&
                !fs.existsSync(bad.p('var/opt/mgu-deploy/main.js')) && bad.hash().hash === before.hash,
                treeDiff(before, bad.hash()));
        });

    // the boot unit's command, its paths in a fake root and mount logged
    const boot = fakeRoot();
    boot.run(['fallback', 'on', '--yes']);
    const mounts = boot.p('mounts.log');
    const command = fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-app-fallback.service'), 'utf8')
        .match(/^ExecStart=\/bin\/sh -c '(.*)'$/m)[1]
        .split('/usr/bin/node').join(UNIT_NODE).split('/var/opt/').join(boot.p('var/opt/'))
        .split('/usr/lib/').join(boot.p('usr/lib/'));
    const bootRun = () => cp.spawnSync('sh', ['-c', `mount() { echo "$*" >> '${mounts}'; }; ${command}`], { encoding: 'utf8' });
    let b = bootRun();
    check('boot unit: a copy that parses is bound', b.status === 0 &&
        fs.readFileSync(mounts, 'utf8').includes(`--bind ${boot.p('var/opt/mgu-deploy/main.js')}`), `${b.stdout}${b.stderr}`);
    fs.unlinkSync(mounts);
    fs.writeFileSync(boot.p('usr/lib/oap-mainapp/src/main.js'), unparsable);
    b = bootRun();
    check('boot unit: a copy that does not parse is not bound, the unit succeeds', b.status === 0 && !fs.existsSync(mounts) &&
        b.stderr.includes('SyntaxError'), `${b.stdout}${b.stderr}`);

    // MainApp 6.5.5 shape: main.js is a bytecode-loader stub, main.bundle.js holds the bundle
    const boot655 = fakeRoot({ main: '// bytecode-loader stub\n' });
    write(boot655.p('usr/lib/oap-mainapp/src/main.bundle.js'), stockMain());
    const fb655 = boot655.run(['fallback', 'on', '--yes']);
    check('MainApp 6.5.5 (.bundle.js): fallback on builds from main.bundle.js when main.js is a stub',
        fb655.status === 0 && fs.existsSync(boot655.p('var/opt/mgu-deploy/main.js')), fb655.out);
    const hookStub = (input) => {
        const out = path.join(fs.mkdtempSync(path.join(T, 'hook-')), 'main.js');
        cp.execFileSync(UNIT_NODE, [path.join(HERE, '..', 'unit', 'fallback_build.js'), input, out, path.join(T, 'none.json')]);
        return (/const stub=([^,]*),ops=/.exec(fs.readFileSync(out, 'utf8')) || [])[1];
    };
    check('in-place hook: the controller\'s appManager is the installer, without a controller (6.5.5) appManager itself',
        hookStub(path.join(HERE, 'fixtures', 'main_queue.js')) === 'mgr&&mgr.appManager' &&
        hookStub(path.join(HERE, 'fixtures', 'main.js')) === 'mgr&&(mgr.appManager||mgr)');
    const mounts655 = boot655.p('mounts.log');
    const cmd655 = fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-app-fallback.service'), 'utf8')
        .match(/^ExecStart=\/bin\/sh -c '(.*)'$/m)[1]
        .split('/usr/bin/node').join(UNIT_NODE).split('/var/opt/').join(boot655.p('var/opt/'))
        .split('/usr/lib/').join(boot655.p('usr/lib/'));
    const b655 = cp.spawnSync('sh', ['-c', `mount() { echo "$*" >> '${mounts655}'; }; ${cmd655}`], { encoding: 'utf8' });
    check('MainApp 6.5.5 (.bundle.js): boot unit builds from and binds over main.bundle.js', b655.status === 0 &&
        fs.readFileSync(mounts655, 'utf8').trim() ===
        `--bind ${boot655.p('var/opt/mgu-deploy/main.js')} ${boot655.p('usr/lib/oap-mainapp/src/main.bundle.js')}`, `${b655.stdout}${b655.stderr}`);
}

/* The fallback built from the fixture main.js, run: its handle() is
 * ProvisioningNotifier's provisioningHandler reduced to what the hook sees. */
function testFallbackHook() {
    const dir = fs.mkdtempSync(path.join(T, 'hook-'));
    const list = path.join(dir, 'custom_apps.json');
    const flags = { '-enabled': 'true', '-allowed': 'true', '-appStartType': 'manually',
        '-userLoginRequired': 'false', '-updateMechanism': 'PLATFORM' };
    // their_app as idrive7-apps' installer lists it
    write(list, JSON.stringify({ our_app: flags, their_app: { '-appStartType': 'manually', '-userLoginRequired': 'false' } }));
    const r = cp.spawnSync(UNIT_NODE, [path.join(DEPLOY, 'unit', 'fallback_build.js'),
        path.join(HERE, 'fixtures', 'main.js'), path.join(dir, 'built.js'), list], { encoding: 'utf8' });
    check('fallback hook: builds from the fixture main.js', r.status === 0, r.stderr);
    if (r.status !== 0) {
        return;
    }
    const handle = (section, prov) => new (require(path.join(dir, 'built.js')))().handle(section, prov);
    const main = handle('main_app', { installable_apps: { app: { '#text': 'provisioned_app' } } });
    check('fallback hook: installable_apps keeps the provisioned app and adds ours',
        main.installable_apps.app.map((a) => a['#text']).join(',') === 'provisioned_app,our_app,their_app', JSON.stringify(main));
    check('fallback hook: an entry without -enabled/-allowed (idrive7-apps\' installer) takes them as true',
        JSON.stringify(handle('their_app', undefined)) === JSON.stringify(flags) &&
        main.installable_apps.app[2]['-enabled'] === 'true', JSON.stringify(handle('their_app', undefined)));
    check('fallback hook: our app with no section of its own takes its flags',
        JSON.stringify(handle('our_app', undefined)) === JSON.stringify(flags) &&
        JSON.stringify(handle('our_app', {})) === JSON.stringify(flags));
    check('fallback hook: a provisioned section is kept',
        JSON.stringify(handle('our_app', { '-enabled': 'false' })) === '{"-enabled":"false"}');
    check('fallback hook: an app custom_apps.json does not list is unchanged',
        handle('other_app', undefined) === undefined);
}

/* The copy built from fixtures/main_queue.js: our apps' installs go first in
 * the controller's queue, behind the one running; an app not listed waits its
 * turn. The stock fixture main.js lacks the anchors: built without, said. */
function testQueueFirst() {
    const dir = fs.mkdtempSync(path.join(T, 'queue-'));
    const list = path.join(dir, 'custom_apps.json');
    write(list, JSON.stringify({ our_app: {}, their_app: { '-appStartType': 'manually' } }));
    const build = (fixture, out) => cp.spawnSync(UNIT_NODE, [path.join(DEPLOY, 'unit', 'fallback_build.js'),
        path.join(HERE, 'fixtures', fixture), path.join(dir, out), list], { encoding: 'utf8' });
    const run = (built) => {
        const r = cp.spawnSync(UNIT_NODE, [path.join(HERE, 'queue_first.js'), path.join(dir, built)], { encoding: 'utf8' });
        try { return JSON.parse(r.stdout); } catch (e) { return { error: r.stdout + r.stderr }; }
    };
    const b = build('main_queue.js', 'built.js');
    check('queue first: builds from the queue fixture, with no note', b.status === 0 && !b.stdout.includes('install queue'), b.stdout + b.stderr);
    if (b.status !== 0) return;
    /* not before every one of BMW's apps had its next try (or not yet at all) */
    const late = (o, a) => { const i = (o.ran || []).indexOf(a); return i < 0 || i > 7; };
    const r = run('built.js'), ran = r.ran || [];
    check('queue first: ours run right behind the one running, in their order, ahead of the others waiting',
        ran.indexOf('our_app') === 2 && ran.indexOf('their_app') === 3 && late(r, 'other_app'), JSON.stringify(r));
    check('queue first: ours are done before the retry waits of the others', r.done && r.done.our_app < 300 && r.done.their_app < 300,
        JSON.stringify(r));
    check('queue first: MainApp\'s log says what moved',
        (r.log || []).join('|') === 'mgu-deploy: install our_app queued ahead of 5 other install(s)|' +
            'mgu-deploy: install their_app queued ahead of 5 other install(s)', JSON.stringify(r.log));
    /* ten of ours at once, one of them failing with a network error */
    const ten = Array.from({ length: 10 }, (x, i) => `app_${i}`);
    write(list, JSON.stringify(ten.reduce((o, id) => Object.assign(o, { [id]: {} }), {})));
    const r10 = cp.spawnSync(UNIT_NODE, [path.join(HERE, 'queue_first.js'), path.join(dir, 'built.js'), ten.join(','), 'app_4'],
        { encoding: 'utf8' });
    let t = {};
    try { t = JSON.parse(r10.stdout); } catch (e) { t = { error: r10.stdout + r10.stderr }; }
    const ran10 = t.ran || [];
    check('queue first: ten of ours at once run right behind the one running, in their order',
        JSON.stringify(ran10.slice(2, 12)) === JSON.stringify(ten), JSON.stringify(t));
    check('queue first: one of ours that fails is queued again at the end, not first again',
        (ran10.indexOf('app_4', 7) < 0 || ran10.indexOf('app_4', 7) > 16) && ran10.slice(12, 17).every((a) => /^bmw_/.test(a)) &&
        ten.filter((a) => a !== 'app_4').every((a) => t.done && t.done[a] < 400), JSON.stringify(t));
    /* first into an empty queue, behind a retry wait the others left */
    write(list, JSON.stringify({ our_app: {} }));
    const alone = (failing) => {
        const r = cp.spawnSync(UNIT_NODE, [path.join(HERE, 'queue_first.js'), path.join(dir, 'built.js'), 'our_app', failing, 'empty'],
            { encoding: 'utf8' });
        try { return JSON.parse(r.stdout); } catch (e) { return { error: r.stdout + r.stderr }; }
    };
    const e = alone('');
    check('queue first: one of ours first in an empty queue does not wait out the retry delay left behind',
        (e.ran || [])[0] === 'our_app' && e.done && e.done.our_app < 150, JSON.stringify(e));
    const ef = alone('our_app'), efRan = ef.ran || [];
    check('queue first: one of ours first in an empty queue that fails is queued again at the end, not first again',
        efRan[0] === 'our_app' && efRan[1] === 'bmw_1' && (efRan.indexOf('our_app', 1) < 0 || efRan.indexOf('our_app', 1) > 6),
        JSON.stringify(ef));
    write(list, '{}');
    const s = run('built.js');
    check('queue first: an app custom_apps.json no longer lists waits its turn', late(s, 'our_app') && !(s.log || []).length,
        JSON.stringify(s));
    write(list, 'not json');
    const u = run('built.js');
    check('queue first: an unreadable custom_apps.json leaves the queue as it is', late(u, 'our_app') && !(u.log || []).length, JSON.stringify(u));
    const p = build('main.js', 'plain.js');
    check('queue first: a main.js without its anchors is built without it, said',
        p.status === 0 && p.stdout.includes('anchors for our apps first in the install queue not found exactly once') &&
        !fs.readFileSync(path.join(dir, 'plain.js'), 'utf8').includes('mgu-deploy apps first'), p.stdout + p.stderr);
}

/* ---- in-place install --------------------------------------------------------------------- */

const inplaceChildren = [];
function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function inplaceStatus(root) {
    return readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/mgu-deploy-inplace.json`));
}
/* fake_inplace.js as the running manager, on the fallback copy's hook;
 * back once the hook announced itself ("late": once the process runs). */
function startInplace(root, mode, env) {
    const child = cp.spawn(process.execPath, [path.join(HERE, 'fake_inplace.js'), root.p('var/opt/mgu-deploy/main.js')],
        { env: Object.assign({}, root.env, { FAKE_INPLACE: mode || '' }, env || {}), stdio: 'ignore' });
    inplaceChildren.push(child);
    const t0 = Date.now();
    for (;;) {
        const st = inplaceStatus(root);
        if (mode === 'late' ? root.managerPid() === child.pid : st && st.pid === child.pid) {
            return child;
        }
        if (Date.now() - t0 > 10000) {
            throw new Error('fake_inplace.js did not start');
        }
        sleep(25);
    }
}
/* A unit with fixture_app 1.0.0 installed (the first install turns the
 * fallback on, through a bounce), then the manager on the hook. */
function inplaceRoot(mode, opts, env) {
    const root = fakeRoot(opts);
    const first = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    if (first.status !== 0) {
        throw new Error(`first install failed: ${first.out}`);
    }
    return { root, first, mgr: startInplace(root, mode, env) };
}

function testInplace() {
    const { root, first, mgr } = inplaceRoot();
    const request = root.p('var/opt/mgu-deploy/inplace/request.json');
    check('in place: the first install writes the fallback copy after the manager started, so it bounces',
        root.kills().length === 1 && first.out.includes('through a bounce: its main.js or AppManagement.js was written after it started'),
        first.out);
    const copy = root.p('var/opt/mgu-deploy/main.js');
    const copyAt = fs.statSync(copy).mtimeMs;
    const stockEntry = fs.readFileSync(root.entry('stock_app'));
    const fresh = root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    check('in place: a fresh install is the running manager\'s own install, no bounce', fresh.status === 0 &&
        root.kills().length === 1 && root.managerLog().includes('install second_app 1.0.0 uid 13002 in place') &&
        fresh.out.includes(`installed in place by the app manager (pid ${mgr.pid}) as uid 13002`),
    `${fresh.out}\n${root.managerLog().join('\n')}`);
    const st = inplaceStatus(root) || {};
    check('in place: the hook answered done, and the request is gone', st.state === 'done' && st.app === 'second_app' &&
        st.action === 'install' && st.pid === mgr.pid && !fs.existsSync(request), JSON.stringify(st));
    check('in place: listed by the fallback and recorded with its uid',
        'second_app' in (readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {}) &&
        JSON.stringify(root.state().apps.second_app) === JSON.stringify({ uid: 13002, version: '1.0.0' }), JSON.stringify(root.state()));
    check('in place: the fallback copy is not rewritten when its bytes are the same', fs.statSync(copy).mtimeMs === copyAt);
    // the entry point's code cache of 1.0.0's bundle: the firmware's V8 runs it for a bundle of the same length
    const cache = path.join(root.home(13001), 'data/app.js.bytecode'), own = path.join(root.home(13001), 'data/settings.json');
    write(cache, 'cache of 1.0.0');
    write(own, '{}');
    const up = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('in place: an update removes the app\'s code cache, its other data stays', up.status === 0 && !fs.existsSync(cache) &&
        fs.existsSync(own) && up.out.includes('fixture_app: its code cache goes'), up.out);
    check('in place: an update is the running manager\'s own update, uid kept, no re-seed, no bounce', up.status === 0 &&
        root.kills().length === 1 && readJson(root.entry('fixture_app')).userId === 13001 &&
        readJson(path.join(root.home(13001), 'source/package.json')).version === '1.1.0' &&
        root.managerLog().includes('update fixture_app 1.1.0 uid 13001 in place') && !up.out.includes('re-seeded') &&
        up.out.includes('updated in place'), `${up.out}\n${root.managerLog().join('\n')}`);
    check('in place: the manager kept running, the other apps\' entries are untouched',
        root.managerPid() === mgr.pid && mgr.exitCode === null && fs.readFileSync(root.entry('stock_app')).equals(stockEntry));
    check('in place: the hook logged both requests in the manager\'s log',
        root.managerLog().includes('hook mgu-deploy in-place install second_app: done') &&
        root.managerLog().includes('hook mgu-deploy in-place update fixture_app: done'), root.managerLog().join('\n'));
    // the app owns its home: a data folder that is a link leads the removal nowhere
    const elsewhere = root.p('var/opt/elsewhere');
    write(path.join(elsewhere, 'app.js.bytecode'), 'not the app\'s');
    fs.renameSync(path.join(root.home(13001), 'data'), root.p('var/opt/fixture_data'));
    fs.symlinkSync(elsewhere, path.join(root.home(13001), 'data'));
    const linked = root.run(['install', '--artifact', appArtifact('fixture_app', '1.2.0', true), '--yes']);
    check('in place: an update leaves a file a linked data folder leads to', linked.status === 0 &&
        fs.existsSync(path.join(elsewhere, 'app.js.bytecode')) && !linked.out.includes('its code cache goes'), linked.out);
    fs.unlinkSync(path.join(root.home(13001), 'data'));
    fs.renameSync(root.p('var/opt/fixture_data'), path.join(root.home(13001), 'data'));

    // a copy written after the manager started: it runs older code, so a bounce
    fs.utimesSync(copy, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
    const newer = root.run(['install', '--artifact', appArtifact('third_app', '1.0.0', true), '--yes']);
    check('in place: a manager that started before main.js was written is bounced instead', newer.status === 0 &&
        root.kills().length === 2 && newer.out.includes('was written after it started') &&
        root.managerLog().includes('install third_app 1.0.0 uid 13003'), newer.out);
    fs.utimesSync(copy, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
    const next = root.run(['install', '--artifact', appArtifact('third_app', '1.1.0', true), '--yes']);
    check('in place: the respawned manager announced nothing: the next install bounces too', next.status === 0 &&
        root.kills().length === 3 && next.out.includes('has no in-place hook'), next.out);

    // MainApp's installer rejected it, its errors as the iD7 firmware gives them (AppManager.update's reason
    // UPDATE_FAILED; an install's reason or code; else its message): the same install after a bounce fails too
    [['an update (UPDATE_FAILED)', () => appArtifact('fixture_app', '1.1.0', true), { FAKE_INPLACE_REASON: 'UPDATE_FAILED' },
        'could not update fixture_app 1.1.0: UPDATE_FAILED', true],
    ['a fresh install with a reason code', () => appArtifact('second_app', '1.0.0', true), { FAKE_INPLACE_REASON: 'APP_INSTALLATION_FAILED' },
        'could not install second_app 1.0.0: APP_INSTALLATION_FAILED', false],
    ['a fresh install with AppManager\'s message', () => appArtifact('second_app', '1.0.0', true), { FAKE_INPLACE_ERROR:
        'AppManagerStub::_callMethod appManager.install(second_app, ) failed due to Error: AppManager::install Failed due to validation failed' },
        'could not install second_app 1.0.0: validation failed', false]]
        .forEach(([what, artifact, env, why, update]) => {
            const c = inplaceRoot('fail', { minUp: 1 }, env);
            const r = c.root.run(['install', '--artifact', artifact(), '--yes']);
            check(`in place: ${what} the manager failed in its installer fails with its reason, exit 1, no bounce, rolled back`,
                r.status === 1 && r.out.includes(`mgu-deploy: the app manager ${why}`) && r.out.includes('rolling back') &&
                !r.out.includes('through a bounce') && c.root.kills().length === 1 && c.root.managerPid() === c.mgr.pid &&
                c.mgr.exitCode === null && readJson(c.root.entry('fixture_app')).userId === 13001 &&
                (update || !fs.existsSync(c.root.entry('second_app'))), r.out);
        });

    // MainApp's own error, with its stack: the reason in one line
    const cert = inplaceRoot('fail', { minUp: 1 }, { FAKE_INPLACE_ERROR: 'AppManagerStub::_callMethod appManager.install(second_app, ) ' +
        'failed due to Error: AppManager::install Failed due to { Error: uidrun::runCommand#close uidrun exited with return code 1 ' +
        'and error . uidrun -u 13002 -g 13002 903 -c /usr/lib/oap-mainapp/src/scripts/CertificateManager.js -- second_app ' +
        '/var/opt/public/oap/oap_13002/security.\n    at ChildProcess.uidrunProcess.on.code (AppManagement.js:3374:6111)' });
    const cr = cert.root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    // with what the copy of CertificateManager.js said on stderr
    const told = inplaceRoot('fail', { minUp: 1 }, { FAKE_INPLACE_ERROR: 'AppManagerStub::_callMethod appManager.install(second_app, ) ' +
        'failed due to Error: AppManager::install Failed due to { Error: uidrun::runCommand#close uidrun exited with return code 1 ' +
        'and error keychain of second_app not ready after 120s; certificate service states: 0s 2, 30s 2; /x before the request: ' +
        'empty; uid 13002\n. uidrun -u 13002 -g 13002 903 -c /usr/lib/oap-mainapp/src/scripts/CertificateManager.js -- second_app /x.' });
    const tr = told.root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    check('in place: what the copy of CertificateManager.js said is the reason', tr.status === 1 &&
        tr.out.includes('mgu-deploy: the app manager could not install second_app 1.0.0: MainApp\'s CertificateManager: keychain of ' +
            'second_app not ready after 120s; certificate service states: 0s 2, 30s 2; /x before the request: empty; uid 13002\n'), tr.out);
    check('in place: a keychain MainApp could not create is said so, on one line', cr.status === 1 &&
        cr.out.includes('mgu-deploy: the app manager could not install second_app 1.0.0: MainApp\'s CertificateManager did not ' +
            'create the app\'s keychain (uidrun exited 1)') && !/\n\s+at ChildProcess/.test(cr.out), cr.out);

    const cases = [
        ['an update whose channel to the AppManagement child failed', 'fail', () => appArtifact('fixture_app', '1.1.0', true),
            { FAKE_INPLACE_ERROR: 'AppManagerStub::_callMethod appManager.update(fixture_app, PLATFORM) failed due to Error: channel closed.' },
            'the app manager failed the in-place update (AppManagerStub::_callMethod appManager.update(fixture_app, PLATFORM) failed due to ' +
            'Error: channel closed.)', 'update fixture_app 1.1.0 uid 13001'],
        ['a refused install', 'refuse', () => appArtifact('second_app', '1.0.0', true), {},
            'the app manager refused the in-place install (already registered)', 'install second_app 1.0.0 uid 13002'],
        ['a request not taken', 'deaf', () => appArtifact('second_app', '1.0.0', true), { MGU_DEPLOY_INPLACE_ACK_MS: '500' },
            'the app manager did not take the request within 1s', 'install second_app 1.0.0 uid 13002'],
        ['a manager that restarted during the install', 'respawn', () => appArtifact('second_app', '1.0.0', true), {},
            'the app manager restarted during the in-place install', 'install second_app 1.0.0 uid 13002']
    ];
    cases.forEach(([what, mode, artifact, extra, why, done]) => {
        const c = inplaceRoot(mode, { minUp: 1 }, extra);
        const r = c.root.run(['install', '--artifact', artifact(), '--yes'], extra);
        const k = c.root.kills();
        check(`in place: ${what} falls back to a bounce, which installs it`, r.status === 0 &&
            r.out.includes(`through a bounce: ${why}`) && k.length === 2 && c.root.managerLog().includes(done),
        `${r.out}\n${c.root.managerLog().join('\n')}`);
        check(`in place: ${what}: the bounce kept its spacing, and the request is gone`,
            k.length === 2 && k[1].at - k[0].at >= 1000 && !fs.existsSync(c.root.p('var/opt/mgu-deploy/inplace/request.json')),
            JSON.stringify(k));
    });

    // the manager took the request: no bounce, which could cut its install short
    const hang = inplaceRoot('hang', { minUp: 1 });
    const hr = hang.root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    check('in place: an install the manager took but did not finish in time fails like a watch timeout, exit 1, no bounce',
        hr.status === 1 && hr.out.includes('not bounced, it may still be installing') && hr.out.includes('rolling back') &&
        hang.root.kills().length === 1 && hang.root.managerPid() === hang.mgr.pid && hang.mgr.exitCode === null &&
        !('second_app' in (readJsonOrNull(hang.root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {})), hr.out);
    const blink = inplaceRoot('blink');
    const br = blink.root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    check('in place: a moment with no manager in ps is not a restart: installed in place, no bounce', br.status === 0 &&
        blink.root.kills().length === 1 && br.out.includes('installed in place') &&
        blink.root.managerLog().includes('install second_app 1.0.0 uid 13002 in place'), br.out);

    // the manager is installing the app by itself when the hook refuses: no bounce once that install is done
    const self = inplaceRoot('self', { minUp: 4 });
    const sr = self.root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    const sl = self.root.managerLog();
    check('in place: an app the manager installs by itself is waited for as a bounce would, then needs no bounce',
        sr.status === 0 && self.root.kills().length === 1 && sr.out.includes('refused the in-place install (already registered)') &&
        sr.out.includes('waiting') && sr.out.includes('installed by the app manager on its own as uid 13002') &&
        !sr.out.includes('through a bounce') && sl.includes('install second_app 1.0.0 uid 13002 on its own') &&
        sl.includes('finished second_app on its own'), `${sr.out}\n${sl.join('\n')}`);
    // a failed request counts as the manager's own install only when it failed as installed already
    [['APP_ALREADY_INSTALLED', 1], ['APP_START_FAILED', 2]].forEach(([reason, kills]) => {
        const f = inplaceRoot('failafter', {}, { FAKE_INPLACE_REASON: reason });
        const fr = f.root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
        check(`in place: an install the manager failed with ${reason}, its files in place: ` +
            (kills === 1 ? 'installed, no bounce' : 'a bounce'), fr.status === 0 && f.root.kills().length === kills &&
            fr.out.includes(`failed the in-place install (${reason})`) &&
            fr.out.includes(kills === 1 ? 'installed by the app manager on its own' : 'through a bounce'), fr.out);
    });

    // an update the manager made by itself before the request (a provisioning pass): no bounce
    const au = inplaceRoot('failafter', {}, { FAKE_INPLACE_REASON: 'APP_ALREADY_UPDATED' });
    const ar = au.root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('in place: an update the manager failed as updated already, at the new version: updated, no bounce',
        ar.status === 0 && au.root.kills().length === 1 && ar.out.includes('failed the in-place update (APP_ALREADY_UPDATED)') &&
        ar.out.includes('installed by the app manager on its own as uid 13001') && !ar.out.includes('through a bounce'), ar.out);

    // the wait is told from the hook's trace of the installer: the child's start, another app's run ahead
    const slow = inplaceRoot('', {}, { FAKE_INPLACE_FORK_MS: '2500', FAKE_INPLACE_AHEAD_MS: '2500' });
    const slr = slow.root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes'],
        { MGU_DEPLOY_INPLACE_REPORT_MS: '1000', MGU_DEPLOY_WATCH_TIMEOUT_MS: '15000' });
    check('in place: the wait is reported each interval, from the installer\'s trace', slr.status === 0 &&
        /the app manager is on it \(\ds\): .*AppManagement child starting since \+\d+s/.test(slr.out) &&
        /the app manager is on it \(\ds\): in the installer's queue since \+\d+s; other stock_app running for \d+s/.test(slr.out),
    slr.out);
    check('in place: the end of the wait says where the time went',
        /the app manager done after \d+s: installing since \+[4-6]s, ended \+[4-6]s; other stock_app ran until \+[4-6]s; AppManagement child started \+0s to \+[2-3]s/
            .test(slr.out), slr.out);

    // a manager younger than the bounce minimum gets until then to announce the hook
    const late = inplaceRoot('late', { minUp: 4 });
    const t0 = Date.now();
    const lr = late.root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    check('in place: a young manager that announces its hook late installs in place, no bounce', lr.status === 0 &&
        late.root.kills().length === 1 && lr.out.includes('to announce its in-place hook') &&
        late.root.managerLog().includes('install second_app 1.0.0 uid 13002 in place') && Date.now() - t0 < 4000, lr.out);
}

/* MainApp's CertificateManager.js in the shape the copy's edits anchor on:
 * a service that reports $states, a TIMEOUT, a keychain written when ready. */
function stockCertManager(states) {
    return `#!/usr/bin/env node
"use strict";const fs=require("fs"),path=require("path"),util=require("util"),logger={info(){},error(){}};
const certmgr={READY:"READY",setupKeychain(){},stopKeychainNotification(){},
useKeychain(p,cb){${JSON.stringify(states)}.forEach((s,i)=>setTimeout(()=>cb(s,{k:1}),20*i));return 1}};
const TIMEOUT=3e4;
function requestKeyChain(process){const logPrefix="CertificateManager::requestKeyChain",[appName,keyChainPath]=process.argv.slice(2);logger.info("start"),certmgr.setupKeychain(appName,keyChainPath);const handle=certmgr.useKeychain(keyChainPath,(state,_chain)=>{if(state===certmgr.READY){const keyChainFile=path.join(keyChainPath,"joynrKeyChain.json");return util.promisify(fs.writeFile)(keyChainFile,JSON.stringify(_chain,null,2)).then(()=>{process.exit(0)}).catch(e=>{logger.error(\`\${logPrefix} Error while requesting keyChain due to \${e}.\`),certmgr.stopKeychainNotification(handle),process.exit(1)})}});setTimeout(()=>{logger.error(\`\${logPrefix} Terminating due to \${TIMEOUT}ms timeout.\`),certmgr.stopKeychainNotification(handle),process.exit(1)},TIMEOUT)}
requestKeyChain(process);
`;
}

function testCertCopy() {
    const root = fakeRoot();
    const stock = root.p('usr/lib/oap-mainapp/src/scripts/CertificateManager.js');
    const copy = root.p('var/opt/mgu-deploy/CertificateManager.js');
    write(stock, stockCertManager(['PENDING', 'PENDING']));
    const r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const text = fs.existsSync(copy) ? fs.readFileSync(copy, 'utf8') : '';
    check('certificate wait: an app install builds the copy of CertificateManager.js, waiting 115 s',
        r.status === 0 && r.out.includes('keychain wait of MainApp\'s installs: 115 s') && text.includes('TIMEOUT=115e3') &&
        (fs.statSync(copy).mode & 0o777) === 0o755 && fs.readFileSync(stock, 'utf8') === stockCertManager(['PENDING', 'PENDING']), r.out);
    // the copy run as MainApp runs it (its service's states swapped in), with a short wait
    const run = (states, timeout) => {
        const dir = fs.mkdtempSync(path.join(T, 'sec-'));
        fs.writeFileSync(path.join(dir, 'old.json'), 'abc');
        const script = path.join(dir, '..', path.basename(dir) + '.js');
        fs.writeFileSync(script, text.replace(JSON.stringify(['PENDING', 'PENDING']), JSON.stringify(states))
            .replace('TIMEOUT=115e3', `TIMEOUT=${timeout}`));
        const out = cp.spawnSync(process.execPath, [script, 'demo_app', dir], { encoding: 'utf8' });
        return { out, dir };
    };
    const slow = run(['PENDING', 'PENDING'], 300);
    check('certificate wait: a keychain not ready in time exits 1, its states, folder and uid on stderr',
        slow.out.status === 1 && new RegExp('^keychain of demo_app not ready after 0.3s; certificate service states: ' +
            '0s PENDING, 0s PENDING; ' + slow.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' before the request: old.json:\\d+:3; uid \\d+\n$')
            .test(slow.out.stderr), slow.out.stderr);
    const ready = run(['PENDING', 'READY'], 5000);
    check('certificate wait: a ready keychain is written, exit 0, nothing on stderr', ready.out.status === 0 &&
        ready.out.stderr === '' && fs.existsSync(path.join(ready.dir, 'joynrKeyChain.json')), ready.out.stderr);
    // a script whose anchors are not each there once: the stock one runs, said so
    const odd = fakeRoot();
    write(odd.p('usr/lib/oap-mainapp/src/scripts/CertificateManager.js'), stockCertManager([]).replace('TIMEOUT=3e4', 'TIMEOUT=4e4'));
    const or = odd.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('certificate wait: an unknown script is left as it is, with a warning, and the install goes on',
        or.status === 0 && or.out.includes('MainApp keeps its 30 s keychain wait') &&
        !fs.existsSync(odd.p('var/opt/mgu-deploy/CertificateManager.js')), or.out);
    // a copy that does not parse is never bound
    const bad = fakeRoot();
    write(bad.p('usr/lib/oap-mainapp/src/scripts/CertificateManager.js'),
        stockCertManager([]).replace('const TIMEOUT=3e4;', 'const TIMEOUT=3e4;)'));
    const br = bad.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('certificate wait: a copy that does not parse is not used, with a warning, and the install goes on',
        br.status === 0 && br.out.includes('does not parse') && !fs.existsSync(bad.p('var/opt/mgu-deploy/CertificateManager.js')), br.out);
    // the copy cannot be put in place: the install goes on with the stock script
    const stuck = fakeRoot();
    write(stuck.p('usr/lib/oap-mainapp/src/scripts/CertificateManager.js'), stockCertManager([]));
    write(stuck.p('var/opt/mgu-deploy/CertificateManager.js/x'), 'a folder where the copy goes');
    const sr = stuck.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('certificate wait: a copy that cannot be put in place never fails the install',
        sr.status === 0 && sr.out.includes('is not in place (') && sr.out.includes('MainApp keeps its 30 s keychain wait') &&
        readJson(stuck.entry('fixture_app')).userId > 0, sr.out);
    const off = root.run(['fallback', 'off', '--yes']);
    check('certificate wait: fallback off removes the copy', off.status === 0 && !fs.existsSync(copy), off.out);
    // MainApp 8.1.1's script binds the keychain handle with let
    const old = fakeRoot({ mainapp811: true });
    write(old.p('usr/lib/oap-mainapp/src/scripts/CertificateManager.js'), stockCertManager([]).replace('const handle=', 'let handle='));
    const lr = old.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const ltext = fs.existsSync(old.p('var/opt/mgu-deploy/CertificateManager.js')) ?
        fs.readFileSync(old.p('var/opt/mgu-deploy/CertificateManager.js'), 'utf8') : '';
    check('certificate wait: MainApp 8.1.1\'s script takes the same copy', lr.status === 0 &&
        lr.out.includes('keychain wait of MainApp\'s installs: 115 s') && ltext.includes('TIMEOUT=115e3') &&
        ltext.includes('let handle=certmgr.useKeychain(keyChainPath,(state,_chain)=>{__mgu.states.length<30&&'), lr.out);
}

/* MainApp 8.1.1 and 8.2.10: their AppManagement.js names no
 * installationSource; their installs and updates record none, and their
 * start updates no app. 8.2.10's main.js has the fixture's anchors. */
function testMainApp811() {
    const { root, first, mgr } = inplaceRoot(undefined, { mainapp811: true });
    check('MainApp 8.1.1 and 8.2.10: a fresh install through a bounce is done without an installationSource', first.status === 0 &&
        first.out.includes('fixture_app 1.0.0 installed by the app manager as uid 13001 (source not recorded)') &&
        !('installationSource' in readJson(root.entry('fixture_app'))), first.out);
    const fresh = root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    check('MainApp 8.1.1 and 8.2.10: a fresh install in place, no bounce', fresh.status === 0 && root.kills().length === 1 &&
        fresh.out.includes(`installed in place by the app manager (pid ${mgr.pid}) as uid 13002 (source not recorded)`),
    `${fresh.out}\n${root.managerLog().join('\n')}`);
    const up = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('MainApp 8.1.1 and 8.2.10: an update in place, uid kept, no re-seed, no bounce', up.status === 0 && root.kills().length === 1 &&
        up.out.includes('updated in place') && !up.out.includes('re-seeded') &&
        readJson(path.join(root.home(13001), 'source/package.json')).version === '1.1.0', `${up.out}\n${root.managerLog().join('\n')}`);

    // a running manager without the hook: one bounce, then the restarted manager updates in place
    const installed = (opts) => {
        const r0 = fakeRoot(opts);
        const i0 = r0.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
        if (i0.status !== 0) throw new Error(`first install failed: ${i0.out}`);
        return r0;
    };
    const b = installed({ mainapp811: true });
    const k0 = b.kills().length;
    const r = b.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes'], { FAKE_MGR_HOOK: '1' });
    const log = b.managerLog();
    let killAt = -1;
    log.forEach((l, i) => { if (l.startsWith('kill ')) killAt = i; });
    check('MainApp 8.1.1 and 8.2.10: an update through a bounce is made in place by the restarted manager, no re-seed',
        r.status === 0 && b.kills().length === k0 + 1 && r.out.includes('through a bounce') && r.out.includes('updated in place') &&
        !r.out.includes('re-seeded') && killAt >= 0 && log.indexOf('update fixture_app 1.1.0 uid 13001 in place') > killAt &&
        !('installationSource' in readJson(b.entry('fixture_app'))), `${r.out}\n${log.join('\n')}`);
    stopHooked(b);

    // the restarted manager fails the update: said so, no second bounce
    const f = installed({ mainapp811: true });
    const fk = f.kills().length;
    const fr = f.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes'],
        { FAKE_MGR_HOOK: '1', FAKE_INPLACE: 'fail' });
    check('MainApp 8.1.1 and 8.2.10: an update the restarted manager fails is reported, one bounce',
        fr.status !== 0 && fr.out.includes('the app manager could not update fixture_app 1.1.0 after its restart') &&
        f.kills().length >= fk + 1, fr.out);
    stopHooked(f);
}

/* MainApp 6.5.5: main.js is a bytecode-loader stub that runs main.bundle.js,
 * and its restarted manager installs no app at its start. */
function testMainApp655() {
    const root = fakeRoot({ mainapp811: true, main: '// bytecode-loader stub\n' });
    write(root.p('usr/lib/oap-mainapp/src/main.bundle.js'), stockMain());
    const r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'],
        { FAKE_MGR_HOOK: '1', FAKE_MGR_NO_START_INSTALL: '1' });
    const log = root.managerLog();
    let killAt = -1;
    log.forEach((l, i) => { if (l.startsWith('kill ')) killAt = i; });
    check('MainApp 6.5.5: a fresh install through a bounce is made in place by the restarted manager',
        r.status === 0 && root.kills().length === 1 && r.out.includes('through a bounce') &&
        r.out.includes('installed in place by the app manager') && killAt >= 0 &&
        log.indexOf('install fixture_app 1.0.0 uid 13001 in place') > killAt, `${r.out}\n${log.join('\n')}`);
    stopHooked(root);
}

/* The certification service in the app's SOME/IP manifest: MainApp's install gets its keychain through it. */
function testCertificationProxy() {
    const withManifest = (name, manifest, pkgExtra) => {
        const pkg = Object.assign({ name, version: '1.0.0', description: 'deploy test app', mguLocalOnly: true }, pkgExtra);
        const file = path.join(fs.mkdtempSync(path.join(T, 'app-')), `${name}@1.0.0.tgz`);
        const files = [
            { name: 'javascript/app.js', data: Buffer.from('console.log(1);\n'), mode: 0o644 },
            { name: 'package.json', data: Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), mode: 0o644 }];
        if (manifest) files.push({ name: manifest.name, data: Buffer.from(JSON.stringify(manifest.data)), mode: 0o644 });
        fs.writeFileSync(file, tgz(files, 1700000000));
        return file;
    };
    const installed = (root, id, name) => readJson(path.join(root.home(readJson(root.entry(id)).userId), 'source', name || 'manifest.json'));
    const root = fakeRoot();
    const r = root.run(['install', '--artifact', withManifest('cert_app', { name: 'manifest.json',
        data: { proxies: { 'de.bmw.infotainment.hmi.entrypoint.EntryPoint': '*' }, services: {} } }), '--yes']);
    const m = r.status === 0 ? installed(root, 'cert_app') : {};
    check('certification: a SOME/IP manifest without the certification service gets it, the rest kept',
        r.status === 0 && r.out.includes('the certification service added to manifest.json') &&
        m.proxies['de.bmw.infotainment.certification.Certification'] === '*' &&
        m.proxies['de.bmw.infotainment.hmi.entrypoint.EntryPoint'] === '*' && JSON.stringify(m.services) === '{}', r.out);
    const named = root.run(['install', '--artifact', withManifest('named_app', { name: 'someip.json', data: { proxies: {} } },
        { oapAppSettings: { someipManifest: 'someip.json' } }), '--yes']);
    check('certification: the manifest package.json names is the one completed', named.status === 0 &&
        installed(root, 'named_app', 'someip.json').proxies['de.bmw.infotainment.certification.Certification'] === '*', named.out);
    const has = withManifest('has_app', { name: 'manifest.json',
        data: { proxies: { 'de.bmw.infotainment.certification.Certification': '*' } } });
    const hr = root.run(['install', '--artifact', has, '--yes']);
    check('certification: a manifest that names it, and a package with no manifest, are not prepared for it',
        hr.status === 0 && !hr.out.includes('prepared has_app') && !hr.out.includes('certification service added') &&
        !root.run(['install', '--artifact', withManifest('plain_app', null), '--yes']).out.includes('prepared plain_app'), hr.out);
    const lacking = JSON.stringify({ proxies: { 'de.bmw.infotainment.hmi.entrypoint.EntryPoint': '*' } });
    const src7 = donorRoot();
    const s7 = src7.run(['install', '--artifact', sourceArtifact('1.0.0', {}, { 'manifest.json': lacking }), '--yes']);
    const s7m = s7.status === 0 ? JSON.parse(untarBuf(fs.readFileSync(src7.preinstalled('robertn_demo', '1.0.0')))['manifest.json']) : { proxies: {} };
    check('certification: a source package whose manifest lacks it is built with it and installs (iDrive 7)', s7.status === 0 &&
        s7.out.includes('the certification service added to manifest.json') &&
        s7m.proxies['de.bmw.infotainment.certification.Certification'] === '*' &&
        s7m.proxies['de.bmw.infotainment.hmi.entrypoint.EntryPoint'] === '*', s7.out);
    const queued8 = (root, id, v) => untarBuf(fs.readFileSync(root.p(`var/opt/mgu-deploy/id8/queue/${id}@${v}.tgz`)));
    const src8 = id8Root();
    donor.tgz(src8.pre21('donor_app', '1.0.0'));
    const s8 = src8.run(['install', '--artifact', sourceArtifact('1.0.0', {}, { 'manifest.json': lacking }), '--yes']);
    const s8m = s8.status === 0 ? JSON.parse(queued8(src8, 'robertn_demo', '1.0.0')['package/manifest.json']) : { proxies: {} };
    check('certification: a source package whose manifest lacks it is built with it and queued (iDrive 8)', s8.status === 0 &&
        s8.out.includes('the certification service added to manifest.json') &&
        s8m.proxies['de.bmw.infotainment.certification.Certification'] === '*', s8.out);
    const flat8 = id8Root();
    const f8 = flat8.run(['install', '--artifact', rhmiApp('flat8', '1.0.0', ['ID8'], { npm: true, acl: ACL, manifest: JSON.parse(lacking) }), '--yes']);
    const f8m = f8.status === 0 ? JSON.parse(queued8(flat8, 'flat8', '1.0.0')['package/manifest.json']) : { proxies: {} };
    check('certification: a published package whose manifest lacks it is queued with it (iDrive 8)', f8.status === 0 &&
        f8.out.includes('the certification service added to manifest.json') &&
        f8m.proxies['de.bmw.infotainment.certification.Certification'] === '*' &&
        f8m.proxies['de.bmw.infotainment.hmi.entrypoint.EntryPoint'] === '*', f8.out);
    const has8 = rhmiApp('has8', '1.0.0', ['ID8'], { npm: true, acl: ACL, appletId: 20097,
        manifest: { proxies: { 'de.bmw.infotainment.certification.Certification': '*' } } });
    const h8 = flat8.run(['install', '--artifact', has8, '--yes']);
    check('certification: a published package whose manifest names it is queued as published (iDrive 8)', h8.status === 0 &&
        fs.readFileSync(flat8.p('var/opt/mgu-deploy/id8/queue/has8@1.0.0.tgz')).equals(fs.readFileSync(has8)), h8.out);
}

/* Interfaces the app's SOME/IP manifest names and the unit's interface database lacks (older iDrive 7
 * firmware): taken out, so MainApp installs the app. */
function testUnknownInterfaces() {
    const EP = 'de.bmw.infotainment.hmi.entrypoint.EntryPoint', EP2 = 'de.bmw.infotainment.hmi.entrypoint2.EntryPoint2';
    const CERT = 'de.bmw.infotainment.certification.Certification', STATUS = 'de.bmw.infotainment.telematic.oap.AppStatus';
    const CTX2 = 'de.bmw.infotainment.hmi.hmicontext2.HMIContext2';
    const manifest = { proxies: { [CERT]: '*', [EP]: '*', [EP2]: '*', [CTX2]: { instances: ['1'] } },
        services: { [STATUS]: { instances: ['${userId}'] } } };
    const withDb = (root, ids) => write(root.p('etc/oap/someip/someip-interfaces.json'),
        JSON.stringify({ version: 1, interfaces: ids.reduce((o, id) => Object.assign(o, { [id]: { serviceId: 1 } }), {}) }));
    const flat = (name) => {
        const file = path.join(fs.mkdtempSync(path.join(T, 'app-')), `${name}@1.0.0.tgz`);
        fs.writeFileSync(file, tgz([
            { name: 'javascript/app.js', data: Buffer.from('console.log(1);\n'), mode: 0o644 },
            { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
            { name: 'package.json', data: Buffer.from(JSON.stringify({ name, version: '1.0.0', description: 'deploy test app',
                mguLocalOnly: true })), mode: 0o644 }], 1700000000));
        return file;
    };
    const installed = (root, id) => readJson(path.join(root.home(readJson(root.entry(id)).userId), 'source', 'manifest.json'));
    const old = fakeRoot();
    withDb(old, [EP, CTX2]);
    const r = old.run(['install', '--artifact', flat('old_fw'), '--yes']);
    const m = r.status === 0 ? installed(old, 'old_fw') : { proxies: {}, services: {} };
    check('interfaces: those the unit lacks are taken out of a published package\'s manifest, the rest kept',
        r.status === 0 && r.out.includes(`${EP2}, ${STATUS} (not on this unit) taken out of manifest.json`) &&
        JSON.stringify(Object.keys(m.proxies)) === JSON.stringify([CERT, EP, CTX2]) &&
        JSON.stringify(m.services) === '{}', r.out);
    const cur = fakeRoot();
    withDb(cur, [EP, EP2, CTX2, STATUS]);
    const c = cur.run(['install', '--artifact', flat('cur_fw'), '--yes']);
    check('interfaces: a package whose interfaces the unit all has installs as published',
        c.status === 0 && !c.out.includes('prepared cur_fw') &&
        JSON.stringify(installed(cur, 'cur_fw')) === JSON.stringify(manifest), c.out);
    const none = fakeRoot();
    const n = none.run(['install', '--artifact', flat('no_db'), '--yes']);
    check('interfaces: without an interface database the manifest is kept', n.status === 0 && !n.out.includes('prepared no_db') &&
        JSON.stringify(installed(none, 'no_db')) === JSON.stringify(manifest), n.out);
    const src = donorRoot();
    withDb(src, [EP]);
    const s = src.run(['install', '--artifact', sourceArtifact('1.0.0', {}, { 'manifest.json': JSON.stringify(manifest) }), '--yes']);
    const sm = s.status === 0 ? JSON.parse(untarBuf(fs.readFileSync(src.preinstalled('robertn_demo', '1.0.0')))['manifest.json']) :
        { proxies: {} };
    check('interfaces: a source package is built without those the unit lacks', s.status === 0 &&
        s.out.includes(`${EP2}, ${CTX2}, ${STATUS} (not on this unit) taken out of manifest.json`) &&
        JSON.stringify(Object.keys(sm.proxies)) === JSON.stringify([CERT, EP]), s.out);
    const id8 = id8Root();
    donor.tgz(id8.pre21('donor_app', '1.0.0'));
    withDb(id8, [EP]);
    const e = id8.run(['install', '--artifact', sourceArtifact('1.0.0', {}, { 'manifest.json': JSON.stringify(manifest) }), '--yes']);
    const em = e.status === 0 ? JSON.parse(untarBuf(fs.readFileSync(id8.p('var/opt/mgu-deploy/id8/queue/robertn_demo@1.0.0.tgz')))[
        'package/manifest.json']) : { proxies: {} };
    const odd = fakeRoot();
    withDb(odd, [EP]);
    const oddFile = path.join(fs.mkdtempSync(path.join(T, 'app-')), 'odd_services@1.0.0.tgz');
    fs.writeFileSync(oddFile, tgz([
        { name: 'javascript/app.js', data: Buffer.from('console.log(1);\n'), mode: 0o644 },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify({ proxies: { [EP]: '*' }, services: [] })), mode: 0o644 },
        { name: 'package.json', data: Buffer.from(JSON.stringify({ name: 'odd_services', version: '1.0.0', description: 'deploy test app',
            mguLocalOnly: true })), mode: 0o644 }], 1700000000));
    const o = odd.run(['install', '--artifact', oddFile, '--yes']);
    check('interfaces: a manifest whose services are not an object still gets the certification service', o.status === 0 &&
        installed(odd, 'odd_services').proxies[CERT] === '*' && !o.out.includes('not on this unit'), o.out);
    check('interfaces: iDrive 8 keeps the manifest\'s interfaces', e.status === 0 && !e.out.includes('not on this unit') &&
        em.proxies[EP2] === '*', e.out);
}

/* What an interrupted install left: removed only when this tool provably put it there. */
function testInterrupted() {
    const listFile = (root) => root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`);
    const pre = (root, id, v) => root.preinstalled(id, v || '1.0.0');
    // listed with its package, as another installer leaves it
    const leftover = (root, id, v) => {
        const c = readJsonOrNull(listFile(root)) || {};
        c[id] = { '-enabled': 'true', '-allowed': 'true', '-appStartType': 'manually' };
        fs.writeFileSync(listFile(root), JSON.stringify(c));
        fs.copyFileSync(appArtifact(id, v || '1.0.0', true), pre(root, id, v));
    };
    // our install of id, its registry entry gone: what an interrupted install leaves
    const interrupted = (root, id) => {
        root.run(['install', '--artifact', appArtifact(id, '1.0.0', true), '--yes']);
        fs.unlinkSync(root.entry(id));
    };
    const setState = (root, f) => {
        const file = root.p('var/opt/mgu-deploy/state.json');
        const st = readJsonOrNull(file) || {};
        f(st);
        fs.writeFileSync(file, JSON.stringify(st));
    };
    const record = (root, id, extra) => setState(root, (st) => {
        st.inflight = Object.assign({ id, version: '1.0.0', pid: 999999,
            boot: fs.readFileSync(root.p('proc/boot_id'), 'utf8').trim() }, extra);
        st.placed = { [id]: { version: '1.0.0', sha256: sha256(fs.readFileSync(pre(root, id))) } };
    });
    const next = (root) => root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    const kept = (root, id, r, v) => r.status === 0 && id in readJson(listFile(root)) && fs.existsSync(pre(root, id, v)) &&
        r.out.includes(`${id} is listed for the app manager without being installed`) && !r.out.includes('removed what');

    // its record names a run that is gone, its install snapshot shows it placed the package, the checksum matches
    const a = fakeRoot();
    interrupted(a, 'ghost_app');
    record(a, 'ghost_app');
    const ar = next(a);
    const cleanup = fs.readdirSync(a.p('var/opt/mgu-deploy/backups')).filter((n) => /-cleanup$/.test(n))[0];
    const cman = cleanup ? readJson(a.p(`var/opt/mgu-deploy/backups/${cleanup}/manifest.json`)) : { entries: [] };
    const cpkg = cman.entries.filter((e) => e.path === pre(a, 'ghost_app'))[0];
    const clist = cman.entries.filter((e) => e.path === listFile(a))[0];
    check('interrupted: an install whose run is gone is unlisted and its package removed, before the next install',
        ar.status === 0 && /removed what an interrupted install of ghost_app left \(snapshot \S+-install\)/.test(ar.out) &&
        !('ghost_app' in readJson(listFile(a))) && !fs.existsSync(pre(a, 'ghost_app')) &&
        'second_app' in readJson(listFile(a)) && !('inflight' in a.state()) && !('placed' in a.state()), ar.out);
    check('interrupted: the listing and the package are snapshotted before they are removed', !!cleanup &&
        cpkg && cpkg.kind === 'file' && clist && clist.kind === 'file' &&
        'ghost_app' in readJson(a.p(`var/opt/mgu-deploy/backups/${cleanup}/${clist.stored}`)), JSON.stringify(cman));
    check('interrupted: a finished install leaves no inflight record', !('inflight' in a.state()), JSON.stringify(a.state()));
    // no record: the snapshot of its install shows this tool placed it
    const b = fakeRoot();
    interrupted(b, 'ghost_app');
    const br = next(b);
    check('interrupted: without a record, the snapshot of its install shows this tool placed it: removed',
        br.status === 0 && br.out.includes('removed what an interrupted install of ghost_app left') &&
        !('ghost_app' in readJson(listFile(b))) && !fs.existsSync(pre(b, 'ghost_app')), br.out);
    // the recorded checksum does not match the package on disk
    const c = fakeRoot();
    interrupted(c, 'ghost_app');
    record(c, 'ghost_app');
    fs.copyFileSync(appArtifact('ghost_app', '1.0.0', false), pre(c, 'ghost_app'));
    const cr = next(c);
    check('interrupted: a package that is not the one recorded is left, with a warning', kept(c, 'ghost_app', cr), cr.out);
    // the manager has not installed it (its registry entry is not there) by the install after that
    if (fs.existsSync(c.entry('ghost_app'))) fs.unlinkSync(c.entry('ghost_app'));
    const cr2 = c.run(['install', '--artifact', appArtifact('third_app', '1.0.0', true), '--yes']);
    check('interrupted: and it is still left at the install after that', kept(c, 'ghost_app', cr2), cr2.out);
    // another version than the one our install placed
    const v = fakeRoot();
    interrupted(v, 'ghost_app');
    fs.unlinkSync(pre(v, 'ghost_app'));
    leftover(v, 'ghost_app', '1.1.0');
    check('interrupted: a package of another version than the one placed is left', kept(v, 'ghost_app', next(v), '1.1.0'));
    // our uninstall after our install: what another installer put there since stays
    const u = fakeRoot();
    u.run(['install', '--artifact', appArtifact('ghost_app', '1.0.0', true), '--yes']);
    const ur = u.run(['uninstall', 'ghost_app', '--yes']);
    leftover(u, 'ghost_app');
    check('interrupted: the same id placed by another installer after our uninstall is left', ur.status === 0 && kept(u, 'ghost_app', next(u)), ur.out);
    // nothing says this tool placed it
    const n = fakeRoot();
    n.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    leftover(n, 'other_app');
    check('interrupted: a listing this tool has no snapshot of is left, with a warning', kept(n, 'other_app', next(n)));
    // a run still alive is not interrupted; an installed app is never touched
    const d = fakeRoot();
    d.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    interrupted(d, 'ghost_app');
    record(d, 'ghost_app', { pid: process.pid });
    const dr = next(d);
    check('interrupted: a recorded run that is still alive is left alone; the installed app stays listed',
        dr.status === 0 && 'ghost_app' in readJson(listFile(d)) && 'fixture_app' in readJson(listFile(d)) && !dr.out.includes('removed what'), dr.out);
    // a registry entry that cannot be read counts as installed
    const e = fakeRoot();
    interrupted(e, 'ghost_app');
    fs.writeFileSync(e.entry('ghost_app'), '{ not json');
    const er = next(e);
    check('interrupted: an app whose registry entry cannot be read is installed, and left', er.status === 0 &&
        'ghost_app' in readJson(listFile(e)) && fs.existsSync(pre(e, 'ghost_app')) && !er.out.includes('ghost_app is listed') &&
        !er.out.includes('removed what'), er.out);
}

/* The manager a bounce respawned on the hook ($FAKE_MGR_HOOK), stopped. */
function stopHooked(root) {
    const marker = `${root.R}.mgr.pid.inplace`;
    if (fs.existsSync(marker)) {
        try { process.kill(Number(fs.readFileSync(marker, 'utf8')), 'SIGKILL'); } catch (e) { /* gone */ }
    }
}

/* A copy the running manager runs, built by an earlier deploy tool: kept
 * while its in-place hook is this version's, so the update stays in place;
 * a different hook is rewritten and the manager bounced before the new
 * package is there, which it then updates in place. */
function testInplaceKeepCopy() {
    const copyOf = (root) => root.p('var/opt/mgu-deploy/main.js');
    const hookOf = (text) => {
        const mark = '/* mgu-deploy in-place install */';
        const a = text.indexOf(mark);
        return text.slice(a, text.indexOf(mark, a + 1));
    };
    const older = (root, edit) => {
        const copy = copyOf(root);
        fs.writeFileSync(copy, edit(fs.readFileSync(copy, 'utf8')));
        fs.utimesSync(copy, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
    };

    const { root, mgr } = inplaceRoot();
    older(root, (t) => `/* an earlier build */\n${t}`);
    const up = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('keep copy: an update while the manager runs an earlier build with this hook is made in place, no bounce',
        up.status === 0 && root.kills().length === 1 && up.out.includes('updated in place') &&
        root.managerPid() === mgr.pid && up.out.includes('keeps the provisioning fallback it runs'),
    `${up.out}\n${root.managerLog().join('\n')}`);
    check('keep copy: the copy it runs stays as it is', fs.readFileSync(copyOf(root), 'utf8').startsWith('/* an earlier build */'));
    const un = root.run(['uninstall', 'fixture_app', '--yes']);
    check('keep copy: an uninstall in place keeps it too, no bounce', un.status === 0 && root.kills().length === 1 &&
        un.out.includes('uninstalled in place') && fs.readFileSync(copyOf(root), 'utf8').startsWith('/* an earlier build */'), un.out);

    const b = inplaceRoot(undefined, { minUp: 1 });
    older(b.root, (t) => t.replace(hookOf(t), hookOf(t).replace('state:"ready"', 'state:"ready",earlier:1')));
    const k0 = b.root.kills().length;
    const r = b.root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes'], { FAKE_MGR_HOOK: '1' });
    const log = b.root.managerLog();
    const killAt = log.findIndex((l) => l.startsWith('kill ') && l.includes(`kill ${b.mgr.pid} `));
    check('keep copy: a different hook is written, the manager bounced once before the update, then updated in place',
        r.status === 0 && !fs.readFileSync(copyOf(b.root), 'utf8').includes('earlier:1') && b.root.kills().length === k0 + 1 &&
        r.out.includes('restarting it before the update') && r.out.includes('updated in place') && !r.out.includes('re-seeded') &&
        killAt >= 0 && log.indexOf('update fixture_app 1.1.0 uid 13001 in place') > killAt &&
        !log.some((l) => l === 'update fixture_app 1.1.0 uid 13001'),
    `${r.out}\n${log.join('\n')}`);
    check('keep copy: the bounce came before the new package was there',
        log.slice(killAt).every((l) => !/^update fixture_app [\d.]+ uid \d+$/.test(l)) &&
        readJson(b.root.entry('fixture_app')).userId === 13001, log.join('\n'));
    check('keep copy: the package waits until the restarted manager has started: its start-up pass does not update the app',
        r.out.includes('to finish starting before placing fixture_app 1.1.0') && log.indexOf('start-up pass', killAt) > killAt &&
        !log.some((l) => l.startsWith('update fixture_app') && l.endsWith(' at start')), `${r.out}\n${log.join('\n')}`);
    stopHooked(b.root);

    // a young manager, as after app-privacy's bounce, gets until the bounce minimum to announce its hook
    const young = inplaceRoot('late', { minUp: 4 });
    older(young.root, (t) => `/* an earlier build */\n${t}`);
    const k1 = young.root.kills().length;
    const y = young.root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('keep copy: a young manager that announces its hook late keeps its copy, no bounce',
        y.status === 0 && young.root.kills().length === k1 && y.out.includes('keeps the provisioning fallback it runs') &&
        y.out.includes('updated in place') && fs.readFileSync(copyOf(young.root), 'utf8').startsWith('/* an earlier build */'),
    `${y.out}\n${young.root.managerLog().join('\n')}`);
    const upd = y.out.indexOf('installing app fixture_app 1.1.0');
    check('keep copy: the wait for its hook comes before the build, while main.js is still bound',
        y.out.indexOf('to announce its in-place hook', upd) > upd &&
        y.out.indexOf('to announce its in-place hook', upd) < y.out.indexOf('fallback copy built', upd), y.out);

    // app-privacy's bounce in the same install: the package waits for the restarted manager's start-up too
    const pv = inplaceRoot(undefined, { minUp: 1 });
    const kp = pv.root.kills().length;
    const p = pv.root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes'],
        { FAKE_MGR_HOOK: '1', FAKE_PRIVACY_CHANGED_ONCE: `${pv.root.R}.privacy-changed` });
    const plog = pv.root.managerLog();
    check('keep copy: after app-privacy\'s bounce the package waits for the start-up; its pass does not update the app',
        p.status === 0 && pv.root.kills().length === kp + 1 && p.out.includes('to finish starting before placing fixture_app 1.1.0') &&
        p.out.includes('updated in place') && plog.includes('start-up pass') &&
        !plog.some((l) => l.startsWith('update fixture_app') && l.endsWith(' at start')), `${p.out}\n${plog.join('\n')}`);
    stopHooked(pv.root);

    // a kept copy, then app-privacy writes main.js: the bounce before the update restarts the manager on this version's copy
    const queueMain = `${stockMain()}
const makeMethodQueued_1=(function(){const module={};function makeMethodQueued(){}function unqueueMethodCall(){}
function getCurrentOperationPromise(){}function onQueueIdle(){}function configureQueue(){}
module.exports={makeMethodQueued:makeMethodQueued,unqueueMethodCall:unqueueMethodCall,getCurrentOperationPromise:getCurrentOperationPromise,onQueueIdle:onQueueIdle,configureQueue:configureQueue};
return module.exports})();
class AppManagementController{constructor(){this.queuedRecursiveRetry=makeMethodQueued_1.makeMethodQueued(this,this.queuedRecursiveRetry,!0)}}
`;
    const st = inplaceRoot(undefined, { minUp: 1, main: queueMain });
    older(st.root, (t) => `/* an earlier build */\n${t.split('/* mgu-deploy apps first */').join('')}`);
    sleep(50);
    const ks = st.root.kills().length;
    const s = st.root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes'],
        { FAKE_MGR_HOOK: '1', FAKE_PRIVACY_WRITES_MAIN_AT: `${st.root.R}.privacy-applies:2` });
    const copyNow = fs.readFileSync(copyOf(st.root), 'utf8');
    check('keep copy: a stale manager with a kept copy restarts on this version\'s copy, with the queue edit, then updates in place',
        s.status === 0 && st.root.kills().length === ks + 1 && s.out.includes('restarting it before the update') &&
        !copyNow.startsWith('/* an earlier build */') && copyNow.includes('/* mgu-deploy apps first */') &&
        s.out.includes('updated in place'), `${s.out}\n${st.root.managerLog().join('\n')}`);
    stopHooked(st.root);
}

/* An update of an app the running manager has not listed (the listing and
 * the fallback gone, as after a failed install's rollback) while the
 * manager runs older code: the app is listed before the restart, so the
 * restarted manager provisions it and updates it in place. */
function testStaleUnlisted() {
    const b = inplaceRoot(undefined, { minUp: 1 });
    const copy = b.root.p('var/opt/mgu-deploy/main.js');
    fs.writeFileSync(copy, `/* an earlier build */\n${fs.readFileSync(copy, 'utf8').replace('state:"ready"', 'state:"ready",earlier:1')}`);
    fs.utimesSync(copy, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
    const list = b.root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`);
    write(list, '{}\n', 0o660);
    const k0 = b.root.kills().length;
    const r = b.root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes'],
        { FAKE_MGR_HOOK: '1', FAKE_INPLACE_PROVISIONED: '1' });
    const log = b.root.managerLog();
    check('stale unlisted: listed before the restart, the restarted manager updates it in place, one bounce',
        r.status === 0 && b.root.kills().length === k0 + 1 && r.out.includes('restarting it before the update') &&
        r.out.includes('updated in place') && !r.out.includes('has been disabled') && !r.out.includes('re-seeded') &&
        log.includes('update fixture_app 1.1.0 uid 13001 in place'), `${r.out}\n${log.join('\n')}`);
    check('stale unlisted: listed enabled and allowed', ((readJsonOrNull(list) || {}).fixture_app || {})['-enabled'] === 'true');
    stopHooked(b.root);
}

/* MainApp's update unregisters the app and removes its folders before it
 * generates the app's SOME/IP interfaces; a manifest it rejects there fails
 * the update (UPDATE_FAILED) with the app neither registered nor startable.
 * The rollback leaves the previous version installed and registered, at
 * once (the manager restarted, loading it again) and after a restart. */
function testRejectedUpdate() {
    const c = inplaceRoot('reject', { minUp: 1 });
    const h = c.root.home(13001);
    write(path.join(h, 'rhmiData', 'application.json'), '{"fixture":true}\n');
    const folders = () => treeHash(h, (rel) => /^(data|kvs|security|share)(\/|$)/.test(rel)).hash;
    const before = folders();
    const entry = fs.readFileSync(c.root.entry('fixture_app'));
    const r = c.root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('rejected update: fails with the manager\'s reason, rolled back', r.status === 1 &&
        r.out.includes('mgu-deploy: the app manager could not update fixture_app 1.1.0: UPDATE_FAILED') &&
        c.root.managerLog().includes('rejected update fixture_app uid 13001'), `${r.out}\n${c.root.managerLog().join('\n')}`);
    check('rejected update: the app\'s source, interfaces and HMI data are back as they were',
        folders() === before && fs.readFileSync(c.root.entry('fixture_app')).equals(entry), r.out);
    check('rejected update: the manager is restarted once, so it loads the app again',
        c.root.kills().length === 2 && c.root.kills()[1].pid === c.mgr.pid &&
        !c.root.managerLog().some((l) => l.startsWith('init-failed fixture_app')) &&
        r.out.includes('restarting it so it loads fixture_app 1.0.0 again'), `${r.out}\n${c.root.managerLog().join('\n')}`);
    cp.spawnSync(path.join(HERE, 'fake_kill.sh'), [String(c.root.managerPid())], { env: c.root.env });
    check('rejected update: after a restart fixture_app 1.0.0 is still installed and registered as uid 13001',
        c.root.kills().length === 3 && readJson(c.root.entry('fixture_app')).userId === 13001 && folders() === before &&
        !c.root.managerLog().some((l) => l.startsWith('init-failed fixture_app')) &&
        JSON.stringify(c.root.state().apps.fixture_app) === JSON.stringify({ uid: 13001, version: '1.0.0' }),
    c.root.managerLog().join('\n'));
    check('rejected update: no copy of the app\'s folders is left',
        !fs.readdirSync(c.root.p('var/opt/mgu-deploy')).some((n) => n.startsWith('app-home-')), fs.readdirSync(c.root.p('var/opt/mgu-deploy')).join(' '));

    // a rejected fresh install: MainApp removed what it made, the rollback the rest, no restart
    const f = inplaceRoot('reject', { minUp: 1 }, { FAKE_INPLACE_REASON: 'APP_INSTALLATION_FAILED' });
    const homes = fs.readdirSync(f.root.p('var/opt/public/oap')).length;
    const fr = f.root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    check('rejected fresh install: nothing of it is left, the manager is not restarted', fr.status === 1 &&
        fr.out.includes('could not install second_app 1.0.0: APP_INSTALLATION_FAILED') && f.root.kills().length === 1 &&
        !fs.existsSync(f.root.entry('second_app')) && !fs.existsSync(f.root.preinstalled('second_app', '1.0.0')) &&
        !('second_app' in (readJsonOrNull(f.root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {})) &&
        fs.readdirSync(f.root.p('var/opt/public/oap')).length === homes, fr.out);

    // iDrive 8: MainApp-21 is not restarted; it loads the app from its folders at its next start
    const e = id8LiveRoot('reject');
    const app8 = (v) => rhmiApp('live8', v, ['ID8'], { npm: true, acl: ACL, marked: true });
    write(e.root.pre21('live8', '1.0.0'), fs.readFileSync(app8('1.0.0')));
    write(e.root.entry('live8'), JSON.stringify({ userId: 13006, installationSource: 'PREINSTALLED' }));
    write(e.root.p('var/opt/public/oap/oap_13006/source/package.json'), JSON.stringify({ name: 'live8', version: '1.0.0' }));
    write(e.root.p('var/opt/public/oap/oap_13006/someipInterfaces/acl.json'), '{}\n');
    write(e.root.p('var/opt/public/oap/oap_13006/security/joynrKeyChain.json'), '{}');
    const h8 = e.root.home(13006);
    const folders8 = () => treeHash(h8, (rel) => /^(data|kvs|security|share)(\/|$)/.test(rel)).hash;
    const before8 = folders8();
    const er = e.root.run(['install', '--artifact', app8('1.1.0'), '--yes']);
    check('rejected update, iDrive 8: rolled back with the app\'s folders and entry, back from the next start, no restart',
        er.status === 1 && e.root.managerLog().includes('rejected update live8 uid 13006') && folders8() === before8 &&
        readJson(e.root.entry('live8')).userId === 13006 && e.root.kills().length === 0 &&
        er.out.includes('live8 1.0.0 is back from the next start of the head unit'), `${er.out}\n${e.root.managerLog().join('\n')}`);
}

/* Uninstall through the running manager's own uninstall (its tile goes at
 * once), or else the bounce: not confirmed, or no manager running. */
function testInplaceUninstall() {
    const custom = (root) => readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
    const gone = (root) => !fs.existsSync(root.entry('fixture_app')) && !fs.existsSync(root.home(13001)) &&
        !fs.existsSync(root.preinstalled('fixture_app', '1.0.0')) && !('fixture_app' in custom(root)) &&
        !('fixture_app' in (root.state().apps || {}));
    const { root, mgr } = inplaceRoot();
    const stockEntry = fs.readFileSync(root.entry('stock_app'));
    const u = root.run(['uninstall', 'fixture_app', '--yes']);
    check('in-place uninstall: the running manager\'s own uninstall, no bounce', u.status === 0 &&
        root.kills().length === 1 && root.managerLog().includes('uninstall fixture_app uid 13001 in place') &&
        u.out.includes(`fixture_app uninstalled in place by the app manager (pid ${mgr.pid})`) &&
        !u.out.includes('through a bounce') && !u.out.includes('ACL/UI/status records'),
    `${u.out}\n${root.managerLog().join('\n')}`);
    check('in-place uninstall: the app\'s entry, home, package, custom_apps entry and deploy state are gone', gone(root),
        JSON.stringify(custom(root)));
    check('in-place uninstall: the hook answered done, the manager kept running, the stock app is untouched',
        (inplaceStatus(root) || {}).state === 'done' && (inplaceStatus(root) || {}).action === 'uninstall' &&
        root.managerLog().includes('hook mgu-deploy in-place uninstall fixture_app: done') &&
        root.managerPid() === mgr.pid && mgr.exitCode === null && fs.readFileSync(root.entry('stock_app')).equals(stockEntry) &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/inplace/request.json')), root.managerLog().join('\n'));
    check('in-place uninstall: a snapshot is taken',
        fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).some((b) => b.endsWith('-uninstall')));

    [['failed', 'fail', {}, 'the app manager failed the in-place uninstall (FAKE_FAILURE)'],
        ['not taken', 'deaf', { MGU_DEPLOY_INPLACE_ACK_MS: '500' }, 'the app manager did not take the request within 1s'],
        ['not done in time', 'hang', { MGU_DEPLOY_WATCH_TIMEOUT_MS: '500' }, 'the app manager did not uninstall fixture_app in place within 1s']
    ].forEach(([what, mode, extra, why]) => {
        const c = inplaceRoot(mode, { minUp: 1 });
        const r = c.root.run(['uninstall', 'fixture_app', '--yes'], extra);
        const k = c.root.kills();
        check(`in-place uninstall ${what}: removed, then one bounce, spaced`, r.status === 0 &&
            r.out.includes(`uninstalling fixture_app through a bounce: ${why}`) && k.length === 2 && k[1].at - k[0].at >= 1000 &&
            r.out.includes('ACL/UI/status records') && gone(c.root), `${r.out}\n${JSON.stringify(k)}`);
    });

    // a home whose package.json names another app stays, and the manager is not asked to remove it
    const foreign = inplaceRoot();
    const fpkg = path.join(foreign.root.home(13001), 'source', 'package.json');
    fs.writeFileSync(fpkg, JSON.stringify({ name: 'other_app', version: '1.0.0' }));
    const fr = foreign.root.run(['uninstall', 'fixture_app', '--yes']);
    check('in-place uninstall: a home not provably the app\'s is kept, no request, one bounce', fr.status === 0 &&
        !fr.out.includes('asking the running app manager') && fr.out.includes("through a bounce: its home is not provably fixture_app's") &&
        fr.out.includes('left in place: not provably') && fs.existsSync(fpkg) && !fs.existsSync(foreign.root.entry('fixture_app')) &&
        foreign.root.kills().length === 2, fr.out);

    const down = inplaceRoot();
    down.mgr.kill('SIGKILL');
    fs.writeFileSync(`${down.root.R}.mgr.pid`, '');
    const d = down.root.run(['uninstall', 'fixture_app', '--yes']);
    check('in-place uninstall: with no manager running, removed with no request and no bounce', d.status === 0 &&
        d.out.includes('uninstalling fixture_app through a bounce: no app manager is running') &&
        d.out.includes('nothing to bounce') && down.root.kills().length === 1 && !d.out.includes('asking the running app manager') &&
        gone(down.root), d.out);
}

/* An app custom_apps.json lists that runs from an unmarked package (the
 * retired installer's) goes on app-privacy's override list at the next
 * app install; entries already there stay, a marked app is not added. */
function testLocalOnlyListed() {
    const { root } = inplaceRoot();
    const list = root.p(`var/opt/public/oap/oap_${MGR}/data/local-only-apps.json`);
    const pkgFile = path.join(root.home(readJson(root.entry('fixture_app')).userId), 'source', 'package.json');
    const pkg = readJson(pkgFile);
    delete pkg.mguLocalOnly;
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    write(list, JSON.stringify(['owner_app']), 0o644);
    const r = root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    check('local-only: an unmarked app the fallback lists goes on the override list, which keeps its entries',
        r.status === 0 && r.out.includes('app-privacy override lists fixture_app: installed without the local-only marker') &&
        JSON.stringify(readJson(list)) === JSON.stringify(['owner_app', 'fixture_app']) && (fs.statSync(list).mode & 0o777) === 0o644,
    `${r.out}\n${fs.readFileSync(list, 'utf8')}`);
    const again = root.run(['install', '--artifact', appArtifact('third_app', '1.0.0', true), '--yes']);
    check('local-only: once listed, nothing is added again', again.status === 0 && !again.out.includes('app-privacy override lists') &&
        JSON.stringify(readJson(list)) === JSON.stringify(['owner_app', 'fixture_app']), again.out);

    // an install that fails rolls back without taking another app's listing with it
    const hang = inplaceRoot('hang', { minUp: 1 });
    const hpkg = path.join(hang.root.home(readJson(hang.root.entry('fixture_app')).userId), 'source', 'package.json');
    const hp = readJson(hpkg);
    delete hp.mguLocalOnly;
    fs.writeFileSync(hpkg, JSON.stringify(hp));
    const hr = hang.root.run(['install', '--artifact', appArtifact('second_app', '1.0.0', true), '--yes'],
        { MGU_DEPLOY_WATCH_TIMEOUT_MS: '2000' });
    const hlist = hang.root.p(`var/opt/public/oap/oap_${MGR}/data/local-only-apps.json`);
    check('local-only: a rolled-back install keeps the listing it wrote', hr.status === 1 && hr.out.includes('rolling back') &&
        fs.existsSync(hlist) && JSON.stringify(readJson(hlist)) === JSON.stringify(['fixture_app']), hr.out);
}

/* The hook's own rules: the request's folder and file, expiry, malformed
 * requests, a registration that does not match the action, an id once. */
function testInplaceHook() {
    const { root, mgr } = inplaceRoot();
    const request = root.p('var/opt/mgu-deploy/inplace/request.json');
    const ask = (body, fileMode) => {
        write(request, JSON.stringify(Object.assign({ notAfter: Date.now() + 60000 }, body)), fileMode || 0o644);
        fs.chmodSync(path.dirname(request), 0o755);
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) {
            const st = inplaceStatus(root);
            if (st && st.request === body.id) {
                return st;
            }
            sleep(50);
        }
        return null;
    };
    check('in-place hook: a request others can write is ignored', ask({ id: 'h1', app: 'nope', action: 'update' }, 0o666) === null);
    fs.chmodSync(request, 0o644);
    sleep(1500);
    const st = inplaceStatus(root) || {};
    check('in-place hook: the same request once only root can write it: refused, the app is not registered',
        st.request === 'h1' && st.state === 'refused' && st.error === 'not registered', JSON.stringify(st));
    write(request, JSON.stringify({ id: 'h1', app: 'stock_app', action: 'update', notAfter: Date.now() + 60000 }), 0o644);
    sleep(1500);
    const again = inplaceStatus(root) || {};
    check('in-place hook: a request id is taken once', again.at === st.at && again.state === 'refused', JSON.stringify(again));
    const expired = ask({ id: 'h2', app: 'second_app', action: 'install', notAfter: Date.now() - 1 }) || {};
    check('in-place hook: an expired request is refused', expired.state === 'refused' && expired.error === 'expired',
        JSON.stringify(expired));
    const bad = ask({ id: 'h3', app: '../x', action: 'install' }) || {};
    check('in-place hook: a malformed app id is refused', bad.state === 'refused' && bad.error === 'malformed', JSON.stringify(bad));
    const unreg = ask({ id: 'h5', app: 'nope', action: 'uninstall' }) || {};
    check('in-place hook: uninstalling an app that is not registered is refused', unreg.state === 'refused' &&
        unreg.error === 'not registered', JSON.stringify(unreg));
    const dup = ask({ id: 'h4', app: 'stock_app', action: 'install' }) || {};
    check('in-place hook: installing a registered app is refused', dup.state === 'refused' && dup.error === 'already registered',
        JSON.stringify(dup));
    check('in-place hook: nothing was installed or bounced', root.kills().length === 1 && mgr.exitCode === null &&
        !root.managerLog().some((l) => / in place$/.test(l)), root.managerLog().join('\n'));
}

/* ---- the deploy tool as a tool --------------------------------------------------------- */

/* A copy of deploy/ at another version, both in component.json and the
 * script's VERSION. */
function deployCopy(version) {
    const top = fs.mkdtempSync(path.join(T, 'deploy-'));
    const dir = path.join(top, 'deploy');
    fs.mkdirSync(dir);
    cp.execFileSync('cp', ['-R', path.join(DEPLOY, 'unit'), path.join(DEPLOY, 'component.json'), dir]);
    fs.mkdirSync(path.join(top, 'tools'));
    LINK_FILES.forEach((n) => fs.copyFileSync(path.join(TOOLS, n), path.join(top, 'tools', n)));
    const c = readJson(path.join(dir, 'component.json'));
    c.version = version;
    fs.writeFileSync(path.join(dir, 'component.json'), JSON.stringify(c, null, 2) + '\n');
    const js = path.join(dir, 'unit', 'mgu-deploy.js');
    fs.writeFileSync(js, fs.readFileSync(js, 'utf8').replace(/var VERSION = '[^']+'/, `var VERSION = '${version}'`));
    return dir;
}

function testSelf() {
    const c = readJson(path.join(DEPLOY, 'component.json'));
    check('self: deploy/component.json and mgu-deploy.js carry one version', c.id === 'mgu-deploy' && c.version === VERSION &&
        c.kind === 'tool' && JSON.stringify(c.units) === '[]' && JSON.stringify(c.restart) === '[]', `${c.version} vs ${VERSION}`);
    const builds = ['a', 'b'].map((k) => {
        const out = path.join(T, `self-${k}`);
        const r = hu(['artifact', DEPLOY, '--out', out]);
        return { r, file: path.join(out, `mgu-deploy@${VERSION}.tgz`) };
    });
    check('self: deploy/hu artifact deploy builds mgu-deploy@<version>.tgz', builds.every((b) => b.r.status === 0 && fs.existsSync(b.file)),
        builds.map((b) => b.r.stderr).join('\n'));
    check('self: two builds are byte-identical', sha256(fs.readFileSync(builds[0].file)) === sha256(fs.readFileSync(builds[1].file)));
    check('self: the artifact holds its thirteen files and its manifest', JSON.stringify(tarList(builds[0].file)) === JSON.stringify([
        'component.json', 'files/fallback_build.js', 'files/mgu-app-fallback-id8.service', 'files/mgu-app-fallback.service',
        'files/mgu-deploy-apply.service', 'files/mgu-deploy-cleanup.service', 'files/mgu-deploy-safe-mode.service',
        'files/mgu-deploy-verify.service', 'files/mgu-deploy.js', 'files/mgu-deploy.sh',
        'files/oap_link.js', 'files/oap_pack.js', 'files/safe_mode.sh', 'files/var-opt-ro-safe-mode.conf']),
    tarList(builds[0].file).join(' '));
    const built = untar(builds[0].file)['component.json'].data;
    const huText = fs.readFileSync(HU, 'utf8');
    const unstaged = readJson(path.join(DEPLOY, 'component.json')).files.map((f) => f.path)
        .filter((n) => huText.indexOf(`{ name: '${n}'`) < 0);
    check('self: deploy/hu stages every file of the deploy tool\'s manifest', unstaged.length === 0, unstaged.join(' '));

    // run from deploy/unit (no component.json beside it): the manifest is synthesized
    const root = fakeRoot();
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const v = root.p(`var/opt/mgu-deploy/versions/${VERSION}`);
    check('self: installed as versions/<version> with current and the shim',
        fs.readlinkSync(root.p('var/opt/mgu-deploy/current')) === `versions/${VERSION}` &&
        mode(path.join(v, 'mgu-deploy.sh')) === 0o755 && mode(path.join(v, 'mgu-deploy.js')) === 0o644 &&
        mode(root.p('var/opt/mgu-deploy/mgu-deploy.sh')) === 0o755 && !fs.existsSync(root.p('var/opt/mgu-deploy/mgu-deploy.js')));
    check('self: a synthesized manifest equals the artifact\'s', fs.readFileSync(path.join(v, 'component.json')).equals(built),
        fs.readFileSync(path.join(v, 'component.json'), 'utf8'));
    const shim = cp.spawnSync('sh', [root.p('var/opt/mgu-deploy/mgu-deploy.sh'), 'status', '--json'],
        { encoding: 'utf8', env: Object.assign({}, root.env, { MGU_DEPLOY_NODE: UNIT_NODE }) });
    let st = null;
    try { st = JSON.parse(shim.stdout); } catch (e) { /* checked below */ }
    check('self: the shim runs status --json from current', shim.status === 0 && st && st.version === VERSION &&
        st.components.some((x) => x.id === 'mgu-deploy' && x.kind === 'tool' && x.version === VERSION), shim.stdout + shim.stderr);

    // the kit layout: component.json beside the script
    const kit = fs.mkdtempSync(path.join(T, 'kit-'));
    ['mgu-deploy.js', 'mgu-deploy.sh', 'fallback_build.js', 'mgu-app-fallback.service', 'mgu-deploy-apply.service', 'mgu-deploy-verify.service',
        'mgu-deploy-cleanup.service', 'mgu-app-fallback-id8.service', 'safe_mode.sh', 'mgu-deploy-safe-mode.service',
        'var-opt-ro-safe-mode.conf'].forEach((n) =>
        fs.copyFileSync(path.join(DEPLOY, 'unit', n), path.join(kit, n)));
    LINK_FILES.forEach((n) => fs.copyFileSync(path.join(TOOLS, n), path.join(kit, n)));
    fs.copyFileSync(path.join(DEPLOY, 'component.json'), path.join(kit, 'component.json'));
    const kroot = fakeRoot();
    const kr = cp.spawnSync(UNIT_NODE, [path.join(kit, 'mgu-deploy.js'), 'install', '--artifact', toolArtifact('0.2.0'), '--yes'],
        { encoding: 'utf8', env: kroot.env });
    check('self: from a kit, the manifest beside the script is the artifact\'s', kr.status === 0 &&
        fs.readFileSync(kroot.p(`var/opt/mgu-deploy/versions/${VERSION}/component.json`)).equals(built), kr.stdout + kr.stderr);

    // the updater's self-update: install --artifact of the deploy tool itself
    const sroot = fakeRoot();
    const r0 = sroot.run(['install', '--artifact', builds[0].file, '--yes']);
    check('self: install --artifact mgu-deploy@<version> exits 0', r0.status === 0 &&
        fs.readlinkSync(sroot.p('var/opt/mgu-deploy/current')) === `versions/${VERSION}`, r0.out);
    sroot.run(['fallback', 'on', '--yes']);
    const out = fs.mkdtempSync(path.join(T, 'self-next-'));
    hu(['artifact', deployCopy(NEXT), '--out', out]);
    const backupsBefore = fs.readdirSync(sroot.p('var/opt/mgu-deploy/backups')).length;
    const r1 = sroot.run(['install', '--artifact', path.join(out, `mgu-deploy@${NEXT}.tgz`), '--yes']);
    check('self: a newer deploy tool keeps {new, previous} versions', r1.status === 0 &&
        fs.readdirSync(sroot.p('var/opt/mgu-deploy/versions')).sort().join(' ') === [VERSION, NEXT].sort().join(' ') &&
        fs.readlinkSync(sroot.p('var/opt/mgu-deploy/current')) === `versions/${NEXT}`, r1.out);
    check('self: state, backups and the fallback copy stay', fs.existsSync(sroot.p('var/opt/mgu-deploy/state.json')) &&
        fs.readdirSync(sroot.p('var/opt/mgu-deploy/backups')).length > backupsBefore &&
        fs.existsSync(sroot.p('var/opt/mgu-deploy/main.js')));
    const s2 = cp.spawnSync('sh', [sroot.p('var/opt/mgu-deploy/mgu-deploy.sh'), 'status', '--json'],
        { encoding: 'utf8', env: Object.assign({}, sroot.env, { MGU_DEPLOY_NODE: UNIT_NODE }) });
    st = null;
    try { st = JSON.parse(s2.stdout); } catch (e) { /* checked below */ }
    check('self: status through the shim answers from the new current at once', s2.status === 0 && st && st.version === NEXT &&
        st.components.some((x) => x.id === 'mgu-deploy' && x.version === NEXT), s2.stdout + s2.stderr);
    const un = sroot.run(['uninstall', 'mgu-deploy', '--yes']);
    check('self: uninstall mgu-deploy is refused, exit 2', un.status === 2 && un.out.includes('the deploy tool goes with remove-all') &&
        fs.existsSync(sroot.p('var/opt/mgu-deploy/current')), un.out);
    const res = sroot.run(['restore', 'stock', '--yes']);
    check('self: restore stock keeps the deploy tool', res.status === 0 && fs.readlinkSync(sroot.p('var/opt/mgu-deploy/current')) === `versions/${NEXT}`,
        res.out);
}

/* ---- restarts, health and rollback ---------------------------------------------------- */

/* A fixture-tool artifact with a plain service (no socket), cached by version. */
const plainCache = {};
function plainArtifact(version) {
    if (!plainCache[version]) {
        const out = fs.mkdtempSync(path.join(T, 'plain-'));
        const src = fixtureCopy(version, (c) => {
            c.units = [{ name: 'fixture-tool.service', from: 'systemd/fixture-tool.service' }];
            c.enable = [];
        });
        const r = hu(['artifact', src, '--out', out]);
        if (r.status !== 0) {
            throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
        }
        plainCache[version] = path.join(out, `fixture-tool@${version}.tgz`);
    }
    return plainCache[version];
}

function testHealth() {
    let root = fakeRoot({ recmgr: ['fixture-tool'] });
    let r = root.run(['install', '--artifact', plainArtifact('0.2.0'), '--yes']);
    check('health: a fresh install whose recmgr entry is loaded starts its stopped service and checks it',
        r.status === 0 && root.systemctlCalls().includes('start fixture-tool.service') &&
        root.systemctlCalls().filter((c) => c.startsWith('show ')).length === 2 && r.out.includes('healthy: fixture-tool.service'), r.out);

    root = fakeRoot();
    r = root.run(['install', '--artifact', plainArtifact('0.2.0'), '--yes']);
    check('health: a fresh install whose recmgr entry is not loaded starts nothing and reports the next boot',
        r.status === 0 && !root.systemctlCalls().some((c) => /^(start|restart) fixture-tool.service/.test(c)) &&
        r.out.includes('fixture-tool.service starts at the next boot') &&
        root.status().pending_reboot.some((x) => x.id === 'fixture-tool' && x.reason === 'starts at the next boot'), r.out);

    root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    root.run(['install', '--artifact', plainArtifact('0.2.0'), '--yes']);
    r = root.run(['install', '--artifact', plainArtifact('0.3.0'), '--yes']);
    check('health: a healthy restart passes', r.status === 0 && root.systemctlCalls().includes('restart fixture-tool.service') &&
        r.out.includes('healthy: fixture-tool.service') && fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')) === 'versions/0.3.0', r.out);

    // 0.4.0 crash-loops: its update returns to 0.3.0
    fs.writeFileSync(root.unitFile('fixture-tool.service.crash'), `${path.join(root.tool('fixture-tool'), 'current')} versions/0.4.0\n`);
    const before = root.systemctlCalls().length;
    r = root.run(['install', '--artifact', plainArtifact('0.4.0'), '--yes']);
    const calls = root.systemctlCalls().slice(before);
    check('health: a crash-looping update exits 1 with the previous version current again',
        r.status === 1 && fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')) === 'versions/0.3.0' &&
        !fs.existsSync(path.join(root.tool('fixture-tool'), 'versions/0.4.0')) &&
        versionsOf(root).join(' ') === '0.2.0 0.3.0', `${r.out}\n${versionsOf(root)}`);
    check('health: the previous version is restarted again and checked healthy',
        calls.filter((c) => c === 'restart fixture-tool.service').length === 2 && r.out.includes('fixture-tool 0.3.0 is healthy'),
        `${calls.join('; ')}\n${r.out}`);

    // a crash-looping first install has nothing to return to
    root = fakeRoot({ recmgr: ['fixture-tool'] });
    fs.writeFileSync(root.unitFile('fixture-tool.service.crash'), `${path.join(root.tool('fixture-tool'), 'current')} versions/0.2.0\n`);
    r = root.run(['install', '--artifact', plainArtifact('0.2.0'), '--yes']);
    check('health: a crash-looping fresh install exits 1 and stays current, reported',
        r.status === 1 && fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')) === 'versions/0.2.0' &&
        r.out.includes('no previous version to return to'), r.out);
}

/* The fixture tool with one service and a check: check.sh fails while
 * $FAKE_CHECK_DIR/fail-<version> exists. With keepRunning, a renderer's rule. */
const checkCache = {};
function checkArtifact(version, keepRunning) {
    const k = `${version}:${!!keepRunning}`;
    if (!checkCache[k]) {
        const out = fs.mkdtempSync(path.join(T, 'check-'));
        const src = fixtureCopy(version, (c) => {
            c.units = [{ name: 'fixture-tool.service', from: 'systemd/fixture-tool.service' }];
            c.enable = [];
            c.files.push({ path: 'check.sh', from: 'check.sh', mode: '0755' });
            c.check = ['check.sh', '--quick'];
            if (keepRunning) c.keepRunning = true;
        });
        fs.writeFileSync(path.join(src, 'check.sh'), `echo "checking ${version} $1"\n` +
            `if [ -e "$FAKE_CHECK_DIR/fail-${version}" ]; then echo "it does not answer" >&2; exit 1; fi\n`);
        const r = hu(['artifact', src, '--out', out]);
        if (r.status !== 0) {
            throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
        }
        checkCache[k] = path.join(out, `fixture-tool@${version}.tgz`);
    }
    return checkCache[k];
}

function testCheck() {
    const dir = fs.mkdtempSync(path.join(T, 'checks-'));
    const env = { FAKE_CHECK_DIR: dir, MGU_DEPLOY_VERIFY_AFTER_S: '0' };
    const cur = (root) => fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current'));
    let root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    let r = root.run(['install', '--artifact', checkArtifact('0.2.0'), '--yes'], env);
    r = root.run(['install', '--artifact', checkArtifact('0.3.0'), '--yes'], env);
    check('check: an update that runs now is checked with its arguments, and stays when it works',
        r.status === 0 && r.out.includes('checking 0.3.0 --quick') && r.out.includes('fixture-tool 0.3.0 works') &&
        cur(root) === 'versions/0.3.0' && !fs.existsSync(root.p('var/opt/mgu-deploy/verify.json')), r.out);
    check('check: status names the version a rollback returns to',
        root.status().components.find((c) => c.id === 'fixture-tool').previous === '0.2.0');

    fs.writeFileSync(path.join(dir, 'fail-0.4.0'), '');
    let before = root.systemctlCalls().length;
    r = root.run(['install', '--artifact', checkArtifact('0.4.0'), '--yes'], env);
    check('check: an update whose check fails exits 1 with the previous version current again',
        r.status === 1 && cur(root) === 'versions/0.3.0' && !fs.existsSync(path.join(root.tool('fixture-tool'), 'versions/0.4.0')) &&
        r.out.includes('its check failed: it does not answer'), r.out);
    check('check: the service the failed check ran against restarts on the previous version',
        root.systemctlCalls().slice(before).filter((c) => c === 'restart fixture-tool.service').length === 2 &&
        r.out.includes('fixture-tool 0.3.0 is healthy'), `${root.systemctlCalls().slice(before).join('; ')}\n${r.out}`);

    r = root.run(['install', '--artifact', checkArtifact('0.3.0'), '--yes'], env);
    check('check: the same version again is not checked', r.status === 0 && !r.out.includes('checking'), r.out);

    // recmgr has not loaded the entry: the new version runs from the next start, and is checked then
    root = fakeRoot({ active: 'fixture-tool.service' });
    root.run(['install', '--artifact', checkArtifact('0.2.0'), '--yes'], env);
    r = root.run(['install', '--artifact', checkArtifact('0.3.0'), '--yes'], env);
    const noted = readJsonOrNull(root.p('var/opt/mgu-deploy/verify.json')) || {};
    const sys = root.p('etc/systemd/system');
    check('check: an update that runs from the next start is not checked now, but noted with the version before',
        r.status === 0 && !r.out.includes('checking 0.3.0') && noted['fixture-tool'] && noted['fixture-tool'].version === '0.3.0' &&
        noted['fixture-tool'].previous === '0.2.0' && r.out.includes('is checked at the next start'), `${r.out}\n${JSON.stringify(noted)}`);
    check('check: the boot unit that checks it is installed, enabled and in recmgr\'s list',
        fs.readFileSync(path.join(sys, 'mgu-deploy-verify.service'), 'utf8') ===
            fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-deploy-verify.service'), 'utf8') &&
        fs.readlinkSync(path.join(sys, 'late.target.wants/mgu-deploy-verify.service')) === '../mgu-deploy-verify.service' &&
        /^mgu-deploy-verify$/m.test(fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8')));
    r = root.run(['verify'], env);
    check('check: in the same start the boot check has nothing to do', r.status === 0 && r.out.includes('nothing to check') &&
        fs.existsSync(root.p('var/opt/mgu-deploy/verify.json')), r.out);

    root.reboot(Math.floor(Date.now() / 1000) + 5);
    fs.writeFileSync(path.join(dir, 'fail-0.3.0'), '');
    before = root.systemctlCalls().length;
    r = root.run(['verify'], env);
    let last = readJsonOrNull(root.p('var/opt/mgu-deploy/last-verify.json')) || {};
    check('check: at the next start a failing check rolls back to the version before, its service restarted',
        r.status === 0 && cur(root) === 'versions/0.2.0' && r.out.includes('its check failed') &&
        root.systemctlCalls().slice(before).includes('restart fixture-tool.service'), r.out);
    check('check: the result is recorded once, the note gone, and status reports it',
        !fs.existsSync(root.p('var/opt/mgu-deploy/verify.json')) && last.results && last.results.length === 1 &&
        last.results[0].ok === false && last.results[0].rolledBack === true && last.results[0].previous === '0.2.0' &&
        root.status().last_verify.results[0].version === '0.3.0', JSON.stringify(last));
    r = root.run(['verify'], env);
    check('check: the start after that checks and rolls back nothing again', r.status === 0 && r.out.includes('nothing to check') &&
        cur(root) === 'versions/0.2.0', r.out);
    check('check: the newer version kept beside it is no version to roll back to',
        root.status().components.find((c) => c.id === 'fixture-tool').previous === null);
    r = root.run(['restore', 'stock', '--yes'], env);
    check('check: restore stock removes the boot unit', r.status === 0 && !fs.existsSync(path.join(sys, 'mgu-deploy-verify.service')) &&
        !fs.existsSync(path.join(sys, 'late.target.wants/mgu-deploy-verify.service')), r.out);
    fs.unlinkSync(path.join(dir, 'fail-0.3.0'));

    // a renderer's rule (keepRunning): its running service keeps the old version until the next start
    root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    root.run(['install', '--artifact', checkArtifact('0.2.0', true), '--yes'], env);
    r = root.run(['install', '--artifact', checkArtifact('0.3.0', true), '--yes'], env);
    check('check: a keepRunning update is checked at the next start', r.status === 0 && !r.out.includes('checking 0.3.0') &&
        (readJsonOrNull(root.p('var/opt/mgu-deploy/verify.json')) || {})['fixture-tool'], r.out);
    root.reboot(Math.floor(Date.now() / 1000) + 5);
    r = root.run(['verify'], env);
    last = readJsonOrNull(root.p('var/opt/mgu-deploy/last-verify.json')) || {};
    check('check: one that works at the next start stays', r.status === 0 && cur(root) === 'versions/0.3.0' &&
        last.results[0].ok === true && !fs.existsSync(root.p('var/opt/mgu-deploy/verify.json')), r.out);
    r = root.run(['install', '--artifact', checkArtifact('0.4.0', true), '--yes'], env);
    root.reboot(Math.floor(Date.now() / 1000) + 10);
    fs.writeFileSync(path.join(dir, 'fail-0.4.0'), '');
    before = root.systemctlCalls().length;
    r = root.run(['verify'], env);
    check('check: one that fails at the next start goes back, its running service restarted though keepRunning',
        r.status === 0 && cur(root) === 'versions/0.3.0' && root.systemctlCalls().slice(before).includes('restart fixture-tool.service'), r.out);

    // a boot service that does not run at the next start
    root = fakeRoot({ active: 'fixture-tool.service' });
    root.run(['install', '--artifact', checkArtifact('0.2.0'), '--yes'], env);
    root.run(['install', '--artifact', checkArtifact('0.5.0'), '--yes'], env);
    root.reboot(Math.floor(Date.now() / 1000) + 5);
    fs.writeFileSync(root.unitFile('fixture-tool.service.active'), 'failed\n');
    r = root.run(['verify'], env);
    check('check: a service that does not run at the next start rolls back', r.status === 0 && cur(root) === 'versions/0.2.0' &&
        r.out.includes('is not healthy'), r.out);

    // the stock snapshot taken by an app's install: restore stock still removes the boot unit
    root = fakeRoot({ active: 'fixture-tool.service' });
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'], env);
    root.run(['install', '--artifact', checkArtifact('0.2.0'), '--yes'], env);
    root.run(['install', '--artifact', checkArtifact('0.3.0'), '--yes'], env);
    const sys2 = root.p('etc/systemd/system');
    root.run(['uninstall', 'fixture-tool', '--yes'], env);
    check('check: (the boot unit is installed, and stays after the tool goes)', fs.existsSync(path.join(sys2, 'mgu-deploy-verify.service')));
    r = root.run(['restore', 'stock', '--yes'], env);
    check('check: restore stock removes the boot unit when an app took the stock snapshot', r.status === 0 &&
        !fs.existsSync(path.join(sys2, 'mgu-deploy-verify.service')) && !fs.existsSync(path.join(sys2, 'late.target.wants/mgu-deploy-verify.service')), r.out);

    // a manual rollback drops the note
    root = fakeRoot({ active: 'fixture-tool.service' });
    root.run(['install', '--artifact', checkArtifact('0.2.0'), '--yes'], env);
    root.run(['install', '--artifact', checkArtifact('0.3.0'), '--yes'], env);
    root.run(['rollback', 'fixture-tool', '--yes'], env);
    check('check: a rollback drops the note for the next start', !fs.existsSync(root.p('var/opt/mgu-deploy/verify.json')));
}

function testAppRollback() {
    const root = fakeRoot();
    const kept = (v) => root.p(`var/opt/mgu-deploy/kept/fixture_app/fixture_app@${v}.tgz`);
    const app = () => root.status().components.find((c) => c.id === 'fixture_app') || {};
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('app rollback: a fresh install keeps its package, with nothing to go back to', fs.existsSync(kept('1.0.0')) &&
        app().previous === null, JSON.stringify(app()));
    const uid = app().uid;
    write(path.join(root.home(uid), 'data/settings.json'), '{"theme":"dark"}\n');
    let r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    check('app rollback: an update keeps the new package and the one before, and status names it',
        r.status === 0 && fs.existsSync(kept('1.0.0')) && fs.existsSync(kept('1.1.0')) && app().previous === '1.0.0', JSON.stringify(app()));
    r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.2.0', true), '--yes']);
    check('app rollback: only the installed version and the newest older one stay kept',
        r.status === 0 && !fs.existsSync(kept('1.0.0')) && fs.existsSync(kept('1.1.0')) && fs.existsSync(kept('1.2.0')) &&
        app().previous === '1.1.0', fs.readdirSync(root.p('var/opt/mgu-deploy/kept/fixture_app')).join(' '));

    r = root.run(['rollback', 'fixture_app', '--yes']);
    const now = app();
    check('app rollback: uninstall, then the kept older package installs', r.status === 0 && now.version === '1.1.0' &&
        r.out.includes('rolling back fixture_app 1.2.0 -> 1.1.0') && r.out.includes('fixture_app rolled back to 1.1.0'), r.out);
    check('app rollback: the app\'s data is carried over',
        fs.readFileSync(path.join(root.home(now.uid), 'data/settings.json'), 'utf8') === '{"theme":"dark"}\n', r.out);
    check('app rollback: nothing older is kept after it, so it is offered no more', now.previous === null &&
        !fs.existsSync(kept('1.2.0')), JSON.stringify(now));
    r = root.run(['rollback', 'fixture_app', '--yes']);
    check('app rollback: with nothing older kept it is refused, exit 2', r.status === 2 && r.out.includes('no earlier version is kept'), r.out);

    // the older package does not install: the version that was there comes back
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.3.0', true), '--yes']);
    fs.writeFileSync(kept('1.1.0'), 'not a package');
    r = root.run(['rollback', 'fixture_app', '--yes']);
    const back = app();
    check('app rollback: an older package that does not install puts the installed version back, exit 1',
        r.status === 1 && back.version === '1.3.0' && r.out.includes('installing fixture_app 1.3.0 again') &&
        fs.readFileSync(path.join(root.home(back.uid), 'data/settings.json'), 'utf8') === '{"theme":"dark"}\n', r.out);

    root.run(['uninstall', 'fixture_app', '--yes']);
    check('app rollback: an uninstall removes its kept packages', !fs.existsSync(root.p('var/opt/mgu-deploy/kept/fixture_app')));
}

function testRollback() {
    let root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    let r = root.run(['rollback', 'fixture-tool', '--yes']);
    check('rollback: with one version kept it is refused, exit 2', r.status === 2 && r.out.includes('no other version'), r.out);
    root.run(['install', '--artifact', toolArtifact('0.3.0'), '--yes']);
    let before = root.systemctlCalls().length;
    r = root.run(['rollback', 'fixture-tool', '--yes']);
    check('rollback: current switches to the other version, its service restarts and is checked',
        r.status === 0 && fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')) === 'versions/0.2.0' &&
        root.systemctlCalls().slice(before).includes('restart fixture-tool.service') && r.out.includes('healthy'), r.out);
    check('rollback: it snapshots first', fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).some((n) => n.endsWith('-rollback')));
    r = root.run(['rollback', 'fixture-tool', '--yes']);
    check('rollback: and back again', r.status === 0 && fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')) === 'versions/0.3.0', r.out);

    fs.mkdirSync(path.join(root.tool('fixture-tool'), 'versions/0.1.0'));
    r = root.run(['rollback', 'fixture-tool', '--yes']);
    check('rollback: with several versions kept it is refused, listing them', r.status === 2 &&
        r.out.includes('0.1.0, 0.2.0'), r.out);
    fs.rmdirSync(path.join(root.tool('fixture-tool'), 'versions/0.1.0'));

    fs.writeFileSync(root.unitFile('fixture-tool.service.crash'), `${path.join(root.tool('fixture-tool'), 'current')} versions/0.2.0\n`);
    before = root.systemctlCalls().length;
    r = root.run(['rollback', 'fixture-tool', '--yes']);
    check('rollback: a failed health check switches back, restarts again, exit 1',
        r.status === 1 && fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')) === 'versions/0.3.0' &&
        root.systemctlCalls().slice(before).filter((c) => c === 'restart fixture-tool.service').length === 2, r.out);

    root = fakeRoot({ active: 'fixture-tool.service' });
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    root.run(['install', '--artifact', plainArtifact('0.3.0'), '--yes']);
    before = root.systemctlCalls().length;
    r = root.run(['rollback', 'fixture-tool', '--yes']);
    check('rollback: recmgr not loaded: the switch happens, no restart, pending reboot',
        r.status === 0 && fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')) === 'versions/0.2.0' &&
        !root.systemctlCalls().slice(before).some((c) => c.startsWith('restart')) &&
        root.status().pending_reboot.some((x) => x.id === 'fixture-tool'), r.out);
    check('rollback: the units the version returned to lists that the update took out are laid again from its kept copy',
        fs.existsSync(root.p('etc/systemd/system/fixture-tool.socket')) && fs.existsSync(root.p('etc/systemd/system/fixture-tool.service')) &&
        fs.readlinkSync(root.p('etc/systemd/system/sockets.target.wants/fixture-tool.socket')) === '../fixture-tool.socket' &&
        r.out.includes('laid again from the copy kept here: fixture-tool.socket, sockets.target.wants/fixture-tool.socket') &&
        !r.out.includes('missing'), r.out);

    // with recmgr's entry loaded, the socket laid again starts
    root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    root.run(['install', '--artifact', plainArtifact('0.3.0'), '--yes']);
    before = root.systemctlCalls().length;
    r = root.run(['rollback', 'fixture-tool', '--yes']);
    check('rollback: a socket laid again from the kept copy starts when recmgr has loaded its entry',
        r.status === 0 && fs.existsSync(root.p('etc/systemd/system/fixture-tool.socket')) &&
        root.systemctlCalls().slice(before).includes('start fixture-tool.socket') && r.out.includes('started fixture-tool.socket'), r.out);

    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    r = root.run(['rollback', 'fixture_app', '--yes']);
    check('rollback: an app with no older package kept is refused, exit 2', r.status === 2 &&
        r.out.includes('no earlier version is kept'), r.out);

    root = fakeRoot();
    const self = path.join(fs.mkdtempSync(path.join(T, 'self-rb-')));
    hu(['artifact', DEPLOY, '--out', self]);
    hu(['artifact', deployCopy(NEXT), '--out', self]);
    root.run(['install', '--artifact', path.join(self, `mgu-deploy@${VERSION}.tgz`), '--yes']);
    root.run(['install', '--artifact', path.join(self, `mgu-deploy@${NEXT}.tgz`), '--yes']);
    r = root.run(['rollback', 'mgu-deploy', '--yes']);
    const s = cp.spawnSync('sh', [root.p('var/opt/mgu-deploy/mgu-deploy.sh'), 'status', '--json'],
        { encoding: 'utf8', env: Object.assign({}, root.env, { MGU_DEPLOY_NODE: UNIT_NODE }) });
    check('rollback: mgu-deploy switches current; the shim runs the version rolled back to',
        r.status === 0 && fs.readlinkSync(root.p('var/opt/mgu-deploy/current')) === `versions/${VERSION}` &&
        JSON.parse(s.stdout).version === VERSION, `${r.out}\n${s.stdout}${s.stderr}`);
}

/* An app-privacy tool whose patch_mainapp.js applies with the given exit
 * status, logging each call to $FAKE_PRIVACY_LOG. apply and revert report
 * the files written, and nextStart for MainApp-21. With mismatch, check
 * and apply refuse as on a MainApp the tool does not fit. */
function privacyTool(version, applyExit, revertExit, mismatch) {
    const dir = path.join(fs.mkdtempSync(path.join(T, 'priv-')), 'app-privacy');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'component.json'), JSON.stringify({ id: 'app-privacy', kind: 'tool', version,
        files: [{ path: 'patch_mainapp.js', from: 'patch_mainapp.js', mode: '0755' }],
        units: [], enable: [], recmgr: [], restart: [] }, null, 2));
    fs.writeFileSync(path.join(dir, 'patch_mainapp.js'), `'use strict';
const cmd = process.argv[2];
require('fs').appendFileSync(process.env.FAKE_PRIVACY_LOG, '${version} ' + process.argv.slice(2).join(' ') + '\\n');
if (${!!mismatch} && cmd !== 'revert') {
    console.log(JSON.stringify({ state: 'mismatch', changed: false, files: [{ kind: 'main', path: '/usr/lib/oap-mainapp/src/main.js',
        problems: ['anchor "class AppsAutoupdater{...": 0 occurrence(s), expected 1'] }, { kind: 'appmanagement', problems: [] }] }));
    process.exit(2);
}
if (cmd === 'apply' && process.argv[3] !== '--main' && ${applyExit}) process.exit(${applyExit});
if (cmd === 'revert' && ${revertExit || 0}) process.exit(${revertExit || 0});
console.log(JSON.stringify({ state: cmd === 'revert' ? 'unpatched' : 'patched', changed: cmd !== 'check', restartNeeded: false,
    nextStart: cmd !== 'check' }));
`);
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    const r = hu(['artifact', dir, '--out', out]);
    if (r.status !== 0) {
        throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
    }
    return path.join(out, `app-privacy@${version}.tgz`);
}

function testPrivacyTool() {
    const plog = (root) => (fs.existsSync(`${root.R}.privacy.log`) ? fs.readFileSync(`${root.R}.privacy.log`, 'utf8').split('\n').filter(Boolean) : []);
    let root = fakeRoot({ privacy: false });
    let r = root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    check('privacy tool: installing it runs its apply and bounces the manager on a change',
        r.status === 0 && plog(root).includes('1.0.0 apply --json') && root.kills().length === 1, `${r.out}\n${plog(root)}`);
    const n = plog(root).length;
    r = root.run(['install', '--artifact', privacyTool('1.0.1', 1), '--yes']);
    check('privacy tool: an update whose apply fails returns to the previous version, applies it again, exit 1',
        r.status === 1 && fs.readlinkSync(path.join(root.tool('app-privacy'), 'current')) === 'versions/1.0.0' &&
        JSON.stringify(plog(root).slice(n)) === JSON.stringify(['1.0.1 check --json', '1.0.1 apply --json', '1.0.0 apply --json']) &&
        !fs.existsSync(path.join(root.tool('app-privacy'), 'versions/1.0.1')), `${r.out}\n${plog(root).join('\n')}`);
    root.run(['install', '--artifact', privacyTool('1.0.2', 0), '--yes']);
    const m = plog(root).length;
    r = root.run(['rollback', 'app-privacy', '--yes']);
    check('privacy tool: rollback runs the older version\'s apply', r.status === 0 &&
        fs.readlinkSync(path.join(root.tool('app-privacy'), 'current')) === 'versions/1.0.0' &&
        plog(root).slice(m).includes('1.0.0 apply --json'), `${r.out}\n${plog(root).join('\n')}`);

    root = fakeRoot({ privacy: false });
    r = root.run(['install', '--artifact', privacyTool('1.0.0', 1), '--yes']);
    check('privacy tool: a first install whose apply fails stays installed, exit 1, patch reported not in effect',
        r.status === 1 && fs.readlinkSync(path.join(root.tool('app-privacy'), 'current')) === 'versions/1.0.0' &&
        r.out.includes('NOT in effect'), r.out);
    r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('privacy tool: and an app install is then refused', r.status === 2 && r.out.includes('app-privacy apply exited'), r.out);

    root = fakeRoot({ privacy: false });
    fs.writeFileSync(path.join(root.R, 'usr/lib/oap-mainapp/package.json'), JSON.stringify({ version: '7.9.9' }));
    r = root.run(['install', '--artifact', privacyTool('1.0.0', 0, 0, true), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('privacy tool: a first install on a MainApp it does not fit is refused before anything changes, naming why',
        r.status === 2 && r.out.includes("app-privacy 1.0.0: its edits do not fit this head unit's MainApp 7.9.9 " +
            '(main.js: anchor "class AppsAutoupdater{...": 0 occurrence(s), expected 1); nothing was installed') &&
        JSON.stringify(plog(root)) === JSON.stringify(['1.0.0 check --json']) && !fs.existsSync(root.tool('app-privacy')) &&
        !fs.existsSync(root.tool('mgu-deploy')), `${r.out}\n${plog(root).join('\n')}`);
    root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    r = root.run(['install', '--artifact', privacyTool('1.0.1', 0, 0, true), '--yes']);
    check('privacy tool: an update that does not fit the MainApp is refused, the installed version stays',
        r.status === 2 && r.out.includes('app-privacy 1.0.1: its edits do not fit this head unit\'s MainApp 7.9.9') &&
        fs.readlinkSync(path.join(root.tool('app-privacy'), 'current')) === 'versions/1.0.0' &&
        !fs.existsSync(path.join(root.tool('app-privacy'), 'versions/1.0.1')), r.out);

    root = fakeRoot({ privacy: false });
    root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    r = root.run(['uninstall', 'app-privacy', '--yes']);
    check('privacy tool: uninstall is refused while one of our apps is installed', r.status === 2 &&
        r.out.includes('fixture_app') && fs.existsSync(root.tool('app-privacy')) && !plog(root).some((l) => l.includes('revert')), r.out);
    root.run(['uninstall', 'fixture_app', '--yes']);
    r = root.run(['uninstall', 'app-privacy', '--yes']);
    check('privacy tool: with no app of ours, uninstall reverts first, then removes it', r.status === 0 &&
        plog(root).includes('1.0.0 revert --json') && !fs.existsSync(root.tool('app-privacy')), r.out);

    root = fakeRoot({ privacy: false });
    root.run(['install', '--artifact', privacyTool('1.0.0', 0, 1), '--yes']);
    r = root.run(['uninstall', 'app-privacy', '--yes']);
    check('privacy tool: a failed revert refuses the uninstall, the tool stays', r.status === 2 &&
        fs.existsSync(path.join(root.tool('app-privacy'), 'current')), r.out);
}

/* app-privacy installed with an app on a unit whose manager lists no app
 * of ours: one bounce, the app's, after the patch, the fallback and the
 * listing. Where the manager could list an app of ours, and for
 * app-privacy alone, its own bounce comes first; a bounce still owed when
 * the install fails is made then. */
function testPrivacyOneBounce() {
    const plog = (root) => (fs.existsSync(`${root.R}.privacy.log`) ? fs.readFileSync(`${root.R}.privacy.log`, 'utf8').split('\n').filter(Boolean) : []);
    const custom = (root) => readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
    const at = (out, text) => out.indexOf(text);
    let root = fakeRoot({ privacy: false });
    let r = root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    let entry = readJsonOrNull(root.entry('fixture_app')) || {};
    check('privacy one bounce: app-privacy and an app on a fresh unit restart the manager once, which installs the app',
        r.status === 0 && root.kills().length === 1 && entry.installationSource === 'PREINSTALLED' &&
        r.out.includes('app-privacy: the app manager loads it at the app install\'s restart') &&
        (r.out.match(/bouncing the app manager/g) || []).length === 1 && !r.out.includes('waiting'), r.out);
    check('privacy one bounce: the patch is applied, the fallback on and the app listed before that bounce',
        plog(root).includes('1.0.0 apply --json') && at(r.out, 'app-privacy: patched') >= 0 &&
        at(r.out, 'app-privacy: patched') < at(r.out, 'provisioning fallback turned on') &&
        at(r.out, 'provisioning fallback turned on') < at(r.out, 'bouncing the app manager') &&
        at(r.out, 'bouncing the app manager') > 0 && custom(root).fixture_app, r.out);

    // app-privacy installed by an earlier run, as a run cut short after its apply leaves it; this one's apply (the
    // fake reports a change each time) waits for the app's bounce the same way
    root = fakeRoot({ privacy: false });
    root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    const k0 = root.kills().length;
    r = root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('privacy one bounce: run again after an interruption, one bounce, after the apply, installs the app',
        r.status === 0 && root.kills().length === k0 + 1 && (readJsonOrNull(root.entry('fixture_app')) || {}).installationSource === 'PREINSTALLED' &&
        at(r.out, 'app-privacy: patched') >= 0 && at(r.out, 'app-privacy: patched') < at(r.out, 'bouncing the app manager'), r.out);

    // a manager that may list an app of ours (the fallback on): app-privacy's bounce comes before the next app is placed
    r = root.run(['install', '--artifact', privacyTool('1.0.1', 0), '--artifact', appArtifact('second_app', '1.0.0', true), '--yes']);
    check('privacy one bounce: with an app of ours listed, app-privacy bounces at once, before the next app is placed',
        r.status === 0 && !r.out.includes('loads it at the app install') &&
        at(r.out, 'bouncing the app manager') >= 0 && at(r.out, 'bouncing the app manager') < at(r.out, 'installing app second_app'), r.out);

    // an app of ours in the manager's registry, with no fallback: app-privacy's bounce comes first too
    root = fakeRoot({ privacy: false });
    write(root.entry('old_app'), JSON.stringify({ userId: 13005, installationSource: 'PREINSTALLED' }));
    write(path.join(root.home(13005), 'source/package.json'), JSON.stringify({ name: 'old_app', version: '1.0.0', mguLocalOnly: true }));
    r = root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('privacy one bounce: with an app of ours in the registry, app-privacy bounces at once, before the app is placed',
        r.status === 0 && !r.out.includes('loads it at the app install') &&
        at(r.out, 'bouncing the app manager') >= 0 && at(r.out, 'bouncing the app manager') < at(r.out, 'installing app fixture_app'), r.out);

    // the retired installer's leftovers: app-privacy's bounce does not wait
    root = fakeRoot({ privacy: false });
    write(root.p('usr/lib/oap-mainapp/src/main.js.capbak'), stockMain(), 0o755);
    r = root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('privacy one bounce: with the retired installer\'s leftovers, app-privacy bounces at once',
        at(r.out, 'bouncing the app manager') >= 0 && at(r.out, 'bouncing the app manager') < at(r.out, 'installing app fixture_app') &&
        !r.out.includes('loads it at the app install'), r.out);

    // app-privacy alone: its own bounce
    root = fakeRoot({ privacy: false });
    r = root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    check('privacy one bounce: app-privacy without an app bounces at once', r.status === 0 && root.kills().length === 1 &&
        !r.out.includes('loads it at the app install'), r.out);

    // an install that fails after app-privacy's apply, before the app: the owed bounce is made, the app not installed
    const fails = fs.mkdtempSync(path.join(T, 'checks-'));
    fs.writeFileSync(path.join(fails, 'fail-0.7.0'), '');
    root = fakeRoot({ privacy: false, recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    r = root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--artifact', checkArtifact('0.7.0'),
        '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'], { FAKE_CHECK_DIR: fails });
    check('privacy one bounce: a failure before the app still restarts the manager for app-privacy, once',
        r.status === 1 && root.kills().length === 1 && plog(root).includes('1.0.0 apply --json') &&
        !custom(root).fixture_app && !readJsonOrNull(root.entry('fixture_app')), r.out);
}

/* app-privacy that leaves out privacy-only edits this MainApp lacks still
 * lets apps install, and says which in one line; one that refuses a
 * required edit refuses the install. Its record is in status --json. */
function testPrivacySkipped() {
    let root = fakeRoot();
    root.env.FAKE_PRIVACY_SKIPPED = 'update-availability-sweep';
    let r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('privacy skipped: an app installs with an optional edit skipped, named in one line',
        r.status === 0 && r.out.split('\n').filter((l) => l.indexOf('privacy edits applied') >= 0).length === 1 &&
        r.out.includes('app-privacy: 2 of 3 privacy edits applied; skipped: update availability sweep') &&
        root.entry('fixture_app') && fs.existsSync(root.entry('fixture_app')), r.out);
    root = fakeRoot();
    root.env.FAKE_PRIVACY_SKIPPED = 'update-availability-sweep';
    r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true),
        '--artifact', appArtifact('fixture_two', '1.0.0', true), '--yes']);
    check('privacy skipped: two apps in one run name the skipped edits once',
        r.status === 0 && r.out.split('\n').filter((l) => l.indexOf('privacy edits applied') >= 0).length === 1 &&
        fs.existsSync(root.entry('fixture_two')), r.out);
    root = fakeRoot();
    r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('privacy skipped: with every edit applied there is no skipped line',
        r.status === 0 && !r.out.includes('privacy edits applied'), r.out);
    root = fakeRoot();
    root.env.FAKE_PRIVACY_REFUSED = 'crash-count';
    r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('privacy skipped: a required edit refused refuses the app install',
        r.status === 2 && r.out.includes('refusing the app install') && r.out.includes('(required crash-count)') &&
        !fs.existsSync(root.entry('fixture_app')), r.out);

    root = id8Root();
    root.env.FAKE_PRIVACY_SKIPPED = 'release-notes,analytics-start';
    r = root.run(['install', '--artifact', rhmiApp('robertn_x8', '1.0.0', ['ID8'], { marked: true, npm: true }), '--yes']);
    check('privacy skipped id8: an app queues with optional edits skipped, named in one line',
        r.status === 0 && r.out.includes('app-privacy: 2 of 4 privacy edits applied; skipped: release notes, analytics start') &&
        fs.existsSync(root.p('var/opt/mgu-deploy/id8/queue/robertn_x8@1.0.0.tgz')), r.out);
    root = id8Root();
    root.env.FAKE_PRIVACY_REFUSED = 'package-source';
    r = root.run(['install', '--artifact', rhmiApp('robertn_x8', '1.0.0', ['ID8'], { marked: true, npm: true }), '--yes']);
    check('privacy skipped id8: a required edit refused refuses the app install',
        r.status === 2 && r.out.includes('refusing the app install') &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/id8/queue/robertn_x8@1.0.0.tgz')), r.out);

    root = fakeRoot();
    check('privacy record: status --json has none before app-privacy wrote one', root.status().app_privacy_record === null,
        JSON.stringify(root.status().app_privacy_record));
    const record = { latest: [{ time: '2026-11-01T10:00:00.000Z', command: 'apply', appPrivacy: '1.7.0', unit: 'ID7',
        mainappVersion: '8.2.10', patchSet: '8.3.2', fingerprint: '0123456789abcdef', state: 'patched', files: [],
        edits: [{ id: 'crash-gate', title: 'crash recovery', required: true, result: 'applied' },
            { id: 'backend-inventory', title: 'backend app inventory', required: false, result: 'applied' },
            { id: 'update-availability-sweep', title: 'update-availability sweep', required: false,
                result: 'skipped-not-found' }] }], history: [] };
    write(root.p('var/opt/app-privacy/edit-record.json'), JSON.stringify(record));
    check('privacy record: status --json carries app-privacy\'s record as it is',
        JSON.stringify(root.status().app_privacy_record) === JSON.stringify(record), JSON.stringify(root.status()));
    r = root.run(['status']);
    check('privacy record: status names the last run and the skipped edits in one line', r.status === 0 &&
        r.out.includes('app-privacy: patched on MainApp 8.2.10 (apply 2026-11-01T10:00:00.000Z); ' +
            '1 of 2 privacy edits applied; skipped: update-availability sweep'), r.out);
}

/* iDrive 8: MainApp-21 is never bounced for app-privacy; its patch takes
 * effect at the next start, before MainApp-21 installs a queued app. */
function testPrivacyId8() {
    const plog = (root) => (fs.existsSync(`${root.R}.privacy.log`) ? fs.readFileSync(`${root.R}.privacy.log`, 'utf8').split('\n').filter(Boolean) : []);
    let root = id8Root({ privacy: false });
    let r = root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    check('privacy id8: installing it runs its apply, MainApp-21 is not bounced, the patch waits for the next start',
        r.status === 0 && plog(root).includes('1.0.0 apply --json') && root.kills().length === 0 &&
        r.out.includes('app-privacy: in effect from the next start of the head unit') &&
        root.status().pending_reboot.some((p) => p.id === 'app-privacy' && p.reason === 'the new version runs from its next start'),
        `${r.out}\n${plog(root).join('\n')}`);
    const n = plog(root).length;
    r = root.run(['install', '--artifact', rhmiApp('robertn_x8', '1.0.0', ['ID8'], { marked: true, npm: true }), '--yes']);
    check('privacy id8: an app install applies the patch first and queues the app, no bounce',
        r.status === 0 && plog(root).slice(n).includes('1.0.0 apply --json') && root.kills().length === 0 &&
        fs.existsSync(root.p('var/opt/mgu-deploy/id8/queue/robertn_x8@1.0.0.tgz')), `${r.out}\n${plog(root).join('\n')}`);
    root.run(['uninstall', 'robertn_x8', '--yes']);
    r = root.run(['uninstall', 'app-privacy', '--yes']);
    check('privacy id8: uninstall with MainApp-21 running reverts, does not bounce it, says it is removed, leaves nothing pending',
        r.status === 0 && plog(root).includes('1.0.0 revert --json') && root.kills().length === 0 &&
        r.out.includes('app-privacy: removed; MainApp-21 runs without it from the next start of the head unit') &&
        !r.out.includes('in effect from the next start') &&
        !root.status().pending_reboot.some((p) => p.id === 'app-privacy'), r.out);

    root = id8Root({ privacy: false });
    root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    check('privacy id8: (restore) app-privacy pending before the restore',
        root.status().pending_reboot.some((p) => p.id === 'app-privacy'), JSON.stringify(root.status().pending_reboot));
    r = root.run(['restore', 'stock', '--yes']);
    check('privacy id8: restore removing app-privacy with MainApp-21 running reverts, does not bounce it, drops its pending entry',
        r.status === 0 && plog(root).includes('1.0.0 revert --json') && root.kills().length === 0 &&
        !fs.existsSync(root.tool('app-privacy')) &&
        r.out.includes('app-privacy: removed; MainApp-21 runs without it from the next start of the head unit') &&
        !r.out.includes('in effect from the next start') &&
        !root.status().pending_reboot.some((p) => p.id === 'app-privacy'), `${r.out}\n${JSON.stringify(root.status().pending_reboot)}`);

    root = id8Root();
    root.env.FAKE_PRIVACY_APPLY_EXIT = '2';
    r = root.run(['install', '--artifact', rhmiApp('robertn_x8', '1.0.0', ['ID8'], { marked: true, npm: true }), '--yes']);
    check('privacy id8: an app install is refused while the patch does not apply',
        r.status === 2 && r.out.includes('refusing the app install') &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/id8/queue/robertn_x8@1.0.0.tgz')), r.out);

    root = id8Root({ privacy: false });
    r = root.run(['install', '--artifact', rhmiApp('robertn_x8', '1.0.0', ['ID8'], { marked: true, npm: true }), '--yes']);
    check('privacy id8: without app-privacy an app still queues, with a warning',
        r.status === 0 && r.out.includes('app-privacy is not installed') &&
        fs.existsSync(root.p('var/opt/mgu-deploy/id8/queue/robertn_x8@1.0.0.tgz')), r.out);
}

/* A copy of the fixture tool with an activate and a deactivate hook
 * (fake_hook.js as hook.js, run by "node"), at the given version. */
function hookArtifact(version, edit) {
    const dir = fixtureCopy(version, (c) => {
        c.files.push({ path: 'hook.js', from: 'hook.js', mode: '0644' });
        c.activate = ['node', 'hook.js', 'activate'];
        c.deactivate = ['node', 'hook.js', 'deactivate'];
        c.requires = { 'lib-tool': '0.1.0' };
        if (edit) {
            edit(c);
        }
    });
    fs.copyFileSync(path.join(HERE, 'fake_hook.js'), path.join(dir, 'hook.js'));
    // the same hook as a program of the tool, run directly
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'hook'), `#!/bin/sh\nexec "$FAKE_NODE" "$(dirname "$0")/../hook.js" "$@"\n`, { mode: 0o755 });
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    const r = hu(['artifact', dir, '--out', out]);
    if (r.status !== 0) {
        throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
    }
    return path.join(out, `fixture-tool@${version}.tgz`);
}

/* restore: a tool the backup puts on another version, or removes, runs the
 * deactivate of the version it leaves first, all of it in place; one that
 * fails refuses the restore and that version is activated again; a tool
 * the backup leaves on its version runs no hook. */
function testRestoreDeactivate() {
    const fresh = () => {
        const root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
        root.log = `${root.R}.hooks.log`;
        root.hooks = () => (fs.existsSync(root.log) ? fs.readFileSync(root.log, 'utf8').split('\n').filter(Boolean) : []);
        root.env = (extra) => Object.assign({ FAKE_HOOK_LOG: root.log }, extra || {});
        root.current = () => { try { return fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')); } catch (e) { return null; } };
        root.snap = () => fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).filter((d) => /-install$/.test(d)).sort().pop();
        let r = root.run(['install', '--artifact', hookArtifact('1.0.0'), '--yes'], root.env());
        if (r.status !== 0) throw new Error(r.out);
        r = root.run(['install', '--artifact', hookArtifact('1.1.0'), '--yes'], root.env());
        if (r.status !== 0) throw new Error(r.out);
        return root;
    };
    const short = (lines) => lines.map((l) => l.split(' ').slice(0, 2).join(' '));

    // back to the version before the update
    let root = fresh(), snap = root.snap(), n = root.hooks().length;
    let r = root.run(['restore', snap, '--yes'], root.env());
    check('restore deactivate: a restore putting a tool back on its earlier version runs the deactivate of the version it leaves first, all of it in place',
        r.status === 0 && root.current() === 'versions/1.0.0' && root.hooks().slice(n).length === 1 &&
        root.hooks()[n] === 'deactivate 1.1.0 cwd=fixture-tool/versions/1.1.0 current=versions/1.1.0 unit=yes active=active', `${r.out}\n${root.hooks().slice(n).join('\n')}`);
    check('restore deactivate: the version left is recorded deactivated',
        ((root.state().deactivated || {})['fixture-tool'] || []).includes('1.1.0'), JSON.stringify(root.state().deactivated));

    // to a version recorded deactivated (a rollback left it): its record goes once the restore makes it current
    root = fresh();
    r = root.run(['rollback', 'fixture-tool', '--yes'], root.env());
    if (r.status !== 0 || root.current() !== 'versions/1.0.0') throw new Error(r.out);
    snap = fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).filter((d) => /-rollback$/.test(d)).sort().pop();
    n = root.hooks().length;
    r = root.run(['restore', snap, '--yes'], root.env());
    const marks = (root.state().deactivated || {})['fixture-tool'] || [];
    check('restore deactivate: a restore back to a version recorded deactivated runs the deactivate of the one it leaves, and the version made current keeps no record',
        r.status === 0 && root.current() === 'versions/1.1.0' && JSON.stringify(short(root.hooks().slice(n))) === JSON.stringify(['deactivate 1.0.0']) &&
        !marks.includes('1.1.0') && marks.includes('1.0.0'), `${r.out}\n${JSON.stringify(marks)}\n${root.hooks().slice(n).join('\n')}`);

    // a backup recording the tool's current on the version it is on: no hook
    root = fresh();
    r = root.run(['install', '--artifact', hookArtifact('1.1.0'), '--yes'], root.env());
    if (r.status !== 0) throw new Error(r.out);
    snap = root.snap(); n = root.hooks().length;
    r = root.run(['restore', snap, '--yes'], root.env());
    check('restore deactivate: a backup recording the tool on its current version runs no hook of it',
        r.status === 0 && root.current() === 'versions/1.1.0' && root.hooks().slice(n).length === 0, `${r.out}\n${root.hooks().slice(n).join('\n')}`);

    // a deactivate that fails: refused, nothing restored, activated again
    root = fresh(); snap = root.snap(); n = root.hooks().length;
    r = root.run(['restore', snap, '--yes'], root.env({ FAKE_HOOK_FAIL: 'deactivate@1.1.0' }));
    check('restore deactivate: a deactivate that fails refuses the restore, exit 2, nothing restored, and that version is activated again',
        r.status === 2 && root.current() === 'versions/1.1.0' && r.out.includes('fixture-tool 1.1.0: deactivate exited 3') && r.out.includes('nothing restored') &&
        JSON.stringify(short(root.hooks().slice(n))) === JSON.stringify(['deactivate 1.1.0', 'activate 1.1.0']), `${r.out}\n${root.hooks().slice(n).join('\n')}`);

    // restore stock: the tool goes, after the hooks of its removal (a kept version whose deactivate is owed
    // runs it too); a restart its deactivate asks for is pending under the deploy tool
    root = fresh();
    const owed = root.state();
    owed.deactivate_owed = { 'fixture-tool': ['1.0.0'] };
    write(root.p('var/opt/mgu-deploy/state.json'), JSON.stringify(owed));
    n = root.hooks().length;
    r = root.run(['restore', 'stock', '--yes'], root.env({ FAKE_HOOK_REBOOT: 'patch removed; the original runs from the next start', FAKE_HOOK_REBOOT_ON: 'deactivate@1.1.0' }));
    const after = root.state();
    check('restore deactivate: a restore that removes a tool runs the hooks of its removal first, and keeps no record of it',
        r.status === 0 && root.current() === null && JSON.stringify(short(root.hooks().slice(n))) === JSON.stringify(['deactivate 1.1.0', 'deactivate 1.0.0']) &&
        !((after.deactivated || {})['fixture-tool']) && !((after.deactivate_owed || {})['fixture-tool']), `${r.out}\n${root.hooks().slice(n).join('\n')}`);
    check('restore deactivate: a restart the removed tool\'s deactivate asks for is pending under the deploy tool',
        (after.pending_reboot || []).some((p) => p.id === 'mgu-deploy' && /fixture-tool removed: patch removed/.test(p.reason)) &&
        !(after.pending_reboot || []).some((p) => p.id === 'fixture-tool'), JSON.stringify(after.pending_reboot));

    // a backup that leaves the tool on its version: no hook
    root = fresh();
    r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'], root.env());
    if (r.status !== 0) throw new Error(r.out);
    snap = root.snap(); n = root.hooks().length;
    r = root.run(['restore', snap, '--yes'], root.env());
    check('restore deactivate: a restore that leaves a tool on its version runs no hook of it',
        r.status === 0 && root.current() === 'versions/1.1.0' && root.hooks().slice(n).length === 0, `${r.out}\n${root.hooks().slice(n).join('\n')}`);
}

function testHooks() {
    const art = (v) => hookArtifact(v);
    const m = JSON.parse(untar(art('1.0.0'))['component.json'].data);
    check('hooks: deploy/hu artifact keeps activate and deactivate',
        JSON.stringify(m.activate) === '["node","hook.js","activate"]' && JSON.stringify(m.deactivate) === '["node","hook.js","deactivate"]' &&
        m.requires === undefined, JSON.stringify(m));

    const root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    const hookLog = `${root.R}.hooks.log`;
    const hooks = () => (fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean) : []);
    const env = (extra) => Object.assign({ FAKE_HOOK_LOG: hookLog }, extra || {});
    const current = () => fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current'));
    const pending = () => root.status().pending_reboot;

    let r = root.run(['install', '--artifact', art('1.0.0'), '--yes'], env({ FAKE_HOOK_REBOOT: 'patch written; takes effect at the next head-unit start' }));
    check('hooks: an install runs activate once, as the installed version, in its folder, units in place and started',
        r.status === 0 && JSON.stringify(hooks()) === JSON.stringify(['activate 1.0.0 cwd=fixture-tool/versions/1.0.0 current=versions/1.0.0 unit=yes active=active']),
        `${r.out}\n${hooks().join('\n')}`);
    check('hooks: its stdout and stderr go to the log, its JSON result line does not',
        r.out.includes('fixture-tool activate: hook activate@1.0.0 says hello') && r.out.includes('fixture-tool activate: hook activate@1.0.0 on stderr') &&
        r.out.includes('fixture-tool activate: activate@1.0.0 done') && !r.out.includes('{"status"'), r.out);
    check('hooks: a "reboot" reason is a pending reboot of the tool, which status --json lists',
        pending().some((p) => p.id === 'fixture-tool' && p.reason === 'patch written; takes effect at the next head-unit start'), JSON.stringify(pending()));

    r = root.run(['install', '--artifact', art('1.0.0'), '--yes'], env());
    check('hooks: installing the same version again runs activate again', r.status === 0 && hooks().length === 2 &&
        hooks()[1].startsWith('activate 1.0.0 '), `${r.out}\n${hooks().join('\n')}`);

    r = root.run(['install', '--artifact', art('1.0.1'), '--yes'], env());
    check('hooks: an update runs the new version\'s activate', r.status === 0 && current() === 'versions/1.0.1' &&
        hooks()[2] === 'activate 1.0.1 cwd=fixture-tool/versions/1.0.1 current=versions/1.0.1 unit=yes active=active', `${r.out}\n${hooks().join('\n')}`);

    r = root.run(['install', '--artifact', art('1.0.2'), '--yes'], env({ FAKE_HOOK_FAIL: 'activate@1.0.2' }));
    check('hooks: a failed activate rolls the update back after its deactivate, runs the previous version\'s activate again, exit 1',
        r.status === 1 && current() === 'versions/1.0.1' && !fs.existsSync(path.join(root.tool('fixture-tool'), 'versions/1.0.2')) &&
        JSON.stringify(hooks().slice(3).map((l) => l.split(' ').slice(0, 2).join(' '))) ===
            JSON.stringify(['activate 1.0.2', 'deactivate 1.0.2', 'activate 1.0.1']) &&
        r.out.includes('activate exited 3: hook activate@1.0.2 failing as asked'), `${r.out}\n${hooks().join('\n')}`);

    r = root.run(['install', '--artifact', art('1.0.3'), '--yes'], env({ FAKE_HOOK_SLOW: 'activate@1.0.3', MGU_DEPLOY_HOOK_TIMEOUT_MS: '1000' }));
    check('hooks: an activate past the timeout is killed and rolled back like a failure',
        r.status === 1 && current() === 'versions/1.0.1' && r.out.includes('activate timed out after 1 s'), r.out);

    root.run(['install', '--artifact', art('1.0.4'), '--yes'], env());
    let n = hooks().length;
    r = root.run(['rollback', 'fixture-tool', '--yes'], env());
    check('hooks: rollback runs the version going\'s deactivate, all of it in place, then the older version\'s activate',
        r.status === 0 && current() === 'versions/1.0.1' && hooks().slice(n).length === 2 &&
        hooks()[n] === 'deactivate 1.0.4 cwd=fixture-tool/versions/1.0.4 current=versions/1.0.4 unit=yes active=active' &&
        hooks()[n + 1].startsWith('activate 1.0.1 '), `${r.out}\n${hooks().slice(n).join('\n')}`);
    root.run(['install', '--artifact', art('1.0.4'), '--yes'], env());
    n = hooks().length;
    r = root.run(['rollback', 'fixture-tool', '--yes'], env({ FAKE_HOOK_FAIL: 'activate@1.0.1' }));
    check('hooks: a rollback whose activate fails returns to the current version and activates it again, exit 1',
        r.status === 1 && current() === 'versions/1.0.4' &&
        JSON.stringify(hooks().slice(n).map((l) => l.split(' ').slice(0, 2).join(' '))) ===
            JSON.stringify(['deactivate 1.0.4', 'activate 1.0.1', 'deactivate 1.0.1', 'activate 1.0.4']), `${r.out}\n${hooks().slice(n).join('\n')}`);

    // a check that fails after the new version's activate ran
    const checked = (v) => hookArtifact(v, (c) => { c.check = ['hook.js', 'check']; });
    const cr = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    const clog = `${cr.R}.hooks.log`;
    cr.run(['install', '--artifact', checked('2.0.0'), '--yes'], { FAKE_HOOK_LOG: clog });
    fs.writeFileSync(clog, '');
    r = cr.run(['install', '--artifact', checked('2.0.1'), '--yes'], { FAKE_HOOK_LOG: clog, FAKE_HOOK_FAIL: 'check@2.0.1' });
    const cl = fs.readFileSync(clog, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 2).join(' '));
    check('hooks: a check failing after the activate ran rolls back after the deactivate and runs the previous version\'s activate again, exit 1',
        r.status === 1 && fs.readlinkSync(path.join(cr.tool('fixture-tool'), 'current')) === 'versions/2.0.0' &&
        JSON.stringify(cl) === JSON.stringify(['activate 2.0.1', 'check 2.0.1', 'deactivate 2.0.1', 'activate 2.0.0']), `${r.out}\n${cl.join('; ')}`);

    n = hooks().length;
    r = root.run(['uninstall', 'fixture-tool', '--yes'], env({ FAKE_HOOK_FAIL: 'deactivate@1.0.4' }));
    check('hooks: a failed deactivate refuses the removal, exit 2, the tool stays whole and is activated again',
        r.status === 2 && current() === 'versions/1.0.4' && fs.existsSync(root.p('etc/systemd/system/fixture-tool.service')) &&
        r.out.includes('deactivate exited 3') && r.out.includes('fixture-tool stays installed') &&
        hooks().slice(-1)[0].startsWith('activate 1.0.4 '), `${r.out}\n${hooks().slice(-2).join('\n')}`);
    r = root.run(['uninstall', 'fixture-tool', '--yes'], env({ FAKE_HOOK_REBOOT: 'patch removed; the original runs from the next start' }));
    check('hooks: deactivate runs before anything is removed (units in place, still running), then the tool goes',
        r.status === 0 && hooks()[n + 2] === 'deactivate 1.0.4 cwd=fixture-tool/versions/1.0.4 current=versions/1.0.4 unit=yes active=active' &&
        !fs.existsSync(root.tool('fixture-tool')) && !fs.existsSync(root.p('etc/systemd/system/fixture-tool.service')), `${r.out}\n${hooks().join('\n')}`);
    check('hooks: its reboot reason stays pending under the deploy tool, the tool\'s own entries gone',
        pending().some((p) => p.id === 'mgu-deploy' && p.reason === 'fixture-tool removed: patch removed; the original runs from the next start'),
        JSON.stringify(pending()));

    const fresh = fakeRoot({ recmgr: ['fixture-tool'] });
    r = fresh.run(['install', '--artifact', art('1.0.0'), '--yes'], { FAKE_HOOK_LOG: `${fresh.R}.hooks.log`, FAKE_HOOK_FAIL: 'activate@1.0.0' });
    check('hooks: a first install whose activate fails is removed again, units and all, exit 1',
        r.status === 1 && !fs.existsSync(fresh.tool('fixture-tool')) && !fs.existsSync(fresh.p('etc/systemd/system/fixture-tool.service')) &&
        !fs.existsSync(fresh.p('etc/systemd/system/sockets.target.wants/fixture-tool.socket')), r.out);

    const bad = [
        ['an empty activate', (c) => { c.activate = []; }],
        ['activate as a string', (c) => { c.activate = 'node hook.js activate'; }],
        ['an argument with ..', (c) => { c.activate = ['node', '../hook.js']; }],
        ['an absolute program', (c) => { c.deactivate = ['/bin/sh', '-c', 'true']; }],
        ['a program the tool does not ship as executable', (c) => { c.activate = ['hook.js', 'activate']; }],
        ['an empty argument', (c) => { c.activate = ['node', '']; }]
    ];
    bad.forEach(([what, edit]) => {
        const rr = fakeRoot();
        const before = rr.hash();
        const res = rr.run(['install', '--artifact', hookArtifact('1.1.0', edit), '--yes']);
        check(`hooks: ${what} is refused, exit 2, nothing changed`, res.status === 2 && /(activate|deactivate) is \["node"/.test(res.out) &&
            rr.hash().hash === before.hash, res.out);
    });
    const ok = fakeRoot({ recmgr: ['fixture-tool'] });
    r = ok.run(['install', '--artifact', hookArtifact('1.1.0', (c) => {
        c.files.push({ path: 'bin/hook', from: 'bin/hook', mode: '0755' });
        c.activate = ['bin/hook', 'activate'];
    }), '--yes'], { FAKE_HOOK_LOG: `${ok.R}.hooks.log` });
    check('hooks: an executable file of the tool runs directly', r.status === 0 && r.out.includes('hook activate@1.1.0 says hello'), r.out);
}

/* Runs fn with the harness's umask (which the deploy tool's process
 * inherits) set to mask. */
function underUmask(mask, fn) {
    const was = process.umask(mask);
    try {
        return fn();
    } finally {
        process.umask(was);
    }
}

/* The deploy tool runs with umask 022 whatever its caller's, and a stock
 * file under /bin, /etc, /lib, /sbin or /usr that a hook or postInstall
 * leaves without a group or other read or execute bit it had gets its mode
 * and owner back. */
function testStockFiles() {
    const asRoot = process.getuid() === 0;
    const stock = (root) => {
        ['usr/bin/carplay', 'usr/bin/aapd'].forEach((rel) => write(root.p(rel), `${rel}\n`, 0o755));
        write(root.p('etc/private.conf'), 'secret\n', 0o600);
        fs.chmodSync(root.p('usr/bin'), 0o755);
    };
    const owner = (p) => `${fs.lstatSync(p).uid}:${fs.lstatSync(p).gid}`;
    const art = (v) => hookArtifact(v);

    let root = fakeRoot({ recmgr: ['fixture-tool'] });
    stock(root);
    const carplay = root.p('usr/bin/carplay');
    const umasks = `${root.R}.umask.log`;
    let r = underUmask(0o077, () => root.run(['install', '--artifact', art('3.0.0'), '--yes'], {
        FAKE_HOOK_LOG: `${root.R}.hooks.log`, FAKE_HOOK_UMASK: umasks, FAKE_HOOK_REPLACE: JSON.stringify([['activate', carplay]])
    }));
    check('stock files: under a caller\'s umask 077 the deploy tool runs a hook with umask 022',
        r.status === 0 && fs.readFileSync(umasks, 'utf8') === 'activate 0022\n', `${r.out}\n${fs.existsSync(umasks) ? fs.readFileSync(umasks, 'utf8') : ''}`);
    const v = root.p('var/opt/fixture-tool/versions/3.0.0');
    check('stock files: an install under umask 077 leaves the tool\'s files, folders, units and records at their modes',
        mode(path.join(v, 'bin/fixture-tool')) === 0o755 && mode(path.join(v, 'lib/helper.js')) === 0o644 &&
        mode(path.join(v, 'component.json')) === 0o644 && mode(v) === 0o755 && mode(path.join(v, 'lib')) === 0o755 &&
        mode(root.p('etc/systemd/system/fixture-tool.service')) === 0o644 && mode(root.p('var/opt/mgu-deploy/state.json')) === 0o644 &&
        mode(root.p('var/opt/mgu-deploy/kept/fixture-tool/3.0.0/units/fixture-tool.service')) === 0o600,
        [path.join(v, 'bin/fixture-tool'), path.join(v, 'component.json'), root.p('etc/systemd/system/fixture-tool.service'),
            root.p('var/opt/mgu-deploy/state.json'), root.p('var/opt/mgu-deploy/kept/fixture-tool/3.0.0/units/fixture-tool.service')]
            .map((p) => `${p} ${fs.existsSync(p) ? mode(p).toString(8) : 'absent'}`).join('\n'));
    check('stock files: a hook writing carplay as its patcher does (a temp file with mode 0755, renamed over it) leaves it 0755 under umask 077, no warning',
        mode(carplay) === 0o755 && !r.out.includes('its service\'s user'), `${mode(carplay).toString(8)}\n${r.out}`);
    check('stock files: the deploy tool\'s backups stay root\'s alone under umask 077',
        mode(root.p('var/opt/mgu-deploy/backups')) === 0o700 &&
        fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).every((d) => {
            const f = root.p(`var/opt/mgu-deploy/backups/${d}/files`);
            return !fs.existsSync(f) || (mode(f) === 0o700 && fs.readdirSync(f).every((n) => mode(path.join(f, n)) === 0o600));
        }));

    // after a firmware update: the stock carplay back; another install lays the tool's files only, Set up runs its activate
    write(root.p('etc/os-release-id-dlt'), 'BMW MGU P18_21w03 mgu-high\n');
    root.run(['install', '--artifact', art('3.0.0'), '--yes'], { FAKE_HOOK_LOG: `${root.R}.hooks.log` });
    write(root.p('etc/os-release-id-dlt'), 'BMW MGU J18_21w19.2-1-5 mgu-high\n');
    write(carplay, 'stock carplay\n', 0o755);
    const hookEnv = { FAKE_HOOK_LOG: `${root.R}.hooks.log`, FAKE_HOOK_REPLACE: JSON.stringify([['activate', carplay]]) };
    r = underUmask(0o077, () => root.run(['install', '--artifact', namedTool('other-tool', '0.1.0'), '--yes'], hookEnv));
    check('stock files: after a firmware update, an install of another tool leaves the stock carplay as it is: no activate',
        r.status === 0 && !r.out.includes('fixture-tool activate:') && fs.readFileSync(carplay, 'utf8') === 'stock carplay\n' && mode(carplay) === 0o755,
        `${mode(carplay).toString(8)}\n${r.out}`);
    r = underUmask(0o077, () => root.run(['setup', 'fixture-tool', '--yes'], hookEnv));
    check('stock files: Set up under umask 077 runs its activate, which leaves carplay 0755',
        r.status === 0 && r.out.includes('fixture-tool activate:') && mode(carplay) === 0o755, `${mode(carplay).toString(8)}\n${r.out}`);

    // a hook that leaves carplay 0700 (another user's) and aapd 0711, and tightens files of its own
    root = fakeRoot({ recmgr: ['fixture-tool'] });
    stock(root);
    const p = (rel) => root.p(rel);
    write(p('etc/aapd.conf'), 'conf\n', 0o644);
    write(p('usr/bin/locked'), 'tool\n', 0o755);
    const chmods = [['activate', p('usr/bin/carplay'), '700'].concat(asRoot ? [1234, 1234] : []), ['activate', p('usr/bin/aapd'), '711'],
        ['activate', p('etc/aapd.conf'), '600'], ['activate', p('etc/private.conf'), '400'], ['activate', p('usr/bin/locked'), '750']];
    r = root.run(['install', '--artifact', art('3.0.0'), '--yes'], { FAKE_HOOK_LOG: `${root.R}.hooks.log`,
        FAKE_HOOK_CHMOD: JSON.stringify(chmods), FAKE_HOOK_CREATE: JSON.stringify([['activate', p('usr/bin/carplay.woc-orig')]]) });
    check('stock files: an activate leaving carplay 0700 (another user\'s), aapd 0711 and aapd.conf 0600: 0755 root:root, 0755 and 0644 after it, the install through',
        r.status === 0 && mode(p('usr/bin/carplay')) === 0o755 && mode(p('usr/bin/aapd')) === 0o755 && mode(p('etc/aapd.conf')) === 0o644 &&
        (!asRoot || owner(p('usr/bin/carplay')) === '0:0'), `${r.out}\n${mode(p('usr/bin/carplay')).toString(8)} ${owner(p('usr/bin/carplay'))}`);
    check('stock files: each one fixed is a warning naming it, its mode and owner, and what it becomes',
        r.out.includes(`warning: fixture-tool activate: ${p('usr/bin/carplay')} is 0700 ${asRoot ? '1234:1234' : owner(p('usr/bin/carplay'))}, which its service's user cannot run: it becomes 0755 0:0`) &&
        r.out.includes(`warning: fixture-tool activate: ${p('usr/bin/aapd')} is 0711 `) &&
        r.out.includes(`warning: fixture-tool activate: ${p('etc/aapd.conf')} is 0600 `) && r.out.includes('cannot read: it becomes 0644 0:0'), r.out);
    check('stock files: files off the list a hook tightened stay so, and a new file the hook wrote keeps its mode',
        mode(p('etc/private.conf')) === 0o400 && mode(p('usr/bin/locked')) === 0o750 && mode(p('usr/bin/carplay.woc-orig')) === 0o600 &&
        !r.out.includes('private.conf') && !r.out.includes('locked'), r.out);

    r = root.run(['uninstall', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: `${root.R}.hooks.log`,
        FAKE_HOOK_CHMOD: JSON.stringify([['deactivate', p('usr/bin/carplay'), '700']]) });
    check('stock files: a deactivate leaving carplay 0700 gets it 0755 too, the removal through',
        r.status === 0 && mode(p('usr/bin/carplay')) === 0o755 && r.out.includes(`warning: fixture-tool deactivate: ${p('usr/bin/carplay')} is 0700`) &&
        !fs.existsSync(root.tool('fixture-tool')), r.out);

    // through the rootfs window's sh script, as on the unit
    const shRoot = () => {
        const x = fakeRoot({ recmgr: ['fixture-tool'] });
        stock(x);
        Object.assign(x.env, { MGU_DEPLOY_FAKE_SH_WINDOW: '1', MGU_DEPLOY_MOUNT: path.join(HERE, 'fake_mount.sh'), FAKE_MOUNT_LOG: `${x.R}.mount.log` });
        return x;
    };
    const remounts = (x) => (fs.existsSync(`${x.R}.mount.log`) ? fs.readFileSync(`${x.R}.mount.log`, 'utf8').split('\n').filter(Boolean) : []);
    let x = shRoot();
    r = x.run(['install', '--artifact', art('3.0.0'), '--yes'], { FAKE_HOOK_LOG: `${x.R}.hooks.log` });
    fs.writeFileSync(`${x.R}.mount.log`, '');
    r = x.run(['install', '--artifact', art('3.0.0'), '--yes'], { FAKE_HOOK_LOG: `${x.R}.hooks.log` });
    check('stock files: a hook that leaves carplay 0755 root\'s changes nothing, with no remount',
        r.status === 0 && r.out.includes('fixture-tool activate: hook activate@3.0.0 says hello') && remounts(x).length === 0 &&
        mode(x.p('usr/bin/carplay')) === 0o755 && !r.out.includes('its service\'s user'), `${remounts(x).join(' ')}\n${r.out}`);
    r = x.run(['install', '--artifact', art('3.0.0'), '--yes'], { FAKE_HOOK_LOG: `${x.R}.hooks.log`,
        FAKE_HOOK_CHMOD: JSON.stringify([['activate', x.p('usr/bin/carplay'), '700']]) });
    check('stock files: carplay left 0700 is 0755 again through the rootfs window, / read-only after',
        r.status === 0 && mode(x.p('usr/bin/carplay')) === 0o755 && JSON.stringify(remounts(x)) === '["remount,rw","remount,ro"]' &&
        fs.readFileSync(x.p('proc/mounts'), 'utf8').includes(' ro,'), `${remounts(x).join(' ')}\n${r.out}`);

    // a symlink, in the path or the file itself, and a mount: never followed or touched
    x = fakeRoot({ recmgr: ['fixture-tool'] });
    stock(x);
    write(x.p('var/opt/private/aapd'), 'private\n', 0o700);
    fs.rmSync(x.p('usr/bin/aapd'));
    fs.symlinkSync(x.p('var/opt/private/aapd'), x.p('usr/bin/aapd'));
    write(x.p('var/opt/private/etc/aapd.conf'), 'private\n', 0o600);
    fs.mkdirSync(x.p('var/opt/private/etc'), { recursive: true });
    fs.renameSync(x.p('etc'), x.p('etc.real'));
    fs.symlinkSync(x.p('var/opt/private/etc'), x.p('etc'));
    // the fake root's own files under etc/ stay reachable through the symlink
    cp.execFileSync('cp', ['-a', `${x.p('etc.real')}/.`, x.p('var/opt/private/etc')]);
    fs.chmodSync(x.p('usr/bin/carplay'), 0o700);
    fs.appendFileSync(x.p('proc/mounts'), `/dev/vdb ${x.p('usr/bin/carplay')} ext4 rw 0 0\nrootfs / ext4 ro,relatime 0 0\n`);
    r = x.run(['install', '--artifact', art('3.0.0'), '--yes'], { FAKE_HOOK_LOG: `${x.R}.hooks.log` });
    check('stock files: a symlinked file, a file under a symlinked folder, and a mounted path are never touched',
        r.status === 0 && mode(x.p('var/opt/private/aapd')) === 0o700 && mode(x.p('var/opt/private/etc/aapd.conf')) === 0o600 &&
        mode(x.p('usr/bin/carplay')) === 0o700 && !r.out.includes('its service\'s user'), r.out);

    // / not read-only after the fix's window: the hook fails, what it asked for kept
    x = shRoot();
    x.run(['install', '--artifact', art('3.0.0'), '--yes'], { FAKE_HOOK_LOG: `${x.R}.hooks.log` });
    const unused = x.p('usr/lib/old-patched');
    write(unused, 'old\n', 0o755);
    r = x.run(['uninstall', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: `${x.R}.hooks.log`, FAKE_MOUNT_STUCK: `${x.R}.stuck`,
        FAKE_HOOK_MARK: `${x.R}.stuck`, FAKE_HOOK_CHMOD: JSON.stringify([['deactivate', x.p('usr/bin/carplay'), '700']]),
        FAKE_HOOK_REBOOT: 'patch removed; the original runs from the next start', FAKE_HOOK_REBOOT_ON: 'deactivate@3.0.0',
        FAKE_HOOK_UNUSED: JSON.stringify([unused]) });
    check('stock files: / not read-only after the fix fails the hook, saying so (a refused removal, exit 2)',
        r.status === 2 && r.out.includes('fixture-tool 3.0.0: deactivate left a stock file its service cannot use, and fixing it failed: ') && r.out.includes('mount: / is busy') &&
        fs.existsSync(x.tool('fixture-tool')), r.out);
    check('stock files: the failed hook\'s restart reason and files removed once unused are kept',
        !fs.existsSync(unused) && x.state().pending_reboot.some((q) => q.id === 'fixture-tool' && q.reason === 'patch removed; the original runs from the next start'),
        `${JSON.stringify(x.state().pending_reboot)}\n${r.out}`);
    x = shRoot();
    r = x.run(['install', '--artifact', art('3.0.0'), '--yes'], { FAKE_HOOK_LOG: `${x.R}.hooks.log`, FAKE_MOUNT_STUCK: `${x.R}.stuck`,
        FAKE_HOOK_MARK: `${x.R}.stuck`, FAKE_HOOK_CHMOD: JSON.stringify([['activate', x.p('usr/bin/carplay'), '700']]) });
    check('stock files: an activate whose fix leaves / read-write fails the install',
        r.status === 1 && r.out.includes('fixture-tool 3.0.0: activate left a stock file its service cannot use, and fixing it failed: ') && r.out.includes('mount: / is busy'), r.out);

    // the updater's token and sources: root's alone whatever the caller's umask
    [0o077, 0o022].forEach((mask) => {
        const t = fakeRoot();
        const dir = t.p('var/opt/mgu-updater/credentials');
        const res = underUmask(mask, () => cp.spawnSync(UNIT_NODE, [UNIT_JS, 'updater-token'], { encoding: 'utf8', env: t.env, input: `${TOKEN}\n` }));
        const id = Object.keys(tokenTexts(t))[0];
        check(`stock files: under umask 0${mask.toString(8)} the updater's token is 0600 and its entries 0600 in a 0700 folder`,
            res.status === 0 && mode(path.join(dir, `token-${id}`)) === 0o600 && mode(path.join(dir, 'tokens.json')) === 0o600 && mode(dir) === 0o700,
            `${res.stdout}${res.stderr}`);
    });
}

/* A rollback runs the deactivate of the version going before anything
 * switches (one that fails keeps that version current, a failure after it
 * puts everything back and activates it again) and takes out the units,
 * links, drop-ins and list names it has and the version returned to does
 * not; an uninstall takes out those of every kept version. */
function testRollbackRemoves() {
    const extra = 'fixture-tool-extra.service';
    const older = hookArtifact('1.0.0');
    const newer = (edit) => hookArtifact('1.1.0', (c) => {
        c.units.push({ name: extra, from: 'systemd/fixture-tool.service' });
        c.enable.push({ unit: extra, target: 'multi-user.target' });
        c.recmgr.push('fixture-extra-name');
        c.crashNames = ['fixture-extra-prog'];
        c.dropins = [{ unit: 'hmi.service', name: 'zz-fixture-tool.conf', from: 'fixture-tool.conf' }];
        if (edit) {
            edit(c);
        }
    });
    const withDeactivate = newer();
    const withoutDeactivate = newer((c) => { delete c.deactivate; });
    const setup = (art) => {
        const root = fakeRoot({ recmgr: ['fixture-tool', 'fixture-tool-extra'], active: `fixture-tool.service ${extra}` });
        write(root.p('etc/crashhandler-restartlist.conf'), CRASH_LIST);
        // the names recmgr loaded are the firmware's list's: they stay
        const stockRec = fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
        const log = `${root.R}.hooks.log`;
        root.run(['install', '--artifact', older, '--yes'], { FAKE_HOOK_LOG: log });
        const r = root.run(['install', '--artifact', art, '--yes'], { FAKE_HOOK_LOG: log });
        if (r.status !== 0) {
            throw new Error(`install 1.1.0 failed: ${r.out}`);
        }
        fs.writeFileSync(log, '');
        const sys = (rel) => root.p(`etc/systemd/system/${rel}`);
        return {
            root, log, stockRec,
            hooks: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
            short: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 2).join(' ')),
            current: () => fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')),
            pieces: () => [extra, `multi-user.target.wants/${extra}`, 'hmi.service.d/zz-fixture-tool.conf', `${extra}.d/zz-mgu-deploy-limits.conf`]
                .filter((rel) => lstatOrNullT(sys(rel))),
            kept: () => ['fixture-tool.service', 'fixture-tool.socket', 'sockets.target.wants/fixture-tool.socket',
                'fixture-tool.service.d/zz-mgu-deploy-limits.conf'].every((rel) => lstatOrNullT(sys(rel))),
            recmgr: () => fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8'),
            crash: () => fs.readFileSync(root.p('etc/crashhandler-restartlist.conf'), 'utf8')
        };
    };

    let t = setup(withDeactivate);
    const recBefore = t.recmgr(), crashBefore = t.crash();
    check('rollback removal: 1.1.0 installs its own unit, link, drop-in, limits and list names',
        t.pieces().length === 4 && /fixture-extra-name/.test(recBefore) && /fixture-extra-prog/.test(crashBefore), t.pieces().join());
    let before = t.root.systemctlCalls().length;
    let r = t.root.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log });
    check('rollback removal: the version going runs its deactivate with all of it in place, then the older one\'s activate',
        r.status === 0 && t.current() === 'versions/1.0.0' && t.hooks().length === 2 &&
        t.hooks()[0] === 'deactivate 1.1.0 cwd=fixture-tool/versions/1.1.0 current=versions/1.1.0 unit=yes active=active' &&
        t.hooks()[1].startsWith('activate 1.0.0 cwd=fixture-tool/versions/1.0.0 current=versions/1.0.0 '), `${r.out}\n${t.hooks().join('\n')}`);
    check('rollback removal: what only 1.1.0 installed goes (its running unit stopped first), what 1.0.0 lists stays',
        t.pieces().length === 0 && t.kept() && t.root.systemctlCalls().slice(before).includes(`stop ${extra}`), `${r.out}\n${t.pieces().join()}`);
    check('rollback removal: the recmgr and crash handler names it added go; the names the list had before it and the rest of each list stay',
        t.recmgr() === t.stockRec && recBefore.split('\nfixture-extra-name').join('') === t.stockRec &&
        t.crash() === CRASH_LIST && r.out.includes('crash handler whitelist: removed fixture-extra-prog'), `${t.recmgr()}\n${t.crash()}`);
    check('rollback removal: the newer version stays kept', fs.existsSync(path.join(t.root.tool('fixture-tool'), 'versions/1.1.0/component.json')));
    r = t.root.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log });
    check('rollback removal: a rollback to the newer version lays its own pieces again from its kept copy, list names first',
        r.status === 0 && t.current() === 'versions/1.1.0' && t.pieces().length === 4 && t.crash() === crashBefore &&
        ['fixture-extra-name', 'fixture-tool-extra'].every((n) => new RegExp(`\\[Whitelist\\][^[]*\\n${n}\\n[^[]*\\[WhitelistExitSuccess\\][^[]*\\n${n}\\n`).test(t.recmgr())),
        `${r.out}\n${t.pieces().join()}\n${t.recmgr()}`);
    t.root.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log });
    fs.rmSync(t.root.p('var/opt/mgu-deploy/kept/fixture-tool/1.1.0'), { recursive: true });
    r = t.root.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log });
    check('rollback removal: without a kept copy it says which of its own pieces are missing',
        r.status === 0 && t.current() === 'versions/1.1.0' && r.out.includes(`warning: fixture-tool 1.1.0: ${extra}, `) &&
        r.out.includes('missing; an install of its artifact lays them again'), r.out);

    t = setup(withoutDeactivate);
    r = t.root.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log });
    check('rollback removal: a version going without a deactivate: only the older one\'s activate runs, its own pieces go',
        r.status === 0 && t.current() === 'versions/1.0.0' && JSON.stringify(t.short()) === JSON.stringify(['activate 1.0.0']) &&
        t.pieces().length === 0 && t.kept(), `${r.out}\n${t.hooks().join('\n')}`);

    t = setup(withDeactivate);
    r = t.root.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log, FAKE_HOOK_FAIL: 'deactivate@1.1.0' });
    check('rollback removal: a deactivate that fails refuses the rollback, exit 2: nothing switches or goes, 1.1.0 is activated again',
        r.status === 2 && t.current() === 'versions/1.1.0' && t.pieces().length === 4 && t.recmgr() === recBefore && t.crash() === crashBefore &&
        JSON.stringify(t.short()) === JSON.stringify(['deactivate 1.1.0', 'activate 1.1.0']) &&
        r.out.includes('fixture-tool 1.1.0: deactivate exited 3') && r.out.includes('1.1.0 stays current'), `${r.out}\n${t.hooks().join('\n')}`);

    before = t.root.systemctlCalls().length;
    r = t.root.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log, FAKE_HOOK_FAIL: 'activate@1.0.0' });
    check('rollback removal: an activate that fails after the removal puts 1.1.0 back whole, starts what was stopped and activates it again, exit 1',
        r.status === 1 && t.current() === 'versions/1.1.0' && t.pieces().length === 4 && t.recmgr() === recBefore && t.crash() === crashBefore &&
        t.root.systemctlCalls().slice(before).includes(`start ${extra}`) &&
        JSON.stringify(t.short().slice(-4)) === JSON.stringify(['deactivate 1.1.0', 'activate 1.0.0', 'deactivate 1.0.0', 'activate 1.1.0']),
        `${r.out}\n${t.hooks().join('\n')}`);
    r = t.root.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log, FAKE_HOOK_FAIL: 'activate@1.0.0,deactivate@1.0.0' });
    check('rollback removal: when the activate and then the deactivate of the version gone to fail, it stays current, exit 1',
        r.status === 1 && t.current() === 'versions/1.0.0' && r.out.includes('fixture-tool 1.0.0 stays current: deactivate exited 3') &&
        JSON.stringify(t.short().slice(-3)) === JSON.stringify(['deactivate 1.1.0', 'activate 1.0.0', 'deactivate 1.0.0']),
        `${r.out}\n${t.hooks().join('\n')}`);

    // a rollback that left 1.1.0's pieces in place (as an earlier deploy tool's did): the uninstall takes them out
    t = setup(withoutDeactivate);
    const cur = path.join(t.root.tool('fixture-tool'), 'current');
    fs.unlinkSync(cur);
    fs.symlinkSync('versions/1.0.0', cur);
    r = t.root.run(['uninstall', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log });
    check('rollback removal: an uninstall takes out the units, links, drop-ins and the list names it added of every kept version',
        r.status === 0 && !fs.existsSync(t.root.tool('fixture-tool')) && t.pieces().length === 0 &&
        t.recmgr() === t.stockRec && t.crash() === CRASH_LIST, `${r.out}\n${t.pieces().join()}\n${t.recmgr()}`);

    // a failed install whose deactivate fails too: the new version stays current
    t = setup(withDeactivate);
    t.root.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: t.log });
    fs.writeFileSync(t.log, '');
    r = t.root.run(['install', '--artifact', withDeactivate, '--yes'], { FAKE_HOOK_LOG: t.log, FAKE_HOOK_FAIL: 'activate@1.1.0,deactivate@1.1.0' });
    check('rollback removal: a failed update whose deactivate fails too stays current, exit 1',
        r.status === 1 && t.current() === 'versions/1.1.0' && JSON.stringify(t.short()) === JSON.stringify(['activate 1.1.0', 'deactivate 1.1.0']) &&
        r.out.includes('fixture-tool 1.1.0 stays current: deactivate exited 3'), `${r.out}\n${t.hooks().join('\n')}`);
    // a version never installed here before: the one that stays is recorded and its copy kept, as an install does
    r = t.root.run(['install', '--artifact', hookArtifact('1.3.0'), '--yes'], { FAKE_HOOK_LOG: t.log, FAKE_HOOK_FAIL: 'activate@1.3.0,deactivate@1.3.0' });
    const st = readJson(t.root.p('var/opt/mgu-deploy/state.json'));
    check('rollback removal: a version that stays current after its deactivate failed is recorded and its copy kept',
        r.status === 1 && t.current() === 'versions/1.3.0' && st.tools['fixture-tool'].version === '1.3.0' &&
        fs.existsSync(t.root.p('var/opt/mgu-deploy/kept/fixture-tool/1.3.0/component.json')), `${r.out}\n${JSON.stringify(st.tools)}`);

    /* an install that changes the version: what only the version it replaces installed goes; an
     * older version or one from another source runs that version's deactivate first */
    const plain = hookArtifact('1.2.0');
    t = setup(withDeactivate);
    r = t.root.run(['install', '--artifact', plain, '--yes'], { FAKE_HOOK_LOG: t.log });
    check('version change: an update runs only its own activate; what only the version before installed goes',
        r.status === 0 && t.current() === 'versions/1.2.0' && JSON.stringify(t.short()) === JSON.stringify(['activate 1.2.0']) &&
        t.pieces().length === 0 && t.kept() && t.recmgr() === t.stockRec &&
        t.crash() === CRASH_LIST, `${r.out}\n${t.hooks().join('\n')}\n${t.pieces().join()}`);

    // an update after a rollback that left 1.1.0's pieces in place (as an earlier deploy tool's did)
    t = setup(withoutDeactivate);
    fs.unlinkSync(path.join(t.root.tool('fixture-tool'), 'current'));
    fs.symlinkSync('versions/1.0.0', path.join(t.root.tool('fixture-tool'), 'current'));
    r = t.root.run(['install', '--artifact', plain, '--yes'], { FAKE_HOOK_LOG: t.log });
    check('version change: an update takes out what any kept version installed and it does not list, and the folders it created',
        r.status === 0 && t.current() === 'versions/1.2.0' && t.pieces().length === 0 && t.kept() && t.crash() === CRASH_LIST &&
        !fs.existsSync(t.root.p('etc/systemd/system/hmi.service.d')), `${r.out}\n${t.pieces().join()}`);

    // a unit another installed tool lists stays when the version that listed it goes
    t = setup(withDeactivate);
    r = t.root.run(['install', '--artifact', namedTool('other-tool', '1.0.0', (c) => {
        c.units = [{ name: extra, from: 'systemd/fixture-tool.service' }];
    }), '--yes'], { FAKE_HOOK_LOG: t.log });
    before = t.root.systemctlCalls().length;
    r = t.root.run(['install', '--artifact', plain, '--yes'], { FAKE_HOOK_LOG: t.log });
    check('version change: a unit another installed tool lists is neither stopped nor taken out',
        r.status === 0 && fs.existsSync(t.root.p(`etc/systemd/system/${extra}`)) && fs.existsSync(t.root.p(`etc/systemd/system/${extra}.d/zz-mgu-deploy-limits.conf`)) &&
        !t.root.systemctlCalls().slice(before).includes(`stop ${extra}`) && !fs.existsSync(t.root.p(`etc/systemd/system/multi-user.target.wants/${extra}`)),
        `${r.out}\n${t.pieces().join()}`);

    t = setup(withDeactivate);
    before = t.root.systemctlCalls().length;
    r = t.root.run(['install', '--artifact', older, '--yes'], { FAKE_HOOK_LOG: t.log });
    check('version change: a downgrade runs the deactivate of the version it replaces first, all of it in place, then its own activate',
        r.status === 0 && t.current() === 'versions/1.0.0' && t.hooks().length === 2 &&
        t.hooks()[0] === 'deactivate 1.1.0 cwd=fixture-tool/versions/1.1.0 current=versions/1.1.0 unit=yes active=active' &&
        t.hooks()[1].startsWith('activate 1.0.0 '), `${r.out}\n${t.hooks().join('\n')}`);
    check('version change: a downgrade takes out what only the version it replaces installed, its running unit stopped first',
        t.pieces().length === 0 && t.kept() && t.crash() === CRASH_LIST && t.root.systemctlCalls().slice(before).includes(`stop ${extra}`),
        `${r.out}\n${t.pieces().join()}`);

    t = setup(withDeactivate);
    r = t.root.run(['install', '--artifact', plain, '--other-source', '--yes'], { FAKE_HOOK_LOG: t.log });
    check('version change: a newer version from another source also runs the deactivate of the version it replaces first',
        r.status === 0 && t.current() === 'versions/1.2.0' && JSON.stringify(t.short()) === JSON.stringify(['deactivate 1.1.0', 'activate 1.2.0']) &&
        t.pieces().length === 0, `${r.out}\n${t.hooks().join('\n')}`);

    t = setup(withDeactivate);
    r = t.root.run(['install', '--artifact', older, '--yes'], { FAKE_HOOK_LOG: t.log, FAKE_HOOK_FAIL: 'deactivate@1.1.0' });
    check('version change: a downgrade whose deactivate fails is refused, exit 2: 1.1.0 stays whole and is activated again',
        r.status === 2 && t.current() === 'versions/1.1.0' && t.pieces().length === 4 && t.recmgr() === recBefore && t.crash() === crashBefore &&
        JSON.stringify(t.short()) === JSON.stringify(['deactivate 1.1.0', 'activate 1.1.0']) && r.out.includes('1.1.0 stays current'),
        `${r.out}\n${t.hooks().join('\n')}`);

    t = setup(withDeactivate);
    before = t.root.systemctlCalls().length;
    r = t.root.run(['install', '--artifact', older, '--yes'], { FAKE_HOOK_LOG: t.log, FAKE_HOOK_FAIL: 'activate@1.0.0' });
    check('version change: a downgrade whose activate fails puts 1.1.0 back whole, starts what was stopped and activates it again, exit 1',
        r.status === 1 && t.current() === 'versions/1.1.0' && t.pieces().length === 4 && t.recmgr() === recBefore && t.crash() === crashBefore &&
        t.root.systemctlCalls().slice(before).includes(`start ${extra}`) &&
        JSON.stringify(t.short()) === JSON.stringify(['deactivate 1.1.0', 'activate 1.0.0', 'deactivate 1.0.0', 'activate 1.1.0']),
        `${r.out}\n${t.hooks().join('\n')}`);
}

/* A tool whose 1.1.0 patches files 1.0.0 knows nothing of (as the Android
 * Auto patch): its activate writes them, its deactivate puts them back; a
 * hook named in $FAKE_PATCH_FAIL (<command>@<version>) exits 3; with
 * $FAKE_STATE_PROBE its activate appends the "deactivated" of
 * $FAKE_STATE_FILE (state.json) as it finds it. 1.1.0's deactivate puts a
 * folder where the deploy tool writes $FAKE_BLOCK_TMP next (its .tmp-<pid>),
 * which an activate takes away, and hands over $FAKE_PATCH_UNUSED
 * (removeWhenUnused). edit changes its component.json. */
function patchArtifact(version, edit) {
    const dir = fixtureCopy(version, (c) => {
        c.files.push({ path: 'patch.js', from: 'patch.js', mode: '0644' });
        c.activate = ['node', 'patch.js', 'activate'];
        c.deactivate = ['node', 'patch.js', 'deactivate'];
        if (edit) {
            edit(c);
        }
    });
    fs.writeFileSync(path.join(dir, 'patch.js'), [
        "const fs = require('fs');",
        `if (process.env.FAKE_PATCH_FAIL === process.argv[2] + '@' + ${JSON.stringify(version)}) process.exit(3);`,
        "if (process.argv[2] === 'activate' && process.env.FAKE_STATE_PROBE) fs.appendFileSync(process.env.FAKE_STATE_PROBE, " +
            "JSON.stringify(JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE, 'utf8')).deactivated || {}) + '\\n');",
        // the deploy tool's pid (Node 8.9.4 has no process.ppid)
        "const ppid = process.ppid || Number(/\\) \\S+ (\\d+)/.exec(fs.readFileSync('/proc/self/stat', 'utf8'))[1]);",
        "const block = process.env.FAKE_BLOCK_TMP ? process.env.FAKE_BLOCK_TMP + '.tmp-' + ppid : null;",
        "if (block && process.argv[2] === 'activate' && fs.existsSync(block)) fs.rmdirSync(block);",
        `if (${JSON.stringify(version)} !== '1.1.0') process.exit(0);`,
        "const on = process.argv[2] === 'activate';",
        "fs.writeFileSync(process.env.FAKE_AAPD, on ? 'patched aapd\\n' : 'stock aapd\\n');",
        "fs.writeFileSync(process.env.FAKE_AAPD_CONF, on ? 'patched conf\\n' : 'stock conf\\n');",
        "if (block && !on) fs.mkdirSync(block);",
        "if (!on && process.env.FAKE_PATCH_UNUSED) console.log(JSON.stringify({ removeWhenUnused: JSON.parse(process.env.FAKE_PATCH_UNUSED) }));",
        ''].join('\n'));
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    const r = hu(['artifact', dir, '--out', out]);
    if (r.status !== 0) {
        throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
    }
    return path.join(out, `fixture-tool@${version}.tgz`);
}

/* A car an earlier deploy tool rolled back from 1.1.0 to 1.0.0 (current
 * switched, 1.1.0 kept, its patch in place): the uninstall runs 1.0.0's
 * deactivate, then 1.1.0's, and the patched files are stock again. */
function testUninstallAfterOldRollback() {
    const root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    const files = { FAKE_AAPD: root.p('usr/bin/aapd'), FAKE_AAPD_CONF: root.p('etc/aapd.conf') };
    write(files.FAKE_AAPD, 'stock aapd\n');
    write(files.FAKE_AAPD_CONF, 'stock conf\n');
    root.run(['install', '--artifact', patchArtifact('1.0.0'), '--yes'], files);
    root.run(['install', '--artifact', patchArtifact('1.1.0'), '--yes'], files);
    const cur = path.join(root.tool('fixture-tool'), 'current');
    fs.unlinkSync(cur);
    fs.symlinkSync('versions/1.0.0', cur);
    check('old rollback: the files stay patched after it', fs.readFileSync(files.FAKE_AAPD, 'utf8') === 'patched aapd\n' &&
        fs.readFileSync(files.FAKE_AAPD_CONF, 'utf8') === 'patched conf\n');
    let r = root.run(['uninstall', 'fixture-tool', '--yes'], Object.assign({ FAKE_PATCH_FAIL: 'deactivate@1.1.0' }, files));
    check('old rollback: the kept newer version\'s deactivate runs after the current one\'s; its refusal keeps the tool whole, exit 2',
        r.status === 2 && fs.existsSync(root.tool('fixture-tool')) && fs.existsSync(root.p('etc/systemd/system/fixture-tool.service')) &&
        r.out.includes('fixture-tool 1.1.0: deactivate exited 3') && r.out.split('fixture-tool deactivate: node patch.js deactivate').length === 3, r.out);
    r = root.run(['uninstall', 'fixture-tool', '--yes'], files);
    check('old rollback: the uninstall leaves the patched files stock',
        r.status === 0 && !fs.existsSync(root.tool('fixture-tool')) && fs.readFileSync(files.FAKE_AAPD, 'utf8') === 'stock aapd\n' &&
        fs.readFileSync(files.FAKE_AAPD_CONF, 'utf8') === 'stock conf\n', r.out);

    const stock = () => fs.readFileSync(files.FAKE_AAPD, 'utf8') === 'stock aapd\n' && fs.readFileSync(files.FAKE_AAPD_CONF, 'utf8') === 'stock conf\n';
    const oldStyle = (firmware) => {
        const rr = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
        if (firmware) {
            write(rr.p('etc/os-release-id-dlt'), `${firmware}\n`);
        }
        const ff = { FAKE_AAPD: rr.p('usr/bin/aapd'), FAKE_AAPD_CONF: rr.p('etc/aapd.conf') };
        write(ff.FAKE_AAPD, 'stock aapd\n');
        write(ff.FAKE_AAPD_CONF, 'stock conf\n');
        rr.run(['install', '--artifact', patchArtifact('1.0.0'), '--yes'], ff);
        rr.run(['install', '--artifact', patchArtifact('1.1.0'), '--yes'], ff);
        const c = path.join(rr.tool('fixture-tool'), 'current');
        fs.unlinkSync(c);
        fs.symlinkSync('versions/1.0.0', c);
        Object.assign(files, ff);
        return rr;
    };

    // an update after it: the newer version kept runs its deactivate before it goes
    let rr = oldStyle();
    r = rr.run(['install', '--artifact', patchArtifact('1.2.0'), '--yes'], files);
    check('old rollback: an update runs the deactivate of the newer version kept before it goes; the files are stock',
        r.status === 0 && stock() && !fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.1.0')), r.out);
    rr = oldStyle();
    r = rr.run(['install', '--artifact', patchArtifact('1.2.0'), '--yes'], Object.assign({ FAKE_PATCH_FAIL: 'deactivate@1.1.0' }, files));
    check('old rollback: one whose deactivate fails refuses the update, exit 2, naming it; nothing switches, it stays kept and owed',
        r.status === 2 && fs.readlinkSync(path.join(rr.tool('fixture-tool'), 'current')) === 'versions/1.0.0' &&
        fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.1.0')) && !fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.2.0')) &&
        fs.readFileSync(files.FAKE_AAPD, 'utf8') === 'patched aapd\n' &&
        r.out.includes('fixture-tool 1.2.0: the kept fixture-tool 1.1.0 must be deactivated first, and its deactivate exited 3') &&
        r.out.includes('1.0.0 stays current') &&
        JSON.stringify(readJson(rr.p('var/opt/mgu-deploy/state.json')).deactivate_owed) === '{"fixture-tool":["1.1.0"]}', r.out);
    r = rr.run(['uninstall', 'fixture-tool', '--yes'], files);
    check('old rollback: and the removal runs it again; the files are stock', r.status === 0 && stock() && !fs.existsSync(rr.tool('fixture-tool')), r.out);

    // laying the current version again for a unit missing (another install lays its files, setup the rest) runs the due deactivate first
    rr = oldStyle();
    fs.unlinkSync(rr.p('etc/systemd/system/fixture-tool.service'));
    rr.run(['install', '--artifact', namedTool('other-tool', '1.0.0'), '--yes'], files);
    r = rr.run(['setup', 'fixture-tool', '--yes'], files);
    check('old rollback: laying the current version again for a unit missing runs the due deactivate first; the files are stock',
        r.status === 0 && fs.existsSync(rr.p('etc/systemd/system/fixture-tool.service')) && stock() &&
        !fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.1.0')), r.out);
    rr = oldStyle();
    fs.unlinkSync(rr.p('etc/systemd/system/fixture-tool.service'));
    rr.run(['install', '--artifact', namedTool('other-tool', '1.0.0'), '--yes'], files);
    r = rr.run(['setup', 'fixture-tool', '--yes'], Object.assign({ FAKE_PATCH_FAIL: 'deactivate@1.1.0' }, files));
    check('old rollback: one whose deactivate fails stays kept and owed, said, and the current version is laid again',
        r.status === 0 && fs.existsSync(rr.p('etc/systemd/system/fixture-tool.service')) &&
        fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.1.0')) &&
        r.out.includes('warning: fixture-tool 1.1.0: deactivate exited 3; it stays kept and owed, and fixture-tool 1.0.0 is laid again') &&
        JSON.stringify(readJson(rr.p('var/opt/mgu-deploy/state.json')).deactivate_owed) === '{"fixture-tool":["1.1.0"]}', r.out);
    // after a firmware update (another build string than the one recorded), no due deactivate runs
    rr = oldStyle('BMW MGU P18_23w44.2-1-3 mgu-high');
    write(rr.p('etc/os-release-id-dlt'), 'BMW MGU P18_24w07 mgu-high\n');
    fs.unlinkSync(rr.p('etc/systemd/system/fixture-tool.service'));
    write(files.FAKE_AAPD, 'stock aapd\n');
    write(files.FAKE_AAPD_CONF, 'stock conf\n');
    r = rr.run(['install', '--artifact', namedTool('other-tool', '1.0.0'), '--yes'], Object.assign({ FAKE_PATCH_FAIL: 'deactivate@1.1.0' }, files));
    check('old rollback: laying the current version again after a firmware update runs no due deactivate and keeps that version',
        r.status === 0 && fs.existsSync(rr.p('etc/systemd/system/fixture-tool.service')) &&
        fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.1.0')) && !r.out.includes('patch.js deactivate'), r.out);
    r = rr.run(['setup', 'fixture-tool', '--yes'], Object.assign({ FAKE_PATCH_FAIL: 'deactivate@1.1.0' }, files));
    check('old rollback: and its setup after it runs none either, the version kept',
        r.status === 0 && fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.1.0')) && !r.out.includes('deactivate exited'), r.out);

    // after a firmware update, an install of a newer version from its artifact runs no due deactivate either
    rr = oldStyle('BMW MGU P18_23w44.2-1-3 mgu-high');
    write(rr.p('etc/os-release-id-dlt'), 'BMW MGU P18_24w07 mgu-high\n');
    write(files.FAKE_AAPD, 'stock aapd\n');
    write(files.FAKE_AAPD_CONF, 'stock conf\n');
    r = rr.run(['install', '--artifact', patchArtifact('1.2.0'), '--yes'], Object.assign({ FAKE_PATCH_FAIL: 'deactivate@1.1.0' }, files));
    check('old rollback: after a firmware update an update from its artifact runs no due deactivate, the version kept',
        r.status === 0 && !r.out.includes('deactivate exited') && fs.readlinkSync(path.join(rr.tool('fixture-tool'), 'current')) === 'versions/1.2.0' &&
        fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.1.0')), r.out);
    // files only first (relay), the firmware then recorded: the update still runs none
    rr = oldStyle('BMW MGU P18_23w44.2-1-3 mgu-high');
    write(rr.p('etc/os-release-id-dlt'), 'BMW MGU P18_24w07 mgu-high\n');
    rr.run(['relay', '--yes'], files);
    r = rr.run(['install', '--artifact', patchArtifact('1.2.0'), '--yes'], Object.assign({ FAKE_PATCH_FAIL: 'deactivate@1.1.0' }, files));
    check('old rollback: after relay under the new firmware, an update from its artifact runs no due deactivate either',
        r.status === 0 && !r.out.includes('deactivate exited') && fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.1.0')), r.out);

    // a due deactivate that ran and then failed to hand a file over: the version it replaces is activated again
    rr = oldStyle();
    const held = rr.p('usr/bin/held.old');
    write(held, 'old binary\n', 0o755);
    fs.mkdirSync(rr.p('proc/779'), { recursive: true });
    fs.symlinkSync(held, rr.p('proc/779/exe'));
    r = rr.run(['install', '--artifact', patchArtifact('1.2.0'), '--yes'], Object.assign({ FAKE_PATCH_UNUSED: JSON.stringify([held]),
        FAKE_BLOCK_TMP: rr.p('var/opt/mgu-deploy/remove-when-unused.json') }, files));
    check('old rollback: a due deactivate that fails after it ran still has the version it replaces activated again',
        r.status === 1 && fs.readlinkSync(path.join(rr.tool('fixture-tool'), 'current')) === 'versions/1.0.0' &&
        r.out.includes('fixture-tool 1.0.0 activated again'), r.out);

    // an uninstall that fails after the newer version's deactivate ran keeps that recorded: the next one does not run it again
    rr = oldStyle();
    r = rr.run(['uninstall', 'fixture-tool', '--yes'], Object.assign({ FAKE_FAIL: 'stop fixture-tool.service' }, files));
    check('old rollback: a removal failing after the deactivates keeps them recorded', r.status === 1 && stock() &&
        fs.existsSync(rr.tool('fixture-tool')) &&
        JSON.stringify(readJson(rr.p('var/opt/mgu-deploy/state.json')).deactivated) === '{"fixture-tool":["1.1.0"]}', r.out);
    r = rr.run(['uninstall', 'fixture-tool', '--yes'], Object.assign({ FAKE_PATCH_FAIL: 'deactivate@1.1.0' }, files));
    check('old rollback: so the next removal does not run that deactivate again', r.status === 0 && !fs.existsSync(rr.tool('fixture-tool')), r.out);

    // an update whose due deactivate ran, then failed: the version it replaces is activated again
    rr = oldStyle();
    const hookLog = `${rr.R}.hooks.log`;
    r = rr.run(['install', '--artifact', hookArtifact('1.2.0', (c) => { delete c.activate; c.check = ['hook.js', 'check']; }), '--yes'],
        Object.assign({ FAKE_HOOK_LOG: hookLog, FAKE_HOOK_FAIL: 'check@1.2.0' }, files));
    check('old rollback: an update that fails after the due deactivate ran activates the version it replaces again',
        r.status === 1 && fs.readlinkSync(path.join(rr.tool('fixture-tool'), 'current')) === 'versions/1.0.0' &&
        r.out.includes('fixture-tool 1.0.0 activated again'), r.out);
    rr = oldStyle();
    const changed = patchArtifact('1.0.0', (c) => { c.units.push({ name: 'fixture-tool-extra.service', from: 'systemd/fixture-tool.service' }); });
    r = rr.run(['install', '--artifact', changed, '--yes'], Object.assign({ FAKE_FAIL: 'restart fixture-tool.service' }, files));
    check('old rollback: so does a reinstall of the current version that fails after it',
        r.status === 1 && r.out.includes('fixture-tool 1.0.0 activated again'), r.out);

    // a rollback by this tool: the version it left ran its deactivate, and the uninstall does not run it again
    rr = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    files.FAKE_AAPD = rr.p('usr/bin/aapd');
    files.FAKE_AAPD_CONF = rr.p('etc/aapd.conf');
    write(files.FAKE_AAPD, 'stock aapd\n');
    write(files.FAKE_AAPD_CONF, 'stock conf\n');
    rr.run(['install', '--artifact', patchArtifact('1.0.0'), '--yes'], files);
    rr.run(['install', '--artifact', patchArtifact('1.1.0'), '--yes'], files);
    const probe = `${rr.R}.state-probe`;
    r = rr.run(['rollback', 'fixture-tool', '--yes'], Object.assign({ FAKE_STATE_PROBE: probe, FAKE_STATE_FILE: rr.p('var/opt/mgu-deploy/state.json') }, files));
    check('rollback: the record of the deactivate is on disk before the next hook runs',
        fs.existsSync(probe) && fs.readFileSync(probe, 'utf8') === '{"fixture-tool":["1.1.0"]}\n', fs.existsSync(probe) ? fs.readFileSync(probe, 'utf8') : 'no probe');
    // a rollback that fails puts the snapshot back with the record the deactivate made
    const fr = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    const ff = { FAKE_AAPD: fr.p('usr/bin/aapd'), FAKE_AAPD_CONF: fr.p('etc/aapd.conf') };
    write(ff.FAKE_AAPD, 'stock aapd\n');
    write(ff.FAKE_AAPD_CONF, 'stock conf\n');
    fr.run(['install', '--artifact', patchArtifact('1.0.0'), '--yes'], ff);
    fr.run(['install', '--artifact', patchArtifact('1.1.0'), '--yes'], ff);
    fs.writeFileSync(fr.unitFile('fixture-tool.service.crash'), `${path.join(fr.tool('fixture-tool'), 'current')} versions/1.0.0\n`);
    const frProbe = `${fr.R}.state-probe`;
    const fail = fr.run(['rollback', 'fixture-tool', '--yes'], Object.assign({ FAKE_STATE_PROBE: frProbe, FAKE_STATE_FILE: fr.p('var/opt/mgu-deploy/state.json') }, ff));
    check('rollback: a snapshot put back keeps the record of the deactivate that ran, until the activate after it',
        fail.status === 1 && fs.existsSync(frProbe) && fs.readFileSync(frProbe, 'utf8') === '{"fixture-tool":["1.1.0"]}\n',
        `${fs.existsSync(frProbe) ? fs.readFileSync(frProbe, 'utf8') : 'no probe'}\n${fail.out}`);
    // a record the disk refuses right after the hook is kept for the command's own save
    const br = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    const bf = { FAKE_AAPD: br.p('usr/bin/aapd'), FAKE_AAPD_CONF: br.p('etc/aapd.conf') };
    write(bf.FAKE_AAPD, 'stock aapd\n');
    write(bf.FAKE_AAPD_CONF, 'stock conf\n');
    br.run(['install', '--artifact', patchArtifact('1.0.0'), '--yes'], bf);
    br.run(['install', '--artifact', patchArtifact('1.1.0'), '--yes'], bf);
    const blocked = br.run(['rollback', 'fixture-tool', '--yes'], Object.assign({ FAKE_BLOCK_TMP: br.p('var/opt/mgu-deploy/state.json') }, bf));
    check('rollback: a record the disk refuses after the hook is said and kept, and is on disk once the disk takes it',
        blocked.status === 0 && blocked.out.includes('warning: fixture-tool: the record of its hooks is not on disk yet') &&
        JSON.stringify(readJson(br.p('var/opt/mgu-deploy/state.json')).deactivated) === '{"fixture-tool":["1.1.0"]}', blocked.out);
    const pruned = br.run(['install', '--artifact', patchArtifact('1.2.0'), '--yes'], bf);
    check('rollback: an install that removes the version deactivated drops its record',
        pruned.status === 0 && !fs.existsSync(path.join(br.tool('fixture-tool'), 'versions/1.1.0')) &&
        (readJson(br.p('var/opt/mgu-deploy/state.json')).deactivated || {})['fixture-tool'] === undefined, pruned.out);
    check('rollback: the version it leaves is recorded as deactivated', r.status === 0 && stock() &&
        JSON.stringify(readJson(rr.p('var/opt/mgu-deploy/state.json')).deactivated) === '{"fixture-tool":["1.1.0"]}', r.out);
    r = rr.run(['uninstall', 'fixture-tool', '--yes'], Object.assign({ FAKE_PATCH_FAIL: 'deactivate@1.1.0' }, files));
    check('rollback: the uninstall after it does not run that deactivate again, and the record goes with the tool',
        r.status === 0 && !fs.existsSync(rr.tool('fixture-tool')) && readJson(rr.p('var/opt/mgu-deploy/state.json')).deactivated['fixture-tool'] === undefined,
        r.out);

    // a version made current again loses its record, whether or not it has an activate
    rr = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    const noActivate = (v) => hookArtifact(v, (c) => { delete c.activate; });
    rr.run(['install', '--artifact', noActivate('1.0.0'), '--yes'], { FAKE_HOOK_LOG: `${rr.R}.hooks.log` });
    rr.run(['install', '--artifact', noActivate('1.1.0'), '--yes'], { FAKE_HOOK_LOG: `${rr.R}.hooks.log` });
    rr.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: `${rr.R}.hooks.log` });
    const marked = () => (readJson(rr.p('var/opt/mgu-deploy/state.json')).deactivated || {})['fixture-tool'];
    const wasMarked = JSON.stringify(marked());
    r = rr.run(['install', '--artifact', noActivate('1.1.0'), '--yes'], { FAKE_HOOK_LOG: `${rr.R}.hooks.log` });
    check('rollback: a version installed again loses its deactivated record, with no activate to clear it',
        wasMarked === '["1.1.0"]' && r.status === 0 && marked() === undefined, `${wasMarked} ${JSON.stringify(marked())}\n${r.out}`);
    fs.writeFileSync(rr.unitFile('fixture-tool.service.crash'), `${path.join(rr.tool('fixture-tool'), 'current')} versions/1.0.0\n`);
    r = rr.run(['rollback', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: `${rr.R}.hooks.log` });
    check('rollback: one that fails puts the version it left back with no record, though it has no activate',
        r.status === 1 && fs.readlinkSync(path.join(rr.tool('fixture-tool'), 'current')) === 'versions/1.1.0' && marked() === undefined,
        `${JSON.stringify(marked())}\n${r.out}`);
    fs.unlinkSync(rr.unitFile('fixture-tool.service.crash'));
    r = rr.run(['install', '--artifact', hookArtifact('1.3.0'), '--yes'], { FAKE_HOOK_LOG: `${rr.R}.hooks.log`, FAKE_HOOK_FAIL: 'activate@1.3.0' });
    check('rollback: a failed install whose version folder goes leaves no record of it',
        r.status === 1 && !fs.existsSync(path.join(rr.tool('fixture-tool'), 'versions/1.3.0')) && marked() === undefined,
        `${JSON.stringify(marked())}\n${r.out}`);
}

/* A hook's "removeWhenUnused": a file no process runs goes at once; one a
 * process runs waits for mgu-deploy-cleanup.service, installed, enabled and
 * in the recmgr list, whose remove-unused removes it once nothing runs it. */
function testRemoveWhenUnused() {
    const root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    const hookLog = `${root.R}.hooks.log`;
    root.run(['install', '--artifact', hookArtifact('1.0.0'), '--yes'], { FAKE_HOOK_LOG: hookLog });
    const kept = root.p('usr/bin/thing.old-running');
    write(kept, 'old binary\n', 0o755);
    // a process runs it: its fake /proc exe is that file
    fs.mkdirSync(root.p('proc/777'), { recursive: true });
    fs.symlinkSync(kept, root.p('proc/777/exe'));
    let r = root.run(['uninstall', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: hookLog, FAKE_HOOK_UNUSED: JSON.stringify([kept]) });
    const unit = root.p('etc/systemd/system/mgu-deploy-cleanup.service');
    check('unused: a file a process runs is kept and queued, the removal goes on', r.status === 0 && fs.existsSync(kept) &&
        !fs.existsSync(root.tool('fixture-tool')) && JSON.stringify(root.status().remove_when_unused) === JSON.stringify([kept]) &&
        r.out.includes('removed at a later start, once no process runs it'), r.out);
    check('unused: the cleanup unit is installed, enabled and in the recmgr list',
        fs.readFileSync(unit, 'utf8') === fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-deploy-cleanup.service'), 'utf8') &&
        fs.readlinkSync(root.p('etc/systemd/system/late.target.wants/mgu-deploy-cleanup.service')) === '../mgu-deploy-cleanup.service' &&
        /\[Whitelist\][^[]*mgu-deploy-cleanup[^[]*\[WhitelistExitSuccess\][^[]*mgu-deploy-cleanup/.test(fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8')));
    check('unused: the unit runs only with something queued, waits for the lock with no start timeout, always ends as succeeded',
        /ConditionPathExists=\/var\/opt\/mgu-deploy\/remove-when-unused\.json/.test(fs.readFileSync(unit, 'utf8')) &&
        /^Type=simple$/m.test(fs.readFileSync(unit, 'utf8')) && /^ExecStart=-\/bin\/sh \S+mgu-deploy\.sh remove-unused$/m.test(fs.readFileSync(unit, 'utf8')));
    r = root.run(['remove-unused']);
    check('unused: remove-unused keeps it while a process runs it', r.status === 0 && fs.existsSync(kept) &&
        JSON.stringify(root.status().remove_when_unused) === JSON.stringify([kept]) && r.out.includes('still run by a process'), r.out);
    // the next start: nothing runs it
    cp.execFileSync('rm', ['-rf', root.p('proc/777')]);
    r = root.run(['remove-unused']);
    check('unused: once nothing runs it, remove-unused removes it and empties the queue', r.status === 0 && !fs.existsSync(kept) &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/remove-when-unused.json')) && root.status().remove_when_unused.length === 0 &&
        r.out.includes('removed ' + kept), r.out);
    r = root.run(['remove-unused']);
    check('unused: with nothing queued it has nothing to do', r.status === 0 && r.out.includes('nothing to remove'), r.out);

    // a removal that fails after its deactivate handed a file over is rolled
    // back whole: the cleanup unit, its link and the queue with the recmgr list
    const fl = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    fl.run(['install', '--artifact', hookArtifact('1.0.0'), '--yes'], { FAKE_HOOK_LOG: `${fl.R}.hooks.log` });
    const held = fl.p('usr/bin/held.old-running');
    write(held, 'old binary\n', 0o755);
    fs.mkdirSync(fl.p('proc/778'), { recursive: true });
    fs.symlinkSync(held, fl.p('proc/778/exe'));
    const recBefore = fs.readFileSync(fl.p('etc/recmgr-restartlist.conf'), 'utf8');
    r = fl.run(['uninstall', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: `${fl.R}.hooks.log`, FAKE_HOOK_UNUSED: JSON.stringify([held]),
        FAKE_FAIL: 'stop fixture-tool.service' });
    check('unused: a removal failing after the hand-over rolls back the cleanup unit, its link, the queue and the recmgr list',
        r.status === 1 && fs.existsSync(fl.tool('fixture-tool')) && r.out.includes('mgu-deploy-cleanup.service installed') &&
        !fs.existsSync(fl.p('etc/systemd/system/mgu-deploy-cleanup.service')) &&
        !fs.existsSync(fl.p('etc/systemd/system/late.target.wants/mgu-deploy-cleanup.service')) &&
        !fs.existsSync(fl.p('var/opt/mgu-deploy/remove-when-unused.json')) &&
        fs.readFileSync(fl.p('etc/recmgr-restartlist.conf'), 'utf8') === recBefore, r.out);
    const flCalls = fl.systemctlCalls();
    check('unused: that rollback reloads systemd after the units are back',
        flCalls.lastIndexOf('daemon-reload') > flCalls.lastIndexOf('stop fixture-tool.service'), flCalls.join("; ") + "\n" + r.out);
    const flog = fs.readFileSync(`${fl.R}.hooks.log`, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 2).join(' '));
    check('unused: and the tool, back after its deactivate ran, is activated again',
        JSON.stringify(flog.slice(-2)) === JSON.stringify(['deactivate 1.0.0', 'activate 1.0.0']), flog.join('; '));

    const now = fakeRoot({ recmgr: ['fixture-tool'] });
    now.run(['install', '--artifact', hookArtifact('1.0.0'), '--yes'], { FAKE_HOOK_LOG: `${now.R}.hooks.log` });
    const free = now.p('usr/bin/free.old-running');
    write(free, 'old binary\n', 0o755);
    const dir = now.p('usr/bin/somedir');
    fs.mkdirSync(dir, { recursive: true });
    const link = now.p('usr/bin/link');
    fs.symlinkSync(free, link);
    r = now.run(['uninstall', 'fixture-tool', '--yes'], { FAKE_HOOK_LOG: `${now.R}.hooks.log`,
        FAKE_HOOK_UNUSED: JSON.stringify([free, dir, link, 'relative/path', `${now.R}/usr/bin/../etc/passwd`, now.p('usr/bin/gone')]) });
    check('unused: a file no process runs goes at once, nothing queued, no unit', r.status === 0 && !fs.existsSync(free) &&
        !fs.existsSync(now.p('var/opt/mgu-deploy/remove-when-unused.json')) && !fs.existsSync(now.p('etc/systemd/system/mgu-deploy-cleanup.service')), r.out);
    check('unused: a folder or a symlink is left as it is, a relative or ".." path ignored, each said',
        fs.existsSync(dir) && fs.lstatSync(link).isSymbolicLink() && fs.existsSync(now.p('etc/passwd')) &&
        r.out.includes('somedir is not a regular file') && r.out.includes('"relative/path" is not an absolute file path') &&
        r.out.includes('../etc/passwd') && r.out.includes('is not an absolute file path'), r.out);
}

/* stock and the newest ten snapshots stay */
function testBackupRetention() {
    const root = fakeRoot();
    for (let i = 0; i < 12; i++) root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const names = fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).sort();
    check('backups: stock and the 10 newest snapshots are kept',
        names.length === 11 && names.includes('stock'), names.join(' '));
    const r = root.run(['restore', 'stock', '--yes']);
    check('backups: stock still restores after pruning', r.status === 0 && !fs.existsSync(root.tool('fixture-tool')), r.out);
}

/* one changing run at a time; status reads while another run holds the lock */
function testLock() {
    const root = fakeRoot();
    const lock = root.p('var/opt/mgu-deploy/lock');
    const boot = fs.readFileSync(root.p('proc/boot_id'), 'utf8').trim();
    const runWait = (args, ms) => {
        const r = cp.spawnSync(UNIT_NODE, [UNIT_JS].concat(args),
            { encoding: 'utf8', env: Object.assign({}, root.env, { MGU_DEPLOY_LOCK_WAIT_MS: String(ms) }), input: '' });
        r.out = `${r.stdout}${r.stderr}`;
        return r;
    };
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid} ${boot}\n`);
    let r = runWait(['install', '--artifact', toolArtifact('0.2.0'), '--yes'], 1500);
    check('lock: a live holder makes an install wait, then refuse (exit 2), nothing installed',
        r.status === 2 && r.out.includes(`waiting for the mgu-deploy run with pid ${process.pid}`) &&
        !fs.existsSync(root.tool('fixture-tool')) && fs.existsSync(lock), r.out);
    r = root.run(['status', '--json']);
    check('lock: status --json answers while the lock is held', r.status === 0 && JSON.parse(r.stdout).version, r.out);
    fs.writeFileSync(lock, `${process.pid} boot-earlier\n`);
    r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('lock: a lock from an earlier boot is taken over, and released after the run',
        r.status === 0 && fs.existsSync(root.tool('fixture-tool')) && !fs.existsSync(lock), r.out);
    const gone = cp.spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(lock, `${gone} ${boot}\n`);
    r = root.run(['uninstall', 'fixture-tool', '--yes']);
    check('lock: a lock whose holder is gone is taken over', r.status === 0 && !fs.existsSync(root.tool('fixture-tool')) &&
        !fs.existsSync(lock), r.out);
}

/* An id provisioning already uses keeps provisioning's flags: hidden. */
function testProvisioningSection() {
    const root = fakeRoot();
    fs.writeFileSync(`${root.R}.sections.json`, JSON.stringify({ fixture_app: { '-allowed': 'false', '-enabled': 'false' } }));
    const r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const a = root.status().components.find((c) => c.id === 'fixture_app');
    check('tile: an app whose id provisioning already uses installs, with a warning that its tile stays hidden',
        r.status === 0 && r.out.includes("fixture_app's tile stays hidden: provisioning has its own section for fixture_app"), r.out);
    check('tile: status reports it hidden', a && a.tile_visible === false && a.tile_provisioned === false &&
        a.tile_fallback === false, JSON.stringify(a));
}

/* An app whose registry entry caches -enabled and -allowed false (one
 * provisioning dropped) updates listed enabled and allowed. */
function testDisabledCache() {
    const root = fakeRoot();
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const entry = readJson(root.entry('fixture_app'));
    entry.provisioningCache = Object.assign({}, entry.provisioningCache, { '-enabled': 'false', '-allowed': 'false' });
    write(root.entry('fixture_app'), JSON.stringify(entry), 0o660);
    const r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
    const listed = (readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {}).fixture_app || {};
    check('disabled cache: the update lists the app enabled and allowed', r.status === 0 &&
        listed['-enabled'] === 'true' && listed['-allowed'] === 'true', `${JSON.stringify(listed)}\n${r.out}`);
}

/* A current that is a folder (an earlier installer's) goes aside for the
 * install and goes once the new version is up; a failed install, its
 * health check or app-privacy apply included, puts it back; a killed
 * install's folder comes back at the next run. */
function testLegacyCurrent() {
    const legacy = (root, id, files) => {
        const cur = path.join(root.tool(id || 'fixture-tool'), 'current');
        Object.entries(files || { 'old.js': 'old\n' }).forEach(([n, d]) => write(path.join(cur, n), d));
        return cur;
    };
    const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { return null; } };
    const isBack = (root, cur, id) => isLink(cur) === false && fs.readFileSync(path.join(cur, 'old.js'), 'utf8') === 'old\n' &&
        !fs.readdirSync(root.tool(id || 'fixture-tool')).some((n) => n === 'current.new' || n.startsWith('current.legacy-'));

    let root = fakeRoot();
    let cur = legacy(root);
    let r = root.run(['install', '--artifact', plainArtifact('0.2.0'), '--yes']);
    check('legacy current: a folder current is replaced by a link to the new version, and goes once it is up',
        r.status === 0 && isLink(cur) && fs.readlinkSync(cur) === 'versions/0.2.0' &&
        fs.readdirSync(root.tool('fixture-tool')).join(' ') === 'current versions', r.out);

    // the restart fails; the rollback itself works
    root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service', fail: 'restart fixture-tool.service' });
    cur = legacy(root);
    r = root.run(['install', '--artifact', plainArtifact('0.2.0'), '--yes']);
    check('legacy current: a failed install puts the folder back as current, with no current.new or version left',
        r.status === 1 && isBack(root, cur) && fs.readdirSync(root.tool('fixture-tool')).join(' ') === 'current' &&
        r.out.includes('current folder is back'), r.out);

    root = fakeRoot({ recmgr: ['fixture-tool'] });
    cur = legacy(root);
    fs.writeFileSync(root.unitFile('fixture-tool.service.crash'), `${cur} versions/0.2.0\n`);
    r = root.run(['install', '--artifact', plainArtifact('0.2.0'), '--yes']);
    check('legacy current: a failed health check puts the folder back and restarts the tool on it',
        r.status === 1 && isBack(root, cur) && !r.out.includes('stays current') &&
        r.out.includes("fixture-tool's earlier install is healthy"), r.out);

    // app-privacy's own tool runs from current: the new version has none, the folder's applies
    root = fakeRoot({ privacy: false });
    cur = legacy(root, 'app-privacy', { 'old.js': 'old\n', 'patch_mainapp.js': 'console.log(JSON.stringify({ state: "patched" }));\n' });
    r = root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    check('legacy current: a failed app-privacy apply puts the folder back and applies it again',
        r.status === 1 && isBack(root, cur, 'app-privacy') && !r.out.includes('stays current') &&
        r.out.includes("app-privacy's earlier install applied again"), r.out);

    // a killed install: its folder comes back when current is gone, else goes
    const gone = Number(cp.spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
    root = fakeRoot();
    cur = legacy(root);
    fs.renameSync(cur, `${cur}.legacy-${gone}`);
    r = root.run(['rollback', 'fixture-tool', '--yes']);
    check('legacy current: a killed install\'s folder is current again at the next run', isBack(root, cur), r.out);
    root = fakeRoot();
    root.run(['install', '--artifact', plainArtifact('0.2.0'), '--yes']);
    cur = legacy(root, 'fixture-tool', {});
    write(`${cur}.legacy-${gone}/old.js`, 'old\n');
    r = root.run(['rollback', 'fixture-tool', '--yes']);
    check('legacy current: a killed install\'s folder goes at the next run when current is in place',
        fs.readlinkSync(cur) === 'versions/0.2.0' && fs.readdirSync(root.tool('fixture-tool')).join(' ') === 'current versions', r.out);

    // a folder current an earlier installer left, as the current version: the uninstall goes through
    root = fakeRoot();
    legacy(root, 'fixture-tool', { 'component.json': JSON.stringify({ id: 'fixture-tool', kind: 'tool', version: '0.1.0', files: [] }) });
    r = root.run(['uninstall', 'fixture-tool', '--yes']);
    check('legacy current: a tool whose current is a folder uninstalls', r.status === 0 && !fs.existsSync(root.tool('fixture-tool')), r.out);
}

/* A killed run's files go at the next changing run. */
function testStaleFiles() {
    const root = fakeRoot();
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const gone = Number(cp.spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
    const dd = root.p('var/opt/mgu-deploy');
    ['stage-', 'window-', 'main.fallback-'].forEach((p, i) => fs.mkdirSync(path.join(dd, `${p}${gone}${['', '.sh', '.js'][i]}`)));
    fs.writeFileSync(path.join(dd, `write-${gone}-0`), 'x');
    fs.writeFileSync(path.join(dd, `state.json.tmp-${gone}`), 'x');
    fs.mkdirSync(path.join(root.tool('fixture-tool'), 'versions', `0.3.0.partial-${gone}`));
    fs.mkdirSync(root.p(`var/opt/abandoned-tool/versions/1.0.0.partial-${gone}`), { recursive: true });
    fs.writeFileSync(root.p(`var/opt/.mgu-deploy-probe-${gone}`), '');
    fs.writeFileSync(path.join(dd, `write-${process.pid}-0`), 'live');
    const oldKit = root.p('var/opt/mgu-deploy-kit-11'), newKit = root.p('var/opt/mgu-deploy-kit-12');
    fs.mkdirSync(oldKit); fs.mkdirSync(newKit);
    fs.utimesSync(oldKit, Date.now() / 1000 - 2 * 86400, Date.now() / 1000 - 2 * 86400);
    const r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const left = fs.readdirSync(dd).filter((n) => n.includes(String(gone)))
        .concat(fs.readdirSync(path.join(root.tool('fixture-tool'), 'versions')).filter((n) => n.includes(String(gone))))
        .concat(fs.readdirSync(root.p('var/opt/abandoned-tool/versions')).filter((n) => n.includes(String(gone))))
        .concat(fs.readdirSync(root.p('var/opt')).filter((n) => n.includes(String(gone))));
    check('stale: a killed run\'s staging, window, write, temp, probe and partial files go (a never-finished tool\'s too); a live run\'s stay',
        r.status === 0 && left.length === 0 && fs.existsSync(path.join(dd, `write-${process.pid}-0`)), `${r.out}\n${left.join(' ')}`);
    check('stale: a day-old deploy/hu kit folder goes, a fresh one stays', !fs.existsSync(oldKit) && fs.existsSync(newKit));
}

/* restore refuses what it would leave broken: a component installed after
 * the backup without what it runs under, a current on a version gone. */
function testRestoreRefusals() {
    const plog = (root) => (fs.existsSync(`${root.R}.privacy.log`) ? fs.readFileSync(`${root.R}.privacy.log`, 'utf8').split('\n').filter(Boolean) : []);
    let root = fakeRoot({ privacy: false });
    root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    let r = root.run(['restore', 'stock', '--yes']);
    check('restore refusal: app-privacy would go while a later app of ours stays: exit 2, nothing reverted',
        r.status === 2 && r.out.includes('fixture_app would stay installed without app-privacy') &&
        fs.existsSync(root.tool('app-privacy')) && fs.existsSync(root.entry('fixture_app')) &&
        !plog(root).some((l) => l.includes('revert')), r.out);
    root.run(['uninstall', 'fixture_app', '--yes']);
    r = root.run(['restore', 'stock', '--yes']);
    check('restore refusal: with that app uninstalled first, the restore runs', r.status === 0 &&
        !fs.existsSync(root.tool('app-privacy')), r.out);

    root = fakeRoot();
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    root.run(['install', '--artifact', privacyArtifact(), '--yes']);
    const rec = fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
    r = root.run(['restore', 'stock', '--yes']);
    check('restore refusal: a later tool would lose its recmgr entries: exit 2, the list unchanged',
        r.status === 2 && r.out.includes('app-privacy would lose its recmgr entries (app-privacy, fixture-tool)') &&
        fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8') === rec, r.out);

    root = fakeRoot();
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    root.run(['uninstall', 'fixture-tool', '--yes']);
    const un = fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).filter((n) => n.endsWith('-uninstall'))[0];
    r = root.run(['restore', un, '--yes']);
    check('restore refusal: a current on a version no longer kept: exit 2, nothing put back',
        r.status === 2 && r.out.includes('fixture-tool 0.2.0 is no longer kept') &&
        !fs.existsSync(root.p('etc/systemd/system/fixture-tool.service')), r.out);
}

/* Turning the fallback off applies app-privacy to the stock main.js the
 * copy was bound over. */
function testFallbackOffPrivacy() {
    const root = fakeRoot({ privacy: false });
    root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--yes']);
    root.run(['fallback', 'on']);
    const n = fs.readFileSync(`${root.R}.privacy.log`, 'utf8').split('\n').filter(Boolean).length;
    const r = root.run(['fallback', 'off']);
    const after = fs.readFileSync(`${root.R}.privacy.log`, 'utf8').split('\n').filter(Boolean).slice(n);
    check('fallback off: app-privacy applies to the stock main.js', r.status === 0 && after.includes('1.0.0 apply --json'),
        `${r.out}\n${after.join('\n')}`);
}

/* ---- per-artifact transactions ---------------------------------------------------------- */

function testTransactions() {
    // the app fails (no manager to install it); the tool before it stays
    let root = fakeRoot({ noManager: true });
    let r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const sys = root.p('etc/systemd/system');
    check('transaction: a failing app after a tool exits 1 and says the tool was kept',
        r.status === 1 && r.out.includes('installed before this failure, and kept: fixture-tool 0.2.0') &&
        fs.readlinkSync(path.join(root.tool('fixture-tool'), 'current')) === 'versions/0.2.0', r.out);
    check('transaction: the app\'s package, custom_apps entry and the fallback it turned on are gone',
        !fs.existsSync(root.preinstalled('fixture_app', '1.0.0')) &&
        !fs.existsSync(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) &&
        !fs.existsSync(path.join(sys, 'mgu-app-fallback.service')) && !fs.existsSync(root.p('var/opt/mgu-deploy/main.js')) &&
        !fs.existsSync(path.join(sys, 'multi-user.target.wants/mgu-app-fallback.service')), r.out);

    // the manager installs but never writes the keychain: its partial home goes
    root = fakeRoot({ noKeychain: true });
    r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('transaction: a partial manager install is removed (entry and app home)', r.status === 1 &&
        !fs.existsSync(root.entry('fixture_app')) && !fs.existsSync(root.home(13001)) && fs.existsSync(root.home(13000)) &&
        r.out.includes('partial install'), r.out);

    // a fresh tool (its recmgr entry loaded) that fails after its socket started leaves nothing behind
    root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service', fail: 'restart fixture-tool.service' });
    r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const sys2 = root.p('etc/systemd/system');
    check('transaction: a failed fresh tool leaves no versions/ without current, its socket stopped, its units gone',
        r.status === 1 && !fs.existsSync(root.tool('fixture-tool')) && root.systemctlCalls().includes('stop fixture-tool.socket') &&
        !fs.existsSync(path.join(sys2, 'fixture-tool.socket')) && !fs.existsSync(path.join(sys2, 'sockets.target.wants/fixture-tool.socket')) &&
        fs.existsSync(path.join(sys2, 'sockets.target.wants')), r.out);

    // .wants folders this tool created go when emptied; stock ones stay
    root = fakeRoot({ noWants: true });
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const wants = root.p('etc/systemd/system/sockets.target.wants');
    const made = fs.existsSync(wants);
    r = root.run(['uninstall', 'fixture-tool', '--yes']);
    check('wants: an emptied .wants folder the tool created is removed on uninstall', made && r.status === 0 && !fs.existsSync(wants), r.out);
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    r = root.run(['restore', 'stock', '--yes']);
    check('wants: and on restore', r.status === 0 && !fs.existsSync(wants), r.out);
    root = fakeRoot();
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    root.run(['uninstall', 'fixture-tool', '--yes']);
    check('wants: a stock .wants folder stays, even empty', fs.existsSync(root.p('etc/systemd/system/sockets.target.wants')));
}

/* ---- the updater's tokens ------------------------------------------------------------------ */

const TOKEN = 'github_pat_FIXTURE0only0for0the0deploy0tests0000000000';

/* The texts of the updater's tokens under a fake root, by id. */
function tokenTexts(root) {
    const dir = root.p('var/opt/mgu-updater/credentials');
    const out = {};
    (fs.existsSync(dir) ? fs.readdirSync(dir) : []).forEach((n) => {
        const m = /^token-([0-9a-f]{8})$/.exec(n);
        if (m) {
            out[m[1]] = fs.readFileSync(path.join(dir, n), 'utf8').trim();
        }
    });
    return out;
}

function testToken() {
    const root = fakeRoot();
    const dir = root.p('var/opt/mgu-updater/credentials');
    const list = () => readJson(path.join(dir, 'tokens.json'));
    const runIn = (args, input) => {
        const r = cp.spawnSync(UNIT_NODE, [UNIT_JS].concat(args), { encoding: 'utf8', env: root.env, input });
        r.out = `${r.stdout}${r.stderr}`;
        return r;
    };
    const outputs = [];
    let r = runIn(['updater-token'], `${TOKEN}\n`);
    outputs.push(r.out);
    const id = Object.keys(tokenTexts(root))[0];
    check('token: stored from stdin as a token of its own, trailing newline dropped, 0600 in a 0700 folder, with its entry',
        r.status === 0 && /^[0-9a-f]{8}$/.test(id) && tokenTexts(root)[id] === TOKEN && mode(path.join(dir, `token-${id}`)) === 0o600 &&
        mode(dir) === 0o700 && mode(path.join(dir, 'tokens.json')) === 0o600 && list().length === 1 && list()[0].id === id &&
        list()[0].kind === 'github' && r.out.includes(`${TOKEN.length} bytes`) && r.out.includes(id), r.out);
    r = runIn(['updater-token'], TOKEN);
    outputs.push(r.out);
    check('token: the same text again is not stored twice', r.status === 0 && r.out.includes(`stored already as ${id}`) &&
        Object.keys(tokenTexts(root)).length === 1, r.out);
    // the updater's own fields stay when another token is added
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify([Object.assign(list()[0], { label: 'car', login: 'someone' })]));
    r = runIn(['updater-token'], `${TOKEN}2\n`);
    const id2 = Object.keys(tokenTexts(root)).find((x) => x !== id);
    check('token: a second token beside the first, whose entry is kept', r.status === 0 && id2 && list().length === 2 &&
        list().find((t) => t.id === id).login === 'someone', JSON.stringify(list()));
    r = runIn(['updater-token', '--source', 'idrive7-apps'], TOKEN);
    check('token: no source is named (exit 2)', r.status === 2 && r.out.includes('no source'), r.out);
    r = runIn(['updater-token', '--list']);
    outputs.push(r.out);
    check('token: --list names id, label and account', r.status === 0 && r.out.includes(`${id}  car  someone`) &&
        r.out.includes(`${id2}  -  -`), r.out);
    r = runIn(['updater-token', '--list', '--json']);
    outputs.push(r.out);
    const listed = JSON.parse(r.stdout);
    check('token: --list --json', listed.length === 2 && listed[0].id === id && listed[0].login === 'someone' && listed[1].label === null &&
        Object.keys(listed[0]).sort().join() === 'addedAt,id,label,login', r.stdout);
    // a file the updater has not listed yet counts too
    fs.writeFileSync(path.join(dir, 'token-0badc0de'), 'ghp_x\n', { mode: 0o600 });
    check('token: a token file without an entry is listed', JSON.parse(runIn(['updater-token', '--list', '--json']).stdout).some((t) => t.id === '0badc0de'));
    r = runIn(['updater-token', '--remove', '0badc0de']);
    check('token: --remove <id> removes it', r.status === 0 && !tokenTexts(root)['0badc0de'], r.out);
    const st = root.status();
    const human = root.run(['status']);
    outputs.push(JSON.stringify(st), human.out);
    check('token: status counts them, in both forms', st.updater_tokens === 2 && human.stdout.includes('updater tokens: 2'));
    const before = JSON.stringify(tokenTexts(root));
    [['', 'no token'], ['a\nb\n', 'more than one line'], ['x'.repeat(513), 'over 512'], ['has space', 'spaces']].forEach(([input, why]) => {
        const bad = runIn(['updater-token'], input);
        outputs.push(bad.out);
        check(`token: refused (${why}), exit 2, nothing changed`, bad.status === 2 && bad.out.includes(why) &&
            JSON.stringify(tokenTexts(root)) === before, bad.out);
    });
    r = runIn(['updater-token', '--remove', '../x']);
    check('token: --remove takes a token id (exit 2)', r.status === 2 && r.out.includes('token id'), r.out);
    const backups = root.p('var/opt/mgu-deploy/backups');
    const stored = fs.readdirSync(backups).map((d) => path.join(backups, d, 'files')).filter((d) => fs.existsSync(d))
        .flatMap((d) => fs.readdirSync(d).map((n) => path.join(d, n)));
    check('token: snapshot copies are private and contain no credentials', mode(backups) === 0o700 &&
        stored.every((f) => mode(f) === 0o600 && !fs.readFileSync(f).includes(Buffer.from(TOKEN))) &&
        fs.readdirSync(backups).every((d) => !readJson(path.join(backups, d, 'manifest.json')).entries.some((e) =>
            e.path.includes('/credentials') || e.path.endsWith('/sources.json'))));
    r = root.run(['restore', 'stock', '--yes']);
    outputs.push(r.out);
    check('token: restoring stock keeps the updater\'s tokens', r.status === 0 && tokenTexts(root)[id] === TOKEN, r.out);
    r = runIn(['updater-token', '--remove', id]);
    outputs.push(r.out);
    check('token: --remove deletes the file and the entry', r.status === 0 && !tokenTexts(root)[id] && !list().some((t) => t.id === id) &&
        list().length === 1, r.out);
    r = runIn(['updater-token', '--remove', id]);
    check('token: removing it again is no error', r.status === 0 && r.out.includes('absent already'), r.out);
    check('token: the value is in no output', outputs.every((o) => !o.includes(TOKEN)));

    // the updater's config goes with it
    const up = fakeRoot();
    const src = fixtureCopy('0.1.0', (c) => { c.id = 'mgu-updater'; c.recmgr = ['mgu-updater']; c.restart = []; });
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    hu(['artifact', src, '--out', out]);
    up.run(['install', '--artifact', path.join(out, 'mgu-updater@0.1.0.tgz'), '--yes']);
    cp.spawnSync(UNIT_NODE, [UNIT_JS, 'updater-token'], { env: up.env, input: TOKEN });
    const un = up.run(['uninstall', 'mgu-updater', '--yes']);
    check('token: uninstalling mgu-updater removes its token with its folder, naming it', un.status === 0 &&
        !fs.existsSync(up.p('var/opt/mgu-updater')) && un.out.includes('credentials') && !un.out.includes(TOKEN), un.out);
}

/* deploy/hu with a stand-in ssh: the token travels on stdin only. */
function testHuToken() {
    const bin = fs.mkdtempSync(path.join(T, 'bin-'));
    fs.symlinkSync(path.join(HERE, 'fake_ssh.sh'), path.join(bin, 'ssh'));
    const tokenFile = path.join(fs.mkdtempSync(path.join(T, 'tok-')), 'token');
    fs.writeFileSync(tokenFile, `${TOKEN}\n`);
    const run = (args, extra) => {
        const log = path.join(fs.mkdtempSync(path.join(T, 'ssh-')), 'log');
        const r = hu(args, Object.assign({ PATH: `${bin}:${process.env.PATH}`, FAKE_SSH_LOG: log, HU_HOST: '127.0.0.1' }, extra || {}));
        const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
        return { r, calls, stdin: (i) => fs.readFileSync(`${log}.${i}`) };
    };
    let x = run(['updater-token', '--updater-token-file', tokenFile]);
    check('hu token: updater-token stages the installer, then sends the token on stdin',
        x.r.status === 0 && x.calls.length === 3 && x.calls[1].includes("'updater-token'") &&
        x.stdin(1).toString() === `${TOKEN}\n`, `${x.r.stderr}\n${x.calls.join('\n')}`);
    const staged = Object.keys(untarBuf(x.stdin(0))).sort().join(' ');
    check('hu: the staging upload carries the deploy tool with its linker and packer', staged ===
        'component.json fallback_build.js mgu-app-fallback-id8.service mgu-app-fallback.service mgu-deploy-apply.service mgu-deploy-cleanup.service mgu-deploy-safe-mode.service mgu-deploy-verify.service mgu-deploy.js mgu-deploy.sh oap_link.js oap_pack.js safe_mode.sh var-opt-ro-safe-mode.conf', staged);
    check('hu token: not in any ssh argument, the staging upload or the output',
        x.calls.every((c) => !c.includes(TOKEN)) && !zlib.gunzipSync(x.stdin(0)).includes(TOKEN) &&
        !`${x.r.stdout}${x.r.stderr}`.includes(TOKEN));
    x = run(['install', '--artifact', toolArtifact('0.2.0')], { HU_UPDATER_TOKEN_FILE: tokenFile });
    check('hu token: install seeds the updater\'s sources, then sends the token', x.r.status === 0 &&
        x.calls.length === 5 && x.calls[1].includes("'install'") && x.calls[2].includes("'updater-sources'") &&
        x.stdin(2).equals(fs.readFileSync(path.join(DEPLOY, 'sources.json'))) &&
        /'updater-token'$/.test(x.calls[3]) && x.stdin(3).toString() === `${TOKEN}\n` &&
        x.calls.every((c) => !c.includes(TOKEN)), x.calls.join('\n'));
    x = run(['updater-token', '--remove', '3f9a01c2']);
    check('hu token: --remove <id> sends the id and no token', x.r.status === 0 && x.calls[1].includes("'updater-token' '--remove' '3f9a01c2'") &&
        x.stdin(1).length === 0, x.calls.join('\n'));
    x = run(['updater-token', '--list', '--json']);
    check('hu token: --list sends no token', x.r.status === 0 && x.calls[1].includes("'updater-token' '--list' '--json'") && x.stdin(1).length === 0,
        x.calls.join('\n'));
    x = run(['updater-token']);
    check('hu token: updater-token without a file is a usage error, nothing sent', x.r.status === 2 && x.calls.length === 0, x.r.stderr);
}

/* ---- the connection (deploy/transport) ------------------------------------------------------- */

const TRANSPORT = path.join(DEPLOY, 'transport');

/* deploy/test/connect_test.js: how mgu-install.js finds the unit. */
function testConnect() {
    const r = cp.spawnSync(process.execPath, [path.join(HERE, 'connect_test.js')], { encoding: 'utf8' });
    const lines = r.stdout.split('\n');
    let seen = 0;
    lines.forEach((l, i) => {
        const m = /^(not )?ok (.*)$/.exec(l);
        if (m) {
            seen += 1;
            const detail = [];
            for (let j = i + 1; j < lines.length && lines[j].startsWith('  # '); j += 1) {
                detail.push(lines[j].slice(4));
            }
            check(`connect: ${m[2]}`, !m[1], detail.join('\n'));
        }
    });
    check('connect: connect_test.js ran to the end', r.status === 0 && seen > 20, `${r.status} ${r.stderr.slice(-2000)}`);
}

/* deploy/transport compiles on the system python3, and its own tests
 * (transport_test.py: selection, banner, relay, arming) all pass. */
function testTransport() {
    fs.readdirSync(TRANSPORT).filter((f) => f.endsWith('.py')).forEach((f) => {
        const r = cp.spawnSync('python3', ['-B', '-c', 'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
            path.join(TRANSPORT, f), path.join(T, `${f}c`)], { encoding: 'utf8' });
        check(`transport: ${f} compiles on python3`, r.status === 0, r.stderr);
    });
    const r = cp.spawnSync('python3', ['-B', path.join(HERE, 'transport_test.py')], { encoding: 'utf8' });
    const lines = r.stdout.split('\n');
    let seen = 0;
    lines.forEach((l, i) => {
        const m = /^(not )?ok (.*)$/.exec(l);
        if (m) {
            seen += 1;
            const detail = [];
            for (let j = i + 1; j < lines.length && lines[j].startsWith('  # '); j += 1) {
                detail.push(lines[j].slice(4));
            }
            check(`transport: ${m[2]}`, !m[1], detail.join('\n'));
        }
    });
    check('transport: transport_test.py ran to the end', r.status === 0 && seen > 30, `${r.status} ${r.stderr.slice(-2000)}`);
}

/* deploy/hu without --host: the connection deploy/transport selects (its
 * network replaced by fake_transport.py) is the target of every ssh call. */
function testHuConnect() {
    const bin = fs.mkdtempSync(path.join(T, 'bin-'));
    fs.symlinkSync(path.join(HERE, 'fake_ssh.sh'), path.join(bin, 'ssh'));
    const assets = fs.mkdtempSync(path.join(T, 'assets-'));
    ['mgu_ssh_key_rsa.pem', 'asset_03.bin', 'asset_04.bin'].forEach((n) => fs.writeFileSync(path.join(assets, n), 'placeholder\n'));
    const key = path.join(assets, 'mgu_ssh_key_rsa.pem');
    const run = (args, extra) => {
        const dir = fs.mkdtempSync(path.join(T, 'conn-'));
        const log = path.join(dir, 'ssh');
        const tlog = path.join(dir, 'transport');
        const r = hu(args, Object.assign({
            PATH: `${bin}:${process.env.PATH}`, FAKE_SSH_LOG: log, FAKE_TRANSPORT_LOG: tlog,
            MGU_CONNECT_FAKES: path.join(HERE, 'fake_transport.py'), HU_HOST: '', HU_PORT: '', HU_IDENTITY: '',
            HU_ASSETS_DIR: assets, HU_STATE_DIR: path.join(dir, 'state')
        }, extra || {}));
        const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
        const t = lines(tlog);
        const port = (t.find((l) => l.startsWith('hu-port ')) || '').slice(8);
        return { r, calls: lines(log), t, port, requests: t.filter((l) => l.startsWith('request ')).map((l) => l.slice(8)) };
    };
    const target = (c) => {
        const m = /-p (\d+) .*?(\S+@\S+) /.exec(`${c} `);
        return m ? `${m[2]}:${m[1]}` : c;
    };

    let x = run(['status', '--wifi']);
    check('hu connect: --wifi sends every ssh call straight to the hotspot address, no relay, no HSFZ',
        x.r.status === 0 && x.calls.length === 3 && x.port && x.calls.every((c) => target(c) === `root@127.0.0.1:${x.port}`) &&
        x.requests.length === 0 && !x.t.some((l) => l.startsWith('discover')), `${x.r.stderr}\n${x.calls.join('\n')}\n${x.t.join('\n')}`);
    check('hu connect: a selected connection uses the assets key and does not pin host keys',
        x.calls.every((c) => c.includes(`-i ${key} -o IdentitiesOnly=yes`) && c.includes('StrictHostKeyChecking=no') &&
            c.includes('UserKnownHostsFile=/dev/null')), x.calls[0]);

    x = run(['status', '--lport', '0'], { FAKE_ENET: '1' });
    const relayed = x.calls.length ? target(x.calls[0]) : '';
    check('hu connect: auto over ENET sends every ssh call to the relay on 127.0.0.1, found by DID 172A unarmed',
        x.r.status === 0 && x.calls.length === 3 && /^root@127\.0\.0\.1:\d+$/.test(relayed) && relayed !== `root@127.0.0.1:${x.port}` &&
        x.calls.every((c) => target(c) === relayed) && x.requests.join(' ') === '22172a',
        `${x.r.stderr}\n${x.calls.join('\n')}\n${x.t.join('\n')}`);

    x = run(['status', '--host', '10.9.8.7', '--wifi', '--hu-ip', '169.254.1.2']);
    check('hu connect: --host beats the selection (no transport started)',
        x.r.status === 0 && x.calls.length === 3 && x.calls.every((c) => target(c) === 'root@10.9.8.7:22') &&
        !x.t.length && x.r.stderr.includes('not used') && !x.calls[0].includes('StrictHostKeyChecking'), `${x.r.stderr}\n${x.calls.join('\n')}`);
    x = run(['status'], { HU_HOST: '10.9.8.6', FAKE_ENET: '1' });
    check('hu connect: HU_HOST beats the selection', x.r.status === 0 && x.calls.every((c) => target(c) === 'root@10.9.8.6:22') && !x.t.length,
        x.calls.join('\n'));

    x = run(['install', '--arm-debug', '--wifi', '--artifact', toolArtifact('0.2.0')]);
    check('hu connect: --arm-debug with --wifi is a usage error before any network',
        x.r.status === 2 && !x.calls.length && !x.t.length && x.r.stderr.includes('drop --wifi/--hu-ip'), x.r.stderr);
    x = run(['status', '--keep-armed']);
    check('hu connect: --keep-armed without --arm-debug is a usage error', x.r.status === 2 && !x.t.length, x.r.stderr);

    x = run(['status', '--wifi'], { HU_ASSETS_DIR: path.join(T, 'no-assets') });
    check('hu connect: missing assets name the key and where it looked, nothing started',
        x.r.status === 2 && !x.t.length && !x.calls.length && x.r.stderr.includes('mgu_ssh_key_rsa.pem') &&
        x.r.stderr.includes(path.join(T, 'no-assets')) && x.r.stderr.includes('--assets-dir'), x.r.stderr);
    x = run(['status', '--wifi', '--identity', '/k/id_rsa'], { HU_ASSETS_DIR: path.join(T, 'no-assets') });
    check('hu connect: --identity overrides the assets key', x.r.status === 0 &&
        x.calls.every((c) => c.includes('-i /k/id_rsa ')), `${x.r.stderr}\n${x.calls[0]}`);

    x = run(['status'], { FAKE_ENET: '1', FAKE_SILENT: '1' });
    check('hu connect: a unit that does not answer stops with the permanent-SSH-disabled message, nothing armed',
        x.r.status === 1 && !x.calls.length && x.r.stderr.includes('Permanent (field-mode) SSH seems disabled') &&
        !x.requests.some((q) => q.startsWith('31')), `${x.r.stderr}\n${x.t.join('\n')}`);

    x = run(['status', '--arm-debug', '--lport', '0'], { FAKE_ENET: '1' });
    check('hu connect: --arm-debug arms, relays every ssh call, and disarms when the command is done',
        x.r.status === 0 && x.calls.length === 3 && x.calls.every((c) => /^root@127\.0\.0\.1:\d+$/.test(target(c))) &&
        x.requests.slice(0, 4).join(' ') === '1003 3101a671 3101a0fd 22172a' && x.requests[x.requests.length - 1] === '3102a0fd' &&
        x.r.stderr.includes('invalidates the MyBMW login'), `${x.r.stderr}\n${x.t.join('\n')}`);
    x = run(['status', '--arm-debug', '--keep-armed', '--lport', '0'], { FAKE_ENET: '1' });
    check('hu connect: --arm-debug --keep-armed does not disarm', x.r.status === 0 && x.requests.includes('3101a0fd') &&
        !x.requests.includes('3102a0fd'), x.t.join('\n'));

    x = run(['connect', '--wifi']);
    check('hu connect: connect prints the ssh command line for the hotspot and returns',
        x.r.status === 0 && x.r.stdout.trim() === `ssh -p ${x.port} -i ${key} -o IdentitiesOnly=yes -o HostKeyAlgorithms=+ssh-rsa ` +
            `-o PubkeyAcceptedAlgorithms=+ssh-rsa -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ` +
            '-o ConnectTimeout=8 root@127.0.0.1', x.r.stdout);
    const t0 = Date.now();
    x = run(['connect', '--hold', '1', '--lport', '0'], { FAKE_ENET: '1' });
    check('hu connect: connect --hold prints the relay\'s ssh command line and holds it',
        x.r.status === 0 && /^ssh -p \d+ .* root@127\.0\.0\.1$/.test(x.r.stdout.trim()) && !x.r.stdout.includes(`-p ${x.port} `) &&
        Date.now() - t0 >= 1000 && x.r.stderr.includes('holding'), `${x.r.stdout}\n${x.r.stderr}`);
    x = run(['connect', '--wifi', '--cmd', 'id']);
    check('hu connect: connect --cmd runs one command on the unit', x.r.status === 0 && x.calls.length === 1 &&
        x.calls[0].endsWith('root@127.0.0.1 id'), x.calls.join('\n'));
    x = run(['status', '--hold', '5', '--wifi']);
    check('hu connect: --hold applies to connect only', x.r.status === 2 && !x.t.length, x.r.stderr);
}

/* ---- restore after a bootstrap --------------------------------------------------------- */

function testRestoreAfterBootstrap() {
    const out = path.join(T, 'boot-self');
    hu(['artifact', DEPLOY, '--out', out]);
    const root = fakeRoot();
    let r = root.run(['install', '--artifact', path.join(out, `mgu-deploy@${VERSION}.tgz`), '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('bootstrap: the deploy tool and a tool in the first install', r.status === 0 &&
        fs.readlinkSync(root.p('var/opt/mgu-deploy/current')) === `versions/${VERSION}`, r.out);
    r = root.run(['restore', 'stock', '--yes']);
    const cur = root.p('var/opt/mgu-deploy/current');
    check('bootstrap: restore stock keeps the deploy tool it was bootstrapped with', r.status === 0 &&
        fs.existsSync(path.join(cur, 'mgu-deploy.js')), `${r.out}\nversions: ${fs.existsSync(root.p('var/opt/mgu-deploy/versions')) ?
        fs.readdirSync(root.p('var/opt/mgu-deploy/versions')).join(' ') : '(none)'}`);
    const shim = cp.spawnSync('sh', [root.p('var/opt/mgu-deploy/mgu-deploy.sh'), 'status', '--json'],
        { encoding: 'utf8', env: Object.assign({}, root.env, { MGU_DEPLOY_NODE: UNIT_NODE }) });
    check('bootstrap: the shim answers status --json after the restore', shim.status === 0, shim.stdout + shim.stderr);
}

/* ---- the retired installer's leftovers ---------------------------------------------------- */

/* MainApp 8.3.2's AppManagement.js records each install's installationSource. */
const AM_STOCK = 'AppManagement stock app.setPersistentProperty("installationSource",installationSource)\n';
/* The retired edit names the apps it lists as string literals; with
 * opts.dropApp it also lists drop_app, built from two literals. */
const retiredEdit = (ids, dropApp) => stockMain().replace('module.exports=',
    `/* retired edit */var retiredApps=${JSON.stringify(ids)}${dropApp ? '.concat("drop"+"_app")' : ''};module.exports=`);

/* A unit as the retired installer left it, with the deploy tool's fallback
 * on: main.js carries the retired edit, main.js.capbak is the stock file
 * and main.js.vcbak an earlier edit; AppManagement.js carries an edit,
 * AppManagement.js.capbak the stock file (none with opts.noAmBackup);
 * base.json has ignoreSignatureFailure true. The edit lists old_app (uid
 * 13002) and old_two (13003), ours, and legacy_app (13004), not marked;
 * custom_apps.json does not list them (with opts.allUnmarked none of the
 * three is marked). With opts.dropApp it also lists
 * drop_app (13005, not marked) in a form that names no literal. store_app
 * (13001) came through the deploy tool, stock_app is provisioned. The fake
 * manager provisions every app (FAKE_MGR_RETIRED): one listed by nothing
 * loses its tile. */
function retiredRoot(opts) {
    opts = opts || {};
    const listed = ['old_app', 'old_two', 'legacy_app'];
    const root = fakeRoot({ main: retiredEdit(listed, opts.dropApp), minUp: opts.minUp });
    const r = root.run(['install', '--artifact', appArtifact('store_app', '0.2.0', true), '--yes']);
    if (r.status !== 0) {
        throw new Error(`retiredRoot: ${r.out}`);
    }
    const src = root.p('usr/lib/oap-mainapp/src');
    write(path.join(src, 'main.js.capbak'), stockMain(), 0o755);
    write(path.join(src, 'main.js.vcbak'), retiredEdit(['old_app']), 0o755);
    write(`${root.R}.stock-appmanagement.js`, AM_STOCK);
    write(path.join(src, 'AppManagement/AppManagement.js'), `${AM_STOCK}/* retired edit */\n`, 0o755);
    if (!opts.noAmBackup) {
        write(path.join(src, 'AppManagement/AppManagement.js.capbak'), AM_STOCK, 0o755);
    }
    const base = root.p('usr/lib/oap-mainapp/config/base.json');
    root.stockBase = fs.readFileSync(base, 'utf8');
    fs.writeFileSync(base, root.stockBase.replace('"ignoreSignatureFailure": false', '"ignoreSignatureFailure": true'));
    root.flags = { '-allowed': 'true', '-appStartType': 'manually', '-enabled': 'true',
        '-userLoginRequired': 'false', '-updateMechanism': 'PLATFORM' };
    const apps = [['old_app', 13002, !opts.allUnmarked], ['old_two', 13003, !opts.allUnmarked], ['legacy_app', 13004, false]];
    if (opts.dropApp) {
        apps.push(['drop_app', 13005, false]);
    }
    apps.forEach(([id, uid, marked]) => {
        const pkg = appArtifact(id, '1.0.0', marked);
        fs.copyFileSync(pkg, root.preinstalled(id, '1.0.0'));
        fs.mkdirSync(path.join(root.home(uid), 'source'), { recursive: true });
        cp.execFileSync('tar', ['-xzf', pkg, '-C', path.join(root.home(uid), 'source')]);
        write(path.join(root.home(uid), 'someipInterfaces/acl.json'), '{}\n');
        write(path.join(root.home(uid), 'security/joynrKeyChain.json'), '{}\n');
        fs.appendFileSync(root.p(`var/opt/public/oap/oap_${MGR}/security/uids.txt`), `${uid}=${id}\n`);
        write(root.entry(id), JSON.stringify({ userId: uid, provisioningCache: root.flags,
            configStateQueueIndex: null, installationSource: 'PREINSTALLED' }), 0o660);
    });
    write(`${root.R}.sections.json`, JSON.stringify({ stock_app: { '-enabled': 'true', '-allowed': 'true' } }));
    write(`${root.R}.retired.json`, JSON.stringify(apps.map(([id]) => id)));
    root.env.FAKE_MGR_RETIRED = `${root.R}.retired.json`;
    root.custom = () => readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
    root.visible = (id) => {
        const c = (readJsonOrNull(root.entry(id)) || {}).provisioningCache || {};
        return c['-enabled'] === 'true' && c['-allowed'] === 'true';
    };
    root.src = (rel) => path.join(src, rel);
    root.snapshots = () => fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).sort();
    return root;
}

/* what a migration and its rollback leave as they found: everything but
 * the snapshots and the deploy tool's state */
const notBackups = (rel) => rel.startsWith('var/opt/mgu-deploy/backups') || rel === 'var/opt/mgu-deploy/state.json';

function testRetiredDetect() {
    const root = retiredRoot();
    const before = root.hash();
    const c = root.run(['check']);
    check('retired: check names each backup and whether it is the stock bundle', c.status === 0 &&
        c.out.includes(`retired installer's backup: ${root.src('main.js.capbak')} (the stock main.js)`) &&
        c.out.includes(`retired installer's backup: ${root.src('main.js.vcbak')} (not the stock main.js)`) &&
        c.out.includes(`retired installer's backup: ${root.src('AppManagement/AppManagement.js.capbak')} (the stock AppManagement.js)`) &&
        c.out.includes('migrates them') && c.out.includes('ignoreSignatureFailure: true'), c.out);
    const st = root.status();
    check('retired: status --json lists the leftovers', JSON.stringify(st.retired_leftovers) === JSON.stringify(
        [root.src('main.js.capbak'), root.src('main.js.vcbak'), root.src('AppManagement/AppManagement.js.capbak')]),
    JSON.stringify(st.retired_leftovers));
    const store = st.components.find((x) => x.id === 'store_app') || {};
    check('retired: with the leftovers, a listed app\'s tile is reported from the registry cache while the manager is not on the copy',
        st.fallback.manager_runs_copy === false && 'store_app' in root.custom() && store.tile_visible === true, JSON.stringify(st));
    check('retired: check and status change nothing', root.hash().hash === before.hash, treeDiff(before, root.hash()));
}

function testRetiredMigrate() {
    const root = retiredRoot({ minUp: 1 });
    const pre = {
        main: fs.readFileSync(root.src('main.js')), am: fs.readFileSync(root.src('AppManagement/AppManagement.js')),
        base: fs.readFileSync(root.p('usr/lib/oap-mainapp/config/base.json')), custom: fs.readFileSync(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`))
    };
    const kills0 = root.kills().length;
    const snaps0 = root.snapshots();
    const r = root.run(['install', '--artifact', appArtifact('old_app', '1.1.0', true), '--yes']);
    check('retired: an app update migrates the leftovers first, exit 0', r.status === 0 &&
        r.out.indexOf("migrating the retired installer's leftovers") >= 0 &&
        r.out.indexOf("leftovers are migrated") < r.out.indexOf('installing app old_app 1.1.0'), r.out);
    check('retired: the bundles are the stock files again',
        fs.readFileSync(root.src('main.js'), 'utf8') === stockMain() &&
        fs.readFileSync(root.src('AppManagement/AppManagement.js'), 'utf8') === AM_STOCK &&
        mode(root.src('main.js')) === 0o644 && mode(root.src('AppManagement/AppManagement.js')) === 0o755);
    check('retired: the backups are gone', !fs.existsSync(root.src('main.js.capbak')) &&
        !fs.existsSync(root.src('main.js.vcbak')) && !fs.existsSync(root.src('AppManagement/AppManagement.js.capbak')));
    check('retired: base.json is stock again (ignoreSignatureFailure false, nothing else changed)',
        fs.readFileSync(root.p('usr/lib/oap-mainapp/config/base.json'), 'utf8') === root.stockBase);
    const custom = root.custom();
    check('retired: custom_apps.json lists every app of ours and the edit\'s own, with their registry flags',
        JSON.stringify(Object.keys(custom).sort()) === '["legacy_app","old_app","old_two","store_app"]' &&
        JSON.stringify(custom.legacy_app) === JSON.stringify(custom.old_two) &&
        JSON.stringify(custom.old_two) === JSON.stringify(Object.assign({ '-enabled': 'true', '-allowed': 'true',
            '-appStartType': 'manually', '-userLoginRequired': 'false', '-updateMechanism': 'PLATFORM' }, root.flags)),
    JSON.stringify(custom));
    const copy = fs.readFileSync(root.p('var/opt/mgu-deploy/main.js'), 'utf8');
    check('retired: the fallback copy is rebuilt from the stock main.js',
        copy.includes('/* mgu-deploy provisioning fallback */') && !copy.includes('retired edit'));
    const migrate = root.snapshots().filter((d) => d.endsWith('-migrate') && !snaps0.includes(d));
    const manifest = migrate.length === 1 ? readJson(root.p(`var/opt/mgu-deploy/backups/${migrate[0]}/manifest.json`)) : { entries: [] };
    const stored = (p) => {
        const e = manifest.entries.find((x) => x.path === p && x.kind === 'file');
        return e ? fs.readFileSync(root.p(`var/opt/mgu-deploy/backups/${migrate[0]}/${e.stored}`)) : null;
    };
    check('retired: one migration snapshot, copying the bundles, the backups, base.json and custom_apps.json',
        migrate.length === 1 && pre.main.equals(stored(root.src('main.js')) || Buffer.alloc(0)) &&
        pre.am.equals(stored(root.src('AppManagement/AppManagement.js')) || Buffer.alloc(0)) &&
        stored(root.src('main.js.capbak')) && stored(root.src('main.js.vcbak')) &&
        stored(root.src('AppManagement/AppManagement.js.capbak')) &&
        pre.base.equals(stored(root.p('usr/lib/oap-mainapp/config/base.json')) || Buffer.alloc(0)) &&
        pre.custom.equals(stored(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || Buffer.alloc(0)),
    JSON.stringify(migrate));
    const kills = root.kills().slice(kills0);
    check('retired: two bounces, the migration\'s and the update\'s, spaced', kills.length === 2 &&
        kills[0].at - root.kills()[kills0 - 1].at >= 1000 && kills[1].at - kills[0].at >= 1000, JSON.stringify(root.kills()));
    check('retired: the update itself goes through', readJson(path.join(root.home(13002), 'source/package.json')).version === '1.1.0' &&
        root.managerLog().includes('update old_app 1.1.0 uid 13002'), root.managerLog().join('\n'));
    const st = root.status();
    const tile = (id) => st.components.find((x) => x.id === id) || {};
    check('retired: status lists no leftovers; the fallback lists the old apps, whose tiles stay visible',
        st.retired_leftovers.length === 0 && JSON.stringify(st.fallback.apps) === '["legacy_app","old_app","old_two","store_app"]' &&
        tile('old_app').tile_visible === true && tile('old_two').tile_visible === true, JSON.stringify(st));
    check('retired: an app not marked as ours that only the retired edit listed keeps its tile',
        tile('legacy_app').tile_visible === true && root.visible('legacy_app') && 'legacy_app' in custom &&
        !root.managerLog().some((l) => l.startsWith('hidden')), root.managerLog().join('\n'));
    const kills1 = root.kills().length;
    const pinned = root.hash(notBackups);
    const back = root.run(['restore', migrate[0], '--yes']);
    check('retired: restoring the migration snapshot is refused while the old apps depend on their listing, nothing changed',
        back.status === 2 && back.out.includes('old_app would lose its fallback listing') &&
        root.hash(notBackups).hash === pinned.hash, back.out);
    const snaps1 = root.snapshots();
    const before = root.hash(notBackups);
    const again = root.run(['fallback', 'migrate', '--yes']);
    check('retired: a second run has nothing to migrate: no snapshot, no bounce, nothing changed',
        again.status === 0 && again.out.includes('no leftovers of the retired installer') &&
        root.kills().length === kills1 && JSON.stringify(root.snapshots()) === JSON.stringify(snaps1) &&
        root.hash(notBackups).hash === before.hash, `${again.out}\n${treeDiff(before, root.hash(notBackups))}`);
    const next = root.run(['install', '--artifact', appArtifact('old_two', '1.1.0', true), '--yes']);
    check('retired: the next update has no migration in it', next.status === 0 && !next.out.includes('retired') &&
        root.kills().length === kills1 + 1, next.out);
}

function testRetiredRollback() {
    // a failure after the bounce: app-privacy does not report patched
    const root = retiredRoot();
    const before = root.hash(notBackups);
    const kills0 = root.kills().length;
    const r = root.run(['install', '--artifact', appArtifact('old_app', '1.1.0', true), '--yes'], { FAKE_PRIVACY_STATE: 'unpatched' });
    check('retired rollback: a failed check after the bounce fails the command, exit 1', r.status === 1 &&
        r.out.includes('migration failed') && r.out.includes('back as they were') &&
        r.out.includes('no app was installed, updated or removed'), r.out);
    check('retired rollback: everything is back: bundles, backups, base.json, custom_apps.json, the fallback copy',
        root.hash(notBackups).hash === before.hash, treeDiff(before, root.hash(notBackups)));
    check('retired rollback: the manager bounced once more after the failed bounce, and the update did not run',
        root.kills().length === kills0 + 2 && !root.managerLog().some((l) => l.startsWith('update old_app')),
        JSON.stringify(root.kills()));
    const later = root.run(['install', '--artifact', appArtifact('old_app', '1.1.0', true), '--yes']);
    check('retired rollback: the same boot\'s next install goes ahead without migrating', later.status === 0 &&
        later.out.includes('leftovers stay this boot') && fs.existsSync(root.src('main.js.capbak')) &&
        root.kills().length === kills0 + 3 && root.managerLog().includes('update old_app 1.1.0 uid 13002'), later.out);
    const explicit = root.run(['fallback', 'migrate', '--yes']);
    check('retired rollback: fallback migrate tries again in the same boot', explicit.status === 0 &&
        !fs.existsSync(root.src('main.js.capbak')) && fs.readFileSync(root.src('main.js'), 'utf8') === stockMain() &&
        !('retired_migration_failed' in root.state()), explicit.out);

    // a failure before the bounce: app-privacy's apply on the stock bundles
    const two = retiredRoot();
    const before2 = two.hash(notBackups);
    const k2 = two.kills().length;
    const f = two.run(['fallback', 'migrate', '--yes'], { FAKE_PRIVACY_APPLY_EXIT: '1' });
    check('retired rollback: a failed apply before the bounce: exit 1, everything back, no bounce', f.status === 1 &&
        f.out.includes('back as they were') && two.hash(notBackups).hash === before2.hash && two.kills().length === k2,
    `${f.out}\n${treeDiff(before2, two.hash(notBackups))}`);
}

function testRetiredEdges() {
    const noAm = retiredRoot({ noAmBackup: true });
    const amBefore = fs.readFileSync(noAm.src('AppManagement/AppManagement.js'));
    const m = noAm.run(['fallback', 'migrate', '--yes']);
    check('retired: a bundle with no stock copy beside it stays as it is; main.js is migrated', m.status === 0 &&
        fs.readFileSync(noAm.src('main.js'), 'utf8') === stockMain() &&
        fs.readFileSync(noAm.src('AppManagement/AppManagement.js')).equals(amBefore) &&
        fs.readFileSync(noAm.p('usr/lib/oap-mainapp/config/base.json'), 'utf8') === noAm.stockBase, m.out);

    const bad = retiredRoot({ noAmBackup: true });
    write(bad.src('main.js.capbak'), retiredEdit('old_app,old_two'));
    const kills0 = bad.kills().length;
    const before = bad.hash(notBackups);
    const c = bad.run(['check']);
    const fm = bad.run(['fallback', 'migrate', '--yes']);
    const i = bad.run(['install', '--artifact', appArtifact('old_app', '1.1.0', true), '--yes'],
        { FAKE_MGR_HOOK: '1', MGU_DEPLOY_BOUNCE_MIN_UP_S: '1' });
    check('retired: backups that are not the stock bundle are reported and left; the install goes ahead alone',
        c.out.includes('(not the stock main.js)') && !c.out.includes('migrates them') && fm.status === 0 &&
        fm.out.includes("none of the retired installer's backups is a stock bundle") && i.status === 0 &&
        fs.existsSync(bad.src('main.js.capbak')) && bad.kills().length === kills0 + 1 &&
        !bad.snapshots().some((d) => d.endsWith('-migrate')), `${c.out}\n${i.out}`);
    stopHooked(bad);

    const twice = retiredRoot();
    const base = twice.p('usr/lib/oap-mainapp/config/base.json');
    fs.writeFileSync(base, fs.readFileSync(base, 'utf8').replace('"appManagement": {', '"ignoreSignatureFailure": true,\n  "appManagement": {'));
    const before2 = twice.hash(notBackups);
    const k2 = twice.kills().length;
    const t = twice.run(['fallback', 'migrate', '--yes']);
    check('retired: base.json naming the flag twice refuses the migration, exit 2, nothing changed', t.status === 2 &&
        t.out.includes('ignoreSignatureFailure 2 times') && twice.hash(notBackups).hash === before2.hash && twice.kills().length === k2,
    `${t.out}\n${treeDiff(before2, twice.hash(notBackups))}`);
    const ti = twice.run(['install', '--artifact', appArtifact('old_app', '1.1.0', true), '--yes']);
    check('retired: ... and an install goes ahead without it, saying why', ti.status === 0 &&
        ti.out.includes('ignoreSignatureFailure 2 times') && fs.existsSync(twice.src('main.js.capbak')), ti.out);

    const noPrivacy = retiredRoot();
    const np = noPrivacy.run(['fallback', 'migrate', '--yes'], { MGU_DEPLOY_PRIVACY: noPrivacy.p('var/opt/none/patch_mainapp.js') });
    check('retired: without app-privacy to tell the stock bundles, fallback migrate is refused, exit 2',
        np.status === 2 && np.out.includes('app-privacy, which tells the stock bundles, is not installed') &&
        fs.existsSync(noPrivacy.src('main.js.capbak')), np.out);

    const un = retiredRoot();
    const k3 = un.kills().length;
    const u = un.run(['uninstall', 'old_two', '--yes']);
    check('retired: an uninstall migrates first, then removes the app', u.status === 0 &&
        !fs.existsSync(un.src('main.js.capbak')) && !fs.existsSync(un.entry('old_two')) &&
        JSON.stringify(Object.keys(un.custom()).sort()) === '["legacy_app","old_app","store_app"]' && un.kills().length === k3 + 2, u.out);
}

/* A visible app the migration does not carry (the edit names it in no
 * literal) loses its tile at the bounce: the migration rolls back. */
function testRetiredDrop() {
    const root = retiredRoot({ dropApp: true });
    const notDrop = (rel) => notBackups(rel) || rel === `var/opt/public/oap/oap_${MGR}/data/apps/drop_app.json`;
    const before = root.hash(notDrop);
    const custom = JSON.stringify(root.custom());
    const kills0 = root.kills().length;
    check('retired drop: drop_app is visible before', root.visible('drop_app'));
    const r = root.run(['install', '--artifact', appArtifact('old_app', '1.1.0', true), '--yes']);
    check('retired drop: drop_app losing its tile fails the migration, exit 1', r.status === 1 &&
        r.out.includes("drop_app's tile is hidden") && r.out.includes('back as they were') &&
        root.managerLog().includes('hidden drop_app: listed by nothing'), `${r.out}\n${root.managerLog().join('\n')}`);
    check('retired drop: everything is back, and drop_app\'s tile shows again after the second bounce',
        root.hash(notDrop).hash === before.hash && JSON.stringify(root.custom()) === custom &&
        fs.existsSync(root.src('main.js.capbak')) && root.visible('drop_app') &&
        root.managerLog().includes('shown drop_app') && root.kills().length === kills0 + 2 &&
        !root.managerLog().some((l) => l.startsWith('update old_app')), treeDiff(before, root.hash(notDrop)));
}

/* After a migration, an app it listed that is not ours depends on
 * custom_apps.json alone: restoring a snapshot from before is refused. */
function testRetiredRestoreGuard() {
    const root = retiredRoot({ allUnmarked: true });
    root.run(['fallback', 'on', '--yes']);
    const before = root.snapshots().filter((d) => d.endsWith('-fallback')).pop();
    const m = root.run(['fallback', 'migrate', '--yes']);
    const pinned = root.hash(notBackups);
    const r = root.run(['restore', before, '--yes']);
    check('retired restore: a snapshot from before the migration is refused for the unmarked apps it listed',
        m.status === 0 && r.status === 2 && ['legacy_app', 'old_app', 'old_two'].every((id) => r.out.includes(`${id} would lose its fallback listing`)) &&
        !r.out.includes('store_app') && root.hash(notBackups).hash === pinned.hash, `${m.out}\n${r.out}`);
}

/* A rollback that fails is reported as failed, never as a restore. */
function testRetiredRollbackFails() {
    const root = retiredRoot();
    const r = root.run(['install', '--artifact', appArtifact('old_app', '1.1.0', true), '--yes'],
        { FAKE_PRIVACY_STATE: 'unpatched', FAKE_MGR_STAY_DOWN_AT: String(root.kills().length + 2) });
    const last = r.stderr.trim().split('\n').pop();
    check('retired rollback fails: the last line says the rollback failed too and claims no restore', r.status === 1 &&
        /^mgu-deploy: migration failed \(after the migration: app-privacy reports unpatched\) and its rollback failed too \(app manager node child did not respawn/.test(last) &&
        last.includes('-migrate holds the state before it') && !last.includes('restored') &&
        !r.out.includes('back as they were'), r.out);
    check('retired rollback fails: the failure is kept for this boot', root.state().retired_migration_failed &&
        root.state().retired_migration_failed.error.includes('rollback failed too'), JSON.stringify(root.state()));
}

/* Only AppManagement.js has a stock copy: it goes back; main.js, which
 * the fallback copy is already built from, stays. */
function testRetiredAppManagementOnly() {
    const root = retiredRoot();
    write(root.src('main.js.capbak'), retiredEdit(['old_app']));
    const main = fs.readFileSync(root.src('main.js'));
    const r = root.run(['fallback', 'migrate', '--yes']);
    check('retired: with only AppManagement.js\'s stock copy, it alone is migrated', r.status === 0 &&
        fs.readFileSync(root.src('AppManagement/AppManagement.js'), 'utf8') === AM_STOCK &&
        fs.readFileSync(root.src('main.js')).equals(main) && fs.existsSync(root.src('main.js.capbak')) &&
        !fs.existsSync(root.src('AppManagement/AppManagement.js.capbak')) &&
        fs.readFileSync(root.p('usr/lib/oap-mainapp/config/base.json'), 'utf8') === root.stockBase, r.out);
    const fresh = fakeRoot();
    const n = fresh.run(['fallback', 'migrate', '--yes']);
    check('retired: fallback migrate with nothing to migrate leaves no deploy folder behind',
        n.status === 0 && n.out.includes('no leftovers') && !fs.existsSync(fresh.p('var/opt/mgu-deploy')), n.out);
}

/* ---- source packages and packages built elsewhere -------------------------------------------- */

/* A fake root with the made-up donor among the preinstalled apps. */
function donorRoot(opts) {
    const root = fakeRoot(opts);
    donor.tgz(root.preinstalled('donor_app', '1.0.0'));
    return root;
}

/* A source package (mgu-app.json) of robertn_demo, packed by oap_link.js. */
function sourceArtifact(version, extra, treeFiles) {
    const dir = fs.mkdtempSync(path.join(T, 'srcpkg-'));
    const m = Object.assign({ schema: 1, id: 'robertn_demo', version, tree: `robertn_demo@${version}`,
        modules: ['src/demo.js'], sdk: ['oap-sdk/src/core/OnlineApp.js'] }, extra);
    write(path.join(dir, 'mgu-app.json'), JSON.stringify(m));
    write(path.join(dir, 'src', 'demo.js'), "'use strict';\nconst { OnlineApp } = require('oap-sdk/src/core/OnlineApp.js');\nnew OnlineApp('demo');\n");
    write(path.join(dir, m.tree, 'package.json'), JSON.stringify({ name: m.id, version,
        files: ['javascript', 'package.json'].concat(Object.keys(treeFiles || {})) }));
    write(path.join(dir, m.tree, 'javascript', 'runner.js'), '// runner\n');
    Object.keys(treeFiles || {}).forEach((n) => write(path.join(dir, m.tree, n), treeFiles[n]));
    const file = path.join(fs.mkdtempSync(path.join(T, 'srcart-')), `robertn_demo@${version}.tgz`);
    link.packSource(dir, file);
    return file;
}

/* An OAP package built elsewhere: no marker, require('oap-sdk') without
 * node_modules/oap-sdk; layout 'npm' (members under package/) or 'mgu'. */
function thirdPartyArtifact(id, version, layout, opts) {
    opts = opts || {};
    const prefix = layout === 'mgu' ? 'source/' : 'package/';
    const entries = [
        { name: `${prefix}package.json`, data: Buffer.from(JSON.stringify({ name: id, version, main: 'javascript/app.js' })), mode: 0o644 },
        { name: `${prefix}javascript/app.js`, data: Buffer.from("const { OnlineApp } = require('oap-sdk');\nnew OnlineApp('x');\n"), mode: 0o644 },
        { name: `${prefix}rhmiData/application.json`, data: Buffer.from('{}'), mode: 0o644 }
    ];
    if (layout === 'mgu') {
        entries.push({ name: 'meta.json', data: Buffer.from(JSON.stringify({ id: opts.metaId || id, version, title: id })), mode: 0o644 },
            { name: 'rhmiData/application.json', data: Buffer.from('{}'), mode: 0o644 },
            { name: 'oapgen/gen.js', data: Buffer.from('// theirs\n'), mode: 0o644 });
    }
    const file = path.join(fs.mkdtempSync(path.join(T, 'tp-')), `${id}@${version}.${layout === 'mgu' ? 'mgu' : 'tgz'}`);
    fs.writeFileSync(file, tgz(entries.sort((a, b) => (a.name < b.name ? -1 : 1)), 1700000000));
    return file;
}

function testSourcePackages() {
    const root = donorRoot();
    const file = sourceArtifact('1.2.3', { internet: true });
    const before = root.hash();
    const c = root.run(['check', '--artifact', file]);
    check('source: check builds it on the unit and changes nothing', c.status === 0 &&
        c.out.includes('built robertn_demo 1.2.3 from its source package') && c.out.includes('oap-sdk from donor_app@1.0.0.tgz:javascript/app.js') &&
        c.out.includes('app robertn_demo 1.2.3 ok') && root.hash().hash === before.hash, `${c.out}\n${treeDiff(before, root.hash())}`);
    const r = root.run(['install', '--artifact', file, '--yes']);
    const pkg = root.preinstalled('robertn_demo', '1.2.3');
    const m = fs.existsSync(pkg) ? untarBuf(fs.readFileSync(pkg)) : {};
    check('source: install builds it and installs the result as an app', r.status === 0 &&
        r.out.includes('built robertn_demo 1.2.3') && m['javascript/app.js'] && m['javascript/runner.js'] &&
        JSON.parse(m['package.json']).mguLocalOnly === true && JSON.parse(m['package.json']).mguInternet === true &&
        root.status().components.some((x) => x.id === 'robertn_demo' && x.version === '1.2.3'), r.out);
    const again = root.run(['install', '--artifact', file, '--yes']);
    check('source: the same version again is not built', again.status === 0 && again.out.includes('already installed') &&
        !again.out.includes('built robertn_demo'), again.out);
    const bare = fakeRoot();
    const b0 = bare.hash();
    const nb = bare.run(['install', '--artifact', file, '--yes']);
    check('source: with no donor on the unit, refused (exit 2), nothing changed', nb.status === 2 &&
        nb.out.includes('cannot build robertn_demo 1.2.3 on this unit: no donor holds oap-sdk/src/core/OnlineApp.js') &&
        bare.hash().hash === b0.hash, `${nb.out}\n${treeDiff(b0, bare.hash())}`);
    const bad = rebuild(file, (entries) => tgz(entries.map((e) => (e.name === 'mgu-app.json' ?
        Object.assign({}, e, { data: Buffer.from('{"schema":1,"id":"robertn_demo","version":"1.2"}') }) : e)), 1700000000));
    const nr = donorRoot().run(['install', '--artifact', bad, '--yes']);
    check('source: a bad mgu-app.json is refused, exit 2', nr.status === 2 && nr.out.includes('mgu-app.json: version is not x.y.z'), nr.out);
}

/* Safe mode through an install that installs an app afresh inside it
 * (reinstallApp's own install): every run with work lifts it, only the
 * outermost settles it, and a shortfall anywhere in it keeps it. */
function testSafeModeAfresh() {
    const file = sourceArtifact('1.2.3');
    const on = '{"at": "2026-11-09T10:00:00Z", "reason": "test"}\n';
    const entryFile = (root) => root.p(`var/opt/public/oap/oap_${MGR}/data/apps/robertn_demo.json`);
    const setup = (fresh) => {
        const root = donorRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
        [file, plainArtifact('0.2.0')].forEach((a) => {
            const res = root.run(['install', '--artifact', a, '--yes']);
            if (res.status !== 0) throw new Error(`setup: ${res.out}`);
        });
        // the app waits for its update after a firmware update: an install installs it afresh
        const e = JSON.parse(fs.readFileSync(entryFile(root), 'utf8'));
        e.NO_FORCED_UPDATE_NEEDED = false;
        fs.writeFileSync(entryFile(root), JSON.stringify(e));
        // the tool lacks its unit: the install lays it again from its kept copy
        if (!fresh) fs.unlinkSync(root.p('etc/systemd/system/fixture-tool.service'));
        write(root.p('var/opt/mgu-deploy/safe-mode'), on);
        return root;
    };
    const on_ = (root) => fs.existsSync(root.p('var/opt/mgu-deploy/safe-mode'));
    const lifted = (root) => fs.existsSync(root.p('run/mgu-deploy/safe-mode-lifted'));

    let root = setup();
    let r = root.run(['install', '--artifact', file, '--yes']);
    check('safe mode afresh: a run that lays a tool again and installs an app afresh, all of it through, leaves it',
        r.status === 0 && r.out.includes('laid again from the copy kept here') && r.out.includes('robertn_demo 1.2.3 installed afresh') &&
        !on_(root) && !lifted(root) && root.status().pending_reboot.some((p) => p.id === 'mgu-deploy'), r.out);

    // an app installed afresh, nothing else to do
    root = setup(true);
    r = root.run(['install', '--artifact', file, '--yes']);
    check('safe mode afresh: an install that only installs an app afresh, which goes through, leaves it',
        r.status === 0 && !r.out.includes('laid again') && r.out.includes('robertn_demo 1.2.3 installed afresh') && !on_(root) && !lifted(root), r.out);
    root = setup(true);
    r = root.run(['install', '--artifact', file, '--yes'], { FAKE_MGR_REJECT: '1' });
    check('safe mode afresh: an install that only installs an app afresh, which fails, keeps it',
        r.status === 1 && r.out.includes('installing afresh failed: robertn_demo') && on_(root) && !lifted(root), r.out);

    // an app's Undo update: one install as to safe mode
    const undo = () => {
        const u = fakeRoot();
        u.run(['install', '--artifact', privacyArtifact(), '--yes']);
        u.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
        const up = u.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
        if (up.status !== 0) throw new Error(`setup: ${up.out}`);
        write(u.p('var/opt/mgu-deploy/safe-mode'), on);
        return u;
    };
    root = undo();
    write(root.p('var/opt/mgu-deploy/kept/fixture_app/fixture_app@1.0.0.tgz'), 'not a package\n');
    r = root.run(['rollback', 'fixture_app', '--yes']);
    check('safe mode: an app rollback that fails, the version before installed again, keeps it',
        r.status === 1 && /installing fixture_app 1\.1\.0 again/.test(r.out) && on_(root) && !lifted(root), r.out);
    root = undo();
    r = root.run(['rollback', 'fixture_app', '--yes']);
    check('safe mode: an app rollback that goes through leaves it', r.status === 0 && !on_(root) && !lifted(root), r.out);

    // the tool's first lay fails (its next start runs), the app's install afresh lays it again and goes through
    root = setup();
    const starts = Number(fs.readFileSync(root.unitFile('fixture-tool.service.starts'), 'utf8'));
    fs.writeFileSync(root.unitFile('fixture-tool.service.crash'), `${path.join(root.tool('fixture-tool'), 'current')} versions/0.2.0 ${starts + 1}\n`);
    r = root.run(['install', '--artifact', file, '--yes']);
    check('safe mode afresh: a tool laid again that fails (warned), then is laid again by the app\'s install afresh, which goes through, keeps it',
        r.status === 0 && /fixture-tool 0\.2\.0 is not laid again/.test(r.out) && r.out.includes('robertn_demo 1.2.3 installed afresh') &&
        fs.existsSync(root.p('etc/systemd/system/fixture-tool.service')) && (r.out.match(/is not laid again/g) || []).length === 1 &&
        on_(root) && !lifted(root), r.out);

    root = setup();
    r = root.run(['install', '--artifact', file, '--yes'], { FAKE_MGR_REJECT: '1' });
    check('safe mode afresh: a tool laid again that goes through and an app installed afresh that fails keep it',
        r.status === 1 && r.out.includes('laid again from the copy kept here') && r.out.includes('installing afresh failed: robertn_demo') &&
        on_(root) && !lifted(root), r.out);

    // two apps installed afresh: the first goes through, the second fails
    const two = sourceArtifact('1.0.0', { id: 'robertn_two', tree: 'robertn_two@1.0.0' });
    root = setup();
    r = root.run(['install', '--artifact', two, '--yes']);
    const e2 = JSON.parse(fs.readFileSync(root.p(`var/opt/public/oap/oap_${MGR}/data/apps/robertn_two.json`), 'utf8'));
    e2.NO_FORCED_UPDATE_NEEDED = false;
    fs.writeFileSync(root.p(`var/opt/public/oap/oap_${MGR}/data/apps/robertn_two.json`), JSON.stringify(e2));
    // that install went through: safe mode on again, the tool lacking its unit again
    fs.unlinkSync(root.p('etc/systemd/system/fixture-tool.service'));
    write(root.p('var/opt/mgu-deploy/safe-mode'), on);
    r = root.run(['install', '--artifact', file, '--artifact', two, '--yes'], { FAKE_MGR_REJECT: 'robertn_two' });
    check('safe mode afresh: an app installed afresh that goes through, then one that fails, keep it',
        r.status === 1 && r.out.includes('laid again from the copy kept here') && r.out.includes('robertn_demo 1.2.3 installed afresh') &&
        r.out.includes('installing afresh failed: robertn_two') &&
        on_(root) && !lifted(root), r.out);
}

/* iDrive 7: a current app the app manager marked for an update at its
 * first start after a firmware update ("NO_FORCED_UPDATE_NEEDED": false,
 * which it starts no app with) is installed afresh, its data carried over. */
function testSetUpElsewhere() {
    const file = sourceArtifact('1.2.3');
    const app = (root) => root.status().components.find((x) => x.id === 'robertn_demo') || {};
    const entryFile = (root) => root.p(`var/opt/public/oap/oap_${MGR}/data/apps/robertn_demo.json`);
    const mark = (root) => {
        const e = JSON.parse(fs.readFileSync(entryFile(root), 'utf8'));
        e.NO_FORCED_UPDATE_NEEDED = false;
        fs.writeFileSync(entryFile(root), JSON.stringify(e));
    };
    const dataOf = (root) => { try { return fs.readFileSync(path.join(root.home(app(root).uid), 'data/settings.json'), 'utf8'); } catch (e) { return null; } };
    const WHY = 'the app manager starts it only once it is updated, after a firmware update';
    let root = donorRoot();
    let r = root.run(['install', '--artifact', file, '--yes']);
    write(path.join(root.home(app(root).uid), 'data/settings.json'), '{"theme":"dark"}\n');
    const cacheOf = (root) => path.join(root.home(app(root).uid), 'data/app.js.bytecode');
    check('forced update: a current app the manager starts is not touched, nor built', r.status === 0 && app(root).stale === null &&
        !root.run(['install', '--artifact', file, '--yes']).out.includes('built robertn_demo'), r.out);
    mark(root);
    check('forced update: status says the app does not work and why', app(root).stale === WHY &&
        root.run(['status']).out.includes(`app robertn_demo 1.2.3 uid=${app(root).uid}`) &&
        root.run(['status']).out.includes(`(not working: ${WHY})`), JSON.stringify(app(root)));
    fs.unlinkSync(root.preinstalled('donor_app', '1.0.0'));
    donor.tgz(root.preinstalled('donor_app', '1.1.0'));
    write(cacheOf(root), 'cache of the build for the firmware before');
    r = root.run(['install', '--artifact', file, '--yes']);
    const entry = JSON.parse(fs.readFileSync(entryFile(root), 'utf8'));
    check('forced update: an install installs it afresh, built for this unit, its data carried over, the mark gone',
        r.status === 0 && r.out.includes(`robertn_demo 1.2.3 already installed; ${WHY}: installed afresh after the rest`) &&
        r.out.includes('uninstalling app robertn_demo') && r.out.includes('robertn_demo 1.2.3 installed afresh') &&
        app(root).version === '1.2.3' && app(root).stale === null && !('NO_FORCED_UPDATE_NEEDED' in entry) &&
        dataOf(root) === '{"theme":"dark"}\n' && !fs.existsSync(cacheOf(root)) &&
        untarBuf(fs.readFileSync(root.preinstalled('robertn_demo', '1.2.3')))['javascript/build.json'].includes('donor_app@1.1.0.tgz'), r.out);
    check('forced update: the fresh install keeps its package and leaves no copy behind',
        fs.existsSync(root.p('var/opt/mgu-deploy/kept/robertn_demo/robertn_demo@1.2.3.tgz')) &&
        !fs.readdirSync(root.p('var/opt/mgu-deploy')).some((n) => /\.afresh\./.test(n)));
    r = root.run(['install', '--artifact', file, '--yes']);
    check('forced update: the next install changes nothing', r.status === 0 && r.out.includes('already installed; nothing to change') &&
        !r.out.includes('afresh'), r.out);

    // no app manager running: nothing removed, said
    mark(root);
    const before = app(root).uid;
    fs.writeFileSync(`${root.R}.mgr.pid`, '');
    r = root.run(['install', '--artifact', file, '--yes']);
    check('forced update: with no app manager running the app stays, and the output says an install then installs it afresh',
        r.status === 0 && r.out.includes(`robertn_demo 1.2.3: ${WHY}; an install while the app manager runs installs it afresh`) &&
        app(root).uid === before, r.out);

    // the fresh install fails, and so does the kept package: exit 1, the data folder kept and named
    root = donorRoot();
    root.run(['install', '--artifact', file, '--yes']);
    write(path.join(root.home(app(root).uid), 'data/settings.json'), '{"theme":"dark"}\n');
    mark(root);
    r = root.run(['install', '--artifact', file, '--yes'], { FAKE_MGR_REJECT: '1' });
    const stash = fs.readdirSync(root.p('var/opt/public/oap')).filter((n) => /^\.mgu-deploy-data-robertn_demo-/.test(n));
    check('forced update: a fresh install that fails tries the kept package, exits 1 and keeps the data folder, naming it',
        r.status === 1 && r.out.includes('installing robertn_demo 1.2.3 again') && r.out.includes('installing afresh failed: robertn_demo') &&
        stash.length === 1 && r.out.includes(`robertn_demo's data is kept in`) &&
        fs.readFileSync(root.p(`var/opt/public/oap/${stash[0]}/settings.json`), 'utf8') === '{"theme":"dark"}\n', r.out);
    const folder = root.p(`var/opt/public/oap/${stash[0]}`);
    const recorded = () => ((root.state().data_stash || {}).robertn_demo || []).some((d) => d.path === folder);
    check('forced update: the data folder kept is recorded for the app\'s next install', recorded(), JSON.stringify(root.state().data_stash));
    // the updater's status seconds later, and another changing command: it stays, recorded
    root.status();
    const other = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('forced update: a status as root and another command leave the kept data folder where it is, recorded',
        other.status === 0 && fs.existsSync(path.join(folder, 'settings.json')) && recorded(), `${other.out}\n${JSON.stringify(root.state().data_stash)}`);
    // the app's next install takes it
    r = root.run(['install', '--artifact', file, '--yes']);
    check('forced update: the app\'s next install takes the data folder in, nothing left recorded',
        r.status === 0 && fs.readFileSync(path.join(root.home(app(root).uid), 'data/settings.json'), 'utf8') === '{"theme":"dark"}\n' &&
        !fs.existsSync(folder) && !(root.state().data_stash || {}).robertn_demo, r.out);
}

function testThirdParty() {
    const root = donorRoot();
    const npm = thirdPartyArtifact('warmup', '1.4.3', 'npm');
    const r = root.run(['install', '--artifact', npm, '--yes']);
    const pkg = root.preinstalled('warmup', '1.4.3');
    const m = fs.existsSync(pkg) ? untarBuf(fs.readFileSync(pkg)) : {};
    check('third party: an npm-format package installs flat, marked, with oap-sdk generated from the donor', r.status === 0 &&
        r.out.includes('node_modules/oap-sdk generated from donor_app@1.0.0.tgz:javascript/app.js') &&
        JSON.parse(m['package.json'] || '{}').mguLocalOnly === true && m['node_modules/oap-sdk/index.js'] &&
        !Object.keys(m).some((k) => k.indexOf('package/') === 0) &&
        root.status().components.some((x) => x.id === 'warmup' && x.version === '1.4.3'), r.out);
    const mgu = thirdPartyArtifact('gforce', '2.0.0', 'mgu');
    const r2 = root.run(['install', '--artifact', mgu, '--yes']);
    const m2 = untarBuf(fs.readFileSync(root.preinstalled('gforce', '2.0.0')));
    check('third party: a .mgu installs its source/ as the package', r2.status === 0 && m2['javascript/app.js'] &&
        m2['rhmiData/application.json'] && !m2['meta.json'] && !m2['oapgen/gen.js'] && m2['node_modules/oap-sdk/index.js'], r2.out);
    const plain = appArtifact('plain_app', '1.0.0', false);
    const r3 = root.run(['install', '--artifact', plain, '--yes']);
    check('third party: an unmarked flat package is marked and installed', r3.status === 0 && r3.out.includes('marked local-only') &&
        JSON.parse(untarBuf(fs.readFileSync(root.preinstalled('plain_app', '1.0.0')))['package.json']).mguLocalOnly === true, r3.out);
    const dotDir = fs.mkdtempSync(path.join(T, 'dot-'));
    const dotTree = path.join(dotDir, 'tree');
    fs.mkdirSync(dotTree);
    cp.execFileSync('tar', ['-xzf', appArtifact('dot_app', '1.0.0', false), '-C', dotTree]);
    const dot = path.join(dotDir, 'dot_app@1.0.0.tgz');
    cp.execFileSync('tar', ['-czf', dot, '-C', dotTree, '.']);
    const r5 = root.run(['install', '--artifact', dot, '--yes']);
    check('third party: one packed with tar -C <dir> . (members under ./) installs', tarList(dot).indexOf('./') >= 0 && r5.status === 0 &&
        root.status().components.some((x) => x.id === 'dot_app' && x.version === '1.0.0'), r5.out);
    const ours = appArtifact('ours_app', '1.0.0', true);
    const r4 = root.run(['install', '--artifact', ours, '--yes']);
    check('third party: one of ours installs byte for byte', r4.status === 0 && !r4.out.includes('prepared') &&
        fs.readFileSync(root.preinstalled('ours_app', '1.0.0')).equals(fs.readFileSync(ours)), r4.out);
    const bare = fakeRoot();
    const b0 = bare.hash();
    const nb = bare.run(['install', '--artifact', npm, '--yes']);
    check('third party: needing oap-sdk with no donor on the unit is refused, nothing changed', nb.status === 2 &&
        nb.out.includes('cannot prepare warmup 1.4.3 on this unit: no donor holds the oap-sdk core') &&
        bare.hash().hash === b0.hash, nb.out);
    const mis = donorRoot().run(['install', '--artifact', thirdPartyArtifact('gforce', '2.0.0', 'mgu', { metaId: 'other' }), '--yes']);
    check('third party: a .mgu whose meta.json names another app is refused', mis.status === 2 && mis.out.includes('meta.json names other 2.0.0'), mis.out);
}

/* A tool artifact built from the fixture tool under another id. */
function namedTool(id, version, edit) {
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    const r = hu(['artifact', fixtureCopy(version, (c) => {
        c.id = id;
        c.units = [];
        c.enable = [];
        c.recmgr = [];
        c.restart = [];
        if (edit) {
            edit(c);
        }
    }), '--out', out]);
    if (r.status !== 0) {
        throw new Error(r.stderr);
    }
    return path.join(out, `${id}@${version}.tgz`);
}

/* Every installed tool's .service units get the limits drop-in (no core
 * dump, a start limit): written by an install, removed by an uninstall,
 * brought in line by status for tools installed before it and for a unit
 * no tool lists; stock units and other drop-ins are left alone; a service its
 * start limit stopped starts again with an install; iDrive 7 and 8. */
function testServiceLimits() {
    const LIMITS = '# Written by mgu-deploy for every service a tool installs: a crash leaves no core dump for the\n' +
        '# crash handler, which would restart the head unit, a service that keeps failing stops, and\n' +
        '# it does not start in safe mode.\n' +
        '[Unit]\nStartLimitIntervalSec=600\nStartLimitBurst=20\n' +
        'ConditionPathExists=|!/var/opt/mgu-deploy/safe-mode\nConditionPathExists=|/run/mgu-deploy/safe-mode-lifted\nConditionPathExists=|!/var/opt/mgu-deploy/current/safe_mode.sh\n\n[Service]\nLimitCORE=1\n';
    const SOCKET = '# Written by mgu-deploy for every unit a tool installs: it does not start in safe mode.\n' +
        '[Unit]\nConditionPathExists=|!/var/opt/mgu-deploy/safe-mode\nConditionPathExists=|/run/mgu-deploy/safe-mode-lifted\nConditionPathExists=|!/var/opt/mgu-deploy/current/safe_mode.sh\n';
    const sys = (root, rel) => root.p(`etc/systemd/system/${rel}`);
    const dropIn = (root, unit) => sys(root, `${unit}.d/zz-mgu-deploy-limits.conf`);
    const limitsState = (res) => { try { return JSON.parse(res.stdout).service_limits; } catch (e) { return null; } };
    const backups = (root) => fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).length;

    const root = fakeRoot({ recmgr: ['fixture-tool'] });
    let r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('limits: a fresh tool install gives its service the drop-in, its socket the safe mode condition, and reloads systemd',
        r.status === 0 && fs.readFileSync(dropIn(root, 'fixture-tool.service'), 'utf8') === LIMITS &&
        mode(dropIn(root, 'fixture-tool.service')) === 0o644 && fs.readFileSync(dropIn(root, 'fixture-tool.socket'), 'utf8') === SOCKET &&
        root.systemctlCalls().includes('daemon-reload'), r.out);
    check('limits: a stock unit gets none', !fs.existsSync(sys(root, 'stock.service.d')));
    const snap = fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).filter((n) => /-install$/.test(n)).sort().pop();
    const manifest = readJson(root.p(`var/opt/mgu-deploy/backups/${snap}/manifest.json`));
    check('limits: the drop-in is in the install\'s snapshot (absent before it)', manifest.entries.some((e) =>
        e.path === dropIn(root, 'fixture-tool.service') && e.kind === 'absent'), JSON.stringify(manifest.entries.map((e) => e.path)));
    r = root.run(['status', '--json']);
    check('limits: status after an install says up to date and changes nothing',
        r.status === 0 && JSON.stringify(limitsState(r)) === JSON.stringify({ state: 'ok', reason: 'up to date' }) && !r.stderr, r.out);
    r = root.run(['status']);
    check('limits: plain status prints the step\'s result', r.status === 0 && r.stdout.includes('service limits: ok (up to date)'), r.out);

    // a tool installed before this deploy tool: no drop-in
    fs.rmSync(sys(root, 'fixture-tool.service.d'), { recursive: true });
    write(sys(root, 'fixture-tool.service.d/10-own.conf'), '[Service]\nNice=5\n');
    // a drop-in of this name for a unit no tool lists, alone in its folder and beside another
    write(sys(root, 'gone.service.d/zz-mgu-deploy-limits.conf'), LIMITS);
    write(sys(root, 'stock.service.d/zz-mgu-deploy-limits.conf'), LIMITS);
    write(sys(root, 'stock.service.d/vendor.conf'), '[Service]\nNice=1\n');
    const before = backups(root);
    fs.writeFileSync(root.log, '');
    r = root.run(['status', '--json']);
    const calls = root.systemctlCalls();
    check('limits: status gives an installed tool\'s service the drop-in, beside its own, and removes the others\'',
        r.status === 0 && limitsState(r).state === 'changed' &&
        fs.readFileSync(dropIn(root, 'fixture-tool.service'), 'utf8') === LIMITS &&
        fs.readFileSync(sys(root, 'fixture-tool.service.d/10-own.conf'), 'utf8') === '[Service]\nNice=5\n' &&
        !fs.existsSync(sys(root, 'gone.service.d')) && !fs.existsSync(dropIn(root, 'stock.service')) &&
        fs.existsSync(sys(root, 'stock.service.d/vendor.conf')) && backups(root) === before + 1 &&
        /^service limits: drop-in /.test(r.stderr), r.out);
    check('limits: status reloads systemd and restarts nothing', calls.includes('daemon-reload') &&
        !calls.some((c) => /^(start|restart|stop) /.test(c)), calls.join('\n'));
    r = root.run(['status', '--json']);
    check('limits: status again changes nothing', r.status === 0 && limitsState(r).state === 'ok' && backups(root) === before + 1, r.out);
    // another run holds the lock: pending, nothing written
    fs.unlinkSync(dropIn(root, 'fixture-tool.service'));
    write(root.p('var/opt/mgu-deploy/lock'), `1 ${fs.readFileSync(root.p('proc/boot_id'), 'utf8').trim()}\n`);
    r = root.run(['status', '--json']);
    check('limits: status waits while another run holds the lock',
        r.status === 0 && limitsState(r).state === 'pending' && !fs.existsSync(dropIn(root, 'fixture-tool.service')), r.out);
    fs.unlinkSync(root.p('var/opt/mgu-deploy/lock'));

    // an update writes it again; a socket-activated service its start limit stopped is reset before its socket starts
    write(path.join(`${root.R}.units`, 'fixture-tool.service.active'), 'failed\n');
    write(path.join(`${root.R}.units`, 'fixture-tool.service.result'), 'start-limit-hit\n');
    write(path.join(`${root.R}.units`, 'fixture-tool.socket.active'), 'failed\n');
    fs.writeFileSync(root.log, '');
    r = root.run(['install', '--artifact', toolArtifact('0.2.1'), '--yes']);
    let upd = root.systemctlCalls();
    check('limits: an update writes the drop-in, resets the service its start limit stopped and starts its socket',
        r.status === 0 && fs.readFileSync(dropIn(root, 'fixture-tool.service'), 'utf8') === LIMITS &&
        upd.includes('reset-failed fixture-tool.service') && upd.includes('start fixture-tool.socket') &&
        upd.indexOf('reset-failed fixture-tool.service') < upd.indexOf('start fixture-tool.socket') &&
        !upd.includes('start fixture-tool.service'), r.out + upd.join('\n'));
    // a service started without a socket
    const plain = (version) => {
        const out = fs.mkdtempSync(path.join(T, 'art-'));
        const res = hu(['artifact', fixtureCopy(version, (c) => {
            c.units = c.units.filter((u) => /\.service$/.test(u.name));
            c.enable = [{ unit: 'fixture-tool.service', target: 'multi-user.target' }];
        }), '--out', out]);
        if (res.status !== 0) throw new Error(res.stderr);
        return path.join(out, `fixture-tool@${version}.tgz`);
    };
    write(path.join(`${root.R}.units`, 'fixture-tool.service.active'), 'failed\n');
    fs.writeFileSync(root.log, '');
    r = root.run(['install', '--artifact', plain('0.3.0'), '--yes']);
    upd = root.systemctlCalls();
    check('limits: an update starts the service its start limit stopped, reset first',
        r.status === 0 && upd.includes('reset-failed fixture-tool.service') && upd.includes('start fixture-tool.service') &&
        upd.indexOf('reset-failed fixture-tool.service') < upd.indexOf('start fixture-tool.service'), r.out + upd.join('\n'));
    // a rollback brings back a socket-activated service its start limit stopped, through its socket
    const rb = fakeRoot({ recmgr: ['fixture-tool'] });
    rb.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    rb.run(['install', '--artifact', toolArtifact('0.2.1'), '--yes']);
    write(path.join(`${rb.R}.units`, 'fixture-tool.service.active'), 'failed\n');
    write(path.join(`${rb.R}.units`, 'fixture-tool.service.result'), 'start-limit-hit\n');
    write(path.join(`${rb.R}.units`, 'fixture-tool.socket.active'), 'failed\n');
    fs.writeFileSync(rb.log, '');
    r = rb.run(['rollback', 'fixture-tool', '--yes']);
    const rbCalls = rb.systemctlCalls();
    check('limits: a rollback resets the socket-activated service its start limit stopped and starts its socket',
        r.status === 0 && rbCalls.includes('reset-failed fixture-tool.service fixture-tool.socket') &&
        rbCalls.indexOf('reset-failed fixture-tool.service fixture-tool.socket') < rbCalls.indexOf('start fixture-tool.socket'),
        r.out + rbCalls.join('\n'));
    // systemd 237 keeps the crash's Result when the start limit ends its automatic restarts
    write(path.join(`${root.R}.units`, 'fixture-tool.service.active'), 'failed\n');
    write(path.join(`${root.R}.units`, 'fixture-tool.service.result'), 'signal\n');
    write(path.join(`${root.R}.units`, 'fixture-tool.service.nrestarts'), '20\n');
    fs.writeFileSync(root.log, '');
    r = root.run(['install', '--artifact', plain('0.3.2'), '--yes']);
    check('limits: an update starts a service that failed after 19 or more automatic restarts (Result=signal)',
        r.status === 0 && root.systemctlCalls().includes('reset-failed fixture-tool.service') &&
        root.systemctlCalls().includes('start fixture-tool.service'), r.out);
    fs.unlinkSync(path.join(`${root.R}.units`, 'fixture-tool.service.nrestarts'));
    // a stopped service that failed for another reason stays as it is
    write(path.join(`${root.R}.units`, 'fixture-tool.service.active'), 'failed\n');
    write(path.join(`${root.R}.units`, 'fixture-tool.service.result'), 'exit-code\n');
    fs.writeFileSync(root.log, '');
    r = root.run(['install', '--artifact', plain('0.3.3'), '--yes']);
    check('limits: an update does not start a service that failed otherwise',
        r.status === 0 && !root.systemctlCalls().includes('start fixture-tool.service'), r.out);

    // the uninstall takes the drop-in out; the folder stays while the tool's other file is in it
    r = root.run(['uninstall', 'fixture-tool', '--yes']);
    check('limits: uninstall removes the drop-in, and keeps a folder that holds something else',
        r.status === 0 && !fs.existsSync(dropIn(root, 'fixture-tool.service')) &&
        fs.existsSync(sys(root, 'fixture-tool.service.d/10-own.conf')), r.out);
    const clean = fakeRoot({ recmgr: ['fixture-tool'] });
    const h0 = clean.hash();
    clean.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    r = clean.run(['uninstall', 'fixture-tool', '--yes']);
    // the deploy tool's safe mode guard stays with the deploy tool
    const guardRel = (rel) => /mgu-deploy-safe-mode|^etc\/systemd\/system\/var-opt-ro\.service\.d/.test(rel);
    check('limits: uninstall removes the drop-in with its folder',
        r.status === 0 && !fs.existsSync(sys(clean, 'fixture-tool.service.d')) &&
        !treeDiff(h0, clean.hash((rel) => rel.startsWith('var/opt/mgu-deploy') || rel.startsWith('var/opt/public') || guardRel(rel))).split('\n')
            .some((l) => /etc\/systemd/.test(l)), r.out);

    // a restore to the snapshot before the install takes the drop-in out with the tool
    const rs = fakeRoot({ recmgr: ['fixture-tool'] });
    rs.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const pre = fs.readdirSync(rs.p('var/opt/mgu-deploy/backups')).filter((n) => /-install$/.test(n)).sort().pop();
    r = rs.run(['restore', pre, '--yes']);
    check('limits: restoring the snapshot before an install removes the drop-in with the tool',
        r.status === 0 && !fs.existsSync(rs.p('var/opt/fixture-tool')) && !fs.existsSync(dropIn(rs, 'fixture-tool.service')), r.out);
    // a restore of a snapshot taken before the drop-ins existed (an older deploy tool's) leaves the installed tool its drop-in
    rs.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const older = rs.p('var/opt/mgu-deploy/backups/00000000T000000000Z-older');
    write(path.join(older, 'manifest.json'), JSON.stringify({ command: 'older', created: new Date().toISOString(), entries: [] }) + '\n');
    fs.rmSync(sys(rs, 'fixture-tool.service.d'), { recursive: true });
    r = rs.run(['restore', '00000000T000000000Z-older', '--yes']);
    check('limits: a restore gives the installed tools\' services their drop-in',
        r.status === 0 && fs.readFileSync(dropIn(rs, 'fixture-tool.service'), 'utf8') === LIMITS, r.out);

    // iDrive 8, with recmgr's list and without
    [false, true].forEach((noRecmgr) => {
        const r8 = id8Root({ recmgr: ['fixture-tool'], noRecmgr });
        const res = r8.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
        const listText = noRecmgr ? null : fs.readFileSync(r8.p('etc/recmgr-restartlist.conf'), 'utf8');
        check(`limits: iDrive 8${noRecmgr ? ' without recmgr\'s list' : ''}: the install writes the drop-in` +
            (noRecmgr ? '' : ' and keeps the tool in recmgr\'s list'),
            res.status === 0 && fs.readFileSync(dropIn(r8, 'fixture-tool.service'), 'utf8') === LIMITS &&
            (noRecmgr || /\[Whitelist\]\nstockd\nfixture-tool\n/.test(listText)), res.out + listText);
        const un = r8.run(['uninstall', 'fixture-tool', '--yes']);
        check(`limits: iDrive 8${noRecmgr ? ' without recmgr\'s list' : ''}: uninstall removes it`,
            un.status === 0 && !fs.existsSync(sys(r8, 'fixture-tool.service.d')), un.out);
    });
}

/* Safe mode (deploy/README.md, "Safe mode"): safe_mode.sh's count of
 * failed starts against made-up restart records and uptimes, on the sh the
 * tests run under; then the deploy tool: the drop-in's condition for a
 * tool's units and none for one that runs in safe mode, the guard laid by
 * an install and by status, safe_mode in status --json, the boot check
 * waiting, leaving safe mode (safe-mode off, an install that goes through,
 * not a refused or failed one) and remove-all taking the guard out. */
function testSafeMode() {
    const SCRIPT = path.join(DEPLOY, 'unit', 'safe_mode.sh');
    const G = fs.mkdtempSync(path.join(T, 'guard-'));
    const gp = (rel) => path.join(G, rel);
    fs.mkdirSync(gp('var/opt/mgu-deploy'), { recursive: true });
    const now = () => Math.floor(Date.now() / 1000);
    // sqlite3 stands in for recmgr's crash statistics: its last crash key, from a file
    write(gp('bin/sqlite3'), `#!/bin/sh\n[ -f '${gp('crash-key')}' ] || exit 1\necho 500\ncat '${gp('crash-key')}'\n`, 0o755);
    write(gp('var/opt/public/sin/recmgr/recmgr_stats.db'), 'stats\n');
    const crashKey = (k) => (k === null ? fs.rmSync(gp('crash-key'), { force: true }) : write(gp('crash-key'), `${k}\n`));
    crashKey(5);
    const env = { PATH: `${gp('bin')}:${process.env.PATH}`, MGU_DEPLOY_VAR_OPT: gp('var/opt'), MGU_DEPLOY_BOOT_ID: gp('proc/boot_id'),
        MGU_DEPLOY_PROC: gp('proc'), MGU_DEPLOY_PROC_STAT: gp('proc/stat') };
    const guard = (cmd) => cp.spawnSync('sh', [SCRIPT, cmd], { encoding: 'utf8', env, timeout: 15000 });
    // the up step while the uptime moves on: the shell commands in bg run beside it
    const upWhile = (bg) => cp.spawnSync('sh', ['-c', `( ${bg} ) >/dev/null 2>&1 & exec sh '${SCRIPT}' up`],
        { encoding: 'utf8', env, timeout: 30000 });
    const setUp = (secs) => `echo '${secs}.42 77.00' > '${gp('proc/uptime')}'`;
    const up = (s) => write(gp('proc/uptime'), `${s}.42 77.00\n`);
    let n8 = 0;
    // a start of the head unit: a new boot id and btime; recmgr and crashhandler delete their records
    const start = () => {
        n8 += 1;
        write(gp('proc/boot_id'), `${String(n8).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd\n`);
        write(gp('proc/stat'), `cpu 0 0 0 0\nbtime ${now() - 20}\n`);
        ['recmgr', 'crashhandler'].forEach((m) => fs.rmSync(gp(`var/opt/public/sin/${m}/restartInfo.xml`), { force: true }));
        up(20);
    };
    const bootNow = () => fs.readFileSync(gp('proc/boot_id'), 'utf8').trim();
    const record = (m, at) => {
        const f = gp(`var/opt/public/sin/${m}/restartInfo.xml`);
        write(f, '<restartInfo/>\n');
        fs.utimesSync(f, at, at);
    };
    const flag = gp('var/opt/mgu-deploy/safe-mode');
    const countFile = gp('var/opt/mgu-deploy/safe-mode-count');
    // the failed starts in a row, the last mark's start included
    const count = () => (fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8').trim().split(' ')[2] : null);
    // how this start ends; the next start's boot step
    const crashAt = (s, m) => { up(s); record(m || 'recmgr', now()); guard('mark'); };
    const endAt = (s) => { up(s); guard('mark'); };
    const next = () => { start(); return guard('boot'); };

    start();
    let r = guard('boot');
    check('safe mode: the boot step records recmgr\'s crash key and nothing else', r.status === 0 &&
        fs.readFileSync(gp('var/opt/mgu-deploy/safe-mode-crashes'), 'utf8') === `${bootNow()} 5\n` &&
        !fs.existsSync(countFile) && !fs.existsSync(flag), r.stdout + r.stderr);
    let t0 = Date.now();
    crashAt(60);
    check('safe mode: the shutdown mark records a restart recmgr asked for, with the uptime, and reads the statistics at once',
        fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8') === `${bootNow()} crash 60 recmgr\n` && Date.now() - t0 < 1500,
    `${Date.now() - t0} ms`);
    check('safe mode: a restart after a crash within 2 minutes counts at the shutdown', count() === '1' &&
        fs.readFileSync(countFile, 'utf8') === `0 ${bootNow()} 1\n`);
    crashAt(70);
    check('safe mode: the mark run again in the same start counts it once', count() === '1');
    next();
    crashAt(150, 'crashhandler');
    check('safe mode: a crash restart after 2 minutes neither counts nor clears', count() === '1');
    next();
    crashAt(30);
    next();
    endAt(150);
    check('safe mode: a switch-off or a restart the HMI or the Store asked for (a shutdown without a restart record) clears the count',
        count() === '0');
    next();
    crashAt(30);
    next();
    endAt(25);
    check('safe mode: such a shutdown within 2 minutes (a short drive, or a restart whose records were lost) neither counts nor clears',
        count() === '1');
    next();
    endAt(40);
    check('safe mode: nor does a second', count() === '1');
    next();
    // recmgr's startup deletes its restartInfo.xml, also one of the same start: its crash statistics still tell
    crashKey(9);
    fs.utimesSync(gp('var/opt/public/sin/recmgr/recmgr_stats.db'), now(), now());
    endAt(12);
    check('safe mode: a row recmgr added to its crash statistics in this start marks a crash restart, and counts',
        fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8') === `${bootNow()} crash 12 recmgr_stats\n` && count() === '2');
    next();
    crashKey(10);
    fs.utimesSync(gp('var/opt/public/sin/recmgr/recmgr_stats.db'), now() - 120, now() - 120);
    endAt(60);
    check('safe mode: a row whose statistics were written over a minute before the shutdown is no record of it', count() === '2' &&
        /normal 60$/.test(fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8').trim()));
    fs.utimesSync(gp('var/opt/public/sin/recmgr/recmgr_stats.db'), now(), now());
    next();
    endAt(60);
    check('safe mode: statistics that did not grow in the start: no crash', count() === '2' &&
        /normal 60$/.test(fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8').trim()));
    crashKey(null);
    next();
    crashKey(12);
    fs.utimesSync(gp('var/opt/public/sin/recmgr/recmgr_stats.db'), now(), now());
    endAt(60);
    check('safe mode: no statistics at the boot step: no baseline, nothing taken from them', count() === '2' &&
        /normal 60$/.test(fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8').trim()));
    next();
    write(gp('crash-key'), 'database is locked\n');
    endAt(60);
    check('safe mode: statistics that do not read as a key: no crash', count() === '2');
    crashKey(12);
    next();
    // a power cut: no shutdown mark for this start
    next();
    check('safe mode: a start with no shutdown mark (power cut) neither counts nor clears', count() === '2');
    write(gp('var/opt/mgu-deploy/restart-requested'), `${bootNow()}\n`);
    crashAt(20);
    check('safe mode: a restart our tools asked for (restart-requested names the start) does not count, and clears', count() === '0');
    next();
    crashAt(30);
    next();
    crashAt(400);
    check('safe mode: a crash restart after 5 minutes clears it', count() === '0');
    next();
    // four in a row: decided at the fourth's shutdown, so the next start is in safe mode
    [['recmgr', 30], ['crashhandler', 45], ['recmgr', 90]].forEach(([m, s]) => { crashAt(s, m); next(); });
    check('safe mode: three in a row: no safe mode', count() === '3' && !fs.existsSync(flag));
    crashAt(15);
    let f = null;
    try { f = JSON.parse(fs.readFileSync(flag, 'utf8')); } catch (e) { /* checked below */ }
    check('safe mode: the fourth in a row turns it on at its shutdown: the flag with the time and the reason, the count from zero',
        f && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(f.at) && /^4 failed starts in a row, each within 120 s$/.test(f.reason) &&
        count() === '0', JSON.stringify(f));
    crashAt(16);
    check('safe mode: a second mark of that start keeps it as it is', count() === '0' && fs.existsSync(flag));
    r = next();
    check('safe mode: the next start\'s boot step says so', /safe mode: on/.test(r.stdout), r.stdout);
    const flagBytes = fs.readFileSync(flag);
    [1, 2, 3, 4].forEach(() => { crashAt(10); next(); });
    check('safe mode: once on, the flag stays as it was written', fs.readFileSync(flag).equals(flagBytes));
    fs.unlinkSync(flag);
    next();
    // a start up 5 minutes clears the count (the guard's second step)
    crashAt(30);
    next();
    crashAt(30);
    next();
    up(299);
    t0 = Date.now();
    r = upWhile(`sleep 1; ${setUp(300)}`);
    check('safe mode: a start that stays up 5 minutes clears the count, waiting until its uptime says so', r.status === 0 && count() === '0' &&
        Date.now() - t0 >= 900 && /up 300 s/.test(r.stdout), r.stdout + r.stderr);
    crashAt(30);
    check('safe mode: and a crash at its shutdown after it starts the count at one', count() === '1');
    next();

    // starts that leave no shutdown mark: power cuts, resets that skip var-opt-ro.service, var-opt-ro.service failing before the mark
    for (let i = 0; i < 9; i += 1) next();
    check('safe mode: starts without a shutdown mark count nothing, however many in a row', count() === '1' && !fs.existsSync(flag));
    crashAt(30);
    check('safe mode: and the count goes on from the last marked start', count() === '2');
    next();
    endAt(150);
    next();

    // corrupt or missing files never turn safe mode on
    write(countFile, `0 x 9\n`);
    crashAt(30);
    check('safe mode: a count at or above the threshold reads as no count: this start counts one', count() === '1' && !fs.existsSync(flag));
    next();
    write(countFile, '3\n');
    crashAt(30);
    check('safe mode: a count without its start reads as none', count() === '1' && !fs.existsSync(flag));
    next();
    write(countFile, 'garbage words here\n');
    crashAt(30);
    check('safe mode: a count that does not read as written reads as none', count() === '1' && !fs.existsSync(flag));
    next();
    fs.unlinkSync(countFile);
    crashAt(30);
    check('safe mode: no count file: this start counts one', count() === '1' && !fs.existsSync(flag));
    next();
    write(countFile, `0 x 3\n`);
    up(30);
    record('recmgr', now() - 3600);
    guard('mark');
    check('safe mode: a restart record from before this start is not this start\'s', /normal 30$/.test(fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8').trim()));
    record('recmgr', now() + 120);
    guard('mark');
    check('safe mode: nor one from after now', /normal 30$/.test(fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8').trim()));
    check('safe mode: so that start counts nothing', count() === '3' && !fs.existsSync(flag));
    next();
    fs.writeFileSync(gp('proc/uptime'), 'x\n');
    record('recmgr', now());
    const countBefore = fs.readFileSync(countFile, 'utf8');
    r = guard('mark');
    check('safe mode: no mark and no count without the uptime', r.status === 0 && fs.readFileSync(countFile, 'utf8') === countBefore);
    fs.writeFileSync(gp('proc/boot_id'), '');
    up(30);
    r = guard('mark');
    check('safe mode: no boot id: nothing written, exit 0', r.status === 0 && fs.readFileSync(countFile, 'utf8') === countBefore && !fs.existsSync(flag));
    const bare = fs.mkdtempSync(path.join(T, 'bare-'));
    r = cp.spawnSync('sh', [SCRIPT, 'mark'], { encoding: 'utf8', env: Object.assign({}, env, { MGU_DEPLOY_VAR_OPT: bare }) });
    check('safe mode: without the deploy tool\'s folder it writes nothing', r.status === 0 && fs.readdirSync(bare).length === 0);
    check('safe mode: the script leaves no temporary file', fs.readdirSync(gp('var/opt/mgu-deploy')).every((n) => !/\.tmp$|^\.crash-key/.test(n)),
        fs.readdirSync(gp('var/opt/mgu-deploy')).join(' '));
    // a statistics read that hangs is given up after 2 s
    start();
    write(gp('bin/sqlite3'), '#!/bin/sh\nexec sleep 30\n', 0o755);
    t0 = Date.now();
    r = guard('boot');
    check('safe mode: a statistics read that does not answer is given up after 2 s, no baseline', r.status === 0 &&
        Date.now() - t0 < 6000 && !fs.existsSync(gp('var/opt/mgu-deploy/safe-mode-crashes')), `${Date.now() - t0} ms`);
    // a shutdown cut during that read: the mark so far is on disk, the count as it was
    write(gp('var/opt/mgu-deploy/safe-mode-crashes'), `${bootNow()} 5\n`);
    const countWas = fs.readFileSync(countFile, 'utf8');
    up(30);
    record('recmgr', now());
    cp.spawnSync('sh', [SCRIPT, 'mark'], { env, timeout: 1000, killSignal: 'SIGKILL', stdio: 'ignore' });
    check('safe mode: a shutdown cut during the statistics read leaves the start marked, with the records read before it, the count as it was',
        fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8') === `${bootNow()} crash 30 recmgr\n` &&
        fs.readFileSync(countFile, 'utf8') === countWas, fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8'));
    fs.rmSync(gp('var/opt/public/sin/recmgr/restartInfo.xml'), { force: true });
    up(30);
    cp.spawnSync('sh', [SCRIPT, 'mark'], { env, timeout: 1000, killSignal: 'SIGKILL', stdio: 'ignore' });
    check('safe mode: and without records the start is marked normal before that read, the count as it was',
        fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8') === `${bootNow()} normal 30\n` &&
        fs.readFileSync(countFile, 'utf8') === countWas, fs.readFileSync(gp('var/opt/mgu-deploy/last-shutdown'), 'utf8'));

    // ---- the deploy tool ----
    const sys = (root, rel) => root.p(`etc/systemd/system/${rel}`);
    const dropIn = (root, unit) => fs.readFileSync(sys(root, `${unit}.d/zz-mgu-deploy-limits.conf`), 'utf8');
    const COND = 'ConditionPathExists=|!/var/opt/mgu-deploy/safe-mode\nConditionPathExists=|/run/mgu-deploy/safe-mode-lifted\nConditionPathExists=|!/var/opt/mgu-deploy/current/safe_mode.sh\n';
    const out = fs.mkdtempSync(path.join(T, 'safe-'));
    const kit = (version) => {
        const res = hu(['artifact', fixtureCopy(version, (x) => {
            x.units.push({ name: 'fixture-tool-boot.service', from: 'systemd/fixture-tool.service', runsInSafeMode: true });
        }), '--out', out]);
        if (res.status !== 0) throw new Error(res.stderr);
        return path.join(out, `fixture-tool@${version}.tgz`);
    };
    const manifest = JSON.parse(untar(kit('0.2.0'))['component.json'].data);
    check('safe mode: the kit carries runsInSafeMode for its unit only', JSON.stringify(manifest.units) === JSON.stringify([
        { name: 'fixture-tool.socket' }, { name: 'fixture-tool.service' }, { name: 'fixture-tool-boot.service', runsInSafeMode: true }]),
    JSON.stringify(manifest.units));
    const root = fakeRoot({ recmgr: ['fixture-tool'] });
    r = root.run(['install', '--artifact', kit('0.2.0'), '--yes']);
    check('safe mode: no guard on a unit without the firmware\'s var-opt-ro.service (no start would be marked)',
        r.status === 0 && !fs.existsSync(sys(root, 'mgu-deploy-safe-mode.service')) && !fs.existsSync(sys(root, 'var-opt-ro.service.d')), r.out);
    write(root.p('lib/systemd/system/var-opt-ro.service'), '[Service]\nType=oneshot\nExecStart=/bin/mount -o remount,ro /var/opt\n');
    r = root.run(['install', '--artifact', kit('0.2.0'), '--yes']);
    const svc = dropIn(root, 'fixture-tool.service');
    check('safe mode: a tool\'s service: its limits, off in safe mode',
        r.status === 0 && svc.includes('StartLimitBurst=20') && svc.includes('LimitCORE=1') && svc.includes(COND), r.out + svc);
    const sock = dropIn(root, 'fixture-tool.socket');
    check('safe mode: its socket: off in safe mode, nothing else', sock.includes(COND) && !/\[Service\]|StartLimit/.test(sock), sock);
    const dropIns = fs.readdirSync(sys(root, '')).filter((n) => /\.d$/.test(n) && fs.existsSync(sys(root, `${n}/zz-mgu-deploy-limits.conf`)));
    check('safe mode: no tool unit\'s drop-in orders on the guard or wants it (nothing waits for it at boot)', dropIns.length === 3 &&
        dropIns.every((n) => !/mgu-deploy-safe-mode|^(Wants|After|Before|Requires|BindsTo)=/m.test(dropIn(root, n.slice(0, -2)))),
    dropIns.join(' '));
    const guardUnit = fs.readFileSync(path.join(DEPLOY, 'unit', 'mgu-deploy-safe-mode.service'), 'utf8');
    check('safe mode: the guard orders itself before nothing', !/^(Before|RequiredBy|WantedBy=(sockets|basic|sysinit|local-fs)\.target)/m.test(guardUnit));
    const plainLimits = dropIn(root, 'fixture-tool-boot.service');
    check('safe mode: a unit that runs in safe mode: the limits alone', !plainLimits.includes('safe-mode') && plainLimits.includes('LimitCORE=1'),
        plainLimits);
    const rec = fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
    check('safe mode: the install lays the guard: its unit, enabled, the shutdown mark for var-opt-ro.service, its recmgr entry in both sections',
        fs.readFileSync(sys(root, 'mgu-deploy-safe-mode.service'), 'utf8') === fs.readFileSync(path.join(DEPLOY, 'unit', 'mgu-deploy-safe-mode.service'), 'utf8') &&
        fs.readlinkSync(sys(root, 'multi-user.target.wants/mgu-deploy-safe-mode.service')) === '../mgu-deploy-safe-mode.service' &&
        fs.readFileSync(sys(root, 'var-opt-ro.service.d/40-mgu-deploy-safe-mode.conf'), 'utf8') ===
            fs.readFileSync(path.join(DEPLOY, 'unit', 'var-opt-ro-safe-mode.conf'), 'utf8') &&
        /\[Whitelist\][^[]*mgu-deploy-safe-mode/.test(rec) && /\[WhitelistExitSuccess\][^[]*mgu-deploy-safe-mode/.test(rec) &&
        fs.existsSync(root.p('var/opt/mgu-deploy/current/safe_mode.sh')), r.out + rec);
    r = root.run(['status', '--json']);
    let st = JSON.parse(r.stdout);
    check('safe mode: status after the install changes nothing and reports safe mode off',
        r.status === 0 && st.safe_mode === null && st.service_limits.state === 'ok' && !r.stderr, r.out);
    // a deploy tool update that brings the guard: status lays it
    ['mgu-deploy-safe-mode.service', 'multi-user.target.wants/mgu-deploy-safe-mode.service', 'var-opt-ro.service.d'].forEach((rel) =>
        fs.rmSync(sys(root, rel), { recursive: true }));
    write(sys(root, 'fixture-tool.service.d/zz-mgu-deploy-limits.conf'), 'older\n');
    r = root.run(['status', '--json']);
    st = JSON.parse(r.stdout);
    check('safe mode: status lays the guard and the drop-ins again',
        r.status === 0 && st.service_limits.state === 'changed' && /safe mode guard mgu-deploy-safe-mode.service/.test(st.service_limits.reason) &&
        fs.existsSync(sys(root, 'mgu-deploy-safe-mode.service')) && fs.existsSync(sys(root, 'var-opt-ro.service.d/40-mgu-deploy-safe-mode.conf')) &&
        dropIn(root, 'fixture-tool.service') === svc, r.out);

    // safe mode on
    const FLAG = root.p('var/opt/mgu-deploy/safe-mode');
    const on = '{"at": "2026-11-09T10:00:00Z", "reason": "4 failed starts in a row, each within 120 s"}\n';
    write(FLAG, on);
    st = root.status();
    check('safe mode: status --json reports it', JSON.stringify(st.safe_mode) ===
        JSON.stringify({ at: '2026-11-09T10:00:00Z', reason: '4 failed starts in a row, each within 120 s' }), JSON.stringify(st.safe_mode));
    r = root.run(['status']);
    check('safe mode: plain status says so', r.stdout.includes('safe mode: on since 2026-11-09T10:00:00Z'), r.stdout);
    write(FLAG, 'torn');
    check('safe mode: a flag that does not read as written is still on', JSON.stringify(root.status().safe_mode) === '{"at":null,"reason":null}');
    write(FLAG, on);
    // the boot check waits for a start without safe mode
    write(root.p('var/opt/mgu-deploy/verify.json'), JSON.stringify({ 'fixture-tool': { version: '0.2.0', previous: null, boot: 'boot-0' } }));
    r = root.run(['verify'], { MGU_DEPLOY_VERIFY_AFTER_S: '0' });
    check('safe mode: the boot check waits, its entries kept', r.status === 0 && /safe mode is on: fixture-tool checked at a start without it/.test(r.out) &&
        !!readJson(root.p('var/opt/mgu-deploy/verify.json'))['fixture-tool'], r.out);
    fs.unlinkSync(root.p('var/opt/mgu-deploy/verify.json'));
    r = root.run(['safe-mode', 'off']);
    check('safe mode: safe-mode off needs --yes', r.status === 2 && fs.existsSync(FLAG), r.out);
    r = root.run(['safe-mode', '--json']);
    check('safe mode: safe-mode --json', r.status === 0 && JSON.parse(r.stdout).safe_mode.at === '2026-11-09T10:00:00Z', r.out);
    r = root.run(['safe-mode', 'off', '--yes']);
    st = root.status();
    check('safe mode: safe-mode off --yes (the Store\'s button): the flag gone, the count from zero, the tools pending the next start',
        r.status === 0 && !fs.existsSync(FLAG) && st.safe_mode === null &&
        fs.readFileSync(root.p('var/opt/mgu-deploy/safe-mode-count'), 'utf8') === '0 boot-1 0\n' &&
        st.pending_reboot.some((p) => p.id === 'mgu-deploy' && p.reason === 'our tools start at the next start'), r.out + JSON.stringify(st.pending_reboot));
    r = root.run(['safe-mode', 'off', '--yes']);
    check('safe mode: safe-mode off when it is off', r.status === 0 && /safe mode is off/.test(r.stdout), r.out);
    // an install that goes through leaves it
    write(FLAG, on);
    r = root.run(['install', '--artifact', kit('0.2.1'), '--yes']);
    check('safe mode: an install that goes through leaves it, the tools pending the next start',
        r.status === 0 && !fs.existsSync(FLAG) && /safe mode off/.test(r.out) &&
        root.status().pending_reboot.some((p) => p.id === 'mgu-deploy' && p.reason === 'our tools start at the next start'), r.out);
    write(FLAG, on);
    r = root.run(['install', '--artifact', path.join(T, 'no-such.tgz'), '--yes']);
    check('safe mode: a refused install keeps it', r.status === 2 && fs.readFileSync(FLAG, 'utf8') === on, r.out);
    // a socket newly marked runsInSafeMode loses its drop-in at the install that marks it
    const exempt = fs.mkdtempSync(path.join(T, 'safe-'));
    let res = hu(['artifact', fixtureCopy('0.2.3', (x) => {
        x.units[0].runsInSafeMode = true;
        x.units.push({ name: 'fixture-tool-boot.service', from: 'systemd/fixture-tool.service', runsInSafeMode: true });
    }), '--out', exempt]);
    r = root.run(['install', '--artifact', path.join(exempt, 'fixture-tool@0.2.3.tgz'), '--yes']);
    check('safe mode: an install that marks a socket runsInSafeMode takes its drop-in out', res.status === 0 && r.status === 0 &&
        !fs.existsSync(sys(root, 'fixture-tool.socket.d')) && dropIn(root, 'fixture-tool.service').includes(COND), r.out);
    r = root.run(['install', '--artifact', kit('0.2.4'), '--yes']);
    check('safe mode: and the next version without the flag gives it back', r.status === 0 && dropIn(root, 'fixture-tool.socket').includes(COND), r.out);
    // a failed install keeps it: its update crash-loops and goes back
    const fr = fakeRoot({ recmgr: ['fixture-tool', 'a-tool'], active: 'fixture-tool.service' });
    fr.run(['install', '--artifact', plainArtifact('0.2.0'), '--yes']);
    fs.writeFileSync(fr.unitFile('fixture-tool.service.crash'), `${path.join(fr.tool('fixture-tool'), 'current')} versions/0.4.0\n`);
    write(fr.p('var/opt/mgu-deploy/safe-mode'), on);
    r = fr.run(['install', '--artifact', plainArtifact('0.4.0'), '--yes']);
    check('safe mode: a failed install keeps it', r.status === 1 && fs.readFileSync(fr.p('var/opt/mgu-deploy/safe-mode'), 'utf8') === on &&
        !fr.status().pending_reboot.some((p) => p.id === 'mgu-deploy'), r.out);
    // nor when one artifact goes through and a later one fails
    res = hu(['artifact', fixtureCopy('0.1.0', (x) => {
        x.id = 'a-tool';
        x.units = [{ name: 'a-tool.service', from: 'systemd/fixture-tool.service' }];
        x.enable = [];
        x.recmgr = ['a-tool'];
        x.restart = [];
    }), '--out', exempt]);
    r = fr.run(['install', '--artifact', path.join(exempt, 'a-tool@0.1.0.tgz'), '--artifact', plainArtifact('0.4.0'), '--yes']);
    check('safe mode: an install whose first artifact goes through and a later one fails keeps it', res.status === 0 && r.status === 1 &&
        fs.existsSync(fr.tool('a-tool')) && fs.readFileSync(fr.p('var/opt/mgu-deploy/safe-mode'), 'utf8') === on &&
        !fs.existsSync(fr.p('run/mgu-deploy/safe-mode-lifted')), r.out);
    // an install lifts it in RAM (/run) only: the flag stays on disk until the install went through
    const lifted = fr.p('run/mgu-deploy/safe-mode-lifted');
    fs.writeFileSync(fr.unitFile('fixture-tool.service.crash'), '');
    r = fr.run(['install', '--artifact', path.join(exempt, 'a-tool@0.1.0.tgz'), '--yes']);
    check('safe mode: an install that goes through leaves it, and its lift in RAM goes',
        r.status === 0 && !fs.existsSync(fr.p('var/opt/mgu-deploy/safe-mode')) && !fs.existsSync(lifted), r.out);
    // a run cut short leaves it lifted in RAM; the next run of the deploy tool (or the next start) ends that
    write(fr.p('var/opt/mgu-deploy/safe-mode'), on);
    write(lifted, '1\n');
    r = fr.run(['safe-mode', 'off']);
    check('safe mode: a lift a cut-short install left goes at the next run, the flag kept', fs.readFileSync(fr.p('var/opt/mgu-deploy/safe-mode'), 'utf8') === on &&
        !fs.existsSync(lifted), r.out);
    // a tool to lay again that fails without failing the run keeps it
    fs.unlinkSync(fr.p('etc/systemd/system/fixture-tool.service'));
    fs.writeFileSync(fr.unitFile('fixture-tool.service.crash'), `${path.join(fr.tool('fixture-tool'), 'current')} versions/0.2.0\n`);
    r = fr.run(['install', '--artifact', path.join(exempt, 'a-tool@0.1.0.tgz'), '--yes']);
    check('safe mode: an install whose re-lay of another tool fails (warned, exit 0) keeps it', r.status === 0 &&
        /fixture-tool 0\.2\.0 is not laid again/.test(r.out) && fs.readFileSync(fr.p('var/opt/mgu-deploy/safe-mode'), 'utf8') === on &&
        !fs.existsSync(lifted), r.out);
    // an older deploy tool without safe mode, installed or rolled back to: the guard and safe mode go, the drop-ins let every unit start
    const dg = fakeRoot({ recmgr: ['fixture-tool'] });
    write(dg.p('lib/systemd/system/var-opt-ro.service'), '[Service]\nType=oneshot\nExecStart=/bin/mount -o remount,ro /var/opt\n');
    const selfOut = fs.mkdtempSync(path.join(T, 'safe-self-'));
    const older = deployCopy('0.0.1');
    const oc = readJson(path.join(older, 'component.json'));
    oc.files = oc.files.filter((f) => !/safe_mode\.sh|safe-mode/.test(f.path));
    fs.writeFileSync(path.join(older, 'component.json'), JSON.stringify(oc, null, 2) + '\n');
    res = hu(['artifact', older, '--out', selfOut]);
    hu(['artifact', DEPLOY, '--out', selfOut]);
    dg.run(['install', '--artifact', kit('0.2.0'), '--yes']);
    const guardPieces = ['mgu-deploy-safe-mode.service', 'multi-user.target.wants/mgu-deploy-safe-mode.service',
        'var-opt-ro.service.d/40-mgu-deploy-safe-mode.conf'];
    const records = ['safe-mode', 'safe-mode-count', 'safe-mode-crashes', 'last-shutdown'].map((n) => dg.p(`var/opt/mgu-deploy/${n}`));
    const turnOn = () => {
        write(records[0], on);
        write(records[1], '0 boot-0 3\n');
        write(records[2], 'boot-0 5\n');
        write(records[3], 'boot-0 crash 30 recmgr\n');
    };
    // as on the unit: the installed deploy tool runs, through its shim
    const shim = (args) => {
        const x = cp.spawnSync('sh', [dg.p('var/opt/mgu-deploy/mgu-deploy.sh')].concat(args),
            { encoding: 'utf8', env: Object.assign({}, dg.env, { MGU_DEPLOY_NODE: UNIT_NODE }) });
        return { status: x.status, out: x.stdout + x.stderr };
    };
    turnOn();
    r = shim(['install', '--artifact', path.join(selfOut, 'mgu-deploy@0.0.1.tgz'), '--yes']);
    check('safe mode: an install of an older deploy tool without it takes the guard out and leaves safe mode, its count and records gone',
        res.status === 0 && r.status === 0 && fs.readlinkSync(dg.p('var/opt/mgu-deploy/current')) === 'versions/0.0.1' &&
        guardPieces.every((rel) => !fs.existsSync(sys(dg, rel))) && records.every((f) => !fs.existsSync(f)) &&
        /safe mode guard mgu-deploy-safe-mode.service removed/.test(r.out) &&
        dg.status().pending_reboot.some((p) => p.id === 'mgu-deploy' && p.reason === 'our tools start at the next start'), r.out);
    check('safe mode: the tools\' drop-ins left let every unit start under it (no safe_mode.sh in its version)',
        dropIn(dg, 'fixture-tool.service').includes('ConditionPathExists=|!/var/opt/mgu-deploy/current/safe_mode.sh') &&
        !fs.existsSync(dg.p('var/opt/mgu-deploy/current/safe_mode.sh')));
    r = shim(['install', '--artifact', path.join(selfOut, `mgu-deploy@${VERSION}.tgz`), '--yes']);
    check('safe mode: the deploy tool with it installed again lays the guard again, safe mode off',
        r.status === 0 && guardPieces.every((rel) => fs.existsSync(sys(dg, rel))) && !fs.existsSync(records[0]), r.out);
    turnOn();
    r = shim(['rollback', 'mgu-deploy', '--yes']);
    check('safe mode: a rollback to an older deploy tool without it does the same',
        r.status === 0 && fs.readlinkSync(dg.p('var/opt/mgu-deploy/current')) === 'versions/0.0.1' &&
        guardPieces.every((rel) => !fs.existsSync(sys(dg, rel))) && records.every((f) => !fs.existsSync(f)), r.out);

    // remove-all takes the guard out
    fs.rmSync(FLAG, { force: true });
    r = root.run(['remove-all', '--yes']);
    const recAfter = fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
    check('safe mode: remove-all takes the guard, its link, the shutdown mark and its recmgr entry out',
        r.status === 0 && !fs.existsSync(sys(root, 'mgu-deploy-safe-mode.service')) &&
        !fs.existsSync(sys(root, 'multi-user.target.wants/mgu-deploy-safe-mode.service')) && !fs.existsSync(sys(root, 'var-opt-ro.service.d')) &&
        !recAfter.includes('mgu-deploy-safe-mode'), r.out + recAfter);
}

/* The crash handler's restart list, as iDrive 8 ships it (no newline at
 * the end). */
const CRASH_LIST = '\n[Whitelist]\nMonitor\nnode\n; a comment\nsocat\n\n[ForceRestartList]\ndbus-daemon\nNodeStateManager';

/* Our tools' names go into the crash handler's [Whitelist] while they are
 * installed (crashNames, or the built-in names of a tool that has none),
 * idempotently and snapshotted, and come out with them; nothing else in
 * the file changes, a stock name stays, and a unit without the list is
 * left alone. status (as root, lock free) catches up a list written
 * without them. */
function testCrashList() {
    const root = fakeRoot();
    const list = root.p('etc/crashhandler-restartlist.conf');
    const owned = root.p('var/opt/mgu-deploy/crash-names.json');
    write(list, CRASH_LIST);
    fs.chmodSync(list, 0o640);
    const uplink = namedTool('mgu-uplink', '0.8.0', (c) => { c.crashNames = ['mgu-uplink', 'mgu-wpa', 'node']; });
    let r = root.run(['install', '--artifact', uplink, '--yes']);
    const after = CRASH_LIST.replace('socat\n', 'socat\nmgu-uplink\nmgu-wpa\n');
    check('crash list: install adds the names after [Whitelist]\'s last entry, the rest byte for byte',
        r.status === 0 && fs.readFileSync(list, 'utf8') === after && mode(list) === 0o640 &&
        r.out.includes('crash handler whitelist: added mgu-uplink, mgu-wpa'), r.out + fs.readFileSync(list, 'utf8'));
    check('crash list: only the names it added are recorded as its own (node is stock)',
        JSON.stringify(readJson(owned).names) === JSON.stringify(['mgu-uplink', 'mgu-wpa']));
    const backups = fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).filter((b) => b !== 'stock').sort();
    const manifest = readJson(root.p(`var/opt/mgu-deploy/backups/${backups[backups.length - 1]}/manifest.json`));
    check('crash list: the install\'s snapshot holds the list as it was',
        manifest.entries.some((e) => e.path === list && e.kind === 'file' && e.sha256 === sha256(Buffer.from(CRASH_LIST))));
    r = root.run(['install', '--artifact', uplink, '--yes']);
    check('crash list: a reinstall changes nothing', r.status === 0 && fs.readFileSync(list, 'utf8') === after &&
        !r.out.includes('crash handler whitelist'), r.out);
    r = root.run(['install', '--artifact', namedTool('mgu-render', '0.4.0'), '--yes']);
    check('crash list: a tool without crashNames gets its built-in names',
        r.status === 0 && fs.readFileSync(list, 'utf8') === after.replace('mgu-wpa\n', 'mgu-wpa\nmgu-render\n'), r.out);
    r = root.run(['uninstall', 'mgu-uplink', '--yes']);
    check('crash list: uninstalling removes its names, the stock one stays',
        r.status === 0 && fs.readFileSync(list, 'utf8') === CRASH_LIST.replace('socat\n', 'socat\nmgu-render\n') &&
        JSON.stringify(readJson(owned).names) === JSON.stringify(['mgu-render']) &&
        r.out.includes('crash handler whitelist: removed mgu-uplink, mgu-wpa'), r.out);
    r = root.run(['uninstall', 'mgu-render', '--yes']);
    check('crash list: with none of ours left the file is as it was', r.status === 0 && fs.readFileSync(list, 'utf8') === CRASH_LIST, r.out);
    r = root.run(['install', '--artifact', namedTool('mgu-uplink', '0.8.1', (c) => { c.crashNames = ['mgu uplink']; }), '--yes']);
    check('crash list: a name that is not a plain file name is refused', r.status === 2 && r.out.includes('crashNames'), r.out);
    // a manifest an older deploy tool installed as it came: its bad names are passed over
    r = root.run(['install', '--artifact', namedTool('long-names', '0.1.0', (c) => { c.crashNames = ['robertn-logger-enet']; }), '--yes']);
    const manifestFile = root.p('var/opt/long-names/current/component.json');
    const m = readJson(manifestFile);
    m.crashNames.push(' x', '[Other]');
    fs.writeFileSync(manifestFile, JSON.stringify(m));
    const r1 = root.run(['status', '--json']), text1 = fs.readFileSync(list, 'utf8');
    const r2 = root.run(['status', '--json']);
    check('crash list: a long file name is listed; bad names in an installed manifest are skipped, status settles',
        r.status === 0 && r1.status === 0 && r2.status === 0 && text1 === CRASH_LIST.replace('socat\n', 'socat\nrobertn-logger-enet\n') &&
        fs.readFileSync(list, 'utf8') === text1, r.out + r1.out + r2.out + text1);
    root.run(['uninstall', 'long-names', '--yes']);
    r = root.run(['install', '--artifact', namedTool('constructor', '0.1.0'), '--yes']);
    check('crash list: a tool whose id is an Object property name has no built-in names',
        r.status === 0 && fs.readFileSync(list, 'utf8') === CRASH_LIST, r.out);
    root.run(['uninstall', 'constructor', '--yes']);

    // a tool installed while the list was absent: nothing written; status catches up once it is there
    const bare = fakeRoot();
    const bareList = bare.p('etc/crashhandler-restartlist.conf');
    r = bare.run(['install', '--artifact', namedTool('mgu-uplink', '0.7.0'), '--yes']);
    check('crash list: a unit without the list gets none', r.status === 0 && !fs.existsSync(bareList) &&
        !fs.existsSync(bare.p('var/opt/mgu-deploy/crash-names.json')), r.out);
    const bareStock = '[Whitelist]\r\nnode\r\n\r\n[ForceRestartList]\r\ndbus-daemon\r\n';
    write(bareList, bareStock);
    const crashState = (res) => { try { return JSON.parse(res.stdout).crash_list; } catch (e) { return null; } };
    const unchanged = () => fs.readFileSync(bareList, 'utf8') === bareStock;
    r = bare.run(['status', '--read-only', '--json']);
    check('crash list: status --read-only leaves a list that lacks our names, pending', r.status === 0 && unchanged() &&
        JSON.stringify(crashState(r)) === '{"state":"pending","reason":"read-only"}', r.out);
    write(bare.p('var/opt/mgu-deploy/lock'), `1 ${fs.readFileSync(bare.p('proc/boot_id'), 'utf8').trim()}\n`);
    r = bare.run(['status', '--json']);
    check('crash list: status leaves it while another run holds the lock, and says so',
        r.status === 0 && unchanged() && crashState(r).state === 'pending' && /holds the lock/.test(crashState(r).reason), r.out);
    // a lock from an earlier boot is stale
    write(bare.p('var/opt/mgu-deploy/lock'), '1 boot-0\n');
    // / read-write: another writer (app-privacy's boot run, someone's shell) may be at work
    write(bare.p('proc/mounts'), 'rootfs / ext4 rw,relatime 0 0\n');
    r = bare.run(['status', '--json']);
    check('crash list: status does not touch it while / is read-write',
        r.status === 0 && unchanged() && crashState(r).state === 'pending' && /read-write/.test(crashState(r).reason), r.out);
    write(bare.p('proc/mounts'), 'rootfs / ext4 ro,relatime 0 0\n');
    // app-privacy's boot run, which remounts / itself, has not finished
    const units = `${bare.R}.units`;
    write(bare.p('etc/systemd/system/app-privacy.service'), '[Service]\nType=oneshot\n');
    fs.symlinkSync('../app-privacy.service', bare.p('etc/systemd/system/multi-user.target.wants/app-privacy.service'));
    write(path.join(units, 'system'), 'starting\n');
    write(path.join(units, 'app-privacy.service.active'), 'inactive\n');
    r = bare.run(['status', '--json']);
    check('crash list: status waits while the boot has app-privacy\'s run still ahead',
        r.status === 0 && unchanged() && crashState(r).state === 'pending' && /app-privacy\.service is inactive/.test(crashState(r).reason), r.out);
    write(path.join(units, 'app-privacy.service.active'), 'activating\n');
    r = bare.run(['status', '--json']);
    check('crash list: status waits while app-privacy\'s boot run is activating',
        r.status === 0 && unchanged() && crashState(r).state === 'pending' && /is activating/.test(crashState(r).reason), r.out);
    // both at once: app-privacy's boot run remounts / read-write, writes and puts / back, while the
    // updater's status runs again and again; it finishes (active, boot done) only once the test says so
    const release = `${bare.R}.privacy-done`;
    const privacyRun = cp.spawn('sh', ['-c',
        'echo activating > "$1/app-privacy.service.active"; sleep 0.2; ' +
        'echo "rootfs / ext4 rw,relatime 0 0" > "$2"; sleep 0.4; echo "rootfs / ext4 ro,relatime 0 0" > "$2"; ' +
        'while [ ! -f "$3" ]; do sleep 0.05; done; echo active > "$1/app-privacy.service.active"; echo running > "$1/system"',
    'sh', units, bare.p('proc/mounts'), release], { stdio: 'ignore' });
    const during = [];
    for (let i = 0; i < 4; i += 1) {
        during.push(crashState(bare.run(['status', '--json'])));
        cp.spawnSync('sh', ['-c', 'sleep 0.25']);
    }
    write(release, '');
    for (let i = 0; i < 40 && fs.readFileSync(path.join(units, 'system'), 'utf8').trim() !== 'running'; i += 1) {
        cp.spawnSync('sh', ['-c', 'sleep 0.05']);
    }
    privacyRun.kill();
    check('crash list: while app-privacy\'s boot run is at work, every status waits and writes nothing',
        during.every((c) => c && c.state === 'pending') && unchanged(), JSON.stringify(during));
    const before = fs.readdirSync(bare.p('var/opt/mgu-deploy/backups')).length;
    r = bare.run(['status', '--json']);
    check('crash list: once the boot is done, status adds the built-in names (in the file\'s line ending), snapshotted, one line, reported',
        r.status === 0 && crashState(r) && crashState(r).state === 'changed' &&
        crashState(r).reason === 'added mgu-uplink; / remounted read-write for it and back to read-only' &&
        fs.readFileSync(bareList, 'utf8') === bareStock.replace('node\r\n', 'node\r\nmgu-uplink\r\n') &&
        fs.readdirSync(bare.p('var/opt/mgu-deploy/backups')).length === before + 1 &&
        r.stderr === 'crash handler whitelist: added mgu-uplink; / remounted read-write for it and back to read-only\n' &&
        !fs.existsSync(bare.p('var/opt/mgu-deploy/lock')), r.out);
    r = bare.run(['status', '--json']);
    check('crash list: status again changes nothing and says ok',
        r.status === 0 && fs.readdirSync(bare.p('var/opt/mgu-deploy/backups')).length === before + 1 && !r.stderr &&
        crashState(r).state === 'ok', r.out);
    // a name this tool added that has left the list and that nothing wants: only the record changes, no remount
    const ownedFile = bare.p('var/opt/mgu-deploy/crash-names.json');
    write(ownedFile, JSON.stringify({ names: ['gone', 'mgu-uplink'] }) + '\n');
    const listBefore = fs.readFileSync(bareList, 'utf8');
    r = bare.run(['status', '--json']);
    check('crash list: status drops a gone name from its record without touching the list',
        r.status === 0 && crashState(r).state === 'ok' && JSON.stringify(readJson(ownedFile).names) === '["mgu-uplink"]' &&
        fs.readFileSync(bareList, 'utf8') === listBefore && !r.stderr, r.out);
    r = bare.run(['status']);
    check('crash list: plain status prints the step\'s result', r.status === 0 && r.stdout.includes('crash handler whitelist: ok (up to date)'), r.out);
    // a fresh app-privacy install enables the unit without starting it: after the boot that is not a run ahead
    write(path.join(units, 'app-privacy.service.active'), 'inactive\n');
    write(bareList, '[ForceRestartList]\ndbus-daemon\n');
    r = bare.run(['status', '--json']);
    check('crash list: a list without [Whitelist] is left as it is, an error in status (app-privacy enabled, not started, boot done)',
        r.status === 0 && fs.readFileSync(bareList, 'utf8') === '[ForceRestartList]\ndbus-daemon\n' &&
        crashState(r).state === 'error' && /has no \[Whitelist\] section; left as it is/.test(crashState(r).reason), r.out);
    // a list that cannot be read: status reports the error and still answers; an install fails before it changes anything
    const unreadable = { MGU_DEPLOY_CRASHLIST: '/proc/self/mem' };
    r = bare.run(['status', '--json'], unreadable);
    check('crash list: an unreadable list is an error in status, which still answers',
        r.status === 0 && crashState(r) && crashState(r).state === 'error', r.out);
    r = bare.run(['install', '--artifact', namedTool('mgu-render', '0.4.0'), '--yes'], unreadable);
    check('crash list: an install with an unreadable list fails at its snapshot, nothing installed',
        r.status !== 0 && !fs.existsSync(bare.p('var/opt/mgu-render')), r.out);
}

/* The lists the head unit reads at boot: an install has its payload and
 * its list entries on disk before its units and links, an uninstall takes
 * the units out before the entries, and a list without its stock sections
 * is never edited. */
function testBootLists() {
    const root = fakeRoot();
    const syncLog = `${root.R}.sync.log`;
    const watch = { FAKE_SYNC_WATCH: [root.p('etc/recmgr-restartlist.conf'), root.p('var/opt/fixture-tool/current'),
        root.p('etc/systemd/system/fixture-tool.service'), root.p('etc/systemd/system/sockets.target.wants/fixture-tool.socket')].join(' ') };
    // what each sync found on disk
    const syncs = () => fs.readFileSync(syncLog, 'utf8').split('\n').filter(Boolean).map((l) => {
        const o = {};
        l.split(' ').slice(1).forEach((kv) => { o[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1); });
        return { listed: o['recmgr-restartlist.conf'].split('|').indexOf('fixture-tool') >= 0, payload: o.current !== '-',
            unit: o['fixture-tool.service'] !== '-', link: o['fixture-tool.socket'] !== '-' };
    });
    let r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes'], watch);
    let s = syncs();
    const firstPayload = s.findIndex((x) => x.payload);
    check('boot lists: an install syncs its payload before the list, and the list entry before the unit and its link',
        r.status === 0 && s.length > 2 && firstPayload >= 0 && !s[firstPayload].listed && !s[firstPayload].unit &&
        s.some((x) => x.listed && x.payload && !x.unit && !x.link) &&
        s.every((x) => !(x.unit || x.link) || x.listed) && s[s.length - 1].unit && s[s.length - 1].link,
    `${r.out}\n${JSON.stringify(s)}`);
    fs.unlinkSync(syncLog);
    r = root.run(['uninstall', 'fixture-tool', '--yes'], watch);
    s = syncs();
    check('boot lists: an uninstall has the unit and its link gone before the list entry',
        r.status === 0 && s.length > 0 && s.every((x) => x.listed || (!x.unit && !x.link)) && !s[s.length - 1].listed,
        `${r.out}\n${JSON.stringify(s)}`);

    [['empty', ''], ['without sections', 'stockd\n'], ['with neither whitelist', '[ForceRestartList]\ndbus\n']].forEach(([what, text]) => {
        const bad = fakeRoot();
        const list = bad.p('etc/recmgr-restartlist.conf');
        write(list, text);
        const res = bad.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
        check(`boot lists: an install onto a recmgr list ${what} is refused; the list, units and tool as they were`,
            res.status === 2 && /recmgr-restartlist\.conf has no \[Whitelist\] or \[WhitelistExitSuccess\] section; left as it is/.test(res.out) &&
            fs.readFileSync(list, 'utf8') === text && !fs.existsSync(bad.p('etc/systemd/system/fixture-tool.service')) &&
            !fs.existsSync(bad.p('etc/systemd/system/sockets.target.wants/fixture-tool.socket')) &&
            !fs.existsSync(bad.tool('fixture-tool')), res.out);
    });
    // a list with one of the two whitelists gets the other, at the end
    const half = fakeRoot();
    const halfList = half.p('etc/recmgr-restartlist.conf');
    write(halfList, '[Whitelist]\nstockd\n\n[ForceRestartList]\ndbus\n');
    r = half.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('boot lists: a recmgr list without [WhitelistExitSuccess] gets it at the end, with our name; the rest kept',
        r.status === 0 && JSON.stringify(sectionsOf(fs.readFileSync(halfList, 'utf8'))) ===
        JSON.stringify({ Whitelist: ['stockd', 'fixture-tool'], ForceRestartList: ['dbus'], WhitelistExitSuccess: ['fixture-tool'] }),
    r.out + fs.readFileSync(halfList, 'utf8'));
    // the names come from the tool's units and from the ELF files it ships executable
    const auto = fakeRoot();
    const autoRec = auto.p('etc/recmgr-restartlist.conf');
    const autoCrash = auto.p('etc/crashhandler-restartlist.conf');
    write(autoCrash, CRASH_LIST);
    const recStock = fs.readFileSync(autoRec, 'utf8');
    const elfTool = (version) => elfArtifact('fixture-tool', version, 'fixture-tool', (c) => { c.recmgr = []; });
    r = auto.run(['install', '--artifact', elfTool('0.2.0'), '--yes']);
    const listed = (text, sec, name) => new RegExp(`\\[${sec}\\][^[]*\\n${name}\\n`).test(text);
    let autoText = fs.readFileSync(autoRec, 'utf8');
    check('boot lists: a tool without recmgr names gets its units\' name in both recmgr sections, its ELF program in the crash list',
        r.status === 0 && listed(autoText, 'Whitelist', 'fixture-tool') && listed(autoText, 'WhitelistExitSuccess', 'fixture-tool') &&
        fs.readFileSync(autoCrash, 'utf8') === CRASH_LIST.replace('socat\n', 'socat\nfixture-tool\n'), r.out + autoText);
    r = auto.run(['uninstall', 'fixture-tool', '--yes']);
    check('boot lists: its uninstall takes both out, the lists as they were',
        r.status === 0 && fs.readFileSync(autoRec, 'utf8') === recStock && fs.readFileSync(autoCrash, 'utf8') === CRASH_LIST, r.out);
    r = auto.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    check('boot lists: a shipped script is no program of the tool\'s: the crash list unchanged',
        r.status === 0 && fs.readFileSync(autoCrash, 'utf8') === CRASH_LIST, r.out);
    // an install by a deploy tool before these names: status adds them
    r = auto.run(['install', '--artifact', elfTool('0.3.0'), '--yes']);
    write(autoRec, recStock);
    write(autoCrash, CRASH_LIST);
    fs.unlinkSync(auto.p('var/opt/mgu-deploy/crash-names.json'));
    r = auto.run(['status', '--json']);
    autoText = fs.readFileSync(autoRec, 'utf8');
    check('boot lists: status adds an installed tool\'s missing names to both lists, one line each',
        r.status === 0 && listed(autoText, 'Whitelist', 'fixture-tool') && listed(autoText, 'WhitelistExitSuccess', 'fixture-tool') &&
        /\[ForceRestartList\]\ndbus\n/.test(autoText) &&
        fs.readFileSync(autoCrash, 'utf8') === CRASH_LIST.replace('socat\n', 'socat\nfixture-tool\n') &&
        r.stderr === 'crash handler whitelist: added fixture-tool; / remounted read-write for it and back to read-only\nrecmgr list: added fixture-tool\n' &&
        JSON.parse(r.stdout).crash_list.state === 'changed', r.out + autoText);
    r = auto.run(['status', '--json']);
    check('boot lists: status again changes nothing', r.status === 0 && !r.stderr && JSON.parse(r.stdout).crash_list.state === 'ok', r.out);

    const crash = fakeRoot();
    const crashList = crash.p('etc/crashhandler-restartlist.conf');
    write(crashList, '\n[Whitelist]\n\n');
    r = crash.run(['install', '--artifact', namedTool('mgu-uplink', '0.8.0'), '--yes']);
    check('boot lists: a crash handler list of an empty [Whitelist] alone is edited',
        r.status === 0 && fs.readFileSync(crashList, 'utf8') === '\n[Whitelist]\nmgu-uplink\n\n', r.out);
    const noWhite = fakeRoot();
    write(noWhite.p('etc/crashhandler-restartlist.conf'), '[ForceRestartList]\ndbus-daemon\n');
    r = noWhite.run(['install', '--artifact', namedTool('mgu-uplink', '0.8.0'), '--yes']);
    check('boot lists: an install onto a crash handler list without [Whitelist] is refused, the list as it was',
        r.status === 2 && /crashhandler-restartlist\.conf has no \[Whitelist\] section; left as it is/.test(r.out) &&
        fs.readFileSync(noWhite.p('etc/crashhandler-restartlist.conf'), 'utf8') === '[ForceRestartList]\ndbus-daemon\n' &&
        !fs.existsSync(noWhite.tool('mgu-uplink')), r.out);
    r = noWhite.run(['install', '--artifact', namedTool('no-names', '0.1.0'), '--yes']);
    check('boot lists: an install that changes neither list goes through whatever the lists hold',
        r.status === 0 && fs.existsSync(noWhite.tool('no-names')), r.out);
    // status: one list refused leaves the other's names added
    write(noWhite.p('etc/recmgr-restartlist.conf'), '[Whitelist]\nstockd\n[WhitelistExitSuccess]\nstockd\n');
    r = noWhite.run(['install', '--artifact', namedTool('svc-tool', '0.1.0', (c) => { c.recmgr = ['svc-tool']; }), '--yes']);
    write(noWhite.p('etc/recmgr-restartlist.conf'), '[Whitelist]\nstockd\n[WhitelistExitSuccess]\nstockd\n');
    write(noWhite.p('var/opt/no-names/current/component.json'), JSON.stringify(Object.assign(
        readJson(noWhite.p('var/opt/no-names/current/component.json')), { crashNames: ['no-names'] })));
    r = noWhite.run(['status', '--json']);
    const cs = JSON.parse(r.stdout).crash_list;
    check('boot lists: status adds recmgr\'s missing names while the crash handler\'s list is refused, and reports both',
        r.status === 0 && JSON.stringify(sectionsOf(fs.readFileSync(noWhite.p('etc/recmgr-restartlist.conf'), 'utf8'))) ===
        JSON.stringify({ Whitelist: ['stockd', 'svc-tool'], WhitelistExitSuccess: ['stockd', 'svc-tool'] }) &&
        cs.state === 'error' && /recmgr list: added svc-tool/.test(cs.reason) && /has no \[Whitelist\] section/.test(cs.reason) &&
        fs.readFileSync(noWhite.p('etc/crashhandler-restartlist.conf'), 'utf8') === '[ForceRestartList]\ndbus-daemon\n', r.out);
    const names = fakeRoot();
    ['#comment', '[Whitelist]', '   ', 'a name', 'name#x'].forEach((bad) => {
        const res = names.run(['install', '--artifact', namedTool('bad-name', '0.1.0', (c) => { c.recmgr = [bad]; }), '--yes']);
        check(`boot lists: a recmgr name ${JSON.stringify(bad)} is refused at install`,
            res.status === 2 && res.out.includes(`bad recmgr entry ${JSON.stringify(bad)}`) && !fs.existsSync(names.tool('bad-name')), res.out);
    });
    r = names.run(['install', '--artifact', namedTool('tpl-name', '0.1.0', (c) => { c.recmgr = ['tpl-name@']; }), '--yes']);
    check('boot lists: a template\'s recmgr name (name@) is taken', r.status === 0 &&
        /\ntpl-name@\n/.test(fs.readFileSync(names.p('etc/recmgr-restartlist.conf'), 'utf8')), r.out);
}

/* A restart list's sections and entries, as the firmware reads them. */
function sectionsOf(text) {
    const out = {};
    let cur = null;
    text.split('\n').forEach((line) => {
        const t = line.split('#')[0].trim();
        if (/^\[.*\]$/.test(t)) {
            cur = t.slice(1, -1);
            out[cur] = out[cur] || [];
        } else if (cur && t) {
            out[cur].push(t);
        }
    });
    return out;
}

/* A copy of the fixture tool as id@version whose program is bin/<prog>,
 * an ELF file. */
function elfArtifact(id, version, prog, edit) {
    const dir = fixtureCopy(version, (c) => {
        c.id = id;
        c.files[0].path = `bin/${prog}`;
        if (edit) {
            edit(c);
        }
    });
    fs.writeFileSync(path.join(dir, 'src', 'fixture-tool.sh'), '\x7fELF\x02\x01\x01 a program\n');
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    const r = hu(['artifact', dir, '--out', out]);
    if (r.status !== 0) {
        throw new Error(r.stderr);
    }
    return path.join(out, `${id}@${version}.tgz`);
}

/* A recmgr list shaped as the firmware's: a comment, an inline comment,
 * odd spacing, a template entry, a section of its own and blank lines. */
const REC_STOCK = '# restart list\n[WhitelistExitSuccess]\nflashpluginwrapper\nsshd@\n  spaced-entry\t\nmonitor # inline\n\n' +
    '[Whitelist]\nmonitor\nquotaon\n\n[Unknown]\nkeep me\n\n[ForceRestartList]\ndbus\nhmi\n';

/* The lists stay the firmware's but for our lines: every edit of them is
 * idempotent, keeps every other byte, refuses a list it cannot read the
 * firmware's way, survives a power cut at every sync, and never lists a
 * name of the firmware's. */
function testListSafety() {
    const art = elfArtifact('fixture-tool', '0.2.0', 'fixture-tool');
    const ours = (text, names) => text.split('\n').filter((l) => names.indexOf(l.replace(/\r$/, '')) < 0).join('\n');
    const count = (text, name) => text.split('\n').filter((l) => l.replace(/\r$/, '') === name).length;
    // the rootfs writes go through the sh window, as on the unit
    const setup = (recText, crashText) => {
        const root = fakeRoot();
        Object.assign(root.env, { MGU_DEPLOY_FAKE_SH_WINDOW: '1', MGU_DEPLOY_MOUNT: path.join(HERE, 'fake_mount.sh') });
        write(root.p('etc/recmgr-restartlist.conf'), recText);
        write(root.p('etc/crashhandler-restartlist.conf'), crashText);
        root.rec = () => fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
        root.crash = () => fs.readFileSync(root.p('etc/crashhandler-restartlist.conf'), 'utf8');
        return root;
    };
    const cases = [
        ['LF', REC_STOCK, CRASH_LIST],
        ['CRLF', REC_STOCK.replace(/\n/g, '\r\n'), CRASH_LIST.replace(/\n/g, '\r\n')],
        ['no newline at the end, [Whitelist] last', '[WhitelistExitSuccess]\nx\n[ForceRestartList]\ndbus\n[Whitelist]\nmonitor',
            '[ForceRestartList]\ndbus-daemon\n[Whitelist]\nnode'],
        ['headers with spaces and comments', '  [WhitelistExitSuccess]  # a\n\tx\n [Whitelist]\t\n[ForceRestartList] #b\ndbus\n',
            ' [Whitelist] # w\nnode\n[ForceRestartList]\n'],
        ['5000 entries', `[WhitelistExitSuccess]\n[Whitelist]\n${Array.from({ length: 5000 }, (_, i) => `svc${i}`).join('\n')}\n[ForceRestartList]\ndbus\n`,
            `[Whitelist]\n${Array.from({ length: 5000 }, (_, i) => `prog${i}`).join('\n')}\n[ForceRestartList]\n`]
    ];
    cases.forEach(([what, recText, crashText]) => {
        const root = setup(recText, crashText);
        let r = root.run(['install', '--artifact', art, '--yes']);
        const rec1 = root.rec();
        const crash1 = root.crash();
        const crlf = /\r\n/.test(recText);
        check(`list safety (${what}): an install adds only our lines, once per section, in the file's line ending`,
            r.status === 0 && ours(rec1, ['fixture-tool']) === recText && count(rec1, 'fixture-tool') === 2 &&
            ours(crash1, ['fixture-tool']) === crashText && count(crash1, 'fixture-tool') === 1 &&
            (!crlf || rec1.split('\n').slice(0, -1).every((l) => /\r$/.test(l))),
        `${r.out}\n${JSON.stringify(rec1).slice(0, 600)}\n${JSON.stringify(crash1).slice(0, 400)}`);
        r = root.run(['install', '--artifact', art, '--yes']);
        const s1 = root.run(['status', '--json']);
        const s2 = root.run(['status', '--json']);
        check(`list safety (${what}): installing again and status twice leave both lists byte for byte`,
            r.status === 0 && s1.status === 0 && s2.status === 0 && root.rec() === rec1 && root.crash() === crash1, r.out + s1.stderr + s2.stderr);
        r = root.run(['uninstall', 'fixture-tool', '--yes']);
        check(`list safety (${what}): the uninstall leaves both lists as the firmware's, byte for byte`,
            r.status === 0 && root.rec() === recText && root.crash() === crashText, r.out);
    });

    // lists with none of the sections an edit touches: refused, the file untouched
    [['torn before its first section', REC_STOCK.slice(0, 20)],
        ['headers only as comments', '# [WhitelistExitSuccess]\n# [Whitelist]\n# [ForceRestartList]\n']].forEach(([what, text]) => {
        const root = setup(text, CRASH_LIST);
        const r = root.run(['install', '--artifact', art, '--yes']);
        check(`list safety: a recmgr list ${what} is refused and left byte for byte, nothing installed`,
            r.status === 2 && /has no \[Whitelist\] or \[WhitelistExitSuccess\] section; left as it is/.test(r.out) && root.rec() === text &&
            root.crash() === CRASH_LIST && !fs.existsSync(root.tool('fixture-tool')), r.out);
    });
    // a list with one of them: the other is added at the end, every other line kept
    [['torn after [WhitelistExitSuccess]', REC_STOCK.slice(0, 60)], ['a header in another case', REC_STOCK.replace('[Whitelist]', '[whitelist]')]]
        .forEach(([what, text]) => {
            const root = setup(text, CRASH_LIST);
            const r = root.run(['install', '--artifact', art, '--yes']);
            const after = root.rec();
            check(`list safety: a recmgr list ${what} gets [Whitelist] at the end, with only our name in it`,
                r.status === 0 && ours(after, ['fixture-tool']) === `${text}\n[Whitelist]` && sectionsOf(after).Whitelist.join() === 'fixture-tool' &&
                sectionsOf(after).WhitelistExitSuccess.indexOf('fixture-tool') >= 0, `${r.out}\n${JSON.stringify(after)}`);
        });

    // a power cut, or a failing sync, at each sync of an install and of an uninstall
    const clean = setup(REC_STOCK, CRASH_LIST);
    clean.run(['install', '--artifact', art, '--yes']);
    const recNew = clean.rec();
    const crashNew = clean.crash();
    const installSyncs = fs.readFileSync(`${clean.R}.sync.log`, 'utf8').split('\n').filter(Boolean).length;
    fs.unlinkSync(`${clean.R}.sync.log`);
    clean.run(['uninstall', 'fixture-tool', '--yes']);
    const uninstallSyncs = fs.readFileSync(`${clean.R}.sync.log`, 'utf8').split('\n').filter(Boolean).length;
    const unitThere = (root) => fs.existsSync(root.p('etc/systemd/system/fixture-tool.socket')) ||
        !!lstatOrNullT(root.p('etc/systemd/system/sockets.target.wants/fixture-tool.socket'));
    const cut = [];
    const failed = [];
    for (let k = 1; k <= installSyncs; k += 1) {
        let root = setup(REC_STOCK, CRASH_LIST);
        let r = root.run(['install', '--artifact', art, '--yes'], { FAKE_SYNC_KILL_AT: String(k) });
        let rec = root.rec();
        let crash = root.crash();
        if (r.signal !== 'SIGKILL' || [REC_STOCK, recNew].indexOf(rec) < 0 || [CRASH_LIST, crashNew].indexOf(crash) < 0 ||
            (unitThere(root) && (rec !== recNew || crash !== crashNew))) {
            cut.push(`install, cut at sync ${k}: ${r.signal} ${JSON.stringify(rec).slice(0, 80)} unit ${unitThere(root)}`);
        }
        root = setup(REC_STOCK, CRASH_LIST);
        r = root.run(['install', '--artifact', art, '--yes'], { FAKE_SYNC_FAIL_AT: String(k) });
        // the deploy tool's own install, after the tool's: the tool stays whole, the deploy tool's current not switched
        const saved = readJsonOrNull(root.p('var/opt/mgu-deploy/state.json'));
        const selfFailed = /fixture-tool 0\.2\.0 installed\n/.test(r.out) && root.rec() === recNew && root.crash() === crashNew &&
            unitThere(root) && !lstatOrNullT(root.p('var/opt/mgu-deploy/current')) &&
            !!(saved && saved.tools && saved.tools['fixture-tool'] && saved.tools['fixture-tool'].version === '0.2.0');
        if (r.status === 0 || (!selfFailed && (root.rec() !== REC_STOCK || root.crash() !== CRASH_LIST || unitThere(root)))) {
            failed.push(`install, sync ${k} failing: exit ${r.status} unit ${unitThere(root)}`);
        }
    }
    for (let k = 1; k <= uninstallSyncs; k += 1) {
        let root = setup(REC_STOCK, CRASH_LIST);
        root.run(['install', '--artifact', art, '--yes']);
        fs.unlinkSync(`${root.R}.sync.log`);
        let r = root.run(['uninstall', 'fixture-tool', '--yes'], { FAKE_SYNC_KILL_AT: String(k) });
        let rec = root.rec();
        if (r.signal !== 'SIGKILL' || [REC_STOCK, recNew].indexOf(rec) < 0 || [CRASH_LIST, crashNew].indexOf(root.crash()) < 0 ||
            (rec === REC_STOCK && unitThere(root))) {
            cut.push(`uninstall, cut at sync ${k}: ${r.signal} ${JSON.stringify(rec).slice(0, 80)} unit ${unitThere(root)}`);
        }
        root = setup(REC_STOCK, CRASH_LIST);
        root.run(['install', '--artifact', art, '--yes']);
        fs.unlinkSync(`${root.R}.sync.log`);
        r = root.run(['uninstall', 'fixture-tool', '--yes'], { FAKE_SYNC_FAIL_AT: String(k) });
        rec = root.rec();
        if ([REC_STOCK, recNew].indexOf(rec) < 0 || [CRASH_LIST, crashNew].indexOf(root.crash()) < 0 ||
            (r.status === 0 && (rec !== REC_STOCK || unitThere(root))) || (r.status !== 0 && (rec !== recNew || !unitThere(root)))) {
            failed.push(`uninstall, sync ${k} failing: exit ${r.status} ${JSON.stringify(rec).slice(0, 80)} unit ${unitThere(root)}`);
        }
    }
    check(`list safety: a power cut at each of an install's ${installSyncs} and an uninstall's ${uninstallSyncs} syncs leaves each list old or new, ` +
        'never a unit enabled without its entries', installSyncs > 3 && uninstallSyncs > 2 && !cut.length, cut.join('\n'));
    check('list safety: a sync failing at each of those points fails the change and leaves the lists and units as they were ' +
        '(at the deploy tool\'s own install after it, the tool whole and recorded, the deploy tool not switched)',
        !failed.length, failed.join('\n'));

    // a fresh install whose activate fails is rolled back: a power cut, or a failing sync, at each sync of it
    const hookEnv = (root, extra) => Object.assign({ FAKE_HOOK_LOG: `${root.R}.hooks.log`, FAKE_HOOK_FAIL: 'activate@0.2.0' }, extra);
    const failing = hookArtifact('0.2.0', (c) => { delete c.requires; });
    const rb = setup(REC_STOCK, CRASH_LIST);
    let rr = rb.run(['install', '--artifact', failing, '--yes'], hookEnv(rb));
    const rbSyncs = fs.readFileSync(`${rb.R}.sync.log`, 'utf8').split('\n').filter(Boolean);
    check('list safety: a fresh install whose activate fails is rolled back: lists, units and tool as they were',
        rr.status !== 0 && rb.rec() === REC_STOCK && rb.crash() === CRASH_LIST && !unitThere(rb) &&
        !fs.existsSync(rb.tool('fixture-tool')) && rbSyncs.length > installSyncs, rr.out);
    const rbCut = [];
    for (let k = 1; k <= rbSyncs.length; k += 1) {
        ['FAKE_SYNC_KILL_AT', 'FAKE_SYNC_FAIL_AT'].forEach((mode) => {
            const root = setup(REC_STOCK, CRASH_LIST);
            const res = root.run(['install', '--artifact', failing, '--yes'], hookEnv(root, { [mode]: String(k) }));
            const rec = root.rec();
            if (rec !== REC_STOCK && rec !== recNew) rbCut.push(`${mode}=${k}: the list is neither as it was nor with our entries`);
            if (unitThere(root) && rec !== recNew) rbCut.push(`${mode}=${k}: a unit on disk without its entries`);
            if (mode === 'FAKE_SYNC_FAIL_AT' && !/rollback failed/.test(res.out) && (res.status === 0 || rec !== REC_STOCK || unitThere(root))) {
                rbCut.push(`${mode}=${k}: exit ${res.status}, rolled back yet not as it was`);
            }
        });
    }
    check(`list safety: at each of the ${rbSyncs.length} syncs of that install and its rollback, a power cut or a failing sync ` +
        'never leaves a unit on disk without its entries', rbSyncs.length > installSyncs && !rbCut.length, rbCut.join('\n'));

    // every unit and enablement link on disk has its name in both recmgr sections; the ones that do not
    const uncovered = (root) => {
        const sec = sectionsOf(root.rec());
        const dir = root.p('etc/systemd/system');
        const units = fs.readdirSync(dir).filter((n) => /\.(service|socket)$/.test(n) && n !== 'stock.service');
        fs.readdirSync(dir).filter((n) => /\.wants$/.test(n)).forEach((w) => units.push(...fs.readdirSync(path.join(dir, w))));
        return units.filter((u) => {
            const b = u.replace(/\.(service|socket)$/, '');
            return (sec.Whitelist || []).indexOf(b) < 0 || (sec.WhitelistExitSuccess || []).indexOf(b) < 0;
        });
    };
    const units = (root) => root.hash().lines.filter((l) => l.startsWith('etc/systemd/system')).join('\n');
    // each sync of run(root, extra) cut by a power cut and failing; the units a step leaves without entries
    const cutEverywhere = (prepare, run) => {
        const clean = prepare();
        fs.writeFileSync(`${clean.R}.sync.log`, '');
        run(clean, {});
        const n = fs.readFileSync(`${clean.R}.sync.log`, 'utf8').split('\n').filter(Boolean).length;
        const bad = [];
        for (let k = 1; k <= n; k += 1) {
            ['FAKE_SYNC_KILL_AT', 'FAKE_SYNC_FAIL_AT'].forEach((mode) => {
                const root = prepare();
                fs.writeFileSync(`${root.R}.sync.log`, '');
                run(root, { [mode]: String(k) });
                const left = uncovered(root);
                if (left.length) bad.push(`${mode}=${k}: ${left.join(', ')} without entries`);
            });
        }
        return { n, bad };
    };

    // an update whose activate fails goes back to the version before: v1 has units A and B, v2 A and C
    const twoUnits = (version, other) => hookArtifact(version, (c) => {
        delete c.requires;
        c.units = [{ name: 'fixture-tool.service', from: 'systemd/fixture-tool.service' },
            { name: `${other}.service`, from: 'systemd/fixture-tool.service' }];
        c.enable = [{ unit: `${other}.service`, target: 'multi-user.target' }];
        c.recmgr = [];
        c.restart = [];
    });
    const v1 = twoUnits('0.2.0', 'tool-b');
    const v2 = twoUnits('0.3.0', 'tool-c');
    const v1State = {};
    const onV1 = () => {
        const root = setup(REC_STOCK, CRASH_LIST);
        root.run(['install', '--artifact', v1, '--yes'], { FAKE_HOOK_LOG: `${root.R}.hooks.log` });
        v1State.rec = root.rec();
        v1State.units = units(root);
        return root;
    };
    const update = (root, extra) => root.run(['install', '--artifact', v2, '--yes'],
        Object.assign({ FAKE_HOOK_LOG: `${root.R}.hooks.log`, FAKE_HOOK_FAIL: 'activate@0.3.0' }, extra));
    const up = onV1();
    rr = update(up, {});
    check('list safety: an update whose activate fails comes back to v1: v1\'s lists and units exactly, C gone',
        rr.status !== 0 && up.rec() === v1State.rec && units(up) === v1State.units && !uncovered(up).length &&
        fs.readlinkSync(path.join(up.tool('fixture-tool'), 'current')) === 'versions/0.2.0' &&
        !fs.existsSync(up.p('etc/systemd/system/tool-c.service')), rr.out);
    const upCut = cutEverywhere(onV1, update);
    check(`list safety: at each of the ${upCut.n} syncs of that update and its rollback, a power cut or a failing sync leaves ` +
        'no unit without its entries', upCut.n > 5 && !upCut.bad.length, upCut.bad.join('\n'));

    // restore from a backup that has a unit the unit does not: the fallback's, taken by `fallback off`
    const fbState = {};
    const fbOff = () => {
        const root = setup(REC_STOCK, CRASH_LIST);
        root.run(['fallback', 'on', '--yes']);
        fbState.rec = root.rec();
        fbState.units = units(root);
        root.run(['fallback', 'off', '--yes']);
        root.backup = fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).filter((b) => /-fallback$/.test(b)).sort().pop();
        return root;
    };
    const restore = (root, extra) => root.run(['restore', root.backup, '--yes'], extra);
    const fb = fbOff();
    const fbOffRec = fb.rec();
    rr = restore(fb, {});
    check('list safety: restoring the backup `fallback off` took puts its unit, link and entries back, as before it',
        rr.status === 0 && fbOffRec.indexOf('mgu-app-fallback') < 0 && fb.rec() === fbState.rec && units(fb) === fbState.units &&
        sectionsOf(fb.rec()).Whitelist.indexOf('mgu-app-fallback') >= 0, `${rr.out}\n${fb.rec()}`);
    const fbCut = cutEverywhere(fbOff, restore);
    check(`list safety: at each of the ${fbCut.n} syncs of that restore, a power cut or a failing sync leaves no unit without its entries`,
        fbCut.n > 3 && !fbCut.bad.length, fbCut.bad.join('\n'));

    // a name another installed tool still has stays
    const shared = setup(REC_STOCK, CRASH_LIST);
    shared.run(['install', '--artifact', art, '--yes']);
    let r = shared.run(['install', '--artifact', namedTool('other-tool', '1.0.0', (c) => { c.recmgr = ['fixture-tool']; c.crashNames = ['fixture-tool']; }), '--yes']);
    const both = [shared.rec(), shared.crash()];
    r = shared.run(['uninstall', 'fixture-tool', '--yes']);
    check('list safety: uninstalling a tool keeps the names another installed tool has',
        r.status === 0 && shared.rec() === both[0] && shared.crash() === both[1], r.out);
    r = shared.run(['uninstall', 'other-tool', '--yes']);
    check('list safety: and they go with the last tool that has them',
        r.status === 0 && shared.rec() === REC_STOCK && shared.crash() === CRASH_LIST, r.out + shared.rec());

    // names the tool derives that are the firmware's are never added, nor removed
    const stock = setup(REC_STOCK, CRASH_LIST);
    write(stock.p('lib/systemd/system/monitor.service'), '[Service]\n');
    write(stock.p('usr/lib/systemd/system/mgusecdiagd.service'), '[Service]\n');
    write(stock.p('bin/sh'), 'stock shell\n');
    Object.assign(stock.env, { MGU_DEPLOY_STOCK_UNITS: `${stock.p('lib/systemd/system')}:${stock.p('usr/lib/systemd/system')}` });
    const stockUnits = (c) => {
        c.units = [{ name: 'monitor.service', from: 'systemd/fixture-tool.service' },
            { name: 'mgusecdiagd.service', from: 'systemd/fixture-tool.service' },
            { name: 'hmi.service', from: 'systemd/fixture-tool.service' }];
        c.enable = [];
        c.restart = [];
        c.recmgr = [];
        delete c.crashNames;
    };
    r = stock.run(['install', '--artifact', elfArtifact('stockish', '1.0.0', 'sh', stockUnits), '--yes']);
    check('list safety: units named as the firmware\'s (/lib and /usr/lib) or in [ForceRestartList], and a program named as one of ' +
        'the firmware\'s (sh), are not added', r.status === 0 && stock.rec() === REC_STOCK && stock.crash() === CRASH_LIST,
    `${r.out}\n${stock.rec()}\n${stock.crash()}`);
    r = stock.run(['uninstall', 'stockish', '--yes']);
    check('list safety: nor removed by the uninstall (monitor stays)',
        r.status === 0 && stock.rec() === REC_STOCK && stock.crash() === CRASH_LIST, `${r.out}\n${stock.rec()}`);

    // declared names are the tool's, whatever the firmware has: waze-on-cluster's manifest names carplay, a firmware unit
    const waze = setup(REC_STOCK, CRASH_LIST);
    write(waze.p('lib/systemd/system/carplay.service'), '[Service]\n');
    const wazeUnits = ['waze-on-cluster.socket', 'waze-on-cluster.service', 'waze-on-cluster-patchd.service',
        'waze-on-cluster-boot.service', 'waze-on-cluster-recovery.service', 'waze-on-cluster-capture.service'];
    const wazeArt = elfArtifact('waze-on-cluster', '0.7.7', 'waze-on-cluster', (c) => {
        // waze-on-cluster 0.7.7's component.json: units, enablement and recmgr names
        c.units = wazeUnits.map((name) => ({ name, from: `systemd/fixture-tool.${name.split('.').pop()}` }));
        c.enable = [{ unit: 'waze-on-cluster.socket', target: 'sockets.target' }].concat(wazeUnits.slice(1)
            .map((unit) => ({ unit, target: 'multi-user.target' })));
        c.recmgr = ['carplay', 'waze-on-cluster', 'waze-on-cluster-patchd', 'waze-on-cluster-boot', 'waze-on-cluster-recovery',
            'waze-on-cluster-capture'];
        c.restart = [];
    });
    r = waze.run(['install', '--artifact', wazeArt, '--yes']);
    const wz = sectionsOf(waze.rec());
    const wzNames = ['carplay', 'waze-on-cluster', 'waze-on-cluster-patchd', 'waze-on-cluster-boot', 'waze-on-cluster-recovery', 'waze-on-cluster-capture'];
    check('list safety: waze-on-cluster\'s carplay (a firmware unit it names) goes into both recmgr sections with its own names',
        r.status === 0 && wzNames.every((n) => wz.Whitelist.indexOf(n) >= 0 && wz.WhitelistExitSuccess.indexOf(n) >= 0) &&
        ours(waze.rec(), wzNames) === REC_STOCK, `${r.out}\n${waze.rec()}`);
    const wst = waze.status();
    check('list safety: status reports no recmgr entry missing for it',
        !wst.pending_reboot.some((x) => x.reason === 'recmgr entry missing'), JSON.stringify(wst.pending_reboot));
    r = waze.run(['uninstall', 'waze-on-cluster', '--yes']);
    check('list safety: its uninstall takes carplay out with its own names, the list as it was',
        r.status === 0 && waze.rec() === REC_STOCK && waze.crash() === CRASH_LIST, `${r.out}\n${waze.rec()}`);

    // a built-in crash name stays while its tool is installed, though a program of the firmware's has it
    const py = setup(REC_STOCK, CRASH_LIST);
    write(py.p('usr/bin/python3'), 'a python of the firmware\'s\n');
    r = py.run(['install', '--artifact', namedTool('mgu-python', '1.0.2'), '--yes']);
    const py1 = py.crash();
    const s1 = py.run(['status', '--json']);
    check('list safety: mgu-python\'s python3 goes in and stays through status, though /usr/bin/python3 exists',
        r.status === 0 && count(py1, 'python3') === 1 && s1.status === 0 && py.crash() === py1, r.out + s1.stderr);
    r = py.run(['uninstall', 'mgu-python', '--yes']);
    check('list safety: and goes with mgu-python', r.status === 0 && py.crash() === CRASH_LIST, r.out);
}

/* A new version's files are on disk before current points to them, on
 * every path that switches current: the sync before the switch saw the
 * version's files whole (in the folder they are written to), and current
 * still on the version before. */
function testDurableSwitch() {
    // what each sync of a fake root found of the watched files, by name (fake_sync.sh: " <name>=<lines>" each)
    const syncsOf = (r, names) => {
        const log = `${r.R}.sync.log`;
        return (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []).map((l) => {
            const o = {};
            names.forEach((k, i) => {
                const at = l.indexOf(` ${k}=`);
                const next = i + 1 < names.length ? l.indexOf(` ${names[i + 1]}=`, at + 1) : l.length;
                o[k] = l.slice(at + k.length + 2, next);
            });
            return o;
        });
    };
    // the last sync before current first pointed to target: current not there yet, the file whole
    const syncedFirst = (s, target, key, whole) => {
        const at = s.findIndex((x) => x.current === `->${target}`);
        const before = at < 0 ? s[s.length - 1] : s[at - 1];
        return !!before && before.current !== `->${target}` && before[key] === whole;
    };
    const joined = (file) => fs.readFileSync(file, 'utf8').split('\n').join('|');
    const conf = joined(path.join(FIXTURE_TOOL, 'fixture-tool.conf'));
    const keys = ['current', 'fixture-tool.conf'];
    // the version's folder is written as versions/<version>.partial-<pid> (the shell expands the pattern)
    const toolWatch = (root, version) => ({ FAKE_SYNC_WATCH: [root.p('var/opt/fixture-tool/current'),
        root.p(`var/opt/fixture-tool/versions/${version}.partial-*/fixture-tool.conf`)].join(' ') });

    const root = fakeRoot();
    let r = root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes'], toolWatch(root, '0.2.0'));
    let s = syncsOf(root, keys);
    check('durable switch: a first install syncs the version\'s files before current points to them',
        r.status === 0 && syncedFirst(s, 'versions/0.2.0', 'fixture-tool.conf', conf), `${r.out}\n${JSON.stringify(s)}`);
    // the same units and list entries: no rootfs window follows the switch
    fs.unlinkSync(`${root.R}.sync.log`);
    r = root.run(['install', '--artifact', toolArtifact('0.3.0'), '--yes'], toolWatch(root, '0.3.0'));
    s = syncsOf(root, keys);
    check('durable switch: an update that changes no unit or list syncs the new version\'s files before current switches',
        r.status === 0 && syncedFirst(s, 'versions/0.3.0', 'fixture-tool.conf', conf) &&
        fs.readlinkSync(root.p('var/opt/fixture-tool/current')) === 'versions/0.3.0', `${r.out}\n${JSON.stringify(s)}`);

    // a power cut at that sync: current stays on the version before; the next install goes through
    const cut = fakeRoot();
    cut.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    fs.unlinkSync(`${cut.R}.sync.log`);
    r = cut.run(['install', '--artifact', toolArtifact('0.3.0'), '--yes'], { FAKE_SYNC_KILL_AT: '1' });
    const cutCurrent = fs.readlinkSync(cut.p('var/opt/fixture-tool/current'));
    const again = cut.run(['install', '--artifact', toolArtifact('0.3.0'), '--yes']);
    check('durable switch: a power cut at the sync before the switch leaves current on the version before; the install then goes through',
        r.signal === 'SIGKILL' && cutCurrent === 'versions/0.2.0' && again.status === 0 &&
        fs.readlinkSync(cut.p('var/opt/fixture-tool/current')) === 'versions/0.3.0' &&
        !fs.readdirSync(cut.p('var/opt/fixture-tool/versions')).some((n) => /partial|old/.test(n)),
    `${r.signal} ${cutCurrent}\n${again.out}`);
    // a failing sync there fails the update before the switch
    const failing = fakeRoot();
    failing.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    fs.unlinkSync(`${failing.R}.sync.log`);
    r = failing.run(['install', '--artifact', toolArtifact('0.3.0'), '--yes'], { FAKE_SYNC_FAIL_AT: '1' });
    check('durable switch: a failing sync before the switch fails the update; current stays on the version before',
        r.status !== 0 && fs.readlinkSync(failing.p('var/opt/fixture-tool/current')) === 'versions/0.2.0', r.out);

    // the deploy tool installing itself
    const self = fakeRoot();
    const version = /var VERSION = '([^']+)'/.exec(fs.readFileSync(UNIT_JS, 'utf8'))[1];
    const selfDir = self.p('var/opt/mgu-deploy');
    r = self.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes'],
        { FAKE_SYNC_WATCH: [path.join(selfDir, 'current'), path.join(selfDir, 'versions', `${version}.partial-*`, 'mgu-deploy.sh')].join(' ') });
    s = syncsOf(self, ['current', 'mgu-deploy.sh']);
    check('durable switch: the deploy tool syncs its own files before its current points to them',
        r.status === 0 && fs.readlinkSync(path.join(selfDir, 'current')) === `versions/${version}` &&
        syncedFirst(s, `versions/${version}`, 'mgu-deploy.sh', joined(path.join(selfDir, 'versions', version, 'mgu-deploy.sh'))),
    `${r.out}\n${JSON.stringify(s)}`);
}

/* recmgr's list keeps the firmware's entries: only the names this tool
 * added come out, by section, at an update, a rollback and an uninstall. */
function testRecmgrOwned() {
    const setup = (recText, firmware) => {
        const root = fakeRoot();
        Object.assign(root.env, { MGU_DEPLOY_FAKE_SH_WINDOW: '1', MGU_DEPLOY_MOUNT: path.join(HERE, 'fake_mount.sh') });
        write(root.p('etc/recmgr-restartlist.conf'), recText);
        if (firmware) write(root.p('etc/os-release-id-dlt'), `${firmware}\n`);
        root.rec = () => fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
        root.owned = () => readJsonOrNull(root.p('var/opt/mgu-deploy/recmgr-names.json'));
        return root;
    };
    // carplay as the firmware lists it: in both sections, or in [Whitelist] only
    const BOTH = REC_STOCK.replace('[WhitelistExitSuccess]\n', '[WhitelistExitSuccess]\ncarplay\n').replace('[Whitelist]\n', '[Whitelist]\ncarplay\n');
    const HALF = REC_STOCK.replace('[Whitelist]\n', '[Whitelist]\ncarplay\n');
    const tool = (version, names) => namedTool('cp-tool', version, (c) => { c.recmgr = names; });
    const v1 = tool('1.0.0', ['carplay', 'cp-tool']);
    const has = (text, sec, n) => (sectionsOf(text)[sec] || []).indexOf(n) >= 0;
    const both = (text, n) => has(text, 'Whitelist', n) && has(text, 'WhitelistExitSuccess', n);

    let root = setup(BOTH);
    let r = root.run(['install', '--artifact', v1, '--yes']);
    check('recmgr names: an install adds only what the list lacks and records just that',
        r.status === 0 && both(root.rec(), 'cp-tool') && root.rec().split('\ncarplay\n').length === 3 && root.owned() &&
        JSON.stringify(root.owned().names) === JSON.stringify({ Whitelist: ['cp-tool'], WhitelistExitSuccess: ['cp-tool'] }),
    `${r.out}\n${root.rec()}\n${JSON.stringify(root.owned())}`);
    r = root.run(['install', '--artifact', tool('1.0.1', ['cp-tool']), '--yes']);
    check('recmgr names: an update that drops a firmware name it listed keeps it in the list',
        r.status === 0 && both(root.rec(), 'carplay') && both(root.rec(), 'cp-tool') && r.out.includes('recmgr list: kept carplay in [Whitelist] and [WhitelistExitSuccess] (in the stock list)\n'),
        `${r.out}\n${root.rec()}`);
    r = root.run(['install', '--artifact', tool('1.0.2', ['carplay', 'cp-tool', 'cp-extra']), '--yes']);
    r = root.run(['rollback', 'cp-tool', '--yes']);
    check('recmgr names: a rollback takes out the name it added for the version going, the firmware\'s stay',
        r.status === 0 && !has(root.rec(), 'Whitelist', 'cp-extra') && !has(root.rec(), 'WhitelistExitSuccess', 'cp-extra') &&
        both(root.rec(), 'carplay') && both(root.rec(), 'cp-tool'), `${r.out}\n${root.rec()}`);
    r = root.run(['uninstall', 'cp-tool', '--yes']);
    check('recmgr names: the uninstall leaves the list as the firmware\'s, carplay in it, byte for byte',
        r.status === 0 && root.rec() === BOTH && r.out.includes('recmgr list: kept carplay in [Whitelist] and [WhitelistExitSuccess] (in the stock list)\n') &&
        JSON.stringify(root.owned().names) === JSON.stringify({ Whitelist: [], WhitelistExitSuccess: [] }), `${r.out}\n${root.rec()}`);

    // a name the firmware has in one section: added to the other, and taken out of that one only
    root = setup(HALF);
    r = root.run(['install', '--artifact', v1, '--yes']);
    const halfOwned = root.owned();
    check('recmgr names: a firmware name missing from one section goes into it, recorded for that section only',
        r.status === 0 && both(root.rec(), 'carplay') && root.rec().split('\ncarplay\n').length === 3 &&
        halfOwned.names.WhitelistExitSuccess.indexOf('carplay') >= 0 && halfOwned.names.Whitelist.indexOf('carplay') < 0,
    `${r.out}\n${root.rec()}\n${JSON.stringify(halfOwned)}`);
    r = root.run(['uninstall', 'cp-tool', '--yes']);
    check('recmgr names: its uninstall takes carplay out of that section only, the list as the firmware\'s',
        r.status === 0 && root.rec() === HALF, `${r.out}\n${root.rec()}`);

    // an install from before the record: the stock backup tells the firmware's names from ours
    root = setup(HALF);
    root.run(['install', '--artifact', v1, '--yes']);
    fs.unlinkSync(root.p('var/opt/mgu-deploy/recmgr-names.json'));
    r = root.run(['uninstall', 'cp-tool', '--yes']);
    check('recmgr names: without a record, the uninstall takes out only the names the stock backup\'s list lacks',
        r.status === 0 && root.rec() === HALF, `${r.out}\n${root.rec()}`);

    // without a record and a stock backup, nothing goes, and that is said
    root = setup(HALF);
    root.run(['install', '--artifact', v1, '--yes']);
    let installed = root.rec();
    fs.unlinkSync(root.p('var/opt/mgu-deploy/recmgr-names.json'));
    fs.rmSync(root.p('var/opt/mgu-deploy/backups/stock'), { recursive: true });
    r = root.run(['uninstall', 'cp-tool', '--yes']);
    check('recmgr names: without a record or a stock backup, the uninstall keeps the names and says why',
        r.status === 0 && root.rec() === installed && !fs.existsSync(root.tool('cp-tool')) &&
        r.out.includes('recmgr list: kept carplay in [Whitelist] and [WhitelistExitSuccess] (no record, and no stock backup from this firmware), ' +
            'cp-tool in [Whitelist] and [WhitelistExitSuccess] (no record, and no stock backup from this firmware)\n'),
    `${r.out}\n${root.rec()}`);

    // a stock backup from another firmware tells nothing
    root = setup(HALF, 'fw-A');
    root.run(['install', '--artifact', v1, '--yes']);
    installed = root.rec();
    fs.unlinkSync(root.p('var/opt/mgu-deploy/recmgr-names.json'));
    write(root.p('etc/os-release-id-dlt'), 'fw-B\n');
    r = root.run(['uninstall', 'cp-tool', '--yes']);
    check('recmgr names: without a record, a stock backup from another firmware keeps the names',
        r.status === 0 && root.rec() === installed && r.out.includes('recmgr list: kept carplay in [Whitelist] (in the stock list), ' +
            'cp-tool in [Whitelist] and [WhitelistExitSuccess] (no record, and no stock backup from this firmware), carplay in [WhitelistExitSuccess] (no record, and no stock backup from this firmware)\n'),
        `${r.out}\n${root.rec()}`);

    // a record from another firmware: the firmware update put its own list back
    root = setup(HALF, 'fw-A');
    root.run(['install', '--artifact', v1, '--yes']);
    installed = root.rec();
    write(root.p('etc/os-release-id-dlt'), 'fw-B\n');
    r = root.run(['uninstall', 'cp-tool', '--yes']);
    check('recmgr names: a record written under another firmware takes nothing out, and says so',
        r.status === 0 && root.rec() === installed &&
        r.out.includes("cp-tool in [Whitelist] and [WhitelistExitSuccess] (mgu-deploy's record is from other firmware)"), `${r.out}\n${root.rec()}`);
    // a record that does not hold a name in the list: an earlier deploy tool may have added it
    root = setup(HALF);
    root.run(['install', '--artifact', v1, '--yes']);
    installed = root.rec();
    write(root.p('var/opt/mgu-deploy/recmgr-names.json'), JSON.stringify({ firmware: null, names: { Whitelist: [], WhitelistExitSuccess: [] } }) + '\n');
    r = root.run(['uninstall', 'cp-tool', '--yes']);
    check('recmgr names: a name the record does not hold stays, said as not in the record',
        r.status === 0 && root.rec() === installed && r.out.includes('recmgr list: kept carplay in [Whitelist] (in the stock list), ' +
            "cp-tool in [Whitelist] and [WhitelistExitSuccess] (not in mgu-deploy's record; an earlier version may have added it), " +
            "carplay in [WhitelistExitSuccess] (not in mgu-deploy's record; an earlier version may have added it)\n"), `${r.out}\n${root.rec()}`);
    // the next edit under this firmware records what it adds
    root = setup(HALF, 'fw-A');
    root.run(['install', '--artifact', v1, '--yes']);
    write(root.p('etc/os-release-id-dlt'), 'fw-B\n');
    write(root.p('etc/recmgr-restartlist.conf'), HALF);
    r = root.run(['status', '--json']);
    const fwOwned = root.owned();
    const uninstall = root.run(['uninstall', 'cp-tool', '--yes']);
    check('recmgr names: after a firmware update, status adds the names back and records them under that firmware; the uninstall takes them out',
        r.status === 0 && fwOwned.firmware === 'fw-B' && fwOwned.names.WhitelistExitSuccess.join() === 'carplay,cp-tool' &&
        fwOwned.names.Whitelist.join() === 'cp-tool' && uninstall.status === 0 && root.rec() === HALF,
    `${r.stderr}\n${JSON.stringify(fwOwned)}\n${uninstall.out}\n${root.rec()}`);

    // an update rolled back puts the record back with the list
    root = setup(HALF);
    const hooked = (version, names) => hookArtifact(version, (c) => { delete c.requires; c.recmgr = names; });
    const hookEnv = { FAKE_HOOK_LOG: `${root.R}.hooks.log` };
    root.run(['install', '--artifact', hooked('0.2.0', ['carplay', 'fixture-tool']), '--yes'], hookEnv);
    const before = { rec: root.rec(), owned: JSON.stringify(root.owned()) };
    r = root.run(['install', '--artifact', hooked('0.3.0', ['fixture-tool', 'cp-extra']), '--yes'],
        Object.assign({ FAKE_HOOK_FAIL: 'activate@0.3.0' }, hookEnv));
    check('recmgr names: an update rolled back leaves the list and the record as before it',
        r.status !== 0 && /rolling back/.test(r.out) && before.owned.indexOf('carplay') >= 0 &&
        root.rec() === before.rec && JSON.stringify(root.owned()) === before.owned,
    `${r.out}\n${root.rec()}\n${before.owned}\n${JSON.stringify(root.owned())}`);
}

function testInternet() {
    const root = fakeRoot();
    const uids = root.p('var/opt/mgu-uplink/uids.d/net-tool');
    const apps = root.p('var/opt/mgu-uplink/apps.d/net_app');
    let r = root.run(['install', '--artifact', namedTool('net-tool', '1.0.0', (c) => { c.internet = true; c.uids = [12993, 12994]; }), '--yes']);
    check('internet: without mgu-uplink no drop-in is written', r.status === 0 && !fs.existsSync(root.p('var/opt/mgu-uplink')), r.out);
    r = root.run(['install', '--artifact', namedTool('mgu-uplink', '1.0.0'), '--yes']);
    check('internet: installing mgu-uplink writes the drop-ins of what is installed', r.status === 0 &&
        fs.readFileSync(uids, 'utf8') === '12993\n12994\n' && mode(uids) === 0o644, r.out);
    r = root.run(['install', '--artifact', appArtifact('net_app', '1.0.0', true, { mguInternet: true }), '--yes']);
    check('internet: an app with "mguInternet": true gets apps.d/<id>', r.status === 0 && fs.readFileSync(apps, 'utf8') === 'net_app\n', r.out);
    r = root.run(['uninstall', 'net_app', '--yes']);
    check('internet: uninstalling the app removes its drop-in', r.status === 0 && !fs.existsSync(apps), r.out);
    r = root.run(['uninstall', 'net-tool', '--yes']);
    check('internet: uninstalling the tool removes its drop-in', r.status === 0 && !fs.existsSync(uids) &&
        fs.existsSync(root.p('var/opt/mgu-uplink/current')), r.out);
    const bad = fakeRoot().run(['install', '--artifact', namedTool('net-tool', '1.0.0', (c) => { c.internet = true; c.uids = []; }), '--yes']);
    check('internet: "internet" without uids is refused', bad.status === 2 && bad.out.includes('needs "uids"'), bad.out);
    const outside = fakeRoot().run(['install', '--artifact', namedTool('net-tool', '1.0.0', (c) => { c.internet = true; c.uids = '../x'; }), '--yes']);
    check('internet: a uids file outside the tool\'s folder is refused', outside.status === 2 && outside.out.includes('needs "uids"'), outside.out);
    // a tool that picks its uids on the unit keeps them in a file of its own
    const own = root.p('var/opt/mgu-uplink/uids.d/own-tool');
    r = root.run(['install', '--artifact', namedTool('own-tool', '1.0.0', (c) => { c.internet = true; c.uids = 'state/internet-uids'; }), '--yes']);
    check('internet: a uids file the tool has not written yet gives no drop-in', r.status === 0 && !fs.existsSync(own), r.out);
    fs.mkdirSync(root.p('var/opt/own-tool/state'));
    fs.writeFileSync(root.p('var/opt/own-tool/state/internet-uids'), '12708\n');
    r = root.run(['install', '--artifact', namedTool('mgu-uplink', '1.0.1'), '--yes']);
    check('internet: installing mgu-uplink writes the uids a tool keeps in its file',
        r.status === 0 && fs.readFileSync(own, 'utf8') === '12708\n', r.out);
    fs.writeFileSync(own, '12709\n');
    fs.writeFileSync(root.p('var/opt/own-tool/state/internet-uids'), '12709\n');
    r = root.run(['install', '--artifact', namedTool('net-tool', '1.0.0', (c) => { c.internet = true; c.uids = [12993]; }), '--yes']);
    check('internet: a drop-in the tool rewrote to match its file is kept', r.status === 0 &&
        fs.readFileSync(own, 'utf8') === '12709\n', r.out);
}

function testSourcesAndDonor() {
    const root = donorRoot();
    const sources = fs.readFileSync(path.join(DEPLOY, 'sources.json'));
    const file = root.p('var/opt/mgu-updater/sources.json');
    const runIn = (args, input, extra) => {
        const r = cp.spawnSync(UNIT_NODE, [UNIT_JS].concat(args),
            { encoding: 'utf8', env: Object.assign({}, root.env, extra || {}), input });
        r.out = `${r.stdout}${r.stderr}`;
        return r;
    };
    let r = runIn(['updater-sources'], sources);
    check('sources: nothing written while mgu-updater is not installed', r.status === 0 && r.out.includes('not installed') &&
        !fs.existsSync(root.p('var/opt/mgu-updater')), r.out);
    root.run(['install', '--artifact', namedTool('mgu-updater', '0.2.0'), '--yes']);
    r = runIn(['updater-sources'], sources);
    check('sources: seeded, root\'s alone', r.status === 0 && JSON.stringify(readJson(file)) === JSON.stringify(JSON.parse(sources)) &&
        mode(file) === 0o600, r.out);
    r = runIn(['updater-sources'], '{"schema":1,"sources":[{"id":"other","type":"https","url":"https://x/catalog.json"}]}');
    check('sources: an existing sources.json is kept', r.status === 0 && r.out.includes('kept') &&
        JSON.stringify(readJson(file)) === JSON.stringify(JSON.parse(sources)), r.out);
    [['not json', 'not JSON'], ['{"schema":1,"sources":[{"id":"a","type":"ftp"}]}', 'distinct ids'],
        ['{"schema":1,"sources":[{"id":"a","type":"file"},{"id":"a","type":"file"}]}', 'distinct ids']].forEach(([input, why]) => {
        const bad = runIn(['updater-sources'], input);
        check(`sources: refused (${why}), exit 2`, bad.status === 2 && bad.out.includes(why), bad.out);
    });
    const run = root.p('run/mgu-deploy');
    r = runIn(['sdk-donor', '--json'], '', { MGU_DEPLOY_RUN: run });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch (e) { /* checked below */ }
    check('donor: sdk-donor --json names a readable copy of the donor bundle in an app folder\'s layout', r.status === 0 && j &&
        j.path === path.join(run, 'sdk-donor', 'javascript', 'app.js') && fs.readFileSync(j.path, 'utf8') === donor.bundle() &&
        mode(j.path) === 0o644 && mode(path.join(run, 'sdk-donor')) === 0o755 && j.donor === 'donor_app@1.0.0.tgz:javascript/app.js' &&
        readJson(path.join(run, 'sdk-donor', 'package.json')).dependencies['oap-sdk'] === '9.8.7', r.out);
    const mod = j && j.module;
    let api = null;
    try { api = Object.keys(require(path.join(mod, 'index.js'))); } catch (e) { /* checked below */ }
    check('donor: sdk-donor --json also names the oap-sdk module generated from it (index.js, package.json)', !!mod &&
        mod === path.join(run, 'sdk-donor', 'oap-sdk') && mode(path.join(mod, 'index.js')) === 0o644 && mode(mod) === 0o755 &&
        readJson(path.join(mod, 'package.json')).version === '9.8.7' && api && api.indexOf('OnlineApp') >= 0, r.out);
    const none = fakeRoot().run(['sdk-donor', '--json'], { MGU_DEPLOY_RUN: run + '-none' });
    check('donor: no donor on the unit, exit 2', none.status === 2 && none.out.includes('no donor holds the oap-sdk core'), none.out);
}

/* Sources and credentials belong to the updater even when restoring a
 * manifest made by a deploy version that copied them. */
function testUpdaterStateRestore() {
    const root = fakeRoot();
    root.run(['install', '--artifact', namedTool('mgu-updater', '0.2.0'), '--yes']);
    const base = root.p('var/opt/mgu-updater');
    const sources = path.join(base, 'sources.json');
    const credential = path.join(base, 'credentials', 'mgu-store');
    const other = path.join(base, 'credentials', 'other');
    write(sources, '{"schema":1,"sources":[{"id":"owner","type":"file"}]}');
    write(credential, TOKEN);
    write(other, 'OTHER_FIXTURE_TOKEN');
    const legacy = root.p('var/opt/mgu-deploy/backups/stock/manifest.json');
    const manifest = readJson(legacy);
    const absent = (p) => ({ path: p, kind: 'absent' });
    manifest.entries.push(absent(sources), absent(credential), absent(other), absent(path.dirname(credential)));
    fs.writeFileSync(legacy, JSON.stringify(manifest));
    let r = root.run(['restore', 'stock', '--yes']);
    check('restore: legacy absent entries and updater removal preserve sources and every credential', r.status === 0 &&
        fs.readFileSync(sources, 'utf8').includes('owner') && fs.readFileSync(credential, 'utf8') === TOKEN &&
        fs.readFileSync(other, 'utf8') === 'OTHER_FIXTURE_TOKEN' && !fs.existsSync(path.join(base, 'current')), r.out);
    const oldFile = root.p('var/opt/mgu-deploy/backups/stock/files/old-token');
    write(oldFile, 'OLD_FIXTURE_TOKEN');
    manifest.entries = manifest.entries.filter((e) => !e.path.includes('/credentials') && e.path !== sources);
    manifest.entries.push({ path: credential, kind: 'file', stored: 'files/old-token', sha256: sha256(Buffer.from('OLD_FIXTURE_TOKEN')), mode: 0o600 });
    fs.writeFileSync(legacy, JSON.stringify(manifest));
    r = root.run(['restore', 'stock', '--yes']);
    check('restore: legacy stored credentials are neither restored nor verified against the current token', r.status === 0 &&
        fs.readFileSync(credential, 'utf8') === TOKEN, r.out);
    const backups = root.p('var/opt/mgu-deploy/backups');
    check('restore: new snapshots contain no updater state even when restoring a legacy manifest',
        fs.readdirSync(backups).filter((d) => d !== 'stock').every((d) =>
            !readJson(path.join(backups, d, 'manifest.json')).entries.some((e) =>
                e.path === sources || e.path.indexOf(path.join(base, 'credentials')) === 0)));
}

/* ---- mgu-install ------------------------------------------------------------------------------ */

const MGU_INSTALL = path.join(DEPLOY, 'mgu-install.js');
const STORE_REPO = 'robertnisipeanu/mgu-store';

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* The stand-in GitHub API (fake_github.js) on 127.0.0.1; config is
 * rewritten with set(). */
function fakeGithub(config) {
    const dir = fs.mkdtempSync(path.join(T, 'gh-'));
    const file = path.join(dir, 'config.json');
    const log = path.join(dir, 'log');
    const portFile = path.join(dir, 'port');
    fs.writeFileSync(file, JSON.stringify(config));
    fs.writeFileSync(log, '');
    const child = cp.spawn(process.execPath, [path.join(HERE, 'fake_github.js'), file, log, portFile], { stdio: 'inherit' });
    inplaceChildren.push(child);
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i += 1) {
        sleepSync(25);
    }
    return {
        api: `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8')}`,
        set: (c) => fs.writeFileSync(file, JSON.stringify(c)),
        requests: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
        reset: () => fs.writeFileSync(log, ''),
        stop: () => child.kill()
    };
}

/* A published catalog's entry for an artifact served as asset n. */
function publishedEntry(api, file, n, kind, extra) {
    const [id, version] = path.basename(file).replace(/\.tgz$/, '').split('@');
    const data = fs.readFileSync(file);
    return Object.assign({ id, kind, title: id, description: `${id} for the tests`, version,
        artifact: { name: `${id}@${version}.tgz`, size: data.length, sha256: sha256(data), url: `${api}/repos/${STORE_REPO}/releases/assets/${n}` } }, extra);
}

/* The Store's source package, built with its release.json command when it is not there yet. */
function storeArtifact() {
    const c = require('../../release/release.js').components(path.join(DEPLOY, '..')).find((x) => x.id === 'robertn_store');
    const file = path.join(DEPLOY, '..', c.artifact);
    if (!fs.existsSync(file)) {
        cp.execSync(c.release.build, { cwd: path.join(DEPLOY, '..', c.dir), stdio: ['ignore', 2, 2] });
    }
    const out = path.join(fs.mkdtempSync(path.join(T, 'store-')), `robertn_store@${c.version}.tgz`);
    fs.copyFileSync(file, out);
    return out;
}

/* The mgu-store release as fake_github serves it: the deploy tool, app-privacy, the
 * Store's source package, stand-ins for the updater and the uplink. */
function fakeRelease(api) {
    const art = fs.mkdtempSync(path.join(T, 'rel-'));
    hu(['artifact', DEPLOY, '--out', art]);
    hu(['artifact', path.join(DEPLOY, '..', 'native', 'app-privacy'), '--out', art]);
    const privacy = fs.readdirSync(art).find((n) => n.startsWith('app-privacy@'));
    const files = [path.join(art, `mgu-deploy@${VERSION}.tgz`), path.join(art, privacy), namedTool('mgu-updater', '0.2.0'),
        namedTool('mgu-uplink', '0.4.0'), storeArtifact(), namedTool('mgu-render', '0.1.0', (c) => { c.mguProvides = 'renderer'; })];
    const entries = [publishedEntry(api, files[0], 0, 'tool'), publishedEntry(api, files[1], 1, 'tool'), publishedEntry(api, files[2], 2, 'tool'),
        publishedEntry(api, files[3], 3, 'tool', { optional: true, uninstallable: true }),
        publishedEntry(api, files[4], 4, 'app', { build: 'unit', requires: { 'mgu-deploy': '0.2.0' } }),
        publishedEntry(api, files[5], 5, 'tool', { optional: true, uninstallable: true })];
    const catalog = path.join(art, 'catalog.json');
    fs.writeFileSync(catalog, JSON.stringify({ schema: 2, commit: 'c0ffee', components: entries }, null, 2));
    files.push(catalog);
    return { files, entries, catalogIndex: files.length - 1, dir: art };
}

/* bin/ with ssh (fake_ssh_exec.js against root), systemctl and gh stand-ins. */
function installBin(root) {
    const bin = fs.mkdtempSync(path.join(T, 'bin-'));
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(HERE, 'fake_ssh_exec.js')}' "$@"\n`, { mode: 0o755 });
    fs.symlinkSync(path.join(HERE, 'fake_systemctl.sh'), path.join(bin, 'systemctl'));
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2" = "auth token" ] && [ -n "$FAKE_GH_TOKEN" ] && echo "$FAKE_GH_TOKEN" && exit 0\nexit 1\n', { mode: 0o755 });
    // the head unit's restart request: its arguments in nsm.log, nsm.out (when there) as its answer
    fs.writeFileSync(path.join(bin, 'nsm_control'), `#!/bin/sh\necho "$*" >> '${bin}/nsm.log'\ncat '${bin}/nsm.out' 2>/dev/null\nexit 0\n`, { mode: 0o755 });
    const envFile = path.join(bin, 'env.json');
    if (root) {
        fs.writeFileSync(envFile, JSON.stringify(Object.assign({}, root.env, { PATH: `${bin}:${root.env.PATH}` })));
    }
    return { bin, envFile };
}

/* A server on 127.0.0.1 that greets like an sshd, in its own process (the
 * tests block this one); its port. */
function bannerServer() {
    const portFile = path.join(fs.mkdtempSync(path.join(T, 'banner-')), 'port');
    const child = cp.spawn(process.execPath, ['-e', `const s = require('net').createServer((c) => { c.on('error', () => {}); c.end('SSH-2.0-OpenSSH_7.8\\r\\n'); });
s.listen(0, '127.0.0.1', () => require('fs').writeFileSync(process.argv[1], String(s.address().port)));`, portFile], { stdio: 'inherit' });
    inplaceChildren.push(child);
    for (let i = 0; i < 200 && !(fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8')); i += 1) {
        sleepSync(25);
    }
    return fs.readFileSync(portFile, 'utf8');
}

/* The restart requests the head unit got, through bin/nsm_control. */
function nsmCalls(bin) {
    const f = path.join(bin.bin, 'nsm.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

/* mgu-install in a terminal (a pseudo-terminal from python3's pty): answer
 * typed once "[y/N]" shows ('' for Enter, null for nothing; the run then
 * ends without input), after writing file.text to file.path when given.
 * { status, out, calls } */
const IN_TERMINAL = `import json, os, pty, select, sys
argv, answer, file = json.loads(sys.argv[1]), json.loads(sys.argv[2]), json.loads(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
out, sent = b'', False
while True:
    if not select.select([fd], [], [], 120)[0]:
        break
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    out += d
    if not sent and answer is not None and b'[y/N]' in out:
        if file:
            open(file['path'], 'w').write(file['text'])
        os.write(fd, answer.encode() + b'\\r')
        sent = True
st = os.waitpid(pid, 0)[1]
sys.stdout.buffer.write(out)
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128)
`;
function mguInstallTerminal(args, opts, answer, file) {
    const log = path.join(fs.mkdtempSync(path.join(T, 'ssh-')), 'log');
    fs.writeFileSync(log, '');
    const env = Object.assign({}, process.env, { PATH: `${opts.bin.bin}:${process.env.PATH}`, FAKE_SSH_LOG: log,
        FAKE_SSH_ENV: opts.bin.envFile, MGU_INSTALL_GITHUB_API: opts.api, FAKE_GH_TOKEN: '' }, opts.env || {});
    if (!(opts.env && 'CI' in opts.env)) {
        delete env.CI;
    }
    // opts.command: the whole command line instead of mgu-install with args
    const argv = opts.command || (process.env.MGU_TEST_INSTALL_EXE ? [process.env.MGU_TEST_INSTALL_EXE] : [process.execPath, MGU_INSTALL]).concat(args);
    const r = cp.spawnSync('python3', ['-c', IN_TERMINAL, JSON.stringify(argv), JSON.stringify(answer), JSON.stringify(file || null)], { encoding: 'utf8', env });
    r.out = String(r.stdout).replace(/\r\n/g, '\n');
    r.calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] !== '-V');
    return r;
}

function mguInstall(args, opts) {
    const log = path.join(fs.mkdtempSync(path.join(T, 'ssh-')), 'log');
    fs.writeFileSync(log, '');
    const env = Object.assign({}, process.env, { PATH: `${opts.bin.bin}:${process.env.PATH}`, FAKE_SSH_LOG: log,
        FAKE_SSH_ENV: opts.bin.envFile, MGU_INSTALL_GITHUB_API: opts.api, FAKE_GH_TOKEN: '' }, opts.env || {});
    // stdin: the script itself on stdin (node -), with no terminal; MGU_TEST_INSTALL_EXE: a standalone executable of it
    const r = opts.stdin ? cp.spawnSync(process.execPath, ['-'].concat(args), { encoding: 'utf8', env, input: fs.readFileSync(MGU_INSTALL), detached: true }) :
        process.env.MGU_TEST_INSTALL_EXE ? cp.spawnSync(process.env.MGU_TEST_INSTALL_EXE, args, { encoding: 'utf8', env, input: opts.input || '' }) :
        cp.spawnSync(process.execPath, [MGU_INSTALL].concat(args), { encoding: 'utf8', env, input: opts.input || '' });
    r.out = `${r.stdout}${r.stderr}`;
    r.calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] !== '-V');
    return r;
}

/* first-install on a unit whose coding keeps MainApp from starting: it
 * stops after one read-only look, before any download or anything sent. */
function testMguInstallCoding() {
    const gh = fakeGithub({ files: [], repos: {} });
    try {
        const rel = fakeRelease(gh.api);
        gh.set({ files: rel.files, repos: { [STORE_REPO]: { catalog: rel.catalogIndex } } });
        const unit = (flags, opts) => {
            const root = donorRoot(opts);
            writeCoding(root, flags);
            return { root, opts: { bin: installBin(root), api: gh.api } };
        };
        const d = unit(0x0a, { noManager: true });
        const before = d.root.hash();
        gh.reset();
        let r = mguInstall(['first-install', '--host', '10.0.0.9'], d.opts);
        check('mgu-install first-install, default coding: refused (exit 2) saying what to do', r.status === 2 &&
            r.stdout === 'The head unit\'s coding is missing: it holds default values. This often happens after enabling SSH or flashing. ' +
            'Restore the head unit\'s coding from a backup (BimmerCode, E-Sys or ISTA) or have HU_MGU coded to the car, ' +
            'restart the head unit, then run the install again.\n', r.out);
        check('mgu-install first-install, default coding: one read-only command, no download, the unit unchanged',
            r.calls.length === 1 && !/["\\]/.test(r.calls[0][r.calls[0].length - 1]) && !gh.requests().length &&
            d.root.hash().hash === before.hash, `${r.out}\n${JSON.stringify(r.calls)}\n${treeDiff(before, d.root.hash())}`);
        const inv = unit(0x00, { noManager: true });
        r = mguInstall(['first-install', '--host', '10.0.0.9'], inv.opts);
        check('mgu-install first-install, invalid coding: refused the same way', r.status === 2 &&
            r.stdout.startsWith('The head unit\'s coding is missing: it is not valid.') && r.calls.length === 1, r.out);
        // a running app manager (node running MainApp's main.js): the coding check lets it go on
        for (const dir of ['oap-mainapp', 'oap-mainapp21']) {
            const m = unit(0x0a, {});
            write(m.root.p('proc/4000/cmdline'), `/usr/bin/node\0--max-old-space-size=200\0/usr/lib/${dir}/src/main.js\0`);
            r = mguInstall(['first-install', '--host', '10.0.0.9', '--no-uplink', '--no-renderer'], m.opts);
            check(`mgu-install first-install, default coding with ${dir} running: installs`, r.status === 0 &&
                !r.out.includes('coding is missing'), r.out.slice(-2000));
        }
        // no coding segment: nothing to go by, so not refused
        const none = donorRoot();
        r = mguInstall(['first-install', '--host', '10.0.0.9', '--no-uplink', '--no-renderer'], { bin: installBin(none), api: gh.api });
        check('mgu-install first-install, no coding segment: installs', r.status === 0 && !r.out.includes('coding is missing'), r.out.slice(-2000));
    } finally {
        gh.stop();
    }
}

/* first-install and token against a fake root, the release from the stand-in GitHub. */
function testMguInstall() {
    const gh = fakeGithub({ files: [], repos: {} });
    try {
        const rel = fakeRelease(gh.api);
        const config = { files: rel.files, repos: { [STORE_REPO]: { token: TOKEN, catalog: rel.catalogIndex } } };
        gh.set(config);
        const root = donorRoot();
        // the car's coding, no app manager seen by the installer's check
        writeCoding(root, 0x09);
        const bin = installBin(root);
        const opts = { bin, api: gh.api };
        let r = mguInstall(['first-install', '--host', '10.0.0.9', '--token', '--no-uplink', '--no-renderer'],
            Object.assign({ input: `${TOKEN}\n` }, opts));
        const st = r.status === 0 ? root.status() : { components: [] };
        const has = (id) => st.components.some((x) => x.id === id);
        check('mgu-install first-install --no-uplink --no-renderer: the release\'s tools and the Store, built on the unit, without the two',
            r.status === 0 && ['app-privacy', 'mgu-updater', 'mgu-deploy', 'robertn_store'].every(has) && !has('mgu-uplink') &&
            !has('mgu-render') && r.out.includes('built robertn_store'), r.out.slice(-3000));
        check('mgu-install first-install: the deploy tool is the release\'s, installed from its own files',
            fs.readlinkSync(root.p('var/opt/mgu-deploy/current')) === `versions/${VERSION}` &&
            fs.readFileSync(root.p(`var/opt/mgu-deploy/versions/${VERSION}/mgu-deploy.js`)).equals(fs.readFileSync(UNIT_JS)));
        check('mgu-install first-install: seeds the sources and adds the token, root\'s alone',
            JSON.parse(fs.readFileSync(root.p('var/opt/mgu-updater/sources.json'), 'utf8')).sources[0].repo === STORE_REPO &&
            mode(root.p('var/opt/mgu-updater/sources.json')) === 0o600 &&
            Object.values(tokenTexts(root)).join() === TOKEN);
        check('mgu-install first-install: ends saying a restart finishes setup while the updater is not running; with no terminal, no question',
            r.stdout.endsWith('\nRestart the head unit to finish setup.\n') && !r.out.includes('[y/N]') && !nsmCalls(bin).length, r.out.slice(-500));
        check('mgu-install first-install: the token is in no output and no ssh argument; it went on stdin to updater-token',
            !r.out.includes(TOKEN) && r.calls.every((a) => !a.join(' ').includes(TOKEN)) &&
            r.calls.some((a) => / updater-token( |$)/.test(a[a.length - 1])), r.calls.map((a) => a[a.length - 1]).join('\n'));
        const reqs = gh.requests();
        check('mgu-install first-install: anonymous first, then the token, to the API host only; never to the host a download redirects to',
            reqs[0].path === `/repos/${STORE_REPO}` && reqs[0].auth === null && reqs[1].auth === `Bearer ${TOKEN}` &&
            reqs.filter((x) => x.path.startsWith('/blob/')).length === 5 && reqs.filter((x) => x.path.startsWith('/blob/')).every((x) => x.auth === null),
            JSON.stringify(reqs));
        check('mgu-install first-install: ssh to the given host as root on port 22, with ssh-rsa allowed for the unit\'s sshd and its host key neither asked about nor kept',
            r.calls.every((a) => a.includes('root@10.0.0.9') && a[0] === '-p' && a[1] === '22' && a.includes('HostKeyAlgorithms=+ssh-rsa') &&
                a.includes('StrictHostKeyChecking=no') && a.includes('UserKnownHostsFile=/dev/null')),
            JSON.stringify(r.calls[0]));
        check('mgu-install first-install: no remote command carries a double quote or a backslash (Windows passes them through its own quoting)',
            r.calls.every((a) => !/["\\]/.test(a[a.length - 1])), r.calls.map((a) => a[a.length - 1]).join('\n'));
        check('mgu-install first-install: leaves no staging folder', !fs.readdirSync(root.p('var/opt')).some((n) => /^mgu-deploy-kit-/.test(n)));
        check('mgu-install first-install: the kit runs under umask 022, in a folder made root\'s alone by its mode',
            r.calls.some((a) => /^rm -rf '\/var\/opt\/mgu-deploy-kit-\d+' && umask 022 && mkdir -m 700 -p '\/var\/opt\/mgu-deploy-kit-\d+' && tar /.test(a[a.length - 1])),
            r.calls.map((a) => a[a.length - 1]).join('\n'));
        // again, the updater running since the next start, the manager on the fallback copy, the token from the GitHub CLI
        fs.writeFileSync(root.unitFile('mgu-updater.service.active'), 'active\n');
        startInplace(root);
        gh.reset();
        r = mguInstall(['first-install', '--host', '10.0.0.9', '--no-uplink', '--no-renderer'], Object.assign({ env: { FAKE_GH_TOKEN: TOKEN } }, opts));
        check('mgu-install first-install again: changes nothing installed, and says setup is done', r.status === 0 &&
            r.out.includes('already installed') && !r.out.includes('built robertn_store') && r.out.includes('updater sources kept') &&
            r.stdout.endsWith('Setup is done: the Store installs and updates everything from here on.\n') &&
            gh.requests()[1].auth === `Bearer ${TOKEN}` && !r.calls.some((a) => / updater-token/.test(a[a.length - 1])), r.out.slice(-2000));
        r = mguInstall(['first-install', '--host', '10.0.0.9'], Object.assign({ env: { FAKE_GH_TOKEN: TOKEN } }, opts));
        check('mgu-install first-install: installs the renderer and the uplink by default, which start at the next start', r.status === 0 &&
            ['mgu-uplink', 'mgu-render'].every((id) => root.status().components.some((x) => x.id === id)) &&
            r.stdout.endsWith('\nRestart the head unit to finish setup.\n'),
            r.out.slice(-2000));
        // at a terminal, while the renderer and the uplink are not running: the question
        const again = ['first-install', '--host', '10.0.0.9'];
        const tOpts = Object.assign({ env: { FAKE_GH_TOKEN: TOKEN } }, opts);
        const QUESTION = 'Restart the head unit to finish setup.\nRestart the head unit now? [y/N] ';
        r = mguInstallTerminal(again, tOpts, 'y');
        check('mgu-install first-install at a terminal: asks to restart; y restarts the head unit as the Store does, says so, exit 0',
            r.status === 0 && r.out.includes(QUESTION) && r.out.endsWith('\nRestarting the head unit.\n') &&
            JSON.stringify(nsmCalls(bin)) === JSON.stringify(['--requestRestart 7 --normal']) &&
            r.calls.every((a) => !/["\\]/.test(a[a.length - 1])), r.out.slice(-1500));
        r = mguInstallTerminal(again, tOpts, 'yes');
        check('mgu-install first-install at a terminal: yes restarts too', r.status === 0 && nsmCalls(bin).length === 2, r.out.slice(-800));
        for (const [answer, what] of [['n', 'n'], ['', 'Enter'], ['restart', 'another answer']]) {
            r = mguInstallTerminal(again, tOpts, answer);
            check(`mgu-install first-install at a terminal: ${what} leaves the head unit running, exit 0`,
                r.status === 0 && r.out.includes(QUESTION) && !r.out.includes('Restarting') && nsmCalls(bin).length === 2, r.out.slice(-800));
        }
        r = mguInstallTerminal(again.concat(['--no-restart-prompt']), tOpts, null);
        check('mgu-install first-install --no-restart-prompt at a terminal: no question, ends with the restart line',
            r.status === 0 && !r.out.includes('[y/N]') && r.out.endsWith('\nRestart the head unit to finish setup.\n') && nsmCalls(bin).length === 2, r.out.slice(-800));
        r = mguInstallTerminal(again, Object.assign({}, tOpts, { env: { FAKE_GH_TOKEN: TOKEN, CI: 'true' } }), null);
        check('mgu-install first-install under CI at a terminal: no question', r.status === 0 && !r.out.includes('[y/N]') &&
            r.out.endsWith('\nRestart the head unit to finish setup.\n'), r.out.slice(-800));
        fs.writeFileSync(path.join(bin.bin, 'nsm.out'), '[Error. Restart not allowed now]\n');
        r = mguInstallTerminal(again, tOpts, 'y');
        check('mgu-install first-install at a terminal: a restart the head unit refuses is said, exit 1',
            r.status === 1 && r.out.endsWith('\nThe head unit did not take the restart: Restart not allowed now. Restart it from the Store.\n') &&
            nsmCalls(bin).length === 3, r.out.slice(-800));
        fs.unlinkSync(path.join(bin.bin, 'nsm.out'));
        // a deploy tool run of this boot holds the lock when the question is answered: no restart
        const lock = root.p('var/opt/mgu-deploy/lock');
        r = mguInstallTerminal(again, tOpts, 'y', { path: lock, text: `${process.pid} ${fs.readFileSync(root.p('proc/boot_id'), 'utf8').trim()}\n` });
        check('mgu-install first-install at a terminal: no restart while a deploy tool run holds its lock, said, exit 1',
            r.status === 1 && r.out.endsWith('\nAn install is running on the head unit: restart it from the Store once it is done.\n') &&
            nsmCalls(bin).length === 3, r.out.slice(-800));
        fs.unlinkSync(lock);
        // the same lock from an earlier boot, or of a run that is gone: the restart goes ahead
        r = mguInstallTerminal(again, tOpts, 'y', { path: lock, text: `${process.pid} boot-0\n` });
        check('mgu-install first-install at a terminal: a lock of an earlier boot does not hold the restart back',
            r.status === 0 && r.out.endsWith('\nRestarting the head unit.\n') && nsmCalls(bin).length === 4, r.out.slice(-800));
        fs.unlinkSync(lock);
        // the script on stdin (curl | node -): the question at the terminal
        r = mguInstallTerminal(null, Object.assign({}, tOpts, { command: ['sh', '-c',
            `exec '${process.execPath}' - first-install --host 10.0.0.9 < '${MGU_INSTALL}'`] }), 'y');
        check('mgu-install from stdin at a terminal: asks at the terminal; y restarts', r.status === 0 && r.out.includes(QUESTION) &&
            r.out.endsWith('\nRestarting the head unit.\n') && nsmCalls(bin).length === 5, r.out.slice(-800));
        // install.sh through curl | sh: it gives the executable the terminal, where the question is answered
        const dl = fs.mkdtempSync(path.join(T, 'dl-'));
        const exe = `mgu-install-linux-${os.arch()}.gz`;
        fs.writeFileSync(path.join(dl, exe), zlib.gzipSync(`#!/bin/sh\nexec '${process.execPath}' '${MGU_INSTALL}' "$@"\n`));
        fs.writeFileSync(path.join(dl, 'SHA256SUMS'), `${sha256(fs.readFileSync(path.join(dl, exe)))}  ${exe}\n`);
        r = mguInstallTerminal(null, Object.assign({}, tOpts, { env: { FAKE_GH_TOKEN: TOKEN, MGU_INSTALL_DOWNLOAD: `file://${dl}` },
            command: ['sh', '-c', `cat '${path.join(DEPLOY, 'install.sh')}' | sh -s -- first-install --host 10.0.0.9`] }), 'y');
        check('install.sh through curl | sh at a terminal: asks; y restarts', r.status === 0 && r.out.includes(QUESTION) &&
            r.out.endsWith('\nRestarting the head unit.\n') && nsmCalls(bin).length === 6, r.out.slice(-800));
        r = mguInstallTerminal(null, Object.assign({}, tOpts, { env: { FAKE_GH_TOKEN: TOKEN, MGU_INSTALL_DOWNLOAD: `file://${dl}` },
            command: ['sh', '-c', `cat '${path.join(DEPLOY, 'install.sh')}' | sh -s -- first-install --host 10.0.0.9`] }), 'n');
        check('install.sh through curl | sh at a terminal: n leaves the head unit running', r.status === 0 && r.out.includes(QUESTION) &&
            nsmCalls(bin).length === 6, r.out.slice(-800));
        // another renderer on a second unit: the renderer installs beside it
        const unit2 = donorRoot();
        const otherOpts = { bin: installBin(unit2), api: gh.api };
        r = unit2.run(['install', '--artifact', namedTool('other-render', '1.0.0', (c) => { c.mguProvides = 'renderer'; }), '--yes']);
        r = r.status === 0 ? mguInstall(['first-install', '--host', '10.0.0.9'], Object.assign({ env: { FAKE_GH_TOKEN: TOKEN } }, otherOpts)) : r;
        const os2 = unit2.status();
        check('mgu-install first-install: beside another renderer the renderer installs too', r.status === 0 &&
            ['robertn_store', 'mgu-uplink', 'other-render', 'mgu-render'].every((id) => os2.components.some((x) => x.id === id)) &&
            !r.out.includes('left out'), r.out.slice(-3000));
        const noRender = JSON.parse(fs.readFileSync(rel.files[rel.catalogIndex], 'utf8'));
        noRender.components = noRender.components.filter((c) => c.id !== 'mgu-render');
        const noRenderFile = path.join(rel.dir, 'no-render-catalog.json');
        fs.writeFileSync(noRenderFile, JSON.stringify(noRender));
        gh.set(Object.assign({}, config, { files: rel.files.concat([noRenderFile]), repos: { [STORE_REPO]: { token: TOKEN, catalog: rel.files.length } } }));
        r = mguInstall(['first-install', '--host', '10.0.0.9'], Object.assign({ env: { FAKE_GH_TOKEN: TOKEN } }, opts));
        check('mgu-install first-install: a catalog without the renderer installs the rest, saying so', r.status === 0 &&
            r.out.includes('the catalog has no mgu-render; installing without it'), r.out.slice(-2000));
        gh.set(config);
        r = mguInstall(['first-install', '--host', '10.0.0.9'], opts);
        check('mgu-install first-install: a private release without a token is refused, the unit only read', r.status === 1 &&
            r.stderr.includes('no access') && r.calls.length === 1 && r.calls[0][r.calls[0].length - 1].includes('rawcodingdata'), r.out);
        const bad = JSON.parse(fs.readFileSync(rel.files[rel.catalogIndex], 'utf8'));
        bad.components[1].artifact.sha256 = '0'.repeat(64);
        const badFile = path.join(rel.dir, 'bad-catalog.json');
        fs.writeFileSync(badFile, JSON.stringify(bad));
        gh.set(Object.assign({}, config, { files: rel.files.concat([badFile]), repos: { [STORE_REPO]: { token: TOKEN, catalog: rel.files.length } } }));
        r = mguInstall(['first-install', '--host', '10.0.0.9'], Object.assign({ env: { FAKE_GH_TOKEN: TOKEN } }, opts));
        check('mgu-install first-install: an artifact that does not match its catalog stops it before anything is sent', r.status === 1 &&
            r.stderr.includes('sha256 does not match') && r.calls.length === 1 && r.calls[0][r.calls[0].length - 1].includes('rawcodingdata'), r.out);
        gh.set(config);
        // token
        const other = `${TOKEN}x`;
        r = mguInstall(['token', '--host', '10.0.0.9'], Object.assign({ input: other }, opts));
        check('mgu-install token: adds a token from stdin through updater-token; the running updater reads its sources again', r.status === 0 &&
            Object.values(tokenTexts(root)).sort().join() === [TOKEN, other].sort().join() && !r.out.includes(other) &&
            /^sh \/var\/opt\/mgu-deploy\/mgu-deploy\.sh updater-token && /.test(r.calls[0][r.calls[0].length - 1]) &&
            r.calls[0][r.calls[0].length - 1].includes('updater.js check') && r.calls.every((a) => !a.join(' ').includes(other)), r.out);
        r = mguInstall(['token', '--host', '10.0.0.9', '--list'], opts);
        check('mgu-install token --list: updater-token --list on the unit', r.calls.length === 1 &&
            r.calls[0][r.calls[0].length - 1].endsWith('sh /var/opt/mgu-deploy/mgu-deploy.sh updater-token --list'), JSON.stringify(r.calls));
        r = mguInstall(['token', '--host', '10.0.0.9', '--list', '--ssh-opt', 'StrictHostKeyChecking=yes'], opts);
        check('mgu-install: an owner\'s StrictHostKeyChecking comes before the tool\'s, so ssh takes the owner\'s',
            r.calls.length === 1 && r.calls[0].indexOf('StrictHostKeyChecking=yes') >= 0 &&
            r.calls[0].indexOf('StrictHostKeyChecking=yes') < r.calls[0].indexOf('StrictHostKeyChecking=no'), JSON.stringify(r.calls));
        r = mguInstall(['token', '--host', '10.0.0.9', '--list', '--json'], opts);
        const listed = JSON.parse(r.stdout);
        const otherId = Object.keys(tokenTexts(root)).find((id) => tokenTexts(root)[id] === other);
        check('mgu-install token --list --json: the tokens as JSON, no token text', r.status === 0 &&
            r.calls[0][r.calls[0].length - 1].endsWith('sh /var/opt/mgu-deploy/mgu-deploy.sh updater-token --list --json') &&
            listed.length === 2 && listed.some((t) => t.id === otherId) && !r.out.includes(TOKEN), r.out);
        const deployComponent = root.p('var/opt/mgu-deploy/current/component.json');
        const deployOwn = fs.readFileSync(deployComponent, 'utf8');
        fs.writeFileSync(deployComponent, JSON.stringify(Object.assign(JSON.parse(deployOwn), { version: '0.2.2' })));
        r = mguInstall(['token', '--host', '10.0.0.9', '--remove', otherId], opts);
        check('mgu-install token --remove: a deploy tool older than 0.2.3 is refused, every token kept', r.status === 2 &&
            r.stderr.includes('older than 0.2.3') && Object.keys(tokenTexts(root)).length === 2, r.out);
        fs.writeFileSync(deployComponent, deployOwn);
        r = mguInstall(['token', '--host', '10.0.0.9', '--remove', otherId], opts);
        check('mgu-install token --remove <id>: updater-token --remove <id> on the unit', r.status === 0 && r.calls.length === 1 &&
            r.calls[0][r.calls[0].length - 1].endsWith(`sh /var/opt/mgu-deploy/mgu-deploy.sh updater-token --remove '${otherId}'`) &&
            !tokenTexts(root)[otherId] && Object.keys(tokenTexts(root)).length === 1, JSON.stringify(r.calls));
        const jsonAlone = mguInstall(['token', '--json'], opts);
        const notHex = mguInstall(['token', '--remove', 't-1a2b'], opts);
        check('mgu-install token: --json without --list, or an id that is not one, is refused, nothing sent',
            jsonAlone.status === 2 && notHex.status === 2 && !jsonAlone.calls.length && !notHex.calls.length, `${jsonAlone.out}${notHex.out}`);
        r = mguInstall(['token', '--remove', "x'; rm -rf /"], opts);
        const empty = mguInstall(['token'], opts);
        const argv = mguInstall(['token', TOKEN], opts);
        check('mgu-install token: a bad id, no token, or a token as an argument is refused, nothing sent',
            r.status === 2 && empty.status === 2 && empty.stderr.includes('no token given') && argv.status === 2 &&
            !r.calls.length && !empty.calls.length && !argv.calls.length, `${r.out}${empty.out}${argv.out}`);
        r = mguInstall(['first-install', '--host', '10.0.0.9', '--source', 'x'], opts);
        check('mgu-install: an unknown option is a usage error', r.status === 2 && r.stderr.includes('unknown option --source'), r.out);
        check('mgu-install: seeds the same sources as deploy/hu', JSON.stringify(require(MGU_INSTALL).SOURCES) ===
            JSON.stringify(readJson(path.join(DEPLOY, 'sources.json'))));
        const defaults = /^default_sources = (.*)$/m.exec(fs.readFileSync(path.join(DEPLOY, '..', 'native', 'mgu-updater', 'updater.conf'), 'utf8'));
        check('sources: the installers seed the updater\'s default sources', !!defaults && JSON.stringify(defaults[1].split(' ')) ===
            JSON.stringify(readJson(path.join(DEPLOY, 'sources.json')).sources.filter((x) => !x.builtin).map((x) => `${x.repo}:${x.channel}`)),
            defaults && defaults[1]);

        // the one-liner: the script on stdin (curl ... | node - first-install), the unit found on its own
        const unit3 = donorRoot();
        const port = bannerServer();
        const one = { bin: installBin(unit3), api: gh.api, stdin: true, env: { FAKE_GH_TOKEN: TOKEN, MGU_INSTALL_HOTSPOT: `127.0.0.1:${port}` } };
        r = mguInstall(['first-install'], one);
        check('mgu-install from stdin, no --host: finds the unit at the hotspot address, says so, and installs there',
            r.status === 0 && unit3.status().components.some((x) => x.id === 'robertn_store') &&
            r.stderr.includes(`connecting over the car's hotspot (127.0.0.1)`) && r.calls.length > 0 &&
            r.calls.every((a) => a.join(' ').startsWith(`-p ${port} `) && a.includes('root@127.0.0.1')), `${r.out.slice(-2000)}\n${JSON.stringify(r.calls[0])}`);
        r = mguInstall(['token'], one);
        check('mgu-install from stdin without a terminal: token is refused before connecting, saying how to run it',
            r.status === 2 && r.stderr.includes('no terminal') && !r.calls.length, r.out);
        // an address no host answers (TEST-NET-1): no head unit; a refused port is one found with SSH closed (testMguInstallClosed)
        r = mguInstall(['first-install'], Object.assign({}, one, { env: { FAKE_GH_TOKEN: TOKEN, MGU_INSTALL_HOTSPOT: '192.0.2.1:22' } }));
        check('mgu-install: no unit answering SSH stops before any download or ssh, saying what to check',
            r.status === 1 && !r.calls.length && r.stderr.includes('no head unit answered SSH') && r.stderr.includes('--host'), r.out);
    } finally {
        gh.stop();
    }
}

/* usb-repo from every kind of input, read back the way the updater reads a stick (on the unit's Node). */
function testMguInstallUsb() {
    const gh = fakeGithub({ files: [], repos: {} });
    try {
        const rel = fakeRelease(gh.api);
        const relApp = thirdPartyArtifact('rel_app', '1.1.0', 'npm');
        const relMgu = thirdPartyArtifact('rel_app', '1.1.0', 'mgu');
        const mguOnly = thirdPartyArtifact('mgu_only', '0.1.0', 'mgu');
        const draft = thirdPartyArtifact('rel_app', '9.9.9', 'npm');
        const titles = path.join(fs.mkdtempSync(path.join(T, 'titles-')), 'mgu-store.json');
        fs.writeFileSync(titles, JSON.stringify({ apps: { rel_app: { title: 'Release App' } } }));
        const files = rel.files.concat([relApp, relMgu, mguOnly, draft, titles]);
        const n = rel.files.length;
        gh.set({ files, repos: {
            [STORE_REPO]: { token: TOKEN, catalog: rel.catalogIndex },
            'third/rel': { releases: [{ draft: true, assets: [{ name: 'rel_app@9.9.9.tgz', n: n + 3 }] },
                { assets: [{ name: 'rel_app@1.1.0.tgz', n }, { name: 'rel_app@1.1.0.mgu', n: n + 1 }, { name: 'mgu-store.json', n: n + 4 }] },
                { assets: [{ name: 'mgu_only@0.1.0.mgu', n: n + 2 }] }] }
        } });
        // a dir: publish and a checkout with mgu-repo.json
        const pub = path.join(fs.mkdtempSync(path.join(T, 'pub-')), 'Dir Publish');
        fs.mkdirSync(pub);
        const dirApp = appArtifact('dir_app', '1.0.0', true);
        fs.copyFileSync(dirApp, path.join(pub, 'dir_app@1.0.0.tgz'));
        const dd = fs.readFileSync(dirApp);
        fs.writeFileSync(path.join(pub, 'catalog.json'), JSON.stringify({ schema: 1, components: [{ id: 'dir_app', kind: 'app', title: 'Dir', version: '1.0.0',
            artifact: { name: 'dir_app@1.0.0.tgz', size: dd.length, sha256: sha256(dd), url: './dir_app@1.0.0.tgz' } }] }));
        const co = path.join(fs.mkdtempSync(path.join(T, 'co-')), 'checkout');
        write(path.join(co, 'mgu-repo.json'), JSON.stringify({ schema: 1, components: [{ id: 'co-tool', kind: 'tool', path: 'native/co-tool' }] }));
        write(path.join(co, 'native', 'co-tool', 'component.json'), JSON.stringify({ id: 'co-tool', kind: 'tool', version: '0.1.0',
            files: [{ path: 'co.sh', mode: '0755' }], units: [], enable: [], recmgr: [], restart: [] }));
        write(path.join(co, 'native', 'co-tool', 'co.sh'), '#!/bin/sh\n');
        write(path.join(co, 'node_modules', 'x', 'index.js'), '// not on GitHub\n');
        // a clone of a GitHub repository: usb-repo names it in mgu-copy.json
        cp.execFileSync('git', ['-C', co, 'init', '-q']);
        cp.execFileSync('git', ['-C', co, 'add', 'mgu-repo.json', 'native']);
        cp.execFileSync('git', ['-C', co, 'remote', 'add', 'origin', 'git@github.com:cauliflowermossgrape/idrive7-apps.git']);
        // package files: an app built elsewhere, a .mgu, a tool kit, a source package
        const pk = fs.mkdtempSync(path.join(T, 'pk-'));
        const pkgs = [thirdPartyArtifact('loose_app', '1.0.0', 'npm'), thirdPartyArtifact('mgu_app', '2.0.0', 'mgu'),
            namedTool('loose-tool', '0.3.0'), sourceArtifact('1.0.0')].map((f, i) => {
            const to = path.join(pk, `${i} ${path.basename(f)}`);
            fs.copyFileSync(f, to);
            return to;
        });
        const media = fs.mkdtempSync(path.join(T, 'media-'));
        const stick = path.join(media, 'MY STICK');
        fs.mkdirSync(stick);
        const bin = installBin(null);
        const opts = { bin, api: gh.api, env: { FAKE_GH_TOKEN: TOKEN } };
        let r = mguInstall(['usb-repo', stick, `github:${STORE_REPO}`, 'github:third/rel', pub, co].concat(pkgs), opts);
        const repo = path.join(stick, 'mgu-repo');
        check('mgu-install usb-repo: one folder per input, package files together in local/', r.status === 0 &&
            fs.readdirSync(repo).sort().join() === 'checkout,dir-publish,local,mgu-store,rel', `${r.out}\n${fs.existsSync(repo) && fs.readdirSync(repo)}`);
        const reqs = gh.requests();
        check('mgu-install usb-repo: the GitHub CLI\'s token for the private repo, only to the API host', reqs.some((x) => x.auth === `Bearer ${TOKEN}`) &&
            reqs.filter((x) => x.path.startsWith('/blob/')).every((x) => x.auth === null) &&
            reqs.filter((x) => x.path.startsWith('/repos/third/rel')).every((x) => x.auth === null), JSON.stringify(reqs));
        const read = () => {
            const x = cp.spawnSync(UNIT_NODE, [path.join(HERE, 'stick_read.js'), media], { encoding: 'utf8' });
            try {
                return JSON.parse(x.stdout);
            } catch (e) {
                return { error: x.stderr };
            }
        };
        // what an interrupted run leaves at the stick's root is no source
        write(path.join(stick, '.mgu-repo-rel.partial', 'catalog.json'), fs.readFileSync(path.join(repo, 'rel', 'catalog.json')));
        let seen = read();
        const src = (name) => seen[`usb:MY STICK/mgu-repo/${name}`] || {};
        const ids = (name) => (src(name).components || []).map((c) => `${c.id}@${c.version}${c.build ? `:${c.build}` : ''}`).sort().join(' ');
        const allOk = Object.keys(seen).every((k) => seen[k].components && seen[k].components.every((c) => c.ok === true) && !seen[k].skipped.length);
        check('mgu-install usb-repo: the updater reads every folder, and every artifact matches its listed size and sha256 (unit Node)',
            Object.keys(seen).length === 5 && allOk, JSON.stringify(seen));
        check('mgu-install usb-repo: a published catalog keeps its schema-2 fields',
            ids('mgu-store') === `app-privacy@${rel.entries[1].version} mgu-deploy@${VERSION} mgu-render@0.1.0 mgu-updater@0.2.0 mgu-uplink@0.4.0 robertn_store@${rel.entries[4].version}:unit`,
            ids('mgu-store'));
        const relCat = JSON.parse(fs.readFileSync(path.join(repo, 'rel', 'catalog.json'), 'utf8'));
        check('mgu-install usb-repo: a releases-mode repo gets a catalog: the newest of each id, the .tgz over the .mgu, titles from mgu-store.json',
            ids('rel') === 'mgu_only@0.1.0 rel_app@1.1.0' && relCat.components.find((c) => c.id === 'rel_app').title === 'Release App' &&
            relCat.components.find((c) => c.id === 'mgu_only').artifact.url === 'mgu_only@0.1.0.mgu' &&
            relCat.components.every((c) => c.uninstallable === true), JSON.stringify(relCat));
        check('mgu-install usb-repo: a dir: publish and a checkout (the updater builds it as a repo tree, node_modules left out)',
            ids('dir-publish') === 'dir_app@1.0.0' && src('checkout').mode === 'repo' && ids('checkout') === 'co-tool@0.1.0' &&
            !fs.existsSync(path.join(repo, 'checkout', 'node_modules')), JSON.stringify([src('dir-publish'), src('checkout')]));
        const marker = (name) => (fs.existsSync(path.join(repo, name, 'mgu-copy.json')) ?
            JSON.parse(fs.readFileSync(path.join(repo, name, 'mgu-copy.json'), 'utf8')).copyOf : null);
        check('mgu-install usb-repo: a published source\'s folder, and a clone of a GitHub repository, names the source it is a copy of; the updater reads it',
            marker('mgu-store') === `github:${STORE_REPO}` && marker('rel') === 'github:third/rel' && src('mgu-store').copyOf === `github:${STORE_REPO}` &&
            marker('checkout') === 'github:cauliflowermossgrape/idrive7-apps' && src('checkout').copyOf === marker('checkout') &&
            [marker('dir-publish'), marker('local')].every((m) => m === null), JSON.stringify([marker('mgu-store'), src('mgu-store').copyOf, marker('checkout')]));
        check('mgu-install usb-repo: package files by their content: an app, a .mgu, a tool kit and a source package built on the unit',
            ids('local') === 'loose-tool@0.3.0 loose_app@1.0.0 mgu_app@2.0.0 robertn_demo@1.0.0:unit', ids('local'));
        // again: a newer and an older package; the newer replaces, the older leaves the newer
        const pk2 = [thirdPartyArtifact('loose_app', '1.1.0', 'npm'), thirdPartyArtifact('mgu_app', '1.0.0', 'mgu')];
        r = mguInstall(['usb-repo', stick].concat(pk2), opts);
        seen = read();
        check('mgu-install usb-repo again: local/ keeps the higher version of each id and the rest', r.status === 0 &&
            ids('local') === 'loose-tool@0.3.0 loose_app@1.1.0 mgu_app@2.0.0 robertn_demo@1.0.0:unit' &&
            !fs.existsSync(path.join(repo, 'local', 'loose_app@1.0.0.tgz')) && r.out.includes('mgu_app 2.0.0 stays'), `${r.out}\n${ids('local')}`);
        const before = treeHash(stick).hash;
        const service = path.join(fs.mkdtempSync(path.join(T, 'svc-')), 'renderer.tgz');
        fs.writeFileSync(service, tgz([{ name: 'package/package.json', data: Buffer.from(JSON.stringify({ name: 'mgu-renderd', version: '1.0.0', mguService: {} })), mode: 0o644 }], 1700000000));
        r = mguInstall(['usb-repo', stick, service], opts);
        const goodSvc = path.join(fs.mkdtempSync(path.join(T, 'usbsvc-')), 'usbsvc');
        fs.mkdirSync(goodSvc);
        const svcStick = path.join(goodSvc, 'stick');
        fs.mkdirSync(svcStick);
        const rs = mguInstall(['usb-repo', svcStick, serviceArtifact('renderer', '1.1.0')], opts);
        const svcEntry = (readJson(path.join(svcStick, 'mgu-repo', 'local', 'catalog.json')).components || [])[0] || {};
        check('mgu-install usb-repo: a renderer package is listed as the tool it installs as, providing renderer', rs.status === 0 &&
            svcEntry.id === 'mgu-renderd' && svcEntry.kind === 'tool' && svcEntry.mguProvides === 'renderer' && svcEntry.uninstallable === true &&
            JSON.stringify(svcEntry.requires) === '{"mgu-deploy":"0.4.0"}',
            `${rs.out}\n${JSON.stringify(svcEntry)}`);
        const badHmi = mguInstall(['usb-repo', svcStick, rhmiApp('badhmi', '1.0.0', null, { pkg: { mguHmi: 'ID7' } })], opts);
        check('mgu-install usb-repo: a malformed mguHmi is refused', badHmi.status === 2 && badHmi.stderr.includes('mguHmi must list'), badHmi.out);
        const badPub = path.join(fs.mkdtempSync(path.join(T, 'badpub-')), 'dir-publish');
        cp.execFileSync('cp', ['-R', pub + '/.', badPub]);
        fs.appendFileSync(path.join(badPub, 'dir_app@1.0.0.tgz'), 'x');
        const r2 = mguInstall(['usb-repo', stick, badPub], opts);
        check('mgu-install usb-repo: a root-service package and an artifact that does not match are refused; the stick is unchanged',
            r.status === 2 && r.stderr.includes('root-service') && r2.status === 1 && /bytes, the source lists|sha256/.test(r2.stderr) &&
            treeHash(stick).hash === before, `${r.out}\n${r2.out}`);
        r = mguInstall(['usb-repo', stick, `github:${STORE_REPO}`], Object.assign({}, opts, { env: { FAKE_GH_TOKEN: '' } }));
        check('mgu-install usb-repo: a private repo with no token is refused, its folder kept', r.status === 1 && r.stderr.includes('no access') &&
            treeHash(stick).hash === before, r.out);
    } finally {
        gh.stop();
    }
}

/* first-install --from a folder usb-repo wrote: the same install, no GitHub request. */
function testMguInstallFrom() {
    const gh = fakeGithub({ files: [], repos: {} });
    try {
        const rel = fakeRelease(gh.api);
        gh.set({ files: rel.files, repos: { [STORE_REPO]: { token: TOKEN, catalog: rel.catalogIndex } } });
        const stick = path.join(fs.mkdtempSync(path.join(T, 'from-')), 'MY STICK');
        fs.mkdirSync(stick);
        let r = mguInstall(['usb-repo', stick], { bin: installBin(null), api: gh.api, env: { FAKE_GH_TOKEN: TOKEN } });
        const from = path.join(stick, 'mgu-repo', 'mgu-store');
        check('mgu-install usb-repo: writes the release as a folder for --from', r.status === 0 &&
            fs.existsSync(path.join(from, 'catalog.json')), r.out);
        const root = donorRoot();
        const opts = { bin: installBin(root), api: gh.api };
        gh.reset();
        r = mguInstall(['first-install', '--from', from, '--host', '10.0.0.9', '--no-uplink', '--no-renderer'], opts);
        const st = r.status === 0 ? root.status() : { components: [] };
        check('mgu-install first-install --from: the release\'s tools and the Store from the folder, no GitHub request',
            r.status === 0 && ['app-privacy', 'mgu-updater', 'mgu-deploy', 'robertn_store'].every((id) => st.components.some((x) => x.id === id)) &&
            !gh.requests().length, `${r.out.slice(-3000)}\n${JSON.stringify(gh.requests())}`);
        // a tampered artifact: same size, other bytes
        const bad = fs.mkdtempSync(path.join(T, 'from-bad-'));
        fs.readdirSync(from).filter((n) => fs.statSync(path.join(from, n)).isFile())
            .forEach((n) => fs.copyFileSync(path.join(from, n), path.join(bad, n)));
        const victim = fs.readdirSync(bad).find((n) => n.endsWith('.tgz'));
        const data = fs.readFileSync(path.join(bad, victim));
        data[data.length >> 1] ^= 0xff;
        fs.writeFileSync(path.join(bad, victim), data);
        r = mguInstall(['first-install', '--from', bad, '--host', '10.0.0.9'], opts);
        check('mgu-install first-install --from: an artifact that does not match the catalog stops it before anything is sent',
            r.status === 1 && r.stderr.includes('sha256 does not match') && r.calls.length === 1 &&
            r.calls[0][r.calls[0].length - 1].includes('rawcodingdata'), r.out);
        r = mguInstall(['first-install', '--from', fs.mkdtempSync(path.join(T, 'from-empty-')), '--host', '10.0.0.9'], opts);
        check('mgu-install first-install --from: a folder without catalog.json is refused before connecting',
            r.status === 2 && r.stderr.includes('no catalog.json') && !r.calls.length, r.out);
        r = mguInstall(['first-install', '--from', stick, '--host', '10.0.0.9'], opts);
        check('mgu-install first-install --from: the stick root is refused, naming the folder to give',
            r.status === 2 && r.stderr.includes(from) && !r.calls.length, r.out);
        // a catalog without mgu-deploy names the folder, not the GitHub repo
        const nodeploy = fs.mkdtempSync(path.join(T, 'from-nodeploy-'));
        fs.readdirSync(from).filter((n) => fs.statSync(path.join(from, n)).isFile())
            .forEach((n) => fs.copyFileSync(path.join(from, n), path.join(nodeploy, n)));
        const cat = JSON.parse(fs.readFileSync(path.join(nodeploy, 'catalog.json'), 'utf8'));
        cat.components = (cat.components || []).filter((c) => c.id !== 'mgu-deploy');
        fs.writeFileSync(path.join(nodeploy, 'catalog.json'), JSON.stringify(cat));
        r = mguInstall(['first-install', '--from', nodeploy, '--host', '10.0.0.9'], opts);
        check('mgu-install first-install --from: a catalog without mgu-deploy names the folder',
            r.status === 1 && r.stderr.includes(`${path.resolve(nodeploy)}: the catalog has no mgu-deploy`) &&
            !r.stderr.includes(`${STORE_REPO}: the catalog`) && r.calls.length === 1 &&
            r.calls[0][r.calls[0].length - 1].includes('rawcodingdata'), r.out);
        r = mguInstall(['token', '--from', from, '--host', '10.0.0.9'], opts);
        check('mgu-install: --from goes with first-install only', r.status === 2 &&
            r.stderr.includes('unknown option --from') && !r.calls.length, r.out);
        r = mguInstall(['help'], opts);
        check('mgu-install help: names --from', r.status === 0 && r.stdout.includes('--from <folder>'), r.out);
    } finally {
        gh.stop();
    }
}

/* What mgu-install does with paths on Windows (path.win32): local paths stay
 * one argument, the unit gets POSIX ones, names on the stick are valid there. */
function testMguInstallPaths() {
    const mi = require(MGU_INSTALL);
    const o = mi.parse(['token', '--host', '172.16.222.97', '--identity', 'C:\\Users\\Me Here\\.ssh\\id_rsa', '--ssh-opt', 'StrictHostKeyChecking=no']);
    const args = mi.sshArgs(o, 'sh /var/opt/mgu-deploy/mgu-deploy.sh updater-token --list');
    check('mgu-install paths: a Windows key path is one ssh argument, the owner\'s options first, the remote command last',
        args[args.indexOf('-i') + 1] === 'C:\\Users\\Me Here\\.ssh\\id_rsa' && args.indexOf('StrictHostKeyChecking=no') < args.indexOf('-i') &&
        args[args.length - 2] === 'root@172.16.222.97' && args[args.length - 1].startsWith('sh /var/opt/'), JSON.stringify(args));
    const winBad = /[<>:"/\\|?*\x00-\x1f]|^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
    const names = ['Owner/Repo:Name*?', 'nul', 'COM1', 'updates.example.org-repo', '..', 'a\\b'].map(mi.folderName);
    check('mgu-install paths: folder names on the stick are valid on Windows (FAT, exFAT, NTFS)',
        names.every((x) => x && !winBad.test(x) && !/^\.|\.$/.test(x)), JSON.stringify(names));
    check('mgu-install paths: an artifact file name from a catalog is one plain name',
        ['a\\b.tgz', 'C:x.tgz', '../x.tgz', 'a/b.tgz', '..'].every((x) => !mi.plainName(x)) && mi.plainName('robertn_store@0.4.1.tgz'));
    const packed = mi.untgz(mi.tgz([{ name: 'files/a.sh', data: Buffer.from('x'), mode: 0o755 }], 1700000000));
    check('mgu-install paths: the kit is packed in Node with POSIX member names and modes',
        packed.length === 1 && packed[0].name === 'files/a.sh' && packed[0].mode === 0o755);
}

/* ---- remove-all and the restore's firmware guard ---------------------------------------- */

/* /etc, MainApp's tree and the app manager's tree, but the manager's uid records (restore's boundary too). */
const systemTrees = (rel) => rel.endsWith('/security/uids.txt') ||
    !(rel === 'etc' || rel.startsWith('etc/') || rel === 'usr' || rel.startsWith('usr/') ||
    rel === 'var' || rel === 'var/opt' || rel === 'var/opt/public' || rel.startsWith('var/opt/public/'));

/* A unit with the Store setup: app-privacy, the updater with sources and a
 * token, a tool with a service, recmgr names and a program, our app and a
 * third-party app, the fallback on. */
function storeSetupRoot(root) {
    const tool = elfArtifact('fixture-tool', '0.2.0', 'fixtured');
    const steps = [
        ['install', '--artifact', privacyArtifact(), '--artifact', namedTool('mgu-updater', '0.2.0'), '--artifact', tool, '--artifact',
            appArtifact('fixture_app', '1.0.0', true), '--artifact', appArtifact('other_app', '2.0.0', false), '--yes']
    ];
    steps.forEach((a) => {
        const r = root.run(a);
        if (r.status !== 0) {
            throw new Error(`setup: ${a.join(' ')}: ${r.out}`);
        }
    });
    let r = cp.spawnSync(UNIT_NODE, [UNIT_JS, 'updater-sources'], { encoding: 'utf8', env: root.env, input: JSON.stringify({ schema: 1, sources: [{ id: 'a', type: 'github', repo: 'x/y' }] }) });
    r = cp.spawnSync(UNIT_NODE, [UNIT_JS, 'updater-token'], { encoding: 'utf8', env: root.env, input: 'ghp_removeall\n' });
    if (r.status !== 0) {
        throw new Error(`setup token: ${r.stdout}${r.stderr}`);
    }
    return root;
}

function testRemoveAll() {
    const root = fakeRoot();
    write(root.p('etc/os-release-id-dlt'), 'BMW MGU FW-1 mgu-high\n');
    write(root.p('etc/crashhandler-restartlist.conf'), '[Whitelist]\nstockcrash\n\n[ForceRestartList]\nhmi\n');
    const stock = root.hash(systemTrees);
    storeSetupRoot(root);
    const before = root.hash();
    const list = root.run(['remove-all', '--json']);
    const plan = list.status === 0 ? JSON.parse(list.stdout) : {};
    check('remove-all --json: lists our app and the third-party app, every tool but the deploy tool, the updater\'s source and token',
        list.status === 0 && JSON.stringify(plan.apps.map((a) => a.id)) === '["fixture_app","other_app"]' &&
        JSON.stringify(plan.tools.map((t) => t.id).sort()) === '["app-privacy","fixture-tool","mgu-updater"]' &&
        plan.sources === 1 && plan.tokens === 1 && plan.fallback === true && plan.deploy_tool === VERSION &&
        plan.unit.firmware === 'BMW MGU FW-1 mgu-high', list.out);
    check('remove-all --json and remove-all without --yes change nothing',
        root.run(['remove-all']).status === 0 && root.hash().hash === before.hash, treeDiff(before, root.hash()));
    const kills = root.kills().length;
    const r = root.run(['remove-all', '--yes']);
    const res = r.status === 0 ? JSON.parse(r.stdout.trim().split('\n').pop()) : {};
    check('remove-all --yes: exit 0, nothing left, the deploy tool removed, no restart needed, the result the one stdout line',
        r.status === 0 && res.self === 'removed' && res.left.length === 0 && res.restart === false && r.stdout.trim().split('\n').length === 1 &&
        ['fixture_app', 'other_app', 'fixture-tool', 'mgu-updater', 'app-privacy'].every((id) => res.removed.includes(id)), r.out);
    const now = root.hash(systemTrees);
    check('remove-all: /etc, MainApp\'s tree and the app manager\'s tree are as before the setup',
        now.hash === stock.hash, treeDiff(stock, now));
    check('remove-all: no tool, updater state or deploy tool folder is left under /var/opt',
        JSON.stringify(fs.readdirSync(root.p('var/opt'))) === '["public"]', fs.readdirSync(root.p('var/opt')).join(', '));
    check('remove-all: the app-privacy patch reverted, the app manager restarted once',
        fs.readFileSync(`${root.R}.privacy.log`, 'utf8').split('\n').includes('revert') && root.kills().length - kills === 1,
        `${root.kills().length - kills} bounces\n${r.out}`);
    const again = root.run(['remove-all', '--json']);
    check('remove-all: run again it finds nothing', again.status === 0 && JSON.parse(again.stdout).apps.length === 0 &&
        JSON.parse(again.stdout).tools.length === 0, again.out);
}

/* A step that fails leaves the deploy tool, and what depends on the step;
 * running remove-all again finishes. */
function testRemoveAllAgain() {
    const root = fakeRoot({ recmgr: ['fixture-tool'], active: 'fixture-tool.service' });
    const hookLog = `${root.R}.hooks.log`;
    const env = { FAKE_HOOK_LOG: hookLog };
    root.run(['install', '--artifact', privacyArtifact(), '--artifact', namedTool('lib-tool', '0.1.0'), '--artifact', hookArtifact('1.0.0'),
        '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes'], env);
    const r = root.run(['remove-all', '--yes'], Object.assign({ FAKE_HOOK_FAIL: 'deactivate@1.0.0' }, env));
    const res = JSON.parse(r.stdout.trim().split('\n').pop());
    check('remove-all: a tool whose deactivate fails stays, named; the rest goes; the deploy tool stays',
        r.status === 1 && JSON.stringify(res.left) === '["fixture-tool"]' && res.self === 'kept' &&
        fs.existsSync(root.tool('fixture-tool')) && !fs.existsSync(root.tool('lib-tool')) && !fs.existsSync(root.tool('app-privacy')) &&
        !fs.existsSync(root.entry('fixture_app')) && fs.existsSync(root.p('var/opt/mgu-deploy/current')), r.out);
    check('remove-all: the tool another one requires goes after it',
        r.out.indexOf('uninstalling tool fixture-tool') >= 0 && r.out.indexOf('uninstalling tool lib-tool') > r.out.indexOf('uninstalling tool fixture-tool'), r.out);
    const r2 = root.run(['remove-all', '--yes'], env);
    const res2 = JSON.parse(r2.stdout.trim().split('\n').pop());
    check('remove-all again: finishes the job', r2.status === 0 && res2.self === 'removed' && !fs.existsSync(root.tool('fixture-tool')) &&
        !fs.existsSync(root.p('var/opt/mgu-deploy')), r2.out);
}

/* After a firmware update: the lists are the new firmware's, our names
 * written again by status; remove-all takes our names out of them as they
 * are, and restore refuses to write the old firmware's files. */
function testRemoveAllFirmware() {
    const root = fakeRoot();
    write(root.p('etc/os-release-id-dlt'), 'BMW MGU FW-1 mgu-high\n');
    write(root.p('etc/crashhandler-restartlist.conf'), '[Whitelist]\nstockcrash\n');
    const stockRec = fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
    root.run(['install', '--artifact', elfArtifact('fixture-tool', '0.2.0', 'fixtured'), '--yes']);
    // the firmware update: its own lists, with lines of its own; the next status writes our names again
    write(root.p('etc/os-release-id-dlt'), 'BMW MGU FW-2 mgu-high\n');
    const fwRec = stockRec.replace('[Other]\n', '[Other]\nnewfw-entry\n').replace('[Whitelist]\n', '[Whitelist]\nnewfwd\n');
    write(root.p('etc/recmgr-restartlist.conf'), fwRec);
    write(root.p('etc/crashhandler-restartlist.conf'), '[Whitelist]\nstockcrash\nnewcrash\n');
    const st = root.run(['status', '--json']);
    const rec = fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
    check('status after a firmware update: our names back in the new firmware\'s lists',
        st.status === 0 && sectionsOf(rec).Whitelist.indexOf('fixture-tool') >= 0 && sectionsOf(rec).WhitelistExitSuccess.indexOf('fixture-tool') >= 0 &&
        /fixtured/.test(fs.readFileSync(root.p('etc/crashhandler-restartlist.conf'), 'utf8')), `${st.stderr}\n${rec}`);
    const before = root.hash();
    const res = root.run(['restore', 'stock', '--yes']);
    check('restore: refused for a backup taken on other firmware, nothing changed', res.status === 2 &&
        res.out.includes('it was taken on firmware BMW MGU FW-1 mgu-high and this head unit runs BMW MGU FW-2 mgu-high') &&
        res.out.includes('etc/recmgr-restartlist.conf') && root.hash().hash === before.hash, res.out);
    const r = root.run(['remove-all', '--yes']);
    const recNow = fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
    check('remove-all after a firmware update: our names out of the lists as they are now; the new firmware\'s lines stay',
        r.status === 0 && recNow === fwRec &&
        fs.readFileSync(root.p('etc/crashhandler-restartlist.conf'), 'utf8') === '[Whitelist]\nstockcrash\nnewcrash\n', `${r.out}\n${recNow}`);
}

function testRestoreFirmwareGuard() {
    const root = fakeRoot();
    write(root.p('etc/os-release-id-dlt'), 'BMW MGU FW-1 mgu-high\n');
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const stockManifest = root.p('var/opt/mgu-deploy/backups/stock/manifest.json');
    check('backups record the firmware they were taken on', readJson(stockManifest).firmware === 'BMW MGU FW-1 mgu-high');
    // a backup from before the record: the same files, no firmware
    const m = readJson(stockManifest);
    delete m.firmware;
    fs.writeFileSync(stockManifest, JSON.stringify(m));
    const before = root.hash();
    const old = root.run(['restore', 'stock', '--yes']);
    check('restore: a backup without the firmware record that would write system files is refused', old.status === 2 &&
        old.out.includes('it does not record the firmware it was taken on') && root.hash().hash === before.hash, old.out);
    // one whose system files are as they are now restores
    const tok = cp.spawnSync(UNIT_NODE, [UNIT_JS, 'updater-token'], { encoding: 'utf8', env: root.env, input: 'ghp_guard\n' });
    const name = fs.readdirSync(root.p('var/opt/mgu-deploy/backups')).filter((n) => n.endsWith('-updater-token'))[0];
    const tm = readJson(root.p(`var/opt/mgu-deploy/backups/${name}/manifest.json`));
    delete tm.firmware;
    fs.writeFileSync(root.p(`var/opt/mgu-deploy/backups/${name}/manifest.json`), JSON.stringify(tm));
    const same = root.run(['restore', name, '--yes']);
    check('restore: a backup without the record goes back when it writes no system file', tok.status === 0 && same.status === 0, same.out);
    m.firmware = 'BMW MGU FW-1 mgu-high';
    fs.writeFileSync(stockManifest, JSON.stringify(m));
    const ok = root.run(['restore', 'stock', '--yes']);
    check('restore: a backup of the firmware the unit runs restores', ok.status === 0 && !fs.existsSync(root.tool('fixture-tool')), ok.out);
}

/* iDrive 8: removals MainApp-21 does not take in place wait for the next
 * start; the queue's boot unit and the deploy tool stay for it, apply them,
 * then go. */
function testRemoveAllId8() {
    const root = id8Root();
    const dasBefore = id8Das(root);
    const recBefore = fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8');
    const art = rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true, acl: ACL, appletId: 20097, marked: true });
    root.run(['install', '--artifact', art, '--yes']);
    root.noManager();
    root.run(['apply-pending']);
    write(root.entry('oap-cardash'), JSON.stringify({ userId: 13001, installationSource: 'PREINSTALLED' }));
    write(root.p('var/opt/public/oap/oap_13001/source/package.json'), JSON.stringify({ name: 'oap-cardash', version: '1.1.4', mguLocalOnly: true }));
    write(root.p(`var/opt/public/oap/oap_${MGR}/security/uids.txt`), '13000=stock_app\n13001=oap-cardash\n');
    const listed = root.p(`var/opt/public/oap/oap_${MGR}/data/mgu-deploy-listed.json`);
    write(listed, JSON.stringify({ pid: 1, apps: ['oap-cardash'] }));
    const plan = JSON.parse(root.run(['remove-all', '--json']).stdout);
    check('id8 remove-all --json: the app MainApp-21 installed from our das lines', JSON.stringify(plan.apps.map((a) => a.id)) === '["oap-cardash"]',
        JSON.stringify(plan));
    const r = root.run(['remove-all', '--yes']);
    const res = JSON.parse(r.stdout.trim().split('\n').pop());
    check('id8 remove-all: the app is removed at the next start; the queue\'s boot unit and the deploy tool stay for it; a restart is asked for',
        r.status === 0 && res.self === 'next-start' && res.restart === true && JSON.stringify(res.next_start) === '["oap-cardash"]' &&
        fs.existsSync(root.p('etc/systemd/system/mgu-deploy-apply.service')) && fs.existsSync(root.p('var/opt/mgu-deploy/remove-all.json')) &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/backups')) && !fs.existsSync(listed), r.out);
    const a = root.run(['apply-pending']);
    check('id8 remove-all, next start: the app, its das lines, the boot unit, its recmgr entry and the deploy tool are gone',
        a.status === 0 && !fs.existsSync(root.entry('oap-cardash')) && JSON.stringify(id8Das(root)) === JSON.stringify(dasBefore) &&
        !fs.existsSync(root.p('etc/systemd/system/mgu-deploy-apply.service')) &&
        !fs.existsSync(root.p('etc/systemd/system/late.target.wants/mgu-deploy-apply.service')) &&
        fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8') === recBefore && !fs.existsSync(listed) &&
        !fs.existsSync(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) &&
        JSON.stringify(fs.readdirSync(root.p('var/opt'))) === '["public"]', `${a.out}\n${fs.readdirSync(root.p('var/opt'))}`);
}

/* iDrive 8: a queued removal that fails at the next start keeps the deploy
 * tool, so the uninstall can run again. */
function testRemoveAllId8Failed() {
    const root = id8Root();
    const art = rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true, acl: ACL, appletId: 20097, marked: true });
    root.run(['install', '--artifact', art, '--yes']);
    root.noManager();
    root.run(['apply-pending']);
    write(root.entry('oap-cardash'), JSON.stringify({ userId: 13001, installationSource: 'PREINSTALLED' }));
    write(root.p('var/opt/public/oap/oap_13001/source/package.json'), JSON.stringify({ name: 'oap-cardash', version: '1.1.4', mguLocalOnly: true }));
    root.run(['remove-all', '--yes']);
    const queue = root.p('var/opt/mgu-deploy/id8/pending.json');
    const pend = readJson(queue);
    write(queue, JSON.stringify(Object.assign({}, pend, { changes: pend.changes.concat([{ id: 'oap-other', action: 'bogus' }]) })));
    const a = root.run(['apply-pending']);
    const b = root.run(['apply-pending']);
    check('id8 remove-all, a queued change failing at the next start: the deploy tool stays, also at the start after',
        a.status === 1 && b.status === 0 && fs.existsSync(root.p('var/opt/mgu-deploy/current')) &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/remove-all.json')) && root.run(['remove-all', '--json']).status === 0, `${a.out}\n${b.out}`);
}

/* iDrive 8: an install after a remove-all keeps the deploy tool at the next
 * start; the App Manager's own apps are not ours to remove. */
function testRemoveAllId8Kept() {
    let root = id8Root();
    const art = rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true, acl: ACL, appletId: 20097, marked: true });
    root.run(['install', '--artifact', art, '--yes']);
    root.noManager();
    root.run(['apply-pending']);
    write(root.entry('oap-cardash'), JSON.stringify({ userId: 13001, installationSource: 'PREINSTALLED' }));
    write(root.p('var/opt/public/oap/oap_13001/source/package.json'), JSON.stringify({ name: 'oap-cardash', version: '1.1.4', mguLocalOnly: true }));
    fs.writeFileSync(`${root.R}.mgr.pid`, '4000');
    root.run(['remove-all', '--yes']);
    root.run(['install', '--artifact', namedTool('mgu-updater', '0.2.0'), '--yes']);
    root.noManager();
    const a = root.run(['apply-pending']);
    check('id8 remove-all, then an install before the next start: the queued removal goes, the deploy tool and the tool stay',
        a.status === 0 && !fs.existsSync(root.entry('oap-cardash')) && fs.existsSync(root.p('var/opt/mgu-deploy/current')) &&
        fs.existsSync(root.tool('mgu-updater')) && !fs.existsSync(root.p('var/opt/mgu-deploy/remove-all.json')), a.out);
    root = amRoot();
    const plan = JSON.parse(root.run(['remove-all', '--json']).stdout);
    check('id8 remove-all --json: the apps IterioDev\'s App Manager installed are not listed for removal',
        !plan.apps.some((x) => ['oap-cardash', 'oap-draggy'].includes(x.id)), JSON.stringify(plan));
}

/* A service the removal leaves running asks for a restart. */
function testRemoveAllRunning() {
    const root = fakeRoot({ active: 'fixture-tool.service' });
    root.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    const r = root.run(['remove-all', '--yes']);
    const res = JSON.parse(r.stdout.trim().split('\n').pop());
    check('remove-all: a service recmgr has not loaded stays running; the result asks for a restart',
        r.status === 0 && res.restart === true && res.self === 'removed' && r.out.includes('left running until a reboot'), r.out);
}

/* mgu-install uninstall: lists, asks, removes with the unit's deploy tool,
 * or the published one when the unit's has no remove-all. */
function testMguInstallUninstall() {
    const gh = fakeGithub({ files: [], repos: {} });
    try {
        const rel = fakeRelease(gh.api);
        gh.set({ files: rel.files, repos: { [STORE_REPO]: { token: TOKEN, catalog: rel.catalogIndex } } });
        const setup = () => {
            const root = donorRoot();
            writeCoding(root, 0x09);
            const bin = installBin(root);
            const opts = { bin, api: gh.api, env: { FAKE_GH_TOKEN: TOKEN } };
            const r = mguInstall(['first-install', '--host', '10.0.0.9', '--no-uplink', '--no-renderer'], opts);
            if (r.status !== 0) {
                throw new Error(r.out);
            }
            return { root, bin, opts };
        };
        let { root, bin, opts } = setup();
        let r = mguInstall(['uninstall', '--host', '10.0.0.9'], opts);
        check('mgu-install uninstall: with no terminal and no --yes it lists, removes nothing, exit 2', r.status === 2 &&
            r.out.includes('Uninstall removes what the Store setup put on the head unit:') && r.out.includes('robertn_store') &&
            r.out.includes('mgu-updater') && r.stdout.endsWith('Nothing was removed: run uninstall at a terminal to answer, or add --yes.\n') &&
            fs.existsSync(root.p('var/opt/mgu-deploy/current')), r.out.slice(-2000));
        r = mguInstallTerminal(['uninstall', '--host', '10.0.0.9'], opts, 'n');
        check('mgu-install uninstall: at a terminal, no keeps everything', r.status === 0 && r.out.includes('Remove all of it? [y/N] ') &&
            r.out.includes('Nothing was removed.') && fs.existsSync(root.p('var/opt/mgu-deploy/current')), r.out.slice(-1000));
        r = mguInstallTerminal(['uninstall', '--host', '10.0.0.9'], opts, 'y');
        check('mgu-install uninstall: yes removes everything; one line says so',
            r.status === 0 && /Removed(: nothing of the Store setup is left on the head unit\.|\. Restart the head unit to finish\.)/.test(r.out) &&
            JSON.stringify(fs.readdirSync(root.p('var/opt'))) === '["public"]', r.out.slice(-3000));
        check('mgu-install uninstall: no remote command carries a double quote or a backslash',
            r.calls.every((a) => !/["\\]/.test(a[a.length - 1])), r.calls.map((a) => a[a.length - 1]).join('\n'));
        r = mguInstall(['uninstall', '--host', '10.0.0.9', '--yes'], opts);
        check('mgu-install uninstall: on a unit without the setup, nothing to remove', r.status === 0 &&
            r.stdout.endsWith('The Store setup is not on this head unit: nothing to remove.\n'), r.out);
        // a deploy tool on the unit without remove-all: the published one removes the setup
        ({ root, bin, opts } = setup());
        const shim = root.p('var/opt/mgu-deploy/mgu-deploy.sh');
        const real = fs.readFileSync(shim, 'utf8');
        fs.writeFileSync(shim, `[ "$1" = help ] && { echo 'mgu-deploy 0.7.15'; exit 0; }\n${real}`);
        gh.reset();
        r = mguInstall(['uninstall', '--host', '10.0.0.9', '--yes'], opts);
        check('mgu-install uninstall --yes: with an older deploy tool on the unit, the published one removes the setup, no question asked',
            r.status === 0 && !r.out.includes('[y/N]') && gh.requests().some((x) => x.path.startsWith('/blob/')) &&
            JSON.stringify(fs.readdirSync(root.p('var/opt'))) === '["public"]', r.out.slice(-3000));
        check('mgu-install uninstall: the published deploy tool runs under umask 022, in a folder made root\'s alone by its mode',
            r.calls.some((a) => /^rm -rf '\/var\/opt\/mgu-deploy-kit-\d+' && umask 022 && mkdir -m 700 -p '\/var\/opt\/mgu-deploy-kit-\d+' && tar .* remove-all /.test(a[a.length - 1])),
            r.calls.map((a) => a[a.length - 1]).join('\n'));
    } finally {
        gh.stop();
    }
}

/* mgu-install status: the deploy tool's status --read-only, changing
 * nothing; with an older deploy tool its plain status, said so. */
function testMguInstallStatus() {
    const gh = fakeGithub({ files: [], repos: {} });
    try {
        const rel = fakeRelease(gh.api);
        gh.set({ files: rel.files, repos: { [STORE_REPO]: { token: TOKEN, catalog: rel.catalogIndex } } });
        const root = donorRoot();
        writeCoding(root, 0x09);
        const bin = installBin(root);
        const opts = { bin, api: gh.api, env: { FAKE_GH_TOKEN: TOKEN } };
        let r = mguInstall(['first-install', '--host', '10.0.0.9', '--no-uplink', '--no-renderer'], opts);
        if (r.status !== 0) {
            throw new Error(r.out);
        }
        const before = root.hash();
        r = mguInstall(['status', '--host', '10.0.0.9'], opts);
        check('mgu-install status: prints the deploy tool\'s status --read-only, each app\'s tile, and changes nothing',
            r.status === 0 && /app robertn_store \S+ uid=\d+ .* tile=/.test(r.stdout) && !r.stdout.includes('no read-only status') &&
            r.calls.some((a) => / status --read-only 2>&1$/.test(a[a.length - 1])) && root.hash().hash === before.hash, r.out);
        check('mgu-install status: no remote command carries a double quote or a backslash',
            r.calls.every((a) => !/["\\]/.test(a[a.length - 1])), r.calls.map((a) => a[a.length - 1]).join('\n'));
        ['--yes', '--token', '--from', 'x'].forEach((extra) => {
            const x = mguInstall(['status', '--host', '10.0.0.9', extra], opts);
            check(`mgu-install status ${extra}: refused before anything reaches the unit`, x.status === 2 && !x.calls.length, x.out);
        });
        const shim = root.p('var/opt/mgu-deploy/mgu-deploy.sh');
        fs.writeFileSync(shim, `[ "$1" = help ] && { echo 'mgu-deploy 0.8.9'; exit 0; }\n${fs.readFileSync(shim, 'utf8')}`);
        r = mguInstall(['status', '--host', '10.0.0.9'], opts);
        check('mgu-install status: with an older deploy tool, its plain status and one line that it may have repaired things',
            r.status === 0 && r.stdout.includes('app robertn_store') && r.calls.some((a) => / status 2>&1$/.test(a[a.length - 1])) &&
            r.stdout.endsWith('it may have repaired things, as the updater does at its start.)\n'), r.out);
        fs.rmSync(root.p('var/opt/mgu-deploy'), { recursive: true });
        r = mguInstall(['status', '--host', '10.0.0.9'], opts);
        check('mgu-install status: without a deploy tool, says the Store is not installed', r.status === 1 &&
            r.stdout === 'The Store is not installed on this head unit: it has no deploy tool.\n', r.out);
    } finally {
        gh.stop();
    }
}

/* mgu-install's own command line: node with the file, or the standalone executable under test. */
function installArgv() {
    return process.env.MGU_TEST_INSTALL_EXE ? [process.env.MGU_TEST_INSTALL_EXE] : [process.execPath, MGU_INSTALL];
}

/* Ctrl+C (SIGINT) or SIGTERM while the head unit works: one line saying how
 * to finish, the ssh it runs stopped, the exit the signal makes. */
function testMguInstallStop() {
    const bin = installBin(null);
    fs.unlinkSync(path.join(bin.bin, 'ssh'));
    fs.writeFileSync(path.join(bin.bin, 'ssh'), '#!/bin/sh\n[ "$1" = -V ] && { echo OpenSSH_9.6p1 >&2; exit 0; }\nexec sleep 20\n', { mode: 0o755 });
    // the signal 1.5 s in; the run ends once the sleeping ssh has gone too, as it holds stderr open
    const SIGNAL_AFTER = `const c = require('child_process').spawn(process.argv[1], JSON.parse(process.argv[2]), { stdio: ['ignore', 'ignore', 'pipe'] });
let err = ''; const t0 = Date.now();
c.stderr.on('data', (d) => { err += d; });
setTimeout(() => c.kill(process.argv[3]), 1500);
c.on('close', (code, signal) => process.stdout.write(JSON.stringify({ code, signal, err, ms: Date.now() - t0 })));`;
    const argv = installArgv();
    ['SIGINT', 'SIGTERM'].forEach((signal) => {
        const x = cp.spawnSync(process.execPath, ['-e', SIGNAL_AFTER, argv[0], JSON.stringify(argv.slice(1).concat(['status', '--host', '10.0.0.9'])), signal],
            { encoding: 'utf8', env: Object.assign({}, process.env, { PATH: `${bin.bin}:${process.env.PATH}` }), timeout: 30000 });
        let r = {};
        try {
            r = JSON.parse(x.stdout);
        } catch (e) {
            r = { err: x.stderr };
        }
        check(`mgu-install: ${signal} while the head unit works says to run the command again, stops ssh, ends by the signal`,
            r.signal === signal && r.err.split('\n').filter((l) => l === 'stopped; run the same command again to finish').length === 1 &&
            r.ms < 10000, JSON.stringify(r));
    });
}

/* A head unit found whose SSH does not answer (the hotspot's address
 * refuses port 22): every command that connects says so, nothing run. */
function testMguInstallClosed() {
    const port = cp.execFileSync(process.execPath, ['-e', "const s = require('net').createServer().listen(0, '127.0.0.1', () => " +
        '{ process.stdout.write(String(s.address().port)); s.close(); });'], { encoding: 'utf8' });
    const opts = { bin: installBin(null), api: 'http://127.0.0.1:9', env: { MGU_INSTALL_HOTSPOT: `127.0.0.1:${port}` } };
    [['first-install'], ['status'], ['uninstall', '--yes'], ['token', '--list']].forEach((args) => {
        const r = mguInstall(args, opts);
        check(`mgu-install ${args[0]}: a found head unit with SSH closed is named so, exit 1, nothing run`, r.status === 1 &&
            r.stderr.includes(`found the head unit at 127.0.0.1:${port}, but its SSH is closed: enable root SSH first, then run this again`) &&
            !r.stderr.includes('no head unit answered') && !r.calls.length, r.out);
    });
}

/* usb-repo copies each listed icon beside the stick's catalog.json,
 * checked against its iconSha256; the updater reads it from the stick. */
function testMguInstallUsbIcons() {
    const gh = fakeGithub({ files: [], repos: {} });
    try {
        const dir = fs.mkdtempSync(path.join(T, 'icons-'));
        const png = (name) => {
            const f = path.join(dir, name);
            fs.writeFileSync(f, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, name)]));
            return f;
        };
        const apps = ['good_icon', 'bad_icon', 'gone_icon', 'no_icon'].map((id) => thirdPartyArtifact(id, '1.0.0', 'npm'));
        const good = png('good.png');
        const bad = png('bad.png');
        const entries = [
            publishedEntry(gh.api, apps[0], 0, 'app', { icon: 'good_icon.png', iconSha256: sha256(fs.readFileSync(good)) }),
            publishedEntry(gh.api, apps[1], 1, 'app', { icon: 'bad_icon.png', iconSha256: sha256(Buffer.from('another picture')) }),
            publishedEntry(gh.api, apps[2], 2, 'app', { icon: 'gone_icon.png', iconSha256: 'a'.repeat(64) }),
            publishedEntry(gh.api, apps[3], 3, 'app')];
        const catalog = path.join(dir, 'catalog.json');
        fs.writeFileSync(catalog, JSON.stringify({ schema: 2, components: entries }));
        gh.set({ files: apps.concat([good, bad, catalog]), repos: { [STORE_REPO]: { catalog: 6,
            catalogAssets: [{ name: 'good_icon.png', n: 4 }, { name: 'bad_icon.png', n: 5 }] } } });
        // a dir: publish whose icon is a file in a folder of it
        const pub = path.join(fs.mkdtempSync(path.join(T, 'pub-')), 'with-icons');
        const dirApp = thirdPartyArtifact('dir_icon', '1.0.0', 'npm');
        const dirPng = png('dir.png');
        write(path.join(pub, 'icons', 'dir.png'), fs.readFileSync(dirPng));
        fs.copyFileSync(dirApp, path.join(pub, 'dir_icon@1.0.0.tgz'));
        const dd = fs.readFileSync(dirApp);
        fs.writeFileSync(path.join(pub, 'catalog.json'), JSON.stringify({ schema: 2, components: [{ id: 'dir_icon', kind: 'app', version: '1.0.0',
            icon: 'icons/dir.png', iconSha256: sha256(fs.readFileSync(dirPng)),
            artifact: { name: 'dir_icon@1.0.0.tgz', size: dd.length, sha256: sha256(dd), url: 'dir_icon@1.0.0.tgz' } }] }));
        const media = fs.mkdtempSync(path.join(T, 'media-'));
        const stick = path.join(media, 'STICK');
        fs.mkdirSync(stick);
        const r = mguInstall(['usb-repo', stick, `github:${STORE_REPO}`, pub], { bin: installBin(null), api: gh.api });
        const repo = path.join(stick, 'mgu-repo');
        const listed = (name) => (readJson(path.join(repo, name, 'catalog.json')).components || []).reduce((m, c) => Object.assign(m, { [c.id]: c }), {});
        const store = listed('mgu-store');
        const same = (a, b) => fs.existsSync(a) && fs.readFileSync(a).equals(fs.readFileSync(b));
        check('mgu-install usb-repo: a listed icon is copied beside catalog.json as <id>.png, its entry naming it with its sha256',
            r.status === 0 && same(path.join(repo, 'mgu-store', 'good_icon.png'), good) && store.good_icon && store.good_icon.icon === 'good_icon.png' &&
            store.good_icon.iconSha256 === sha256(fs.readFileSync(good)) && same(path.join(repo, 'with-icons', 'dir_icon.png'), dirPng) &&
            listed('with-icons').dir_icon.icon === 'dir_icon.png', `${r.out}\n${JSON.stringify(store)}`);
        check('mgu-install usb-repo: an icon that does not match its iconSha256, or is missing, is left out, said, and the stick is written',
            r.status === 0 && !fs.existsSync(path.join(repo, 'mgu-store', 'bad_icon.png')) && !fs.existsSync(path.join(repo, 'mgu-store', 'gone_icon.png')) &&
            ['bad_icon', 'gone_icon', 'no_icon'].every((id) => store[id] && store[id].icon === undefined && store[id].iconSha256 === undefined) &&
            r.stdout.includes('bad_icon: icon left out (its sha256 does not match the catalog\'s)') && r.stdout.includes('gone_icon: icon left out (') &&
            !r.stdout.includes('no_icon: icon'), r.out);
        const x = cp.spawnSync(UNIT_NODE, [path.join(HERE, 'stick_read.js'), media], { encoding: 'utf8' });
        let seen = {};
        try {
            seen = JSON.parse(x.stdout);
        } catch (e) {
            seen = { error: x.stderr };
        }
        const comps = [].concat(...Object.keys(seen).map((k) => seen[k].components || []));
        const byId = comps.reduce((m, c) => Object.assign(m, { [c.id]: c }), {});
        check('mgu-install usb-repo: the updater reads the copied icons from the stick, matching their sha256 (unit Node)',
            comps.length === 5 && comps.every((c) => c.ok === true) && byId.good_icon.icon === true && byId.dir_icon.icon === true &&
            byId.bad_icon.icon === undefined, JSON.stringify(seen));
    } finally {
        gh.stop();
    }
}

/* ---- run ------------------------------------------------------------------------------------- */

/* ---- head units, compatibility, iDrive 8, service packages, capabilities ---------- */

/* An ELF64 x86-64 header and some bytes: the program a service package carries. */
function elf() {
    const b = Buffer.alloc(256);
    b.writeUInt32BE(0x7f454c46, 0);
    b[4] = 2;
    b.writeUInt16LE(0x3e, 18);
    return b;
}

/* IterioDev's service package format: npm-format, package/<name> and package.json. */
function serviceArtifact(kind, version, opts) {
    opts = opts || {};
    const name = opts.name || (kind === 'tether' ? 'ipheth-tether' : 'mgu-renderd');
    const pkg = Object.assign({ name, version, productName: kind === 'tether' ? 'iPhone tether' : 'GPU renderer',
        description: `test ${kind}`, mguService: kind }, opts.pkg || {});
    const file = path.join(fs.mkdtempSync(path.join(T, 'svc-')), `${name}@${version}.tgz`);
    fs.writeFileSync(file, tgz([
        { name: `package/${opts.binName || name}`, data: opts.bin || elf(), mode: 0o755 },
        { name: 'package/package.json', data: Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), mode: 0o644 }
    ], 1700000000));
    return file;
}

/* An app with rhmiData naming hmis; npm: files under package/. */
function rhmiApp(name, version, hmis, opts) {
    opts = opts || {};
    const pre = opts.npm ? 'package/' : '';
    const pkg = Object.assign({ name, version, description: 'rhmi test app', main: './javascript/app.js' }, opts.pkg || {});
    if (opts.marked) {
        pkg.mguLocalOnly = true;
    }
    const entries = [
        { name: `${pre}javascript/app.js`, data: Buffer.from(`console.log(${JSON.stringify(name)});\n`), mode: 0o644 },
        { name: `${pre}package.json`, data: Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), mode: 0o644 }
    ];
    if (opts.manifest) {
        entries.push({ name: `${pre}manifest.json`, data: Buffer.from(JSON.stringify(opts.manifest)), mode: 0o644 });
    }
    if (opts.acl) {
        entries.push({ name: `${pre}permissions.json`, data: Buffer.from(JSON.stringify(opts.acl)), mode: 0o644 });
    }
    if (hmis) {
        const application = { name, uiDescriptions: hmis.map((h) => ({ applicationFilePath: `./uiDescriptions/${h}/application.xml`, hmi: [h] })) };
        if (opts.appletId) {
            application.appletId = opts.appletId;
        }
        entries.push({ name: `${pre}rhmiData/application.json`, mode: 0o644, data: Buffer.from(JSON.stringify({ application })) });
        hmis.forEach((h) => entries.push({ name: `${pre}rhmiData/uiDescriptions/${h}/application.xml`, data: Buffer.from('<x/>\n'), mode: 0o644 }));
    }
    const file = path.join(fs.mkdtempSync(path.join(T, 'rapp-')), `${name}@${version}.tgz`);
    fs.writeFileSync(file, tgz(entries, 1700000000));
    return file;
}

/* A das file the way MainApp-21's provisioning holds one (made up here:
 * the anchors IterioDev's App Manager edits around). */
function dasText(n) {
    return ['<?xml version="1.0" encoding="UTF-8"?>', `<das id="${n}">`, '    <section name="oap">',
        '        <installable_apps>', '            <app supportedECUs="HU">x_call</app>', '        </installable_apps>',
        '        <x_call enabled="true" allowed="true" appStartType="autostart" userLoginRequired="false"/>',
        '    </section>', '</das>', ''].join('\n');
}

/* A fake iDrive 8: MainApp-21's folder instead of MainApp's, the six das
 * files (opts.prov: a folder of real ones), no recmgr list with opts.noRecmgr. */
function id8Root(opts) {
    opts = Object.assign({ main: fs.readFileSync(path.join(HERE, 'fixtures', 'main21.js'), 'utf8') }, opts);
    const root = fakeRoot(opts);
    fs.renameSync(root.p('usr/lib/oap-mainapp'), root.p('usr/lib/oap-mainapp21'));
    for (let i = 0; i < 6; i += 1) {
        const n = `das_00${i}`;
        write(root.p(`usr/share/tm/prov/${n}.xml`), opts.prov ? fs.readFileSync(path.join(opts.prov, `${n}.xml`)) : dasText(n));
    }
    if (opts.noRecmgr) {
        fs.unlinkSync(root.p('etc/recmgr-restartlist.conf'));
    }
    // Hmi8's built-in applets (opts.builtin: RHMI applet manifests' appletIds, opts.native: native applets' AppletIds)
    (opts.builtin || [20000]).forEach((v, i) => write(root.p(`mnt/dataro/data/hmi8/applet/rhmi${i}/App${i}/App${i}.manifest`),
        `<?xml version="1.0" encoding="utf-8"?>\n<plugin>\n    <name>App${i}</name>\n    <appletId>${v}</appletId>\n</plugin>\n`));
    (opts.native || ['0x08']).forEach((v, i) => write(root.p(`usr/lib/hmi8/applet/native${i}.xml`),
        `<PluginBundle>\n\t<Plugin>\n\t\t<MetaInformation key="AppletId" value="${v}"/>\n\t</Plugin>\n</PluginBundle>\n`));
    fs.mkdirSync(root.p('mnt/dataro/data/hmi8'), { recursive: true });
    root.env.MGU_DEPLOY_HMI8_DATA = root.p('mnt/dataro/data/hmi8');
    root.env.MGU_DEPLOY_HMI8_APPLETS = root.p('usr/lib/hmi8/applet');
    root.env.FAKE_MGR_DIR = 'oap-mainapp21';
    root.noManager = () => fs.writeFileSync(`${root.R}.mgr.pid`, '');
    root.pre21 = (id, v) => root.p(`usr/lib/oap-mainapp21/preinstalled_apps/${id}@${v}.tgz`);
    return root;
}

function testUnitDetect() {
    const r7 = fakeRoot();
    write(r7.p('etc/os-release-id-dlt'), 'BMW MGU P18_23w44.2-1-3 mgu-high\n');
    const st = r7.status();
    check('unit: MainApp in /usr/lib/oap-mainapp is iDrive 7, firmware from os-release-id-dlt',
        JSON.stringify(st.unit) === JSON.stringify({ hmi: 'ID7', firmware: 'BMW MGU P18_23w44.2-1-3 mgu-high' }), JSON.stringify(st.unit));
    const text = r7.run(['status']).stdout;
    check('unit: status says which and why', text.includes('head unit: iDrive 7 (') && text.includes('oap-mainapp)'), text);
    const r8 = id8Root();
    write(r8.p('etc/os-release'), 'NAME="MGU"\nPRETTY_NAME="BMW MGU 23w50"\n');
    check('unit: MainApp-21 in /usr/lib/oap-mainapp21 is iDrive 8, firmware from os-release', JSON.stringify(r8.status().unit) ===
        JSON.stringify({ hmi: 'ID8', firmware: 'BMW MGU 23w50' }), JSON.stringify(r8.status().unit));
    const both = fakeRoot();
    fs.mkdirSync(both.p('usr/lib/oap-mainapp21'), { recursive: true });
    write(both.p('proc/77/comm'), 'Hmi8\n');
    check('unit: with both folders the running HMI decides', both.status().unit.hmi === 'ID8', JSON.stringify(both.status().unit));
    fs.unlinkSync(both.p('proc/77/comm'));
    write(both.p('proc/78/comm'), 'HmiMain3D\n');
    check('unit: HmiMain3D is iDrive 7', both.status().unit.hmi === 'ID7');
    fs.unlinkSync(both.p('proc/78/comm'));
    const r = both.run(['install', '--artifact', rhmiApp('x8', '1.0.0', ['ID8']), '--yes']);
    check('unit: unknown, the install says mguHmi is not checked', both.status().unit.hmi === null &&
        r.out.includes('which head unit this is is unknown (both MainApp folders, no HMI running): mguHmi is not checked'), r.out);
}

/* An app with iDrive 7 and iDrive 8 HMI parts, as MainApp's AppDescription reads them. */
function hmiPartsApp(name, version) {
    const application = { name,
        uiDescriptions: ['ID7', 'ID8'].map((h) => ({ applicationFilePath: `./uiDescriptions/${h}/application.xml`,
            uiDescriptionFilePath: `./uiDescriptions/${h}/uiDescription.json`, hmi: [h] })),
        variantGroups: [{ stringsPath: './variantGroups/Common/texts', resourcesPath: './variantGroups/Common/images', hmi: ['ID7'], brands: ['BMW'] },
            { stringsPath: './variantGroups/Eight/texts', resourcesPath: './variantGroups/Eight/images', hmi: ['ID8'], brands: ['BMW'] }] };
    const pkg = { name, version, description: 'hmi parts test app', main: './javascript/app.js', mguLocalOnly: true };
    const entries = [
        { name: 'javascript/app.js', data: Buffer.from('console.log(1);\n'), mode: 0o644 },
        { name: 'package.json', data: Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), mode: 0o644 },
        { name: 'rhmiData/application.json', data: Buffer.from(JSON.stringify({ application }, null, 2)), mode: 0o644 },
        { name: 'rhmiData/variantGroups/Common/texts/en_US.json', data: Buffer.from('{"SID_TITLE":"Seven"}'), mode: 0o644 },
        { name: 'rhmiData/variantGroups/Common/images/icon.png', data: Buffer.from('seven icon'), mode: 0o644 },
        { name: 'rhmiData/variantGroups/Eight/texts/en_US.json', data: Buffer.from('{"SID_TITLE":"Eight"}'), mode: 0o644 },
        { name: 'rhmiData/variantGroups/Eight/images/icon.png', data: Buffer.from('eight icon'), mode: 0o644 }];
    ['ID7', 'ID8'].forEach((h) => {
        entries.push({ name: `rhmiData/uiDescriptions/${h}/application.xml`, data: Buffer.from(`<${h}/>\n`), mode: 0o644 });
        entries.push({ name: `rhmiData/uiDescriptions/${h}/uiDescription.json`, data: Buffer.from(`{"${h}":1}\n`), mode: 0o644 });
    });
    const file = path.join(fs.mkdtempSync(path.join(T, 'hmiapp-')), `${name}@${version}.tgz`);
    fs.writeFileSync(file, tgz(entries, 1700000000));
    return file;
}

function testHmiParts() {
    const app = hmiPartsApp('kitapp', '1.0.0');
    const appJson = (file) => {
        const m = untar(file);
        return JSON.parse((m['rhmiData/application.json'] || m['package/rhmiData/application.json']).data).application;
    };
    // a unit that reports ID8: MainApp gets a package whose iDrive 7 parts are listed for ID8 and its iDrive 8 ones for nothing
    const r8 = fakeRoot();
    r8.env.MGU_DEPLOY_HMI_VERSION = '3';
    const i8 = r8.run(['install', '--artifact', app, '--yes']);
    const placed = fs.existsSync(r8.preinstalled('kitapp', '1.0.0')) ? appJson(r8.preinstalled('kitapp', '1.0.0')) : null;
    check('hmi parts: on an iDrive 7 unit reporting ID8 the package MainApp installs lists its iDrive 7 parts for ID8, its iDrive 8 ones for nothing',
        i8.status === 0 && placed && JSON.stringify(placed.uiDescriptions.map((u) => u.hmi)) === '[["ID7","ID8"],[]]' &&
        JSON.stringify(placed.variantGroups.map((g) => g.hmi)) === '[["ID7","ID8"],[]]' &&
        i8.out.includes('kitapp 1.0.0: its iDrive 7 HMI parts listed for ID8'), `${i8.out}\n${JSON.stringify(placed)}`);
    const r7 = fakeRoot();
    r7.env.MGU_DEPLOY_HMI_VERSION = '2';
    const i7 = r7.run(['install', '--artifact', app, '--yes']);
    check('hmi parts: a unit reporting ID7 gets the package as it is', i7.status === 0 &&
        sha256(fs.readFileSync(r7.preinstalled('kitapp', '1.0.0'))) === sha256(fs.readFileSync(app)), i7.out);

    // installed with MainApp's iDrive 8 choice: its iDrive 8 UI, its strings and resources folders empty
    const uid = r8.state().apps.kitapp.uid;
    const miss = (root) => {
        const h = root.home(uid);
        ['strings', 'resources'].forEach((d) => fs.mkdirSync(path.join(h, 'rhmiData', d), { recursive: true }));
        write(path.join(h, 'rhmiData/uiDescription/application.xml'), '<ID8/>\n');
        write(path.join(h, 'rhmiData/uiDescription/uiDescription.json'), '{"ID8":1}\n');
    };
    miss(r8);
    const h0 = r8.hash();
    const ro = r8.run(['status', '--read-only', '--json']);
    const rep = JSON.parse(ro.stdout).hmi_parts;
    check('hmi parts: status --read-only names the app and its files, and changes nothing', ro.status === 0 && rep.length === 1 &&
        rep[0].id === 'kitapp' && JSON.stringify(rep[0].files) === JSON.stringify(['rhmiData/uiDescription/application.xml',
            'rhmiData/uiDescription/uiDescription.json', 'rhmiData/strings/en_US.json', 'rhmiData/resources/icon.png']) &&
        r8.hash().hash === h0.hash, `${ro.out}\n${treeDiff(h0, r8.hash())}`);
    const st = r8.status();
    const f = (rel) => path.join(r8.home(uid), 'rhmiData', rel);
    check('hmi parts: status puts the iDrive 7 files in place as MainApp merges them, modes as MainApp\'s', st.hmi_parts.length === 0 &&
        fs.readFileSync(f('uiDescription/application.xml'), 'utf8') === '<ID7/>\n' &&
        fs.readFileSync(f('uiDescription/uiDescription.json'), 'utf8') === '{"ID7":1}\n' &&
        fs.readFileSync(f('strings/en_US.json'), 'utf8') === '{"SID_TITLE":"Seven"}' &&
        fs.readFileSync(f('resources/icon.png'), 'utf8') === 'seven icon' &&
        mode(f('strings/en_US.json')) === 0o660 && mode(f('resources/icon.png')) === 0o644 && mode(f('uiDescription/application.xml')) === 0o644,
        JSON.stringify(st.hmi_parts));
    check('hmi parts: the tile then waits for a restart (Restart pending)', st.pending_reboot.some((p) => p.id === 'kitapp' &&
        p.reason === 'its tile shows from the next start (its iDrive 7 HMI files were put in place)'), JSON.stringify(st.pending_reboot));
    const h1 = r8.hash();
    const again = r8.run(['status', '--json']);
    check('hmi parts: status again changes nothing', again.status === 0 && r8.hash().hash === h1.hash, treeDiff(h1, r8.hash()));

    // a report not read yet: what MainApp installed stays until it is
    miss(r8);
    const hu = r8.hash();
    const unread = r8.run(['status', '--json'], { MGU_DEPLOY_HMI_VERSION: '' });
    check('hmi parts: while the reported HMI is not read status leaves the installed files', unread.status === 0 &&
        r8.hash().hash === hu.hash, treeDiff(hu, r8.hash()));

    // paths in application.json outside rhmiData are never read
    const outside = rebuild(hmiPartsApp('outside', '1.0.0'), (entries) => tgz(entries.map((e) => (e.name !== 'rhmiData/application.json' ? e :
        Object.assign({}, e, { data: Buffer.from(e.data.toString().split('./uiDescriptions/ID7/uiDescription.json')
            .join('./../../../../../../../../etc/passwd')) }))), 1700000000));
    const ri = r8.run(['install', '--artifact', outside, '--yes']);
    const ouid = r8.state().apps.outside && r8.state().apps.outside.uid;
    fs.mkdirSync(path.join(r8.home(ouid), 'rhmiData', 'uiDescription'), { recursive: true });
    const so = r8.status();
    check('hmi parts: a UI file outside the package is never copied', ri.status === 0 &&
        !fs.existsSync(path.join(r8.home(ouid), 'rhmiData/uiDescription/passwd')) && !so.hmi_parts.some((a) => a.id === 'outside'),
        `${ri.out}\n${JSON.stringify(so.hmi_parts)}`);

    // iDrive 8 gets the package's HMI parts as they are, whatever is reported
    const e8 = id8Root();
    e8.env.MGU_DEPLOY_HMI_VERSION = '3';
    const q8 = e8.run(['install', '--artifact', hmiPartsApp('kitapp', '1.0.0'), '--yes']);
    const qf = e8.p('var/opt/mgu-deploy/id8/queue/kitapp@1.0.0.tgz');
    const queued = fs.existsSync(qf) ? appJson(qf) : null;
    check('hmi parts: iDrive 8 installs the package\'s HMI lists as they are', q8.status === 0 && queued &&
        JSON.stringify(queued.uiDescriptions.map((u) => u.hmi)) === '[["ID7"],["ID8"]]' && !q8.out.includes('HMI parts listed') &&
        e8.status().hmi_parts.length === 0, `${q8.out}\n${JSON.stringify(queued)}`);

    // a unit that reports ID7 keeps what MainApp installed
    miss(r7);
    const h7 = r7.hash();
    const st7 = r7.status();
    check('hmi parts: on a unit reporting ID7 status leaves the installed files', st7.hmi_parts.length === 0 && r7.hash().hash === h7.hash,
        treeDiff(h7, r7.hash()));
}

function testCompat() {
    const root = fakeRoot();
    const h0 = root.hash();
    const r = root.run(['install', '--artifact', rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true }), '--yes']);
    check('compat: an app whose rhmiData is iDrive 8 only is refused on iDrive 7, nothing changed', r.status === 2 &&
        r.out.includes('oap-cardash 1.1.4 is for iDrive 8 (its rhmiData); this head unit is iDrive 7') && root.hash().hash === h0.hash, r.out);
    const r2 = root.run(['install', '--artifact', rhmiApp('decl8', '1.0.0', ['ID7'], { pkg: { mguHmi: ['ID8'] } }), '--yes']);
    check('compat: a declared mguHmi wins over the rhmiData', r2.status === 2 &&
        r2.out.includes('decl8 1.0.0 is for iDrive 8; this head unit is iDrive 7'), r2.out);
    const r3 = root.run(['install', '--artifact', rhmiApp('bad', '1.0.0', null, { pkg: { mguHmi: 'ID7' } }), '--yes']);
    check('compat: mguHmi that is not a list of ID7/ID8 is refused', r3.status === 2 && r3.out.includes('mguHmi must list "ID7" and/or "ID8"'), r3.out);
    const c = root.run(['check', '--artifact', rhmiApp('both', '1.0.0', ['ID7', 'ID8'], { marked: true })]);
    check('compat: check names the HMIs an artifact is for', c.out.includes('app both 1.0.0 ok (for iDrive 7 and iDrive 8)'), c.out);
    const kit = fakeRoot();
    const k = kit.run(['install', '--artifact', rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true }), '--artifact', toolArtifact('0.2.0'),
        '--skip-older', '--yes']);
    check('compat: a kit (--skip-older) skips what is not for this unit and installs the rest', k.status === 0 &&
        k.out.includes('oap-cardash 1.1.4 skipped: oap-cardash 1.1.4 is for iDrive 8') && fs.existsSync(kit.p('var/opt/fixture-tool/current')), k.out);
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    const b = hu(['artifact', fixtureCopy('0.2.0', (x) => { x.mguHmi = ['ID8']; }), '--out', out]);
    const r4 = root.run(['install', '--artifact', path.join(out, 'fixture-tool@0.2.0.tgz'), '--yes']);
    check('compat: a tool for iDrive 8 only is refused on iDrive 7 (mguHmi kept by deploy/hu artifact)', b.status === 0 && r4.status === 2 &&
        r4.out.includes('fixture-tool 0.2.0 is for iDrive 8; this head unit is iDrive 7'), b.stderr + r4.out);
}

function testServices() {
    const root = fakeRoot();
    const art = serviceArtifact('renderer', '1.1.0');
    const r = root.run(['install', '--artifact', art, '--yes']);
    const dir = root.p('var/opt/mgu-renderd/versions/1.1.0');
    const unit = fs.existsSync(root.p('etc/systemd/system/mgu-renderd.service')) ?
        fs.readFileSync(root.p('etc/systemd/system/mgu-renderd.service'), 'utf8') : '';
    check('service: a renderer package installs as the tool mgu-renderd', r.status === 0 &&
        fs.readFileSync(path.join(dir, 'mgu-renderd')).equals(elf()) && mode(path.join(dir, 'mgu-renderd')) === 0o755 &&
        readJson(path.join(dir, 'package.json')).mguService === 'renderer' &&
        fs.readlinkSync(root.p('var/opt/mgu-renderd/current')) === 'versions/1.1.0', r.out);
    check('service: its unit runs current/mgu-renderd as root on its socket, no touch routing on iDrive 7',
        unit.includes(`ExecStart=${root.p('var/opt/mgu-renderd/current/mgu-renderd')} --socket /run/mgu-renderd/renderd.sock\n`) &&
        !unit.includes('User=') && unit.includes('RuntimeDirectory=mgu-renderd') && !unit.includes('--touch'), unit);
    check('service: enabled for late.target and listed in recmgr',
        fs.readlinkSync(root.p('etc/systemd/system/late.target.wants/mgu-renderd.service')) === '../mgu-renderd.service' &&
        /\[Whitelist\][^[]*mgu-renderd/.test(fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8')));
    const st = root.status();
    check('service: recmgr has not loaded it: it starts at the next boot', !root.systemctlCalls().includes('start mgu-renderd.service') &&
        st.pending_reboot.some((p) => p.id === 'mgu-renderd' && p.reason === 'starts at the next boot'), JSON.stringify(st.pending_reboot));
    check('service: status lists it as a tool providing renderer',
        st.components.some((c) => c.id === 'mgu-renderd' && c.kind === 'tool' && c.provides === 'renderer'), JSON.stringify(st.components));
    const notElf = root.run(['install', '--artifact', serviceArtifact('renderer', '1.1.1', { bin: Buffer.from('#!/bin/sh\n') }), '--yes']);
    check('service: a program that is not x86-64 is refused', notElf.status === 2 && notElf.out.includes('mgu-renderd is not an x86-64 program'), notElf.out);
    const named = root.run(['install', '--artifact', serviceArtifact('renderer', '1.1.1', { name: 'other-renderd' }), '--yes']);
    check('service: a renderer package must be called mgu-renderd', named.status === 2 &&
        named.out.includes('a renderer package is named mgu-renderd, not other-renderd'), named.out);
    const kind = root.run(['install', '--artifact', serviceArtifact('bogus', '1.0.0', { name: 'bogus' }), '--yes']);
    check('service: an unknown mguService is refused', kind.status === 2 && kind.out.includes('unknown mguService bogus'), kind.out);
    const t = root.run(['install', '--artifact', serviceArtifact('tether', '1.0.1'), '--yes']);
    check('service: a tether package is refused: mgu-uplink drives the iPhone', t.status === 2 &&
        t.out.includes('the iPhone tether is replaced by mgu-uplink') && !fs.existsSync(root.p('var/opt/ipheth-tether')), t.out);
    const his = fakeRoot();
    write(his.p('etc/systemd/system/mgu-renderd.service'), '[Service]\nExecStart=/var/opt/appmanager/renderer/mgu-renderd\n');
    const h0 = his.hash();
    const fr = his.run(['install', '--artifact', art, '--yes']);
    check('service: a renderer whose unit another manager installed is refused, nothing changed',
        fr.status === 2 && fr.out.includes('mgu-renderd 1.1.0: mgu-renderd.service is installed, but by no tool of ours') &&
        his.hash().hash === h0.hash, fr.out);
    const u = root.run(['uninstall', 'mgu-renderd', '--yes']);
    check('service: uninstall removes the tool, its unit, link and recmgr entry', u.status === 0 &&
        !fs.existsSync(root.p('var/opt/mgu-renderd')) && !fs.existsSync(root.p('etc/systemd/system/mgu-renderd.service')) &&
        !fs.existsSync(root.p('etc/systemd/system/late.target.wants/mgu-renderd.service')) &&
        !/mgu-renderd/.test(fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8')), u.out);

    const r8 = id8Root({ noRecmgr: true });
    const i8 = r8.run(['install', '--artifact', art, '--yes']);
    const unit8 = fs.readFileSync(r8.p('etc/systemd/system/mgu-renderd.service'), 'utf8');
    check('service: on iDrive 8 without a recmgr list it starts at once, with touch routing over the iDrive 8 app area',
        i8.status === 0 && r8.systemctlCalls().includes('start mgu-renderd.service') &&
        unit8.includes('--socket /run/mgu-renderd/renderd.sock --touch car --touch-area 0,76,2880,764') &&
        unit8.includes('nft delete table ip touchroute') && !fs.existsSync(r8.p('etc/recmgr-restartlist.conf')) &&
        r8.status().pending_reboot.length === 0, i8.out);
    const vm = id8Root({ noRecmgr: true });
    write(vm.p('usr/bin/vminput'), '');
    vm.run(['install', '--artifact', art, '--yes']);
    check('service: in the MGU VM (vminput) its touch comes from the VM',
        fs.readFileSync(vm.p('etc/systemd/system/mgu-renderd.service'), 'utf8').includes('--touch vm --touch-area'));
}

function providerArtifact(version, edit) {
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    const r = hu(['artifact', fixtureCopy(version, (c) => { c.mguProvides = 'renderer'; c.enable = []; if (edit) edit(c); }), '--out', out]);
    if (r.status !== 0) {
        throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
    }
    return path.join(out, `fixture-tool@${version}.tgz`);
}

/* After a firmware update (the root put back, /var/opt kept), any install
 * lays an installed tool again from the copy of its units and drop-ins kept
 * at its install; status says what a tool lacks until then. */
function testToolsAfterFirmware() {
    const FW = 'etc/os-release-id-dlt';
    const art = (() => {
        const out = fs.mkdtempSync(path.join(T, 'art-'));
        const r = hu(['artifact', fixtureCopy('0.2.0', (c) => {
            c.dropins = [{ unit: 'hmi.service', name: 'zz-fixture-tool.conf', from: 'fixture-tool.conf' }];
        }), '--out', out]);
        if (r.status !== 0) {
            throw new Error(r.stderr);
        }
        return path.join(out, 'fixture-tool@0.2.0.tgz');
    })();
    const sys = (root, rel) => root.p(`etc/systemd/system/${rel}`);
    const PIECES = ['fixture-tool.service', 'fixture-tool.socket', 'sockets.target.wants/fixture-tool.socket', 'hmi.service.d/zz-fixture-tool.conf'];
    const reset = (root, fw) => {
        PIECES.forEach((rel) => fs.rmSync(sys(root, rel), { force: true }));
        write(root.p(FW), `${fw}\n`);
    };
    const kept = (root, rel) => root.p(`var/opt/mgu-deploy/kept/fixture-tool/0.2.0/${rel}`);
    const stateOf = (root) => JSON.parse(fs.readFileSync(root.p('var/opt/mgu-deploy/state.json'), 'utf8'));
    const tool = (root) => root.status().components.find((c) => c.id === 'fixture-tool');
    const other = () => namedTool('other-tool', '0.1.0');

    let root = fakeRoot({ recmgr: ['fixture-tool'] });
    write(sys(root, 'hmi.service'), '[Service]\nExecStart=/usr/bin/HmiMain3D\n');
    write(root.p(FW), 'BMW MGU P18_21w03 mgu-high\n');
    let r = root.run(['install', '--artifact', art, '--yes']);
    const bytes = PIECES.slice(0, 2).concat([PIECES[3]]).map((rel) => fs.readFileSync(sys(root, rel), 'utf8'));
    check('tools after firmware: an install keeps the tool\'s units, drop-ins and component.json, and records the firmware',
        r.status === 0 && fs.readFileSync(kept(root, 'units/fixture-tool.service'), 'utf8') === bytes[0] &&
        fs.readFileSync(kept(root, 'dropins/hmi.service.d/zz-fixture-tool.conf'), 'utf8') === bytes[2] &&
        fs.existsSync(kept(root, 'component.json')) && stateOf(root).tools['fixture-tool'].firmware === 'BMW MGU P18_21w03 mgu-high' &&
        tool(root).stale === null && tool(root).kept === true, r.out);

    reset(root, 'BMW MGU P18_23w44.2-1-3 mgu-high');
    const st = root.run(['status']);
    check('tools after firmware: status says what the tool lacks', tool(root).stale ===
        'fixture-tool.socket, fixture-tool.service, sockets.target.wants/fixture-tool.socket, hmi.service.d/zz-fixture-tool.conf missing' &&
        st.out.includes('tool fixture-tool 0.2.0 (not working: fixture-tool.socket, fixture-tool.service, sockets.target.wants/fixture-tool.socket, hmi.service.d/zz-fixture-tool.conf missing)'),
        `${JSON.stringify(tool(root))}\n${st.out}`);
    r = root.run(['install', '--artifact', other(), '--yes']);
    check('tools after firmware: an install of something else lays the tool again from its copy, as it was',
        r.status === 0 && r.out.includes('fixture-tool 0.2.0: fixture-tool.socket, fixture-tool.service, sockets.target.wants/fixture-tool.socket, hmi.service.d/zz-fixture-tool.conf missing; laid again from the copy kept here') &&
        PIECES.slice(0, 2).concat([PIECES[3]]).every((rel, i) => fs.readFileSync(sys(root, rel), 'utf8') === bytes[i]) &&
        fs.readlinkSync(sys(root, PIECES[2])) === '../fixture-tool.socket' && tool(root).stale === null &&
        stateOf(root).tools['fixture-tool'].firmware === 'BMW MGU P18_23w44.2-1-3 mgu-high', r.out);
    r = root.run(['install', '--artifact', other(), '--yes']);
    check('tools after firmware: the next install leaves it alone', r.status === 0 && !r.out.includes('laid again'), r.out);
    reset(root, 'BMW MGU P18_23w44.2-1-3 mgu-high');
    r = root.run(['relay', '--yes']);
    check('tools after firmware: relay lays a tool with no install step again whole, never needing setup',
        r.status === 0 && r.out.includes('laid again from the copy kept here') && fs.existsSync(sys(root, 'fixture-tool.service')) &&
        tool(root).stale === null && tool(root).needs_setup === null, r.out);

    write(root.p(FW), 'BMW MGU P18_24w07 mgu-high\n');
    check('tools after firmware: with its pieces in place, another firmware still counts',
        tool(root).stale === 'installed under firmware BMW MGU P18_23w44.2-1-3 mgu-high', JSON.stringify(tool(root)));
    r = root.run(['install', '--artifact', other(), '--yes']);
    check('tools after firmware: and an install lays it again', r.status === 0 &&
        r.out.includes('fixture-tool 0.2.0: installed under firmware BMW MGU P18_23w44.2-1-3 mgu-high; laid again from the copy kept here') &&
        tool(root).stale === null, r.out);

    // installed before copies were kept: said, left for its source
    fs.rmSync(root.p('var/opt/mgu-deploy/kept/fixture-tool'), { recursive: true });
    const s = stateOf(root);
    delete s.tools;
    fs.writeFileSync(root.p('var/opt/mgu-deploy/state.json'), JSON.stringify(s));
    r = root.run(['install', '--artifact', other(), '--yes']);
    check('tools after firmware: a tool with no firmware recorded and its pieces in place gets the firmware recorded',
        r.status === 0 && stateOf(root).tools['fixture-tool'].firmware === 'BMW MGU P18_24w07 mgu-high' && !r.out.includes('fixture-tool 0.2.0:'), r.out);
    reset(root, 'BMW MGU P18_24w07 mgu-high');
    r = root.run(['install', '--artifact', other(), '--yes']);
    check('tools after firmware: one with no copy kept is left for its source to install again, said, exit 0', r.status === 0 &&
        r.out.includes('fixture-tool 0.2.0: fixture-tool.socket, fixture-tool.service, sockets.target.wants/fixture-tool.socket, hmi.service.d/zz-fixture-tool.conf missing; no copy of it is kept here, so its source installs it again') &&
        !fs.existsSync(sys(root, 'fixture-tool.service')) && tool(root).kept === false && tool(root).stale !== null, r.out);
    r = root.run(['install', '--artifact', art, '--yes']);
    check('tools after firmware: its own install, the same version, lays it and keeps the copy', r.status === 0 &&
        fs.existsSync(sys(root, 'fixture-tool.service')) && fs.existsSync(sys(root, PIECES[3])) && tool(root).stale === null &&
        tool(root).kept === true, r.out);

    r = root.run(['uninstall', 'fixture-tool', '--yes']);
    check('tools after firmware: an uninstall removes the copy and the record', r.status === 0 &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/kept/fixture-tool')) && !(stateOf(root).tools || {})['fixture-tool'], r.out);
}

/* A tool with an install step (activate, postInstall) set up under another
 * firmware: an install of something else, or relay, lays its files only,
 * its step left for its next install or Set up (setup), which runs it and
 * the stock-file fix after it; nothing restarts the head unit. */
function testToolsAfterFirmwareSetup() {
    const FW = 'etc/os-release-id-dlt';
    const PIECES = ['fixture-tool.service', 'fixture-tool.socket', 'sockets.target.wants/fixture-tool.socket'];
    const sys = (root, rel) => root.p(`etc/systemd/system/${rel}`);
    const hooks = (root) => (fs.existsSync(`${root.R}.hooks.log`) ? fs.readFileSync(`${root.R}.hooks.log`, 'utf8').split('\n').filter(Boolean) : []);
    const tool = (root) => root.status().components.find((c) => c.id === 'fixture-tool');
    const stateOf = (root) => JSON.parse(fs.readFileSync(root.p('var/opt/mgu-deploy/state.json'), 'utf8'));
    const firmwareUpdate = (root, fw) => {
        PIECES.forEach((rel) => fs.rmSync(sys(root, rel), { force: true }));
        write(root.p(FW), `${fw}\n`);
        write(root.p('usr/bin/carplay'), 'stock carplay\n', 0o755);
    };
    const setUp = () => {
        const root = fakeRoot({ recmgr: ['fixture-tool'] });
        Object.assign(root.env, { FAKE_HOOK_LOG: `${root.R}.hooks.log`,
            FAKE_HOOK_CHMOD: JSON.stringify([['activate', root.p('usr/bin/carplay'), '700']]) });
        write(root.p(FW), 'BMW MGU P18_21w03 mgu-high\n');
        write(root.p('usr/bin/carplay'), 'stock carplay\n', 0o755);
        const r = root.run(['install', '--artifact', hookArtifact('3.0.0'), '--yes']);
        if (r.status !== 0) throw new Error(r.out);
        firmwareUpdate(root, 'BMW MGU P18_23w44.2-1-3 mgu-high');
        return root;
    };

    let root = setUp();
    let n = hooks(root).length;
    const kills = root.kills().length;
    let r = root.run(['install', '--artifact', namedTool('other-tool', '0.1.0'), '--yes']);
    check('tools after firmware, with an install step: an install of something else lays its files only, no hook, carplay stock',
        r.status === 0 && PIECES.every((rel) => lstatOrNullT(sys(root, rel))) && hooks(root).length === n &&
        !r.out.includes('fixture-tool activate:') && mode(root.p('usr/bin/carplay')) === 0o755 &&
        r.out.includes('fixture-tool 3.0.0: fixture-tool.socket, fixture-tool.service, sockets.target.wants/fixture-tool.socket missing; ' +
            'its files are laid again, its install step waits for its next install or Set up') &&
        r.out.includes('needs setup (its install step runs at its next install or update, or with Set up in the Store): fixture-tool'), r.out);
    let t = tool(root);
    check('tools after firmware, with an install step: status says it needs setup, stale no more, the firmware it runs under recorded',
        t.stale === null && /missing$/.test(t.needs_setup) && stateOf(root).tools['fixture-tool'].firmware === 'BMW MGU P18_23w44.2-1-3 mgu-high', JSON.stringify(t));
    r = root.run(['install', '--artifact', namedTool('other-tool', '0.1.0'), '--yes']);
    check('tools after firmware, with an install step: the next install leaves it alone, still needing setup',
        r.status === 0 && !r.out.includes('fixture-tool 3.0.0:') && hooks(root).length === n && tool(root).needs_setup, r.out);
    r = root.run(['setup', 'fixture-tool', '--yes']);
    t = tool(root);
    check('tools after firmware, with an install step: setup lays it again from its copy with its activate, the stock-file fix after it',
        r.status === 0 && hooks(root).slice(n).some((l) => /^activate 3\.0\.0/.test(l)) && t.needs_setup === null && t.stale === null &&
        mode(root.p('usr/bin/carplay')) === 0o755 && r.out.includes('it becomes 0755'), `${r.out}\n${hooks(root).slice(n).join('\n')}`);
    r = root.run(['setup', 'fixture-tool', '--yes']);
    check('tools after firmware, with an install step: setup of a tool that needs none is refused, exit 2', r.status === 2 &&
        r.out.includes('needs no setup'), r.out);
    check('tools after firmware, with an install step: nothing restarted the app manager', root.kills().length === kills);

    // --leave: a tool a later install of the caller installs is not laid again by this one
    root = setUp();
    r = root.run(['install', '--artifact', namedTool('other-tool', '0.1.0'), '--leave', 'fixture-tool', '--yes']);
    check('tools after firmware, with an install step: an install with --leave leaves that tool for its own install',
        r.status === 0 && !r.out.includes('fixture-tool 3.0.0:') && !lstatOrNullT(sys(root, PIECES[0])) && tool(root).needs_setup === null, r.out);

    // a setup whose step fails: rolled back, exit 1, still needing setup
    root = setUp();
    root.run(['relay', '--yes']);
    r = root.run(['setup', 'fixture-tool', '--yes'], { FAKE_HOOK_FAIL: 'activate@3.0.0' });
    check('tools after firmware, with an install step: a setup whose step fails exits 1, rolled back, still needing setup',
        r.status === 1 && r.out.includes('activate exited 3') && /missing$/.test(tool(root).needs_setup), r.out);

    // an install refused at its preflight lays nothing
    root = setUp();
    write(root.p('usr/lib/oap-mainapp/src/main.js'), 'no anchors here\n');
    r = root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('tools after firmware, with an install step: an install refused before it changes anything lays no tool again',
        r.status === 2 && !lstatOrNullT(sys(root, PIECES[0])) && tool(root).needs_setup === null && !r.out.includes('its files are laid again'), r.out);

    // an update after a firmware move whose activate fails: no activate of the version it replaces, files only, needs setup, exit 1
    [['relayed first', true], ['stale', false]].forEach(([what, relayed]) => {
        root = setUp();
        if (relayed) root.run(['relay', '--yes']);
        n = hooks(root).length;
        r = root.run(['install', '--artifact', hookArtifact('3.0.1'), '--yes'], { FAKE_HOOK_FAIL: 'activate@3.0.1' });
        const ran = hooks(root).slice(n);
        check(`tools after firmware, with an install step (${what}): an update whose activate fails exits 1, rolled back to its files only, ` +
            'no activate of the version it replaces, needing setup',
            r.status === 1 && ran.some((l) => /^activate 3\.0\.1/.test(l)) && !ran.some((l) => /^activate 3\.0\.0/.test(l)) &&
            fs.readlinkSync(root.p('var/opt/fixture-tool/current')) === 'versions/3.0.0' && /failed after a firmware update$/.test(tool(root).needs_setup) &&
            r.out.includes('fixture-tool 3.0.0: its files are back, its install step waits for its next install or Set up'), `${r.out}\n${ran.join('\n')}`);
    });

    // from another source after a firmware move: the deactivate of the version it replaces does not run
    root = setUp();
    n = hooks(root).length;
    r = root.run(['install', '--artifact', hookArtifact('3.0.1'), '--other-source', '--yes']);
    check('tools after firmware, with an install step: an install from another source after a firmware move runs no deactivate of the version it replaces',
        r.status === 0 && !hooks(root).slice(n).some((l) => /^deactivate 3\.0\.0/.test(l)) && hooks(root).slice(n).some((l) => /^activate 3\.0\.1/.test(l)) &&
        tool(root).needs_setup === null, `${r.out}\n${hooks(root).slice(n).join('\n')}`);

    // a downgrade after a firmware move: the replaced 3.0.1's deactivate runs first (it may have changed the
    // firmware's files since, through its own tool), then 3.0.0's activate; the install after it runs no deactivate
    root = setUp();
    r = root.run(['install', '--artifact', hookArtifact('3.0.1'), '--yes']);
    if (r.status !== 0) throw new Error(r.out);
    firmwareUpdate(root, 'BMW MGU P18_24w07 mgu-high');
    n = hooks(root).length;
    r = root.run(['install', '--artifact', hookArtifact('3.0.0'), '--yes']);
    const ranDown = hooks(root).slice(n).map((l) => l.split(' ').slice(0, 2).join(' '));
    n = hooks(root).length;
    const r2 = root.run(['install', '--artifact', hookArtifact('3.0.0'), '--yes']);
    check('tools after firmware, with an install step: a downgrade after a firmware move runs the deactivate of the version replaced, ' +
        'all of it in place, then its own activate; the install after it runs no deactivate',
        r.status === 0 && r2.status === 0 && JSON.stringify(ranDown) === JSON.stringify(['deactivate 3.0.1', 'activate 3.0.0']) &&
        !hooks(root).slice(n).some((l) => /^deactivate/.test(l)) && fs.readlinkSync(root.p('var/opt/fixture-tool/current')) === 'versions/3.0.0',
        `${r.out}\n${r2.out}\n${ranDown.join('\n')}`);
    // the same downgrade whose deactivate fails: refused, exit 2, 3.0.1 stays current
    root = setUp();
    r = root.run(['install', '--artifact', hookArtifact('3.0.1'), '--yes']);
    if (r.status !== 0) throw new Error(r.out);
    firmwareUpdate(root, 'BMW MGU P18_24w07 mgu-high');
    n = hooks(root).length;
    r = root.run(['install', '--artifact', hookArtifact('3.0.0'), '--yes'], { FAKE_HOOK_FAIL: 'deactivate@3.0.1' });
    check('tools after firmware, with an install step: a downgrade after a firmware move whose deactivate fails is refused, exit 2, ' +
        'the version replaced stays current, no activate, needing setup',
        r.status === 2 && r.out.includes('fixture-tool 3.0.1: deactivate exited 3') && fs.readlinkSync(root.p('var/opt/fixture-tool/current')) === 'versions/3.0.1' &&
        JSON.stringify(hooks(root).slice(n).map((l) => l.split(' ').slice(0, 2).join(' '))) === JSON.stringify(['deactivate 3.0.1']) &&
        /failed after a firmware update$/.test(tool(root).needs_setup), `${r.out}\n${hooks(root).slice(n).join('\n')}`);
    // the same from another source
    root = setUp();
    n = hooks(root).length;
    r = root.run(['install', '--artifact', hookArtifact('3.0.1'), '--other-source', '--yes']);
    const r3 = root.run(['install', '--artifact', hookArtifact('3.0.2'), '--yes']);
    check('tools after firmware, with an install step: an install from another source after a firmware move, and the update after it, run no deactivate of 3.0.0',
        r.status === 0 && r3.status === 0 && !hooks(root).slice(n).some((l) => /^deactivate 3\.0\.0/.test(l)), `${r.out}\n${r3.out}\n${hooks(root).slice(n).join('\n')}`);

    // a refusal inside the work after files were laid again: exit 1, saying what was laid
    root = setUp();
    r = root.run(['install', '--artifact', namedHookTool('other-hook', '1.0.0'), '--yes']);
    if (r.status !== 0) throw new Error(r.out);
    firmwareUpdate(root, 'BMW MGU P18_24w07 mgu-high');
    // other-hook's record put on this firmware, so its downgrade is not after a firmware update
    const st0 = stateOf(root);
    st0.tools['other-hook'].firmware = 'BMW MGU P18_24w07 mgu-high';
    write(root.p('var/opt/mgu-deploy/state.json'), JSON.stringify(st0));
    r = root.run(['install', '--artifact', namedHookTool('other-hook', '0.9.0'), '--yes'], { FAKE_HOOK_FAIL: 'deactivate@1.0.0' });
    check('tools after firmware, with an install step: a refusal after files were laid again exits 1, naming what was laid',
        r.status === 1 && r.out.includes('deactivate exited 3') && r.out.includes('laid again before this failure, files only, and kept: fixture-tool') &&
        PIECES.every((rel) => lstatOrNullT(sys(root, rel))) && /missing$/.test(tool(root).needs_setup), r.out);

    // relay <id> and setup <id>: that tool only
    root = setUp();
    r = root.run(['install', '--artifact', namedHookTool('other-hook', '1.0.0', (c) => { c.units = [{ name: 'other-hook.service', from: 'systemd/fixture-tool.service' }]; }), '--yes']);
    if (r.status !== 0) throw new Error(r.out);
    // both stale: fixture-tool's pieces gone again, other-hook's unit gone
    firmwareUpdate(root, 'BMW MGU P18_24w07 mgu-high');
    fs.rmSync(sys(root, 'other-hook.service'), { force: true });
    const others = () => root.status().components.find((c) => c.id === 'other-hook');
    r = root.run(['relay', 'fixture-tool', '--yes']);
    check('tools after firmware: relay <id> lays only that tool again', r.status === 0 && /missing$/.test(tool(root).needs_setup) &&
        others().stale !== null && others().needs_setup === null && !lstatOrNullT(sys(root, 'other-hook.service')), r.out);
    r = root.run(['setup', 'fixture-tool', '--yes']);
    check('tools after firmware: setup <id> sets up only that tool', r.status === 0 && tool(root).needs_setup === null &&
        others().stale !== null && others().needs_setup === null && !lstatOrNullT(sys(root, 'other-hook.service')), r.out);

    // relay: the files only, asked for
    root = setUp();
    n = hooks(root).length;
    r = root.run(['relay', '--yes']);
    check('tools after firmware, with an install step: relay lays its files only and records why it needs setup',
        r.status === 0 && PIECES.every((rel) => lstatOrNullT(sys(root, rel))) && hooks(root).length === n && /missing$/.test(tool(root).needs_setup), r.out);
    r = root.run(['relay', '--yes']);
    check('tools after firmware, with an install step: relay again has nothing to do', r.status === 0 && r.out.includes('nothing to lay again'), r.out);

    // its pieces in place, another firmware: needs setup too, nothing laid
    root = setUp();
    root.run(['relay', '--yes']);
    root.run(['setup', 'fixture-tool', '--yes']);
    write(root.p(FW), 'BMW MGU P18_24w07 mgu-high\n');
    n = hooks(root).length;
    r = root.run(['install', '--artifact', namedTool('other-tool', '0.1.0'), '--yes']);
    check('tools after firmware, with an install step: under another firmware with its pieces in place, it needs setup, no hook',
        r.status === 0 && hooks(root).length === n && tool(root).needs_setup === 'installed under firmware BMW MGU P18_23w44.2-1-3 mgu-high', r.out);

    // an install of a newer version runs its step and clears it
    r = root.run(['install', '--artifact', hookArtifact('3.0.1'), '--yes']);
    check('tools after firmware, with an install step: an install of a newer version runs its activate, nothing needs setup',
        r.status === 0 && hooks(root).slice(n).some((l) => /^activate 3\.0\.1/.test(l)) && tool(root).needs_setup === null, r.out);
}

/* A tool of id with fake_hook.js as its activate and deactivate. */
function namedHookTool(id, version, edit) {
    const dir = fixtureCopy(version, (c) => {
        c.id = id;
        c.units = [];
        c.enable = [];
        c.recmgr = [];
        c.restart = [];
        c.files.push({ path: 'hook.js', from: 'hook.js', mode: '0644' });
        c.activate = ['node', 'hook.js', 'activate'];
        c.deactivate = ['node', 'hook.js', 'deactivate'];
        if (edit) {
            edit(c);
        }
    });
    fs.copyFileSync(path.join(HERE, 'fake_hook.js'), path.join(dir, 'hook.js'));
    const out = fs.mkdtempSync(path.join(T, 'art-'));
    const r = hu(['artifact', dir, '--out', out]);
    if (r.status !== 0) {
        throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
    }
    return path.join(out, `${id}@${version}.tgz`);
}

/* A tool's drop-in for a unit it does not own: installed into a folder it
 * creates, the unit's own files untouched, refused over a foreign one,
 * rolled back with a failed install, and removed (with the folder) on
 * uninstall, leaving the unit as it was. */
function testDropins() {
    const dropinTool = (version, none) => {
        const out = fs.mkdtempSync(path.join(T, 'art-'));
        const r = hu(['artifact', fixtureCopy(version, (c) => {
            c.enable = [];
            if (!none) {
                c.dropins = [{ unit: 'hmi.service', name: 'zz-fixture-tool.conf', from: 'fixture-tool.conf' }];
            }
        }), '--out', out]);
        if (r.status !== 0) {
            throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
        }
        return path.join(out, `fixture-tool@${version}.tgz`);
    };
    const root = fakeRoot({ recmgr: ['fixture-tool'] });
    write(root.p('etc/systemd/system/hmi.service'), '[Service]\nExecStart=/usr/bin/HmiMain3D\n');
    // the deploy tool's own files and the recmgr list (the fixture's entry) are not what this is about
    const skip = (rel) => rel.startsWith('var/opt/mgu-deploy') || rel === 'etc/recmgr-restartlist.conf';
    const before = root.hash(skip);
    const art = dropinTool('0.2.0');
    const r = root.run(['install', '--artifact', art, '--yes']);
    const drop = root.p('etc/systemd/system/hmi.service.d/zz-fixture-tool.conf');
    check('dropins: installed into <unit>.d/, the unit itself untouched', r.status === 0 && fs.existsSync(drop) &&
        fs.readFileSync(drop, 'utf8') === fs.readFileSync(path.join(FIXTURE_TOOL, 'fixture-tool.conf'), 'utf8') &&
        fs.readFileSync(root.p('etc/systemd/system/hmi.service'), 'utf8') === '[Service]\nExecStart=/usr/bin/HmiMain3D\n' &&
        root.systemctlCalls().indexOf('daemon-reload') >= 0, r.out);
    const un = root.run(['uninstall', 'fixture-tool', '--yes']);
    const after = root.hash(skip);
    check('dropins: uninstall removes the drop-in and the folder it created: the unit is as before', un.status === 0 &&
        !fs.existsSync(root.p('etc/systemd/system/hmi.service.d')) && after.hash === before.hash, `${un.out}\n${treeDiff(before, after)}`);

    // a folder that was there stays, with the other drop-ins in it
    write(root.p('etc/systemd/system/hmi.service.d/10-stock.conf'), '[Service]\nEnvironment=A=1\n');
    const r2 = root.run(['install', '--artifact', art, '--yes']);
    const u2 = root.run(['uninstall', 'fixture-tool', '--yes']);
    check('dropins: a folder that was there stays with its other drop-ins', r2.status === 0 && u2.status === 0 &&
        fs.readdirSync(root.p('etc/systemd/system/hmi.service.d')).join() === '10-stock.conf', `${r2.out}\n${u2.out}`);

    // a drop-in of that name no tool of ours installed
    write(drop, '[Service]\nEnvironment=OTHER=1\n');
    const h = root.hash(skip);
    const foreign = root.run(['install', '--artifact', art, '--yes']);
    check('dropins: one of that name no tool of ours installed is refused, nothing changed', foreign.status === 2 &&
        foreign.out.includes('hmi.service.d/zz-fixture-tool.conf is installed, but by no tool of ours') && root.hash(skip).hash === h.hash, foreign.out);
    fs.unlinkSync(drop);

    // an update that adds the drop-in and fails its health check is rolled back without it
    const h2 = root.hash(skip);
    const first = root.run(['install', '--artifact', dropinTool('0.1.0', true), '--yes']);
    write(root.unitFile('fixture-tool.service.crash'), `${root.p('var/opt/fixture-tool/current')} versions/0.2.0`);
    const bad = root.run(['install', '--artifact', art, '--yes']);
    fs.unlinkSync(root.unitFile('fixture-tool.service.crash'));
    check('dropins: a failed update is rolled back without its drop-in', first.status === 0 && bad.status === 1 && !fs.existsSync(drop) &&
        fs.readlinkSync(root.p('var/opt/fixture-tool/current')) === 'versions/0.1.0', `${bad.out}`);
    // an update without the drop-in that fails its health check puts the drop-in back
    const withIt = root.run(['install', '--artifact', art, '--yes']);
    write(root.unitFile('fixture-tool.service.crash'), `${root.p('var/opt/fixture-tool/current')} versions/0.4.0`);
    const failed = root.run(['install', '--artifact', dropinTool('0.4.0', true), '--yes']);
    fs.unlinkSync(root.unitFile('fixture-tool.service.crash'));
    check('dropins: a failed update without the drop-in is rolled back with it', withIt.status === 0 && failed.status === 1 &&
        fs.existsSync(drop) && fs.readlinkSync(root.p('var/opt/fixture-tool/current')) === 'versions/0.2.0', failed.out);
    // an update without the drop-in removes it
    const without = root.run(['install', '--artifact', dropinTool('0.3.0', true), '--yes']);
    check('dropins: an update whose version has no drop-in removes the one before it', without.status === 0 &&
        !fs.existsSync(drop), `${withIt.out}\n${without.out}`);
    root.run(['uninstall', 'fixture-tool', '--yes']);
    check('dropins: ...and after its removal the unit\'s folder is as before', root.hash(skip).hash === h2.hash, treeDiff(h2, root.hash(skip)));
}

/* idrive7-apps' own installer (deploy/mgu-app-install.sh there) left its
 * renderer and controller gate: a tool of ours takes them over. */
function i7Leftovers(root) {
    const mark = '# added by mgu-app-install.sh - GPU renderer for the custom apps\n';
    write(root.p('etc/systemd/system/mgu-renderd.service'), `${mark}[Service]\nRuntimeDirectory=mgu-renderd\nExecStart=/var/opt/mgu-renderd/mgu-renderd --group 12202\n`);
    fs.mkdirSync(root.p('etc/systemd/system/oapcontroller.service.wants'), { recursive: true });
    fs.symlinkSync('../mgu-renderd.service', root.p('etc/systemd/system/oapcontroller.service.wants/mgu-renderd.service'));
    write(root.p('etc/systemd/system/mgu-inputgate-guard.service'), '# added by mgu-app-install.sh - boot guard\n[Service]\nType=oneshot\n');
    write(root.p('etc/systemd/system/hmi.service.d/zz-mgu-inputgate.conf'), '# added by mgu-app-install.sh - gate\n[Service]\nEnvironmentFile=-/run/mgu-inputgate.env\n');
    ['mgu-renderd', 'mgu-inputgate.so', 'inputgate-guard.sh', 'inputgate.env', 'inputgate.strikes'].forEach((f) => write(root.p(`var/opt/mgu-renderd/${f}`), f));
}
function testI7Takeover() {
    const toolArt = (version, edit, unitTail) => {
        const dir = fixtureCopy(version, (c) => { c.enable = []; edit(c); });
        if (unitTail) {
            fs.appendFileSync(path.join(dir, 'systemd', 'fixture-tool.service'), unitTail);
        }
        const out = fs.mkdtempSync(path.join(T, 'art-'));
        const r = hu(['artifact', dir, '--out', out]);
        if (r.status !== 0) {
            throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
        }
        return path.join(out, `fixture-tool@${version}.tgz`);
    };
    // a renderer serving the community socket's folder
    const root = fakeRoot({ recmgr: ['fixture-tool'] });
    i7Leftovers(root);
    const r = root.run(['install', '--artifact', toolArt('0.2.0', (c) => { c.mguProvides = 'renderer'; }, 'RuntimeDirectory=mgu-renderd\n'), '--yes']);
    check('idrive7-apps installer: a renderer serving /run/mgu-renderd replaces theirs: unit, enablement and program go, nothing stopped',
        r.status === 0 && !fs.existsSync(root.p('etc/systemd/system/mgu-renderd.service')) &&
        !fs.existsSync(root.p('etc/systemd/system/oapcontroller.service.wants/mgu-renderd.service')) &&
        !fs.existsSync(root.p('var/opt/mgu-renderd/mgu-renderd')) && fs.existsSync(root.p('var/opt/mgu-renderd/mgu-inputgate.so')) &&
        fs.existsSync(root.p('etc/systemd/system/mgu-inputgate-guard.service')) &&
        !root.systemctlCalls().some((c) => /^stop mgu-renderd/.test(c)) && r.out.includes("takes over from idrive7-apps' installer"), r.out);
    // a renderer update that fails its health check puts theirs back
    const failing = fakeRoot({ recmgr: ['fixture-tool'] });
    i7Leftovers(failing);
    const first = failing.run(['install', '--artifact', toolArt('0.2.0', (c) => { c.mguProvides = 'renderer'; }), '--yes']);
    check('idrive7-apps installer: a renderer on a socket of its own installs beside theirs', first.status === 0 &&
        fs.existsSync(failing.p('etc/systemd/system/mgu-renderd.service')), first.out);
    const art = toolArt('0.3.0', (c) => { c.mguProvides = 'renderer'; }, 'RuntimeDirectory=mgu-renderd\n');
    write(failing.unitFile('fixture-tool.service.crash'), `${failing.p('var/opt/fixture-tool/current')} versions/0.3.0`);
    const back = failing.run(['install', '--artifact', art, '--yes']);
    check('idrive7-apps installer: a failed renderer update puts their renderer back',
        back.status === 1 && fs.existsSync(failing.p('etc/systemd/system/mgu-renderd.service')) &&
        fs.readlinkSync(failing.p('etc/systemd/system/oapcontroller.service.wants/mgu-renderd.service')) === '../mgu-renderd.service' &&
        fs.readFileSync(failing.p('var/opt/mgu-renderd/mgu-renderd'), 'utf8') === 'mgu-renderd', back.out);

    // the controller gate: units and drop-in of the same names
    const gate = fakeRoot({ recmgr: ['fixture-tool'] });
    i7Leftovers(gate);
    const g = gate.run(['install', '--artifact', toolArt('0.2.0', (c) => {
        c.units.push({ name: 'mgu-inputgate-guard.service', from: 'systemd/fixture-tool.service' });
        c.dropins = [{ unit: 'hmi.service', name: 'zz-mgu-inputgate.conf', from: 'fixture-tool.conf' }];
    }), '--yes']);
    check('idrive7-apps installer: a gate of the same unit names is not refused: it writes over theirs, their gate files go',
        g.status === 0 && !fs.readFileSync(gate.p('etc/systemd/system/mgu-inputgate-guard.service'), 'utf8').startsWith('# added by') &&
        fs.readFileSync(gate.p('etc/systemd/system/hmi.service.d/zz-mgu-inputgate.conf'), 'utf8') ===
            fs.readFileSync(path.join(FIXTURE_TOOL, 'fixture-tool.conf'), 'utf8') &&
        !fs.existsSync(gate.p('var/opt/mgu-renderd/mgu-inputgate.so')) && !fs.existsSync(gate.p('var/opt/mgu-renderd/inputgate.strikes')) &&
        fs.existsSync(gate.p('var/opt/mgu-renderd/mgu-renderd')) && fs.existsSync(gate.p('etc/systemd/system/mgu-renderd.service')), g.out);

    // an app their installer put there: no keychain, its kit's marker, listed with two flags
    const apps = fakeRoot();
    write(apps.p(`var/opt/public/oap/oap_${MGR}/data/apps/their_app.json`), JSON.stringify({ userId: 13005,
        provisioningCache: { '-allowed': 'true', '-appStartType': 'manually', '-enabled': 'true', '-userLoginRequired': 'false',
            '-updateMechanism': 'PLATFORM' }, configStateQueueIndex: null, installationSource: 'PREINSTALLED' }), 0o660);
    write(apps.p('var/opt/public/oap/oap_13005/source/package.json'), JSON.stringify({ name: 'their_app', version: '1.0.0' }));
    write(apps.p('var/opt/public/oap/oap_13005/source/javascript/kit/app-spec.json'), '{}\n');
    write(apps.p('var/opt/public/oap/oap_13005/someipInterfaces/acl.json'), '{}\n');
    fs.appendFileSync(apps.p(`var/opt/public/oap/oap_${MGR}/security/uids.txt`), '13005=their_app\n');
    write(apps.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`),
        JSON.stringify({ their_app: { '-appStartType': 'manually', '-userLoginRequired': 'false' } }));
    const listed = apps.status().idrive7;
    check('idrive7-apps installer: status names the apps it installed', JSON.stringify(listed) ===
        JSON.stringify({ apps: [{ id: 'their_app', version: '1.0.0' }] }), JSON.stringify(listed));
    const up = apps.run(['install', '--artifact', appArtifact('their_app', '1.1.0', true), '--yes']);
    check('idrive7-apps installer: its app, which has no keychain, updates under its uid',
        up.status === 0 && readJson(apps.entry('their_app')).userId === 13005 &&
        readJson(apps.p('var/opt/public/oap/oap_13005/source/package.json')).version === '1.1.0' &&
        !fs.existsSync(apps.p('var/opt/public/oap/oap_13005/security/joynrKeyChain.json')), up.out);
    check('idrive7-apps installer: an app this tool updated is its own, no longer named', apps.status().idrive7.apps.length === 0,
        JSON.stringify(apps.status().idrive7));
    const gone = apps.run(['uninstall', 'their_app', '--yes']);
    check('idrive7-apps installer: its app uninstalls: registry entry, home and custom_apps.json entry go', gone.status === 0 &&
        !fs.existsSync(apps.entry('their_app')) && !fs.existsSync(apps.home(13005)) &&
        !('their_app' in readJson(apps.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`))), gone.out);

    // the same names without their mark stay another manager's
    const plain = fakeRoot({ recmgr: ['fixture-tool'] });
    write(plain.p('etc/systemd/system/mgu-inputgate-guard.service'), '[Service]\nType=oneshot\n');
    const pl = plain.run(['install', '--artifact', toolArt('0.2.0', (c) => {
        c.mguProvides = 'gate';
        c.units.push({ name: 'mgu-inputgate-guard.service', from: 'systemd/fixture-tool.service' });
    }), '--yes']);
    check('idrive7-apps installer: a unit of that name without their mark is still refused', pl.status === 2 &&
        pl.out.includes('mgu-inputgate-guard.service is installed, but by no tool of ours'), pl.out);
}

function testProvides() {
    const opts = { recmgr: ['mgu-renderd', 'fixture-tool'], active: 'mgu-renderd.service' };
    const root = fakeRoot(opts);
    const ren = root.run(['install', '--artifact', serviceArtifact('renderer', '1.1.0'), '--yes']);
    const prov = providerArtifact('0.2.0');
    const r = root.run(['install', '--artifact', prov, '--yes']);
    const st = root.status();
    check('provides: a second renderer installs beside the first, nothing of the first changed; both provide renderer',
        ren.status === 0 && r.status === 0 && fs.existsSync(root.p('var/opt/mgu-renderd/current/mgu-renderd')) &&
        fs.existsSync(root.p('etc/systemd/system/mgu-renderd.service')) &&
        !root.systemctlCalls().some((c) => /^(stop|restart) mgu-renderd/.test(c)) &&
        st.components.filter((c) => c.provides === 'renderer').map((c) => c.id).sort().join() === 'fixture-tool,mgu-renderd',
        `${r.out}\n${JSON.stringify(st.components)}`);
    const two = fakeRoot().run(['install', '--artifact', serviceArtifact('renderer', '1.1.0'), '--artifact', prov, '--yes']);
    check('provides: two providers install in one call', two.status === 0, two.out);
    const un = root.run(['uninstall', 'fixture-tool', '--yes']);
    check('provides: uninstalling one leaves the other', un.status === 0 &&
        root.status().components.filter((c) => c.provides === 'renderer').map((c) => c.id).join() === 'mgu-renderd', un.out);
}

/* postInstall (mgu-render's page template): the tool's script runs from current/ after each
 * install; what it does never undoes the install */
function testPostInstall() {
    const root = fakeRoot({ recmgr: ['fixture-tool'] });
    const art = (version, exit, cmd) => {
        const dir = fixtureCopy(version, (c) => {
            c.files.push({ path: 'post.sh', from: 'post.sh', mode: '0644' });
            c.postInstall = cmd || ['post.sh', 'one arg', '--two'];
        });
        fs.writeFileSync(path.join(dir, 'post.sh'), `printf '%s|%s|%s|%s\\n' "$PWD" "$0" "$1" "$2" >> "$(dirname "$(dirname "$0")")/post.log"; echo said ${version}; exit ${exit}\n`);
        const out = fs.mkdtempSync(path.join(T, 'art-'));
        const r = hu(['artifact', dir, '--out', out]);
        if (r.status !== 0) {
            throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
        }
        return path.join(out, `fixture-tool@${version}.tgz`);
    };
    const log = () => (fs.existsSync(root.p('var/opt/fixture-tool/post.log')) ? fs.readFileSync(root.p('var/opt/fixture-tool/post.log'), 'utf8') : '')
        .split('\n').filter(Boolean);
    const a = art('0.2.0', 0);
    const r = root.run(['install', '--artifact', a, '--yes']);
    const cur = root.p('var/opt/fixture-tool/current');
    check('postInstall: kept by deploy/hu artifact; its script runs from current/ with its arguments, its output shown', r.status === 0 &&
        readJson(root.p('var/opt/fixture-tool/current/component.json')).postInstall.join() === 'post.sh,one arg,--two' &&
        log().join() === `${fs.realpathSync(cur)}|${cur}/post.sh|one arg|--two` && r.out.includes('  said 0.2.0'), `${r.out}\n${log()}`);
    const again = root.run(['install', '--artifact', a, '--yes']);
    check('postInstall: runs at every install, the same version again too', again.status === 0 && log().length === 2, again.out);
    const bad = root.run(['install', '--artifact', art('0.3.0', 3), '--yes']);
    check('postInstall: a script that fails leaves the install in place, with a warning', bad.status === 0 &&
        fs.readlinkSync(cur) === 'versions/0.3.0' && log().length === 3 && bad.out.includes('warning: fixture-tool: post.sh exited 3'), bad.out);
    const refused = root.run(['install', '--artifact', art('0.4.0', 0, ['nope.sh']), '--yes']);
    check('postInstall: a script that is not one of its files is refused', refused.status !== 0 &&
        refused.out.includes('postInstall is a list: one of its files, then its arguments') && fs.readlinkSync(cur) === 'versions/0.3.0' &&
        log().length === 3, refused.out);
}

/* keepRunning (mgu-render, a renderer package): an update leaves the running service running */
function testKeepRunning() {
    const root = fakeRoot({ recmgr: ['fixture-tool'] });
    const art = (version, socketLine) => {
        const dir = fixtureCopy(version, (c) => { c.keepRunning = true; });
        if (socketLine) {
            fs.appendFileSync(path.join(dir, 'systemd', 'fixture-tool.socket'), `# ${socketLine}\n`);
        }
        const out = fs.mkdtempSync(path.join(T, 'art-'));
        const r = hu(['artifact', dir, '--out', out]);
        if (r.status !== 0) {
            throw new Error(`deploy/hu artifact failed: ${r.stderr}`);
        }
        return path.join(out, `fixture-tool@${version}.tgz`);
    };
    const fresh = root.run(['install', '--artifact', art('0.2.0'), '--yes']);
    check('keepRunning: kept by deploy/hu artifact; a fresh install starts the socket', fresh.status === 0 &&
        readJson(root.p('var/opt/fixture-tool/current/component.json')).keepRunning === true &&
        root.systemctlCalls().includes('start fixture-tool.socket'), fresh.out);
    fs.writeFileSync(root.unitFile('fixture-tool.service.active'), 'active\n');
    let n = root.systemctlCalls().length;
    const up = root.run(['install', '--artifact', art('0.3.0', 'changed'), '--yes']);
    let calls = root.systemctlCalls().slice(n);
    check('keepRunning: an update leaves the running service and its changed socket as they are, pending the next start',
        up.status === 0 && fs.readlinkSync(root.p('var/opt/fixture-tool/current')) === 'versions/0.3.0' &&
        !calls.some((c) => /^(stop|restart|start) fixture-tool/.test(c)) &&
        root.status().pending_reboot.some((p) => p.id === 'fixture-tool' && p.reason === 'the new version runs from its next start') &&
        up.out.includes('fixture-tool.service keeps running the version it started with'), `${up.out}\n${calls.join('; ')}`);
    fs.writeFileSync(root.unitFile('fixture-tool.service.active'), 'inactive\n');
    n = root.systemctlCalls().length;
    const idle = root.run(['install', '--artifact', art('0.4.0', 'changed again'), '--yes']);
    calls = root.systemctlCalls().slice(n);
    check('keepRunning: with the service stopped, a changed socket restarts at once; the service is left to it',
        idle.status === 0 && calls.includes('restart fixture-tool.socket') && !calls.some((c) => /fixture-tool\.service$/.test(c) && /^(start|restart|stop)/.test(c)),
        `${idle.out}\n${calls.join('; ')}`);

    const back = fakeRoot({ recmgr: ['fixture-tool'] });
    back.run(['install', '--artifact', toolArtifact('0.2.0'), '--yes']);
    back.run(['install', '--artifact', art('0.3.0'), '--yes']);
    fs.writeFileSync(back.unitFile('fixture-tool.service.active'), 'active\n');
    n = back.systemctlCalls().length;
    const rb = back.run(['rollback', 'fixture-tool', '--yes']);
    calls = back.systemctlCalls().slice(n);
    check('keepRunning: a rollback to a version without it leaves the running service running too', rb.status === 0 &&
        fs.readlinkSync(back.p('var/opt/fixture-tool/current')) === 'versions/0.2.0' && !calls.some((c) => /^(stop|restart) fixture-tool/.test(c)),
        `${rb.out}\n${calls.join('; ')}`);

    const svc = fakeRoot({ recmgr: ['mgu-renderd'], active: 'mgu-renderd.service' });
    svc.run(['install', '--artifact', serviceArtifact('renderer', '1.1.0'), '--yes']);
    n = svc.systemctlCalls().length;
    const sup = svc.run(['install', '--artifact', serviceArtifact('renderer', '1.1.2'), '--yes']);
    calls = svc.systemctlCalls().slice(n);
    check('keepRunning: a running renderer package is not restarted by its update, as his App Manager does', sup.status === 0 &&
        fs.readlinkSync(svc.p('var/opt/mgu-renderd/current')) === 'versions/1.1.2' && !calls.some((c) => /^(stop|restart) mgu-renderd/.test(c)) &&
        svc.status().pending_reboot.some((p) => p.id === 'mgu-renderd' && p.reason === 'the new version runs from its next start'),
        `${sup.out}\n${calls.join('; ')}`);
    const bad = root.run(['install', '--artifact', (() => {
        const dir = fixtureCopy('0.5.0', (c) => { c.keepRunning = 'yes'; });
        const out = fs.mkdtempSync(path.join(T, 'art-'));
        hu(['artifact', dir, '--out', out]);
        return path.join(out, 'fixture-tool@0.5.0.tgz');
    })(), '--yes']);
    check('keepRunning: anything but true or false is refused', bad.status === 2 && bad.out.includes('keepRunning is true or false'), bad.out);
}

const ACL = { masterAccessTable: [], masterRegistrationTable: [] };

/* ---- iDrive 8: app changes in place ---------------------------------------------------- */

const ID8_COPY = 'var/opt/mgu-deploy/main.js';
const id8Das = (root) => [0, 1, 2, 3, 4, 5].map((i) => fs.readFileSync(root.p(`usr/share/tm/prov/das_00${i}.xml`), 'utf8'));
const id8Custom = (root) => readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
const dasLine = (id) => `<app supportedECUs="HU" initialPreferPreinstalled="true">${id}</app>`;
/* A fake iDrive 8 whose first app install turned the fallback on (that
 * install queued), and MainApp-21 started on the copy: fake_inplace.js with
 * its guard counting earlier loads as up a minute. */
function id8LiveRoot(mode, env) {
    const root = id8Root();
    const first = root.run(['install', '--artifact', rhmiApp('first8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    if (first.status !== 0) throw new Error(`first install failed: ${first.out}`);
    const mgr = startInplace(root, mode, env);
    return { root, first, mgr };
}

function testId8Inplace() {
    const { root, first, mgr } = id8LiveRoot();
    const copy = fs.existsSync(root.p(ID8_COPY)) ? fs.readFileSync(root.p(ID8_COPY), 'utf8') : '';
    check('id8 in place: the first install turns the fallback on and is queued, MainApp-21 not restarted', first.status === 0 &&
        first.out.includes('provisioning fallback turned on') && first.out.includes('is not installed in place') &&
        first.out.includes('first8 1.0.0 installs at the next start') && root.kills().length === 0 &&
        fs.existsSync(root.p('var/opt/mgu-deploy/id8/queue/first8@1.0.0.tgz')), first.out);
    check('id8 boot unit: it builds the copy after the queued changes are applied (their check for MainApp-21 must not see the build)',
        /^After=mgu-deploy-apply\.service$/m.test(fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-app-fallback-id8.service'), 'utf8')));
    check('id8 in place: the boot unit is iDrive 8\'s, the copy has MainApp-21\'s fallback, guard and hook',
        fs.readFileSync(root.p('etc/systemd/system/mgu-app-fallback.service'), 'utf8') ===
        fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-app-fallback-id8.service'), 'utf8') &&
        copy.includes('__mguDeployGuard') && copy.split('/* mgu-deploy in-place install */').length === 3 &&
        copy.includes('requestSource:"PREINSTALLED"') && !copy.includes('__mguDeployFallbackApps'));
    const dasBefore = id8Das(root);
    const art = rhmiApp('live8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true });
    const r = root.run(['install', '--artifact', art, '--yes']);
    check('id8 in place: an install is MainApp-21\'s own, now: registered, no restart, nothing queued for it', r.status === 0 &&
        r.out.includes(`installed in place by the app manager (pid ${mgr.pid})`) && root.kills().length === 0 &&
        root.managerLog().includes('install live8 1.0.0 uid 13001 in place') && !r.out.includes('next start') &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/id8/queue/live8@1.0.0.tgz')) &&
        !root.status().pending_reboot.some((p) => p.id === 'live8'), `${r.out}\n${root.managerLog().join('\n')}`);
    check('id8 in place: its package, das lines and custom_apps.json entry are there for every later start',
        fs.existsSync(root.pre21('live8', '1.0.0')) && id8Das(root).every((t) => t.includes(dasLine('live8'))) &&
        id8Custom(root).live8['-appStartType'] === 'autostart' && id8Custom(root).live8['-enabled'] === 'true');
    check('id8 in place: the queued first install stays queued', fs.existsSync(root.p('var/opt/mgu-deploy/id8/queue/first8@1.0.0.tgz')));
    const up = root.run(['install', '--artifact', rhmiApp('live8', '1.1.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    check('id8 in place: an update is MainApp-21\'s own, uid kept, the older package gone', up.status === 0 &&
        up.out.includes('updated in place') && root.kills().length === 0 && readJson(root.entry('live8')).userId === 13001 &&
        root.managerLog().includes('update live8 1.1.0 uid 13001 in place') &&
        fs.existsSync(root.pre21('live8', '1.1.0')) && !fs.existsSync(root.pre21('live8', '1.0.0')), up.out);
    // the update of live8 applied at this start, waiting for MainApp-21
    const pend = readJson(root.p('var/opt/mgu-deploy/id8/pending.json'));
    write(root.p('var/opt/mgu-deploy/id8/pending.json'), JSON.stringify(Object.assign({}, pend, { unconfirmed: [{ id: 'live8', version: '1.1.0', previous: '1.0.0', uid: 13001,
        line: '13001=live8', bin: root.p('var/opt/mgu-deploy/id8/trash/x'), moved: [] }] })));
    const un = root.run(['uninstall', 'live8', '--yes']);
    check('id8 in place: an uninstall drops the record of the app\'s update waiting for MainApp-21, so it does not come back',
        readJson(root.p('var/opt/mgu-deploy/id8/pending.json')).unconfirmed === undefined && readJson(root.p('var/opt/mgu-deploy/id8/pending.json')).changes.length === pend.changes.length);
    check('id8 in place: an uninstall is MainApp-21\'s own; package, das lines and listing go, nothing queued, the id kept from the backend', un.status === 0 &&
        un.out.includes('live8 uninstalled in place') && root.kills().length === 0 && !fs.existsSync(root.entry('live8')) &&
        !fs.existsSync(root.pre21('live8', '1.1.0')) && JSON.stringify(id8Das(root)) === JSON.stringify(dasBefore) &&
        !('live8' in id8Custom(root)) && !root.status().pending_reboot.some((p) => p.id === 'live8') &&
        (readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/local-only-apps.json`)) || []).indexOf('live8') >= 0, un.out);
    check('id8 in place: MainApp-21 kept running throughout', root.managerPid() === mgr.pid && mgr.exitCode === null);

    // not taken: queued as without the hook, with what was placed put back
    [['a refused install', 'refuse', {}, 'refused the in-place install'],
        ['a request not taken', 'deaf', { MGU_DEPLOY_INPLACE_ACK_MS: '500' }, 'did not take the request']].forEach(([what, mode, extra, why]) => {
        const c = id8LiveRoot(mode, extra);
        const before = id8Das(c.root);
        const q = c.root.run(['install', '--artifact', rhmiApp('live8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes'], extra);
        check(`id8 in place: ${what} is queued for the next start, what was placed put back, no restart`, q.status === 0 &&
            q.out.includes(why) && q.out.includes('live8 1.0.0 installs at the next start') && c.root.kills().length === 0 &&
            !fs.existsSync(c.root.pre21('live8', '1.0.0')) && JSON.stringify(id8Das(c.root)) === JSON.stringify(before) &&
            !('live8' in id8Custom(c.root)) && fs.existsSync(c.root.p('var/opt/mgu-deploy/id8/queue/live8@1.0.0.tgz')), q.out);
    });

    // an update not taken: the installed version's package and listing back
    const u = id8LiveRoot('deaf', { MGU_DEPLOY_INPLACE_ACK_MS: '500' });
    u.root.run(['install', '--artifact', rhmiApp('live8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    write(u.root.pre21('live8', '1.0.0'), fs.readFileSync(rhmiApp('live8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true })));
    write(u.root.entry('live8'), JSON.stringify({ userId: 13006, installationSource: 'PREINSTALLED' }));
    write(u.root.p('var/opt/public/oap/oap_13006/source/package.json'), JSON.stringify({ name: 'live8', version: '1.0.0' }));
    write(u.root.p('var/opt/public/oap/oap_13006/security/joynrKeyChain.json'), '{}');
    const preBefore = fs.readFileSync(u.root.pre21('live8', '1.0.0'));
    const ur = u.root.run(['install', '--artifact', rhmiApp('live8', '1.1.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes'],
        { MGU_DEPLOY_INPLACE_ACK_MS: '500' });
    check('id8 in place: an update not taken is queued, the installed version\'s package put back', ur.status === 0 &&
        ur.out.includes('live8 1.1.0 installs at the next start') && fs.existsSync(u.root.pre21('live8', '1.0.0')) &&
        fs.readFileSync(u.root.pre21('live8', '1.0.0')).equals(preBefore) && !fs.existsSync(u.root.pre21('live8', '1.1.0')), ur.out);

    // a MainApp-21 the copy does not fit: queued, not refused, no copy bound
    const nf = id8Root({ main: fs.readFileSync(path.join(HERE, 'fixtures', 'main21.js'), 'utf8').replace('Promise.all([mainApp.init()])', 'Promise.all([mainApp.init(1)])') });
    const nr = nf.run(['install', '--artifact', rhmiApp('live8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    check('id8 in place: on a MainApp-21 the copy does not fit, an install is queued as before, no fallback turned on', nr.status === 0 &&
        nr.out.includes('is not installed in place: fallback build refused') && nr.out.includes('live8 1.0.0 installs at the next start') &&
        !fs.existsSync(nf.p(ID8_COPY)) && !fs.existsSync(nf.p('etc/systemd/system/mgu-app-fallback.service')), nr.out);

    // MainApp-21's installer failed it: fails, rolled back, no restart
    const f = id8LiveRoot('fail', { FAKE_INPLACE_REASON: 'APP_INSTALLATION_FAILED' });
    const fb = id8Das(f.root);
    const fr = f.root.run(['install', '--artifact', rhmiApp('live8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    check('id8 in place: an install MainApp-21\'s installer failed fails with its reason, rolled back, not queued, no restart',
        fr.status === 1 && fr.out.includes('MainApp-21 could not install live8 1.0.0: APP_INSTALLATION_FAILED') &&
        f.root.kills().length === 0 && !fs.existsSync(f.root.pre21('live8', '1.0.0')) &&
        JSON.stringify(id8Das(f.root)) === JSON.stringify(fb) && !('live8' in id8Custom(f.root)) &&
        !fs.existsSync(f.root.p('var/opt/mgu-deploy/id8/queue/live8@1.0.0.tgz')), fr.out);

    // an uninstall the hook does not take is queued
    const d = id8LiveRoot('fail', { FAKE_INPLACE_REASON: 'APP_NOT_INSTALLED' });
    write(d.root.entry('first8'), JSON.stringify({ userId: 13005, installationSource: 'PREINSTALLED' }));
    write(d.root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`), JSON.stringify({ first8: {} }));
    write(d.root.p('var/opt/public/oap/oap_13005/source/package.json'), JSON.stringify({ name: 'first8', version: '1.0.0' }));
    const du = d.root.run(['uninstall', 'first8', '--yes']);
    check('id8 in place: an uninstall MainApp-21 failed is queued for the next start', du.status === 0 &&
        du.out.includes('first8 is not uninstalled in place') && du.out.includes('first8 is removed at the next start') &&
        d.root.kills().length === 0 && !('first8' in id8Custom(d.root)), du.out);

    // the guard turned the hook off for this boot: queued, saying why
    const g = id8Root();
    g.run(['install', '--artifact', rhmiApp('first8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    write(g.p(`var/opt/public/oap/oap_${MGR}/data/mgu-deploy-guard.json`), JSON.stringify({ boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
        loads: 1, ready: 0 }));
    startInplace(g);
    const gr = g.run(['install', '--artifact', rhmiApp('live8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    check('id8 in place: with the hook off after a restart within a minute of a start, the install is queued, saying why', gr.status === 0 &&
        gr.out.includes('its in-place hook is off until the next start: MainApp-21 restarted within a minute of its start') &&
        gr.out.includes('live8 1.0.0 installs at the next start') && g.kills().length === 0, gr.out);

    // at boot the queue applies while the copy is built: that build is not MainApp-21
    const ap = id8Root();
    ap.run(['install', '--artifact', rhmiApp('first8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    ap.noManager();
    const build = '  474 root      217m S    /bin/sh -c /usr/bin/node /var/opt/mgu-deploy/current/fallback_build.js ' +
        '/usr/lib/oap-mainapp21/src/main.js /var/opt/mgu-deploy/main.js\n  475 root      217m S    /usr/bin/node ' +
        '/var/opt/mgu-deploy/current/fallback_build.js /usr/lib/oap-mainapp21/src/main.js /var/opt/mgu-deploy/main.js';
    const apr = ap.run(['apply-pending'], { FAKE_PS_EXTRA: build });
    check('id8: apply-pending runs while the copy of MainApp-21\'s main.js is being built', apr.status === 0 &&
        fs.existsSync(ap.pre21('first8', '1.0.0')), apr.out);
    const mgrLine = '  476 12201    1875m S    /usr/bin/node -r /usr/local/libexec/x.js --expose-gc /usr/lib/oap-mainapp21/src/main.js';
    write(ap.p('var/opt/mgu-deploy/id8/pending.json'), JSON.stringify({ changes: [{ action: 'remove', id: 'zz' }] }));
    const busy = ap.run(['apply-pending'], { FAKE_PS_EXTRA: mgrLine });
    check('id8: apply-pending is refused while node runs MainApp-21\'s main.js after its options', busy.status === 2 &&
        busy.out.includes('the app manager is running'), busy.out);

    // the boot unit: its paths in a fake root, mount logged
    const boot = id8Root();
    boot.run(['install', '--artifact', rhmiApp('first8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    const mounts = boot.p('mounts.log');
    const command = fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-app-fallback-id8.service'), 'utf8')
        .match(/^ExecStart=\/bin\/sh -c '(.*)'$/m)[1]
        .split('/usr/bin/node').join(UNIT_NODE).split('/var/opt/').join(boot.p('var/opt/'))
        .split('/usr/lib/').join(boot.p('usr/lib/'));
    const bootRun = () => cp.spawnSync('sh', ['-c', `mount() { echo "$*" >> '${mounts}'; }; ${command}`], { encoding: 'utf8' });
    let b = bootRun();
    check('id8 boot unit: the copy is built and bound over MainApp-21\'s main.js', b.status === 0 &&
        fs.readFileSync(mounts, 'utf8').trim() === `--bind ${boot.p(ID8_COPY)} ${boot.p('usr/lib/oap-mainapp21/src/main.js')}`, `${b.stdout}${b.stderr}`);
    const stock = fs.readFileSync(boot.p('usr/lib/oap-mainapp21/src/main.js'), 'utf8');
    [['a missing hook anchor', stock.replace('Promise.all([mainApp.init()])', 'Promise.all([mainApp.init(1)])')],
        ['a duplicated provisioning anchor', `${stock}\n(function(){this.isMainapp&&section===this.mainappSection&&(newProvisioning.x=1)})`],
        ['iDrive 7\'s anchors as well', `${stock}\nisMainapp&&section===mainAppSection&&(newProvisioning.x=1)`]].forEach(([what, text]) => {
        fs.writeFileSync(boot.p('usr/lib/oap-mainapp21/src/main.js'), text);
        fs.rmSync(mounts, { force: true });
        b = bootRun();
        check(`id8 boot unit: with ${what} nothing is bound, the unit succeeds`, b.status === 0 && !fs.existsSync(mounts) &&
            b.stderr.includes('refusing to build'), `${b.stdout}${b.stderr}`);
    });
}

/* After a deploy tool update the updater's status check turns live app
 * changes on: the boot unit only, the copy bound at the next start. */
function testId8LiveOn() {
    const live = (root) => { const r = root.run(['status', '--json']); try { return JSON.parse(r.stdout).live_installs; } catch (e) { return r.out; } };
    const root = id8Root();
    const unit = root.p('etc/systemd/system/mgu-app-fallback.service');
    const l1 = live(root);
    check('id8 live on: status turns live changes on from the next start: the boot unit installed and enabled, the copy built, no restart',
        l1 && l1.state === 'changed' && fs.readFileSync(unit, 'utf8') ===
        fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-app-fallback-id8.service'), 'utf8') &&
        fs.readlinkSync(root.p('etc/systemd/system/multi-user.target.wants/mgu-app-fallback.service')) === '../mgu-app-fallback.service' &&
        fs.readFileSync(root.p(ID8_COPY), 'utf8').includes('__mguDeployGuard') && root.kills().length === 0, JSON.stringify(l1));
    const st = root.status();
    check('id8 live on: nothing pending for it, and the next status says it is on', st.pending_reboot.length === 0 &&
        JSON.stringify(st.live_installs) === JSON.stringify({ state: 'ok', reason: 'on' }), JSON.stringify(st));
    const r = root.run(['install', '--artifact', rhmiApp('first8', '1.0.0', ['ID8'], { npm: true, acl: ACL, marked: true }), '--yes']);
    check('id8 live on: until the next start an install is queued, as without it', r.status === 0 &&
        r.out.includes('first8 1.0.0 installs at the next start') && !r.out.includes('provisioning fallback turned on') &&
        root.kills().length === 0, r.out);

    const off = root.run(['fallback', 'off', '--yes']);
    const l2 = live(root);
    check('id8 live on: once turned off, status leaves it off', off.status === 0 && l2 && l2.state === 'ok' &&
        l2.reason === 'turned off since it was turned on' && !fs.existsSync(unit), JSON.stringify(l2));

    // recmgr, where the unit has the list
    const rm = id8Root();
    write(rm.p('etc/recmgr-restartlist.conf'), '[Whitelist]\nstockd\n\n[WhitelistExitSuccess]\nstockd\n\n[ForceRestartList]\ndbus\n');
    live(rm);
    check('id8 live on: where the unit has a recmgr list, the boot unit is listed in it',
        /\[Whitelist\][^[]*mgu-app-fallback/.test(fs.readFileSync(rm.p('etc/recmgr-restartlist.conf'), 'utf8')));

    const nf = id8Root({ main: fs.readFileSync(path.join(HERE, 'fixtures', 'main21.js'), 'utf8').replace('Promise.all([mainApp.init()])', 'Promise.all([mainApp.init(1)])') });
    const n1 = live(nf);
    check('id8 live on: on a MainApp-21 the copy does not fit it stays off, saying why, nothing written but its record',
        n1 && n1.state === 'ok' && /^off: fallback build refused/.test(n1.reason) &&
        !fs.existsSync(nf.p('etc/systemd/system/mgu-app-fallback.service')) && fs.existsSync(nf.p('var/opt/mgu-deploy/id8-live.json')), JSON.stringify(n1));
    const rec = fs.statSync(nf.p('var/opt/mgu-deploy/id8-live.json')).mtimeMs;
    const n2 = live(nf);
    check('id8 live on: that MainApp-21 is not built again at the next status', n2 && n2.state === 'ok' &&
        fs.statSync(nf.p('var/opt/mgu-deploy/id8-live.json')).mtimeMs === rec, JSON.stringify(n2));
    const r0 = readJson(nf.p('var/opt/mgu-deploy/id8-live.json'));
    write(nf.p('var/opt/mgu-deploy/id8-live.json'), JSON.stringify({ key: r0.key.replace(VERSION, '0.0.1'), why: r0.why }));
    write(nf.p('usr/lib/oap-mainapp21/src/main.js'), fs.readFileSync(path.join(HERE, 'fixtures', 'main21.js'), 'utf8'));
    const n3 = live(nf);
    check('id8 live on: a record from another deploy tool version is tried again', n3 && n3.state === 'changed', JSON.stringify(n3));

    const busy = id8Root();
    fs.writeFileSync(busy.p('proc/mounts'), 'rootfs / ext4 rw,relatime 0 0\n');
    const b1 = live(busy);
    check('id8 live on: with / read-write it waits for a later status', b1 && b1.state === 'pending' &&
        !fs.existsSync(busy.p('etc/systemd/system/mgu-app-fallback.service')), JSON.stringify(b1));
    check('id8 live on: not on iDrive 7', !('live_installs' in fakeRoot().status()));
}

/* iDrive 8 under backend provisioning: every app of ours the das files
 * list keeps its custom_apps.json entry (the fallback's flags for an app
 * the provisioning has no section for), put back by apply-pending, an
 * install, status and the boot unit's relist; the tile shows only where a
 * section reaches MainApp-21. */
function testId8Listing() {
    const root = id8Root();
    const custom = () => readJsonOrNull(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`)) || {};
    const art = rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true, acl: ACL, appletId: 20097 });
    root.run(['install', '--artifact', art, '--yes']);
    root.noManager();
    const a = root.run(['apply-pending']);
    check('id8 listing: a queued install applied at boot is listed with its das line\'s flags', a.status === 0 &&
        a.out.includes('listed for the provisioning fallback: oap-cardash') &&
        JSON.stringify(custom()['oap-cardash']) === JSON.stringify({ '-enabled': 'true', '-allowed': 'true', '-appStartType': 'autostart',
            '-userLoginRequired': 'false', '-updateMechanism': 'PLATFORM' }), a.out);
    // MainApp-21 installs it at its start
    fs.writeFileSync(`${root.R}.mgr.pid`, '4000');
    write(root.entry('oap-cardash'), JSON.stringify({ userId: 13001, installationSource: 'PREINSTALLED',
        provisioningCache: { '-enabled': 'true', '-allowed': 'true', '-appStartType': 'autostart' } }));
    write(root.p('var/opt/public/oap/oap_13001/source/package.json'), JSON.stringify({ name: 'oap-cardash', version: '1.1.4' }));
    let st = root.status();
    let c = st.components.find((x) => x.id === 'oap-cardash');
    check('id8 listing: with the das files served its tile is provisioned', c.tile_provisioned && c.tile_visible &&
        st.listing.state === 'ok' && JSON.stringify(st.fallback.listed_by_manager) === '[]', JSON.stringify(c));
    // the backend's provisioning arrives, without our app
    const signed = root.p('var/opt/public/tm/tm_12000/data/prov/ProvSigned.xml');
    write(signed, '<bmwprovsigned><bmwprov><set><data><x_call enabled="true" allowed="true"/><main_app/></data></set></bmwprov></bmwprovsigned>\n');
    c = root.status().components.find((x) => x.id === 'oap-cardash');
    check('id8 listing: under backend provisioning without its section the tile is hidden until the running MainApp-21 fills it',
        !c.tile_visible && !c.tile_provisioned && !c.tile_fallback, JSON.stringify(c));
    const record = root.p(`var/opt/public/oap/oap_${MGR}/data/mgu-deploy-listed.json`);
    write(record, JSON.stringify({ pid: 4000, apps: ['oap-cardash'] }));
    c = root.status().components.find((x) => x.id === 'oap-cardash');
    check('id8 listing: a section the running MainApp-21 filled shows the tile via the fallback',
        c.tile_visible && c.tile_fallback && !c.tile_provisioned, JSON.stringify(c));
    write(record, JSON.stringify({ pid: 3999, apps: ['oap-cardash'] }));
    c = root.status().components.find((x) => x.id === 'oap-cardash');
    check('id8 listing: a record of another MainApp-21 counts for nothing', !c.tile_visible, JSON.stringify(c));
    write(signed, '<bmwprov><oap-cardash enabled="true" allowed="true"/></bmwprov>\n');
    c = root.status().components.find((x) => x.id === 'oap-cardash');
    check('id8 listing: a section of its own in the backend\'s provisioning is provisioned', c.tile_provisioned && c.tile_visible, JSON.stringify(c));
    fs.unlinkSync(signed);
    // the entry lost
    fs.unlinkSync(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`));
    const sr = root.run(['status', '--json']);
    st = JSON.parse(sr.stdout);
    check('id8 listing: status puts a lost entry back, from the next start', st.listing.state === 'changed' &&
        st.listing.reason === 'listed oap-cardash' && custom()['oap-cardash']['-appStartType'] === 'autostart' &&
        sr.stderr.includes('listed for the provisioning fallback, from the next start: oap-cardash'), sr.out);
    check('id8 listing: and the next status has nothing to do', root.status().listing.state === 'ok');
    fs.unlinkSync(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`));
    const rl = root.run(['relist']);
    check('id8 listing: relist (the boot unit) puts it back', rl.status === 0 && rl.out.includes('listed for the provisioning fallback: oap-cardash') &&
        !!custom()['oap-cardash'], rl.out);
    check('id8 listing: relist again lists nothing', root.run(['relist']).out.includes('every app of ours is listed'));
    fs.unlinkSync(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`));
    const again = root.run(['install', '--artifact', art, '--yes']);
    check('id8 listing: an install with the app current puts it back', again.status === 0 &&
        again.out.includes('already installed; nothing to change') &&
        again.out.includes('listed for the provisioning fallback, from the next start of the head unit: oap-cardash') && !!custom()['oap-cardash'], again.out);
    const unit = fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-app-fallback-id8.service'), 'utf8');
    check('id8 listing: the fallback\'s boot unit relists before it builds the copy',
        /\nExecStartPre=-\/bin\/sh \/var\/opt\/mgu-deploy\/mgu-deploy\.sh relist\n/.test(unit));
    const unitPath = root.p('etc/systemd/system/mgu-app-fallback.service');
    write(unitPath, '[Unit]\nDescription=an older boot unit\n');
    const ur = root.status();
    check('id8 listing: status brings an older fallback boot unit up to date, and only the unit file',
        fs.readFileSync(unitPath, 'utf8') === unit && ur.listing.reason === 'boot unit brought up to date' && !root.kills().length &&
        root.status().listing.state === 'ok', JSON.stringify(ur.listing));
    fs.unlinkSync(unitPath);
    // a queued removal is not listed again
    root.run(['uninstall', 'oap-cardash', '--yes']);
    const rs = root.status();
    check('id8 listing: an app with a queued removal is not listed again', !custom()['oap-cardash'] &&
        rs.pending_reboot.some((x) => x.id === 'oap-cardash' && x.reason === 'removed at the next start') && rs.listing.state === 'ok', JSON.stringify(rs.listing));
    root.noManager();
    root.run(['apply-pending']);
    check('id8 listing: once removed it stays out', !custom()['oap-cardash'] && root.status().listing.state === 'ok');
    const seven = fakeRoot().run(['relist']);
    check('id8 listing: relist does nothing on iDrive 7', seven.status === 0 && seven.out.includes('not iDrive 8'), seven.out);
}

/* iDrive 8 under backend provisioning: an app placed at the start that
 * MainApp-21 did not install (its provisioning does not list it) is a lost
 * app, for the updater to install in place once the hook is up. */
function testId8Unprovisioned() {
    const root = id8Root();
    const art = rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true, acl: ACL, appletId: 20097 });
    root.run(['install', '--artifact', art, '--yes']);
    root.noManager();
    root.run(['apply-pending']);
    const placed = root.p('usr/lib/oap-mainapp21/preinstalled_apps/oap-cardash@1.1.4.tgz');
    const hookFile = root.p(`var/opt/public/oap/oap_${MGR}/data/mgu-deploy-inplace.json`);
    const signed = root.p('var/opt/public/tm/tm_12000/data/prov/ProvSigned.xml');
    const lost = () => JSON.stringify(root.status().lost_apps);
    const start = Math.floor(Date.now() / 1000) + 1;
    const hook = (o) => write(hookFile, JSON.stringify(Object.assign({ pid: 4000, start: start * 1000, at: start * 1000, state: 'ready' }, o)));
    fs.writeFileSync(`${root.R}.mgr.pid`, '4000');
    root.setManagerStart(start);
    hook();
    check('id8 unprovisioned: with the das files served MainApp-21 installs it; not lost', fs.existsSync(placed) && lost() === '[]', lost());
    write(signed, '<bmwprovsigned><bmwprov><set><data><x_call enabled="true" allowed="true"/><main_app/></data></set></bmwprov></bmwprovsigned>\n');
    check('id8 unprovisioned: under backend provisioning without it, lost with its placed package',
        lost() === JSON.stringify([{ id: 'oap-cardash', version: '1.1.4', package: placed }]), lost());
    hook({ pid: 3999 });
    check('id8 unprovisioned: not while the running manager has not announced its hook', lost() === '[]', lost());
    hook({ start: (start - 60) * 1000 });
    check('id8 unprovisioned: not on a hook announced by an earlier manager of that pid', lost() === '[]', lost());
    hook({ state: 'off', why: 'x' });
    check('id8 unprovisioned: not while the hook is off', lost() === '[]', lost());
    hook({ state: 'done' });
    write(signed, '<bmwprov><oap-cardash enabled="true" allowed="true"/></bmwprov>\n');
    check('id8 unprovisioned: not when the backend\'s provisioning names it', lost() === '[]', lost());
    write(signed, '<bmwprov><x_call/></bmwprov>\n');
    const pending = root.p('var/opt/mgu-deploy/id8/pending.json');
    write(pending, JSON.stringify({ changes: [], unconfirmed: [{ id: 'oap-cardash', version: '1.1.4', previous: '1.1.3' }] }));
    check('id8 unprovisioned: not an update applied at the start, which goes back at the next one', lost() === '[]', lost());
    fs.unlinkSync(pending);
    const am = root.p('usr/lib/oap-mainapp21/preinstalled_apps/oap-appmanager@1.0.0.tgz');
    fs.copyFileSync(placed, am);
    [0, 1, 2, 3, 4, 5].forEach((i) => {
        const f = root.p(`usr/share/tm/prov/das_00${i}.xml`);
        fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('        </installable_apps>',
            `            ${dasLine('oap-appmanager')}\n        </installable_apps>`)
            .replace(/(<x_call [^\n]*\n)/, '$1        <oap-appmanager enabled="true" allowed="true" appStartType="autostart" userLoginRequired="false"/>\n'));
    });
    check('id8 unprovisioned: never IterioDev\'s App Manager', lost() === JSON.stringify([{ id: 'oap-cardash', version: '1.1.4', package: placed }]), lost());
    write(root.entry('oap-cardash'), JSON.stringify({ userId: 13001, installationSource: 'PREINSTALLED' }));
    check('id8 unprovisioned: not once registered', lost() === '[]', lost());
    fs.unlinkSync(root.entry('oap-cardash'));
    root.run(['uninstall', 'oap-cardash', '--yes']);
    check('id8 unprovisioned: not with a removal queued', lost() === '[]', lost());
}

/* After a factory reset the app manager's home is gone until its first
 * start creates it: nothing of this tool creates it, no app counts as lost
 * and no app installs meanwhile. A home owned by root is given back to
 * the manager, and the manager started again. */
function testFactoryReset() {
    const art = appArtifact('fixture_app', '1.0.0', true);
    const root = fakeRoot();
    const ins = root.run(['install', '--artifact', art, '--yes']);
    if (ins.status !== 0) throw new Error(ins.out);
    const home = root.home(MGR);
    fs.rmSync(home, { recursive: true });
    const sr = root.run(['status', '--json']);
    check('factory reset: status reports no lost app and creates nothing while the app manager\'s home is missing',
        sr.status === 0 && JSON.parse(sr.stdout).lost_apps.length === 0 && !fs.existsSync(home), sr.out);
    const again = root.run(['install', '--artifact', art, '--yes']);
    check('factory reset: an app install is refused and creates nothing', again.status === 2 &&
        again.out.includes('the app manager has not created its data folder yet') && !fs.existsSync(home), again.out);
    fs.mkdirSync(path.join(home, 'data', 'apps'), { recursive: true });
    const lost = root.status().lost_apps;
    check('factory reset: once the app manager has created its home the app counts as lost', lost.length === 1 && lost[0].id === 'fixture_app',
        JSON.stringify(lost));

    // a home made as root: the test's own uid stands for root
    const asRoot = { MGU_DEPLOY_FAKE_ROOT_UID: String(process.getuid()) };
    const broken = fakeRoot();
    const bh = broken.home(MGR);
    fs.chmodSync(bh, 0o755);
    fs.chmodSync(path.join(bh, 'data'), 0o755);
    const before = broken.hash();
    const ro = broken.run(['status', '--read-only'], asRoot);
    check('factory reset: status --read-only reports and leaves the root-owned home, the manager and every file as they are',
        ro.status === 0 && ro.stdout.includes('app stock_app') && mode(bh) === 0o755 && !broken.kills().length &&
        broken.hash().hash === before.hash, ro.out + treeDiff(before, broken.hash()));
    const rr = broken.run(['status', '--json'], asRoot);
    check('factory reset: status gives a root-owned home back with the manager\'s modes and restarts the manager that started before',
        rr.status === 0 && mode(bh) === 0o3770 && mode(path.join(bh, 'data')) === 0o750 && broken.kills().length === 1 &&
        rr.stderr.includes('and its data folder were owned by root: given back to uid 12201') &&
        !JSON.parse(rr.stdout).pending_reboot.length, rr.out);
    check('factory reset: the repair touches nothing inside the data folder', mode(broken.entry('stock_app')) === 0o660);
    const idle = fakeRoot({ noManager: true });
    fs.chmodSync(idle.home(MGR), 0o755);
    const ir = idle.run(['status', '--json'], asRoot);
    check('factory reset: with no app manager coming up the restart is pending', mode(idle.home(MGR)) === 0o3770 &&
        JSON.parse(ir.stdout).pending_reboot.some((x) => x.id === 'mgu-deploy' && /folders were repaired/.test(x.reason)), ir.out);
    check('factory reset: a home not owned by root is left as it is', (() => {
        const ok = fakeRoot();
        fs.chmodSync(ok.home(MGR), 0o755);
        ok.run(['status', '--json']);
        return mode(ok.home(MGR)) === 0o755 && !ok.kills().length;
    })());

    // iDrive 8: the boot unit's relist, before MainApp-21
    const id8 = id8Root();
    const custom = id8.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`);
    const cardash = rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true, acl: ACL, appletId: 20097 });
    id8.run(['install', '--artifact', cardash, '--yes']);
    id8.noManager();
    id8.run(['apply-pending']);
    const h8 = id8.home(MGR);
    fs.rmSync(h8, { recursive: true });
    const rl = id8.run(['relist']);
    check('factory reset: iDrive 8 relist creates nothing while the app manager\'s home is missing', rl.status === 0 &&
        rl.out.includes('has not created its data folder yet') && !fs.existsSync(h8), rl.out);
    const s8 = id8.status();
    check('factory reset: iDrive 8 status lists nothing meanwhile', s8.listing.state === 'pending' && !fs.existsSync(h8), JSON.stringify(s8.listing));
    fs.mkdirSync(path.join(h8, 'data'), { recursive: true, mode: 0o755 });
    fs.chmodSync(h8, 0o755);
    const fixed = id8.run(['relist'], asRoot);
    check('factory reset: iDrive 8 relist gives a root-owned home back before it lists', fixed.status === 0 && mode(h8) === 0o3770 &&
        mode(path.join(h8, 'data')) === 0o750 && fixed.out.includes('listed for the provisioning fallback: oap-cardash') &&
        !!(readJsonOrNull(custom) || {})['oap-cardash'], fixed.out);
    fs.chmodSync(h8, 0o755);
    const p8 = JSON.parse(id8.run(['status', '--json'], asRoot).stdout);
    check('factory reset: iDrive 8 status repairs it with the restart pending', mode(h8) === 0o3770 && !id8.kills().length &&
        p8.pending_reboot.some((x) => x.id === 'mgu-deploy' && /folders were repaired/.test(x.reason)), JSON.stringify(p8.pending_reboot));
}

/* The guard in a copy of the MainApp-21 fixture, loaded as MainApp-21
 * loads it, one process per start. */
function testId8Guard() {
    const dir = fs.mkdtempSync(path.join(T, 'guard-'));
    const list = path.join(dir, 'custom_apps.json');
    write(list, JSON.stringify({ our_app: { '-appStartType': 'autostart' } }));
    const r = cp.spawnSync(UNIT_NODE, [path.join(DEPLOY, 'unit', 'fallback_build.js'), path.join(HERE, 'fixtures', 'main21.js'),
        path.join(dir, 'built.js'), list], { encoding: 'utf8' });
    check('id8 guard: builds from the MainApp-21 fixture', r.status === 0, r.stderr);
    const load = () => JSON.parse(cp.spawnSync(UNIT_NODE, ['-e', `const P=require(${JSON.stringify(path.join(dir, 'built.js'))});` +
        'console.log(JSON.stringify({on:global.__mguDeployGuard.on,why:global.__mguDeployGuard.why,' +
        'section:new P().handle("our_app",undefined)||null,other:new P().handle("x",undefined)||null}))'], { encoding: 'utf8' }).stdout);
    const guard = path.join(dir, 'mgu-deploy-guard.json');
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    let l = load();
    check('id8 guard: the first load of a boot is on and gives a listed app with no section its flags',
        l.on && l.section && l.section['-enabled'] === 'true' && l.section['-appStartType'] === 'autostart' && l.other === null &&
        JSON.stringify(readJson(guard)) === JSON.stringify({ boot, loads: 1, ready: 0 }), JSON.stringify(l));
    l = load();
    check('id8 guard: a load after one that ended within a minute is off for the boot, the fallback with it',
        !l.on && l.why === 'MainApp-21 restarted within a minute of its start' && l.section === null && readJson(guard).off === l.why, JSON.stringify(l));
    const traced = JSON.parse(cp.spawnSync(UNIT_NODE, ['-e', `const P=require(${JSON.stringify(path.join(dir, 'built.js'))});` +
        'const cm=function(){},stub={callMethod:cm,install(){}};' +
        'P.start({appManager:stub},{getById:()=>null},{info(){}}).then(()=>{console.log(JSON.stringify(' +
        '{callMethod:stub.callMethod===cm,status:JSON.parse(require("fs").readFileSync(' +
        JSON.stringify(path.join(dir, 'mgu-deploy-inplace.json')) + ',"utf8")).state}));process.exit(0)})'], { encoding: 'utf8' }).stdout || 'null');
    check('id8 guard: off, the hook leaves MainApp-21\'s installer as it is and says so', traced && traced.callMethod === true &&
        traced.status === 'off', JSON.stringify(traced));
    write(guard, JSON.stringify({ boot, loads: 2, ready: 2 }));
    l = load();
    check('id8 guard: after loads that were up a minute it is on', l.on && readJson(guard).loads === 3, JSON.stringify(l));
    write(guard, JSON.stringify({ boot, loads: 3, ready: 3 }));
    write(path.join(dir, 'mgu-deploy-inplace.json'), JSON.stringify({ pid: 1, start: 0, at: Date.now(), state: 'running', app: 'our_app', action: 'install' }));
    l = load();
    check('id8 guard: a load after a MainApp-21 that ended during an in-place change is off',
        !l.on && l.why === 'MainApp-21 restarted during the in-place install of our_app', JSON.stringify(l));
    write(guard, JSON.stringify({ boot: 'an-earlier-boot', loads: 5, ready: 0, off: 'x' }));
    write(path.join(dir, 'mgu-deploy-inplace.json'), JSON.stringify({ pid: 1, start: 0, at: 0, state: 'running', app: 'our_app', action: 'install' }));
    l = load();
    check('id8 guard: a new boot starts it over', l.on && readJson(guard).loads === 1 && readJson(guard).boot === boot, JSON.stringify(l));
}

function testId8Apps() {
    const prov = process.env.MGU_TEST_ID8_PROV;
    [null].concat(prov ? [prov] : []).forEach((provDir) => {
        const tag = provDir ? 'id8 (real das files)' : 'id8';
        const root = id8Root({ prov: provDir });
        const das = () => [0, 1, 2, 3, 4, 5].map((i) => fs.readFileSync(root.p(`usr/share/tm/prov/das_00${i}.xml`), 'utf8'));
        const dasBefore = das();
        const art = rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true, acl: ACL, appletId: 20097 });
        const r = root.run(['install', '--artifact', art, '--yes']);
        const queued = root.p('var/opt/mgu-deploy/id8/queue/oap-cardash@1.1.4.tgz');
        const st = root.status();
        check(`${tag}: an install is queued for the next start, the npm package as published`, r.status === 0 &&
            r.out.includes('oap-cardash 1.1.4 installs at the next start of the head unit') &&
            fs.readFileSync(queued).equals(fs.readFileSync(art)) && !fs.existsSync(root.pre21('oap-cardash', '1.1.4')) &&
            st.pending_reboot.some((p) => p.id === 'oap-cardash' && p.reason === 'installs at the next start') &&
            JSON.stringify(das()) === JSON.stringify(dasBefore), r.out);
        check(`${tag}: the boot unit that applies it is installed, enabled and in recmgr`,
            fs.readFileSync(root.p('etc/systemd/system/mgu-deploy-apply.service'), 'utf8') ===
            fs.readFileSync(path.join(HERE, '..', 'unit', 'mgu-deploy-apply.service'), 'utf8') &&
            fs.readlinkSync(root.p('etc/systemd/system/late.target.wants/mgu-deploy-apply.service')) === '../mgu-deploy-apply.service' &&
            /mgu-deploy-apply/.test(fs.readFileSync(root.p('etc/recmgr-restartlist.conf'), 'utf8')));
        const busy = root.run(['apply-pending']);
        check(`${tag}: apply-pending is refused while MainApp runs`, busy.status === 2 && busy.out.includes('the app manager is running'), busy.out);
        root.noManager();
        const a = root.run(['apply-pending']);
        const lines = (t, s) => t.split('\n').filter((l) => l.trim() === s).length;
        const app = '<app supportedECUs="HU" initialPreferPreinstalled="true">oap-cardash</app>';
        const en = '<oap-cardash enabled="true" allowed="true" appStartType="autostart" userLoginRequired="false"/>';
        check(`${tag}: at boot the package goes to MainApp-21's preinstalled_apps and both lines into every das file`, a.status === 0 &&
            fs.readFileSync(root.pre21('oap-cardash', '1.1.4')).equals(fs.readFileSync(art)) &&
            das().every((t) => lines(t, app) === 1 && lines(t, en) === 1) && !fs.existsSync(queued) &&
            root.status().pending_reboot.length === 0 && root.status().last_apply.results[0].ok === true, a.out);
        // MainApp installs it at its start
        write(root.entry('oap-cardash'), JSON.stringify({ userId: 13001, installationSource: 'PREINSTALLED' }));
        write(root.p('var/opt/public/oap/oap_13001/source/package.json'), JSON.stringify({ name: 'oap-cardash', version: '1.1.4' }));
        write(root.p('var/opt/public/oap/oap_13001/data/x'), 'data\n');
        write(root.p(`var/opt/public/oap/oap_${MGR}/security/uids.txt`), '13000=stock_app\n13001=oap-cardash\n');
        write(root.p(`var/opt/public/oap/oap_${MGR}/data/diagOapInstallationStatus.json`), JSON.stringify({ 'oap-cardash': { installationStatus: 'installed' }, other: {} }));
        write(root.p('var/opt/personal/p1/oap/oap_13001/x'), 'p\n');
        write(root.p('etc/vsomeip/13001_13001/policy.json'), '{}\n');
        check(`${tag}: MainApp's install shows as installed`, root.status().components.some((c) => c.id === 'oap-cardash' && c.version === '1.1.4'));
        root.run(['uninstall', 'oap-cardash', '--yes']);
        const again = root.run(['install', '--artifact', art, '--yes']);
        check(`${tag}: installing the installed version again drops its queued removal`, again.status === 0 &&
            again.out.includes('the queued removal of oap-cardash is dropped') && root.status().pending_reboot.length === 0, again.out);
        const up = root.run(['install', '--artifact', rhmiApp('oap-cardash', '1.1.5', ['ID8'], { npm: true, acl: ACL, appletId: 20097 }), '--yes']);
        check(`${tag}: an update says the installed version goes first and comes back with its data should MainApp-21 not install the new one`, up.status === 0 &&
            up.out.includes('1.1.4 is uninstalled first and comes back, with its data, if MainApp-21 does not install 1.1.5'), up.out);
        const u = root.run(['uninstall', 'oap-cardash', '--yes']);
        check(`${tag}: uninstall replaces the queued update with a removal`, u.status === 0 &&
            JSON.stringify(root.status().pending_reboot) === JSON.stringify([{ id: 'oap-cardash', reason: 'removed at the next start' }]) &&
            !fs.existsSync(root.p('var/opt/mgu-deploy/id8/queue/oap-cardash@1.1.5.tgz')), u.out);
        const rm = root.run(['apply-pending']);
        const trash = root.p('var/opt/mgu-deploy/id8/trash');
        const bin = fs.readdirSync(trash)[fs.readdirSync(trash).length - 1];
        const inTrash = (p) => fs.existsSync(path.join(trash, bin, root.p(p)));
        check(`${tag}: at boot the removal moves registry entry, home, personal copy, vsomeip policy and package to the trash`, rm.status === 0 &&
            !fs.existsSync(root.entry('oap-cardash')) && inTrash(`var/opt/public/oap/oap_${MGR}/data/apps/oap-cardash.json`) &&
            inTrash('var/opt/public/oap/oap_13001/data/x') && inTrash('var/opt/personal/p1/oap/oap_13001/x') &&
            inTrash('etc/vsomeip/13001_13001/policy.json') && inTrash('usr/lib/oap-mainapp21/preinstalled_apps/oap-cardash@1.1.4.tgz') &&
            !fs.existsSync(root.pre21('oap-cardash', '1.1.4')), rm.out);
        check(`${tag}: and takes its uids.txt line, diag entry and das lines out`,
            fs.readFileSync(root.p(`var/opt/public/oap/oap_${MGR}/security/uids.txt`), 'utf8') === '13000=stock_app\n' &&
            JSON.stringify(readJson(root.p(`var/opt/public/oap/oap_${MGR}/data/diagOapInstallationStatus.json`))) === '{"other":{}}' &&
            JSON.stringify(das()) === JSON.stringify(dasBefore));
    });
    const root = id8Root();
    const flat = root.run(['install', '--artifact', rhmiApp('plainapp', '1.0.0', null), '--yes']);
    const q = root.p('var/opt/mgu-deploy/id8/queue/plainapp@1.0.0.tgz');
    check('id8: a flat package is repacked in npm format', flat.status === 0 && fs.existsSync(q) &&
        tarList(q).every((n) => n.indexOf('package/') === 0), flat.out);
    const drop = root.run(['uninstall', 'plainapp', '--yes']);
    check('id8: uninstalling an app only queued drops its install', drop.status === 0 && drop.out.includes('the queued install of plainapp is dropped') &&
        root.status().pending_reboot.length === 0 && !fs.existsSync(q), drop.out);
    const seven = root.run(['install', '--artifact', rhmiApp('robertn_x', '1.0.0', ['ID7'], { marked: true }), '--yes']);
    check('id8: an iDrive 7 app is refused', seven.status === 2 && seven.out.includes('is for iDrive 7 (its rhmiData); this head unit is iDrive 8'), seven.out);
    const fb = root.run(['fallback', 'migrate', '--yes']);
    check('id8: fallback migrate is refused', fb.status === 2 && fb.out.includes('fallback migrate is for iDrive 7'), fb.out);
    const sys = root.run(['uninstall', 'x_call', '--yes']);
    check('id8: a system app is not removed', sys.status === 2, sys.out);
    const seven7 = fakeRoot().run(['apply-pending']);
    check('id8: apply-pending is refused on iDrive 7', seven7.status === 2 && seven7.out.includes('this head unit is iDrive 7'), seven7.out);
}

/* A queued iDrive 8 update MainApp-21 rejects at boot: apply-pending moves
 * the installed version out and the new package in; MainApp-21's install
 * of it fails (a uid assigned, nothing registered). The next apply-pending,
 * before MainApp-21 starts, puts the previous version back with its uid
 * and data; one MainApp-21 installed is left as it is. */
function testId8RejectedUpdate() {
    const root = id8Root();
    const art = (v) => rhmiApp('oap-cardash', v, ['ID8'], { npm: true, acl: ACL, appletId: 20097 });
    const uids = root.p(`var/opt/public/oap/oap_${MGR}/security/uids.txt`);
    const home = (uid) => root.p(`var/opt/public/oap/oap_${uid}`);
    const rj = (f) => { try { return readJson(f); } catch (e) { return {}; } };
    const mainAppInstalls = (uid, v) => {
        write(root.entry('oap-cardash'), JSON.stringify({ userId: uid, installationSource: 'PREINSTALLED' }));
        write(path.join(home(uid), 'source/package.json'), JSON.stringify({ name: 'oap-cardash', version: v }));
        write(uids, fs.readFileSync(uids, 'utf8').split('\n').filter((l) => l && !/=oap-cardash$/.test(l)).concat([`${uid}=oap-cardash`, '']).join('\n'));
    };
    write(uids, '13000=stock_app\n');
    root.run(['install', '--artifact', art('1.1.4'), '--yes']);
    root.noManager();
    root.run(['apply-pending']);
    mainAppInstalls(13001, '1.1.4');
    write(path.join(home(13001), 'data/x'), 'data\n');
    write(root.p('var/opt/personal/p1/oap/oap_13001/x'), 'p\n');
    write(root.p('etc/vsomeip/13001_13001/policy.json'), '{}\n');
    const q = root.run(['install', '--artifact', art('1.1.5'), '--yes']);
    check('id8 rejected: an update is queued', q.status === 0 && q.out.includes('oap-cardash 1.1.5 installs at the next start'), q.out);
    const a = root.run(['apply-pending']);
    check('id8 rejected: at boot the update goes in, the installed version is kept until MainApp-21 takes it', a.status === 0 &&
        fs.existsSync(root.pre21('oap-cardash', '1.1.5')) && !fs.existsSync(root.entry('oap-cardash')) &&
        fs.existsSync(root.p('var/opt/mgu-deploy/id8/pending.json')) && root.status().pending_reboot.length === 0, a.out);
    // MainApp-21 rejects 1.1.5: a new uid, nothing registered
    write(uids, '13000=stock_app\n13002=oap-cardash\n');
    const b = root.run(['apply-pending']);
    const last = root.status().last_apply.results;
    check('id8 rejected: the next start puts the previous version back with its uid and data', b.status === 0 &&
        rj(root.entry('oap-cardash')).userId === 13001 && fs.existsSync(path.join(home(13001), 'data/x')) &&
        rj(path.join(home(13001), 'source/package.json')).version === '1.1.4' &&
        fs.existsSync(root.p('var/opt/personal/p1/oap/oap_13001/x')) && fs.existsSync(root.p('etc/vsomeip/13001_13001/policy.json')) &&
        fs.readFileSync(uids, 'utf8') === '13000=stock_app\n13001=oap-cardash\n', b.out);
    check('id8 rejected: and its package in place of the rejected one, reported in last_apply', fs.existsSync(root.pre21('oap-cardash', '1.1.4')) &&
        !fs.existsSync(root.pre21('oap-cardash', '1.1.5')) && last.length === 1 && last[0].action === 'restore' &&
        last[0].version === '1.1.4' && last[0].rejected === '1.1.5' && last[0].ok === true &&
        b.out.includes('oap-cardash 1.1.5 was not installed by MainApp-21 at the last start: 1.1.4 is back'), b.out + JSON.stringify(last));
    const c = root.run(['apply-pending']);
    check('id8 rejected: it is put back once', c.status === 0 && c.out.includes('nothing queued') &&
        !fs.existsSync(root.p('var/opt/mgu-deploy/id8/pending.json')), c.out);
    // an update MainApp-21 takes stays
    root.run(['install', '--artifact', art('1.1.6'), '--yes']);
    root.run(['apply-pending']);
    mainAppInstalls(13003, '1.1.6');
    const d = root.run(['apply-pending']);
    check('id8 rejected: an update MainApp-21 installed is left as it is', d.status === 0 && rj(root.entry('oap-cardash')).userId === 13003 &&
        fs.existsSync(root.pre21('oap-cardash', '1.1.6')) && !fs.existsSync(root.pre21('oap-cardash', '1.1.4')) &&
        !fs.existsSync(home(13001)) && !fs.existsSync(root.p('var/opt/mgu-deploy/id8/pending.json')) &&
        root.status().last_apply.results[0].version === '1.1.6', d.out);
    // a removal queued while the app was missing applies to the version put back
    root.run(['install', '--artifact', art('1.1.7'), '--yes']);
    root.run(['apply-pending']);
    root.run(['uninstall', 'oap-cardash', '--yes']);
    const e = root.run(['apply-pending']);
    check('id8 rejected: a removal queued meanwhile removes the version put back', e.status === 0 && !fs.existsSync(root.entry('oap-cardash')) &&
        !fs.existsSync(home(13003)) && !fs.existsSync(root.pre21('oap-cardash', '1.1.6')) &&
        !fs.existsSync(root.pre21('oap-cardash', '1.1.7')) &&
        JSON.stringify(root.status().last_apply.results.map((r) => r.action)) === '["restore","remove"]', e.out);
}

/* IterioDev's App Manager as his install.sh and his service leave it on an
 * iDrive 8 (appmanager-service: install.sh, oap.js, services.js, store.js):
 * the service in /var/opt/appmanager/code/<v>/ with its links, state.json,
 * config.json (a token for a private repository), catalog.json, apply.log,
 * a queued install in pending.json and staged/, his renderer and tether
 * with their units, his two units enabled for late.target by absolute
 * links; his app, Car Data and Drag Timer installed for MainApp-21, a Fault
 * Codes he installed and removed again, an app of our own; no recmgr list. */
function amRoot(opts) {
    opts = opts || {};
    const root = opts.id7 ? fakeRoot(opts) : id8Root(Object.assign({ noRecmgr: true }, opts));
    const H = (rel) => root.p(`var/opt/appmanager/${rel}`);
    const sys = (rel) => root.p(`etc/systemd/system/${rel}`);
    write(H('code/2.0.3/appmanager.js'), '// his daemon\n');
    write(H('code/2.0.3/version.json'), '{ "version": "2.0.3" }\n');
    ['current', 'stable', 'previous'].forEach((l) => fs.symlinkSync('2.0.3', H(`code/${l}`)));
    write(H('selfcheck.js'), '// his selfcheck\n');
    write(H('state.json'), JSON.stringify({ installedFrom: { 'oap-cardash': 'github.com/IterioDev/car-apps', 'mgu-renderd': 'github.com/IterioDev/car-apps' },
        lastApply: { at: 1, results: [] } }, null, 1));
    write(H('config.json'), JSON.stringify({ repos: [
        { url: 'github.com/IterioDev/car-apps', index: 'https://raw.githubusercontent.com/IterioDev/car-apps/HEAD/index.json', enabled: true, isDefault: true },
        { url: 'github.com/me/priv', index: 'https://api.github.com/repos/me/priv/contents/index.json', token: 'github_pat_SECRETSECRETSECRET', enabled: true }] }), 0o600);
    write(H('catalog.json'), JSON.stringify({ repos: { 'github.com/IterioDev/car-apps': { entries: [{ id: 'oap-appmanager' }, { id: 'oap-cardash' },
        { id: 'oap-draggy' }, { id: 'mgu-renderd' }] } } }));
    write(H('apply.log'), [
        { at: '2026-10-25T08:00:00Z', results: [{ appId: 'oap-appmanager', action: 'install', version: '2.0.3', ok: true },
            { appId: 'oap-draggy', action: 'install', version: '1.1.3', ok: true }, { appId: 'oap-dtcscan', action: 'install', version: '1.1.1', ok: true },
            { appId: 'oap-broken', action: 'install', version: '1.0.0', ok: false }] },
        { at: '2026-10-25T09:00:00Z', renderer: { action: 'install', version: '1.1.2', ok: true } },
        { at: '2026-10-25T10:00:00Z', results: [{ appId: 'oap-cardash', action: 'install', version: '1.1.4', ok: true },
            { appId: 'oap-dtcscan', action: 'remove', ok: true }] }].map((j) => JSON.stringify(j)).join('\n') + '\n');
    const staged = H('staged/oap-driverecorder-next@1.0.8.tgz');
    write(staged, fs.readFileSync(rhmiApp('oap-driverecorder-next', '1.0.8', ['ID8'], { npm: true })));
    write(H('pending.json'), JSON.stringify({ changes: [{ action: 'install', appId: 'oap-driverecorder-next', version: '1.0.8', title: 'Drive Recorder',
        staged: '/var/opt/appmanager/staged/oap-driverecorder-next@1.0.8.tgz', sha256: sha256(fs.readFileSync(staged)), at: 1 }] }));
    write(H('renderer/mgu-renderd'), elf(), 0o755);
    write(H('renderer/version.json'), JSON.stringify({ version: '1.1.2', at: 1 }));
    const tbin = Buffer.concat([elf(), Buffer.from('tether')]);
    write(H('tether/ipheth-tether'), tbin, 0o755);
    write(H('tether/version.json'), JSON.stringify({ version: '1.0.1', at: 1 }));
    write(sys('appmanager.service'), '[Service]\nExecStart=/usr/bin/node /var/opt/appmanager/code/current/appmanager.js daemon\n[Install]\nWantedBy=late.target\n');
    write(sys('appmanager-apply.service'), '[Service]\nType=oneshot\nExecStart=/usr/bin/node /var/opt/appmanager/code/stable/appmanager.js apply\n');
    write(sys('mgu-renderd.service'), '[Service]\nExecStart=/var/opt/appmanager/renderer/mgu-renderd --socket /run/mgu-renderd/renderd.sock\n');
    write(sys('ipheth-tether.service'), '[Service]\nExecStart=/var/opt/appmanager/tether/ipheth-tether socks 127.0.0.1:1080\n');
    ['appmanager.service', 'appmanager-apply.service', 'mgu-renderd.service'].forEach((u) => {
        fs.mkdirSync(sys('late.target.wants'), { recursive: true });
        fs.symlinkSync(`/etc/systemd/system/${u}`, sys(`late.target.wants/${u}`));
    });
    if (!opts.id7) {
        // what his apply step put in place for MainApp-21, and what it installed
        const das = (id) => [0, 1, 2, 3, 4, 5].forEach((i) => {
            const f = root.p(`usr/share/tm/prov/das_00${i}.xml`);
            fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('        </installable_apps>',
                `            <app supportedECUs="HU" initialPreferPreinstalled="true">${id}</app>\n        </installable_apps>`)
                .replace(/(<x_call [^\n]*\n)/, `$1        <${id} enabled="true" allowed="true" appStartType="autostart" userLoginRequired="false"/>\n`));
        });
        [['oap-appmanager', '2.0.3', 13001], ['oap-cardash', '1.1.4', 13002], ['oap-draggy', '1.1.3', 0], ['robertn_ours', '1.0.0', 13003]].forEach(([id, v, uid]) => {
            write(root.pre21(id, v), fs.readFileSync(rhmiApp(id, v, ['ID8'], { npm: true })));
            das(id);
            if (uid) {
                write(root.entry(id), JSON.stringify({ userId: uid, installationSource: 'PREINSTALLED' }));
                write(root.p(`var/opt/public/oap/oap_${uid}/source/package.json`), JSON.stringify({ name: id, version: v }));
                write(root.p(`var/opt/public/oap/oap_${uid}/data/kept`), `${id} data\n`);
            }
        });
    }
    root.env.FAKE_ACTIVE = 'appmanager.service mgu-renderd.service ipheth-tether.service';
    root.H = H;
    root.sys = sys;
    root.tbin = tbin;
    return root;
}

function testAppManager() {
    const root = amRoot();
    const st0 = root.status();
    check('appmanager: status names his service, his app and his running daemon', st0.appmanager && st0.appmanager.present === true &&
        st0.appmanager.version === '2.0.3' && st0.appmanager.app === '2.0.3' && st0.appmanager.daemon === 'active' &&
        st0.appmanager.record === null, JSON.stringify(st0.appmanager));
    const h0 = root.hash();
    const own = root.run(['install', '--artifact', rhmiApp('oap-appmanager', '2.0.4', ['ID8'], { npm: true }), '--yes']);
    check('appmanager: his app package is refused, nothing changed', own.status === 2 &&
        own.out.includes("oap-appmanager is IterioDev's App Manager, which the Store replaces") && root.hash().hash === h0.hash, own.out);
    const svc = root.run(['install', '--artifact', serviceArtifact('renderer', '1.1.3'), '--yes']);
    check('appmanager: a renderer package is refused while his renderer unit is his', svc.status === 2 &&
        svc.out.includes('mgu-renderd.service is installed, but by no tool of ours'), svc.out);
    const apps = () => ['oap-appmanager', 'oap-cardash', 'robertn_ours'].map((id) => fs.readFileSync(root.entry(id), 'utf8')).join() +
        ['var/opt/public/oap/oap_13001/data/kept', 'var/opt/public/oap/oap_13002/data/kept', 'var/opt/public/oap/oap_13003/data/kept']
            .map((f) => fs.readFileSync(root.p(f), 'utf8')).join() +
        [['oap-appmanager', '2.0.3'], ['oap-cardash', '1.1.4'], ['oap-draggy', '1.1.3']].map(([id, v]) => sha256(fs.readFileSync(root.pre21(id, v)))).join();
    const dasNow = () => [0, 1, 2, 3, 4, 5].map((i) => fs.readFileSync(root.p(`usr/share/tm/prov/das_00${i}.xml`), 'utf8')).join();
    const apps0 = apps(), das0 = dasNow();

    const a = root.run(['appmanager', 'adopt', '--yes']);
    const calls = root.systemctlCalls();
    const rec = readJsonOrNull(root.p('var/opt/mgu-deploy/appmanager.json')) || {};
    check('appmanager: adopt stops his daemon and his tether, a start queued for them too (never a restart of the renderer)', a.status === 0 &&
        calls.includes('stop appmanager.service') && calls.includes('stop ipheth-tether.service') &&
        !calls.some((c) => /^(stop|restart) mgu-renderd/.test(c)), a.out + calls.join('\n'));
    check('appmanager: his units stay, disabled', fs.existsSync(root.sys('appmanager.service')) && fs.existsSync(root.sys('appmanager-apply.service')) &&
        !fs.existsSync(root.sys('late.target.wants/appmanager.service')) && !fs.existsSync(root.sys('late.target.wants/appmanager-apply.service')));
    const unit = fs.readFileSync(root.sys('mgu-renderd.service'), 'utf8');
    check('appmanager: his renderer is the tool mgu-renderd, its program as it was, our unit over his, enabled',
        fs.readFileSync(root.p('var/opt/mgu-renderd/versions/1.1.2/mgu-renderd')).equals(elf()) &&
        fs.readlinkSync(root.p('var/opt/mgu-renderd/current')) === 'versions/1.1.2' &&
        unit.includes(`ExecStart=${root.p('var/opt/mgu-renderd/current/mgu-renderd')} --socket /run/mgu-renderd/renderd.sock --touch car`) &&
        fs.readlinkSync(root.sys('late.target.wants/mgu-renderd.service')) === '../mgu-renderd.service' &&
        root.status().components.some((c) => c.id === 'mgu-renderd' && c.provides === 'renderer'), unit);
    check('appmanager: the running renderer keeps running, the tool runs from its next start',
        root.status().pending_reboot.some((p) => p.id === 'mgu-renderd' && p.reason === 'the new version runs from its next start'),
        JSON.stringify(root.status().pending_reboot));
    const movedPkg = untarBuf(fs.readFileSync(root.p('var/opt/mgu-deploy/id8/queue/oap-driverecorder-next@1.0.8.tgz')));
    check('appmanager: his queued install moves to our queue as ours queues one (ACL tables, appletId), his pending.json goes',
        !fs.existsSync(root.H('pending.json')) &&
        JSON.parse(movedPkg['package/permissions.json']).masterRegistrationTable.length === 0 &&
        JSON.parse(movedPkg['package/rhmiData/application.json']).application.appletId === 20001 &&
        root.status().pending_reboot.some((p) => p.id === 'oap-driverecorder-next' && p.reason === 'installs at the next start'), a.out);
    check('appmanager: the record names the apps he installed that are on the unit or in his queue, with the repository he recorded',
        JSON.stringify(rec.apps) === JSON.stringify([{ id: 'oap-cardash', version: '1.1.4', from: 'github.com/IterioDev/car-apps' },
            { id: 'oap-draggy', version: '1.1.3', from: null }, { id: 'oap-driverecorder-next', version: '1.0.8', from: null }]) &&
        rec.renderer === '1.1.2' && rec.tether === '1.0.1', JSON.stringify(rec));
    check('appmanager: and his repositories with what his store saw there, without the token',
        rec.repos && rec.repos.length === 2 && rec.repos[0].isDefault === true && rec.repos[0].lists.indexOf('oap-draggy') >= 0 &&
        rec.repos[1].private === true && !fs.readFileSync(root.p('var/opt/mgu-deploy/appmanager.json'), 'utf8').includes('SECRET'), JSON.stringify(rec.repos));
    check('appmanager: nothing reinstalled: registry, app data, packages and das files as they were', apps() === apps0 && dasNow() === das0);
    check('appmanager: status says it is adopted', root.status().appmanager.record.at === rec.at && root.status().appmanager.daemon === 'inactive');
    const again = root.run(['appmanager', 'adopt', '--yes']);
    check('appmanager: adopting again changes nothing it took over', again.status === 0 && readJsonOrNull(root.p('var/opt/mgu-deploy/appmanager.json')).renderer === '1.1.2' &&
        fs.readlinkSync(root.p('var/opt/mgu-renderd/current')) === 'versions/1.1.2', again.out);

    const r = root.run(['uninstall', 'oap-appmanager', '--yes']);
    const st = root.status();
    check('appmanager: Remove takes his units and boot hook away and keeps his folder aside', r.status === 0 &&
        !fs.existsSync(root.sys('appmanager.service')) && !fs.existsSync(root.sys('appmanager-apply.service')) &&
        !fs.existsSync(root.sys('ipheth-tether.service')) && !fs.existsSync(root.H('')) &&
        fs.readFileSync(root.p('var/opt/mgu-deploy/appmanager-removed/tether/ipheth-tether')).equals(root.tbin), r.out);
    check('appmanager: his app is removed at the next start; the renderer and his apps stay', st.appmanager.present === false &&
        st.appmanager.record.removed && st.pending_reboot.some((p) => p.id === 'oap-appmanager' && p.reason === 'removed at the next start') &&
        fs.existsSync(root.p('var/opt/mgu-renderd/current/mgu-renderd')) && fs.existsSync(root.sys('mgu-renderd.service')) && apps() === apps0, JSON.stringify(st));
    root.noManager();
    const boot = root.run(['apply-pending']);
    const das = dasNow();
    check('appmanager: at the start his app goes; Car Data, Drag Timer, ours and the queued Drive Recorder are there',
        boot.status === 0 && !fs.existsSync(root.entry('oap-appmanager')) && !fs.existsSync(root.pre21('oap-appmanager', '2.0.3')) &&
        !das.includes('>oap-appmanager<') && das.includes('>oap-cardash<') && das.includes('>oap-draggy<') && das.includes('>robertn_ours<') &&
        das.includes('>oap-driverecorder-next<') && fs.existsSync(root.entry('oap-cardash')) &&
        fs.readFileSync(root.p('var/opt/public/oap/oap_13002/data/kept'), 'utf8') === 'oap-cardash data\n', boot.out);
    check('appmanager: once removed it is not on the unit, and adopt is refused',
        root.run(['appmanager', 'adopt', '--yes']).status === 2 && root.status().appmanager.present === false);

    // a failure rolls the takeover back
    const bad = amRoot();
    const hb = bad.hash((rel) => rel.startsWith('var/opt/mgu-deploy'));
    const f = bad.run(['appmanager', 'adopt', '--yes'], { FAKE_FAIL: 'daemon-reload' });
    const daemon = bad.unitFile('appmanager.service.active');
    check('appmanager: a failed adopt puts everything back, his daemon running', f.status === 1 &&
        bad.hash((rel) => rel.startsWith('var/opt/mgu-deploy')).hash === hb.hash &&
        (!fs.existsSync(daemon) || fs.readFileSync(daemon, 'utf8').trim() === 'active') &&
        !fs.existsSync(bad.p('var/opt/mgu-deploy/appmanager.json')),
        f.out + treeDiff(hb, bad.hash((rel) => rel.startsWith('var/opt/mgu-deploy'))));

    const late = amRoot();
    write(late.H('renderer/mgu-renderd'), '#!/bin/sh\n', 0o755);
    const hl = late.hash((rel) => rel.startsWith('var/opt/mgu-deploy'));
    const fl = late.run(['appmanager', 'adopt', '--yes']);
    check('appmanager: one failing after his daemon stopped (a renderer that is no program) starts it again, all else back', fl.status !== 0 &&
        fl.out.includes('is not an x86-64 program') && late.systemctlCalls().includes('start appmanager.service') &&
        late.hash((rel) => rel.startsWith('var/opt/mgu-deploy')).hash === hl.hash && !fs.existsSync(late.p('var/opt/mgu-renderd')),
        fl.out + treeDiff(hl, late.hash((rel) => rel.startsWith('var/opt/mgu-deploy'))));

    // our renderer tool first, his App Manager installed after it: his unit over ours
    const first = amRoot();
    fs.renameSync(first.sys('mgu-renderd.service'), `${first.R}.his-unit`);
    fs.unlinkSync(first.sys('late.target.wants/mgu-renderd.service'));
    const ownTool = first.run(['install', '--artifact', serviceArtifact('renderer', '1.1.0'), '--yes']);
    fs.copyFileSync(`${first.R}.his-unit`, first.sys('mgu-renderd.service'));
    const fa = first.run(['appmanager', 'adopt', '--yes']);
    check('appmanager: over our own renderer tool, adopt puts our unit back; the tool stays as it was', ownTool.status === 0 && fa.status === 0 &&
        fs.readFileSync(first.sys('mgu-renderd.service'), 'utf8').includes(`ExecStart=${first.p('var/opt/mgu-renderd/current/mgu-renderd')} `) &&
        fs.readlinkSync(first.p('var/opt/mgu-renderd/current')) === 'versions/1.1.0' &&
        first.status().appmanager.record.renderer === null, fa.out);

    // a recmgr list without his units: stopping a running one would restart the head unit
    const seven = amRoot({ id7: true });
    const unit7 = fs.readFileSync(seven.sys('mgu-renderd.service'), 'utf8');
    const s7 = seven.run(['appmanager', 'adopt', '--yes']);
    check('appmanager: with his daemon running and not in recmgr, adopt only disables his units; the rest waits for the next boot', s7.status === 0 &&
        !seven.systemctlCalls().some((c) => /^stop (appmanager|ipheth)/.test(c)) && !fs.existsSync(seven.sys('late.target.wants/appmanager.service')) &&
        seven.status().pending_reboot.some((p) => p.id === 'oap-appmanager' && p.reason === 'adopted at the next boot') &&
        seven.status().appmanager.record === null && fs.readFileSync(seven.sys('mgu-renderd.service'), 'utf8') === unit7 &&
        !fs.existsSync(seven.p('var/opt/mgu-renderd')), s7.out);
    const r7 = seven.run(['uninstall', 'oap-appmanager', '--yes']);
    check('appmanager: and it is not removed before then', r7.status === 2 && r7.out.includes('runs until the next boot') &&
        fs.existsSync(seven.sys('appmanager.service')), r7.out);
    seven.reboot(Math.floor(Date.now() / 1000) - 60);
    const n7 = seven.run(['appmanager', 'adopt', '--yes'], { FAKE_ACTIVE: 'mgu-renderd.service' });
    check('appmanager: at the next boot, his daemon not started, adopt completes', n7.status === 0 &&
        seven.status().appmanager.record.renderer === '1.1.2' && fs.readlinkSync(seven.p('var/opt/mgu-renderd/current')) === 'versions/1.1.2' &&
        !fs.readFileSync(seven.sys('mgu-renderd.service'), 'utf8').includes('--touch'), n7.out);
    // his queued install with a staged package that is another app, or a file that is not a tgz, is dropped saying why
    [[rhmiApp('oap-other', '1.0.8', ['ID8'], { npm: true }), 'its staged package is not that app'], [null, 'unreadable tgz']].forEach(([art, why]) => {
        const odd = amRoot();
        const staged = odd.H('staged/oap-driverecorder-next@1.0.8.tgz');
        write(staged, art ? fs.readFileSync(art) : 'not a tgz\n');
        const pend = readJson(odd.H('pending.json'));
        pend.changes[0].sha256 = sha256(fs.readFileSync(staged));
        write(odd.H('pending.json'), JSON.stringify(pend));
        const r = odd.run(['appmanager', 'adopt', '--yes']);
        check(`appmanager: his queued install is dropped, saying why (${why})`, r.status === 0 &&
            r.out.includes(`his queued install of oap-driverecorder-next is dropped: ${why}`) &&
            !fs.existsSync(odd.p('var/opt/mgu-deploy/id8/queue/oap-driverecorder-next@1.0.8.tgz')), r.out);
    });
    // the unit's failure while his queued install is moved rolls the whole adopt back, his queue kept for the next try:
    // no space to extract the package, the linker not loadable, no space to write the repacked package
    const unitCopy = (files) => {
        const d = fs.mkdtempSync(path.join(T, 'unit-'));
        fs.readdirSync(path.join(HERE, '..', 'unit')).forEach((n) => fs.copyFileSync(path.join(HERE, '..', 'unit', n), path.join(d, n)));
        LINK_FILES.forEach((n) => fs.copyFileSync(path.join(HERE, '..', '..', 'tools', n), path.join(d, n)));
        Object.keys(files).forEach((n) => fs.writeFileSync(path.join(d, n), files[n]));
        return path.join(d, 'mgu-deploy.js');
    };
    const fullTar = path.join(fs.mkdtempSync(path.join(T, 'tar-')), 'tar');
    fs.writeFileSync(fullTar, '#!/bin/sh\ncase "$1" in -x*) echo "tar: write error: No space left on device" >&2; exit 2;; esac\nexec tar "$@"\n',
        { mode: 0o755 });
    const realPack = fs.readFileSync(path.join(HERE, '..', '..', 'tools', 'oap_pack.js'), 'utf8');
    {
        const env8 = amRoot();
        write(env8.p('var/opt/public/oap/oap_13099/rhmiData/application.json'), '{ not json');
        const r = env8.run(['appmanager', 'adopt', '--yes']);
        check('appmanager: an appletId source that cannot be read while his queued install moves: adopt rolled back, his queue kept',
            r.status !== 0 && r.out.includes('rolling back') && !r.out.includes('is dropped') && fs.existsSync(env8.H('pending.json')) &&
            !fs.existsSync(env8.p('var/opt/mgu-deploy/id8/queue/oap-driverecorder-next@1.0.8.tgz')) && env8.status().appmanager.record === null, r.out);
    }
    [['no space to extract', null, { MGU_DEPLOY_TAR: fullTar }],
        ['the linker not loadable', unitCopy({ 'oap_link.js': "throw new Error('oap_link.js: cannot load');\n" }), {}],
        ['no space to write the repacked package', unitCopy({ 'oap_pack.js': `${realPack}\nconst tgz = module.exports.tgz;\n` +
            "module.exports.tgz = (entries, mtime) => { if (entries.some((e) => e.name.indexOf('package/') === 0)) { " +
            "const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC'; throw e; } return tgz(entries, mtime); };\n" }), {}]]
        .forEach(([what, js, env]) => {
            const env8 = amRoot();
            const r = js ? cp.spawnSync(UNIT_NODE, [js, 'appmanager', 'adopt', '--yes'], { encoding: 'utf8', env: Object.assign({}, env8.env, env), input: '' })
                : env8.run(['appmanager', 'adopt', '--yes'], env);
            const out = `${r.stdout}${r.stderr}`;
            check(`appmanager: ${what} while his queued install moves: adopt rolled back, his queue kept`, r.status !== 0 &&
                out.includes('rolling back') && !out.includes('is dropped') && fs.existsSync(env8.H('pending.json')) &&
                fs.existsSync(env8.H('staged/oap-driverecorder-next@1.0.8.tgz')) &&
                !fs.existsSync(env8.p('var/opt/mgu-deploy/id8/queue/oap-driverecorder-next@1.0.8.tgz')) && env8.status().appmanager.record === null, out);
        });
}

/* iDrive 8: what MainApp-21 needs and a package lacks, added before it is
 * queued: the ACL tables permissions.json lacks, and an appletId free on
 * the unit, read from what the unit has. */
function testId8Complete() {
    const queuedIn = (root) => (id, v) => untarBuf(fs.readFileSync(root.p(`var/opt/mgu-deploy/id8/queue/${id}@${v || '1.0.0'}.tgz`)));
    const appletId = (m) => JSON.parse(m['package/rhmiData/application.json']).application.appletId;
    const install = (root, id, opts) => root.run(['install', '--artifact', rhmiApp(id, (opts || {}).v || '1.0.0', ['ID8'],
        Object.assign({ npm: true, acl: ACL }, opts || {})), '--yes']);

    // a unit whose only id in use is a built-in applet's, 20000
    const root = id8Root();
    const queued = queuedIn(root);
    const entry = { uid: '${APPNAME}', domain: 'hmi.entrypoint2', operation: '*' };
    const r = root.run(['install', '--artifact', rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true, acl: { masterAccessTable: [entry] } }), '--yes']);
    const m = queued('oap-cardash', '1.1.4'), acl = JSON.parse(m['package/permissions.json']);
    check('id8: a package without masterRegistrationTable or appletId is queued with both added, its entries kept', r.status === 0 &&
        JSON.stringify(acl) === JSON.stringify({ masterAccessTable: [entry], masterRegistrationTable: [] }) && appletId(m) === 20001 &&
        Object.keys(m).every((n) => n.indexOf('package/') === 0) &&
        r.out.includes('repacked oap-cardash 1.1.4: masterRegistrationTable added to permissions.json, appletId 20001 added to rhmiData/application.json'),
    r.out);
    const two = root.run(['install', '--artifact', rhmiApp('a1', '1.0.0', ['ID8'], { npm: true, acl: ACL }),
        '--artifact', rhmiApp('a2', '1.0.0', ['ID8'], { acl: ACL }), '--yes']);
    check('id8: apps without one get appletIds the queue and each other do not hold', two.status === 0 &&
        appletId(queued('a1')) === 20002 && appletId(queued('a2')) === 20003, two.out);
    const kept = install(root, 'kept', { appletId: 20650 });
    check('id8: a declared appletId free on the unit is kept', kept.status === 0 && appletId(queued('kept')) === 20650 &&
        !kept.out.includes('repacked'), kept.out);
    const clash = install(root, 'clash', { appletId: 20001 });
    check('id8: a declared appletId another app holds is replaced by a free one, saying so', clash.status === 0 &&
        appletId(queued('clash')) === 20004 &&
        clash.out.includes('appletId 20004 in rhmiData/application.json in place of 20001, which this unit cannot take'), clash.out);
    const fixed = [['near', 21000, 20005], ['high', 27100, 20006], ['low', 19900, 20007]].map(([id, v, want]) => {
        const x = install(root, id, { appletId: v });
        return [x, appletId(queued(id)) === want];
    });
    check('id8: a declared appletId 1000 from a built-in applet\'s, or outside what Hmi8 takes, is replaced',
        fixed.every(([x, ok]) => x.status === 0 && ok), fixed.map(([x]) => x.out).join('\n'));

    // another unit: ids in use at 20000 (an OAP app), 20001 (a native applet), 23002 (a built-in RHMI applet, 3000 from 20002),
    // 20003 (an OAP app), 20004 (a built-in RHMI applet), 20005 (MainApp-21), 20006 (a package in preinstalled_apps)
    const r2 = id8Root({ builtin: [23002, 20004], native: ['0x4E21', '0x08'] });
    const q2 = queuedIn(r2);
    const home = (uid, v) => write(r2.p(`var/opt/public/oap/oap_${uid}/rhmiData/application.json`), JSON.stringify({ application: { appletId: v } }));
    home(13001, 20000); home(13002, 20003);
    write(r2.p('usr/lib/oap-mainapp21/rhmiData/application.json'), JSON.stringify({ application: { appletId: 20005 } }));
    write(r2.pre21('waiting', '1.0.0'), fs.readFileSync(rhmiApp('waiting', '1.0.0', ['ID8'], { npm: true, appletId: 20006 })));
    const n = install(r2, 'newapp');
    check('id8: the lowest appletId clear of every id the unit has: OAP apps, MainApp-21, preinstalled packages, the HMI\'s built-in applets',
        n.status === 0 && appletId(q2('newapp')) === 20007, n.out);
    write(r2.entry('mine'), JSON.stringify({ userId: 13003 }));
    home(13003, 20650);
    write(r2.p('var/opt/public/oap/oap_13003/source/package.json'), JSON.stringify({ name: 'mine', version: '0.9.0' }));
    write(r2.p('usr/lib/oap-mainapp21/preinstalled_apps/mine-0.9.0.tgz'), fs.readFileSync(rhmiApp('mine', '0.9.0', ['ID8'], { npm: true, appletId: 20650 })));
    const u = install(r2, 'mine', { appletId: 20700 });
    check('id8: an update keeps the installed version\'s appletId (its package named <id>-<version>.tgz) over the one it declares',
        u.status === 0 && appletId(q2('mine')) === 20650, u.out);
    write(r2.entry('lowapp'), JSON.stringify({ userId: 13005 }));
    home(13005, 19500);
    write(r2.p('var/opt/public/oap/oap_13005/source/package.json'), JSON.stringify({ name: 'lowapp', version: '0.9.0' }));
    const lo = install(r2, 'lowapp');
    check('id8: an installed version\'s appletId outside what Hmi8 takes is not kept', lo.status === 0 && appletId(q2('lowapp')) === 20008, lo.out);

    // a unit without native applets has none of their ids
    const none = id8Root({ native: [] });
    fs.rmSync(none.p('usr/lib/hmi8/applet'), { recursive: true, force: true });
    const nn = install(none, 'nonative');
    check('id8: a unit without the native applets\' folder has no ids there', nn.status === 0 && appletId(queuedIn(none)('nonative')) === 20001, nn.out);

    // what cannot be read refuses the install, nothing queued: an app's application.json that does not parse, an applets
    // folder that is no folder, a manifest whose appletId is no number
    const bad = id8Root();
    write(bad.p('var/opt/public/oap/oap_13009/rhmiData/application.json'), '{ not json');
    const b1 = install(bad, 'b1');
    fs.rmSync(bad.p('var/opt/public/oap/oap_13009'), { recursive: true });
    fs.rmSync(bad.p('usr/lib/hmi8/applet'), { recursive: true });
    write(bad.p('usr/lib/hmi8/applet'), 'not a folder\n');
    const b2 = install(bad, 'b2');
    fs.rmSync(bad.p('usr/lib/hmi8/applet'));
    write(bad.p('mnt/dataro/data/hmi8/applet/rhmi9/X/X.manifest'), '<plugin><appletId>twenty</appletId></plugin>\n');
    const b3 = install(bad, 'b3');
    fs.rmSync(bad.p('mnt/dataro/data/hmi8/applet/rhmi9'), { recursive: true });
    fs.rmSync(bad.p('mnt/dataro/data/hmi8'), { recursive: true });
    const b4 = install(bad, 'b4');
    check('id8: an id source that cannot be read fails the install (the unit\'s failure): an app\'s application.json, an applets folder that ' +
        'is no folder, a manifest id that is no number, the HMI\'s data folder missing', b1.status === 1 &&
        b1.out.includes('rhmiData/application.json for the appletIds in use') && b2.status === 1 && b2.out.includes('cannot read the HMI\'s applets') &&
        b3.status === 1 && b3.out.includes('appletId twenty is not a number') && b4.status === 1 && b4.out.includes('mnt/dataro/data/hmi8 is missing') &&
        ['b1', 'b2', 'b3', 'b4'].every((id) => !fs.existsSync(bad.p(`var/opt/mgu-deploy/id8/queue/${id}@1.0.0.tgz`))),
    `${b1.out}\n${b2.out}\n${b3.out}\n${b4.out}`);
    const noHomes = id8Root();
    fs.rmSync(noHomes.p('var/opt/public/oap'), { recursive: true });
    const nh = install(noHomes, 'nh');
    check('id8: the apps\' homes folder missing refuses the install', nh.status === 2 &&
        nh.out.includes('the app manager has not created its data folder yet'), nh.out);

    // a unit whose RHMI applets folder is missing under the HMI's data has none there
    const noRhmi = id8Root({ builtin: [] });
    const nr = install(noRhmi, 'norhmi');
    check('id8: the RHMI applets folder missing under the HMI\'s data holds no ids', nr.status === 0 && appletId(queuedIn(noRhmi)('norhmi')) === 20000, nr.out);

    // what the scan reads: manifests through a linked folder and a linked file, hex ids, an empty id passed over, a
    // byte order mark in an app's application.json; other apps' packages that cannot be read passed over, warning
    const odd = id8Root({ builtin: [], native: [] });
    const H = (rel) => odd.p(`mnt/dataro/data/hmi8/${rel}`);
    write(odd.p('elsewhere/Linked/Linked.manifest'), '<plugin><appletId>20000</appletId></plugin>\n');
    fs.mkdirSync(H('applet'), { recursive: true });
    fs.symlinkSync(odd.p('elsewhere'), H('applet/linkeddir'));
    write(odd.p('elsewhere2/real.manifest'), '<plugin><appletId>0x4E21</appletId></plugin>\n');
    fs.mkdirSync(H('applet/files'), { recursive: true });
    fs.symlinkSync(odd.p('elsewhere2/real.manifest'), H('applet/files/Hex.manifest'));
    write(H('applet/empty/Empty.manifest'), '<plugin><appletId></appletId></plugin>\n');
    write(odd.p('var/opt/public/oap/oap_13001/rhmiData/application.json'), '\uFEFF' + JSON.stringify({ application: { appletId: 20002 } }));
    write(odd.pre21('broken', '1.0.0'), 'not a tgz\n');
    write(odd.p('var/opt/mgu-deploy/id8/queue/gone@1.0.0.tgz'), 'not a tgz\n');
    write(odd.p('var/opt/mgu-deploy/id8/pending.json'), JSON.stringify({ changes: [{ action: 'install', id: 'gone', version: '1.0.0',
        file: odd.p('var/opt/mgu-deploy/id8/queue/gone@1.0.0.tgz'), sha256: 'x' }] }));
    const o = install(odd, 'oddapp');
    check('id8: linked folders and files, hex and empty ids, a byte order mark are read; others\' unreadable packages passed over, warning',
        o.status === 0 && appletId(queuedIn(odd)('oddapp')) === 20003 && o.out.includes('broken@1.0.0.tgz is not known, passed over') &&
        o.out.includes('gone@1.0.0.tgz is not known, passed over'), o.out);
}

/* An install in which every app is current, on an iDrive 7 unit whose
 * fallback unit is gone while our app is registered and listed: the
 * fallback goes on again and the manager restarts once; a later install
 * leaves it; with the HMI or the SOME/IP daemon not running it takes
 * effect at the next start, with no restart; a copy that does not build
 * leaves the fallback off, says why, and status gives the reason. */
function testRelist() {
    const PLATFORM = 'vsomeipd.service hmi.service';
    const lose = (root) => {
        fs.unlinkSync(root.p('etc/systemd/system/mgu-app-fallback.service'));
        fs.unlinkSync(root.p('etc/systemd/system/multi-user.target.wants/mgu-app-fallback.service'));
    };
    const again = (root) => root.run(['install', '--artifact', toolArtifact('0.1.0'), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    let root = fakeRoot({ active: PLATFORM });
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const k0 = root.kills().length;
    lose(root);
    check('relist: status --json says the fallback is off and the manager does not run its copy',
        root.status().fallback.unit_present === false && root.status().fallback.manager_runs_copy === false);
    const app = (st) => st.components.find((c) => c.id === 'fixture_app') || {};
    const cached = readJson(root.entry('fixture_app')).provisioningCache;
    let st = root.status();
    check('relist: with the registry cache still enabled and allowed, status --json reports the tile hidden',
        cached['-enabled'] === 'true' && cached['-allowed'] === 'true' && app(st).tile_visible === false &&
        app(st).tile_provisioned === false && app(st).tile_fallback === false, JSON.stringify(app(st)));
    check('relist: status prints tile=hidden and check tile hidden',
        root.run(['status']).stdout.includes('app fixture_app 1.0.0 uid=13001 source=PREINSTALLED running=false tile=hidden') &&
        root.run(['check']).stdout.includes('app fixture_app 1.0.0: tile hidden'), root.run(['status']).out);
    let r = again(root);
    check('relist: the app current and the fallback unit gone, the install turns it on again and restarts the manager once',
        r.status === 0 && r.out.includes('fixture_app 1.0.0 already installed; nothing to change') &&
        r.out.includes('our apps are listed again: restarting the app manager so their tiles show') &&
        root.kills().length === k0 + 1 && fs.existsSync(root.p('etc/systemd/system/mgu-app-fallback.service')) &&
        fs.readlinkSync(root.p('etc/systemd/system/multi-user.target.wants/mgu-app-fallback.service')) === '../mgu-app-fallback.service' &&
        root.status().fallback.unit_present === true, r.out);
    const young = JSON.parse(root.run(['status', '--json'], { MGU_DEPLOY_BOUNCE_MIN_UP_S: '60' }).stdout).fallback;
    check('relist: the manager the relist bounce started counts as running the copy while younger than the bounce minimum',
        young.manager_runs_copy === true && root.status().fallback.manager_runs_copy === false, JSON.stringify(young));
    r = again(root);
    check('relist: the next install, with the fallback on, does not restart the manager',
        r.status === 0 && root.kills().length === k0 + 1 && !r.out.includes('listed again'), r.out);

    // the copy's in-place hook announced for the running manager: status says it runs the copy
    startInplace(root);
    check('relist: status --json says the manager runs the copy once its hook announced itself',
        root.status().fallback.manager_runs_copy === true);
    st = root.status();
    check('relist: with the manager on the copy, status reports the tile from the fallback',
        app(st).tile_fallback === true && app(st).tile_visible === true && app(st).tile_provisioned === false &&
        root.run(['status']).stdout.includes('tile=fallback'), JSON.stringify(app(st)));
    fs.writeFileSync(root.env.FAKE_MGR_PIDFILE, '');
    st = root.status();
    check('relist: with no app manager running, status reports the tile hidden',
        st.fallback.manager_runs_copy === null && app(st).tile_visible === false && app(st).tile_fallback === false,
        JSON.stringify(app(st)));

    // the HMI and the SOME/IP daemon not running: no restart, the boot unit lists the app from the next start
    root = fakeRoot();
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const k1 = root.kills().length;
    lose(root);
    r = again(root);
    check('relist: with the HMI and the SOME/IP daemon down, the fallback goes on with no restart, from the next start',
        r.status === 0 && root.kills().length === k1 && fs.existsSync(root.p('etc/systemd/system/mgu-app-fallback.service')) &&
        r.out.includes('our apps are listed again from the next start of the head unit (vsomeipd.service, hmi.service not running'), r.out);

    // a copy that does not build: the fallback stays off, the install stands, status gives the reason
    root = fakeRoot({ active: PLATFORM });
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    const k2 = root.kills().length;
    lose(root);
    write(root.p('usr/lib/oap-mainapp/src/main.js'), stockMain().replace(HOOK_ANCHOR, 'isMainapp&&(newProvisioning.'));
    r = again(root);
    const fb = root.status().fallback;
    check('relist: a copy that does not build leaves the fallback off, no restart, the install stands, the reason in status',
        r.status === 0 && root.kills().length === k2 && r.out.includes('our apps\' tiles stay hidden: ') &&
        !fs.existsSync(root.p('etc/systemd/system/mgu-app-fallback.service')) && fb.unit_present === false &&
        typeof fb.refused === 'string' && fb.refused.includes('anchor'), `${r.out}\n${JSON.stringify(fb)}`);

    // the fallback unit gone while the running manager still runs the bound copy: listed again, no restart
    root = fakeRoot({ active: PLATFORM });
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    startInplace(root);
    const k3 = root.kills().length;
    lose(root);
    r = again(root);
    check('relist: a manager whose hook announced itself on the copy is not restarted',
        r.status === 0 && root.kills().length === k3 && fs.existsSync(root.p('etc/systemd/system/mgu-app-fallback.service')), r.out);

    // our app registered (the manager put it back from preinstalled_apps) but not listed, the fallback
    // on and run by the manager: status lists it, from the manager's next start; an install lists it
    // and restarts the manager once
    const custom = (root) => readJson(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`));
    const unlist = (root) => write(root.p(`var/opt/public/oap/oap_${MGR}/data/custom_apps.json`), '{}\n');
    root = fakeRoot({ active: PLATFORM });
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    startInplace(root);
    unlist(root);
    st = root.status();
    check('relist: status lists an app of ours registered without a listing, from the next start',
        st.listing && st.listing.state === 'changed' && custom(root).fixture_app &&
        custom(root).fixture_app['-enabled'] === 'true' && custom(root).fixture_app['-allowed'] === 'true',
        JSON.stringify(st.listing));
    check('relist: and the next status has nothing to do', root.status().listing.state === 'ok');
    const k7 = root.kills().length;
    r = again(root);
    check('relist: an install after the status that listed it restarts the manager that has not taken it, once',
        r.status === 0 && root.kills().length === k7 + 1 &&
        r.out.includes('our apps are listed again: restarting the app manager so their tiles show'), r.out);
    startInplace(root);
    unlist(root);
    const k4 = root.kills().length;
    r = again(root);
    check('relist: an install with every app current lists an unlisted app of ours and restarts the manager once',
        r.status === 0 && custom(root).fixture_app && root.kills().length === k4 + 1 &&
        r.out.includes('our apps are listed again: restarting the app manager so their tiles show'), r.out);
    r = again(root);
    check('relist: the next install leaves it', r.status === 0 && root.kills().length === k4 + 1 && !r.out.includes('listed again'), r.out);

    // the same with the fallback unit gone: the fallback goes on again with the app listed
    root = fakeRoot({ active: PLATFORM });
    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    lose(root);
    unlist(root);
    const k6 = root.kills().length;
    r = again(root);
    check('relist: an unlisted app of ours with the fallback unit gone: listed, the fallback on, one restart',
        r.status === 0 && custom(root).fixture_app && root.kills().length === k6 + 1 &&
        fs.existsSync(root.p('etc/systemd/system/mgu-app-fallback.service')), r.out);

    // app-privacy applied during a relist waits for the relist's restart, said as such
    root = fakeRoot({ active: PLATFORM, privacy: false });
    root.run(['install', '--artifact', privacyTool('1.0.0', 0), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    lose(root);
    const k5 = root.kills().length;
    r = root.run(['install', '--artifact', privacyTool('1.0.1', 0), '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    check('relist: app-privacy\'s restart is the relist\'s one restart, and the output says so',
        r.status === 0 && root.kills().length === k5 + 1 && r.out.includes('app-privacy: the app manager loads it at its next restart') &&
        !r.out.includes('the app install\'s restart'), r.out);

    // no app of ours registered or listed: nothing to list again
    root = fakeRoot({ active: PLATFORM });
    r = root.run(['install', '--artifact', toolArtifact('0.1.0'), '--yes']);
    check('relist: a unit with no app of ours gets no fallback from a tool install',
        r.status === 0 && !fs.existsSync(root.p('etc/systemd/system/mgu-app-fallback.service')) && !root.kills().length, r.out);
}

/* first-install's last line on iDrive 7 follows our apps' tiles: done
 * once the manager runs the fallback copy, a restart while it does not,
 * and one line saying why when the fallback could not go on. */
function testMguInstallTiles() {
    const mi = require(MGU_INSTALL);
    const st = (fb, extra) => JSON.stringify(Object.assign({ unit: { hmi: 'ID7' }, fallback: fb, retired_leftovers: [] }, extra || {}));
    const fb = { active: true, apps: ['robertn_store'], manager_runs_copy: true, refused: null };
    check('mgu-install tiles: an active fallback the manager runs shows the tiles', mi.tilesShow(st(fb)).shown === true);
    check('mgu-install tiles: an active fallback the manager does not run yet needs a restart',
        mi.tilesShow(st(Object.assign({}, fb, { manager_runs_copy: false }))).shown === false &&
        !mi.tilesShow(st(Object.assign({}, fb, { manager_runs_copy: null }))).why);
    check('mgu-install tiles: a fallback the deploy tool could not turn on gives its reason',
        mi.tilesShow(st(Object.assign({}, fb, { active: false, manager_runs_copy: null, refused: 'fallback build refused: x' }))).why ===
        'fallback build refused: x');
    const older = { active: false, apps: ['robertn_store'] };
    check('mgu-install tiles: an older deploy tool\'s status, iDrive 8, no app listed, the retired installer\'s leftovers or no status count as shown',
        mi.tilesShow(st(older)).shown && mi.tilesShow(st(Object.assign({}, fb, { active: false }), { unit: { hmi: 'ID8' } })).shown &&
        mi.tilesShow(st(Object.assign({}, fb, { active: false, apps: [] }))).shown &&
        mi.tilesShow(st(Object.assign({}, fb, { active: false }), { retired_leftovers: ['x'] })).shown &&
        mi.tilesShow('').shown && mi.tilesShow(undefined).shown);
    const st8 = (comps, fb8) => JSON.stringify({ unit: { hmi: 'ID8' }, components: comps,
        fallback: Object.assign({ active: true, apps: ['robertn_store', 'oap-cardash'], manager_runs_copy: null, listed_by_manager: [] }, fb8 || {}) });
    const app = (id, visible) => ({ id, kind: 'app', tile_visible: visible });
    check('mgu-install tiles: iDrive 8 shows once the Store and every listed app report their tiles visible',
        mi.tilesShow(st8([app('robertn_store', true), app('oap-cardash', true)])).shown === true &&
        mi.tilesShow(st8([app('robertn_store', true)])).shown === true);
    check('mgu-install tiles: on iDrive 8 a hidden tile or a Store not yet registered needs a restart',
        mi.tilesShow(st8([app('robertn_store', true), app('oap-cardash', false)])).shown === false &&
        mi.tilesShow(st8([app('robertn_store', false)])).shown === false && mi.tilesShow(st8([])).shown === false &&
        !mi.tilesShow(st8([])).why);
    check('mgu-install tiles: on iDrive 8 a fallback that cannot go on gives its reason',
        mi.tilesShow(JSON.stringify(Object.assign(JSON.parse(st8([app('robertn_store', false)], { active: false })),
            { live_installs: { state: 'ok', reason: 'off: fallback build refused: x' } }))).why === 'fallback build refused: x' &&
        !mi.tilesShow(JSON.stringify(Object.assign(JSON.parse(st8([app('robertn_store', true)], { active: false })),
            { live_installs: { state: 'ok', reason: 'off: fallback build refused: x' } }))).why);

    const gh = fakeGithub({ files: [], repos: {} });
    try {
        const rel = fakeRelease(gh.api);
        gh.set({ files: rel.files, repos: { [STORE_REPO]: { catalog: rel.catalogIndex } } });
        const root = donorRoot();
        writeCoding(root, 0x09);
        const opts = { bin: installBin(root), api: gh.api };
        const args = ['first-install', '--host', '10.0.0.9', '--no-uplink', '--no-renderer'];
        let r = mguInstall(args, opts);
        fs.writeFileSync(root.unitFile('mgu-updater.service.active'), 'active\n');
        r = mguInstall(args, opts);
        check('mgu-install tiles: the updater running, the manager not on the fallback copy: a restart finishes setup',
            r.status === 0 && r.stdout.endsWith('\nRestart the head unit to finish setup.\n'), r.out.slice(-1500));
        const mgr = startInplace(root);
        r = mguInstall(args, opts);
        check('mgu-install tiles: the manager on the fallback copy: setup is done',
            r.status === 0 && r.stdout.endsWith('Setup is done: the Store installs and updates everything from here on.\n'), r.out.slice(-1500));
        mgr.kill('SIGKILL');
        fs.writeFileSync(`${root.R}.mgr.pid`, '4000');
        fs.unlinkSync(root.p('etc/systemd/system/mgu-app-fallback.service'));
        fs.unlinkSync(root.p('etc/systemd/system/multi-user.target.wants/mgu-app-fallback.service'));
        write(root.p('usr/lib/oap-mainapp/src/main.js'), stockMain().replace(HOOK_ANCHOR, 'isMainapp&&(newProvisioning.'));
        r = mguInstall(args, opts);
        check('mgu-install tiles: the fallback lost and its copy not building: one line saying why, exit 1',
            r.status === 1 && /\nThe Store's tile cannot show: [^\n]*anchor[^\n]*\n$/.test(r.stdout) && !r.out.includes('Setup is done'),
            r.out.slice(-1500));
        fs.writeFileSync(root.unitFile('mgu-updater.service.active'), 'inactive\n');
        r = mguInstall(args, opts);
        check('mgu-install tiles: the same with the updater waiting for the next start: the reason, then the restart line',
            r.status === 0 && /\nThe Store's tile cannot show: [^\n]*\nRestart the head unit to finish setup\.\n$/.test(r.stdout),
            r.out.slice(-1500));
    } finally {
        gh.stop();
    }
}

/* --read-only belongs to status: any other command given it is refused
 * before it takes the lock or changes anything. */
function testReadOnlyOnlyStatus() {
    const root = fakeRoot();
    const ins = root.run(['install', '--artifact', toolArtifact('0.1.0'), '--yes']);
    if (ins.status !== 0) throw new Error(ins.out);
    const before = root.hash();
    [['relay', '--read-only', '--yes'], ['install', '--artifact', toolArtifact('0.2.0'), '--read-only', '--yes'],
        ['uninstall', 'fixture-tool', '--read-only', '--yes'], ['verify', '--read-only'], ['check', '--read-only']].forEach((a) => {
        const r = root.run(a);
        check(`read-only: ${a[0]} --read-only is refused (exit 2) and changes nothing`,
            r.status === 2 && r.stderr.includes('--read-only is only for status') && root.hash().hash === before.hash,
            r.out + treeDiff(before, root.hash()));
    });
}

// MGU_TEST_ONLY=<name>,...: only those test functions
const SUITES = [
    testArtifact,
    testSelf,
    testRefusals,
    testToolInstall,
    testPendingReboot,
    testApps,
    testBounceGuard,
    testIdleWait,
    testMainAppGuard,
    testGuardStops,
    testGuardNested,
    testGuardEdges,
    testGuardStash,
    testGuardBookkeeping,
    testGuardCopy,
    testNoManagerInstall,
    testDefaultCodingInstall,
    testMainBind,
    testRestore,
    testPrivacyRevert,
    testPrivacySkipped,
    testStatusJson,
    testFallback,
    testRelist,
    testInplace,
    testCertCopy,
    testMainApp811,
    testMainApp655,
    testCertificationProxy,
    testUnknownInterfaces,
    testInterrupted,
    testInplaceKeepCopy,
    testStaleUnlisted,
    testInplaceHook,
    testInplaceUninstall,
    testRejectedUpdate,
    testLocalOnlyListed,
    testHealth,
    testCheck,
    testAppRollback,
    testRollback,
    testPrivacyTool,
    testPrivacyOneBounce,
    testHooks,
    testRestoreDeactivate,
    testStockFiles,
    testRollbackRemoves,
    testUninstallAfterOldRollback,
    testRemoveWhenUnused,
    testPrivacyId8,
    testRestoreRefusals,
    testStaleFiles,
    testProvisioningSection,
    testDisabledCache,
    testLegacyCurrent,
    testBackupRetention,
    testLock,
    testFallbackOffPrivacy,
    testTransactions,
    testToken,
    testHuToken,
    testSourcePackages,
    testSetUpElsewhere,
    testThirdParty,
    testInternet,
    testCrashList,
    testServiceLimits,
    testSafeMode,
    testSafeModeAfresh,
    testBootLists,
    testListSafety,
    testDurableSwitch,
    testRecmgrOwned,
    testSourcesAndDonor,
    testMguInstall,
    testMguInstallTiles,
    testMguInstallCoding,
    testMguInstallUsb,
    testMguInstallFrom,
    testConnect,
    testMguInstallPaths,
    testUpdaterStateRestore,
    testTransport,
    testHuConnect,
    testRestoreAfterBootstrap,
    testRetiredDetect,
    testRetiredMigrate,
    testRetiredRollback,
    testRetiredEdges,
    testRetiredDrop,
    testRetiredRestoreGuard,
    testRetiredRollbackFails,
    testRetiredAppManagementOnly,
    testUnitDetect,
    testCompat,
    testHmiParts,
    testServices,
    testProvides,
    testDropins,
    testToolsAfterFirmware,
    testToolsAfterFirmwareSetup,
    testI7Takeover,
    testKeepRunning,
    testPostInstall,
    testId8Apps,
    testId8RejectedUpdate,
    testId8Inplace,
    testId8Guard,
    testId8Listing,
    testId8Unprovisioned,
    testFactoryReset,
    testId8LiveOn,
    testAppManager,
    testId8Complete,
    testRemoveAll,
    testRemoveAllAgain,
    testRemoveAllFirmware,
    testRestoreFirmwareGuard,
    testRemoveAllId8,
    testRemoveAllId8Failed,
    testRemoveAllId8Kept,
    testRemoveAllRunning,
    testMguInstallUninstall,
    testMguInstallStatus,
    testReadOnlyOnlyStatus,
    testMguInstallStop,
    testMguInstallClosed,
    testMguInstallUsbIcons
];
const ONLY = (process.env.MGU_TEST_ONLY || '').split(',').filter(Boolean);
let crashed = null;
try {
    SUITES.filter((f) => !ONLY.length || ONLY.indexOf(f.name) >= 0).forEach((f) => f());
} catch (e) {
    crashed = e;
}
inplaceChildren.forEach((child) => child.kill('SIGKILL'));
if (crashed) {
    failed += 1;
    console.log(`not ok ${n + 1} - the suite ran to the end\n  # ${crashed.stack}`);
}
const total = n + (crashed ? 1 : 0);
console.log(`${failed ? 'FAILED' : 'passed'}: ${total - failed} of ${total} ok`);
if (failed) {
    console.log(`fake roots kept for inspection in ${T}`);
} else {
    fs.rmSync(T, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
