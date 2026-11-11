import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MONSTERS } from "./catalog.js";
import { mergeGlb } from "./glbmerge.js";
import { createArena } from "./arena.js";
import { createSfx } from "./sfx.js";

const BASE = import.meta.env.BASE_URL;
// the game's menu sounds (src/sfx.js); on unless the visitor turned them off (About panel)
const savedVolume = Number(recall("volume") ?? 100);
const sfx = createSfx(BASE, recall("sound") !== "off", Number.isFinite(savedVolume) ? Math.max(0, Math.min(100, savedVolume)) / 100 : 1);

// The PS1 does its color math straight on texture and vertex values, with no color space conversion. Turning off three.js
// color management keeps the texture colors as they are in the game.
THREE.ColorManagement.enabled = false;

// Camera: 3/4 view to the right, slightly above
const YAW = THREE.MathUtils.degToRad(35);
const PITCH = THREE.MathUtils.degToRad(8);
const FOVY = 30;

import { GAME_FONT } from "./gamefont.js";
const $ = (id) => document.getElementById(id);
const canvas = $("scene");
const selLight = $("light");
const stats = $("info");
const monsterName = $("monster-name");
const portrait = $("portrait");
const modelStats = $("model-stats");
const status = $("notice");
const download = $("download");
const downloadLabel = $("download-label");
const loadingBox = $("loader");
const loadingText = $("loader-text");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // BASE_PIXEL_RATIO (bigger while saving a big picture)
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.autoClear = false;
const backgroundColor = new THREE.Color(0x17181b);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOVY, 1, 1, 10000);
scene.add(camera);

// Floor grid like Blender's (and the GrandChase viewer's), on the game's ground (y = 0, where the monsters stand): thin
// lines every 10 game units, thick ones every 100, the X axis in red and the Z axis in green. It fades out away from the
// center (radius set per monster in placeGrid), and the thin lines fade out when they get too close together on screen.
const grid = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { cell: { value: 10 }, fade: { value: new THREE.Vector2(100, 300) } },
    vertexShader: `
      varying vec3 vP;
      void main() { vP = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP, 1.0); }`,
    fragmentShader: `
      uniform float cell;
      uniform vec2 fade;
      varying vec3 vP;
      float line(vec2 c) { vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c); return 1.0 - min(min(g.x, g.y), 1.0); }
      void main() {
        vec2 c = vP.xz / cell;
        vec2 d = fwidth(c);
        float thin = line(c) * (1.0 - smoothstep(0.2, 0.5, max(d.x, d.y)));   // gone when the cells are a few pixels wide
        float thick = line(c / 10.0);
        float axisX = 1.0 - min(abs(c.y) / d.y, 1.0);   // the X axis (red), z = 0
        float axisZ = 1.0 - min(abs(c.x) / d.x, 1.0);   // the Z axis (green), x = 0
        vec3 color = vec3(0.55);
        float a = max(thin * 0.35, thick * 0.6);
        if (axisX > 0.0) { color = mix(color, vec3(0.9, 0.25, 0.3), axisX); a = max(a, axisX * 0.9); }
        if (axisZ > 0.0) { color = mix(color, vec3(0.45, 0.75, 0.2), axisZ); a = max(a, axisZ * 0.9); }
        a *= 1.0 - smoothstep(fade.x, fade.y, length(vP.xz));
        if (a < 0.01) discard;
        gl_FragColor = vec4(color, a);
      }`,
  }),
);
grid.rotation.x = -Math.PI / 2;
grid.renderOrder = -1; // first among the see-through things: the monster's fire and wireframe go over it
grid.frustumCulled = false;
scene.add(grid);

// The Boss arena (round 1), an alternative to the plain background and grid (src/arena.js). stageOn is read by the camera
// limits and by the background, so it lives here with the scene.
const arena = createArena(BASE);
scene.add(arena.group);
let stageOn = false;
const STAGE_DOLLY = 2.2; // the game's camera is farther from the fighters than the viewer's close-up framing: back off in the arena

// size: the monster's framing box (largest side): the grid reaches about three times that around the center
function placeGrid(size) {
  grid.scale.set(size * 8, size * 8, 1);
  grid.material.uniforms.fade.value.set(size * 0.9, size * 3);
}

// Lighting: ambient + one directional light attached to the camera (so the light follows the camera).
// Intensities are the renderer's (color * (ambient + directional * max(0, n.L))); three.js Lambert divides by pi, hence * PI.
const ambient = new THREE.AmbientLight(0xffffff, 0);
const sun = new THREE.DirectionalLight(0xffffff, 0);
scene.add(ambient);
camera.add(sun, sun.target);

// The default light direction in camera space, in degrees: direction 0 = coming from behind the camera (lighting the
// monster's front), positive to the right; height 0 = horizontal. It does not depend on the monster.
const GAME_LIGHT = (() => {
  const dir = new THREE.Vector3(Math.sin(YAW) * Math.cos(PITCH), Math.sin(PITCH), -Math.cos(YAW) * Math.cos(PITCH));
  const cam = new THREE.PerspectiveCamera();
  cam.position.copy(dir);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  const L = new THREE.Vector3(Math.sin(YAW - 0.7) * 0.6, 0.8, -Math.cos(YAW - 0.7) * 0.6).normalize();
  const local = cam.worldToLocal(dir.clone().add(L));
  return {
    az: Math.round(THREE.MathUtils.radToDeg(Math.atan2(local.x, local.z))),
    el: Math.round(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)))),
  };
})();

const LIGHT_PRESETS = {
  game: { amb: 0.7, dir: 0.6, ...GAME_LIGHT },
  unlit: { amb: 1.5, dir: 0, ...GAME_LIGHT },
  side: { amb: 0.35, dir: 1.2, az: 85, el: 15 },
  top: { amb: 0.45, dir: 1, az: 10, el: 80 },
  back: { amb: 0.4, dir: 1.3, az: 160, el: 25 },
};

function applyLight({ amb, dir, az, el }) {
  ambient.intensity = amb * Math.PI;
  sun.intensity = dir * Math.PI;
  const a = THREE.MathUtils.degToRad(az);
  const e = THREE.MathUtils.degToRad(el);
  sun.position.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
  sun.target.position.set(0, 0, 0);
}

// Wireframe: a copy of each mesh bound to the same bones, with a wire material. The solid mesh is pushed back a little
// (polygonOffset) so the lines don't fight with it in "solid + wireframe".
const wireMaterial = new THREE.MeshBasicMaterial({ color: 0xc8ecff, wireframe: true, transparent: true, depthWrite: false });

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.1;

const gltfLoader = new GLTFLoader();
let lastTime = performance.now();
let current = null; // { root, mixer, bones, action, frames, file, idle, anims }
let request = 0;

// ---- visitor preferences (convenience only; the page works without them)
function remember(key, value) {
  try {
    localStorage.setItem("dra." + key, value);
  } catch {}
}
function recall(key) {
  try {
    return localStorage.getItem("dra." + key);
  } catch {
    return null;
  }
}

// scrolls only the drawer that holds `el` (not the page) so that `el` is in view
function reveal(el) {
  const box = el.closest(".scroll");
  if (!box || box.offsetParent === null) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top + 4;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 4;
}

// ---- monster list (tiles with the game's logo, or the name for the bosses), then its costumes (chips, hidden when the
// monster has only one)
const monsterList = $("monster-list");
const costumeSection = $("costume-section");
const costumeGroup = $("costumes");
const filesOf = (m) => m.costumes.map((c) => `${m.prefix}${c}`);
let monster = MONSTERS[0];
let costume = filesOf(monster)[0]; // the file of the picked costume

MONSTERS.forEach((m, i) => {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile monster";
  tile.title = m.name;
  tile.dataset.i = i;
  const img = document.createElement("img");
  img.src = `${BASE}icons/${m.prefix.toLowerCase()}.png`;
  img.alt = m.name;
  img.width = img.height = 28;
  img.decoding = "async";
  tile.append(img);
  monsterList.append(tile);
});

// a new monster keeps the costume position when it has one (third costume of Congar -> third of Togera)
monsterList.addEventListener("click", (e) => {
  const tile = e.target.closest(".tile");
  if (tile) switchMonster(MONSTERS[Number(tile.dataset.i)]);
});

