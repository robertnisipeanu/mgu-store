#include "dialect.h"

#include <stdlib.h>
#include <string.h>

#include "proto.h"

static uint32_t word(const uint8_t *p, int i)
{
    uint32_t v;
    memcpy(&v, p + 4 * i, 4);
    return v;
}

int dialect_of(uint32_t type, const uint8_t *p, uint32_t len)
{
    switch (type) {
    case 9: {
        if (len >= 12) {
            uint64_t w = word(p, 1), h = word(p, 2);
            if (w >= 1 && h >= 1 && w <= 4096 && h <= 4096 && 12 + w * h * 4 <= len)
                return DIALECT_UPSTREAM;
        }
        if (len >= 4 && word(p, 0) <= 16 && len >= 4 + 16 * (uint64_t)word(p, 0))
            return DIALECT_ITERIO;
        return DIALECT_UNKNOWN;
    }
    case 10:
        if (len == 4)
            return DIALECT_UPSTREAM;
        if (len >= 12) {
            uint64_t w = word(p, 1), h = word(p, 2);
            if (len == 12 + w * h * 4)
                return DIALECT_ITERIO;
        }
        return DIALECT_UNKNOWN;
    case 11:
        return DIALECT_ITERIO;
    default:
        return DIALECT_UNKNOWN;
    }
}

int hello_parse(const uint8_t *p, uint32_t len, char *app, size_t appsz)
{
    size_t idlen = 0;
    while (idlen < len && p[idlen])
        idlen++;
    size_t n = idlen < appsz - 1 ? idlen : appsz - 1;
    for (size_t i = 0; i < n; i++)
        app[i] = p[i] >= 32 && p[i] <= 126 ? (char)p[i] : '?';
    app[n] = 0;
    int version = 0;
    const size_t tl = sizeof MGU_NATIVE_TOKEN - 1;
    for (size_t at = idlen + 1; at < len;) {
        size_t end = at;
        while (end < len && p[end])
            end++;
        if (end - at > tl && end - at < tl + 6 && !memcmp(p + at, MGU_NATIVE_TOKEN, tl)) {
            char num[8] = { 0 };
            memcpy(num, p + at + tl, end - at - tl);
            char *e;
            long v = strtol(num, &e, 10);
            if (*e == 0 && v > 0 && v < 1000)
                version = (int)v;
        }
        at = end + 1;
    }
    return version;
}

const char *dialect_name(int d)
{
    switch (d) {
    case DIALECT_UPSTREAM: return "upstream";
    case DIALECT_ITERIO: return "iterio";
    case DIALECT_NATIVE: return "native";
    default: return "undecided";
    }
}
