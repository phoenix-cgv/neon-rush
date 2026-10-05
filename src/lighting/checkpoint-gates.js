import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { NOISE, DISPLACE, EDGE } from "./dissolve-glsl.js";
import { MINIMAP_LAYER } from "../ui/minimap.js";
import { CAR } from "../vehicle/config.js";

// ---------------------------------------------------------------------
// Checkpoint gates: a neon arch marking the NEXT checkpoint. It builds
// itself up ahead of the player, and dissolves into glowing fragments
// the moment they drive through it; then the following one appears.
//
// Checkpoints themselves are invisible: Progress counts them from `s`
// alone (src/core/progress.js). The gates are presentation only. They
// read the player's progress and change nothing in the simulation, so a
// gate can never block a car or disagree with the lap counter.
//
// ONE GATE AT A TIME. Every checkpoint standing at once was eighteen
// arches on the Grand Prix, which is clutter, not information. Showing
// only the next one turns the gate into guidance: it says where you are
// heading. The one just passed finishes dissolving behind you.
//
// PLACED WHERE IT FITS. An arch's posts stand just outside the legal
// racing band, which is exactly where scenery stands: gantry pillars, the
// pit wall, lamp posts, trees. Before a gate is placed, its two posts and
// its beam are tested against
//   - the map's own objects, by their bounding boxes (lamp posts, trees,
//     signs: scenery that has no collider), and
//   - the physics world, for solid things (walls, rails, pit wall, tyre
//     walls), ground excluded.
// If anything is in the way the gate slides BACK along the track, a few
// metres at a time, until it is clear. Only back: a gate past its
// checkpoint would still be standing when the lap counter had already
// moved on. If nothing is clear within GIVE_UP metres, that checkpoint
// has no gate. Placement is measured, so it stays right when a map is
// re-exported.
//
// No gate stands on the start/finish line (checkpoint 0): every level
// already has a real gantry there.
//
// All of a level's gates are ONE InstancedMesh (one draw call). Each has
// its own dissolve progress in an instanced attribute, `aProgress`.
//
// The glow colour is the level's (`lit.glow`): cyan in the City, amber on
// the Mountain, magenta at the Grand Prix.
// ---------------------------------------------------------------------

const HEIGHT = 5.5; // m from the road to the top of the arch
const TUBE = 0.28; // m, thickness of the neon tubes
// Where the posts stand: beyond the racing band by a car's half-width and
// a margin. The band (wallLimit) limits the car's CENTRE, so a car pressed
// against the wall reaches 0.85 m further out; posts any closer would be
// driven straight through. This also puts them behind the Mountain's
// rails and the Grand Prix's armco rather than in them.
const OUTSIDE = CAR.halfExtents.x + 0.6;
const STEP_BACK = 4; // m per placement attempt
const GIVE_UP = 32; // m behind its checkpoint, at most
const DISSOLVE_TIME = 0.9; // s for a passed gate to burn away
const BUILD_TIME = 1.6; // s for the next gate to build itself up
const CROSS_WINDOW = 40; // m past a gate that still counts as "just driven through it"
const BIG = 40; // m: map objects wider than this (terrain, road ribbons) are not obstacles