function switchMonster(m) {
  const i = filesOf(monster).indexOf(costume);
  pickMonster(filesOf(m)[i] ?? filesOf(m)[0]);
}

// fills the costume chips for the picked monster and picks `file` (or the first costume)
function fillCostumes(m, file) {
  costumeGroup.replaceChildren();
  costumeGroup.style.setProperty("--n", Math.min(m.costumes.length, 4));
  m.costumes.forEach((c, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.file = `${m.prefix}${c}`;
    chip.textContent = m.labels?.[i] ?? `Costume ${c + 1}`;
    costumeGroup.append(chip);
  });
  costumeSection.hidden = m.costumes.length < 2;
  costume = filesOf(m).includes(file) ? file : filesOf(m)[0];
}

function markMonster() {
  for (const tile of monsterList.children) {
    const on = MONSTERS[Number(tile.dataset.i)] === monster;
    tile.classList.toggle("on", on);
    tile.setAttribute("aria-pressed", String(on));
  }
  for (const chip of costumeGroup.children) {
    const on = chip.dataset.file === costume;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
}

function pickCostume(file) {
  costume = file;
  markMonster();
  setMonster(file);
}
costumeGroup.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) pickCostume(chip.dataset.file);
});

function pickMonster(file) {
  monster = monsterOf(file) ?? MONSTERS[0];
  fillCostumes(monster, file);
  markMonster();
  setMonster(costume);
  reveal(monsterList.querySelector(".tile.on"));
}

// previous / next monster or costume (wrapping around), as if clicked
function stepMonster(delta) {
  const n = MONSTERS.length;
  switchMonster(MONSTERS[(MONSTERS.indexOf(monster) + delta + n) % n]);
}
function stepCostume(delta) {
  const files = filesOf(monster);
  const n = files.length;
  if (n > 1) pickCostume(files[(files.indexOf(costume) + delta + n) % n]);
}

function monsterOf(file) {
  return MONSTERS.find((m) => filesOf(m).includes(file));
}

// ---- background: a plain color of the visitor's choice
const DEFAULT_COLOR = "#17181b"; // the drawers' color (--panel in style.css)
const colorInput = $("bg-color");

// ---- floor grid on / off
const gridGroup = $("grid-group");
let gridWanted = true; // the visitor's choice; the grid is hidden anyway while the Boss arena is on
function setGrid(on) {
  gridWanted = on;
  grid.visible = on && !stageOn;
  for (const chip of gridGroup.children) chip.classList.toggle("on", (chip.dataset.v === "on") === on);
  remember("grid", on ? "on" : "off");
}

// ---- stage: plain (color + grid) or the Boss arena, whose lines and bands can be turned on and off one by one. The "Background"
// section shows the options of the stage that is on (the color and grid for plain, the lines and bands for the arena).
const stageGroup = $("stage-group");
const partGroups = { lattice: $("lines-group"), bands: $("bands-group") };
const stageParts = { lattice: true, bands: false };
function showStage(on) {
  const was = stageOn;
  stageOn = on;
  for (const chip of stageGroup.children) chip.classList.toggle("on", (chip.dataset.v === "boss") === on);
  for (const el of document.querySelectorAll("#pnl-scene [data-for]")) el.hidden = (el.dataset.for === "boss") !== on;
  arena.group.visible = on;
  grid.visible = gridWanted && !on;
  if (limitDist && was !== on) {
    const k = on ? STAGE_DOLLY : 1 / STAGE_DOLLY;
    camera.position.sub(controls.target).multiplyScalar(k).add(controls.target);
    baseDist *= k;
    cameraLimits(limitDist * k);
  }
}
async function setStage(on) {
  showStage(on);
  remember("stage", on ? "boss" : "plain");
  if (!on) return;
  try {
    await arena.load();
  } catch {
    showStage(false); // the arena files did not come: back to the plain stage
  }
}
function setStagePart(key, on) {
  stageParts[key] = on;
  (key === "lattice" ? arena.setLattice : arena.setBands)(on);
  for (const chip of partGroups[key].children) chip.classList.toggle("on", (chip.dataset.v === "on") === on);
  remember("stage-" + key, on ? "on" : "off");
}
stageGroup.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) setStage(chip.dataset.v === "boss");
});
for (const key in partGroups) {
  partGroups[key].addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) setStagePart(key, chip.dataset.v === "on");
  });
}
gridGroup.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) setGrid(chip.dataset.v === "on");
});

function setColor(hex) {
  colorInput.value = hex;
  backgroundColor.set(hex);
  remember("bgcolor", hex);
}
colorInput.addEventListener("input", () => setColor(colorInput.value));

