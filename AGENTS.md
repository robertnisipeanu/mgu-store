# mgu-store

The Store, updater, deploy tool and network driver for the owner's iDrive 7
(MGU) head unit. Owner-authorised; development runs with full privileges on
the owner's hardware.

- No BMW SDK or firmware-derived files in this repository. App bundles link
  the oap-sdk from a donor bundle found on the unit (or one the builder
  names on the build machine); never commit a built `javascript/app.js`.
- Everything on the car happens through the Store's UI or its updates: never
  hand the owner SSH, shell steps or files to place.
- Describe the final state in comments and docs (no "changed from" /
  "previously"), build the smallest thing that solves the problem, and don't
  add UI helper text that restates a label.

## Updates must work in any order

Cars update each component on its own, in whatever order the owner taps,
and a broken Store or updater can only be repaired through the Store. So
every release has to be safe whichever component is updated first:

- A component that needs a newer version of another declares it in
  `requires` (its `component.json`, or the app's `release.json`). The
  updater installs requirements first, its own update included, and
  `release.js publish` publishes nothing while the catalog would list a
  component whose requirements it doesn't hold.
- Otherwise a new version keeps working with the published versions of the
  components it talks to (the Store with the updater, the updater with the
  deploy tool and the uplink, apps with the renderer): keep old requests,
  files and options working, or require the newer partner.
- When a change touches the Store and one of its dependencies (updater,
  deploy tool, renderer, uplink, Python) in ways that depend on each other,
  test it on a head unit before publishing: start from the published
  release, publish every component of the
  branch to a folder from a scratch checkout of it (`MGU_RELEASE_LABELS=off
  node release/release.js stamp`, so the changed components carry
  their next versions and every `"next"` is resolved, then
  `MGU_PUBLISH=dir:<folder> node release/release.js publish` there), give the unit that
  folder as a USB stick, and update ONLY
  the changed component from it in the Store (its requirements come along).
  Restart when asked, and check that the updater runs, the Store opens with
  its tile, and it can still update the rest. Repeat for each changed
  component, each time from the published release. (`deploy/hu install`
  also installs the branch's deploy tool, so it can't test an order.)
