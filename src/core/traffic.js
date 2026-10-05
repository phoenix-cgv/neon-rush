import * as THREE from "three";
import { GROUP, ALL } from "../vehicle/vehicle.js";
import { trafficParts, trafficWheels, TRAFFIC_MODELS } from "./traffic-models.js";
import { idmAccel, cornerLookahead, avoidanceTarget, slew } from "./traffic-logic.js";

// ---------------------------------------------------------------------
// Civilian traffic: cars driving the circuit at city speeds, both ways.
//
// Not racers. They don't use the vehicle model at all: each is a
// kinematic body moved along the track at a lane offset, so it follows
// the road exactly, costs almost nothing to simulate, and can never spin,
// get stuck or need a respawn. To the player it is a moving obstacle —
// solid, and treated by the car as a wall (so a hit scrubs speed and
// does damage), not as a rival.
//
// Traffic keeps LEFT, as in South Africa: cars heading the race
// direction use the left lane, oncoming cars the right. Each one slows
// for corners and for anything in its lane ahead of it — other traffic
// and the player — and waits rather than push. Oncoming cars cannot
// swerve, so a player sitting in their lane stops them.
//
// Stepped on the fixed step with the field, before world.step(), like
// every other body: never on the render frame.
// ---------------------------------------------------------------------

const HALF = { x: 0.9, y: 0.7, z: 2.2 }; // collider half extents, m
const RIDE = 0.05; // gap under the collider
const LOOK = 60; // m ahead a driver watches for something to follow
const CLEAR_LAT = 2.0; // lateral separation at which something is no longer "in my way"
const CAR_LEN = 4.4; // bumper-to-bumper = centre gap minus this
const STEER_RATE = 1.8; // m/s of lateral movement when steering round something
const LATERAL_G = 0.55; // civilians corner gently: ~0.55 g, not 1.4

const COLOURS = [0xd8dde0, 0x1f2a36, 0x8a1c1c, 0x2e5c8a, 0xc9a227, 0x3b6b3b, 0x6d6f73, 0xe8e4d8, 0x4a2f5c, 0xb85c1e];

const MIX = ["car", "coupe", "truck", "car", "coupe", "car", "truck"];

const _fr = {};
const _m = new THREE.Matrix4();
const _basis = new THREE.Matrix4();
const _part = new THREE.Matrix4();
const _wm = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _spin = new THREE.Matrix4();
const _flip = new THREE.Matrix4().makeRotationY(Math.PI);
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _back = new THREE.Vector3();

