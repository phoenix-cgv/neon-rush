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
import { HealthBar } from "./ui/health.js";
import { Pickups } from "./core/pickups.js";
import { Traffic } from "./core/traffic.js";
import { RaceDirector } from "./core/race-director.js";
import { RaceHud } from "./ui/race-hud.js";
import { Smoke } from "./vehicle/smoke.js";
import { DebugOverlay } from "./debug/overlay.js";
import { buildTestbed } from "./levels/testbed.js";
import { buildCity } from "./levels/city.js";
import { buildGrandPrix } from "./levels/grandprix.js";
import { buildMountain } from "./levels/mountain.js";

// ---------------------------------------------------------------------
// M1-M4.
//
// Drivable car (raycast suspension, slip-angle tyres, friction circle) on
// one of the three maps or the tuning testbed, with checkpoints, laps,
// falling and respawn all derived from one number: distance along the
// track centreline.
//
// Tuning constants live in src/vehicle/config.js. Maps live in
// src/levels/ (city.js, mountain.js, grandprix.js) and assets/maps/.
// Neither belongs in here.
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
const health = new HealthBar();
const raceHud = new RaceHud();
// One shared pool for the whole field — smoke is one draw call however
// many cars are smoking, and it is kept off the minimap layer.
const smoke = new Smoke(scene, MINIMAP_LAYER);

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
  health.setVisible(Save.get("healthBar") !== false);
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
// Levels: the game's three maps, in order. L cycles through them.
//
// The maps are modelled in Blender (assets/maps); their builders carry a
// preload() that fetches the .glb, and loadLevel awaits it before
// building.
//
// The testbed is a development tool, not a level: it is where the car
// was tuned and where handling gets re-checked. It stays loadable with
// ?level=testbed but is deliberately left out of the L cycle, so players
// never land on it.
// ---------------------------------------------------------------------
const LEVELS = {
  city: buildCity, //           1 — street circuit, solo through live traffic
  mountain: buildMountain, //   2 — banked climb, guardrails, tunnel
  grandprix: buildGrandPrix, // 3 — the full circuit, five opponents
  testbed: buildTestbed, //     development only: ?level=testbed
};
const ORDER = ["city", "mountain", "grandprix"];
let level = null;
// The car a track-less level owns, so the next loadLevel can take it back.
let pickups = null;
let traffic = null; // civilian traffic, on levels that ask for it
let director = null; // start lights, laps and the flag, on levels that race
let soloVehicle = null;
let soloRig = null;
let progress = null;
const requested = new URLSearchParams(location.search).get("level");
let levelName = requested && Object.hasOwn(LEVELS, requested) ? requested : ORDER[0];
// Set while a map file is being fetched. The current level keeps running
// meanwhile; a second request is ignored rather than racing the first.
let loading = null;
const loadingNote = document.createElement("div");
loadingNote.style.cssText =
  "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);" +
  "font:600 18px system-ui,sans-serif;color:#fff;background:rgba(10,16,22,.72);" +
  "padding:12px 20px;border-radius:8px;pointer-events:none;display:none;z-index:10";
document.body.appendChild(loadingNote);

async function loadLevel(name) {
  if (loading) return;
  let asset;
  if (LEVELS[name].preload) {
    loading = name;
    loadingNote.textContent = `Loading ${name}…`;
    loadingNote.style.display = "block";
    try {
      asset = await LEVELS[name].preload();
    } catch (err) {
      console.error(`[loadLevel] could not load map "${name}"`, err);
      loadingNote.textContent = `Could not load ${name} — see console`;
      setTimeout(() => (loadingNote.style.display = "none"), 4000);
      loading = null;
      return;
    }
    loading = null;
    loadingNote.style.display = "none";
  }
  if (level) {
    level.track?.dispose?.();
    level.dispose?.(); // levels without a Track clean up their own bodies
    for (const o of level.statics ?? []) {
      scene.remove(o);
      o.geometry?.dispose();
    }
  }
  levelName = name;
  level = LEVELS[name](RAPIER, world, scene, asset);

  const fog = level.lit?.fog ?? [0x8fb4c4, 180, 620];
  scene.fog = new THREE.Fog(fog[0], fog[1], fog[2]);
  if (level.lit?.sun) SUN_OFFSET.set(...level.lit.sun);

  director?.dispose();
  director = null;
  raceHud.setActive(false);
  race?.dispose();
  race = null;
  traffic?.dispose();
  traffic = null;
  pickups = null; // its meshes belong to the track and go with it

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
    pickups = new Pickups(level.track, scene, level.pickups ?? {});
    if (level.traffic) traffic = new Traffic(RAPIER, world, scene, level.track, level.traffic);
    if (level.race) {
      director = new RaceDirector(race, { laps: level.race.laps, lamps: level.startLamps ?? [] });
      raceHud.setActive(true);
    }
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
  traffic?.clearAround(p.position);
  cameraRig.snapTo(vehicle.state);
}

await loadLevel(levelName);
// A map that failed to download must not leave the game with no level.
// The testbed is built in code, so it needs no download.
if (!level) await loadLevel("testbed");

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
  if (input.pressed("restart")) {
    if (!director) {
      progress?.reset();
      respawn();
    } else if (director.state === "finished") {
      loadLevel(levelName); // race again
    } else if (director.state === "racing") {
      // Mid-race, R puts you back at your last checkpoint and keeps your
      // laps: resetting to the grid would throw the race away.
      respawn(progress.respawnPose());
    } // during the start lights R does nothing
  }
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
      // Lights before cars: the step the lights go out on is the first
      // step anyone may move.
      director?.step(WORLD.fixedDt);
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

    // Traffic moves on the same step, before the same single solve.
    traffic?.step(WORLD.fixedDt, race ? race.cars : []);

    world.step();

    if (race) {
      // Constraints and progress correct the pose Rapier just produced,
      // so they run after the solver, not before it.
      race.postStep(WORLD.fixedDt);
      pickups?.update(WORLD.fixedDt, race.cars);
      // Best lap per level, shown in the pause menu.
      if (progress?.justCompletedLap) Save.submitLap(levelName, progress.lastLapTime);
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
  traffic?.render(alpha);
  pickups?.render();
  // Render-frame, not fixed-step: smoke changes nothing in the
  // simulation, so it must not cost a physics step or stutter at high
  // frame rates.
  smoke.update(frameDt, race ? race.cars : [{ vehicle }]);

  const state = vehicle.state;
  health.update(state.damage);
  raceHud.update(director, race);
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
  minimap, menu, Save, input, renderer, health, smoke,
  get pickups() { return pickups; },
  get traffic() { return traffic; },
  get director() { return director; },
  // physics test harness — see src/core/determinism.js
  determinism: () => import("./core/determinism.js"),
  get vehicle() { return vehicle; },
};

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
