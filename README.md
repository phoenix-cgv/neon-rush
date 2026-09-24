# Getting started — Neon Rush

For anyone joining the project. Read §1 and §2 before you write code; the
rest is reference you can come back to when you need it.

Neon Rush is a 3D racing game in **Three.js** with **Rapier** for physics,
built with **Vite**. The vehicle dynamics are ours — Rapier supplies
collision detection, rigid-body integration and raycasts, and nothing
else. The design document has the reasoning; this file has the practice.

---

## 1. Run it

You need **Node 20.19+ or 22.12+** — that is Vite 7's requirement, not a
preference, and Node 18 fails at install. Developed on Node 22.23 / npm 12.
Check with `node -v` before anything else.

```bash
git clone https://github.com/phoenix-cgv/neon-rush.git
cd neon-rush
npm install
npm run dev
```

Open http://localhost:5173. You should be sitting on the start line of
the **City Track** with the engine idling. If you see a black screen, open the
browser console first — the game logs nothing on a healthy boot, so
anything there is the problem.

```bash
npm run build      # production build into dist/
npm run preview    # serve dist/ locally, to check the real build
```

---

## 2. Drive it

Spend five minutes actually driving before changing anything. Most of the
design decisions in here only make sense once you have felt the car.

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
| `G` | telemetry overlay (the condition bar follows `Save.healthBar`) |
| `L` | next level: City Track → Mountain Track → Grand Prix (the tuning testbed is `?level=testbed`) |
| `Esc` | pause / options — quality, assists, mouse look, key rebinding |

In the air, `W`/`S` become pitch and `A`/`D` become roll.

Press `G` and look at the **friction circle** bars while you corner. All
four near full means the car is at its limit and the balance is right. One
pinned at full with another near empty is a load-transfer problem. That
readout is the fastest way to understand what the physics is doing.

---

## 3. Find your way around

Start from the thing you have been asked to work on.

| I am working on… | Start here |
|---|---|
| A new level or map | `src/levels/glb-map.js`, then copy `city.js` (§5) |
| Hazards and obstacles | `src/track/track.js` — the level-author API (§5) |
| Car handling / feel | `src/vehicle/config.js` — **constants only, see §6** |
| Opponent behaviour | `src/ai/driver.js` |
| HUD, menus, minimap | `src/ui/`, `src/debug/overlay.js` |
| Anything touching the loop | `src/main.js` |

Full map:

| Path | What |
|---|---|
| `src/vehicle/config.js` | **All tuning constants.** Edit here, not in vehicle.js |
| `src/vehicle/vehicle.js` | Suspension, tyre model, friction circle, aero, air control |
| `src/vehicle/car-rig.js` | The car's scene graph — hierarchy and why it is shaped that way |
| `src/vehicle/camera-rig.js` | Chase / cockpit / wide cameras |
| `src/core/input.js` | Keyboard → control struct (the vehicle never sees a key) |
| `src/track/spline.js` | Arc-length centreline, frames, curvature, projection |
| `src/track/track.js` | Road + runoff + barriers, checkpoints, **level-author API** |
| `src/core/progress.js` | Laps, checkpoints, falling, off-track reset |
| `src/core/race.js` | The field: every car, grid, slipstream, standings, respawn |
| `src/core/traffic.js` | Civilian traffic: kinematic cars that keep left, both ways |
| `src/core/race-director.js` | Start lights, lap limit, finishing order (levels with `race: { laps }`) |
| `src/core/determinism.js` | Replay recordings, **the physics test harness** |
| `src/core/save.js` | Settings and records in localStorage (never throws) |
| `src/ai/driver.js` | Opponent controllers and personalities |
| `src/levels/glb-map.js` | Modelled maps: .glb → merged meshes + Track (centreline, colliders) |
| `src/levels/city.js` | Level 1 — City Track (`assets/maps/CityTrack.glb`) |
| `src/levels/mountain.js` | Level 2 — Mountain Track (`assets/maps/MountainTrack.glb`) |
| `src/levels/grandprix.js` | Level 3 — Grand Prix (`assets/maps/GrandPrix.glb`) |
| `src/levels/armco.js` | Visual steel barrier along the track edge, where a soft wall bites |
| `src/levels/testbed.js` | Tuning testbed (development only): slalom, crest, ramp, barriers |
| `src/ui/menu.js` | Pause and options: quality, assists, key rebinding |
| `src/ui/minimap.js` | Orthographic second camera in a scissored corner |
| `src/ui/race-hud.js` | Race display: start lights, lap / position / time, results |
| `src/debug/overlay.js` | Telemetry and force vectors |
| `assets/credits.json` | **Append the moment anything enters the repo** |

