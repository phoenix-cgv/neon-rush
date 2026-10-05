import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Track } from "../track/track.js";
import { MAP_WORLD_LAYER } from "../ui/minimap.js";

// ---------------------------------------------------------------------
// Modelled maps: a Blender-authored .glb becomes a Track.
//
// The generated levels sweep everything from a spline. A modelled map
// runs the other way round: the road already exists as a mesh, so the
// centreline is RECOVERED from it and handed to Track, which then gives
// the map everything that hangs off s — laps, checkpoints, respawn, the
// AI's lookahead, pickups, the minimap. No level code needs to know the
// map came from a file.
//
// What the .glb must provide (both official maps do):
//
//   A mesh named "Road" that is a single closed ribbon, vertices in
//   left/right pairs along the lap (0,1 | 2,3 | ...). The midpoint of each
//   pair is the centreline; the pair's spacing is the road width. The
//   first pair is the start line and the pair order is the direction of
//   travel.
//
// Three things done at load time, each for a reason:
//
//   Merged by material. The exported maps are one node per object —
//   3339 in the city, 4124 at the Grand Prix — which is one draw call
//   each. Baking world transforms and merging per material takes that
//   to a few dozen with no visual change (see README §8, "Authoring
//   granularity is not drawing granularity").
//
//   Soft walls, not barrier geometry. The city has 4 m and 7 m hairpins
//   against a 14 m road: a barrier ribbon swept round those crumples on
//   the inside into exactly the invisible collision sheet the Track warns
//   about. The soft wall is a constraint on lateral offset, so a tight
//   corner cannot break it.
//
//   Solids are named, not guessed. Only trackside objects the level lists
//   (pit wall, tyre walls, gantry legs) become colliders, as oriented
//   boxes from their own bounds. A grass blade is not a wall.
// ---------------------------------------------------------------------

const loader = new GLTFLoader();
const cache = new Map(); // url -> Promise<gltf>
const prepared = new WeakMap(); // gltf -> merged meshes + track data

/** Fetch and parse once; every later visit to the level reuses it. */
export function loadMap(url) {
  if (!cache.has(url)) {
    const p = loader.loadAsync(url).catch((err) => {
      cache.delete(url); // let a retry actually retry
      throw err;
    });
    cache.set(url, p);
  }
  return cache.get(url);
}

// The name GLTFLoader gave a node, for a mesh that may be a primitive of
// a multi-material node (then the node is its parent group).
function nodeNameOf(mesh, root) {
  const p = mesh.parent;
  if (p && p !== root && p.isGroup && p.children.every((c) => c.isMesh) && p.name) {
    return p.name;
  }
  return mesh.name;
}

/**
 * Pull the centreline out of the road ribbon: midpoint of each vertex
 * pair, resampled to even arc length, then lightly smoothed.
 *
 * Resampled because exports can be wildly uneven — 0.26 m between
 * samples in the city's hairpins, 42 m down the straights of the first
 * Grand Prix export — and the spline's centripetal fit is only as good as
 * its input spacing. Smoothed because a modelled ribbon can have small
 * kinks that are invisible on the asphalt but read as a spike in
 * curvature, and the AI brakes on curvature. (The Grand Prix and Mountain
 * ribbons are now generated evenly every 2 m and 1.84 m; see blender/.)
 *
 * Two ribbon layouts occur. Smooth-shaded exports store each ring as a
 * left/right pair (0,1 | 2,3 ...). Flat-shaded ones duplicate every
 * vertex for its split normals, so a ring is left, left, right, right
 * (0,2 | 4,6 ...). The duplicate is detected rather than configured.
 *
 * Banking comes out too: the angle the left-to-right edge makes with the
 * horizontal. The Mountain Track leans its road up to 33 degrees, and a
 * Track that thought the road was flat would spawn cars level above a
 * sloping surface and measure lateral offset through the air.
 */
