/* Multi-touch through the daemon's own code (src/main.c compiled in here, src/touch.c as it is): apps connect over a
 * socket pair and speak the protocol (HELLO, CLAIM, X_FINGERS), the display's PDUs go to the diverted port as on
 * the unit, and what each app gets back is read from its socket. No compositor: the app counts as shown (its layer a
 * stand-in, never drawn). nft is a stand-in that does nothing.
 *  - X_READY offers CAP_FINGERS while touch routing is on;
 *  - a native app with X_FINGERS 1 gets every finger as X_FINGER (phase, id, logical x, y) and no TOUCH;
 *  - X_FINGERS 0: TOUCH again, the first finger only;
 *  - a legacy (iterio) app gets TOUCH for the first finger; an X_FINGERS from it changes nothing;
 *  - placement: logical coordinates relative to the app's origin. */
#define main mgu_render_main
#include "../src/main.c"
#undef main
#include <arpa/inet.h>
#include <sys/wait.h>

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static void put(int fd, uint32_t type, const void *p, uint32_t len)
{
    uint32_t h[2] = { type, len };
    if (write(fd, h, 8) != 8 || (len && write(fd, p, len) != (ssize_t)len)) { perror("write"); exit(1); }
}
static void put_u32(int fd, uint32_t type, uint32_t v) { put(fd, type, &v, 4); }

/* the app's side: the messages the daemon sent it, in order */
struct got { uint32_t type, len; uint8_t p[128]; };
static int take(int fd, struct got *g, int max)
{
    uint8_t b[16384];
    ssize_t n = recv(fd, b, sizeof b, MSG_DONTWAIT);
    int k = 0;
    for (ssize_t at = 0; n > 0 && at + 8 <= n && k < max; k++) {
        memcpy(&g[k].type, b + at, 4); memcpy(&g[k].len, b + at + 4, 4);
        memcpy(g[k].p, b + at + 8, g[k].len < sizeof g[k].p ? g[k].len : sizeof g[k].p);
        at += 8 + g[k].len;
    }
    return k;
}
static uint32_t u32(const struct got *g, int i) { uint32_t v; memcpy(&v, g->p + 4 * i, 4); return v; }
static float f32(const struct got *g, int i) { float v; memcpy(&v, g->p + 4 * i, 4); return v; }

/* a connected, shown app in slot: its socket end is returned */
static client *app(int slot, int *peer)
{
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv)) { perror("socketpair"); exit(1); }
    fcntl(sv[0], F_SETFL, O_NONBLOCK);
    client *c = calloc(1, sizeof *c);
    c->fd = sv[0]; c->slot = slot; c->xf.s = 1; c->es = EGL_NO_SURFACE; c->mode = MODE_LAYER; c->uid = getuid(); c->g.name = c->app;
    clients[slot] = c;
    *peer = sv[1];
    return c;
}
static void show(client *c, int x, int y)
{
    c->cl = (struct ivi_controller_layer *)c;      /* a stand-in: only its being there counts */
    c->visible = 1; c->frames_shown = 1; c->placed = 1; c->x = x; c->y = y;
}

