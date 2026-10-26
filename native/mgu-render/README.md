# mgu-render

The renderer for apps on the head unit: apps send draw commands (or pixels)
over a socket, and mgu-render draws them with OpenGL ES at the display's rate,
either on the app's own layer over the HMI or inside the app's own HMI page.

- **Every existing renderer app runs unchanged.** It serves the socket
  `/run/mgu-renderd/renderd.sock` in both protocols apps already use: upstream
  idrive7-apps' `kit/renderd` (car_vitals, gforce, doom, ...) and IterioDev's
  mgu-renderd (oap-cardash, oap-draggy, oap-dtcscan, ...). Their draws come out
  byte for byte as from each original (`make test`).
- **Its own protocol, mgu-render/1,** asked for in HELLO, adds the embed
  placement, pixel images written in regions (INDEX8 with a palette, for a game
  like DOOM), and state events. [PROTOCOL.md](PROTOCOL.md) describes all three.
- **Two placements**, chosen by the app:
  - `layer`: the app's own Winston surface on its own ivi layer, over the HMI
    (the originals' placement; every legacy app).
  - `embed`: inside the app's HMI page, on the page template
    `LT_State_A4A_WelcomeApp`, through the HMI's own compositor (`wayland-1`):
    the HMI's title bar, popups, camera, BACK and HOME behave as on any stock
    page (display-bridge's placement).
- **Only the app in front shows**: a foreground gate reads the HMI's
  `RemoteHmiApplication` stack and the kernel's peer uid of each connection.
- **Touch** is IterioDev's divert of the display's touch PDUs to the app that
  claims the area, per unit from the configuration; the **iDrive controller**
  can be held for an app through the HMI's controller gate (upstream's GRAB).

It is a Store tool component (`component.json`, `mguProvides: renderer`,
optional): installed and updated by the updater like the other tools.

## How it is built

```
app (Node 8)                      mgu-render (root:mgu_wayland)                         compositors
--------------                    ------------------------------                        -----------
kit renderd.js / record.js  ---> dialect.c: upstream | iterio | native per connection
mgu_render_client.js             gfx.c: GLES2, one shader, analytic AA, cached layers,  layer: EGL window on
  FRAME (draw ops), IMAGE,         glyph atlases, ramps, pictures, pixmaps                Winston (wayland-0), own
  pixmap regions, CLAIM, GRAB    layer  -> eglSwapBuffers on the app's ivi surface       ivi layer per app
                           <---  TICK when the compositor took the frame               embed: FBO -> readback ->
                           <---  TOUCH / CLOSED (touch.c, nft divert of UDP 30567)        wl_shm on HmiMain3D's
                           <---  X_STATE, CCU                                              compositor (wayland-1)
foreground_gate.js (child, root:root) -> which uids are in front
mgu-render-hmi.sh (before hmi.service) -> page template mounted into the HMI's widgets
```

The sources come from both renderers this replaces:

| From | Parts |
|---|---|
| idrive7-apps `kit/renderd` (MIT, `LICENSE.mgu-renderd`) | `src/gfx.c` (GLES2 executor), the main loop, layer surfaces, `--replay`, the wire protocol |
| IterioDev's mgu-renderd (ported with permission) | touch routing (`src/touch.c`), pictures (IMAGE, DROP_IMAGE, limits), the client's picture cache (`js/mgu_render_client.js`) |
| display-bridge (mgu-apps) | the embed placement (`src/embed.c`, `js/hmi_template.js`, `systemd/mgu-render-hmi.sh`), the foreground gate (`src/gate.c`, `js/foreground_gate.js`), yield surfaces |

The ivi protocol files (`protocol/*.xml`) are COVESA wayland-ivi-extension's,
MIT (DENSO CORPORATION, BMW Car IT GmbH, notice in each file). Nothing from the
firmware is in this folder: the page template is made on the unit, at boot,
from the installed HmiMain3D.

## Install, files, units

`/var/opt/mgu-render/current/`: `mgu-render`, `mgu-render.conf`,
`foreground_gate.js`, `hmi_template.js`, `mgu-render-hmi.sh`,
`mgu_render_client.js` (for apps to copy), `LICENSE.mgu-renderd`.

- `mgu-render.socket` (sockets.target): `/run/mgu-renderd/renderd.sock`,
  0660, group `tm_oap_app`. The first app that connects starts
  `mgu-render.service` (root:mgu_wayland; waits for Winston's socket).
- `mgu-render-hmi.service` (before `hmi.service`): generates the page
  template from the installed HmiMain3D (again whenever that binary changes),
  mounts a tmpfs copy of `bmw/widget/` with it over the original, and writes
  `/run/mgu-render/hmi-template`. Embed is offered from the next HMI start:
  after the first install, the next head-unit start. Any failure leaves the
  stock widgets; `umount /mnt/dataro/data/hmi/bmw/widget` undoes it.
- Logs: `journalctl -u mgu-render -u mgu-render-hmi`.

Only one renderer may own the socket: the Store installs one provider of
`renderer` at a time. display-bridge (mgu-apps) uses the same page template
and ivi id `0x500` for its own embed; the two are not run together.

## Settings

`mgu-render.conf` lists every key with its default; `-s key=value` overrides.
The unit-specific ones:

| Key | iDrive 7 | iDrive 8 |
|---|---|---|
| screen, app area | read from Winston's output: 1920×720, area 108,82,1790,638 | 2880×960, area 0,76,2880,764 |
| `touch_iface`, `touch_saddr` | `vlan73`, `160.48.199.115` (`auto`: `lo` when there is no vlan73, as in the emulator) | same |
| `touch_area` | 84,76,1836,644 (`auto` by screen size) | 0,76,2880,764 |
| `touch_finger_tag` | 8 (on-car) | 8 |
| `embed`, `embed_area` | 1, 104,88,1796,632 | never offered: no HmiMain3D, so no template is loaded |
| `foreground_gate`, `hmi_process` | node + `foreground_gate.js`, `HmiMain3D` | the gate reads ID7's oap-mainapp paths: on-car |

## Apps

New apps use `js/mgu_render_client.js` (Node 8, net/fs/events only):

```js
const { RenderClient, imageOp } = require('./mgu_render_client');
const gpu = new RenderClient('my_app', log, { mode: 'embed', kit: require('./record') });
gpu.on('ready', (screen, info) => {
    if (!info) { /* an older renderer: draw in software */ return; }
    if (info.modes.indexOf('embed') < 0) gpu.mode('layer');
    const box = gpu.mode() === 'embed' ? info.embedBox : info.appArea;
    gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, ox: 0, oy: 0 });
    gpu.show(true);
});
gpu.on('tick', () => gpu.frame(recorder));          // kit Recorder, or gpu.frameWords(ops)
gpu.on('state', (s) => { /* { mode, onScreen, front } */ });
gpu.on('touch', (phase, x, y) => { /* in claimed areas: gpu.claim([...]) */ });
gpu.connect();
```

A page for embed mode names the template as its state's widget:

```xml
<container id="1" type="state" widget="LT_State_A4A_WelcomeApp">
    <layoutGroup id="100" name="Titlebar"><component id="10" type="title"/></layoutGroup>
</container>
```

Pixel apps: `gpu.pixmap(1, 320, 200, 'index8', 'nearest')`, `gpu.palette(1,
rgb768)`, `gpu.pixels(1, rects, indices)` for what changed, and
`imageOp(1, x, y, w, h)` in each frame (`test/pixel_client.js`).

The controller: read FrontCCU over SOME/IP in the app (display-bridge's
`display_input.js` does) and keep the page's hidden focusable components for
the HMI's own focus and BACK; `gpu.grab(true)` holds the dial back from the
HMI only where the HMI's controller gate is loaded (`info.controller`).

## Build and test

| Command | What |
|---|---|
| `make target` | `build/target/mgu-render`: x86-64, glibc 2.27, loader `/lib/ld-linux-x86-64.so.2`, built in Ubuntu 18.04 (Docker, linux/amd64) |
| `make check-target` | the binary's architecture, loader, libraries (`libwayland-client`, `libwayland-egl`, `libEGL`, `libGLESv2`, libc, libm) and glibc versions |
| `make test` | in Ubuntu 24.04 with Mesa's llvmpipe (Docker): `test/test_dialect.c`, and `test/replay.sh`: every session in `test/sessions/` (recorded from upstream's and IterioDev's kits, `test/sessions/README.md`) and the synthetic ones (`test/gen_sessions.js`) replayed through the original daemons (`test/reference/`) and mgu-render, every frame compared byte for byte; native pixmaps compared with the same pictures sent as IterioDev pictures |
| `deploy/hu install mgu-render` | build and install on a unit or the emulator (deploy/README.md) |

`mgu-render --replay FILE --out F.pam [--raw F.rgba]` draws a recorded
stream offscreen. `record_dir` in the conf records each connection.

## On the car

Settled offline and in the emulator: both legacy protocols (frames identical
to the originals), native pixmaps, the embed and layer placements, the
foreground gate, the template service, socket activation and packaging. Only
the car can show:

**iDrive 7**
- [ ] Layer: an upstream app (car_vitals) draws at 60 fps under our unit (upstream measured 56-61 fps with its own); our layer's z-order over HMI popups and the camera, and the yield surface ids of the reversing camera.
- [ ] Embed: DOOM-style pixmap frames inside the page: presented rate (`fps` in `test/pixel_client.js`), and the readback cost at 1796×632 (STATS avg µs) on the HD 505.
- [ ] Embed: whether HmiMain3D's compositor offers `wl_drm`/`zwp_linux_dmabuf_v1` (`verbose = 1` logs its globals): an EGL surface there would skip the readback.
- [ ] Touch: finger PDUs on UDP 30567 from 160.48.199.115 on vlan73, payload byte 12 tag 8, the firewall accepting 30568 with the inserted rule; the claim area 84,76,1836,644.
- [ ] Touch in embed mode: a claimed area inside the page reaches the app and the HMI's hidden components under it do not react.
- [ ] The foreground gate as root:root (gid 0) under the unit's SOME/IP credentials.
- [ ] GRAB with upstream's `mgu-inputgate.so` loaded (installed separately).

**iDrive 8**
- [ ] Layer with IterioDev's apps unchanged (their packages are iDrive 8 only), screen 2880×960, the touch divert as with IterioDev's renderer.
- [ ] The foreground gate: `RemoteHmiApplication` and the uid → uuid path under `oap-mainapp21` (a gate that reads nothing there leaves legacy apps as they are without it).
- [ ] Embed: whether Hmi8 has an embedded compositor, an embedded-surface widget and loadable widget files (until then embed is not offered: no HmiMain3D).
