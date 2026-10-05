import * as THREE from "three";

// ---------------------------------------------------------------------
// The sky: a dome with a gradient, a sun (or moon), drifting clouds and,
// at night, stars. All of it is one fragment shader on an inverted
// sphere that follows the camera; there is no texture.
//
// It is DYNAMIC: the clouds move with time (uTime) and the stars
// twinkle, and the sun disc sits exactly where the level's sun light
// comes from (uSunDir, from `lit.sun`), so a shadow always points away
// from the sun you can see.
//
// Per level, through `lit.sky`:
//   top, horizon, bottom  the gradient (the Mountain's fog patch tints
//                         these three at runtime, so the names are kept)
//   clouds      coverage, 0 clear .. 1 overcast
//   cloudColor  the clouds' own colour (white by day, dark at night)
//   stars       0 none .. 1 full starfield
//   sunDisc     brightness of the disc; well above 1 so bloom catches it
//   sunSize     angular radius of the disc, radians
//
// The environment map (src/lighting/sky-environment.js) is baked from
// this same material, so clouds and the sun turn up in reflections.
//
// How each part works, briefly:
//
//   clouds  The view direction is projected onto a flat ceiling
//           (xz / y), which makes cloud shapes shrink toward the
//           horizon the way real ones do. Fractal noise (four octaves
//           of value noise, each finer and fainter) on that plane,
//           scrolled by time, is thresholded by the coverage. The side
//           facing the sun is tinted with the sun's colour.
//   stars   The sphere of directions is cut into a fine 3D grid; a hash
//           of each cell decides whether it holds a star (0.6% do), and
//           the star is a small dot at the cell centre whose brightness
//           wobbles with time. Clouds hide them.
//   sun     The angle between the view direction and the sun direction:
//           a sharp disc where it is tiny, plus a soft halo around it.
// ---------------------------------------------------------------------

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAG = /* glsl */ `
  uniform vec3 uTop, uHorizon, uBottom;
  uniform vec3 uSunDir, uSunColor, uCloudColor;
  uniform float uTime, uClouds, uStars, uSunDisc, uSunSize;
  varying vec3 vDir;

  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float hash2(vec2 p) { return hash3(vec3(p, 0.0)); }
  float noise2(vec2 x) {
    vec2 i = floor(x);
    vec2 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x),
               mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
  }
  // Fractal noise: each octave double the frequency, half the weight.
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise2(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;

    // The gradient, as before.
    vec3 c = h > 0.0
      ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55))
      : mix(uHorizon, uBottom, pow(clamp(-h, 0.0, 1.0), 0.4));

    float toSun = dot(d, normalize(uSunDir));

    // Clouds, only above the horizon.
    float cloud = 0.0;
    if (h > 0.0 && uClouds > 0.0) {
      vec2 uv = d.xz / (h + 0.12) * 1.6;
      uv += vec2(uTime * 0.012, uTime * 0.004); // the wind
      float n = fbm(uv);
      cloud = smoothstep(1.0 - uClouds, 1.0 - uClouds + 0.25, n);
      cloud *= smoothstep(0.0, 0.18, h); // thin out into the haze at the horizon
    }

    // Stars, behind the clouds.
    if (h > 0.0 && uStars > 0.0) {
      // 160 cells per unit of direction makes a star about a pixel and
      // a half across at 1280 wide; any finer and FXAA smoothed them away.
      vec3 g = d * 160.0;
      vec3 cell = floor(g);
      float rnd = hash3(cell);
      if (rnd > 0.994) {
        float dist = length(fract(g) - 0.5);
        float twinkle = 0.6 + 0.4 * sin(uTime * (2.0 + rnd * 4.0) + rnd * 60.0);
        float star = smoothstep(0.3, 0.0, dist) * twinkle;
        c += vec3(star) * 3.0 * uStars * smoothstep(0.0, 0.15, h) * (1.0 - cloud);
      }
    }

    // Sun (or moon): a hard disc and a soft halo.
    float disc = smoothstep(cos(uSunSize), cos(uSunSize * 0.75), toSun);
    float halo = pow(max(toSun, 0.0), 300.0) * 0.6 + pow(max(toSun, 0.0), 12.0) * 0.12;
    c += uSunColor * (disc * uSunDisc + halo) * (1.0 - cloud * 0.85);

    // Clouds over everything, lit from the sun's side.
    vec3 cloudLit = uCloudColor + uSunColor * pow(max(toSun, 0.0), 6.0) * 0.6;
    c = mix(c, cloudLit, cloud * 0.9);

    gl_FragColor = vec4(c, 1.0);
    // Tone-map and encode like every built-in material does, so the dome
    // matches the rest of the scene with bloom on or off.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export const SKY_DEFAULTS = {
  top: 0x3f7fb5,
  horizon: 0xcfe2ea,
  bottom: 0x6f7d6a,
  clouds: 0.3,
  cloudColor: 0xe8eef2,
  stars: 0,
  sunDisc: 12,
  sunSize: 0.03,
};

export class Sky {
  constructor(radius) {
    this.uniforms = {
      uTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uBottom: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uCloudColor: { value: new THREE.Color() },
      uTime: { value: 0 },
      uClouds: { value: 0 },
      uStars: { value: 0 },
      uSunDisc: { value: 0 },
      uSunSize: { value: 0.03 },
    };
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), this.material);
    this.mesh.frustumCulled = false;
  }

  /**
   * @param {object} look      a level's `lit.sky` (anything left out is default)
   * @param {number[]} sunPos  `lit.sun`, the sun's offset from the car
   * @param {number} sunColor
   */
  set(look, sunPos, sunColor) {
    const s = { ...SKY_DEFAULTS, ...look };
    const u = this.uniforms;
    u.uTop.value.set(s.top);
    u.uHorizon.value.set(s.horizon);
    u.uBottom.value.set(s.bottom);
    u.uClouds.value = s.clouds;
    u.uCloudColor.value.set(s.cloudColor);
    u.uStars.value = s.stars;
    u.uSunDisc.value = s.sunDisc;
    u.uSunSize.value = s.sunSize;
    u.uSunDir.value.set(...sunPos).normalize();
    u.uSunColor.value.set(sunColor);
  }

  /** Once per rendered frame: follow the camera, move the clouds. */
  update(dt, camera) {
    this.uniforms.uTime.value += dt;
    this.mesh.position.copy(camera.position);
  }
}
