import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CityBuildings } from "./city-buildings.js";
import { CityAmenities } from "./city-amenities.js";
import gardenUrl from "../../assets/props/garden.glb?url";
import benchUrl from "../../assets/props/bench.glb?url";
import fountainUrl from "../../assets/props/fountain.glb?url";
import ferrisUrl from "../../assets/props/ferris-wheel.glb?url";
import craneUrl from "../../assets/props/crane.glb?url";
import jetUrl from "../../assets/props/airplane.glb?url";
import cessnaUrl from "../../assets/props/small-airplane.glb?url";
import treeUrl from "../../assets/props/ornamental-tree.glb?url";
import planterUrl from "../../assets/props/planter-box.glb?url";
import wheatUrl from "../../assets/props/wheat-plant.glb?url";
import lampUrl from "../../assets/props/lamp-post.glb?url";
import fenceUrl from "../../assets/props/chain-link-fence.glb?url";
import binUrl from "../../assets/props/wheelie-bin.glb?url";
import paperUrl from "../../assets/props/wastepaper-bin.glb?url";
import shrubUrl from "../../assets/props/evergreen-shrub.glb?url";
import stallUrl from "../../assets/props/market-stall.glb?url";

// ---------------------------------------------------------------------
// City Track vegetation: trees and grass built from generated textures and
// small vertex shaders, replacing the map's flat-coloured cone trees and
// cone "tufts".
//
//   Textures   drawn on canvases at load (no image files): a leaf-cluster
//              sprite, bark, pine needles, a palm frond, a grass-blade
//              tuft and a tiling lawn.
//   Trees      broadleaf (a canopy of ~50 alpha-cut leaf cards with outward
//              normals so the crown shades like a soft ball), pine (needle-
//              textured tiers) and leaning palms (bent, drooping fronds).
//              One InstancedMesh per variant and part, so the whole forest
//              is a few dozen draw calls.
//   Grass      ~4,000 crossed-card tufts on the green islands and along the
//              pavement edge, plus a world-space lawn texture on the
//              islands themselves.
//   Shaders    onBeforeCompile hooks add wind: trees sway from the trunk
//              up, leaves flutter, grass bends from its roots. Everything
//              reads one shared clock, advanced by update().
//
// Placement comes from the map: one tree at each of its "TreePit" paving
// squares, grass on its "GreenIsland" slabs.
// ---------------------------------------------------------------------

const uniforms = { uTime: { value: 0 }, uSway: { value: 1 } };

// Small deterministic RNG, so the forest is the same every visit.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- textures
function canvasTex(w, h, draw, { repeat = false, srgb = true } = {}) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  return t;
}

function pathTexture() {
  const r = rng(91);
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = "#b9b2a2";
    g.fillRect(0, 0, w, h);
    // running-bond pavers
    const bw = 32, bh = 16;
    for (let row = 0; row * bh < h; row++) {
      for (let col = -1; col * bw < w; col++) {
        const x = col * bw + (row % 2 ? bw / 2 : 0);
        const tone = 150 + Math.floor(r() * 50);
        g.fillStyle = `rgb(${tone},${tone - 6},${tone - 18})`;
        g.fillRect(x + 1, row * bh + 1, bw - 2, bh - 2);
      }
    }
  }, { repeat: true });
}

function lawnTexture() {
  const r = rng(67);
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = "#6f9a52";
    g.fillRect(0, 0, w, h);
    // mottling, wrapped so it tiles
    for (let i = 0; i < 260; i++) {
      const x = r() * w;
      const y = r() * h;
      const rad = 6 + r() * 22;
      const light = r() < 0.5;
      for (const [dx, dy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) {
        const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
        grad.addColorStop(0, light ? "rgba(170,210,110,.28)" : "rgba(30,80,40,.3)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = grad;
        g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
      }
    }
    for (let i = 0; i < 1800; i++) {
      const x = r() * w;
      const y = r() * h;
      g.strokeStyle = r() < 0.5 ? "rgba(36,90,40,.55)" : "rgba(180,220,120,.5)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 3, y - 2 - r() * 5);
      g.stroke();
    }
  }, { repeat: true });
}

