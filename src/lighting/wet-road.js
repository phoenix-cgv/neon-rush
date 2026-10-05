import * as THREE from "three";

// ---------------------------------------------------------------------
// Wet asphalt: puddles and rain ripples, written INTO three's own
// MeshStandardMaterial rather than replacing it.
//
// A ShaderMaterial written from scratch would lose everything the
// standard material already does: the sun's shadows, every light in the
// scene (headlights, the floodlight pool), the environment reflections,
// fog. Instead `onBeforeCompile` edits the standard shader's source just
// before it compiles, inserting a few lines at three of its named
// stages. The surface keeps all of three's lighting and only changes
// what a wet road changes:
//
//   colour     darker inside a puddle (water darkens what it soaks)
//   roughness  damp everywhere, near-mirror in a puddle, so the
//              floodlights and headlights streak across the road
//   normal     rain ripples: rings spreading in each puddle, made by
//              bending the surface normal. This is bump mapping, but
//              with the bumps computed from a formula instead of read
//              from a texture.
//
// PUDDLES are two octaves of value noise in world xz, thresholded by
// `coverage`: big, irregular, fixed to the road.
//
// RIPPLES: the road is divided into 1.1 m cells. Each cell has one drop,
// at a random point, landing at a random moment, repeating. A drop's
// ring radius grows with time since it landed and its height dies away
// as it spreads. Rings stay inside their own cell, so only one cell is
// ever evaluated per pixel. The ring's slope (from two nearby samples,
// a finite difference) tilts the normal: that is what the eye reads as
// a ripple catching the light.
//
// Every patched material shares the same uniforms, so one uTime drives
// them all.
// ---------------------------------------------------------------------

export const wetUniforms = {
  uTime: { value: 0 },
  uPuddles: { value: 0.45 }, // coverage, 0 dry .. 1 flooded
  uDamp: { value: 0.38 }, // roughness between puddles
  uRipples: { value: 1 }, // ripple strength (0 = no rain)
};

const COMMON = /* glsl */ `
  uniform float uTime, uPuddles, uDamp, uRipples;
  varying vec3 vWetPos;

  float wetHash(vec2 p) {
    p = fract(p * vec2(0.3183099, 0.3678794) + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * (p.x + p.y));
  }
  float wetNoise(vec2 x) {
    vec2 i = floor(x);
    vec2 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wetHash(i), wetHash(i + vec2(1, 0)), f.x),
               mix(wetHash(i + vec2(0, 1)), wetHash(i + vec2(1, 1)), f.x), f.y);
  }
  // 0 dry .. 1 standing water.
  float wetPuddle(vec2 xz) {
    float n = 0.65 * wetNoise(xz * 0.11) + 0.35 * wetNoise(xz * 0.31 + 7.0);
    return smoothstep(1.0 - uPuddles, 1.0 - uPuddles + 0.07, n);
  }
  // Height of the ripple surface at xz (arbitrary units).
  float wetRipple(vec2 xz) {
    const float CELL = 1.1;
    vec2 cell = floor(xz / CELL);
    float r1 = wetHash(cell);
    float r2 = wetHash(cell + 17.3);
    vec2 drop = (cell + 0.25 + 0.5 * vec2(r1, r2)) * CELL; // where it lands
    float t = fract(uTime * 0.9 + r1 * 7.0);                 // 0..1 since it landed
    float radius = t * 0.45;                                 // m, stays inside the cell
    float d = length(xz - drop);
    float ring = sin((d - radius) * 40.0) * smoothstep(0.06, 0.0, abs(d - radius));
    return ring * (1.0 - t); // fades as it spreads
  }
`;

/** Patch one standard material. Idempotent: a material is patched once. */
export function makeWet(material) {
  if (material.userData.wet) return;
  material.userData.wet = true;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wetUniforms);

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWetPos;`)
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>\nvWetPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${COMMON}`)
      // Colour: water darkens what it soaks.
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         float wetP = wetPuddle(vWetPos.xz);
         diffuseColor.rgb *= mix(0.85, 0.55, wetP);`
      )
      // Roughness: damp everywhere, almost a mirror in a puddle.
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
         roughnessFactor = mix(uDamp, 0.05, wetP);`
      )
      // Normal: tilt it by the ripple's slope, only where there is water.
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
         if (wetP > 0.01 && uRipples > 0.0) {
           const float E = 0.02;
           float h0 = wetRipple(vWetPos.xz);
           float hx = wetRipple(vWetPos.xz + vec2(E, 0.0));
           float hz = wetRipple(vWetPos.xz + vec2(0.0, E));
           vec3 slope = vec3(h0 - hx, 0.0, h0 - hz) / E * 0.02 * uRipples * wetP;
           normal = normalize(normal + (viewMatrix * vec4(slope, 0.0)).xyz);
         }`
      );
  };
  // Tell three this is a different program from an unpatched standard
  // material, or it may reuse the cached one.
  material.customProgramCacheKey = () => "wet-road";
  material.needsUpdate = true;
}
