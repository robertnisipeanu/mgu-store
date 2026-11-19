/*
 * GPU executor for draw command lists (gfx.c). Derived from mgu-renderd src/gfx.h (idrive7-apps
 * kit/renderd, MIT, Copyright (c) 2026 cauliflowermossgrape; pictures and video by IterioDev).
 */
#ifndef MGU_GFX_H
#define MGU_GFX_H
#include <stdint.h>
#include <stddef.h>

/* per-client render state the GPU side needs (atlases and layers are per client) */
typedef struct gfx_layer { uint32_t id; unsigned tex, fbo; int w, h; struct gfx_layer *next; } gfx_layer;

/* images share one id space per client:
   IMG_PICTURE  iterio / native MI_IMAGE: premultiplied, linear (+ mipmaps), corner radius
   IMG_UPSTREAM upstream MU_IMAGE: opaque RGBA, nearest pixel, replaced in place
   IMG_PIXMAP   native X_PIXMAP: written in regions, RGBA or INDEX8 + palette */
enum { IMG_PICTURE = 0, IMG_UPSTREAM = 1, IMG_PIXMAP = 2 };
typedef struct gfx_image {
    uint32_t id; unsigned tex; int w, h; size_t bytes; int kind;
    int format;                          /* pixmap: PIX_* */
    uint8_t *index;                      /* INDEX8 pixmap: the newest indices, w*h */
    uint8_t pal[768];                    /* INDEX8 pixmap: RGB */
    struct gfx_image *next;
} gfx_image;

/* pictures: per app at most GFX_IMG_MAX of them / GFX_IMG_BYTES of pixels, all apps together GFX_IMG_ALL
   (the kit keeps under the per-app limits by itself: it drops the least recently drawn). Upstream images
   (sides up to GFX_UPSTREAM_SIDE) and pixmaps (GFX_PIXMAP_SIDE) count towards the count and the all-apps total. */
#define GFX_IMG_SIDE 1024
#define GFX_UPSTREAM_SIDE 4096
#define GFX_PIXMAP_SIDE 2048
#define GFX_IMG_MAX 64
#define GFX_IMG_BYTES (32u << 20)
#define GFX_IMG_ALL (96u << 20)
#define GFX_PIXELS_RECTS 64

/* a video (proto.h MI_VIDEO): its frame file, the newest frame on the GPU as Y, U, V luminance textures (NV12: Y, and
   U V as one luminance-alpha texture) */
typedef struct gfx_video {
    uint32_t id; int fd; unsigned tex[3]; int w, h, matrix, full, nv12; uint32_t seq;
    uint8_t *buf; size_t cap;            /* the frame being uploaded */
    size_t bytes;                        /* counted towards the video limits */
    uint32_t bad_seq;                    /* a frame that could not be read or had no room: not pending (= seq once a
                                            frame is read) */
    uint32_t refused_w, refused_h;       /* the size last refused for room (logged once) */
    struct gfx_video *next;
} gfx_video;
#define GFX_VIDEO_MAX 4
#define GFX_VIDEO_SIDE 2048
/* video bytes, apart from the pictures' (a kit keeps its pictures under GFX_IMG_BYTES by itself): w*h*3 a video (its
   newest frame in memory and as textures). An app: one video of the largest size (2048x2048, 12 MiB), or two 1080p
   (6 MiB each); all apps: five 1080p. */
#define GFX_VIDEO_BYTES (12u << 20)
#define GFX_VIDEO_ALL (32u << 20)

typedef struct gfx_xf { float s, ox, oy; } gfx_xf;      /* device = logical * s + (ox, oy) */

typedef struct gfx_client {
    /* Content-keyed textures are shared while clients reference them. */
    struct { uint32_t id; int slot; } atlas[64];
    int natlas;
    struct { uint32_t id; int row; } ramp[64];
    int nramp;
    gfx_layer *layers;
    gfx_image *images;
    int nimage;
    size_t image_bytes;                   /* pictures only (GFX_IMG_BYTES) */
    int upstream_ops;                     /* OP_IMAGE in upstream's layout */
    gfx_video *videos;
    int nvideo;
    size_t video_bytes;                   /* GFX_VIDEO_BYTES */
    const char *name;                     /* the app, for the log */
} gfx_client;

int gfx_init(void);                       /* needs a current GL context */
void gfx_client_free(gfx_client *c);
int gfx_atlas(gfx_client *c, uint32_t id, int w, int h, const uint8_t *alpha);
int gfx_ramp(gfx_client *c, uint32_t id, int n, const uint32_t *cols);
int gfx_layer_def(gfx_client *c, uint32_t id, float w, float h, float scale, const uint32_t *cmd, size_t nwords);
void gfx_layer_drop(gfx_client *c, uint32_t id);
/* px: w*h*4 bytes premultiplied RGBA, rows top-down; same id replaces (the old one is dropped first) */
int gfx_image_def(gfx_client *c, uint32_t id, int w, int h, const uint8_t *px);
/* upstream: opaque RGBA, rows top-down; the same id and size is overwritten in place */
int gfx_image_upstream(gfx_client *c, uint32_t id, int w, int h, const uint8_t *rgba);
void gfx_image_drop(gfx_client *c, uint32_t id);
/* native pixmaps; gfx_pixmap_pixels takes the X_PIXELS payload after the id and returns -1 for a
   malformed one (a protocol error), -2 for an unknown id (E_ERROR), else 0 */
int gfx_pixmap_def(gfx_client *c, uint32_t id, int w, int h, int format, int linear);
int gfx_pixmap_pixels(gfx_client *c, uint32_t id, const uint8_t *p, size_t len);
int gfx_pixmap_palette(gfx_client *c, uint32_t id, const uint8_t *rgb);
/* one region of a pixmap, px in its format's bytes (rows packed): 0, or -1 (gfx_error) */
int gfx_pixmap_write(gfx_client *c, uint32_t id, int x, int y, int w, int h, const uint8_t *px);
/* videos: path /dev/shm/mgu-video-<name> (proto.h), owned by the app's uid, root or nobody; same id replaces; 0, or
   -1 (gfx_error). Each draw shows the file's newest frame. */
int gfx_video_def(gfx_client *c, uint32_t id, const char *path, uint32_t uid);
void gfx_video_drop(gfx_client *c, uint32_t id);
int gfx_video_pending(gfx_client *c);     /* a video has a newer frame than the one drawn: draw the app's frame again */
/* draw a command list into the bound framebuffer (size fbw x fbh, y down). flags: GFX_CLEAR clears it transparent
   first; GFX_TOP_DOWN draws it upside down in GL terms, so its rows lie top-down in memory (a buffer another process
   shows as it is, or reads back without turning it) */
enum { GFX_CLEAR = 1, GFX_TOP_DOWN = 2 };
void gfx_draw(gfx_client *c, const gfx_xf *xf, int fbw, int fbh, const uint32_t *cmd, size_t nwords, int flags);
const char *gfx_error(void);

#endif
