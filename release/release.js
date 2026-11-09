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
 *   node release/release.js versions <base>           a pull request's checks against its base commit
 *   node release/release.js stamp [<id>...]           next versions into the tree, the release commit
 *   node release/release.js publish [<id>...|--stamped] [--dry-run]
 *                                                     upload new versions, then the catalog
 *
 * A component in GATED publishes a new version to GitHub only when its
 * source commit has a successful commit status release-check/<id>.
 *
 * Builds run on a clean `git archive HEAD` export, never on the working tree,
 * with SOURCE_DATE_EPOCH set to the last commit that touched what the
 * component ships (an app's staged tree, a tool's folder): the same tree
 * always gives the same bytes, so one version has exactly one artifact.
 *
 * Every component's version is set by the release: `stamp` gives each one
 * changed since its last release (its <id>@<version> tag), or named, the
 * next version, writes it into the tree with the CHANGELOG's Unreleased
 * section under it and each "requires" of "next" resolved, and commits
 * that. A pull request's labels release:minor and release:major raise the
 * step from a patch.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
// what draws an app's picture: published only with a passing release-check/<id> status on its source
const GATED = ['mgu-render', 'robertn_store'];
// an app's staged tree (mgu-app.json "tree"); the build names it <id>@<version> (stageTree)
const APP_TREE = 'package';
const DEPLOY = path.join('deploy', 'hu');
const publishTarget = require('./publish');
const { compareVersions, hmiList, textsOf, SEMVER } = require('../native/mgu-updater/js/catalog.js');

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

/* "requires" may name this repository's component at "next": the version it
 * has after the next release, which `stamp` writes in. */
const NEXT = 'next';

/* The catalog fields beyond schema 1 (release/README.md), from an app's
 * release.json or a tool's component.json. */
function catalogFields(from, where) {
    const out = {};
    if (from.requires !== undefined) {
        if (!from.requires || typeof from.requires !== 'object' || Array.isArray(from.requires) ||
            !Object.keys(from.requires).every((id) => SEMVER.test(from.requires[id]) || from.requires[id] === NEXT)) {
            throw new Error(`${where}: "requires" maps component ids to x.y.z versions or "${NEXT}"`);
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
    if (from.mguHmi !== undefined) {
        try {
            if (from.mguHmi === null) {
                throw new Error('mguHmi must list "ID7" and/or "ID8"');
            }
            out.mguHmi = hmiList(from.mguHmi);
        } catch (e) {
            throw new Error(`${where}: ${e.message}`);
        }
    }
    if (from.mguProvides !== undefined) {
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(from.mguProvides)) {
            throw new Error(`${where}: "mguProvides" is one lower-case name`);
        }
        out.mguProvides = from.mguProvides;
    }
    return out;
}

/* The HMIs an app's staged rhmiData has a UI for (application.json's
 * uiDescriptions[].hmi), or undefined. */
function rhmiHmi(stagedDir) {
    const app = readJson(path.join(stagedDir, 'rhmiData', 'application.json')).application;
    const out = [];
    (app.uiDescriptions || []).forEach((u) => (u.hmi || []).forEach((h) => {
        if (['ID7', 'ID8'].indexOf(h) >= 0 && out.indexOf(h) < 0) {
            out.push(h);
        }
    }));
    return out.length ? out.sort() : undefined;
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
        // with mgu-app.json the artifact is the source package, built on the unit
        const manifestFile = path.join(dir, 'mgu-app.json');
        const manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : null;
        const tree = manifest ? manifest.tree : APP_TREE;
        if (typeof tree !== 'string' || !/^[A-Za-z0-9._@-]+$/.test(tree) || !isDir(path.join(dir, tree))) {
            throw new Error(`apps/${id}: no staged tree (mgu-app.json "tree", or ${APP_TREE}/)`);
        }
        const stagedDir = path.join(dir, tree);
        const pkg = readJson(path.join(stagedDir, 'package.json'));
        const version = pkg.version;
        if (!SEMVER.test(version || '') || pkg.name !== id) {
            throw new Error(`apps/${id}: ${tree}/package.json is ${pkg.name}@${pkg.version}, not ${id}@<x.y.z>`);
        }
        // installers refuse an unmarked app (native/app-privacy/INTEGRATION.md)
        if (pkg.mguLocalOnly !== true) {
            throw new Error(`apps/${id}: ${tree}/package.json lacks "mguLocalOnly": true`);
        }
        if (!id.startsWith(APP_ID_PREFIX)) {
            throw new Error(`apps/${id}: an app id starts with ${APP_ID_PREFIX} (release/README.md)`);
        }
        const release = readJson(releaseFile);
        if (manifest && (manifest.id !== id || manifest.version !== version)) {
            throw new Error(`apps/${id}/mgu-app.json names ${manifest.id}@${manifest.version}, not ${id}@${version} as ${tree}/package.json`);
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
            tree,
            manifest: !!manifest,
            changelog: `apps/${id}/${tree}/CHANGELOG.md`,
            shipped: [`apps/${id}/${tree}`].concat(manifest ?
                [`apps/${id}/mgu-app.json`].concat(manifest.modules.map((m) => `apps/${id}/${m}`)) : []),
            artifact: `apps/${id}/${id}@${version}${manifest ? '.src' : ''}.tgz`
        }, catalogFields(Object.assign({ mguHmi: rhmiHmi(stagedDir) }, release), `apps/${id}/release.json`)));
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
            changelog: `${dir}/CHANGELOG.md`,
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
    const texts = catalogTexts(out.map((c) => c.id), root);
    out.forEach((c) => {
        if (texts[c.id]) {
            c.texts = texts[c.id];
        }
        Object.keys(c.requires || {}).forEach((id) => {
            if (c.requires[id] === NEXT && !out.some((x) => x.id === id)) {
                throw new Error(`${c.dir}: requires ${id}: "${NEXT}" names a component of this repository only`);
            }
        });
    });
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

