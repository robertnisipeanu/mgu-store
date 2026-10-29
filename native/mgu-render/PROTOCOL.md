# mgu-render protocol

Apps talk to mgu-render over the stream socket `/run/mgu-render/render.sock`
(mode 0660, group `tm_oap_app`), or over the community renderers' socket
`/run/mgu-renderd/renderd.sock` while that is a link to it (README.md,
"Beside other renderers"). Two renderers serve that socket themselves, with
protocols that agree on most messages and clash on a few; mgu-render speaks
both, unchanged, and a third dialect of its own that a client asks for
explicitly. `js/mgu_render_client.js` connects to mgu-render's own socket and,
when nothing listens there, to the community one.

| Dialect | Who sends it | Reference |
|---|---|---|
| **upstream** | idrive7-apps `kit/runtime/renderd.js` (car_vitals, gforce, doom, ...) | idrive7-apps `kit/renderd/src/proto.h`, protocol 1 |
| **iterio** | IterioDev's kit `renderd.js` (oap-cardash, oap-draggy, oap-dtcscan, oap-youtube, ...) | IterioDev mgu-renderd 1.2.0 `src/proto.h`, protocol 4 |
| **native** | `js/mgu_render_client.js` | this file, `mgu-render/1` |

`src/proto.h` has every number below.

A fourth protocol, display-bridge's DBR1 (mgu-apps `native/display-bridge`,
`src/dbr.h`), has its own framing: a connection whose first four bytes are its
magic `DBR1` speaks it for good (README.md, "display-bridge's apps"). No
message of the three dialects begins that way: their first message is HELLO,
type 1.

## Framing

Every message, both ways: `u32 type`, `u32 length`, then `length` bytes of
payload. Little endian. The kits pad payloads to 4 bytes; the daemon does not
require it. A message over 24 MiB, or one whose payload is malformed for its
type, ends the connection ("bad message" in the log), as in both originals.
Unknown types are ignored.

## Messages every dialect sends

Client to daemon:

| Type | Name | Payload |
|---|---|---|
| 1 | HELLO | utf8 app id (native: see below) |
| 2 | PLACE | i32 x, y, w, h (screen px), f32 scale, ox, oy: device = logical × scale + (ox, oy) |
| 3 | SHOW | u32 on |
| 4 | ATLAS | u32 id, w, h, then w×h alpha bytes |
| 5 | RAMP | u32 id, n, then n colours (0xRRGGBBAA), evenly spaced |
| 6 | LAYER | u32 id, f32 w, h, then draw ops: drawn once into a cached texture |
| 7 | FRAME | draw ops: the next frame |
| 8 | DROP_LAYER | u32 id |

Daemon to client:

