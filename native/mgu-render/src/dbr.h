/*
 * display-bridge's protocol, DBR1 (mgu-apps native/display-bridge src/wire.h), which DOOM, draw_gallery and
 * display_bridge_demo speak through their js/display_bridge_client.js. mgu-render serves it on display-bridge's
 * socket path (README.md, "display-bridge's apps"): a connection whose first four bytes are the magic is a DBR1
 * session. No GL, no display: host-testable.
 *
 * Every message is a 16-byte little-endian header, then `length` payload bytes:
 *   u32 magic "DBR1", u16 type, u16 flags (0), u32 length, u32 seq (FRAME / RECTS: the app's frame id, echoed in
 *   PRESENTED / DROPPED).
 * App -> renderer
 *   HELLO    16 bytes  u16 version, format, width, height; i16 dst_x, dst_y; u16 dst_w, dst_h
 *   PALETTE 768 bytes  256 x (r, g, b), INDEX8 only, for the whole picture
 *   FRAME   w*h*bpp    the whole frame, rows top-down, packed
 *   RECTS   4+8n+...   v2: u16 n (1..64), u16 0; n x (u16 x, y, w, h); then each region's pixels in turn
 *   SHOW, HIDE, PING   no payload
 * Renderer -> app
 *   READY    32 bytes  u16 version, max_in_flight, screen_w, screen_h; u32 refresh_mhz, surface_id, layer_id,
 *                      flags (DBR_READY_*); i16 dst_x, dst_y; u16 dst_w, dst_h (the picture on the screen)
 *   PRESENTED 4 bytes  u32 ms; seq = the frame's id: it is on the screen
 *   DROPPED   0 bytes  seq = the frame's id: a newer frame replaced it, or the picture went before it showed
 *   TOUCH     8 bytes  u8 kind (DBR_TOUCH_*), u8 id, u8 source, u8 0, i16 x, y in frame pixels
 *   ERROR   4+n bytes  u32 code (DBR_ERR_*), utf8 text; the connection then closes
 */
#ifndef MGU_DBR_H
#define MGU_DBR_H
#include <stddef.h>
#include <stdint.h>

#define DBR_MAGIC 0x31524244u
#define DBR_VERSION 2           /* RECTS */
#define DBR_HEADER 16
#define DBR_HELLO_SIZE 16
#define DBR_PALETTE_SIZE 768
#define DBR_READY_SIZE 32
#define DBR_MAX_RECTS 64

enum {
    DBR_HELLO = 0x01, DBR_PALETTE = 0x02, DBR_FRAME = 0x03, DBR_SHOW = 0x04, DBR_HIDE = 0x05, DBR_PING = 0x06,
    DBR_RECTS = 0x07,
    DBR_READY = 0x81, DBR_PRESENTED = 0x82, DBR_DROPPED = 0x83, DBR_TOUCH = 0x84, DBR_ERROR = 0x8f,
};
enum { DBR_FMT_INDEX8 = 1, DBR_FMT_XRGB8888 = 2, DBR_FMT_ARGB8888 = 3, DBR_FMT_RGBA8888 = 4 };
enum { DBR_READY_CONTROLLER = 1, DBR_READY_TOUCH = 2, DBR_READY_HMI = 4 };
enum { DBR_TOUCH_DOWN = 1, DBR_TOUCH_MOTION = 2, DBR_TOUCH_UP = 3 };
enum { DBR_TOUCH_SRC_EVDEV = 3 };   /* the touchscreen, as display-bridge's own target hmi reports it */
enum { DBR_ERR_PROTOCOL = 1, DBR_ERR_UNSUPPORTED = 3, DBR_ERR_DISPLAY = 4 };

struct dbr_hello { unsigned version, format, width, height; int dst_x, dst_y, dst_w, dst_h; };
struct dbr_ready {
    unsigned version, max_in_flight, screen_w, screen_h;
    uint32_t refresh_mhz, surface_id, layer_id, flags;
    int dst[4];
};

/* the first four bytes of a connection are DBR1's magic */
int dbr_is_magic(const uint8_t *p);
/* the header at p: 0, or -1 when the magic is wrong */
int dbr_header(const uint8_t *p, unsigned *type, uint32_t *len, uint32_t *seq);
void dbr_put_header(uint8_t out[DBR_HEADER], unsigned type, uint32_t len, uint32_t seq);
void dbr_hello_decode(const uint8_t p[DBR_HELLO_SIZE], struct dbr_hello *h);
void dbr_ready_encode(const struct dbr_ready *r, uint8_t out[DBR_READY_SIZE]);
void dbr_touch_encode(unsigned kind, int x, int y, uint8_t out[8]);
/* ERROR's payload: code, then the text (at most cap - 4 bytes of it); returns its length */
uint32_t dbr_error_encode(unsigned code, const char *text, uint8_t *out, size_t cap);
/* bytes per pixel of a format, 0 when unknown */
size_t dbr_bpp(unsigned format);
/* a RECTS payload of len bytes for a w x h frame of bpp-byte pixels: the regions (x, y, w, h) and *px at the
 * first one's pixels; returns their count, or -1 when a region is empty or outside the frame, or the pixel bytes
 * do not match them */
int dbr_rects(const uint8_t *p, size_t len, int w, int h, size_t bpp, int rects[DBR_MAX_RECTS][4], const uint8_t **px);
/* the largest rectangle of a w x h frame's shape centred in area (x, y, w, h), as display-bridge places it */
void dbr_fit(const int area[4], int w, int h, int out[4]);
/* n pixels of an XRGB8888 / ARGB8888 frame (bytes b, g, r, x|a) as RGBA bytes; XRGB opaque */
void dbr_to_rgba(uint8_t *dst, const uint8_t *src, size_t n, unsigned format);
/* the 256 colours of a PALETTE (r, g, b) as XRGB8888 words, X 0xff */
void dbr_palette_lut(const uint8_t rgb[DBR_PALETTE_SIZE], uint32_t lut[256]);
/* the whole picture into an XRGB8888 buffer dw x dh (stride dw * 4): the sw x sh frame src in its format,
   scaled to the nearest pixel into img (x, y, w, h, inside the buffer), black around it; INDEX8 through lut.
   Premultiplied ARGB shows over black. Every word's X byte is 0xff: the HMI's compositor reads it as alpha. */
void dbr_blit(uint8_t *dst, int dw, int dh, const int img[4], const uint8_t *src, int sw, int sh, unsigned format,
              const uint32_t lut[256]);

#endif
