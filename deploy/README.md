# deploy: our tools and apps on the head unit

One installer puts our root tools (`native/<id>/component.json`) and OAP apps
(`apps/<id>/release.json`) on the unit, updates, rolls back and removes them,
snapshots every change first, and restores a snapshot on request.

| Part | Runs on | What it does |
|---|---|---|
| `deploy/mgu-install.js` | the owner's computer (Node 18+; Windows, macOS, Linux) | the first install over SSH from the published release, the updater's tokens, USB sticks as local repos |
| `deploy/install.sh`, `deploy/install.ps1`, `deploy/installer/` | the owner's computer, without Node | run `mgu-install.js` as a standalone executable from the `installer` release |
| `deploy/hu` | the Mac (system Node) | packs tool artifacts, installs components built from this checkout over SSH (development) |
| `deploy/sources.json` | | the updater's sources the installers seed: the Store's own, idrive7-apps, idrive-apps, car-apps and idrive7-system-monitor |
| `deploy/transport/` | the Mac (system `python3`) | finds the unit's sshd over ENET or the hotspot, relays ENET, and the `--arm-debug` bootstrap |
| `deploy/unit/mgu-deploy.sh` → `mgu-deploy.js` | the unit, as root, under its Node 8 | the installer itself |
| `tools/oap_link.js`, `tools/oap_pack.js` | the unit (and the build machine) | build source packages and prepare packages built elsewhere |
| `deploy/component.json` | | the installer as a tool component, `mgu-deploy` |

The updater (`native/mgu-updater`) installs everything it downloads through
the installed deploy tool, `/var/opt/mgu-deploy/mgu-deploy.sh install
--artifact <file> --yes`, so every install takes the same path, whichever
installer starts it.

## mgu-install

`deploy/mgu-install.js` is the owner's side: one file, no dependencies,
Node 18 or newer, driving the system's OpenSSH client (built into
Windows 10/11, macOS and Linux). It runs from a file or from stdin
(`curl -fsSL <raw URL> | node - first-install ...`).

```sh
node mgu-install.js first-install [--from <folder>] [--no-renderer] [--no-uplink] [--token] [--no-restart-prompt] [ssh options]
node mgu-install.js token [--list [--json] | --remove <id>] [ssh options]
node mgu-install.js uninstall [--yes] [--from <folder>] [--no-restart-prompt] [ssh options]
node mgu-install.js status [ssh options]
node mgu-install.js usb-repo <stick folder> [<input>...]
```

```powershell
node .\mgu-install.js first-install --identity $HOME\.ssh\mgu_root_key --token
node .\mgu-install.js token --host 192.168.1.50 --identity $HOME\.ssh\mgu_root_key --list
node .\mgu-install.js usb-repo E:\ github:robertnisipeanu/mgu-store
```

Exit status: 0 done, 1 failed, 2 refused or bad usage; `token` and
`status` return the deploy tool's own exit status.

**Finding the head unit.** `first-install`, `uninstall`, `status` and
`token` find the head unit by themselves and print which connection they
used: the car's hotspot (`172.16.222.97:22`) when it serves SSH, else ENET
on each interface with a `169.254.x.x` address (the address the vehicle
gateway reports for the head unit, read without changing any session, or
the last ENET address that answered). When the head unit is found but its
SSH does not answer, it stops with `found the head unit at <address>, but
its SSH is closed: enable root SSH first, then run this again`. When
nothing answers it stops, naming the hotspot, the ENET cable and
`--host`; on Linux it also says how to give the ENET adapter a link-local
address (`nmcli con mod <its connection> ipv4.method link-local`), or,
with several link-local interfaces, to unplug the others or give `--host`.

**SSH options:**

