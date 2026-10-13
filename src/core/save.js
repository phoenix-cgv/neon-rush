// Persisted settings and records.
//
// Every read and write is wrapped: localStorage throws outright in a
// private window, when site data is blocked, and inside some embedded
// viewers. A settings store is not worth crashing the game over, so a
// failure here silently falls back to defaults.

const KEY = "neon-rush.v1";

export const DEFAULTS = {
  // assists — Level 2 may want autoLevel lower than the default
  autoLevel: 14000,
  wallAssist: 1.0,
  // feel
  mouseSensitivity: 1.0,
  // presentation
  quality: "high", // high | medium | low
  minimap: true,
  healthBar: true,
  telemetry: false,
  // audio
  music: true,
  sound: true,
  // input — which key family drives the car: "keys" (WASD), "arrows" or "both"
  controlScheme: "both",
  // furthest level reached, 1-based (City = 1)
  maxLevel: 1,
  // --- the story (src/core/story.js) --------------------------------
  // Purses banked, keyed by level. A level pays ONCE, the first time it
  // is won, so replaying cannot grind the repair bill down.
  earned: {},
  // Story cards already shown, keyed by "intro", a level name, or
  // "<level>-win" / "ending", so no card is ever shown twice.
  storySeen: {},
  // First-time teaching prompts already given (see story.js TUTORIALS).
  taught: {},
  bindings: null, // null = use DEFAULT_BINDINGS
  // Best lap per level, keyed by level name: a lap time only means
  // something on the track it was set on.
  records: {},
};

/**
 * Defaults plus whatever was stored. The maps (records, and the story's
 * earned / storySeen / taught) are rebuilt rather than taken from
 * DEFAULTS: shared out by reference they would be the SAME object every
 * time, and the first write would edit the defaults themselves.
 */
function fresh(stored) {
  return {
    ...DEFAULTS,
    records: {},
    earned: {},
    storySeen: {},
    taught: {},
    ...stored,
  };
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return fresh(raw ? JSON.parse(raw) : {});
  } catch {
    return fresh({});
  }
}

function write(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false; // quota, private mode, blocked storage — not fatal
  }
}

/** Whether this browser has saved settings yet (false on a first visit). */
function hasSaved() {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export const Save = {
  firstVisit: !hasSaved(),
  data: read(),

  get(k) {
    return this.data[k];
  },

  set(k, v) {
    this.data[k] = v;
    write(this.data);
  },

  /** The stored best lap for one level (and its ghost recording, if any), or null. */
  record(level) {
    return this.data.records?.[level] ?? { bestLap: null, ghost: null };
  },

  /**
   * Store a lap if it beat this level's stored one.
   * @param {object|null} ghost  a determinism.js recording ({ start, frames })
   *   of the lap just driven, kept alongside the time so the next visit can
   *   race it as a ghost car. Six bytes a frame — a 50 s lap is ~18 KB,
   *   comfortably inside localStorage.
   */
  submitLap(level, seconds, ghost = null) {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const prev = this.record(level);
    if (prev.bestLap !== null && seconds >= prev.bestLap) return false;
    this.data.records = this.data.records ?? {};
    this.data.records[level] = { bestLap: seconds, ghost };
    write(this.data);
    return true;
  },

  clearRecord(level) {
    if (!this.data.records?.[level]) return false;
    delete this.data.records[level];
    write(this.data);
    return true;
  },

  /**
   * Bank a level's purse, once. Returns the amount actually added, so the
   * caller knows whether this was the win that paid.
   */
  bank(level, amount) {
    this.data.earned = this.data.earned ?? {};
    if (this.data.earned[level]) return 0; // already paid for this one
    this.data.earned[level] = amount;
    write(this.data);
    return amount;
  },

  /** Has this story card been shown before? Marks it shown if not. */
  firstTime(key, group = "storySeen") {
    this.data[group] = this.data[group] ?? {};
    if (this.data[group][key]) return false;
    this.data[group][key] = true;
    write(this.data);
    return true;
  },

  reset() {
    this.data = fresh({});
    write(this.data);
  },
};

export const QUALITY = {
  // bloom   the post-processing pass (src/lighting/post.js)
  // lights  share of each light pool's real lights kept (src/lighting/
  //         light-pool.js). Real lights are the dearest thing in the frame:
  //         measured in the Grand Prix tunnel (AMD integrated GPU) the six
  //         pool lights cost 3.9 ms of 14.6, against 0.7 for all post.
  //         Medium halves them; low keeps the glowing fixtures but none
  //         of their light on the road.
  // detail  the generated normal maps (src/lighting/surface-detail.js)
  // Without `lights`, medium was no cheaper than high on a screen at
  // pixel ratio 1: the two differed only in a resolution cap that never
  // applied and the shadow map's size.
  high: { pixelRatio: 1.5, shadows: true, shadowMap: 2048, bloom: true, lights: 1, detail: true },
  medium: { pixelRatio: 1.0, shadows: true, shadowMap: 1024, bloom: true, lights: 0.5, detail: true },
  low: { pixelRatio: 0.75, shadows: false, shadowMap: 512, bloom: false, lights: 0, detail: false },
};
