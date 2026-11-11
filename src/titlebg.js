// The title screen's background (title/title_logo.c of the decompilation), for the first screen of the site: a flat tunnel of circuit boards
// that turns, scrolls and pulses green.
//
//   * TitleLogoTask_initTunnel: 6 rings of 33 points (the first is the last again), ring r with radius 4096 >> (6 - r) (64 .. 2048) at
//     z = -64 * (r + 1), drawn by TitleLogoTask_drawPanels as 5 x 32 panels (a ring and the next, a 16 texel wide slice of the 192 x 64
//     strip of title.tim images 5, 6 and 7, slice (panel % 12), and all 64 rows from v, which is ~counter & 63: the strip is stored twice, one
//     under the other, so that it wraps). The model is turned about z by TITLE_SPIN (it adds the sine of an angle that grows by 4, divided
//     by 256, each tick: it swings back and forth over 34 seconds) and moved to z = 2048; the camera looks from z = -2560 at the origin
//     with the game's field of view (30 degrees on a 512 wide screen: 955 px away). The corners of a ring are dimmer the nearer the
//     centre: ring r is r * 21 of the 128 that mean full brightness, once the logo is up (it comes up over 60 ticks);
//   * func_8007236C: each tick colours 0 and 15 of the CLUT are green, (t >> 2, t, t >> 2) of 5 bits with t = 16 + d and 15 - d, d being
//     the sine of an angle that grows by 64 a tick (a turn in 64 ticks) divided by 512, so -8 to 8.
//
// The counter goes up by 2 a tick (spawnRate) and the game runs at 30 ticks a second. Everything is drawn by three.js; the colour numbers of
// the strip are a grey texture and the CLUT a 16 x 1 one that is rewritten each tick (src/titletunnel.js, public/ui/title-tunnel.png).
import * as THREE from "three";
import { TUNNEL_PALETTE } from "./titletunnel.js";

const TICK = 30;
const RINGS = 6;
const PANELS = 32;
const PROJECTION = 955; // px of a 512 x 480 screen
const SHADE = 21 / 128; // the brightness one ring adds
const FADE_TICKS = 60;

const sin = (a) => Math.round(Math.sin(((a & 0xfff) * Math.PI * 2) / 4096) * 4096);
const cos = (a) => Math.round(Math.cos(((a & 0xfff) * Math.PI * 2) / 4096) * 4096);

function buildGeometry() {
  const ring = (r, i) => [sin(i * 128) >> (6 - r), cos(i * 128) >> (6 - r), -64 * (r + 1)];
  const position = [];
  const strip = []; // per vertex: u in the strip (px), 0 inner or 1 outer edge, brightness
  for (let r = 0; r < RINGS - 1; r++) {
    for (let i = 0; i < PANELS; i++) {
      const u = (i % 12) * 16;
      const corners = [
        [ring(r, i), u, 0, r],
        [ring(r, i + 1), u + 16, 0, r],
        [ring(r + 1, i), u, 1, r + 1],
        [ring(r + 1, i + 1), u + 16, 1, r + 1],
      ];
      for (const k of [0, 1, 2, 1, 3, 2]) {
        const [p, pu, edge, level] = corners[k];
        position.push(...p);
        strip.push(pu, edge, level * SHADE);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("strip", new THREE.Float32BufferAttribute(strip, 3));
  return geometry;
}

const material = (indexTexture, paletteTexture) =>
  new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      index: { value: indexTexture },
      palette: { value: paletteTexture },
      scroll: { value: 0 },
      level: { value: 0 },
    },
    vertexShader: `
      attribute vec3 strip;
      varying vec3 vStrip;
      void main() {
        vStrip = strip;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D index;
      uniform sampler2D palette;
      uniform float scroll;
      uniform float level;
      varying vec3 vStrip;
      void main() {
        vec2 uv = vec2(vStrip.x / 192.0, (scroll + vStrip.y * 64.0) / 128.0);
        float number = floor(texture2D(index, uv).r * 255.0 / 17.0 + 0.5);
        vec3 color = texture2D(palette, vec2((number + 0.5) / 16.0, 0.5)).rgb;
        gl_FragColor = vec4(color * vStrip.z * level, 1.0);
      }`,
  });