// Deterministic per-car variety, so a run and its replay see the same town.
const hash = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export class Traffic {
  /**
   * @param {object} RAPIER
   * @param {object} world
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {object} opts { sameWay, oncoming, lane, cruise: [min, max] m/s, clearStart }
   */
  constructor(RAPIER, world, scene, track, opts = {}) {
    this.world = world;
    this.scene = scene;
    this.track = track;
    const lane = opts.lane ?? 3.5;
    const [vMin, vMax] = opts.cruise ?? [11, 15];
    const clearStart = opts.clearStart ?? 45; // m kept empty around the grid
    this.cars = [];

    const L = track.length;
    const spawnRing = (count, dir, phase) => {
      const usable = L - 2 * clearStart;
      for (let i = 0; i < count; i++) {
        const k = this.cars.length;
        const s = clearStart + ((i + phase) / count) * usable;
        // A fixed rotation, so the mix is even however few cars there are:
        // three regular cars, two coupes, two trucks in every seven. A model
        // that failed to load falls back (-> car -> coupe -> the old box).
        const want = MIX[k % MIX.length];
        const kind = [want, "car", "coupe"].find((x) => trafficParts(x)) ?? "box";
        const truck = kind === "truck";
        const palette = TRAFFIC_MODELS[kind]?.colours ?? COLOURS;
        this.cars.push({
          kind,
          truck,
          spin: 0, // wheel angle, radians
          half: TRAFFIC_MODELS[kind]?.half ?? HALF,
          dir,
          laneT: -dir * lane, // keep left: left of the direction of travel
          lat: -dir * lane, // where it actually is: laneT, unless steering round something
          s,
          speed: 0,
          // trucks are a little slower and heavier on the brakes' patience
          cruise: (vMin + (vMax - vMin) * hash(k)) * (truck ? 0.85 : 1),
          colour: palette[Math.floor(hash(k + 50) * palette.length)],
          body: null,
          prev: { p: new THREE.Vector3(), q: new THREE.Quaternion() },
          cur: { p: new THREE.Vector3(), q: new THREE.Quaternion() },
        });
      }
    };
    spawnRing(opts.sameWay ?? 7, 1, 0.3);
    spawnRing(opts.oncoming ?? 6, -1, 0.75);

    for (const c of this.cars) {
      c.speed = c.cruise;
      this.#pose(c, c.cur);
      c.prev.p.copy(c.cur.p);
      c.prev.q.copy(c.cur.q);
      c.body = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(c.cur.p.x, c.cur.p.y, c.cur.p.z)
          .setRotation({ x: c.cur.q.x, y: c.cur.q.y, z: c.cur.q.z, w: c.cur.q.w })
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(c.half.x, c.half.y, c.half.z)
          .setFriction(0.3)
          .setRestitution(0.1)
          // Its own collision layer, solid to every car and wheel ray.
          .setCollisionGroups((GROUP.traffic << 16) | ALL),
        c.body
      );
    }

    this.#buildMeshes();
    this.render(1);
  }

  /** Where a car at its s and lane sits, and which way it faces. */
  #pose(c, out) {
    this.track.frameAt(c.s, _fr);
    _fwd.copy(_fr.tangent).multiplyScalar(c.dir);
    _right.copy(_fr.right).multiplyScalar(c.dir);
    out.p
      .copy(_fr.position)
      .addScaledVector(_fr.right, c.lat)
      .addScaledVector(_fr.up, c.half.y + RIDE);
    // -Z is forward, as for every car in the game.
    _basis.makeBasis(_right, _fr.up, _back.copy(_fwd).negate());
    out.q.setFromRotationMatrix(_basis);
  }

  /** Along-track distance from a to b in direction dir, wrapped to (-L/2, L/2]. */
  #ahead(a, b, dir) {
    const L = this.track.length;
    let d = (b - a) * dir;
    d = ((d % L) + L) % L;
    return d > L / 2 ? d - L : d;
  }

  /**
   * Advance one fixed step. Call before world.step().
   * @param {number} dt
   * @param {Array} field  race entries ({ vehicle, progress }) — the player and any racers
   */
  step(dt, field = []) {
    const L = this.track.length;
    const roadHalf = this.track.width / 2;
    for (const c of this.cars) {
      // Corner speed: read the road far enough ahead to brake for it
      // gently at this speed, rather than a fixed 40 m that is too short
      // at 15 m/s and wasteful at 5.
      let target = c.cruise;
      const look = cornerLookahead(c.speed);
      for (let a = 0; a <= look; a += 4) {
        const k = this.track.curvatureAt(c.s + a * c.dir);
        if (k > 1e-4) target = Math.min(target, Math.sqrt((LATERAL_G * 9.81) / k));
      }

      // What is in my way. Other traffic shares my lane, so it is always
      // a leader. The player (and any racer) is one only if it is
      // actually overlapping my line — and it is judged by where I will
      // be after steering round it, not where I started.
      let gap = Infinity;
      let vObs = 0;
      for (const o of this.cars) {
        if (o === c || o.dir !== c.dir) continue;
        const d = this.#ahead(c.s, o.s, c.dir);
        if (d > 0 && d < gap) {
          gap = d;
          vObs = o.speed;
        }
      }
      gap = Number.isFinite(gap) ? gap - CAR_LEN : gap;

      let hazard = null;
      for (const f of field) {
        const v = f.vehicle;
        const d = this.#ahead(c.s, v.s, c.dir);
        if (d <= -2 || d > LOOK) continue;
        if (Math.abs(v.lateralOffset - c.lat) > CLEAR_LAT + 0.7) continue;
        if (!hazard || d < hazard.gap) hazard = { lat: v.lateralOffset, gap: Math.max(d, 0), speed: v.speed * c.dir };
      }

      // Steer round it toward my own kerb instead of stopping in its path.
      const want = avoidanceTarget(c.laneT, c.lat, hazard, roadHalf);
      c.lat = slew(c.lat, want, STEER_RATE, dt);

      // ...and only treat it as a leader if it is still in my way.
      if (hazard && Math.abs(hazard.lat - c.lat) < CLEAR_LAT) {
        const g = hazard.gap - CAR_LEN;
        if (g < gap) {
          gap = g;
          vObs = hazard.speed;
        }
      }

      c.speed = Math.max(0, c.speed + idmAccel(c.speed, target, gap, vObs) * dt);
      c.spin += (c.speed * dt) / (trafficWheels(c.kind)?.radius || 0.35);
      c.s = (((c.s + c.dir * c.speed * dt) % L) + L) % L;

      c.prev.p.copy(c.cur.p);
      c.prev.q.copy(c.cur.q);
      this.#pose(c, c.cur);
      c.body.setNextKinematicTranslation(c.cur.p);
      c.body.setNextKinematicRotation(c.cur.q);
    }

    // A car that has just been respawned must not reappear inside traffic.
    for (const f of field) {
      if (f.progress?.justRespawned) this.clearAround(f.vehicle.body.translation());
    }
  }

  /**
   * Move any traffic within `radius` of a point further along its lane —
   * for respawns, which put a car back on the road wherever it has to go.
   */
  clearAround(pos, radius = 20) {
    const L = this.track.length;
    for (const c of this.cars) {
      const dx = c.cur.p.x - pos.x;
      const dz = c.cur.p.z - pos.z;
      if (dx * dx + dz * dz > radius * radius) continue;
      c.s = (((c.s + c.dir * 60) % L) + L) % L;
      this.#pose(c, c.cur);
      c.prev.p.copy(c.cur.p);
      c.prev.q.copy(c.cur.q);
      c.body.setTranslation(c.cur.p, true);
      c.body.setRotation(c.cur.q, true);
    }
  }

  // -------------------------------------------------------------------
  // Drawing: one InstancedMesh per part, so the whole town's traffic is
  // five draw calls however many cars there are.
  // -------------------------------------------------------------------
  #buildMeshes() {
    const sedans = this.cars.filter((c) => c.kind === "box"); // fallback boxes
    sedans.forEach((c, i) => (c.slot = i));
    for (const c of sedans) c.insts = null; // filled below
    const n = sedans.length;
    const part = (geo, mat, perCar, local, count = n) => {
      const inst = new THREE.InstancedMesh(geo, mat, count * perCar.length);
      inst.castShadow = true;
      inst.frustumCulled = false; // spread round the whole lap
      inst.userData.local = perCar.map((o) => new THREE.Matrix4().compose(o.p, o.q ?? new THREE.Quaternion(), _one));
      this.scene.add(inst);
      return inst;
    };
    const wheelQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const y0 = -(HALF.y + RIDE); // road level relative to the body centre
    const V = (x, y, z) => new THREE.Vector3(x, y, z);

    this.body = part(
      new THREE.BoxGeometry(1.8, 0.7, 4.3),
      new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.4 }),
      [{ p: V(0, y0 + 0.62, 0) }]
    );
    this.cabin = part(
      new THREE.BoxGeometry(1.6, 0.55, 2.2),
      new THREE.MeshStandardMaterial({ color: 0x1b2530, roughness: 0.15, metalness: 0.6 }),
      [{ p: V(0, y0 + 1.22, 0.25) }]
    );
    this.wheels = part(
      new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12),
      new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }),
      [V(-0.86, y0 + 0.34, -1.35), V(0.86, y0 + 0.34, -1.35), V(-0.86, y0 + 0.34, 1.35), V(0.86, y0 + 0.34, 1.35)].map((p) => ({ p, q: wheelQ }))
    );
    this.heads = part(
      new THREE.BoxGeometry(0.4, 0.14, 0.05),
      new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff2cc, emissiveIntensity: 1.6 }),
      [{ p: V(-0.6, y0 + 0.72, -2.16) }, { p: V(0.6, y0 + 0.72, -2.16) }]
    );
    this.tails = part(
      new THREE.BoxGeometry(0.4, 0.14, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x8a0f0f, emissive: 0xff2211, emissiveIntensity: 1.2 }),
      [{ p: V(-0.6, y0 + 0.72, 2.16) }, { p: V(0.6, y0 + 0.72, 2.16) }]
    );
    const col = new THREE.Color();
    sedans.forEach((c, i) => this.body.setColorAt(i, col.setHex(c.colour)));
    if (n) this.body.instanceColor.needsUpdate = true;
    this.parts = [this.body, this.cabin, this.wheels, this.heads, this.tails];

    // Model vehicles: one instanced mesh per material, per kind. The
    // "paint" material takes each vehicle's own colour. The models stand on
    // y = 0, so they are dropped to the road under the collider's centre.
    this.modelParts = [];
    for (const kind of Object.keys(TRAFFIC_MODELS)) {
      const group = this.cars.filter((c) => c.kind === kind);
      const tp = trafficParts(kind);
      if (!group.length || !tp) continue;
      group.forEach((c, i) => (c.slot = i));
      const drop = new THREE.Matrix4().makeTranslation(0, -(TRAFFIC_MODELS[kind].half.y + RIDE), 0);
      const insts = [];
      for (const { name, geometry, material } of tp) {
        const inst = new THREE.InstancedMesh(geometry, material, group.length);
        inst.castShadow = true;
        inst.frustumCulled = false;
        inst.userData.local = [drop];
        if (name === "paint") {
          group.forEach((c, i) => inst.setColorAt(i, col.setHex(c.colour)));
          inst.instanceColor.needsUpdate = true;
        }
        this.scene.add(inst);
        insts.push(inst);
        this.modelParts.push(inst);
      }
      for (const c of group) c.insts = insts;

      // Wheels: their own instanced meshes (four per vehicle), so they can
      // turn. Every wheel is drawn from the model's front-left one, the far
      // side turned round to face outward.
      const ws = trafficWheels(kind);
      if (ws) {
        const winsts = [];
        for (const { geometry, material } of ws.parts) {
          const inst = new THREE.InstancedMesh(geometry, material, group.length * 4);
          inst.castShadow = true;
          inst.frustumCulled = false;
          this.scene.add(inst);
          winsts.push(inst);
          this.modelParts.push(inst);
        }
        for (const c of group) c.wheelInsts = winsts;
        this.wheelDrop ??= {};
        this.wheelDrop[kind] = drop;
      }
    }
    for (const c of sedans) c.insts = this.parts;
  }

  /** Pose every mesh, blending the last two steps like the racing cars. */
  render(alpha) {
    this.cars.forEach((c) => {
      _p.lerpVectors(c.prev.p, c.cur.p, alpha);
      _q.slerpQuaternions(c.prev.q, c.cur.q, alpha);
      _m.compose(_p, _q, _one);
      for (const inst of c.insts) {
        const locals = inst.userData.local;
        for (let j = 0; j < locals.length; j++) {
          inst.setMatrixAt(c.slot * locals.length + j, _part.multiplyMatrices(_m, locals[j]));
        }
      }
      if (c.wheelInsts) {
        const ws = trafficWheels(c.kind);
        _spin.makeRotationX(-c.spin); // forward is -Z: the tops roll toward it
        for (let k = 0; k < 4; k++) {
          const cn = ws.corners[k];
          _wm.copy(_m).multiply(this.wheelDrop[c.kind]).multiply(_t.makeTranslation(cn.x, cn.y, cn.z));
          if (cn.x > 0) _wm.multiply(_flip); // far side: face the outside outward
          _wm.multiply(_spin);
          for (const inst of c.wheelInsts) inst.setMatrixAt(c.slot * 4 + k, _wm);
        }
      }
    });
    for (const inst of this.parts) inst.instanceMatrix.needsUpdate = true;
    for (const inst of this.modelParts) inst.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const c of this.cars) this.world.removeRigidBody(c.body); // removes its collider too
    for (const inst of [...(this.parts ?? []), ...(this.modelParts ?? [])]) {
      this.scene.remove(inst);
      inst.geometry.dispose();
      inst.material.dispose();
      inst.dispose();
    }
    this.cars.length = 0;
  }
}
