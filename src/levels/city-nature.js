import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CityBuildings } from "./city-buildings.js";
import treeUrl from "../../assets/props/ornamental-tree.glb?url";
import planterUrl from "../../assets/props/planter-box.glb?url";
import wheatUrl from "../../assets/props/wheat-plant.glb?url";
import lampUrl from "../../assets/props/lamp-post.glb?url";
import fenceUrl from "../../assets/props/chain-link-fence.glb?url";

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
    out.push({ geometry, material });
  });
  return out;
}

/** Fetch the GL props once (the tree, planter box, wheat, lamp post, fence). */
export function loadCityProps() {
  propsLoading ??= Promise.all(
    [["tree", treeUrl], ["planter", planterUrl], ["wheat", wheatUrl], ["lamp", lampUrl], ["fence", fenceUrl]].map(
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
    const buildings = [];
    const box = new THREE.Box3();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (/^TreePit/.test(o.name)) {
        box.setFromObject(o);
        pits.push(new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2));
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
    this.buildings = new CityBuildings(scene, buildings);
    const doorOf = new Map(this.buildings.placed.map((p) => [p.index, p]));

    // ---- paths from the pavement to every building's door
    // Doors face +Z (the map's -Y). A short forecourt straight out from the
    // door, then a straight run to the pavement's outer edge. A building whose
    // run would cut across another is left without a path.
    const paths = [];
    const fr = {};
    buildings.forEach((b, bi) => {
      if (!doorOf.has(bi)) return; // no building stands here any more
      const cx = (b.min.x + b.max.x) / 2;
      const e = { x: cx, z: b.max.z };
      const f = { x: cx, z: b.max.z + 2.6 };
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
      let clear = true;
      for (const o of buildings) {
        if (o === b) {
          if (segmentHitsBox(f.x, f.z, t.x, t.z, o, 0.2)) clear = false;
        } else if (segmentHitsBox(f.x, f.z, t.x, t.z, o, 1.0) || segmentHitsBox(e.x, e.z, f.x, f.z, o, 0.4)) {
          clear = false;
        }
        if (!clear) break;
      }
      if (clear) paths.push({ e, f, t });
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
      !buildings.some((b) => p.x > b.min.x - pad && p.x < b.max.x + pad && p.z > b.min.z - pad && p.z < b.max.z + pad);
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
        for (const side of [-1, 1]) {
          const px = pth.e.x + side * 1.7;
          const pz = pth.e.z + 0.8;
          planters.push(place(px, GROUND, pz, 0));
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
  }

  dispose() {
    this.buildings?.dispose();
    for (const o of this.objects) {
      this.scene.remove(o);
      o.dispose?.();
    }
    for (const d of this.disposables) d.dispose?.();
    this.objects.length = 0;
  }
}