| Option | What it does |
|---|---|
| `--identity <key file>` | root's private SSH key |
| `--host <address>`, `--port <n>` | reach the head unit there and skip the search (port 22; `--host` defaults to the hotspot's address) |
| `--user <name>` | SSH user (default `root`) |
| `--ssh-opt <option>` | an extra `ssh -o` option, e.g. `ConnectTimeout=30`; repeatable. Through a jump host give `--host` too: `--host <head unit> --ssh-opt ProxyJump=<jump host>` |

The unit's host key is neither asked about nor kept: every car's hotspot
has the same address, and a unit's key can change.

While a step takes longer than 30 s it prints a line about every 30 s.
Stopped with Ctrl+C, it prints `stopped; run the same command again to
finish`.

**Without Node.** The `installer` release of `robertnisipeanu/mgu-store`
holds `mgu-install.js` built into standalone executables
(`mgu-install-<os>-<cpu>.gz` for `windows-x64.exe`, `windows-arm64.exe`,
`macos-arm64`, `macos-x64`, `linux-x64` and `linux-arm64`, and their
`SHA256SUMS`). `deploy/install.sh` (POSIX sh) and `deploy/install.ps1`
(Windows PowerShell 5.1 and PowerShell 7) download the one for the
computer, refuse it when its sha256 differs, run it with their own
arguments and return its exit status; `MGU_INSTALL_DOWNLOAD` names another
folder of the same files.

```sh
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- usb-repo /Volumes/STICK
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) token --identity $HOME\.ssh\mgu_root_key --list
```

### first-install

Before installing, the car is parked, on stable power (engine running or a
charger connected), and stays awake until the command finishes.

It installs the newest `catalog` release of `robertnisipeanu/mgu-store`
(release/README.md): the deploy tool, app-privacy, the updater, Python, the
Store, the renderer `mgu-render` and the internet uplink `mgu-uplink`
(`--no-renderer` and `--no-uplink` leave those two out). Each file is
checked against the catalog's size and sha256 before anything is sent; the
Store is built on the unit. Newer installed tools and apps are kept, so
running it again is safe. It seeds the updater's default sources
(mgu-store, idrive7-apps, idrive-apps, car-apps and idrive7-system-monitor;
kept when the unit has its own). With `--token` a GitHub token is added
afterwards (`token`, below).

It ends with `Setup is done`, or `Restart the head unit to finish setup.`
and, at a terminal, `Restart the head unit now? [y/N]`; `y` restarts the
head unit the way the Store's **Restart head unit** does. The question is
not asked under CI or with `--no-restart-prompt`. When the Store's
tile cannot show, it says `The Store's tile cannot show:` and why.

It stops before any download (exit 2) when the head unit's coding is
missing or holds the default values while no app manager runs: the head
unit then never starts its app manager, so the Store cannot install.
Restore the head unit's coding from a backup (BimmerCode, E-Sys or ISTA)
or have HU_MGU coded to the car, restart the head unit and run the install
again.

**first-install --from <folder>** installs from a folder `usb-repo` wrote
(`<folder>/mgu-repo/mgu-store`) instead of GitHub, each file checked the
same way. For a computer that has internet only away from the car:

```sh
node mgu-install.js usb-repo <folder>                                                   # at home
node mgu-install.js first-install --from <folder>/mgu-repo/mgu-store --identity <key>   # at the car
```

### uninstall

Removes everything the Store setup put on the head unit: the apps and tools
the deploy tool installed (from any source), the app manager patch, the
provisioning fallback, the updater's sources and tokens, and last the
deploy tool with its backups. It lists them first and asks `Remove all of
it? [y/N]`; `--yes` answers for you, and without a terminal it removes
nothing unless given `--yes` (exit 2). It ends with one line:

- `Removed: nothing of the Store setup is left on the head unit.`
- `Removed. Restart the head unit to finish.` (on iDrive 8, `Restart the
  head unit to finish: <apps> and the deploy tool go at its next start.`),
  then the restart question;
- `Not finished: <what> is still on the head unit. Run uninstall again to
  finish.` (exit 1), or, when what is left goes only after a restart,
  `… Restart the head unit, then run uninstall again to finish.`

```sh
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- uninstall --identity ~/.ssh/mgu_root_key
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) uninstall --identity $HOME\.ssh\mgu_root_key
```

### status

Prints the deploy tool's report from the head unit: each tool and app,
each app's tile (`tile=provisioned`, `fallback` or `hidden`) and what waits
for a restart. It changes nothing on the unit. Paste the output when asking
for help:

```sh
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- status --identity ~/.ssh/mgu_root_key
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) status --identity $HOME\.ssh\mgu_root_key
```

### token

Adds a GitHub token for the updater, read from a hidden prompt (or from
stdin when stdin is not a terminal and the script came from a file); never
from an argument or the environment, never printed. `--list [--json]`
names the stored tokens (id, label, account; never a token) and `--remove
<id>` removes one. The running updater uses a new token at once.

**Downloads** from a private repository take a token: the one given with
`--token`, else the GitHub CLI's (`gh auth token`), else one typed at a
hidden prompt.

### usb-repo

Writes a local repository onto a stick for a car without internet. Each
input becomes `mgu-repo/<name>/`, which the updater reads as a source while
the stick is in (native/mgu-updater/README.md, "USB media"):

| Input | Folder | Written |
|---|---|---|
| `github:<owner>/<repo>` with a `catalog` release | `<repo>` | its catalog.json and every artifact, each checked against the catalog's size and sha256 |
| `github:<owner>/<repo>` with release assets `<id>@<x.y.z>.tgz` / `.mgu` | `<repo>` | a catalog of the newest of each id, each asset checked against its size |
| `https://.../catalog.json` | `<host>-<folder>` | as a catalog release |
| a folder with `catalog.json` (a `dir:` publish) | its name | as a catalog release |
| a folder with `mgu-repo.json` (a checkout) | its name | the repository's files, which the unit builds |
| package files `*.tgz`, `*.mgu` | `local` | apps, source packages, tool kits and renderer packages; of an id the higher version stays |

No input: `github:robertnisipeanu/mgu-store`. The stick's copy of a
`github:` or https source updates what that source installed
(native/mgu-updater/README.md, "Ids"). Catalog icons are copied beside the
catalog; one that cannot be read or does not match is left out. A folder is
replaced only once its new copy is complete; the stick's other files stay.
A folder over the updater's limits (catalog.json over 1 MiB, a checkout over
200 MB or 20000 files) or an artifact that does not match is refused.

