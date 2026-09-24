import mapUrl from "../../assets/maps/MountainTrack.glb?url";
import { loadMap, buildMapTrack } from "./glb-map.js";

// ---------------------------------------------------------------------
// OFFICIAL MAP 3 — Mountain Track
//
// A hill climb and descent round a mountain, modelled in Blender
// (assets/maps/MountainTrack.glb). 1.46 km, 10 m of road — the narrowest
// of the three — climbing from 5 m to 83 m, through an open-topped
// tunnel at the summit and back down over a viaduct. The road is banked
// the whole way round, mostly 5-15 degrees and up to 33.
//
// Unlike the other two maps this one has real barriers: continuous
// guardrails on both sides, 5.65 m from the centre, which collide as
// their own mesh — so no soft wall. The terrain is scenery only: the
// rails keep every car on the road, and a 45 000-triangle mountain would
// be a lot of collision geometry for nobody to touch.
//
// The corner just after the start line is a 6 m hairpin banked the
// WRONG way — its inside edge is 6 m above its outside (33 degrees
// off-camber), as modelled. Track.cornerSpeedAt accounts for banking, so
// the AI slows for it; a player will have to as well.
//
// Mesh names are as three.js sanitises them: spaces become underscores.
// ---------------------------------------------------------------------

buildMountain.preload = () => loadMap(mapUrl);

// `gltf` is what preload() resolved to — loadLevel in main.js awaits it.
export function buildMountain(RAPIER, world, scene, gltf) {
  const map = buildMapTrack(RAPIER, world, scene, gltf, {
    name: "MountainTrack",
    roadName: "Mountain_Race_Track",
    surfaces: [{ match: /^Mountain_Race_Track$/, friction: 1.0 }],
    walls: /^Guardrail_(Left|Right)$/,
    decals: /^(White_Edge|Yellow_Centre|Race_Direction_Arrow|Start_Finish_Checker|Red_White_Curb)/,
    minimap: /^(Mountain_Race_Track|White_Edge|Guardrail_(Left|Right)$)/,
    // The rails are the boundary, as on a generated track, and wallLimit
    // is where they stand. A soft wall here fought the rails: where the
    // centreline and the modelled road disagree by even half a metre, it
    // held cars short of a rail they could see and they stalled there.
    softWalls: false,
    wallLimit: 5.65,
    // Light smoothing only. The default (6 m, 3 passes) rounds the 6 m
    // hairpin at the start into a line 3.3 m off the modelled road; this
    // keeps within 0.6 m. The ribbon is evenly sampled and needs little.
    centreline: { spacing: 3, passes: 1 },
    track: { checkpointSpacing: 120 },
  });
  const { track } = map;

  const gate = track.spawnAt(0);
  return {
    name: "mountain",
    index: 3,
    title: "Mountain Track",
    track,
    // Three: 10 m of road between rails is two cars wide, not three.
    opponents: 3,
    pickups: { repair: 4, boost: 5 },
    spawn: gate.position,
    quaternion: gate.quaternion,
    lit: { sun: [70, 110, 40], fog: [0xa7bccb, 260, 1000], sky: 0xa7bccb },
    dispose: map.dispose,
  };
}
