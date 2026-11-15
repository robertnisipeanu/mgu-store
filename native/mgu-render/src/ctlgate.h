/*
 * The controller gate's file (upstream's mgu-inputgate.so reads it): fresh while an app holds the controller. Its
 * words name the parts held (HOLD_* in proto.h: "knob press"); empty holds all three, which is all any other
 * renderer writes, and all a gate without the marker "mgu-inputgate-hold:" reads.
 */
#ifndef MGU_CTLGATE_H
#define MGU_CTLGATE_H
#include <stdint.h>

/* the file naming hold (all three: empty), fresh: 0, or -1 when the file can't be written */
int ctlgate_write(const char *path, uint32_t hold);
/* words left in the file emptied, its age kept: 1 when there were some */
int ctlgate_clear(const char *path);
/* a controller event (FrontCCU's: [1..2] knob, [3] press, [4] tilt) after prev moves a part of hold */
int ctlgate_moves(const uint8_t *prev, const uint8_t *ev, uint32_t hold);

#endif
