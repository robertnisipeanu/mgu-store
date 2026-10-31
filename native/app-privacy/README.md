# app-privacy

Keeps this repository's apps off BMW's backend, and keeps their data and
installs through crashes. `oap-mainapp` (the Online Apps Platform manager
on the head unit) enumerates every app in its registry in several off-car
paths; the patch in this directory makes each of them skip local-only
apps. It also makes MainApp only restart a local-only app that crashed.
Genuine backend-delivered apps are reported, updated, diagnosed and
recovered exactly as before. It covers iDrive 7's MainApp 8.3.2, 8.2.8
and 8.1.1 (`/usr/lib/oap-mainapp`) and iDrive 8's MainApp-21 9.3.4 and
9.2.15 (`/usr/lib/oap-mainapp21`).

## Which apps are local-only

Every app this repository builds says so itself: its `package.json`
carries `"mguLocalOnly": true`. `tools/oap_pack.js`, which every app build
packs with, stamps it into the staged tree before packing, so the marker
is inside every tgz we produce and lands in the installed `oap_<uid>/source/package.json`.

The patched manager decides at runtime, per app: it reads the app's
registry entry (`/var/opt/public/oap/oap_12201/data/apps/<appId>.json`)
for its uid and that app's installed `package.json` for the marker. An
app with no registry entry, which is every app MainApp is about to
install, is decided by its package in MainApp's preinstalled-apps folder
(`/usr/lib/oap-mainapp/preinstalled_apps/<appId>@<version>.tgz`, on
iDrive 8 `/usr/lib/oap-mainapp21/preinstalled_apps/`), the package
MainApp installs it from; so a fresh install skips the
repository version query too. An app without the marker, or whose files
cannot be read, is reported as before. Nothing is registered at install
time; renaming an app or adding a new one needs no list change.

`/var/opt/public/oap/oap_12201/data/local-only-apps.json` (a JSON array of
appIds) is an optional manual override for an app installed from a build
without the marker. Installers do not maintain it.

## What is filtered

### iDrive 7

All sites are in `/usr/lib/oap-mainapp/src/main.js` and
`/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js`. MainApp 8.1.1
has no platform analytics, no `getAvailableUpdatesFromBackend` sweep and no
`DiagOapProvider`, and MainApp 8.2.8 has no such sweep either, so those
rows apply only where MainApp has the site.

| Path | Site |
|---|---|
| Backend app inventory, `AppManagement_ff.getAllInstalledApps` → `AppManagementResult.getAllInstalledAppsResult` (joynr, domain `inf.apr`) | `AppManagementFfProviderImpl.getAllInstalledApps` |
| Backend-triggered update of every app | `AppManagementFfProviderImpl.updateAllApps` |
| App-repository version queries (`GET <repo_url>/<appId>` with a `BMW-Vin` header) | `NpmPackageManager.getLatestAppVersion`; the sweeps in `AppManagementController.getAvailableUpdatesFromBackend`, `AppsAutoupdater._performUpdate` and `MainApp._contextUpdateHandler` skip local-only apps as well |
| App-repository package downloads | `NpmPackageManager.download` (preinstalled folder only) |
| Platform analytics events carrying an app name (`APP_INSTALL`, `APP_CRASH`), forwarded via the CDC app | `AppManagementController.queuedRecursiveRetry`, `CorruptAppsHandler._tryRecoverApp` (with the crash recovery below); `APP_DOWNLOAD` and `APP_SIGNATURE_CHECK` fire only for app-repository downloads, which local-only apps never make |
| Corrupt-app reports (`appId`, version, VIN) | `CorruptAppsHandler._handleAsIrrecoverable`, `AppManager._reportCorruptApp` |
| Diagnostic readout `DiagOap.StatusOap` (`STAT_OAP_TEXT`: installation, crash and download status) | `DiagOapProvider` list building and crash-status persistence |

### iDrive 8

All sites are in `/usr/lib/oap-mainapp21/src/main.js` and
`/usr/lib/oap-mainapp21/src/AppManagement/AppManagement.js`:

| Path | Site |
|---|---|
| Backend app inventory and backend-triggered update of every app | `AppManagementFfProviderImpl.getAllInstalledApps`, `.updateAllApps` |
| App-repository version queries and package downloads, the predownload before a software update included | `NpmPackageManager.getLatestAppVersion`, `.getLatestAppVersionInfo`, `.download`; the sweeps in `AppManagementController.getAvailableUpdatesFromBackend`, `AppsAutoupdater.performUpdate` and `MainApp`'s user-triggered update skip local-only apps as well |
| Release notes request for updated apps | `AppReleaseNotesControl.downloadReleaseNotes` |
| Platform analytics events carrying an app name (`APP_INSTALL`, `APP_CRASH`, `APP_START`, `APP_STOP`) | `AppManagementController` install queue, `CorruptAppsHandler.tryRecoverApp`, `AnalyticsAppStartStopEvents` |
| Corrupt-app reports | `CorruptAppsHandler.handleAsIrrecoverable`, `AppManager.reportCorruptApp` |
| Diagnostic readout `DiagOap.StatusOap` | `DiagOapProvider21` lists (provisioning lists our apps as installable too) and crash-status persistence |

## Crash recovery

