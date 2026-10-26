/*
 * gfx.c - GPU executor for kit draw command lists (OpenGL ES 2).
 *
 * Every primitive becomes one quad (or a few) in a single vertex stream, drawn in command
 * order with one shader. The shader computes each pixel's coverage analytically (box,
 * rounded box, ring sector with round caps, capsule, convex quad, glyph alpha), so edges
 * are anti-aliased without multisampling and the result matches the kit's software canvas
 * (kit/runtime/canvas.js) closely. Output is premultiplied alpha.
 *
 * From mgu-renderd src/gfx.c (idrive7-apps kit/renderd, MIT, Copyright (c) 2026 cauliflowermossgrape),
 * with both forks' images: upstream's pixel images and IterioDev's pictures (ported with permission),
 * and mgu-render's pixmaps (images written in regions, INDEX8 with a palette).
 */
#include <GLES2/gl2.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "gfx.h"
#include "proto.h"

enum { K_BOX = 0, K_RRECT = 1, K_ARC = 3, K_LINE = 4, K_GLYPH = 5, K_TEX = 6, K_VCOL = 7, K_RAMPRECT = 8, K_QUAD = 9, K_IMG = 10 };

/* vertex: pos(2) kind(1) pad(1) | a(4) | b(4) | c(4) | d(4) | col(4) = 24 floats */
#define VF 24
typedef struct { float v[VF]; } vert;

static GLuint prog, vbo, ibo;
static GLint u_view, u_atlas, u_ramp, u_tex;
static GLuint atlas_tex, ramp_tex;
#define ATLAS_W 2048
#define ATLAS_H 4096
#define RAMP_W 256
#define RAMP_H 256
static int atlas_shelf_x[2], atlas_shelf_y[2];          /* two 1024-wide columns, filled top-down */
static int ramp_rows;
static char err[256];

static vert *vb; static size_t nv, cap;                  /* current batch */
static GLuint cur_tex;                                   /* layer texture bound for K_TEX quads */
static int fb_w, fb_h;
static float g_alpha = 1;

const char *gfx_error(void) { return err; }

static const char *VS =
    "attribute vec4 a_pos; attribute vec4 a_a; attribute vec4 a_b; attribute vec4 a_c; attribute vec4 a_d; attribute vec4 a_col;\n"
    "uniform vec2 u_view;\n"
    "varying vec2 v_p; varying float v_kind; varying vec4 v_a; varying vec4 v_b; varying vec4 v_c; varying vec4 v_d; varying vec4 v_col;\n"
    "void main() {\n"
    "  v_p = a_pos.xy; v_kind = a_pos.z; v_a = a_a; v_b = a_b; v_c = a_c; v_d = a_d; v_col = a_col;\n"
    "  gl_Position = vec4(a_pos.x / u_view.x * 2.0 - 1.0, 1.0 - a_pos.y / u_view.y * 2.0, 0.0, 1.0);\n"
    "}\n";

static const char *FS =
    "precision highp float;\n"
    "varying vec2 v_p; varying float v_kind; varying vec4 v_a; varying vec4 v_b; varying vec4 v_c; varying vec4 v_d; varying vec4 v_col;\n"
    "uniform sampler2D u_atlas; uniform sampler2D u_ramp; uniform sampler2D u_tex;\n"
    "const float PI = 3.14159265358979;\n"
    /* exact overlap of the pixel square around p with the box a.xy..a.zw */
    "float boxcov(vec2 p, vec4 r) { vec2 o = clamp(min(p + 0.5, r.zw) - max(p - 0.5, r.xy), 0.0, 1.0); return o.x * o.y; }\n"
    "float rrdist(vec2 p, vec4 a, float r) { vec2 q = abs(p - a.xy) - (a.zw - r); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }\n"
    "vec4 rampcol(float row, float t) { return texture2D(u_ramp, vec2((clamp(t, 0.0, 1.0) * 255.0 + 0.5) / 256.0, (row + 0.5) / 256.0)); }\n"
    "void main() {\n"
    "  float k = v_kind; vec2 p = v_p; float cov = 1.0; vec4 col = v_col;\n"
    "  if (k < 0.5) { cov = boxcov(p, v_a); }\n"
    "  else if (k < 1.5) {\n"                                   /* rounded rect: a = centre, half size; b.x radius, b.y stroke (0 fill) */
    "    float d = rrdist(p, v_a, v_b.x);\n"
    "    cov = clamp(0.5 - d, 0.0, 1.0);\n"
    "    if (v_b.y > 0.0) cov *= clamp(d + v_b.y + 0.5, 0.0, 1.0);\n"
    "    if (v_b.z > 0.0) cov *= boxcov(p, v_c);\n"             /* card band: only this stop interval */
    "  }\n"
    "  else if (k < 3.5) {\n"                                   /* ring sector: a = cx cy r0 r1, b = mid half flags hw, c = caps, d = ramp row, from, span(signed), full */
    "    vec2 dv = p - v_a.xy; float dd = length(dv);\n"
    "    cov = clamp(v_a.w - dd + 0.5, 0.0, 1.0) * (v_a.z > 0.0 ? clamp(dd - v_a.z + 0.5, 0.0, 1.0) : 1.0);\n"
    "    float ang = atan(dv.x, -dv.y);\n"
    "    if (v_d.w < 0.5) {\n"
    "      float rel = ang - v_b.x;\n"
    "      rel = mod(rel + PI, 2.0 * PI) - PI;\n"
    "      float outside = (abs(rel) - v_b.y) * max(dd, 1.0);\n"
    "      float v = cov * clamp(0.5 - outside, 0.0, 1.0);\n"
    "      if (v_b.z > 0.5 && v < 1.0) {\n"
    "        v = max(v, clamp(v_b.w - length(p - v_c.xy) + 0.5, 0.0, 1.0));\n"
    "        v = max(v, clamp(v_b.w - length(p - v_c.zw) + 0.5, 0.0, 1.0));\n"
    "      }\n"
    "      cov = v;\n"
    "    }\n"
    "    if (v_d.x >= 0.0) {\n"
    "      float span = abs(v_d.z);\n"
    "      float da = (ang * 180.0 / PI - v_d.y) * (v_d.z < 0.0 ? -1.0 : 1.0);\n"
    "      da = mod(da, 360.0);\n"
    "      if (da > span + (360.0 - span) / 2.0) da -= 360.0;\n"
    "      vec4 rc = rampcol(v_d.x, da / span); col = vec4(rc.rgb, rc.a * v_col.a);\n"
    "    }\n"
    "  }\n"
    "  else if (k < 4.5) {\n"                                   /* capsule a = ends, b.x = half width */
    "    vec2 v = v_a.zw - v_a.xy; vec2 q = p - v_a.xy; float l2 = max(dot(v, v), 1e-6);\n"
    "    float t = clamp(dot(q, v) / l2, 0.0, 1.0);\n"
    "    cov = clamp(v_b.x - length(q - v * t) + 0.5, 0.0, 1.0);\n"
    "  }\n"
    "  else if (k < 5.5) { cov = texture2D(u_atlas, v_c.xy).a; }\n"
    "  else if (k < 6.5) { vec4 t = texture2D(u_tex, v_c.xy); gl_FragColor = t * v_col.a; return; }\n"
    "  else if (k < 7.5) { cov = 1.0; }\n"
    "  else if (k < 8.5) {\n"                                   /* ramp rect: a = centre/half, b = r, spanX, spanW, row */
    "    cov = clamp(0.5 - rrdist(p, v_a, v_b.x), 0.0, 1.0);\n"
    "    vec4 rc = rampcol(v_b.w, (p.x - v_b.y) / max(v_b.z, 1.0)); col = vec4(rc.rgb, rc.a * v_col.a);\n"
    "    if (v_c.z > 0.0) cov *= boxcov(p, v_d);\n"
    "  }\n"
    "  else if (k < 9.5) {\n"                                   /* convex quad: 4 edges (nx, ny, d), inside where n.p + d >= 0 */
    "    vec4 e = vec4(dot(v_a.xy, p) + v_a.z, dot(vec2(v_a.w, v_b.x), p) + v_b.y, dot(v_b.zw, p) + v_c.x, dot(v_c.yz, p) + v_c.w);\n"
    "    vec4 c4 = clamp(e + 0.5, 0.0, 1.0); cov = c4.x * c4.y * c4.z * c4.w;\n"
    "  }\n"
    "  else {\n"                                                /* picture: a = centre, half size; b.x radius; uv in c.xy (premultiplied) */
    "    float ic = clamp(0.5 - rrdist(p, v_a, v_b.x), 0.0, 1.0) * v_col.a;\n"
    "    if (ic <= 0.0) discard;\n"
    "    gl_FragColor = texture2D(u_tex, v_c.xy) * ic; return;\n"
    "  }\n"
    "  float a = col.a * cov;\n"
    "  if (a <= 0.0) discard;\n"
    "  gl_FragColor = vec4(col.rgb * a, a);\n"
    "}\n";

