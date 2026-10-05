import mapUrl from "../../assets/maps/GrandPrix.glb?url";
import { loadMap, buildMapTrack } from "./glb-map.js";
import * as THREE from "three";
import { buildArmco } from "./armco.js";
import { GrandPrixScenery, loadGrandPrixProps } from "./grandprix-scenery.js";

// ---------------------------------------------------------------------
// OFFICIAL MAP 3 — Grand Prix
//
// A full-size permanent circuit, modelled in Blender
// (assets/maps/GrandPrix.glb, rebuilt by blender/grandprix/fix_grandprix.py):
// 2.8 km with pit straight, garages, start gantry, four grandstands full
// of spectators, gravel, continuous tyre walls and floodlights. The lap:
// a 1 km opening straight downhill into Turn 1, a hard stop for an R16
// left hairpin (boards at 300/200/100 m) and a banked R45 right; up the
// back straight to a blind +10 m crest under a sponsor bridge; the esses,
// left-right-left at R40 under the Esses stand; a banked R90 left onto a
// long diagonal; and the banked R30 final corner, which finishes 70 m
// before the line so the whole grid lines up on straight, level road.
//
// The pit lane is a real one (src/track/pit-lane.js): the entry peels off
// before the final corner, the exit merges back after the garages, there
// is a limiter between the two painted lines, and stopping in your box
// repairs the car and refills the boost. Opponents pit only when badly
// damaged.
//
// The limiter is 100 km/h, not a realistic 60: the nine garages (and so
// the limited zone between the painted lines) stretch across most of
// the 760 m level section of the home straight — about a quarter of the
// whole lap — so at 60 the limiter alone was costing upwards of 30 s
// against driving that same stretch on the racing line, on top of the
// detour and the stop itself. A pit stop should cost you the stop and
// the few car-lengths either side of it, not a third of a lap.
//
// The soft wall sits 1.4 m out on the grass verge, just inside the tyre
// walls. It was first set 4 m out, which put the tyre walls inside the
// drivable band — and they are separate 4.6 m blocks with gaps between,
// so a car running wide met a block end-on at 190 km/h and stopped dead.
// Solid: the pit wall along the main straight and the gantry legs, which
// stand right beside the road. The tyre walls stay solid for anything
// that gets past the wall. Rocks are not: a box round a rock is mostly
// invisible wall.
// ---------------------------------------------------------------------

buildGrandPrix.preload = async () => {
  const [map] = await Promise.all([loadMap(mapUrl), loadGrandPrixProps()]);
  return map;
};

