# mgu-store

An app store for BMW iDrive 7 (MGU) head units, made of:

- the **Store** app on the car's screen, where you browse, install, update and remove apps;
- the **updater**, a background service on the head unit that downloads and installs what the Store asks for;
- the **deploy tool**, which performs every install on the head unit and can roll it back;
- **app privacy**, which keeps installed apps out of the head unit's reports to BMW's backend;
- the **renderer** (mgu-render), which draws the Store's screens and other apps' graphics;
- the optional **internet uplink** (mgu-uplink), which gives apps internet through a USB network adapter, an LTE stick or a USB-tethered phone.

It also ships **mgu-python** (Python 3.12), which the head unit builds Python apps with; it is installed with the updater.

The Store is built and used on iDrive 7. iDrive 8 support is in the code
but has not been tested on a real iDrive 8 head unit. On iDrive 8, app
installs and removals take effect at the next head-unit restart.

## Requirements

- A computer running Windows 10/11, macOS or Linux, with
  [Node.js](https://nodejs.org) 18 or newer and the OpenSSH client (`ssh`;
  built into all three).
- Root SSH access to the head unit, already set up, and root's private key
  as a file on the computer. Getting root access is not covered here.
- A network path from the computer to the head unit's SSH: the car's Wi-Fi
  hotspot (the installer's default, `172.16.222.97`), an ENET cable, or any
  other way you reach it with `ssh`. Use `--host` (and `--port`) for an
  address other than the hotspot's.
- The car parked, on stable power (engine running or a charger connected),
  and awake until the install finishes.

## Install

1. Download the installer, `deploy/mgu-install.js`. It is a single file
   with no dependencies.

   ```sh
   # macOS, Linux
   curl -LO https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/mgu-install.js
   ```

   ```powershell
   # Windows PowerShell
   Invoke-WebRequest https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/mgu-install.js -OutFile mgu-install.js
   ```

2. Connect the computer to the head unit: join the car's hotspot, or use
   your ENET cable or other SSH route. Check it with
   `ssh -i <root's key> root@<address>` first.

3. Run the first install, pointing `--identity` at root's key:

   ```sh
   # macOS, Linux
   node mgu-install.js first-install --identity ~/.ssh/mgu_root_key
   ```

   ```powershell
   # Windows PowerShell
   node .\mgu-install.js first-install --identity $HOME\.ssh\mgu_root_key
   ```

   Over anything other than the hotspot, add `--host <address>` (and
   `--port <n>` if SSH isn't on 22), for example
   `--host 169.254.25.10` for the head unit's address on ENET. An SSH
   config alias also works as `--host`, and `--ssh-opt` passes any `ssh -o`
   option, such as `--ssh-opt ProxyJump=<jump host>`.

   It downloads the newest release of this repository, checks every file
   against the release's size and sha256, and installs the deploy tool, app
   privacy, the updater, Python, the renderer, the internet uplink and the
   Store. The Store is built on the head unit. The updater starts with two
   sources: this repository and
   [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps).

4. Restart the head unit when the installer says
   `Restart the head unit to finish setup`. A normal ignition cycle does it.
   The updater and the other services start then.

The Store's tile then appears among the car's apps. From here on, every
update, the Store's own included, comes through the Store. Running
`first-install` again is safe: newer installed components are kept.

| Option | What it does |
|---|---|
| `--identity <file>` | root's private SSH key |
| `--token` | asks for a GitHub token (hidden prompt) and gives it to the updater, for private repositories |
| `--no-renderer` | leaves out the renderer; the Store then shows its plain list screens until a Store update installs the renderer it requires |
| `--no-uplink` | leaves out the internet uplink |
| `--host <address>`, `--port <n>` | the head unit's SSH address (an IP, a hostname or an SSH config alias) and port; default `172.16.222.97:22`, the car's hotspot |
| `--user <name>` | SSH user (default `root`) |
| `--ssh-opt <option>` | an extra `ssh -o` option; repeatable |

GitHub tokens can also be managed later from the computer, with the same
`--identity` (and connection options) as the install:

```sh
node mgu-install.js token --identity ~/.ssh/mgu_root_key                # add one (hidden prompt, or piped on stdin)
node mgu-install.js token --identity ~/.ssh/mgu_root_key --list         # list them
node mgu-install.js token --identity ~/.ssh/mgu_root_key --remove <id>  # remove one
```

On Windows, run these in PowerShell or cmd. Git Bash shows no hidden
prompt; pipe the token in instead.

## Using the Store

Open the Store's tile. The side menu has four pages:

- **Store**: every app and head-unit tool from your sources, with All /
  Apps / Tools filters. Each tile shows its state: `Installed`,
  `Update 1.0.1`, a download in progress, `Not for this head unit`,
  `Failed`, `Restart pending`.
- **Installed**: what is installed, with **Update** on each one that has
  an update, and **Update all**.
- **USB**: what the plugged-in USB sticks offer.
- **Settings**: sources, accounts, phone access, versions, **Check now**
  and **Restart head unit**.

Press a component to open its page, which shows its version, size, source
and description, and the button for what can be done: **Install**,
**Update to**, **Try again**, **Remove** or **Restart head unit**.

- Nothing installs on its own. Updates are listed; you start them.
- Installing an app can restart the other running apps.
- A tool that shows `Restart pending` takes effect after the head unit
  restarts. Settings → **Restart head unit** does it.
- **Remove** appears only for components that can be removed. The updater,
  the deploy tool and Python cannot be removed.

The updater checks its sources at start, at regular intervals, when the
internet comes up, when a USB stick is plugged in, and on **Check now**.

Without the renderer, the Store shows the same information as plain
lists: Apps, Head-unit tools, Sources, Phone access and Restart head unit.

### Sources

The Store starts with two sources: its own, and
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), read
on its default branch, whose apps the head unit builds with Python. An
updater update adds idrive7-apps once to a car without it. It can be
removed like any added source, and stays removed.

### Adding a repository

Settings → **Add source**, then type one of:

| You type | The Store adds |
|---|---|
| `owner/repo` or `https://github.com/owner/repo` | a GitHub repository, on what you pick from what it has |
| `https://github.com/owner/repo/tree/<branch>` | that branch of the repository |
| any other `https://…` address | a `catalog.json` at that address, or an App Manager index |

`github.com/owner/repo`, a trailing `/` and `.git` are accepted too. For a
GitHub repository the Store then lists only what it has: **Releases**,
**Tags** and its branches (main and master first, then the default
branch). Press one to add it. A repository with only one of these is added
on it straight away. A private repository no account can read shows
**Sign in with GitHub** and **Add token** instead, and its list once an
account can read it. Open a
source in Settings to see its channel, the account that reads it, its
components and errors, and to remove it. The Store's own source cannot be
removed.

### Private repositories: GitHub accounts

Public repositories need no account. For a private one, add an account in
Settings → **Accounts**:

- **Sign in with GitHub** shows a QR code and a code. Open the page on your
  phone, enter the code, and sign in. The private repository must also have
  the [mgu-store GitHub App](https://github.com/apps/mgu-store) installed;
  a source that still cannot be read shows the App's install page as a QR
  code.
- **Add token** types a GitHub token on the car's keyboard (steps below).

Accounts belong to the updater, not to one source: each source is read with
whichever account can reach it. Tokens can also be added from the computer
(`mgu-install.js token`) or from the phone page, which is easier than typing
one on the car.

**Creating a token** (read-only access to the repositories you choose):

1. On github.com, open your picture → **Settings** → **Developer settings**
   → **Personal access tokens** → **Fine-grained tokens** →
   **Generate new token**.
2. **Token name**: anything, e.g. `car`. **Expiration**: pick a date, or
   *No expiration* so the car keeps working (renew it before it expires
   otherwise).
3. **Resource owner**: the account or organisation that owns the
   repository.
4. **Repository access**: **Only select repositories**, and pick the
   private repositories the car should read.
5. **Permissions** → **Repository permissions** → **Contents**:
   **Read-only**. Leave everything else at *No access* (Metadata turns
   read-only by itself).
6. **Generate token**, and copy it (it starts with `github_pat_`). GitHub
   shows it only once.
7. Add it on the car (Settings → **Accounts** → **Add token**), on the
   phone page, or from the computer with `mgu-install.js token`.

For a repository of an organisation, the organisation may have to approve
the token first (GitHub shows it as *pending*). A classic token
(**Tokens (classic)** → scope `repo`) also works, but it can write to every
repository you have access to.

### The phone page

Settings → **Phone access** → On shows a QR code. Scan it with a phone
joined to the car's hotspot. The page (port 8470 on the head unit) shows the
sources, components, installs in progress, errors and logs, and lets you add
and remove sources and accounts with the phone's keyboard. When adding a
repository there, its list shows only what it has (Releases, Tags, its
branches); pick one and press **Add**.
Every time phone access is turned on, it gets a new access code; turn it
off when done.

### Internet: the uplink

The head unit gives apps no internet of its own. The internet uplink gives
it to the updater and to the apps that ask for it, through one of:

- a USB Ethernet adapter (for example one cabled to an LTE router);
- a Huawei HiLink LTE stick (E3372h) or another CDC-ECM stick;
- an Android phone with USB tethering on (Settings → Network → Hotspot &
  tethering → USB tethering);
- an iPhone with Personal Hotspot on, unlocked, and **Trust** tapped when it
  asks. While it tethers, USB media playback from that iPhone stops.

Android and iPhone tethering are untested on a real car.

`first-install` installs the uplink unless you pass `--no-uplink`. To add
it later, install **Internet uplink** from the Store's Tools (from a USB
stick when the car has no internet yet), then restart the head unit. After
that, plug a device in; a wired adapter or stick is preferred over a phone.
The Store shows `Online` once there is a connection.

## Offline: a USB stick as a repository

A car without internet installs and updates from a USB stick. On the
computer:

```sh
node mgu-install.js usb-repo <stick> [<input>...]
```

Each input becomes a folder `mgu-repo/<name>/` on the stick:

| Input | Example |
|---|---|
| a published GitHub repository | `github:owner/repo` |
| a catalog URL | `https://example.org/repo/catalog.json` |
| a folder holding `catalog.json` or `mgu-repo.json` (a checkout) | `../my-apps` |
| package files: apps, source packages, tool kits | `gauges@1.2.0.tgz`, `doom@1.0.0.mgu` |

With no inputs it writes this repository's newest release. Running it
again replaces each folder with the newer versions.

```powershell
node .\mgu-install.js usb-repo E:\ github:robertnisipeanu/mgu-store C:\Users\me\Downloads\gauges@1.2.0.tgz
```

Plug the stick into the car. Its contents appear under **USB** in the
Store, and a newer version there is offered as an update to a component
installed from anywhere. A stick with IterioDev's App Manager packages in a
folder `oap/` works too.

## Publishing apps: your own repository

Any GitHub repository, HTTPS address or USB stick can be a source. A
repository uses one of three layouts:

| Layout | The repository has | Who builds the apps |
|---|---|---|
| Releases | built app packages attached to GitHub Releases | you |
| Catalog | a `catalog.json` (in a release named `catalog`, or at an HTTPS address) listing each component | you, or the head unit for source packages |
| Repo tree | `mgu-repo.json` at the repository root | the head unit, from source; no releases needed |

**Releases**, the simplest: build your app and attach
`<id>@<version>.tgz` (or `.mgu`) to a GitHub release. The newest version of
each id is offered.

**Repo tree**: commit `mgu-repo.json` and the head unit builds each app.
The Store reads it on the branch picked when adding the repository. For a folder of apps
built by your own script, as in
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps):

