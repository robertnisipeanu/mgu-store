#include "log.h"

#include <stdarg.h>
#include <stdio.h>
#include <time.h>

int log_verbose;

int64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

void log_at(char level, const char *fmt, ...)
{
    static int64_t start;
    int64_t now = now_ms();
    if (!start)
        start = now;
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "[%7lld.%03lld] %c ", (long long)((now - start) / 1000), (long long)((now - start) % 1000), level);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}
