/*
 * Embed mode's display (embed.h), from display-bridge's target hmi (backend_wayland.c).
 *
 * Nothing here waits for the HMI's compositor: it serves its clients from the HMI's own loop, which
 * may be busy or idle for a while, and the layer apps must not wait with it (only the first apps after
 * the renderer starts wait, up to 3 s, for its first answer: main.c). Setup, surface changes
 * and buffer reuse after a surface is gone all complete on wl_callback.done in the event loop.
 *
 * Setup takes up to three round trips: the globals; wl_drm's device, formats and capabilities (when it is
 * offered); the GPU buffers accepted (the compositor imports a dmabuf as it is wrapped, and refuses one it cannot
 * import with a protocol error on wl_drm, which ends the connection: the next one reads back, at once).
 */
#define _GNU_SOURCE
#include "embed.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#include <wayland-client.h>

#include "embed_gl.h"
#include "ivi-application-client-protocol.h"
#include "log.h"
#include "wayland-drm-client-protocol.h"

#define NSHM 4                    /* one shown, one the compositor has not released yet, one committed, one drawn */
#define NGPU 3                    /* one shown, one committed, one drawn */
#define NB (NSHM + NGPU)          /* buffers 0..NSHM-1 shared memory, then the GPU ones */
#define SETUP_MS 5000

enum { OFF, CONNECTING, READY };
enum { SYNC_GLOBALS, SYNC_DRM, SYNC_BUFFERS };

static struct {
    int state, stage;
    int64_t since;
    struct wl_display *dpy;
    struct wl_registry *reg;
    struct wl_callback *sync;     /* setup, or a destroyed surface's buffers coming back */
    struct wl_compositor *comp;
    struct wl_shm *shm;
    struct ivi_application *iapp;
    struct wl_drm *drm;
    char drm_device[64];
    int drm_caps, drm_xrgb;
    struct wl_surface *surface;
    struct ivi_surface *isurf;
    struct wl_callback *frame_cb;
    uint64_t commit_us, cb_sum, cb_max;   /* the last commit; commit-to-callback times since embed_callbacks */
    unsigned cb_n;
    struct wl_buffer *buf[NB];
    int held[NB];                 /* committed, not released yet */
    int ngpu;                     /* GPU buffers on this connection */
    int reclaiming;               /* the surface is gone; buffers are ours once the compositor confirms */
    uint8_t *map;
    size_t map_size;
    int w, h, cur, ready, reading;   /* cur: being drawn; ready: drawn, not committed yet (-1: none) */
    int failed;                   /* set inside a callback: disconnect once dispatch has returned */
    uint32_t id;
    int zero_copy;                /* asked for */
    char display[64];
    char globals[1024];
    char path[200];               /* "zero-copy" or "readback (<why>)" */
    char why[160];                /* why readback */
    char refused[160];            /* the compositor refused our GPU buffers: why (later connections read back) */
} E = { .cur = -1, .ready = -1 };

static void drm_device(void *d, struct wl_drm *drm, const char *name)
{
    (void)d, (void)drm;
    snprintf(E.drm_device, sizeof E.drm_device, "%s", name);
}
static void drm_format(void *d, struct wl_drm *drm, uint32_t f)
{
    (void)d, (void)drm;
    if (f == WL_DRM_FORMAT_XRGB8888) E.drm_xrgb = 1;
}
static void drm_authenticated(void *d, struct wl_drm *drm) { (void)d, (void)drm; }
static void drm_capabilities(void *d, struct wl_drm *drm, uint32_t v)
{
    (void)d, (void)drm;
    E.drm_caps = (int)v;
}
static const struct wl_drm_listener drm_listener = { drm_device, drm_format, drm_authenticated, drm_capabilities };

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver)
{
    (void)d;
    size_t n = strlen(E.globals);
    snprintf(E.globals + n, sizeof E.globals - n, "%s%s v%u", n ? ", " : "", iface, ver);
    if (!strcmp(iface, wl_compositor_interface.name))
        E.comp = wl_registry_bind(r, name, &wl_compositor_interface, ver < 4 ? ver : 4);
    else if (!strcmp(iface, wl_shm_interface.name))
        E.shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
    else if (!strcmp(iface, ivi_application_interface.name))
        E.iapp = wl_registry_bind(r, name, &ivi_application_interface, 1);
    else if (!strcmp(iface, wl_drm_interface.name) && !E.drm) {
        E.drm = wl_registry_bind(r, name, &wl_drm_interface, ver < 2 ? ver : 2);
        wl_drm_add_listener(E.drm, &drm_listener, NULL);
    }
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d, (void)r, (void)n; }
static const struct wl_registry_listener reg_listener = { reg_global, reg_remove };

