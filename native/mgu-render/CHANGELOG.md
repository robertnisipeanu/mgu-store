# mgu-render changelog

## 0.6.10

Both changes are for iDrive 8 only (centre display 2880x960); on iDrive 7 the renderer behaves as 0.6.9.

- iDrive 8: layer apps hide for a yield surface (`yield_surfaces`) only while it shows a picture: visible and with a buffer (its `configuration` larger than 0x0). On a G82 the HMI keeps cameraplayer's `SID_VIDEO_DIGITAL_HU` 0x198 visible from boot with no buffer, which hid every layer app for good (the Store kept its widget screens). The renderer logs each yield surface's visibility and buffer size as they change.
- iDrive 8: overlays (`overlay_apps`, default `iteriodev-overlays`): a root client with a listed app id stays shown over the yield surfaces, is never closed by a touch on the HMI, gets touch first and may claim outside `touch_area` (the climate bar), and its layer is put back on top when another app's layer goes on the screen. While an overlay claims, the touch rule and the firewall's accept go in again every 10 s. On iDrive 7 a listed app is an ordinary app (logged).

## 0.6.9

- The foreground gate finds the HMI's `RemoteHmiApplication` description on iDrive 7 firmware that keeps it elsewhere: after `/usr/lib/oap-mainapp/src-gen/` and the iDrive 8 one, `/usr/lib/oap-mainapp/src-gen/someip/`, then the copy MainApp's installer writes for each app whose manifest names the interface (`/var/opt/public/oap/oap_<uid>/someipInterfaces/`, the one with the most instances).
- With no description anywhere, the gate says so (`unavailable`) and is not started again. mgu-render/1 apps it gates are offered no mode, so they keep their own screens (the Store its widget screens); those connected before are disconnected once and get that on their next connection.

## 0.6.8

- `render_check.js`, the deploy tool's check after an update (`check` in `component.json`; needs mgu-deploy 0.6.9): a client connects to the renderer's socket and must get its native answer (X_READY, then READY with a screen size); 20 s later the service must still run with no restart, and a second connection must get READY again. It draws nothing. A renderer that fails it goes back to the version before, at the install or at the next start of the head unit.

## 0.6.7

- A layer app's layer goes onto the centre screen through a connection made for it and closed again (`src/relist.c`), never through the renderer's own long-lived one. Winston applies a screen's `add_layer` to the layer list as the calling connection last saw or set it, so a connection open a while dropped every layer other programs (the HMI, another renderer) put on the screen since. The new connection sees the list as it is: our layer goes on top and every other layer stays.
- When another program sets the screen's layers without ours, Winston says so (the layer's `screen` event) and the layer goes back on top: at once while the app is shown, at its next show otherwise. Taken off more than 10 times in 10 s while shown, it goes back at its next show (journal: `layer taken off the screen`).

## 0.6.2

- `fps` and `fps.<app>` (0): the frames a second an app that asks for a rate (FPS) gets, in place of the rate it asks; for every such app, or for one (`fps.robertn_store = 30`). Display-bridge apps ask for none and are not paced by it.
- While `/run/mgu-render/stats-log` exists, each step of an app's frames and touches goes to `/run/mgu-render/trace.log` (`<us> R <step> <n> <app>`, CLOCK_MONOTONIC): touch in and forwarded, TICK sent, frame received, draw start and end, commit, the HMI's frame callback; `tools/car-test/trace.js` lines it up with the Store's.

## 0.6.1

- The HMI page template, its folder and the boot's copy of the HMI's widgets are made readable by the HMI's user (0644 files, 0755 folders) whatever umask the install or the boot runs with. An install that ran with umask 077 left the template readable by root only, and the HMI, which runs as its own user, showed the app's page empty. An install whose template is in place for its HmiMain3D makes it readable without making it again, and each boot copies it readable.

## 0.5.1

- A zero-copy frame is committed once its GL commands are flushed (`glFlush`), relying on the GPU driver's implicit sync, so the renderer's loop is not held while the GPU draws; `embed_finish = 1` waits for the GPU (`glFinish`).
- A display-bridge app's frame (DOOM) on zero-copy is uploaded at its own size and scaled into the GPU buffer by GL, to the nearest pixel, black around it.
- While `/run/mgu-render/stats-log` exists, an embed app's stats line has the HMI's frame callbacks in that second and the time from commit to callback.

## 0.5.0

- Embed frames are drawn straight into GPU buffers the HMI's compositor shows (zero-copy): three linear XRGB8888 dmabufs from GBM (`libgbm.so.1`, loaded when needed), each the texture of an FBO, given to the compositor with `wl_drm`'s `create_prime_buffer`. Used when the compositor offers `wl_drm` v2 with PRIME and XRGB8888 and the renderer's EGL imports dmabufs; otherwise frames are read back into its shared memory as before, and so until mgu-render restarts once the compositor refused the buffers (a `wl_drm` protocol error; mgu-render reconnects at once) or they could not be made. The journal says `embed: zero-copy` or `embed: readback fallback (<why>)`, and lists the compositor's globals. `embed_zero_copy = 0` reads back always.
- With zero-copy, display-bridge's apps' pixels go into the GPU buffers too (drawn by GL as a picture): the HMI's compositor shows a GPU buffer with red and blue swapped once the surface id has shown a shared-memory buffer in that HMI run.
- Embed frames are drawn top-down, so a readback is one copy (no rows turned); anti-aliased edges can differ from 0.4.0's by a few levels.
- `tick_early` (on): an embed app gets its TICK once its last frame is drawn and no drawn frame waits, so it builds frame N+1 while the HMI shows frame N; that frame is drawn while the compositor still has the one before and committed at its frame callback.
- `readback_pbo` (on): the readback goes through a pixel buffer (GLES 3) and is copied into the compositor's buffer just before that frame is committed.
- STATS has a fourth word for native apps (1: the frames were drawn zero-copy), X_READY's caps have 32 (embed zero-copy), and while `/run/mgu-render/stats-log` exists each shown app's frames a second, render time and frame path are logged once a second.

