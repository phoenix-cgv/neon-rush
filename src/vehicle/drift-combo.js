// The drift combo, as plain arithmetic so it can be tested without a car.
//
// A slide that is more than a twitch keeps the combo alive and its clock
// running; sitting out of a slide for too long, or touching a wall, ends
// it. The clock decides the title (DRIFTER, DRIFT MASTER, DRIFT KING,
// DRIFT GOD); the title decides how fast a slide fills the boost tank and
// how far the tank stretches. The stretched part stays for a while after
// the combo ends, then shrinks away.

/**
 * Advance the combo by one step. Mutates `s`:
 *   { chain, gap, tankExtra, extraHold }  (all start at 0)
 * @returns {{ tier: number, mult: number }}  tier is an index into `cfg.tiers`, or -1
 */
export function stepDrift(s, dt, { sliding, factor, wall }, cfg) {
  if (wall) {
    s.chain = 0;
    s.gap = cfg.gapReset;
  } else if (sliding && factor > 0.12) {
    s.chain += dt;
    s.gap = 0;
  } else {
    s.gap += dt;
    if (s.gap > cfg.gapReset) s.chain = 0;
  }

  let tier = -1;
  for (let i = 0; i < cfg.tiers.length; i++) if (s.chain >= cfg.tiers[i].at) tier = i;

  if (tier >= 0) {
    s.tankExtra = Math.max(s.tankExtra, cfg.tiers[tier].ext);
    s.extraHold = cfg.hold;
  } else if (s.extraHold > 0) {
    s.extraHold -= dt;
  } else if (s.tankExtra > 0) {
    s.tankExtra = Math.max(0, s.tankExtra - cfg.decay * dt);
  }
  return { tier, mult: tier >= 0 ? cfg.tiers[tier].mult : 1 };
}
