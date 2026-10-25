# mgu-updater

The head unit's updater: a root daemon that reads the published catalog
(`release/README.md`), compares it with what is installed, and downloads
and installs new versions of our OAP apps and root tools, itself included.
The Store app (`apps/robertn_store`) is its screen. On the Store's request
it also restarts the head unit.

```
 catalog (GitHub Releases / static host / file)
        │ HTTPS, as uid 12990 through the apps-only uplink (native/mgu-uplink)
        ▼
 fetch.js ──► state/dl-<random>/<id>@<v>.tgz       (a folder root made for this download, the fetch uid's)
        │
 updater.js (root): read it (no links, regular file, bounded), check size + sha256 against the catalog,
        │            write the checked bytes to state/verified/ (root only)
        │
        ▼
 /var/opt/mgu-deploy/mgu-deploy.sh install --artifact <file> --yes   (runs current/)
        ├─ app:  MainApp's own install (preinstalled package, listed by the provisioning fallback; in the running MainApp, else a MainApp bounce)
        └─ tool: /var/opt/<id>/versions/<v>/ + `current` switched by rename, units, recmgr
        ▲
 Store app ── /dev/shm/mgu-updater/updater.sock (state stream; check / install / reboot requests)
```

## Installers

Two installers put our tools and apps on the car, and both run one install
core, the deploy tool's on-unit `mgu-deploy.js` (`deploy/README.md`):

- **Local**: `deploy/hu` on the Mac, over SSH or from the USB kit. It
  bootstraps the car and installs the deploy tool, the uplink and this
  updater.
- **Cloud**: this updater and the Store, from the signed catalog on the
  private repository's releases (`release/README.md`). It hands each
  verified artifact to `/var/opt/mgu-deploy/mgu-deploy.sh install
  --artifact`.

Both take the same artifacts (`release.js` packs tools with `deploy/hu
artifact`), the same `component.json`, the same `versions/<v>` + `current`
layout and the same `"mguLocalOnly": true` marking, so a component
installed by one is updated or removed by the other. The emulator's image
provisioning installs apps for testing only.

## What it does

- **Catalog.** At start (after `first_check_s`), every `check_interval_s`,
  when the uplink comes up, and on request (Store, `updater.js check`). A
  catalog that does not parse, lists a malformed entry, or (with
  `public_key`) is not signed by that key is not used; the last good one
  stays in `state/catalog.json`.
- **Installed versions.** Apps from MainApp's registry
  (`/var/opt/public/oap/oap_12201/data/apps/<id>.json` names the app's uid,
  `oap_<uid>/source/package.json` its version). Tools from
  `/var/opt/<id>/current/component.json`. Only components the catalog lists
  are looked at.
- **Installing.** On request only, one at a time (later requests queue).
  Nothing is installed on its own: an app install restarts every running
  OAP app, which must not happen unasked. The artifact is downloaded,
  copied root-only and checked against the catalog's size and sha256, then
  handed to the deploy tool's `install --artifact`, the one install path
  every app and tool takes on the unit. Exit 0 is done (a tool whose
  service cannot restart yet reports "takes effect after reboot", shown as
  *Restart pending*), 1 failed and rolled back, 2 refused by preflight.

## Downloads: apps-only internet

The unit has no default route to the internet; mgu-uplink lets only listed
uids out. The updater does every download in a child process (`fetch.js`)
running as `fetch_uid` (12990), which `native/mgu-uplink/mgu-uplink.conf`
lists under `uids`. That uid has no account and can write only the folder root makes for
each download: the HTTPS and HTTP handling runs without privileges, and the
root daemon reads only the downloaded file, through a descriptor that
follows no link and only if it is a regular file within the size the
catalog states. Root removes download folders by running `rm -rf` as the
fetch uid, so nothing planted in them leads root anywhere, and the
fetcher can change nothing it installs.

- Names resolve through the DNS servers of the uplink's lease
  (`/run/mgu-uplink/lease.json`); without a lease the unit is offline and
  the Store says so.
- HTTPS only, Node's bundled roots (or `ca_file`). Redirects are followed,
  but request headers go to the first host only: the GitHub token reaches
  `api.github.com` and never the asset storage it redirects to.
- The size the catalog states is the most that is read.

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
3. The new version serves its socket and, for up to 120 s, tries to fetch
   the catalog through the uplink (a start at boot comes before the uplink;
   a network error can pass). A verified catalog, or an HTTP answer from
   the server, shows its network path works. When that works and the
   deploy tool answers its status, it deletes `trial`: committed. Otherwise
   it exits, leaving the reason. Installs asked for meanwhile wait.
