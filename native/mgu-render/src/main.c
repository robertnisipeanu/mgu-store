/*
 * mgu-render - the renderer for MGU custom apps.
 *
 * Apps connect over a unix socket and send draw command lists (proto.h, PROTOCOL.md) in one of three
 * dialects: upstream idrive7-apps kit/renderd, IterioDev's mgu-renderd, or mgu-render's own (native).
 * The daemon draws each app's frames with OpenGL ES at display rate in one of two placements:
 *   layer  the app's own wayland surface on its own ivi layer above the HMI (Winston, wayland-0);
 *   embed  inside the app's HMI page: the HMI's embedded compositor (wayland-1) shows our surface in
 *          the page template's box (js/hmi_template.js); frames are drawn offscreen and read back.
 * When the compositor has taken a frame, the app gets a TICK and sends the next one - so the app
 * renders exactly as fast as the screen shows. Apps (any uid but root) show only while the HMI has
 * their screen in front (the foreground gate, gate.c). Touch on apps' claimed areas is routed to
 * them (touch.c); the iDrive controller can be held back from the HMI for an app (GRAB, when the
 * HMI's controller gate is loaded). A video's frames come from a file another program writes (VIDEO): each new
 * frame draws the app's last frame again.
 *
 * Apps connect to its own socket (socket_path). The community renderers' socket (shared_path) is a link to it
 * while no other renderer is installed (share.c): their apps then draw here, unchanged. display-bridge's socket
 * (bridge_path) links to it too: display-bridge's apps speak its protocol (dbr.h) and draw in their pages.
 *
 *   mgu-render [-c FILE] [-s key=value]... [-v]
 *   mgu-render [-c FILE] --share | --unshare   link the community and display-bridge sockets now, or remove the links (the socket unit)
 *   mgu-render --replay FILE --out FILE.pam [--raw FILE.rgba] [--uid N]   render a recorded client stream offscreen, as
 *                                                                          an app of uid N (default: the caller's)
 *
 * From mgu-renderd src/main.c (idrive7-apps kit/renderd, MIT, Copyright (c) 2026 cauliflowermossgrape;
 * touch routing, pictures and video by IterioDev) and display-bridge (embed placement,
 * foreground gate).
 */
#define _GNU_SOURCE
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
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
#include "config.h"
#include "dbr.h"
#include "dialect.h"
#include "embed.h"
#include "embed_gl.h"
#include "gate.h"
#include "gfx.h"
#include "log.h"
#include "trace.h"
#include "proto.h"
#include "relist.h"
#include "share.h"
#include "touch.h"
#include "ivi-application-client-protocol.h"
#include "ivi-controller-client-protocol.h"

#define MAX_CLIENTS 16
#define MAX_MSG (24u << 20)
#define LAYER_BASE 0x4d520000u      /* "MR"; the community renderers use "MG", 0x4d470000 and 0x4d470100 */
#define SURF_BASE 0x4d520100u
#define WATCHDOG_US 3000000ull       /* an app on screen that says nothing for this long is hidden */
#define GRAB_US 1500000ull           /* a GRAB holds this long unless repeated */
#define GATE_TOUCH_US 200000ull      /* the controller gate's file is refreshed this often while held */
#define SHARE_US 2000000ull          /* the community socket's rule is applied this often */
#define DROP_WINDOW_US 10000000ull   /* a layer taken off while shown goes back at once at most DROP_MAX times in this */
#define DROP_MAX 10
#ifndef GL_BGRA_EXT
#define GL_BGRA_EXT 0x80E1
#endif

static struct cfg cfg;
static uint64_t now_us(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (uint64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000; }
static uint64_t t_start;

/* ---------------- EGL / wayland ---------------- */
static struct wl_display *dpy;
static struct wl_compositor *comp;
static struct ivi_application *iapp;
static struct ivi_controller *ictl;
static int nscreens;
static EGLDisplay edpy;
static EGLConfig ecfg;
static EGLContext ectx;
static EGLSurface init_es = EGL_NO_SURFACE;
static int screen_w = 1920, screen_h = 720, refresh_mhz;
/* the centre display of iDrive 8 (iDrive 7: 1920x720); overlays and the picture check on yield surfaces are for it only */
static int idrive8(void) { return screen_w == 2880 && screen_h == 960; }

/* yield surfaces (camera, video): layer mode hides while one shows a picture (visible, with a buffer) */
static struct { uint32_t id; struct ivi_controller_surface *s; int visible, w, h; } yield[CFG_MAX_YIELD];
static int nyield, yielding;

typedef struct client {
    int fd;
    char app[64];
    uint32_t uid;
    int dialect, mode;
    uint8_t *in; size_t inlen, incap;
    uint8_t *out; size_t outlen, outcap;
    gfx_client g;
    /* placement */
    int placed, x, y, w, h;
    gfx_xf xf;
    int visible;
    uint64_t show_seq;      /* order of SHOWs: the newest shown embed app holds the HMI's box */
    /* wayland (layer mode) */
    int slot;
    struct wl_surface *ws;
    struct ivi_surface *is;
    struct wl_egl_window *win;
    EGLSurface es;
    struct ivi_controller_surface *cs;
    struct ivi_controller_layer *cl;
    int listed;             /* the layer is on the centre screen's list, as the compositor last said */
    int shown_on;           /* shown at the last apply_visibility */
    uint64_t drop_t; int drops; /* the layer taken off while shown: when the current 10 s began, how often since */
    struct wl_callback *frame_cb;
    /* frames */
    uint32_t *frame; size_t frame_words, frame_cap;
    int dirty;              /* a frame arrived that is not on screen yet */
    int want_tick;          /* tell the app when we can take the next frame */
    uint32_t frames_shown, ticks;
    /* watchdog: an app on screen that stops talking (hung) is hidden until it talks again */
    uint64_t last_msg; int stale;
    /* touch claims, logical px (CLAIM) */
    int nclaim; float claim[16][4];
    int overlay;            /* a root client named in overlay_apps: shown over camera surfaces, never closed by an HMI
                               touch, its claims first and outside touch_area too, its layer kept above the others */
    /* frame cap (MI_FPS): at least min_us between two frames drawn; 0 = none */
    uint64_t min_us, last_draw;
    uint32_t tr_frames, tr_touches, tr_drawn, tr_committed;   /* trace.h: frames and touches on this connection */
    /* controller grab: last time the app asked for it, 0 = not */
    uint64_t grab_t;
    /* native: the last X_STATE sent */
    int st_mode, st_on, st_front, st_sent;
    int on_screen;          /* shown at the last update: the watchdog counts silence from the moment it shows */
    FILE *rec;
    int started;            /* a message has come: a DBR1 session is told by its first four bytes */
    /* a display-bridge app (DIALECT_DBR): shown in img (logical px); in the HMI's box its picture px (and lut for
       INDEX8) is made on the CPU into the compositor's buffer (with GPU buffers: drawn into one by GL), on a layer it is
       pixmap 1. Of its frames one waits to
       be drawn (pending), one drawn waits to be committed (embed: prepared), one committed waits for the
       compositor (committed); each is answered PRESENTED or DROPPED */
    struct {
        unsigned format, w, h; size_t bpp; float img[4]; uint8_t *px; uint32_t lut[256];
        int pending, prepared, committed; uint32_t pending_seq, prepared_seq, committed_seq;
    } dbr;
    /* stats */
    uint64_t stat_t0; uint32_t stat_frames; uint64_t stat_sum, stat_max;
} client;

static client *clients[MAX_CLIENTS];
static int listen_fd = -1, own_socket;
static uint64_t show_counter;
static client *embed_owner;
static int touch_on;
static int ccu_fd = -1, ctl_gate_on;
static uint64_t ctl_gate_t, ccu_retry;
static void ccu_open(void);
static int ccu_free(void);

static void c_screen(void *d, struct ivi_controller *c, uint32_t id, struct ivi_controller_screen *s) {
    (void)d, (void)c, (void)s;
    nscreens++;
    log_debug("screen %u", id);
}
static void c_layer(void *d, struct ivi_controller *c, uint32_t id) { (void)d, (void)c, (void)id; }

static void update_all(void);
/* iDrive 8: visible alone is not a picture: on a G82 (2026-11-01) the HMI keeps cameraplayer's SID_VIDEO_DIGITAL_HU
 * 0x198 visible from boot with no buffer (configuration 0x0), which hid every layer app for good. iDrive 7: visible. */
static void y_update(int i) {
    int any = 0;
    for (int k = 0; k < nyield; k++) any |= yield[k].visible && (!idrive8() || (yield[k].w > 0 && yield[k].h > 0));
    if (any != yielding) {
        yielding = any;
        log_info(any ? "surface %#x shows a picture: layer apps yield the screen" : "surface %#x shows no picture: layer apps may show", yield[i].id);
        update_all();
    }
}
static void y_visibility(void *d, struct ivi_controller_surface *s, int32_t v) {
    (void)s;
    int i = (int)(intptr_t)d;
    if (yield[i].visible != (v != 0)) log_info("surface %#x %s, buffer %dx%d", yield[i].id, v ? "visible" : "hidden", yield[i].w, yield[i].h);
    yield[i].visible = v != 0;
    y_update(i);
}
static void y_opacity(void *d, struct ivi_controller_surface *s, wl_fixed_t o) { (void)d, (void)s, (void)o; }
static void y_rect(void *d, struct ivi_controller_surface *s, int32_t x, int32_t y, int32_t w, int32_t h) { (void)d, (void)s, (void)x, (void)y, (void)w, (void)h; }
static void y_config(void *d, struct ivi_controller_surface *s, int32_t w, int32_t h) {
    (void)s;
    int i = (int)(intptr_t)d;
    if (yield[i].w != w || yield[i].h != h) log_info("surface %#x buffer %dx%d", yield[i].id, w, h);
    yield[i].w = w, yield[i].h = h;
    y_update(i);
}
static void y_int(void *d, struct ivi_controller_surface *s, int32_t v) { (void)d, (void)s, (void)v; }
static void y_layer(void *d, struct ivi_controller_surface *s, struct ivi_controller_layer *l) { (void)d, (void)s, (void)l; }
static void y_stats(void *d, struct ivi_controller_surface *s, uint32_t a, uint32_t b, uint32_t c, uint32_t p, const char *n) {
    (void)d, (void)s, (void)a, (void)b, (void)c, (void)p, (void)n;
}
static void y_destroyed(void *d, struct ivi_controller_surface *s) {
    int i = (int)(intptr_t)d;
    wl_proxy_destroy((struct wl_proxy *)s);
    yield[i].s = NULL;
    yield[i].w = yield[i].h = 0;
    y_visibility(d, NULL, 0);
}
static const struct ivi_controller_surface_listener yield_listener = {
    y_visibility, y_opacity, y_rect, y_rect, y_config, y_int, y_int, y_layer, y_stats, y_destroyed, y_int,
};

static void c_surface(void *d, struct ivi_controller *c, uint32_t id) {
    (void)d;
    for (int i = 0; i < cfg.n_yield; i++) {
        if (cfg.yield_surfaces[i] != id) continue;
        int k = 0;
        while (k < nyield && yield[k].id != id) k++;
        if (k == nyield) { if (nyield == CFG_MAX_YIELD) return; nyield++; }
        if (yield[k].s) return;
        yield[k].id = id; yield[k].visible = yield[k].w = yield[k].h = 0;
        yield[k].s = ivi_controller_surface_create(c, id);
        ivi_controller_surface_add_listener(yield[k].s, &yield_listener, (void *)(intptr_t)k);
        log_info("watching surface %#x", id);
    }
}
static void c_error(void *d, struct ivi_controller *c, int32_t oid, int32_t ot, int32_t code, const char *t) {
    (void)d, (void)c;
    log_error("ivi error object %d type %d code %d: %s", oid, ot, code, t ? t : "");
}
static const struct ivi_controller_listener ctl_listener = { c_screen, c_layer, c_surface, c_error };

static void o_geom(void *d, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph, int32_t sp, const char *mk, const char *md, int32_t t) {
    (void)d, (void)o, (void)x, (void)y, (void)pw, (void)ph, (void)sp, (void)mk, (void)md, (void)t;
}
static void o_mode(void *d, struct wl_output *o, uint32_t flags, int32_t w, int32_t h, int32_t r) {
    (void)o;
    /* the first output is the centre display (HDMI-A-1 in winston's command line) */
    if ((flags & WL_OUTPUT_MODE_CURRENT) && d == (void *)1) { screen_w = w; screen_h = h; refresh_mhz = r; log_debug("centre output %dx%d@%d", w, h, r / 1000); }
}
static void o_done(void *d, struct wl_output *o) { (void)d, (void)o; }
static void o_scale(void *d, struct wl_output *o, int32_t f) { (void)d, (void)o, (void)f; }
static const struct wl_output_listener out_listener = { .geometry = o_geom, .mode = o_mode, .done = o_done, .scale = o_scale };
static int noutputs;

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
    (void)d;
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
static void reg_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d, (void)r, (void)n; }
static const struct wl_registry_listener reg_listener = { reg_global, reg_remove };

