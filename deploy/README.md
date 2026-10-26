# deploy: our tools and apps on the head unit

One installer puts our root tools (`native/<id>/component.json`) and OAP apps
(`apps/<id>/release.json`) on the unit, updates, rolls back and removes them,
snapshots every change first, and restores a snapshot on request.

| Part | Runs on | What it does |
|---|---|---|
| `deploy/mgu-install.js` | the owner's computer (Node 18+; Windows, macOS, Linux) | the first install over SSH from the published release, the updater's tokens, USB sticks as local repos |
| `deploy/hu` | the Mac (system Node) | packs tool artifacts, installs components built from this checkout over SSH (development) |
| `deploy/sources.json` | | the updater's sources the installers seed: the Store's own |
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
  (claude-bmw-ecu `mgu18/PERSISTENT_SSH_SETUP.md`); nothing arms, disarms or
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
  Then make SSH permanent (claude-bmw-ecu `mgu18/PERSISTENT_SSH_SETUP.md`)
  and go back to the default. `--arm-debug` with `--wifi` or `--hu-ip` is a
  usage error.

A selected connection uses the assets' key (or `--identity`) and passes
`StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`,
`LogLevel=ERROR` and `ConnectTimeout=8`: `127.0.0.1:<lport>` stands for
whichever unit answers.