// `gltf` is what preload() resolved to — loadLevel in main.js awaits it.
export function buildGrandPrix(RAPIER, world, scene, gltf) {
  const map = buildMapTrack(RAPIER, world, scene, gltf, {
    name: "GrandPrix",
    surfaces: [
      { match: /^Road$/, friction: 1.0 },
      { match: /^PitLane$/, friction: 1.0 },
      { match: /^PitApron$/, friction: 1.0 },
      // Leaving the track costs you. Grass holds about two thirds of what
      // asphalt does and drags like rolling off the throttle; gravel holds
      // half and drags like braking. (grip x tyre grip, rolling = extra
      // rolling resistance as a fraction of wheel load.)
      { match: /^Verge_[LR]$/, friction: 0.8, grip: 0.65, rolling: 0.1 },
      { match: /^GravelTrap/, friction: 0.6, grip: 0.5, rolling: 0.3 },
      { match: /^GroundGrass$/, friction: 0.7, grip: 0.65, rolling: 0.1 },
    ],
    solid: /^(PitWall|TyreWall|GantryPillar)/,
    // The five lamps on the start gantry, lit one by one by the race director.
    keep: /^StartLamp\d*$/,
    // The plain garages (and their doors, windows and roof trim) give way to the pit-building model.
    exclude: /^(Garage|GarageDoor|Garage_Window|Garage_RoofTrim)\d*$/,
    // The pit road overlaps the track where it peels off and rejoins, so it
    // is drawn over the road like the paint is.
    decals: /^(RacingLine|EdgeLine|StartFinishLine|ApexKerbs|PitLane|PitLine|PitLimit|PitBox)/,
    overlays: /^(Road|Verge|PitApron|GravelTrap|GrassPatch|Lake)/,
    minimap: /^(Road|Verge|PitLane|EdgeLine|ApexKerbs|StartFinishLine)/,
    // Road edge 7 m; the nearest tyre-wall face is at 10.3 m, and the car
    // is 0.85 m either side of its centre.
    wallLimit: 8.4,
    track: { checkpointSpacing: 150 },
    // The pit road and its markers, for the PitLane (src/track/pit-lane.js).
    pit: { ribbon: "PitLane", boxes: /^PitBox/, limits: /^PitLimit/ },
  });
  const { track } = map;

  // A steel barrier exactly where the soft wall stops the car, so the
  // edge is something you can see rather than an invisible wall. The
  // rail's face sits a car's half-width outside the wall line. Left out
  // wherever the pit road runs beside the track (the pit wall is there,
  // and the pit entry and exit must stay open) and at the gantry's legs.
  const L = track.length;
  const offset = 8.4 + 0.85 + 0.1;
  const skip = [
    { side: -1, s0: L - 3, s1: 3 },
    { side: 1, s0: L - 3, s1: 3 },
    ...pitSkips(track, map.pit, offset),
  ];
  for (const o of buildArmco(track, scene, { offset, skip })) {
    track.objects.push(o); // disposed with the track
  }

  // Cacti, tents and apple trees on the open grass, and neon rails through
  // the tunnel (road distance 2,338-2,552 m).
  // Where the map's plain garages stood (read from the file: the nodes are excluded from drawing).
  const garages = [];
  {
    const box = new THREE.Box3();
    const q = new THREE.Quaternion();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh || !/^Garage\d*$/.test(o.name)) return;
      box.setFromObject(o);
      o.getWorldQuaternion(q);
      const s = o.getWorldScale(new THREE.Vector3());
      const pos = o.getWorldPosition(new THREE.Vector3());
      // the unit cube spans -1..1, so the footprint is twice the scale; the bottom of the ground is the pit box height
      garages.push({ x: pos.x, z: pos.z, y: 0, quaternion: q.clone(), w: Math.abs(s.x) * 2, d: Math.abs(s.z) * 2 });
    });
  }
  const scenery = new GrandPrixScenery(scene, track, map.group.children, { tunnel: [2338, 2552], garages });

  const gate = track.spawnAt(0);
  return {
    name: "grandprix",
    scenery,
    index: 3,
    title: "Grand Prix",
    track,
    opponents: 5, // the full field: this is the race
    // A proper race: start lights, two laps, a classification. timeLimit
    // scales with laps (was 8 min for three) rather than being a fixed
    // ceiling, so it stays exactly as generous relative to a real race
    // distance as it always was.
    race: { laps: 2, timeLimit: (8 * 60 * 2) / 3 },
    startLamps: map.kept.filter((m) => /^StartLamp/.test(m.name)),
    // A real pit stop: repaired and refuelled with boost in your box in
    // about three seconds; opponents pit when badly damaged. The limiter
    // is 100 km/h, not the usual 60 — see the note near the top of this
    // file for why.
    pit: { data: map.pit, limitKmh: 100, repairTime: 3, aiDamage: 0.5 },
    pickups: { repair: 6, boost: 8 },
    spawn: gate.position,
    quaternion: gate.quaternion,
    // Night, after rain. The only daylight is a dim blue moon; the scene
    // is lit by what glows in the map (floodlights, tunnel strips, the big
    // screen, banners) through bloom, plus a handful of REAL lights that
    // follow the player between those fixtures (src/lighting/light-pool.js):
    // four floodlight spots out of eleven towers, two tunnel lights out of
    // fifteen strips. Far fixtures only glow; near ones light the road.
    //
    // The asphalt is wet (src/lighting/wet-road.js): damp and glossy, with
    // puddles that are near-mirrors and rain rippling in them, so the
    // floodlights, tunnel strips and headlights streak across the road.
    lit: {
      sun: [-80, 45, 60], // the moon, low enough to be seen from the chase camera
      sunColor: 0x9fb4ff,
      sunIntensity: 0.45,
      hemi: [0x2a3550, 0x0a0a10, 0.3],
      // Stars between thin, dark clouds, and a pale moon.
      sky: { top: 0x03050c, horizon: 0x1b2140, bottom: 0x050508, clouds: 0.25, cloudColor: 0x141a2c, stars: 1, sunDisc: 3, sunSize: 0.022 },
      fog: [0x0d1222, 140, 700],
      exposure: 1.1,
      envIntensity: 0.6,
      bloom: { threshold: 1.5, strength: 0.45, radius: 0.25 },
      headlights: true,
      glow: 0xff3cc8, // neon magenta against the night
      // Generated normal maps (src/lighting/surface-detail.js); the asphalt
      // is also wet, and the two patches stack (material-patches.js).
      detail: {
        Asphalt: { map: "grain", size: 1.5, strength: 0.5 },
        AsphaltWorn: { map: "grain", size: 1.2, strength: 0.7 },
        PitAsphalt: { map: "grain", size: 1.5, strength: 0.5 },
        GravelTrap: { map: "gravel", size: 1.2, strength: 1 },
        Concrete: { map: "panels", size: 3, strength: 0.7 },
        TunnelConcrete: { map: "panels", size: 4, strength: 0.7 },
        Rock: { map: "rock", size: 6, strength: 1.2 },
      },
      emissive: { TunnelLights: 0.45 },
      // The tunnel strips are modelled with a fixed amber emissive — this
      // overrides the colour itself (not just its intensity, which the
      // `emissive` map above already scales) to lit.glow's magenta, so
      // the tunnel glows with the track's own neon rather than a real
      // tunnel's sodium lighting. See restyleMaterials() in main.js.
      materials: { TunnelLights: { emissive: new THREE.Color(0xff3cc8) } },
      wet: { materials: ["Asphalt", "AsphaltWorn", "PitAsphalt"], puddles: 0.45, damp: 0.38, ripples: 1 },
      // The eleven floodlight towers come as four pairs (one each side of
      // the road, at the same point on track) plus three singles, not
      // eleven independent positions — src/lighting/light-pool.js's own
      // `count` real lights follow the nearest sources with no shared
      // budget between them, so whenever the car is near a pair, BOTH
      // towers light up at full intensity at once with nothing capping
      // the total. At the s~1702 pair that doubled intensity, reflected
      // off the near-mirror wet road straight into the camera, blew the
      // whole frame to white — not a corner-specific glitch, a structural
      // risk at any of the four pairs. distance down from 160 to 70 so
      // the falloff window is already biting by the ~40 m a pair sits at
      // on its approach, instead of staying near its unwindowed full
      // strength out to 160 m; intensity down from 15000 to 7000 so even
      // two at once, this close, stay inside what bloom/tone-mapping can
      // render without clipping the frame. Verified live (driven through,
      // not just teleported) at the s~1702 pair and the other three; a
      // single floodlight further out (80-100 m, the common case) is
      // dimmer than before but still clearly visible against the night.
      pools: [
        { material: "FloodlightGlow", count: 4, type: "spot", color: 0xdfe8ff, intensity: 7000, distance: 70, angle: 0.75, penumbra: 0.7, fade: 40 },
        { material: "TunnelLights", count: 2, type: "point", color: 0xff3cc8, intensity: 150, distance: 30, fade: 20 },
      ],
    },
    dispose: () => {
      scenery.dispose();
      map.dispose();
    },
  };
}

