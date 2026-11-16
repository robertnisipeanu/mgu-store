/* Glyph atlas pages shared by app clients, on Mesa EGL. */
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "gfx.h"
#include "proto.h"

static int fails;
#define CHECK(c, msg) do { printf("%s %s\n", (c) ? "ok" : (fails++, "FAIL"), msg); } while (0)
static uint32_t fp(float f) { uint32_t n; memcpy(&n, &f, sizeof n); return n; }

#define RED 0xff0000ffu
#define GREEN 0x00ff00ffu

/* one glyph quad from atlas id, coloured col, covering x0..x1 of a 16x16 frame, sampled at atlas u..u+16 */
#define GLYPH(id, col, x0, x1, u) OP_GLYPHS, id, col, 1, fp(x0), fp(0), fp((x1) - (x0)), fp(16), fp(u), fp(u), fp((u) + 16), fp((u) + 16)

static uint8_t px[16 * 16 * 4];
static void draw(gfx_client *c, const uint32_t *cmd, size_t n) {
    gfx_xf xf = { 1, 0, 0 };
    gfx_draw(c, &xf, 16, 16, cmd, n, GFX_CLEAR);
    glReadPixels(0, 0, 16, 16, GL_RGBA, GL_UNSIGNED_BYTE, px);
}
static int red(int x) { const uint8_t *p = px + (8 * 16 + x) * 4; return p[0] > 245 && p[1] < 10; }
static int green(int x) { const uint8_t *p = px + (8 * 16 + x) * 4; return p[1] > 245 && p[0] < 10; }

int main(void) {
    EGLDisplay d = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    EGLint ca[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE }, n;
    EGLint xa[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE }, pa[] = { EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE };
    EGLConfig cfg;
    if (!eglInitialize(d, NULL, NULL) || !eglChooseConfig(d, ca, &cfg, 1, &n) || n < 1) return 1;
    eglBindAPI(EGL_OPENGL_ES_API);
    EGLContext ctx = eglCreateContext(d, cfg, EGL_NO_CONTEXT, xa);
    EGLSurface pb = eglCreatePbufferSurface(d, cfg, pa);
    if (!eglMakeCurrent(d, pb, pb, ctx) || gfx_init() < 0) return 1;

    uint8_t *opaque = malloc(1024 * 4096), *holed = malloc(1024 * 4096), clear[256] = {0};
    memset(opaque, 255, 1024 * 4096);
    memcpy(holed, opaque, 1024 * 4096);
    memset(holed, 0, 1024 * 16);                            /* rows 0..15 empty */
    int good;

    /* a font two apps share stays drawn for the one still open, also after another app's font is added */
    gfx_client a = {0}, b = {0}, e = {0};
    good = !gfx_atlas(&a, 1, 16, 16, opaque) && !gfx_atlas(&b, 1, 16, 16, opaque);
    gfx_client_free(&a);
    good &= !gfx_atlas(&e, 5, 16, 16, clear);
    uint32_t one[] = { GLYPH(1, RED, 0, 16, 0) };
    draw(&b, one, sizeof one / sizeof *one);
    gfx_client_free(&e);
    CHECK(good && red(4) && red(12), "a shared font survives when one of its apps closes");

    /* each launch's fonts are freed when it closes; 20 full columns exceed the 16 that fit in 64 MiB */
    good = 1;
    for (int i = 0; i < 20; i++) {
        gfx_client c = {0};
        good &= !gfx_atlas(&c, 1000 + i, 1024, 3000, opaque);
        gfx_client_free(&c);
    }
    draw(&b, one, sizeof one / sizeof *one);
    CHECK(good && red(8), "fonts are freed after their app closes");
    gfx_client_free(&b);

    /* 64 MiB holds 16 full-height columns; a font another app holds needs no more memory */
    gfx_client full = {0}, shared = {0};
    good = 1;
    for (int i = 0; i < 16; i++) good &= !gfx_atlas(&full, 2000 + i, 1024, 4096, opaque);
    CHECK(good && gfx_atlas(&full, 3000, 1, 1, opaque) < 0, "glyph textures are capped at 64 MiB");
    CHECK(!gfx_atlas(&shared, 2000, 1024, 4096, opaque), "sharing a held font needs no more memory");
    gfx_client_free(&full);
    gfx_client_free(&shared);

    /* page 0 full, so atlas 12 lands on page 1: quads keep their order and their page across the
       page change (each is sampled where the other page is empty) */
    gfx_client o = {0};
    good = !gfx_atlas(&o, 10, 1024, 4096, holed) && !gfx_atlas(&o, 11, 1024, 4096, opaque);
    glEnable(0xffff);                                       /* an unrelated GL error still pending */
    good &= !gfx_atlas(&o, 12, 16, 16, opaque);
    CHECK(good, "a font uploads while an older GL error is pending");
    uint32_t order[] = { GLYPH(10, RED, 0, 8, 100), GLYPH(12, GREEN, 4, 12, 0), GLYPH(10, RED, 10, 16, 100) };
    draw(&o, order, sizeof order / sizeof *order);
    CHECK(red(2) && green(6) && green(9) && red(11) && red(14), "glyphs on two pages draw in order");
    gfx_client_free(&o);

    free(opaque);
    free(holed);
    CHECK(glGetError() == GL_NO_ERROR, "no GL errors");
    return fails ? 1 : 0;
}
