import * as THREE from "three";
import { Vehicle } from "../vehicle/vehicle.js";
import { CarRig } from "../vehicle/car-rig.js";
import { Recorder, ReplayController } from "./determinism.js";
import { Save } from "./save.js";
import { MINIMAP_LAYER } from "../ui/minimap.js";

// ---------------------------------------------------------------------
// The ghost car.
//
// Your best lap, driving alongside you. It is the payoff for the
// determinism work rather than a separate feature: the recording is six
// bytes of CONTROLS per frame, not a list of positions, so the ghost is
// only in the right place because the simulation reproduces exactly from
// the same inputs. A replay that drifts is not a ghost, it is a lie —
// which is why verifyDeterminism exists and why this file can be short.
//
// The ghost is a third caller of an interface that already existed. It
// produces the same control struct the keyboard and the AI produce, and
// steps the same Vehicle class, so nothing downstream needs to know it is
// not a real car.
//
// What it must NOT do is race. It shares the track — it has to, or the
// replay meets different geometry than the recording did — but it cannot
// touch another car. That separation is done with Rapier interaction
// groups inside Vehicle rather than here.
// ---------------------------------------------------------------------

const OPACITY = 0.34;

export class Ghost {
  /**
   * @param {object} RAPIER
   * @param {object} world
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {string} levelName  records are stored per level
   * @param {boolean} replayable  false on a level with opponents
   */
  constructor(RAPIER, world, scene, track, levelName, replayable = true) {
    this.world = world;
    this.scene = scene;
    this.track = track;
    this.levelName = levelName;
    this.replayable = replayable;

    this.recorder = new Recorder();
    this.replay = null;
    this.vehicle = null;
    this.rig = null;
    this.running = false;

    const stored = Save.record(levelName);
    this.bestLap = stored.bestLap;

    // A lap is only replayable if nothing outside the recording shaped
    // it. In a race it was shaped by slipstream and by contact with
    // cars the ghost deliberately cannot touch, so the replay meets a
    // different world than the recording did and drifts: measured on
    // the six-car circuit, a lap that covered 1248 m replayed to 769 m
    // and stopped against a barrier. The same recording on the solo
    // level replays the full 1338 m lap and finishes 2.75 m from the
    // line.
    //
    // So the best lap is still RECORDED everywhere — the time is real
    // whatever the traffic did — but the car is only DRAWN where the
    // replay is faithful. Showing a drifting ghost labelled as your
    // best lap would be showing a lap nobody drove.
    if (replayable && stored.ghost && stored.ghost.frames?.length) {
      this.#build(RAPIER, stored.ghost);
    }
  }

  #build(RAPIER, recording) {
    const pose = this.track.spawnAt(0, 0);
    this.vehicle = new Vehicle(RAPIER, this.world, pose.position, { ghost: true });
    this.vehicle.setTrack(this.track, 0);

    this.rig = new CarRig(0x8fd8e4);
    // Translucent, and it never writes depth: a solid car you cannot hit
    // reads as a bug, and one that occludes the track you are trying to
    // drive is worse than not having it.
    this.rig.root.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      o.material = mats.map((m) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = OPACITY;
        c.depthWrite = false;
        return c;
      });
      if (!Array.isArray(o.material)) o.material = o.material[0];
      o.castShadow = false;
      o.renderOrder = 2;
    });
    // Off the minimap: two overlapping blips on the same racing line are
    // unreadable, and the ghost is not someone you can crash into.
    this.rig.root.traverse((o) => o.layers.disable(MINIMAP_LAYER));
    this.scene.add(this.rig.root);

    this.replay = new ReplayController(recording);
    this.recording = recording;
  }

  get hasGhost() {
    return this.replay !== null;
  }

  /** Start (or restart) both the recording and the replay from the line. */
  restart(vehicle) {
    this.recorder.begin(vehicle);
    if (this.replay) {
      this.replay.reset(this.vehicle);
      this.vehicle.setTrack(this.track, this.vehicle.s);
      this.running = true;
    }
  }

  /**
   * One fixed step. Call between the field's step and world.step(), so
   * the ghost is integrated by the same solve as everything else.
   */
  step(dt, playerControls) {
    this.recorder.capture(playerControls);
    if (!this.running || !this.replay) return;
    if (this.replay.finished) {
      this.running = false;
      // Park it rather than leave it coasting into a barrier at the end
      // of a recording that stopped at the line.
      this.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }
    this.vehicle.savePreviousState();
    this.vehicle.step(dt, this.replay.update());
  }

  /** After world.step(), matching what Race does for real cars. */
  postStep() {
    if (this.running && this.vehicle) this.vehicle.applySoftWall();
  }

  render(alpha) {
    if (!this.vehicle || !this.rig) return;
    this.rig.root.visible = this.running;
    if (!this.running) return;
    this.vehicle.writeTransform(alpha);
    this.rig.sync(this.vehicle.state);
  }

  /**
   * A lap has just been completed. Store it if it is a new best, and
   * begin the next recording either way.
   *
   * @returns {boolean} true if this became the new best lap
   */
  completeLap(seconds, vehicle) {
    const taken = this.recorder.end();
    let improved = false;
    if (Number.isFinite(seconds) && seconds > 0 && taken.frames.length) {
      improved = Save.submitLap(this.levelName, seconds, taken);
      if (improved) this.bestLap = seconds;
    }
    this.recorder.begin(vehicle);
    // The stored ghost only changes on the NEXT load. Swapping it in mid
    // session would mean racing a ghost that started its lap at a
    // different moment than you did, which reads as it cheating.
    if (this.replay) {
      this.replay.reset(this.vehicle);
      this.vehicle.setTrack(this.track, this.vehicle.s);
      this.running = true;
    }
    return improved;
  }

  dispose() {
    if (this.vehicle) {
      this.world.removeRigidBody(this.vehicle.body);
      this.vehicle = null;
    }
    if (this.rig) {
      this.scene.remove(this.rig.root);
      this.rig = null;
    }
    this.replay = null;
    this.running = false;
  }
}