// ----------------------------------------------------------------- shaders
/** Wind, injected into a standard material. mode: "tree" | "leaf" | "grass". */
function windify(material, mode) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uSway = uniforms.uSway;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uSway;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3].x, 0.0, instanceMatrix[3].z);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float ph = ip.x * 0.31 + ip.z * 0.17;
        ${
          mode === "crop"
            ? `float bend = max(position.y, 0.0);
               bend *= bend;
               transformed.x += sin(uTime * 1.9 + ph + position.x * 3.0) * 0.17 * bend * uSway;
               transformed.z += cos(uTime * 1.6 + ph * 1.3) * 0.12 * bend * uSway;`
            : `float hgt = max(position.y, 0.0);
               float sway = uSway * hgt * 0.016;
               transformed.x += sin(uTime * 1.2 + ph + position.y * 0.6) * sway;
               transformed.z += cos(uTime * 0.9 + ph * 1.4 + position.x * 0.5) * sway * 0.8;
               ${
                 mode === "leaf"
                   ? "transformed += normal * sin(uTime * 4.5 + position.x * 7.0 + position.z * 5.0 + ph) * 0.035 * uSway;"
                   : ""
               }`
        }`
      );
  };
  material.customProgramCacheKey = () => `wind-${mode}`;
  return material;
}

/** World-space lawn texture on an existing flat-colour material. */
function lawnify(material, tex) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLawn = { value: tex };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nuniform sampler2D uLawn;")
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        vec3 lawn = texture2D(uLawn, vWPos.xz * 0.22).rgb * 0.7
                  + texture2D(uLawn, vWPos.xz * 0.037).rgb * 0.5;
        diffuseColor.rgb *= lawn * 1.25;`
      );
  };
  material.customProgramCacheKey = () => "lawn";
  material.needsUpdate = true;
}

// ---------------------------------------------------------------- geometry
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

// ------------------------------------------------------------ props (GLBs)
const loader = new GLTFLoader();
let propsLoading = null;
let props = null;

/** Bake a prop's meshes into world-space geometry with its own (vertex-coloured) material. */
function bake(gltf) {
  gltf.scene.updateMatrixWorld(true);
  const out = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const material = o.material.clone();
    material.vertexColors = !!geometry.attributes.color;
    material.side = THREE.DoubleSide;
    out.push({ geometry, material, name: `${o.name}|${o.parent?.name ?? ""}` });
  });
  return out;
}

/** Fetch the GL props once (tree, planter box, wheat, lamp post, fence, bins, shrub). */
export function loadCityProps() {
  propsLoading ??= Promise.all(
    [["tree", treeUrl], ["planter", planterUrl], ["wheat", wheatUrl], ["lamp", lampUrl], ["fence", fenceUrl], ["bin", binUrl], ["paper", paperUrl], ["shrub", shrubUrl], ["stall", stallUrl], ["garden", gardenUrl], ["bench", benchUrl], ["fountain", fountainUrl], ["ferris", ferrisUrl], ["crane", craneUrl], ["jet", jetUrl], ["cessna", cessnaUrl]].map(
      async ([name, url]) => [name, bake(await loader.loadAsync(url))]
    )
  )
    .then((entries) => (props = Object.fromEntries(entries)))
    .catch((err) => {
      console.error("[city-nature] could not load the city props; the street is left bare", err);
      return (props = null);
    });
  return propsLoading;
}

// ------------------------------------------------------------------ helpers
const distToSegment = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
};

/** Does the segment (a -> b) cross the box (x/z extents), grown by `pad`? */
function segmentHitsBox(ax, az, bx, bz, box, pad) {
  const x0 = box.min.x - pad, x1 = box.max.x + pad, z0 = box.min.z - pad, z1 = box.max.z + pad;
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dz, az - z0], [dz, z1 - az]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/**
 * More plots between the map's own: houses and low blocks wherever there is
 * room beside the circuit. Same clearances the map used (the nearest corner
 * well outside the road, pavement and lamp line), with a gap to every other
 * building and to every tree.
 * @returns {THREE.Box3[]}
 */
