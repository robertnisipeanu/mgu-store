/*
 * Touch routing (touch.h), from IterioDev's mgu-renderd src/touch.c (the renderer it
 * extends is idrive7-apps kit/renderd, MIT, Copyright (c) 2026 cauliflowermossgrape). The rule's interface and
 * source address come from the configuration (touch_iface, touch_saddr), per unit.
 *
 * The HMI (Hmi8 on iDrive 8, HmiMain3D on iDrive 7) reads the centre display's touch as UDP PDUs on port 30567 -
 * on the car from the display (APIX3 Ethernet, 160.48.199.115 on vlan73), in the MGU VM from vminput (lo). While a
 * visible app has claimed an area, one stateless nftables rule (raw prerouting, notrack, destination port
 * rewritten 30567 -> 30570) sends them here instead. Per gesture, decided when its first finger goes down: inside a
 * claim (and the -a area) -> the app's (E_TOUCH), else every PDU goes on to the HMI unchanged (127.0.0.1:30567,
 * from port 30571, which the VM rule skips so nothing loops). Non-finger PDUs always go to the HMI. Every finger of
 * the gesture goes to its owner: TOUCH for the first, X_FINGER for each to a native app that asked (X_FINGERS).
 *
 * Beside IterioDev's renderer, which diverts the same PDUs with its own rule (table ip touchroute, ports 30568 in
 * and 30569 out): ours has its own table (ip mgu_render) and ports, so neither removes the other's rule or takes
 * the other's port. Each diverts only while one of its own apps is shown with claims, so they take turns. Were
 * both in at once, the first chain to see a PDU takes it; on lo our rule lets IterioDev's re-injections (from
 * 30569) through as well as ours, and his catches ours, so a PDU passes each renderer at most once.
 * A gesture that goes to the HMI while apps claim closes them (E_CLOSED): the user tapped the HMI, e.g. its home
 * button - with no claim left the rule goes, and the rest of that gesture reaches the HMI directly.
 *
 * Fail open: no claim -> no rule. A guard process (forked at start) gets a heartbeat; when the renderer dies it
 * removes the rule, when it hangs with the rule in place (no beat for GUARD_MS) it removes the rule and kills it.
 *
 * PDU (Hmi8 CHmiTouchScreenDevice::decodeTouchScreenPduData): 16-byte header, big-endian id + length + 8-byte
 * timestamp; touchscreen data = id 0xB0048002, payload [12] >> 4 word type (0/1/2/4/8: the car's display sends
 * other types than the 8 vminput sends, so it is not checked), [37] & 0x1f finger count (0: no finger, the HMI's),
 * first finger [38] X u16, [44] Y u16, [47] bits 4-5 event (1 down, 2 move, 3 up; bits 6-7 its touch type), bits 0-3
 * its id; the further fingers where report(), below, puts them.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "touch.h"

enum { PORT_HMI = 30567, PORT_IN = 30570, PORT_OUT = 30571, PORT_OTHER_OUT = 30569, GUARD_MS = 1500, REFRESH_MS = 10000, JOB_MS = 10000, RETRY_MS = 5000 };
#define TABLE "ip mgu_render"
enum { DOWN = 1, MOVE = 2, UP = 3, CANCEL = 4 };
enum { NONE = -1, HMI = -2, GONE = -3 };       /* gesture owner, else a client slot; GONE: its app left */

/* On the car the release firewall (ip filter input, ends in logblocked = drop) only accepts the display's touch
 * on 30567, so the diverted 30570 needs its own accept in that chain - inserted (once, idempotent) every time
 * the divert goes in, as the firewall may have been reloaded meanwhile; without it diverted touches never arrive
 * (iDrive 8 car). lo (a local sender) is accepted anyway. */
static char rule[384], open_fw[512];
static int in = -1, out = -1, beat = -1, loaded, owner = NONE;
static int ax, ay, aw, ah;                     /* area apps may claim; aw 0 = whole screen */

static unsigned be32(const unsigned char *p) { return (unsigned)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]; }

/* nft runs beside the render loop, never in it: one job at a time, a shell started with posix_spawn and looked at
 * (waitpid WNOHANG) every loop turn, killed with its process group after JOB_MS. A slow or failing nft only delays the
 * divert; the loop keeps drawing and beating. */