static int egl_setup(EGLNativeDisplayType nd, int pbuffer) {
    edpy = eglGetDisplay(nd);
    if (edpy == EGL_NO_DISPLAY || !eglInitialize(edpy, NULL, NULL)) { log_error("eglInitialize failed 0x%x", eglGetError()); return -1; }
    eglBindAPI(EGL_OPENGL_ES_API);
    EGLint attr[] = { EGL_SURFACE_TYPE, pbuffer ? EGL_PBUFFER_BIT : EGL_WINDOW_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8,
                      EGL_ALPHA_SIZE, 8, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE };
    EGLint n = 0;
    if (!eglChooseConfig(edpy, attr, &ecfg, 1, &n) || n < 1) { log_error("no EGL config"); return -1; }
    EGLint cattr[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    ectx = eglCreateContext(edpy, ecfg, EGL_NO_CONTEXT, cattr);
    if (ectx == EGL_NO_CONTEXT) { log_error("eglCreateContext failed 0x%x", eglGetError()); return -1; }
    return 0;
}

/* ---------------- client output ---------------- */
static void send_bytes(client *c, const void *h, size_t hl, const void *p, uint32_t len) {
    if (c->fd < 0) return;                                /* replay: replies go nowhere */
    size_t need = c->outlen + hl + len;
    if (need > (4u << 20)) return;                       /* app not reading: drop */
    if (need > c->outcap) { c->outcap = need * 2; c->out = realloc(c->out, c->outcap); }
    memcpy(c->out + c->outlen, h, hl);
    if (len) memcpy(c->out + c->outlen + hl, p, len);
    c->outlen += hl + len;
    ssize_t w = send(c->fd, c->out, c->outlen, MSG_DONTWAIT | MSG_NOSIGNAL);
    if (w > 0) { memmove(c->out, c->out + w, c->outlen - w); c->outlen -= w; }
}
static void send_msg(client *c, uint32_t type, const void *p, uint32_t len) {
    if (c->dialect == DIALECT_DBR) return;                /* a display-bridge app gets only DBR1 messages */
    uint32_t h[2] = { type, len };
    send_bytes(c, h, sizeof h, p, len);
}
static void dbr_send(client *c, unsigned type, uint32_t seq, const void *p, uint32_t len) {
    uint8_t h[DBR_HEADER];
    dbr_put_header(h, type, len, seq);
    send_bytes(c, h, sizeof h, p, len);
}
static void dbr_error(client *c, unsigned code, const char *e) {
    uint8_t p[256];
    dbr_send(c, DBR_ERROR, 0, p, dbr_error_encode(code, e, p, sizeof p));
}
static void send_error(client *c, const char *e) {
    if (c->dialect == DIALECT_DBR) dbr_error(c, DBR_ERR_DISPLAY, e);
    else send_msg(c, E_ERROR, e, (uint32_t)strlen(e));
}
static void send_tick(client *c) {
    uint32_t p[2] = { ++c->ticks, (uint32_t)((now_us() - t_start) / 1000) };
    c->want_tick = 0;
    send_msg(c, E_TICK, p, sizeof p);
    if (trace_on()) trace(now_us(), "tick", c->app, c->ticks);
}

/* ---------------- who shows ---------------- */
static int legacy(const client *c) { return c->dialect != DIALECT_NATIVE && c->dialect != DIALECT_DBR; }
static int gate_applies(const client *c) {
    if (!cfg.foreground_gate[0] || c->uid == 0) return 0;     /* root: bring-up tools */
    return !legacy(c) || c->mode == MODE_EMBED || cfg.gate_legacy;
}
/* Native, display-bridge and embed apps show only while the gate reports them in front. Legacy apps hide themselves
 * when their screen goes; for them the gate only hides while it names another app in front, so a gate that reads
 * nothing (on a unit it cannot read) leaves them as they were without it. */
static int in_front(const client *c) {
    if (!gate_applies(c)) return 1;
    if (legacy(c) && c->mode == MODE_LAYER) return !gate_any_front() || gate_front(c->uid);
    return gate_reported() && gate_front(c->uid);
}

/* The gate cannot tell which app is in front: the mgu-render/1 apps it gates were offered modes it can never show,
 * so they are disconnected once; they connect again to a READY that offers none. */
static int gate_dropped;
static void client_free(client *c);
static void drop_gated(void) {
    gate_dropped = 1;
    for (int i = 0; i < MAX_CLIENTS; i++)
        if (clients[i] && clients[i]->dialect == DIALECT_NATIVE && gate_applies(clients[i])) client_free(clients[i]);
    update_all();
}

static int shown(const client *c) {
    if (c->mode == MODE_EMBED) return c == embed_owner && embed_visible() && c->frames_shown > 0;
    return c->cl && c->visible && c->frames_shown > 0 && !c->stale && in_front(c) && (!yielding || c->overlay);
}

/* app is one of the comma-separated ids in list */
static int listed(const char *list, const char *app) {
    size_t n = strlen(app);
    for (const char *p = list; n && *p;) {
        while (*p == ',' || *p == ' ') p++;
        size_t k = strcspn(p, ", ");
        if (k == n && !strncmp(p, app, n)) return 1;
        p += k;
    }
    return 0;
}

/* where the app's logical (0, 0) + placement offset sits on the screen */
static void origin(const client *c, float *x, float *y) {
    if (c->mode == MODE_EMBED) { *x = (float)cfg.embed_area[0]; *y = (float)cfg.embed_area[1]; }
    else { *x = (float)c->x; *y = (float)c->y; }
}

static void layer_put(client *c);
static void apply_visibility(client *c) {
    if (!c->cl) return;
    int on = shown(c);                                     /* never show an empty or dead surface */
    if (on && !c->shown_on) {                              /* shown: a layer taken off meanwhile goes back */
        c->drops = 0;
        if (!c->listed) layer_put(c);
    }
    c->shown_on = on;
    ivi_controller_layer_set_visibility(c->cl, on);
    ivi_controller_surface_set_visibility(c->cs, on);
    ivi_controller_commit_changes(ictl);
}

static void send_state(client *c) {
    if (c->dialect != DIALECT_NATIVE) return;
    int on = shown(c), front = in_front(c);
    if (c->st_sent && c->st_mode == c->mode && c->st_on == on && c->st_front == front) return;
    c->st_sent = 1; c->st_mode = c->mode; c->st_on = on; c->st_front = front;
    uint32_t p[3] = { (uint32_t)c->mode, (uint32_t)on, (uint32_t)front };
    send_msg(c, X_STATE, p, sizeof p);
}

/* the newest shown embed app that is in front and has a frame holds the HMI's box */
static void embed_update(void) {
    client *best = NULL;
    for (int i = 0; i < MAX_CLIENTS; i++) {
        client *c = clients[i];
        if (!c || c->mode != MODE_EMBED || !c->visible || !c->frame_words || !in_front(c) || c->stale) continue;
        if (!best || c->show_seq > best->show_seq) best = c;
    }
    if (!embed_connected()) best = NULL;
    if (best != embed_owner) {
        embed_discard();                                    /* what was drawn for the app before */
        embed_gl_cancel();
        if (embed_owner) log_info("%s: leaves the HMI's box", embed_owner->app);
        embed_owner = best;
        if (best) {
            log_info("%s: drawn in the HMI's box", best->app);
            best->dirty = 1;                                /* its newest frame, again */
            best->frames_shown = 0;
        }
    }
    embed_show(best != NULL);
}

/* a display-bridge app's frames: drawn (the one waiting becomes the prepared one; drawn over, the one prepared
   before is dropped), committed, on the screen, or gone */
static void dbr_answer(client *c, int *has, uint32_t seq) {
    if (*has) dbr_send(c, DBR_DROPPED, seq, NULL, 0);
    *has = 0;
}
static void dbr_drawn(client *c) {
    if (c->dialect != DIALECT_DBR || !c->dbr.pending) return;
    dbr_answer(c, &c->dbr.prepared, c->dbr.prepared_seq);
    c->dbr.prepared = 1; c->dbr.prepared_seq = c->dbr.pending_seq;
    c->dbr.pending = 0;
}
static void dbr_committed(client *c) {
    if (c->dialect != DIALECT_DBR || !c->dbr.prepared) return;
    dbr_answer(c, &c->dbr.committed, c->dbr.committed_seq);
    c->dbr.committed = 1; c->dbr.committed_seq = c->dbr.prepared_seq;
    c->dbr.prepared = 0;
}
static void dbr_presented(client *c) {
    if (c->dialect != DIALECT_DBR || !c->dbr.committed) return;
    uint8_t ms[4];
    uint32_t t = (uint32_t)((now_us() - t_start) / 1000);
    memcpy(ms, &t, 4);
    c->dbr.committed = 0;
    dbr_send(c, DBR_PRESENTED, c->dbr.committed_seq, ms, sizeof ms);
}

static void update_all(void) {
    embed_update();
    for (int i = 0; i < MAX_CLIENTS; i++) {
        client *c = clients[i];
        if (!c) continue;
        int on = shown(c);
        if (c->dialect == DIALECT_DBR) {                  /* its picture went before the frame showed */
            if (c != embed_owner) dbr_answer(c, &c->dbr.prepared, c->dbr.prepared_seq);
            if (!on) dbr_answer(c, &c->dbr.committed, c->dbr.committed_seq);
        }
        if (on && !c->on_screen) c->last_msg = now_us();
        c->on_screen = on;
        apply_visibility(c);
        send_state(c);
    }
}

/* ---------------- layer surfaces ---------------- */
static void surface_destroy(client *c) {
    if (c->frame_cb) { wl_callback_destroy(c->frame_cb); c->frame_cb = NULL; }
    if (c->cl) { ivi_controller_layer_destroy(c->cl, 1); c->cl = NULL; }
    if (c->cs) { ivi_controller_surface_destroy(c->cs, 1); c->cs = NULL; }
    if (c->es != EGL_NO_SURFACE) { eglMakeCurrent(edpy, init_es, init_es, ectx); eglDestroySurface(edpy, c->es); c->es = EGL_NO_SURFACE; }
    if (c->win) { wl_egl_window_destroy(c->win); c->win = NULL; }
    if (c->is) { ivi_surface_destroy(c->is); c->is = NULL; }
    if (c->ws) { wl_surface_destroy(c->ws); c->ws = NULL; }
    if (ictl) ivi_controller_commit_changes(ictl);
}

/* Our layer onto the centre screen, on top. Never through ictl: winston applies a screen's add_layer to the list as
 * this connection last saw or set it, so it would drop the layers other programs (the HMI, another renderer) put on
 * the screen since. A connection made for it sees the list as it is (relist.h). */
static void layer_put(client *c) {
    if (relist_put(cfg.wayland_display, cfg.screen_id, LAYER_BASE + c->slot, screen_w, screen_h) == 0) c->listed = 1;
    if (!c->overlay)                                      /* overlays stay above: back on top after another layer */
        for (int i = 0; i < MAX_CLIENTS; i++)
            if (clients[i] && clients[i]->overlay && clients[i]->cl) layer_put(clients[i]);
}

/* The compositor says which screen the layer is on: none once another program set the screen's layers without it.
 * Shown, it goes back at once; hidden, at its next show (another app is in front meanwhile, its renderer's turn). */
static void l_screen(void *d, struct ivi_controller_layer *l, struct wl_output *o) {
    client *c = d;
    (void)l;
    if (!c->cl) return;
    if (o) { c->listed = 1; return; }
    if (!c->listed) return;
    c->listed = 0;
    if (!c->shown_on) { log_info("%s: layer taken off the screen", c->app); return; }
    uint64_t t = now_us();
    if (t - c->drop_t > DROP_WINDOW_US) { c->drop_t = t; c->drops = 0; }
    if (++c->drops > DROP_MAX) {
        if (c->drops == DROP_MAX + 1)
            log_warn("%s: layer taken off the screen more than %d times in %llu s; back at its next show", c->app, DROP_MAX,
                     (unsigned long long)(DROP_WINDOW_US / 1000000));
        return;
    }
    log_info("%s: layer taken off the screen, put back", c->app);
    layer_put(c);
}
static void l_int(void *d, struct ivi_controller_layer *l, int32_t v) { (void)d, (void)l, (void)v; }
static void l_opacity(void *d, struct ivi_controller_layer *l, wl_fixed_t v) { (void)d, (void)l, (void)v; }
static void l_rect(void *d, struct ivi_controller_layer *l, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)d, (void)l, (void)x, (void)y, (void)w, (void)h;
}
static void l_config(void *d, struct ivi_controller_layer *l, int32_t w, int32_t h) { (void)d, (void)l, (void)w, (void)h; }
static void l_destroyed(void *d, struct ivi_controller_layer *l) { (void)d, (void)l; }
static const struct ivi_controller_layer_listener layer_listener = {
    l_int, l_opacity, l_rect, l_rect, l_config, l_int, l_screen, l_destroyed,
};

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
    if (c->es == EGL_NO_SURFACE) { log_error("%s: eglCreateWindowSurface failed 0x%x", c->app, eglGetError()); return -1; }
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
    ivi_controller_layer_add_listener(c->cl, &layer_listener, c);
    ivi_controller_commit_changes(ictl);
    wl_display_roundtrip(dpy);                            /* the layer exists for the connection that puts it on */
    c->listed = 0; c->shown_on = 0; c->drops = 0;
    layer_put(c);                                         /* on top of the screen's layers */
    wl_display_roundtrip(dpy);
    log_info("%s: surface 0x%x on layer 0x%x at %d,%d %dx%d (scale %.3f)", c->app, sid, lid, c->x, c->y, c->w, c->h, c->xf.s);
    return 0;
}

