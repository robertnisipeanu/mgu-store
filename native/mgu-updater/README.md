# mgu-updater

The head unit's updater: a root daemon that reads its **sources** (GitHub
repos, catalog URLs, USB sticks), compares what they list with what is
installed, and downloads, builds and installs new versions of apps and
root tools, itself included, and removes them on request. The Store app
(`apps/robertn_store`) is its screen, the phone page (`js/web.js`) its
second one. On the Store's request it also restarts the head unit.

Every install goes through the deploy tool
(`/var/opt/mgu-deploy/mgu-deploy.sh install --artifact <file> --yes`,
deploy/README.md), so a component installed over SSH by `mgu-install.js`
is updated or removed by the updater, and the other way round.

How to publish apps and tools for it (the layouts, `catalog.json`,
`mgu-repo.json`, build scripts, App Manager indexes):
[docs/PUBLISHING.md](../../docs/PUBLISHING.md).

## Sources

`/var/opt/mgu-updater/sources.json` (root, 0600) lists them in order; the
Store and the phone page add and remove them:

```json
{ "schema": 1, "sources": [
  { "id": "mgu-store", "type": "github", "repo": "robertnisipeanu/mgu-store", "builtin": true },
  { "id": "idrive7-apps", "type": "github", "repo": "cauliflowermossgrape/idrive7-apps", "channel": "branch" },
  { "id": "s-3f9a",    "type": "https",  "url": "https://example.org/repo/catalog.json" }
] }
```

- `github`: a repo, read on its `channel`: `releases` (the `catalog`
  release, else the packages attached to releases), `branch:<name>`,
  `branch` (the default branch) or `tags` (the highest `v1.2.3`, `1.2.3` or
  `<id>@1.2.3` tag). Without one: `releases` when the repo has a release,
  else its default branch. `https`: a `catalog.json` URL, or an App
  Manager index. `file`: a local folder.
- `builtin`: the Store's own source (`builtin_repo`, id `mgu-store`),
  always there.
- **Default sources** (`default_sources`): idrive7-apps, idrive-apps and
  car-apps, each added once, at the first start of an updater that names
  it, unless a source of that repo is there already. The installers seed
  the same list (`deploy/sources.json`) and never replace a `sources.json`
  that is there.
- Nothing is signed: trust is HTTPS (and a token, "Tokens") to a source
  the owner added; every download is checked against the size and sha256
  its source lists, or, where the source names none (release assets, repo
  trees), its sha256 is taken on download.
- A source that cannot be read keeps the components it listed last.

**GitHub without a token.** A public GitHub source read without a token
uses GitHub's web hosts (`github.com`, `raw.githubusercontent.com`,
`codeload.github.com`), which GitHub's API limit of 60 requests an hour
per address does not count. The API is used only for a releases layout
without a `catalog` release, for listing an `apps` folder, and when a
source is added. A repo those hosts do not reach (private, or not there)
is read through the API as with a token.

**Building on the unit.** A repo tree's source packages and build scripts
build on the head unit, without network unless the build asks for it, as
the updater's build uid, within `build_timeout_s` (600) and
`build_max_bytes` (200 MB). docs/PUBLISHING.md, "Build scripts", has what a
build gets and must leave.

