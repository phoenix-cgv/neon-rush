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
}
