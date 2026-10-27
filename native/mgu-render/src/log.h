#ifndef MGU_LOG_H
#define MGU_LOG_H

#include <stdint.h>

extern int log_verbose;

/* Monotonic milliseconds. */
int64_t now_ms(void);

void log_at(char level, const char *fmt, ...) __attribute__((format(printf, 2, 3)));

#define log_error(...) log_at('E', __VA_ARGS__)
#define log_warn(...)  log_at('W', __VA_ARGS__)
#define log_info(...)  log_at('I', __VA_ARGS__)
#define log_debug(...) do { if (log_verbose) log_at('D', __VA_ARGS__); } while (0)

#endif