---

## 4. The rules that are not negotiable

Four conventions hold the codebase together. Breaking one does not fail
loudly — it fails three weeks later in someone else's module.

**1. Talk to the vehicle through two interfaces only.**

```js
// IN — the vehicle never reads a keyboard
vehicle.step(dt, { throttle, brake, steer, handbrake, boost, pitch, roll });

// OUT — everything else reads this and nothing else
vehicle.state; // position, quaternion, speed, grounded, steerAngle,
               // driftFactor, boostCharge, boosting, and per wheel:
               // { compression, spinAngle, slipAngle, load, gripUsed, grounded }
```

The player, the AI and a recorded replay all produce that same struct.
That is why opponents and recorded replays cost no extra vehicle code, and
why the physics backend stays swappable.

**2. Never call Rapier directly from a level.** Go through the track (§5).

**3. Never simulate on the render frame.** Physics runs at a fixed 60 Hz;
the variable frame time reaches only interpolation and the camera. If you
find yourself writing `dt` from `requestAnimationFrame` into anything that
affects the car, stop — see the ramping entry in §8.

**4. Append to `assets/credits.json` the moment anything enters the repo.**
Models, textures, audio, a snippet you learned from. Reconstructing this
in the last week is how a team ends up guessing, and a guess is what turns
properly credited work into a plagiarism question.

---

## 5. Adding a level or a hazard

The game has three levels, all maps modelled in Blender: City Track,
Mountain Track and Grand Prix, in that order. A level is a function that
returns a description. To add one, export the map to `assets/maps/`, copy
`src/levels/city.js`, and register it in the `LEVELS` map and `ORDER`
array in `src/main.js`. Anything in `LEVELS` but not in `ORDER` (like the
testbed) can still be opened with `?level=name` but is not in the `L`
cycle.

`Track` can also sweep a road from a list of control points instead of a
model (the original procedural levels did; they are in git history). If
you do that, generate the points from a smooth periodic function rather
than placing them by hand: hand-placed points closed the loop with a kink
and put a 7.3 m-radius corner on the start/finish line, which no car can
take.

The level-author API:

```js
const id = track.registerCollider(s0, s1, colliderDesc, { position, mesh });
track.removeCollider(id);                   // a collapsing deck
track.addForceField(s0, s1, ctx => force);  // crosswind, boost strips, updraft
track.project(worldPos, sHint);             // -> { s, t, distance }
track.frameAt(s);                           // position, tangent, right, up
track.curvatureAt(s);                       // 1 / radius
track.cornerSpeedAt(s);                     // sqrt(mu*g/kappa) — used by the AI
```

`s` (metres along the centreline) drives lap timing, race position, the
minimap, checkpoints, hazard triggers, respawn and AI lookahead. Always
pass `sHint` on the hot path — it makes projection O(1).

**Check your corners are drivable.** At mu = 1.4 the maximum cornering
speed for radius r is `sqrt(1.4 * 9.81 * r)`; the car cannot turn tighter
than about 4.2 m at full lock. The three levels:

| # | Name | `?level=` | Tightest corner | Field | Mechanic |
|---|---|---|---|---|---|
| 1 | City Track | `city` | 15.3 m — 51 km/h | solo | live two-way traffic (`src/core/traffic.js`) |
| 2 | Mountain Track | `mountain` | 15.1 m, banked 13° — 51 km/h | solo | banked climb, guardrails, tunnel |
| 3 | Grand Prix | `grandprix` | 16.2 m — 54 km/h | 6 cars | 3-lap race: start lights, results; grass costs grip; hills, banking, esses |
| — | Testbed (development only) | `testbed` | n/a | solo | slalom, crest, ramp |

**The maps are modelled, not generated.** All three are Blender exports
in `assets/maps/`, turned into a Track by
`src/levels/glb-map.js`. The contract with the modeller is one road mesh
(`Road` unless the level names another): a single closed ribbon with its
vertices in left/right pairs along the lap (flat-shaded exports that
duplicate each vertex are detected, but **smooth-shade the road before
exporting**: a flat-shaded export merges the duplicate wherever two
neighbouring faces are exactly coplanar, and every pair after that is
off by one). The centreline, `s`, the width, the start line (first pair) and
the direction of travel (pair order) are all recovered from it, so
checkpoints, AI, pickups and minimap work unchanged. Things to know:

