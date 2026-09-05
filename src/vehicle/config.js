// Vehicle constants — section 8 of the design document.
//
// ===================================================================
// FROZEN as of the M10 pass. Level authors may build against these.
//
// The handling is signed off and validated (resting load = mass x g,
// 39 m braking from 120 km/h at 1.45 g, zero lateral drift over 348 m,
// a six-car race with no spins). Changing a value here now re-tunes
// every level at once and invalidates any stored ghost recording,
// because a replay is only faithful if the car it replays through is
// the car that recorded it.
//
// Two fields are deliberately written at RUNTIME by the options menu
// and are not frozen: `autoLevel` (landing assist) and
// `wallAlignTorque` (wall assist). Both are player-facing assists, and
// both are scaled from the defaults below rather than replacing them.
//
// If you need different handling for a level, ask for a per-level
// override rather than editing this file.
// ===================================================================
//
// These values are self-consistent:
// with a 300 kg corner mass, k = 35000 gives a natural frequency of about
// 1.72 Hz and c = 4500 gives a damping ratio near 0.69. That is a
// well-behaved road car and comfortably stable at a 1/60 s timestep.
//
// Axis convention (Three.js, Y-up):
//   forward = -Z     right = +X     up = +Y
//   rotation about X = pitch,  about Y = yaw,  about Z = roll

