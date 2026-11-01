# Deploy tool changelog

## 0.7.8

- iDrive 7: when the head unit's coding is not valid or is the default values (for the default values, oapcontroller's journal says only `Coding base: Default values flag is set, default values will be used`), oapcontroller never starts MainApp. With no app manager running then, an install with an app in it is refused before anything changes, saying so: the head unit needs coding to the car, a restart, then the install again.

## 0.7.7

- `main.js` (`main.bundle.js` on MainApp 6.5.5) is bound only to the fallback copy as it is. A failed first app install, a restore or a rollback that removes or replaces the copy unmounts the bind left on the old file, and binds the copy there again while the fallback's unit is present; with no copy, `main.js` stays the stock file. `restore` and app-privacy's revert first unmount such a bind, so `restore stock` succeeds in one run from it, and never bind a copy that is not there.
- A failed first install of an app that leaves it no registry entry takes out the app's `uids.txt` lines, the one the app manager gave it before it stopped and any an earlier failed attempt left, written in place: the file keeps its owner, mode and ACLs.

## 0.7.6

- iDrive 7 with MainApp 6.5.5: app installs and updates work. Its `main.js` and `AppManagement.js` are bytecode-loader stubs, so the provisioning fallback copy is built from `main.bundle.js` and bound over it, and the tool reads `AppManagement.bundle.js`. Its manager has no `AppManagementController`, so the in-place hook works with its `AppManagerStub` directly; a fresh app the restarted manager has not installed by itself once started up is installed in place.

## 0.7.5

