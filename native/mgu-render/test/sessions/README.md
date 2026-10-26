# Recorded sessions

Client-to-daemon message streams (u32 type, u32 length, payload), gzipped, as each kit's
`RenderClient` file sink writes them. `test/replay.sh` replays them through the original daemon
of their dialect and through mgu-render.

| File | Kit | How |
|---|---|---|
| `upstream/car_vitals.bin.gz` | idrive7-apps 7829757, car_vitals 2.12.2 | `kit/tools/build.py car_vitals`, then `node kit/tools/preview.js dist/car_vitals out frames=60 --gpu car_vitals.bin` (62 frames: fonts, ramps, layers) |
| `upstream/gforce.bin.gz` | same, gforce 1.4.1 | as above (62 frames) |
| `upstream/doom.bin.gz` | same, doom 1.4.1 on Freedoom 0.13 E1M1 | `preview.js dist/doom out BTN_PLAY wait=1 frames=8 --set detail=low --gpu doom.bin`, with preview's ctx given mgu.js's controller object so GRAB reaches the stream: 8 frames, IMAGE (9) ×11, GRAB (10) ×7 |
| `iterio/scene.bin.gz`, `bad-*.bin.gz`, `over-count.bin.gz` | IterioDev hmi-ui-builder | `node test_images.js --streams DIR`: pictures, malformed IMAGE messages, 65 pictures |
| `iterio/screen-car-data-sketches-A_dash.bin.gz` | IterioDev hmi-ui-builder `screenapp.js` + kit `renderd.js` | the builder's car-data-sketches project, screen A_dash, view id7, 60 frames, with one generated picture: CLAIM (9), IMAGE (10) |
| `iterio/screen-drag-timer-home.bin.gz` | same | drag-timer project, screen home, 30 frames: CLAIM |

The builder's streams use the upstream kit's Ubuntu font atlases; none carries data baked from the
HMI's fonts or icons.
