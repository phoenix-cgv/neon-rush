import * as THREE from "three";
import { CAR } from "./config.js";

// ---------------------------------------------------------------------
// Scratch objects.
//
// Zero allocations inside step(). Every Vector3 created in a 60 Hz loop is
// work handed to the garbage collector that arrives later as a visible
// stutter. All temporaries live here and are reused.
// ---------------------------------------------------------------------
const _mount = new THREE.Vector3();
const _down = new THREE.Vector3();
const _contact = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _r = new THREE.Vector3();
const _pointVel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _force = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _frame = {}; // scratch for track.frameAt
const _linvel = new THREE.Vector3();
const _angvel = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _quat2 = new THREE.Quaternion(); // scratch for world -> car space
const _up = new THREE.Vector3();

const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Collision layers. `car` is every racing car including the player;
// `ghost` is a replay, which shares the track but not the racing.
const GROUP = { car: 0x0002, ghost: 0x0004 };
const ALL = 0xffff;

/**
 * Tyre force curve. Returns a signed grip coefficient for a slip angle.
 *
 * Linear rise to muPeak at peakSlip, then a falloff toward muSlide by
 * limitSlip. The falloff is the whole reason the car is driftable.
 */
function tyreCurve(slip) {
  const s = Math.sign(slip);
  const m = Math.abs(slip);
  if (m <= CAR.peakSlip) return s * CAR.muPeak * (m / CAR.peakSlip);
  const t = clamp((m - CAR.peakSlip) / (CAR.limitSlip - CAR.peakSlip), 0, 1);
  return s * (CAR.muPeak + (CAR.muSlide - CAR.muPeak) * t);
}

// Every vehicle chassis in the world. Wall handling consults this so an
// opponent is not mistaken for a barrier — without it, ordinary racing
// contact would trip the anti-spin assist and the soft-wall constraint.
const CHASSIS = new Set();

export class Vehicle {
  static registerChassis(handle) { CHASSIS.add(handle); }
  static unregisterChassis(handle) { CHASSIS.delete(handle); }
  static isChassis(handle) { return CHASSIS.has(handle); }

  /**
   * @param {import("@dimforge/rapier3d-compat")} RAPIER
   * @param {object} world  Rapier world
   * @param {THREE.Vector3} spawn
   */
  constructor(RAPIER, world, spawn = new THREE.Vector3(0, 2, 0), opts = {}) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.isGhost = opts.ghost === true;

    // --- the chassis rigid body -------------------------------------
    // Body origin IS the centre of mass, so wheel mounts are measured
    // from it directly and r = contactPoint - translation() with no
    // offset bookkeeping.
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(0.0) // drag is modelled explicitly below
      .setAngularDamping(CAR.angularDamping)
      .setCcdEnabled(true) // at 55 m/s the car moves ~0.9 m per step
      .setAdditionalMassProperties(
        CAR.mass,
        { x: 0, y: 0, z: 0 }, // CoM offset — body origin already is the CoM
        CAR.inertia,
        { x: 0, y: 0, z: 0, w: 1 }
      );

    this.body = world.createRigidBody(bodyDesc);

    const h = CAR.halfExtents;
    const colDesc = RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
      .setDensity(0) // mass comes from setAdditionalMassProperties
      .setFriction(0.15)
      .setRestitution(0.0); // no bounce — see #wallScrape

    // Interaction groups, so a ghost can share the world without racing
    // in it.
    //
    // A replay is only faithful if the ghost meets the SAME track the
    // recording met — so it must still collide with road and barriers,
    // which rules out making it a sensor. What it must never do is touch
    // another car: a ghost that can shove the player is worse than no
    // ghost at all, and the shove would push the replay off its own
    // recorded line as well.
    //
    // Rapier needs BOTH directions to agree, so clearing the car bit in
    // the ghost's filter is enough to sever car-to-ghost on its own.
    colDesc.setCollisionGroups(
      this.isGhost
        ? (GROUP.ghost << 16) | (ALL & ~GROUP.car)
        : (GROUP.car << 16) | ALL
    );
    this.collider = world.createCollider(colDesc, this.body);

    // The same mask is handed to the suspension raycasts. Without it a
    // real car's wheel rays land on the ghost's chassis and it drives
    // over a rival it cannot collide with.
    this.queryGroups = this.isGhost
      ? (GROUP.ghost << 16) | (ALL & ~GROUP.car)
      : (GROUP.car << 16) | (ALL & ~GROUP.ghost);

    // --- per-wheel state --------------------------------------------
    this.wheels = CAR.wheels.map((w) => ({
      local: new THREE.Vector3(w.x, w.y, w.z),
      front: w.front,
      driven: w.driven,
      grounded: false,
      compression: 0, // 0..1, for the scene graph
      compressionM: 0, // metres, for the anti-roll bar
      load: 0, // N
      slipAngle: 0, // rad
      gripUsed: 0, // 0..1 fraction of the friction circle spent
      spinAngle: 0, // rad, visual wheel rotation
      steer: 0, // rad
      contact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      pointVel: new THREE.Vector3(),
      forceLong: new THREE.Vector3(),
      forceLat: new THREE.Vector3(),
    }));

    // One Ray, mutated per cast — see the note in #castRay.
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

    // Driven-wheel count is fixed; computing it with .filter() every step
    // allocated an array 60 times a second for no reason.
    this.drivenCount = this.wheels.filter((w) => w.driven).length;

