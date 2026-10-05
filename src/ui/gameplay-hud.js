import { CAR } from "../vehicle/config.js";

const TIER_COLOURS = ["#7fe3ff", "#ffd24a", "#ff9a2a", "#ff3b30"];
const FONT = `"Cascadia Mono",Consolas,monospace`;
const CRITICAL_DAMAGE = 0.85; // warn before RaceDirector's default maxDamage (1) ends the race
const GHOST_COLOR = "#7fe3ff"; // matches the ghost car's paint (src/core/ghost.js)
const HAZARD_COLOR = "#41c7e6"; // an active crosswind/fog patch — distinct from the ghost's cyan

const fmt = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};

export class GameplayHud {
  constructor() {
    this.root = document.createElement("div");
    this.root.style.cssText = `position:fixed;inset:0;z-index:24;pointer-events:none;
      font:700 11px/1 ${FONT};letter-spacing:.1em;color:#dbe8eb;display:none`;

    // The boost tank: the ordinary bar (cyan), and to its right the red
    // extension a drift combo adds. The bar is anchored at its left so the
    // extension grows outward.
    this.boost = document.createElement("div");
    this.boost.style.cssText = `position:absolute;left:calc(50% - min(140px,29vw));bottom:22px;
      text-align:left;text-shadow:0 1px 2px #000`;
    this.boost.innerHTML = `<div style="margin-bottom:5px;display:flex;gap:10px">BOOST
      <span data-ext style="color:#ff5a4a;display:none">+<span data-extn>0</span> RED TANK</span></div>
      <div style="display:flex;align-items:stretch">
        <div data-track style="width:min(280px,58vw);height:9px;box-sizing:border-box;
          border:1px solid rgba(190,220,225,.55);background:rgba(5,13,16,.72);overflow:hidden">
          <div data-fill style="height:100%;width:0;background:#32c9df;transition:width .1s linear"></div></div>
        <div data-xtrack style="width:0;height:9px;box-sizing:border-box;border:1px solid #ff4b3a;
          border-left:0;background:rgba(40,6,4,.75);overflow:hidden;
          box-shadow:0 0 10px rgba(255,59,48,.55);transition:width .25s ease;display:none">
          <div data-xfill style="height:100%;width:0;background:linear-gradient(90deg,#ff3b30,#ff8a5a);
            transition:width .1s linear"></div></div>
      </div>`;
    this.fill = this.boost.querySelector("[data-fill]");
    this.boostTrack = this.boost.querySelector("[data-track]");
    this.xtrack = this.boost.querySelector("[data-xtrack]");
    this.xfill = this.boost.querySelector("[data-xfill]");
    this.extLabel = this.boost.querySelector("[data-ext]");
    this.extN = this.boost.querySelector("[data-extn]");

    // Drift title: DRIFTER -> DRIFT MASTER x2 -> DRIFT KING x3 -> DRIFT GOD x5.
    this.drift = document.createElement("div");
    this.drift.style.cssText = `position:absolute;left:50%;bottom:70px;transform:translateX(-50%);
      text-align:center;white-space:nowrap;opacity:0;transition:opacity .25s;
      font:400 clamp(1.4rem,4vw,2.4rem)/1 Anton,Impact,'Arial Narrow Bold',sans-serif;
      letter-spacing:.06em;text-shadow:0 0 14px currentColor,0 2px 4px #000`;
    this.driftName = document.createElement("div");
    this.driftSub = document.createElement("div");
    this.driftSub.style.cssText = `font:700 11px/1.4 ${FONT};letter-spacing:.2em;margin-top:4px;color:#fff`;
    this.drift.append(this.driftName, this.driftSub);
    this.lastTier = -1;

    this.checkpoint = document.createElement("div");
    this.checkpoint.dataset.gameplayCheckpoint = "";
    this.checkpoint.style.cssText = `position:absolute;right:18px;top:18px;padding:6px 9px;
      background:rgba(5,13,16,.62);border:1px solid rgba(190,220,225,.3);text-shadow:0 1px 2px #000`;

    this.warning = document.createElement("div");
    this.warning.dataset.gameplayWarning = "";
    this.warning.style.cssText = `position:absolute;left:50%;top:145px;transform:translateX(-50%);
      font:900 22px/1 ${FONT};letter-spacing:.12em;color:#ffd24a;text-shadow:0 2px 4px #000;
      display:none;white-space:nowrap`;

    // A time-trial pickup moves the clock, not the boost bar, so it needs
    // its own brief callout rather than riding the boost fill.
    this.toast = document.createElement("div");
    this.toast.style.cssText = `position:absolute;left:50%;top:185px;transform:translateX(-50%);
      font:800 18px/1 ${FONT};letter-spacing:.1em;color:#58e08f;text-shadow:0 2px 4px #000;
      display:none;white-space:nowrap`;

    this.root.append(this.boost, this.drift, this.checkpoint, this.warning, this.toast);
    document.body.appendChild(this.root);
    this.responsiveStyle = document.createElement("style");
    this.responsiveStyle.textContent = `@media (max-width:600px) {
      [data-gameplay-checkpoint] { top:auto !important; right:8px !important; bottom:76px; }
      [data-gameplay-warning] { top:215px !important; font-size:16px !important; }
    }`;
    document.head.appendChild(this.responsiveStyle);
    this.lastKey = "";
  }

