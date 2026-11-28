/*
 * The page templates the HMI loaded, as mgu-render-hmi.sh's marker names them when it mounts them (a line each,
 * "<content|full> <surface id> <x> <y> <w> <h>", the generator's boxes file): the page box's template, which every
 * in-page app's page uses, and the whole screen's, which only an app's own page names. Each box is the one of the
 * template the HMI loaded, never a setting that could differ from it.
 */
#ifndef MGU_PAGES_H
#define MGU_PAGES_H
#include <stdint.h>

enum { PAGE_BOX = 0, PAGE_FULL = 1 };   /* = X_MODE's LAYOUT_PAGE, LAYOUT_FULL */

struct page { int on; uint32_t id; int box[4]; };

/* pages[PAGE_BOX] and pages[PAGE_FULL] from the marker's text; the page box's is id and box when the text names none
   (a marker of an older mgu-render-hmi.sh: the page template alone, made for the conf's id) */
void pages_parse(const char *text, uint32_t id, const int box[4], struct page pages[2]);

#endif
