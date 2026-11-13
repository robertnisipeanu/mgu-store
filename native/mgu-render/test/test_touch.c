/* Touch PDU routing (src/touch.c, compiled in here), with PDUs as the car's display and vminput send them: the
 * diverted socket is a loopback pair, the HMI side a socket on another port, main.c's hooks are stubs. nft is a
 * stand-in that logs every script, to check the divert beside IterioDev's renderer: our own table and ports only,
 * in while claimed, out when not, out when the renderer dies. A slow nft (<dir>/slow holds its seconds) and a
 * failing one (<dir>/fail) never hold up touch_tick. */
#include "../src/touch.c"
#include <sys/stat.h>
#include <sys/wait.h>

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static int sent[16][4], nsent, outside, fing[32][5], nfing, claim_x = 1000;
/* slot 0 claims x >= claim_x (1000) inside the area; slot 1, an overlay, claims y >= 840 wherever it is (main.c's rule) */
int touch_owner_at(int x, int y, int in_area) { return y >= 840 ? 1 : in_area && x >= claim_x ? 0 : -1; }
void touch_send(int slot, int phase, int x, int y) { if (nsent < 16) { int *s = sent[nsent++]; s[0] = slot; s[1] = phase; s[2] = x; s[3] = y; } }
void touch_finger(int slot, int phase, int id, int x, int y)
{
    if (nfing < 32) { int *s = fing[nfing++]; s[0] = slot; s[1] = phase; s[2] = id; s[3] = x; s[4] = y; }
}
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

/* a touchscreen PDU as the car's display sends it (104-byte payload, 13 records): n fingers, each id, event, x, y.
 * Report byte i (the records' data bytes in a row) is payload byte 4 + 8 * (i / 4) + i % 4. */
static size_t pdun(unsigned char *b, int n, const int (*f)[4])
{
    memset(b, 0, 16 + 104);
    b[0] = 0xB0; b[1] = 0x04; b[2] = 0x80; b[3] = 0x02; b[7] = 104;
    unsigned char *p = b + 16, r[52] = { 0 };
    r[17] = (unsigned char)n;
    for (int k = 0; k < n; k++) {
        unsigned char *q = r + 18 + 6 * k;
        q[0] = (unsigned char)(f[k][2] >> 8); q[1] = (unsigned char)f[k][2];
        q[2] = (unsigned char)(f[k][3] >> 8); q[3] = (unsigned char)f[k][3];
        q[4] = 60; q[5] = (unsigned char)(f[k][1] << 4 | f[k][0]);
    }
    for (int i = 0; i < 52; i++) p[4 + 8 * (i / 4) + i % 4] = r[i];
    return 16 + 104;
}
static int has_finger(int k, int slot, int phase, int id, int x, int y)
{
    return k < nfing && fing[k][0] == slot && fing[k][1] == phase && fing[k][2] == id && fing[k][3] == x && fing[k][4] == y;
}

/* PDUs from an F93 (MGU18, P18_23w44.2-1-3): finger 1 down; 1 moves, 2 down; 1 moves, 2 up; 1 up; then
 * 1 down; 1 moves, 2 down; both up in one PDU */
static const char *car[] = {
    "b004800200000068000000000101020000c540000000000000c140010000000000c140020000000000c140038000400100c140044001038e00c140050120461100c140060000000000c140070000000000c140080000000000c140090000000000c1400a0000000000c3400b00000000",
    "b004800200000068000000000101020000c540d80000000000c140d90000000000c140da0000000000c140db8000400200c140dcc002038b00c140dd0123552100c140de052f013f00c140df4b12000000c140e00000000000c140e10000000000c140e20000000000c340e300000000",
    "b004800200000068000000000101020000c540580000000000c140590000000000c1405a0000000000c1405b8000400200c1405cc002039000c1405d011e502100c1405e0538013a00c1405f4132000000c140600000000000c140610000000000c140620000000000c3406300000000",
    "b004800200000068000000000101020000c5402c0000000000c1402d0000000000c1402e0000000000c1402f0000400100c140308001039300c140310118413100c140320000000000c140330000000000c140340000000000c140350000000000c140360000000000c3403700000000",
    "b004800200000068000000000101020000c540380000000000c140390000000000c1403a0000000000c1403b8000400100c1403c4001047700c1403d01373c1100c1403e0000000000c1403f0000000000c140400000000000c140410000000000c140420000000000c3404300000000",
    "b004800200000068000000000101020000c540b00000000000c140b10000000000c140b20000000000c140b38000400200c140b4c002047700c140b501394b2100c140b6040f015100c140b75012000000c140b80000000000c140b90000000000c140ba0000000000c340bb00000000",
    "b004800200000068000000000101020000c540d80000000000c140d90000000000c140da0000000000c140db8000400200c140dc400204a800c140dd018e413100c140de0448019100c140df3732000000c140e00000000000c140e10000000000c140e20000000000c340e300000000",};
