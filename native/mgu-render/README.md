# mgu-render

The renderer for apps on the head unit: apps send draw commands (or pixels)
over a socket, and mgu-render draws them with OpenGL ES at the display's rate,
either on the app's own layer over the HMI or inside the app's own HMI page.

- **Every existing renderer app runs unchanged.** It speaks both protocols
  apps already use: upstream idrive7-apps' `kit/renderd` (car_vitals, gforce,
  doom, ...) and IterioDev's mgu-renderd (oap-cardash, oap-draggy,
  oap-dtcscan, ...). Their draws come out byte for byte as from each original
  (`make test`). display-bridge's apps (mgu-apps DOOM, draw_gallery,
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
    page (display-bridge's placement).
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

## How it is built

```
app (Node 8)                      mgu-render (root:mgu_wayland)                         compositors
--------------                    ------------------------------                        -----------
kit renderd.js / record.js  ---> dialect.c: upstream | iterio | native per connection
mgu_render_client.js             gfx.c: GLES2, one shader, analytic AA, cached layers,  layer: EGL window on
  FRAME (draw ops), IMAGE,         glyph atlases, ramps, pictures, pixmaps                Winston (wayland-0), own
  pixmap regions, CLAIM, GRAB    layer  -> eglSwapBuffers on the app's ivi surface       ivi layer per app
                           <---  TICK when the compositor took the frame               embed: GBM dmabuf FBO ->
                           <---  TOUCH / CLOSED (touch.c, nft divert of UDP 30567)        wl_drm buffer (else FBO ->
                           <---  X_STATE, CCU                                              readback -> wl_shm) on
                                                                                           HmiMain3D's compositor
                                                                                           (wayland-1)
foreground_gate.js (child, root:root) -> which uids are in front
mgu-render-hmi.sh --build (install) -> page template; mgu-render-hmi.sh (before hmi.service) -> mounted into the HMI's widgets
```

The sources come from both renderers this replaces:

| From | Parts |
|---|---|
| idrive7-apps `kit/renderd` (MIT, `LICENSE.mgu-renderd`) | `src/gfx.c` (GLES2 executor), the main loop, layer surfaces, `--replay`, the wire protocol |
| IterioDev's mgu-renderd | touch routing (`src/touch.c`), pictures (IMAGE, DROP_IMAGE, limits), the frame cap (FPS), video (VIDEO, DROP_VIDEO, op 19: frames from a player's file, YUV to RGB in the shader), the client's picture cache (`js/mgu_render_client.js`) |
| display-bridge (mgu-apps) | the embed placement (`src/embed.c`, `js/hmi_template.js`, `systemd/mgu-render-hmi.sh`), the foreground gate (`src/gate.c`, `js/foreground_gate.js`), yield surfaces |

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
- The page template is made at install (`mgu-render-hmi.sh --build`, the
  deploy tool's `postInstall`) from the installed HmiMain3D into
  `/var/opt/mgu-render/hmi/`, for its stamp (HmiMain3D's size and mtime, the
  generator, `embed_surface_id`), at low priority for at most 120 s.
  `/var/opt/mgu-render/status.json` says how it went: `template` (`ok`,
  `building`, `failed`), `stamp`, `reason`, `retry`, and `problem`
  (`In-page drawing unavailable: <reason>`), which the Store shows on the
  Renderer's page. HmiMain3D lacking what the template needs is not tried
  again until the stamp changes; any other failure (the time limit, a
  signal, memory or disk) is tried again at the next install.
- After an update the deploy tool runs `render_check.js` (its `check`),
  at once or, while the old renderer keeps running, at the next start: a
  client must get X_READY and READY with a screen size, and 20 s later the
  service must still run with no restart and answer again. It draws
  nothing. A renderer that fails goes back to the version before.
- `mgu-render-hmi.service` (before `hmi.service`, at most 30 s) generates
  nothing: with a template for the current stamp it mounts a copy of
  `bmw/widget/` in `/run` with it over the original and writes
  `/run/mgu-render/hmi-template`, else the stock widgets stay. The template, its folder and the copy are
  readable by the HMI's user (0644, 0755) whatever the installer's umask. Embed is
  offered from the next HMI start: after the first install, the next
  head-unit start. `umount /mnt/dataro/data/hmi/bmw/widget` undoes it.
- The boot count ("The HMI and the page template", below) stops the mount
  after the HMI failed twice with the template: `/var/opt/mgu-render/hmi-boot`,
  `hmi-shutdown`, and `"hmi": "failed"` with its `problem` in `status.json`.
- Drop-in `/etc/systemd/system/var-opt-ro.service.d/50-mgu-render.conf`: the
  shutdown record the boot count reads.
- Drop-ins `/etc/systemd/system/display-bridge{.socket,.service,-hmi.service}.d/mgu-render.conf`:
  display-bridge's units stand down while mgu-render is installed ("display-bridge's apps").
- Logs: `journalctl -u mgu-render -u mgu-render-hmi`. `embed:` lines name the HMI compositor's globals and the
  embed path (`zero-copy`, or `readback fallback (<why>)`). While `/run/mgu-render/stats-log` exists, each shown
  app's frames a second, render time and path are logged once a second (`stats <app>: ...`); an embed app's line
  adds the HMI's frame callbacks in that second and the time from each commit to its callback. The Store then
  appends its own line to `/dev/shm/robertn_store-stats.log` (`stats store: ...`: builds, frames sent, touch
  events, CPU). Each step of an app's frames and touches also goes to `/run/mgu-render/trace.log`, the Store's to
  `/dev/shm/robertn_store-trace.log`; `node tools/car-test/trace.js <mgu-render's> <the Store's>` gives the time
  each step takes.

An update does not stop a running mgu-render (`keepRunning` in
`component.json`): the files and units are replaced, the running daemon goes
on, and the new version runs from its next start: stopping a renderer with
apps' surfaces up can restart the head unit (IterioDev's iDrive 8 car), and
a handover to a new daemon would end the old one's surfaces the same way. The socket's own path changes only when the
socket unit restarts: at once when the daemon is not running (the deploy
tool restarts a changed socket whose service is stopped), else at the next
head-unit start; meanwhile apps reach it through the community socket, which
the client tries next.

