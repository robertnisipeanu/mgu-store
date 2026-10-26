/* display-bridge's protocol (dbr.h): framing, HELLO, RECTS, placement. */
#include "dbr.h"

#include <stdlib.h>
#include <string.h>

static unsigned get16(const uint8_t *p) { return (unsigned)(p[0] | p[1] << 8); }
static uint32_t get32(const uint8_t *p)
{
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static void put16(uint8_t *p, unsigned v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void put32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

int dbr_is_magic(const uint8_t *p) { return get32(p) == DBR_MAGIC; }

int dbr_header(const uint8_t *p, unsigned *type, uint32_t *len, uint32_t *seq)
{
    if (!dbr_is_magic(p)) return -1;
    *type = get16(p + 4);
    *len = get32(p + 8);
    *seq = get32(p + 12);
    return 0;
}

void dbr_put_header(uint8_t out[DBR_HEADER], unsigned type, uint32_t len, uint32_t seq)
{
    put32(out, DBR_MAGIC);
    put16(out + 4, type);
    put16(out + 6, 0);
    put32(out + 8, len);
    put32(out + 12, seq);
}

void dbr_hello_decode(const uint8_t p[DBR_HELLO_SIZE], struct dbr_hello *h)
{
    h->version = get16(p);
    h->format = get16(p + 2);
    h->width = get16(p + 4);
    h->height = get16(p + 6);
    h->dst_x = (int16_t)get16(p + 8);
    h->dst_y = (int16_t)get16(p + 10);
    h->dst_w = (int)get16(p + 12);
    h->dst_h = (int)get16(p + 14);
}

void dbr_ready_encode(const struct dbr_ready *r, uint8_t out[DBR_READY_SIZE])
{
    put16(out, r->version);
    put16(out + 2, r->max_in_flight);
    put16(out + 4, r->screen_w);
    put16(out + 6, r->screen_h);
    put32(out + 8, r->refresh_mhz);
    put32(out + 12, r->surface_id);
    put32(out + 16, r->layer_id);
    put32(out + 20, r->flags);
    for (int i = 0; i < 4; i++) put16(out + 24 + 2 * i, (unsigned)r->dst[i]);
}

void dbr_touch_encode(unsigned kind, int x, int y, uint8_t out[8])
{
    out[0] = (uint8_t)kind;
    out[1] = 0;
    out[2] = DBR_TOUCH_SRC_EVDEV;
    out[3] = 0;
    put16(out + 4, (unsigned)(x < -32768 ? -32768 : x > 32767 ? 32767 : x));
    put16(out + 6, (unsigned)(y < -32768 ? -32768 : y > 32767 ? 32767 : y));
}

uint32_t dbr_error_encode(unsigned code, const char *text, uint8_t *out, size_t cap)
{
    size_t n = strlen(text);
    if (n > cap - 4) n = cap - 4;
    put32(out, code);
    memcpy(out + 4, text, n);
    return (uint32_t)(4 + n);
}

size_t dbr_bpp(unsigned format)
{
    switch (format) {
    case DBR_FMT_INDEX8: return 1;
    case DBR_FMT_XRGB8888: case DBR_FMT_ARGB8888: case DBR_FMT_RGBA8888: return 4;
    default: return 0;
    }
}

int dbr_rects(const uint8_t *p, size_t len, int w, int h, size_t bpp, int rects[DBR_MAX_RECTS][4], const uint8_t **px)
{
    if (len < 4) return -1;
    unsigned n = get16(p);
    if (n < 1 || n > DBR_MAX_RECTS || len < 4 + 8 * (size_t)n) return -1;
    size_t need = 0;
    for (unsigned i = 0; i < n; i++) {
        const uint8_t *r = p + 4 + 8 * i;
        int x = (int)get16(r), y = (int)get16(r + 2), rw = (int)get16(r + 4), rh = (int)get16(r + 6);
        if (rw < 1 || rh < 1 || x + rw > w || y + rh > h) return -1;
        rects[i][0] = x; rects[i][1] = y; rects[i][2] = rw; rects[i][3] = rh;
        need += (size_t)rw * rh * bpp;
    }
    if (need != len - 4 - 8 * (size_t)n || need > (size_t)w * h * bpp) return -1;
    *px = p + 4 + 8 * n;
    return (int)n;
}

void dbr_fit(const int area[4], int w, int h, int out[4])
{
    long aw = area[2], ah = area[3];
    if (aw * h <= ah * w) {
        out[2] = (int)aw;
        out[3] = (int)((aw * h + w / 2) / w);
    } else {
        out[3] = (int)ah;
        out[2] = (int)((ah * w + h / 2) / h);
    }
    out[0] = area[0] + (area[2] - out[2]) / 2;
    out[1] = area[1] + (area[3] - out[3]) / 2;
}

void dbr_to_rgba(uint8_t *dst, const uint8_t *src, size_t n, unsigned format)
{
    uint8_t a = format == DBR_FMT_XRGB8888 ? 255 : 0;
    for (size_t i = 0; i < n; i++, src += 4, dst += 4) {
        dst[0] = src[2]; dst[1] = src[1]; dst[2] = src[0]; dst[3] = a ? a : src[3];
    }
}

void dbr_palette_lut(const uint8_t rgb[DBR_PALETTE_SIZE], uint32_t lut[256])
{
    for (int i = 0; i < 256; i++)
        lut[i] = 0xff000000u | (uint32_t)rgb[3 * i] << 16 | (uint32_t)rgb[3 * i + 1] << 8 | rgb[3 * i + 2];
}

/* n opaque black pixels: the compositor takes the X byte as alpha */
static void fill(uint8_t *row, int n)
{
    uint32_t *o = (uint32_t *)(void *)row;
    for (int i = 0; i < n; i++) o[i] = 0xff000000u;
}

void dbr_blit(uint8_t *dst, int dw, int dh, const int img[4], const uint8_t *src, int sw, int sh, unsigned format,
              const uint32_t lut[256])
{
    size_t stride = (size_t)dw * 4;
    int x0 = img[0], y0 = img[1], iw = img[2], ih = img[3];
    int *xs = malloc((size_t)iw * sizeof *xs);
    if (!xs) return;
    for (int x = 0; x < iw; x++) xs[x] = (int)((long)x * sw / iw);
    size_t bpp = dbr_bpp(format);
    int last = -1;
    for (int y = 0; y < dh; y++) {
        uint8_t *row = dst + (size_t)y * stride;
        if (y < y0 || y >= y0 + ih) { fill(row, dw); continue; }
        int sy = (int)((long)(y - y0) * sh / ih);
        if (sy == last) { memcpy(row, row - stride, stride); continue; }   /* the same source row again */
        last = sy;
        fill(row, x0);
        fill(row + (size_t)(x0 + iw) * 4, dw - x0 - iw);
        uint32_t *o = (uint32_t *)(void *)(row + (size_t)x0 * 4);
        const uint8_t *s = src + (size_t)sy * sw * bpp;
        if (format == DBR_FMT_INDEX8) {
            for (int x = 0; x < iw; x++) o[x] = lut[s[xs[x]]];
        } else if (format == DBR_FMT_RGBA8888) {
            for (int x = 0; x < iw; x++) {
                const uint8_t *p = s + (size_t)xs[x] * 4;
                o[x] = 0xff000000u | (uint32_t)p[0] << 16 | (uint32_t)p[1] << 8 | p[2];
            }
        } else {                                       /* XRGB / premultiplied ARGB, little endian: b, g, r, x|a */
            for (int x = 0; x < iw; x++) {
                const uint8_t *p = s + (size_t)xs[x] * 4;
                o[x] = 0xff000000u | (uint32_t)p[2] << 16 | (uint32_t)p[1] << 8 | p[0];
            }
        }
    }
    free(xs);
}
