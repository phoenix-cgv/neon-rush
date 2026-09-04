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
**Sprint** with the engine idling. If you see a black screen, open the
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
| `L` | next level: Sprint → Storm Ridge → Neon Circuit → testbed |
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
| A new level or track layout | `src/levels/common.js`, then copy `sprint.js` |
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
| `src/core/ghost.js` | Best-lap recording and the ghost car |
| `src/core/determinism.js` | Replay, ghost recordings, **the physics test harness** |
| `src/core/save.js` | Settings and records in localStorage (never throws) |
| `src/ai/driver.js` | Opponent controllers and personalities |
| `src/levels/common.js` | Shared level furniture: scatter, gantry, markers, `polarPoints` |
| `src/levels/sprint.js` | Level 1 — wide and fast, boost strips |
| `src/levels/storm.js` | Level 2 — crosswind, updraft, chicanes |
| `src/levels/circuit.js` | Level 3 — the race. First Track consumer |
| `src/levels/testbed.js` | Tuning testbed: slalom, crest, ramp, barriers |
| `src/ui/menu.js` | Pause and options: quality, assists, key rebinding |
| `src/ui/minimap.js` | Orthographic second camera in a scissored corner |
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
That is why opponents and the ghost car cost no extra vehicle code, and
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

Levels are functions that return a description. Copy `src/levels/sprint.js`
and change the numbers; register it in the `LEVELS` map and `ORDER` array
in `src/main.js`.

Track shape comes from `polarPoints()` — a periodic polar radius function,
**not** hand-placed points. Hand-placed points closed the loop with a kink
and put a 7.3 m-radius corner on the start/finish line, which no car can
take. A periodic function is smooth at the seam by construction.

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
speed for radius r is `sqrt(1.4 * 9.81 * r)`. The three levels are
deliberately graded by their tightest corner:

| # | Name | `?level=` | Tightest corner | Field | Mechanic |
|---|---|---|---|---|---|
| 1 | Sprint | `sprint` | 42.9 m — 87 km/h | solo | boost strips |
| 2 | Storm Ridge | `storm` | 34.1 m — 78 km/h | 2 cars | crosswind, updraft, chicanes |
| 3 | Neon Circuit | `circuit` | 27.7 m — 70 km/h | 5 cars | racing |
| — | Testbed | `testbed` | n/a | solo | slalom, crest, ramp |

Two things to copy from Storm Ridge when you build a hazard:

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
level at once and invalidates stored ghost recordings. If you need
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
`ghost`, `minimap`, `menu`, `Save`, `input` and `loadLevel(name)`.

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

### Testing

- **A/B self-comparison cannot catch a wrong timestep** — see §7. A test
  that cannot fail is not evidence.

---

## 9. The ghost car

Your best lap, replayed alongside you. The recording is six bytes of
**controls** per frame (a 50 s lap is about 17 KB), not a list of
positions, so the ghost is only in the right place because the simulation
reproduces exactly from the same inputs. That is what the determinism
harness in §7 is for.

It shares the track but cannot race. It must meet the same barriers the
recording met, so it is not a sensor; what it must never do is touch
another car, because a ghost that shoves the player is worse than no
ghost. That separation is Rapier interaction groups set in `Vehicle`,
applied to the chassis collider **and** to the suspension raycasts —
without the second, a real car's wheel rays land on the ghost's chassis
and it drives over a rival it cannot collide with.

**Replay is enabled only on levels with no opponents.** A lap driven in
traffic was shaped by slipstream and by contact with cars the ghost cannot
touch, so the replay meets a different world than the recording did.
Measured: on the six-car circuit a lap covering 1248 m replayed to 769 m
and stopped against a barrier; the same recording on the solo level
replays the full 1338 m and finishes 2.75 m from the line. The best lap
*time* is still recorded everywhere — it is real whatever the traffic did
— but the car is only drawn where the replay is faithful.

Records are stored per level. One global best would replay a Sprint ghost
on the Circuit, straight through a barrier.

---

## 10. Deploying to the department server

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