static void frame_done(void *data, struct wl_callback *cb, uint32_t t) {
    (void)t;
    client *c = data;
    wl_callback_destroy(cb);
    c->frame_cb = NULL;
    if (trace_on()) trace(now_us(), "callback", c->app, c->tr_committed);
    dbr_presented(c);
    if (c->want_tick) send_tick(c);
}
static const struct wl_callback_listener frame_listener = { frame_done };

/* how the app's frames reach the screen: "layer", "zero-copy" (drawn into the HMI compositor's GPU buffer), "readback"
   (drawn, then read into its shared memory), "pixels" (a display-bridge app's pixels written into it) */
static const char *frame_path(const client *c) {
    if (c->mode != MODE_EMBED) return "layer";
    if (c->dialect == DIALECT_DBR) return "pixels";
    return embed_zero_copy() ? "zero-copy" : "readback";
}

static void stats(client *c, uint64_t dt) {
    c->stat_frames++; c->stat_sum += dt; if (dt > c->stat_max) c->stat_max = dt;
    uint64_t now = now_us();
    if (!c->stat_t0) c->stat_t0 = now;
    if (now - c->stat_t0 >= 1000000) {
        const char *path = frame_path(c);
        uint32_t p[4] = { c->stat_frames, (uint32_t)(c->stat_sum / (c->stat_frames ? c->stat_frames : 1)), (uint32_t)c->stat_max,
                          !strcmp(path, "zero-copy") ? STATS_ZERO_COPY : 0 };
        send_msg(c, E_STATS, p, c->dialect == DIALECT_NATIVE ? sizeof p : 3 * 4);
        unsigned n = 0, avg = 0, max = 0;
        if (c->mode == MODE_EMBED) embed_callbacks(&n, &avg, &max);
        if (access(STATS_LOG_FILE, F_OK) != 0)
            log_debug("%s: %u fps, render avg %u us max %u us, path %s", c->app, p[0], p[1], p[2], path);
        else if (c->mode == MODE_EMBED)
            log_info("stats %s: %u fps, render avg %u us max %u us, path %s, hmi callbacks %u, commit to callback avg %u us max %u us",
                     c->app, p[0], p[1], p[2], path, n, avg, max);
        else
            log_info("stats %s: %u fps, render avg %u us max %u us, path %s", c->app, p[0], p[1], p[2], path);
        c->stat_t0 = now; c->stat_frames = 0; c->stat_sum = 0; c->stat_max = 0;
    }
}

/* the time between two frames of an app that asked for a rate: the fps setting's in place of its own; 0 = none */
static uint64_t frame_us(const client *c) {
    if (!c->min_us) return 0;
    int f = cfg_fps(&cfg, c->app);
    return f > 0 ? 1000000ull / (uint64_t)f : c->min_us;
}

/* a capped app's frame that came too early: how long until it may be drawn (us), else 0 */
static uint64_t cap_wait(const client *c, uint64_t now) {
    uint64_t m = frame_us(c);
    return m && c->dirty && !c->frame_cb && now - c->last_draw < m ? m - (now - c->last_draw) : 0;
}

static void render_layer(client *c) {
    if (!c->es || !c->dirty || c->frame_cb) return;
    uint64_t t0 = now_us();
    if (cap_wait(c, t0)) return;                          /* too early for its cap: stays dirty, drawn later */
    c->last_draw = t0;
    c->tr_drawn = c->tr_committed = c->tr_frames;
    if (trace_on()) trace(t0, "draw-start", c->app, c->tr_drawn);
    eglMakeCurrent(edpy, c->es, c->es, ectx);
    gfx_draw(&c->g, &c->xf, c->w, c->h, c->frame, c->frame_words, 1);
    if (trace_on()) trace(now_us(), "draw-end", c->app, c->tr_drawn);
    c->frame_cb = wl_surface_frame(c->ws);
    wl_callback_add_listener(c->frame_cb, &frame_listener, c);
    eglSwapBuffers(edpy, c->es);
    if (trace_on()) trace(now_us(), "commit", c->app, c->tr_committed);
    c->dirty = 0;
    dbr_drawn(c);
    dbr_committed(c);
    if (c->frames_shown++ == 0) { apply_visibility(c); send_state(c); }
    stats(c, now_us() - t0);
}

/* ---------------- embed: drawn into the HMI compositor's buffer (embed.h, embed_gl.h) ---------------- */

