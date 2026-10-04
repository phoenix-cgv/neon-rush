// Bottom-left circuit outline: the whole track as a white line with a dot
// for the player. Drawn once per level from the spline, so unlike the old
// scissored map camera it costs no second render pass.

const BOX = 150;
const PAD = 8;

export class TrackOutline {
  constructor() {
    this.root = document.createElement("div");
    this.root.style.cssText = `position:fixed;left:18px;bottom:16px;width:${BOX}px;height:${BOX}px;
      z-index:24;pointer-events:none;display:none;filter:drop-shadow(0 1px 3px rgba(0,0,0,.7))`;
    this.root.innerHTML = `<svg width="${BOX}" height="${BOX}" viewBox="0 0 ${BOX} ${BOX}">
      <path data-path fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <circle data-dot r="4.5" fill="#ffc933" stroke="#1b1410" stroke-width="1.5"/></svg>`;
    this.path = this.root.querySelector("[data-path]");
    this.dot = this.root.querySelector("[data-dot]");
    document.body.appendChild(this.root);
    this.visible = true;
    this.hasTrack = false;
    this.tf = null;
    this.others = []; // pooled circles for rivals and the ghost
  }

  #dot(i) {
    if (!this.others[i]) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("r", "3.5");
      c.setAttribute("stroke", "#1b1410");
      c.setAttribute("stroke-width", "1.2");
      // under the player's dot
      this.dot.before(c);
      this.others[i] = c;
    }
    return this.others[i];
  }

  build(track) {
    this.hasTrack = !!track;
    if (!track) return this.#apply();
    const n = 240;
    const pts = [];
    const f = {};
    for (let i = 0; i < n; i++) {
      const p = track.frameAt((i / n) * track.length, f).position;
      pts.push([p.x, p.z]);
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const k = (BOX - PAD * 2) / Math.max(x1 - x0, z1 - z0, 1);
    const ox = (BOX - (x1 - x0) * k) / 2 - x0 * k;
    const oz = (BOX - (z1 - z0) * k) / 2 - z0 * k;
    this.tf = (x, z) => [x * k + ox, z * k + oz];
    this.path.setAttribute(
      "d",
      pts.map(([x, z], i) => `${i ? "L" : "M"}${this.tf(x, z).map((v) => v.toFixed(1)).join(" ")}`).join("") + "Z"
    );
    this.#apply();
  }

  /**
   * @param {object} position  the player's position
   * @param {{position, colour:number, ghost?:boolean}[]} others  rivals and ghost
   */
  update(position, others = []) {
    if (!this.tf || !this.visible) return;
    others.forEach((o, i) => {
      const c = this.#dot(i);
      const [ox, oy] = this.tf(o.position.x, o.position.z);
      c.setAttribute("cx", ox.toFixed(1));
      c.setAttribute("cy", oy.toFixed(1));
      c.setAttribute("fill", o.ghost ? "#7fe3ff" : `#${o.colour.toString(16).padStart(6, "0")}`);
      c.setAttribute("fill-opacity", o.ghost ? "0.75" : "1");
      c.style.display = "";
    });
    for (let i = others.length; i < this.others.length; i++) this.others[i].style.display = "none";
    const [x, y] = this.tf(position.x, position.z);
    this.dot.setAttribute("cx", x.toFixed(1));
    this.dot.setAttribute("cy", y.toFixed(1));
  }

  setVisible(v) {
    this.visible = !!v;
    this.#apply();
  }

  #apply() {
    this.root.style.display = this.visible && this.hasTrack ? "block" : "none";
  }
}
