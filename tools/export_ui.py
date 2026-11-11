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
  public/ui/font.png, src/gamefont.js   the game's system font (--zascii <zascii.tim>, image 0: 16x16 cells, A-Z 0-9 . : _ -) as one strip of
                                    white glyphs 14 px high, with each glyph's x and width; the sheet has no parentheses, so ( and ) are drawn here
  public/ui/logo-viewer.png         "MODEL VIEWER" in the green alphabet of system.tim (--system <system.tim>, image 20, 32 px cells, A-Z 0-9)
  public/ui/banner.png              the title banner of the options screen (--option <option.tim>, image 0, 248x32): steel frame with slanted ends and
                                    a dark window. The "OPTIONS" text is painted out and the grey steel recoloured to the blue steel of the
                                    main menu's plates (header, footer, player), so the site's metal is one family. Shown with border-image
                                    (52 px ends, the middle stretches)
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





FONT_CHARS = ".:_-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
# ( and ): the sheet lacks them; 3 px strokes like its letters, 13 rows (the letters' height)
PAREN = ["..##", ".###", "###.", "###.", "###.", "###.", "###.", "###.", "###.", "###.", "###.", ".###", "..##"]


def game_font(path, out_dir, js_path):
    """zascii.tim image 0 -> public/ui/font.png (strip of glyphs, white, 14 px high) + src/gamefont.js (x and width of each)."""
    w, h, px = decode(_tims(open(path, "rb").read())[0])
    glyphs = []  # (char, rows of 14 strings of 0/1)
    for i, ch in enumerate(FONT_CHARS):
        cx, cy = (i % 16) * 16, (i // 16) * 16
        rows = [[1 if px[((cy + 1 + y) * w + cx + x) * 4 + 3] else 0 for x in range(16)] for y in range(14)]
        xs = [x for r in rows for x in range(16) if r[x]]
        glyphs.append((ch, [r[min(xs):max(xs) + 1] for r in rows]))
    for ch, art in (("(", PAREN), (")", [r[::-1] for r in PAREN])):
        glyphs.append((ch, [[1 if c == "#" else 0 for c in r] for r in art] + [[0] * 4]))
    total = sum(len(g[1][0]) for g in glyphs)
    strip = bytearray(total * 14 * 4)
    x0, table = 0, {}
    for ch, rows in glyphs:
        gw = len(rows[0])
        for y in range(14):
            for x in range(gw):
                if rows[y][x]:
                    o = (y * total + x0 + x) * 4
                    strip[o:o + 4] = bytes((255, 255, 255, 255))
        table[ch] = (x0, gw)
        x0 += gw
    save(os.path.join(out_dir, "ui", "font.png"), (total, 14, bytes(strip)))
    NL = chr(10)
    body = ("," + NL).join('  "%s": [%d, %d]' % (c, x, gw) for c, (x, gw) in table.items())
    head = "// generated by tools/export_ui.py --zascii: where each glyph of public/ui/font.png starts and how wide it is"
    with open(js_path, "w", encoding="utf-8", newline=NL) as f:
        f.write(NL.join([head, "export const GAME_FONT = {", "  height: 14,", "  gap: 2,", "  space: 6,", "  glyphs: {", body, "  },", "};", ""]))


def viewer_logo(path, out_dir):
    """system.tim image 20 (the green alphabet, 8 cells of 32 px per row) -> "MODEL VIEWER" written with it, at its own size."""
    w, h, px = decode(_tims(open(path, "rb").read())[20])
    cells = []
    for ch in "MODEL VIEWER":
        if ch == " ":
            cells.append(None)
            continue
        i = ord(ch) - ord("A")
        cx, cy = (i % 8) * 32, (i // 8) * 32
        cells.append(crop((w, h, px), cx, cy, 32, 32))
    def bounds(img):
        cw, ch_, p = img
        xs = [x for y in range(ch_) for x in range(cw) if p[(y * cw + x) * 4 + 3]]
        ys = [y for y in range(ch_) for x in range(cw) if p[(y * cw + x) * 4 + 3]]
        return min(xs), max(xs), min(ys), max(ys)
    boxes = [bounds(c) for c in cells if c]
    y0, y1 = min(b[2] for b in boxes), max(b[3] for b in boxes)
    gap, space = 2, 14
    pieces = []
    for c in cells:
        if c is None:
            pieces.append((space, None))
            continue
        a, b, _, _ = bounds(c)
        pieces.append((b - a + 1 + gap, crop(c, a, y0, b - a + 1, y1 - y0 + 1)))
    W, H = sum(p[0] for p in pieces) - gap, y1 - y0 + 1
    out = bytearray(W * H * 4)
    x0 = 0
    for adv, img in pieces:
        if img:
            iw, _, ip = img
            for y in range(H):
                out[(y * W + x0) * 4:(y * W + x0 + iw) * 4] = ip[y * iw * 4:(y + 1) * iw * 4]
        x0 += adv
    save(os.path.join(out_dir, "ui", "logo-viewer.png"), (W, H, bytes(out)))


# the options banner's greys -> the main menu's blue steel (highlight, plate, edge, dark) and its dark window
BANNER_STEEL = {
    (0xbd, 0xb5, 0xb5): (0xad, 0xbd, 0xc6), (0xad, 0xad, 0xad): (0xad, 0xbd, 0xc6),
    (0xa5, 0x9c, 0x9c): (0x8c, 0xa5, 0xb5), (0x8c, 0x84, 0x84): (0x73, 0x8c, 0x9c), (0x73, 0x6b, 0x6b): (0x5a, 0x73, 0x84),
}
BANNER_WINDOW = (0x00, 0x10, 0x21)


def option_banner(path, out_dir):
    """option.tim image 0 -> banner.png: text painted out, steel recoloured, trimmed to the banner."""
    w, h, px = decode(_tims(open(path, "rb").read())[0])
    px = bytearray(px)
    for o in range(0, len(px), 4):
        if px[o + 3]:
            rgb = BANNER_STEEL.get(tuple(px[o:o + 3]), BANNER_WINDOW)
            px[o:o + 3] = bytes(rgb)
    img = trim((w, h, bytes(px)))
    save(os.path.join(out_dir, "ui", "banner.png"), img)
    print("banner: %dx%d" % (img[0], img[1]))


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
    ap.add_argument("--zascii", help="zascii.tim: also writes the game's system font (public/ui/font.png, src/gamefont.js)")
    ap.add_argument("--system", help="system.tim: also writes the \"MODEL VIEWER\" logo in the game's green alphabet")
    ap.add_argument("--option", help="title/option.tim: also writes the title banner (public/ui/banner.png)")
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
    if a.option:
        option_banner(a.option, a.out)
    if a.zascii:
        game_font(a.zascii, a.out, os.path.join(a.out, "..", "src", "gamefont.js"))
    if a.system:
        viewer_logo(a.system, a.out)
    print("ui: 2 logos, select frame, 24 names, 24 icons ->", os.path.abspath(a.out))





if __name__ == "__main__":

    sys.exit(main())