/* With GPU buffers every frame goes into them, a display-bridge app's pixels too (made on the CPU, drawn into the
   dmabuf by GL): the HMI's compositor shows a GPU buffer with red and blue swapped once the same surface id has shown
   a shared-memory one in that HMI run, so the two are not mixed; when that fails, the connection goes over to
   shared memory for good (embed_readback).
   A frame is drawn as soon as the buffers allow and committed at the compositor's next frame callback. A display-bridge
   app's frame is drawn over the one drawn but not committed yet, if there is one. Another app's frame (a GL draw)
   waits for the compositor's frame callback; with tick_early it is drawn while the compositor still has the one
   before, when no drawn frame waits, and the app is asked for its next frame (TICK) once its last one is drawn and
   nothing drawn waits: it builds frame N+1 while the compositor shows frame N. */
static void render_embed(void) {
    client *c = embed_owner;
    if (!c) return;
    uint64_t t0 = now_us();
    int dbr = c->dialect == DIALECT_DBR;
    int draw = c->dirty && !cap_wait(c, t0) &&
               (dbr || !embed_waiting() || (cfg.tick_early && embed_ready() < 0));
    int b = draw ? embed_buffer(embed_zero_copy()) : -1;
    if (b >= 0) {
        c->last_draw = t0;
        c->tr_drawn = c->tr_frames;
        if (trace_on()) trace(t0, "draw-start", c->app, c->tr_drawn);
        int w = cfg.embed_area[2], h = cfg.embed_area[3];
        if (dbr) {
            int img[4] = { (int)c->dbr.img[0], (int)c->dbr.img[1], (int)c->dbr.img[2], (int)c->dbr.img[3] };
            int gpu = embed_gpu_index(b), pw = (int)c->dbr.w, ph = (int)c->dbr.h;
            embed_gl_cancel();
            if (gpu >= 0) {
                static uint8_t *rgba;
                static size_t cap;
                size_t need = (size_t)pw * ph * 4;
                if (need > cap) { free(rgba); cap = (rgba = malloc(need)) ? need : 0; }
                if (!rgba) return;
                dbr_rgba(rgba, c->dbr.px, pw, ph, c->dbr.format, c->dbr.lut);
                if (embed_gl_picture(gpu, rgba, pw, ph, img, w, h) < 0) { embed_readback("pixels could not be drawn into a GPU buffer"); return; }
            } else {
                dbr_blit(embed_pixels(b), w, h, img, c->dbr.px, pw, ph, c->dbr.format, c->dbr.lut);
            }
        } else {
            int gpu = embed_gpu_index(b), flags = embed_gl_begin(gpu, w, h);
            if (flags < 0) return;
            gfx_draw(&c->g, &c->xf, w, h, c->frame, c->frame_words, flags);
            embed_gl_end(gpu, embed_pixels(b), w, h);
        }
        embed_filled();
        c->dirty = 0;
        dbr_drawn(c);
        if (trace_on()) trace(now_us(), "draw-end", c->app, c->tr_drawn);
        stats(c, now_us() - t0);
    }
    if (embed_can_commit()) {
        embed_gl_resolve();
        embed_commit();
        c->tr_committed = c->tr_drawn;
        if (trace_on()) trace(now_us(), "commit", c->app, c->tr_committed);
        dbr_committed(c);
        if (c->frames_shown++ == 0) send_state(c);
    }
    /* tick_early: the next frame is asked for as soon as the app's last one is drawn and no drawn frame waits */
    if (cfg.tick_early && !dbr && c->want_tick && !c->dirty && embed_ready() < 0) send_tick(c);
}

void embed_frame_done(void) {
    client *c = embed_owner;
    if (c && trace_on()) trace(now_us(), "callback", c->app, c->tr_committed);
    if (c) dbr_presented(c);
    if (c && c->want_tick && !cfg.tick_early) send_tick(c);
}

void embed_changed(void) { update_all(); }

/* the HMI's process id, or -1 */
static int hmi_pid(void) {
    DIR *d = opendir("/proc");
    if (!d) return -1;
    struct dirent *e;
    int pid = -1;
    while (pid < 0 && (e = readdir(d))) {
        char p[64], name[64] = "";
        if (e->d_name[0] < '0' || e->d_name[0] > '9' || strlen(e->d_name) > 12) continue;
        snprintf(p, sizeof p, "/proc/%d/comm", atoi(e->d_name));
        FILE *f = fopen(p, "r");
        if (!f) continue;
        if (fgets(name, sizeof name, f)) name[strcspn(name, "\n")] = 0;
        fclose(f);
        if (!strcmp(name, cfg.hmi_process)) pid = atoi(e->d_name);
    }
    closedir(d);
    return pid;
}

/* the HMI started after mgu-render-hmi.sh mounted the template (its marker) */
static int template_loaded(void) {
    struct stat ms;
    int pid;
    if (stat(cfg.embed_marker, &ms) < 0 || (pid = hmi_pid()) < 0) return 0;
    char p[64], buf[1024];
    snprintf(p, sizeof p, "/proc/%d/stat", pid);
    FILE *f = fopen(p, "r");
    if (!f) return 0;
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;
    char *q = strrchr(buf, ')');                         /* field 22 (starttime), counted after the name */
    for (int k = 0; q && k < 20; k++) q = strchr(q + 1, ' ');
    if (!q) return 0;
    long long start = atoll(q + 1), btime = 0;
    char line[256];
    f = fopen("/proc/stat", "r");
    while (f && fgets(line, sizeof line, f)) if (!strncmp(line, "btime ", 6)) btime = atoll(line + 6);
    if (f) fclose(f);
    long hz = sysconf(_SC_CLK_TCK);
    return btime && hz > 0 && btime + start / hz + 1 >= (long long)ms.st_mtime;
}

static uint64_t t_listen;
static int embed_settling(uint64_t t) { return cfg.embed && embed_connecting() && t - t_listen < 3000000; }

static int embed_available(void) { return cfg.embed && embed_connected() && template_loaded(); }

/* ---------------- touch (touch.c asks) ---------------- */
int touch_owner_at(int x, int y, int in_area) {
    for (int k = 0; k < 2 * MAX_CLIENTS; k++) {           /* overlays first, wherever they claim; then the others */
        client *c = clients[k % MAX_CLIENTS];
        if (!c || !shown(c) || c->overlay != (k < MAX_CLIENTS) || (!c->overlay && !in_area)) continue;
        if (c->mode == MODE_EMBED) {                      /* only in the HMI's box */
            const int *b = cfg.embed_area;
            if (x < b[0] || y < b[1] || x >= b[0] + b[2] || y >= b[1] + b[3]) continue;
        }
        float bx, by; origin(c, &bx, &by);
        for (int j = 0; j < c->nclaim; j++) {
            const float *r = c->claim[j], s = c->xf.s;
            float x0 = bx + c->xf.ox + r[0] * s, y0 = by + c->xf.oy + r[1] * s;
            if (x >= x0 && y >= y0 && x < x0 + r[2] * s && y < y0 + r[3] * s) return k % MAX_CLIENTS;
        }
    }
    return -1;
}

void touch_send(int slot, int phase, int x, int y) {
    client *c = clients[slot];
    if (!c) return;
    uint64_t t_in = trace_on() ? now_us() : 0;
    float bx, by; origin(c, &bx, &by);
    uint32_t p[3] = { (uint32_t)phase };
    float lx = (x - bx - c->xf.ox) / c->xf.s, ly = (y - by - c->xf.oy) / c->xf.s;
    if (c->dialect == DIALECT_DBR) {                     /* in frame pixels; the phases are DBR1's kinds */
        const float *r = c->dbr.img;
        uint8_t t[8];
        dbr_touch_encode((unsigned)phase, (int)floorf((lx - r[0]) * (float)c->dbr.w / r[2]),
                         (int)floorf((ly - r[1]) * (float)c->dbr.h / r[3]), t);
        dbr_send(c, DBR_TOUCH, 0, t, sizeof t);
        return;
    }
    memcpy(&p[1], &lx, 4); memcpy(&p[2], &ly, 4);
    send_msg(c, EI_TOUCH, p, sizeof p);
    c->tr_touches++;
    if (t_in) {
        trace(t_in, "touch-in", c->app, c->tr_touches);
        trace(now_us(), "touch-fwd", c->app, c->tr_touches);
    }
}

/* the HMI was touched: layer apps that claim close (an embed app's page is the HMI's to leave) */
void touch_outside(void) {
    for (int i = 0; i < MAX_CLIENTS; i++) {
        client *c = clients[i];
        if (!c || !c->nclaim || c->mode != MODE_LAYER || c->dialect == DIALECT_DBR || c->overlay || !shown(c)) continue;
        c->visible = 0;
        apply_visibility(c);
        send_msg(c, EI_CLOSED, NULL, 0);
        send_state(c);
        log_info("%s: the HMI was touched - closed", c->app);
    }
}

static int any_claim(void) {                           /* 0 none, 1 a shown app claims, 2 an overlay claims */
    int any = 0;
    for (int i = 0; i < MAX_CLIENTS; i++)
        if (clients[i] && clients[i]->nclaim && shown(clients[i])) { if (clients[i]->overlay) return 2; any = 1; }
    return any;
}

static void touch_defaults(int area[4]) {
    if (cfg.touch_area[2]) { memcpy(area, cfg.touch_area, 4 * sizeof *area); return; }
    area[0] = area[1] = area[2] = area[3] = 0;
    if (screen_w == 2880 && screen_h == 960) { area[1] = 76; area[2] = 2880; area[3] = 764; }   /* iDrive 8: title strip, climate bar */
    else if (screen_w == 1920 && screen_h == 720) { area[0] = 84; area[1] = 76; area[2] = 1836; area[3] = 644; }   /* iDrive 7: back column, title strip */
}

/* ---------------- controller gate (upstream inputgate) ---------------- */
static int grabbing(const client *c, uint64_t t) { return c->grab_t && t - c->grab_t < GRAB_US && shown(c); }

/* The gate's file and event socket are upstream's interface, which upstream's renderer also uses: they are held
 * only while one of our apps grabs, and the file only while the event socket is ours. Bound by another renderer,
 * the controller stays the HMI's (and that renderer's) for our apps. */
static void ctl_gate_update(uint64_t t) {
    if (!cfg.controller_gate[0]) return;
    int want = 0;
    for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i] && grabbing(clients[i], t)) want = 1;
    if (want && ccu_fd < 0 && t >= ccu_retry) {
        ccu_open();
        if (ccu_fd < 0) ccu_retry = t + 5000000;
    }
    if (ccu_fd < 0) want = 0;
    if (want) {
        if (!ctl_gate_on || t - ctl_gate_t >= GATE_TOUCH_US) {
            int fd = open(cfg.controller_gate, O_WRONLY | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0644);
            if (fd >= 0) { futimens(fd, NULL); close(fd); }
            if (!ctl_gate_on) log_info("controller: held for an app");
            ctl_gate_on = 1; ctl_gate_t = t;
        }
    } else if (ctl_gate_on) {
        unlink(cfg.controller_gate); ctl_gate_on = 0;
        log_info("controller: back to the HMI");
    }
    if (!want && ccu_fd >= 0) { close(ccu_fd); ccu_fd = -1; }
}