## The HMI and the page template

The template goes into HmiMain3D's widgets before the HMI starts, at every
boot. An HMI build that failed with it would restart the head unit at every
start (recmgr and crashhandler restart the head unit for any failure of
`hmi.service` or HmiMain3D), so `mgu-render-hmi.sh` counts the boots that
mount it and stops mounting it after two that ended in an HMI failure.

**Which template.** The count is kept for one key: the template's stamp
(HmiMain3D, the generator, `embed_surface_id`) and the MD5 of its `.pbw`
files. Another key (a firmware update, another generator or
`embed_surface_id`, a template that comes out different) starts the count
again at 0 and mounts it, as does a new install after a removal, which takes
`/var/opt/mgu-render` with it. An mgu-render update that leaves the template
as it was keeps the count.

**Healthy.** After mounting, `mgu-render-hmi.sh --confirm` waits in
`mgu-render-hmi.service` (in the background; the unit is already started)
for `hmi.service` to be active, notes its main PID and
`ExecMainStartTimestampMonotonic`, and 120 s later checks that the same run
is still active, that its main PID is HmiMain3D and that the template is
still in place. The boot is then confirmed healthy and the count goes to 0.
`hmi.service` has no `Restart=`, and a failure of it restarts the head unit,
so the same main PID and start time 120 s apart is one unbroken HMI run
with the template. It asks systemd every 5 s until the HMI is active, for
up to 600 s, then once more 120 s later.

**Failed.** A boot that mounted the template counts one failure only when
it was not confirmed healthy, was not stopped by systemd, and a restart
record names the HMI: recmgr's `/var/opt/public/sin/recmgr/restartInfo.xml`
with `<ServiceName value="hmi.service"/>` (recmgr writes it before it asks
for the restart, for any failure of `hmi.service`: a crash, a watchdog
timeout, a start timeout) or crashhandler's
`/var/opt/public/sin/crashhandler/restartInfo.xml` naming `HmiMain3D`. Only
a record written in that boot after the mount counts: one that was not there
at the mount or whose modification time, size or inode changed since
(`seen` in `hmi-boot`), whatever the clock did. crashhandler names the
process as dlt-cdh, the kernel's core handler, gives it: the file name of
`/proc/<pid>/exe`. The boot's evidence is read:

