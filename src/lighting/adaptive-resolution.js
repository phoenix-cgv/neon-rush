// ---------------------------------------------------------------------
// Adaptive resolution: keep the frame rate by lowering the resolution
// the 3D scene is drawn at, never by turning effects off.
//
// The game will be marked on lab machines nobody here has measured.
// Measured on an AMD integrated GPU at 1920x936, the Grand Prix tunnel
// takes 20.8 ms to draw on "high": more than a 60 Hz frame (16.7 ms)
// before any physics has run. Asking the marker to find the options menu
// is not a plan. Instead the game watches how long its own frames take
// and, when they run over, draws the scene at a lower internal
// resolution (the canvas stays the same size; the image is scaled up to
// fill it, slightly softer). With headroom, it climbs back.
//
// MEASURING. Two signals:
//   GPU time   a WebGL timer query around each frame's rendering, where
//              the browser has the extension (Chrome on Windows does).
//              This is what can see HEADROOM: a frame that takes 9 ms
//              of a 16.7 ms budget.
//   interval   the time between animation frames. Always available, but
//              pinned at the refresh interval whenever the game keeps up,
//              so it can only say "too slow", never "room to spare".
// The budget is the display's own refresh interval, learned from the
// shortest intervals seen, so a 144 Hz monitor gets a 6.9 ms budget and
// a 60 Hz one 16.7 ms.
//
// HYSTERESIS. Scaling down is quick (about 0.75 s over budget, -10%),
// scaling up is slow (3 s of clear headroom, +5%, and never within 4 s of
// a drop). Otherwise a frame that only just fits would go up, miss, come
// down and go up again, and the picture would visibly pump.
//
// It stands down while a level loads (a load is one long frame, not a
// slow GPU), while the menu is open, and in photo mode. The scale it
// settles on is kept across levels.
// ---------------------------------------------------------------------

const MIN_SCALE = 0.6; // never below 60% of the preset's resolution
const STEP_DOWN = 0.1;
const STEP_UP = 0.05;
const OVER = 0.92; // a frame over 92% of the budget counts as too slow
const ROOM = 0.65; // under 65% counts as headroom
const DOWN_AFTER = 0.75; // s of slow frames before stepping down
const UP_AFTER = 3; // s of headroom before stepping up
const UP_COOLDOWN = 4; // s after a step down before any step up

export class AdaptiveResolution {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {() => void} onChange  called after the pixel ratio changes
   *   (post-processing must resize its buffers)
   */
  constructor(renderer, onChange) {
    this.renderer = renderer;
    this.onChange = onChange;
    this.enabled = true;
    this.scale = 1;
    this.base = renderer.getPixelRatio(); // the quality preset's ratio
    this.refresh = 1 / 60; // s, learned
    this.slowFor = 0;
    this.roomFor = 0;
    this.sinceDown = UP_COOLDOWN;
    this.hold = 1.5; // s to ignore after start or a load
    this.gpuMs = null; // smoothed GPU time per frame, if measurable

    const gl = renderer.getContext();
    this.gl = gl;
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    this.queries = [];
    this.open = null;
  }

  /** The quality preset's pixel ratio; the scale applies on top of it. */
  setBase(ratio) {
    this.base = ratio;
    this.#apply();
  }

  /** Ignore frames for a while: a level load, a resume from the menu. */
  pause(seconds = 1.5) {
    this.hold = Math.max(this.hold, seconds);
    this.slowFor = this.roomFor = 0;
  }

  /** Bracket the frame's rendering. */
  begin() {
    // Not while disabled: the benchmark times frames with its own query,
    // and WebGL allows only one timer query open at a time.
    if (!this.enabled || !this.ext || this.open || this.queries.length > 4) return;
    this.open = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.open);
  }

  end() {
    if (!this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.queries.push(this.open);
    this.open = null;
  }

  /** Once per rendered frame, after end(), with the frame's interval in s. */
  update(dt) {
    // Collect finished GPU timings (they arrive a frame or two late).
    const gl = this.gl;
    while (this.queries.length && gl.getQueryParameter(this.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = this.queries.shift();
      if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.gpuMs = this.gpuMs === null ? ms : this.gpuMs + (ms - this.gpuMs) * 0.1;
      }
      gl.deleteQuery(q);
    }

    // The display's refresh interval: take any shorter interval at once
    // (a frame can be late, never early), and drift up only on intervals
    // within 15% of the estimate. Drifting toward ALL intervals would let
    // a long run of slow frames raise the budget until they looked fine.
    if (dt > 0.003 && dt < 0.05) {
      if (dt < this.refresh) this.refresh = dt;
      else if (dt < this.refresh * 1.15) this.refresh += (dt - this.refresh) * 0.01;
    }

    if (!this.enabled) return;
    if (this.hold > 0) {
      this.hold -= dt;
      return;
    }
    this.sinceDown += dt;

    const budget = this.refresh * 1000;
    const slow = this.gpuMs !== null ? this.gpuMs > budget * OVER : dt > this.refresh * 1.4;
    const room = this.gpuMs !== null && this.gpuMs < budget * ROOM;

    this.slowFor = slow ? this.slowFor + dt : 0;
    this.roomFor = room ? this.roomFor + dt : 0;

    if (this.slowFor > DOWN_AFTER && this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, +(this.scale - STEP_DOWN).toFixed(2));
      this.sinceDown = 0;
      this.#changed();
    } else if (this.roomFor > UP_AFTER && this.sinceDown > UP_COOLDOWN && this.scale < 1) {
      this.scale = Math.min(1, +(this.scale + STEP_UP).toFixed(2));
      this.#changed();
    }
  }

  #changed() {
    this.slowFor = this.roomFor = 0;
    this.gpuMs = null; // the old timing describes the old resolution
    this.hold = 0.3; // let the new size settle before judging it
    this.#apply();
  }

  #apply() {
    const ratio = this.base * (this.enabled ? this.scale : 1);
    if (Math.abs(this.renderer.getPixelRatio() - ratio) < 1e-3) return;
    this.renderer.setPixelRatio(ratio);
    this.onChange?.();
  }

  /** Switch adapting on or off (off restores the preset's full resolution). */
  setEnabled(on) {
    this.enabled = on;
    this.pause();
    this.#apply();
  }
}