// the two colours the game pulses, as 8 bit RGB, at a tick
function pulse(tick) {
  const d = sin(tick * 64) >> 9;
  const green = (t) => [(t >> 2) * 8.226, (t & 31) * 8.226, (t >> 2) * 8.226].map(Math.round);
  return [green((d + 16) & 0xff), green((15 - d) & 0xff)];
}

// canvas: fills its box. Returns { start, stop }; start() draws, with its own frame loop, until stop()
export function createTitleBackground(canvas, base) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  const camera = new THREE.PerspectiveCamera(30, 1, 100, 20000);
  camera.position.set(0, 0, -2560);
  camera.lookAt(0, 0, 0);
  const scene = new THREE.Scene();

  const indexTexture = new THREE.DataTexture(new Uint8Array(192 * 128), 192, 128, THREE.RedFormat, THREE.UnsignedByteType);
  const paletteData = new Uint8Array(16 * 4);
  const paletteTexture = new THREE.DataTexture(paletteData, 16, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  for (const texture of [indexTexture, paletteTexture]) {
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
  }
  const mat = material(indexTexture, paletteTexture);
  const tunnel = new THREE.Mesh(buildGeometry(), mat);
  tunnel.frustumCulled = false;
  tunnel.position.z = 2048;
  scene.add(tunnel);

  function setPalette(tick) {
    const colors = TUNNEL_PALETTE.map((c) => [...c]);
    [colors[0], colors[15]] = pulse(tick);
    colors.forEach((c, i) => paletteData.set([...c, 255], i * 4));
    paletteTexture.needsUpdate = true;
  }
  setPalette(0);

  // the strip of colour numbers, twice (the second copy is what v reads when it passes row 63)
  const image = new Image();
  image.onload = () => {
    const c = document.createElement("canvas");
    c.width = 192;
    c.height = 64;
    const ctx = c.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, 192, 64).data;
    const data = indexTexture.image.data;
    for (let i = 0; i < 192 * 64; i++) data[i] = data[192 * 64 + i] = Math.round(pixels[i * 4] / 17) * 17;
    indexTexture.needsUpdate = true;
  };
  image.src = `${base}ui/title-tunnel.png`;

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    // the game's picture is 512 x 480 (half the diagonal 351 px); wider or taller windows keep rings 4 and 5 around them
    const half = 420 / Math.hypot(w / h, 1);
    camera.aspect = w / h;
    camera.fov = (2 * Math.atan(half / PROJECTION) * 180) / Math.PI;
    camera.updateProjectionMatrix();
  }

  let frame = 0;
  let t0 = 0;
  let tick = -1; // the last tick that ran
  let spin = 0;
  let spinNext = 0;
  let spinPhase = 0;

  function draw(now) {
    frame = requestAnimationFrame(draw);
    const ticks = ((now - t0) / 1000) * TICK;
    while (tick < Math.floor(ticks)) {
      tick++;
      spin = spinNext;
      spinNext = spin + (sin(spinPhase) >> 8);
      spinPhase += 4;
      setPalette(tick);
    }
    const f = ticks - Math.floor(ticks);
    tunnel.rotation.z = ((spin + (spinNext - spin) * f) * Math.PI * 2) / 4096;
    mat.uniforms.scroll.value = 63 - (Math.floor(ticks * 2) & 0x3f); // ~counter & 0x3F, the counter going up by 2 a tick
    mat.uniforms.level.value = Math.min(1, ticks / FADE_TICKS);
    resize();
    renderer.render(scene, camera);
  }

  return {
    start() {
      if (frame) return;
      t0 = performance.now();
      tick = -1;
      spin = spinNext = spinPhase = 0;
      frame = requestAnimationFrame(draw);
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      renderer.dispose();
      indexTexture.dispose();
      paletteTexture.dispose();
    },
  };
}
