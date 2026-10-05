import { loadingScreen } from "./ui/loading-screen.js";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

import { WORLD, CAR } from "./vehicle/config.js";
import { Vehicle } from "./vehicle/vehicle.js";
import { CarRig } from "./vehicle/car-rig.js";
import { loadCarModel } from "./vehicle/car-model.js";
import { loadTrafficModels } from "./core/traffic-models.js";
import { CameraRig } from "./vehicle/camera-rig.js";
import { Input } from "./core/input.js";
import { Progress } from "./core/progress.js";
import { Race } from "./core/race.js";
import { Minimap, MINIMAP_LAYER, MAP_WORLD_LAYER } from "./ui/minimap.js";
import { Menu } from "./ui/menu.js";
import { Speedo } from "./ui/speedo.js";
import { TrackOutline } from "./ui/track-outline.js";
import { Dashboard } from "./ui/dashboard.js";
import { GameAudio } from "./core/audio.js";
import { Save, QUALITY } from "./core/save.js";
import { HealthBar } from "./ui/health.js";
import { Pickups } from "./core/pickups.js";
import { Traffic } from "./core/traffic.js";
import { Rockfall } from "./core/rockfall.js";
import { Crosswind } from "./core/crosswind.js";
import { FogPatch } from "./core/fog-patch.js";
import { PitLane } from "./track/pit-lane.js";
import { RaceDirector } from "./core/race-director.js";
import { Ghost } from "./core/ghost.js";
import { Recorder } from "./core/determinism.js";
import { RaceHud } from "./ui/race-hud.js";
import { GameplayHud } from "./ui/gameplay-hud.js";
import { GameplayEvents } from "./core/gameplay-events.js";
import { Smoke } from "./vehicle/smoke.js";
import { WheelGlow } from "./vehicle/wheel-glow.js";
import { DriftFx } from "./vehicle/drift-fx.js";
import { DebugOverlay } from "./debug/overlay.js";
import { SkyEnvironment } from "./lighting/sky-environment.js";
import { Sky } from "./lighting/sky.js";
import { PostFX } from "./lighting/post.js";
import { LevelLights } from "./lighting/level-lights.js";
import { addFakeHeadlights } from "./lighting/fake-headlights.js";
import { CheckpointGates } from "./lighting/checkpoint-gates.js";
import { BoostTrails } from "./lighting/boost-trail.js";
import { makeWet, wetUniforms } from "./lighting/wet-road.js";
import { addDetail, detailSwitch } from "./lighting/surface-detail.js";
import { AdaptiveResolution } from "./lighting/adaptive-resolution.js";
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
await Promise.all([loadCarModel(), loadTrafficModels()]); // before any car or traffic is built; each falls back if it fails

const params = new URLSearchParams(location.search);

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
// A dome with a gradient, sun or moon, drifting clouds and stars; see
// src/lighting/sky.js. `skyUniforms` is handed to the Mountain's fog
// patch, which tints the gradient's three colours as it thickens.
const SKY_RADIUS = 900;
const sky = new Sky(SKY_RADIUS);
const skyUniforms = sky.uniforms;
scene.add(sky.mesh);

// Reflections baked from that same dome (src/lighting/sky-environment.js),
// bloom and tone mapping (src/lighting/post.js), and any extra lights a
// level declares (src/lighting/level-lights.js). ?env=0 and ?post=0 turn
// the first two off, for before/after comparisons; ?detail=0 does the
// same for the normal maps (src/lighting/surface-detail.js).
const skyEnv = params.get("env") === "0" ? null : new SkyEnvironment(renderer, sky.material, SKY_RADIUS);
const post = new PostFX(renderer, scene, camera);
const postAllowed = params.get("post") !== "0";
const detailAllowed = params.get("detail") !== "0"; // ?detail=0: no normal maps, for comparison
const levelLights = new LevelLights(scene);
// Lowers the scene's resolution when frames run long (see
// src/lighting/adaptive-resolution.js). ?adaptive=0 turns it off.
const adaptive = new AdaptiveResolution(renderer, () => post.resize());

