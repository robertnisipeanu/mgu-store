/*
 * mgu-renderd - GPU renderer for MGU custom apps.
 *
 * Apps (kit/runtime/renderd.js) connect over a unix socket and send draw command lists
 * (proto.h). For each app the daemon owns one wayland surface on the head unit's compositor
 * (winston, GENIVI ivi-shell), on its own layer above the HMI, and draws the app's frames
 * there with OpenGL ES at display rate. When the compositor has taken a frame, the app gets
 * a TICK and sends the next one - so the app renders exactly as fast as the screen shows.
 *
 *   mgu-renderd [--socket PATH] [--group GID] [--screen ID] [--touch car|vm [--touch-area x,y,w,h]] [-v]
 *   mgu-renderd --replay FILE --out FILE.ppm     render a recorded client stream offscreen
 *   ... --raw FILE.rgba                          also append every frame there (raw RGBA, top row first)
 *
 * --touch (MGU7 workspace, touch.c): apps claim areas (M_CLAIM); while a claiming app is shown, the touches that
 * start there go to it (E_TOUCH) instead of the HMI. --touch-area: where apps may claim (the HMI's menus never).
 */
#define _GNU_SOURCE
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <wayland-egl.h>
#include "gfx.h"
#include "proto.h"
#include "touch.h"
#include "ivi-application-client-protocol.h"
#include "ivi-controller-client-protocol.h"

#define MAX_CLIENTS 16
#define MAX_MSG (24u << 20)
#define LAYER_BASE 0x4d470000u      /* "MG" */
#define SURF_BASE 0x4d470100u

static int verbose;
static void logf_(const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    fprintf(stderr, "[renderd %ld.%03ld] ", (long)ts.tv_sec, ts.tv_nsec / 1000000);
    vfprintf(stderr, fmt, ap); fputc('\n', stderr); va_end(ap);
}
#define LOG(...) logf_(__VA_ARGS__)
#define DBG(...) do { if (verbose) logf_(__VA_ARGS__); } while (0)

static uint64_t now_us(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (uint64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000; }
static uint64_t t_start;

/* ---------------- EGL / wayland ---------------- */
static struct wl_display *dpy;
static struct wl_compositor *comp;
static struct ivi_application *iapp;
static struct ivi_controller *ictl;
static struct { uint32_t id; struct ivi_controller_screen *s; } screens[16];
static int nscreens;
static uint32_t want_screen;        /* 0: first one reported */
static EGLDisplay edpy;
static EGLConfig ecfg;
static EGLContext ectx;
static int screen_w = 1920, screen_h = 720;

typedef struct client {
    int fd;
    char app[64];
    uint8_t *in; size_t inlen, incap;
    uint8_t *out; size_t outlen, outcap;
    gfx_client g;
    /* placement */
    int placed, x, y, w, h;
    gfx_xf xf;
    int visible;
    /* wayland */
    int slot;
    struct wl_surface *ws;
    struct ivi_surface *is;
    struct wl_egl_window *win;
    EGLSurface es;
    struct ivi_controller_surface *cs;
    struct ivi_controller_layer *cl;
    struct wl_callback *frame_cb;
    /* frames */
    uint32_t *frame; size_t frame_words, frame_cap;
    int dirty;              /* a frame arrived that is not on screen yet */
    int want_tick;          /* tell the app when we can take the next frame */
    uint32_t frames_shown, ticks;
    /* watchdog: a visible app that stops talking (hung) is hidden until it talks again */
    uint64_t last_msg; int stale;
    /* touch claims, logical px (M_CLAIM) */
    int nclaim; float claim[16][4];
    /* frame cap (M_FPS): at least min_us between two frames on screen; 0 = none */
    uint64_t min_us, last_swap;
    /* stats */
    uint64_t stat_t0; uint32_t stat_frames; uint64_t stat_sum, stat_max;
} client;

#define WATCHDOG_US 3000000ull
static client *clients[MAX_CLIENTS];
static int listen_fd = -1;

static void c_screen(void *d, struct ivi_controller *c, uint32_t id, struct ivi_controller_screen *s) {
    if (nscreens < 16) { screens[nscreens].id = id; screens[nscreens].s = s; nscreens++; }
    DBG("screen %u", id);
}
static void c_layer(void *d, struct ivi_controller *c, uint32_t id) {}
static void c_surface(void *d, struct ivi_controller *c, uint32_t id) {}
static void c_error(void *d, struct ivi_controller *c, int32_t oid, int32_t ot, int32_t code, const char *t) {
    LOG("ivi error object %d type %d code %d: %s", oid, ot, code, t ? t : "");
}
static const struct ivi_controller_listener ctl_listener = { c_screen, c_layer, c_surface, c_error };

static void o_geom(void *d, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph, int32_t sp, const char *mk, const char *md, int32_t t) {}
static void o_mode(void *d, struct wl_output *o, uint32_t flags, int32_t w, int32_t h, int32_t r) {
    /* the first output is the centre display (HDMI-A-1 in winston's command line) */
    if ((flags & WL_OUTPUT_MODE_CURRENT) && d == (void *)1) { screen_w = w; screen_h = h; DBG("centre output %dx%d@%d", w, h, r / 1000); }
}
static void o_done(void *d, struct wl_output *o) {}
static void o_scale(void *d, struct wl_output *o, int32_t f) {}
static const struct wl_output_listener out_listener = { o_geom, o_mode, o_done, o_scale };
static int noutputs;

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
    if (!strcmp(iface, "wl_compositor")) comp = wl_registry_bind(r, name, &wl_compositor_interface, 1);
    else if (!strcmp(iface, "ivi_application")) iapp = wl_registry_bind(r, name, &ivi_application_interface, 1);
    else if (!strcmp(iface, "ivi_controller")) {
        ictl = wl_registry_bind(r, name, &ivi_controller_interface, 1);
        ivi_controller_add_listener(ictl, &ctl_listener, NULL);
    } else if (!strcmp(iface, "wl_output")) {
        struct wl_output *o = wl_registry_bind(r, name, &wl_output_interface, ver < 2 ? ver : 2);
        wl_output_add_listener(o, &out_listener, (void *)(intptr_t)(++noutputs));
    }
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t n) {}
static const struct wl_registry_listener reg_listener = { reg_global, reg_remove };

