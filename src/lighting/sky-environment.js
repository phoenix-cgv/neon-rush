import * as THREE from "three";

// ---------------------------------------------------------------------
// Image-based lighting from the level's own sky.
//
// Every MeshStandardMaterial in the game has a reflection term, but with
// no environment map there is nothing for it to reflect: metal paint,
// glass and (later) wet asphalt all come out flat, and glTF's default
// material — fully metallic — renders near-black whatever its colour.
//
// Rather than download an HDR image per level, the environment is baked
// from the sky dome the level already has. The dome is drawn into a cube
// map once and pre-filtered (PMREM) so rough surfaces get a blurred
// reflection and smooth ones a sharp one. A dusk sky therefore puts dusk
// in the paintwork, and a night sky puts night there, with no asset to
// keep in step with the lighting.
//
// Baked once per level load, not per frame: the dome only changes when
// the level does. (The Mountain's fog patch tints the dome at runtime;
// reflections keep the clear-sky colours through it, which is not
// noticeable through the fog itself.)
// ---------------------------------------------------------------------

export class SkyEnvironment {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Material} skyMaterial  the dome's material, shared, so the
   *   bake always sees the uniforms the level has just set
   * @param {number} radius  the dome's radius, m
   */
  constructor(renderer, skyMaterial, radius) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.radius = radius;
    this.scene = new THREE.Scene();
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), skyMaterial);
    this.scene.add(this.dome);
    this.target = null;
  }

  /** Re-bake from the dome's current colours. @returns {THREE.Texture} */
  bake() {
    // far must reach the dome: PMREM's default far plane (100 m) sits
    // inside it and would bake an empty, black environment.
    const target = this.pmrem.fromScene(this.scene, 0, 1, this.radius * 1.1);
    this.target?.dispose();
    this.target = target;
    return target.texture;
  }

  dispose() {
    this.target?.dispose();
    this.dome.geometry.dispose();
    this.pmrem.dispose();
  }
}
