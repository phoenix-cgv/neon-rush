import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import truckUrl from "../../assets/car/small-truck.glb?url";
import carUrl from "../../assets/car/regular-car.glb?url";

// ---------------------------------------------------------------------
// Traffic vehicle models: the regular car and the small truck
// (assets/car/regular-car.glb, small-truck.glb).
//
// Traffic is drawn with instanced meshes, so each model is flattened once
// into one geometry per material and shared by every vehicle of that kind.
// Both files are Y-up with their nose along -X; the game's nose is -Z,
// hence the quarter turn. Each stands on y = 0, centred on its own axes.
//
// Materials: "paint" takes each vehicle's own solid colour (instance
// colour); lamps glow; everything else is drawn as authored.
// ---------------------------------------------------------------------

export const TRAFFIC_MODELS = {
  car: {
    url: carUrl,
    half: { x: 1.05, y: 0.77, z: 2.3 }, // collider half extents, m
    colours: [0xd8322a, 0x1e6bff, 0xf2c200, 0x12a05a, 0xeceff1, 0x8f2bff, 0x00a8c8, 0x1f2a36, 0xe84393, 0x9aa5ad],
  },
  truck: {
    url: truckUrl,
    half: { x: 1.0, y: 1.0, z: 2.1 },
    colours: [0xf2c200, 0xd8322a, 0x1e6bff, 0xe8602c, 0x12a05a, 0xeceff1, 0x8f2bff],
  },
};

const GLOW = new Set(["headlight", "amber", "tail"]);

const loading = {};
const parts = {}; // kind -> [{ name, geometry, material }] once loaded

/** Load every traffic model. A kind that fails to load is simply absent. */
export function loadTrafficModels() {
  return Promise.all(
    Object.entries(TRAFFIC_MODELS).map(([kind, def]) => {
      loading[kind] ??= new GLTFLoader()
        .loadAsync(def.url)
        .then((gltf) => (parts[kind] = flatten(gltf.scene)))
        .catch((err) => {
          console.error(`[traffic-models] could not load the ${kind}; traffic falls back`, err);
          return null;
        });
      return loading[kind];
    })
  );
}

/** The flattened model for a kind, or undefined if it has not loaded. */
export const trafficParts = (kind) => parts[kind];

function flatten(scene) {
  scene.updateMatrixWorld(true);
  const turn = new THREE.Matrix4().makeRotationY(-Math.PI / 2); // nose -X -> -Z
  const byMat = new Map();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    let g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(turn, o.matrixWorld));
    if (g.index) g = g.toNonIndexed();
    for (const a of Object.keys(g.attributes)) if (a !== "position") g.deleteAttribute(a);
    g.computeVertexNormals(); // flat-shaded, like the rest of the game
    const key = o.material;
    if (!byMat.has(key)) byMat.set(key, []);
    byMat.get(key).push(g);
  });
  const out = [];
  for (const [src, geos] of byMat) {
    const material = src.clone();
    material.side = THREE.DoubleSide;
    if (GLOW.has(src.name)) {
      material.emissive = material.color.clone();
      material.emissiveIntensity = 1.2;
    }
    out.push({ name: src.name, geometry: mergeGeometries(geos, false), material });
  }
  return out;
}
