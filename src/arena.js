// The "Boss" stage (arena 6), round 1, rebuilt from the game's data and code (decomp: src/battle/stages/st06/st06.c):
//
//   * the colourful lattice is code, not a model: StageBoss's func_800D4958 (18 x 12 points on the ground, x from -0x2000
//     by 0x3C3, z from -0x5D1 by 0x5D1), func_800D4A00 (one hue for all of them, +8 a tick, 0x600 = a turn; the brightness
//     of a point is a half sine along x times a linear fade along z, saturation 0xFF) and func_800D4B78 (for each cell a
//     LINE_G4: the point, its x neighbour, its z neighbour, then 0x800 straight down to black), all at a level of 0xFF;
//   * the four bands (steel truss, bars, circuit, hexagons) are the map06.dmm meshes of nodes 0..3: St06Spinner turns each
//     about a random axis at 1 to 8 units of 4096 a tick (and by twice that about y), scaled by 40 * level / 4096 (level
//     0xFF = 2.49x), all centred on the fighters. Their texels are additive (the TMD primitives are semi-transparent).
//
// Coordinates are the game's (x right, y down, z forward); the group is turned 180 degrees about x into Y up, like the
// characters' root node. The game runs at 30 ticks a second.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const TICK = 30;
const HUE_TURN = 0x600;
const POINTS_X = 18;
const POINTS_Z = 12;
const PITCH_X = 0x3c3;
const PITCH_Z = 0x5d1;
const START_X = -0x2000;
const START_Z = -0x5d1;
const DROP = 0x800;
const LEVEL = 0xff;
const LATTICE_SCALE = (LEVEL * 16) / 4096; // matrixScale(1, level << 4, level << 4)
const BAND_SCALE = (LEVEL * 40) / 4096;
const FAR = 90000;

// convertHsvToRgb (src/engine/gfx/color.c) with the lattice's saturation of 0xFF, returned as 0..1 floats
function hsv(hue, value) {
  const angle = ((hue % HUE_TURN) + HUE_TURN) % HUE_TURN;
  const i = angle & 0xff;
  const sat = 0xff;
  const p = Math.floor((value * (0xff00 - sat * 0x100) + 0x7f80) / 0xff00);
  const q = Math.floor((value * (0xff00 - sat * i) + 0x7f80) / 0xff00);
  const t = Math.floor((value * (0xff00 - sat * (0x100 - i)) + 0x7f80) / 0xff00);
  let r, g, b;
  switch (angle >> 8) {
    case 0:
      [r, g, b] = [value, t, p];
      break;
    case 1:
      [r, g, b] = [q, value, p];
      break;
    case 2:
      [r, g, b] = [p, value, t];
      break;
    case 3:
      [r, g, b] = [p, q, value];
      break;
    case 4:
      [r, g, b] = [t, p, value];
      break;
    default:
      [r, g, b] = [value, p, q];
  }
  return [r / 255, g / 255, b / 255];
}

// the brightness (0..255 value) of each lattice point: func_800D4A00 at level 0xFF
const BRIGHTNESS = (() => {
  const value = LEVEL >> 1;
  const out = [];
  for (let i = 0; i < POINTS_X; i++) {
    const angle = Math.floor(Math.floor(((i << 11) * 0x78787879) / 2 ** 32) / 8) & 0xfff;
    const sin = Math.round(Math.sin((angle * Math.PI * 2) / 4096) * 4096);
    const amp = (value * sin) >> 12;
    const row = [];
    for (let j = 0; j < POINTS_Z; j++) row.push(Math.max(0, Math.floor((amp * (11 - j)) / 11)) & 0xff);
    out.push(row);
  }
  return out;
})();

