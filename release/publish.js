'use strict';
/**
 * Where release.js publishes, chosen by MGU_PUBLISH (default
 * github:robertnisipeanu/mgu-apps):
 *
 *   github:<owner>/<repo>  GitHub Releases of a PRIVATE repository: each
 *                          version is the release <id>@<version> with its
 *                          artifact as the one asset; the release "catalog"
 *                          holds catalog.json. Runs in GitHub Actions only,
 *                          with the workflow's GITHUB_TOKEN (GH_TOKEN). A
 *                          repository that is not private is refused; nothing
 *                          here changes a repository's visibility.
 *   dir:<path>             A local folder (relative paths: to the repository):
 *                          catalog.json and the artifacts side by side, a
 *                          test catalog for the emulator.
 *
 * Catalogs are signed with the EC P-256 private key at MGU_SIGNING_KEY (in
 * GitHub Actions, the CATALOG_SIGNING_KEY secret written to a 0600 file). The
 * signature travels inside catalog.json, so the catalog and its signature are
 * always replaced together: "signature" holds the base64 DER ECDSA-SHA256
 * signature of JSON.stringify(catalog without "signature"), which the
 * updater checks against native/mgu-updater/catalog-key.pub.pem.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { parse, verifySignature } = require('../native/mgu-updater/js/catalog.js');

const TARGET = process.env.MGU_PUBLISH || 'github:robertnisipeanu/mgu-apps';
const REPO = path.join(__dirname, '..');
const SIGNING_KEY = process.env.MGU_SIGNING_KEY || null;
const PUBLIC_KEY = path.join(__dirname, '..', 'native', 'mgu-updater', 'catalog-key.pub.pem');
const KIND = TARGET.slice(0, TARGET.indexOf(':'));
const WHERE = KIND === 'dir' ? path.resolve(REPO, TARGET.slice(TARGET.indexOf(':') + 1)) : TARGET.slice(TARGET.indexOf(':') + 1);
const CATALOG_TAG = 'catalog';

function gh(args, opts = {}) {
    return cp.execFileSync('gh', args, Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, opts));
}

/* The private key, readable by its owner only, or null without one. */
function signingKey() {
    if (!SIGNING_KEY) {
        return null;
    }
    let st;
    try {
        st = fs.statSync(SIGNING_KEY);
    } catch (e) {
        return null;
    }
    if (st.mode & 0o077) {
        throw new Error(`${SIGNING_KEY} is readable by others: chmod 600 it`);
    }
    return fs.readFileSync(SIGNING_KEY);
}

/* Whether a catalog carries our signature. */
function signedByUs(catalog) {
    return verifySignature(catalog, fs.readFileSync(PUBLIC_KEY, 'utf8'));
}

/* The published catalog, or null when none is published. Whatever is there
 * must be a well-formed catalog, on GitHub one our key signed, as the car
 * requires: its entries carry over into the next catalog, which is signed
 * again. */
function published() {
    const text = targets[KIND].fetchCatalogText();
    if (text === null) {
        return null;
    }
    try {
        return parse(text, KIND === 'github' ? fs.readFileSync(PUBLIC_KEY, 'utf8') : null);
    } catch (e) {
        throw new Error(`the published catalog at ${TARGET} is unusable (${e.message}); ` +
            'find out who changed it before publishing over it');
    }
}

/* Signs a catalog; the signature must verify with the public key the
 * updater ships, or the car would refuse the catalog. Without a key the
 * catalog stays unsigned unless `required`. */
function sign(catalog, required) {
    const key = signingKey();
    const body = Object.assign({}, catalog);
    delete body.signature;
    if (!key) {
        if (required) {
            throw new Error('no signing key (MGU_SIGNING_KEY): the car accepts only signed catalogs (release/README.md)');
        }
        return body;
    }
    const value = crypto.createSign('SHA256').update(JSON.stringify(body)).sign(key);
    const signed = Object.assign(body, { signature: { alg: 'ecdsa-p256-sha256', value: value.toString('base64') } });
    if (!signedByUs(signed)) {
        throw new Error(`${SIGNING_KEY} does not match ${path.relative(process.cwd(), PUBLIC_KEY)}, the key the updater checks with`);
    }
    return signed;
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

/* Publishing to GitHub runs in GitHub Actions (.github/workflows/release.yml),
 * and goes only to a private repository. */
function githubPreflight(dryRun) {
    if (!dryRun && process.env.GITHUB_ACTIONS !== 'true') {
        throw new Error('publishing runs in GitHub Actions: push a v* tag or run the Release workflow (release/README.md)');
    }
    assertPrivate();
}

function assertPrivate() {
    const repo = JSON.parse(gh(['api', `repos/${WHERE}`]));
    if (repo.private !== true || repo.visibility !== 'private') {
        throw new Error(`refusing to publish: ${WHERE} is ${repo.visibility}, not private`);
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
         * release's one asset is the artifact, whatever name GitHub gave it. */
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
                gh(['release', 'create', tag, file, '-R', WHERE, '--target', commit, '--latest=false',
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
            assertPrivate();
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

// Only GitHub Releases carry catalogs for the car, which must be signed.
module.exports = Object.assign({ describe: () => TARGET, sign, published, forTheCar: KIND === 'github' }, targets[KIND]);
