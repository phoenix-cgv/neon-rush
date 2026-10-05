import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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

function leafTexture() {
  const r = rng(11);
  return canvasTex(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const greens = ["#1c5a22", "#2a7a2e", "#3d9a3a", "#58b24a", "#7bc95a"];
    for (let i = 0; i < 170; i++) {
      const x = 16 + r() * (w - 32);
      const y = 16 + r() * (h - 32);
      const len = 26 + r() * 24;
      const wid = len * (0.38 + r() * 0.12);
      const rot = r() * Math.PI * 2;
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      const col = greens[Math.floor(r() * greens.length)];
      g.fillStyle = col;
      g.beginPath();
      g.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(10,40,12,.55)"; // edge
      g.lineWidth = 1;
      g.stroke();
      g.strokeStyle = "rgba(220,255,200,.35)"; // midrib
      g.beginPath();
      g.moveTo(-len / 2, 0);
      g.lineTo(len / 2, 0);
      g.stroke();
      g.restore();
    }
  });
}

function barkTexture() {
  const r = rng(23);
  return canvasTex(64, 128, (g, w, h) => {
    g.fillStyle = "#6b4a2d";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 120; i++) {
      const x = r() * w;
      const y = r() * h;
      const l = 14 + r() * 40;
      g.strokeStyle = r() < 0.5 ? "rgba(30,18,8,.45)" : "rgba(150,110,70,.35)";
      g.lineWidth = 1 + r() * 2;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 3, y + l);
      g.stroke();
    }
  }, { repeat: true });
}

function needleTexture() {
  const r = rng(37);
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = "#1d4a26";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) {
      const x = r() * w;
      const y = r() * h;
      const a = (r() - 0.5) * 1.6 + Math.PI / 2;
      const l = 5 + r() * 7;
      g.strokeStyle = r() < 0.5 ? "rgba(12,48,22,.8)" : "rgba(86,150,74,.7)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
  }, { repeat: true });
}

function frondTexture() {
  return canvasTex(128, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = "#3a6a2a";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(w / 2, h);
    g.lineTo(w / 2, 4);
    g.stroke();
    for (let y = 14; y < h - 4; y += 9) {
      const t = 1 - y / h; // 0 at the base, 1 at the tip
      const len = (w / 2 - 4) * (1 - Math.pow(t - 0.35, 2) * 1.6);
      for (const s of [-1, 1]) {
        const grad = g.createLinearGradient(w / 2, y, w / 2 + s * len, y + 18);
        grad.addColorStop(0, "#2f6d2a");
        grad.addColorStop(1, "#7fbe4a");
        g.strokeStyle = grad;
        g.lineWidth = 7;
        g.beginPath();
        g.moveTo(w / 2, y);
        g.lineTo(w / 2 + s * Math.max(6, len), y + 16);
        g.stroke();
      }
    }
  });
}

