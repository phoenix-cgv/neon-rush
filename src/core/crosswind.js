import * as THREE from "three";

// ---------------------------------------------------------------------
// Crosswind: a lateral gust where the road has nothing beside it to
// break the wind — the Mountain's viaduct, which crosses open air over
// the gorge with no slope and no guardrail-height cliff either side.
//
// The force-field hook this uses (Track.addForceField) already existed
// and is already applied to every car every step by main.js — its own
// comment there names "Level 2's crosswind" as the reason it's there.
// Nothing had ever registered a field through it. This module is the
// zone, the gust shape and the warning sign, not a new mechanism.
//
// A gust has to be fair to be fun, same as the rockfall it shares the
// road with: it is a function of s alone, never of wall-clock time, so
// it is identical lap to lap — readable rather than a surprise spike,
// and a ghost replay meets the exact gust its recording did. Windsocks
// at the entrance show which way and about how hard before the car
// arrives; there is no on-screen banner, because a sock leaning hard
// into the wind already tells you what you need to know, the same way
// a real one does.
// ---------------------------------------------------------------------

const RAMP = 25; // m the gust takes to build from nothing to full strength
const WARN_BEFORE = 55; // m before the zone that the windsock stands

const _fr = {};
const _f = new THREE.Vector3();
const _v = new THREE.Vector3();
const _windDir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

export class Crosswind {
  /**
   * @param {object} track
   * @param {THREE.Scene} scene
   * @param {object[]} zones  [{ s0, s1, side, force, signOffset }]
   *   side   +1/-1, which way across the track's right the gust pushes
   *          (a design choice, not measured from the terrain)
   *   force  N at full strength, applied at the chassis
   */
  constructor(track, scene, zones = []) {
    this.track = track;
    this.scene = scene;
    this.objects = [];
    this.socks = []; // { mesh, phase } — animated each render frame
    this.time = 0;

    this.zones = zones.map((z) => ({
      ...z,
      side: Math.sign(z.side ?? 1) || 1,
      force: z.force ?? 4200,
    }));
    this.fieldIds = this.zones.map((z) =>
      track.addForceField(z.s0 - RAMP, z.s1 + RAMP, (ctx) => this.#forceAt(z, ctx))
    );
    for (const z of this.zones) this.#buildSigns(z);
  }

  // -------------------------------------------------------------------

  /**
   * Gust strength at s, 0..1: ramps up over RAMP, eases through the
   * zone (two broad swells rather than one flat shove, so crossing it
   * feels like weather and not a constant hand on the wheel), ramps
   * back down. A pure function of s — see the module comment on why.
   */
  #strengthAt(z, s) {
    if (s <= z.s0 - RAMP || s >= z.s1 + RAMP) return 0;
    if (s < z.s0) return (s - (z.s0 - RAMP)) / RAMP;
    if (s > z.s1) return 1 - (s - z.s1) / RAMP;
    const span = Math.max(1, z.s1 - z.s0);
    const u = (s - z.s0) / span;
    return 0.7 + 0.3 * Math.sin(u * Math.PI * 2);
  }

  /** Is s inside any zone's gust (ramps included)? For the HUD warning. */
  activeAt(s) {
    return this.zones.some((z) => this.#strengthAt(z, s) > 0.05);
  }

  #forceAt(z, ctx) {
    const k = this.#strengthAt(z, ctx.s);
    if (k <= 0) return null;
    this.track.frameAt(ctx.s, _fr);
    return _f.copy(_fr.right).multiplyScalar(z.side * z.force * k);
  }

  // -------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------

  /** A windsock on each side of the road at the zone's approach. */
  #buildSigns(z) {
    const offset = z.signOffset ?? 7.6;
    const s = z.s0 - WARN_BEFORE;
    this.track.frameAt(s, _fr);
    // Which way the wind blows, in world space, with a slight droop —
    // a sock never flies dead level.
    _windDir.copy(_fr.right).multiplyScalar(z.side).addScaledVector(UP, -0.1).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, _windDir);

    for (const side of [-1, 1]) {
      const base = _fr.position.clone().addScaledVector(_fr.right, side * offset);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 4.0, 6),
        new THREE.MeshStandardMaterial({ color: 0x8c9296, metalness: 0.4, roughness: 0.6 })
      );
      pole.position.copy(base).add(_v.set(0, 2.0, 0));
      pole.castShadow = true;

      // Bigger and lit from within: at speed, a thin orange cone the
      // size of the original was easy to miss entirely against the
      // terrain. A glow reads the same whether the sun is behind it or
      // in front of it, which plain colour does not.
      const sock = new THREE.Mesh(
        new THREE.ConeGeometry(0.5, 2.2, 10, 1, true),
        new THREE.MeshStandardMaterial({
          color: 0xff7a1a,
          emissive: 0xff3300,
          emissiveIntensity: 0.5,
          roughness: 0.75,
          side: THREE.DoubleSide,
        })
      );
      sock.position.copy(base).add(_v.set(0, 3.9, 0));
      sock.quaternion.copy(q);
      sock.castShadow = true;

      this.scene.add(pole, sock);
      this.objects.push(pole, sock);
      this.socks.push({ mesh: sock, base: sock.quaternion.clone(), phase: Math.random() * Math.PI * 2 });
    }
  }

  /** Flutter the windsocks. Cosmetic only — the render frame, not the fixed step. */
  render(dt) {
    this.time += dt;
    for (const s of this.socks) {
      const wobble = Math.sin(this.time * 5.5 + s.phase) * 0.1;
      s.mesh.quaternion.copy(s.base).multiply(_q.setFromAxisAngle(Z, wobble));
    }
  }

  dispose() {
    for (const id of this.fieldIds) this.track.removeForceField(id);
    for (const o of this.objects) {
      this.scene.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
    this.objects.length = 0;
    this.socks.length = 0;
  }
}
