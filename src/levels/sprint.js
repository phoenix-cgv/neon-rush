import * as THREE from "three";
import { Track } from "../track/track.js";
import { dressTrack, startGantry, checkpointMarkers, polarPoints, scatter } from "./common.js";

// ---------------------------------------------------------------------
// LEVEL 1 — Sprint
//
// The level that teaches the car. Wide, open and fast: the corners are
// deliberately inside the tyre limit at full throttle so a new player is
// never punished for not knowing where the grip runs out. What it does
// ask is that they learn the BOOST ECONOMY, which is the mechanic every
// later level assumes they already have.
//
// Boost is earned by drifting and spent on the straights. Telling a
// player that in text does not work; making the fastest line depend on it
// does. The strips below are the teaching device: each one is a forward
// force you only collect by being on the correct side of the road, so
// the reward for placing the car well is immediate and physical rather
// than a number going up on the HUD.
//
// Width 19 against the circuit's 17, and a 7th harmonic instead of a 5th,
// which trades outright corner severity for more direction changes — the
// drift charge comes from the changes, so this shape pays out more boost
// than the race circuit does.
// ---------------------------------------------------------------------

// Forward push, in newtons. The engine makes 9000 N, so a strip is worth
// roughly a third of full throttle for as long as you are on it — enough
// to feel unmistakably like a gain, not enough to drive the lap for you.
const STRIP_FORCE = 3200;
const STRIP_HALF_WIDTH = 3.0; // m either side of the strip centre
const STRIP_LENGTH = 46; // m of track each strip covers

const _fr = {};
const _force = new THREE.Vector3();

export function buildSprint(RAPIER, world, scene) {
  const track = new Track(RAPIER, world, scene, {
    points: polarPoints({
      count: 30,
      base: 205,
      a: 28,
      b: 9,
      harmonic: 7, // more direction changes, none of them severe
      phase1: 0.35,
      phase2: 0.8,
      rise: 1.2,
      riseHarmonic: 2,
    }),
    closed: true,
    width: 19,
    spacing: 2,
    runoffWidth: 1.8,
    barrierSpacing: 9,
    barrierHeight: 3.0,
    checkpointSpacing: 130,
    roadColor: 0x33393f,
    runoffColor: 0x4a5f52,
    barrierColor: 0xb9c6cc,
    fallDepth: 9,
  });

  startGantry(track, scene, RAPIER, { color: 0xdfe6ea, emissive: 0x0d2830 });
  checkpointMarkers(track, scene, { color: 0x37c8d8, emissive: 0x06333a });

  // --- boost strips ----------------------------------------------------
  // Placed on the EXIT of the four longest straights and offset to the
  // inside, so collecting one means getting the corner before it right.
  // A strip in the middle of a straight is free; this way it is earned.
  const strips = [];
  const count = 4;
  for (let i = 0; i < count; i++) {
    const s0 = (i / count) * track.length + 70;
    const s1 = s0 + STRIP_LENGTH;
    // Alternate sides so the level does not reward one line all the way
    // round — the same reason the circuit uses an odd harmonic.
    const lateral = i % 2 === 0 ? -4.2 : 4.2;

    track.addForceField(s0, s1, (ctx) => {
      if (Math.abs(ctx.t - lateral) > STRIP_HALF_WIDTH) return null;
      track.frameAt(ctx.s, _fr);
      // Push along the track, not along the car: a strip should not
      // reward pointing sideways on it.
      return _force
        .copy(_fr.tangent)
        .setY(0)
        .normalize()
        .multiplyScalar(STRIP_FORCE);
    });
    strips.push({ s0, s1, lateral });
  }

  // Draw them. A force you cannot see is a bug report, not a mechanic.
  const stripMat = new THREE.MeshStandardMaterial({
    color: 0x1cb2c8,
    emissive: 0x0e6a7a,
    emissiveIntensity: 1.4,
    roughness: 0.4,
    transparent: true,
    opacity: 0.85,
  });
  const perStrip = 12;
  scatter(
    track,
    scene,
    strips.length * perStrip,
    new THREE.BoxGeometry(STRIP_HALF_WIDTH * 2, 0.06, 2.6),
    stripMat,
    (i, pos, q) => {
      const strip = strips[Math.floor(i / perStrip)];
      const k = i % perStrip;
      const s = strip.s0 + ((k + 0.5) / perStrip) * (strip.s1 - strip.s0);
      track.frameAt(s, _fr);
      pos.copy(_fr.position).addScaledVector(_fr.right, strip.lateral);
      pos.addScaledVector(_fr.up, 0.07);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(_fr.tangent.x, _fr.tangent.z));
    }
  );

  dressTrack(track, scene, {
    trees: 150,
    treeColor: 0x2f5238,
    pylons: 120,
    pylonColor: 0xdfe3e6,
    pylonEmissive: 0x0a1a1e,
    stands: 8,
    standColor: 0x6f7f88,
    groundColor: 0x3f5744,
    groundRadius: 760,
  });

  const gate = track.spawnAt(0);
  return {
    name: "sprint",
    index: 1,
    title: "Sprint",
    track,
    opponents: 0, // solo: learn the car before racing anyone
    pickups: { repair: 5, boost: 7 },
    spawn: gate.position,
    quaternion: gate.quaternion,
    lit: { sun: [80, 95, 25], fog: [0xa9c6d2, 300, 1200], sky: 0xa9c6d2 },
  };
}