function infillPlots(track, buildings, pits, want) {
  const r = rng(2024);
  const out = [];
  const sizes = [[9, 9], [10, 12], [12, 10], [13, 13], [9, 14], [11, 11]];
  const probe = new THREE.Vector3();
  for (let n = 0; n < 9000 && out.length < want; n++) {
    const x = -380 + r() * 560;
    const z = -220 + r() * 440;
    const [w, d] = sizes[Math.floor(r() * sizes.length)];
    const h = 11 + r() * 15;
    const half = Math.hypot(w, d) / 2;
    const dist = track.project(probe.set(x, 0, z)).distance;
    if (dist < half + 12.5 || dist > 170) continue;
    let ok = true;
    for (const o of [...buildings, ...out]) {
      const oh = 0.5 * Math.hypot(o.max.x - o.min.x, o.max.z - o.min.z);
      if (Math.hypot(x - (o.min.x + o.max.x) / 2, z - (o.min.z + o.max.z) / 2) < half + oh + 2.2) { ok = false; break; }
    }
    if (!ok || pits.some((p) => Math.hypot(x - p.x, z - p.z) < half + 3.2)) continue;
    out.push(new THREE.Box3(new THREE.Vector3(x - w / 2, 0, z - d / 2), new THREE.Vector3(x + w / 2, h, z + d / 2)));
  }
  return out;
}

// -------------------------------------------------------------------- main
export class CityNature {
  /**
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {object} gltf  the loaded map: its TreePit nodes place the trees, its big cubes are the buildings
   * @param {THREE.Group} mapGroup  the built map, whose ground gets the lawn
   */
  constructor(scene, track, gltf, mapGroup) {
    this.scene = scene;
    this.objects = [];
    this.disposables = [];
    const own = (o) => (this.disposables.push(o), o);

    // ---- what is on the map
    const pits = [];
    const mapBins = []; // where the map put its (plain) bins, to be swapped for the real ones
    const benches = [];
    const buildings = [];
    const box = new THREE.Box3();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (/^TreePit/.test(o.name)) {
        box.setFromObject(o);
        pits.push(new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2));
      } else if (/^TrashBin/.test(o.name)) {
        box.setFromObject(o);
        mapBins.push(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
      } else if (/^BenchSeat/.test(o.name)) {
        box.setFromObject(o);
        benches.push(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
      } else if (/^Cube/.test(o.name)) {
        // a building: a tall block that stands on the ground (not a roof unit, awning or balcony)
        box.setFromObject(o);
        const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
        if (box.max.y > 6 && w > 6 && d > 6 && box.min.y < 0.5) buildings.push(box.clone());
      }
    });

    // ---- textures
    const lawn = own(lawnTexture());
    const pave = own(pathTexture());

    // ---- the ground is lawn: the map's flat graphite plane, textured green
    mapGroup.traverse((o) => {
      if (o.isMesh && /^City blocks/.test(o.material?.name ?? "")) {
        o.material.color.setRGB(0.62, 0.82, 0.55);
        lawnify(o.material, lawn);
      }
    });

    // ---- the buildings: modelled designs on the map's plots
    // denser: infill plots between the map's own
    // Set pieces first (they need open ground), then the infill works round them.
    const centre = { x: -90, z: 0 };
    const blockers = []; // square footprints of the set pieces
    const sites = { centre, fly: { x: 0, z: 0 }, gardens: [], fountains: [] };
    const facing = (x, z) => {
      const pr = track.project(new THREE.Vector3(x, 0, z));
      track.frameAt(pr.s, fr0);
      return Math.atan2(-(fr0.position.z - z), fr0.position.x - x);
    };
    const fr0 = {};
    const siteR = rng(515);
    // The set pieces cluster around the starting line, where the player sees
    // them: of the open spots found, the one nearest the start is taken.
    const startFr = {};
    track.frameAt(0, startFr);
    const startAt = startFr.position;
    const findSite = (radius, near, far) => {
      const probe = new THREE.Vector3();
      let best = null, bestD = Infinity, found = 0;
      for (let n = 0; n < 20000 && found < 40; n++) {
        const x = -380 + siteR() * 560;
        const z = -220 + siteR() * 440;
        const dist = track.project(probe.set(x, 0, z)).distance;
        if (dist < near || dist > far) continue;
        const clearB = buildings.every((o) => {
          const cx = Math.max(o.min.x, Math.min(x, o.max.x)), cz = Math.max(o.min.z, Math.min(z, o.max.z));
          return Math.hypot(x - cx, z - cz) > radius + 1.5;
        });
        if (!clearB || blockers.some((o) => Math.hypot(x - (o.min.x + o.max.x) / 2, z - (o.min.z + o.max.z) / 2) < radius + (o.max.x - o.min.x) / 2 + 3)) continue;
        if (pits.some((q) => Math.hypot(x - q.x, z - q.z) < radius * 0.7)) continue;
        found++;
        const d = Math.hypot(x - startAt.x, z - startAt.z);
        if (d < bestD) { bestD = d; best = { x, z }; }
      }
      if (!best) return null;
      blockers.push(new THREE.Box3(new THREE.Vector3(best.x - radius, 0, best.z - radius), new THREE.Vector3(best.x + radius, 5, best.z + radius)));
      return best;
    };
    if (props?.ferris) {
      const q = findSite(25, 36, 200);
      if (q) sites.ferris = { ...q, yaw: facing(q.x, q.z) };
      else console.warn("[city-nature] no open ground for the ferris wheel");
    }
    if (props?.crane) {
      const q = findSite(15, 26, 110);
      if (q) sites.crane = { ...q, yaw: facing(q.x, q.z) + Math.PI / 2 };
    }
    if (props?.garden) for (let i = 0; i < 2; i++) { const q = findSite(14, 24, 100); if (q) sites.gardens.push({ ...q, yaw: facing(q.x, q.z) }); }
    if (props?.fountain) for (let i = 0; i < 2; i++) { const q = findSite(7.5, 15, 80); if (q) sites.fountains.push(q); }

