import * as THREE from "three";
import { CAR } from "../vehicle/config.js";

// Debug tooling — section 9 of the design document.
//
// Half a day of this turns tuning from "change a number, drive, feel
// something, guess" into engineering. With five people waiting on this
// module, that is where a week would otherwise disappear.
//
// The friction circle readout is the one to watch: all four wheels near
// 1.0 through a corner means the car is at its limit and the balance is
// right. One pinned at 1.0 with another at 0.2 is a load transfer problem.

const FORCE_SCALE = 1 / 4000; // metres of arrow per newton

export class DebugOverlay {
  constructor(scene) {
    this.visible = true;

    // --- 3D force vectors --------------------------------------------
    this.group = new THREE.Group();
    this.group.name = "DebugForces";
    scene.add(this.group);

    const mk = (color) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
      line.renderOrder = 999;
      line.frustumCulled = false;
      this.group.add(line);
      return line;
    };

    this.lines = CAR.wheels.map(() => ({
      ray: mk(0x8899a6), // suspension ray
      load: mk(0x3fa9f5), // normal force
      long: mk(0x4ecb71), // longitudinal
      lat: mk(0xe2564a), // lateral
    }));

    // --- HTML telemetry ----------------------------------------------
    this.el = document.createElement("div");
    this.el.style.cssText = `
      position:fixed; top:12px; left:12px; z-index:10;
      font:11px/1.55 "Cascadia Mono",Consolas,monospace;
      color:#dbe4e6; background:rgba(10,16,18,.82);
      border:1px solid rgba(120,150,160,.28); border-radius:3px;
      padding:10px 12px; white-space:pre; pointer-events:none;
      text-shadow:0 1px 2px rgba(0,0,0,.7); min-width:290px;`;
    document.body.appendChild(this.el);
  }

  /** @returns {boolean} the new state, so a caller can persist it. */
  toggle() {
    return this.setVisible(!this.visible);
  }

  setVisible(v) {
    this.visible = !!v;
    this.group.visible = this.visible;
    this.el.style.display = this.visible ? "block" : "none";
    return this.visible;
  }

  #setLine(line, from, dir, scale) {
    // A non-finite value here poisons the geometry's bounding sphere and
    // three.js complains once per frame. Debug drawing must never be the
    // thing that breaks the frame.
    if (
      !Number.isFinite(from.x + from.y + from.z) ||
      !Number.isFinite(dir.x + dir.y + dir.z) ||
      !Number.isFinite(scale)
    ) {
      line.visible = false;
      return;
    }
    const p = line.geometry.attributes.position.array;
    p[0] = from.x;
    p[1] = from.y;
    p[2] = from.z;
    p[3] = from.x + dir.x * scale;
    p[4] = from.y + dir.y * scale;
    p[5] = from.z + dir.z * scale;
    line.geometry.attributes.position.needsUpdate = true;
  }

  update(state, fps, extra = {}) {
    if (!this.visible) return;

    for (let i = 0; i < state.wheels.length; i++) {
      const w = state.wheels[i];
      const L = this.lines[i];
      const on = w.grounded;
      L.ray.visible = L.load.visible = L.long.visible = L.lat.visible = on;
      if (!on) continue;

      this.#setLine(L.load, w.contact, w.normal, w.load * FORCE_SCALE);
      this.#setLine(L.long, w.contact, w.forceLong, FORCE_SCALE);
      this.#setLine(L.lat, w.contact, w.forceLat, FORCE_SCALE);
    }

    const kmh = (state.speed * 3.6).toFixed(0).padStart(3);
    const bar = (v, n = 10) => {
      const f = Math.max(0, Math.min(1, v));
      return "#".repeat(Math.round(f * n)).padEnd(n, ".");
    };

    let wheelRows = "";
    const names = ["FL", "FR", "RL", "RR"];
    for (let i = 0; i < state.wheels.length; i++) {
      const w = state.wheels[i];
      const slipDeg = ((w.slipAngle * 180) / Math.PI).toFixed(1).padStart(6);
      const load = w.load.toFixed(0).padStart(5);
      const grip = w.gripUsed;
      const flag = !w.grounded ? " AIR" : grip > 0.99 ? " LIM" : "";
      wheelRows += `  ${names[i]} ${load}N ${slipDeg}deg [${bar(grip)}]${flag}\n`;
    }

    this.el.textContent =
      `NEON RUSH  vehicle telemetry        ${fps.toFixed(0).padStart(3)} fps\n` +
      `${"-".repeat(42)}\n` +
      `speed     ${kmh} km/h  ${state.gear === -1 ? "[R]" : "[D]"}  ` +
      `${state.grounded ? "grounded" : "AIRBORNE"}\n` +
      `steer     ${((state.steerAngle * 180) / Math.PI).toFixed(1).padStart(5)} deg\n` +
      `drift     [${bar(state.driftFactor)}] ${(state.driftFactor * 100).toFixed(0)}%\n` +
      `boost     [${bar(state.boostCharge / CAR.boostCapacity)}] ${state.boostCharge.toFixed(0)}` +
      `${state.boosting ? "  FIRING" : ""}\n` +
      `camera    ${extra.camera ?? "-"}   level ${extra.level ?? "-"}\n` +
      (extra.progress && extra.track
        ? `lap ${extra.progress.lap}  cp ${extra.progress.lastCheckpoint}/${extra.track.checkpoints.length}` +
          `  s ${state.s.toFixed(0)}/${extra.track.length.toFixed(0)} m` +
          `  off ${state.lateralOffset.toFixed(1)} m` +
          `${extra.progress.respawns ? "  resets " + extra.progress.respawns : ""}\n`
        : "") +
      `${"-".repeat(42)}\n` +
      `        load   slip   friction circle\n` +
      wheelRows +
      `${"-".repeat(42)}\n` +
      `W/S throttle-brake   A/D steer   Space handbrake\n` +
      `Shift boost   C camera   R reset   L level   M map   G hide this`;
  }
}
