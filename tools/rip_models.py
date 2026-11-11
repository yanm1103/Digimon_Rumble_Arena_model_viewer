#!/usr/bin/env python3
"""Rip Digimon Rumble Arena / Tamers Battle Evolution character models.

Reads NN.tmd (mesh), NN.tim (textures, several TIMs back to back), NN.mop
(node hierarchy + animation clips) from the extracted disc /chara folder and
writes a textured, posed OBJ + MTL + PNGs, plus an optional preview render.

No third-party packages: pure Python (struct, zlib).

  python rip_models.py <chara_dir> <out_dir> [--ids 0 1 ...] [--clip N] [--frame N]
                       [--bind] [--preview] [--list-clips]

--bind   ignore the animation: every node gets identity (parts at their TMD origin)
"""
import argparse
import math
import os
import struct
import sys
import zlib
from array import array


# ---------------------------------------------------------------- PNG output
def write_png(path, w, h, rgba):
    """rgba: bytes/bytearray of w*h*4."""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


# ---------------------------------------------------------------- VRAM / TIM
class Vram:
    def __init__(self):
        self.px = array("H", [0]) * (1024 * 512)

    def blit(self, x, y, w, h, data):
        # data: w*h halfwords
        for row in range(h):
            for col in range(w):
                o = (row * w + col) * 2
                xx, yy = x + col, y + row
                if 0 <= xx < 1024 and 0 <= yy < 512:
                    self.px[yy * 1024 + xx] = data[o] | (data[o + 1] << 8)

    def get(self, x, y):
        return self.px[(y & 511) * 1024 + (x & 1023)]


# ---------------------------------------------------------------- the game's colour tint (color.c, color_shift.c)
HUE_TURN = 0x600
HUE_SEXTANT = 0x100


def _cdiv(a, b):
    """C integer division (truncates toward zero)."""
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


def _rgb_to_hsv(r, g, b):
    mx, which = b, 0
    if mx < r:
        mx, which = r, 1
    if mx < g:
        mx, which = g, 2
    delta = mx - min(r, g, b)
    sat = delta * 255 // mx if mx else 0
    if sat == 0:
        return -1, 0, mx
    if which == 0:
        hue = _cdiv((r - g) * HUE_SEXTANT, delta) + HUE_TURN * 2 // 3
    elif which == 1:
        hue = _cdiv((g - b) * HUE_SEXTANT, delta)
    else:
        hue = _cdiv((b - r) * HUE_SEXTANT, delta) + HUE_TURN // 3
    if hue < 0:
        hue += HUE_TURN
    return hue, sat, mx


def _hsv_to_rgb(hue, sat, val):
    if sat & 0xFF == 0:
        return val, val, val
    angle = hue % HUE_TURN if hue >= 0 else HUE_TURN - (-hue) % HUE_TURN
    i = angle & (HUE_SEXTANT - 1)
    p = (val * (0xFF00 - sat * HUE_SEXTANT) + 0x7F80) // 0xFF00
    q = (val * (0xFF00 - sat * i) + 0x7F80) // 0xFF00
    t = (val * (0xFF00 - sat * (HUE_SEXTANT - i)) + 0x7F80) // 0xFF00
    return [(val, t, p), (q, val, p), (p, val, t), (p, q, val), (t, p, val), (val, p, q), (val, t, p)][angle >> 8]


def shift_color(c, tint):
    """shiftColor of the game: tint = (hue, saturation, value), saturation and value scale by n / 128, hue turns.
    A 15 bit colour in, a 15 bit colour (with the STP bit) out; the transparent colour 0 stays."""
    if c == 0:
        return 0
    r, g, b = (c & 31) << 3, ((c >> 5) & 31) << 3, ((c >> 10) & 31) << 3
    hue, sat, val = _rgb_to_hsv(r, g, b)
    sat = min(0xFF, max(0, (sat * tint[1]) >> 7))
    val = min(0xFF, max(0, (val * tint[2]) >> 7))
    hue = ((hue + tint[0] + 0x8000) & 0xFFFF) - 0x8000  # an s16 in the game
    r, g, b = _hsv_to_rgb(hue, sat, val)
    return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10) | 0x8000


