/*
 * The community renderers' socket (share.c): /run/mgu-renderd/renderd.sock, which upstream idrive7-apps' and
 * IterioDev's renderers bind and their apps connect to. mgu-render serves it with a symlink to its own socket
 * while no other renderer is installed, and leaves it to the other renderer otherwise.
 */
#ifndef MGU_SHARE_H
#define MGU_SHARE_H

#define SHARE_MAX_YIELD 8

struct share {
    const char *own;                         /* mgu-render's socket, the link's target */
    const char *shared;                      /* the community path */
    const char *yield[SHARE_MAX_YIELD];      /* unit files of other renderers: any present = one is installed */
    int n_yield;
};

enum { SHARE_TAKEN = 1, SHARE_HELD, SHARE_DROPPED, SHARE_OTHER, SHARE_NONE };

/* One pass of the rule: another renderer installed -> our link goes (if it is there); else, the path free or a
 * socket nobody listens on (share.c) -> our link is made. Never removes anything else. Returns what the path is
 * now: SHARE_TAKEN (linked now), SHARE_HELD (ours already), SHARE_DROPPED (our link removed now), SHARE_OTHER (another renderer's, or
 * anything not ours), SHARE_NONE (nothing there). */
int share_update(const struct share *s);
/* Removes our link, if it is there (the socket unit stopping). */
int share_drop(const struct share *s);
int share_is_ours(const struct share *s, const char *path);
const char *share_name(int r);

#endif