    this.gear = 1; // 1 = forward, -1 = reverse
    this.track = null; // optional; set with setTrack()
    this.s = 0; // distance along the track centreline
    this.lateralOffset = 0; // signed, positive to the right
    this.wasGrounded = true;
    this.dragScale = 1; // < 1 while in another car's slipstream
    this.againstWall = false; // sliding along the soft boundary
    this.surfaceHandles = null; // collider handles that are ground, not wall
    this.chassisTouching = false; // body resting on geometry, wheels or not
    this.scrapingWall = false; // chassis against a roughly vertical surface
    this.wasScrapingWall = false;
    this.wallAssist = 0; // seconds of alignment assist remaining
    this.wallNormal = new THREE.Vector3();
    this.lastWallImpact = 0; // closing speed of the last wall strike, m/s
    this.wasTouching = true;
    this.wasScrapingWall = false;
    this.wallAssist = 0;
    this.beached = 0; // seconds stationary with no wheel on the ground
    this.lastLanding = 0; // misalignment of the last landing, radians
    this.landingPenalty = 0; // 0..1, how bad it was — drives camera shake
    this.damage = 0; // 0..1, accumulated crash damage — heals while clean
    // A counter rather than a boolean, so the rig can tell a NEW impact
    // from the same one still being reported. A boolean loses an impact
    // that lands and clears between two render frames.
    this.impactSeq = 0;
    this.impactLocal = new THREE.Vector3(); // hit direction in car space
    this.impactForce = 0; // 0..1, how hard the last one was
    this.steerAngle = 0;
    this.boostCharge = 0;
    this.boosting = false;
    this.driftFactor = 0;
    this.grounded = false;
    this.speed = 0;

