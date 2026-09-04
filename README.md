# Neon Rush

Three.js + Rapier. Physics and mechanics module — see the design document
for the reasoning behind the architecture.

## Run it

```
npm install
npm run dev
```

## Controls

| Key | Action |
|---|---|
| `W` / `S` | throttle / brake |
| `A` / `D` | steer |
| `S` (held at a stop) | selects reverse — hold it and the car backs up |
| `Space` | handbrake — cuts rear grip, initiates a drift |
| `Shift` | boost (spends drift charge) |
| `C` | cycle camera: chase / cockpit / chase-wide |
| `R` | reset to spawn |
| `G` | toggle the telemetry overlay and force vectors |
| `M` | toggle the minimap |
| `L` | next level: Sprint → Storm Ridge → Neon Circuit → testbed |
| `Esc` | pause / options — quality, assists, mouse look, key rebinding |

In the air, `W`/`S` become pitch and `A`/`D` become roll.

## The three levels

`L` cycles them; `?level=<name>` loads one directly. Difficulty is set by
the tightest corner, checked against the car's real limit — at mu = 1.4
the cornering speed for radius r is sqrt(1.4 * 9.81 * r).

| # | Name | `?level=` | Tightest corner | Field | Mechanic |
|---|---|---|---|---|---|
| 1 | Sprint | `sprint` | 42.9 m — 87 km/h | solo | boost strips |
| 2 | Storm Ridge | `storm` | 34.1 m — 78 km/h | 2 cars | crosswind, updraft, chicanes |
| 3 | Neon Circuit | `circuit` | 27.7 m — 70 km/h | 5 cars | racing |
| — | Testbed | `testbed` | n/a | solo | slalom, crest, ramp |

**Sprint** teaches the boost economy. Boost is earned by drifting and
spent on the straights, and telling a player that in text does not work —
making the fastest line depend on it does. Each strip is 3200 N of
forward push (measured: 3200 on the line, 0 beside it) collected only by
being on the correct side of the road, and they alternate sides so no
single line pays out all the way round.

**Storm Ridge** takes the grip away, using nothing but the Track API —
which is as much the point as the difficulty is. If a hazard cannot be
written as a force field or a registered collider, the API is missing
something, and this level is where that shows up.

- *Crosswind*, peaking at 5200 N (0.44 g). A travelling gust front, not a
  constant push: a constant force is a steering trim you set once and
  forget, while a gust has to be caught, and the front moving means the
  same corner is not always the hard one.
- *Updraft* over the crests. Measured: wheel load falls from 11 772 N to
  2805 N, so the car keeps under a quarter of its weight exactly where it
  is fastest. A DOWNdraft was tried first and is the wrong sign — it
  presses the car down and ADDS grip, an aid dressed as a hazard.
- *Chicane blocks*, real colliders, narrowing the road on the fastest exits.

**Neon Circuit** is the race, and has no hazards at all: with five
opponents the other cars ARE the hazard, and stacking wind on top would
make it impossible to tell whether a spin was your mistake or the level's.
## Where things live

| Path | What |
|---|---|
| `src/vehicle/config.js` | **All tuning constants.** Edit here, not in vehicle.js. |
| `src/vehicle/vehicle.js` | Suspension, tyre model, friction circle, aero, air control |
| `src/vehicle/car-rig.js` | The scene graph — hierarchy and why it is shaped that way |
| `src/vehicle/camera-rig.js` | Chase / cockpit cameras |
| `src/core/input.js` | Keyboard -> control struct (the vehicle never sees a key) |
| `src/track/spline.js` | Arc-length centreline, frames, curvature, projection |
| `src/track/track.js` | Road + runoff + barriers, checkpoints, **level-author API** |
| `src/core/progress.js` | Laps, checkpoints, falling, off-track reset |
| `src/levels/common.js` | Shared level furniture: scatter, gantry, markers, `polarPoints` |
| `src/levels/sprint.js` | Level 1 — wide and fast, boost strips |
| `src/levels/storm.js` | Level 2 — crosswind, updraft, chicanes |
| `src/levels/circuit.js` | Level 3 — the race. First Track consumer |
| `src/levels/testbed.js` | Tuning testbed: slalom, crest, ramp, barriers |
| `src/core/race.js` | The field: every car, grid, slipstream, standings, respawn |
| `src/ai/driver.js` | Opponent controllers and personalities |
| `src/core/determinism.js` | Replay, ghost recordings, **the physics test harness** |
| `src/core/save.js` | Settings and records in localStorage (never throws) |
| `src/ui/menu.js` | Pause and options: quality, assists, key rebinding |
| `src/ui/minimap.js` | Orthographic second camera in a scissored corner |
| `src/debug/overlay.js` | Telemetry and force vectors |
| `assets/credits.json` | **Append the moment anything enters the repo.** |