def shift_block(data, tint):
    n = len(data) // 2
    vals = struct.unpack("<%dH" % n, data[:n * 2])
    return struct.pack("<%dH" % n, *[shift_color(c, tint) for c in vals])


def load_tims(vram, data, tint=None):
    """Load back-to-back TIMs into vram. Returns a list of descriptions. tint: the game tints every CLUT (and the image
    of a 16 bit TIM) it loads with an HSV tint (charaLoadTims / tintTim): alternative colours."""
    pos = 0
    out = []
    while pos + 8 <= len(data):
        magic, flags = struct.unpack_from("<II", data, pos)
        if magic != 0x10:
            break
        pos += 8
        desc = {"mode": flags & 3}
        if flags & 8:
            bnum, x, y, w, h = struct.unpack_from("<IHHHH", data, pos)
            block = data[pos + 12:pos + 12 + w * h * 2]
            vram.blit(x, y, w, h, shift_block(block, tint) if tint else block)
            desc["clut"] = (x, y, w, h)
            pos += bnum
        bnum, x, y, w, h = struct.unpack_from("<IHHHH", data, pos)
        block = data[pos + 12:pos + 12 + w * h * 2]
        vram.blit(x, y, w, h, shift_block(block, tint) if tint and desc["mode"] == 2 else block)
        desc["image"] = (x, y, w, h)
        pos += bnum
        out.append(desc)
    return out


def bgr555(c):
    r = (c & 31) << 3
    g = ((c >> 5) & 31) << 3
    b = ((c >> 10) & 31) << 3
    return r | (r >> 5), g | (g >> 5), b | (b >> 5)


def texel(vram, tsb, cba, u, v):
    """Return (r,g,b,a) of texel (u,v) for a primitive's tpage/clut."""
    tpx = (tsb & 0xF) * 64
    tpy = ((tsb >> 4) & 1) * 256
    mode = (tsb >> 7) & 3
    cx = (cba & 0x3F) * 16
    cy = cba >> 6
    if mode == 0:
        hw = vram.get(tpx + (u >> 2), tpy + v)
        c = vram.get(cx + ((hw >> ((u & 3) * 4)) & 0xF), cy)
    elif mode == 1:
        hw = vram.get(tpx + (u >> 1), tpy + v)
        c = vram.get(cx + ((hw >> ((u & 1) * 8)) & 0xFF), cy)
    else:
        c = vram.get(tpx + u, tpy + v)
    if c == 0:
        return 0, 0, 0, 0
    r, g, b = bgr555(c)
    return r, g, b, 255


# ---------------------------------------------------------------- TMD
class Prim:
    __slots__ = ("obj", "verts", "norms", "uvs", "tsb", "cba", "color", "abe")


def parse_tmd(d):
    magic, flags, nobj = struct.unpack_from("<III", d, 0)
    assert magic == 0x41, "not a TMD"
    assert flags & 1 == 0, "FIXP TMD not supported"
    objs = []
    for i in range(nobj):
        vt, nv, nt, nn, pt, npr, sc = struct.unpack_from("<7I", d, 12 + i * 28)
        verts = [struct.unpack_from("<hhh", d, 12 + vt + k * 8) for k in range(nv)]
        norms = [tuple(c / 4096.0 for c in struct.unpack_from("<hhh", d, 12 + nt + k * 8))
                 for k in range(nn)]
        prims = []
        p = 12 + pt
        for _ in range(npr):
            olen, ilen, flag, mode = struct.unpack_from("<BBBB", d, p)
            q = p + 4
            pr = Prim()
            pr.obj = i
            pr.color = None
            pr.tsb = pr.cba = 0
            pr.uvs = None
            pr.abe = bool(mode & 2)
            quad = bool(mode & 8)
            textured = bool(mode & 4)
            gouraud = bool(mode & 0x10)
            n = 4 if quad else 3
            if textured:
                uvs = []
                for k in range(n):
                    u, v, w = struct.unpack_from("<BBH", d, q + k * 4)
                    uvs.append((u, v))
                    if k == 0:
                        pr.cba = w
                    elif k == 1:
                        pr.tsb = w
                pr.uvs = uvs
                q += n * 4
            else:
                r, g, b, _m = struct.unpack_from("<BBBB", d, q)
                pr.color = (r, g, b)
                q += 4
            if gouraud:
                nv_ = [struct.unpack_from("<HH", d, q + k * 4) for k in range(n)]
                pr.norms = [a for a, _ in nv_]
                pr.verts = [b for _, b in nv_]
            else:
                n0, v0 = struct.unpack_from("<HH", d, q)
                rest = struct.unpack_from("<HH", d, q + 4)
                vs = [v0, rest[0], rest[1]]
                if quad:
                    vs.append(struct.unpack_from("<HH", d, q + 8)[0])
                pr.verts = vs
                pr.norms = [n0] * n
            prims.append(pr)
            p += 4 + ilen * 4
        objs.append({"verts": verts, "norms": norms, "prims": prims})
    return objs


