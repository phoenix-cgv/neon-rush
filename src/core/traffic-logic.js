// The decisions behind civilian traffic, kept free of three.js and Rapier
// so they can be unit-tested: how hard to accelerate or brake given what is
// ahead, how far to look for corners, and when to steer round an obstacle.

/**
 * Intelligent Driver Model: one formula for free-road acceleration,
 * following a slower car, and braking for something stopped ahead.
 * Unlike "target = (gap - 9) * 0.6" it takes the closing speed into
 * account, so a car brakes early for something it is approaching fast
 * (an oncoming player) and eases off gently behind something slow.
 *
 * @param {number} v     my speed along my direction of travel, m/s
 * @param {number} v0    the speed I would like (cruise, or the corner limit)
 * @param {number} gap   bumper-to-bumper distance to the obstacle ahead, m (Infinity if none)
 * @param {number} vObs  the obstacle's speed along MY direction, m/s (negative = coming at me)
 * @returns {number} acceleration in m/s^2, clamped to [-maxBrake, accel]
 */
export function idmAccel(v, v0, gap, vObs = 0, o = {}) {
  const { accel = 2.5, comfort = 3.0, maxBrake = 8.0, headway = 1.5, minGap = 2.5 } = o;
  const free = 1 - Math.pow(v / Math.max(v0, 0.1), 4);
  let interaction = 0;
  if (Number.isFinite(gap)) {
    const dv = v - vObs; // closing speed
    const want = minGap + Math.max(0, v * headway + (v * dv) / (2 * Math.sqrt(accel * comfort)));
    interaction = Math.pow(want / Math.max(gap, 0.1), 2);
  }
  return Math.max(-maxBrake, Math.min(accel, accel * (free - interaction)));
}

/** How far ahead to read the road: stopping distance at a gentle brake, plus a margin. */
export function cornerLookahead(v, comfort = 2.5) {
  return Math.max(25, Math.min(80, (v * v) / (2 * comfort) + 12));
}

/**
 * Where, laterally, a car should be driving. Normally in its own lane;
 * but if a hazard (the player straying into its lane, a wreck) is ahead
 * and overlapping, it steers toward its own kerb instead of just stopping
 * dead in the player's path — an oncoming car that stops in the road is
 * a wall, one that tucks in to the side is traffic.
 *
 * Lateral values are offsets from the road centreline (+ = road right).
 *
 * @param {number} laneT      the lane centre this car normally uses
 * @param {number} lat        where the car is now
 * @param {{lat:number, gap:number}|null} hazard  nearest obstacle ahead, or null
 * @param {number} roadHalf   half the drivable width
 */
export function avoidanceTarget(laneT, lat, hazard, roadHalf, o = {}) {
  const { look = 40, maxShift = 2.3, overlap = 3.0, edgeMargin = 1.1 } = o;
  if (!hazard || hazard.gap > look || Math.abs(hazard.lat - lat) > overlap) return laneT;
  // Away from the hazard; if dead centre on it, toward the nearer kerb.
  const side = hazard.lat === lat ? Math.sign(laneT) || 1 : Math.sign(lat - hazard.lat);
  const urgency = 1 - Math.max(0, hazard.gap) / look; // 0 far .. 1 close
  const want = laneT + side * maxShift * Math.min(1, 0.4 + urgency);
  const limit = Math.max(0, roadHalf - edgeMargin);
  return Math.max(-limit, Math.min(limit, want));
}

/** Slew toward a target at a fixed rate, without overshoot. */
export function slew(current, target, rate, dt) {
  const d = target - current;
  const m = rate * dt;
  return Math.abs(d) <= m ? target : current + Math.sign(d) * m;
}
