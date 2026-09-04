import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

import { WORLD, CAR } from "./vehicle/config.js";
import { Vehicle } from "./vehicle/vehicle.js";
import { CarRig } from "./vehicle/car-rig.js";
import { CameraRig } from "./vehicle/camera-rig.js";
import { Input } from "./core/input.js";
import { Progress } from "./core/progress.js";
import { Race } from "./core/race.js";
import { Minimap, MINIMAP_LAYER, MAP_WORLD_LAYER } from "./ui/minimap.js";
import { Menu } from "./ui/menu.js";
import { Save, QUALITY } from "./core/save.js";
import { Ghost } from "./core/ghost.js";
import { DebugOverlay } from "./debug/overlay.js";
import { buildTestbed } from "./levels/testbed.js";
import { buildCircuit } from "./levels/circuit.js";
import { buildSprint } from "./levels/sprint.js";
import { buildStorm } from "./levels/storm.js";

// ---------------------------------------------------------------------
// M1-M4.
//
// Drivable car (raycast suspension, slip-angle tyres, friction circle) on
// either the tuning testbed or a spline-generated circuit, with
// checkpoints, laps, falling and respawn all derived from one number:
// distance along the track centreline.
//
// Tuning constants live in src/vehicle/config.js. Track shape lives in
// src/levels/circuit.js. Neither belongs in here.
// ---------------------------------------------------------------------

await RAPIER.init();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 1500);
const SUN_OFFSET = new THREE.Vector3(60, 80, 30);

const hemi = new THREE.HemisphereLight(0xbcd9e8, 0x4a4238, 2.2);
scene.add(hemi);
// Lights are layer-gated exactly like meshes: a light the camera cannot
// "see" does not illuminate its pass. Restricting the minimap camera to
// the track layers silently excluded the sun and the sky light, and the
// map rendered pure black — the geometry was there the whole time.
hemi.layers.enable(MAP_WORLD_LAYER);

const sun = new THREE.DirectionalLight(0xfff3dc, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const S = 60;
sun.shadow.camera.left = -S;
sun.shadow.camera.right = S;
sun.shadow.camera.top = S;
sun.shadow.camera.bottom = -S;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 300;
sun.shadow.bias = -0.0012;
sun.layers.enable(MAP_WORLD_LAYER);
scene.add(sun, sun.target);

// --- sky ---------------------------------------------------------------
// A gradient dome instead of a flat clear colour. Costs one inverted
// sphere and a nine-line shader, and it is the difference between a
// horizon and a blank wall. (Level 1's real sky shader — day to dusk to
// night — replaces this; the uniforms are already here for it.)
const skyUniforms = {
  uTop: { value: new THREE.Color(0x3f7fb5) },
  uHorizon: { value: new THREE.Color(0xcfe2ea) },
  uBottom: { value: new THREE.Color(0x6f7d6a) },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(900, 24, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uTop, uHorizon, uBottom;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = h > 0.0
          ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55))
          : mix(uHorizon, uBottom, pow(clamp(-h, 0.0, 1.0), 0.4));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
);
sky.frustumCulled = false;
scene.add(sky);

const world = new RAPIER.World(WORLD.gravity);
world.timestep = WORLD.fixedDt;

// The field is built per level (it needs the track for the grid), so
// these are filled in by loadLevel.
let race = null;
let vehicle = null; // the player's car — everything below reads this
let carRig = null;

// The main camera must not see the minimap's blips.
camera.layers.disable(MINIMAP_LAYER);

const cameraRig = new CameraRig(camera);
const input = new Input();
const debug = new DebugOverlay(scene);
const minimap = new Minimap(scene);

// --- settings ----------------------------------------------------------
function applyQuality(q = QUALITY[Save.get("quality")] ?? QUALITY.high) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
  renderer.shadowMap.enabled = q.shadows;
  sun.castShadow = q.shadows;
  if (q.shadows && sun.shadow.mapSize.width !== q.shadowMap) {
    sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
}
function applyPresentation() {
  // These two were in DEFAULTS but never read back, so the toggles
  // persisted a preference the game then ignored on the next load.
  minimap.enabled = Save.get("minimap") !== false;
  debug.setVisible(Save.get("telemetry") !== false);
}

function applyAssists() {
  CAR.autoLevel = Save.get("autoLevel");
  CAR.wallAlignTorque = 14000 * Save.get("wallAssist");
  input.sensitivity = Save.get("mouseSensitivity");
  input.setBindings(Save.get("bindings"));
}

