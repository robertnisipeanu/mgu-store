# Car test: mgu-render's embed pacing

Measures the Store's scrolling and DOOM on the car with the published
mgu-render and Store, then with this branch's, and puts the published versions
back. It answers three questions:

1. How often the HMI takes a frame: `hmi callbacks` a second and `commit to
   callback` time in mgu-render's stats line.
2. Whether flushing a zero-copy frame (`glFlush`, the default) shows it whole:
   the owner's look at the Store while dragging and at DOOM, and the fps and
   render times against `embed_finish=1` (`glFinish`).
3. Where the Store's CPU goes: its own line (`stats store: ...`: builds,
   frames sent, touch events and their times, its CPU), beside the probe's
   per-process CPU.

About 20 minutes over ENET, two head-unit restarts included. The agent runs
every command; the owner opens and closes the Store and DOOM, drags the list,
plays, and says what they see.

| File | What |
|---|---|
| `install-test.sh` | runs on the Mac: status, the test install and restore, test settings, renderer and head-unit restarts, measurements |
| `probe.js` | runs on the unit (Node 8): Wayland globals, GPU, CPU per second; read-only |
| `kit.js` | `install-test.sh`'s version checks, on the Mac |
| `trace.js` | the per-frame trace of a drag as a step-by-step breakdown, on the Mac |

## Short check: swipes, 30 and 60 fps, page changes

The branch's mgu-render and Store with the per-frame trace; renderer
restarts with nothing on screen, no head-unit restart. About 25 minutes.

1. `k status` (the published versions, `embed: zero-copy`), `k stats on`.
2. Owner: open the Store on its list. `k drag before`: quick swipes.
   Owner: close the Store.