function kb(bytes) {
  return `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;
}

// ---- monster
// Shading. "smooth" uses the game's own vertex normals (in every .glb, none of them zero), blended across each face, the
// way the PS1 lights them (per vertex); here it's per pixel, which looks the same without the vertex steps. "flat" uses one
// normal per triangle, so every face shows.
let shading = recall("shading") === "flat" ? "flat" : "smooth";
const flatShading = () => shading === "flat";
const shadingGroup = $("shading-group");

function setShading(mode) {
  shading = mode;
  for (const chip of shadingGroup.children) {
    const on = chip.dataset.v === mode;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  current?.root.traverse((o) => {
    if (!o.isMesh || o.userData.wire) return;
    for (const m of materialsOf(o)) {
      m.flatShading = flatShading();
      m.needsUpdate = true; // another shader program
    }
  });
  remember("shading", mode);
}
shadingGroup.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) setShading(chip.dataset.v);
});

// Surface: what the solid mesh shows. "texture" is the game's look (makeMaterial); "normals" paints where each point faces
// (view space: red = right, green = up, blue = toward the camera). The files have no other map: one color texture, nothing
// else. The view is made the first time it's needed and kept on the mesh (userData.views); userData.game is the game's
// material.
const SURFACES = ["texture", "normals"];
let surface = SURFACES.includes(recall("surface")) ? recall("surface") : "texture";
const surfaceGroup = $("surface-group");

// every material a solid mesh may wear
function materialsOf(o) {
  return [o.userData.game ?? o.material, ...Object.values(o.userData.views ?? {})];
}

// Parts cut out by the alpha test (leaves, spikes, hair cards) keep their shape in the views: the texture's alpha is
// still read, only to drop the same pixels.
function cutOut(shader, map, cut) {
  shader.uniforms.cutMap = { value: map };
  shader.uniforms.cut = { value: cut };
  shader.fragmentShader =
    "uniform sampler2D cutMap;\nuniform float cut;\n" +
    shader.fragmentShader.replace("void main() {", "void main() {\n  if (texture2D(cutMap, vUv).a < cut) discard;");
}

function viewMaterial(o, mode) {
  const views = (o.userData.views ??= {});
  if (views[mode]) return views[mode];
  const game = o.userData.game;
  // opaque, and behind the wireframe like the game's material
  const common = {
    side: game.side,
    polygonOffset: true,
    polygonOffsetFactor: game.polygonOffsetFactor,
    polygonOffsetUnits: game.polygonOffsetUnits,
  };
  const m =
    mode === "normals"
      ? new THREE.MeshNormalMaterial({ ...common, flatShading: flatShading() })
      : new THREE.MeshBasicMaterial({ ...common, vertexColors: game.vertexColors });
  const cut = !!game.map && game.alphaTest > 0;
  if (cut) m.defines = { USE_UV: "" };
  m.onBeforeCompile = (shader) => {
    keepGameNormals(shader);
    if (cut) cutOut(shader, game.map, game.alphaTest);
  };
  m.customProgramCacheKey = () => `view${cut ? "|cut" : ""}`;
  views[mode] = m;
  return m;
}

// puts the picked surface on every solid mesh of the monster on screen
function applySurface() {
  current?.root.traverse((o) => {
    if (!o.isMesh || o.userData.wire) return;
    const visible = o.material.visible;
    o.material = surface === "texture" ? o.userData.game : viewMaterial(o, surface);
    o.material.visible = visible;
  });
  applyLayers();
}

function setSurface(mode) {
  surface = mode;
  for (const chip of surfaceGroup.children) {
    const on = chip.dataset.v === mode;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  applySurface();
  remember("surface", mode);
}
surfaceGroup.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) setSurface(chip.dataset.v);
});

// This game's triangles agree with their vertex normals once the winding is fixed at export (tools/export_glb.py). The
// .glb materials are double-sided, like the other viewers', but makeMaterial draws front faces only, like the game. But
// three.js turns the normal around on a triangle it sees from the back (by its winding), which lit half the faces from
// the wrong side. The game uses the normal as it is, and so does this: the flip is taken out of the shader. (Flat
// shading doesn't read these normals: it takes one from the screen, always facing the camera.)
const GAME_NORMALS = THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", "");
function keepGameNormals(shader) {
  shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_begin>", GAME_NORMALS);
}

// Every solid sits a little behind (polygonOffset) so the wireframe lines win over it. The skinned body sits further back
// than the rigid parts: a part laid exactly on the body (the red eye of Goliath Prime's early version) wins the tie, as it
// does in the game, instead of fighting with the body (skinned on the GPU vs rigid: the two depths round differently).
function makeMaterial(original, skinned) {
  // Lambert = ambient + directional per fragment, over texture * vertex color (the glTF carries non-metallic PBR)
  const m = new THREE.MeshLambertMaterial({
    map: original.map,
    vertexColors: original.vertexColors,
    transparent: original.transparent,
    alphaTest: original.alphaTest,
    // Single-sided, like the game: every TMD primitive has the double-sided flag off and the GTE drops back faces (nclip), so
    // the artists made two-sided parts (Seraphimon's wings) as a front quad plus a back quad with the same vertices. Drawing
    // both sides (the .glb says doubleSided) puts the two copies at the same depth and they z-fight.
    side: THREE.FrontSide,
    depthWrite: original.depthWrite,
    opacity: original.opacity,
    polygonOffset: true,
    polygonOffsetFactor: skinned ? 2 : 1,
    polygonOffsetUnits: skinned ? 2 : 1,
    flatShading: flatShading(), // see setShading
  });
  if (m.map) m.map.colorSpace = THREE.NoColorSpace;
  m.onBeforeCompile = (shader) => keepGameNormals(shader);
  m.customProgramCacheKey = () => "gameNormals";
  m.name = original.name;
  original.dispose();
  return m;
}

function dispose(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of o.userData.wire ? [o.material] : materialsOf(o)) {
      if (m === wireMaterial) continue; // shared between monsters
      m.map?.dispose();
      m.dispose();
    }
  });
}

function solidMeshes(root) {
  const list = [];
  root.traverse((o) => o.isMesh && !o.userData.wire && list.push(o));
  return list;
}

function addWireframe(root) {
  for (const o of solidMeshes(root)) {
    let w;
    if (o.isSkinnedMesh) {
      w = new THREE.SkinnedMesh(o.geometry, wireMaterial);
      w.bind(o.skeleton, o.bindMatrix);
    } else {
      w = new THREE.Mesh(o.geometry, wireMaterial);
    }
    w.frustumCulled = false;
    w.userData.wire = true;
    o.add(w); // child with identity matrix: same place as the solid mesh
  }
}

// Bones: a line from each joint to its parent (SkeletonHelper) plus a dot on every joint, drawn over the mesh
const BONE_COLOR = new THREE.Color(0xf0a32a);
const BONE_TIP = new THREE.Color(0xfff1c9);
const jointTexture = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(16, 16, 14, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
})();

function makeBones(root) {
  const lines = new THREE.SkeletonHelper(root);
  const col = lines.geometry.getAttribute("color");
  for (let i = 0; i < col.count; i += 2) {
    BONE_COLOR.toArray(col.array, i * 3); // parent end
    BONE_TIP.toArray(col.array, i * 3 + 3); // child end
  }
  Object.assign(lines.material, { depthTest: false, depthWrite: false, transparent: true });
  lines.renderOrder = 10;

  const positions = new Float32Array(lines.bones.length * 3);
  const joints = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(positions, 3)),
    new THREE.PointsMaterial({
      color: BONE_COLOR,
      size: 7,
      sizeAttenuation: false,
      map: jointTexture,
      alphaTest: 0.5,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }),
  );
  joints.frustumCulled = false;
  joints.renderOrder = 11;

  const group = new THREE.Group();
  group.add(lines, joints);
  group.userData = { lines, joints };
  return group;
}

const tmp = new THREE.Vector3();
function updateJoints(bones) {
  const { lines, joints } = bones.userData;
  const pos = joints.geometry.getAttribute("position");
  lines.bones.forEach((b, i) => b.getWorldPosition(tmp).toArray(pos.array, i * 3));
  pos.needsUpdate = true;
}

function disposeBones(bones) {
  for (const o of bones.children) {
    o.geometry.dispose();
    o.material.dispose();
  }
}

// what to draw: mesh / wireframe / bones, each one a chip that turns on and off on its own
const layerChips = { mesh: $("show-mesh"), wire: $("show-wire"), bones: $("show-bones") };
const layerState = { mesh: true, wire: false, bones: false };

function layers() {
  return { ...layerState };
}

function setLayer(key, on) {
  layerState[key] = on;
  layerChips[key].classList.toggle("on", on);
  layerChips[key].setAttribute("aria-pressed", String(on));
}

function toggleLayer(key) {
  setLayer(key, !layerState[key]);
  applyLayers();
  remember("layers", JSON.stringify(layers()));
}
for (const [key, chip] of Object.entries(layerChips)) chip.addEventListener("click", () => toggleLayer(key));

// the big art of the Digimon (bottom right of the stage): on / off, and bilinear filter (smooth) or crisp pixels
const portraitChip = $("show-portrait");
const portraitSmoothChip = $("portrait-smooth");
let portraitOn = true;
let portraitSmooth = true;

function setPortraitOn(on, save = true) {
  portraitOn = on;
  portrait.classList.toggle("off", !on);
  portraitChip.classList.toggle("on", on);
  portraitChip.setAttribute("aria-pressed", String(on));
  portraitSmoothChip.disabled = !on;
  if (save) remember("portrait", on ? "on" : "off");
}

function setPortraitSmooth(smooth, save = true) {
  portraitSmooth = smooth;
  portrait.classList.toggle("crisp", !smooth);
  portraitSmoothChip.classList.toggle("on", smooth);
  portraitSmoothChip.setAttribute("aria-pressed", String(smooth));
  if (save) remember("portrait-filter", smooth ? "on" : "off");
}
portraitChip.addEventListener("click", () => setPortraitOn(!portraitOn));
portraitSmoothChip.addEventListener("click", () => setPortraitSmooth(!portraitSmooth));

function applyLayers() {
  const l = layers();
  wireMaterial.opacity = l.mesh ? 0.45 : 0.9;
  if (!current) return;
  current.root.traverse((o) => {
    if (!o.isMesh) return;
    // material.visible (not o.visible) hides the solid mesh without hiding the wireframe, which is its child
    if (o.userData.wire) o.visible = l.wire;
    else for (const m of materialsOf(o)) m.visible = l.mesh;
  });
  current.bones.visible = l.bones && current.root.visible;
}


function countTriangles(root) {
  let n = 0;
  for (const o of solidMeshes(root)) {
    const g = o.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  return n;
}

// The camera frames by height (wide screen). On narrow screens (phone in portrait) back off to fit the width.
let baseDist = 0;
function slack() {
  return 1 / Math.min(camera.aspect, 1);
}

let limitDist = 0;
function cameraLimits(dist) {
  limitDist = dist;
  camera.near = dist * 0.05;
  camera.far = stageOn ? Math.max(dist * 6, arena.far) : dist * 6; // the arena is far bigger than a monster
  camera.updateProjectionMatrix();
  controls.minDistance = dist * 0.3;
  controls.maxDistance = dist * (stageOn ? 12 : 3);
  controls.update();
}

// Fixed box over the whole idle (Model::computeFraming): without it the camera "dances" with the animation
function frame(root, mixer, clip, zoom) {
  const box = new THREE.Box3();
  const samples = 24;
  for (let s = 0; s < samples; s++) {
    mixer.setTime((clip.duration * s) / samples);
    root.updateMatrixWorld(true);
    box.expandByObject(root, true);
  }
  mixer.setTime(0);
  const center = box.getCenter(new THREE.Vector3());
  const side = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1e-3);
  placeGrid(side);
  baseDist = ((side * 0.8) / Math.tan(THREE.MathUtils.degToRad(FOVY / 2)) / zoom) * (stageOn ? STAGE_DOLLY : 1);
  const dist = baseDist * slack();

  // game: camera at c + (sin yaw cos pitch, cos yaw cos pitch, sin pitch) * dist, Z up; here Y up (x, z, -y)
  const dir = new THREE.Vector3(Math.sin(YAW) * Math.cos(PITCH), Math.sin(PITCH), -Math.cos(YAW) * Math.cos(PITCH));
  camera.position.copy(center).addScaledVector(dir, dist);
  controls.target.copy(center);
  cameraLimits(dist);
}

async function setMonster(file) {
  const mine = ++request;
  const mon = monsterOf(file);
  const label = mon?.name ?? file;
  monsterName.replaceChildren();
  if (mon && mon.nameImage !== false) {
    // the name as the game's select screen writes it (public/names), the text only as the alt
    monsterName.append(Object.assign(document.createElement("img"), { src: `${BASE}names/${mon.prefix.toLowerCase()}.png`, alt: label }));
  } else {
    monsterName.append(label);
  }
  portrait.src = mon ? `${BASE}logos/${mon.prefix.toLowerCase()}.png` : "";
  portrait.alt = "";
  portrait.hidden = !mon;
  const url = `${BASE}models/${file}.glb`;
  status.textContent = "";
  remember("monster", file);

  // paused: the next costume opens on the same frame of the same animation
  const shown = current?.anims?.find((x) => x.k === animK);
  keepFrame = !playing && current?.action && shown ? { key: animKey(shown, current), frame: currentFrame() } : null;

  // the spinner takes the monster's place until the new one is ready (shown after a moment, so a cached file doesn't flash)
  if (current) current.root.visible = current.bones.visible = false;
  player.hidden = true;
  animsReady = false;
  animSorted = [];
  renderAnims();
  download.hidden = true;
  setSaveButtons(false);
  stopRecording(false);
  stats.textContent = modelStats.textContent = "";
  loadingText.textContent = `Loading ${label}…`;
  const spinnerTimer = setTimeout(() => (loadingBox.hidden = false), 150);

  let gltf;
  try {
    gltf = await gltfLoader.loadAsync(url, (e) => {
      if (mine !== request) return;
      loadingText.textContent = e.total
        ? `Loading ${label}… ${Math.floor((100 * e.loaded) / e.total)}% (${kb(e.loaded)} of ${kb(e.total)})`
        : `Loading ${label}… ${kb(e.loaded)}`;
    });
  } catch (e) {
    if (mine === request) {
      clearTimeout(spinnerTimer);
      loadingBox.hidden = true;
      if (current) current.root.visible = true;
      applyLayers();
      status.textContent = `Could not load ${file}.glb`;
    }
    console.error(e);
    return;
  }
  if (mine !== request) {
    dispose(gltf.scene);
    return;
  }
  clearTimeout(spinnerTimer);
  loadingBox.hidden = true;

  const root = gltf.scene;
  root.traverse((o) => {
    if (o.isMesh) {
      o.material = o.userData.game = makeMaterial(o.material, o.isSkinnedMesh);
      o.frustumCulled = false; // the skinned mesh's bounding box is the rest pose's
    }
  });
  addWireframe(root);

  const mixer = new THREE.AnimationMixer(root);
  const clip = gltf.animations.find((a) => a.name === "idle") ?? gltf.animations[0];
  const action = clip ? mixer.clipAction(clip).play() : null;
  // another costume of the same monster keeps the visitor's camera; a new monster gets the game's framing
  const sameMonster = !!mon && !!current && monsterOf(current.file) === mon;
  if (clip) {
    if (!sameMonster) frame(root, mixer, clip, mon?.zoom ?? 1);
  }

  if (current) {
    scene.remove(current.root, current.bones);
    current.mixer.stopAllAction();
    dispose(current.root);
    disposeBones(current.bones);
  }
  const bones = makeBones(root);
  scene.add(root, bones);
  current = { root, mixer, bones, action, frames: clip ? Math.round(clip.duration * FPS) : 0, file, idle: clip };
  applySurface();
  setupPlayer();
  fillAnims(root.userData.animations ?? []);
  syncAnimNav();
  const n = (x) => `<b>${x.toLocaleString("en-US")}</b>`;
  stats.innerHTML = modelStats.innerHTML = `${n(countTriangles(root))} triangles · ${n(bones.userData.lines.bones.length)} bones`;
  showDownload();
  setSaveButtons(true);
}

// ---- download. The costume's .glb has only one animation (the others are downloaded when picked), so the button builds
// the file on click: the costume's .glb plus every animation in its list (glbmerge.js), with the exporter's clip names.
let downloadBusy = false;

function showDownload() {
  const n = current.anims.length || 1;
  downloadLabel.textContent = `Download model (.glb), ${n} animation${n === 1 ? "" : "s"}`;
  download.hidden = false;
}

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

download.addEventListener("click", async (e) => {
  e.preventDefault();
  if (downloadBusy || !current) return;
  downloadBusy = true;
  const owner = current;
  const mon = monsterOf(owner.file);
  const name = `${(mon?.name ?? owner.file).replace(/[^\w-]+/g, "_")}_${owner.file}.glb`;
  const list = owner.anims;
  const own = list.find(isIdle); // the animation the costume's .glb already has
  const others = animSorted.filter((a) => a !== own);
  const text = downloadLabel.textContent;
  const progress = (done) => (downloadLabel.textContent = `Preparing… ${done} of ${others.length} animations`);
  try {
    progress(0);
    const base = await fetchBuffer(`${BASE}models/${owner.file}.glb`);
    const buffers = new Array(others.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < others.length) {
        const i = next++;
        buffers[i] = await fetchBuffer(`${BASE}models/${others[i].file}`);
        progress(++done);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (owner !== current) return; // another monster was picked meanwhile
    const glb = mergeGlb(base, buffers);
    const url = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    console.error(err);
    if (owner === current) status.textContent = "Could not prepare the download";
  } finally {
    downloadBusy = false;
    if (owner === current) downloadLabel.textContent = text;
  }
});

// ---- save the picture the visitor composed: background color + the 3D view, at screen resolution
const snapshot = $("snapshot");
const snapshotTop = $("snapshot-top");
const snapshotAlpha = $("snapshot-alpha");
const imageSize = $("image-size");
const imageSizeText = $("image-size-text");
const sizeChips = [...imageSize.querySelectorAll(".chip")];
let pictureScale = 1;

// the buttons that need a monster on screen (off while one is loading)
function setSaveButtons(on) {
  snapshot.disabled = snapshotTop.disabled = snapshotAlpha.disabled = !on;
  recordButton.disabled = !on || !canRecord;
}

function setPictureScale(k) {
  pictureScale = k;
  for (const chip of sizeChips) {
    const on = Number(chip.dataset.v) === k;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-checked", String(on));
  }
  syncImageSizes();
}
imageSize.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip && !chip.disabled) setPictureScale(Number(chip.dataset.v));
});
// Bigger pictures are drawn at a higher pixel ratio: the bones' dots scale with
// it, so the picture is the same as on screen, only sharper. Capped by what the graphics card can draw (and at 8192 px,
// past which the browser may run out of memory reading it back).
const BASE_PIXEL_RATIO = Math.min(window.devicePixelRatio, 2);
const MAX_PICTURE = Math.min(renderer.getContext().getParameter(renderer.getContext().MAX_RENDERBUFFER_SIZE), 8192);

// the sizes in pixels in the tooltips (and the picked one under the chips); sizes too big for this screen are turned off
function syncImageSizes() {
  const w = canvas.width;
  const h = canvas.height;
  for (const chip of sizeChips) {
    const k = Number(chip.dataset.v);
    chip.disabled = Math.max(w, h) * k > MAX_PICTURE;
    chip.title = chip.disabled ? "Too big for this device" : `${w * k} × ${h * k} px`;
  }
  if (sizeChips.find((c) => Number(c.dataset.v) === pictureScale)?.disabled) {
    setPictureScale(1);
    return;
  }
  imageSizeText.textContent = `${w * pictureScale} × ${h * pictureScale} px, the view on screen × ${pictureScale}.`;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// Transparent picture. The additive parts (Kineticlops' body, fire, flares) add light without writing alpha, so the canvas
// alpha alone would drop them. Instead the scene is drawn over black and over white: a pixel that lets a fraction
// (1 - a) of the background through differs by (1 - a) between the two, and additive light (which saturates over white)
// keeps its brightness as alpha. Color = the black render divided by alpha.
const BLACK = new THREE.Color(0, 0, 0);
const WHITE = new THREE.Color(1, 1, 1);
// Alpha at or below this (of 255) is treated as empty. Some browsers return black and white a step or two off (display
// color profiles, fingerprinting noise), which made every pixel slightly opaque and the crop keep the whole frame.
const MATTE_FLOOR = 6;

function grab(w, h, solid) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(solid);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(canvas, 0, 0);
  return g.getImageData(0, 0, w, h);
}

// The matted picture cropped to the box of every pixel with alpha > 0 (no fully transparent margins). The box comes from
// the alpha computed here, not from reading the picture back, which can add noise in some browsers.
function matte(w, h) {
  const b = grab(w, h, BLACK);
  const wt = grab(w, h, WHITE).data;
  const px = b.data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < px.length; i += 4) {
    let a = 0;
    for (let c = 0; c < 3; c++) a = Math.max(a, 255 - wt[i + c] + px[i + c]);
    a = Math.min(255, a);
    if (a <= MATTE_FLOOR) a = 0; // readback noise (color management, anti-fingerprinting) must not count as content
    for (let c = 0; c < 3; c++) px[i + c] = a ? Math.min(255, Math.round((px[i + c] * 255) / a)) : 0;
    px[i + 3] = a;
    if (a) {
      const x = (i >> 2) % w;
      const y = Math.floor((i >> 2) / w);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (x1 < 0) [x0, y0, x1, y1] = [0, 0, w - 1, h - 1]; // nothing drawn: keep the full frame
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d").putImageData(b, -x0, -y0);
  return out;
}

async function saveImage(transparent) {
  const k = pictureScale;
  const who = slug(monster.name); // named when clicked, not when the file is ready
  // nothing behind the monster: the PNG keeps the 3D view's alpha
  const bgName = transparent ? "transparent" : "color";
  if (k > 1) {
    status.textContent = `Saving ${canvas.width * k} × ${canvas.height * k} picture…`;
    await new Promise((r) => setTimeout(r, 50)); // let the message show before the heavy part
  }
  // the WebGL canvas is only readable right after a render, in the same task: resize, render, copy, then back to the
  // screen's size, all at once (the next frame redraws the screen)
  let out;
  const gridShown = grid.visible;
  const arenaShown = arena.group.visible;
  try {
    if (transparent) {
      grid.visible = false; // only the monster in a picture with no background
      arena.group.visible = false;
    }
    if (k > 1) renderer.setPixelRatio(BASE_PIXEL_RATIO * k);
    const w = canvas.width;
    const h = canvas.height;
    if (transparent) {
      out = matte(w, h);
    } else {
      out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      draw();
      out.getContext("2d").drawImage(canvas, 0, 0);
    }
  } finally {
    grid.visible = gridShown;
    arena.group.visible = arenaShown;
    if (k > 1) renderer.setPixelRatio(BASE_PIXEL_RATIO);
  }
  const blob = await new Promise((r) => out.toBlob(r, "image/png"));
  if (k > 1) status.textContent = "";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${who}_${slug(bgName)}${k > 1 ? `_${k}x` : ""}.png`;
  a.click();
  sfx.play("code");
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

for (const [button, transparent] of [
  [snapshot, false],
  [snapshotTop, false],
  [snapshotAlpha, true],
]) {
  button.addEventListener("click", () => {
    saveImage(transparent).catch((e) => {
      status.textContent = "Could not save the image";
      console.error(e);
    });
  });
}

// ---- video: the canvas is recorded live while the animation plays once from its first frame, at the chosen speed (the
// visitor can still turn the camera while it records). MP4 where the browser can make it (what most sites accept),
// WebM otherwise.
const recordButton = $("record");
const recordLabel = $("record-label");
const VIDEO_TYPE = ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find(
  (t) => window.MediaRecorder?.isTypeSupported(t),
);
const canRecord = !!VIDEO_TYPE && !!canvas.captureStream;
$("video-section").hidden = !canRecord;
const MAX_VIDEO_SECONDS = 120;
let recording = null; // { recorder, chunks, name, start, last, keep }

function startRecording() {
  if (!current?.action || recording) return;
  const who = slug(monster.name);
  const what = slug(animNameText().replace(/\(.*\)/, "") || "animation");
  const recorder = new MediaRecorder(canvas.captureStream(60), { mimeType: VIDEO_TYPE, videoBitsPerSecond: 12e6 });
  const rec = { recorder, chunks: [], name: `${who}_${what}`, start: performance.now(), last: 0, keep: true };
  recording = rec;
  // the last piece arrives after stop(), when `recording` is already cleared: collect into this recording's own list
  recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  recorder.onstop = () => {
    if (!rec.keep || !rec.chunks.length) return;
    const blob = new Blob(rec.chunks, { type: VIDEO_TYPE.split(";")[0] });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${rec.name}.${VIDEO_TYPE.startsWith("video/mp4") ? "mp4" : "webm"}`;
    a.click();
    sfx.play("code");
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  seek(0);
  setPlaying(true);
  recorder.start();
  recordButton.classList.add("recording");
  recordLabel.textContent = "Stop recording";
}

// keep: save what was recorded (false when the model goes away mid-recording)
function stopRecording(keep = true) {
  if (!recording) return;
  recording.keep = keep;
  if (recording.recorder.state !== "inactive") recording.recorder.stop();
  recording = null;
  recordButton.classList.remove("recording");
  recordLabel.textContent = "Save animation as video";
  if (status.textContent.startsWith("Recording")) status.textContent = "";
}

// called every frame: stop once the animation wrapped around to its start (one full play), or at the time limit
function checkRecording() {
  if (!recording) return;
  const t = current?.action?.time ?? 0;
  const seconds = (performance.now() - recording.start) / 1000;
  status.textContent = `Recording… ${seconds.toFixed(1)} s`;
  if ((t < recording.last && seconds > 0.1) || seconds > MAX_VIDEO_SECONDS) {
    stopRecording(true);
    return;
  }
  recording.last = t;
}

recordButton.addEventListener("click", () => (recording ? stopRecording(true) : startRecording()));

// ---- drawers. One rail: its first icons open the drawer with what to show (monsters, animations), the rest the panel with
// how to show it (model, scene, lighting, picture). Only one is open at a time: opening one closes the other. On a computer
// it sits next to the rail; on a phone (the same rule as style.css) it is a sheet under the stage.
const mobile = matchMedia("(max-width: 760px), (pointer: coarse) and (max-height: 520px)");
const landscape = matchMedia("(pointer: coarse) and (max-height: 520px) and (orientation: landscape)");
const drawer = $("drawer");
const panel = $("panel");
const rail = $("rail");
const TABS = { monsters: "Digimon", anims: "Animations" };
const PANELS = { model: "Model", scene: "Scene", light: "Lighting", photo: "Picture and video", about: "About" };
const ui = {
  tab: recall("tab") in TABS ? recall("tab") : "monsters",
  // first visit: open on a computer, closed on a phone (where it would cover the Digimon)
  open: recall("drawer") ? recall("drawer") === "open" : !mobile.matches,
  pnl: recall("panel") ?? "",
};
if (!(ui.pnl in PANELS)) ui.pnl = "";
if (ui.open) ui.pnl = "";

function renderDrawers() {
  drawer.hidden = !ui.open;
  for (const t in TABS) $(`tab-${t}`).hidden = t !== ui.tab;
  $("drawer-title").textContent = TABS[ui.tab];
  $("drawer-num").textContent = ui.tab === "anims" && animSorted.length ? animShown().length : "";
  for (const b of rail.querySelectorAll("[data-tab]")) b.classList.toggle("on", ui.open && b.dataset.tab === ui.tab);

  panel.hidden = !ui.pnl;
  for (const p in PANELS) $(`pnl-${p}`).hidden = p !== ui.pnl;
  $("panel-title").textContent = PANELS[ui.pnl] ?? "";
  for (const b of rail.querySelectorAll("[data-pnl]")) b.classList.toggle("on", b.dataset.pnl === ui.pnl);
}

function saveDrawers() {
  remember("tab", ui.tab);
  remember("drawer", ui.open ? "open" : "closed");
  remember("panel", ui.pnl);
}

// the same icon again closes it
function openTab(tab) {
  if (ui.tab === tab && ui.open) ui.open = false;
  else {
    ui.tab = tab;
    ui.open = true;
  }
  if (ui.open) ui.pnl = "";
  saveDrawers();
  renderDrawers();
  if (ui.open) reveal(drawer.querySelector(`#tab-${ui.tab} .on`) ?? drawer);
}

function openPanel(p) {
  ui.pnl = ui.pnl === p ? "" : p;
  if (ui.pnl) ui.open = false;
  saveDrawers();
  renderDrawers();
}

rail.addEventListener("click", (e) => {
  const b = e.target.closest(".ico");
  if (!b) return;
  if (b.dataset.tab) openTab(b.dataset.tab);
  else openPanel(b.dataset.pnl);
});
$("drawer-close").addEventListener("click", () => openTab(ui.tab));
$("panel-close").addEventListener("click", () => openPanel(ui.pnl));

// Sheet height on phones: dragging its top (the small bar or the title) makes it taller or shorter; remembered in this
// browser
const root = document.documentElement;
const savedSheet = Number(recall("sheet"));
if (savedSheet > 0) root.style.setProperty("--sheet", `${savedSheet}px`);
for (const sheet of [drawer, panel]) {
  const head = sheet.querySelector(".head");
  sheet.addEventListener("pointerdown", (e) => {
    if (!mobile.matches || landscape.matches || e.target.closest("button, input, select, a")) return;
    if (e.target !== sheet && !head.contains(e.target)) return;
    e.preventDefault();
    sheet.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = sheet.offsetHeight;
    const max = innerHeight - 44 - 52 - 120;
    let h = h0;
    const move = (ev) => {
      h = Math.round(Math.max(120, Math.min(max, h0 - (ev.clientY - y0))));
      root.style.setProperty("--sheet", `${h}px`);
    };
    const drop = () => {
      sheet.removeEventListener("pointermove", move);
      sheet.removeEventListener("pointerup", drop);
      sheet.removeEventListener("pointercancel", drop);
      remember("sheet", h);
    };
    sheet.addEventListener("pointermove", move);
    sheet.addEventListener("pointerup", drop);
    sheet.addEventListener("pointercancel", drop);
  });
}

// a button clicked with the mouse lets go of the focus, so space and the arrows go back to the player (the keyboard keeps
// it: e.detail is 0 for a click made with Enter or space)
document.addEventListener("click", (e) => {
  if (e.detail > 0) e.target.closest?.("button")?.blur();
});

// ---- lighting controls
const sliders = {
  amb: { input: document.getElementById("amb"), out: document.getElementById("v-amb"), fmt: (v) => v.toFixed(2) },
  dir: { input: document.getElementById("dir"), out: document.getElementById("v-dir"), fmt: (v) => v.toFixed(2) },
  az: { input: document.getElementById("az"), out: document.getElementById("v-az"), fmt: (v) => `${v}°` },
  el: { input: document.getElementById("el"), out: document.getElementById("v-el"), fmt: (v) => `${v}°` },
};
const customOption = selLight.querySelector('option[value="custom"]');

function lightFromSliders() {
  return Object.fromEntries(Object.entries(sliders).map(([k, s]) => [k, Number(s.input.value)]));
}

function showLight(light, preset) {
  for (const [k, s] of Object.entries(sliders)) {
    s.input.value = light[k];
    s.out.textContent = s.fmt(light[k]);
  }
  customOption.hidden = preset !== "custom";
  selLight.value = preset;
  applyLight(light);
  remember("light", JSON.stringify({ preset, ...light }));
}

selLight.addEventListener("change", () => showLight(LIGHT_PRESETS[selLight.value], selLight.value));
for (const s of Object.values(sliders)) s.input.addEventListener("input", () => showLight(lightFromSliders(), "custom"));

// ---- animation list. The model file carries the idle and the list ({ k, id, frames, file }); each other animation is its own
// small .glb (only node names and the keys), downloaded when picked and played on the model, which finds each node by name.
// k is the index in the game's table: ids repeat (Togera has two animation 0s), k does not.
const clipCache = new Map(); // url -> AnimationClip
let animRequest = 0;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// writes text into el with the pad buttons (□ △ ○ ✕) in a symbol font: the page's font draws □ much smaller than △
function setButtonText(el, text) {
  el.replaceChildren(
    ...text.split(/([□△○✕])/).map((part, i) => {
      if (!(i % 2)) return part;
      const b = document.createElement("span");
      b.className = "pad";
      b.textContent = part;
      return b;
    }),
  );
}

// The animations are named by the game itself (NORMAL_IDLE, KOED_FACEUP_IDLE, ATOMICBREATH_CHARGE_FULL...). The first word
// is the kind of move: the list puts a heading over each run of animations that share it.
const kindOf = (a) => a.name.split("_")[0];

// the animation's name without the frame count (the list shows the count apart)
function animTitle(a) {
  return a.name;
}

function animLabel(a) {
  return `${animTitle(a)} (${a.frames - 1} frames)`;
}

// the idle: the one the exporter marked as the .glb's own
function isIdle(a) {
  return !!a.first;
}

// The list in the Animations tab: idle first, then by name (which groups the kinds of move). Previous / next go through it.
const animList = $("anim-list");
let animSorted = [];
let animK = null; // k of the animation on screen
let animsReady = false; // false while a monster loads
const animShown = () => animSorted;

function renderAnims() {
  animList.replaceChildren();
  const shown = animShown();
  const kinds = new Map();
  for (const a of shown) kinds.set(kindOf(a), (kinds.get(kindOf(a)) ?? 0) + 1);
  let head = null;
  for (const a of shown) {
    const kind = !isIdle(a) && kinds.get(kindOf(a)) > 1 ? kindOf(a) : null;
    if (kind && kind !== head) {
      const el = document.createElement("div");
      el.className = "anim-group";
      el.textContent = cap(kind.toLowerCase());
      animList.append(el);
    }
    head = kind;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "anim";
    b.dataset.k = a.k;
    b.title = animLabel(a);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = animTitle(a);
    const frames = document.createElement("small");
    frames.textContent = `${a.frames - 1} frames`;
    b.append(name, frames);
    animList.append(b);
  }
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = animsReady || !current ? "Only the idle animation." : "Loading…";
    animList.append(empty);
  }
  markAnim();
  renderDrawers(); // the count on the tab's title
}

function markAnim() {
  for (const b of animList.querySelectorAll(".anim")) {
    const on = Number(b.dataset.k) === animK;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  syncAnimNav();
}

function shownAnim() {
  return current?.anims?.find((x) => x.k === animK);
}

function animNameText() {
  const a = shownAnim();
  if (a) return animLabel(a);
  return current?.idle ? "Idle" : "None";
}

// the player's tooltip, the same as the list's
function animNameTip() {
  const a = shownAnim();
  return a ? animLabel(a) : "";
}

animList.addEventListener("click", (e) => {
  const b = e.target.closest(".anim");
  const a = b && current?.anims?.find((x) => x.k === Number(b.dataset.k));
  if (a && animsReady) setAnim(a);
});

function fillAnims(list) {
  current.anims = list;
  animSorted = [...list].sort((a, b) => isIdle(b) - isIdle(a) || a.name.localeCompare(b.name) || a.k - b.k);
  animsReady = true;
  if (!list.length) {
    animK = null;
    renderAnims();
    return;
  }
  const idle = list.find(isIdle) ?? list[0];
  animK = idle.k;
  renderAnims();
  // keep the visitor's animation when changing costume; another monster starts on its idle
  const saved = recall("anim");
  const wanted = list.find((a) => animKey(a, current) === saved);
  const target = wanted ?? idle;
  const keep = keepFrame;
  keepFrame = null;
  const frame = keep && animKey(target, current) === keep.key ? keep.frame : 0;
  if (target !== idle) setAnim(target, frame);
  else if (frame) seek(Math.min(frame, current.frames));
}

// remembered as monster + animation name: the same index means a different animation on another monster
function animKey(a, owner) {
  return `${monsterOf(owner.file)?.prefix ?? owner.file}|${a.name}`;
}

async function setAnim(a, frame = 0) {
  stopRecording(false); // another animation: the half-made video is dropped
  const mine = ++animRequest;
  const owner = current;
  animK = a.k;
  markAnim();
  reveal(animList.querySelector(".anim.on") ?? animList);
  remember("anim", animKey(a, owner));
  let clip = isIdle(a) && owner.idle ? owner.idle : clipCache.get(`${BASE}models/${a.file}`);
  if (!clip) {
    status.textContent = `Loading ${animLabel(a)}…`;
    const url = `${BASE}models/${a.file}`;
    try {
      const g = await gltfLoader.loadAsync(url);
      clip = g.animations[0];
      clipCache.set(url, clip);
    } catch (e) {
      console.error(e);
      if (mine === animRequest) status.textContent = `Could not load ${a.file}`;
      return;
    }
    if (mine === animRequest) status.textContent = "";
  }
  if (mine !== animRequest || owner !== current) return;
  const action = owner.mixer.clipAction(clip);
  if (owner.action !== action) {
    owner.action?.stop();
    action.reset().play();
  }
  owner.action = action;
  owner.frames = Math.round(clip.duration * FPS);
  setupPlayer(frame);
}

// ---- animation player. The game runs its animations one frame per vertical blank, 60 per second, so frame n is at time n / 60.
const FPS = 30;
const player = $("player");
const playButton = $("play");
const prevFrame = $("prev-frame");
const nextFrame = $("next-frame");
const frameSlider = $("frame");
const frameLabel = $("frame-label");
const prevAnim = $("prev-anim");
const nextAnim = $("next-anim");
const animName = $("anim-name");

// the arrow at the end of the player hides it; a small arrow at the bottom of the stage brings it back (remembered for
// the next visit)
function setPlayerShown(shown) {
  player.classList.toggle("collapsed", !shown);
  remember("player", shown ? "shown" : "hidden");
}
$("hide-player").addEventListener("click", () => setPlayerShown(false));
$("show-player").addEventListener("click", () => setPlayerShown(true));
if (recall("player") === "hidden") setPlayerShown(false);

// playback speed: one chip per speed; - and + step down / up
const SPEEDS = [0.5, 1, 2];
const speedGroup = $("speeds");
for (const s of SPEEDS) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.dataset.v = s;
  chip.textContent = `${s}×`;
  chip.title = `Playback speed ${s}× (- / +)`;
  speedGroup.append(chip);
}
let speed = 1;
function setSpeed(s) {
  speed = s;
  for (const chip of speedGroup.children) {
    const on = Number(chip.dataset.v) === s;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  remember("speed", s);
}
function stepSpeed(delta) {
  const i = SPEEDS.indexOf(speed) + delta;
  setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i))]);
}
speedGroup.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) setSpeed(Number(chip.dataset.v));
});
const savedSpeed = Number(recall("speed"));
setSpeed(SPEEDS.includes(savedSpeed) ? savedSpeed : 1);

