import * as THREE from "three";
import { CAR } from "./config.js";

// ---------------------------------------------------------------------
// Neon light on the ground behind the rear wheels (the Grand Prix): a soft
// glow pool under each rear tyre and a thin ribbon of light left along its
// path that fades out over about a second. The player's is neon orange and
// only lit while boosting; every rival's is the colour of its own body.
// Purely visual — it reads the rigs' wheel positions and never touches the
// simulation.
// ---------------------------------------------------------------------

const MAX = 70; // points per ribbon
const LIFE = 1.0; // s a point of the trail lasts
const SPACING = 0.3; // m between points
const HALF = 0.11; // half the ribbon's width, m

const trailMaterial = (colour) =>
  new THREE.ShaderMaterial({
    uniforms: { uNow: { value: 0 }, uLife: { value: LIFE }, uColor: { value: new THREE.Color(colour) } },
    vertexShader: `attribute float aBirth; varying float vAge; uniform float uNow; uniform float uLife;
      void main(){ vAge = clamp((uNow - aBirth) / uLife, 0.0, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vAge; uniform vec3 uColor;
      void main(){
        // hot white-tinted at the wheel, settling to the pure colour as it fades
        vec3 c = mix(uColor * 1.5 + vec3(0.18), uColor, smoothstep(0.0, 0.5, vAge));
        float a = (1.0 - vAge); a *= a;
        gl_FragColor = vec4(c * a * 1.5, a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });

let _pool = null;
function poolTexture() {
  if (_pool) return _pool;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,.4)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return (_pool = new THREE.CanvasTexture(c));
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

/** One car's pair of trails and pools. */
class CarGlow {
  constructor(parent, colour) {
    this.rear = null;
    this.group = new THREE.Group();
    parent.add(this.group);
    this.material = trailMaterial(colour);
    this.trails = [new Trail(this.group, this.material), new Trail(this.group, this.material)];
    this.poolMat = new THREE.MeshBasicMaterial({
      map: poolTexture(), color: colour, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      fog: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.pools = [0, 1].map(() => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2), this.poolMat);
      m.renderOrder = 3;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
  }

  /** @param {boolean} lit  whether new light is being laid down */
  update(now, rig, speed, lit, dt) {
    this.material.uniforms.uNow.value = now;
    this.poolMat.opacity += ((lit ? 0.85 : 0) - this.poolMat.opacity) * Math.min(1, dt * 10);
    // The two rear wheels, fixed once from the rig's own layout (the nose points -z, so the
    // rear has the larger z), left one first. Picking them afresh each frame by world
    // position let the pair swap places, which tangled the two ribbons together.
    this.rear ??= rig.wheelMeshes
      .map((w, k) => ({ k, x: w.pivot.position.x, z: w.pivot.position.z }))
      .sort((a, b) => b.z - a.z)
      .slice(0, 2)
      .sort((a, b) => a.x - b.x)
      .map((e) => rig.wheelMeshes[e.k]);
    const behind = this.rear.map((w) => ({ w }));
    for (let i = 0; i < 2; i++) {
      behind[i].w.pivot.getWorldPosition(_p);
      const y = _p.y - CAR.wheelRadius + 0.05;
      this.pools[i].position.set(_p.x, y + 0.01, _p.z);
      this.pools[i].visible = this.poolMat.opacity > 0.01;
      if (lit && speed > 1.5) this.trails[i].add(_p.x, y, _p.z, now);
      this.trails[i].rebuild(now);
    }
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.material.dispose();
    this.poolMat.dispose();
    for (const t of this.trails) t.geo.dispose();
  }
}

export class WheelGlow {
  constructor(scene) {
    this.scene = scene;
    this.enabled = false;
    this.group = new THREE.Group();
    this.group.name = "WheelGlow";
    scene.add(this.group);
    this.cars = new Map(); // rig -> CarGlow
    this.last = 0;
  }

  /**
   * @param {number} now  seconds
   * @param {{rig: object, state: object, colour: number, boostOnly?: boolean}[]} cars
   * @param {boolean} active  false while the title page is up
   */
  update(now, cars, active = true) {
    const dt = Math.min(0.1, Math.max(0, now - this.last));
    this.last = now;
    const on = this.enabled && active;
    this.group.visible = on;
    // drop the glow of cars that have gone (a restarted race builds new rigs)
    for (const [rig, g] of this.cars) {
      if (!on || !cars.some((c) => c.rig === rig)) {
        g.dispose();
        this.cars.delete(rig);
      }
    }
    if (!on) return;
    for (const c of cars) {
      if (!c.rig?.wheelMeshes) continue;
      let g = this.cars.get(c.rig);
      if (!g) this.cars.set(c.rig, (g = new CarGlow(this.group, c.colour)));
      const speed = c.state?.speed ?? 0;
      g.update(now, c.rig, speed, c.boostOnly ? !!c.state?.boosting : speed > 3, dt);
    }
  }

  dispose() {
    for (const g of this.cars.values()) g.dispose();
    this.scene.remove(this.group);
  }
}
