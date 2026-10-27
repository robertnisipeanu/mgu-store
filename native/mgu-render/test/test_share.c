/* The community socket beside other renderers (src/share.c), in a scratch folder: our socket, a fake second
 * renderer that binds the community path the way upstream's and IterioDev's do (unlink, bind; unlink at exit),
 * its unit file coming and going, and the handover in both directions. */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static void race(void);
#define SHARE_RACE_POINT() race()
#include "../src/share.c"

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static char dir[32], own[100], shared[100], unit[100];

static int listen_at(const char *path)
{
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);      /* accept() in reaches() must not wait */
    struct sockaddr_un sa = { .sun_family = AF_UNIX };
    snprintf(sa.sun_path, sizeof sa.sun_path, "%s", path);
    if (fd < 0 || bind(fd, (struct sockaddr *)&sa, sizeof sa) < 0 || listen(fd, 4) < 0) { perror(path); exit(1); }
    return fd;
}
/* the other renderer's start: unlink whatever is there, bind its own */
static int other_start(void) { unlink(shared); return listen_at(shared); }
/* the other renderer's exit: its socket goes */
static void other_stop(int fd) { close(fd); unlink(shared); }

/* which listener a client of the community path reaches: 1 ours, 2 the other's, 0 none */
static int reaches(int ours, int theirs)
{
    int c = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un sa = { .sun_family = AF_UNIX };
    snprintf(sa.sun_path, sizeof sa.sun_path, "%s", shared);
    int r = connect(c, (struct sockaddr *)&sa, sizeof sa) == 0;
    close(c);
    if (!r) return 0;
    int a = accept4(ours, NULL, NULL, SOCK_NONBLOCK);
    if (a >= 0) { close(a); return 1; }
    if (theirs >= 0) { a = accept4(theirs, NULL, NULL, SOCK_NONBLOCK); if (a >= 0) { close(a); return 2; } }
    return -1;
}

/* set: the next share_drop() meets another renderer binding between its check and its move */
static int race_armed, race_fd = -1;
static void race(void) { if (race_armed) { race_armed = 0; race_fd = other_start(); } }

static int is_link(const char *p) { struct stat st; return lstat(p, &st) == 0 && S_ISLNK(st.st_mode); }
static int is_sock(const char *p) { struct stat st; return lstat(p, &st) == 0 && S_ISSOCK(st.st_mode); }

