import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FXAAPass } from "three/addons/postprocessing/FXAAPass.js";
import { SpeedFx } from "./speed-fx.js";

// ---------------------------------------------------------------------
// Post-processing: the frame is rendered into an off-screen HDR buffer,
// bloomed, then tone-mapped onto the screen.
//
// Bloom is what makes an emissive surface read as a LIGHT rather than as
// a brightly painted one. The maps already glow (the City's lamps and
// billboards, the Grand Prix's floodlights at 12x), but on screen they
// stop at white. Bloom spills anything brighter than `threshold` into
// its surroundings, which is how the eye reads a light source. It is
// also far cheaper than the alternative: a real light per lamp costs a
// loop iteration in every lit fragment shader (README §8).
//
// Four things that are easy to get wrong:
//
//   HDR buffer. The scene renders into HalfFloat, so values above 1 are
//   kept and the threshold means something. In an 8-bit buffer every
//   emissive would clip to 1.0 and bloom identically to white paint.
//
//   Antialiasing. The canvas's own MSAA does not apply to an off-screen
//   target, and the jaggies come back the moment a composer is added.
//   Asking the target for 4 MSAA samples fixes that but was measured at
//   +6.6 ms a frame on an AMD integrated GPU (the class of machine the
//   labs have) at 1920x935 — a HalfFloat MSAA buffer is expensive to
//   resolve. FXAA, a single full-screen pass that smooths edges it finds
//   in the finished image, does the same job for a fraction of that. It
//   runs after OutputPass because it expects display (sRGB) colours.
//
//   Bloom at half resolution. A glow is blurry by definition, so it is
//   computed from a half-size copy of the frame (UnrealBloomPass halves
//   it again internally) at a quarter of the fill cost.
//
//   Tone mapping happens LAST, in OutputPass. three applies tone mapping
//   only when drawing to the screen, so the RenderPass leaves the buffer
//   linear and the bloom works on real light values, then OutputPass
//   applies the renderer's ACES curve and exposure once, at the end.
//
// After bloom, the speed/boost pass (src/lighting/speed-fx.js) distorts
// and streaks the image from the player's speed and boost.
//
// The minimap is drawn afterwards straight to the canvas, without post.
// ---------------------------------------------------------------------

export const BLOOM_DEFAULTS = {
  // Linear luminance a pixel needs before it blooms. Sunlit white paint
  // reaches about 1.4 in daylight, so the default sits above it: only
  // things that are actually lights should glow.
  threshold: 1.6,
  strength: 0.5,
  radius: 0.35,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    const size = renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(
      size.clone(),
      BLOOM_DEFAULTS.strength,
      BLOOM_DEFAULTS.radius,
      BLOOM_DEFAULTS.threshold
    );
    this.composer.addPass(this.bloom);
    this.speed = new SpeedFx();
    this.composer.addPass(this.speed.pass);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new FXAAPass());
  }

  /** Per-level look: any of { threshold, strength, radius }. */
  setBloom(opts = {}) {
    const b = { ...BLOOM_DEFAULTS, ...opts };
    this.bloom.threshold = b.threshold;
    this.bloom.strength = b.strength;
    this.bloom.radius = b.radius;
  }

  /** After the renderer's pixel ratio or the window size changes. */
  resize() {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);
    // composer.setSize just sized every pass to the full frame; bloom
    // goes back down to half (see the note at the top).
    const pr = this.renderer.getPixelRatio();
    this.bloom.setSize((size.x * pr) / 2, (size.y * pr) / 2);
  }

  render() {
    if (this.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