static GLuint shader(GLenum t, const char *src) {
    GLuint s = glCreateShader(t);
    glShaderSource(s, 1, &src, NULL);
    glCompileShader(s);
    GLint ok; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) { glGetShaderInfoLog(s, sizeof err, NULL, err); return 0; }
    return s;
}

int gfx_init(void) {
    GLuint vs = shader(GL_VERTEX_SHADER, VS), fs = shader(GL_FRAGMENT_SHADER, FS);
    if (!vs || !fs) return -1;
    prog = glCreateProgram();
    glAttachShader(prog, vs); glAttachShader(prog, fs);
    const char *names[] = { "a_pos", "a_a", "a_b", "a_c", "a_d", "a_col" };
    for (int i = 0; i < 6; i++) glBindAttribLocation(prog, i, names[i]);
    glLinkProgram(prog);
    GLint ok; glGetProgramiv(prog, GL_LINK_STATUS, &ok);
    if (!ok) { glGetProgramInfoLog(prog, sizeof err, NULL, err); return -1; }
    u_view = glGetUniformLocation(prog, "u_view");
    u_atlas = glGetUniformLocation(prog, "u_atlas");
    u_ramp = glGetUniformLocation(prog, "u_ramp");
    u_tex = glGetUniformLocation(prog, "u_tex");
    glGenBuffers(1, &vbo); glGenBuffers(1, &ibo);

    glGenTextures(1, &atlas_tex);
    glBindTexture(GL_TEXTURE_2D, atlas_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_ALPHA, ATLAS_W, ATLAS_H, 0, GL_ALPHA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glGenTextures(1, &ramp_tex);
    glBindTexture(GL_TEXTURE_2D, ramp_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, RAMP_W, RAMP_H, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    return glGetError() == GL_NO_ERROR ? 0 : -1;
}

/* ---------------- resources ---------------- */

int gfx_atlas(gfx_client *c, uint32_t id, int w, int h, const uint8_t *alpha) {
    for (int i = 0; i < c->natlas; i++) if (c->atlas[i].id == id) return 0;    /* already have it */
    if (c->natlas >= 64 || w > ATLAS_W / 2) { snprintf(err, sizeof err, "atlas %u: too many or too wide", id); return -1; }
    /* the shared atlas texture is first come, first served for all clients; an atlas with
       the same content key (id) from an earlier client is reused */
    static struct { uint32_t id; int x, y, w, h; } global[128];
    static int nglobal;
    for (int i = 0; i < nglobal; i++) if (global[i].id == id && global[i].w == w && global[i].h == h) {
        c->atlas[c->natlas].id = id; c->atlas[c->natlas].x = global[i].x; c->atlas[c->natlas].y = global[i].y;
        c->atlas[c->natlas].w = w; c->atlas[c->natlas].h = h; c->natlas++;
        return 0;
    }
    int col = atlas_shelf_y[0] <= atlas_shelf_y[1] ? 0 : 1;
    if (atlas_shelf_y[col] + h > ATLAS_H || nglobal >= 128) { snprintf(err, sizeof err, "glyph atlas texture full"); return -1; }
    int x = col * (ATLAS_W / 2), y = atlas_shelf_y[col];
    atlas_shelf_y[col] += h + 1;
    glBindTexture(GL_TEXTURE_2D, atlas_tex);
    glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, w, h, GL_ALPHA, GL_UNSIGNED_BYTE, alpha);
    global[nglobal].id = id; global[nglobal].x = x; global[nglobal].y = y; global[nglobal].w = w; global[nglobal].h = h; nglobal++;
    c->atlas[c->natlas].id = id; c->atlas[c->natlas].x = x; c->atlas[c->natlas].y = y;
    c->atlas[c->natlas].w = w; c->atlas[c->natlas].h = h; c->natlas++;
    (void)atlas_shelf_x;
    return 0;
}

int gfx_ramp(gfx_client *c, uint32_t id, int n, const uint32_t *cols) {
    int row = -1;
    for (int i = 0; i < c->nramp; i++) if (c->ramp[i].id == id) row = c->ramp[i].row;
    if (row < 0) {
        if (c->nramp >= 64) { snprintf(err, sizeof err, "too many ramps"); return -1; }
        row = ramp_rows++ % RAMP_H;                     /* rows wrap: old clients' ramps get reused */
        c->ramp[c->nramp].id = id; c->ramp[c->nramp].row = row; c->nramp++;
    }
    if (n < 1) return 0;
    uint8_t px[RAMP_W * 4];
    for (int i = 0; i < RAMP_W; i++) {
        float f = n == 1 ? 0 : (i / (float)(RAMP_W - 1)) * (n - 1);
        int a = (int)f; if (a > n - 2) a = n - 2; if (a < 0) a = 0;
        float t = n == 1 ? 0 : f - a;
        uint32_t c0 = cols[a], c1 = cols[n == 1 ? 0 : a + 1];
        for (int k = 0; k < 4; k++) {
            float v0 = (c0 >> (24 - 8 * k)) & 255, v1 = (c1 >> (24 - 8 * k)) & 255;
            px[i * 4 + k] = (uint8_t)lrintf(v0 + (v1 - v0) * t);
        }
    }
    glBindTexture(GL_TEXTURE_2D, ramp_tex);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, row, RAMP_W, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
    return 0;
}

static int ramp_row(gfx_client *c, uint32_t id) {
    for (int i = 0; i < c->nramp; i++) if (c->ramp[i].id == id) return c->ramp[i].row;
    return -1;
}

static gfx_layer *find_layer(gfx_client *c, uint32_t id) {
    for (gfx_layer *l = c->layers; l; l = l->next) if (l->id == id) return l;
    return NULL;
}

void gfx_layer_drop(gfx_client *c, uint32_t id) {
    for (gfx_layer **pp = &c->layers; *pp; pp = &(*pp)->next) {
        if ((*pp)->id == id) {
            gfx_layer *l = *pp; *pp = l->next;
            glDeleteTextures(1, &l->tex); glDeleteFramebuffers(1, &l->fbo); free(l);
            return;
        }
    }
}

static size_t images_all;                                /* picture bytes of all apps */

static gfx_image *find_image(gfx_client *c, uint32_t id) {
    for (gfx_image *m = c->images; m; m = m->next) if (m->id == id) return m;
    return NULL;
}

void gfx_image_drop(gfx_client *c, uint32_t id) {
    for (gfx_image **pp = &c->images; *pp; pp = &(*pp)->next) {
        if ((*pp)->id == id) {
            gfx_image *m = *pp; *pp = m->next;
            glDeleteTextures(1, &m->tex);
            c->nimage--; images_all -= m->bytes;
            if (m->kind == IMG_PICTURE) c->image_bytes -= m->bytes;
            free(m->index); free(m);
            return;
        }
    }
}

/* room for one more image of `bytes`; pictures also count against the per-app bytes */
static int image_room(gfx_client *c, uint32_t id, size_t bytes, int picture) {
    if (c->nimage >= GFX_IMG_MAX || (picture && c->image_bytes + bytes > GFX_IMG_BYTES)) {
        snprintf(err, sizeof err, "image %u: an app holds at most %d pictures / %u MB", id, GFX_IMG_MAX, GFX_IMG_BYTES >> 20);
        return -1;
    }
    if (images_all + bytes > GFX_IMG_ALL) { snprintf(err, sizeof err, "image %u: all apps' pictures use %u MB already", id, GFX_IMG_ALL >> 20); return -1; }
    return 0;
}

/* a new texture w x h from px (NULL: zero); the caller sets its filters */
static gfx_image *image_new(gfx_client *c, uint32_t id, int w, int h, int kind, const uint8_t *px) {
    gfx_image *m = calloc(1, sizeof *m);
    if (!m) { snprintf(err, sizeof err, "image %u: out of memory", id); return NULL; }
    m->id = id; m->w = w; m->h = h; m->bytes = (size_t)w * h * 4; m->kind = kind;
    for (int k = 0; k < 8 && glGetError() != GL_NO_ERROR; k++) {}    /* an older error must not fail this upload */
    glGenTextures(1, &m->tex);
    glBindTexture(GL_TEXTURE_2D, m->tex);
    uint8_t *zero = NULL;
    if (!px) px = zero = calloc(1, m->bytes);
    if (!px) { glDeleteTextures(1, &m->tex); free(m); snprintf(err, sizeof err, "image %u: out of memory", id); return NULL; }
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, px);
    free(zero);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    return m;
}