const menu = new Menu({
  onQuality: applyQuality,
  onAssist: applyAssists,
  onRestart: () => loadLevel(levelName),
  levelName: () => levelName,
});
applyQuality();
applyAssists();
applyPresentation();

// ---------------------------------------------------------------------
// Levels. The testbed stays because it is where the car was tuned and
// where it gets re-checked; the circuit is the first thing built on the
// track API. Switch with L, or ?level=testbed.
// ---------------------------------------------------------------------
// The three game levels, in order, plus the tuning testbed — which is a
// development tool rather than a level and deliberately sits after them
// in the cycle.
const LEVELS = {
  sprint: buildSprint, // 1 — learn the car and the boost economy
  storm: buildStorm, //   2 — crosswind, downdraft, chicanes
  circuit: buildCircuit, // 3 — the race, five opponents
  testbed: buildTestbed,
};
const ORDER = ["sprint", "storm", "circuit", "testbed"];
let level = null;
// The car a track-less level owns, so the next loadLevel can take it back.
let ghost = null;
let soloVehicle = null;
let soloRig = null;
let progress = null;
const requested = new URLSearchParams(location.search).get("level");
let levelName = ORDER.includes(requested) ? requested : "sprint";

function loadLevel(name) {
  if (level) {
    level.track?.dispose?.();
    level.dispose?.(); // levels without a Track clean up their own bodies
    for (const o of level.statics ?? []) {
      scene.remove(o);
      o.geometry?.dispose();
    }
  }
  levelName = name;
  level = LEVELS[name](RAPIER, world, scene);

  const fog = level.lit?.fog ?? [0x8fb4c4, 180, 620];
  scene.fog = new THREE.Fog(fog[0], fog[1], fog[2]);
  if (level.lit?.sun) SUN_OFFSET.set(...level.lit.sun);

  race?.dispose();
  race = null;
  ghost?.dispose();
  ghost = null;

  // A track-less level builds its own car instead of a Race, and
  // race.dispose() is a no-op for it — so that car's rigid body survived
  // the level switch. One body per visit is easy to miss and it is solid:
  // the next level was accumulating an invisible parked car at its spawn.
  if (soloVehicle) {
    Vehicle.unregisterChassis(soloVehicle.collider.handle);
    world.removeRigidBody(soloVehicle.body);
    if (soloRig) scene.remove(soloRig.root);
    soloVehicle = null;
    soloRig = null;
  }

  if (level.track) {
    // Level 3 is the race; the others are single-car. Opponent count
    // comes from the level so the testbed stays a testbed.
    race = new Race(RAPIER, world, scene, level.track, level.opponents ?? 0);
    vehicle = race.player.vehicle;
    carRig = race.player.rig;
    progress = race.player.progress;
    minimap.build(race.cars);
    // The ghost shares the world but not the race: it is not in
    // race.cars, so it cannot affect standings, slipstream or respawn
    // slot searches.
    ghost = new Ghost(RAPIER, world, scene, level.track, name, (level.opponents ?? 0) === 0);
    ghost.restart(vehicle);
    cameraRig.snapTo(vehicle.state);
  } else {
    // No track: a bare car on the testbed, no race machinery.
    vehicle = new Vehicle(RAPIER, world, level.spawn);
    carRig = new CarRig();
    soloVehicle = vehicle;
    soloRig = carRig;
    scene.add(carRig.root);
    vehicle.setTrack(null, 0);
    progress = null;
    minimap.build([{ isPlayer: true, vehicle, rig: carRig }]);
    respawn();
  }
}

function respawn(pose = null) {
  const p = pose ?? { position: level.spawn, quaternion: level.quaternion ?? null };
  vehicle.reset(p.position, level.heading ?? 0);
  if (p.quaternion) {
    vehicle.body.setRotation(
      { x: p.quaternion.x, y: p.quaternion.y, z: p.quaternion.z, w: p.quaternion.w },
      true
    );
    vehicle.prevQuat.copy(p.quaternion);
    vehicle.renderQuat.copy(p.quaternion);
  }
  if (level.track) vehicle.setTrack(level.track, vehicle.s);
  progress?.markProgressFrom(vehicle.s);
  cameraRig.snapTo(vehicle.state);
}

loadLevel(levelName);

renderer.domElement.addEventListener("click", () => {
  renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
});

let last = performance.now();
let accumulator = 0;
let fps = 60;
const _fieldForce = new THREE.Vector3();