// frame interpolation: on, three.js blends between the 60 frames of each second; off, the pose holds each frame until
// the next one, like a frame-by-frame player (the clock keeps running smoothly underneath)
const interpGroup = $("interp-group");
let interpolate = true;
function setInterpolate(on) {
  interpolate = on;
  for (const chip of interpGroup.children) {
    const pressed = (chip.dataset.v === "on") === on;
    chip.classList.toggle("on", pressed);
    chip.setAttribute("aria-pressed", String(pressed));
  }
  remember("interp", on ? "on" : "off");
  if (!on && current?.action) seek(currentFrame()); // snap the pose on screen now, even while paused
}
interpGroup.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) setInterpolate(chip.dataset.v === "on");
});
setInterpolate(recall("interp") !== "off");

// poses the frame the player shows, then puts the clock back where it was so playback keeps its pace
function holdFrame() {
  const action = current.action;
  if (!action) return;
  const time = action.time;
  action.time = currentFrame() / FPS;
  current.mixer.update(0);
  action.time = time;
}
let playing = true;
let shownFrame = -1;
let keepFrame = null; // { key, frame }: the paused frame to reopen after a costume change

function currentFrame() {
  return Math.min(Math.round(current.action.time * FPS), current.frames);
}

function showFrame() {
  if (!current?.action) return;
  const f = currentFrame();
  if (f === shownFrame) return;
  shownFrame = f;
  frameSlider.value = f;
  frameLabel.innerHTML = `<strong>${f}</strong> / ${current.frames}`;
}