static int image_add(gfx_client *c, gfx_image *m) {
    if (glGetError() != GL_NO_ERROR) {
        glDeleteTextures(1, &m->tex); free(m->index); free(m);
        snprintf(err, sizeof err, "image: the GPU refused it (out of memory?)");
        return -1;
    }
    m->next = c->images; c->images = m;
    c->nimage++; images_all += m->bytes;
    if (m->kind == IMG_PICTURE) c->image_bytes += m->bytes;
    return 0;
}

int gfx_image_def(gfx_client *c, uint32_t id, int w, int h, const uint8_t *px) {
    gfx_image_drop(c, id);                               /* a replace: the old one's room counts as free (refused = gone) */
    if (w < 1 || h < 1 || w > GFX_IMG_SIDE || h > GFX_IMG_SIDE) { snprintf(err, sizeof err, "image %u: bad size %dx%d", id, w, h); return -1; }
    size_t bytes = (size_t)w * h * 4;
    if (image_room(c, id, bytes, 1) < 0) return -1;
    gfx_image *m = image_new(c, id, w, h, IMG_PICTURE, px);
    if (!m) return -1;
    /* power-of-two sides get mipmaps (a 256 px icon shown at 76 px stays clean); GLES2 allows none on others */
    int pot = !(w & (w - 1)) && !(h & (h - 1));
    if (pot) glGenerateMipmap(GL_TEXTURE_2D);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, pot ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    return image_add(c, m);
}

int gfx_image_upstream(gfx_client *c, uint32_t id, int w, int h, const uint8_t *rgba) {
    if (w < 1 || h < 1 || w > GFX_UPSTREAM_SIDE || h > GFX_UPSTREAM_SIDE) { snprintf(err, sizeof err, "image %u: bad size %dx%d", id, w, h); return -1; }
    gfx_image *m = find_image(c, id);
    if (m && m->kind == IMG_UPSTREAM && m->w == w && m->h == h) {   /* a game's next frame: overwrite */
        glBindTexture(GL_TEXTURE_2D, m->tex);
        glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
        return 0;
    }
    if (m) gfx_image_drop(c, id);
    if (image_room(c, id, (size_t)w * h * 4, 0) < 0) return -1;
    m = image_new(c, id, w, h, IMG_UPSTREAM, rgba);
    if (!m) return -1;
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    return image_add(c, m);
}