# ---------------------------------------------------------------- MOP
class Mop:
    def __init__(self, d):
        (self.magic, self.node_count, parents_o, objects_o, self.clip_count, clips_o,
         rot_o, scale_o, trans_o) = struct.unpack_from("<9I", d, 0)
        (_u24, self.rot_mask, self.scale_shift, self.scale_mask,
         self.trans_shift, self.trans_mask) = struct.unpack_from("<6H", d, 0x24)
        n = self.node_count
        self.parents = list(struct.unpack_from("<%dh" % n, d, parents_o))
        self.objects = list(struct.unpack_from("<%dh" % n, d, objects_o))
        self.d = d
        self.rot_o, self.scale_o, self.trans_o = rot_o, scale_o, trans_o
        self.clips = []
        for i in range(self.clip_count):
            fc, ko = struct.unpack_from("<iI", d, clips_o + i * 8)
            self.clips.append((fc, ko))

    def pose(self, clip, frame):
        """Per node: (quat(x,y,z,w) floats, scale(3 floats), trans(3 ints))."""
        fc, ko = self.clips[clip]
        frame = max(0, min(frame, fc - 1))
        n = self.node_count
        keys = struct.unpack_from("<%dI" % n, self.d, ko + n * 4 * frame)
        out = []
        for key in keys:
            ri = key & self.rot_mask
            key >>= self.scale_shift
            si = key & self.scale_mask
            key >>= self.trans_shift
            ti = key & self.trans_mask
            q = struct.unpack_from("<4h", self.d, self.rot_o + ri * 8)
            s = struct.unpack_from("<3h", self.d, self.scale_o + si * 6)
            t = struct.unpack_from("<3h", self.d, self.trans_o + ti * 6)
            out.append((tuple(c / 4096.0 for c in q), tuple(c / 4096.0 for c in s), t))
        return out


def quat_matrix(q):
    x, y, z, w = q
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def mat_vec(m, v):
    return tuple(sum(m[i][k] * v[k] for k in range(3)) for i in range(3))


IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]


def node_worlds(mop, pose):
    """World (R, T) per node. Local = R(q) * diag(scale), translation as is.
    pose None -> identity for every node."""
    n = mop.node_count
    world = [None] * n

    def get(i):
        if world[i] is not None:
            return world[i]
        if pose is None:
            lr, lt = IDENT, (0, 0, 0)
        else:
            q, s, t = pose[i]
            r = quat_matrix(q)
            lr = [[r[a][b] * s[b] for b in range(3)] for a in range(3)]  # R * diag(s)
            lt = t
        par = mop.parents[i]
        if par < 0 or par == i:
            world[i] = (lr, tuple(lt))
        else:
            pr, pt = get(par)
            t = mat_vec(pr, lt)
            world[i] = (mat_mul(pr, lr), (t[0] + pt[0], t[1] + pt[1], t[2] + pt[2]))
        return world[i]

    for i in range(n):
        get(i)
    return world


# ---------------------------------------------------------------- build mesh
def to_out(v):
    """PS1 (x right, y down, z into screen) -> Y-up right-handed."""
    return (v[0], -v[1], -v[2])