/**
 * Stretches of the track, per side, where the pit road runs within reach
 * of the armco line: the rail would stand across the pit entry and exit,
 * or behind the pit wall.
 */
function pitSkips(track, pit, offset) {
  if (!pit) return [];
  const centres = pit.left.map((a, i) => a.clone().add(pit.right[i]).multiplyScalar(0.5));
  const halves = pit.left.map((a, i) => Math.hypot(a.x - pit.right[i].x, a.z - pit.right[i].z) / 2);
  const side = Math.sign(track.project(centres[centres.length >> 1], null).t) || -1;
  const fr = {};
  const p = new THREE.Vector3();
  const out = [];
  let run = null;
  const step = 2;
  for (let s = 0; s <= track.length; s += step) {
    track.frameAt(s, fr);
    p.copy(fr.position).addScaledVector(fr.right, side * offset);
    let near = false;
    for (let i = 0; i < centres.length; i += 2) {
      const dx = centres[i].x - p.x;
      const dz = centres[i].z - p.z;
      const r = halves[i] + 4;
      if (dx * dx + dz * dz < r * r) {
        near = true;
        break;
      }
    }
    if (near && !run) run = { side, s0: Math.max(0, s - step), s1: s };
    else if (near) run.s1 = s;
    else if (run) {
      run.s1 += step;
      out.push(run);
      run = null;
    }
  }
  if (run) out.push({ ...run, s1: track.length });
  return out;
}