- at its end, by the drop-in of `var-opt-ro.service` (`--shutdown`), which
  the NodeStateManager runs at every shutdown of the head unit (a
  switch-off, a restart asked for, a restart recmgr or crashhandler asked
  for) before `/var/opt` goes read-only: `hmi-shutdown` holds `<boot>
  hmi|other|none`;
- without such a line for that boot, at the next boot (before the HMI
  starts, and before recmgr and crashhandler delete their records, some
  10 s into the boot), from the records on disk.

| How the boot ended | Counted |
|---|---|
| the HMI ran 120 s unbroken with the template (confirmed) | the count goes to 0 |
| a switch-off or suspend, a restart from BMW's menu, the Store or an update (the NodeStateManager's restart: no restart record) | no |
| `systemctl reboot` or `poweroff` (`--stop`, the unit's `ExecStop`, which `Conflicts=shutdown.target` runs at every systemd shutdown, marks the boot; `hmi.service`'s stop signal, SIGABRT, may leave a core) | no |
| a power cut (no shutdown record, no new restart record) | no |
| an HMI that starts slowly, then any of the above | no |
| a restart for another program (the record names it) | no |
| a record already there at the mount, left by an earlier boot | no |
| a restart record naming the HMI, written after the mount | 1 |

At two failures with no confirmed boot between them, the template is marked
failed (`state=failed`) and not mounted: the HMI starts with its stock
widgets, the marker is not written, and apps that ask for the embed
placement get their layer, as with no template. `status.json` gets `"hmi":
"failed"` and the `problem` `In-page drawing unavailable: the HMI failed
with the page template`, which the Store shows on the Renderer's page, until
the key changes. A template marked failed is never mounted, whatever else
fails. A count that cannot be read (a missing or corrupt `hmi-boot`, no boot
id) mounts the template, as does any other error in the count.

`hmi-boot` is `template=<key>`, `fails=<n>`, `boot=<id>` (a random id kept
in `/run/mgu-render/boot`, which every boot starts without), `at=<s>`,
`seen=<recmgr's record's mtime.size.inode or -> <crashhandler's>` and
`state=mounted|confirmed|clean|failed`.

## Embed buffers

An embed app's frames reach the HMI's compositor one of two ways, decided when mgu-render connects to it:

- **zero-copy**: drawn straight into one of three GPU buffers the compositor shows. They are linear XRGB8888
  dmabufs from GBM (`/dev/dri/renderD128`, else `card0`), each the texture of an FBO, given to the compositor with
  `wl_drm`'s `create_prime_buffer`. A frame's GL commands are flushed (`glFlush`) before it is committed; the GPU driver's implicit sync orders the compositor's reads after them (`embed_finish = 1`: it waits for the GPU, `glFinish`). Needs `wl_drm` v2 with
  PRIME and XRGB8888 on the compositor and dmabuf import (`EGL_EXT_image_dma_buf_import`) in mgu-render's own EGL.
- **readback**: drawn into an offscreen FBO and read into the compositor's shared memory (`wl_shm`), through a pixel
  buffer when the context is GLES 3. Used when anything zero-copy needs is missing, with `embed_zero_copy = 0`, and
  once the compositor refused the GPU buffers (a protocol error on `wl_drm`) or they could not be made: from then on
  until mgu-render restarts, reconnecting at once after a refusal.

Both draw top-down and give the same bytes (`test/test_embed.c`). display-bridge's apps' pixels go into whichever
kind is in use (with zero-copy, uploaded at the app's own size and scaled into the GPU buffer by GL): the HMI's compositor shows a GPU buffer
with red and blue swapped once the same surface id has shown a shared-memory buffer in that HMI run (seen on a
test unit and on the car), so a connection never mixes the two. Once reading back, mgu-render stays so until it restarts, and
zero-copy after a readback shows right only on a freshly started HMI. The journal names the path (`embed: zero-copy` or `embed: readback fallback (<why>)`);
apps see it in X_READY's caps (32) and STATS' fourth word.

## display-bridge's apps

mgu-apps' display-bridge draws DOOM, draw_gallery and display_bridge_demo in
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
  display-bridge's protocol (`src/dbr.h`, the same as mgu-apps'
  `native/display-bridge/src/wire.h`, version 2). HELLO's frame (INDEX8 with
  PALETTE, XRGB8888, premultiplied ARGB8888, RGBA8888; up to 1920×720, as
  display-bridge)
  is kept as FRAME and RECTS write it, and shown in the HMI page's box,
  fitted and centred with black around it as display-bridge places it, with
  READY's `hmi` flag and that rectangle: made on the CPU (palette lookup,
  nearest-pixel scaling, about 0.5 ms a frame) and written straight into
  the compositor's shared memory, or, with zero-copy, uploaded at the app's
  own size and scaled into its GPU buffer by GL ("Embed buffers").
  Without the page template (the first start after an install) it goes on
  the app's own layer as a pixmap, fitted into the app area. SHOW and HIDE are
  the app's wish; it shows only while the foreground gate reports it in front.
