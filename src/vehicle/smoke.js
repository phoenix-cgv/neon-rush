import * as THREE from "three";

// ---------------------------------------------------------------------
// Exhaust smoke, thickening and darkening with damage.
//
// The condition bar tells you the number; smoke tells you at a glance,
// from behind, while you are busy driving — which is the one viewpoint
// the player actually spends the race in. It is also the only damage cue
// visible to the DRIVER of a car rather than to someone looking at it,
// because it trails out behind the bodywork instead of being on it.
//
// One pool for the whole field, not one per car. Every damaged car draws
// from the same particle array, so the entire effect is a single draw
// call however many cars are smoking — the same reasoning as the pickup
// orbs and the minimap blips.
//
// Updated on the RENDER frame, not the fixed step. Smoke affects nothing
// in the simulation, so stepping it at 60 Hz would be wasted work at high
// frame rates and would visibly stutter; and because it is not simulated,
// it stays out of captureState and cannot desynchronise a replay.
// ---------------------------------------------------------------------

const MAX = 160; // particles in the shared pool
const LIFE = 2.3; // seconds each one lives — long enough to leave a trail
// Smoke has to CLIMB to be seen. The chase camera looks slightly down at
// the car, so a plume that stays at exhaust height sits behind the
// bodywork and reads as a smudge on the road; one that rises crosses the
// skyline behind you, where nothing else is competing for attention.
const RISE = 2.9; // m/s upward drift
const SPREAD = 0.55; // m/s of random scatter at birth

// Below this the engine is merely unhappy and produces nothing. Smoke
// from a car with a scratch on it reads as the game being broken.
const THRESHOLD = 0.18;

// Pale haze through to dark grey — deliberately NOT to black. A near-black
// particle over a dark road is a hole in the picture rather than a plume,
// and at any real density it stops reading as smoke and starts reading as
// a rendering fault. Both ends stay desaturated: a coloured tint reads as
// fire or as a power-up, not as a failing engine.
const CLEAN = new THREE.Color(0xc2c7ca);
const FILTHY = new THREE.Color(0x51565c);

const _pos = new THREE.Vector3();
const _back = new THREE.Vector3();
const _col = new THREE.Color();

const VERT = `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aSize;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;

    // Fade out as a puff approaches the camera.
    //
    // This is what stops the effect blinding the player. Smoke is emitted
    // at the car and drifts backwards, which means straight at a chase
    // camera sitting seven metres behind it — and a particle two metres
    // from the lens covers most of the screen however small it is in
    // world terms. Fading it out over that last stretch keeps the trail
    // fully visible where the player is looking and removes it exactly
    // where it would have been in the way.
    vAlpha = aAlpha * smoothstep(1.8, 5.5, dist);

    // Perspective-correct sizing, so a puff shrinks with distance the way
    // the car it came from does.
    gl_PointSize = aSize * (300.0 / dist);
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // A soft round falloff computed from the point coordinate rather than
    // sampled from a texture: no image to load, no filtering, and it stays
    // crisp at any size.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    float soft = smoothstep(0.5, 0.08, r);
    gl_FragColor = vec4(vColor, vAlpha * soft);
  }`;

