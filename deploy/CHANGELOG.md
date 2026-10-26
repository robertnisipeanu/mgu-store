# Deploy tool changelog

## 0.3.1

- `mgu-install.js first-install` puts on the renderer (`mgu-render`) and the internet uplink (`mgu-uplink`) too; `--no-renderer` and `--no-uplink` leave them out, and one the catalog does not list is skipped, saying so.

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