int gfx_pixmap_def(gfx_client *c, uint32_t id, int w, int h, int format, int linear) {
    gfx_image_drop(c, id);
    if (w < 1 || h < 1 || w > GFX_PIXMAP_SIDE || h > GFX_PIXMAP_SIDE) { snprintf(err, sizeof err, "pixmap %u: bad size %dx%d", id, w, h); return -1; }
    if (format != PIX_RGBA_PREMUL && format != PIX_RGBA_OPAQUE && format != PIX_INDEX8) { snprintf(err, sizeof err, "pixmap %u: bad format %d", id, format); return -1; }
    if (image_room(c, id, (size_t)w * h * 4, 0) < 0) return -1;
    gfx_image *m = image_new(c, id, w, h, IMG_PIXMAP, NULL);
    if (!m) return -1;
    m->format = format;
    if (format == PIX_INDEX8 && !(m->index = calloc(1, (size_t)w * h))) {
        glDeleteTextures(1, &m->tex); free(m); snprintf(err, sizeof err, "pixmap %u: out of memory", id); return -1;
    }
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, linear ? GL_LINEAR : GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, linear ? GL_LINEAR : GL_NEAREST);
    return image_add(c, m);
}

/* rect x,y,w,h of an INDEX8 pixmap from its indices and palette, uploaded */
static void index8_upload(gfx_image *m, int x, int y, int w, int h) {
    uint8_t *row = malloc((size_t)w * 4);
    if (!row) return;
    glBindTexture(GL_TEXTURE_2D, m->tex);
    for (int j = 0; j < h; j++) {
        const uint8_t *ix = m->index + (size_t)(y + j) * m->w + x;
        for (int i = 0; i < w; i++) {
            const uint8_t *pc = m->pal + ix[i] * 3;
            row[i * 4] = pc[0]; row[i * 4 + 1] = pc[1]; row[i * 4 + 2] = pc[2]; row[i * 4 + 3] = 255;
        }
        glTexSubImage2D(GL_TEXTURE_2D, 0, x, y + j, w, 1, GL_RGBA, GL_UNSIGNED_BYTE, row);
    }
    free(row);
}

/* region x,y,w,h of pixmap m from px (its format's bytes, rows packed); the region is inside m */
static int pixmap_rect(gfx_image *m, int x, int y, int w, int h, const uint8_t *px) {
    if (m->format == PIX_INDEX8) {
        for (int j = 0; j < h; j++) memcpy(m->index + (size_t)(y + j) * m->w + x, px + (size_t)j * w, (size_t)w);
        index8_upload(m, x, y, w, h);
        return 0;
    }
    glBindTexture(GL_TEXTURE_2D, m->tex);
    if (m->format == PIX_RGBA_OPAQUE) {
        size_t sz = (size_t)w * h * 4;
        uint8_t *o = malloc(sz);
        if (!o) return -2;
        memcpy(o, px, sz);
        for (size_t i = 3; i < sz; i += 4) o[i] = 255;
        glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, o);
        free(o);
    } else {
        glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, px);
    }
    return 0;
}

int gfx_pixmap_pixels(gfx_client *c, uint32_t id, const uint8_t *p, size_t len) {
    if (len < 4) return -1;
    uint32_t n; memcpy(&n, p, 4);
    if (n < 1 || n > GFX_PIXELS_RECTS || len < 4 + (size_t)n * 16) return -1;
    gfx_image *m = find_image(c, id);
    int bpp = m && m->format == PIX_INDEX8 ? 1 : 4;
    const uint8_t *rects = p + 4, *px = p + 4 + (size_t)n * 16;
    size_t need = 0;
    uint32_t r[GFX_PIXELS_RECTS][4];
    memcpy(r, rects, (size_t)n * 16);
    for (uint32_t k = 0; k < n; k++) {
        if (r[k][2] > GFX_PIXMAP_SIDE || r[k][3] > GFX_PIXMAP_SIDE) return -1;
        need += (size_t)r[k][2] * r[k][3] * bpp;
    }
    if (len - 4 - (size_t)n * 16 < need) return -1;
    if (!m || m->kind != IMG_PIXMAP) { snprintf(err, sizeof err, "pixels: no pixmap %u", id); return -2; }
    for (uint32_t k = 0; k < n; k++) {
        uint32_t x = r[k][0], y = r[k][1], w = r[k][2], h = r[k][3];
        if (x > (uint32_t)m->w || y > (uint32_t)m->h || w > (uint32_t)m->w - x || h > (uint32_t)m->h - y) {
            snprintf(err, sizeof err, "pixels: rect %u,%u %ux%u outside pixmap %u", x, y, w, h, id);
            return -2;
        }
        if (w && h && pixmap_rect(m, (int)x, (int)y, (int)w, (int)h, px) < 0) return -2;
        px += (size_t)w * h * bpp;
    }
    return 0;
}

int gfx_pixmap_write(gfx_client *c, uint32_t id, int x, int y, int w, int h, const uint8_t *px) {
    gfx_image *m = find_image(c, id);
    if (!m || m->kind != IMG_PIXMAP || x < 0 || y < 0 || w < 1 || h < 1 || w > m->w - x || h > m->h - y) {
        snprintf(err, sizeof err, "pixels: rect %d,%d %dx%d not in pixmap %u", x, y, w, h, id);
        return -1;
    }
    return pixmap_rect(m, x, y, w, h, px) < 0 ? -1 : 0;
}

int gfx_pixmap_palette(gfx_client *c, uint32_t id, const uint8_t *rgb) {
    gfx_image *m = find_image(c, id);
    if (!m || m->kind != IMG_PIXMAP || m->format != PIX_INDEX8) { snprintf(err, sizeof err, "palette: no INDEX8 pixmap %u", id); return -1; }
    memcpy(m->pal, rgb, 768);
    index8_upload(m, 0, 0, m->w, m->h);
    return 0;
}

void gfx_client_free(gfx_client *c) {
    while (c->layers) gfx_layer_drop(c, c->layers->id);
    while (c->images) gfx_image_drop(c, c->images->id);
    c->natlas = c->nramp = 0;
}

/* ---------------- batching ---------------- */

static vert *push4(void) {
    if (nv + 4 > cap) {
        cap = cap ? cap * 2 : 4096;
        vb = realloc(vb, cap * sizeof(vert));
    }
    vert *v = vb + nv; nv += 4;
    memset(v, 0, 4 * sizeof(vert));
    return v;
}

