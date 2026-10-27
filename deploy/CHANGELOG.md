# Deploy tool changelog

## 0.5.10

- IterioDev's YouTube player package (`mguService` `ytplay`, `mgu-ytplay`) installs as the tool `mgu-ytplay`: `versions/<v>/`, `mgu-ytplay.service` (as his App Manager writes it, running `current/mgu-ytplay`) enabled for `late.target`, its recmgr entry, kept running by updates. It is `"internet": true` with its uids in `/var/opt/mgu-ytplay/internet-uids`. A Wi-Fi hotspot package (`wifi`, `mgu-wifi`) is refused, as the tether is.
- `appmanager adopt` makes his running player the tool `mgu-ytplay` the way it makes his renderer `mgu-renderd` (never stopped; ours from its next start), before anything can move `/var/opt/appmanager`. His Wi-Fi hotspot service stays as it is. The record has the player's version (`ytplay`).
- `uninstall oap-appmanager` is refused, nothing changed, while an enabled unit other than his two names a path in `/var/opt/appmanager`: moving the folder would fail it at every start.
- `mgu-install.js usb-repo` lists a player package as a tool needing `mgu-deploy` 0.5.10.

## 0.5.9

- Source packages (`mgu-app.json`) are built with the certification service in their SOME/IP manifest, so one whose manifest lacks it installs on iDrive 7 and iDrive 8.
- iDrive 8 packages get the certification service in their SOME/IP manifest when they lack it, as on iDrive 7: MainApp-21 has cadaemon create the app's keychain as the app's uid in the same way.
- What an interrupted app install left is removed only when this tool provably put it there: the newest snapshot holding the app is this tool's install of it, which found the app absent; the package on disk is the one that install placed, with the checksum recorded for it (`placed` in `state.json`) when there is one. Another installer's app of the same id, placed after our uninstall, stays. A registry entry that cannot be read counts as installed. The listing and the package are snapshotted (`cleanup`) before they are removed.

## 0.5.8

- Apps whose SOME/IP manifest does not name the certification service (`de.bmw.infotainment.certification.Certification`), which includes every idrive7-apps app, install: the deploy tool adds that entry when it prepares the package. Without it, the car does not let the new app's uid reach the service that creates its keychain: MainApp's install waited for a keychain that never came and failed. The emulator does not check those permissions.
- What an interrupted app install left (the app listed for MainApp and its package in `preinstalled_apps`, which MainApp tries to install at every start) is removed before the next app install, when this tool put it there: its record of the install names a run that is gone, or its install snapshot shows the app was not listed and the package absent before. Anything else stays, said in the output.

## 0.5.7

- Putting the copy of `CertificateManager.js` in place never fails an install: on any error the stock script stays, with a warning.
- An install MainApp failed as already installed is waited for as before, and needs no bounce once the app is there.
- Only MainApp's own rejection of an install or update ends it at once; a failure of its AppManagement child or channel goes through the bounce, which restarts the child.
- The copy's keychain wait is 115 s, inside the 125 s MainApp gives it with app-privacy 1.5.0.

## 0.5.6

- An app install or update that MainApp itself fails (for example, when the head unit's certificate service does not create the app's keychain) fails at once with MainApp's reason, in one line. MainApp is not restarted and no 10-minute wait follows: a restarted MainApp runs the same install, and restarting it stops every app, the Store included.
- MainApp's installs wait up to 120 s for an app's keychain, and when it is not created, the error names the certificate service's states, the app's security folder before the request and the uid. The deploy tool binds its copy of `CertificateManager.js` over MainApp's at each app install; app-privacy 1.5.0 lets it run that long for our apps (without it, MainApp stops it after 35 s, as before).
- The waits for MainApp's installs are measured in wall-clock time.

## 0.5.5

- iDrive 8: app-privacy installs, updates, rolls back and uninstalls without restarting MainApp-21; its patch takes effect at the next start of the head unit, and app-privacy shows as pending until then. With app-privacy installed, an app is queued only after its patch applies.

## 0.5.4

- An app update, the Store's included, runs in place, restarting only that app, also right after an update of the deploy tool: while the app manager runs a provisioning fallback with the same in-place install hook, it keeps that one, and the deploy tool's new one takes effect at the next start. An app manager restarted moments before (by an app-privacy update, say) is given its usual time to come up first.
- An update the running app manager cannot make in place restarts the app manager before the new version is put in place, then has it update the app in place, so the app's tile stays on the HMI. An app manager that started less than a minute before, whatever restarted it, is given that minute before the new version is put in place, saying so. (An update the app manager made while it was starting could leave the app without its tile until the head unit restarted.)