static void release(void *d, struct wl_buffer *b)
{
    (void)b;
    E.held[(intptr_t)d] = 0;
}
static const struct wl_buffer_listener buf_listener = { release };

static void lost(const char *what)
{
    int err = E.dpy ? wl_display_get_error(E.dpy) : 0, retry = 0;
    if (err == EPROTO) {
        const struct wl_interface *iface = NULL;
        uint32_t oid = 0, code = wl_display_get_protocol_error(E.dpy, &iface, &oid);
        if (iface == &wl_drm_interface) {
            snprintf(E.refused, sizeof E.refused, "the compositor refused the GPU buffers: wl_drm error %u", code);
            log_warn("embed: %s; reading back from now on", E.refused);
            retry = 1;
        } else {
            log_error("embed: %s: protocol error %u on %s@%u (surface id %#x held by another producer?)", what, code,
                      iface ? iface->name : "?", oid, E.id);
        }
    } else {
        log_error("embed: %s: %s", what, strerror(err ? err : errno));
    }
    char display[sizeof E.display];
    snprintf(display, sizeof display, "%s", E.display);
    embed_disconnect();
    if (retry)
        embed_connect(display, E.id, E.w, E.h, E.zero_copy);
}

void embed_readback(const char *why)
{
    char display[sizeof E.display];
    snprintf(display, sizeof display, "%s", E.display);
    snprintf(E.refused, sizeof E.refused, "%s", why);
    log_warn("embed: %s; reading back from now on", why);
    embed_disconnect();
    embed_connect(display, E.id, E.w, E.h, E.zero_copy);
}

static int shm_buffers(void)
{
    size_t one = (size_t)E.w * E.h * 4;
    E.map_size = one * NSHM;
    int fd = (int)syscall(SYS_memfd_create, "mgu-render-embed", 1u /* MFD_CLOEXEC */);
    if (fd < 0 || ftruncate(fd, (off_t)E.map_size) < 0 ||
        (E.map = mmap(NULL, E.map_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)) == MAP_FAILED) {
        log_error("embed: %zu bytes of shared memory: %s", E.map_size, strerror(errno));
        E.map = NULL;
        E.map_size = 0;
        if (fd >= 0) close(fd);
        return -1;
    }
    struct wl_shm_pool *pool = wl_shm_create_pool(E.shm, fd, (int32_t)E.map_size);
    for (int i = 0; i < NSHM; i++) {
        E.buf[i] = wl_shm_pool_create_buffer(pool, (int32_t)(one * i), E.w, E.h, E.w * 4, WL_SHM_FORMAT_XRGB8888);
        wl_buffer_add_listener(E.buf[i], &buf_listener, (void *)(intptr_t)i);
        E.held[i] = 0;
    }
    wl_shm_pool_destroy(pool);
    close(fd);
    return 0;
}

/* GPU buffers, when everything for them is there: 1 (wrapped, the compositor's answer pending), else 0 with the
   reason in E.path */
