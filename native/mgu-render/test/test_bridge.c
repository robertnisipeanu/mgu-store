/* The embed bridge's decisions (src/bridge.c), driven as main.c drives them: X_BRIDGE 1 and 0 from the app, the
 * app's state as the foreground gate, the HMI's box, SHOW and the camera surfaces leave it, and the clock. A stand-in
 * layer records each show and hide, so every case checks what the screen would get: shown at the page change, gone at
 * its time, at once on a popup (the app's X_BRIDGE 0), when another app comes in front, on a camera, when the app
 * leaves the box or is hidden, and never shown while any of those holds. */
#include <stdio.h>
#include <string.h>

#include "bridge.h"

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

#define HOLD 400000ull

/* the layer and the app, as main.c sees them */
static struct bridge b;
static struct bridge_app app;
static int shown, shows, hides;
static char why[128];
static uint64_t now;

static void layer(int on, const char *reason)
{
    if (on == shown) return;
    shown = on;
    if (on) shows++;
    else { hides++; snprintf(why, sizeof why, "%s", reason ? reason : ""); }
}

/* X_BRIDGE 1 */
static int ask(void)
{
    int r = bridge_start(&b, now, HOLD, bridge_unsafe(&app));
    if (r >= 0) layer(1, NULL);
    return r;
}

/* X_BRIDGE 0 */
static void ask_off(void)
{
    if (bridge_stop(&b)) layer(0, "the app asked");
}

/* the main loop's pass at time t */
static void tick(uint64_t t)
{
    now = t;
    const char *w = bridge_check(&b, now, bridge_unsafe(&app));
    if (w) layer(0, w);
}

static void reset(void)
{
    memset(&b, 0, sizeof b);
    app = (struct bridge_app){ .in_box = 1, .shown = 1, .in_front = 1, .camera = 0 };
    shown = shows = hides = 0;
    why[0] = 0;
    now = 1000000;
}

int main(void)
{
    /* a page change: shown at once, for HOLD, then gone */
    reset();
    CHECK(ask() == 1, "start shows it");
    CHECK(shown && shows == 1, "the layer shows at the page change");
    tick(now + 100000);
    CHECK(shown, "still there 100 ms in");
    CHECK(bridge_left(&b, now) == HOLD - 100000, "300 ms left: %llu", (unsigned long long)bridge_left(&b, now));
    tick(1000000 + HOLD - 1);
    CHECK(shown, "still there 1 us before its time");
    tick(1000000 + HOLD);
    CHECK(!shown && !strcmp(why, "its time is up"), "gone at its time (%s)", why);
    CHECK(bridge_left(&b, now) == 0, "nothing left once gone");

    /* a second change while it shows (setTab closing two pages) holds it from the newest */
    reset();
    ask();
    tick(now + 300000);
    CHECK(ask() == 0 && shows == 1, "a second X_BRIDGE 1 holds it, no second show");
    tick(1000000 + HOLD + 100000);
    CHECK(shown, "held past the first one's time");
    tick(1000000 + 300000 + HOLD);
    CHECK(!shown && hides == 1, "gone at the second one's time");

    /* an HMI popup takes the page's focus: the app's X_BRIDGE 0 hides it at once */
    reset();
    ask();
    tick(now + 50000);
    ask_off();
    CHECK(!shown && !b.on && !strcmp(why, "the app asked"), "popup: gone at once (%s)", why);
    tick(now + 10000);
    CHECK(shows == 1 && hides == 1, "and stays gone");
    ask_off();
    CHECK(hides == 1, "a second X_BRIDGE 0 hides nothing");

    /* an app asking again and again is held at most twice the hold from when it showed */
    reset();
    ask();
    uint64_t gone = 0;
    for (int k = 1; k <= 20 && !gone; k++) { tick(1000000 + k * 50000); if (shown) ask(); else gone = now; }
    CHECK(gone == 1000000 + 2 * HOLD, "repeated X_BRIDGE 1: gone at twice the hold (at +%llu us)",
          (unsigned long long)(gone - 1000000));

    /* another app comes in front (MENU, HOME, a phone call): gone at the next pass */
    reset();
    ask();
    tick(now + 20000);
    app.in_front = 0;
    tick(now + 1);
    CHECK(!shown && !strcmp(why, "the app is not in front"), "front lost: gone (%s)", why);
    app.in_front = 1;
    tick(now + 1000);
    CHECK(!shown, "the app in front again shows nothing by itself");

    /* the reversing camera */
    reset();
    ask();
    app.camera = 1;
    tick(now + 1);
    CHECK(!shown && !strcmp(why, "a camera or video surface is visible"), "camera: gone (%s)", why);

    /* the app leaves the HMI's box (another embed app holds it, or the HMI's compositor went) */
    reset();
    ask();
    app.in_box = 0;
    tick(now + 1);
    CHECK(!shown && !strcmp(why, "the app is not in the HMI's box"), "box lost: gone (%s)", why);

    /* the app hides itself (SHOW 0: the HMI's speller), goes silent or has no frame */
    reset();
    ask();
    app.shown = 0;
    tick(now + 1);
    CHECK(!shown && !strcmp(why, "the app is not shown"), "hidden: gone (%s)", why);

    /* never shown while unsafe */
    const char *field[] = { "in_front", "camera", "in_box", "shown" };
    for (int k = 0; k < 4; k++) {
        reset();
        if (k == 0) app.in_front = 0;
        if (k == 1) app.camera = 1;
        if (k == 2) app.in_box = 0;
        if (k == 3) app.shown = 0;
        CHECK(ask() == -1 && !shown && !b.on, "refused with %s unsafe", field[k]);
        tick(now + HOLD + 1);
        CHECK(shows == 0 && hides == 0, "nothing shown or hidden later (%s)", field[k]);
    }

    /* embed_bridge_ms = 0: never shown */
    reset();
    CHECK(bridge_start(&b, now, 0, NULL) == -1 && !b.on, "a hold of 0 refuses");

    /* a pass while off changes nothing */
    reset();
    CHECK(bridge_check(&b, now, "the app is not in front") == NULL, "off: no reason to hide");

    printf("bridge: %d checks, %d failed\n", checks, fails);
    return fails != 0;
}
