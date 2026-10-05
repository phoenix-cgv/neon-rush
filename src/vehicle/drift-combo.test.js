import test from "node:test";
import assert from "node:assert/strict";
import { stepDrift } from "./drift-combo.js";

const cfg = {
  tiers: [
    { name: "DRIFTER", at: 0.6, mult: 1, ext: 15 },
    { name: "DRIFT MASTER", at: 2.5, mult: 2, ext: 35 },
    { name: "DRIFT KING", at: 5.0, mult: 3, ext: 60 },
    { name: "DRIFT GOD", at: 8.5, mult: 5, ext: 100 },
  ],
  gapReset: 1.0,
  hold: 6,
  decay: 20,
};
const fresh = () => ({ chain: 0, gap: 0, tankExtra: 0, extraHold: 0 });
const slide = { sliding: true, factor: 0.6, wall: false };
const straight = { sliding: false, factor: 0, wall: false };
const run = (s, seconds, input) => {
  let r;
  for (let t = 0; t < seconds; t += 1 / 60) r = stepDrift(s, 1 / 60, input, cfg);
  return r;
};

test("a sustained slide climbs through the four titles in order, with the multipliers", () => {
  const s = fresh();
  assert.equal(run(s, 0.3, slide).tier, -1);
  let r = run(s, 0.5, slide);
  assert.deepEqual([r.tier, r.mult], [0, 1]);
  r = run(s, 2, slide);
  assert.deepEqual([r.tier, r.mult], [1, 2]);
  r = run(s, 2.6, slide);
  assert.deepEqual([r.tier, r.mult], [2, 3]);
  r = run(s, 3.6, slide);
  assert.deepEqual([r.tier, r.mult], [3, 5]);
});

test("a twitch (weak slip) does not build the combo", () => {
  const s = fresh();
  run(s, 3, { sliding: true, factor: 0.05, wall: false });
  assert.equal(s.chain, 0);
});

test("the tank stretches to the best title and the extension is kept after the combo", () => {
  const s = fresh();
  run(s, 3, slide); // DRIFT MASTER
  assert.equal(s.tankExtra, 35);
  run(s, 3, straight); // combo lost after the 1 s gap, but the tank is held for 6 s
  assert.equal(s.chain, 0);
  assert.equal(s.tankExtra, 35);
});

test("after the hold the extension shrinks away", () => {
  const s = fresh();
  run(s, 3, slide);
  run(s, 6, straight); // 6 s hold
  assert.equal(s.tankExtra, 35);
  run(s, 3, straight); // then 20/s decay: gone in under 2 s
  assert.equal(s.tankExtra, 0);
});

test("a short break keeps the combo; a long one, or a wall, ends it", () => {
  const s = fresh();
  run(s, 3, slide);
  const chain = s.chain;
  run(s, 0.5, straight);
  assert.ok(s.chain >= chain, "half a second out of the slide keeps the combo");
  run(s, 1, slide);
  run(s, 1.5, straight);
  assert.equal(s.chain, 0, "1.5 s out of the slide loses it");
  run(s, 3, slide);
  stepDrift(s, 1 / 60, { sliding: true, factor: 1, wall: true }, cfg);
  assert.equal(s.chain, 0, "a wall breaks it");
});

test("higher titles stretch the tank further", () => {
  const exts = [];
  for (const secs of [1, 3, 6, 10]) {
    const s = fresh();
    run(s, secs, slide);
    exts.push(s.tankExtra);
  }
  assert.deepEqual(exts, [15, 35, 60, 100]);
});
