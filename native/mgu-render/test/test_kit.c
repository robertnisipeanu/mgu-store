/* Kit apps back to the community socket's renderer (src/kit.c), and the listener lookup it uses (src/share.c):
 * kit apps told by their folder, the listener's steadiness, the strikes and holds, and a socket told live without
 * a connection. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "../src/kit.h"
#include "../src/share.h"

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

#define S 1000000ull

static int listen_at(const char *path)
{
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);
    struct sockaddr_un sa = { .sun_family = AF_UNIX };
    snprintf(sa.sun_path, sizeof sa.sun_path, "%s", path);
    if (fd < 0 || bind(fd, (struct sockaddr *)&sa, sizeof sa) < 0 || listen(fd, 4) < 0) { perror(path); exit(1); }
    return fd;
}

static void mkfile(const char *p)
{
    char d[256];
    snprintf(d, sizeof d, "mkdir -p \"$(dirname '%s')\" && touch '%s'", p, p);
    if (system(d) != 0) { perror(p); exit(1); }
}

int main(void)
{
    char dir[] = "/tmp/mgu-kit-XXXXXX";
    if (!mkdtemp(dir)) { perror("mkdtemp"); return 1; }
    char p[256];

    /* a kit app is told by its folder's app spec; other apps (the Store) are not */
    snprintf(p, sizeof p, "%s/oap_12345/source/javascript/kit/app-spec.json", dir); mkfile(p);
    snprintf(p, sizeof p, "%s/oap_12346/source/javascript/main.js", dir); mkfile(p);
    CHECK(kit_app(dir, 12345), "kit app not told");
    CHECK(!kit_app(dir, 12346), "a non-kit app taken for a kit app");
    CHECK(!kit_app(dir, 12347), "an app without a folder taken for a kit app");

    /* the listener: steady only after KIT_STEADY_US of the same one; a new one (a restart) starts over */
    struct kit k = { 0 };
    uint64_t t = 100 * S;
    kit_listener(&k, 0, t);
    CHECK(!kit_steady(&k, t + 60 * S), "nothing listening, yet steady");
    kit_listener(&k, 77, t);
    CHECK(!kit_steady(&k, t + 2 * S), "steady after 2 s");
    kit_listener(&k, 77, t + 2 * S);
    CHECK(kit_steady(&k, t + KIT_STEADY_US), "the same listener for 5 s, not steady");
    kit_listener(&k, 78, t + 6 * S);
    CHECK(!kit_steady(&k, t + 8 * S), "a new listener taken as steady");
    kit_listener(&k, 0, t + 9 * S);
    CHECK(!kit_steady(&k, t + 30 * S), "gone, yet steady");

    /* first time: sent at once */
    uint32_t uid = 12345;
    CHECK(kit_connected(&k, uid, t) == 0, "a first connection counted as a strike");
    CHECK(kit_may_send(&k, uid, t), "first time: not sent");
    kit_sent(&k, uid, t);

    /* back within 60 s: a strike, held 30 s; back again: held 120 s; a third time: never */
    t += 4 * S;
    CHECK(kit_connected(&k, uid, t) == 1, "came back: no strike");
    CHECK(!kit_may_send(&k, uid, t + 10 * S), "1 strike: sent within the hold");
    CHECK(kit_may_send(&k, uid, t + KIT_HOLD1_US), "1 strike: not sent after the hold");
    t += KIT_HOLD1_US; kit_sent(&k, uid, t);
    t += 4 * S;
    CHECK(kit_connected(&k, uid, t) == 2, "came back twice: not 2 strikes");
    CHECK(!kit_may_send(&k, uid, t + KIT_HOLD1_US), "2 strikes: sent within the hold");
    CHECK(kit_may_send(&k, uid, t + KIT_HOLD2_US), "2 strikes: not sent after the hold");
    t += KIT_HOLD2_US; kit_sent(&k, uid, t);
    t += 4 * S;
    CHECK(kit_connected(&k, uid, t) == KIT_STRIKES, "came back three times: not 3 strikes");
    CHECK(!kit_may_send(&k, uid, t + 3600 * S), "3 strikes: sent again");

    /* away longer than 60 s (its renderer went down much later): a fresh start */
    CHECK(kit_connected(&k, uid, t + KIT_BACK_US + 3600 * S) == 0, "away long: strikes kept");
    CHECK(kit_may_send(&k, uid, t + KIT_BACK_US + 3600 * S), "away long: not sent");

    /* other apps are counted on their own; the table never overflows */
    kit_sent(&k, 1, t);
    CHECK(kit_may_send(&k, 2, t), "another app held by the first one's strikes");
    for (uint32_t u = 100; u < 100 + 2 * KIT_MAX_APPS; u++) kit_sent(&k, u, t + u);
    CHECK(kit_connected(&k, 100 + 2 * KIT_MAX_APPS - 1, t + 300) == 1, "the newest entry was lost");

    /* the listener lookup: a socket listening at the path, by the kernel's table, with no connection made */
    snprintf(p, sizeof p, "%s/renderd.sock", dir);
    CHECK(share_listener(p) == 0, "nothing there, yet a listener");
    int fd = listen_at(p);
    unsigned long ino = share_listener(p);
    struct stat st;
    CHECK(ino && ino != SHARE_UNKNOWN && fstat(fd, &st) == 0 && st.st_ino == ino, "the listening socket not found");
    CHECK(accept4(fd, NULL, NULL, SOCK_NONBLOCK) < 0 && errno == EAGAIN, "the lookup connected");
    /* a link to another socket is not a listener at the path (the community socket linked to ours) */
    char own[256], ln[256];
    snprintf(own, sizeof own, "%s/render.sock", dir);
    snprintf(ln, sizeof ln, "%s/link.sock", dir);
    int fo = listen_at(own);
    if (symlink(own, ln) != 0) { perror("symlink"); return 1; }
    CHECK(share_listener(ln) == 0, "our link taken for another renderer");
    /* stopped: the file stays, nobody listens; restarted: another listener */
    close(fd);
    CHECK(share_listener(p) == 0, "a closed socket still listening");
    unlink(p);
    fd = listen_at(p);
    unsigned long ino2 = share_listener(p);
    CHECK(ino2 && ino2 != SHARE_UNKNOWN && ino2 != ino, "a restarted listener not told from the first");
    close(fd); close(fo);

    snprintf(p, sizeof p, "rm -rf %s", dir);
    if (system(p) != 0) { /* the scratch folder stays */ }
    printf("test_kit: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
