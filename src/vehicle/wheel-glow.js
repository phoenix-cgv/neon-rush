import * as THREE from "three";
import { CAR } from "./config.js";

// ---------------------------------------------------------------------
// Neon light on the ground behind the rear wheels (the Grand Prix): a soft
// glow pool under each rear tyre and a ribbon of light left along its path
// that fades out over about a second, cyan at the wheel shading to magenta
// as it ages. Purely visual — it reads the rig's wheel positions and never
// touches the simulation.
// ---------------------------------------------------------------------

const MAX = 70; // points per ribbon
const LIFE = 1.15; // s a point of the trail lasts
const SPACING = 0.3; // m between points
const HALF = 0.26; // half the ribbon's width, m

const trailMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { uNow: { value: 0 }, uLife: { value: LIFE } },
    vertexShader: `attribute float aBirth; varying float vAge; uniform float uNow; uniform float uLife;
      void main(){ vAge = clamp((uNow - aBirth) / uLife, 0.0, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vAge;
      void main(){
        vec3 c = mix(vec3(0.10, 0.95, 1.0), vec3(1.0, 0.12, 0.85), smoothstep(0.0, 0.9, vAge));
        float a = (1.0 - vAge); a *= a;
        gl_FragColor = vec4(c * a * 1.7, a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });

function poolTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(40,235,255,1)");
  grad.addColorStop(0.35, "rgba(20,150,255,.5)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class Trail {
  constructor(parent, material) {
    this.pts = []; // { x, y, z, t } newest last
    this.pos = new Float32Array(MAX * 2 * 3);
    this.birth = new Float32Array(MAX * 2);
    const idx = [];
    for (let i = 0; i < MAX - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("aBirth", new THREE.BufferAttribute(this.birth, 1));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    parent.add(this.mesh);
  }

  add(x, y, z, t) {
    const last = this.pts[this.pts.length - 1];
    if (last) {
      const d = Math.hypot(x - last.x, z - last.z);
      if (d > 4) this.pts.length = 0; // a jump (respawn): start a new ribbon
      else if (d < SPACING) return;
    }
    this.pts.push({ x, y, z, t });
    if (this.pts.length > MAX) this.pts.shift();
  }

  rebuild(now) {
    while (this.pts.length && now - this.pts[0].t > LIFE) this.pts.shift();
    const n = this.pts.length;
    for (let i = 0; i < n; i++) {
      const p = this.pts[i];
      const a = this.pts[Math.max(0, i - 1)], c = this.pts[Math.min(n - 1, i + 1)];
      let dx = c.x - a.x, dz = c.z - a.z;
      const m = Math.hypot(dx, dz) || 1;
      dx /= m; dz /= m;
      const nx = -dz * HALF, nz = dx * HALF;
      const k = i * 6;
      this.pos[k] = p.x + nx; this.pos[k + 1] = p.y; this.pos[k + 2] = p.z + nz;
      this.pos[k + 3] = p.x - nx; this.pos[k + 4] = p.y; this.pos[k + 5] = p.z - nz;
      this.birth[i * 2] = this.birth[i * 2 + 1] = p.t;
    }
    this.geo.setDrawRange(0, Math.max(0, n - 1) * 6);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aBirth.needsUpdate = true;
  }
}

const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class WheelGlow {
  constructor(scene) {
    this.scene = scene;
    this.enabled = false;
    this.group = new THREE.Group();
    this.group.name = "WheelGlow";
    scene.add(this.group);
    this.material = trailMaterial();
    this.trails = [new Trail(this.group, this.material), new Trail(this.group, this.material)];
    const tex = poolTexture();
    this.poolMat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.pools = [0, 1].map(() => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.3).rotateX(-Math.PI / 2), this.poolMat);
      m.renderOrder = 3;
      m.material = this.poolMat;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
    this.group.visible = false;
  }

  /**
   * @param {number} now  seconds
   * @param {object} rig  the player's CarRig
   * @param {object} state  vehicle.state
   * @param {boolean} active  false while the title page is up
   */
  update(now, rig, state, active = true) {
    const on = this.enabled && active && !!rig;
    this.group.visible = on;
    if (!on) {
      for (const t of this.trails) t.pts.length = 0;
      return;
    }
    this.material.uniforms.uNow.value = now;
    const moving = (state?.speed ?? 0) > 1.5;
    // the two wheels furthest behind the car's nose
    _fwd.set(0, 0, -1).applyQuaternion(rig.root.quaternion);
    const behind = rig.wheelMeshes
      .map((w) => (w.pivot.getWorldPosition(_p), { w, d: _p.dot(_fwd) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .sort((a, b) => a.w.pivot.position.x - b.w.pivot.position.x);
    for (let i = 0; i < 2; i++) {
      behind[i].w.pivot.getWorldPosition(_p);
      const y = _p.y - CAR.wheelRadius + 0.05;
      this.pools[i].position.set(_p.x, y + 0.01, _p.z);
      if (moving) this.trails[i].add(_p.x, y, _p.z, now);
      this.trails[i].rebuild(now);
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.material.dispose();
    this.poolMat.dispose();
    for (const t of this.trails) t.geo.dispose();
  }
}
