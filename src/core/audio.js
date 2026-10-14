// Procedural audio — no asset files. Music is a looping synth arpeggio,
// sound is an engine tone that follows speed plus UI blips. Browsers
// refuse to start an AudioContext before a user gesture, so everything
// is created lazily by unlock(), which the dashboard calls from a click.

// The music: synthwave, which is what a neon street racer wants — a kick
// on every beat, hats off the beat, a detuned saw bass moving under a
// filter, and a pad washing underneath.
//
// Each track is a chord progression, one chord a bar, played on a 16th
// note grid (16 steps a bar). The progression runs twice before it
// repeats, the second time with the arpeggio an octave up, so the loop
// is eight bars rather than the one-second cycle this replaced.
//
// `bass` and the drum rows are one bar of 16 steps:
//   bass  0 silent, 1 root, 2 the octave above
//   kick / clap / hat  1 to hit
// `arp` indexes the chord's own notes, so a figure follows the harmony.
const DRIVE = {
  kick: [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],
  clap: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
  hat:  [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,1],
  bass: [1,0,1,0, 1,0,2,0, 1,0,1,0, 1,2,0,0],
};
const LIGHT = {
  kick: [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
  clap: [0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
  hat:  [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
  bass: [1,0,0,0, 0,0,1,0, 1,0,0,0, 0,0,0,0],
};
// A chord is its bass root plus the notes the arpeggio and pad draw from.
const Am = { root: 45, notes: [57, 60, 64] };
const F  = { root: 41, notes: [57, 60, 65] };
const C  = { root: 48, notes: [55, 60, 64] };
const G  = { root: 43, notes: [55, 59, 62] };

const MUSIC = {
  // Grand Prix, night: i-VI-III-VII in A minor, the outrun progression,
  // fast and driving.
  night: { bpm: 128, chords: [Am, F, C, G], drums: DRIVE, arpEvery: 2, padVol: 0.1, leadVol: 0.2, leadType: "sawtooth" },
  // City, morning: the same four chords turned to start on C, so it
  // reads bright rather than brooding, and a lighter kit under it.
  day: { bpm: 112, chords: [C, G, Am, F], drums: LIGHT, arpEvery: 2, padVol: 0.11, leadVol: 0.16, leadType: "triangle" },
  // Title screen: no drums at all, mostly pad, the arpeggio sparse and
  // soft — it sits under the menu rather than in front of it.
  title: { bpm: 84, chords: [Am, F, C, G], drums: null, arpEvery: 4, padVol: 0.16, leadVol: 0.1, leadType: "triangle" },
};
const STEPS_PER_BAR = 16;
// Speeds (m/s) at which each cosmetic gear tops out — the same ladder the
// tachometer uses (src/ui/speedo.js), so what is heard and what the dial
// shows are the same car.
const GEARS = [0, 11, 22, 34, 46, 58, 72];

/**
 * Where the engine is, from road speed alone: which gear, and how far up
 * that gear's rev range (0..1).
 *
 * This is what was missing. The pitch used to be a straight line from
 * road speed, so the engine climbed for ever like a siren and never did
 * the one thing an engine audibly does — run up to the top of a gear and
 * drop back down into the next. The car has no real gearbox, so the
 * ladder is borrowed from the dial rather than invented twice.
 */
function revsAt(speed) {
  const v = Math.abs(speed);
  let g = 1;
  while (g < 6 && v > GEARS[g]) g++;
  const span = GEARS[g] - GEARS[g - 1];
  return { gear: g, rpm: clamp01(0.12 + ((v - GEARS[g - 1]) / span) * 0.88) };
}
// Spoken, so words rather than "1st" — a synthesiser reads those unevenly.
const PLACES = {
  1: "first", 2: "second", 3: "third", 4: "fourth",
  5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth",
};
import { Sfx } from "./sfx.js";

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
    this.drill = null; // a testDrift() preview in progress
    this.lastCrash = -1; // when the last crash sounded, and how hard
    this.lastBoostAt = -1; // when a boost last announced itself
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
    // Gentle, and slow enough to let the crack at the front of a sound
    // through: at 8:1 from -12 dB with a 3 ms attack it was catching every
    // transient, which is exactly the part that gives a kick or a crash
    // its punch. It still has to stop a crash over a fanfare clipping.
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -9;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 4;
    this.limiter.attack.value = 0.008;
    this.limiter.release.value = 0.25;
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

    // One room for the whole game.
    //
    // Everything used to be bone dry — the only thing in the file that put
    // a sound anywhere was the tunnel's echo. A dry sound has no space
    // around it and sits flat against the speaker however well it is
    // synthesised, which is most of why the game sounded flat. One
    // convolver, fed from the two buses so the Sound and Music toggles
    // still silence it, gives everything the same room.
    //
    // The impulse is generated, not loaded: noise that dies away, which is
    // what a room's tail is. No asset, so nothing to credit.
    this.reverb = c.createConvolver();
    this.reverb.buffer = this.#impulse(2.4, 2.8);
    this.reverbReturn = c.createGain();
    this.reverbReturn.gain.value = 1;
    this.reverb.connect(this.reverbReturn).connect(this.master);
    // Separate sends, so a level can be wetter without drowning the music.
    this.sfxVerb = c.createGain();
    this.sfxVerb.gain.value = 0.16;
    this.sfxGain.connect(this.sfxVerb).connect(this.reverb);
    this.musicVerb = c.createGain();
    this.musicVerb.gain.value = 0.3;
    this.musicGain.connect(this.musicVerb).connect(this.reverb);

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
    // Exhaust rasp: narrow, low noise that rides the revs. Built after the
    // noise buffer exists (below), so it is wired up there.

    // One second of white noise, looped by every noise sound. Built once.
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Exhaust: the rough edge under the tone, low and narrow.
    this.exhaust = this.#noiseVoice("bandpass", 120, 1.6, this.sfxGain);

    // Tyre squeal, in layers, all built once and running forever (a voice
    // that is never started or stopped cannot click; only its gain moves):
    //  - tonal: three detuned saws around 760-1100 Hz through a bandpass,
    //    the actual "screech";
    //  - wobble: two LFOs (5-12 Hz, re-aimed at random every quarter
    //    second) bend the pitch and the volume, so it sounds like rubber
    //    gripping and slipping rather than a steady beep;
    //  - texture: quiet bandpassed noise underneath, for grit;
    //  - a panner, so a slide to the left is heard on the left.
    // The last voice is a triangle an octave down: it gives the body.
    this.squealOsc = [1, 1.12, 1.27, 0.5].map((ratio, i) => {
      const o = c.createOscillator();
      o.type = i === 3 ? "triangle" : "sawtooth";
      o.frequency.value = 490 * ratio;
      o.detune.value = (i - 1) * 14;
      o.start();
      return { o, ratio };
    });
    const tonalSum = c.createGain();
    tonalSum.gain.value = 0.3;
    this.squealBand = c.createBiquadFilter();
    this.squealBand.type = "bandpass";
    this.squealBand.frequency.value = 700;
    this.squealBand.Q.value = 1.8; // wide, so it is full rather than a thin whistle
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
    gritBand.frequency.value = 1300;
    gritBand.Q.value = 0.8;
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

    // The recorded sounds, once there is a context to decode into. They
    // arrive a moment after the first click; until then, and for ever if
    // they fail, the synthesised versions play (see src/core/sfx.js).
    this.sfx = new Sfx();
    this.sfx.load(c);

    this.#applyGains();
    // setLevel() may have been called before there was a context to build in.
    if (this.levelName) this.setLevel(this.levelName);
    if (this.opponentCount) this.setOpponents(this.opponentCount);
  }

  /**
   * A room's tail, made rather than loaded: noise that fades out along a
   * curve. Stereo, with the two sides built from different noise, which is
   * what makes the tail sound wide instead of like one point of sound.
   * `decay` is how sharply it dies — higher is a smaller room.
   */
  #impulse(seconds = 2.4, decay = 2.8) {
    const c = this.ctx;
    const n = Math.max(1, Math.floor(c.sampleRate * seconds));
    const buf = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** decay;
      }
    }
    return buf;
  }

  /**
   * Play a recorded one-shot, if we have that recording. Returns false
   * when we do not, so each caller can fall through to its synthesised
   * version — which is still there, and still what most players on a
   * broken connection will hear.
   */
  #sample(name, { vol = 1, rate = 1, pan = null, delay = 0 } = {}) {
    const buf = this.sfx?.get(name);
    if (!buf) return false;
    const c = this.ctx;
    const t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = vol;
    const p = c.createStereoPanner();
    p.pan.value = pan ?? (Math.random() - 0.5) * 0.3;
    src.connect(g).connect(p).connect(this.sfxGain);
    src.start(t);
    return true;
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
    // The engine: rev range within a gear, not a line from road speed.
    // Crossing a gear drops the note the way a real shift does.
    const { rpm } = revsAt(speed);
    const throttle = clamp01(drive.throttle ?? 1);
    const f = 32 + rpm * 150; // firing frequency, roughly idle to redline
    // Quick, but not instant: a shift should land, not teleport.
    this.engine.frequency.setTargetAtTime(f, t, 0.05);
    this.engine2.frequency.setTargetAtTime(f, t, 0.05);
    this.engineSub.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    // Under load it opens up and hardens; off the throttle it closes to a
    // softer overrun, which is most of what makes an engine sound driven
    // rather than played.
    const open = 240 + rpm * 1500 + throttle * 420;
    this.engineFilter.frequency.setTargetAtTime(open, t, 0.07);
    const drive_ = 0.55 + throttle * 0.45;
    this.engineGain.gain.setTargetAtTime(active ? (0.05 + rpm * 0.16) * drive_ : 0, t, 0.1);
    // Exhaust: a low, rough edge that comes up with the revs and the
    // throttle. Kept well under 400 Hz — this is rumble, not hiss.
    if (this.exhaust) {
      this.exhaust.gain.gain.setTargetAtTime(active ? (0.03 + rpm * 0.1) * throttle : 0, t, 0.1);
      this.exhaust.filter.frequency.setTargetAtTime(90 + rpm * 230, t, 0.08);
    }

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
    // (No low-health beep. A repeating alarm over the last third of the
    // condition bar nagged for as long as the damage lasted, which is
    // most of a bad race. The bar itself, the smoke and the dented
    // panels already say the car is hurt.)

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
    const base = 450 + clamp01(drift) * 180 + clamp01(squealSpeed / 60) * 40;
    for (const v of this.squealOsc) v.o.frequency.setTargetAtTime(base * v.ratio, t, 0.06);
    this.squealBand.frequency.setTargetAtTime(base * 1.1, t, 0.08);
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
        if (on) this.#play("tyre-chirp", [{ type: "sawtooth", freq: 700 + drift * 280, to: 1600, dur: 0.07, vol: 0.2 }]);
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
    const stepSec = 60 / m.bpm / 4; // a 16th note
    if (seq.nextT === 0) seq.nextT = t + 0.1;
    while (seq.nextT < t + 0.25) {
      if (this.music) this.#step(m, seq.step, seq.nextT, stepSec, bus);
      seq.step++;
      seq.nextT += stepSec;
    }
  }

  /** One 16th note of a track: drums, bass, arpeggio and (on the bar) a pad. */
  #step(m, step, when, stepSec, bus) {
    const i = step % STEPS_PER_BAR;
    // Eight bars before anything repeats: the progression twice, the
    // second pass an octave up.
    const bar = Math.floor(step / STEPS_PER_BAR) % (m.chords.length * 2);
    const chord = m.chords[bar % m.chords.length];
    const high = bar >= m.chords.length;

    const d = m.drums;
    if (d) {
      if (d.kick[i]) this.#kick(when, bus);
      if (d.clap[i]) this.#clap(when, bus);
      if (d.hat[i]) this.#hat(when, bus, i === STEPS_PER_BAR - 1); // open on the last 16th
      const b = d.bass[i];
      if (b) this.#bassNote(chord.root + (b === 2 ? 12 : 0), when, stepSec * 1.7, bus);
    } else if (i === 0) {
      this.#bassNote(chord.root, when, stepSec * 10, bus, 0.3);
    }

    if (step % m.arpEvery === 0) {
      const n = chord.notes[(step / m.arpEvery) % chord.notes.length];
      this.#leadNote(n + (high ? 12 : 0), when, stepSec * m.arpEvery * 0.9, bus, {
        vol: m.leadVol,
        type: m.leadType,
        pan: ((step / m.arpEvery) % 2 ? 1 : -1) * 0.35, // the figure alternates sides
      });
    }

    if (i === 0) this.#padChord(chord.notes, when, stepSec * STEPS_PER_BAR, bus, m.padVol);
  }

  /** Kick: a sine dropped fast in pitch. The whole floor of the track. */
  #kick(when, bus, vol = 0.9) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(132, when);
    o.frequency.exponentialRampToValueAtTime(45, when + 0.1);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.26);
    o.connect(g).connect(bus);
    o.start(when);
    o.stop(when + 0.3);
  }

  /** Clap: a band of noise, short. The backbeat. */
  #clap(when, bus, vol = 0.35) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1700;
    bp.Q.value = 1.1;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.17);
    src.connect(bp).connect(g).connect(bus);
    src.start(when, Math.random() * 0.8); // a different slice of noise each time
    src.stop(when + 0.2);
  }

  /** Hat: a tick of high noise, off the beat. */
  #hat(when, bus, open = false, vol = 0.14) {
    const c = this.ctx;
    const dur = open ? 0.16 : 0.035;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7200;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(hp).connect(g).connect(bus);
    src.start(when, Math.random() * 0.8);
    src.stop(when + dur + 0.02);
  }

  /**
   * Bass: two saws pulled apart by a few cents through a resonant lowpass
   * that closes as the note decays. The detuning is what gives it weight,
   * and the closing filter is what makes it move instead of just sitting.
   */
  #bassNote(midi, when, dur, bus, vol = 0.42) {
    const c = this.ctx;
    const f = mtof(midi);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 7;
    lp.frequency.setValueAtTime(Math.min(f * 10, 2600), when);
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 2, 70), when + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    for (const cents of [-8, 8]) {
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.detune.value = cents;
      o.connect(lp);
      o.start(when);
      o.stop(when + dur + 0.03);
    }
    lp.connect(g).connect(bus);
  }

  /** The arpeggio on top: detuned, filtered, and placed off to one side. */
  #leadNote(midi, when, dur, bus, { vol = 0.2, type = "sawtooth", pan = 0 } = {}) {
    const c = this.ctx;
    const f = mtof(midi);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(f * 7, when);
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 2, 200), when + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const p = c.createStereoPanner();
    p.pan.value = pan;
    for (const cents of [-9, 9]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = cents;
      o.connect(lp);
      o.start(when);
      o.stop(when + dur + 0.03);
    }
    lp.connect(g).connect(p).connect(bus);
  }

  /** The pad: the chord held under everything, wide and slow to arrive. */
  #padChord(notes, when, dur, bus, vol = 0.1) {
    if (vol <= 0) return;
    const c = this.ctx;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + dur * 0.45); // slow swell
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur * 1.25);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1500;
    notes.forEach((midi, k) => {
      const p = c.createStereoPanner();
      p.pan.value = (k / Math.max(1, notes.length - 1)) * 1.2 - 0.6; // spread across the stereo field
      for (const cents of [-11, 11]) {
        const o = c.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = mtof(midi);
        o.detune.value = cents;
        o.connect(p);
        o.start(when);
        o.stop(when + dur * 1.3);
      }
      p.connect(lp);
    });
    lp.connect(g).connect(bus);
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

  /** Pointer moves onto a button: a tiny, quiet tick. */
  hover() {
    this.#play("button-hover", [{ type: "triangle", freq: 940, dur: 0.04, vol: 0.12 }]);
  }

  /** Back / resume / close: two falling notes, the opposite of the rising click feel. */
  back() {
    this.#play("button-back", [
      { type: "triangle", freq: 560, dur: 0.07, vol: 0.3 },
      { type: "triangle", freq: 400, dur: 0.1, vol: 0.3, delay: 0.06 },
    ]);
  }

  click() {
    if (!this.canPlay("click")) return;
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
    if (!this.canPlay(name)) return;
    this.#log(name);
    for (const n of notes) this.#blip(n);
  }

  /**
   * Can a sound actually be HEARD right now? Says why not, in the log.
   *
   * The suspended case is the one that matters. A browser can leave the
   * context suspended (autoplay policy, a tab switch, a gesture it did
   * not count), and anything scheduled into a stopped clock makes no
   * sound — but this used to resume() and then log and schedule anyway,
   * so the console read exactly like a game that was playing perfectly
   * while nothing came out of the speakers. Now it asks to resume and
   * says plainly that it could not play, which is the difference between
   * a silent game and a silent game you can diagnose.
   */
  canPlay(name) {
    if (!this.ctx) {
      this.#log(name, "(skipped: audio not unlocked yet — click the page)");
      return false;
    }
    if (!this.sound) {
      this.#log(name, "(skipped: Sound is off in Settings)");
      return false;
    }
    if (this.ctx.state !== "running") {
      this.ctx.resume?.(); // ask again — it may be allowed by now
      this.#log(name, `(skipped: the browser has audio ${this.ctx.state} — click the page)`);
      return false;
    }
    return true;
  }

  /**
   * One short synth note on the sfx bus. `freq` glides to `to` over `dur`;
   * `delay` offsets it so a few of these make an arpeggio or a stab.
   * Gain ramps start and end at 0.0001 (an exponential ramp cannot touch
   * 0), and the start time is never earlier than "now".
   */
  #blip({ type = "square", freq, to = freq, dur = 0.12, vol = 0.3, delay = 0, pan = null, detune = 7, sub = 0 }) {
    const c = this.ctx;
    const t = Math.max(c.currentTime, c.currentTime + delay) + 0.005;
    const peak = Math.max(vol, 0.0002);
    // A little off true, differently each time. Identical repeats stop
    // registering as a sound and start registering as a beep.
    const wobble = 1 + (Math.random() - 0.5) * 0.016;
    const f0 = freq * wobble;
    const f1 = Math.max(to * wobble, 1);

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // The tone closes as the sound decays, the way a real one does. A
    // fixed timbre for the whole of a sound's life is most of what made
    // these read as flat.
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(Math.min(Math.max(f0, f1) * 6, 18000), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(Math.min(f0, f1) * 2, 180), t + dur);
    const p = c.createStereoPanner();
    p.pan.value = pan ?? (Math.random() - 0.5) * 0.3; // a touch of width

    // Two voices a few cents apart, which is the whole difference between
    // a tone and an instrument.
    for (const cents of detune ? [-detune, detune] : [0]) {
      const o = c.createOscillator();
      o.type = type;
      o.detune.value = cents;
      o.frequency.setValueAtTime(f0, t);
      if (to !== freq) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    if (sub > 0) {
      const o = c.createOscillator();
      const sg = c.createGain();
      sg.gain.value = sub;
      o.type = "sine";
      o.frequency.setValueAtTime(f0 / 2, t);
      if (to !== freq) o.frequency.exponentialRampToValueAtTime(f1 / 2, t + dur);
      o.connect(sg).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    lp.connect(g).connect(p).connect(this.sfxGain);
  }

  /**
   * A filtered noise burst on the sfx bus: the crunch of a crash, the
   * rumble of a rock. The lowpass sweeps from `from` Hz down to `to` Hz
   * over `dur`, so a bigger, slower sound is also a duller one.
   */
  #burst({ vol, from, to, dur, delay = 0, pan = null }) {
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
    const p = c.createStereoPanner();
    p.pan.value = pan ?? (Math.random() - 0.5) * 0.4;
    src.connect(lp).connect(g).connect(p).connect(this.sfxGain);
    src.start(t, Math.random() * 0.8); // a different slice of the noise each time
    src.stop(t + dur + 0.05);
  }

  /**
   * A crash, sized 0..1 by how hard the hit was: a noise burst (the
   * crunch, duller and longer the harder it is) over a low sine thud. A
   * graze is a tick; a head-on is a boom.
   */
  crash(severity = 0.5) {
    const k = clamp01(severity);
    if (!this.canPlay("crash")) return;
    // A scrape along a wall reports a string of tiny hits; sound only the
    // ones that matter, and never more than a few a second.
    const now = this.ctx.currentTime;
    if (k < 0.06 || (now - this.lastCrash < 0.25 && k < this.lastCrashK + 0.2)) return;
    this.lastCrash = now;
    this.lastCrashK = k;
    this.#log("crash", `severity=${k.toFixed(2)}`);
    // The recorded crash is a glancing scrape, so it plays for the hits
    // it suits — pitched down and louder the harder it is — while the
    // biggest impacts keep the synthesised crunch, which has more weight
    // than this recording does.
    if (k < 0.75 && this.#sample("crash", { vol: 0.5 + k * 0.5, rate: 1.1 - k * 0.3 })) return;
    // The crack of the moment of contact: very short, very bright. This is
    // the layer the ear reads as "hard", and it was the one missing — the
    // crunch and the thud alone land as a soft thump however loud.
    this.#burst({ vol: 0.3 + k * 0.5, from: 7500, to: 1800, dur: 0.035 });
    // the crunch, duller and longer the harder it is
    this.#burst({ vol: 0.4 + k * 0.6, from: 3500 - k * 2200, to: 200, dur: 0.15 + k * 0.5 });
    // the thud through the floor, with a sub under it
    this.#blip({ type: "sine", freq: 130 - k * 50, to: 40, dur: 0.2 + k * 0.3, vol: 0.4 + k * 0.5, detune: 0, sub: 0.6 });
    // a real hit throws pieces: a few metallic ticks scattered after it
    if (k > 0.45) {
      const bits = 2 + Math.round(k * 4);
      for (let i = 0; i < bits; i++) {
        this.#burst({ vol: 0.1 + k * 0.14, from: 6000 + Math.random() * 4000, to: 1200, dur: 0.03 + Math.random() * 0.05, delay: 0.06 + Math.random() * (0.25 + k * 0.4) });
      }
    }
  }

  /** A boulder landing somewhere: a deep rumble, louder the closer it is. */
  rockLanded(distance = 60) {
    if (!this.canPlay("rock-landed")) return;
    const near = clamp01(1 - distance / 160);
    this.#log("rock-landed", `distance=${Math.round(distance)}m`);
    // A recording of stone, if we have one: this is the sound synthesis
    // is worst at, and the one that could not be heard at all before.
    if (this.#sample("rock", { vol: 0.35 + near * 0.75, rate: 0.92 + Math.random() * 0.16 })) return;
    // This used to be a 600->50 Hz sweep over a 70->30 Hz sine, which is
    // almost entirely below what a laptop or a phone can reproduce — a
    // boulder could land beside you and be inaudible. The weight is still
    // down there for anyone with the speakers for it, but the sound now
    // has a body in the mids, where it can actually be heard.
    //
    // the strike: stone meeting road
    this.#burst({ vol: 0.5 + near * 0.5, from: 1800, to: 400, dur: 0.12 });
    // the mass of it, in the register every speaker reaches
    this.#blip({ type: "triangle", freq: 190, to: 72, dur: 0.45, vol: 0.4 + near * 0.5, detune: 9, sub: 0.5 });
    // the weight underneath
    this.#blip({ type: "sine", freq: 80, to: 34, dur: 0.75, vol: 0.22 + near * 0.5, detune: 0 });
    // scree: the stones still coming down after it
    const bits = 3 + Math.round(near * 5);
    for (let i = 0; i < bits; i++) {
      this.#burst({
        vol: 0.1 + near * 0.2,
        from: 1400 + Math.random() * 900,
        to: 400,
        dur: 0.04 + Math.random() * 0.06,
        delay: 0.09 + Math.random() * 0.7,
      });
    }
    // and the roll of it away down the slope
    this.#whoosh({ from: 320, to: 120, dur: 1.2, vol: 0.18 + near * 0.3, q: 0.8, swell: 0.3, delay: 0.06 });
  }

  /** The player's car meeting a settled rock: a sharp stony crack over the crash. */
  rockHit() {
    if (!this.canPlay("rock-hit-car")) return;
    this.#log("rock-hit-car");
    this.#burst({ vol: 0.85, from: 3200, to: 300, dur: 0.35 });
  }

  // (Passing a checkpoint makes no sound — see the note in main.js.)

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

  /**
   * Boost on: a turbo coming on song, in four layers rather than one
   * sweep — the shove you feel, the spool you hear, the tone that carries
   * the pitch, and a crack of ignition on top. One sawtooth sweep did the
   * job of all four and sounded like a test tone.
   */
  boostStarted() {
    if (!this.canPlay("boost-started")) return;
    // However the car's boost is switched, the sound of it starting is a
    // big layered noise and must not stack: a quarter of a second between
    // two of them is already faster than anyone taps the button.
    const now = this.ctx.currentTime;
    if (now - this.lastBoostAt < 0.25) return void this.#log("boost-started", "(skipped: too soon after the last)");
    this.lastBoostAt = now;
    this.#log("boost-started");
    // the shove: a short, low thump under everything
    this.#blip({ type: "sine", freq: 110, to: 42, dur: 0.22, vol: 0.5 });
    // the spool: noise climbing and opening up
    this.#whoosh({ from: 320, to: 3200, dur: 0.46, vol: 0.3, q: 0.9, swell: 0.75 });
    // the tone: the sweep that was already there, now with a sub under it
    this.#blip({ type: "sawtooth", freq: 150, to: 940, dur: 0.42, vol: 0.26, sub: 0.5, detune: 12 });
    // ignition, right at the front
    this.#burst({ vol: 0.3, from: 7000, to: 1800, dur: 0.07 });
  }

  /** Boost off: the sweep falling away, and the blow-off hiss after it. */
  boostStopped() {
    if (!this.canPlay("boost-stopped")) return;
    this.#log("boost-stopped");
    this.#blip({ type: "sawtooth", freq: 620, to: 120, dur: 0.3, vol: 0.16, detune: 10 });
    // the valve letting go: bright, short, and gone
    this.#whoosh({ from: 4200, to: 900, dur: 0.3, vol: 0.26, q: 1.1, swell: 0.12, delay: 0.04 });
  }

  /** Pickup: a sparkly high chirp that jumps an octave. */
  pickup() {
    if (!this.canPlay("pickup")) return;
    this.#log("pickup");
    if (this.#sample("pickup", { vol: 0.5, rate: 0.98 + Math.random() * 0.06 })) return;
    // A rising figure rather than one chirp, each note a little louder,
    // so it reads as something being taken in rather than a blip.
    //
    // An octave and a bit lower than it was. The figure used to run
    // 1.3-2.6 kHz with a shimmer sweeping to 5.3 kHz over it, which is
    // squarely in the register the ear finds shrill — and it fires every
    // few seconds on a lap full of orbs. A C major triad from C5 is warm,
    // still bright against the engine, and does not pierce. The noise
    // sparkle that sat on top is gone with it: it lived at 9 kHz.
    [72, 76, 79].forEach((m, i) =>
      this.#blip({ type: "triangle", freq: mtof(m), dur: 0.13, vol: 0.26 + i * 0.05, delay: i * 0.045, detune: 5 })
    );
    // the shimmer it leaves behind, an octave down too
    this.#blip({ type: "sine", freq: mtof(84), to: mtof(88), dur: 0.5, vol: 0.13, delay: 0.14, detune: 14 });
  }

  /** One start lamp lit: a short, flat F1-style beep, the same pitch each time. */
  startLight(lamp = 1) {
    this.#play(`start-light ${lamp}`, [{ type: "square", freq: mtof(81), dur: 0.16, vol: 0.4 }]);
  }

  /** Lights out: a higher, longer "GO" tone, with a fifth above it for bite. */
  raceStarted() {
    this.#play("race-started", [
      { type: "square", freq: mtof(81), dur: 0.7, vol: 0.45 },
      { type: "sawtooth", freq: mtof(88), dur: 0.7, vol: 0.2 },
    ]);
  }

  /**
   * Engine rev as the lights go out: the motor winds up hard and settles
   * back. Two detuned saws through a lowpass that opens as the revs rise.
   */
  engineRev() {
    if (!this.canPlay("engine-rev")) return;
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
      // 880/1319 rather than 1760/2637: this lands moments after a boost
      // orb, so it was heard as part of the same shrill chirp.
      { type: "sine", freq: 880, dur: 0.5, vol: 0.32 },
      { type: "sine", freq: 1319, dur: 0.35, vol: 0.14 },
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
    if (!this.canPlay("landing")) return;
    const k = clamp01((airTime - 0.25) / 1.5);
    this.#log("landing", `air=${airTime.toFixed(2)}s`);
    this.#burst({ vol: 0.2 + k * 0.5, from: 900, to: 80, dur: 0.18 + k * 0.2 });
    this.#blip({ type: "sine", freq: 110 - k * 40, to: 38, dur: 0.18 + k * 0.25, vol: 0.4 + k * 0.5 });
  }

  /** Respawn: a rising whoosh with a soft shimmer, the car being put back. */
  respawn() {
    if (!this.canPlay("respawn")) return;
    this.#log("respawn");
    this.#whoosh({ from: 250, to: 3200, dur: 0.6, vol: 0.55, q: 1.2, swell: 0.7 });
    this.#blip({ type: "sine", freq: mtof(76), to: mtof(88), dur: 0.4, vol: 0.18 });
  }

  /** A traffic car whipping past: a quick falling whoosh, louder the closer and faster. */
  nearMiss(side = 3, speed = 20) {
    if (!this.canPlay("near-miss")) return;
    const k = clamp01(1 - side / 5.5) * 0.6 + clamp01(speed / 50) * 0.4;
    this.#log("near-miss", `side=${side.toFixed(1)}m closing=${Math.round(speed)}m/s`);
    this.#whoosh({ from: 2200, to: 450, dur: 0.4, vol: 0.12 + k * 0.5, q: 0.9, swell: 0.3 });
  }

  /** Crowd at the finish: a swell of noise, claps and two whoops. Bigger for a win. */
  cheer(position = 1) {
    if (!this.canPlay("crowd-cheer")) return;
    const k = position === 1 ? 1 : 0.55;
    this.#log("crowd-cheer", `position=${position}`);
    this.#whoosh({ from: 900, to: 1500, dur: 2.6, vol: 0.4 * k, q: 0.5, swell: 0.25 });
    this.#whoosh({ from: 2600, to: 3200, dur: 2.2, vol: 0.12 * k, q: 0.7, swell: 0.3 });
    // scattered claps, then two whoops
    for (let i = 0; i < 10; i++) this.#burst({ vol: 0.16 * k, from: 4500, to: 1500, dur: 0.05, delay: 0.1 + Math.random() * 1.8 });
    this.#blip({ type: "sine", freq: 520, to: 900, dur: 0.45, vol: 0.12 * k, delay: 0.3 });
    this.#blip({ type: "sine", freq: 640, to: 1100, dur: 0.5, vol: 0.1 * k, delay: 0.8 });
  }

  /**
   * Play a test sound and report, in words, what actually happened.
   *
   * Someone who cannot hear the game needs to know which of three things
   * is wrong — the game, the browser, or their speakers — and the console
   * is not where most people look. This plays a clear two-note chime and
   * MEASURES the signal leaving the final stage, so "the game is making
   * sound" is a reading rather than a hope. If sound is coming out of the
   * graph and still cannot be heard, the fault is past the browser: the
   * tab is muted, the app is turned down in the system mixer, or the
   * output is going somewhere else.
   *
   * @returns {{ok: boolean, text: string}}
   */
  async testSound() {
    this.unlock();
    if (!this.ctx) return { ok: false, text: "This browser has no Web Audio at all." };
    if (!this.sound) return { ok: false, text: "Sound is switched off here — turn it on above." };
    if (this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch { /* the browser said no */ }
      if (this.ctx.state !== "running") {
        return { ok: false, text: `The browser is holding audio ${this.ctx.state}. Click the page, then try again.` };
      }
    }
    // Listen to our own output while the chime plays.
    const an = this.ctx.createAnalyser();
    an.fftSize = 2048;
    this.limiter.connect(an);
    const buf = new Float32Array(an.fftSize);
    const level = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      return Math.sqrt(s / buf.length);
    };
    this.#log("sound-test");
    for (const [m, d] of [[76, 0], [83, 0.14]]) {
      this.#blip({ type: "triangle", freq: mtof(m), dur: 0.3, vol: 0.5, delay: d, detune: 8 });
    }
    let peak = 0;
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 40));
      peak = Math.max(peak, level());
    }
    this.limiter.disconnect(an);
    this.#log("sound-test", `peak=${peak.toFixed(4)}`);
    if (peak < 0.002) {
      return { ok: false, text: "The game made no sound at all — that is a bug here, not your speakers." };
    }
    return {
      ok: true,
      text: `Sound is leaving the game (level ${peak.toFixed(2)}). If you heard nothing, it is past the browser: check the tab is not muted, and Chrome's own volume in the Windows volume mixer.`,
    };
  }

  /**
   * A spoken line, through the browser's own speech synthesis.
   *
   * Not Web Audio at all, so it does not pass through the buses, the
   * reverb, the pause muffle or the limiter — which also means the Sound
   * toggle has to be honoured here by hand. There is no audio file and no
   * voice shipped with the game, so there is still nothing to credit.
   *
   * A browser with no voices installed simply says nothing: every line
   * spoken is also on screen, so silence costs the player no information.
   */
  say(text, { rate = 0.95, pitch = 0.85, delay = 0 } = {}) {
    if (!this.sound) return void this.#log("announce", "(skipped: Sound is off)");
    const synth = typeof window !== "undefined" && window.speechSynthesis;
    if (!synth) return void this.#log("announce", "(skipped: no speech synthesis here)");
    const speak = () => {
      try {
        synth.cancel(); // one announcement at a time; a new one replaces the last
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate;
        u.pitch = pitch;
        u.volume = 0.95;
        // An English voice if there is one, otherwise whatever is default.
        const voice = synth.getVoices?.().find((v) => /^en([-_]|$)/i.test(v.lang));
        if (voice) u.voice = voice;
        synth.speak(u);
        this.#log("announce", `"${text}"`);
      } catch (err) {
        this.#log("announce", `(failed: ${err.message})`);
      }
    };
    if (delay > 0) setTimeout(speak, delay * 1000);
    else speak();
  }

  /**
   * The result of the Grand Prix, spoken over the line. A podium is the
   * mission: the prize money for the top three is what the garage needed.
   * @param {number} position  1 for the winner
   */
  announceFinish(position) {
    const place = PLACES[position] ?? `in position ${position}`;
    const podium = position >= 1 && position <= 3;
    // A recorded voice for the podium, where there is one line to say and
    // a real voice can say it. It REPLACES the spoken line rather than
    // following it: two voices reading the same result, one of them a
    // speech synthesiser, is worse than either alone.
    //
    // Anywhere else the result has to be read out loud — the position
    // changes, so no recording can cover it — and the browser's own voice
    // does that, as it did before.
    if (podium && this.sound && this.#sample("voicePodium", { vol: 0.95, pan: 0, delay: 1.2 })) {
      this.#log("announce", `(recorded podium line, position ${position})`);
      return;
    }
    // After the crowd, not over it.
    this.say(podium ? `You finished ${place}. Mission accomplished.` : `You finished ${place}.`, { delay: 1.2 });
  }

  /** The Grand Prix ended without the player finishing: no place to read out. */
  announceFailed() {
    this.say("You did not finish. Mission failed.", { delay: 0.8 });
  }

  /** A new personal best lap: a bright two-step fanfare with a sparkle on top. */
  newBest() {
    // Starts 0.45 s late so it lands after the lap-complete arpeggio.
    this.#play("new-best-lap", [
      { type: "square", freq: mtof(79), dur: 0.12, vol: 0.3, delay: 0.45 },
      { type: "square", freq: mtof(84), dur: 0.12, vol: 0.3, delay: 0.55 },
      { type: "triangle", freq: mtof(79), dur: 0.5, vol: 0.35, delay: 0.65 },
      { type: "sine", freq: mtof(91), dur: 0.45, vol: 0.16, delay: 0.71 },
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
    // How much room each level sits in: the mountain is open air and a
    // valley, the city is a street with walls close by, the circuit at
    // night is wide and mostly empty.
    const space = { city: 0.13, mountain: 0.3, grandprix: 0.2 }[name] ?? 0.16;
    this.sfxVerb.gain.setTargetAtTime(space, t, 0.5);

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
    // Traffic, heard from inside it: low, and breathing rather than flat.
    //
    // There used to be a second layer of noise bandpassed at 2.6 kHz with
    // a Q of 0.6 — which is hardly a filter at all, so what came through
    // was a wide band of constant high hiss. Steady broadband noise in
    // that register is the sound of RAIN, and that is what it was heard
    // as. A city does not hiss; it rumbles and it swells. So the hiss is
    // gone and what is left is low, with a slow rise and fall under it
    // like traffic coming and going.
    const hum = this.#noiseVoice("lowpass", 340, 0.7, amb.gain);
    hum.gain.gain.value = 0.2;
    const swell = this.ctx.createOscillator();
    const depth = this.ctx.createGain();
    swell.frequency.value = 0.08; // a breath every 12 s or so
    depth.gain.value = 0.07;
    swell.connect(depth).connect(hum.gain.gain);
    swell.start();
    amb.sources.push(hum.src, swell);
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
    // Wind with no hiss in it.
    //
    // This used to be a wide band of noise around 500 Hz opening to 1.5
    // kHz in a gust, which is the same steady broadband hiss the City had
    // and read the same way. The gust still has to be HEARD — it is a
    // hazard, and the sound is the warning — so it is still noise, but
    // kept low and narrow: a moan that rises and falls rather than a
    // sheet of static. Nothing above a few hundred hertz survives the
    // lowpass, which is where the hiss lived.
    const wind = this.#noiseVoice("lowpass", 220, 0.9, amb.gain);
    const body = this.#noiseVoice("lowpass", 140, 0.7, amb.gain);
    amb.sources.push(wind.src, body.src);
    let gusting = false;
    amb.update = (t, active, speed, drive) => {
      const gust = clamp01(drive.wind ?? 0);
      const v = clamp01(speed / 50);
      wind.gain.gain.setTargetAtTime(0.06 + gust * 0.5 + v * 0.12, t, 0.15);
      // opens only into the low mids, never into the hiss register
      wind.filter.frequency.setTargetAtTime(150 + gust * 260 + v * 70, t, 0.2);
      body.gain.gain.setTargetAtTime(0.1 + gust * 0.5, t, 0.2);
      const strong = active && gust > 0.5;
      if (strong !== gusting) {
        gusting = strong;
        if (this.sound) this.#log(strong ? "mountain wind: gust" : "mountain wind: calm");
      }
    };
    return amb;
  }

  /** Grand Prix: a low pulsing drone under the faster night music. */
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
    // No standing crowd noise. It was a wide band around 900 Hz, left on
    // for the whole race, and that is hiss however quiet it is set. The
    // crowd is still there when it matters — it cheers you over the line
    // (see cheer()) — which is an event rather than a carpet of static.
    for (const o of [o1, o2, lfo]) o.start();
    amb.sources.push(o1, o2, lfo);
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
