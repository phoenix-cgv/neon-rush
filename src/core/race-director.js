// ---------------------------------------------------------------------
// The race director: start lights, a fixed number of laps, the flag.
//
// A Race on its own is an endless session — cars lap until the level is
// changed. This turns it into an event with a beginning and an end:
//
//   LIGHTS    the field is held on the grid (race.frozen). Five lamps
//             come on one per second, hold for a moment nobody can
//             predict, then all go out together: that is the start.
//   RACING    the race clock runs; a car that completes the last lap is
//             classified in the order it crossed the line.
//   FINISHED  the player has taken the flag. Their car is handed to the
//             AI for a cool-down lap and the rest of the field keeps
//             running, joining the classification as they finish.
//
// Stepped on the fixed step, before race.step(), so a car is never moved
// on the step the lights go out on and held on the next.
// ---------------------------------------------------------------------

const LAMP_EVERY = 1.0; // s between lamps
const LAMPS = 5;
const HOLD_MIN = 0.6; // s all five stay lit before they go out...
const HOLD_MAX = 1.8; // ...somewhere in here, so the start can't be timed

const LIT = { color: 0xff3322, emissive: 0xff1a0a, intensity: 3.2 };
const DARK = { color: 0x2a0806, emissive: 0x000000, intensity: 0 };

export class RaceDirector {
  /**
   * @param {object} race
   * @param {object} opts { laps, lamps: THREE.Mesh[] in the order they light }
   */
  constructor(race, { laps = 3, lamps = [] } = {}) {
    this.race = race;
    this.laps = laps;
    this.lamps = lamps;
    this.state = "lights";
    this.t = 0; // s since the level loaded
    this.hold = HOLD_MIN + Math.random() * (HOLD_MAX - HOLD_MIN);
    this.raceTime = 0; // s since the lights went out
    this.finished = []; // { car, time } in finishing order
    this.lampsLit = 0;
    this.race.frozen = true;
    this.#paintLamps(0);
  }

  /** Seconds since the start, or null before it. */
  get goneFor() {
    return this.state === "lights" ? null : this.raceTime;
  }

  step(dt) {
    this.t += dt;
    if (this.state === "lights") {
      const lit = Math.min(LAMPS, Math.floor(this.t / LAMP_EVERY));
      if (lit !== this.lampsLit) this.#paintLamps(lit);
      if (this.t >= LAMPS * LAMP_EVERY + this.hold) {
        this.#paintLamps(0); // lights out
        this.state = "racing";
        this.race.frozen = false;
      }
      return;
    }

    this.raceTime += dt;
    for (const c of this.race.cars) {
      if (c.progress.lap <= this.laps || this.finished.some((f) => f.car === c)) continue;
      this.finished.push({ car: c, time: this.raceTime });
      if (c.isPlayer) {
        this.state = "finished";
        this.race.autopilotPlayer();
      }
    }
  }

  /**
   * The classification: finishers in order, then everyone still running
   * in their current race order.
   * @returns {{ name, colour, isPlayer, finished, time, lap }[]}
   */
  results() {
    const done = this.finished.map((f) => ({
      name: f.car.name,
      colour: f.car.colour,
      isPlayer: f.car.isPlayer,
      finished: true,
      time: f.time,
      lap: this.laps,
    }));
    const running = (this.race.standings ?? this.race.cars)
      .filter((c) => !this.finished.some((f) => f.car === c))
      .map((c) => ({
        name: c.name,
        colour: c.colour,
        isPlayer: c.isPlayer,
        finished: false,
        time: null,
        lap: Math.max(1, Math.min(this.laps, c.progress.lap)),
      }));
    return done.concat(running);
  }

  /** The player's place in the classification (1-based). */
  get playerPosition() {
    return this.results().findIndex((r) => r.isPlayer) + 1;
  }

  #paintLamps(n) {
    this.lampsLit = n;
    this.lamps.forEach((m, i) => {
      const look = i < n ? LIT : DARK;
      m.material.color.setHex(look.color);
      m.material.emissive?.setHex(look.emissive);
      if ("emissiveIntensity" in m.material) m.material.emissiveIntensity = look.intensity;
    });
  }

  dispose() {
    this.#paintLamps(0);
    this.race.frozen = false;
  }
}