Stock MainApp handles each crash of an app (it exits on its own, is killed
for memory or CPU, or stops answering its heartbeat for a minute) with the
next step of a ladder, counted from MainApp's start: restart it; delete
its data and restart it; uninstall, reinstall and restart it; then block
it, delete its data, disable its tile and report it to the backend.
iDrive 8's MainApp-21 has its own ladder: restart it; reinstall it from
its package (a forced update); delete its data; then block it, disable
its tile and report it; every 48 hours it starts the count again and
lifts the block. MainApp-21 9.2.15 deletes its data again when it blocks
it, and its 48-hour reset lifts no block.

A local-only app is restarted on every crash instead. Its data stays, it
stays installed and its tile stays enabled. When it has been restarted 5
times in the last 10 minutes, the next crash leaves it stopped, with
MainApp logging `<appId> is local-only and was restarted 5 times in 10
minutes; left stopped until it is started again`: an app that crashes on
every start stops after a few tries. Opening it from its tile starts it
again, MainApp may start it again on its own (as it does an app it keeps
running), and the next boot starts it too. A restart that fails counts;
a death while the head unit shuts down does not.

This is the same on both head units. Other apps keep the stock ladder.

The apps in this repository carry no analytics themselves: their bundles
link an oap-sdk closure without the analytics modules and declare no
`oapAnalytics` key, so the SDK's Countly channel cannot initialise.
`check-apps` below enforces that and the marker. `data/oap-sdk-analytics.json`
in stock apps is a local `{version}` marker for the install/update event.

## On the unit

`patch_mainapp.js` runs on the unit's Node 8 as root; the unit has no
Python. It ships as the `app-privacy` tool component (`component.json`,
the deploy tool's format; `"mguHmi": ["ID7", "ID8"]`), installed at
`/var/opt/app-privacy/current/patch_mainapp.js`, with `app-privacy.service`,
a boot oneshot ordered before `oapcontroller.service` that runs `boot`
(apply, always exit 0). When the bundles are replaced (a software update
that leaves `/etc` in place, a restored copy), the next boot patches them
again before MainApp starts. `/etc` is on the root filesystem: an update
that rewrites all of it removes the unit too, and the component has to be
installed again.

```sh
node patch_mainapp.js --version          # app-privacy 1.4.0
node patch_mainapp.js check [--json]     # 0 patched, 1 unpatched, 2 mismatch
node patch_mainapp.js apply [--json]     # 0 patched, 2 refused, 1 write error
node patch_mainapp.js revert [--json]    # 0 unpatched, 2 refused, 1 write error
```

The tool patches the MainApp oapcontroller starts: MainApp-21 when the
kernel command line says `hwgen=21` or later, else iDrive 7's MainApp.
`--unit ID7|ID8` names it instead. `--main PATH` / `--appmanagement PATH`
override the bundle paths. `apply`
and `revert` are idempotent and prepare both files before writing either;
a bundle whose anchors do not match exactly (other firmware, or another
patch that changed one of our sites) is refused with nothing written.
`revert` removes exactly this patch's edits and keeps any other change to
the files. Bundles that carry an earlier release's edits count as
unpatched (`patchedBy` names that release): `apply` replaces those edits
with this release's in the same write, and `revert` removes them. The
tool keeps every earlier release's edits that differ from its own in
`EARLIER_PATCH_SETS`. A bundle on the read-only root filesystem is written with `/`
remounted read-write for the write only; a file bind-mounted over a bundle
path is written in place. With `--json`, the last stdout line is
`{"version","command","state","changed","files":[...],"restartNeeded","unit","mainapp"}`;
`mainapp` names the MainApp release whose edits the bundles take (`8.3.2`,
`8.2.8`, `8.1.1`, on iDrive 8 `9.3.4`, `9.2.15`; null on a mismatch). On iDrive 8 `changed` and `restartNeeded` are always false, since
MainApp-21 is not to be bounced for this patch, whoever runs the tool;
`nextStart` is true while the running MainApp-21 has not loaded the
bundles as they are now.

Installing or updating the component writes the new release's patch at
once: the installer runs `apply --json` and, on iDrive 7, bounces MainApp
when it reports `changed` or `restartNeeded` (INTEGRATION.md §3). On
iDrive 8 MainApp-21 is not bounced: the patch takes effect at the next
start of the head unit, the start that also installs queued apps.
`app-privacy.service` is not restarted; it runs the new release from the
next boot on.

MainApp loads the bundles when it starts. `restartNeeded` is true while a
running MainApp started before the bundles were last written; on
iDrive 7 bounce MainApp's node child then (kill it; `oapcontroller`
respawns it), on iDrive 8 it loads them at the next start. Never
stop or restart `oapcontroller` itself: it is not in recmgr's restart
list, and stopping it reboots the unit.

[INTEGRATION.md](INTEGRATION.md) is the contract for installers.

## Verify

```sh
# in this repository
sh native/app-privacy/test/run.sh        # Node 8.16.2 in Docker
node native/app-privacy/test/test_patch_mainapp.js
node native/app-privacy/patch_mainapp.js check-apps apps
```

Set `FIRMWARE_MAINAPP_DIR` to a decoded oap-mainapp folder to also test
against its bundles; `run.sh` passes it into the container.
`FIRMWARE_MAINAPP21_DIR` does the same with a decoded MainApp-21 (9.3.4 or 9.2.15).