static void flush(void) {
    if (!nv) return;
    size_t nq = nv / 4;
    static GLushort *idx; static size_t idx_q;
    if (nq > idx_q) {
        /* 16-bit indices: draw in chunks of 16384 quads */
        idx_q = 16384;
        idx = realloc(idx, idx_q * 6 * sizeof(GLushort));
        for (size_t q = 0; q < idx_q; q++) {
            GLushort b = (GLushort)(q * 4);
            GLushort *o = idx + q * 6;
            o[0] = b; o[1] = b + 1; o[2] = b + 2; o[3] = b; o[4] = b + 2; o[5] = b + 3;
        }
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibo);
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, idx_q * 6 * sizeof(GLushort), idx, GL_STATIC_DRAW);
    }
    glUseProgram(prog);
    glUniform2f(u_view, (float)fb_w, (float)fb_h);
    glUniform1i(u_atlas, 0); glUniform1i(u_ramp, 1); glUniform1i(u_tex, 2);
    glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, atlas_tex);
    glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D, ramp_tex);
    glActiveTexture(GL_TEXTURE2); glBindTexture(GL_TEXTURE_2D, cur_tex);
    glActiveTexture(GL_TEXTURE0);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibo);
    for (size_t q0 = 0; q0 < nq; q0 += 16384) {
        size_t n = nq - q0 < 16384 ? nq - q0 : 16384;
        glBufferData(GL_ARRAY_BUFFER, n * 4 * sizeof(vert), vb + q0 * 4, GL_STREAM_DRAW);
        for (int i = 0; i < 6; i++) {
            glEnableVertexAttribArray(i);
            glVertexAttribPointer(i, 4, GL_FLOAT, GL_FALSE, sizeof(vert), (void *)(sizeof(float) * 4 * i));
        }
        glDrawElements(GL_TRIANGLES, (GLsizei)(n * 6), GL_UNSIGNED_SHORT, 0);
    }
    nv = 0;
}

static float unpackc(uint32_t c, int k) { return ((c >> (24 - 8 * k)) & 255) / 255.0f; }
static void setcol(vert *v, uint32_t c) {
    for (int i = 0; i < 4; i++) {
        v[i].v[20] = unpackc(c, 0); v[i].v[21] = unpackc(c, 1); v[i].v[22] = unpackc(c, 2);
        v[i].v[23] = unpackc(c, 3) * g_alpha;
    }
}
/* axis-aligned quad x0..x1, y0..y1 (device px) of kind k; per-vertex params set by the caller */
static vert *quad(float x0, float y0, float x1, float y1, int k) {
    vert *v = push4();
    float xs[4] = { x0, x1, x1, x0 }, ys[4] = { y0, y0, y1, y1 };
    for (int i = 0; i < 4; i++) { v[i].v[0] = xs[i]; v[i].v[1] = ys[i]; v[i].v[2] = (float)k; }
    return v;
}
static void set4(vert *v, int at, float a, float b, float c, float d) {
    for (int i = 0; i < 4; i++) { v[i].v[at] = a; v[i].v[at + 1] = b; v[i].v[at + 2] = c; v[i].v[at + 3] = d; }
}

/* ---------------- primitives (device px) ---------------- */

static void prim_box(float x, float y, float w, float h, uint32_t c) {
    if (w <= 0 || h <= 0) return;
    vert *v = quad(floorf(x) - 1, floorf(y) - 1, ceilf(x + w) + 1, ceilf(y + h) + 1, K_BOX);
    set4(v, 4, x, y, x + w, y + h);
    setcol(v, c);
}

static void prim_rrect(float x, float y, float w, float h, float r, float stroke, uint32_t c) {
    if (w <= 0 || h <= 0) return;
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    vert *v = quad(floorf(x) - 2, floorf(y) - 2, ceilf(x + w) + 2, ceilf(y + h) + 2, K_RRECT);
    set4(v, 4, x + w / 2, y + h / 2, w / 2, h / 2);
    set4(v, 8, r, stroke, 0, 0);
    setcol(v, c);
}

static void prim_line(float xa, float ya, float xb, float yb, float width, uint32_t c) {
    float hw = width / 2, dx = xb - xa, dy = yb - ya, len = sqrtf(dx * dx + dy * dy);
    float ux = len > 1e-4f ? dx / len : 1, uy = len > 1e-4f ? dy / len : 0;
    float e = hw + 1.5f;                       /* reach of the coverage ramp */
    float px = -uy * e, py = ux * e;           /* normal */
    vert *v = push4();
    float X[4] = { xa - ux * e + px, xb + ux * e + px, xb + ux * e - px, xa - ux * e - px };
    float Y[4] = { ya - uy * e + py, yb + uy * e + py, yb + uy * e - py, ya - uy * e - py };
    for (int i = 0; i < 4; i++) { v[i].v[0] = X[i]; v[i].v[1] = Y[i]; v[i].v[2] = K_LINE; }
    set4(v, 4, xa, ya, xb, yb);
    set4(v, 8, hw, 0, 0, 0);
    setcol(v, c);
}

static void prim_arc(float cx, float cy, float r0, float r1, float a0, float a1, uint32_t c, int flags, int row, float rf, float rt) {
    const float RAD = (float)M_PI / 180;
    if (a1 < a0) { float t = a0; a0 = a1; a1 = t; }
    int full = a1 - a0 >= 360;
    int round = (flags & 1) && !full;
    float rm = (r0 + r1) / 2, hw = (r1 - r0) / 2;
    float bx0 = cx - r1, bx1 = cx + r1, by0 = cy - r1, by1 = cy + r1;
    if (!full) {
        /* bounding box of the sector: its end points and any 90-degree extremes inside it */
        float xs[16], ys[16]; int n = 0;
        float ends[2] = { a0, a1 }, rr[2] = { r0, r1 };
        for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) {
            xs[n] = cx + sinf(ends[i] * RAD) * rr[j]; ys[n] = cy - cosf(ends[i] * RAD) * rr[j]; n++;
        }
        for (float k = ceilf(a0 / 90) * 90; k <= a1 && n < 16; k += 90) { xs[n] = cx + sinf(k * RAD) * r1; ys[n] = cy - cosf(k * RAD) * r1; n++; }
        float pad = round ? hw + 1 : 1;
        bx0 = bx1 = xs[0]; by0 = by1 = ys[0];
        for (int i = 1; i < n; i++) {
            if (xs[i] < bx0) bx0 = xs[i]; if (xs[i] > bx1) bx1 = xs[i];
            if (ys[i] < by0) by0 = ys[i]; if (ys[i] > by1) by1 = ys[i];
        }
        bx0 -= pad; bx1 += pad; by0 -= pad; by1 += pad;
    }
    vert *v = quad(floorf(bx0) - 1, floorf(by0) - 1, ceilf(bx1) + 1, ceilf(by1) + 1, K_ARC);
    float mid = (a0 + a1) / 2 * RAD, half = (a1 - a0) / 2 * RAD;
    set4(v, 4, cx, cy, r0, r1);
    set4(v, 8, mid, half, round ? 1 : 0, hw);
    set4(v, 12, cx + sinf(a0 * RAD) * rm, cy - cosf(a0 * RAD) * rm, cx + sinf(a1 * RAD) * rm, cy - cosf(a1 * RAD) * rm);
    float span = rt - rf;
    if (fabsf(span) < 1e-6f) span = 1e-6f;
    set4(v, 16, (flags & 2) ? (float)row : -1, rf, span, full ? 1 : 0);
    setcol(v, c);
}

