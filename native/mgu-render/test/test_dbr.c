/* display-bridge's protocol (src/dbr.c): framing, HELLO, READY, TOUCH and ERROR as display-bridge's
 * js/display_bridge_client.js writes and reads them, RECTS validation, placement, pixel formats. */
#include <stdio.h>
#include <string.h>

#include "../src/dbr.h"

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static void put16(uint8_t *p, unsigned v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }

/* a RECTS payload: n regions of a frame whose pixel at (x, y) is (x + 7 * y) & 255, bpp 1 */
static size_t rects_payload(uint8_t *out, const int (*r)[4], int n)
{
    put16(out, (unsigned)n);
    put16(out + 2, 0);
    size_t at = 4;
    for (int i = 0; i < n; i++, at += 8) {
        put16(out + at, (unsigned)r[i][0]); put16(out + at + 2, (unsigned)r[i][1]);
        put16(out + at + 4, (unsigned)r[i][2]); put16(out + at + 6, (unsigned)r[i][3]);
    }
    for (int i = 0; i < n; i++)
        for (int y = r[i][1]; y < r[i][1] + r[i][3]; y++)
            for (int x = r[i][0]; x < r[i][0] + r[i][2]; x++) out[at++] = (uint8_t)((x + 7 * y) & 255);
    return at;
}

