// ---------------------------------------------------------------------
// Pack a map .glb for the web: lossless, order-preserving compression.
//
//   npm run pack:map -- assets/maps/GrandPrix.glb            (in place)
//   npm run pack:map -- exported.glb assets/maps/GrandPrix.glb
//
// Run it on every map after exporting from Blender, or the map ships at
// full size (the three maps went from 35 MB to 21 MB).
//
// Why not Draco, or `gltf-transform optimize`: the game builds each track
// from the road ribbon's vertex ORDER (src/levels/glb-map.js), finds
// pieces by mesh NAME, and builds its colliders from the geometry. Draco
// reorders and merges vertices, even in its "sequential" mode, and
// optimize also joins and simplifies meshes. This applies only meshopt's
// codec (EXT_meshopt_compression): every position comes back bit for bit
// and every triangle is the same; normals are stored at 8 bits (< 1°).
// Props and buildings have no such constraint — use Draco for those:
//   npx @gltf-transform/cli draco in.glb out.glb
// ---------------------------------------------------------------------
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import { statSync } from "node:fs";

const [src, dst = src] = process.argv.slice(2);
if (!src) {
  console.error("usage: npm run pack:map -- <in.glb> [out.glb]");
  process.exit(1);
}

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
// Every extension registered, so none is silently dropped on the way
// through (KHR_materials_emissive_strength carries the floodlights' glow).
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

const before = statSync(src).size;
const doc = await io.read(src);
doc
  .createExtension(EXTMeshoptCompression)
  .setRequired(true)
  .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
await io.write(dst, doc);
const mb = (n) => (n / 1048576).toFixed(1);
console.log(`${src} ${mb(before)} MB -> ${dst} ${mb(statSync(dst).size)} MB`);
