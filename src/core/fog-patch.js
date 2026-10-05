import * as THREE from "three";

// ---------------------------------------------------------------------
// Fog patch: a stretch where the mountain air thickens over the road,
// pulling the draw distance right in. Low ground mist pooling somewhere
// reads as a real place for weather to collect; thickening right by a
// summit instead just looks like the sky got swapped for a flat grey
// card (see the Mountain's own placement for the reasoning behind
// exactly where). The hazard is "the corners you already have to read
// on sight now give you less sight," not a cheap jump-scare out of
// nowhere.
//
// Same fairness rule as the rockfall and the crosswind it shares the
// mountain with: thickness is a function of s alone, ramped in and out
// smoothly, with a sign on the approach. No separate HUD banner of its
// own — it shares main.js's one hazard-warning slot with the rockfall
// and the crosswind, so only one can ever be on screen at a time.
//
// The dome tints toward three slightly different shades of the fog
// colour (brighter overhead, darker at the ground) rather than one flat
// value: collapsing the whole sky to a single colour fixed the ORIGINAL
// bug (clear blue still showing past the fog, so it looked like the
// murk just stopped), but a perfectly flat dome swung too far the other
// way and read as a solid card rather than an overcast sky.
// ---------------------------------------------------------------------

const RAMP = 40; // m the patch takes to thicken to / clear from full strength
const WARN_BEFORE = 70; // m before the patch that the sign stands
// A pale grey under this scene's bright sun and ACES exposure reads as
// blown-out white, not mist — this is a darker, cooler slate that still
// reads as fog once lit.
const DEFAULT_COLOR = 0x6c7680;

const _fr = {};
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);
const BLACK = new THREE.Color(0x000000);

export class FogPatch {
  /**
   * @param {object} track
   * @param {THREE.Scene} scene
   * @param {object[]} zones  [{ s0, s1, near, far, color, signOffset, ramp }]
   *   near/far  THREE.Fog distances at full strength, m (short — that's
   *             the point); default to a tight, grey murk.
   *   color     fog colour at full strength; defaults to DEFAULT_COLOR.
   *   ramp      m to thicken/clear over; defaults to RAMP (40). Lower it
   *             for a zone boxed in by too little clean road either side
   *             of it to take the default without overlapping something
   *             else — see the Mountain's zone, wedged into the ~55 m
   *             between the last rockfall zone and the finish line.
   *   pastLine  for a zone that runs up to the line: m of the next lap it
   *             stays at full strength, once the car has been through it.
   *   fadeOut   m it then clears over; defaults to `ramp`.
   * @param {object} [skyUniforms]  main.js's uTop/uHorizon/uBottom, so the
   *   sky dome tints toward the fog too. Without this the dome keeps
   *   showing its ordinary blue gradient right through the murk — the
   *   fog reads as a flat grey wall with clear sky visible past it,
   *   rather than actually being in the air around the car.
   */
  constructor(track, scene, zones = [], skyUniforms = null) {
    this.track = track;
    this.scene = scene;
    this.skyUniforms = skyUniforms;
    this.objects = [];

    const base = scene.fog;
    this.baseNear = base?.near ?? 180;
    this.baseFar = base?.far ?? 620;
    this.baseColor = (base?.color ?? new THREE.Color(0x8fb4c4)).clone();
    if (skyUniforms) {
      this.baseSky = {
        top: skyUniforms.uTop.value.clone(),
        horizon: skyUniforms.uHorizon.value.clone(),
        bottom: skyUniforms.uBottom.value.clone(),
      };
    }

    this.zones = zones.map((z) => {
      const color = z.color !== undefined ? new THREE.Color(z.color) : new THREE.Color(DEFAULT_COLOR);
      return {
        ...z,
        near: z.near ?? 20,
        far: z.far ?? 140,
        ramp: z.ramp ?? RAMP,
        color,
        // The dome tints toward three DIFFERENT shades of this colour,
        // not one flat value — brighter overhead, darker at the ground —
        // so thick fog still reads as sky-shaped murk rather than a
        // single-colour card pasted behind the scene.
        skyTop: color.clone().lerp(WHITE, 0.2),
        skyHorizon: color.clone(),
        skyBottom: color.clone().lerp(BLACK, 0.18),
      };
    });
    for (const z of this.zones) this.#buildSign(z);
  }

