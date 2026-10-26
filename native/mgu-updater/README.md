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
        │            pack a repo-tree component, or run the repo's build script as uid 12995 (build.js)
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

- **Local**: over SSH, `deploy/mgu-install.js` from the published release
  (`deploy/hu` from a checkout, for development). It bootstraps the car
  and installs the deploy tool, the uplink and this updater.
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
  { "id": "idrive7-apps", "type": "github", "repo": "someone/idrive7-apps", "channel": "branch:main" },
  { "id": "s-3f9a",    "type": "https",  "url": "https://example.org/repo/catalog.json" }
] }
```

- `github`: a repo, read through the REST API (`github_api`). `https`: a
  `catalog.json` URL, or an App Manager index (below). `file`: a local
  folder (tests, the emulator).
- `builtin`: the Store's own source (`builtin_repo`, id `mgu-store`),
  always there and not removable.
- Nothing is signed: trust is HTTPS (and a token, "Tokens") to a source
  the owner added; every download is checked against the size and
  sha256 its source lists, or, where the source names none (release
  assets, repo trees), its sha256 is taken on download. A `signature` in a
  catalog is ignored.
- A source that cannot be read keeps the components it listed last
  (`state/sources/<id>.json`).

**Layouts.** A source reads as the first of these it has:

| Layout | Where | Components |
|---|---|---|
| catalog | a `catalog` release's `catalog.json` asset (`release/README.md`), the https URL, `catalog.json` in a folder | schema 1 or 2 entries; artifact URLs absolute or relative to the catalog |
| releases | a GitHub repo's releases (newest first, drafts and prereleases left out): assets named `<id>@<x.y.z>.tgz` or `.mgu` | each id's newest version, the `.tgz` over the `.mgu` of one version; titles from an optional `mgu-store.json` asset (`{"apps":{"<id>":{"title","description"}}}`), else the installed app's en_GB entry-point text, else the id; always apps, each `uninstallable` |
| repo tree | `mgu-repo.json` at a repo's or folder's root, at one commit | see below |
| index | an https URL answering IterioDev's App Manager index: version 2, `{"version": 2, "packages": [{"url", "sha256", "size", "id", "kind", "version", "title", "author", "description", "icon", "iconSha256", …}]}`, or version 1, `{"packages": [{"url", "sha256"}]}` | version 2: each entry as it stands, no package downloaded (50 at most, 32 MiB each); `kind` `app`, or `renderer` / `tether`: a tool providing that kind, as a stick's service package (below); an app without `mguHmi` is for iDrive 8, the App Manager's head unit; an entry of another kind or without an https `url`, a sha256 and a size is left out, named in the source's `error`. An install downloads the package, checks its sha256 and that its `package.json` is the id, version and service its entry names, and keeps it in `state/index/<source id>/<sha256>.tgz` (root, 0600) while the index lists it. Version 1: each package (https, absolute or relative to the index) downloaded once, checked against its sha256, kept the same way, then read like a stick's `oap/` package; a package that is missing or does not match is left out, named in the source's `error` |

**Icons.** A catalog entry's `icon` (absolute https, or relative to the
catalog; in a GitHub `catalog` release one of its assets), the asset an
`mgu-store.json` entry's `icon` names, and an index version 2 entry's
`icon` (absolute or relative to the index), each with an optional
`iconSha256`, are fetched in the background after the source is read
(no check waits for them): a PNG of at most 128 KiB, matching its sha256
when one is given, kept in `state/icons/<sha256>.png` (named by the
source's sha256, else by source, id, version and URL; 0644, the folder
0755, for the Store to read) and fetched again only when no kept file has
that name. A component's `icon` in the state is that file, null without
one; an icon that cannot be fetched or is not such a PNG is logged, left
out and asked for again a day later. Kept icons no component names go
after each check. A repo tree's components have none. A package read for
what it is (a stick's `oap/`, a version 1 index) gives its own
`icon.png` (beside `package.json`, the same limits), `author` (a string
or `author.name`) and `store.description` over `description`.

**Channels** (a `github` source's `channel`): `releases` (the catalog
release, else the releases layout), `branch:<name>` (`mgu-repo.json` at
the branch's head commit; each commit is a revision), `branch` (the same,
on the repo's default branch), `tags`
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

- An app with `mgu-app.json` in its folder (no `build`, or `"build":
  "unit"`) is a **source package**: the folder packed as it is
  (`mgu-app.json` at the root), built and installed by the deploy tool
  (phase `build`).
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
`build_uid` 12995 (no account, in none of the uplink's lists: no network;
no other service may run as it),
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
folder is emptied as the build uid afterwards.

**Ids.** Component ids are global on the unit. An id several sources list
is shown once, at the highest version any of them lists, so a newer
version on a USB stick is an update of a component installed from GitHub.
Of equal versions it comes from the source that installed it
(`state/origins.json`), else a USB stick, else the first source in
`sources.json` order; the source an install comes from becomes the
component's origin. Without internet, a network source's last listing
counts only for ids no other source lists. `requires` (`{"<id>":
"<min version>"}`) installs a missing or older requirement first, from the
same source if it has one at least that version, else from any (a
newer updater installs alone: it restarts into its new version, which ends
the queue, and the component is asked for again after);
`optional` components are listed but never counted as updates unless
installed; `uninstallable` ones can be removed (Store, phone page), through
`mgu-deploy.sh uninstall <id> --yes`, unless something installed requires
them. The updater and the deploy tool are never removed. An install asked
for while a removal of the same component waits or runs (or the other way
round) is refused.

**Tokens.** GitHub tokens are the updater's own, not a source's: one
token that reads all the owner's repos serves every source, and a repo
added later needs no new token when a stored one reaches it.
`credentials_dir` (`/var/opt/mgu-updater/credentials`, root, 0700) holds
each token's text in `token-<id>` (0600; the id is 8 hex digits) and in
`tokens.json` (0600) what is known of each: `[{ id, kind: "github", label,
login, scopes, addedAt, expiresAt, checkedAt, rejected }]`, and for a
sign-in's token its refresh token. A `token-<id>` file is a token whether
or not `tokens.json` names it yet; the deploy tool writes both too
(`mgu-deploy.sh updater-token`, deploy/README.md), and the updater reads
the folder again every `usb_poll_s` and on each check.

- A GitHub source is read with the token that read it last, else each
  stored token in turn (those GitHub rejects last) until one reaches the
  repo; the one that does is kept for it (in `state/sources/<id>.json`, a
  cache) and its downloads use it. A repo whose own answer said it is
  public is read without a token first; any other repo without one last.
  A source no token reaches (the repo answers 401 or 404 to each) is
  `auth-needed`. When the tokens change, the sources that need one, or
  lost theirs, are read again.
- `token-add` asks `api.github.com/user` whose the token is: `login`, and
  a classic token's `X-OAuth-Scopes` as `scopes` (a fine-grained or GitHub
  App token has none: null). One GitHub rejects (401) is refused; without
  an answer it is stored and asked about later. The same text again is
  not stored twice. Each check asks again for every token (`login`,
  `scopes`, `rejected`), and a new token file at once.
- A token is in no file the Store or the phone page can read and never in
  the state stream. It goes only to `api.github.com` (never to
  `github.com`, `codeload.github.com` or the asset storage a download
  redirects to). An https source is read without a token; one that answers
  401 or 403 is an `error`.
- The per-source files of mgu-updater 0.2.x (`credentials/<source id>`, and
  `<id>.json`: its account, expiry and refresh token) become tokens at
  start, one per distinct text, each source keeping its token; an https
  source's is not a GitHub token and is dropped. The files are removed
  once this version runs committed ("Updating itself"), so a version the
  supervisor goes back to still has them.

**Signing in to GitHub.** `login-start` runs GitHub's device flow for a
GitHub App (`github_client_id`; while it is empty the state's `signin` is
false, clients offer no sign-in, `login-start` is refused, and a pasted token
still works): the state's `login`
shows the address and the code, which the owner enters on a phone; the
updater polls at the interval GitHub gives (5 s more on `slow_down`) until
the code expires, and stores the token it gets as a token labelled with
the account from `/user`, in place of an earlier sign-in's token of that
account. An expiring token is renewed from its refresh token before a
source is read. The App: *Enable Device Flow* on,
repository permission *Contents: Read-only* (Metadata comes with it),
installable by any account, installed by each owner on the repos their car
reads; the shipped `github_client_id` is the client id of
https://github.com/apps/mgu-store (public; no client secret or private key). Requests to `github.com` carry the client id with the
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
any name, flat or with npm's `package/` prefix, is a component with the id
and version of its own `package.json` and the title of its en_GB
entry-point text, else its `productName`, else its name; the newest of an
id wins, and its sha256 is taken as it is listed. A package whose
`package.json` has `mguService` `renderer` or `tether` (IterioDev's root
services) is a tool: the deploy tool installs it as one (deploy/README.md,
"Service packages"), so it provides its kind and needs `mgu-deploy` 0.3.0
or newer; another `mguService` is left out. An app without `mguHmi` is
for the HMIs its rhmiData has a UI for. Each can be removed
(`uninstallable`). It installs as `<id>@<version>.tgz` (or `.mgu`).
`mgu-install.js usb-repo` writes a stick from published repositories,
catalog URLs, checkouts and package files, one `mgu-repo/<name>/` folder
each (deploy/README.md, "mgu-install"), so a car without internet installs
and updates from it alone. Sticks
are only read: no link is followed (a folder or file reached through one is
not there), only regular files, every size bounded.

**Head units.** Each entry may say which head units it is for, `mguHmi`
(`["ID7"]`, `["ID8"]` or both; catalog, `mgu-repo.json` or the component's
own manifest, docs/PUBLISHING.md). The unit is the one the deploy tool's
`status --json` names (`unit`). A component's `compat` is `yes`, `no` or
`unknown` (it says nothing, or the unit is not known); one that is `no` is
listed, and its install is refused with the reason (`<title> is for
iDrive 8; this head unit is iDrive 7`), as a requirement too.

**Capabilities.** A tool may provide a capability only one installed tool
holds (`mguProvides`; a renderer package provides `renderer`, a tether
package `tether`). The installed provider of each is in `providers`, from
the deploy tool's `status --json`; a component providing what another
installed tool provides names it in `replaces`, and its install is refused
unless it carries `"replace": true`, which is privileged: the deploy tool
then installs it with `--replace`, which removes the other one first.

**First start.** The installers seed `sources.json` (the deploy tool's
`updater-sources`, from `deploy/sources.json`) and never replace
one that is there. Until it exists the updater reads the built-in source
alone and writes nothing; the first change to the sources writes it.

## What it does

- **Reading the sources.** At start (after `first_check_s`), every
  `check_interval_s`, when the uplink comes up, on a stick, and on request
  (Store, `updater.js check`); a source added is read at once, and a token
  added or removed reads again the sources that need one. Each source's state: `ok`, `checking`, `error`, `auth-needed` or
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
while it is set up. So does a version installed from a USB stick or a
folder.

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
| `uplink_tool` (`mgu-uplink`) | within `bootstrap_check_s` (90 s) the uplink's lease is back and the first network source answers through it; not checked when there was no internet before the install | `mgu-deploy.sh rollback mgu-uplink`, then the internet is waited for again; the previous version cannot be downloaded without it. A rollback the deploy tool reports as failed shows as such |

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
(owner/repo with Releases, a branch, the default branch when none is named, or Tags) or a catalog URL and
removes one; each source shows the account that reads it, or *Sign-in
needed*. Its Tokens list each token (label, account, the sources it reads)
with Remove; a token is added by pasting it, or by Sign in with GitHub (shown
while the state's `signin` is true; the code and the link show on the page). A component not for this head unit
says so; one providing what another installed tool provides (a second
renderer) has Replace, which asks *Replace <installed> with <it>?* and
installs it with `replace`. Off by default; the Store turns it
on and off (privileged `web` op) and shows its QR code.

- **Server.** A child of the daemon, `node web.js serve`, as `web_uid`
  12996 and `web_gid` 12202 (`tm_oap_app`, the socket's group) with no
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
  token: every OAP app reads that stream and can reach 127.0.0.1:8470. The
  Store reads the QR URL (`http://172.16.222.97:8470/#t=…`) from the file
  `web-url` the updater keeps in the Store's own data folder (the Store's
  uid, 0400) while the page is on; a state goes out after each change.
