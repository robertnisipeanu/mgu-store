'use strict';
/**
 * Where release.js publishes, chosen by MGU_PUBLISH (default
 * github:robertnisipeanu/mgu-store):
 *
 *   github:<owner>/<repo>  GitHub Releases of the repository: each version
 *                          is the release <id>@<version> with its artifact
 *                          as the one asset; the release "catalog" holds
 *                          catalog.json and the icons it names. Runs in GitHub Actions only, with
 *                          the workflow's GITHUB_TOKEN (GH_TOKEN).
 *   dir:<path>             A local folder (relative paths: to the repository):
 *                          catalog.json, the icons it names and the
 *                          artifacts side by side, a catalog for a test
 *                          unit or a USB stick.
 *
 * Catalogs are not signed: the unit trusts a source over HTTPS (and its
 * token), and checks every artifact against the catalog's size and sha256.
 *
 * A catalog entry's artifact url (listedUrl): in a public repository the
 * asset's release download (https://github.com/<owner>/<repo>/releases/
 * download/<tag>/<name>, its browser_download_url), which a car without a
 * token fetches without GitHub's API and its rate limit; in a private one
 * the asset's API URL, which the car downloads with its token.
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

let visibility = null;
/* Whether the repository is public (asked once). */
function isPublic() {
    if (visibility === null) {
        visibility = JSON.parse(gh(['api', `repos/${WHERE}`])).private === false ? 'public' : 'private';
    }
    return visibility === 'public';
}

/* The url a catalog lists a release asset under (above). */
function assetUrl(asset) {
    return isPublic() ? asset.browser_download_url : asset.url;
}

/* The release <id>@<version> of a published entry, or null. */
function releaseOf(tag) {
    try {
        return JSON.parse(gh(['api', `repos/${WHERE}/releases/tags/${encodeURIComponent(tag)}`]));
    } catch (e) {
        return null;
    }
}

/* The release "catalog", created when it is not there. */
function catalogRelease() {
    try {
        gh(['release', 'view', CATALOG_TAG, '-R', WHERE]);
    } catch (e) {
        gh(['release', 'create', CATALOG_TAG, '-R', WHERE, '--latest=false', '--title', 'Catalog',
            '--notes', 'catalog.json: the newest version of every component (release/README.md)']);
    }
}

/* Publishing to GitHub runs in GitHub Actions (.github/workflows/release.yml). */
function githubPreflight(dryRun) {
    if (!dryRun && process.env.GITHUB_ACTIONS !== 'true') {
        throw new Error('publishing runs in GitHub Actions: run the Release workflow (release/README.md)');
    }
}

const targets = {
    dir: {
        preflight() {},
        fetchCatalogText() {
            const file = path.join(WHERE, 'catalog.json');
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        },
        listedUrl(entry) {
            return entry.artifact.url;
        },
        uploadArtifact(entry, file) {
            fs.mkdirSync(WHERE, { recursive: true });
            fs.copyFileSync(file, path.join(WHERE, entry.artifact.name));
            return entry.artifact.name;
        },
        uploadCatalogAsset(file) {
            fs.mkdirSync(WHERE, { recursive: true });
            fs.copyFileSync(file, path.join(WHERE, path.basename(file)));
        },
        uploadCatalog(catalogFile) {
            fs.mkdirSync(WHERE, { recursive: true });
            fs.copyFileSync(catalogFile, path.join(WHERE, 'catalog.json.tmp'));
            fs.renameSync(path.join(WHERE, 'catalog.json.tmp'), path.join(WHERE, 'catalog.json'));
        }
    },
    github: {
        preflight: githubPreflight,
        /* The newest status named context on a commit of the repository
         * (GitHub's status object: state, description, ...), or null. */
        commitStatus(sha, context) {
            let statuses;
            try {
                statuses = JSON.parse(gh(['api', `repos/${WHERE}/commits/${sha}/statuses?per_page=100`]));
            } catch (e) {
                throw new Error(`cannot read the statuses of ${sha.slice(0, 12)} in ${WHERE}: ${String(e.stderr || e.message).trim()}`);
            }
            return statuses.find((st) => st.context === context) || null;
        },
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
        /* A published entry's artifact url as this repository lists it
         * (assetUrl), from its release's one asset. */
        listedUrl(entry) {
            const url = entry.artifact.url || '';
            const download = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(url);
            if (download === isPublic()) {
                return url;
            }
            const release = releaseOf(`${entry.id}@${entry.version}`);
            const asset = release && release.assets.length === 1 && release.assets[0];
            if (!asset || asset.size !== entry.artifact.size) {
                throw new Error(`${entry.id}@${entry.version}: its release's asset is missing or not ${entry.artifact.size} bytes`);
            }
            return assetUrl(asset);
        },
        /* Returns the url the catalog lists the asset under (assetUrl). A
         * release left by an interrupted publish is completed rather than
         * created again. The release's one asset is the artifact, whatever
         * name GitHub gave it. Each new release is marked Latest, so a run's
         * last one is the repository's Latest. */
        uploadArtifact(entry, file) {
            const tag = `${entry.id}@${entry.version}`;
            const view = () => releaseOf(tag);
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
            return assetUrl(asset);
        },
        /* A file beside catalog.json in the release "catalog", under its name. */
        uploadCatalogAsset(file) {
            catalogRelease();
            gh(['release', 'upload', CATALOG_TAG, '-R', WHERE, '--clobber', file]);
        },
        uploadCatalog(catalogFile) {
            catalogRelease();
            gh(['release', 'upload', CATALOG_TAG, '-R', WHERE, '--clobber', catalogFile]);
        }
    }
};

if (!targets[KIND]) {
    throw new Error(`MGU_PUBLISH=${TARGET}: use github:<owner>/<repo> or dir:<path>`);
}

module.exports = Object.assign({ describe: () => TARGET, published }, targets[KIND]);
