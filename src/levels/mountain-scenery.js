import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import planeUrl from "../../assets/props/airplane-2.glb?url";
import towerAUrl from "../../assets/props/radio-tower-a.glb?url";
import towerBUrl from "../../assets/props/radio-tower-b.glb?url";
import mountainsUrl from "../../assets/props/mountains.glb?url";
import rockUrl from "../../assets/props/rock-flat-grass.glb?url";
import tree2Url from "../../assets/props/tree-2.glb?url";
import autumnUrl from "../../assets/props/autumn-tree.glb?url";
import goatUrl from "../../assets/props/goat.glb?url";
import islandUrl from "../../assets/props/island-fox.glb?url";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// ---------------------------------------------------------------------
// Mountain Track scenery from the provided models:
//
//   radio towers   on the highest ground clear of the road, two designs
//                  alternating, each with a red beacon that pulses
//   aeroplane      one biplane wandering a looping route across the mountain
//   range          a ring of distant snow-capped mountains beyond the map
//   boulders, trees  grass-topped rocks, round-crowned trees and autumn trees scattered on the slopes
//   goats          small herds grazing on the slopes beside the road
//   islands        floating islands (one with a fox) far above the mountain
//   neon streaks   an orange line along each guardrail through the tunnel
//
// Towers stand where a downward ray finds the terrain, so they sit on the
// slope rather than float. Nothing here is physical.
// ---------------------------------------------------------------------

const loader = new GLTFLoader();
let loading = null;
let models = null;

/** Merge a glTF's meshes into world-space geometry, re-based so (0,0,0) is the middle of the foot. */
function bake(gltf, { footY = null, merge = false, height: targetH = null } = {}) {
  gltf.scene.updateMatrixWorld(true);
  let parts = [];
  const byMaterial = new Map();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (merge) {
      // many tiny meshes sharing a handful of materials: one draw call per material
      for (const k of Object.keys(geometry.attributes)) if (!["position", "normal", "uv"].includes(k)) geometry.deleteAttribute(k);
      if (!geometry.attributes.uv) geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2));
      const list = byMaterial.get(o.material) ?? byMaterial.set(o.material, []).get(o.material);
      list.push(geometry.index ? geometry.toNonIndexed() : geometry);
      return;
    }
    const material = o.material.clone();
    material.vertexColors = !!geometry.attributes.color;
    material.side = THREE.DoubleSide;
    parts.push({ geometry, material });
  });
  if (merge) {
    for (const [mat, list] of byMaterial) {
      const material = mat.clone();
      material.side = THREE.DoubleSide;
      parts.push({ geometry: mergeGeometries(list), material });
    }
  }
  const box = new THREE.Box3();
  parts.forEach((p) => (p.geometry.computeBoundingBox(), box.union(p.geometry.boundingBox)));
  if (footY !== null) {
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    parts.forEach((p) => p.geometry.translate(-cx, -box.min.y + footY, -cz));
    const k = targetH ? targetH / (box.max.y - box.min.y) : 1;
    if (k !== 1) parts.forEach((p) => p.geometry.scale(k, k, k));
    return { parts, height: (box.max.y - box.min.y) * k, width: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * k };
  }
  return { parts, height: box.max.y - box.min.y };
}

