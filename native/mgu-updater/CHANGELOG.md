# Updater changelog

## 0.8.5

- Without a GitHub token (GitHub allows such a car 60 API requests an hour), a public GitHub source's files at a commit, its icons and its tarball come from raw.githubusercontent.com and codeload.github.com, which are not counted against that limit: a branch source no longer spends one request per app at each new commit. With the limit spent, a releases source (the Store's own) reads its catalog release's catalog.json from the download link instead of failing with 'GitHub rate limit reached'. Conf `github_raw` names the raw host (none when `github_api` names another server).

## 0.8.4

- The phone page shows the renderer's journals too (`mgu-render`, `mgu-render-hmi`).

## 0.8.3

- A component's `pendingReboot` is true whenever the deploy tool reports its id pending, also before it is installed: an iDrive 8 app install the deploy tool queued for the next start (`installs at the next start`), which the car's app list does not have until then, and an app this start put in place (`last_apply`) that MainApp does not list yet, for 5 minutes; after that it shows as a failed install (`put in place at the last start but not registered`), and the state goes out again when MainApp lists it. An id that is not installed is pending only on the row of the origin that queued it. Before, the row of a first install showed `available` with no pending restart, and the Store offered Install again.
- A component's `nextStart`: `install` or `remove` for such an iDrive 8 app change (the deploy tool's `pending_reboot` reasons), else null.
- A queued first install can be removed: `uninstall` takes an id whose install is queued for the next start, from the row of the origin that queued it (by the id it is queued as, also another source's row of that id), and the deploy tool drops it from its queue. A removal is decided by the row of the origin that installed or queued the id: another origin's row of it cannot remove it.
- A change the last start failed to apply (the deploy tool's `last_apply`, read with its status) shows on its row's `error`: `the install at the start of the head unit failed: <why>` (or `the removal`), with `applyFailed` `install` or `remove`, until an install or removal of that id is asked for or a newer start applies; that is kept in `state/apply-seen.json` across restarts. Removing an app not installed whose change failed puts the failure aside. Before, a failed install or removal at boot showed the app as available or installed again, with no reason.

## 0.8.2

- A component's `problem`: what an installed tool says is wrong, the `problem` line of its `/var/opt/<id>/status.json` (mgu-render 0.4.1: `In-page drawing unavailable: <reason>`), else null.

## 0.8.1

- `history`: a component's update history for its Store page: a GitHub branch source's commits that changed the component's folder (or the shared code it is built with), or the versions of the CHANGELOG.md a catalog entry names in `changelog`; what is not installed yet is marked new.

## 0.8.0

- The uplink's Wi-Fi and preferred connection for the Store (from IterioDev App Manager 2.0.6 Wi-Fi pages): the privileged requests `uplink-prefer`, `wifi-enable`, `wifi-scan`, `wifi-connect` and `wifi-forget` are checked and relayed to mgu-uplink's root-only `/run/mgu-uplink/ctl.sock` (mgu-uplink 0.7.0) with only their own fields; the answer is the state, or the uplink's refusal. A Wi-Fi password goes to the uplink only: no log line or reply names it. Without the uplink's socket the request is refused with `needs mgu-uplink 0.7.0 or newer, running`; nothing else depends on it.
- The state's `uplink`: the uplink's `status.json` (device, state, error, `preferred`, `wifi`), read every 2 s (`uplink_status`, `uplink_poll_s`), null while the uplink does not run.

## 0.7.9

- Without internet a branch source's apps of the same version aren't shown as updates: which files changed since their commit isn't known then (it is asked again once GitHub answers). What GitHub said is kept with the source's cache, so a start without internet still knows it. Before, every app of the source showed as an update while offline.

## 0.7.8

- `deploy_timeout_s` is 5400 (90 min): longer than the deploy tool's 60-minute wait for another run's lock plus its longest run, so a queued run is never stopped mid-change.

## 0.7.7

- A branch source's new commit makes an installed app of the same version an update only when the app's own folder, or the shared code it is built with (its build script's folder, outside the other components' folders), changed since the commit it was built from - one GitHub compare per commit. Before, every commit made every app of the source an update. When the changes can't be read, it is an update, as before.

## 0.7.6

- A deploy tool run still going after `deploy_timeout_s` (3600) is stopped together with everything it started, and the install fails with `the deploy tool did not finish within 60 min and was stopped`. No `mgu-deploy` process is left running.

## 0.7.5

- Requires `mgu-python` 1.0.2, and so does every app that builds with Python: `mgu-python` 1.0.1 and older cannot start on the head unit, so an updater update, or the install of such an app, updates it first.
- A Python build whose interpreter cannot start fails with `Python (<path>) cannot start (<reason>): update mgu-python`.

## 0.7.4

- The apps idrive7-apps' own installer put on the unit are adopted with the default source (cauliflowermossgrape/idrive7-apps) as their origin.

## 0.7.3

- An installed app's `icon` is the icon its installed package shows on the car's app list (its rhmiData's first entry point's, read through no link), kept in `state/icons/`; the row of the installed app has its source's icon fetched only once it has none, other sources' rows of that id show their own.
- A repo tree's apps have icons: a build-script app's `icon.png` in its folder (or the file its `mgu-repo.json` entry's `icon` names there), a source package's entry-point icon (each variant group's `resourcesPath` looked in, then `resources/`). Each is read from the listed commit once per version, in the background.
- A package without `icon.png` beside `package.json` gives its entry point's icon.
- An icon that is missing, larger than 128 KiB, not a PNG or not its sha256 is not asked for again for that version of the component and that icon, across restarts too (`state/icon-failures.json`); one that could not be fetched for another reason is asked for again a day later.

## 0.7.2

- Builds, downloads and the phone page run as uids the updater picks on the unit (README.md, "Its own uids"): free numbers above the app uid ranges of the running MainApp's config, kept in `state/uids.json` and picked again, once no download or build runs, when something else takes one; what the old uid left is removed as it, downloads wait for the uplink to read the new fetch uid, and the phone page restarts. Without MainApp's config nothing is picked. `build_uid`, `fetch_uid`, `web_uid` and their gids are overrides; `updater.conf` ships none. The fetch uid reaches the uplink as `uids.d/mgu-updater` (`component.json` `"internet": true`, `"uids": "state/internet-uids"`); while an uplink older than 0.4.0 runs, downloads run as 12990.
- A queued component that needs a newer updater waits for the updater's own update, queued with it; what is still queued when the updater restarts into its new version is installed by that version once it is kept.
- Requires `mgu-deploy` 0.5.3.

## 0.7.1

- GitHub sources and the add-source check are read with a stored token when there is one, public repos too, and without one only where every token is refused; a source that hits GitHub's rate limit with no usable token says `GitHub rate limit reached`.
- A check asks GitHub only what can have changed and reads the rest only when it did, so unchanged sources cost far fewer requests and a new version is still found in the same check.

## 0.7.0

- IterioDev's App Manager on the unit (the deploy tool's `status --json` `appmanager`) is adopted once through `mgu-deploy.sh appmanager adopt`. Each app it installed gets as origin the source that reads its public repository's index (added as an https source named after the repository when none does), the repository it recorded, else its default one when that listed the app; any other is `imported`: no origin, so the source listing it updates it ("Ids"); one no source lists has a row of source `imported`, installed and removable.
- `oap-appmanager` is listed as `Replaced by Store` and `ipheth-tether` as `Replaced by mgu-uplink` from every source (`blocked`), never installed; the App Manager's app keeps its row while it or the App Manager's service is on the unit, and its Remove is the deploy tool's `uninstall oap-appmanager`, which removes the App Manager. An App Manager installed again after its removal is adopted again.
- Default sources (`default_sources`, `cauliflowermossgrape/idrive7-apps:branch`): each is added to `sources.json` once, at the first start of an updater that names it, unless a source of that repo is there; `state/default-sources.json` records it, so one the owner removes stays removed.
- Apps idrive7-apps' own installer put on the unit (the deploy tool's `status --json` `idrive7.apps`) get an origin once: the source reading `cauliflowermossgrape/idrive7-apps` (the default source) when it lists the app, once it has been read; else `imported`, and so while no source reads that repository (one the owner removed is not added again). They are shown installed from that source and updated from it.
- `source-probe` (privileged): what a GitHub repo can be added on, read with each token in turn, then without one: its name as GitHub spells it, whether it has a release and an x.y.z tag, its default branch, and its branches (100 a page, at most 300; main, master, the default branch, then the rest). Answers `{"type":"probe", status}`: `ok`, `auth-needed` (a 403 that is no rate limit counts as no reach, and the next token is tried), `offline`, `rate-limited` (a 429, or a 403 with `x-ratelimit-remaining: 0` or `retry-after`) or `error`; a repo that is already a source is refused. A branch name no channel takes, the default one included, is left out.
- Phone page: after a GitHub repository is typed (asked about once the box is left, or on the first Add, which then waits for the answer), its channel list shows only what the repo has (Releases, Tags, its branches in that order), and it is added under the name GitHub spells it with; the free-text branch box is gone. A `/tree/<branch>` address adds that branch; a repo that could not be listed is added without a channel. `source-add` from the page takes no channel.
- Requires `mgu-deploy` 0.5.0, and `mgu-python` 1.0.0 (`requires`): an updater update installs it first, and it cannot be removed.
- Sources are listed apart: each origin's component of an id is a row of its own, and an installed component is updated only from its origin; another source's newer version of its id is beside it, not an update. With nothing of an id installed, the first origin listing one that cannot install under another id (a package built elsewhere, a tool) has the id; the others are beside it. Rows carry `installAs` (the id a row keyed `<id>@<source>` installs as); requests and `busy` name the row's `id`.
- An app the updater builds goes beside another origin's under `<id>2`, `<id>3`, … whether or not that one is installed yet, so both install; a package built elsewhere and a tool are blocked while another origin's component has the id.
- A stick folder that `mgu-install.js usb-repo` marked as a copy of a stored source (`mgu-copy.json` `copyOf`) has that source as its origin: it updates what the source installed, and what installs from it has the source as its origin.
- An installed component without an origin (installed from outside the updater, `imported`) or whose origin lists it no more is updated by the origin whose listing has its title, or, without a recorded origin, by the only origin listing its id; an origin holding another id for it (`doom2`) does not count; else it has no update: a row of its own that nothing installs over. Every installed tool and local app no source lists has a row for its Remove, removable only when its `component.json` says so (an app: always), and never for the updater, the deploy tool, the Store or what the updater requires. A removed source's origins are kept; added again, it updates them. A stick folder `mgu-repo/<name>` without `mgu-copy.json` stands for the stored source `<name>`; `usb-repo` names the GitHub repository of a checkout too.
- A requirement is installed through its row: an installed one from its origin only, one without an origin not at all.

## 0.6.0

- Providers of one capability install side by side: a second renderer installs beside the first, with no Replace. `allProviders` lists every installed provider of each capability (`{"renderer": [{id, version}, ...]}`), and `providers` keeps one of them each (`{"renderer": {id, version}}`) for the Store 0.7; components carry no `replaces`; `install` takes no `replace`, and the phone page installs nothing (it showed only Replace) and shows a component's capability.
- Every installed provider counts, so a requirement that provides a capability counts as met when another installed tool provides it, whichever it is.
- Renderer and tether service packages, and a repo tool that provides a capability, require `mgu-deploy` 0.4.0; a repo service tool providing `renderer` carries `keepRunning`, so an update leaves it running.

## 0.5.3

- An app whose id an installed app of another origin holds: built here (a repo tree's build script, or source package), it installs as `<id>2`, `<id>3`, … (the first id free on the unit and in every source), from a copy of its folder made over to that id; `state/aliases.json` keeps that id for its source, so its updates land there, until it is removed. A package built elsewhere is listed as blocked (`<id> is already installed from <source>`) and not installed. State rows carry `listedId` and `blocked`.

## 0.5.2

- `mgu-repo.json` `apps`: every subfolder of a folder holding the manifest (`app.json`) is an app, its id the subfolder's name.
- Build scripts in Python (`build.python`), under the `mgu-python` tool, which such an app requires; `build.sdk` puts the oap-sdk module generated from the donor in the repo copy first (needs `mgu-deploy` 0.3.2); `build.output` names the package the build leaves in the repo; `{id}`, `{version}` and `{dir}` are filled in.
- `build.network` (true, or app ids): the build downloads through an HTTP proxy run as the fetch uid for it alone, serving the build uid with a per-build password, public addresses on ports 443 (CONNECT) and 80 only; without the uplink the build fails, saying it needs internet.
- `tools` with `service`: a committed program installed as a tool whose systemd unit the updater writes from the entry, with its recmgr entry and `mguProvides`.
- `tools` with `preload`: a committed library a stock unit's process loads from the next head-unit start, behind a boot guard (after idrive7-apps' controller gate installer): the guard, its check and the unit's drop-in are written by the updater; it needs `mgu-deploy` 0.3.2.
- `needs` / `mguNeeds` (capabilities): an install is refused until an installed tool provides each, naming the ones the sources list; the last installed provider of a capability an installed component needs cannot be removed. State rows carry `needs`.

## 0.5.1

- `github_app_url`, shipped as the mgu-store GitHub App's page: the state's `signinApp.installUrl` is the App's install page (null without it), which the Store shows for a private source a sign-in does not reach.
- A requirement that provides a capability another installed tool provides counts as met: a component requiring the renderer installs beside another renderer.

## 0.5.0

- An https source answering IterioDev's App Manager index version 2 (`{"version": 2, "packages": [{url, sha256, size, id, kind, version, title, author, description, icon, iconSha256, …}]}`) is listed from the index alone, without downloading a package. `kind` `app` is an app (for iDrive 8 unless the entry names `mguHmi`); `renderer` and `tether` are tools providing that kind, installed by `mgu-deploy` 0.3.0 or newer; another kind is left out. An install downloads the package and refuses one whose `package.json` is not the id, version and service the index names. Version 1 indexes are read as before.
- Icons: an index version 2 entry's `icon`, a catalog entry's `icon` and an `mgu-store.json` entry's `icon` (a release asset), each with an optional `iconSha256`, are fetched after a check (PNG, at most 128 KiB) and kept in `state/icons/` for the Store to read. Components in the state carry `icon` (that file, or null), `author` and `description`.
- A package read for what it is (a stick's `oap/`, a version 1 index) gives its `icon.png`, `author` (or `author.name`) and `store.description` (over `description`), as App Manager 2 packages carry them.

## 0.4.0

- The state names the head unit the deploy tool reports, `unit` (`hmi` `ID7`/`ID8`, `firmware`). Components carry `mguHmi` (catalog schema 2, `mgu-repo.json`, a component's manifest; an app package without it, from a stick or an index: the HMIs its rhmiData has a UI for) and `compat` (`yes`, `no`, `unknown`); installing one that is not for this unit, or needs one, is refused with the reason.
- A stick's `oap/` lists IterioDev's root-service packages (`mguService` `renderer`, `tether`) as tools, which the deploy tool installs as such (they need `mgu-deploy` 0.3.0 or newer); another `mguService` is left out.
- An https source answering an App Manager index (`{"packages": [{url, sha256}]}`) is read in index mode: each package downloaded once, checked against its sha256, kept by it while listed, and read for what it is.
- Capabilities: a tool's `mguProvides` (a service package: its kind). The state's `providers` names the installed provider of each, and a component providing the same one names it in `replaces`. Its install is refused unless the privileged `{"op":"install","id","replace":true}` asks for it, which installs it with the deploy tool's `--replace`. The phone page shows a component's capability and that it is not for this unit, and offers Replace.

## 0.3.0

- Tokens are the updater's own, not a source's: `credentials/tokens.json` and `credentials/token-<id>`. A GitHub source is read with the token that read it last, else each stored token until one reaches the repo (a repo known to be public without one first), so one token serves every repo it can read and a source added later needs none. `auth-needed` only when no stored token reaches the repo.
- `token-add` (checked with `api.github.com/user`: account and a classic token's scopes; one GitHub rejects is refused) and `token-remove` replace `token-set` and `token-clear`; `login-start` takes no source and its sign-in adds a token. The state has `tokens` (id, label, account, the sources each reads; never the text) and each source's `auth` names its token.
- Token files the deploy tool writes are picked up within `usb_poll_s`, without a restart.
- The per-source token files of 0.2.x become tokens at start, one per distinct text, and are removed once this version is committed.
- An https source is read without a token.
- The phone page has a Tokens section (paste, Sign in with GitHub, Remove); adding a source asks for no token.

## 0.2.2

- An installed component shows an update when any source, a USB stick included, lists a higher version. Among equal versions the source that installed it is preferred, then a stick, then `sources.json` order; the installing source becomes its origin.
- An updater or uplink installed from a stick while the unit is offline is kept: its check passes when the deploy tool answers, without the catalog.

## 0.2.1

- Without `sources.json` the updater reads the built-in source alone and writes nothing, so the installers' `updater-sources` seeds the file whichever starts first. The first-start conversion of an earlier updater's `updater.local.conf` `catalog` and `github-token` into sources is removed: units carry `sources.json` from the installers or from updater 0.2.0.
