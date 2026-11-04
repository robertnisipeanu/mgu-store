#!/usr/bin/env python3
"""Bakes the glyph atlases the Store draws accented Latin, Greek, Cyrillic
and Vietnamese with while a locale with that "font" is in use
(src/kit_fonts.js), from Inter 4.1, SIL Open Font License 1.1
(src/LICENSE-Inter.txt):

    python3 tools/bake_inter.py <folder with Inter-Regular.ttf and Inter-SemiBold.ttf>

    font         writes                   letters
    latin        src/font_latin.js        Latin-1, Latin Extended-A, Romanian's comma-below
    greek        src/font_greek.js        Greek
    cyrillic     src/font_cyrillic.js     Cyrillic, Ukrainian's Ґ
    vietnamese   src/font_vietnamese.js   Latin-1's letters and Vietnamese's

Each is the faces of tools/bake_fonts.py with its letters and the
characters of its locales' words and catalog texts (release/texts), at
fewer sizes (the kit scales the nearest one). Each atlas is 1024 px wide
(mgu-render's limit) and has a key from its contents, so the renderer,
which shares atlases between apps by id, never mixes them up with another
font's. The renderer's glyph texture is shared and never emptied: a font
holds one language family's letters only.
"""
import glob, hashlib, json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_fonts

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..')
FACES = {'regular': ('Inter-Regular.ttf', [23, 41]),
         'semibold': ('Inter-SemiBold.ttf', [25, 44, 77])}


def ranges(*spans):
    return ''.join(chr(c) for a, b in spans for c in range(a, b + 1))


PUNCTUATION = '¡¿«»‘’‚“”„‹›€−'
FONTS = {
    'latin': ranges((0xC0, 0xFF), (0x100, 0x148), (0x14A, 0x17F), (0x218, 0x21B)) + PUNCTUATION,
    'greek': ranges((0x386, 0x386), (0x388, 0x38A), (0x38C, 0x38C), (0x38E, 0x3A1), (0x3A3, 0x3CE)) + PUNCTUATION,
    'cyrillic': ranges((0x400, 0x45F), (0x490, 0x491)) + PUNCTUATION + '₴₽№',
    'vietnamese': ranges((0xC0, 0xFF), (0x1EA0, 0x1EF9)) + 'ĂăĐđĨĩŨũƠơƯư' + PUNCTUATION + '₫',
}


def locale_text(font):
    text = ''
    for path in sorted(glob.glob(os.path.join(APP, 'locales', '*.json'))):
        with open(path, encoding='utf-8') as f:
            locale = json.load(f)
        if locale.get('font') == font:
            text += ''.join(locale['words'].values())
            # the catalog's titles and descriptions in that language (release/texts)
            texts = os.path.join(APP, '..', '..', 'release', 'texts', os.path.basename(path))
            if os.path.exists(texts):
                with open(texts, encoding='utf-8') as f:
                    text += ''.join(v for c in json.load(f).values() for v in c.values())
    return text


def atlas(path, face, font, size, chars):
    bake_fonts.TEXT = ''.join(sorted(set(bake_fonts.TEXT + chars)))
    a = bake_fonts.bake(path, size, None, 1024)
    a['key'] = 'Inter %s %s@%d@%s' % (face, font, size, hashlib.sha256(
        json.dumps(a, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:16])
    return a


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    base = bake_fonts.TEXT
    for font, letters in FONTS.items():
        chars = letters + locale_text(font)
        faces = {}
        for name, (file, sizes) in FACES.items():
            faces[name] = {'sizes': []}
            for s in sizes:
                faces[name]['sizes'].append(atlas(os.path.join(sys.argv[1], file), name, font, s, chars))
                bake_fonts.TEXT = base
        out = os.path.join(APP, 'src', 'font_%s.js' % font)
        with open(out, 'w', encoding='utf-8', newline='\n') as o:
            o.write('/* Inter glyph atlases with %s letters, baked by tools/bake_inter.py\n'
                    ' * from Inter-Regular.ttf and Inter-SemiBold.ttf (Inter 4.1).\n'
                    ' * Copyright 2016 The Inter Project Authors. SIL Open Font License 1.1: src/LICENSE-Inter.txt */\n'
                    "'use strict';\nmodule.exports = %s;\n" % (font, json.dumps({'family': 'Inter ' + font, 'faces': faces},
                                                                            separators=(',', ':'))))
        rows = sum(a['atlasH'] + 1 for f in faces.values() for a in f['sizes'])
        print('%s: %d glyphs, %d rows, %d bytes' % (os.path.relpath(out), len(faces['regular']['sizes'][0]['glyphs']),
                                                   rows, os.path.getsize(out)))


if __name__ == '__main__':
    main()
