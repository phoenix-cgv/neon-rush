import * as THREE from "three";

// ---------------------------------------------------------------------
// The City Track's set pieces, built from the provided models:
//
//   ferris wheel   a 50 m wheel on open ground facing the circuit, turning
//   gardens        two flower-bed gardens
//   fountains      two plazas, each ringed with benches
//   crane          a tower crane on a building site
//   benches        everywhere a bench goes, all turned to face what they overlook
//   aircraft       a jet and a small propeller plane circling over the city
//
// Everything here either stands still or is moved by update(t); none of it is
// part of the simulation.
// ---------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);

/** Split a geometry's triangles into those lying wholly below `y` and the rest. */
function splitBelow(geometry, y) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const p = g.attributes.position;
  const low = [], high = [];
  for (let i = 0; i < p.count; i += 3) {
    const under = p.getY(i) < y && p.getY(i + 1) < y && p.getY(i + 2) < y;
    (under ? low : high).push(i);
  }
  const take = (starts) => {
    const out = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) {
      const n = attr.itemSize;
      const arr = new Float32Array(starts.length * 3 * n);
      starts.forEach((s, k) => {
        for (let v = 0; v < 3; v++) for (let c = 0; c < n; c++) arr[(k * 3 + v) * n + c] = attr.getComponent(s + v, c);
      });
      out.setAttribute(name, new THREE.BufferAttribute(arr, n));
    }
    return out;
  };
  return [low.length ? take(low) : null, high.length ? take(high) : null];
}

const centreOf = (geometry) => {
  geometry.computeBoundingBox();
  return geometry.boundingBox.getCenter(new THREE.Vector3());
};

export class CityAmenities {
  /**
   * @param {THREE.Scene} scene
   * @param {object} props  baked models: { name, geometry, material }[] by key
   * @param {object} sites  { ferris, gardens[], fountains[], crane } positions picked by CityNature
   * @param {{x,z,yaw}[]} benchSpots  every bench to stand
   */
  constructor(scene, props, sites, benchSpots) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = "CityAmenities";
    scene.add(this.group);
    this.spinners = []; // { obj, axis, rate }
    this.flyers = []; // { obj, ... }
    this.disposables = [];

