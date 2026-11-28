/*
 * Embed mode's display: the HMI's embedded compositor (HmiMain3D, wayland-1). The page template
 * (js/hmi_template.js) draws ivi surface `id` inside an app's page, stretched over its box; the
 * renderer draws the shown app there through buffers of the box's size. The surface exists
 * only while an app is shown, so another app's page with the template shows nothing of ours.
 *
 * Two kinds of buffer, both XRGB8888 rows top-down, one kind per connection (the compositor shows a GPU buffer with
 * red and blue swapped once the surface id has shown a shared-memory one in that HMI run):
 * - GPU buffers (zero-copy): dmabufs GL draws into (embed_gl.c), given to the compositor with wl_drm's
 *   create_prime_buffer. Made when the compositor offers wl_drm with PRIME and XRGB8888, and the renderer's
 *   own GL can draw into dmabufs; the compositor accepting them completes the setup.
 * - shared-memory buffers (wl_shm): written on the CPU, without GPU buffers (GL frames read back,
 *   display-bridge's pixel apps' frames).
 */
#ifndef MGU_EMBED_H
#define MGU_EMBED_H
#include <poll.h>
#include <stdint.h>

/* from now on read back (GPU buffers failed: why), at once: a new connection with shared-memory buffers only */
void embed_readback(const char *why);
/* starts connecting (0), or -1 when the compositor is not there; embed_changed follows when it is ready.
   zero_copy: make GPU buffers when the compositor takes them */
int embed_connect(const char *display, uint32_t id, int w, int h, int zero_copy);
int embed_connected(void);           /* set up and usable */
/* the connection's surface id and buffer size: 1 while connected or connecting, else 0 */
int embed_target(uint32_t *id, int *w, int *h);
int embed_connecting(void);          /* waiting for the compositor's first answer */
int embed_zero_copy(void);           /* connected with GPU buffers */
const char *embed_path(void);        /* "zero-copy", or "readback (<why>)" once connected */
void embed_disconnect(void);
void embed_show(int on);             /* create / destroy the surface */
int embed_visible(void);
/* A frame is drawn as soon as it comes and committed at the compositor's next frame callback:
   embed_buffer gives a buffer to draw it into - of the kind asked for (gpu: a GPU buffer), the drawn one
   not committed yet when it is of that kind (drawn over), else a free one; -1 while the compositor holds them all -
   and embed_filled marks it drawn. embed_commit shows the drawn one once no frame callback is outstanding
   (embed_can_commit); embed_frame_done follows. */
int embed_buffer(int gpu);
uint8_t *embed_pixels(int b);        /* a shared-memory buffer's pixels (stride w*4), NULL for a GPU buffer */
int embed_gpu_index(int b);          /* a GPU buffer's index for embed_gl, -1 for a shared-memory one */
void embed_filled(void);
int embed_can_commit(void);
int embed_ready(void);               /* the drawn buffer not committed yet, or -1 */
void embed_commit(void);
void embed_discard(void);            /* the drawn frame is not to be shown (another app has the box) */
int embed_waiting(void);             /* a frame callback is outstanding */
/* the compositor's frame callbacks since the last call: their count and the time from commit to callback (us) */
void embed_callbacks(unsigned *n, unsigned *avg_us, unsigned *max_us);
/* event loop: prepare fills one pollfd (fd -1 when not connected); dispatch returns -1 when lost */
void embed_prepare(struct pollfd *pfd);
int embed_dispatch(const struct pollfd *pfd);

/* provided by main.c */
void embed_frame_done(void);         /* the frame committed last is on screen */
void embed_changed(void);            /* embed became usable, or stopped being */

#endif