- **Firewall.** The unit's `ip filter` input chain (firewalldz) drops what
  it does not accept. While the page is on, one rule at its top accepts
  it: `iifname "wlan_bridge" tcp dport 8470 accept comment
  "mgu-updater-web"`, checked every 30 s and put back after a ruleset load.
  Every start and every on/off first removes rules with that comment.
  Replies leave through the output chain's established accept.
- **Requests.** The server talks to the socket with the web secret
  (`web_secret`, `/run/mgu-updater/web-secret`), and passes on only
  `source-add` (`github` or `https` only), `source-remove`, `token-add`,
  `token-remove`, `login-start`, `login-cancel` and `install` with
  `"replace": true` (no other install), each with only its own fields; the daemon checks their values.
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
{ "type": "state", "updater": { "version": "0.4.0" }, "online": true, "privacy": "patched",
  "unit": { "hmi": "ID7", "firmware": "BMW MGU P18_23w44.2-1-3 mgu-high" },
  "providers": { "renderer": { "id": "mgu-renderd", "version": "1.1.0" } },
  "catalog": { "commit": "…", "checkedAt": 1792620000000, "checking": false, "error": null },
  "sources": [ { "id": "idrive7-apps", "type": "github", "label": "someone/idrive7-apps",
    "builtin": false, "usb": false, "channel": "releases", "status": "ok", "error": null,
    "auth": { "kind": "github", "token": "3f9a01c2", "login": "someone" }, "checkedAt": 1792620000000, "components": 7 } ],
  "tokens": [ { "id": "3f9a01c2", "kind": "github", "label": "someone", "login": "someone",
    "addedAt": 1792610000000, "rejected": false, "usedBy": ["mgu-store", "idrive7-apps"] } ],
  "signin": true,
  "login": { "url": "https://github.com/login/device", "code": "ABCD-1234",
    "expiresAt": 1792620900000, "status": "pending", "error": null },
  "web": { "enabled": false, "urls": [], "error": null },
  "busy": { "id": "doom", "phase": "download", "progress": 524288, "total": 2080457 },
  "rebooting": false, "rebootError": null,
  "components": [ { "id": "doom", "kind": "app", "title": "DOOM", "version": "1.0.1",
    "installed": "1.0.0", "size": 2080457, "status": "update", "source": "idrive7-apps",
    "build": null, "optional": false, "uninstallable": true, "revision": null,
    "description": "…", "author": "…", "icon": "/var/opt/mgu-updater/state/icons/…png",
    "mguHmi": ["ID7"], "compat": "yes", "provides": null, "service": null, "replaces": null,
    "pendingReboot": false, "queued": false, "error": null } ] }
