/*
 * Embed mode's GL side (embed_gl.h).
 *
 * Zero-copy buffers are GBM buffer objects (libgbm, loaded when first needed: without it, or without a DRM device,
 * embed reads back), linear XRGB8888, so the compositor imports them by fd, stride and format alone (wl_drm's
 * create_prime_buffer has no modifiers). Each is imported into our own EGL display as an EGLImage, the texture of an
 * FBO. A frame's GL commands are flushed before it is committed; the GPU driver's implicit sync orders the
 * compositor's reads after them. With embed_finish the frame waits for the GPU (glFinish) instead, for a driver
 * whose buffers carry no implicit fence.
 *
 * Built with -DMGU_FAKE_DMABUF (test/test_embed.c), a "dmabuf" is a memfd that the frame is read into unturned, so
 * a mock compositor sees the bytes a GPU would have written there.
 */
#define _GNU_SOURCE
#include "embed_gl.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>

#include "gfx.h"
#include "log.h"
#include "proto.h"

#define MAXBUF 4
#define FOURCC_XRGB8888 0x34325258u            /* 'X' 'R' '2' '4' */
#ifndef GL_PIXEL_PACK_BUFFER
#define GL_PIXEL_PACK_BUFFER 0x88EB
#define GL_STREAM_READ 0x88E1
#define GL_MAP_READ_BIT 0x0001
#endif

static EGLDisplay dpy;
static EGLSurface surf;
static EGLContext ctx;
static int want_pbo, want_finish, read_bgra, inited;

/* readback */
static GLuint rb_tex, rb_fbo, pbo;
static uint8_t *rb_px;                          /* sync readback's rows, when not read as BGRA */
static uint8_t *pend_px;                        /* a started pixel-buffer readback's destination */
static int pend_w, pend_h;
static void *(*map_range)(GLenum, GLintptr, GLsizeiptr, GLbitfield);
static GLboolean (*unmap)(GLenum);

/* zero-copy */
#ifndef MGU_FAKE_DMABUF
struct gbm_device;
struct gbm_bo;
#endif
static struct {
    int fd; uint32_t stride; GLuint tex, fbo; EGLImageKHR img; uint8_t *map;
#ifndef MGU_FAKE_DMABUF
    struct gbm_bo *bo;
#endif
} B[MAXBUF];
static int nbuf, bw, bh;
static char failed[160];                        /* making the buffers failed: why (not tried again) */

static void current(void) { eglMakeCurrent(dpy, surf, surf, ctx); }

static void setup(void)
{
    if (inited) return;
    inited = 1;
    const char *ext = (const char *)glGetString(GL_EXTENSIONS);
    const char *ver = (const char *)glGetString(GL_VERSION);
    read_bgra = ext && strstr(ext, "GL_EXT_read_format_bgra") != NULL;
    if (want_pbo && ver && !strncmp(ver, "OpenGL ES 3", 11)) {
        map_range = (void *(*)(GLenum, GLintptr, GLsizeiptr, GLbitfield))eglGetProcAddress("glMapBufferRange");
        unmap = (GLboolean (*)(GLenum))eglGetProcAddress("glUnmapBuffer");
    }
}

void embed_gl_init(EGLDisplay d, EGLSurface s, EGLContext c, int use_pbo, int finish)
{
    dpy = d; surf = s; ctx = c; want_pbo = use_pbo; want_finish = finish;
    current();
    setup();
}

const char *embed_gl_readback_mode(void) { return map_range && unmap ? "pixel buffer" : "glReadPixels"; }

/* ---------------- zero-copy buffers ---------------- */
#ifndef MGU_FAKE_DMABUF
static struct {
    struct gbm_device *(*create_device)(int);
    struct gbm_bo *(*bo_create)(struct gbm_device *, uint32_t, uint32_t, uint32_t, uint32_t);
    void (*bo_destroy)(struct gbm_bo *);
    int (*bo_get_fd)(struct gbm_bo *);
    uint32_t (*bo_get_stride)(struct gbm_bo *);
} gbm;
static PFNEGLDESTROYIMAGEKHRPROC destroy_image;
#define GBM_BO_USE_RENDERING (1 << 2)
#define GBM_BO_USE_LINEAR (1 << 4)