## 0.5.3

- A tool's `"internet": true` can name in `"uids"` a file under `/var/opt/<id>/` the tool keeps its uids in (the updater picks its own on the unit); its `uids.d/<id>` follows that file.

## 0.5.1

- iDrive 8: apps get their tile there. Each app is given what MainApp-21 needs to install and show it: the permission tables it requires, and an appletId chosen on the car from the ids its apps and the HMI already use. An update keeps the app's id; a package's own id is kept when it is free; otherwise a free one is given and the output says so. If the ids in use cannot be read, the install stops rather than guess.
- `appmanager adopt` prepares IterioDev's queued installs the same way. One whose package is unusable is dropped, saying why; if the car itself fails (no space, a read error), the adopt is undone and his queue kept.

## 0.5.0

- IterioDev's App Manager is replaced by the Store. `appmanager adopt` takes over a unit that runs it: its daemon disabled and stopped (a start the boot queued cancelled; one recmgr does not list runs until the next boot, which completes the adoption), its queued app changes moved to ours (iDrive 8) and its boot hook disabled, its iPhone tether stopped and disabled, its renderer made the tool `mgu-renderd` from the program it runs (left running), and the apps it installed or had queued and its repositories (without tokens) recorded in `appmanager.json`; with our `mgu-renderd` installed first, our unit goes back over the one it wrote; nothing is reinstalled. `uninstall oap-appmanager` adopts first, removes its units and boot hook, keeps `/var/opt/appmanager` as `appmanager-removed/`, and uninstalls its app (on iDrive 8 at the next start); the apps and the renderer stay. Both run in one snapshot, rolled back on a failure. `status --json` has `appmanager`.
- Its app package (`oap-appmanager`) and tether packages (`mguService` `tether`) are refused: mgu-uplink drives the iPhone.
- The provisioning fallback gives an app whose `custom_apps.json` entry leaves out `-enabled` or `-allowed` the value `"true"`, so apps idrive7-apps' own installer listed there keep their tiles once the fallback takes over its main.js hook.
- A tool takes over what idrive7-apps' own installer (`# added by mgu-app-install.sh`) left: a unit or drop-in of the same name is written over, its controller gate files go with them, and a tool serving `/run/mgu-renderd` removes their renderer's unit, link and program (the running one stops at the next boot). All in the install's snapshot.
- An update of an app installed without a CertificateManager keychain (idrive7-apps' installer installs them so) is done once the manager has the new version in place: MainApp's update keeps what the app had, without a keychain.
- `status --json` `idrive7.apps`: the apps idrive7-apps' installer put on the unit (registered, listed in `custom_apps.json`, with its kit's `app-spec.json`, not installed by this tool), for the updater to give them their origin.

## 0.4.0

- Providers of one capability install side by side, a second renderer among them; `install --replace` is gone (the flag is ignored). A service package or provider whose unit another manager installed is still refused.
- `"keepRunning": true` in a tool's `component.json` (`deploy/hu artifact` keeps it): a running unit in `restart` is not restarted by an update or a rollback (to a version with or without it); it keeps the version it started with, reported pending (`the new version runs from its next start`). Renderer service packages get it, as IterioDev's App Manager 2.0.1 leaves a running renderer running.
- A running socket whose unit changed is restarted when its service is stopped, so it listens as the new unit says; while its service runs it changes with the next boot (pending).

## 0.3.2

- A tool's `dropins` (`[{unit, name}]`, payload `dropins/<unit>.d/<name>`; `deploy/hu artifact` packs them from `from`): drop-ins for units the tool does not own, installed with its units, in the snapshot, removed on uninstall with the folder the tool made; one no tool of ours installed refuses the install.
- `deploy/hu install --with-uplink` adds `mgu-uplink` alone, not the other optional tools.
- `sdk-donor` also writes the oap-sdk module that module mode generates from the donor, `<run>/sdk-donor/oap-sdk/index.js` and `package.json`, and `--json` names its folder as `module`. The updater puts it where a repository's build asks for it (`build.sdk`).

## 0.3.1

- `mgu-install.js first-install` puts on the renderer (`mgu-render`) and the internet uplink (`mgu-uplink`) too; `--no-renderer` and `--no-uplink` leave them out; one the catalog does not list, or the deploy tool refuses (another renderer is installed), is left out, saying so, and the rest installs.