- **Pacing.** READY offers 3 frames in flight: one waiting to be drawn, one
  drawn and waiting for the compositor's frame callback, one committed. A
  newer frame replaces the one waiting, or is drawn over the one not yet
  committed (DROPPED either way). The committed one is PRESENTED on the
  frame callback, or DROPPED when the picture goes first. On a test unit
  whose HMI repaints its embedded surfaces about 20 times a second, 10 s of
  DOOM play showed 16.9 frames a second (3 dropped), display-bridge 17.9.
- **Touch.** The picture is the app's claim: a touch that starts there comes
  as TOUCH (down, motion, up) in frame pixels, source `evdev`, and the HMI does
  not get it.

## Beside other renderers

IterioDev's mgu-renderd (`mgu-renderd.service`, from his App Manager or as a
service package through the Store) and upstream idrive7-apps' renderer
(`mgu-renderd.service` from its installer, or the tool `idrive7-renderd`
from its repository through the Store, `idrive7-renderd.service`) can be
installed with mgu-render. Each serves its own apps; nothing is replaced. A
tool that needs a renderer (upstream's controller gate) is satisfied by any.

**Sockets.** Ours is `/run/mgu-render/render.sock`. The community socket
`/run/mgu-renderd/renderd.sock` is ours exactly when it is a symlink to our
socket; anything else there is another renderer's and is never removed,
except a socket nobody listens on while no other renderer is installed (the
one mgu-render before 0.2.0 listened on, left when its socket unit
restarts), which the link replaces.
- *Taken* (`src/share.c`): the link is made only where nothing is (`symlink`
  fails on anything present) and only while none of `shared_yield`'s unit
  files is installed: `/etc/systemd/system/mgu-renderd.service`,
  `/run/systemd/system/mgu-renderd.service`,
  `/etc/systemd/system/idrive7-renderd.service`. The socket unit makes it at
  its start (`mgu-render --share`), the daemon checks every 2 s while it
  runs. Through the link, socket activation works for community apps too.
- *Handed over*: the other renderers unlink the path and bind their own
  socket at their start, so one that starts has it at once. Installed but not
  yet started, its unit file is there: the daemon removes our link within
  2 s. Our link is moved aside before it is removed; when what moved is a
  socket the other renderer bound in between, it goes back (`link`, which
  never replaces anything), so the other's socket is never lost.
- *Taken back*: once the other renderer's unit file is gone (removed) and its
  socket with it, the daemon links the path again within 2 s; when the daemon
  is not running, at its next start or the next head-unit start. An installed
  renderer that stops or restarts (`Restart=always`) keeps the path: its unit
  file is still there.
- The socket unit stopping (uninstall) removes our socket and our link
  (`--unshare`), nothing else.
- *Kit apps sent back* (`src/kit.c`): an idrive7-apps kit app (its folder
  has `source/javascript/kit/app-spec.json`) tries the community socket first
  and ours second, and stays with the one it reached. When the renderer there
  restarts, its kit apps come to us. While a kit app is connected to us, the
  daemon reads every 2 s which socket listens at the community path (the
  kernel's table `/proc/net/unix`, no connection); once the same one has
  listened there for 5 s, the kit app's connection is closed and the kit
  connects again, to the community socket unless a failed try there turned
  it to ours. An app back within 60 s is sent again only after 30 s, then
  2 min; back a third time, it stays.

**ivi ids.** Our layer apps use layer `0x4d520000 + slot` and surface
`0x4d520100 + slot` ("MR"); the community renderers use `0x4d470000` and
`0x4d470100` ("MG") on the same compositor, so two apps in slot 0 never share
an id. The embed surface `0x500` is on the HMI's own compositor (`wayland-1`),
which neither community renderer connects to.

**The screen's layer list.** Winston rewrites the centre screen's list on
each `add_layer` from the calling connection's own copy (taken when it
connected, changed only by its own requests), so a long-open connection drops
the layers others added since. Our layer goes on through a connection made
for that moment (`src/relist.c`), whose copy is the list as it is, so other
programs' layers stay. A
layer another program drops is put back on top, at once while its app is
shown, otherwise at its next show; with no layer of ours dropping theirs, a
renderer that puts its own layer back in turn finds nothing to answer.

**Touch.** IterioDev's renderer diverts the display's touch with its own
table (`ip touchroute`, ports 30568 in, 30569 out); ours has `ip mgu_render`
and ports 30570 in, 30571 out, so neither removes the other's rule or takes
its ports. Each diverts only while one of its own apps is shown with claims:
ours only while one of its apps is in front (the foreground gate), his while
his app shows its screen. They take turns. Were both in at once, the first
chain to see a PDU takes it; on a test unit's `lo` our rule passes both
renderers' re-injections (from 30569 and 30571) to the HMI and his catches
ours, so a PDU passes each renderer at most once and nothing loops. Neither
leaves its rule behind: each has a guard process that removes it when its
renderer dies or hangs, and its unit's `ExecStopPost` deletes its own table
only. Upstream's renderer has no divert.

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
same format), read last: an update replaces `mgu-render.conf` but leaves that
file, so a value changed on a car survives the next update. A bad line there is
logged and skipped; the renderer still starts. The unit-specific ones:

