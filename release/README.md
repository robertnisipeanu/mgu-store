# Releases: versions, catalog, publishing

Everything the head unit installs from the catalog is a **component**: an
app (`apps/<id>/`) or a root tool (`native/<id>/`, `deploy/`). Each has one
semantic version, one artifact `<id>@<version>.tgz`, and an entry in the
published `catalog.json`. The updater on the unit (`native/mgu-updater`)
reads that catalog, and the Store app (`apps/robertn_store`) shows it.
Publishing for other repositories, and the layouts the updater reads
besides this one: [`docs/PUBLISHING.md`](../docs/PUBLISHING.md).

```sh
node release/release.js list                    # components, versions, publish state
node release/release.js build [<id>...]         # reproducible build of HEAD into release/out/ + catalog.json
node release/release.js check [<id>...]         # build twice, compare the artifacts byte for byte
node release/release.js versions <base>         # a pull request's version checks against its base
node release/release.js stamp [<id>...]         # (the Release workflow) next versions, the release commit
node release/release.js publish --stamped [--dry-run]  # (the Release workflow) upload the new versions, then the catalog
tools/emu-gate <id>...                          # (this Mac) the emulator gate for mgu-render / robertn_store
```

Contributors: [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Components

| Kind | Where | Version | Artifact |
|---|---|---|---|
| app | `apps/<id>/release.json` marks it releasable | the staged tree `apps/<id>/package/` (its `package.json`; the build names it `<id>@<version>` in the package) | with `apps/<id>/mgu-app.json`: the source package its build packs (`<id>@<version>.src.tgz`), built on the unit; else the app's own flat OAP tgz |
| tool | `native/<id>/component.json` | `component.json` `version` | a component kit tgz, packed by the deploy tool (`deploy/hu artifact native/<id>`) |
| tool | `deploy/component.json` (`mgu-deploy`, the deploy tool itself) | `component.json` `version` | the same, from `deploy/unit/` (`deploy/hu artifact deploy`) |

**Adding an app** to the catalog is one file, `apps/<id>/release.json`. An
app's id (its folder and `package.json` name) starts with
`robertn_`: the head unit's provisioning knows apps by id, and its own section
for an id we also use (BMW has one named `store`) wins over the provisioning
fallback and can hide our tile. `release.js` refuses an id without the
prefix.

```json
{ "build": "node tools/build.js && node tools/test_view.js", "requires": { "mgu-deploy": "0.2.0" } }
```

- `build`: the app's build command, run in `apps/<id>/`. It leaves the
  artifact there: the source package `<id>@<version>.src.tgz` when the app
  has `mgu-app.json` (`tools/oap_link.js` `packSource`), else
  `<id>@<version>.tgz`, packed with `tools/oap_pack.js`. A release build
  has no oap-sdk donor (`MGU_SDK_DONOR` is unset for it), and no file of
  the SDK is in this repository.
- `requires`, `optional`, `uninstallable`, `mguHmi`: the catalog fields
  below; without `mguHmi`, the app's staged rhmiData names it
  (`uiDescriptions[].hmi`).

The store shows the app under the en_GB text of its first entry point.

**Adding a tool** is its `native/<id>/component.json`: `id`, `kind: "tool"`,
`version`, `title`, `description`, `files[{path, from, mode}]`, `units`,
`enable`, `recmgr`, `restart`, `dropins` (the deploy tool's format; see
`native/mgu-updater/component.json`), and optionally `internet` with
`uids` (deploy/README.md, "Internet for selected components") and the
catalog fields `requires`, `optional`, `uninstallable`, `mguHmi`, `mguProvides`.

## The emulator gate

A new version of `mgu-render` or `robertn_store` is published to GitHub only
after it passed in the head-unit emulator, which runs on the owner's Mac:

```sh
tools/emu-gate mgu-render          # 4 to 8 min a component
git add release/gate/mgu-render.json && git commit -m "mgu-render: emulator gate"
```

It installs this commit's build on its own over the published release (built
at the version the release would give it, a patch) and
checks that the Store's picture stays on the screen when other programs
change the screen's layers and when the renderer and head unit restart
(the cases: `tools/emu-gate`). Passing, it writes `release/gate/<id>.json`
for that source; `release.js publish` refuses a new version without one, so
any later change to what the component ships needs the gate again. The
record holds for the version the release gives that source: the release
commit, which only writes the version, resolves `"next"` and moves a shipped
CHANGELOG's Unreleased lines, leaves the source as it was (`release.js`
`sourceCommit`). The gate needs Docker, `gh` signed in and the mgu-emulator
checkout (`MGU_EMULATOR`, default `~/workspaces/personal/mgu-emulator`).

