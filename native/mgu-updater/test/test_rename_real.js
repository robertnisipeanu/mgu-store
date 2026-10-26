'use strict';
/**
 * idrive7-apps' own kit/tools/build.py building one of its apps under
 * another id, from the files sources.js renameApp makes over to it, on this
 * machine's python3:
 *
 *   node test/test_rename_real.js <idrive7-apps clone> [<app>...]
 *
 * Each app (car_vitals without one named; doom downloads its WAD) is built
 * as <app>2 and its package checked: the package, RHMI and settings names,
 * the UUIDs build.py derives from the id (uuid5 in its namespace) and none
 * derived from the app's own id. Without a clone it passes, saying so.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const sourcesLib = require('../js/sources');
const tar = require('../js/tar');

const clone = process.argv[2] || process.env.IDRIVE7_APPS;
const apps = process.argv.slice(3).length ? process.argv.slice(3) : ['car_vitals'];
// build.py's NS
const NS = Buffer.from('6b1d3a528f0e4c4b9a770d0c4d4e5f10', 'hex');
let failures = 0;

function ok(name, cond, detail) {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : `: ${detail}`}`);
    failures += cond ? 0 : 1;
}

/* Python's uuid.uuid5(NS, name). */
function uuid5(name) {
    const h = crypto.createHash('sha1').update(NS).update(name, 'utf8').digest();
    h[6] = (h[6] & 0x0f) | 0x50;
    h[8] = (h[8] & 0x3f) | 0x80;
    const x = h.slice(0, 16).toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/* The clone's files as the updater hands a build its repo. */
function files(root) {
    const out = [];
    (function walk(rel) {
        fs.readdirSync(path.join(root, rel)).forEach((n) => {
            const r = rel ? `${rel}/${n}` : n;
            if (['.git', 'dist', 'node_modules', '__pycache__', 'oap-sdk'].indexOf(n) >= 0) {
                return;
            }
            const st = fs.lstatSync(path.join(root, r));
            if (st.isDirectory()) {
                walk(r);
            } else if (st.isFile()) {
                out.push({ name: r, data: fs.readFileSync(path.join(root, r)), mode: st.mode & 0o777 });
            }
        });
    }(''));
    return out;
}

function main() {
    if (!clone || !fs.existsSync(path.join(clone, 'kit', 'tools', 'build.py'))) {
        console.log('SKIP no idrive7-apps clone named');
        return Promise.resolve();
    }
    const repo = files(clone);
    const read = (rel) => {
        const f = repo.find((x) => x.name === rel);
        return f ? Promise.resolve(f.data) : Promise.reject(Object.assign(new Error(`${rel} missing`), { missing: true }));
    };
    const list = (rel) => Promise.resolve(fs.readdirSync(path.join(clone, rel)).filter((n) => fs.statSync(path.join(clone, rel, n)).isDirectory()));
    return sourcesLib.repoCatalog(read, null, null, list).then((cat) => apps.reduce((p, id) => p.then(() => {
        const own = cat.components.find((c) => c.id === id);
        const to = `${id}2`;
        ok(`${id}: listed by its mgu-repo.json as an app that can be built under another id`, !!own && sourcesLib.renameable(own));
        const made = sourcesLib.renameApp(own, repo, to);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idrive7-rename-'));
        made.files.forEach((f) => {
            fs.mkdirSync(path.dirname(path.join(dir, f.name)), { recursive: true });
            fs.writeFileSync(path.join(dir, f.name), f.data, { mode: f.mode });
        });
        // the oap-sdk module the deploy tool hands a build with "sdk"
        fs.mkdirSync(path.join(dir, made.entry.script.sdk), { recursive: true });
        fs.writeFileSync(path.join(dir, made.entry.script.sdk, 'index.js'), '// oap-sdk\n');
        fs.writeFileSync(path.join(dir, made.entry.script.sdk, 'package.json'), '{"name":"oap-sdk","version":"0.0.0"}\n');
        const run = cp.spawnSync('python3', [made.entry.script.python].concat(made.entry.script.args), { cwd: dir, encoding: 'utf8' });
        ok(`${id} as ${to}: build.py ${made.entry.script.args.join(' ')} builds it`, run.status === 0, run.stdout + run.stderr);
        if (run.status !== 0) {
            return null;
        }
        return tar.untgz(fs.readFileSync(path.join(dir, made.entry.script.output)), 512 << 20).then((members) => {
            const at = (n) => (members.find((m) => m.name === `package/${n}`) || {}).data;
            const pkg = JSON.parse(at('package.json'));
            const app = JSON.parse(at('rhmiData/application.json')).application;
            const ep = app.entryPoints[0];
            const sid = `SID_${to.toUpperCase()}_TITLE`;
            const strings = JSON.parse(at('rhmiData/variantGroups/Common/texts/en_GB.json'));
            const spec = JSON.parse(at('javascript/kit/app-spec.json'));
            const base = JSON.parse(at('config/base.json'));
            ok(`${to}: package name, RHMI name, entry point, text id, icon, kit spec and settings key are ${to}`,
                pkg.name === to && app.name === to && ep.name === `${to.toUpperCase()}_ENTRY` && ep.textId === sid &&
                ep.icon === `${to}_icon.png` && typeof strings[sid] === 'string' && spec.id === to &&
                Object.keys(base.settings).join() === to && !!at(`rhmiData/variantGroups/Common/images/${to}_icon.png`),
                JSON.stringify([pkg.name, app.name, ep, spec.id, base]));
            ok(`${to}: its UUIDs are build.py's for ${to}`, app.uuid === uuid5(`${to}:app`) && ep.uuid === uuid5(`${to}:entry`) &&
                app.stringBundleUuid === uuid5(`${to}:strings`) && app.resourceBundleUuid === uuid5(`${to}:resources`),
                JSON.stringify(app));
            const text = members.filter((m) => /\.(json|js|xml)$/.test(m.name)).map((m) => m.data.toString('utf8')).join('\n');
            const theirs = ['app', 'entry', 'strings', 'resources', 'ep-strings', 'ep-resources', 'ed-strings', 'bookmarks'].map((w) => uuid5(`${id}:${w}`));
            ok(`${to}: none of ${id}'s UUIDs or names left`, theirs.every((u) => text.indexOf(u) < 0) &&
                text.indexOf(`SID_${id.toUpperCase()}_`) < 0 && text.indexOf(`"${id}"`) < 0, theirs.filter((u) => text.indexOf(u) >= 0).join());
            ok(`${to}: built from apps/${to}/app.json, apps/${id} beside it as it was`, made.entry.path === `apps/${to}` &&
                JSON.parse(fs.readFileSync(path.join(dir, 'apps', to, 'app.json'), 'utf8')).id === to &&
                fs.readFileSync(path.join(dir, 'apps', id, 'app.json'), 'utf8') === fs.readFileSync(path.join(clone, 'apps', id, 'app.json'), 'utf8'));
            cp.execFileSync('rm', ['-rf', dir]);
        });
    }), Promise.resolve()));
}

main().then(() => {
    console.log(failures ? `${failures} failed` : 'all passed');
    process.exit(failures ? 1 : 0);
}, (err) => {
    console.log(`FAIL ${err.stack}`);
    process.exit(1);
});
