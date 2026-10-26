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
  unit takes it, and for a source package without one its entry point, from
  a stock BMW app already on it (a *donor*: the firmware's preinstalled
  packages first, then BMW's installed apps; never a package the Store
  installed).
- **App ids are global on the unit**, and the head unit's provisioning
  knows apps by id: an id BMW uses (`store`, `x_call`, ...) can hide the
  tile. Pick a prefix of your own.
- **No signing.** The owner trusts a source by adding it; the unit fetches
  over HTTPS (with a token for a private repository) and checks every
  download against its size and sha256.
- The deploy tool marks every app it installs as local
  (`"mguLocalOnly": true` in its `package.json`); you need not.
- **Say which head units it is for.** `"mguHmi": ["ID7"]` (iDrive 7),
  `["ID8"]` (iDrive 8) or both, in the app's `package.json` (or
  `mgu-app.json`), a tool's `component.json`, and a catalog entry. The
  Store lists a component that is not for the car but does not install it,
  saying why. An app without it is taken to be for the HMIs its rhmiData
  has a UI for (`rhmiData/application.json` `uiDescriptions[].hmi`, or its
  `uiDescriptions/ID7|ID8/` folders) wherever the package itself is read
  (a stick, an index, the install); a catalog entry or a release asset
  without it shows as unknown, and the install still refuses it when its
  rhmiData has a UI for the other unit only.
- **Apps only, unless you ship a tool kit or a service package.** Native
  companions (a renderer, a daemon) are root tools: they install only as a
  tool artifact with `component.json` (deploy/README.md, "Artifacts"),
  listed in a catalog or committed prebuilt in a repo tree, or as one of
  IterioDev's App Manager service packages (below). An app's own
  javascript cannot install one.
- **One renderer.** A tool that only one installed tool may provide a
  capability for says so: `"mguProvides": "renderer"` in its
  `component.json` and catalog entry (every renderer binds
  `/run/mgu-renderd/renderd.sock` and the same ivi layer and surface ids).
  The Store then offers to replace the installed renderer rather than
  install a second one.

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
- The owner can remove every app of this layout from the Store.
- Titles: an optional release asset **`mgu-store.json`**,
  `{"apps": {"<id>": {"title": "…", "description": "…", "author": "…",
  "icon": "<asset name>", "iconSha256": "<hex>"}}}`; without it the Store
  shows the id until the app is installed, then its en_GB entry-point text.
  `icon` names a PNG asset of any release (at most 128 KiB; `iconSha256`
  optional).

idrive7-apps works as published: its `kit/tools/build.py` writes both
`dist/<id>@<ver>.tgz` and `.mgu`; upload either, after removing
`node_modules/oap-sdk` (or building without the extracted SDK in place).

A repository is read in releases mode when it has neither a release named
`catalog` nor `mgu-repo.json`.

### App Manager packages and index

Packages made for IterioDev's App Manager install as they are:

- on a USB stick in a folder `oap/` (any file name, `.tgz`, `.tar.gz` or
  `.mgu`), or listed by an **index** at an https URL the owner adds as a
  source (his `make_index.py` writes one). Version 2, `{"version": 2,
  "name", "packages": [{"url", "sha256", "size", "id", "kind", "version",
  "title", "author", "description", "updated", "renderer", "icon",
  "iconSha256"}]}`, is listed as it stands: `kind` `app`, or a service
  package's kind (below); an app is for iDrive 8 unless its entry has
  `mguHmi`; `url` and `icon` absolute or relative to the index; a package
  is downloaded on install and must be the id and version its entry names.
  Version 1, `{"packages": [{"url", "sha256"}]}`, has each package
  downloaded and read for what it is. A package read that way (or from a
  stick) shows its `icon.png` beside `package.json` (a PNG of at most
  128 KiB), `author` (or `author.name`) and `store.description` (else
  `description`);
- a **service package** (`package.json` `{name, version, mguService}` and
  the x86-64 program under its name): `renderer` (`mgu-renderd`) or
  `tether` (`ipheth-tether`). It installs as a root tool of that name, with
  the unit his App Manager writes (deploy/README.md, "Service packages"),
  and provides its kind.

## 2. Catalog

A `catalog.json` lists every component with its newest version and
artifact; this repository publishes one (release/README.md). It is read
from a GitHub release named `catalog`, an HTTPS URL, or a folder (a USB
stick holding `catalog.json` at its root, in `mgu-repo/` or
`mgu-repo/<name>/`). `node deploy/mgu-install.js usb-repo <stick>
github:<owner>/<repo>` copies a published repository onto a stick, for a
car without internet (deploy/README.md, "mgu-install"); a repository in
the releases layout gets a catalog there.

