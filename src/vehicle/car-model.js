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
    .then((gltf) => (model = gltf.scene))
    .catch((err) => {
      console.error("[car-model] could not load the car model, using the built-in one", err);
      return null;
    });
  return loading;
}

export const carModelReady = () => model !== null;

// Model space -> car-local space: rotate, scale, then drop so the model's
// ground plane (z = 0) is the road under a resting car (y = -comHeight).
const place = new THREE.Matrix4()
  .makeTranslation(0, -CAR.comHeight, 0)
  .multiply(new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE))
  .multiply(ZUP_TO_YUP);

/**
 * Make triangle winding agree with the shape's volume. Some parts of the
 * model (thin plates like the wing) are wound inside-out, and with back-face
 * culling an inside-out part is simply not drawn — it looks transparent.
 * A closed part has positive signed volume when it faces outward; if it is
 * negative, swap two vertices of every triangle.
 */
function orientOutward(g) {
  const p = g.attributes.position;
  let vol = 0;
  for (let i = 0; i < p.count; i += 3) {
    const ax = p.getX(i), ay = p.getY(i), az = p.getZ(i);
    const bx = p.getX(i + 1), by = p.getY(i + 1), bz = p.getZ(i + 1);
    const cx = p.getX(i + 2), cy = p.getY(i + 2), cz = p.getZ(i + 2);
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (vol >= 0) return;
  for (let i = 0; i < p.count; i += 3) {
    const x = p.getX(i + 1), y = p.getY(i + 1), z = p.getZ(i + 1);
    p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
    p.setXYZ(i + 2, x, y, z);
  }
}

/** Flat-shaded, with planar UVs so the scratch texture has somewhere to land. */
function prepare(mesh) {
  let g = mesh.geometry.clone().applyMatrix4(place);
  if (g.index) g = g.toNonIndexed();
  g.deleteAttribute("uv");
  orientOutward(g);
  g.computeVertexNormals();
  const p = g.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = p.getX(i) / 2.4 + 0.5;
    uv[i * 2 + 1] = p.getZ(i) / 4.8 + 0.5;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Swap a CarRig's built-in shell and wheels for the model. Call after the
 * rig has built its wheels and before it merges draw calls.
 */
export function applyCarModel(rig) {
  if (!model) return false;

  // clear the procedural shell (everything on the pivot but the steering group)
  for (const c of [...rig.chassisPivot.children]) {
    if (c !== rig.steeringGroup) rig.chassisPivot.remove(c);
  }
  for (const w of rig.wheelMeshes) w.mesh.clear();

  const paintFor = {
    body: rig.bodyMat,
    light: rig.headMat,
    red: rig.tailMat,
  };

  const wheelParts = [[], [], [], []]; // FL FR RL RR
  model.traverse((o) => {
    if (!o.isMesh) return;
    const mat = paintFor[o.material.name] ?? o.material;
    // Belt and braces: a part that is still wound the wrong way (an open
    // sheet has no volume to judge by) is drawn from both sides.
    mat.side = THREE.DoubleSide;
    const geo = prepare(o);
    const name = o.name;
    const wm = /^(front|rear)_(?:tire|rim|wheel_inner|spoke|hub)_(-1|1)/.exec(name);
    if (wm) {
      const idx = (wm[1] === "rear" ? 2 : 0) + (wm[2] === "-1" ? 0 : 1);
      wheelParts[idx].push({ geo, mat });
    } else {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      rig.chassisPivot.add(mesh);
    }
  });

  wheelParts.forEach((parts, i) => {
    if (!parts.length) return;
    // centre of the wheel from its tyre/rim bounds, so it spins about its axle
    const box = new THREE.Box3();
    for (const { geo } of parts) {
      geo.computeBoundingBox();
      box.union(geo.boundingBox);
    }
    const c = box.getCenter(new THREE.Vector3());
    const w = rig.wheelMeshes[i];
    for (const { geo, mat } of parts) {
      geo.translate(-c.x, -c.y, -c.z);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      w.mesh.add(mesh);
    }
    w.pivot.position.x = c.x;
    w.pivot.position.z = c.z;
  });
  return true;
}
