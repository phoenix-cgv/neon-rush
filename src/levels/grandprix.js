import mapUrl from "../../assets/maps/GrandPrix.glb?url";
import { loadMap, buildMapTrack } from "./glb-map.js";
import { buildArmco } from "./armco.js";

// ---------------------------------------------------------------------
// OFFICIAL MAP 3 — Grand Prix
//
// A full-size permanent circuit, modelled in Blender
// (assets/maps/GrandPrix.glb, fixed by blender/grandprix/fix_grandprix.py):
// 2.7 km, pit straight with garages and a start gantry, grandstands,
// gravel traps and tyre walls. Long straights and mostly fast sweepers,
// closing with a diagonal run down the west side into one slow R30 left
// onto the pit straight — the one corner that punishes arriving flat
// out. It finishes 70 m before the line, so the whole grid lines up on
// straight road.
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
    decals: /^(RacingLine|EdgeLine|StartFinishLine|ApexKerbs)/,
    overlays: /^(Road|Verge|PitLane|GravelTrap|GrassPatch|Lake)/,
    minimap: /^(Road|Verge|PitLane|EdgeLine|ApexKerbs|StartFinishLine)/,
    // Road edge 7 m; the nearest tyre-wall face is at 9.4 m, and the car
    // is 0.85 m either side of its centre.
    wallLimit: 8.4,
    track: { checkpointSpacing: 150 },
  });
  const { track } = map;

  // A steel barrier exactly where the soft wall stops the car, so the
  // edge is something you can see rather than an invisible wall. The
  // rail's face sits a car's half-width outside the wall line. Left out
  // along the pit straight (the pit wall and pit lane are there) and at
  // the gantry's legs.
  const L = track.length;
  for (const o of buildArmco(track, scene, {
    offset: 8.4 + 0.85 + 0.1,
    skip: [
      { side: -1, s0: 40, s1: 760 },
      { side: -1, s0: L - 3, s1: 3 },
      { side: 1, s0: L - 3, s1: 3 },
    ],
  })) {
    track.objects.push(o); // disposed with the track
  }

  const gate = track.spawnAt(0);
  return {
    name: "grandprix",
    index: 3,
    title: "Grand Prix",
    track,
    opponents: 5, // the full field: this is the race
    // A proper race: start lights, three laps, a classification.
    race: { laps: 3 },
    startLamps: map.kept,
    pickups: { repair: 6, boost: 8 },
    spawn: gate.position,
    quaternion: gate.quaternion,
    lit: { sun: [80, 95, 25], fog: [0xa9c6d2, 320, 1400], sky: 0xa9c6d2 },
    dispose: map.dispose,
  };
}
