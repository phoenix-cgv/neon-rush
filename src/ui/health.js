// ---------------------------------------------------------------------
// Condition bar.
//
// Damage is already visible on the car — scratches, dents, dead lamps —
// but you spend the race looking at the BACK of your own car from six
// metres, which is exactly where a crease in the nose is hardest to see.
// The bar is the readable version of the same number.
//
// It is plain DOM over the canvas rather than anything drawn in WebGL:
// no draw call, no shader, and it costs nothing in the frame budget that
// the performance pass just bought back.
//
// It only writes to the DOM when the value actually moves. Setting
// style.width every frame on a value that has not changed is a layout
// invalidation sixty times a second for no reason.
// ---------------------------------------------------------------------

const GOOD = [0x4a, 0xc0, 0x8a];
const WARN = [0xd8, 0xa1, 0x3c];
const BAD = [0xd0, 0x45, 0x35];

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/** Green through amber to red, so the colour reads before the length does. */
function colourFor(health) {
  const t = 1 - health;
  const [from, to, k] =
    t < 0.5 ? [GOOD, WARN, t / 0.5] : [WARN, BAD, (t - 0.5) / 0.5];
  return `rgb(${lerp(from[0], to[0], k)},${lerp(from[1], to[1], k)},${lerp(
    from[2],
    to[2],
    k
  )})`;
}

export class HealthBar {
  constructor() {
    this.shown = -1;
    this.visible = true;

    this.root = document.createElement("div");
    this.root.style.cssText = `
      position:fixed; top:14px; left:50%; transform:translateX(-50%);
      z-index:20; width:min(300px,42vw);
      font:600 10px/1 "Cascadia Mono",Consolas,monospace;
      letter-spacing:.14em; color:#c9d6da; pointer-events:none;
      text-shadow:0 1px 2px rgba(0,0,0,.8);`;

    const label = document.createElement("div");
    label.textContent = "CONDITION";
    label.style.cssText = "margin-bottom:5px;text-align:center;opacity:.75";

    this.track = document.createElement("div");
    this.track.style.cssText = `
      height:9px; border:1px solid rgba(190,210,215,.45);
      background:rgba(8,14,16,.62); border-radius:1px; overflow:hidden;`;

    this.fill = document.createElement("div");
    this.fill.style.cssText = `
      height:100%; width:100%; background:${colourFor(1)};
      transition:width .12s linear, background-color .25s linear;`;

    this.track.appendChild(this.fill);
    this.root.append(label, this.track);
    document.body.appendChild(this.root);
  }

  /** @param {number} damage 0..1 from vehicle.state */
  update(damage) {
    const health = Math.max(0, Math.min(1, 1 - (damage ?? 0)));
    if (Math.abs(health - this.shown) < 0.005) return;
    this.shown = health;
    this.fill.style.width = `${(health * 100).toFixed(1)}%`;
    this.fill.style.backgroundColor = colourFor(health);
    // Only shout when it matters. A bar that pulses from the first scuff
    // is noise the player learns to ignore, and then it is not there when
    // the car is genuinely in trouble.
    this.root.style.opacity = health < 0.35 ? "1" : "0.82";
  }

  /** @returns {boolean} the new state, so a caller can persist it. */
  toggle() {
    return this.setVisible(!this.visible);
  }

  setVisible(v) {
    this.visible = !!v;
    this.root.style.display = this.visible ? "block" : "none";
    return this.visible;
  }
}