int main(void)
{
    snprintf(dir, sizeof dir, "/tmp/mgu-share-XXXXXX");
    if (!mkdtemp(dir)) { perror("mkdtemp"); return 1; }
    char d1[64], d2[64];
    snprintf(d1, sizeof d1, "%s/mgu-render", dir); mkdir(d1, 0755);
    snprintf(d2, sizeof d2, "%s/systemd", dir); mkdir(d2, 0755);
    snprintf(own, sizeof own, "%s/render.sock", d1);
    snprintf(shared, sizeof shared, "%s/mgu-renderd/renderd.sock", dir);   /* its folder: made by whoever binds first */
    snprintf(unit, sizeof unit, "%s/mgu-renderd.service", d2);
    struct share s = { .own = own, .shared = shared, .yield = { unit, "/nonexistent/idrive7-renderd.service" }, .n_yield = 2 };

    /* before our socket exists nothing is linked */
    CHECK(share_update(&s) == SHARE_NONE && !is_link(shared), "linked to a socket that is not there");
    int ours = listen_at(own);

    /* alone: the community path links to ours, and its apps reach us */
    CHECK(share_update(&s) == SHARE_TAKEN && share_is_ours(&s, shared), "alone: not linked");
    CHECK(share_update(&s) == SHARE_HELD, "alone: second pass");
    CHECK(reaches(ours, -1) == 1, "alone: a community app does not reach us");

    /* another renderer installed and started: it unlinks our link and binds; we leave it be */
    FILE *f = fopen(unit, "w"); fputs("[Service]\n", f); fclose(f);
    int theirs = other_start();
    CHECK(share_update(&s) == SHARE_OTHER && is_sock(shared), "beside another: its socket was touched");
    CHECK(reaches(ours, theirs) == 2, "beside another: a community app does not reach it");
    CHECK(share_drop(&s) == SHARE_OTHER && is_sock(shared), "beside another: unshare removed its socket");

    /* it restarts (Restart=always): its socket goes for a moment; installed, so the path is not taken back */
    other_stop(theirs);
    CHECK(share_update(&s) == SHARE_NONE && access(shared, F_OK) != 0, "restarting other: path taken back");
    theirs = other_start();
    CHECK(reaches(ours, theirs) == 2, "restarted other: not reached");

    /* installed but not running (its unit written, not started yet): our link goes */
    other_stop(theirs);
    if (symlink(own, shared) != 0) { perror("symlink"); return 1; }
    CHECK(share_update(&s) == SHARE_DROPPED && access(shared, F_OK) != 0 && !is_link(shared), "installed other: our link stayed");

    /* removed: its unit file goes; the next pass takes the path back */
    unlink(unit);
    char d3[64]; snprintf(d3, sizeof d3, "%s/mgu-renderd", dir); rmdir(d3);   /* RuntimeDirectory= removes the folder */
    CHECK(share_update(&s) == SHARE_TAKEN && share_is_ours(&s, shared), "removed other: not taken back");
    CHECK(reaches(ours, -1) == 1, "taken back: a community app does not reach us");

    /* something else at the path, no renderer installed (a stale or hand-made socket): never removed */
    unlink(shared);
    int stray = listen_at(shared);
    CHECK(share_update(&s) == SHARE_OTHER && is_sock(shared), "stray socket replaced");
    CHECK(share_drop(&s) == SHARE_OTHER && is_sock(shared), "stray socket removed by unshare");
    /* and told live without a connection (one would start a socket unit's service) */
    CHECK(accept4(stray, NULL, NULL, SOCK_NONBLOCK) < 0 && errno == EAGAIN, "a live socket was connected to");
    close(stray);

    /* a socket nobody listens on (mgu-render 0.1's own, left after its socket unit restarted), no renderer
     * installed: replaced by our link; with another renderer installed, left */
    f = fopen(unit, "w"); fputs("[Service]\n", f); fclose(f);
    CHECK(share_update(&s) == SHARE_OTHER && is_sock(shared), "dead socket replaced beside an installed renderer");
    unlink(unit);
    CHECK(share_update(&s) == SHARE_TAKEN && reaches(ours, -1) == 1, "dead socket not replaced");
    unlink(shared);

    /* a link to some other target is not ours either */
    if (symlink("/run/elsewhere.sock", shared) != 0) { perror("symlink"); return 1; }
    CHECK(share_update(&s) == SHARE_OTHER && is_link(shared) && !share_is_ours(&s, shared), "foreign link replaced");
    unlink(shared);

    /* the drop race: the other renderer binds between our check and our move - its socket goes back */
    CHECK(share_update(&s) == SHARE_TAKEN, "race: not linked");
    f = fopen(unit, "w"); fputs("[Service]\n", f); fclose(f);
    race_armed = 1;
    CHECK(share_update(&s) == SHARE_OTHER && race_fd >= 0, "race: not met");
    CHECK(is_sock(shared) && reaches(ours, race_fd) == 2, "race: the other's socket is not back in place");
    other_stop(race_fd);
    unlink(unit);

    /* unshare (our socket unit stopping): our link goes, nothing else */
    CHECK(share_update(&s) == SHARE_TAKEN && share_drop(&s) == SHARE_DROPPED && access(shared, F_OK) != 0, "unshare kept our link");
    CHECK(share_drop(&s) == SHARE_NONE, "unshare of nothing");

    close(ours); unlink(own);
    char cmd[128]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir);
    if (system(cmd) != 0) { /* the scratch folder stays */ }
    printf("test_share: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
