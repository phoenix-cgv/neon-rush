import mapUrl from "../../assets/maps/GrandPrix.glb?url";
import { loadMap, buildMapTrack } from "./glb-map.js";
import * as THREE from "three";
import { buildArmco } from "./armco.js";

// ---------------------------------------------------------------------
// OFFICIAL MAP 3 — Grand Prix
//
// A full-size permanent circuit, modelled in Blender
// (assets/maps/GrandPrix.glb, rebuilt by blender/grandprix/fix_grandprix.py):
// 2.8 km with pit straight, garages, start gantry, four grandstands full
// of spectators, gravel, continuous tyre walls and floodlights. The lap:
// a 1 km opening straight downhill into Turn 1, a hard stop for an R16
// left hairpin (boards at 300/200/100 m) and a banked R45 right; up the
// back straight to a blind +10 m crest under a sponsor bridge; the esses,
// left-right-left at R40 under the Esses stand; a banked R90 left onto a
// long diagonal; and the banked R30 final corner, which finishes 70 m
// before the line so the whole grid lines up on straight, level road.
//
// The pit lane is a real one (src/track/pit-lane.js): the entry peels off
// before the final corner, the exit merges back after the garages, there
// is a limiter between the two painted lines, and stopping in your box
// repairs the car and refills the boost. Opponents pit only when badly
// damaged.
//
// The limiter is 100 km/h, not a realistic 60: the nine garages (and so
// the limited zone between the painted lines) stretch across most of
// the 760 m level section of the home straight — about a quarter of the
// whole lap — so at 60 the limiter alone was costing upwards of 30 s
// against driving that same stretch on the racing line, on top of the
// detour and the stop itself. A pit stop should cost you the stop and
// the few car-lengths either side of it, not a third of a lap.
//
// The soft wall sits 1.4 m out on the grass verge, just inside the tyre
// walls. It was first set 4 m out, which put the tyre walls inside the
// drivable band — and they are separate 4.6 m blocks with gaps between,
// so a car running wide met a block end-on at 190 km/h and stopped dead.
// Solid: the pit wall along the main straight and the gantry legs, which
// stand right beside the road. The tyre walls stay solid for anything
// that gets past the wall. Rocks are not: a box round a rock is mostly
// invisible wall.
// ---------------------------------------------------------------------

buildGrandPrix.preload = () => loadMap(mapUrl);

