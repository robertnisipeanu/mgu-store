import sys
from PIL import Image, ImageDraw

# 140x140 tile icon, glyph centered with ~24px transparent padding
# (visible glyph ~92px). Supersampled 4x then downscaled for smooth edges.
# Glyph: a tray with a downward arrow into it = install / update.
out = sys.argv[1]
S = 4
N = 140 * S
pad = 24 * S
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
col = (235, 238, 242, 255)        # near-white glyph
w = 9 * S                         # stroke width
left, right = pad, N - pad
top, bottom = pad, N - pad
cx = N // 2

# tray: open box along the bottom third
tray_top = bottom - 30 * S
d.rectangle([left, tray_top, left + w, bottom], fill=col)
d.rectangle([right - w, tray_top, right, bottom], fill=col)
d.rectangle([left, bottom - w, right, bottom], fill=col)
# arrow: shaft from the top, head pointing into the tray
head = 26 * S
shaft_bottom = bottom - 20 * S - head
d.rectangle([cx - w // 2, top, cx + w // 2, shaft_bottom + 2 * S], fill=col)
d.polygon([(cx - head, shaft_bottom), (cx + head, shaft_bottom), (cx, shaft_bottom + head)], fill=col)

img = img.resize((140, 140), Image.LANCZOS)
img.save(out)
print("wrote", out, img.size)
