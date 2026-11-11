# Digimon Rumble Arena Model Viewer

A browser 3D viewer for the 25 characters of *Digimon Rumble Arena* (PS1): meshes, textures, skeletons and every animation
of each one. A fan project by TwistZero, built the same way as the
[War of the Monsters Model Museum](https://github.com/yanm1103/wotm-model-museum) and the
[Godzilla: Save the Earth Model Viewer](https://github.com/yanm1103/godzilla-save-the-earth-model-viewer)
(Vite + three.js, same layout).

## Run it

```
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/, what GitHub Pages serves (the workflow does it on every push to master)
```

## Where the models come from

`public/models/` holds the baked `.glb` files: `<NAME>0.glb` per character (mesh, skeleton, texture, the idle, the list of
animations) and `<NAME>/aNNN.glb`, one small file per animation. `tools/export_glb.py` makes them from the game's own files,
with no packages (pure Python 3):

```
python tools/export_glb.py <folder with NN.tmd NN.tim NN.mop> [--only AGUMON,VMON] [--icons <title/charasel.tim>]
```

The input is the `/chara` folder of the disc (`A.VFS`), extracted with the decomp project's `tools/unpack_vfs.py`
(<https://github.com/ReGame-Labs/dtbe_decomp>). `--icons` takes the disc's `title/charasel.tim` and writes the select screen's portraits (108 x 120, 8 bit, one palette each;
picture n is character n; palette index 0 is transparent) to `public/logos/`. Calumon has none, so the list shows its name.
The disc and its files never go in this repo, only the baked output.
`tools/rip_models.py` is the same decoder as a stand-alone OBJ ripper (`python tools/rip_models.py <chara> <out> --preview`).

What the formats are:

- `NN.tmd`: a standard Sony TMD, one object per body part (offsets count from byte 12). Primitives: textured
  triangles and quads (flat or Gouraud), a few untextured ones.
- `NN.tim`: up to 84 small TIMs back to back, loaded into a 1024x512 VRAM; each primitive picks its texture with a
  texture page + a CLUT, so the exporter builds one atlas out of the used rectangles. Black texels are transparent.
- `NN.mop`: the node tree (parent of each node, which TMD object each node moves) and 33 clips of one key per node per
  frame. A key packs indices into a quaternion, a scale and a translation table. The local matrix is R(q) * diag(scale)
  with the translation as is. There is no skinning in the game: here every vertex is skinned 100% to its part's node.
- The clips are the same for every character (`FighterClip` in the decomp: STAND, WALK, DASH, ... SPECIAL1, WIN_POSE...).
  The pose of clip 0 (STAND) frame 0 is the bind pose: every rotation is the identity.
- The animations run at 30 frames per second (`FPS` in `src/main.js` and `tools/export_glb.py`). A first guess of 60,
  from reading the code, played at double speed on the site.

## Interface pictures

`python tools/export_ui.py --charasel <title/charasel.tim> --title <title/title.tim> --menu <title/mainmenu.tim>` cuts, from the disc's TIMs:
the two logos (`public/ui`: the RUMBLE ARENA picture is stored as two halves 48 empty columns apart, which are joined),
the orange player-1 selector frame (`public/ui/select-frame.png`, the "1" badge painted out; shown around the picked Digimon) and the cyan player-2 one (`hover-frame.png`, the hover),
each Digimon's name as the select screen writes it (`public/names`), and the face of each Digimon in the select screen's grid
(`public/icons`, 24x24, cell -> character from `GRID_CELLS`). `public/logos` is the big art (`export_glb.py --icons`), shown
bottom right of the stage. Names are the US ones (Gallantmon, Magnadramon, Beelzemon, Omnimon, MegaGargomon, Gatomon, Veemon,
Reapermon): the decomp uses the Japanese ones. Both menus use the main menu's own background (`--menu`: `public/ui/menu-tile.png`, the hexagons that say DIGIMON, repeating every 229x40 px,
rebuilt from the 512x480 picture, and `menu-edge-left/right.png`, the dark side layer with circles that shrink away from the border,
9 px high, a black at 22% opacity); the steel header and footer (the main menu's top and bottom plates: five colours, a dark window with slanted ends), navy and pill buttons are CSS only. Calumon is not in the select screen: his picture
(`public/logos/calumon.png`) was drawn by hand and his name is text.

## Other colors

Every character except Calumon has a second costume, "other colors": the game does not store a second texture, it tints every
palette of the character at load time (`charaLoadTims` -> `tintTim` -> `shiftColors`) with one HSV tint per character, used when both
sides would look alike. `tools/export_glb.py` has that table (`TINTS`, from the executable) and `tools/rip_models.py` the same
integer RGB<->HSV code as the game (`shift_color`), so `<NAME>1.glb` has the atlas of the tinted palettes and shares the animation
files of `<NAME>0.glb`.

## Not done

- The faces: the game changes eyes and mouths at run time by copying small pictures in VRAM (`FaceEntry`), so what shows is
  the texture as stored.
- The models of stages and effects.
- Sounds.