    sites.fly = { x: startAt.x, z: startAt.z };
    const infill = infillPlots(track, [...buildings, ...blockers], pits, 110);
    buildings.push(...infill);
    this.infillCount = infill.length;

    // The skyline: skyscraper plots in a ring round the outskirts of the city.
    const ring = [];
    {
      const rr = rng(77);
      const probe = new THREE.Vector3();
      for (let n = 0; n < 400 && ring.length < 40; n++) {
        const ang = (ring.length / 40) * Math.PI * 2 + (rr() - 0.5) * 0.12;
        const rad = 300 + rr() * 50;
        const x = centre.x + Math.cos(ang) * rad * 1.15;
        const z = centre.z + Math.sin(ang) * rad;
        if (track.project(probe.set(x, 0, z)).distance < 70) continue;
        if (ring.some((o) => Math.hypot(x - (o.min.x + o.max.x) / 2, z - (o.min.z + o.max.z) / 2) < 22)) continue;
        const b = new THREE.Box3(new THREE.Vector3(x - 7, 0, z - 7), new THREE.Vector3(x + 7, 60, z + 7));
        b.outskirt = true;
        ring.push(b);
      }
    }
    this.buildings = new CityBuildings(scene, [...buildings, ...ring], track, centre);
    const doorOf = new Map(this.buildings.placed.map((p) => [p.index, p]));

    // ---- paths from the pavement to every building's door
    // A short forecourt straight out from the door (the way the building
    // faces), then a straight run to the pavement's outer edge. A building
    // whose run would cut across another is left without a path.
    const paths = [];
    const fr = {};
    buildings.forEach((b, bi) => {
      const door = doorOf.get(bi);
      if (!door || door.noDoor) return; // no building stands here any more
      const e = { x: door.door.x, z: door.door.z };
      const f = { x: e.x + door.fwd.x * 2.6, z: e.z + door.fwd.z * 2.6 };
      const pr = track.project(new THREE.Vector3(f.x, 0, f.z));
      track.frameAt(pr.s, fr);
      const side = Math.sign(pr.t || 1);
      const t = {
        x: fr.position.x + fr.right.x * side * 11.9,
        z: fr.position.z + fr.right.z * side * 11.9,
        tx: fr.tangent.x,
        tz: fr.tangent.z,
      };
      if (Math.hypot(t.x - f.x, t.z - f.z) > 46) return;
      if ((t.x - f.x) * door.fwd.x + (t.z - f.z) * door.fwd.z < 0) return; // would run back through its own building
      let clear = true;
      for (const o of [...buildings, ...blockers]) {
        if (o === b) continue;
        if (segmentHitsBox(f.x, f.z, t.x, t.z, o, 1.0) || segmentHitsBox(e.x, e.z, f.x, f.z, o, 0.4)) {
          clear = false;
          break;
        }
      }
      if (clear) paths.push({ e, f, t, door });
    });
    this.pathCount = paths.length;

