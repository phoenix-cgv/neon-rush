import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CAR } from "./config.js";

// The scene graph for the car — section 4 of the design document.
//
// The hierarchy is doing real work, and each parenting choice has a reason
// you should be able to give out loud:
//
//   CarRig                 world position and heading; physics writes here
//   └── ChassisPivot       body shell, lights, spoiler
//       └── SteeringGroup  yaw from steer input
//           ├── WheelFL    inherits steer AND applies its own spin
//           └── WheelFR
//   └── WheelRL/RR         spin only, no steer
//   └── CameraBoom         child of CarRig, deliberately NOT of ChassisPivot,
//                          so the camera does not inherit suspension shake
//
// Breaking the chain one level early for the camera is a better answer in a
// demonstration than a deeper hierarchy would be: it shows the graph was
// designed rather than accepted.
//
// Nothing here touches CAR.halfExtents, which is the COLLIDER. The shell is
// built around it so the car can look like a car without changing a single
// number the physics depends on.

// White, so damage shows. Scratches are drawn as dark gouges and dents
// read by their shading — both are far more legible on a pale panel than
// on the original teal, where a crease just looked like another shadow.
const PAINT = 0xeef1f2;
const PAINT_DARK = 0x9aa4a8;
const TRIM = 0x0e1417;

// Panels are SUBDIVIDED, and that is a damage decision rather than a
// shading one. A dent is vertices pushed in around a contact point, so a
// 24-vertex box can only fold at its corners and creases like cardboard.
// Three segments a side gives 98 vertices to deform and reads as sheet
// metal. It costs triangles, which is the resource this car has most of:
// the whole body was 936 of them, and the render is bound by draw calls,
// which subdividing does not change at all.
const SEG = 3;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampAbs = (v, m) => (v > m ? m : v < -m ? -m : v);
// Deepest a single vertex may be pushed, in metres. The car is 1.7 m wide.
const DENT_MAX = 0.26;

// Body panels get more segments than trim does. Two reasons, and both are
// about damage: rounding needs vertices to round WITH, and a dent needs
// vertices to bend. It costs triangles, which is the resource this car has
// most of — the render is bound by draw calls, and subdividing changes
// those not at all.
const BODY_SEG = 6;

/**
 * Push a box's surface out onto a rounded profile.
 *
 * Every vertex is clamped into the inner box (the shape shrunk by the
 * corner radius) and then pushed back out to exactly `r` from that clamped
 * point. Flat faces stay flat, edges become quarter-cylinders and corners
 * become eighth-spheres — a real fillet rather than a chamfer.
 *
 * This is what makes damage legible. On a flat panel a dent barely changes
 * the shading, because the surface normal was constant and stays roughly
 * constant. On a curved one it breaks the highlight running along the
 * flank, which the eye picks up immediately.
 */
function roundProfile(g, w, h, d, r) {
  const p = g.attributes.position;
  const hw = Math.max(0, w / 2 - r);
  const hh = Math.max(0, h / 2 - r);
  const hd = Math.max(0, d / 2 - r);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const cx = clampAbs(x, hw);
    const cy = clampAbs(y, hh);
    const cz = clampAbs(z, hd);
    const dx = x - cx;
    const dy = y - cy;
    const dz = z - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) continue;
    const k = r / len;
    p.setXYZ(i, cx + dx * k, cy + dy * k, cz + dz * k);
  }
  g.computeVertexNormals();
}

function roundedBox(w, h, d, r, mat) {
  const g = new THREE.BoxGeometry(w, h, d, BODY_SEG, BODY_SEG, BODY_SEG);
  roundProfile(g, w, h, d, r);
  return new THREE.Mesh(g, mat);
}

/** Rounded AND tapered: the shape most of this car is made of. */
function roundedTaper(wFront, wBack, h, d, r, mat) {
  // Round in unit-width space first, then taper. Doing it the other way
  // round would fillet an already-wedge-shaped box and leave the corner
  // radius visibly different at the nose and the tail.
  const g = new THREE.BoxGeometry(1, h, d, BODY_SEG, BODY_SEG, BODY_SEG);
  roundProfile(g, 1, h, d, r);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = clamp01(p.getZ(i) / d + 0.5); // 0 at the nose (-Z), 1 at the tail
    p.setX(i, p.getX(i) * (wFront + (wBack - wFront) * t));
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

function box(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d, SEG, SEG, SEG), mat);
}


