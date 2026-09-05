import * as THREE from "three";
import { Track } from "../track/track.js";
import { dressTrack, startGantry, checkpointMarkers, polarPoints, scatter } from "./common.js";

// ---------------------------------------------------------------------
// LEVEL 2 — Storm Ridge
//
// The level that takes the grip away. Narrower than Sprint (15 m against
// 19), steeper, and the air is doing something to you almost everywhere.
//
// Three hazards, all built from the Track API rather than by reaching
// into Rapier — which is the point of the level as much as the challenge
// is. If a hazard cannot be expressed as a force field or a registered
// collider, the API is missing something and better to find out here.
//
//   CROSSWIND   lateral force over the exposed ridge sections. Gusts,
//               rather than a constant push: a constant force is just a
//               steering trim you set once and forget, while a gust has
//               to be caught. The gust is a travelling front, so the
//               same corner is not always the hard one.
//
//   UPDRAFT     over the two crests, where wind spilling over a ridge
//               accelerates and lifts. The car is already light at the
//               top of a rise and the natural mistake is to arrive flat
//               out; taking half its weight away at that moment sends it
//               airborne, and the landing-attitude penalty does the rest.
//               It punishes with a bad landing rather than with a wall,
//               which is a mistake the player can see themselves make.
//               (A DOWNdraft was tried first and is the wrong sign: it
//               presses the car into the road and ADDS grip — an aid
//               dressed as a hazard.)
//
//   CHICANE     paired blocks that narrow the road to a single line.
//               Static colliders, so they hurt if you hit them, and
//               placed on the exit of the fastest sections where the
//               temptation to carry speed is strongest.
//
// The wind is the reason this level has only two opponents rather than
// five. A gust that shoves the field into each other reads as the game
// cheating; with a smaller field there is room to be blown off line and
// still recover.
// ---------------------------------------------------------------------

const GUST_PEAK = 5200; // N at the centre of a gust — about 0.44 g sideways
const GUST_PERIOD = 7.5; // s for the gust front to travel one zone
const UPDRAFT = 6000; // N of lift over a crest — about half the car's weight
const _fr = {};
const _force = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