An app's release build may not write a file the app ships (a copy from
another folder, a generated file) other than as it is committed: commit what
its build writes, so the source the record names is what ships.

## Versions

`x.y.z`, compared numerically. A changed component needs a higher version
before it can be published again: publishing refuses a version that is
already published with other bytes, and a version older than the published
one.

Every component's version is set at release time. Pull requests leave it
alone, and `versions` (the Versions workflow, on every pull request) fails
one that changes it, that changes a component with a CHANGELOG without
lines under `## Unreleased`, or whose app's staged tree has a version in its
folder name. The Release workflow's `stamp`:

- takes each one changed since its last release (its `<id>@<version>` tag;
  a change is a file it ships), or named in the workflow's input;
- gives it the next version: a patch, or minor/major when a merged pull
  request that changed it carries the label `release:minor` or
  `release:major`; a named component with no change gets a patch, with
  "No changes." in its CHANGELOG;
- writes it into a tool's `component.json` and its `versionFiles`
  (`VERSION = 'x.y.z'`, relative to the tool's folder; the deploy tool's
  `unit/mgu-deploy.js`), or an app's `mgu-app.json` and its `package/`'s
  `package.json`, `npm-shrinkwrap.json` and `rhmiData/application.json`;
  moves the CHANGELOG's `## Unreleased` lines under `## <version>` and
  leaves an empty `## Unreleased` above;
- writes the version of each `"requires": {"<id>": "next"}`, and brings that
  component along when it was not chosen;
- commits `release: <id>@<version>, …` to `main`.

A version stamped but never published (no tag) keeps its number at the next
run; new Unreleased lines join its section.

`mgu-repo.json` lists the Store for the branch channel. Its version on the
branch is the one the last release commit wrote; a merged change waiting
for its release shows there as the same version at a new commit.

## Reproducible builds

`build`, `check` and `publish` build a clean `git archive HEAD` export, never
the working tree, with `SOURCE_DATE_EPOCH` set to the time of the last
commit that touched what the component ships (an app's staged tree
`package/`, with `mgu-app.json` and its modules; a tool's folder
without its notes; the deploy tool's `deploy/unit/` and the linker and
packer in `tools/`) and a private `TMPDIR`. The app builds take their `build.json` timestamp from it, and
`tools/oap_pack.js` writes sorted members with fixed owner, mode, mtime and
gzip header. The same tree gives the same bytes on any machine, so a
version has exactly one artifact and a rebuild can be checked against the
published sha256; `check` proves it for every component. Node's bundled
zlib is one outside input: a Node release with another zlib can
compress differently, which publishing reports as other content. The
other is the host Python 3.12 that compiles mgu-python's `.pyc`: another
3.12.x release can write different bytecode.

## The catalog

```json
{
  "schema": 2,
  "commit": "<HEAD the components were built from>",
  "components": [
    {
      "id": "robertn_store",
      "kind": "app",
      "title": "Store",
      "description": "Lists our published apps and head-unit tools …",
      "version": "0.4.0",
      "artifact": { "name": "robertn_store@0.4.0.tgz", "size": 41210, "sha256": "…", "url": "…" },
      "build": "unit",
      "requires": { "mgu-deploy": "0.2.0" },
      "texts": { "de": { "title": "Store", "description": "…" } }
    },
    {
      "id": "mgu-uplink",
      "kind": "tool",
      "…": "…",
      "optional": true,
      "uninstallable": true
    }
  ]
}
```