    // Interpolation state — physics runs at a fixed rate, rendering does
    // not, so we keep the previous pose and lerp toward the current one.
    this.prevPos = new THREE.Vector3().copy(spawn);
    this.prevQuat = new THREE.Quaternion();
    this.renderPos = new THREE.Vector3().copy(spawn);
    this.renderQuat = new THREE.Quaternion();
  }

  savePreviousState() {
    const t = this.body.translation();
    const q = this.body.rotation();
    this.prevPos.set(t.x, t.y, t.z);
    this.prevQuat.set(q.x, q.y, q.z, q.w);
  }

  /** Blend the last two physics poses for rendering. alpha is 0..1. */
  writeTransform(alpha) {
    const t = this.body.translation();
    const q = this.body.rotation();
    _pos.set(t.x, t.y, t.z);
    _quat.set(q.x, q.y, q.z, q.w);
    this.renderPos.copy(this.prevPos).lerp(_pos, alpha);
    this.renderQuat.copy(this.prevQuat).slerp(_quat, alpha);
  }

  /**
   * One fixed physics step. Forces are applied here; Rapier integrates
   * and resolves contacts in world.step(), which the caller runs after
   * every vehicle in the scene has had its turn.
   */
  step(dt, controls) {
    const body = this.body;

    // Rapier's force accumulator is PERSISTENT. Unlike most engines,
    // addForce/addForceAtPoint keep applying on every subsequent step
    // until explicitly cleared — so a single suspension spike would go
    // on pushing the car forever. Clearing first is mandatory, not
    // hygiene. (Verified: one addForce call accelerated the body by the
    // same amount on five consecutive steps.)
    body.resetForces(true);
    body.resetTorques(true);

    const t = body.translation();
    const q = body.rotation();
    const lv = body.linvel();
    const av = body.angvel();
    _pos.set(t.x, t.y, t.z);
    _quat.set(q.x, q.y, q.z, q.w);
    _linvel.set(lv.x, lv.y, lv.z);
    _angvel.set(av.x, av.y, av.z);
    _up.copy(UP).applyQuaternion(_quat);

    // Signed forward speed, used everywhere below.
    _fwd.copy(FORWARD).applyQuaternion(_quat);
    const forwardSpeed = _linvel.dot(_fwd);
    this.speed = _linvel.length();

    this.#updateGear(controls, forwardSpeed);
    this.#updateSteering(dt, controls, forwardSpeed);

    // --- 1. suspension ----------------------------------------------
    // Must run before the tyres: each wheel's grip ceiling is mu * N,
    // where N is the load this wheel's own spring is carrying right now.
    // That ordering is what makes weight transfer emerge instead of
    // being scripted.
    let groundedCount = 0;
    for (const wheel of this.wheels) {
      if (this.#suspension(wheel, dt)) groundedCount++;
    }
    this.grounded = groundedCount > 0;
    body.setAngularDamping(
      this.grounded ? CAR.angularDamping : CAR.angularDampingAir
    );

    this.#antiRoll(0, 1); // front axle
    this.#antiRoll(2, 3); // rear axle

    // --- 2. tyres ----------------------------------------------------
    if (this.grounded) {
      const drive = this.#driveForce(controls, forwardSpeed);
      for (const wheel of this.wheels) {
        this.#tyre(wheel, dt, controls, drive, forwardSpeed);
      }
    } else {
      // Extra angular damping in the air only, so the car settles instead
      // of tumbling — without blunting yaw response on the ground.
      this.#airControl(controls);
      for (const wheel of this.wheels) {
        wheel.forceLong.set(0, 0, 0);
        wheel.forceLat.set(0, 0, 0);
        wheel.gripUsed = 0;
      }
    }

    // --- 3. aero -----------------------------------------------------
    this.#aero(controls);

    // --- 4. drift accounting and boost (Level 1 mechanic) ------------
    this.#drift(dt, controls);

    // --- 5. track position, un-stick, landing -------------------------
    this.#trackPosition();
    this.#unstick(controls);
    this.#landing(controls);
    this.wasGrounded = this.grounded;
  }

  /** Optional. Without a track the vehicle simply publishes s = 0. */
  setTrack(track, sHint = 0) {
    this.track = track;
    this.surfaceHandles = track?.surfaceHandles ?? null;
    this.s = sHint;
    if (track) {
      const r = track.project(_pos.copy(this.body.translation()), null);
      this.s = r.s;
      this.lateralOffset = r.t;
    }
  }

  #trackPosition() {
    if (!this.track) return;
    // Hint with last step's value: the car cannot teleport, so the search
    // window is a few metres and this stays O(1) however long the track is.
    const r = this.track.project(_pos, this.s);
    this.s = r.s;
    this.lateralOffset = r.t;
  }

  /**
   * The soft wall.
   *
   * Runs AFTER Rapier integrates, so it corrects the pose the solver just
   * produced. Past the track edge the car is moved back to it and the
   * outward component of its velocity is deleted; the along-wall
   * component survives, scrubbed, so contact costs time rather than
   * control.
   *
   * This is a constraint, not a collision. There is no contact manifold,
   * no impulse landing off-centre, and no geometry to wedge against —
   * which is why it cannot reproduce any of the ways the rigid barriers
   * found to trap the car: spun by a graze, wedged nose-in, high-centred
   * on a barrier base, beached with the wheels in the air.
   *
   * @returns {number} inward speed at the moment of contact, m/s
   */
  applySoftWall() {
    if (!this.track || !this.track.softWalls) return 0;

    const t0 = this.body.translation();
    _pos.set(t0.x, t0.y, t0.z);
    const pr = this.track.project(_pos, this.s);
    this.s = pr.s;
    this.lateralOffset = pr.t;

    const over = Math.abs(pr.t) - this.track.wallLimit;
    if (over <= 0) {
      this.againstWall = false;
      return 0;
    }

    const sign = Math.sign(pr.t);
    const fr = this.track.frameAt(pr.s, _frame);
    this.againstWall = true;

    // 1. put the car back on the legal side of the line
    _tmp2.copy(fr.right).multiplyScalar(-sign * over);
    this.body.setTranslation(
      { x: t0.x + _tmp2.x, y: t0.y, z: t0.z + _tmp2.z },
      true
    );
    // The car is on the line now, so say so: slipstream and the AI both
    // read this field later in the same step and would otherwise be told
    // the car is still buried in the wall.
    this.lateralOffset = sign * this.track.wallLimit;

    // 2. split the velocity, delete only the part going into the wall
    const lv = this.body.linvel();
    _tmp.set(lv.x, 0, lv.z);
    const into = _tmp.dot(fr.right) * sign; // > 0 means heading outward
    let bite = 0;
    if (into > 0) {
      bite = into;
      _tmp.addScaledVector(fr.right, -sign * into); // now purely along the wall
      // A square-on hit still costs you: charge part of the inward speed
      // against the along-wall speed that survives.
      _tmp.multiplyScalar(1 - CAR.softWallBite * clamp(into / 18, 0, 1));
    }
    // 3. rubbing along the wall bleeds speed steadily
    _tmp.multiplyScalar(1 - CAR.softWallScrub / 60);
    this.body.setLinvel({ x: _tmp.x, y: lv.y, z: _tmp.z }, true);

    // 4. take the sting out of the spin, but only while in contact
    const av = this.body.angvel();
    this.body.setAngvel(
      { x: av.x, y: av.y * CAR.softWallYawDamp, z: av.z },
      true
    );

    return bite;
  }


  /**
   * Get off the wall.
   *
   * Two separate failures, one method, because they share a trigger:
   *
   *   PINNED — the car is alongside a barrier with the tyres loaded. The
   *   front tyres sit far past peak slip, so the steering the player is
   *   holding produces almost no yaw and the car tracks the wall for
   *   seconds. Translating it sideways has to beat the tyres; a push does
   *   that directly.
   *
   *   WEDGED — the car has spun and is jammed corner-first into the
   *   barrier, often facing back up the track. Measured at 137 degrees
   *   off the track direction with all four wheels down and 0.5 m of the
   *   nose inside the trimesh. Throttle drives it further in. Nothing in
   *   the wall code extracts it, so the progress backstop respawns it,
   *   and it drives back into the same corner: the loop the player sees
   *   as an invisible wall that eats the whole field.
   *
   * Keyed on POSITION, not on contact. A car leaning on a barrier often
   * produces a normal too far from horizontal to count as a wall strike,
   * so a contact-driven push never fires in the case that needs it most.
   */
  #unstick(controls) {
    if (!this.track) return;
    const edge = this.track.width * 0.5 - CAR.unstickMargin;
    const off = this.lateralOffset;
    if (Math.abs(off) < edge) return;

    const fr = this.track.frameAt(this.s, _frame);
    const outward = Math.sign(off); // +1 = pinned on the right wall

    // Separation rate: how fast the car is moving AWAY from this wall.
    // Not total speed — a pinned car can be doing 30 km/h along the
    // barrier and still be going nowhere away from it.
    const lv = this.body.linvel();
    _tmp2.set(lv.x, 0, lv.z);
    const away = -outward * _tmp2.dot(fr.right);
    const fade = clamp(1 - away / CAR.wallPushOffSpeed, 0, 1);
    if (fade <= 0.01) return; // already peeling off under its own steam

    _tmp2.copy(fr.right).multiplyScalar(-outward * CAR.wallPushOff * fade);
    _tmp2.y = 0;
    this.body.addForce(_tmp2, true);

    // A yaw torque aimed at the track tangent was tried here to rotate a
    // car that has spun and jammed corner-first into the barrier. It was
    // removed: measured against the same four wedge cases with it on and
    // off, the freeing times were identical to the frame (0.88 / 1.3 /
    // 1.2 / 0.35 s), and on a car sitting at 137 degrees it pushed the
    // yaw further wrong. With four wheels loaded the tyres resist the
    // rotation, and the throttle drives the nose deeper in.
    //
    // A car wedged that badly is recovered by the respawn instead, which
    // now fires in 3.5 s and puts it back at the checkpoint it actually
    // reached. Shipping an assist that changes nothing measurable is how
    // the deleted-by-mistake push-off happened in the first place.
  }

  /**
   * Wall contact. Rapier has already resolved the collision; this only
   * tames the consequences, because an impulse applied at a corner of the
   * chassis spins the car and being turned around by a kerb-brush is a
   * far bigger punishment than the mistake deserves.
   *
   * Speed is scrubbed continuously while scraping, so a wall still costs
   * you the lap — it just costs it in time rather than in orientation.
   */
  #wallScrape(isFirstContact, controls) {
    const body = this.body;

    // Cap the spin. This is the part that stops a kerb-brush turning the
    // car around, and it applies for as long as contact lasts — but as a
    // ceiling, so the player can still steer out of the wall.
    const av = body.angvel();
    const cap = CAR.wallYawClamp;
    if (Math.abs(av.y) > cap) {
      body.setAngvel({ x: av.x, y: Math.sign(av.y) * cap, z: av.z }, true);
    }

    const lv = body.linvel();
    _tmp.set(lv.x, lv.y, lv.z);

    // Split into the component heading into the wall and the component
    // running along it. Rapier removes the first for us; we only decide
    // how much of the second survives.
    const into = _tmp.dot(this.wallNormal);
    _tmp2.copy(this.wallNormal).multiplyScalar(into);
    _tmp.sub(_tmp2); // now purely along the wall

    let keep;
    if (isFirstContact) {
      // A one-off charge, scaled by how squarely the car arrived. Hitting
      // the wall head-on costs the most; grazing it costs almost nothing.
      this.lastWallImpact = Math.abs(into);
      const severity = clamp(Math.abs(into) / CAR.wallImpactRef, 0, 1);
      // Damage uses its own, lower reference than the speed penalty: a hit
      // hard enough to be worth scrubbing speed for should already leave a
      // mark, rather than the paint staying pristine after a big one.
      const bite = clamp(Math.abs(into) / CAR.damageRef, 0, 1);
      this.damage = clamp(this.damage + bite * CAR.damageGain, 0, 1);

      // Publish WHERE it was hit, in the car's own frame, so the rig can
      // put the dent on the panel that actually met the wall. The rig has
      // no idea where the barrier was; only the physics does.
      if (bite > 0.05) {
        const q = body.rotation();
        _quat2.set(q.x, q.y, q.z, q.w).invert();
        this.impactLocal.copy(this.wallNormal).applyQuaternion(_quat2);
        this.impactForce = bite;
        this.impactSeq++;
      }
      keep = 1 - CAR.wallImpactScrub * severity;
    } else {
      // Rubbing along: a slow bleed, so a long scrape costs lap time
      // without ever bringing the car to a halt.
      keep = 1 - CAR.wallSlideScrub / 60;
    }

    _tmp.multiplyScalar(keep);
    body.setLinvel({ x: _tmp.x, y: lv.y, z: _tmp.z }, true);

    this.#alignToVelocity(controls);
  }

  /**
   * Point the car where it is going.
   *
   * A wall strike lands off-centre and yaws the car away from its own
   * velocity; left alone that reads as being spun round by a glancing
   * blow. Runs during contact AND for a short window afterwards, because
   * the rotation an impact starts plays out long after the touch ends.
   */
  #alignToVelocity(controls) {
    // Steering input overrides the assist. Without this the car cannot be
    // driven off a barrier: the assist holds the nose parallel to the
    // wall and cancels the steering meant to peel it away.
    const steerInput = Math.abs(controls?.steer ?? 0);
    const authority = 1 - CAR.wallAssistYield * Math.min(1, steerInput);
    if (authority <= 0.02) return;

    const body = this.body;
    const lv = body.linvel();
    _tmp2.set(lv.x, 0, lv.z);
    if (_tmp2.lengthSq() < 4) return; // too slow to have a meaningful heading
    _tmp2.normalize();

    _fwd.copy(FORWARD).applyQuaternion(_quat);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) return;
    _fwd.normalize();

    const crossY = _fwd.z * _tmp2.x - _fwd.x * _tmp2.z;
    const err = Math.atan2(crossY, _fwd.dot(_tmp2));
    const yawRate = body.angvel().y;
    body.addTorque(
      {
        x: 0,
        y: (err * CAR.wallAlignTorque - yawRate * CAR.wallAlignDamp) * authority,
        z: 0,
      },
      true
    );
  }

  /**
   * Nudge a stranded car back toward the road.
   *
   * Deliberately driven by POSITION and SPEED, not by contact detection.
   * The earlier version only ran while `scrapingWall` was true, which
   * needs a contact normal within 28 degrees of horizontal — a car
   * leaning against a barrier frequently does not produce one, so the
   * help never arrived and the car simply sat there. Where the car is and
   * how fast it is going are always known.
   *
   * The direction is the sign of the lateral offset, which says
   * unambiguously which side the barrier is on. Rapier's manifold normal
   * does not: its orientation flips between contacts, and a fixed sign
   * pushed away from the wall going forward and into it in reverse.
   */
  /**
   * Landing rule — Level 2's failure condition.
   *
   * Compare the chassis up-vector against the surface it just met. Past
   * badLandingAngle the landing scrubs speed in proportion to how wrong
   * the attitude was, so arriving flat is worth doing and arriving
   * sideways costs you the corner. The penalty is published so the camera
   * can telegraph it — a number on the HUD is not legible at speed.
   */
  #landing(controls) {
    this.landingPenalty *= 0.9; // decays, so the camera settles
    // Damage does NOT heal on its own. It is repaired by driving through a
    // repair pickup, which turns recovery into a line you have to take
    // rather than a timer you wait out — the same reason the boost strips
    // on Sprint are offset instead of sitting on the racing line.

    // Touchdown is not the same as "a wheel ray found ground".
    //
    // Pitched past about 45 degrees the suspension rays point well away
    // from vertical and are only rest+radius long, so they miss entirely
    // while the chassis box is sitting on the road. The car is then
    // beached: no wheel contact, no tyre forces, and — before this — no
    // landing detected either, so the very worst landings were the only
    // ones that scored no penalty. Ask the physics world whether the
    // chassis is touching anything instead.
    this.chassisTouching = false;
    this.scrapingWall = false;
    this.inContactWithCar = false;
    this.wallNormal.set(0, 0, 0);
    if (this.world.contactPairsWith) {
      this.world.contactPairsWith(this.collider, (other) => {
        // The road and the runoff are ground by definition, whatever
        // normal their triangle edges happen to report.
        // A rival is neither ground nor wall: let Rapier resolve the
        // contact between two dynamic bodies and leave it at that.
        if (Vehicle.isChassis(other.handle)) {
          this.inContactWithCar = true;
          return;
        }
        const isSurface = this.surfaceHandles?.has(other.handle) ?? false;
        this.world.contactPair?.(this.collider, other, (manifold) => {
          // contactPairsWith iterates BROAD-PHASE candidates, not actual
          // touches. The road trimesh's bounding volume spans the whole
          // circuit, so without this test the chassis counts as touching
          // it permanently — and manifold.normal() reads (0,0,0) because
          // there are no contact points to have a normal.
          if ((manifold.numContacts?.() ?? 0) === 0) return;
          this.chassisTouching = true;

          // Separate a wall from the ground by how horizontal the normal
          // is, so bottoming out over a crest is not a wall strike.
          if (isSurface) return; // bottoming out, not a wall strike
          const nrm = manifold.normal?.();
          if (!nrm) return;
          if (Math.hypot(nrm.x, nrm.z) > CAR.wallMinNormal) {
            this.scrapingWall = true;
            this.wallNormal.x += nrm.x;
            this.wallNormal.y += nrm.y;
            this.wallNormal.z += nrm.z;
          }
        });
      });
    }
    if (this.scrapingWall && this.wallNormal.lengthSq() > 1e-6) {
      this.wallNormal.normalize();
      this.#wallScrape(!this.wasScrapingWall, controls);
      this.wallAssist = CAR.wallAssistTime;
    } else if (this.wallAssist > 0) {
      // Keep steadying the car after it has bounced clear.
      this.wallAssist -= 1 / 60;
      this.#alignToVelocity(controls);
    }
    this.wasScrapingWall = this.scrapingWall;
    const touching = this.grounded || this.chassisTouching;

    // Beached: upright-ish or not, if nothing is rolling and we are barely
    // moving, the player has no way to recover on their own.
    this.beached =
      !this.grounded && this.speed < 1.5 && touching
        ? this.beached + 1 / 60
        : 0;

    const wasTouching = this.wasTouching;
    this.wasTouching = touching;
    if (!touching || wasTouching) return; // still in the air, or already down

    _normal.set(0, 0, 0);
    let n = 0;
    for (const wheel of this.wheels) {
      if (!wheel.grounded) continue;
      _normal.add(wheel.normal);
      n++;
    }
    // Landed on the body with no wheel contact: fall back to world up, so
    // the measurement still happens rather than being skipped.
    if (n === 0) _normal.set(0, 1, 0);
    else _normal.divideScalar(n).normalize();

    _up.copy(UP).applyQuaternion(_quat);
    const misalign = Math.acos(clamp(_up.dot(_normal), -1, 1));
    this.lastLanding = misalign;
    if (misalign <= CAR.badLandingAngle) return;

    const severity = clamp(
      (misalign - CAR.badLandingAngle) / CAR.badLandingSpread,
      0,
      1
    );
    this.landingPenalty = severity;
    this.damage = clamp(this.damage + severity * CAR.damageLanding, 0, 1);

    // Scrub speed rather than teleport or stop: the player keeps control,
    // they just lose the corner.
    const keep = 1 - severity * CAR.badLandingScrub;
    const lv = this.body.linvel();
    this.body.setLinvel(
      { x: lv.x * keep, y: lv.y, z: lv.z * keep },
      true
    );
  }

  // -------------------------------------------------------------------
  #updateSteering(dt, controls, forwardSpeed) {
    // Steering authority falls with speed. Without this, a full-lock
    // keypress at 150 km/h asks for more lateral force than the tyres
    // can make and the car is simply undriveable.
    const speedFactor =
      1 - CAR.steerSpeedFactor * clamp(Math.abs(forwardSpeed) / CAR.steerSpeedFalloff, 0, 1);
    const target = controls.steer * CAR.maxSteer * speedFactor;

    // Ramp rather than snap — this is most of what makes keys feel analogue.
    const maxDelta = CAR.steerRate * dt;
    const delta = clamp(target - this.steerAngle, -maxDelta, maxDelta);
    this.steerAngle += delta;

    // Ackermann: the inner wheel turns slightly more than the outer, so
    // both trace the same turn centre instead of scrubbing.
    for (const wheel of this.wheels) {
      if (!wheel.front) {
        wheel.steer = 0;
        continue;
      }
      const isInner = Math.sign(wheel.local.x) === Math.sign(this.steerAngle);
      const gain = isInner ? 1 + CAR.ackermann : 1 - CAR.ackermann;
      wheel.steer = this.steerAngle * gain;
    }
  }

  // -------------------------------------------------------------------
  #suspension(wheel, dt) {
    const body = this.body;

    _mount.copy(wheel.local).applyQuaternion(_quat).add(_pos);
    _down.copy(UP).applyQuaternion(_quat).multiplyScalar(-1);

    const maxToi = CAR.suspensionRest + CAR.wheelRadius;
    const hit = this.#castRay(_mount, _down, maxToi);

    if (!hit) {
      wheel.grounded = false;
      wheel.load = 0;
      wheel.compression = 0;
      wheel.compressionM = 0;
      return false;
    }

    wheel.grounded = true;
    _normal.copy(hit.normal);
    // A ray can hit a face whose normal points away from us on thin or
    // double-sided geometry; flip it so the spring always pushes up.
    if (_normal.dot(_down) > 0) _normal.negate();
    wheel.normal.copy(_normal);

    _contact.copy(_down).multiplyScalar(hit.toi).add(_mount);
    wheel.contact.copy(_contact);

    const compressionM = maxToi - hit.toi;
    wheel.compressionM = compressionM;
    wheel.compression = clamp(compressionM / CAR.suspensionTravel, 0, 1);

    // Velocity of the chassis at the contact point: v + omega x r
    _r.copy(_contact).sub(_pos);
    _pointVel.copy(_angvel).cross(_r).add(_linvel);
    wheel.pointVel.copy(_pointVel);

    const vN = _pointVel.dot(_normal); // closing speed along the normal
    const damper = vN < 0 ? CAR.damperCompression : CAR.damperRebound;

    // A spring cannot pull. Clamping at zero is what lets a wheel leave
    // the ground over a crest instead of being sucked back down.
    wheel.load = Math.max(0, CAR.springK * compressionM - damper * vN);

    _force.copy(_normal).multiplyScalar(wheel.load);
    body.addForceAtPoint(_force, _contact, true);

    return true;
  }

  // -------------------------------------------------------------------
  #antiRoll(iL, iR) {
    const L = this.wheels[iL];
    const R = this.wheels[iR];
    if (!L.grounded && !R.grounded) return;

    // Transfer load between the two sides in proportion to how much more
    // one is compressed than the other. Without it, the only way to stop
    // body roll is stiffer springs, which ruins bump behaviour.
    //
    // Signs matter and are easy to get backwards: if L is the more
    // compressed side, the bar RESISTS that, so it pushes the body UP on
    // the L side and pulls it DOWN on the R side. Reversed, this adds
    // roll instead of removing it — which reads as a mysteriously
    // tippy car rather than as an obvious bug.
    const diff = (L.compressionM - R.compressionM) * CAR.antiRoll;
    _tmp.copy(UP).applyQuaternion(_quat);

    if (L.grounded) {
      _force.copy(_tmp).multiplyScalar(diff);
      this.body.addForceAtPoint(_force, L.contact, true);
    }
    if (R.grounded) {
      _force.copy(_tmp).multiplyScalar(-diff);
      this.body.addForceAtPoint(_force, R.contact, true);
    }

    // The bar also changes the vertical load at the contact patch, and
    // therefore the grip ceiling mu*N that the tyre stage is about to
    // read. This is what makes an anti-roll bar a BALANCE tool: stiffen
    // the front and you move load transfer forward, cutting front grip
    // and adding understeer. It only works because anti-roll runs
    // between the suspension and the tyres.
    L.load = Math.max(0, L.load + diff);
    R.load = Math.max(0, R.load - diff);
  }

  // -------------------------------------------------------------------
  /**
   * Pick a gear. Two states, 1 (forward) and -1 (reverse).
   *
   * Reverse only engages from near a standstill, so the brake can never
   * become an accidental reverse at speed — hold the brake, the car stops,
   * and only then does it start backing up. Any throttle, or rolling
   * forward again, returns to a forward gear.
   */
  #updateGear(controls, forwardSpeed) {
    if (this.gear === 1) {
      if (
        controls.brake > 0.1 &&
        controls.throttle < 0.1 &&
        forwardSpeed < CAR.reverseSelectSpeed
      ) {
        this.gear = -1;
      }
    } else if (controls.throttle > 0.1 || forwardSpeed > CAR.reverseSelectSpeed) {
      this.gear = 1;
    }
  }

  #driveForce(controls, forwardSpeed) {
    if (this.gear === -1) {
      // In reverse the brake pedal IS the throttle, and all four wheels
      // drive — see the note on reverseForce in config.
      const falloff = clamp(
        1 - Math.abs(forwardSpeed) / CAR.reverseMaxSpeed,
        0,
        1
      );
      return -(controls.brake * CAR.reverseForce * falloff) / this.wheels.length;
    }

    // Linear falloff stands in for a torque curve and a gearbox.
    const falloff = clamp(1 - Math.abs(forwardSpeed) / CAR.engineFalloffSpeed, 0, 1);
    // Boost is deliberately NOT added here — see #aero. Routed through
    // the driven wheels it consumed the whole friction circle (5.5 kN per
    // rear tyre against a ~5 kN budget), leaving zero lateral grip, so
    // boosting mid-corner sent rear slip from 11 to 64 degrees and spun
    // the car every time.
    // A damaged car makes less power. Only the engine is affected — not
    // grip and not steering — so the car still handles predictably and the
    // penalty is paid in lap time rather than in control.
    const condition = 1 - this.damage * CAR.damagePowerLoss;
    return (
      (controls.throttle * CAR.engineForce * falloff * condition) /
      this.drivenCount
    );
  }

  // -------------------------------------------------------------------
  #tyre(wheel, dt, controls, drive, forwardSpeed) {
    if (!wheel.grounded) {
      wheel.slipAngle = 0;
      wheel.gripUsed = 0;
      wheel.forceLong.set(0, 0, 0);
      wheel.forceLat.set(0, 0, 0);
      // Free-spinning wheel in the air keeps its last speed, visually.
      return;
    }

    _normal.copy(wheel.normal);

    // Wheel heading: chassis forward, steered about the contact normal,
    // then flattened into the contact plane.
    _fwd.copy(FORWARD).applyQuaternion(_quat);
    if (wheel.steer !== 0) _fwd.applyAxisAngle(_normal, -wheel.steer);
    _fwd.projectOnPlane(_normal);
    if (_fwd.lengthSq() < 1e-8) return;
    _fwd.normalize();

    _right.copy(_fwd).cross(_normal).normalize();

    const pv = wheel.pointVel;
    const vF = pv.dot(_fwd);
    const vR = pv.dot(_right);

    // The +0.5 keeps this finite at rest instead of dividing by zero and
    // making a stationary car snap to full slip.
    wheel.slipAngle = Math.atan2(vR, Math.abs(vF) + 0.5);

    // Handbrake cuts rear grip rather than applying a braking force —
    // physically closer to a locked wheel, and the cleanest way to give
    // Level 1 a deliberate drift-initiation button.
    const handbraked = controls.handbrake && !wheel.front;
    let gripMul = handbraked ? CAR.handbrakeGrip : 1;
    // Rear bias keeps the car understeering at the limit rather than
    // snapping into oversteer. Handbrake still overrides it, so a
    // deliberate drift is unaffected.
    if (!wheel.front && !handbraked) gripMul *= CAR.rearGripBias;
    // Scraping a wall: let the tyres give up rather than scrub the car to
    // a halt against the barrier.
    if (this.scrapingWall) gripMul *= CAR.wallGripFactor;

    const lat = -tyreCurve(wheel.slipAngle) * wheel.load * gripMul;

    // Every wheel drives in reverse; only the rears drive going forward.
    const driven = this.gear === -1 || wheel.driven;
    let lon = driven ? drive : 0;

    // The pedal that brakes swaps with the gear. In forward it is the
    // brake input; in reverse it is the throttle. Leaving it hard-wired
    // to controls.brake meant the brake fought the reverse drive and the
    // car could never pull away backwards.
    const brakeInput = this.gear === 1 ? controls.brake : controls.throttle;
    if (brakeInput > 0) {
      // Taper the direction to zero as the wheel stops rather than cutting
      // the brakes off below a threshold. A hard cut-off left the car
      // creeping the last metre; a hard sign() makes it buzz back and
      // forth around standstill. Tapering does neither.
      const dir =
        Math.abs(vF) > CAR.brakeCreepSpeed
          ? Math.sign(vF)
          : vF / CAR.brakeCreepSpeed;
      // Bias the split front/rear rather than dividing by four. The rear
      // axle is light under braking and saturates first; over-braking it
      // costs the lateral grip that keeps the car pointing straight.
      const axleShare = wheel.front ? CAR.brakeBias : 1 - CAR.brakeBias;
      lon -= brakeInput * CAR.brakeForce * axleShare * 0.5 * dir;
    }
    lon -= CAR.rollingResistance * wheel.load * Math.sign(vF);

    // --- the friction circle -----------------------------------------
    // A tyre has ONE budget of grip; turning and accelerating spend from
    // the same account. This clamp is why braking into a corner
    // understeers, why full throttle mid-corner steps the rear out, and
    // why the car feels like a car.
    _force.copy(_right).multiplyScalar(lat).addScaledVector(_fwd, lon);
    const max = CAR.muPeak * wheel.load * gripMul;
    const mag = _force.length();
    wheel.gripUsed = max > 1 ? clamp(mag / max, 0, 2) : 0;
    if (mag > max && mag > 1e-6) _force.multiplyScalar(max / mag);

    wheel.forceLong.copy(_fwd).multiplyScalar(lon);
    wheel.forceLat.copy(_right).multiplyScalar(lat);

    this.body.addForceAtPoint(_force, wheel.contact, true);

    // Visual wheel spin, driven by how fast the contact patch is moving.
    wheel.spinAngle += (vF / CAR.wheelRadius) * dt;
  }

  // -------------------------------------------------------------------
  #airControl(controls) {
    // With no wheel grounded the suspension and tyre stages are skipped
    // entirely — only gravity, drag and the player's air input act.
    _fwd.copy(FORWARD).applyQuaternion(_quat);
    _right.set(1, 0, 0).applyQuaternion(_quat);
    _up.copy(UP).applyQuaternion(_quat);

    _force.set(0, 0, 0);
    _force.addScaledVector(_right, controls.pitch * CAR.airPitchTorque);
    _force.addScaledVector(_fwd, -controls.roll * CAR.airRollTorque);

    // --- P: rotate back toward level ---------------------------------
    // Turning vector a toward vector b takes a torque along a x b, so
    // levelling the car needs +(carUp x worldUp). This was negated, which
    // made the "assist" rotate the car AWAY from flat and turned every
    // jump into a tumble. Landing attitude decides whether the player
    // keeps their speed, so the sign here is not cosmetic.
    _tmp.copy(_up).cross(UP);
    _force.addScaledVector(_tmp, CAR.autoLevel);

    // --- D: bleed off rotation rate ----------------------------------
    // Split the angular velocity into yaw (about world up) and the rest.
    // Pitch and roll are damped hard, because a tumble is never what the
    // player wanted; yaw is damped only lightly, because a deliberate
    // spin sometimes is. Without the D term the P term alone just makes
    // the car oscillate through level instead of settling on it.
    const yawRate = _angvel.dot(UP);
    _tmp.copy(UP).multiplyScalar(yawRate); // yaw component
    _tmp2.copy(_angvel).sub(_tmp); // pitch + roll component
    _force.addScaledVector(_tmp, -CAR.airYawDamp);
    _force.addScaledVector(_tmp2, -CAR.airStabilise);

    this.body.addTorque(_force, true);
  }

  // -------------------------------------------------------------------
  #aero(controls) {
    // Drag ~ v^2 gives a natural top speed instead of a hard clamp on
    // velocity, which always feels artificial.
    const speed = _linvel.length();
    if (speed > 0.01) {
      _force.copy(_linvel).multiplyScalar(-CAR.drag * this.dragScale * speed);
      this.body.addForce(_force, true);
    }

    // Boost as a body force along the car's heading, applied at the
    // centre of mass. A shove, not engine torque: it costs no tyre grip
    // and generates no yaw, so it adds speed without taking away the
    // ability to steer.
    if (this.boosting) {
      _fwd.copy(FORWARD).applyQuaternion(_quat);
      _force.copy(_fwd).multiplyScalar(CAR.boostForce);
      this.body.addForce(_force, true);
    }

    // Downforce ~ v^2 raises N with speed, so the car gains grip the
    // faster it goes. This is what makes the boost feel planted rather
    // than terrifying.
    if (this.grounded) {
      const df = CAR.downforce * speed * speed * (this.boosting ? CAR.boostDownforceBonus : 1);
      _force.set(0, -df, 0);
      this.body.addForce(_force, true);
    }
  }

  // -------------------------------------------------------------------
  #drift(dt, controls) {
    // A drift is already measurable: the mean absolute slip angle of the
    // two rear wheels. No new state, no special case.
    const rl = this.wheels[2];
    const rr = this.wheels[3];
    const rearSlip = (Math.abs(rl.slipAngle) + Math.abs(rr.slipAngle)) / 2;

    const sliding = rearSlip > CAR.peakSlip && this.speed > CAR.driftMinSpeed && this.grounded;
    this.driftFactor = sliding
      ? clamp((rearSlip - CAR.peakSlip) / (CAR.limitSlip - CAR.peakSlip), 0, 1)
      : 0;

    if (sliding) {
      // Rate scales with both slip and speed, so a long deliberate slide
      // pays far better than a twitch.
      const rate = CAR.boostFillRate * this.driftFactor * clamp(this.speed / 30, 0, 1);
      this.boostCharge = Math.min(CAR.boostCapacity, this.boostCharge + rate * dt);
    }

    // Drifting is the fast way to earn boost, but a slow trickle means
    // Shift is never simply dead — which matters while tuning, and stops
    // new players concluding the button does nothing.
    this.boostCharge = Math.min(
      CAR.boostCapacity,
      this.boostCharge + CAR.boostPassiveRegen * dt
    );

    this.boosting = controls.boost && this.boostCharge > 0 && this.gear === 1;
    if (this.boosting) {
      this.boostCharge = Math.max(0, this.boostCharge - CAR.boostDrainRate * dt);
    }
  }

  // -------------------------------------------------------------------
  /**
   * Raycast into the Rapier world, excluding our own chassis.
   *
   * Rapier renamed the time-of-impact field between versions
   * (`toi` -> `timeOfImpact`), so both are read here rather than pinning
   * a version and being surprised on someone else's machine.
   */
  #castRay(origin, dir, maxToi) {
    // Reused rather than reallocated — 4 casts a step at 60 Hz is 240
    // objects a second that the GC would otherwise have to collect.
    this._ray.origin = origin;
    this._ray.dir = dir;
    const hit = this.world.castRayAndGetNormal(
      this._ray,
      maxToi,
      true, // solid
      undefined,
      this.queryGroups, // never see a ghost, and a ghost never sees a car
      undefined,
      this.body // exclude our own chassis
    );
    if (!hit) return null;

    const toi = hit.timeOfImpact !== undefined ? hit.timeOfImpact : hit.toi;
    if (toi === undefined) return null;

    return { toi, normal: hit.normal };
  }

  // -------------------------------------------------------------------
  /** The state struct every other module reads. Nothing else is public. */
  get state() {
    return {
      position: this.renderPos,
      quaternion: this.renderQuat,
      speed: this.speed,
      grounded: this.grounded,
      steerAngle: this.steerAngle,
      gear: this.gear,
      s: this.s,
      lateralOffset: this.lateralOffset,
      landingPenalty: this.landingPenalty,
      damage: this.damage,
      beached: this.beached,
      scrapingWall: this.scrapingWall || this.againstWall,
      againstWall: this.againstWall,
      inContactWithCar: this.inContactWithCar,
      dragScale: this.dragScale,
      lastWallImpact: this.lastWallImpact,
      driftFactor: this.driftFactor,
      boostCharge: this.boostCharge,
      boosting: this.boosting,
      impactSeq: this.impactSeq,
      impactLocal: this.impactLocal,
      impactForce: this.impactForce,
      wheels: this.wheels,
    };
  }

  /**
   * Everything that must be restored for a replay to reproduce a run.
   *
   * Body pose and velocity are not enough on their own: the gear, the
   * steering ramp, the boost tank and each wheel's spin all persist
   * across steps and change what the next step does. Miss one and the
   * replay diverges slowly, which is far harder to spot than diverging
   * immediately.
   */
  /** Repair, from a pickup. Returns how much condition was actually given. */
  repair(amount) {
    const before = this.damage;
    this.damage = Math.max(0, this.damage - amount);
    return before - this.damage;
  }

  /** Top up boost charge, from a pickup. */
  refillBoost(amount) {
    const before = this.boostCharge;
    this.boostCharge = Math.min(CAR.boostCapacity, this.boostCharge + amount);
    return this.boostCharge - before;
  }

  captureState() {
    const t = this.body.translation();
    const q = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    return {
      t: [t.x, t.y, t.z],
      q: [q.x, q.y, q.z, q.w],
      lv: [lv.x, lv.y, lv.z],
      av: [av.x, av.y, av.z],
      gear: this.gear,
      steerAngle: this.steerAngle,
      boostCharge: this.boostCharge,
      boosting: this.boosting,
      s: this.s,
      lateralOffset: this.lateralOffset,
      wasGrounded: this.wasGrounded,
      wasTouching: this.wasTouching,
      wasScrapingWall: this.wasScrapingWall,
      wallAssist: this.wallAssist,
      beached: this.beached,
      dragScale: this.dragScale,
      // Damage scales engine force, so a replay that did not restore it
      // would drive with different power than the recording did.
      damage: this.damage,
      spin: this.wheels.map((w) => w.spinAngle),
    };
  }

  restoreState(k) {
    this.body.setTranslation({ x: k.t[0], y: k.t[1], z: k.t[2] }, true);
    this.body.setRotation({ x: k.q[0], y: k.q[1], z: k.q[2], w: k.q[3] }, true);
    this.body.setLinvel({ x: k.lv[0], y: k.lv[1], z: k.lv[2] }, true);
    this.body.setAngvel({ x: k.av[0], y: k.av[1], z: k.av[2] }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.gear = k.gear;
    this.steerAngle = k.steerAngle;
    this.boostCharge = k.boostCharge;
    this.boosting = k.boosting;
    this.s = k.s;
    this.lateralOffset = k.lateralOffset;
    this.wasGrounded = k.wasGrounded;
    this.wasTouching = k.wasTouching;
    this.wasScrapingWall = k.wasScrapingWall;
    this.wallAssist = k.wallAssist;
    this.beached = k.beached;
    this.dragScale = k.dragScale;
    this.damage = k.damage ?? 0;
    k.spin.forEach((v, i) => (this.wheels[i].spinAngle = v));
    this.prevPos.set(k.t[0], k.t[1], k.t[2]);
    this.prevQuat.set(k.q[0], k.q[1], k.q[2], k.q[3]);
    this.renderPos.copy(this.prevPos);
    this.renderQuat.copy(this.prevQuat);
  }

  reset(spawn, heading = 0) {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, heading);
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    this.gear = 1;
    this.wasGrounded = true;
    this.wasTouching = true;
    this.wasScrapingWall = false;
    this.wallAssist = 0;
    this.beached = 0;
    this.landingPenalty = 0;
    this.damage = 0;
    this.steerAngle = 0;
    this.boostCharge = CAR.boostCapacity;
    this.boosting = false;
    this.prevPos.copy(spawn);
    this.prevQuat.copy(q);
    this.renderPos.copy(spawn);
    this.renderQuat.copy(q);
  }
}