  setActive(active) {
    this.root.style.display = active ? "block" : "none";
    if (!active) {
      clearTimeout(this.toastTimer);
      this.toast.style.display = "none";
    }
  }

  /** A brief "+Ns" callout when a pickup extends a time-trial's clock. */
  flashTimeBonus(seconds) {
    clearTimeout(this.toastTimer);
    this.toast.textContent = `+${seconds}s`;
    this.toast.style.display = "block";
    this.toastTimer = setTimeout(() => (this.toast.style.display = "none"), 1300);
  }

  update(progress, track, state, ghostBestLap = null, hazard = null, finished = false) {
    if (!progress || !track || !state) return;
    // Ordinary tank, then the red extension beyond it.
    const base = CAR.boostCapacity;
    const extra = state.tankExtra ?? 0;
    const charge = Math.max(0, Math.min(1, state.boostCharge / base));
    const red = extra > 0 ? Math.max(0, Math.min(1, (state.boostCharge - base) / extra)) : 0;
    const key = `${charge.toFixed(3)}|${red.toFixed(3)}|${extra.toFixed(1)}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.fill.style.width = `${(charge * 100).toFixed(1)}%`;
      const showExt = extra > 0.5;
      this.xtrack.style.display = showExt ? "block" : "none";
      this.xtrack.style.width = showExt ? `calc(min(280px,58vw) * ${(extra / base).toFixed(3)})` : "0";
      this.xfill.style.width = `${(red * 100).toFixed(1)}%`;
      this.extLabel.style.display = showExt ? "inline" : "none";
      this.extN.textContent = Math.round(extra);
    }
    this.fill.style.background = state.boosting ? "#f5fbff" : "#32c9df";
    this.boostTrack.style.boxShadow = state.boosting ? "0 0 16px rgba(50,201,223,.9)" : "none";

    // The drift title, popping each time a new one is earned.
    const tier = state.driftTier ?? -1;
    const live = tier >= 0 && (state.driftGap ?? 0) < 0.9;
    this.drift.style.opacity = live ? "1" : "0";
    if (tier >= 0) {
      const t = CAR.driftTiers[tier];
      this.driftName.textContent = `${t.name} x${t.mult}`;
      this.driftSub.textContent = `${state.driftChain.toFixed(1)} s  ·  FILLS ${t.mult}x FASTER  ·  TANK +${t.ext}`;
      this.drift.style.color = TIER_COLOURS[tier];
      if (tier !== this.lastTier && live) {
        this.drift.animate(
          [{ transform: "translateX(-50%) scale(1.7)" }, { transform: "translateX(-50%) scale(1)" }],
          { duration: 320, easing: "cubic-bezier(.2,1.4,.4,1)" }
        );
        this.onTierUp?.(tier);
      }
    }
    this.lastTier = live ? tier : -1;

    this.checkpoint.innerHTML =
      `NEXT CP ${progress.nextCheckpoint + 1}/${track.checkpoints.length}` +
      (ghostBestLap !== null
        ? `<div style="color:${GHOST_COLOR};margin-top:3px">GHOST ${fmt(ghostBestLap)}</div>`
        : "");
    // Priority: a wrecked car ends the race, which outranks everything
    // else; an active hazard (rockfall, crosswind, fog — main.js picks
    // which one) is live right now and more actionable than the other
    // two, which are the player's own mistake to correct rather than
    // something happening to them this instant. Once the race is over
    // the results screen is the only thing that should be talking to the
    // player — a leftover "WRONG WAY" from the car's last few seconds
    // (it's handed to autopilot, but not reset) would otherwise sit
    // rendered on top of it.
    const critical = state.damage >= CRITICAL_DAMAGE;
    const message = finished
      ? ""
      : critical
        ? "CRITICAL DAMAGE"
        : hazard
          ? hazard
          : progress.wrongWay
            ? "WRONG WAY"
            : progress.missedCheckpoint !== null
              ? `CHECKPOINT ${progress.missedCheckpoint + 1} MISSED`
              : "";
    this.warning.textContent = message;
    // A falling rock is a physical danger (the old rockfall banner's own
    // yellow/black), not ambient weather (crosswind/fog's cyan) — kept
    // distinct so the two read as different kinds of warning at a glance.
    this.warning.style.color = critical ? "#ff4433" : hazard === "ROCKFALL" ? "#f2c200" : hazard ? HAZARD_COLOR : "#ffd24a";
    this.warning.style.display = message ? "block" : "none";
  }
}