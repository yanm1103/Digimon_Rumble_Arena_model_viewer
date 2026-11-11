#!/usr/bin/env python3
"""Bakes the characters of Digimon Rumble Arena (PS1; US SLUS-014.04, JP SLPS-03357) into the .glb files the site loads,
in the layout of the War of the Monsters Model Museum / Godzilla: Save the Earth Model Viewer:

  public/models/<PREFIX>0.glb        mesh, skeleton, texture, the idle clip ("idle") and, in the scene extras, the list
                                     of animations ({k, id, name, frames, file[, first]})
  public/models/<PREFIX>/aNNN.glb    one animation per file (node names + keys); the site merges them (src/glbmerge.js)
  public/logos/<prefix>.png          the game's select screen portrait for the character list (--icons)

Input: the extracted /chara folder of the disc (NN.tmd, NN.tim, NN.mop; see README.md). Pure Python, no packages.

How the game's data maps to glTF:
  * a character is a TMD of rigid parts (one TMD object per part) and a MoP animation file: a node tree whose node i moves
    TMD object objects[i]; each clip has a key per node per frame (rotation quaternion, scale, translation). There is no
    skinning in the game; here every vertex is skinned 100% to its part's node, so the .glb is a normal skinned mesh
    (bones view, wireframe, download all work as in the other viewers).
  * bind pose = clip 0 (STAND) frame 0, where every rotation is identity.
  * PS1 space is x right, y down, z into the screen (right handed); a root node rotates it 180 degrees about X into glTF's
    Y up, so nothing inside needs mirroring.
  * the game runs its animations at 30 frames per second (FPS below; 60 played at double speed on the site).
"""
import argparse
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rip_models as R  # noqa: E402

FPS = 30

# the game's own names for the clips of every fighter (FighterClip in the decomp's game_classes.h); 32 is not named there
CLIP_NAMES = [
    "STAND", "WALK", "DASH", "JUMP", "FALL", "ATTACK1", "ATTACK2", "ATTACK3", "DASH_ATTACK", "AIR_ATTACK",
    "AIR_UP_ATTACK", "THROW", "GUARD", "FLINCH", "AIR_FLINCH", "DIZZY", "KNOCKED_DOWN", "DOWN", "GET_UP", "CROUCH",
    "CROUCH_ATTACK", "CROUCH_GUARD", "SPECIAL1", "AIR_SPECIAL1", "SPECIAL2", "AIR_SPECIAL2", "SPECIAL3",
    "AIR_SPECIAL3", "WIN_POSE", "END_POSE", "INTRO", "UP_ATTACK", "CLIP_32",
]

# the other colours of each character (one tint per character id, 0..23; Calumon has none): (hue, saturation, value).
# From the US executable (D_80064F44 in the decomp's battle_scene.rodata.s): the game applies it to every palette of the
# character when both sides would look alike (altColor). Hue is in 1/1536 of a turn; saturation and value scale by n / 128.
TINTS = [
    (672, 224, 128),
    (768, 128, 128),
    (768, 64, 128),
    (384, 160, 144),
    (384, 192, 128),
    (-608, 96, 176),
    (688, 224, 128),
    (384, 160, 128),
    (672, 176, 128),
    (704, 64, 192),
    (704, 160, 144),
    (-256, 56, 128),
    (-128, 144, 128),
    (-112, 127, 112),
    (352, 64, 160),
    (736, 144, 144),
    (-416, 112, 128),
    (-192, 128, 128),
    (448, 96, 120),
    (704, 96, 144),
    (-304, 112, 144),
    (768, 72, 112),
    (-192, 192, 96),
    (-224, 128, 128),
]