/**
 * Collapse a node's direct mesh children into one mesh per material.
 *
 * The car is modelled as 38 separate boxes and cylinders — which is the
 * right way to AUTHOR it, because every part is positioned by a readable
 * line of code rather than by a vertex list. It is the wrong way to DRAW
 * it: 38 meshes carrying 936 triangles between them is about 25 triangles
 * a draw call, and with six cars on track that was 228 of the scene's 253
 * meshes and over half the render pass. The cost is per-call overhead, not
 * geometry.
 *
 * So the parts are authored separately and merged once, at build time.
 * Grouping by material rather than merging everything into one keeps the
 * material objects that sync() mutates — brake lights and the boost glow
 * still work, because they are the same material instances.
 *
 * Only call this on a node whose mesh children never move relative to it:
 * merging bakes each part's local matrix into its vertices, so a merged
 * part can no longer be animated on its own.
 */
function mergeByMaterial(node) {
  const meshes = node.children.filter((c) => c.isMesh);
  if (meshes.length < 2) return;

  const byMat = new Map();
  for (const m of meshes) {
    m.updateMatrix();
    const geo = m.geometry.clone().applyMatrix4(m.matrix);
    geo.clearGroups(); // box faces carry groups that would fight the merge
    if (!byMat.has(m.material)) byMat.set(m.material, { geos: [], cast: false });
    const entry = byMat.get(m.material);
    entry.geos.push(geo);
    entry.cast = entry.cast || m.castShadow;
  }

  const built = [];
  for (const [mat, entry] of byMat) {
    const geo =
      entry.geos.length === 1 ? entry.geos[0] : mergeGeometries(entry.geos, false);
    // mergeGeometries returns null if the attribute sets disagree. Bailing
    // out with the original meshes intact is always better than a car that
    // renders as nothing.
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = entry.cast;
    built.push(mesh);
  }

  for (const m of meshes) node.remove(m);
  for (const m of built) node.add(m);
}

// Where damaged paint ends up: a dull, sooted grey-brown. Not black —
// see #applyDamage.
const SCORCH = new THREE.Color(0x3a3330);
// Headlight glass, lit and smashed.
const CLEAN_LAMP = new THREE.Color(0xfff4d6);
const DEAD_LAMP = new THREE.Color(0x2b2a27);

