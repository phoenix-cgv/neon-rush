import * as THREE from "three";

// ---------------------------------------------------------------------
// Drift effects: sparks thrown off the rear wheels while the car slides,
// coloured by the title the combo has reached (DRIFTER cyan, MASTER gold,
// KING orange, GOD red) and getting denser with it, plus a burst round the
// car each time a new title is earned.
//
// One pooled Points object for the whole thing, so it costs a single draw
// call whatever is happening. Purely visual: it reads the car's state and
// never touches the simulation.
// ---------------------------------------------------------------------

const N = 260;
const COLOURS = [0x7fe3ff, 0xffd24a, 0xff9a2a, 0xff3b30].map((c) => new THREE.Color(c));
const BASE = new THREE.Color(0xffe2b0);

const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Color();

export class DriftFx {
  constructor(scene) {
    this.scene = scene;
    this.pos = new Float32Array(N * 3);
    this.col = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.life = new Float32Array(N); // seconds left; <= 0 is free
    this.next = 0;
    this.carry = 0; // fractional spawns carried between frames
    for (let i = 0; i < N; i++) this.pos[i * 3 + 1] = -1000;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 0.17,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      })
    );
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  #spawn(x, y, z, vx, vy, vz, colour, life) {
    const i = this.next;
    this.next = (this.next + 1) % N;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = colour.r; this.col[i * 3 + 1] = colour.g; this.col[i * 3 + 2] = colour.b;
    this.life[i] = life;
  }

  /** A ring of sparks round the car, in the colour of the title just earned. */
  burst(rig, tier) {
    const c = COLOURS[Math.max(0, Math.min(3, tier))];
    rig.root.getWorldPosition(_p);
    for (let k = 0; k < 46; k++) {
      const a = (k / 46) * Math.PI * 2;
      const sp = 5 + Math.random() * 5;
      this.#spawn(_p.x, _p.y + 0.5, _p.z, Math.cos(a) * sp, 2 + Math.random() * 4, Math.sin(a) * sp, c, 0.7 + Math.random() * 0.4);
    }
  }

  /**
   * @param {number} dt  render delta
   * @param {object} state  vehicle.state
   * @param {object} rig  the car's CarRig (for the rear wheel positions)
   */
  update(dt, state, rig) {
    // spawn from the rear wheels while sliding
    if (state && rig && state.driftFactor > 0.1 && state.grounded) {
      const tier = state.driftTier ?? -1;
      const colour = tier >= 0 ? COLOURS[tier] : BASE;
      const perSecond = (50 + (tier + 1) * 45) * state.driftFactor;
      this.carry += perSecond * dt;
      _fwd.set(0, 0, -1).applyQuaternion(rig.root.quaternion);
      _right.set(1, 0, 0).applyQuaternion(rig.root.quaternion);
      while (this.carry >= 1) {
        this.carry -= 1;
        const w = rig.wheelMeshes[2 + (Math.random() < 0.5 ? 0 : 1)];
        w.pivot.getWorldPosition(_p);
        const side = (Math.random() - 0.5) * 3 + Math.sign(state.steerAngle || 1) * -1.5;
        const back = -(2 + Math.random() * 4) - state.speed * 0.15;
        _tmp.copy(colour).lerp(BASE, Math.random() * 0.35);
        this.#spawn(
          _p.x, _p.y - 0.25, _p.z,
          _fwd.x * back + _right.x * side, 0.8 + Math.random() * 2.4, _fwd.z * back + _right.z * side,
          _tmp, 0.35 + Math.random() * 0.35
        );
      }
    }

    // move, fall, fade
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -1000;
        continue;
      }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