static int alloc_bo(int i, int w, int h, char *why, size_t len)
{
    static struct gbm_device *dev;
    if (!dev) {
        void *lib = dlopen("libgbm.so.1", RTLD_NOW | RTLD_LOCAL);
        if (!lib) { snprintf(why, len, "no libgbm: %s", dlerror()); return -1; }
        gbm.create_device = (struct gbm_device *(*)(int))dlsym(lib, "gbm_create_device");
        gbm.bo_create = (struct gbm_bo *(*)(struct gbm_device *, uint32_t, uint32_t, uint32_t, uint32_t))dlsym(lib, "gbm_bo_create");
        gbm.bo_destroy = (void (*)(struct gbm_bo *))dlsym(lib, "gbm_bo_destroy");
        gbm.bo_get_fd = (int (*)(struct gbm_bo *))dlsym(lib, "gbm_bo_get_fd");
        gbm.bo_get_stride = (uint32_t (*)(struct gbm_bo *))dlsym(lib, "gbm_bo_get_stride");
        if (!gbm.create_device || !gbm.bo_create || !gbm.bo_get_fd || !gbm.bo_get_stride) {
            dlclose(lib);
            snprintf(why, len, "libgbm lacks gbm_bo_get_fd / gbm_bo_get_stride");
            return -1;
        }
        const char *node = "/dev/dri/renderD128";
        int fd = open(node, O_RDWR | O_CLOEXEC);
        if (fd < 0) { node = "/dev/dri/card0"; fd = open(node, O_RDWR | O_CLOEXEC); }
        if (fd < 0) { snprintf(why, len, "no DRM device: %s", strerror(errno)); return -1; }
        dev = gbm.create_device(fd);
        if (!dev) { close(fd); snprintf(why, len, "gbm_create_device(%s) failed", node); return -1; }
        log_info("embed: buffers from %s", node);
    }
    struct gbm_bo *bo = gbm.bo_create(dev, (uint32_t)w, (uint32_t)h, FOURCC_XRGB8888, GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR);
    if (!bo) { snprintf(why, len, "gbm_bo_create %dx%d XRGB8888 linear failed", w, h); return -1; }
    B[i].bo = bo;
    B[i].fd = gbm.bo_get_fd(bo);               /* kept, with the bo and the image, for later connections */
    B[i].stride = gbm.bo_get_stride(bo);
    if (B[i].fd < 0) { snprintf(why, len, "gbm_bo_get_fd failed"); return -1; }
    static PFNEGLCREATEIMAGEKHRPROC create_image;
    static PFNGLEGLIMAGETARGETTEXTURE2DOESPROC target_tex;
    if (!create_image) {
        const char *ext = eglQueryString(dpy, EGL_EXTENSIONS);
        if (!ext || !strstr(ext, "EGL_EXT_image_dma_buf_import")) { snprintf(why, len, "EGL lacks EGL_EXT_image_dma_buf_import"); return -1; }
        create_image = (PFNEGLCREATEIMAGEKHRPROC)eglGetProcAddress("eglCreateImageKHR");
        destroy_image = (PFNEGLDESTROYIMAGEKHRPROC)eglGetProcAddress("eglDestroyImageKHR");
        target_tex = (PFNGLEGLIMAGETARGETTEXTURE2DOESPROC)eglGetProcAddress("glEGLImageTargetTexture2DOES");
        if (!create_image || !target_tex) { create_image = NULL; snprintf(why, len, "no eglCreateImageKHR / glEGLImageTargetTexture2DOES"); return -1; }
    }
    EGLint a[] = { EGL_WIDTH, w, EGL_HEIGHT, h, EGL_LINUX_DRM_FOURCC_EXT, (EGLint)FOURCC_XRGB8888,
                   EGL_DMA_BUF_PLANE0_FD_EXT, B[i].fd, EGL_DMA_BUF_PLANE0_OFFSET_EXT, 0,
                   EGL_DMA_BUF_PLANE0_PITCH_EXT, (EGLint)B[i].stride, EGL_NONE };
    B[i].img = create_image(dpy, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, NULL, a);
    if (B[i].img == EGL_NO_IMAGE_KHR) { snprintf(why, len, "eglCreateImageKHR(dmabuf) failed 0x%x", eglGetError()); return -1; }
    glGenTextures(1, &B[i].tex);
    glBindTexture(GL_TEXTURE_2D, B[i].tex);
    target_tex(GL_TEXTURE_2D, (GLeglImageOES)B[i].img);
    return 0;
}
#else
static int alloc_bo(int i, int w, int h, char *why, size_t len)
{
    B[i].stride = (uint32_t)w * 4;
    B[i].fd = (int)syscall(SYS_memfd_create, "fake-dmabuf", 1u);
    if (B[i].fd < 0 || ftruncate(B[i].fd, (off_t)B[i].stride * h) < 0 ||
        (B[i].map = mmap(NULL, (size_t)B[i].stride * h, PROT_READ | PROT_WRITE, MAP_SHARED, B[i].fd, 0)) == MAP_FAILED) {
        B[i].map = NULL;
        snprintf(why, len, "memfd: %s", strerror(errno));
        return -1;
    }
    glGenTextures(1, &B[i].tex);
    glBindTexture(GL_TEXTURE_2D, B[i].tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    return 0;
}
#endif

static void free_bo(int i, int h)
{
    if (B[i].fbo) { glDeleteFramebuffers(1, &B[i].fbo); B[i].fbo = 0; }
    if (B[i].tex) { glDeleteTextures(1, &B[i].tex); B[i].tex = 0; }
#ifndef MGU_FAKE_DMABUF
    if (B[i].img != EGL_NO_IMAGE_KHR && destroy_image) destroy_image(dpy, B[i].img);
    B[i].img = EGL_NO_IMAGE_KHR;
    if (B[i].bo && gbm.bo_destroy) gbm.bo_destroy(B[i].bo);
    B[i].bo = NULL;
#else
    if (B[i].map) { munmap(B[i].map, (size_t)B[i].stride * h); B[i].map = NULL; }
#endif
    if (B[i].fd >= 0) { close(B[i].fd); B[i].fd = -1; }
    B[i].stride = 0;
}

int embed_gl_buffers(int n, int w, int h, int fd[], uint32_t stride[], char *why, size_t len)
{
    if (n > MAXBUF) n = MAXBUF;
    if (failed[0]) { snprintf(why, len, "%s", failed); return -1; }
    if (nbuf && (w != bw || h != bh)) { snprintf(why, len, "buffers made for %dx%d", bw, bh); return -1; }
    current();
    setup();
    for (int i = nbuf; i < n; i++) {
        B[i].fd = -1;
        B[i].img = EGL_NO_IMAGE_KHR;
        if (alloc_bo(i, w, h, why, len) < 0) goto fail;
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glGenFramebuffers(1, &B[i].fbo);
        glBindFramebuffer(GL_FRAMEBUFFER, B[i].fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, B[i].tex, 0);
        GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        if (st != GL_FRAMEBUFFER_COMPLETE) { snprintf(why, len, "dmabuf framebuffer incomplete 0x%x", st); goto fail; }
        nbuf = i + 1; bw = w; bh = h;
    }
    for (int i = 0; i < n; i++) { fd[i] = B[i].fd; stride[i] = B[i].stride; }
    return 0;
fail:
    for (int j = 0; j <= nbuf; j++) free_bo(j, h);
    nbuf = 0; bw = 0; bh = 0;
    snprintf(failed, sizeof failed, "%s", why);
    return -1;
}

/* ---------------- drawing ---------------- */
static int readback_target(int w, int h)
{
    if (rb_fbo) { glBindFramebuffer(GL_FRAMEBUFFER, rb_fbo); return 0; }
    if (!read_bgra && !(map_range && unmap) && !(rb_px = malloc((size_t)w * h * 4))) return -1;
    glGenTextures(1, &rb_tex); glBindTexture(GL_TEXTURE_2D, rb_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glGenFramebuffers(1, &rb_fbo); glBindFramebuffer(GL_FRAMEBUFFER, rb_fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, rb_tex, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        log_error("embed: framebuffer incomplete");
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glDeleteFramebuffers(1, &rb_fbo); rb_fbo = 0;
        glDeleteTextures(1, &rb_tex); rb_tex = 0;
        free(rb_px); rb_px = NULL;
        return -1;
    }
    if (map_range && unmap) {
        glGenBuffers(1, &pbo);
        glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo);
        glBufferData(GL_PIXEL_PACK_BUFFER, (GLsizeiptr)w * h * 4, NULL, GL_STREAM_READ);
        glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    }
    return 0;
}

int embed_gl_begin(int gpu, int w, int h)
{
    current();
    setup();
    if (gpu >= 0 && gpu < nbuf) glBindFramebuffer(GL_FRAMEBUFFER, B[gpu].fbo);
    else if (readback_target(w, h) < 0) return -1;
    return GFX_CLEAR | GFX_TOP_DOWN;
}

/* rows as read (top-down, drawn so), RGBA or BGRA -> XRGB8888 (bytes B G R X) */
static void convert(uint8_t *dst, const uint8_t *s, int w, int h, int bgra)
{
    size_t n = (size_t)w * h;
    if (bgra) { memcpy(dst, s, n * 4); return; }
    for (size_t i = 0; i < n; i++) {                    /* (dst may be s) */
        uint8_t r = s[i * 4], g = s[i * 4 + 1], b = s[i * 4 + 2];
        dst[i * 4] = b; dst[i * 4 + 1] = g; dst[i * 4 + 2] = r; dst[i * 4 + 3] = 255;
    }
}

static void read_into(uint8_t *dst, int w, int h)
{
    if (read_bgra) { glReadPixels(0, 0, w, h, GL_BGRA_EXT, GL_UNSIGNED_BYTE, dst); return; }
    glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, rb_px);
    convert(dst, rb_px, w, h, 0);
}