- The level lists which meshes are drivable (`surfaces`, trimesh colliders
  made from the same vertices that are drawn) and which are solid
  (`solid`, oriented boxes). Everything else is visual only.
- Walls are **soft** (`wallLimit`), not barrier geometry: the city's
  hairpins are tighter than half the road width, and a swept barrier
  crumples on the inside of them.
- Meshes are merged per material at load (3339 and 4124 nodes → a few
  dozen draw calls). Re-export freely; nothing is hand-placed in code.
- A material exported without a colour renders white — fix it in
  Blender or with `materialColors` in the level.
- Banking is read from the ribbon and `cornerSpeedAt` accounts for it.
  **Check the sign of the tilt**: the first Mountain Track export leaned
  every corner the wrong way (inside edge higher), which halves the grip
  in the hairpins and slides cars into the rails. The Mountain Track is
  now generated by `blender/mountain/mountain_track.py`, and
  `blender/mountain/check_mountain.py` checks banking, start area, kerbs,
  rails, tunnel and terrain clearance before an export.
- Real barriers go in `walls` (collide as their own mesh) with
  `softWalls: false`, as on the Mountain Track (guardrails and
  `Tunnel_Wall`).
- three.js turns spaces in names into underscores: match `Guardrail_Left`,
  not `Guardrail Left`.

Two lessons from the old Storm Ridge level (removed; it is in git
history) for anyone building a hazard:

- **Make the invisible visible.** The crosswind has wind socks standing in
  it, leaning downwind. A player shoved sideways by nothing reads it as a
  physics bug, not as weather.
