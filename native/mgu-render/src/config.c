#include "config.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "log.h"

void cfg_defaults(struct cfg *c)
{
    memset(c, 0, sizeof *c);
    snprintf(c->socket_path, sizeof c->socket_path, "/run/mgu-renderd/renderd.sock");
    snprintf(c->wayland_display, sizeof c->wayland_display, "wayland-0");
    c->embed = 1;
    snprintf(c->hmi_display, sizeof c->hmi_display, "wayland-1");
    c->embed_surface_id = 0x500;
    c->embed_area[0] = 104; c->embed_area[1] = 88; c->embed_area[2] = 1796; c->embed_area[3] = 632;
    snprintf(c->embed_marker, sizeof c->embed_marker, "/run/mgu-render/hmi-template");
    snprintf(c->hmi_process, sizeof c->hmi_process, "HmiMain3D");
    c->gate_legacy = 1;
    const uint32_t y[] = { 0x197, 0x198, 0x19d, 0x19f };
    memcpy(c->yield_surfaces, y, sizeof y);
    c->n_yield = 4;
    c->touch = 1;
    snprintf(c->touch_iface, sizeof c->touch_iface, "auto");
    snprintf(c->touch_saddr, sizeof c->touch_saddr, "160.48.199.115");
    c->touch_finger_tag = 8;
    snprintf(c->controller_gate, sizeof c->controller_gate, "/run/mgu-renderd/inputgate");
    snprintf(c->controller_lib, sizeof c->controller_lib, "mgu-inputgate");
}

static int str(char *dst, size_t n, const char *v, const char *key)
{
    if (strlen(v) >= n) {
        log_error("%s: value too long", key);
        return -1;
    }
    snprintf(dst, n, "%s", v);
    return 0;
}

static int num(const char *v, long *out)
{
    char *e;
    long x = strtol(v, &e, 0);
    if (e == v || *e)
        return -1;
    *out = x;
    return 0;
}

static int rect(int r[4], const char *v)
{
    int a[4];
    if (sscanf(v, "%d , %d , %d , %d", &a[0], &a[1], &a[2], &a[3]) != 4 || a[2] < 0 || a[3] < 0)
        return -1;
    memcpy(r, a, sizeof a);
    return 0;
}

#define STR(k, f) if (!strcmp(key, k)) return str(c->f, sizeof c->f, value, key)

int cfg_set(struct cfg *c, const char *key, const char *value)
{
    long n;
    STR("socket_path", socket_path);
    STR("socket_group", socket_group);
    STR("wayland_display", wayland_display);
    STR("hmi_display", hmi_display);
    STR("embed_marker", embed_marker);
    STR("hmi_process", hmi_process);
    STR("foreground_gate", foreground_gate);
    STR("touch_iface", touch_iface);
    STR("touch_saddr", touch_saddr);
    STR("controller_gate", controller_gate);
    STR("controller_lib", controller_lib);
    STR("record_dir", record_dir);
    if (!strcmp(key, "embed_area")) {
        if (rect(c->embed_area, value) == 0 && c->embed_area[2] > 0 && c->embed_area[3] > 0)
            return 0;
        log_error("%s: x,y,w,h with a size expected", key);
        return -1;
    }
    if (!strcmp(key, "app_area") || !strcmp(key, "touch_area")) {
        int *r = key[0] == 'a' ? c->app_area : c->touch_area;
        if (!strcmp(value, "auto")) {
            memset(r, 0, 4 * sizeof *r);
            return 0;
        }
        if (rect(r, value) == 0)
            return 0;
        log_error("%s: x,y,w,h or auto expected", key);
        return -1;
    }
    if (!strcmp(key, "yield_surfaces")) {
        c->n_yield = 0;
        for (const char *p = value; *p && c->n_yield < CFG_MAX_YIELD;) {
            char *e;
            unsigned long id = strtoul(p, &e, 0);
            if (e == p)
                break;
            c->yield_surfaces[c->n_yield++] = (uint32_t)id;
            p = e;
            while (*p == ',' || isspace((unsigned char)*p))
                p++;
        }
        return 0;
    }
    if (num(value, &n)) {
        log_error("%s: '%s' is not a number", key, value);
        return -1;
    }
    if (!strcmp(key, "screen_id")) c->screen_id = (uint32_t)n;
    else if (!strcmp(key, "embed")) c->embed = n != 0;
    else if (!strcmp(key, "embed_surface_id")) c->embed_surface_id = (uint32_t)n;
    else if (!strcmp(key, "gate_legacy")) c->gate_legacy = n != 0;
    else if (!strcmp(key, "touch")) c->touch = n != 0;
    else if (!strcmp(key, "touch_finger_tag")) c->touch_finger_tag = (int)n;
    else if (!strcmp(key, "verbose")) c->verbose = n != 0;
    else {
        log_error("unknown setting '%s'", key);
        return -1;
    }
    return 0;
}

int cfg_set_pair(struct cfg *c, const char *pair)
{
    char buf[512];
    snprintf(buf, sizeof buf, "%s", pair);
    char *eq = strchr(buf, '=');
    if (!eq) {
        log_error("'%s': key=value expected", pair);
        return -1;
    }
    *eq = 0;
    char *k = buf, *v = eq + 1;
    while (isspace((unsigned char)*k)) k++;
    char *e = k + strlen(k);
    while (e > k && isspace((unsigned char)e[-1])) *--e = 0;
    while (isspace((unsigned char)*v)) v++;
    e = v + strlen(v);
    while (e > v && isspace((unsigned char)e[-1])) *--e = 0;
    return cfg_set(c, k, v);
}

int cfg_load(struct cfg *c, const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) {
        log_error("%s: cannot open", path);
        return -1;
    }
    char line[512];
    int rc = 0, ln = 0;
    while (fgets(line, sizeof line, f)) {
        ln++;
        char *p = line;
        while (isspace((unsigned char)*p)) p++;
        if (!*p || *p == '#')
            continue;
        p[strcspn(p, "\r\n")] = 0;
        if (cfg_set_pair(c, p)) {
            log_error("%s:%d: bad line", path, ln);
            rc = -1;
        }
    }
    fclose(f);
    return rc;
}
