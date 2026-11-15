/* CJK atlases across concurrent apps and repeated app launches, on Mesa EGL. */
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

static void picture(gfx_client *c) {
    uint32_t cmd[] = {
        OP_GLYPHS, 1, 0xffffffff, 1,
        fp(0), fp(0), fp(8), fp(16), fp(0), fp(0), fp(16), fp(16),
        OP_GLYPHS, 2, 0xffffffff, 1,
        fp(8), fp(0), fp(8), fp(16), fp(0), fp(0), fp(16), fp(16),
        OP_GLYPHS, 1, 0xffffffff, 1,
        fp(12), fp(0), fp(4), fp(16), fp(0), fp(0), fp(16), fp(16)
    };
    gfx_xf xf = { 1, 0, 0 };
    gfx_draw(c, &xf, 16, 16, cmd, sizeof cmd / sizeof *cmd, GFX_CLEAR);
    uint8_t px[16 * 16 * 4];
    glReadPixels(0, 0, 16, 16, GL_RGBA, GL_UNSIGNED_BYTE, px);
    CHECK(px[(8 * 16 + 4) * 4] > 245 && px[(8 * 16 + 10) * 4] < 10 &&
          px[(8 * 16 + 14) * 4] > 245, "mixed atlas batches keep glyph textures and draw order");
}

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

    gfx_client a = {0}, b = {0};
    uint8_t white[256], black[256] = {0};
    memset(white, 255, sizeof white);
    CHECK(!gfx_atlas(&a, 1, 16, 16, white) && !gfx_atlas(&a, 2, 16, 16, black), "two glyph textures upload");
    CHECK(!gfx_atlas(&b, 1, 16, 16, white) && !gfx_atlas(&b, 2, 16, 16, black), "another app shares the fonts");
    picture(&a);
    gfx_client_free(&a);
    picture(&b);
    gfx_client_free(&b);

    uint8_t *large = malloc(1024 * 4096);
    memset(large, 255, 1024 * 4096);
    gfx_client clients[4];
    memset(clients, 0, sizeof clients);
    int good = 1;
    for (int i = 0; i < 4; i++) good &= !gfx_atlas(&clients[i], 100 + i, 1024, 3000, large);
    CHECK(good, "four concurrent large CJK fonts exceed the old shared shelf without losing text");
    for (int i = 0; i < 4; i++) gfx_client_free(&clients[i]);
    CHECK(!gfx_atlas(&a, 1, 16, 16, white), "keep another app's font alive during repeated launches");
    good = 1;
    for (int i = 0; i < 200; i++) {
        gfx_client c = {0};
        good &= !gfx_atlas(&c, 1000 + i, 1024, 3000, large);
        gfx_client_free(&c);
    }
    CHECK(good, "200 app launches reclaim glyph textures instead of filling a permanent cache");
    gfx_client_free(&a);
    gfx_client full = {0}, shared = {0};
    good = 1;
    for (int i = 0; i < 16; i++) good &= !gfx_atlas(&full, 2000 + i, 1024, 4096, large);
    CHECK(good && gfx_atlas(&full, 3000, 1, 1, white) < 0, "global glyph memory is bounded at 64 MiB");
    CHECK(!gfx_atlas(&shared, 2000, 1024, 4096, large), "sharing an existing texture needs no extra memory");
    gfx_client_free(&full);
    CHECK(!gfx_atlas(&shared, 3000, 1024, 4096, large), "closing one app releases only its unshared fonts");
    gfx_client_free(&shared);
    free(large);
    CHECK(glGetError() == GL_NO_ERROR, "no GL errors");
    return fails ? 1 : 0;
}
