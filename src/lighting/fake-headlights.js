import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CAR } from "../vehicle/config.js";
import { MINIMAP_LAYER } from "../ui/minimap.js";

// ---------------------------------------------------------------------
// Headlights for the opponents, without lights.
//
// Real headlights are two SpotLights per car. On the player's car that is
// worth it — they light the actual road and scenery. On five opponents it
// would be ten more lights in every lit fragment shader (README §8
// measured twelve idle ones at a quarter of the frame). What the player
// needs from an opponent's headlights is to SEE them: a beam in the air,
// and a pool of light on the road ahead of the car, sweeping past as it
// overtakes. Both can be drawn rather than computed.
//
// One mesh per car, a child of its chassis, so it pitches and rolls with
// the body and sweeps with every turn for free:
//
//   beam   two cones from the lamps, forward along -Z
//   pool   a quad lying on the road ahead
//
// Both use one small shader. It draws ADDITIVELY (light adds to what is
// behind it, never darkens) and writes no depth, so a beam never hides the
// car in front of it.
//
//   aKind  attribute, 0 = beam, 1 = pool: one geometry, one draw call
//   vUv    along the beam / across and along the pool
//   uStrength  how bright, per car, from GAME STATE: it follows the car's
//          headlamp material, which CarRig dims as the car is damaged.
//          A wrecked opponent's beams die with its lamps.
// ---------------------------------------------------------------------

const BEAM_LENGTH = 16; // m
const BEAM_RADIUS = 2.2; // m at the far end
const POOL_NEAR = 2.5; // m in front of the nose
const POOL_FAR = 18;
const POOL_WIDTH = 6;
const LAMP_FULL = 1.4; // CarRig's undamaged headMat emissiveIntensity

const VERT = `
  attribute float aKind;
  varying vec2 vUv;
  varying float vKind;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vDepth;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vKind = aKind;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    vDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const FRAG = `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  varying float vKind;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vDepth;
  #include <fog_pars_fragment>
  void main() {
    float a;
    if (vKind < 0.5) {
      // Beam: v runs 0 at the lamp to 1 at the far end. Bright at the
      // lamp, fading with distance; and faded where the cone's surface
      // is seen edge-on, so it reads as a soft volume, not a hard cone.
      float along = pow(1.0 - vUv.y, 2.0);
      float facing = abs(dot(vNormalV, vViewDir));
      // Faded out close to the camera, like the smoke (smoke.js). The
      // chase camera sits a couple of metres in front of the car behind
      // the player, i.e. INSIDE that car's beam, and without this the
      // cone washed over the whole screen.
      a = along * facing * 0.1 * smoothstep(3.0, 9.0, vDepth);
    } else {
      // Pool: u across (0..1), v from near (0) to far (1). Brightest a
      // little ahead of the car, soft at every edge.
      float across = 1.0 - pow(abs(vUv.x * 2.0 - 1.0), 2.0);
      float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - vUv.y);
      a = across * along * 0.14;
    }
    gl_FragColor = vec4(uColor * a * uStrength, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // Not three's <fog_fragment>: that blends TOWARD the fog colour, which
    // on an additive surface ADDS fog-coloured light far away. Light in
    // fog should fade to nothing instead.
    #ifdef USE_FOG
      gl_FragColor.rgb *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  }`;

let sharedGeometry = null;

function buildGeometry() {
  const h = CAR.halfExtents;
  const parts = [];
  const tag = (g, kind) => {
    g.setAttribute("aKind", new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(kind), 1));
    return g;
  };
  for (const sx of [-1, 1]) {
    // ConeGeometry has its tip at +Y. Rotating +90 degrees about X sends
    // +Y to +Z (backwards), so the tip sits at the lamp and the cone
    // opens forward along -Z.
    const cone = new THREE.ConeGeometry(BEAM_RADIUS, BEAM_LENGTH, 16, 1, true);
    cone.rotateX(Math.PI / 2);
    cone.translate(sx * h.x * 0.9, -h.y * 0.1 - 0.35, -h.z * 1.14 - BEAM_LENGTH / 2);
    // Cone uv.y is 0 at the base and 1 at the tip; the shader wants 0 at
    // the lamp (the tip).
    const uv = cone.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    parts.push(tag(cone, 0));
  }
  const pool = new THREE.PlaneGeometry(POOL_WIDTH, POOL_FAR - POOL_NEAR);
  pool.rotateX(-Math.PI / 2); // lie flat; plane's +Y (v = 1) now points to -Z, forward
  // On the road: the body origin is the centre of mass, comHeight above
  // it. A couple of centimetres up so it does not z-fight the asphalt.
  pool.translate(0, -CAR.comHeight + 0.03, -h.z - (POOL_NEAR + POOL_FAR) / 2);
  parts.push(tag(pool, 1));
  return mergeGeometries(parts, false);
}

/**
 * Give a CarRig drawn headlights. Call once per car, after it is built.
 * The mesh is a child of the rig, so it leaves the scene with it.
 */
export function addFakeHeadlights(rig, color = 0xfff0d0) {
  sharedGeometry ??= buildGeometry();
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uColor: { value: new THREE.Color(color) }, uStrength: { value: 1 } },
    ]),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  const mesh = new THREE.Mesh(sharedGeometry, material);
  mesh.name = "FakeHeadlights";
  mesh.frustumCulled = false; // the pool reaches well beyond the car's bounds
  mesh.renderOrder = 2;
  mesh.layers.disable(MINIMAP_LAYER);
  // Read the lamps' state just before drawing: no per-frame bookkeeping
  // anywhere else, and a car that is not drawn costs nothing.
  mesh.onBeforeRender = () => {
    material.uniforms.uStrength.value = rig.headMat.emissiveIntensity / LAMP_FULL;
  };
  rig.chassisPivot.add(mesh);
  rig.fakeHeadlights = mesh;
  return mesh;
}
