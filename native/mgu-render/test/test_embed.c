/*
 * Embed's buffer paths (embed.c, embed_gl.c built with -DMGU_FAKE_DMABUF) against test/mock_hmi, on Mesa's surfaceless
 * EGL. Each scenario draws the same frames; the mock reports what each commit holds (CRC of B G R, rows top-down),
 * and every path must give the same bytes: the frame as GL draws it top-down (GFX_TOP_DOWN). That frame must also
 * match the frame drawn the usual way up and turned on the CPU, up to the rounding of anti-aliased edges (a few
 * levels on under 1% of the pixels: a triangle rasterised the other way up).
 *   EGL_PLATFORM=surfaceless build/host/test_embed build/host/mock_hmi
 */
#define _GNU_SOURCE
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "embed.h"
#include "embed_gl.h"
#include "gfx.h"
#include "proto.h"

#define W 1796
#define H 632
#define FRAMES 5

static int fails, ready_seen, frames_done;
#define CHECK(cond, ...) do { if (cond) { printf("ok   "); printf(__VA_ARGS__); puts(""); } \
                              else { printf("FAIL "); printf(__VA_ARGS__); puts(""); fails++; } } while (0)

void embed_frame_done(void) { frames_done++; }
void embed_changed(void) { if (embed_connected()) ready_seen = 1; }

static uint32_t crc_table[256];
static uint32_t crc32_rgb(const uint8_t *p, int w, int h)
{
    uint32_t c = 0xffffffffu;
    for (size_t i = 0; i < (size_t)w * h; i++)
        for (int k = 0; k < 3; k++) c = crc_table[(c ^ p[i * 4 + k]) & 0xff] ^ (c >> 8);
    return c ^ 0xffffffffu;
}

static uint32_t fbits(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }

/* frame k: shapes near every edge, a clip, a line and a cached layer, so a frame turned or shifted shows */
static size_t frame_ops(int k, uint32_t *o)
{
    size_t n = 0;
#define F(v) (o[n++] = fbits((float)(v)))
#define U(v) (o[n++] = (uint32_t)(v))
    U(OP_CLEAR); U(0x202830ffu + (uint32_t)k * 0x01000000u);
    U(OP_RECT); F(10 + k * 7); F(5); F(200); F(40); U(0xff0000ffu);
    U(OP_RRECT); F(300); F(400 + k); F(500); F(120); F(24); U(0x30c060ffu);
    U(OP_GRAD); F(900); F(50); F(300); F(500); U(2); F(0); U(0x0000ffffu); F(1); U(0xffff00ffu);
    U(OP_CLIP); F(1000); F(100); F(200); F(100);
    U(OP_RECT); F(950); F(50); F(400); F(400); U(0xffffff80u);
    U(OP_NOCLIP);
    U(OP_LINE); F(50); F(600); F(1700); F(30 + k * 10); F(3); U(0xffffffffu);
    U(OP_LAYER); U(1); F(1400); F(300 + k * 3);
#undef F
#undef U
    return n;
}

static gfx_client g;
static gfx_xf xf = { 1, 0, 0 };

static void define_layer(void)
{
    uint32_t o[32]; size_t n = 0;
#define F(v) (o[n++] = fbits((float)(v)))
#define U(v) (o[n++] = (uint32_t)(v))
    U(OP_RRECT); F(0); F(0); F(200); F(100); F(16); U(0xff8000ffu);
    U(OP_RECT); F(10); F(10); F(50); F(20); U(0x000000ffu);
#undef F
#undef U
    if (gfx_layer_def(&g, 1, 200, 100, 1, o, n) < 0) { printf("FAIL layer: %s\n", gfx_error()); exit(1); }
}

/* each frame drawn top-down and read unturned: crc, the bytes every path must commit. Checked against the frame drawn
   the usual way up and turned on the CPU: at most 1% of the pixels differ, each channel by at most 16. */
