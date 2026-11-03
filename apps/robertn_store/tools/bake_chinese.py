#!/usr/bin/env python3
"""Bakes src/font_chinese.js, the glyph atlases the Store draws Chinese
with while a locale with "font": "chinese" is in use (src/kit_fonts.js),
from Noto Sans SC, SIL Open Font License 1.1 (src/LICENSE-NotoSansSC.txt):

    python3 tools/bake_chinese.py <NotoSansSC[wght].ttf>

The font is google/fonts ofl/notosanssc/NotoSansSC[wght].ttf at commit
2894aab31764f10f29c421bdfd2340d3b382d384 (its SHA-256 below), drawn at
weight 500. Needs Pillow. Two atlases, each with ASCII and the Inter
atlases' symbols: "ui", the characters of the locales' words at 48 px (the
Store's own text, titles included, stays sharp), and "common", GB2312's
level 1 (the 3,755 most used characters) with those at 24 px, for names
and descriptions from sources. Each atlas is 1024 px wide (mgu-render's
limit) and has a key from its contents, so the renderer, which shares
atlases between apps by id, never mixes them up with another font's.
"""
import glob, hashlib, json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_fonts

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..')
FONT_SHA256 = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
WEIGHT = 500
PUNCTUATION = '，。：；？！（）、“”‘’《》【】—…·'


def gb2312_level1():
    return ''.join(bytes([r, c]).decode('gb2312') for r in range(0xB0, 0xD8) for c in range(0xA1, 0xFF)
                   if not (r == 0xD7 and c > 0xF9))


def locale_text():
    text = ''
    for path in sorted(glob.glob(os.path.join(APP, 'locales', '*.json'))):
        with open(path, encoding='utf-8') as f:
            locale = json.load(f)
        if locale.get('font') == 'chinese':
            text += ''.join(locale['words'].values())
    return text


def atlas(path, name, size, chars):
    bake_fonts.TEXT = ''.join(sorted(set(bake_fonts.TEXT + PUNCTUATION + chars)))
    a = bake_fonts.bake(path, size, [WEIGHT], 1024)
    a['key'] = 'Noto Sans SC %s@%d@%s' % (name, size, hashlib.sha256(
        json.dumps(a, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:16])
    return a


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], 'rb') as f:
        if hashlib.sha256(f.read()).hexdigest() != FONT_SHA256:
            sys.exit('not the pinned NotoSansSC[wght].ttf (SHA-256 %s)' % FONT_SHA256)
    ui = locale_text()
    face = {'family': 'Noto Sans SC', 'sizes': [atlas(sys.argv[1], 'ui', 48, ui),
                                                 atlas(sys.argv[1], 'common', 24, gb2312_level1() + ui)]}
    out = os.path.join(APP, 'src', 'font_chinese.js')
    with open(out, 'w', encoding='utf-8', newline='\n') as o:
        o.write('/* Noto Sans SC glyph atlases, baked by tools/bake_chinese.py from NotoSansSC[wght].ttf.\n'
                ' * Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name \'Source\'.\n'
                ' * SIL Open Font License 1.1: src/LICENSE-NotoSansSC.txt */\n'
                "'use strict';\nmodule.exports = %s;\n" % json.dumps(face, separators=(',', ':')))
    for a in face['sizes']:
        print('%s: %d glyphs, %d x %d' % (a['key'], len(a['glyphs']), a['atlasW'], a['atlasH']))
    print('%s: %d bytes' % (os.path.relpath(out), os.path.getsize(out)))


if __name__ == '__main__':
    main()