static int egl_setup(EGLNativeDisplayType nd, int pbuffer) {
    edpy = eglGetDisplay(nd);
    if (edpy == EGL_NO_DISPLAY || !eglInitialize(edpy, NULL, NULL)) { LOG("eglInitialize failed 0x%x", eglGetError()); return -1; }
    eglBindAPI(EGL_OPENGL_ES_API);
    EGLint attr[] = { EGL_SURFACE_TYPE, pbuffer ? EGL_PBUFFER_BIT : EGL_WINDOW_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8,
                      EGL_ALPHA_SIZE, 8, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE };
    EGLint n = 0;
    if (!eglChooseConfig(edpy, attr, &ecfg, 1, &n) || n < 1) { LOG("no EGL config"); return -1; }
    EGLint cattr[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    ectx = eglCreateContext(edpy, ecfg, EGL_NO_CONTEXT, cattr);
    if (ectx == EGL_NO_CONTEXT) { LOG("eglCreateContext failed 0x%x", eglGetError()); return -1; }
    return 0;
}

/* ---------------- client output ---------------- */
static void send_msg(client *c, uint32_t type, const void *p, uint32_t len) {
    size_t need = c->outlen + 8 + len;
    if (need > (4u << 20)) return;                       /* app not reading: drop */
    if (need > c->outcap) { c->outcap = need * 2; c->out = realloc(c->out, c->outcap); }
    memcpy(c->out + c->outlen, &type, 4); memcpy(c->out + c->outlen + 4, &len, 4);
    if (len) memcpy(c->out + c->outlen + 8, p, len);
    c->outlen += 8 + len;
    ssize_t w = send(c->fd, c->out, c->outlen, MSG_DONTWAIT | MSG_NOSIGNAL);
    if (w > 0) { memmove(c->out, c->out + w, c->outlen - w); c->outlen -= w; }
}
static void send_tick(client *c) {
    uint32_t p[2] = { ++c->ticks, (uint32_t)((now_us() - t_start) / 1000) };
    c->want_tick = 0;
    send_msg(c, E_TICK, p, sizeof p);
}

/* ---------------- surfaces ---------------- */
static void surface_destroy(client *c) {
    if (c->frame_cb) { wl_callback_destroy(c->frame_cb); c->frame_cb = NULL; }
    if (c->cl) { ivi_controller_layer_destroy(c->cl, 1); c->cl = NULL; }
    if (c->cs) { ivi_controller_surface_destroy(c->cs, 1); c->cs = NULL; }
    if (c->es != EGL_NO_SURFACE && c->es) { eglMakeCurrent(edpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ectx); eglDestroySurface(edpy, c->es); c->es = EGL_NO_SURFACE; }
    if (c->win) { wl_egl_window_destroy(c->win); c->win = NULL; }
    if (c->is) { ivi_surface_destroy(c->is); c->is = NULL; }
    if (c->ws) { wl_surface_destroy(c->ws); c->ws = NULL; }
    if (ictl) ivi_controller_commit_changes(ictl);
}

static struct ivi_controller_screen *centre_screen(void) {
    for (int i = 0; i < nscreens; i++) if (want_screen && screens[i].id == want_screen) return screens[i].s;
    /* winston reports the screens newest first; the centre display is the oldest (lowest id) */
    struct ivi_controller_screen *best = NULL; uint32_t bid = 0xffffffffu;
    for (int i = 0; i < nscreens; i++) if (screens[i].id < bid) { bid = screens[i].id; best = screens[i].s; }
    return best;
}

static int shown(const client *c) { return c->cl && c->visible && c->frames_shown > 0 && !c->stale; }

static void apply_visibility(client *c) {
    if (!c->cl) return;
    int on = shown(c);                                     /* never show an empty or dead surface */
    ivi_controller_layer_set_visibility(c->cl, on);
    ivi_controller_surface_set_visibility(c->cs, on);
    ivi_controller_commit_changes(ictl);
}

static int surface_create(client *c) {
    if (!dpy) return -1;
    surface_destroy(c);
    uint32_t sid = SURF_BASE + c->slot, lid = LAYER_BASE + c->slot;
    c->ws = wl_compositor_create_surface(comp);
    struct wl_region *empty = wl_compositor_create_region(comp);
    wl_surface_set_input_region(c->ws, empty);           /* input goes to the HMI underneath */
    wl_region_destroy(empty);
    c->is = ivi_application_surface_create(iapp, sid, c->ws);
    c->win = wl_egl_window_create(c->ws, c->w, c->h);
    c->es = eglCreateWindowSurface(edpy, ecfg, (EGLNativeWindowType)c->win, NULL);
    if (c->es == EGL_NO_SURFACE) { LOG("%s: eglCreateWindowSurface failed 0x%x", c->app, eglGetError()); return -1; }
    eglMakeCurrent(edpy, c->es, c->es, ectx);
    eglSwapInterval(edpy, 0);                             /* pacing comes from frame callbacks */
    /* first buffer: transparent, so the surface exists before it is placed */
    glClearColor(0, 0, 0, 0); glClear(GL_COLOR_BUFFER_BIT);
    eglSwapBuffers(edpy, c->es);
    wl_display_roundtrip(dpy);
    c->cs = ivi_controller_surface_create(ictl, sid);
    ivi_controller_surface_set_source_rectangle(c->cs, 0, 0, c->w, c->h);
    ivi_controller_surface_set_destination_rectangle(c->cs, 0, 0, c->w, c->h);
    ivi_controller_surface_set_visibility(c->cs, 0);
    c->cl = ivi_controller_layer_create(ictl, lid, screen_w, screen_h);
    ivi_controller_layer_set_source_rectangle(c->cl, 0, 0, c->w, c->h);
    ivi_controller_layer_set_destination_rectangle(c->cl, c->x, c->y, c->w, c->h);
    ivi_controller_layer_set_opacity(c->cl, wl_fixed_from_int(1));
    ivi_controller_layer_add_surface(c->cl, c->cs);
    ivi_controller_layer_set_visibility(c->cl, 0);
    ivi_controller_commit_changes(ictl);
    struct ivi_controller_screen *scr = centre_screen();
    if (scr) ivi_controller_screen_add_layer(scr, c->cl);   /* on top of the screen's layers */
    else LOG("%s: no screen to put the layer on", c->app);
    ivi_controller_commit_changes(ictl);
    wl_display_roundtrip(dpy);
    LOG("%s: surface 0x%x on layer 0x%x at %d,%d %dx%d (scale %.3f)", c->app, sid, lid, c->x, c->y, c->w, c->h, c->xf.s);
    return 0;
}

static void frame_done(void *data, struct wl_callback *cb, uint32_t t) {
    client *c = data;
    wl_callback_destroy(cb);
    c->frame_cb = NULL;
    if (c->want_tick) send_tick(c);
}
static const struct wl_callback_listener frame_listener = { frame_done };

/* a capped app's frame that came too early: how long until it may be drawn (us), else 0 */
static uint64_t cap_wait(const client *c, uint64_t now) {
    return c->min_us && c->dirty && !c->frame_cb && now - c->last_swap < c->min_us ? c->min_us - (now - c->last_swap) : 0;
}

static void render_client(client *c) {
    if (!c->es || !c->dirty || c->frame_cb) return;
    uint64_t t0 = now_us();
    if (cap_wait(c, t0)) return;                         /* too early for its cap: stays dirty, drawn later */
    c->last_swap = t0;
    eglMakeCurrent(edpy, c->es, c->es, ectx);
    gfx_draw(&c->g, &c->xf, c->w, c->h, c->frame, c->frame_words, 1);
    c->frame_cb = wl_surface_frame(c->ws);
    wl_callback_add_listener(c->frame_cb, &frame_listener, c);
    eglSwapBuffers(edpy, c->es);
    c->dirty = 0;
    if (c->frames_shown++ == 0) apply_visibility(c);
    uint64_t dt = now_us() - t0;
    c->stat_frames++; c->stat_sum += dt; if (dt > c->stat_max) c->stat_max = dt;
    uint64_t now = now_us();
    if (!c->stat_t0) c->stat_t0 = now;
    if (now - c->stat_t0 >= 1000000) {
        uint32_t p[3] = { c->stat_frames, (uint32_t)(c->stat_sum / (c->stat_frames ? c->stat_frames : 1)), (uint32_t)c->stat_max };
        send_msg(c, E_STATS, p, sizeof p);
        DBG("%s: %u fps, render avg %u us max %u us", c->app, p[0], p[1], p[2]);
        c->stat_t0 = now; c->stat_frames = 0; c->stat_sum = 0; c->stat_max = 0;
    }
}

/* ---------------- touch (touch.c asks) ---------------- */
static int touch_on;

/* only a shown app's claims count: hidden or hung, its area is the HMI's again */
int touch_owner_at(int x, int y) {
    for (int i = 0; i < MAX_CLIENTS; i++) {
        client *c = clients[i];
        if (!c || !shown(c)) continue;
        for (int j = 0; j < c->nclaim; j++) {
            const float *r = c->claim[j], s = c->xf.s;
            float x0 = c->x + c->xf.ox + r[0] * s, y0 = c->y + c->xf.oy + r[1] * s;
            if (x >= x0 && y >= y0 && x < x0 + r[2] * s && y < y0 + r[3] * s) return i;
        }
    }
    return -1;
}

void touch_send(int slot, int phase, int x, int y) {
    client *c = clients[slot];
    if (!c) return;
    uint32_t p[3] = { (uint32_t)phase };
    float lx = (x - c->x - c->xf.ox) / c->xf.s, ly = (y - c->y - c->xf.oy) / c->xf.s;
    memcpy(&p[1], &lx, 4); memcpy(&p[2], &ly, 4);
    send_msg(c, E_TOUCH, p, sizeof p);
}

void touch_outside(void) {
    for (int i = 0; i < MAX_CLIENTS; i++) {
        client *c = clients[i];
        if (!c || !c->nclaim || !shown(c)) continue;
        c->visible = 0;
        apply_visibility(c);
        send_msg(c, E_CLOSED, NULL, 0);
        LOG("%s: the HMI was touched - closed", c->app);
    }
}

static int any_claim(void) {
    for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i] && clients[i]->nclaim && shown(clients[i])) return 1;
    return 0;
}

