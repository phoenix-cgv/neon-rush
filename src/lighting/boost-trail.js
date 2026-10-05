import * as THREE from "three";
import { NOISE, DISPLACE, EDGE } from "./dissolve-glsl.js";
import { MINIMAP_LAYER } from "../ui/minimap.js";

// ---------------------------------------------------------------------
// The boost trail: a ribbon of light behind each car that shows the
// drift-boost economy (CAR.boost* in src/vehicle/config.js) at a glance.
//
//   CHARGING  while drifting, the rear lays down a faint ribbon in the
//             level's glow colour, stronger the harder the car slides
//             (vehicle.driftFactor): you can SEE the meter filling.
//   SPENDING  while boosting, the ribbon is wide and white-hot.
//
// The ribbon is made of cross-sections dropped behind the car at a fixed
// time interval; each remembers its age and its "heat" (how charged or
// boosting the car was when it was laid). In the shader, age is the
// DISSOLVE PROGRESS (src/lighting/dissolve-glsl.js): the oldest part of
// the trail burns away with a glowing edge rather than simply fading,
// the same effect the checkpoint gates use. A cooler sample dissolves
// sooner, so a short twitch leaves a short, broken trail and a long
// committed drift a long solid one.
//
// The noise is looked up by distance ALONG the trail (aDist), which
// stays with each cross-section, so the ragged pattern sits on the road
// where it was laid instead of sliding along with the car.
//
// One mesh and one draw call per car, rebuilt on the render frame: it is
// presentation only and never touches the simulation, so it cannot
// affect a replay.
// ---------------------------------------------------------------------

const STEP = 1 / 45; // s between cross-sections
const LIFE = 0.6; // s a cross-section lives
const N = Math.ceil(LIFE / STEP) + 2; // cross-sections per car, head included
const REAR = new THREE.Vector3(0, -0.3, 2.0); // trail origin in the car's frame (behind the rear axle)
const WIDTH_DRIFT = 1.5; // m
const WIDTH_BOOST = 1.9;
const TELEPORT = 12; // m in one frame: a respawn, not driving — start a fresh trail

const VERT = /* glsl */ `
  attribute float aAge;   // 0 just laid .. 1 end of life
  attribute float aHeat;  // 0 nothing .. ~0.5 drifting .. 1 boosting
  attribute float aSide;  // 0 left edge, 1 right edge
  attribute float aDist;  // m along the trail, fixed to the cross-section
  uniform float uTime;
  varying float vAge;
  varying float vHeat;
  varying float vSide;
  varying float vDist;
  varying float vDepth;
  ${NOISE}
  ${DISPLACE}
  #include <fog_pars_vertex>
  void main() {
    vAge = aAge; vHeat = aHeat; vSide = aSide; vDist = aDist;
    // A cooler cross-section is further through its dissolve at the same
    // age: (1 - heat) pushes it along.
    float progress = clamp(aAge + (1.0 - aHeat) * 0.45, 0.0, 1.0);
    float seed = dissolveNoise(vec3(aDist * 1.4, aSide * 2.0, 0.0));
    // World space already; the mesh sits at the origin. Up is the drift.
    vec3 p = dissolveDisplace(position, vec3(0.0, 1.0, 0.0), progress, seed, uTime, 0.6);
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    vDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAge;
  varying float vHeat;
  varying float vSide;
  varying float vDist;
  varying float vDepth;
  ${NOISE}
  ${EDGE}
  #include <fog_pars_fragment>
  void main() {
    if (vHeat < 0.02) discard;
    float progress = clamp(vAge + (1.0 - vHeat) * 0.45, 0.0, 1.0);
    float threshold = dissolveNoise(vec3(vDist * 1.4, vSide * 2.0, 0.0));
    float edge = dissolveEdge(threshold, progress, 0.12);

    // Soft across the ribbon, brightest down the middle.
    float across = 1.0 - pow(abs(vSide * 2.0 - 1.0), 2.0);
    // Drifting: the level colour. Boosting: hotter, part-way to white —
    // all the way to white lost the level's colour entirely.
    vec3 body = mix(uColor, vec3(1.0), 0.45 * smoothstep(0.6, 1.0, vHeat)) * (0.5 + 0.9 * vHeat);
    vec3 rim = mix(uColor, vec3(1.0), 0.4) * 4.0;
    vec3 c = mix(body * across, rim, edge);
    // Faded out right in front of the lens, like the smoke (smoke.js): the
    // trail streams straight back at the chase camera, and the last few
    // metres of it filled the bottom of the screen.
    c *= smoothstep(2.5, 8.0, vDepth);
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // Additive, so fog fades it to nothing (not to fog colour).
    #ifdef USE_FOG
      gl_FragColor.rgb *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  }`;