static void ccu_read(void) {
    uint8_t ev[64];
    ssize_t n;
    uint64_t t = now_us();
    while ((n = recv(ccu_fd, ev, sizeof ev, MSG_DONTWAIT)) > 0) {
        if (!ctl_gate_on || n < 5) continue;
        for (int i = 0; i < MAX_CLIENTS; i++) {
            client *c = clients[i];
            if (c && grabbing(c, t)) send_msg(c, c->dialect == DIALECT_NATIVE ? X_CCU : EU_CCU, ev, (uint32_t)n);
        }
    }
}

/* the HMI runs with the controller gate library */
static int ctl_gate_loaded(void) {
    int pid = cfg.controller_lib[0] ? hmi_pid() : -1;
    if (pid < 0) return 0;
    char p[64], line[512];
    snprintf(p, sizeof p, "/proc/%d/maps", pid);
    FILE *f = fopen(p, "r");
    int found = 0;
    while (f && !found && fgets(line, sizeof line, f)) found = strstr(line, cfg.controller_lib) != NULL;
    if (f) fclose(f);
    return found;
}

/* ---------------- messages ---------------- */
static void client_free(client *c) {
    log_info("%s: disconnected", c->app[0] ? c->app : "client");
    touch_forget(c->slot);
    if (c == embed_owner) embed_owner = NULL;
    if (dpy) {
        eglMakeCurrent(edpy, init_es, init_es, ectx);
        surface_destroy(c);
        gfx_client_free(&c->g);
        wl_display_flush(dpy);
    }
    if (c->rec) fclose(c->rec);
    close(c->fd);
    free(c->in); free(c->out); free(c->frame); free(c->dbr.px);
    clients[c->slot] = NULL;
    free(c);
    update_all();
}

static void make_current_any(client *c) {
    if (!dpy) return;
    if (c->es != EGL_NO_SURFACE) eglMakeCurrent(edpy, c->es, c->es, ectx);
    else eglMakeCurrent(edpy, init_es, init_es, ectx);
}

static void app_area(int r[4]) {
    if (cfg.app_area[2]) { memcpy(r, cfg.app_area, 4 * sizeof *r); return; }
    if (screen_w == 2880 && screen_h == 960) { r[0] = 0; r[1] = 76; r[2] = 2880; r[3] = 764; }
    else { r[0] = 108; r[1] = 82; r[2] = 1790; r[3] = 638; }
}

static void hello(client *c, const uint8_t *p, uint32_t len) {
    int native = hello_parse(p, len, c->app, sizeof c->app);
    if (native) {
        c->dialect = DIALECT_NATIVE;
        int emb = embed_available(), area[4];
        app_area(area);
        uint32_t caps = CAP_PIXMAP | CAP_VIDEO | (touch_on ? CAP_TOUCH_ROUTE : 0) | (cfg.foreground_gate[0] ? CAP_FRONT_GATE : 0) |
                        (ctl_gate_loaded() && ccu_free() ? CAP_CONTROLLER : 0) | (emb && embed_zero_copy() ? CAP_EMBED_ZERO_COPY : 0);
        /* a gate that cannot tell which app is in front would never show the app: no mode, the app keeps its own screens */
        uint32_t modes = gate_applies(c) && gate_unavailable() ? 0 : (1u << (MODE_LAYER - 1)) | (emb ? 1u << (MODE_EMBED - 1) : 0);
        uint32_t x[15] = { MGU_NATIVE_VERSION, modes, caps };
        for (int k = 0; k < 4; k++) { x[3 + k] = emb ? (uint32_t)cfg.embed_area[k] : 0; x[7 + k] = (uint32_t)area[k]; }
        x[11] = GFX_PIXMAP_SIDE; x[12] = (uint32_t)refresh_mhz;
        send_msg(c, X_READY, x, 13 * 4);
    }
    int listed_root = c->uid == 0 && listed(cfg.overlay_apps, c->app);
    c->overlay = listed_root && idrive8();
    log_info("%s: connected (uid %u%s%s)", c->app, c->uid, native ? ", mgu-render/1" : "",
             c->overlay ? ", overlay" : listed_root ? ", overlay_apps is for iDrive 8 only" : "");
    uint32_t r[4] = { MGU_PROTO_VERSION, (uint32_t)screen_w, (uint32_t)screen_h, (uint32_t)touch_on };
    send_msg(c, E_READY, r, sizeof r);
}

static void set_dialect(client *c, int d) {
    c->dialect = d;
    c->g.upstream_ops = d == DIALECT_UPSTREAM;
    log_info("%s: speaks the %s dialect", c->app, dialect_name(d));
}

static int set_mode(client *c, uint32_t mode) {
    if (mode != MODE_LAYER && mode != MODE_EMBED) return -1;
    if ((int)mode == c->mode) return 0;
    if (mode == MODE_EMBED && !embed_available()) {
        send_error(c, "embed: not available (the HMI's page template is not loaded)");
        send_state(c);
        return 0;
    }
    c->mode = (int)mode;
    c->frames_shown = 0;
    c->dirty = c->frame_words > 0;
    if (dpy) {
        if (mode == MODE_EMBED) surface_destroy(c);
        else if (c->placed && surface_create(c) < 0) { send_error(c, "surface"); return -1; }
    }
    log_info("%s: %s mode", c->app, mode == MODE_EMBED ? "embed" : "layer");
    if (c->placed) { c->want_tick = 1; if (!c->frame_cb) send_tick(c); }
    update_all();
    return 0;
}

static int claim(client *c, const uint32_t *w, size_t nw) {
    if (nw < 1 || w[0] > 16 || nw < 1 + 4 * (size_t)w[0]) return -1;
    c->nclaim = (int)w[0];
    memcpy(c->claim, w + 1, (size_t)c->nclaim * 16);
    log_debug("%s: claims %d touch area(s)", c->app, c->nclaim);
    return 0;
}

static int picture(client *c, const uint8_t *p, uint32_t len) {
    const uint32_t *w = (const uint32_t *)p;
    if (len < 12) return -1;
    uint32_t iw = w[1], ih = w[2];
    if (iw < 1 || ih < 1 || iw > GFX_IMG_SIDE || ih > GFX_IMG_SIDE || len != 12 + (size_t)iw * ih * 4) return -1;
    make_current_any(c);
    if (gfx_image_def(&c->g, w[0], (int)iw, (int)ih, p + 12) < 0) { log_warn("%s: %s", c->app, gfx_error()); send_error(c, gfx_error()); }
    return 0;
}

static int video(client *c, const uint8_t *p, uint32_t len) {
    if (len < 8) return -1;
    uint32_t id; memcpy(&id, p, 4);
    char path[128];
    size_t n = strnlen((const char *)p + 4, len - 4);
    if (n >= sizeof path) n = sizeof path - 1;
    memcpy(path, p + 4, n); path[n] = 0;
    make_current_any(c);
    /* a bad path is the app's error, not a reason to drop it */
    if (gfx_video_def(&c->g, id, path, c->uid) < 0) { log_warn("%s: %s", c->app, gfx_error()); send_error(c, gfx_error()); }
    else log_debug("%s: video %u from %s", c->app, id, path);
    return 0;
}

static int grab(client *c, const uint32_t *w, size_t nw) {
    if (nw < 1) return -1;
    c->grab_t = w[0] ? now_us() : 0;
    return 0;
}

/* returns -1 to drop the client */
static int handle(client *c, uint32_t type, const uint8_t *p, uint32_t len) {
    const uint32_t *w = (const uint32_t *)p;
    size_t nw = len / 4;
    if (type >= 9 && type <= 11 && c->dialect == DIALECT_UNKNOWN) {
        int d = dialect_of(type, p, len);
        if (d == DIALECT_UNKNOWN) return -1;              /* fits neither dialect's message */
        set_dialect(c, d);
    }
    switch (type) {
    case M_HELLO:
        hello(c, p, len);
        return 0;
    case 9:
        if (c->dialect == DIALECT_UPSTREAM) {
            if (nw < 3 || (uint64_t)w[1] * w[2] * 4 + 12 > len) return -1;
            if (!c->placed) return 0;
            make_current_any(c);
            if (gfx_image_upstream(&c->g, w[0], (int)w[1], (int)w[2], p + 12) < 0) send_error(c, gfx_error());
            return 0;
        }
        return claim(c, w, nw);
    case 10:
        if (c->dialect == DIALECT_UPSTREAM) return grab(c, w, nw);
        return picture(c, p, len);
    case 11:
        if (c->dialect == DIALECT_UPSTREAM) return 0;
        if (nw < 1) return -1;
        make_current_any(c);
        gfx_image_drop(&c->g, w[0]);
        return 0;
    case MI_FPS:
        if (nw < 1) return -1;
        c->min_us = w[0] ? 1000000ull / (w[0] > 1000 ? 1000 : w[0]) : 0;
        log_debug("%s: at most %u frames a second", c->app, w[0]);
        return 0;
    case MI_VIDEO:
        if (c->dialect == DIALECT_UPSTREAM) return 0;
        return video(c, p, len);
    case MI_DROP_VIDEO:
        if (c->dialect == DIALECT_UPSTREAM) return 0;
        if (nw < 1) return -1;
        make_current_any(c);
        gfx_video_drop(&c->g, w[0]);
        return 0;
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
            if (c->mode == MODE_LAYER && surface_create(c) < 0) { send_error(c, "surface"); return -1; }
        } else if (c->mode == MODE_LAYER) {
            ivi_controller_layer_set_destination_rectangle(c->cl, x, y, ww, hh);
            ivi_controller_commit_changes(ictl);
        } else {
            c->dirty = c->frame_words > 0;
        }
        c->want_tick = 1;
        if (!c->frame_cb) send_tick(c);
        return 0;
    }
    case M_SHOW: {
        if (nw < 1) return -1;
        c->visible = w[0] != 0;
        if (c->visible) c->show_seq = ++show_counter;
        log_debug("%s: %s", c->app, c->visible ? "show" : "hide");
        update_all();
        if (c->visible) { c->want_tick = 1; if (!c->frame_cb) send_tick(c); }
        return 0;
    }
    case M_ATLAS: {
        if (nw < 3) return -1;
        uint32_t id = w[0], aw = w[1], ah = w[2];
        if (aw > 4096 || ah > 4096 || 12 + (size_t)aw * ah > len) return -1;
        make_current_any(c);
        if (gfx_atlas(&c->g, id, (int)aw, (int)ah, p + 12) < 0) send_error(c, gfx_error());
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
        if (gfx_layer_def(&c->g, w[0], lw, lh, c->xf.s, w + 3, nw - 3) < 0) send_error(c, gfx_error());
        return 0;
    }
    case M_DROP_LAYER:
        if (nw < 1) return -1;
        make_current_any(c);
        gfx_layer_drop(&c->g, w[0]);
        return 0;
    case M_FRAME: {
        int first = !c->frame_words;
        if (nw > c->frame_cap) { c->frame_cap = nw + 1024; c->frame = realloc(c->frame, c->frame_cap * 4); }
        memcpy(c->frame, p, nw * 4);
        c->frame_words = nw;
        c->dirty = 1;
        c->want_tick = 1;
        c->tr_frames++;
        if (trace_on()) trace(now_us(), "frame-rx", c->app, c->tr_frames);
        if (first && c->mode == MODE_EMBED) update_all();
        return 0;
    }
    }
    if (c->dialect != DIALECT_NATIVE) return 0;           /* newer client: ignore */
    switch (type) {
    case X_MODE:
        if (nw < 1) return -1;
        return set_mode(c, w[0]);
    case X_GRAB:
        return grab(c, w, nw);
    case X_PIXMAP:
        if (nw < 5) return -1;
        make_current_any(c);
        if (gfx_pixmap_def(&c->g, w[0], (int)w[1], (int)w[2], (int)w[3], w[4] != 0) < 0) send_error(c, gfx_error());
        return 0;
    case X_PIXELS: {
        if (nw < 1) return -1;
        make_current_any(c);
        int r = gfx_pixmap_pixels(&c->g, w[0], p + 4, len - 4);
        if (r == -2) send_error(c, gfx_error());
        return r == -1 ? -1 : 0;
    }
    case X_PALETTE:
        if (len < 4 + 768) return -1;
        make_current_any(c);
        if (gfx_pixmap_palette(&c->g, w[0], p + 4) < 0) send_error(c, gfx_error());
        return 0;
    default:
        return 0;
    }
}

