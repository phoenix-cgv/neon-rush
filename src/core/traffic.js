import * as THREE from "three";
import { GROUP, ALL } from "../vehicle/vehicle.js";

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
const LANE_HALF = 2.6; // lateral band that counts as "in my lane"
const LOOK = 45; // m ahead a driver watches for something to follow
const STOP_GAP = 9; // m to leave behind whatever it is following
const ACCEL = 2.5; // m/s^2
const BRAKE = 7.0; // m/s^2
const LATERAL_G = 0.55; // civilians corner gently: ~0.55 g, not 1.4

const COLOURS = [0xd8dde0, 0x1f2a36, 0x8a1c1c, 0x2e5c8a, 0xc9a227, 0x3b6b3b, 0x6d6f73, 0xe8e4d8, 0x4a2f5c, 0xb85c1e];

const _fr = {};
const _m = new THREE.Matrix4();
const _basis = new THREE.Matrix4();
const _part = new THREE.Matrix4();
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
        this.cars.push({
          dir,
          laneT: -dir * lane, // keep left: left of the direction of travel
          s,
          speed: 0,
          cruise: vMin + (vMax - vMin) * hash(k),
          colour: COLOURS[Math.floor(hash(k + 50) * COLOURS.length)],
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
        RAPIER.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z)
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
      .addScaledVector(_fr.right, c.laneT)
      .addScaledVector(_fr.up, HALF.y + RIDE);
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
    for (const c of this.cars) {
      // Corner speed: the tightest point in the next 40 m, at a gentle g.
      let target = c.cruise;
      for (let a = 0; a <= 40; a += 4) {
        const k = this.track.curvatureAt(c.s + a * c.dir);
        if (k > 1e-4) target = Math.min(target, Math.sqrt((LATERAL_G * 9.81) / k));
      }

      // Follow: anything in my lane ahead of me, traffic or player.
      let gap = Infinity;
      for (const o of this.cars) {
        if (o === c || o.dir !== c.dir) continue;
        const d = this.#ahead(c.s, o.s, c.dir);
        if (d > 0 && d < gap) gap = d;
      }
      for (const f of field) {
        const v = f.vehicle;
        if (Math.abs(v.lateralOffset - c.laneT) > LANE_HALF) continue;
        const d = this.#ahead(c.s, v.s, c.dir);
        if (d > -2 && d < gap) gap = Math.max(d, 0);
      }
      if (gap < LOOK) target = Math.min(target, Math.max(0, (gap - STOP_GAP) * 0.6));

      const dv = target - c.speed;
      c.speed += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, dv));
      c.speed = Math.max(0, c.speed);
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
    const n = this.cars.length;
    const part = (geo, mat, perCar, local) => {
      const inst = new THREE.InstancedMesh(geo, mat, n * perCar.length);
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
    this.cars.forEach((c, i) => this.body.setColorAt(i, col.setHex(c.colour)));
    this.body.instanceColor.needsUpdate = true;
    this.parts = [this.body, this.cabin, this.wheels, this.heads, this.tails];
  }

  /** Pose every mesh, blending the last two steps like the racing cars. */
  render(alpha) {
    this.cars.forEach((c, i) => {
      _p.lerpVectors(c.prev.p, c.cur.p, alpha);
      _q.slerpQuaternions(c.prev.q, c.cur.q, alpha);
      _m.compose(_p, _q, _one);
      for (const inst of this.parts) {
        const locals = inst.userData.local;
        for (let j = 0; j < locals.length; j++) {
          inst.setMatrixAt(i * locals.length + j, _part.multiplyMatrices(_m, locals[j]));
        }
      }
    });
    for (const inst of this.parts) inst.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const c of this.cars) this.world.removeRigidBody(c.body); // removes its collider too
    for (const inst of this.parts ?? []) {
      this.scene.remove(inst);
      inst.geometry.dispose();
      inst.material.dispose();
      inst.dispose();
    }
    this.cars.length = 0;
  }
}
