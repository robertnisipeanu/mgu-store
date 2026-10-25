#!/usr/bin/env node
'use strict';
/**
 * Versions, builds and publishes everything the head unit installs and
 * updates from the catalog: each app with an apps/<id>/release.json, each
 * root tool with a native/<id>/component.json, and the deploy tool with
 * deploy/component.json. release/README.md describes
 * the versioning rules, the catalog and the publish target.
 *
 *   node release/release.js list                      components, versions, publish state
 *   node release/release.js build [<id>...]           reproducible build of HEAD into release/out/
 *   node release/release.js check [<id>...]           build twice, compare the artifacts
 *   node release/release.js bump <id> <version>       set a component's version
 *   node release/release.js publish [<id>...] [--dry-run]
 *                                                     upload new versions, then the catalog
 *
 * Builds run on a clean `git archive HEAD` export, never on the working tree,
 * with SOURCE_DATE_EPOCH set to the last commit that touched what the
 * component ships (an app's staged tree, a tool's folder): the same tree
 * always gives the same bytes, so one version has exactly one artifact.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const DEPLOY = path.join('deploy', 'hu');
const publishTarget = require('./publish');
const { compareVersions, SEMVER } = require('../native/mgu-updater/js/catalog.js');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isDir(p) {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function git(args, opts = {}) {
    return cp.execFileSync('git', args, Object.assign({ cwd: REPO, encoding: 'utf8' }, opts)).trim();
}

/* The release title of an app is the en_GB text of its first entry point. */
function appTitle(stagedDir) {
    const app = readJson(path.join(stagedDir, 'rhmiData', 'application.json')).application;
    const textId = app.entryPoints && app.entryPoints[0] && app.entryPoints[0].textId;
    const strings = path.join(stagedDir, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json');
    if (textId && fs.existsSync(strings)) {
        const text = readJson(strings)[textId];
        if (text) {
            return text;
        }
    }
    return app.name;
}

/* An app's id is also the name provisioning knows it by, and provisioning's
 * own section for an id wins over the fallback: our app ids carry this
 * prefix. */
const APP_ID_PREFIX = 'robertn_';

/* The catalog fields beyond schema 1 (release/README.md), from an app's
 * release.json or a tool's component.json. */
function catalogFields(from, where) {
    const out = {};
    if (from.requires !== undefined) {
        if (!from.requires || typeof from.requires !== 'object' ||
            !Object.keys(from.requires).every((id) => SEMVER.test(from.requires[id]))) {
            throw new Error(`${where}: "requires" maps component ids to x.y.z versions`);
        }
        out.requires = from.requires;
    }
    ['optional', 'uninstallable'].forEach((k) => {
        if (from[k] !== undefined && from[k] !== true) {
            throw new Error(`${where}: "${k}" is true or absent`);
        }
        if (from[k]) {
            out[k] = true;
        }
    });
    return out;
}

/* Every releasable component in a repo tree (the working tree or an export). */
function components(root = REPO) {
    const out = [];
    const apps = path.join(root, 'apps');
    fs.readdirSync(apps).sort().forEach((id) => {
        const dir = path.join(apps, id);
        const releaseFile = path.join(dir, 'release.json');
        if (!fs.existsSync(releaseFile)) {
            return;
        }
        const staged = fs.readdirSync(dir).filter((n) => n.startsWith(`${id}@`) && isDir(path.join(dir, n)));
        if (staged.length !== 1) {
            throw new Error(`apps/${id}: expected one staged tree ${id}@<version>/, found ${staged.length}`);
        }
        const version = staged[0].slice(id.length + 1);
        const stagedDir = path.join(dir, staged[0]);
        const pkg = readJson(path.join(stagedDir, 'package.json'));
        if (!SEMVER.test(version) || pkg.name !== id || pkg.version !== version) {
            throw new Error(`apps/${id}: ${staged[0]} holds package.json ${pkg.name}@${pkg.version}`);
        }
        // installers refuse an unmarked app (native/app-privacy/INTEGRATION.md)
        if (pkg.mguLocalOnly !== true) {
            throw new Error(`apps/${id}: ${staged[0]}/package.json lacks "mguLocalOnly": true`);
        }
        if (!id.startsWith(APP_ID_PREFIX)) {
            throw new Error(`apps/${id}: an app id starts with ${APP_ID_PREFIX} (release/README.md)`);
        }
        const release = readJson(releaseFile);
        // with mgu-app.json the artifact is the source package, built on the unit
        const manifestFile = path.join(dir, 'mgu-app.json');
        const manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : null;
        if (manifest && (manifest.id !== id || manifest.version !== version || manifest.tree !== staged[0])) {
            throw new Error(`apps/${id}/mgu-app.json names ${manifest.id}@${manifest.version} (tree ${manifest.tree}), not ${staged[0]}`);
        }
        out.push(Object.assign({
            id,
            kind: 'app',
            version,
            dir: `apps/${id}`,
            title: appTitle(stagedDir),
            description: pkg.description || '',
            release,
            build: manifest ? 'unit' : null,
            shipped: [`apps/${id}/${id}@${version}`].concat(manifest ?
                [`apps/${id}/mgu-app.json`].concat(manifest.modules.map((m) => `apps/${id}/${m}`)) : []),
            artifact: `apps/${id}/${id}@${version}${manifest ? '.src' : ''}.tgz`
        }, catalogFields(release, `apps/${id}/release.json`)));
    });
    const tool = (dir, id, shipped) => {
        const file = path.join(root, dir, 'component.json');
        if (!fs.existsSync(file)) {
            return;
        }
        const c = readJson(file);
        if (c.id !== id || c.kind !== 'tool' || !SEMVER.test(c.version || '')) {
            throw new Error(`${dir}/component.json: needs id "${id}", kind "tool" and a x.y.z version`);
        }
        out.push(Object.assign({
            id,
            kind: 'tool',
            version: c.version,
            dir,
            title: c.title || id,
            description: c.description || '',
            build: null,
            // source files that carry the version too, as VERSION = 'x.y.z'
            versionFiles: c.versionFiles || [],
            shipped,
            artifact: null
        }, catalogFields(c, `${dir}/component.json`)));
    };
    fs.readdirSync(path.join(root, 'native')).sort().forEach((id) => {
        const dir = `native/${id}`;
        tool(dir, id, [dir, `:(exclude,glob)${dir}/*.md`, `:(exclude)${dir}/test`]);
    });
    // The deploy tool: its artifact is deploy/unit/ and the linker and packer
    // under deploy/component.json (deploy/README.md, "The deploy tool as a tool").
    tool('deploy', 'mgu-deploy', ['deploy/unit', 'deploy/component.json', 'tools/oap_link.js', 'tools/oap_pack.js']);
    return out;
}

function select(all, ids) {
    if (!ids.length) {
        return all;
    }
    return ids.map((id) => {
        const c = all.find((x) => x.id === id);
        if (!c) {
            throw new Error(`no component "${id}" (have: ${all.map((x) => x.id).join(', ')})`);
        }
        return c;
    });
}

/* Commit time of the last commit that touched what the component ships: an
 * app's staged tree, a tool's folder without its tests and notes. A change
 * outside that gives the same bytes; one inside it changes them, and
 * publishing then asks for a new version. */
function sourceEpoch(c) {
    return git(['log', '-1', '--format=%ct', 'HEAD', '--'].concat(c.shipped));
}

function exportHead() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-release-'));
    const tar = cp.spawnSync('sh', ['-c', 'git archive HEAD | tar -x -C "$1"', 'sh', dir], { cwd: REPO, stdio: 'inherit' });
    if (tar.status !== 0) {
        throw new Error('git archive HEAD failed');
    }
    return dir;
}

