// ---------------------------------------------------------------------
// The dissolve effect, shared GLSL.
//
// Used by the checkpoint gates (src/lighting/checkpoint-gates.js) and the
// boost trail (src/lighting/boost-trail.js). Both are custom
// ShaderMaterials that paste these chunks into their own vertex and
// fragment shaders.
//
// THE IDEA, in three lines:
//
//   1. Every point on the surface gets a fixed random-looking number
//      between 0 and 1 from 3D noise of its position: its "threshold".
//   2. A uniform (or attribute) `progress` rises from 0 to 1. Any
//      fragment whose threshold is below progress is DISCARDED: it has
//      dissolved. Because the noise is smooth, what is left is not random
//      speckle but ragged, organic islands that shrink.
//   3. Fragments whose threshold is only JUST above progress are on the
//      edge that is about to go. They are painted in a bright glow colour,
//      bright enough (well above 1.0) that bloom picks them up. That is
//      the glowing rim that eats into the surface.
//
// The vertex shader uses the same number to push the dissolving parts
// outward and upward, so the edge looks like it is breaking off into
// drifting particles rather than just being erased.
//
// Why 3D noise of the OBJECT-SPACE position rather than of the UVs: it
// needs no UVs at all, it is continuous across the seams between faces,
// and it does not stretch on long thin parts like a gate's posts.
// ---------------------------------------------------------------------

/**
 * Value noise in 3D, 0..1. Hash the 8 corners of the unit cube the point
 * is in, then blend them with a smooth curve. Cheap and good enough for a
 * dissolve. `dissolveNoise` adds two octaves (a coarse shape plus finer
 * detail) so the edge is ragged at two scales.
 */
export const NOISE = /* glsl */ `
  float dsHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float dsValueNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f); // smoothstep: no visible grid lines
    return mix(
      mix(mix(dsHash(i + vec3(0, 0, 0)), dsHash(i + vec3(1, 0, 0)), f.x),
          mix(dsHash(i + vec3(0, 1, 0)), dsHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(dsHash(i + vec3(0, 0, 1)), dsHash(i + vec3(1, 0, 1)), f.x),
          mix(dsHash(i + vec3(0, 1, 1)), dsHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float dissolveNoise(vec3 p) {
    return 0.65 * dsValueNoise(p) + 0.35 * dsValueNoise(p * 2.7 + 11.0);
  }
`;

/**
 * Vertex side. Moves a vertex that is dissolving: outward along its
 * normal, up, and with a little time-varying wobble, by how far past
 * its threshold the dissolve has gone.
 *
 *   p        object-space position
 *   n        object-space normal
 *   progress 0 (whole) .. 1 (gone)
 *   seed     the noise value at this vertex
 *   time     seconds, for the wobble
 */
export const DISPLACE = /* glsl */ `
  vec3 dissolveDisplace(vec3 p, vec3 n, float progress, float seed, float time, float strength) {
    float gone = clamp((progress - seed) * 4.0, 0.0, 1.0);
    vec3 drift = n * 0.6 + vec3(0.0, 1.0, 0.0);
    drift += 0.25 * vec3(sin(time * 3.0 + seed * 40.0), 0.0, cos(time * 2.3 + seed * 31.0));
    return p + drift * gone * gone * strength;
  }
`;

/**
 * Fragment side. Returns how much of the glow colour to add here (0 on
 * the plain surface, rising to 1 right at the burning edge), or discards
 * the fragment if it has already dissolved.
 *
 *   threshold  the noise value at this fragment
 *   progress   0 (whole) .. 1 (gone)
 *   edge       width of the glowing rim, in noise units (~0.05-0.12)
 */
export const EDGE = /* glsl */ `
  float dissolveEdge(float threshold, float progress, float edge) {
    // progress is stretched slightly past 0..1 so that 0 shows NO edge
    // (nothing is burning yet) and 1 leaves nothing behind.
    float p = progress * (1.0 + edge) - edge;
    if (threshold < p) discard;
    return 1.0 - smoothstep(0.0, edge, threshold - p);
  }
`;
