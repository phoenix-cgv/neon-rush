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

    // position / laps / times, top-left
    this.bar = document.createElement("div");
    this.bar.style.cssText = `position:absolute;top:22px;left:26px;white-space:nowrap;
      font:600 13px/1.35 system-ui,sans-serif;letter-spacing:0;color:#fff`;
    this.lapTimes = [];
    this.lastLap = 1;

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
    this.lapTimes = [];
    this.lastLap = 1;
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
    // Completed laps are logged as the lap counter ticks over.
    if (p.lap > this.lastLap && p.lastLapTime !== null) this.lapTimes.push(p.lastLapTime);
    this.lastLap = p.lap;
    const total = t ?? 0;
    const done = this.lapTimes.reduce((a, b) => a + b, 0);
    const stamp = (x) => {
      if (x === null) return "-:--.---";
      const m = Math.floor(x / 60);
      return `${m}:${(x - m * 60).toFixed(3).padStart(6, "0")}`;
    };
    const ord = (n) => n + (["th", "st", "nd", "rd"][(n % 100 >> 3) ^ 1 && n % 10 < 4 ? n % 10 : 0]);
    const small = `font:400 11px/1.5 system-ui,sans-serif;opacity:.9`;
    const rows = Array.from({ length: director.laps }, (_, i) =>
      `<div>(${i + 1}) ${stamp(i < this.lapTimes.length ? this.lapTimes[i] : i === lap - 1 ? Math.max(0, total - done) : null)}</div>`
    ).join("");
    this.bar.innerHTML =
      (field > 1
        ? `<div style="font:italic 800 22px/1.1 system-ui,sans-serif">Position <span style="font-size:30px;margin-left:8px">${ord(pos)}</span></div>`
        : "") +
      `<div style="font:italic 600 17px/1.5 system-ui,sans-serif;opacity:.95">Laps ${lap} / ${director.laps}</div>` +
      `<div style="${small};margin-top:6px"><div>Total Time &nbsp;&nbsp; ${stamp(total)}${director.timeLimit ? ` / ${stamp(director.timeLimit)}` : ""}</div>${rows}</div>`;

    // results
    if (director.state === "finished") {
      const rows = director.results();
      const winner = rows[0]?.time ?? null;
      const heading = director.outcome === "won"
        ? "VICTORY"
        : director.reason === "time-limit"
          ? "TIME UP"
          : director.reason === "wrecked"
            ? "WRECKED"
            : director.outcome === "lost"
              ? "RACE LOST"
              : "FINISHED";
      // Solo (a time trial, no other cars): a placing of "P1 of 1" tells
      // the player nothing a field of rivals would.
      const html =
        `<div style="font:800 20px/1.2 ${FONT};letter-spacing:.08em;margin-bottom:4px">` +
        `${heading}${field > 1 ? ` — P${pos} of ${field}` : ""}</div>` +
        `<div style="color:#8fa5ac;margin-bottom:12px">` +
        `${director.laps} lap${director.laps === 1 ? "" : "s"}</div>` +
        `<table style="border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums">` +
        rows
          .map((r, i) => {
            const status = director.outcome === "lost" && r.isPlayer && !r.finished
              ? "DNF"
              : r.finished
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
