# deploy: our tools and apps on the head unit

One installer puts our root tools (`native/<id>/component.json`) and OAP apps
(`apps/<id>/release.json`) on the unit, updates, rolls back and removes them,
snapshots every change first, and restores a snapshot on request.

| Part | Runs on | What it does |
|---|---|---|
| `deploy/mgu-install.js` | the owner's computer (Node 18+; Windows, macOS, Linux) | the first install over SSH from the published release, the updater's tokens, USB sticks as local repos |
| `deploy/install.sh`, `deploy/install.ps1`, `deploy/installer/` | the owner's computer, without Node | run `mgu-install.js` as a standalone executable from the `installer` release |
| `deploy/hu` | the Mac (system Node) | packs tool artifacts, installs components built from this checkout over SSH (development) |
| `deploy/sources.json` | | the updater's sources the installers seed: the Store's own, idrive7-apps, idrive-apps and car-apps |
| `deploy/transport/` | the Mac (system `python3`) | finds the unit's sshd over ENET or the hotspot, relays ENET, and the `--arm-debug` bootstrap |
| `deploy/unit/mgu-deploy.sh` → `mgu-deploy.js` | the unit, as root, under its Node 8 | the installer itself |
| `tools/oap_link.js`, `tools/oap_pack.js` | the unit (and the build machine) | build source packages and prepare packages built elsewhere |
| `deploy/unit/fallback_build.js`, `mgu-app-fallback.service` | the unit | the provisioning fallback our apps install through |
| `deploy/component.json` | | the installer as a tool component, `mgu-deploy` |

## Two installers

- **The local deploy tool** (this folder) bootstraps the car over SSH:
  `mgu-install.js` from the published release, `deploy/hu` from a
  checkout. It installs app-privacy, the updater and the Store, seeds the
  updater's sources and adds a GitHub token.
- **The updater** (`native/mgu-updater`) is the cloud installer: it
  downloads from its sources and installs each artifact by calling the
  installed deploy tool, `/var/opt/mgu-deploy/mgu-deploy.sh install
  --artifact <file> --yes`.

Both follow one contract: a tool is `component.json` installed as
`/var/opt/<id>/versions/<version>/` with `current` switched by rename; an
app's installed `package.json` carries `"mguLocalOnly": true`. Every install
takes the same path, whichever installer starts it.

## From the Mac

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

The SSH commands upload the repo's `deploy/unit/` files, `tools/oap_link.js`,
`tools/oap_pack.js` and `deploy/component.json`, plus for `install` and
`check` the artifacts, as one
tar stream into a fresh `/var/opt/mgu-deploy-kit-<pid>` on the unit, run
`sh <stage>/mgu-deploy.sh <command> ...` there with its output streamed, exit
with its status, and remove the staging folder (`--keep-stage` keeps it,
until a changing run a day later removes it).
`check` changes nothing else on the unit. Bare ids name components to build
locally (`app-privacy`, `robertn_store`, ...); `--artifact` names files
already built. After a successful `install`, `updater-sources` seeds the
updater's sources from `deploy/sources.json` (kept when the unit has its
own), and, with a token file, `updater-token` stores it.

SSH options: `--user` (`HU_USER`, root), `--identity <key>` (`HU_IDENTITY`),
and repeatable `--ssh-opt <option>` passed as `ssh -o` (the first value of
an option wins in ssh, so these come before the tool's own). With an
identity it also passes `-o IdentitiesOnly=yes -o HostKeyAlgorithms=+ssh-rsa
-o PubkeyAcceptedAlgorithms=+ssh-rsa`, which the unit's sshd needs.

### Connecting

`--host <addr>` (`HU_HOST`) and `--port <n>` (`HU_PORT`, 22) name the target
themselves: ssh goes there as given (host `172.16.222.97` when only a port
is given), host-key checking is left to `--ssh-opt`, and nothing below runs.

Without them, every SSH command (and `connect`) first finds the unit with
`deploy/transport/mgu_connect.py`, holds what it opens for the duration of
the command, and shuts it down after:

- **Default, debug-free.** The unit runs a permanent field-mode sshd
  (the unit's root SSH access, set up beforehand); nothing arms, disarms or
  resets it.
  - **ENET** when a `169.254.x` adapter is present (or `--iface <if>`). The
    unit's link-local address is, in order: `--hu-ip <addr>` (used alone);
    DID `22 17 2A` read over HSFZ without arming (gateway identification and
    one ReadDataByIdentifier, no session change, no routine); the last
    address that answered. macOS routes link-local only per interface, so a
    relay `127.0.0.1:<lport>` (`--lport`, 2222) → unit`:22`, bound to the
    ENET interface, carries ssh.
  - **The DIRECT-BMW hotspot** (`--wifi`, or no ENET adapter): ssh goes
    straight to `172.16.222.97` (or `--hu-ip`).
  - Every candidate must serve an SSH banner on `:22` before it is used; the
    first one that does wins. When none does, the command stops: "Permanent
    (field-mode) SSH seems disabled on this HU", with what to check.
- **`--arm-debug`, first-time bootstrap only** (permanent SSH not set up yet,
  or removed by a firmware update), over ENET. **Arming invalidates the
  MyBMW login and personal settings.** It arms debug mode (`10 03`, challenge
  `31 01 A6 71`, a leaf certificate minted from the assets, `31 01 A0 FD`,
  then DID `22 17 2A` for the address), holds the session with
  TesterPresent, relays to `:22`, and disarms (`31 02 A0 FD`) when the
  command ends, unless `--keep-armed`. The debug sshd starts only at boot
  while armed: when no banner appears after arming, debug is left armed and
  the command stops, saying to reboot the unit (UDS `11 01` to `0x63`, or
  hold the volume/power knob ~25 s) and run it again with `--arm-debug`.
  Then set up permanent SSH on the unit
  and go back to the default. `--arm-debug` with `--wifi` or `--hu-ip` is a
  usage error.

A selected connection uses the assets' key (or `--identity`) and passes
`StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`,
`LogLevel=ERROR` and `ConnectTimeout=8`: `127.0.0.1:<lport>` stands for
whichever unit answers.

**Assets.** The SSH key and the debug-certificate material are **not in this
repository** and must never be committed. `--assets-dir <dir>`
(`HU_ASSETS_DIR`; default `~/.config/mgu-store/assets`) holds
`mgu_ssh_key_rsa.pem` (root's key on the unit), and for `--arm-debug` also
`asset_03.bin` (PMO intermediate CA certificate) and `asset_04.bin` (its
key). `--identity` replaces the key. A missing file stops the command
before any connection, naming the file and the folder it looked in.
`--arm-debug` also needs the Python package `cryptography`.

**State.** The last ENET address that answered is written to
`~/.cache/mgu-store/last_hu_enet_ip` (`HU_STATE_DIR`), and also read from
`last_hu_enet_ip` beside the assets folder.

```sh
deploy/hu connect                       # ENET or hotspot; prints the ssh command, holds until Ctrl-C
deploy/hu connect --hold 1800           # hold the relay 30 min for ssh from another terminal
deploy/hu connect --wifi --cmd 'id'     # one command
deploy/hu status --hu-ip 169.254.125.24
deploy/hu connect --arm-debug --keep-armed --hold 1800   # bootstrap only, see above
```

`connect` prints the ssh command line that reaches root on the unit
(stdout), then runs `--cmd`, or holds the relay `--hold` seconds (default:
until interrupted). Over the hotspot there is nothing to hold, and it
returns.

A unit on a local SSH port:

```sh
deploy/hu status --host 127.0.0.1 --port 2225 \
    --ssh-opt StrictHostKeyChecking=no --ssh-opt UserKnownHostsFile=/dev/null
```

Exit status everywhere: 0 done, 1 failed (rolled back where it applies),
2 refused before anything changed (and bad usage), 3 stopped by the MainApp
guard (iDrive 7, "Bouncing the app manager"): what it changed stays.

### The updater's sources and tokens

The updater reads its sources from `/var/opt/mgu-updater/sources.json`
(native/mgu-updater/README.md). The installers seed it with
`deploy/sources.json`, the Store's own source (`mgu-store`, this
repository's releases), idrive7-apps (`cauliflowermossgrape/idrive7-apps`
on its default branch), idrive-apps (`robertnisipeanu/idrive-apps`, from
its releases) and car-apps (`IterioDev/car-apps`, at its newest x.y.z
tag), when the updater is installed and has none: `sh
mgu-deploy.sh updater-sources < sources.json` writes it, root's, mode 0600,
and keeps an existing one, since the owner adds sources from the Store.

The updater's tokens are its own, not a source's (native/mgu-updater/
README.md, "Tokens"): each one's text in `/var/opt/mgu-updater/credentials/
token-<id>` and its entry (id, label, account) in `credentials/tokens.json`,
root's, mode 0600, in a 0700 folder; the updater reads each GitHub source
with whichever token reaches it. The owner supplies a GitHub token (one
that reads the private repositories the car reads) as a file on the Mac; it is never committed. `deploy/hu install
--updater-token-file <file>` stores it after the install, and `deploy/hu
updater-token --updater-token-file <file>` stores it alone; both default to
`HU_UPDATER_TOKEN_FILE`. `deploy/hu updater-token --list [--json]` names the
stored tokens (id, label, account; never a token) and `--remove <id>`
removes one. Over SSH the file's content travels on ssh's stdin only: it is
never an argument or part of the staging upload, nor printed.
`mgu-install.js token` sends one typed at a hidden prompt the same way
(below). On the unit, `sh mgu-deploy.sh updater-token < <file>` stores a
token, as a new id, unless one with that text is stored already; it writes
the files only (the running updater notices them within 5 s, asks GitHub
whose the token is and reads the sources that need it). `--list [--json]`
and `--remove <id>` as above.

## Artifacts

A **tool artifact** `<id>@<version>.tgz` holds `component.json` at its root,
`files/<path>`, `units/<name>` and `dropins/<unit>.d/<name>`. `deploy/hu artifact` builds it from a
folder holding a `component.json` (`native/<id>`, or `deploy` for the deploy
tool itself):

- `build`, when present, is a command run in that folder first
  (mgu-uplink: `make target`, which needs Go, and Docker for its
  wpa_supplicant);
- `files[{path, from, mode}]` are read from `from`; a missing one fails,
  naming the build command;
- the artifact's `component.json` is `{id, kind, version, title,
  description, files[{path, mode, sha256}], units[{name}], enable, recmgr,
  restart}`, `dropins[{unit, name}]` (each read from `from`), and `internet`
  with `uids`, `mguHmi`, `mguProvides`, `keepRunning`, `crashNames`,
  `postInstall`, `check`, `activate` and `deactivate` when the tool declares
  them;
- members are sorted, owned 0:0, with the listed modes (`component.json` and
  units 0644) and one mtime: `SOURCE_DATE_EPOCH` when set, else the packer's
  fixed one (`tools/oap_pack.js`, which also writes the gzip header's OS byte
  as Unix on any machine). The same tree gives the same bytes;
  `release/release.js` packs tools with this command.

An **app artifact** is one of:

- an OAP package: the flat tgz our builds pack (`tools/oap_pack.js`, files
  at the root, `"mguLocalOnly": true`), installed byte for byte; or one
  built elsewhere (below): an npm-format tgz (files under `package/`), or a
  `.mgu` (`meta.json`, the package as `source/`, `rhmiData/`, `oapgen/`);
- a **source package**: a tgz with `mgu-app.json` at its root, built on the
  unit (below). The Store is published this way.

A **service package** (IterioDev's App Manager format: `package.json` with
`mguService`) installs as a tool when it is a renderer; a tether is refused
("Service packages").

## mgu-install

`deploy/mgu-install.js` is the owner's side: one file, no dependencies,
Node 18 or newer (its own `fetch`, `crypto` and `zlib`; what it sends is
packed in Node, no `tar`, shell or Python on the computer), driving the system's
OpenSSH client (`ssh`, built into Windows 10/11, macOS and Linux). It runs
from a file or from stdin (`curl -fsSL <raw URL> | node - first-install
...`); from stdin a token prompt reads the terminal device (`/dev/tty`),
and where there is none (Windows) the downloaded file is run instead.

`first-install`, `uninstall` and `token` find the head unit by themselves, and print
which connection they used:

1. the car's hotspot, `172.16.222.97:22`, when it serves an SSH banner;
2. else ENET, on each interface with a `169.254.x.x` address in turn: HSFZ
   gateway identification (UDP `00 00 00 00 00 11` to `:6811`, sent from
   that address, answers heard there and on `:6811` on all addresses, so a
   gateway that answers by broadcast is heard too), then DID `22 17 2A` read from the head unit (`0x63`)
   through the gateway's `:6801` — that request alone, no session change,
   no routine, nothing armed — and the last ENET address that answered
   (`~/.cache/mgu-store/last_hu_enet_ip`, which `deploy/transport` keeps
   too). The first of these that serves an SSH banner from the
   interface's address is the target, and ssh binds to that address
   (`ssh -b`), so the link-local route goes out of the ENET interface
   without a relay. The address that answered is remembered.

When the head unit was found but its SSH does not answer (the hotspot's
address refuses port 22 or answers there without SSH, or the gateway
reported an address whose port 22 does not answer), it stops with
`found the head unit at <address>, but its SSH is closed: enable root SSH
first, then run this again`. When nothing answers it stops before downloading anything, naming the
hotspot, the ENET cable and `--host`; on Linux also how to give the ENET
adapter a link-local address (`nmcli con mod <its connection>
ipv4.method link-local`) when no interface has one, or, with several
link-local interfaces (Linux routes them by destination only), their
names and to unplug the others or give `--host`. `--host <address>` and
`--port <n>` (22) name the target themselves and skip the search
(`--host` defaults to the hotspot's address). `--ssh-opt <option>`
(repeatable, `ssh -o`, before the tool's own; e.g.
`ConnectTimeout=30`) applies to whichever target is used;
through a jump host give `--host` as well (`--ssh-opt ProxyJump=<host>`),
as the search runs from this computer. `--user <name>`
(root) and `--identity <key file>` apply to either. The unit's host key
is neither asked about nor kept (`StrictHostKeyChecking=no`,
`UserKnownHostsFile=/dev/null`): every car's hotspot has the same address,
and a unit's key can change. With OpenSSH 8.8 or newer it adds
`HostKeyAlgorithms=+ssh-rsa` and `PubkeyAcceptedAlgorithms=+ssh-rsa`,
which the unit's sshd needs.
`--arm-debug` stays with `deploy/hu`.

While a step takes longer than 30 s (finding the unit, a download, the
install or removal on the head unit) it prints one line about every 30 s,
such as `the head unit is still installing (2 min)`. Stopped with Ctrl+C
(or SIGTERM), it prints `stopped; run the same command again to finish`
and exits as the signal would.

```sh
node mgu-install.js first-install [--from <folder>] [--no-renderer] [--no-uplink] [--token] [ssh options]
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

**Without Node.** The `installer` release of `robertnisipeanu/mgu-store`
holds `mgu-install.js` built into standalone executables (Node single
executable applications, Node 24 built in): `mgu-install-<os>-<cpu>.gz` for
`windows-x64.exe`, `windows-arm64.exe`, `macos-arm64`, `macos-x64`,
`linux-x64` and `linux-arm64`, and their `SHA256SUMS`.
`.github/workflows/installer.yml` builds them on each system
(`deploy/installer/build.sh`), tests them, and replaces the assets when
`mgu-install.js` changes on main. `deploy/install.sh` (POSIX sh) and
`deploy/install.ps1` (Windows PowerShell 5.1 and PowerShell 7) pick the
one for the computer, download it and `SHA256SUMS` to a temporary folder,
refuse it when its sha256 differs, unpack it, run it with their own
arguments, delete it, and return its exit status (1 when it could not be
fetched); `MGU_INSTALL_DOWNLOAD` names another folder of the same files.
Through `curl | sh` the executable's stdin is the terminal, for the token
prompt; a token on stdin goes to the executable or `mgu-install.js`
directly. install.ps1 starts the executable with each argument quoted
for the Windows C runtime, so spaces, quotes and trailing backslashes
arrive whole in both PowerShells, and leaves its exit status in
`$LASTEXITCODE`:

```sh
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- usb-repo /Volumes/STICK
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) token --identity $HOME\.ssh\mgu_root_key --list
```

**first-install** first reads, without changing anything, whether the
head unit's coding (`/dev/shm/rawcodingdata`) is missing (not valid, or the
default values) while no app manager runs: oapcontroller then never starts
MainApp, so the Store cannot install. It stops there (exit 2), before any
download, saying to restore the head unit's coding from a backup
(BimmerCode, E-Sys or ISTA) or have HU_MGU coded to the car, restart the
head unit and run the install again. A unit where that cannot be read
installs as usual.

It reads the `catalog` release of
`robertnisipeanu/mgu-store` (release/README.md), takes every entry but the
optional ones, and of those the renderer `mgu-render` (the Store draws its
screens with it) and the internet uplink `mgu-uplink` (`--no-renderer`,
`--no-uplink` leave them out; one the catalog does not list is skipped,
saying so, and one the deploy tool refuses is left out after the rest
installs), downloads each
artifact and checks its size and sha256 against the catalog; a mismatch
stops it before anything is sent. The deploy tool's own files come from the
published `mgu-deploy` artifact, each checked against its manifest; nothing
is built on the computer, and the Store's source package is built on the
unit. One ssh call sends them as a tar stream to
`/var/opt/mgu-deploy-kit-<pid>` (0700) and runs there: `mgu-deploy.sh
install --artifact ... --skip-older --yes` with the release's deploy tool
(it installs itself as `mgu-deploy`, keeps newer installed tools and apps,
does not build an installed Store version again) and `updater-sources`
with the default sources, mgu-store, idrive7-apps, idrive-apps and car-apps (kept
when the unit has its own); then removes
the folder. With `--token` a token is added (below), then `status` is
printed. Its last line
is `Restart the head unit to finish setup.` while any of
`mgu-updater.service`, `mgu-render.socket` and `mgu-uplink.service` is
installed but not active, or, on iDrive 7, while the running app manager
does not yet run the provisioning fallback that shows our apps' tiles,
or, on iDrive 8, while the deploy tool's `status` does not report the
Store's tile and those of the other apps listed in `custom_apps.json`
as shown (a Store not yet registered included); else `Setup is done`. When the fallback could not be turned on, it says
`The Store's tile cannot show:` and the reason (exit 1 when the services
run). After the restart line, at a
terminal (not under CI, nor with `--no-restart-prompt`), it asks
`Restart the head unit now? [y/N]`; `y` or `yes` restarts the head unit
the way the Store's Restart head unit does (`/usr/bin/nsm_control
--requestRestart 7 --normal`) and prints `Restarting the head unit.`;
any other answer ends it there. After `y`, no restart is requested while a
deploy tool run of this boot holds its lock, and none is taken when
`nsm_control` answers `[Error. <why>]`; either ends it with exit 1, saying so. Through
`install.sh` and `install.ps1` the question is asked at the terminal they
run in. Exit status: 0 done, 1 failed, 2 refused (the coding, or the deploy tool's own).

**first-install --from <folder>** takes the component list from a folder
`usb-repo` wrote (`<folder>/mgu-repo/mgu-store`: its `catalog.json` and the
artifacts beside it) instead of the `catalog` release. Nothing is
downloaded; each artifact is checked against the catalog's size and sha256
as it is read, before anything is sent, and the rest is the same. The
folder's `catalog.json` is read before the head unit is searched for; a
folder without one is refused (exit 2). For a computer that has internet
only away from the car:

```sh
node mgu-install.js usb-repo <folder>                                                   # at home
node mgu-install.js first-install --from <folder>/mgu-repo/mgu-store --identity <key>   # at the car
```

Before installing, the car is parked, on stable power (engine running or a
charger connected), and stays awake until the command finishes.

**uninstall** removes everything the Store setup put on the head unit,
with the deploy tool's `remove-all` ("Removing the Store setup" below). It
first lists what is installed (the apps and tools the deploy tool
installed, from any source, the updater's sources and tokens, the deploy
tool) and asks `Remove all of it? [y/N]`; `--yes` skips the question, and
without a terminal it removes nothing unless given `--yes` (exit 2). A
deploy tool on the unit without `remove-all` hands the job to the
published one, read like first-install's (or from `--from <folder>`),
which stays installed should the run not finish.
It ends with one line:
`Removed: nothing of the Store setup is left on the head unit.`;
`Removed. Restart the head unit to finish.` or, on iDrive 8 with apps
removed at the next start, `Restart the head unit to finish: <apps> and
the deploy tool go at its next start.`, either followed by the restart
question as first-install asks it; or `Not finished: <what> is still on
the head unit. Run uninstall again to finish.` (exit 1), or, when what
is left goes only after a restart, `… Restart the head unit, then run
uninstall again to finish.` and the restart question (exit 1).

```sh
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- uninstall --identity ~/.ssh/mgu_root_key
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) uninstall --identity $HOME\.ssh\mgu_root_key
```

**status** prints the deploy tool's report from the head unit: each tool
and app, each app's tile (`tile=provisioned`, `fallback` or `hidden`) and
what waits for a restart. It finds the unit like `first-install` and
changes nothing there (`mgu-deploy.sh status --read-only`). A deploy tool
without `--read-only` runs its plain `status`, which may repair things as
the updater's does at its start; a line after the report says so. Without
a deploy tool it says the Store is not installed (exit 1). Paste the
output when asking for help:

```sh
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- status --identity ~/.ssh/mgu_root_key
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) status --identity $HOME\.ssh\mgu_root_key
```

**token** adds a GitHub token for the updater: read from a hidden prompt
(not echoed), or from stdin when stdin is not a terminal and the script
came from a file, never from an
argument or the environment, never printed. It goes on ssh's stdin to the
installed deploy tool's `updater-token`; while the updater runs, `updater.js
check` then has it read its sources again. `--list [--json]` (id, label,
account; never a token) and `--remove <id>` (an id `--list` names) run
`updater-token --list [--json]` and `--remove <id>` with nothing on stdin.
A token added while the updater does not run is used once it runs.

**Downloads** go over https; a token goes to the GitHub API host only and
never to the host a download redirects to. A repository is read without a
token first, then with the one given to `--token`, then the GitHub CLI's
(`gh auth token`), then one typed at a hidden prompt.

**usb-repo** writes a local repository onto a stick for a car without
internet. Each input becomes `mgu-repo/<name>/` (names lower-case, safe on
FAT, exFAT and NTFS), which the updater reads as source
`usb:<label>/mgu-repo/<name>` (native/mgu-updater/README.md, "USB media"):

| Input | Folder | Written |
|---|---|---|
| `github:<owner>/<repo>` with a `catalog` release | `<repo>` | its catalog.json and every artifact, each checked against the catalog's size and sha256 |
| `github:<owner>/<repo>` with release assets `<id>@<x.y.z>.tgz` / `.mgu` | `<repo>` | a catalog of the newest of each id (the `.tgz` over the `.mgu`, titles from `mgu-store.json`), each asset checked against its size |
| `https://.../catalog.json` | `<host>-<folder>` | as a catalog release |
| a folder with `catalog.json` (a `dir:` publish) | its name | as a catalog release |
| a folder with `mgu-repo.json` (a checkout) | its name | the repository's files (git's tracked files, else all but `.git` and `node_modules`), which the unit builds |
| package files `*.tgz`, `*.mgu` | `local` | added to `local/`'s catalog by their content: an app (`package.json` flat, under `package/`, or a `.mgu`), a source package (`mgu-app.json`, `build: "unit"`), a tool kit (`component.json`), a renderer or tether package (`mguService`) as a tool providing its kind; of an id the higher version stays |

