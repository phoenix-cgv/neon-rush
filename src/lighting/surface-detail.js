import * as THREE from "three";
import { addPatch } from "./material-patches.js";

// ---------------------------------------------------------------------
// Surface detail: NORMAL MAPS, generated in code, projected without UVs.
//
// A normal map is a texture whose colours are not colours but
// directions: each pixel says which way that point of the surface faces.
// Lighting reads it instead of the flat face's own normal, so a flat
// wall shades as if it had brick courses and mortar grooves, and a flat
// road as if it had grit, without a single extra triangle.
//
// THE MAPS are made here, at startup, from height fields: a small
// program draws how high each point is (bricks raised above mortar,
// grains of aggregate, pebbles, slab joints), then the slope of that
// height at every pixel is turned into a direction. No image files, no
// Blender; every one is ours. Each tiles seamlessly (all the noise wraps
// around), so it can repeat across a whole building or road.
//
// TRIPLANAR PROJECTION. The maps' meshes have no texture coordinates: the
// map loader (src/levels/glb-map.js) rebuilds every mesh from positions
// and normals alone. So the texture is projected from the WORLD position
// instead, three times: once from above (onto x-z), once from the side
// (y-z) and once from the front (x-y). Each surface uses the projections
// facing it, blended by how squarely it faces each axis: a road takes
// the top-down one, a wall the side ones, a slope a mix. This is also why
// detail never stretches on a long thin mesh the way a UV map can.
//
// Combining the projected normal with the surface's own uses the
// "whiteout" blend (after Ben Golus, "Normal Mapping for a Triplanar
// Shader", 2017): add the map's tilt to the surface's, keep the surface's
// up. It is inserted into three's MeshStandardMaterial after its own
// normal step, so every light, shadow and reflection uses the bumps.
//
// Per level, in `lit.detail`: { materialName: { map, size, strength } }
//   map       one of the generators below
//   size      metres one tile of the texture covers
//   strength  how pronounced the bumps are (0 flat .. ~1.5)
// ---------------------------------------------------------------------

const RES = 512;