| Type | Name | Payload |
|---|---|---|
| 101 | READY | u32 version (4), screen w, screen h, touch routing on |
| 102 | TICK | u32 frame number, ms since start: the compositor took the last frame, send the next (embed with `tick_early`: the last frame is drawn and none waits to be shown) |
| 103 | ERROR | utf8 text |
| 104 | STATS | u32 frames shown in the last second, avg render µs, max render µs; native only: u32 flags (1: drawn zero-copy into the HMI compositor's buffer) |

READY carries four words to every client. Upstream's kit reads words 1 and 2;
IterioDev's reads the version (3: pictures supported, 4: video) and the touch word.

## Where the dialects differ

| Type | upstream | iterio / native |
|---|---|---|
| 9 | IMAGE: u32 id, w, h (1..4096), w×h opaque RGBA, rows top-down; the same id is overwritten | CLAIM: u32 n (0..16), n × f32 x, y, w, h logical px: touch there is this app's while it is shown |
| 10 | GRAB: u32 on: the iDrive controller to this app while it is shown | IMAGE: u32 id, w, h (1..1024), w×h premultiplied RGBA, rows top-down; the same id replaces |
| 11 | (none) | DROP_IMAGE: u32 id |
| 12 | (none) | FPS: u32 at most that many frames a second (0 = no cap, at most 1000): a faster frame waits, TICK comes at that rate |
| 13 | (none) | VIDEO: u32 id, utf8 frame file path (NUL padded): that video's frames ("Video", below); the same id replaces |
| 14 | (none) | DROP_VIDEO: u32 id |
| 105 | CCU: a FrontCCU `RotaryEncoderStateFront` event the HMI did not get (u8 sequence, u16 BE knob, u8 press, u8 tilt, ...) | TOUCH: u32 phase (1 down, 2 move, 3 up), f32 x, y logical px |
| 106 | (none) | CLOSED: the HMI was touched outside the claims; the app is hidden (SHOW 0) |
| op 18 | IMAGE `id ver x y w h`: the image scaled into the rect, nearest pixel | IMAGE `x y w h r id`: the picture over the rect, corner radius r, filtered |
| op 19 | (none) | VIDEO `x y w h r id`: the video's newest frame fitted into the rect (aspect kept, centred), corner radius r; nothing before its first frame, nothing inside a LAYER |

### Telling them apart

A legacy HELLO is only an app id, so the daemon reads a connection's dialect
from the first message 9, 10 or 11 it sends (`src/dialect.c`), and from then on
treats 9, 10, 11, the events and op 18 that way:

- **9** is upstream's IMAGE when words 1 and 2 are a size of 1..4096 and the
  payload holds at least 12 + w×h×4 bytes; otherwise IterioDev's CLAIM (word 0
  at most 16, then that many rects). An upstream image's w and h, read as a
  claim's first x and y, are float bit patterns below 1e-38, which no claim
  has, so the image reading wins.
- **10** of 4 bytes is upstream's GRAB; 12 + w×h×4 bytes is IterioDev's IMAGE.
- **11** is IterioDev's.
- Anything else in 9-11 fits neither and ends the connection.
- **12** is IterioDev's (renderd 1.1.2) and decides nothing: upstream sends none.
- **13** and **14** are IterioDev's (renderd 1.2.0) and decide nothing either; a connection
  already upstream ignores them, as upstream's daemon does.

Until then nothing tells them apart, and nothing needs to: messages 1-8 are the
same, the daemon sends 105 and 106 only to an app that claimed or grabbed, and
op 18 draws nothing without an uploaded image. An app that never sends 9-11
stays undecided and is served exactly as either original would serve it.

`test/test_dialect.c` checks the rules; `make test` replays sessions recorded
from both kits through the original daemons and through mgu-render and
compares every frame byte for byte.

## Native dialect, mgu-render/1

A client asks for it in HELLO: the app id, a NUL, then NUL-separated
`key=value` fields, among them `proto=mgu-render/1`:

```
"my_app" 00 "proto=mgu-render/1"
```

An older renderer takes the app id up to the NUL and answers with READY
alone, so the client knows to fall back. mgu-render
answers with X_READY first, then READY. Native clients use IterioDev's numbers
for 9-14, 105, 106 and ops 18 and 19, and the extensions below, whose types start
with "MR" (0x4d52…) so they never meet a number another dialect uses. A
dialect added later takes its own HELLO field and its own type prefix.

Client to daemon:

| Type | Name | Payload |
|---|---|---|
| 0x4d520001 | X_MODE | u32 mode: 1 layer, 2 embed. Before PLACE, or again to move the app |
| 0x4d520002 | X_GRAB | u32 on: as upstream's GRAB; events come as X_CCU |
| 0x4d520003 | X_PIXMAP | u32 id, w, h (1..2048), format (1 premultiplied RGBA, 2 RGBA shown opaque, 3 INDEX8), filter (0 nearest, 1 linear): an image written in regions, drawn with op 18 |
| 0x4d520004 | X_PIXELS | u32 id, n (1..64), n × u32 x, y, w, h, then each rect's pixels in turn, rows top-down, packed (w × 1 or 4 bytes a row) |
| 0x4d520005 | X_PALETTE | u32 id, 768 bytes RGB: an INDEX8 pixmap's colours, for the whole picture from now on |
| 0x4d520006 | X_BRIDGE | u32 on (embed, caps 64): 1 the HMI changes the app's page now, the app's frames show on the renderer's layer over the box for `embed_bridge_ms` (a second one holds it longer); 0 hide that layer now (an HMI popup took the page's focus). README.md, "Page changes" |

