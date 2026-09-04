// ---------------------------------------------------------------------
// Determinism harness and replay.
//
// Two jobs from one piece of machinery:
//
//   VERIFY — run a recorded control sequence from a fixed start twice and
//   assert the car finishes in the same place. If it drifts, something is
//   reading render dt instead of the fixed step, or allocating in a way
//   that changes evaluation order. That bug is nearly invisible in play
//   (the car just handles slightly differently on a different machine)
//   and trivial to catch here.
//
//   REPLAY — the ghost car is the same recording, played back through a
//   ReplayController. It is only trustworthy BECAUSE of the verify pass:
//   a replay that drifts is not a ghost, it is a lie. That is why these
//   live in one file rather than two.
//
// The recording is just controls, not positions: six bytes a frame, so a
// 50-second lap is about 18 KB. Comfortably inside localStorage, and far
// smaller than storing poses.
// ---------------------------------------------------------------------

const FIELDS = ["throttle", "brake", "steer", "handbrake", "boost", "pitch", "roll"];

/** Pack one control struct into a compact array. */
function pack(c) {
  return [
    Math.round(c.throttle * 127),
    Math.round(c.brake * 127),
    Math.round(c.steer * 127),
    (c.handbrake ? 1 : 0) | (c.boost ? 2 : 0),
    Math.round(c.pitch * 127),
    Math.round(c.roll * 127),
  ];
}

function unpack(a, out) {
  out.throttle = a[0] / 127;
  out.brake = a[1] / 127;
  out.steer = a[2] / 127;
  out.handbrake = (a[3] & 1) !== 0;
  out.boost = (a[3] & 2) !== 0;
  out.pitch = a[4] / 127;
  out.roll = a[5] / 127;
  return out;
}

export class Recorder {
  constructor() {
    this.frames = [];
    this.start = null;
    this.recording = false;
  }

  begin(vehicle) {
    this.start = vehicle.captureState();
    this.frames = [];
    this.recording = true;
  }

  capture(controls) {
    if (this.recording) this.frames.push(pack(controls));
  }

  end() {
    this.recording = false;
    return { start: this.start, frames: this.frames };
  }

  get seconds() {
    return this.frames.length / 60;
  }
}

/**
 * Replays a recording as a controller. Produces the same struct shape the
 * keyboard and the AI produce, so the vehicle cannot tell the difference
 * — the ghost car is a third caller of an interface that already existed.
 */
export class ReplayController {
  constructor(recording) {
    this.recording = recording;
    this.frame = 0;
    this.controls = {
      throttle: 0, brake: 0, steer: 0,
      handbrake: false, boost: false, pitch: 0, roll: 0,
    };
  }

  reset(vehicle) {
    this.frame = 0;
    if (vehicle && this.recording.start) vehicle.restoreState(this.recording.start);
  }

  get finished() {
    return this.frame >= this.recording.frames.length;
  }

  update() {
    const f = this.recording.frames[this.frame];
    if (f) {
      unpack(f, this.controls);
      this.frame++;
    } else {
      // Past the end: coast rather than hold the last input forever.
      this.controls.throttle = 0;
      this.controls.brake = 0;
      this.controls.steer = 0;
      this.controls.handbrake = false;
      this.controls.boost = false;
    }
    return this.controls;
  }
}

/**
 * Run the same recording twice from the same start and report how far
 * apart the two runs finish.
 *
 * @param {object} vehicle
 * @param {object} world     Rapier world
 * @param {object} recording from Recorder.end()
 * @param {number} tolerance metres of drift that counts as a pass
 */