/**
 * Fit the start gantry's front lettering onto its board.
 *
 * As exported, "GRAND PRIX" is turned about 5 degrees off the board's
 * line and is 17.5 m long between pillars 15.3 m apart: the G stands
 * 1.3 m proud of the board while the X disappears into the board and
 * into the right-hand pillar, so the sign read "GRAND PRI". Here it is
 * turned parallel to the board, centred on it 12 cm in front of the face,
 * and scaled (uniformly) to fit between the pillars.
 *
 * The board and pillars are measured from the map, not written in, so
 * this stays right if the map is re-exported. The proper fix belongs in
 * blender/grandprix/fix_grandprix.py; until then this does it at load.
 * Kept meshes are cached with the map and shared between visits, so it
 * runs once per mesh.
 */
function fitGantryText(text, root) {
  const board = root.getObjectByName("GantryBanner");
  if (!text || !board || text.userData.fitted) return;
  text.userData.fitted = true;
  const g = text.geometry;
  const pos = g.attributes.position;

  // The lettering's long axis in plan: the principal axis of its xz
  // spread (a 2x2 covariance, solved in closed form).
  g.computeBoundingBox();
  const c = g.boundingBox.getCenter(new THREE.Vector3());
  let sxx = 0, sxz = 0, szz = 0;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - c.x;
    const dz = pos.getZ(i) - c.z;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  }
  const axis = 0.5 * Math.atan2(2 * sxz, sxx - szz); // angle of the long axis from +x

  // The board, and the gap between the pillars along it.
  const b = new THREE.Box3().setFromObject(board);
  const bc = b.getCenter(new THREE.Vector3());
  const bs = b.getSize(new THREE.Vector3());
  const along = bs.z > bs.x ? "z" : "x"; // the board's long axis
  const thin = along === "z" ? "x" : "z";
  let lo = b.min[along];
  let hi = b.max[along];
  root.traverse((o) => {
    if (!/^GantryPillar/.test(o.name)) return;
    const p = new THREE.Box3().setFromObject(o);
    const pc = (p.min[along] + p.max[along]) / 2;
    if (pc < bc[along]) lo = Math.max(lo, p.max[along]);
    else hi = Math.min(hi, p.min[along]);
  });
  const MARGIN = 0.4; // m clear of each pillar

  // Straighten: rotate about y so the long axis lies along the board's.
  const want = along === "z" ? Math.PI / 2 : 0;
  const m = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
  m.premultiply(new THREE.Matrix4().makeRotationY(axis - want));
  g.applyMatrix4(m);

  // Fit: scale down (never up) to the gap between the pillars.
  g.computeBoundingBox();
  const length = g.boundingBox.max[along] - g.boundingBox.min[along];
  const k = Math.min(1, (hi - lo - 2 * MARGIN) / length);
  g.scale(k, k, k);

  // Place: centred in the gap, its back 12 cm in front of the board on
  // the side it was exported on.
  g.computeBoundingBox();
  const side = Math.sign(c[thin] - bc[thin]) || -1;
  const face = side < 0 ? b.min[thin] : b.max[thin];
  const t = new THREE.Vector3();
  t[along] = (lo + hi) / 2;
  t.y = c.y;
  t[thin] = face + side * (0.12 + (g.boundingBox.max[thin] - g.boundingBox.min[thin]) / 2);
  g.translate(t.x, t.y, t.z);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  pos.needsUpdate = true;
}
