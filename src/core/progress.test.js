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

  // Already on the pit road, not entering it this frame — settles
  // wasInPit first, so the entry resync below doesn't fire and it's
  // genuinely the ordinary continuous crossing test (bypassing the
  // lateral gate for vehicle.inPit) being exercised, not that resync.
  const settling = vehicle(95, 12);
  settling.inPit = true;
  progress.update(1 / 60, settling);
  progress.consumeEvents();

  const v = vehicle(101, 12);
  v.inPit = true;
  progress.update(1 / 60, v);

  assert.equal(progress.lastCheckpoint, 1);
  assert.equal(progress.missedCheckpoint, null);
  assert.deepEqual(progress.consumeEvents().map((event) => event.type), ["checkpoint"]);
});

test("entering the pit road syncs checkpoints instead of measuring the jump as a drive", () => {
  // PitLane.constrain reassigns vehicle.s to its own tracking the frame a
  // car enters the pit road — not a continuous drive from the car's real
  // previous position. A jump big enough to span more than one checkpoint
  // only lets the ordinary crossing test register the first one it finds
  // (checkpoint 2 here): checkpoint 3 would be skipped, never counted as
  // passed OR missed, and the lap could never complete (visited.size
  // never reaches n). Entering the pit must resync past both at once.
  const progress = new Progress(track);
  progress.markProgressFrom(90);
  progress.update(1 / 60, vehicle(101, 0)); // ordinary crossing of checkpoint 1
  progress.consumeEvents();

  const v = vehicle(310, 12); // far out on the pit road
  v.inPit = true;
  progress.update(1 / 60, v);

  assert.equal(progress.lastCheckpoint, 3);
  assert.equal(progress.visited.size, 4);
  assert.equal(progress.missedCheckpoint, null);
  assert.deepEqual(progress.consumeEvents().map((event) => event.type), []);
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