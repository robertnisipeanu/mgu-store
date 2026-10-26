# app-privacy

Keeps this repository's apps off BMW's backend. `oap-mainapp` (the Online
Apps Platform manager on the head unit) enumerates every app in its
registry in several off-car paths; the patch in this directory makes each
of them skip local-only apps. Genuine backend-delivered apps are reported,
updated and diagnosed exactly as before.

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
(`/usr/lib/oap-mainapp/preinstalled_apps/<appId>@<version>.tgz`), the
package MainApp installs it from; so a fresh install skips the
repository version query too. An app without the marker, or whose files
cannot be read, is reported as before. Nothing is registered at install
time; renaming an app or adding a new one needs no list change.

`/var/opt/public/oap/oap_12201/data/local-only-apps.json` (a JSON array of
appIds) is an optional manual override for an app installed from a build
without the marker. Installers do not maintain it.

## What is filtered

All sites are in `/usr/lib/oap-mainapp/src/main.js` and
`/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js`:

| Path | Site |
|---|---|
| Backend app inventory, `AppManagement_ff.getAllInstalledApps` → `AppManagementResult.getAllInstalledAppsResult` (joynr, domain `inf.apr`) | `AppManagementFfProviderImpl.getAllInstalledApps` |
| Backend-triggered update of every app | `AppManagementFfProviderImpl.updateAllApps` |
| App-repository version queries (`GET <repo_url>/<appId>` with a `BMW-Vin` header) | `NpmPackageManager.getLatestAppVersion`; the sweeps in `AppManagementController.getAvailableUpdatesFromBackend`, `AppsAutoupdater._performUpdate` and `MainApp._contextUpdateHandler` skip local-only apps as well |
| App-repository package downloads | `NpmPackageManager.download` (preinstalled folder only) |
| Platform analytics events carrying an app name (`APP_INSTALL`, `APP_CRASH`), forwarded via the CDC app | `AppManagementController.queuedRecursiveRetry`, `CorruptAppsHandler._tryRecoverApp`; `APP_DOWNLOAD` and `APP_SIGNATURE_CHECK` fire only for app-repository downloads, which local-only apps never make |
| Corrupt-app reports (`appId`, version, VIN) | `CorruptAppsHandler._handleAsIrrecoverable`, `AppManager._reportCorruptApp` |
| Diagnostic readout `DiagOap.StatusOap` (`STAT_OAP_TEXT`: installation, crash and download status) | `DiagOapProvider` list building and crash-status persistence |

The apps in this repository carry no analytics themselves: their bundles
link an oap-sdk closure without the analytics modules and declare no
`oapAnalytics` key, so the SDK's Countly channel cannot initialise.
`check-apps` below enforces that and the marker. `data/oap-sdk-analytics.json`
in stock apps is a local `{version}` marker for the install/update event.

## On the unit

`patch_mainapp.js` runs on the unit's Node 8 as root; the unit has no
Python. It ships as the `app-privacy` tool component (`component.json`,
the deploy tool's format; iDrive 7's MainApp only, `"mguHmi": ["ID7"]`), installed at
`/var/opt/app-privacy/current/patch_mainapp.js`, with `app-privacy.service`,
a boot oneshot ordered before `oapcontroller.service` that runs `boot`
(apply, always exit 0). When the bundles are replaced (a software update
that leaves `/etc` in place, a restored copy), the next boot patches them
again before MainApp starts. `/etc` is on the root filesystem: an update
that rewrites all of it removes the unit too, and the component has to be
installed again.

```sh
node patch_mainapp.js --version          # app-privacy 1.2.2
node patch_mainapp.js check [--json]     # 0 patched, 1 unpatched, 2 mismatch
node patch_mainapp.js apply [--json]     # 0 patched, 2 refused, 1 write error
node patch_mainapp.js revert [--json]    # 0 unpatched, 2 refused, 1 write error
```

`--main PATH` / `--appmanagement PATH` override the bundle paths. `apply`
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
`{"version","command","state","changed","files":[...],"restartNeeded"}`.

Installing or updating the component writes the new release's patch at
once: the installer runs `apply --json` and bounces MainApp when it
reports `changed` or `restartNeeded` (INTEGRATION.md §3).
`app-privacy.service` is not restarted; it runs the new release from the
next boot on.

MainApp loads the bundles when it starts. `restartNeeded` is true while a
running MainApp started before the bundles were last written; bounce
MainApp's node child then (kill it; `oapcontroller` respawns it). Never
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

The tests cover the check/apply/revert state machine, fail-closed
behaviour on a mismatched bundle, composition with other edits, the
runtime marker and override decision, build-time stamping, `check-apps`
over this repository's apps, and — when `FIRMWARE_MAINAPP_DIR` names a decoded oap-mainapp —
patching, parsing and exactly reverting the reference firmware
bundles.
