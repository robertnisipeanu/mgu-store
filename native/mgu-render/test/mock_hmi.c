/*
 * A stand-in for the HMI's embedded compositor (wayland-1), for test/test_embed.c: wl_compositor, wl_shm,
 * ivi_application and, with --drm, wl_drm v2 (PRIME, XRGB8888) as Mesa's offers it.
 *   mock_hmi SOCKET [--drm] [--no-prime] [--refuse]
 * Prints one line per commit: "commit shm|drm W H CRC" (CRC-32 of each pixel's B G R bytes, rows top-down), and
 * "VIOLATION <what>" when a client attaches a buffer the compositor still holds or wraps a dmabuf that does not fit
 * its size. A buffer is held from its commit until the next commit (then released). --refuse answers
 * create_prime_buffer with wl_drm's invalid_name error, as Mesa does for a dmabuf it cannot import, once.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <wayland-server.h>

#include "ivi-application-server-protocol.h"
#include "wayland-drm-server-protocol.h"

static int opt_drm, opt_prime = 1, opt_refuse;

struct dbuf { struct wl_resource *res; int fd; int w, h; uint32_t stride, format; int held; };
/* current_gone: the shown buffer destroyed (a client that goes away destroys its buffers before its surface) */
struct surf { struct wl_resource *res, *pending, *current; struct wl_list frames; struct wl_listener current_gone; int watching; };

static uint32_t crc_table[256];
static uint32_t crc32_rgb(const uint8_t *p, int w, int h, uint32_t stride)
{
    uint32_t c = 0xffffffffu;
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
            for (int k = 0; k < 3; k++)
                c = crc_table[(c ^ p[(size_t)y * stride + (size_t)x * 4 + k]) & 0xff] ^ (c >> 8);
    return c ^ 0xffffffffu;
}

static void destroy_res(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }

/* ---- wl_buffer (dmabuf) ---- */
static const struct wl_buffer_interface dbuf_impl = { destroy_res };
static void dbuf_free(struct wl_resource *r)
{
    struct dbuf *b = wl_resource_get_user_data(r);
    close(b->fd);
    free(b);
}
static int is_dbuf(struct wl_resource *r) { return wl_resource_instance_of(r, &wl_buffer_interface, &dbuf_impl); }

/* held flags of shm buffers, by resource */
static struct wl_resource *shm_held[64];
static int held(struct wl_resource *r)
{
    if (is_dbuf(r)) return ((struct dbuf *)wl_resource_get_user_data(r))->held;
    for (int i = 0; i < 64; i++) if (shm_held[i] == r) return 1;
    return 0;
}
static void set_held(struct wl_resource *r, int on)
{
    if (is_dbuf(r)) { ((struct dbuf *)wl_resource_get_user_data(r))->held = on; return; }
    for (int i = 0; i < 64; i++) {
        if (on && !shm_held[i]) { shm_held[i] = r; return; }
        if (!on && shm_held[i] == r) { shm_held[i] = NULL; return; }
    }
}