export function loadMountainProps() {
  loading ??= Promise.all([planeUrl, towerAUrl, towerBUrl, goatUrl, islandUrl, mountainsUrl, rockUrl, tree2Url, autumnUrl].map((u) => loader.loadAsync(u)))
    .then(([plane, a, b, goat, island, range, rock, tree2, autumn]) => (models = {
      range: bake(range, { footY: 0 }),
      rock: bake(rock, { footY: 0 }),
      tree2: bake(tree2, { footY: 0, height: 9 }),
      autumn: bake(autumn, { footY: 0, height: 10 }),
      plane: bake(plane),
      towerA: bake(a, { footY: -0.3 }),
      towerB: bake(b, { footY: -0.3 }),
      goat: bake(goat, { footY: 0 }),
      island: bake(island, { merge: true }),
    }))
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
  constructor(scene, track, ground, { tunnel = null } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = "MountainScenery";
    scene.add(this.group);
    this.beacons = [];
    this.flyers = [];
    this.goats = [];
    this.islands = [];
    this.towerCount = 0;
    this.treeCount = 0;
    this.rockCount = 0;
    this.tunnelUniforms = { uTime: { value: 0 } };
    if (tunnel) this.#neonTunnel(track, tunnel[0], tunnel[1]);
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

    // ---- one aeroplane, wandering a looping route over the whole mountain
    const cx = chosen[0]?.x ?? 0;
    const cz = chosen[0]?.z ?? 0;
    const top = chosen[0]?.y ?? 70;
    {
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
      this.plane = { root, cx, cz, alt: top + 75 };
    }

    // ---- scatter helpers: ground points off the road on the grass slopes
    const grassOnly = ground.filter((m) => /Grass/.test(m.name));
    const sr = (() => { let t = 90210; return () => ((t = (Math.imul(t ^ (t >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296); })();
    const scatterPoints = (count, near, far, maxTries, minSep = 0) => {
      const pts = [];
      for (let n = 0; n < maxTries && pts.length < count; n++) {
        const x = box.min.x + 10 + sr() * (box.max.x - box.min.x - 20);
        const z = box.min.z + 10 + sr() * (box.max.z - box.min.z - 20);
        rc.set(probe.set(x, box.max.y + 50, z), down);
        const hit = rc.intersectObjects(grassOnly, false)[0];
        if (!hit) continue;
        const dist = track.project(probe.set(x, hit.point.y, z)).distance;
        if (dist < near || dist > far) continue;
        if (hit.face && hit.face.normal.y < 0.6) continue; // not on a cliff face
        if (minSep && pts.some((q) => Math.hypot(q.x - x, q.z - z) < minSep)) continue;
        pts.push({ x, y: hit.point.y, z });
      }
      return pts;
    };
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
    const compose = (pt, yaw, sc, sink = 0) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(pt.x, pt.y - sink, pt.z),
        new THREE.Quaternion().setFromAxisAngle(down.clone().negate(), yaw),
        new THREE.Vector3(sc, sc * (0.9 + sr() * 0.3), sc)
      );

    // ---- more trees: round-crowned and autumn, in loose groves beside the road
    {
      const t2 = scatterPoints(130, 12, 110, 4000, 6).map((pt) => compose(pt, sr() * 6.28, 0.8 + sr() * 0.6, 0.15));
      const au = scatterPoints(70, 14, 120, 4000, 8).map((pt) => compose(pt, sr() * 6.28, 0.8 + sr() * 0.6, 0.15));
      instance(models.tree2.parts, t2);
      instance(models.autumn.parts, au);
      this.treeCount += t2.length + au.length;
    }

    // ---- boulders: grass-topped rocks of every size
    {
      const bm = scatterPoints(90, 9, 100, 4000, 4).map((pt) => compose(pt, sr() * 6.28, 2 + Math.pow(sr(), 2) * 6, 0.3));
      instance(models.rock.parts, bm);
      this.rockCount = bm.length;
    }

    // ---- a ring of distant mountains beyond the map, snow-capped, in the haze
    {
      const n = 9;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + sr() * 0.3;
        const rad = 620 + sr() * 120;
        const width = 520 + sr() * 260;
        const sc = width / models.range.width;
        const g = new THREE.Group();
        for (const { geometry, material } of models.range.parts) g.add(new THREE.Mesh(geometry, material));
        g.scale.set(sc, sc * (0.9 + sr() * 0.5), sc);
        g.position.set(cx + Math.cos(ang) * rad, -25, cz + Math.sin(ang) * rad);
        g.rotation.y = sr() * 6.28;
        this.group.add(g);
      }
    }

    // ---- goats grazing on the grass beside the road
    {
      const rr = (a) => { let t = a >>> 0; return () => ((t = (Math.imul(t ^ (t >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296); };
      const rand = rr(31337);
      const fr = {};
      const grass = ground.filter((m) => /Grass/.test(m.name));
      const herds = [];
      for (let n = 0; n < 1500 && herds.length < 6; n++) {
        const sPos = 60 + rand() * (track.length - 120);
        if ((sPos > 660 && sPos < 840) || (sPos > 1000 && sPos < 1180)) continue; // tunnel, viaduct
        if (herds.some((h) => Math.abs(h.s - sPos) < 120)) continue;
        track.frameAt(sPos, fr);
        const side = rand() < 0.5 ? -1 : 1;
        const off = 15 + rand() * 12;
        const x = fr.position.x + fr.right.x * side * off;
        const z = fr.position.z + fr.right.z * side * off;
        rc.set(probe.set(x, fr.position.y + 60, z), down);
        const hit = rc.intersectObjects(grass, false)[0];
        if (!hit || Math.abs(hit.point.y - fr.position.y) > 5) continue;
        if (hit.face && hit.face.normal.y < 0.8) continue; // too steep to graze
        herds.push({ s: sPos, x, z, y: hit.point.y });
      }
      herds.forEach((h, hi) => {
        const count = 3 + (hi % 3);
        for (let k = 0; k < count; k++) {
          const gx = h.x + (rand() - 0.5) * 7;
          const gz = h.z + (rand() - 0.5) * 7;
          rc.set(probe.set(gx, h.y + 20, gz), down);
          const hit = rc.intersectObjects(grass, false)[0];
          if (!hit || Math.abs(hit.point.y - h.y) > 3) continue;
          const g = new THREE.Group();
          for (const { geometry, material } of models.goat.parts) {
            const m = new THREE.Mesh(geometry, material);
            m.castShadow = true;
            g.add(m);
          }
          const sc = 0.011 + rand() * 0.003;
          g.scale.setScalar(sc);
          g.position.set(gx, hit.point.y, gz);
          this.group.add(g);
          this.goats.push({ obj: g, x: gx, z: gz, y: hit.point.y, yaw: rand() * 6.28, phase: rand() * 6.28, range: 1.5 + rand() * 2 });
        }
      });
    }

    // ---- floating islands, all high above the mountain
    [
      { x: cx - 70, z: cz + 40, alt: top + 210, scale: 26, spin: 0.03 },
      { x: cx + 190, z: cz - 130, alt: top + 290, scale: 20, spin: -0.04 },
      { x: cx - 260, z: cz - 150, alt: top + 250, scale: 30, spin: 0.025 },
      { x: cx + 60, z: cz + 260, alt: top + 330, scale: 24, spin: -0.03 },
      { x: cx - 120, z: cz - 330, alt: top + 380, scale: 34, spin: 0.02 },
      { x: cx + 330, z: cz + 120, alt: top + 270, scale: 22, spin: 0.04 },
      { x: cx - 330, z: cz + 190, alt: top + 340, scale: 28, spin: -0.025 },
    ].forEach((d, i) => {
      const g = new THREE.Group();
      for (const { geometry, material } of models.island.parts) {
        const m = new THREE.Mesh(geometry, material);
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
      }
      g.scale.setScalar(d.scale);
      g.position.set(d.x, d.alt, d.z);
      this.group.add(g);
      this.islands.push({ obj: g, ...d, phase: i * 2 });
    });
  }

  // Light running along the road through the tunnel: a bright centre streak
  // and two side lines, each pulsing forward in the direction of travel.
  #neonTunnel(track, s0, s1) {
    const fr = {};
    const step = 2;
    // one orange line along each guardrail, standing on the inside face of the rail
    const lines = [
      { off: -6.0, color: [1.0, 0.42, 0.04], speed: 1.0 },
      { off: 6.0, color: [1.0, 0.42, 0.04], speed: 1.0 },
    ];
    for (const L of lines) {
      const pos = [], uv = [], idx = [];
      let n = 0;
      for (let sPos = s0 - 6; sPos <= s1 + 6; sPos += step, n++) {
        track.frameAt(sPos, fr);
        const c = fr.position.clone().addScaledVector(fr.right, L.off);
        const a = c.clone().addScaledVector(fr.up, 0.42);
        const b = c.clone().addScaledVector(fr.up, 0.78);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        uv.push(0, sPos, 1, sPos);
        if (n) { const k = (n - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...this.tunnelUniforms, uColor: { value: new THREE.Vector3(...L.color) }, uSpeed: { value: L.speed }, uS0: { value: s0 }, uS1: { value: s1 } },
        vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader: `varying vec2 vUv; uniform float uTime; uniform vec3 uColor; uniform float uSpeed; uniform float uS0; uniform float uS1;
          void main(){
            float edge = 1.0 - abs(vUv.x * 2.0 - 1.0);
            float core = pow(edge, 0.6);
            // pulses run forward along the tunnel; a faint base keeps the line lit between them
            float ph = fract(vUv.y / 14.0 - uTime * uSpeed * 0.9);
            float pulse = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.08, 0.5, ph));
            float fade = smoothstep(uS0 - 6.0, uS0 + 4.0, vUv.y) * (1.0 - smoothstep(uS1 - 4.0, uS1 + 6.0, vUv.y));
            float a = core * (0.6 + 1.1 * pulse) * fade;
            gl_FragColor = vec4(uColor * (0.6 + 1.4 * pulse) * a, a);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
    }
  }

  /** t in seconds. */
  update(t) {
    this.tunnelUniforms.uTime.value = t;
    for (const b of this.beacons) b.mesh.visible = Math.sin(t * 2.4 + b.phase) > -0.2;
    if (this.plane) {
      // a looping route that wanders: two incommensurate harmonics, so it
      // never retraces itself and sweeps over the whole mountain
      const P = this.plane;
      const at = (u) => [
        P.cx + 210 * Math.cos(u) + 90 * Math.cos(2.7 * u + 1.3),
        P.alt + 22 * Math.sin(1.9 * u),
        P.cz + 170 * Math.sin(u * 1.0 + 0.4) + 80 * Math.sin(2.3 * u),
      ];
      const u = t * 0.085;
      const [x, y, z] = at(u);
      const [x2, , z2] = at(u + 0.02);
      const [x0, , z0] = at(u - 0.02);
      P.root.position.set(x, y, z);
      const hx = x2 - x, hz = z2 - z;
      // turn rate gives the bank
      const turn = Math.atan2((x2 - x) * (z - z0) - (z2 - z) * (x - x0), (x2 - x) * (x - x0) + (z2 - z) * (z - z0));
      P.root.rotation.set(0, Math.atan2(-hx, -hz), THREE.MathUtils.clamp(turn * 9, -0.5, 0.5), "YXZ");
    }
    for (const g of this.goats) {
      // graze: a slow amble back and forth, pausing at the ends
      const w = Math.sin(t * 0.18 + g.phase);
      const along = Math.sign(w) * Math.pow(Math.abs(w), 0.6) * g.range;
      g.obj.position.set(g.x + Math.sin(g.yaw) * along, g.y, g.z + Math.cos(g.yaw) * along);
      g.obj.rotation.y = g.yaw + (Math.cos(t * 0.18 + g.phase) > 0 ? 0 : Math.PI);
    }
    for (const i of this.islands) {
      i.obj.position.y = i.alt + Math.sin(t * 0.3 + i.phase) * 4;
      i.obj.rotation.y = t * i.spin;
    }
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
