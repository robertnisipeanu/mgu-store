# Updater changelog

## 0.2.2

- An installed component shows an update when any source, a USB stick included, lists a higher version. Among equal versions the source that installed it is preferred, then a stick, then `sources.json` order; the installing source becomes its origin.
- An updater or uplink installed from a stick while the unit is offline is kept: its check passes when the deploy tool answers, without the catalog.

## 0.2.1

- Without `sources.json` the updater reads the built-in source alone and writes nothing, so the installers' `updater-sources` seeds the file whichever starts first. The first-start conversion of an earlier updater's `updater.local.conf` `catalog` and `github-token` into sources is removed: units carry `sources.json` from the installers or from updater 0.2.0.
