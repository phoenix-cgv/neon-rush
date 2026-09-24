import * as THREE from "three";
import { TrackSpline } from "./spline.js";
import { MAP_WORLD_LAYER } from "../ui/minimap.js";

// ---------------------------------------------------------------------
// The track: geometry, colliders, checkpoints, and the API level authors
// build against.
//
// Level authors never call Rapier directly. They register through here,
// which is what keeps the section-2 fallback cheap — if the physics
// backend ever changes, no level code changes with it.
//
// The road mesh and the road collider are generated from the SAME vertex
// array. That is not tidiness: the first testbed drew a half-cylinder and
// collided a full one, and the thing you could see was not the thing you
// hit.
// ---------------------------------------------------------------------

const _fr = {};
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _scale = new THREE.Vector3(1, 1, 1);

export class Track {
  /**
   * @param {object} RAPIER
   * @param {object} world   Rapier world
   * @param {THREE.Scene} scene
   * @param {object} def     { points, closed, width, banking, ... }
   */
  constructor(RAPIER, world, scene, def) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.scene = scene;
    this.def = def;

    this.width = def.width ?? 16;
    // A modelled map (see levels/glb-map.js) brings its own road, kerbs and
    // ground as `surfaces`, and none of the generated ribbons, kerbs,
    // markings or barriers are built: the model is what you see, so the
    // model is what you drive on.
    this.modelled = Array.isArray(def.surfaces);
    // Where the soft wall bites. The visual barriers are drawn here too,
    // so what stops you is exactly what you can see.
    this.wallLimit = def.wallLimit ?? (def.width ?? 16) * 0.5 + 0.9;
    // Where the un-stick push engages. On a generated track the barrier
    // sits 0.9 m off the road edge, so this is the road edge. A modelled
    // map puts its (soft) wall out on the pavement or verge, and keying
    // the push to the road edge there would shove every car back onto
    // the tarmac whenever it put a wheel on the grass.
    this.pushOffEdge = this.wallLimit - 0.9;
    // Off by default. The walls are real geometry again now that they are
    // seamless; the soft-wall constraint stays available as a fallback for
    // any level where solid barriers prove troublesome.
    this.softWalls = def.softWalls === true;
    this.runoffHalfWidth =
      def.runoffHalfWidth ??
      (def.runoff === false ? this.width * 0.5 : (this.width * (def.runoffWidth ?? 3.2)) * 0.5);
    this.spline = new TrackSpline(def.points, {
      closed: def.closed ?? true,
      spacing: def.spacing ?? 2,
      banking: def.banking ?? null,
    });

    this.objects = []; // everything we added to the scene, for dispose()
    this.bodies = []; // everything we added to the physics world
    this.colliders = new Map(); // id -> { collider, body, mesh, s0, s1 }
    // Handles of the road and runoff ribbons. The vehicle needs to know
    // these are ground, never wall: a trimesh throws near-horizontal
    // contact normals at its triangle edges, so a car bottoming out on
    // the road was being charged for a wall impact in the middle of it.
    this.surfaceHandles = new Set();
    this.forceFields = new Map(); // id -> { s0, s1, fn }
    this.#nextId = 1;

    if (this.modelled) {
      for (const surf of def.surfaces) this.#buildSurfaceCollider(surf);
      this.#buildCheckpoints(def.checkpointSpacing ?? 140);
      this.#measureCorners();
      return;
    }

