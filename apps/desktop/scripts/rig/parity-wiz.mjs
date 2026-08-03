/**
 * Wizard pixel-parity capture + gate (plan doc 11, rule 3; phase U1).
 *
 * Drives the wizard through its five reference states with a SEEDED
 * store (the mock's exact machine and catalog, frozen), screenshots each
 * clipped to the reference geometry, then runs compare.mjs against the
 * Inter-rendered references. Seeding is what pins the data-bearing
 * regions; the masks generated alongside the references absorb what no
 * truthful app state can reproduce (see render-mock.cjs).
 *
 * Usage: node parity-wiz.mjs --refs <dir>   (dir must hold wiz-*.png + masks.json)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { evalInApp, makeCheck, shotsDir, startRig, stopRig } from "./rig.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const refsArg = process.argv.indexOf("--refs");
const refsDir = refsArg >= 0 ? path.resolve(process.argv[refsArg + 1]) : null;
if (!refsDir) {
  console.error("usage: node parity-wiz.mjs --refs <dir>");
  process.exit(2);
}

const dir = shotsDir("parity-wiz");
const check = makeCheck();

const GB = 2 ** 30;
const gpu = {
  vendor: "NVIDIA",
  name: "NVIDIA GeForce RTX 3080 Laptop GPU",
  vram_gb: 8,
  backend: "cuda",
};
const license = { id: "apache-2.0", commercial: true, verdict: "commercial", notes: "" };
const entry = (id, task, { external = false, vram = 8, family = "", version = "", size = GB } = {}) => ({
  id,
  task,
  family,
  version,
  quant: "",
  requirements: { vram_gb: vram, ram_gb: 8, disk_gb: 20, backends: [] },
  quality_score: 1,
  speed_score: 1,
  license,
  files: external ? [] : [{ url: "https://example.test/w", dest: "w", sha256: "0", size }],
  comfy_graph_template: "",
  custom: false,
  size_bytes: external ? 0 : size,
  downloaded: false,
  downloading: false,
  progress: null,
  partial_bytes: 0,
});

/** The mock's machine and catalog, one truthful difference: ltx and ace
 * are still to download (the mock says installed AND "2 downloads" — no
 * real state can say both; the masked metas absorb it). */
const MODELS = [
  entry("qwen3-8b-q4", "text.llm", { external: true, vram: 6, family: "qwen 3", version: "· 8B" }),
  entry("qwen3-14b-q4", "text.llm", { external: true, vram: 10, family: "qwen 3", version: "· 14B" }),
  { ...entry("sdxl-base-1.0", "image.gen", { family: "sdxl", version: "1.0", size: 6.5 * GB }), downloaded: true },
  entry("flux.1-schnell", "image.gen", { external: true, vram: 12, family: "flux", version: "1 Schnell" }),
  {
    ...entry("ltx-video-0.9-i2v", "video.i2v", { family: "ltx", version: "0.9", size: 11 * GB }),
    license: { id: "ltx-community", commercial: false, verdict: "conditions", notes: "" },
  },
  entry("wan2.2-i2v-14b-fp8", "video.i2v", { vram: 16, family: "wan", version: "2.2", size: 33 * GB }),
  entry("chatterbox-tts", "speech.tts", { external: true, vram: 6, family: "chatterbox tts" }),
  entry("kokoro-v1", "speech.tts", { vram: 0, family: "kokoro", version: "82M", size: 350 * 2 ** 20 }),
  entry("ace-step-v1-3.5b", "music.gen", { family: "ACE-Step", version: "3.5B", size: 7.2 * GB }),
  entry("faster-whisper-large-v3", "transcribe", { external: true, vram: 4, family: "whisper large", version: "v3" }),
];

const SYSTEM = {
  hardware: {
    os: "linux",
    arch: "x86_64",
    ram_gb: 61.7,
    disk_free_gb: 87.6,
    gpus: [gpu],
    primary_gpu: gpu,
    tier: "A",
  },
  recommendations: [
    { task: "text.llm", model: MODELS[0], reason: "" },
    { task: "image.gen", model: MODELS[2], reason: "" },
    { task: "video.i2v", model: MODELS[4], reason: "" },
    { task: "speech.tts", model: MODELS[6], reason: "" },
    { task: "music.gen", model: MODELS[8], reason: "" },
    { task: "transcribe", model: MODELS[9], reason: "" },
  ],
  backend_mode: "local,mock",
};

/** Step-4 frame: ltx at 51%, ace at 12% — the mock's percentages. */
const MODELS_DOWNLOADING = MODELS.map((row) => {
  if (row.id === "ltx-video-0.9-i2v")
    return { ...row, downloading: true, progress: { done: 0.51 * 11 * GB, total: 11 * GB } };
  if (row.id === "ace-step-v1-3.5b")
    return { ...row, downloading: true, progress: { done: 0.12 * 7.2 * GB, total: 7.2 * GB } };
  return row;
});

const refSize = (name) => {
  const png = PNG.sync.read(readFileSync(path.join(refsDir, `${name}.png`)));
  return { width: png.width, height: png.height };
};