function tuftTexture() {
  const r = rng(51);
  return canvasTex(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 20; i++) {
      const x = 10 + r() * (w - 20);
      const tipX = x + (r() - 0.5) * 36;
      const top = 10 + r() * 50;
      const grad = g.createLinearGradient(0, h, 0, top);
      grad.addColorStop(0, "#1a4a1c");
      grad.addColorStop(0.6, "#3f8c32");
      grad.addColorStop(1, "#9bd46a");
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x - 3, h);
      g.quadraticCurveTo(x + (tipX - x) * 0.2, h * 0.5, tipX, top);
      g.quadraticCurveTo(x + (tipX - x) * 0.3, h * 0.55, x + 3, h);
      g.closePath();
      g.fill();
    }
  });
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
          mode === "grass"
            ? `float bend = uv.y * uv.y;
               transformed.x += sin(uTime * 1.8 + ph + position.x * 2.0) * 0.16 * bend * uSway;
               transformed.z += cos(uTime * 1.5 + ph * 1.3) * 0.12 * bend * uSway;`
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
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Leaf-card canopy: many randomly-turned cards inside an ellipsoid. */
function canopyGeometry(seed, { cards = 90, rx = 2.5, ry = 2.0, cy = 5.0, size = [2.0, 3.0] } = {}) {
  const r = rng(seed);
  const parts = [];
  for (let i = 0; i < cards; i++) {
    // uniform in an ellipsoid, pushed toward the shell so the crown is full
    let x, y, z;
    do {
      x = r() * 2 - 1;
      y = r() * 2 - 1;
      z = r() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    const k = 0.55 + 0.45 * Math.cbrt(x * x + y * y + z * z);
    _v.set(x * rx * k, cy + y * ry * k, z * rx * k);
    const sz = size[0] + r() * (size[1] - size[0]);
    const g = new THREE.PlaneGeometry(sz, sz);
    _e.set((r() - 0.5) * 2.4, r() * Math.PI * 2, (r() - 0.5) * 2.4);
    _q.setFromEuler(_e);
    _m.compose(_v, _q, _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    // outward normals from the crown's centre: shades like a soft sphere
    const p = g.attributes.position;
    const n = g.attributes.normal;
    for (let j = 0; j < p.count; j++) {
      _s.set(p.getX(j) / rx, (p.getY(j) - cy) / ry, p.getZ(j) / rx).normalize();
      n.setXYZ(j, _s.x, _s.y, _s.z);
    }
    parts.push(g);
  }
  return mergeGeometries(parts, false);
}

function trunkGeometry(h, r0, r1, branches = 3, seed = 5) {
  const r = rng(seed);
  const parts = [new THREE.CylinderGeometry(r1, r0, h, 8, 3).translate(0, h / 2, 0)];
  for (let i = 0; i < branches; i++) {
    const len = 1.4 + r();
    const g = new THREE.CylinderGeometry(0.05, 0.11, len, 5).translate(0, len / 2, 0);
    g.rotateZ((0.5 + r() * 0.5) * (i % 2 ? 1 : -1));
    g.rotateY(r() * Math.PI * 2);
    g.translate(0, h * (0.6 + r() * 0.3), 0);
    parts.push(g);
  }
  return mergeGeometries(parts, false);
}

function pineGeometry() {
  const parts = [];
  const tiers = 6;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const radius = 2.0 - t * 1.55;
    const height = 2.1 - t * 0.5;
    const g = new THREE.ConeGeometry(radius, height, 10, 1, true);
    g.translate(0, 2.3 + i * 1.05 + height / 2, 0);
    // a slight droop: pull the rim down
    const p = g.attributes.position;
    for (let j = 0; j < p.count; j++) {
      if (p.getY(j) < 2.3 + i * 1.05 + height * 0.2) p.setY(j, p.getY(j) - 0.12);
    }
    g.computeVertexNormals();
    parts.push(g);
  }
  return mergeGeometries(parts, false);
}

function palmTrunkGeometry(lean) {
  const segs = 9;
  const parts = [];
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const len = 0.78;
    const r0 = 0.22 - t * 0.07;
    const g = new THREE.CylinderGeometry(r0 - 0.012, r0, len, 7, 1).translate(0, len / 2, 0);
    const tilt = lean * (0.35 + t);
    g.rotateZ(tilt);
    g.translate(x, y, z);
    parts.push(g);
    x += -Math.sin(tilt) * len;
    y += Math.cos(tilt) * len;
  }
  return { geo: mergeGeometries(parts, false), top: new THREE.Vector3(x, y, z) };
}

function frondGeometry(top, seed) {
  const r = rng(seed);
  const parts = [];
  const fronds = 9;
  for (let i = 0; i < fronds; i++) {
    const g = new THREE.PlaneGeometry(1.5, 3.3, 1, 8).translate(0, 1.65, 0);
    const p = g.attributes.position;
    for (let j = 0; j < p.count; j++) {
      const t = p.getY(j) / 3.3;
      p.setZ(j, p.getZ(j) - t * t * 1.5); // droop outward and down
      p.setY(j, p.getY(j) * (1 - t * 0.12));
    }
    g.rotateX(-1.05 + (r() - 0.5) * 0.4); // lay the frond out, tip up a little
    g.rotateY((i / fronds) * Math.PI * 2 + (r() - 0.5) * 0.3);
    g.translate(top.x, top.y, top.z);
    g.computeVertexNormals();
    parts.push(g);
  }
  return mergeGeometries(parts, false);
}

