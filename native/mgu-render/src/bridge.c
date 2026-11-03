/* When the embed bridge shows (bridge.h). */
#include "bridge.h"

#include <stddef.h>

const char *bridge_unsafe(const struct bridge_app *a)
{
    if (!a->in_front) return "the app is not in front";
    if (a->camera) return "a camera or video surface is visible";
    if (!a->in_box) return "the app is not in the HMI's box";
    if (!a->shown) return "the app is not shown";
    return NULL;
}

int bridge_start(struct bridge *b, uint64_t now, uint64_t hold_us, const char *unsafe)
{
    if (unsafe || !hold_us)
        return -1;
    if (b->on) {
        uint64_t last = b->since + 2 * hold_us;
        b->until = now + hold_us < last ? now + hold_us : last;
        return 0;
    }
    b->on = 1;
    b->since = now;
    b->until = now + hold_us;
    return 1;
}

int bridge_stop(struct bridge *b)
{
    int was = b->on;
    b->on = 0;
    return was;
}

const char *bridge_check(struct bridge *b, uint64_t now, const char *unsafe)
{
    if (!b->on)
        return NULL;
    const char *why = unsafe ? unsafe : now >= b->until ? "its time is up" : NULL;
    if (why)
        b->on = 0;
    return why;
}

uint64_t bridge_left(const struct bridge *b, uint64_t now)
{
    return b->on && b->until > now ? b->until - now : 0;
}
