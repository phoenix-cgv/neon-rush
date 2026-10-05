import * as THREE from "three";

// ---------------------------------------------------------------------
// Blocky pedestrians: cube-built people (head, torso, two arms, two legs,
// hair and eyes) in the proportions of a voxel-game character — the body
// is 8 units wide, 12 tall and 4 deep on a head of 8, 1 unit = 5.6 cm, so a
// figure stands 1.8 m. Original shapes and colours, not any game's skins.
//
// Each body part is ONE InstancedMesh shared by every person, so the whole
// crowd is ten draw calls however many people stand on the pavement.
// Instances are static (they stand and watch), posed once at build time.
// ---------------------------------------------------------------------

const U = 0.05625; // metres per unit
const P = {
  head: [8 * U, 8 * U, 8 * U],
  torso: [8 * U, 12 * U, 4 * U],
  arm: [4 * U, 12 * U, 4 * U],
  leg: [4 * U, 12 * U, 4 * U],
};
const LEG_H = 12 * U;
const TORSO_H = 12 * U;

const SKIN = [0xf1c9a5, 0xd9a273, 0xa86f45, 0x6d4630];
const HAIR = [0x2b1d14, 0x5a3b22, 0xc9a24a, 0x161616, 0x8a4a2a];
const SHIRT = [0xd8322a, 0x1e6bff, 0xf2c200, 0x12a05a, 0x8f2bff, 0x00a8c8, 0xe8602c, 0xeceff1, 0xe84393];
const TROUSER = [0x2a3a5c, 0x23262b, 0x4b3b2c, 0x3a4a3a, 0x59616b];

const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];

// Deterministic, so the same crowd stands in the same places every visit.
const rng = (i, k) => {
  const x = Math.sin(i * 91.7 + k * 17.3 + 5.1) * 43758.5453;
  return x - Math.floor(x);
};

export class BlockyCrowd {
  /**
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {{x:number, y:number, z:number, scale?:number}[]} spots  feet positions
   */
  constructor(scene, track, spots) {
    this.scene = scene;
    const n = spots.length;
    this.meshes = [];

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
    const make = (size, material) => {
      const m = new THREE.InstancedMesh(new THREE.BoxGeometry(...size), material, n);
      m.castShadow = true;
      m.frustumCulled = false; // spread along the whole lap
      scene.add(m);
      this.meshes.push(m);
      return m;
    };
    const head = make(P.head, mat);
    const hairTop = make([P.head[0] + 0.02, 0.09, P.head[2] + 0.02], mat);
    const hairBack = make([P.head[0] + 0.02, P.head[1] * 0.7, 0.09], mat);
    const eyeL = make([0.07, 0.07, 0.03], eyeMat);
    const eyeR = make([0.07, 0.07, 0.03], eyeMat);
    const torso = make(P.torso, mat);
    const armL = make(P.arm, mat);
    const armR = make(P.arm, mat);
    const legL = make(P.leg, mat);
    const legR = make(P.leg, mat);

    const root = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const fr = {};
    const put = (mesh, i, x, y, z, colourHex) => {
      local.makeTranslation(x, y, z);
      m4.multiplyMatrices(root, local);
      mesh.setMatrixAt(i, m4);
      if (colourHex !== undefined) mesh.setColorAt(i, col.setHex(colourHex));
    };

    spots.forEach((s, i) => {
      const scale = s.scale ?? 1;
      // Turn to face the road (most of them), or the way the cars go.
      pos.set(s.x, s.y, s.z);
      const pr = track.project(pos);
      track.frameAt(pr.s, fr);
      const towardRoad = -Math.sign(pr.t || 1);
      const dirx = fr.right.x * towardRoad;
      const dirz = fr.right.z * towardRoad;
      let yaw = Math.atan2(-dirx, -dirz);
      yaw += rng(i, 1) < 0.35 ? Math.PI / 2 * (rng(i, 2) < 0.5 ? 1 : -1) : 0;
      yaw += (rng(i, 3) - 0.5) * 0.7;

      q.setFromAxisAngle(up, yaw);
      sc.set(scale, scale, scale);
      root.compose(pos, q, sc);

      const skin = pick(SKIN, rng(i, 4));
      const hair = pick(HAIR, rng(i, 5));
      const shirt = pick(SHIRT, rng(i, 6));
      const trouser = pick(TROUSER, rng(i, 7));
      const sleeve = rng(i, 8) < 0.5 ? shirt : skin; // short sleeves or long

      const legY = LEG_H / 2;
      const torsoY = LEG_H + TORSO_H / 2;
      const headY = LEG_H + TORSO_H + P.head[1] / 2;
      const ax = P.torso[0] / 2 + P.arm[0] / 2;
      const lx = P.leg[0] / 2;

      put(legL, i, -lx, legY, 0, trouser);
      put(legR, i, lx, legY, 0, trouser);
      put(torso, i, 0, torsoY, 0, shirt);
      put(armL, i, -ax, torsoY, 0, sleeve);
      put(armR, i, ax, torsoY, 0, sleeve);
      put(head, i, 0, headY, 0, skin);
      put(hairTop, i, 0, headY + P.head[1] / 2 + 0.03, 0, hair);
      put(hairBack, i, 0, headY + P.head[1] * 0.15, P.head[2] / 2 + 0.03, hair); // back is +Z
      put(eyeL, i, -0.1, headY + 0.03, -(P.head[2] / 2 + 0.005), 0x1a1a1a);
      put(eyeR, i, 0.1, headY + 0.03, -(P.head[2] / 2 + 0.005), 0x1a1a1a);
    });

    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.materials = [mat, eyeMat];
  }

  dispose() {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    for (const mt of this.materials) mt.dispose();
    this.meshes.length = 0;
  }
}
