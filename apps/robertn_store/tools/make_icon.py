#!/usr/bin/env python3
"""The Store's tile icon (140 x 140): tools/store_icon.svg, drawn like the idrive7-apps icons
(kit/tools/render_icons.py there: the art on a transparent background with a soft shadow,
rendered at 4x with headless Chromium and scaled down).

    python3 tools/make_icon.py <out.png>        CHROME=/path/to/chrome when it isn't found
"""
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE, SCALE = 140, 4
SHADOW = '''<defs><filter id="tile-shadow" x="-20%" y="-20%" width="140%" height="140%">
<feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.75"/></filter></defs>
<g filter="url(#tile-shadow)">{art}</g>'''


def chrome():
    for c in [os.environ.get('CHROME')] + [shutil.which(n) for n in ('chrome-headless-shell', 'chromium', 'google-chrome')]:
        if c:
            return c
    found = sorted(glob.glob('/opt/pw-browsers/chromium_headless_shell-*/*/chrome-headless-shell') +
                   glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')))
    if found:
        return found[-1]
    sys.exit('no Chromium / Chrome found - set CHROME=/path/to/it')


def main():
    out = sys.argv[1]
    src = open(os.path.join(HERE, 'store_icon.svg'), encoding='utf-8').read()
    art = re.sub(r'^\s*<!--.*?-->', '', src, flags=re.S)
    px = SIZE * SCALE
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" viewBox="0 0 {SIZE} {SIZE}">'
           + SHADOW.replace('{art}', art) + '</svg>')
    with tempfile.TemporaryDirectory() as tmp:
        html, big = os.path.join(tmp, 'icon.html'), os.path.join(tmp, 'icon.png')
        open(html, 'w', encoding='utf-8').write(
            f'<html><body style="margin:0;background:transparent;overflow:hidden">{svg}</body></html>')
        subprocess.run([chrome(), '--no-sandbox', '--hide-scrollbars', '--default-background-color=00000000',
                        f'--window-size={px},{px}', f'--screenshot={big}', 'file://' + html],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        Image.open(big).convert('RGBA').resize((SIZE, SIZE), Image.LANCZOS).save(out, optimize=True)


if __name__ == '__main__':
    main()
