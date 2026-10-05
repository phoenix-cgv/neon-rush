import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import blockUrl from "../../assets/buildings/apartment-block.glb?url";
import polyUrl from "../../assets/buildings/apartment-poly.glb?url";
import smallUrl from "../../assets/buildings/kenney-small.glb?url";
import largeUrl from "../../assets/buildings/kenney-large.glb?url";
import towerUrl from "../../assets/buildings/skyscraper.glb?url";
import landmarkUrl from "../../assets/buildings/skyscraper-poly.glb?url";

// ---------------------------------------------------------------------
// The City Track's buildings: five modelled designs standing where the
// map's plain boxes stood.
//
//   block   a six-storey brick apartment block with balconies (Draco-
//           compressed, 35k triangles, so only a few are used)
//   poly    a tenement with a fire escape (one textured mesh)
//   small, large   two flat-roofed blocks with banded windows
//   tower   a stepped office tower; the diorama's base slab and street
//           light are trimmed off
//
// Every model is flattened to one geometry per material, recentred with
// its base on the ground and its front toward +Z, and drawn as instances,
// so the whole skyline is about twenty draw calls.
// ---------------------------------------------------------------------

const MODELS = {
  block: { url: blockUrl, draco: true, max: 9 },
  poly: { url: polyUrl },
  small: { url: smallUrl, tint: "_defaultMat" },
  large: { url: largeUrl, tint: "_defaultMat" },
  tower: { url: towerUrl, trim: true, tall: true },
  // a slim stepped skyscraper, placed separately on the few plots with room
  landmark: { url: landmarkUrl, landmark: true },
};

const TINTS = [0xffffff, 0xf0dcc0, 0xe6b8a2, 0xb9d3cf, 0xdbe0c8, 0xf3cfa4];

let loading = null;
let models = null; // id -> { parts: [{ name, geometry, material }], w, h, d }

function prepare(scene, def) {
  scene.updateMatrixWorld(true);
  const items = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    items.push({ name: o.name, mat: o.material, g });
  });

  let kept = items;
  if (def.trim) {
    // the tower is posed on a little street scene: keep only the tower
    const core = new THREE.Box3();
    for (const it of items) {
      if (/street_light|TextPlus/i.test(it.name) || it.g.boundingBox.max.y < 3) continue;
      core.union(it.g.boundingBox);
    }
    kept = items.filter((it) => {
      if (/street_light|TextPlus|Cylinder|StraightStair/i.test(it.name)) return false;
      const b = it.g.boundingBox;
      const out = Math.max(core.min.x - b.min.x, b.max.x - core.max.x, core.min.z - b.min.z, b.max.z - core.max.z);
      return out < 0.6 && b.max.y > 0.05;
    });
  }

  const box = new THREE.Box3();
  for (const it of kept) box.union(it.g.boundingBox);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const byMat = new Map();
  for (const it of kept) {
    let g = it.g;
    g.translate(-c.x, -box.min.y, -c.z);
    if (g.index && byMat.size >= 0) g = g.toNonIndexed();
    if (!byMat.has(it.mat)) byMat.set(it.mat, []);
    byMat.get(it.mat).push(g);
  }
  const parts = [];
  for (const [mat, geos] of byMat) {
    // attributes must agree to merge: keep what every piece has
    const keep = ["position", "normal", "uv", "color"].filter((a) => geos.every((g) => g.attributes[a]));
    for (const g of geos) for (const a of Object.keys(g.attributes)) if (!keep.includes(a)) g.deleteAttribute(a);
    const geometry = mergeGeometries(geos, false);
    const material = mat.clone();
    material.vertexColors = !!geometry.attributes.color;
    parts.push({ name: mat.name, geometry, material });
  }
  return { parts, w: size.x, h: size.y, d: size.z };
}

/** Load all five once. A model that fails to load is simply left out. */
export function loadBuildingModels() {
  loading ??= (async () => {
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    const loader = new GLTFLoader().setDRACOLoader(draco);
    const out = {};
    await Promise.all(
      Object.entries(MODELS).map(async ([id, def]) => {
        try {
          out[id] = prepare((await loader.loadAsync(def.url)).scene, def);
        } catch (err) {
          console.error(`[city-buildings] could not load "${id}"`, err);
        }
      })
    );
    draco.dispose();
    return (models = out);
  })();
  return loading;
}

