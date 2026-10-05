import * as THREE from "three";
import { CAR } from "../vehicle/config.js";
import { MINIMAP_LAYER } from "../ui/minimap.js";

// ---------------------------------------------------------------------
// Pickups: repair and boost orbs on the road.
//
// These exist because damage no longer heals on its own. A handicap you
// wait out is not a cost — it costs patience, not skill. A handicap you
// have to drive somewhere to clear is a decision, and it is a decision
// with a price, because the orb is rarely on the line you would take.
//
// Placement is in track space (`s` along the centreline, lateral offset),
// which is the same coordinate everything else in this project uses. The
// alternative — world positions — would have to be re-authored for every
// track and would not survive a change to the spline.
//
// Collection is a proximity test in that same space rather than a physics
// sensor. A sensor collider would be woken, broad-phased and solved every
// step by Rapier for something that is two subtractions and a compare,
// and it would need collision groups to avoid the ghost car collecting
// orbs it cannot see.
// ---------------------------------------------------------------------

const REPAIR = "repair";
const BOOST = "boost";

const PICK_RADIUS_S = 3.2; // m along the track
const PICK_RADIUS_T = 2.4; // m across it
const RESPAWN_SECONDS = 12; // so a second lap is not a barren one
const HOVER = 1.15; // m above the road
const CORE_RADIUS = 0.85; // m — the gem at the centre
const RING_RADIUS = 1.3; // m — the portal ring standing round it

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qRing = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _sRing = new THREE.Vector3();
const _hidden = new THREE.Vector3(0, -9999, 0);
const RING_NORMAL = new THREE.Vector3(0, 0, 1); // RingGeometry's own local normal

let _ringGeo = null;
/** A flat annulus, shared by both pickup types (only the material differs). */
function ringGeometry() {
  return (_ringGeo ??= new THREE.RingGeometry(RING_RADIUS * 0.72, RING_RADIUS, 48, 1));
}

/**
 * The portal ring's material: additive, with a soft radial glow at each
 * edge and three points of brighter light drifting round it — an energy
 * ring, not a solid object. `vUv.y` is RingGeometry's own radial
 * coordinate (0 at the inner edge, 1 at the outer), `vUv.x` the angle.
 */
function ringMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uTime;
      void main() {
        float radial = smoothstep(0.0, 0.3, vUv.y) * (1.0 - smoothstep(0.7, 1.0, vUv.y));
        float pulse = 0.65 + 0.35 * sin(vUv.x * 18.8 - uTime * 2.6);
        float a = radial * pulse;
        gl_FragColor = vec4(uColor * 1.8 * a, a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}

/**
 * @param {object} track
 * @param {THREE.Scene} scene
 * @param {object} plan  { repair, boost } counts, or explicit `at` list.
 *   `boostSeconds`, if set, turns every boost orb into a clock bonus
 *   instead of a boost-charge refill — for a level raced against a
 *   countdown rather than against a field of other cars.
 */
export class Pickups {
  constructor(track, scene, plan = {}, eventBus = null) {
    this.track = track;
    this.scene = scene;
    this.items = [];
    this.time = 0;
    this.eventBus = eventBus;
    this.boostSeconds = plan.boostSeconds ?? null;

    const repairCount = plan.repair ?? 0;
    const boostCount = plan.boost ?? 0;
    if (repairCount + boostCount === 0) return;

    this.#place(REPAIR, repairCount, 0.0);
    this.#place(BOOST, boostCount, 0.5);

    // One InstancedMesh per type for the core, one more for its ring: a
    // lap's worth of orbs costs four draw calls, which is still what the
    // whole car costs after the merge pass. Saturated neon rather than the
    // muted green/cyan the gem alone used to be — a magic-portal glow,
    // not a scattered collectible.
    this.meshes = {
      [REPAIR]: this.#build(0x1aff8c, repairCount),
      [BOOST]: this.#build(0x1ad4ff, boostCount),
    };
  }

  /**
   * Spread `count` orbs around the lap, alternating which side of the
   * centreline they sit on.
   *
   * Deliberately NOT on the racing line. An orb you collect by driving
   * the fast line is a free gift; one a metre off it is a decision, and
   * on a track this width that is the whole mechanic.
   */
  #place(kind, count, phase) {
    const L = this.track.length;
    for (let i = 0; i < count; i++) {
      const s = ((i + phase) / count) * L;
      const lateral = (i % 2 === 0 ? -1 : 1) * (2.6 + (i % 3) * 0.9);
      this.items.push({ kind, s, lateral, active: true, takenAt: 0, index: i });
    }
  }

  /** The core gem and its portal ring, as a pair of InstancedMeshes. */
  #build(color, count) {
    if (count === 0) return null;
    const geo = new THREE.IcosahedronGeometry(CORE_RADIUS, 1);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 2.4,
      roughness: 0.2,
      metalness: 0.1,
    });
    const core = new THREE.InstancedMesh(geo, mat, count);
    core.frustumCulled = false; // they ring the whole track
    core.castShadow = false;
    // Off the minimap: at 260 m span a ring of orbs is a dotted line that
    // hides the road and the cars, which is what the map is for.
    core.layers.disable(MINIMAP_LAYER);
    this.scene.add(core);
    this.track.objects.push(core); // disposed with the track

    const ring = new THREE.InstancedMesh(ringGeometry(), ringMaterial(color), count);
    ring.frustumCulled = false;
    ring.castShadow = false;
    ring.layers.disable(MINIMAP_LAYER);
    this.scene.add(ring);
    this.track.objects.push(ring);

    return { core, ring };
  }

  /**
   * Check every car against every orb. Called once per fixed step.
   *
   * @param {Array} cars  entries with { vehicle } — the field, plus nobody else
   */
  update(dt, cars) {
    this.time += dt;
    if (this.items.length === 0) return;
    const L = this.track.length;

    for (const item of this.items) {
      if (!item.active) {
        if (this.time - item.takenAt >= RESPAWN_SECONDS) item.active = true;
        continue;
      }
      for (const car of cars) {
        const v = car.vehicle;
        // Wrapped distance along the track, so an orb near the start line
        // is collectable from both sides of it.
        let ds = v.s - item.s;
        if (ds > L / 2) ds -= L;
        if (ds < -L / 2) ds += L;
        if (Math.abs(ds) > PICK_RADIUS_S) continue;
        if (Math.abs(v.lateralOffset - item.lateral) > PICK_RADIUS_T) continue;

        // A time-trial level (boostSeconds set) spends its boost orbs on
        // the clock instead: the car's boost charge is untouched, and the
        // race director adds the seconds once it hears the event below.
        const timeBonus = item.kind === BOOST ? this.boostSeconds : null;
        const amount = item.kind === REPAIR
          ? v.repair(CAR.repairPickup)
          : timeBonus !== null
            ? timeBonus
            : v.refillBoost(CAR.boostPickup);

        item.active = false;
        item.takenAt = this.time;
        this.eventBus?.emit("pickup-collected", {
          kind: item.kind,
          amount,
          timeBonus,
          car,
          vehicle: v,
          pickup: item,
        });
        break; // first car to reach it takes it
      }
    }
  }

  /** Pose the instances. Called once per rendered frame. */
  render() {
    if (this.items.length === 0) return;
    const fr = {};
    const counts = { [REPAIR]: 0, [BOOST]: 0 };
    for (const item of this.items) {
      const mesh = this.meshes[item.kind];
      if (!mesh) continue;
      const i = counts[item.kind]++;
      if (!item.active) {
        // Parked far below the world rather than scaled to zero: a zero
        // scale still costs the same instance slot but produces degenerate
        // normals, and three warns about the bounding sphere.
        _m.compose(_hidden, _q, _s);
        mesh.core.setMatrixAt(i, _m);
        mesh.ring.setMatrixAt(i, _m);
        continue;
      }
      this.track.frameAt(item.s, fr);
      _v.copy(fr.position)
        .addScaledVector(fr.right, item.lateral)
        .addScaledVector(fr.up, HOVER + Math.sin(this.time * 2.4 + item.index) * 0.12);
      _q.setFromAxisAngle(UP, this.time * 1.6 + item.index);
      _m.compose(_v, _q, _s);
      mesh.core.setMatrixAt(i, _m);

      // The ring stands facing down the track, like a portal the car
      // drives through, and breathes gently rather than holding still.
      _qRing.setFromUnitVectors(RING_NORMAL, fr.tangent);
      const breathe = 1 + Math.sin(this.time * 1.8 + item.index * 1.7) * 0.08;
      _sRing.setScalar(breathe);
      _m.compose(_v, _qRing, _sRing);
      mesh.ring.setMatrixAt(i, _m);
    }
    for (const k of [REPAIR, BOOST]) {
      const mesh = this.meshes[k];
      if (!mesh) continue;
      mesh.core.instanceMatrix.needsUpdate = true;
      mesh.ring.instanceMatrix.needsUpdate = true;
      mesh.ring.material.uniforms.uTime.value = this.time;
    }
  }

  /** How many of each are currently on the road — for the HUD and tests. */
  get available() {
    let repair = 0;
    let boost = 0;
    for (const i of this.items) {
      if (!i.active) continue;
      if (i.kind === REPAIR) repair++;
      else boost++;
    }
    return { repair, boost };
  }
}

const UP = new THREE.Vector3(0, 1, 0);