## The two interfaces

Everything else in the game talks to the vehicle through exactly two things.
Do not reach past them — the fallback to Rapier's own vehicle controller
depends on these staying the only contact surface.

**In:** `vehicle.step(dt, controls)` where controls is
`{throttle, brake, steer, handbrake, boost, pitch, roll}`.
The player, the Level 3 AI and a recorded replay all produce this struct.

**Out:** `vehicle.state` — position, quaternion, speed, grounded,
steerAngle, driftFactor, boostCharge, boosting, and per wheel
`{compression, spinAngle, slipAngle, load, gripUsed, grounded}`.

## The track API (for level authors)

Never call Rapier directly — go through the track, so the physics backend
stays swappable:

```js
const id = track.registerCollider(s0, s1, colliderDesc, { position, mesh });
track.removeCollider(id);                   // Level 2's collapsing deck
track.addForceField(s0, s1, ctx => force);  // Level 2's crosswind
track.project(worldPos, sHint);             // -> { s, t, distance }
track.frameAt(s);                           // position, tangent, right, up
track.cornerSpeedAt(s);                     // sqrt(mu*g/kappa) — Level 3 AI
```

`s` (metres along the centreline) drives lap timing, race position, the
minimap, checkpoints, hazard triggers, respawn and AI lookahead. Always
pass `sHint` on the hot path — it makes projection O(1).

## Tuning

Open the console and use `__dbg`:

```js
__dbg.CAR.antiRoll = 20000    // live, no reload
__dbg.CAR.muPeak = 1.6        // grip
__dbg.CAR.brakeForce = 20000  // stopping power
__dbg.CAR.brakeBias = 0.7     // <0.7 gets tail-happy under braking
__dbg.CAR.boostForce = 14000  // how hard Shift shoves
__dbg.CAR.airStabilise = 7000 // how hard the car refuses to tumble
__dbg.CAR.wallAlignTorque = 14000 // how hard a wall hit is straightened out
__dbg.CAR.wallImpactScrub = 0.16  // speed lost on a wall hit
__dbg.CAR.muSlide = 1.2           // grip once a tyre is past its peak
__dbg.CAR.wallPushOff = 3800      // shove off the wall at low speed
__dbg.CAR.wallAssistYield = 0.92  // how much steering overrides the assist
__dbg.vehicle.body.translation()
```

Watch the friction circle bars in the overlay. All four near full through a
corner means the car is at its limit and the balance is right. One pinned at
full with another near empty is a load transfer problem.

## Things that bit us already

- **Rapier's force accumulator is persistent.** `addForce` keeps applying
  every step until `resetForces()`. Not clearing it launched the car into
  orbit. Cleared at the top of `Vehicle.step()`.
- **Suspension mount height is derived, not chosen.** It follows from
  `comHeight`; setting it by hand made the car ride 0.7 m high, which
  dropped the rollover threshold below tyre grip and made it tip in every
  corner instead of sliding.
- **Anti-roll signs.** Reversed, the bar adds roll instead of removing it,
  and reads as a mysteriously tippy car rather than an obvious bug.
- **Auto-level signs.** Turning vector `a` toward `b` needs a torque along
  `a x b`. Negated, the airborne "assist" rotated the car *away* from
  level and turned every jump into a tumble.
- **Brake bias is not optional.** Load transfer leaves the rear axle
  carrying ~3 kN under heavy braking, so an even four-way split saturates
  the rear tyres, strips their lateral grip and spins the car. 0.74 to the
  front is the value the load transfer maths gives.
- **Reverse is a gear, not negative throttle.** The pedal that brakes has
  to swap with the gear, or the brake input fights the reverse drive and
  the car never pulls away.
