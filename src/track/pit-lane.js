import * as THREE from "three";
import { TrackSpline } from "./spline.js";
import { CAR } from "../vehicle/config.js";

// ---------------------------------------------------------------------
// The pit lane: a second road, joined to the track at both ends.
//
// The map models it (blender/grandprix/fix_grandprix.py): an entry road
// peeling off the left of the diagonal before the final corner, across
// the corner's infield, down the pit straight past the garages behind a
// pit wall, and back onto the track after them. Its ribbon is left/right
// pairs like the road's, and its garage boxes and speed-limit lines are
// named markers.
//
// The track's rules would stop anyone using it: the soft wall holds a car
// 8.4 m from the centre line, and Progress resets a car it finds 12 m out.
// So a car on the pit road is handed over to this class instead:
//
//   IN        A car enters where the pit road runs alongside the track,
//             with its centre over the pit road and off the asphalt.
//             From then on `vehicle.inPit` is set: the track's soft wall
//             and off-track resets stand down, and the pit road's own
//             edges hold the car (the same soft-wall constraint, along
//             this road). It leaves where the road rejoins the track.
//
//   WHERE     Progress and the AI read `vehicle.s`. On the pit road it is
//             the track distance the car is level with, never going
//             backwards, so checkpoints and laps count through the pits.
//
//   LIMITER   60 km/h between the two lines. Arrive faster and the car is
//             slowed hard to it; it cannot go faster until the second line.
//
//   SERVICE   Stop in your own garage box (it glows) and the car is
//             repaired and the boost refilled; about three seconds from
//             wrecked. Every car has a box: the player's is the first.
//
//   AI        Opponents stay out unless badly damaged, then pit at the
//             next chance: aim down the pit road, keep to the limit, stop
//             in their box, go when serviced.
// ---------------------------------------------------------------------

const _pos = new THREE.Vector3();
const _fr = {};
const _aim = new THREE.Vector3();
const _rel = new THREE.Vector3();

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const ENTER_OFF_ROAD = 6.2; // a car's centre must be this far out to enter
const REJOINED = 6.0; // back within this of the centre line: left the pits
const EDGE_MARGIN = 0.6; // the car's centre stays this far inside an edge
const OPEN_EDGE = 8.0; // the pit road is open to the track where its inner edge is within this
const BRAKE = 6.0; // m/s^2 the AI plans to brake at on the pit road
const BOX_HALF = { along: 2.6, across: 1.3 }; // where a car's centre counts as in its box

export class PitLane {
  /**
   * @param {Track} track
   * @param {THREE.Scene} scene
   * @param {{left, right, boxes, limits}} data  from buildMapTrack's `pit`
   * @param {object} opts  { limitKmh, repairTime, aiDamage }
   */
  constructor(track, scene, data, opts = {}) {
    this.track = track;
    this.scene = scene;
    this.limit = (opts.limitKmh ?? 60) / 3.6;
    this.repairRate = 1 / (opts.repairTime ?? 3); // condition per second
    this.boostRate = CAR.boostCapacity / (opts.repairTime ?? 3);
    this.aiDamage = opts.aiDamage ?? 0.5; // an opponent this damaged pits
    this.objects = [];
    this.state = new Map(); // vehicle -> per-car pit state

    // Centre line and half width, from every other pair (1 m apart).
    const centres = [];
    const halves = [];
    for (let i = 0; i < data.left.length; i += 2) {
      centres.push(data.left[i].clone().add(data.right[i]).multiplyScalar(0.5));
      halves.push(Math.hypot(data.left[i].x - data.right[i].x, data.left[i].z - data.right[i].z) / 2);
    }
    this.spline = new TrackSpline(centres, { closed: false, spacing: 1 });
    this.length = this.spline.length;
    const n = this.spline.pos.length;
    const step = this.spline.step;
    const cum = [0];
    for (let i = 1; i < centres.length; i++) cum.push(cum[i - 1] + centres[i].distanceTo(centres[i - 1]));
    const scale = this.length / cum[cum.length - 1];
    this.half = new Float32Array(n);
    for (let k = 0, j = 0; k < n; k++) {
      const u = (k * step) / scale;
      while (j < cum.length - 2 && cum[j + 1] < u) j++;
      const f = clamp((u - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]), 0, 1);
      this.half[k] = halves[j] + (halves[j + 1] - halves[j]) * f;
    }

