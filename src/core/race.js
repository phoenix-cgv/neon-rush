import * as THREE from "three";
import { Vehicle } from "../vehicle/vehicle.js";
import { CarRig } from "../vehicle/car-rig.js";
import { Progress } from "./progress.js";
import { AIController, PERSONALITIES } from "../ai/driver.js";

// ---------------------------------------------------------------------
// The field: every car in the race, the player's included.
//
// One list, one loop. The player is entry 0 and is driven by the input
// module; the rest are driven by AIController. Nothing downstream knows
// or cares which is which, because both produce the same control struct.
//
// All cars are stepped BEFORE a single world.step(). Stepping one car and
// solving, then the next and solving again, would let the first car see a
// world the second had not moved in yet — the order of the list would
// change the outcome of a collision.
// ---------------------------------------------------------------------

const GRID_SPACING = 9; // metres between rows on the starting grid

// The player's automatic reset is far more patient than the AI's. An AI
// car that stops is always stuck, and a quick reset keeps the race going;
// a player who stops usually meant to, and being teleported for waiting
// behind traffic is infuriating. Falling off the map still resets at once,
// and R resets whenever the player likes.
const PLAYER_PATIENCE = {
  requireIntent: true, // stopped on purpose never counts
  stuckLimit: 10, // s trying to move at a crawl (AI: 4)
  progressWindow: 15, // s trying without getting 18 m further (AI: 6)
  offTrackLimit: 6, // off-course clock (AI: 3), so ~2 s beyond the runoff
  pinnedLimit: 6, // s grinding against a wall (AI: 2.5)
  beachedLimit: 3, // s on its body with no wheel down (AI: 1.2)
};
const GRID_STAGGER = 3.2; // lateral offset, alternating

// What every car is given while the field is held on the grid.
const HOLD = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, pitch: 0, roll: 0 };
const titleCase = (w) => w.charAt(0).toUpperCase() + w.slice(1);