- **Barrier panels must be sized from the measured gap.** Posts follow the
  centreline but sit 9 m outside it, so around a corner their spacing
  stretches by the radius ratio. Fixed-length panels left a 1.8 m hole and
  the car is 1.7 m wide.
- **Hand-placed control points kinked the loop closed.** The tightest
  corner on the track landed on the start/finish line at 7.3 m radius.
  Generating points from a periodic radius function is smooth at the seam
  by construction.
- **A lateral shove cannot beat tyre grip.** The push-off that frees a
  stopped car is ~4 kN; the tyres resist sideways motion with up to 16 kN.
  Against a wall facing backwards the car drives happily ALONG the barrier
  at 47 km/h and no amount of pushing moves it off. That case needs a
  reset, not a nudge — which is why the backstop measures progress along
  the track rather than speed. It is the only test that catches a car
  going the wrong way.
- **Getting off a wall is its own problem.** Pinned at a shallow angle,
  reversing moves the car ALONG the barrier, not away from it — 7.5 m of
  travel bought 0.87 m of separation. Rear-wheel drive made it worse: one
  rear wheel is usually unloaded against a wall and the other is saturated
  fighting lateral load, so reverse drives all four wheels. There is also
  a low-speed push toward the centreline, and its direction comes from the
  sign of the car's lateral offset — Rapier's manifold normal points
  inconsistently between contacts and a fixed sign pushed away from the
  wall going forward and into it in reverse.
- **An assist strong enough to save you is strong enough to trap you.**
  Two separate versions of the wall-impact helper removed the player's
  steering entirely: a 0.80-per-step angular damp (10^-6 per second) and a
  30 000 N.m alignment torque. Both stopped the car spinning and both made
  it impossible to drive off the barrier. Assists need sweeping against
  normal driving, not just against the failure they target.
- **Recovery needs a general backstop, not more special cases.** Off-track,
  beached and pinned each cover one way of getting stuck; the car then
  high-centred on a barrier base — on the road, grounded, not scraping —
  which was none of them. Measuring "has the car stopped going anywhere"
  catches every case whatever the cause.
- **Switching levels leaked the old level into the new one.** Removing a
  mesh from the scene does not remove its rigid body, and the testbed
  created 16 bodies plus 4 meshes that nothing tracked. Two visits and
  the next level was being driven through a set of invisible walls; the
  count grew without bound (7 colliders fresh, 23 after one testbed
  visit, 39 after two). A level with a `Track` is cleaned up by
  `track.dispose()`; one without needs its own `dispose()`, and every
  `scene.add` needs a matching entry in `statics`.
- **`race.dispose()` is a no-op for a track-less level**, which builds a
  bare `Vehicle` instead of a `Race` — so that car's body survived every
  switch, one solid invisible car per visit accumulating at the spawn.
  Regression test: load every level twenty times and assert the collider
  and scene-child counts come back to what a fresh page gives.
- **A warning you cannot see is not a warning.** Storm's wind socks were
  placed 3 m up against a 3.2 m barrier, so they sat behind exactly the
  thing the driver looks past. Screenshot the level; do not assume that
  because an object was added it can be seen.
- **"An invisible wall that eats the whole field" was a respawn bug.**
  Reported as all cars stopping near s=999 and respawning forever. The
  barrier geometry was innocent: every vertex sits at |lateral| >= 9.39
  against a 9.4 limit, and the car's own outermost corner measured 9.39
  while yawed 137 degrees to the track. It had spun and jammed corner-
  first into a wall that was exactly where it belonged.
  Two things then kept it there. `markProgressFrom()` reset the progress
  backstop but never moved `lastCheckpoint`, so a car anywhere on the
  track still respawned to checkpoint 0 — the START LINE, a full lap
  back. And when several cars piled onto one checkpoint, `#clearRespawn`
  gave up after five rows and dropped them inside each other, which
  wedged them and triggered the next respawn immediately. Measure where
  a respawn actually LANDS, not just that one happened.
- **A recovery assist that fires 0.3% of the time is not dead code.**
  `#unstick` applied the 3800 N wall push-off — the only force that
  peeled a pinned car off a barrier. It was deleted during a cleanup on
  the grounds that it rarely fired. Rarely firing is what a safety net
  does. Check who calls a constant before removing its only caller:
  `wallPushOff` and `unstickMargin` sat in config referenced by nothing.