/* ---------------- display-bridge's apps (DBR1, dbr.h) ---------------- */
#define DBR_PIXMAP 1
#define DBR_MAX_IN_FLIGHT 3      /* display-bridge's: its queue of 2, and the frame being shown */

/* ERROR, then the connection ends (-1) */
static int dbr_fail(client *c, unsigned code, const char *why) {
    log_warn("%s: %s", c->app, why);
    dbr_error(c, code, why);
    return -1;
}

/* HELLO: the frame becomes pixmap DBR_PIXMAP, shown fitted into the HMI page's box (embed), or into the app area
 * on the app's own layer when the page template is not loaded */
static int dbr_hello(client *c, const uint8_t *p) {
    struct dbr_hello h;
    dbr_hello_decode(p, &h);
    size_t bpp = dbr_bpp(h.format);
    if (h.version > DBR_VERSION || !bpp || h.width < 1 || h.height < 1 || h.width > DBR_MAX_WIDTH || h.height > DBR_MAX_HEIGHT)
        return dbr_fail(c, DBR_ERR_UNSUPPORTED, "unsupported version, format or size");
    int emb = embed_available(), area[4], r[4];
    if (emb && !(c->dbr.px = calloc((size_t)h.width * h.height, bpp))) return dbr_fail(c, DBR_ERR_DISPLAY, "out of memory");
    uint8_t gray[DBR_PALETTE_SIZE];                      /* until a PALETTE: index i is grey i, as display-bridge's */
    for (int i = 0; i < 256; i++) gray[3 * i] = gray[3 * i + 1] = gray[3 * i + 2] = (uint8_t)i;
    dbr_palette_lut(gray, c->dbr.lut);
    int pix = h.format == DBR_FMT_INDEX8 ? PIX_INDEX8 : h.format == DBR_FMT_RGBA8888 ? PIX_RGBA_OPAQUE : PIX_RGBA_PREMUL;
    make_current_any(c);
    if (!emb && (gfx_pixmap_def(&c->g, DBR_PIXMAP, (int)h.width, (int)h.height, pix, 0) < 0 ||
                 (pix == PIX_INDEX8 && gfx_pixmap_palette(&c->g, DBR_PIXMAP, gray) < 0)))
        return dbr_fail(c, DBR_ERR_DISPLAY, gfx_error());
    if (emb) memcpy(area, cfg.embed_area, sizeof area);
    else app_area(area);
    if (!emb && h.dst_w && h.dst_h && h.dst_x >= area[0] && h.dst_y >= area[1] &&
        h.dst_x + h.dst_w <= area[0] + area[2] && h.dst_y + h.dst_h <= area[1] + area[3]) {
        r[0] = h.dst_x; r[1] = h.dst_y; r[2] = h.dst_w; r[3] = h.dst_h;
    } else {
        dbr_fit(area, (int)h.width, (int)h.height, r);
    }
    c->dbr.format = h.format; c->dbr.w = h.width; c->dbr.h = h.height; c->dbr.bpp = bpp;
    c->xf.s = 1; c->xf.ox = 0; c->xf.oy = 0;
    c->placed = 1;
    if (emb) {
        c->mode = MODE_EMBED;
        c->x = area[0]; c->y = area[1]; c->w = area[2]; c->h = area[3];
    } else {
        c->mode = MODE_LAYER;
        c->x = r[0]; c->y = r[1]; c->w = r[2]; c->h = r[3];
        if (dpy && surface_create(c) < 0) return dbr_fail(c, DBR_ERR_DISPLAY, "the compositor refused the surface");
    }
    float img[4] = { (float)(r[0] - c->x), (float)(r[1] - c->y), (float)r[2], (float)r[3] };
    memcpy(c->dbr.img, img, sizeof img);
    c->nclaim = 1;                                       /* touch on the picture is the app's */
    memcpy(c->claim[0], img, sizeof img);
    struct dbr_ready rd = { DBR_VERSION, DBR_MAX_IN_FLIGHT, (unsigned)screen_w, (unsigned)screen_h, (uint32_t)refresh_mhz,
                            emb ? cfg.embed_surface_id : SURF_BASE + c->slot, emb ? 0 : LAYER_BASE + c->slot,
                            (emb ? DBR_READY_HMI : DBR_READY_CONTROLLER) | (touch_on ? DBR_READY_TOUCH : 0),
                            { r[0], r[1], r[2], r[3] } };
    uint8_t out[DBR_READY_SIZE];
    dbr_ready_encode(&rd, out);
    dbr_send(c, DBR_READY, 0, out, sizeof out);
    log_info("%s: connected (display-bridge's protocol): %ux%u format %u at %d,%d %dx%d, %s", c->app, h.width, h.height,
             h.format, r[0], r[1], r[2], r[3], emb ? "in the HMI's page" : "on its own layer");
    return 0;
}

/* FRAME (one region, the whole frame) or RECTS: written into the picture (and on a layer the pixmap); the frame
   waiting before it is dropped */
static int dbr_frame(client *c, uint32_t seq, int n, int rects[][4], const uint8_t *px) {
    if (c->mode != MODE_EMBED) make_current_any(c);
    for (int k = 0; k < n; k++) {
        int x = rects[k][0], y = rects[k][1], w = rects[k][2], h = rects[k][3];
        size_t row = (size_t)w * c->dbr.bpp, sz = row * h, pitch = (size_t)c->dbr.w * c->dbr.bpp;
        if (c->mode == MODE_EMBED) {
            for (int j = 0; j < h; j++) memcpy(c->dbr.px + (size_t)(y + j) * pitch + (size_t)x * c->dbr.bpp, px + j * row, row);
            px += sz;
            continue;
        }
        int r;
        if (c->dbr.format == DBR_FMT_XRGB8888 || c->dbr.format == DBR_FMT_ARGB8888) {
            uint8_t *rgba = malloc(sz);
            if (!rgba) return dbr_fail(c, DBR_ERR_DISPLAY, "out of memory");
            dbr_to_rgba(rgba, px, (size_t)w * h, c->dbr.format);
            r = gfx_pixmap_write(&c->g, DBR_PIXMAP, x, y, w, h, rgba);
            free(rgba);
        } else {
            r = gfx_pixmap_write(&c->g, DBR_PIXMAP, x, y, w, h, px);
        }
        if (r < 0) return dbr_fail(c, DBR_ERR_DISPLAY, gfx_error());
        px += sz;
    }
    if (c->dbr.pending) dbr_send(c, DBR_DROPPED, c->dbr.pending_seq, NULL, 0);
    c->dbr.pending = 1; c->dbr.pending_seq = seq;
    c->dirty = 1;
    if (!c->frame_words) {                               /* a layer's picture: black, the pixmap over img */
        const float *g = c->dbr.img;
        uint32_t w[9] = { OP_CLEAR, 0x000000ffu, OP_IMAGE };
        float r0 = 0;
        memcpy(&w[3], &g[0], 4); memcpy(&w[4], &g[1], 4); memcpy(&w[5], &g[2], 4); memcpy(&w[6], &g[3], 4);
        memcpy(&w[7], &r0, 4); w[8] = DBR_PIXMAP;
        c->frame = malloc(sizeof w);
        if (!c->frame) return dbr_fail(c, DBR_ERR_DISPLAY, "out of memory");
        memcpy(c->frame, w, sizeof w);
        c->frame_cap = c->frame_words = 9;
        update_all();
    }
    return 0;
}

