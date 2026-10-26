/* The foreground gate (gate.h), from display-bridge's bridge.c. */
#define _GNU_SOURCE
#include "gate.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "log.h"

#define MAX_FRONT 16

static pid_t pid;
static int out = -1, in = -1, reported;
static uint32_t front[MAX_FRONT];
static int nfront;
static char line[256];
static size_t len;

int gate_start(const char *command)
{
    int o[2], i[2];
    if (pipe2(o, O_CLOEXEC) || pipe2(i, O_CLOEXEC)) {
        log_error("foreground gate: pipe: %s", strerror(errno));
        return -1;
    }
    pid = fork();
    if (pid < 0) {
        log_error("foreground gate: fork: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        /* Reports come on fd 3; the gate's stdout, where its libraries log, joins our log. Only the
         * renderer holds the write end of the gate's stdin: its exit, however it happens, closes the
         * gate's input. */
        int r = fcntl(i[0], F_DUPFD_CLOEXEC, 4), w = fcntl(o[1], F_DUPFD_CLOEXEC, 4);
        dup2(r, STDIN_FILENO);
        dup2(STDERR_FILENO, STDOUT_FILENO);
        dup2(w, 3);
        /* The unit's SOME/IP security matches a client's uid and gid together, and its policy for root
         * is uid 0 with gid 0: as root:mgu_wayland the gate's requests are refused. */
        if (geteuid() == 0 && getegid() != 0 && setgid(0))
            fprintf(stderr, "foreground gate: setgid 0: %s\n", strerror(errno));
        setenv("MGU_RENDER_REPORT_FD", "3", 1);
        execl("/bin/sh", "sh", "-c", command, (char *)NULL);
        _exit(127);
    }
    close(o[1]);
    close(i[0]);
    out = o[0];
    in = i[1];
    fcntl(out, F_SETFL, O_NONBLOCK);
    log_info("foreground gate: pid %d: %s", (int)pid, command);
    return 0;
}

int gate_fd(void) { return out; }
int gate_reported(void) { return reported; }

int gate_front(uint32_t uid)
{
    for (int i = 0; i < nfront; i++)
        if (front[i] == uid)
            return 1;
    return 0;
}

static void report(const char *l)
{
    nfront = 0;
    reported = 1;
    if (strncmp(l, "foreground", 10)) {
        log_warn("foreground gate: unexpected line '%s': no app in front", l);
        return;
    }
    char *end;
    for (const char *p = l + 10; nfront < MAX_FRONT; p = end) {
        unsigned long uid = strtoul(p, &end, 10);
        if (end == p)
            break;
        front[nfront++] = (uint32_t)uid;
    }
    log_info("in front: %s", nfront ? l + 11 : "no app");
}

int gate_read(void)
{
    int changed = 0;
    for (;;) {
        ssize_t n = read(out, line + len, sizeof line - 1 - len);
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))
            return changed;
        if (n <= 0) {
            log_error("foreground gate ended: %s", n ? strerror(errno) : "end of output");
            gate_stop();
            nfront = 0;
            reported = 0;
            len = 0;
            return -1;
        }
        len += (size_t)n;
        char *nl;
        while ((nl = memchr(line, '\n', len))) {
            *nl = 0;
            report(line);
            changed = 1;
            size_t used = (size_t)(nl + 1 - line);
            memmove(line, nl + 1, len - used);
            len -= used;
        }
        if (len == sizeof line - 1) {
            len = 0;
            report("(line too long)");
            changed = 1;
        }
    }
}

void gate_stop(void)
{
    if (!pid)
        return;
    if (in >= 0)
        close(in);
    if (out >= 0)
        close(out);
    in = out = -1;
    kill(pid, SIGTERM);
    waitpid(pid, NULL, 0);
    pid = 0;
}