- **A/B self-comparison cannot catch a wrong timestep.** The determinism
  harness ran both of its runs through the same code, so a dt error
  appeared in both identically and cancelled. Feeding it a deliberately
  broken dt — the exact bug it existed to find — it reported a pass at
  every jitter amplitude up to 40%, and at a flat wrong 50 Hz. A test
  that cannot fail is not evidence.
- **Controls were ramped on the render frame, not the fixed step.**
  `Input.update()` moves throttle and steer toward their targets at a
  rate per second, and it was called once per rendered frame while
  physics ran at 60 Hz. At 144 fps most of those values never reached a
  step; at 30 fps each reached two. Same keystrokes, measurably different
  drive — 0.108 of control travel between 30 and 144 fps — and a replay
  recorded on one machine would not reproduce on another. Ramp inside the
  fixed step.
- **`grounded` is not the same as "touching the ground".** Pitched past
  ~45 degrees the suspension rays miss entirely while the chassis rests on
  the road: no wheel contact, no tyre forces, no landing detected, and no
  way for the player to drive out. Ask the physics world for chassis
  contacts as well.

## The ghost car

Your best lap, replayed alongside you. The recording is six bytes of
CONTROLS per frame (a 50 s lap is about 17 KB), not a list of positions —
so the ghost is only in the right place because the simulation reproduces
exactly from the same inputs. That is what the determinism harness is
for; see **Testing the physics**.

It shares the track but cannot race. It has to meet the same barriers the
recording met, so it is not a sensor; what it must never do is touch
another car, because a ghost that shoves the player is worse than no
ghost. That separation is Rapier interaction groups set in `Vehicle`,
applied to the chassis collider AND to the suspension raycasts — without
the second one a real car's wheel rays land on the ghost's chassis and it
drives over a rival it cannot collide with. Verified: player and ghost
pass through the same point with zero contacts and no acceleration spike.

**Replay is enabled only on levels with no opponents.** A lap driven in
traffic was shaped by slipstream and by contact with cars the ghost
cannot touch, so the replay meets a different world than the recording
did. Measured: on the six-car circuit a lap that covered 1248 m replayed
to 769 m and stopped against a barrier; the same recording on the solo
level replays the full 1338 m and finishes 2.75 m from the line. The best
lap TIME is still recorded everywhere — it is real whatever the traffic
did — but the car is only drawn where the replay is faithful. Showing a
drifting ghost labelled as your best lap would be showing a lap nobody
drove.

Records are stored per level. One global best lap would replay a Sprint
ghost on the Circuit, straight through a barrier.
## Testing the physics

`src/core/determinism.js` holds two checks. Run them from the console:

```js
const d = window.__dbg, det = await d.determinism();
det.verifyFrameRateIndependence(d.input);          // fast, no setup
```

**`verifyFrameRateIndependence`** holds the same keys down and drives a
real `Input` through a real accumulator at 30, 60 and 144 fps, comparing
the control values that actually reached a fixed step. It must report a
`worstControlDelta` of exactly 0.

**`verifyDeterminism(vehicle, world, recording)`** replays a recorded
control sequence from a captured state and checks the car lands in the
same place. Two things about it are worth knowing before you trust it:

- It runs **three** times and discards the first. `restoreState` puts the
  car back but cannot put the *world* back — Rapier keeps warm-start
  impulses and contact history that no API exposes. That leaves a floor
  of roughly 0.4 mm of scatter over 25 s, and re-running never removes
  it. The tolerance is set above that floor deliberately, not tightened
  to a number that only looks rigorous.
- It compares two runs **in one process**, so it catches genuine
  nondeterminism (uninitialised scratch, iteration order) but *cannot*
  catch a step that is merely wrong. A dt bug reproduces perfectly
  against itself, so A/B self-comparison cancels it out — verified by
  feeding it a deliberately jittered dt, which it passed. That is what
  the frame-rate check above is for; between them they cover both.

## Deployment (LAMP)

`npm run build`, then upload `dist/`. `vite.config.js` sets `base: "./"`
because the game is served from `/~student/neon-rush/`, not a domain root.

**Filenames must be lowercase-with-hyphens.** Ubuntu is case-sensitive:
`Car.glb` works on every laptop in the team and 404s on the server.
#   n e o n - r u s h 
 
 