/* ---------------- messages ---------------- */
static void client_free(client *c) {
    LOG("%s: disconnected", c->app[0] ? c->app : "client");
    touch_forget(c->slot);
    if (dpy) {
        eglMakeCurrent(edpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ectx);
        surface_destroy(c);
        gfx_client_free(&c->g);
        wl_display_flush(dpy);
    }
    close(c->fd);
    free(c->in); free(c->out); free(c->frame);
    clients[c->slot] = NULL;
    free(c);
}

static void make_current_any(client *c) {
    if (c->es) eglMakeCurrent(edpy, c->es, c->es, ectx);
}

/* returns -1 to drop the client */
static int handle(client *c, uint32_t type, const uint8_t *p, uint32_t len) {
    const uint32_t *w = (const uint32_t *)p;
    size_t nw = len / 4;
    switch (type) {
    case M_HELLO: {
        size_t n = len < sizeof c->app - 1 ? len : sizeof c->app - 1;
        memcpy(c->app, p, n); c->app[n] = 0;
        for (char *s = c->app; *s; s++) if (*s < 32 || *s > 126) *s = '?';
        LOG("%s: connected", c->app);
        uint32_t r[4] = { MGU_PROTO_VERSION, (uint32_t)screen_w, (uint32_t)screen_h, (uint32_t)touch_on };
        send_msg(c, E_READY, r, sizeof r);
        return 0;
    }
    case M_FPS:
        if (nw < 1) return -1;
        c->min_us = w[0] ? 1000000ull / (w[0] > 1000 ? 1000 : w[0]) : 0;
        DBG("%s: at most %u frames a second", c->app, w[0]);
        return 0;
    case M_CLAIM: {
        if (nw < 1 || w[0] > 16 || nw < 1 + 4 * (size_t)w[0]) return -1;
        c->nclaim = (int)w[0];
        memcpy(c->claim, w + 1, (size_t)c->nclaim * 16);
        DBG("%s: claims %d touch area(s)", c->app, c->nclaim);
        return 0;
    }
    case M_PLACE: {
        if (nw < 7) return -1;
        int x = (int32_t)w[0], y = (int32_t)w[1], ww = (int32_t)w[2], hh = (int32_t)w[3];
        float s, ox, oy; memcpy(&s, &w[4], 4); memcpy(&ox, &w[5], 4); memcpy(&oy, &w[6], 4);
        if (ww < 1 || hh < 1 || ww > 4096 || hh > 4096 || !(s > 0.05f && s < 8)) return -1;
        int resize = !c->placed || ww != c->w || hh != c->h;
        c->x = x; c->y = y; c->w = ww; c->h = hh; c->xf.s = s; c->xf.ox = ox; c->xf.oy = oy;
        c->placed = 1;
        if (!dpy) return 0;
        if (resize) {
            /* layers were rendered at the old scale: the app re-sends them */
            make_current_any(c);
            gfx_client_free(&c->g);
            c->frames_shown = 0;
            if (surface_create(c) < 0) { send_msg(c, E_ERROR, "surface", 7); return -1; }
        } else {
            ivi_controller_layer_set_destination_rectangle(c->cl, x, y, ww, hh);
            ivi_controller_commit_changes(ictl);
        }
        c->want_tick = 1;
        if (!c->frame_cb) send_tick(c);
        return 0;
    }
    case M_SHOW: {
        if (nw < 1) return -1;
        c->visible = w[0] != 0;
        DBG("%s: %s", c->app, c->visible ? "show" : "hide");
        apply_visibility(c);
        if (c->visible) { c->want_tick = 1; if (!c->frame_cb) send_tick(c); }
        return 0;
    }
    case M_ATLAS: {
        if (nw < 3) return -1;
        uint32_t id = w[0], aw = w[1], ah = w[2];
        if (aw > 4096 || ah > 4096 || 12 + (size_t)aw * ah > len) return -1;
        make_current_any(c);
        if (gfx_atlas(&c->g, id, (int)aw, (int)ah, p + 12) < 0) { const char *e = gfx_error(); send_msg(c, E_ERROR, e, (uint32_t)strlen(e)); }
        return 0;
    }
    case M_RAMP: {
        if (nw < 2 || w[1] > 64 || nw < 2 + (size_t)w[1]) return -1;
        make_current_any(c);
        gfx_ramp(&c->g, w[0], (int)w[1], w + 2);
        return 0;
    }
    case M_LAYER: {
        if (nw < 3 || !c->placed) return nw < 3 ? -1 : 0;
        float lw, lh; memcpy(&lw, &w[1], 4); memcpy(&lh, &w[2], 4);
        make_current_any(c);
        if (gfx_layer_def(&c->g, w[0], lw, lh, c->xf.s, w + 3, nw - 3) < 0) { const char *e = gfx_error(); send_msg(c, E_ERROR, e, (uint32_t)strlen(e)); }
        return 0;
    }
    case M_DROP_LAYER:
        if (nw < 1) return -1;
        make_current_any(c);
        gfx_layer_drop(&c->g, w[0]);
        return 0;
    case M_IMAGE: {
        if (nw < 3) return -1;
        uint32_t iw = w[1], ih = w[2];
        if (iw < 1 || ih < 1 || iw > GFX_IMG_SIDE || ih > GFX_IMG_SIDE || len != 12 + (size_t)iw * ih * 4) return -1;
        make_current_any(c);
        if (gfx_image_def(&c->g, w[0], (int)iw, (int)ih, p + 12) < 0) {
            const char *e = gfx_error();
            LOG("%s: %s", c->app, e);
            send_msg(c, E_ERROR, e, (uint32_t)strlen(e));
        }
        return 0;
    }
    case M_DROP_IMAGE:
        if (nw < 1) return -1;
        make_current_any(c);
        gfx_image_drop(&c->g, w[0]);
        return 0;
    case M_FRAME:
        if (nw > c->frame_cap) { c->frame_cap = nw + 1024; c->frame = realloc(c->frame, c->frame_cap * 4); }
        memcpy(c->frame, p, nw * 4);
        c->frame_words = nw;
        c->dirty = 1;
        c->want_tick = 1;
        return 0;
    default:
        return 0;                                        /* newer client: ignore */
    }
}