static int dbr_handle(client *c, unsigned type, uint32_t seq, const uint8_t *p, uint32_t len) {
    if (type == DBR_HELLO) {
        if (c->placed || len != DBR_HELLO_SIZE) return dbr_fail(c, DBR_ERR_PROTOCOL, "HELLO must come once, with 16 bytes");
        return dbr_hello(c, p);
    }
    if (type == DBR_PING) return 0;
    if (!c->placed) return dbr_fail(c, DBR_ERR_PROTOCOL, "HELLO first");
    switch (type) {
    case DBR_PALETTE:
        if (c->dbr.format != DBR_FMT_INDEX8 || len != DBR_PALETTE_SIZE)
            return dbr_fail(c, DBR_ERR_PROTOCOL, "PALETTE needs an INDEX8 session and 768 bytes");
        dbr_palette_lut(p, c->dbr.lut);
        if (c->mode == MODE_EMBED) return 0;
        make_current_any(c);
        if (gfx_pixmap_palette(&c->g, DBR_PIXMAP, p) < 0) return dbr_fail(c, DBR_ERR_DISPLAY, gfx_error());
        return 0;
    case DBR_FRAME: {
        if (len != (size_t)c->dbr.w * c->dbr.h * c->dbr.bpp) return dbr_fail(c, DBR_ERR_PROTOCOL, "FRAME must be one whole frame");
        int whole[1][4] = { { 0, 0, (int)c->dbr.w, (int)c->dbr.h } };
        return dbr_frame(c, seq, 1, whole, p);
    }
    case DBR_RECTS: {
        int rects[DBR_MAX_RECTS][4];
        const uint8_t *px;
        int n = dbr_rects(p, len, (int)c->dbr.w, (int)c->dbr.h, c->dbr.bpp, rects, &px);
        if (n < 0) return dbr_fail(c, DBR_ERR_PROTOCOL, "RECTS: regions outside the frame or not matching their pixels");
        return dbr_frame(c, seq, n, rects, px);
    }
    case DBR_SHOW:
    case DBR_HIDE:
        c->visible = type == DBR_SHOW;
        if (c->visible) c->show_seq = ++show_counter;
        log_debug("%s: %s", c->app, c->visible ? "show" : "hide");
        update_all();
        return 0;
    default:
        return dbr_fail(c, DBR_ERR_PROTOCOL, "unknown message");
    }
}

static void record(client *c, uint32_t type, const uint8_t *msg, uint32_t len) {
    static int n;
    if (type == M_HELLO && !c->rec && cfg.record_dir[0]) {
        char path[256], app[64];
        hello_parse(msg + 8, len, app, sizeof app);
        for (char *s = app; *s; s++) if (*s == '/' || *s == '?' || *s == ' ') *s = '_';
        snprintf(path, sizeof path, "%s/%s-%d-%d.bin", cfg.record_dir, app, (int)getpid(), ++n);
        int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        c->rec = fd >= 0 ? fdopen(fd, "wb") : NULL;
        if (c->rec) log_info("recording to %s", path);
        else log_warn("recording to %s: %s", path, strerror(errno));
    }
    if (c->rec) fwrite(msg, 1, 8 + (size_t)len, c->rec);
}

static int client_read(client *c) {
    for (;;) {
        if (c->incap - c->inlen < 65536) { c->incap = c->incap ? c->incap * 2 : 262144; c->in = realloc(c->in, c->incap); }
        ssize_t r = recv(c->fd, c->in + c->inlen, c->incap - c->inlen, MSG_DONTWAIT);
        if (r == 0) return -1;
        if (r < 0) { if (errno == EAGAIN || errno == EWOULDBLOCK) break; if (errno == EINTR) continue; return -1; }
        c->inlen += (size_t)r;
        c->last_msg = now_us();
        if (c->stale) { c->stale = 0; log_info("%s: talking again", c->app); update_all(); }
    }
    if (!c->started && c->inlen >= 4 && dbr_is_magic(c->in)) {
        c->dialect = DIALECT_DBR;
        snprintf(c->app, sizeof c->app, "display-bridge app (uid %u)", c->uid);
    }
    size_t off = 0;
    if (c->dialect == DIALECT_DBR) {
        while (c->inlen - off >= DBR_HEADER) {
            unsigned type; uint32_t len, seq;
            if (dbr_header(c->in + off, &type, &len, &seq) < 0) { log_warn("%s: bad message", c->app); return -1; }
            if (len > MAX_MSG) return -1;
            if (c->inlen - off - DBR_HEADER < len) {
                if (c->incap < len + DBR_HEADER) { c->incap = len + DBR_HEADER + 65536; uint8_t *n = realloc(c->in, c->incap); if (!n) return -1; c->in = n; }
                break;
            }
            c->started = 1;
            if (dbr_handle(c, type, seq, c->in + off + DBR_HEADER, len) < 0) return -1;
            off += DBR_HEADER + len;
        }
        if (off) { memmove(c->in, c->in + off, c->inlen - off); c->inlen -= off; }
        return 0;
    }
    while (c->inlen - off >= 8) {
        uint32_t type, len;
        memcpy(&type, c->in + off, 4); memcpy(&len, c->in + off + 4, 4);
        if (len > MAX_MSG) return -1;
        if (c->inlen - off - 8 < len) {
            if (c->incap < len + 8) { c->incap = len + 8 + 65536; uint8_t *n = realloc(c->in, c->incap); if (!n) return -1; c->in = n; }
            break;
        }
        c->started = 1;
        record(c, type, c->in + off, len);
        /* payload must be 4-byte aligned for the word views: copy if it is not */
        const uint8_t *pl = c->in + off + 8;
        uint8_t *tmp = NULL;
        if (((uintptr_t)pl & 3) != 0) { tmp = malloc(len + 4); memcpy(tmp, pl, len); pl = tmp; }
        int rc = handle(c, type, pl, len);
        free(tmp);
        if (rc < 0) { log_warn("%s: bad message %u (len %u)", c->app, type, len); return -1; }
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
    if (slot < 0) { log_warn("%d apps connected already: refused", MAX_CLIENTS); close(fd); return; }
    int sz = 4 << 20; setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &sz, sizeof sz);
    client *c = calloc(1, sizeof *c);
    c->fd = fd; c->slot = slot; c->xf.s = 1; c->es = EGL_NO_SURFACE; c->mode = MODE_LAYER; c->uid = UINT32_MAX; c->g.name = c->app;
    struct ucred cr; socklen_t cl = sizeof cr;
    if (!getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cr, &cl)) c->uid = cr.uid;
    clients[slot] = c;
}

/* ---------------- offscreen replay (testing on a PC) ---------------- */
static int replay(const char *in, const char *out, const char *raw, uint32_t uid) {
    setenv("EGL_PLATFORM", "surfaceless", 0);
    if (egl_setup(EGL_DEFAULT_DISPLAY, 1) < 0) return 1;
    EGLint pa[] = { EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE };
    EGLSurface pb = eglCreatePbufferSurface(edpy, ecfg, pa);
    if (!eglMakeCurrent(edpy, pb, pb, ectx)) { log_error("eglMakeCurrent failed 0x%x", eglGetError()); return 1; }
    if (gfx_init() < 0) { log_error("gfx_init: %s", gfx_error()); return 1; }
    FILE *f = fopen(in, "rb");
    if (!f) { perror(in); return 1; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc(n + 4); if (fread(buf, 1, n, f) != (size_t)n) return 1; fclose(f);
    client c; memset(&c, 0, sizeof c); c.fd = -1; c.xf.s = 1; c.mode = MODE_LAYER; strcpy(c.app, "replay");
    c.uid = uid; c.g.name = c.app;
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
        } else if (handle(&c, type, pl, len) < 0) { log_error("bad message %u", type); return 1; }
        free(pl);
        off += 8 + len;
    }
    if (rf) { fclose(rf); free(rpx); }
    if (!fbo) { log_error("no frame in %s", in); return 1; }
    uint8_t *px = malloc((size_t)c.w * c.h * 4);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glReadPixels(0, 0, c.w, c.h, GL_RGBA, GL_UNSIGNED_BYTE, px);
    FILE *o = fopen(out, "wb");
    if (!o) { perror(out); return 1; }
    /* PAM (RGBA), bottom-up rows flipped */
    fprintf(o, "P7\nWIDTH %d\nHEIGHT %d\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n", c.w, c.h);
    for (int y = c.h - 1; y >= 0; y--) fwrite(px + (size_t)y * c.w * 4, 1, (size_t)c.w * 4, o);
    fclose(o);
    log_info("%d frames, %.2f ms per frame (%s), %dx%d, %s dialect -> %s", frames, tsum / 1000.0 / (frames ? frames : 1),
             (const char *)glGetString(GL_RENDERER), c.w, c.h, dialect_name(c.dialect), out);
    return 0;
}

/* ---------------- socket ---------------- */
static int open_listener(void) {
    const char *pid = getenv("LISTEN_PID"), *fds = getenv("LISTEN_FDS");
    if (pid && fds && atoi(pid) == (int)getpid() && atoi(fds) >= 1) {
        unsetenv("LISTEN_PID"); unsetenv("LISTEN_FDS"); unsetenv("LISTEN_FDNAMES");
        fcntl(3, F_SETFL, O_NONBLOCK);
        fcntl(3, F_SETFD, FD_CLOEXEC);
        log_info("listening on the socket-activated descriptor");
        return 3;
    }
    const char *path = cfg.socket_path;
    char dir[sizeof cfg.socket_path];
    snprintf(dir, sizeof dir, "%s", path);
    char *sl = strrchr(dir, '/');
    if (sl && sl != dir) { *sl = 0; mkdir(dir, 0755); }
    unlink(path);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    struct sockaddr_un sa = { .sun_family = AF_UNIX };
    snprintf(sa.sun_path, sizeof sa.sun_path, "%s", path);
    mode_t old = umask(0117);
    if (fd < 0 || bind(fd, (struct sockaddr *)&sa, sizeof sa) < 0 || listen(fd, 8) < 0) { log_error("socket %s: %s", path, strerror(errno)); umask(old); return -1; }
    umask(old);
    struct group *g = cfg.socket_group[0] ? getgrnam(cfg.socket_group) : NULL;
    if (g && chown(path, (uid_t)-1, g->gr_gid) < 0) log_warn("chown %s: %s", path, strerror(errno));
    chmod(path, g ? 0660 : 0666);
    own_socket = 1;
    log_info("listening on %s", path);
    return fd;
}

/* controller events from the HMI's controller gate (abstract socket: no file, gone with us) */
static int ccu_bind(void) {
    int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return -1;
    struct sockaddr_un ca = { .sun_family = AF_UNIX };
    static const char cn[] = "\0mgu-renderd-ccu";
    memcpy(ca.sun_path, cn, sizeof cn - 1);
    if (bind(fd, (struct sockaddr *)&ca, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + sizeof cn - 1)) == 0) return fd;
    int e = errno;
    close(fd);
    errno = e;
    return -1;
}
static void ccu_open(void) {
    ccu_fd = ccu_bind();
    if (ccu_fd < 0) log_warn("controller socket: %s%s", strerror(errno), errno == EADDRINUSE ? " (another renderer has it)" : "");
}
/* the controller gate can be ours: its event socket is ours already, or free */
static int ccu_free(void) {
    if (ccu_fd >= 0) return 1;
    int fd = ccu_bind();
    if (fd >= 0) close(fd);
    return fd >= 0;
}