enum { JOB_NONE, JOB_CLEAN, JOB_IN, JOB_OUT };
static int job;                                /* the one running, JOB_NONE when idle */
static pid_t job_pid;
static double job_t;
static int job_killed;
static char job_file[32];                      /* the script's file while JOB_IN runs */
static double failed = -1e9;                   /* when a load last failed */
static int stray;                              /* a failed load may have put the rule in all the same */

static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

static int job_start(int kind, const char *cmd)
{
    posix_spawnattr_t at;
    sigset_t dfl;
    posix_spawnattr_init(&at);
    sigemptyset(&dfl); sigaddset(&dfl, SIGPIPE);              /* ignored here; nft gets the default */
    posix_spawnattr_setsigdefault(&at, &dfl);
    posix_spawnattr_setpgroup(&at, 0);                        /* its own group: a timeout kills nft too */
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETPGROUP);
    char *argv[] = { "sh", "-c", (char *)cmd, NULL };
    int r = posix_spawn(&job_pid, "/bin/sh", NULL, &at, argv, environ);
    posix_spawnattr_destroy(&at);
    if (r) return -1;
    job = kind; job_t = now_ms(); job_killed = 0;
    return 0;
}

/* the rule's job: the firewall's accept, the script given to nft in a file (nftables 0.7 on iDrive 7 units reads
 * "-" as a file of that name, fails and still exits 0), then the table must be there: an nft that reports a load
 * done is not proof */
static int rule_in_start(void)
{
    char s[768], cmd[sizeof open_fw + 256];
    snprintf(s, sizeof s, "table " TABLE "\ndelete table " TABLE "\ntable " TABLE " {\n"
        "chain pre {\ntype filter hook prerouting priority -300; policy accept;\n%s\n}\n}\n", rule);
    snprintf(job_file, sizeof job_file, "/tmp/mgu-render-nft-XXXXXX");
    int fd = mkstemp(job_file);
    if (fd < 0) { job_file[0] = 0; return -1; }
    size_t n = strlen(s);
    int ok = write(fd, s, n) == (ssize_t)n;
    close(fd);
    int len = snprintf(cmd, sizeof cmd, "%s%s%snft -f %s 2>&1 && nft list table " TABLE " >/dev/null 2>&1",
             open_fw[0] ? "{ " : "", open_fw, open_fw[0] ? "; } || echo '[mgu-render] touch: opening the firewall for 30570 failed'; " : "", job_file);
    if (!ok || len >= (int)sizeof cmd || job_start(JOB_IN, cmd) < 0) { unlink(job_file); job_file[0] = 0; return -1; }
    return 0;
}
/* no file: taking the rule out must work with /tmp full; an absent table is not an error here */
#define RULE_OUT "nft delete table " TABLE " >/dev/null 2>&1"
static void rule_out(void) { if (system(RULE_OUT)) {} }
static int rule_out_start(int kind) { return job_start(kind, RULE_OUT); }

/* the running job: -1 still running, else 0 done and succeeded, 1 failed (or killed after JOB_MS) */
static int job_poll(void)
{
    int st;
    pid_t r = waitpid(job_pid, &st, WNOHANG);
    if (r == 0) {
        if (!job_killed && now_ms() - job_t > JOB_MS) { kill(-job_pid, SIGKILL); job_killed = 1; }
        return -1;
    }
    if (job_file[0]) { unlink(job_file); job_file[0] = 0; }
    job = JOB_NONE;
    return job_killed || r < 0 || !WIFEXITED(st) || WEXITSTATUS(st) ? 1 : 0;
}

/* The guard: beats are '0' (no rule) / '1' (rule in, or may be). Dead renderer (pipe closed) -> rule out; hung with the
 * rule in -> rule out + kill it. A hang without the rule (start-up, nothing claimed) touches nobody's input. */
static void guard(int fd, pid_t renderer)
{
    char b[64], state = '0';
    for (int fdn = 3; fdn < 1024; fdn++) if (fdn != fd) close(fdn);
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN);
    for (;;) {
        struct pollfd pf = { .fd = fd, .events = POLLIN };
        int r = poll(&pf, 1, GUARD_MS);
        if (r > 0) {
            ssize_t n = read(fd, b, sizeof b);
            if (n > 0) { state = b[n - 1]; continue; }
            rule_out();                                       /* the renderer is gone */
            _exit(0);
        }
        if (r == 0 && state == '1') {
            fprintf(stderr, "[mgu-render guard] renderer hung with touch diverted: rule removed, renderer killed\n");
            rule_out();
            kill(renderer, SIGKILL);
            _exit(0);
        }
    }
}