/* convex quad with anti-aliased edges; points in either winding */
static void prim_quad(const float *P, uint32_t c) {
    float area = 0;
    for (int i = 0; i < 4; i++) { int j = (i + 1) & 3; area += P[i * 2] * P[j * 2 + 1] - P[j * 2] * P[i * 2 + 1]; }
    if (fabsf(area) < 1e-6f) return;
    float s = area > 0 ? 1 : -1;                /* y down: positive area = clockwise on screen */
    float E[12];
    for (int i = 0; i < 4; i++) {
        int j = (i + 1) & 3;
        float ex = P[j * 2] - P[i * 2], ey = P[j * 2 + 1] - P[i * 2 + 1], l = sqrtf(ex * ex + ey * ey);
        if (l < 1e-6f) { E[i * 3] = 0; E[i * 3 + 1] = 0; E[i * 3 + 2] = 1e3f; continue; }
        /* inward normal */
        float nx = -ey / l * s, ny = ex / l * s;
        E[i * 3] = nx; E[i * 3 + 1] = ny; E[i * 3 + 2] = -(nx * P[i * 2] + ny * P[i * 2 + 1]);
    }
    float x0 = P[0], x1 = P[0], y0 = P[1], y1 = P[1];
    for (int i = 1; i < 4; i++) {
        if (P[i * 2] < x0) x0 = P[i * 2]; if (P[i * 2] > x1) x1 = P[i * 2];
        if (P[i * 2 + 1] < y0) y0 = P[i * 2 + 1]; if (P[i * 2 + 1] > y1) y1 = P[i * 2 + 1];
    }
    vert *v = quad(floorf(x0) - 1, floorf(y0) - 1, ceilf(x1) + 1, ceilf(y1) + 1, K_QUAD);
    set4(v, 4, E[0], E[1], E[2], E[3]);
    set4(v, 8, E[4], E[5], E[6], E[7]);
    set4(v, 12, E[8], E[9], E[10], E[11]);
    setcol(v, c);
}

/* ---------------- command execution ---------------- */

#define F(i) (*(const float *)&cmd[(i)])
#define U(i) (cmd[(i)])

static void lerpcol(uint32_t a, uint32_t b, float t, float *out) {
    for (int k = 0; k < 4; k++) out[k] = unpackc(a, k) + (unpackc(b, k) - unpackc(a, k)) * t;
}

/* vertical gradient: stops (t, colour) at y + t * h; constant before the first and after the last
   stop, linear in between. One band quad per interval, colour per vertex (extrapolated linearly
   to the padded quad corners, so it is exact inside the band). rounded: clip each band to the
   whole rounded rect (card). */
static void band(float x, float y, float w, float h, float ya, float yb, const float *A, const float *B, int rounded, float r) {
    if (yb <= ya) return;
    vert *v;
    if (rounded) {
        v = quad(floorf(x) - 1, floorf(ya) - 1, ceilf(x + w) + 1, ceilf(yb) + 1, K_RRECT);
        set4(v, 4, x + w / 2, y + h / 2, w / 2, h / 2);
        set4(v, 8, r, 0, 1, 0);
        set4(v, 12, x - 2, ya, x + w + 2, yb);
    } else {
        v = quad(floorf(x) - 1, floorf(ya) - 1, ceilf(x + w) + 1, ceilf(yb) + 1, K_BOX);
        set4(v, 4, x, ya, x + w, yb);
    }
    for (int k = 0; k < 4; k++) {
        float t = (v[k].v[1] - ya) / (yb - ya);
        for (int j = 0; j < 4; j++) v[k].v[20 + j] = A[j] + (B[j] - A[j]) * t;
        v[k].v[23] *= g_alpha;
    }
}
static void bands(const uint32_t *cmd, int n, float x, float y, float w, float h, int rounded, float r) {
    if (n < 1 || w <= 0 || h <= 0) return;
    if (rounded) { if (r > w / 2) r = w / 2; if (r > h / 2) r = h / 2; }
    float A[4], B[4];
    float prev_y = y;
    lerpcol(U(1), U(1), 0, A);
    for (int i = 0; i < n; i++) {
        float t = F(i * 2); if (t < 0) t = 0; if (t > 1) t = 1;
        float yt = y + t * h;
        lerpcol(U(i * 2 + 1), U(i * 2 + 1), 0, B);
        if (i == 0) band(x, y, w, h, y, yt, B, B, rounded, r);          /* before the first stop */
        else band(x, y, w, h, prev_y, yt, A, B, rounded, r);
        memcpy(A, B, sizeof A);
        prev_y = yt > prev_y ? yt : prev_y;
    }
    band(x, y, w, h, prev_y, y + h, A, A, rounded, r);                    /* after the last stop */
}

static int glyph_atlas(gfx_client *c, uint32_t id, int *ax, int *ay) {
    for (int i = 0; i < c->natlas; i++) if (c->atlas[i].id == id) { *ax = c->atlas[i].x; *ay = c->atlas[i].y; return 1; }
    return 0;
}

static void run(gfx_client *c, const gfx_xf *xf, const uint32_t *cmd, size_t n, int depth);

static void draw_layer(gfx_client *c, uint32_t id, float lx, float ly, const gfx_xf *xf) {
    gfx_layer *l = find_layer(c, id);
    if (!l) return;
    flush();
    /* snap to whole device pixels: the layer was rendered at this scale, so it maps 1:1 */
    float x = roundf(lx * xf->s + xf->ox), y = roundf(ly * xf->s + xf->oy);
    cur_tex = l->tex;
    vert *v = quad(x, y, x + l->w, y + l->h, K_TEX);
    /* FBO textures are stored bottom-up */
    v[0].v[12] = 0; v[0].v[13] = 1; v[1].v[12] = 1; v[1].v[13] = 1;
    v[2].v[12] = 1; v[2].v[13] = 0; v[3].v[12] = 0; v[3].v[13] = 0;
    setcol(v, 0xffffffff);
    flush();
}

