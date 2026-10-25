# robertn_store 0.4.0

The Store: every app and head-unit tool of every source, each with its
state, the progress of the running install, the sources and the phone page.
It is the screen of [mgu-updater](../../native/mgu-updater/README.md),
which does all the work; the app shows the state the updater streams over
its socket and sends it requests: check, install and reboot, and the
privileged ones (uninstall, source-remove, login-start, login-cancel,
web), which carry the secret the updater leaves in the app's data folder
(`data/updater-secret`, read again for every request).

| Row (`LT_Button_1Row_2Col7030_2Text`) | Press |
|---|---|
| `DOOM` · `Update 1.0.1` | update to the catalog version |
| `Display bridge demo` · `Install 1.0.0` | install |
| `Network driver` · `Install 0.2.0` | install (an optional component) |
| `Vehicle control` · `Installed 1.0.0` | nothing; *Remove?* when the catalog marks it `uninstallable` |
| `DOOM` · `42%` / `Verifying` / `Building` / `Installing` / `Removing` | nothing (in progress) |
| `Extended dashboard` · `Waiting` | nothing (queued) |
| `Display bridge` · `Restart pending` | nothing (installed; active after the next reboot) |
| `DOOM` · `Failed, retry` | try again (the status line names the error) |

The start screen has a status line (`1 update, checked 14:02`, `Offline`,
`Checking for updates`, `Restarting`, the last error, `Updater not
running`), a **Check for updates** button, a progress bar for the running
install (hidden when none runs), the rows **Apps** and **Head-unit tools**,
each showing its running install, `Failed` or its number of updates,
**Sources** (`Sign in` or `Error` when a source needs it), **Phone access**
(`On` / `Off`), and **Restart head unit**. Apps and Head-unit tools each
open their own list of the rows above, one row per component the updater
lists. Opening the Store also asks for a check. Sources and Phone access
are hidden with an updater that reports no `sources` or `web`.

**Remove?** names the component (`DOOM 1.0.1`) and has **Cancel** and
**Remove**, which asks the updater to uninstall it.

**Restart head unit** opens a confirm step, *Restart head unit?*, with
**Cancel** (focused first) and **Restart**. Restart asks the updater to
restart the head unit through the Node State Manager (its `reboot`
request). The row is hidden
while an install runs or waits, while the updater is unreachable or
already restarting the unit, and with an updater older than 0.1.4.

## Sources

**Sources** lists one row per source, its label and status: `OK`, `USB`
(a source on a plugged-in USB stick), `Checking`, `Sign in`, `Error`,
`Offline`; then **Add source**. A source's page shows its label and
status, **Account** (the signed-in GitHub login), **Components** (how many
it lists), its error, **Sign in with GitHub** (GitHub sources) and
**Remove** (with a confirm step, *Remove source?*; not for the Store's
own source or a USB source).

**Sign in with GitHub** starts the updater's GitHub device sign-in and opens
its page: the QR code of the sign-in page with the code drawn large beside
it, the code and the page's address as text, the status (`Waiting for
sign-in`, `Code expired`, `Sign-in failed: …`) and **Cancel**. The page
closes itself once signed in.

The head unit has no text entry, so a source is added on the phone page:
**Add source** opens **Phone access**. A USB stick holding a catalog or a
repo tree appears in the list by itself
([mgu-updater](../../native/mgu-updater/README.md)).

## Phone access

**Phone access** turns the updater's phone page on or off (`On` / `Off`)
and, while on, shows the QR code of the page's address with its access
token, the address as text, and the page's error. The address is the first
one the updater reports that is not the unit's loopback.

QR codes are written to `/dev/shm/robertn_store_qr_<uid>/` (0755, files
0644), where the HMI can read them, a new file per text, and removed when
replaced, when their page has nothing to show, and at start and shutdown.
Neither the sign-in code, the phone page's address nor the secret goes into
a log line.

An app installs or updates in place when the running MainApp can do it:
only that app stops and starts. Otherwise the installer restarts MainApp's
app processes, the Store included (deploy/README.md, "In place"). When the
Store closes this way, or is the app being updated, the updater carries
on, and the Store shows the result when it is opened again.

## Layout

```
src/store.js               the app (bundle module 10000)
src/store_view.js          its texts from the updater's state (10001)
src/qr.js                  QR code PNG with a caption (10003)
src/qrcodegen.js           Project Nayuki's QR Code generator 1.5.0 (10004, src/LICENSE-qrcodegen.txt)
tools/gen_rhmi.js          application.xml + uiDescription.json from one table
tools/build.js             RHMI, bundle (+ native/mgu-updater/js/client.js, 10002), node --check, build.json, tgz
tools/test_view.js         the texts for every row, source, sign-in and phone state, offline
tools/test_rhmi.js         the generated RHMI files' structure and the names src/store.js binds
tools/test_qr.js           the QR pictures (decoded back with zbarimg when installed)
tools/make_icon.py         the 140x140 tile icon
robertn_store@0.4.0/       staged package tree
```

## Build

```sh
cd apps/robertn_store
node tools/build.js && node tools/test_view.js && node tools/test_rhmi.js && node tools/test_qr.js
# robertn_store@0.4.0.tgz
```