```json
{ "schema": 1,
  "apps": { "path": "apps/*", "manifest": "app.json", "mguHmi": ["ID7"],
    "build": { "python": "kit/tools/build.py", "args": ["{id}"], "sdk": "oap-sdk",
      "output": "dist/{id}@{version}.tgz" } } }
```

Every subfolder of `apps/` that holds an `app.json` is an app: the folder
name is its id, and `app.json` gives its `version` (`x.y.z`). The build
script runs on the head unit, without internet unless the entry allows it,
and must leave the package at `output`.

**Catalog**: a `catalog.json` listing each component with its artifact.
Served from an HTTPS address, `url` can be relative to the catalog:

```json
{ "schema": 2, "components": [
  { "id": "acme_gauges", "kind": "app", "title": "Gauges", "version": "1.2.0",
    "mguHmi": ["ID7"],
    "artifact": { "name": "acme_gauges@1.2.0.tgz", "size": 41210, "sha256": "<hex>",
                  "url": "acme_gauges@1.2.0.tgz" } } ] }
```

What every app needs:

- **No BMW SDK files.** BMW's oap-sdk is not redistributable. Leave
  `node_modules/oap-sdk` out; the head unit links the app against the
  oap-sdk of an app already installed on it.
- **An id of your own**, with a prefix (`acme_gauges`). Ids are shared by
  every source on the head unit, and an id BMW uses can hide your tile.