    // Runoff first, so the road sits on top of it. A wide grass ribbon
    // swept from the same spline means leaving the road is a mistake you
    // can recover from, and — unlike a flat ground plane — it follows the
    // track's elevation instead of fighting it.
    if (def.runoff !== false) {
      this.#buildRibbon({
        width: this.width * (def.runoffWidth ?? 3.2),
        lift: -0.12,
        color: def.runoffColor ?? 0x4f6047,
        friction: 0.7,
        name: "Runoff",
        uvScale: 3,
      });
    }
    this.#buildRibbon({
      width: this.width,
      lift: 0.01,
      color: def.roadColor ?? 0x40484e,
      friction: 1.0,
      name: "RoadMesh",
      uvScale: 8,
      keepRef: true,
    });
    this.#buildKerbs();
    this.#buildMarkings();
    this.#buildBarriers();
    this.#buildCheckpoints(def.checkpointSpacing ?? 140);
    this.#checkRibbonWidth();
  }

  #nextId;

  /**
   * A ribbon swept along a curve pinches on the inside of a corner: the
   * inner edge follows radius (R - halfWidth). As that approaches zero the
   * triangles crumple into a near-vertical, near-degenerate sheet — which
   * you collide with but can barely see. It reads in play as an invisible
   * wall that stops the car dead, and it is invisible in the source too,
   * so it gets checked at build time instead.
   */
  #measureCorners() {
    let minR = Infinity;
    for (let i = 0; i < this.spline.curvature.length; i++) {
      const k = this.spline.curvature[i];
      if (k > 1e-9) minR = Math.min(minR, 1 / k);
    }
    this.minCornerRadius = minR;
    return minR;
  }

  #checkRibbonWidth() {
    const minR = this.#measureCorners();
    const innerRadius = minR - this.runoffHalfWidth;
    if (innerRadius < 12) {
      console.warn(
        `[Track] Runoff half-width ${this.runoffHalfWidth.toFixed(1)} m is too ` +
          `wide for the tightest corner (${minR.toFixed(1)} m radius): the inner ` +
          `edge pinches to ${innerRadius.toFixed(1)} m and will crumple into ` +
          `invisible collision geometry. Reduce runoffWidth.`
      );
    }
  }

  get length() {
    return this.spline.length;
  }

  // -------------------------------------------------------------------
  // Queries — the reason this module exists
  // -------------------------------------------------------------------

  /** @returns {{s, t, distance}} — pass sHint on the hot path. */
  project(worldPos, sHint = null) {
    return this.spline.project(worldPos, sHint);
  }

  frameAt(s, out) {
    return this.spline.frameAt(s, out);
  }

  curvatureAt(s) {
    return this.spline.curvatureAt(s);
  }

  /**
   * Fastest a car can hold a corner here: v = sqrt(mu * g / kappa).
   * Level 3's AI brakes because this says it must, not because someone
   * placed a brake marker.
   */
  cornerSpeedAt(s, mu = 1.4, g = 9.81) {
    const k = this.curvatureAt(s);
    if (k < 1e-5) return Infinity;
    const bank = this.#bankIntoTurn(s);
    if (bank === 0) return Math.sqrt((mu * g) / k);
    // Banked curve: v^2 = g R (sin b + mu cos b) / (cos b - mu sin b),
    // b positive when the road leans INTO the corner. With b = 0 it is the
    // flat formula above. A modelled map can lean the other way — the
    // Mountain Track's first corner is a 6 m hairpin with its inside
    // edge 6 m higher than its outside — and there the car has half the
    // grip the flat formula promises.
    const c = Math.cos(bank);
    const sn = Math.sin(bank);
    const den = c - mu * sn;
    if (den <= 1e-3) return Infinity; // steep enough to hold any speed
    return Math.sqrt(Math.max(0, (g * (sn + mu * c)) / (k * den)));
  }

  /** Bank at s, signed so that positive leans into the corner. */
  #bankIntoTurn(s) {
    const i = Math.round(this.spline.wrapS(s) / this.spline.step) % this.spline.bank.length;
    const bank = this.spline.bank[i];
    if (bank === 0) return 0;
    // Which way the corner turns: along the change in tangent, seen
    // against the right vector. The spline's bank tips its right side
    // DOWN when positive, which leans into a RIGHT-hand corner.
    _v.copy(this.frameAt(s - 2, _fr).tangent);
    const f = this.frameAt(s + 2, _fr);
    const turnsRight = f.tangent.dot(f.right) - _v.dot(f.right) > 0;
    return turnsRight ? bank : -bank;
  }

  /** How far below the road you have to be to count as fallen. */
  killPlaneAt(s) {
    return this.frameAt(s, _fr).position.y - (this.def.fallDepth ?? 8);
  }

  /** Is this lateral offset still on the road surface? */
  onRoad(t) {
    return Math.abs(t) <= this.width * 0.5 + 0.5;
  }

  spawnAt(s, lateral = 0) {
    const fr = this.frameAt(s, _fr);
    const position = fr.position
      .clone()
      .addScaledVector(fr.right, lateral)
      .addScaledVector(fr.up, 0.6);
    // Face along the tangent. -Z is forward, so build the basis that maps
    // -Z onto the tangent.
    const m = new THREE.Matrix4().makeBasis(
      fr.right.clone(),
      fr.up.clone(),
      fr.tangent.clone().negate()
    );
    return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(m) };
  }

  // -------------------------------------------------------------------
  // Level author API
  // -------------------------------------------------------------------

  /**
   * Add a static collider that belongs to a stretch of track. Returns an
   * id you can remove it with later — which is how Level 2's collapsing
   * deck drops out of the world on the same value the shader crumbles it.
   */
  registerCollider(s0, s1, colliderDesc, { position, quaternion, mesh } = {}) {
    const bodyDesc = this.RAPIER.RigidBodyDesc.fixed();
    if (position) bodyDesc.setTranslation(position.x, position.y, position.z);
    if (quaternion)
      bodyDesc.setRotation({
        x: quaternion.x,
        y: quaternion.y,
        z: quaternion.z,
        w: quaternion.w,
      });
    const body = this.world.createRigidBody(bodyDesc);
    const collider = this.world.createCollider(colliderDesc, body);

    if (mesh) {
      this.scene.add(mesh);
      this.objects.push(mesh);
    }
    const id = this.#nextId++;
    this.colliders.set(id, { collider, body, mesh, s0, s1 });
    this.bodies.push(body);
    return id;
  }

  removeCollider(id) {
    const rec = this.colliders.get(id);
    if (!rec) return false;
    this.world.removeRigidBody(rec.body); // removes its colliders too
    if (rec.mesh) {
      this.scene.remove(rec.mesh);
      rec.mesh.geometry?.dispose();
    }
    this.colliders.delete(id);
    return true;
  }

  /**
   * A force applied to any car within an s range. Level 2's crosswind is
   * one of these; so is anything else that pushes the player around
   * without being a solid object.
   *
   * fn(ctx) -> THREE.Vector3 of world force. ctx = { s, t, time, vehicle }
   */
  addForceField(s0, s1, fn) {
    const id = this.#nextId++;
    this.forceFields.set(id, { s0, s1, fn });
    return id;
  }

  removeForceField(id) {
    return this.forceFields.delete(id);
  }

  /** Sum the active fields at s. Called once per vehicle per step. */
  forceAt(s, ctx, out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    for (const f of this.forceFields.values()) {
      if (s < f.s0 || s > f.s1) continue;
      const v = f.fn(ctx);
      if (v) out.add(v);
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------

  #buildCheckpoints(spacing) {
    this.checkpoints = [];
    const n = Math.max(2, Math.round(this.length / spacing));
    for (let i = 0; i < n; i++) {
      const s = (i / n) * this.length;
      const fr = this.frameAt(s, {});
      this.checkpoints.push({
        index: i,
        s,
        position: fr.position.clone(),
        tangent: fr.tangent.clone(),
      });
    }
  }

  /** Index of the last checkpoint at or before s. */
  checkpointIndexAt(s) {
    const n = this.checkpoints.length;
    return Math.min(n - 1, Math.floor((this.spline.wrapS(s) / this.length) * n));
  }

  // -------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------

  /**
   * A drivable surface supplied by a modelled map: world-space vertices
   * and indices lifted straight from the mesh that is drawn, so — as with
   * the generated ribbons — the collider IS the visible surface. Visual
   * only lives with the level; this adds the physics and marks it ground.
   */
  #buildSurfaceCollider({ positions, indices, friction = 1.0 }) {
    const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed());
    const col = this.world.createCollider(
      this.RAPIER.ColliderDesc.trimesh(positions, indices).setFriction(friction),
      body
    );
    this.surfaceHandles.add(col.handle);
    this.bodies.push(body);
  }

  #buildRibbon({ width, lift, color, friction, name, uvScale, keepRef = false }) {
    const sp = this.spline;
    const n = sp.pos.length;
    const closed = sp.closed;
    const half = width * 0.5;
    const rings = closed ? n + 1 : n; // repeat the first ring to close the seam

    const verts = new Float32Array(rings * 2 * 3);
    const uvs = new Float32Array(rings * 2 * 2);
    const idx = [];

    for (let i = 0; i < rings; i++) {
      const k = i % n;
      const p = sp.pos[k];
      const r = sp.right[k];
      const u = sp.up[k];
        for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? -1 : 1;
        const o = (i * 2 + side) * 3;
        verts[o] = p.x + r.x * half * sgn + u.x * lift;
        verts[o + 1] = p.y + r.y * half * sgn + u.y * lift;
        verts[o + 2] = p.z + r.z * half * sgn + u.z * lift;
        const uo = (i * 2 + side) * 2;
        uvs[uo] = side;
        uvs[uo + 1] = (i * sp.step) / uvScale;
      }
    }

    for (let i = 0; i < rings - 1; i++) {
      const a = i * 2,
        b = i * 2 + 1,
        c = (i + 1) * 2,
        d = (i + 1) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geo,
      // DoubleSide deliberately. Triangle winding depends on which way
      // round the level author drew the spline, and reversing the loop
      // silently flipped every ribbon to face downwards — the road
      // vanished and you drove on the scenery showing through from
      // underneath. A flat surface should not care about handedness.
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.95,
        metalness: 0.0,
        side: THREE.DoubleSide,
      })
    );
    mesh.name = name;
    mesh.layers.enable(MAP_WORLD_LAYER); // also drawn on the minimap
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.objects.push(mesh);
    if (keepRef) this.roadMesh = mesh;

    // Same vertices, same indices — the collider IS the visible surface.
    const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed());
    const col = this.world.createCollider(
      this.RAPIER.ColliderDesc.trimesh(verts, new Uint32Array(idx)).setFriction(friction),
      body
    );
    this.surfaceHandles.add(col.handle);
    this.bodies.push(body);
  }

  /**
   * A narrow strip down each edge of the road, striped red and white.
   *
   * Visual only — no collider. A kerb you can feel would change the
   * handling that was tuned without it, and the point here is to give the
   * eye a reference for where the road ends and how fast it is going by.
   * A flat grey ribbon reads as a 2D plane however good the lighting is;
   * a repeating stripe along the edge is what makes it read as a surface
   * receding into the distance.
   */
  #buildKerbs() {
    const sp = this.spline;
    const n = sp.pos.length;
    const rings = sp.closed ? n + 1 : n;
    const inner = this.width * 0.5 - 0.15;
    const outer = this.width * 0.5 + 0.75;

    for (const side of [-1, 1]) {
      const verts = new Float32Array(rings * 2 * 3);
      const cols = new Float32Array(rings * 2 * 3);
      const idx = [];
      for (let i = 0; i < rings; i++) {
        const k = i % n;
        const p = sp.pos[k];
        const r = sp.right[k];
        const u = sp.up[k];
        // Stripe period in METRES, so it stays even however the samples
        // happen to be spaced around the lap.
        const red = Math.floor((i * sp.step) / 3.2) % 2 === 0;
        const cr = red ? 0.78 : 0.9;
        const cg = red ? 0.16 : 0.9;
        const cb = red ? 0.14 : 0.9;
        for (let e = 0; e < 2; e++) {
          const lat = (e === 0 ? inner : outer) * side;
          const o = (i * 2 + e) * 3;
          verts[o] = p.x + r.x * lat + u.x * 0.035;
          verts[o + 1] = p.y + r.y * lat + u.y * 0.035;
          verts[o + 2] = p.z + r.z * lat + u.z * 0.035;
          cols[o] = cr;
          cols[o + 1] = cg;
          cols[o + 2] = cb;
        }
      }
      for (let i = 0; i < rings - 1; i++) {
        const a = i * 2, b2 = i * 2 + 1, c = (i + 1) * 2, dd = (i + 1) * 2 + 1;
        if (side < 0) idx.push(a, c, b2, b2, c, dd);
        else idx.push(a, b2, c, b2, dd, c);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.7,
          side: THREE.DoubleSide,
        })
      );
      mesh.name = `Kerb${side < 0 ? "L" : "R"}`;
      mesh.layers.enable(MAP_WORLD_LAYER); // also drawn on the minimap
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.objects.push(mesh);
    }
  }

  /** Painted lines: solid at the edges, dashed down the middle. */
  #buildMarkings() {
    const sp = this.spline;
    const n = sp.pos.length;
    const rings = sp.closed ? n + 1 : n;
    const white = new THREE.MeshStandardMaterial({
      color: 0xdfe6e8,
      roughness: 0.55,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });

    const strip = (lateral, halfWidth, dashed) => {
      const verts = [];
      const idx = [];
      let v = 0;
      for (let i = 0; i < rings - 1; i++) {
        if (dashed && Math.floor((i * sp.step) / 4) % 2 === 1) continue;
        for (const j of [i, i + 1]) {
          const k = j % n;
          const p = sp.pos[k], r = sp.right[k], u = sp.up[k];
          for (const e of [-1, 1]) {
            const lat = lateral + e * halfWidth;
            verts.push(
              p.x + r.x * lat + u.x * 0.045,
              p.y + r.y * lat + u.y * 0.045,
              p.z + r.z * lat + u.z * 0.045
            );
          }
        }
        idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
        v += 4;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, white);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.objects.push(mesh);
    };

    strip(0, 0.09, true); // centre line, dashed
    strip(-this.width * 0.5 + 0.45, 0.07, false);
    strip(this.width * 0.5 - 0.45, 0.07, false);
  }

  /**
   * One continuous wall per side, as a single trimesh — exactly how the
   * road surface is built.
   *
   * The first version tiled ~290 short box colliders along the curve.
   * Boxes are individually robust, but every junction between two panels
   * that are at an angle to each other leaves a corner protruding into
   * the car's path, and that is what a sliding car catches on. The
   * testbed's walls never did this because each is ONE box 660 m long
   * with no joins at all — the difference was never box-versus-trimesh,
   * it was seams-versus-none.
   *
   * A swept ribbon has no seams by construction, follows the curve
   * exactly, and costs one collider per side instead of 145.
   */
  #buildBarriers() {
    const sp = this.spline;
    const n = sp.pos.length;
    const rings = sp.closed ? n + 1 : n;
    const half = this.wallLimit;
    const h = this.def.barrierHeight ?? 2.4;

    for (const side of [-1, 1]) {
      const verts = new Float32Array(rings * 2 * 3);
      const idx = [];

      for (let i = 0; i < rings; i++) {
        const k = i % n;
        const p = sp.pos[k];
        const r = sp.right[k];
        const u = sp.up[k];
        for (let e = 0; e < 2; e++) {
          const lift = e === 0 ? -0.2 : h; // sunk slightly, so no gap at the road
          const o = (i * 2 + e) * 3;
          verts[o] = p.x + r.x * half * side + u.x * lift;
          verts[o + 1] = p.y + r.y * half * side + u.y * lift;
          verts[o + 2] = p.z + r.z * half * side + u.z * lift;
        }
      }
      for (let i = 0; i < rings - 1; i++) {
        const a = i * 2, b2 = i * 2 + 1, c = (i + 1) * 2, d2 = (i + 1) * 2 + 1;
        idx.push(a, c, b2, b2, c, d2);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: this.def.barrierColor ?? 0x9aa7ae,
          roughness: 0.8,
          side: THREE.DoubleSide,
        })
      );
      mesh.name = `Barrier${side < 0 ? "L" : "R"}`;
      mesh.layers.enable(MAP_WORLD_LAYER); // also drawn on the minimap
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.objects.push(mesh);

      // Same vertices, same indices: the collider IS the visible wall.
      const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed());
      this.world.createCollider(
        this.RAPIER.ColliderDesc.trimesh(verts, new Uint32Array(idx))
          .setFriction(0.05) // slippery: a graze should slide, not catch
          .setRestitution(0.0),
        body
      );
      this.bodies.push(body);

      // A bright rail capping the wall, visual only.
      const rv = new Float32Array(rings * 2 * 3);
      const ridx = [];
      for (let i = 0; i < rings; i++) {
        const k = i % n;
        const p = sp.pos[k], r = sp.right[k], u = sp.up[k];
        for (let e = 0; e < 2; e++) {
          const lat = half + (e === 0 ? -0.32 : 0.32) * side;
          const o = (i * 2 + e) * 3;
          rv[o] = p.x + r.x * lat * side + u.x * (h + 0.06);
          rv[o + 1] = p.y + r.y * lat * side + u.y * (h + 0.06);
          rv[o + 2] = p.z + r.z * lat * side + u.z * (h + 0.06);
        }
      }
      for (let i = 0; i < rings - 1; i++) {
        const a = i * 2, b2 = i * 2 + 1, c = (i + 1) * 2, d2 = (i + 1) * 2 + 1;
        ridx.push(a, c, b2, b2, c, d2);
      }
      const rgeo = new THREE.BufferGeometry();
      rgeo.setAttribute("position", new THREE.BufferAttribute(rv, 3));
      rgeo.setIndex(ridx);
      rgeo.computeVertexNormals();
      const rail = new THREE.Mesh(
        rgeo,
        new THREE.MeshStandardMaterial({
          color: this.def.railColor ?? 0xe25a3a,
          roughness: 0.55,
          side: THREE.DoubleSide,
        })
      );
      rail.name = `Rail${side < 0 ? "L" : "R"}`;
      this.scene.add(rail);
      this.objects.push(rail);
    }
  }

  // -------------------------------------------------------------------
  dispose() {
    for (const o of this.objects) {
      this.scene.remove(o);
      o.geometry?.dispose();
      if (o.material) {
        Array.isArray(o.material)
          ? o.material.forEach((m) => m.dispose())
          : o.material.dispose();
      }
    }
    for (const b of this.bodies) this.world.removeRigidBody(b);
    this.objects.length = 0;
    this.bodies.length = 0;
    this.colliders.clear();
    this.forceFields.clear();
  }
}