/* the divert rule and the firewall line for iface (and saddr), into rule and open_fw; -1 for a bad name */
static int touch_rules(const char *iface, const char *saddr)
{
    if (!iface || !*iface) { fprintf(stderr, "touch: no interface\n"); return -1; }
    for (const char *q = iface; *q; q++) if (!((*q >= 'a' && *q <= 'z') || (*q >= '0' && *q <= '9') || *q == '.' || *q == '_' || *q == '-')) return -1;
    for (const char *q = saddr; q && *q; q++) if (!((*q >= '0' && *q <= '9') || *q == '.')) return -1;
    if (!strcmp(iface, "lo")) {
        /* the HMI's touch comes from a local sender: re-injections (ours from PORT_OUT, IterioDev's renderer's from
         * PORT_OTHER_OUT) go on to the HMI */
        snprintf(rule, sizeof rule, "iifname \"lo\" udp sport { %d, %d } accept\n"
                 "iifname \"lo\" udp dport %d notrack udp dport set %d", PORT_OTHER_OUT, PORT_OUT, PORT_HMI, PORT_IN);
        open_fw[0] = 0;
    } else {
        char src[64] = "";
        if (saddr && *saddr) snprintf(src, sizeof src, "ip saddr %s ", saddr);
        snprintf(rule, sizeof rule, "iifname \"%s\" %sudp dport %d notrack udp dport set %d", iface, src, PORT_HMI, PORT_IN);
        snprintf(open_fw, sizeof open_fw, "nft list chain ip filter input 2>/dev/null | grep -q 'udp dport %d accept' || "
                 "nft insert rule ip filter input iifname %s %sudp dport %d accept", PORT_IN, iface, src, PORT_IN);
    }
    return 0;
}

int touch_init(const char *iface, const char *saddr, const int area[4])
{
    if (touch_rules(iface, saddr) < 0) return -1;
    aw = 0;
    if (area && area[2] > 0 && area[3] > 0) { ax = area[0]; ay = area[1]; aw = area[2]; ah = area[3]; }
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(PORT_IN), .sin_addr.s_addr = htonl(INADDR_ANY) };
    struct sockaddr_in o = { .sin_family = AF_INET, .sin_port = htons(PORT_OUT), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    in = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    out = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (bind(in, (struct sockaddr *)&a, sizeof a) || bind(out, (struct sockaddr *)&o, sizeof o)) {
        perror("touch: bind 30570/30571"); close(in); close(out); in = out = -1; return -1;
    }
    int p[2];
    pid_t me = getpid();
    if (pipe2(p, O_CLOEXEC)) return -1;
    pid_t g = fork();
    if (g == 0) { close(p[1]); guard(p[0], me); }
    close(p[0]);
    if (g < 0) { close(p[1]); return -1; }
    beat = p[1];
    fcntl(beat, F_SETFL, O_NONBLOCK);
    if (rule_out_start(JOB_CLEAN) < 0) { /* a leftover from a crash: the guard or ExecStopPost took it out */ }
    if (aw) fprintf(stderr, "[mgu-render] touch routing on %s, apps may claim %d,%d %dx%d\n", iface, ax, ay, aw, ah);
    else fprintf(stderr, "[mgu-render] touch routing on %s, apps may claim the whole screen\n", iface);
    return 0;
}

int touch_fd(void) { return in; }

