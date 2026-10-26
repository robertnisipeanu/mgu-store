/* Touch PDU routing (src/touch.c, compiled in here), with PDUs as the car's display and vminput send them: the
 * diverted socket is a loopback pair, the HMI side a socket on another port, main.c's hooks are stubs. */
#include "../src/touch.c"

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static int sent[16][4], nsent, outside;
int touch_owner_at(int x, int y) { return x >= 1000 ? 0 : -1; }     /* slot 0 claims x >= 1000 */
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

int main(void)
{
    /* touch_init would load nft rules; the sockets it binds are set up here the same way */
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(PORT_IN), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    struct sockaddr_in o = { .sin_family = AF_INET, .sin_port = htons(PORT_OUT), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    struct sockaddr_in h = { .sin_family = AF_INET, .sin_port = htons(PORT_HMI), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    in = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK, 0); out = socket(AF_INET, SOCK_DGRAM, 0);
    hmi = socket(AF_INET, SOCK_DGRAM, 0); tx = socket(AF_INET, SOCK_DGRAM, 0);
    if (bind(in, (struct sockaddr *)&a, sizeof a) || bind(out, (struct sockaddr *)&o, sizeof o) || bind(hmi, (struct sockaddr *)&h, sizeof h)) {
        perror("bind 30567-30569"); return 1;
    }
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

    printf("test_touch: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