/* picture over the device rect, corner radius r; the quad reaches 1 px further for the anti-aliased edge (uv
   runs on past 0..1 there, clamped to the edge texel) */
static void draw_image(gfx_image *m, float x, float y, float w, float h, float r) {
    if (!(w > 0 && h > 0 && w < 65536 && h < 65536 && isfinite(x) && isfinite(y))) return;
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    if (!(r > 0)) r = 0;
    flush();
    cur_tex = m->tex;
    float x0 = floorf(x) - 1, y0 = floorf(y) - 1, x1 = ceilf(x + w) + 1, y1 = ceilf(y + h) + 1;
    vert *v = quad(x0, y0, x1, y1, K_IMG);
    set4(v, 4, x + w / 2, y + h / 2, w / 2, h / 2);
    set4(v, 8, r, 0, 0, 0);
    float u0 = (x0 - x) / w, u1 = (x1 - x) / w, v0 = (y0 - y) / h, v1 = (y1 - y) / h;
    v[0].v[12] = u0; v[0].v[13] = v0; v[1].v[12] = u1; v[1].v[13] = v0;
    v[2].v[12] = u1; v[2].v[13] = v1; v[3].v[12] = u0; v[3].v[13] = v1;
    setcol(v, 0xffffffff);
    flush();
}

/* upstream: pixel image into device rect x0,y0..x1,y1 (top row of the image at the top), nearest pixel */
static void draw_image_upstream(gfx_image *m, float x0, float y0, float x1, float y1) {
    flush();
    cur_tex = m->tex;
    vert *v = quad(roundf(x0), roundf(y0), roundf(x1), roundf(y1), K_TEX);
    v[0].v[12] = 0; v[0].v[13] = 0; v[1].v[12] = 1; v[1].v[13] = 0;
    v[2].v[12] = 1; v[2].v[13] = 1; v[3].v[12] = 0; v[3].v[13] = 1;
    setcol(v, 0xffffffff);
    flush();
}

static void run(gfx_client *c, const gfx_xf *xf0, const uint32_t *cmd, size_t n, int depth) {
    gfx_xf cur = *xf0;
    const gfx_xf *xf = &cur;
    float s = cur.s, ox = cur.ox, oy = cur.oy;
#define X(v) ((v) * s + ox)
#define Y(v) ((v) * s + oy)
#define L(v) ((v) * s)
#define NEED(k) do { if (i + (k) > n) return; } while (0)
    size_t i = 0;
    while (i < n) {
        uint32_t op = cmd[i++];
        switch (op) {
        case OP_CLEAR: {
            NEED(1);
            uint32_t col = U(i); i += 1;
            flush();
            float a = unpackc(col, 3);
            glClearColor(unpackc(col, 0) * a, unpackc(col, 1) * a, unpackc(col, 2) * a, a);
            glClear(GL_COLOR_BUFFER_BIT);
            break;
        }
        case OP_RECT: NEED(5); prim_box(X(F(i)), Y(F(i + 1)), L(F(i + 2)), L(F(i + 3)), U(i + 4)); i += 5; break;
        case OP_GRAD: case OP_CARD: {
            int card = op == OP_CARD;
            NEED(card ? 6 : 5);
            float x = F(i), y = F(i + 1), w = F(i + 2), h = F(i + 3), r = card ? F(i + 4) : 0;
            int k = (int)U(i + (card ? 5 : 4));
            i += card ? 6 : 5;
            if (k < 0 || k > 64) return;
            NEED((size_t)k * 2);
            bands(cmd + i, k, X(x), Y(y), L(w), L(h), card, L(r));
            i += (size_t)k * 2;
            break;
        }
        case OP_RRECT: NEED(6); prim_rrect(X(F(i)), Y(F(i + 1)), L(F(i + 2)), L(F(i + 3)), L(F(i + 4)), 0, U(i + 5)); i += 6; break;
        case OP_RSTROKE: NEED(7); prim_rrect(X(F(i)), Y(F(i + 1)), L(F(i + 2)), L(F(i + 3)), L(F(i + 4)), L(F(i + 5)), U(i + 6)); i += 7; break;
        case OP_RAMPRECT: {
            NEED(8);
            float x = X(F(i)), y = Y(F(i + 1)), w = L(F(i + 2)), h = L(F(i + 3)), r = L(F(i + 4));
            int row = ramp_row(c, U(i + 5));
            float sx = X(F(i + 6)), sw = L(F(i + 7));
            i += 8;
            if (row < 0 || w <= 0 || h <= 0) break;
            if (r > w / 2) r = w / 2; if (r > h / 2) r = h / 2;
            vert *v = quad(floorf(x) - 1, floorf(y) - 1, ceilf(x + w) + 1, ceilf(y + h) + 1, K_RAMPRECT);
            set4(v, 4, x + w / 2, y + h / 2, w / 2, h / 2);
            set4(v, 8, r, sx, sw, (float)row);
            setcol(v, 0xffffffff);
            break;
        }
        case OP_ARC: {
            NEED(11);
            uint32_t flags = U(i + 7);
            int row = (flags & 2) ? ramp_row(c, U(i + 8)) : -1;
            if (row < 0) flags &= ~2u;
            prim_arc(X(F(i)), Y(F(i + 1)), L(F(i + 2)), L(F(i + 3)), F(i + 4), F(i + 5), U(i + 6), (int)flags, row, F(i + 9), F(i + 10));
            i += 11;
            break;
        }
        case OP_LINE: NEED(6); prim_line(X(F(i)), Y(F(i + 1)), X(F(i + 2)), Y(F(i + 3)), L(F(i + 4)), U(i + 5)); i += 6; break;
        case OP_QUAD: {
            NEED(9);
            float P[8];
            for (int k = 0; k < 4; k++) { P[k * 2] = X(F(i + k * 2)); P[k * 2 + 1] = Y(F(i + k * 2 + 1)); }
            prim_quad(P, U(i + 8));
            i += 9;
            break;
        }
        case OP_TRIS: {
            NEED(1);
            uint32_t k = U(i++);
            if (k > 100000) return;
            NEED((size_t)k * 9);
            for (uint32_t t = 0; t < k; t++) {
                /* a triangle as a degenerate quad (last vertex repeated) */
                vert *v = push4();
                for (int j = 0; j < 4; j++) {
                    int src = j < 3 ? j : 2;
                    const uint32_t *p = cmd + i + t * 9 + src * 3;
                    v[j].v[0] = X(*(const float *)&p[0]); v[j].v[1] = Y(*(const float *)&p[1]); v[j].v[2] = K_VCOL;
                    for (int q = 0; q < 4; q++) v[j].v[20 + q] = unpackc(p[2], q);
                    v[j].v[23] *= g_alpha;
                }
            }
            i += (size_t)k * 9;
            break;
        }
        case OP_GLYPHS: {
            NEED(3);
            uint32_t aid = U(i), col = U(i + 1), k = U(i + 2);
            i += 3;
            if (k > 100000) return;
            NEED((size_t)k * 8);
            int ax, ay;
            if (!glyph_atlas(c, aid, &ax, &ay)) { i += (size_t)k * 8; break; }
            for (uint32_t g = 0; g < k; g++) {
                const uint32_t *p = cmd + i + g * 8;
                float gx = X(*(const float *)&p[0]), gy = Y(*(const float *)&p[1]);
                float gw = L(*(const float *)&p[2]), gh = L(*(const float *)&p[3]);
                float u0 = (ax + *(const float *)&p[4]) / ATLAS_W, v0 = (ay + *(const float *)&p[5]) / ATLAS_H;
                float u1 = (ax + *(const float *)&p[6]) / ATLAS_W, v1 = (ay + *(const float *)&p[7]) / ATLAS_H;
                vert *v = quad(gx, gy, gx + gw, gy + gh, K_GLYPH);
                v[0].v[12] = u0; v[0].v[13] = v0; v[1].v[12] = u1; v[1].v[13] = v0;
                v[2].v[12] = u1; v[2].v[13] = v1; v[3].v[12] = u0; v[3].v[13] = v1;
                setcol(v, col);
            }
            i += (size_t)k * 8;
            break;
        }
        case OP_LAYER: NEED(3); if (depth == 0) draw_layer(c, U(i), F(i + 1), F(i + 2), xf); i += 3; break;
        case OP_IMAGE: {
            NEED(6);
            if (c->upstream_ops) {
                gfx_image *m = find_image(c, U(i));
                if (m) draw_image_upstream(m, X(F(i + 2)), Y(F(i + 3)), X(F(i + 2) + F(i + 4)), Y(F(i + 3) + F(i + 5)));
            } else {
                gfx_image *m = find_image(c, U(i + 5));
                if (m) draw_image(m, X(F(i)), Y(F(i + 1)), L(F(i + 2)), L(F(i + 3)), L(F(i + 4)));
            }
            i += 6;
            break;
        }
        case OP_CLIP: {
            NEED(4);
            flush();
            float x = X(F(i)), y = Y(F(i + 1)), w = L(F(i + 2)), h = L(F(i + 3));
            i += 4;
            glEnable(GL_SCISSOR_TEST);
            int sx = (int)floorf(x), sy = (int)floorf(y), sw = (int)ceilf(x + w) - sx, sh = (int)ceilf(y + h) - sy;
            if (sw < 0) sw = 0; if (sh < 0) sh = 0;
            glScissor(sx, fb_h - (sy + sh), sw, sh);           /* GL: origin bottom-left */
            break;
        }
        case OP_NOCLIP: flush(); glDisable(GL_SCISSOR_TEST); break;
        case OP_XF: {
            NEED(3);
            float ns = F(i), nx = F(i + 1), ny = F(i + 2);
            i += 3;
            if (ns > 0 && ns < 64 && isfinite(nx) && isfinite(ny)) { cur.s = ns; cur.ox = nx; cur.oy = ny; }
            else cur = *xf0;
            s = cur.s; ox = cur.ox; oy = cur.oy;
            break;
        }
        case OP_ALPHA: NEED(1); g_alpha = F(i); if (!(g_alpha >= 0)) g_alpha = 0; if (g_alpha > 1) g_alpha = 1; i += 1; break;
        default:
            return;                                             /* unknown op: stop rather than misread */
        }
    }
#undef X
#undef Y
#undef L
#undef NEED
}