def build_model(tmd, mop, pose, vram):
    worlds = node_worlds(mop, pose)
    # object -> list of nodes that move it (normally one)
    obj_nodes = {}
    for node, obj in enumerate(mop.objects):
        if 0 <= obj < len(tmd):
            obj_nodes.setdefault(obj, []).append(node)
    unmoved = [i for i in range(len(tmd)) if i not in obj_nodes]

    # texture pages: key (tpx,tpy,mode,cx,cy) -> uv bbox
    tris = []  # (positions[3], normals[3], uv[3] or None, matkey)
    for oi, obj in enumerate(tmd):
        nodes = obj_nodes.get(oi)
        if not nodes:
            continue  # TMD object no node moves; reported by caller
        R, T = worlds[nodes[0]]
        pv = [tuple(R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2] + T[i] for i in range(3))
              for v in obj["verts"]]
        pn = [mat_vec(R, nn) for nn in obj["norms"]]
        for pr in obj["prims"]:
            n = len(pr.verts)
            idx = [0, 1, 2] if n == 3 else [0, 1, 2, 2, 1, 3]
            if pr.uvs is not None:
                us = [u for u, _ in pr.uvs]
                vs = [v for _, v in pr.uvs]
                mat = ("tex", pr.tsb & 0x9F, pr.cba,
                       (min(us), min(vs), min(255, max(us) + 1), min(255, max(vs) + 1)))
            else:
                mat = ("col", pr.color)
            for t in range(0, len(idx), 3):
                tri = idx[t:t + 3]
                tris.append((
                    [to_out(pv[pr.verts[k]]) for k in tri],
                    [to_out(pn[pr.norms[k]]) if pr.norms[k] < len(pn) else (0, 1, 0) for k in tri],
                    [pr.uvs[k] for k in tri] if pr.uvs else None,
                    mat,
                ))
    return tris, unmoved


def fix_winding(tris):
    """Pick the winding that makes geometric normals agree with vertex normals
    (global majority). Returns (flipped?, agree_ratio)."""
    agree = disagree = 0
    for pos, nrm, _uv, _m in tris:
        a, b, c = pos
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        g = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        s = sum(g[i] * (nrm[0][i] + nrm[1][i] + nrm[2][i]) for i in range(3))
        if s > 0:
            agree += 1
        elif s < 0:
            disagree += 1
    total = max(1, agree + disagree)
    return disagree > agree, max(agree, disagree) / total


# ---------------------------------------------------------------- atlas
PAD = 1


def build_atlas(tris, vram):
    """Pack every distinct (tpage, clut, uv box) patch, plus solid colours, into
    one RGBA atlas. Returns (W, H, rgba, {mat: (ax, ay)})."""
    mats = []
    for _p, _n, _uv, mat in tris:
        if mat not in mats:
            mats.append(mat)

    def size(mat):
        if mat[0] == "tex":
            u0, v0, u1, v1 = mat[3]
            return u1 - u0 + 1, v1 - v0 + 1
        return 2, 2

    order = sorted(mats, key=lambda m: -size(m)[1])
    for W in (128, 256, 512, 1024):
        pos, x, y, rowh, ok = {}, 0, 0, 0, True
        for m in order:
            w, h = size(m)
            w += PAD * 2
            h += PAD * 2
            if w > W:
                ok = False
                break
            if x + w > W:
                x, y, rowh = 0, y + rowh, 0
            pos[m] = (x + PAD, y + PAD)
            x += w
            rowh = max(rowh, h)
        if ok and y + rowh <= W * 2:
            break
    H = 1
    while H < y + rowh:
        H *= 2
    px = bytearray(W * H * 4)
    for m, (ax, ay) in pos.items():
        w, h = size(m)
        for yy in range(-PAD, h + PAD):
            for xx in range(-PAD, w + PAD):
                sx = min(max(xx, 0), w - 1)
                sy = min(max(yy, 0), h - 1)
                if m[0] == "tex":
                    _t, tsb, cba, (u0, v0, _u1, _v1) = m
                    c = texel(vram, tsb, cba, u0 + sx, v0 + sy)
                else:
                    c = (m[1][0], m[1][1], m[1][2], 255)
                o = ((ay + yy) * W + ax + xx) * 4
                px[o:o + 4] = bytes(c)
    return W, H, bytes(px), pos


def atlas_uv(mat, uv, pos, W, H):
    """Texture coordinate (OBJ convention, v up) of a primitive vertex uv."""
    ax, ay = pos[mat]
    if mat[0] == "tex":
        u0, v0 = mat[3][0], mat[3][1]
        return (ax + uv[0] - u0) / W, 1 - (ay + uv[1] - v0) / H
    return (ax + 1) / W, 1 - (ay + 1) / H