Daemon to client:

| Type | Name | Payload |
|---|---|---|
| 0x4d520101 | X_READY | u32 version (1), modes (bit 0 layer, bit 1 embed: offered now), caps (1 touch routing, 2 controller gate loaded in the HMI and its event socket ours or free, 4 front gate, 8 pixmaps, 16 video, 32 embed frames drawn zero-copy, 64 X_BRIDGE), i32 embed box x, y, w, h (0 when no embed), i32 app area x, y, w, h, u32 largest pixmap side, refresh mHz |
| 0x4d520102 | X_STATE | u32 mode, on screen, in front (the HMI shows the app's screen); sent whenever one changes |
| 0x4d520103 | X_CCU | as upstream's CCU |

Pixmaps share the id space of IMAGE pictures. Pictures, upstream images and
pixmaps count towards 64 per app and 96 MiB for all apps; pictures also
towards 32 MiB per app. An upload past them gets an ERROR and draws nothing.
Videos have limits of their own (below).

## Video

IterioDev's protocol 4, the same in the iterio and native dialects. Another
program (a player) writes decoded frames to a file in `/dev/shm`; the app
names the file (VIDEO) and draws op 19 where the picture goes. The renderer
reads the file's newest frame each time it draws the app, and draws the app's
last frame again by itself when a newer one is there (it looks every 5 ms
while a shown app has a video), so the app sends frames for its own changes.
New video frames are not the app talking: a shown app still sends at least
one message a second (its frame again will do), or after 3 s of silence it is
taken for hung and hidden until it talks again, as IterioDev's kit does.

- **Path**: `/dev/shm/mgu-video-<name>`, the name of letters, digits, `-`, `_`
  and `.`, not starting with `.`, up to 64 characters; a regular file, opened
  without following a link (the renderer runs as root), owned by the app's
  uid, by root or by `nobody` (a player run as a system service: IterioDev's
  mgu-ytplay gives its file to `nobody` and writes as `nobody`). Anything else
  gets an ERROR and the app stays connected; the op then draws nothing. At
  most 4 videos per app.
- **File**: a 64-byte header, then `nslot` frames of w×h×3/2 bytes, I420 (the
  Y plane, then U, then V, rows without padding):

  | Word | Field |
  |---|---|
  | 0 | magic `0x4656474d` ("MGVF") |
  | 1 | version, 1 |
  | 2, 3 | w, h: even, 16..2048 |
  | 4 | seq: frames written so far |
  | 5 | slot: the newest frame's slot |
  | 6 | nslot: 1..4 |
  | 7 | matrix: 0 BT.601, 1 BT.709 |
  | 8 | range: 0 limited (16-235), 1 full |
  | 9-15 | zero |

  The writer fills slot (slot + 1) % nslot, then sets slot, then seq + 1; the
  renderer reads the header, then that slot. With 3 slots the writer is two
  frames away from the one being read. A header that does not fit these
  bounds, or a file shorter than its header says, draws the frame read before
  (or nothing), and the app is not drawn again for it until seq changes.
- **Limits**: a video counts w×h×3 bytes (its newest frame in memory and on
  the GPU), from its first frame and at each new size: at most 12 MiB per app
  (one 2048×2048 video, or two 1080p) and 32 MiB for all apps, apart from the
  pictures' limits. A frame size past them is not shown: the frame shown before
  stays (or nothing), and the renderer logs it, until there is room.
- A new size (PLACE with another w or h) drops the videos with the other
  resources; the client sends VIDEO again.

## Placement

- **layer** (every legacy client): the app's own Winston surface on its own
  ivi layer (`0x4d520000 + slot`, surface `0x4d520100 + slot`; the community
  renderers use `0x4d47…`) on top of the
  centre screen, input region empty, placed by PLACE in screen pixels. Shown
  while: SHOW, at least one frame drawn, not silent for 3 s, in front (below),
  and no camera or video surface (`yield_surfaces`) visible.
- **embed** (native, X_MODE 2): inside the app's HMI page. The page names the
  template `LT_State_A4A_WelcomeApp` as its state's widget; the HMI draws the
  ivi surface `embed_surface_id` from its own compositor (`wayland-1`) in the
  template's box (`embed_area`), under its title bar and its popups. PLACE's x
  and y are the box's; frames are drawn at the box's size straight into the
  HMI compositor's GPU buffers, or read back into its shared memory (README.md,
  "Embed buffers"). One app at a time holds the box: the
  newest shown one in front. X_READY offers embed only when the template is
  loaded in the running HMI (`mgu-render-hmi.service` ran before it started),
  and X_MODE 2 is refused with an ERROR otherwise.

