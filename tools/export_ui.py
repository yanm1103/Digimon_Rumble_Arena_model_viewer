#!/usr/bin/env python3
"""Cuts the interface pictures the site uses out of the disc's TIMs (US).

  python tools/export_ui.py --charasel <title/charasel.tim> --title <title/title.tim> [--out public]

writes
  public/ui/logo-digimon.png        DIGIMON Digital Monsters logo (title.tim, image 9)
  public/ui/logo-rumble.png         RUMBLE ARENA logo (title.tim, image 0: the 8 bit picture holds the left half at x 0..207
                                    and the right half at x 256..463, 48 empty columns between them: the halves are joined)
  public/names/<prefix>.png         each Digimon's name as the select screen writes it (charasel.tim images 12..35, 128x24,
                                    trimmed to the letters)
  public/ui/select-frame.png        the orange "player 1" selector of the select screen (charasel.tim image 0, 32x32, chamfered thick
                                    frame in #FFB563 / #FF8C31 / #DE6B21) with the red-and-yellow "1" badge painted out
  public/ui/menu-tile.png           the main menu's background (--menu <title/mainmenu.tim>, image 0, 512x480): hexagons with DIGIMON written in
                                    them. It repeats every 229x40 px; the tile is rebuilt by voting over the parts of the picture that are
                                    not the frames, the dark side bands or the dragon, so nothing of those is in it
  public/ui/menu-edge-left.png,     the side bands: a black layer at ~22% opacity (the dark colours are 0.78 of the tile's colours) with big
  public/ui/menu-edge-right.png     circles that shrink away from the border. 9 px high, repeats vertically
  public/ui/hover-frame.png         the same in cyan (image 1, the "2" player's), badge painted out: the hover of the list
  public/icons/<prefix>.png         the 24x24 face of each Digimon in the select screen's grid (the grid is one 288x116 picture,
                                    charasel.tim image 6; cell -> character from GRID_CELLS)
The big portraits (public/logos) come from export_glb.py --icons.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rip_models as R  # noqa: E402
import export_glb as G  # noqa: E402

# GRID_CELLS of the US executable (chara_select.rodata.s): the character of each cell of the select grid
CELL_CHARACTER = [22, 23, 10, 7, 8, 6, 2, 0, 11, 18, 3, 12, 20, 19, 17, 9, 21, 15, 14, 1, 13, 16, 5, 4]


def cell_position(c):
    """getCellPosition: where cell c sits inside the 288x116 grid picture."""
    if c < 6:
        return (c * 30 + 0x62 if c >= 3 else c * 30 + 8), 11
    if c < 15:
        return (c - 6) * 30 + 8, 0x29
    return (c - 15) * 30 + 8, 0x47


def parse_stream(path):
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
    return _tims(open(path, "rb").read())


def _tims(data):
    import struct
    pos, out = 0, []
    while pos + 8 <= len(data):
        magic, flags = struct.unpack_from("<II", data, pos)
        if magic != 0x10:
            break
        pos += 8
        t = {"mode": flags & 3, "clut": None}
        if flags & 8:
            bnum, x, y, w, h = struct.unpack_from("<IHHHH", data, pos)
            t["clut"] = (w, h, data[pos + 12:pos + 12 + w * h * 2])
            pos += bnum
        bnum, x, y, w, h = struct.unpack_from("<IHHHH", data, pos)
        t["image"] = (w, h, data[pos + 12:pos + 12 + w * h * 2])
        pos += bnum
        out.append(t)
    return out


def decode(t):
    """RGBA of a TIM image, CLUT row 0, colour 0 transparent. Returns (w, h, bytes)."""
    import struct
    w, h, raw = t["image"]
    hw = struct.unpack("<%dH" % (len(raw) // 2), raw)
    if t["mode"] == 2:
        pw, px = w, bytearray()
        for c in hw:
            px += bytes((*R.bgr555(c), 255)) if c else b"\0\0\0\0"
        return pw, h, bytes(px)
    cw, ch, craw = t["clut"]
    clut = struct.unpack("<%dH" % (len(craw) // 2), craw)[:cw]
    per = 4 if t["mode"] == 0 else 2
    bits = 16 // per
    pw = w * per
    px = bytearray()
    for y in range(h):
        for x in range(pw):
            idx = (hw[y * w + x // per] >> ((x % per) * bits)) & ((1 << bits) - 1)
            c = clut[idx] if idx < len(clut) else 0
            px += bytes((*R.bgr555(c), 255)) if c else b"\0\0\0\0"
    return pw, h, bytes(px)


def crop(img, x0, y0, cw, chh):
    w, _h, px = img
    out = bytearray()
    for y in range(y0, y0 + chh):
        out += px[(y * w + x0) * 4:(y * w + x0 + cw) * 4]
    return cw, chh, bytes(out)


def trim(img):
    w, h, px = img
    xs = [x for y in range(h) for x in range(w) if px[(y * w + x) * 4 + 3]]
    ys = [y for y in range(h) for x in range(w) if px[(y * w + x) * 4 + 3]]
    return crop(img, min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1)


def hjoin(a, b):
    (wa, h, pa), (wb, _h, pb) = a, b
    out = bytearray()
    for y in range(h):
        out += pa[y * wa * 4:(y + 1) * wa * 4] + pb[y * wb * 4:(y + 1) * wb * 4]
    return wa + wb, h, bytes(out)


def save(path, img):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    R.write_png(path, *img)


MENU_PERIOD = (229, 40)
EDGE_ALPHA = 56  # 22% black: the band's colours are 0.78 x the pattern's


def menu_background(path, out_dir):
    """mainmenu.tim image 0 -> menu-tile.png + menu-edge-left/right.png (see the header)."""
    import collections
    w, h, px = decode(_tims(open(path, "rb").read())[0])
    pw, ph = MENU_PERIOD
    P = lambda x, y: bytes(px[(y * w + x) * 4:(y * w + x) * 4 + 3])

    def clean(x, y):  # not the frames (top, bottom), the side bands, or the dragon and its dots
        if x < 80 or x >= w - 76 or y < 76 or y >= 412:
            return False
        return not (140 <= x < 380 and 98 <= y < 374)

    votes = collections.defaultdict(collections.Counter)
    for y in range(h):
        for x in range(w):
            if clean(x, y):
                votes[(x % pw, y % ph)][P(x, y)] += 1
    tile = bytearray()
    for v in range(ph):
        for u in range(pw):
            tile += votes[(u, v)].most_common(1)[0][0] + bytes((255,))
    save(os.path.join(out_dir, "ui", "menu-tile.png"), (pw, ph, bytes(tile)))

    palette = {bytes(tile[i:i + 3]) for i in range(0, len(tile), 4)}
    err = n = 0
    for name, x0, x1 in (("left", 0, 90), ("right", w - 90, w)):
        rows = range(100, 109)  # the circles repeat every 9 rows
        cols = [x for x in range(x0, x1) if any(P(x, y) not in palette for y in range(76, 412))]
        a, b = min(cols), max(cols) + 1
        strip = bytearray()
        for y in rows:
            for x in range(a, b):
                strip += bytes((0, 0, 0, EDGE_ALPHA)) if P(x, y) not in palette else bytes(4)
        save(os.path.join(out_dir, "ui", "menu-edge-%s.png" % name), (b - a, 9, bytes(strip)))
        for y in range(76, 412):  # does tile + 22% black give the picture back?
            for x in range(a, b):
                t = tile[((y % ph) * pw + x % pw) * 4:((y % ph) * pw + x % pw) * 4 + 3]
                dark = P(x, y) not in palette
                for c in range(3):
                    err += abs((int(t[c] * (1 - EDGE_ALPHA / 255)) if dark else t[c]) - P(x, y)[c]); n += 1
        print("menu edge %s: %d px wide (x %d..%d)" % (name, b - a, a, b))
    print("menu background: tile %dx%d, mean error of the bands rebuilt from tile + overlay: %.2f / 255" % (pw, ph, err / n))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--charasel", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--menu", help="title/mainmenu.tim: also cuts the menu background (tile and side bands)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public"))
    a = ap.parse_args()

    title = _tims(open(a.title, "rb").read())
    rumble = decode(title[0])
    joined = hjoin(crop(rumble, 0, 0, 208, rumble[1]), crop(rumble, 256, 0, rumble[0] - 256, rumble[1]))
    save(os.path.join(a.out, "ui", "logo-rumble.png"), trim(joined))
    save(os.path.join(a.out, "ui", "logo-digimon.png"), trim(decode(title[9])))

    cs = _tims(open(a.charasel, "rb").read())
    for cid in range(24):
        save(os.path.join(a.out, "names", G.CHARACTERS[cid][0].lower() + ".png"), trim(decode(cs[12 + cid])))
    # the selector frames: orange "1" (image 0) and cyan "2" (image 1), each with its red badge and the digit painted out
    for idx, name, badge in ((0, "select-frame", ((222, 0, 66), (255, 181, 41))), (1, "hover-frame", ((222, 0, 66), (247, 214, 24)))):
        frame = list(decode(cs[idx]))
        px = bytearray(frame[2])
        for o in range(0, len(px), 4):
            if tuple(px[o:o + 3]) in badge:
                px[o:o + 4] = bytes(4)
        frame[2] = bytes(px)
        save(os.path.join(a.out, "ui", name + ".png"), tuple(frame))
    grid = decode(cs[6])
    for cell, cid in enumerate(CELL_CHARACTER):
        x, y = cell_position(cell)
        save(os.path.join(a.out, "icons", G.CHARACTERS[cid][0].lower() + ".png"), crop(grid, x + 2, y + 2, 24, 24))
    if a.menu:
        menu_background(a.menu, a.out)
    print("ui: 2 logos, select frame, 24 names, 24 icons ->", os.path.abspath(a.out))


if __name__ == "__main__":
    sys.exit(main())
