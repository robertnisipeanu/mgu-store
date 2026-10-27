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
    write(p('etc/recmgr-restartlist.conf'), `[Whitelist]\n${listed}\n\n[WhitelistExitSuccess]\n${listed}\n\n[Other]\nkeepme\n`);
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
        MGU_DEPLOY_MAINAPP: p('usr/lib/oap-mainapp'),
        MGU_DEPLOY_MAINAPP21: p('usr/lib/oap-mainapp21'),
        MGU_DEPLOY_PROV: p('usr/share/tm/prov'),
        MGU_DEPLOY_VMINPUT: p('usr/bin/vminput'),
        MGU_DEPLOY_OAP: p('var/opt/public/oap'),
        MGU_DEPLOY_ETC: p('etc'),
        MGU_DEPLOY_PROC: p('proc'),
        MGU_DEPLOY_PROC_STAT: p('proc/stat'),
        MGU_DEPLOY_PROC_MOUNTS: p('proc/mounts'),
        MGU_DEPLOY_BOOT_ID: p('proc/boot_id'),
        MGU_DEPLOY_SYSTEMCTL: path.join(HERE, 'fake_systemctl.sh'),
        MGU_DEPLOY_JOURNALCTL: path.join(HERE, 'fake_journalctl.sh'),
        MGU_DEPLOY_PS: path.join(HERE, 'fake_ps.sh'),
        MGU_DEPLOY_KILL: path.join(HERE, 'fake_kill.sh'),
        MGU_DEPLOY_BOUNCE_MIN_UP_S: String(opts.minUp || 0),
        MGU_DEPLOY_BOUNCE_TIMEOUT_MS: '3000',
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
        a.uid === 13001 && a.tile_provisioned === true && a.tile_fallback === false && a.tile_visible === true &&
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

