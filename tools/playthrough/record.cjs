// ---------------------------------------------------------------------
// Record a playthrough video: the title page, then every level in order,
// driving through two checkpoint gates on each (the game's own AI at the
// wheel), pausing back to the title page and pulling off on the next.
//
//   npm run build && npm run preview            (serves dist/ on :4173)
//   NODE_PATH=$(npm root -g) xvfb-run -a -s "-screen 0 1920x1080x24" \
//     node tools/playthrough/record.cjs [url] [framesDir] [--test]
//   ffmpeg -framerate 30 -i playthrough-frames/%06d.jpg -c:v libx264 -crf 20 \
//     -pix_fmt yuv420p -movflags +faststart playthrough.mp4
//
// Needs Playwright (global, or `npm i -D playwright`) and Xvfb. --test
// cuts every hold short and drives three seconds a level: a quick check
// that the flow still works after the UI changes.
//
// It does not record in real time. Software WebGL draws about one frame
// a second, so virtual-clock.js stops the page's clock and this script
// steps it 1/30 s at a time, capturing each frame: the video plays at
// full speed however slowly it was drawn. There is no sound; the audio
// runs on the real clock and is switched off.
//
// Levels unlock by winning, and two gates is not a win, so the next level
// is unlocked through Save before each return to the title page.
// ---------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const URL = process.argv[2] ?? "http://localhost:4173/?adaptive=0";
const OUT = process.argv[3] ?? "playthrough-frames";
const TEST = process.argv.includes("--test");
const FPS = 30;
const DT = 1000 / FPS;
const W = 1280, H = 720;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let frameNo = 0;
let page;
let cdp;
const t0 = Date.now();

function log(...a) {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s f${frameNo}]`, ...a);
}

/** Advance game time by one frame; capture it unless told not to. */
async function step({ capture = true } = {}) {
  const st = await page.evaluate((dt) => {
    __vt.step(dt);
    const d = window.__dbg;
    const w = (window.__watch ??= { last: null, passed: 0 });
    const p = d?.progress;
    if (p && d.gates?.gates) {
      if (w.last !== null && p.lastCheckpoint !== w.last && d.gates.gates.some((g) => g.checkpoint === p.lastCheckpoint)) {
        w.passed++;
      }
      w.last = p.lastCheckpoint;
    }
    const ls = [...document.body.children].find((e) => e.style.zIndex === "200");
    return {
      ready: !!d,
      loading: !!ls && ls.style.display !== "none" && ls.style.opacity !== "0",
      state: d?.director?.state ?? null,
      gates: w.passed,
      speed: d?.vehicle?.state?.speed ?? 0,
      s: d?.vehicle?.s ?? 0,
      level: d?.level?.title ?? null,
    };
  }, DT);
  if (capture) {
    const file = path.join(OUT, String(frameNo).padStart(6, "0") + ".jpg");
    const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frameNo++;
  }
  return st;
}

/** Hold for `seconds` of game time, capturing every frame. */
async function hold(seconds) {
  let st;
  for (let i = 0; i < Math.round(seconds * FPS); i++) st = await step();
  return st;
}

/** Step without capturing until the level has finished loading. */
async function waitLoaded(maxCaptured = 30) {
  let st = await step({ capture: false });
  let shown = 0;
  // the load starts on a timer; give it a moment to begin
  for (let i = 0; i < 20 && !st.loading; i++) st = await step({ capture: false });
  while (st.loading) {
    st = await step({ capture: shown < maxCaptured });
    shown++;
    if (shown >= maxCaptured) await sleep(30);
  }
  // the loading screen fades out over 0.45 s
  return hold(0.5);
}

async function key(k) {
  await page.keyboard.down(k);
  await step();
  await page.keyboard.up(k);
}

async function click(sel) {
  const ok = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);
  if (!ok) throw new Error(`nothing to click at ${sel}`);
}

/** Lights, then drive (the game's own AI at the wheel) through two gates. */
async function driveTwoGates() {
  await page.evaluate(() => {
    window.__watch = { last: null, passed: 0 };
    __dbg.race.autopilotPlayer();
  });
  let st;
  let n = 0;
  do {
    st = await step();
    if (++n % 60 === 0) log(st.level, st.state, `gates ${st.gates}`, `${(st.speed * 3.6).toFixed(0)} km/h`, `s ${st.s.toFixed(0)}`);
    if (n > FPS * 90) throw new Error("two gates took over 90 s");
    if (TEST && n > FPS * 3) return st;
  } while (st.gates < 2);
  log("second gate passed");
  return hold(1.6); // watch it burn away
}

(async () => {
  // Clears only frames a previous run left, never anything else there.
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (/^\d{6}\.jpg$/.test(f)) fs.rmSync(path.join(OUT, f));
  const browser = await chromium.launch({
    // Headed under Xvfb, so WebGL runs on Mesa's llvmpipe: about three
    // times faster than headless Chromium's SwiftShader, same image.
    headless: false,
    args: ["--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist"],
  });
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  await ctx.addInitScript({ path: path.join(__dirname, "virtual-clock.js") });
  page = await ctx.newPage();
  cdp = await ctx.newCDPSession(page);
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && log("[console]", m.type(), m.text().slice(0, 300)));
  page.on("pageerror", (e) => log("[pageerror]", e.message));
  await page.goto(URL);

  // Boot: step time until the title page is up.
  let st;
  for (;;) {
    st = await page.evaluate((dt) => (window.__vt ? (__vt.step(dt), !!window.__dbg) : false), 50).catch(() => false);
    if (st) break;
    await sleep(20);
  }
  st = await waitLoaded(0);
  log("title page up; quality", await page.evaluate(() => __dbg.Save.get("quality")));

  // --- the title page, with the welcome card a new player gets ---------
  await hold(TEST ? 0.2 : 4.0);
  await key("Enter"); // dismiss "How to play"
  await hold(TEST ? 0.2 : 3.0);

  const levels = ["city", "mountain", "grandprix"];
  for (let i = 0; i < levels.length; i++) {
    if (i > 0) {
      // Back on the title page: step to the next track. Levels unlock by
      // winning; this run only drives two gates, so unlock it directly.
      await page.evaluate((n) => __dbg.Save.set("maxLevel", n), i + 1);
      await key("Escape"); // pause
      await hold(TEST ? 0.2 : 1.5);
      await click('[data-act="home"]');
      await hold(TEST ? 0.2 : 1.5);
      await click('[data-act="next"]');
      await hold(0.4);
      await waitLoaded(TEST ? 2 : 40);
      await hold(TEST ? 0.2 : 2.5);
    }
    log("pull off:", levels[i]);
    await click('[data-act="play"]');
    await step();
    // Story cards: the intro on a new save, then the act's briefing.
    for (let c = 0; c < 3; c++) {
      const open = await page.evaluate(() => [...document.body.children].some((e) => e.style.zIndex === "70" && e.style.display === "block"));
      if (!open) break;
      await hold(TEST ? 0.2 : 4.0);
      await key("Enter");
    }
    await driveTwoGates();
    if (TEST) log("test timing", ((Date.now() - t0) / frameNo).toFixed(0), "ms/frame");
  }
  await hold(TEST ? 0.2 : 1.0);
  log("done:", frameNo, "frames,", (frameNo / FPS).toFixed(1), "s of video");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