function setPlaying(on) {
  if (on !== playing) sfx.play(on ? "confirm" : "pause");
  playing = on;
  player.classList.toggle("paused", !on);
  playButton.setAttribute("aria-label", on ? "Pause" : "Play");
  playButton.title = on ? "Pause (space)" : "Play (space)";
}

function seek(f) {
  if (!current?.action) return;
  const n = current.frames + 1; // frames 0..frames, wrapping around
  f = ((f % n) + n) % n;
  current.action.time = f / FPS;
  current.mixer.update(0); // apply the pose without moving time
  showFrame();
}

// frame: where to open the animation (kept when changing costume while paused); past its end, the last frame
function setupPlayer(frame = 0) {
  shownFrame = -1;
  syncAnimNav();
  if (!current.action || current.frames < 1) return;
  frameSlider.max = current.frames;
  seek(Math.min(frame, current.frames));
  player.hidden = false;
}

function step(delta) {
  setPlaying(false);
  seek(currentFrame() + delta);
}

// the animation's name between the previous / next buttons (they're off when there is nothing to switch to)
function syncAnimNav() {
  setButtonText(animName, animsReady ? animNameText() : "");
  animName.title = animsReady ? animNameTip() : "";
  prevAnim.disabled = nextAnim.disabled = !animsReady || animShown().length < 2;
}