```

- `components`: each id once (Sources, "Ids"). `status` is `installed`,
  `update`, `available` or `newer` (a local build ahead of its source);
  `build` is `"unit"` for what is built on the unit; `revision` the short
  commit a branch would install; `size` null where the source states none;
  `description` and `author` its source's (`''` when it gives none);
  `icon` the kept icon's path, or null (Sources, "Icons").
- `unit`: the head unit (`hmi` `ID7`, `ID8` or null, `firmware` its build
  string), null until the deploy tool says. `providers`: the installed tool
  providing each capability. A component's `mguHmi`, `compat`, `provides`
  (its capability), `service` (`renderer` or `tether` for a service
  package) and `replaces` ("Head units", "Capabilities").
- `busy.phase`: `download`, `build` (a source package or a repo's build
  script), `verify`, `install`, `uninstall`, or `check` (a tool the
  updater runs on, "Tools the updater runs on"); `busy.op`: `install` or
  `uninstall`.
- `sources`: stored ones in order, then USB media; `channel` is a GitHub
  source's channel in use; `auth` the token that reads it (null: none, or
  none reaches it); `error` of an `ok` source names the components it left
  out.
- `tokens`: the stored tokens ("Tokens"), never their text; `usedBy` the
  sources each one reads, `rejected` when GitHub refuses it.
- `signin`: true when a GitHub App client id is configured; only then do
  clients offer Sign in with GitHub.
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
| `{"op":"install","id","replace":true}` | installs a tool that replaces the installed one providing the same capability |
| `{"op":"uninstall","id"}` | removes an `uninstallable` component |
| `{"op":"source-add","type":"github","repo":"o/r","channel"?}`, `{"op":"source-add","type":"https","url"}` | adds a source (id: the repo's name, else `s-<hex>`) and reads it |
| `{"op":"source-remove","id"}` | removes a source (not the built-in one) and its record in `origins.json` |
| `{"op":"token-add","token","label"?}` | stores a token GitHub accepts ("Tokens"), labelled (else with its account), and reads the sources that need one |
| `{"op":"token-remove","id"}` | removes a token; its sources are read with another one, else need one |
| `{"op":"login-start"}`, `{"op":"login-cancel"}` | GitHub sign-in, which adds a token |
| `{"op":"web","enable":true\|false}` | the phone page on or off, kept across restarts (`state/web.json`) |
| `{"op":"logs","unit","lines"}` | `{"type":"logs","unit","text"}`: a journal for the phone page |

A refused request gets `{"type":"error","op",…,"error"}`; one without the
right secret, `"error":"forbidden"`. The direct answer to a request
(state, error or logs) carries the request's `"rid"`.

**The secret.** At each start the daemon makes 32 random bytes (hex) and
writes them, as the reader's own 0400 file, to the Store's data folder
(`<oap_root>/oap_<uid>/data/updater-secret`, the uid from MainApp's
registry entry for `store_app`; written by a child running as that uid, so
a link there leads nowhere it could not write itself, with the Store's group
and the apps' group of `oap_root`; written again within 15 s when the Store's
uid changes or the file is gone, as after MainApp's crash recovery reinstalls
the Store) and to `web_secret` for the phone page (`web_uid`).
Every OAP app can reach the socket; only these two can change sources or
tokens, sign in, remove or replace components or read journals. While the
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
js/sources.js            sources.json, USB media, reading each layout
js/tokens.js             the tokens (credentials/), and the per-source files of 0.2.x converted
js/catalog.js            catalog parsing (schema 1 and 2), installed-vs-source plan
js/tar.js                .tar.gz in memory: reading a repo tarball, packing a component
js/build.js              a repo's build script, as the build uid
js/login.js              GitHub device-flow sign-in
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
  two of them list; tokens: a private repo without one, a token GitHub
  rejects, one that reads two private repos (the second added later, no
  token asked for), a third repo only a token the deploy tool writes
  reaches, the same token twice, removal (each source falls back to
  another token, else needs one), a public repo read without one, a token
  added by the device flow (pending, slow_down, denied, renewed by its
  refresh token), no token anywhere but `api.github.com`, and the
  per-source files of 0.2 converted; the releases layout, a branch (a new commit of the same
  version is an update) and tags, repo-tree apps and tools, build scripts
  that succeed, fail, run too long or write outside their folder,
  requirements installed first, uninstall and its refusals, USB media
  (a stick's root and `mgu-repo/<name>`, a stick's `oap/` with a renderer
  package, links not followed, nothing written), the privileged requests and their secret files, `web-url`
  (with a stand-in page), `rid`, a first start without `sources.json`, and
  the Store 0.3's texts from the state;
- the head unit and compatibility: the unit from the deploy tool, an
  iDrive 8 app refused on iDrive 7 (and not on iDrive 8); an App Manager
  index (packages kept by sha256, one that does not match left out, a kept
  one installed after the server dropped it, one no longer listed
  removed); a renderer package listed and installed as a tool providing
  `renderer`, a second renderer refused, refused to replace without the
  secret, replacing with it, and none left after its uninstall;
- an App Manager index version 2: listed with no package downloaded, an
  unknown kind left out, an app without `mguHmi` for iDrive 8, a renderer
  as a tool, an install that downloads and keeps the package, one whose
  package is another id refused; icons from it, a folder catalog and a
  repo's `mgu-store.json`, kept by sha256 (0644), one that does not match
  or is too big left out, kept and failed ones not fetched again, removed once unnamed; a package's own `icon.png`, `author` and `store.description` from a stick and a version 1 index;
- the daemon under its supervisor: an app install and update, the updater
  updating itself, rollback from a new version that crashes and from one
  that never comes up, a download that does not match its source, a
  failed deploy, offline, the tools the updater runs on, and the reboot
  request (refused during an install, run once, a failing command and a
  unit that stays up reported) with a stand-in command.
