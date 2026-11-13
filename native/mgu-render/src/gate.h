/*
 * The foreground gate (js/foreground_gate.js): a child process that reads the HMI and reports the uids of
 * the apps whose screens are in front, as "foreground [uid ...]" lines on its fd 3, and those of them the HMI
 * covers with something that takes the input (a popup, its menu, a screen opened from there), as "covered [uid ...]".
 */
#ifndef MGU_GATE_H
#define MGU_GATE_H
#include <stdint.h>

int gate_start(const char *command);   /* 0, or -1 */
int gate_fd(void);                     /* its reports (poll it), -1 when none */
/* reads what came; returns 1 when the front set changed, -1 when the gate ended */
int gate_read(void);
int gate_reported(void);               /* a report has come (until then no app is in front) */
int gate_unavailable(void);            /* it said it cannot read the HMI on this unit ("unavailable") */
int gate_front(uint32_t uid);          /* uid is in front */
int gate_any_front(void);              /* some app is in front */
int gate_covered(uint32_t uid);        /* uid is in front with something of the HMI over it */
void gate_stop(void);

#endif