```json
{ "schema": 2, "components": [
  { "id": "acme_gauges", "kind": "app", "title": "Gauges", "description": "…", "version": "1.2.0",
    "artifact": { "name": "acme_gauges@1.2.0.tgz", "size": 41210, "sha256": "…", "url": "acme_gauges@1.2.0.tgz" },
    "build": "unit", "requires": { "mgu-deploy": "0.2.0" } },
  { "id": "acme-renderd", "kind": "tool", "title": "Renderer", "version": "0.3.0",
    "artifact": { "name": "acme-renderd@0.3.0.tgz", "size": 912340, "sha256": "…", "url": "…" },
    "optional": true, "uninstallable": true, "mguHmi": ["ID7", "ID8"], "mguProvides": "renderer" } ] }
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
  `uninstallable`: the Store offers Remove. `mguHmi`: the head units it is
  for. `mguProvides`: a tool's capability (above); the tool kit's
  `component.json` names it too. `author`, and `icon`: a PNG of at most
  128 KiB, absolute (https) or relative to the catalog (a GitHub catalog
  release: one of its assets), with an optional `iconSha256`.
- Schema 1 (without those fields) is read too.

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
revision, shown as its short sha when the version is unchanged), `branch`
(the same on the repository's default branch) or `tags`
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

   - `tree`: the staged package tree (`package.json` with its `main`,
     `rhmiData/`; no `javascript/app.js` of its own). A tree without a file
     at `main` (`javascript/<file>.js`) gets the donor package's own entry
     point there, which loads `javascript/app.js`.
   - `modules`: the app's own javascript, the entry first. A module
     requires another as `'./<file name>'`, the oap-sdk by the exact names
     in `sdk`, and Node builtins by name; nothing else.
   - `"internet": true` (optional) asks mgu-uplink to give the app internet.

   The unit links the modules against the oap-sdk modules of its donor
   into `javascript/app.js` (`tools/oap_link.js`, with the donor's module
   ids) and installs the package. The same build runs on a desktop with
   `apps/<id>/tools/build.js --sdk <donor>`, for the emulator.
2. **A build script**, `"build": {"node" or "python": "<script, relative
   to the repo root>", "args": [...]}`: the repository's own build, run on
   the unit with these rules:
   - Node **8.16.2** (`node`), or Python **3.12** (`python`: the
     `mgu-python` tool, which the Store installs first), as an
     unprivileged uid with **no network**, in a writable copy of the
     repository (the working directory), limited to 10 minutes and
     200 MB; `node` is on `PATH` for a Python build too;
   - `MGU_SDK_DONOR`: a donor bundle (an app's `javascript/app.js`, a
     `package.json` naming its oap-sdk version beside `javascript/`),
     read-only. Extract or link what you need from it;
   - `"sdk": "<folder>"` (optional): the oap-sdk module generated from the
     donor (`index.js`, `package.json`, the shape of idrive7-apps'
     `extract_sdk.js`) is put in that folder of the copy before the build;
   - `MGU_OUT`: an empty folder, where the script leaves **exactly one**
     `<id>@<version>.tgz` OAP package; or `"output": "<path in the
     repo>"`, the package the build leaves there;
   - `"network": true`, or the ids of the apps that need it: the build may
     download, through an HTTP proxy the unit gives it (`http_proxy`,
     `https_proxy`; https by CONNECT to port 443, http to port 80, public
     addresses only). It fails without internet on the unit;
   - `{id}`, `{version}` and `{dir}` (the app's folder) in `args` and
     `output` are filled in;
   - the package then installs as in releases mode (the oap-sdk module
     generated when it calls `require('oap-sdk')` without one).

**Every app in a folder.** In place of one entry per app, `apps` names a
folder of apps; each subfolder holding the manifest is one, its id the
subfolder's name, its version, title and description from the manifest, so
a new app needs no change to `mgu-repo.json`:

```json
{ "schema": 1,
  "apps": { "path": "apps/*", "manifest": "app.json", "exclude": ["wip"], "mguHmi": ["ID7"],
    "build": { "python": "kit/tools/build.py", "args": ["{id}"], "sdk": "oap-sdk",
      "output": "dist/{id}@{version}.tgz", "network": ["doom"] } } }
```

Tools in a repo tree need no build step: their `component.json` names
prebuilt, committed files (no `build`). A committed program that runs as a
service can instead be described in `tools`, and the unit writes its
systemd unit:

```json
"tools": [{ "id": "acme-renderd", "path": "native/renderd/prebuilt", "version": "1.0.0",
  "title": "Renderer", "provides": "renderer", "mguHmi": ["ID7"],
  "service": { "exec": "acme-renderd", "args": ["--group", "{app_gid}"], "user": "dynamic",
    "groups": ["video", "tm_oap_app"], "environment": { "XDG_RUNTIME_DIR": "/run/wayland" },
    "runtimeDirectory": "acme-renderd", "after": ["winston.service"], "wantedBy": "oapcontroller.service" } }]
```

- `exec`: the program, a file in `path`; it runs from the installed
  version (`/var/opt/<id>/current/<exec>`) with `args` (`{app_gid}`: the
  apps' group, `tm_oap_app`), as root or `"user": "dynamic"` (systemd's
  `DynamicUser`) with `groups`, restarted when it stops, started with
  `wantedBy` (default `multi-user.target`) and after `after`;
- `provides`: its capability (one renderer at a time, above); the Store
  offers to replace the installed provider;
- each value is one plain word (letters, digits, `_.@:/=,+%-`).

A committed library that a stock unit's process should load (`LD_PRELOAD`)
is a `preload` tool. It takes effect at the next head-unit start, behind a
boot guard: after `strikes` starts in a row in which the process did not
stay up with it for `healthySeconds`, the unit starts without it. `needs`
names capabilities an installed tool must provide first:

```json
{ "id": "acme-gate", "path": "native/gate/prebuilt", "version": "1.0.0", "title": "Controller gate",
  "needs": ["renderer"], "optional": true,
  "preload": { "library": "acme-gate.so", "unit": "hmi.service", "process": "HmiMain3D",
    "strikes": 2, "checkAfterSeconds": 120, "healthySeconds": 60 } }
```
