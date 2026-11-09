# Simplified Chinese screenshots

The `*.zh-CN.png` images use the Store's drawn screens, Chinese translations
and fonts, with the sample updater state from
`apps/robertn_store/tools/fixture.js`. They are rendered by
`mgu-render --replay` with Mesa, not photographed on a head unit.
App names and descriptions supplied in English by the fixture stay in
English. Its versions, sources and install states are examples, not the
current catalog or a record of a vehicle.

From the repository root, with Node.js, Docker and Make installed:

```sh
(cd native/mgu-render && make test)
STORE_LANGUAGE=CHINESISCH_SIMPLE node apps/robertn_store/tools/shots.js \
    /tmp/mgu-store-zh-shots store app-update installed settings pick
cp /tmp/mgu-store-zh-shots/id7-store.png docs/screenshots/store.zh-CN.png
cp /tmp/mgu-store-zh-shots/id7-app-update.png docs/screenshots/app.zh-CN.png
cp /tmp/mgu-store-zh-shots/id7-installed.png docs/screenshots/installed.zh-CN.png
cp /tmp/mgu-store-zh-shots/id7-settings.png docs/screenshots/settings.zh-CN.png
cp /tmp/mgu-store-zh-shots/id7-pick.png docs/screenshots/add-source.zh-CN.png
```

The tool also produces ID8 images. The Chinese README uses the ID7 page
box (1796 x 632). No SDK donor, SSH key or vehicle connection is needed.