**Ids.** Component ids are global on the unit, and each source's component
of an id is a row of its own. An installed component is updated only by the
source that installed it (its origin); another source's listing of that id
shows beside it, `blocked` (`<id> is already installed from <source>`). An
app the updater builds itself (a repo tree's build script or source
package) installs beside it under another id instead: `<id>2`, `<id>3`, …,
and that source's updates land there. A component installed from outside
the updater (`mgu-install.js`, IterioDev's App Manager) is updated by the
source whose listing has its title, the built-in source first. A stick
folder `mgu-install.js usb-repo` wrote from a source (its `mgu-copy.json`,
`{"copyOf": "github:<owner>/<repo>"}` or the catalog's URL) counts as that
source, so a car without internet updates from the stick what that source
installed.

**Requirements and removal.** `requires` (`{"<id>": "<min version>"}`)
installs a missing or older requirement first, from the same source if it
has one at least that version, else from any; a requirement that provides a
capability another installed tool provides counts as met. Apps and
`uninstallable` tools can be removed, unless something installed requires
them. The Store and the tools its setup installs (the updater, the deploy
tool, `mgu-python`, `app-privacy`, `mgu-render`, `mgu-uplink`) are never
removed by the updater, whatever a source says; `mgu-install.js uninstall`
(deploy/README.md) removes them.

**Head units.** Each component may say which head units it is for
(`mguHmi`). One that is not for this head unit is listed, and its install
is refused with the reason (`<title> is for iDrive 8; this head unit is
iDrive 7`).

**Capabilities.** A tool may provide a capability (`mguProvides`; a
renderer package provides `renderer`). Providers of one capability install
side by side (`native/mgu-render/README.md`, "Beside other renderers"). A
component that `needs` a capability is refused until an installed tool
provides it.

**IterioDev's App Manager.** The Store replaces it, and mgu-uplink its
iPhone tether: `oap-appmanager` is `blocked` `Replaced by Store` and
`ipheth-tether` `Replaced by mgu-uplink`, whichever source lists them. When
the App Manager is on the unit, the updater has the deploy tool adopt it
(deploy/README.md, "IterioDev's App Manager"). Each app it installed
updates from the repository it came from, added as a source when needed,
else from the source that lists it. Its row's Remove removes the App
Manager and leaves what it installed.

**idrive7-apps' own installer.** The apps idrive7-apps'
`mgu-app-install.sh` put on the unit update from the idrive7-apps source
once it has read that repository. Nothing is reinstalled: an update builds
the repository's newer version and installs it over the app.

## Tokens

GitHub tokens are the updater's own, not a source's: one token that reads
all the owner's repos serves every source, and a repo added later needs no
new token when a stored one reaches it. They are kept in `credentials_dir`
(`/var/opt/mgu-updater/credentials`, root only); the deploy tool adds them
too (`mgu-install.js token`, deploy/README.md).

- A GitHub source is read with a stored token when one reaches it, and
  without a token only when every token is refused for that repo. A source
  no token reaches is `auth-needed`. A request GitHub's rate limit refuses
  fails with `GitHub limit reached. Try later or sign in.`
- A token GitHub rejects is refused when added. The same text again is not
  stored twice.
- A token is never shown to the Store or the phone page, and goes only to
  `api.github.com`, never to the host a download redirects to. An https
  source is read without a token.

**Signing in to GitHub.** Sign in with GitHub runs GitHub's device flow for
the GitHub App [mgu-store](https://github.com/apps/mgu-store)
(`github_client_id`): the Store shows the address and the code, the owner
enters them on a phone, and the token GitHub gives is stored, labelled with
the account. An expiring token is renewed by itself. The App reads
repository contents (read-only) and must be installed on the repos the car
reads; the Store shows its install page as a QR code for a private source
that still needs it. An empty `github_client_id` turns sign-in off; a
pasted token still works.

## USB media

A stick is read while it is mounted under `usb_roots` (`/media/<label>`).
The stick's root, `mgu-repo/` and each `mgu-repo/<name>/` that hold
`catalog.json` or `mgu-repo.json` are sources `usb:<label>[/<path>]`, until
the stick goes; `mgu-install.js usb-repo` writes them (deploy/README.md,
"mgu-install"). A stick's `oap/` folder (IterioDev's App Manager's) is
source `usb:<label>/oap`: each `*.tgz`, `*.tar.gz` or `*.mgu` in it is a
component with the id and version of its own `package.json`; the newest of
an id wins. Sticks are only read, and no link on them is followed.

## Installing

- Sources are read at start (after `first_check_s`), every
  `check_interval_s`, when the uplink comes up, when a stick is put in, and
  on request (the Store, `updater.js check`).
- Installs run on request, one at a time; later requests queue. The deploy
  tool's own update goes first, the Store's last. The updater installs
  nothing unasked, except to set up again what a firmware update left not
  working and to put back an app the head unit lost: an app install
  restarts every running OAP app.
- An app of ours the head unit's app manager lost (its registry wiped)
  while the deploy tool keeps its package is installed again from that
  package, the Store first, once per start of the head unit. An app removed
  on purpose stays removed.
- Downloads use HTTPS only, through the internet uplink (native/mgu-uplink).
  A certificate's validity dates are not held against it, since the unit's
  clock may be days off; everything else about it is checked. A download
  that breaks is tried again, from where it stopped when the server
  allows.

### Through a proxy

Downloads can go through a proxy, for networks where GitHub is slow or
blocked. Set it in the Store (Settings → Proxy), on the phone page, or in
`/var/opt/mgu-updater/updater.local.conf` (then restart the updater or the
head unit):

```
proxy = socks5://192.168.8.1:7891
```

- `http://host:port` (a proxy that takes `CONNECT`) or `socks5://host:port`;
  with a user name and password as `socks5://user:password@host:port`
  (characters such as `@`, `:` or `#` in them written as `%40`, `%3A`,
  `%23`).
- Everything goes through it: GitHub, catalogs, packages, pictures, every
  redirect, and the downloads of a build on the unit.
- TLS runs through the proxy to the server itself, with the same
  certificate checks. The proxy gets its own user name and password only,
  never a token.
- The proxy looks up the names of what is downloaded itself, so a name
  server that answers wrongly on the car's network does not matter.
- When the proxy is down or refuses, the error says so, e.g. `proxy
  192.168.8.1:7890: connection refused`.
- The log and the Store show only the proxy's host and port.
- An empty `proxy` (or off in the Store) downloads directly again.

### Its own uids

Builds, downloads and the phone page each run as a uid of the updater's
own, with no account: the build, fetch and web uids. The updater picks free
numbers above the uid ranges the app manager hands apps, and picks again
when something takes one later. To fix a number instead, set `build_uid`,
`fetch_uid` or `web_uid` (and `build_gid`, `fetch_gid`, `web_gid`) in
`updater.local.conf`.

### Updating itself

A new version of the updater that does not come up, or cannot read its
sources, is not kept: the previous version comes back and the Store shows
why (`0.5.0 not kept: it cannot fetch the catalog …`).

### Tools the updater runs on

A new version of the deploy tool or the uplink is checked right after its
install, and the version before is put back when the check fails. The
Store row then shows Failed, with "<new> does not run; <old> kept" or
"<new> gives no internet; <old> kept".

| Tool (`updater.conf`) | Check |
|---|---|
| `deploy_tool` (`mgu-deploy`) | answers `status --json` within 60 s |
| `uplink_tool` (`mgu-uplink`) | within `bootstrap_check_s` (90 s) the internet is back and the first network source answers; not checked when there was no internet before the install |

A Store update that does not start, or whose tile does not show, within 2
minutes goes back to its version before: `<version> did not start;
<previous> is back`.

## Restarting the head unit

The Store's **Restart head unit** sends `{"op":"reboot"}` with the secret,
and the daemon runs the `reboot` command (`/usr/bin/nsm_control
--requestRestart 7 --normal`): the same normal restart the HMI's own restart
asks for.

- Before it runs, the start's boot id goes into
  `/var/opt/mgu-deploy/restart-requested`, so the deploy tool's safe mode
  never counts the restart as a failed start (deploy/README.md, "Safe
  mode").
- Refused (`an install is running`) while an install runs or waits. Once
  the restart is under way, installs are refused (`the head unit is
  restarting`).
- The state's `rebooting` is true from the request until the unit goes
  down. A restart that does not happen sets `rebootError`.
- A request without the secret is refused before the unit has been up 4
  minutes, within 10 minutes of the last restart the updater asked for, and
  after 3 in the last hour.

## Phone page

A page the car serves to a phone on its hotspot (`js/web.js`): the
sources with their channel and status, the components with installed and
source versions, what is being installed, errors, and the logs. On it the
owner adds a GitHub source or a catalog URL (picking Releases, Tags or a
branch, from what the repo has) and removes one, adds tokens by pasting or
Sign in with GitHub, and sets the proxy. Off by default; the Store turns it
on and off and shows its QR code.

It listens on port `web_port` (8470) of the hotspot address
(`172.16.222.97`) only while it is on. The QR code carries a new access
token each time it is turned on; without it the page says *Scan the code
in the Store*.

## Configuration

`updater.conf` (in the version folder) holds the defaults with a comment
on each; `/var/opt/mgu-updater/updater.local.conf` overrides any key and
survives updates.

**Log.** Every line the daemon logs goes to the journal and, with its UTC
time, to `log_file` (`/tmp/mgu-updater.log`; past 128 KiB it moves to
`mgu-updater.log.1`): each source read, each install's phases, a build's
output as `build <id>: …` lines, and the deploy tool's output as `deploy:
…` lines.

## The socket

`/dev/shm/mgu-updater/updater.sock`, `0660 root:tm_oap_app` (every OAP app
has that group). One JSON object per line. The daemon sends the full state
on connect, after each request, and whenever it changes (at most every
250 ms):

```json
{ "type": "state", "updater": { "version": "0.4.0" }, "online": true, "privacy": "patched",
  "unit": { "hmi": "ID7", "firmware": "BMW MGU P18_23w44.2-1-3 mgu-high" },
  "allProviders": { "renderer": [ { "id": "mgu-render", "version": "0.2.0" }, { "id": "mgu-renderd", "version": "1.1.2" } ] },
  "providers": { "renderer": { "id": "mgu-render", "version": "0.2.0" } },
  "catalog": { "commit": "…", "checkedAt": 1792620000000, "checking": false, "error": null },
  "sources": [ { "id": "idrive7-apps", "type": "github", "label": "cauliflowermossgrape/idrive7-apps",
    "builtin": false, "usb": false, "channel": "branch:main", "status": "ok", "error": null,
    "auth": { "kind": "github", "token": "3f9a01c2", "login": "someone" }, "checkedAt": 1792620000000, "components": 7 } ],
  "tokens": [ { "id": "3f9a01c2", "kind": "github", "label": "someone", "login": "someone",
    "addedAt": 1792610000000, "rejected": false, "usedBy": ["mgu-store", "idrive7-apps"] } ],
  "signin": true, "signinApp": { "installUrl": "https://github.com/apps/mgu-store/installations/new" },
  "login": { "url": "https://github.com/login/device", "code": "ABCD-1234",
    "expiresAt": 1792620900000, "status": "pending", "error": null },
  "web": { "enabled": false, "urls": [], "error": null },
  "proxy": { "on": true, "kind": "socks5", "address": "192.168.8.1:7891", "auth": false, "error": null },
  "uplink": { "device": { "kind": "wifi", "name": "Phone" }, "state": "online", "error": null, "preferred": "wifi",
    "wifi": { "enabled": true, "link": "online", "ssid": "Phone", "ip": "172.20.10.2", "signal": -45, "networks": [ … ],
      "saved": [ "Phone" ], "scanning": false, "error": null } },
  "busy": { "id": "doom", "phase": "download", "progress": 524288, "total": 2080457 },
  "rebooting": false, "rebootError": null, "safeMode": null,
  "components": [ { "id": "doom", "kind": "app", "title": "DOOM", "version": "1.0.1",
    "installed": "1.0.0", "size": 2080457, "status": "update", "source": "idrive7-apps",
    "build": null, "optional": false, "uninstallable": true, "revision": null,
    "description": "…", "texts": { "de": { "title": "DOOM", "description": "…" } }, "author": "…",
    "icon": "/var/opt/mgu-updater/state/icons/…png",
    "mguHmi": ["ID7"], "compat": "yes", "provides": null, "service": null,
    "listedId": null, "installAs": "doom", "blocked": null, "pendingReboot": false, "problem": null, "repair": null, "nextStart": null, "queued": false,
    "previous": null, "requiredAlone": [], "error": null } ] }
```

- `components`: each source's component of an id ("Ids"). `id` is the
  row's id (requests and `busy` name it), `listedId` the id its source
  lists when `id` is another, `installAs` the id it is or would be
  installed under, `blocked` why it cannot be installed (else null).
  `status` is `installed`, `update`, `available` or `newer` (a local build
  ahead of its source); `build` is `"unit"` for what is built on the unit;
  `revision` the short commit a branch would install; `size` null where the
  source states none; `icon` the kept icon's path, or null; `texts` the
  title and description in other languages, by the Store's language code
  (`de`, `pt-BR`, `zh-TW`), else null; `source` null for an installed
  component without an origin.
- `pendingReboot`: the change takes effect at the next start of the head
  unit; `nextStart` `install` or `remove` for an iDrive 8 app change queued
  for then (else null).
- `problem`: what an installed tool says is wrong (the `problem` of its
  `/var/opt/<id>/status.json`), else `Not working: <repair>` for an
  installed component that does not work, else null. `repair`: why it does
  not work until it is set up again (after a firmware update), else null.
  `needsSetup`: why its install step waits for Set up, else null.
- `tileHidden`: an installed app of ours whose tile does not show after an
  install restarted the app manager, until the next start of the head
  unit; else false.
- `previous`: the version Undo update returns to, else null.
- `requiredAlone`: of an installed app, the installed tools only it
  requires, which its removal may take along; else `[]`.
- `error`: why the last install, removal or start failed, else null.
- `unit`: the head unit (`hmi` `ID7`, `ID8` or null, `firmware` its build
  string), null until the deploy tool says. `allProviders`: the installed
  tools providing each capability; `providers`: the first of them each. A
  component's `mguHmi`, `compat` (`yes`, `no`, `unknown`), `provides` (its
  capability) and `service` (`renderer` or `tether` for a service package).
- `busy.phase`: `download`, `build`, `verify`, `install`, `uninstall`, or
  `check` (a tool the updater runs on); `busy.op`: `install`, `uninstall` or
  `rollback`.
- `sources`: stored ones in order, then USB media; `status` `ok`,
  `checking`, `error`, `auth-needed` or `offline`; `channel` a GitHub
  source's channel in use; `auth` the token that reads it (null: none);
  `error` of an `ok` source names the components it left out.
- `tokens`: the stored tokens, never their text; `usedBy` the sources each
  one reads, `rejected` when GitHub refuses it.
- `signin`: whether clients offer Sign in with GitHub; `signinApp` the App's
  install page, or null. `login`: the sign-in in progress (`pending`,
  `done`, `error`, `expired`), or null.
- `web`: the phone page's state. `proxy`: the proxy setting (`on`, `kind`
  `http` or `socks5`, `address` host:port, `auth` whether it has a user name
  or password, never shown, and `error`).
- `uplink`: the uplink's `status.json` (native/mgu-uplink/README.md), null
  while the uplink does not run.
- `catalog`: the sources as one line: `checking` while any is read, `error`
  the first source that failed.
- `mainappGuard`: why app changes wait for the next start of the head unit,
  else null.
- `privacy`: app-privacy's state (`patched`, `restart-needed`, `unpatched`,
  `mismatch`, `unknown`, or `null` without the tool).
- `rebooting`, `rebootError`: "Restarting the head unit". `safeMode`:
  `{ "at", "reason" }` while the deploy tool's safe mode keeps our tools off
  (deploy/README.md, "Safe mode"), else null.

Requests: `{"op":"status"}`, `{"op":"check"}`, `{"op":"install","id"}`
(with its missing requirements first), from any app.
`{"op":"hello","id","version"}` (no answer): a client says what it is.
**Privileged** ones carry `"secret"`:

| Request | Does |
|---|---|
| `{"op":"reboot"}` | restarts the head unit ("Restarting the head unit") |
| `{"op":"safe-mode-off"}` | Leave safe mode; refused while an install runs or waits. The tools start at the next start of the head unit |
| `{"op":"uninstall","id","tools"?}` | removes an `uninstallable` component (every app but the Store); then each of `tools`, which must be among the app row's `requiredAlone` |
| `{"op":"setup","id"}` | Set up: a tool whose row has `needsSetup` set up again with its install step |
| `{"op":"rollback","id"}` | Undo update: a component whose row has `previous` back to that version |
| `{"op":"source-add","type":"github","repo":"o/r","channel"?}`, `{"op":"source-add","type":"https","url"}` | adds a source (id: the repo's name, else `s-<hex>`) and reads it |
| `{"op":"source-probe","repo":"o/r"}` | `{"type":"probe","repo",status}`: what a GitHub repo can be added on. `ok` with `name` (the repo as GitHub spells it), `releases` (it has a release), `tags` (an x.y.z tag), `defaultBranch`, `branches` (at most 300) and `more` (there are more); `auth-needed`, `offline`, `rate-limited`, or `error` with `error`. A repo that is already a source is refused |
| `{"op":"source-remove","id"}` | removes a source (not the built-in one); what it installed keeps it as its origin |
| `{"op":"token-add","token","label"?}` | stores a token GitHub accepts, labelled (else with its account), and reads the sources that need one |
| `{"op":"token-remove","id"}` | removes a token; its sources are read with another one, else need one |
| `{"op":"login-start"}`, `{"op":"login-cancel"}` | GitHub sign-in, which adds a token |
| `{"op":"proxy-set","url"}` | the proxy downloads go through (`""`: none), kept in `updater.local.conf`; the sources are read again |
| `{"op":"web","enable":true\|false}` | the phone page on or off, kept across restarts |
| `{"op":"logs","unit","lines"}` | `{"type":"logs","unit","text"}`: a journal (the updater's, the uplink's, the renderer's and the deploy tool's units; 1–1000 lines) |
| `{"op":"uplink-prefer","kind"}` | the uplink's preferred connection: `wifi`, `usb`, `phone` (`""` for none) ("The uplink") |
| `{"op":"wifi-enable","on":true\|false}`, `{"op":"wifi-5ghz","on":true\|false}`, `{"op":"wifi-scan"}`, `{"op":"wifi-connect","ssid","psk"?}`, `{"op":"wifi-forget","ssid"}` | the uplink's Wi-Fi ("The uplink") |
| `{"op":"usb-phone","on":true\|false}` | phones over USB used by the uplink or left alone ("The uplink") |

A refused request gets `{"type":"error","op",…,"error"}`; one without the
right secret, `"error":"forbidden"`. The direct answer to a request
(state, error or logs) carries the request's `"rid"`.

**The secret.** At each start the daemon writes a new random secret, as
the reader's own 0400 file, to the Store's data folder
(`<oap_root>/oap_<uid>/data/updater-secret`) and to `web_secret` for the
phone page. Every OAP app can reach the socket; only these two can change
sources or tokens, sign in, remove components, read journals or change the
uplink. While the phone page is on, `web-url` beside `updater-secret` holds
its address with the access token, for the Store's QR code.

`js/client.js` is the client (the Store bundles it; the privileged
requests take the secret as `opts.secret` or `setSecret()`).

### The uplink

The Store talks to the updater only; the updater relays `uplink-prefer`,
`usb-phone`, `wifi-enable`, `wifi-5ghz`, `wifi-scan`, `wifi-connect` and
`wifi-forget` to the uplink's requests socket (`uplink_ctl`,
`/run/mgu-uplink/ctl.sock`), never with the secret. A network name is 1 to
32 bytes, a password 8 to 63 printable ASCII characters or none. The answer
is the state once the uplink took it, else an error with the uplink's
reason, `needs mgu-uplink 0.7.0 or newer, running`, or `the uplink gave no
answer`. The log never names the password.

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
js/tokens.js             the tokens (credentials/)
js/catalog.js            catalog parsing (schema 1 and 2), installed-vs-source plan
js/tar.js                .tar.gz in memory: reading a repo tarball, packing a component
js/build.js              a repo's build script, as the build uid
js/login.js              GitHub device-flow sign-in
js/fetch.js              one download, as the fetch uid
js/certs.js              a server's certificate chain checked without its dates
js/py/sitecustomize.py   a Python build's TLS: certificates checked without their dates
js/client.js             socket client (Store app, command line)
js/web.js                the phone page
updater.conf             defaults
systemd/mgu-updater.service
component.json           the tool component (deploy tool format); its unit runs in safe mode
```

## Tests

```sh
sh test/run.sh                          # Node 8.16.2 in Docker
MGU_TEST_NODE_VERSION=8.9.4 sh test/run.sh
```

They run offline, against a local HTTPS server standing in for GitHub and
a stand-in deploy tool.