3. `k install`, `k restart --off-screen`. Owner: open the Store and wait a
   second (the drag's layers are made ahead).
4. `k drag swipes60`: the owner swipes the list in short quick strokes,
   lifting the finger between them. `k drag drag60`: one slow drag up and
   down without lifting. `k drag pages60`: the owner opens apps from the
   list and goes back, and switches tabs, several times. The owner says
   what flickers, if anything. Owner: close the Store.
5. `k ab fps.robertn_store=30`, `k restart --off-screen`. Owner: open the
   Store. `k drag swipes30`, `k drag drag30`, `k drag pages30`, as in 4;
   the owner says what differs. Owner: close the Store.
6. `k restore`, `k restart --off-screen`, `k status`.

`<name>.trace.txt`: each step's median and p90, and the Store's work per
touch: a touch's first drag frame, the release (settle), whole page builds
and the drag layers made ahead.

## Short check: one drag, traced

`install` puts on only what is newer on the branch. With the unit's
mgu-render already drawing zero-copy, a renderer restart with nothing on
screen starts a new mgu-render; no head-unit restart. About 15 minutes:

1. `k status` (the published versions, `embed: zero-copy`), `k stats on`.
2. Owner: open the Store on its list. `k drag before` while the owner drags
   the list. Owner: close the Store.
3. `k install`, then `k restart --off-screen` when it installed mgu-render.
4. Owner: open the Store on its list. `k drag after`; the owner says whether
   the list moves whole and smoothly. Owner: close the Store.
5. `k restore`, then `k restart --off-screen` when it put mgu-render back;
   `k status`.

Each `<name>.txt` has the probe's per-second table with the fastest core's
clock (`cpu MHz`) and the clock policy; each `<name>.stats` has mgu-render's
lines and the Store's. With mgu-render 0.6.2 and the Store 0.9.11 or later,
`<name>.trace.txt` has each step's median and p90 over the frames of the
drag (`trace.js`, from `<name>.render-trace` and `<name>.store-trace`): what
a frame waited for before its build, the build, the socket, the wait in
mgu-render before its draw, the draw, the commit and the HMI's callback,
and the time from one frame to the next.

## Before the car

- The branch is committed: `install` builds HEAD (`release/release.js
  build`) and refuses uncommitted changes in `native/mgu-render` or
  `apps/robertn_store`.
- Docker is running (the mgu-render build), the Mac has internet (`install`
  copies the published release first).
- Rehearse once on a test head unit, with its SSH options as the target:

  ```sh
  H=(--host 127.0.0.1 --port <ssh> --identity <key> --ssh-opt StrictHostKeyChecking=no
     --ssh-opt UserKnownHostsFile=/dev/null --ssh-opt LogLevel=ERROR --ssh-opt IdentitiesOnly=yes)
  k() { native/mgu-render/tools/car-test/install-test.sh "$@" -- "${H[@]}"; }
  ```

  Keep the options in an array: a string of them is one word in zsh,
  `--host` is then not seen, and the command refuses (the same string
  given to deploy/hu itself would make it look for the car).
- At the car: parked, on stable power (engine running or a charger), ENET
  cable in, the SSH key in `~/.config/mgu-store/assets` (deploy/README.md,
  "Connecting").

Run everything from the root of the mgu-store checkout. The target is
always named after `--`; nothing connects without it. At the car:

```sh
k() { native/mgu-render/tools/car-test/install-test.sh "$@" -- --car; }
k status
```

`--car` finds the car as deploy/hu does (ENET, relay on local port 2224;
else the hotspot; add `--wifi` or `--hu-ip <addr>` after it to choose).
Each command connects by itself. `status` prints the installed versions, what the
running mgu-render runs, the test settings and stats-log state. Results go to
`~/.cache/mgu-store/car-test/results/`.

## a) Baseline: the published versions

1. `k status`: note the versions (the published ones: mgu-render, Store,
   deploy tool).
2. `k probe all`: the Wayland globals of `wayland-0` and `wayland-1` (with
   `wl_drm`'s device and PRIME capability, `zwp_linux_dmabuf_v1`'s formats and
   modifiers) and the GPU: DRM devices, i915 frequencies, the GL libraries
   HmiMain3D and mgu-render have loaded, `/dev/dri`.
3. `k stats on` (the published mgu-render logs each second's `stats <app>:
   N fps, render avg ... us max ... us, path ...` while it is on).
4. Owner: open the Store on its list.
5. `k drag baseline`, and tell the owner to drag the list up and down
   without stopping until the command ends (about 15 s).
6. Owner: close the Store, open DOOM and play. `k drag doom-baseline`. Owner:
   close DOOM.

## b) Install the branch

The branch's zero-copy path must first show on a freshly started HMI: once
the HMI's page surface has shown a pixel (shm) buffer, as the published
renderer's did in a), it can show the zero-copy buffers with red and blue
swapped until the HMI restarts. So the install ends with a head-unit
restart, not a renderer restart.

1. Owner: close the Store (HOME).
2. `k install`. It records the installed versions, copies the published
   release (every artifact checked against the catalog), builds HEAD's
   mgu-render and Store, each when the branch has a newer version than the
   unit (a changed mgu-render at the version its release gives it, from
   `release.js stamp` in a clone), and installs them with the unit's own deploy tool (the deploy tool itself
   is not changed). A few minutes; a Store install waits for the app
   manager. It refuses, changing nothing, when it cannot record the
   versions, when the unit's versions are not the published ones, or when
   a requirement is missing.
3. With the owner at the car and nothing on screen: `k reboot --off-screen`.
   It asks the head unit for the restart the Store's Restart head unit
   makes (the Node State Manager's) and waits until the unit is back,
   about 2 minutes. When it cannot, the owner uses the Store's Restart
   head unit instead, and `k status` answers once the unit is back. The
   restart also clears a)'s `verbose=1`.
4. `k stats on` (stats-log is gone with the restart).
5. Owner: open the Store. `k status` must show `embed: zero-copy (...)`;
   `embed: readback fallback (<why>)` gives the reason it is not.
6. `k sh 'journalctl -u mgu-render -b -o cat | grep -E "embed:|wayland|wl_"'`:
   the renderer's view of `wayland-1`'s globals.

## c) Measure

Each run: the owner has the Store open on its list and drags it while the
command runs (or plays DOOM). `<name>.stats` gets mgu-render's lines of that
window (`stats <app>: N fps, render avg ... us max ... us, path ..., hmi
callbacks N, commit to callback avg ... us max ... us`) and the Store's
(`stats store: ...`).

1. `k drag flush` (the branch's defaults). The owner says whether the list
   moves whole while dragging (no half-drawn rows, no flicker), then opens the
   Store's Installed page and says how the tool icons look (below).
2. Owner: close the Store. `k ab embed_finish=1`, `k restart --off-screen`.
   Owner: open the Store. `k drag finish`.
3. Owner: close the Store. `k ab` (the defaults), `k restart --off-screen`.
   Owner: open DOOM and play. `k drag doom`. The owner says whether DOOM looks
   right (the whole picture, its colours). Owner: close DOOM.

   | Icon | Right | Red and blue swapped |
   |---|---|---|
   | App privacy | purple | pinkish red |
   | Deploy tool | red | blue |
   | Python | green | teal green |
   | Renderer | blue | orange |

4. `k sh 'journalctl -u mgu-render -b -o short-monotonic' > ~/.cache/mgu-store/car-test/results/mgu-render-journal.txt`

## d) Restore

1. Owner: close the Store.
2. `k restore`. It clears the test settings and stats-log, installs the
   published versions again from the copy made in b), and checks that the
   deploy tool, mgu-render and the Store have the versions recorded before
   and that mgu-render's installed manifest (every file's sha256) is the
   one recorded before. Anything else is an error: run `restore` again.
   When the test installed a Store, an app cannot go back a version, so
   the test Store is uninstalled and the published one installed fresh:
   its tile goes and comes back, it may get another uid, and its data
   folder starts empty. That folder holds only what is made again by
   itself (the updater writes `updater-secret` again within 15 s, the
   bundle cache is rebuilt); sources, tokens and settings are the
   updater's and stay. The deploy tool's snapshots do not cover app homes,
   so nothing else would bring them back.
3. With nothing on screen: `k reboot --off-screen`, so the published
   renderer starts on a freshly started HMI, as the car runs it every day.
4. `k status`: the versions of a), `runs /var/opt/mgu-render/versions/<published>/mgu-render`
   (once the Store has been opened), test settings none, stats-log off, no
   test install recorded.
5. Owner: open the Store and check it draws, scrolls, and its icons have
   their right colours.

The test build stays on the unit as mgu-render's other kept version (the
deploy tool keeps two). The next published update replaces it; do not run
`rollback mgu-render` before then.

## e) What to send back

The whole `~/.cache/mgu-store/car-test/results/` folder (`*.txt`, `*.json`,
`*.stats`, `mgu-render-journal.txt`), the output of `install` and `restore`,
and this table:

| Run | Looks right | fps mean | render avg / max µs | HMI callbacks a second | commit to callback avg / max µs | Store builds avg ms, CPU % (its line) | mgu-render / HmiMain3D / Store CPU % (probe) | GPU MHz mean / max |
|---|---|---|---|---|---|---|---|---|
| baseline (published) | | | | | | | | |
| doom-baseline | | | | | | n/a | | |
| flush | yes / no, colours | | | | | | | |
| finish | | | | | | | | |
| doom | yes / no | | | | | n/a | | |

`wayland-1` globals: `wl_drm` v__ device ______ PRIME yes/no;
`zwp_linux_dmabuf_v1` v__, XR24/AR24 modifiers ______. GPU driver ______,
DRI driver HmiMain3D has loaded ______.

## What can go wrong

- **Never stop or restart mgu-render with an app on screen.** Stopping a
  renderer while an app's surface is up can restart the head unit. Use
  `k restart --off-screen` only, after the owner has closed the Store; it
  also refuses while mgu-render's journal shows its embed surface up, when
  an app has drawn over the HMI since mgu-render started (its closing is not
  logged), when the journal cannot be read, or when mgu-render is not in
  recmgr's restart list. Then `k reboot --off-screen` instead, and `k ab
  <settings>` and `k stats on` again (a head-unit restart clears them).
- **The head unit restarts by itself** (black screen, boot logo): wait until
  it is back (about 2 minutes). Test settings and stats-log are gone; the
  installed mgu-render runs. `k status`, then go on, or `k restore`.
- **Icons with red and blue swapped:** the zero-copy buffers on a page
  surface that showed a pixel buffer earlier in this HMI run. Only a
  head-unit restart clears it (`k reboot --off-screen`); a renderer
  restart does not.
- **`k reboot` refused or not taken:** it refuses while the deploy tool
  runs; otherwise the owner uses the Store's Restart head unit.
- **The Store does not draw after a restart, or mgu-render does not stay
  up:** `k ab` (clears the settings), `k restart --off-screen`, `k
  status`. If it still fails: `k restore`.
- **`install` refused (exit 2):** when the message is the kit's own
  (versions, requirements, a test install already recorded), nothing
  changed. When the unit's deploy tool refused a component, the test
  record exists: `k status`, then `k restore`.
- **`install` failed (exit 1):** the deploy tool undid that component. `k
  status`, then `k restore`.
- **The connection drops mid-command:** run the command again. `install`
  refuses once its record exists: run `restore`, which can always run again.
- **The Store's tile goes away during `restore`:** expected while the
  published Store reinstalls; it comes back when the install ends.

## Not verified off the car

- The whole round trip (status, probe, install of mgu-render and a newer
  Store, restart guard and restart, the runtime settings, drag with stats
  lines, restore with the Store reinstalled, the checks, `k reboot`) ran in
  a test unit. The car's own connection (`--car`) is deploy/hu's. `k
  reboot` sends the request the updater's `reboot` sends (`nsm_control
  --requestRestart 7 --normal`) and waits for a new boot id or a new start
  of the HMI.
- How HmiMain3D's compositor answers a client that binds
  `zwp_linux_dmabuf_v1` and leaves: mgu-render binds `wl_drm` there, the
  probe also `zwp_linux_dmabuf_v1` (for its formats and modifiers), which
  mgu-render never does.
- Whether the car's i915 exposes `gt_act_freq_mhz` under
  `/sys/class/drm/card0`; without it `drag` reports no GPU column.
