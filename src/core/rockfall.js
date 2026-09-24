import * as THREE from "three";
import { GROUP, ALL } from "../vehicle/vehicle.js";

// ---------------------------------------------------------------------
// Rockfall: boulders that come down the slope onto the road.
//
// A hazard has to be fair to be fun, so every rock is readable:
//
//   SIGNS     each zone has a falling-rocks warning sign on its approach.
//   WARNING   a trickle of small stones comes down the slope a second
//             before the boulder, and "ROCKFALL" flashes on screen.
//   AHEAD     a boulder always lands well ahead of the car (the landing
//             point is chosen from the car's speed), never on it, and on
//             the uphill half of the road, so there is always a lane.
//   SOLID     once it settles it is a solid obstacle: hitting it is a
//             crash like hitting a wall. After you are past it, it sinks
//             away.
//
// Zones are stretches of road with a real slope above them. Which side is
// uphill is measured from the terrain, not configured, so the zones stay
// right if the map is regenerated.
//
// Rocks are scripted, not simulated: a falling rock is drawn only, and
// becomes a kinematic body (like traffic) when it comes to rest. A
// boulder that simulated its way down could land on a car, and a
// kinematic body moving into a dynamic one crushes it into the road.
// Stepped on the fixed step, before world.step().
// ---------------------------------------------------------------------

const WARN_TIME = 1.0; // s of small stones before the boulder
const FALL_TIME = 1.3; // s from the ledge to the road
const BOUNCE_TIME = 0.45;
const ROLL_TIME = 0.9;
const SINK_TIME = 0.8;
const SOURCE_OUT = 16; // m uphill of the landing point that the rock starts
const SOURCE_UP = 15; // m above it
const LANE_EDGE = 4.4; // a resting rock's centre stays within this of the centre line
const CLEAR_AHEAD = 35; // m a boulder lands in front of the car, at least
const TRIGGER_BEFORE = 130; // m before a zone that its rocks are set off
const MAX_ROCKS = 5;

const _fr = {};
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

const easeOut = (t) => 1 - (1 - t) * (1 - t);

export class Rockfall {
  /**
   * @param {object} RAPIER
   * @param {object} world
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {object} opts
   *   zones   [{ s0, s1 }] metres round the lap where rocks can fall
   *   ground  THREE.Object3D[] the terrain, to tell uphill from downhill
   *   signOffset  lateral distance of the warning signs, m
   */
  constructor(RAPIER, world, scene, track, opts = {}) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.scene = scene;
    this.track = track;
    this.rocks = [];
    this.objects = [];
    this.warnFor = 0;

