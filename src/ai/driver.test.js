import test from "node:test";
import assert from "node:assert/strict";

import { wantsBoost } from "./driver.js";
import { CAR } from "../vehicle/config.js";

/**
 * Run the tank forward under a rule and count how often the decision
 * flips. The real rates: boost drains, and the trickle refills, every
 * step either way.
 */
function flips(rule, seconds = 20) {
  const dt = 1 / 60;
  let charge = CAR.boostCapacity;
  let on = false;
  let changes = 0;
  for (let i = 0; i < seconds / dt; i++) {
    const want = rule(on, charge);
    if (want !== on) changes++;
    on = want;
    if (on) charge = Math.max(0, charge - CAR.boostDrainRate * dt);
    if (charge < CAR.boostCapacity) {
      charge = Math.min(CAR.boostCapacity, charge + CAR.boostPassiveRegen * dt);
    }
  }
  return changes;
}

test("the AI's boost does not chatter the way a single threshold did", () => {
  // What it used to do: one line, crossed again as soon as it was crossed.
  const single = flips((on, charge) => charge > 25);
  assert.ok(single > 40, `a single threshold should chatter, got ${single} flips`);

  // What it does now.
  const hysteresis = flips((on, charge) => wantsBoost(on, charge));
  assert.ok(hysteresis <= 6, `hysteresis should settle, got ${hysteresis} flips in 20 s`);
});

test("a boost run starts only with a worthwhile tank and holds until spent", () => {
  assert.equal(wantsBoost(false, 44), false); // not yet worth starting
  assert.equal(wantsBoost(false, 46), true); // worth it now
  assert.equal(wantsBoost(true, 20), true); // mid run, keep going
  assert.equal(wantsBoost(true, 4), false); // spent
});