// Per-level lighting. A level's `lit` may set any of these; anything it
// leaves out falls back to the daylight defaults, so switching from a
// dusk level back to a day one restores everything.
//   sun          sun position relative to the car (sets its direction)
//   sunColor, sunIntensity
//   hemi         [sky colour, ground colour, intensity] of the fill light
//   sky          { top, horizon, bottom, clouds, cloudColor, stars, sunDisc,
//                sunSize } — see src/lighting/sky.js
//   fog          [colour, near, far]
//   exposure     tone-mapping exposure
//   envIntensity how strongly the sky-baked environment lights and
//                reflects in every standard material (0 = off)
//   bloom        { threshold, strength, radius } — see src/lighting/post.js
//   lights       extra point/spot lights — see src/lighting/level-lights.js
//   headlights   true to switch on the player's headlight spots (dusk, night)
//   pools        light pools — see src/lighting/light-pool.js
//   strips       glowing fittings the map lacks — see src/lighting/level-lights.js
//   shelter      [{ s0, s1, ramp, ambient }] stretches under a roof (a
//                tunnel): the sky fill and the environment are scaled to
//                `ambient` there, since neither can be blocked by a roof
//   emissive     { materialName: scale } on the map's glowing materials, so
//                a level can switch street lamps off at noon or turn
//                floodlights up at night without touching the .glb
//   materials    { materialName: { roughness, metalness, ... } } overrides,
//                e.g. wet asphalt at night
//   glow         the level's effect colour: checkpoint gates, boost trail
//   detail       { materialName: { map, size, strength } } — generated normal
//                maps, projected without UVs, see src/lighting/surface-detail.js
//   wet          { materials: [names], puddles, damp, ripples } — puddles and
//                rain ripples on those materials, see src/lighting/wet-road.js
const LIGHT_DEFAULTS = {
  sun: [60, 80, 30],
  sunColor: 0xfff3dc,
  sunIntensity: 3.0,
  hemi: [0xbcd9e8, 0x4a4238, 2.2],
  sky: { top: 0x3f7fb5, horizon: 0xcfe2ea, bottom: 0x6f7d6a },
  fog: [0x8fb4c4, 180, 620],
  exposure: 1.05,
  envIntensity: 0.4,
  bloom: {},
  lights: [],
  pools: [],
  strips: [],
  shelter: [],
  emissive: {},
  materials: {},
};
// Share of each light pool kept, from the quality preset (see QUALITY).
// Starts at the SAVED preset's value: applyQuality() first runs before
// `level` is declared further down, and must find nothing to rebuild.
let lightShare = (QUALITY[Save.get("quality")] ?? QUALITY.high).lights;

// The current level's roofed stretches and the fill values they dim.
let shelter = { zones: [], hemi: 0, env: 0 };

/**
 * How much open sky the player is under, 0..1: 1 in the open, `ambient`
 * deep in a tunnel, ramped over `ramp` metres at each mouth. Neither the
 * hemisphere fill nor the environment map knows about the tunnel roof,
 * and without this the inside of the Mountain's tunnel was lit by the
 * dusk sky, a faint purple, from nowhere.
 */
function openSky(s) {
  let k = 1;
  for (const z of shelter.zones) {
    const ramp = z.ramp ?? 15;
    let w = 0; // 0 outside .. 1 fully inside
    if (s > z.s0 - ramp && s < z.s1 + ramp) {
      w = Math.min(1, (s - (z.s0 - ramp)) / ramp, ((z.s1 + ramp) - s) / ramp);
    }
    k = Math.min(k, 1 - w * (1 - (z.ambient ?? 0.2)));
  }
  return k;
}

