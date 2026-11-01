#ifndef MGU_TOUCH_H
#define MGU_TOUCH_H
/*
 * Touch routing (touch.c, from IterioDev's mgu-renderd): the centre display's touch PDUs (UDP 30567, the HMI's own input) are diverted here by one
 * nftables rule while an app has claimed screen areas (M_CLAIM). A gesture that starts in a visible app's claim
 * goes to that app (E_TOUCH) and the HMI never sees it; everything else is forwarded to the HMI unchanged.
 */

/* iface: where the display's PDUs arrive (the car: "vlan73", from saddr 160.48.199.115; "lo": a local sender, as in
 * the emulator); saddr may be empty. area x,y,w,h (screen px) apps may claim, w 0 = all. Forks the guard: call
 * before the compositor connection. -1 = off. */
int touch_init(const char *iface, const char *saddr, const int area[4]);
int touch_fd(void);                  /* the diverted PDUs (poll it), -1 when off */
void touch_read(void);               /* route what came in */
void touch_tick(int claimed);        /* every loop turn: claimed = a visible app has claims (2: an overlay) -> rule in or out */
void touch_forget(int slot);         /* that app is gone: the rest of its gesture is dropped */
void touch_stop(void);               /* rule out */

/* provided by main.c */
int touch_owner_at(int x, int y, int in_area);      /* the client slot claiming screen pixel x, y, or -1; outside
                                                       the area only an overlay's claim counts */
void touch_send(int slot, int phase, int x, int y); /* E_TOUCH to it (phase 1 down, 2 move, 3 up; screen px) */
void touch_outside(void);                           /* a gesture went to the HMI: the claiming apps close */

#endif
