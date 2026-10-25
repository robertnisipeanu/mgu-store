# Releases: versions, catalog, publishing

Everything the head unit installs from the catalog is a **component**: an
app (`apps/<id>/`) or a root tool (`native/<id>/`). Each has one semantic
version, one artifact `<id>@<version>.tgz`, and an entry in the published
`catalog.json`. The updater on the unit (`native/mgu-updater`) reads that
catalog, and the Store app (`apps/robertn_store`) shows it.

```sh
node release/release.js list                    # components, versions, publish state
node release/release.js build [<id>...]         # reproducible build of HEAD into release/out/ + catalog.json
node release/release.js check [<id>...]         # build twice, compare the artifacts byte for byte
node release/release.js bump <id> <x.y.z>       # set a component's version
node release/release.js publish [--dry-run]     # (GitHub Actions) upload the new versions, then the catalog
```

## Components

| Kind | Where | Version | Artifact |
|---|---|---|---|
| app | `apps/<id>/release.json` marks it releasable | the staged tree `apps/<id>/<id>@<version>/` (its `package.json`) | the app's own flat OAP tgz, from its own build |
| tool | `native/<id>/component.json` | `component.json` `version` | a component kit tgz, packed by the deploy tool (`deploy/hu artifact native/<id>`) |
| tool | `deploy/component.json` (`mgu-deploy`, the deploy tool itself) | `component.json` `version` | the same, from `deploy/unit/` (`deploy/hu artifact deploy`) |

**Adding an app** to the catalog is one file, `apps/<id>/release.json`. A
new app's id (its folder, staged tree and `package.json` name) starts with
`robertn_`: the head unit's provisioning knows apps by id, and its own section
for an id we also use (BMW has one named `store`) wins over the provisioning
fallback and can hide our tile. `release.js` refuses a new id without the
prefix; the ids that predate the rule are listed in it.

```json
{ "build": "node tools/build.js", "local": [] }
```

- `build`: the app's build command, run in `apps/<id>/`. It must leave
  `<id>@<version>.tgz` there, packed with `tools/oap_pack.js`.
- `local`: files the build needs that git does not carry, relative to the
  staged tree (DOOM's `wad/DOOM1.WAD`). They are copied from the working
  tree, or in CI by file name from the private release `build-inputs`
  (`gh release upload build-inputs <file>` when an app gains one).

The store shows the app under the en_GB text of its first entry point.

**Adding a tool** is its `native/<id>/component.json`: `id`, `kind: "tool"`,
`version`, `title`, `description`, `files[{path, from, mode}]`, `units`,
`enable`, `recmgr`, `restart` (the deploy tool's format; see
`native/mgu-updater/component.json`).

## Versions

`x.y.z`, compared numerically. A changed component needs a higher version
before it can be published again: publishing refuses a version that is
already published with other bytes, and a version older than the published
one.

`bump` does the bookkeeping. For an app it renames the staged tree
(`git mv apps/<id>/<id>@<old> … @<new>`), rewrites every `<id>@<old>` in the
repo's text files (build scripts, validators, READMEs; not
`docs/investigations/`), and sets the version in `package.json`,
`npm-shrinkwrap.json` and `rhmiData/application.json`. Add the CHANGELOG
entry, rebuild, commit. For a tool it sets `component.json`'s version, and
`VERSION = 'x.y.z'` in each file its optional `versionFiles` lists (relative
to the tool's folder; the deploy tool's `unit/mgu-deploy.js`).

## Reproducible builds