export const CAR = {
  // --- body ---------------------------------------------------------
  mass: 1200, // kg
  // Principal inertia about X (pitch), Y (yaw), Z (roll).
  // Solid box 4.2 long x 1.8 wide x 1.3 tall. Drop yaw toward 1600 for a
  // more eager, arcade turn-in.
  inertia: { x: 1933, y: 2088, z: 493 },

  // Half-extents of the chassis collider. The body origin IS the centre
  // of mass, so y must be less than comHeight or the box scrapes the
  // ground: 0.45 - 0.38 leaves 70 mm of clearance.
  // y = 0.27 leaves 0.18 m of ground clearance under the centre of mass.
  // At 0.38 there was only 0.07 m: the chassis dragged on the road for
  // thousands of frames a lap, and a landing bottomed out hard enough to
  // take 76 km/h off in a single frame.
  halfExtents: { x: 0.85, y: 0.27, z: 2.0 },

  // How high the centre of mass rides at rest. THE most sensitive number
  // in this file — it sets the rollover threshold, which is
  // trackHalfWidth / comHeight = 0.8 / 0.45 = 1.78 g. That must stay
  // comfortably above muPeak (1.4) or the car tips before it slides,
  // which is both wrong and horrible to drive.
  comHeight: 0.45,

  wheelRadius: 0.34, // m
  suspensionRest: 0.35, // m — length of the spring at rest
  suspensionTravel: 0.25, // m — used to normalise compression to 0..1
  springK: 35000, // N/m per wheel
  damperCompression: 4500, // N.s/m
  damperRebound: 5500, // N.s/m
  antiRoll: 12000, // N per unit compression difference, per axle

  // Rapier body damping. Angular damping fights the car's natural yaw
  // response, so keep it low on the ground — it exists to stop the car
  // tumbling forever in the air, not to stabilise cornering.
  angularDamping: 0.12,
  angularDampingAir: 0.4, // explicit PD stabilisation below does the real work

  // --- tyres --------------------------------------------------------
  // The curve: linear rise to muPeak at peakSlip, then a falloff to
  // muSlide by limitSlip. That falloff is what makes a slide holdable
  // rather than a binary loss of control. Flatten it and the car becomes
  // uncatchable; remove it and the car cannot drift at all.
  muPeak: 1.4,
  // 1.2, not 1.0. A 29% grip cliff past the peak means the moment a tyre
  // is over-slipped it lets go, and the car spins with no warning. A 14%
  // drop still lets a slide be held and started deliberately, but it
  // gives the player time to catch it.
  muSlide: 1.25,
  // 18 degrees, not 11.5. Measured: at 60% steering the front tyres run
  // 19-20 degrees of slip at any speed worth cornering at. With the peak
  // at 11.5 that put ordinary driving 65-78% PAST it — permanently in the
  // falloff, where the tyre gives less grip the harder you ask. The car
  // simultaneously refused to turn and felt like it was letting go,
  // because both were true. At 18 the same cornering sits 16-19% past the
  // peak: near the plateau, with the falloff kept in reserve for genuine
  // over-driving and for the drift.
  peakSlip: 0.315, // rad (18 degrees)
  limitSlip: 0.52, // rad (30 degrees)

  // The rear axle gets slightly more grip than the front, so the car runs
  // wide at the limit instead of swapping ends. Measured before this: the
  // balance flipped from understeer to snap-oversteer somewhere between
  // 110 and 140 km/h, which is exactly the speed a player is carrying
  // into a fast corner.
  rearGripBias: 1.10,
  handbrakeGrip: 0.55, // rear grip multiplier while the handbrake is held

  // --- drivetrain ---------------------------------------------------
  engineForce: 9000, // N at zero speed
  engineFalloffSpeed: 70, // m/s at which drive force reaches zero
  // Sized so that BRAKING IS GRIP-LIMITED, not force-limited. At 24 kN the
  // demand exceeds mu*N, so the friction circle clamps it and the tyres
  // decide the stopping distance. At the old 14 kN the number itself was
  // the limit, which capped braking at about 1.0 g when 1.4 g was available.
  // Total demand is set just above what the tyres can actually deliver
  // (mu * weight = 16.5 kN = 1.4 g), so the friction circle is the limit
  // rather than this number. Much higher and every wheel simply saturates.
  brakeForce: 17000, // N total
  // Front/rear split. Load transfer under braking leaves the rear axle
  // carrying only ~3 kN, so an even split saturates the rear tyres, robs
  // them of all lateral grip and the car spins — which is exactly what
  // happened at 160 km/h before this existed. 0.74 matches the ideal
  // computed from the load transfer above.
  brakeBias: 0.74, // fraction of brake force to the front axle
  brakeCreepSpeed: 0.35, // m/s — below this, brake force tapers to stop creep

  // Reverse is a gear, not a negative throttle. Below reverseSelectSpeed
  // the brake pedal stops meaning "brake" and starts meaning "reverse
  // throttle" — and the throttle becomes the brake. Without that swap the
  // brake input fights the reverse drive and the car can never pull away.
  // Reverse drives all four wheels, forward drives the rear two. That is
  // not how a real car works, but reversing is the recovery case: pinned
  // against a barrier one rear wheel is often completely unloaded and the
  // other is saturated fighting lateral load, so rear-wheel drive is
  // trying to push the car out on a single tyre. Forward drive stays
  // rear-only, so the drift mechanic is unaffected.
  reverseForce: 6500, // N
  reverseMaxSpeed: 12, // m/s (~43 km/h) — reverse should feel slow
  reverseSelectSpeed: 0.6, // m/s below which holding brake selects reverse

  // --- steering -----------------------------------------------------
  maxSteer: 0.55, // rad (~32 degrees)
  steerRate: 4.0, // rad/s — a keyboard is a switch, a wheel is not
  // Tuned between two failures. Too little reduction and 85% stick at
  // speed asks for far more slip than the tyres can give, so the front
  // scrubs. Too much (0.74 over 36 m/s) and the car simply cannot make
  // its own corners — it understeers into the barrier and has no
  // authority left to steer back off it.
  steerSpeedFalloff: 44, // m/s at which steering is reduced by the factor below
  steerSpeedFactor: 0.62, // max reduction at/above the falloff speed
  ackermann: 0.25, // 0 = parallel steering, 1 = full Ackermann

  // --- aero ---------------------------------------------------------
  drag: 0.43, // 0.5 * rho * Cd * A — gives a top speed near 55 m/s
  downforce: 1.2, // N per (m/s)^2 — about 3 kN at 50 m/s
  rollingResistance: 0.015,

  // --- soft walls ---------------------------------------------------
  // The barriers are NOT rigid bodies. Every wall problem so far — being
  // spun by a graze, wedged nose-in, high-centred on a barrier base,
  // beached with the wheels off the ground — came from the same source:
  // rigid contact geometry will always find a way to catch. Assists can
  // only ever treat the symptoms.
  //
  // Instead the track edge is a CONSTRAINT. Beyond the limit the car is
  // moved back to it and its outward velocity is removed, so it slides
  // along losing time. You cannot get stuck on a constraint, because
  // there is nothing to get stuck on.
  softWallScrub: 0.9, // fraction of along-wall speed lost per second
  softWallBite: 0.35, // how much of an impact's inward speed is charged
  softWallYawDamp: 0.86, // per step, only while actually against the wall

  // --- wall contact (legacy: only fires on props, not barriers) ------
  // A glancing hit should cost time, not control. Rapier resolves the
  // collision itself; these only tame what the impulse does to the car's
  // rotation, because a wall strike applied at a corner of the chassis
  // produces a large yaw torque and the car ends up facing backwards.
  // Velocity is split into the part going INTO the wall and the part
  // running ALONG it. Only the first is a mistake, so only the first is
  // charged for — as a one-off hit on contact. Scrubbing continuously
  // instead took a 110 km/h car to 2 km/h just for brushing a barrier.
  // Clamp the spin rate, do not damp it. A per-step multiplier of 0.8 is
  // 0.8^60 per second — it annihilates ALL rotation while touching a
  // wall, including the player's steering, so the car pins itself flat
  // against the barrier and cannot drive off. A clamp leaves normal
  // cornering (0.3-0.5 rad/s) untouched and only removes the violent
  // impact spin (5+ rad/s).
  // Measured: ordinary cornering reaches 4.3 rad/s, impact spins 5-6.
  // The clamp has to sit above the first or it fights the player's own
  // steering every time they brush a barrier mid-corner.
  wallYawClamp: 4.6, // rad/s while in contact with a wall

  // While scraping, actively steer the car's HEADING back toward the
  // direction it is actually travelling. Clamping the yaw rate alone was
  // not enough — it caps how fast the car rotates but not how far, so a
  // 15 degree graze still turned the car 34 degrees. Aligning heading to
  // velocity is what keeps a glancing hit from disorienting the player.
  // Swept against both metrics that matter. Too strong and the assist
  // overpowers the steering — at 30 000 over 0.9 s the car cannot be
  // driven off the wall at all and the lap count halves. Too weak and a
  // 30 degree hit still spins the car 120 degrees. 14 000 over 0.6 s
  // costs nothing in normal driving and takes a 45 degree impact from
  // 108 degrees of spin down to 7.
  wallAlignTorque: 14000, // N.m per radian of heading-vs-velocity error
  wallAlignDamp: 5000, // N.m per rad/s, stops it oscillating
  // An assist must yield to explicit input. Pinned against a barrier the
  // car's velocity runs ALONG the wall, so aligning heading to velocity
  // holds the nose parallel to it and cancels exactly the steering the
  // player is using to get off. At full lock the assist is switched off.
  wallAssistYield: 0.92, // how much full steering input disables the assist

  // A gentle shove away from the wall, but only when nearly stopped. At a
  // shallow nose-in angle, reversing moves the car ALONG the barrier
  // rather than off it — measured 7.5 m of travel for 0.87 m of
  // separation — which reads as being glued to the wall. This fades out
  // with speed so it never affects a fast glancing hit.
  wallPushOff: 3800, // N when not separating at all
  // Fades on how fast the car is moving AWAY from the wall, not on how
  // fast it is moving. Pinned against a barrier the car is often
  // travelling quickly ALONG it while going nowhere away from it — keying
  // the fade on total speed switched the help off in exactly the case
  // that needs it, and facing backwards it never recovered at all.
  wallPushOffSpeed: 3, // m/s of separation at which the push has faded out
  // Margin inside the road edge at which the un-stick starts helping.
  // This does NOT depend on contact detection: a car leaning against a
  // barrier often produces a contact normal too far from horizontal to
  // count as a wall, so the scrape-driven push never fired and nothing
  // helped at all. Position and speed are always known.
  unstickMargin: 0.6, // m inside the road edge before the push engages
  // Pinned against a barrier the front tyres sit at 17-28 degrees of slip
  // — far past the peak — so the steering the player is holding produces
  // almost no yaw and the car tracks the wall for seconds. Translating the
  // car sideways has to beat ~16 kN of tyre grip; ROTATING it does not,
  // so the help is a torque. It only assists a driver already trying to
  // leave: steer into the wall and it stands down.
  // Left at zero. A fixed torque direction cannot be right on both sides
  // of a track, and testing showed the two walls wanted OPPOSITE signs —
  // which was the symptom of a circuit that only turned one way, not
  // something to paper over here. The fix is in the track geometry.
  // Left at zero, and now genuinely unused: the push-off force above is
  // the whole of the wall recovery. A tangent-aimed torque was measured
  // and made no difference to any wedge case, so it is not here.
  unstickTorque: 0, // N.m — retained only so tuning notes still resolve
  // The assist has to outlive the contact. Contact itself lasts a few
  // frames; the spin it started plays out over the second that follows,
  // so correcting only while touching the wall changed almost nothing.
  wallAssistTime: 0.6, // seconds of alignment after the last wall contact

  // Pressed against a wall at an angle, the tyres sit at a huge slip
  // angle and scrub away all the speed — the car stops dead and cannot
  // pull off the barrier. Cutting grip while scraping lets it slide
  // along instead of fighting, which is what a real glancing hit does.
  // 0.75, not 0.45. Halving grip the instant the car touches a barrier
  // is a cliff in the middle of a corner: brush a wall while cornering
  // and the car snaps round. It has to be enough to stop the tyres
  // fighting the wall, and gentle enough not to be its own hazard.
  // Barely reduced, not halved. Grip is what the player steers with, and
  // taking it away while they are trying to peel off a barrier is the
  // difference between a scrape and being glued to it.
  wallGripFactor: 0.9,
  wallImpactScrub: 0.16, // max fraction of along-wall speed lost on impact
  wallImpactRef: 22, // m/s of closing speed that counts as a full-force hit

  // --- accumulated damage ---------------------------------------------
  // Added after the M10 freeze. These are NEW constants, not changes to
  // frozen ones, so nothing already tuned moves.
  //
  // Damage is permanent until repaired. A handicap you simply wait out is
  // not a cost, so recovery is a pickup you have to go and collect —
  // which is a decision, and sometimes the wrong line.
  //
  // There is deliberately NO steering penalty. Steering authority is
  // already reduced at speed (steerSpeedFactor 0.62, itself reverted from
  // a value that made the car unable to make its own corners), and the
  // circuit's tightest corner needs close to full lock. Taking more away
  // can make a corner impossible, which reads as broken rather than hard.
  damageRef: 14, // m/s of closing speed for a full-strength hit
  damageGain: 0.34, // damage added by one reference-strength hit
  damageLanding: 0.16, // damage added by a maximally bad landing
  // Damage does not decay. Repair is a pickup on the road, so recovering
  // costs you a line rather than costing you nothing but patience.
  repairPickup: 0.45, // condition restored by one repair pickup
  boostPickup: 65, // boost charge restored by one speed pickup
  damagePowerLoss: 0.15, // engine force lost at damage = 1. Set to 0 to disable.
  wallSlideScrub: 0.06, // per second, while still rubbing along
  // How horizontal a contact normal must be to count as a wall. 0.55
  // accepted anything more than 33 degrees off vertical, which caught the
  // chassis bottoming out on the road — trimesh edge contacts throw
  // normals like that constantly, and the car spent 60% of a run being
  // "scraped" by the road it was driving on. 0.88 means within 28 degrees
  // of truly horizontal.
  wallMinNormal: 0.88,

  // --- airborne (Level 2) -------------------------------------------
  airPitchTorque: 9000, // N.m
  airRollTorque: 7000, // N.m
  // Airborne stabilisation, as a PD controller rather than a lone spring.
  // P pulls the car back to level, D bleeds off the rotation rate. Pitch
  // and roll are damped hard because a tumble is never wanted; yaw only
  // lightly, because a spin sometimes is.
  autoLevel: 14000, // N.m proportional term toward flat
  airStabilise: 5200, // N.m per rad/s of pitch/roll rate
  airYawDamp: 900, // N.m per rad/s of yaw rate
  // Landing rule. Below badLandingAngle a landing is clean; above it the
  // penalty ramps over badLandingSpread and scrubs up to badLandingScrub
  // of the car's speed. This is Level 2's failure condition, so it has to
  // be forgiving enough to learn and harsh enough to respect.
  badLandingAngle: 0.44, // rad (~25 deg) misalignment before any penalty
  badLandingSpread: 0.5, // rad over which the penalty ramps to full
  badLandingScrub: 0.45, // max fraction of horizontal speed lost

  // --- boost (Level 1) ----------------------------------------------
  // 11 kN on 1200 kg is about 9 m/s^2 on top of whatever the engine is
  // already making — roughly a third of a g, which you feel. At the old
  // 4.5 kN the boost was real but easy to miss.
  boostForce: 6500, // N
  boostCapacity: 100,
  boostFillRate: 40, // per second at full drift
  boostDrainRate: 34, // per second while held (~3 s from full)
  boostPassiveRegen: 7, // per second always — so Shift always does something
  driftMinSpeed: 15, // m/s below which drifting earns nothing
  boostDownforceBonus: 2.2, // multiplier on downforce while boosting
};