No input: `github:robertnisipeanu/mgu-store`. The folder of a `github:` or
https input holds `mgu-copy.json`, `{"copyOf": "<the input>"}`: the
updater then updates from it what that source installed
(native/mgu-updater/README.md, "Ids"). A written catalog is schema
2 with the source's fields (`build`, `requires`, `optional`,
`uninstallable`, `mguHmi`, `mguProvides`; apps and service packages from
releases or package files are `uninstallable`)
and each artifact beside it under a relative URL; an `.mgu` keeps its file
name and is listed as `<id>@<version>.tgz`, which the deploy tool installs
by its content. Each icon a catalog entry lists (`icon`) is copied beside
it as `<id>.png`, checked against its `iconSha256`, and the entry names
that file; an icon that cannot be read or does not match is left out,
saying so, and never stops the stick (an `https` icon stays listed for
the updater to fetch when online). A folder is written next to the old one and replaces it
once complete, so the stick holds the newer versions only; other folders
and the stick's other files stay. A root-service package of another
`mguService`, a folder over the updater's limits (catalog.json over 1 MiB, a checkout over
200 MB or 20000 files) or an artifact that does not match is refused.

## On the unit

```
mgu-deploy.sh check [--artifact <file>...]
mgu-deploy.sh install [--artifact <file>...] [--skip-older] [--other-source] [--leave <id>...] [--yes]
mgu-deploy.sh status [--read-only] [--json]   # --read-only: changes nothing
mgu-deploy.sh relay [<id>...] --yes           # a stale tool's files from the copy kept here, no install step
mgu-deploy.sh setup <id> --yes                # a tool laid again from that copy, its install step included
mgu-deploy.sh uninstall <id> [--yes]
mgu-deploy.sh remove-all [--json] | remove-all --yes
mgu-deploy.sh rollback <id> [--yes]
mgu-deploy.sh restore [name] [--yes]
mgu-deploy.sh backups
mgu-deploy.sh fallback <on|off|status|migrate> [--yes]
mgu-deploy.sh updater-token                   # a token on stdin
mgu-deploy.sh updater-token --list [--json] | --remove <id>
mgu-deploy.sh updater-sources                 # sources.json on stdin
mgu-deploy.sh sdk-donor [--json]
mgu-deploy.sh apply-pending                   # iDrive 8, at boot
mgu-deploy.sh relist                          # iDrive 8, at boot: our apps in custom_apps.json
mgu-deploy.sh verify                          # at boot: the tools updated for this start
mgu-deploy.sh remove-unused                   # at boot: files hooks handed over
mgu-deploy.sh appmanager [--json] | appmanager adopt [--yes]
```

`install` without `--artifact` takes every `*.tgz` and `*.mgu` in
`./artifacts` beside the script. Tools install before apps, `app-privacy`
first. `restore` needs `--yes`, or `YES` typed at a terminal.

### Layout

```
/var/opt/<id>/versions/<version>/        a tool's files and its component.json
/var/opt/<id>/current -> versions/<v>    the version in use (switched by rename)
/etc/systemd/system/<unit>               units; <target>.wants/<unit> for enable
/etc/recmgr-restartlist.conf             recmgr's restart list
/etc/crashhandler-restartlist.conf       the crash handler's restart list
/var/opt/mgu-deploy/versions/<v>/        the deploy tool itself (mgu-deploy.js, .sh, fallback_build.js, its
                                         boot units, oap_link.js, oap_pack.js)
/var/opt/mgu-deploy/current -> versions/<v>
/var/opt/mgu-deploy/mgu-deploy.sh        shim: runs current/mgu-deploy.sh
/var/opt/mgu-deploy/state.json           pending reboots, apps' uids, the last bounce
/var/opt/mgu-deploy/recmgr-at-boot.json  the recmgr list as it stood at this boot
/var/opt/mgu-deploy/crash-names.json     the names this tool added to the crash handler's list
/var/opt/mgu-deploy/recmgr-names.json    the names this tool added to recmgr's list, by section, and the firmware
/var/opt/mgu-deploy/lock                 the changing run's pid and boot
/var/opt/mgu-deploy/backups/<time>-<command>/, backups/stock/   (0700)
/var/opt/mgu-deploy/main.js              the fallback copy of the manager's main.js
/var/opt/mgu-deploy/inplace/request.json an in-place install request, while one is pending
/var/opt/mgu-deploy/verify.json          the tools checked at the next start; last-verify.json the last outcome
/var/opt/mgu-deploy/kept/<id>/<id>@<v>.tgz  iDrive 7: an app's installed package and the newest older one
/var/opt/mgu-updater/sources.json        the updater's sources, seeded (0600)
/var/opt/mgu-updater/credentials/        the updater's tokens: token-<id>, tokens.json (0600, folder 0700)
/var/opt/mgu-uplink/uids.d/<id>          a tool's uids that get internet
/var/opt/mgu-uplink/apps.d/<id>          an app that gets internet
/run/mgu-deploy/sdk-donor/               the donor bundle's readable copy and its oap-sdk module (sdk-donor)
/var/opt/mgu-deploy/id8/pending.json     iDrive 8: the queued app changes (queue/<id>@<version>.tgz their packages), and the updates MainApp-21 has yet to install
/var/opt/mgu-deploy/id8/last-apply.json  iDrive 8: what the last apply-pending did; trash/<time>/ what it removed
/var/opt/mgu-deploy/appmanager.json      what was taken over from IterioDev's App Manager; appmanager-removed/ its folder
/etc/systemd/system/mgu-deploy-apply.service   iDrive 8: applies the queue at boot (late.target.wants)
/etc/systemd/system/mgu-deploy-verify.service  checks the tools updated for this start (late.target.wants)
/var/opt/mgu-deploy/remove-when-unused.json    files hooks handed over that a process still ran
/etc/systemd/system/mgu-deploy-cleanup.service removes them at boot once unused (late.target.wants)
/usr/lib/oap-mainapp/preinstalled_apps/<id>@<version>.tgz
/usr/lib/oap-mainapp21/preinstalled_apps/<id>@<version>.tgz   iDrive 8
/usr/share/tm/prov/das_000.xml ... das_005.xml                 iDrive 8: provisioning, our apps' lines
/var/opt/public/oap/oap_12201/data/apps/<id>.json   an app's registry entry
/var/opt/public/oap/oap_12201/data/custom_apps.json the apps the fallback lists
/var/opt/public/oap/oap_12201/data/mgu-deploy-inplace.json the manager's in-place hook and its last answer
/var/opt/public/oap/oap_12201/data/mgu-deploy-guard.json   the MainApp guard for this boot (iDrive 7: the bounces' watch; iDrive 8: the copy's)
/var/opt/public/oap/oap_<uid>/           an app's home (source/, data/, security/, someipInterfaces/, ...)
```

Writes under `/` (units, the recmgr list, preinstalled packages) go through
one shell script per operation that remounts `/` read-write and remounts it
read-only on any exit; a `/` found read-write stays read-write.

### Head units

