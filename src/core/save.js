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
  // input
  bindings: null, // null = use DEFAULT_BINDINGS
  // Best lap per level, keyed by level name: a lap time only means
  // something on the track it was set on.
  records: {},
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const data = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    return data;
  } catch {
    return { ...DEFAULTS };
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

export const Save = {
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

  reset() {
    this.data = { ...DEFAULTS };
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
