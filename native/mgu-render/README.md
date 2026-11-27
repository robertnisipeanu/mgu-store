# mgu-render

The renderer for apps on the head unit: apps send draw commands (or pixels)
over a socket, and mgu-render draws them with OpenGL ES at the display's rate,
either on the app's own layer over the HMI or inside the app's own HMI page.

- **Every existing renderer app runs unchanged.** It speaks both protocols
  apps already use: upstream idrive7-apps' `kit/renderd` (car_vitals, gforce,
  doom, ...) and IterioDev's mgu-renderd (oap-cardash, oap-draggy,
  oap-dtcscan, ...). Their draws come out byte for byte as from each original.
  display-bridge's apps (DOOM, draw_gallery,
  display_bridge_demo) draw through it too ("display-bridge's apps").
- **Beside the other renderers.** Its own socket is
  `/run/mgu-render/render.sock` (the Store, `js/mgu_render_client.js`). The
  community socket `/run/mgu-renderd/renderd.sock` is a link to it while no
  other renderer is installed; with IterioDev's or upstream's renderer
  installed, that one has it ("Beside other renderers").
- **Its own protocol, mgu-render/1,** asked for in HELLO, adds the embed
  placement, pixel images written in regions (INDEX8 with a palette, for a game
  like DOOM), and state events. [PROTOCOL.md](PROTOCOL.md) describes all three.
- **Two placements**, chosen by the app:
  - `layer`: the app's own Winston surface on its own ivi layer, over the HMI
    (the originals' placement; every legacy app).
  - `embed`: inside the app's HMI page, on the page template
    `LT_State_A4A_WelcomeApp`, through the HMI's own compositor (`wayland-1`):
    the HMI's title bar, popups, camera, BACK and HOME behave as on any stock
    page (display-bridge's placement). An app that asks for it (`full`) gets
    the whole screen instead, with the HMI's strip and popups over it, on the
    whole-screen template its own page names; every other app keeps the page box.
- **Only the app in front shows**: a foreground gate reads the HMI's
  `RemoteHmiApplication` (iDrive 8: `RemoteHmiApplication2`) stack and the
  kernel's peer uid of each connection.
- **Touch** is IterioDev's divert of the display's touch PDUs to the app that
  claims the area, per unit from the configuration; the **iDrive controller**
  can be held for an app through the HMI's controller gate (upstream's GRAB).
- **Anything of the HMI's over an app** (a popup, its menu, the voice
  assistant, a screen opened from there) takes the focus from the app's
  states: the foreground gate reports the app covered, and touch and the
  controller are the HMI's until the focus comes back. An app whose picture
  stays as it was through 4 touches or controller turns in a row gets neither
  for 10 s (a layer app is taken off meanwhile).

It is a Store tool component (`component.json`, `mguProvides: renderer`,
optional): installed and updated by the updater like the other tools.

## Where it comes from

The sources come from both renderers this replaces:

| From | Parts |
|---|---|
| idrive7-apps `kit/renderd` (MIT, `LICENSE.mgu-renderd`) | `src/gfx.c` (GLES2 executor), the main loop, layer surfaces, `--replay`, the wire protocol |
| IterioDev's mgu-renderd | touch routing (`src/touch.c`), pictures (IMAGE, DROP_IMAGE, limits), the frame cap (FPS), video (VIDEO, DROP_VIDEO, op 19: frames from a player's file, YUV to RGB in the shader), the client's picture cache (`js/mgu_render_client.js`) |
| display-bridge | the embed placement (`src/embed.c`, `js/hmi_template.js`, `systemd/mgu-render-hmi.sh`), the foreground gate (`src/gate.c`, `js/foreground_gate.js`), yield surfaces |

The ivi protocol files (`protocol/*.xml`) are COVESA wayland-ivi-extension's,
MIT (DENSO CORPORATION, BMW Car IT GmbH, notice in each file). Nothing from the
firmware is in this folder: the page template is made on the unit, at install,
from the installed HmiMain3D.

## Install, files, units

`/var/opt/mgu-render/current/`: `mgu-render`, `mgu-render.conf`,
`foreground_gate.js`, `hmi_template.js`, `mgu-render-hmi.sh`,
`mgu_render_client.js` (for apps to copy), `LICENSE.mgu-renderd`.

