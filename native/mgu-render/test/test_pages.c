/* pages.c: the marker's lines, and the page box's from the conf when it names none */
#include <stdio.h>
#include <string.h>

#include "pages.h"

static int fails, pass;
#define CHECK(cond, what) do { if (cond) { pass++; printf("ok   %s\n", what); } else { fails++; printf("FAIL %s\n", what); } } while (0)

static int is(const struct page *p, int on, uint32_t id, int x, int y, int w, int h)
{
    return p->on == on && (!on || (p->id == id && p->box[0] == x && p->box[1] == y && p->box[2] == w && p->box[3] == h));
}

int main(void)
{
    static const int conf[4] = { 104, 88, 1796, 632 };
    struct page pg[2];
    pages_parse("content 0x500 104 88 1796 632\nfull 0x501 0 0 1920 720\n", 0x500, conf, pg);
    CHECK(is(&pg[PAGE_BOX], 1, 0x500, 104, 88, 1796, 632) && is(&pg[PAGE_FULL], 1, 0x501, 0, 0, 1920, 720),
          "both templates: each one's surface and box");
    pages_parse("content 0x510 100 90 1700 600\n", 0x500, conf, pg);
    CHECK(is(&pg[PAGE_BOX], 1, 0x510, 100, 90, 1700, 600) && is(&pg[PAGE_FULL], 0, 0, 0, 0, 0, 0),
          "the page template alone: its box from the marker, not the conf; no whole screen");
    pages_parse("", 0x500, conf, pg);
    CHECK(is(&pg[PAGE_BOX], 1, 0x500, 104, 88, 1796, 632) && !pg[PAGE_FULL].on,
          "an empty marker (an older mgu-render-hmi.sh): the page box from the conf");
    pages_parse(NULL, 0x500, conf, pg);
    CHECK(is(&pg[PAGE_BOX], 1, 0x500, 104, 88, 1796, 632) && !pg[PAGE_FULL].on, "no marker text: the same");
    pages_parse("full 0x501 0 0 1920 720", 0x500, conf, pg);
    CHECK(is(&pg[PAGE_BOX], 1, 0x500, 104, 88, 1796, 632) && is(&pg[PAGE_FULL], 1, 0x501, 0, 0, 1920, 720),
          "the whole screen without a newline at the end, the page box from the conf");
    pages_parse("full 0x501 0 0 0 720\nother 0x502 0 0 10 10\ncontent 0x500 1 2 3\nfull 0x501 0 0 1920 720 x\n",
                0x500, conf, pg);
    CHECK(is(&pg[PAGE_BOX], 1, 0x500, 104, 88, 1796, 632) && !pg[PAGE_FULL].on,
          "lines with no size, another name, too few or too many fields are left out");
    pages_parse("content 0x500 104 88 1796 632\nfull 0x500 0 0 1920 720\n", 0x500, conf, pg);
    CHECK(!pg[PAGE_FULL].on, "a whole-screen template on the page box's surface is left out");
    printf("test_pages: %d checks pass\n", pass);
    return fails != 0;
}