export class CarRig {
  /** @param {number} paint  body colour, so a field of cars is legible */
  constructor(paint = PAINT) {
    this.root = new THREE.Group();
    this.root.name = "CarRig";

    this.chassisPivot = new THREE.Group();
    this.chassisPivot.name = "ChassisPivot";
    this.root.add(this.chassisPivot);

    const h = CAR.halfExtents; // collider: 0.85 x 0.27 x 2.0

    const bodyMat = new THREE.MeshStandardMaterial({
      color: paint,
      metalness: 0.6,
      roughness: 0.32,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(paint).multiplyScalar(0.55),
      metalness: 0.5,
      roughness: 0.45,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: TRIM,
      metalness: 0.35,
      roughness: 0.7,
    });
    this.bodyMat = bodyMat;
    this.darkMat = darkMat;
    // The clean paint, kept so damage interpolates from it rather than
    // compounding: applying a darkening factor to the live colour every
    // frame would fade the car to black over a few seconds of contact.
    this.cleanPaint = new THREE.Color(paint);
    this.cleanDark = new THREE.Color(paint).multiplyScalar(0.55);
    this.cleanRoughness = bodyMat.roughness;
    this.cleanMetalness = bodyMat.metalness;
    this.shownDamage = -1; // force the first update
    this.lastImpactSeq = 0;
    // How deformed the shell currently IS, tracked separately from how
    // damaged the car is. The two are not the same number: damage can
    // drop to zero in a single frame (a respawn does exactly that) while
    // the geometry still has to be beaten back out.
    this.shownDent = 0; // fraction of the dent field currently drawn
    this.dentDirty = false;

    // --- lower shell ---------------------------------------------------
    const shell = roundedTaper(h.x * 1.72, h.x * 1.94, h.y * 1.9, h.z * 1.92, 0.17, bodyMat);
    shell.name = "BodyMesh";
    shell.castShadow = true;
    this.chassisPivot.add(shell);
    this.body = shell;

    // Side skirts, which read as sills and hide the gap over the wheels.
    for (const sx of [-1, 1]) {
      const skirt = box(0.1, 0.16, h.z * 1.5, trimMat);
      skirt.position.set(sx * h.x * 0.96, -h.y * 0.75, 0);
      skirt.castShadow = true;
      this.chassisPivot.add(skirt);
    }

    // --- cabin ---------------------------------------------------------
    const cabin = roundedTaper(h.x * 1.06, h.x * 1.46, 0.34, h.z * 0.92, 0.13, darkMat);
    cabin.position.set(0, h.y + 0.15, 0.12);
    cabin.castShadow = true;
    this.chassisPivot.add(cabin);

    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x9fd8e8,
      metalness: 0.1,
      roughness: 0.08,
      transparent: true,
      opacity: 0.55,
    });
    const glass = roundedTaper(h.x * 0.98, h.x * 1.34, 0.2, h.z * 0.62, 0.08, glassMat);
    glass.position.set(0, h.y + 0.24, -0.02);
    this.chassisPivot.add(glass);

    // --- nose and tail -------------------------------------------------
    const nose = roundedTaper(h.x * 1.3, h.x * 1.72, 0.2, 0.55, 0.09, bodyMat);
    nose.position.set(0, -h.y * 0.15, -h.z * 0.92);
    nose.castShadow = true;
    this.chassisPivot.add(nose);

    const splitter = box(h.x * 1.8, 0.06, 0.4, trimMat);
    splitter.position.set(0, -h.y * 0.95, -h.z * 1.05);
    this.chassisPivot.add(splitter);

    // Rear wing on two stays — the clearest silhouette cue that this is a
    // car and not a crate, and it reads instantly from the chase camera.
    const wing = box(h.x * 1.85, 0.07, 0.34, trimMat);
    wing.position.set(0, h.y + 0.42, h.z * 0.96);
    wing.castShadow = true;
    this.chassisPivot.add(wing);
    for (const sx of [-1, 1]) {
      const stay = box(0.07, 0.36, 0.1, trimMat);
      stay.position.set(sx * h.x * 0.7, h.y + 0.24, h.z * 0.96);
      this.chassisPivot.add(stay);
    }

    // --- lights --------------------------------------------------------
    // Emissive so they read at dusk and at night without needing a real
    // light source for each one — Level 3 has enough of those already.
    this.headMat = new THREE.MeshStandardMaterial({
      color: 0xfff4d6,
      emissive: 0xfff0c8,
      emissiveIntensity: 1.4,
      roughness: 0.3,
    });
    this.tailMat = new THREE.MeshStandardMaterial({
      color: 0x6b1414,
      emissive: 0xff2a1a,
      emissiveIntensity: 0.35,
      roughness: 0.4,
    });
    for (const sx of [-1, 1]) {
      const lamp = box(0.3, 0.12, 0.08, this.headMat);
      lamp.position.set(sx * h.x * 0.92, -h.y * 0.1, -h.z * 1.14);
      this.chassisPivot.add(lamp);

      const tail = box(0.34, 0.11, 0.07, this.tailMat);
      tail.position.set(sx * h.x * 0.98, h.y * 0.35, h.z * 1.0);
      this.chassisPivot.add(tail);
    }

    // Headlight spots are created ON DEMAND, not up front.
    //
    // They used to be built here at intensity 0, waiting for a night
    // level. three.js does not care that a light is dark: every light in
    // the scene is uniform data and a loop iteration in EVERY lit
    // material's fragment shader, whether it contributes anything or not.
    // Twelve of them across a six-car field cost 2.95 ms of a 12.4 ms
    // render pass — a quarter of the frame spent on lights that emitted
    // nothing. Built lazily, a daytime race pays nothing and a night
    // level still gets them by calling setHeadlights(true).
    //
    // They are children of the chassis, so they sweep the road as the car
    // turns and dip as the nose dives — no per-frame code.
    this.headlights = [];
    this.headlightGeom = { x: h.x * 0.9, z: h.z };

    // --- wheels --------------------------------------------------------
    this.steeringGroup = new THREE.Group();
    this.steeringGroup.name = "SteeringGroup";
    this.chassisPivot.add(this.steeringGroup);

    const r = CAR.wheelRadius;
    const tyreGeo = new THREE.CylinderGeometry(r, r, 0.3, 22);
    tyreGeo.rotateZ(Math.PI / 2); // cylinder axis -> X, the wheel's spin axis
    const tyreMat = new THREE.MeshStandardMaterial({
      color: 0x14181b,
      roughness: 0.92,
    });
    const rimGeo = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.32, 14);
    rimGeo.rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xc9d3d8,
      metalness: 0.85,
      roughness: 0.28,
    });
    // A spoke plate so the wheels visibly SPIN. A smooth cylinder gives no
    // rotational cue at all, and spinning wheels are most of what sells
    // speed from the chase camera.
    const spokeGeo = new THREE.BoxGeometry(0.34, r * 0.9, 0.07);

    this.wheelMeshes = CAR.wheels.map((wcfg, i) => {
      const wheel = new THREE.Group();
      const tyre = new THREE.Mesh(tyreGeo, tyreMat);
      tyre.castShadow = true;
      wheel.add(tyre);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      wheel.add(rim);
      for (let k = 0; k < 3; k++) {
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        spoke.rotation.x = (k / 3) * Math.PI;
        wheel.add(spoke);
      }
      wheel.name = `Wheel${i}`;

      // Front wheels hang off the steering group so they inherit steer AND
      // apply their own spin — two composed rotations, the textbook
      // hierarchical modelling case. Rear wheels only spin.
      const parent = wcfg.front ? this.steeringGroup : this.chassisPivot;
      const pivot = new THREE.Group();
      pivot.position.set(wcfg.x, wcfg.y, wcfg.z);
      pivot.add(wheel);
      parent.add(pivot);

      // Arch over each wheel, so the body does not look like it is floating.
      const arch = roundedBox(0.36, 0.12, r * 2.25, 0.055, bodyMat);
      arch.position.set(wcfg.x, CAR.mountY - 0.02, wcfg.z);
      arch.castShadow = true;
      this.chassisPivot.add(arch);

      return { mesh: wheel, pivot, front: wcfg.front };
    });

    this.cameraBoom = new THREE.Group();
    this.cameraBoom.name = "CameraBoom";
    this.root.add(this.cameraBoom);

    // Draw-call pass. Everything above stays readable; this makes it cheap.
    // The body is rigid to the chassis pivot, and each wheel's parts are
    // rigid to that wheel — those are exactly the nodes it is safe to
    // merge. The wheel GROUPS and the steering group are untouched, so
    // spin and steer still compose the way the hierarchy says they do.
    mergeByMaterial(this.chassisPivot);
    for (const w of this.wheelMeshes) mergeByMaterial(w.mesh);

    // The merge is what makes DENTS possible rather than what prevents
    // them: the whole body is now one geometry, so pushing vertices in
    // around an impact deforms the car as a single shell instead of
    // moving one box out of alignment with its neighbours.
    this.bodyMesh =
      this.chassisPivot.children.find((c) => c.isMesh && c.material === bodyMat) ??
      null;
    if (this.bodyMesh) {
      const pos = this.bodyMesh.geometry.attributes.position;
      this.pristine = new Float32Array(pos.array); // the undamaged shell
      // Accumulated deformation, held SEPARATELY from the live vertices.
      //
      // The drawn shape is always pristine + dentField x shown, so repair
      // converges on the original geometry by construction. Easing the
      // live vertices toward pristine instead does not: the step size and
      // the damage value decay at different rates, so the car stopped
      // straightening while still visibly creased — 0.064 m of dent left
      // after a full repair, which a respawn made permanent.
      this.dentField = new Float32Array(pos.array.length);
      this.bodyMesh.geometry.computeBoundingSphere();
    }
    this.#initScratches(paint);
  }

  /**
   * Read the vehicle state and pose the graph. No physics happens here, and
   * no transform maths happens outside it.
   */
  sync(state) {
    this.root.position.copy(state.position);
    this.root.quaternion.copy(state.quaternion);

    this.steeringGroup.rotation.y = -state.steerAngle;

    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const w = state.wheels[i];
      const { mesh, pivot } = this.wheelMeshes[i];
      const springLength = w.grounded
        ? CAR.suspensionRest - w.compressionM
        : CAR.suspensionRest;
      pivot.position.y = CAR.mountY - springLength;
      mesh.rotation.x = w.spinAngle;
    }

    // Brake lights brighten under braking, and the paint picks up a glow
    // while boosting. Both read from state the physics already publishes.
    const braking = state.gear === 1 && state.speed > 1 && state.wheels[0].load > 0;
    this.tailMat.emissiveIntensity = state.boosting ? 1.6 : braking ? 0.9 : 0.35;
    this.bodyMat.emissive.setHex(state.boosting ? 0x1a5f6b : 0x000000);
    this.bodyMat.emissiveIntensity = state.boosting ? 0.8 : 0;

    // A new impact scratches and dents ONCE, on the frame it happens.
    // Driving these off the damage value instead would redraw scratches
    // every frame the car is damaged and grind the canvas to a smear.
    const seq = state.impactSeq ?? 0;
    if (seq !== this.lastImpactSeq) {
      this.lastImpactSeq = seq;
      const f = state.impactForce ?? 0.5;
      this.#scratch(f);
      if (state.impactLocal) this.#dent(state.impactLocal, f);
    }

    const damage = state.damage ?? 0;
    // Repairing: pull the panels out and buff the scratches at the same
    // rate the damage value is healing, so the look and the number agree.
    // How much of the accumulated deformation is currently shown follows
    // the damage value, easing so a repair looks like panels being beaten
    // out rather than snapping straight. Because the shape is rebuilt from
    // pristine every time, damage reaching 0 restores the car exactly —
    // including when a respawn zeroes it in a single frame.
    const wantDent = Math.min(1, damage * 1.35);
    if (this.dentDirty || Math.abs(wantDent - this.shownDent) > 0.002) {
      this.shownDent += (wantDent - this.shownDent) * 0.12;
      if (this.dentDirty) this.shownDent = Math.max(this.shownDent, wantDent);
      if (Math.abs(wantDent - this.shownDent) < 0.004) this.shownDent = wantDent;
      this.#reshape(this.shownDent);
      this.dentDirty = false;
    }
    // Once the car is genuinely clean, forget the scars entirely.
    //
    // The dent field is kept across a repair so that damage rising again
    // re-creases the panels that were already bent. But a respawn zeroes
    // damage on a car that is meant to be fresh, and without this the
    // first light knock afterwards would instantly restore every dent it
    // ever had.
    if (damage < 0.01 && this.dentField) {
      let live = false;
      const f = this.dentField;
      for (let i = 0; i < f.length; i++) {
        if (f[i] === 0) continue;
        f[i] *= 0.94;
        if (Math.abs(f[i]) < 1e-4) f[i] = 0;
        else live = true;
      }
      if (live) this.dentDirty = true;
    }

    // Paint comes back last: buff the scratches only while actually healing.
    if (damage < this.shownDamage - 0.0005) {
      this.#polish(Math.min(0.06, (this.shownDamage - damage) * 0.5));
    }

    this.#applyDamage(damage);
  }

  /**
   * Show accumulated damage on the paint.
   *
   * Material-based rather than geometric, because the draw-call merge
   * bakes every body part into one geometry — a wing can no longer be
   * bent or dropped on its own. Scuffed, dulled paint carries the same
   * information and costs nothing per frame.
   *
   * Skipped unless the value actually moved: this runs for every car,
   * every frame, and Color.lerpColors on a pristine car is pure waste.
   */
  /**
   * A per-car canvas used as the body's colour map.
   *
   * It starts as flat paint and gets scratches DRAWN into it as the car
   * takes hits, so the marks are cumulative and every car ends up scarred
   * differently. three multiplies map by colour, so the same texture keeps
   * working when the paint darkens with damage.
   *
   * 256 square per car: small enough that six of them are nothing, big
   * enough that a scratch is a scratch and not a blur.
   */
  #initScratches() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; // white = unmodified paint
    ctx.fillRect(0, 0, 256, 256);
    this.scratchCanvas = c;
    this.scratchCtx = ctx;
    this.scratchTex = new THREE.CanvasTexture(c);
    this.scratchTex.anisotropy = 4;
    this.bodyMat.map = this.scratchTex;
    this.bodyMat.needsUpdate = true;
  }

  /** Draw a burst of scratches. Called once per impact, not per frame. */
  #scratch(force) {
    const ctx = this.scratchCtx;
    const n = 3 + Math.round(force * 7);
    for (let i = 0; i < n; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const len = 12 + Math.random() * 54 * (0.4 + force);
      const ang = (Math.random() - 0.5) * 0.9; // roughly along the airflow
      // Bare metal shows through as a light streak with a dark edge, which
      // reads as a gouge rather than as dirt.
      ctx.strokeStyle = `rgba(40,36,33,${0.35 + Math.random() * 0.4})`;
      ctx.lineWidth = 1 + Math.random() * 2.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      ctx.stroke();
      ctx.strokeStyle = `rgba(215,210,200,${0.25 + Math.random() * 0.35})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y + 1);
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len + 1);
      ctx.stroke();
    }
    this.scratchTex.needsUpdate = true;
  }

  /** Fade scratches back toward clean paint as the car repairs. */
  #polish(amount) {
    const ctx = this.scratchCtx;
    ctx.fillStyle = `rgba(255,255,255,${amount})`;
    ctx.fillRect(0, 0, 256, 256);
    this.scratchTex.needsUpdate = true;
  }

  /**
   * Push the shell in around an impact.
   *
   * `dir` is the contact normal in the car's own space, so the dent lands
   * on the panel that actually met the wall. Only vertices facing that way
   * move, weighted by how squarely they face it, so a side-on hit creases
   * the flank and a nose-on hit folds the nose.
   */
  #dent(dir, force) {
    if (!this.bodyMesh) return;
    const p = this.pristine;
    const f = this.dentField;
    const depth = 0.045 + force * 0.11;
    // A random centre on the struck side, so repeated hits do not all
    // deepen one crater.
    const cx = dir.x * 0.85 + (Math.random() - 0.5) * 0.5;
    const cy = dir.y * 0.3 + (Math.random() - 0.5) * 0.35;
    const cz = dir.z * 1.9 + (Math.random() - 0.5) * 1.6;
    const reach = 0.75 + force * 0.55;
    for (let i = 0; i < p.length; i += 3) {
      const dx = p[i] - cx;
      const dy = p[i + 1] - cy;
      const dz = p[i + 2] - cz;
      const d = Math.hypot(dx, dy, dz);
      if (d > reach) continue;
      const w = 1 - d / reach;
      const k = w * w * depth;
      // Capped, or twenty hits on one panel fold the car through itself.
      f[i] = clampAbs(f[i] - dir.x * k, DENT_MAX);
      f[i + 1] = clampAbs(f[i + 1] - dir.y * k, DENT_MAX);
      f[i + 2] = clampAbs(f[i + 2] - dir.z * k, DENT_MAX);
    }
    this.dentDirty = true;
  }

  /** Redraw the shell as pristine + accumulated dents, scaled by `shown`. */
  #reshape(shown) {
    const pos = this.bodyMesh.geometry.attributes.position;
    const a = pos.array;
    const p = this.pristine;
    const f = this.dentField;
    for (let i = 0; i < a.length; i++) a[i] = p[i] + f[i] * shown;
    pos.needsUpdate = true;
    this.bodyMesh.geometry.computeVertexNormals();
  }


  #applyDamage(damage) {
    if (Math.abs(damage - this.shownDamage) < 0.005) return;
    this.shownDamage = damage;
    const k = Math.min(damage, 1);

    // Toward scorched grey, never fully to it — a car that turns black
    // stops reading as YOUR car, and colour is how you find yourself in
    // a six-car pack.
    this.bodyMat.color.lerpColors(this.cleanPaint, SCORCH, k * 0.62);
    this.darkMat.color.lerpColors(this.cleanDark, SCORCH, k * 0.7);
    // Polish goes first, then the paint. Rough, flat panels read as
    // damaged long before the hue shift is obvious.
    this.bodyMat.roughness = this.cleanRoughness + (0.92 - this.cleanRoughness) * k;
    this.bodyMat.metalness = this.cleanMetalness * (1 - 0.75 * k);

    // Broken headlights. Dulled paint alone is easy to miss at chase-camera
    // distance — a lamp that has gone out is read instantly, and it is the
    // one cue that still works in a dark level. Held at full brightness
    // until a third of the way in, so light contact does not put them out.
    const lamps = 1 - Math.max(0, (k - 0.33) / 0.67);
    this.headMat.emissiveIntensity = 1.4 * lamps;
    this.headMat.color.lerpColors(CLEAN_LAMP, DEAD_LAMP, 1 - lamps);
  }

  setHeadlights(on) {
    if (on && this.headlights.length === 0) this.#buildHeadlights();
    for (const l of this.headlights) l.intensity = on ? 60 : 0;
    this.headMat.emissiveIntensity = on ? 2.2 : 1.0;
  }

  #buildHeadlights() {
    const { x, z } = this.headlightGeom;
    for (const sx of [-1, 1]) {
      const light = new THREE.SpotLight(0xfff0d0, 0, 70, Math.PI / 7, 0.45, 1.2);
      light.position.set(sx * x, 0, -z);
      light.target.position.set(sx * x, -0.6, -z - 14);
      this.chassisPivot.add(light, light.target);
      this.headlights.push(light);
    }
  }
}