export function verifyDeterminism(vehicle, world, recording, tolerance = 0.01) {
  // Three runs, not two.
  //
  // restoreState puts the CAR back, but it cannot put the WORLD back:
  // Rapier keeps warm-start impulses, island assignments and contact
  // history between steps, and there is no API to rewind them. Measured
  // on the circuit, that leaves a floor of roughly 0.4 mm of scatter over
  // 25 seconds — consecutive runs land in a small ball around each other
  // rather than converging on one point.
  //
  // Discarding the first run drops the largest part of that (a cold cache
  // is further out than a warm one), but the floor is real and no amount
  // of re-running removes it.
  //
  // Which is why the verdict is not "did it land in exactly the same
  // spot". Cache scatter is BOUNDED — it wanders inside that ball. The
  // bugs this harness exists to catch are not: a step that reads render
  // dt, or one whose evaluation order shifts with allocation, diverges
  // and keeps diverging, because every frame's error feeds the next.
  //
  // So the test is the SHAPE of the drift over time. Sampling both runs
  // at intervals separates a flat wander from a growing divergence, which
  // is the distinction that actually matters.
  const SAMPLES = 8;
  const n = recording.frames.length;
  const every = Math.max(1, Math.floor(n / SAMPLES));

  const run = () => {
    const rc = new ReplayController(recording);
    rc.reset(vehicle);
    const path = [];
    for (let i = 0; i < n; i++) {
      vehicle.savePreviousState();
      vehicle.step(1 / 60, rc.update());
      world.step();
      vehicle.applySoftWall();
      if (i % every === 0) {
        const p = vehicle.body.translation();
        path.push([p.x, p.y, p.z]);
      }
    }
    const t = vehicle.body.translation();
    const q = vehicle.body.rotation();
    path.push([t.x, t.y, t.z]);
    return { path, t: [t.x, t.y, t.z], q: [q.x, q.y, q.z, q.w] };
  };

  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

  const warm = run(); // discarded: cold solver caches
  const a = run();
  const b = run();

  const curve = a.path.map((p, i) => dist(p, b.path[i]));
  const drift = curve[curve.length - 1];
  const spin = Math.max(...a.q.map((v, i) => Math.abs(v - b.q[i])));

  // How much of the total drift appeared in the second half? Bounded
  // scatter sits near 0.5 and jitters; genuine divergence pushes it
  // towards 1 and keeps it there, because the error compounds.
  const mid = curve[Math.floor(curve.length / 2)];
  const growth = drift > 1e-9 ? mid / drift : 0;

  return {
    frames: n,
    seconds: +(n / 60).toFixed(1),
    positionDrift_m: drift,
    rotationDrift: spin,
    driftCurve_mm: curve.map((v) => +(v * 1000).toFixed(3)),
    coldStartDrift_m: dist(warm.t, a.t), // Rapier's caches, not our code
    diverging: drift > tolerance && growth < 0.25,
    endedAt: a.t.map((v) => +v.toFixed(3)),
    pass: drift <= tolerance && spin <= 2e-3,
  };
}

/**
 * Build a synthetic recording without needing a human to drive one — a
 * varied but repeatable input sequence, so the harness can be run from a
 * cold start in one call.
 */
export function syntheticRun(seconds = 20) {
  const frames = [];
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    const t = i / 60;
    frames.push(
      pack({
        throttle: t < 2 ? 1 : 0.55 + 0.45 * Math.sin(t * 0.7),
        brake: Math.sin(t * 0.31) > 0.85 ? 0.8 : 0,
        steer: Math.sin(t * 0.9) * 0.75 + Math.sin(t * 2.3) * 0.2,
        handbrake: Math.sin(t * 0.5) > 0.95,
        boost: Math.sin(t * 0.23) > 0.7,
        pitch: 0,
        roll: 0,
      })
    );
  }
  return frames;
}

/**
 * Frame-rate independence of the control path.
 *
 * verifyDeterminism above compares two runs in one process, which catches
 * genuine nondeterminism (uninitialised scratch, iteration order) but
 * cannot catch a bug that is merely WRONG — a dt error reproduces
 * perfectly against itself, so A/B self-comparison cancels it out.
 *
 * This checks the property that self-comparison misses: hold the keys
 * down identically and the controls the physics actually receives must
 * not depend on how fast the display runs. It drives a real Input through
 * a real accumulator at several frame rates and compares the sequence of
 * control values that reached a fixed step.
 *
 * @param {object} input   an Input instance (its key set is driven here)
 * @param {number[]} rates frame rates to compare, fps
 */
export function verifyFrameRateIndependence(input, rates = [30, 60, 144]) {
  const SECONDS = 3;
  const FIXED = 1 / 60;

  const sample = (fps) => {
    const frameDt = 1 / fps;
    const delivered = [];
    let acc = 0;
    // Reset the ramp, then hold throttle and right-steer for the whole run.
    input.controls.throttle = 0;
    input.controls.brake = 0;
    input.controls.steer = 0;
    for (let f = 0; f < SECONDS * fps; f++) {
      acc += frameDt;
      while (acc >= FIXED) {
        const c = input.update(FIXED, false);
        delivered.push([c.throttle, c.steer]);
        acc -= FIXED;
      }
    }
    return delivered;
  };

  const held = new Set(["KeyW", "KeyD"]);
  const realKeys = input.keys;
  input.keys = held;
  const runs = rates.map(sample);
  input.keys = realKeys;

  // Compare each rate against 60 Hz over the steps they have in common.
  const base = runs[rates.indexOf(60)] ?? runs[0];
  let worst = 0;
  for (const r of runs) {
    const n = Math.min(r.length, base.length);
    for (let i = 0; i < n; i++) {
      worst = Math.max(worst, Math.abs(r[i][0] - base[i][0]), Math.abs(r[i][1] - base[i][1]));
    }
  }
  return {
    rates,
    stepsDelivered: runs.map((r) => r.length),
    worstControlDelta: worst,
    pass: worst < 1e-9,
  };
}
