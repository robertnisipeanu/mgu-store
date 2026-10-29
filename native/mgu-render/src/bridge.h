/*
 * The embed bridge: when the HMI changes an embed app's page (each page is its own host state), it fades the old one
 * out, shows neither for about 100-200 ms, then fades the new one in, and the app's box is black meanwhile. Nothing
 * the HMI tells the app or the renderer marks when the new page shows again: its host-state events all come as the
 * change starts, and its frame callbacks go on throughout. So the app says when a change starts (X_BRIDGE 1), and
 * its frames are shown on a layer of the renderer's own over the box for a fixed time (embed_bridge_ms), the new
 * page being drawn there at once. The layer goes as soon as anything makes it unsafe: the app's X_BRIDGE 0 (an HMI
 * popup took the page's focus), the app no longer in front or no longer in the box, a camera or video surface, the
 * app hidden, silent or gone. main.c draws and places the layer; this decides when it shows.
 */
#ifndef MGU_BRIDGE_H
#define MGU_BRIDGE_H
#include <stdint.h>

struct bridge {
    int on;
    uint64_t since, until;          /* shown since, until (us) */
};

/* the app as the layer sees it */
struct bridge_app {
    int in_box;                     /* it holds the HMI's box and its surface is there */
    int shown;                      /* it asked to be shown (SHOW), has a frame, and talks (not silent for 3 s) */
    int in_front;                   /* the foreground gate has it in front */
    int camera;                     /* a camera or video surface is visible */
};

/* what makes showing the app's frames over the box unsafe, or NULL */
const char *bridge_unsafe(const struct bridge_app *a);

/* X_BRIDGE 1: shown from now (1), or held until now + hold_us when it shows already (0); refused (-1) when unsafe */
int bridge_start(struct bridge *b, uint64_t now, uint64_t hold_us, const char *unsafe);
/* why it goes now (it is then off), or NULL while it stays: unsafe (what makes it so, NULL: nothing), or its time up */
const char *bridge_check(struct bridge *b, uint64_t now, const char *unsafe);
/* until it goes by itself, us (0 when off) */
uint64_t bridge_left(const struct bridge *b, uint64_t now);

#endif
