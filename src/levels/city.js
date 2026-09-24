import * as THREE from "three";
import mapUrl from "../../assets/maps/CityTrack.glb?url";
import { loadMap, buildMapTrack } from "./glb-map.js";

// ---------------------------------------------------------------------
// OFFICIAL MAP 1 — City Track
//
// A street circuit through a city block, modelled in Blender
// (assets/maps/CityTrack.glb). 1.2 km, 14 m of road between kerbs, and
// two genuine hairpins — about 4 m and 7 m radius on the modelled line —
// that nothing in the procedural levels comes close to. Those are the
// point of the map: this is where braking is learned.
//
// The soft wall sits out on the pavement, so the kerb is a line you can
// cross and the buildings are never reached. Every facade was measured
// against the centreline: the nearest is well outside the wall, so none
// of the 2595 blocks needs a collider.
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
      // The modelled gutter is the ground plane, 12 cm below the road and
      // 14 cm below the pavement. The chassis clears the road by 17 cm,
      // so in the gutter a flat pavement edge caught it side-on and
      // stopped the car dead — and as ground, not wall, nothing counted
      // it as a hit or pushed it off. Collide with the ground at road
      // level; the 12 cm the wheels float over the gutter is invisible.
      { match: /^CityGround$/, friction: 0.7, lift: 0.12 },
    ],
    decals: /^(Line|CentreDash)/,
    overlays: /^(Road|KerbLeft|KerbRight|Pavement|GreenIsland|TreePit)/,
    minimap: /^(Road|KerbLeft|KerbRight|Pavement)/,
    // 132 posts in the model have no material at all.
    materialColors: { default: [0.3, 0.3, 0.32] },
    // Road edge 7 m, kerb to 7.35, pavement from 9 to 12, and the nearest
    // building face at 11.9. The hairpins need all the width there is:
    // the car's full-lock radius (~4.2 m) is the same as theirs.
    wallLimit: 10.5,
  });
  const { track } = map;

  // The model has no start line, and a lap that ends at nothing reads as
  // a timing bug. A chequered strip across the road at s = 0.
  const line = startLine(track, scene);
  track.objects.push(line); // Track.dispose() frees its geometry and material

  const gate = track.spawnAt(0);
  return {
    name: "city",
    index: 1,
    title: "City Track",
    track,
    // Three, not five: 14 m between kerbs and two hairpins do not fit a
    // six-car field without the respawn logic doing most of the racing.
    opponents: 3,
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
