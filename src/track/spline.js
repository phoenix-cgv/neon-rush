import * as THREE from "three";

// ---------------------------------------------------------------------
// The track centreline.
//
// Everything downstream is expressed in ONE number: s, the distance in
// metres along the centreline. Lap timing, race position, the minimap,
// checkpoints, hazard triggers, respawn points and the AI's lookahead all
// read it, which is why this file exists even though Rapier does the
// ground queries.
//
// Two decisions worth defending:
//
//   Arc-length parameterisation. s is metres, not a curve parameter, so
//   "150 m along" means the same thing everywhere regardless of how the
//   control points happen to be spaced.
//
//   Frames are built from world up, not Frenet. A Frenet frame twists
//   through an inflection and would barrel-roll the road; deriving right
//   from (tangent x worldUp) keeps the surface upright, and banking is
//   then applied deliberately rather than as an artefact.
// ---------------------------------------------------------------------

const WORLD_UP = new THREE.Vector3(0, 1, 0);

const _p = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _proj = new THREE.Vector3();

/** Closest point on segment a->b to p. Returns the parametric 0..1. */
function projectOnSegment(p, a, b) {
  _ab.subVectors(b, a);
  const lenSq = _ab.lengthSq();
  if (lenSq < 1e-9) return 0;
  _ap.subVectors(p, a);
  return Math.max(0, Math.min(1, _ap.dot(_ab) / lenSq));
}

export class TrackSpline {
  /**
   * @param {THREE.Vector3[]} points control points
   * @param {{closed?: boolean, spacing?: number, banking?: number[]}} opts
   */
  constructor(points, { closed = true, spacing = 2, banking = null } = {}) {
    // "centripetal" avoids the cusps and overshoot that the uniform
    // variety produces when control points are unevenly spaced — which
    // on a race track shows up as a kink you cannot tune out.
    this.curve = new THREE.CatmullRomCurve3(
      points.map((p) => p.clone()),
      closed,
      "centripetal",
      0.5
    );
    this.curve.arcLengthDivisions = Math.max(2000, points.length * 60);

    this.closed = closed;
    this.length = this.curve.getLength();
    this.count = Math.max(16, Math.round(this.length / spacing));
    this.step = this.length / this.count;

    // Uniform arc-length samples. Because they are evenly spaced, an s
    // maps to an index by division rather than a search.
    const n = closed ? this.count : this.count + 1;
    this.pos = new Array(n);
    this.tan = new Array(n);
    this.right = new Array(n);
    this.up = new Array(n);
    this.curvature = new Float32Array(n);
    this.bank = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const u = (i / this.count) % 1;
      const p = this.curve.getPointAt(closed ? u : i / this.count);
      const t = this.curve
        .getTangentAt(closed ? u : i / this.count)
        .normalize();

      const right = new THREE.Vector3().crossVectors(t, WORLD_UP);
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0); // near-vertical guard
      right.normalize();
      const up = new THREE.Vector3().crossVectors(right, t).normalize();

