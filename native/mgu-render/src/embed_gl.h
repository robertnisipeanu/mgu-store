/*
 * Embed mode's GL side: a frame for one of embed.c's buffers is drawn either straight into that buffer (zero-copy:
 * a dmabuf the HMI's compositor samples, with an FBO of its own) or into an offscreen FBO and read back into the
 * buffer's shared memory (readback). Frames are drawn top-down (GFX_TOP_DOWN), as the compositor reads its buffers.
 */
#ifndef MGU_EMBED_GL_H
#define MGU_EMBED_GL_H
#include <stddef.h>
#include <stdint.h>
#include <EGL/egl.h>

/* the context to draw with (current), made current by each call below; pbo: read back through a pixel buffer
   (GLES 3) */
void embed_gl_init(EGLDisplay d, EGLSurface s, EGLContext ctx, int pbo, int finish);
/* n dmabufs of w x h XRGB8888 (linear), each with an FBO: their fds and strides (kept open, owned here, made once
   and kept for later connections of that size; another size, the other page template's, makes them again); 0, or
   -1 with the reason in why */
int embed_gl_buffers(int n, int w, int h, int fd[], uint32_t stride[], char *why, size_t len);
/* binds the target for a frame: dmabuf gpu (0..n-1), or the readback FBO (gpu < 0); returns gfx_draw's flags */
int embed_gl_begin(int gpu, int w, int h);
/* the frame is drawn: a dmabuf is finished (the compositor may sample it once committed); a readback either reads
   it into px (w*4 bytes a row) now or, with a pixel buffer, starts reading and leaves px to embed_gl_resolve */
void embed_gl_end(int gpu, uint8_t *px, int w, int h);
/* a picture made on the CPU (opaque RGBA, pw x ph, rows top-down) into dmabuf gpu (w x h): scaled by GL to the
   nearest pixel into img (x, y, w, h), black around it; 0, or -1 */
int embed_gl_picture(int gpu, const uint8_t *rgba, int pw, int ph, const int img[4], int w, int h);
void embed_gl_resolve(void);                /* a started readback into its px: before that buffer is committed */
void embed_gl_cancel(void);                 /* a started readback's frame is not to be shown */
const char *embed_gl_readback_mode(void);   /* how a readback reads, for the log */

#endif