# character id (file NN) -> site prefix and name, as the US game shows them on its select screen (the decomp's names are the
# Japanese ones). Order = the game's CHARACTER_* ids; 24 is the title/menu character.
CHARACTERS = [
    ("AGUMON", "Agumon"), ("GALLANTMON", "Gallantmon"), ("GABUMON", "Gabumon"), ("GUILMON", "Guilmon"),
    ("MAGNADRAMON", "Magnadramon"), ("IMPERIALDRAMON", "Imperialdramon"),
    ("IMPERIALDRAMONPM", "Imperialdramon Paladin Mode"), ("IMPMON", "Impmon"), ("BEELZEMON", "Beelzemon"),
    ("METALGARURUMON", "MetalGarurumon"), ("OMNIMON", "Omnimon"), ("PATAMON", "Patamon"), ("RENAMON", "Renamon"),
    ("SAKUYAMON", "Sakuyamon"), ("MEGAGARGOMON", "MegaGargomon"), ("SERAPHIMON", "Seraphimon"),
    ("STINGMON", "Stingmon"), ("GATOMON", "Gatomon"), ("TERRIERMON", "Terriermon"), ("VEEMON", "Veemon"),
    ("WORMMON", "Wormmon"), ("WARGREYMON", "WarGreymon"), ("REAPERMON", "Reapermon"),
    ("BLACKWARGREYMON", "BlackWarGreymon"), ("CALUMON", "Calumon"),
]


# ------------------------------------------------------------------ glTF writer
class Gltf:
    def __init__(self):
        self.bin = bytearray()
        self.views = []
        self.accessors = []

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            v["target"] = target
        self.bin += data
        self.views.append(v)
        return len(self.views) - 1

    def accessor(self, data, ctype, kind, count, target=None, minmax=None):
        a = {"bufferView": self.view(data, target), "componentType": ctype, "type": kind, "count": count}
        if minmax:
            a["min"], a["max"] = minmax
        self.accessors.append(a)
        return len(self.accessors) - 1

    def floats(self, flat, kind, count, target=None, minmax=None):
        return self.accessor(struct.pack("<%df" % len(flat), *flat), 5126, kind, count, target, minmax)

    def glb(self, doc):
        doc = dict(doc)
        doc["asset"] = {"version": "2.0", "generator": "DRA tools/export_glb.py"}
        doc["bufferViews"] = self.views
        doc["accessors"] = self.accessors
        doc["buffers"] = [{"byteLength": len(self.bin)}]
        text = json.dumps(doc, separators=(",", ":")).encode()
        text += b" " * (-len(text) % 4)
        binary = bytes(self.bin) + b"\0" * (-len(self.bin) % 4)
        total = 12 + 8 + len(text) + 8 + len(binary)
        return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(text), 0x4E4F534A) + text
                + struct.pack("<II", len(binary), 0x004E4942) + binary)


def mat4_inverse_affine(Rm, T):
    """Inverse of x -> Rm x + T for a 3x3 Rm (general inverse). Returns column-major 16 floats."""
    a, b, c = Rm[0]
    d, e, f = Rm[1]
    g, h, i = Rm[2]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-12:
        det = 1e-12
    inv = [
        [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ]
    t = [-(inv[r][0] * T[0] + inv[r][1] * T[1] + inv[r][2] * T[2]) for r in range(3)]
    m = [[inv[0][0], inv[0][1], inv[0][2], t[0]], [inv[1][0], inv[1][1], inv[1][2], t[1]],
         [inv[2][0], inv[2][1], inv[2][2], t[2]], [0, 0, 0, 1]]
    return [m[r][c] for c in range(4) for r in range(4)]  # column-major


def qnorm(q):
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return tuple(c / n for c in q)


# ------------------------------------------------------------------ model
def build_mesh(tmd, mop, worlds, vram):
    """Triangles in PS1 bind space: list of (pos[3], nrm[3], uv[3]|None, mat, joint)."""
    obj_node = {}
    for node, obj in enumerate(mop.objects):
        if 0 <= obj < len(tmd) and obj not in obj_node:
            obj_node[obj] = node
    tris = []
    for oi, obj in enumerate(tmd):
        node = obj_node.get(oi)
        if node is None:
            continue
        Rm, T = worlds[node]
        pv = [tuple(Rm[i][0] * v[0] + Rm[i][1] * v[1] + Rm[i][2] * v[2] + T[i] for i in range(3))
              for v in obj["verts"]]
        pn = [R.mat_vec(Rm, n) for n in obj["norms"]]
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
                    [pv[pr.verts[k]] for k in tri],
                    [qnorm(pn[pr.norms[k]]) if pr.norms[k] < len(pn) else (0, -1, 0) for k in tri],
                    [pr.uvs[k] for k in tri] if pr.uvs else None,
                    mat,
                    node,
                ))
    return tris


