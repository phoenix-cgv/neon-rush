// ---------------------------------------------------------------------
// The race display: start lights, lap / position / time, and the
// classification at the flag.
//
// The gantry's own lamps light up in the world too, but from pole
// position they are directly overhead and out of the chase camera's
// view, so the sequence is mirrored here where every car can see it.
// ---------------------------------------------------------------------

const FONT = `"Cascadia Mono",Consolas,monospace`;

const fmt = (t) => {
  if (t === null || t === undefined) return "—";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};
const hex = (c) => `#${c.toString(16).padStart(6, "0")}`;

export class RaceHud {
  constructor() {
    this.root = document.createElement("div");
    this.root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:25;
      font:600 13px/1.3 ${FONT};color:#e6eff1;text-shadow:0 1px 2px rgba(0,0,0,.85);display:none`;

    // lap / position / time, under the condition bar
    this.bar = document.createElement("div");
    this.bar.style.cssText = `position:absolute;top:44px;left:50%;transform:translateX(-50%);
      display:flex;gap:18px;letter-spacing:.08em;background:rgba(8,14,16,.55);
      padding:5px 12px;border:1px solid rgba(190,210,215,.3);border-radius:3px;white-space:nowrap`;

    // five start lamps
    this.lights = document.createElement("div");
    this.lights.style.cssText = `position:absolute;top:92px;left:50%;transform:translateX(-50%);
      display:flex;gap:12px;padding:10px 14px;background:rgba(8,10,12,.78);
      border:1px solid rgba(190,210,215,.3);border-radius:6px`;
    this.lamps = Array.from({ length: 5 }, () => {
      const l = document.createElement("div");
      l.style.cssText = `width:30px;height:30px;border-radius:50%;background:#2a0806;
        border:2px solid #111;transition:background .06s,box-shadow .06s`;
      this.lights.appendChild(l);
      return l;
    });

    this.go = document.createElement("div");
    this.go.textContent = "GO";
    this.go.style.cssText = `position:absolute;top:88px;left:50%;transform:translateX(-50%);
      font:800 44px/1 ${FONT};letter-spacing:.2em;color:#58e08f;display:none`;

    // classification at the flag
    this.results = document.createElement("div");
    this.results.style.cssText = `position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
      min-width:min(420px,90vw);max-width:92vw;background:rgba(8,14,16,.88);
      border:1px solid rgba(190,210,215,.35);border-radius:6px;padding:16px 18px;display:none`;

    this.root.append(this.bar, this.lights, this.go, this.results);
    document.body.appendChild(this.root);
    this.lastResults = "";
  }

  /** Show for a level with a race director, hide otherwise. */
  setActive(on) {
    this.root.style.display = on ? "block" : "none";
    this.results.style.display = "none";
    this.lastResults = "";
  }

  /**
   * @param {object|null} director  RaceDirector
   * @param {object|null} race
   */
  update(director, race) {
    if (!director || !race) return;

    // start lights
    const lighting = director.state === "lights";
    this.lights.style.display = lighting ? "flex" : "none";
    this.lamps.forEach((l, i) => {
      const on = lighting && i < director.lampsLit;
      l.style.background = on ? "#ff2a1a" : "#2a0806";
      l.style.boxShadow = on ? "0 0 14px #ff2a1a" : "none";
    });
    const t = director.goneFor;
    this.go.style.display = t !== null && t < 1.2 ? "block" : "none";

    // lap / position / time
    const p = race.player.progress;
    const lap = Math.max(1, Math.min(director.laps, p.lap));
    const field = race.cars.length;
    const pos = director.playerPosition;
    this.bar.innerHTML =
      `<span>LAP ${lap}/${director.laps}</span>` +
      `<span>P${pos}/${field}</span>` +
      `<span>${fmt(t ?? 0)}</span>`;

    // results
    if (director.state === "finished") {
      const rows = director.results();
      const winner = rows[0]?.time ?? null;
      const html =
        `<div style="font:800 20px/1.2 ${FONT};letter-spacing:.08em;margin-bottom:4px">` +
        `FINISHED — P${pos} of ${field}</div>` +
        `<div style="color:#8fa5ac;margin-bottom:12px">${director.laps} laps</div>` +
        `<table style="border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums">` +
        rows
          .map((r, i) => {
            const status = r.finished
              ? i === 0 || winner === null
                ? fmt(r.time)
                : `+${(r.time - winner).toFixed(2)} s`
              : `lap ${r.lap}`;
            const weight = r.isPlayer ? "color:#fff;font-weight:800" : "color:#c9d6da";
            return (
              `<tr style="${weight}">` +
              `<td style="padding:3px 8px 3px 0;width:2.2em">P${i + 1}</td>` +
              `<td style="padding:3px 8px"><span style="display:inline-block;width:10px;height:10px;` +
              `border-radius:2px;background:${hex(r.colour)};margin-right:8px"></span>${r.name}</td>` +
              `<td style="padding:3px 0 3px 8px;text-align:right">${status}</td></tr>`
            );
          })
          .join("") +
        `</table>` +
        `<div style="margin-top:14px;color:#8fa5ac;letter-spacing:.06em">` +
        `R&nbsp; race again &nbsp;·&nbsp; L&nbsp; next level</div>`;
      // Rebuilt only when something changed: rewriting innerHTML every
      // frame is wasted layout work.
      if (html !== this.lastResults) {
        this.results.innerHTML = html;
        this.lastResults = html;
      }
      this.results.style.display = "block";
    } else {
      this.results.style.display = "none";
    }
  }
}
