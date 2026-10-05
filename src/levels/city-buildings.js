import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import blockUrl from "../../assets/buildings/apartment-block.glb?url";
import polyUrl from "../../assets/buildings/apartment-poly.glb?url";
import smallUrl from "../../assets/buildings/kenney-small.glb?url";
import largeUrl from "../../assets/buildings/kenney-large.glb?url";
import towerUrl from "../../assets/buildings/skyscraper.glb?url";
import landmarkUrl from "../../assets/buildings/skyscraper-poly.glb?url";
import wardUrl from "../../assets/buildings/ward-block.glb?url";
import clinicUrl from "../../assets/buildings/clinic-annexe.glb?url";
import emergencyUrl from "../../assets/buildings/emergency-block.glb?url";
import coreUrl from "../../assets/buildings/stair-core.glb?url";
import kayUrl from "../../assets/buildings/kay-building.glb?url";
import hUrl from "../../assets/buildings/building-h.fbx?url";

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
  kay: { url: kayUrl }, // a brick shopfront with an awning
  hfbx: { url: hUrl, fbx: true }, // two stepped apartment blocks with a water tank (FBX)
  // the skyscrapers stand only on the outskirts, as the skyline round the city
  tower: { url: towerUrl, trim: true, outskirt: true },
  landmark: { url: landmarkUrl, outskirt: true },
  // the hospital campus: placed together, never at random
  ward: { url: wardUrl, special: true },
  emergency: { url: emergencyUrl, special: true },
  clinic: { url: clinicUrl, special: true },
  core: { url: coreUrl, special: true }, // the stair and lift tower beside the ward block
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
    let palette = null; // the shopfront's colour map, which the FBX building shares
    await Promise.all(
      Object.entries(MODELS)
        .filter(([, def]) => !def.fbx)
        .map(async ([id, def]) => {
          try {
            const gltf = await loader.loadAsync(def.url);
            if (id === "kay") gltf.scene.traverse((o) => o.isMesh && o.material.map && (palette = o.material.map));
            out[id] = prepare(gltf.scene, def);
          } catch (err) {
            console.error(`[city-buildings] could not load "${id}"`, err);
          }
        })
    );
    draco.dispose();

    // The FBX does not carry its texture, but its UVs address the same
    // colour palette as the shopfront GLB (same artist, same pack). Borrow
    // that map; glTF has its V axis the other way up, so flip the UVs. Its
    // materials arrive flagged transparent, which hides them: clear that.
    for (const [id, def] of Object.entries(MODELS)) {
      if (!def.fbx) continue;
      try {
        const fbx = await new FBXLoader().loadAsync(def.url);
        fbx.traverse((o) => {
          if (!o.isMesh) return;
          const uv = o.geometry.attributes.uv;
          if (uv) for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
          for (const m of [].concat(o.material)) {
            m.transparent = false;
            m.opacity = 1;
            if (palette) m.map = palette;
          }
        });
        out[id] = prepare(fbx, def);
      } catch (err) {
        console.error(`[city-buildings] could not load "${id}"`, err);
      }
    }
    return (models = out);
  })();
  return loading;
}

const hash = (i, k = 0) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Scale at which a model, turned by `yaw`, just fits a w x d plot. */
function fitScale(m, yaw, w, d) {
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const bw = m.w * c + m.d * s;
  const bd = m.w * s + m.d * c;
  return Math.min((w * 0.96) / bw, (d * 0.96) / bd) * 1.05;
}

