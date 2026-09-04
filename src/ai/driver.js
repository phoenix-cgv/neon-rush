import * as THREE from "three";

// ---------------------------------------------------------------------
// An opponent driver.
//
// It produces the SAME control struct the player's keyboard produces —
// throttle, brake, steer, handbrake, boost — and the vehicle cannot tell
// the difference. That is the whole payoff of the interface decided in
// week one: opponents needed no changes to the physics at all.
//
// Two things follow from driving the same model as the player:
//
//   The opponents are beatable. They obey the same grip limits, so a
//   better line or a braver braking point actually wins.
//
//   They brake because the maths says they must. Target speed comes from
//   sqrt(mu * g / kappa) at their lookahead, read off the same spline the
//   player drives on — not from hand-placed brake markers.
//
// Personalities are PARAMETERS over this one controller, never separate
// code paths. A second implementation would be a second set of bugs.
// ---------------------------------------------------------------------

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _fr = {};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const PERSONALITIES = {
  clean: { grip: 1.02, aggression: 0.25, lineOffset: 0.0, wobble: 0.4, reaction: 0.30 },
  quick: { grip: 1.12, aggression: 0.45, lineOffset: -1.6, wobble: 0.3, reaction: 0.22 },
  blocker: { grip: 1.0, aggression: 0.85, lineOffset: 1.8, wobble: 0.5, reaction: 0.35 },
  wild: { grip: 1.18, aggression: 0.7, lineOffset: 2.6, wobble: 1.5, reaction: 0.45 },
  steady: { grip: 0.94, aggression: 0.2, lineOffset: -0.8, wobble: 0.6, reaction: 0.40 },
};

export class AIController {
  /**
   * @param {object} track
   * @param {object} personality  one of PERSONALITIES, or the same shape
   * @param {number} seed         so each car wobbles differently
   */
  constructor(track, personality = PERSONALITIES.clean, seed = 0) {
    this.track = track;
    this.p = { ...personality };
    this.seed = seed;
    this.controls = {
      throttle: 0, brake: 0, steer: 0,
      handbrake: false, boost: false, pitch: 0, roll: 0,
    };
    this.targetOffset = this.p.lineOffset;
    this.blocking = false;
    this._t = seed * 13.7;
  }

  /**
   * @param {Vehicle} car    the vehicle this controller drives
   * @param {number} dt
   * @param {object[]} field  every car in the race, for blocking decisions
   */
  update(car, dt, field = []) {
    const c = this.controls;
    const t = this.track;
    this._t += dt;

    // --- where to aim -------------------------------------------------
    // Lookahead grows with speed. Too short and the car saws at the wheel
    // on a straight; too long and it cuts every corner.
    const look = 9 + car.speed * 1.05;
    t.frameAt(car.s + look, _fr);

    // Drift the target line slowly rather than snapping to it, so a car
    // changing its mind does not twitch.
    let wantOffset = this.p.lineOffset;
    this.blocking = false;
    if (this.p.aggression > 0.5) {
      // Sit in front of whoever is close behind. Aggression decides how
      // far they will move to do it.
      const chaser = this.#closestBehind(car, field, 22);
      if (chaser) {
        wantOffset = clamp(chaser.lateralOffset, -t.width * 0.32, t.width * 0.32);
        this.blocking = true;
      }
    }
    // A little wander, so a field of AI cars does not drive as one object.
    wantOffset += Math.sin(this._t * 0.6 + this.seed) * this.p.wobble;
    this.targetOffset += (wantOffset - this.targetOffset) * clamp(dt / this.p.reaction, 0, 1);

    _aim.copy(_fr.position).addScaledVector(_fr.right, this.targetOffset);

    const rot = car.body.rotation();
    _q.set(rot.x, rot.y, rot.z, rot.w);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _fwd.set(0, 0, -1).applyQuaternion(_q);

    const tr = car.body.translation();
    _pos.set(tr.x, tr.y, tr.z);
    _aim.sub(_pos);
    _aim.y = 0;
    if (_aim.lengthSq() > 1e-6) _aim.normalize();

    c.steer = clamp(_aim.dot(_right) * 2.9, -1, 1);

    // --- how fast ------------------------------------------------------
    // Scan ahead for the tightest thing coming and slow for THAT, not for
    // where the car is now. A driver who brakes on the apex is too late.
    let vmax = Infinity;
    for (let a = 0; a <= 70; a += 10) {
      vmax = Math.min(vmax, t.cornerSpeedAt(car.s + look + a, 1.4 * this.p.grip));
    }
    vmax = Math.min(vmax, 62);

    const err = vmax - car.speed;
    c.throttle = err > 0 ? clamp(err * 0.45, 0, 1) : 0;
    c.brake = err < -1 ? clamp(-err * 0.28, 0, 1) : 0;

    // Boost on the exit of a corner, where it is worth most and least
    // likely to put the car in a wall.
    c.boost =
      car.boostCharge > 25 && err > 6 && Math.abs(c.steer) < 0.35 && car.grounded;

    // Recovery: pointing the wrong way or stopped against something.
    const wrongWay = _fwd.dot(_fr.tangent) < -0.2;
    if (wrongWay && car.speed < 8) {
      c.brake = 1; // reverse out
      c.throttle = 0;
      c.steer = clamp(-Math.sign(car.lateralOffset), -1, 1);
    }

    c.handbrake = false;
    c.pitch = 0;
    c.roll = 0;
    return c;
  }

  /** Nearest car within `range` metres behind this one, or null. */
  #closestBehind(car, field, range) {
    const L = this.track.length;
    let best = null;
    let bestGap = range;
    for (const other of field) {
      if (other === car) continue;
      let gap = car.s - other.s;
      while (gap > L / 2) gap -= L;
      while (gap < -L / 2) gap += L;
      if (gap > 0 && gap < bestGap) {
        bestGap = gap;
        best = other;
      }
    }
    return best;
  }
}