## deploy/hu (development)

Installs components built from this checkout over SSH.

```sh
deploy/hu check  [<id>...] [--artifact <file>...]   # read-only checks of the unit (and the artifacts)
deploy/hu install [<id>...] [--with-uplink] [--artifact <file>...] [--updater-token-file <file>]
                                                    # build and install; no ids: every component but mgu-uplink
deploy/hu status [--json]
deploy/hu uninstall <id> --yes
deploy/hu rollback <id> --yes                       # a tool back to its other kept version
deploy/hu backups
deploy/hu restore [name] --yes                      # default: stock
deploy/hu fallback on|off|status|migrate
deploy/hu updater-token [--updater-token-file <file>] | --list [--json] | --remove <id>
deploy/hu artifact <dir> --out <dir>                # one tool artifact: native/<id>, or deploy
deploy/hu connect [--hold <seconds>] [--cmd <command>]   # reach root on the unit (below)
deploy/hu help
```

Bare ids name components to build locally (`app-privacy`,
`robertn_store`, ...); `--artifact` names files already built. After a
successful `install`, the updater's sources are seeded from
`deploy/sources.json` (kept when the unit has its own), and a token file
(`--updater-token-file`, or `HU_UPDATER_TOKEN_FILE`) is stored as the
updater's token. A token file is never committed; its content travels on
ssh's stdin only. `--keep-stage` keeps the upload folder on the unit.

SSH options: `--user` (`HU_USER`, root), `--identity <key>` (`HU_IDENTITY`),
and repeatable `--ssh-opt <option>` passed as `ssh -o`.

Exit status: 0 done, 1 failed (rolled back where it applies), 2 refused
before anything changed (and bad usage), 3 stopped by the MainApp guard
(iDrive 7): what it changed stays and is taken up at the next start of the
head unit.

### Connecting

`--host <addr>` (`HU_HOST`) and `--port <n>` (`HU_PORT`, 22) name the target
themselves: ssh goes there as given (host `172.16.222.97` when only a port
is given), and host-key checking is left to `--ssh-opt`.

