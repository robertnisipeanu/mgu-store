/* mgu-render settings: built-in defaults, a key = value file (mgu-render.conf), -s key=value overrides. */
#ifndef MGU_CONFIG_H
#define MGU_CONFIG_H
#include <stdint.h>

#define CFG_MAX_YIELD 16
#define CFG_MAX_SHARED_YIELD 8
#define CFG_MAX_APP_FPS 8

struct cfg {
    char socket_path[108];      /* our own socket (the socket unit's; bound here when not socket-activated) */
    char socket_group[32];      /* group of a socket the daemon creates; empty: mode 0666 */
    char shared_path[108];      /* the community renderers' socket, a link to ours while ours to serve; empty: none */
    char shared_yield[CFG_MAX_SHARED_YIELD][128]; /* other renderers' unit files: one present = the path is its */
    int n_shared_yield;
    char bridge_path[108];      /* display-bridge's socket, a link to ours (its apps speak dbr.h); empty: not served */
    char wayland_display[64];   /* the system compositor (Winston), in XDG_RUNTIME_DIR */
    uint32_t screen_id;         /* layer mode's screen; 0: the lowest id (the centre display) */
    int app_area[4];            /* layer mode: the app content area apps are told (X_READY); w 0: by screen size */
    int embed;                  /* embed mode offered */
    char hmi_display[64];       /* the HMI's embedded compositor */
    uint32_t embed_surface_id;  /* the ivi id the page template samples */
    int embed_area[4];          /* the template's box on the screen */
    int embed_zero_copy;        /* draw embed frames into the compositor's GPU buffers when it takes dmabufs */
    int tick_early;             /* embed: TICK once the app's frame is drawn, not when the compositor shows it */
    int readback_pbo;           /* embed readback through a pixel buffer (GLES 3) */
    int embed_finish;           /* embed zero-copy: a frame waits for the GPU (glFinish) before it is committed */
    char embed_marker[128];     /* written by mgu-render-hmi.sh once the template is mounted */
    char hmi_process[32];       /* the HMI's process name: the template is loaded if it started after the marker */
    char foreground_gate[256];  /* command reporting "foreground [uid ...]" on fd 3; empty: none */
    int gate_legacy;            /* upstream / iterio apps (layer) hidden while another app is in front */
    uint32_t yield_surfaces[CFG_MAX_YIELD]; /* layer mode hides while one of these is visible */
    int n_yield;
    int touch;                  /* touch routing */
    char touch_iface[32];       /* "auto": vlan73 when it exists, else lo */
    char touch_saddr[32];       /* the display's address (not for lo) */
    int touch_area[4];          /* where apps may claim; w 0: by screen size */
    char overlay_apps[256];     /* root clients with one of these app ids are overlays (always shown, first for touch) */
    char controller_gate[128];  /* the HMI controller gate's file (upstream inputgate) */
    char controller_lib[64];    /* its library name, looked for in the HMI's maps */
    char record_dir[128];       /* debug: each connection's incoming bytes to <dir>/<app>-<pid>-<n>.bin */
    int verbose;
    int fps;                    /* frames a second for every app that asks for a rate (FPS), in its place; 0: its own */
    struct { char app[64]; int fps; } app_fps[CFG_MAX_APP_FPS];   /* fps.<app>: the same for one app */
    int n_app_fps;
};

void cfg_defaults(struct cfg *c);
int cfg_set(struct cfg *c, const char *key, const char *value);   /* 0, or -1 (logged) */
int cfg_load(struct cfg *c, const char *path);
int cfg_set_pair(struct cfg *c, const char *pair);
int cfg_fps(const struct cfg *c, const char *app);   /* app's fps setting, else the global one */

#endif