`build`, `check` and `publish` build a clean `git archive HEAD` export, never
the working tree, with `SOURCE_DATE_EPOCH` set to the time of the last
commit that touched what the component ships (an app's staged tree
`<id>@<version>/`, a tool's folder without its notes) and a private
`TMPDIR`. The app builds take their `build.json` timestamp from it, and
`tools/oap_pack.js` writes sorted members with fixed owner, mode, mtime and
gzip header. The same tree gives the same bytes on any machine, so a
version has exactly one artifact and a rebuild can be checked against the
published sha256; `check` proves it for every component. Node's bundled
zlib is the one outside input: a Node release with another zlib can
compress differently, which publishing reports as other content.

## The catalog

```json
{
  "schema": 1,
  "commit": "<HEAD the components were built from>",
  "components": [
    {
      "id": "doom",
      "kind": "app",
      "title": "DOOM",
      "description": "DOOM shareware episode, played with the iDrive controller",
      "version": "1.0.1",
      "artifact": { "name": "doom@1.0.1.tgz", "size": 2080457, "sha256": "…", "url": "…" }
    }
  ],
  "signature": { "alg": "ecdsa-p256-sha256", "value": "…" }
}
```

It lists the newest published version of every component. `artifact.url` is
where the unit downloads it: the GitHub asset's API URL, or a path relative
to the catalog on a static host. The updater checks `size` and `sha256`
before anything is installed.

### Signing

The car uses only a catalog signed with our key. `signature.value` is the
base64 DER ECDSA-SHA256 signature of `JSON.stringify` of the catalog without
`signature`. It sits inside `catalog.json`, so a catalog and its signature
are always replaced together.

- **Private key** (EC P-256): the repository's Actions secret
  `CATALOG_SIGNING_KEY`, which the Release workflow writes to a 0600 file
  for `MGU_SIGNING_KEY` and removes afterwards. It is in no file of this
  repository. `release.js` refuses a key file others can read.
- **Public key**: `native/mgu-updater/catalog-key.pub.pem` (SHA-256 of its
  DER: `7fcd008916959920…`). The updater ships it next to its
  `updater.conf` (`public_key = catalog-key.pub.pem`), uses only catalogs it
  verifies, keeps the last good catalog when a new one fails, and refuses
  every catalog while the key cannot be read.
- `publish` signs every catalog it uploads to GitHub and checks the
  signature against that public key first, so a key that does not match the
  updater's fails before anything is uploaded. `build` and a `dir:` publish
  sign when `MGU_SIGNING_KEY` is set.

An Actions secret cannot be read back, so keep a copy of the private key
offline. Replacing it means a new `catalog-key.pub.pem` in an updater
version installed by the local installer (`deploy/hu`), since the car
refuses a catalog signed with a new key until then.

## Publishing

Publishing runs in GitHub Actions only (`.github/workflows/release.yml`):

```sh
git tag v2026.10.22 && git push origin v2026.10.22      # every component
gh workflow run release.yml -f components="doom robertn_store"  # some components
```

The workflow checks out the tagged (or chosen) commit with its history,
installs the build toolchain (Node 22.12.0, Go 1.27.2, zig 0.15.2), takes
the inputs git does not carry from the private release `build-inputs`
(`DOOM1.WAD`), writes the signing key from the `CATALOG_SIGNING_KEY` secret,
and runs `release.js publish` with the workflow's own `GITHUB_TOKEN`
(contents: write). No other token, and no developer machine, is involved.
`publish` to GitHub refuses to run outside Actions; `--dry-run` runs
anywhere, checking the signing key only when `MGU_SIGNING_KEY` is set. The
workflow runs on `main` and `v*` tags only, with every action pinned to a
commit.

The releases are GitHub Releases of the **private**
`robertnisipeanu/mgu-apps` repository. Releases of a private repository are
visible only to those with access to it, and stay private. `publish` reads
the repository's visibility before it builds and again before it uploads
the catalog, and refuses unless it is private; nothing in this tooling
changes a repository's visibility. The car reads the releases with a
fine-grained token that can only read this repository's contents, put on
the car by the local installer (`native/mgu-updater/README.md`,
"Configuration").

| Target (`MGU_PUBLISH`) | Layout | The unit reads it with |
|---|---|---|
| `github:<owner>/<repo>` (the workflow's repository) | release `<id>@<version>` per version, its artifact the one asset; release `catalog` holding `catalog.json` | `catalog = github:<owner>/<repo>` and a read-only token in `token_file` |
| `dir:<path>` (relative paths: to the repository) | `catalog.json` and the artifacts side by side in a local folder, for the emulator | `catalog = file:///<path>/catalog.json`, or served over HTTPS on the test network |

`publish` requires a clean working tree, builds HEAD, uploads each new
artifact, and uploads `catalog.json` last, so the published catalog never
names an artifact that is not there yet. A component that does not build,
whose bytes differ from its published version, or that is older than it,
is skipped with a message (exit status 1, a failed workflow run) and the
rest is published.
An interrupted run can be run again: a release left behind is completed,
its asset checked against the new artifact's sha256. For the emulator,
`MGU_PUBLISH=dir:release/published` (git-ignored) writes a local catalog,
signed only when `MGU_SIGNING_KEY` is set; an emulator's updater reads an
unsigned one with `public_key =` in its `updater.local.conf`. Only GitHub
Releases of the private repository carry catalogs for the car.

The entries of the published catalog carry over into the next one, which
is signed again, so `publish` to GitHub refuses a published catalog our
key did not sign rather than sign what someone else put there. An entry
whose component is no longer in the repository (removed or renamed) is
left out; its release stays. `publish` refuses a commit that does not
contain the published catalog's, so a re-run of an older tag cannot take
back what later commits published.
