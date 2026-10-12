/**
 * Give `npm run dev` a Windows identity, so its toasts say who sent them.
 *
 * Windows draws a toast's sender name and small icon from the Start Menu
 * shortcut that carries the sending app's AppUserModelID. The installer
 * writes that shortcut for a release build. A dev build runs the electron.exe
 * in node_modules, which has none, so its toasts arrive from "Electron" or
 * from nobody, whatever id main.ts claims.
 *
 * This writes "LocalCut AI (dev)" into the user's Start Menu: that same
 * electron.exe, the id electron-builder stamps on the installed shortcut, and
 * the app's icon. Launching it runs this checkout the way `npm start` does.
 *
 * Runs under the repo's Electron, which is what has `shell.writeShortcutLink`:
 *   npm run dev:shortcut
 * Once per checkout, since the shortcut holds absolute paths into it. Any
 * other shortcut claiming the same id is reported rather than removed: it may
 * be an installed release, and with two of them Windows is free to take the
 * name and icon from either.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// With ELECTRON_RUN_AS_NODE set, which VS Code passes to whatever it starts,
// the binary runs this as plain Node: `require("electron")` is then the
// binary's path and there is no `app`. Start it again without the variable,
// as rig/launch.cjs does.
const electron = require("electron");
if (typeof electron === "string") {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  process.exit(spawnSync(electron, [__filename], { env, stdio: "inherit" }).status ?? 1);
}
const { app, shell } = electron;

const APP_DIR = path.resolve(__dirname, "..");

// Electron's default for an uncaught main-process throw is a modal error box
// that waits for OK. Print and exit instead, as rig/render-mock.cjs does.
process.on("uncaughtException", (error) => {
  console.error(error);
  app.exit(1);
});

/** A top-level scalar from electron-builder.yml, read off the text the way
 * electron/test/appId.ts reads it. Taking the id from there, rather than
 * writing it out again, keeps the dev shortcut on whatever id the installer
 * uses, and appId.contract.test.ts holds main.ts to that same id. */
function builderValue(key) {
  const text = fs.readFileSync(path.join(APP_DIR, "electron-builder.yml"), "utf8");
  const raw = new RegExp(`^${key}:[ \\t]+(.+?)[ \\t]*(?:#.*)?$`, "m").exec(text)?.[1];
  return raw ? raw.replace(/^(["'])(.*)\1$/, "$2") : null;
}

/** Every other shortcut under `dir` that claims `appId`. */
function otherClaims(dir, appId, except) {
  const claims = [];
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, name);
    if (!file.toLowerCase().endsWith(".lnk") || file === except) continue;
    try {
      if (shell.readShortcutLink(file).appUserModelId === appId) claims.push(file);
    } catch {
      // Not every .lnk resolves (an MSI advertised shortcut, a dead target).
    }
  }
  return claims;
}

function main() {
  if (process.platform !== "win32") {
    console.log(`Only Windows needs this. Nothing to do on ${process.platform}.`);
    return 0;
  }
  const appId = builderValue("appId");
  const productName = builderValue("productName");
  if (!appId || !productName) {
    console.error("Could not read appId and productName from electron-builder.yml.");
    return 1;
  }

  const programs = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  const link = path.join(programs, `${productName} (dev).lnk`);
  const written = shell.writeShortcutLink(link, "create", {
    target: process.execPath,
    args: `"${APP_DIR}"`,
    cwd: APP_DIR,
    description: `${productName} development build`,
    icon: path.join(APP_DIR, "build", "icon.ico"),
    iconIndex: 0,
    appUserModelId: appId,
  });
  if (!written) {
    console.error(`Could not write ${link}`);
    return 1;
  }
  console.log(`Wrote ${link}`);
  console.log(`Toasts from npm run dev now come from "${productName} (dev)".`);

  const others = otherClaims(programs, appId, link);
  if (others.length > 0) {
    console.log(`\nThese shortcuts also claim ${appId}, so Windows may name toasts after any of them:`);
    for (const other of others) console.log(`  ${other}`);
    console.log("Delete the ones you don't want.");
  }
  return 0;
}

app.whenReady().then(() => app.exit(main()));
