/* The controller gate's file: the words written, a leftover emptied, writing where no new file can be made, and which
 * controller events the safety net counts. */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "ctlgate.h"
#include "proto.h"

static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL "); printf(__VA_ARGS__); printf("\n"); } } while (0)

static const char *slurp(const char *path) {
    static char buf[64];
    FILE *f = fopen(path, "r");
    size_t n = f ? fread(buf, 1, sizeof buf - 1, f) : 0;
    if (f) fclose(f);
    buf[n] = 0;
    return f ? buf : NULL;
}

int main(void)
{
    char dir[] = "/tmp/ctlgate.XXXXXX", gate[64], tmp[80];
    if (!mkdtemp(dir)) { perror("mkdtemp"); return 1; }
    snprintf(gate, sizeof gate, "%s/inputgate", dir);
    snprintf(tmp, sizeof tmp, "%s.new", gate);

    CHECK(ctlgate_write(gate, HOLD_KNOB | HOLD_PRESS) == 0 && !strcmp(slurp(gate), "knob press \n"), "knob press written");
    CHECK(access(tmp, F_OK) != 0, "no new file left");
    CHECK(ctlgate_write(gate, HOLD_ALL) == 0 && !strcmp(slurp(gate), ""), "all three: empty");

    /* a leftover (killed while it held parts): emptied, its age kept, so a stale file stays stale */
    ctlgate_write(gate, HOLD_TILT);
    struct timespec old[2] = { { 1000, 0 }, { 1000, 0 } };
    utimensat(AT_FDCWD, gate, old, 0);
    CHECK(ctlgate_clear(gate) == 1, "leftover cleared");
    struct stat st;
    CHECK(stat(gate, &st) == 0 && st.st_size == 0 && st.st_mtim.tv_sec == 1000, "empty, age kept");
    CHECK(ctlgate_clear(gate) == 0, "nothing to clear");
    unlink(gate);
    CHECK(ctlgate_clear(gate) == 0 && access(gate, F_OK) != 0, "no file: none made");

    /* no new file can be made beside it: the words go into the file itself, fresh */
    ctlgate_write(gate, HOLD_KNOB);
    utimensat(AT_FDCWD, gate, old, 0);
    mkdir(tmp, 0755);
    CHECK(ctlgate_write(gate, HOLD_PRESS) == 0 && !strcmp(slurp(gate), "press \n"), "written in place");
    CHECK(stat(gate, &st) == 0 && st.st_mtim.tv_sec > 1000, "in place: fresh");
    rmdir(tmp);
    char nodir[96];
    snprintf(nodir, sizeof nodir, "%s/none/inputgate", dir);
    CHECK(ctlgate_write(nodir, HOLD_KNOB) == -1, "unwritable: -1");

    /* the safety net: every event while all three are held; otherwise only what moves a held part */
    const uint8_t rest[5] = { 1, 0x10, 0x00, 0, 0 }, knob[5] = { 2, 0x10, 0x01, 0, 0 }, press[5] = { 3, 0x10, 0x00, 1, 0 },
                  tilt[5] = { 4, 0x10, 0x00, 0, 3 };
    CHECK(ctlgate_moves(rest, rest, HOLD_ALL) && ctlgate_moves(rest, tilt, HOLD_ALL), "all three: every event");
    CHECK(ctlgate_moves(rest, knob, HOLD_KNOB | HOLD_PRESS) && ctlgate_moves(rest, press, HOLD_KNOB | HOLD_PRESS),
          "knob and press held: they count");
    CHECK(!ctlgate_moves(rest, tilt, HOLD_KNOB | HOLD_PRESS) && !ctlgate_moves(tilt, rest, HOLD_KNOB | HOLD_PRESS),
          "knob and press held: a tilt and its return don't");
    CHECK(!ctlgate_moves(rest, knob, HOLD_TILT) && ctlgate_moves(rest, tilt, HOLD_TILT), "tilt held: only the tilt");

    unlink(gate);
    rmdir(dir);
    printf("ctlgate: %d/%d\n", checks - fails, checks);
    return fails != 0;
}