void gfx_draw(gfx_client *c, const gfx_xf *xf, int fbw, int fbh, const uint32_t *cmd, size_t n, int clear_transparent) {
    fb_w = fbw; fb_h = fbh; g_alpha = 1;
    glViewport(0, 0, fbw, fbh);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_DEPTH_TEST);
    glEnable(GL_BLEND);
    glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    if (clear_transparent) { glClearColor(0, 0, 0, 0); glClear(GL_COLOR_BUFFER_BIT); }
    nv = 0;
    run(c, xf, cmd, n, 0);
    flush();
    glDisable(GL_SCISSOR_TEST);
}

int gfx_layer_def(gfx_client *c, uint32_t id, float w, float h, float scale, const uint32_t *cmd, size_t n) {
    gfx_layer_drop(c, id);
    int pw = (int)ceilf(w * scale), ph = (int)ceilf(h * scale);
    if (pw < 1 || ph < 1 || pw > 4096 || ph > 4096) { snprintf(err, sizeof err, "layer %u: bad size %dx%d", id, pw, ph); return -1; }
    gfx_layer *l = calloc(1, sizeof *l);
    l->id = id; l->w = pw; l->h = ph;
    glGenTextures(1, &l->tex);
    glBindTexture(GL_TEXTURE_2D, l->tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, pw, ph, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glGenFramebuffers(1, &l->fbo);
    GLint prev; glGetIntegerv(GL_FRAMEBUFFER_BINDING, &prev);
    glBindFramebuffer(GL_FRAMEBUFFER, l->fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, l->tex, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        glBindFramebuffer(GL_FRAMEBUFFER, prev);
        snprintf(err, sizeof err, "layer %u: framebuffer incomplete", id);
        glDeleteTextures(1, &l->tex); glDeleteFramebuffers(1, &l->fbo); free(l);
        return -1;
    }
    /* drawn the right way up in GL terms; draw_layer flips it back */
    gfx_xf lx = { scale, 0, 0 };
    int save_w = fb_w, save_h = fb_h;
    fb_w = pw; fb_h = ph; g_alpha = 1;
    glViewport(0, 0, pw, ph);
    glDisable(GL_SCISSOR_TEST);
    glEnable(GL_BLEND);
    glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    glClearColor(0, 0, 0, 0); glClear(GL_COLOR_BUFFER_BIT);
    nv = 0;
    run(c, &lx, cmd, n, 1);
    flush();
    fb_w = save_w; fb_h = save_h;
    glBindFramebuffer(GL_FRAMEBUFFER, prev);
    l->next = c->layers; c->layers = l;
    return 0;
}