void touch_tick(int claimed)
{
    static double last_beat, refreshed;
    static int failing;
    if (!rule[0]) return;
    double t = now_ms();
    if (job) {
        int was = job, r = job_poll();
        if (r >= 0) {
            if (was == JOB_IN && !r) {
                if (!loaded || failing) fprintf(stderr, "[mgu-render] touch: diverted (an app claims an area)\n");
                loaded = 1; failing = 0;
            } else if (was == JOB_IN && loaded) {
                fprintf(stderr, "[mgu-render] touch: refreshing the nft rule failed%s\n", job_killed ? " (no answer in 10 s)" : "");
            } else if (was == JOB_IN) {
                failed = t; stray = 1;
                if (!failing) fprintf(stderr, "[mgu-render] touch: loading the nft rule failed%s, touch stays the HMI's; "
                                      "trying again every 5 s\n", job_killed ? " (no answer in 10 s)" : "");
                failing = 1;
            } else if (was == JOB_OUT && job_killed) {
                fprintf(stderr, "[mgu-render] touch: taking the nft rule out gave no answer in 10 s; trying again\n");
            } else if (was == JOB_OUT) {
                if (loaded) fprintf(stderr, "[mgu-render] touch: nothing claimed, straight to the HMI\n");
                loaded = 0; stray = 0;
            }
            last_beat = 0;
        }
    }
    /* a firewall reload while diverted (an overlay diverts all the time) would drop every touch on its way here:
     * while an overlay claims (2), the rule and the firewall's accept go in again every REFRESH_MS */
    if (!job && claimed == 2 && loaded && t - refreshed > REFRESH_MS) {
        refreshed = t;
        if (rule_in_start() < 0) fprintf(stderr, "[mgu-render] touch: refreshing the nft rule failed\n");
    }
    claimed = claimed != 0;
    if (!job && (claimed != loaded || (!claimed && stray))) {
        if (!claimed) { if (rule_out_start(JOB_OUT) < 0) fprintf(stderr, "[mgu-render] touch: nft could not be started\n"); }
        else if (t - failed > RETRY_MS) {                     /* nft missing / refusing: not every loop turn */
            refreshed = t;
            if (rule_in_start() < 0) {
                failed = t;
                if (!failing) fprintf(stderr, "[mgu-render] touch: loading the nft rule failed, touch stays the HMI's; trying again every 5 s\n");
                failing = 1;
            }
        }
        last_beat = 0;
    }
    if (t - last_beat < 100) return;
    last_beat = t;
    /* '1' while the rule is or may be in: the loop never waits for nft, so a missing beat is a hang */
    if (write(beat, loaded || stray || job == JOB_IN ? "1" : "0", 1) < 0) { /* full pipe: the guard is behind, it reads the latest */ }
}

int touch_busy(void) { return job != JOB_NONE; }

void touch_forget(int slot) { if (owner == slot) owner = GONE; }   /* its fingers are still tracked, to the gesture's end */

/* at exit: a running nft is stopped, and the guard, seeing the renderer gone, takes the rule out */
void touch_stop(void)
{
    if (job) { kill(-job_pid, SIGKILL); if (job_file[0]) unlink(job_file); job = JOB_NONE; }
    if (beat >= 0) { close(beat); beat = -1; }
    loaded = stray = 0;
}

/* The PDU's fingers. The payload after the 16-byte header is a row of 8-byte records (4 bytes header, 4 data); the
 * data bytes of all records in a row are the report: [17] finger count (payload [37]), from [18] six bytes per finger,
 * xH xL yH yL size state (state bits 4-5 the event, bits 0-3 the display's finger id). Report byte i is payload byte
 * 4 + 8 * (i / 4) + i % 4, so the first finger is payload [38] x, [44] y, [47] event, the second [52] x, [54] y,
 * [61] event (measured on an MGU18, F93: one and two fingers). -1 past the PDU's end. */
static int report(const unsigned char *p, size_t plen, int i)
{
    size_t o = 4 + 8 * (size_t)(i / 4) + (size_t)(i % 4);
    return o < plen ? p[o] : -1;
}

enum { FINGERS = 16 };
static int fdown[FINGERS], fx[FINGERS], fy[FINGERS];   /* per finger id: down in this gesture, where it was last */
static int first = -1;                         /* the finger that began the gesture: it also goes as TOUCH */

/* the app's events for one finger: X_FINGER to an app that asked, TOUCH for the gesture's first finger */
static void send_finger(int phase, int id, int x, int y)
{
    if (owner < 0) return;
    touch_finger(owner, phase, id, x, y);
    if (id == first) touch_send(owner, phase, x, y);
}
static void finger_up(int id)
{
    send_finger(UP, id, fx[id], fy[id]);
    fdown[id] = 0;
    if (id == first) first = -1;
}
/* how many fingers are down, and in *last the highest id of them */
static int downs(int *last)
{
    int n = 0;
    for (int f = 0; f < FINGERS; f++) if (fdown[f]) { n++; if (last) *last = f; }
    return n;
}
/* a finger whose UP was never seen: no TOUCH (an UP there would tap what it was on), CANCEL to an app that asked */
static void finger_lost(int id)
{
    if (owner >= 0) touch_finger(owner, CANCEL, id, fx[id], fy[id]);
    fdown[id] = 0;
    if (id == first) first = -1;
}

