import * as THREE from "three";

const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

const MODES = ["chase", "hood", "chaseWide"];

/**
 * Camera rig. The boom hangs off CarRig rather than ChassisPivot, so the
 * camera never inherits suspension roll — see the note in car-rig.js.
 *
 * The chase camera is damped in world space rather than rigidly parented:
 * a rigid chase camera whips around every time the car yaws and is
 * genuinely unpleasant to play. Lag is the feature.
 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 0;
    this.position = new THREE.Vector3(0, 5, 12);
    this.lookAt = new THREE.Vector3();

    this.presets = {
      chase: { offset: new THREE.Vector3(0, 2.4, 7.0), lookAhead: 6, damp: 6, fov: 72 },
      chaseWide: { offset: new THREE.Vector3(0, 4.0, 11.0), lookAhead: 8, damp: 4, fov: 82 },
      hood: { offset: new THREE.Vector3(0, 0.75, -0.4), lookAhead: 14, damp: 40, fov: 78 },
    };
  }

  cycle() {
    this.mode = (this.mode + 1) % MODES.length;
    return MODES[this.mode];
  }

  get modeName() {
    return MODES[this.mode];
  }

  update(dt, state, look) {
    const preset = this.presets[this.modeName];

    // Offset in the car's frame, so the camera sits behind the car
    // whichever way it is pointing.
    _offset.copy(preset.offset);
    if (look) {
      // Free-look swings the boom around the car without moving it.
      _offset.applyAxisAngle(_up, -look.x * 1.8);
    }
    _offset.applyQuaternion(state.quaternion);
    _desired.copy(state.position).add(_offset);

    // Speed pulls the camera back and widens the lens a little, which
    // reads as speed far more strongly than the number on the HUD.
    const speedT = Math.min(state.speed / 55, 1);
    const targetFov = preset.fov + speedT * 8 + (state.boosting ? 12 : 0);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 7);
    this.camera.updateProjectionMatrix();

    // Critically damped follow. A rigid parent would whip on every yaw.
    const k = 1 - Math.exp(-preset.damp * dt);
    this.position.lerp(_desired, k);

    // Look ahead of the car rather than at it.
    _lookAt.set(0, 0, -preset.lookAhead).applyQuaternion(state.quaternion);
    _target.copy(state.position).add(_lookAt);
    _target.y += 1.0;
    this.lookAt.lerp(_target, k);

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.lookAt);
  }

  snapTo(state) {
    const preset = this.presets[this.modeName];
    _offset.copy(preset.offset).applyQuaternion(state.quaternion);
    this.position.copy(state.position).add(_offset);
    this.lookAt.copy(state.position);
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.lookAt);
  }
}
