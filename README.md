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
| [`release`](release) | versions, reproducible builds, the signed catalog |
| [`tools/oap_pack.js`](tools/oap_pack.js) | the flat, reproducible OAP tgz |