# ---------------------------------------------------------------- OBJ output
def write_obj(outdir, name, tris, atlas, flip):
    os.makedirs(outdir, exist_ok=True)
    W, H, rgba, pos = atlas
    write_png(os.path.join(outdir, name + ".png"), W, H, rgba)
    with open(os.path.join(outdir, name + ".mtl"), "w") as f:
        f.write(("newmtl %s" + chr(10) + "Kd 1 1 1" + chr(10) + "map_Kd %s.png" + chr(10)
                 + "map_d %s.png" + chr(10)) % (name, name, name))
    lines = ["mtllib %s.mtl" % name, "o %s" % name, "usemtl %s" % name]
    vi = 0
    o = [2, 1, 0] if flip else [0, 1, 2]
    for p3, nrm, uv, mat in tris:
        face = []
        for k in o:
            lines.append("v %.4f %.4f %.4f" % p3[k])
            lines.append("vn %.4f %.4f %.4f" % nrm[k])
            u, v = atlas_uv(mat, uv[k] if uv else (0, 0), pos, W, H)
            lines.append("vt %.5f %.5f" % (u, v))
            vi += 1
            face.append("%d/%d/%d" % (vi, vi, vi))
        lines.append("f " + " ".join(face))
    with open(os.path.join(outdir, name + ".obj"), "w") as f:
        f.write(chr(10).join(lines) + chr(10))


# ---------------------------------------------------------------- preview
def render_preview(path, tris, atlas, flip, size=512, yaw=math.pi, bounds=None, transparent=False):
    """Tiny z-buffer renderer, orthographic, looking down -Z."""
    cy, sy = math.cos(yaw), math.sin(yaw)

    def rot(p):
        return (p[0] * cy + p[2] * sy, p[1], -p[0] * sy + p[2] * cy)

    allp = [rot(p) for t in tris for p in t[0]]
    if not allp:
        return None
    minx = min(p[0] for p in allp)
    maxx = max(p[0] for p in allp)
    miny = min(p[1] for p in allp)
    maxy = max(p[1] for p in allp)
    fill = 0.92
    if bounds:  # (minx, maxx, miny, maxy) in the model space to fill the picture with, yaw 0 axes
        minx, maxx, miny, maxy = bounds
        fill = 1.0
    scale = (size * fill) / max(maxx - minx, maxy - miny, 1)
    ox = size / 2 - (minx + maxx) / 2 * scale
    oy = size / 2 + (miny + maxy) / 2 * scale
    img = bytearray(([0, 0, 0, 0] if transparent else [40, 40, 48, 255]) * (size * size))
    zbuf = [1e30] * (size * size)
    light = (0.3, 0.5, 0.8)
    for pos, nrm, uv, mat in tris:
        pp = [rot(p) for p in pos]
        sp = [(p[0] * scale + ox, -p[1] * scale + oy, -p[2]) for p in pp]
        x0, y0, _ = sp[0]
        x1, y1, _ = sp[1]
        x2, y2, _ = sp[2]
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(area) < 1e-6:
            continue
        # backface cull: screen area sign vs flip (y screen is inverted)
        front = area < 0
        if flip:
            front = not front
        if not front:
            continue
        nz = sum(rot(n)[2] for n in nrm) / 3
        shade = 0.55 + 0.45 * max(0.0, nz * light[2] + 0.3)
        minx_i = max(0, int(min(x0, x1, x2)))
        maxx_i = min(size - 1, int(max(x0, x1, x2)) + 1)
        miny_i = max(0, int(min(y0, y1, y2)))
        maxy_i = min(size - 1, int(max(y0, y1, y2)) + 1)
        AW, AH, argba, apos = atlas
        for y in range(miny_i, maxy_i + 1):
            for x in range(minx_i, maxx_i + 1):
                px, py = x + 0.5, y + 0.5
                w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area
                w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area
                w2 = 1 - w0 - w1
                if w0 < -1e-4 or w1 < -1e-4 or w2 < -1e-4:
                    continue
                z = w0 * sp[0][2] + w1 * sp[1][2] + w2 * sp[2][2]
                if z >= zbuf[y * size + x]:
                    continue
                if uv is not None:
                    u = w0 * uv[0][0] + w1 * uv[1][0] + w2 * uv[2][0]
                    v = w0 * uv[0][1] + w1 * uv[1][1] + w2 * uv[2][1]
                    ax, ay = apos[mat]
                    tx = ax + min(mat[3][2] - mat[3][0], max(0, int(u - mat[3][0])))
                    ty = ay + min(mat[3][3] - mat[3][1], max(0, int(v - mat[3][1])))
                    o = (ty * AW + tx) * 4
                    if argba[o + 3] == 0:
                        continue
                    c = (argba[o], argba[o + 1], argba[o + 2])
                else:
                    c = mat[1]
                zbuf[y * size + x] = z
                o = (y * size + x) * 4
                img[o] = min(255, int(c[0] * shade))
                img[o + 1] = min(255, int(c[1] * shade))
                img[o + 2] = min(255, int(c[2] * shade))
                img[o + 3] = 255
    if path:
        write_png(path, size, size, bytes(img))
    return bytes(img)


