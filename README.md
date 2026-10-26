# mgu-store

The Store for the BMW iDrive 7 (MGU) head unit: an on-screen app store, the
updater daemon behind it, the on-unit deploy tool every install goes through,
and an opt-in network driver that gives apps internet through a USB adapter
or a tethered phone.

| Path | What |
|---|---|
| [`apps/robertn_store`](apps/robertn_store) | the Store app (OAP/RHMI) |
| [`native/mgu-updater`](native/mgu-updater) | the updater daemon: sources, downloads, installs |
| [`deploy`](deploy) | the deploy tool (`mgu-deploy`) and the Mac-side installer |
| [`native/mgu-uplink`](native/mgu-uplink) | the network driver (opt-in) |
| [`native/app-privacy`](native/app-privacy) | keeps installed apps out of the unit's backend app reporting |
| [`release`](release) | versions, reproducible builds, the catalog |
| [`tools/oap_link.js`](tools/oap_link.js) | builds an app from its source package against the oap-sdk of an app on the unit |
| [`tools/oap_pack.js`](tools/oap_pack.js) | the flat, reproducible OAP tgz |
| [`docs/PUBLISHING.md`](docs/PUBLISHING.md) | publishing apps for the Store from any repository |
| [`mgu-repo.json`](mgu-repo.json) | this repository as a source the unit builds from (the Store app) |

No file of BMW's oap-sdk is in this repository: the Store is published as
a source package, and the deploy tool links it on the unit against the
oap-sdk of an app already there.

## Install

### First install over SSH

Whoever installs has SSH to the unit (root's key). On a computer with
Node 18 or newer and the OpenSSH client (Windows 10/11, macOS, Linux), with
[`deploy/mgu-install.js`](deploy/mgu-install.js), one file with no
dependencies:

```sh
node mgu-install.js first-install --identity <root's key> [--token] [--with-uplink]
```

It downloads the newest published release of this repository, checks every
file against the catalog's size and sha256, and installs the deploy tool,
app-privacy, the updater, the Store (built on the unit) and, with
`--with-uplink`, the internet uplink, over SSH to `172.16.222.97` (the
car's hotspot; `--host`/`--port` for another address). It seeds the
updater's sources with this repository, and with `--token` adds a GitHub
token for the updater, typed at a hidden prompt (or piped on stdin). It
ends with `Restart the head unit to finish setup`: the updater starts at
the next ignition cycle. Running it again is safe; newer installed
components are kept. After that every update comes through the Store.

```powershell
# Windows PowerShell
node .\mgu-install.js first-install --identity $HOME\.ssh\mgu_root_key --token
```

```sh
# macOS, Linux
node mgu-install.js first-install --identity ~/.ssh/mgu_root_key --token
```

Later, `node mgu-install.js token` adds a token, `token --list` lists them
and `token --remove <id>` removes one. On Windows, run it in PowerShell or
cmd: Git Bash's terminal shows no hidden prompt (pipe the token instead). Downloading a private release needs
a token too: the one given with `--token`, else the GitHub CLI's (`gh auth
login`), else a hidden prompt. deploy/README.md ("mgu-install") has the
details; `deploy/hu install` installs components built from a checkout,
for development.

### Offline: a USB stick as a local repo

A car without internet installs and updates from a USB stick. On the
computer:

```sh
node mgu-install.js usb-repo <stick> [<input>...]
```

writes each input as a folder `mgu-repo/<name>/` on the stick: a published
GitHub repository (`github:<owner>/<repo>`), a `catalog.json` URL, a
folder holding `catalog.json` or `mgu-repo.json` (a checkout), or package
files (`*.tgz`, `*.mgu`: apps, source packages, tool kits; together in
`mgu-repo/local/`). Without inputs it takes this repository's newest
release. Running it again replaces what a folder held with the newer
versions. Plugged into the car, the stick is a source in the Store: it
lists its apps and tools, installs them, and offers a newer version there
as an update of a component installed from anywhere else.

```powershell
node .\mgu-install.js usb-repo E:\ github:robertnisipeanu/mgu-store C:\Users\me\Downloads\gauges@1.2.0.tgz
```
