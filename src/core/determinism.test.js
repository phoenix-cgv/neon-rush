import test from "node:test";
import assert from "node:assert/strict";
import { Recorder, KEY_EVERY } from "./determinism.js";

const fakeVehicle = (x) => ({
  captureState: () => ({ t: [x, 0.123456789, 0], q: [0, 0, 0, 1], spin: [1.00004, 2], gear: 1 }),
});
const ctl = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false, pitch: 0, roll: 0 };

test("a snapshot is kept once per second of recording, keyed by frame", () => {
  const r = new Recorder();
  r.begin(fakeVehicle(0));
  for (let i = 0; i < KEY_EVERY * 2 + 5; i++) {
    r.snapshot(fakeVehicle(i));
    r.capture(ctl);
  }
  const rec = r.end();
  assert.deepEqual(Object.keys(rec.keys).map(Number), [KEY_EVERY, KEY_EVERY * 2]);
  // the snapshot taken before frame 60 is the state with x = 60
  assert.equal(rec.keys[KEY_EVERY].t[0], KEY_EVERY);
});

test("snapshots are rounded so a lap stays small in localStorage", () => {
  const r = new Recorder();
  r.begin(fakeVehicle(0));
  for (let i = 0; i <= KEY_EVERY; i++) {
    r.snapshot(fakeVehicle(1));
    r.capture(ctl);
  }
  const k = r.end().keys[KEY_EVERY];
  assert.equal(k.t[1], 0.1235);
  assert.equal(k.spin[0], 1);
});

test("nothing is snapshotted before the lap starts", () => {
  const r = new Recorder();
  r.snapshot(fakeVehicle(0));
  r.begin(fakeVehicle(0));
  assert.deepEqual(r.end().keys, {});
});