const hash = (i, k = 0) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export class CityBuildings {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Box3[]} boxes  the map's plain boxes: where a building stands and how big it may be
   */
  constructor(scene, boxes, track = null) {
    this.scene = scene;
    this.meshes = [];
    /** one per box that got a model: where its front door is */
    this.placed = [];
    if (!models || !Object.keys(models).length) return;

    const ids = Object.keys(models);
    const assign = []; // { id, s, sy, x, z, index }

    // The landmark first: it needs far more room than a plot, so it goes
    // only where the plot is well clear of the road and of its neighbours,
    // scaled up until it nearly fills that room.
    const taken = new Set();
    const lm = models.landmark;
    if (lm && track) {
      const half1 = 0.5 * Math.hypot(lm.w, lm.d);
      const cands = [];
      boxes.forEach((b, i) => {
        if (b.max.y < 50) return;
        const cx = (b.min.x + b.max.x) / 2;
        const cz = (b.min.z + b.max.z) / 2;
        const clear = track.project(new THREE.Vector3(cx, 0, cz)).distance;
        let s = Math.min(3.0, (clear - 14.5) / half1);
        boxes.forEach((o, j) => {
          if (j === i) return;
          const dd = Math.hypot((o.min.x + o.max.x) / 2 - cx, (o.min.z + o.max.z) / 2 - cz);
          const oh = 0.5 * Math.hypot(o.max.x - o.min.x, o.max.z - o.min.z);
          if (dd < half1 * s + oh + 1.5) s = Math.min(s, Math.max(0, (dd - oh - 1.5) / half1));
        });
        if (lm.h * s >= 38) cands.push({ i, s, height: lm.h * s, cx, cz });
      });
      cands.sort((a, b) => b.height - a.height);
      const chosen = [];
      for (const c of cands) {
        // spread them out
        if (chosen.some((o) => Math.hypot(o.cx - c.cx, o.cz - c.cz) < 90)) continue;
        chosen.push(c);
        if (chosen.length >= 5) break;
      }
      for (const c of chosen) {
        taken.add(c.i);
        assign.push({ id: "landmark", s: c.s, sy: c.s, x: c.cx, z: c.cz + (lm.d * c.s) / 2, index: c.i });
      }
    }

    const ids2 = ids.filter((id) => !MODELS[id].landmark);
    const used = Object.fromEntries(ids.map((id) => [id, 0]));
    boxes.forEach((b, i) => {
      if (taken.has(i)) return;
      const w = b.max.x - b.min.x;
      const d = b.max.z - b.min.z;
      const origH = b.max.y;
      const hWant = Math.min(44, Math.max(14, origH * 0.8));
      const options = [];
      for (const id of ids2) {
        const m = models[id];
        if (MODELS[id].max !== undefined && used[id] >= MODELS[id].max) continue;
        const sFit = Math.min((w * 0.96) / m.w, (d * 0.96) / m.d) * 1.05;
        let s = Math.min(sFit, hWant / m.h);
        // Always scaled evenly: stretching a model only upward pulls its
        // windows apart into slats. A tower may overrun its plot a little,
        // since the plots it takes are well clear of the road.
        if (MODELS[id].tall) {
          if (origH < 55) continue; // towers go where towers were
          s = Math.min(sFit * 1.5, hWant / m.h);
        } else if (origH >= 55 && hash(i, 3) < 0.6) {
          continue; // most tall plots take a tower
        }
        const sy = s;
        const height = m.h * sy;
        if (height < 10.5) continue;
        options.push({ id, s, sy, height });
      }
      if (!options.length) return;
      const pick = options[Math.floor(hash(i, 1) * options.length)];
      used[pick.id]++;
      assign.push({ ...pick, x: (b.min.x + b.max.x) / 2, z: b.max.z, index: i });
    });

    // one InstancedMesh per model part
    const m4 = new THREE.Matrix4();
    const tint = new THREE.Color();
    for (const id of ids) {
      const list = assign.filter((a) => a.id === id);
      if (!list.length) continue;
      const model = models[id];
      for (const part of model.parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.frustumCulled = false;
        list.forEach((a, i) => {
          // front flush with the plot's front edge, centred across it
          m4.compose(
            new THREE.Vector3(a.x, 0, a.z - (model.d * a.s) / 2),
            new THREE.Quaternion(),
            new THREE.Vector3(a.s, a.sy, a.s)
          );
          inst.setMatrixAt(i, m4);
          if (MODELS[id].tint === part.name) inst.setColorAt(i, tint.setHex(TINTS[Math.floor(hash(a.index, 5) * TINTS.length)]));
        });
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        scene.add(inst);
        this.meshes.push(inst);
      }
    }
    this.placed = assign.map((a) => ({ index: a.index, x: a.x, z: a.z, halfW: (models[a.id].w * a.s) / 2 }));
    this.counts = Object.fromEntries(ids.map((id) => [id, assign.filter((a) => a.id === id).length]));
  }

  dispose() {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.dispose();
    }
    this.meshes.length = 0;
  }
}