static int client_read(client *c) {
    for (;;) {
        if (c->incap - c->inlen < 65536) { c->incap = c->incap ? c->incap * 2 : 262144; c->in = realloc(c->in, c->incap); }
        ssize_t r = recv(c->fd, c->in + c->inlen, c->incap - c->inlen, MSG_DONTWAIT);
        if (r == 0) return -1;
        if (r < 0) { if (errno == EAGAIN || errno == EWOULDBLOCK) break; if (errno == EINTR) continue; return -1; }
        c->inlen += (size_t)r;
        c->last_msg = now_us();
        if (c->stale) { c->stale = 0; LOG("%s: talking again", c->app); apply_visibility(c); }
    }
    size_t off = 0;
    while (c->inlen - off >= 8) {
        uint32_t type, len;
        memcpy(&type, c->in + off, 4); memcpy(&len, c->in + off + 4, 4);
        if (len > MAX_MSG) return -1;
        if (c->inlen - off - 8 < len) {
            if (c->incap < len + 8) { c->incap = len + 8 + 65536; uint8_t *n = realloc(c->in, c->incap); if (!n) return -1; c->in = n; }
            break;
        }
        /* payload must be 4-byte aligned for the word views: copy if it is not */
        const uint8_t *pl = c->in + off + 8;
        uint8_t *tmp = NULL;
        if (((uintptr_t)pl & 3) != 0) { tmp = malloc(len + 4); memcpy(tmp, pl, len); pl = tmp; }
        int rc = handle(c, type, pl, len);
        free(tmp);
        if (rc < 0) { LOG("%s: bad message %u (len %u)", c->app, type, len); return -1; }
        off += 8 + len;
    }
    if (off) { memmove(c->in, c->in + off, c->inlen - off); c->inlen -= off; }
    return 0;
}

