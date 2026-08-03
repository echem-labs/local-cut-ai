/**
 * Launch the desktop app under Playwright and expose an HTTP eval server.
 *
 * POST /        JS function body -> runs with {app, page} in scope; the
 *               JSON-serialized return value comes back.
 * GET  /health  {ok, consoleErrors, pageErrors, mainLog} since launch.
 *
 * Every request must carry `x-rig-token: $RIG_TOKEN`. The token is not
 * about secrecy on a single-user box — it is what makes "the server on
 * 9223" mean "the app THIS run spawned". Without it, a rig left over from
 * a crashed run answers the health check, the new launcher dies of
 * EADDRINUSE unnoticed, and the walk drives the stale app — which, for
 * rig:e2e, is the developer's real profile rather than a temp one. It also
 * shuts the browser door: a POST of `text/plain` needs no CORS preflight,
 * so any page open in any local browser could otherwise reach this and run
 * code with main-process privileges.
 *
 * Two hard-won rules encoded here rather than remembered:
 * - The env must NOT carry ELECTRON_RUN_AS_NODE (VS Code terminals export
 *   it), or the Electron binary runs as plain Node and `app` is undefined.
 * - Never call page.setViewportSize: CDP viewport emulation pins the
 *   renderer, which masks exactly the resize behavior walk.mjs asserts.
 *
 * Env:
 *   RIG_PORT           eval-server port (default 9223)
 *   RIG_TOKEN          required on every request (rig.mjs generates one)
 *   LOCALCUT_USERDATA  fresh-profile dir (dev-only override in main.ts)
 *   RIG_OZONE          value for --ozone-platform-hint (e.g. "x11")
 *   LOCALCUT_*         passed through to the app/engine as usual
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { _electron } = require("playwright-core");

const DESKTOP = path.resolve(__dirname, "..", "..");
const PORT = Number(process.env.RIG_PORT || 9223);
const TOKEN = process.env.RIG_TOKEN;
if (!TOKEN) {
  console.error("rig: RIG_TOKEN is required - start the rig through rig.mjs or set one");
  process.exit(2);
}

/**
 * `electron .` loads the BUILT bundle, so without this a rig run reports
 * green about whatever was compiled last — the working tree need not have
 * anything to do with it. Cost is one directory walk; the alternative
 * (building on every entry point) pays a full tsc+vite twice per gate.
 */
function newestMtime(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of fs.readdirSync(target)) {
    newest = Math.max(newest, newestMtime(path.join(target, entry)));
  }
  return newest;
}

function assertFreshBuild() {
  const outputs = ["dist/index.html", "dist-electron/electron/main.js"].map((file) =>
    path.join(DESKTOP, file),
  );
  const missing = outputs.filter((file) => !fs.existsSync(file));
  if (missing.length) {
    console.error(`rig: no build to run - ${missing.join(", ")}\n     run: npm run build`);
    process.exit(2);
  }
  const built = Math.min(...outputs.map((file) => fs.statSync(file).mtimeMs));
  const sources = ["src", "electron", "index.html", "vite.config.ts"]
    .map((entry) => path.join(DESKTOP, entry))
    .filter((entry) => fs.existsSync(entry));
  const edited = Math.max(...sources.map(newestMtime));
  if (edited > built) {
    console.error(
      `rig: the build is older than the source it would test\n     run: npm run build`,
    );
    process.exit(2);
  }
}

async function main() {
  assertFreshBuild();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const args = ["."];
  if (process.env.RIG_OZONE) args.push(`--ozone-platform-hint=${process.env.RIG_OZONE}`);

  const app = await _electron.launch({
    executablePath: path.join(DESKTOP, "node_modules", ".bin", "electron"),
    args,
    cwd: DESKTOP,
    env,
  });

  const consoleErrors = [];
  const pageErrors = [];

  // The main process is where the engine's own failures surface (it spawns
  // it and logs its output). Playwright swallows that stream, so a rig
  // could see "no projects" and never learn the engine had exited.
  const mainLog = [];
  const record = (stream) => {
    if (!stream) return;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) mainLog.push(line.trimEnd());
      }
      if (mainLog.length > 400) mainLog.splice(0, mainLog.length - 400);
    });
  };
  record(app.process().stdout);
  record(app.process().stderr);

  // Subscribed through the app, before awaiting the first window: a page
  // handler attached after firstWindow() misses anything the first render
  // threw, which is the class of error this rig exists to catch.
  const watched = new Set();
  const watch = (target) => {
    if (watched.has(target)) return;
    watched.add(target);
    target.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    target.on("pageerror", (error) => pageErrors.push(String(error)));
  };
  app.on("window", watch);
  const page = await app.firstWindow();
  watch(page);

  const server = http.createServer((req, res) => {
    // Anything reaching us from a browser page carries Origin (cross-origin
    // requests) or Sec-Fetch-Site (every fetch/XHR in a modern browser).
    // Node's fetch sends neither — it does send sec-fetch-mode, so testing
    // that one would reject the rig's own client. Checked before the token
    // so a leaked token still cannot be replayed from a page.
    if (req.headers.origin || req.headers["sec-fetch-site"]) {
      res.writeHead(403).end();
      return;
    }
    if (req.headers["x-rig-token"] !== TOKEN) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "rig token mismatch" }));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, consoleErrors, pageErrors, mainLog }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    // Without this, a character split across two chunks is concatenated as
    // two mangled Buffers - screenshot paths carry the user's home dir.
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const fn = new Function("app", "page", `return (async () => { ${body} })()`);
        const result = await fn(app, page);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
      } catch (error) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: String(error && error.stack ? error.stack : error) }),
        );
      }
    });
  });
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `rig: port ${PORT} is already in use - another rig is running (RIG_PORT to change)`
        : `rig: eval server failed - ${error.message}`,
    );
    void app.close().finally(() => process.exit(2));
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`rig eval server on ${PORT}`));

  // `code` is null when the app was killed by a signal — that is a run
  // that did not finish, so it must not read as success.
  app.process().on("exit", (code) => process.exit(code ?? 1));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