    this.zones = (opts.zones ?? [])
      .map((z) => ({ ...z, side: this.#uphillSide(z, opts.ground ?? []), armed: true }))
      .filter((z) => z.side !== 0); // no slope above it, no rocks
    for (const z of this.zones) this.#sign(z, opts.signOffset ?? 7.6);

    this.#buildMeshes();
    this.#buildBanner();
  }

  // -------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------

  /** +1 if the ground rises on the track's right, -1 on its left, 0 if neither. */
  #uphillSide(z, ground) {
    if (!ground.length) return 0;
    const ray = new THREE.Raycaster();
    let rise = 0;
    let samples = 0;
    for (let s = z.s0; s <= z.s1; s += 25) {
      this.track.frameAt(s, _fr);
      const h = (side) => {
        _v.copy(_fr.position).addScaledVector(_fr.right, side * 24);
        _v.y += 300;
        ray.set(_v, DOWN);
        const hit = ray.intersectObjects(ground, true)[0];
        return hit ? hit.point.y - _fr.position.y : null;
      };
      const r = h(1);
      const l = h(-1);
      if (r === null || l === null) continue;
      rise += r - l;
      samples++;
    }
    if (!samples || Math.abs(rise / samples) < 6) return 0;
    return Math.sign(rise);
  }

  /** A yellow falling-rocks sign on the approach to a zone. */
  #sign(z, offset) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    g.translate(64, 64);
    g.rotate(Math.PI / 4);
    g.fillStyle = "#111";
    g.fillRect(-44, -44, 88, 88);
    g.fillStyle = "#f2c200";
    g.fillRect(-39, -39, 78, 78);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#111";
    // a slope and three rocks tumbling off it
    g.beginPath();
    g.moveTo(34, 88);
    g.lineTo(34, 40);
    g.lineTo(62, 88);
    g.closePath();
    g.fill();
    for (const [x, y, r] of [[60, 52, 7], [74, 66, 6], [84, 82, 5]]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const s = z.s0 - 70;
    this.track.frameAt(s, _fr);
    const base = _fr.position.clone().addScaledVector(_fr.right, z.side * offset);
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 2.8, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x8c9296, metalness: 0.5, roughness: 0.5 })
    );
    post.position.copy(base).add(new THREE.Vector3(0, 1.4, 0));
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 1.8),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide })
    );
    face.position.copy(base).add(new THREE.Vector3(0, 3.1, 0));
    // Face the oncoming car: look back down the road.
    face.lookAt(_v.copy(face.position).addScaledVector(_fr.tangent, -10));
    for (const o of [post, face]) {
      o.castShadow = true;
      this.scene.add(o);
      this.objects.push(o);
    }
  }

  #buildMeshes() {
    // A boulder: an icosahedron with its corners pushed about, flat-shaded
    // so it reads as broken rock. Deterministic, so every rock is the
    // same shape at a different size and spin.
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      const k = 0.78 + 0.34 * Math.abs(Math.sin(_v.x * 12.9 + _v.y * 78.2 + _v.z * 37.7));
      _v.multiplyScalar(k);
      _v.y *= 0.82;
      pos.setXYZ(i, _v.x, _v.y, _v.z);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x7a6f66, roughness: 0.95, flatShading: true });
    this.boulders = new THREE.InstancedMesh(geo, mat, MAX_ROCKS);
    this.boulders.castShadow = true;
    this.boulders.receiveShadow = true;
    this.boulders.frustumCulled = false;
    this.boulders.count = 0;

    // Small stones, the warning. Visual only.
    this.stones = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.18, 0), mat, MAX_ROCKS * 10);
    this.stones.frustumCulled = false;
    this.stones.count = 0;

    // Dust where a boulder lands.
    this.dust = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xb8ab98, transparent: true, opacity: 0.35, depthWrite: false }),
      MAX_ROCKS * 6
    );
    this.dust.frustumCulled = false;
    this.dust.count = 0;

    for (const o of [this.boulders, this.stones, this.dust]) {
      this.scene.add(o);
      this.objects.push(o);
    }
  }

  #buildBanner() {
    this.banner = document.createElement("div");
    this.banner.textContent = "⚠ ROCKFALL";
    this.banner.style.cssText = `position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:25;
      font:800 16px/1 "Cascadia Mono",Consolas,monospace;letter-spacing:.14em;color:#1a1300;
      background:#f2c200;border:2px solid #1a1300;padding:6px 12px;border-radius:3px;
      pointer-events:none;display:none`;
    document.body.appendChild(this.banner);
  }

  // -------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------

  /**
   * One fixed step. Call before world.step().
   * @param {number} dt
   * @param {Array} field  race entries ({ vehicle, progress })
   */
  step(dt, field = []) {
    const L = this.track.length;
    const lead = field[0]; // the player
    if (lead) {
      const v = lead.vehicle;
      for (const z of this.zones) {
        // Distance to the zone's start, ahead of the car, wrapped round the lap.
        const toStart = (((z.s0 - v.s) % L) + L) % L;
        const inTrigger = toStart <= TRIGGER_BEFORE && toStart > 0;
        if (inTrigger && z.armed) {
          z.armed = false;
          this.#launch(z, v, toStart);
        } else if (!inTrigger && toStart > TRIGGER_BEFORE + 50 && toStart < L - (z.s1 - z.s0) - 50) {
          z.armed = true; // well clear of the zone: ready for the next lap
        }
      }
      if (lead.progress?.justRespawned) this.clearAround(v.body.translation());
    }

    this.warnFor = Math.max(0, this.warnFor - dt);
    for (const r of this.rocks) this.#advance(r, dt, field);
    this.rocks = this.rocks.filter((r) => r.phase !== "gone");
  }

  /**
   * Set off one or two boulders in a zone, landing ahead of the car.
   * @param {number} toStart  metres from the car to the zone's start
   */
  #launch(z, v, toStart) {
    const L = this.track.length;
    const speed = Math.max(v.speed, 12);
    // Where the car will be when a boulder lands, plus a margin: never
    // closer than that, and inside the zone wherever that allows.
    const minAhead = speed * (WARN_TIME + FALL_TIME) + CLEAR_AHEAD;
    const zoneEnd = toStart + (z.s1 - z.s0);
    const room = Math.max(0, zoneEnd - Math.max(minAhead, toStart));
    const count = room > 45 && Math.random() < 0.45 ? 2 : 1;
    let s = v.s + Math.max(minAhead, toStart) + Math.random() * Math.min(25, room);
    for (let i = 0; i < count && this.rocks.length < MAX_ROCKS; i++) {
      const land = ((s % L) + L) % L;
      // The uphill half of the road: the other half is always open.
      const lat = z.side * (2.6 + Math.random() * 1.6);
      this.rocks.push(this.#newRock(land, lat, z.side, 0.8 + Math.random() * 0.5, i * 0.5));
      s += 28 + Math.random() * 18;
    }
    this.warnFor = 2.4;
  }

  #newRock(s, lat, side, radius, delay) {
    this.track.frameAt(s, _fr);
    const land = _fr.position.clone().addScaledVector(_fr.right, lat).addScaledVector(_fr.up, radius);
    const source = land.clone().addScaledVector(_fr.right, side * SOURCE_OUT).addScaledVector(_fr.up, SOURCE_UP);
    // Bounce and roll toward the downhill side, but settle on the uphill
    // half, at least 1.3 m from the centre line: the other half is the lane.
    const restLat = side * THREE.MathUtils.clamp(Math.abs(lat) - (0.8 + Math.random() * 0.8), 1.3, LANE_EDGE);
    const bounceLat = (lat + restLat) / 2;
    const at = (l, lift = 0) =>
      _fr.position.clone().addScaledVector(_fr.right, l).addScaledVector(_fr.up, radius + lift);
    const stones = Array.from({ length: 8 }, (_, i) => ({
      t0: (i / 8) * WARN_TIME * 0.9,
      off: new THREE.Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4),
    }));
    return {
      s,
      radius,
      phase: "warn",
      t: -delay,
      source,
      land,
      bounce: at(bounceLat),
      rest: at(restLat),
      pos: source.clone(),
      prev: source.clone(),
      spin: 0,
      spinAxis: new THREE.Vector3().crossVectors(_fr.up, _fr.right.clone().multiplyScalar(-side)).normalize(),
      stones,
      dustT: -1,
      body: null,
    };
  }

  #advance(r, dt, field) {
    r.prev.copy(r.pos);
    r.t += dt;
    if (r.t < 0) return;

    switch (r.phase) {
      case "warn":
        if (r.t >= WARN_TIME) {
          r.phase = "fall";
          r.t = 0;
        }
        break;
      case "fall": {
        const k = Math.min(1, r.t / FALL_TIME);
        // Across linearly, down accelerating: it drops off a ledge.
        r.pos.lerpVectors(r.source, r.land, k);
        r.pos.y = r.source.y + (r.land.y - r.source.y) * k * k;
        r.spin += dt * 5;
        if (k >= 1) {
          r.phase = "bounce";
          r.t = 0;
          r.dustT = 0;
        }
        break;
      }
      case "bounce": {
        const k = Math.min(1, r.t / BOUNCE_TIME);
        r.pos.lerpVectors(r.land, r.bounce, k);
        r.pos.y += Math.sin(Math.PI * k) * 1.4;
        r.spin += dt * 4;
        if (k >= 1) {
          r.phase = "roll";
          r.t = 0;
        }
        break;
      }
      case "roll": {
        const k = Math.min(1, r.t / ROLL_TIME);
        r.pos.lerpVectors(r.bounce, r.rest, easeOut(k));
        r.spin += dt * 3 * (1 - k);
        if (k >= 1) {
          r.phase = "settle";
          r.t = 0;
        }
        break;
      }
      case "settle":
        // Solid only once nothing is where it would be: a body appearing
        // around a car would launch it.
        if (!this.#carNear(r.rest, r.radius + 2.2, field)) {
          r.body = this.world.createRigidBody(
            this.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(r.rest.x, r.rest.y, r.rest.z)
          );
          this.world.createCollider(
            this.RAPIER.ColliderDesc.ball(r.radius * 0.9)
              .setFriction(0.4)
              .setCollisionGroups((GROUP.traffic << 16) | ALL),
            r.body
          );
          r.phase = "rest";
          r.t = 0;
        }
        break;
      case "rest": {
        // Sink once the player is well past it, or after a while anyway.
        const lead = field[0]?.vehicle;
        const L = this.track.length;
        let past = lead ? lead.s - r.s : 0;
        past = ((past % L) + L) % L;
        if ((past > 60 && past < L / 2) || r.t > 25) this.#sink(r);
        break;
      }
      case "sink": {
        const k = Math.min(1, r.t / SINK_TIME);
        r.pos.copy(r.rest);
        r.pos.y -= k * r.radius * 2.2;
        if (k >= 1) r.phase = "gone";
        break;
      }
    }
    if (r.dustT >= 0) r.dustT += dt;
  }

  #sink(r) {
    if (r.body) {
      this.world.removeRigidBody(r.body);
      r.body = null;
    }
    r.phase = "sink";
    r.t = 0;
  }

  #carNear(p, dist, field) {
    for (const f of field) {
      const t = f.vehicle.body.translation();
      if ((t.x - p.x) ** 2 + (t.z - p.z) ** 2 < dist * dist) return true;
    }
    return false;
  }

  /** Clear rocks near a respawn point, so a car never reappears inside one. */
  clearAround(pos, radius = 25) {
    for (const r of this.rocks) {
      if (r.pos.distanceToSquared(_v.set(pos.x, pos.y, pos.z)) < radius * radius) {
        if (r.body) this.world.removeRigidBody(r.body);
        r.body = null;
        r.phase = "gone";
      }
    }
    this.rocks = this.rocks.filter((r) => r.phase !== "gone");
  }

  // -------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------
  render(alpha) {
    let nb = 0;
    let ns = 0;
    let nd = 0;
    for (const r of this.rocks) {
      if (r.t < 0 && r.phase === "warn") continue;
      if (r.phase !== "warn") {
        _v.lerpVectors(r.prev, r.pos, alpha);
        _q.setFromAxisAngle(r.spinAxis, r.spin);
        _m.compose(_v, _q, _s.setScalar(r.radius));
        this.boulders.setMatrixAt(nb++, _m);
      } else {
        // Warning stones, falling along the boulder's path.
        for (const st of r.stones) {
          const k = (r.t - st.t0) / (FALL_TIME * 0.8);
          if (k < 0 || k > 1) continue;
          _v.lerpVectors(r.source, r.land, k).add(st.off);
          _v.y = r.source.y + (r.land.y - r.source.y) * k * k;
          _m.compose(_v, _q.identity(), _s.setScalar(1));
          this.stones.setMatrixAt(ns++, _m);
        }
      }
      if (r.dustT >= 0 && r.dustT < 0.9) {
        const k = r.dustT / 0.9;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          _v.copy(r.land);
          _v.x += Math.cos(a) * k * 3;
          _v.z += Math.sin(a) * k * 3;
          _v.y += -r.radius + 0.3 + k * 1.2;
          _m.compose(_v, _q.identity(), _s.setScalar(0.5 + k * 1.3 * (1 - k * 0.5)));
          if (nd < this.dust.instanceMatrix.count) this.dust.setMatrixAt(nd++, _m);
        }
      }
    }
    this.boulders.count = nb;
    this.stones.count = ns;
    this.dust.count = nd;
    this.dust.material.opacity = 0.35;
    for (const o of [this.boulders, this.stones, this.dust]) o.instanceMatrix.needsUpdate = true;
    this.banner.style.display = this.warnFor > 0 ? "block" : "none";
  }

  dispose() {
    for (const r of this.rocks) if (r.body) this.world.removeRigidBody(r.body);
    this.rocks.length = 0;
    for (const o of this.objects) {
      this.scene.remove(o);
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m?.map?.dispose();
        m?.dispose();
      }
      o.dispose?.();
    }
    this.objects.length = 0;
    this.banner.remove();
  }
}