    // Which way the track is from the pit road (its inner side), and which
    // side of the track the pit road is on.
    const mid = this.spline.pos[n >> 1];
    const mp = track.project(mid, null);
    this.side = Math.sign(mp.t) || -1;
    track.frameAt(mp.s, _fr);
    const toTrack = _fr.position.clone().sub(mid);
    this.innerSign = Math.sign(toTrack.dot(this.spline.right[n >> 1])) || 1;

    // Track distance level with each sample: projected where the pit road
    // is beside the track, interpolated across the infield, never going
    // backwards.
    const L = track.length;
    const raw = new Float64Array(n);
    const near = new Uint8Array(n);
    this.open = new Uint8Array(n);
    const inner = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      const p = this.spline.pos[k];
      const pr = track.project(p, null);
      raw[k] = pr.s;
      near[k] = Math.abs(pr.t) < 16 ? 1 : 0;
      inner.copy(p).addScaledVector(this.spline.right[k], this.innerSign * this.half[k]);
      this.open[k] = Math.abs(track.project(inner, pr.s).t) < OPEN_EDGE ? 1 : 0;
    }
    this.entryS = raw[0];
    const d = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let x = (((raw[k] - this.entryS) % L) + L) % L;
      if (x > L - 60) x -= L;
      d[k] = x;
    }
    let last = -1;
    for (let k = 0; k < n; k++) {
      if (!near[k] && k < n - 1) continue;
      if (last >= 0 && k - last > 1) {
        for (let q = last + 1; q < k; q++) d[q] = d[last] + ((d[k] - d[last]) * (q - last)) / (k - last);
      }
      last = k;
    }
    this.mainS = new Float64Array(n);
    let top = -Infinity;
    for (let k = 0; k < n; k++) {
      top = Math.max(top, d[k]);
      this.mainS[k] = top;
    }

    // Open to the track at the ends, walled in between.
    let a = 0;
    while (a < n - 1 && this.open[a]) a++;
    let b = n - 1;
    while (b > 0 && this.open[b]) b--;
    this.entryOpenEnd = a * step;
    this.exitOpenStart = (b + 1) * step;

    // Markers, as distances along the pit road.
    const limitU = data.limits.map((p) => this.spline.project(p, null).s).sort((x, y) => x - y);
    this.limitFrom = limitU.length >= 2 ? limitU[0] : this.entryOpenEnd;
    this.limitTo = limitU.length >= 2 ? limitU[limitU.length - 1] : this.exitOpenStart;
    this.boxes = data.boxes
      .map((p) => {
        const pr = this.spline.project(p, null);
        const fr = this.spline.frameAt(pr.s, {});
        return {
          u: pr.s,
          t: pr.t,
          pos: p.clone(),
          tangent: fr.tangent.clone().setY(0).normalize(),
          right: fr.right.clone().setY(0).normalize(),
        };
      })
      .sort((x, y) => x.u - y.u);

    this.#buildHud();
    this.clock = 0;
  }

  // -------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------

  /** Give every car in the race the pit lane and a box; the player's is the first. */
  attach(cars) {
    cars.forEach((c, i) => {
      c.vehicle.pitLane = this;
      const st = this.#state(c.vehicle);
      st.box = this.boxes.length ? this.boxes[i % this.boxes.length] : null;
      if (c.controller) c.controller.pit = this;
      if (c.isPlayer && st.box) this.#buildHighlight(st.box);
    });
  }

  #state(v) {
    let st = this.state.get(v);
    if (!st) {
      st = { u: 0, t: 0, box: null, stopped: 0, served: false, inZone: false };
      this.state.set(v, st);
    }
    return st;
  }

  halfAt(u) {
    const f = clamp(u / this.spline.step, 0, this.half.length - 1);
    const i = Math.floor(f);
    const j = Math.min(i + 1, this.half.length - 1);
    return this.half[i] + (this.half[j] - this.half[i]) * (f - i);
  }

  /** The track distance level with pit-road distance u. */
  mainSAt(u) {
    const f = clamp(u / this.spline.step, 0, this.mainS.length - 1);
    const i = Math.floor(f);
    const j = Math.min(i + 1, this.mainS.length - 1);
    const d = this.mainS[i] + (this.mainS[j] - this.mainS[i]) * (f - i);
    return this.track.spline.wrapS(this.entryS + d);
  }

  /** Metres from track distance s forward to s2, round the lap. */
  #ahead(s, s2) {
    const L = this.track.length;
    return (((s2 - s) % L) + L) % L;
  }

  // -------------------------------------------------------------------
  // The constraint: called from Vehicle.applySoftWall, after the solve
  // -------------------------------------------------------------------

  /**
   * Hold a car on the pit road, or let it in or out.
   * @returns {boolean} true while the car is on the pit road (the track's
   *   soft wall must then leave it alone)
   */
  constrain(v) {
    const st = this.#state(v);
    const t0 = v.body.translation();
    _pos.set(t0.x, t0.y, t0.z);

    if (!v.inPit) {
      // Cheap test first: near the entry, on the pit side, off the asphalt.
      const along = this.#ahead(this.entryS, v.s);
      if (along > this.entryOpenEnd + 20) return false;
      if (v.lateralOffset * this.side < ENTER_OFF_ROAD) return false;
      const pr = this.spline.project(_pos, clamp(along, 0, this.entryOpenEnd), 24);
      if (pr.s > this.entryOpenEnd || Math.abs(pr.t) > this.halfAt(pr.s)) return false;
      v.inPit = true;
      st.u = pr.s;
      st.served = false;
      st.stopped = 0;
    }

    const pr = this.spline.project(_pos, st.u, 12);
    st.u = pr.s;
    st.t = pr.t;
    const half = this.halfAt(pr.s);
    // Nowhere near the pit road (a respawn put it back on the track), or
    // off the far end: the track has it again.
    if (Math.abs(pr.t) > half + 3 || pr.s >= this.length - 0.5) return this.#leave(v, st);

    const sMain = this.mainSAt(pr.s);
    const mp = this.track.project(_pos, sMain);
    v.s = sMain;
    v.lateralOffset = mp.t;
    const open = pr.s <= this.entryOpenEnd || pr.s >= this.exitOpenStart;
    if (open && Math.abs(mp.t) < REJOINED) {
      v.s = mp.s;
      return this.#leave(v, st);
    }

    // The pit road's edges. Where it is open to the track, only the outer one.
    const sign = Math.sign(pr.t);
    const over = Math.abs(pr.t) - (half - EDGE_MARGIN);
    if (over > 0 && !(open && sign === this.innerSign)) {
      this.spline.frameAt(pr.s, _fr);
      v.holdInside(over, sign, _fr.right);
    } else {
      v.againstWall = false;
    }
    return true;
  }

  #leave(v, st) {
    v.inPit = false;
    v.pitService = false;
    st.stopped = 0;
    st.inZone = false;
    return false;
  }

  // -------------------------------------------------------------------
  // Limiter and service: after race.postStep
  // -------------------------------------------------------------------

  postStep(dt, cars) {
    this.clock += dt;
    for (const c of cars) {
      const v = c.vehicle;
      const st = this.#state(v);
      if (!v.inPit) {
        v.pitService = false;
        continue;
      }

      // Speed limit: slowed hard to it, and held there.
      st.inZone = st.u >= this.limitFrom && st.u <= this.limitTo;
      if (st.inZone) {
        const lv = v.body.linvel();
        const h = Math.hypot(lv.x, lv.z);
        if (h > this.limit) {
          const k = Math.max(this.limit, h - 16 * dt) / h;
          v.body.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, true);
        }
      }

      // Service: stopped in your own box.
      const box = st.box;
      let inBox = false;
      if (box) {
        const p = v.body.translation();
        _rel.set(p.x - box.pos.x, 0, p.z - box.pos.z);
        inBox =
          Math.abs(_rel.dot(box.tangent)) < BOX_HALF.along &&
          Math.abs(_rel.dot(box.right)) < BOX_HALF.across;
      }
      st.inBox = inBox;
      st.stopped = inBox && v.speed < 1.0 ? st.stopped + dt : 0;
      v.pitService = st.stopped > 0.3;
      if (v.pitService) {
        v.repair(this.repairRate * dt);
        v.refillBoost(this.boostRate * dt);
        if (v.damage <= 0 && v.boostCharge >= CAR.boostCapacity - 0.01) st.served = true;
      }
    }
    if (this.highlight) {
      const pulse = 0.28 + 0.12 * Math.sin(this.clock * 4);
      this.highlight.material.opacity = pulse;
    }
  }

  // -------------------------------------------------------------------
  // AI
  // -------------------------------------------------------------------

  /**
   * The fastest a car may go now so that, braking at BRAKE, it takes every
   * bend of the pit road from u0 to u0 + horizon. The car is `lead` metres
   * short of u0.
   */
  #speedFrom(u0, lead, horizon) {
    let v = Infinity;
    for (let a = 0; a <= horizon; a += 3) {
      const u = u0 + a;
      if (u > this.length) break;
      const k = Math.max(this.spline.curvatureAt(u), 1e-4);
      const vc = Math.sqrt((1.2 * 9.81) / k);
      v = Math.min(v, Math.sqrt(vc * vc + 2 * BRAKE * (a + lead)));
    }
    return v;
  }

  /**
   * Where an opponent should aim and how fast it may go, or null to race.
   * @param {AIController} ctrl  its controller (holds `pitting`)
   * @param {Vehicle} car
   * @param {number} look  its lookahead, m
   * @returns {null | {aim: THREE.Vector3, vmax: number, stop: boolean}}
   */
  aiPlan(ctrl, car, look) {
    const st = this.#state(car);
    if (!car.inPit) {
      const toEntry = this.#ahead(car.s, this.entryS);
      if (!ctrl.pitting) {
        // Stay out unless badly damaged, and only decide in good time.
        if (car.damage < this.aiDamage || toEntry < 150 || toEntry > 700) return null;
        ctrl.pitting = true;
      }
      if (toEntry > 700) {
        ctrl.pitting = false; // went past it (or has been through)
        return null;
      }
      const vmax = this.#speedFrom(0, toEntry, 160);
      if (toEntry > look) {
        // Move over to the pit side in good time.
        const f = clamp(1 - (toEntry - look) / 160, 0, 1);
        this.track.frameAt(car.s + look, _fr);
        _aim.copy(_fr.position).addScaledVector(_fr.right, this.side * 7.4 * f + ctrl.targetOffset * (1 - f));
      } else {
        this.spline.frameAt(look - toEntry, _fr);
        _aim.copy(_fr.position);
      }
      return { aim: _aim, vmax, stop: false };
    }

    const u = st.u;
    const box = st.box;
    let lat = 0;
    const toBox = box ? box.u - u : -1;
    if (box && !st.served && toBox > -3 && toBox < 80) lat = box.t * clamp(1 - (toBox - 10) / 60, 0, 1);
    const at = Math.min(u + look, this.length);
    this.spline.frameAt(at, _fr);
    _aim.copy(_fr.position).addScaledVector(_fr.right, lat);

    let vmax = this.#speedFrom(u, 0, look + 60);
    const lim = this.limit * 0.93;
    if (u < this.limitFrom) vmax = Math.min(vmax, Math.sqrt(lim * lim + 2 * BRAKE * Math.max(0, this.limitFrom - u - 4)));
    else if (u <= this.limitTo) vmax = Math.min(vmax, lim);

    let stop = false;
    if (box && !st.served) {
      vmax = Math.min(vmax, Math.sqrt(2 * 3.5 * Math.max(0, toBox - 0.4)));
      stop = toBox < 1.2 || car.pitService;
    }
    if (st.served) ctrl.pitting = false;

    // Past the pit road's end of the wall: steer back onto the track.
    if (u > this.exitOpenStart) {
      this.track.frameAt(car.s + look, _fr);
      _aim.copy(_fr.position).addScaledVector(_fr.right, this.side * 4.5);
    }
    return { aim: _aim, vmax, stop };
  }

  // -------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------

  /** A pulsing green panel and a light column on the player's box. */
  #buildHighlight(box) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x3dff8e,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(BOX_HALF.along * 2 - 0.4, BOX_HALF.across * 2 + 0.2), mat);
    panel.rotation.x = -Math.PI / 2;
    const yaw = Math.atan2(-box.tangent.z, box.tangent.x);
    const holder = new THREE.Group();
    holder.position.copy(box.pos).setY(box.pos.y + 0.03);
    holder.rotation.y = yaw;
    holder.add(panel);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 14, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x3dff8e,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    beam.position.y = 7;
    holder.add(beam);
    this.scene.add(holder);
    this.objects.push(holder);
    this.highlight = panel;
  }

  #buildHud() {
    this.hud = document.createElement("div");
    this.hud.style.cssText = `position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:25;
      font:800 15px/1.25 "Cascadia Mono",Consolas,monospace;letter-spacing:.12em;color:#07140c;
      background:#3dff8e;border:2px solid #07140c;padding:6px 12px;border-radius:3px;text-align:center;
      pointer-events:none;display:none;white-space:nowrap`;
    document.body.appendChild(this.hud);
    this.hudText = "";
  }

  /** The player's pit messages, once per rendered frame. */
  updateHud(v) {
    let text = "";
    const st = this.#state(v);
    if (v.inPit) {
      if (v.pitService) {
        const cond = Math.round((1 - v.damage) * 100);
        const boost = Math.round((v.boostCharge / CAR.boostCapacity) * 100);
        text = st.served ? "SERVICE DONE — GO" : `PIT STOP · REPAIR ${cond}% · BOOST ${boost}%`;
      } else if (st.served) {
        text = st.inZone ? `PIT LIMITER ${Math.round(this.limit * 3.6)} km/h` : "";
      } else {
        const toBox = st.box ? st.box.u - st.u : -1;
        const limiter = st.inZone ? `LIMITER ${Math.round(this.limit * 3.6)} km/h · ` : "PIT LANE · ";
        if (toBox > 2.6) text = `${limiter}YOUR BOX ${Math.round(toBox)} m`;
        else if (st.inBox) text = "STOP IN YOUR BOX";
        else if (toBox > -8) text = `${limiter}YOUR BOX ◂ BACK UP`;
        else text = limiter.replace(/ · $/, "");
      }
    } else if (v.damage > 0.35) {
      const toEntry = this.#ahead(v.s, this.entryS);
      if (toEntry < 450) text = `PIT ENTRY ${Math.round(toEntry)} m · KEEP ${this.side < 0 ? "LEFT" : "RIGHT"}`;
    }
    if (text !== this.hudText) {
      this.hudText = text;
      this.hud.textContent = text;
      this.hud.style.display = text ? "block" : "none";
    }
  }

  dispose() {
    for (const o of this.objects) {
      this.scene.remove(o);
      o.traverse((m) => {
        m.geometry?.dispose();
        m.material?.dispose();
      });
    }
    this.objects.length = 0;
    for (const v of this.state.keys()) {
      v.pitLane = null;
      v.inPit = false;
      v.pitService = false;
    }
    this.state.clear();
    this.hud.remove();
  }
}
