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
  telemetry: true,
  // input
  bindings: null, // null = use DEFAULT_BINDINGS
  // Records, keyed by level name. A ghost is a recording of a specific
  // track: replaying a Sprint lap on the Circuit would send it straight
  // through a barrier, so one global best lap is not a record, it is a
  // category error.
  records: {},
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
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

  /** The stored best lap and ghost for one level, or nulls. */
  record(level) {
    return this.data.records?.[level] ?? { bestLap: null, ghost: null };
  },

  /**
   * Store a lap if it beat this level's stored one. The ghost is kept
   * with it, so the recording on disk is always the lap the time
   * belongs to rather than whatever happened to be recorded last.
   */
  submitLap(level, seconds, recording) {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const prev = this.record(level);
    if (prev.bestLap !== null && seconds >= prev.bestLap) return false;
    this.data.records = this.data.records ?? {};
    this.data.records[level] = {
      bestLap: seconds,
      ghost: recording ?? prev.ghost ?? null,
    };
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
  high: { pixelRatio: 1.5, shadows: true, shadowMap: 2048 },
  medium: { pixelRatio: 1.0, shadows: true, shadowMap: 1024 },
  low: { pixelRatio: 0.75, shadows: false, shadowMap: 512 },
};