/* The last commit that touched what the component ships, and for a tool its
 * packer: its source, as the release check tested it. A merge commit that
 * brings the change in unaltered keeps it (history simplification follows the
 * parent it came from). An app's build may write files it ships (copies, generated
 * files) only as they are committed (buildIn), so what it ships is that
 * commit's. A release commit that only wrote the component's version and
 * resolved its "requires" (stamp) is passed over: the check tests what the
 * component does, built at the version it would get. */
function sourceCommit(c, repo = REPO) {
    const paths = c.shipped.concat(c.kind === 'tool' ? ['deploy/hu', 'tools/oap_pack.js'] : []);
    const commits = git(['log', '--format=%H', 'HEAD', '--'].concat(paths), { cwd: repo }).split('\n').filter(Boolean);
    return commits.find((sha) => !stampOnly(c, sha, paths, repo)) || '';
}

/* The files that carry c's version, from the repository root, each with what
 * names it there: [rel, text or pattern] (writeVersion). */
function versionFilesOf(c) {
    if (c.kind === 'tool') {
        return [[`${c.dir}/component.json`, `"version": "${c.version}"`]]
            .concat((c.versionFiles || []).map((f) => [`${c.dir}/${f}`, `VERSION = '${c.version}'`]));
    }
    return (c.manifest ? [[`${c.dir}/mgu-app.json`, /("version": )"\d+\.\d+\.\d+"/]] : [])
        .concat(APP_VERSION_FILES.map(([rel, field]) => [`${c.dir}/${c.tree}/${rel}`, field]));
}

/* Whether a commit is a release commit that changes nothing of what c ships
 * but its version (versionFilesOf: "version", VERSION) and a "requires" of
 * "next" turned into a version, each changed line the line before with only
 * those values replaced, and a shipped CHANGELOG's Unreleased lines put under
 * that version (releaseChangelog). */
