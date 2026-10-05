import * as THREE from "three";

// ---------------------------------------------------------------------
// Armco: a steel crash barrier drawn along the track edge.
//
// Visual only. On a map with soft walls the car is stopped by a
// constraint on lateral offset, and a constraint you cannot see reads as
// an invisible wall. Drawing a barrier exactly where the constraint
// bites makes the edge honest without adding collision geometry that a
// sliding car could catch on.
//
// Swept from the track's own frames, like the generated barriers. On the
// inside of a corner tighter than the offset, a swept strip folds over
// itself, so there the rail is pulled in to 80 % of the corner radius.
// ---------------------------------------------------------------------

const RAIL_LOW = 0.45; // m above the road
const RAIL_HIGH = 0.8;
const POST_EVERY = 4; // m

/**
 * @param {object} track
 * @param {THREE.Scene} scene
 * @param {object} opts
 *   offset  lateral distance of the rail's face from the centre line, m
 *   skip    [{ side: -1 | 1, s0, s1 }] stretches with no barrier (pit wall, gantry legs)
 *   neon    optional { colors, blend, skip }: a glowing strip along the top
 *           of the rail. `colors` split the lap into that many equal
 *           sectors, one colour each, blending over `blend` m (default 40)
 *           either side of each join. Left out over `skip` ([{ s0, s1 }],
 *           both sides) as well as wherever the rail is
 * @returns {THREE.Object3D[]}  added to the scene; push them into track.objects
 */
export function buildArmco(track, scene, { offset, skip = [], neon = null }) {
  const sp = track.spline;
  const n = sp.pos.length;
  const L = track.length;
  const skipped = (side, s) =>
    skip.some((k) => k.side === side && (k.s0 <= k.s1 ? s >= k.s0 && s <= k.s1 : s >= k.s0 || s <= k.s1));
  const unlit = (s) => neon.skip?.some((k) => s >= k.s0 && s <= k.s1) ?? false;
  const sectorColor = neon && sectorPalette(neon.colors, neon.blend ?? 40, L);
  const _col = new THREE.Color();

  const railMat = new THREE.MeshStandardMaterial({
    color: 0xb9c1c7,
    metalness: 0.75,
    roughness: 0.35,
    side: THREE.DoubleSide,
  });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x5b6268, metalness: 0.4, roughness: 0.6 });
  const out = [];

  // Which way the track turns at sample i: +1 right, -1 left.
  const turn = (i) => {
    const a = sp.tan[(i - 1 + n) % n];
    const b = sp.tan[(i + 1) % n];
    return Math.sign((b.x - a.x) * sp.right[i].x + (b.y - a.y) * sp.right[i].y + (b.z - a.z) * sp.right[i].z);
  };

  for (const side of [-1, 1]) {
    const verts = [];
    const idx = [];
    const posts = [];
    const glow = []; // the neon strip: two vertices per ring, v = across the strip
    const glowCol = [];
    const glowIdx = [];
    let glowRun = -1;
    let run = -1; // index of the previous ring in the current unbroken run
    let sinceP = POST_EVERY;
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const s = (i / n) * L;
      if (skipped(side, s)) {
        run = -1;
        glowRun = -1;
        continue;
      }
      const kap = sp.curvature[k];
      let lat = offset;
      if (turn(k) === side && kap > 1e-6) lat = Math.min(offset, 0.8 / kap); // inside of a tight corner
      const p = sp.pos[k], r = sp.right[k], u = sp.up[k];
      const base = verts.length / 3;
      for (const h of [RAIL_LOW, RAIL_HIGH]) {
        verts.push(
          p.x + r.x * lat * side + u.x * h,
          p.y + r.y * lat * side + u.y * h,
          p.z + r.z * lat * side + u.z * h
        );
      }
      if (run >= 0) idx.push(run, base, run + 1, run + 1, base, base + 1);
      run = base;
      if (neon && !unlit(s)) {
        // just proud of the rail's face, so it never z-fights the steel
        const gl = lat - 0.03;
        const g = glow.length / 3;
        sectorColor(s, _col);
        for (const h of [NEON_LOW, NEON_HIGH]) {
          glowCol.push(_col.r, _col.g, _col.b);
          glow.push(
            p.x + r.x * gl * side + u.x * h,
            p.y + r.y * gl * side + u.y * h,
            p.z + r.z * gl * side + u.z * h
          );
        }
        if (glowRun >= 0) glowIdx.push(glowRun, g, glowRun + 1, glowRun + 1, g, g + 1);
        glowRun = g;
      } else glowRun = -1;
      sinceP += sp.step;
      if (sinceP >= POST_EVERY) {
        sinceP = 0;
        posts.push(new THREE.Vector3(p.x + r.x * (lat + 0.12) * side, p.y + 0.4, p.z + r.z * (lat + 0.12) * side));
      }
    }
    if (!idx.length) continue;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const rail = new THREE.Mesh(geo, side < 0 ? railMat : railMat.clone());
    rail.name = `Armco${side < 0 ? "L" : "R"}`;
    rail.castShadow = true;
    rail.receiveShadow = true;
    scene.add(rail);
    out.push(rail);

    const postGeo = new THREE.BoxGeometry(0.12, 0.8, 0.12);
    const inst = new THREE.InstancedMesh(postGeo, side < 0 ? postMat : postMat.clone(), posts.length);
    const m = new THREE.Matrix4();
    posts.forEach((p, j) => inst.setMatrixAt(j, m.makeTranslation(p.x, p.y, p.z)));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    scene.add(inst);
    out.push(inst);

    if (glowIdx.length) {
      const ggeo = new THREE.BufferGeometry();
      ggeo.setAttribute("position", new THREE.Float32BufferAttribute(glow, 3));
      const across = new Float32Array(glow.length / 3);
      for (let j = 1; j < across.length; j += 2) across[j] = 1;
      ggeo.setAttribute("across", new THREE.BufferAttribute(across, 1));
      ggeo.setAttribute("tint", new THREE.Float32BufferAttribute(glowCol, 3));
      ggeo.setIndex(glowIdx);
      const strip = new THREE.Mesh(ggeo, neonMaterial());
      strip.name = `ArmcoNeon${side < 0 ? "L" : "R"}`;
      strip.renderOrder = 5;
      scene.add(strip);
      out.push(strip);
    }
  }
  return out;
}

