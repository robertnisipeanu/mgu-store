/*
 * The community renderers' socket (share.h).
 *
 * Ownership: the path is ours exactly when it is a symlink whose target is our own socket; anything else there
 * (another renderer's socket, a file) is not, and is never removed - except a socket nobody listens on while no
 * other renderer is installed, which only a renderer gone for good leaves (mgu-render before 0.2.0 listened there
 * itself, and its socket file outlives its socket unit's restart). The other renderers bind the path
 * themselves at their start (unlink, then bind), so one that starts takes it from us with no help; we make
 * the link only where nothing is (symlink() fails on anything present), and only while none of the other
 * renderers' unit files is installed, so we never take the path back from one that is installed but stopped
 * or restarting.
 *
 * Dropping our link races with another renderer's start: between our check and an unlink, its fresh socket
 * could be what we remove. So the link is moved aside first (rename), checked there, and removed; when what
 * moved turns out to be another renderer's socket, it goes back with link(), which fails rather than replace
 * anything that took the path meanwhile.
 */
#define _GNU_SOURCE
#include "share.h"

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "log.h"

#ifndef SHARE_RACE_POINT
#define SHARE_RACE_POINT()                /* test/test_share.c: another renderer binds here */
#endif

int share_is_ours(const struct share *s, const char *path)
{
    struct stat st;
    char t[PATH_MAX];
    if (lstat(path, &st) < 0 || !S_ISLNK(st.st_mode)) return 0;
    ssize_t n = readlink(path, t, sizeof t - 1);
    if (n < 0) return 0;
    t[n] = 0;
    return !strcmp(t, s->own);
}

static int present(const char *p)
{
    struct stat st;
    return lstat(p, &st) == 0;
}

/* A socket file nobody listens on. Read from the kernel's table of unix sockets, not by connecting: a socket unit
 * that still listens there (display-bridge's, before the head-unit start that stands it down) would start its
 * service for a connection. */
static int dead_socket(const char *p)
{
    struct stat st;
    if (lstat(p, &st) < 0 || !S_ISSOCK(st.st_mode)) return 0;
    FILE *f = fopen("/proc/net/unix", "r");
    if (!f) return 0;                                    /* unknown: left alone */
    char line[PATH_MAX + 128];
    int listening = 0;
    while (!listening && fgets(line, sizeof line, f)) {
        unsigned flags;
        int at = 0;
        if (sscanf(line, "%*s %*x %*x %x %*x %*x %*u %n", &flags, &at) < 1 || !at) continue;
        line[strcspn(line, "\n")] = 0;
        listening = (flags & 0x10000) && !strcmp(line + at, p);   /* __SO_ACCEPTCON */
    }
    fclose(f);
    return !listening;
}

int share_drop(const struct share *s)
{
    if (!share_is_ours(s, s->shared)) return present(s->shared) ? SHARE_OTHER : SHARE_NONE;
    SHARE_RACE_POINT();
    char aside[PATH_MAX];
    snprintf(aside, sizeof aside, "%s.aside-%d", s->shared, (int)getpid());
    if (rename(s->shared, aside) < 0) return present(s->shared) ? SHARE_OTHER : SHARE_NONE;
    if (share_is_ours(s, aside)) {
        unlink(aside);
        return SHARE_DROPPED;
    }
    /* another renderer bound the path between the check and the move: its socket goes back */
    if (link(aside, s->shared) == 0) unlink(aside);
    else log_warn("%s: another renderer's socket was moved to %s and could not go back (%s)", s->shared, aside, strerror(errno));
    return SHARE_OTHER;
}

int share_update(const struct share *s)
{
    for (int i = 0; i < s->n_yield; i++)
        if (present(s->yield[i])) return share_drop(s);
    if (share_is_ours(s, s->shared)) return SHARE_HELD;
    if (!present(s->own)) return present(s->shared) ? SHARE_OTHER : SHARE_NONE;   /* nothing to link to yet */
    if (present(s->shared)) {
        if (!dead_socket(s->shared)) return SHARE_OTHER;
        unlink(s->shared);
    }
    char dir[PATH_MAX];
    snprintf(dir, sizeof dir, "%s", s->shared);
    char *sl = strrchr(dir, '/');
    if (sl && sl != dir) { *sl = 0; mkdir(dir, 0755); }
    if (symlink(s->own, s->shared) == 0) return SHARE_TAKEN;
    return errno == EEXIST ? SHARE_OTHER : SHARE_NONE;
}

const char *share_name(int r)
{
    switch (r) {
    case SHARE_TAKEN: return "linked to ours";
    case SHARE_HELD: return "ours";
    case SHARE_DROPPED: return "our link removed";
    case SHARE_OTHER: return "another renderer's";
    default: return "free";
    }
}
