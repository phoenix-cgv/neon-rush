// ---------------------------------------------------------------------
// Stacking shader patches on one built-in material.
//
// three lets a material edit its own shader source just before it
// compiles (`onBeforeCompile`), which is how the wet road and the surface
// detail add to MeshStandardMaterial without losing any of its lighting.
// But a material has only ONE onBeforeCompile: the Grand Prix asphalt is
// both wet and detailed, and whichever was assigned second would silently
// replace the first.
//
// So patches are registered by name and all run, in order, from a single
// onBeforeCompile. The program cache key lists them, so three compiles a
// separate program for each combination instead of reusing one that is
// missing a patch.
// ---------------------------------------------------------------------

/**
 * @param {THREE.Material} material
 * @param {string} key   names the patch; a material gets each key once
 * @param {(shader) => void} fn  edits shader.vertexShader / fragmentShader / uniforms
 * @returns {boolean} false if the material already had this patch
 */
export function addPatch(material, key, fn) {
  const patches = (material.userData.patches ??= new Map());
  if (patches.has(key)) return false;
  patches.set(key, fn);
  material.onBeforeCompile = (shader) => {
    for (const f of patches.values()) f(shader);
  };
  material.customProgramCacheKey = () => [...patches.keys()].join("|");
  material.needsUpdate = true;
  return true;
}
