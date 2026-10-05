import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

// ---------------------------------------------------------------------
// One GLTFLoader setup for the whole game: a model may be compressed, so
// every loader needs both decoders. The props are Draco (the best ratio,
// but it reorders and merges vertices); the maps are meshopt, losslessly,
// because the track is read from the road ribbon's vertex ORDER (see
// glb-map.js) and Draco scrambled it. One shared DRACOLoader, so the decoder
// (public/draco/, a few hundred KB of WebAssembly) is fetched and started
// once however many loaders there are.
// ---------------------------------------------------------------------

let draco = null;

/**
 * Unpack interleaved vertex data into plain attributes, once, in place.
 * The compressed maps carry their normals interleaved; three can merge
 * and clone those only by copying them out, and it logs a notice every
 * time it does — a dozen thousand lines for one map, which cost real
 * time on load. Plain copies, made here quietly, avoid all of that.
 * @returns the gltf, for chaining
 */
export function deinterleave(gltf) {
  gltf.scene.traverse((o) => {
    const g = o.geometry;
    if (!g) return;
    for (const [name, a] of Object.entries(g.attributes)) {
      if (!a.isInterleavedBufferAttribute) continue;
      // the raw stored values (getComponent would rescale normalized ones)
      const src = a.data.array;
      const stride = a.data.stride;
      const out = new src.constructor(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) {
        for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = src[i * stride + a.offset + c];
      }
      g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize, a.normalized));
    }
  });
  return gltf;
}

export function createGLTFLoader() {
  if (!draco) {
    draco = new DRACOLoader();
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  }
  return new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
}
