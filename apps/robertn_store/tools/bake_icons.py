#!/usr/bin/env python3
"""Bakes the glyph atlases the Store draws its icons with (src/font_icons.js)
from Lucide's icon font, ISC License (src/LICENSE-Lucide.txt),
the way tools/bake_fonts.py bakes Inter: an icon is one glyph, drawn at any
size and in any colour.

    python3 tools/bake_icons.py <folder with lucide.ttf and lucide.css>

lucide-static 1.72.0 (https://github.com/lucide-icons/lucide, font/).
Needs Pillow and fontTools. The module is a font module (tools/bake_fonts.py)
with icons: { the Store's icon name: its character's code }, and baseline:
the baseline's distance below the top of the icon's square, as a share of
its size.
"""
import json, os, re, sys
from fontTools.ttLib import TTFont
import bake_fonts

# the Store's icon names (src/kit_vicons.js) -> Lucide's
ICONS = {'grid': 'layout-grid', 'check': 'check', 'arrowDown': 'download', 'clock': 'clock', 'back': 'chevron-left',
         'chevron': 'chevron-right', 'plus': 'plus', 'trash': 'trash-2', 'lock': 'lock', 'unlock': 'lock-open', 'warning': 'triangle-alert',
         'gear': 'settings', 'usb': 'usb', 'refresh': 'refresh-cw', 'gauge': 'gauge', 'stopwatch': 'timer', 'camera': 'camera',
         'tether': 'globe', 'wifi': 'wifi', 'phone': 'smartphone', 'display': 'monitor', 'route': 'route',
         'wrench': 'wrench'}
# Device px (the kit picks the smallest at least the size asked and scales it down): icons are 14 to 125 px.
SIZES = [20, 34, 64, 128]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = os.path.join(sys.argv[1], 'lucide.ttf')
    css = open(os.path.join(sys.argv[1], 'lucide.css')).read()
    codes = {n: int(c, 16) for n, c in re.findall(r'\.icon-([a-z0-9-]+):+before\s*\{\s*content:\s*"\\([0-9a-f]+)"', css)}
    icons = {name: codes[ph] for name, ph in ICONS.items()}
    head = TTFont(path)
    bake_fonts.TEXT = ''.join(chr(c) for c in sorted(icons.values()))
    fam = {'family': 'Lucide', 'baseline': head['hhea'].ascent / head['head'].unitsPerEm, 'icons': icons,
           'sizes': [bake_fonts.bake(path, s) for s in SIZES]}
    out = os.path.join(bake_fonts.SRC, 'font_icons.js')
    with open(out, 'w') as o:
        o.write('/* Lucide glyph atlases, baked by tools/bake_icons.py from lucide.ttf (lucide-static 1.72.0).\n'
                ' * Copyright (c) 2026 Lucide Icons and Contributors. ISC License: src/LICENSE-Lucide.txt */\n'
                "'use strict';\nmodule.exports = %s;\n" % json.dumps(fam, separators=(',', ':')))
    print('%s: %d bytes' % (os.path.relpath(out), os.path.getsize(out)))


if __name__ == '__main__':
    main()
