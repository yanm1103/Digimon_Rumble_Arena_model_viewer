#!/usr/bin/env python3
"""Rip a Digimon Rumble Arena stage (map/mapNN.dmm, a "2MMD" MeshSceneFile).

Layout (include/engine/gfx/mesh_scene.h in the decomp): u32 magic, u32 5; 32 TMD offsets at 0x08; 32 collision-table
offsets at 0x88; nodes offset at 0x108; TIM block at 0x10C.  nodes = s16 n, 4 arrays of n s16 (tmd, parent, unk,
hidden), then n poses of 16 bytes (s16 quaternion x4 / 4096, s16 translation x3, pad).

  python rip_map.py <map.dmm> [--preview out_prefix]
"""
import argparse
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rip_models as R  # noqa: E402


class MapPrim:
    """Like rip_models.Prim, plus the vertex colours and whether the prim is lit."""


def parse_tmd_unlit(d):
    """TMD parser that also handles the stage's unlit prims (flag bit 0: vertex indices only) and keeps the vertex
    colours.  Returns objs of {verts, norms, prims}; prims have .verts .uvs .tsb .cba .cols .abe .lit."""
    magic, flags, nobj = struct.unpack_from("<III", d, 0)
    assert magic == 0x41 and flags & 1 == 0
    objs = []
    for i in range(nobj):
        vt, nv, nt, nn, pt, npr, sc = struct.unpack_from("<7I", d, 12 + i * 28)
        verts = [struct.unpack_from("<hhh", d, 12 + vt + k * 8) for k in range(nv)]
        norms = [tuple(c / 4096.0 for c in struct.unpack_from("<hhh", d, 12 + nt + k * 8)) for k in range(nn)]
        prims = []
        p = 12 + pt
        for _ in range(npr):
            olen, ilen, flag, mode = struct.unpack_from("<BBBB", d, p)
            q = p + 4
            pr = MapPrim()
            pr.obj = i
            pr.tsb = pr.cba = 0
            pr.uvs = None
            pr.abe = bool(mode & 2)
            pr.raw = bool(mode & 1)  # TGE: the texture is drawn as it is, the vertex colours are not applied
            lit = not (flag & 1)
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
            nc = n if gouraud else 1
            pr.cols = [tuple(d[q + k * 4:q + k * 4 + 3]) for k in range(nc)]
            if nc == 1:
                pr.cols = pr.cols * n
            q += nc * 4
            if not lit:
                vs = list(struct.unpack_from("<%dH" % n, d, q))
                pr.norms = [0] * n
            elif gouraud:
                nv_ = [struct.unpack_from("<HH", d, q + k * 4) for k in range(n)]
                pr.norms = [a for a, _ in nv_]
                vs = [b for _, b in nv_]
            else:
                n0, v0 = struct.unpack_from("<HH", d, q)
                rest = struct.unpack_from("<HH", d, q + 4)
                vs = [v0, rest[0], rest[1]]
                if quad:
                    vs.append(struct.unpack_from("<HH", d, q + 8)[0])
                pr.norms = [n0] * n
            pr.verts = vs
            pr.lit = lit
            pr.color = pr.cols[0]
            prims.append(pr)
            p += 4 + ilen * 4
        objs.append({"verts": verts, "norms": norms, "prims": prims})
    return objs


def read_dmm(path):
    d = open(path, "rb").read()
    assert d[:4] == b"2MMD", "not a DMM"
    tm = [struct.unpack_from("<I", d, 8 + 4 * i)[0] for i in range(32)]
    co = [struct.unpack_from("<I", d, 0x88 + 4 * i)[0] for i in range(32)]
    nodes_o, tims_o = struct.unpack_from("<II", d, 0x108)
    tm = [x for x in tm if x]
    co = [x for x in co if x]
    n = struct.unpack_from("<h", d, nodes_o)[0]
    p = nodes_o + 2
    arrs = [list(struct.unpack_from("<%dh" % n, d, p + 2 * n * i)) for i in range(4)]
    p += 8 * n
    poses = []
    for i in range(n):
        q = struct.unpack_from("<4h", d, p + 16 * i)
        t = struct.unpack_from("<3h", d, p + 16 * i + 8)
        poses.append((tuple(c / 4096.0 for c in q), t))
    ends = (sorted(tm + [co[0] if co else tims_o]))
    tmds = []
    for o in tm:
        e = min([x for x in ends if x > o] or [len(d)])
        tmds.append(parse_tmd_unlit(d[o:e]))
    vram = R.Vram()
    tims = R.load_tims(vram, d[tims_o:])
    return {"tmds": tmds, "tmd_of": arrs[0], "parent": arrs[1], "hidden": arrs[3], "poses": poses,
            "vram": vram, "tims": tims, "coll": co}


def node_world(m, i):
    q, t = m["poses"][i]
    r = R.quat_matrix(q)
    par = m["parent"][i]
    if par < 0 or par == i:
        return r, tuple(t)
    pr, pt = node_world(m, par)
    tt = R.mat_vec(pr, t)
    return R.mat_mul(pr, r), (tt[0] + pt[0], tt[1] + pt[1], tt[2] + pt[2])


def build_tris(m):
    tris = []
    for node, ti in enumerate(m["tmd_of"]):
        if not (0 <= ti < len(m["tmds"])):
            continue
        Rm, T = node_world(m, node)
        for obj in m["tmds"][ti]:
            pv = [tuple(Rm[i][0] * v[0] + Rm[i][1] * v[1] + Rm[i][2] * v[2] + T[i] for i in range(3))
                  for v in obj["verts"]]
            pn = [R.mat_vec(Rm, nn) for nn in obj["norms"]]
            for pr in obj["prims"]:
                n = len(pr.verts)
                idx = [0, 1, 2] if n == 3 else [0, 1, 2, 2, 1, 3]
                if pr.uvs is not None:
                    us = [u for u, _ in pr.uvs]
                    vs = [v for _, v in pr.uvs]
                    mat = ("tex", pr.tsb & 0x9F, pr.cba, (min(us), min(vs), min(255, max(us) + 1), min(255, max(vs) + 1)))
                else:
                    mat = ("col", pr.color)
                for t in range(0, len(idx), 3):
                    tri = idx[t:t + 3]
                    tris.append(([R.to_out(pv[pr.verts[k]]) for k in tri],
                                 [R.to_out(pn[pr.norms[k]]) if pr.lit and pr.norms[k] < len(pn) else (0, 1, 0) for k in tri],
                                 [pr.uvs[k] for k in tri] if pr.uvs else None, mat))
    return tris


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dmm")
    ap.add_argument("--preview")
    a = ap.parse_args()
    m = read_dmm(a.dmm)
    tris = build_tris(m)
    atlas = R.build_atlas(tris, m["vram"])
    print(len(tris), "tris, atlas", atlas[0], atlas[1])
    if a.preview:
        for flip in (False, True):
            for nm, yaw in (("front", math.pi), ("side", math.pi / 2)):
                R.render_preview("%s_%s_%d.png" % (a.preview, nm, flip), tris, atlas, flip, size=700, yaw=yaw)
        R.write_png(a.preview + "_atlas.png", atlas[0], atlas[1], atlas[2])


if __name__ == "__main__":
    main()