static int gpu_buffers(void)
{
    char why[160];
    int fd[NGPU];
    uint32_t stride[NGPU];
    if (!E.zero_copy) snprintf(why, sizeof why, "embed_zero_copy = 0");
    else if (E.refused[0]) snprintf(why, sizeof why, "%s", E.refused);
    else if (!E.drm) snprintf(why, sizeof why, "the compositor offers no wl_drm");
    else if (wl_proxy_get_version((struct wl_proxy *)E.drm) < 2 || !(E.drm_caps & WL_DRM_CAPABILITY_PRIME))
        snprintf(why, sizeof why, "the compositor's wl_drm takes no dmabufs (no PRIME)");
    else if (!E.drm_xrgb) snprintf(why, sizeof why, "the compositor's wl_drm lacks XRGB8888");
    else if (embed_gl_buffers(NGPU, E.w, E.h, fd, stride, why, sizeof why) == 0) {
        for (int i = 0; i < NGPU; i++) {
            E.buf[NSHM + i] = wl_drm_create_prime_buffer(E.drm, fd[i], E.w, E.h, WL_DRM_FORMAT_XRGB8888,
                                                         0, (int32_t)stride[i], 0, 0, 0, 0);
            wl_buffer_add_listener(E.buf[NSHM + i], &buf_listener, (void *)(intptr_t)(NSHM + i));
            E.held[NSHM + i] = 0;
        }
        E.ngpu = NGPU;
        snprintf(E.path, sizeof E.path, "zero-copy");
        log_info("embed: %d dmabufs %dx%d XRGB8888 (stride %u) through wl_drm (%s)", NGPU, E.w, E.h, stride[0],
                 E.drm_device[0] ? E.drm_device : "?");
        return 1;
    }
    snprintf(E.why, sizeof E.why, "%s", why);
    snprintf(E.path, sizeof E.path, "readback (%s)", why);
    return 0;
}

static void sync_start(void);

static void setup_done(void)
{
    E.state = READY;
    if (E.ngpu) log_info("embed: zero-copy, surface %#x %dx%d while shown", E.id, E.w, E.h);
    else log_info("embed: readback fallback (%s), by %s, surface %#x %dx%d while shown", E.why, embed_gl_readback_mode(),
                  E.id, E.w, E.h);
    embed_changed();
}

static void synced(void *d, struct wl_callback *cb, uint32_t t)
{
    (void)d, (void)t;
    wl_callback_destroy(cb);
    E.sync = NULL;
    if (E.state == CONNECTING) {
        switch (E.stage) {
        case SYNC_GLOBALS:
            log_info("embed: %s offers %s", E.display, E.globals);
            if (!E.comp || !E.shm || !E.iapp) {
                log_warn("embed: the HMI's compositor lacks wl_compositor / wl_shm / ivi_application");
                E.failed = 1;
                return;
            }
            if (E.drm && E.zero_copy && !E.refused[0]) { E.stage = SYNC_DRM; sync_start(); return; }
            /* fall through */
        case SYNC_DRM:
            if (gpu_buffers()) { E.stage = SYNC_BUFFERS; sync_start(); return; }
            if (shm_buffers() < 0) { E.failed = 1; return; }
            setup_done();
            return;
        case SYNC_BUFFERS:
            setup_done();
            return;
        }
    }
    if (E.reclaiming) {           /* what the compositor held of the gone surface is released */
        E.reclaiming = 0;
        for (int i = 0; i < NB; i++) E.held[i] = 0;
    }
}
static const struct wl_callback_listener sync_listener = { synced };

static void sync_start(void)
{
    if (E.sync) wl_callback_destroy(E.sync);
    E.sync = wl_display_sync(E.dpy);
    wl_callback_add_listener(E.sync, &sync_listener, NULL);
}

