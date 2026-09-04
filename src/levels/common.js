import * as THREE from "three";

// ---------------------------------------------------------------------
// Shared level furniture.
//
// The circuit grew a gantry, checkpoint markers, three scatter passes and
// a ground disc before there was a second level to share them with. Two
// more levels would have meant three copies of the same 150 lines, and
// three places to fix the next time a pylon turns out to be sitting on
// the racing line.
//
// Everything here is INSTANCED and registered with track.objects, so it
// is disposed with the track. Scenery deliberately stays off the minimap
// layer: from 400 m up a tree is one dark pixel that hides the road.
// ---------------------------------------------------------------------

const _yAxis = new THREE.Vector3(0, 1, 0);

/**
 * Place `count` instances of one geometry, positioned by a callback.
 *
 * @param {object} track
 * @param {THREE.Scene} scene
 * @param {number} count
 * @param {THREE.BufferGeometry} geo
 * @param {THREE.Material} mat
 * @param {(i:number, pos:THREE.Vector3, q:THREE.Quaternion, sc:THREE.Vector3)=>void} place
 */
export function scatter(track, scene, count, geo, mat, place) {
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    q.identity();
    sc.set(1, 1, 1);
    place(i, pos, q, sc);
    m.compose(pos, q, sc);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = true;
  scene.add(inst);
  track.objects.push(inst);
  return inst;
}

/** Two posts either side of the line, as real colliders. */
export function startGantry(track, scene, RAPIER, { color = 0xd8dde0, emissive = 0x102025 } = {}) {
  const fr = track.frameAt(0, {});
  const geo = new THREE.BoxGeometry(0.6, 5, 0.6);
  const mat = new THREE.MeshStandardMaterial({ color, emissive, roughness: 0.6 });
  for (const sgn of [-1, 1]) {
    const p = fr.position.clone().addScaledVector(fr.right, sgn * (track.wallLimit + 1));
    p.y += 2.5;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(p);
    mesh.castShadow = true;
    track.registerCollider(0, 6, RAPIER.ColliderDesc.cuboid(0.3, 2.5, 0.3), {
      position: p,
      mesh,
    });
  }
}

/** A pair of posts at every checkpoint, so progress is legible while driving. */
export function checkpointMarkers(track, scene, { color = 0xe4a13c, emissive = 0x3a2200 } = {}) {
  const markers = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.35, 2.2, 0.35),
    new THREE.MeshStandardMaterial({ color, emissive, roughness: 0.5 }),
    track.checkpoints.length * 2
  );
  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3(1, 1, 1);
  const q = new THREE.Quaternion();
  track.checkpoints.forEach((cp, i) => {
    const f = track.frameAt(cp.s, {});
    [-1, 1].forEach((sgn, j) => {
      const p = f.position.clone().addScaledVector(f.right, sgn * track.wallLimit);
      p.addScaledVector(f.up, 1.1);
      m.compose(p, q, scl);
      markers.setMatrixAt(i * 2 + j, m);
    });
  });
  markers.instanceMatrix.needsUpdate = true;
  markers.castShadow = true;
  scene.add(markers);
  track.objects.push(markers);
  return markers;
}

/**
 * The standard depth cues: trees, marker pylons, grandstands, ground.
 *
 * A road ribbon in a void reads as flat however good the lighting is.
 * Objects of KNOWN height standing beside it, passing at speed, are what
 * make the scene read as three-dimensional — the pylons matter most,
 * because they pass closest.
 *
 * Palettes differ per level so the three do not feel like one track
 * re-lit; the geometry and counts are shared.
 */
