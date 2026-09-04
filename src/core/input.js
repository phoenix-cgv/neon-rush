// Keyboard and mouse -> a plain control struct.
//
// The vehicle never sees a key. Three things produce this struct — the
// player, the Level 3 AI, and a recorded replay — so opponents and the
// ghost car come free from one code path. Nothing else may reach the
// vehicle.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Ramp `current` toward `target` at `rate` units per second. This is most
// of what turns a binary key into something that feels analogue.
function moveToward(current, target, rate, dt) {
  const delta = target - current;
  const maxStep = rate * dt;
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}

export const DEFAULT_BINDINGS = {
  throttle: ["KeyW", "ArrowUp"],
  brake: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  handbrake: ["Space"],
  boost: ["ShiftLeft", "ShiftRight"],
  camera: ["KeyC"],
  restart: ["KeyR"],
  debug: ["KeyG"],
  level: ["KeyL"],
  map: ["KeyM"],
  pause: ["Escape"],
};

export class Input {
  constructor(bindings = DEFAULT_BINDINGS) {
    this.bindings = bindings;
    this.sensitivity = 1;
    this.keys = new Set();
    this.pressedThisFrame = new Set();

    // Smoothed axes — what the vehicle actually receives.
    this.controls = {
      throttle: 0,
      brake: 0,
      steer: 0,
      handbrake: false,
      boost: false,
      pitch: 0,
      roll: 0,
    };

    this.look = { x: 0, y: 0 }; // free-look offset, -1..1
    this.pointerLocked = false;

    this._onKeyDown = (e) => {
      if (!this.keys.has(e.code)) this.pressedThisFrame.add(e.code);
      this.keys.add(e.code);
      // Stop the page scrolling out from under the game.
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear(); // alt-tab must not stick the throttle

    this._onMouseMove = (e) => {
      if (!this.pointerLocked) return;
      const k = 0.0025 * this.sensitivity;
      this.look.x = clamp(this.look.x + e.movementX * k, -1, 1);
      this.look.y = clamp(this.look.y + e.movementY * k, -0.6, 0.6);
    };

    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._onBlur);
    window.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement !== null;
    });
  }

  /** Swap in a rebound map from the options menu. */
  setBindings(b) {
    this.bindings = b || DEFAULT_BINDINGS;
  }

  #held(action) {
    return (this.bindings[action] ?? DEFAULT_BINDINGS[action] ?? []).some((c) =>
      this.keys.has(c)
    );
  }

  /** True once on the frame the key went down. */
  pressed(action) {
    return (this.bindings[action] ?? DEFAULT_BINDINGS[action] ?? []).some((c) =>
      this.pressedThisFrame.has(c)
    );
  }

  /**
   * @param {number} dt      render delta, for smoothing
   * @param {boolean} airborne  Level 2 remaps the same keys in the air
   */
  update(dt, airborne = false) {
    const c = this.controls;

    const up = this.#held("throttle") ? 1 : 0;
    const down = this.#held("brake") ? 1 : 0;
    const left = this.#held("left") ? 1 : 0;
    const right = this.#held("right") ? 1 : 0;

    if (airborne) {
      // In the air the same keys become attitude control.
      c.pitch = down - up;
      c.roll = right - left;
      c.throttle = 0;
      c.brake = 0;
      c.steer = moveToward(c.steer, 0, 6, dt);
    } else {
      c.pitch = 0;
      c.roll = 0;
      // Release faster than application — lifting off should be instant,
      // getting on the power should not.
      c.throttle = moveToward(c.throttle, up, up ? 6.5 : 12, dt);
      c.brake = moveToward(c.brake, down, down ? 9 : 14, dt);
      c.steer = moveToward(c.steer, right - left, 5.5, dt);
    }

    c.handbrake = this.#held("handbrake");
    c.boost = this.#held("boost");

    // Free-look springs back to centre when the mouse is still.
    this.look.x = moveToward(this.look.x, 0, 0.8, dt);
    this.look.y = moveToward(this.look.y, 0, 0.8, dt);

    return c;
  }

  /** Call at the very end of the frame. */
  endFrame() {
    this.pressedThisFrame.clear();
  }

  dispose() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onBlur);
    window.removeEventListener("mousemove", this._onMouseMove);
  }
}
