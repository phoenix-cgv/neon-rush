import * as THREE from "three";
import { CAR } from "../vehicle/config.js";

// A tuning testbed, not a level. Everything here exists to make one
// vehicle behaviour visible:
//
//   flat ground   baseline grip, top speed, braking distance
//   the slalom    turn-in, steering ramp, weight transfer left/right
//   the ramp      airborne control and landing attitude (Level 2)
//   the crest     wheels leaving the ground, spring rebound
//   barriers      contact response and CCD at speed
//
// Level authors: this is also the shape a real level takes — build the
// Three mesh and the Rapier collider from the same numbers, always.

export function buildTestbed(RAPIER, world, scene) {
  const statics = [];
  // Every rigid body this level creates, so it can take them back out.
  // Without this the arena's 16 bodies stayed in the world after a level
  // switch — invisible, because their meshes had been removed from the
  // scene, but still solid. Two visits to the testbed and the next level
  // was being driven through a set of ghost walls.
  const bodies = [];

  const addBox = (w, h, d, x, y, z, color, rotY = 0) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.05 })
    );
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0));
    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(x, y, z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    const body = world.createRigidBody(bodyDesc);
    bodies.push(body);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setFriction(1.0),
      body
    );
    statics.push(mesh);
    return mesh;
  };

  // --- arena ---------------------------------------------------------
  // Closed on all four sides. An open-ended testbed just means you drive
  // off the edge at 240 km/h and fall out of the world, which wastes a
  // run every time you want to test the far end of the course.
  const ARENA = { halfWidth: 22, zStart: 40, zEnd: -620 };
  ARENA.length = ARENA.zStart - ARENA.zEnd;
  ARENA.zMid = (ARENA.zStart + ARENA.zEnd) / 2;

  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x5c6870,
    roughness: 0.95,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(160, 2, ARENA.length + 40),
    groundMat
  );
  ground.position.set(0, -1, ARENA.zMid);
  ground.receiveShadow = true;
  scene.add(ground);
  statics.push(ground);

  const groundBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, ARENA.zMid)
  );
  bodies.push(groundBody);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(80, 1, (ARENA.length + 40) / 2).setFriction(1.0),
    groundBody
  );

  // A grid so speed is legible without reading the HUD.
  const grid = new THREE.GridHelper(ARENA.length + 40, 88, 0x8d9aa2, 0x707d85);
  grid.position.set(0, 0.02, ARENA.zMid);
  scene.add(grid);
  statics.push(grid);

  // --- slalom: weight transfer, turn-in ------------------------------
  // Markers to weave between, 12 m apart. Kept short and thin: these are
  // meant to be brushed past, and a 2.2 m block stops the car dead,
  // which teaches you nothing about turn-in.
  for (let i = 0; i < 8; i++) {
    addBox(0.5, 0.9, 0.5, i % 2 === 0 ? -6 : 6, 0.45, -40 - i * 22, 0xc8532b);
  }

  // --- barriers: contact response and CCD ----------------------------
  for (const sx of [-1, 1]) {
    addBox(1.0, 1.6, ARENA.length, sx * ARENA.halfWidth, 0.8, ARENA.zMid, 0x4a5760);
  }
  // End walls, so a missed braking point costs you a reset and not a
  // ten-second fall.
  const endW = ARENA.halfWidth * 2 + 2;
  addBox(endW, 1.6, 1.0, 0, 0.8, ARENA.zStart, 0x4a5760);
  addBox(endW, 1.6, 1.0, 0, 0.8, ARENA.zEnd, 0x4a5760);

  // --- crest: wheels off the ground, spring rebound ------------------
  //
  // A buried cylinder, so only a shallow cap shows above the ground. The
  // radius is what sets the gradient, NOT the height: a small radius
  // gives a tall bump with near-vertical flanks that the car simply
  // stops against. r = 30 buried to y = -29 leaves a 1 m crest with
  // 15 degree approaches, which unloads the suspension at speed without
  // being a wall.
  //
  // Mesh and collider are built from the SAME numbers, deliberately. The
  // first version drew a half-cylinder and collided a full one, so the
  // thing you could see and the thing you hit were different shapes.
  const CREST = { radius: 30, halfLength: 20, y: -29, z: -150 };

  const crest = new THREE.Mesh(
    new THREE.CylinderGeometry(
      CREST.radius,
      CREST.radius,
      CREST.halfLength * 2,
      48
    ),
    new THREE.MeshStandardMaterial({ color: 0x6d7a82, roughness: 0.92 })
  );
  crest.rotation.z = Math.PI / 2; // cylinder axis -> X, lying across the track
  crest.position.set(0, CREST.y, CREST.z);
  crest.receiveShadow = true;
  scene.add(crest);
  statics.push(crest);

  const cq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
  const crestBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, CREST.y, CREST.z)
  );
  bodies.push(crestBody);
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(CREST.halfLength, CREST.radius)
      .setRotation({ x: cq.x, y: cq.y, z: cq.z, w: cq.w })
      .setFriction(1.0),
    crestBody
  );

  // --- ramp: airborne control and landing (Level 2 rehearsal) --------
  //
  // Forward is -Z, so the car arrives from the +Z side and that end must
  // be the LOW one. A positive rotation about X drops the +Z end; the
  // first version used a negative angle, which stood a 5.2 m wall in the
  // car's path and made the ramp unusable from the only direction you
  // can approach it.
  const RAMP = { w: 14, t: 0.8, len: 20, angle: 0.2, z: -250 };

  // Place the ramp by its DRIVING SURFACE, not its centre line. The slab
  // has thickness, so putting the centre of the low end at ground level
  // leaves the top face half a slab proud — a 0.4 m step the car bumps
  // over instead of a lip it drives up. Sink the low end's top face to
  // y = 0 and the buried half simply disappears into the ground.
  RAMP.cy =
    (RAMP.len / 2) * Math.sin(RAMP.angle) - (RAMP.t / 2) * Math.cos(RAMP.angle);

  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(RAMP.w, RAMP.t, RAMP.len),
    new THREE.MeshStandardMaterial({ color: 0x8a6a9a, roughness: 0.8 })
  );
  ramp.position.set(0, RAMP.cy, RAMP.z);
  ramp.rotation.x = RAMP.angle;
  ramp.castShadow = true;
  ramp.receiveShadow = true;
  scene.add(ramp);
  statics.push(ramp);

  const rq = new THREE.Quaternion().setFromEuler(new THREE.Euler(RAMP.angle, 0, 0));
  const rampBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(0, RAMP.cy, RAMP.z)
      .setRotation({ x: rq.x, y: rq.y, z: rq.z, w: rq.w })
  );
  bodies.push(rampBody);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(RAMP.w / 2, RAMP.t / 2, RAMP.len / 2).setFriction(1.0),
    rampBody
  );

  return {
    name: "testbed",
    track: null, // hand-placed on purpose — see the header
    spawn: new THREE.Vector3(0, CAR.comHeight + 0.05, 0),
    heading: 0,
    statics,
    // Levels with a Track get their cleanup from track.dispose(); this one
    // has no track, so it owns its own.
    dispose() {
      for (const b of bodies) world.removeRigidBody(b);
      bodies.length = 0;
    },
  };
}
