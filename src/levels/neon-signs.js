import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// ---------------------------------------------------------------------
// Neon signs: a glowing tube round the edge of every board of a material.
//
// The map's signs are plain boxes (a sponsor banner is 10 x 1.4 m and
// 12 cm thick), merged by glb-map into one mesh per material, so a whole
// row of banners is one geometry. Here it is split back into its boxes
// (triangles that share corners belong to the same box), each box's three
// edge directions are read off one corner's three nearest neighbours, and
// a frame of four thin bars is laid round its big face. The bars are a
// little deeper than the board, so the tube wraps the rim and reads from
// either side.
//
// The bars are unlit and brighter than white, so bloom turns them into
// tubes of light; the board's own face is darkened and only softly lit
// in the same colour, the way a real neon sign's backing glows. One mesh
// per colour, so the whole set is a handful of draw calls.
// ---------------------------------------------------------------------

const TUBE = 0.14; // m, the tube's thickness
const _a = new THREE.Vector3();

/**
 * @param {THREE.Object3D} root  where the map's merged meshes are
 * @param {THREE.Scene} scene
 * @param {object} signs  { materialName: { tube, face, faceGlow, glow } }
 *   tube      the neon colour
 *   face      the board's own colour (darker, so the tube stands out)
 *   faceGlow  how strongly the face is backlit in the tube's colour
 *   glow      how far past white the tube is driven (bloom), default 2.6
 * @returns {THREE.Mesh[]}  added to the scene; push them into track.objects
 */
export function neonSigns(root, scene, signs) {
  const bars = new Map(); // material name -> bar geometries
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const spec = o.isMesh && !Array.isArray(o.material) && signs[o.material.name];
    if (!spec) return;
    const m = o.material;
    m.color.set(spec.face);
    m.emissive = new THREE.Color(spec.tube);
    m.emissiveIntensity = spec.faceGlow ?? 0.35;
    // the face's own value is what restyleMaterials() restores and scales
    if (m.userData.base) m.userData.base.emissiveIntensity = m.emissiveIntensity;
    const list = bars.get(m.name) ?? [];
    for (const box of boxesOf(o.geometry, o.matrixWorld)) list.push(...frameBars(box));
    bars.set(m.name, list);
  });

  const out = [];
  for (const [name, list] of bars) {
    if (!list.length) continue;
    const spec = signs[name];
    const c = new THREE.Color(spec.tube).multiplyScalar(spec.glow ?? 2.6);
    const mesh = new THREE.Mesh(mergeGeometries(list, false), new THREE.MeshBasicMaterial({ color: c }));
    for (const g of list) g.dispose();
    mesh.name = `NeonSign_${name}`;
    scene.add(mesh);
    out.push(mesh);
  }
  return out;
}

/** The boxes in a merged geometry: { centre, axes: [u, v, w] (full-length edge vectors) }. */
function boxesOf(geometry, matrix) {
  const pos = geometry.attributes.position;
  const index = geometry.index ? geometry.index.array : [...Array(pos.count).keys()];
  // Weld by position: the exporter splits corners for flat normals.
  const key = (i) => {
    _a.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    return `${Math.round(_a.x * 200)},${Math.round(_a.y * 200)},${Math.round(_a.z * 200)}`;
  };
  const ids = new Map();
  const corner = new Int32Array(pos.count);
  const points = [];
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    if (!ids.has(k)) {
      ids.set(k, points.length);
      points.push(_a.clone());
    }
    corner[i] = ids.get(k);
  }
  // Union-find over triangles: corners of one triangle are one box.
  const parent = points.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let t = 0; t < index.length; t += 3) {
    const a = find(corner[index[t]]);
    parent[find(corner[index[t + 1]])] = a;
    parent[find(corner[index[t + 2]])] = a;
  }
  const groups = new Map();
  points.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  });

  const boxes = [];
  for (const pts of groups.values()) {
    if (pts.length !== 8) continue; // not a box (lettering, a bevelled piece): leave it
    const centre = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / 8);
    // A corner's edges are the nearest corners at right angles to each
    // other. Not simply the three nearest: on a thin board the diagonal
    // across its narrow end is shorter than its long edge.
    const o = pts[0];
    const cand = pts
      .slice(1)
      .map((p) => p.clone().sub(o))
      .sort((a, b) => a.lengthSq() - b.lengthSq());
    const axes = [];
    for (const d of cand) {
      if (axes.every((e) => Math.abs(d.dot(e)) < 0.02 * d.length() * e.length())) axes.push(d);
      if (axes.length === 3) break;
    }
    if (axes.length === 3) boxes.push({ centre, axes });
  }
  return boxes;
}

/** Four bars round the box's largest face, wrapping its rim. */
function frameBars({ centre, axes }) {
  const [w, v, u] = [...axes].sort((a, b) => a.length() - b.length()); // w thinnest, u longest
  const depth = w.length() + TUBE * 2;
  const W = w.clone().normalize();
  const out = [];
  for (const [along, across] of [[u, v], [v, u]]) {
    for (const side of [-0.5, 0.5]) {
      const len = along.length() + TUBE;
      const g = new THREE.BoxGeometry(len, TUBE, depth);
      // box x along the edge, y across the face, z through the board
      const X = along.clone().normalize();
      const Y = across.clone().normalize();
      const Z = W.clone();
      if (new THREE.Vector3().crossVectors(X, Y).dot(Z) < 0) Z.negate();
      const m = new THREE.Matrix4().makeBasis(X, Y, Z);
      m.setPosition(centre.clone().addScaledVector(across, side));
      g.applyMatrix4(m);
      out.push(g);
    }
  }
  return out;
}
