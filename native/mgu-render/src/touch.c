/*
 * Touch routing (touch.h), from IterioDev's mgu-renderd src/touch.c (the renderer it
 * extends is idrive7-apps kit/renderd, MIT, Copyright (c) 2026 cauliflowermossgrape). The rule's interface and
 * source address come from the configuration (touch_iface, touch_saddr), per unit.
 *
 * The HMI (Hmi8 on iDrive 8, HmiMain3D on iDrive 7) reads the centre display's touch as UDP PDUs on port 30567 -
 * on the car from the display (APIX3 Ethernet, 160.48.199.115 on vlan73), in the MGU VM from vminput (lo). While a
 * visible app has claimed an area, one stateless nftables rule (raw prerouting, notrack, destination port
 * rewritten 30567 -> 30570) sends them here instead. Per gesture, decided when the finger goes down: inside a
 * claim (and the -a area) -> the app's (E_TOUCH), else every PDU goes on to the HMI unchanged (127.0.0.1:30567,
 * from port 30571, which the VM rule skips so nothing loops). Non-finger PDUs always go to the HMI. One finger.
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
 * first finger [38] X u16, [44] Y u16, [47] bits 4-5 event (1 down, 2 move, 3 up; bits 6-7 its touch type).
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#include "touch.h"

enum { PORT_HMI = 30567, PORT_IN = 30570, PORT_OUT = 30571, PORT_OTHER_OUT = 30569, GUARD_MS = 1500, REFRESH_MS = 10000 };
#define TABLE "ip mgu_render"
enum { DOWN = 1, MOVE = 2, UP = 3 };
enum { NONE = -1, HMI = -2, GONE = -3 };       /* gesture owner, else a client slot; GONE: its app left */

/* On the car the release firewall (ip filter input, ends in logblocked = drop) only accepts the display's touch
 * on 30567, so the diverted 30570 needs its own accept in that chain - inserted (once, idempotent) every time
 * the divert goes in, as the firewall may have been reloaded meanwhile; without it diverted touches never arrive
 * (iDrive 8 car). lo (VM, emulator) is accepted anyway. */
static char rule[384], open_fw[512];
static int in = -1, out = -1, beat = -1, loaded, owner = NONE;
static int ax, ay, aw, ah;                     /* area apps may claim; aw 0 = whole screen */

static unsigned be16(const unsigned char *p) { return p[0] << 8 | p[1]; }
static unsigned be32(const unsigned char *p) { return (unsigned)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]; }

static int nft(const char *script)
{
    FILE *f = popen("nft -f - 2>&1", "w");
    if (!f) return -1;
    fputs(script, f);
    return pclose(f) == 0 ? 0 : -1;
}
static int rule_in(void)
{
    if (open_fw[0] && system(open_fw) != 0) fprintf(stderr, "[mgu-render] touch: opening the firewall for %d failed\n", PORT_IN);
    char s[768];
    snprintf(s, sizeof s, "table " TABLE "\ndelete table " TABLE "\ntable " TABLE " {\n"
        "chain pre {\ntype filter hook prerouting priority -300; policy accept;\n%s\n}\n}\n", rule);
    return nft(s);
}
static void rule_out(void) { nft("table " TABLE "\ndelete table " TABLE "\n"); }

/* The guard: beats are '0' (no rule) / '1' (rule in). Dead renderer (pipe closed) -> rule out; hung with the
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
    rule_out();                                               /* a leftover from a crash before this start */
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
    if (aw) fprintf(stderr, "[mgu-render] touch routing on %s, apps may claim %d,%d %dx%d\n", iface, ax, ay, aw, ah);
    else fprintf(stderr, "[mgu-render] touch routing on %s, apps may claim the whole screen\n", iface);
    return 0;
}

int touch_fd(void) { return in; }

static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

void touch_tick(int claimed)
{
    static double last_beat, failed, refreshed;
    if (!rule[0]) return;
    double t = now_ms();
    /* a firewall reload while diverted (an overlay diverts all the time) would drop every touch on its way here:
     * the rule and the firewall's accept go in again every REFRESH_MS */
    if (claimed && loaded && t - refreshed > REFRESH_MS) {
        refreshed = t;
        if (rule_in() != 0) fprintf(stderr, "[mgu-render] touch: refreshing the nft rule failed\n");
    }
    if (claimed != loaded) {
        if (!claimed) { rule_out(); loaded = 0; fprintf(stderr, "[mgu-render] touch: nothing claimed, straight to the HMI\n"); }
        else if (t - failed > 5000) {                         /* nft missing / refusing: not every loop turn */
            if (rule_in() == 0) { loaded = 1; refreshed = t; fprintf(stderr, "[mgu-render] touch: diverted (an app claims an area)\n"); }
            else { failed = t; fprintf(stderr, "[mgu-render] touch: loading the nft rule failed, touch stays the HMI's\n"); }
        }
        last_beat = 0;
    }
    if (t - last_beat < 100) return;
    last_beat = t;
    if (write(beat, loaded ? "1" : "0", 1) < 0) { /* full pipe: the guard is behind, it reads the latest */ }
}

void touch_forget(int slot) { if (owner == slot) owner = GONE; }

void touch_stop(void) { if (loaded) rule_out(); loaded = 0; }

/* one finger PDU: 1 = it is an app's (sent to it, or dropped), 0 = forward to the HMI */
static int route_finger(const unsigned char *p)
{
    int x = be16(p + 38), y = be16(p + 44), ev = (p[47] >> 4) & 3;
    /* every DOWN starts a gesture (one finger): an UP we never saw - the rule went (HMI touched, app gone) or a
     * lost datagram - must not hand the next gesture to the last owner */
    if (ev == DOWN) {
        int slot = touch_owner_at(x, y, !aw || (x >= ax && y >= ay && x < ax + aw && y < ay + ah));
        owner = slot >= 0 ? slot : HMI;
        if (owner == HMI) touch_outside();       /* e.g. the HMI's home button: the shown app is left */
    }
    int app = owner >= 0 || owner == GONE;
    if (owner >= 0 && ev >= DOWN && ev <= UP) touch_send(owner, ev, x, y);
    if (ev == UP) owner = NONE;
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
            if (!(be32(b + at) == 0xB0048002 && plen >= 48 && (p[37] & 0x1f) && route_finger(p))) {
                memcpy(f + fn, b + at, end - at); fn += end - at;
            }
            at = end;
        }
        if (at < (size_t)len) { memcpy(f + fn, b + at, len - at); fn += len - at; }   /* trailing bytes: as they came */
        if (fn) sendto(out, f, fn, 0, (struct sockaddr *)&hmi, sizeof hmi);
    }
}
