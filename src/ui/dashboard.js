import { Save } from "../core/save.js";

// The home screen. Plain DOM over the canvas; the live city track is the
// backdrop (main.js orbits the camera round the start line while it is
// open). Settings write straight to Save and notify via onChange.
//
// Levels unlock in order: Save "maxLevel" is the highest level the player
// may enter, and it only grows when the level before it is WON.

const SCHEMES = [
  ["keys", "WASD"],
  ["arrows", "Arrows"],
  ["both", "Both"],
];

const ORANGE = "#e8602c";
const CREAM = "#f4eee0";
const AMBER = "#f0b429";
const DISPLAY = "Anton,Impact,'Arial Narrow Bold',Haettenschweiler,sans-serif";
const GLASS = "background:rgba(34,32,30,.82);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(6px)";

export class Dashboard {
  constructor({ gameName, levels, onPlay, onChange, onClick } = {}) {
    this.gameName = gameName;
    this.levels = levels; // [{ id, title }] in play order
    this.onPlay = onPlay;
    this.onChange = onChange;
    this.onClick = onClick;
    this.open = false;
    this.selected = 0;
    this.settingsOpen = false;

    this.root = document.createElement("div");
    this.root.style.cssText = `
      position:fixed; inset:0; z-index:60; display:none; pointer-events:none;
      font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; color:${CREAM};`;
    document.body.appendChild(this.root);

    this.root.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el || el.disabled) return;
      this.onClick?.();
      this.#act(el.dataset.act);
    });
  }

  show(currentIndex) {
    this.selected = Math.min(currentIndex, this.#max() - 1);
    this.open = true;
    this.settingsOpen = false;
    this.root.style.display = "block";
    this.render();
  }

  hide() {
    this.open = false;
    this.root.style.display = "none";
  }

  /** Highest level the player may enter, 1-based. */
  #max() {
    return Math.min(Math.max(1, Save.get("maxLevel") | 0), this.levels.length);
  }

  #toggle(label, key, on) {
    return this.#row(
      label,
      `<button data-act="toggle:${key}" style="${chip(on)}">${on ? "ON" : "OFF"}</button>`
    );
  }

  #row(label, control) {
    return `<div style="display:flex;justify-content:space-between;align-items:center;
      gap:1rem;padding:.55rem 0;border-bottom:1px solid rgba(255,255,255,.1)">
      <span style="color:#c9c1b2">${label}</span><span>${control}</span></div>`;
  }

  render() {
    const max = this.#max();
    const scheme = Save.get("controlScheme");
    const n = this.levels.length;
    const lvl = this.levels[this.selected];
    const nextLocked = this.selected + 1 < n && this.selected + 1 >= max;
    const arrow = (act, glyph, off) =>
      `<button data-act="${act}" ${off ? "disabled" : ""} style="font:inherit;font-size:1.1rem;
        width:2rem;height:2rem;border-radius:6px;cursor:${off ? "default" : "pointer"};
        color:${off ? "rgba(244,238,224,.3)" : CREAM};background:rgba(255,255,255,.08);
        border:1px solid rgba(255,255,255,.14)">${glyph}</button>`;

    this.root.innerHTML = `
      <div style="position:absolute;left:22px;top:18px">
        <div style="font:700 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.35em;
          color:${AMBER};margin-bottom:6px">STREET RACING</div>
        <div style="font:400 clamp(2.6rem,7vw,4.6rem)/1 ${DISPLAY};text-transform:uppercase;
          color:${CREAM};text-shadow:0 3px 14px rgba(0,0,0,.45)">${this.gameName}</div>
        <div style="height:7px;width:100%;margin-top:6px;border-radius:1px;
          background:repeating-linear-gradient(135deg,${ORANGE} 0 9px,${AMBER} 9px 18px)"></div>
      </div>

      <div style="${GLASS};position:absolute;left:22px;bottom:22px;padding:10px 14px 9px;
        border-radius:10px;pointer-events:auto;min-width:9.5rem">
        <div style="font:700 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.3em;
          color:${AMBER};margin-bottom:8px">LEVEL</div>
        <div style="display:flex;align-items:center;gap:.7rem">
          ${arrow("prev", "&larr;", this.selected === 0)}
          <span style="font:400 2rem/1 ${DISPLAY};min-width:1.4rem;text-align:center">${this.selected + 1}</span>
          ${arrow("next", nextLocked ? "&#128274;" : "&rarr;", this.selected >= max - 1)}
        </div>
        <div style="font-size:11px;margin-top:6px;color:#c9c1b2">
          ${lvl.title} &middot; Level ${this.selected + 1} of ${n}</div>
        <div style="font-size:11px;color:#c9c1b2">Best reached: <b style="color:${AMBER}">${max}</b></div>
        ${nextLocked ? `<div style="font-size:11px;color:${ORANGE};margin-top:3px">
          Win level ${this.selected + 1} to unlock level ${this.selected + 2}</div>` : ""}
      </div>

      <button data-act="play" style="pointer-events:auto;position:absolute;left:50%;bottom:22px;
        transform:translateX(-50%);font:inherit;cursor:pointer;border:0;border-radius:999px;
        padding:.65rem 2.6rem;background:${ORANGE};color:#1b1410;
        box-shadow:0 6px 26px rgba(232,96,44,.55)">
        <div style="font:400 1.5rem/1.1 ${DISPLAY};letter-spacing:.04em;text-transform:uppercase">Pull Off</div>
        <div style="font:600 9px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.3em;
          opacity:.75">START THE ROUND</div>
      </button>

      ${this.settingsOpen ? `
      <div style="${GLASS};position:absolute;right:22px;bottom:70px;width:min(20rem,calc(100vw - 44px));
        padding:6px 16px 12px;border-radius:12px;pointer-events:auto">
        <div style="font:700 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.3em;
          color:${AMBER};padding:12px 0 4px">SETTINGS</div>
        ${this.#toggle("Music", "music", Save.get("music") !== false)}
        ${this.#toggle("Sound", "sound", Save.get("sound") !== false)}
        ${this.#row(
          "Controls",
          SCHEMES.map(
            ([v, t]) => `<button data-act="scheme:${v}" style="${chip(scheme === v)};margin-left:.25rem">${t}</button>`
          ).join("")
        )}
      </div>` : ""}

      <button data-act="settings" style="${GLASS};pointer-events:auto;position:absolute;right:22px;
        bottom:22px;font:600 13px system-ui,sans-serif;color:${CREAM};cursor:pointer;
        padding:.55rem 1rem;border-radius:999px">&#9881; Settings</button>`;
  }

  #act(act) {
    if (act === "play") {
      this.hide();
      return this.onPlay?.(this.selected);
    }
    if (act === "settings") this.settingsOpen = !this.settingsOpen;
    else if (act === "prev" && this.selected > 0) this.selected--;
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

function chip(active) {
  return `font:inherit;cursor:pointer;padding:.25rem .7rem;border-radius:999px;color:${CREAM};
    background:${active ? ORANGE : "rgba(255,255,255,.08)"};
    border:1px solid ${active ? ORANGE : "rgba(255,255,255,.2)"}`;
}
