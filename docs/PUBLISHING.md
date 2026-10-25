# Publishing apps for the Store

The Store installs from **sources**: GitHub repositories, HTTPS catalogs
and USB sticks the owner adds on the car (native/mgu-updater/README.md).
A repository can be read in three layouts; the first needs nothing but
GitHub Releases.

| Layout | The repository has | Builds on the unit |
|---|---|---|
| [Releases](#1-releases) | built OAP packages as release assets | no (the oap-sdk module, when missing) |
| [Catalog](#2-catalog) | a `catalog.json` (release `catalog`, a URL or a folder) | source packages (`build: "unit"`) |
| [Repo tree](#3-repo-tree-and-channels) | `mgu-repo.json` at its root | every app, from source |

What every layout shares:

- **No SDK in the repository.** BMW's oap-sdk is not redistributable. The
  unit takes it from an app already on it (a *donor*: the preinstalled
  packages first, then installed apps' bundles).
- **App ids are global on the unit**, and the head unit's provisioning
  knows apps by id: an id BMW uses (`store`, `x_call`, ...) can hide the
  tile. Pick a prefix of your own.
- **No signing.** The owner trusts a source by adding it; the unit fetches
  over HTTPS (with a token for a private repository) and checks every
  download against its size and sha256.
- The deploy tool marks every app it installs as local
  (`"mguLocalOnly": true` in its `package.json`); you need not.
- **Apps only, unless you ship a tool kit.** Native companions (a
  renderer, a daemon) are root tools: they install only as a tool
  artifact with `component.json` (deploy/README.md, "Artifacts"), listed in
  a catalog or committed prebuilt in a repo tree. An app's own javascript
  cannot install one.

## 1. Releases

The simplest: build as you do, and upload the packages to a GitHub Release.

- Assets named **`<id>@<semver>.tgz`** (an OAP package, its files at the
  root or under `package/` as `npm pack` writes them) or
  **`<id>@<semver>.mgu`** (`meta.json`, the package as `source/` with its
  `rhmiData/`, and `rhmiData/`, `oapgen/` beside it, which the unit leaves
  out). The package's `package.json` names the same id and version.
- **Without `node_modules/oap-sdk`.** When the package's javascript calls
  `require('oap-sdk')` and ships no such module, the unit generates it from
  its donor: the oap-sdk's public API (`OnlineApp`, `NsmProxy`, `config`,
  `logging`, `loggingLevel`, `SDKError`, `someipBuilders`,
  `RhmiApplication`, `RhmiResourcesLocator`, `telephony`, `getVin`,
  `runtimeVariant`, `appstart`, `guidance`, `map`,
  `MapKmlContentTypeConverters`, `poi`), each name loading its module on
  first use, the shape of `kit/tools/extract_sdk.js` in
  [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps). A
  browserify bundle that links the SDK itself also works, as does a
  package that vendors its own `oap-sdk` (left as it is), but neither can
  be published without SDK code in it.
- Every release, newest first, counts (drafts and prereleases do not); the
  newest version of each id wins.
- Titles: an optional release asset **`mgu-store.json`**,
  `{"apps": {"<id>": {"title": "…", "description": "…"}}}`; without it
  the Store shows the id until the app is installed, then its en_GB
  entry-point text.

idrive7-apps works as published: its `kit/tools/build.py` writes both
`dist/<id>@<ver>.tgz` and `.mgu`; upload either, after removing
`node_modules/oap-sdk` (or building without the extracted SDK in place).

A repository is read in releases mode when it has neither a release named
`catalog` nor `mgu-repo.json`.

## 2. Catalog

A `catalog.json` lists every component with its newest version and
artifact; this repository publishes one (release/README.md). It is read
from a GitHub release named `catalog`, an HTTPS URL, or a folder (a USB
stick holding `catalog.json` at its root, in `mgu-repo/` or
`mgu-repo/<name>/`).

```json
{ "schema": 2, "components": [
  { "id": "acme_gauges", "kind": "app", "title": "Gauges", "description": "…", "version": "1.2.0",
    "artifact": { "name": "acme_gauges@1.2.0.tgz", "size": 41210, "sha256": "…", "url": "acme_gauges@1.2.0.tgz" },
    "build": "unit", "requires": { "mgu-deploy": "0.2.0" } },
  { "id": "acme-renderd", "kind": "tool", "title": "Renderer", "version": "0.3.0",
    "artifact": { "name": "acme-renderd@0.3.0.tgz", "size": 912340, "sha256": "…", "url": "…" },
    "optional": true, "uninstallable": true } ] }
```

- `artifact.name` is `<id>@<version>.tgz`; `url` is absolute (a GitHub
  asset's API URL) or relative to the catalog. `size` and `sha256` are
  checked before anything is installed.
- An app's artifact is an OAP package (as in releases mode), or with
  `"build": "unit"` a source package: the app's folder with `mgu-app.json`
  (below), packed, which the unit links against its donor.
- A tool's artifact is a tool kit (deploy/README.md, "Artifacts";
  `deploy/hu artifact <dir> --out <dir>` packs one from a folder with
  `component.json`).
- `requires` installs those components (at least that version) first.
  `optional`: listed, never offered as an update until installed.
  `uninstallable`: the Store offers Remove.
- Schema 1 (without those four fields) is read too.

`node release/release.js` builds and publishes this layout for this
repository; `MGU_PUBLISH=dir:<folder>` writes it to a folder.

## 3. Repo tree and channels

For a repository that publishes source only, the unit builds every app.
`mgu-repo.json` at the repository root lists the components:

```json
{ "schema": 1, "components": [
  { "id": "robertn_store", "kind": "app", "path": "apps/robertn_store", "build": "unit" },
  { "id": "acme_dash", "kind": "app", "path": "apps/dash",
    "build": { "node": "tools/build_unit.js", "args": ["dash"] } },
  { "id": "acme-renderd", "kind": "tool", "path": "native/renderd" } ] }
```

The source's **channel** picks the revision: `releases` (above),
`branch:<name>` (the branch's head commit; every new commit is a new
revision, shown as its short sha when the version is unchanged) or `tags`
(the highest semver tag: `v1.2.3`, `1.2.3` or `<id>@1.2.3`). The unit reads
`mgu-repo.json` at that commit and fetches the repository's tarball at it.
A plain checkout copied to a USB stick works the same way (no revision).
This repository lists its Store app this way, so the Store can follow a
branch.

An app builds on the unit in one of two ways:

1. **`mgu-app.json`** in the app's `path` (this repository's format, no
   script). Version and title come from it and the staged tree:

   ```json
   { "schema": 1, "id": "robertn_store", "version": "0.4.0",
     "tree": "robertn_store@0.4.0",
     "modules": ["src/store.js", "src/store_view.js", "lib/client.js"],
     "sdk": ["oap-sdk/src/core/OnlineApp.js", "oap-sdk/src/logging/logging"] }
   ```

   - `tree`: the staged package tree (`package.json`, `rhmiData/`, a
     `javascript/` main file that loads `javascript/app.js`; no
     `javascript/app.js` of its own).
   - `modules`: the app's own javascript, the entry first. A module
     requires another as `'./<file name>'`, the oap-sdk by the exact names
     in `sdk`, and Node builtins by name; nothing else.
   - `"internet": true` (optional) asks mgu-uplink to give the app internet.

   The unit links the modules against the oap-sdk modules of its donor
   into `javascript/app.js` (`tools/oap_link.js`, with the donor's module
   ids) and installs the package. The same build runs on a desktop with
   `apps/<id>/tools/build.js --sdk <donor>`, for the emulator.
2. **A build script**, `"build": {"node": "<script, relative to the repo
   root>", "args": [...]}`: the repository's own build, run on the unit
   with these rules:
   - Node **8.16.2**, as an unprivileged uid with **no network**, in a
     writable copy of the repository (the working directory), limited to
     10 minutes and 200 MB;
   - `MGU_SDK_DONOR`: a donor bundle (an app's `javascript/app.js`, a
     `package.json` naming its oap-sdk version beside `javascript/`),
     read-only. Extract or link what you need from it;
   - `MGU_OUT`: an empty folder, where the script leaves **exactly one**
     `<id>@<version>.tgz` OAP package;
   - the package then installs as in releases mode (the oap-sdk module
     generated when it calls `require('oap-sdk')` without one).

Tools in a repo tree need no build step: their `component.json` names
prebuilt, committed files (no `build`).
