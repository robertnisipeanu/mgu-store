# mgu-store

The Store for the BMW iDrive 7 (MGU) head unit: an on-screen app store, the
updater daemon behind it, the on-unit deploy tool every install goes through,
and an opt-in network driver that gives apps internet through a USB adapter
or a tethered phone.

| Path | What |
|---|---|
| [`apps/robertn_store`](apps/robertn_store) | the Store app (OAP/RHMI) |
| [`native/mgu-updater`](native/mgu-updater) | the updater daemon: sources, downloads, installs |
| [`deploy`](deploy) | the deploy tool (`mgu-deploy`) and the Mac-side installer |
| [`native/mgu-uplink`](native/mgu-uplink) | the network driver (opt-in) |
| [`native/app-privacy`](native/app-privacy) | keeps installed apps out of the unit's backend app reporting |
| [`release`](release) | versions, reproducible builds, the catalog |
| [`tools/oap_link.js`](tools/oap_link.js) | builds an app from its source package against the oap-sdk of an app on the unit |
| [`tools/oap_pack.js`](tools/oap_pack.js) | the flat, reproducible OAP tgz |
| [`docs/PUBLISHING.md`](docs/PUBLISHING.md) | publishing apps for the Store from any repository |
| [`mgu-repo.json`](mgu-repo.json) | this repository as a source the unit builds from (the Store app) |

No file of BMW's oap-sdk is in this repository: the Store is published as
a source package, and the deploy tool links it on the unit against the
oap-sdk of an app already there.

## Install

Once, from a USB stick. On a Mac with this repository:

```sh
deploy/hu kit --updater-token-file <token file> [--with-uplink]
```

writes `deploy/out/kit/`; copy it to a stick. On the unit, as root:

```sh
sh /path/to/kit/install.sh [--with-uplink]
```

It installs the deploy tool, app-privacy, the updater, the Store (built on
the unit) and, with `--with-uplink`, the internet uplink; it seeds the
updater's sources with this repository and writes its token. The updater
(and the uplink) start at the head unit's next start, so its last line is
`Restart the head unit to finish setup`; the next ignition cycle does it,
and until then the Store's status line says the same. Running it again is
safe. `deploy/hu install --updater-token-file <file>` does the
same over SSH. After that every update, and every other source, comes
through the Store. deploy/README.md ("The install kit") has the details.