const VERT = /* glsl */ `
  attribute float aProgress;
  uniform float uTime;
  varying float vProgress;
  varying vec3 vLocal;
  ${NOISE}
  ${DISPLACE}
  #include <fog_pars_vertex>
  void main() {
    vProgress = aProgress;
    vLocal = position;
    // Noise scale 0.9: blobs about a metre across on an 18 m arch.
    float seed = dissolveNoise(position * 0.9);
    vec3 p = dissolveDisplace(position, normal, aProgress, seed, uTime, 2.5);
    // instanceMatrix places this gate at its spot, facing along the
    // track: a per-instance model matrix three supplies.
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vProgress;
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

/**
 * Bounding boxes of the map's standing objects, once per map. Flat
 * things (paint, kerbs) and huge things (terrain, the road itself) are
 * left out: a box round either is mostly empty space.
 */
const sceneryCache = new WeakMap();
function sceneryBoxes(root) {
  if (!root) return [];
  if (sceneryCache.has(root)) return sceneryCache.get(root);
  const boxes = [];
  const size = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const b = new THREE.Box3().setFromObject(o);
    b.getSize(size);
    if (size.y < 0.3 || size.x > BIG || size.z > BIG) return;
    // For diagnosing a blocked spot: the node's name, or its parent's for
    // a primitive of a multi-material node.
    b.name = o.parent && o.parent !== root && o.parent.isGroup ? o.parent.name : o.name;
    boxes.push(b);
  });
  sceneryCache.set(root, boxes);
  return boxes;
}

const _fr = {};
const _m = new THREE.Matrix4();
const _neg = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _probe = new THREE.Box3();
const _half = new THREE.Vector3();

export class CheckpointGates {
  /**
   * @param {object} track
   * @param {THREE.Scene} scene
   * @param {object} opts
   *   color    the level's glow colour
   *   scenery  the loaded map's root (gltf.scene), for the clearance test
   *   RAPIER, world  for testing against solid objects
   */
  constructor(track, scene, { color = 0x35d0ff, scenery = null, RAPIER = null, world = null } = {}) {
    this.track = track;
    this.scene = scene;
    this.RAPIER = RAPIER;
    this.world = world;
    this.boxes = sceneryBoxes(scenery);
    this.halfWidth = track.checkpoints[0].halfWidth + OUTSIDE;
    this.time = 0;
    this.frames = 0;
    this.gates = null; // placed lazily, see update()
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 } },
      ]),
      fog: true,
    });
    this.mesh = null;
  }

  // -------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------

  /** Is an axis-aligned probe box free of every scenery box? */
  #boxClear(centre, halfSize) {
    _probe.setFromCenterAndSize(centre, _half.copy(halfSize).multiplyScalar(2));
    for (const b of this.boxes) if (b.intersectsBox(_probe)) return false;
    return true;
  }

  /** Is a post standing at `base` clear of solid objects (ground excluded)? */
  #solidClear(base, up) {
    if (!this.world) return true;
    const R = this.RAPIER;
    // From 0.4 m up (so the ground it stands on does not count) to the top.
    const halfH = (HEIGHT - 0.4) / 2;
    const centre = _a.copy(base).addScaledVector(up, 0.4 + halfH);
    let hit = false;
    this.world.intersectionsWithShape(
      { x: centre.x, y: centre.y, z: centre.z },
      { x: 0, y: 0, z: 0, w: 1 },
      new R.Cylinder(halfH, 0.35),
      () => {
        hit = true;
        return false; // one is enough
      },
      undefined,
      undefined,
      undefined,
      undefined,
      (c) => !this.track.surfaceHandles.has(c.handle) && (c.parent()?.isFixed() ?? true)
    );
    return !hit;
  }

  /** Could an arch stand at s? Both posts and the beam must be clear. */
  #fits(s) {
    this.track.frameAt(s, _fr);
    const posts = [-1, 1].map((side) =>
      _fr.position.clone().addScaledVector(_fr.right, side * this.halfWidth)
    );
    for (const base of posts) {
      if (!this.#solidClear(base, _fr.up)) return false;
      if (!this.#boxClear(_b.copy(base).addScaledVector(_fr.up, HEIGHT / 2 + 0.3), _half.set(0.5, HEIGHT / 2 - 0.2, 0.5).clone())) return false;
    }
    // The beam, sampled every 1.5 m across the road at its own height:
    // catches lamp arms and anything else overhanging the road.
    const n = Math.ceil((this.halfWidth * 2) / 1.5);
    for (let k = 0; k <= n; k++) {
      _b.lerpVectors(posts[0], posts[1], k / n).addScaledVector(_fr.up, HEIGHT - 0.3);
      if (!this.#boxClear(_b, _half.set(0.6, 0.6, 0.6).clone())) return false;
    }
    return true;
  }

  #place() {
    const cps = this.track.checkpoints;
    this.gates = [];
    this.skipped = [];
    this.moved = [];
    for (let i = 1; i < cps.length; i++) {
      let at = null;
      for (let back = 0; back <= GIVE_UP; back += STEP_BACK) {
        const s = this.track.spline.wrapS(cps[i].s - back);
        if (this.#fits(s)) {
          at = s;
          if (back > 0) this.moved.push({ checkpoint: i, back });
          break;
        }
      }
      if (at === null) this.skipped.push(i);
      else this.gates.push({ checkpoint: i, s: at });
    }

    const geo = archGeometry(this.halfWidth);
    this.progress = new Float32Array(Math.max(1, this.gates.length)).fill(1); // all hidden
    this.target = new Float32Array(this.progress.length).fill(1);
    this.attr = new THREE.InstancedBufferAttribute(this.progress, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aProgress", this.attr);
    this.mesh = new THREE.InstancedMesh(geo, this.material, this.progress.length);
    this.mesh.name = "CheckpointGates";
    this.mesh.frustumCulled = false; // they ring the whole lap
    this.mesh.layers.disable(MINIMAP_LAYER);
    this.mesh.count = this.gates.length;
    this.gates.forEach((g, k) => {
      this.track.frameAt(g.s, _fr);
      // right x up = -tangent for this track's frames, so (right, up,
      // -tangent) is a proper rotation; the arch is symmetric along z.
      _m.makeBasis(_fr.right, _fr.up, _neg.copy(_fr.tangent).negate()).setPosition(_fr.position);
      this.mesh.setMatrixAt(k, _m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.mesh);
  }

  // -------------------------------------------------------------------

  /**
   * Once per rendered frame.
   * @param {number} dt
   * @param {number} playerS   the player's s
   * @param {object} progress  the player's Progress
   */
  update(dt, playerS, progress) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    // Placement waits a few frames: the physics world's scene queries
    // only know about colliders once it has stepped.
    if (!this.gates) {
      if (++this.frames < 3) return;
      this.#place();
    }
    if (!progress || this.gates.length === 0) return;

    const L = this.track.length;
    const next = progress.nextCheckpoint;
    const last = progress.lastCheckpoint;
    let changed = false;
    this.gates.forEach((g, k) => {
      let to = 1;
      if (g.checkpoint === next) {
        // Ahead: build it. Just driven through: dissolve it.
        let ds = playerS - g.s;
        if (ds < -L / 2) ds += L;
        if (ds > L / 2) ds -= L;
        to = ds >= 0 && ds < CROSS_WINDOW ? 1 : 0;
      } else if (g.checkpoint !== last) {
        // Neither next nor just passed: gone, instantly.
        if (this.progress[k] !== 1) {
          this.progress[k] = 1;
          changed = true;
        }
      }
      this.target[k] = to;
      const cur = this.progress[k];
      if (cur === to) return;
      const rate = to > cur ? 1 / DISSOLVE_TIME : 1 / BUILD_TIME;
      this.progress[k] = to > cur ? Math.min(to, cur + rate * dt) : Math.max(to, cur - rate * dt);
      changed = true;
    });
    if (changed) this.attr.needsUpdate = true;
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
    }
    this.material.dispose();
  }
}