function buildOne(c, exportDir) {
    // A private TMPDIR: app harnesses keep scratch files there by uid, which
    // concurrent builds and harness runs would otherwise share. Short, as
    // harnesses put Unix sockets in it (104 bytes on macOS).
    const tmp = fs.mkdtempSync('/tmp/mgu-rel-');
    const env = Object.assign({}, process.env, { SOURCE_DATE_EPOCH: sourceEpoch(c), TMPDIR: tmp });
    // a release build is the source package alone, whatever donor the machine has
    delete env.MGU_SDK_DONOR;
    try {
        return buildIn(c, exportDir, env);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function buildIn(c, exportDir, env) {
    let artifact;
    if (c.kind === 'app') {
        const r = cp.spawnSync(c.release.build, { cwd: path.join(exportDir, c.dir), env, shell: true,
            stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
        if (r.status !== 0) {
            process.stderr.write(String(r.stdout).slice(-4000) + String(r.stderr).slice(-4000));
            throw new Error(`${c.id}: build "${c.release.build}" failed (${r.error ? r.error.message : r.signal || `exit ${r.status}`})`);
        }
        artifact = path.join(exportDir, c.artifact);
    } else {
        // Tools are packed by the deploy tool, so a release artifact and a
        // kit's artifact are the same bytes.
        const tool = path.join(exportDir, DEPLOY);
        if (!fs.existsSync(tool)) {
            throw new Error(`${c.id}: ${DEPLOY} is not in HEAD; it packs tool artifacts`);
        }
        const r = cp.spawnSync(tool, ['artifact', c.dir, '--out', path.join(exportDir, 'release-out')],
            { cwd: exportDir, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
        if (r.status !== 0) {
            process.stderr.write(String(r.stdout).slice(-4000) + String(r.stderr).slice(-4000));
            throw new Error(`${c.id}: ${DEPLOY} artifact ${c.dir} failed`);
        }
        artifact = path.join(exportDir, 'release-out', `${c.id}@${c.version}.tgz`);
    }
    if (!fs.existsSync(artifact)) {
        throw new Error(`${c.id}: the build did not produce ${path.relative(exportDir, artifact)}`);
    }
    return artifact;
}

/* A catalog entry (schema 2): the artifact is always <id>@<version>.tgz;
 * "build": "unit" marks a source package. */
function catalogEntry(c, file) {
    const entry = {
        id: c.id,
        kind: c.kind,
        title: c.title,
        description: c.description,
        version: c.version,
        artifact: { name: path.basename(file), size: fs.statSync(file).size, sha256: sha256(file) }
    };
    if (c.build) {
        entry.build = c.build;
    }
    ['requires', 'optional', 'uninstallable'].forEach((k) => {
        if (c[k] !== undefined) {
            entry[k] = c[k];
        }
    });
    return entry;
}

/* Builds the selected components of HEAD into outDir; returns their catalog
 * entries. With `failed` (an array), a component that does not build is
 * recorded there and the others are built. */
function build(ids, outDir, failed) {
    const exportDir = exportHead();
    let ok = false;
    try {
        const list = select(components(exportDir), ids);
        fs.mkdirSync(outDir, { recursive: true });
        const entries = [];
        list.forEach((c) => {
            process.stdout.write(`building ${c.id}@${c.version} ... `);
            let file;
            try {
                file = buildOne(c, exportDir);
            } catch (e) {
                if (!failed) {
                    throw e;
                }
                console.log('failed');
                failed.push(`${c.id}@${c.version} does not build: ${e.message}`);
                return;
            }
            const dest = path.join(outDir, `${c.id}@${c.version}.tgz`);
            fs.copyFileSync(file, dest);
            const entry = catalogEntry(c, dest);
            console.log(`${entry.artifact.sha256.slice(0, 12)} ${entry.artifact.size} bytes`);
            entries.push(entry);
        });
        ok = !failed || !failed.length;
        return entries;
    } finally {
        if (ok) {
            fs.rmSync(exportDir, { recursive: true, force: true });
        } else {
            console.error(`the build tree is kept for inspection: ${exportDir}`);
        }
    }
}

function writeCatalog(entries, dir) {
    const catalog = {
        schema: 2,
        commit: git(['rev-parse', 'HEAD']),
        components: entries.slice().sort((a, b) => a.id.localeCompare(b.id))
    };
    const file = path.join(dir, 'catalog.json');
    fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
    return file;
}

function warnDirty() {
    if (git(['status', '--porcelain', '--untracked-files=no'])) {
        console.log('note: uncommitted changes are not built; builds use HEAD');
    }
}

function cmdList() {
    const published = publishTarget.published();
    const byId = new Map((published ? published.components : []).map((e) => [e.id, e]));
    const rows = components().map((c) => {
        const p = byId.get(c.id);
        let state = 'not published';
        if (p) {
            const cmp = compareVersions(c.version, p.version);
            state = cmp === 0 ? 'published' : cmp > 0 ? `newer than published ${p.version}` : `OLDER than published ${p.version}`;
        }
        return [c.id, c.kind, c.version, state, c.title];
    });
    const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)));
    rows.forEach((r) => console.log(r.map((v, i) => (i < 4 ? v.padEnd(widths[i]) : v)).join('  ')));
    if (!published) {
        console.log(`(no published catalog at ${publishTarget.describe()})`);
    }
}

function cmdBuild(ids) {
    warnDirty();
    const entries = build(ids, OUT);
    console.log(`wrote ${path.relative(REPO, writeCatalog(entries, OUT))}`);
}

function cmdCheck(ids) {
    warnDirty();
    const a = build(ids, fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-check-a-')));
    const b = build(ids, fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-check-b-')));
    let ok = true;
    a.forEach((e, i) => {
        const same = e.artifact.sha256 === b[i].artifact.sha256;
        ok = ok && same;
        console.log(`${same ? 'reproducible' : 'DIFFERS'}  ${e.id}@${e.version}`);
    });
    if (!ok) {
        process.exitCode = 1;
    }
}

/* Text files that name an app's staged tree by <id>@<version>. Historical
 * investigation notes keep the version they describe. */
function filesNaming(token) {
    let out = '';
    try {
        out = git(['grep', '-l', '-F', token]);
    } catch (e) {
        return [];
    }
    return out.split('\n').filter((f) => f && !f.startsWith('docs/investigations/') &&
        !f.endsWith('/javascript/app.js'));
}

function moveLeftovers(from, to) {
    if (!fs.existsSync(from)) {
        return;
    }
    fs.readdirSync(from).forEach((name) => {
        const src = path.join(from, name);
        const dest = path.join(to, name);
        if (fs.existsSync(dest) && isDir(src)) {
            moveLeftovers(src, dest);
        } else {
            fs.renameSync(src, dest);
        }
    });
    fs.rmdirSync(from);
}

function cmdBump(id, version) {
    if (!SEMVER.test(version || '')) {
        throw new Error('usage: bump <id> <x.y.z>');
    }
    const c = components().find((x) => x.id === id);
    if (!c) {
        throw new Error(`no component "${id}"`);
    }
    if (compareVersions(version, c.version) <= 0) {
        throw new Error(`${id} is at ${c.version}; the new version must be higher`);
    }
    if (c.kind === 'tool') {
        const edits = [['component.json', `"version": "${c.version}"`, `"version": "${version}"`]]
            .concat(c.versionFiles.map((rel) => [rel, `VERSION = '${c.version}'`, `VERSION = '${version}'`]));
        // every file names the old version once, or none is written
        const texts = edits.map(([rel, from]) => {
            const text = fs.readFileSync(path.join(REPO, c.dir, rel), 'utf8');
            if (text.split(from).length !== 2) {
                throw new Error(`${c.dir}/${rel}: expected ${from} once`);
            }
            return text;
        });
        edits.forEach(([rel, from, to], i) => {
            fs.writeFileSync(path.join(REPO, c.dir, rel), texts[i].replace(from, to));
            console.log(`${c.dir}/${rel}: ${c.version} -> ${version}`);
        });
        return;
    }
    const oldToken = `${id}@${c.version}`;
    const newToken = `${id}@${version}`;
    const files = filesNaming(oldToken);
    git(['mv', path.join(c.dir, oldToken), path.join(c.dir, newToken)]);
    // untracked files move along
    moveLeftovers(path.join(REPO, c.dir, oldToken), path.join(REPO, c.dir, newToken));
    files.forEach((f) => {
        const p = path.join(REPO, f.split(oldToken).join(newToken));
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split(oldToken).join(newToken));
    });
    // The version fields inside the staged tree; build.json is rewritten by the build.
    const staged = path.join(REPO, c.dir, newToken);
    const manifest = path.join(REPO, c.dir, 'mgu-app.json');
    if (fs.existsSync(manifest)) {
        const j = readJson(manifest);
        j.version = version;
        fs.writeFileSync(manifest, JSON.stringify(j, null, 2) + '\n');
    }
    [['package.json', (j) => { j.version = version; }],
        ['npm-shrinkwrap.json', (j) => { j.version = version; }],
        [path.join('rhmiData', 'application.json'), (j) => { j.application.version = version; }]
    ].forEach(([rel, edit]) => {
        const p = path.join(staged, rel);
        if (fs.existsSync(p)) {
            const j = readJson(p);
            edit(j);
            fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
        }
    });
    console.log(`${oldToken} -> ${newToken}: renamed the staged tree, updated ${files.length} files`);
    console.log(`next: add a ${version} entry to ${c.dir}/${newToken}/CHANGELOG.md, rebuild (${c.release.build}), commit`);
}

function cmdPublish(ids, dryRun) {
    if (git(['status', '--porcelain', '--untracked-files=no'])) {
        throw new Error('commit first: publish builds HEAD and records its commit in the catalog');
    }
    // before anything is built or uploaded: the target is private and
    // publishing to it runs in GitHub Actions
    publishTarget.preflight(dryRun);
    const published = publishTarget.published() || { components: [] };
    // a run from a commit older than the published catalog's (a re-run of an
    // old tag) would take back what later commits published
    if (published.commit && cp.spawnSync('git', ['merge-base', '--is-ancestor', published.commit, 'HEAD'],
        { cwd: REPO }).status !== 0) {
        throw new Error(`HEAD does not contain ${published.commit}, the published catalog's commit: ` +
            'publish from that commit or a later one');
    }
    const current = new Map(published.components.map((e) => [e.id, e]));
    // the catalog lists what the repository has: a component removed from it
    // (or renamed) leaves the catalog too
    const inRepo = new Set(components().map((c) => c.id));
    const removed = [...current.keys()].filter((id) => !inRepo.has(id));
    removed.forEach((id) => current.delete(id));
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-publish-'));
    const skipped = [];
    const built = build(ids, staging, skipped);
    const uploads = [];
    built.forEach((e) => {
        const p = current.get(e.id);
        if (p && p.version === e.version && p.artifact.sha256 !== e.artifact.sha256) {
            skipped.push(`${e.id}@${e.version} is published with other content: bump its version to publish it`);
        } else if (p && compareVersions(e.version, p.version) < 0) {
            skipped.push(`${e.id}@${e.version} is older than the published ${p.version}`);
        } else if (!p || p.version !== e.version) {
            uploads.push(e);
        }
    });
    skipped.forEach((m) => console.log(`skipped: ${m}`));
    if (skipped.length) {
        process.exitCode = 1;
    }
    if (!uploads.length && !removed.length) {
        console.log('nothing new to publish');
        return;
    }
    removed.forEach((id) => console.log(`${dryRun ? 'would remove' : 'removing'} ${id}: not in the repository`));
    uploads.forEach((e) => console.log(`${dryRun ? 'would publish' : 'publishing'} ${e.id}@${e.version}`));
    if (dryRun) {
        return;
    }
    uploads.forEach((e) => {
        e.artifact.url = publishTarget.uploadArtifact(e, path.join(staging, e.artifact.name));
        current.set(e.id, e);
    });
    const catalogFile = writeCatalog([...current.values()], staging);
    publishTarget.uploadCatalog(catalogFile);
    console.log(`catalog published to ${publishTarget.describe()}`);
}

function main(argv) {
    const [cmd, ...rest] = argv;
    const flags = rest.filter((a) => a.startsWith('--'));
    const args = rest.filter((a) => !a.startsWith('--'));
    switch (cmd) {
    case 'list': return cmdList();
    case 'build': return cmdBuild(args);
    case 'check': return cmdCheck(args);
    case 'bump': return cmdBump(args[0], args[1]);
    case 'publish': return cmdPublish(args, flags.includes('--dry-run'));
    default:
        process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(2, 14)
            .map((l) => l.replace(/^ \* ?/, '')).join('\n') + '\n');
        process.exitCode = cmd ? 2 : 0;
    }
    return undefined;
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        console.error(`release: ${e.message}`);
        process.exitCode = 1;
    }
}

module.exports = { components, compareVersions };