  #strengthAt(z, s) {
    const ramp = z.ramp;
    // Carried over the line: once the car has driven into the patch, the
    // first `pastLine` m of the next lap stay at full strength and then
    // clear over `fadeOut` m. A fresh patch (every new run) starts
    // disarmed, so the grid itself is never in fog.
    if (z.armed && s < z.s0 - ramp) {
      const tail = z.pastLine ?? 0;
      const fade = z.fadeOut ?? ramp;
      if (s <= tail) return 1;
      if (s < tail + fade) return 1 - (s - tail) / fade;
      return 0;
    }
    if (s <= z.s0 - ramp || s >= z.s1 + ramp) return 0;
    if (s < z.s0) return (s - (z.s0 - ramp)) / ramp;
    if (s > z.s1) return 1 - (s - z.s1) / ramp;
    return 1;
  }

  /** Is s inside any zone's murk (ramps included)? For the HUD warning. */
  activeAt(s) {
    return this.zones.some((z) => this.#strengthAt(z, s) > 0.05);
  }

  /** Called once per rendered frame with the player's track distance. */
  update(s) {
    const fog = this.scene.fog;
    if (!fog) return;
    // Several zones could in principle overlap; the thickest one wins
    // rather than the sum, so stacking never fogs out past "zero".
    let k = 0;
    let zone = null;
    for (const z of this.zones) {
      if (z.pastLine !== undefined) {
        if (s >= z.s0 && s <= z.s1 + z.ramp) z.armed = true;
        // well clear of both ends: the carried-over murk is spent
        else if (s > z.pastLine + (z.fadeOut ?? z.ramp) && s < z.s0 - z.ramp) z.armed = false;
      }
      const zk = this.#strengthAt(z, s);
      if (zk > k) {
        k = zk;
        zone = z;
      }
    }
    fog.near = THREE.MathUtils.lerp(this.baseNear, zone?.near ?? this.baseNear, k);
    fog.far = THREE.MathUtils.lerp(this.baseFar, zone?.far ?? this.baseFar, k);
    _c.copy(this.baseColor);
    if (zone) _c.lerp(zone.color, k);
    fog.color.copy(_c);

    // The dome tints toward the murk as the patch thickens — not to one
    // flat colour (that read as a solid card pasted behind the scene,
    // not a sky), but to its own top/horizon/bottom shades, so there is
    // still a sky-shaped gradient to see, just a muted, overcast one. k
    // is 0 whenever zone is null, so the tint fallback never actually
    // applies — lerp(..., 0) is exactly the base colour regardless.
    if (this.skyUniforms) {
      const top = zone?.skyTop ?? this.baseColor;
      const horizon = zone?.skyHorizon ?? this.baseColor;
      const bottom = zone?.skyBottom ?? this.baseColor;
      this.skyUniforms.uTop.value.copy(this.baseSky.top).lerp(top, k);
      this.skyUniforms.uHorizon.value.copy(this.baseSky.horizon).lerp(horizon, k);
      this.skyUniforms.uBottom.value.copy(this.baseSky.bottom).lerp(bottom, k);
    }
  }

  // -------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------

  /** A yellow hazard sign — wavy mist lines — on the patch's approach. */
  #buildSign(z) {
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
    g.strokeStyle = "#111";
    g.lineWidth = 7;
    g.lineCap = "round";
    for (const y of [48, 64, 80]) {
      g.beginPath();
      g.moveTo(30, y);
      for (let x = 30; x <= 98; x += 8) g.lineTo(x, y + Math.sin((x - 30) / 7) * 4);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const s = z.s0 - WARN_BEFORE;
    this.track.frameAt(s, _fr);
    const offset = (z.side ?? 1) * (z.signOffset ?? 7.6);
    const base = _fr.position.clone().addScaledVector(_fr.right, offset);
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
    face.lookAt(_v.copy(face.position).addScaledVector(_fr.tangent, -10));
    for (const o of [post, face]) {
      o.castShadow = true;
      this.scene.add(o);
      this.objects.push(o);
    }
  }

  dispose() {
    const fog = this.scene.fog;
    if (fog) {
      fog.near = this.baseNear;
      fog.far = this.baseFar;
      fog.color.copy(this.baseColor);
    }
    if (this.skyUniforms) {
      this.skyUniforms.uTop.value.copy(this.baseSky.top);
      this.skyUniforms.uHorizon.value.copy(this.baseSky.horizon);
      this.skyUniforms.uBottom.value.copy(this.baseSky.bottom);
    }
    for (const o of this.objects) {
      this.scene.remove(o);
      o.geometry?.dispose();
      o.material?.map?.dispose();
      o.material?.dispose();
    }
    this.objects.length = 0;
  }
}