Without them, every SSH command (and `connect`) finds the unit with
`deploy/transport/mgu_connect.py`:

- **ENET** when a `169.254.x` adapter is present (or `--iface <if>`): the
  unit's address is `--hu-ip <addr>`, else the one the gateway reports,
  else the last one that answered. A relay `127.0.0.1:<lport>` (`--lport`,
  2222) carries ssh.
- **The DIRECT-BMW hotspot** (`--wifi`, or no ENET adapter): ssh goes
  straight to `172.16.222.97` (or `--hu-ip`).

The unit must already have permanent root SSH. When no candidate serves
SSH, the command stops: "Permanent (field-mode) SSH seems disabled on this
HU".

**`--arm-debug`** is for a first-time bootstrap only, over ENET, when
permanent SSH is not set up yet or a firmware update removed it. **Arming
invalidates the MyBMW login and personal settings.** It arms debug mode,
relays to the debug sshd and disarms when the command ends, unless
`--keep-armed`. When no SSH appears after arming, debug is left armed and
the command says to restart the unit (or hold the volume/power knob about
25 s) and run it again with `--arm-debug`. Then set up permanent SSH on the
unit and go back to the default. It needs the Python package
`cryptography`, and cannot be combined with `--wifi` or `--hu-ip`.

**Assets.** The SSH key and the debug-certificate material are **not in this
repository** and must never be committed. `--assets-dir <dir>`
(`HU_ASSETS_DIR`; default `~/.config/mgu-store/assets`) holds
`mgu_ssh_key_rsa.pem` (root's key on the unit), and for `--arm-debug` also
`asset_03.bin` (PMO intermediate CA certificate) and `asset_04.bin` (its
key). `--identity` replaces the key.

```sh
deploy/hu connect                       # ENET or hotspot; prints the ssh command, holds until Ctrl-C
deploy/hu connect --hold 1800           # hold the relay 30 min for ssh from another terminal
deploy/hu connect --wifi --cmd 'id'     # one command
deploy/hu status --hu-ip 169.254.125.24
deploy/hu connect --arm-debug --keep-armed --hold 1800   # bootstrap only, see above
```

## On the unit

```
mgu-deploy.sh check [--artifact <file>...]
mgu-deploy.sh install [--artifact <file>...] [--skip-older] [--other-source] [--leave <id>...] [--keep-safe-mode] [--repair] [--yes]
mgu-deploy.sh status [--read-only] [--json]   # --read-only: changes nothing
mgu-deploy.sh relay [<id>...] [--keep-safe-mode] --yes   # a stale tool's files again, without its install step
mgu-deploy.sh setup <id> --yes                # a tool laid again, its install step included
mgu-deploy.sh uninstall <id> [--yes]          # refused while an installed component requires it
mgu-deploy.sh remove-all [--json] | remove-all --yes
mgu-deploy.sh rollback <id> [--keep-safe-mode] [--yes]
mgu-deploy.sh restore [name] [--yes]
mgu-deploy.sh backups
mgu-deploy.sh fallback <on|off|status|migrate> [--yes]
mgu-deploy.sh updater-token                   # a token on stdin
mgu-deploy.sh updater-token --list [--json] | --remove <id>
mgu-deploy.sh updater-sources                 # sources.json on stdin
mgu-deploy.sh sdk-donor [--json]
mgu-deploy.sh safe-mode [--json] | safe-mode off --yes
mgu-deploy.sh appmanager [--json] | appmanager adopt [--yes]
mgu-deploy.sh apply-pending                   # iDrive 8, at boot
mgu-deploy.sh relist                          # iDrive 8, at boot
mgu-deploy.sh verify                          # at boot
mgu-deploy.sh remove-unused                   # at boot
```

`install` without `--artifact` takes every `*.tgz` and `*.mgu` in
`./artifacts` beside the script. Tools install before apps, `app-privacy`
first. `--other-source` (the updater's) installs a tool another source
installed, deactivating the version it replaces first. Each artifact is its own transaction: when one fails, only its
changes are undone, and the ones installed before it stay. One changing
command runs at a time; another waits for it, up to an hour.

`status --json` also gives `inputs`: each file the run read, with its stamp
as it read it (`size:mtime:ctime:inode` as `lstat` gives them, times in
ms; for a link `>` and its target's, `>-` when it leads nowhere; `-` when
absent), a file the run wrote or a folder whose entries it changed as the
run left it; `/proc/mounts` as the first 16 hex digits of the sha256 of
its text, nothing else of `/proc`, `/sys` or `/dev`. While every stamp
holds, and the head unit and its app manager process are the same, the
answer holds too, up to `inputs_until` (epoch ms) when it gives one; the
units' states and journals, `running` and `app_uids` are live and not
covered. A run gives no `inputs` when its answer rests on more: a repair
it made, left pending or that failed, another run holding the lock, an HMI
it could not read, the head unit told by its running HMI, or a file it read
that changed from the second before the run on. The updater keeps the
answer by them.

`--repair` (the updater's) installs again an app `status` lists under
`lost_apps`, from its kept package, once: after that, or when it fails,
the app is listed under `lost_held` with the reason until it is installed
from the Store. While safe mode is on, every lost app but the Store
(which has **Leave safe mode**) is held; the Store too under an updater before
0.8.47.

On iDrive 7, an app's first install frees app uids when the app manager has
none left: the homes of our apps in `/var/opt/public/oap` that no registry
entry uses go (not those changed in the last 10 minutes or that a process
runs from). `status` shows the free app uids and those held by no app.

- **rollback <id>** switches a tool to its other kept version (an update
  keeps the version before), or, on iDrive 7, an app to its kept older
  package, carrying its data over. Refused on iDrive 8 apps.
- **backups** / **restore [name]**: every change is snapshotted first.
  `stock` is the first snapshot ever taken; the 10 newest others are kept.
  A restore puts back the files the snapshot recorded and keeps the deploy
  tool and the updater's sources and tokens. It needs `--yes`, or `YES`
  typed at a terminal. A restore of a snapshot taken under other firmware
  that would write system files is refused: after a firmware update, use
  `mgu-install.js uninstall` to take the Store setup off.
- **remove-all** lists what the Store setup put on the unit; with `--yes`
  it removes all of it, the deploy tool last (`mgu-install.js uninstall`
  runs this).
- **sdk-donor** makes a readable copy of the unit's oap-sdk donor bundle in
  `/run/mgu-deploy/sdk-donor/` and prints its path; the updater hands it to
  a repository's own build (docs/PUBLISHING.md).

## Artifacts

A **tool artifact** `<id>@<version>.tgz` holds `component.json` at its
root, `files/<path>`, `units/<name>` and `dropins/<unit>.d/<name>`.
`deploy/hu artifact` builds it from a folder holding a `component.json`
(`native/<id>`, or `deploy` for the deploy tool itself); `build`, when
present, is a command run in that folder first. The same tree gives the
same bytes; `release/release.js` packs tools with this command.

An **app artifact** is one of:

- an OAP package: a flat tgz (`tools/oap_pack.js`, files at the root), an
  npm-format tgz (files under `package/`), or a `.mgu` (`meta.json`, the
  package as `source/`);
- a **source package**: a tgz with `mgu-app.json` at its root, built on the
  unit ("Source packages"). The Store is published this way.

A **service package** (IterioDev's App Manager format: `package.json` with
`mguService`) installs as a tool when it is a renderer ("Service packages").

### component.json

| Field | What it does |
|---|---|
| `id`, `kind: "tool"`, `version` (x.y.z), `title`, `description` | the tool |
| `build` | a command run in the folder before packing |
| `files[{path, from, mode}]` | files installed under `/var/opt/<id>/versions/<version>/`, `current` pointing at the version in use |
| `units[{name, from, runsInSafeMode}]` | systemd units installed in `/etc/systemd/system` ("Safe mode" for `runsInSafeMode`) |
| `enable` | units to enable, as `<target>.wants` links |
| `restart` | units started or restarted after an install; `[]` starts nothing |
| `recmgr` | extra names for recmgr's restart list (letters, digits and `:._+@-`); every service and socket unit the tool installs is listed there already |
| `dropins[{unit, name, from}]` | a drop-in for a unit the tool does not own, such as `hmi.service`; it takes effect at that unit's next start |
| `keepRunning` | `true`: a running service is never restarted by an update or rollback; the new version runs from its next start (a renderer) |
| `crashNames` | program file names for the crash handler's list (letters, digits and `._+-`), when they differ from the tool's executables' names ("The crash handler's list") |
| `postInstall` | `["<script>", "<arg>", ...]`: run with `sh` from `current/` after every install, for at most 5 minutes; a failure is a warning |
| `check` | `["<script>", "<arg>", ...]`: run from `current/` (node for `.js`, else sh) once a new version runs, for at most 5 minutes; a non-zero exit rolls the tool back |
| `activate`, `deactivate` | "Activate and deactivate" |
| `internet`, `uids` | "Internet for selected components" |
| `mguHmi` | `["ID7"]`, `["ID8"]` or both ("Compatibility") |
| `mguProvides` | the capability it provides ("Capabilities") |
| `versionFiles` | source files that carry the version as `VERSION = 'x.y.z'` |

Every unit a tool starts must be up and not restarting 10 s later, and its
`check` must pass, or the tool goes back to its previous version. A unit
starts or restarts only once recmgr has its entry, which it reads at boot:
a new tool's units start at the next boot, and the tool is reported
pending until then. `oapcontroller` is never stopped or restarted: an
artifact naming it is refused.

### Activate and deactivate

A tool may name a command its installs run, `"activate"`, and one its
removal runs, `"deactivate"`: `["node", <argument>...]` (the Node the deploy
tool runs on) or `[<an executable file of the tool>, <argument>...]`,
non-empty strings without `..`, no shell. Each runs as root in the
version's folder for at most 120 s, its output prefixed `<id> activate:`.
When its last non-empty stdout line is a JSON object, `"reboot"` says why
the change needs a head-unit restart (the tool is then pending with that
reason), `"status"` is a line for the output, and `"removeWhenUnused"` lists
files on `/` to remove once no process runs them.

- `activate` runs on every install of the tool (the same version again too)
  and on a rollback to a version that has one, after its units are in
  place. It must be idempotent. A non-zero exit or the timeout fails the
  install, which rolls back.
- `deactivate` runs before a removal or a rollback changes anything, with
  the tool in place. It must succeed, doing nothing, when what it reverts is
  already stock (after a firmware update, say). A non-zero exit refuses the
  removal (exit 2) and the tool stays.

A command that writes to `/` remounts it read-write itself. Stock files the
car's services run as their own user (`/usr/bin/carplay`, `/usr/bin/aapd`,
`/etc/aapd.conf`) must stay readable (and runnable) by them; the deploy
tool puts their mode back with a warning when a hook leaves them otherwise.

### Compatibility

A component may name the head units it is for, `"mguHmi": ["ID7"]`,
`["ID8"]` or both: an app in its `package.json` (or `mgu-app.json`), a tool
in its `component.json`. An app that does not is taken to be for the HMIs
its rhmiData has a UI for. An install on another head unit is refused
before anything changes (exit 2: `oap-cardash 1.1.4 is for iDrive 8 (its
rhmiData); this head unit is iDrive 7`).

### Source packages

A source package is a tgz with `mgu-app.json` at its root
(`tools/oap_link.js` has the format): the app's staged package tree without
`javascript/app.js`, its modules (the entry first), and the require names
its modules take from the oap-sdk. The unit builds it before anything
changes, linking those names from a stock BMW app on the unit (the
**donor**), and installs the result as any app. The same inputs give the
same bundle on the unit and on the build machine. No donor, a module that
does not compile, or a bad `mgu-app.json` refuses the artifact (exit 2,
nothing changed). `"internet": true` in `mgu-app.json` becomes
`"mguInternet": true` in the built `package.json`.

### Packages built elsewhere

An OAP package from another repository installs as it is published, with
what the head unit's app manager needs to install it added:

- an npm-format tgz or a `.mgu` (`meta.json` must name the same id and
  version as its `source/`) is repacked flat;
- `"mguLocalOnly": true` is added to its `package.json`;
- without `node_modules/` or `npm-shrinkwrap.json`, an empty
  `npm-shrinkwrap.json` is added;
- `permissions.json` gets the ACL tables it lacks (`masterAccessTable`,
  `masterRegistrationTable`), empty;
- its SOME/IP manifest gets `de.bmw.infotainment.certification.Certification`
  (`"*"`), without which the app cannot get its keychain;
- on iDrive 7, the interfaces its SOME/IP manifest names that the head
  unit's firmware does not have (such as iDrive 8's `hmi.entrypoint2`) are
  taken out, and the output names them;
- when its javascript calls `require('oap-sdk')` and it ships no
  `node_modules/oap-sdk`, that module is generated from the unit's donor.
  The approach follows `kit/tools/extract_sdk.js` of
  [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
  (MIT); `tools/oap_link.js` is its own implementation.

A package that needs the oap-sdk on a unit with no donor is refused (exit 2,
nothing changed).

### App package fields

In an app's `package.json`:

| Field | What it does |
|---|---|
| `mguHmi` | the head units it is for ("Compatibility") |
| `mguInternet` | `true`: the app gets internet through the uplink |
| `mguAppStartType` | `manually` (default), `autostart` or `lum`; an `autostart` app starts with the head unit and is started again when it stops. Any other value is refused |
| `mguLocalOnly` | added by the installer: marks the app as ours, so app-privacy keeps it out of the head unit's reports to BMW |

Only a higher version updates an app; the same version is reported as
already installed, a lower one is refused (use `rollback`).

### Service packages

IterioDev's App Manager installs root services as packages: an npm-format
tgz holding `package.json` `{ name, version, mguService }` and an x86-64
program under its name. A renderer (`mguService` `renderer`, name
`mgu-renderd`) installs as a tool of that name, run by
`mgu-renderd.service` from boot; a tether (`tether`, `ipheth-tether`) is
refused: mgu-uplink drives the iPhone. Any other `mguService`, a version
that is not x.y.z, or a program that is not a 64-bit x86-64 ELF of at most
16 MiB is refused.

### Capabilities

A tool may say which capability it provides, `"mguProvides": "<name>"` in
its `component.json`; a service package provides its kind. Providers of one
capability install side by side: renderers keep to their own sockets, and
mgu-render leaves the community socket to another installed renderer
(native/mgu-render/README.md, "Beside other renderers").

**idrive7-apps' own installer.** A tool of ours takes over the renderer and
controller gate units that idrive7-apps' `mgu-app-install.sh` wrote. The
apps that installer put on the unit are updated and removed by the Store
like any app.

### Internet for selected components

A tool whose `component.json` says `"internet": true` lists its numeric
`uids`, or names in `uids` a file under `/var/opt/<id>/` where it keeps
them, one per line; an app's `package.json` says `"mguInternet": true`.
While `mgu-uplink` is installed, those uids and apps get internet through
it.

### The crash handler's list

The head unit restarts when a process crashes whose executable's file name
is not in the crash handler's list. Every ELF file a tool ships executable
goes into the list by its file name; `crashNames` adds others:

```json
"crashNames": ["mgu-uplink", "mgu-wpa"]
```

A name the car's own programs use (`sh`, `wpa_supplicant`, `dbus-send`)
does not belong there: give the program a name of its own instead. Each
name goes in also as `<name> (deleted)`, the name of a process whose
executable an update replaced while it ran. The list takes effect from
the next boot.

Every service a tool installs runs with `LimitCORE=1`, so a crash of it or
of a program it starts restarts that service, not the head unit, and with
a start limit: a service that has started 20 times within 10 minutes stays
failed until the next boot or the next install of its tool.

### The deploy tool as a tool

`mgu-deploy` is a tool component like the others (`deploy/component.json`;
`VERSION` in `mgu-deploy.js` equals its version). Its artifact is
`deploy/unit/`, `tools/oap_link.js` and `tools/oap_pack.js`; `deploy/hu`,
`mgu-install.js`, the tests and this README are not part of it. A change to
a file of the artifact adds its line under `## Unreleased` in
`deploy/CHANGELOG.md`; the release sets the version (release/README.md,
"Versions"). The updater updates it like any tool. `uninstall mgu-deploy`
is refused: it goes last in `remove-all`.

## On the head unit

### iDrive 8 apps

When the running app manager (MainApp-21) supports it, app installs,
updates and removals take effect at once. Otherwise they are queued and
applied at the next start of the head unit, and the Store shows them as
pending (`installs at the next start`, `removed at the next start`). An
update MainApp-21 rejects at that start is put back to the version before
at the next one.

After the car's first **Update apps and services** with BMW's backend, the
backend's provisioning lists none of our apps; the deploy tool keeps their
tiles listed through the provisioning fallback.

### IterioDev's App Manager

The Store replaces IterioDev's App Manager
([IterioDev/mgu-app-store](https://github.com/IterioDev/mgu-app-store)): its
app `oap-appmanager` and its tether are refused from any source.
`appmanager adopt [--yes]` takes over what it installed, nothing
reinstalled: its daemon stops, its queued app changes and its renderer
become ours, and the updater gives each app it installed its origin.
`uninstall oap-appmanager` adopts first, then removes it; the apps and
services it installed stay.

### Safe mode

When three starts of the head unit end within 5 minutes, by a crash or
recovery restart none of our tools asked for or with no orderly shutdown
at all (a power cut, a reset), and no start between them stays up 5
minutes, our tools' units stay off from the next start: **safe mode**. The
guard runs first at each start and our tools' units start after it, so the
start that follows the third failed one already runs without them. A
shutdown in order (switching the car off, the Store's or the HMI's
restart) never counts. BMW's units are never touched. Units marked
`"runsInSafeMode": true` in their tool's `component.json` still run; give
it to units that recover the head unit or leave safe mode:

```json
"units": [{ "name": "acme-recovery.service", "from": "systemd/acme-recovery.service", "runsInSafeMode": true }]
```

The next install that goes through as a whole (of any app or tool) leaves
safe mode, as does `safe-mode off --yes` (the Store's **Leave safe mode**).
Our tools start again at the next start of the head unit.

A tool that restarts the head unit itself writes the start's boot id
(`/proc/sys/kernel/random/boot_id`) to
`/var/opt/mgu-deploy/restart-requested` first, so that restart does not
count.

### After a firmware update

A firmware update puts the root file system back and keeps `/var/opt`:
the components stay installed, but their units and boot entries are gone.
Running `mgu-install.js first-install` again, or any install from the
Store, sets every component up again. A tool with an install step of its
own (`activate`, `postInstall`) gets its files only and is listed as
`needs setup`; its step runs at its next install or with `setup <id>
--yes` (the Store's **Set up**). The app manager marks every app as needing
an update after a firmware update; an install of such an app, already
current, installs it afresh with its data kept.

### Bouncing the app manager

On iDrive 7, an app install the running app manager cannot make in place
restarts it. The app manager's supervisor wipes every app and its data on
the third app manager crash in a row, so the deploy tool waits until the
manager has been up 60 s, and since the last restart as long, before it
restarts it: an install can pause for up to a minute, saying why. When the
manager dies right after a restart anyway, the run stops (exit 3) and app
changes wait for the next start of the head unit.

## Tests

```sh
node deploy/test/run.js              # MGU_TEST_ONLY=testKit,... runs those test functions only; MGU_TEST_INSTALL_EXE=<file> runs an mgu-install executable in place of the script
sh deploy/test/run.sh                # in Docker: the unit's code on Node 8.16.2 (MGU_TEST_UNIT_NODE)
node tools/test/run.js               # the linker and packer; sh tools/test/run.sh: on Node 8.16.2
MGU_TEST_NODE_VERSION=8.9.4 sh deploy/test/run.sh   # both run.sh: on Node 8.9.4
```

They run offline, against a fake root.
