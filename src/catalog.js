// What the site shows. Each exported character is public/models/<PREFIX>0.glb (mesh, skeleton, idle and the list of animations);
// the animations are public/models/<PREFIX>/aNNN.glb, one per file (tools/export_glb.py). The list is the game's CHARACTER_* order.
// costumes: 0 = the game's colours, 1 = the other colours (the game tints every palette with a per-character HSV tint when both
// sides would look alike; tools/export_glb.py applies the same tint). Calumon has no other colors.
// zoom: camera dolly per character (wide wings or weapons make the framing box wide).
// The list shows public/icons/<prefix>.png (the face in the select screen's grid, 28x28) and the stage the name picture
// public/names/<prefix>.png; public/logos/<prefix>.png is the big art (bottom right of the stage). Calumon has none of them in the
// game: his icon (28x28, same style) and public/logos/calumon.png were drawn by hand, and he has `nameImage: false` (his name is text).
export const MONSTERS = [
  { prefix: "AGUMON", name: "Agumon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "GALLANTMON", name: "Gallantmon", costumes: [0, 1], labels: ["default", "other colors"], zoom: 1.2 },
  { prefix: "GABUMON", name: "Gabumon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "GUILMON", name: "Guilmon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "MAGNADRAMON", name: "Magnadramon", costumes: [0, 1], labels: ["default", "other colors"], zoom: 1.3 },
  { prefix: "IMPERIALDRAMON", name: "Imperialdramon", costumes: [0, 1], labels: ["default", "other colors"], zoom: 1.2 },
  { prefix: "IMPERIALDRAMONPM", name: "Imperialdramon Paladin Mode", costumes: [0, 1], labels: ["default", "other colors"], zoom: 1.2 },
  { prefix: "IMPMON", name: "Impmon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "BEELZEMON", name: "Beelzemon", costumes: [0, 1], labels: ["default", "other colors"], zoom: 1.2 },
  { prefix: "METALGARURUMON", name: "MetalGarurumon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "OMNIMON", name: "Omnimon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "PATAMON", name: "Patamon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "RENAMON", name: "Renamon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "SAKUYAMON", name: "Sakuyamon", costumes: [0, 1], labels: ["default", "other colors"], zoom: 1.2 },
  { prefix: "MEGAGARGOMON", name: "MegaGargomon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "SERAPHIMON", name: "Seraphimon", costumes: [0, 1], labels: ["default", "other colors"], zoom: 1.3 },
  { prefix: "STINGMON", name: "Stingmon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "GATOMON", name: "Gatomon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "TERRIERMON", name: "Terriermon", costumes: [0, 1], labels: ["default", "other colors"], zoom: 1.2 },
  { prefix: "VEEMON", name: "Veemon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "WORMMON", name: "Wormmon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "WARGREYMON", name: "WarGreymon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "REAPERMON", name: "Reapermon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "BLACKWARGREYMON", name: "BlackWarGreymon", costumes: [0, 1], labels: ["default", "other colors"] },
  { prefix: "CALUMON", name: "Calumon", costumes: [0], zoom: 1.2, nameImage: false },
];
