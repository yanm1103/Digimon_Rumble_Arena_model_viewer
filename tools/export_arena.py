#!/usr/bin/env python3
"""Bakes the Boss arena's four spinning bands (map/map06.dmm, nodes 0..3 + the floor strip, node 4) for the site:

  public/arena/boss.json   {bands: [{pos, uv, col, additive}]}  (triangle lists, PS1 space: x right, y down, z forward)
  public/arena/boss.png    one texture atlas (the game's 4 bit CLUT textures, already resolved to RGBA)

Not in the file: the colourful lattice (it is code, StageBoss's func_800D4958 / func_800D4A00 / func_800D4B78, rebuilt in
src/main.js) nor the full screen feedback effect.  Input: map06.dmm from the disc's /map folder.

  python -I tools/export_arena.py <map06.dmm> [out_dir=public/arena]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rip_map as M  # noqa: E402
import rip_models as R  # noqa: E402


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "public", "arena")
    os.makedirs(out, exist_ok=True)
    m = M.read_dmm(src)
    # every vertex of every prim, per node, with the game's vertex colour (128 = 1.0) and the atlas uv
    node_tris = {}
    for node, ti in enumerate(m["tmd_of"]):
        tris = []
        for obj in m["tmds"][ti]:
            pv = obj["verts"]
            for pr in obj["prims"]:
                n = len(pr.verts)
                idx = [0, 1, 2] if n == 3 else [0, 1, 2, 2, 1, 3]
                if pr.uvs is None:
                    continue
                us = [u for u, _ in pr.uvs]
                vs = [v for _, v in pr.uvs]
                mat = ("tex", pr.tsb & 0x9F, pr.cba, (min(us), min(vs), min(255, max(us) + 1), min(255, max(vs) + 1)))
                for t in range(0, len(idx), 3):
                    tri = idx[t:t + 3]
                    tris.append(([pv[pr.verts[k]] for k in tri], [pr.uvs[k] for k in tri],
                                 [(128, 128, 128) if pr.raw else pr.cols[k] for k in tri], mat, pr.abe))
        node_tris[node] = tris
    allmats = [(0, 0, 0, t[3]) for tris in node_tris.values() for t in tris]
    atlas = R.build_atlas([(None, None, None, t[3]) for tris in node_tris.values() for t in tris], m["vram"])
    W, H, rgba, pos = atlas
    R.write_png(os.path.join(out, "boss.png"), W, H, rgba)
    bands = []
    for node in sorted(node_tris):
        P, UV, C = [], [], []
        additive = True
        for verts, uvs, cols, mat, abe in node_tris[node]:
            additive = additive and abe
            for k in range(3):
                P += list(verts[k])
                u, v = R.atlas_uv(mat, uvs[k], pos, W, H)
                UV += [round(u, 5), round(v, 5)]
                C += [round(c / 128.0, 4) for c in cols[k]]
        bands.append({"node": node, "pos": P, "uv": UV, "col": C, "additive": additive})
    with open(os.path.join(out, "boss.json"), "w") as f:
        json.dump({"bands": bands}, f, separators=(",", ":"))
    print("bands:", [(b["node"], len(b["pos"]) // 9, b["additive"]) for b in bands], "atlas", W, H)


if __name__ == "__main__":
    main()
