import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { NOISE, DISPLACE, EDGE } from "./dissolve-glsl.js";
import { MINIMAP_LAYER } from "../ui/minimap.js";

// ---------------------------------------------------------------------
// Checkpoint gates: a neon arch over every checkpoint, which dissolves
// into glowing fragments the moment the player drives through it.
//
// Checkpoints themselves are invisible: Progress counts them from `s`
// alone (src/core/progress.js). These are presentation only. They read
// the `checkpoint` event and change nothing in the simulation, so a gate
// can never block a car or disagree with the lap counter.
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

const HEIGHT = 5.5; // m from the road to the top of the arch
const TUBE = 0.28; // m, thickness of the neon tubes
const DISSOLVE_TIME = 0.9; // s for a passed gate to burn away completely
const REFORM_TIME = 1.6; // s to build back up (out of sight anyway)

const VERT = /* glsl */ `
  attribute float aProgress;
  uniform float uTime;
  varying float vProgress;
  varying float vThreshold;
  varying vec3 vLocal;
  ${NOISE}
  ${DISPLACE}
  #include <fog_pars_vertex>
  void main() {
    vProgress = aProgress;
    vLocal = position;
    // Noise scale 0.9: blobs about a metre across on an 18 m arch.
    float seed = dissolveNoise(position * 0.9);
    vThreshold = seed;
    vec3 p = dissolveDisplace(position, normal, aProgress, seed, uTime, 2.5);
    // instanceMatrix places this gate at its checkpoint, facing along
    // the track: a per-instance model matrix three supplies.
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vProgress;
  varying float vThreshold;
  varying vec3 vLocal;
  ${NOISE}
  ${EDGE}
  #include <fog_pars_fragment>
  void main() {
    // Recompute the noise per FRAGMENT rather than interpolating the
    // vertex value: the edge then follows the noise exactly instead of
    // the triangle mesh, and stays sharp.
    float threshold = dissolveNoise(vLocal * 0.9);
    float edge = dissolveEdge(threshold, vProgress, 0.09);

    // The tube itself: the level colour, with bands of light running up
    // the posts and across the beam so the gate reads as energised.
    float bands = 0.75 + 0.25 * sin((vLocal.x + vLocal.y) * 2.2 - uTime * 6.0);
    vec3 body = uColor * 1.3 * bands;
    // The burning edge: far brighter than the body, so bloom catches it.
    vec3 rim = mix(uColor, vec3(1.0), 0.35) * 7.0;
    gl_FragColor = vec4(mix(body, rim, edge), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

/** The arch, in the gate's own frame: x across the road, y up, z along it. */
function archGeometry(halfWidth) {
  const w = halfWidth * 2;
  // Subdivided so the vertex shader has vertices to push around: a
  // 24-vertex box could only move at its corners.
  const post = () => new THREE.BoxGeometry(TUBE, HEIGHT, TUBE, 1, 22, 1);
  const left = post().translate(-halfWidth, HEIGHT / 2, 0);
  const right = post().translate(halfWidth, HEIGHT / 2, 0);
  const beam = new THREE.BoxGeometry(w + TUBE, TUBE, TUBE, Math.round(w * 2), 1, 1).translate(0, HEIGHT, 0);
  // A second, thinner bar under the beam: the sign-gantry silhouette.
  const bar = new THREE.BoxGeometry(w, TUBE * 0.5, TUBE * 0.5, Math.round(w * 2), 1, 1).translate(0, HEIGHT - 0.7, 0);
  const g = mergeGeometries([left, right, beam, bar], false);
  for (const p of [left, right, beam, bar]) p.dispose();
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

    const geo = archGeometry(cps[0].halfWidth + 0.6);
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
      fog: true,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, this.count);
    this.mesh.name = "CheckpointGates";
    this.mesh.frustumCulled = false; // they ring the whole lap
    this.mesh.layers.disable(MINIMAP_LAYER);
    cps.forEach((cp, i) => {
      // right x up = -tangent for this track's frames, so (right, up,
      // -tangent) is a proper rotation; the arch is symmetric along z.
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
    // build it back for the next lap.
    this.target[(i + Math.floor(this.count / 2)) % this.count] = 0;
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