const NEON_LOW = 0.58; // the strip: a band along the top of the rail, m above the road
const NEON_HIGH = 0.8; // (22 cm: at 10 it thinned to a hairline a few corners away)

/**
 * The colour at distance s: equal sectors round the lap, each eased into
 * the next over `blend` m either side of the join (the last sector blends
 * into the first across the line).
 */
function sectorPalette(colors, blend, L) {
  const pal = colors.map((c) => new THREE.Color(c));
  const n = pal.length;
  const len = L / n;
  const w = Math.min(blend, len / 2);
  return (s, out) => {
    const i = Math.min(n - 1, Math.floor(s / len));
    const into = s - i * len; // m into this sector
    const left = len - into; // m to the next join
    out.copy(pal[i]);
    if (left < w) out.lerp(pal[(i + 1) % n], 0.5 * (1 - left / w)); // easing into the next
    else if (into < w) out.lerp(pal[(i - 1 + n) % n], 0.5 * (1 - into / w)); // easing out of the last
    return out;
  };
}

/**
 * Additive, unlit, brighter than white at its core so bloom picks it up:
 * the strip reads as a tube of light, soft at its top and bottom edges.
 * The colour comes per vertex (`tint`), from the sector it stands in.
 */
function neonMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: `attribute float across; attribute vec3 tint; varying float vAcross; varying vec3 vTint;
      void main(){ vAcross = across; vTint = tint; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vAcross; varying vec3 vTint;
      void main(){
        float edge = 1.0 - abs(vAcross * 2.0 - 1.0);
        float a = pow(edge, 0.5);
        gl_FragColor = vec4(vTint * (1.2 + 1.4 * edge) * a, a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}
