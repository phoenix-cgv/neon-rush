import * as THREE from "three";
import { CAR } from "./config.js";

// The scene graph for the car — section 4 of the design document.
//
// The hierarchy is doing real work, and each parenting choice has a reason
// you should be able to give out loud:
//
//   CarRig                 world position and heading; physics writes here
//   └── ChassisPivot       body shell, lights, spoiler
//       └── SteeringGroup  yaw from steer input
//           ├── WheelFL    inherits steer AND applies its own spin
//           └── WheelFR
//   └── WheelRL/RR         spin only, no steer
//   └── CameraBoom         child of CarRig, deliberately NOT of ChassisPivot,
//                          so the camera does not inherit suspension shake
//
// Breaking the chain one level early for the camera is a better answer in a
// demonstration than a deeper hierarchy would be: it shows the graph was
// designed rather than accepted.
//
// Nothing here touches CAR.halfExtents, which is the COLLIDER. The shell is
// built around it so the car can look like a car without changing a single
// number the physics depends on.

const PAINT = 0x1d7f8c;
const PAINT_DARK = 0x0d4e58;
const TRIM = 0x0e1417;

function box(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

/** A box tapered along Z — wider at the back than the front. */
function taperedBox(wFront, wBack, h, d, mat) {
  const g = new THREE.BoxGeometry(1, h, d, 1, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const w = z < 0 ? wFront : wBack; // -Z is forward
    p.setX(i, p.getX(i) * w);
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

export class CarRig {
  /** @param {number} paint  body colour, so a field of cars is legible */
  constructor(paint = PAINT) {
    this.root = new THREE.Group();
    this.root.name = "CarRig";

    this.chassisPivot = new THREE.Group();
    this.chassisPivot.name = "ChassisPivot";
    this.root.add(this.chassisPivot);

    const h = CAR.halfExtents; // collider: 0.85 x 0.27 x 2.0

    const bodyMat = new THREE.MeshStandardMaterial({
      color: paint,
      metalness: 0.6,
      roughness: 0.32,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(paint).multiplyScalar(0.55),
      metalness: 0.5,
      roughness: 0.45,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: TRIM,
      metalness: 0.35,
      roughness: 0.7,
    });
    this.bodyMat = bodyMat;

    // --- lower shell ---------------------------------------------------
    const shell = taperedBox(h.x * 1.72, h.x * 1.94, h.y * 1.9, h.z * 1.92, bodyMat);
    shell.name = "BodyMesh";
    shell.castShadow = true;
    this.chassisPivot.add(shell);
    this.body = shell;

    // Side skirts, which read as sills and hide the gap over the wheels.
    for (const sx of [-1, 1]) {
      const skirt = box(0.1, 0.16, h.z * 1.5, trimMat);
      skirt.position.set(sx * h.x * 0.96, -h.y * 0.75, 0);
      skirt.castShadow = true;
      this.chassisPivot.add(skirt);
    }

    // --- cabin ---------------------------------------------------------
    const cabin = taperedBox(h.x * 1.06, h.x * 1.46, 0.34, h.z * 0.92, darkMat);
    cabin.position.set(0, h.y + 0.15, 0.12);
    cabin.castShadow = true;
    this.chassisPivot.add(cabin);

    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x9fd8e8,
      metalness: 0.1,
      roughness: 0.08,
      transparent: true,
      opacity: 0.55,
    });
    const glass = taperedBox(h.x * 0.98, h.x * 1.34, 0.2, h.z * 0.62, glassMat);
    glass.position.set(0, h.y + 0.24, -0.02);
    this.chassisPivot.add(glass);

    // --- nose and tail -------------------------------------------------
    const nose = taperedBox(h.x * 1.3, h.x * 1.72, 0.2, 0.55, bodyMat);
    nose.position.set(0, -h.y * 0.15, -h.z * 0.92);
    nose.castShadow = true;
    this.chassisPivot.add(nose);

    const splitter = box(h.x * 1.8, 0.06, 0.4, trimMat);
    splitter.position.set(0, -h.y * 0.95, -h.z * 1.05);
    this.chassisPivot.add(splitter);

    // Rear wing on two stays — the clearest silhouette cue that this is a
    // car and not a crate, and it reads instantly from the chase camera.
    const wing = box(h.x * 1.85, 0.07, 0.34, trimMat);
    wing.position.set(0, h.y + 0.42, h.z * 0.96);
    wing.castShadow = true;
    this.chassisPivot.add(wing);
    for (const sx of [-1, 1]) {
      const stay = box(0.07, 0.36, 0.1, trimMat);
      stay.position.set(sx * h.x * 0.7, h.y + 0.24, h.z * 0.96);
      this.chassisPivot.add(stay);
    }

    // --- lights --------------------------------------------------------
    // Emissive so they read at dusk and at night without needing a real
    // light source for each one — Level 3 has enough of those already.
    this.headMat = new THREE.MeshStandardMaterial({
      color: 0xfff4d6,
      emissive: 0xfff0c8,
      emissiveIntensity: 1.4,
      roughness: 0.3,
    });
    this.tailMat = new THREE.MeshStandardMaterial({
      color: 0x6b1414,
      emissive: 0xff2a1a,
      emissiveIntensity: 0.35,
      roughness: 0.4,
    });
    for (const sx of [-1, 1]) {
      const lamp = box(0.3, 0.12, 0.08, this.headMat);
      lamp.position.set(sx * h.x * 0.92, -h.y * 0.1, -h.z * 1.14);
      this.chassisPivot.add(lamp);

      const tail = box(0.34, 0.11, 0.07, this.tailMat);
      tail.position.set(sx * h.x * 0.98, h.y * 0.35, h.z * 1.0);
      this.chassisPivot.add(tail);
    }

    // Headlight spots are children of the chassis, so they sweep the road
    // as the car turns and dip as the nose dives — no per-frame code.
    this.headlights = [];
    for (const sx of [-1, 1]) {
      const light = new THREE.SpotLight(0xfff0d0, 0, 70, Math.PI / 7, 0.45, 1.2);
      light.position.set(sx * h.x * 0.9, 0, -h.z);
      light.target.position.set(sx * h.x * 0.9, -0.6, -h.z - 14);
      this.chassisPivot.add(light, light.target);
      this.headlights.push(light);
    }

    // --- wheels --------------------------------------------------------
    this.steeringGroup = new THREE.Group();
    this.steeringGroup.name = "SteeringGroup";
    this.chassisPivot.add(this.steeringGroup);

    const r = CAR.wheelRadius;
    const tyreGeo = new THREE.CylinderGeometry(r, r, 0.3, 22);
    tyreGeo.rotateZ(Math.PI / 2); // cylinder axis -> X, the wheel's spin axis
    const tyreMat = new THREE.MeshStandardMaterial({
      color: 0x14181b,
      roughness: 0.92,
    });
    const rimGeo = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.32, 14);
    rimGeo.rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xc9d3d8,
      metalness: 0.85,
      roughness: 0.28,
    });
    // A spoke plate so the wheels visibly SPIN. A smooth cylinder gives no
    // rotational cue at all, and spinning wheels are most of what sells
    // speed from the chase camera.
    const spokeGeo = new THREE.BoxGeometry(0.34, r * 0.9, 0.07);

    this.wheelMeshes = CAR.wheels.map((wcfg, i) => {
      const wheel = new THREE.Group();
      const tyre = new THREE.Mesh(tyreGeo, tyreMat);
      tyre.castShadow = true;
      wheel.add(tyre);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      wheel.add(rim);
      for (let k = 0; k < 3; k++) {
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        spoke.rotation.x = (k / 3) * Math.PI;
        wheel.add(spoke);
      }
      wheel.name = `Wheel${i}`;

      // Front wheels hang off the steering group so they inherit steer AND
      // apply their own spin — two composed rotations, the textbook
      // hierarchical modelling case. Rear wheels only spin.
      const parent = wcfg.front ? this.steeringGroup : this.chassisPivot;
      const pivot = new THREE.Group();
      pivot.position.set(wcfg.x, wcfg.y, wcfg.z);
      pivot.add(wheel);
      parent.add(pivot);

      // Arch over each wheel, so the body does not look like it is floating.
      const arch = box(0.36, 0.1, r * 2.25, bodyMat);
      arch.position.set(wcfg.x, CAR.mountY - 0.02, wcfg.z);
      arch.castShadow = true;
      this.chassisPivot.add(arch);

      return { mesh: wheel, pivot, front: wcfg.front };
    });

    this.cameraBoom = new THREE.Group();
    this.cameraBoom.name = "CameraBoom";
    this.root.add(this.cameraBoom);
  }

  /**
   * Read the vehicle state and pose the graph. No physics happens here, and
   * no transform maths happens outside it.
   */
  sync(state) {
    this.root.position.copy(state.position);
    this.root.quaternion.copy(state.quaternion);

    this.steeringGroup.rotation.y = -state.steerAngle;

    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const w = state.wheels[i];
      const { mesh, pivot } = this.wheelMeshes[i];
      const springLength = w.grounded
        ? CAR.suspensionRest - w.compressionM
        : CAR.suspensionRest;
      pivot.position.y = CAR.mountY - springLength;
      mesh.rotation.x = w.spinAngle;
    }

    // Brake lights brighten under braking, and the paint picks up a glow
    // while boosting. Both read from state the physics already publishes.
    const braking = state.gear === 1 && state.speed > 1 && state.wheels[0].load > 0;
    this.tailMat.emissiveIntensity = state.boosting ? 1.6 : braking ? 0.9 : 0.35;
    this.bodyMat.emissive.setHex(state.boosting ? 0x1a5f6b : 0x000000);
    this.bodyMat.emissiveIntensity = state.boosting ? 0.8 : 0;
  }

  setHeadlights(on) {
    for (const l of this.headlights) l.intensity = on ? 60 : 0;
    this.headMat.emissiveIntensity = on ? 2.2 : 1.0;
  }
}