function applyLighting(lit, track = null) {
  const L = { ...LIGHT_DEFAULTS, ...lit };
  // Older levels give `sky` as one colour (their fog colour): keep the
  // default dome for them rather than painting it flat.
  const dome = typeof L.sky === "object" ? L.sky : LIGHT_DEFAULTS.sky;
  SUN_OFFSET.set(...L.sun);
  sun.color.set(L.sunColor);
  sun.intensity = L.sunIntensity;
  hemi.color.set(L.hemi[0]);
  hemi.groundColor.set(L.hemi[1]);
  hemi.intensity = L.hemi[2];
  sky.set(dome, L.sun, L.sunColor);
  scene.fog = new THREE.Fog(L.fog[0], L.fog[1], L.fog[2]);
  renderer.toneMappingExposure = L.exposure;
  // After the dome's colours are set: the bake reads them.
  if (skyEnv) {
    scene.environment = skyEnv.bake();
    scene.environmentIntensity = L.envIntensity;
  }
  post.setBloom(L.bloom);
  // Fewer real lights on lower presets; a pool cut to none just leaves
  // its fixtures glowing.
  const pools = L.pools
    .map((p) => ({ ...p, count: Math.ceil((p.count ?? 4) * lightShare) }))
    .filter((p) => p.count > 0);
  levelLights.build(L.lights, track, pools, L.strips);
  shelter = { zones: L.shelter, hemi: L.hemi[2], env: L.envIntensity };
  restyleMaterials(L.emissive, L.materials);
  if (L.detail && detailAllowed) {
    scene.traverse((o) => {
      const d = o.isMesh && o.material?.isMeshStandardMaterial && L.detail[o.material.name];
      if (d) addDetail(o.material, d);
    });
  }
  if (L.wet) {
    scene.traverse((o) => {
      if (o.isMesh && L.wet.materials.includes(o.material?.name)) makeWet(o.material);
    });
    wetUniforms.uPuddles.value = L.wet.puddles ?? 0.45;
    wetUniforms.uDamp.value = L.wet.damp ?? 0.38;
    wetUniforms.uRipples.value = L.wet.ripples ?? 1;
  }
}

/**
 * Per-level material looks, by material name: `emissive` scales a glow,
 * `materials` overrides properties (wet asphalt is roughness down).
 *
 * The exported value of anything touched is kept on the material the
 * first time it is seen, and every level starts from THAT, never from the
 * current value: the map's materials are cached and shared between
 * visits, so working from the live value would compound on every reload,
 * and a property one level overrode would leak into the next.
 */
function restyleMaterials(emissive, overrides) {
  scene.traverse((o) => {
    const m = o.isMesh ? o.material : null;
    if (!m || Array.isArray(m) || !m.isMeshStandardMaterial) return;
    const base = (m.userData.base ??= {});
    if (m.emissive) {
      base.emissiveIntensity ??= m.emissiveIntensity;
      m.emissiveIntensity = base.emissiveIntensity * (emissive[m.name] ?? 1);
    }
    for (const k of Object.keys(base)) if (k !== "emissiveIntensity") m[k] = base[k];
    for (const [k, v] of Object.entries(overrides[m.name] ?? {})) {
      base[k] ??= m[k];
      m[k] = v;
    }
  });
}

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
const gameplayHud = new GameplayHud();
const speedo = new Speedo();
const outline = new TrackOutline();
// Race HUD is hidden behind the home screen.
const hudStyle = document.createElement("style");
hudStyle.textContent = "body.dash-open .hud{visibility:hidden !important}";
document.head.appendChild(hudStyle);
for (const r of [raceHud.root, gameplayHud.root, speedo.root, outline.root, health.root]) r.classList.add("hud");
const gameplayEvents = new GameplayEvents();
// One shared pool for the whole field — smoke is one draw call however
// many cars are smoking, and it is kept off the minimap layer.
const smoke = new Smoke(scene, MINIMAP_LAYER);
const driftFx = new DriftFx(scene);
const wheelGlow = new WheelGlow(scene); // neon on the ground behind the rear wheels (Grand Prix)
gameplayHud.onTierUp = (tier) => driftFx.burst(carRig, tier);

// A time-trial level's boost orbs (see Pickups' boostSeconds) push the
// race clock back instead of filling the boost meter. One listener for
// the whole game: `director` is reassigned on every loadLevel, and this
// closure always reads whatever it currently is.
gameplayEvents.on("pickup-collected", (e) => {
  if (!e.timeBonus) return;
  director?.addTime(e.timeBonus);
  gameplayHud.flashTimeBonus(e.timeBonus);
});