The tool tells the head unit by MainApp's folder: `/usr/lib/oap-mainapp`
is iDrive 7 (`ID7`), `/usr/lib/oap-mainapp21` iDrive 8 (`ID8`, IterioDev's
App Manager installs there). With both or neither, the running HMI decides
(`/proc/<pid>/comm`: `HmiMain3D` on iDrive 7, `Hmi8` on iDrive 8); else
the unit is unknown. The firmware is the first line of
`/etc/os-release-id-dlt` (`BMW MGU P18_23w44.2-1-3 mgu-high` on the
owner's car), else `/etc/os-release`'s `PRETTY_NAME`. `status` and `check`
print both and what decided; `status --json` has `unit: {hmi, firmware}`.

**Compatibility.** A component may name the head units it is for,
`"mguHmi": ["ID7"]`, `["ID8"]` or both: an app in its `package.json` (or
`mgu-app.json`), a tool in its `component.json` (`deploy/hu artifact`
keeps it). An app that does not is taken to be for the HMIs its rhmiData
has a UI for (`application.json`'s `uiDescriptions[].hmi`, else the folders
under `uiDescriptions/`). An install of one that is not for this unit is
refused before anything changes (exit 2: `oap-cardash 1.1.4 is for iDrive 8
(its rhmiData); this head unit is iDrive 7`); one that names none either way
installs. On a unit not known the install says mguHmi is not checked.
With `--skip-older` (a kit, `mgu-install.js first-install`) such an
artifact is skipped, saying why, and the others install.

**Another version of an installed tool.** An install of an older version,
or of any version with `--other-source` (the updater's install of a tool
another source installed), runs the `deactivate` of the version it
replaces first, with all of that version in place, as its removal does:
one that fails refuses the install (exit 2), and that version stays
current and runs its `activate` again. An older version runs it after a
firmware update too: the version it replaces may have changed the new
firmware's files through its own tool since, which the older one does not
know; one that fails there refuses the install (exit 2) and that version
stays current, its files only, needing setup (below). An update runs only
the new version's `activate`. Whichever it is, what the versions kept under
`versions/` installed and the new one does not list goes, as in a
rollback, in the install's own rootfs window: their running units are
stopped first (when recmgr has loaded them), the new version's list
entries go in, then its units, links and drop-ins, then the old units,
links, drop-ins and their limits go, and last their recmgr names no
installed tool has and the crash handler's names no installed tool wants.
An install that fails after that puts them back with the snapshot, starts
the units it stopped again, and runs the replaced version's `activate`
again.

### iDrive 8 apps

**Backend provisioning.** Telematics serves the das files until the car's
first sync with BMW's backend (**Update apps and services**). From then on
it serves the backend's provisioning
(`/var/opt/public/tm/tm_12000/data/prov/ProvSigned.xml`), which has no
section for our apps, and MainApp-21 gives an app with no section no
tile. So every app of ours the das files list, registered or with its
package in place, keeps a `custom_apps.json` entry with its das line's
flags, which the fallback copy gives it as its section. `apply-pending`,
every `install`, `status` run as root (the updater runs it) and `relist`
(run by the fallback's boot unit before MainApp-21) put a missing entry
back; an app with a queued removal is left out. An entry put back counts
from MainApp-21's next start. The copy records the sections it filled in
`oap_12201/data/mgu-deploy-listed.json` (`{pid, apps}`), and `status`
reports an app's tile as shown only when the provisioning Telematics
serves has its section (`tile=provisioned`) or the running MainApp-21's
copy filled it (`tile=fallback`); `status --json` lists those apps as
`fallback.listed_by_manager`.

MainApp-21 installs an app it finds in its `preinstalled_apps` when
provisioning, the six das files under `/usr/share/tm/prov`, lists it, at
its start. Provisioning reads the das files only at its own start, so a
change takes one of two paths.

**Live.** The fallback copy of MainApp-21's `main.js`, bound at boot by
`mgu-app-fallback.service` (from `mgu-app-fallback-id8.service`), carries
the in-place hook. When the running MainApp-21 started on it, `install`,
an update and `uninstall` are MainApp-21's own install, update or
uninstall of that one app, as on iDrive 7, and its tile appears or goes at
once. The package (`preinstalled_apps/<id>@<version>.tgz`) and the app's
das lines go in first, as `apply-pending` puts them (below), so every later
start has the app; its `custom_apps.json` entry gives it its provisioning
section whenever provisioning has none for it (the copy fills only a
listed app's empty section and never adds to `installable_apps`). `status`, run as root (the updater
runs it right after it installs the deploy tool), turns the fallback on
once, when a copy of this MainApp-21's `main.js` builds, with the crash
list's rules for remounting `/`; it reports `live_installs` in `status
--json`, and does not turn it on again after `fallback off`. A MainApp-21
the copy does not fit is tried again when its `main.js`, the deploy tool
or app-privacy changes (`id8-live.json`). From the next start on, changes
are live; until then they are queued. A
change the running MainApp-21 does not take (no hook, the request not
taken or refused, MainApp-21 restarted) is queued instead, with what was
placed for it put back; one its installer failed fails, rolled back, an
update with the app's folders as on iDrive 7 (below): MainApp-21 loads the
previous version from them at its next start. On a
MainApp-21 the copy does not fit, every change is queued. An app
uninstalled live goes on app-privacy's override list
(`local-only-apps.json`): provisioning lists it until the next start, and
a MainApp-21 restarted meanwhile would otherwise ask the backend for it.
MainApp-21 is never restarted.

The copy is built at every boot from the stock `main.js` and bound only
when its three anchors each occur once, app-privacy's patch applies to it
and it parses; otherwise the stock file stays in effect. Every edit in it
runs inside `try`/`catch`. oapcontroller wipes every app's ACLs and data
on the third MainApp-21 crash in a row (30 s up ends a row), so the copy
keeps a guard (`oap_12201/data/mgu-deploy-guard.json`): when MainApp-21
restarted within a minute of starting, or during a live change, the copy
behaves as the stock file for the rest of that boot, and changes are
queued, the status file saying why.

**Queued**, the way IterioDev's App Manager does (`appmanager-service/oap.js` in
[IterioDev/mgu-app-store](https://github.com/IterioDev/mgu-app-store)),
whose das edits and removal steps it follows:

- `install` queues the package (`id8/queue/<id>@<version>.tgz`, in npm
  format: one published so as it is, a source package built from the
  unit's own donor (MainApp-21's `preinstalled_apps`, then the installed
  stock apps; the apps provisioning lists as preinstalled custom apps
  excluded), any other one repacked with its files under `package/`), and
  reports the app `pending_reboot` with `installs at the next start`.
  The package gets what iDrive 8 needs to install it and show its tile,
  when it lacks it: the permission tables MainApp-21 requires, the
  certification service in its SOME/IP manifest (below), and an appletId. The appletId is chosen on the car at install time, from the
  ids its apps and the HMI already use: an update keeps the one the app
  has, a package's own is kept when it is free, otherwise the tool picks a
  free one and says so. When the tool cannot read the ids in use, it
  stops the install rather than guess.
  With app-privacy installed, its `apply` runs first and the app is
  refused when it fails; MainApp-21 is not restarted for it, and the patch
  is in effect from the start that installs the app. `fallback migrate`
  is refused.
- `uninstall` queues the removal (`removed at the next start`); for an app
  only queued, it drops the queued install. Installing the installed
  version again drops a queued removal.
- The first change queued installs `mgu-deploy-apply.service` (enabled for
  `late.target`, ordered before `telematics-platform` and `oapcontroller`,
  run only while `id8/pending.json` exists; listed in recmgr where the unit
  has the list), which runs `apply-pending` at boot. `apply-pending` is
  refused while MainApp runs. Each change: an install uninstalls the
  installed version first, puts the package as `preinstalled_apps/<id>@<version>.tgz` and the app's two
  lines into every das file (`<app supportedECUs="HU"
  initialPreferPreinstalled="true">` before `</installable_apps>`, its
  enable line after `x_call`'s); a removal moves its registry entry, home,
  personal copies and `/etc/vsomeip/<uid>_<uid>` to `id8/trash/<time>/` (the
  3 newest kept), takes its `uids.txt` line and diag status entries out,
  and its packages and das lines. A das file without those anchors fails
  that change before anything moves. The result is in `last-apply.json`
  and `status`.
- An update keeps the version it uninstalls (its registry entry, home,
  personal copies and vsomeip policy in its trash folder with their owners
  and modes, the ACLs of those under `/var/opt`, its uid, `uids.txt` line
  and package) listed as `unconfirmed` in
  `pending.json`, so `apply-pending` runs again at the next start. Before
  MainApp-21 starts then, an app with a registry entry was installed and
  stays; one without (MainApp-21 rejected the new package, for example a
  manifest naming an interface the head unit does not have) gets that
  version back as it was, the new package going to the trash, and
  MainApp-21 loads it at that start with its uid, data and tile. Nothing
  goes back over an entry, folder or other package of the app that is
  there again. Each update is looked at once; MainApp-21 is never
  restarted. A removal queued meanwhile applies to the version put back.

### Service packages

IterioDev's App Manager installs two root services as packages: an
npm-format tgz holding `package.json` `{ name, version, mguService }` and
an x86-64 program under its name (`appmanager-service/services.js`,
`pkg.js`). The tool installs a renderer as a tool of that name, so the
tool rules apply (layout, recmgr, start, update, rollback, uninstall); a
tether (`mguService` `tether`, `ipheth-tether`) is refused: mgu-uplink
drives the iPhone:

| `mguService` | name | unit | runs |
|---|---|---|---|
| `renderer` | `mgu-renderd` | `mgu-renderd.service`, enabled for `late.target` | from boot: `current/mgu-renderd --socket /run/mgu-renderd/renderd.sock`, on iDrive 8 with `--touch car --touch-area 0,76,2880,764` (`vm` with `/usr/bin/vminput`) |

The program and its `package.json` go to `versions/<version>/`, the unit
is the one his App Manager writes (root, `Restart=always`, the renderer
waiting for `/run/wayland/wayland-0`), and the name goes into recmgr's
lists. A fresh renderer starts once recmgr has loaded its entry, so at the
next boot on a unit with the list; a running one is not restarted by an
update (`keepRunning`, as his App Manager does). The tool provides its kind
("Capabilities"). Any other `mguService`, a name that does not match its
kind, a version that is not x.y.z, or a program that is not a 64-bit x86-64
ELF of at most 16 MiB is refused.

iDrive 7 and iDrive 8 both have `/etc/recmgr-restartlist.conf` and the same
recmgr. A unit without the list has no recmgr to restart it: nothing is written there, and units start,
restart and stop at once.

### IterioDev's App Manager

The Store replaces IterioDev's App Manager
([IterioDev/mgu-app-store](https://github.com/IterioDev/mgu-app-store),
`appmanager-service`): its app package `oap-appmanager` is refused from
any source, as is its tether. On a unit that runs it, it is:

| Its | Where |
|---|---|
| service | `/var/opt/appmanager/code/current/` (1.0.x: the folder itself), `appmanager.service` (daemon) and `appmanager-apply.service` (its queue at boot), both enabled for `late.target` |
| records | `state.json` (`installedFrom`: app → repository), `apply.log` (one JSON line per boot apply), `config.json` (`repos`, a token for a private one), `catalog.json` (what each repository listed), `pending.json` + `staged/` (its queue) |
| app | `oap-appmanager`, installed for MainApp-21 like ours (iDrive 8) |
| services | `renderer/mgu-renderd` + `mgu-renderd.service`; `tether/ipheth-tether` + `ipheth-tether.service` (on demand) |

`appmanager adopt [--yes]` takes it over, in one snapshot, nothing
reinstalled:

- its two units and its tether are disabled (their enablement links
  removed; the files stay), then stopped: `systemctl stop` also cancels a
  start the boot has queued for them, since its daemon rewrites the
  renderer's unit while it runs. A running one recmgr does not list is not
  stopped (that would restart the head unit): the adoption stops there and
  completes at the next boot, which starts neither (`oap-appmanager`
  pending, `adopted at the next boot`; `uninstall oap-appmanager` is
  refused until then);
- its queued app changes go into ours (iDrive 8): an install with its
  staged package while that matches its sha256, a removal as it is; its
  own app is not carried over; `pending.json` goes;
- its renderer becomes the tool `mgu-renderd` (`versions/<its version>/`
  from the program it runs), our unit written over its unit; a running
  renderer keeps running and runs ours from its next start. With our
  `mgu-renderd` installed before it, its unit is written over ours: ours
  goes back, and our tool runs from the renderer's next start;
- `/var/opt/mgu-deploy/appmanager.json` records the apps it installed that
  are on the unit (`state.json`'s `installedFrom`, and what `apply.log` last
  shows installed; not its app, its services or a system app) and the
  installs moved from its queue, with the
  repository it recorded for each (`from`), its repositories without their
  tokens (`url`, `index`, `private`, `enabled`, `isDefault`, and the ids
  its last catalog fetch saw there as `lists`), and the renderer and tether
  versions. The updater gives each app its origin from this.

`uninstall oap-appmanager [--yes]` removes it: it adopts first, then
removes its two units (and the tether's, unless the tool `ipheth-tether` is
ours), keeps `/var/opt/appmanager` as `/var/opt/mgu-deploy/appmanager-removed/`
(the one before replaced), and uninstalls its app (on iDrive 8 queued for
the next start). The apps and services it installed stay. A failure in
either puts its folder and the snapshot back, removes a renderer tool it
made, and starts its daemon again when it ran. `status --json` has
`appmanager`: `null` when it was never on the unit, else `{ present,
version, app, daemon, record }` (`record`: `appmanager.json`, with
`removed` once removed). `appmanager [--json]` prints the same.

### Capabilities

A tool may say which capability it provides, `"mguProvides": "<name>"` in
its `component.json` (`deploy/hu artifact` keeps it); a service package
provides its kind. Providers of one capability install side by side:
renderers keep to their own sockets and ivi ids, and mgu-render leaves the
community socket to another installed renderer
(`native/mgu-render/README.md`, "Beside other renderers"). A service
package, or a tool providing a capability, whose unit file is on the unit
but listed by no installed tool of ours (IterioDev's App Manager writes
`mgu-renderd.service` for its own renderer) is refused: the other manager
would write its unit back. `status --json` gives each tool's `provides`.

**idrive7-apps' own installer.** Its `mgu-app-install.sh` starts every
unit and drop-in it writes with `# added by mgu-app-install.sh`: its
renderer (`/var/opt/mgu-renderd/mgu-renderd`, `mgu-renderd.service` enabled
for `oapcontroller.service`, on `/run/mgu-renderd/renderd.sock`) and its
controller gate (`mgu-inputgate-guard.service`,
`mgu-inputgate-check.service`, `hmi.service.d/zz-mgu-inputgate.conf`, and
`mgu-inputgate.so`, `inputgate-guard.sh`, `inputgate.env`,
`inputgate.strikes` in `/var/opt/mgu-renderd`). A tool of ours takes them
over, in the install's snapshot: a unit or drop-in of the same name it
writes over (the gate from that repository's source does; its gate files
go too), and a tool whose unit serves the community socket's folder
(`RuntimeDirectory=mgu-renderd`) removes their renderer's unit, link and
program. Their renderer runs on until the next boot, when the tool's starts
instead. The apps it installed (registered, listed in `custom_apps.json`,
with its kit's `source/javascript/kit/app-spec.json`, not installed by this
tool) are `status --json` `idrive7.apps` (`[{id, version}]`), from which the
updater gives them their origin; `install` updates them and `uninstall`
removes them like any app.

### The deploy tool as a tool

`mgu-deploy` is a tool component like the others (`deploy/component.json`;
`VERSION` in `mgu-deploy.js` equals its version). Run from a staging
folder, every successful install or uninstall, and turning the
fallback on, installs the files it runs from into
`/var/opt/mgu-deploy/versions/<VERSION>/`, under the `component.json` beside
the script (synthesized from `VERSION` and its nine files when there is
none; run from `deploy/unit/`, the linker and packer come from `tools/`), switches `current` to it and keeps that version and the one `current`
pointed to before; a newer version already current stays. Run from
`versions/`, it is installed already. `state.json`, `backups/` and the
fallback copy stay beside `versions/`. `status` lists it from
`current/component.json` and prints its version (`"version"` in `--json`).

The updater updates it like any tool: `install --artifact
mgu-deploy@<v>.tgz` goes through the generic tool install, which manages
only `versions/` and `current`, and refreshes the shim. The running process
finishes on the files it started from; the next call through the shim runs
the new version, so `status --json` answers from the new `current` at once.
The updater probes `status --json` after its self-update and, when it gets
no answer, renames `current` back itself.

`uninstall mgu-deploy` is refused (exit 2): the deploy tool goes last in
`remove-all`, with everything it installed ("Removing the Store setup").
`restore` puts back what the tool changed and keeps the tool.

**Version rule.** The release sets `deploy/component.json`'s version and
`VERSION` with it (release/README.md, "Versions"). A change to a file under
`deploy/unit/`, `tools/oap_link.js` or `tools/oap_pack.js` adds its line
under `## Unreleased` in `deploy/CHANGELOG.md`; `deploy/hu`, `mgu-install.js`,
the tests and this README are not part of the artifact.

### Tools

A tool installs into `versions/<version>/` (files with their listed modes,
folders 0755) and `current` switches to it by rename. The version's files
are written to a folder of their own and synced to disk before it takes the
version's name, and the switch is on disk before the install goes on, so a
power cut leaves `current` on the version before or on the new one, whole;
the deploy tool installs itself the same way. Once it is up, only the
new version and the one `current` pointed to before stay; others are
removed. Units, enablement links and the recmgr list change only when their
bytes differ, then `systemctl daemon-reload`. Reinstalling the same artifact
changes nothing but adding a snapshot. A `current` that is a folder (an
earlier installer's) goes aside for the install and is removed once the new
version is up; a failed install puts it back as `current`, the way it returns
to a previous version.

**Drop-ins.** `dropins[{unit, name}]` adds a drop-in to a unit the tool does
not own, such as `hmi.service`: `/etc/systemd/system/<unit>.d/<name>` (the
folder made when missing, and removed again once a removal leaves it empty),
in the same window as the units, in the snapshot, and removed on uninstall,
so the unit is as it was. A drop-in of that name that no tool of ours
installed refuses the install (exit 2). Nothing is restarted for it: the
unit reads it when it next starts.

**Prune boundary.** A second update in the same boot prunes the version a
running service may still execute from (it keeps only the new one and the
previous `current`). Tools that start from `current/` on each start are
unaffected; a long-running process started from an older version keeps its
open files but cannot load new ones from that folder.

recmgr reads its restart list only at boot. A tool's `recmgr` names go into
both `[Whitelist]` and `[WhitelistExitSuccess]`, and so does the name of each
service and socket unit it installs (without `.service` or `.socket`; a
template's as `name@`) unless the firmware has that name: in
`[ForceRestartList]`, or a unit in `/lib/systemd/system` or
`/usr/lib/systemd/system`. A `recmgr` name is letters, digits and `:._+@-`
(an install with another is refused). Other lines and sections are kept as
they are. A name goes only into the sections that lack it, and
`recmgr-names.json` records, by section, the names the deploy tool put
there and the firmware it did so under. An update, rollback or uninstall
takes out the names no installed tool has any more, and of those only the
ones recorded for a section, never one the stock backup's list
(`backups/stock`) has in it: an entry the firmware has, such as `carplay`
for a tool that lists it, stays. After a firmware update the record counts
for nothing until the list is next edited. Without a record (tools
installed by an earlier deploy tool), a name the list has goes only when
the stock backup, taken on the firmware running, lacks it; with no such
backup it stays, said in the output.
`status`, run as root, adds the installed tools' names missing from the
list, as for the crash handler's list below.

Both lists are read as recmgr and the crash handler read them: from `#` on a
line is a comment, the rest is trimmed, `[name]` starts a section and any
other text is an entry; the file's line ending is kept. An edit that changes
nothing is not checked. A list with neither `[Whitelist]` nor
`[WhitelistExitSuccess]` (an empty or torn file) is never edited: the
install is refused (exit 2) and the file left as it is; a list with one of
them gets the other at the end. An install writes, each on disk before the
next: the tool's files under `/var/opt`, its list entries, then its units,
enablement links and drop-ins. An uninstall takes the units out before the
entries. A rollback or restore puts the snapshot's entries back first,
added to the list, then the units, links and drop-ins, and only then the
list as the snapshot has it.

A stopped service that recmgr does not list reboots the unit, which is why
nothing is stopped, started or restarted before recmgr has loaded its entry:
its name in both sections now and in the list as it stood at boot (the file
while it is older than the boot; once the tool writes it in a boot, the copy
it saved first, `recmgr-at-boot.json`). For each unit in `restart`:

- running: restarted when recmgr has loaded its entry; otherwise it keeps
  running the previous version and `status` reports the tool under
  `pending_reboot` until the next boot. With `"keepRunning": true` in the
  `component.json` (a renderer: stopping one with apps' surfaces up can
  restart the head unit) it is never restarted by an update or a rollback:
  it keeps the version it started with, reported pending with reason `the
  new version runs from its next start`;
- not running, on a fresh install: started under the same rule; otherwise
  left stopped and reported pending with reason `starts at the next boot`.

A unit enabled as a `.socket` starts under the same rule, when recmgr has
loaded its entry, else at the next boot (pending): the service it activates
can stop like any other. That service is left to the socket. A running
socket whose unit changed listens as the new unit says only once it
restarts, which systemd refuses while its service runs: it is restarted
when its service is stopped (and recmgr has its entry), else it changes
with the next boot (pending). `restart: []`
starts or restarts nothing. `oapcontroller` is never stopped or restarted: an
artifact naming it is refused.

**Post-install.** `"postInstall": ["<script>", "<arg>", ...]` names one of
the tool's files and its arguments: once the install is in place (after the
health check), `sh <root>/current/<script> <arg>...` runs as root from
`current/`, at every install of the tool, the same version again included,
for at most 5 minutes (`MGU_DEPLOY_POST_INSTALL_MS`). Its output is shown; a
failure or the time limit is a warning, and the install stands. mgu-render
makes its HMI page template this way.

**Health check.** Every unit the tool restarts or starts is read with
`systemctl show -p ActiveState -p NRestarts` right after, and again
`MGU_DEPLOY_HEALTH_MS` later (default 10 s): it must be `active` with
`NRestarts` unchanged. A oneshot with `RemainAfterExit` passes as `active`; a
failed one does not. When the check fails, `current` returns to the previous
version, the snapshot puts units and the recmgr list back, the unit restarts
on the previous version and is checked again (the result is printed), and
the install exits 1. With no previous version or folder, the new one stays current,
reported as not healthy, exit 1.

**Check.** `"check": ["<script>", "<arg>", ...]` names one of the tool's
files: once a new version runs (after the health check and
`postInstall`), it runs from `current/` as root, node for a `.js` file,
else sh, for at most 5 minutes (`MGU_DEPLOY_CHECK_MS`). Exit 0 says the
tool works. A failing check rolls back as a failed health check does, and
the tool's running services restart on the previous version (they ran the
new one for the check). mgu-render checks that it answers a client.

**At the next start.** A new version that runs only from the next start
(the tool is pending: a `keepRunning` service, a recmgr entry not loaded)
is checked then, when it has a `check` or services that start at boot. It
is noted in `verify.json` with the version before, and
`mgu-deploy-verify.service` (enabled for `late.target`, in recmgr's list,
run while `verify.json` exists) runs `verify` at the next start, once the
head unit has been up 150 s (`MGU_DEPLOY_VERIFY_AFTER_S`): the tool's
services that start at boot get the health check, then its `check` runs.
One that fails goes back to the version before (`rollback`), its running
services restarted whether `keepRunning` or not. Every entry goes from
`verify.json` before anything runs, so each version is checked once and
no start repeats it; the unit never restarts the head unit and exits 0.
`last-verify.json` (`status --json` `last_verify`) holds the outcome:
`{at, results: [{id, version, ok, error, previous, rolledBack}]}`.

**Activate and deactivate.** A tool may name a command its installs run,
`"activate"`, and one its removal runs, `"deactivate"`: `["node", <argument>...]`
(the Node this tool runs on) or `[<an executable file of the tool>,
<argument>...]`, non-empty strings without `..`, no shell. Anything else
refuses the install (exit 2). Each runs as root with this tool's
environment, in the version's folder, for at most 120 s
(`MGU_DEPLOY_HOOK_TIMEOUT_MS`), and its stdout and stderr go to this tool's
output, prefixed `<id> activate:`. When its last non-empty stdout line is a
JSON object, `"reboot"` is why the change needs a head-unit start (the tool
is then pending with that reason), `"status"` a line for the output, and
`"removeWhenUnused"` a list of files on `/` to remove once no process runs
them (below).

- `activate` runs on every install of the tool (the same version again too)
  and a rollback to a version that has one, once the version's files, units,
  the recmgr list and the restarts are done and `/` is read-only again (a
  command that writes to `/` remounts it itself), after the health check and
  app-privacy's apply and before `postInstall` and `check`. It must be
  idempotent. A tool it leaves pending is checked at the next start. A
  non-zero exit or the timeout fails the install: the units it started or
  restarted are restarted on the previous version (or stopped when their
  unit went with it) and a first install is removed. Whenever an install
  that ran `activate` is rolled back (a failed `activate` or `check`), the
  new version's `deactivate` runs first (one that fails keeps the new
  version current, recorded and its copy kept as an install does, and the
  install fails), then the previous version's `activate` runs again.
- `deactivate` runs before a removal changes anything, with the tool's units
  and files in place. It must succeed, doing nothing, when what it reverts
  is already stock (after a firmware update put the original files back,
  or when another version's `deactivate` reverted them first): it may run
  for a version whose changes are gone. A non-zero exit refuses the
  removal (exit 2) and the tool stays; a removal that fails after it is
  rolled back. Either way the tool's `activate` runs again. A restart it
  asks for stays pending under `mgu-deploy` (`<id> removed: <reason>`),
  since the tool's own entries go with it. A rollback runs the
  `deactivate` of the version it leaves the same way, before it switches
  (Rollback, below). `state.json` records the kept versions whose
  `deactivate` ran last (`deactivated`), which are not deactivated again,
  and those an install could not deactivate (`deactivate_owed`), which the
  next install or removal deactivates; a version made current again, or no
  longer kept, has neither. Each record is on disk (written by rename, file
  and folder synced) as soon as its hook has run, or, when the disk
  refuses it then, kept for the command's own save and said in the output;
  a snapshot put back keeps them. An install deactivates a kept version
  newer than the one it replaces and never deactivated (or one owed)
  before removing it: one that fails refuses the install (exit 2), naming
  it, and stays kept and owed, and the current version's `activate` runs
  again; a failure after it activates the version it replaces again too.
  Any install of the tool after a firmware update (the firmware recorded
  with the tool, `state.json` `tools`, differs from the unit's, or the
  tool needs setup since) leaves such versions kept and records them as
  deactivated, as it does the version an install of the same or a newer
  version from another source replaces, so no later install runs them; laying it
  again for another reason (a unit missing) runs them first, and one that
  fails stays kept and owed while the current version is laid again. A
  unit, link or drop-in another installed tool lists is never stopped or
  taken out.

**Stock files stay usable.** The deploy tool runs with umask 022, whatever
its caller's, and so does everything it runs; a file that must be root's
alone is written with its mode. After each `activate`, `deactivate` and
`postInstall`, it checks the stock files whose service runs as its own user
and fails, restarting the head unit at every start, when that user cannot
use them: `/usr/bin/carplay` and `/usr/bin/aapd` must be readable and
runnable by group and others, `/etc/aapd.conf` readable. One that lacks such
a bit gets it added to its mode (the rest of the mode stays), and one not
owned by root:root gets root:root, in a rootfs window, with a warning
(`warning: <id> activate: /usr/bin/carplay is 0700 0:0, which its service's
user cannot run: it becomes 0755 0:0`). Only a regular file on `/`'s file
system is touched: none through a symlink, in its path or itself, and none
a mount covers. When the window fails (`/` not read-only after it), the hook
fails as a non-zero exit does, after its result (restart reason, files
removed once unused) is recorded; the install fails after a `postInstall`.

**Files removed once unused.** A hook that replaced a binary a process still
runs keeps the old file linked (an unlinked file a process holds keeps `/`
from going read-only) and hands it over with `"removeWhenUnused": [<absolute
path>...]`; after a removal nothing of the tool is left to remove it. A
file no process runs (no `/proc/<pid>/exe` is its inode) is removed at once,
in a rootfs window. One a process runs waits in
`/var/opt/mgu-deploy/remove-when-unused.json` (`status --json`
`remove_when_unused`): `mgu-deploy-cleanup.service`, installed, enabled for
`late.target` and added to recmgr's list on the first such file, runs
`remove-unused` at each start while that file exists (it waits for the
deploy tool's lock and always ends as succeeded), which removes what no
process runs any more and keeps the rest for a later start. Only regular files are removed; a
folder, a symlink, a relative path or one with `..` is left as it is, said in
the output. Every snapshot holds the unit, its link and the list, so a
failed install or removal puts them back with the recmgr list.

`uninstall <id>` stops the tool's running units (when recmgr has loaded
them), removes its units, links, drop-ins and the recmgr names no other tool
lists, those of every version kept under `versions/` as well as the current one's
(after the current version's `deactivate`, that of each kept version whose
`deactivate` is due, oldest first: one newer than the current version and
never deactivated, which an earlier deploy tool's rollback left and which
reverts what only it set up, or one an install could not deactivate; a
refusal by any of them refuses the removal),
and the whole `/var/opt/<id>`: besides `versions/` and `current`, a tool's
own config there goes too, named in the output (the updater's
`sources.json` and `credentials/`, the uplink's `local.conf`, `uids.d/` and
`apps.d/`). A `.wants` folder the tool
created is removed once it is empty; folders that were there before stay.

### Rollback

`rollback <id>` switches a tool's `current` to its one other kept version
(`status --json` names it as the tool's `previous` when it is older).
With no other version, or more than one, it is refused (exit 2, listing
them). It snapshots first, then runs the `deactivate` of the version it
leaves, with all of it in place, as a removal does: one that fails refuses
the rollback (exit 2), that version stays current and its `activate` runs
again. It switches `current`, and takes out what the version it leaves
installed and the one it goes to does not list: units (stopped first when
recmgr has loaded them), enablement links, drop-ins and their limits, its
recmgr names no installed tool has and the crash handler's names no
installed tool wants, units before list entries. Then it restarts that
version's `restart` units under the same recmgr rules and health check, and
runs its `activate` (a failed one runs that version's `deactivate` first;
one that fails too keeps it current). A failed check, apply or `activate`
puts the snapshot back (`current`, the units and lists), starts again the units it stopped,
restarts again, runs the left version's `activate` again and exits 1. When
recmgr has not loaded the entry the switch still happens and the tool is
reported pending. Units both versions list are not rolled back: they run
from `current/`, so they stay as the newer version installed them, and an
install of the wanted artifact changes them. The units, links and drop-ins
the version it goes to lists that are missing (a change to another version
took them out) are laid again from the copy kept with it
(`kept/<id>/<version>/`), its recmgr names first, in one rootfs window, and
its `restart` units and enabled sockets among them start as at a first
install; one without a copy says which are missing, and an install of its
artifact lays them again.
`rollback app-privacy` also runs
its `apply` (below). `rollback mgu-deploy` switches `current` and exits; the
shim and the updater run that version from the next call.

An app (iDrive 7) goes back to the newest kept older package: the app
manager takes no older package for an installed app, so `rollback <app>`
uninstalls it and installs that package, carrying its data folder over
(owned by the uid it runs as then). When that install fails, the version
that was there is installed again from its kept package (exit 1). Every
app install keeps its package, and that of the version it replaces (from
`preinstalled_apps`), in `kept/<id>/`; only the installed version and the
newest older one stay, and an uninstall removes them. `status --json`
gives an app's `previous` (null on iDrive 8, where it is refused).

`status --json` lists as `lost_apps` the apps this tool installed
(`state.json` `apps`) that MainApp's registry no longer has while the
installed version's package is kept, as oapcontroller's wipe leaves them;
none while another run holds the lock. The updater installs them again
from that package. An uninstall (also one the MainApp guard stopped) and a
restore that removes an app (once its bounce is done or stopped) drop
both the app's record and its kept packages, so an app removed on purpose
is never one. An uninstall that
fails and is rolled back keeps both, and its registry entry is back.

### HMI parts on iDrive 7 units that report iDrive 8

At an install MainApp copies, of an app's `rhmiData`, the first
`uiDescriptions` entry and the `variantGroups` whose `hmi` lists the HMI
Telematics reports (`Provisioning.provisioningAttributes.hmiVersion`: `2`
is ID7, `3` ID8), and for the brand its coding names. Some iDrive 7 units
report `3`: MainApp then installs an app's iDrive 8 UI, or nothing for an
app with only iDrive 7 parts, and that app gets no tile.

On an iDrive 7 unit (MainApp in `/usr/lib/oap-mainapp`) that reports
another HMI than ID7, the deploy tool reads `hmiVersion` and the brand the
way MainApp does and, before MainApp gets an app's package, lists that HMI
in `rhmiData/application.json` wherever the package lists ID7 and removes
it everywhere else, so MainApp installs the iDrive 7 parts. Units that
report ID7, and iDrive 8 units, get packages as they are.

`status` (as root) compares each installed app's
`rhmiData/{uiDescription,strings,resources}` with the iDrive 7 parts of
its kept package, merged as MainApp merges them, and writes the files that
differ (owned by 12201, strings `0660`, the rest `0644`). The tile then
shows from the next start of the head unit, which is pending. `status
--read-only` and `status --json` list what differs as `hmi_parts`. An app
found in order is not looked at again until its files or package change.

On iDrive 8, `lost_apps` lists the apps placed at a start for MainApp-21
(their package in `preinstalled_apps`, their das lines) that it did not
install because Telematics serves BMW's backend provisioning
(`ProvSigned.xml`), which does not list them, once the running manager
runs the in-place hook. An app with a change queued, an update applied at
the start (it goes back at the next one) and IterioDev's App Manager are
left out. The updater installs them in place from that package.

### app-privacy

The `app-privacy` tool must be in effect before the manager sees an app
(`native/app-privacy/INTEGRATION.md`). After installing or rolling back the
tool, the installer runs its `patch_mainapp.js apply --json` and bounces the
manager when it reports `changed` or `restartNeeded`; on iDrive 8 it bounces
nothing and reports app-privacy pending until the next start.

An install with an app to install or update, on an iDrive 7 unit where the
running manager can list no app of ours (the fallback's unit absent,
`main.js` not bound, `custom_apps.json` listing nothing, no app of ours in
its registry, none of the retired installer's leftovers: a first install,
`mgu-install.js first-install` among them), leaves that bounce to the
app's: the fallback goes on with the app, so the app install bounces the
manager anyway, and the manager restarts once, with the patch, the
fallback and the app (`app-privacy: the app manager loads it at the app
install's restart`). Until then the manager runs the stock code it
started with, which lists no app of ours, and a manager that restarts
meanwhile loads the patched bundles. A bounce still owed when the install
ends (it failed, say) is made then; a run cut short leaves the patch on
disk for the next start of the manager, and the same install run again
bounces once. When `apply` fails,
`current` returns to the previous version and its `apply` runs again (exit
1); with no previous version the tool stays installed and the output says
the patch is not in effect, so app installs are refused until `apply`
succeeds.

An `apply` that leaves out optional edits this MainApp has no place for
(native/app-privacy/README.md, "Required and optional edits") succeeds:
app installs go ahead, and the output names them in one line, once per run,
`app-privacy: 11 of 12 privacy edits applied; skipped: update-availability sweep`.
`status` shows the same for app-privacy's last run, and `status --json`
carries its record (`/var/opt/app-privacy/edit-record.json`) as
`app_privacy_record`, null without one.

`uninstall app-privacy` is refused while any app of ours is installed (a
registry entry whose source `package.json` has `"mguLocalOnly": true`; an
entry or source that cannot be read counts). Otherwise it runs `revert
--json` first, which puts the stock bundles back (bouncing the manager when
they changed); a failed revert refuses the uninstall and the tool stays.
With the fallback copy bound over `main.js`, the revert runs on the copy and
again, with the copy unbound for that run, on the stock `main.js` under it.

### Bouncing the app manager

Bouncing the app manager is killing its node child; oapcontroller respawns
it. oapcontroller counts every death of that child as a crash and forgets
the count only once the respawned child has stayed up past its alive timer
(about 33 s after the respawn). A third death inside that window makes it
treat MainApp as corrupt: it reports that to the backend and deletes every
installed app, every app's data and MainApp's data. A genuine crash counts
too.

So every bounce the tool makes (an app install or update the running
manager does not make in place, uninstall, restore, fallback on/off, the
app-privacy apply, rollback, the migration of the retired installer's
leftovers) waits until the running child has been up
60 s (`MGU_DEPLOY_BOUNCE_MIN_UP_S`; its start from
`/proc/<pid>/stat` and the boot time, from `/proc/uptime`) and the last
bounce, recorded as
`lastBounceAt` in `state.json` by every invocation, is as long ago. It never
refuses: it prints how long it waits and why, waits, and looks at the
manager again (a respawned child restarts the wait). With no manager
running there is no bounce and no wait. This is why an install can pause for
up to 60 s. The rule lives only here: the updater adds no timer of its own
and gets the spacing by calling this tool.

**MainApp idle (iDrive 7).** Every bounce also waits until MainApp's install
worker (the node child running `src/AppManagement/AppManagement`) has not
run for 5 s (`MGU_DEPLOY_IDLE_QUIET_S`), for at most 3 minutes
(`MGU_DEPLOY_IDLE_MAX_S`). An app update deletes the app's registry entry and
writes it again later in the worker's run; a restart in between loses the
entry, and MainApp installs the app again from its firmware package under a
new uid. Still busy at the bound, MainApp is not restarted, and the run's
later bounces do not wait again. What needs the restart takes effect at the
next start of the head unit (`mgu-deploy` pending for the rest of the boot);
an app install or update that needed it fails and is rolled back, to be run
again later.

**The MainApp guard (iDrive 7).** After every bounce the respawned child
is watched until it has been up 60 s (`MGU_DEPLOY_GUARD_WATCH_S`), so a
manager that crashes right after a bounce never reaches the third death.
One that dies before turns the guard off for the rest of the boot:

- the run stops where it is (exit 3, `… stopped here: what this run
  changed stays`). Nothing is rolled back: that would write `/`, the
  registry, `custom_apps.json` and app folders while the next manager
  starts. What it placed and listed is taken up at the next start of the
  head unit. Only this tool's own records follow what the run did: an app
  install stopped once its package is placed records that version and keeps
  its package; an app removal or a restore's removal stopped counts as done
  (the app's record and kept packages go); a reinstall stopped (an app
  rollback, an install afresh) keeps the app's record at the version of the
  install under way (its fallback install's, when that one was), with that
  package, and its data folder: put into the app's home when the app is
  installed, else recorded in `state.json` (`data_stash`, below); a
  `remove-all` stopped prints its result, what it removed and what is
  left; a boot check (`verify`) stopped records its outcome, reports the
  tool it was rolling back as that tool is now, keeps the tools it had not
  checked due for the next start, and exits 0. An unmount that fails is
  said and the run still stops. A hook's stock-file fix runs right after
  the hook, before any bounce, and never bounces;
- `main.js` and `CertificateManager.js` are unbound, so the next manager
  starts on the files under them as they are. Until the next start nothing
  binds them again, nothing bounces, and app-privacy is not applied: an
  apply is left to `app-privacy.service` at the next start (app-privacy
  reported pending). The fallback's boot unit binds the copy again then;
- app installs, removals, rollbacks, `fallback migrate`, `restore` and the
  removal of app-privacy or IterioDev's App Manager are refused (exit 2,
  `… waits for the next start of the head unit: <why>`); `remove-all`
  removes nothing and its result names everything as left, with a
  restart (exit 1). Other tools still install.

Every data folder a reinstall sets aside (`.mgu-deploy-data-<id>-<pid>`
beside the homes) and does not put back, stopped or failed, is recorded in
`data_stash`, each app's folders oldest first. The newest goes into the
app's home once the app is registered again, whoever installed it (the
updater's reinstall, an install from the Store, or the app manager by
itself at its start): by that install, else by the next changing run or
`status` run as root (not while the guard is off), and only while the app
has no data folder or an empty one, the home and data folder never
followed through a link. An install within a reinstall of the app takes
none: the reinstall puts back the folder it set aside itself. An app with
data of its own keeps it, and its folders stay recorded, said once. Only
an explicit removal of the app removes them, all of them: an uninstall, a
restore that removes the app, `remove-all`. A folder no record names is
left as it is.

The guard file (`oap_12201/data/mgu-deploy-guard.json`, `{boot, bounce,
watch, off}`) is written before the bounce and when the watch starts. A
run cut short while it watched leaves its watch there: once a manager runs
again, the next changing run, or `status` run as root (under the lock, when
free), finds the watched manager gone and the running one started before
the watch would have ended, and turns the guard off. The fallback copy reads the file as it loads: a load whose
process started within the watch of the first manager after the bounce, or
of the one this tool watched, runs as the stock file for the rest of the
boot (no provisioning fallback, in-place hook or queue order; its hook's
status file says `off`), which covers the manager oapcontroller starts
before this tool sees the death. `status --json` gives the reason as
`mainapp_guard`. oapcontroller is never restarted.

### Apps

The app manager installs our apps itself.

- **Precondition.** The app-privacy patch must be in effect before the
  manager sees an app: without `/var/opt/app-privacy/current/patch_mainapp.js`
  an app install is refused. The installer runs its `apply --json` and
  bounces the manager when the patch changed or the running manager predates
  it, or, where the manager can list no app of ours, leaves that to the
  app's bounce (app-privacy, above).
- **Coding.** On iDrive 7 and 8, oapcontroller starts MainApp only when the
  head unit's coding (`/dev/shm/rawcodingdata`) is valid and is not the
  default values (with the default values, its journal says only `Coding
  base: Default values flag is set, default values will be used`). With no
  app manager running and such a coding, an install with an app to install
  or update is refused (exit 2) once its artifacts are read and checked,
  before app-privacy's check and any change, telling the user to restore
  the head unit's coding from a backup or have HU_MGU coded, restart it and
  install again.
  Tools install as usual.
- **Fresh install.** The manager installs an app it has no registry entry
  for: a full install from `preinstalled_apps` (its someip interfaces and
  their ACLs, its folders, its CertificateManager keychain, and the lowest
  uid with no registry entry and no quota). Provisioning does not list our
  apps, so they are listed through the provisioning fallback (below). In
  order: app-privacy's apply (and bounce); the package to
  `preinstalled_apps/<id>@<version>.tgz` (other `<id>@*` / `<id>-*` packages
  removed in the same rootfs window), before the app becomes installable,
  since app-privacy decides an app being installed by its package; the app
  added to `custom_apps.json`, the fallback turned on when it is off (said in
  the output), its copy rebuilt and bound; then the running manager installs
  it in place (below), or else one bounce and the restarted manager installs
  it because the fallback lists it. The installer then waits (up to 10
  minutes) for the manager's registry entry with an `installationSource`
  (MainApp 8.1.1 and 8.2.10 record none), the
  source at the new version and the keychain, and records the uid the manager
  chose. The tool writes no registry entry, app folder or credentials of its
  own.
- **Update.** The app must have its registry entry, a matching source and
  `someipInterfaces/acl.json` (without it the manager cannot start the app;
  exit 2, "broken install; uninstall then install"). After the app-privacy
  apply, the new package replaces the old one in the same window,
  `custom_apps.json` lists the app, and the manager's update takes the newer
  package, keeping the uid, the data and the keychain: in place (below), or
  else the entry's `installationSource` is re-seeded as null (uid and
  provisioning cache kept) and one bounce lets the restarted manager update
  it. MainApp 8.1.1 and 8.2.10 update no app at their start: after the bounce, the
  restarted manager updates it in place. A running manager on older bundles than `main.js` (the copy, when
  bound) and `AppManagement.js` hold is bounced before the new package is
  placed, and the restarted one updates the app in place. The package of
  an update is placed only once the manager has been up the bounce minimum,
  whatever restarted it (this bounce, app-privacy's, a boot): its start-up
  provisioning pass, which updates an app marked `PREINSTALLED` from a
  newer package, runs once provisioning reaches it, normally within seconds
  of its start, and nothing on the unit tells when it has run; the output
  says why it waits. An update the manager makes while it starts
  removes and inserts the app's tile while its start-up insert of that tile
  may still run, which can leave the HMI without the tile until the head
  unit restarts. Only a higher version installs; the same version is
  reported as already installed (exit 0), a lower one is refused.
- **Fallback lost.** On iDrive 7, an install in which every app is already
  current, while our apps are listed in `custom_apps.json` and the
  fallback is not active (its unit missing, or `main.js` not bound
  to the copy), turns the fallback on again and restarts the manager once,
  under the bounce rules (not when it already runs the copy), so the tiles
  show. While `vsomeipd.service` or
  `hmi.service` is not running, a restarted manager could not start, so it
  is not restarted and the boot unit lists the apps from the next start.
  A copy that does not build leaves the fallback off, the install stands,
  and `status --json` gives the reason as `fallback.refused`.
- **Unlisted apps.** On iDrive 7, an app of ours (`mguLocalOnly`) the
  manager has registered from any source, its own reinstall from
  `preinstalled_apps` included, that `custom_apps.json` does not list has
  no tile. `status` run as root and every app install list it, and its
  tile shows from the manager's next start (with the fallback lost, once
  an install turns it on again). An install in which every app is current
  lists it and restarts the manager once, as for a lost fallback; so does
  one after a run that listed an app while the running manager was up.
- **Start type.** `custom_apps.json` lists every app with
  `-appStartType` `manually`, or the value its `package.json` names in
  `"mguAppStartType"` (`autostart`, `lum` or `manually`; any other value
  refuses the artifact, exit 2). An `autostart` app starts with the
  platform, the manager starts it again when it stops, and it is never
  stopped for being inactive in the background. The type takes effect with
  the manager's install of the app.
- **Unmarked apps.** Before the manager is asked, every app `custom_apps.json`
  lists that runs from a package without `"mguLocalOnly": true` (one the
  retired installer put there) is added to app-privacy's override list,
  `oap_12201/data/local-only-apps.json`, and the installer names them.
  Entries already there stay, and a rolled-back install keeps the list.
  Without it app-privacy treats such an app as BMW's: the manager asks BMW's
  app repository for its version at each start, and the failed request
  holds every install behind its network-retry delays (40 s, then
  doubling).
- `base.json`'s `appManagement.ignoreSignatureFailure` is reported by `check`;
  only the migration of the retired installer's leftovers (below) writes it,
  back to `false`.

**In place.** The fallback copy of `main.js` carries a hook through which
the running manager installs, updates or uninstalls one app itself, with
the calls it makes at start: `install(<id>)`, or `update(<id>, "PLATFORM")`,
which takes the newer preinstalled package, and `uninstall(<id>)`, the call
its backend's removal makes. Each one touches only that app: an update
stops it, replaces its source, generates its SOME/IP interfaces and ACL
again and registers it again, which inserts its tile again; an uninstall
stops it, drops its SOME/IP permissions, unregisters it, which takes its
tile off the HMI, and removes its registry entry and folders. The manager,
the other apps and their tiles keep running; there is no bounce.

- Once MainApp has initialized, the hook writes
  `oap_12201/data/mgu-deploy-inplace.json` with the manager's pid and start.
- The installer uses it when the running manager wrote it and started after
  its `main.js` (the copy, when bound) and `AppManagement.js` were last
  written, so it runs the copy bound now. A manager younger than the bounce
  minimum gets until then to write it, which a bounce would wait for anyway.
- The request is `/var/opt/mgu-deploy/inplace/request.json`, root's, 0644 in
  a 0755 folder: `{id, app, version, action: "install"|"update"|"uninstall",
  notAfter}`.
  The hook reads it each second, only from a folder and file owned by root
  (or the manager) that no group or other user can write, and takes it
  until `notAfter` (20 s, `MGU_DEPLOY_INPLACE_ACK_MS`). It answers in its
  status file with the request's id: `running`, then `done` or `failed`; or
  `refused` (expired, malformed, or the app's registration does not match
  the action). One runs at a time, behind the manager's own installs. The
  installer removes the request once it is taken or expired.
- The install is done when the hook says `done` and the manager's registry
  entry, source and keychain show what a bounced install is checked for; an
  update keeps its uid.
- The hook traces the manager's installer (`AppManagerStub`): each install,
  update and uninstall it queues, each call it runs in its AppManagement
  child, and that child's start, with times; and whether a network-retry
  delay or an NSM resume is pending. While the request runs, the status
  file carries the trace. Every 15 s (`MGU_DEPLOY_INPLACE_REPORT_MS`) and
  when the request ends, the installer says from it where the app is
  (not yet handed to the installer, in its queue, installing), what else
  runs, and the child's start, in seconds since the request was taken:

  ```
  the app manager is on it (15s): in the installer's queue since +0s; update other_app running for 15s; AppManagement child started +0s to +3s
  the app manager done after 21s: installing since +16s, ended +21s; update other_app ran until +16s; AppManagement child started +0s to +3s
  ```
- When the manager's own install or update rejected the app in its
  installer (not its AppManagement child or channel failing), the install
  fails at once (exit 1, rolled back) with the manager's reason in one
  line, and no bounce to install it: a restarted manager runs the same
  install, and the bounce stops every app. An update the manager rejects
  (a manifest naming an interface the head unit does not have, say:
  `UPDATE_FAILED`) has already unregistered the app, taking its tile, and
  removed its `source/`, `someipInterfaces/`, `rhmiData/` and
  `rhmiDataStartWidget/`. Before every update the installer copies those
  folders aside with their owners, modes and ACLs; the rollback puts back
  the ones that changed and restarts the manager once, which loads the
  previous version with its uid, data and tile.
- When the manager never had the install in hand (no hook, the request not
  taken, refused or failed, or the manager restarted meanwhile) the
  installer says why and installs through the bounce above, under the same
  spacing. A fresh app the manager has installed by itself once that wait
  is over (a manager restarted by app-privacy's apply installs it from
  `custom_apps.json` at its start) needs no bounce, unless the manager
  failed the request for a reason other than `APP_ALREADY_INSTALLED`.
  Likewise an update the manager failed as `APP_ALREADY_UPDATED` with the
  new version in place needs no bounce: a provisioning pass updates an app
  still marked `PREINSTALLED` from the newer package before the request.
  Once the manager has taken the request, an
  install not done within 10 minutes, or a result that does not match,
  fails like a bounced install that is not done (exit 1, rolled back), with
  no bounce, which could cut the manager's install short.

**Keychain wait.** The manager's install creates the app's keychain with
`/usr/lib/oap-mainapp/src/scripts/CertificateManager.js`, run as the app's
uid: the head unit's certificate service creates it, the script gives up
after 30 s with nothing on stderr, and the install fails. Each app install
binds `/var/opt/mgu-deploy/CertificateManager.js` over it: the same script
waiting 115 s, which, when it gives up or cannot write the keychain, says
on stderr the states the service reported and when, the security folder's
files before the request (`name:uid:size`) and its uid. The manager puts
that in the install's error, and the installer's reason carries it. The
manager stops the script after 35 s; app-privacy 1.5.0 gives our apps 125
s. When the stock script is not the one these edits anchor on, it runs as
it is (said in the output); so does any error putting the copy in place,
which never fails the install. The copy is bound until the next start of the
head unit, and again at the next app install; `fallback off` removes it.

**The certification service.** MainApp's install has the certification
service (cadaemon) create the app's keychain, called as the app's uid; the
car's SOME/IP security lets that call through only when the app's
permissions, which MainApp makes from the proxies of its SOME/IP manifest
(`package.json` `oapAppSettings.someipManifest`, `manifest.json` by
default), name `de.bmw.infotainment.certification.Certification`. A
package whose manifest lacks it is prepared with it added (`"*"`, as the
stock apps name it), and a source package is built with it; without it no
answer comes and the install fails at the keychain. iDrive 8's MainApp-21
installs the same way, and its packages get the entry too. A package with
no manifest is left as it is.

**Interfaces the head unit lacks.** MainApp makes those permissions from
its interface database, the firmware's
`/etc/oap/someip/someip-interfaces.json`, and refuses an app whose manifest
names an interface the database does not hold (`IFConfigGenerator::generate()
Interface … not found`). Older iDrive 7 firmware holds fewer interfaces: no
iDrive 8 HMI interfaces (`hmi.entrypoint2`, `hmi.remote2`,
`hmi.resourcemanagement2`, `oap.PrivateEntryPoint2`). On iDrive 7 a package
whose manifest names such interfaces, as proxies or services, is prepared
with them taken out, and the output names them; the certification service
stays. iDrive 8 installs the manifest as it is.

**Interrupted installs.** Each app install is recorded in `state.json`
until it finishes or is rolled back: `inflight` names the app and the run,
`placed` the version and checksum of the package placed, kept while what
an interrupted install left is listed. Before an app install, an app listed
in `custom_apps.json` without a registry entry (one that cannot be read
counts as there) is unlisted and its `preinstalled_apps` package removed
only when this tool provably put them there: the newest snapshot holding
the app's registry entry is this tool's install of it, which found the app
not listed, not registered and without a package; the one package on disk
is the one that install placed, with the recorded checksum when there is
one; and a run `inflight` names is gone (or from another boot). A
`cleanup` snapshot of the listing and the package is taken first.
Anything else stays, and the output says so.

`uninstall <id>` removes the app from `custom_apps.json` first, so the
manager does not install it again meanwhile, then asks the running manager
to uninstall it in place (above), which takes its tile off the HMI at once,
unless its home's `package.json` does not name the app (the home then stays,
listed as a leftover, and the manager is not asked to remove it).
The uninstall is done when the hook says `done`. Then whatever the manager
left goes: the registry entry, the home, the preinstalled packages; the
fallback copy is rebuilt (written only when its bytes change), the app's
npm cache entries are removed and its quota cleared. When the manager did
not uninstall it (no hook, the request not taken, refused or failed, not
done within 10 minutes, the manager restarted, or a home not provably the
app's), the installer says why, removes the same files and bounces the
manager once, under the spacing above, so the manager neither reinstalls
the app in between nor asks the backend for it; the manager's own ACL, UI
and status records for the uid then stay, and the tile stays on the HMI
until the head unit's next start. With no manager running there is nothing
to ask and nothing to bounce. Anything left behind is listed. The snapshot and the
rollback on a failure are the same either way.

### Source packages

A source package is a tgz with `mgu-app.json` at its root
(`tools/oap_link.js` has the format): the app's staged package tree
without `javascript/app.js`, its modules (the entry first), and the
require names its modules take from the oap-sdk. `install` and `check`
build it in the staging folder before anything changes ("bundle" mode):
the first **stock BMW donor** on the unit that resolves every name to exactly
one module id, searched in the firmware preinstalled packages
(`/usr/lib/oap-mainapp/preinstalled_apps/*.tgz`, their `javascript/*.js`)
and then the installed stock apps' bundles (`oap_*/source/javascript/*.js`).
A package with any `mguLocalOnly` field, or named in the manager's
`local-only-apps.json` or `custom_apps.json`, is excluded from both searches.
Root splits the donor in a separate Node process as uid/gid 65534 (overrides:
`MGU_DEPLOY_SPLIT_UID` and `MGU_DEPLOY_SPLIT_GID`, positive numeric ids),
with a 30 s timeout and a 64 MiB output cap. The child captures the module
map without calling module functions and returns JSON containing their
source text and dependency tables; root links those strings without
evaluating the donor. Non-root host builds use the same string form in
process. The closure of those names is copied with the donor's ids, the app's modules follow from id 10000, and `javascript/app.js`
and `javascript/build.json` are written, `node --check`ed and packed
(`tools/oap_pack.js`). When the tree ships no file at its `package.json`
`main` (`javascript/<file>.js`), the build writes there the entry point of
the donor's own package (the file that package's `main` names: in a
preinstalled tgz, or beside an installed app's `javascript/`; the other
donors' packages next), with a `runnerConfig.json` beside it naming the
app's bundle (`./app.js`) and data folder (`../../data`); when no donor
package has one, a loader that requires `./app.js`. `build.json` names where
it came from. The result installs as any app. The same
inputs give the same bundle on the unit and on the build machine. An app
already installed at that version is not built. No donor, a module that
does not compile, or a bad `mgu-app.json` refuses the artifact (exit 2,
nothing changed), saying what each donor lacked. `"internet": true` in
`mgu-app.json` becomes `"mguInternet": true` in the built `package.json`.

### Packages built elsewhere

An OAP package from another repository installs as it is published:

- an npm-format tgz (its files under `package/`) or a `.mgu` (its
  `source/` is the package; `meta.json` must name the same id and version;
  `rhmiData/` and `oapgen/` beside it are left out, the manager makes its
  own) is repacked flat;
- `"mguLocalOnly": true` is added to its `package.json`;
- without `node_modules/` or `npm-shrinkwrap.json`, an `npm-shrinkwrap.json`
  without dependencies is added: the manager installs such a package only
  through one, and the package carries what it runs on;
- `permissions.json` gets the ACL tables it lacks of the two the manager's
  `aclManager.js` reads (`masterAccessTable`, `masterRegistrationTable`),
  empty: without either the manager fails the install;
- its SOME/IP manifest gets `de.bmw.infotainment.certification.Certification`
  (`"*"`) when it lacks it: without it the install fails at the app's
  keychain (the certification service, above);
- on iDrive 7, the interfaces its SOME/IP manifest names and the head
  unit's interface database lacks are taken out (above);
- when its own javascript calls `require('oap-sdk')` (a browserify bundle
  resolves its requires itself) and it has no `node_modules/oap-sdk`, that
  module is generated from the first donor holding the oap-sdk core
  (`OnlineApp`, `someipBuilders`), "module" mode: the closure of the public
  API's modules with the donor's ids behind the browserify prelude, and one
  getter per API name (`OnlineApp`, `NsmProxy`, `config`, `logging`,
  `loggingLevel`, `SDKError`, `someipBuilders`, `RhmiApplication`,
  `RhmiResourcesLocator`, `telephony`, `getVin`, `runtimeVariant`,
  `appstart`, `guidance`, `map`, `MapKmlContentTypeConverters`, `poi`; the
  ones the donor holds) that loads its module on first use. The idea and
  the export shape follow `kit/tools/extract_sdk.js` of
  [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
  (MIT); `tools/oap_link.js` is its own implementation. An `oap-sdk` the
  package ships stays as it is.

The prepared package is checked again as an app, then installed. Our own
flat, marked packages are installed byte for byte when their SOME/IP
manifest names the certification service and, on iDrive 7, no interface
the head unit lacks, or they have none; otherwise they are prepared as
above. A package that needs
the oap-sdk on a unit with no donor is refused (exit 2, nothing changed).

`sdk-donor [--json]` copies the bundle module mode takes the oap-sdk from to
`/run/mgu-deploy/sdk-donor/javascript/app.js` (0644, folders 0755), beside a
`package.json` naming its oap-sdk version, and the oap-sdk module module
mode generates from it to `/run/mgu-deploy/sdk-donor/oap-sdk/` (`index.js`,
`package.json`), and prints the bundle's path (`{"path", "module",
"donor", "sdkVersion"}` with `--json`). The updater hands the bundle to a
repository's own build as `MGU_SDK_DONOR`, and the module to a build that
asks for it (`build.sdk`, docs/PUBLISHING.md). No lock, no snapshot; exit
2 when no donor holds the core.

### Internet for selected components

A tool whose `component.json` says `"internet": true` lists its numeric
`uids`, or names in `uids` a file under `/var/opt/<id>/` where it keeps
them, one per line (the updater: `state/internet-uids`); an app's built or published `package.json` says `"mguInternet":
true`. After every install and uninstall, while `mgu-uplink` is installed,
the tool writes `/var/opt/mgu-uplink/uids.d/<id>` (the uids, one per line)
and `apps.d/<id>` (the app id) for every installed component that declares
it, and removes the ones of components that are gone; installing
`mgu-uplink` writes them all. mgu-uplink reads both folders besides its
conf. The files are in the component's snapshot.

### The crash handler's whitelist

A crashing process's core dump goes to the crash handler, which reboots the
head unit unless the file name of the process's executable
(`/proc/<pid>/exe`) is a line of `[Whitelist]` in
`/etc/crashhandler-restartlist.conf` (exact and case-sensitive; `node` is
there). A script runs as its interpreter. Every ELF file a tool ships
executable is one of its programs, listed by its file name. A tool can name
more programs in `component.json`:

```json
"crashNames": ["mgu-uplink", "mgu-wpa"]
```

each a file name of letters, digits or `._+-` (other names are refused). A name the
car's own programs use (`sh`, `wpa_supplicant`, `dbus-send`) does not belong
there: give the program a name of its own instead. A tool without
`crashNames` gets the names this tool knows for it: `mgu-uplink`,
`mgu-render`, and `python3` for `mgu-python`. Both kinds of name go into the
list; a shipped ELF file's only when the firmware has no such name (in
`[ForceRestartList]`, or a program in `/bin`, `/sbin`, `/usr/bin` or
`/usr/sbin`, such as `sh` or `node`).

Every tool install and uninstall puts the names of the installed tools into
`[Whitelist]`, after its last entry, and takes out the ones it added that no
installed tool still names; the change is in the install's snapshot. A name
already in the list is left as it is and never removed. Other lines and
sections stay byte for byte. `status`, run as root, does the same: a deploy
tool update brings the names at the updater's check after it, and a firmware
update that put back the stock list gets them again. It remounts `/` only for
a change, under this tool's lock and with a snapshot of its own, and puts it
back read-only on any exit. It waits while `/` is read-write, while
app-privacy's boot run (which remounts `/` itself) has not finished, or while
another run holds the lock, and tries again at the next `status`. `status
--json` reports it as `crash_list: {state, reason}`, `state` being `ok`,
`changed`, `pending` or `error`; a change is also one line on stderr. The
crash handler reads the list when it starts: a change counts from the next
boot. A unit without the file is left alone. A list without `[Whitelist]`
is never edited: an install is refused (exit 2), `status` reports an error
and still adds recmgr's missing names, and the file stays as it is.

### Limits for the services tools install

Every service unit (`.service`) an installed tool lists, whatever its source
(our tools, mgu-apps', other repositories' and service packages), gets the
drop-in `/etc/systemd/system/<unit>.d/zz-mgu-deploy-limits.conf`:

```ini
[Unit]
StartLimitIntervalSec=600
StartLimitBurst=20
ConditionPathExists=|!/var/opt/mgu-deploy/safe-mode
ConditionPathExists=|/run/mgu-deploy/safe-mode-lifted
ConditionPathExists=|!/var/opt/mgu-deploy/current/safe_mode.sh

[Service]
LimitCORE=1
```

The triggering `ConditionPathExists=|` lines (any one lets the unit start)
keep it off in safe mode unless an install lifts it (below), and never
under an installed deploy tool without safe mode (an older one); a
tool's socket, timer and path units get them alone, in a drop-in of the
same name. A unit that runs in safe mode (`"runsInSafeMode": true`) has
none: a service gets the limits alone, any other unit no drop-in. Nothing
orders a unit on safe mode's guard, so no unit, BMW's included, waits for
it at boot.

- `LimitCORE=1`: the kernel pipes core dumps to the crash handler, which
  restarts the head unit for a program its list does not name, and it writes
  no piped core dump for a process whose core limit is 1. A crash of the
  service, or of a program it starts (they inherit the limit), stays the
  service's own; with its recmgr entry, a crash restarts the service, never
  the head unit.
- The start limit: a service that has started 20 times within 10 minutes is
  left failed instead of restarting for ever, also when
  its unit sets `StartLimitIntervalSec=0`. A service that restarts every 5 s
  gives up after about 100 s, one that restarts every 3 s after about 60 s,
  which leaves room for a service waiting at boot for what it needs. It
  starts again at the next boot, or when an install or rollback of its tool
  starts it.

A tool install writes the drop-ins of its services and an uninstall removes
them, with the folder when nothing else is in it; they are in the
snapshot. `status`, run as root, gives every installed tool's services the
drop-in and removes it from units no installed tool lists, under the crash
list's rules (lock, read-only `/`, a snapshot of its own): a deploy tool
update brings it to the tools installed before it at the updater's check
after it, and a restore leaves the drop-ins as the restored tools want them.
A change is followed by `daemon-reload`; a running service takes the limits at
its next start (the unit has no `prlimit` to change a running process).
`status --json` reports the step as `service_limits: {state, reason}`. Units of other components and the car's
own are never given one.

### Safe mode

When the head unit keeps restarting soon after it starts, and nothing more
specific (such as a tool's own boot recovery) has ended it, our tools'
units stay off: **safe mode**. While `/var/opt/mgu-deploy/safe-mode` exists,
no unit of an installed tool starts, except those that run in safe mode;
BMW's units are never touched.

**What counts.** A start counts as failed when it ended in a restart recmgr
or crashhandler asked for within 2 minutes of the start (the system uptime
at the shutdown), and none of our tools asked for the restart. A restart is
theirs on either record of it:

- the `restartInfo.xml` each writes under
  `/var/opt/public/sin/<recmgr|crashhandler>/` when it asks, written in this
  start (its modification time not before `/proc/stat`'s `btime` and not
  after now, a second of slack each way);
- a row recmgr added to its crash statistics since the start's boot step
  (`/var/opt/public/sin/recmgr/recmgr_stats.db`, table `Crash`, whose
  `CrashKey` only grows), with the statistics written within 60 s of the
  shutdown. recmgr adds the row for a failure it restarts the head unit for,
  just before it asks for the restart, in the same start; none for a
  service in its lists, nor for a crash of a program crashhandler lists
  (`node`) in a service that keeps running, nor for crashhandler's own
  restarts, which its `restartInfo.xml` records. recmgr's startup, some 10 s
  into a start, deletes its `restartInfo.xml`, also one written in that
  same start: a restart before then leaves only this record. A row has no
  time of its own (`Crash`: `CrashKey`, `Timestamp`, `AppID`, `UserID`,
  `CrashID`, `LC`; recmgr leaves `Timestamp` empty and `LC` 0), so the time
  is the database file's: its last write of any kind. The mark cannot read
  the shutdown's kind itself either (a restart, a switch-off and a normal
  restart all run `var-opt-ro.service`). So a row added earlier in the
  start counts when the database was written again within a minute of the
  shutdown (recmgr writes it for the failures it restarts the head unit
  for), as does a restart recmgr asked for that the NodeStateManager did not
  take, followed within a minute by a switch-off. A read that meets
  recmgr's commit waits up to 200 ms for it.

The shutdown that ends the fourth failed start in a row turns safe mode on,
so the fifth start is the first without our tools: four failed starts.
Nothing else counts:

| How a start ended | The count |
|---|---|
| a restart recmgr or crashhandler asked for, up less than 2 minutes | + 1 |
| a shutdown without either record after 2 minutes: a switch-off, the HMI's, the Store's or another normal restart | back to 0 |
| a restart our tools asked for (`restart-requested` names the start) | back to 0 |
| the start stayed up 5 minutes | back to 0 |
| a shutdown without either record within 2 minutes (a short drive, or a restart whose records were lost) | kept |
| a crash restart between 2 and 5 minutes | kept |
| no shutdown mark (a power cut, a reset that skipped `var-opt-ro.service`, `var-opt-ro.service` failing before the mark ran, `systemctl reboot`) | kept |

A suspend keeps the start (and its boot id) and its uptime runs on, so a
drive after it never counts as an early end. A state file that is missing
or does not read as `safe_mode.sh` writes it counts nothing, so it can
never turn safe mode on.

**How.** `safe_mode.sh` (beside `mgu-deploy.js`) does it, in sh:

- `mark`, at each shutdown through the NodeStateManager: the drop-in
  `/etc/systemd/system/var-opt-ro.service.d/40-mgu-deploy-safe-mode.conf`
  runs it before `/var/opt` goes read-only (`ExecStartPre=-`, so it never
  holds up the remount). recmgr's and crashhandler's restarts, a switch-off
  and a normal restart all take that path. It writes `last-shutdown`
  (`<boot id> crash|normal <uptime s> [recmgr] [crashhandler]
  [recmgr_stats]`), once before the statistics read and again after it, so
  a shutdown cut during the read still finds the start marked, and
  `safe-mode-count` (`<failed starts in a row before this start> <boot id>
  <with this start>`; a second shutdown of the same start counts it again
  from the first number), and at the fourth failed
  start in a row writes `safe-mode`, `{"at": "<UTC time>", "reason":
  "<why>"}`, and starts the count again. The flag is there before the next
  start's units, so nothing has to wait at boot.
- `boot`, early at each start: `mgu-deploy-safe-mode.service`
  (`DefaultDependencies=no`, after `/var/opt` is mounted, enabled for
  `multi-user.target`, in recmgr's list, and ordered with no other unit).
  It writes `safe-mode-crashes` (`<boot id> <recmgr's last crash key>`), the
  baseline for this start's mark.
- `up`, the same service: at 5 minutes of uptime the count goes back to 0,
  by `/proc/uptime`, looked at every 5 s, so a suspend counts as time up. The
  service then stays up, so recmgr never sees it end.

The statistics are read with the database opened read-only
(`file:…?mode=ro`, the firmware's `sqlite3` 3.22), for at most 2 s.

Each file is written whole (renamed into place) under `/var/opt/mgu-deploy`.
On a head unit whose firmware has `var-opt-ro.service`, an install lays the
service, its link, the drop-in and the recmgr entry (entry first), as does
`status` (with the limits drop-ins, under the same rules); `remove-all` takes
them out.

**A restart our tools ask for** is marked first: its start's boot id
(`/proc/sys/kernel/random/boot_id`) in `/var/opt/mgu-deploy/restart-requested`,
written whole before the request. The updater's `reboot`, `mgu-install.js`'s
restart and mgu-render's car test do it; another tool that asks for a
head-unit restart writes it the same way.

**What runs in safe mode.** A unit whose entry in the tool's `component.json`
says so:

```json
"units": [{ "name": "acme-recovery.service", "from": "systemd/acme-recovery.service", "runsInSafeMode": true }]
```

Give it to units that recover the head unit or leave safe mode: the updater
(which installs the fix and leaves safe mode; the deploy tool also treats a
published updater's unit without the flag so), and units that put BMW's
files back. `deploy/hu artifact` carries the flag into the kit. The deploy
tool's own units (the boot check, the fallback, the guard) are not tool
units and run as before.

**Leaving it.** The next install that goes through as a whole (an install
or update of any app or tool, the same version again included) leaves it.
`safe-mode` stays on disk while it runs; the install lifts it in RAM, with
`/run/mgu-deploy/safe-mode-lifted` (the drop-in's other, triggering
condition), so what it starts runs. `safe-mode` goes once every artifact,
every tool it lays again, every app it installs afresh and the deploy
tool's own update are through. An install that fails, partly or wholly,
falls short (a tool it lays again fails, warned), or that the MainApp guard
stops ends the lift and keeps it; one cut short leaves the lift until the
next run of the deploy tool or the next start (a power cut included), as
`/run` does not outlive a start. Only the outermost install settles it;
an app installed afresh inside it counts towards it, and an app's
`rollback` (Undo update) is one install: one that fails keeps it, also when
the version before goes back in. `safe-mode off --yes`
removes it too: the Store's Leave safe mode, through the updater. Either
way the count starts again, the tools start at the next start of the head
unit, and until then `status` lists `mgu-deploy` under `pending_reboot`
(`our tools start at the next start`). The boot check (`verify`) waits
for a start without safe mode. `status --json` reports `safe_mode: {at,
reason}` while it is on (both null for a file that does not read as
written), else `null`; `safe-mode [--json]` says the same.

**An older deploy tool.** An install of an older deploy tool, or `rollback
mgu-deploy` to one, that has no safe mode (no `safe_mode.sh` in its
version) takes the guard's unit, link and drop-in out and leaves safe mode,
its count and its records with it, as above; the recmgr entry stays, naming
no unit. Whatever an older version leaves on disk does nothing: the limits
drop-in's third condition lets every unit start while the installed
version has no `safe_mode.sh`, and the guard's unit, if still there, runs
no script and stays up without one.

### One transaction per artifact

Each artifact of an `install` is its own transaction, with its own snapshot.
When one fails, only its changes are undone: its new version folder (no
`versions/` without `current`), a socket it started whose unit is removed
again, its preinstalled package, its `custom_apps.json` entry, an app home
the manager created for it during the attempt, and the fallback when this
install turned it on (the copy is rebuilt or unbound to match). A first
install of an app that fails, and leaves it no registry entry, also takes
out the app's `uids.txt` lines (this attempt's and earlier ones'), written
in place so the file keeps its owner, mode and ACLs. Artifacts
installed before it in the same call stay installed, and the output says so
(the updater installs one artifact per call). The app-privacy patch stays
applied after a failed app install while the app-privacy tool is installed.

### After a firmware update

A firmware update puts the root file system back and keeps `/var/opt`:
every component stays listed, while what it set up outside `/var/opt`
(units, their enablement and drop-ins, boot-list entries, MainApp's
copies of an app's SOME/IP interfaces and ACLs for the firmware before)
is gone or set up for the firmware before. Running the same install again
(`mgu-install.js first-install`, which also brings back the updater and
our boot units) sets every component up again:

- Each tool install records the firmware it was installed under
  (`state.json` `tools`) and keeps the tool's units, drop-ins and
  `component.json` in `kept/<id>/<version>/`, one for each version under
  `/var/opt/<id>/versions`.
- Every install lays again from that copy each installed tool it does not
  install that lacks a unit, an enablement link or a drop-in, or was
  installed under another firmware. A tool with no install step of its own
  is laid again as an install of the same version. One with an `activate`
  or `postInstall` gets its files only: its units, enablement links and
  drop-ins, their recmgr names and limits, and the restart units laid
  started as at a first install, under recmgr's rules; its step does not
  run, since the copy may be an old version from another source and the
  step may patch the firmware's files. Its record then holds the firmware
  and `needsSetup` (`status --json` `needs_setup`, why), and the run's last
  line names such tools (`needs setup (...): <ids>`). Its step runs at its
  next install (an update, the same version again) or `setup <id> --yes`,
  which lays it again from its copy, step included (the Store's Set up);
  the stock-file fix follows each step as at any install. `relay [<id>...]
  --yes` lays the files again without an install (the updater, when no
  newer version is reachable): only for the tools named, files only for
  one with an install step, whole for one without. Until a hook of the
  tool has run on the new firmware, no install of it runs a hook of a
  version it replaces (a due deactivate, the deactivate of an install of
  the same or a newer version from another source, or the activate of the
  version a failed install goes back to, which then needs setup); a
  downgrade runs the deactivate of the version it replaces, as above. An install that a
  refusal stops after it laid tools' files again exits 1, naming them. A tool installed before copies were kept
  says so; its source installs it again (the updater, `repair`).
  `mgu-install.js first-install` installs the release's tools as usual and
  leaves the others (from other sources) to files only, so no other
  source's step runs unasked.
- MainApp's first start after a firmware update marks every installed
  app as needing an update (`"NO_FORCED_UPDATE_NEEDED": false` in its
  registry entry) and starts none so marked; it updates its own apps, not
  ours. On iDrive 7 an install of such an app, already current, installs
  it afresh: uninstall, install, its data folder carried over.
- `status --json` gives each component's `stale` until then, and for a
  tool `kept` and `needs_setup`.

### Removing the Store setup

`remove-all --yes` removes what the Store setup put on the unit, each step
with its snapshot and rollback as on its own, in this order: every app the
deploy tool installed (recorded in `state.json`, listed in
`custom_apps.json` or marked `mguLocalOnly`; on iDrive 8 also those with
our das lines and queued installs); every tool but app-privacy, a tool
another requires after it; the provisioning fallback and `custom_apps.json`;
app-privacy, its patch reverted; then the deploy tool's boot units and
recmgr entries, any limits drop-in and crash handler name it still owns,
`local-only-apps.json` and its other files in the app manager's folder, the
updater's sources and tokens, and last `/var/opt/mgu-deploy` with its
state and backups. The restart lists are edited as they are on the unit,
whatever firmware wrote them; no backup is restored. The app manager is
restarted once at the end (iDrive 7, the usual bounce rules), where a step
asked for it. A step that fails is named and what depends on it stays:
app-privacy and the fallback while one of our apps is left, the deploy
tool while anything is; running it again finishes. On iDrive 8 the apps
MainApp-21 does not uninstall in place are queued; `mgu-deploy-apply`
and the deploy tool stay for the next start, which removes them and then
both. Apps and the renderer adopted from IterioDev's App Manager stay, as
`uninstall oap-appmanager` leaves them.

`remove-all` (or `--json`) lists what it would remove and changes nothing.
With `--yes` the steps' lines go to stderr and the result is one JSON line
on stdout: `removed`, `left`, `restart` (a restart finishes the job),
`next_start` and `self` (`removed`, `next-start` or `kept`). Exit 0 when
nothing is left, 1 otherwise.

### Backups and restore

Before every change the installer snapshots every file the operation
touches: unit files, enablement links, the recmgr list, preinstalled
packages, registry entries, and each tool's `current` link, each with mode
and owner, or marked absent. Every snapshot also records `state.json`,
`custom_apps.json`, and the fallback's unit, link and copy. The updater owns
its `sources.json` and `credentials/`: snapshots neither copy nor restore
them, including when restoring an older manifest that lists them. The app
manager's `main.js` is recorded (checksum, bind-mounted or not), not copied, except by a snapshot that covers the retired installer's
leftovers (below), which copies the file under the fallback copy. Restoring
one taken before a migration that listed apps is refused (below); otherwise
the file is put back with the copy unbound, and the rebuilt copy is bound
after. Stored copies are mode 0600 in the 0700 `backups/`. The
first snapshot ever taken is also kept as `stock` and never overwritten; the
first install covers all of its artifacts in it. Besides `stock`, the 10
newest snapshots are kept, and every snapshot of the command that just ran;
a command that took one removes the older ones when it ends. A failed uninstall or fallback change restores its own
snapshot.

One changing command runs at a time (`install`, `uninstall`, `rollback`,
`restore`, `fallback on|off|migrate`, `updater-token`, `updater-sources`): it waits for the
`lock` of another run, up to an hour, then refuses (exit 2). A lock whose process is
gone, or from an earlier boot, is taken over. `status`, `check`, `backups`
`fallback status` and `sdk-donor` take no lock. Holding the lock, a changing command
first removes what a killed run left: files named after a process that is
gone (staging, rootfs-window and temp files, a tool's unfinished version
folder) and `/var/opt/mgu-deploy-kit-<n>` folders a day old. A tool's earlier
`current` folder such a run set aside comes back as `current` when there is
none, else it is removed.

`restore [name]` (default `stock`) first snapshots the current state, then
runs, with all of it in place, the `deactivate` of each tool's current
version the backup puts on another version (as a rollback does), and the
hooks of each tool's removal the backup shows it absent from (as a removal
does; a restart one asks for is pending under the deploy tool). One that
fails refuses the restore (exit 2, nothing restored), and the versions
deactivated run their `activate` again, as they do when the restore fails
after them, but for a tool it has removed by then. A restore runs no
`activate` of the version it puts back. It then puts every recorded file
back, removes what the snapshot shows as absent
(a tool's `/var/opt/<id>`, an app's home and package, `custom_apps.json`),
keeps the updater's sources and credentials, verifies every file against
its checksum (a mismatch is exit 1
and rolls back), and rebuilds or unbinds the fallback copy to match. Its
boundary:

- it covers the paths the snapshot recorded. `stock` is the state before the
  first command, for the paths that command touched and the ones every
  snapshot records; a component first installed by a later command is
  removed with `uninstall`. The restore is refused (exit 2, nothing changed)
  while such a component would be left without what it runs under: a tool
  without its recmgr entries, one of our apps without app-privacy, or any
  app that stays registered without the fallback listing it has now (ours,
  or one the migration of the retired installer's leftovers listed).
- tool version folders are not copied (they stay under the prune rule), nor
  are app homes: an app restored as present must still be installed. A
  restore that would point a tool's `current` at a version no longer kept is
  refused; install that artifact instead.
- the app manager's records for removed apps (uids, ACLs, UI state) stay.
- sources and credentials stay even when the restore removes the updater.
  Explicitly uninstalling the updater removes its whole folder.
- the deploy tool itself stays installed: no snapshot records or restores
  `/var/opt/mgu-deploy/versions/` or `current`.
- every snapshot records the firmware it was taken on (`firmware` in its
  manifest). A restore that would write a file outside `/var/opt` is
  refused (exit 2, nothing changed) unless that is the firmware the unit
  runs now. A snapshot without the record counts as another firmware's,
  since it may predate a firmware update; one that writes no file outside
  `/var/opt` restores. To take the Store setup off after a firmware
  update, use `mgu-install.js uninstall`.

app-privacy patches the app manager's bundles in place. A restore that
removes it first runs its `revert --json` (on the fallback copy and the stock
`main.js` under it, as `uninstall` does) and bounces the manager when the
bundles changed.

### Provisioning fallback

Our apps install through it. `fallback on` (and every app install) builds a
copy of the stock `/usr/lib/oap-mainapp/src/main.js` (or `main.bundle.js` on
MainApp 6.5.5, where `main.js` is a bytecode-loader stub) with one change in
`ProvisioningNotifier`: an app with no provisioning entry takes it from
`oap_12201/data/custom_apps.json`, which lists our apps, both in MainApp's
`installable_apps` (so the manager installs it) and as the app's own section
(its flags, which give it its tile and start type; a flag an entry leaves
out is `"true"` for `-enabled` and `-allowed`, else as `install` writes it,
so the entries idrive7-apps' installer writes there, with
`-appStartType` and `-userLoginRequired` alone, show their tiles too). An
app provisioning lists keeps its own entry. The build needs both anchors (`class
ProvisioningNotifier ` and the `installable_apps` hook,
`isMainapp&&section===mainAppSection&&(newProvisioning.`) exactly once in the stock file;
any other count refuses it and nothing is written. The copy also carries
the in-place install hook (Apps, above), in main's start-up once MainApp
has initialized, at the step after `mainApp.init()`:

```
mainApp.init()}).then(()=>{
```

When that anchor does not occur exactly once, the copy is built without
the hook and the build says so; app installs then go through a bounce.

On iDrive 7 the copy also puts our apps first in MainApp's install queue.
MainApp runs every install and update through one queue in
`AppManagementController`, one at a time. Without ConnectedDrive it retries
BMW's online apps there at every start, and each failure doubles the wait
(from 40 s) before the next call, whichever app it is for. In the copy, a
call for an app `custom_apps.json` lists moves to right behind the call
running (ours keep their order) and runs without the leftover wait; a
retry of one of ours after a network error goes to the end, as MainApp
queues it. MainApp logs `mgu-deploy: install <app> queued ahead of <n>
other install(s)`. It needs these two anchors exactly once, the end of
MainApp's own `utils/makeMethodQueued` and the controller's queued method:

```
module.exports={makeMethodQueued:makeMethodQueued,unqueueMethodCall:unqueueMethodCall,getCurrentOperationPromise:getCurrentOperationPromise,onQueueIdle:onQueueIdle,configureQueue:configureQueue};
this.queuedRecursiveRetry=makeMethodQueued_1.makeMethodQueued(this,this.queuedRecursiveRetry,!0)
```

Without them the copy is built without it and the build says so. The
manager runs it from its next start: the boot unit's build, or the build
this tool writes before it restarts the manager.

The copy, with the app-privacy patch applied to it, is `/var/opt/mgu-deploy/main.js`,
bind-mounted over the stock file. `main.js` is only ever bound to the copy
as it is: a bind left on a copy deleted or replaced since (a bind keeps the
file it was made with) is unmounted by the next restore or rollback, which
binds the copy there again while the fallback's unit is present, and by
app-privacy's revert; with no copy, `main.js` stays the stock file. A rebuild unmounts the old copy, builds
from the stock file and binds the copy again, rewritten only when its bytes
change. An app install or uninstall keeps the copy the running manager runs
when it announced its hook and the new build has the same hook (a newer
deploy tool's build differing elsewhere), so the manager keeps installing
in place with no bounce; the boot unit builds the new copy at the next
start. When the manager does not install or uninstall that app in place
after all, the new copy is written before the bounce that does it.

`mgu-app-fallback.service` (enabled, listed in recmgr, before oapcontroller
and app-privacy) rebuilds the copy from the stock file at every boot with
`/var/opt/mgu-deploy/current/fallback_build.js` and bind-mounts it; when the
build refuses (a firmware update changed `main.js`), the stock file stays in
effect. `fallback off` unmounts it and removes the unit, its link, its recmgr
entry and the copy; apps installed already stay installed, and a new app
install turns it on again. `status` shows per app whether its tile comes from
provisioning (`tile_provisioned`) or the fallback (`tile_fallback`), from the
flags the manager persisted in its `provisioningCache`; on iDrive 8 only
where the provisioning served has the app's section or the running
MainApp-21's copy filled it (iDrive 8 apps, Backend provisioning). On iDrive 7 an app
listed in `custom_apps.json` shows only while the running manager runs the
fallback copy (`fallback.manager_runs_copy`); otherwise, or with no manager
running, its tile is reported hidden (with the retired installer's leftovers,
which list apps by themselves, the cached flags stand). Provisioning's own section for an app's
id wins over the fallback: when it disallows the app the tile stays hidden
(`tile_visible: false`, and `tile_withheld: true`: the flags the manager
keeps hide it, so a restart does not show it), and the install says so.

### The retired installer's leftovers

An earlier installer, not part of this repository, listed its
apps by editing the app manager's bundles in place: `main.js` puts their ids
in `installable_apps` and forces their provisioning flags. It kept the files
it replaced beside them (`main.js.capbak`, the stock file; `main.js.vcbak`,
an earlier edit) and set `base.json`'s `ignoreSignatureFailure` to `true`.

A leftover is a backup beside a bundle, `<bundle>.<letters>bak` (`main.js`,
`AppManagement/AppManagement.js`). One that app-privacy's `check --json
--main|--appmanagement <backup>` reports as its stock reference
(`reference: true`) is that bundle's verified stock copy. `check` lists every
backup and whether it is one; `status --json` lists them as
`retired_leftovers`.

At the start of every app install, update or uninstall (after the tools,
app-privacy among them, and before the first app's own change), and with
`fallback migrate`, a unit with a verified stock copy is migrated, as its own
transaction under the run's lock:

1. Refused before any change (exit 2 for `fallback migrate`; an install or
   uninstall says why and goes ahead without it) unless app-privacy is
   installed, the fallback copy builds (from the stock `main.js` when that is
   migrated) and app-privacy applies to it, and `base.json` names
   `ignoreSignatureFailure` exactly once with a boolean.
2. A snapshot (`<time>-migrate`) that copies what it touches: both bundles
   (`main.js` as it is under the fallback copy, which is unbound for it), the
   backups, `base.json`, `custom_apps.json`, and the fallback's unit, link,
   recmgr list and copy.
3. Every registered app that `custom_apps.json` does not list is added
   with the flags its registry `provisioningCache` holds, so the fallback
   keeps its tile, when it is ours (its source marked `mguLocalOnly`) or the
   retired edit lists it, marked or not: its id is a `"<id>"` string literal
   in `main.js` as the manager loads it and not in the stock copy.
4. One rootfs window: each bundle with a verified stock copy is put back
   from it (keeping its own mode and owner) and checked against its
   checksum, `ignoreSignatureFailure` is set to `false` (an edit of that one
   value), and that bundle's backups are removed. A bundle without one stays
   as it is, with its backups.
5. app-privacy's `apply` on the stock bundles, nothing bound; the fallback
   copy rebuilt from the stock `main.js` and bound (the fallback turned on
   when it is off).
6. One bounce, under the spacing above, when what the manager loads
   changed; then, `MGU_DEPLOY_MIGRATE_SETTLE_MS` (45 s) after the manager is
   back, every app of ours is still registered, every app whose tile showed
   before, ours or not, still shows it, and app-privacy reports patched with
   no restart needed.

Any failure after the snapshot restores it (bundles, backups, `base.json`,
`custom_apps.json`), rebuilds or unbinds the fallback copy to match, and
bounces once more when the migration bounced, still spaced. The command
then fails (exit 1) before its own app change; when the rollback fails too,
its last line says so and names the snapshot. A failed automatic migration
is recorded in `state.json` for the boot: later commands of that boot go
ahead without it, and `fallback migrate` tries again at any time. A unit
without a verified stock copy is not touched: no snapshot, no bounce. The
migration's bounce comes before the command's own one, so a command makes
at most one bounce more than it would without leftovers.

### For the updater

The updater installs with `/var/opt/mgu-deploy/mgu-deploy.sh install
--artifact <file> --yes` and reads `status --json`: one JSON object on
stdout, read-only, taking no lock, of this shape:

```
{ "version": "<x.y.z>",
  "unit": { "hmi": "ID7"|"ID8"|null, "firmware" },
  "components": [{ "id", "kind": "tool", "version", "units": [{ "name", "enabled", "active", "journal" }], "provides",
                   "stale": "<what it lacks>"|null, "kept": true, "needs_setup": "<why>"|null },
                 { "id", "kind": "app", "version", "uid", "installationSource", "running",
                   "tile_provisioned", "tile_fallback", "tile_visible", "tile_withheld", "stale": "<why>"|null }],
  "pending_reboot": [{ "id", "reason" }],
  "last_apply": { "at", "results": [{ "id", "action", "version", "ok", "error"?, "log", "rejected"? }] } | null,   (iDrive 8;
                 action "restore": version put back in place of the rejected one)
  "display_bridge_socket": true, "display_bridge_todo_on_car": ["<key>: TODO(on-car): ..."],   (display-bridge)
  "fallback": { ... }, "backups": 3, "stock_backup": true, "updater_tokens": 1,
  "retired_leftovers": ["/usr/lib/oap-mainapp/src/main.js.capbak"],
  "appmanager": { "present", "version", "app", "daemon", "record" } | null,
  "mainapp_guard": "<why app changes wait for the next start>" | null, "last_bounce_at": <epoch s> | null,   (iDrive 7)
  "lost_apps": [{ "id", "version", "package" }],
  "hmi_parts": [{ "id", "version", "files": ["rhmiData/<folder>/<file>"] }],   (iDrive 7)
  "safe_mode": { "at", "reason" } | null }
```

## Tests

```sh
node deploy/test/run.js              # MGU_TEST_ONLY=testKit,... runs those test functions only; MGU_TEST_INSTALL_EXE=<file> runs an mgu-install executable in place of the script
sh deploy/test/run.sh                # in Docker: the unit's code on Node 8.16.2 (MGU_TEST_UNIT_NODE)
node tools/test/run.js               # the linker and packer; sh tools/test/run.sh: on Node 8.16.2
MGU_TEST_NODE_VERSION=8.9.4 sh deploy/test/run.sh   # both run.sh: on the 2019 MGU's Node 8.9.4
```

Offline, against a fake root (`MGU_DEPLOY_FAKE_ROOT=1` and the
`MGU_DEPLOY_*` path and command overrides at the top of `mgu-deploy.js`;
`systemctl`, `journalctl`, `ps`, `kill`, `ssh`, the app manager and
app-privacy are the stand-ins in `deploy/test/`): reproducible artifacts
(the deploy tool's own included), refused artifacts leaving the root
unchanged, tool layout, pruning and idempotence, pending reboots, restarts
with their health check and the rollback after a crash loop, `rollback`,
app-privacy as a tool, the fresh-install and update flows through the
simulated manager, bounce spacing, the MainApp guard (a manager that dies within the watch
after a bounce: the run stops with exit 3, an install, an update and an
uninstall through the sh window keeping what they did with no rootfs write
after the death and their records following it, a rollback stopped in its
removal or its install keeping the record, kept package and data that the
next install completes, a restore stopped or failing, an unmount that
fails, a boot check stopped, no further bounce, app change or app-privacy apply, main.js unbound,
until the next start; one that dies after it: nothing; a watch a killed
run left, judged at the next status; the copy's guard loaded once per
start; a data folder set aside taken by its app registered again with an
empty data folder, kept recorded beside one with data, never through a
link, kept through a later reinstall of the app that succeeds, fails or
is stopped (both folders recorded then), all of them removed by an
uninstall, kept through status and later commands after a failed reinstall, and
gone after a removal, a restore or remove-all; a fallback install stopped
recording its version; the records of a stopped app-privacy install, update
and rollback, restore and fallback on and off matching the finished ones; a stopped boot
check keeping the rest due; a hook's stock-file fix before a stopped
bounce and with the guard off; remove-all while the guard is off); a
restore that removes an app dropping its record, per-artifact transactions, the stock
restore, `status --json`, the fallback, the in-place install, update and
uninstall (the copy built from `fixtures/main.js`, its hook run by
`fake_inplace.js` as the running manager: installs, updates and uninstalls
with no bounce, the request's rules, the bounce instead after a failed, refused or untaken request, a
restarted manager or a copy written after the manager started, no bounce
for an app the manager installs by itself during the bounce's wait or
while the manager is still installing, or updates by itself before the request, an uninstall
the manager fails, does not take or does not finish in time removed through
the bounce, one with no manager running removed with no bounce, and the copy
built without the hook when its anchor is missing), the retired
installer's leftovers (detection, the migration through an update and an uninstall and of
`AppManagement.js` alone, an unmarked app the retired edit lists keeping its
tile, its rollback after a failure before and after its bounce and when a
tile that showed is lost, a rollback that fails too, the restore guard for
carried apps, and the refusals), the updater's sources and tokens (on the
unit and through `deploy/hu`), source packages built against the made-up
donor in `tools/test/synthetic_donor.js` (installed, not built again, no
donor refused), packages built elsewhere (npm format, `.mgu`, unmarked,
oap-sdk generated, no donor refused), the internet drop-ins, `sdk-donor`,
the head unit (iDrive 7 and 8 by MainApp's folder, by the running HMI with
both or neither, unknown), compatibility (rhmiData, a declared `mguHmi`,
a tool's, a malformed one), service packages (the renderer as a tool with
its unit, link and recmgr entry, starting at the next boot; refusals, the
tether among them; uninstall; on an iDrive 8 without a recmgr list started
at once with touch routing), capabilities (a second renderer installed
beside the first, two in one call, one left after the other's uninstall),
`keepRunning` (a running service and its changed socket left as they are,
pending the next start; with the service stopped the socket restarted; a
renderer package not restarted), iDrive 8 apps against made-up das files (queued, the boot unit,
`apply-pending` refused while MainApp runs, applied, an update and a
removal with everything moved to the trash, an update MainApp-21 rejects
put back at the next start (and one it installs left), a flat package repacked, a
queued install dropped, refusals; with `MGU_TEST_ID8_PROV=<folder>` also
against real das files, never part of the repository),
IterioDev's App Manager on a made-up iDrive 8 laid out as its `install.sh`
and service leave it (its app refused; adopt: its daemon and tether
stopped, its queue moved, its renderer our tool, the record without its
token, nothing reinstalled; again; Remove and the next start; a failed
adopt rolled back; our renderer installed first; under recmgr finished at
the next boot),
and `mgu-install.js`: `first-install` and `token` against a fake root
through a stand-in `ssh` (`fake_ssh_exec.js`) with the release from a
stand-in GitHub API (`fake_github.js`: a private repository, downloads
redirected to another host), run twice (the restart line while the
updater is not running, none once it is), with the uplink, without a
token, with an artifact that does not match; `usb-repo` from every kind of
input, the stick then read by the updater's own `sources.js` on the unit's
Node (`stick_read.js`); the script run from stdin, finding the unit
at the hotspot address by itself; and Windows paths and names
(`path.win32`). `deploy/test/connect_test.js` covers how it finds the
unit: the order with stand-ins, the interface choice, HSFZ framing and the
DID answer, and the banner check, gateway identification and the DID read
against servers on `127.0.0.1`.
`tools/test/run.js` builds and runs linked and module-mode apps against
that donor; with `MGU_TEST_DONORS` and `MGU_TEST_THIRDPARTY` it also
checks real donors and third-party packages on the machine (never part of
the repository).

The connection is tested without a car or an ENET adapter:
`deploy/test/transport_test.py` (run by `run.js`, on the system `python3`)
covers the selection with stand-ins for the adapter, HSFZ, the certificate
and the banner probe, the banner check and the relay against servers on
`127.0.0.1`, and the `--arm-debug` sequence, hold and disarm.
`deploy/hu`'s own tests run the real transport with `MGU_CONNECT_FAKES`
pointing at `deploy/test/fake_transport.py` (the unit as a banner server on
`127.0.0.1`) and check the target of every ssh call.

## [on-car-unconfirmed]

- The manager's fresh install of an app listed only by the fallback, and an
  update re-seeded with `installationSource: null`, on the car (both proven on
  a test unit).
- The in-place install and update on the car (proven on a test unit): the
  running manager installing with the other apps up, its trigger_service
  check at each install, and only that app stopping and starting.
- The in-place uninstall on the car (proven on a test unit): the
  tile leaving the HMI at once and the other apps staying up.
- oapcontroller's crash counting and alive window on the car (proven on a
  test unit; the 60 s spacing covers it, with room for a slower start).
- recmgr's rules: an entry counts once it was in the list at boot; a stopped,
  unlisted service rebooting the unit.
- The rootfs window (`mount -o remount,rw /` and back to `ro`).
- The fallback anchors in the car's `main.js`, and the bind mount taking
  effect before oapcontroller starts.
- `setquota` clearing an app uid's quota on `/var/opt`.
- busybox `tar -xzf -` reading the staging stream from ssh stdin.
- SSH over the ENET relay in field mode.
- The unit answering DID `22 17 2A` while debug is disarmed.
- `mgu-install.js` over ENET: the gateway answering identification sent from
  the interface's address, and `ssh -b <that address>` reaching the unit's
  link-local address on macOS, Linux and Windows.
- `deploy/hu`'s `--arm-debug` flow end to end on the car.
- The migration of the retired installer's leftovers on the car: its
  backups' names and content, and our apps keeping their tiles through the
  fallback once the stock bundles are back (proven on a test unit with a
  reproduction of the car's state).
- The car's donors: which preinstalled package resolves the Store's sdk
  names first (on a replica of the car's rootfs it is
  `ts_diagnostic_service@4.20.2`, oap-sdk 24.10.2 with module ids of its
  own; x_call's closure is byte-identical to oap-sdk 24.10.2), and the
  Store built from it, with that package's entry point, starting on the car.
- A package built elsewhere running on the car with the generated
  `node_modules/oap-sdk` under the manager's install (its native modules
  resolved for the app as for a stock app).
- `/run/mgu-deploy` writable and readable by other uids on the car.

On an iDrive 8 head unit (IterioDev's car), the
whole iDrive 8 path:

- the detection (`/usr/lib/oap-mainapp21` present and
  `/usr/lib/oap-mainapp` absent; the `Hmi8` process name; the firmware line
  from `/etc/os-release-id-dlt` or `/etc/os-release`);
- whether `/etc/recmgr-restartlist.conf` exists there (without it units
  start at once; with it, the iDrive 7 rules hold);
- `mgu-deploy-apply.service` running at boot before oapcontroller with
  `late.target`, and `apply-pending`'s das edits, package placement and
  removal steps giving the same result as the App Manager's;
- MainApp-21 installing an npm-format package from `preinstalled_apps`
  repacked by this tool (a flat or `.mgu` one), and a source package built
  from an iDrive 8 donor;
- the renderer and tether units as written here (a renderer the App
  Manager installed is refused here; remove it there first);
- MainApp-21 running as node with `oap-mainapp21/src/main.js` as its script
  (`apply-pending` refuses while it runs, by that);
- live changes (the copy bound at boot, the hook, tiles shown and removed
  at once, no corruption handling in oapcontroller's log) on the car's
  MainApp-21 build;
- MainApp-21 supplying `oap-sdk` to an npm package that names it in
  `dependencies` without shipping it (IterioDev's packages do so).
