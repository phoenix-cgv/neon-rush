// Procedural audio — no asset files. Music is a looping synth arpeggio,
// sound is an engine tone that follows speed plus UI blips. Browsers
// refuse to start an AudioContext before a user gesture, so everything
// is created lazily by unlock(), which the dashboard calls from a click.

// Arpeggios, MIDI. "day" is the original; "night" (Grand Prix) is lower,
// faster and minor, with a driving bass pulse under it.
const MUSIC = {
  day: { notes: [57, 60, 64, 67, 55, 59, 62, 65], stepSec: 0.2, bass: false, type: "square", dur: 0.18, vol: 0.5 },
  night: { notes: [45, 57, 48, 57, 43, 55, 46, 55], stepSec: 0.14, bass: true, type: "square", dur: 0.18, vol: 0.5 },
  // Title screen: slow, soft and calm, with a low pad under it.
  title: { notes: [57, 64, 69, 72, 67, 64, 60, 64], stepSec: 0.55, bass: false, type: "triangle", dur: 0.95, vol: 0.5, pad: [45, 52, 57] },
};
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const clamp01 = (x) => clamp(x, 0, 1);

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.music = true;
    this.sound = true;
    this.seq = { title: { step: 0, nextT: 0 }, race: { step: 0, nextT: 0 } }; // one sequencer per music bus
    this.scene = "title"; // title | game: which music is meant to be playing
    this.squealing = false; // for logging the on/off edge only
    this.levelName = null;
    this.boostWasFull = false;
    this.lastT = 0; // previous update's clock, for airtime
    this.airT = 0;
    this.nextWarn = 0;
    this.drill = null; // a testDrift() preview in progress
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
    // While paused everything runs through this lowpass: the game goes
    // "underwater" instead of going silent.
    this.muffle = c.createBiquadFilter();
    this.muffle.type = "lowpass";
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.7;
    this.master.connect(this.muffle).connect(this.limiter).connect(c.destination);
    this.muffled = false;
    this.musicGain = c.createGain();
    this.musicGain.connect(this.master);
    // Two music buses under the music gain, so the title theme and the race
    // music can cross-fade instead of cutting.
    this.titleBus = c.createGain();
    this.titleBus.connect(this.musicGain);
    this.raceBus = c.createGain();
    this.raceBus.gain.value = 0;
    this.raceBus.connect(this.musicGain);
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

    // Tyre squeal, in layers, all built once and running forever (a voice
    // that is never started or stopped cannot click; only its gain moves):
    //  - tonal: three detuned saws around 760-1100 Hz through a bandpass,
    //    the actual "screech";
    //  - wobble: two LFOs (5-12 Hz, re-aimed at random every quarter
    //    second) bend the pitch and the volume, so it sounds like rubber
    //    gripping and slipping rather than a steady beep;
    //  - texture: quiet bandpassed noise underneath, for grit;
    //  - a panner, so a slide to the left is heard on the left.
    this.squealOsc = [1, 1.12, 1.27].map((ratio, i) => {
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = 700 * ratio;
      o.detune.value = (i - 1) * 14;
      o.start();
      return { o, ratio };
    });
    const tonalSum = c.createGain();
    tonalSum.gain.value = 0.34;
    this.squealBand = c.createBiquadFilter();
    this.squealBand.type = "bandpass";
    this.squealBand.frequency.value = 1000;
    this.squealBand.Q.value = 4;
    this.squealTone = c.createGain(); // the wobble's volume target
    this.squealTone.gain.value = 0.75;
    for (const v of this.squealOsc) v.o.connect(tonalSum);
    tonalSum.connect(this.squealBand).connect(this.squealTone);

    this.wobbleA = c.createOscillator();
    this.wobbleB = c.createOscillator();
    this.wobbleA.type = "sine";
    this.wobbleB.type = "triangle";
    this.wobbleA.frequency.value = 6.5;
    this.wobbleB.frequency.value = 10.3;
    const pitchDepth = c.createGain();
    pitchDepth.gain.value = 45; // cents
    const ampDepth = c.createGain();
    ampDepth.gain.value = 0.22;
    this.wobbleA.connect(pitchDepth);
    this.wobbleB.connect(pitchDepth);
    this.wobbleA.connect(ampDepth);
    this.wobbleB.connect(ampDepth);
    for (const v of this.squealOsc) pitchDepth.connect(v.o.detune);
    ampDepth.connect(this.squealTone.gain);
    this.wobbleA.start();
    this.wobbleB.start();
    this.nextWobble = 0;

    const grit = c.createBufferSource();
    grit.buffer = this.noise;
    grit.loop = true;
    const gritBand = c.createBiquadFilter();
    gritBand.type = "bandpass";
    gritBand.frequency.value = 1900;
    gritBand.Q.value = 1.2;
    const gritGain = c.createGain();
    gritGain.gain.value = 0.28;
    grit.connect(gritBand).connect(gritGain);
    grit.start();

    this.squealGain = c.createGain(); // the envelope: the only thing update() drives
    this.squealGain.gain.value = 0;
    this.squealPan = c.createStereoPanner();
    this.squealTone.connect(this.squealGain);
    gritGain.connect(this.squealGain);
    this.squealGain.connect(this.squealPan).connect(this.sfxGain);

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

    // Tunnel echo: a send from the sfx bus into a filtered feedback delay,
    // opened only inside the tunnel. Built once; only the send level moves.
    this.echoSend = c.createGain();
    this.echoSend.gain.value = 0;
    const echo = c.createDelay(0.5);
    echo.delayTime.value = 0.16;
    const echoFb = c.createGain();
    echoFb.gain.value = 0.5;
    const echoTone = c.createBiquadFilter();
    echoTone.type = "lowpass";
    echoTone.frequency.value = 2400;
    this.sfxGain.connect(this.echoSend);
    this.echoSend.connect(echo);
    echo.connect(echoTone).connect(echoFb).connect(echo);
    echoTone.connect(this.master);
    this.inTunnel = false;

    // Grass / gravel rumble: low noise, chattering at about 16 Hz
    this.rumble = this.#noiseVoice("lowpass", 200, 0.8, this.sfxGain);
    const chatter = c.createOscillator();
    const chatterDepth = c.createGain();
    chatter.frequency.value = 16;
    chatterDepth.gain.value = 0.35;
    chatter.connect(chatterDepth).connect(this.rumble.gain.gain);
    chatter.start();
    this.rumbling = false;

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

    // Airtime -> landing thud; heavy damage -> a repeating warning beep.
    const dt = Math.min(t - this.lastT, 0.1);
    this.lastT = t;
    const live = active && !drive.paused;
    if (!live) this.airT = 0;
    else if (!(drive.grounded ?? true)) this.airT += dt;
    else {
      if (this.airT > 0.3) this.landing(this.airT);
      this.airT = 0;
    }
    const damage = drive.damage ?? 0;
    if (live && damage >= 0.7 && t >= this.nextWarn) {
      this.warningBeep();
      this.nextWarn = t + 1.5 - 0.9 * clamp01((damage - 0.7) / 0.3); // faster as it gets worse
    }

    // Squeal: needs a real slide AND real speed, so a parked car turning
    // the wheel or a crawl round a hairpin stays quiet. testDrift() takes
    // over these inputs for a few seconds so it can be previewed.
    let drift = drive.drift ?? 0;
    let squealSpeed = speed;
    let pan = clamp(drive.slide ?? 0, -1, 1) * 1.4;
    let squealOk = active && !drive.paused && (drive.grounded ?? true);
    if (this.drill) {
      const u = (t - this.drill.from) / this.drill.dur;
      if (u >= 1) {
        this.drill = null;
        this.#log("testDrift finished");
      } else {
        drift = this.drill.k;
        squealSpeed = Math.max(speed, 40);
        pan = Math.sin(u * Math.PI * 2) * 0.7; // slide left, then right
        squealOk = true;
      }
    }
    const slide = squealOk ? Math.max(0, drift - 0.12) : 0;
    const level = Math.min(slide * 1.6, 1) * Math.min(squealSpeed / 25, 1);
    // Faster to come in than to leave, and always a smooth ramp.
    const rising = level * 0.5 > this.squealGain.gain.value;
    this.squealGain.gain.setTargetAtTime(level * 0.5, t, rising ? 0.025 : 0.14);
    // The more sideways, the higher it screams; a little more with speed.
    const base = 640 + clamp01(drift) * 260 + clamp01(squealSpeed / 60) * 60;
    for (const v of this.squealOsc) v.o.frequency.setTargetAtTime(base * v.ratio, t, 0.06);
    this.squealBand.frequency.setTargetAtTime(base * 1.25, t, 0.08);
    this.squealPan.pan.setTargetAtTime(clamp(pan, -0.8, 0.8), t, 0.1);
    if (t > this.nextWobble) {
      // Re-aim the two wobbles at random rates so the rhythm never settles.
      this.wobbleA.frequency.setTargetAtTime(5 + Math.random() * 7, t, 0.08);
      this.wobbleB.frequency.setTargetAtTime(5 + Math.random() * 7, t, 0.08);
      this.nextWobble = t + 0.15 + Math.random() * 0.2;
    }
    const on = level > 0.08;
    if (on !== this.squealing) {
      this.squealing = on;
      if (this.sound) {
        this.#log(on ? "tyre-squeal start" : "tyre-squeal stop");
        // A short bark as the tyres let go.
        if (on) this.#play("tyre-chirp", [{ type: "sawtooth", freq: 1000 + drift * 400, to: 2300, dur: 0.07, vol: 0.2 }]);
      }
    }

    // Slipstream: a whoosh that swells with the tow and with speed.
    const slip = active && !drive.paused ? clamp01(drive.slip ?? 0) * clamp01(speed / 30) : 0;
    this.whooshGain.gain.setTargetAtTime(slip * 0.3, t, 0.12);
    this.whooshFilter.frequency.setTargetAtTime(500 + slip * 1400, t, 0.12);
    const drafting = slip > 0.05;
    if (drafting !== this.whooshing) {
      this.whooshing = drafting;
      if (this.sound) this.#log(drafting ? "slipstream whoosh start" : "slipstream whoosh stop");
    }

    // Boost tank just reached full (a ding on the way up only).
    const full = !!drive.boostFull;
    if (full && !this.boostWasFull && active && !drive.paused) this.boostFull();
    this.boostWasFull = full;

    // Tunnel echo opens inside the tunnel; grass rumble follows how many
    // tyres are off the asphalt and how fast.
    const tunnel = !!drive.tunnel && live;
    this.echoSend.gain.setTargetAtTime(tunnel ? 0.45 : 0, t, 0.15);
    if (tunnel !== this.inTunnel) {
      this.inTunnel = tunnel;
      if (this.sound) this.#log(tunnel ? "tunnel echo on" : "tunnel echo off");
    }
    const grass = live ? clamp01(drive.grass ?? 0) * clamp01(speed / 30) : 0;
    this.rumble.gain.gain.setTargetAtTime(grass * 0.45, t, 0.1);
    this.rumble.filter.frequency.setTargetAtTime(120 + grass * 160, t, 0.2);
    if ((grass > 0.08) !== this.rumbling) {
      this.rumbling = grass > 0.08;
      if (this.sound) this.#log(this.rumbling ? "grass rumble start" : "grass rumble stop");
    }

    // Ambience: quiet on the dashboard and pause menu, live otherwise.
    this.ambBus.gain.setTargetAtTime(active ? 1 : 0, t, 0.2);
    this.amb?.update?.(t, active && !drive.paused, speed, drive);

    // Pause: muffle everything rather than cut it.
    const paused = !!drive.paused && active;
    this.muffle.frequency.setTargetAtTime(paused ? 380 : 20000, t, paused ? 0.1 : 0.06);
    if (paused !== this.muffled) {
      this.muffled = paused;
      if (this.sound || this.music) this.#log(paused ? "pause muffle on" : "pause muffle off");
    }

    // Music: the title theme and the race music cross-fade (about 1.5 s).
    const game = this.scene === "game";
    this.titleBus.gain.setTargetAtTime(game ? 0 : 1, t, 0.5);
    this.raceBus.gain.setTargetAtTime(game ? 1 : 0, t, 0.5);
    this.#sequence(this.seq.title, MUSIC.title, this.titleBus, t, !game || this.titleBus.gain.value > 0.02);
    this.#sequence(this.seq.race, MUSIC[this.musicStyle], this.raceBus, t, game || this.raceBus.gain.value > 0.02);
  }

  /**
   * Schedule one music bus's notes a little ahead of the clock. A bus that
   * is faded out is left alone (and re-syncs to "now" when it returns), so
   * the idle one costs nothing.
   */
  #sequence(seq, m, bus, t, running) {
    if (!running) return void (seq.nextT = 0);
    if (seq.nextT === 0) seq.nextT = t + 0.1;
    while (seq.nextT < t + 0.25) {
      if (this.music) {
        this.#note(m.notes[seq.step % m.notes.length], seq.nextT, bus, m);
        if (m.bass && seq.step % 2 === 0) this.#bass(m.notes[(seq.step >> 3) % m.notes.length] - 12, seq.nextT);
        if (m.pad && seq.step % 8 === 0) for (const p of m.pad) this.#note(p, seq.nextT, bus, { type: "sine", dur: 4.2, vol: 0.28 });
      }
      seq.step++;
      seq.nextT += m.stepSec;
    }
  }

  /**
   * Which music should be playing: "title" (calm, the home screen) or
   * "game" (the level's race music). They cross-fade.
   */
  setScene(scene) {
    if (scene === this.scene) return;
    this.scene = scene;
    this.#log(`music scene: ${scene}`, scene === "game" ? "(cross-fading to race music)" : "(cross-fading to title theme)");
  }

  #note(midi, when, bus = this.raceBus, { type = "square", dur = 0.18, vol = 0.5 } = {}) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = mtof(midi);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + Math.min(0.01 + dur * 0.15, 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(bus);
    o.start(when);
    o.stop(when + dur + 0.02);
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
    o.connect(g).connect(this.raceBus);
    o.start(when);
    o.stop(when + 0.22);
  }

  /** Pointer moves onto a button: a tiny, quiet tick. */
  hover() {
    this.#play("button-hover", [{ type: "triangle", freq: 1250, dur: 0.04, vol: 0.12 }]);
  }

  /** Back / resume / close: two falling notes, the opposite of the rising click feel. */
  back() {
    this.#play("button-back", [
      { type: "triangle", freq: 560, dur: 0.07, vol: 0.3 },
      { type: "triangle", freq: 400, dur: 0.1, vol: 0.3, delay: 0.06 },
    ]);
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
  #burst({ vol, from, to, dur, delay = 0 }) {
    const c = this.ctx;
    const t = c.currentTime + delay + 0.005;
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

  /**
   * Engine rev as the lights go out: the motor winds up hard and settles
   * back. Two detuned saws through a lowpass that opens as the revs rise.
   */
  engineRev() {
    if (!this.ctx || !this.sound) return void (this.ctx && this.#log("engine-rev (skipped: Sound is off)"));
    this.#log("engine-rev");
    const c = this.ctx;
    const t = c.currentTime + 0.005;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(2200, t + 0.5);
    lp.frequency.exponentialRampToValueAtTime(700, t + 1.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.08);
    g.gain.setValueAtTime(0.5, t + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    lp.connect(g).connect(this.sfxGain);
    for (const detune of [0, 20]) {
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.detune.value = detune;
      o.frequency.setValueAtTime(55, t);
      o.frequency.exponentialRampToValueAtTime(230, t + 0.5);
      o.frequency.exponentialRampToValueAtTime(95, t + 1.2);
      o.connect(lp);
      o.start(t);
      o.stop(t + 1.35);
    }
  }

  /** Drift tier-up: a rising chime, one more note and a higher start for each tier. */
  tierUp(tier = 0) {
    const n = 3 + Math.min(Math.max(tier, 0), 3);
    const root = 76 + tier * 2;
    const scale = [0, 4, 7, 12, 16, 19]; // a major arpeggio, so it always sounds like a reward
    this.#play(`drift-tier-up ${tier}`, Array.from({ length: n }, (_, i) =>
      ({ type: "triangle", freq: mtof(root + scale[i]), dur: 0.22, vol: 0.3, delay: i * 0.06 })));
  }

  /** Boost tank just filled: a bright bell-like ding. */
  boostFull() {
    this.#play("boost-full", [
      { type: "sine", freq: 1760, dur: 0.5, vol: 0.35 },
      { type: "sine", freq: 2637, dur: 0.35, vol: 0.18 },
    ]);
  }

  /**
   * A swept band of noise on the sfx bus: the generic "whoosh". The band's
   * centre glides from `from` to `to` Hz while the volume swells and falls
   * (swell = how far through `dur` the peak lands, 0..1).
   */
  #whoosh({ from, to, dur, vol, q = 1.5, swell = 0.4, delay = 0 }) {
    const c = this.ctx;
    const t = c.currentTime + delay + 0.005;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = q;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + dur * swell);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** Touchdown after being airborne: a low thud, heavier the longer you were up. */
  landing(airTime = 0.5) {
    if (!this.ctx || !this.sound) return;
    const k = clamp01((airTime - 0.25) / 1.5);
    this.#log("landing", `air=${airTime.toFixed(2)}s`);
    this.#burst({ vol: 0.2 + k * 0.5, from: 900, to: 80, dur: 0.18 + k * 0.2 });
    this.#blip({ type: "sine", freq: 110 - k * 40, to: 38, dur: 0.18 + k * 0.25, vol: 0.4 + k * 0.5 });
  }

  /** Low-health warning: a short, urgent double beep. */
  warningBeep() {
    this.#play("low-health-beep", [
      { type: "square", freq: 880, dur: 0.08, vol: 0.28 },
      { type: "square", freq: 880, dur: 0.08, vol: 0.28, delay: 0.12 },
    ]);
  }

  /** Respawn: a rising whoosh with a soft shimmer, the car being put back. */
  respawn() {
    if (!this.ctx || !this.sound) return;
    this.#log("respawn");
    this.#whoosh({ from: 250, to: 3200, dur: 0.6, vol: 0.55, q: 1.2, swell: 0.7 });
    this.#blip({ type: "sine", freq: mtof(76), to: mtof(88), dur: 0.4, vol: 0.18 });
  }

  /** A traffic car whipping past: a quick falling whoosh, louder the closer and faster. */
  nearMiss(side = 3, speed = 20) {
    if (!this.ctx || !this.sound) return;
    const k = clamp01(1 - side / 5.5) * 0.6 + clamp01(speed / 50) * 0.4;
    this.#log("near-miss", `side=${side.toFixed(1)}m closing=${Math.round(speed)}m/s`);
    this.#whoosh({ from: 2200, to: 450, dur: 0.4, vol: 0.12 + k * 0.5, q: 0.9, swell: 0.3 });
  }

  /** Crowd at the finish: a swell of noise, claps and two whoops. Bigger for a win. */
  cheer(position = 1) {
    if (!this.ctx || !this.sound) return;
    const k = position === 1 ? 1 : 0.55;
    this.#log("crowd-cheer", `position=${position}`);
    this.#whoosh({ from: 900, to: 1500, dur: 2.6, vol: 0.4 * k, q: 0.5, swell: 0.25 });
    this.#whoosh({ from: 2600, to: 3200, dur: 2.2, vol: 0.12 * k, q: 0.7, swell: 0.3 });
    // scattered claps, then two whoops
    for (let i = 0; i < 10; i++) this.#burst({ vol: 0.16 * k, from: 4500, to: 1500, dur: 0.05, delay: 0.1 + Math.random() * 1.8 });
    this.#blip({ type: "sine", freq: 520, to: 900, dur: 0.45, vol: 0.12 * k, delay: 0.3 });
    this.#blip({ type: "sine", freq: 640, to: 1100, dur: 0.5, vol: 0.1 * k, delay: 0.8 });
  }

  /** A new personal best lap: a bright two-step fanfare with a sparkle on top. */
  newBest() {
    // Starts 0.45 s late so it lands after the lap-complete arpeggio.
    this.#play("new-best-lap", [
      { type: "square", freq: mtof(79), dur: 0.12, vol: 0.3, delay: 0.45 },
      { type: "square", freq: mtof(84), dur: 0.12, vol: 0.3, delay: 0.55 },
      { type: "triangle", freq: mtof(91), dur: 0.5, vol: 0.35, delay: 0.65 },
      { type: "sine", freq: mtof(103), dur: 0.45, vol: 0.16, delay: 0.71 },
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

  /**
   * Preview the drift squeal from the console without driving:
   * `__dbg.audio.testDrift(0.7)`. intensity 0..1 is the driftFactor; it
   * holds for `seconds` while sliding left then right across the stereo field.
   */
  testDrift(intensity = 0.7, seconds = 3) {
    if (!this.ctx) return void this.#log("testDrift (skipped: audio not unlocked, click the page first)");
    if (!this.sound) return void this.#log("testDrift (skipped: Sound is off)");
    this.drill = { k: clamp01(intensity), from: this.ctx.currentTime, dur: Math.max(seconds, 0.5) };
    this.#log("testDrift", `intensity=${this.drill.k.toFixed(2)} for ${seconds}s`);
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
    this.seq.race.step = 0;
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