      this.pos[i] = p;
      this.tan[i] = t;
      this.right[i] = right;
      this.up[i] = up;
      if (banking) this.bank[i] = banking[i % banking.length] || 0;
    }

    // Curvature by finite difference of the tangents: kappa = |dT/ds|.
    // Level 3's AI reads this to work out how fast it can take a corner,
    // so it comes from the same geometry the player drives on.
    for (let i = 0; i < n; i++) {
      const a = this.tan[this.#wrap(i - 1)];
      const b = this.tan[this.#wrap(i + 1)];
      this.curvature[i] = a.distanceTo(b) / (2 * this.step);
    }

    // Apply banking to the frames after the fact, so bank is a design
    // choice rather than something the curve maths decided for us.
    if (banking) {
      for (let i = 0; i < n; i++) {
        const angle = this.bank[i];
        if (angle === 0) continue;
        this.right[i].applyAxisAngle(this.tan[i], angle);
        this.up[i].applyAxisAngle(this.tan[i], angle);
      }
    }
  }

  #wrap(i) {
    const n = this.pos.length;
    if (this.closed) return ((i % n) + n) % n;
    return Math.max(0, Math.min(n - 1, i));
  }

  /** Wrap a distance into [0, length) for closed tracks. */
  wrapS(s) {
    if (!this.closed) return Math.max(0, Math.min(this.length, s));
    return ((s % this.length) + this.length) % this.length;
  }

  /**
   * Position, tangent, right and up at distance s. Writes into `out` to
   * keep this allocation-free on the hot path.
   */
  frameAt(s, out = {}) {
    const f = this.wrapS(s) / this.step;
    const i0 = this.#wrap(Math.floor(f));
    const i1 = this.#wrap(Math.floor(f) + 1);
    const a = f - Math.floor(f);

    out.position = (out.position || new THREE.Vector3())
      .copy(this.pos[i0])
      .lerp(this.pos[i1], a);
    out.tangent = (out.tangent || new THREE.Vector3())
      .copy(this.tan[i0])
      .lerp(this.tan[i1], a)
      .normalize();
    out.right = (out.right || new THREE.Vector3())
      .copy(this.right[i0])
      .lerp(this.right[i1], a)
      .normalize();
    out.up = (out.up || new THREE.Vector3())
      .copy(this.up[i0])
      .lerp(this.up[i1], a)
      .normalize();
    out.curvature =
      this.curvature[i0] * (1 - a) + this.curvature[i1] * a;
    return out;
  }

  curvatureAt(s) {
    const f = this.wrapS(s) / this.step;
    const i0 = this.#wrap(Math.floor(f));
    const i1 = this.#wrap(Math.floor(f) + 1);
    const a = f - Math.floor(f);
    return this.curvature[i0] * (1 - a) + this.curvature[i1] * a;
  }

  /**
   * Project a world position onto the centreline.
   *
   * With a hint this is O(1): the car cannot teleport, so this step's s is
   * within a few metres of the last one and a small window around it is
   * enough. Without a hint it scans everything, which is fine at spawn and
   * nowhere else — pass the hint on the hot path.
   *
   * @returns {{s: number, t: number, distance: number}}
   *          t is the signed lateral offset, positive to the right.
   */
  project(worldPos, sHint = null, windowMetres = 12) {
    const n = this.pos.length;
    let best = 0;
    let bestD = Infinity;

    if (sHint === null) {
      for (let i = 0; i < n; i++) {
        const d = this.pos[i].distanceToSquared(worldPos);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    } else {
      const centre = Math.round(this.wrapS(sHint) / this.step);
      const win = Math.max(2, Math.ceil(windowMetres / this.step));
      for (let k = -win; k <= win; k++) {
        const i = this.#wrap(centre + k);
        const d = this.pos[i].distanceToSquared(worldPos);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }

    // Refine against the two segments either side of the best sample, so
    // the answer is continuous rather than snapping to sample points.
    let bestS = best * this.step;
    let bestSegD = Infinity;
    for (const off of [-1, 0]) {
      const iA = this.#wrap(best + off);
      const iB = this.#wrap(best + off + 1);
      const a = this.pos[iA];
      const b = this.pos[iB];
      const u = projectOnSegment(worldPos, a, b);
      _proj.copy(a).lerp(b, u);
      const d = _proj.distanceToSquared(worldPos);
      if (d < bestSegD) {
        bestSegD = d;
        bestS = (this.#wrap(best + off) + u) * this.step;
        // guard the wrap seam on a closed loop
        if (this.closed && off === -1 && best === 0) {
          bestS = this.length - (1 - u) * this.step;
        }
      }
    }

    const s = this.wrapS(bestS);
    const fr = this.frameAt(s, _frameScratch);
    _p.subVectors(worldPos, fr.position);
    return { s, t: _p.dot(fr.right), distance: Math.sqrt(bestSegD) };
  }
}

const _frameScratch = {};