def clip_tracks(mop, clip, bind):
    """Per node: times, and the T/R/S key lists of the clip, constant tracks collapsed to one key."""
    frames = mop.clips[clip][0]
    poses = [mop.pose(clip, f) for f in range(frames)]
    out = []
    for n in range(mop.node_count):
        rots, trs, scs = [], [], []
        prev = None
        for f in range(frames):
            q, s, t = poses[f][n]
            q = qnorm(q)
            if prev is not None and sum(a * b for a, b in zip(q, prev)) < 0:
                q = tuple(-c for c in q)  # same hemisphere as the previous key: slerp takes the short way
            prev = q
            rots.append(q)
            trs.append(tuple(float(c) for c in t))
            scs.append(tuple(float(c) for c in s))
        out.append((trs, rots, scs))
    return frames, out


def add_animation(g, mop, clip, bind_pose, name, node_offset, doc_anims):
    frames, tracks = clip_tracks(mop, clip, bind_pose)
    n_keys = max(frames, 2)
    if frames == 1:  # a pose: two equal keys, so the player has something to scrub
        tracks = [([t[0], t[0]], [r[0], r[0]], [s[0], s[0]]) for t, r, s in tracks]
    times = [i / FPS for i in range(n_keys)]
    t_acc = g.floats(times, "SCALAR", n_keys, minmax=([0.0], [times[-1]]))
    one_acc = g.floats([0.0], "SCALAR", 1, minmax=([0.0], [0.0]))
    samplers, channels = [], []

    def emit(node, path, keys, kind):
        const = all(k == keys[0] for k in keys)
        use = keys[:1] if const else keys
        flat = [c for k in use for c in k]
        out = g.floats(flat, kind, len(use))
        samplers.append({"input": one_acc if const else t_acc, "output": out, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": node, "path": path}})

    for n, (trs, rots, scs) in enumerate(tracks):
        node = node_offset + n
        emit(node, "translation", trs, "VEC3")
        emit(node, "rotation", rots, "VEC4")
        if any(abs(c - 1.0) > 1e-6 for s in scs for c in s):
            emit(node, "scale", scs, "VEC3")
    doc_anims.append({"name": name, "channels": channels, "samplers": samplers})
    return n_keys


def export_character(chara_dir, out_dir, cid, prefix, name, costume=0):
    """costume 0: the game's colours; 1: the other colours (TINTS). Costume 1 shares the animation files of costume 0."""
    base = os.path.join(chara_dir, "%02d" % cid)
    tmd = R.parse_tmd(open(base + ".tmd", "rb").read())
    mop = R.Mop(open(base + ".mop", "rb").read())
    vram = R.Vram()
    R.load_tims(vram, open(base + ".tim", "rb").read(), TINTS[cid] if costume else None)

    bind = mop.pose(0, 0)
    worlds = R.node_worlds(mop, bind)
    tris = build_mesh(tmd, mop, worlds, vram)
    flip, ratio = R.fix_winding([t[:4] for t in tris])
    atlas = R.build_atlas([t[:4] for t in tris], vram)
    W, H, rgba, pos = atlas

    # --- vertices, deduplicated
    seen, P, N, UV, J, I = {}, [], [], [], [], []
    for p3, n3, uv, mat, joint in tris:
        face = []
        for k in range(3):
            u, v = (uv[k] if uv else (0, 0))
            au, av = R.atlas_uv(mat, (u, v), pos, W, H)
            av = 1 - av  # glTF's v goes down; atlas_uv returns the OBJ convention
            key = (tuple(round(c, 3) for c in p3[k]), tuple(round(c, 4) for c in n3[k]),
                   round(au, 5), round(av, 5), joint)
            i = seen.get(key)
            if i is None:
                i = seen[key] = len(P)
                P.append(p3[k]), N.append(n3[k]), UV.append((au, av)), J.append(joint)
            face.append(i)
        I.extend([face[0], face[2], face[1]] if flip else face)

    g = Gltf()
    png_view = g.view(png_bytes(W, H, rgba))
    flatP = [c for p in P for c in p]
    pos_acc = g.floats(flatP, "VEC3", len(P), 34962,
                       ([min(p[i] for p in P) for i in range(3)], [max(p[i] for p in P) for i in range(3)]))
    nrm_acc = g.floats([c for n in N for c in n], "VEC3", len(N), 34962)
    uv_acc = g.floats([c for u in UV for c in u], "VEC2", len(UV), 34962)
    joints = b"".join(struct.pack("<4B", j, 0, 0, 0) for j in J)
    jnt_acc = g.accessor(joints, 5121, "VEC4", len(J), 34962)
    wgt_acc = g.floats([c for _ in J for c in (1.0, 0.0, 0.0, 0.0)], "VEC4", len(J), 34962)
    idx_acc = g.accessor(struct.pack("<%dH" % len(I), *I), 5123, "SCALAR", len(I), 34963)
    ibm = []
    for n in range(mop.node_count):
        ibm += mat4_inverse_affine(*worlds[n])
    ibm_acc = g.floats(ibm, "MAT4", mop.node_count)

    # --- nodes: 0 = root (PS1 -> Y up), 1..n = the parts in the game's tree, n+1 = the skinned mesh
    n_nodes = mop.node_count
    node_off = 1
    nodes = [{"name": "DRA", "rotation": [1.0, 0.0, 0.0, 0.0], "children": []}]
    children = {i: [] for i in range(n_nodes)}
    roots = []
    for i, par in enumerate(mop.parents):
        (children[par] if 0 <= par < n_nodes and par != i else roots).append(i)
    for i in range(n_nodes):
        q, s, t = bind[i]
        node = {"name": "part%02d" % i, "translation": [float(c) for c in t],
                "rotation": list(qnorm(q))}
        if any(abs(c - 1.0) > 1e-6 for c in s):
            node["scale"] = [float(c) for c in s]
        if children[i]:
            node["children"] = [node_off + c for c in children[i]]
        nodes.append(node)
    mesh_node = node_off + n_nodes
    nodes.append({"name": "body", "mesh": 0, "skin": 0})
    nodes[0]["children"] = [node_off + r for r in roots] + [mesh_node]

    # --- animations: the idle in this file, every clip with frames in its own file
    anims_doc, entries = [], []
    stem = "%s" % prefix
    adir = os.path.join(out_dir, stem)
    if not costume:
        os.makedirs(adir, exist_ok=True)
        for old in os.listdir(adir):
            os.remove(os.path.join(adir, old))
    for clip in range(mop.clip_count):
        if mop.clips[clip][0] == 0:
            continue
        cname = CLIP_NAMES[clip] if clip < len(CLIP_NAMES) else "CLIP_%d" % clip
        gg = Gltf()
        docs = []
        n_keys = add_animation(gg, mop, clip, bind, cname, 0, docs)
        file = "%s/a%03d.glb" % (stem, clip)
        small = {"scene": 0, "scenes": [{"nodes": list(range(n_nodes))}],
                 "nodes": [{"name": "part%02d" % i} for i in range(n_nodes)], "animations": docs}
        if not costume:
            open(os.path.join(out_dir, file), "wb").write(gg.glb(small))
        entry = {"k": clip, "id": clip, "name": cname, "frames": n_keys, "file": file}
        if clip == 0:
            entry["first"] = True
            add_animation(g, mop, 0, bind, "idle", node_off, anims_doc)
        entries.append(entry)

    doc = {
        "scene": 0,
        "scenes": [{"nodes": [0], "extras": {"bones": n_nodes, "parts": 0, "animations": entries}}],
        "nodes": nodes,
        "images": [{"bufferView": png_view, "mimeType": "image/png", "name": name}],
        "samplers": [{"magFilter": 9728, "minFilter": 9728, "wrapS": 33071, "wrapT": 33071}],
        "textures": [{"sampler": 0, "source": 0}],
        "materials": [{"name": "skin", "alphaMode": "MASK", "alphaCutoff": 0.5, "doubleSided": True,
                       "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0,
                                                "roughnessFactor": 1.0}}],
        "meshes": [{"name": "body", "primitives": [{"attributes": {
            "POSITION": pos_acc, "NORMAL": nrm_acc, "TEXCOORD_0": uv_acc, "JOINTS_0": jnt_acc,
            "WEIGHTS_0": wgt_acc}, "indices": idx_acc, "material": 0}]}],
        "skins": [{"name": "skin", "joints": [node_off + i for i in range(n_nodes)],
                   "inverseBindMatrices": ibm_acc}],
        "animations": anims_doc,
    }
    path = os.path.join(out_dir, "%s%d.glb" % (prefix, costume))
    open(path, "wb").write(g.glb(doc))
    return {"tris": len(I) // 3, "verts": len(P), "nodes": n_nodes, "anims": len(entries),
            "atlas": (W, H), "agree": ratio, "bytes": os.path.getsize(path)}


def png_bytes(w, h, rgba):
    import zlib
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * w * 4:(y + 1) * w * 4]

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def rip_icons(charasel_path, logos_dir):
    """The select screen's portraits (108 x 120, 8 bit, one CLUT each) from title/charasel.tim -> public/logos/<name>.png.
    Picture n is character n (0..23); 24 and 25 are not portraits. Palette index 0 is black = transparent."""
    vram = R.Vram()
    R.load_tims(vram, open(charasel_path, "rb").read())
    for pic in range(24):
        if pic < 8:
            col, xb, y0 = pic, 320, 256
        elif pic < 16:
            col, xb, y0 = pic - 8, 320, 256 + 120
        elif pic < 21:
            col, xb, y0 = pic - 16, 384, 0
        else:
            col, xb, y0 = pic - 21, 384, 120
        cx, cy = (320, 496 + pic) if pic < 16 else (384, 232 + pic)
        px = bytearray()
        for y in range(120):
            for x in range(108):
                hw = vram.get(xb + col * 54 + x // 2, y0 + y)
                c = vram.get(cx + ((hw >> (8 * (x & 1))) & 0xFF), cy)
                px += bytes((*R.bgr555(c), 0 if c == 0 else 255))
        with open(os.path.join(logos_dir, CHARACTERS[pic][0].lower() + ".png"), "wb") as f:
            f.write(png_bytes(108, 120, bytes(px)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("chara_dir", help="the extracted /chara folder (NN.tmd, NN.tim, NN.mop)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public"))
    ap.add_argument("--only", help="comma separated prefixes, e.g. AGUMON,V-MON")
    ap.add_argument("--icons", help="the disc's title/charasel.tim: writes the list portraits (public/logos)")
    args = ap.parse_args()
    only = {s.strip().upper() for s in args.only.split(",")} if args.only else None
    models = os.path.join(args.out, "models")
    logos = os.path.join(args.out, "logos")
    os.makedirs(models, exist_ok=True)
    os.makedirs(logos, exist_ok=True)
    if args.icons:
        rip_icons(args.icons, logos)
    for cid, (prefix, name) in enumerate(CHARACTERS):
        if only and prefix not in only:
            continue
        if not os.path.exists(os.path.join(args.chara_dir, "%02d.tmd" % cid)):
            print("%02d %s: files missing, skipped" % (cid, prefix))
            continue
        for costume in ((0, 1) if cid < len(TINTS) else (0,)):
            info = export_character(args.chara_dir, models, cid, prefix, name, costume)
            print("%02d %-18s c%d %4d tris %4d verts %2d nodes %2d anims atlas %dx%d %6.1f KB winding %.0f%%" % (
                cid, prefix, costume, info["tris"], info["verts"], info["nodes"], info["anims"], *info["atlas"],
                info["bytes"] / 1024, info["agree"] * 100))

if __name__ == "__main__":
    sys.exit(main())