- **Check the sign of your force.** A *downdraft* over a crest presses the
  car into the road and *adds* grip — an aid dressed as a hazard. The
  updraft (which removes 76% of the car's weight at the crest) is the one
  that actually punishes arriving too fast.

**Clean up after yourself.** A level with a `Track` is disposed by
`track.dispose()`. A level without one must return its own `dispose()`,
and every `scene.add` needs a matching entry in `statics` — removing a
mesh from the scene does **not** remove its rigid body. See §8.

---

## 6. Tuning the car

`src/vehicle/config.js` is **frozen** as of the M10 pass. The handling is
signed off and validated, so changing a value there now re-tunes every
level at once and invalidates stored replay recordings. If you need
different handling for one level, ask for a per-level override rather than
editing the file.

To experiment live, use `__dbg` in the console — no reload needed:

```js
__dbg.CAR.antiRoll = 20000        // roll stiffness / balance
__dbg.CAR.muPeak = 1.6            // grip
__dbg.CAR.brakeForce = 20000      // stopping power
__dbg.CAR.brakeBias = 0.7         // below ~0.7 gets tail-happy under braking
__dbg.CAR.boostForce = 14000      // how hard Shift shoves
__dbg.CAR.airStabilise = 7000     // how hard the car refuses to tumble
__dbg.CAR.muSlide = 1.2           // grip once a tyre is past its peak
__dbg.CAR.wallAlignTorque = 14000 // how hard a wall hit is straightened out
__dbg.CAR.wallImpactScrub = 0.16  // speed lost on a wall hit
__dbg.CAR.wallPushOff = 3800      // shove off the wall at low speed
__dbg.vehicle.body.translation()
```

`__dbg` also exposes `THREE`, `RAPIER`, `world`, `scene`, `level`, `race`,
`traffic`, `minimap`, `menu`, `Save`, `input` and `loadLevel(name)`.

---

## 7. Testing the physics

`src/core/determinism.js` holds two checks. Run them from the console:

```js
const d = window.__dbg, det = await d.determinism();
det.verifyFrameRateIndependence(d.input);   // fast, no setup
```

**`verifyFrameRateIndependence`** holds the same keys down and drives a
real `Input` through a real accumulator at 30, 60 and 144 fps, comparing
the control values that actually reached a fixed step. It must report a
`worstControlDelta` of exactly **0**.

**`verifyDeterminism(vehicle, world, recording)`** replays a recorded
control sequence from a captured state and checks the car lands in the
same place. Two things are worth knowing before you trust it:

- It runs **three** times and discards the first. `restoreState` puts the
  car back but cannot put the *world* back — Rapier keeps warm-start
  impulses and contact history that no API exposes. That leaves a floor of
  roughly 0.4 mm of scatter over 25 s, and re-running never removes it.
  The tolerance sits above that floor deliberately, rather than being
  tightened to a number that only looks rigorous.
- It compares two runs **in one process**, so it catches genuine
  nondeterminism but *cannot* catch a step that is merely wrong. A dt bug
  reproduces perfectly against itself and cancels out — verified by
  feeding it a deliberately broken dt, which it passed. That is what the
  frame-rate check is for; between them they cover both.

**Before you push a change that touches level loading**, load every level
twenty times and check the collider and scene-child counts return to what
a fresh page gives. That regression exists because of two real leaks (§8).

---

## 8. Read this before you spend a day debugging

Every entry below cost someone hours. They are ordered roughly by how
likely you are to hit them.

### Physics engine

- **Rapier's force accumulator is persistent.** `addForce` keeps applying
  every step until `resetForces()`. Not clearing it launched the car into
  orbit. Cleared at the top of `Vehicle.step()`.
- **`grounded` is not the same as "touching the ground".** Pitched past
  ~45°, the suspension rays miss entirely while the chassis rests on the
  road: no wheel contact, no tyre forces, no landing detected, and no way
  to drive out. Ask the physics world for chassis contacts as well.
- **`contactPairsWith` iterates broad-phase candidates, not actual
  touches.** Filter on `numContacts() > 0`, or the road trimesh — whose
  bounding volume spans the whole circuit — counts as touching you
  permanently.

### The car

- **Suspension mount height is derived, not chosen.** It follows from
  `comHeight`. Setting it by hand made the car ride 0.7 m high, dropping
  the rollover threshold below tyre grip so it tipped in every corner
  instead of sliding.
- **Anti-roll signs.** Reversed, the bar adds roll instead of removing it,
  and reads as a mysteriously tippy car rather than an obvious bug.
- **Auto-level signs.** Turning vector `a` toward `b` needs a torque along
  `a × b`. Negated, the airborne "assist" rotated the car *away* from level
  and turned every jump into a tumble.
- **Brake bias is not optional.** Load transfer leaves the rear axle
  carrying ~3 kN under heavy braking, so an even four-way split saturates
  the rear tyres, strips their lateral grip and spins the car. 0.74 front
  is what the load-transfer maths gives.
- **Reverse is a gear, not negative throttle.** The braking pedal has to
  swap with the gear, or the brake input fights the reverse drive and the
  car never pulls away.

### Walls, sticking and recovery

- **A lateral shove cannot beat tyre grip.** The push-off that frees a
  stopped car is ~4 kN; the tyres resist sideways motion with up to 16 kN.
  Facing backwards against a wall, the car drives happily *along* the
  barrier at 47 km/h and no amount of pushing moves it off. That case needs
  a reset, not a nudge — which is why the backstop measures progress along
  the track rather than speed. It is the only test that catches a car going
  the wrong way.
- **An assist strong enough to save you is strong enough to trap you.**
  Two versions of the wall helper removed the player's steering entirely: a
  0.80-per-step angular damp (10⁻⁶ per second) and a 30 000 N·m alignment
  torque. Both stopped the spin and both made it impossible to drive off
  the barrier. Sweep assists against *normal* driving, not just against the
  failure they target.
- **A recovery assist that fires 0.3% of the time is not dead code.**
  `#unstick` applied the 3800 N wall push-off — the only force that peeled
  a pinned car off a barrier — and was deleted in a cleanup for firing
  rarely. Firing rarely is what a safety net does. Check who reads a
  constant before removing its only caller.
- **"An invisible wall that eats the whole field" was a respawn bug.**
  Reported as all cars stopping near s=999 and respawning forever. The
  barrier was innocent: every vertex sits at |lateral| ≥ 9.39 against a 9.4
  limit, and the car's own outermost corner measured 9.39 while yawed 137°
  — it had spun and jammed corner-first into a wall exactly where it
  belonged. Then `markProgressFrom()` reset the backstop but never moved
  `lastCheckpoint`, so the car respawned to checkpoint 0 — the **start
  line**, a full lap back — and `#clearRespawn` gave up after five rows and
  dropped cars inside each other. **Measure where a respawn actually lands,
  not just that one happened.**

### Loop and lifetime

- **Controls were ramped on the render frame, not the fixed step.**
  `Input.update()` moves throttle and steer toward their targets at a rate
  per second, and was called once per rendered frame while physics ran at
  60 Hz. At 144 fps most values never reached a step; at 30 fps each
  reached two. Same keystrokes, measurably different drive — 0.108 of
  control travel between 30 and 144 fps.
- **Switching levels leaked the old level into the new one.** Removing a
  mesh from the scene does not remove its rigid body. The testbed created
  16 bodies plus 4 meshes that nothing tracked: 7 colliders fresh, 23 after
  one visit, 39 after two — and those bodies are still *solid*, so the next
  level was driven through invisible walls.
- **`race.dispose()` is a no-op for a track-less level**, which builds a
  bare `Vehicle` instead of a `Race` — one solid invisible car per visit,
  accumulating at the spawn.

### Levels and geometry

- **Hand-placed control points kinked the loop closed** — see §5.
- **Barrier panels must be sized from the measured gap.** Posts follow the
  centreline but sit 9 m outside it, so around a corner their spacing
  stretches by the radius ratio. Fixed-length panels left a 1.8 m hole; the
  car is 1.7 m wide.
- **A warning you cannot see is not a warning.** Storm's wind socks were
  placed 3 m up against a 3.2 m barrier, sitting behind exactly the thing
  the driver looks past. Screenshot the level; do not assume that because
  an object was added it can be seen.

### Performance

- **A light at zero intensity is not free.** Twelve headlight SpotLights
  were built up front at intensity 0, waiting for a night level. three.js
  does not care that a light is dark: every light is uniform data and a
  loop iteration in *every* lit material's fragment shader. They cost
  2.95 ms of a 12.4 ms render pass — a quarter of the frame on lights that
  emitted nothing. Build lights on demand.
- **Authoring granularity is not drawing granularity.** The car is modelled
  as 38 separate boxes and cylinders carrying 936 triangles between them —
  about 25 triangles a draw call. That is the right way to *author* it and
  the wrong way to *draw* it: six cars were 228 of the scene's 253 meshes
  and over half the render pass. Merging by material at build time took
  draw calls from 356 to 170 and meshes per car from 38 to 14, with no
  visual change. Profile draw calls before triangles.
- **Merging changes material arity, and three.js is unforgiving about it.**
  An array material is drawn per geometry group; merged geometries have
  their groups cleared, so wrapping a single material in an array renders
  *nothing*. That silently made the ghost car invisible.
- **`renderer.info.render` resets on every `render()` call.** Reading it
  after a timing loop gives you the last frame drawn, not the one you
  meant — which is how a draw-call count of 44 turned out to be the
  cars-hidden figure.
### Testing

- **A/B self-comparison cannot catch a wrong timestep** — see §7. A test
  that cannot fail is not evidence.

---

## 9. Crash damage

Hit things and the car gets scruffier and slower. Damage is `0..1`, lives
on the vehicle, and is published in `vehicle.state.damage`.

- **Earned** by every kind of crash, through one formula (`#takeHit` in
  `vehicle.js`): solid walls and guardrails, the **soft wall** at a
  modelled map's edge, **other cars** (each car is charged for how hard it
  was stopped, so a two-car hit is shared), traffic, and a bad landing.
  A continuous scrape does *not* keep adding damage — only a new contact
  does, or brushing a barrier for a second would total the car.
