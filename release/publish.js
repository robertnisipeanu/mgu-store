'use strict';
/**
 * Where release.js publishes, chosen by MGU_PUBLISH (default
 * github:robertnisipeanu/mgu-store):
 *
 *   github:<owner>/<repo>  GitHub Releases of the repository: each version
 *                          is the release <id>@<version> with its artifact
 *                          as the one asset; the release "catalog" holds
 *                          catalog.json. Runs in GitHub Actions only, with
 *                          the workflow's GITHUB_TOKEN (GH_TOKEN).
 *   dir:<path>             A local folder (relative paths: to the repository):
 *                          catalog.json and the artifacts side by side, a
 *                          catalog for the emulator or a USB stick.
 *
 * Catalogs are not signed: the unit trusts a source over HTTPS (and its
 * token), and checks every artifact against the catalog's size and sha256.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const TARGET = process.env.MGU_PUBLISH || 'github:robertnisipeanu/mgu-store';
const REPO = path.join(__dirname, '..');
const KIND = TARGET.slice(0, TARGET.indexOf(':'));
const WHERE = KIND === 'dir' ? path.resolve(REPO, TARGET.slice(TARGET.indexOf(':') + 1)) : TARGET.slice(TARGET.indexOf(':') + 1);
const CATALOG_TAG = 'catalog';

function gh(args, opts = {}) {
    return cp.execFileSync('gh', args, Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, opts));
}

/* A catalog's entries carry over into the next one: what is published
 * must be a catalog (schema 1 or 2) whose entries name their artifact. */
function checkCatalog(catalog) {
    if (!catalog || [1, 2].indexOf(catalog.schema) < 0 || !Array.isArray(catalog.components)) {
        throw new Error('not a catalog of schema 1 or 2');
    }
    catalog.components.forEach((c) => {
        const a = c && c.artifact;
        if (!c || typeof c.id !== 'string' || typeof c.version !== 'string' || !a ||
            a.name !== `${c.id}@${c.version}.tgz` || !/^[0-9a-f]{64}$/.test(a.sha256 || '') || !(a.size > 0)) {
            throw new Error(`entry ${c && c.id} is malformed`);
        }
    });
    return catalog;
}

/* The published catalog, or null when none is published. */
function published() {
    const text = targets[KIND].fetchCatalogText();
    if (text === null) {
        return null;
    }
    try {
        return checkCatalog(JSON.parse(text));
    } catch (e) {
        throw new Error(`the published catalog at ${TARGET} is unusable (${e.message}); ` +
            'find out who changed it before publishing over it');
    }
}

/* sha256 of a release's one asset, as GitHub serves it. */
function assetSha256(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-asset-'));
    try {
        gh(['release', 'download', tag, '-R', WHERE, '-D', dir]);
        const files = fs.readdirSync(dir);
        return files.length === 1 ? crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, files[0]))).digest('hex') : null;
    } catch (e) {
        return null; // an asset GitHub cannot serve is uploaded again
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* Publishing to GitHub runs in GitHub Actions (.github/workflows/release.yml). */
function githubPreflight(dryRun) {
    if (!dryRun && process.env.GITHUB_ACTIONS !== 'true') {
        throw new Error('publishing runs in GitHub Actions: push a v* tag or run the Release workflow (release/README.md)');
    }
}

const targets = {
    dir: {
        preflight() {},
        fetchCatalogText() {
            const file = path.join(WHERE, 'catalog.json');
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        },
        uploadArtifact(entry, file) {
            fs.mkdirSync(WHERE, { recursive: true });
            fs.copyFileSync(file, path.join(WHERE, entry.artifact.name));
            return entry.artifact.name;
        },
        uploadCatalog(catalogFile) {
            fs.mkdirSync(WHERE, { recursive: true });
            fs.copyFileSync(catalogFile, path.join(WHERE, 'catalog.json.tmp'));
            fs.renameSync(path.join(WHERE, 'catalog.json.tmp'), path.join(WHERE, 'catalog.json'));
        }
    },
    github: {
        preflight: githubPreflight,
        fetchCatalogText() {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-catalog-'));
            try {
                gh(['release', 'download', CATALOG_TAG, '-R', WHERE, '-p', 'catalog.json', '-D', dir]);
                return fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');
            } catch (e) {
                if (/release not found|no assets/i.test(String(e.stderr))) {
                    return null;
                }
                throw new Error(`cannot read the published catalog from ${WHERE}: ${String(e.stderr).trim()}`);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
        /* Returns the asset's API URL: the head unit downloads it with its
         * token and Accept: application/octet-stream. A release left by an
         * interrupted publish is completed rather than created again. The
         * release's one asset is the artifact, whatever name GitHub gave it.
         * Each new release is marked Latest, so a run's last one is the
         * repository's Latest. */
        uploadArtifact(entry, file) {
            const tag = `${entry.id}@${entry.version}`;
            const view = () => {
                try {
                    return JSON.parse(gh(['api', `repos/${WHERE}/releases/tags/${encodeURIComponent(tag)}`]));
                } catch (e) {
                    return null;
                }
            };
            let release = view();
            if (!release) {
                const commit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
                gh(['release', 'create', tag, file, '-R', WHERE, '--target', commit, '--latest',
                    '--title', `${entry.title} ${entry.version}`, '--notes', entry.description || tag]);
                release = view();
            } else if (release.assets.length !== 1 || assetSha256(tag) !== entry.artifact.sha256) {
                release.assets.forEach((a) => gh(['api', '-X', 'DELETE', `repos/${WHERE}/releases/assets/${a.id}`]));
                gh(['release', 'upload', tag, file, '-R', WHERE]);
                release = view();
            }
            const asset = release && release.assets.length === 1 && release.assets[0];
            if (!asset || asset.size !== entry.artifact.size) {
                throw new Error(`${tag}: the release's asset is missing or not ${entry.artifact.size} bytes`);
            }
            return asset.url;
        },
        uploadCatalog(catalogFile) {
            try {
                gh(['release', 'view', CATALOG_TAG, '-R', WHERE]);
            } catch (e) {
                gh(['release', 'create', CATALOG_TAG, '-R', WHERE, '--latest=false', '--title', 'Catalog',
                    '--notes', 'catalog.json: the newest version of every component (release/README.md)']);
            }
            gh(['release', 'upload', CATALOG_TAG, '-R', WHERE, '--clobber', catalogFile]);
        }
    }
};

if (!targets[KIND]) {
    throw new Error(`MGU_PUBLISH=${TARGET}: use github:<owner>/<repo> or dir:<path>`);
}

module.exports = Object.assign({ describe: () => TARGET, published }, targets[KIND]);
