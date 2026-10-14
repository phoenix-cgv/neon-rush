// ---------------------------------------------------------------------
// A story card: the full screen goes dark over the paused level, an act
// and a title come up, and the lines sit under them until the player
// presses on.
//
// The game keeps rendering behind it — the card is DOM over the canvas,
// like every other screen here — but main.js holds the race while one is
// open (the start lights do not count down and the car takes no input),
// so a card can never cost the player time.
//
// The words are not in this file. They are in src/core/story.js.
// ---------------------------------------------------------------------

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const ORANGE = "#e8602c";
const CREAM = "#f4eee0";
const DISPLAY = "Anton,Impact,'Arial Narrow Bold',Haettenschweiler,sans-serif";
const MONO = "ui-monospace,Consolas,'Cascadia Mono',monospace";
const LABEL = `font:600 10px/1 ${MONO};letter-spacing:.22em;text-transform:uppercase`;

export class StoryCard {
  constructor() {
    this.open = false;
    this.onDone = null;
    this.root = document.createElement("div");
    // Above the pause menu (50) and the title page (60), below the
    // loading screen (200): a card is read instead of whatever it is
    // over, and the welcome one comes up on the title page itself.
    this.root.style.cssText = `position:fixed;inset:0;z-index:70;display:none;
      background:linear-gradient(180deg,rgba(6,9,14,.93) 0%,rgba(6,9,14,.88) 60%,rgba(6,9,14,.95) 100%);
      color:${CREAM};font-family:${MONO}`;
    document.body.appendChild(this.root);

    // Enter, Space or a click moves on — whichever the player reaches for.
    this.onKey = (e) => {
      if (!this.open) return;
      if (e.key === "Enter" || e.key === " " || e.code === "Space") {
        e.preventDefault();
        // Immediate: stopPropagation alone does not stop other listeners
        // on the SAME element, and the title page's "Enter starts the
        // round" is also on window — so dismissing the welcome card
        // started the race in the same keystroke.
        e.stopImmediatePropagation();
        this.dismiss();
      }
    };
    // Capture, so the key does not also reach the game underneath.
    window.addEventListener("keydown", this.onKey, true);
    this.root.addEventListener("pointerdown", () => this.dismiss());
  }

  /**
   * Put a card up. `done` is called once, when the player moves on.
   * @param {object} card  { act, title, lines, note, controls }
   *   `controls` is [what it does, which keys][] — the welcome card uses
   *   it for the key list; story beats leave it out.
   */
  show({ act, title, lines = [], note = "", controls = null }, done = null) {
    this.open = true;
    this.onDone = done;
    this.root.style.display = "block";
    this.root.innerHTML = `
      <div style="position:absolute;left:clamp(24px,7vw,96px);top:50%;transform:translateY(-50%);
        max-width:min(46rem,calc(100vw - 48px))">
        <div style="display:flex;align-items:center;gap:12px;${LABEL};color:${ORANGE}">
          <span style="width:26px;height:2px;background:${ORANGE}"></span>${esc(act)}</div>
        <div style="font:400 clamp(2.6rem,8vh,5rem)/.95 ${DISPLAY};text-transform:uppercase;
          letter-spacing:.01em;color:${CREAM};margin:14px 0 18px">${esc(title)}</div>
        <div style="height:3px;width:min(18rem,60vw);background:${ORANGE};margin-bottom:22px"></div>
        ${lines
          .map(
            (l) => `<div style="font:400 clamp(.95rem,2.1vh,1.15rem)/1.65 ${MONO};
              color:${CREAM};opacity:.9;margin-bottom:.55rem">${esc(l)}</div>`
          )
          .join("")}
        ${controls
          ? `<div style="display:grid;grid-template-columns:auto auto;gap:.5rem 1.6rem;
               margin:22px 0 4px;justify-content:start;align-items:baseline">
              ${controls
                .map(
                  ([what, keys]) => `
                  <div style="font:400 clamp(.85rem,1.9vh,1rem)/1.5 ${MONO};color:${CREAM};opacity:.75">${esc(what)}</div>
                  <div style="font:700 clamp(.85rem,1.9vh,1rem)/1.5 ${MONO};color:${ORANGE};white-space:nowrap">${esc(keys)}</div>`
                )
                .join("")}
            </div>`
          : ""}
        ${note ? `<div style="${LABEL};color:${ORANGE};margin-top:20px">${esc(note)}</div>` : ""}
        <div style="${LABEL};color:${CREAM};opacity:.55;margin-top:28px">Press Enter to continue</div>
      </div>`;
  }

  dismiss() {
    if (!this.open) return;
    this.open = false;
    this.root.style.display = "none";
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }
}