export function dressTrack(
  track,
  scene,
  {
    trees = 170,
    treeColor = 0x33562f,
    treeGeo = null,
    pylons = 120,
    pylonColor = 0xd8d2c4,
    pylonEmissive = 0x14100a,
    stands = 10,
    standColor = 0x7d8a93,
    groundColor = 0x445a3c,
    groundRadius = 700,
    groundY = -3.5,
  } = {}
) {
  const fr = {};

  if (trees > 0) {
    scatter(
      track,
      scene,
      trees,
      treeGeo ?? new THREE.ConeGeometry(2.6, 9, 7),
      new THREE.MeshStandardMaterial({ color: treeColor, roughness: 1 }),
      (i, pos, q, sc) => {
        const s = (i / trees) * track.length + (i % 7) * 3;
        track.frameAt(s % track.length, fr);
        const side = i % 2 === 0 ? -1 : 1;
        const out = track.runoffHalfWidth + 6 + ((i * 37) % 40);
        pos.copy(fr.position).addScaledVector(fr.right, side * out);
        pos.y += 4;
        q.setFromAxisAngle(_yAxis, (i * 1.7) % Math.PI);
        const k = 0.7 + ((i * 13) % 10) / 14;
        sc.set(k, k, k);
      }
    );
  }

  if (pylons > 0) {
    scatter(
      track,
      scene,
      pylons,
      new THREE.CylinderGeometry(0.22, 0.3, 4.5, 6),
      new THREE.MeshStandardMaterial({
        color: pylonColor,
        emissive: pylonEmissive,
        roughness: 0.8,
      }),
      (i, pos, q, sc) => {
        const s = (i / pylons) * track.length;
        track.frameAt(s, fr);
        const side = i % 2 === 0 ? -1 : 1;
        pos
          .copy(fr.position)
          .addScaledVector(fr.right, side * (track.width * 0.5 + 3.2));
        pos.addScaledVector(fr.up, 2.2);
      }
    );
  }

  if (stands > 0) {
    scatter(
      track,
      scene,
      stands,
      new THREE.BoxGeometry(26, 8, 10),
      new THREE.MeshStandardMaterial({ color: standColor, roughness: 0.85 }),
      (i, pos, q, sc) => {
        const s = (i / stands) * track.length + 40;
        track.frameAt(s % track.length, fr);
        const side = i % 2 === 0 ? -1 : 1;
        pos
          .copy(fr.position)
          .addScaledVector(fr.right, side * (track.runoffHalfWidth + 16));
        pos.y += 4;
        q.setFromAxisAngle(_yAxis, Math.atan2(fr.tangent.x, fr.tangent.z));
      }
    );
  }

  // Ground far beyond the runoff, so the world does not end in a void.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(groundRadius, 48).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: groundColor, roughness: 1 })
  );
  ground.position.y = groundY;
  ground.receiveShadow = true;
  scene.add(ground);
  track.objects.push(ground);
  return ground;
}

/**
 * Control points from a periodic polar radius.
 *
 *   r(θ) = base + a·sin(2θ + φ₁) + b·sin(harmonic·θ + φ₂)
 *
 * Generated rather than typed out, because hand-placed points closed the
 * loop with a kink: the tightest corner on the whole track landed on the
 * start/finish line at 7.3 m radius, which no car can take. A periodic
 * function is smooth at the seam by construction.
 *
 * The second harmonic must be ODD and >= 5. A closed polar loop always
 * nets 360 degrees, and with a low harmonic it curves the SAME WAY all
 * the way round — one wall becomes the outside of every corner and
 * cornering load pins you against it.
 *
 * Corner radii are checked against the car's real limit: at mu = 1.4 the
 * cornering speed for radius r is sqrt(1.4 * 9.81 * r), so 40 m is about
 * 85 km/h and 80 m about 120 km/h.
 */
export function polarPoints({
  count = 30,
  base = 180,
  a = 35,
  b = 20,
  harmonic = 5,
  phase1 = 0.6,
  phase2 = -1.1,
  rise = 1.8,
  riseHarmonic = 3,
  risePhase = 0.4,
} = {}) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const th = (i / count) * Math.PI * 2;
    const r =
      base + a * Math.sin(2 * th + phase1) + b * Math.sin(harmonic * th + phase2);
    // Gentle elevation. The runoff ribbon is swept from the same spline,
    // so the ground follows the road up and over rather than a flat plane
    // poking through it.
    const y = rise * Math.sin(riseHarmonic * th + risePhase);
    pts.push(new THREE.Vector3(r * Math.cos(th), y, r * Math.sin(th)));
  }
  return pts;
}
