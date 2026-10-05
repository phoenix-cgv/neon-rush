import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import truckUrl from "../../assets/car/small-truck.glb?url";

// ---------------------------------------------------------------------
// The small truck (assets/car/small-truck.glb), for civilian traffic.
//
// Traffic is drawn with instanced meshes, so the model is flattened once
// into one geometry per material and shared by every truck on the road.
// The file is Y-up with its nose along -X; the game's nose is -Z, hence the
// quarter turn. It stands on y = 0, centred on its own axes.
//
// Materials: "paint" takes each truck's own solid colour (instance colour);
// the lamps glow; everything else is drawn as authored.
// ---------------------------------------------------------------------

export const TRUCK_HALF = { x: 1.0, y: 1.0, z: 2.1 }; // collider half extents, m
export const TRUCK_COLOURS = [0xf2c200, 0xd8322a, 0x1e6bff, 0xe8602c, 0x12a05a, 0xeceff1, 0x8f2bff];

const GLOW = new Set(["headlight", "amber", "tail"]);

let loading = null;
let parts = null; // [{ name, geometry, material }] once loaded

export function loadTruckModel() {
  loading ??= new GLTFLoader()
    .loadAsync(truckUrl)
    .then((gltf) => (parts = flatten(gltf.scene)))
    .catch((err) => {
      console.error("[truck-model] could not load the truck, traffic stays cars only", err);
      return null;
    });
  return loading;
}

/** The flattened truck, or null if it has not loaded. */
export const truckParts = () => parts;

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