- **Measured over the first 8 steps of a contact** (`IMPACT_STEPS`), as the
  speed the car lost toward the obstacle. Rapier creates contacts slightly
  before bodies meet, and resolves the impact inside `world.step()`, so
  reading one step at contact scored the same crash 0.06 one time and 0.34
  the next. Also: Rapier can report a contact pair the other way round —
  honour `flipped`, or the wall normal points away from the wall.
- **Permanent until repaired.** Damage does not decay. A handicap you wait
  out costs patience rather than skill; repair is a green orb on the road,
  so recovering costs you a line — and the orbs are deliberately off the
  racing line, which makes taking one a decision rather than a gift.
- **Costs power only.** At `damage = 1` the engine loses 15%
  (`damagePowerLoss`). Grip and steering are untouched, so the car still
  handles predictably and the penalty is paid in lap time.
- **No steering penalty, deliberately.** Steering authority is already cut
  at speed (`steerSpeedFactor` 0.62, itself reverted from a value that made
  the car unable to make its own corners), and the circuit's tightest
  corner needs close to full lock. Taking more away can make a corner
  *impossible*, which reads as broken rather than hard.

### What you see

Three cues, because one is never enough at chase-camera distance:

- **Scratches.** Each car owns a 256² canvas used as the body's colour
  map. It starts as flat paint, and every impact draws a burst of gouges
  into it — a dark streak with a light edge, so it reads as bare metal
  rather than dirt. They are cumulative, and because three multiplies map
  by colour they keep working as the paint darkens. Every car ends up
  scarred differently.