static void accept_client(void) {
    int fd = accept4(listen_fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (fd < 0) return;
    int slot = -1;
    for (int i = 0; i < MAX_CLIENTS; i++) if (!clients[i]) { slot = i; break; }
    if (slot < 0) { close(fd); return; }
    int sz = 4 << 20; setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &sz, sizeof sz);
    client *c = calloc(1, sizeof *c);
    c->fd = fd; c->slot = slot; c->xf.s = 1; c->es = EGL_NO_SURFACE;
    clients[slot] = c;
}

/* ---------------- offscreen replay (testing on a PC) ---------------- */
static int replay(const char *in, const char *out, const char *raw) {
    setenv("EGL_PLATFORM", "surfaceless", 0);
    if (egl_setup(EGL_DEFAULT_DISPLAY, 1) < 0) return 1;
    EGLint pa[] = { EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE };
    EGLSurface pb = eglCreatePbufferSurface(edpy, ecfg, pa);
    if (!eglMakeCurrent(edpy, pb, pb, ectx)) { LOG("eglMakeCurrent failed 0x%x", eglGetError()); return 1; }
    if (gfx_init() < 0) { LOG("gfx_init: %s", gfx_error()); return 1; }
    FILE *f = fopen(in, "rb");
    if (!f) { perror(in); return 1; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc(n + 4); if (fread(buf, 1, n, f) != (size_t)n) return 1; fclose(f);
    client c; memset(&c, 0, sizeof c); c.fd = -1; c.xf.s = 1; strcpy(c.app, "replay");    /* replies go nowhere */
    GLuint tex = 0, fbo = 0;
    FILE *rf = raw ? fopen(raw, "wb") : NULL;
    uint8_t *rpx = NULL;
    if (raw && !rf) { perror(raw); return 1; }
    int frames = 0; uint64_t tsum = 0;
    for (long off = 0; off + 8 <= n;) {
        uint32_t type, len; memcpy(&type, buf + off, 4); memcpy(&len, buf + off + 4, 4);
        if (off + 8 + (long)len > n) break;
        uint8_t *pl = malloc(len + 4); memcpy(pl, buf + off + 8, len);
        if (type == M_FRAME) {
            if (!fbo) {
                glGenTextures(1, &tex); glBindTexture(GL_TEXTURE_2D, tex);
                glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, c.w, c.h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
                glGenFramebuffers(1, &fbo); glBindFramebuffer(GL_FRAMEBUFFER, fbo);
                glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
            }
            glBindFramebuffer(GL_FRAMEBUFFER, fbo);
            uint64_t t0 = now_us();
            gfx_draw(&c.g, &c.xf, c.w, c.h, (uint32_t *)pl, len / 4, 1);
            glFinish();
            tsum += now_us() - t0; frames++;
            if (rf) {
                if (!rpx) rpx = malloc((size_t)c.w * c.h * 4);
                glReadPixels(0, 0, c.w, c.h, GL_RGBA, GL_UNSIGNED_BYTE, rpx);
                for (int y = c.h - 1; y >= 0; y--) fwrite(rpx + (size_t)y * c.w * 4, 1, (size_t)c.w * 4, rf);
            }
        } else if (handle(&c, type, pl, len) < 0) { LOG("bad message %u", type); return 1; }
        free(pl);
        off += 8 + len;
    }
    if (rf) { fclose(rf); free(rpx); }
    if (!fbo) { LOG("no frame in %s", in); return 1; }
    uint8_t *px = malloc((size_t)c.w * c.h * 4);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glReadPixels(0, 0, c.w, c.h, GL_RGBA, GL_UNSIGNED_BYTE, px);
    FILE *o = fopen(out, "wb");
    /* PAM (RGBA), bottom-up rows flipped */
    fprintf(o, "P7\nWIDTH %d\nHEIGHT %d\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n", c.w, c.h);
    for (int y = c.h - 1; y >= 0; y--) fwrite(px + (size_t)y * c.w * 4, 1, (size_t)c.w * 4, o);
    fclose(o);
    LOG("%d frames, %.2f ms per frame (%s), %dx%d -> %s", frames, tsum / 1000.0 / (frames ? frames : 1), (const char *)glGetString(GL_RENDERER), c.w, c.h, out);
    return 0;
}

/* ---------------- main ---------------- */
static volatile sig_atomic_t quit;
static void on_sig(int s) { quit = 1; }

int main(int argc, char **argv) {
    const char *sock = "/run/mgu-renderd/renderd.sock", *rin = NULL, *rout = "out.pam", *rraw = NULL, *tmode = NULL, *tarea = NULL;
    int gid = -1;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--socket") && i + 1 < argc) sock = argv[++i];
        else if (!strcmp(argv[i], "--group") && i + 1 < argc) gid = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--screen") && i + 1 < argc) want_screen = strtoul(argv[++i], NULL, 0);
        else if (!strcmp(argv[i], "--replay") && i + 1 < argc) rin = argv[++i];
        else if (!strcmp(argv[i], "--out") && i + 1 < argc) rout = argv[++i];
        else if (!strcmp(argv[i], "--raw") && i + 1 < argc) rraw = argv[++i];
        else if (!strcmp(argv[i], "--touch") && i + 1 < argc) tmode = argv[++i];
        else if (!strcmp(argv[i], "--touch-area") && i + 1 < argc) tarea = argv[++i];
        else if (!strcmp(argv[i], "-v")) verbose = 1;
        else { fprintf(stderr, "usage: %s [--socket PATH] [--group GID] [--screen ID] [--touch car|vm [--touch-area x,y,w,h]] [-v] | --replay FILE --out FILE.pam [--raw FILE.rgba]\n", argv[0]); return 2; }
    }
    t_start = now_us();
    if (rin) return replay(rin, rout, rraw);

    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, on_sig); signal(SIGINT, on_sig);
    if (tmode) touch_on = touch_init(tmode, tarea) == 0;   /* before the compositor: it forks the guard */
    if (!getenv("XDG_RUNTIME_DIR")) setenv("XDG_RUNTIME_DIR", "/run/wayland", 1);
    dpy = wl_display_connect(NULL);
    if (!dpy) { LOG("cannot connect to the compositor (%s)", strerror(errno)); return 1; }
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &reg_listener, NULL);
    wl_display_roundtrip(dpy); wl_display_roundtrip(dpy);
    if (!comp || !iapp || !ictl) { LOG("compositor lacks wl_compositor / ivi_application / ivi_controller"); return 1; }
    LOG("compositor: %d screens, centre output %dx%d", nscreens, screen_w, screen_h);
    if (egl_setup((EGLNativeDisplayType)dpy, 0) < 0) return 1;
    /* a context needs a surface to be made current on some drivers: use a tiny one for init */
    struct wl_surface *ts = wl_compositor_create_surface(comp);
    struct wl_egl_window *tw = wl_egl_window_create(ts, 1, 1);
    EGLSurface tes = eglCreateWindowSurface(edpy, ecfg, (EGLNativeWindowType)tw, NULL);
    eglMakeCurrent(edpy, tes, tes, ectx);
    if (gfx_init() < 0) { LOG("gfx_init: %s", gfx_error()); return 1; }
    LOG("GL: %s / %s", (const char *)glGetString(GL_RENDERER), (const char *)glGetString(GL_VERSION));

    /* socket */
    unlink(sock);
    listen_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    struct sockaddr_un sa = { .sun_family = AF_UNIX };
    snprintf(sa.sun_path, sizeof sa.sun_path, "%s", sock);
    mode_t old = umask(0117);
    if (bind(listen_fd, (struct sockaddr *)&sa, sizeof sa) < 0 || listen(listen_fd, 8) < 0) { LOG("socket %s: %s", sock, strerror(errno)); return 1; }
    umask(old);
    if (gid >= 0 && chown(sock, (uid_t)-1, (gid_t)gid) < 0) LOG("chown %s: %s", sock, strerror(errno));
    chmod(sock, gid >= 0 ? 0660 : 0666);
    LOG("listening on %s", sock);

    while (!quit) {
        uint64_t tnow = now_us();
        for (int i = 0; i < MAX_CLIENTS; i++) {
            client *c = clients[i];
            if (!c) continue;
            /* apps send a frame at least every second while shown; 3 s of silence = hung */
            if (c->visible && !c->stale && c->last_msg && tnow - c->last_msg > WATCHDOG_US) {
                c->stale = 1; LOG("%s: no frames for 3 s - hidden", c->app); apply_visibility(c);
            }
            render_client(c);
        }
        if (touch_on) touch_tick(any_claim());
        while (wl_display_prepare_read(dpy) != 0) wl_display_dispatch_pending(dpy);
        wl_display_flush(dpy);
        struct pollfd pf[3 + MAX_CLIENTS];
        int np = 0, map[MAX_CLIENTS + 3];
        pf[np].fd = wl_display_get_fd(dpy); pf[np].events = POLLIN; map[np++] = -1;
        pf[np].fd = listen_fd; pf[np].events = POLLIN; map[np++] = -2;
        pf[np].fd = touch_on ? touch_fd() : -1; pf[np].events = POLLIN; map[np++] = -3;   /* fd -1: poll skips it */
        for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i]) {
            pf[np].fd = clients[i]->fd;
            pf[np].events = POLLIN | (clients[i]->outlen ? POLLOUT : 0);
            map[np++] = i;
        }
        int wait_ms = 250;                               /* wake up in time for a capped app's waiting frame */
        for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i]) {
            uint64_t us = cap_wait(clients[i], tnow);
            if (us && (int)(us / 1000) + 1 < wait_ms) wait_ms = (int)(us / 1000) + 1;
        }
        int r = poll(pf, np, wait_ms);
        if (r < 0 && errno != EINTR) { wl_display_cancel_read(dpy); break; }
        if (pf[0].revents & POLLIN) wl_display_read_events(dpy); else wl_display_cancel_read(dpy);
        if (pf[0].revents & (POLLERR | POLLHUP)) { LOG("compositor connection lost"); break; }
        wl_display_dispatch_pending(dpy);
        if (pf[1].revents & POLLIN) accept_client();
        if (pf[2].revents & POLLIN) touch_read();
        for (int k = 3; k < np; k++) {
            client *c = clients[map[k]];
            if (!c) continue;
            if (pf[k].revents & POLLOUT && c->outlen) {
                ssize_t w = send(c->fd, c->out, c->outlen, MSG_DONTWAIT | MSG_NOSIGNAL);
                if (w > 0) { memmove(c->out, c->out + w, c->outlen - w); c->outlen -= w; }
            }
            if (pf[k].revents & (POLLIN | POLLHUP | POLLERR)) {
                if (client_read(c) < 0) client_free(c);
            }
        }
    }
    if (touch_on) touch_stop();
    for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i]) client_free(clients[i]);
    unlink(sock);
    LOG("exit");
    return 0;
}
