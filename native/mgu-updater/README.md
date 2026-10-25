# mgu-updater

The head unit's updater: a root daemon that reads its **sources** (GitHub
repos, catalog URLs, USB sticks), compares what they list with what is
installed, and downloads, builds and installs new versions of apps and
root tools, itself included, and removes them on request. The Store app
(`apps/robertn_store`) is its screen, the phone page (`js/web.js`) its
second one. On the Store's request it also restarts the head unit.

```
 sources (sources.json: GitHub repos, catalog URLs; USB media under /media)
        │ HTTPS, as uid 12990 through the apps-only uplink (native/mgu-uplink)
        ▼
 fetch.js ──► state/dl-<random>/<file>                (a folder root made for this download, the fetch uid's)
        │
 updater.js (root): read it (no links, regular file, bounded), check its size + sha256,
        │            pack a repo-tree component, or run the repo's build script as uid 12992 (build.js)
        │            write the checked bytes to state/verified/ (root only)
        ▼
 /var/opt/mgu-deploy/mgu-deploy.sh install --artifact <file> --yes   (runs current/)
        ├─ app:  MainApp's own install (a source package or a third-party package built on the unit first)
        └─ tool: /var/opt/<id>/versions/<v>/ + `current` switched by rename, units, recmgr
        ▲
 Store app, phone page ── /dev/shm/mgu-updater/updater.sock (state stream; requests)
```

## Installers

Two installers put our tools and apps on the car, and both run one install
core, the deploy tool's on-unit `mgu-deploy.js` (`deploy/README.md`):

- **Local**: `deploy/hu` on the Mac, over SSH or from the USB kit. It
  bootstraps the car and installs the deploy tool, the uplink and this
  updater.
- **Sources**: this updater and the Store. It hands each verified
  artifact to `/var/opt/mgu-deploy/mgu-deploy.sh install --artifact`.

Both take the same artifacts (`release.js` packs tools with `deploy/hu
artifact`), the same `component.json`, the same `versions/<v>` + `current`
layout and the same `"mguLocalOnly": true` marking, so a component
installed by one is updated or removed by the other. The emulator's image
provisioning installs apps for testing only.

## Sources

`/var/opt/mgu-updater/sources.json` (`sources`; root, 0600, written by
rename) lists them in order; the Store and the phone page add and remove
them:

```json
{ "schema": 1, "sources": [
  { "id": "mgu-store", "type": "github", "repo": "robertnisipeanu/mgu-store", "builtin": true },
  { "id": "mgu-apps",  "type": "github", "repo": "robertnisipeanu/mgu-apps" },
  { "id": "idrive7-apps", "type": "github", "repo": "someone/idrive7-apps", "channel": "branch:main" },
  { "id": "s-3f9a",    "type": "https",  "url": "https://example.org/repo/catalog.json" }
] }
```

- `github`: a repo, read through the REST API (`github_api`). `https`: a
  `catalog.json` URL. `file`: a local folder (tests, the emulator).
- `builtin`: the Store's own source (`builtin_repo`, id `mgu-store`),
  always there and not removable.
