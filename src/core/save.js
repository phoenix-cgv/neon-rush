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
  telemetry: true,
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
    // Earlier versions kept a ghost-car recording (~17 KB of controls)
    // with every best lap. The ghost is gone; keep the times, drop those.
    for (const rec of Object.values(data.records ?? {})) if (rec) delete rec.ghost;
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

  /** The stored best lap for one level, or null. */
  record(level) {
    return this.data.records?.[level] ?? { bestLap: null };
  },

  /** Store a lap if it beat this level's stored one. */
  submitLap(level, seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const prev = this.record(level);
    if (prev.bestLap !== null && seconds >= prev.bestLap) return false;
    this.data.records = this.data.records ?? {};
    this.data.records[level] = { bestLap: seconds };
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