// previous / next animation in the list as shown (wrapping around), as if clicked; from one the filter hides, the
// first or last shown
function stepAnim(delta) {
  const shown = animShown();
  const n = shown.length;
  if (!animsReady || n < 2) return;
  const i = shown.findIndex((a) => a.k === animK);
  setAnim(shown[i < 0 ? (delta > 0 ? 0 : n - 1) : (i + delta + n) % n]);
}

// previous / next option of a select (wrapping around, skipping hidden options), as if picked by the visitor
function stepSelect(sel, delta) {
  const options = [...sel.options].filter((o) => !o.hidden && !o.disabled);
  const n = options.length;
  if (sel.disabled || n < 2) return;
  const i = options.indexOf(sel.selectedOptions[0]);
  // from a hidden option (the "Custom" lighting) going forward starts at the first one
  const next = i < 0 ? (delta > 0 ? 0 : n - 1) : (i + delta + n) % n;
  sel.value = options[next].value;
  sel.dispatchEvent(new Event("change"));
}
prevAnim.addEventListener("click", () => stepAnim(-1));
nextAnim.addEventListener("click", () => stepAnim(1));

playButton.addEventListener("click", () => setPlaying(!playing));
prevFrame.addEventListener("click", () => step(-1));
nextFrame.addEventListener("click", () => step(1));
// dragging the slider pauses on the picked frame
frameSlider.addEventListener("input", () => {
  setPlaying(false);
  seek(Number(frameSlider.value));
});

