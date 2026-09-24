import mapUrl from "../../assets/maps/GrandPrix.glb?url";
import { loadMap, buildMapTrack } from "./glb-map.js";

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
      { match: /^Verge_[LR]$/, friction: 0.8 },
      { match: /^GravelTrap/, friction: 0.6 },
      { match: /^GroundGrass$/, friction: 0.7 },
    ],
    solid: /^(PitWall|TyreWall|GantryPillar)/,
    decals: /^(RacingLine|EdgeLine|StartFinishLine|ApexKerbs)/,
    overlays: /^(Road|Verge|PitLane|GravelTrap|GrassPatch|Lake)/,
    minimap: /^(Road|Verge|PitLane|EdgeLine|ApexKerbs|StartFinishLine)/,
    // Road edge 7 m; the nearest tyre-wall face is at 9.4 m, and the car
    // is 0.85 m either side of its centre.
    wallLimit: 8.4,
    track: { checkpointSpacing: 150 },
  });
  const { track } = map;

  const gate = track.spawnAt(0);
  return {
    name: "grandprix",
    index: 3,
    title: "Grand Prix",
    track,
    opponents: 5, // the full field: this is the race
    pickups: { repair: 6, boost: 8 },
    spawn: gate.position,
    quaternion: gate.quaternion,
    lit: { sun: [80, 95, 25], fog: [0xa9c6d2, 320, 1400], sky: 0xa9c6d2 },
    dispose: map.dispose,
  };
}
