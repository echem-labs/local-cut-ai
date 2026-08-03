/**
 * Launch the desktop app under Playwright and expose an HTTP eval server.
 *
 * POST /        JS function body -> runs with {app, page} in scope; the
 *               JSON-serialized return value comes back.
 * GET  /health  {ok, consoleErrors, pageErrors} collected since launch.
 *
 * Two hard-won rules encoded here rather than remembered:
 * - The env must NOT carry ELECTRON_RUN_AS_NODE (VS Code terminals export
 *   it), or the Electron binary runs as plain Node and `app` is undefined.
 * - Never call page.setViewportSize: CDP viewport emulation pins the
 *   renderer, which masks exactly the resize behavior walk.mjs asserts.
 *
 * Env:
 *   RIG_PORT           eval-server port (default 9223)
 *   LOCALCUT_USERDATA  fresh-profile dir (dev-only override in main.ts)
 *   RIG_OZONE          value for --ozone-platform-hint (e.g. "x11")
 *   LOCALCUT_*         passed through to the app/engine as usual
 */
const http = require("http");
const path = require("path");
const { _electron } = require("playwright-core");

const DESKTOP = path.resolve(__dirname, "..", "..");
const PORT = Number(process.env.RIG_PORT || 9223);

async function main() {
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
  const page = await app.firstWindow();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, consoleErrors, pageErrors }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
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
  server.listen(PORT, "127.0.0.1", () => console.log(`rig eval server on ${PORT}`));

  app.process().on("exit", (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
