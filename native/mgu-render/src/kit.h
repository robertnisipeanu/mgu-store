/*
 * idrive7-apps kit apps on our socket while the community socket has its own renderer again (kit.c).
 *
 * A kit app (its folder has source/javascript/kit/app-spec.json) connects to the community socket first and to ours
 * when nothing answers there, and stays with whichever it reached. When the renderer there (idrive7-renderd) restarts
 * - every update of it does - its running kit apps come to us and stay. Once the same listener has been at the
 * community socket for KIT_STEADY_US, their connection to us is closed; the kit connects again by itself, to the
 * community socket unless an earlier failed try there turned it to ours. An app that comes back to us within
 * KIT_BACK_US is a strike: after one it is sent back again only after KIT_HOLD1_US, after two only after KIT_HOLD2_US,
 * after three not at all while it stays connected.
 */
#ifndef MGU_KIT_H
#define MGU_KIT_H

#include <stdint.h>

#define KIT_STEADY_US 5000000ull
#define KIT_BACK_US 60000000ull
#define KIT_HOLD1_US 30000000ull
#define KIT_HOLD2_US 120000000ull
#define KIT_STRIKES 3
#define KIT_MAX_APPS 16

struct kit {
    unsigned long ino;      /* the listener last seen at the community socket, 0 none */
    uint64_t since;         /* when it was first seen */
    struct { uint32_t uid; uint64_t sent; int strikes; } app[KIT_MAX_APPS];
};

/* A kit app: oap_dir/oap_<uid>/source/javascript/kit/app-spec.json is there. */
int kit_app(const char *oap_dir, uint32_t uid);
/* What is listening at the community socket now (share_listener()). */
void kit_listener(struct kit *k, unsigned long ino, uint64_t now);
/* The same listener for KIT_STEADY_US. */
int kit_steady(const struct kit *k, uint64_t now);
/* A kit app of this uid connected to us; returns its strikes. */
int kit_connected(struct kit *k, uint32_t uid, uint64_t now);
/* It may be sent back now (its strikes' hold is over). */
int kit_may_send(const struct kit *k, uint32_t uid, uint64_t now);
void kit_sent(struct kit *k, uint32_t uid, uint64_t now);

#endif