int embed_connect(const char *display, uint32_t id, int w, int h, int zero_copy)
{
    if (E.dpy)
        return 0;
    E.dpy = wl_display_connect(display);
    if (!E.dpy) {
        log_debug("embed: cannot connect to %s: %s", display, strerror(errno));
        return -1;
    }
    E.id = id; E.w = w; E.h = h; E.zero_copy = zero_copy;
    snprintf(E.display, sizeof E.display, "%s", display);
    E.globals[0] = 0; E.path[0] = 0; E.drm_device[0] = 0;
    E.drm_caps = 0; E.drm_xrgb = 0;
    E.state = CONNECTING;
    E.stage = SYNC_GLOBALS;
    E.since = now_ms();
    E.reg = wl_display_get_registry(E.dpy);
    wl_registry_add_listener(E.reg, &reg_listener, NULL);
    sync_start();
    wl_display_flush(E.dpy);
    log_info("embed: connecting to %s", display);
    return 0;
}

int embed_connected(void) { return E.state == READY; }
int embed_connecting(void) { return E.state == CONNECTING; }
int embed_zero_copy(void) { return E.state == READY && E.ngpu > 0; }
const char *embed_path(void) { return E.state == READY ? E.path : ""; }
int embed_visible(void) { return E.surface != NULL; }

static void destroy_surface(void)
{
    if (E.frame_cb) { wl_callback_destroy(E.frame_cb); E.frame_cb = NULL; }
    if (E.isurf) { ivi_surface_destroy(E.isurf); E.isurf = NULL; }
    if (E.surface) { wl_surface_destroy(E.surface); E.surface = NULL; }
}

void embed_disconnect(void)
{
    if (!E.dpy)
        return;
    if (E.reading) { wl_display_cancel_read(E.dpy); E.reading = 0; }
    int was = E.state == READY;
    destroy_surface();
    if (E.sync) { wl_callback_destroy(E.sync); E.sync = NULL; }
    for (int i = 0; i < NB; i++)
        if (E.buf[i]) { wl_buffer_destroy(E.buf[i]); E.buf[i] = NULL; }
    if (E.map) { munmap(E.map, E.map_size); E.map = NULL; E.map_size = 0; }
    if (E.drm) wl_drm_destroy(E.drm);
    if (E.iapp) ivi_application_destroy(E.iapp);
    if (E.shm) wl_shm_destroy(E.shm);
    if (E.comp) wl_compositor_destroy(E.comp);
    if (E.reg) wl_registry_destroy(E.reg);
    E.drm = NULL; E.iapp = NULL; E.shm = NULL; E.comp = NULL; E.reg = NULL;
    wl_display_disconnect(E.dpy);
    E.dpy = NULL;
    E.ngpu = 0;
    E.cur = -1;
    E.ready = -1;
    E.reclaiming = 0;
    E.failed = 0;
    E.state = OFF;
    if (was) embed_changed();
}

void embed_show(int on)
{
    if (E.state != READY || on == (E.surface != NULL))
        return;
    if (on) {
        E.surface = wl_compositor_create_surface(E.comp);
        struct wl_region *r = wl_compositor_create_region(E.comp);
        wl_region_add(r, 0, 0, E.w, E.h);
        wl_surface_set_opaque_region(E.surface, r);
        wl_region_destroy(r);
        E.isurf = ivi_application_surface_create(E.iapp, E.id, E.surface);
    } else {
        destroy_surface();
        E.ready = -1;
        E.reclaiming = 1;
        sync_start();
    }
    wl_display_flush(E.dpy);
    log_info("embed: surface %#x %s", E.id, on ? "created" : "destroyed");
}

int embed_buffer(int gpu)
{
    if (!E.surface || E.reclaiming || (gpu ? !E.ngpu : !E.map))
        return -1;
    int lo = gpu ? NSHM : 0, hi = gpu ? NSHM + E.ngpu : NSHM;
    E.cur = E.ready >= lo && E.ready < hi ? E.ready : -1;  /* a frame not committed yet is drawn over */
    for (int i = lo; E.cur < 0 && i < hi; i++)
        if (!E.held[i])
            E.cur = i;
    return E.cur;
}