// `gltf` is what preload() resolved to — loadLevel in main.js awaits it.
export function buildGrandPrix(RAPIER, world, scene, gltf) {
  const map = buildMapTrack(RAPIER, world, scene, gltf, {
    name: "GrandPrix",
    surfaces: [
      { match: /^Road$/, friction: 1.0 },
      { match: /^PitLane$/, friction: 1.0 },
      { match: /^PitApron$/, friction: 1.0 },
      // Leaving the track costs you. Grass holds about two thirds of what
      // asphalt does and drags like rolling off the throttle; gravel holds
      // half and drags like braking. (grip x tyre grip, rolling = extra
      // rolling resistance as a fraction of wheel load.)
      { match: /^Verge_[LR]$/, friction: 0.8, grip: 0.65, rolling: 0.1 },
      { match: /^GravelTrap/, friction: 0.6, grip: 0.5, rolling: 0.3 },
      { match: /^GroundGrass$/, friction: 0.7, grip: 0.65, rolling: 0.1 },
    ],
    solid: /^(PitWall|TyreWall|GantryPillar)/,
    // The five lamps on the start gantry, lit one by one by the race director.
    keep: /^StartLamp\d*$/,
    // The pit road overlaps the track where it peels off and rejoins, so it
    // is drawn over the road like the paint is.
    decals: /^(RacingLine|EdgeLine|StartFinishLine|ApexKerbs|PitLane|PitLine|PitLimit|PitBox)/,
    overlays: /^(Road|Verge|PitApron|GravelTrap|GrassPatch|Lake)/,
    minimap: /^(Road|Verge|PitLane|EdgeLine|ApexKerbs|StartFinishLine)/,
    // Road edge 7 m; the nearest tyre-wall face is at 10.3 m, and the car
    // is 0.85 m either side of its centre.
    wallLimit: 8.4,
    track: { checkpointSpacing: 150 },
    // The pit road and its markers, for the PitLane (src/track/pit-lane.js).
    pit: { ribbon: "PitLane", boxes: /^PitBox/, limits: /^PitLimit/ },
  });
  const { track } = map;

  // A steel barrier exactly where the soft wall stops the car, so the
  // edge is something you can see rather than an invisible wall. The
  // rail's face sits a car's half-width outside the wall line. Left out
  // wherever the pit road runs beside the track (the pit wall is there,
  // and the pit entry and exit must stay open) and at the gantry's legs.
  const L = track.length;
  const offset = 8.4 + 0.85 + 0.1;
  const skip = [
    { side: -1, s0: L - 3, s1: 3 },
    { side: 1, s0: L - 3, s1: 3 },
    ...pitSkips(track, map.pit, offset),
  ];
  for (const o of buildArmco(track, scene, { offset, skip })) {
    track.objects.push(o); // disposed with the track
  }

  const gate = track.spawnAt(0);
  return {
    name: "grandprix",
    index: 3,
    title: "Grand Prix",
    track,
    opponents: 5, // the full field: this is the race
    // A proper race: start lights, two laps, a classification. timeLimit
    // scales with laps (was 8 min for three) rather than being a fixed
    // ceiling, so it stays exactly as generous relative to a real race
    // distance as it always was.
    race: { laps: 2, timeLimit: (8 * 60 * 2) / 3 },
    startLamps: map.kept,
    // A real pit stop: repaired and refuelled with boost in your box in
    // about three seconds; opponents pit when badly damaged. The limiter
    // is 100 km/h, not the usual 60 — see the note near the top of this
    // file for why.
    pit: { data: map.pit, limitKmh: 100, repairTime: 3, aiDamage: 0.5 },
    pickups: { repair: 6, boost: 8 },
    spawn: gate.position,
    quaternion: gate.quaternion,
    // Night, after rain. The only daylight is a dim blue moon; the scene
    // is lit by what glows in the map (floodlights, tunnel strips, the big
    // screen, banners) through bloom, plus a handful of REAL lights that
    // follow the player between those fixtures (src/lighting/light-pool.js):
    // four floodlight spots out of eleven towers, two tunnel lights out of
    // fifteen strips. Far fixtures only glow; near ones light the road.
    //
    // The asphalt is glossy because it is wet, so it picks up the
    // floodlights, the tunnel strips and the headlights as streaks.
    lit: {
      sun: [-60, 95, 40], // the moon
      sunColor: 0x9fb4ff,
      sunIntensity: 0.45,
      hemi: [0x2a3550, 0x0a0a10, 0.3],
      sky: { top: 0x03050c, horizon: 0x1b2140, bottom: 0x050508 },
      fog: [0x0d1222, 140, 700],
      exposure: 1.1,
      envIntensity: 0.6,
      bloom: { threshold: 1.5, strength: 0.45, radius: 0.25 },
      headlights: true,
      glow: 0xff3cc8, // neon magenta against the night
      emissive: { TunnelLights: 0.45 },
      materials: { Asphalt: { roughness: 0.32 }, AsphaltWorn: { roughness: 0.4 } },
      pools: [
        { material: "FloodlightGlow", count: 4, type: "spot", color: 0xdfe8ff, intensity: 15000, distance: 160, angle: 0.75, penumbra: 0.7, fade: 40 },
        { material: "TunnelLights", count: 2, type: "point", color: 0xffc68a, intensity: 150, distance: 30, fade: 20 },
      ],
    },
    dispose: map.dispose,
  };
}

/**
 * Stretches of the track, per side, where the pit road runs within reach
 * of the armco line: the rail would stand across the pit entry and exit,
 * or behind the pit wall.
 */
function pitSkips(track, pit, offset) {
  if (!pit) return [];
  const centres = pit.left.map((a, i) => a.clone().add(pit.right[i]).multiplyScalar(0.5));
  const halves = pit.left.map((a, i) => Math.hypot(a.x - pit.right[i].x, a.z - pit.right[i].z) / 2);
  const side = Math.sign(track.project(centres[centres.length >> 1], null).t) || -1;
  const fr = {};
  const p = new THREE.Vector3();
  const out = [];
  let run = null;
  const step = 2;
  for (let s = 0; s <= track.length; s += step) {
    track.frameAt(s, fr);
    p.copy(fr.position).addScaledVector(fr.right, side * offset);
    let near = false;
    for (let i = 0; i < centres.length; i += 2) {
      const dx = centres[i].x - p.x;
      const dz = centres[i].z - p.z;
      const r = halves[i] + 4;
      if (dx * dx + dz * dz < r * r) {
        near = true;
        break;
      }
    }
    if (near && !run) run = { side, s0: Math.max(0, s - step), s1: s };
    else if (near) run.s1 = s;
    else if (run) {
      run.s1 += step;
      out.push(run);
      run = null;
    }
  }
  if (run) out.push({ ...run, s1: track.length });
  return out;
}
