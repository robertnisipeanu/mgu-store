# Deploy tool changelog

## Unreleased

- iDrive 7 with MainApp 6.4.8: the provisioning fallback copy carries the in-place install hook, at its start-up's `Promise.all([mainApp.init(),bookmarkController.init()])`, so an app install or update restarts only that app instead of the app manager.

## 0.8.18

- `status` asks systemctl about all tools' units in one run per question and reads the process list once, so the status after each install or update takes about a second less.
- Building a source package on the unit checks that each module compiles inside the deploy tool's own Node, as `node --check` does, without starting a Node per module: an app built on the unit installs a few seconds sooner.

## 0.8.17

- `install`, `relay` and an app's `rollback` take `--keep-safe-mode`: an install that goes through keeps safe mode on. The updater's own repairs use it.

## 0.8.16

- Safe mode: when 4 starts of the head unit in a row end in a restart that recmgr or crashhandler asked for within 2 minutes, our tools' units stay off at the next starts, BMW's start as usual. A switch-off or a normal restart (the HMI's or the Store's) after 2 minutes, a restart our tools ask for and a start that stays up 5 minutes start the count again; a start that leaves no shutdown mark (a power cut, or `var-opt-ro.service` not running the mark) counts nothing. The next install or update that goes through as a whole, or `safe-mode off --yes`, leaves it, and the tools start at the next start. A unit whose `component.json` entry says `"runsInSafeMode": true` (the updater's) runs in safe mode. `status --json` reports `safe_mode`. An install of an older deploy tool, or a rollback to one, that has no safe mode takes the guard out and leaves safe mode. deploy/README.md, "Safe mode".
- A rollback that puts units, links or drop-ins back reloads systemd, so they take effect: a failed uninstall, restore, fallback switch or app manager takeover. The boot step that removes the deploy tool at the start after `remove-all` on iDrive 8 reloads systemd too.

## 0.8.15

- `restore` runs, before it puts anything back and with all of each version in place, the `deactivate` of each tool's current version the backup puts on another version, as a rollback does, and the hooks of the removal of each tool the backup shows absent, as a removal does (a restart one asks for is pending under the deploy tool). One that fails refuses the restore (exit 2, nothing restored), and the versions deactivated run their `activate` again, as they do when the restore fails after them, but for a tool it has removed by then. A tool the backup leaves on its version runs no hook.
- An install of an older version after a firmware update runs the `deactivate` of the version it replaces, as any downgrade does: that version may have changed the new firmware's files through its own tool since. One that fails refuses the install (exit 2), and that version stays current, needing setup. An install of the same or a newer version from another source after a firmware update still records the version it replaces as deactivated without running it.
- `mgu-install.js`: while finding the head unit, a download, or the install or removal on the head unit takes longer than 30 s, a line about every 30 s says it is still going, such as `the head unit is still installing (2 min)`. Ctrl+C (or SIGTERM) prints `stopped; run the same command again to finish` and exits as the signal would.
- `mgu-install.js` `first-install`, `status`, `uninstall` and `token`: when the head unit was found (its hotspot address answers on port 22 without SSH, or the ENET gateway reports its address) but its SSH does not answer, they say `found the head unit at <address>, but its SSH is closed: enable root SSH first, then run this again`.
- `mgu-install.js usb-repo` copies each app icon a catalog lists beside the stick's `catalog.json`, checked against its `iconSha256`, so the Store shows it from the stick. An icon that cannot be read or does not match is left out, said, and the stick is written all the same.

## 0.8.14

- `--read-only` belongs to `status` alone: any other command given it refuses (exit 2) and changes nothing.

## 0.8.13

- On iDrive 7, an app of ours the app manager registered without a `custom_apps.json` entry, such as one it put back from `preinstalled_apps` itself, gets its tile again: `status` run as root and every app install list it, from the app manager's next start, and an install in which every app is current (re-running the installer's `first-install`) lists it, or finds it listed since the app manager started, and restarts the app manager once.

## 0.8.12

