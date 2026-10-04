import { Save } from "../core/save.js";

// The home screen. Plain DOM over the canvas; the live city track is the
// backdrop (main.js orbits the camera round the start line while it is
// open). Settings write straight to Save and notify via onChange.

const SCHEMES = [
  ["keys", "WASD"],
  ["arrows", "Arrows"],
  ["both", "Both"],
];

export class Dashboard {
  constructor({ gameName, levels, onPlay, onChange, onClick } = {}) {
    this.gameName = gameName;
    this.levels = levels; // [{ id, title }] in play order
    this.onPlay = onPlay;
    this.onChange = onChange;
    this.onClick = onClick;
    this.open = false;
    this.selected = 0;

    this.root = document.createElement("div");
    this.root.style.cssText = `
      position:fixed; inset:0; z-index:60; display:none;
      background:linear-gradient(90deg,rgba(4,6,16,.82) 0%,rgba(4,6,16,.35) 55%,rgba(4,6,16,0) 100%);
      font:15px/1.5 "Cascadia Mono",Consolas,monospace; color:#e4ecff;`;
    this.panel = document.createElement("div");
    this.panel.style.cssText = `
      position:absolute; left:max(4vw,16px); top:50%; transform:translateY(-50%);
      width:min(26rem,calc(100vw - 32px));`;
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);

    this.root.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      this.onClick?.();
      this.#act(el.dataset.act);
    });
  }

  show(currentIndex) {
    this.selected = Math.min(currentIndex, this.#max() - 1);
    this.open = true;
    this.root.style.display = "block";
    this.render();
  }

  hide() {
    this.open = false;
    this.root.style.display = "none";
  }

  #max() {
    return Math.min(Math.max(1, Save.get("maxLevel") | 0), this.levels.length);
  }

  #toggle(label, key, on) {
    return this.#row(
      label,
      `<button data-act="toggle:${key}" style="${btn(on)}">${on ? "ON" : "OFF"}</button>`
    );
  }

  #row(label, control) {
    return `<div style="display:flex;justify-content:space-between;align-items:center;
      gap:1rem;padding:.5rem 0;border-bottom:1px solid rgba(130,160,255,.18)">
      <span style="color:#9fb0d8">${label}</span><span>${control}</span></div>`;
  }

  render() {
    const max = this.#max();
    const scheme = Save.get("controlScheme");
    const lvl = this.levels[this.selected];
    this.panel.innerHTML = `
      <div style="font-size:clamp(2.2rem,8vw,3.6rem);font-weight:800;letter-spacing:.06em;
        line-height:1;color:#fff;text-shadow:0 0 18px #3df2ff,0 0 42px #ff2fd6">
        ${this.gameName.toUpperCase()}</div>
      <div style="color:#7fe9ff;margin:.4rem 0 1.4rem;letter-spacing:.2em;font-size:.8rem">
        STREET RACING</div>
      <button data-act="play" style="font:inherit;font-size:1.3rem;font-weight:700;cursor:pointer;
        width:100%;padding:.8rem;border-radius:4px;letter-spacing:.2em;color:#06101a;
        background:linear-gradient(90deg,#3df2ff,#ff2fd6);border:0;
        box-shadow:0 0 22px rgba(61,242,255,.55)">&#9654; PLAY</button>
      <div style="margin-top:1.2rem;padding:.2rem 1rem;background:rgba(8,12,28,.72);
        border:1px solid rgba(130,160,255,.3);border-radius:4px;backdrop-filter:blur(3px)">
        ${this.#row(
          "Current level",
          `<button data-act="prev" style="${btn(false)}" ${this.selected === 0 ? "disabled" : ""}>&lsaquo;</button>
           <span style="display:inline-block;min-width:7.5rem;text-align:center">
             ${this.selected + 1} &middot; ${lvl.title}</span>
           <button data-act="next" style="${btn(false)}" ${this.selected >= max - 1 ? "disabled" : ""}>&rsaquo;</button>`
        )}
        ${this.#row("Max level achieved", `<b style="color:#ffd84a">${max}</b> / ${this.levels.length}`)}
        ${this.#toggle("Music", "music", Save.get("music") !== false)}
        ${this.#toggle("Sound", "sound", Save.get("sound") !== false)}
        ${this.#row(
          "Controls",
          SCHEMES.map(
            ([v, t]) => `<button data-act="scheme:${v}" style="${btn(scheme === v)};margin-left:.25rem">${t}</button>`
          ).join("")
        )}
      </div>`;
  }

  #act(act) {
    if (act === "play") {
      this.hide();
      return this.onPlay?.(this.selected);
    }
    if (act === "prev" && this.selected > 0) this.selected--;
    else if (act === "next" && this.selected < this.#max() - 1) this.selected++;
    else if (act.startsWith("toggle:")) {
      const k = act.split(":")[1];
      Save.set(k, Save.get(k) === false);
    } else if (act.startsWith("scheme:")) {
      Save.set("controlScheme", act.split(":")[1]);
    }
    this.onChange?.(this.selected);
    this.render();
  }
}

function btn(active) {
  return `font:inherit;cursor:pointer;padding:.22rem .7rem;border-radius:3px;color:#fff;
    background:${active ? "#1b6b8a" : "rgba(255,255,255,.08)"};
    border:1px solid ${active ? "#3df2ff" : "rgba(150,175,255,.35)"}`;
}
