import test from "node:test";
import assert from "node:assert/strict";

import { Progress } from "./progress.js";

const track = {
  length: 400,
  width: 16,
  runoffHalfWidth: 24,
  checkpoints: [0, 100, 200, 300].map((s, index) => ({ index, s })),
  checkpointIndexAt(s) {
    const wrapped = ((s % this.length) + this.length) % this.length;
    return Math.floor(wrapped / 100);
  },
  killPlaneAt() {
    return -10;
  },
  spawnAt(s) {
    return { s };
  },
};

function vehicle(s, lateralOffset = 0) {
  return {
    s,
    lateralOffset,
    speed: 20,
    grounded: true,
    scrapingWall: false,
    beached: 0,
    inPit: false,
    body: { translation: () => ({ y: 0 }) },
  };
}

test("counts only an ordered forward crossing through the checkpoint gate", () => {
  const progress = new Progress(track);
  progress.markProgressFrom(90);

  progress.update(1 / 60, vehicle(101, 0));

  assert.equal(progress.lastCheckpoint, 1);
  assert.equal(progress.nextCheckpoint, 2);
  assert.deepEqual(progress.consumeEvents().map((event) => event.type), ["checkpoint"]);
});

test("reports a missed checkpoint when crossing outside the road-width gate", () => {
  const progress = new Progress(track);
  progress.markProgressFrom(90);

  progress.update(1 / 60, vehicle(101, 12));

  assert.equal(progress.lastCheckpoint, 0);
  assert.equal(progress.missedCheckpoint, 1);
  assert.deepEqual(progress.consumeEvents().map((event) => event.type), ["checkpoint-missed"]);
});

test("counts a checkpoint crossed on the pit road despite its huge lateral offset", () => {
  // The pit road runs several metres out from the centreline, and
  // PitLane.constrain projects the car onto the main track from there —
  // vehicle.lateralOffset while inPit is routinely far outside any gate.
  // Grand Prix's pit lane happens to run alongside the main straight
  // through s = 0, so a pitting car sweeps across the start/finish
  // checkpoint while still reading that offset.
  const progress = new Progress(track);
  progress.markProgressFrom(90);

  const v = vehicle(101, 12);
  v.inPit = true;
  progress.update(1 / 60, v);

  assert.equal(progress.lastCheckpoint, 1);
  assert.equal(progress.missedCheckpoint, null);
  assert.deepEqual(progress.consumeEvents().map((event) => event.type), ["checkpoint"]);
});

test("raises and clears wrong-way state from sustained reverse travel", () => {
  const progress = new Progress(track, { wrongWayDelay: 0.5 });
  progress.markProgressFrom(150);

  for (const s of [148, 146, 144, 142]) progress.update(0.2, vehicle(s));
  assert.equal(progress.wrongWay, true);
  assert.equal(progress.consumeEvents().at(-1)?.type, "wrong-way");

  for (const s of [144, 146, 148, 150]) progress.update(0.2, vehicle(s));
  assert.equal(progress.wrongWay, false);
  assert.equal(progress.consumeEvents().at(-1)?.type, "right-way");
});