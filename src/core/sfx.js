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
// SEAMLESS LOOPS. Generated clips almost always fade at one or both
// ends — measured on these: some sat at 0.58 of their own middle by the
// last 80 ms. Looping that gives a pulse once a second, which is worse
// than no sample at all. `#seamless` fixes it by folding the tail back
// over the head: the last `fade` seconds are crossfaded into the first,
// and the buffer is shortened by that much, so the join lands on
// matching material at matching level.
// ---------------------------------------------------------------------

import engineLowUrl from "../../assets/audio/engine-low.mp3?url";
import engineMidUrl from "../../assets/audio/engine-mid.mp3?url";
import engineHighUrl from "../../assets/audio/engine-high.mp3?url";
import rockUrl from "../../assets/audio/rock-landing.mp3?url";
import crashUrl from "../../assets/audio/crash.mp3?url";
import squealUrl from "../../assets/audio/tyre-squeal.mp3?url";
import pickupUrl from "../../assets/audio/pickup.mp3?url";
import voicePodiumUrl from "../../assets/audio/voice-podium.mp3?url";

// `loop` marks the ones that are held rather than struck, so only those
// pay for the crossfade. Engine clips are short, so they take a shorter
// fade — a long one would eat most of the clip.
const FILES = {
  engineLow: { url: engineLowUrl, loop: true, fade: 0.12 },
  engineMid: { url: engineMidUrl, loop: true, fade: 0.16 },
  engineHigh: { url: engineHighUrl, loop: true, fade: 0.16 },
  squeal: { url: squealUrl, loop: true, fade: 0.25 },
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
