import test from "node:test";
import assert from "node:assert/strict";

import { RaceDirector } from "./race-director.js";

function makeRace() {
  const player = {
    isPlayer: true,
    name: "You",
    colour: 0xffffff,
    progress: { lap: 1, respawns: 0 },
    vehicle: { damage: 0 },
  };
  const rival = {
    isPlayer: false,
    name: "Rival",
    colour: 0xff0000,
    progress: { lap: 1, respawns: 0 },
  };
  return {
    cars: [player, rival],
    player,
    standings: [player, rival],
    frozen: false,
    autopilotCalls: 0,
    autopilotPlayer() {
      this.autopilotCalls++;
    },
  };
}

test("publishes a win when the player takes the flag first", () => {
  const race = makeRace();
  const director = new RaceDirector(race, { laps: 1 });
  director.state = "racing";
  race.frozen = false;
  race.player.progress.lap = 2;

  director.step(1);

  assert.equal(director.state, "finished");
  assert.equal(director.outcome, "won");
  assert.equal(director.reason, "finished-first");
  assert.equal(race.autopilotCalls, 1);
  assert.equal(director.consumeEvents().at(-1)?.type, "race-won");
});

test("publishes a loss when the configured race time expires", () => {
  const race = makeRace();
  const director = new RaceDirector(race, { laps: 3, timeLimit: 10 });
  director.state = "racing";
  race.frozen = false;

  director.step(10);

  assert.equal(director.state, "finished");
  assert.equal(director.outcome, "lost");
  assert.equal(director.reason, "time-limit");
  assert.equal(director.consumeEvents().at(-1)?.type, "race-lost");

  race.player.progress.lap = 4;
  director.step(1);
  assert.equal(director.results().find((result) => result.isPlayer).finished, false);
});

test("addTime pushes the deadline back instead of ending the race", () => {
  const race = makeRace();
  const director = new RaceDirector(race, { laps: 1, timeLimit: 10 });
  director.state = "racing";
  race.frozen = false;

  director.step(9);
  director.addTime(5);
  assert.equal(director.timeLimit, 15);
  assert.equal(director.consumeEvents().at(-1)?.type, "time-added");

  director.step(5); // 14 s elapsed, still under the extended 15 s
  assert.equal(director.state, "racing");

  director.step(1); // 15 s elapsed: the extended deadline now expires
  assert.equal(director.state, "finished");
  assert.equal(director.reason, "time-limit");
});

test("addTime does nothing once the race is already decided", () => {
  const race = makeRace();
  const director = new RaceDirector(race, { laps: 3, timeLimit: 10 });
  director.state = "racing";
  race.frozen = false;

  director.step(10); // times out
  assert.equal(director.state, "finished");

  director.addTime(5);
  assert.equal(director.timeLimit, 10);
});

test("publishes a loss when the player's car is wrecked", () => {
  const race = makeRace();
  const director = new RaceDirector(race, { laps: 3 });
  director.state = "racing";
  race.frozen = false;

  race.player.vehicle.damage = 0.6;
  director.step(1);
  assert.equal(director.state, "racing"); // damaged, but not wrecked yet

  race.player.vehicle.damage = 1;
  director.step(1);

  assert.equal(director.state, "finished");
  assert.equal(director.outcome, "lost");
  assert.equal(director.reason, "wrecked");
  assert.equal(director.consumeEvents().at(-1)?.type, "race-lost");
});

test("maxDamage: null turns the wreck check off", () => {
  const race = makeRace();
  const director = new RaceDirector(race, { laps: 3, maxDamage: null });
  director.state = "racing";
  race.frozen = false;

  race.player.vehicle.damage = 1;
  director.step(1);

  assert.equal(director.state, "racing");
});