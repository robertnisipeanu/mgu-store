# robertn_store 0.3.2

The Store: every app and head-unit tool in the published catalog, each with
its state, and the progress of the running install. It is the screen of
[mgu-updater](../../native/mgu-updater/README.md), which does all the work;
the app shows the state the updater streams over its socket and sends it
three requests: check, install and reboot.

| Row (`LT_Button_1Row_2Col7030_2Text`) | Press |
|---|---|
| `DOOM` · `Update 1.0.1` | update to the catalog version |
| `Display bridge demo` · `Install 1.0.0` | install |
| `Vehicle control` · `Installed 1.0.0` | nothing |
| `DOOM` · `42%` / `Verifying` / `Installing` | nothing (in progress) |
| `Extended dashboard` · `Waiting` | nothing (queued) |
| `Display bridge` · `Restart pending` | nothing (installed; active after the next reboot) |
| `DOOM` · `Failed, retry` | try again (the status line names the error) |

The start screen has a status line (`1 update, checked 14:02`, `Offline`,
`Checking for updates`, `Restarting`, the last error, `Updater not
running`), a **Check for updates** button, a progress bar for the running
install (hidden when none runs), two rows, **Apps** and **Head-unit
tools**, each showing its running install, `Failed` or its number of
updates, and **Restart head unit**. Each of the two rows opens its own list
of the rows above, one row per component in the catalog. Opening the Store
also asks for a check.

**Restart head unit** opens a confirm step, *Restart head unit?*, with
**Cancel** (focused first) and **Restart**. Restart asks the updater to
restart the head unit through the Node State Manager (its `reboot`
request). The row is hidden
while an install runs or waits, while the updater is unreachable or
already restarting the unit, and with an updater older than 0.1.4.

An app installs or updates in place when the running MainApp can do it:
only that app stops and starts. Otherwise the installer restarts MainApp's
app processes, the Store included (deploy/README.md, "In place"). When the
Store closes this way, or is the app being updated, the updater carries
on, and the Store shows the result when it is opened again.

## Layout

```
mgu-app.json               the source package's manifest: tree, modules, oap-sdk names
src/store.js               the app (bundle module 10000)
src/store_view.js          its texts from the updater's state (10001)
lib/client.js              mgu-updater's socket client (10002), copied by tools/build.js
tools/gen_rhmi.js          application.xml + uiDescription.json from one table
tools/build.js             RHMI, lib/client.js, the source package, and given a donor the OAP tgz
tools/test_view.js         the texts for every row state, offline
tools/make_icon.py         the 140x140 tile icon
robertn_store@0.3.2/       staged package tree (no javascript/app.js)
```

## Build

```sh
cd apps/robertn_store
node tools/build.js && node tools/test_view.js     # robertn_store@0.3.2.src.tgz
node tools/build.js --sdk <donor .tgz|.js>         # and robertn_store@0.3.2.tgz (MGU_SDK_DONOR)
```

The published artifact is the source package: `mgu-app.json`, the modules
and the staged tree. The deploy tool on the unit links it against the
oap-sdk of an app already there and installs the result
(deploy/README.md, "Source packages"); the folder itself is that package,
so a source following a branch builds it straight from a checkout
(`mgu-repo.json`). With a donor on the build machine (an OAP app's tgz or
`javascript/app.js`, never committed) the build writes the same OAP tgz
the unit builds, for the emulator: the modules linked against the donor's
oap-sdk modules with its module ids, `node --check`, `javascript/build.json`.
`lib/client.js` is committed: run the build after
`native/mgu-updater/js/client.js` changes and commit the copy.