- **Rounded panels.** The painted surfaces are filleted boxes, not boxes:
  every vertex is clamped into the shape shrunk by the corner radius and
  pushed back out to exactly that radius, so flat faces stay flat while
  edges become quarter-cylinders. This is a DAMAGE decision as much as a
  styling one — on a flat panel a dent barely changes the shading, because
  the normal was constant and stays roughly constant; on a curved one it
  breaks the highlight running along the flank, which the eye catches
  immediately. Body panels use `BODY_SEG = 6` (1764 vertices) so there is
  something to round with and something to bend.
- **Dents.** Real vertex deformation. The vehicle publishes the contact
  normal in the car's own frame (`state.impactLocal`), so the dent lands on
  the panel that actually met the wall — a side-on hit creases the flank, a
  nose-on hit folds the nose. Body panels are subdivided (`SEG = 3`, 576
  specifically so there is something to bend: a 24-vertex box can
  only fold at its corners. Subdividing costs triangles, which is the
  resource this car has most of, and does not change draw calls at all.
- **Dead headlights** past a third damage. The one cue that still reads at
  distance, and the only one that works in a dark level.

The shell is always drawn as `pristine + dentField × shown`, never eased
toward pristine in place. That matters: driven by the frame-to-frame change
in damage, a respawn that zeroed damage in one step unbent the car once and
stopped, leaving **0.064 m of permanent crease**. Chasing a target
converges by construction. Once the car is genuinely clean the dent field
is forgotten too, or the first light knock after a respawn would restore
every dent the car ever had.

### Pickups

`src/core/pickups.js`. Levels opt in with a `pickups: { repair, boost }`
count in their returned description.

| Orb | Effect | Constant |
|---|---|---|
| Green | Repairs `0.45` of condition | `CAR.repairPickup` |
| Blue | Restores `65` boost charge | `CAR.boostPickup` |

Placed in TRACK space (`s` along the centreline plus a lateral offset),
not world space — the same coordinate everything else here uses, so they
survive a change to the spline instead of needing re-authoring. They
alternate sides and sit 2.6–4.4 m off centre, because an orb on the
racing line is a free gift and one a metre off it is a choice.

Collection is a proximity test in that same space, not a sensor collider.
A sensor would be woken, broad-phased and solved by Rapier every step for
something that is two subtractions and a compare, and it would need
collision groups to stop the ghost car collecting orbs it cannot see. They
return after 12 s, so a second lap is not a barren one, and only the field
collects them — a replay must not change the world it is replaying into.

Two InstancedMeshes, one per type: a lap's worth of orbs costs two draw
calls, and they are kept off the minimap layer because at 260 m span a
ring of dots hides the road the map exists to show.
### Smoke

`src/vehicle/smoke.js`. Above `THRESHOLD = 0.18` damage the exhaust starts
smoking, and it thickens and darkens the worse the car gets. Measured
across the range:

| Damage | Live particles | Linear luma |
|---|---|---|
| 0.15 | 0 | not drawn at all |
| 0.35 | 11 | 0.45 — pale haze |
| 0.60 | 24 | 0.28 |
| 0.85 | 46 | 0.12 |
| 1.00 | 65 | 0.09 — dark grey |

Peak opacity is 0.33, and the dirty end stops at dark grey rather than
black. The first version went to 0x0e1013 at 0.74 alpha and was wrong: a
near-black particle over a dark road is a hole in the picture rather than
a plume, and at that density it stopped reading as smoke and started
reading as a rendering fault. Both ends stay desaturated — a coloured tint
reads as fire or as a power-up, not as a failing engine. Below the
threshold nothing is drawn and `points.visible` is false, so an undamaged
field costs no draw call.

Three decisions worth keeping:

- **One pool for the whole field.** Every damaged car emits into the same
  particle array, so the effect is a single draw call however many cars
  are smoking — the same reasoning as the pickup orbs and the map blips.
- **Updated on the render frame, not the fixed step.** Smoke changes
  nothing in the simulation, so stepping it at 60 Hz would be wasted work
  at high frame rates and would stutter. It is also therefore absent from
  `captureState` and cannot desynchronise a replay.
- **Emission scales with SPEED as well as damage.** Not for realism: a
  stationary car has no relative wind to carry the smoke away, so it piles
  up in place and swallows the car whole — measured, it hid the very
  bodywork the effect exists to comment on.
- **Particles fade out near the camera** (`smoothstep(1.8, 5.5, dist)` in
  the vertex shader). This is what stops the effect blinding the player.
  Smoke is emitted at the car and drifts backwards, which is straight at a
  chase camera seven metres behind it, and a puff two metres from the lens
  covers most of the screen however small it is in world terms. Fading it
  over that last stretch keeps the trail fully visible where the player is
  looking and removes it exactly where it was in the way.

Per-particle alpha needs a custom `ShaderMaterial`; `PointsMaterial` only
has one opacity for the whole system, and fading each puff independently
is most of what stops it looking like a sprite sheet. The round falloff is
computed from `gl_PointCoord` rather than sampled from a texture — no
image to load, and it stays crisp at any size.
### The condition bar

`src/ui/health.js` — plain DOM at the top of the screen, green through
amber to red. You spend the race looking at the *back* of your own car from
six metres, which is where a crease in the nose is hardest to see; the bar
is the readable version of the same number. It writes to the DOM only when
the value actually moves, and toggles with the rest of the HUD via
`Save.healthBar`.

The player's car is **white** so that damage reads: scratches are dark
gouges and dents show by their shading, both far more legible on a pale
panel than on the original teal, where a crease just looked like another
shadow. Opponents keep strong hues so the field stays separable.

Damage stops short of turning the car black on purpose — colour is how you
pick yourself out of a six-car pack. The knobs are `SCORCH` and the lerp
factors in `CarRig.#applyDamage`, `DENT_MAX`, and the depth in `#dent`.

It is **geometric and material, not part-based**: the draw-call merge (§8)
bakes the body into one geometry, so a wing cannot be dropped on its own —
but that same merge is what makes dents possible, because the shell
deforms as one surface instead of one box sliding out of line with its
neighbours.

`damage` is in `captureState`, because it scales engine force — a replay
that did not restore it would drive with different power than the recording
did. Set `damagePowerLoss: 0` to keep the looks and drop the handicap.
## 10. Best laps

Your best lap time on each level is saved in the browser (`Save.record`,
keyed by level name) and shown in the pause menu. Times are per level: a
lap only means something on the track it was set on.

There used to be a **ghost car** that replayed your best lap alongside you.
It was removed because players found it confusing; it is in git history
(`src/core/ghost.js`) if it is ever wanted back. Its replays were
recordings of the **controls**, not of positions, so they only worked
because the simulation reproduces exactly from the same inputs; the
determinism harness in §7 still guarantees that. `Vehicle` keeps the
`ghost` collision layer the replay car used, unused. Old saves drop their
stored ghost recordings on load.

---

## 11. Deploying

**GitHub Pages (automatic).** Every push to `main` builds the game and
publishes it to <https://phoenix-cgv.github.io/neon-rush/>, via
`.github/workflows/deploy.yml`. Watch a deploy in the repo's Actions tab;
the "Run workflow" button there redeploys without a push. Pages is set to
publish from GitHub Actions (Settings → Pages → Source).

### The department server

```bash
npm run build     # -> dist/
```

Upload the contents of `dist/`.

`vite.config.js` sets `base: "./"` because the game is served from
something like `/~student/neon-rush/`, not a domain root. Any absolute path
(`/assets/car.glb`) 404s there while working perfectly in dev.

**Filenames must be lowercase-with-hyphens.** Ubuntu is case-sensitive:
`Car.glb` works on every laptop in the team and 404s on the server.

---

## Where to ask

If something here is wrong or out of date, fix it in the same commit as
the change that made it wrong. A getting-started guide nobody trusts is
worse than none, because it costs a newcomer a day before they learn not
to trust it.
