/* Which protocol dialect a connection speaks (proto.h). No GL, no display: host-testable. */
#ifndef MGU_DIALECT_H
#define MGU_DIALECT_H
#include <stddef.h>
#include <stdint.h>

/* The dialect a legacy message shows by its type and shape, or DIALECT_UNKNOWN when both legacy
 * dialects send it alike (messages 1-8) or it fits neither. Only messages 9, 10 and 11 differ:
 *   9:  upstream IMAGE (u32 id, w, h with 1 <= w, h <= 4096, then at least w*h*4 bytes) - else
 *       iterio CLAIM (u32 n <= 16, then n rects). An upstream image's w and h, read as a claim's
 *       first x and y, are float bit patterns below 1e-38: no claim has those, so the image wins.
 *   10: upstream GRAB is 4 bytes; iterio IMAGE is 12 + w*h*4 bytes.
 *   11: iterio DROP_IMAGE (upstream has no 11). */
int dialect_of(uint32_t type, const uint8_t *p, uint32_t len);

/* HELLO: copies the app id (up to the first NUL, printable ASCII, others '?') into app, and returns
 * the native version the client asks for ("proto=mgu-render/<n>" among the NUL-separated fields
 * after it), or 0 for a legacy HELLO. */
int hello_parse(const uint8_t *p, uint32_t len, char *app, size_t appsz);

const char *dialect_name(int d);

#endif