- Nothing is signed: trust is HTTPS (and the source's credential) to a
  source the owner added; every download is checked against the size and
  sha256 its source lists, or, where the source names none (release
  assets, repo trees), its sha256 is taken on download. A `signature` in a
  catalog is ignored.
- A source that cannot be read keeps the components it listed last
  (`state/sources/<id>.json`).

**Layouts.** A source reads as the first of these it has:

| Layout | Where | Components |
|---|---|---|
| catalog | a `catalog` release's `catalog.json` asset (`release/README.md`), the https URL, `catalog.json` in a folder | schema 1 or 2 entries; artifact URLs absolute or relative to the catalog |
| releases | a GitHub repo's releases (newest first, drafts and prereleases left out): assets named `<id>@<x.y.z>.tgz` or `.mgu` | each id's newest version, the `.tgz` over the `.mgu` of one version; titles from an optional `mgu-store.json` asset (`{"apps":{"<id>":{"title","description"}}}`), else the installed app's en_GB entry-point text, else the id; always apps |
| repo tree | `mgu-repo.json` at a repo's or folder's root, at one commit | see below |

**Channels** (a `github` source's `channel`): `releases` (the catalog
release, else the releases layout), `branch:<name>` (`mgu-repo.json` at
the branch's head commit; each commit is a revision), `tags`
(`mgu-repo.json` at the highest `v1.2.3`, `1.2.3` or `<id>@1.2.3` tag's
commit). Without one: `releases` when the repo has a release, else
`branch:<default branch>`. The state shows the channel in use.

**Repo trees.** `mgu-repo.json`:

```json
{ "schema": 1, "components": [
  { "id": "robertn_demo", "kind": "app", "path": "apps/robertn_demo" },
  { "id": "redline", "kind": "app", "path": "apps/redline", "build": { "node": "kit/tools/build.js", "args": ["redline"] } },
  { "id": "my-tool", "kind": "tool", "path": "native/my-tool", "uninstallable": true } ] }
```

- An app with `mgu-app.json` in its folder is a **source package**: the
  folder packed as it is (`mgu-app.json` at the root), built and installed
  by the deploy tool (phase `build`).
- An app with `build.node` is built by the repo's own script (below); its
  version and title come from `app.json`, else `package.json`, in its
  folder.
- A tool is its folder's `component.json`, packed as a tool kit
  (`files/`, `units/`, each file's sha256; the other fields kept). It needs
  no build step: one with `build` is left out.
- `title`, `description`, `requires`, `optional` and `uninstallable` come
  from the entry, else from the component's own file. A component that
  cannot be used is left out and the source's `error` says why; the rest
  are listed.
- GitHub: the files are read at the commit through the contents API, and
  an install downloads the repo tarball at that commit (`/tarball/<sha>`,
  at most `repo_max_bytes`; links in it are left out). A folder is read in
  place.
- On a branch, a commit of the same version is an update too: a row's
  `revision` is the short commit it would install, and
  `state/origins.json` records the commit installed.

**Building on the unit.** `build.node` runs under this Node as
`build_uid` 12992 (no account, in none of the uplink's lists: no network),
in a copy of the repo in `state/build-<random>/repo` that only it can
write, with `MGU_SDK_DONOR` (the donor bundle `mgu-deploy.sh sdk-donor
--json` names, read-only), `MGU_OUT` (an empty folder) and `HOME`/`TMPDIR`
in its own folder. It must leave exactly `<id>@<version>.tgz` in
`MGU_OUT`, which goes to the deploy tool like a release package (an
`oap-sdk` module generated for it there when it requires one). It is
stopped past `build_timeout_s` (600) or once its folder holds more than
`build_max_bytes` (200 MB); every process of the build uid is killed
before a build and after it, so nothing a script leaves running reaches
the next one; its output goes to the log as `build <id>:` lines; the
folder is emptied as the build uid afterwards. An install asked for while
a removal of the same component waits (or the other way round) is
refused.

**Ids.** Component ids are global on the unit. An id two sources list is
shown once, from the source that installed it (`state/origins.json`), else
from the first source in order (USB media last). `requires` (`{"<id>":
"<min version>"}`) installs a missing or older requirement first, from the
same source if it has one at least that version, else from any (a
newer updater installs alone: it restarts into its new version, which ends
the queue, and the component is asked for again after);
`optional` components are listed but never counted as updates unless
installed; `uninstallable` ones can be removed (Store, phone page), through
`mgu-deploy.sh uninstall <id> --yes`, unless something installed requires
them. The updater and the deploy tool are never removed.

**Credentials.** `/var/opt/mgu-updater/credentials/<source id>`
(`credentials_dir`; root, 0600) holds a source's token, and `<id>.json`
what is known of it (the account, its expiry, a refresh token). A token is
in no file the Store or the phone page can read and never in the state
stream. A GitHub token goes only to `api.github.com` (never to
`github.com`, `codeload.github.com` or the asset storage a download
redirects to); an https source's token only to its catalog's host. A
GitHub source that answers 401 or 404 for the repo, and an https source
that answers 401 or 403, is `auth-needed`.

**Signing in to GitHub.** `login-start` runs GitHub's device flow for a
GitHub App (`github_client_id`; empty until the App exists, and then
sign-in is refused while a pasted token still works): the state's `login`
shows the address and the code, which the owner enters on a phone; the
updater polls at the interval GitHub gives (5 s more on `slow_down`) until
the code expires, and keeps the token as the source's credential, with
the account from `/user`. An expiring token is renewed from its refresh
token before the source is read. The App: *Enable Device Flow* on,
repository permission *Contents: Read-only* (Metadata comes with it),
installed on the repos the car reads; its client id goes in
`github_client_id`. Requests to `github.com` carry the client id with the
device code, or with the refresh token on a renewal; never an access
token.

**USB media.** udisks mounts a stick at `/media/<label>` and nothing
announces it, so every `usb_poll_s` (5 s) and on each check the updater
reads `/proc/mounts` (`mounts`) for mount points directly under
`usb_roots`. On each, the root, `mgu-repo/` and `mgu-repo/<name>/` that
hold `catalog.json` or `mgu-repo.json` are sources `usb:<label>[/<path>]`,
until the stick goes. A checkout copied to a stick reads as its repo tree
(no revision). A stick's `oap/` folder (the community App Manager's) is
source `usb:<label>/oap`: each `*.tgz`, `*.tar.gz` or `*.mgu` in it, under
any name, flat or with npm's `package/` prefix, is an app with the id and
version of its own `package.json` and the title of its en_GB entry-point
text, else its `productName`, else its name; the newest of an id wins, a
package whose `package.json` has `mguService` (a root service, not an app)
is left out, and its sha256 is taken as it is listed. It installs as
`<id>@<version>.tgz` (or `.mgu`). Sticks are only read: no link is followed (a folder or file
reached through one is not there), only regular files, every size bounded.

**First start.** Without `sources.json` the updater writes one
(`js/migrate.js`): the built-in source, and on a unit the mgu-apps updater
set up (`updater.local.conf` or `/var/opt/mgu-updater/github-token`
there) also that updater's catalog (`catalog =`, by default
`github:robertnisipeanu/mgu-apps`, as source `mgu-apps`), both GitHub
sources with the old token as credential. The credentials are written
first, `sources.json` last; the old files stay as they are, for a version
the supervisor may return to.

## What it does

- **Reading the sources.** At start (after `first_check_s`), every
  `check_interval_s`, when the uplink comes up, on a stick, and on request
  (Store, `updater.js check`); a source added or given a token is read at
  once. Each source's state: `ok`, `checking`, `error`, `auth-needed` or
  `offline` (a network source without the uplink).
- **Installed versions.** Apps from MainApp's registry
  (`/var/opt/public/oap/oap_12201/data/apps/<id>.json` names the app's uid,
  `oap_<uid>/source/package.json` its version). Tools from
  `/var/opt/<id>/current/component.json`. Only components a source lists
  are looked at.
- **Installing.** On request only, one at a time (later requests queue).
  Nothing is installed on its own: an app install restarts every running
  OAP app, which must not happen unasked. The artifact is downloaded (or
  packed, or built), copied root-only and checked, then handed to the
  deploy tool's `install --artifact`, the one install path every app and
  tool takes on the unit. Exit 0 is done (a tool whose service cannot
  restart yet reports "takes effect after reboot", shown as *Restart
  pending*), 1 failed and rolled back, 2 refused by preflight.

## Downloads: apps-only internet

The unit has no default route to the internet; mgu-uplink lets only listed
uids out. The updater does every download in a child process (`fetch.js`)
running as `fetch_uid` (12990), which `native/mgu-uplink/mgu-uplink.conf`
lists under `uids`. That uid has no account and can write only the folder root makes for
each download: the HTTPS and HTTP handling runs without privileges, and the
root daemon reads only the downloaded file, through a descriptor that
follows no link and only if it is a regular file within the size expected.
Root removes download folders by running `rm -rf` as the
fetch uid, so nothing planted in them leads root anywhere, and the
fetcher can change nothing it installs.

- Names resolve through the DNS servers of the uplink's lease
  (`/run/mgu-uplink/lease.json`); without a lease the unit is offline and
  the Store says so.
- HTTPS only, Node's bundled roots (or `ca_file`). Redirects of a GET are
  followed, but request headers go to the first host only: a token never
  reaches the storage a download redirects to. The device flow's POSTs are
  not redirected.
- The size the source states is the most that is read; API answers at
  most 4 MiB.

## Updating itself

`mgu-updater.service`'s main process is `mgu-updater` (sh), a supervisor
that runs `node current/updater.js daemon` and never exits, so recmgr never
sees the service stop (README of the deploy tool: a stopped service that
recmgr does not list reboots the unit). The shell keeps the script it runs
open, so the supervisor runs a copy of itself, `/run/mgu-updater/supervisor`:
a version folder an update or a reinstall prunes while it runs leaves no
open file under `/var/opt`, whose read-only remount at shutdown such a file
would fail (NSM's shutdown then goes on through `var-opt-ro-force-final`,
which kills the processes holding `/var/opt`).

1. The daemon writes `/var/opt/mgu-updater/trial` with the version it is
   running (`current`'s target), then installs the new version through the
   deploy tool (`restart: []` in `component.json`: the deploy tool restarts
   nothing). `current` now points at the new version.
2. It exits with 75; the supervisor starts `current`.
3. The new version serves its socket and, for up to 120 s, tries to read
   its network sources through the uplink (a start at boot comes before
   the uplink; a network error can pass). A source read, or an HTTP answer
   from a source's server, shows its network path works. When that works
   and the deploy tool answers its status, it deletes `trial`: committed.
   Otherwise it exits, leaving the reason. Installs asked for meanwhile
   wait.
4. If it exits before committing, or has not committed within 360 s, the supervisor
   switches `current` back to the version `trial` names (rename, like the
   deploy tool; the deploy tool keeps that version on disk), removes the
   version that failed, and starts the one it went back to.
   The Store shows the update as still available, which version was not
   kept and why ("0.5.0 not kept: it cannot fetch the catalog …").

A version installed from outside (the deploy tool run from the Mac) is
taken up the same way: the running daemon sees `current` move, writes
`trial` with its own version, and hands over. That version commits once
the deploy tool answers, without the sources: the car may have no internet
while it is set up.

## Tools the updater runs on

Two more tools carry the updater's own work: the deploy tool, which does
every install, and the uplink, which carries every download. A new version
of either is checked right after its install, and the version installed
before is put back when the check fails. The Store row then shows Failed,
retry, with "<new> does not run; <old> kept" or "<new> gives no internet;
<old> kept" in the status line; while the check runs the row shows
Checking.

| Tool (`updater.conf`) | Check | On failure |
|---|---|---|
| `deploy_tool` (`mgu-deploy`) | the new version (`mgu-deploy.sh`, which runs `current/`) answers `status --json` with JSON within 60 s | the updater switches `/var/opt/mgu-deploy/current` back by rename: a deploy tool that does not run cannot undo itself |
| `uplink_tool` (`mgu-uplink`) | within `bootstrap_check_s` (90 s) the uplink's lease is back and the first network source answers through it | `mgu-deploy.sh rollback mgu-uplink`, then the internet is waited for again; the previous version cannot be downloaded without it. A rollback the deploy tool reports as failed shows as such |

An uplink update the deploy tool leaves for the next boot (`pending_reboot`)
is not checked: the running version was not restarted. Both tools keep
their previous version on disk (the deploy tool keeps the version `current`
pointed to before), so the way back never needs a download.

## Restarting the head unit

The Store's Restart head unit sends `{"op":"reboot"}`, and the daemon runs
the `reboot` command: `/usr/bin/nsm_control --requestRestart 7 --normal`,
which asks the Node State Manager (NSM) for a restart
(`LifecycleControl.RequestNodeRestart`) with reason 7 (Application) and a
normal shutdown, the request the HMI's own restart sends. NSM's shutdown
clients then get the normal shutdown event, as at every ignition off;
OAP apps get 25 s for it (1.5 s in a fast shutdown), and persistence logs
the user out. `systemctl reboot` is not used: it is systemd's stock reboot,
which no BMW unit hooks, and it stops the services by their `KillSignal`
(SIGABRT for many of BMW's, the NSM daemon's included).

- Refused (`an install is running`) while an install runs or waits, so a
  restart never cuts one short. Once the restart is under way, installs
  are refused (`the head unit is restarting`), and a second reboot request
  runs nothing more.
- The state's `rebooting` is true from the request until the unit goes
  down. A command that cannot run or exits non-zero ends it, with the
  reason in `rebootError`. `nsm_control` exits 0 whether or not NSM took
  the request; when it cannot deliver it, it prints why
  (`[Error. ProxyLifecycleControl not available!]`), which ends the
  restart with that reason. Any other restart that does not happen shows
  as a unit still up 3 minutes later: `rebootError` is `the head unit did
  not restart`. `rebootError` stays until the next catalog check.

## Configuration

`updater.conf` (in the version folder) holds the defaults;
`/var/opt/mgu-updater/updater.local.conf` overrides any key and survives
updates. Keys: `sources`, `credentials_dir`, `builtin_repo`,
`github_client_id`, `github_api`, `github_web`, `ca_file`,
`check_interval_s`, `first_check_s`, `mounts`, `usb_roots`, `usb_poll_s`,
`repo_max_bytes`, `build_uid`, `build_gid`, `build_timeout_s`,
`build_max_bytes`, `fetch_uid`, `fetch_gid`, `lease`, `deploy`,
`deploy_tool`, `uplink_tool`, `bootstrap_check_s`, `privacy_tool`,
`state_dir`, `tool_root`, `oap_root`, `mainapp_uid`, `store_app`,
`reboot`, `log_file`, `socket`, `socket_group`, `web_uid`, `web_gid`,
`web_port`, `web_iface`, `web_secret`. Relative paths are relative to
`updater.conf`.

**Log.** Every line the daemon logs goes to the journal and, with its UTC
time, to `log_file` (`/tmp/mgu-updater.log`, 0644; past 128 KiB it moves to
`mgu-updater.log.1`). Each source read logs its layout, commit and
components (`source <id> (<channel>): …`); each install its phases
(`<id>@<v>: download from <source>`, `verify`, `install`), a build's
output as `build <id>: …` lines, the deploy tool's output as `deploy: …`
lines, its result, and `<id>@<v>: done` when the Store stops showing it as
installing. A new version of the updater itself then logs `running <v>:
update committed` or `<v> not kept: …`. raluca-car's diag `file` op reads
it over the tailnet, with no laptop at the car
(`native/raluca-car/PROTOCOL.md` §5; on the live-codex host, `curl -H
'X-Live-Codex: car' -d
'{"op":"file","path":"/tmp/mgu-updater.log","max":196608}'
http://127.0.0.1:4317/api/car/diag`). The file is written only while it
is root's own regular file; a link, a FIFO or anyone else's file at that
name is removed first, and a folder there leaves only the journal.

## The socket

`/dev/shm/mgu-updater/updater.sock`, `0660 root:tm_oap_app` (every OAP app
has that group), in a folder only root can write to: at start, one that
someone else made or can write to is renamed aside
(`/dev/shm/mgu-updater.untrusted-<time>`) and the folder made afresh. One
JSON object per line. The daemon sends the full state on connect, after
each request, and whenever it changes (at most every 250 ms):

```json
{ "type": "state", "updater": { "version": "0.2.0" }, "online": true, "privacy": "patched",
  "catalog": { "commit": "…", "checkedAt": 1792620000000, "checking": false, "error": null },
  "sources": [ { "id": "mgu-apps", "type": "github", "label": "robertnisipeanu/mgu-apps",
    "builtin": false, "usb": false, "channel": "releases", "status": "ok", "error": null,
    "auth": { "kind": "github", "login": "robertnisipeanu" }, "checkedAt": 1792620000000, "components": 7 } ],
  "login": { "source": "mgu-apps", "url": "https://github.com/login/device", "code": "ABCD-1234",
    "expiresAt": 1792620900000, "status": "pending", "error": null },
  "web": { "enabled": false, "urls": [], "error": null },
  "busy": { "id": "doom", "phase": "download", "progress": 524288, "total": 2080457 },
  "rebooting": false, "rebootError": null,
  "components": [ { "id": "doom", "kind": "app", "title": "DOOM", "version": "1.0.1",
    "installed": "1.0.0", "size": 2080457, "status": "update", "source": "mgu-apps",
    "build": null, "optional": false, "uninstallable": true, "revision": null,
    "pendingReboot": false, "queued": false, "error": null } ] }
```

- `components`: each id once (Sources, "Ids"). `status` is `installed`,
  `update`, `available` or `newer` (a local build ahead of its source);
  `build` is `"unit"` for what is built on the unit; `revision` the short
  commit a branch would install; `size` null where the source states none.
- `busy.phase`: `download`, `build` (a source package or a repo's build
  script), `verify`, `install`, `uninstall`, or `check` (a tool the
  updater runs on, "Tools the updater runs on").
- `sources`: stored ones in order, then USB media; `channel` is a GitHub
  source's channel in use; `auth` is null without a credential; `error`
  of an `ok` source names the components it left out.
- `login`: the GitHub sign-in in progress (`pending`, `done`, `error`,
  `expired`), or null.
- `web`: the phone page's state (`js/web.js`), present when the updater has it.
- `catalog`: the sources as one line, for the Store 0.3: `checking` while
  any is read, `error` the first source that failed (`<label>: <error>`).
- `privacy` is the app-privacy patch's state from `patch_mainapp.js check
  --json` (`native/app-privacy`), read at start, with every check and after
  each install: `patched` (in effect), `restart-needed` (patched, MainApp
  not yet restarted onto it), `unpatched`, `mismatch`, `unknown` (the tool
  gave no answer), or `null` without the tool. `rebooting` and
  `rebootError`: "Restarting the head unit".

Requests: `{"op":"status"}`, `{"op":"check"}`, `{"op":"install","id"}`
(with its missing requirements first), `{"op":"reboot"}`, from any app.
**Privileged** ones carry `"secret"`:

| Request | Does |
|---|---|
| `{"op":"uninstall","id"}` | removes an `uninstallable` component |
| `{"op":"source-add","type":"github","repo":"o/r","channel"?}`, `{"op":"source-add","type":"https","url"}` | adds a source (id: the repo's name, else `s-<hex>`) and reads it |
| `{"op":"source-remove","id"}` | removes a source (not the built-in one), its credential and its record in `origins.json` |
| `{"op":"token-set","source","token"}`, `{"op":"token-clear","source"}` | sets or clears a source's credential, and reads it again |
| `{"op":"login-start","source"}`, `{"op":"login-cancel"}` | GitHub sign-in for a github source |
| `{"op":"web","enable":true\|false}` | the phone page on or off, kept across restarts (`state/web.json`) |
| `{"op":"logs","unit","lines"}` | `{"type":"logs","unit","text"}`: a journal for the phone page |

A refused request gets `{"type":"error","op",…,"error"}`; one without the
right secret, `"error":"forbidden"`. The direct answer to a request
(state, error or logs) carries the request's `"rid"`.

**The secret.** At each start the daemon makes 32 random bytes (hex) and
writes them, as the reader's own 0400 file, to the Store's data folder
(`<oap_root>/oap_<uid>/data/updater-secret`, the uid from MainApp's
registry entry for `store_app`; written by a child running as that uid, so
a link there leads nowhere it could not write itself; written again when
the Store's uid changes) and to `web_secret` for the phone page (`web_uid`).
Every OAP app can reach the socket; only these two can change sources or
credentials, sign in, remove components or read journals. While the
phone page is on, `web-url` beside `updater-secret` holds its hotspot
address with the access token (one line, the Store's own 0400 file) for the
Store's QR code; it is removed when the page goes off, rewritten when the
address changes, and a state goes out after each change, so the Store reads
the file when it gets one.

`js/client.js` is the client (the Store bundles it; the privileged
requests take the secret as `opts.secret` or `setSecret()`).

## Command line

```sh
node /var/opt/mgu-updater/current/updater.js status [--json]
node /var/opt/mgu-updater/current/updater.js check
node /var/opt/mgu-updater/current/updater.js install <id>
```

## Files

```
bin/mgu-updater          supervisor, the service's main process
js/updater.js            daemon and command line
js/sources.js            sources.json, credentials, USB media, reading each layout
js/catalog.js            catalog parsing (schema 1 and 2), installed-vs-source plan
js/tar.js                .tar.gz in memory: reading a repo tarball, packing a component
js/build.js              a repo's build script, as the build uid
js/login.js              GitHub device-flow sign-in
js/migrate.js            the first sources.json of a unit the mgu-apps updater set up
js/fetch.js              one download, as the fetch uid
js/client.js             socket client (Store app, command line)
js/web.js                the phone page
updater.conf             defaults
systemd/mgu-updater.service
component.json           the tool component (deploy tool format)
test/                    offline tests (test/run.sh: Node 8.16.2 in Docker)
```

## Tests

`sh test/run.sh` runs `test/test_updater.js` (and `test/test_web.js`) on
the unit's Node 8.16.2, as root, against a local HTTPS server with its own
CA and a DNS server that also answers for `github.com`,
`api.github.com` and `codeload.github.com` (a fake GitHub: repos,
releases, branches, tags, contents, tarballs, the device flow), with
`test/fake_deploy.js` in the deploy tool's place:

- catalogs (schema 1 and 2, a signature ignored), tar reading and packing;
- downloads through the lease's DNS as uid 12990, a redirect that must not
  carry the token, size limits;
- sources, in an updater in the test process: several sources and an id
  two of them list, a private repo without a token, with a wrong one,
  with one that works, signed in by the device flow (pending, slow_down,
  denied, renewed by its refresh token), no token anywhere but
  `api.github.com`, the releases layout, a branch (a new commit of the same
  version is an update) and tags, repo-tree apps and tools, build scripts
  that succeed, fail, run too long or write outside their folder,
  requirements installed first, uninstall and its refusals, USB media
  (a stick's root and `mgu-repo/<name>`, links not followed, nothing
  written), the privileged requests and their secret files, `web-url`
  (with a stand-in page), `rid`, the first start of a unit the mgu-apps
  updater set up, and the Store 0.3's texts from the state;
- the daemon under its supervisor: an app install and update, the updater
  updating itself, rollback from a new version that crashes and from one
  that never comes up, a download that does not match its source, a
  failed deploy, offline, the tools the updater runs on, and the reboot
  request (refused during an install, run once, a failing command and a
  unit that stays up reported) with a stand-in command.