- Installing or updating an app, or carrying a kept data folder into one, removes the code cache of its earlier bundle (`data/app.js.bytecode`). The head unit's Node accepts that cache for any bundle of the same length, so an update that kept the length would run the earlier version's code.

## 0.8.11

- On iDrive 7 units whose Telematics reports iDrive 8 (`hmiVersion` 3), apps get their tile: before the app manager installs an app, its package lists that HMI wherever it lists iDrive 7 and nowhere else, so the app manager installs the iDrive 7 UI, texts and images. Other units get packages as they are.
- `status` puts an installed app's iDrive 7 UI, texts and images in place from its kept package when the installed ones differ, as on such units for apps installed earlier, and the tile shows from the next start (a restart is pending). `status --read-only` and `--json` list them as `hmi_parts`.

## 0.8.10

- `status --read-only` prints the same report and changes nothing: the repairs, list and drop-in updates and app manager restarts `status` makes as root are left undone, and their lines say `pending (read-only)` when there is something to do.
- `mgu-install.js status` prints the deploy tool's status from the head unit, found like `first-install`, for users to paste when an app's tile does not show (`install.sh` and `install.ps1` run it the same way). It uses `status --read-only`; with a deploy tool without it, plain `status`, and one line after the report says that may have repaired things. Without a deploy tool it says the Store is not installed.

## 0.8.9

- A tool's new version is on disk, every file of it, before its `current` points to it, at every install and update and at the deploy tool's own; each switch of `current` is on disk before the deploy tool goes on. A power cut or ignition off right after an update leaves the version before or the new one whole, never a file the head unit had not written yet.
- recmgr's restart list keeps the firmware's own entries: an update, rollback or uninstall takes out of each of its sections only the names the deploy tool put there, recorded in `/var/opt/mgu-deploy/recmgr-names.json`, and never a name the stock backup's copy of the list has. For tools installed before that record, a name goes only when the stock backup, taken on the firmware running, lacks it; without such a backup the name stays, and the run says so.

## 0.8.8

- The deploy tool never creates the app manager's home or data folder (`/var/opt/public/oap/oap_12201`, its `data`), which the app manager creates at its first start after a factory reset. While they are missing, `custom_apps.json` and `local-only-apps.json` are not written (on iDrive 8 `relist` and `status` list our apps once the folder is there), app installs are refused, and `status` reports no lost app.
- `status` (as root) and iDrive 8's `relist` give a home or data folder owned by root back to the app manager (uid 12201, modes 3770 and 0750), and log it to the journal. After `status`'s repair on iDrive 7 the app manager runs again: started by oapcontroller, or restarted by the deploy tool; when neither happens, and after `status`'s repair on iDrive 8, a restart of the head unit is pending. `relist` repairs before the app manager starts.

## 0.8.7

- iDrive 8: an app placed for MainApp-21 at a start that it does not install, because the head unit's provisioning comes from BMW's backend and does not list it, is reported as not registered (`status`), and the updater installs it in place. This covers the Store after `first-install` on a car that has synced its apps with BMW.

## 0.8.6

- iDrive 7: every restart of MainApp the deploy tool makes first waits until MainApp's install worker has not run for 5 s, for at most 3 minutes. Still busy then, MainApp is not restarted: what needs the restart takes effect at the next start of the head unit (Restart pending), and an app install or update that needed it fails and is rolled back, to be run again later.

## 0.8.5

No changes.

## 0.8.4

