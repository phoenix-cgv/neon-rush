import * as THREE from "three";
import { MAP_WORLD_LAYER } from "../ui/minimap.js";

// ---------------------------------------------------------------------
// A light pool: many light SOURCES in the world, a few real LIGHTS.
//
// At night the Grand Prix has eleven floodlight towers and a tunnel lined
// with strip lights. A real light per source would be the README §8
// lesson again on a far bigger scale: every light is a loop iteration in
// every lit fragment shader, on every pixel, whether it reaches that
// pixel or not.
//
// But only the sources near the player can visibly light anything the
// player sees close up. Far away, the emissive glow and bloom already
// carry the look. So `count` real lights follow the player around,
// each sitting on one of the nearest sources every frame.
//
// The hard part is a light jumping from one tower to another without a
// pop. Each light is faded by how close its source is to being bumped
// out of the nearest few: with the sources sorted by distance, the k-th
// nearest is weighted by how much nearer it is than the first one not
// chosen. A light is therefore at zero exactly when its source is about
// to be swapped, and the swap is invisible.
//
// The light count never changes, so the shader programs never recompile
// while driving. Positions and intensities are just uniforms.
//
// Sources are FOUND, not placed: the vertices of the map's glowing
// material (`material`, e.g. "FloodlightGlow") are clustered into
// separate fixtures. Re-exporting the map moves the lights with it.
//
//   { material, count, type: "spot" | "point", color, intensity, distance,
//     decay, angle, penumbra, cluster (m, default 15), fade (m, default 40) }
//
// Spots aim at the nearest point of the track centreline: a floodlight
// lights the road it stands beside.
// ---------------------------------------------------------------------

const _v = new THREE.Vector3();
const _fr = {};

/** Group a merged mesh's vertices into separate fixtures, by proximity. */
function findSources(scene, materialName, radius) {
  const pts = [];
  scene.traverse((o) => {
    if (!o.isMesh || o.material?.name !== materialName) return;
    const p = o.geometry.attributes.position;
    o.updateMatrixWorld();
    for (let i = 0; i < p.count; i++) pts.push(_v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).clone());
  });
  // Greedy clustering: each point joins the first cluster whose running
  // centre is within `radius`. A few hundred points, once per load.
  const clusters = [];
  for (const p of pts) {
    const c = clusters.find((k) => k.centre.distanceTo(p) < radius);
    if (c) {
      c.sum.add(p);
      c.n++;
      c.centre.copy(c.sum).divideScalar(c.n);
    } else {
      clusters.push({ sum: p.clone(), n: 1, centre: p.clone() });
    }
  }
  return clusters.map((c) => c.centre);
}

export class LightPool {
  constructor(scene, def, track) {
    this.scene = scene;
    this.def = def;
    this.fade = def.fade ?? 40;
    this.sources = findSources(scene, def.material, def.cluster ?? 15).map((position) => {
      const target = new THREE.Vector3();
      if (track) {
        const pr = track.project(position);
        track.frameAt(pr.s, _fr);
        target.copy(_fr.position);
      } else {
        target.copy(position).y -= 10;
      }
      return { position, target, d: 0 };
    });
    this.lights = [];
    const n = Math.min(def.count ?? 4, this.sources.length);
    for (let i = 0; i < n; i++) {
      const light =
        def.type === "point"
          ? new THREE.PointLight(def.color ?? 0xffffff, 0, def.distance ?? 30, def.decay ?? 2)
          : new THREE.SpotLight(def.color ?? 0xffffff, 0, def.distance ?? 120, def.angle ?? Math.PI / 6, def.penumbra ?? 0.6, def.decay ?? 2);
      light.layers.enable(MAP_WORLD_LAYER);
      scene.add(light);
      if (light.isSpotLight) scene.add(light.target);
      this.lights.push(light);
    }
  }

  /** Move the lights onto the sources nearest `pos`. Once per rendered frame. */
  update(pos) {
    const src = this.sources;
    for (const s of src) s.d = s.position.distanceTo(pos);
    src.sort((a, b) => a.d - b.d);
    const n = this.lights.length;
    // Distance of the first source NOT given a light; with every source
    // lit there is nothing to fade toward.
    const cut = src.length > n ? src[n].d : Infinity;
    for (let i = 0; i < n; i++) {
      const s = src[i];
      const l = this.lights[i];
      l.position.copy(s.position);
      if (l.isSpotLight) l.target.position.copy(s.target);
      const w = cut === Infinity ? 1 : THREE.MathUtils.clamp((cut - s.d) / this.fade, 0, 1);
      l.intensity = (this.def.intensity ?? 100) * w;
    }
  }

  dispose() {
    for (const l of this.lights) {
      this.scene.remove(l);
      if (l.isSpotLight) this.scene.remove(l.target);
      l.dispose();
    }
    this.lights.length = 0;
  }
}
