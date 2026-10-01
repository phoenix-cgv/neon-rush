import test from "node:test";
import assert from "node:assert/strict";

import { RaceDirector } from "./race-director.js";

function makeRace() {
  const player = {
    isPlayer: true,
    name: "You",
    colour: 0xffffff,
    progress: { lap: 1, respawns: 0 },
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