const profile = mkdtempSync(path.join(tmpdir(), "localcut-parity-"));
const engineData = mkdtempSync(path.join(tmpdir(), "localcut-parity-engine-"));
const rig = await startRig({
  LOCALCUT_USERDATA: profile,
  LOCALCUT_DATA_DIR: engineData,
  LOCALCUT_ENGINE_PORT: process.env.RIG_ENGINE_PORT || "7931",
  LOCALCUT_SEED_HOOK: "1",
  RIG_SCALE: "1",
});

try {
  await evalInApp("await page.waitForSelector('.setup', { timeout: 30000 }); return null;");

  // The references are dark-only (the mock has no light tokens — recorded
  // deviation); pin the theme rather than inheriting the desktop's.
  await evalInApp(`
    await page.evaluate(() => localStorage.setItem("localcut.theme", "dark"));
    await page.reload();
    await page.waitForSelector(".setup", { timeout: 30000 });
    return null;
  `);

  await evalInApp(`
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentBounds({ x: 0, y: 0, width: 1450, height: 800 });
    });
    await page.waitForTimeout(500);
    return null;
  `);

  // References are 1:1 CSS pixels; the app multiplies in the desktop's
  // text scale (zoom.ts baseline). Pin the whole zoom to exactly 1 —
  // after the app's own initZoom has run, via the same webFrame path.
  await evalInApp(`
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1);
    });
    await page.waitForTimeout(300);
    return null;
  `);

  // Two capture-only adjustments, neither of which the gate measures:
  // - let the DOCUMENT scroll instead of main.content, so a clip taller
  //   than the viewport (wiz-3lib) captures beyond it;
  // - drop the engine-error banner: the engine is irrelevant here (state
  //   is seeded+frozen) and its port-bind flake (see memory: the banner
  //   appears on ~2 in 5 starts) would leak environmental noise into the
  //   44px band above the stepper.
  await evalInApp(`
    await page.addStyleTag({ content: [
      "html, body, #root, .app { height: auto !important; }",
      "main.content { overflow: visible !important; height: auto !important; }",
      "::-webkit-scrollbar { width: 0 !important; height: 0 !important; }",
      ".banner.error { display: none !important; }",
    ].join("\\n") });
    return null;
  `);

  const seeded = await evalInApp(`
    return page.evaluate((patch) => {
      if (!window.__localcutSeed) return false;
      window.__localcutSeed(patch);
      return true;
    }, ${JSON.stringify({ system: SYSTEM, models: MODELS, freeze: true })});
  `);
  check("seed hook is installed and accepted the fixture", seeded === true);

  // fullPage + own crop: a Playwright clip clamps to the viewport, and
  // wiz-3lib is taller than any window this display allows. The injected
  // style above hands overflow to the document, so fullPage stitches it.
  const shoot = async (name) => {
    const { width, height } = refSize(name);
    const clip = await evalInApp(`
      return page.evaluate(([w]) => {
        const stepper = document.querySelector(".stepper").getBoundingClientRect();
        const card = document.querySelector(".setup.wizard").getBoundingClientRect();
        return {
          x: Math.round(card.left + card.width / 2 - w / 2 + window.scrollX),
          y: Math.round(stepper.top - 44 + window.scrollY),
        };
      }, [${width}]);
    `);
    const full = path.join(dir, `${name}.full.png`);
    await evalInApp(`
      await page.screenshot({ path: ${JSON.stringify(full)}, fullPage: true });
      return null;
    `);
    const page_ = PNG.sync.read(readFileSync(full));
    const out = new PNG({ width, height });
    PNG.bitblt(page_, out, clip.x, clip.y, Math.min(width, page_.width - clip.x), Math.min(height, page_.height - clip.y), 0, 0);
    writeFileSync(path.join(dir, `${name}.png`), PNG.sync.write(out));
    rmSync(full);
  };

  const click = (label) =>
    evalInApp(`
      const buttons = await page.$$(".setup-actions button, .setup .seg-toggle button");
      for (const b of buttons) {
        if ((await b.textContent()).trim() === ${JSON.stringify(label)}) { await b.click(); break; }
      }
      await page.waitForTimeout(250);
      return null;
    `);

  await shoot("wiz-1");
  await click("Get started");
  await shoot("wiz-2");
  await click("Continue");
  await shoot("wiz-3");
  await click("Open full library");
  await click("All models"); // the greyed-rows frame; filter chip is masked
  await shoot("wiz-3lib");
  await click("Back to recommended");
  await click("Download & continue (18 GB)");
  // Step 4: re-seed the frozen downloading frame the mock poses.
  await evalInApp(`
    return page.evaluate((patch) => { window.__localcutSeed(patch); return null; },
      ${JSON.stringify({ models: MODELS_DOWNLOADING })});
  `);
  await evalInApp("await page.waitForTimeout(250); return null;");
  await shoot("wiz-4");
} finally {
  await stopRig(rig);
  const scrub = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  rmSync(profile, scrub);
  rmSync(engineData, scrub);
}

if (check.failures() > 0) {
  console.error("parity capture failed before comparing");
  process.exit(1);
}

const compare = spawnSync(
  process.execPath,
  [
    path.join(HERE, "compare.mjs"),
    "--refs",
    refsDir,
    "--shots",
    dir,
    "--masks",
    path.join(refsDir, "masks.json"),
  ],
  { stdio: "inherit" },
);
process.exit(compare.status ?? 1);
