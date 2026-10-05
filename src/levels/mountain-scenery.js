import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import planeUrl from "../../assets/props/airplane-2.glb?url";
import towerAUrl from "../../assets/props/radio-tower-a.glb?url";
import towerBUrl from "../../assets/props/radio-tower-b.glb?url";

// ---------------------------------------------------------------------
// Mountain Track scenery from the provided models:
//
//   radio towers   on the highest ground clear of the road, two designs
//                  alternating, each with a red beacon that pulses
//   aeroplanes     circling the peak, at different heights and speeds
//
// Towers stand where a downward ray finds the terrain, so they sit on the
// slope rather than float. Nothing here is physical.
// ---------------------------------------------------------------------

const loader = new GLTFLoader();
let loading = null;
let models = null;

/** Merge a glTF's meshes into world-space geometry, re-based so (0,0,0) is the middle of the foot. */
function bake(gltf, { footY = null } = {}) {
  gltf.scene.updateMatrixWorld(true);
  const parts = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const material = o.material.clone();
    material.vertexColors = !!geometry.attributes.color;
    material.side = THREE.DoubleSide;
    parts.push({ geometry, material });
  });
  const box = new THREE.Box3();
  parts.forEach((p) => (p.geometry.computeBoundingBox(), box.union(p.geometry.boundingBox)));
  if (footY !== null) {
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    parts.forEach((p) => p.geometry.translate(-cx, -box.min.y + footY, -cz));
    return { parts, height: box.max.y - box.min.y };
  }
  return { parts, height: box.max.y - box.min.y };
}

export function loadMountainProps() {
  loading ??= Promise.all([loader.loadAsync(planeUrl), loader.loadAsync(towerAUrl), loader.loadAsync(towerBUrl)])
    .then(([plane, a, b]) => (models = { plane: bake(plane), towerA: bake(a, { footY: -0.3 }), towerB: bake(b, { footY: -0.3 }) }))
    .catch((err) => {
      console.error("[mountain-scenery] could not load the mountain models", err);
      return (models = null);
    });
  return loading;
}

export class MountainScenery {
  /**
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {THREE.Object3D[]} ground  terrain meshes, for finding the high points
   */
  constructor(scene, track, ground) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = "MountainScenery";
    scene.add(this.group);
    this.beacons = [];
    this.flyers = [];
    this.towerCount = 0;
    if (!models) return;

    // ---- find the high ground, clear of the road
    const box = new THREE.Box3();
    ground.forEach((m) => box.expandByObject(m));
    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const probe = new THREE.Vector3();
    const spots = [];
    for (let x = box.min.x + 10; x < box.max.x - 10; x += 20) {
      for (let z = box.min.z + 10; z < box.max.z - 10; z += 20) {
        rc.set(probe.set(x, box.max.y + 50, z), down);
        const hit = rc.intersectObjects(ground, false)[0];
        if (!hit) continue;
        const dist = track.project(probe.set(x, hit.point.y, z)).distance;
        if (dist > 28) spots.push({ x, y: hit.point.y, z, dist });
      }
    }
    spots.sort((a, b) => b.y - a.y);
    const chosen = [];
    for (const s of spots) {
      if (chosen.length >= 7) break;
      if (chosen.every((c) => Math.hypot(c.x - s.x, c.z - s.z) > 75)) chosen.push(s);
    }

    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, fog: false });
    const beaconGeo = new THREE.SphereGeometry(0.9, 10, 8);
    chosen.forEach((s, i) => {
      const def = i % 2 ? models.towerB : models.towerA;
      // tower A is 34 m; tower B is 4 m of model, scaled up to about the same
      const k = i % 2 ? 9 : 1.15;
      const g = new THREE.Group();
      for (const { geometry, material } of def.parts) {
        const m = new THREE.Mesh(geometry, material);
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
      }
      g.scale.setScalar(k);
      g.position.set(s.x, s.y, s.z);
      g.rotation.y = i * 1.7;
      this.group.add(g);
      const beacon = new THREE.Mesh(beaconGeo, beaconMat.clone());
      beacon.position.set(s.x, s.y + def.height * k + 0.6, s.z);
      this.group.add(beacon);
      this.beacons.push({ mesh: beacon, phase: i * 0.9 });
      this.towerCount++;
    });

    // ---- aeroplanes round the peak
    const cx = chosen[0]?.x ?? 0;
    const cz = chosen[0]?.z ?? 0;
    const top = chosen[0]?.y ?? 70;
    const orbits = [
      { rx: 150, rz: 120, alt: top + 70, period: 55, phase: 0, dir: 1, bank: 0.25 },
      { rx: 210, rz: 170, alt: top + 120, period: 80, phase: 2.1, dir: -1, bank: 0.2 },
      { rx: 110, rz: 90, alt: top + 38, period: 40, phase: 4.2, dir: 1, bank: 0.3 },
    ];
    for (const o of orbits) {
      const body = new THREE.Group();
      for (const { geometry, material } of models.plane.parts) {
        const mat = material.clone();
        mat.fog = false;
        const m = new THREE.Mesh(geometry, mat);
        m.castShadow = true;
        body.add(m);
      }
      body.scale.setScalar(6.5);
      body.rotation.y = Math.PI / 2; // the model flies nose-first along +x; flying forward is -z
      const root = new THREE.Group();
      root.add(body);
      this.group.add(root);
      this.flyers.push({ root, cx, cz, ...o });
    }
  }

  /** t in seconds. */
  update(t) {
    for (const b of this.beacons) b.mesh.visible = Math.sin(t * 2.4 + b.phase) > -0.2;
    for (const f of this.flyers) {
      const phi = f.phase + (f.dir * t * Math.PI * 2) / f.period;
      f.root.position.set(f.cx + Math.cos(phi) * f.rx, f.alt + Math.sin(phi * 3) * 3, f.cz + Math.sin(phi) * f.rz);
      const tx = -Math.sin(phi) * f.rx * f.dir;
      const tz = Math.cos(phi) * f.rz * f.dir;
      f.root.rotation.set(0, Math.atan2(-tx, -tz), f.bank * f.dir, "YXZ");
    }
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
