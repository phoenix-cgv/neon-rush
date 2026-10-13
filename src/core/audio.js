// Procedural audio — no asset files. Music is a looping synth arpeggio,
// sound is an engine tone that follows speed plus UI blips. Browsers
// refuse to start an AudioContext before a user gesture, so everything
// is created lazily by unlock(), which the dashboard calls from a click.

const NOTES = [57, 60, 64, 67, 55, 59, 62, 65]; // Am – G-ish, MIDI
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.music = true;
    this.sound = true;
    this.step = 0;
    this.nextT = 0;
  }

  configure({ music, sound }) {
    this.music = music;
    this.sound = sound;
    if (this.master) this.#applyGains();
  }

  unlock() {
    if (this.ctx) return void this.ctx.resume?.();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      return;
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.connect(c.destination);
    this.musicGain = c.createGain();
    this.musicGain.connect(this.master);
    this.sfxGain = c.createGain();
    this.sfxGain.connect(this.master);

    // engine: detuned saw through a lowpass, pitch/volume driven by speed
    this.engine = c.createOscillator();
    this.engine.type = "sawtooth";
    this.engineFilter = c.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 400;
    this.engineGain = c.createGain();
    this.engineGain.gain.value = 0;
    this.engine.connect(this.engineFilter).connect(this.engineGain).connect(this.sfxGain);
    this.engine.start();

    this.nextT = c.currentTime + 0.1;
    this.#applyGains();
  }

  #applyGains() {
    const t = this.ctx.currentTime;
    this.musicGain.gain.setTargetAtTime(this.music ? 0.12 : 0, t, 0.05);
    this.sfxGain.gain.setTargetAtTime(this.sound ? 0.5 : 0, t, 0.05);
  }

  /** Call every frame. speed in m/s; engine silent when paused/menu. */
  update(speed, active) {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const k = Math.min(speed / 60, 1);
    this.engine.frequency.setTargetAtTime(42 + k * 110, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(300 + k * 900, t, 0.08);
    this.engineGain.gain.setTargetAtTime(active ? 0.05 + k * 0.1 : 0, t, 0.1);

    // schedule the arpeggio a little ahead of the clock
    while (this.nextT < t + 0.25) {
      if (this.music) this.#note(NOTES[this.step % NOTES.length], this.nextT);
      this.step++;
      this.nextT += 0.2;
    }
  }

  #note(midi, when) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "square";
    o.frequency.value = mtof(midi);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.5, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
    o.connect(g).connect(this.musicGain);
    o.start(when);
    o.stop(when + 0.2);
  }

  click() {
    if (!this.ctx || !this.sound) return;
    this.#log("click");
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "triangle";
    o.frequency.value = 660;
    g.gain.setValueAtTime(0.4, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.12);
    o.connect(g).connect(this.sfxGain);
    o.start();
    o.stop(c.currentTime + 0.13);
  }

  /**
   * Log a sound as it plays. Everything audible goes through here so the
   * console shows exactly what the game asked for, in order, even where
   * the speakers say nothing.
   */
  #log(name, detail = "") {
    console.log(`[audio] ${name}${detail ? " " + detail : ""}`);
  }

  /**
   * Play a named sound made of one or more notes on the sfx bus. Returns
   * false (and logs why) when it cannot sound, so a silent sound is never
   * a silent log.
   */
  #play(name, notes) {
    if (!this.ctx) return void this.#log(name, "(skipped: audio not unlocked yet)");
    if (!this.sound) return void this.#log(name, "(skipped: Sound is off)");
    // A context can be suspended again after a tab switch or autoplay
    // policy; scheduling into a suspended clock plays nothing.
    if (this.ctx.state !== "running") this.ctx.resume?.();
    this.#log(name);
    for (const n of notes) this.#blip(n);
  }

  /**
   * One short synth note on the sfx bus. `freq` glides to `to` over `dur`;
   * `delay` offsets it so a few of these make an arpeggio or a stab.
   * Gain ramps start and end at 0.0001 (an exponential ramp cannot touch
   * 0), and the start time is never earlier than "now".
   */
  #blip({ type = "square", freq, to = freq, dur = 0.12, vol = 0.3, delay = 0 }) {
    const c = this.ctx;
    const t = Math.max(c.currentTime, c.currentTime + delay) + 0.005;
    const peak = Math.max(vol, 0.0002);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxGain);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Checkpoint passed: a quick bright two-note ping, rising. */
  checkpoint() {
    this.#play("checkpoint", [
      { type: "triangle", freq: mtof(81), dur: 0.09, vol: 0.5 },
      { type: "triangle", freq: mtof(88), dur: 0.16, vol: 0.5, delay: 0.07 },
    ]);
  }

  /** Checkpoint missed: a dull, falling buzz. */
  checkpointMissed() {
    this.#play("checkpoint-missed", [{ type: "sawtooth", freq: 220, to: 110, dur: 0.28, vol: 0.4 }]);
  }

  /** Lap complete: a fast rising major arpeggio. */
  lapComplete() {
    this.#play("lap-complete", [72, 76, 79, 84].map((m, i) =>
      ({ type: "square", freq: mtof(m), dur: 0.16, vol: 0.35, delay: i * 0.07 })));
  }

  /** Wrong way: two harsh low beeps, like an alarm. */
  wrongWay() {
    this.#play("wrong-way", [
      { type: "square", freq: 300, dur: 0.13, vol: 0.35 },
      { type: "square", freq: 300, dur: 0.13, vol: 0.35, delay: 0.17 },
    ]);
  }

  /** Boost on: a fast upward sweep, like a turbo kicking in. */
  boostStarted() {
    this.#play("boost-started", [{ type: "sawtooth", freq: 140, to: 900, dur: 0.4, vol: 0.35 }]);
  }

  /** Boost off: the same sweep in reverse and quieter, a hiss of lift-off. */
  boostStopped() {
    this.#play("boost-stopped", [{ type: "sawtooth", freq: 600, to: 120, dur: 0.28, vol: 0.2 }]);
  }

  /** Pickup: a sparkly high chirp that jumps an octave. */
  pickup() {
    this.#play("pickup", [
      { type: "sine", freq: mtof(88), to: mtof(100), dur: 0.14, vol: 0.5 },
      { type: "triangle", freq: mtof(100), dur: 0.14, vol: 0.35, delay: 0.06 },
    ]);
  }

  /** Lights out: one punchy, high "go" hit. */
  raceStarted() {
    this.#play("race-started", [
      { type: "square", freq: mtof(84), dur: 0.5, vol: 0.45 },
      { type: "sawtooth", freq: mtof(72), dur: 0.5, vol: 0.3 },
    ]);
  }

  /** Win: a short triumphant fanfare ending on a held chord. */
  raceWon() {
    this.#play("race-won", [
      ...[72, 72, 76, 79].map((m, i) => ({ type: "square", freq: mtof(m), dur: 0.15, vol: 0.35, delay: i * 0.12 })),
      ...[72, 76, 79, 84].map((m) => ({ type: "triangle", freq: mtof(m), dur: 0.7, vol: 0.3, delay: 0.5 })),
    ]);
  }

  /** Loss: a slow descending minor figure. */
  raceLost() {
    this.#play("race-lost", [67, 63, 60, 55].map((m, i) =>
      ({ type: "triangle", freq: mtof(m), dur: 0.24, vol: 0.4, delay: i * 0.16 })));
  }
}
