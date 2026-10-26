"""Where two PAM (RGBA) images differ: count, bounding box, largest channel difference.
    python3 pamdiff.py A.pam B.pam"""
import sys


def load(path):
    data = open(path, 'rb').read()
    end = data.index(b'ENDHDR\n') + 7
    head = dict(l.split(b' ', 1) for l in data[:end].split(b'\n')[1:-2])
    return int(head[b'WIDTH']), int(head[b'HEIGHT']), data[end:]


def main(a, b):
    wa, ha, pa = load(a)
    wb, hb, pb = load(b)
    if (wa, ha) != (wb, hb):
        print('     sizes differ: %dx%d vs %dx%d' % (wa, ha, wb, hb))
        return
    n, box, big = 0, None, 0
    for i in range(0, len(pa), 4):
        d = max(abs(pa[i + k] - pb[i + k]) for k in range(4))
        if d:
            n += 1
            big = max(big, d)
            x, y = (i // 4) % wa, (i // 4) // wa
            box = [x, y, x, y] if not box else [min(box[0], x), min(box[1], y), max(box[2], x), max(box[3], y)]
    print('     last frame: %d pixels differ, box %s, largest difference %d' % (n, box, big))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
