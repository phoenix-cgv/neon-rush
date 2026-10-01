import { CAR } from "../vehicle/config.js";

const FONT = `"Cascadia Mono",Consolas,monospace`;

export class GameplayHud {
  constructor() {
    this.root = document.createElement("div");
    this.root.style.cssText = `position:fixed;inset:0;z-index:24;pointer-events:none;
      font:700 11px/1 ${FONT};letter-spacing:.1em;color:#dbe8eb;display:none`;

    this.boost = document.createElement("div");
    this.boost.style.cssText = `position:absolute;left:50%;bottom:22px;transform:translateX(-50%);
      width:min(280px,58vw);text-align:center;text-shadow:0 1px 2px #000`;
    this.boost.innerHTML = `<div style="margin-bottom:5px">BOOST</div><div data-track style="height:9px;
      border:1px solid rgba(190,220,225,.55);background:rgba(5,13,16,.72);overflow:hidden">
      <div data-fill style="height:100%;width:0;background:#32c9df;transition:width .1s linear"></div></div>`;
    this.fill = this.boost.querySelector("[data-fill]");
    this.boostTrack = this.boost.querySelector("[data-track]");

    this.checkpoint = document.createElement("div");
    this.checkpoint.dataset.gameplayCheckpoint = "";
    this.checkpoint.style.cssText = `position:absolute;right:18px;top:18px;padding:6px 9px;
      background:rgba(5,13,16,.62);border:1px solid rgba(190,220,225,.3);text-shadow:0 1px 2px #000`;

    this.warning = document.createElement("div");
    this.warning.dataset.gameplayWarning = "";
    this.warning.style.cssText = `position:absolute;left:50%;top:145px;transform:translateX(-50%);
      font:900 22px/1 ${FONT};letter-spacing:.12em;color:#ffd24a;text-shadow:0 2px 4px #000;
      display:none;white-space:nowrap`;

    this.root.append(this.boost, this.checkpoint, this.warning);
    document.body.appendChild(this.root);
    this.responsiveStyle = document.createElement("style");
    this.responsiveStyle.textContent = `@media (max-width:600px) {
      [data-gameplay-checkpoint] { top:auto !important; right:8px !important; bottom:76px; }
      [data-gameplay-warning] { top:215px !important; font-size:16px !important; }
    }`;
    document.head.appendChild(this.responsiveStyle);
    this.lastCharge = -1;
  }

  setActive(active) {
    this.root.style.display = active ? "block" : "none";
  }

  update(progress, track, state) {
    if (!progress || !track || !state) return;
    const charge = Math.max(0, Math.min(1, state.boostCharge / CAR.boostCapacity));
    if (Math.abs(charge - this.lastCharge) >= 0.002) {
      this.fill.style.width = `${(charge * 100).toFixed(1)}%`;
      this.lastCharge = charge;
    }
    this.fill.style.background = state.boosting ? "#f5fbff" : "#32c9df";
    this.boostTrack.style.boxShadow = state.boosting ? "0 0 16px rgba(50,201,223,.9)" : "none";

    this.checkpoint.textContent = `NEXT CP ${progress.nextCheckpoint + 1}/${track.checkpoints.length}`;
    const message = progress.wrongWay
      ? "WRONG WAY"
      : progress.missedCheckpoint !== null
        ? `CHECKPOINT ${progress.missedCheckpoint + 1} MISSED`
        : "";
    this.warning.textContent = message;
    this.warning.style.display = message ? "block" : "none";
  }
}