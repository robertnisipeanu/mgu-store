/* Touch PDU routing (src/touch.c, compiled in here), with PDUs as the car's display and vminput send them: the
 * diverted socket is a loopback pair, the HMI side a socket on another port, main.c's hooks are stubs. nft is a
 * stand-in that logs every script, to check the divert beside IterioDev's renderer: our own table and ports only,
 * in while claimed, out when not, out when the renderer dies. */
#include "../src/touch.c"
#include <sys/stat.h>
#include <sys/wait.h>

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static int sent[16][4], nsent, outside;
/* slot 0 claims x >= 1000 inside the area; slot 1, an overlay, claims y >= 840 wherever it is (main.c's rule) */
int touch_owner_at(int x, int y, int in_area) { return y >= 840 ? 1 : in_area && x >= 1000 ? 0 : -1; }
void touch_send(int slot, int phase, int x, int y) { if (nsent < 16) { int *s = sent[nsent++]; s[0] = slot; s[1] = phase; s[2] = x; s[3] = y; } }
void touch_outside(void) { outside++; }

/* one touchscreen PDU: word type, finger count, first finger x/y, event (bits 4-5) with touch type (bits 6-7) */
static size_t pdu(unsigned char *b, int word, int fingers, int x, int y, int ev, int ttype)
{
    memset(b, 0, 16 + 48);
    b[0] = 0xB0; b[1] = 0x04; b[2] = 0x80; b[3] = 0x02; b[7] = 48;
    unsigned char *p = b + 16;
    p[12] = (unsigned char)(word << 4);
    p[37] = (unsigned char)fingers;
    p[38] = (unsigned char)(x >> 8); p[39] = (unsigned char)x;
    p[44] = (unsigned char)(y >> 8); p[45] = (unsigned char)y;
    p[47] = (unsigned char)(ttype << 6 | ev << 4);
    return 16 + 48;
}

static int tx, hmi;
static struct sockaddr_in to_in;
/* sends a datagram to the diverted port, routes it, returns the bytes forwarded to the HMI */
static ssize_t route(const unsigned char *b, size_t n)
{
    sendto(tx, b, n, 0, (struct sockaddr *)&to_in, sizeof to_in);
    usleep(2000);
    touch_read();
    unsigned char r[2048];
    struct pollfd pf = { .fd = hmi, .events = POLLIN };
    return poll(&pf, 1, 20) > 0 ? recv(hmi, r, sizeof r, 0) : 0;
}

static char nft_log[256];
static char *slurp(void)
{
    static char buf[16384];
    FILE *f = fopen(nft_log, "r");
    size_t n = f ? fread(buf, 1, sizeof buf - 1, f) : 0;
    if (f) fclose(f);
    buf[n] = 0;
    return buf;
}
static int count(const char *hay, const char *needle) { int n = 0; for (const char *p = hay; (p = strstr(p, needle)); p++) n++; return n; }
/* rules loaded, and taken out (a load also deletes the table first, to replace it) */
static int loads(void) { return count(slurp(), "table ip mgu_render {"); }
static int outs(void) { return count(slurp(), "delete table ip mgu_render") - loads(); }