**Assets.** The SSH key and the debug-certificate material are **not in this
repository** and must never be committed. `--assets-dir <dir>`
(`HU_ASSETS_DIR`; default
`~/workspaces/personal/claude-bmw-ecu/mgu18/tool_analysis/cap_assets`) holds
`mgu_ssh_key_rsa.pem` (root's key on the unit), and for `--arm-debug` also
`asset_03.bin` (PMO intermediate CA certificate) and `asset_04.bin` (its
key). `--identity` replaces the key. A missing file stops the command
before any connection, naming the file and the folder it looked in.
`--arm-debug` also needs the Python package `cryptography`.

**State.** The last ENET address that answered is written to
`~/.cache/mgu-store/last_hu_enet_ip` (`HU_STATE_DIR`), and also read from
`last_hu_enet_ip` beside the assets folder, where the claude-bmw-ecu tools
kept it.

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

The emulator:

```sh
deploy/hu status --host 127.0.0.1 --port 2225 \
    --ssh-opt StrictHostKeyChecking=no --ssh-opt UserKnownHostsFile=/dev/null
```

Exit status everywhere: 0 done, 1 failed (rolled back where it applies),
2 refused before anything changed (and bad usage).

### The updater's sources and tokens

The updater reads its sources from `/var/opt/mgu-updater/sources.json`
(native/mgu-updater/README.md). The installers seed it with
`deploy/sources.json`, the Store's own source (`mgu-store`, this
repository's releases), when the updater is installed and has none: `sh
mgu-deploy.sh updater-sources < sources.json` writes it, root's, mode 0600,
and keeps an existing one, since the owner adds sources from the Store.

The updater's tokens are its own, not a source's (native/mgu-updater/
README.md, "Tokens"): each one's text in `/var/opt/mgu-updater/credentials/
token-<id>` and its entry (id, label, account) in `credentials/tokens.json`,
root's, mode 0600, in a 0700 folder; the updater reads each GitHub source
with whichever token reaches it. The owner supplies a GitHub token (one
that reads the mgu-store repository, and any other private repository the
car reads) as a file on the Mac; it is never committed. `deploy/hu install
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
`files/<path>` and `units/<name>`. `deploy/hu artifact` builds it from a
folder holding a `component.json` (`native/<id>`, or `deploy` for the deploy
tool itself):

- `build`, when present, is a command run in that folder first
  (mgu-uplink: `make target`, which needs Go);
- `files[{path, from, mode}]` are read from `from`; a missing one fails,
  naming the build command;
- the artifact's `component.json` is `{id, kind, version, title,
  description, files[{path, mode, sha256}], units[{name}], enable, recmgr,
  restart}`, and `internet` with `uids` when the tool declares them;
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

## mgu-install

`deploy/mgu-install.js` is the owner's side: one file, no dependencies,
Node 18 or newer (its own `fetch`, `crypto` and `zlib`; what it sends is
packed in Node, no `tar`, shell or Python on the computer), driving the system's
OpenSSH client (`ssh`, built into Windows 10/11, macOS and Linux). Every
command reaches the unit with `--host <address>` (`172.16.222.97`, the
car's hotspot), `--port <n>` (22), `--user <name>` (root), `--identity <key
file>` and repeatable `--ssh-opt <option>` (`ssh -o`, before the tool's
own); with OpenSSH 8.8 or newer it adds `HostKeyAlgorithms=+ssh-rsa` and
`PubkeyAcceptedAlgorithms=+ssh-rsa`, which the unit's sshd needs. The ENET
relay and `--arm-debug` stay with `deploy/hu`: `deploy/hu connect --hold
<s>` holds the relay, and `--host 127.0.0.1 --port 2222` reaches it.

```sh
node mgu-install.js first-install [--with-uplink] [--token] [ssh options]
node mgu-install.js token [--list [--json] | --remove <id>] [ssh options]
node mgu-install.js usb-repo <stick folder> [<input>...]
```

```powershell
node .\mgu-install.js first-install --identity $HOME\.ssh\mgu_root_key --token
node .\mgu-install.js token --host 192.168.1.50 --identity $HOME\.ssh\mgu_root_key --list
node .\mgu-install.js usb-repo E:\ github:robertnisipeanu/mgu-store
```

**first-install** reads the `catalog` release of
`robertnisipeanu/mgu-store` (release/README.md), takes every entry but the
optional ones (with `--with-uplink` also `mgu-uplink`), downloads each
artifact and checks its size and sha256 against the catalog; a mismatch
stops it before it connects. The deploy tool's own files come from the
published `mgu-deploy` artifact, each checked against its manifest; nothing
is built on the computer, and the Store's source package is built on the
unit. One ssh call sends them as a tar stream to
`/var/opt/mgu-deploy-kit-<pid>` (0700) and runs there: `mgu-deploy.sh
install --artifact ... --skip-older --yes` with the release's deploy tool
(it installs itself as `mgu-deploy`, keeps newer installed tools and apps,
does not build an installed Store version again) and `updater-sources`
with the mgu-store source (kept when the unit has its own); then removes
the folder. With `--token` a token is added (below), then `status` is
printed. Its last line
is `Restart the head unit to finish setup (a normal ignition cycle does
it): the updater starts then.` while `mgu-updater.service` (or, with
`--with-uplink`, `mgu-uplink.service`) is not active, else `Setup is
done`. Exit status: 0 done, 1 failed, 2 refused (the deploy tool's own).

Before installing, the car is parked, on stable power (engine running or a
charger connected), and stays awake until the command finishes.

**token** adds a GitHub token for the updater: read from a hidden prompt
(not echoed), or from stdin when stdin is not a terminal, never from an
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
| package files `*.tgz`, `*.mgu` | `local` | added to `local/`'s catalog by their content: an app (`package.json` flat, under `package/`, or a `.mgu`), a source package (`mgu-app.json`, `build: "unit"`), a tool kit (`component.json`); of an id the higher version stays |

No input: `github:robertnisipeanu/mgu-store`. A written catalog is schema
2 with the source's fields (`build`, `requires`, `optional`,
`uninstallable`; apps from releases or package files are `uninstallable`)
and each artifact beside it under a relative URL; an `.mgu` keeps its file
name and is listed as `<id>@<version>.tgz`, which the deploy tool installs
by its content. A folder is written next to the old one and replaces it
once complete, so the stick holds the newer versions only; other folders
and the stick's other files stay. A root-service package (`mguService`), a
folder over the updater's limits (catalog.json over 1 MiB, a checkout over
200 MB or 20000 files) or an artifact that does not match is refused.

## On the unit

```
mgu-deploy.sh check [--artifact <file>...]
mgu-deploy.sh install [--artifact <file>...] [--skip-older] [--yes]
mgu-deploy.sh status [--json]
mgu-deploy.sh uninstall <id> [--yes]
mgu-deploy.sh rollback <id> [--yes]
mgu-deploy.sh restore [name] [--yes]
mgu-deploy.sh backups
mgu-deploy.sh fallback <on|off|status|migrate> [--yes]
mgu-deploy.sh updater-token                   # a token on stdin
mgu-deploy.sh updater-token --list [--json] | --remove <id>
mgu-deploy.sh updater-sources                 # sources.json on stdin
mgu-deploy.sh sdk-donor [--json]
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
/var/opt/mgu-deploy/versions/<v>/        the deploy tool itself (mgu-deploy.js, .sh, fallback_build.js,
                                         mgu-app-fallback.service, oap_link.js, oap_pack.js)
