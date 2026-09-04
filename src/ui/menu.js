import { Save, QUALITY } from "../core/save.js";
import { DEFAULT_BINDINGS } from "../core/input.js";

// ---------------------------------------------------------------------
// Pause and options.
//
// Plain DOM over the canvas rather than anything drawn in WebGL: it is
// keyboard-navigable and legible for free, and none of it competes with
// the render loop for frame time.
//
// Opening the menu PAUSES the fixed-step loop. It has to: the accumulator
// would otherwise bank several seconds of wall-clock time while the
// player reads, then discharge it in one burst of catch-up steps the
// moment they resume.
// ---------------------------------------------------------------------

const LABELS = {
  throttle: "Accelerate",
  brake: "Brake / reverse",
  left: "Steer left",
  right: "Steer right",
  handbrake: "Handbrake",
  boost: "Boost",
  camera: "Change camera",
  restart: "Restart",
  map: "Toggle map",
  level: "Switch level",
  debug: "Telemetry",
};

export class Menu {
  constructor({ onQuality, onAssist, onRestart, levelName } = {}) {
    this.open = false;
    this.page = "pause";
    this.awaitingBind = null;
    this.onQuality = onQuality;
    this.onAssist = onAssist;
    this.onRestart = onRestart;
    // A getter, not a value: the menu outlives every level change.
    this.levelName = levelName ?? (() => null);

    this.root = document.createElement("div");
    this.root.style.cssText = `
      position:fixed; inset:0; z-index:50; display:none;
      background:rgba(6,10,12,.72); backdrop-filter:blur(3px);
      font:14px/1.5 "Cascadia Mono",Consolas,monospace; color:#dce5e7;`;
    this.panel = document.createElement("div");
    this.panel.style.cssText = `
      position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
      width:min(30rem,90vw); max-height:86vh; overflow:auto;
      background:rgba(12,20,23,.97); border:1px solid rgba(120,155,165,.34);
      border-radius:4px; padding:1.4rem 1.6rem;
      box-shadow:0 24px 60px -20px rgba(0,0,0,.8);`;
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);