function buildLattice() {
  const pos = [];
  const owner = []; // per vertex: the point it takes its colour from, or -1 for the black end of a drop
  const P = (i, j) => [START_X + i * PITCH_X, 0, START_Z + j * PITCH_Z];
  const id = (i, j) => i * POINTS_Z + j;
  const seg = (a, ia, b, ib) => {
    pos.push(...a, ...b);
    owner.push(ia, ib);
  };
  for (let j = 0; j < POINTS_Z - 1; j++) {
    for (let r = 0; r < POINTS_X - 1; r++) {
      const p0 = P(r, j);
      const p1 = P(r + 1, j);
      const p2 = P(r, j + 1);
      const p3 = [p2[0], p2[1] + DROP, p2[2]];
      seg(p0, id(r, j), p1, id(r + 1, j));
      seg(p1, id(r + 1, j), p2, id(r, j + 1));
      seg(p2, id(r, j + 1), p3, -1);
    }
  }
  // fat lines: the game's lines are one pixel of a 320 x 240 picture, a few pixels on this screen
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(pos);
  const colors = new Float32Array(owner.length * 3);
  geometry.setColors(colors); // keeps this very array: update() rewrites it each frame
  const material = new LineMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    linewidth: 2,
  });
  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  lines.scale.set(1, LATTICE_SCALE, LATTICE_SCALE);
  lines.renderOrder = -3;
  return { lines, material, owner, colors, buffer: geometry.getAttribute("instanceColorStart").data };
}

export function createArena(base) {
  const group = new THREE.Group();
  group.rotation.x = Math.PI; // the game's y is down, z forward
  group.visible = false;

  const lattice = buildLattice();
  group.add(lattice.lines);

  const bandsGroup = new THREE.Group();
  group.add(bandsGroup);
  const spinners = [];
  let strip = null;
  let loaded = null;

  function randomizeSpinners() {
    for (const s of spinners) {
      s.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      s.angle = Math.random() * 4096;
      s.speed = 1 + Math.floor(Math.random() * 8);
    }
  }

  function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      const [data, texture] = await Promise.all([
        fetch(`${base}arena/boss.json`).then((r) => r.json()),
        new THREE.TextureLoader().loadAsync(`${base}arena/boss.png`),
      ]);
      texture.magFilter = texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      for (const band of data.bands) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(band.pos, 3));
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(band.uv, 2));
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(band.col, 3));
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          vertexColors: true,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: band.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
          alphaTest: band.additive ? 0 : 0.5,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = -2;
        if (band.node < 4) {
          mesh.scale.setScalar(BAND_SCALE);
          bandsGroup.add(mesh);
          spinners.push({ mesh, axis: new THREE.Vector3(), angle: 0, speed: 1 });
        } else {
          strip = mesh;
          strip.visible = false; // the flat strip at the fighters' feet: not part of the look (see main.js)
          group.add(strip);
        }
      }
      randomizeSpinners();
    })();
    return loaded;
  }

  const qa = new THREE.Quaternion();
  const qy = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  // seconds: any monotonic clock; width and height: the drawing buffer (the lines are as thick in its pixels)
  function update(seconds, width, height) {
    if (!group.visible) return;
    lattice.material.resolution.set(width, height);
    lattice.material.linewidth = Math.max(2, height / 240); // one pixel of the game's 320 x 240 picture
    const ticks = seconds * TICK;
    if (lattice.lines.visible) {
      const hue = (ticks * 8) % HUE_TURN;
      const cache = new Array(POINTS_X * POINTS_Z);
      const { owner, colors, buffer } = lattice;
      for (let v = 0; v < owner.length; v++) {
        const point = owner[v];
        let c = [0, 0, 0];
        if (point >= 0) {
          c = cache[point] ??= hsv(hue, BRIGHTNESS[(point / POINTS_Z) | 0][point % POINTS_Z]);
        }
        colors[v * 3] = c[0];
        colors[v * 3 + 1] = c[1];
        colors[v * 3 + 2] = c[2];
      }
      buffer.needsUpdate = true;
    }
    if (bandsGroup.visible) {
      for (const s of spinners) {
        const turn = ((s.angle + s.speed * ticks) * Math.PI * 2) / 4096;
        qa.setFromAxisAngle(s.axis, turn);
        qy.setFromAxisAngle(up, turn * 2);
        s.mesh.quaternion.copy(qa).multiply(qy); // matrixRotateAxis, then matrixRotateY(2 * angle)
      }
    }
  }

  return {
    group,
    far: FAR,
    load,
    setLattice: (on) => (lattice.lines.visible = on),
    setBands: (on) => (bandsGroup.visible = on),
    reroll: randomizeSpinners,
    update,
  };
}