// ---- showcase mode: the interface goes away and the camera slowly circles the monster. The shortcuts keep working
// (H or Esc leaves); on touch screens a round button in the corner leaves, and fades out when nobody touches anything.
// the game's gold titles, written with the game's own system font (public/ui/font.png, positions in gamefont.js): every letter is a
// small box that shows its glyph through a mask, in plain gold (.fade in style.css). The titles
// of the drawers, the animation groups and the player's name are written by the code above, so a watcher wraps whatever shows up there.
const FADE_TITLES = ".section > h3, .head > span:first-child, .anim-group, #anim-name";
function fadeLetters(root) {
  for (const el of root.querySelectorAll(FADE_TITLES)) {
    if (el.firstElementChild?.tagName === "I" || !el.textContent.trim()) continue;
    const text = el.textContent;
    el.setAttribute("aria-label", text);
    el.classList.add("fade");
    el.replaceChildren(...[...text.toUpperCase()].map((ch) => {
      const i = document.createElement("i");
      i.setAttribute("aria-hidden", "true");
      const glyph = GAME_FONT.glyphs[ch];
      if (ch === " ") i.className = "sp";
      else if (glyph) {
        i.style.width = glyph[1] + "px";
        i.style.setProperty("--x", glyph[0] + "px");
      } else {
        i.className = "fb"; // a character the game's font doesn't have
        i.textContent = ch;
      }
      return i;
    }));
  }
}
for (const side of [$("drawer"), $("panel"), $("player")]) {
  fadeLetters(side);
  new MutationObserver(() => fadeLetters(side)).observe(side, { childList: true, subtree: true });
}

