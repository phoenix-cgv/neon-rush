import * as THREE from "three";

/**
 * One steady neon line along each side of the road between s0 and s1 (a
 * tunnel's guardrails), standing on the inside face of the rail. Fades in
 * and out at the ends.
 * @returns {THREE.Group}
 */
export function neonRails(track, s0, s1, { offset = 6, y0 = 0.42, y1 = 0.78, color = [1.0, 0.42, 0.04] } = {}) {
  const group = new THREE.Group();
  group.name = "NeonRails";
  const fr = {};
  for (const side of [-1, 1]) {
    const pos = [], uv = [], idx = [];
    let n = 0;
    for (let s = s0 - 6; s <= s1 + 6; s += 2, n++) {
      track.frameAt(s, fr);
      const c = fr.position.clone().addScaledVector(fr.right, side * offset);
      const a = c.clone().addScaledVector(fr.up, y0);
      const b = c.clone().addScaledVector(fr.up, y1);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      uv.push(0, s, 1, s);
      if (n) { const k = (n - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Vector3(...color) }, uS0: { value: s0 }, uS1: { value: s1 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: `varying vec2 vUv; uniform vec3 uColor; uniform float uS0; uniform float uS1;
        void main(){
          float edge = 1.0 - abs(vUv.x * 2.0 - 1.0);
          float fade = smoothstep(uS0 - 6.0, uS0 + 4.0, vUv.y) * (1.0 - smoothstep(uS1 - 4.0, uS1 + 6.0, vUv.y));
          float a = pow(edge, 0.6) * fade;
          gl_FragColor = vec4(uColor * 1.6 * a, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    group.add(mesh);
  }
  return group;
}
