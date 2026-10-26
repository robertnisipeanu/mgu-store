#ifndef MGU_GFX_H
#define MGU_GFX_H
#include <stdint.h>
#include <stddef.h>

/* per-client render state the GPU side needs (atlases and layers are per client) */
typedef struct gfx_layer { uint32_t id; unsigned tex, fbo; int w, h; struct gfx_layer *next; } gfx_layer;
typedef struct gfx_image { uint32_t id; unsigned tex; int w, h; size_t bytes; struct gfx_image *next; } gfx_image;

/* pictures: per app at most GFX_IMG_MAX of them / GFX_IMG_BYTES of pixels, all apps together GFX_IMG_ALL
   (the kit keeps under the per-app limits by itself: it drops the least recently drawn) */
#define GFX_IMG_SIDE 1024
#define GFX_IMG_MAX 64
#define GFX_IMG_BYTES (32u << 20)
#define GFX_IMG_ALL (96u << 20)

typedef struct gfx_xf { float s, ox, oy; } gfx_xf;      /* device = logical * s + (ox, oy) */

typedef struct gfx_client {
    /* glyph atlases are packed into one shared texture; this maps atlas id -> position there */
    struct { uint32_t id; int x, y, w, h; } atlas[64];
    int natlas;
    struct { uint32_t id; int row; } ramp[64];
    int nramp;
    gfx_layer *layers;
    gfx_image *images;
    int nimage;
    size_t image_bytes;
} gfx_client;

int gfx_init(void);                       /* needs a current GL context */
void gfx_client_free(gfx_client *c);
int gfx_atlas(gfx_client *c, uint32_t id, int w, int h, const uint8_t *alpha);
int gfx_ramp(gfx_client *c, uint32_t id, int n, const uint32_t *cols);
int gfx_layer_def(gfx_client *c, uint32_t id, float w, float h, float scale, const uint32_t *cmd, size_t nwords);
void gfx_layer_drop(gfx_client *c, uint32_t id);
/* px: w*h*4 bytes premultiplied RGBA, rows top-down; same id replaces (the old one is dropped first) */
int gfx_image_def(gfx_client *c, uint32_t id, int w, int h, const uint8_t *px);
void gfx_image_drop(gfx_client *c, uint32_t id);
/* draw a command list into the bound framebuffer (size fbw x fbh, y down) */
void gfx_draw(gfx_client *c, const gfx_xf *xf, int fbw, int fbh, const uint32_t *cmd, size_t nwords, int clear_transparent);
const char *gfx_error(void);

#endif