// phones: the header's buttons live in a menu behind the hamburger button (CSS); it closes on any pick, outside tap or Esc
const header = document.querySelector("header");
const menuToggle = $("menu-toggle");
function setHeaderMenu(open) {
  header.classList.toggle("menu-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
}
menuToggle.addEventListener("click", () => setHeaderMenu(!header.classList.contains("menu-open")));
$("header-actions").addEventListener("click", (e) => {
  if (e.target.closest("a, button")) setHeaderMenu(false);
});
document.addEventListener("pointerdown", (e) => {
  if (header.classList.contains("menu-open") && !e.target.closest("#header-actions, #menu-toggle")) setHeaderMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && header.classList.contains("menu-open")) setHeaderMenu(false);
});
const showcaseButton = $("showcase");
const showcaseExit = $("showcase-exit");
controls.autoRotateSpeed = 1.5; // 40 seconds per turn
let idleTimer = 0;
function wake() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("idle"), 2500);
}
function setShowcase(on) {
  document.body.classList.toggle("showcase", on);
  controls.autoRotate = on;
  if (on) wake();
  else {
    clearTimeout(idleTimer);
    document.body.classList.remove("idle");
  }
}
const inShowcase = () => document.body.classList.contains("showcase");
showcaseButton.addEventListener("click", () => {
  showcaseButton.blur(); // so space and the arrows reach the player again
  setShowcase(true);
});
showcaseExit.addEventListener("click", () => setShowcase(false));
for (const type of ["pointermove", "pointerdown"]) {
  document.addEventListener(type, () => {
    if (inShowcase()) wake();
  });
}

// keyboard: letters cycle the lists and 1 2 3 toggle the layers (4 the portrait) (the page has no text field, so they work even with a
// select or a button focused), space = play/pause and arrows = one frame (only when no form control has focus, so those keep their
// own keys)
const SHORTCUTS = {
  a: () => stepAnim(-1),
  d: () => stepAnim(1),
  w: () => stepCostume(-1),
  s: () => stepCostume(1),
  q: () => stepMonster(-1),
  e: () => stepMonster(1),
  r: () => stepSelect(selLight, 1),
  f: () => setShading(flatShading() ? "smooth" : "flat"),
  v: () => setSurface(SURFACES[(SURFACES.indexOf(surface) + 1) % SURFACES.length]),
  g: () => setGrid(!gridWanted),
  b: () => setStage(!stageOn),
  1: () => toggleLayer("mesh"),
  2: () => toggleLayer("wire"),
  3: () => toggleLayer("bones"),
  4: () => setPortraitOn(!portraitOn),
  "-": () => stepSpeed(-1),
  "+": () => stepSpeed(1),
  "=": () => stepSpeed(1), // + without shift on US keyboards
  h: () => setShowcase(!inShowcase()),
};
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape" && inShowcase()) {
    setShowcase(false);
    e.preventDefault();
    return;
  }
  // the digits by physical key too, for layouts where they need shift (AZERTY)
  const shortcut = SHORTCUTS[e.key.toLowerCase()] ?? SHORTCUTS[e.code.match(/^Digit([1234])$/)?.[1]];
  if (shortcut) {
    shortcut();
    const key = e.key.toLowerCase();
    if (key !== "h") sfx.play("qwerasd".includes(key) ? "cursor" : "confirm");
    e.preventDefault();
    return;
  }
  if (player.hidden) return;
  if (e.target.closest?.("input, select, textarea, button, summary, a")) return;
  if (e.key === " ") setPlaying(!playing);
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
  else return;
  if (e.key !== " ") sfx.play("step");
  e.preventDefault();
});

// ---- the game's menu sounds: its cursor, confirm and back, the step of an option and the pause (src/sfx.js). They come from clicks, keys
// and sliders alike, so one listener each (in the capture phase, before the page's own handler changes what the button is).
const soundGroup = $("sound-group");
function setSound(on) {
  sfx.on = on;
  for (const chip of soundGroup.children) chip.classList.toggle("on", (chip.dataset.v === "on") === on);
  remember("sound", on ? "on" : "off");
}
soundGroup.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) setSound(chip.dataset.v === "on");
});
const volumeInput = $("volume");
const volumeOut = $("v-volume");
function setVolume(percent, save = true) {
  sfx.volume = percent / 100;
  volumeInput.value = percent;
  volumeOut.textContent = `${percent}%`;
  if (save) remember("volume", String(percent));
}
volumeInput.addEventListener("input", () => setVolume(Number(volumeInput.value)));
document.addEventListener(
  "click",
  (e) => {
    const el = e.target.closest?.("button, a.btn");
    if (!el || el.id === "play") return; // the play button makes its sound in setPlaying
    if (el.matches(".ico")) sfx.play(el.classList.contains("on") ? "back" : "cursor");
    else if (el.matches(".close")) sfx.play("back");
    else if (el.matches("#prev-anim, #next-anim, #prev-frame, #next-frame")) sfx.play("step");
    else sfx.play("confirm");
  },
  true,
);
document.addEventListener("input", (e) => {
  if (e.target.matches?.('input[type="range"]') && e.target.id !== "frame") sfx.play("step");
});
document.addEventListener("change", (e) => {
  if (e.target.matches?.("select")) sfx.play("confirm");
});

// ---- loop
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    syncImageSizes();
    const slackBefore = slack();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (baseDist) {
      // keep the visitor's orbit and only adjust the distance to the new aspect
      const k = slack() / slackBefore;
      camera.position.sub(controls.target).multiplyScalar(k).add(controls.target);
      cameraLimits(baseDist * slack());
    }
  }
}

// background color, then the 3D scene
function draw(solid = null) {
  renderer.setClearColor(solid ?? (stageOn ? 0x000000 : backgroundColor), 1);
  renderer.clear();
  if (current) current.root.updateMatrixWorld();
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(() => {
  resize();
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.1); // background tab: don't skip the whole animation
  if (playing && current) {
    current.mixer.update(dt * speed);
    if (!interpolate) holdFrame();
    showFrame();
  }
  checkRecording();
  arena.update(now / 1000, canvas.width, canvas.height);
  lastTime = now;
  controls.update(dt); // the time step keeps the showcase's turn at the same speed on any refresh rate
  if (current) {
    current.root.updateMatrixWorld();
    if (current.bones.visible) updateJoints(current.bones);
  }
  draw();
});

// ---- start
// layers: { mesh, wire, bones }; older visits stored one "mesh" mode (solid / wire / both)
let savedLayers = null;
try {
  savedLayers = JSON.parse(recall("layers"));
} catch {}
const oldMode = recall("mesh");
if (!savedLayers && oldMode) savedLayers = { mesh: oldMode !== "wire", wire: oldMode !== "solid", bones: false };
for (const key in layerState) setLayer(key, savedLayers ? !!savedLayers[key] : layerState[key]);
renderDrawers();
setGrid(recall("grid") !== "off");
setSound(sfx.on);
setVolume(Math.round(sfx.volume * 100), false);
setStagePart("lattice", recall("stage-lattice") !== "off");
setStagePart("bands", recall("stage-bands") === "on");
setStage(recall("stage") === "boss");
setPortraitOn(recall("portrait") !== "off", false);
setPortraitSmooth(recall("portrait-filter") !== "off", false);
setShading(shading);
setSurface(surface);
setPictureScale(1);

let savedLight = null;
try {
  savedLight = JSON.parse(recall("light"));
} catch {}
if (savedLight && savedLight.preset in LIGHT_PRESETS) showLight(LIGHT_PRESETS[savedLight.preset], savedLight.preset);
else if (savedLight?.preset === "custom" && ["amb", "dir", "az", "el"].every((k) => Number.isFinite(savedLight[k])))
  showLight(savedLight, "custom");
else showLight(LIGHT_PRESETS.game, "game");

const savedColor = recall("bgcolor");
setColor(/^#[0-9a-f]{6}$/i.test(savedColor ?? "") ? savedColor : DEFAULT_COLOR);

pickMonster(recall("monster") ?? "");
