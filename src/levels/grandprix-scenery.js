import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { bake } from "./mountain-scenery.js";
import { neonRails } from "./neon-rails.js";
import cactusUrl from "../../assets/props/cactus.glb?url";
import tentUrl from "../../assets/props/tent.glb?url";
import appleUrl from "../../assets/props/apple-tree.glb?url";

// ---------------------------------------------------------------------
// Grand Prix scenery from the provided models, set on the open grass
// round the circuit (never on the road, the stands, the garages or under an
// existing tree — a spot counts only if a ray from above hits bare ground):
//
//   tents      spectator camps, three or four tents to a cluster
//   cacti      dry patches out on the far grass
//   apple trees  orchard groves, in loose rows
//   neon rails an orange line along each guardrail through the tunnel
// ---------------------------------------------------------------------

let loading = null;
let models = null;

export function loadGrandPrixProps() {
  loading ??= (() => {
    const draco = new DRACOLoader();
    draco.setDecoderPath(import.meta.env.BASE_URL + "draco/");
    const loader = new GLTFLoader().setDRACOLoader(draco);
    return Promise.all([cactusUrl, tentUrl, appleUrl].map((u) => loader.loadAsync(u)))
      .then(([cactus, tent, apple]) => (models = {
        cactus: bake(cactus, { footY: 0, height: 4.5 }),
        tent: bake(tent, { footY: 0, height: 3.4 }),
        apple: bake(apple, { footY: 0, height: 6.5 }),
      }))
      .catch((err) => {
        console.error("[grandprix-scenery] could not load the models", err);
        return (models = null);
      });
  })();
  return loading;
}

