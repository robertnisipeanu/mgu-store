/*
 * Embed mode's display (embed.h), from display-bridge's target hmi (backend_wayland.c).
 *
 * Nothing here waits for the HMI's compositor: it serves its clients from the HMI's own loop, which
 * may be busy or idle for a while, and the layer apps must not wait with it. Setup, surface changes
 * and buffer reuse after a surface is gone all complete on wl_callback.done in the event loop.
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

#include "ivi-application-client-protocol.h"
#include "log.h"

#define NBUF 3
#define SETUP_MS 5000

enum { OFF, CONNECTING, READY };

static struct {
    int state;
    int64_t since;
    struct wl_display *dpy;
    struct wl_registry *reg;
    struct wl_callback *sync;     /* setup, or a destroyed surface's buffers coming back */
    struct wl_compositor *comp;
    struct wl_shm *shm;
    struct ivi_application *iapp;
    struct wl_surface *surface;
    struct ivi_surface *isurf;
    struct wl_callback *frame_cb;
    struct wl_buffer *buf[NBUF];
    int held[NBUF];               /* committed, not released yet */
    int reclaiming;               /* the surface is gone; buffers are ours once the compositor confirms */
    uint8_t *map;
    size_t map_size;
    int w, h, cur, reading;
    uint32_t id;
} E = { .cur = -1 };

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver)
{
    (void)d;
    log_debug("embed: global %s v%u", iface, ver);
    if (!strcmp(iface, wl_compositor_interface.name))
        E.comp = wl_registry_bind(r, name, &wl_compositor_interface, ver < 4 ? ver : 4);
    else if (!strcmp(iface, wl_shm_interface.name))
        E.shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
    else if (!strcmp(iface, ivi_application_interface.name))
        E.iapp = wl_registry_bind(r, name, &ivi_application_interface, 1);
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
    int err = E.dpy ? wl_display_get_error(E.dpy) : 0;
    if (err == EPROTO) {
        const struct wl_interface *iface = NULL;
        uint32_t oid = 0, code = wl_display_get_protocol_error(E.dpy, &iface, &oid);
        log_error("embed: %s: protocol error %u on %s@%u (surface id %#x held by another producer?)", what, code,
                  iface ? iface->name : "?", oid, E.id);
    } else {
        log_error("embed: %s: %s", what, strerror(err ? err : errno));
    }
    embed_disconnect();
}

static int buffers(void)
{
    size_t one = (size_t)E.w * E.h * 4;
    E.map_size = one * NBUF;
    int fd = (int)syscall(SYS_memfd_create, "mgu-render-embed", 1u /* MFD_CLOEXEC */);
    if (fd < 0 || ftruncate(fd, (off_t)E.map_size) < 0 ||
        (E.map = mmap(NULL, E.map_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)) == MAP_FAILED) {
        log_error("embed: %zu bytes of shared memory: %s", E.map_size, strerror(errno));
        E.map = NULL;
        if (fd >= 0) close(fd);
        return -1;
    }
    struct wl_shm_pool *pool = wl_shm_create_pool(E.shm, fd, (int32_t)E.map_size);
    for (int i = 0; i < NBUF; i++) {
        E.buf[i] = wl_shm_pool_create_buffer(pool, (int32_t)(one * i), E.w, E.h, E.w * 4, WL_SHM_FORMAT_XRGB8888);
        wl_buffer_add_listener(E.buf[i], &buf_listener, (void *)(intptr_t)i);
        E.held[i] = 0;
    }
    wl_shm_pool_destroy(pool);
    close(fd);
    return 0;
}