/* ---- wl_surface ---- */
static void current_gone(struct wl_listener *l, void *data)
{
    (void)data;
    struct surf *s = wl_container_of(l, s, current_gone);
    set_held(s->current, 0);
    s->current = NULL;
    s->watching = 0;
}
static void watch_current(struct surf *s, struct wl_resource *b)
{
    if (s->watching) wl_list_remove(&s->current_gone.link);
    s->current = b;
    s->watching = b != NULL;
    if (b) { s->current_gone.notify = current_gone; wl_resource_add_destroy_listener(b, &s->current_gone); }
}
static void s_attach(struct wl_client *c, struct wl_resource *r, struct wl_resource *buf, int32_t x, int32_t y)
{
    (void)c, (void)x, (void)y;
    struct surf *s = wl_resource_get_user_data(r);
    if (buf && held(buf)) { printf("VIOLATION attach of a held buffer\n"); fflush(stdout); }
    s->pending = buf;
}
static void s_damage(struct wl_client *c, struct wl_resource *r, int32_t x, int32_t y, int32_t w, int32_t h) { (void)c, (void)r, (void)x, (void)y, (void)w, (void)h; }
static void cb_free(struct wl_resource *r) { wl_list_remove(wl_resource_get_link(r)); }
static void s_frame(struct wl_client *c, struct wl_resource *r, uint32_t id)
{
    struct surf *s = wl_resource_get_user_data(r);
    struct wl_resource *cb = wl_resource_create(c, &wl_callback_interface, 1, id);
    wl_resource_set_implementation(cb, NULL, NULL, cb_free);
    wl_list_insert(s->frames.prev, wl_resource_get_link(cb));
}
static void s_region(struct wl_client *c, struct wl_resource *r, struct wl_resource *g) { (void)c, (void)r, (void)g; }
static void s_commit(struct wl_client *c, struct wl_resource *r)
{
    (void)c;
    struct surf *s = wl_resource_get_user_data(r);
    if (s->pending) {
        struct wl_resource *b = s->pending;
        struct wl_shm_buffer *shm = wl_shm_buffer_get(b);
        if (shm) {
            wl_shm_buffer_begin_access(shm);
            printf("commit shm %d %d %08x\n", wl_shm_buffer_get_width(shm), wl_shm_buffer_get_height(shm),
                   crc32_rgb(wl_shm_buffer_get_data(shm), wl_shm_buffer_get_width(shm), wl_shm_buffer_get_height(shm),
                             (uint32_t)wl_shm_buffer_get_stride(shm)));
            wl_shm_buffer_end_access(shm);
        } else if (is_dbuf(b)) {
            struct dbuf *d = wl_resource_get_user_data(b);
            size_t sz = (size_t)d->stride * d->h;
            uint8_t *p = mmap(NULL, sz, PROT_READ, MAP_SHARED, d->fd, 0);
            if (p == MAP_FAILED) printf("VIOLATION dmabuf not mappable: %s\n", strerror(errno));
            else { printf("commit drm %d %d %08x\n", d->w, d->h, crc32_rgb(p, d->w, d->h, d->stride)); munmap(p, sz); }
        }
        fflush(stdout);
        if (s->current && s->current != b) { set_held(s->current, 0); wl_buffer_send_release(s->current); }
        set_held(b, 1);
        watch_current(s, b);
        s->pending = NULL;
    }
    struct wl_resource *cb, *tmp;
    wl_resource_for_each_safe(cb, tmp, &s->frames) {
        wl_callback_send_done(cb, 0);
        wl_resource_destroy(cb);
    }
}
static void s_int(struct wl_client *c, struct wl_resource *r, int32_t v) { (void)c, (void)r, (void)v; }
static const struct wl_surface_interface surf_impl = {
    .destroy = destroy_res, .attach = s_attach, .damage = s_damage, .frame = s_frame,
    .set_opaque_region = s_region, .set_input_region = s_region, .commit = s_commit,
    .set_buffer_transform = s_int, .set_buffer_scale = s_int, .damage_buffer = s_damage,
};
static void surf_free(struct wl_resource *r)
{
    struct surf *s = wl_resource_get_user_data(r);
    struct wl_resource *cb, *tmp;
    wl_resource_for_each_safe(cb, tmp, &s->frames) wl_resource_destroy(cb);
    if (s->current) {
        struct wl_resource *b = s->current;
        watch_current(s, NULL);
        set_held(b, 0);
        wl_buffer_send_release(b);
    }
    free(s);
}

/* ---- wl_region, wl_compositor ---- */
static void rg_add(struct wl_client *c, struct wl_resource *r, int32_t x, int32_t y, int32_t w, int32_t h) { (void)c, (void)r, (void)x, (void)y, (void)w, (void)h; }
static const struct wl_region_interface region_impl = { destroy_res, rg_add, rg_add };
static void c_surface(struct wl_client *c, struct wl_resource *r, uint32_t id)
{
    struct surf *s = calloc(1, sizeof *s);
    wl_list_init(&s->frames);
    s->res = wl_resource_create(c, &wl_surface_interface, wl_resource_get_version(r), id);
    wl_resource_set_implementation(s->res, &surf_impl, s, surf_free);
}
static void c_region(struct wl_client *c, struct wl_resource *r, uint32_t id)
{
    struct wl_resource *g = wl_resource_create(c, &wl_region_interface, 1, id);
    (void)r;
    wl_resource_set_implementation(g, &region_impl, NULL, NULL);
}
static const struct wl_compositor_interface comp_impl = { c_surface, c_region };
static void bind_comp(struct wl_client *c, void *d, uint32_t ver, uint32_t id)
{
    (void)d;
    struct wl_resource *r = wl_resource_create(c, &wl_compositor_interface, (int)ver, id);
    wl_resource_set_implementation(r, &comp_impl, NULL, NULL);
}

/* ---- ivi_application ---- */
static const struct ivi_surface_interface isurf_impl = { destroy_res };
static void ia_create(struct wl_client *c, struct wl_resource *r, uint32_t ivi_id, struct wl_resource *s, uint32_t id)
{
    (void)r, (void)ivi_id, (void)s;
    struct wl_resource *i = wl_resource_create(c, &ivi_surface_interface, 1, id);
    wl_resource_set_implementation(i, &isurf_impl, NULL, NULL);
}
static const struct ivi_application_interface iapp_impl = { ia_create };
static void bind_iapp(struct wl_client *c, void *d, uint32_t ver, uint32_t id)
{
    (void)d, (void)ver;
    struct wl_resource *r = wl_resource_create(c, &ivi_application_interface, 1, id);
    wl_resource_set_implementation(r, &iapp_impl, NULL, NULL);
}

