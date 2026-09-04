import * as THREE from "three";

// ---------------------------------------------------------------------
// The minimap.
//
// A genuine second camera with an ORTHOGRAPHIC projection, rendered into
// a scissored corner of the same canvas — not a 2D canvas drawing of the
// spline. It costs a second pass over the scene, but it is a real view of
// the real world: whatever is on the track appears on it without anyone
// maintaining a parallel 2D representation that can drift out of step.
//
// Cars are far too small to see from 260 m up, so each one also gets a
// BLIP — a flat disc that exists only on layer 1. The main camera is told
// to ignore that layer, the minimap camera to include it, so one set of
// objects serves both views without either seeing the other's furniture.
// ---------------------------------------------------------------------

// Layer 1: blips — the minimap camera sees them, the main camera does not.
// Layer 2: the track surfaces worth drawing on a map. Objects opt in by
//          ENABLING it, so they stay on layer 0 for the main view too.
//
// The minimap camera is restricted to layers 1 and 2, which is the real
// optimisation here: a second full pass over the scene would redraw every
// tree, pylon, grandstand and car from 400 m up, where none of them are
// legible anyway. Skipping them costs nothing visually and most of the
// frame time the map was taking.
export const MINIMAP_LAYER = 1;
export const MAP_WORLD_LAYER = 2;

const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Minimap {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts  { span, size, margin }
   */
  constructor(scene, { span = 260, size = 190, margin = 16 } = {}) {
    this.scene = scene;
    this.span = span;
    this.size = size;
    this.margin = margin;
    this.enabled = true;

    const h = span / 2;
    this.camera = new THREE.OrthographicCamera(-h, h, h, -h, 1, 1200);
    this.camera.layers.set(MINIMAP_LAYER); // drops layer 0 entirely
    this.camera.layers.enable(MAP_WORLD_LAYER); // ...and adds the track
    this.camera.up.set(0, 0, -1); // world -Z is "up" on the map before rotation

    this.blips = [];
    this.group = new THREE.Group();
    this.group.name = "MinimapBlips";
    scene.add(this.group);

    // A frame drawn as two flat rings sitting under the map, so the panel
    // reads as an instrument rather than a hole cut in the scene.
    this.frame = null;
  }

  /** One blip per car. Call again if the field changes. */
  build(cars) {
    for (const b of this.blips) this.group.remove(b.mesh);
    this.blips = [];

    for (const c of cars) {
      // An arrow, not a dot: it shows which way a car is pointing, which
      // is the difference between "someone is there" and "someone is
      // coming back onto the racing line".
      const shape = new THREE.Shape();
      shape.moveTo(0, 7);
      shape.lineTo(-4.6, -5);
      shape.lineTo(0, -2.4);
      shape.lineTo(4.6, -5);
      shape.closePath();
      const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);

      const mat = new THREE.MeshBasicMaterial({
        color: c.isPlayer ? 0xffffff : c.rig.bodyMat.color.getHex(),
        depthTest: false,
        transparent: true,
        opacity: c.isPlayer ? 1 : 0.92,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(c.isPlayer ? 1.5 : 1.2);
      mesh.renderOrder = 5;
      mesh.frustumCulled = false;
      mesh.layers.set(MINIMAP_LAYER); // invisible to the main camera
      this.group.add(mesh);
      this.blips.push({ mesh, car: c });
    }
  }

  /** Follow the player and point the map the way they are driving. */
  update(playerState) {
    const p = playerState.position;
    this.camera.position.set(p.x, p.y + 400, p.z);
    this.camera.lookAt(p.x, p.y, p.z);

    // Rotate the projection so the player's heading is always up the
    // screen. A north-up map is fine for navigation and useless at
    // 140 km/h — you want "what is in front of me" without translating.
    _fwd.set(0, 0, -1).applyQuaternion(playerState.quaternion);
    this.camera.rotation.z = -Math.atan2(_fwd.x, -_fwd.z);

    for (const { mesh, car } of this.blips) {
      const st = car.vehicle.state;
      mesh.position.set(st.position.x, st.position.y + 6, st.position.z);
      _q.copy(st.quaternion);
      _fwd.set(0, 0, -1).applyQuaternion(_q);
      mesh.rotation.set(0, Math.atan2(_fwd.x, _fwd.z) + Math.PI, 0);
    }
  }

  /**
   * Draw into the top-right corner. Called after the main render, with
   * scissor on so it only touches its own rectangle.
   */
  render(renderer, scene) {
    if (!this.enabled) return;

    const w = renderer.domElement.clientWidth;
    const hgt = renderer.domElement.clientHeight;
    const s = this.size;
    const x = w - s - this.margin;
    const y = hgt - s - this.margin;

    renderer.setScissorTest(true);
    renderer.setViewport(x, y, s, s);
    renderer.setScissor(x, y, s, s);
    renderer.clearDepth();
    renderer.render(scene, this.camera);

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, hgt);
  }

  /** @returns {boolean} the new state, so a caller can persist it. */
  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }
}
