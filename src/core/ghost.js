import * as THREE from "three";
import { Vehicle } from "../vehicle/vehicle.js";
import { CarRig } from "../vehicle/car-rig.js";
import { ReplayController } from "./determinism.js";
import { AIController, PERSONALITIES } from "../ai/driver.js";
import { wrapDelta, lapDistance, shouldAutopilot } from "./ghost-logic.js";

// ---------------------------------------------------------------------
// Ghost: your own best lap, driving itself alongside you.
//
// The hard part of this was already built and verified — vehicle.js's
// `opts.ghost` flag puts the car on its own Rapier collision group (see
// the comment by GROUP.ghost there): it meets the same road, kerbs and
// barriers the recording did, but it can never touch the player, so a
// ghost that "wins" a corner cannot shove you off your own line. And
// determinism.js already has the Recorder/ReplayController pair, with
// a harness (verifyDeterminism) that proves a recording reproduces
// bit-faithfully — which is the only thing that makes replaying one
// worth doing at all. This module is just the wiring: a second Vehicle
// driven by canned controls instead of the keyboard, painted
// translucent so it's never mistaken for a rival.
//
// It is stepped and rendered exactly like a race car (savePreviousState
// before the solve, applySoftWall after, writeTransform/sync for
// render) — main.js just calls it alongside race.step()/race.render()
// rather than through race.cars, since it is not part of the race.
// ---------------------------------------------------------------------

const _side = new THREE.Vector3();
const HOLD = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, pitch: 0, roll: 0 };
const GHOST_PAINT = 0x7fe3ff;
const GHOST_OPACITY = 0.35;
// At the start the ghost sits this far to the player's right, so it can be
// seen beside the car rather than inside it, then eases into its true line.
// How far off its recorded line the ghost may drift before being put back.
const SNAP_DISTANCE = 0.5; // m
const START_OFFSET = 3.2; // m
const OFFSET_FADE = 8 * 60; // fixed steps of racing over which it closes

export class Ghost {
  /**
   * @param {object} RAPIER
   * @param {object} world
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {{start: object, frames: number[][]}} recording  from Recorder.end()
   */
  constructor(RAPIER, world, scene, track, recording) {
    this.world = world;
    this.scene = scene;

    const t = recording.start.t;
    this.vehicle = new Vehicle(RAPIER, world, new THREE.Vector3(t[0], t[1], t[2]), { ghost: true });
    this.vehicle.setTrack(track, recording.start.s);
    this.vehicle.restoreState(recording.start);
    this.vehicle.savePreviousState();

    this.recording = recording;
    this.track = track;

    // A ghost is its recording, but a recording cannot steer round
    // anything it did not meet the first time. When the replay stalls or
    // runs out before the line, the ghost drives itself home with the same
    // AI the Grand Prix rivals use, so it always reaches the finish.
    this.mode = "replay"; // replay -> ai -> home
    this.driver = new AIController(track, PERSONALITIES.clean, 11);
    this.stalledFor = 0;
    this.racedSteps = 0;
    this.lastS = recording.start.s;
    this.travelled = 0;
    const endKey = recording.keys?.[recording.frames.length];
    this.total = lapDistance(recording.start.s, endKey?.s ?? recording.start.s, track.length);
    this.replay = new ReplayController(recording);
    this.rig = new CarRig(GHOST_PAINT);
    this.#makeTranslucent();
    this.scene.add(this.rig.root);
    this.rig.sync(this.vehicle.state);
  }

  /** A see-through car reads as a ghost, not as another racer. */
  #makeTranslucent() {
    this.rig.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        m.transparent = true;
        m.opacity = Math.min(m.opacity, GHOST_OPACITY);
        m.depthWrite = false;
      }
    });
  }

  /**
   * One fixed step, before world.step() — like every other car. Held
   * still with zero controls until the lights go out, same as the real
   * field; past the end of the recording, ReplayController itself coasts
   * rather than holding the last input forever.
   */
  step(dt, racing) {
    const v = this.vehicle;
    if (!racing) {
      v.savePreviousState();
      v.step(dt, HOLD);
      return;
    }
    this.racedSteps++;

    // Distance covered round the lap, so "has it finished" does not depend
    // on where the recording happened to start.
    const L = this.track.length;
    this.travelled += wrapDelta(this.lastS, v.s, L);
    this.lastS = v.s;
    const home = this.travelled >= this.total - 2;

    if (this.mode === "replay") {
      // Back onto the recorded line if it has strayed (see KEY_EVERY).
      const key = this.recording.keys?.[this.replay.frame];
      if (key && this.replay.frame < this.recording.frames.length) {
        const t = v.body.translation();
        const off = Math.hypot(t.x - key.t[0], t.y - key.t[1], t.z - key.t[2]);
        if (off > SNAP_DISTANCE) v.restoreState(key);
      }
      // Stalled: crashed and not moving although the recording says it
      // should be on the throttle. Snapping back covers a hit it can recover
      // from; this covers one it cannot, and any ghost saved without
      // snapshots.
      const wantsGo = this.replay.frame > 90 && this.replay.controls.throttle > 0.3;
      this.stalledFor = wantsGo && Math.abs(v.speed) < 1.5 ? this.stalledFor + dt : 0;
      if (
        shouldAutopilot({
          stalledFor: this.stalledFor,
          replayDone: this.replay.finished,
          travelled: this.travelled,
          total: this.total,
        })
      ) {
        this.mode = "ai"; // the same driver the Grand Prix rivals use
      } else if (this.replay.finished && home) {
        this.mode = "home";
      }
    }
    if (this.mode === "ai" && home) this.mode = "home";

    v.savePreviousState();
    const controls =
      this.mode === "replay" ? this.replay.update()
      : this.mode === "ai" ? this.driver.update(v, dt, [])
      : HOLD; // home: coast to a stop past the line
    v.step(dt, controls);
  }

  /** After world.step(). */
  postStep() {
    this.vehicle.applySoftWall();
  }

  /** Render frame: alpha blends the last two physics poses. */
  render(alpha) {
    this.vehicle.writeTransform(alpha);
    this.rig.sync(this.vehicle.state);

    // Display only: the physics ghost keeps its exact recorded line.
    const t = Math.min(1, this.racedSteps / OFFSET_FADE);
    const k = 1 - t * t * (3 - 2 * t); // smoothstep, 1 -> 0
    if (k > 0.001) {
      _side.set(1, 0, 0).applyQuaternion(this.rig.root.quaternion);
      this.rig.root.position.addScaledVector(_side, START_OFFSET * k);
    }
  }

  dispose() {
    this.scene.remove(this.rig.root);
    this.world.removeRigidBody(this.vehicle.body);
  }
}
