/*
 * mgu-render wire protocol. PROTOCOL.md describes it in full.
 *
 * Stream socket, little endian. Every message: u32 type, u32 payload length, payload.
 * Draw commands are a stream of 32-bit words: an opcode word, then its arguments
 * (f32 coordinates in the app's logical pixels, u32 colours as 0xRRGGBBAA).
 *
 * Three dialects share the socket (ours, /run/mgu-render/render.sock, and the community one linked to it) and messages 1-8:
 *   upstream  idrive7-apps kit/renderd (protocol 1): 9 IMAGE, 10 GRAB, 105 CCU
 *   iterio    IterioDev mgu-renderd (protocol 3):    9 CLAIM, 10 IMAGE, 11 DROP_IMAGE, 105 TOUCH, 106 CLOSED
 *   native    mgu-render/1, asked for in HELLO:      the iterio messages + the X_* extensions below
 * A legacy connection's dialect is read from the first message only one of them sends (dialect.c).
 *
 * Derived from mgu-renderd src/proto.h (idrive7-apps kit/renderd, MIT, Copyright (c) 2026
 * cauliflowermossgrape; touch routing and pictures by IterioDev).
 */
#ifndef MGU_PROTO_H
#define MGU_PROTO_H

/* E_READY's version word, which iterio's kit reads (>= 3: pictures); upstream's kit ignores it */
#define MGU_PROTO_VERSION 3
/* the native dialect's version (X_READY) */
#define MGU_NATIVE_VERSION 1
#define MGU_NATIVE_TOKEN "proto=mgu-render/"

/* DBR: display-bridge's protocol (dbr.h), its own framing, told by its magic in a connection's first bytes */
enum { DIALECT_UNKNOWN = 0, DIALECT_UPSTREAM = 1, DIALECT_ITERIO = 2, DIALECT_NATIVE = 3, DIALECT_DBR = 4 };

/* client -> daemon, all dialects */
enum {
    M_HELLO = 1,      /* utf8 app id; native: app id, NUL, "proto=mgu-render/1" (NUL-separated key=value fields) */
    M_PLACE = 2,      /* i32 x, y, w, h (screen px), f32 scale, f32 ox, f32 oy: device = logical * scale + (ox, oy) */
    M_SHOW = 3,       /* u32 on */
    M_ATLAS = 4,      /* u32 id, u32 w, u32 h, w*h alpha bytes (padded to 4) */
    M_RAMP = 5,       /* u32 id, u32 n, u32 colour[n] - evenly spaced stops */
    M_LAYER = 6,      /* u32 id, f32 w, f32 h, commands: drawn once into a cached texture */
    M_FRAME = 7,      /* commands: the next frame */
    M_DROP_LAYER = 8, /* u32 id */
};

/* client -> daemon, upstream */
enum {
    MU_IMAGE = 9,     /* u32 id, u32 w, u32 h, w*h RGBA bytes (opaque): a pixel image, replaced on every upload */
    MU_GRAB = 10,     /* u32 on: this app wants the iDrive controller to itself (the HMI's controller gate) */
};

/* client -> daemon, iterio and native */
enum {
    MI_CLAIM = 9,     /* u32 n, (f32 x y w h)*n logical px: touch there is this app's while it is shown (n 0 = none) */
    MI_IMAGE = 10,    /* u32 id, u32 w, u32 h (1..1024), w*h*4 bytes RGBA premultiplied, rows top-down; same id replaces */
    MI_DROP_IMAGE = 11,/* u32 id */
    MI_FPS = 12,      /* u32 max frames a second (0 = no cap, at most 1000): faster frames wait, TICK comes at that rate;
                         upstream sends none, so it needs no dialect */
};

/* client -> daemon, native only ("MR" + n: clear of every number the other dialects use) */
enum {
    X_MODE = 0x4d520001,    /* u32 mode (MODE_*): where the surface goes; before PLACE, or again to move it */
    X_GRAB = 0x4d520002,    /* u32 on: as MU_GRAB, events come as X_CCU */
    X_PIXMAP = 0x4d520003,  /* u32 id, u32 w, u32 h (1..GFX_PIXMAP_SIDE), u32 format (PIX_*), u32 filter (0 nearest,
                               1 linear): an image the app writes in regions (X_PIXELS); drawn with OP_IMAGE */
    X_PIXELS = 0x4d520004,  /* u32 id, u32 n (1..64), (u32 x y w h)*n, then each rect's pixels in turn, rows top-down,
                               packed (w * bytes per pixel per row), the whole padded to 4 */
    X_PALETTE = 0x4d520005, /* u32 id, 256 * 3 bytes RGB: an INDEX8 pixmap's colours, for the whole picture */
};

