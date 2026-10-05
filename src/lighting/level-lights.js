import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MAP_WORLD_LAYER } from "../ui/minimap.js";
import { LightPool } from "./light-pool.js";

// ---------------------------------------------------------------------
// Extra lights a level asks for, beyond the sun and the sky fill that
// every level has. Declared in the level's `lit.lights` and built here on
// load, removed on the next one.
//
// Built only when a level asks, never up front. A light costs a uniform
// and a loop iteration in EVERY lit fragment shader whether it emits
// anything or not — twelve idle headlights once took a quarter of the
// frame (README §8). So a daytime level that declares nothing pays
// nothing, and the count a level declares is the count it pays for.
//
// Every light is put on the minimap's layer too. Lights are layer-gated
// like meshes: one the map camera cannot "see" does not light the map's
// pass. It also keeps the light count, and so the shader programs, the
// same in both passes.
//
// Placement is world space (`position`) or track space (`at`: { s,
// lateral, height }), like the pickups and hazard signs, so a light
// stays beside the road if the map is regenerated.
//
//   { type: "point" | "spot", color, intensity, distance, decay,
//     position: [x, y, z]  or  at: { s, lateral = 0, height = 6 },
//     angle, penumbra  (spot: aims straight down at the road) }
//
// `lit.pools` are light pools (src/lighting/light-pool.js): a few real
// lights that follow the player between many glowing fixtures.
//
// `lit.strips` are glowing light fittings a level needs but its map does
// not have (the Mountain's tunnel was modelled with no lights in it):
//   { name, s0, s1, every, height, lateral = 0, length, color, intensity }
// One merged mesh per strip run, with a material called `name`, so a
// pool can find the fittings by that name. They are built before the
// pools for exactly that reason.
// ---------------------------------------------------------------------

const _fr = {};

export class LevelLights {
  constructor(scene) {
    this.scene = scene;
    this.lights = [];
    this.pools = [];
    this.strips = [];
  }

  /** Replace whatever the last level built with `defs`, `pools` and `strips`. */
  build(defs = [], track = null, pools = [], strips = []) {
    this.clear();
    if (track) for (const st of strips) this.#buildStrip(st, track);
    for (const p of pools) this.pools.push(new LightPool(this.scene, p, track));
    for (const d of defs) {
      const light =
        d.type === "spot"
          ? new THREE.SpotLight(d.color ?? 0xffffff, d.intensity ?? 50, d.distance ?? 40, d.angle ?? Math.PI / 5, d.penumbra ?? 0.5, d.decay ?? 2)
          : new THREE.PointLight(d.color ?? 0xffffff, d.intensity ?? 50, d.distance ?? 30, d.decay ?? 2);

      if (d.at && track) {
        track.frameAt(d.at.s, _fr);
        light.position
          .copy(_fr.position)
          .addScaledVector(_fr.right, d.at.lateral ?? 0)
          .addScaledVector(_fr.up, d.at.height ?? 6);
      } else if (d.position) {
        light.position.set(...d.position);
      }
      if (light.isSpotLight) {
        light.target.position.copy(light.position).y -= 10;
        this.scene.add(light.target);
      }
      light.layers.enable(MAP_WORLD_LAYER);
      this.scene.add(light);
      this.lights.push(light);
    }
  }

  /** A run of glowing fittings along the track, as one mesh. */
  #buildStrip(st, track) {
    const parts = [];
    const m = new THREE.Matrix4();
    const back = new THREE.Vector3();
    for (let s = st.s0; s <= st.s1; s += st.every ?? 9) {
      track.frameAt(s, _fr);
      const g = new THREE.BoxGeometry(0.35, 0.1, st.length ?? 3);
      // Fitting's frame: x across, y up, z along the road.
      m.makeBasis(_fr.right, _fr.up, back.copy(_fr.tangent).negate()).setPosition(
        _fr.position.clone().addScaledVector(_fr.right, st.lateral ?? 0).addScaledVector(_fr.up, st.height ?? 6)
      );
      parts.push(g.applyMatrix4(m));
    }
    if (!parts.length) return;
    const geo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    const mat = new THREE.MeshStandardMaterial({
      name: st.name,
      color: 0x222222,
      emissive: st.color ?? 0xffb070,
      emissiveIntensity: st.intensity ?? 6,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = st.name;
    this.scene.add(mesh);
    this.strips.push(mesh);
  }

  /** Once per rendered frame, with the player's position. */
  update(pos) {
    for (const p of this.pools) p.update(pos);
  }

  clear() {
    for (const p of this.pools) p.dispose();
    this.pools.length = 0;
    for (const m of this.strips) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.strips.length = 0;
    for (const l of this.lights) {
      this.scene.remove(l);
      if (l.isSpotLight) this.scene.remove(l.target);
      l.dispose();
    }
    this.lights.length = 0;
  }
}