static void reference(uint32_t crc[FRAMES], int check)
{
    GLuint tex, fbo;
    glGenTextures(1, &tex); glBindTexture(GL_TEXTURE_2D, tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glGenFramebuffers(1, &fbo); glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
    size_t np = (size_t)W * H;
    uint8_t *td = malloc(np * 4), *up = malloc(np * 4), *x = malloc(np * 4);
    uint32_t ops[256];
    for (int k = 0; k < FRAMES; k++) {
        gfx_draw(&g, &xf, W, H, ops, frame_ops(k, ops), GFX_CLEAR | GFX_TOP_DOWN);
        glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, td);
        for (size_t i = 0; i < np; i++) { x[i * 4] = td[i * 4 + 2]; x[i * 4 + 1] = td[i * 4 + 1]; x[i * 4 + 2] = td[i * 4]; }
        crc[k] = crc32_rgb(x, W, H);
        if (!check) continue;
        gfx_draw(&g, &xf, W, H, ops, frame_ops(k, ops), GFX_CLEAR);
        glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, up);
        size_t nd = 0; int md = 0;
        for (int y = 0; y < H; y++)
            for (int i = 0; i < W; i++) {
                const uint8_t *a = td + ((size_t)y * W + i) * 4, *b = up + ((size_t)(H - 1 - y) * W + i) * 4;
                int d = 0;
                for (int c = 0; c < 3; c++) if (abs(a[c] - b[c]) > d) d = abs(a[c] - b[c]);
                if (d) { nd++; if (d > md) md = d; }
            }
        CHECK(nd <= np / 100 && md <= 16, "frame %d top-down = the usual way up turned (%zu px differ, by up to %d)", k, nd, md);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteFramebuffers(1, &fbo); glDeleteTextures(1, &tex);
    free(td); free(up); free(x);
}

static void pump(int ms)
{
    struct pollfd p;
    embed_prepare(&p);
    poll(&p, p.fd >= 0 ? 1 : 0, ms);
    embed_dispatch(&p);
}

struct scenario { const char *name, *mock_flags; int zero_copy, pbo; const char *path; int check; };

static int run(const struct scenario *sc, const char *mock)
{
    char dir[] = "/tmp/test-embed-XXXXXX";
    if (!mkdtemp(dir)) { perror("mkdtemp"); return 1; }
    setenv("XDG_RUNTIME_DIR", dir, 1);
    int out[2];
    if (pipe(out) < 0) return 1;
    pid_t pid = fork();
    if (pid == 0) {
        dup2(out[1], 1); close(out[0]);
        char flags[64]; snprintf(flags, sizeof flags, "%s", sc->mock_flags);
        char *argv[8] = { (char *)mock, "hmi" }; int a = 2;
        for (char *t = strtok(flags, " "); t && a < 7; t = strtok(NULL, " ")) argv[a++] = t;
        argv[a] = NULL;
        execv(mock, argv);
        _exit(127);
    }
    close(out[1]);
    FILE *mo = fdopen(out[0], "r");
    char line[256];
    if (!fgets(line, sizeof line, mo)) { printf("FAIL %s: mock did not start\n", sc->name); return 1; }

    EGLDisplay d = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    EGLint ca[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE }, n;
    EGLint xa[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE }, pa[] = { EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE };
    EGLConfig cfg;
    if (!eglInitialize(d, NULL, NULL) || !eglChooseConfig(d, ca, &cfg, 1, &n) || n < 1) { puts("FAIL no EGL"); return 1; }
    eglBindAPI(EGL_OPENGL_ES_API);
    EGLContext ctx = eglCreateContext(d, cfg, EGL_NO_CONTEXT, xa);
    EGLSurface pb = eglCreatePbufferSurface(d, cfg, pa);
    if (!eglMakeCurrent(d, pb, pb, ctx) || gfx_init() < 0) { puts("FAIL no GL context"); return 1; }
    define_layer();
    uint32_t ref[FRAMES];
    reference(ref, sc->check);
    embed_gl_init(d, pb, ctx, sc->pbo, 0);

    embed_connect("hmi", 0x500, W, H, sc->zero_copy);
    for (int t = 0; t < 100 && !ready_seen; t++) pump(50);
    CHECK(ready_seen, "%s: connected", sc->name);
    CHECK(strncmp(embed_path(), sc->path, strlen(sc->path)) == 0, "%s: path \"%s\"", sc->name, embed_path());
    CHECK((embed_pixels(0) == NULL) == embed_zero_copy(), "%s: shared memory allocated only for readback", sc->name);
    embed_show(1);
    uint32_t ops[256];
    int drawn = 0;
    for (int k = 0; k < FRAMES; k++) {
        int b = -1;
        for (int t = 0; t < 100 && (b = embed_buffer(embed_zero_copy())) < 0; t++) pump(20);
        if (b < 0) { printf("FAIL %s: no free buffer\n", sc->name); fails++; break; }
        int gpu = embed_gpu_index(b), fl = embed_gl_begin(gpu, W, H);
        gfx_draw(&g, &xf, W, H, ops, frame_ops(k, ops), fl);
        embed_gl_end(gpu, embed_pixels(b), W, H);
        embed_filled();
        for (int t = 0; t < 100 && !embed_can_commit(); t++) pump(20);
        embed_gl_resolve();
        embed_commit();
        drawn++;
        pump(0);
    }
    /* zero-copy: a picture made on the CPU (a display-bridge app's pixels) goes into a GPU buffer too, scaled by GL
       to the nearest pixel into its place (twice its size here), black around it */
    uint32_t pix_crc = 0;
    if (embed_zero_copy()) {
        enum { PW = W / 4, PH = H / 4 };
        int img[4] = { (W - 2 * PW) / 2, (H - 2 * PH) / 2, 2 * PW, 2 * PH };
        uint8_t *pic = malloc((size_t)PW * PH * 4), *px = calloc((size_t)W * H, 4);
        for (size_t i = 0; i < (size_t)PW * PH; i++) { pic[i * 4] = (uint8_t)i; pic[i * 4 + 1] = (uint8_t)(i >> 8); pic[i * 4 + 2] = (uint8_t)(i / PW); pic[i * 4 + 3] = 255; }
        for (int y = 0; y < img[3]; y++)                 /* the frame expected, as the compositor reads it: b, g, r, x */
            for (int x = 0; x < img[2]; x++) {
                const uint8_t *s = pic + ((size_t)(y / 2) * PW + x / 2) * 4;
                uint8_t *d = px + ((size_t)(img[1] + y) * W + img[0] + x) * 4;
                d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; d[3] = 255;
            }
        pix_crc = crc32_rgb(px, W, H);
        int b = -1;
        for (int t = 0; t < 100 && (b = embed_buffer(1)) < 0; t++) pump(20);
        CHECK(b >= 0 && embed_gl_picture(embed_gpu_index(b), pic, PW, PH, img, W, H) == 0, "%s: a picture drawn into a GPU buffer", sc->name);
        free(pic);
        embed_filled();
        for (int t = 0; t < 100 && !embed_can_commit(); t++) pump(20);
        embed_commit();
        drawn++;
        free(px);
    }
    for (int t = 0; t < 100 && frames_done < drawn; t++) pump(20);
    CHECK(frames_done == drawn, "%s: %d frame callbacks for %d commits", sc->name, frames_done, drawn);
    embed_disconnect();
    kill(pid, SIGTERM);
    waitpid(pid, NULL, 0);

    int k = 0, bad = 0, viol = 0;
    const char *kind = !strcmp(sc->path, "zero-copy") ? "drm" : "shm";
    while (fgets(line, sizeof line, mo)) {
        char what[8]; int w, h; unsigned crc;
        if (!strncmp(line, "VIOLATION", 9)) { printf("     %s", line); viol++; continue; }
        if (sscanf(line, "commit %7s %d %d %x", what, &w, &h, &crc) != 4) continue;
        uint32_t want = k < FRAMES ? ref[k] : pix_crc;
        if (k > FRAMES || (k == FRAMES && !pix_crc) || strcmp(what, kind) || w != W || h != H || crc != want) {
            printf("     frame %d: %s %dx%d %08x, expected %s %08x\n", k, what, w, h, crc, kind, want);
            bad++;
        }
        k++;
    }
    CHECK(k == FRAMES + (pix_crc != 0) && !bad, "%s: %d %s frames, each as drawn", sc->name, k, kind);
    CHECK(!viol, "%s: buffers attached only when free, dmabufs fit", sc->name);
    fclose(mo);
    rmdir(dir);
    return fails ? 1 : 0;
}

