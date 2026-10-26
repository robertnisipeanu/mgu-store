# app-privacy integration contract

Both channels that install our apps on the head unit follow these rules:
the deploy tool (`deploy/`, run over SSH from the owner's computer,
installed as `/var/opt/mgu-deploy/mgu-deploy.sh`) and the updater
(`native/mgu-updater`, also behind the Store), which installs through the
deploy tool. They keep our apps out of oap-mainapp's backend
reporting with no per-app bookkeeping.

## 1. Our apps are marked at build time

An app is ours when the `package.json` inside its tgz has
`"mguLocalOnly": true`. `tools/oap_pack.js`, which every app build in this
repository packs with (on the build machine and, for a source package, on
the unit), stamps it into the staged tree before packing, and
`release/release.js` refuses to publish an app without it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "package.json of one of our OAP apps (the fields this contract adds)",
  "type": "object",
  "required": ["name", "mguLocalOnly"],
  "properties": {
    "name": { "type": "string", "description": "appId; also the registry entry <appId>.json" },
    "mguLocalOnly": { "const": true }
  }
}
```

An installer refuses an app tgz whose `package.json` lacks
`"mguLocalOnly": true` (deploy tool: exit 2, refused by preflight). An
unmarked build would be reported like a genuine app.

## 2. The patch is in effect before MainApp sees the app

Before MainApp first sees an app (before any of the app's files are placed
on the unit, it is made installable, or any MainApp bounce):

```sh
/usr/bin/node /var/opt/app-privacy/current/patch_mainapp.js apply --json
```

- Exit 0: patched. The last non-empty stdout line is one JSON object;
  `changed` is `true` when this call wrote the bundles, and
  `restartNeeded` is `true` while a running MainApp started before the
  bundles were last written (by this call or an earlier one). If either
  is true and MainApp is running, bounce MainApp's node child (kill it;
  `oapcontroller` respawns it) before placing the app. Never stop or
  restart `oapcontroller`.
- Exit 2: refused (the bundles do not match the patch; nothing written).
  Refuse the app install.
- Any other exit, or no tool at that path: refuse the app install. The
  component is installed before any app (the installers install tools
  first, `app-privacy` first of all).

`apply` is idempotent (`changed:false` when already patched). It remounts
`/` read-write only when a bundle it must write is on the read-only root
filesystem, and remounts it read-only before it returns (exit 1 if that
remount fails). When it finds `/` read-write it leaves it read-write and
does not remount. A file bind-mounted over a
bundle path is written in place, through the mount.

Then place the app's tgz in `/usr/lib/oap-mainapp/preinstalled_apps/`
(named `<appId>@<version>.tgz`) before MainApp can first try to install
it: before the app becomes installable (provisioned, or listed by a
provisioning fallback) and before the bounce that loads such a list.
Until MainApp has registered the app, that package is how the patched
MainApp knows the app is ours; an install attempt with no package in
place queries the app repository with the VIN.

Uninstall needs no app-privacy step.

## 3. The patch stays applied

The `app-privacy` tool component (`component.json`) installs
`app-privacy.service`: `Type=oneshot`, `RemainAfterExit=yes`,
`Before=oapcontroller.service`, `WantedBy=multi-user.target`, running
`patch_mainapp.js boot` (apply; always exit 0), listed in recmgr
`[Whitelist]` and `[WhitelistExitSuccess]` as `app-privacy`. A head-unit
software update replaces both bundles; the next boot patches them again
before MainApp starts. The component is installed before any app in a kit.

Installing or updating the component leaves `app-privacy.service` alone
(`restart` is empty): the installer's `apply --json` below writes the new
release's patch, and the unit runs the new release from the next boot on.
`apply` and `boot` replace an earlier release's edits with the current
release's, so an update needs no `revert` first. After installing or
updating the component, the installer runs `apply --json` and bounces
MainApp's node child when `changed` or `restartNeeded` is true (§2).
Removing the component is refused while any of our apps is installed;
otherwise it runs `revert` first, which also removes an earlier release's
edits, then bounces MainApp the same way.

`/etc` is on the root filesystem. A software update that rewrites the
whole root filesystem removes `app-privacy.service` and its recmgr entries
with the rest of our root tooling; MainApp then reports our installed apps
until the component is installed again.

## 4. Other changes to MainApp's bundles

The patch edits only its own anchors and `revert` removes only its own
edits, so it composes with other anchor-based patches that leave those
anchors alone and do not name `isLocalOnlyApp` (`check` reports `mismatch`
and names the anchor or the stray occurrence otherwise).

- A component that bind-mounts its own copy of a bundle at boot orders its
  unit `Before=app-privacy.service`; the boot apply then patches through
  the mount into that copy.
- Whenever a component builds or rebuilds such a copy outside boot, it runs
  `patch_mainapp.js apply --main <copy>` (or `--appmanagement <copy>`) on
  the copy after its own edit, before binding it and bouncing MainApp.
  The bundle not named keeps its default path and is checked and patched
  in the same call; a mismatch in either refuses both.
- Whenever a component changes which file is mounted at a bundle path
  (bind, unbind, restore), it runs `apply` once more afterwards.

## 5. State for the Store

`patch_mainapp.js check --json` prints
`{"version","command":"check","state":"patched"|"unpatched"|"mismatch","changed":false,"files":[{"kind","path","sha256","reference","state","patchedBy","problems"}],"restartNeeded"}`
and exits 0 / 1 / 2 for the three states. The patch is in effect when
`state` is `patched` and `restartNeeded` is false. A file's `patchedBy`
names the earlier release whose edits it carries (`state` `unpatched`
until `apply` replaces them). `--version` prints `app-privacy <version>`.

## 6. Manual override

`/var/opt/public/oap/oap_12201/data/local-only-apps.json`, a JSON array of
appIds, marks an app installed from a build without the marker. Installers
neither read nor write it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
  "uniqueItems": true
}
```