/* a touchscreen PDU as the car's display sends it (104-byte payload): n fingers, each id, event, x, y */
static size_t pdun(unsigned char *b, int n, const int (*f)[4])
{
    memset(b, 0, 16 + 104);
    b[0] = 0xB0; b[1] = 0x04; b[2] = 0x80; b[3] = 0x02; b[7] = 104;
    unsigned char r[52] = { 0 };
    r[17] = (unsigned char)n;
    for (int k = 0; k < n; k++) {
        unsigned char *q = r + 18 + 6 * k;
        q[0] = (unsigned char)(f[k][2] >> 8); q[1] = (unsigned char)f[k][2];
        q[2] = (unsigned char)(f[k][3] >> 8); q[3] = (unsigned char)f[k][3];
        q[4] = 60; q[5] = (unsigned char)(f[k][1] << 4 | f[k][0]);
    }
    for (int i = 0; i < 52; i++) b[16 + 4 + 8 * (i / 4) + i % 4] = r[i];
    return 16 + 104;
}
static int tx, hmi;
static void pdu_in(int n, const int (*f)[4])
{
    unsigned char b[256], r[2048];
    struct sockaddr_in to = { .sin_family = AF_INET, .sin_port = htons(30570), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    size_t len = pdun(b, n, f);
    sendto(tx, b, len, 0, (struct sockaddr *)&to, sizeof to);
    usleep(2000);
    touch_read();
    while (recv(hmi, r, sizeof r, MSG_DONTWAIT) > 0) {}   /* what went on to the HMI: not looked at here */
}
/* down 1, down 2, 2 up, 1 up: the gesture every test sends, at x0 */
static void gesture(int x0)
{
    { const int f[][4] = { { 1, 1, x0, 300 } }; pdu_in(1, f); }
    { const int f[][4] = { { 1, 2, x0 + 1, 301 }, { 2, 1, x0 + 200, 320 } }; pdu_in(2, f); }
    { const int f[][4] = { { 1, 2, x0 + 2, 302 }, { 2, 3, x0 + 201, 321 } }; pdu_in(2, f); }
    { const int f[][4] = { { 1, 3, x0 + 3, 303 } }; pdu_in(1, f); }
}

int main(void)
{
    cfg_defaults(&cfg);
    cfg.foreground_gate[0] = 0;                     /* no foreground gate: a shown app is in front */
    char dir[] = "/tmp/mgu-fingers-XXXXXX", path[1200], nft[300];
    if (!mkdtemp(dir)) { perror("mkdtemp"); return 1; }
    snprintf(nft, sizeof nft, "%s/nft", dir);
    FILE *f = fopen(nft, "w"); fputs("#!/bin/sh\nexit 0\n", f); fclose(f); chmod(nft, 0755);
    snprintf(path, sizeof path, "%s:%s", dir, getenv("PATH") ? getenv("PATH") : "/usr/bin:/bin");
    setenv("PATH", path, 1);
    const int area[4] = { 0, 0, 0, 0 };
    if (touch_init("lo", "", area) != 0) { printf("touch_init failed\n"); return 1; }
    touch_on = 1;
    struct sockaddr_in h = { .sin_family = AF_INET, .sin_port = htons(30567), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    hmi = socket(AF_INET, SOCK_DGRAM, 0); tx = socket(AF_INET, SOCK_DGRAM, 0);
    if (bind(hmi, (struct sockaddr *)&h, sizeof h)) { perror("bind 30567"); return 1; }

    struct got g[64];
    int n;
    /* a native app at (100, 50), claiming x 1000..1600 of its own logical px */
    int pn;
    client *nat = app(0, &pn);
    const char hello_n[] = "player\0proto=mgu-render/1";
    put(pn, M_HELLO, hello_n, sizeof hello_n);
    float claim_n[5]; uint32_t one = 1; memcpy(claim_n, &one, 4);
    claim_n[1] = 1000; claim_n[2] = 0; claim_n[3] = 600; claim_n[4] = 600;
    put(pn, 9, claim_n, sizeof claim_n);
    put_u32(pn, X_FINGERS, 1);
    usleep(1000);
    CHECK(client_read(nat) == 0 && nat->dialect == DIALECT_NATIVE && nat->fingers && nat->nclaim == 1, "native app: hello/claim/X_FINGERS");
    n = take(pn, g, 64);
    CHECK(n >= 1 && g[0].type == X_READY && (u32(&g[0], 2) & CAP_FINGERS), "X_READY without CAP_FINGERS (%d messages)", n);
    show(nat, 100, 50);

    /* screen x 1200 = its logical 1100: in the claim */
    gesture(1200);
    n = take(pn, g, 64);
    int fingers = 0, touches = 0;
    for (int i = 0; i < n; i++) { fingers += g[i].type == X_FINGER; touches += g[i].type == EI_TOUCH; }
    CHECK(fingers == 6 && touches == 0, "X_FINGERS 1: %d X_FINGER, %d TOUCH", fingers, touches);
    if (fingers == 6) {
        const uint32_t ph[6] = { 1, 2, 1, 2, 3, 3 }, id[6] = { 1, 1, 2, 1, 2, 1 };
        const float x[6] = { 1100, 1101, 1300, 1102, 1301, 1103 }, y[6] = { 250, 251, 270, 252, 271, 253 };
        for (int i = 0, k = 0; i < n; i++) {
            if (g[i].type != X_FINGER) continue;
            CHECK(g[i].len == 16 && u32(&g[i], 0) == ph[k] && u32(&g[i], 1) == id[k] && f32(&g[i], 2) == x[k] && f32(&g[i], 3) == y[k],
                  "X_FINGER %d: phase %u id %u at %.0f,%.0f", k, u32(&g[i], 0), u32(&g[i], 1), f32(&g[i], 2), f32(&g[i], 3));
            k++;
        }
    }

    /* X_FINGERS 0: TOUCH again, the first finger only */
    put_u32(pn, X_FINGERS, 0); usleep(1000); client_read(nat);
    gesture(1200);
    n = take(pn, g, 64);
    fingers = touches = 0;
    for (int i = 0; i < n; i++) { fingers += g[i].type == X_FINGER; touches += g[i].type == EI_TOUCH; }
    CHECK(fingers == 0 && touches == 4, "X_FINGERS 0: %d X_FINGER, %d TOUCH", fingers, touches);
    clients[0] = NULL; nat->cl = NULL; close(pn);

    /* a legacy (iterio) app: TOUCH for the first finger; its X_FINGERS changes nothing */
    int pl;
    client *leg = app(1, &pl);
    put(pl, M_HELLO, "legacy", 6);
    float claim_l[5]; memcpy(claim_l, &one, 4);
    claim_l[1] = 0; claim_l[2] = 0; claim_l[3] = 1920; claim_l[4] = 720;
    put(pl, 9, claim_l, sizeof claim_l);
    put_u32(pl, X_FINGERS, 1);
    usleep(1000);
    CHECK(client_read(leg) == 0 && leg->dialect == DIALECT_ITERIO && !leg->fingers, "iterio app: dialect %d, fingers %d", leg->dialect, leg->fingers);
    n = take(pl, g, 64);
    CHECK(n == 1 && g[0].type == E_READY, "iterio app: %d messages before any touch, not READY alone", n);
    show(leg, 0, 0);
    gesture(500);
    n = take(pl, g, 64);
    fingers = touches = 0;
    for (int i = 0; i < n; i++) { fingers += g[i].type == X_FINGER; touches += g[i].type == EI_TOUCH; }
    CHECK(fingers == 0 && touches == 4 && g[0].len == 12 && u32(&g[0], 0) == 1 && f32(&g[0], 1) == 500 && f32(&g[0], 2) == 300,
          "iterio app: %d X_FINGER, %d TOUCH", fingers, touches);
    clients[1] = NULL; leg->cl = NULL; close(pl);

    touch_stop();
    while (wait(NULL) > 0) {}
    char cmd[64]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir);
    if (system(cmd) != 0) { /* the scratch folder stays */ }
    printf("test_fingers: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
