import test from "node:test";
import assert from "node:assert/strict";
import { idmAccel, cornerLookahead, avoidanceTarget, slew } from "./traffic-logic.js";

test("free road: accelerates up to cruise and holds it", () => {
  assert.ok(idmAccel(0, 13, Infinity) > 2);
  assert.ok(Math.abs(idmAccel(13, 13, Infinity)) < 1e-9);
  assert.ok(idmAccel(15, 13, Infinity) < 0); // over the limit eases off
});

test("closing on a stopped obstacle brakes, harder the closer it is", () => {
  const far = idmAccel(13, 13, 60, 0);
  const near = idmAccel(13, 13, 15, 0);
  assert.ok(near < far);
  assert.ok(near < -3);
  assert.ok(idmAccel(13, 13, 1, 0) >= -8); // clamped to the emergency limit
});

test("an oncoming car brakes earlier than one following at the same speed", () => {
  assert.ok(idmAccel(12, 12, 40, -15) < idmAccel(12, 12, 40, 12));
});

test("following a car at the same speed at a comfortable gap is calm", () => {
  assert.ok(Math.abs(idmAccel(12, 12, 40, 12)) < 1);
});

test("a stopped car behind an obstacle does not creep into it", () => {
  assert.ok(idmAccel(0, 13, 1.5, 0) < 0.5);
});

test("corner lookahead grows with speed and is bounded", () => {
  assert.equal(cornerLookahead(0), 25);
  assert.ok(cornerLookahead(14) > cornerLookahead(8));
  assert.equal(cornerLookahead(100), 80);
});

test("avoidance: no hazard, or a far one, keeps the lane", () => {
  assert.equal(avoidanceTarget(3.5, 3.5, null, 7), 3.5);
  assert.equal(avoidanceTarget(3.5, 3.5, { lat: 3.5, gap: 90 }, 7), 3.5);
  assert.equal(avoidanceTarget(3.5, 3.5, { lat: -3.5, gap: 10 }, 7), 3.5); // other lane
});

test("avoidance: tucks toward its own kerb, away from the hazard", () => {
  const t = avoidanceTarget(3.5, 3.5, { lat: 2.5, gap: 12 }, 7);
  assert.ok(t > 3.5);
  const l = avoidanceTarget(-3.5, -3.5, { lat: -2.5, gap: 12 }, 7);
  assert.ok(l < -3.5);
});

test("avoidance: never crosses toward the centre, whichever side the hazard is on", () => {
  // hazard on the kerb side of an oncoming car: it must not slide inward
  assert.ok(avoidanceTarget(3.5, 3.5, { lat: 5.5, gap: 10 }, 7) >= 3.5);
  assert.ok(avoidanceTarget(-3.5, -3.5, { lat: -5.5, gap: 10 }, 7) <= -3.5);
});

test("avoidance: never leaves the road", () => {
  const t = avoidanceTarget(3.5, 3.5, { lat: 3.4, gap: 2 }, 7);
  assert.ok(t <= 7 - 1.1 + 1e-9);
  assert.ok(avoidanceTarget(-3.5, -3.5, { lat: -3.4, gap: 2 }, 7) >= -(7 - 1.1) - 1e-9);
});

test("slew moves at a fixed rate and lands exactly", () => {
  assert.equal(slew(0, 10, 2, 1), 2);
  assert.equal(slew(9.5, 10, 2, 1), 10);
  assert.equal(slew(0, -10, 2, 1), -2);
});