const rngOf = (seed) => { let t = seed >>> 0; return () => ((t = (Math.imul(t ^ (t >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296); };

export class GrandPrixScenery {
  /**
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {THREE.Object3D[]} obstacles  every map mesh, to find bare ground
   * @param {{tunnel?: [number, number]}} opts
   */
  constructor(scene, track, obstacles, { tunnel = null } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = "GrandPrixScenery";
    scene.add(this.group);
    this.counts = { tents: 0, cacti: 0, apples: 0 };
    const t0 = performance.now();

    if (tunnel) this.group.add(neonRails(track, tunnel[0], tunnel[1], { offset: 9.0, y0: 0.3, y1: 0.7 }));
    if (!models) return;

    const rand = rngOf(777);
    const up = new THREE.Vector3(0, 1, 0);
    const probe = new THREE.Vector3();
    // bounds of the circuit, to scatter within
    const fr = {};
    const box = new THREE.Box3();
    for (let s = 0; s < track.length; s += 20) { track.frameAt(s, fr); box.expandByPoint(fr.position); }
    box.expandByScalar(220);

    // A ground map: every triangle of the map binned into 6 m cells, once.
    // A cell is bare when it holds grass and nothing else (no road, stand,
    // garage, tree or water), and level when its grass spans under 0.9 m.
    const CELL = 6;
    const gw = Math.ceil((box.max.x - box.min.x) / CELL), gh = Math.ceil((box.max.z - box.min.z) / CELL);
    const gMin = new Float32Array(gw * gh).fill(1e9), gMax = new Float32Array(gw * gh).fill(-1e9);
    const gSum = new Float32Array(gw * gh), gN = new Uint16Array(gw * gh);
    const occ = new Uint8Array(gw * gh);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (const mesh of obstacles) {
      if (!mesh.isMesh) continue;
      const ground = /^GrandPrix:(Grass|GrassDark|GrassVerge)$/.test(mesh.name);
      if (/GrassBlade|StartLamp/.test(mesh.name)) continue;
      mesh.updateMatrixWorld(true);
      const pos = mesh.geometry.attributes.position, index = mesh.geometry.index;
      const tris = index ? index.count / 3 : pos.count / 3;
      for (let t = 0; t < tris; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3, i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1, i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
        // mark every cell the triangle's bounds touch (grass included, for the occupied test only when not ground)
        const x0 = Math.floor((Math.min(a.x, b.x, c.x) - box.min.x) / CELL), x1 = Math.floor((Math.max(a.x, b.x, c.x) - box.min.x) / CELL);
        const z0 = Math.floor((Math.min(a.z, b.z, c.z) - box.min.z) / CELL), z1 = Math.floor((Math.max(a.z, b.z, c.z) - box.min.z) / CELL);
        if (x1 < 0 || z1 < 0 || x0 >= gw || z0 >= gh) continue;
        if (!ground && (x1 - x0 > 40 || z1 - z0 > 40)) continue; // a huge sheet (water, sky): ignore
        const y = (a.y + b.y + c.y) / 3;
        for (let gz = Math.max(0, z0); gz <= Math.min(gh - 1, z1); gz++) {
          for (let gx = Math.max(0, x0); gx <= Math.min(gw - 1, x1); gx++) {
            const k = gz * gw + gx;
            if (ground) {
              if (y < gMin[k]) gMin[k] = y;
              if (y > gMax[k]) gMax[k] = y;
              gSum[k] += y; gN[k]++;
            } else occ[k] = 1;
          }
        }
      }
    }
    const cellAt = (x, z) => {
      const gx = Math.floor((x - box.min.x) / CELL), gz = Math.floor((z - box.min.z) / CELL);
      return gx < 0 || gz < 0 || gx >= gw || gz >= gh ? -1 : gz * gw + gx;
    };
    // the ground height at (x, z) if the ground there is bare and level, else null
    const bare = (x, z, r = 3.5) => {
      let lo = 1e9, hi = -1e9, y0 = null;
      for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
        const k = cellAt(x + dx, z + dz);
        if (k < 0 || occ[k] || !gN[k]) return null;
        lo = Math.min(lo, gMin[k]); hi = Math.max(hi, gMax[k]);
        if (y0 === null) y0 = gSum[k] / gN[k];
      }
      return hi - lo > 1.1 ? null : y0;
    };

    const tried = [];
    const sitePoint = (near, far, sep) => {
      for (let n = 0; n < 900; n++) {
        const x = box.min.x + rand() * (box.max.x - box.min.x);
        const z = box.min.z + rand() * (box.max.z - box.min.z);
        const dist = track.project(probe.set(x, 0, z)).distance;
        if (dist < near || dist > far) continue;
        if (tried.some((q) => Math.hypot(q.x - x, q.z - z) < sep)) continue;
        const y = bare(x, z, 4);
        if (y === null) continue;
        return { x, y, z };
      }
      return null;
    };
    const compose = (x, y, z, yaw, sc, sink = 0.12) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y - sink, z),
        new THREE.Quaternion().setFromAxisAngle(up, yaw),
        new THREE.Vector3(sc, sc * (0.92 + rand() * 0.2), sc)
      );
    const instance = (parts, mats) => {
      if (!mats.length) return;
      for (const { geometry, material } of parts) {
        const inst = new THREE.InstancedMesh(geometry, material, mats.length);
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.frustumCulled = false;
        mats.forEach((m4, i) => inst.setMatrixAt(i, m4));
        inst.instanceMatrix.needsUpdate = true;
        this.group.add(inst);
      }
    };
    // a cluster: pick a centre, then place members round it that pass the bare-ground test
    const cluster = (centre, count, radius, place) => {
      let made = 0;
      for (let k = 0; k < count * 8 && made < count; k++) {
        const a = rand() * 6.283, r = 3 + rand() * radius;
        const x = centre.x + Math.cos(a) * r, z = centre.z + Math.sin(a) * r;
        const y = bare(x, z, 2.2);
        if (y === null) continue;
        place(x, y, z);
        made++;
      }
    };

    // spectator camps: close to the circuit, tents facing a common middle
    const tents = [];
    for (let c = 0; c < 5; c++) {
      const centre = sitePoint(28, 120, 70);
      if (!centre) continue;
      tried.push(centre);
      cluster(centre, 4, 9, (x, y, z) => {
        tents.push(compose(x, y, z, Math.atan2(centre.x - x, centre.z - z) + (rand() - 0.5) * 0.5, 0.95 + rand() * 0.3));
      });
    }
    instance(models.tent.parts, tents);
    this.counts.tents = tents.length;

    // dry patches of cactus out on the far grass
    const cacti = [];
    for (let c = 0; c < 5; c++) {
      const centre = sitePoint(60, 240, 90);
      if (!centre) continue;
      tried.push(centre);
      cluster(centre, 7, 16, (x, y, z) => cacti.push(compose(x, y, z, rand() * 6.28, 0.7 + rand() * 0.9)));
    }
    instance(models.cactus.parts, cacti);
    this.counts.cacti = cacti.length;

    // orchards: loose rows of apple trees
    const apples = [];
    for (let c = 0; c < 5; c++) {
      const centre = sitePoint(35, 200, 80);
      if (!centre) continue;
      tried.push(centre);
      const dir = rand() * 3.14;
      for (let row = -1; row <= 1; row++) {
        for (let col = -3; col <= 3; col++) {
          const x = centre.x + Math.cos(dir) * col * 8 - Math.sin(dir) * row * 8 + (rand() - 0.5) * 2;
          const z = centre.z + Math.sin(dir) * col * 8 + Math.cos(dir) * row * 8 + (rand() - 0.5) * 2;
          const dist = track.project(probe.set(x, 0, z)).distance;
          if (dist < 22) continue;
          const y = bare(x, z, 2.5);
          if (y === null) continue;
          apples.push(compose(x, y, z, rand() * 6.28, 0.85 + rand() * 0.4));
        }
      }
    }
    instance(models.apple.parts, apples);
    this.counts.apples = apples.length;
    this.buildMs = performance.now() - t0;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
