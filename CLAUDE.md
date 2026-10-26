# mgu-store

The Store, updater, deploy tool and network driver for the owner's iDrive 7
(MGU) head unit. Owner-authorised; development runs with full privileges on
the owner's hardware.

- No BMW SDK or firmware-derived files in this repository. App bundles link
  the oap-sdk from a donor bundle found on the unit (or one the builder
  names on the build machine); never commit a built `javascript/app.js`.
- Everything on the car happens through the Store's UI or its updates: never
  hand the owner SSH, shell steps or files to place.
- Test in the emulator (the head-unit emulator) before calling
  anything done.
- Describe the final state in comments and docs (no "changed from" /
  "previously"), build the smallest thing that solves the problem, and don't
  add UI helper text that restates a label.