## 0.3.0

- The head unit: iDrive 7 or iDrive 8 by MainApp's folder (`oap-mainapp` / `oap-mainapp21`), else by the running HMI (`HmiMain3D` / `Hmi8`); the firmware from `/etc/os-release-id-dlt` (else `os-release`). `status` and `check` print them; `status --json` has `unit: {hmi, firmware}`.
- `mguHmi` (`["ID7"]`, `["ID8"]`, both) in an app's `package.json` or `mgu-app.json` or a tool's `component.json`; an app without it is for the HMIs its rhmiData has a UI for. An install not for this unit is refused (exit 2) with the reason.
- iDrive 8 apps: an install or uninstall is queued and applied at the next start by `mgu-deploy-apply.service` (`apply-pending`, before oapcontroller, refused while MainApp runs), as IterioDev's App Manager does: the package in MainApp-21's `preinstalled_apps` (npm format), the app's lines in the six das files, an update uninstalling the installed version first, a removal moving the app's files to `id8/trash/`. No app-privacy or provisioning fallback there. Donors are searched in MainApp-21's folder there, without the apps provisioning lists as preinstalled custom apps.
- Service packages (`mguService` `renderer`, `tether`) install as tools: the program in `versions/<version>/`, the App Manager's unit (root), recmgr entries; the renderer enabled, the tether on demand. Each provides its kind.
- Capabilities: a tool's `mguProvides`. A second provider is refused; `install --replace` uninstalls the installed one first, in one transaction, and puts it back when the new one fails. A service package or provider whose unit another manager installed is refused. `status --json` gives each tool's `provides`.
- With `--skip-older` an artifact not for this unit is skipped, saying why; the others install.
- A unit without recmgr's list: nothing is written there and units start at once.
- `deploy/hu artifact` keeps `mguHmi` and `mguProvides`; `mgu-install.js usb-repo` lists a renderer or tether package as a tool providing its kind, requiring `mgu-deploy` 0.3.0, and refuses a malformed `mguHmi` or `mguProvides`.

## 0.2.4

- A source package whose tree ships no file at its `package.json` `main` (`javascript/<file>.js`) gets the entry point of the SDK donor's own package (the file that package's `main` names), with a `runnerConfig.json` beside it naming the app's bundle and data folder; with no donor entry point, a loader that runs `javascript/app.js`. `build.json` and the build line name where the entry point came from.
- The provisioning fallback finds its insertion points in the app manager's `main.js` by shorter anchors; the copy it builds is unchanged.

## 0.2.3

- `updater-token` stores a token of the updater's own, not a source's: its text in `credentials/token-<id>` and its entry in `credentials/tokens.json`, unless one with that text is stored already. `--list [--json]` names the stored tokens (id, label, account), `--remove <id>` removes one; `--source` is gone. `deploy/hu install`/`updater-token` and `mgu-install.js token` (`--list [--json]`, `--remove <id>`) use it this way. `status` reports `updater_tokens`, how many are stored.

## 0.2.2

- `uninstall <id>` of an app has the running app manager uninstall it in place through the fallback copy's hook: the manager stops the app, unregisters it, which takes its tile off the HMI at once, and removes its folders, with no bounce. When the manager has no hook, does not take the request, refuses or fails it, does not finish in time or restarts, the uninstall removes the app and bounces the manager as without the hook. An app whose home's `package.json` does not name it is not handed to the manager (its home stays) and goes through the bounce.
- `install.sh` ends, while the updater (or, with `--with-uplink`, the uplink) is not running, with one line saying a head-unit restart finishes setup.

## 0.2.1

- SDK donors are stock BMW packages only; local markers and both manager lists exclude custom installs. Root splits donor bundles as an unprivileged uid/gid with a timeout and output cap, linking only returned module source strings.
- Install kits keep newer installed tools and apps while still seeding updater sources and tokens. A kit includes a token only with an explicit `--updater-token-file`.
- A package built elsewhere installs through MainApp with neither `node_modules/` nor `npm-shrinkwrap.json` (an empty shrinkwrap is added) and with a `permissions.json` lacking one of the two ACL tables (added empty). An artifact's `./` root entry is accepted.
- Snapshots exclude updater sources and credentials, which survive restores of both current and older manifests, including restores that remove the updater.
