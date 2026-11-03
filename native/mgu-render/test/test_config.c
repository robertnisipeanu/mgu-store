/* The fps settings: the global one, an app's own (fps.<app>), and values refused. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "config.h"

static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL "); printf(__VA_ARGS__); printf("\n"); } } while (0)

int main(void)
{
    struct cfg c;
    cfg_defaults(&c);
    CHECK(cfg_fps(&c, "robertn_store") == 0, "the default: each app its own rate");
    CHECK(cfg_set_pair(&c, "fps.robertn_store = 60") == 0 && cfg_fps(&c, "robertn_store") == 60, "an app's own");
    CHECK(cfg_fps(&c, "doom") == 0, "the others keep theirs");
    CHECK(cfg_set_pair(&c, "fps=30") == 0 && cfg_fps(&c, "doom") == 30 && cfg_fps(&c, "robertn_store") == 60, "the global one, an app's own over it");
    CHECK(cfg_set_pair(&c, "fps.robertn_store=30") == 0 && cfg_fps(&c, "robertn_store") == 30 && c.n_app_fps == 1, "set again, not added");
    CHECK(cfg_set_pair(&c, "fps=2000") < 0 && cfg_set_pair(&c, "fps.x=-1") < 0 && cfg_set_pair(&c, "fps.=60") < 0, "out of range refused");
    for (int i = 0; i < CFG_MAX_APP_FPS; i++) {
        char kv[32];
        snprintf(kv, sizeof kv, "fps.app%d=60", i);
        cfg_set_pair(&c, kv);
    }
    CHECK(c.n_app_fps == CFG_MAX_APP_FPS, "at most %d apps", CFG_MAX_APP_FPS);
    {
        char p[] = "/tmp/mgu-render-local-XXXXXX";
        int fd = mkstemp(p);
        FILE *f = fdopen(fd, "w");
        fputs("touch_area = 84,0,1836,720\nnot a pair\nlocal_conf = /elsewhere\n", f);
        fclose(f);
        cfg_defaults(&c);
        snprintf(c.local_conf, sizeof c.local_conf, "%s", p);
        CHECK(cfg_load_local(&c) < 0 && c.touch_area[1] == 0 && c.touch_area[3] == 720, "local file: good lines applied, the bad one reported");
        CHECK(!strcmp(c.local_conf, p), "local file cannot point elsewhere");
        unlink(p);
        CHECK(cfg_load_local(&c) == 0, "absent local file: nothing to do");
    }
    printf("test_config: %d checks, %d failed\n", checks, fails);
    return fails != 0;
}