function readJsonOrNull(p) {
    try {
        return readJson(p);
    } catch (e) {
        return null;
    }
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
    const up = root.run(['install', '--artifact', appArtifact('fixture_app', '1.1.0', true), '--yes']);
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

    const cases = [
        ['a failed update', 'fail', () => appArtifact('fixture_app', '1.1.0', true), {},
            'the app manager failed the in-place update (FAKE_FAILURE)', 'update fixture_app 1.1.0 uid 13001'],
        ['a refused install', 'refuse', () => appArtifact('second_app', '1.0.0', true), {},
            'the app manager refused the in-place install (already registered)', 'install second_app 1.0.0 uid 13002'],
        ['a request not taken', 'deaf', () => appArtifact('second_app', '1.0.0', true), { MGU_DEPLOY_INPLACE_ACK_MS: '500' },
            'the app manager did not take the request within 1s', 'install second_app 1.0.0 uid 13002'],
        ['a manager that restarted during the install', 'respawn', () => appArtifact('second_app', '1.0.0', true), {},
            'the app manager restarted during the in-place install', 'install second_app 1.0.0 uid 13002']
    ];
    cases.forEach(([what, mode, artifact, extra, why, done]) => {
        const c = inplaceRoot(mode, { minUp: 1 });
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
        { MGU_DEPLOY_INPLACE_REPORT_MS: '1000' });
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
    check('self: the artifact holds its seven files and its manifest', JSON.stringify(tarList(builds[0].file)) === JSON.stringify([
        'component.json', 'files/fallback_build.js', 'files/mgu-app-fallback.service', 'files/mgu-deploy-apply.service',
        'files/mgu-deploy.js', 'files/mgu-deploy.sh',
        'files/oap_link.js', 'files/oap_pack.js']),
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
    ['mgu-deploy.js', 'mgu-deploy.sh', 'fallback_build.js', 'mgu-app-fallback.service', 'mgu-deploy-apply.service'].forEach((n) =>
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
    check('self: uninstall mgu-deploy is refused, exit 2', un.status === 2 && un.out.includes('does not uninstall itself') &&
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
    check('rollback: unit lists that differ are warned about, unit files unchanged',
        r.out.includes('unit files stay as 0.3.0 installed them') &&
        fs.existsSync(root.p('etc/systemd/system/fixture-tool.socket')), r.out);

    root.run(['install', '--artifact', appArtifact('fixture_app', '1.0.0', true), '--yes']);
    r = root.run(['rollback', 'fixture_app', '--yes']);
    check('rollback: an app is refused, exit 2', r.status === 2 && r.out.includes('uninstall it, then install the older artifact'), r.out);

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
 * status, logging each call to $FAKE_PRIVACY_LOG. */
function privacyTool(version, applyExit, revertExit) {
    const dir = path.join(fs.mkdtempSync(path.join(T, 'priv-')), 'app-privacy');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'component.json'), JSON.stringify({ id: 'app-privacy', kind: 'tool', version,
        files: [{ path: 'patch_mainapp.js', from: 'patch_mainapp.js', mode: '0755' }],
        units: [], enable: [], recmgr: [], restart: [] }, null, 2));
    fs.writeFileSync(path.join(dir, 'patch_mainapp.js'), `'use strict';
const cmd = process.argv[2];
require('fs').appendFileSync(process.env.FAKE_PRIVACY_LOG, '${version} ' + process.argv.slice(2).join(' ') + '\\n');
if (cmd === 'apply' && process.argv[3] !== '--main' && ${applyExit}) process.exit(${applyExit});
if (cmd === 'revert' && ${revertExit || 0}) process.exit(${revertExit || 0});
console.log(JSON.stringify({ state: cmd === 'revert' ? 'unpatched' : 'patched', changed: cmd !== 'check', restartNeeded: false }));
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
        JSON.stringify(plog(root).slice(n)) === JSON.stringify(['1.0.1 apply --json', '1.0.0 apply --json']) &&
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
        r.status === 2 && r.out.includes('app-privacy would lose its recmgr entries (app-privacy)') &&
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

function testTodoLines() {
    const root = fakeRoot();
    // display-bridge installs through this tool; status lists its notes
    write(root.p('var/opt/display-bridge/current/display-bridge.conf'), [
        '# "TODO(on-car)" marks values the bring-up (BRINGUP.md) must confirm.',
        '# The group apps connect with. TODO(on-car): confirm',
        '# (BRINGUP.md step 6).',
        'socket_group =',
        '# Touch range. TODO(on-car): step 8.3.',
        'touch_range = 0,0,4095,4095',
        'mode = "TODO(on-car) in a value is not a note"',
        ''].join('\n'));
    const st = root.status();
    check('status: each TODO(on-car) note in full, after its key, notes only',
        st.display_bridge_todo_on_car.length === 2 &&
        st.display_bridge_todo_on_car.includes('socket_group: TODO(on-car): confirm (BRINGUP.md step 6).') &&
        st.display_bridge_todo_on_car.includes('touch_range: TODO(on-car): step 8.3.') &&
        st.display_bridge_todo_on_car.every((l) => /^[a-z_]+: TODO\(on-car\)/.test(l)), JSON.stringify(st.display_bridge_todo_on_car));
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
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify([Object.assign(list()[0], { label: 'robert', login: 'someone' })]));
    r = runIn(['updater-token'], `${TOKEN}2\n`);
    const id2 = Object.keys(tokenTexts(root)).find((x) => x !== id);
    check('token: a second token beside the first, whose entry is kept', r.status === 0 && id2 && list().length === 2 &&
        list().find((t) => t.id === id).login === 'someone', JSON.stringify(list()));
    r = runIn(['updater-token', '--source', 'idrive7-apps'], TOKEN);
    check('token: no source is named (exit 2)', r.status === 2 && r.out.includes('no source'), r.out);
    r = runIn(['updater-token', '--list']);
    outputs.push(r.out);
    check('token: --list names id, label and account', r.status === 0 && r.out.includes(`${id}  robert  someone`) &&
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
        'component.json fallback_build.js mgu-app-fallback.service mgu-deploy-apply.service mgu-deploy.js mgu-deploy.sh oap_link.js oap_pack.js', staged);
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

const AM_STOCK = 'AppManagement stock\n';
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
    // the fake root binds nothing, so status reports these tiles as provisioned
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
    const i = bad.run(['install', '--artifact', appArtifact('old_app', '1.1.0', true), '--yes']);
    check('retired: backups that are not the stock bundle are reported and left; the install goes ahead alone',
        c.out.includes('(not the stock main.js)') && !c.out.includes('migrates them') && fm.status === 0 &&
        fm.out.includes("none of the retired installer's backups is a stock bundle") && i.status === 0 &&
        fs.existsSync(bad.src('main.js.capbak')) && bad.kills().length === kills0 + 1 &&
        !bad.snapshots().some((d) => d.endsWith('-migrate')), `${c.out}\n${i.out}`);

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
function sourceArtifact(version, extra) {
    const dir = fs.mkdtempSync(path.join(T, 'srcpkg-'));
    const m = Object.assign({ schema: 1, id: 'robertn_demo', version, tree: `robertn_demo@${version}`,
        modules: ['src/demo.js'], sdk: ['oap-sdk/src/core/OnlineApp.js'] }, extra);
    write(path.join(dir, 'mgu-app.json'), JSON.stringify(m));
    write(path.join(dir, 'src', 'demo.js'), "'use strict';\nconst { OnlineApp } = require('oap-sdk/src/core/OnlineApp.js');\nnew OnlineApp('demo');\n");
    write(path.join(dir, m.tree, 'package.json'), JSON.stringify({ name: m.id, version, files: ['javascript', 'package.json'] }));
    write(path.join(dir, m.tree, 'javascript', 'runner.js'), '// runner\n');
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
    const envFile = path.join(bin, 'env.json');
    if (root) {
        fs.writeFileSync(envFile, JSON.stringify(Object.assign({}, root.env, { PATH: `${bin}:${root.env.PATH}` })));
    }
    return { bin, envFile };
}

function mguInstall(args, opts) {
    const log = path.join(fs.mkdtempSync(path.join(T, 'ssh-')), 'log');
    fs.writeFileSync(log, '');
    const env = Object.assign({}, process.env, { PATH: `${opts.bin.bin}:${process.env.PATH}`, FAKE_SSH_LOG: log,
        FAKE_SSH_ENV: opts.bin.envFile, MGU_INSTALL_GITHUB_API: opts.api, FAKE_GH_TOKEN: '' }, opts.env || {});
    const r = cp.spawnSync(process.execPath, [MGU_INSTALL].concat(args), { encoding: 'utf8', env, input: opts.input || '' });
    r.out = `${r.stdout}${r.stderr}`;
    r.calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] !== '-V');
    return r;
}

/* first-install and token against a fake root, the release from the stand-in GitHub. */
function testMguInstall() {
    const gh = fakeGithub({ files: [], repos: {} });
    try {
        const rel = fakeRelease(gh.api);
        const config = { files: rel.files, repos: { [STORE_REPO]: { token: TOKEN, catalog: rel.catalogIndex } } };
        gh.set(config);
        const root = donorRoot();
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
        check('mgu-install first-install: ends saying a restart finishes setup while the updater is not running',
            r.stdout.endsWith('Restart the head unit to finish setup (a normal ignition cycle does it): the updater starts then.\n'), r.stdout.slice(-500));
        check('mgu-install first-install: the token is in no output and no ssh argument; it went on stdin to updater-token',
            !r.out.includes(TOKEN) && r.calls.every((a) => !a.join(' ').includes(TOKEN)) &&
            r.calls.some((a) => / updater-token( |$)/.test(a[a.length - 1])), r.calls.map((a) => a[a.length - 1]).join('\n'));
        const reqs = gh.requests();
        check('mgu-install first-install: anonymous first, then the token, to the API host only; never to the host a download redirects to',
            reqs[0].path === `/repos/${STORE_REPO}` && reqs[0].auth === null && reqs[1].auth === `Bearer ${TOKEN}` &&
            reqs.filter((x) => x.path.startsWith('/blob/')).length === 5 && reqs.filter((x) => x.path.startsWith('/blob/')).every((x) => x.auth === null),
            JSON.stringify(reqs));
        check('mgu-install first-install: ssh to the given host as root on port 22, with ssh-rsa allowed for the unit\'s sshd',
            r.calls.every((a) => a.includes('root@10.0.0.9') && a[0] === '-p' && a[1] === '22' && a.includes('HostKeyAlgorithms=+ssh-rsa')),
            JSON.stringify(r.calls[0]));
        check('mgu-install first-install: no remote command carries a double quote or a backslash (Windows passes them through its own quoting)',
            r.calls.every((a) => !/["\\]/.test(a[a.length - 1])), r.calls.map((a) => a[a.length - 1]).join('\n'));
        check('mgu-install first-install: leaves no staging folder', !fs.readdirSync(root.p('var/opt')).some((n) => /^mgu-deploy-kit-/.test(n)));
        // again, the updater running since the next start, the token from the GitHub CLI
        fs.writeFileSync(root.unitFile('mgu-updater.service.active'), 'active\n');
        gh.reset();
        r = mguInstall(['first-install', '--host', '10.0.0.9', '--no-uplink', '--no-renderer'], Object.assign({ env: { FAKE_GH_TOKEN: TOKEN } }, opts));
        check('mgu-install first-install again: changes nothing installed, and says setup is done', r.status === 0 &&
            r.out.includes('already installed') && !r.out.includes('built robertn_store') && r.out.includes('updater sources kept') &&
            r.stdout.endsWith('Setup is done: the Store installs and updates everything from here on.\n') &&
            gh.requests()[1].auth === `Bearer ${TOKEN}` && !r.calls.some((a) => / updater-token/.test(a[a.length - 1])), r.out.slice(-2000));
        r = mguInstall(['first-install', '--host', '10.0.0.9'], Object.assign({ env: { FAKE_GH_TOKEN: TOKEN } }, opts));
        check('mgu-install first-install: installs the renderer and the uplink by default, which start at the next start', r.status === 0 &&
            ['mgu-uplink', 'mgu-render'].every((id) => root.status().components.some((x) => x.id === id)) &&
            r.stdout.endsWith('Restart the head unit to finish setup (a normal ignition cycle does it): the renderer and the uplink start then.\n'),
            r.out.slice(-2000));
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
        check('mgu-install first-install: a private release without a token is refused before connecting', r.status === 1 &&
            r.stderr.includes('no access') && !r.calls.length, r.out);
        const bad = JSON.parse(fs.readFileSync(rel.files[rel.catalogIndex], 'utf8'));
        bad.components[1].artifact.sha256 = '0'.repeat(64);
        const badFile = path.join(rel.dir, 'bad-catalog.json');
        fs.writeFileSync(badFile, JSON.stringify(bad));
        gh.set(Object.assign({}, config, { files: rel.files.concat([badFile]), repos: { [STORE_REPO]: { token: TOKEN, catalog: rel.files.length } } }));
        r = mguInstall(['first-install', '--host', '10.0.0.9'], Object.assign({ env: { FAKE_GH_TOKEN: TOKEN } }, opts));
        check('mgu-install first-install: an artifact that does not match its catalog stops it before connecting', r.status === 1 &&
            r.stderr.includes('sha256 does not match') && !r.calls.length, r.out);
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
        check('mgu-install usb-repo: a published source\'s folder names the source it is a copy of; the updater reads it',
            marker('mgu-store') === `github:${STORE_REPO}` && marker('rel') === 'github:third/rel' && src('mgu-store').copyOf === `github:${STORE_REPO}` &&
            [marker('dir-publish'), marker('checkout'), marker('local')].every((m) => m === null), JSON.stringify([marker('mgu-store'), src('mgu-store').copyOf]));
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
    if (hmis) {
        entries.push({ name: `${pre}rhmiData/application.json`, mode: 0o644, data: Buffer.from(JSON.stringify({ application: {
            name, uiDescriptions: hmis.map((h) => ({ applicationFilePath: `./uiDescriptions/${h}/application.xml`, hmi: [h] })) } })) });
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
    opts = opts || {};
    const root = fakeRoot(opts);
    fs.renameSync(root.p('usr/lib/oap-mainapp'), root.p('usr/lib/oap-mainapp21'));
    for (let i = 0; i < 6; i += 1) {
        const n = `das_00${i}`;
        write(root.p(`usr/share/tm/prov/${n}.xml`), opts.prov ? fs.readFileSync(path.join(opts.prov, `${n}.xml`)) : dasText(n));
    }
    if (opts.noRecmgr) {
        fs.unlinkSync(root.p('etc/recmgr-restartlist.conf'));
    }
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

function testId8Apps() {
    const prov = process.env.MGU_TEST_ID8_PROV;
    [null].concat(prov ? [prov] : []).forEach((provDir) => {
        const tag = provDir ? 'id8 (real das files)' : 'id8';
        const root = id8Root({ prov: provDir });
        const das = () => [0, 1, 2, 3, 4, 5].map((i) => fs.readFileSync(root.p(`usr/share/tm/prov/das_00${i}.xml`), 'utf8'));
        const dasBefore = das();
        const art = rhmiApp('oap-cardash', '1.1.4', ['ID8'], { npm: true });
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
        const up = root.run(['install', '--artifact', rhmiApp('oap-cardash', '1.1.5', ['ID8'], { npm: true }), '--yes']);
        check(`${tag}: an update says the installed version and its data go first`, up.status === 0 &&
            up.out.includes('1.1.4 is uninstalled first, and its data with it'), up.out);
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
    const fb = root.run(['fallback', 'on', '--yes']);
    check('id8: the provisioning fallback is refused', fb.status === 2 && fb.out.includes('the provisioning fallback is for iDrive 7'), fb.out);
    const sys = root.run(['uninstall', 'x_call', '--yes']);
    check('id8: a system app is not removed', sys.status === 2, sys.out);
    const seven7 = fakeRoot().run(['apply-pending']);
    check('id8: apply-pending is refused on iDrive 7', seven7.status === 2 && seven7.out.includes('this head unit is iDrive 7'), seven7.out);
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
    check('appmanager: his queued install moves to our queue, his pending.json goes', !fs.existsSync(root.H('pending.json')) &&
        fs.readFileSync(root.p('var/opt/mgu-deploy/id8/queue/oap-driverecorder-next@1.0.8.tgz')).equals(fs.readFileSync(root.H('staged/oap-driverecorder-next@1.0.8.tgz'))) &&
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
    testRestore,
    testPrivacyRevert,
    testStatusJson,
    testFallback,
    testInplace,
    testInplaceHook,
    testInplaceUninstall,
    testLocalOnlyListed,
    testHealth,
    testRollback,
    testPrivacyTool,
    testRestoreRefusals,
    testStaleFiles,
    testProvisioningSection,
    testBackupRetention,
    testLock,
    testFallbackOffPrivacy,
    testTransactions,
    testTodoLines,
    testToken,
    testHuToken,
    testSourcePackages,
    testThirdParty,
    testInternet,
    testSourcesAndDonor,
    testMguInstall,
    testMguInstallUsb,
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
    testServices,
    testProvides,
    testDropins,
    testI7Takeover,
    testKeepRunning,
    testId8Apps,
    testAppManager
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
