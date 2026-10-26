#!/usr/bin/env python3
"""Bakes the glyph atlases the Store draws its renderer screens with
(src/font_regular.js, src/font_semibold.js) from Inter, SIL Open Font
License 1.1 (src/LICENSE-Inter.txt). The renderer has no font rasteriser:
an app uploads each atlas once (8-bit alpha) and draws text as glyph quads.

    python3 tools/bake_fonts.py <folder with Inter-Regular.ttf and Inter-SemiBold.ttf>

Inter 4.1 (https://github.com/rsms/inter/releases, extras/ttf/). Needs Pillow.
Each module: { family, sizes: [{ size, ascent, descent, atlasW, atlasH,
alpha: base64(zlib(alpha bytes)), glyphs: { code: [x, y, w, h, ox, oy, adv] } }] },
ox/oy the bitmap's offset from the pen position on the baseline.
"""
import base64, json, os, sys, zlib
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'src')
TEXT = ''.join(chr(c) for c in range(32, 127)) + '·…→–—°×'
# Sizes in device px, a 4:3 step (the kit picks the smallest at least the
# size asked and scales it down): the screens' regular text is 26 to 48
# design px, their semibold 30 to 120, shown at 0.65 (iDrive 7) to 1.01
# (iDrive 8). Each atlas is at most 1024 px wide (mgu-render's limit), and
# all apps share the renderer's glyph texture: no size more than needed.
FACES = {'regular': ('Inter-Regular.ttf', [17, 23, 31, 41, 50]),
         'semibold': ('Inter-SemiBold.ttf', [19, 25, 33, 44, 58, 77, 103])}
PAD = 1


def bake(path, size):
    f = ImageFont.truetype(path, size)
    ascent, descent = f.getmetrics()
    glyphs, boxes = {}, []
    for ch in TEXT:
        l, t, r, b = f.getbbox(ch, anchor='ls')
        boxes.append((ch, l, t, max(0, r - l), max(0, b - t), f.getlength(ch)))
    width = 512 if size <= 24 else 1024
    x = y = PAD
    row = 0
    placed = []
    for ch, l, t, w, h, adv in boxes:
        if x + w + PAD > width:
            x, y, row = PAD, y + row + PAD, 0
        placed.append((ch, x, y, l, t, w, h, adv))
        x += w + PAD
        row = max(row, h)
    height = y + row + PAD
    img = Image.new('L', (width, height), 0)
    d = ImageDraw.Draw(img)
    for ch, gx, gy, l, t, w, h, adv in placed:
        if w and h:
            d.text((gx - l, gy - t), ch, font=f, fill=255, anchor='ls')
        glyphs[str(ord(ch))] = [gx, gy, w, h, l, t, round(adv, 3)]
    return {'size': size, 'ascent': ascent, 'descent': descent, 'atlasW': width, 'atlasH': height,
            'alpha': base64.b64encode(zlib.compress(img.tobytes(), 9)).decode('ascii'), 'glyphs': glyphs}


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    for name, (file, sizes) in FACES.items():
        path = os.path.join(sys.argv[1], file)
        fam = {'family': 'Inter ' + name, 'sizes': [bake(path, s) for s in sizes]}
        out = os.path.join(SRC, 'font_%s.js' % name)
        with open(out, 'w') as o:
            o.write('/* Inter %s glyph atlases, baked by tools/bake_fonts.py from %s (Inter 4.1).\n'
                    ' * Copyright 2016 The Inter Project Authors. SIL Open Font License 1.1: src/LICENSE-Inter.txt */\n'
                    "'use strict';\nmodule.exports = %s;\n" % (name, file, json.dumps(fam, separators=(',', ':'))))
        print('%s: %d bytes' % (os.path.relpath(out), os.path.getsize(out)))


if __name__ == '__main__':
    main()
