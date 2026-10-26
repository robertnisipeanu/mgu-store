/*
 * Embed mode's display: the HMI's embedded compositor (HmiMain3D, wayland-1). The page template
 * (js/hmi_template.js) draws ivi surface `id` inside an app's page, stretched over its box; the
 * renderer draws the shown app there through wl_shm buffers of the box's size. The surface exists
 * only while an app is shown, so another app's page with the template shows nothing of ours.
 */
#ifndef MGU_EMBED_H
#define MGU_EMBED_H
#include <poll.h>
#include <stdint.h>

/* starts connecting (0), or -1 when the compositor is not there; embed_changed follows when it is ready */
int embed_connect(const char *display, uint32_t id, int w, int h);
int embed_connected(void);           /* set up and usable */
void embed_disconnect(void);
void embed_show(int on);             /* create / destroy the surface */
int embed_visible(void);
/* a buffer to write the next frame into (XRGB8888, stride w*4), or NULL while the compositor
   holds them all or a frame callback is outstanding */
uint8_t *embed_buffer(void);
void embed_commit(void);             /* show the buffer embed_buffer gave; embed_frame_done follows */
/* event loop: prepare fills one pollfd (fd -1 when not connected); dispatch returns -1 when lost */
void embed_prepare(struct pollfd *pfd);
int embed_dispatch(const struct pollfd *pfd);

/* provided by main.c */
void embed_frame_done(void);         /* the frame committed last is on screen */
void embed_changed(void);            /* embed became usable, or stopped being */

#endif