int main(void)
{
    /* the client's first bytes: HELLO's header (magic "DBR1", type 1, length 16) */
    uint8_t hdr[DBR_HEADER];
    dbr_put_header(hdr, DBR_HELLO, 16, 0);
    CHECK(!memcmp(hdr, "DBR1", 4), "magic bytes");
    CHECK(dbr_is_magic(hdr), "magic");
    unsigned type; uint32_t len, seq;
    dbr_put_header(hdr, DBR_RECTS, 1234, 0xfffffffeu);
    CHECK(dbr_header(hdr, &type, &len, &seq) == 0 && type == DBR_RECTS && len == 1234 && seq == 0xfffffffeu, "header");
    /* mgu-render's own HELLO (u32 type 1) is not DBR1 */
    uint8_t native[8] = { 1, 0, 0, 0, 5, 0, 0, 0 };
    CHECK(!dbr_is_magic(native) && dbr_header(native, &type, &len, &seq) < 0, "native HELLO is not DBR1");

    /* HELLO as display_bridge_client.js writes it: version 1, INDEX8, 561x200, destination x -5 (signed), w 0 */
    uint8_t hello[16] = { 0 };
    put16(hello, 1); put16(hello + 2, DBR_FMT_INDEX8); put16(hello + 4, 561); put16(hello + 6, 200);
    put16(hello + 8, (unsigned)-5);
    struct dbr_hello h;
    dbr_hello_decode(hello, &h);
    CHECK(h.version == 1 && h.format == DBR_FMT_INDEX8 && h.width == 561 && h.height == 200 && h.dst_x == -5 && h.dst_w == 0,
          "hello %u %u %ux%u %d %d", h.version, h.format, h.width, h.height, h.dst_x, h.dst_w);
    CHECK(dbr_bpp(DBR_FMT_INDEX8) == 1 && dbr_bpp(DBR_FMT_XRGB8888) == 4 && dbr_bpp(DBR_FMT_ARGB8888) == 4 &&
          dbr_bpp(DBR_FMT_RGBA8888) == 4 && dbr_bpp(0) == 0 && dbr_bpp(5) == 0, "bpp");

    /* placement: display-bridge's dbr_fit, into the page's box 104,88 1796x632 and the app area */
    int box[4] = { 104, 88, 1796, 632 }, r[4];
    dbr_fit(box, 561, 200, r);
    CHECK(r[0] == 115 && r[1] == 88 && r[2] == 1773 && r[3] == 632, "doom fit %d,%d %dx%d", r[0], r[1], r[2], r[3]);
    dbr_fit(box, 1796, 632, r);
    CHECK(r[0] == 104 && r[1] == 88 && r[2] == 1796 && r[3] == 632, "gallery fit %d,%d %dx%d", r[0], r[1], r[2], r[3]);
    int area[4] = { 108, 82, 1790, 638 };
    dbr_fit(area, 320, 200, r);
    CHECK(r[0] == 492 && r[1] == 82 && r[2] == 1021 && r[3] == 638, "320x200 in the app area %d,%d %dx%d", r[0], r[1], r[2], r[3]);

    /* READY as the client reads it */
    struct dbr_ready rd = { 2, 3, 1920, 720, 60000, 0x500, 0, DBR_READY_HMI | DBR_READY_TOUCH, { 115, 88, 1773, 632 } };
    uint8_t ready[DBR_READY_SIZE];
    dbr_ready_encode(&rd, ready);
    CHECK(ready[0] == 2 && ready[2] == 3 && ready[4] == 0x80 && ready[5] == 7 && ready[6] == 0xd0 && ready[7] == 2, "ready head");
    CHECK(ready[12] == 0 && ready[13] == 5 && ready[20] == 6 && ready[24] == 115 && ready[26] == 88 && ready[28] == 0xed &&
          ready[29] == 0x06, "ready ids, flags, dst");

    /* TOUCH: kind, id, source, then i16 x, y (a contact dragged off the frame goes negative) */
    uint8_t t[8];
    dbr_touch_encode(DBR_TOUCH_MOTION, -3, 70000, t);
    CHECK(t[0] == 2 && t[1] == 0 && t[2] == DBR_TOUCH_SRC_EVDEV && t[4] == 0xfd && t[5] == 0xff && t[6] == 0xff && t[7] == 0x7f,
          "touch");
    uint8_t e[8];
    CHECK(dbr_error_encode(DBR_ERR_UNSUPPORTED, "abcdef", e, sizeof e) == 8 && e[0] == 3 && !memcmp(e + 4, "abcd", 4), "error");

    /* RECTS: regions and their pixels, as the client sends them */
    static uint8_t buf[1 << 16];
    int rects[DBR_MAX_RECTS][4];
    const uint8_t *px;
    const int two[2][4] = { { 0, 0, 10, 2 }, { 300, 190, 20, 10 } };
    size_t n = rects_payload(buf, two, 2);
    CHECK(dbr_rects(buf, n, 320, 200, 1, rects, &px) == 2 && rects[1][0] == 300 && rects[1][3] == 10 && px == buf + 4 + 16 &&
          px[10] == 7 && px[11] == 8 && px[20] == (uint8_t)(300 + 7 * 190), "two regions");
    CHECK(dbr_rects(buf, n - 1, 320, 200, 1, rects, &px) < 0, "short of pixels");
    CHECK(dbr_rects(buf, n + 1, 320, 200, 1, rects, &px) < 0, "pixels left over");
    const int out[1][4] = { { 310, 0, 11, 1 } };
    n = rects_payload(buf, out, 1);
    CHECK(dbr_rects(buf, n, 320, 200, 1, rects, &px) < 0, "region outside the frame");
    const int empty[1][4] = { { 0, 0, 0, 5 } };
    n = rects_payload(buf, empty, 1);
    CHECK(dbr_rects(buf, n, 320, 200, 1, rects, &px) < 0, "empty region");
    put16(buf, 0);
    CHECK(dbr_rects(buf, 4, 320, 200, 1, rects, &px) < 0, "no region");
    put16(buf, DBR_MAX_RECTS + 1);
    CHECK(dbr_rects(buf, sizeof buf, 320, 200, 1, rects, &px) < 0, "too many regions");
    /* overlapping regions adding up to more than a frame */
    const int over[2][4] = { { 0, 0, 4, 4 }, { 0, 0, 4, 4 } };
    n = rects_payload(buf, over, 2);
    CHECK(dbr_rects(buf, n, 4, 4, 1, rects, &px) < 0, "more than a frame of pixels");

    /* XRGB8888 (b, g, r, x) shows opaque; ARGB8888 keeps its alpha */
    uint8_t src[8] = { 1, 2, 3, 0, 4, 5, 6, 128 }, dst[8];
    dbr_to_rgba(dst, src, 2, DBR_FMT_XRGB8888);
    CHECK(dst[0] == 3 && dst[1] == 2 && dst[2] == 1 && dst[3] == 255 && dst[4] == 6 && dst[7] == 255, "xrgb");
    dbr_to_rgba(dst, src, 2, DBR_FMT_ARGB8888);
    CHECK(dst[3] == 0 && dst[4] == 6 && dst[6] == 4 && dst[7] == 128, "argb");

    /* the picture in the HMI's box: a 4x2 INDEX8 frame nearest-scaled into 8x4 at 2,1 of a 12x6 buffer */
    uint8_t pal[DBR_PALETTE_SIZE] = { 0 };
    for (int i = 0; i < 8; i++) { pal[3 * i] = (uint8_t)(10 * i); pal[3 * i + 1] = 1; pal[3 * i + 2] = 2; }
    uint32_t lut[256];
    dbr_palette_lut(pal, lut);
    CHECK(lut[3] == (0xff000000u | 30u << 16 | 1u << 8 | 2u), "lut");
    static uint32_t shot[12 * 6];
    memset(shot, 0xee, sizeof shot);
    const uint8_t idx[8] = { 0, 1, 2, 3, 4, 5, 6, 7 };
    int img[4] = { 2, 1, 8, 4 };
    dbr_blit((uint8_t *)shot, 12, 6, img, idx, 4, 2, DBR_FMT_INDEX8, lut);
    int black = 1, ok = 1;
    for (int y = 0; y < 6; y++)
        for (int x = 0; x < 12; x++) {
            int in = x >= 2 && x < 10 && y >= 1 && y < 5;
            if (!in) { black &= shot[y * 12 + x] == 0xff000000u; continue; }
            ok &= shot[y * 12 + x] == lut[idx[((y - 1) / 2) * 4 + (x - 2) / 2]];
        }
    CHECK(black, "black around the picture");
    CHECK(ok, "nearest pixels");
    /* XRGB (b, g, r, x) and RGBA (r, g, b, a) frames give the same words */
    const uint8_t xrgb[4] = { 3, 2, 1, 9 }, rgba[4] = { 1, 2, 3, 9 };
    int one[4] = { 0, 0, 2, 1 };
    uint32_t o2[2];
    dbr_blit((uint8_t *)o2, 2, 1, one, xrgb, 1, 1, DBR_FMT_XRGB8888, lut);
    CHECK(o2[0] == 0xff010203u && o2[1] == 0xff010203u, "xrgb blit %08x", o2[0]);
    dbr_blit((uint8_t *)o2, 2, 1, one, rgba, 1, 1, DBR_FMT_RGBA8888, lut);
    CHECK(o2[0] == 0xff010203u, "rgba blit %08x", o2[0]);

    printf("test_dbr: %d checks, %d failed\n", checks, fails);
    return fails != 0;
}
