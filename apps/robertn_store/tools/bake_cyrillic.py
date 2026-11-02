#!/usr/bin/env python3
"""Bakes src/font_cyrillic.js, the glyph atlases the Store draws Russian
with while a locale with "font": "cyrillic" is in use (src/kit_fonts.js),
from Inter Medium, SIL Open Font License 1.1 (src/LICENSE-Inter.txt):

    python3 tools/bake_cyrillic.py <Inter-Medium.ttf>

The font is Inter 4.1's extras/ttf/Inter-Medium.ttf (its SHA-256 below),
the face of the Store's own Inter atlases at weight 500. Needs Pillow.
Each atlas has ASCII, the Inter atlases' symbols, the Cyrillic block
(U+0400 to U+045F), Russian punctuation and the characters of the
locales' words: 24 px for names and descriptions from sources, 48 px for
the Store's own words and 77 px for its titles. Each atlas is 1024 px wide
(mgu-render's limit) and has a key from its contents, so the renderer,
which shares atlases between apps by id, never mixes them up with another
font's.
"""
import glob, hashlib, json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_fonts

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..')
FONT_SHA256 = '97ad806f526e41546d46365bb3a393145f75b7b1568913db74549ad8b8dba872'
SIZES = [24, 48, 77]
CYRILLIC = ''.join(chr(c) for c in range(0x400, 0x460))
PUNCTUATION = '«»„“”‘’№'


def locale_text():
    text = ''
    for path in sorted(glob.glob(os.path.join(APP, 'locales', '*.json'))):
        with open(path, encoding='utf-8') as f:
            locale = json.load(f)
        if locale.get('font') == 'cyrillic':
            text += ''.join(locale['words'].values())
    return text


def atlas(path, size, chars):
    bake_fonts.TEXT = ''.join(sorted(set(bake_fonts.TEXT + CYRILLIC + PUNCTUATION + chars)))
    a = bake_fonts.bake(path, size, None, 1024)
    a['key'] = 'Inter Medium cyrillic@%d@%s' % (size, hashlib.sha256(
        json.dumps(a, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:16])
    return a


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], 'rb') as f:
        if hashlib.sha256(f.read()).hexdigest() != FONT_SHA256:
            sys.exit('not the pinned Inter-Medium.ttf of Inter 4.1 (SHA-256 %s)' % FONT_SHA256)
    words = locale_text()
    face = {'family': 'Inter Medium cyrillic', 'sizes': [atlas(sys.argv[1], s, words) for s in SIZES]}
    out = os.path.join(APP, 'src', 'font_cyrillic.js')
    with open(out, 'w', encoding='utf-8', newline='\n') as o:
        o.write('/* Inter Medium glyph atlases with Cyrillic, baked by tools/bake_cyrillic.py from Inter-Medium.ttf (Inter 4.1).\n'
                ' * Copyright 2016 The Inter Project Authors. SIL Open Font License 1.1: src/LICENSE-Inter.txt */\n'
                "'use strict';\nmodule.exports = %s;\n" % json.dumps(face, separators=(',', ':')))
    for a in face['sizes']:
        print('%s: %d glyphs, %d x %d' % (a['key'], len(a['glyphs']), a['atlasW'], a['atlasH']))
    print('%s: %d bytes' % (os.path.relpath(out), os.path.getsize(out)))


if __name__ == '__main__':
    main()