int main(void)
{
    /* nft: a script that logs its arguments and what it reads */
    char dir[] = "/tmp/mgu-touch-XXXXXX", nft_path[300], path[1200];
    if (!mkdtemp(dir)) { perror("mkdtemp"); return 1; }
    snprintf(nft_log, sizeof nft_log, "%s/nft.log", dir);
    snprintf(nft_path, sizeof nft_path, "%s/nft", dir);
    FILE *f = fopen(nft_path, "w");
    fprintf(f, "#!/bin/sh\n{ echo \"nft $*\"; [ \"$1\" = -f ] && cat; } >> %s\n", nft_log);
    fclose(f); chmod(nft_path, 0755);
    snprintf(path, sizeof path, "%s:%s", dir, getenv("PATH") ? getenv("PATH") : "/usr/bin:/bin");
    setenv("PATH", path, 1);

    /* the car's rule and firewall line: our ports, the display's address */
    CHECK(touch_rules("vlan73", "160.48.199.115") == 0 &&
          !strcmp(rule, "iifname \"vlan73\" ip saddr 160.48.199.115 udp dport 30567 notrack udp dport set 30570") &&
          strstr(open_fw, "nft insert rule ip filter input iifname vlan73 ip saddr 160.48.199.115 udp dport 30570 accept"),
          "car rule: %s / %s", rule, open_fw);

    /* lo: our rule lets both renderers' re-injections through */
    const int area[4] = { 0, 0, 0, 0 };
    if (touch_init("lo", "", area) != 0) { printf("touch_init failed\n"); return 1; }
    CHECK(strstr(rule, "iifname \"lo\" udp sport { 30569, 30571 } accept\n") &&
          strstr(rule, "iifname \"lo\" udp dport 30567 notrack udp dport set 30570") && !open_fw[0], "lo rule: %s", rule);
    CHECK(outs() == 1 && loads() == 0, "start: a leftover of ours is not removed");
    touch_tick(1);
    CHECK(loads() == 1 && strstr(slurp(), "udp dport set 30570"), "claimed: rule not in");
    touch_tick(1);
    CHECK(loads() == 1, "claimed twice: loaded twice");
    touch_tick(2);
    CHECK(loads() == 1, "an overlay's claim (2) with the rule in: loaded again before REFRESH_MS");
    touch_tick(0);
    CHECK(outs() == 2, "nothing claimed: rule not out");

    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(PORT_IN), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    struct sockaddr_in h = { .sin_family = AF_INET, .sin_port = htons(PORT_HMI), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    hmi = socket(AF_INET, SOCK_DGRAM, 0); tx = socket(AF_INET, SOCK_DGRAM, 0);
    if (bind(hmi, (struct sockaddr *)&h, sizeof h)) { perror("bind 30567"); return 1; }
    to_in = a;
    unsigned char b[512];
    size_t n;

    /* the car: word type 0, one finger, touch type bits set - inside the claim: the app's, nothing to the HMI */
    n = pdu(b, 0, 1, 1500, 300, DOWN, 2);
    CHECK(route(b, n) == 0, "car DOWN in the claim reached the HMI");
    n = pdu(b, 0, 1, 1510, 310, MOVE, 2); route(b, n);
    n = pdu(b, 0, 1, 1510, 310, UP, 2); route(b, n);
    CHECK(nsent == 3 && sent[0][0] == 0 && sent[0][1] == DOWN && sent[0][2] == 1500 && sent[0][3] == 300 &&
          sent[1][1] == MOVE && sent[2][1] == UP, "car gesture: %d events to the app", nsent);
    CHECK(outside == 0, "car gesture in the claim closed the apps");

    /* vminput: word type 8 - the same routing */
    nsent = 0;
    n = pdu(b, 8, 1, 1200, 200, DOWN, 0);
    CHECK(route(b, n) == 0 && nsent == 1 && sent[0][1] == DOWN, "vminput DOWN in the claim");
    n = pdu(b, 8, 1, 1200, 200, UP, 0); route(b, n);

    /* outside the claim: forwarded unchanged, the apps hear the HMI was touched */
    nsent = 0;
    n = pdu(b, 4, 1, 500, 200, DOWN, 1);
    CHECK(route(b, n) == (ssize_t)n && nsent == 0 && outside == 1, "DOWN outside the claim: forwarded %d, outside %d", (int)n, outside);
    n = pdu(b, 4, 1, 500, 200, UP, 1);
    CHECK(route(b, n) == (ssize_t)n, "UP outside the claim forwarded");

    /* no finger (count 0, e.g. the display's status words): the HMI's, even inside the claim */
    nsent = 0;
    n = pdu(b, 0, 0, 1500, 300, DOWN, 0);
    CHECK(route(b, n) == (ssize_t)n && nsent == 0, "a PDU without fingers is the HMI's");

    /* two PDUs in one datagram: the app's finger is kept, the other forwarded */
    unsigned char two[512];
    size_t n1 = pdu(two, 0, 1, 1500, 300, DOWN, 0), n2 = pdu(two + n1, 0, 0, 0, 0, 0, 0);
    CHECK(route(two, n1 + n2) == (ssize_t)n2 && nsent == 1, "mixed datagram: forwarded part");

    /* iDrive 8's area (title strip and climate bar out): the overlay's claim in the climate bar is still its, the
     * title strip outside every claim the HMI's */
    ax = 0; ay = 76; aw = 2880; ah = 764;
    nsent = 0; outside = 0;
    n = pdu(b, 0, 1, 1100, 900, DOWN, 0);
    CHECK(route(b, n) == 0 && nsent == 1 && sent[0][0] == 1 && outside == 0, "DOWN on the overlay below the area");
    n = pdu(b, 0, 1, 1100, 900, UP, 0); route(b, n);
    n = pdu(b, 0, 1, 1500, 50, DOWN, 0);
    CHECK(route(b, n) == (ssize_t)n && nsent == 2 && outside == 1, "DOWN in the title strip: not the HMI's");
    n = pdu(b, 0, 1, 1500, 50, UP, 0); route(b, n);
    aw = 0;

    /* the renderer dies with the rule in: its guard takes it out */
    touch_tick(1);
    close(beat);
    int out_after = 0;
    for (int i = 0; i < 100 && !out_after; i++) { usleep(20000); out_after = loads() == 2 && outs() == 3; }
    CHECK(out_after, "renderer gone: the guard left the rule in");
    CHECK(!strstr(slurp(), "touchroute"), "a script names IterioDev's table");
    while (wait(NULL) > 0) {}

    char cmd[64]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir);
    if (system(cmd) != 0) { /* the scratch folder stays */ }
    printf("test_touch: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