export class Smoke {
  /**
   * @param {THREE.Scene} scene
   * @param {number} layerToSkip  usually MINIMAP_LAYER
   */
  constructor(scene, layerToSkip = null) {
    this.scene = scene;
    this.time = 0;
    this.cursor = 0;

    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.alpha = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.age = new Float32Array(MAX);
    this.born = new Float32Array(MAX);
    for (let i = 0; i < MAX; i++) this.age[i] = LIFE + 1; // start all dead

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    // The pool is spread over the whole track, so a bounding sphere
    // computed once would be wrong the moment a car moved.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false, // smoke must not occlude the car it comes from
      depthTest: true,
    });

    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    if (layerToSkip !== null) this.points.layers.disable(layerToSkip);
    scene.add(this.points);

    this.geometry = g;
    this.material = mat;
    this.emitAccumulator = new WeakMap();
  }

  /**
   * @param {number} dt      render delta, seconds
   * @param {Array} cars     entries with { vehicle } — the field
   */
  update(dt, cars) {
    dt = Math.min(dt, 0.1); // a tab returning from the background
    this.time += dt;

    // --- age the live particles --------------------------------------
    let live = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.age[i] >= LIFE) continue;
      this.age[i] += dt;
      const k = this.age[i] / LIFE;
      const i3 = i * 3;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      // Slow down as it disperses, and keep rising.
      const drag = 1 - 1.6 * dt;
      this.vel[i3] *= drag;
      this.vel[i3 + 2] *= drag;
      this.vel[i3 + 1] += RISE * dt * 0.5; // keeps accelerating upward
      // Grow and fade. Fading in briefly at birth stops each puff
      // appearing as a hard disc at the exhaust.
      this.size[i] = this.born[i] * (1 + k * 3.0);
      // Fades on (1-k)^1.5 rather than squared: squared dumps most of the
      // opacity in the first third of the life, which from a chase camera
      // means the trail has already vanished by the time it clears the
      // car's own silhouette — the only place the driver can see it.
      this.alpha[i] = Math.min(k * 7, 1) * Math.pow(1 - k, 1.5) * 0.42;
      if (this.age[i] >= LIFE) this.alpha[i] = 0;
      else live++;
    }

    // --- emit ---------------------------------------------------------
    for (const car of cars) {
      const v = car.vehicle;
      if (!v) continue;
      const damage = v.damage ?? 0;
      if (damage <= THRESHOLD) continue;

      // Above the threshold, thicken sharply: the difference between a
      // damaged car and a dying one should be obvious at a glance.
      const t = (damage - THRESHOLD) / (1 - THRESHOLD);
      let rate = 4 + t * t * 24; // particles per second
      if (v.boosting) rate *= 1.5; // an engine under load smokes harder

      // Scale with speed as well as damage. Two reasons, and the second
      // is the one that matters: an idling engine genuinely smokes less
      // than one being worked, AND smoke from a stationary car has no
      // relative wind to carry it away, so it piles up in place and
      // swallows the car whole — measured, it hid the bodywork the
      // effect exists to comment on.
      rate *= 0.28 + 0.72 * Math.min(1, (v.speed ?? 0) / 12);

      let acc = (this.emitAccumulator.get(car) ?? 0) + rate * dt;
      while (acc >= 1) {
        acc -= 1;
        this.#spawn(v, t);
      }
      this.emitAccumulator.set(car, acc);
    }

    this.points.visible = live > 0;
    if (live > 0 || this.dirty) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aColor.needsUpdate = true;
      this.geometry.attributes.aAlpha.needsUpdate = true;
      this.geometry.attributes.aSize.needsUpdate = true;
    }
    this.dirty = live > 0;
  }

  #spawn(v, t) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    const i3 = i * 3;

    const st = v.state;
    // Behind the car, at about exhaust height. +Z is backwards, because
    // the car's forward is -Z.
    _back.set(0, 0, 1).applyQuaternion(st.quaternion);
    _pos.copy(st.position).addScaledVector(_back, 2.05);
    _pos.y += 0.18;

    this.pos[i3] = _pos.x + (Math.random() - 0.5) * 0.25;
    this.pos[i3 + 1] = _pos.y + (Math.random() - 0.5) * 0.12;
    this.pos[i3 + 2] = _pos.z + (Math.random() - 0.5) * 0.25;

    // Puffed backwards out of the pipe, plus scatter. Deliberately NOT
    // inheriting the car's full velocity: smoke left in still air falls
    // behind immediately, which is what sells the sense of speed.
    this.vel[i3] = _back.x * 1.6 + (Math.random() - 0.5) * SPREAD;
    // Straight up, hard, from the moment it leaves the pipe. Smoke that
    // eases upward stays in the car's shadow for the half-second it is
    // closest to the camera and therefore largest.
    this.vel[i3 + 1] = RISE * (0.95 + Math.random() * 0.6);
    this.vel[i3 + 2] = _back.z * 1.6 + (Math.random() - 0.5) * SPREAD;

    // Darker with damage, with a little variation so a plume is not one
    // flat colour.
    _col.copy(CLEAN).lerp(FILTHY, Math.min(1, t * 1.15));
    const jitter = 0.88 + Math.random() * 0.24;
    this.col[i3] = _col.r * jitter;
    this.col[i3 + 1] = _col.g * jitter;
    this.col[i3 + 2] = _col.b * jitter;

    this.born[i] = 0.55 + t * 0.55 + Math.random() * 0.18;
    this.size[i] = this.born[i];
    this.alpha[i] = 0;
    this.age[i] = 0;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