    // A rebind swallows the next keypress, so this listens at capture
    // depth to get in front of the game's own input handler.
    window.addEventListener(
      "keydown",
      (e) => {
        if (!this.awaitingBind) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.code !== "Escape") {
          const b = Save.get("bindings") || structuredClone(DEFAULT_BINDINGS);
          b[this.awaitingBind] = [e.code];
          Save.set("bindings", b);
        }
        this.awaitingBind = null;
        // Saving the binding is not enough — the live Input holds its own
        // reference to the old map and would keep answering to the old key
        // until the next reload.
        this.onAssist?.();
        this.render();
      },
      true
    );
  }

  toggle() {
    this.open = !this.open;
    this.page = "pause";
    this.root.style.display = this.open ? "block" : "none";
    if (this.open) this.render();
    return this.open;
  }

  close() {
    this.open = false;
    this.awaitingBind = null;
    this.root.style.display = "none";
  }

  #row(label, control) {
    return `<div style="display:flex;justify-content:space-between;align-items:center;
      gap:1rem;padding:.42rem 0;border-bottom:1px solid rgba(120,155,165,.14)">
      <span style="color:#a9bcc1">${label}</span><span>${control}</span></div>`;
  }

  #button(id, text, accent) {
    return `<button data-act="${id}" style="
      font:inherit;cursor:pointer;padding:.34rem .8rem;border-radius:3px;
      background:${accent ? "#12525c" : "rgba(255,255,255,.07)"};
      color:#e6eff1;border:1px solid rgba(140,175,185,.34)">${text}</button>`;
  }

  render() {
    const s = Save.data;
    // Records are per level — a Sprint ghost means nothing on the Circuit.
    const rec = Save.record(this.levelName());
    let html = "";

    if (this.page === "pause") {
      html = `
        <div style="font-size:1.5rem;letter-spacing:.03em;margin-bottom:.2rem">PAUSED</div>
        <div style="color:#7d9198;margin-bottom:1.1rem">
          ${rec.bestLap
            ? "Best lap " + rec.bestLap.toFixed(2) + " s" +
              (rec.ghost ? " &middot; ghost saved" : "")
            : "No lap set yet"}
        </div>
        <div style="display:flex;gap:.6rem;flex-wrap:wrap">
          ${this.#button("resume", "Resume", true)}
          ${this.#button("options", "Options")}
          ${this.#button("restart", "Restart race")}
        </div>`;
    } else if (this.page === "options") {
      const q = (v) =>
        `<button data-act="quality:${v}" style="font:inherit;cursor:pointer;
          padding:.24rem .6rem;margin-left:.3rem;border-radius:3px;
          background:${s.quality === v ? "#12525c" : "rgba(255,255,255,.07)"};
          color:#e6eff1;border:1px solid rgba(140,175,185,.3)">${v}</button>`;

      html = `
        <div style="font-size:1.25rem;margin-bottom:.9rem">OPTIONS</div>
        ${this.#row("Quality", q("low") + q("medium") + q("high"))}
        ${this.#row(
          "Landing assist",
          `<input data-act="autoLevel" type="range" min="0" max="20000" step="1000"
             value="${s.autoLevel}" style="vertical-align:middle">
           <span style="display:inline-block;width:3.4rem;text-align:right">${Math.round(
             (s.autoLevel / 14000) * 100
           )}%</span>`
        )}
        ${this.#row(
          "Wall assist",
          `<input data-act="wallAssist" type="range" min="0" max="1.5" step="0.1"
             value="${s.wallAssist}" style="vertical-align:middle">
           <span style="display:inline-block;width:3.4rem;text-align:right">${Math.round(
             s.wallAssist * 100
           )}%</span>`
        )}
        ${this.#row(
          "Mouse look",
          `<input data-act="mouseSensitivity" type="range" min="0.2" max="2.5" step="0.1"
             value="${s.mouseSensitivity}" style="vertical-align:middle">
           <span style="display:inline-block;width:3.4rem;text-align:right">${s.mouseSensitivity.toFixed(
             1
           )}x</span>`
        )}
        <div style="margin:1rem 0 .4rem;color:#7d9198">CONTROLS &mdash; click to rebind</div>
        ${Object.keys(LABELS)
          .map((k) => {
            const b = (Save.get("bindings") || DEFAULT_BINDINGS)[k] || [];
            const key = this.awaitingBind === k ? "press a key…" : b[0] || "—";
            return this.#row(
              LABELS[k],
              `<button data-act="bind:${k}" style="font:inherit;cursor:pointer;
                 min-width:7rem;padding:.22rem .5rem;border-radius:3px;
                 background:${this.awaitingBind === k ? "#7a4a12" : "rgba(255,255,255,.07)"};
                 color:#e6eff1;border:1px solid rgba(140,175,185,.3)">${key}</button>`
            );
          })
          .join("")}
        <div style="display:flex;gap:.6rem;margin-top:1.1rem;flex-wrap:wrap">
          ${this.#button("back", "Back", true)}
          ${this.#button("defaults", "Reset to defaults")}
        </div>`;
    }

    this.panel.innerHTML = html;
    this.panel.querySelectorAll("[data-act]").forEach((el) => {
      const act = el.dataset.act;
      if (el.tagName === "INPUT") {
        el.addEventListener("input", () => {
          Save.set(act, parseFloat(el.value));
          this.onAssist?.();
          this.render();
        });
      } else {
        el.addEventListener("click", () => this.#act(act));
      }
    });
  }

  #act(act) {
    if (act === "resume") return this.close();
    if (act === "options") { this.page = "options"; return this.render(); }
    if (act === "back") { this.page = "pause"; return this.render(); }
    if (act === "restart") { this.close(); return this.onRestart?.(); }
    if (act === "defaults") { Save.reset(); this.onQuality?.(); this.onAssist?.(); return this.render(); }
    if (act.startsWith("quality:")) {
      Save.set("quality", act.split(":")[1]);
      this.onQuality?.(QUALITY[Save.get("quality")]);
      return this.render();
    }
    if (act.startsWith("bind:")) {
      this.awaitingBind = act.split(":")[1];
      return this.render();
    }
  }
}
