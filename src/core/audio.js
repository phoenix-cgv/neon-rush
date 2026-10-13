// Procedural audio — no asset files. Music is a looping synth arpeggio,
// sound is an engine tone that follows speed plus UI blips. Browsers
// refuse to start an AudioContext before a user gesture, so everything
// is created lazily by unlock(), which the dashboard calls from a click.

// Arpeggios, MIDI. "day" is the original; "night" (Grand Prix) is lower,
// faster and minor, with a driving bass pulse under it.
const MUSIC = {
  day: { notes: [57, 60, 64, 67, 55, 59, 62, 65], stepSec: 0.2, bass: false },
  night: { notes: [45, 57, 48, 57, 43, 55, 46, 55], stepSec: 0.14, bass: true },
};
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.music = true;
    this.sound = true;
    this.step = 0;
    this.nextT = 0;
    this.squealing = false; // for logging the on/off edge only
    this.levelName = null;
    this.lastCrash = -1; // when the last crash sounded, and how hard
    this.lastCrashK = 0;
    this.musicStyle = "day";
    this.amb = null; // the current level's ambience: { name, gain, stop, update }
    this.opponents = []; // Grand Prix: one engine voice per AI car
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
    // Everything meets at master, then a compressor that acts as a limiter:
    // loud moments (a crash over a fanfare over the engine) are pulled down
    // together instead of clipping.
    this.master = c.createGain();
    this.master.gain.value = 0.8;
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -12;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.2;
    this.master.connect(this.limiter).connect(c.destination);
    this.musicGain = c.createGain();
    this.musicGain.connect(this.master);
    this.sfxGain = c.createGain();
    this.sfxGain.connect(this.master);

    // engine: two detuned saws and a sub-octave triangle through one
    // lowpass; pitch/volume follow speed. The detune beats against itself,
    // which is most of what makes it sound like a motor and not a tone.
    this.engine = c.createOscillator();
    this.engine.type = "sawtooth";
    this.engine2 = c.createOscillator();
    this.engine2.type = "sawtooth";
    this.engine2.detune.value = 18; // cents
    this.engineSub = c.createOscillator();
    this.engineSub.type = "triangle";
    const subGain = c.createGain();
    subGain.gain.value = 0.7;
    this.engineFilter = c.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 400;
    this.engineGain = c.createGain();
    this.engineGain.gain.value = 0;
    this.engine.connect(this.engineFilter);
    this.engine2.connect(this.engineFilter);
    this.engineSub.connect(subGain).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.sfxGain);
    this.engine.start();
    this.engine2.start();
    this.engineSub.start();

    // One second of white noise, looped by every noise sound. Built once.
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // tyre squeal: looping noise through a bandpass, silent until drifting
    this.squealSrc = c.createBufferSource();
    this.squealSrc.buffer = this.noise;
    this.squealSrc.loop = true;
    this.squealFilter = c.createBiquadFilter();
    this.squealFilter.type = "bandpass";
    this.squealFilter.frequency.value = 1800;
    this.squealFilter.Q.value = 7;
    this.squealGain = c.createGain();
    this.squealGain.gain.value = 0;
    this.squealSrc.connect(this.squealFilter).connect(this.squealGain).connect(this.sfxGain);
    this.squealSrc.start();

    // Level ambience sits on its own bus under the sfx bus, so the Sound
    // toggle silences it and the pause menu can fade it on its own.
    this.ambBus = c.createGain();
    this.ambBus.gain.value = 0;
    this.ambBus.connect(this.sfxGain);

    // slipstream whoosh: noise through a bandpass that opens with the tow
    this.whooshSrc = c.createBufferSource();
    this.whooshSrc.buffer = this.noise;
    this.whooshSrc.loop = true;
    this.whooshFilter = c.createBiquadFilter();
    this.whooshFilter.type = "bandpass";
    this.whooshFilter.frequency.value = 700;
    this.whooshFilter.Q.value = 1.2;
    this.whooshGain = c.createGain();
    this.whooshGain.gain.value = 0;
    this.whooshSrc.connect(this.whooshFilter).connect(this.whooshGain).connect(this.sfxGain);
    this.whooshSrc.start();
    this.whooshing = false;

    this.nextT = c.currentTime + 0.1;
    this.#applyGains();
    // setLevel() may have been called before there was a context to build in.
    if (this.levelName) this.setLevel(this.levelName);
    if (this.opponentCount) this.setOpponents(this.opponentCount);
  }

  #applyGains() {
    const t = this.ctx.currentTime;
    this.musicGain.gain.setTargetAtTime(this.music ? 0.12 : 0, t, 0.05);
    this.sfxGain.gain.setTargetAtTime(this.sound ? 0.65 : 0, t, 0.05);
  }

  /**
   * Call every frame. speed in m/s; engine silent when paused/menu.
   * `drive.drift` is vehicle.state.driftFactor (0..1) and `drive.grounded`
   * whether the wheels are down; both only matter to the tyre squeal.
   */
  update(speed, active, drive = {}) {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const k = Math.min(speed / 60, 1);
    const f = 42 + k * 110;
    this.engine.frequency.setTargetAtTime(f, t, 0.08);
    this.engine2.frequency.setTargetAtTime(f, t, 0.08);
    this.engineSub.frequency.setTargetAtTime(f * 0.5, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(300 + k * 900, t, 0.08);
    this.engineGain.gain.setTargetAtTime(active ? 0.06 + k * 0.12 : 0, t, 0.1);

    // Squeal: needs a real slide AND real speed, so a parked car turning
    // the wheel or a crawl round a hairpin stays quiet. The pitch rises
    // with speed, and the log only marks the start and end of a squeal.
    const slide = active && (drive.grounded ?? true) ? Math.max(0, (drive.drift ?? 0) - 0.12) : 0;
    const level = Math.min(slide * 1.6, 1) * Math.min(speed / 25, 1);
    this.squealGain.gain.setTargetAtTime(level * 0.35, t, 0.05);
    this.squealFilter.frequency.setTargetAtTime(1500 + k * 1500, t, 0.1);
    const on = level > 0.08;
    if (on !== this.squealing) {
      this.squealing = on;
      if (this.sound) this.#log(on ? "tyre-squeal start" : "tyre-squeal stop");
    }

    // Slipstream: a whoosh that swells with the tow and with speed.
    const slip = active ? clamp01(drive.slip ?? 0) * clamp01(speed / 30) : 0;
    this.whooshGain.gain.setTargetAtTime(slip * 0.3, t, 0.12);
    this.whooshFilter.frequency.setTargetAtTime(500 + slip * 1400, t, 0.12);
    const drafting = slip > 0.05;
    if (drafting !== this.whooshing) {
      this.whooshing = drafting;
      if (this.sound) this.#log(drafting ? "slipstream whoosh start" : "slipstream whoosh stop");
    }

    // Ambience: quiet on the dashboard and pause menu, live otherwise.
    this.ambBus.gain.setTargetAtTime(active ? 1 : 0, t, 0.2);
    this.amb?.update?.(t, active, speed, drive);

    // schedule the arpeggio a little ahead of the clock
    const m = MUSIC[this.musicStyle];
    while (this.nextT < t + 0.25) {
      if (this.music) {
        this.#note(m.notes[this.step % m.notes.length], this.nextT);
        if (m.bass && this.step % 2 === 0) this.#bass(m.notes[(this.step >> 3) % m.notes.length] - 12, this.nextT);
      }
      this.step++;
      this.nextT += m.stepSec;
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

  /** A short low pulse under the night music. */
  #bass(midi, when) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sawtooth";
    o.frequency.value = mtof(midi);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.7, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
    o.connect(g).connect(this.musicGain);
    o.start(when);
    o.stop(when + 0.22);
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

  /**
   * A filtered noise burst on the sfx bus: the crunch of a crash, the
   * rumble of a rock. The lowpass sweeps from `from` Hz down to `to` Hz
   * over `dur`, so a bigger, slower sound is also a duller one.
   */
  #burst({ vol, from, to, dur }) {
    const c = this.ctx;
    const t = c.currentTime + 0.005;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(from, t);
    lp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(this.sfxGain);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /**
   * A crash, sized 0..1 by how hard the hit was: a noise burst (the
   * crunch, duller and longer the harder it is) over a low sine thud. A
   * graze is a tick; a head-on is a boom.
   */
  crash(severity = 0.5) {
    const k = clamp01(severity);
    if (!this.ctx || !this.sound) return;
    // A scrape along a wall reports a string of tiny hits; sound only the
    // ones that matter, and never more than a few a second.
    const now = this.ctx.currentTime;
    if (k < 0.06 || (now - this.lastCrash < 0.25 && k < this.lastCrashK + 0.2)) return;
    this.lastCrash = now;
    this.lastCrashK = k;
    this.#log("crash", `severity=${k.toFixed(2)}`);
    this.#burst({ vol: 0.4 + k * 0.6, from: 3500 - k * 2200, to: 200, dur: 0.15 + k * 0.5 });
    this.#blip({ type: "sine", freq: 130 - k * 50, to: 40, dur: 0.2 + k * 0.3, vol: 0.4 + k * 0.5 });
  }

  /** A boulder landing somewhere: a deep rumble, louder the closer it is. */
  rockLanded(distance = 60) {
    if (!this.ctx || !this.sound) return;
    const near = clamp01(1 - distance / 160);
    this.#log("rock-landed", `distance=${Math.round(distance)}m`);
    this.#burst({ vol: 0.15 + near * 0.7, from: 600, to: 50, dur: 1.1 });
    this.#blip({ type: "sine", freq: 70, to: 30, dur: 0.6, vol: 0.2 + near * 0.6 });
  }

  /** The player's car meeting a settled rock: a sharp stony crack over the crash. */
  rockHit() {
    if (!this.ctx || !this.sound) return;
    this.#log("rock-hit-car");
    this.#burst({ vol: 0.8, from: 5000, to: 300, dur: 0.35 });
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

  /** One start lamp lit: a short, flat F1-style beep, the same pitch each time. */
  startLight(lamp = 1) {
    this.#play(`start-light ${lamp}`, [{ type: "square", freq: mtof(81), dur: 0.16, vol: 0.4 }]);
  }

  /** Lights out: a higher, longer "GO" tone, with a fifth above it for bite. */
  raceStarted() {
    this.#play("race-started", [
      { type: "square", freq: mtof(93), dur: 0.7, vol: 0.45 },
      { type: "sawtooth", freq: mtof(100), dur: 0.7, vol: 0.2 },
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

  // ---------------------------------------------------------------------
  // Per-level ambience. Each level builds its nodes ONCE in setLevel() and
  // then only nudges gains in update(); nothing is created per frame. A
  // level change fades the old bed out and the new one in, then frees the
  // old nodes.
  // ---------------------------------------------------------------------

  /** Call from loadLevel. Names: city | mountain | grandprix (anything else: no ambience). */
  setLevel(name) {
    this.levelName = name;
    this.musicStyle = name === "grandprix" ? "night" : "day";
    this.step = 0;
    this.setOpponents(0); // main.js re-adds them once the new race exists
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const old = this.amb;
    if (old) {
      old.gain.gain.setTargetAtTime(0, t, 0.35);
      setTimeout(() => old.stop(), 2500);
    }
    const build = { city: this.#cityAmbience, mountain: this.#mountainAmbience, grandprix: this.#nightAmbience }[name];
    this.amb = build ? build.call(this) : null;
    if (this.amb) this.amb.gain.gain.setTargetAtTime(1, t, 0.6);
    this.#log(`level ambience: ${name}`, `(music: ${this.musicStyle})`);
  }

  /** A looping noise voice: source -> filter -> gain. Returns the pieces. */
  #noiseVoice(type, freq, q, dest) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = c.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(dest);
    src.start();
    return { src, filter, gain };
  }

  /** Common wrapper: a fade-able gain into the ambience bus, and a stop() that frees its nodes. */
  #ambience() {
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.ambBus);
    return {
      gain,
      sources: [], // every started source node, so stop() can end them
      update: null,
      stop() {
        for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
        gain.disconnect();
      },
    };
  }

  /** City: a soft traffic hum, a little air, and a bird now and then. */
  #cityAmbience() {
    const amb = this.#ambience();
    const hum = this.#noiseVoice("lowpass", 380, 0.7, amb.gain);
    const air = this.#noiseVoice("bandpass", 2600, 0.6, amb.gain);
    hum.gain.gain.value = 0.22;
    air.gain.gain.value = 0.03;
    amb.sources.push(hum.src, air.src);
    let nextBird = 0;
    amb.update = (t, active) => {
      if (!active || t < nextBird) return;
      nextBird = t + 3 + Math.random() * 6;
      const hi = 3000 + Math.random() * 1500;
      this.#play("city-bird", [
        { type: "sine", freq: hi, to: hi * 1.4, dur: 0.07, vol: 0.18 },
        { type: "sine", freq: hi * 1.2, to: hi * 1.6, dur: 0.09, vol: 0.18, delay: 0.1 },
      ]);
    };
    return amb;
  }

  /** Mountain: wind that swells with the crosswind gust and with speed. */
  #mountainAmbience() {
    const amb = this.#ambience();
    const wind = this.#noiseVoice("bandpass", 500, 0.7, amb.gain);
    const body = this.#noiseVoice("lowpass", 140, 0.7, amb.gain);
    amb.sources.push(wind.src, body.src);
    let gusting = false;
    amb.update = (t, active, speed, drive) => {
      const gust = clamp01(drive.wind ?? 0);
      const v = clamp01(speed / 50);
      wind.gain.gain.setTargetAtTime(0.06 + gust * 0.5 + v * 0.12, t, 0.15);
      wind.filter.frequency.setTargetAtTime(350 + gust * 900 + v * 250, t, 0.2);
      body.gain.gain.setTargetAtTime(0.1 + gust * 0.5, t, 0.2);
      const strong = active && gust > 0.5;
      if (strong !== gusting) {
        gusting = strong;
        if (this.sound) this.#log(strong ? "mountain wind: gust" : "mountain wind: calm");
      }
    };
    return amb;
  }

  /** Grand Prix: a low pulsing drone and a distant crowd swell under faster night music. */
  #nightAmbience() {
    const c = this.ctx;
    const amb = this.#ambience();
    const drone = c.createGain();
    drone.gain.value = 0.16;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 240;
    const o1 = c.createOscillator();
    const o2 = c.createOscillator();
    o1.type = o2.type = "sawtooth";
    o1.frequency.value = 55;
    o2.frequency.value = 55.4; // beats slowly against the first
    o1.connect(lp);
    o2.connect(lp);
    lp.connect(drone).connect(amb.gain);
    // slow tremolo so the drone breathes
    const lfo = c.createOscillator();
    const depth = c.createGain();
    lfo.frequency.value = 0.35;
    depth.gain.value = 0.07;
    lfo.connect(depth).connect(drone.gain);
    const crowd = this.#noiseVoice("bandpass", 900, 0.5, amb.gain);
    crowd.gain.gain.value = 0.05;
    const swell = c.createGain();
    swell.gain.value = 0.03;
    lfo.connect(swell).connect(crowd.gain.gain);
    for (const o of [o1, o2, lfo]) o.start();
    amb.sources.push(o1, o2, lfo, crowd.src);
    return amb;
  }

  /**
   * Grand Prix: one engine voice per AI car, built once. Call with the
   * number of opponents after the race is created (0 on solo levels).
   */
  setOpponents(n) {
    this.opponentCount = n;
    if (!this.ctx) return;
    const c = this.ctx;
    for (const v of this.opponents) {
      try { v.o.stop(); v.o2.stop(); } catch { /* already stopped */ }
      v.gain.disconnect();
    }
    this.opponents = [];
    for (let i = 0; i < n; i++) {
      const o = c.createOscillator();
      const o2 = c.createOscillator();
      o.type = o2.type = "sawtooth";
      o2.detune.value = 22;
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 500;
      const gain = c.createGain();
      gain.gain.value = 0;
      o.connect(lp);
      o2.connect(lp);
      lp.connect(gain).connect(this.ambBus);
      o.start();
      o2.start();
      this.opponents.push({ o, o2, lp, gain, pitch: 1 + i * 0.045 });
    }
    if (n) this.#log(`opponent engines: ${n}`);
  }

  /** Per frame, per AI car: distance to the player (m) and its speed (m/s). */
  updateOpponent(i, distance, speed) {
    const v = this.opponents[i];
    if (!v) return;
    const t = this.ctx.currentTime;
    const near = (1 - clamp01(distance / 70)) ** 2;
    const k = clamp01(speed / 60);
    const f = (45 + k * 120) * v.pitch;
    v.o.frequency.setTargetAtTime(f, t, 0.1);
    v.o2.frequency.setTargetAtTime(f, t, 0.1);
    v.lp.frequency.setTargetAtTime(250 + k * 700, t, 0.1);
    v.gain.gain.setTargetAtTime(near * (0.1 + k * 0.14), t, 0.1);
  }
}