/* pixmap formats */
enum { PIX_RGBA_PREMUL = 1, PIX_RGBA_OPAQUE = 2, PIX_INDEX8 = 3 };

/* placement modes */
enum { MODE_LAYER = 1, MODE_EMBED = 2 };

/* daemon -> client, all dialects */
enum {
    E_READY = 101,    /* u32 version, u32 screen w, u32 screen h, u32 touch routing on */
    E_TICK = 102,     /* u32 frame number, u32 ms since start: the compositor took the last frame, send the next */
    E_ERROR = 103,    /* utf8 text */
    E_STATS = 104,    /* u32 frames shown in the last second, u32 avg render us, u32 max render us */
};

/* daemon -> client, upstream */
enum {
    EU_CCU = 105,     /* the controller event the HMI didn't get (while this app holds the grab): FrontCCU
                         RotaryEncoderStateFront as on the wire - u8 sequence, u16 BE knob, u8 press, u8 tilt, ... */
};

/* daemon -> client, iterio and native */
enum {
    EI_TOUCH = 105,   /* u32 phase (1 down, 2 move, 3 up), f32 x, f32 y logical px: a gesture that began in a claim */
    EI_CLOSED = 106,  /* (none) the HMI was touched outside the claims: the user left the app, it is hidden (SHOW 0) */
};

/* daemon -> client, native only */
enum {
    X_READY = 0x4d520101,   /* before E_READY: u32 native version, u32 modes (bit per MODE_*), u32 caps (CAP_*),
                               i32 embed box x y w h (0 0 0 0: no embed), i32 app area x y w h, u32 pixmap side,
                               u32 refresh mHz */
    X_STATE = 0x4d520102,   /* u32 mode, u32 on screen, u32 in front (the HMI shows the app's screen): on change */
    X_CCU = 0x4d520103,     /* as EU_CCU */
};

enum {
    CAP_TOUCH_ROUTE = 1,    /* claims take touch (MI_CLAIM) */
    CAP_CONTROLLER = 2,     /* GRAB holds the controller back from the HMI (the HMI's controller gate is loaded) */
    CAP_FRONT_GATE = 4,     /* surfaces show only while the app's screen is in front */
    CAP_PIXMAP = 8,         /* X_PIXMAP / X_PIXELS / X_PALETTE */
};

/* draw opcodes, all dialects */
enum {
    OP_CLEAR = 1,     /* c */
    OP_RECT = 2,      /* x y w h c */
    OP_GRAD = 3,      /* x y w h n (t c)*n  vertical gradient */
    OP_RRECT = 4,     /* x y w h r c */
    OP_RSTROKE = 5,   /* x y w h r lw c */
    OP_CARD = 6,      /* x y w h r n (t c)*n  rounded rect, vertical gradient */
    OP_RAMPRECT = 7,  /* x y w h r ramp spanX spanW  rounded rect, horizontal colour ramp */
    OP_ARC = 8,       /* cx cy r0 r1 a0 a1 c flags ramp rf rt  (degrees clockwise from 12 o'clock; flags 1 round caps, 2 ramp) */
    OP_LINE = 9,      /* xa ya xb yb width c  round caps */
    OP_TRIS = 10,     /* n (x y c)*3n  plain triangles */
    OP_GLYPHS = 11,   /* atlas c n (x y w h u0 v0 u1 v1)*n  uv in atlas pixels */
    OP_LAYER = 12,    /* id x y */
    OP_CLIP = 13,     /* x y w h */
    OP_NOCLIP = 14,
    OP_QUAD = 15,     /* x0 y0 x1 y1 x2 y2 x3 y3 c  convex quad, anti-aliased edges */
    OP_ALPHA = 16,    /* a  global opacity for what follows (0..1) */
    OP_XF = 17,       /* s ox oy  transform for what follows: device = v * s + (ox, oy); s <= 0: back to the placement's */
    OP_IMAGE = 18,    /* upstream: id ver x y w h  pixel image scaled into the rect, nearest pixel;
                         iterio, native: x y w h r id  picture (or pixmap) over the rect, corner radius r */
};

#endif