function centrelineFromRibbon(pos, { spacing = 6, passes = 3 } = {}) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  a.fromBufferAttribute(pos, 0);
  b.fromBufferAttribute(pos, 1);
  const stride = a.distanceTo(b) < 1e-5 ? 4 : 2;
  const right = stride / 2;

  const rings = Math.floor(pos.count / stride);
  const mids = [];
  const edges = []; // left -> right, per ring
  const widths = [];
  for (let i = 0; i < rings; i++) {
    a.fromBufferAttribute(pos, i * stride);
    b.fromBufferAttribute(pos, i * stride + right);
    const m = a.clone().add(b).multiplyScalar(0.5);
    if (mids.length && m.distanceTo(mids[mids.length - 1]) < 0.05) continue;
    mids.push(m);
    edges.push(b.clone().sub(a));
    widths.push(a.distanceTo(b));
  }
  if (mids.length > 2 && mids[0].distanceTo(mids[mids.length - 1]) < 0.05) {
    mids.pop();
    edges.pop();
  }
  const n = mids.length;

  // Bank in TrackSpline's convention: a rotation of the frame about the
  // tangent, where positive tips the spline's right side DOWN. The
  // spline's right is tangent x up, which may be either end of the pair.
  const up = new THREE.Vector3(0, 1, 0);
  const tan = new THREE.Vector3();
  const rightH = new THREE.Vector3();
  const banks = mids.map((m, i) => {
    tan.subVectors(mids[(i + 1) % n], m);
    rightH.crossVectors(tan, up).normalize();
    const e = edges[i].clone().normalize();
    if (e.dot(rightH) < 0) e.negate();
    return -Math.asin(THREE.MathUtils.clamp(e.y, -1, 1));
  });

  // Closed-loop arc length, including the segment back to the start.
  const cum = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + mids[i - 1].distanceTo(mids[i % n]));
  const L = cum[n];
  const count = Math.max(24, Math.round(L / spacing));
  let pts = [];
  let bank = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const s = (k / count) * L;
    while (cum[j + 1] < s) j++;
    const u = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
    pts.push(mids[j].clone().lerp(mids[(j + 1) % n], u));
    bank.push(banks[j] + (banks[(j + 1) % n] - banks[j]) * u);
  }
  for (let p = 0; p < passes; p++) {
    pts = pts.map((q, i) =>
      q
        .clone()
        .multiplyScalar(2)
        .add(pts[(i - 1 + count) % count])
        .add(pts[(i + 1) % count])
        .multiplyScalar(0.25)
    );
    bank = bank.map((q, i) => (2 * q + bank[(i - 1 + count) % count] + bank[(i + 1) % count]) / 4);
  }
  // Pin s = 0 to the modelled start line rather than to wherever the
  // smoothing nudged the first sample.
  pts[0].copy(mids[0]);

  // A flat map gets no banking at all, so its frames are exactly what a
  // generated track would build.
  const banked = bank.some((x) => Math.abs(x) > 0.01);
  const banking = banked
    ? (u) => {
        const f = (((u % 1) + 1) % 1) * count;
        const i0 = Math.floor(f) % count;
        return bank[i0] + (bank[(i0 + 1) % count] - bank[i0]) * (f - Math.floor(f));
      }
    : null;

  widths.sort((x, y) => x - y);
  return { points: pts, width: widths[widths.length >> 1], banking };
}

/**
 * The pit road, from its ribbon (left/right pairs in the direction of
 * travel, like the road's) and the named markers beside it: the garage
 * boxes and the speed-limit lines. Returns world-space edges, and the
 * centre of each marker's bounds, in the order found.
 */
function pitFromMap(root, opts) {
  const mesh = root.getObjectByName(opts.ribbon ?? "PitLane");
  if (!mesh?.isMesh) return null;
  const pos = mesh.geometry.attributes.position.clone().applyMatrix4(mesh.matrixWorld);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  a.fromBufferAttribute(pos, 0);
  b.fromBufferAttribute(pos, 1);
  const stride = a.distanceTo(b) < 1e-5 ? 4 : 2;
  const left = [];
  const right = [];
  for (let i = 0; i + stride / 2 < pos.count; i += stride) {
    left.push(new THREE.Vector3().fromBufferAttribute(pos, i));
    right.push(new THREE.Vector3().fromBufferAttribute(pos, i + stride / 2));
  }
  const markers = (re) => {
    const out = [];
    if (!re) return out;
    root.traverse((o) => {
      if (o === root || !re.test(o.name) || (o.parent && o.parent !== root && re.test(o.parent.name))) return;
      const box = new THREE.Box3().setFromObject(o);
      if (!box.isEmpty()) out.push(box.getCenter(new THREE.Vector3()));
    });
    return out;
  };
  return { left, right, boxes: markers(opts.boxes), limits: markers(opts.limits) };
}