    const mesh = (e, mat = e.material) => {
      const m = new THREE.Mesh(e.geometry, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };
    const place = (obj, x, z, yaw = 0, scale = 1, y = 0) => {
      obj.position.set(x, y, z);
      obj.rotation.y = yaw;
      obj.scale.setScalar(scale);
      this.group.add(obj);
      return obj;
    };

    // ---- ferris wheel
    if (props.ferris && sites.ferris) {
      const parts = props.ferris;
      // the part with the most vertices is the wheel proper: its centre is the axle
      const rim = parts.reduce((m, e) => (e.geometry.attributes.position.count > m.geometry.attributes.position.count ? e : m));
      const hub = centreOf(rim.geometry);
      const root = new THREE.Group();
      const wheel = new THREE.Group(); // spins about the axle, on the x axis
      wheel.position.copy(hub);
      root.add(wheel);
      for (const e of parts) {
        e.geometry.computeBoundingBox();
        if (e.geometry.boundingBox.max.y < hub.y + 2) {
          root.add(mesh(e)); // the legs stand still
          continue;
        }
        // the remaining parts turn; any foot pads sharing a mesh with them stay put
        const [feet, turning] = splitBelow(e.geometry, 3);
        if (feet) root.add(mesh({ geometry: feet }, e.material));
        if (turning) {
          const m = mesh({ geometry: turning }, e.material);
          m.position.sub(hub);
          wheel.add(m);
        }
      }
      place(root, sites.ferris.x, sites.ferris.z, sites.ferris.yaw);
      this.spinners.push({ obj: wheel, axis: "x", rate: 0.07 });
    }

    // ---- gardens, fountains, crane
    if (props.garden) for (const s of sites.gardens ?? []) {
      const g = new THREE.Group();
      props.garden.forEach((e) => g.add(mesh(e)));
      place(g, s.x, s.z, s.yaw);
    }
    if (props.fountain) for (const s of sites.fountains ?? []) {
      const g = new THREE.Group();
      props.fountain.forEach((e) => g.add(mesh(e)));
      place(g, s.x, s.z, 0, 3.2, 0.8 * 3.2); // the model is centred on its middle
    }
    if (props.crane && sites.crane) {
      const g = new THREE.Group();
      props.crane.forEach((e) => g.add(mesh(e)));
      place(g, sites.crane.x, sites.crane.z, sites.crane.yaw, 1.6);
    }

    // ---- benches (instanced: wood and iron are two parts)
    if (props.bench && benchSpots.length) {
      const S = 2.4; // the model is 0.7 m long
      for (const e of props.bench) {
        const inst = new THREE.InstancedMesh(e.geometry, e.material, benchSpots.length);
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.frustumCulled = false;
        const m4 = new THREE.Matrix4();
        benchSpots.forEach((b, i) => {
          // the bench faces +x; turn it so that points along (fx, fz)
          m4.compose(
            new THREE.Vector3(b.x, b.y ?? 0.12, b.z).add(new THREE.Vector3(0, 0.27 * S, 0)),
            new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-b.fz, b.fx)),
            new THREE.Vector3(S, S, S)
          );
          inst.setMatrixAt(i, m4);
        });
        inst.instanceMatrix.needsUpdate = true;
        this.group.add(inst);
      }
    }

    // ---- aircraft
    const double = (e) => {
      const m = e.material.clone();
      m.side = THREE.DoubleSide;
      m.fog = false; // stays visible against the haze
      return m;
    };
    if (props.jet) {
      const body = new THREE.Group();
      props.jet.forEach((e) => body.add(mesh(e, double(e))));
      body.scale.setScalar(0.022);
      body.rotation.y = Math.PI; // the model's nose is +z; flying forward is -z
      const root = new THREE.Group();
      root.add(body);
      this.group.add(root);
      this.flyers.push({ root, cx: sites.fly.x, cz: sites.fly.z, rx: 170, rz: 130, alt: 70, period: 60, phase: 0.3, dir: 1, bank: 0.22 });
    }
    if (props.cessna) {
      const body = new THREE.Group();
      for (const e of props.cessna) {
        if (/Propeller/.test(e.name)) continue;
        body.add(mesh(e, double(e)));
      }
      // the propeller turns about its own hub
      const prop = new THREE.Group();
      let hub = null;
      for (const e of props.cessna) {
        if (!/Propeller/.test(e.name)) continue;
        hub ??= centreOf(e.geometry);
        const m = mesh(e, double(e));
        m.position.sub(hub);
        prop.add(m);
      }
      if (hub) {
        prop.position.copy(hub);
        body.add(prop);
        this.spinners.push({ obj: prop, axis: "z", rate: 38 });
      }
      body.scale.setScalar(2.2);
      const root = new THREE.Group();
      root.add(body);
      this.group.add(root);
      this.flyers.push({ root, cx: sites.fly.x + 20, cz: sites.fly.z - 10, rx: 110, rz: 90, alt: 48, period: 32, phase: 2.4, dir: -1, bank: 0.3 });
    }
  }

  /** t in seconds. */
  update(t) {
    for (const s of this.spinners) s.obj.rotation[s.axis] = t * s.rate;
    for (const f of this.flyers) {
      const phi = f.phase + (f.dir * t * Math.PI * 2) / f.period;
      f.root.position.set(f.cx + Math.cos(phi) * f.rx, f.alt + Math.sin(phi * 3) * 3, f.cz + Math.sin(phi) * f.rz);
      // heading: along the tangent of the ellipse
      const tx = -Math.sin(phi) * f.rx * f.dir;
      const tz = Math.cos(phi) * f.rz * f.dir;
      f.root.rotation.set(0, Math.atan2(-tx, -tz), f.bank * f.dir, "YXZ");
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => o.isInstancedMesh && o.dispose());
  }
}