4. If it exits before committing, or has not committed within 360 s, the supervisor
   switches `current` back to the version `trial` names (rename, like the
   deploy tool; the deploy tool keeps that version on disk), removes the
   version that failed, and starts the one it went back to.
   The Store shows the update as still available, which version was not
   kept and why ("0.5.0 not kept: it cannot fetch the catalog …").

A version installed from outside (the deploy tool run from the Mac) is
taken up the same way: the running daemon sees `current` move, writes
`trial` with its own version, and hands over. That version commits once
the deploy tool answers, without the catalog: the car may have no internet
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
| `uplink_tool` (`mgu-uplink`) | within `bootstrap_check_s` (90 s) the uplink's lease is back and the catalog can be fetched through it | `mgu-deploy.sh rollback mgu-uplink`, then the internet is waited for again; the previous version cannot be downloaded without it. A rollback the deploy tool reports as failed shows as such |

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

## Phone page

A page the car serves to a phone on its hotspot (`js/web.js`): the
sources with their channel and status, the components with installed and
catalog versions (and the short commit of a branch build), what is being
installed, errors, and the logs. On it the owner adds a GitHub source
(owner/repo with Releases, a branch or Tags) or a catalog URL, removes
one, pastes or clears a source's token, and starts a GitHub sign-in (the
code and the link show on the page). Off by default; the Store turns it
on and off (privileged `web` op) and shows its QR code.