const _o = new THREE.Vector3();
const _r = new THREE.Vector3();

class Trail {
  constructor(material) {
    // Cross-section k: vertices 2k (left) and 2k+1 (right). k = 0 is the
    // head, glued to the car every frame; 1..N-1 are history, newest first.
    this.pos = new Float32Array(N * 2 * 3);
    this.age = new Float32Array(N * 2);
    this.heat = new Float32Array(N * 2);
    this.dist = new Float32Array(N * 2);
    const side = new Float32Array(N * 2);
    for (let k = 0; k < N; k++) side[2 * k + 1] = 1;
    this.age.fill(1); // everything starts dead

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAge", new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aHeat", new THREE.BufferAttribute(this.heat, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aDist", new THREE.BufferAttribute(this.dist, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    const idx = [];
    for (let k = 0; k < N - 1; k++) {
      const a = 2 * k;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    g.setIndex(idx);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false; // world-space positions, rebuilt every frame
    this.mesh.renderOrder = 2;
    this.mesh.layers.disable(MINIMAP_LAYER);
    this.clock = 0;
    this.travelled = 0;
    this.last = null;
  }

  /** Copy cross-section a over b (both indices of cross-sections). */
  #copy(from, to) {
    for (const v of [0, 1]) {
      const f = 2 * from + v;
      const t = 2 * to + v;
      this.pos[t * 3] = this.pos[f * 3];
      this.pos[t * 3 + 1] = this.pos[f * 3 + 1];
      this.pos[t * 3 + 2] = this.pos[f * 3 + 2];
      this.age[t] = this.age[f];
      this.heat[t] = this.heat[f];
      this.dist[t] = this.dist[f];
    }
  }

  update(dt, vehicle) {
    const st = vehicle.state;
    _o.copy(REAR).applyQuaternion(st.quaternion).add(st.position);
    if (this.last && this.last.distanceTo(_o) > TELEPORT) this.age.fill(1); // respawned
    if (this.last) this.travelled += this.last.distanceTo(_o);
    this.last = (this.last ?? new THREE.Vector3()).copy(_o);

    const heat = st.boosting ? 1 : st.driftFactor > 0 ? 0.3 + 0.35 * st.driftFactor : 0;
    const width = st.boosting ? WIDTH_BOOST : WIDTH_DRIFT;

    // Age the history.
    for (let i = 2; i < N * 2; i++) this.age[i] = Math.min(1, this.age[i] + dt / LIFE);

    // Time for a new cross-section: shift the history back one and drop
    // the head's current state in as the newest.
    this.clock += dt;
    if (this.clock >= STEP) {
      this.clock %= STEP;
      for (let k = N - 1; k >= 2; k--) this.#copy(k - 1, k);
      this.#copy(0, 1);
    }

    // The head follows the car exactly, every frame.
    _r.set(width / 2, 0, 0).applyQuaternion(st.quaternion);
    this.pos.set([_o.x - _r.x, _o.y - _r.y, _o.z - _r.z, _o.x + _r.x, _o.y + _r.y, _o.z + _r.z], 0);
    this.age[0] = this.age[1] = 0;
    this.heat[0] = this.heat[1] = heat;
    this.dist[0] = this.dist[1] = this.travelled;

    const a = this.geometry.attributes;
    a.position.needsUpdate = a.aAge.needsUpdate = a.aHeat.needsUpdate = a.aDist.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
  }
}

export class BoostTrails {
  /**
   * @param {THREE.Scene} scene
   * @param {Array} cars  race.cars ({ vehicle })
   * @param {object} opts { color }
   */
  constructor(scene, cars, { color = 0x35d0ff } = {}) {
    this.scene = scene;
    this.time = 0;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 } },
      ]),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.trails = cars.map((c) => {
      const t = new Trail(this.material);
      scene.add(t.mesh);
      return { trail: t, vehicle: c.vehicle };
    });
  }

  /** Once per rendered frame. */
  update(dt) {
    dt = Math.min(dt, 0.1); // a tab coming back from the background
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    for (const { trail, vehicle } of this.trails) trail.update(dt, vehicle);
  }

  dispose() {
    for (const { trail } of this.trails) {
      this.scene.remove(trail.mesh);
      trail.dispose();
    }
    this.material.dispose();
    this.trails.length = 0;
  }
}
