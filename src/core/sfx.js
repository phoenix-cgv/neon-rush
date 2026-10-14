// ---------------------------------------------------------------------
// Recorded sound: the handful of things worth having a real recording of.
//
// Everything else in the game is still synthesised (src/core/audio.js).
// These are the sounds synthesis is worst at — a petrol engine, stone,
// a crash, rubber — and they are generated audio files, so unlike the
// rest of the audio they DO have to be credited (assets/credits.json).
//
// Nothing here is required. Every file is optional: if one fails to
// load, or the whole set does, `have()` reports false for it and
// audio.js falls back to the synthesised version it has always had. A
// missing or broken sound file must never be the reason the game has no
// sound.
//
// SEAMLESS LOOPS. Nothing here loops today, but `#seamless` is kept for
// when something does: generated clips almost always fade at one or both
// ends — measured on the engine takes, some sat at 0.58 of their own
// middle by the last 80 ms — and looping that gives a pulse once a
// second. It folds the tail back over the head with an equal-power
// crossfade and shortens the buffer to match.
// ---------------------------------------------------------------------

import rockUrl from "../../assets/audio/rock-landing.mp3?url";
import crashUrl from "../../assets/audio/crash.mp3?url";
import pickupUrl from "../../assets/audio/pickup.mp3?url";
import voicePodiumUrl from "../../assets/audio/voice-podium.mp3?url";

// One-shots only: things that HAPPEN, not things that are held.
//
// The engine and the tyre squeal were recordings too, briefly, and both
// came back out. A recording is a fixed moment of sound, and those two
// have to track the car continuously — the engine through its rev range
// and every gear change, the squeal with how far sideways the car is.
// Stretching one short loop across all of that does not line up with
// what the car is doing, and a synthesiser driven straight from the
// car's own state does. So those two stay generated in code
// (src/core/audio.js); what is left here is sound that is struck once
// and then over, where a recording is simply better.
const FILES = {
  rock: { url: rockUrl },
  crash: { url: crashUrl },
  pickup: { url: pickupUrl },
  voicePodium: { url: voicePodiumUrl },
};

export class Sfx {
  constructor() {
    this.buffers = {};
    this.loaded = false;
  }

  /** True once this sound is decoded and usable. */
  have(name) {
    return !!this.buffers[name];
  }

  get(name) {
    return this.buffers[name] ?? null;
  }

  /**
   * Fetch and decode everything, in parallel. Safe to call more than
   * once; safe to never call. Each file fails on its own, so one bad
   * download costs one sound rather than all of them.
   */
  async load(ctx) {
    if (this.loaded) return this;
    this.loaded = true;
    await Promise.all(
      Object.entries(FILES).map(async ([name, def]) => {
        try {
          const res = await fetch(def.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const raw = await ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers[name] = def.loop ? this.#seamless(ctx, raw, def.fade) : raw;
        } catch (err) {
          console.warn(`[sfx] ${name} not available, using the synthesised one instead:`, err.message);
        }
      })
    );
    const got = Object.keys(this.buffers).length;
    console.log(`[sfx] ${got}/${Object.keys(FILES).length} recorded sounds ready`);
    return this;
  }

  /**
   * A copy of `buf` that can be looped without a seam: the tail is
   * crossfaded over the head and the buffer shortened to match. An
   * equal-power fade (sin/cos), so the level holds across the join
   * instead of dipping through it.
   */
  #seamless(ctx, buf, fade) {
    const rate = buf.sampleRate;
    const n = Math.min(Math.floor(fade * rate), Math.floor(buf.length / 3));
    if (n < 64) return buf; // too short to be worth folding
    const len = buf.length - n;
    const out = ctx.createBuffer(buf.numberOfChannels, len, rate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = out.getChannelData(ch);
      dst.set(src.subarray(0, len));
      for (let i = 0; i < n; i++) {
        const k = (i / n) * (Math.PI / 2); // equal power across the join
        dst[i] = src[i] * Math.sin(k) + src[len + i] * Math.cos(k);
      }
    }
    return out;
  }
}