It lists the newest published version of every component. `texts` is
each component's title and description in other languages, from
`release/texts/<code>.json` (`{ "<id>": { "title", "description" } }`,
one file per language of the Store's `locales/`); the Store shows the head
unit's language and English where a language has none. `publish` lists
them on every entry, so changed texts need no new version. `artifact.url`
is where the unit downloads it: the GitHub asset's release download
(`https://github.com/<owner>/<repo>/releases/download/<tag>/<name>`) in a
public repository, its API URL in a private one, or a path relative to the
catalog on a static host or a folder. `publish` lists every entry it
carries over that way too, and publishes the catalog when only that
changed. The updater checks
`size` and `sha256` before anything is installed. The catalog is not
signed: the unit trusts a source over HTTPS.

Schema 2 adds, per entry:

- `build: "unit"`: the artifact is a source package (`mgu-app.json` at its
  root), which the deploy tool builds on the unit (deploy/README.md,
  "Source packages"). Absent: a ready OAP tgz or tool kit.
- `requires: { "<id>": "<min version>" }`: installed (or updated) first.
  The Store requires the deploy tool that builds source packages.
- `optional: true`: listed, never offered as an update unless installed
  (`mgu-uplink`).
- `uninstallable: true`: the Store may offer Remove (`mgu-uplink`).
- `mguHmi: ["ID7"|"ID8", ...]`: the head units it is for; the Store
  refuses it on another (docs/PUBLISHING.md). `robertn_store`: `["ID7"]`.
- `mguProvides: "<capability>"`: the capability a tool provides
  (`renderer`); a requirement on such a tool is also met by another
  installed provider, and providers install side by side.

## Publishing

Publishing runs in GitHub Actions only (`.github/workflows/release.yml`),
by hand, on `main`. Run it as a dry run first (the default), then again
without:

```sh
gh workflow run release.yml                                    # dry run: every changed component
gh workflow run release.yml -f dry_run=false                   # release them
gh workflow run release.yml -f components="mgu-python" -f dry_run=false   # some components
```

The workflow checks out `main` with its history and tags, installs the
build toolchain (Node 22.12.0; Go 1.27.2 for `mgu-uplink`; the runner's
Docker builds `mgu-render` and `mgu-uplink`'s wpa_supplicant), runs
`stamp` (Versions, above) and pushes the release commit to `main`, then
`release.js publish --stamped` with the workflow's own `GITHUB_TOKEN`
(contents: write). `--stamped` publishes what `stamp` chose, and any
version tagged but missing from the catalog (a publish that stopped
part-way). Each is built twice from the release commit and published only
when both builds give the same bytes. A dry run stamps and builds without
pushing or publishing. The push fails when `main` moved since the
checkout: run the workflow again. No other token, and no developer machine,
is involved. `publish` to GitHub refuses to run outside Actions;
`--dry-run` runs anywhere. Every action is pinned to a commit.

The releases are GitHub Releases of `robertnisipeanu/mgu-store`, which
the car reads like any public repository.

| Target (`MGU_PUBLISH`) | Layout | The unit reads it with |
|---|---|---|
| `github:<owner>/<repo>` (the workflow's repository) | release `<id>@<version>` per version, its artifact the one asset; release `catalog` holding `catalog.json` | a `github` source |
| `dir:<path>` (relative paths: to the repository) | `catalog.json` and the artifacts side by side in a local folder, for the emulator or a USB stick | a `file` source, a USB stick, or the folder served over HTTPS (`https` source) |

`publish` requires a clean working tree, builds HEAD, uploads each new
artifact, and uploads `catalog.json` last, so the published catalog never
names an artifact that is not there yet. A component that does not build,
whose bytes differ from its published version, or that is older than it,
is skipped with a message (exit status 1, a failed workflow run) and the
rest is published. Nothing is published when the resulting catalog would list a component
whose requirements it doesn't hold at that version or newer, so a car can
always install a component's requirements first.
An interrupted run can be run again: a release left behind is completed,
its asset checked against the new artifact's sha256. For the emulator,
`MGU_PUBLISH=dir:release/published` (git-ignored) writes a local catalog.

The entries of the published catalog carry over into the next one;
`publish` refuses a published catalog it cannot read (not schema 1 or 2,
or an entry without its artifact's name, size and sha256). An entry whose
component is no longer in the repository (removed or renamed) is left out;
its release stays. `publish` refuses a commit that does not
contain the published catalog's, so a re-run of an older tag cannot take
back what later commits published.
