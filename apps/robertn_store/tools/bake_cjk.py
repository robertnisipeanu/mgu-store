#!/usr/bin/env python3
"""Bakes the glyph atlases the Store draws Chinese, Japanese and Korean
with while a locale with that "font" is in use (src/kit_fonts.js), from the
Noto Sans CJK faces of google/fonts, SIL Open Font License 1.1
(src/LICENSE-NotoSans<SC|TC|JP|KR>.txt):

    python3 tools/bake_cjk.py <font> <Noto Sans ttf>

    font          ttf                    common set
    chinese       NotoSansSC[wght].ttf   GB2312 level 1 (3,755 characters), 20 px
    chinese-tc    NotoSansTC[wght].ttf   Big5 level 1 (5,401 characters), 18 px
    japanese      NotoSansJP[wght].ttf   JIS X 0208: kana and level 1 kanji (2,965), 20 px
    korean        NotoSansKR[wght].ttf   KS X 1001's 2,350 Hangul syllables, 20 px

into the staged tree's fonts/<font>.json, which the Store reads when the
language is in use.

Each font is google/fonts ofl/<dir>/<ttf> at commit
2894aab31764f10f29c421bdfd2340d3b382d384 (its SHA-256 below), drawn at
weight 500. Needs Pillow. Two atlases, each with ASCII and the Inter
atlases' symbols: "ui", the characters of the locales' words and catalog
texts (release/texts) at 40 px (the Store's own text, titles included,
stays sharp), and "common", the common set with those at the size above
(small enough that Inter's atlases and two languages' fit the renderer's
glyph texture, which keeps every atlas until it restarts), for names
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
# the staged tree's fonts folder: what the Store reads a language's font from
FONT_DIR = os.path.join(APP, [n for n in os.listdir(APP) if n.startswith('robertn_store@') and os.path.isdir(os.path.join(APP, n))][0], 'fonts')
WEIGHT = 500
PUNCTUATION = '，。：；？！（）、“”‘’《》【】—…·'


def decoded(codec, rows, cols, skip=lambda r, c: False):
    out = []
    for r in rows:
        for c in cols:
            if not skip(r, c):
                try:
                    out.append(bytes([r, c]).decode(codec))
                except UnicodeDecodeError:
                    pass
    return ''.join(out)


def gb2312_level1():
    return decoded('gb2312', range(0xB0, 0xD8), range(0xA1, 0xFF), lambda r, c: r == 0xD7 and c > 0xF9)


def big5_level1():
    return decoded('big5', range(0xA4, 0xC7), list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)),
                   lambda r, c: r == 0xC6 and c > 0x7E)


def jis_level1():
    # rows 4-5 (hiragana, katakana) and 16-47 (level 1 kanji) of JIS X 0208, as EUC-JP
    return decoded('euc_jp', [0xA4, 0xA5] + list(range(0xB0, 0xD0)), range(0xA1, 0xFF)) + 'ー・「」『』〜'


def ksx1001_hangul():
    return decoded('euc_kr', range(0xB0, 0xC9), range(0xA1, 0xFF))


FONTS_OF = {
    'chinese': ('Noto Sans SC', 'NotoSansSC[wght].ttf', 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
                gb2312_level1, 20),
    'chinese-tc': ('Noto Sans TC', 'NotoSansTC[wght].ttf', 'fccb6ba05e6e46e464ddd5adaa2e1ac9badcbb88c762a243f600a0b51659a4c9',
                   big5_level1, 18),
    'japanese': ('Noto Sans JP', 'NotoSansJP[wght].ttf', 'c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f',
                 jis_level1, 20),
    'korean': ('Noto Sans KR', 'NotoSansKR[wght].ttf', '194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252',
               ksx1001_hangul, 20),
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


def atlas(family, path, name, size, chars):
    bake_fonts.TEXT = ''.join(sorted(set(bake_fonts.TEXT + PUNCTUATION + chars)))
    a = bake_fonts.bake(path, size, WEIGHT, 1024)
    a['key'] = '%s %s@%d@%s' % (family, name, size, hashlib.sha256(
        json.dumps(a, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:16])
    return a


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in FONTS_OF:
        sys.exit(__doc__)
    family, ttf, sha256, common, common_size = FONTS_OF[sys.argv[1]]
    with open(sys.argv[2], 'rb') as f:
        if hashlib.sha256(f.read()).hexdigest() != sha256:
            sys.exit('not the pinned %s (SHA-256 %s)' % (ttf, sha256))
    ui = locale_text(sys.argv[1])
    base = bake_fonts.TEXT
    sizes = [atlas(family, sys.argv[2], 'ui', 40, ui)]
    bake_fonts.TEXT = base
    sizes.append(atlas(family, sys.argv[2], 'common', common_size, common() + ui))
    face = {'family': family, 'sizes': sizes}
    out = os.path.join(FONT_DIR, '%s.json' % sys.argv[1])
    with open(out, 'w', encoding='utf-8', newline='\n') as o:
        json.dump({'family': family, 'source': '%s, tools/bake_cjk.py' % ttf,
                   'copyright': "Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'",
                   'license': 'SIL Open Font License 1.1 (LICENSES.txt)', 'sizes': sizes}, o, separators=(',', ':'))
    for a in face['sizes']:
        print('%s: %d glyphs, %d x %d' % (a['key'], len(a['glyphs']), a['atlasW'], a['atlasH']))
    print('%s: %d bytes' % (os.path.relpath(out), os.path.getsize(out)))


if __name__ == '__main__':
    main()