/* ---- wl_drm ---- */
static void d_auth(struct wl_client *c, struct wl_resource *r, uint32_t id) { (void)c, (void)id; wl_drm_send_authenticated(r); }
static void d_create(struct wl_client *c, struct wl_resource *r, uint32_t id, uint32_t name, int32_t w, int32_t h, uint32_t stride, uint32_t format)
{
    (void)c, (void)id, (void)name, (void)w, (void)h, (void)stride, (void)format;
    wl_resource_post_error(r, WL_DRM_ERROR_INVALID_NAME, "flink names not served");
}
static void d_planar(struct wl_client *c, struct wl_resource *r, uint32_t id, uint32_t name, int32_t w, int32_t h, uint32_t format,
                     int32_t o0, int32_t s0, int32_t o1, int32_t s1, int32_t o2, int32_t s2)
{
    (void)c, (void)id, (void)name, (void)w, (void)h, (void)format, (void)o0, (void)s0, (void)o1, (void)s1, (void)o2, (void)s2;
    wl_resource_post_error(r, WL_DRM_ERROR_INVALID_NAME, "flink names not served");
}
static void d_prime(struct wl_client *c, struct wl_resource *r, uint32_t id, int32_t fd, int32_t w, int32_t h, uint32_t format,
                    int32_t o0, int32_t s0, int32_t o1, int32_t s1, int32_t o2, int32_t s2)
{
    (void)o1, (void)s1, (void)o2, (void)s2;
    if (opt_refuse) {
        opt_refuse = 0;
        close(fd);
        wl_resource_post_error(r, WL_DRM_ERROR_INVALID_NAME, "invalid name");
        return;
    }
    struct stat st;
    if (format != WL_DRM_FORMAT_XRGB8888 || o0 != 0 || s0 < w * 4 || fstat(fd, &st) < 0 || (off_t)s0 * h > st.st_size) {
        printf("VIOLATION prime buffer %dx%d format %#x offset %d stride %d\n", w, h, format, o0, s0);
        fflush(stdout);
    }
    struct dbuf *b = calloc(1, sizeof *b);
    b->fd = fd; b->w = w; b->h = h; b->stride = (uint32_t)s0; b->format = format;
    b->res = wl_resource_create(c, &wl_buffer_interface, 1, id);
    wl_resource_set_implementation(b->res, &dbuf_impl, b, dbuf_free);
}
static const struct wl_drm_interface drm_impl = { d_auth, d_create, d_planar, d_prime };
static void bind_drm(struct wl_client *c, void *d, uint32_t ver, uint32_t id)
{
    (void)d;
    struct wl_resource *r = wl_resource_create(c, &wl_drm_interface, (int)ver, id);
    wl_resource_set_implementation(r, &drm_impl, NULL, NULL);
    wl_drm_send_device(r, "/dev/dri/mock");
    wl_drm_send_format(r, WL_DRM_FORMAT_ARGB8888);
    wl_drm_send_format(r, WL_DRM_FORMAT_XRGB8888);
    if (ver >= 2) wl_drm_send_capabilities(r, opt_prime ? WL_DRM_CAPABILITY_PRIME : 0);
}

static int quit;
static void on_term(int s) { (void)s; quit = 1; }

int main(int argc, char **argv)
{
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
        crc_table[i] = c;
    }
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--drm")) opt_drm = 1;
        else if (!strcmp(argv[i], "--no-prime")) opt_prime = 0;
        else if (!strcmp(argv[i], "--refuse")) opt_refuse = 1;
    }
    signal(SIGTERM, on_term);
    struct wl_display *d = wl_display_create();
    if (wl_display_add_socket(d, argv[1]) < 0) { perror("socket"); return 1; }
    wl_display_init_shm(d);
    wl_global_create(d, &wl_compositor_interface, 4, NULL, bind_comp);
    wl_global_create(d, &ivi_application_interface, 1, NULL, bind_iapp);
    if (opt_drm) wl_global_create(d, &wl_drm_interface, 2, NULL, bind_drm);
    printf("listening\n");
    fflush(stdout);
    struct wl_event_loop *loop = wl_display_get_event_loop(d);
    while (!quit) {
        wl_display_flush_clients(d);
        wl_event_loop_dispatch(loop, 100);
    }
    wl_display_destroy(d);
    return 0;
}
