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
const MONO = "ui-monospace,Consolas,'Cascadia Mono',monospace";
const DISPLAY = "Anton,Impact,'Arial Narrow Bold',Haettenschweiler,sans-serif";
const GLASS = "background:rgba(14,18,24,.88);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(6px)";

export class Dashboard {
  constructor({ gameName, levels, onPlay, onChange, onClick } = {}) {
    this.gameName = gameName;
    this.levels = levels; // [{ id, title }] in play order
    this.onPlay = onPlay;
    this.onChange = onChange;
    this.onClick = onClick;
    this.open = false;
    this.selected = 0;
    this.panelOpen = null;

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
    this.panelOpen = null;
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
    const two = (v) => String(v).padStart(2, "0");
    const label = `font:600 10px/1 ${MONO};letter-spacing:.3em;text-transform:uppercase`;
    const arrow = (act, glyph, off) =>
      `<button data-act="${act}" ${off ? "disabled" : ""} style="font:inherit;font-size:1.5rem;
        background:none;border:0;padding:0 .35rem;cursor:${off ? "default" : "pointer"};
        color:${off ? "rgba(244,238,224,.28)" : CREAM}">${glyph}</button>`;
    const link = (act, text) =>
      `<button data-act="${act}" style="${label};background:none;border:0;padding:0;cursor:pointer;
        color:${CREAM};opacity:.9">${text}</button>`;

    this.root.innerHTML = `
      <div style="position:absolute;inset:0;background:
        linear-gradient(90deg,rgba(8,14,20,.88) 0%,rgba(8,14,20,.55) 32%,rgba(8,14,20,0) 62%),
        linear-gradient(180deg,rgba(18,34,60,.45) 0%,rgba(255,120,60,.14) 55%,rgba(8,12,18,.55) 100%)"></div>

      <div style="position:absolute;left:44px;top:30px;display:flex;align-items:center;gap:12px;${label};color:${CREAM}">
        <span style="width:26px;height:2px;background:${ORANGE}"></span>Street Racing</div>
      <div style="position:absolute;right:44px;top:30px;${label};color:${CREAM};opacity:.8">
        Vol. 01 / ${lvl.title.split(" ")[0]}</div>

      <div style="position:absolute;left:44px;top:12vh;max-width:calc(100vw - 88px)">
        <div style="font:400 clamp(4.2rem,17vh,9.5rem)/.9 ${DISPLAY};text-transform:uppercase;
          letter-spacing:.01em;color:${CREAM}">Neon</div>
        <div style="font:400 clamp(4.2rem,17vh,9.5rem)/.9 ${DISPLAY};text-transform:uppercase;
          letter-spacing:.01em;color:${ORANGE}">Rush</div>
        <div style="height:3px;width:min(26rem,72vw);background:${ORANGE};margin:22px 0 14px"></div>
        <div style="${label};color:${CREAM};opacity:.85">Own the streets.</div>
      </div>

      <div style="position:absolute;left:44px;bottom:calc(18vh + 52px)">
        <button data-act="play" style="pointer-events:auto;display:flex;align-items:center;
          justify-content:space-between;gap:3rem;min-width:min(17rem,70vw);border:0;border-radius:0;
          cursor:pointer;padding:.9rem 1.2rem;background:${ORANGE};color:${CREAM}">
          <span style="font:400 1.45rem/1 ${DISPLAY};letter-spacing:.06em;text-transform:uppercase">Pull Off</span>
          <span style="font-size:1.4rem;line-height:1">&rarr;</span></button>
        <div style="${label};font-size:8px;margin-top:12px;opacity:.7;color:${CREAM}">Start the round</div>
      </div>

      <div style="position:absolute;left:44px;bottom:calc(6vh + 24px);display:flex;gap:2.4rem">
        ${link("settings", "Settings")}${link("credits", "Credits")}
      </div>
      <div style="position:absolute;left:44px;bottom:22px;${label};font-size:8px;opacity:.5">NR / Street Division</div>

      ${this.panelOpen === "settings" ? `
      <div style="${GLASS};position:absolute;left:44px;bottom:calc(6vh + 56px);width:min(20rem,calc(100vw - 88px));
        padding:6px 16px 12px;border-radius:2px;pointer-events:auto">
        <div style="${label};color:${AMBER};padding:12px 0 4px">Settings</div>
        ${this.#toggle("Music", "music", Save.get("music") !== false)}
        ${this.#toggle("Sound", "sound", Save.get("sound") !== false)}
        ${this.#row(
          "Controls",
          SCHEMES.map(
            ([v, t]) => `<button data-act="scheme:${v}" style="${chip(scheme === v)};margin-left:.25rem">${t}</button>`
          ).join("")
        )}
      </div>` : ""}
      ${this.panelOpen === "credits" ? `
      <div style="${GLASS};position:absolute;left:44px;bottom:calc(6vh + 56px);width:min(20rem,calc(100vw - 88px));
        padding:14px 16px;border-radius:2px;pointer-events:auto;font-size:12px;line-height:1.6;color:#c9c1b2">
        <div style="${label};color:${AMBER};margin-bottom:8px">Credits</div>
        Neon Rush &mdash; Street Division.<br>Low-poly city, mountain and circuit maps,
        and the coupe, modelled for the game. Built with three.js and Rapier.</div>` : ""}

      <div style="position:absolute;right:44px;bottom:calc(6vh + 24px);text-align:right;pointer-events:auto">
        <div style="${label};font-size:8px;opacity:.7;color:${CREAM};text-align:left">Select track</div>
        <div style="display:flex;align-items:center;gap:1rem;margin-top:8px">
          <span style="font:400 2.4rem/1 ${DISPLAY};color:${CREAM}">${two(this.selected + 1)}</span>
          <span style="text-align:left;min-width:9rem">
            <div style="font:400 1.1rem/1.1 ${DISPLAY};letter-spacing:.06em;text-transform:uppercase;color:${CREAM}">${lvl.title}</div>
            <div style="${label};font-size:8px;opacity:.7;margin-top:4px;color:${CREAM}">Level ${this.selected + 1} / ${n}</div>
          </span>
          <span>${arrow("prev", "&lsaquo;", this.selected === 0)}${arrow("next", nextLocked ? "&#128274;" : "&rsaquo;", this.selected >= max - 1)}</span>
        </div>
        ${nextLocked ? `<div style="${label};font-size:8px;margin-top:8px;color:${ORANGE}">Win level ${this.selected + 1} to unlock level ${this.selected + 2}</div>` : ""}
      </div>
      <div style="position:absolute;right:44px;bottom:22px;${label};font-size:8px;opacity:.5;color:${CREAM}">
        Best reached: ${two(max)}</div>`;
  }

  #act(act) {
    if (act === "play") {
      this.hide();
      return this.onPlay?.(this.selected);
    }
    if (act === "settings" || act === "credits") this.panelOpen = this.panelOpen === act ? null : act;
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
  return `font:inherit;cursor:pointer;padding:.25rem .7rem;border-radius:2px;color:${CREAM};
    background:${active ? ORANGE : "rgba(255,255,255,.08)"};
    border:1px solid ${active ? ORANGE : "rgba(255,255,255,.2)"}`;
}
