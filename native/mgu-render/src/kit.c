/* idrive7-apps kit apps back to the community socket's renderer (kit.h). */
#include "kit.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int kit_app(const char *oap_dir, uint32_t uid)
{
    char p[PATH_MAX];
    snprintf(p, sizeof p, "%s/oap_%u/source/javascript/kit/app-spec.json", oap_dir, uid);
    return access(p, F_OK) == 0;
}

void kit_listener(struct kit *k, unsigned long ino, uint64_t now)
{
    if (ino != k->ino) { k->ino = ino; k->since = now; }
}

int kit_steady(const struct kit *k, uint64_t now)
{
    return k->ino && now - k->since >= KIT_STEADY_US;
}

static int find(const struct kit *k, uint32_t uid)
{
    for (int i = 0; i < KIT_MAX_APPS; i++) if (k->app[i].sent && k->app[i].uid == uid) return i;
    return -1;
}

int kit_connected(struct kit *k, uint32_t uid, uint64_t now)
{
    int i = find(k, uid);
    if (i < 0) return 0;
    if (now - k->app[i].sent < KIT_BACK_US) return ++k->app[i].strikes;
    memset(&k->app[i], 0, sizeof k->app[i]);                /* away long enough: a fresh start */
    return 0;
}

int kit_may_send(const struct kit *k, uint32_t uid, uint64_t now)
{
    int i = find(k, uid);
    if (i < 0) return 1;
    int s = k->app[i].strikes;
    if (s >= KIT_STRIKES) return 0;
    uint64_t hold = s == 0 ? 0 : s == 1 ? KIT_HOLD1_US : KIT_HOLD2_US;
    return now - k->app[i].sent >= hold;
}

void kit_sent(struct kit *k, uint32_t uid, uint64_t now)
{
    int i = find(k, uid);
    if (i < 0) {                                            /* a free entry, else the oldest */
        i = 0;
        for (int j = 0; j < KIT_MAX_APPS; j++) {
            if (!k->app[j].sent) { i = j; break; }
            if (k->app[j].sent < k->app[i].sent) i = j;
        }
        memset(&k->app[i], 0, sizeof k->app[i]);
        k->app[i].uid = uid;
    }
    k->app[i].sent = now ? now : 1;
}