/* a touchscreen PDU with fingers: 1 = it is an app's (sent to it, or dropped), 0 = forward to the HMI.
 * A gesture begins when a finger goes down while none is: the owner is decided there (the app claiming that point,
 * else the HMI) and keeps every finger until none is down. A finger that was down and is missing from a report, or
 * goes down again, lost its UP (a lost datagram, the rule taken out meanwhile): it is let go first, without a TOUCH,
 * so a lost UP never hands the next gesture to the last owner. A listed finger with event 0 stays down, nothing sent.
 * A report of one finger while one is down is that finger, whatever its id. One finger: DOWN, MOVEs, UP as TOUCH. */
static int route_pdu(const unsigned char *p, size_t plen)
{
    int n = p[37] & 0x1f, m = 0, id[FINGERS], ev[FINGERS], x[FINGERS], y[FINGERS], seen[FINGERS] = { 0 }, only = -1;
    for (int k = 0; k < n && m < FINGERS; k++) {
        int b[6];
        for (int j = 0; j < 6; j++) if ((b[j] = report(p, plen, 18 + 6 * k + j)) < 0) goto parsed;
        int e = (b[5] >> 4) & 3, f = b[5] & 15;
        if (seen[f]) continue;
        seen[f] = 1; id[m] = f; ev[m] = e; x[m] = b[0] << 8 | b[1]; y[m] = b[2] << 8 | b[3]; m++;
    }
parsed:
    if (m == 1 && ev[0] != DOWN && downs(&only) == 1) id[0] = only;
    for (int f = 0; f < FINGERS; f++) {
        if (!fdown[f]) continue;
        int k = 0;
        while (k < m && id[k] != f) k++;
        if (k == m || ev[k] == DOWN) finger_lost(f);
    }
    if (!downs(NULL)) {
        owner = NONE;                             /* the last gesture's fingers are all gone */
        int k = 0;
        while (k < m && ev[k] != DOWN) k++;
        if (k < m) {
            int slot = touch_owner_at(x[k], y[k], !aw || (x[k] >= ax && y[k] >= ay && x[k] < ax + aw && y[k] < ay + ah));
            owner = slot >= 0 ? slot : HMI;
            first = id[k];
            if (owner == HMI) touch_outside();   /* e.g. the HMI's home button: the shown app is left */
        }
    }
    int app = owner >= 0 || owner == GONE;
    if (owner != NONE) {
        for (int k = 0; k < m; k++) {
            int f = id[k];
            if (!ev[k]) continue;
            if (ev[k] == UP) { if (fdown[f]) { fx[f] = x[k]; fy[f] = y[k]; finger_up(f); } continue; }
            int phase = fdown[f] ? MOVE : DOWN;       /* a move whose DOWN we missed begins that finger */
            fdown[f] = 1; fx[f] = x[k]; fy[f] = y[k];
            send_finger(phase, f, x[k], y[k]);
        }
        if (!downs(NULL)) owner = NONE;
    }
    return app;
}

void touch_read(void)
{
    unsigned char b[2048], f[2048];
    struct sockaddr_in hmi = { .sin_family = AF_INET, .sin_port = htons(PORT_HMI), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    ssize_t len;
    while ((len = recv(in, b, sizeof b, 0)) > 0) {
        size_t fn = 0, at = 0;                    /* walk the PDUs; copy the ones that go on to the HMI */
        while (at + 16 <= (size_t)len) {
            size_t plen = be32(b + at + 4), end = at + 16 + plen;
            if (end > (size_t)len) { end = len; plen = len - at - 16; }
            const unsigned char *p = b + at + 16;
            if (!(be32(b + at) == 0xB0048002 && plen >= 48 && (p[37] & 0x1f) && route_pdu(p, plen))) {
                memcpy(f + fn, b + at, end - at); fn += end - at;
            }
            at = end;
        }
        if (at < (size_t)len) { memcpy(f + fn, b + at, len - at); fn += len - at; }   /* trailing bytes: as they came */
        if (fn) sendto(out, f, fn, 0, (struct sockaddr *)&hmi, sizeof hmi);
    }
}
