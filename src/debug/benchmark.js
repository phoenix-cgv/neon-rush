// ---------------------------------------------------------------------
// Render benchmark (development only).
//
//   const b = await __dbg.benchmark();
//   console.table(await b.run(__dbg));
//
// Parks the car at a set of viewpoints (photo mode, see main.js) and, at
// each one, times the GPU drawing the same still frame under each
// quality preset. Keep the window VISIBLE while it runs: it measures on
// the browser's own frames, which Chrome stops for a hidden tab.
//
// HOW IT TIMES. A WebGL timer query (EXT_disjoint_timer_query_webgl2)
// brackets the GPU work of K renders of the frame, issued back to back
// inside one animation frame. Two things learned the hard way:
//   - One render per sample is useless on an integrated GPU: it drops
//     its clock between frames, so a light frame times as slow. K renders
//     keep it busy and the numbers become repeatable.
//   - gl.finish() is NOT a timer in Chrome. It returned 3 ms for a frame
//     and 146 ms for a cheaper one; Chrome's command buffer does not make
//     it block the way the specification describes.
// The median sample is reported, per render.
//
// Quality presets are applied without being SAVED: an interrupted run
// must not leave a player's options changed.
//
// It is the cost of DRAWING the frame (GPU), not physics or game logic.
// Draw calls and triangles are counted from one pass of the main scene
// alone (no post-processing quads, no minimap).
// ---------------------------------------------------------------------

export const VIEWS = [
  { level: "city", s: 420, label: "City street" },
  { level: "city", s: 0, label: "City start" },
  { level: "mountain", s: 1080, label: "Mountain cliffs" },
  { level: "mountain", s: 740, label: "Mountain tunnel" },
  { level: "grandprix", s: -30, label: "GP grid, 6 cars" },
  { level: "grandprix", s: 290, label: "GP floodlight" },
  { level: "grandprix", s: 2420, label: "GP tunnel" },
];

const frame = () => new Promise((r) => requestAnimationFrame(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} dbg  window.__dbg
 * @param {object} opts { views, presets, samples, k }
 * @returns {Promise<object[]>} one row per view: ms per render per preset
 */
export async function run(dbg, { views = VIEWS, presets = ["high", "medium", "low"], samples = 30, k = 6 } = {}) {
  const { renderer, post, scene, QUALITY } = dbg;
  const gl = renderer.getContext();
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!ext) throw new Error("no EXT_disjoint_timer_query_webgl2 in this browser");
  if (document.hidden) throw new Error("the tab is hidden: bring the window to the front");
  const camera = dbg.cameraRig.camera;

  // Wrap the game's own render so every frame it draws is K timed renders.
  const orig = post.render.bind(post);
  let times = [];
  let pending = [];
  post.render = () => {
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < k; i++) orig();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push(q);
  };
  const poll = () => {
    pending = pending.filter((q) => {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) times.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / k);
      gl.deleteQuery(q);
      return false;
    });
  };

  // Fixed resolutions only: the adaptive scaler would change the size
  // under the measurement.
  const adaptiveWas = dbg.adaptive?.enabled;
  dbg.adaptive?.setEnabled(false);
  const rows = [];
  try {
    for (const v of views) {
      if (dbg.level?.name !== v.level) await dbg.loadLevel(v.level);
      dbg.shot(v.s);
      await wait(1800); // the car settles; the sun, light pools and sky follow it

      const row = { view: v.label };
      renderer.info.autoReset = false;
      renderer.info.reset();
      renderer.render(scene, camera);
      row.calls = renderer.info.render.calls;
      row.tris = renderer.info.render.triangles;
      renderer.info.autoReset = true;

      for (const p of presets) {
        dbg.applyQuality(QUALITY[p]);
        for (let i = 0; i < 15; i++) {
          await frame(); // compile, resize, warm the clock
          poll();
        }
        times = [];
        while (times.length < samples) {
          await frame();
          poll();
        }
        times.sort((a, b) => a - b);
        row[p] = +times[times.length >> 1].toFixed(2);
      }
      rows.push(row);
    }
  } finally {
    post.render = orig;
    if (adaptiveWas) dbg.adaptive.setEnabled(true);
    dbg.applyQuality(); // back to the player's saved preset
  }
  return rows;
}