## 0.4.1

- The HMI page template is made when mgu-render is installed or updated (`mgu-render-hmi.sh --build`, the deploy tool's `postInstall`; needs mgu-deploy 0.6.1), at low priority for at most 120 s, never before the HMI: `mgu-render-hmi.service` only mounts a template made for the installed HmiMain3D, the generator and the surface id, else leaves the stock widgets, so the HMI and the cluster's map start without waiting for it. An install whose boot-time build never finished gets its template with this update; embed is offered from the next start of the head unit.
- `/var/opt/mgu-render/status.json` says how the last build went: `template` `ok`, `building` or `failed`, the `stamp` it was for, the `reason` and, when it failed, `problem` (`In-page drawing unavailable: <reason>`), which the Store shows on the Renderer's page (mgu-updater 0.8.1, Store 0.9.7). A build the generator refuses (identifiers it cannot find in this HmiMain3D) is not tried again until the stamp changes; any other failure (the time limit, a signal, memory or disk) is tried again at the next install.

## 0.4.0

- Video, from IterioDev mgu-renderd 1.2.0 protocol 4, for third-party apps in the iterio and native dialects: a player writes decoded frames (I420, up to 2048×2048, BT.601 or BT.709, limited or full range) to `/dev/shm/mgu-video-<name>` in up to four slots; the app names the file (VIDEO 13, DROP_VIDEO 14) and draws op 19 where the picture goes, fitted into the box with its aspect kept and a corner radius, under and over its other ops. Each new frame draws the app's last frame again without a message from the app; a shown app still sends at least one message a second, as IterioDev's kit does. Only `/dev/shm/mgu-video-*` regular files of the app's uid, root or `nobody` (IterioDev's mgu-ytplay) are opened (no links); others get an ERROR. A video counts w×h×3 bytes towards limits of its own, 12 MiB an app and 32 MiB all apps; a frame size past them is logged and the frame shown before stays. A frame the file is too short for draws the frame shown before, and the app is not redrawn for it until seq changes. READY's version is 4, X_READY's caps have 16 (video), and `js/mgu_render_client.js` has `video()` and `videoOp()`. Video streams from IterioDev's kit, which its YouTube app (IterioDev/car-apps) draws with, replay unchanged (`make test`).

## 0.3.1

- iDrive 8: an app's screens drawn by the renderer show there (the renderer finds which app is in front on its HMI).

## 0.3.0

- display-bridge's apps (mgu-apps DOOM, draw_gallery, display_bridge_demo) draw through mgu-render, unchanged: it speaks display-bridge's protocol DBR1 (`src/dbr.c`; a connection whose first bytes are its magic) on display-bridge's socket `/dev/shm/display-bridge/bridge.sock`, a link to its own while nothing else listens there. Their frames (INDEX8 with a palette, XRGB, ARGB, RGBA; whole or in regions) go into a pixmap drawn fitted into the HMI page's box as display-bridge places them, each answered PRESENTED or DROPPED; touch on the picture comes as their TOUCH in frame pixels.
- Embed mode draws a frame as soon as it comes and commits it at the compositor's next frame callback (four buffers), so a frame is ready the moment the HMI is; display-bridge's apps' frames are written into the buffer on the CPU, with no GL readback.
- display-bridge's own units (`display-bridge.socket`, `.service`, `-hmi.service`) stand down while mgu-render is installed (a drop-in with `ConditionPathExists=!/var/opt/mgu-render/current/mgu-render`, from the next head-unit start): one embed provider, one page template, one foreground gate. Uninstalling mgu-render removes the drop-ins.

## 0.2.0

- Its own socket, `/run/mgu-render/render.sock`. The community renderers' socket `/run/mgu-renderd/renderd.sock` is a link to it while no other renderer is installed (none of `shared_yield`'s unit files present): made by the socket unit at its start (`mgu-render --share`) and kept by the daemon every 2 s, removed when another renderer is installed, never replacing or removing anything that is not that link but a socket nobody listens on while no other renderer is installed (0.1's own, left when its socket unit restarts). Needs mgu-deploy 0.4.0. Upstream's and IterioDev's renderers take the path at their start; mgu-render takes it back once they are removed.
- Layer apps on ivi layer `0x4d520000 + slot` and surface `0x4d520100 + slot`, apart from the community renderers' `0x4d47…`.
- Touch divert in its own table `ip mgu_render`, ports 30570 in and 30571 out; on `lo` re-injections from IterioDev's renderer (30569) and ours (30571) go on to the HMI. The unit deletes only that table when it stops.
- The controller gate's event socket `@mgu-renderd-ccu` is bound only while an app grabs, and its file touched only while that socket is ours: upstream's renderer keeps the controller for its apps.
- An update leaves a running daemon running (`keepRunning`); the new version runs from its next start.
- `js/mgu_render_client.js` connects to the own socket, then to the community one when nothing listens there.