void embed_gl_end(int gpu, uint8_t *px, int w, int h)
{
    if (gpu >= 0 && gpu < nbuf) {
#ifdef MGU_FAKE_DMABUF
        glReadPixels(0, 0, w, h, read_bgra ? GL_BGRA_EXT : GL_RGBA, GL_UNSIGNED_BYTE, B[gpu].map);
        if (!read_bgra) convert(B[gpu].map, B[gpu].map, w, h, 0);
#else
        if (want_finish) glFinish();
        else glFlush();
#endif
    } else if (pbo) {
        glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo);
        glReadPixels(0, 0, w, h, read_bgra ? GL_BGRA_EXT : GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        glFlush();
        pend_px = px; pend_w = w; pend_h = h;
    } else {
        read_into(px, w, h);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

/* the picture is an image of a private client, drawn to the nearest pixel over opaque black: the GL driver writes
   the dmabuf, so it need not be mappable, and the compositor gets a finished frame as from a GL draw */
int embed_gl_picture(int gpu, const uint8_t *rgba, int pw, int ph, const int img[4], int w, int h)
{
    static gfx_client pc;
    if (gpu < 0 || gpu >= nbuf) return -1;
    current();
    setup();
    for (int k = 0; k < 8 && glGetError() != GL_NO_ERROR; k++) {}   /* only this picture's errors count below */
    pc.upstream_ops = 1;
    if (gfx_image_upstream(&pc, 1, pw, ph, rgba) < 0) { log_warn("embed: %s", gfx_error()); return -1; }
    float f[4] = { (float)img[0], (float)img[1], (float)img[2], (float)img[3] };
    uint32_t ops[9] = { OP_CLEAR, 0x000000ffu, OP_IMAGE, 1, 0 };
    memcpy(&ops[5], f, sizeof f);
    glBindFramebuffer(GL_FRAMEBUFFER, B[gpu].fbo);
    gfx_xf xf = { 1, 0, 0 };
    gfx_draw(&pc, &xf, w, h, ops, 9, GFX_TOP_DOWN);
    embed_gl_end(gpu, NULL, w, h);
    GLenum e = glGetError();
    if (e != GL_NO_ERROR) log_warn("embed: drawing pixels into a GPU buffer: GL error 0x%x", e);
    return e == GL_NO_ERROR ? 0 : -1;
}

void embed_gl_resolve(void)
{
    if (!pend_px) return;
    current();
    glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo);
    const uint8_t *s = map_range(GL_PIXEL_PACK_BUFFER, 0, (GLsizeiptr)pend_w * pend_h * 4, GL_MAP_READ_BIT);
    if (s) convert(pend_px, s, pend_w, pend_h, read_bgra);
    else log_warn("embed: mapping the pixel buffer failed 0x%x", glGetError());
    unmap(GL_PIXEL_PACK_BUFFER);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    pend_px = NULL;
}

void embed_gl_cancel(void) { pend_px = NULL; }