- An install that finds an installed tool it does not install set up under another firmware, or missing a unit, an enablement link or a drop-in, lays a tool with an install step of its own (`activate`, `postInstall`) again files only: its units, enablement links and drop-ins, their recmgr names and limits, and the restart units laid started under recmgr's rules. Its step does not run from the copy kept here, which may be an old version from another source. Its record keeps `needsSetup` (`status --json` `needs_setup`), and the run's last line names such tools. A tool with no install step is laid again whole, as before.
- The step runs at the tool's next install (an update or the same version again) or with `setup <id> --yes`, which lays the tool again from its kept copy with its step, the stock-file fix after it; a step that fails is rolled back and `setup` exits 1. `relay [<id>...] --yes` lays a stale tool's files again without an install: files only for a tool with an install step, whole for one without. An install refused before it changes anything lays nothing again.
- After a firmware update, until a hook of the tool runs on the new firmware, no install of it (from its kept copy or an artifact) runs a hook of a version it replaces: not the deactivate due for a kept version, not the deactivate of the version replaced by a downgrade or an install from another source (each recorded as deactivated, so no later install runs it), and not, when the install fails and is rolled back, the activate of the version it goes back to; that version's files are back and it needs setup, the install exiting 1.
- `relay <id>` and `setup <id>` lay only the tools named. An install that a refusal stops after it laid tools' files again exits 1, naming them.
- `install --leave <id>` leaves that tool to a later install of the caller: no install of the run, an app's afresh included, lays it again. `mgu-install.js first-install` passes the renderer and the uplink it installs after the rest, so only tools from other sources get files only.

## 0.8.3