| Key | iDrive 7 | iDrive 8 |
|---|---|---|
| screen, app area | read from Winston's output: 1920×720, area 108,82,1790,638 | 2880×960, area 0,76,2880,764 |
| `touch_iface`, `touch_saddr` | `vlan73`, `160.48.199.115` (`auto`: `lo` when there is no vlan73, as on a test unit) | same |
| `touch_area` | 84,0,1836,720 (`auto` by screen size) | 0,76,2880,764 |
| `embed`, `embed_area` | 1, 104,88,1796,632 | never offered: no HmiMain3D, so no template is loaded |
| `embed_zero_copy`, `tick_early`, `readback_pbo`, `embed_finish` | 1, 1, 1, 0 (embed: "Embed buffers") | same |
| `fps`, `fps.<app>` | 0: an app that asks for a rate (the Store: 60) gets it; N: N frames a second in its place, for every such app or one (`fps.robertn_store = 30`) | same |
| `foreground_gate`, `hmi_process` | node + `foreground_gate.js`, `HmiMain3D` | the gate reads `RemoteHmiApplication2` from `oap-mainapp21` |

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

Pixel apps: `gpu.pixmap(1, 320, 200, 'index8', 'nearest')`, `gpu.palette(1,
rgb768)`, `gpu.pixels(1, rects, indices)` for what changed, and
`imageOp(1, x, y, w, h)` in each frame (`test/pixel_client.js`).

Video (`info.video`): a player process writes decoded frames (I420) to
`/dev/shm/mgu-video-<name>` (PROTOCOL.md, "Video"); the app names the file
with `gpu.video(1, '/dev/shm/mgu-video-<name>')` and puts
`videoOp(1, x, y, w, h, r)` in its frames. Each new video frame draws the
app's last frame again; the app still sends at least one message a second
while it is shown (its frame again will do), since an app silent for 3 s is
taken for hung and hidden. The frame file must be the app's (its uid), or a
system player's (root, or `nobody`). IterioDev's YouTube app
(IterioDev/car-apps, with its player mgu-ytplay) uses it through IterioDev's
kit.

