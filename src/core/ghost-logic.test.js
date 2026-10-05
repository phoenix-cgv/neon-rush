import test from "node:test";
import assert from "node:assert/strict";
import { wrapDelta, lapDistance, shouldAutopilot } from "./ghost-logic.js";

test("wrapDelta takes the short way round the line", () => {
  assert.equal(wrapDelta(1200, 1240, 1250), 40);
  assert.equal(wrapDelta(1240, 5, 1250), 15);
  assert.equal(wrapDelta(5, 1240, 1250), -15);
  assert.equal(wrapDelta(100, 130, 1250), 30);
});

test("a lap from the grid is one full length", () => {
  assert.equal(lapDistance(0, 0, 1250), 1250);
  assert.equal(lapDistance(1245, 3, 1250), 1258); // 8 m of line-crossing is read as a full lap, not 8 m
});

test("a lap that began mid-track is shorter than a full length", () => {
  assert.equal(lapDistance(400, 2, 1250), 852);
});

test("autopilot: stalled or out of recording, but not when already home", () => {
  const base = { stalledFor: 0, replayDone: false, travelled: 500, total: 1250 };
  assert.equal(shouldAutopilot(base), false);
  assert.equal(shouldAutopilot({ ...base, stalledFor: 2.5 }), true);
  assert.equal(shouldAutopilot({ ...base, replayDone: true }), true);
  assert.equal(shouldAutopilot({ ...base, replayDone: true, travelled: 1249 }), false);
});