// --- settings ----------------------------------------------------------
function applyQuality(q = QUALITY[Save.get("quality")] ?? QUALITY.high) {
  // Through the adaptive scaler: the preset sets the ceiling, it may
  // draw below it when frames run long.
  adaptive.setBase(Math.min(window.devicePixelRatio, q.pixelRatio));
  renderer.shadowMap.enabled = q.shadows;
  sun.castShadow = q.shadows;
  if (q.shadows && sun.shadow.mapSize.width !== q.shadowMap) {
    sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
  post.enabled = postAllowed && q.bloom;
  post.resize();
  detailSwitch.uDetailOn.value = q.detail ? 1 : 0;
  // Light pools are sized from the preset, so a change rebuilds the
  // level's lighting (cheap: a few lights and one environment bake).
  if (q.lights !== lightShare) {
    lightShare = q.lights;
    if (level) applyLighting(level.lit ?? {}, level.track ?? null);
  }
}
function applyPresentation() {
  // These two were in DEFAULTS but never read back, so the toggles
  // persisted a preference the game then ignored on the next load.
  minimap.enabled = Save.get("minimap") !== false;
  outline.setVisible(minimap.enabled);
  health.setVisible(Save.get("healthBar") !== false);
  debug.setVisible(Save.get("telemetry") !== false);
}

function applyAssists() {
  CAR.autoLevel = Save.get("autoLevel");
  CAR.wallAlignTorque = 14000 * Save.get("wallAssist");
  input.sensitivity = Save.get("mouseSensitivity");
  input.setBindings(Save.get("bindings"));
  input.setScheme(Save.get("controlScheme"));
  audio.configure({ music: Save.get("music") !== false, sound: Save.get("sound") !== false });
}

const audio = new GameAudio();
const menu = new Menu({
  onHome: () => showDashboard(),
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
let finishedFor = 0; // s the results screen has been up
let leaving = false; // a return to the title page is under way
let levelFresh = false; // true from a level loading until its lights go out
// The car a track-less level owns, so the next loadLevel can take it back.
let pickups = null;
let traffic = null; // civilian traffic, on levels that ask for it
let rockfall = null; // falling rocks, on levels that ask for them
let crosswind = null; // lateral gusts, on levels that ask for them
let fogPatch = null; // visibility hazard, on levels that ask for it
let pits = null; // the pit lane, on maps that have one
let gates = null; // checkpoint gates (presentation only — Progress does the counting)
let trails = null; // drift / boost ribbons behind every car
let director = null; // start lights, laps and the flag, on levels that race
let ghost = null; // your own best lap, replayed alongside you
let ghostBestLap = null; // its time, for the HUD — fixed for the level's visit, like the ghost itself
let recorder = null; // recording the lap in progress, so a new best gets a ghost
let soloVehicle = null;
let soloRig = null;
let progress = null;
const requested = new URLSearchParams(location.search).get("level");
// ?level= can't skip ahead of what has been unlocked (the testbed is exempt).
const requestedOk =
  requested &&
  Object.hasOwn(LEVELS, requested) &&
  (!ORDER.includes(requested) || ORDER.indexOf(requested) < (Save.get("maxLevel") | 0));
let levelName = requestedOk ? requested : ORDER[0];
// Set while a map file is being fetched. The current level keeps running
// meanwhile; a second request is ignored rather than racing the first.
let loading = null;
const LEVEL_TITLES = { city: "City Track", mountain: "Mountain Track", grandprix: "Grand Prix" };
let bootDone = false; // the loading screen stays up until the title page is ready

async function loadLevel(name) {
  if (loading) return;
  adaptive.pause(2); // a load is one long frame, not a slow GPU
  let asset;
  if (LEVELS[name].preload) {
    loading = name;
    loadingScreen.show(LEVEL_TITLES[name] ?? name);
    try {
      asset = await LEVELS[name].preload();
    } catch (err) {
      console.error(`[loadLevel] could not load map "${name}"`, err);
      loadingScreen.fail(`Could not load ${name} — see console`);
      loading = null;
      return;
    }
    loading = null;
    if (bootDone) loadingScreen.hide();
  }
  if (level) {
    // Before applyLighting below replaces scene.fog for the new level:
    // FogPatch.dispose() restores the OLD fog's near/far/colour, and
    // doing that after the swap would stomp the new level's fog instead
    // of the one it actually captured.
    fogPatch?.dispose();
    fogPatch = null;
    level.track?.dispose?.();
    level.dispose?.(); // levels without a Track clean up their own bodies
    for (const o of level.statics ?? []) {
      scene.remove(o);
      o.geometry?.dispose();
    }
  }
  levelName = name;
  level = LEVELS[name](RAPIER, world, scene, asset);

  applyLighting(level.lit ?? {}, level.track ?? null);

  director?.dispose();
  director = null;
  raceHud.setActive(false);
  gameplayHud.setActive(false);
  speedo.setActive(false);
  race?.dispose();
  race = null;
  traffic?.dispose();
  traffic = null;
  rockfall?.dispose();
  rockfall = null;
  crosswind?.dispose();
  crosswind = null;
  ghost?.dispose();
  ghost = null;
  ghostBestLap = null;
  recorder = null;
  pits?.dispose();
  pits = null;
  gates?.dispose();
  gates = null;
  trails?.dispose();
  trails = null;
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
    race = new Race(RAPIER, world, scene, level.track, level.opponents ?? 0, gameplayEvents);
    vehicle = race.player.vehicle;
    carRig = race.player.rig;
    progress = race.player.progress;
    minimap.build(race.cars);
    outline.build(level.track);
    pickups = new Pickups(level.track, scene, level.pickups ?? {}, gameplayEvents);
    if (level.traffic) traffic = new Traffic(RAPIER, world, scene, level.track, level.traffic);
    if (level.rockfall) {
      rockfall = new Rockfall(RAPIER, world, scene, level.track, level.rockfall, gameplayEvents);
    }
    if (level.crosswind) crosswind = new Crosswind(level.track, scene, level.crosswind);
    gates = new CheckpointGates(level.track, scene, {
      color: level.lit?.glow,
      scenery: asset?.scene ?? null, // the map's own objects, for placement
      RAPIER,
      world,
    });
    trails = new BoostTrails(scene, race.cars, { color: level.lit?.glow });
    if (level.fogPatch) fogPatch = new FogPatch(level.track, scene, level.fogPatch, skyUniforms);
    if (level.pit?.data) {
      pits = new PitLane(level.track, scene, level.pit.data, level.pit);
      pits.attach(race.cars);
    }
    if (level.race) {
      director = new RaceDirector(race, {
        ...level.race,
        lamps: level.startLamps ?? [],
        eventBus: gameplayEvents,
      });
      raceHud.setActive(true);
      // A ghost of the level's own best lap — null if none has been set
      // yet. Loaded once, from whatever was the best lap at the moment
      // this level started: beating it mid-run does not replace it until
      // the next restart, same as any other ghost-replay racer.
      const record = Save.record(levelName);
      if (record.ghost) {
        ghost = new Ghost(RAPIER, world, scene, level.track, record.ghost);
        ghostBestLap = record.bestLap;
      }
      recorder = new Recorder();
    }
    gameplayHud.setActive(true);
    speedo.setActive(true);
    levelFresh = true;
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
    outline.build(null);
    respawn();
  }
  poseForPhoto();
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
  rockfall?.clearAround(p.position);
  cameraRig.snapTo(vehicle.state);
}

await loadLevel(levelName);
// A map that failed to download must not leave the game with no level.
// The testbed is built in code, so it needs no download.
if (!level) await loadLevel("testbed");

// Photo mode shoots at full resolution; and the switch for comparisons.
if (photo || params.get("adaptive") === "0") adaptive.setEnabled(false);

if (photo) {
  for (let i = 0; i < (Number(params.get("cam")) || 0); i++) cameraRig.cycle();
  if (params.get("hud") === "0") {
    // visibility, not display: each HUD toggles its own display on every
    // level load, and this has to outlast that.
    for (const el of [gameplayHud.root, raceHud.root, health.root]) el.style.visibility = "hidden";
    minimap.enabled = false;
    debug.setVisible(false);
  }
}

renderer.domElement.addEventListener("click", () => {
  renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
});

// --- dashboard: the home screen, with the live city as its backdrop -----
const TITLES = { city: "City Track", mountain: "Mountain Track", grandprix: "Grand Prix" };
const dashboard = new Dashboard({
  gameName: "Neon Rush",
  levels: ORDER.map((id) => ({ id, title: TITLES[id] })),
  onClick: () => audio.click(),
  onChange: () => applyAssists(),
  onPlay: (i) => {
    document.body.classList.remove("dash-open");
    audio.unlock();
    // The level behind the title page is already loaded and untouched
    // (after a win it is the next level): just start it.
    if (!(ORDER[i] === levelName && levelFresh)) loadLevel(ORDER[i]);
  },
});
function showDashboard() {
  menu.close();
  const i = Math.max(0, ORDER.indexOf(levelName));
  document.body.classList.add("dash-open");
  dashboard.show(i);
}
// Browsers only allow audio after a gesture: the first click anywhere on
// the dashboard starts it.
window.addEventListener("pointerdown", () => { audio.unlock(); applyAssists(); }, { once: true });
let orbit = 0;
showDashboard();
bootDone = true;
loadingScreen.hide();

let last = performance.now();
let accumulator = 0;
let fps = 60;
const _fieldForce = new THREE.Vector3();
const _mapOthers = [];
const _dashPos = new THREE.Vector3();
const _dashLook = new THREE.Vector3();

// Win or lose, the results screen gives way to the title page after a few
// seconds. After a win the level loaded behind it is the NEXT one (and the
// title page's level picker is already on it); after a loss it is the same
// level again, fresh. R (race again) or L (switch level) in the meantime
// start a fresh race themselves, which ends this countdown.
const RESULTS_DELAY = 5; // s the results screen stays up
async function returnToTitle(next) {
  await loadLevel(next);
  showDashboard();
  finishedFor = 0;
  leaving = false;
}

function frame(now) {
  requestAnimationFrame(frame);

  const frameDt = Math.min((now - last) / 1000, WORLD.maxFrameDt);
  last = now;
  fps += (1 / Math.max(frameDt, 1e-4) - fps) * 0.08;

  audio.update(dashboard.open ? 0 : vehicle.state.speed ?? 0, !dashboard.open && !menu.open);

  // Home screen: the world sits still and the camera frames the car from
  // behind and to the left, so it sits low and to the right of the title.
  if (dashboard.open) {
    accumulator = 0;
    orbit += frameDt;
    // Pose the cars (nothing steps while the dashboard is up) and read the
    // player's rig, which carries the true heading.
    if (race) race.render(1);
    else {
      vehicle.writeTransform(1);
      carRig.sync(vehicle.state);
    }
    const st = { quaternion: carRig.root.quaternion, position: carRig.root.position };
    _dashPos.set(-3.3 + Math.sin(orbit * 0.25) * 0.7, 1.15 + Math.sin(orbit * 0.17) * 0.12, 7.6)
      .applyQuaternion(st.quaternion).add(st.position);
    _dashLook.set(0.2, 1.1, -12).applyQuaternion(st.quaternion).add(st.position);
    camera.position.copy(_dashPos);
    camera.lookAt(_dashLook);
    sky.position.copy(camera.position);
    level.update?.(now / 1000);
    renderer.render(scene, camera);
    input.endFrame();
    return;
  }

  if (input.pressed("pause")) menu.toggle();

  // Paused: drop the accumulator rather than banking wall-clock time and
  // discharging it as a burst of catch-up steps on resume.
  if (menu.open) {
    accumulator = 0;
    renderer.render(scene, camera);
    input.endFrame();
    return;
  }

  if (input.pressed("camera")) cameraRig.cycle();
  if (input.pressed("debug")) Save.set("telemetry", debug.toggle());
  if (input.pressed("map")) {
    Save.set("minimap", minimap.toggle());
    outline.setVisible(minimap.enabled);
  }
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
    // Levels unlock in order: L may only move within what has been earned.
    const next = (ORDER.indexOf(levelName) + 1) % ORDER.length;
    if (next < (Save.get("maxLevel") | 0)) loadLevel(ORDER[next]);
  }

  if (director && director.state !== "lights") levelFresh = false;
  if (director?.state === "finished") {
    const won = director.outcome === "won";
    if (won) {
      // Winning unlocks the next level.
      const unlocked = Math.min(ORDER.indexOf(levelName) + 2, ORDER.length);
      if (unlocked > (Save.get("maxLevel") | 0)) Save.set("maxLevel", unlocked);
    }
    finishedFor += frameDt;
    if (finishedFor >= RESULTS_DELAY && !leaving) {
      leaving = true;
      returnToTitle(won ? ORDER[(ORDER.indexOf(levelName) + 1) % ORDER.length] : levelName);
    }
  } else if (!leaving) {
    finishedFor = 0;
  }
  raceHud.returnIn = director?.state === "finished" ? Math.max(0, RESULTS_DELAY - finishedFor) : null;

  accumulator += frameDt;
  // Photo mode: once settled, nothing steps — the frame is held still.
  if (photo && photo.settle <= 0) accumulator = 0;
  let controls = input.controls;
  while (accumulator >= WORLD.fixedDt) {
    if (photo) photo.settle--;
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
    controls = photo ? HOLD_STILL : input.update(WORLD.fixedDt, !vehicle.grounded);

    if (race) {
      // Lights before cars: the step the lights go out on is the first
      // step anyone may move. In photo mode they never go out.
      if (!photo) director?.step(WORLD.fixedDt);
      for (const c of race.cars) c.vehicle.savePreviousState();
      const racing = director?.state === "racing";
      // Captures the PLAYER's state before this step's controls move it,
      // so a replay starting here and stepping with frame 0 lands exactly
      // where recording frame 0 did. Lap 2+ begins the instant lap 1 did
      // not (below), mid-corner at racing speed rather than from a
      // standing start — which is exactly where that lap actually began.
      if (racing && recorder && !recorder.recording) recorder.begin(vehicle);
      // Every car is stepped BEFORE the single solve, so no car sees a
      // world the others have not moved in yet.
      recorder?.snapshot(vehicle);
      race.step(WORLD.fixedDt, controls);
      recorder?.capture(controls);
      ghost?.step(WORLD.fixedDt, racing);
    } else {
      vehicle.savePreviousState();
      vehicle.step(WORLD.fixedDt, controls);
    }

    // Level force fields (Level 2's crosswind and friends) reach the car
    // through the track wrapper, never by touching Rapier directly.
    //
    // Every car, not just the player. Applying a gust to the player
    // alone makes the wind read as a handicap aimed at them rather than
    // as weather, and the AI would take the exposed line for free. The
    // ghost needs it too, for the same reason it needs everything else
    // the recording met: skip it here and the ghost drifts off its own
    // recorded line the moment it reaches a crosswind, having met a
    // force the original run did not go without.
    if (level.track && level.track.forceFields.size) {
      const field = race ? race.cars.map((c) => c.vehicle) : [vehicle];
      if (ghost) field.push(ghost.vehicle);
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
    rockfall?.step(WORLD.fixedDt, race ? race.cars : []);

    world.step();

    if (race) {
      // Constraints and progress correct the pose Rapier just produced,
      // so they run after the solver, not before it.
      race.postStep(WORLD.fixedDt);
      ghost?.postStep();
      pits?.postStep(WORLD.fixedDt, race.cars);
      pickups?.update(WORLD.fixedDt, race.cars);
      // Best lap per level, shown in the pause menu — and, if it's a new
      // best, the recording just finished becomes next visit's ghost.
      if (progress?.justCompletedLap) {
        const rec = recorder?.recording ? recorder.end(vehicle) : null;
        Save.submitLap(levelName, progress.lastLapTime, rec);
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
  traffic?.render(alpha);
  rockfall?.render(alpha);
  // Flutter only, driven by the render frame like smoke — the gust
  // itself is a force field, already applied in the fixed step above.
  crosswind?.render(frameDt);
  level.update?.(now / 1000); // per-level animation (the City's wind)
  pickups?.render();
  gates?.update(frameDt, vehicle.s, progress);
  trails?.update(frameDt);
  wetUniforms.uTime.value += frameDt;
  // Render-frame, not fixed-step: smoke changes nothing in the
  // simulation, so it must not cost a physics step or stutter at high
  // frame rates.
  smoke.update(frameDt, race ? race.cars : [{ vehicle }]);
  driftFx.update(frameDt, vehicle.state, carRig);
  wheelGlow.enabled = level?.name === "grandprix";
  wheelGlow.update(
    now / 1000,
    race
      ? race.cars.map((c) => ({ rig: c.rig, state: c.vehicle.state, colour: c.isPlayer ? 0xff6a0a : c.colour, boostOnly: c.isPlayer }))
      : [{ rig: carRig, state: vehicle.state, colour: 0xff6a0a, boostOnly: true }],
    !dashboard.open
  );

  const state = vehicle.state;
  health.update(state.damage);
  fogPatch?.update(vehicle.s);
  pits?.updateHud(vehicle);
  raceHud.update(director, race);
  speedo.update(state, frameDt);
  _mapOthers.length = 0;
  if (race) {
    for (const c of race.cars) {
      if (!c.isPlayer) _mapOthers.push({ position: c.vehicle.state.position, colour: c.colour });
    }
  }
  if (ghost) _mapOthers.push({ position: ghost.vehicle.state.position, ghost: true });
  outline.update(state.position, _mapOthers);
  // One shared slot, one hazard at a time — rockfall first (an incoming
  // boulder is the most acutely urgent), so a falling-rocks trigger can
  // never land on top of "CROSSWIND"/"FOG" and bury it, the way its own
  // separate banner used to.
  const hazard = rockfall?.warning
    ? "ROCKFALL"
    : crosswind?.activeAt(vehicle.s)
      ? "CROSSWIND"
      : fogPatch?.activeAt(vehicle.s)
        ? "FOG"
        : null;
  gameplayHud.update(progress, level.track, state, ghostBestLap, hazard, director?.state === "finished");
  cameraRig.update(frameDt, state, input.look);
  post.speed.update(frameDt, state, camera);

  levelLights.update(state.position);
  if (shelter.zones.length) {
    const k = openSky(vehicle.s);
    hemi.intensity = shelter.hemi * k;
    if (skyEnv) scene.environmentIntensity = shelter.env * k;
  }
  sky.update(frameDt, camera);
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

  adaptive.begin();
  post.render();

  // No hide-list needed: the map camera only sees the track layer and the
  // blips, so the sky dome and debug vectors are never in its pass.
  minimap.update(state);

  input.endFrame();
}

requestAnimationFrame(frame);

window.__dbg = {
  THREE, RAPIER, world, cameraRig, scene, CAR, WORLD, loadLevel,
  get level() { return level; },
  get progress() { return progress; },
  get race() { return race; },
  minimap, menu, Save, input, renderer, health, smoke, gameplayEvents, gameplayHud, driftFx, wheelGlow,
  get pickups() { return pickups; },
  get traffic() { return traffic; },
  get rockfall() { return rockfall; },
  get crosswind() { return crosswind; },
  get fogPatch() { return fogPatch; },
  get ghost() { return ghost; },
  get pits() { return pits; },
  get gates() { return gates; },
  get trails() { return trails; },
  get director() { return director; },
  // physics test harness — see src/core/determinism.js
  determinism: () => import("./core/determinism.js"),
  // render benchmark — see src/debug/benchmark.js
  benchmark: () => import("./debug/benchmark.js"),
  applyQuality,
  QUALITY,
  get vehicle() { return vehicle; },
  // photo mode — see the note by SETTLE_STEPS
  shot(s, lateral = 0) {
    photo = { s, lateral, settle: 0 };
    poseForPhoto();
  },
};

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.resize();
});
