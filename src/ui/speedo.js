// Bottom-right instrument: tachometer arc (x1000 rpm), gear and km/h.
//
// The car has no gearbox — just forward and reverse — so the gear and rpm
// shown here are cosmetic, derived from speed: six speed bands, rpm
// sweeping up through each and dropping at the shift.

const FONT = `Anton,Impact,'Arial Narrow Bold',sans-serif`;
const SIZE = 190;
const C = SIZE / 2;
const R = 78;
const A0 = 225; // degrees clockwise from 12 o'clock: lower-left, sweeping over the top
const SWEEP = 270;
const BANDS = [0, 11, 22, 34, 46, 58, 72]; // m/s at which each gear tops out

const pt = (deg, r) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + Math.cos(a) * r, C + Math.sin(a) * r];
};

export class Speedo {
  constructor() {
    this.root = document.createElement("div");
    this.root.style.cssText = `position:fixed;right:18px;bottom:16px;width:${SIZE}px;height:${SIZE}px;
      z-index:24;pointer-events:none;display:none;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.8)`;

    let ticks = "";
    for (let i = 0; i <= 9; i++) {
      const a = A0 + (i / 9) * SWEEP;
      const [x1, y1] = pt(a, R - 9);
      const [x2, y2] = pt(a, R);
      const [tx, ty] = pt(a, R - 21);
      const red = i >= 7 ? "#ff5a3c" : "#fff";
      ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${red}" stroke-width="2.5"/>
        <text x="${tx}" y="${ty + 4}" fill="${red}" font-size="12" text-anchor="middle"
          font-family="system-ui,sans-serif" font-weight="600">${i}</text>`;
    }
    const [sx, sy] = pt(A0, R);
    const [ex, ey] = pt(A0 + SWEEP, R);
    this.root.innerHTML = `
      <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
        <circle cx="${C}" cy="${C}" r="${R + 8}" fill="rgba(10,12,14,.35)"/>
        <path d="M${sx} ${sy} A${R} ${R} 0 1 1 ${ex} ${ey}" fill="none" stroke="#fff" stroke-width="3"/>
        ${ticks}
        <line data-needle x1="${C}" y1="${C}" x2="${C}" y2="${C - R + 6}" stroke="#ffc933" stroke-width="3.5"
          stroke-linecap="round" transform="rotate(${A0} ${C} ${C})"/>
        <circle cx="${C}" cy="${C}" r="5" fill="#ffc933"/>
      </svg>
      <div data-gear style="position:absolute;left:0;right:0;top:112px;text-align:center;
        font:400 30px/1 ${FONT};color:#ff5a3c"></div>
      <div data-kph style="position:absolute;left:0;right:0;top:140px;text-align:center;
        font:400 24px/1 ${FONT};color:#ffc933"></div>
      <div style="position:absolute;left:0;right:0;top:166px;text-align:center;
        font:600 11px/1 system-ui,sans-serif;letter-spacing:.05em">kmph</div>`;
    this.needle = this.root.querySelector("[data-needle]");
    this.gearEl = this.root.querySelector("[data-gear]");
    this.kphEl = this.root.querySelector("[data-kph]");
    this.rpm = 0;
    document.body.appendChild(this.root);
  }

  setActive(on) {
    this.root.style.display = on ? "block" : "none";
  }

  update(state, dt) {
    const v = Math.abs(state.speed);
    let g = 1;
    while (g < 6 && v > BANDS[g]) g++;
    const frac = Math.min(1, (v - BANDS[g - 1]) / (BANDS[g] - BANDS[g - 1]));
    const target = 1.2 + frac * 6.6;
    this.rpm += (target - this.rpm) * Math.min(1, dt * 12);
    const a = A0 + (this.rpm / 9) * SWEEP;
    this.needle.setAttribute("transform", `rotate(${a} ${C} ${C})`);
    this.gearEl.textContent = state.gear === -1 ? "R" : v < 0.5 ? "N" : g;
    this.kphEl.textContent = Math.round(v * 3.6);
  }
}
