import * as THREE from "three";
import { Track } from "../track/track.js";
import { dressTrack, startGantry, checkpointMarkers, polarPoints } from "./common.js";

// ---------------------------------------------------------------------
// LEVEL 3 — Neon Circuit
//
// The race. Five opponents, the widest field the respawn logic is tuned
// for, and no hazards at all: at this point the other cars ARE the
// hazard, and stacking wind on top of a six-car fight would make it
// impossible to tell whether a spin was your mistake or the level's.
//
// This was the first level built on the Track API rather than
// hand-placed boxes, and it exists partly to prove the API works before
// three other people depend on it: if a level cannot be built from
// control points and registerCollider, the API is wrong.
//
// The geometry is left exactly as tuned — the 5th harmonic buys genuine
// left-handers (31% counter-curvature) where the original hand-placed
// loop turned one way the whole way round, so one wall was the outside
// of every corner and cornering load pinned you against it.
// ---------------------------------------------------------------------

export function buildCircuit(RAPIER, world, scene) {
  const track = new Track(RAPIER, world, scene, {
    points: polarPoints({
      count: 30,
      base: 180,
      a: 35, // 2nd harmonic: the long sweeps
      b: 20, // 5th harmonic: this is what creates LEFT-hand corners
      harmonic: 5,
      phase1: 0.6,
      phase2: -1.1,
      rise: 1.8,
    }),
    closed: true,
    width: 17,
    spacing: 2,
    // 1.7x the road, not 3.4x. A runoff only has to be wide enough to
    // recover in — wide enough and its inner edge pinches on the tight
    // corners into invisible collision geometry.
    runoffWidth: 1.7,
    barrierSpacing: 9,
    // A car cresting a rise gets airborne and flies over a low wall — it
    // was measured clearing a 1.5 m barrier by more than a metre. Taller
    // walls and a calmer elevation profile both help, but the guarantee
    // is the off-track reset in Progress, not the wall height.
    barrierHeight: 3.0,
    checkpointSpacing: 130,
    roadColor: 0x3c444a,
    runoffColor: 0x53644b,
    barrierColor: 0x9fb0b8,
    fallDepth: 9,
  });

  startGantry(track, scene, RAPIER);

  checkpointMarkers(track, scene);

  // Depth cues: trees, pylons, grandstands and a ground disc. A road
  // ribbon in a void reads as flat however good the lighting is.
  dressTrack(track, scene);

  const gate = track.spawnAt(0);
  return {
    name: "circuit",
    index: 3,
    title: "Neon Circuit",
    track,
    opponents: 5,
    pickups: { repair: 6, boost: 6 },
    spawn: gate.position,
    quaternion: gate.quaternion,
    lit: { sun: [70, 90, 30], fog: [0x9fbcc9, 260, 1100], sky: 0x9fbcc9 },
  };
}