export class CityBuildings {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Box3[]} plots  where a building stands and how big it may be. A plot
   *   flagged `outskirt` holds a skyscraper; the rest hold ordinary buildings.
   * @param {object} track
   * @param {{x:number,z:number}} [centre]  the middle of the city, which the skyscrapers face
   */
  constructor(scene, plots, track, centre = { x: -90, z: 0 }) {
    this.scene = scene;
    this.meshes = [];
    /** one per building that got a model: where its door is and which way it faces */
    this.placed = [];
    if (!models || !Object.keys(models).length || !track) return;

    const ids = Object.keys(models);
    const fr = {};
    const probe = new THREE.Vector3();
    // Every building faces its nearest sidewalk: its front (+Z) is turned
    // toward the closest point of the road.
    const yawToRoad = (x, z) => {
      const pr = track.project(probe.set(x, 0, z));
      track.frameAt(pr.s, fr);
      const k = -Math.sign(pr.t || 1);
      return Math.atan2(fr.right.x * k, fr.right.z * k);
    };
    const info = plots.map((b, i) => ({
      i, b, outskirt: !!b.outskirt,
      cx: (b.min.x + b.max.x) / 2, cz: (b.min.z + b.max.z) / 2,
      w: b.max.x - b.min.x, d: b.max.z - b.min.z, h: b.max.y,
    }));
    const taken = new Set();
    const assign = []; // { id, s, cx, cz, yaw, index, noDoor? }

    // ---- the skyline: skyscrapers on the outskirts, facing in toward the city
    const sky = ["landmark", "tower"].filter((id) => models[id]);
    info.filter((q) => q.outskirt).forEach((q, n) => {
      taken.add(q.i);
      if (!sky.length) return;
      const id = sky[n % sky.length];
      const m = models[id];
      const height = 62 + hash(q.i, 7) * 50;
      assign.push({ id, s: height / m.h, cx: q.cx, cz: q.cz, yaw: Math.atan2(centre.x - q.cx, centre.z - q.cz), index: q.i });
    });

    // ---- two hospital campuses: the biggest free plots get a ward block, the
    // nearest plots an emergency entrance and a clinic annexe, and a stair-and-
    // lift tower stands against the ward's side.
    if (models.ward && models.emergency && models.clinic) {
      const free = () => info.filter((q) => !taken.has(q.i) && !q.outskirt && q.h < 55);
      const sites = [];
      for (const q of free().filter((q) => q.w >= 11 && q.d >= 9).sort((a, b) => b.w * b.d - a.w * a.d)) {
        if (sites.every((o) => Math.hypot(o.cx - q.cx, o.cz - q.cz) > 160)) sites.push(q);
        if (sites.length >= 2) break;
      }
      const put = (id, q, lo, hi) => {
        taken.add(q.i);
        const yaw = yawToRoad(q.cx, q.cz);
        const s = Math.max(lo, Math.min(hi, fitScale(models[id], yaw, q.w, q.d)));
        assign.push({ id, s, cx: q.cx, cz: q.cz, yaw, index: q.i });
        return assign[assign.length - 1];
      };
      for (const q of sites) {
        const ward = put("ward", q, 0.7, 1.35);
        if (models.core) {
          const sc = ward.s * 1.15;
          const sinY = Math.sin(ward.yaw), cosY = Math.cos(ward.yaw);
          const along = (models.ward.w * ward.s) / 2 + (models.core.w * sc) / 2 - 0.3; // to the ward's right
          const back = -((models.ward.d * ward.s) - (models.core.d * sc)) / 2; // backs level
          assign.push({
            id: "core", s: sc, yaw: ward.yaw, index: -1, noDoor: true,
            cx: ward.cx + cosY * along + sinY * back,
            cz: ward.cz - sinY * along + cosY * back,
          });
        }
        const near = free()
          .filter((o) => o.w >= 7 && o.d >= 5)
          .sort((a, b) => Math.hypot(a.cx - q.cx, a.cz - q.cz) - Math.hypot(b.cx - q.cx, b.cz - q.cz));
        if (near[0]) put("emergency", near[0], 0.6, 1.4);
        if (near[1]) put("clinic", near[1], 0.6, 1.5);
      }
    }

    // ---- everything else
    const pool = ids.filter((id) => !MODELS[id].special && !MODELS[id].outskirt);
    const used = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const q of info) {
      if (taken.has(q.i)) continue;
      const yaw = yawToRoad(q.cx, q.cz);
      const hWant = Math.min(44, Math.max(14, q.h * 0.8));
      const options = [];
      for (const id of pool) {
        const m = models[id];
        if (MODELS[id].max !== undefined && used[id] >= MODELS[id].max) continue;
        const s = Math.min(fitScale(m, yaw, q.w, q.d), hWant / m.h);
        if (m.h * s < 10.5) continue;
        options.push({ id, s });
      }
      if (!options.length) continue;
      const pick = options[Math.floor(hash(q.i, 1) * options.length)];
      used[pick.id]++;
      assign.push({ ...pick, cx: q.cx, cz: q.cz, yaw, index: q.i });
    }

    // ---- one InstancedMesh per model part
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    for (const id of ids) {
      const list = assign.filter((a) => a.id === id);
      if (!list.length) continue;
      for (const part of models[id].parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.frustumCulled = false;
        list.forEach((a, i) => {
          m4.compose(new THREE.Vector3(a.cx, 0, a.cz), quat.setFromAxisAngle(up, a.yaw), new THREE.Vector3(a.s, a.s, a.s));
          inst.setMatrixAt(i, m4);
          if (MODELS[id].tint === part.name) inst.setColorAt(i, tint.setHex(TINTS[Math.floor(hash(a.index, 5) * TINTS.length)]));
        });
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        scene.add(inst);
        this.meshes.push(inst);
      }
    }
    this.placed = assign.map((a) => {
      const m = models[a.id];
      return {
        index: a.index, id: a.id, noDoor: !!a.noDoor || !!MODELS[a.id].outskirt,
        x: a.cx, z: a.cz, yaw: a.yaw,
        halfW: (m.w * a.s) / 2, halfD: (m.d * a.s) / 2,
        // the door: the middle of the front face, and the unit vectors out of it and along it
        fwd: { x: Math.sin(a.yaw), z: Math.cos(a.yaw) },
        right: { x: Math.cos(a.yaw), z: -Math.sin(a.yaw) },
      };
    });
    for (const pl of this.placed) pl.door = { x: pl.x + pl.fwd.x * pl.halfD, z: pl.z + pl.fwd.z * pl.halfD };
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
