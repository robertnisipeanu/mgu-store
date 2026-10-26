/* Dialect detection and HELLO parsing (src/dialect.c), as each kit sends its messages. */
#include <stdio.h>
#include <string.h>

#include "dialect.h"
#include "proto.h"

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static unsigned char buf[1 << 20];

static size_t put32(size_t at, uint32_t v) { memcpy(buf + at, &v, 4); return at + 4; }
static size_t putf(size_t at, float v) { memcpy(buf + at, &v, 4); return at + 4; }

/* upstream M_IMAGE: id, w, h, w*h*4 */
static uint32_t up_image(uint32_t id, uint32_t w, uint32_t h) {
    size_t at = put32(0, id); at = put32(at, w); at = put32(at, h);
    memset(buf + at, 0x55, (size_t)w * h * 4);
    return (uint32_t)(at + (size_t)w * h * 4);
}
/* iterio M_CLAIM: n, rects */
static uint32_t it_claim(int n, const float (*r)[4]) {
    size_t at = put32(0, (uint32_t)n);
    for (int i = 0; i < n; i++) for (int k = 0; k < 4; k++) at = putf(at, r[i][k]);
    return (uint32_t)at;
}

int main(void) {
    /* 9: upstream image vs iterio claim */
    uint32_t len = up_image(1, 320, 200);
    CHECK(dialect_of(9, buf, len) == DIALECT_UPSTREAM, "doom frame is an upstream image");
    len = up_image(0, 1, 1);
    CHECK(dialect_of(9, buf, len) == DIALECT_UPSTREAM, "1x1 image id 0");
    len = up_image(2, 8, 8);         /* also reads as a valid claim of 2 rects with denormal x, y: the image wins */
    CHECK(dialect_of(9, buf, len) == DIALECT_UPSTREAM, "image id 2 8x8");
    len = up_image(1, 1, 2);
    CHECK(dialect_of(9, buf, len) == DIALECT_UPSTREAM, "image 1x2 (20 bytes, the size of a 1-rect claim)");
    const float r1[1][4] = { { 0, 0, 1920, 720 } };
    len = it_claim(1, r1);
    CHECK(dialect_of(9, buf, len) == DIALECT_ITERIO, "claim of the whole screen");
    const float r3[3][4] = { { 12.5f, 80, 300, 120 }, { -4, 0, 10, 10 }, { 1e6f, 1, 2, 3 } };
    len = it_claim(3, r3);
    CHECK(dialect_of(9, buf, len) == DIALECT_ITERIO, "claim of 3 rects");
    len = it_claim(0, NULL);
    CHECK(dialect_of(9, buf, len) == DIALECT_ITERIO, "claim of none");
    const float r16[16][4] = { { 1, 1, 1, 1 } };
    len = it_claim(16, r16);
    CHECK(dialect_of(9, buf, len) == DIALECT_ITERIO, "claim of 16");
    put32(0, 17);
    CHECK(dialect_of(9, buf, 4 + 17 * 16) == DIALECT_UNKNOWN, "claim of 17 fits neither");
    CHECK(dialect_of(9, buf, 2) == DIALECT_UNKNOWN, "short message 9");
    /* every claim with whole-pixel coordinates in range, 1 rect */
    int bad = 0;
    for (int x = -64; x <= 2880 && !bad; x += 7)
        for (int y = -64; y <= 960 && !bad; y += 11) {
            const float r[1][4] = { { (float)x, (float)y, 100, 50 } };
            len = it_claim(1, r);
            if (dialect_of(9, buf, len) != DIALECT_ITERIO) bad = 1;
        }
    CHECK(!bad, "claims at every position read as claims");
    /* 10: upstream grab vs iterio image */
    put32(0, 1);
    CHECK(dialect_of(10, buf, 4) == DIALECT_UPSTREAM, "grab 1");
    put32(0, 0);
    CHECK(dialect_of(10, buf, 4) == DIALECT_UPSTREAM, "grab 0");
    len = up_image(7, 64, 64);       /* same layout as an iterio picture */
    CHECK(dialect_of(10, buf, len) == DIALECT_ITERIO, "picture 64x64");
    len = up_image(7, 1, 1);
    CHECK(dialect_of(10, buf, len) == DIALECT_ITERIO, "picture 1x1");
    CHECK(dialect_of(10, buf, len + 4) == DIALECT_UNKNOWN, "picture with a wrong length");
    CHECK(dialect_of(10, buf, 8) == DIALECT_UNKNOWN, "8-byte message 10");
    /* 11: iterio only; shared ones never decide */
    CHECK(dialect_of(11, buf, 4) == DIALECT_ITERIO, "drop image");
    for (uint32_t t = 1; t <= 8; t++) CHECK(dialect_of(t, buf, 28) == DIALECT_UNKNOWN, "shared message %u", t);
    CHECK(dialect_of(X_MODE, buf, 4) == DIALECT_UNKNOWN, "native message");

    /* HELLO */
    char app[64];
    CHECK(hello_parse((const uint8_t *)"car_vitals", 10, app, sizeof app) == 0 && !strcmp(app, "car_vitals"), "legacy hello");
    static const char nat[] = "doom\0proto=mgu-render/1";
    CHECK(hello_parse((const uint8_t *)nat, sizeof nat - 1, app, sizeof app) == 1 && !strcmp(app, "doom"), "native hello");
    static const char nat2[] = "x\0mode=embed\0proto=mgu-render/12\0";
    CHECK(hello_parse((const uint8_t *)nat2, sizeof nat2 - 1, app, sizeof app) == 12, "native hello, later field, trailing NUL");
    static const char bad1[] = "x\0proto=mgu-render/";
    CHECK(hello_parse((const uint8_t *)bad1, sizeof bad1 - 1, app, sizeof app) == 0, "no version");
    static const char bad2[] = "x\0proto=mgu-render/1x";
    CHECK(hello_parse((const uint8_t *)bad2, sizeof bad2 - 1, app, sizeof app) == 0, "bad version");
    static const char bad3[] = "x proto=mgu-render/1";
    CHECK(hello_parse((const uint8_t *)bad3, sizeof bad3 - 1, app, sizeof app) == 0 && !strcmp(app, "x proto=mgu-render/1"), "token in the id");
    static const char ctl[] = "a\nb\x7f";
    CHECK(hello_parse((const uint8_t *)ctl, 4, app, sizeof app) == 0 && !strcmp(app, "a?b?"), "control characters");
    char longid[200];
    memset(longid, 'z', sizeof longid);
    CHECK(hello_parse((const uint8_t *)longid, sizeof longid, app, sizeof app) == 0 && strlen(app) == 63, "long id truncated");

    printf("%s: %d checks, %d failed\n", fails ? "FAIL" : "ok  ", checks, fails);
    return fails != 0;
}
