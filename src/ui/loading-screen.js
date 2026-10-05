// The loading screen: a full-screen overlay in the title page's colours — a
// neon road running to the horizon, the game's name, the level being loaded
// and a bar that sweeps while it works. It is created, and shown, as soon as
// this module is evaluated, so it covers the page from the first moment
// rather than after the (slow) level has downloaded.

const ORANGE = "#e8602c";
const CREAM = "#f4eee0";
const DISPLAY = "Anton,Impact,'Arial Narrow Bold',Haettenschweiler,sans-serif";
const TIPS = [
  "Drift to fill the boost tank — hold it to climb from Drifter to Drift God.",
  "Win a level to unlock the next one.",
  "Your best run races beside you as a ghost.",
  "Press R to restart, L to change level.",
  "In the tunnel, the rails light your way.",
];

class LoadingScreen {
  constructor() {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes nr-sweep{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}
      @keyframes nr-road{0%{background-position:0 0}100%{background-position:0 200px}}
      @keyframes nr-pulse{0%,100%{opacity:.55}50%{opacity:1}}`;
    document.head.appendChild(style);

    this.root = document.createElement("div");
    this.root.style.cssText = `position:fixed;inset:0;z-index:200;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:0;overflow:hidden;color:${CREAM};
      font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
      background:linear-gradient(180deg,#0d1220 0%,#1c1a2e 46%,#3a2230 62%,#e8602c 62.2%,#14161c 62.6%,#0a0c10 100%);
      transition:opacity .45s ease;`;
    this.root.innerHTML = `
      <div style="position:absolute;left:0;right:0;top:62.6%;bottom:0;perspective:380px;overflow:hidden">
        <div style="position:absolute;left:50%;top:0;width:150%;height:260%;transform:translateX(-50%) rotateX(62deg);transform-origin:50% 0;
          background:
            linear-gradient(90deg,transparent 0 24%,rgba(255,255,255,.55) 24% 24.5%,transparent 24.5% 75.5%,rgba(255,255,255,.55) 75.5% 76%,transparent 76%),
            #0a0c10">
          <div style="position:absolute;left:49.6%;width:.8%;top:0;bottom:0;
            background:repeating-linear-gradient(180deg,${ORANGE} 0 60px,transparent 60px 140px);
            animation:nr-road .5s linear infinite"></div></div>
      </div>
      <div style="position:absolute;left:0;right:0;top:calc(62.6% - 3px);height:3px;background:${ORANGE};box-shadow:0 0 28px 6px ${ORANGE}"></div>
      <div style="position:relative;transform:translateY(-14vh);text-align:center">
        <div style="font:400 clamp(3.2rem,11vw,7.5rem)/0.9 ${DISPLAY};letter-spacing:.02em;text-transform:uppercase">Neon
          <span style="color:${ORANGE};text-shadow:0 0 24px ${ORANGE}">Rush</span></div>
        <div data-role="what" style="margin-top:18px;font:600 .8rem ui-monospace,Consolas,monospace;letter-spacing:.3em;
          text-transform:uppercase;opacity:.85;animation:nr-pulse 1.4s ease-in-out infinite">Loading</div>
        <div style="margin:14px auto 0;width:min(22rem,70vw);height:4px;background:rgba(255,255,255,.14);overflow:hidden;border-radius:2px">
          <div style="width:34%;height:100%;background:${ORANGE};box-shadow:0 0 14px ${ORANGE};animation:nr-sweep 1.15s ease-in-out infinite"></div></div>
        <div data-role="tip" style="margin-top:22px;font-size:.78rem;opacity:.6;max-width:30rem;padding:0 16px"></div>
      </div>`;
    this.what = this.root.querySelector('[data-role="what"]');
    this.tip = this.root.querySelector('[data-role="tip"]');
    (document.body ?? document.documentElement).appendChild(this.root);
    this.shown = true;
    this.#tip();
  }

  #tip() {
    this.tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  }

  /** @param {string} what  e.g. "Mountain Track" */
  show(what = "") {
    this.what.textContent = what ? `Loading ${what}` : "Loading";
    this.#tip();
    this.root.style.display = "flex";
    this.root.style.opacity = "1";
    this.root.style.pointerEvents = "auto";
    this.shown = true;
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    this.root.style.opacity = "0";
    this.root.style.pointerEvents = "none";
    setTimeout(() => !this.shown && (this.root.style.display = "none"), 500);
  }

  fail(text) {
    this.what.textContent = text;
    setTimeout(() => this.hide(), 3000);
  }
}

export const loadingScreen = new LoadingScreen();