- **Server.** A child of the daemon, `node web.js serve`, as `web_uid`
  12991 and `web_gid` 12202 (`tm_oap_app`, the socket's group) with no
  other groups, on `web_port` 8470 at `127.0.0.1` and at `web_iface`'s
  (`wlan_bridge`, the hotspot: 172.16.222.97) IPv4 address while it has
  one, looked up every 5 s. It exits when the daemon does. It serves the
  page and three API paths, nothing from disk but the updater log; a
  request body is at most 16 KiB.
- **Access.** Each enable makes a new 128-bit token; the QR URL is
  `http://<hotspot address>:8470/#t=<token>`. The fragment never reaches
  the server: the page keeps the token in sessionStorage, drops it from the
  address bar and sends `Authorization: Bearer` (no cookies, so no
  cross-site request carries it). The server gets it on stdin and compares
  digests in constant time; without it the page says *Scan the code in the
  Store*. 10 wrong tokens from one address in a minute lock that address
  out for the rest of the minute. The state stream's `web.urls` carry no
  token (every OAP app reads that stream and can reach 127.0.0.1:8470).
- **Firewall.** The unit's `ip filter` input chain (firewalldz) drops what
  it does not accept. While the page is on, one rule at its top accepts
  it: `iifname "wlan_bridge" tcp dport 8470 accept comment
  "mgu-updater-web"`, checked every 30 s and put back after a ruleset load.
  Every start and every on/off first removes rules with that comment.
  Replies leave through the output chain's established accept.
- **Requests.** The server talks to the socket with the web secret
  (`web_secret`, `/run/mgu-updater/web-secret`), and passes on only
  `source-add`, `source-remove`, `token-set`, `token-clear`, `login-start`
  and `login-cancel`, each with only its own fields checked for shape.
  Logs: `log_file` (and `.1`) read directly, the last 64 KiB, only while it
  is the daemon's own regular file; the journals of `mgu-updater`,
  `mgu-uplink` and `mgu-app-fallback` (the deploy tool's unit; its own
  runs log as `deploy:` lines in `log_file`) through the privileged `logs`
  op, since the journal is not readable to the web uid:
  `{"op":"logs","unit","lines","secret"}` → `{"type":"logs","unit","text"}`
  (`journalctl -u <unit> -n <lines> --no-pager`, those three units only,
  1–1000 lines). Requests carry `rid`; the daemon's direct reply to one
  (state, error or logs) carries it back.

`test/test_web.js` (`docker run --rm -v "$PWD:/w:ro" -w /w
node:8.16.2-stretch node test/test_web.js`) runs the server as the web
uid against a stand-in socket, `nft` and `journalctl`, with the
container's address as the hotspot's.

## Configuration

`updater.conf` (in the version folder) holds the defaults;
`/var/opt/mgu-updater/updater.local.conf` overrides any key and survives
updates. Keys: `catalog` (`github:<owner>/<repo>`,
`https://…/catalog.json` or `file:///…/catalog.json`), `token_file`,
`public_key`, `ca_file`, `check_interval_s`, `first_check_s`, `fetch_uid`,
`fetch_gid`, `lease`, `deploy`, `deploy_tool`, `uplink_tool`,
`bootstrap_check_s`, `privacy_tool`, `state_dir`, `tool_root`, `oap_root`,
`mainapp_uid`, `reboot`, `socket`, `socket_group`, `log_file`.

**Log.** Every line the daemon logs goes to the journal and, with its UTC
time, to `log_file` (`/tmp/mgu-updater.log`, 0644; past 128 KiB it moves to
`mgu-updater.log.1`). Each install logs its phases (`<id>@<v>: download`,
`verify`, `install`), the deploy tool's output as `deploy: …` lines, its
result, and `<id>@<v>: done` when the Store stops showing it as installing.
A new version of the updater itself then logs `running <v>: update
committed` or `<v> not kept: …`. raluca-car's diag `file` op reads it over the tailnet, with no
laptop at the car (`native/raluca-car/PROTOCOL.md` §5; on the live-codex
host, `curl -H 'X-Live-Codex: car' -d '{"op":"file","path":"/tmp/mgu-updater.log","max":196608}' http://127.0.0.1:4317/api/car/diag`).
The file is written only while it is root's own regular file; a link, a
FIFO or anyone else's file at that name is removed first, and a folder
there leaves only the journal.

The catalog and the artifacts are GitHub Releases of the private mgu-apps
repository (published by its Release workflow, `release/README.md`), read
with a fine-grained token: resource owner `robertnisipeanu`, repository
access *Only select repositories* → `mgu-apps`, repository permissions
*Contents: Read-only* (Metadata: Read-only comes with it), nothing else. It
is in no artifact and no file of the repository: the local installer
writes it to `/var/opt/mgu-updater/github-token`, root-only, when it sets
up the car (`deploy/hu updater-token --updater-token-file <path>`,
`deploy/README.md`).

The token goes only to `api.github.com`. Renew it before it expires: an
expired token shows in the Store as a failed check.

`public_key` names the key catalogs must be signed with
(`catalog-key.pub.pem`, shipped next to `updater.conf`; release/README.md,
"Signing"). Relative paths in either file are relative to `updater.conf`.
A test catalog built without the signing key needs `public_key =` in the
emulator's `updater.local.conf`.

## The socket

`/dev/shm/mgu-updater/updater.sock`, `0660 root:tm_oap_app` (every OAP app
has that group), in a folder only root can write to: at start, one that
someone else made or can write to is renamed aside
(`/dev/shm/mgu-updater.untrusted-<time>`) and the folder made afresh. One JSON object per line. Requests: `{"op":"status"}`,
`{"op":"check"}`, `{"op":"install","id":"<id>"}`, `{"op":"reboot"}`. The daemon sends the full
state on connect, after each request, and whenever it changes (at most
every 250 ms):

```json
{ "type": "state", "updater": { "version": "0.1.0" }, "online": true, "privacy": "patched",
  "catalog": { "commit": "…", "checkedAt": 1792620000000, "checking": false, "error": null },
  "busy": { "id": "doom", "phase": "download", "progress": 524288, "total": 2080457 },
  "rebooting": false, "rebootError": null,
  "components": [ { "id": "doom", "kind": "app", "title": "DOOM", "version": "1.0.1",
    "installed": "1.0.0", "size": 2080457, "status": "update",
    "pendingReboot": false, "queued": false, "error": null } ] }
```

`status` is `installed`, `update`, `available` or `newer` (a local build
ahead of the catalog); `busy.phase` is `download`, `verify`, `install` or
`check` (a tool the updater runs on, "Tools the updater runs on").
`privacy` is the app-privacy patch's state from `patch_mainapp.js check
--json` (`native/app-privacy`), read at start, with every catalog check and
after each install: `patched` (in effect), `restart-needed` (patched, MainApp
not yet restarted onto it), `unpatched`, `mismatch`, `unknown` (the tool
gave no answer), or `null` without the tool. `rebooting` and
`rebootError`: "Restarting the head unit".
A refused request gets `{"type":"error","op":…,"error":…}`. Any app can
ask for an install, or a restart; what it can ask to install is limited
to catalog versions that pass the checks above. `js/client.js` is the client (the Store
bundles it).

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
js/catalog.js            catalog parsing, signature, installed-vs-catalog plan
js/fetch.js              one download, as the fetch uid
js/client.js             socket client (Store app, command line)
updater.conf             defaults
systemd/mgu-updater.service
component.json           the tool component (deploy tool format)
test/                    offline tests (test/run.sh: Node 8.16.2 in Docker)
```

## Tests

`sh test/run.sh` runs `test/test_updater.js` on the unit's Node 8.16.2, as
root, against a local HTTPS server with its own CA and a DNS server, with
`test/fake_deploy.js` in the deploy tool's place: catalog checks and
signatures, downloads through the lease's DNS as uid 12990, a redirect
that must not carry the token, size limits, an app install and update, the
updater updating itself, rollback from a new version that crashes and from
one that never comes up, a download that does not match the catalog, a
failed deploy, offline, and the reboot request (refused during an install,
run once, a failing command and a unit that stays up reported) with a
stand-in command.