export function buildStorm(RAPIER, world, scene) {
  const track = new Track(RAPIER, world, scene, {
    points: polarPoints({
      count: 30,
      base: 165,
      a: 34,
      b: 14,
      harmonic: 5,
      phase1: -0.4,
      phase2: 2.1,
      rise: 4.6, // real elevation: the crests are the updraft zones
      riseHarmonic: 2,
      risePhase: 1.1,
    }),
    closed: true,
    width: 15,
    spacing: 2,
    runoffWidth: 1.9, // a little more room, because the wind puts you there
    barrierSpacing: 9,
    barrierHeight: 3.2,
    checkpointSpacing: 120,
    roadColor: 0x343b44,
    runoffColor: 0x4b4a42,
    barrierColor: 0x8d949c,
    fallDepth: 10,
  });

  startGantry(track, scene, RAPIER, { color: 0xc9ced6, emissive: 0x241028 });
  checkpointMarkers(track, scene, { color: 0xd8663c, emissive: 0x3a1200 });

  // --- crosswind -------------------------------------------------------
  // Two exposed zones on opposite sides of the lap. Within a zone the
  // gust is a travelling bump rather than a uniform push, so the force
  // depends on WHERE along the zone the car is as well as when.
  const zones = [
    { s0: track.length * 0.08, s1: track.length * 0.30, dir: 1 },
    { s0: track.length * 0.55, s1: track.length * 0.78, dir: -1 },
  ];
  for (const z of zones) {
    const span = z.s1 - z.s0;
    track.addForceField(z.s0, z.s1, (ctx) => {
      // Position of the gust front within the zone, 0..1, travelling.
      const front = (ctx.time / GUST_PERIOD) % 1;
      const here = (ctx.s - z.s0) / span;
      // Wrapped distance to the front, so the bump is continuous at the
      // ends of the zone instead of snapping when it wraps.
      let d = Math.abs(here - front);
      if (d > 0.5) d = 1 - d;
      // A raised cosine: full strength at the front, zero a quarter of
      // the zone away. Smooth, so there is no step for the car to trip on.
      const reach = 0.25;
      if (d > reach) return null;
      const shape = 0.5 * (1 + Math.cos((d / reach) * Math.PI));
      track.frameAt(ctx.s, _fr);
      return _force
        .copy(_fr.right)
        .setY(0)
        .normalize()
        .multiplyScalar(z.dir * GUST_PEAK * shape);
    });
  }

  // --- updraft over the crests -----------------------------------------
  // Found by sampling rather than assumed: the rise is a sine of the
  // angle, but arc length is not proportional to angle on a lobed track,
  // so the crests are not where the formula suggests.
  const crests = findCrests(track, 2);
  for (const cs of crests) {
    track.addForceField(cs - 26, cs + 26, (ctx) => {
      const k = 1 - Math.abs(ctx.s - cs) / 26;
      if (k <= 0) return null;
      // Squared, so the lift builds through the approach instead of
      // switching on under the car at the worst possible moment.
      return _force.set(0, UPDRAFT * k * k, 0);
    });
  }

  // --- chicane blocks --------------------------------------------------
  // Paired, offset, so the gap is off-centre and has to be aimed for.
  const blockMat = new THREE.MeshStandardMaterial({
    color: 0xd9d3c6,
    emissive: 0x2a1408,
    roughness: 0.7,
  });
  const chicanes = [track.length * 0.42, track.length * 0.86];
  for (const cs of chicanes) {
    for (let k = 0; k < 2; k++) {
      const s = cs + k * 14;
      const lateral = k === 0 ? -3.6 : 3.6;
      track.frameAt(s, _fr);
      const p = _fr.position
        .clone()
        .addScaledVector(_fr.right, lateral)
        .addScaledVector(_fr.up, 0.75);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.5, 1.2), blockMat);
      mesh.position.copy(p);
      mesh.quaternion.setFromAxisAngle(_yAxis, Math.atan2(_fr.tangent.x, _fr.tangent.z));
      mesh.castShadow = true;
      track.registerCollider(s - 2, s + 2, RAPIER.ColliderDesc.cuboid(1.6, 0.75, 0.6), {
        position: p,
        quaternion: mesh.quaternion,
        mesh,
      });
    }
  }

  // --- wind socks ------------------------------------------------------
  // The gust is invisible and a player shoved sideways by nothing reads
  // it as a physics bug. These stand in the wind zones and lean the way
  // the wind pushes, so the force has a visible cause before it arrives.
  const sockMat = new THREE.MeshStandardMaterial({
    color: 0xe8622e,
    emissive: 0x40170a,
    roughness: 0.6,
  });
  const socksPerZone = 9;
  scatter(
    track,
    scene,
    zones.length * socksPerZone,
    new THREE.ConeGeometry(0.62, 3.6, 8),
    sockMat,
    (i, pos, q) => {
      const z = zones[Math.floor(i / socksPerZone)];
      const k = i % socksPerZone;
      const s = z.s0 + ((k + 0.5) / socksPerZone) * (z.s1 - z.s0);
      track.frameAt(s, _fr);
      pos
        .copy(_fr.position)
        .addScaledVector(_fr.right, -z.dir * (track.wallLimit + 3.2));
      // Clear of the barrier top, not level with it. At 3 m against a
      // 3.2 m wall they were hidden behind exactly the thing the driver
      // is looking past — a warning you cannot see is not a warning.
      pos.addScaledVector(_fr.up, 6.4);
      // Lean downwind, and lie nearly flat: a sock at 70 degrees off
      // vertical reads as "hard crosswind" at a glance.
      q.setFromAxisAngle(
        new THREE.Vector3(_fr.tangent.x, 0, _fr.tangent.z).normalize(),
        -z.dir * 1.2
      );
    }
  );

  // Masts, so a sock reads as mounted on the ridge rather than floating.
  scatter(
    track,
    scene,
    zones.length * socksPerZone,
    new THREE.CylinderGeometry(0.12, 0.16, 6.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x9aa2a8, roughness: 0.8 }),
    (i, pos) => {
      const z = zones[Math.floor(i / socksPerZone)];
      const k = i % socksPerZone;
      const s = z.s0 + ((k + 0.5) / socksPerZone) * (z.s1 - z.s0);
      track.frameAt(s, _fr);
      pos
        .copy(_fr.position)
        .addScaledVector(_fr.right, -z.dir * (track.wallLimit + 3.2));
      pos.addScaledVector(_fr.up, 3.2);
    }
  );

  dressTrack(track, scene, {
    trees: 110,
    treeColor: 0x3b4436,
    pylons: 130,
    pylonColor: 0xbfc4c9,
    pylonEmissive: 0x231016,
    stands: 6,
    standColor: 0x5f6670,
    groundColor: 0x4a4740,
    groundRadius: 700,
    groundY: -5,
  });

  const gate = track.spawnAt(0);
  return {
    name: "storm",
    index: 2,
    title: "Storm Ridge",
    track,
    opponents: 2,
    pickups: { repair: 7, boost: 5 },
    spawn: gate.position,
    quaternion: gate.quaternion,
    lit: { sun: [-40, 70, -55], fog: [0x6c7684, 150, 720], sky: 0x6c7684 },
  };
}

/**
 * The `n` highest points on the track, by arc length, kept apart so two
 * samples on the same crest do not both count.
 */
function findCrests(track, n) {
  const samples = [];
  for (let s = 0; s < track.length; s += 4) {
    track.frameAt(s, _fr);
    samples.push({ s, y: _fr.position.y });
  }
  samples.sort((a, b) => b.y - a.y);
  const picked = [];
  for (const c of samples) {
    if (picked.some((p) => Math.abs(p - c.s) < track.length * 0.15)) continue;
    picked.push(c.s);
    if (picked.length === n) break;
  }
  return picked;
}