- `mgu-render.socket` (sockets.target): `/run/mgu-render/render.sock`,
  0660, group `tm_oap_app`; once it listens, `mgu-render --share` links the
  community socket to it (below). The first app that connects starts
  `mgu-render.service` (root:mgu_wayland; waits for Winston's socket).
- The page template is made at install (the deploy tool's `postInstall`)
  from the installed HmiMain3D into `/var/opt/mgu-render/hmi/`.
  `/var/opt/mgu-render/status.json` says how it went: `template` (`ok`,
  `building`, `failed`), `reason`, and `problem` (`In-page drawing
  unavailable: <reason>`), which the Store shows on the Renderer's page.
- `mgu-render-hmi.service` (before `hmi.service`) mounts the template into
  the HMI's widgets. Embed is offered from the next HMI start: after the
  first install, the next head-unit start. `umount
  /mnt/dataro/data/hmi/bmw/widget` undoes it.
- After an update the deploy tool checks that the new version answers a
  client and keeps running; one that fails goes back to the version before.
- Drop-ins `/etc/systemd/system/display-bridge{.socket,.service,-hmi.service}.d/mgu-render.conf`:
  display-bridge's units stand down while mgu-render is installed ("display-bridge's apps").
- Logs: `journalctl -u mgu-render -u mgu-render-hmi`. `embed:` lines name
  the embed path (`zero-copy`, or `readback fallback (<why>)`). While
  `/run/mgu-render/stats-log` exists, each shown app's frames a second,
  render time and path are logged once a second (`stats <app>: ...`).

An update does not stop a running mgu-render (`keepRunning`): the new
version runs from its next start, usually the next head-unit start.

## The HMI and the page template

Two templates are made at install: `LT_State_A4A_WelcomeApp`, the page box
under the title bar, and `LT_State_A4A_StockExchange`, the whole screen,
for the apps whose own page names it. A HmiMain3D that lacks what the second
needs gets the first alone. They go into HmiMain3D's widgets before the HMI
starts, at every boot. After two boots in a row that mounted it and ended in an HMI failure,
it is no longer mounted: the HMI starts with its stock widgets, apps that
ask for the embed placement get their layer, and `status.json` gets
`"hmi": "failed"` with the `problem` `In-page drawing unavailable: the HMI
failed with the page template`. A firmware update, or a template that comes
out different, starts the count again.

## Embed buffers

An embed app's frames reach the HMI's compositor one of two ways, decided when mgu-render connects to it:

- **zero-copy**: drawn straight into GPU buffers the compositor shows (`wl_drm` PRIME dmabufs). Needs `wl_drm` v2
  with PRIME and XRGB8888 on the compositor and dmabuf import in mgu-render's own EGL.
- **readback**: drawn into an offscreen FBO and read into the compositor's shared memory (`wl_shm`). Used when
  anything zero-copy needs is missing, with `embed_zero_copy = 0`, and once the compositor refused the GPU buffers,
  until mgu-render restarts.

Both give the same picture. The journal names the path (`embed: zero-copy` or `embed: readback fallback (<why>)`);
apps see it in X_READY's caps (32) and STATS' fourth word.

## display-bridge's apps

display-bridge draws DOOM, draw_gallery and display_bridge_demo in
their pages with the same page template and ivi id `0x500` on the HMI's
compositor. With mgu-render installed, mgu-render is the one embed provider
and serves those apps, unchanged.

- **Socket.** display-bridge's `/dev/shm/display-bridge/bridge.sock`
  (`bridge_path`) is a link to ours, made as the community one is (`src/share.c`)
  but with no other renderer to yield to: anything listening there is left
  alone, a socket nobody listens on is replaced.
- **display-bridge stands down.** The drop-in `mgu-render.conf` on
  `display-bridge.socket`, `display-bridge.service` and
  `display-bridge-hmi.service` (`ConditionPathExists=!/var/opt/mgu-render/current/mgu-render`)
  keeps an installed display-bridge from starting, from the next head-unit
  start: its socket path is free for the link, its template is not mounted
  beside ours, its foreground gate does not run beside ours. Uninstalling
  mgu-render removes the drop-ins, and display-bridge runs again from the
  next start.
- **Protocol.** A connection whose first four bytes are DBR1's magic speaks
  display-bridge's protocol (`src/dbr.h`, version 2). HELLO's frame (INDEX8 with
  PALETTE, XRGB8888, premultiplied ARGB8888, RGBA8888; up to 1920×720, as
  display-bridge)
  is kept as FRAME and RECTS write it, and shown in the HMI page's box,
  fitted and centred with black around it as display-bridge places it, with
  READY's `hmi` flag and that rectangle: written into the compositor's
  shared memory, or, with zero-copy, uploaded at the app's own size and scaled into its GPU buffer by GL ("Embed buffers").
  Without the page template (the first start after an install) it goes on
  the app's own layer as a pixmap, fitted into the app area. SHOW and HIDE are
  the app's wish; it shows only while the foreground gate reports it in front.
- **Pacing.** READY offers 3 frames in flight. A newer frame replaces one
  not yet committed (DROPPED); a committed one is PRESENTED on the
  compositor's frame callback.
- **Touch.** The picture is the app's claim: a touch that starts there comes
  as TOUCH (down, motion, up) in frame pixels, source `evdev`, and the HMI does
  not get it.

## Beside other renderers

IterioDev's mgu-renderd (`mgu-renderd.service`, from IterioDev's App Manager or as a
service package through the Store) and upstream idrive7-apps' renderer
(`mgu-renderd.service` from its installer, or the tool `idrive7-renderd`
from its repository through the Store, `idrive7-renderd.service`) can be
installed with mgu-render. Each serves its own apps; nothing is replaced. A
tool that needs a renderer (upstream's controller gate) is satisfied by any.

**Sockets.** Ours is `/run/mgu-render/render.sock`. The community socket
`/run/mgu-renderd/renderd.sock` is ours exactly when it is a symlink to our
socket; anything else there is another renderer's and is never removed.
mgu-render links it only while no other renderer's unit file
(`/etc/systemd/system/mgu-renderd.service`,
`/run/systemd/system/mgu-renderd.service`,
`/etc/systemd/system/idrive7-renderd.service`) is installed, removes its link
within 2 s of one being installed, and links it again once that renderer is
removed. Through the link, socket activation works for community apps too.
An idrive7-apps kit app that reached our socket because the community
renderer was restarting is sent back to it once it listens again.

**ivi ids.** Our layer apps use layer `0x4d520000 + slot` and surface
`0x4d520100 + slot` ("MR"); the community renderers use `0x4d470000` and
`0x4d470100` ("MG") on the same compositor, so two apps in slot 0 never share
an id. The embed surface `0x500` is on the HMI's own compositor (`wayland-1`),
which neither community renderer connects to.

**The screen's layer list.** Other programs' layers stay on the centre
screen when ours is added, and a layer of ours another program drops is put
back on top.

**Touch.** IterioDev's renderer diverts the display's touch with its own
table (`ip touchroute`, ports 30568 in, 30569 out); ours has `ip mgu_render`
and ports 30570 in, 30571 out, so neither removes the other's rule or takes
its ports. Each diverts only while one of its own apps is shown with claims:
ours only while one of its apps is in front (the foreground gate),
IterioDev's while its app shows its screen. Neither leaves its rule behind
when its renderer dies or hangs. Upstream's renderer has no divert.

**Controller.** Upstream's controller gate (`mgu-inputgate.so`) talks to one
renderer: the file `/run/mgu-renderd/inputgate` and the event socket
`@mgu-renderd-ccu`, which upstream's renderer binds at its start. mgu-render
binds that socket only while one of its apps holds GRAB, and touches the file
only while the socket is its own; bound by upstream's renderer, our apps go
without the gate: X_READY offers `controller` only while the socket is ours
or free, so they read FrontCCU themselves. A stale file releases the
controller after 0.7 s by the gate's own rule, so a killed renderer holds
nothing.

## Settings

`mgu-render.conf` lists every key with its default; `-s key=value` overrides.
A unit's own settings go in `local_conf` (`/var/opt/mgu-render/mgu-render.local.conf`,
same format), read last, which updates keep. A bad line there is logged and
skipped. The unit-specific ones:

| Key | iDrive 7 | iDrive 8 |
|---|---|---|
| screen, app area | read from Winston's output: 1920×720, area 108,82,1790,638 | 2880×960, area 0,76,2880,764 |
| `touch_iface`, `touch_saddr` | `vlan73`, `160.48.199.115` (`auto`: `lo` when there is no vlan73) | same |
| `touch_area` | 0,0,1920,720 (`auto` by screen size) | 0,76,2880,764 |
| `embed`, `embed_area` | 1, 104,88,1796,632 | never offered: no HmiMain3D, so no template is loaded |
| `embed_zero_copy`, `tick_early`, `readback_pbo`, `embed_finish` | 1, 1, 1, 0 (embed: "Embed buffers") | same |
| `fps`, `fps.<app>` | 0: an app that asks for a rate (the Store: 60) gets it; N: N frames a second in its place, for every such app or one (`fps.robertn_store = 30`) | same |
| `foreground_gate`, `hmi_process` | node + `foreground_gate.js`, `HmiMain3D` | the gate reads `RemoteHmiApplication2` from `oap-mainapp21` |

### On the car

Values marked `on-car` in `mgu-render.conf` (the reversing camera's
surface in `yield_surfaces`, `touch_saddr`, `touch_area`) are ones only a
car can confirm. Set another value in `local_conf` when a unit differs.

## Apps

New apps use `js/mgu_render_client.js` (Node 8, net/fs/events only):

```js
const { RenderClient, imageOp } = require('./mgu_render_client');
const gpu = new RenderClient('my_app', log, { mode: 'embed', kit: require('./record') });
gpu.on('ready', (screen, info) => {
    if (!info) { /* an older renderer: draw in software */ return; }
    if (info.modes.indexOf('embed') < 0) gpu.mode('layer');
    const box = gpu.mode() === 'embed' ? info.embedBox : info.appArea;
    // the whole screen, on a page that names the whole-screen template:
    //   gpu.mode(info.modes.indexOf('full') >= 0 ? 'full' : 'layer'), box info.fullBox
    gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, ox: 0, oy: 0 });
    gpu.show(true);
});
gpu.fps(30);                                        // optional: at most 30 frames a second
gpu.on('tick', () => gpu.frame(recorder));          // kit Recorder, or gpu.frameWords(ops)
gpu.on('state', (s) => { /* { mode, onScreen, front } */ });
gpu.on('touch', (phase, x, y) => { /* in claimed areas: gpu.claim([...]) */ });
// gpu.fingers(true): every finger instead, as gpu.on('finger', (phase, id, x, y) => ...) (info.fingers);
//   phase 'cancel': the finger is gone without a lift seen, drop it (not a tap)
gpu.connect();
```

A page for embed mode names the template as its state's widget:

```xml
<container id="1" type="state" widget="LT_State_A4A_WelcomeApp">
    <layoutGroup id="100" name="Titlebar"><component id="10" type="title"/></layoutGroup>
</container>
```

A page for the whole screen (`full`) names `LT_State_A4A_StockExchange` instead.
The HMI's strip stays over the top 88 px and its `<` arrow over the left 104:
leave what of them should stay the HMI's unclaimed.

Pixel apps: `gpu.pixmap(1, 320, 200, 'index8', 'nearest')`, `gpu.palette(1,
rgb768)`, `gpu.pixels(1, rects, indices)` for what changed, and
`imageOp(1, x, y, w, h)` in each frame (`test/pixel_client.js`).

Video (`info.video`): a player process writes decoded frames (I420, or NV12
where `info.videoNv12` is set: the header's format word 1) to
`/dev/shm/mgu-video-<name>` (PROTOCOL.md, "Video"); the app names the file
with `gpu.video(1, '/dev/shm/mgu-video-<name>')` and puts
`videoOp(1, x, y, w, h, r)` in its frames. Each new video frame draws the
app's last frame again; the app still sends at least one message a second
while it is shown (`gpu.alive()` will do), since an app silent for 3 s is
taken for hung and hidden. The frame file must be the app's (its uid), or a
system player's (root, or `nobody`). IterioDev's YouTube app
(IterioDev/car-apps, with its player mgu-ytplay) uses it through IterioDev's
kit.

The controller: read FrontCCU over SOME/IP in the app (display-bridge's
`display_input.js` does) and keep the page's hidden focusable components for
the HMI's own focus and BACK; `gpu.grab(true)` holds the dial back from the
HMI only where the HMI's controller gate is loaded (`info.controller`).
`gpu.grab(true, ['knob', 'press'])` holds only those parts (`'knob'`,
`'press'`, `'tilt'`) where the gate can (`info.controllerHold`); the HMI
keeps the rest. Elsewhere it holds all three.

## Build and test

| Command | What |
|---|---|
| `make target` | `build/target/mgu-render`: x86-64, glibc 2.27, loader `/lib/ld-linux-x86-64.so.2`, built in Ubuntu 18.04 (Docker, linux/amd64) |
| `make check-target` | the binary's architecture, loader, libraries (`libwayland-client`, `libwayland-egl`, `libEGL`, `libGLESv2`, libc, libm, libdl) and glibc versions |
| `make test` | in Ubuntu 24.04 with Mesa's llvmpipe (Docker): the C tests, the page-template script's tests, and every recorded session in `test/sessions/` replayed through the original daemons (`test/reference/`) and mgu-render, every frame compared byte for byte |
| `deploy/hu install mgu-render` | build and install on a unit (deploy/README.md) |

`mgu-render --replay FILE --out F.pam [--raw F.rgba]` draws a recorded
stream offscreen. `record_dir` in the conf records each connection.
