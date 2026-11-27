#include "pages.h"

#include <stdio.h>
#include <string.h>

void pages_parse(const char *text, uint32_t id, const int box[4], struct page pages[2])
{
    memset(pages, 0, 2 * sizeof *pages);
    for (const char *p = text; p && *p;) {
        const char *end = strchr(p, '\n');
        char line[160], name[16];
        size_t n = end ? (size_t)(end - p) : strlen(p);
        if (n < sizeof line) {
            memcpy(line, p, n);
            line[n] = 0;
            unsigned sid;
            int b[4], k = -1;
            char extra;
            if (sscanf(line, "%15s %x %d %d %d %d %c", name, &sid, &b[0], &b[1], &b[2], &b[3], &extra) == 6 &&
                b[0] >= 0 && b[1] >= 0 && b[2] > 0 && b[3] > 0) {
                if (!strcmp(name, "content")) k = PAGE_BOX;
                else if (!strcmp(name, "full")) k = PAGE_FULL;
            }
            if (k >= 0) { pages[k].on = 1; pages[k].id = sid; memcpy(pages[k].box, b, sizeof b); }
        }
        p = end ? end + 1 : NULL;
    }
    if (!pages[PAGE_BOX].on) {
        pages[PAGE_BOX].on = 1;
        pages[PAGE_BOX].id = id;
        memcpy(pages[PAGE_BOX].box, box, sizeof pages[PAGE_BOX].box);
    }
    if (pages[PAGE_FULL].on && pages[PAGE_FULL].id == pages[PAGE_BOX].id) pages[PAGE_FULL].on = 0;
}