function frame(now) {
  requestAnimationFrame(frame);

  const frameDt = Math.min((now - last) / 1000, WORLD.maxFrameDt);
  last = now;
  fps += (1 / Math.max(frameDt, 1e-4) - fps) * 0.08;

  if (input.pressed("pause")) menu.toggle();

  // Paused: drop the accumulator rather than banking wall-clock time and
  // discharging it as a burst of catch-up steps on resume.
  if (menu.open) {
    accumulator = 0;
    renderer.render(scene, camera);
    minimap.render(renderer, scene);
    input.endFrame();
    return;
  }

  if (input.pressed("camera")) cameraRig.cycle();
  if (input.pressed("debug")) Save.set("telemetry", debug.toggle());
  if (input.pressed("map")) Save.set("minimap", minimap.toggle());
  if (input.pressed("restart")) { progress?.reset(); respawn(); }
  if (input.pressed("level")) {
    loadLevel(ORDER[(ORDER.indexOf(levelName) + 1) % ORDER.length]);
  }

  accumulator += frameDt;
  let controls = input.controls;
  while (accumulator >= WORLD.fixedDt) {
    // Ramp the controls on the FIXED step, not the render frame.
    //
    // input.update() moves throttle, brake and steer toward their targets
    // at a rate per second. Called once per rendered frame, the values it
    // produces get sampled by the physics at whatever rate the display
    // happens to run: at 144 Hz most of them never reach a step at all,
    // at 30 Hz each one is applied twice. Same keystrokes, different
    // drive — and a replay recorded on one machine would not reproduce on
    // another. Ramping in here makes the control trajectory a function of
    // the input alone.
    controls = input.update(WORLD.fixedDt, !vehicle.grounded);

    if (race) {
      for (const c of race.cars) c.vehicle.savePreviousState();
      // Every car is stepped BEFORE the single solve, so no car sees a
      // world the others have not moved in yet.
      race.step(WORLD.fixedDt, controls);
    } else {
      vehicle.savePreviousState();
      vehicle.step(WORLD.fixedDt, controls);
    }

    // Level force fields (Level 2's crosswind and friends) reach the car
    // through the track wrapper, never by touching Rapier directly.
    //
    // Every car, not just the player. Applying a gust to the player
    // alone makes the wind read as a handicap aimed at them rather than
    // as weather, and the AI would take the exposed line for free.
    if (level.track && level.track.forceFields.size) {
      const field = race ? race.cars.map((c) => c.vehicle) : [vehicle];
      for (const v of field) {
        level.track.forceAt(
          v.s,
          { s: v.s, t: v.lateralOffset, time: now / 1000, vehicle: v },
          _fieldForce
        );
        if (_fieldForce.lengthSq() > 0) v.body.addForce(_fieldForce, true);
      }
    }

    // The ghost is stepped with the field, before the single solve, for
    // the same reason every car is: anything stepped after would be
    // reacting to a world the others had not moved in yet.
    ghost?.step(WORLD.fixedDt, controls);

    world.step();

    if (race) {
      // Constraints and progress correct the pose Rapier just produced,
      // so they run after the solver, not before it.
      race.postStep(WORLD.fixedDt);
      ghost?.postStep();
      if (progress?.justCompletedLap) {
        ghost?.completeLap(progress.lastLapTime, vehicle);
      }
    } else {
      vehicle.applySoftWall();
    }
    accumulator -= WORLD.fixedDt;
  }

  const alpha = accumulator / WORLD.fixedDt;
  if (race) race.render(alpha);
  else {
    vehicle.writeTransform(alpha);
    carRig.sync(vehicle.state);
  }
  ghost?.render(alpha);

  const state = vehicle.state;
  cameraRig.update(frameDt, state, input.look);

  sky.position.copy(camera.position);
  sun.target.position.copy(state.position);
  sun.position.copy(state.position).add(SUN_OFFSET);

  debug.update(state, fps, {
    camera: cameraRig.modeName,
    level: levelName,
    levelTitle: level?.title ?? levelName,
    track: level.track ?? null,
    progress,
    race,
  });

  renderer.render(scene, camera);

  // No hide-list needed: the map camera only sees the track layer and the
  // blips, so the sky dome and debug vectors are never in its pass.
  minimap.update(state);
  minimap.render(renderer, scene);

  input.endFrame();
}

requestAnimationFrame(frame);

window.__dbg = {
  THREE, RAPIER, world, cameraRig, scene, CAR, WORLD, loadLevel,
  get level() { return level; },
  get progress() { return progress; },
  get race() { return race; },
  minimap, menu, Save, input, renderer,
  get ghost() { return ghost; },
  // physics test harness — see src/core/determinism.js
  determinism: () => import("./core/determinism.js"),
  get vehicle() { return vehicle; },
};

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