/** World-space position + index arrays of a mesh, for a trimesh collider. */
function worldTriangles(mesh, lift = 0, flatY = null) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = v.x;
    out[i * 3 + 1] = flatY ?? v.y + lift;
    out[i * 3 + 2] = v.z;
  }
  const idx = g.index
    ? new Uint32Array(g.index.array)
    : Uint32Array.from({ length: pos.count }, (_, i) => i);
  return { positions: out, indices: idx };
}

/**
 * Drop triangles from a `walls` collider mesh that sit well inside
 * where the real barrier stands (`wallLimit`), keeping the ones at or
 * beyond it. A real continuous barrier's own geometry never needs to
 * reach that far in — only a modelling defect would (the Mountain's
 * Guardrail_Left has exactly this: a stretch of backface-culled,
 * invisible-from-the-road geometry folded in toward the centreline for
 * about 150m near its last checkpoint, found by probing the live
 * collider — see the project history for how). The visual mesh is a
 * separate draw call built from the SAME node's untouched geometry, so
 * this only ever removes collision, never anything drawn.
 */
function cullStrayWallTriangles(w, track, wallLimit) {
  const { positions, indices } = w;
  const safe = wallLimit * 0.6;
  const keep = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i], ib = indices[i + 1], ic = indices[i + 2];
    a.fromArray(positions, ia * 3);
    b.fromArray(positions, ib * 3);
    c.fromArray(positions, ic * 3);
    const centroid = a.add(b).add(c).multiplyScalar(1 / 3);
    const pr = track.project(centroid, null);
    if (Math.abs(pr.t) >= safe) keep.push(ia, ib, ic);
  }
  if (keep.length === indices.length) return w; // nothing to cull
  return { positions, indices: Uint32Array.from(keep) };
}

/**
 * World-space vertices under a node, for a solid's box to be fitted
 * from later — once a track exists to fit it against (see
 * `fitSolidBox`). A node's own (world) rotation is not a safe basis
 * for that box: these barrier blocks are exported with their vertices
 * baked straight into world space and an identity node transform, so a
 * banked block (the Grand Prix's final corner is a banked R30 — exactly
 * where this showed up) has its tilt baked into the vertices
 * themselves, not into any transform `solidBox` could have read. An
 * axis-aligned box around tilted vertices is a diagonal box, bulging
 * well past the block's real footprint — on a banked corner, into the
 * road.
 */
function solidVertices(node) {
  const out = [];
  const v = new THREE.Vector3();
  node.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  return out.length ? out : null;
}

/**
 * Fit a solid's box to the track's own local frame (right/up/tangent)
 * at its position, rather than to world axes — the frame is already
 * correctly banked, so a block that follows the bank (as these do) gets
 * a tight box instead of a world-axis-aligned one ballooned by the
 * tilt. See `solidVertices` for why the world axes cannot be trusted.
 */
function fitSolidBox(positions, track) {
  const n = positions.length / 3;
  const v = new THREE.Vector3();
  const naiveCentre = new THREE.Vector3();
  for (let i = 0; i < n; i++) naiveCentre.add(v.fromArray(positions, i * 3));
  naiveCentre.divideScalar(n);

  const fr = {};
  track.frameAt(track.project(naiveCentre, null).s, fr);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const rel = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    rel.fromArray(positions, i * 3).sub(fr.position);
    const x = rel.dot(fr.right), y = rel.dot(fr.up), z = rel.dot(fr.tangent);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2, midZ = (minZ + maxZ) / 2;
  const position = fr.position.clone()
    .addScaledVector(fr.right, midX)
    .addScaledVector(fr.up, midY)
    .addScaledVector(fr.tangent, midZ);
  const basis = new THREE.Matrix4().makeBasis(fr.right, fr.up, fr.tangent);
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis);
  const half = new THREE.Vector3(
    Math.max(0.05, (maxX - minX) / 2),
    Math.max(0.05, (maxY - minY) / 2),
    Math.max(0.05, (maxZ - minZ) / 2)
  );
  return { position, quaternion, half };
}

/**
 * Turn a loaded glTF into draw-ready merged meshes plus the data a Track
 * needs. Done once per map and cached on the gltf, because it is the
 * expensive part and the result never changes.
 */
