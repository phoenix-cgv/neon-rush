import * as THREE from "three";
import { NOISE, DISPLACE, EDGE } from "./dissolve-glsl.js";
import { MINIMAP_LAYER } from "../ui/minimap.js";

// ---------------------------------------------------------------------
// Checkpoint gates: a holographic light curtain across the road at every
// checkpoint, which dissolves into glowing fragments the moment the
// player drives through it.
//
// Checkpoints themselves are invisible: Progress counts them from `s`
// alone (src/core/progress.js). These are presentation only. They read
// the `checkpoint` event and change nothing in the simulation, so a gate
// can never block a car or disagree with the lap counter.
//
// Why a curtain and not an arch. The first version was a neon arch with
// posts at the edge of the legal racing band, and the posts met whatever
// stands there: at the Grand Prix one was buried in the start gantry's
// pillar while the other stood in front of it, and elsewhere they could
// meet lamp posts or the pit wall. A curtain has nothing touching the
// ground at its ends: it is only as wide as the road, and fades out
// sideways, so it never meets the scenery hard.
//
// The curtain is a single flat sheet, drawn ADDITIVELY (it only ever
// adds light, so it is see-through):
//
//   a bright line on the road and another along the top edge
//   scanlines rising up through it, so it reads as a projection
//   a fade at both ends, and toward the camera: the chase camera passes
//   right through every gate, and a sheet of light a metre from the lens
//   would fill the screen.
//
// No gate stands on the start/finish line (checkpoint 0): every level
// already has a real gantry there, and the player spawns on that line,
// so a gate there sat directly over the car on the grid.
//
// All of a level's gates are ONE InstancedMesh (one draw call however
// many checkpoints there are). Each instance has its own dissolve
// progress in an instanced attribute, `aProgress`, so one shader handles
// a whole gate burning away while the next one stands untouched.
//
// A gate the player has passed re-forms once they are half a lap past
// it, out of sight, so the next lap has gates again; on a one-lap level
// that never comes up.
//
// The glow colour is the level's (`lit.glow`): cyan in the City, amber on
// the Mountain, magenta at the Grand Prix.
// ---------------------------------------------------------------------

const HEIGHT = 4.2; // m from the road to the top edge
const DISSOLVE_TIME = 0.9; // s for a passed gate to burn away completely
const REFORM_TIME = 1.6; // s to build back up (out of sight anyway)

const VERT = /* glsl */ `
  attribute float aProgress;
  uniform float uTime;
  varying float vProgress;
  varying vec3 vLocal;
  varying vec2 vUv;
  varying float vDepth;
  ${NOISE}
  ${DISPLACE}
  #include <fog_pars_vertex>
  void main() {
    vProgress = aProgress;
    vLocal = position;
    vUv = uv;
    // Noise scale 0.9: blobs about a metre across.
    float seed = dissolveNoise(position * 0.9);
    vec3 p = dissolveDisplace(position, normal, aProgress, seed, uTime, 2.5);
    // instanceMatrix places this gate at its checkpoint, facing along
    // the track: a per-instance model matrix three supplies.
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    vDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vProgress;
  varying vec3 vLocal;
  varying vec2 vUv;
  varying float vDepth;
  ${NOISE}
  ${EDGE}
  #include <fog_pars_fragment>
  void main() {
    // Recompute the noise per FRAGMENT rather than interpolating the
    // vertex value: the edge then follows the noise exactly instead of
    // the triangle mesh, and stays sharp.
    float threshold = dissolveNoise(vLocal * 0.9);
    float edge = dissolveEdge(threshold, vProgress, 0.09);

    // u runs across the road (0..1), v up the curtain (0 road .. 1 top).
    float ends = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
    float scan = 0.55 + 0.45 * sin(vUv.y * 70.0 - uTime * 5.0);
    float sheet = 0.16 * scan * mix(1.0, 0.35, vUv.y); // strongest low down
    float lines = smoothstep(0.05, 0.0, vUv.y) * 1.6 + smoothstep(0.97, 1.0, vUv.y) * 1.2;
    vec3 c = uColor * (sheet + lines);
    // The burning edge: far brighter than the sheet, so bloom catches it.
    c += mix(uColor, vec3(1.0), 0.35) * 5.0 * edge;
    c *= ends * smoothstep(2.0, 9.0, vDepth);

    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // Additive, so fog fades it to nothing (not to fog colour).
    #ifdef USE_FOG
      gl_FragColor.rgb *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  }`;

/** The curtain, in the gate's own frame: x across the road, y up. */
function curtainGeometry(width) {
  // Subdivided so the vertex shader has vertices to push around while it
  // dissolves; a two-triangle quad could only move at its corners.
  const g = new THREE.PlaneGeometry(width, HEIGHT, Math.round(width * 2), 12);
  g.translate(0, HEIGHT / 2, 0);
  return g;
}

const _m = new THREE.Matrix4();
const _neg = new THREE.Vector3();

export class CheckpointGates {
  /**
   * @param {object} track
   * @param {THREE.Scene} scene
   * @param {object} opts { color }
   */
  constructor(track, scene, { color = 0x35d0ff } = {}) {
    this.scene = scene;
    const cps = track.checkpoints;
    this.count = cps.length;
    this.time = 0;
    // Current and target progress per gate; the shader reads `progress`.
    this.progress = new Float32Array(this.count);
    this.target = new Float32Array(this.count);
    // The start/finish line has its own gantry: no gate there, ever.
    this.progress[0] = this.target[0] = 1;

    // The paved road plus half a metre either side; the ends fade anyway.
    const geo = curtainGeometry(track.width + 1);
    this.attr = new THREE.InstancedBufferAttribute(this.progress, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aProgress", this.attr);

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

    this.mesh = new THREE.InstancedMesh(geo, this.material, this.count);
    this.mesh.name = "CheckpointGates";
    this.mesh.frustumCulled = false; // they ring the whole lap
    this.mesh.renderOrder = 2;
    this.mesh.layers.disable(MINIMAP_LAYER);
    cps.forEach((cp, i) => {
      // right x up = -tangent for this track's frames, so (right, up,
      // -tangent) is a proper rotation.
      _m.makeBasis(cp.right, cp.up, _neg.copy(cp.tangent).negate()).setPosition(cp.position);
      this.mesh.setMatrixAt(i, _m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  /** The player drove through checkpoint i. */
  pass(i) {
    this.target[i] = 1;
    // The gate half a lap away is behind the player and out of sight:
    // build it back for the next lap (never the start/finish line).
    const back = (i + Math.floor(this.count / 2)) % this.count;
    if (back !== 0) this.target[back] = 0;
  }

  /** Once per rendered frame. */
  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      const cur = this.progress[i];
      const to = this.target[i];
      if (cur === to) continue;
      const rate = to > cur ? 1 / DISSOLVE_TIME : 1 / REFORM_TIME;
      this.progress[i] = to > cur ? Math.min(to, cur + rate * dt) : Math.max(to, cur - rate * dt);
      changed = true;
    }
    if (changed) this.attr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