- **The head units it is for**: `"mguHmi": ["ID7"]`, `["ID8"]` or both,
  in the app's `package.json`, its catalog entry or its `mgu-repo.json` entry.
  The Store lists an app for another head unit but does not install it.
- **Apps or tools.** `kind` is `app` (an OAP app) or `tool` (a root
  program, such as a renderer or a service, packed with its
  `component.json`). An app's own code cannot install a tool.
- **`requires`** (optional): `{"<id>": "<min version>"}` components the
  updater installs first.
- **Internet**: an app that needs it says `"mguInternet": true` in its
  `package.json` (`"internet": true` in `mgu-app.json`). It gets internet
  while the uplink is online.

Nothing is signed: adding a source means trusting it. A download is
checked against the size and sha256 its catalog lists; release assets and
repo trees list no hash.

[docs/PUBLISHING.md](docs/PUBLISHING.md) is the full reference: every
layout and field, source packages (`mgu-app.json`), build scripts on the
head unit, tools and services, and App Manager packages and indexes.

## Repository layout

| Path | What |
|---|---|
| [`apps/robertn_store`](apps/robertn_store) | the Store app |
| [`native/mgu-updater`](native/mgu-updater) | the updater: sources, downloads, installs, the phone page |
| [`deploy`](deploy) | the deploy tool (`mgu-deploy`) and the installer (`mgu-install.js`) |
| [`native/mgu-render`](native/mgu-render) | the renderer |
| [`native/mgu-uplink`](native/mgu-uplink) | the internet uplink |
| [`native/mgu-python`](native/mgu-python) | Python 3.12 for builds on the head unit |
| [`native/app-privacy`](native/app-privacy) | keeps installed apps out of the head unit's reports to BMW's backend |
| [`release`](release) | versions, reproducible builds, the published catalog |
| [`tools`](tools) | `oap_link.js` (builds a source package against the head unit's oap-sdk) and `oap_pack.js` (packs an OAP tgz) |
| [`docs/PUBLISHING.md`](docs/PUBLISHING.md) | publishing apps for the Store |
| [`mgu-repo.json`](mgu-repo.json) | this repository as a repo-tree source (the Store app) |

## Building from source

Each component's README covers its build and tests.
[`deploy/README.md`](deploy/README.md) covers `deploy/hu`, which builds
components from a checkout and installs them over SSH, for development.
[`release/README.md`](release/README.md) covers versions and publishing a
release.

## License

MIT (`LICENSE`). Third-party parts keep their own licences: `THIRD_PARTY_NOTICES.md`.
