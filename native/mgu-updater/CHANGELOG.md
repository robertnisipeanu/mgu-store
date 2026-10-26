# Updater changelog

## 0.2.1

- Without `sources.json` the updater reads the built-in source alone and writes nothing, so the installers' `updater-sources` seeds the file whichever starts first. The first-start conversion of an mgu-apps updater's `updater.local.conf` `catalog` and `github-token` into sources is removed: units carry `sources.json` from the installers or from updater 0.2.0.