function stampOnly(c, sha, paths, repo) {
    const [subject, parents] = git(['show', '-s', '--format=%s%n%P', sha], { cwd: repo }).split('\n');
    if (!subject.startsWith('release: ') || parents.split(' ').length !== 1) {
        return false;
    }
    const files = versionFilesOf(c).map(([rel]) => rel);
    const log = c.changelog;
    const at = (rev, rel) => {
        const r = cp.spawnSync('git', ['show', `${rev}:${rel}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
        return r.status === 0 ? r.stdout : null;
    };
    if (log && paths.some((p) => log === p || log.startsWith(`${p}/`))) {
        const was = at(`${sha}^`, log);
        const now = at(sha, log);
        if (was !== now) {
            const version = /^## Unreleased\n\n## (\d+\.\d+\.\d+)\n/m.exec(now || '');
            if (!version || (releaseChangelog(was || '', version[1]) !== now && sameContentChangelog(was || '', version[1]) !== now)) {
                return false;
            }
        }
        paths = paths.concat([`:(exclude)${log}`]);
    }
    const VALUE = /("(?:next|\d+\.\d+\.\d+)"|'\d+\.\d+\.\d+')/;
    const same = (was, now) => {
        const a = was.split(VALUE);
        const b = now.split(VALUE);
        const version = /"version"\s*:|\bVERSION = /.test(was);
        return a.length === b.length && a.every((part, i) => part === b[i] ||
            (i % 2 === 1 && (version || (part === `"${NEXT}"` && /^"\d/.test(b[i])))));
    };
    let removed = [];
    let added = [];
    const hunkOk = () => removed.length === added.length && removed.every((l, i) => same(l, added[i]));
    const lines = git(['diff', '-U0', '--no-renames', `${sha}^`, sha, '--'].concat(paths), { cwd: repo }).split('\n');
    for (const l of lines) {
        if (/^(diff --git |index |--- a\/|\\ )/.test(l) || l === '') {
            continue;
        }
        if (l.startsWith('+++ ') || l.startsWith('@@ ')) {
            if (!hunkOk() || (l.startsWith('+++ ') && !files.includes(l.slice('+++ b/'.length)))) {
                return false;
            }
            removed = [];
            added = [];
        } else if (l[0] === '-') {
            removed.push(l.slice(1));
        } else if (l[0] === '+') {
            added.push(l.slice(1));
        } else {
            return false;
        }
    }
    return hunkOk();
}

/* Why a gated component's version may not be published: its source commit
 * has no successful release-check/<id> status. null: it may. status: the
 * newest release-check/<id> status of the source commit, or null. The
 * status names the source; the release picks the version. */
function gateProblem(c, status, source) {
    if (!GATED.includes(c.id)) {
        return null;
    }
    const where = `${c.id}@${c.version}: release-check/${c.id} on ${String(source).slice(0, 12)}`;
    if (!status) {
        return `${where} is missing`;
    }
    if (status.state !== 'success') {
        return `${where} is ${status.state}`;
    }
    return null;
}

/* A commit's tree (HEAD's) in a new folder. */
function exportHead(commit = 'HEAD') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-release-'));
    const tar = cp.spawnSync('sh', ['-c', 'git archive "$2" | tar -x -C "$1"', 'sh', dir, commit], { cwd: REPO, stdio: 'inherit' });
    if (tar.status !== 0) {
        throw new Error(`git archive ${commit} failed`);
    }
    return dir;
}

/* An app's staged tree in the build export, named <id>@<version> as the
 * package carries it (mgu-app.json "tree" too). */
function stageTree(c, exportDir) {
    const staged = `${c.id}@${c.version}`;
    if (c.tree === staged) {
        return;
    }
    fs.renameSync(path.join(exportDir, c.dir, c.tree), path.join(exportDir, c.dir, staged));
    if (c.manifest) {
        const file = path.join(exportDir, c.dir, 'mgu-app.json');
        const m = readJson(file);
        m.tree = staged;
        fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
    }
}

/* An app's shipped files in the build export (its staged tree named as the
 * package carries it), by path: their sha256. */
function shippedFiles(c, exportDir) {
    const out = new Map();
    const walk = (rel) => {
        const p = path.join(exportDir, rel);
        if (!fs.existsSync(p)) {
            return;
        }
        if (isDir(p)) {
            fs.readdirSync(p).forEach((n) => walk(`${rel}/${n}`));
        } else {
            out.set(rel, sha256(p));
        }
    };
    c.shipped.map((rel) => rel.replace(`${c.dir}/${c.tree}`, `${c.dir}/${c.id}@${c.version}`)).forEach(walk);
    return out;
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
        stageTree(c, exportDir);
        const before = shippedFiles(c, exportDir);
        const r = cp.spawnSync(c.release.build, { cwd: path.join(exportDir, c.dir), env, shell: true,
            stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
        if (r.status !== 0) {
            process.stderr.write(String(r.stdout).slice(-4000) + String(r.stderr).slice(-4000));
            throw new Error(`${c.id}: build "${c.release.build}" failed (${r.error ? r.error.message : r.signal || `exit ${r.status}`})`);
        }
        const after = shippedFiles(c, exportDir);
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f));
        if (changed.length) {
            throw new Error(`${c.id}: the build wrote ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}: ` +
                'build it in the repository and commit what it writes');
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

/* The components' titles and descriptions in other languages, from
 * release/texts/<code>.json ({ "<id>": { "title", "description" } }): by id,
 * the catalog entry's "texts" (the Store shows them in the head unit's
 * language). */
function catalogTexts(ids, root) {
    const dir = path.join(root, 'release', 'texts');
    const out = {};
    (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((n) => /\.json$/.test(n)).sort().forEach((n) => {
        const code = n.slice(0, -5);
        const file = readJson(path.join(dir, n));
        Object.keys(file).forEach((id) => {
            const one = textsOf({ [code]: file[id] });
            if (ids.indexOf(id) < 0 || !one || !Object.keys(file[id]).every((k) => one[code][k] === file[id][k])) {
                throw new Error(`release/texts/${n}: "${id}" is not a component's { "title", "description" }`);
            }
            out[id] = Object.assign(out[id] || {}, one);
        });
    });
    return out;
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
    ['requires', 'optional', 'uninstallable', 'mguHmi', 'mguProvides', 'texts'].forEach((k) => {
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

/* An app's files under its staged tree that carry its version, and the field. */
const APP_VERSION_FILES = [['package.json', /("version": )"\d+\.\d+\.\d+"/], ['npm-shrinkwrap.json', /^(  "version": )"\d+\.\d+\.\d+"/m],
    ['rhmiData/application.json', /^(    "version": )"\d+\.\d+\.\d+"/m]];

/* Writes a component's version into the tree at root: a tool's
 * component.json and its versionFiles' VERSION = 'x.y.z'; an app's
 * mgu-app.json and its staged tree's package.json, npm-shrinkwrap.json and
 * rhmiData/application.json, each in place, so only that line changes. */
function writeVersion(root, c, version) {
    const edits = versionFilesOf(c).filter(([rel]) => c.kind === 'tool' || fs.existsSync(path.join(root, rel)));
    // every file names the old version once, or none is written
    const texts = edits.map(([rel, from]) => {
        const text = fs.readFileSync(path.join(root, rel), 'utf8');
        const n = typeof from === 'string' ? text.split(from).length - 1 : (text.match(new RegExp(from.source, `g${from.flags}`)) || []).length;
        if (n !== 1) {
            throw new Error(`${rel}: expected ${from} once`);
        }
        return text;
    });
    edits.forEach(([rel, from], i) => fs.writeFileSync(path.join(root, rel), typeof from === 'string'
        ? texts[i].replace(from, from.replace(c.version, version)) : texts[i].replace(from, `$1"${version}"`)));
}

/* ---- release-time versions ---------------------------------------------------- */

function bumpVersion(version, level) {
    const [major, minor, patch] = version.split('.').map(Number);
    return level === 'major' ? `${major + 1}.0.0` : level === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/* Writes resolved "requires" (id -> x.y.z) over the "next" ones of a
 * component's release.json or component.json. */
function writeRequires(root, c, resolved) {
    const file = path.join(root, c.dir, c.kind === 'app' ? 'release.json' : 'component.json');
    let text = fs.readFileSync(file, 'utf8');
    Object.keys(resolved).forEach((id) => {
        const from = new RegExp(`("${id.replace(/[.]/g, '\\.')}"\\s*:\\s*)"${NEXT}"`);
        if (!from.test(text)) {
            throw new Error(`${path.relative(root, file)}: no "${id}": "${NEXT}"`);
        }
        text = text.replace(from, `$1"${resolved[id]}"`);
    });
    fs.writeFileSync(file, text);
}

/* A CHANGELOG's "## Unreleased" section: { start, end, body } (body
 * trimmed), or null. Headings repeated right below it (two pull requests
 * that each added one) count as one. */
const UNRELEASED = /^## Unreleased[ \t]*$/m;
function unreleasedOf(text) {
    const m = UNRELEASED.exec(text);
    if (!m) {
        return null;
    }
    let after = m.index + m[0].length;
    let body = '';
    for (;;) {
        const next = text.slice(after).search(/^## /m);
        const end = next < 0 ? text.length : after + next;
        body += text.slice(after, end);
        const again = UNRELEASED.exec(text.slice(end));
        if (!again || again.index !== 0) {
            return { start: m.index, end, body: body.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim() };
        }
        after = end + again[0].length;
    }
}

/* The CHANGELOG with its Unreleased text under a heading for version and an
 * empty "## Unreleased" above it for the next pull requests; when the
 * newest section is already that version (a release stamped and not yet
 * published), the text goes on top of it. Null when there is no text. */
function releaseChangelog(text, version) {
    const u = unreleasedOf(text);
    if (!u || !u.body) {
        return null;
    }
    let rest = text.slice(u.end);
    const heading = `## ${version}`;
    if (rest.startsWith(`${heading}\n`)) {
        rest = rest.slice(heading.length + 1).replace(/^\n+/, '');
    }
    return `${text.slice(0, u.start)}## Unreleased\n\n${heading}\n\n${u.body}\n\n${rest}`;
}

/* The CHANGELOG of a release of the same content (a component named with no
 * change): "No changes." under the version. */
const NO_CHANGES = 'No changes.';
function sameContentChangelog(text, version) {
    const u = unreleasedOf(text);
    return releaseChangelog(u ? `${text.slice(0, u.start)}## Unreleased\n\n${NO_CHANGES}\n\n${text.slice(u.end)}`
        : text.replace(/^## /m, `## Unreleased\n\n${NO_CHANGES}\n\n## `), version);
}

function tagExists(tag, repo) {
    return cp.spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { cwd: repo }).status === 0;
}

/* The step from a release to the next: "major" or "minor" when a pull
 * request of one of the commits carries release:major or release:minor,
 * else "patch". The pull requests are GITHUB_REPOSITORY's (the workflow's
 * repository). MGU_RELEASE_LABELS=off reads no labels: a patch, but for the
 * commits prLabels already holds (tests). */
const LEVELS = ['patch', 'minor', 'major'];
const prLabels = new Map();
function levelOf(commits) {
    let level = 0;
    commits.forEach((sha) => {
        if (!prLabels.has(sha) && process.env.MGU_RELEASE_LABELS !== 'off') {
            if (!process.env.GITHUB_REPOSITORY) {
                throw new Error('set GITHUB_REPOSITORY=<owner>/<repo> to read pull request labels, or MGU_RELEASE_LABELS=off');
            }
            const out = cp.execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`,
                '--jq', '.[] | .labels[].name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            prLabels.set(sha, out.split('\n').filter(Boolean));
        }
        (prLabels.get(sha) || []).forEach((name) => {
            const m = /^release:(minor|major)$/.exec(name);
            if (m) {
                level = Math.max(level, LEVELS.indexOf(m[1]));
            }
        });
    });
    return LEVELS[level];
}

/* What a release of the selected components (none: all) does. A
 * component changed since its tag <id>@<version>, or named, gets the next
 * version; one whose version has no tag yet (stamped, not published; or
 * new) keeps it. A component that requires another one "next" brings that
 * one along. Returns [{ c, version, level, resolved, same }]; same: named
 * with no change. */
function plan(all, ids, repo = REPO) {
    const byId = new Map(all.map((c) => [c.id, c]));
    const chosen = new Set(select(all, ids).map((c) => c.id));
    const out = new Map();
    const consider = (c) => {
        const tag = `${c.id}@${c.version}`;
        if (!tagExists(tag, repo)) {
            out.set(c.id, { c, version: c.version, level: 'new' });
            return;
        }
        const commits = git(['log', '--format=%H', `${tag}..HEAD`, '--'].concat(c.shipped), { cwd: repo }).split('\n').filter(Boolean);
        const changed = commits.length &&
            cp.spawnSync('git', ['diff', '--quiet', tag, 'HEAD', '--'].concat(c.shipped), { cwd: repo }).status !== 0;
        // named: a patch release of the same content
        if (!changed && !ids.includes(c.id)) {
            return;
        }
        const level = changed ? levelOf(commits) : 'patch';
        out.set(c.id, { c, version: bumpVersion(c.version, level), level, same: !changed });
    };
    all.filter((c) => chosen.has(c.id)).forEach(consider);
    // what a chosen component requires "next" is released with it
    let grew = true;
    while (grew) {
        grew = false;
        [...out.values()].forEach((p) => Object.keys(p.c.requires || {}).forEach((id) => {
            if (p.c.requires[id] === NEXT && !chosen.has(id)) {
                chosen.add(id);
                consider(byId.get(id));
                grew = true;
            }
        }));
    }
    out.forEach((p) => {
        p.resolved = {};
        Object.keys(p.c.requires || {}).forEach((id) => {
            if (p.c.requires[id] === NEXT) {
                p.resolved[id] = out.has(id) ? out.get(id).version : byId.get(id).version;
            }
        });
    });
    return all.filter((c) => out.has(c.id)).map((c) => out.get(c.id));
}

/* Writes a plan into the tree at root: versions, "requires", CHANGELOGs. */
function writePlan(root, steps) {
    steps.forEach((p) => {
        const changelog = path.join(root, p.c.changelog);
        if (fs.existsSync(changelog)) {
            const text = fs.readFileSync(changelog, 'utf8');
            const released = releaseChangelog(text, p.version) || (p.same ? sameContentChangelog(text, p.version) : null);
            if (released === null && !text.includes(`\n## ${p.version}\n`)) {
                throw new Error(`${p.c.changelog}: no "## Unreleased" section with what ${p.c.id} ${p.version} changes`);
            }
            if (released !== null) {
                fs.writeFileSync(changelog, released);
            }
        }
        if (p.version !== p.c.version) {
            writeVersion(root, p.c, p.version);
        }
        if (Object.keys(p.resolved).length) {
            writeRequires(root, p.c, p.resolved);
        }
    });
}

/* The ids the last stamp chose for publish --stamped (release/out/stamped). */
const STAMPED = path.join(OUT, 'stamped');

function cmdStamp(ids) {
    if (git(['status', '--porcelain', '--untracked-files=no'])) {
        throw new Error('commit first: stamp writes the release commit');
    }
    const all = components();
    const steps = plan(all, ids);
    steps.forEach((p) => {
        const req = Object.keys(p.resolved).map((id) => `, requires ${id} ${p.resolved[id]}`).join('');
        const how = p.level === 'new' ? 'not released yet' : `${p.level} from ${p.c.version}${p.same ? ', no change' : ''}`;
        console.log(`releasing ${p.c.id}@${p.version} (${how}${req})`);
    });
    if (!steps.length) {
        console.log('no component changed since its last release');
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(STAMPED, steps.map((p) => p.c.id).join(' ') + '\n');
    writePlan(REPO, steps);
    git(['add', '-u']);
    if (!git(['status', '--porcelain', '--untracked-files=no'])) {
        return;
    }
    git(['commit', '-q', '-m', `release: ${steps.map((p) => `${p.c.id}@${p.version}`).join(', ')}`]);
    console.log(`committed ${git(['rev-parse', '--short', 'HEAD'])}`);
}

/* A pull request's checks against its base commit: a component's version
 * stays as the base has it, a changed one with a CHANGELOG says what
 * changed under "## Unreleased", and an app's staged tree has no version in
 * its folder's name. */
function cmdVersions(base) {
    if (!base) {
        throw new Error('usage: versions <base commit>');
    }
    const baseDir = exportHead(base);
    const problems = [];
    try {
        const before = new Map(components(baseDir).map((c) => [c.id, c.version]));
        const all = components();
        all.forEach((c) => {
            const was = before.get(c.id);
            if (was && was !== c.version) {
                problems.push(`${c.id}: the release sets its version; keep ${was}`);
            }
            if (c.kind === 'app') {
                versionFilesOf(c).filter(([rel]) => fs.existsSync(path.join(REPO, rel))).forEach(([rel, field]) => {
                    const m = fs.readFileSync(path.join(REPO, rel), 'utf8').match(field);
                    if (!m || !m[0].includes(`"${c.version}"`)) {
                        problems.push(`${rel}: the release sets its version; keep ${c.version}`);
                    }
                });
            }
            if (c.kind === 'app' && c.tree !== APP_TREE) {
                problems.push(`${c.dir}: the staged tree is ${APP_TREE}/ (mgu-app.json "tree"); the build names it ${c.id}@<version>`);
            }
            (c.versionFiles || []).forEach((rel) => {
                const text = fs.readFileSync(path.join(REPO, c.dir, rel), 'utf8');
                if (text.split(`VERSION = '${c.version}'`).length !== 2) {
                    problems.push(`${c.dir}/${rel}: the release sets its version; keep VERSION = '${c.version}' (once)`);
                }
            });
            const changed = !was || cp.spawnSync('git', ['diff', '--quiet', base, 'HEAD', '--'].concat(c.shipped),
                { cwd: REPO }).status !== 0;
            const log = path.join(REPO, c.changelog);
            if (changed && fs.existsSync(log)) {
                const u = unreleasedOf(fs.readFileSync(log, 'utf8'));
                if (!u || !u.body) {
                    problems.push(`${c.id}: add what changes under "## Unreleased" at the top of ${c.changelog}`);
                }
            }
        });
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
    problems.forEach((m) => console.log(m));
    if (problems.length) {
        process.exitCode = 1;
    } else {
        console.log('versions: as the base has them');
    }
}

/* What the catalog this run publishes would require but not hold, at that
 * version or newer: the car installs requirements first, so each one must
 * be there to install. current: the published entries still in the
 * repository; uploads: what this run publishes. */
function unmetRequires(uploads, current) {
    const final = new Map([...current.values()].map((e) => [e.id, e]));
    uploads.forEach((e) => final.set(e.id, e));
    const unmet = [];
    final.forEach((e) => {
        Object.keys(e.requires || {}).forEach((dep) => {
            const d = final.get(dep);
            if (dep === e.id) {
                unmet.push(`${e.id}@${e.version} requires itself`);
            } else if (!d || compareVersions(d.version, e.requires[dep]) < 0) {
                unmet.push(`${e.id}@${e.version} needs ${dep} ${e.requires[dep]}, ` +
                    (d ? `but the catalog would have ${dep} ${d.version}` : `which the catalog would not have`));
            }
        });
    });
    return unmet;
}

function cmdPublish(ids, dryRun, stamped) {
    if (git(['status', '--porcelain', '--untracked-files=no'])) {
        throw new Error('commit first: publish builds HEAD and records its commit in the catalog');
    }
    // before anything is built or uploaded: publishing to GitHub runs in Actions
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
    if (stamped) {
        // what the last stamp chose, and any component whose version is
        // tagged but not in the catalog (a publish that stopped part-way)
        const lagging = components().filter((c) => tagExists(`${c.id}@${c.version}`, REPO) &&
            (!current.has(c.id) || current.get(c.id).version !== c.version));
        ids = [...new Set(fs.readFileSync(STAMPED, 'utf8').split(/\s+/).filter(Boolean).concat(lagging.map((c) => c.id)))];
    }
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-publish-'));
    const skipped = [];
    // built twice: a version publishes only when both builds give the same
    // bytes; with --stamped and nothing chosen, nothing is built
    const built = stamped && !ids.length ? [] : build(ids, staging, skipped);
    const again = built.length ? build(built.map((e) => e.id), fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-publish-b-')), skipped) : [];
    const uploads = [];
    const all = components();
    built.forEach((e) => {
        const p = current.get(e.id);
        const c = all.find((x) => x.id === e.id);
        const b = again.find((x) => x.id === e.id);
        const next = Object.keys(e.requires || {}).filter((id) => e.requires[id] === NEXT);
        // the gate binds what reaches cars; a folder (a test stick) takes any build
        const checked = GATED.includes(c.id) && publishTarget.describe().startsWith('github:') && (!p || p.version !== e.version);
        const source = checked ? sourceCommit(c) : '';
        const gate = checked && gateProblem(c, source ? publishTarget.commitStatus(source, `release-check/${c.id}`) : null, source);
        if (!b || b.artifact.sha256 !== e.artifact.sha256) {
            skipped.push(`${e.id}@${e.version} builds differently each time`);
        } else if (next.length) {
            skipped.push(`${e.id}@${e.version} requires ${next.join(', ')} "${NEXT}": stamp first`);
        } else if (gate) {
            skipped.push(gate);
        } else if (p && p.version === e.version && p.artifact.sha256 !== e.artifact.sha256) {
            skipped.push(`${e.id}@${e.version} is published with other content: the release gives it its next version`);
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
    const unmet = unmetRequires(uploads, current);
    if (unmet.length) {
        throw new Error(`nothing published: ${unmet.join('; ')}`);
    }
    // the entries carried over list their artifact as the target does (publish.js listedUrl)
    const relisted = [...current.values()].filter((e) => !uploads.some((x) => x.id === e.id)).filter((e) => {
        const url = publishTarget.listedUrl(e);
        if (url === e.artifact.url) {
            return false;
        }
        e.artifact.url = url;
        return true;
    });
    // the entries carried over list their titles and descriptions in other languages as release/texts has them
    const retexted = [...current.values()].filter((e) => !uploads.some((x) => x.id === e.id)).filter((e) => {
        const c = all.find((x) => x.id === e.id);
        const want = (c && c.texts) || null;
        if (JSON.stringify(want) === JSON.stringify(e.texts || null)) {
            return false;
        }
        if (want) {
            e.texts = want;
        } else {
            delete e.texts;
        }
        return true;
    });
    if (!uploads.length && !removed.length && !relisted.length && !retexted.length) {
        console.log('nothing new to publish');
        return;
    }
    removed.forEach((id) => console.log(`${dryRun ? 'would remove' : 'removing'} ${id}: not in the repository`));
    relisted.forEach((e) => console.log(`${dryRun ? 'would list' : 'listing'} ${e.id}@${e.version} at ${e.artifact.url}`));
    retexted.forEach((e) => console.log(`${dryRun ? 'would list' : 'listing'} ${e.id}@${e.version} with its texts`));
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
    case 'versions': return cmdVersions(args[0]);
    case 'stamp': return cmdStamp(args);
    case 'publish': return cmdPublish(args, flags.includes('--dry-run'), flags.includes('--stamped'));
    default:
        const head = fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(2);
        process.stdout.write(head.slice(0, head.indexOf(' *', head.findIndex((l) => /release\.js list/.test(l))))
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

module.exports = { buildIn, components, catalogTexts, compareVersions, unmetRequires, sourceCommit, gateProblem, GATED, bumpVersion,
    releaseChangelog, plan, writePlan, prLabels };