// ---------------------------------------------------------------------
// Derived geometry.
//
// The suspension mount height is NOT a free parameter — it follows from
// the ride height you asked for. Get this wrong and the car settles at a
// different centre-of-mass height than comHeight claims, which silently
// changes the rollover threshold and makes the car tip in corners.
//
//   static compression = mg / 4k
//   at rest:  contactY = mountY - (rest + radius - compression) = -comHeight
//   so:       mountY = radius + rest - compression - comHeight
// ---------------------------------------------------------------------
CAR.staticCompression = (CAR.mass * 9.81) / (4 * CAR.springK);

CAR.mountY =
  CAR.wheelRadius + CAR.suspensionRest - CAR.staticCompression - CAR.comHeight;

// Wheel mount points in body-local space, measured from the centre of
// mass. Order is FL, FR, RL, RR — front wheels first, always.
CAR.wheels = [
  { x: -0.8, y: CAR.mountY, z: -1.3, front: true, driven: false },
  { x: 0.8, y: CAR.mountY, z: -1.3, front: true, driven: false },
  { x: -0.8, y: CAR.mountY, z: 1.3, front: false, driven: true },
  { x: 0.8, y: CAR.mountY, z: 1.3, front: false, driven: true },
];

// Sanity values worth knowing when tuning:
//   rolloverThreshold  lateral g at which the inside wheels lift
//   If this drops near muPeak, the car tips instead of sliding.
CAR.rolloverThreshold = 0.8 / CAR.comHeight;

export const WORLD = {
  gravity: { x: 0, y: -9.81, z: 0 },
  fixedDt: 1 / 60,
  maxFrameDt: 0.25, // clamp so a backgrounded tab does not spiral
};