Multi-touch (`info.fingers`, `gpu.fingers(true)`) was contributed by
[ciscospirit](https://github.com/ciscospirit).

The controller: read FrontCCU over SOME/IP in the app (display-bridge's
`display_input.js` does) and keep the page's hidden focusable components for
the HMI's own focus and BACK; `gpu.grab(true)` holds the dial back from the
HMI only where the HMI's controller gate is loaded (`info.controller`).

## Build and test

| Command | What |
|---|---|
| `make target` | `build/target/mgu-render`: x86-64, glibc 2.27, loader `/lib/ld-linux-x86-64.so.2`, built in Ubuntu 18.04 (Docker, linux/amd64) |
| `make check-target` | the binary's architecture, loader, libraries (`libwayland-client`, `libwayland-egl`, `libEGL`, `libGLESv2`, libc, libm, libdl) and glibc versions |
| `make test` | in Ubuntu 24.04 with Mesa's llvmpipe (Docker): `test/test_embed.c` (embed's buffer paths against a mock HMI compositor, `test/mock_hmi.c`: zero-copy through `wl_drm` with memfds standing in for dmabufs, readback with and without a pixel buffer, no `wl_drm`, no PRIME, buffers refused; every committed frame's CRC equal to the frame GL drew), `test/test_dialect.c`, `test/test_touch.c` (routing; our table and ports only, in while claimed, out when not and when the renderer dies), `test/test_share.c` (the community socket beside a fake second renderer: handover, restart, take-back, the drop race, foreign sockets kept), `test/test_video.c` (a frame file shorter than its header, the frame file's owner, the video limits), `test/test_hmi.sh` (the page-template script: built at install, only mounted at boot, a refused build not retried, a timeout or signal retried, the template and the boot's copy readable by the HMI's user under umask 077), and `test/replay.sh`: every session in `test/sessions/` (recorded from upstream's and IterioDev's kits, `test/sessions/README.md`) and the synthetic ones (`test/gen_sessions.js`) replayed through the original daemons (`test/reference/`) and mgu-render, every frame compared byte for byte; native pixmaps compared with the same pictures sent as IterioDev pictures; video sessions read frame files in `/dev/shm` and their last frame is checked for the videos' colours; a frame file of another uid is refused |
| `deploy/hu install mgu-render` | build and install on a unit (deploy/README.md) |

`mgu-render --replay FILE --out F.pam [--raw F.rgba]` draws a recorded
stream offscreen. `record_dir` in the conf records each connection.

## On the car

Settled offline and on a test unit: both legacy protocols (frames identical
to the originals), native pixmaps, the embed and layer placements, the
foreground gate, the template service, socket activation and packaging. Only
the car can show:

**iDrive 7**
- [ ] Layer: an upstream app (car_vitals) draws at 60 fps under our unit (upstream measured 56-61 fps with its own); our layer's z-order over HMI popups and the camera, and the yield surface ids of the reversing camera.
- [ ] Embed: DOOM-style pixmap frames inside the page: presented rate (`fps` in `test/pixel_client.js`), and the readback cost at 1796×632 (STATS avg µs) on the HD 505.
- [ ] display-bridge's apps: after the update and a head-unit restart, display-bridge's units inactive (condition), DOOM, draw_gallery and display_bridge_demo drawn in their pages, DOOM's presented rate (`doom fps` in `/tmp/doom.log`) and touch on display_bridge_demo.
- [ ] Embed: HmiMain3D's compositor offers `wl_drm` v2 with PRIME (`embed:` lines in the journal), takes the GPU buffers and shows them (`embed: zero-copy`), and the Store's drawn screens' frame rate while dragging (`tools/car-test/CAR-TEST.md`).
- [ ] Touch: finger PDUs on UDP 30567 from 160.48.199.115 on vlan73, finger PDUs told by their finger count (payload byte 37) whatever their word type; the claim area 84,0,1836,720.
- [ ] Touch in embed mode: a claimed area inside the page reaches the app and the HMI's hidden components under it do not react.
- [ ] The foreground gate as root:root (gid 0) under the unit's SOME/IP credentials.
- [ ] GRAB with upstream's `mgu-inputgate.so` loaded (installed separately).
- [ ] The release firewall accepting 30570 with the inserted rule (as for IterioDev's 30568).
- [ ] Beside upstream's renderer: its apps on its own layer ids, ours on ours, both shown in turn; the community socket its.

**iDrive 8**
- [ ] Layer with IterioDev's apps unchanged (their packages are iDrive 8 only), screen 2880×960, the touch divert as with IterioDev's renderer.
- [ ] Video: IterioDev's YouTube app with its player mgu-ytplay: the player's frame rate on the screen (STATS) at 720p, and the render cost of a frame (STATS avg µs).
- [ ] Embed: whether Hmi8 has an embedded compositor, an embedded-surface widget and loadable widget files (until then embed is not offered: no HmiMain3D).