/** Hash two lattice coordinates to 0..1, wrapping with period p. */
function hash(i, j, p, seed) {
  i = ((i % p) + p) % p;
  j = ((j % p) + p) % p;
  let h = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable value noise at (x, y) in 0..1 texture space, `cells` across. */
function noise(x, y, cells, seed = 0) {
  const fx = x * cells;
  const fy = y * cells;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  let u = fx - i;
  let v = fy - j;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  const a = hash(i, j, cells, seed);
  const b = hash(i + 1, j, cells, seed);
  const c = hash(i, j + 1, cells, seed);
  const d = hash(i + 1, j + 1, cells, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, cells, octaves, seed) {
  let v = 0;
  let amp = 0.5;
  for (let o = 0; o < octaves; o++) {
    v += amp * noise(x, y, cells << o, seed + o);
    amp *= 0.5;
  }
  return v;
}

/** A groove profile: 0 in a joint `w` wide at multiples of `period`, 1 elsewhere. */
function joint(t, period, w) {
  const d = Math.abs(((t % period) + period) % period - period / 2); // distance from the middle of a tile
  return THREE.MathUtils.smoothstep(period / 2 - d, 0, w);
}

// Height fields, (u, v) in 0..1 -> height 0..1.
const HEIGHTS = {
  // Asphalt: fine aggregate, two scales of grit.
  grain: (u, v) => 0.55 * noise(u, v, 96, 1) + 0.45 * noise(u, v, 192, 2),

  // Gravel: rounded pebbles, one per cell, at a random spot in it.
  gravel: (u, v) => {
    const N = 24;
    const ci = Math.floor(u * N);
    const cj = Math.floor(v * N);
    let h = 0;
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        const i = ci + di;
        const j = cj + dj;
        const px = (i + 0.2 + 0.6 * hash(i, j, N, 3)) / N;
        const py = (j + 0.2 + 0.6 * hash(i, j, N, 4)) / N;
        const r = (0.35 + 0.25 * hash(i, j, N, 5)) / N;
        const d = Math.hypot(u - px, v - py) / r;
        if (d < 1) h = Math.max(h, Math.sqrt(1 - d * d));
      }
    return h;
  },

  // Brick: 4 bricks across a tile and 8 courses up, every other course
  // offset by half a brick, mortar grooves between; a little roughness on
  // each brick face.
  brick: (u, v) => {
    const row = Math.floor(v * 8);
    const uu = u + (row % 2 ? 1 / 8 : 0);
    const h = Math.min(joint(uu, 1 / 4, 0.012), joint(v, 1 / 8, 0.012));
    return h * (0.85 + 0.15 * noise(u, v, 64, 6));
  },

  // Paving: square slabs, 4 across a tile, with a fine surface texture.
  tiles: (u, v) => Math.min(joint(u, 1 / 4, 0.008), joint(v, 1 / 4, 0.008)) * (0.9 + 0.1 * noise(u, v, 128, 7)),

  // Concrete: large cast panels, 2 across, and the pitted face of concrete.
  panels: (u, v) => Math.min(joint(u, 1 / 2, 0.005), joint(v, 1 / 2, 0.005)) * (0.85 + 0.15 * fbm(u, v, 32, 3, 8)),

  // Rock: fractal noise with the ridges folded up, for strata and cracks.
  rock: (u, v) => {
    const n = fbm(u, v, 8, 5, 9);
    return 1 - Math.abs(n * 2 - 1);
  },
};

const cache = new Map();

/** Build (once) the normal map for one height field. */
export function normalMap(kind) {
  if (cache.has(kind)) return cache.get(kind);
  const f = HEIGHTS[kind];
  const h = new Float32Array(RES * RES);
  for (let y = 0; y < RES; y++)
    for (let x = 0; x < RES; x++) h[y * RES + x] = f(x / RES, y / RES);

  // Slope by central differences (wrapping, so the tile stays seamless),
  // turned into a unit direction: tilt in x and y, up in z. Stored as
  // colour (-1..1 -> 0..255), the usual normal-map encoding.
  const data = new Uint8Array(RES * RES * 4);
  const k = 6; // how steep a full 0..1 height step is across 2 pixels
  for (let y = 0; y < RES; y++)
    for (let x = 0; x < RES; x++) {
      const l = h[y * RES + ((x - 1 + RES) % RES)];
      const r = h[y * RES + ((x + 1) % RES)];
      const d = h[((y - 1 + RES) % RES) * RES + x];
      const u = h[((y + 1) % RES) * RES + x];
      let nx = (l - r) * k;
      let ny = (d - u) * k;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * RES + x) * 4;
      data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, RES, RES, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace; // directions, not colours
  tex.needsUpdate = true;
  cache.set(kind, tex);
  return tex;
}

/** One switch for every detailed material, set from the quality preset. */
export const detailSwitch = { uDetailOn: { value: 1 } };

const VERT_PARS = /* glsl */ `varying vec3 vDetailPos;`;
const VERT_MAIN = /* glsl */ `vDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`;

const FRAG_PARS = /* glsl */ `
  uniform sampler2D uDetailMap;
  uniform float uDetailScale;    // 1 / metres per tile
  uniform float uDetailStrength;
  uniform float uDetailOn;       // 0 on "low" quality: no sampling at all
  varying vec3 vDetailPos;

  // One projection's normal-map sample, as a tilt (xy) and up (z).
  vec3 detailSample(vec2 p, float strength) {
    vec3 t = texture2D(uDetailMap, p * uDetailScale).xyz * 2.0 - 1.0;
    t.xy *= strength;
    return t;
  }
`;

const FRAG_MAIN = /* glsl */ `
  // Faded out with distance: past ~90 m a bump is smaller than a pixel,
  // and skipping the work there is most of what keeps this cheap.
  float detailFade = uDetailOn * (1.0 - smoothstep(40.0, 90.0, length(vViewPosition)));
  if (detailFade > 0.0) {
    float k = uDetailStrength * detailFade;
    // The surface normal so far is in VIEW space; take it to world space
    // (the view matrix's rotation is orthonormal, so its transpose undoes it).
    vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    // How much each projection applies: sharpened so a wall takes almost
    // only its side projections and a road only the top-down one.
    vec3 w = pow(abs(wN), vec3(4.0));
    w /= (w.x + w.y + w.z);
    // A projection that contributes almost nothing is not sampled at all:
    // a road reads one texture, a wall one or two, never all three.
    vec3 noTilt = vec3(0.0, 0.0, 1.0);
    vec3 tX = w.x > 0.02 ? detailSample(vDetailPos.zy, k) : noTilt;
    vec3 tY = w.y > 0.02 ? detailSample(vDetailPos.xz, k) : noTilt;
    vec3 tZ = w.z > 0.02 ? detailSample(vDetailPos.xy, k) : noTilt;
    // Whiteout blend: add the map's tilt to the surface's own, keep up.
    tX = vec3(tX.xy + wN.zy, abs(tX.z) * wN.x);
    tY = vec3(tY.xy + wN.xz, abs(tY.z) * wN.y);
    tZ = vec3(tZ.xy + wN.xy, abs(tZ.z) * wN.z);
    vec3 detailed = normalize(tX.zyx * w.x + tY.xzy * w.y + tZ.xyz * w.z);
    normal = normalize((viewMatrix * vec4(detailed, 0.0)).xyz);
  }
`;

/**
 * Give one standard material projected normal-map detail.
 * Idempotent per material: a material gets one detail patch.
 */
export function addDetail(material, { map = "grain", size = 2, strength = 1 } = {}) {
  const uniforms = {
    uDetailMap: { value: normalMap(map) },
    uDetailScale: { value: 1 / size },
    uDetailStrength: { value: strength },
    ...detailSwitch, // shared, not copied: one value turns them all off
  };
  addPatch(material, "detail", (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAG_MAIN}`);
  });
}