**In front**: with a foreground gate configured, an app (any uid but root,
from `SO_PEERCRED`) shows only while the HMI's `RemoteHmiApplication` for its
uid holds `ROOT_APP`. Legacy apps hide themselves when their screen goes; the
gate hides them only while it names another app in front, so a gate that reads
nothing leaves them as they would be without it.

## Touch and controller

- **Touch** is IterioDev's divert (`src/touch.c`): while a shown app claims
  areas, one nftables rule (table `ip mgu_render`) sends the display's touch
  PDUs (UDP 30567) to the daemon on port 30570; a gesture that starts in a claim goes to that app as TOUCH, every
  other PDU goes on to the HMI unchanged. A layer app that claims is hidden
  and gets CLOSED when the HMI is touched outside its claims; an embed app's
  page is the HMI's to leave, so it is not closed. A guard process removes the
  rule if the daemon dies or hangs.
- **Controller**: GRAB / X_GRAB keeps `/run/mgu-renderd/inputgate` fresh
  while the grabbing app is shown, and forwards what arrives on the abstract
  socket `@mgu-renderd-ccu` as CCU / X_CCU: the interface of upstream's
  `mgu-inputgate.so`, which a separate install loads into the HMI. The socket
  is bound only while an app grabs, and is upstream's renderer's when that one
  holds it. Without the gate the HMI keeps the controller; apps read FrontCCU
  over SOME/IP themselves and keep their RHMI focus proxies.

## Draw ops

Words after the op: f32 coordinates in logical px, u32 colours 0xRRGGBBAA.

| Op | Name | Arguments |
|---|---|---|
| 1 | CLEAR | c |
| 2 | RECT | x y w h c |
| 3 | GRAD | x y w h n (t c)×n: vertical gradient |
| 4 | RRECT | x y w h r c |
| 5 | RSTROKE | x y w h r lw c |
| 6 | CARD | x y w h r n (t c)×n: rounded rect, vertical gradient |
| 7 | RAMPRECT | x y w h r ramp spanX spanW |
| 8 | ARC | cx cy r0 r1 a0 a1 c flags ramp rf rt (degrees clockwise from 12 o'clock; flags 1 round caps, 2 ramp) |
| 9 | LINE | xa ya xb yb width c (round caps) |
| 10 | TRIS | n (x y c)×3n |
| 11 | GLYPHS | atlas c n (x y w h u0 v0 u1 v1)×n (uv in atlas px) |
| 12 | LAYER | id x y |
| 13 | CLIP | x y w h |
| 14 | NOCLIP | |
| 15 | QUAD | x0 y0 x1 y1 x2 y2 x3 y3 c (convex, anti-aliased) |
| 16 | ALPHA | a: opacity for what follows |
| 17 | XF | s ox oy: transform for what follows; s ≤ 0 back to the placement's |
| 18 | IMAGE | per dialect, above |
| 19 | VIDEO | x y w h r id (iterio, native): the video's newest frame, above |