- iDrive 7: an app's SOME/IP manifest may name interfaces the head unit's firmware does not have (iDrive 8's, on older iDrive 7 firmware); MainApp refuses such an app (`IFConfigGenerator::generate() Interface … not found`). The app is installed with those interfaces taken out of its manifest, read against the firmware's interface database (`/etc/oap/someip/someip-interfaces.json`), and the output names them: `…, de.bmw.infotainment.hmi.entrypoint2.EntryPoint2 (not on this unit) taken out of manifest.json`. The certification service stays. iDrive 8 installs the manifest as it is.

## 0.7.1

- When app-privacy (1.7.0 on) leaves out privacy-only edits this MainApp has no place for, the output says which, once per run: `app-privacy: 11 of 12 privacy edits applied; skipped: update-availability sweep`. `status` shows the same for app-privacy's last run.
- `status --json` carries app-privacy's record of its runs (`app_privacy_record`, null without one).

## 0.7.0

- A tool's `activate` and `deactivate` (`component.json`; `deploy/hu artifact` keeps them): commands run as root, without a shell, in the version's folder, for at most 120 s (`MGU_DEPLOY_HOOK_TIMEOUT_MS`). `activate` runs on every install, update and rollback once the version is in place and `/` is read-only again, before `postInstall` and `check`; a failure is rolled back: an update returns to the previous version, a first install is removed. An install that ran `activate` and is rolled back (a failed `activate` or `check`) runs the previous version's `activate` again. `deactivate` runs before a removal changes anything; a failure keeps the tool, and a removal that fails after it runs the tool's `activate` again. A `{"reboot": "<why>"}` last line marks the tool restart-pending (a removal's, the deploy tool).
- A hook's `"removeWhenUnused": [<path>...]`: files on `/` a process may still run (a binary a hook replaced while it ran). One no process runs is removed at once; one still run waits in `remove-when-unused.json` (`status --json` `remove_when_unused`) and `mgu-deploy-cleanup.service` (enabled for `late.target` and in recmgr's list from the first one) removes it at a later start, once nothing runs it. `remove-unused` runs that removal. Snapshots hold the unit, its link and the list.

## 0.6.10

- iDrive 8: an app update applied at the start of the head unit that MainApp-21 does not install (`UPDATE_FAILED`, for example a manifest naming an interface the head unit does not have) leaves the previous version installed. The update keeps that version (registry entry, home with its data, personal copies and vsomeip policy with their owners and modes, the ACLs of those under `/var/opt`, uid and package) until MainApp-21 has installed the new one; at the next start, before MainApp-21, a version it did not install is put back as it was, and MainApp-21 loads it at that start with its uid, data and tile. MainApp-21 is never restarted for it. `last_apply` reports it (`action` `restore`).

## 0.6.9

- A tool's `check` (`component.json`: one of its files, then its arguments) runs once its new version runs, after the health check and `postInstall`: node for a `.js` file, else sh, from `current/`, for at most 5 minutes (`MGU_DEPLOY_CHECK_MS`). A failing check rolls the install back like a failed health check, its running services restarted on the previous version.
- A new tool version that runs only from the next start of the head unit (a renderer that keeps running, a recmgr entry not loaded yet) is checked at that start: `mgu-deploy-verify.service` (enabled for `late.target`, in recmgr's list, run while `verify.json` exists) runs `verify` once the head unit has been up 150 s (`MGU_DEPLOY_VERIFY_AFTER_S`): the tool's services that start at boot must run and stay up, and its `check` must pass. One that fails goes back to the version before, its running services restarted. Each tool is checked once; the start never restarts the head unit. `status --json` reports the outcome as `last_verify`.
- `rollback <app>` (iDrive 7): uninstall, then install the newest kept older package, with the app's data folder carried over. When that install fails, the version that was there is installed again. Every app install keeps its package, and the one of the version it replaces, in `/var/opt/mgu-deploy/kept/<id>/`; an uninstall removes them.
- `status --json` gives each tool and app `previous`: the older version its rollback returns to, or null.

## 0.6.8

- An app update the app manager rejects (`UPDATE_FAILED`, for example a manifest naming an interface the head unit does not have) leaves the previous version installed, registered and with its tile. The manager unregisters the app and removes its source, SOME/IP interfaces and HMI data before it rejects the new version; the rollback puts these back with their owners, modes and ACLs. On iDrive 7 the app manager then restarts once and shows the tile at once. On iDrive 8 the app is back from the next start of the head unit, with its uid and data.

## 0.6.7

- iDrive 7: an app install that finds no app manager running (no MainApp node child within 30 s) fails once those 30 s pass and is rolled back, with no 600 s wait for an install nothing makes. The output says to restart the head unit and run the install again, and shows what tells why: MainApp's folder and version, oapcontroller's state and drop-ins, the head unit's uptime, the mounts over `main.js`, the processes running as MainApp's uid, the node, MainApp and oapcontroller processes, and oapcontroller's last lines about MainApp.

## 0.6.5

- A tool whose `current` is a folder, not a link (app-privacy 1.5.0 as an earlier installer left it), installs: the folder goes aside as `current.legacy-<pid>` and is removed once the new version is up. A failed install puts the folder back as `current`, with no `current.new` left; after a failed health check or app-privacy apply the tool's services restart on it and its app-privacy applies again, as with a previous version. The folder of an install that was killed comes back as `current` at the next changing run of the deploy tool, unless a new `current` is in place; then it is removed.
- An app update lists the app enabled and allowed in `custom_apps.json` even when its registry entry caches `-enabled` and `-allowed` false (an app provisioning once dropped), so the app manager installs it.

## 0.6.4

- iDrive 7: our apps go first in MainApp's install queue. The fallback copy of `main.js` runs an install or update of an app `custom_apps.json` lists right behind the one running, ahead of BMW's online apps that MainApp retries at every start without ConnectedDrive, and without the doubling retry wait they leave. The app manager runs it from its next start; a `main.js` without its anchors gets a copy without it.

## 0.6.3

- iDrive 7 with MainApp 8.1.1: app installs and updates work. MainApp 8.1.1 records no install source for an app, so an install counts as done once the app's registry entry, its files at the new version and its keychain are there. It does not update apps when it starts, so an update that cannot be made in place restarts the app manager once and then has it update the app in place.
- The keychain wait (`CertificateManager.js` copy) works with MainApp 8.1.1's script too.

## 0.6.2

- iDrive 8: app installs, updates and uninstalls happen live, with no head-unit restart. MainApp-21 installs, updates or removes the one app itself, and its tile appears or goes at once. It turns itself on after the update: from the next start of the head unit every change is live, and until then changes are applied at the next start, as before.
- iDrive 8: a change that MainApp-21 does not take live is applied at the next start, as before. MainApp-21 is never restarted by the deploy tool, `restore` and `fallback on|off` included.
- iDrive 8: the boot unit leaves MainApp-21's own `main.js` in effect when its copy does not match this firmware or does not parse. If MainApp-21 restarts within a minute of starting, or during a live change, live changes stay off until the next start of the head unit.
- `fallback on` and `fallback off` work on iDrive 8; `fallback migrate` stays iDrive 7 only.

## 0.6.1

- `"postInstall": [<script>, <arg>...]` in a tool's `component.json` (`deploy/hu artifact` keeps it): the script, one of the tool's files, runs with `sh` as root from `current/` after every install of the tool (the same version again too), for at most 5 minutes; its output is shown, and the install stands whatever it does (a failure is a warning). mgu-render 0.4.1 makes its HMI page template with it.

## 0.6.0

- A crash of one of our programs does not reboot the head unit: the crash handler's restart whitelist (`/etc/crashhandler-restartlist.conf`, `[Whitelist]`) gets the names of the installed tools' programs, from their `component.json` `crashNames`, or this tool's own list for a tool that has none (`mgu-uplink`, `mgu-render`, `python3`). Each tool install and uninstall updates it in the same snapshot, adding after the last entry and removing only names this tool added; other lines and sections stay as they are. `status`, run as root, brings the list up to date too, so it is written right after a deploy tool update and again after a firmware update; it remounts `/` only for a change, never while `/` is read-write or app-privacy's boot run has not finished, and reports the result as `crash_list` in `status --json`. The crash handler reads the list at boot. A head unit without the file is left alone.

## 0.5.10

- An install that brings app-privacy first checks that its patch fits this head unit's MainApp. When its edits do not fit (a MainApp version it does not support), the whole install is refused before anything changes on the car, naming the MainApp version and the edits that do not fit. An app-privacy apply that refuses names them too.
- The fallback copy of MainApp's `main.js` is bound only when it parses (`node --check`): an install or `fallback on` with a copy that does not parse is refused, naming the syntax error, and MainApp keeps its own `main.js`. The boot unit, refreshed by the next app install or `fallback on`, leaves such a copy unbound at boot.

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
