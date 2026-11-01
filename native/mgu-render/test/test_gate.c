/* The renderer's side of the foreground gate: its reports, its end, and "unavailable". */
#include <poll.h>
#include <stdio.h>
#include <unistd.h>

#include "gate.h"

static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL "); printf(__VA_ARGS__); printf("\n"); } } while (0)

/* reads until the gate ends */
static void drain(void)
{
    for (int i = 0; i < 100 && gate_fd() >= 0; i++) {
        struct pollfd p = { gate_fd(), POLLIN, 0 };
        poll(&p, 1, 100);
        gate_read();
    }
}

int main(void)
{
    gate_start("printf 'foreground 12204\\n' >&3; sleep 0.2");
    drain();
    CHECK(gate_fd() < 0, "the gate ended");
    CHECK(!gate_unavailable(), "a gate that reported is not unavailable");

    gate_start("printf 'unavailable\\n' >&3");
    drain();
    CHECK(gate_unavailable(), "unavailable");
    CHECK(!gate_reported() && !gate_any_front() && !gate_front(12204), "no app in front");
    printf("test_gate: %d checks, %d failed\n", checks, fails);
    return fails != 0;
}
