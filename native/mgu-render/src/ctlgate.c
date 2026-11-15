#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "ctlgate.h"
#include "proto.h"

/* a new file renamed over the old one, so the gate never reads half the words; written in place where that fails */
int ctlgate_write(const char *path, uint32_t hold) {
    char words[32] = "", tmp[512];
    if (hold != HOLD_ALL)
        snprintf(words, sizeof words, "%s%s%s\n", hold & HOLD_KNOB ? "knob " : "", hold & HOLD_PRESS ? "press " : "",
                 hold & HOLD_TILT ? "tilt " : "");
    size_t n = strlen(words);
    if (snprintf(tmp, sizeof tmp, "%s.new", path) >= (int)sizeof tmp) tmp[0] = 0;
    for (int in_place = !tmp[0]; in_place < 2; in_place++) {
        const char *to = in_place ? path : tmp;
        int fd = open(to, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0644);
        if (fd < 0) continue;
        int ok = write(fd, words, n) == (ssize_t)n;
        close(fd);
        if (in_place) return ok ? 0 : -1;
        if (ok && rename(tmp, path) == 0) return 0;
        unlink(tmp);
    }
    return -1;
}

int ctlgate_clear(const char *path) {
    int fd = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    struct stat st;
    int cleared = fstat(fd, &st) == 0 && st.st_size > 0 && ftruncate(fd, 0) == 0;
    if (cleared) {
        struct timespec ts[2] = { st.st_atim, st.st_mtim };
        futimens(fd, ts);
    }
    close(fd);
    return cleared;
}

int ctlgate_moves(const uint8_t *prev, const uint8_t *ev, uint32_t hold) {
    if (hold == HOLD_ALL) return 1;
    return ((hold & HOLD_KNOB) && (ev[1] != prev[1] || ev[2] != prev[2])) || ((hold & HOLD_PRESS) && ev[3] != prev[3]) ||
           ((hold & HOLD_TILT) && ev[4] != prev[4]);
}