- iDrive 7: after every bounce, the app manager it starts is watched until it has been up 60 s (`MGU_DEPLOY_GUARD_WATCH_S`). One that dies before turns the MainApp guard off for the rest of the boot and stops the run where it is (exit 3): what it changed stays and nothing is rolled back, since that would write `/` and the app manager's files while the next manager starts; the next start of the head unit takes it up. `main.js` and `CertificateManager.js` are unbound (an unmount that fails is said, and the run still stops). Until the next start nothing binds them again, nothing bounces, and app-privacy is not applied (its apply is left to `app-privacy.service` at the next start, reported pending); app installs, removals, rollbacks, `fallback migrate`, `restore`, `remove-all` and the removal of app-privacy or IterioDev's App Manager are refused, `remove-all` with its result naming what is left. Other tools still install, their hooks' stock-file fix included. oapcontroller is never restarted.
- This tool's own records follow what a stopped run did: an app install stopped once its package is placed records that version and keeps its package; a stopped removal, or a restore's, counts as done; a stopped reinstall (an app rollback, an install afresh) keeps the app's record at the version of the install under way, its fallback install's when that one was, with that package, and its data folder: put into the app's home when the app is installed, else recorded (`state.json` `data_stash`); a stopped `remove-all` prints its result; a stopped boot check (`verify`) records its outcome, reports the tool it was rolling back as it is, keeps the tools it had not checked due for the next start, and exits 0.
- Every data folder a reinstall sets aside and does not put back, stopped or failed, is recorded in `data_stash`, each app's folders kept in a list, oldest first. Once its app is registered again, by whatever installed it, that install, else the next changing run or `status` run as root, moves the newest into the app's home while the app has no data folder or an empty one (the home and data folder never followed through a link); an install within a reinstall of the app takes none. An app with data of its own keeps it, and the folders stay recorded. Only an uninstall, a restore that removes the app, or `remove-all` removes them, all of them. A reinstall that does not stop puts the data folder in place of the new install's.
- A stop in the bounce of app-privacy's install, update or rollback, a restore or `fallback on`/`off` leaves this tool's records (`state.json`, the kept copy, the versions kept) as the finished command does.
- The guard is kept in `oap_12201/data/mgu-deploy-guard.json` (`{boot, bounce, watch, off}`), written before the bounce and when the watch starts. A run cut short while it watched leaves its watch there: once an app manager runs again, the next run or `status` run as root turns the guard off when that manager started before the watch would have ended, and unbinds the files. The fallback copy reads the same file as it loads: a load whose process started within the watch runs as the stock file for the rest of the boot (its provisioning fallback, in-place hook and queue order left out; the hook's status file says `off`).
- `status --json` has `mainapp_guard` (why app changes wait for the next start, else null), `last_bounce_at`, `lost_apps` (`[{id, version, package}]`: apps this tool installed that MainApp's registry no longer has, with their package kept; none while another run holds the lock), and per app `tile_withheld` (the flags the app manager keeps, `-allowed` or `-enabled` `false`, hide its tile). An uninstall and a restore that removes an app drop the app's record and kept packages, so an app removed on purpose is never listed.

## 0.8.2

- Runs on Node 8.9.4 (2019 MGU, firmware `D_19w31.3`), where Node has no `Atomics` and no `module.builtinModules`: the deploy tool's waits use a `sleep` child there, and the linker takes the list of Node's builtins from the natives binding. Source builds and app installs work there; newer Node runs as before.

## 0.8.1

- The deploy tool runs with umask 022 whatever its caller's, and so do the hooks, `postInstall` scripts and commands it runs. A hook that writes a stock binary with a mode keeps that mode's group and other bits, as when the updater runs it, under an SSH install's umask 077 too.
- After each `activate`, `deactivate` and `postInstall`, `/usr/bin/carplay` and `/usr/bin/aapd` get any group or other read or execute bit they lack, `/etc/aapd.conf` any group or other read bit, and root:root when owned otherwise, with a warning; the rest of the mode stays. Only a regular file on `/`'s file system, reached through no symlink and covered by no mount, is touched. A `/usr/bin/carplay` left `0700` root stops `carplay.service` (`203/EXEC`) and recmgr restarts the head unit at every start. A hook whose fix fails (`/` not read-only after its rootfs window) fails like one that exits non-zero, its restart reason and files removed once unused recorded first; the install fails after a `postInstall`.
- `mgu-install.js` unpacks and runs its kit on the unit (`first-install`, and the published deploy tool `uninstall` sends) under umask 022, in a folder root's alone by its mode.

## 0.8.0

- `mgu-install.js uninstall` removes everything the Store setup put on the head unit, run like `first-install` (`install.sh`, `install.ps1`, the standalone executables, or the script). It lists the apps and tools the deploy tool installed, from any source, and the rest, asks `Remove all of it? [y/N]` (`--yes`: no question; without a terminal and `--yes`, nothing is removed, exit 2), removes it, and ends with one line saying what is left, if anything, and the restart question when a restart finishes the job. A deploy tool on the unit without `remove-all` hands the job to the published one (`--from <folder>`: a folder `usb-repo` wrote), which stays installed should the run not finish.
- `remove-all [--json]` lists what the Store setup put on the unit; `remove-all --yes` removes it: the apps the deploy tool installed, the tools (a tool another requires after it), the provisioning fallback, app-privacy with its patch reverted, the deploy tool's boot units and recmgr entries, any limits drop-in and crash handler name it still owns, its files in the app manager's folder, the updater's sources and tokens, then `/var/opt/mgu-deploy`. The restart lists are edited as they are on the unit; no backup is restored. iDrive 7: the app manager is restarted once at the end, under the usual rules. A failed step is rolled back and named; app-privacy and the fallback stay while one of our apps does, the deploy tool while anything does, so running it again finishes. iDrive 8: removals MainApp-21 does not take in place go at the next start, after which `apply-pending` removes its boot unit and the deploy tool. Apps and the renderer IterioDev's App Manager installed or the deploy tool adopted from it stay. An install drops a self-removal still waiting for the next start.
- Every snapshot records the firmware it was taken on (`firmware` in `manifest.json`). `restore` is refused (exit 2, nothing changed) when it would write a file outside `/var/opt` from a snapshot of other firmware, or from one without the record: after a firmware update the stock snapshot holds the firmware before's restart lists and units.
- iDrive 8: `uninstall app-privacy` goes through while our only apps left are queued for removal at the next start, which removes them before MainApp-21 starts.
- `mgu-install.js first-install` says `Setup is done` on iDrive 8 only when `status` reports the Store's tile and those of the other apps `custom_apps.json` lists as shown; otherwise it ends with `Restart the head unit to finish setup.` and the restart question, or, when the fallback is off because the copy does not fit, `The Store's tile cannot show:` and the reason. A deploy tool's status without `fallback.listed_by_manager` counts as shown.

## 0.7.18

- iDrive 7: an update of an app while the app manager runs older code than its files hold (a fallback copy rebuilt by this install, as after a failed install's rollback took the fallback and the app's listing away) lists the app in `custom_apps.json` before it restarts the manager. The restarted manager provisions the app at its start and updates it in place; one it found unlisted refuses the update as disabled (`robertn_store has been disabled (enabled = false / allowed = false)`).

## 0.7.17

- `rollback <tool>` runs the deactivate of the version it leaves first, with all of that version in place, as its removal does. One that fails refuses the rollback (exit 2): that version stays current and its activate runs again. A rollback that fails after it (the health check, app-privacy's apply, the activate of the version it goes to) puts the snapshot back and runs the deactivated version's activate again.
- A rollback takes out what the version it leaves installed and the version it goes to does not list: its units (stopped first while recmgr has loaded them), enablement links, drop-ins and their limits, its recmgr names no installed tool has, and the crash handler's names no installed tool wants. Units leave before list entries, as in an uninstall. Units both versions list stay as the newer version installed them.
- An install that fails after the new version's activate ran runs that version's deactivate before it rolls back. One that fails keeps the new version current, recorded in `state.json` with its copy kept for a firmware update, as an install does; the install still fails (exit 1).
- An install of an older version of an installed tool, or of any version with `--other-source` (the updater's install of a tool another source installed), runs the deactivate of the version it replaces first, under the same rules as a rollback: one that fails refuses the install (exit 2) and that version is activated again. An update runs only the new version's activate.
- Every install of another version takes out what the versions kept under `versions/` installed and the new one does not list, as a rollback does, in the install's own rootfs window: the new version's list entries and units go in first, then the old units, links and drop-ins go, and last their list names. A failure after that puts them back.
- A rollback lays again, from the copy kept with the version it goes to, the units, links and drop-ins that version lists and that are missing, its recmgr names first, and starts its `restart` units and enabled sockets among them as at a first install; without a copy it says which are missing.
- `state.json` records, per tool, the kept versions whose deactivate ran last (`deactivated`), at a rollback, a downgrade, an install from another source, a failed install and a removal; a version made current again, or no longer kept, loses it. Such a version is not deactivated a second time. Each record is on disk as soon as its hook has run (one the disk refuses then is kept for the command's own save, said in the output), and holds through a removal that fails and a snapshot put back. A tool's deactivate must succeed, doing nothing, when what it reverts is already stock.
- `state.json` and the tool's other records it replaces by rename (`writeAtomic`) are on disk before the rename, and their folder after it.
- `uninstall <tool>` runs, after the current version's deactivate, that of each kept version whose deactivate is due, oldest first: one newer than the current version and never deactivated (a rollback by an earlier deploy tool left it, on a car where it reverts what only that version set up), or one an install could not deactivate. A refusal by any of them refuses the removal.
- An install runs the deactivate of each kept version it is due for before the version is removed (a kept version newer than the one it replaces and never deactivated, as after a rollback by an earlier deploy tool, or one owed). Laying the current version again after a firmware update (the firmware recorded with the tool, `state.json` `tools`, differs from the unit's) leaves such versions kept, for a later install or the removal; laying it again for another reason (a unit missing) runs them first, and one that fails stays kept and owed while the current version is laid again. One that fails refuses the install (exit 2, naming that version: `<id> <new>: the kept <id> <version> must be deactivated first, and its deactivate …; <current> stays current`), which the updater shows as the install's failure; the version stays kept, recorded in `state.json` (`deactivate_owed`) for the tool's next install or removal to run again, and the current version's activate runs again. An install that fails after such a deactivate activates the version it replaces again.
- A rollback whose activate of the version it goes to fails runs that version's deactivate before it puts the snapshot back and activates the version it left again; one that fails too keeps the version gone to current.
- A unit, link or drop-in another installed tool lists is never stopped or taken out when a tool's version changes or the tool is removed.
- `uninstall <tool>` takes out the units, enablement links, drop-ins and recmgr names of every version kept under `/var/opt/<id>/versions/`, so a rollback that left a newer version's pieces in place leaves nothing behind at the removal.

## 0.7.16

- iDrive 8: once the car has synced with BMW's backend (System settings, Update apps and services), Telematics serves the backend's provisioning instead of the das files, and it has no section for our apps, so MainApp-21 shows no tile for them. Every app of ours the das files list (registered, or with its package in place) keeps a `custom_apps.json` entry with the flags of its das line, which the provisioning fallback gives the app as its section. `apply-pending`, every `install` (an app already current included), `status` run as root, which the updater runs, and the new `relist` command, which the fallback's boot unit runs before MainApp-21, put a missing entry back; an app with a queued removal is left out. An entry put back counts from MainApp-21's next start.
- iDrive 8: `status` reports an app's tile as shown only when the provisioning Telematics serves (the backend's once there is one, else the das files) has the app's section (`provisioned`), or the running MainApp-21's fallback copy gave it one (`fallback`), recorded by the copy in `oap_12201/data/mgu-deploy-listed.json`. `status --json` lists those apps as `fallback.listed_by_manager`, and gives the listing step's result as `listing`.

## 0.7.15

- After a firmware update, which puts the root file system back and keeps `/var/opt`, an install sets up again what the update took. Each tool install records the firmware it was installed under (`state.json` `tools`) and keeps the tool's units, drop-ins and `component.json` under `/var/opt/mgu-deploy/kept/<id>/<version>/`.
- Every install, whatever it installs, lays again from that copy each installed tool that lacks a unit, an enablement link or a drop-in, or was installed under another firmware: its units, links, drop-ins and boot-list entries, its activate hook and postInstall, with no download. A tool installed before copies were kept is left for its source to install again, which the output says. A tool that fails to lay again is rolled back and the rest of the install goes on.
- iDrive 7: at its first start after a firmware update MainApp marks every installed app as needing an update (`"NO_FORCED_UPDATE_NEEDED": false` in its registry entry) and starts none so marked, so our apps' tiles show and a tap does nothing. An install of such an app, already current, installs it afresh (uninstall, install, its data folder carried over to the new install): a new registry entry, set up for the firmware it runs on, built against this firmware's donor apps. Not while no app manager runs; the output says so.
- `status` and `status --json` say what does not work until then: a tool's `stale` (the pieces it lacks, or the firmware it was installed under) and `kept` (whether an install lays it again itself), an app's `stale` (the app manager waits for its update; iDrive 7 and 8).

## 0.7.14

- iDrive 7: `status` and `check` report the tile of an app listed in `custom_apps.json` (ours and the other apps the provisioning fallback lists) as shown only while the running app manager runs the fallback copy (`fallback.manager_runs_copy` true); otherwise, and with no app manager running, as `hidden`, whatever the app's registry `provisioningCache` holds. `tile_provisioned`, `tile_fallback` and `tile_visible` in `status --json` follow the same rule. Apps not in `custom_apps.json`, units with the retired installer's leftovers, and iDrive 8 are reported from the registry cache.

## 0.7.13

- iDrive 7: an install in which every app is already current, on a unit whose provisioning fallback is not active (its unit missing, or `main.js` not bound to its copy) while our apps are listed in `custom_apps.json`, turns the fallback on again and restarts the app manager once, under the usual restart rules (none when it already runs the fallback copy), so the apps' tiles show. While `vsomeipd.service` or `hmi.service` is not running, the manager is not restarted (a restarted one could not start) and the apps are listed from the next start. A copy that does not build leaves the fallback as it was; the install stands, and `status --json` gives the reason as `fallback.refused`.
- `status --json` says whether the running app manager runs the fallback copy (`fallback.manager_runs_copy`; `null` without a manager or on iDrive 8).
- `mgu-install.js first-install` says `Setup is done` only when, besides the services, our apps' tiles show on iDrive 7. Otherwise it ends with `Restart the head unit to finish setup.` and the restart question, or, when the fallback could not be turned on, with one line saying why (followed by the restart line while a service still waits for the next start).

## 0.7.12

- iDrive 7: an install with an app, on a unit where the running app manager can list no app of ours (no provisioning fallback yet, as at a first install), restarts the manager once: app-privacy's restart waits for the app's, so the manager comes back with the patch, the fallback and the app. Until then it runs the stock code it started with, which knows nothing of the app. A restart still owed when the install ends is made then. Elsewhere, and for app-privacy on its own, app-privacy restarts the manager as it applies.
- `mgu-install.js first-install` ends with `Restart the head unit to finish setup.` when a restart is needed, then at a terminal asks `Restart the head unit now? [y/N]`; `y` restarts the head unit the way the Store's Restart head unit does. Not asked under CI or with `--no-restart-prompt`.

## 0.7.11

- Every service and socket unit a tool installs has its name in recmgr's `[Whitelist]` and `[WhitelistExitSuccess]`, and every ELF file it ships executable has its file name in the crash handler's `[Whitelist]` (the crash handler matches the file name of the crashed process's executable), besides the tool's `recmgr` and `crashNames` names, which go in as they are (a `recmgr` name other than letters, digits and `:._+@-` is refused at install): a crash or exit of a tool's own program does not restart the head unit. A name a tool does not declare is left out when the firmware has it (in `[ForceRestartList]`, a unit in `/lib/systemd/system` or `/usr/lib/systemd/system`, a program in `/bin`, `/sbin`, `/usr/bin` or `/usr/sbin`). An uninstall takes out the names no other installed tool has. `status`, run as root, adds the names missing from either list for the tools already installed, so the updater's status check after this update brings them; they count from the next start of the head unit. One list `status` cannot edit leaves the other's names added.
- recmgr's restart list and the crash handler's are read as the firmware reads them (`#` starts a comment anywhere on a line, entries trimmed) and keep their line ending. A list with none of the sections an edit touches (recmgr's `[Whitelist]` and `[WhitelistExitSuccess]`, the crash handler's `[Whitelist]`), such as an empty or torn file, is not edited; an edit that would change anything but the tools' names is refused too. The install is refused (exit 2) and the file left as it is, saying which file and why: `/etc/recmgr-restartlist.conf has no [Whitelist] or [WhitelistExitSuccess] section; left as it is`. An edit that changes nothing goes through whatever the list holds.
- Every file the tool writes on `/` is on disk before it replaces the old one, and the replacement is on disk before the next change, so a power cut leaves the old or the new file. An install has its payload under `/var/opt` and its list entries on disk before it writes its units, enablement links and drop-ins; an uninstall takes the units out before the entries; a rollback or restore adds the snapshot's entries first, puts the units, links and drop-ins back, and writes the snapshot's lists last. No power cut leaves a unit enabled without its entries.

## 0.7.10

- Every service unit an installed tool lists, whatever repository it comes from, gets the drop-in `<unit>.d/zz-mgu-deploy-limits.conf`: `LimitCORE=1`, at which the kernel pipes no core dump to the crash handler, so a crash of the service or of a program it starts never restarts the head unit; and a start limit of 20 starts within 10 minutes (`StartLimitIntervalSec=600`, `StartLimitBurst=20`, over a unit's own `StartLimitIntervalSec=0`), so a service that keeps failing is left failed instead of restarting for ever. Installs write it, uninstalls remove it, snapshots, rollbacks and restores carry it, and `status` gives it to the tools installed before this version and takes it from units no tool lists (`status --json` `service_limits`). Stock units are never given one. A running service takes the limits at its next start.
- An install or rollback starts a service its start limit stopped again (`reset-failed` first); for a socket-activated service, its socket.

## 0.7.9

- The refusal of an app install when the head unit's coding is missing (not valid, or the default values) and no app manager runs comes once the artifacts are read and checked: before app-privacy's check and any change to the unit. It applies on iDrive 8 as well, where oapcontroller starts no MainApp-21 on such a coding either. The message says the coding is missing, that this often happens after enabling SSH or flashing, and to restore it from a backup (BimmerCode, E-Sys or ISTA) or have HU_MGU coded, restart the head unit and install again.
- `mgu-install.js first-install` reads the same before it downloads or sends anything, and stops there (exit 2) with that message.

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

- Apps whose SOME/IP manifest does not name the certification service (`de.bmw.infotainment.certification.Certification`), which includes every idrive7-apps app, install: the deploy tool adds that entry when it prepares the package. Without it, the car does not let the new app's uid reach the service that creates its keychain: MainApp's install waited for a keychain that never came and failed.
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
