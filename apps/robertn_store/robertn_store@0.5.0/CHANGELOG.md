# Changelog

## 0.5.0

The package ships no entry point of its own: the build supplies
`javascript/runner.js` from the SDK donor's package, so the Store needs
mgu-deploy 0.2.3 or later to build on the head unit.

## 0.4.1

With no updater to reach and none run since the Store was installed (no
secret in its data folder: the state the install kit leaves until the head
unit's next start), the status line reads `Restart the head unit to finish
setup`; `Updater not running` once the updater has run.

## 0.4.0

The Store lists the components of every source the updater reads. Sources
lists each source with its status; a source's page shows its channel,
account and component count, signs in with GitHub (a QR code of the
sign-in page with the code beside it) and removes the source after a
confirm step. Add source opens the HMI's speller for owner/repo or an https
address; a GitHub repo then gets its channel: Releases, Tags or Branch.
Phone access turns the updater's phone page on or off and shows its access
URL, which the updater leaves in the app's data folder, as a QR code. A
component the catalog marks `uninstallable` is removed from its row after a
confirm step. Privileged
requests carry the secret the updater leaves in the app's data folder. A
branch's new commit at the same version shows as `Update <revision>`, and a
build on the unit as `Building`.

## 0.3.2

Restart head unit on the start screen restarts the head unit through the
Node State Manager, by mgu-updater (0.1.4 or later), after a confirm step.
The status line no longer says apps restart while an app installs.

## 0.3.1

The Apps and Head-unit tools lists show every component of the catalog,
however many there are.

## 0.3.0

The start screen has the status line, Check for updates and the running
install's progress; Apps and Head-unit tools each open their own list.

## 0.2.0

The app's id is `robertn_store`: the car's own provisioning has a section
named `store` that does not allow it.

## 0.1.2

A row with an update or install available shows it even while a restart
is pending.

## 0.1.1

A row shows "Checking" while the updater checks a newly installed
head-unit tool.

## 0.1.0

The Store: one row per app and head-unit tool in the published catalog, with
its state (installed version, update available, not installed) and the
progress of the running install. Pressing a row installs or updates it
through mgu-updater (native/mgu-updater), which does the download and the
install; the app only shows its state and sends the request.
