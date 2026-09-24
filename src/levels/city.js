import * as THREE from "three";
import mapUrl from "../../assets/maps/CityTrack.glb?url";
import { loadMap, buildMapTrack } from "./glb-map.js";

// ---------------------------------------------------------------------
// OFFICIAL MAP 1 — City Track
//
// A street circuit through a city block, generated in Blender by
// citytrack.py (assets/maps/CityTrack.glb): 1.23 km, 14 m of road between
// kerbs, lamps, traffic lights and a crowd along the pavements, and live
// traffic on the road instead of rival racers. Two hairpins, opened out to about 14 m radius in this
// version (they were 3 m and 5 m, tighter than the car can turn, and
// folded the pavement over the road).
//
// The generator keeps everything that stands up at least 10 m from the
// centre line, so the soft wall at 9 m lets a car use the kerb and
// gutter and never reach a lamp post, a pedestrian or a building. None
// of the scenery needs a collider.
// ---------------------------------------------------------------------

buildCity.preload = () => loadMap(mapUrl);

// `gltf` is what preload() resolved to — loadLevel in main.js awaits it.
export function buildCity(RAPIER, world, scene, gltf) {
  const map = buildMapTrack(RAPIER, world, scene, gltf, {
    name: "CityTrack",
    surfaces: [
      { match: /^Road$/, friction: 1.0 },
      { match: /^Kerb(Left|Right)$/, friction: 0.9 },
      { match: /^Pavement(Left|Right)$/, friction: 0.8 },
      // The modelled gutter is the ground plane: 12 cm below the road,
      // with gentle bumps of up to 10 cm either way. The chassis clears
      // the road by 17 cm, so down in the gutter the pavement's edge
      // caught it side-on and stopped the car dead — and as ground, not
      // wall, nothing counted it as a hit or pushed it off. Collide with
      // the ground as a flat sheet at road level instead: lifting the
      // bumpy mesh would push its bumps up through the road.
      { match: /^CityGround$/, friction: 0.7, flatY: 0 },
    ],
    decals: /^(Line|CentreDash|CrosswalkBar|Manhole|Puddle|RoadPatch)/,
    // The model's parked cars. The city's cars are live traffic instead
    // (core/traffic.js), and parked ones beside it read as more of it.
    exclude: /^(CarBody|CarCabin|Wheel|Headlight|Taillight)/,
    overlays: /^(Road|KerbLeft|KerbRight|Pavement|GreenIsland|TreePit)/,
    minimap: /^(Road|KerbLeft|KerbRight|Pavement)/,
    // Road edge 7 m, kerb to 7.35, pavement from 9 to 12; nothing standing
    // inside 10 m. The car is 0.85 m either side of its centre.
    wallLimit: 9,
  });
  const { track } = map;

  // The model has a gantry but no line on the road, and a lap that ends at nothing reads as
  // a timing bug. A chequered strip across the road at s = 0.
  const line = startLine(track, scene);
  track.objects.push(line); // Track.dispose() frees its geometry and material

  const gate = track.spawnAt(0);
  return {
    name: "city",
    index: 1,
    title: "City Track",
    track,
    // No racers here: the city is a solo run against the clock through
    // live traffic, keeping left, both ways. Seven cars going the race
    // direction and six coming the other way on a 1.23 km lap is one
    // every ~95 m: busy, not gridlocked.
    opponents: 0,
    traffic: { sameWay: 7, oncoming: 6, lane: 3.5, cruise: [11, 15] },
    pickups: { repair: 4, boost: 5 },
    spawn: gate.position,
    quaternion: gate.quaternion,
    lit: { sun: [60, 90, 40], fog: [0xb4c6d0, 220, 950], sky: 0xb4c6d0 },
    dispose: () => {
      map.dispose();
      line.material.map.dispose(); // ...but not the texture on it
    },
  };
}

function startLine(track, scene) {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 16;
  const g = c.getContext("2d");
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? "#111" : "#eee";
      g.fillRect(x * 8, y * 8, 8, 8);
    }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;

  const fr = track.frameAt(0, {});
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(track.width, 1.75).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.7,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    })
  );
  mesh.position.copy(fr.position).addScaledVector(fr.up, 0.01);
  mesh.rotation.y = Math.atan2(-fr.right.z, fr.right.x); // plane's x onto the road's right
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}
