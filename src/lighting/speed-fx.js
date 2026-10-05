import * as THREE from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

// ---------------------------------------------------------------------
// Speed and boost, felt through the screen: a post-processing pass that
// works on the finished image (src/lighting/post.js runs it after bloom,
// before tone mapping).
//
// Everything here is driven by GAME STATE, eased so it never snaps:
//
// (Removed: the heat shimmer and fringing below were too distracting with
// several cars boosting at once; only the vignette is left.)
//
//   heat shimmer  While boosting, the image is wobbled around the car's
//                 tail, as if seen through hot exhaust. This is a
//                 refraction effect: the texture is sampled at an offset
//                 position, which is exactly what light bending through
//                 air of uneven temperature does. The car's tail is
//                 projected to the screen each frame (uCarScreen), so
//                 the shimmer stays on it however the camera swings.
//   fringing      While boosting, red and blue are sampled a little
//                 further out from the centre than green, more so at the
//                 edges: chromatic aberration, a lens under stress.
//   vignette      The edges darken, more while boosting, narrowing the
//                 eye onto the road ahead.
//
// Going fast used to also flicker thin white radial streaks over the
// whole screen. That read as a generic "going fast" screen filter, not
// this game's own look — replaced by WheelGlow (src/vehicle/wheel-glow.js),
// an actual neon trail laid down on the road behind the rear wheels, which
// reads as this car leaving this track rather than a shader over everything.
//
// tDiffuse is the image so far (ShaderPass supplies it); vUv is the
// screen position, 0..1.
// ---------------------------------------------------------------------

const SpeedShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uBoost: { value: 0 }, // 0 .. 1
    uCarScreen: { value: new THREE.Vector2(0.5, 0.3) },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uBoost, uAspect;
    uniform vec2 uCarScreen;
    varying vec2 vUv;

    void main() {
      vec2 uv = vUv;

      // (The heat shimmer round the tail and the red/blue fringing that
      // used to come with boosting are gone: too distracting with several
      // cars on screen. The boost shows as the neon lines behind the
      // wheels instead — src/vehicle/wheel-glow.js.)
      vec2 fromC = uv - 0.5;
      float r2 = dot(fromC, fromC);
      vec3 col = texture2D(tDiffuse, uv).rgb;

      // Vignette.
      col *= 1.0 - smoothstep(0.15, 0.6, r2) * (0.22 + 0.3 * uBoost);

      gl_FragColor = vec4(col, 1.0);
    }`,
};

const REAR = new THREE.Vector3(0, 0, 2.2); // the car's tail, in its own frame
const _p = new THREE.Vector3();

export class SpeedFx {
  constructor() {
    this.pass = new ShaderPass(SpeedShader);
    this.u = this.pass.material.uniforms;
  }

  /**
   * Once per rendered frame, from the player's published state.
   * @param {number} dt
   * @param {object} state  vehicle.state
   * @param {THREE.Camera} camera
   * @param {boolean} active  Whether this level shows the screen-space
   *   boost treatment at all. Grand Prix's own feature, to match its
   *   drift-combo sparks and title (see Vehicle's #drift): City and the
   *   Mountain lean on WheelGlow's neon trail alone, so boosting there
   *   eases this pass back to doing nothing rather than layering a
   *   shimmer/fringing/vignette punch on top of it.
   */
  update(dt, state, camera, active = true) {
    const u = this.u;
    u.uTime.value += dt;
    // Eased: about a quarter of a second to come on or go off.
    const k = 1 - Math.exp(-dt * 8);
    u.uBoost.value += ((active && state.boosting ? 1 : 0) - u.uBoost.value) * k;
    u.uAspect.value = camera.aspect;
    // Where the tail is on screen: car space -> world -> clip -> 0..1.
    // The camera rig moved the camera this frame; refresh its matrices
    // first or the shimmer trails a frame behind the car.
    camera.updateMatrixWorld();
    _p.copy(REAR).applyQuaternion(state.quaternion).add(state.position).project(camera);
    u.uCarScreen.value.set(_p.x * 0.5 + 0.5, _p.y * 0.5 + 0.5);
  }
}