static void synced(void *d, struct wl_callback *cb, uint32_t t)
{
    (void)d, (void)t;
    wl_callback_destroy(cb);
    E.sync = NULL;
    if (E.state == CONNECTING) {
        if (!E.comp || !E.shm || !E.iapp) {
            log_warn("embed: the HMI's compositor lacks wl_compositor / wl_shm / ivi_application");
            embed_disconnect();
            return;
        }
        if (buffers() < 0) { embed_disconnect(); return; }
        E.state = READY;
        log_info("embed: ready, surface %#x %dx%d while shown", E.id, E.w, E.h);
        embed_changed();
        return;
    }
    if (E.reclaiming) {           /* what the compositor held of the gone surface is released */
        E.reclaiming = 0;
        for (int i = 0; i < NBUF; i++) E.held[i] = 0;
    }
}
static const struct wl_callback_listener sync_listener = { synced };

static void sync_start(void)
{
    if (E.sync) wl_callback_destroy(E.sync);
    E.sync = wl_display_sync(E.dpy);
    wl_callback_add_listener(E.sync, &sync_listener, NULL);
}

int embed_connect(const char *display, uint32_t id, int w, int h)
{
    if (E.dpy)
        return 0;
    E.dpy = wl_display_connect(display);
    if (!E.dpy) {
        log_debug("embed: cannot connect to %s: %s", display, strerror(errno));
        return -1;
    }
    E.id = id; E.w = w; E.h = h;
    E.state = CONNECTING;
    E.since = now_ms();
    E.reg = wl_display_get_registry(E.dpy);
    wl_registry_add_listener(E.reg, &reg_listener, NULL);
    sync_start();
    wl_display_flush(E.dpy);
    log_info("embed: connecting to %s", display);
    return 0;
}

int embed_connected(void) { return E.state == READY; }
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
    for (int i = 0; i < NBUF; i++)
        if (E.buf[i]) { wl_buffer_destroy(E.buf[i]); E.buf[i] = NULL; }
    if (E.map) { munmap(E.map, E.map_size); E.map = NULL; }
    if (E.iapp) ivi_application_destroy(E.iapp);
    if (E.shm) wl_shm_destroy(E.shm);
    if (E.comp) wl_compositor_destroy(E.comp);
    if (E.reg) wl_registry_destroy(E.reg);
    E.iapp = NULL; E.shm = NULL; E.comp = NULL; E.reg = NULL;
    wl_display_disconnect(E.dpy);
    E.dpy = NULL;
    E.cur = -1;
    E.reclaiming = 0;
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
        E.reclaiming = 1;
        sync_start();
    }
    wl_display_flush(E.dpy);
    log_info("embed: surface %#x %s", E.id, on ? "created" : "destroyed");
}

uint8_t *embed_buffer(void)
{
    if (!E.surface || E.frame_cb || E.reclaiming)
        return NULL;
    for (int i = 0; i < NBUF; i++)
        if (!E.held[i]) {
            E.cur = i;
            return E.map + (size_t)E.w * E.h * 4 * i;
        }
    return NULL;
}

static void frame_done(void *d, struct wl_callback *cb, uint32_t t)
{
    (void)d, (void)t;
    wl_callback_destroy(cb);
    if (cb == E.frame_cb)
        E.frame_cb = NULL;
    embed_frame_done();
}
static const struct wl_callback_listener frame_listener = { frame_done };

void embed_commit(void)
{
    if (!E.surface || E.cur < 0)
        return;
    wl_surface_attach(E.surface, E.buf[E.cur], 0, 0);
    if (wl_proxy_get_version((struct wl_proxy *)E.surface) >= 4)
        wl_surface_damage_buffer(E.surface, 0, 0, E.w, E.h);
    else
        wl_surface_damage(E.surface, 0, 0, E.w, E.h);
    E.frame_cb = wl_surface_frame(E.surface);
    wl_callback_add_listener(E.frame_cb, &frame_listener, NULL);
    wl_surface_commit(E.surface);
    E.held[E.cur] = 1;
    E.cur = -1;
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
        if (wl_display_dispatch_pending(E.dpy) < 0) {
            lost("dispatch");
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
    if (pfd->revents & (POLLERR | POLLHUP)) { lost("connection closed"); return -1; }
    if (wl_display_dispatch_pending(E.dpy) < 0) { lost("dispatch"); return -1; }
    return 0;
}
