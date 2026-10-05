import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import modelUrl from "../../assets/car/neon-rush-car.glb?url";
import { CAR } from "./config.js";

// ---------------------------------------------------------------------
// The car's visual model (assets/car/neon-rush-car.glb).
//
// This only replaces how the car LOOKS. The collider, suspension and every
// number in config.js are untouched; the model is scaled and placed so its
// wheels sit where CAR.wheels says they are.
//
// The file is authored Z-up with its nose along -X. The game is Y-up with
// the nose along -Z, so a model point (x, y, z) lands at (y, z, x) — a
// proper rotation (no mirroring). The car is left/right symmetric, so
// which side is which only matters for naming the wheels.
//
// Node names drive the mapping:
//   front_*_-1  front left     front_*_1  front right
//   rear_*_-1   rear left      rear_*_1   rear right
//   material "body"  -> the car's paint (per-car colour, takes damage)
//   material "light" -> headlamps,  "red" -> tail lamps
// ---------------------------------------------------------------------

const SCALE = 0.93; // 2.8 m model wheelbase -> the 2.6 m the physics uses
const ZUP_TO_YUP = new THREE.Matrix4().set(
  0, 1, 0, 0,
  0, 0, 1, 0,
  1, 0, 0, 0,
  0, 0, 0, 1
);

let loading = null;
let model = null; // the parsed scene, once loaded

/** Fetch once. Resolves to null (and the procedural car stays) on failure. */
export function loadCarModel() {
  loading ??= new GLTFLoader()
    .loadAsync(modelUrl)
    .then((gltf) => {
      // The file's own materials are used as authored, with one flag: draw
      // both faces. Several of its panels (the -1 side windows, thin plates)
      // face the wrong way, and with the default front-face-only drawing
      // they are skipped and read as holes.
      gltf.scene.traverse((o) => {
        if (o.isMesh) o.material.side = THREE.DoubleSide;
      });
      return (model = gltf.scene);
    })
    .catch((err) => {
      console.error("[car-model] could not load the car model, using the built-in one", err);
      return null;
    });
  return loading;
}

export const carModelReady = () => model !== null;

// Model space -> car-local space: rotate, scale, then drop so the model's
// ground plane (z = 0) is the road under a resting car (y = -comHeight).
const rotScale = new THREE.Matrix4()
  .makeScale(SCALE, SCALE, SCALE)
  .multiply(ZUP_TO_YUP);
const place = new THREE.Matrix4().makeTranslation(0, -CAR.comHeight, 0).multiply(rotScale);

const WHEEL_PART = /^(front|rear)_(?:tire|rim|wheel_inner|spoke|hub)_(-1|1)/;

/**
 * Swap a CarRig's built-in shell and wheels for the model, exactly as
 * authored: its own geometry and materials, untouched. The only things
 * done to it are placing it (rotate, scale, drop to the road) and parking
 * each wheel's parts under a pivot so the wheel can spin and steer.
 * Returns true if the model was used.
 */
export function applyCarModel(rig) {
  if (!model) return false;

  // Keep the steering group (front wheels) and the rear wheel pivots, which
  // hang straight off the chassis; everything else is the built-in shell.
  const keep = new Set([rig.steeringGroup, ...rig.wheelMeshes.map((w) => w.pivot)]);
  for (const c of [...rig.chassisPivot.children]) {
    if (!keep.has(c)) rig.chassisPivot.remove(c);
  }
  for (const w of rig.wheelMeshes) w.mesh.clear();

  // Each node is moved, not cloned, so use a fresh copy of the scene.
  const copy = model.clone(true);

  // Materials are per car. clone(true) shares them with the loaded scene and
  // with every other car, and the ghost makes its materials see-through —
  // on shared ones that turned every car's spoiler, tyres and trim
  // transparent the moment a ghost existed.
  //   body  -> this car's own paint (solid colour, per car)
  //   light -> its headlamps, red -> its neon-red tail lamps
  //   the rest (glass, trim, tyres, rims, metal) are private copies as authored
  const own = new Map();
  const special = { body: rig.bodyMat, light: rig.headMat, red: rig.tailMat };
  for (const m of Object.values(special)) m.side = THREE.DoubleSide;
  copy.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    if (!own.has(src)) own.set(src, special[src.name] ?? src.clone());
    o.material = own.get(src);
  });

  const body = new THREE.Group();
  body.name = "CarModel";
  body.matrixAutoUpdate = false;
  body.matrix.copy(place);
  rig.chassisPivot.add(body);

  const wheelNodes = [[], [], [], []]; // FL FR RL RR
  for (const node of [...copy.children]) {
    const m = WHEEL_PART.exec(node.name);
    if (!m) {
      body.add(node);
      continue;
    }
    wheelNodes[(m[1] === "rear" ? 2 : 0) + (m[2] === "-1" ? 0 : 1)].push(node);
  }

  wheelNodes.forEach((nodes, i) => {
    if (!nodes.length) return;
    const centre = new THREE.Box3();
    for (const n of nodes) centre.union(new THREE.Box3().setFromObject(n));
    const c = centre.getCenter(new THREE.Vector3());

    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(rotScale).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    for (const n of nodes) holder.add(n);

    const w = rig.wheelMeshes[i];
    w.mesh.add(holder);
    const placed = c.clone().applyMatrix4(place);
    w.pivot.position.x = placed.x;
    w.pivot.position.z = placed.z;
  });
  return true;
}