int main(int argc, char **argv)
{
    if (argc < 2) { fprintf(stderr, "usage: %s MOCK_HMI\n", argv[0]); return 2; }
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
        crc_table[i] = c;
    }
    static const struct scenario S[] = {
        { "zero-copy", "--drm", 1, 1, "zero-copy", 1 },
        { "readback, off", "--drm", 0, 0, "readback (embed_zero_copy = 0)", 0 },
        { "readback, pixel buffer", "", 1, 1, "readback (the compositor offers no wl_drm)", 0 },
        { "readback, no PRIME", "--drm --no-prime", 1, 0, "readback (the compositor's wl_drm takes no dmabufs", 0 },
        { "readback, refused", "--drm --refuse", 1, 1, "readback (the compositor refused the GPU buffers", 0 },
    };
    int rc = 0;
    for (size_t i = 0; i < sizeof S / sizeof S[0]; i++) {
        fflush(stdout);
        pid_t p = fork();                     /* each scenario with its own GL context and embed state */
        if (p == 0) { int r = run(&S[i], argv[1]); fflush(stdout); _exit(r); }
        int st = 0;
        waitpid(p, &st, 0);
        if (!WIFEXITED(st) || WEXITSTATUS(st)) rc = 1;
    }
    puts(rc ? "test_embed: FAILED" : "test_embed: all passed");
    return rc;
}