static int touch_start(void) {
    char iface[32];
    snprintf(iface, sizeof iface, "%s", cfg.touch_iface);
    if (!strcmp(iface, "auto")) snprintf(iface, sizeof iface, "%s", access("/sys/class/net/vlan73", F_OK) == 0 ? "vlan73" : "lo");
    int area[4];
    touch_defaults(area);
    return touch_init(iface, strcmp(iface, "lo") ? cfg.touch_saddr : "", area) == 0;
}

/* ---------------- the community socket and display-bridge's (share.c) ---------------- */
/* display-bridge's socket yields to nothing: display-bridge's own units stand down while mgu-render is installed
 * (systemd/display-bridge-standdown.conf), and a socket it still listens on is never taken */
static struct share shares[2];
static int share_state[2];

static void share_setup(void) {
    _Static_assert(CFG_MAX_SHARED_YIELD <= SHARE_MAX_YIELD, "shared_yield does not fit struct share");
    shares[0].own = shares[1].own = cfg.socket_path;
    shares[0].shared = cfg.shared_path;
    shares[0].n_yield = cfg.n_shared_yield;
    for (int i = 0; i < cfg.n_shared_yield; i++) shares[0].yield[i] = cfg.shared_yield[i];
    shares[1].shared = cfg.bridge_path;
}

static void share_tick(void) {
    for (int i = 0; i < 2; i++) {
        if (!shares[i].shared[0]) continue;
        int r = share_update(&shares[i]);
        if (r != share_state[i] && r != SHARE_HELD) log_info("%s: %s", shares[i].shared, share_name(r));
        share_state[i] = r == SHARE_TAKEN ? SHARE_HELD : r == SHARE_DROPPED ? SHARE_NONE : r;
    }
}

/* ---------------- main ---------------- */
static volatile sig_atomic_t quit;
static void on_sig(int s) { (void)s; quit = 1; }

static void usage(const char *a0) {
    fprintf(stderr, "usage: %s [-c FILE] [-s key=value]... [-v] [--share | --unshare] | --replay FILE --out FILE.pam [--raw FILE.rgba] [--uid N]\n", a0);
}

int main(int argc, char **argv) {
    const char *rin = NULL, *rout = "out.pam", *rraw = NULL;
    uint32_t ruid = (uint32_t)getuid();
    int share_only = 0;
    cfg_defaults(&cfg);
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-c") && i + 1 < argc) { if (cfg_load(&cfg, argv[++i])) return 2; }
        else if (!strcmp(argv[i], "-s") && i + 1 < argc) { if (cfg_set_pair(&cfg, argv[++i])) return 2; }
        else if (!strcmp(argv[i], "--replay") && i + 1 < argc) rin = argv[++i];
        else if (!strcmp(argv[i], "--out") && i + 1 < argc) rout = argv[++i];
        else if (!strcmp(argv[i], "--raw") && i + 1 < argc) rraw = argv[++i];
        else if (!strcmp(argv[i], "--uid") && i + 1 < argc) ruid = (uint32_t)strtoul(argv[++i], NULL, 10);
        else if (!strcmp(argv[i], "-v")) cfg.verbose = 1;
        else if (!strcmp(argv[i], "--share")) share_only = 1;
        else if (!strcmp(argv[i], "--unshare")) share_only = 2;
        else { usage(argv[0]); return 2; }
    }
    log_verbose = cfg.verbose;
    t_start = now_us();
    if (rin) return replay(rin, rout, rraw, ruid);
    share_setup();
    if (share_only) {
        for (int i = 0; i < 2; i++) {
            if (!shares[i].shared[0]) continue;
            int r = share_only == 1 ? share_update(&shares[i]) : share_drop(&shares[i]);
            log_info("%s: %s", shares[i].shared, share_name(r));
        }
        return 0;
    }

    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, on_sig); signal(SIGINT, on_sig);
    if (!getenv("XDG_RUNTIME_DIR")) setenv("XDG_RUNTIME_DIR", "/run/wayland", 1);
    dpy = wl_display_connect(cfg.wayland_display);
    if (!dpy) { log_error("cannot connect to the compositor %s (%s)", cfg.wayland_display, strerror(errno)); return 1; }
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &reg_listener, NULL);
    wl_display_roundtrip(dpy); wl_display_roundtrip(dpy);
    if (!comp || !iapp || !ictl) { log_error("compositor lacks wl_compositor / ivi_application / ivi_controller"); return 1; }
    log_info("compositor: %d screens, centre output %dx%d", nscreens, screen_w, screen_h);
    /* forks the guard: before the GL driver loads */
    if (cfg.touch) touch_on = touch_start();
    if (egl_setup((EGLNativeDisplayType)dpy, 0) < 0) return 1;
    /* a context needs a surface to be made current on some drivers: a tiny one for resources and embed mode */
    struct wl_surface *ts = wl_compositor_create_surface(comp);
    struct wl_egl_window *tw = wl_egl_window_create(ts, 1, 1);
    init_es = eglCreateWindowSurface(edpy, ecfg, (EGLNativeWindowType)tw, NULL);
    eglMakeCurrent(edpy, init_es, init_es, ectx);
    if (gfx_init() < 0) { log_error("gfx_init: %s", gfx_error()); return 1; }
    embed_gl_init(edpy, init_es, ectx, cfg.readback_pbo, cfg.embed_finish);
    log_info("GL: %s / %s", (const char *)glGetString(GL_RENDERER), (const char *)glGetString(GL_VERSION));

    if (cfg.foreground_gate[0] && gate_start(cfg.foreground_gate) < 0) return 1;
    if ((listen_fd = open_listener()) < 0) return 1;
    t_listen = now_us();
    if (cfg.embed) embed_connect(cfg.hmi_display, cfg.embed_surface_id, cfg.embed_area[2], cfg.embed_area[3], cfg.embed_zero_copy);
    share_tick();

    uint64_t gate_retry = 0, embed_retry = 0, share_next = 0;
    while (!quit) {
        uint64_t tnow = now_us();
        int video_on = 0;
        for (int i = 0; i < MAX_CLIENTS; i++) {
            client *c = clients[i];
            if (!c) continue;
            /* apps send a frame at least every second while shown; 3 s of silence = hung */
            if (shown(c) && !c->stale && c->last_msg && tnow - c->last_msg > WATCHDOG_US) {
                c->stale = 1; log_warn("%s: no frames for 3 s - hidden", c->app); update_all();
            }
            /* a shown app with a video: its newest frame draws the app's last frame again (no message from the app) */
            if (c->g.videos && shown(c) && c->frame_words) {
                video_on = 1;
                if (!c->dirty && gfx_video_pending(&c->g)) c->dirty = 1;
            }
            if (c->mode == MODE_LAYER) render_layer(c);
        }
        render_embed();
        ctl_gate_update(tnow);
        if (touch_on) touch_tick(any_claim());
        trace_check(now_us());
        if (tnow >= share_next) { share_next = tnow + SHARE_US; share_tick(); }
        if (cfg.foreground_gate[0] && !gate_unavailable() && gate_fd() < 0 && tnow > gate_retry) {
            gate_retry = tnow + 5000000;
            gate_start(cfg.foreground_gate);
        }
        if (cfg.embed && tnow > embed_retry) {               /* (no-op while connected or connecting) */
            embed_retry = tnow + 5000000;
            embed_connect(cfg.hmi_display, cfg.embed_surface_id, cfg.embed_area[2], cfg.embed_area[3], cfg.embed_zero_copy);
        }
        while (wl_display_prepare_read(dpy) != 0) wl_display_dispatch_pending(dpy);
        wl_display_flush(dpy);
        struct pollfd pf[6 + MAX_CLIENTS];
        int np = 0, map[6 + MAX_CLIENTS];
        pf[np].fd = wl_display_get_fd(dpy); pf[np].events = POLLIN; map[np++] = -1;
        /* until embed has settled (at most its setup time), apps wait: READY must say whether it is offered */
        pf[np].fd = embed_settling(tnow) ? -1 : listen_fd; pf[np].events = POLLIN; map[np++] = -2;
        pf[np].fd = touch_on ? touch_fd() : -1; pf[np].events = POLLIN; map[np++] = -3;   /* fd -1: poll skips it */
        pf[np].fd = gate_fd(); pf[np].events = POLLIN; map[np++] = -4;
        pf[np].fd = ccu_fd; pf[np].events = POLLIN; map[np++] = -5;
        embed_prepare(&pf[np]); map[np++] = -6;
        for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i]) {
            pf[np].fd = clients[i]->fd;
            pf[np].events = POLLIN | (clients[i]->outlen ? POLLOUT : 0);
            map[np++] = i;
        }
        /* controller held: keep its file fresh; a video's next frame: look every 5 ms.
           ponytail: polling the frame file's header, an eventfd from the player if it ever costs */
        int wait_ms = video_on ? 5 : ctl_gate_on ? 100 : 250;
        for (int i = 0; i < MAX_CLIENTS; i++) if (clients[i]) {   /* in time for a capped app's waiting frame */
            uint64_t us = cap_wait(clients[i], tnow);
            if (us && (int)(us / 1000) + 1 < wait_ms) wait_ms = (int)(us / 1000) + 1;
        }
        int r = poll(pf, np, wait_ms);
        if (r < 0 && errno != EINTR) { wl_display_cancel_read(dpy); break; }
        if (pf[0].revents & POLLIN) wl_display_read_events(dpy); else wl_display_cancel_read(dpy);
        if (pf[0].revents & (POLLERR | POLLHUP)) { log_error("compositor connection lost"); break; }
        wl_display_dispatch_pending(dpy);
        if (pf[1].revents & POLLIN) accept_client();
        if (pf[2].revents & POLLIN) touch_read();
        if (pf[3].revents & (POLLIN | POLLHUP)) {
            if (gate_read() != 0) update_all();
            if (gate_unavailable() && !gate_dropped) drop_gated();
        }
        if (pf[4].revents & POLLIN) ccu_read();
        embed_dispatch(&pf[5]);
        for (int k = 6; k < np; k++) {
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
    if (ctl_gate_on) unlink(cfg.controller_gate);
    gate_stop();
    embed_disconnect();
    if (own_socket) {                                    /* run by hand: its socket and the link to it go */
        for (int i = 0; i < 2; i++) if (shares[i].shared[0]) share_drop(&shares[i]);
        unlink(cfg.socket_path);
    }
    log_info("exit");
    return 0;
}