# ---------------------------------------------------------------- main
SHEET = []
SHEET_CELL = 200


def write_sheet(path):
    if not SHEET:
        return
    cols = 5
    rows = (len(SHEET) + cols - 1) // cols
    W, H = cols * SHEET_CELL, rows * SHEET_CELL
    out = bytearray(W * H * 4)
    for i, (_cid, img) in enumerate(SHEET):
        if img is None:
            continue
        cx, cy = (i % cols) * SHEET_CELL, (i // cols) * SHEET_CELL
        for y in range(SHEET_CELL):
            o = ((cy + y) * W + cx) * 4
            out[o:o + SHEET_CELL * 4] = img[y * SHEET_CELL * 4:(y + 1) * SHEET_CELL * 4]
    write_png(path, W, H, bytes(out))


def rip_one(chara_dir, out_dir, cid, args):
    base = os.path.join(chara_dir, "%02d" % cid)
    tmd_p, tim_p, mop_p = base + ".tmd", base + ".tim", base + ".mop"
    if not (os.path.exists(tmd_p) and os.path.exists(tim_p) and os.path.exists(mop_p)):
        print("%02d: files missing, skipped" % cid)
        return
    tmd = parse_tmd(open(tmd_p, "rb").read())
    mop = Mop(open(mop_p, "rb").read())
    vram = Vram()
    tims = load_tims(vram, open(tim_p, "rb").read())

    if args.list_clips:
        print("%02d: %d nodes, %d clips: %s" % (
            cid, mop.node_count, mop.clip_count, [c[0] for c in mop.clips]))
        return

    pose = None if args.bind else mop.pose(args.clip, args.frame)
    tris, unmoved = build_model(tmd, mop, pose, vram)
    flip, ratio = fix_winding(tris)
    atlas = build_atlas(tris, vram)
    name = "chara%02d" % cid
    sub = os.path.join(out_dir, name)
    write_obj(sub, name, tris, atlas, flip)
    if args.preview:
        render_preview(os.path.join(sub, name + "_front.png"), tris, atlas, flip)
        render_preview(os.path.join(sub, name + "_side.png"), tris, atlas, flip, yaw=math.pi / 2)
        SHEET.append((cid, render_preview(None, tris, atlas, flip, size=SHEET_CELL)))
    print("%02d: %d tris, atlas %dx%d (%d TIMs), winding flip=%s agree=%.0f%%%s" % (
        cid, len(tris), atlas[0], atlas[1], len(tims), flip, ratio * 100,
        ", TMD objects without node: %s" % unmoved if unmoved else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("chara_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--ids", type=int, nargs="*")
    ap.add_argument("--clip", type=int, default=0)
    ap.add_argument("--frame", type=int, default=0)
    ap.add_argument("--bind", action="store_true")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--list-clips", action="store_true")
    args = ap.parse_args()
    ids = args.ids
    if not ids:
        ids = sorted(int(f[:2]) for f in os.listdir(args.chara_dir)
                     if f.endswith(".tmd") and f[:2].isdigit())
    for cid in ids:
        rip_one(args.chara_dir, args.out_dir, cid, args)
    if args.preview:
        write_sheet(os.path.join(args.out_dir, "contact_sheet.png"))


if __name__ == "__main__":
    sys.exit(main())