function prepare(gltf, opts) {
  if (prepared.has(gltf)) return prepared.get(gltf);

  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const road = root.getObjectByName(opts.roadName ?? "Road");
  if (!road?.isMesh) throw new Error(`[glb-map] no "${opts.roadName ?? "Road"}" mesh in map`);
  const { points, width, banking } = centrelineFromRibbon(
    road.geometry.attributes.position.clone().applyMatrix4(road.matrixWorld),
    opts.centreline
  );

  const surfaces = [];
  const kept = []; // meshes the level drives itself (opts.keep), unmerged
  const walls = [];
  const solids = [];
  const buckets = new Map(); // key -> { material, geos[], onMap, cast, layer }

  // Outermost match only: a multi-material node's primitives can carry
  // the same name stem, and one object must not become two boxes.
  const findSolids = (o) => {
    if (o !== root && opts.solid?.test(o.name)) {
      const v = solidVertices(o);
      if (v) solids.push(v);
      return;
    }
    for (const c of o.children) findSolids(c);
  };
  findSolids(root);

  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = nodeNameOf(o, root);
    if (opts.exclude?.test(name)) return; // left out of the game entirely

    // Kept whole, with a material of its own, so the level can change it
    // at runtime (the Grand Prix lights its start lamps one at a time).
    if (opts.keep?.test(name)) {
      const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      const mesh = new THREE.Mesh(geo, o.material.clone());
      mesh.name = name;
      mesh.castShadow = true;
      kept.push(mesh);
      return;
    }

    const surface = opts.surfaces.find((sf) => sf.match.test(name));
    if (surface) {
      surfaces.push({
        ...worldTriangles(o, surface.lift, surface.flatY),
        friction: surface.friction ?? 1.0,
        grip: surface.grip ?? 1,
        rolling: surface.rolling ?? 0,
      });
    }
    // Continuous barriers (the Mountain Track's guardrails) collide as the
    // mesh itself, like the generated barriers do: a row of boxes along a
    // curve leaves a protruding corner at every join for a car to catch.
    if (opts.walls?.test(name)) walls.push(worldTriangles(o));

    // Decals sit a centimetre or less above the road (the city's lane
    // lines are exactly coplanar with it), which z-fights from any
    // distance. Pull them towards the camera in depth instead of lifting
    // geometry that is also a collider.
    const layer = opts.decals?.test(name) ? 2 : opts.overlays?.test(name) ? 1 : 0;
    const onMap = opts.minimap?.test(name) ?? false;
    const flat = layer > 0 || !!surface;
    const key = `${o.material.uuid}|${layer}|${onMap}|${flat}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material: o.material, geos: [], layer, onMap, flat };
      buckets.set(key, bucket);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", o.geometry.attributes.position.clone());
    if (o.geometry.attributes.normal) g.setAttribute("normal", o.geometry.attributes.normal.clone());
    else g.computeVertexNormals();
    g.setIndex(
      o.geometry.index
        ? o.geometry.index.clone()
        : Array.from({ length: g.attributes.position.count }, (_, i) => i)
    );
    g.applyMatrix4(o.matrixWorld);
    bucket.geos.push(g);
  });

  const group = new THREE.Group();
  group.name = opts.name ?? "Map";
  for (const b of buckets.values()) {
    const geo = mergeGeometries(b.geos, false);
    for (const g of b.geos) g.dispose();
    if (!geo) continue;
    let mat = b.material;
    // Blender procedural materials export with no colour at all, which
    // glTF reads as white; the level supplies what they should be.
    const recolour = opts.materialColors?.[mat.name || "default"];
    if (recolour) {
      mat = mat.clone();
      mat.color.setRGB(...recolour); // linear, like baseColorFactor
      // glTF's default material is fully metallic, which with no
      // environment map renders near-black whatever its colour.
      if (!mat.name) mat.metalness = 0;
    }
    if (b.layer > 0) {
      mat = mat.clone();
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -b.layer;
      mat.polygonOffsetUnits = -b.layer * 2;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `${group.name}:${mat.name || "default"}`;
    mesh.receiveShadow = true;
    mesh.castShadow = !b.flat; // flat ground shadows nothing but the shadow pass
    if (b.onMap) mesh.layers.enable(MAP_WORLD_LAYER);
    group.add(mesh);
  }

  kept.sort((a, b) => a.name.localeCompare(b.name));
  for (const m of kept) group.add(m);

  const pit = opts.pit ? pitFromMap(root, opts.pit) : null;
  const map = { group, points, width, banking, surfaces, walls, solids, kept, pit };
  prepared.set(gltf, map);
  return map;
}

/**
 * Build a Track from a loaded map.
 *
 * @param {object} gltf       from loadMap()
 * @param {object} opts
 *   surfaces   [{ match: RegExp, friction, lift, flatY, grip, rolling }]
 *              meshes that are drivable ground; lift raises the collider
 *              (not the mesh), in metres; flatY collides as a flat sheet at
 *              that height; grip (x tyre grip, default 1) and rolling
 *              (extra rolling resistance, default 0) make grass and gravel
 *              cost the driver who runs onto them
 *   roadName   the road ribbon mesh (default "Road")
 *   solid      RegExp of node names that become box colliders
 *   walls      RegExp of meshes that collide as themselves (barriers)
 *   exclude    RegExp of meshes left out entirely (not drawn, not solid)
 *   keep       RegExp of meshes kept whole (own material) and returned as
 *              `kept`, for the level to animate
 *   decals     RegExp of paint/lines lying on the road (depth-offset x2)
 *   overlays   RegExp of surfaces lying on the ground (depth-offset x1)
 *   minimap    RegExp of meshes drawn on the minimap
 *   materialColors  { materialName: [r, g, b] } linear colour overrides;
 *              "default" is the material glTF gives an unassigned mesh
 *   wallLimit  lateral offset of the soft wall (or of the barrier), m
 *   softWalls  false when `walls` are the boundary; default true
 *   centreline { spacing, passes } resampling and smoothing, see above
 *   track      extra Track def fields (checkpointSpacing, fallDepth, ...)
 *   pit        { ribbon, boxes: RegExp, limits: RegExp } — a pit road,
 *              returned as `pit` for a PitLane (see src/track/pit-lane.js)
 * @returns {{ track: Track, group: THREE.Group, dispose: () => void }}
 */
export function buildMapTrack(RAPIER, world, scene, gltf, opts) {
  const map = prepare(gltf, opts);

  const track = new Track(RAPIER, world, scene, {
    points: map.points,
    closed: true,
    width: opts.width ?? map.width,
    spacing: 2,
    banking: map.banking,
    surfaces: map.surfaces,
    // Soft walls unless the map brings real barriers (opts.walls) and
    // says so: then it behaves like a generated track, and wallLimit is
    // where the barrier stands.
    softWalls: opts.softWalls ?? true,
    wallLimit: opts.wallLimit,
    // Progress calls anything past this "beyond the runoff" and resets it
    // quickly. It must sit outside the soft wall, or the wall would hold a
    // car exactly where Progress is counting it down.
    runoffHalfWidth: opts.wallLimit + 1.5,
    checkpointSpacing: 130,
    fallDepth: 9,
    ...opts.track,
  });

  for (const w of map.walls) {
    const { positions, indices } = opts.wallLimit != null
      ? cullStrayWallTriangles(w, track, opts.wallLimit)
      : w;
    track.registerCollider(
      0,
      track.length,
      RAPIER.ColliderDesc.trimesh(positions, indices)
        .setFriction(0.05) // slippery, as the generated barriers are
        .setRestitution(0.0)
    );
  }
  for (const vertices of map.solids) {
    const s = fitSolidBox(vertices, track);
    const pr = track.project(s.position);
    // Even track-frame-fitted (see fitSolidBox), a solid whose own
    // CENTRE still lands well inside wallLimit is not a real roadside
    // barrier — found on the Grand Prix, where a few PitWall/TyreWall
    // pieces right at the pit exit's merge don't run along the main
    // track's frame at all (that frame is what fitSolidBox has to
    // assume), so even the fit still lands them in the road. Dropped
    // rather than kept undersized: a short gap in a wall that stands
    // metres further out is harmless; the same piece left solid where
    // the merge actually drives is the invisible stop this is fixing.
    if (opts.wallLimit != null && Math.abs(pr.t) < opts.wallLimit * 0.5) continue;
    track.registerCollider(
      pr.s,
      pr.s,
      RAPIER.ColliderDesc.cuboid(s.half.x, s.half.y, s.half.z)
        .setFriction(0.05) // like the barriers: a graze should slide
        .setRestitution(0.0),
      { position: s.position, quaternion: s.quaternion }
    );
  }

  // The merged meshes are cached with the map and shared between visits,
  // so they must NOT go into track.objects — Track.dispose() would free
  // geometry the next visit still needs. The level removes the group.
  scene.add(map.group);
  return {
    track,
    group: map.group,
    kept: map.kept, // opts.keep meshes, sorted by name
    pit: map.pit, // opts.pit: the pit road's edges and markers, or null
    dispose: () => scene.remove(map.group),
  };
}