/var/opt/mgu-deploy/current -> versions/<v>
/var/opt/mgu-deploy/mgu-deploy.sh        shim: runs current/mgu-deploy.sh
/var/opt/mgu-deploy/state.json           pending reboots, apps' uids, the last bounce
/var/opt/mgu-deploy/recmgr-at-boot.json  the recmgr list as it stood at this boot
/var/opt/mgu-deploy/lock                 the changing run's pid and boot
/var/opt/mgu-deploy/backups/<time>-<command>/, backups/stock/   (0700)
/var/opt/mgu-deploy/main.js              the fallback copy of the manager's main.js
/var/opt/mgu-deploy/inplace/request.json an in-place install request, while one is pending
/var/opt/mgu-updater/sources.json        the updater's sources, seeded (0600)
/var/opt/mgu-updater/credentials/        the updater's tokens: token-<id>, tokens.json (0600, folder 0700)
/var/opt/mgu-uplink/uids.d/<id>          a tool's uids that get internet
/var/opt/mgu-uplink/apps.d/<id>          an app that gets internet
/run/mgu-deploy/sdk-donor/               the donor bundle's readable copy (sdk-donor)
/usr/lib/oap-mainapp/preinstalled_apps/<id>@<version>.tgz
/var/opt/public/oap/oap_12201/data/apps/<id>.json   an app's registry entry
/var/opt/public/oap/oap_12201/data/custom_apps.json the apps the fallback lists
/var/opt/public/oap/oap_12201/data/mgu-deploy-inplace.json the manager's in-place hook and its last answer
/var/opt/public/oap/oap_<uid>/           an app's home (source/, data/, security/, someipInterfaces/, ...)
```

Writes under `/` (units, the recmgr list, preinstalled packages) go through
one shell script per operation that remounts `/` read-write and remounts it
read-only on any exit; a `/` found read-write stays read-write.

### The deploy tool as a tool

`mgu-deploy` is a tool component like the others (`deploy/component.json`;
`VERSION` in `mgu-deploy.js` equals its version). Run from a staging
folder, every successful install or uninstall, and turning the
fallback on, installs the files it runs from into
`/var/opt/mgu-deploy/versions/<VERSION>/`, under the `component.json` beside
the script (synthesized from `VERSION` and its six files when there is
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

`uninstall mgu-deploy` is refused (exit 2): a running tool does not remove
itself. `restore` puts back what the tool changed and keeps the tool;
`/var/opt/mgu-deploy` is removed by hand when wanted.

**Version rule.** Bump `deploy/component.json`'s version, and `VERSION` with
it (`node release/release.js bump mgu-deploy <x.y.z>` sets both), whenever a
file under `deploy/unit/`, `tools/oap_link.js` or `tools/oap_pack.js`
changes; `deploy/hu`, `mgu-install.js`, the tests and this README are not part
of the artifact.

### Tools

A tool installs into `versions/<version>/` (files with their listed modes,
folders 0755) and `current` switches to it by rename. Once it is up, only the
new version and the one `current` pointed to before stay; others are
removed. Units, enablement links and the recmgr list change only when their
bytes differ, then `systemctl daemon-reload`. Reinstalling the same artifact
changes nothing but adding a snapshot.

**Prune boundary.** A second update in the same boot prunes the version a
running service may still execute from (it keeps only the new one and the
previous `current`). Tools that start from `current/` on each start are
unaffected; a long-running process started from an older version keeps its
open files but cannot load new ones from that folder.

recmgr reads its restart list only at boot. A tool's `recmgr` names go into
both `[Whitelist]` and `[WhitelistExitSuccess]`; other lines and sections are
kept as they are. A stopped service that recmgr does not list reboots the
unit, which is why nothing is stopped, started or restarted before recmgr has
loaded its entry: its name in both sections now and in the list as it stood
at boot (the file while it is older than the boot; once the tool writes it
in a boot, the copy it saved first, `recmgr-at-boot.json`). For each unit in
`restart`:

- running: restarted when recmgr has loaded its entry; otherwise it keeps
  running the previous version and `status` reports the tool under
  `pending_reboot` until the next boot;
- not running, on a fresh install: started under the same rule; otherwise
  left stopped and reported pending with reason `starts at the next boot`.

A unit enabled as a `.socket` starts under the same rule, when recmgr has
loaded its entry, else at the next boot (pending): the service it activates
can stop like any other. That service is left to the socket. `restart: []`
starts or restarts nothing. `oapcontroller` is never stopped or restarted: an
artifact naming it is refused.

**Health check.** Every unit the tool restarts or starts is read with
`systemctl show -p ActiveState -p NRestarts` right after, and again
`MGU_DEPLOY_HEALTH_MS` later (default 10 s): it must be `active` with
`NRestarts` unchanged. A oneshot with `RemainAfterExit` passes as `active`; a
failed one does not. When the check fails, `current` returns to the previous
version, the snapshot puts units and the recmgr list back, the unit restarts
on the previous version and is checked again (the result is printed), and
the install exits 1. With no previous version, the new one stays current,
reported as not healthy, exit 1.

`uninstall <id>` stops the tool's running units (when recmgr has loaded
them), removes its units, links and the recmgr names no other tool lists,
and the whole `/var/opt/<id>`: besides `versions/` and `current`, a tool's
own config there goes too, named in the output (the updater's
`sources.json` and `credentials/`, the uplink's `local.conf`, `uids.d/` and
`apps.d/`). A `.wants` folder the tool
created is removed once it is empty; folders that were there before stay.

### Rollback

`rollback <id>` switches a tool's `current` to its one other kept version.
With no other version, or more than one, it is refused (exit 2, listing
them). It snapshots first, then restarts that version's `restart` units under
the same recmgr rules and health check; a failed check switches back,
restarts again and exits 1. When recmgr has not loaded the entry the switch
still happens and the tool is reported pending. Unit files are not rolled
back: they run from `current/`, so they stay as the newer version installed
them; when the two versions list different units, `rollback` says so, and an
install of the wanted artifact changes them. `rollback app-privacy` also runs
its `apply` (below). `rollback mgu-deploy` switches `current` and exits; the
shim and the updater run that version from the next call.

Apps have no rollback (exit 2): the app manager refuses a downgrade, so an
older app version is installed by uninstalling the app, then installing the
older artifact.

### app-privacy

The `app-privacy` tool must be in effect before the manager sees an app
(`native/app-privacy/INTEGRATION.md`). After installing or rolling back the
tool, the installer runs its `patch_mainapp.js apply --json` and bounces the
manager when it reports `changed` or `restartNeeded`. When `apply` fails,
`current` returns to the previous version and its `apply` runs again (exit
1); with no previous version the tool stays installed and the output says
the patch is not in effect, so app installs are refused until `apply`
succeeds.

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

### Apps

The app manager installs our apps itself.

- **Precondition.** The app-privacy patch must be in effect before the
  manager sees an app: without `/var/opt/app-privacy/current/patch_mainapp.js`
  an app install is refused. The installer runs its `apply --json` and
  bounces the manager when the patch changed or the running manager predates
  it.
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
  minutes) for the manager's registry entry with an `installationSource`, the
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
  it. Only a higher version installs; the same version is reported as
  already installed (exit 0), a lower one is refused.
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
(`tools/oap_pack.js`). The result installs as any app. The same
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
flat, marked packages are installed byte for byte. A package that needs
the oap-sdk on a unit with no donor is refused (exit 2, nothing changed).

`sdk-donor [--json]` copies the bundle module mode takes the oap-sdk from to
`/run/mgu-deploy/sdk-donor/javascript/app.js` (0644, folders 0755), beside a
`package.json` naming its oap-sdk version, and prints its path (`{"path",
"donor", "sdkVersion"}` with `--json`). The updater hands it to a
repository's own build as `MGU_SDK_DONOR` (docs/PUBLISHING.md). No lock, no
snapshot; exit 2 when no donor holds the core.

### Internet for selected components

A tool whose `component.json` says `"internet": true` lists its numeric
`uids`; an app's built or published `package.json` says `"mguInternet":
true`. After every install and uninstall, while `mgu-uplink` is installed,
the tool writes `/var/opt/mgu-uplink/uids.d/<id>` (the uids, one per line)
and `apps.d/<id>` (the app id) for every installed component that declares
it, and removes the ones of components that are gone; installing
`mgu-uplink` writes them all. mgu-uplink reads both folders besides its
conf. The files are in the component's snapshot.

### One transaction per artifact

Each artifact of an `install` is its own transaction, with its own snapshot.
When one fails, only its changes are undone: its new version folder (no
`versions/` without `current`), a socket it started whose unit is removed
again, its preinstalled package, its `custom_apps.json` entry, an app home
the manager created for it during the attempt, and the fallback when this
install turned it on (the copy is rebuilt or unbound to match). Artifacts
installed before it in the same call stay installed, and the output says so
(the updater installs one artifact per call). The app-privacy patch stays
applied after a failed app install while the app-privacy tool is installed.

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
folder) and `/var/opt/mgu-deploy-kit-<n>` folders a day old.

`restore [name]` (default `stock`) first snapshots the current state, then
puts every recorded file back, removes what the snapshot shows as absent
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

app-privacy patches the app manager's bundles in place. A restore that
removes it first runs its `revert --json` (on the fallback copy and the stock
`main.js` under it, as `uninstall` does) and bounces the manager when the
bundles changed.

### Provisioning fallback

Our apps install through it. `fallback on` (and every app install) builds a
copy of the stock `/usr/lib/oap-mainapp/src/main.js` with one change in
`ProvisioningNotifier`: an app with no provisioning entry takes it from
`oap_12201/data/custom_apps.json`, which lists our apps, both in MainApp's
`installable_apps` (so the manager installs it) and as the app's own section
(its flags, which give it its tile and start type). An app provisioning
lists keeps its own entry. The build needs both anchors (`class
ProvisioningNotifier extends events_1.EventEmitter{` and the
`installable_apps` hook) exactly once in the stock file; any other count
refuses it and nothing is written. The copy also carries the in-place
install hook (Apps, above), in main's start-up once MainApp has
initialized, at the step after `mainApp.init()`:

```
kpiLogger.info("MARKER All components instantiated. Initializing."),mainApp.init()}).then(()=>{
```

When that anchor does not occur exactly once, the copy is built without
the hook and the build says so; app installs then go through a bounce.

The copy, with the app-privacy patch applied to it, is `/var/opt/mgu-deploy/main.js`,
bind-mounted over the stock file; a rebuild unmounts the old copy, builds
from the stock file and binds the copy again, rewritten only when its bytes
change.

`mgu-app-fallback.service` (enabled, listed in recmgr, before oapcontroller
and app-privacy) rebuilds the copy from the stock file at every boot with
`/var/opt/mgu-deploy/current/fallback_build.js` and bind-mounts it; when the
build refuses (a firmware update changed `main.js`), the stock file stays in
effect. `fallback off` unmounts it and removes the unit, its link, its recmgr
entry and the copy; apps installed already stay installed, and a new app
install turns it on again. `status` shows per app whether its tile comes from
provisioning (`tile_provisioned`) or the fallback (`tile_fallback`), from the
flags the manager persisted in its `provisioningCache`. Provisioning's own
section for an app's id wins over the fallback: when it disallows the app the
tile stays hidden (`tile_visible: false`), and the install says so.

### The retired installer's leftovers

claude-bmw-ecu's retired installer (`tools/mgu7_install_app.py`) listed its
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
  "components": [{ "id", "kind": "tool", "version", "units": [{ "name", "enabled", "active", "journal" }] },
                 { "id", "kind": "app", "version", "uid", "installationSource", "running",
                   "tile_provisioned", "tile_fallback", "tile_visible" }],
  "pending_reboot": [{ "id", "reason" }],
  "display_bridge_socket": true, "display_bridge_todo_on_car": ["<key>: TODO(on-car): ..."],   (display-bridge)
  "fallback": { ... }, "backups": 3, "stock_backup": true, "updater_tokens": 1,
  "retired_leftovers": ["/usr/lib/oap-mainapp/src/main.js.capbak"] }
```

## Tests

```sh
node deploy/test/run.js              # MGU_TEST_ONLY=testKit,... runs those test functions only
sh deploy/test/run.sh                # in Docker: the unit's code on Node 8.16.2 (MGU_TEST_UNIT_NODE)
node tools/test/run.js               # the linker and packer; sh tools/test/run.sh: on Node 8.16.2
```

Offline, against a fake root (`MGU_DEPLOY_FAKE_ROOT=1` and the
`MGU_DEPLOY_*` path and command overrides at the top of `mgu-deploy.js`;
`systemctl`, `journalctl`, `ps`, `kill`, `ssh`, the app manager and
app-privacy are the stand-ins in `deploy/test/`): reproducible artifacts
(the deploy tool's own included), refused artifacts leaving the root
unchanged, tool layout, pruning and idempotence, pending reboots, restarts
with their health check and the rollback after a crash loop, `rollback`,
app-privacy as a tool, the fresh-install and update flows through the
simulated manager, bounce spacing, per-artifact transactions, the stock
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
and `mgu-install.js`: `first-install` and `token` against a fake root
through a stand-in `ssh` (`fake_ssh_exec.js`) with the release from a
stand-in GitHub API (`fake_github.js`: a private repository, downloads
redirected to another host), run twice (the restart line while the
updater is not running, none once it is), with the uplink, without a
token, with an artifact that does not match; `usb-repo` from every kind of
input, the stick then read by the updater's own `sources.js` on the unit's
Node (`stick_read.js`); and Windows paths and names (`path.win32`).
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
  update re-seeded with `installationSource: null`, on the car (both proven in
  the emulator).
- The in-place install and update on the car (proven in the emulator): the
  running manager installing with the other apps up, its trigger_service
  check at each install, and only that app stopping and starting.
- The in-place uninstall on the car (proven in the emulator): the
  tile leaving the HMI at once and the other apps staying up.
- oapcontroller's crash counting and alive window on the car (proven in the
  emulator; the 60 s spacing covers it, with room for a slower start).
- recmgr's rules: an entry counts once it was in the list at boot; a stopped,
  unlisted service rebooting the unit.
- The rootfs window (`mount -o remount,rw /` and back to `ro`).
- The fallback anchors in the car's `main.js`, and the bind mount taking
  effect before oapcontroller starts.
- `setquota` clearing an app uid's quota on `/var/opt`.
- busybox `tar -xzf -` reading the staging stream from ssh stdin.
- SSH over the ENET relay in field mode (claude-bmw-ecu
  `mgu18/SSH_CONNECT_STEPS.md`).
- The unit answering DID `22 17 2A` while debug is disarmed.
- `deploy/hu`'s `--arm-debug` flow end to end on the car (the sequence and
  the reboot requirement are the claude-bmw-ecu tools' proven ones).
- The migration of the retired installer's leftovers on the car: its
  backups' names and content, and our apps keeping their tiles through the
  fallback once the stock bundles are back (proven in the emulator on a
  reproduction of the car's state).
- The car's donors: which preinstalled package resolves the Store's sdk
  names first (on a replica of the car's rootfs it is
  `ts_diagnostic_service@4.20.2`, oap-sdk 24.10.2 with module ids of its
  own; x_call's closure is byte-identical to oap-sdk 24.10.2), and the
  Store built from it starting on the car.
- A package built elsewhere running on the car with the generated
  `node_modules/oap-sdk` under the manager's install (its native modules
  resolved for the app as for a stock app).
- `/run/mgu-deploy` writable and readable by other uids on the car.