    if (paths.length) {
      const W = 0.85; // half width
      const pos = [], uv = [], idx = [];
      const addStrip = (pts, y0, y1) => {
        // pts: [{x,z}], height eased from y0 to y1 along the whole strip
        let len = 0;
        const L = pts.reduce((a, p, i) => a + (i ? Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) : 0), 0);
        let base = pos.length / 3;
        pts.forEach((p, i) => {
          if (i) len += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
          const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
          let dx = c.x - a.x, dz = c.z - a.z;
          const m = Math.hypot(dx, dz) || 1;
          dx /= m; dz /= m;
          const nx = -dz, nz = dx;
          const y = y0 + (y1 - y0) * (len / L);
          pos.push(p.x + nx * W, y, p.z + nz * W, p.x - nx * W, y, p.z - nz * W);
          uv.push(0, len / 1.7, 1, len / 1.7);
          if (i) {
            const k = base + (i - 1) * 2;
            idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
          }
        });
      };
      for (const pth of paths) addStrip([pth.e, pth.f, pth.t], -0.045, 0.128);
      const g = own(new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, own(new THREE.MeshStandardMaterial({
        map: pave, roughness: 0.9, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      })));
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.objects.push(mesh);
    }

    // ---- trees stand at the map's paving squares, but never inside a building or on a path
    const clearOfBuildings = (p, pad) =>
      ![...buildings, ...blockers].some((b) => p.x > b.min.x - pad && p.x < b.max.x + pad && p.z > b.min.z - pad && p.z < b.max.z + pad);
    const clearOfPaths = (p, pad) =>
      !paths.some((q) => distToSegment(p.x, p.z, q.e.x, q.e.z, q.f.x, q.f.z) < pad || distToSegment(p.x, p.z, q.f.x, q.f.z, q.t.x, q.t.z) < pad);
    const spots = pits.filter((p) => clearOfBuildings(p, 3.4) && clearOfPaths(p, 2.4));
    this.treeCount = spots.length;

    // Every tree is the provided low-poly tree (the textured broadleaf and
    // pine trees are gone). If it failed to load there are simply no trees.
    const buckets = [spots];
    const kinds = [];
    if (props?.tree) {
      kinds.push({
        parts: props.tree.map(({ geometry, material }) => [geometry, own(windify(material, "tree"))]),
      });
    } else {
      buckets.length = 0;
    }

    const placeR = rng(888);
    const tint = new THREE.Color();
    const warm = [0xe6b84a, 0xe58a3a, 0xd05a3a]; // a few late-season trees
    buckets.forEach((list, vi) => {
      if (!list.length) return;
      for (const [geo, mat] of kinds[vi].parts) {
        const inst = own(new THREE.InstancedMesh(geo, mat, list.length));
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.frustumCulled = false;
        list.forEach((p, i) => {
          const sc = 1.15 + placeR() * 0.6;
          _q.setFromAxisAngle(_v.set(0, 1, 0), placeR() * Math.PI * 2);
          _m.compose(p, _q, _s.set(sc, sc * (0.9 + placeR() * 0.25), sc));
          inst.setMatrixAt(i, _m);
          const accent = placeR() < 0.16;
          tint.setHex(accent ? warm[Math.floor(placeR() * warm.length)] : 0xffffff);
          if (!accent) tint.offsetHSL((placeR() - 0.5) * 0.04, 0, -placeR() * 0.12);
          inst.setColorAt(i, tint);
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.instanceColor.needsUpdate = true;
        scene.add(inst);
        this.objects.push(inst);
      }
    });

    // ---- street dressing from the provided props
    if (props) {
      const addInstances = (parts, mats4, { wind = null, shadow = true } = {}) => {
        if (!mats4.length) return;
        for (const { geometry, material } of parts) {
          const mat = wind ? own(windify(material.clone(), wind)) : own(material.clone());
          const inst = own(new THREE.InstancedMesh(geometry, mat, mats4.length));
          inst.castShadow = shadow;
          inst.receiveShadow = true;
          inst.frustumCulled = false;
          mats4.forEach((m4, i) => inst.setMatrixAt(i, m4));
          inst.instanceMatrix.needsUpdate = true;
          scene.add(inst);
          this.objects.push(inst);
        }
      };
      const place = (x, y, z, yaw = 0, sc = 1) =>
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, y, z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
          new THREE.Vector3(sc, sc, sc)
        );

      // Planter boxes either side of each door, with wheat growing in them.
      const planters = [], wheat = [], lamps = [];
      const wr = rng(4242);
      const GROUND = -0.05;
      paths.forEach((pth, i) => {
        const d = pth.door;
        for (const side of [-1, 1]) {
          const px = pth.e.x + d.right.x * side * 1.7 + d.fwd.x * 0.8;
          const pz = pth.e.z + d.right.z * side * 1.7 + d.fwd.z * 0.8;
          planters.push(place(px, GROUND, pz, d.yaw));
          for (let k = 0; k < 6; k++) {
            wheat.push(place(px + (wr() - 0.5) * 0.7, GROUND + 0.74, pz + (wr() - 0.5) * 0.7, wr() * 6.28, 0.85 + wr() * 0.5));
          }
        }
        // a lamp post where the path meets the pavement, on every other path
        if (i % 2 === 0) lamps.push(place(pth.t.x + pth.tx * 1.7, 0.12, pth.t.z + pth.tz * 1.7, 0));
      });
      addInstances(props.planter, planters);
      addInstances(props.wheat, wheat, { wind: "crop", shadow: false });
      addInstances(props.lamp, lamps);

      // Bins: a wheelie bin where the map had each of its plain ones, a
      // wastepaper bin by every bench, and a wheelie bin by the corner of some
      // doorways. All turn to face the road.
      const bins = [], papers = [];
      const faceRoad = (x, z) => {
        const pr = track.project(new THREE.Vector3(x, 0, z));
        track.frameAt(pr.s, fr);
        const k = -Math.sign(pr.t || 1);
        return Math.atan2(fr.right.x * k, fr.right.z * k);
      };
      mapBins.forEach((p, i) => {
        (i % 3 === 2 ? papers : bins).push(
          place(p.x, p.y, p.z, faceRoad(p.x, p.z) + (wr() - 0.5) * 0.5, i % 3 === 2 ? 2.4 : 1)
        );
      });
      const benchSpots = [];
      for (const p of benches) {
        const pr = track.project(new THREE.Vector3(p.x, 0, p.z));
        track.frameAt(pr.s, fr);
        const k = -Math.sign(pr.t || 1);
        papers.push(place(p.x + fr.tangent.x * 1.5, p.y, p.z + fr.tangent.z * 1.5, faceRoad(p.x, p.z), 2.4));
        benchSpots.push({ x: p.x, y: p.y, z: p.z, fx: fr.right.x * k, fz: fr.right.z * k });
      }
      // a ring of benches round each fountain, all facing it
      for (const q of sites.fountains) {
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + 0.3;
          benchSpots.push({ x: q.x + Math.cos(a) * 5.2, y: 0.12, z: q.z + Math.sin(a) * 5.2, fx: -Math.cos(a), fz: -Math.sin(a) });
        }
      }
      this.amenities = new CityAmenities(scene, props, sites, benchSpots);
      this.buildings.placed.forEach((pl, i) => {
        if (pl.noDoor || i % 3 !== 0) return;
        const bx = pl.door.x + pl.right.x * (pl.halfW + 0.8) + pl.fwd.x * 0.7;
        const bz = pl.door.z + pl.right.z * (pl.halfW + 0.8) + pl.fwd.z * 0.7;
        if (!clearOfPaths({ x: bx, z: bz }, 1.2)) return;
        bins.push(place(bx, GROUND, bz, pl.yaw + wr() * 0.6 - 0.3));
      });
      addInstances(props.bin, bins);
      addInstances(props.paper, papers);

      // Columnar evergreens: a pair flanking each doorway's planters, and a
      // loose line along the pavement's outer edge.
      const shrubs = [];
      this.buildings.placed.forEach((pl) => {
        if (pl.noDoor) return;
        const off = Math.max(2.8, Math.min(pl.halfW - 0.9, 3.8));
        for (const side of [-1, 1]) shrubs.push(place(pl.door.x + pl.right.x * side * off + pl.fwd.x * 0.9, GROUND, pl.door.z + pl.right.z * side * off + pl.fwd.z * 0.9, wr() * 6.28, 0.95 + wr() * 0.4));
      });
      for (let sPos = 6; sPos < track.length - 6; sPos += 13 + wr() * 5) {
        const side = wr() < 0.5 ? -1 : 1;
        track.frameAt(sPos, fr);
        const x = fr.position.x + fr.right.x * side * 12.9;
        const z = fr.position.z + fr.right.z * side * 12.9;
        if (paths.some((q) => Math.hypot(q.t.x - x, q.t.z - z) < 3)) continue;
        if (!clearOfBuildings({ x, z }, 0.6)) continue;
        shrubs.push(place(x, 0.12, z, wr() * 6.28, 1.0 + wr() * 0.5));
      }
      addInstances(props.shrub, shrubs);

      // A market: stalls along the pavement where the low shopfronts
      // cluster. The stretch with the most low-rise plots within reach is
      // found by scanning the lap in 10 m steps and taking the best 80 m.
      const low = buildings.filter((b) => b.max.y < 26).map((b) => [(b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2]);
      const step = 10;
      const score = [];
      for (let sPos = 0; sPos < track.length; sPos += step) {
        track.frameAt(sPos, fr);
        score.push(low.reduce((a, [lx, lz]) => a + (Math.hypot(lx - fr.position.x, lz - fr.position.z) < 38 ? 1 : 0), 0));
      }
      let bestAt = 0, bestSum = -1;
      for (let i = 0; i < score.length; i++) {
        let sum = 0;
        for (let k = 0; k < 8; k++) sum += score[(i + k) % score.length];
        if (sum > bestSum) { bestSum = sum; bestAt = i; }
      }
      const stalls = [];
      const stallTints = [0xffffff, 0xffe3b8, 0xdff0ff, 0xf6d3d0, 0xe3f2cf];
      this.stallCount = 0;
      for (let k = 0; k < 20; k++) {
        const sPos = bestAt * step + k * 4;
        const side = k % 2 ? 1 : -1;
        track.frameAt(sPos, fr);
        const x = fr.position.x + fr.right.x * side * 9.6;
        const z = fr.position.z + fr.right.z * side * 9.6;
        if (paths.some((q) => Math.hypot(q.t.x - x, q.t.z - z) < 3.5)) continue;
        stalls.push(place(x, 0.12, z, faceRoad(x, z)));
        this.stallCount++;
      }
      if (stalls.length && props.stall) {
        props.stall.forEach(({ geometry, material }) => {
          const inst = own(new THREE.InstancedMesh(geometry, own(material.clone()), stalls.length));
          inst.castShadow = true;
          inst.frustumCulled = false;
          stalls.forEach((m4, i) => {
            inst.setMatrixAt(i, m4);
            inst.setColorAt(i, tint.setHex(stallTints[i % stallTints.length]));
          });
          inst.instanceMatrix.needsUpdate = true;
          inst.instanceColor.needsUpdate = true;
          scene.add(inst);
          this.objects.push(inst);
        });
      }

      // Chain-link fence along stretches of the pavement's outer edge, never
      // across a path.
      const fences = [];
      for (let sPos = 0; sPos < track.length - 4; sPos += 4) {
        const band = Math.floor(sPos / 70);
        if (band % 3 !== 1) continue;
        const side = band % 2 ? 1 : -1;
        track.frameAt(sPos + 2, fr);
        const x = fr.position.x + fr.right.x * side * 12.5;
        const z = fr.position.z + fr.right.z * side * 12.5;
        if (paths.some((q) => Math.hypot(q.t.x - x, q.t.z - z) < 4.5)) continue;
        if (!clearOfBuildings({ x, z }, 0.4)) continue;
        fences.push(place(x, 0.12, z, Math.atan2(-fr.tangent.z, fr.tangent.x)));
      }
      addInstances(props.fence, fences);
    }
  }

  /** Advance the wind. t in seconds. */
  update(t) {
    uniforms.uTime.value = t;
    this.amenities?.update(t);
  }

  dispose() {
    this.buildings?.dispose();
    this.amenities?.dispose();
    for (const o of this.objects) {
      this.scene.remove(o);
      o.dispose?.();
    }
    for (const d of this.disposables) d.dispose?.();
    this.objects.length = 0;
  }
}