uint8_t *embed_pixels(int b) { return b >= 0 && b < NSHM && E.map ? E.map + (size_t)E.w * E.h * 4 * b : NULL; }
int embed_gpu_index(int b) { return b >= NSHM && b < NSHM + E.ngpu ? b - NSHM : -1; }

void embed_filled(void)
{
    E.ready = E.cur;
    E.cur = -1;
}

int embed_can_commit(void) { return E.surface && E.ready >= 0 && !E.frame_cb; }
int embed_ready(void) { return E.ready; }

void embed_discard(void) { E.ready = -1; }

int embed_waiting(void) { return E.frame_cb != NULL; }

static uint64_t mono_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000 + (uint64_t)ts.tv_nsec / 1000;
}

void embed_callbacks(unsigned *n, unsigned *avg_us, unsigned *max_us)
{
    *n = E.cb_n;
    *avg_us = E.cb_n ? (unsigned)(E.cb_sum / E.cb_n) : 0;
    *max_us = (unsigned)E.cb_max;
    E.cb_n = 0; E.cb_sum = 0; E.cb_max = 0;
}

static void frame_done(void *d, struct wl_callback *cb, uint32_t t)
{
    (void)d, (void)t;
    wl_callback_destroy(cb);
    if (cb == E.frame_cb) {
        E.frame_cb = NULL;
        uint64_t dt = mono_us() - E.commit_us;
        E.cb_n++; E.cb_sum += dt; if (dt > E.cb_max) E.cb_max = dt;
    }
    embed_frame_done();
}
static const struct wl_callback_listener frame_listener = { frame_done };

void embed_commit(void)
{
    if (!embed_can_commit())
        return;
    wl_surface_attach(E.surface, E.buf[E.ready], 0, 0);
    if (wl_proxy_get_version((struct wl_proxy *)E.surface) >= 4)
        wl_surface_damage_buffer(E.surface, 0, 0, E.w, E.h);
    else
        wl_surface_damage(E.surface, 0, 0, E.w, E.h);
    E.frame_cb = wl_surface_frame(E.surface);
    wl_callback_add_listener(E.frame_cb, &frame_listener, NULL);
    wl_surface_commit(E.surface);
    E.commit_us = mono_us();
    E.held[E.ready] = 1;
    E.ready = -1;
}

void embed_prepare(struct pollfd *pfd)
{
    pfd->fd = -1;
    pfd->events = POLLIN;
    pfd->revents = 0;
    if (!E.dpy)
        return;
    if (E.state == CONNECTING && now_ms() - E.since > SETUP_MS) {
        log_warn("embed: the HMI's compositor did not answer within %d ms", SETUP_MS);
        embed_disconnect();
        return;
    }
    while (wl_display_prepare_read(E.dpy) != 0)
        if (wl_display_dispatch_pending(E.dpy) < 0 || E.failed) {
            if (E.failed) embed_disconnect(); else lost("dispatch");
            return;
        }
    E.reading = 1;
    if (wl_display_flush(E.dpy) < 0 && errno == EAGAIN)
        pfd->events |= POLLOUT;
    pfd->fd = wl_display_get_fd(E.dpy);
}

int embed_dispatch(const struct pollfd *pfd)
{
    if (!E.dpy)
        return 0;
    if (E.reading) {
        E.reading = 0;
        if (pfd->revents & POLLIN) {
            if (wl_display_read_events(E.dpy) < 0) { lost("read"); return -1; }
        } else {
            wl_display_cancel_read(E.dpy);
        }
    }
    if (wl_display_dispatch_pending(E.dpy) < 0) { lost("dispatch"); return -1; }   /* a protocol error comes before the hangup */
    if (pfd->revents & (POLLERR | POLLHUP)) { lost("connection closed"); return -1; }
    if (E.failed) { embed_disconnect(); return -1; }
    return 0;
}