function tuftGeometry() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(0.75, 0.6, 1, 2).translate(0, 0.3, 0);
    g.rotateY((i / 3) * Math.PI);
    parts.push(g);
  }
  const g = mergeGeometries(parts, false);
  // upward normals: lit like the ground they stand on, not like a wall
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

// -------------------------------------------------------------------- main
export class CityNature {
  /**
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {object} gltf  the loaded map (its TreePit and GreenIsland nodes place everything)
   * @param {THREE.Group} mapGroup  the built map, whose "Grass Light" material gets the lawn
   */
  constructor(scene, track, gltf, mapGroup) {
    this.scene = scene;
    this.objects = [];
    this.disposables = [];
    const own = (o) => (this.disposables.push(o), o);

    // Where things go.
    const pits = [];
    const islands = [];
    const box = new THREE.Box3();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (/^TreePit/.test(o.name)) {
        box.setFromObject(o);
        pits.push(new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2));
      } else if (/^GreenIsland/.test(o.name)) {
        islands.push(box.setFromObject(o).clone());
      }
    });

    // Textures
    const leaf = own(leafTexture());
    const bark = own(barkTexture());
    const needles = own(needleTexture());
    const frond = own(frondTexture());
    const tuft = own(tuftTexture());
    const lawn = own(lawnTexture());

    // The lawn on the islands (the map's flat "Grass Light" material).
    mapGroup.traverse((o) => {
      if (o.isMesh && o.material?.name === "Grass Light") lawnify(o.material, lawn);
    });

    // ---- trees
    const barkMat = own(new THREE.MeshStandardMaterial({ map: bark, roughness: 0.95 }));
    const leafMat = own(windify(new THREE.MeshStandardMaterial({
      map: leaf, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85,
      // a little self-light from the same texture: leaves seen against the
      // low sun would otherwise go black
      emissive: 0x3d7a2c, emissiveMap: leaf, emissiveIntensity: 0.5,
    }), "leaf"));
    const needleMat = own(windify(new THREE.MeshStandardMaterial({ map: needles, side: THREE.DoubleSide, roughness: 0.9, emissive: 0x2f6a30, emissiveMap: needles, emissiveIntensity: 0.3 }), "tree"));
    const frondMat = own(windify(new THREE.MeshStandardMaterial({
      map: frond, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8,
      emissive: 0x4f9a35, emissiveMap: frond, emissiveIntensity: 0.6,
    }), "leaf"));
    const trunkTree = windify(barkMat, "tree");

    const lean = 0.14;
    const palm = palmTrunkGeometry(lean);
    const variants = [
      { kind: "broad", parts: [[trunkGeometry(3.6, 0.3, 0.17, 3, 5), trunkTree], [canopyGeometry(101), leafMat]] },
      { kind: "broad", parts: [[trunkGeometry(3.2, 0.28, 0.16, 4, 7), trunkTree], [canopyGeometry(202, { cards: 76, rx: 2.2, ry: 1.8, cy: 4.6 }), leafMat]] },
      { kind: "broad", parts: [[trunkGeometry(4.0, 0.32, 0.18, 3, 9), trunkTree], [canopyGeometry(303, { cards: 104, rx: 2.8, ry: 2.2, cy: 5.4 }), leafMat]] },
      { kind: "pine", parts: [[trunkGeometry(3.0, 0.26, 0.14, 0, 3), trunkTree], [pineGeometry(), needleMat]] },
      { kind: "palm", parts: [[palm.geo, trunkTree], [frondGeometry(palm.top, 404), frondMat]] },
    ];
    // which variant stands at which pit (deterministic)
    const pickR = rng(777);
    const buckets = variants.map(() => []);
    pits.forEach((p) => {
      const t = pickR();
      const v = t < 0.5 ? Math.floor(pickR() * 3) : t < 0.8 ? 3 : 4;
      buckets[v].push(p);
    });

    const placeR = rng(888);
    const tint = new THREE.Color();
    const warm = [0xc9a33a, 0xd2762c, 0xb8442a]; // a few late-season trees
    buckets.forEach((spots, vi) => {
      if (!spots.length) return;
      for (const [geo, mat] of variants[vi].parts) {
        const inst = own(new THREE.InstancedMesh(geo, mat, spots.length));
        inst.castShadow = true;
        inst.receiveShadow = mat !== leafMat;
        inst.frustumCulled = false;
        spots.forEach((p, i) => {
          const sc = 0.85 + placeR() * 0.45;
          _q.setFromAxisAngle(_v.set(0, 1, 0), placeR() * Math.PI * 2);
          _m.compose(p, _q, _s.set(sc, sc, sc));
          inst.setMatrixAt(i, _m);
          if (mat === leafMat || mat === frondMat) {
            const accent = variants[vi].kind === "broad" && placeR() < 0.18;
            tint.setHex(accent ? warm[Math.floor(placeR() * warm.length)] : 0xffffff);
            if (!accent) tint.offsetHSL((placeR() - 0.5) * 0.04, 0, (placeR() - 0.5) * 0.16);
            inst.setColorAt(i, tint);
          }
        });
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        scene.add(inst);
        this.objects.push(inst);
      }
    });

    // ---- grass tufts
    const spotsG = [];
    const gr = rng(999);
    for (const b of islands) {
      const area = (b.max.x - b.min.x) * (b.max.z - b.min.z);
      const n = Math.min(1400, Math.floor(area * 0.55));
      for (let i = 0; i < n; i++) {
        spotsG.push(new THREE.Vector3(b.min.x + gr() * (b.max.x - b.min.x), b.max.y, b.min.z + gr() * (b.max.z - b.min.z)));
      }
    }
    // along the pavement's outer edge, both sides of the road
    const fr = {};
    for (let s = 0; s < track.length; s += 1.7) {
      track.frameAt(s, fr);
      for (const side of [-1, 1]) {
        if (gr() < 0.45) continue;
        const lat = side * (12.4 + gr() * 2.6);
        spotsG.push(new THREE.Vector3(fr.position.x + fr.right.x * lat, fr.position.y - 0.08, fr.position.z + fr.right.z * lat));
      }
    }
    // A little emission from the same texture, so tufts keep their green
    // in the dim late light instead of reading as black spikes.
    const grassMat = own(windify(new THREE.MeshStandardMaterial({
      map: tuft, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.95,
      emissive: 0x4a8a3a, emissiveMap: tuft, emissiveIntensity: 0.45,
    }), "grass"));
    const grass = own(new THREE.InstancedMesh(own(tuftGeometry()), grassMat, spotsG.length));
    grass.frustumCulled = false;
    grass.receiveShadow = true;
    spotsG.forEach((p, i) => {
      const sc = 0.7 + gr() * 0.9;
      _q.setFromAxisAngle(_v.set(0, 1, 0), gr() * Math.PI);
      _m.compose(p, _q, _s.set(sc, sc * (0.8 + gr() * 0.6), sc));
      grass.setMatrixAt(i, _m);
      grass.setColorAt(i, tint.setHSL(0.27 + (gr() - 0.5) * 0.06, 0.45 + gr() * 0.2, 0.55 + gr() * 0.25));
    });
    grass.instanceMatrix.needsUpdate = true;
    grass.instanceColor.needsUpdate = true;
    scene.add(grass);
    this.objects.push(grass);
  }

  /** Advance the wind. t in seconds. */
  update(t) {
    uniforms.uTime.value = t;
  }

  dispose() {
    for (const o of this.objects) {
      this.scene.remove(o);
      o.dispose?.();
    }
    for (const d of this.disposables) d.dispose?.();
    this.objects.length = 0;
  }
}
