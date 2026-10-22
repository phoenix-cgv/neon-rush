// Injected before the game's own scripts. Time stands still unless the
// recorder steps it: performance.now, requestAnimationFrame and timed
// setTimeouts all run on __vt, so every captured frame is exactly 1/30 s
// of game time however long software WebGL took to draw it.
(() => {
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  let vt = 0;
  let nextId = 1e7;
  const timers = new Map();
  let rafs = [];
  let rafId = 0;

  performance.now = () => vt;
  window.setTimeout = (fn, ms = 0, ...args) => {
    if (typeof fn !== "function" || !(ms > 0)) return realSetTimeout(fn, ms, ...args);
    const id = ++nextId;
    timers.set(id, { at: vt + ms, fn, args });
    return id;
  };
  window.clearTimeout = (id) => {
    if (!timers.delete(id)) realClearTimeout(id);
  };
  window.requestAnimationFrame = (cb) => {
    rafs.push({ id: ++rafId, cb });
    return rafId;
  };
  window.cancelAnimationFrame = (id) => {
    rafs = rafs.filter((r) => r.id !== id);
  };

  window.__vt = {
    get now() {
      return vt;
    },
    step(ms) {
      const target = vt + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= target && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        timers.delete(due[0]);
        vt = Math.max(vt, due[1].at);
        try {
          due[1].fn(...due[1].args);
        } catch (e) {
          console.error(e);
        }
      }
      vt = target;
      const list = rafs;
      rafs = [];
      for (const r of list) {
        try {
          r.cb(vt);
        } catch (e) {
          console.error(e);
        }
      }
    },
  };

  // A first visit as the game would see it, except: High quality (the GPU
  // check would pick Medium for software WebGL) and no audio, which this
  // recording cannot capture anyway.
  try {
    if (!localStorage.getItem("neon-rush.v1")) {
      localStorage.setItem("neon-rush.v1", JSON.stringify({ quality: "high", music: false, sound: false }));
    }
  } catch {}
})();