static size_t hex(unsigned char *b, const char *h)
{
    size_t n = strlen(h) / 2;
    for (size_t i = 0; i < n; i++) { unsigned v; sscanf(h + 2 * i, "%2x", &v); b[i] = (unsigned char)v; }
    return n;
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

/* touch_tick(claimed) until nft is done (at most 5 s); returns the longest touch_tick took, in ms */
static double settle(int claimed)
{
    double worst = 0, t0 = now_ms();
    do {
        double t = now_ms();
        touch_tick(claimed);
        if (now_ms() - t > worst) worst = now_ms() - t;
        usleep(5000);
    } while (touch_busy() && now_ms() - t0 < 5000);
    return worst;
}

int main(void)
{
    /* nft: a script that logs its arguments and the file it is given; while <dir>/gone exists, `nft list table`
     * finds no table (nftables 0.7 given a script on "-": it reports the load done, and nothing went in) */
    char dir[] = "/tmp/mgu-touch-XXXXXX", nft_path[300], path[1200], gone[300], slow[300], fail[300];
    if (!mkdtemp(dir)) { perror("mkdtemp"); return 1; }
    snprintf(nft_log, sizeof nft_log, "%s/nft.log", dir);
    snprintf(nft_path, sizeof nft_path, "%s/nft", dir);
    snprintf(gone, sizeof gone, "%s/gone", dir);
    snprintf(slow, sizeof slow, "%s/slow", dir);
    snprintf(fail, sizeof fail, "%s/fail", dir);
    FILE *f = fopen(nft_path, "w");
    fprintf(f, "#!/bin/sh\n[ -e %s ] && sleep $(cat %s)\n[ -e %s ] && exit 1\n"
               "{ echo \"nft $*\"; [ \"$1\" = -f ] && cat \"$2\"; } >> %s\n"
               "[ \"$1 $2\" != \"list table\" ] || [ ! -e %s ]\n", slow, slow, fail, nft_log, gone);
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
    settle(0);
    CHECK(outs() == 1 && loads() == 0, "start: a leftover of ours is not removed");
    settle(1);
    CHECK(loads() == 1 && loaded && strstr(slurp(), "udp dport set 30570"), "claimed: rule not in");
    settle(1);
    CHECK(loads() == 1, "claimed twice: loaded twice");
    settle(2);
    CHECK(loads() == 1, "an overlay's claim (2) with the rule in: loaded again before REFRESH_MS");
    settle(0);
    CHECK(outs() == 2 && !loaded, "nothing claimed: rule not out");

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
    n = pdu(b, 0, 1, 1500, 300, UP, 0); route(b, n);

    /* two fingers in the claim: every finger to the app (X_FINGER), the first one also as TOUCH, nothing to the HMI */
    nsent = 0; nfing = 0; outside = 0;
    { const int f[][4] = { { 1, DOWN, 1200, 300 } }; n = pdun(b, 1, f); CHECK(route(b, n) == 0, "2f: first DOWN forwarded"); }
    { const int f[][4] = { { 1, MOVE, 1201, 301 }, { 2, DOWN, 1400, 320 } }; n = pdun(b, 2, f); CHECK(route(b, n) == 0, "2f: second DOWN forwarded"); }
    { const int f[][4] = { { 1, MOVE, 1202, 302 }, { 2, UP, 1401, 321 } }; n = pdun(b, 2, f); CHECK(route(b, n) == 0, "2f: second UP forwarded"); }
    { const int f[][4] = { { 1, UP, 1203, 303 } }; n = pdun(b, 1, f); CHECK(route(b, n) == 0, "2f: first UP forwarded"); }
    CHECK(nfing == 6 && has_finger(0, 0, DOWN, 1, 1200, 300) && has_finger(1, 0, MOVE, 1, 1201, 301) &&
          has_finger(2, 0, DOWN, 2, 1400, 320) && has_finger(3, 0, MOVE, 1, 1202, 302) &&
          has_finger(4, 0, UP, 2, 1401, 321) && has_finger(5, 0, UP, 1, 1203, 303), "2f: %d finger events", nfing);
    CHECK(nsent == 4 && sent[0][1] == DOWN && sent[0][2] == 1200 && sent[1][1] == MOVE && sent[2][1] == MOVE &&
          sent[2][2] == 1202 && sent[3][1] == UP && outside == 0, "2f: TOUCH is the first finger only (%d)", nsent);

    /* the second finger outside every claim: still the app's, the HMI hears nothing */
    nsent = 0; nfing = 0;
    { const int f[][4] = { { 3, DOWN, 1500, 300 } }; n = pdun(b, 1, f); route(b, n); }
    { const int f[][4] = { { 3, MOVE, 1500, 300 }, { 4, DOWN, 200, 300 } }; n = pdun(b, 2, f);
      CHECK(route(b, n) == 0 && outside == 0 && has_finger(2, 0, DOWN, 4, 200, 300), "2f: second finger outside the claim"); }
    { const int f[][4] = { { 3, UP, 1500, 300 }, { 4, UP, 200, 300 } }; n = pdun(b, 2, f);
      CHECK(route(b, n) == 0 && nfing == 5, "2f: both up in one PDU: %d events", nfing); }

    /* the first finger lifts first: TOUCH ends there, the second finger stays the app's to its UP */
    nsent = 0; nfing = 0;
    { const int f[][4] = { { 1, DOWN, 1200, 300 } }; n = pdun(b, 1, f); route(b, n); }
    { const int f[][4] = { { 1, MOVE, 1200, 300 }, { 2, DOWN, 1300, 300 } }; n = pdun(b, 2, f); route(b, n); }
    { const int f[][4] = { { 1, UP, 1200, 300 }, { 2, MOVE, 1300, 300 } }; n = pdun(b, 2, f); route(b, n); }
    { const int f[][4] = { { 2, MOVE, 1310, 300 } }; n = pdun(b, 1, f);
      CHECK(route(b, n) == 0 && has_finger(nfing - 1, 0, MOVE, 2, 1310, 300), "2f: second finger after the first lifted"); }
    { const int f[][4] = { { 2, UP, 1310, 300 } }; n = pdun(b, 1, f); route(b, n); }
    CHECK(nsent == 3 && sent[0][1] == DOWN && sent[1][1] == MOVE && sent[2][1] == UP && sent[2][2] == 1200,
          "2f: TOUCH followed the second finger (%d)", nsent);

    /* a finger missing from a report lost its UP: let go then (CANCEL, never an UP: that would tap where it was, e.g.
     * the Store's button under a popup that took the UP); the next DOWN is a new gesture */
    nsent = 0; nfing = 0;
    { const int f[][4] = { { 1, DOWN, 1200, 300 } }; n = pdun(b, 1, f); route(b, n); }
    { const int f[][4] = { { 1, MOVE, 1200, 300 }, { 2, DOWN, 1300, 300 } }; n = pdun(b, 2, f); route(b, n); }
    { const int f[][4] = { { 1, MOVE, 1205, 300 } }; n = pdun(b, 1, f); route(b, n); }
    CHECK(has_finger(3, 0, CANCEL, 2, 1300, 300) && has_finger(4, 0, MOVE, 1, 1205, 300), "lost UP of the second finger");
    { const int f[][4] = { { 1, DOWN, 500, 300 } }; n = pdun(b, 1, f);
      CHECK(route(b, n) == (ssize_t)n && has_finger(5, 0, CANCEL, 1, 1205, 300) && outside == 1,
            "a DOWN again: the old finger cancelled, the new gesture the HMI's"); }
    CHECK(nsent == 3 && sent[2][1] == MOVE, "a lost UP: %d TOUCH events, the last phase %d", nsent, sent[nsent - 1][1]);
    { const int f[][4] = { { 1, UP, 500, 300 } }; n = pdun(b, 1, f); CHECK(route(b, n) == (ssize_t)n, "HMI gesture UP"); }

    /* a listed finger with event 0 is still down: the gesture stays the app's, nothing sent for it */
    nsent = 0; nfing = 0;
    { const int f[][4] = { { 1, DOWN, 1200, 300 } }; n = pdun(b, 1, f); route(b, n); }
    { const int f[][4] = { { 1, 0, 1200, 300 } }; n = pdun(b, 1, f); CHECK(route(b, n) == 0, "event 0: forwarded"); }
    { const int f[][4] = { { 1, MOVE, 1210, 300 } }; n = pdun(b, 1, f); CHECK(route(b, n) == 0, "after event 0: MOVE forwarded"); }
    { const int f[][4] = { { 1, UP, 1210, 300 } }; n = pdun(b, 1, f); route(b, n); }
    CHECK(nsent == 3 && sent[1][1] == MOVE && sent[2][1] == UP, "event 0: %d TOUCH events", nsent);

    /* one finger reported while one is down is that finger, whatever its id: a single-finger gesture never depends on
     * the display's finger ids */
    nsent = 0;
    { const int f[][4] = { { 0, DOWN, 1200, 300 } }; n = pdun(b, 1, f); route(b, n); }
    { const int f[][4] = { { 5, MOVE, 1220, 300 } }; n = pdun(b, 1, f); CHECK(route(b, n) == 0, "new id: MOVE forwarded"); }
    { const int f[][4] = { { 7, UP, 1230, 300 } }; n = pdun(b, 1, f); route(b, n); }
    CHECK(nsent == 3 && sent[1][1] == MOVE && sent[2][1] == UP && sent[2][2] == 1230, "new id: %d TOUCH events", nsent);

    /* a gesture that begins outside: every finger the HMI's, PDUs unchanged */
    nsent = 0; nfing = 0; outside = 0;
    { const int f[][4] = { { 1, DOWN, 500, 300 } }; n = pdun(b, 1, f); CHECK(route(b, n) == (ssize_t)n, "HMI 2f: DOWN"); }
    { const int f[][4] = { { 1, MOVE, 500, 300 }, { 2, DOWN, 1500, 300 } }; n = pdun(b, 2, f);
      CHECK(route(b, n) == (ssize_t)n && nfing == 0 && nsent == 0 && outside == 1, "HMI 2f: second finger in the claim taken"); }
    { const int f[][4] = { { 1, UP, 500, 300 }, { 2, UP, 1500, 300 } }; n = pdun(b, 2, f); route(b, n); }

    /* the app leaves mid-gesture: the rest of it is dropped, to its last finger's UP */
    nsent = 0; nfing = 0;
    { const int f[][4] = { { 1, DOWN, 1200, 300 } }; n = pdun(b, 1, f); route(b, n); }
    touch_forget(0);
    { const int f[][4] = { { 1, MOVE, 1200, 300 }, { 2, DOWN, 1300, 300 } }; n = pdun(b, 2, f);
      CHECK(route(b, n) == 0 && nfing == 1 && nsent == 1, "gone app: rest of gesture dropped"); }
    { const int f[][4] = { { 1, UP, 1200, 300 }, { 2, UP, 1300, 300 } }; n = pdun(b, 2, f); CHECK(route(b, n) == 0, "gone app: UP dropped"); }
    { const int f[][4] = { { 1, DOWN, 500, 300 } }; n = pdun(b, 1, f); CHECK(route(b, n) == (ssize_t)n, "after a gone app: next gesture"); }
    { const int f[][4] = { { 1, UP, 500, 300 } }; n = pdun(b, 1, f); route(b, n); }

    /* the car's own PDUs, everything in the claim */
    claim_x = 0; nsent = 0; nfing = 0; outside = 0;
    for (size_t i = 0; i < sizeof car / sizeof *car; i++) { n = hex(b, car[i]); CHECK(route(b, n) == 0, "car PDU %zu forwarded", i); }
    CHECK(nfing == 11 && has_finger(0, 0, DOWN, 1, 910, 288) && has_finger(1, 0, MOVE, 1, 907, 291) &&
          has_finger(2, 0, DOWN, 2, 1327, 319) && has_finger(3, 0, MOVE, 1, 912, 286) && has_finger(4, 0, UP, 2, 1336, 314) &&
          has_finger(5, 0, UP, 1, 915, 280) && has_finger(6, 0, DOWN, 1, 1143, 311) && has_finger(8, 0, DOWN, 2, 1039, 337) &&
          has_finger(9, 0, UP, 1, 1192, 398) && has_finger(10, 0, UP, 2, 1096, 401), "car PDUs: %d finger events", nfing);
    CHECK(nsent == 7 && sent[0][1] == DOWN && sent[0][2] == 910 && sent[3][1] == UP && sent[4][1] == DOWN && sent[6][1] == UP,
          "car PDUs: %d TOUCH events", nsent);
    claim_x = 1000;

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

    /* a slow nft (2 s a run): every touch_tick returns at once, the rule goes in and out all the same, and the
     * guard, beating meanwhile, kills nothing */
    FILE *sf = fopen(slow, "w"); fputs("2\n", sf); fclose(sf);
    double worst = settle(1);
    CHECK(worst < 50 && loaded && loads() == 2, "slow nft, in: a tick took %.0f ms, loaded %d", worst, loaded);
    worst = settle(0);
    CHECK(worst < 50 && !loaded && outs() == 3, "slow nft, out: a tick took %.0f ms, loaded %d", worst, loaded);
    unlink(slow);

    /* a failing nft: not counted as in, a tick never waits, the next try comes RETRY_MS later and then succeeds */
    fclose(fopen(fail, "w"));
    worst = settle(1);
    CHECK(worst < 50 && !loaded, "failing nft: loaded %d, a tick took %.0f ms", loaded, worst);
    int before = loads();
    unlink(fail);
    settle(1);
    CHECK(!loaded && loads() == before, "failing nft: tried again before RETRY_MS");
    for (int i = 0; i < 140 && !loaded; i++) { usleep(50000); settle(1); }
    CHECK(loaded && loads() == before + 1, "failing nft: not tried again once it works");
    settle(0);

    /* a failed load the claim gives up before the next try: the rule may be in, so it is taken out */
    fclose(fopen(fail, "w"));
    failed -= RETRY_MS;
    settle(1);
    unlink(fail);
    before = outs();
    settle(0);
    CHECK(outs() == before + 1 && !stray && !loaded, "a failed load, then no claim: not taken out");

    /* an nft that never answers: killed after JOB_MS, counted as failed, its script file gone */
    sf = fopen(slow, "w"); fputs("60\n", sf); fclose(sf);
    failed -= RETRY_MS;
    touch_tick(1);
    CHECK(touch_busy() && job_file[0], "hung nft: no load started");
    char kept[32]; snprintf(kept, sizeof kept, "%s", job_file);
    job_t -= JOB_MS + 1;                                      /* as if JOB_MS had passed */
    settle(1);
    CHECK(!touch_busy() && !loaded && access(kept, F_OK) != 0, "hung nft: busy %d loaded %d, %s left", touch_busy(), loaded, kept);
    unlink(slow);
    failed -= RETRY_MS;
    settle(1);
    CHECK(loaded, "after a hung nft: the rule did not go in");

    /* the renderer dies with the rule in: its guard takes it out */
    before = outs();
    close(beat);
    int out_after = 0;
    for (int i = 0; i < 100 && !out_after; i++) { usleep(20000); out_after = outs() == before + 1; }
    CHECK(out_after, "renderer gone: the guard left the rule in");
    CHECK(!strstr(slurp(), "touchroute"), "a script names IterioDev's table");
    while (wait(NULL) > 0) {}

    /* every script goes to nft in a file, and a load counts only when its table is there afterwards */
    CHECK(count(slurp(), "nft -f /tmp/mgu-render-nft-") == count(slurp(), "nft -f "), "a script not given in a file");
    fclose(fopen(gone, "w"));
    loaded = 0; failed -= RETRY_MS; beat = open("/dev/null", O_WRONLY);
    settle(1);
    CHECK(!loaded, "a load whose table is not there counted as in");
    unlink(gone);
    failed -= RETRY_MS;
    settle(1);
    CHECK(loaded, "a load whose table is there counted as failed");
    CHECK(count(slurp(), "nft -f /tmp/mgu-render-nft-") == count(slurp(), "nft -f "), "a script not given in a file");
    CHECK(system("ls /tmp/mgu-render-nft-* >/dev/null 2>&1") != 0, "a script file left in /tmp");

    char cmd[64]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir);
    if (system(cmd) != 0) { /* the scratch folder stays */ }
    printf("test_touch: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
