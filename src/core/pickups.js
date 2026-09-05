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

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _hidden = new THREE.Vector3(0, -9999, 0);

/**
 * @param {object} track
 * @param {THREE.Scene} scene
 * @param {object} plan  { repair, boost } counts, or explicit `at` list
 */
export class Pickups {
  constructor(track, scene, plan = {}) {
    this.track = track;
    this.scene = scene;
    this.items = [];
    this.time = 0;

    const repairCount = plan.repair ?? 0;
    const boostCount = plan.boost ?? 0;
    if (repairCount + boostCount === 0) return;

    this.#place(REPAIR, repairCount, 0.0);
    this.#place(BOOST, boostCount, 0.5);

    // One InstancedMesh per type: a lap's worth of orbs costs two draw
    // calls, which is what the whole car costs after the merge pass.
    this.meshes = {
      [REPAIR]: this.#build(0x46d08a, 0x1b6a44, repairCount),
      [BOOST]: this.#build(0x35bcd8, 0x115a6c, boostCount),
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

  #build(color, emissive, count) {
    if (count === 0) return null;
    const geo = new THREE.IcosahedronGeometry(0.62, 1);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity: 1.5,
      roughness: 0.25,
      metalness: 0.1,
    });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.frustumCulled = false; // they ring the whole track
    inst.castShadow = false;
    // Off the minimap: at 260 m span a ring of orbs is a dotted line that
    // hides the road and the cars, which is what the map is for.
    inst.layers.disable(MINIMAP_LAYER);
    this.scene.add(inst);
    this.track.objects.push(inst); // disposed with the track
    return inst;
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

        if (item.kind === REPAIR) v.repair(CAR.repairPickup);
        else v.refillBoost(CAR.boostPickup);

        item.active = false;
        item.takenAt = this.time;
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
        mesh.setMatrixAt(i, _m);
        continue;
      }
      this.track.frameAt(item.s, fr);
      _v.copy(fr.position)
        .addScaledVector(fr.right, item.lateral)
        .addScaledVector(fr.up, HOVER + Math.sin(this.time * 2.4 + item.index) * 0.12);
      _q.setFromAxisAngle(UP, this.time * 1.6 + item.index);
      _m.compose(_v, _q, _s);
      mesh.setMatrixAt(i, _m);
    }
    for (const k of [REPAIR, BOOST]) {
      if (this.meshes[k]) this.meshes[k].instanceMatrix.needsUpdate = true;
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