const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Race {
  /**
   * @param {object} RAPIER
   * @param {object} world
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {number} opponents  how many AI cars
   */
  constructor(RAPIER, world, scene, track, opponents = 5) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.scene = scene;
    this.track = track;
    this.cars = [];

    const names = Object.keys(PERSONALITIES);
    // The player is white so damage reads on it; the opponents keep strong
    // hues so the field is still separable at a glance on the minimap.
    const colours = [0xeef1f2, 0xc0463a, 0xd9a13c, 0x6f4a9c, 0x3f8f4e, 0x1d7f8c];

    for (let i = 0; i <= opponents; i++) {
      // Grid: rows back from the line, staggered left and right.
      const s = track.spline.wrapS(-i * GRID_SPACING);
      const lateral = (i % 2 === 0 ? -1 : 1) * GRID_STAGGER;
      const pose = track.spawnAt(s, lateral);

      const vehicle = new Vehicle(RAPIER, world, pose.position);
      vehicle.body.setRotation(
        { x: pose.quaternion.x, y: pose.quaternion.y, z: pose.quaternion.z, w: pose.quaternion.w },
        true
      );
      vehicle.setTrack(track, s);

      const rig = new CarRig(colours[i % colours.length]);
      scene.add(rig.root);

      const progress = new Progress(track, i === 0 ? PLAYER_PATIENCE : {});
      progress.markProgressFrom(s);
      // Everyone but pole starts behind the line, on lap 0.
      if (i > 0) progress.startBehindLine();

      const isPlayer = i === 0;
      this.cars.push({
        index: i,
        isPlayer,
        name: isPlayer ? "You" : titleCase(names[(i - 1) % names.length]),
        colour: colours[i % colours.length],
        vehicle,
        rig,
        progress,
        grid: { s, lateral },
        controller: isPlayer
          ? null
          : new AIController(track, PERSONALITIES[names[(i - 1) % names.length]], i),
        slipstream: 0,
        position: i + 1,
      });
    }

    // Every car's chassis, so wall detection can tell a rival from a
    // barrier. Without this an opponent would be treated as a wall and
    // the anti-spin assist would fire on ordinary racing contact.
    for (const c of this.cars) Vehicle.registerChassis(c.vehicle.collider.handle);

    this.player = this.cars[0];

    // Set by a RaceDirector during the start lights: every car is held
    // still and nobody's progress clock runs, so the AI's quick stuck
    // reset cannot fire on a car that is simply waiting for the lights.
    this.frozen = false;
  }

  /**
   * Hand the player's car to the AI (a cool-down lap after the flag).
   * The player's controls are ignored from here on.
   */
  autopilotPlayer() {
    this.player.controller = new AIController(this.track, PERSONALITIES.clean, 0);
  }

  /**
   * Advance every controller and vehicle by one fixed step. The caller
   * runs world.step() afterwards, once, for the whole field.
   */
  step(dt, playerControls) {
    this.playerControls = playerControls; // read by postStep for the player's intent
    const vehicles = this.cars.map((c) => c.vehicle);
    this.#updateSlipstream();

    for (const c of this.cars) {
      const controls = this.frozen
        ? HOLD
        : c.controller
          ? c.controller.update(c.vehicle, dt, vehicles)
          : playerControls;
      c.vehicle.step(dt, controls);
    }
  }

  /** After world.step(): apply constraints and resolve progress. */
  postStep(dt) {
    for (const c of this.cars) {
      c.vehicle.applySoftWall();
      if (this.frozen) continue;
      const pc = this.playerControls;
      const trying = !c.isPlayer || !pc || pc.throttle > 0.05 || pc.brake > 0.05;
      if (c.progress.update(dt, c.vehicle, trying) === "respawn") {
        const pose = this.#clearRespawn(c);
        c.vehicle.reset(pose.position, 0);
        c.vehicle.body.setRotation(
          { x: pose.quaternion.x, y: pose.quaternion.y, z: pose.quaternion.z, w: pose.quaternion.w },
          true
        );
        c.vehicle.setTrack(this.track, c.vehicle.s);
        c.progress.markProgressFrom(c.vehicle.s);
      }
    }
    this.#updateStandings();
  }

  /** Pose every car's scene graph. alpha blends the last two physics steps. */
  render(alpha) {
    for (const c of this.cars) {
      c.vehicle.writeTransform(alpha);
      c.rig.sync(c.vehicle.state);
    }
  }

  /**
   * A respawn slot with nobody already in it.
   *
   * Progress hands back the last checkpoint on the centreline, which is
   * correct for one car and wrong for six: two cars resetting near the
   * same place both get the same spot and are dropped inside each other.
   * Progress cannot fix this because it only ever sees its own car — the
   * field is the only thing that knows where everyone is.
   *
   * Tries the centreline first, then staggers sideways, then works back
   * up the track, so a car always reappears somewhere sensible.
   */
  #clearRespawn(car) {
    const cp = this.track.checkpoints[car.progress.lastCheckpoint];
    const slots = [0, -3.4, 3.4, -6.6, 6.6];
    // Reach further back than the old five rows. A pile-up puts several
    // cars near one checkpoint at once, and the previous fallback — drop
    // it on the checkpoint regardless — placed them INSIDE each other,
    // which wedges the field and triggers the next respawn immediately.
    // That is the loop, and it feeds itself: every give-up makes the
    // next respawn more likely to give up too.
    for (let back = 0; back < 14; back++) {
      const s = this.track.spline.wrapS(cp.s - back * 9);
      for (const lat of slots) {
        const pose = this.track.spawnAt(s, lat);
        if (this.#slotIsFree(pose.position, car)) return pose;
      }
    }
    // Still nothing after 126 m of track: take the emptiest slot we saw
    // rather than a guaranteed overlap.
    let best = null;
    let bestGap = -1;
    for (let back = 0; back < 14; back++) {
      const s = this.track.spline.wrapS(cp.s - back * 9);
      for (const lat of slots) {
        const pose = this.track.spawnAt(s, lat);
        const gap = this.#nearestCar(pose.position, car);
        if (gap > bestGap) {
          bestGap = gap;
          best = pose;
        }
      }
    }
    return best ?? this.track.spawnAt(cp.s, 0);
  }

  /** Distance to the closest other car, so a fallback can pick the least bad slot. */
  #nearestCar(pos, self) {
    let best = Infinity;
    for (const c of this.cars) {
      if (c === self) continue;
      const t = c.vehicle.body.translation();
      const dx = t.x - pos.x;
      const dz = t.z - pos.z;
      best = Math.min(best, Math.hypot(dx, dz));
    }
    return best;
  }

  #slotIsFree(pos, self) {
    for (const c of this.cars) {
      if (c === self) continue;
      const t = c.vehicle.body.translation();
      const dx = t.x - pos.x;
      const dz = t.z - pos.z;
      if (dx * dx + dz * dz < CLEARANCE * CLEARANCE) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------
  /**
   * Drag reduction for a car sitting in another's wake.
   *
   * The overtake is then a physical consequence rather than a scripted
   * event, and it forces a real decision: the tow is strongest exactly
   * where a mistake is most expensive, right behind someone at speed.
   */
  #updateSlipstream() {
    const L = this.track.length;
    for (const c of this.cars) {
      let best = 0;
      for (const o of this.cars) {
        if (o === c) continue;
        let gap = o.vehicle.s - c.vehicle.s; // positive = they are ahead
        while (gap > L / 2) gap -= L;
        while (gap < -L / 2) gap += L;
        if (gap <= 1 || gap > SLIP_RANGE) continue;
        const lateral = Math.abs(o.vehicle.lateralOffset - c.vehicle.lateralOffset);
        if (lateral > SLIP_WIDTH) continue;

        // Strongest just behind the car ahead, fading with both distance
        // and how far off their line you are.
        const byGap = 1 - (gap - 1) / (SLIP_RANGE - 1);
        const byLine = 1 - lateral / SLIP_WIDTH;
        best = Math.max(best, byGap * byLine);
      }
      c.slipstream = best;
      c.vehicle.dragScale = 1 - SLIP_MAX * best;
    }
  }

  /** Race order by total distance covered: laps plus distance into this one. */
  #updateStandings() {
    const ranked = [...this.cars].sort(
      (a, b) =>
        b.progress.lap * this.track.length +
        b.vehicle.s -
        (a.progress.lap * this.track.length + a.vehicle.s)
    );
    ranked.forEach((c, i) => (c.position = i + 1));
    this.standings = ranked;
  }

  dispose() {
    for (const c of this.cars) {
      this.scene.remove(c.rig.root);
      Vehicle.unregisterChassis(c.vehicle.collider.handle);
      this.world.removeRigidBody(c.vehicle.body);
    }
    this.cars.length = 0;
  }
}

const CLEARANCE = 6.5; // m that must be free before a car respawns there
const SLIP_RANGE = 15; // m behind another car that the tow reaches
const SLIP_WIDTH = 2.2; // m off their line before it stops working
const SLIP_MAX = 0.4; // up to 40% less drag
