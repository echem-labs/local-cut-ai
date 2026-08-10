// Renders branding/logo.svg into every icon this app ships:
//
//   build/icon.ico    embedded in the exe and installer by electron-builder
//   build/icon.png    the Linux AppImage/deb icon — freedesktop wants a
//                     plain 512px PNG
//   build/icon.icns   the macOS bundle icon (Dock, Finder, About panel)
//   public/icon.png   the icon the RUNNING app uses — Vite copies public/
//                     into dist/, so this one rides inside app.asar where
//                     the main process can reach it. build/ cannot serve
//                     that purpose: electron-builder treats it as the build
//                     resources directory and excludes it from the package.
//   public/icon-mac.png  the same mark on Apple's grid, for the one runtime
//                     surface that is sized against that grid: the Dock icon
//                     an unpackaged macOS run has to set for itself. Handing
//                     it the full-bleed PNG puts back exactly the defect the
//                     .icns inset below exists to remove.
//
// The two full-bleed PNGs are byte-identical by construction. They are kept as
// separate files rather than one shared path because they answer to different
// owners — electron-builder resolves build/, Vite owns public/ — and pointing
// either tool at the other's directory reads as a mistake at the next change.
//
// Small ico sizes are stored as classic BGRA bitmaps — the format Explorer's
// taskbar and list views read most reliably — and 64px+ as PNG, the Vista+
// convention. Re-run with `npm run icon` after any change to the mark;
// `npm run icon:check` (CI) proves the committed files still match the SVG.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const logo = path.join(here, "..", "..", "..", "branding", "logo.svg");
const svg = readFileSync(logo);

const BMP_SIZES = [16, 24, 32, 48];
const PNG_SIZES = [64, 128, 256];

const renderFrom = (source, size) =>
  new Resvg(source, {
    fitTo: { mode: "width", value: size },
    // The mark is pure geometry — one rect and two paths, no <text> and no
    // font-family anywhere. Left on, resvg enumerates the whole system font
    // database before every single render, which is ~95% of this script's
    // runtime and is now paid on four CI jobs. A logo that ever grows text
    // fails the icon check loudly rather than drifting quietly.
    font: { loadSystemFonts: false },
  }).render();
const render = (size) => renderFrom(svg, size);

/** ICO bitmap entry: BITMAPINFOHEADER + bottom-up BGRA + 1bpp AND mask
 * (all zeros — the alpha channel is authoritative on 32bpp icons). */
function bmpEntry(image) {
  const { width: w, height: h } = image;
  const rgba = image.pixels;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // height counts XOR + AND blocks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = ((h - 1 - y) * w + x) * 4;
      xor[dst] = rgba[src + 2];
      xor[dst + 1] = rgba[src + 1];
      xor[dst + 2] = rgba[src];
      xor[dst + 3] = rgba[src + 3];
    }
  }
  const andMask = Buffer.alloc(Math.ceil(w / 32) * 4 * h);
  return Buffer.concat([header, xor, andMask]);
}

function buildIco() {
  const entries = [
    ...BMP_SIZES.map((size) => ({ size, data: bmpEntry(render(size)) })),
    ...PNG_SIZES.map((size) => ({ size, data: render(size).asPng() })),
  ];

  const icondir = Buffer.alloc(6);
  icondir.writeUInt16LE(1, 2); // type 1 = icon
  icondir.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dirEntries = entries.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // 0 encodes 256
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([icondir, ...dirEntries, ...entries.map((e) => e.data)]);
}

/** The macOS variant of the mark.
 *
 * Every other platform wants the tile full-bleed. macOS does not: the icons
 * it sits beside in the Dock all occupy a fixed fraction of their canvas —
 * 824 of 1024 points, centred — so a full-bleed tile is not "the same size
 * as its neighbours with a tighter crop", it renders visibly LARGER than all
 * of them. Apple's grid is a layout the whole Dock agrees on, so the mark is
 * inset to the same ratio here and the margin left transparent.
 *
 * The source is re-wrapped rather than re-drawn: whatever geometry logo.svg
 * holds is scaled as a group, so the mac icon cannot drift from the mark the
 * other three outputs use. Its corner radius scales with it and stays a hair
 * rounder than Apple's own squircle — invisible next to the inset, and not
 * worth a second copy of the geometry to correct.
 *
 * logo.svg is NESTED whole rather than having its body transplanted into a
 * new root. A nested <svg> is its own viewport, so every question about the
 * mark's coordinate space — a viewBox with a non-zero origin, a non-square
 * one, `preserveAspectRatio` — is answered by the renderer instead of by this
 * file, and every root attribute (a shared `fill`, a `style`, an `opacity`,
 * anything an SVG optimiser hoists up there) still applies to the children
 * that inherit it. Transplanting the body dropped all of that silently, and
 * `icon:check` cannot see it: the check re-derives whatever this function
 * produces and compares it against itself.
 */
const MAC_CANVAS = 1024;
const MAC_ART = 824;

/** How much room the nested mark takes in the canvas it is placed in, which
 * is what the inset has to scale away. An absent or percentage width makes a
 * nested viewport 100% of its parent's, i.e. the whole canvas. */
function nestedWidth(text) {
  const raw = /<svg\b[^>]*?\swidth="([^"]*)"/.exec(text)?.[1]?.trim();
  if (!raw || raw.endsWith("%")) return MAC_CANVAS;
  const px = /^([0-9.]+)(?:px)?$/.exec(raw);
  if (!px || !Number(px[1])) {
    throw new Error(`${logo}: root <svg> width "${raw}" is not a plain pixel length`);
  }
  return Number(px[1]);
}

function macSource() {
  // A prolog or a doctype is legal only at the top of a document, and the
  // mark is about to become a child of one.
  const text = svg
    .toString("utf8")
    .replace(/^\s*<\?xml[^>]*\?>\s*/, "")
    .replace(/^\s*<!DOCTYPE[^>]*>\s*/i, "")
    .trim();
  if (!text.startsWith("<svg")) throw new Error(`${logo}: expected an <svg> root to inset for macOS`);
  const scale = MAC_ART / nestedWidth(text);
  const pad = (MAC_CANVAS - MAC_ART) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MAC_CANVAS}" height="${MAC_CANVAS}" ` +
    `viewBox="0 0 ${MAC_CANVAS} ${MAC_CANVAS}">` +
    `<g transform="translate(${pad} ${pad}) scale(${scale})">${text}</g>` +
    `</svg>`
  );
}

// ICNS is a flat container: an 8-byte magic + length header followed by typed
// entries, and PNG payloads are accepted from OS X 10.7 on. electron-builder
// can convert a PNG on macOS via iconutil, but not when the build runs
// anywhere else, so the .icns is generated here and committed with its
// siblings.
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  // Retina variants: same pixels, the "@2x" types the system picks on HiDPI.
  ["ic11", 32], // 16pt @2x
  ["ic12", 64], // 32pt @2x
  ["ic13", 256], // 128pt @2x
  ["ic14", 512], // 256pt @2x
  ["ic10", 1024], // 512pt @2x — Finder's largest preview upscaled without it
];

/** The inset mark at a given size, rendered once per size. ICNS_TYPES names
 * ten entries but only seven distinct sizes — 32, 256 and 512 each appear
 * twice, as a 1x type and as the @2x type of a smaller point size — and the
 * duplicates are the same pixels by construction. */
const macRenders = new Map();
let macSvg;
function macPng(size) {
  const cached = macRenders.get(size);
  if (cached) return cached;
  macSvg ??= macSource();
  const data = renderFrom(macSvg, size).asPng();
  macRenders.set(size, data);
  return data;
}

function buildIcns() {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const data = macPng(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(data.length + 8, 4); // length INCLUDES the header
    return Buffer.concat([header, data]);
  });

  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

const appPng = render(512).asPng();
const icoSizes = BMP_SIZES.length + PNG_SIZES.length;
const outputs = [
  { file: path.join(here, "..", "build", "icon.ico"), data: buildIco(), note: `${icoSizes} sizes` },
  { file: path.join(here, "..", "build", "icon.png"), data: appPng, note: "512px" },
  { file: path.join(here, "..", "public", "icon.png"), data: appPng, note: "512px" },
  {
    file: path.join(here, "..", "build", "icon.icns"),
    data: buildIcns(),
    note: `${ICNS_TYPES.length} sizes, ${MAC_ART}/${MAC_CANVAS} inset`,
  },
  {
    file: path.join(here, "..", "public", "icon-mac.png"),
    // 512 is the largest the Dock and the app switcher ever draw (128pt @2x).
    data: macPng(512),
    note: `512px, ${MAC_ART}/${MAC_CANVAS} inset`,
  },
];

// --check is the CI guard. The committed binaries are the ones that ship, so
// an edit to logo.svg that never had `npm run icon` run against it has to be
// caught here rather than discovered in an installer.
if (process.argv.includes("--check")) {
  const stale = outputs.filter(({ file, data }) => {
    try {
      return !readFileSync(file).equals(data);
    } catch (error) {
      // Absent counts as stale — that is what a fresh checkout of a logo edit
      // looks like. Anything else (a lock, a permission, a directory in the
      // way) is not a mark that drifted, and reporting it as one sends the
      // reader to run a generator that cannot fix it.
      if (error.code === "ENOENT") return true;
      throw error;
    }
  });
  if (stale.length === 0) {
    console.log(`icons match ${path.relative(process.cwd(), logo)} - ${outputs.length} files`);
  } else {
    // `exitCode` rather than `exit()`: writes to a Windows terminal are
    // asynchronous, and exiting outright can truncate the very message this
    // failure exists to deliver.
    process.exitCode = 1;
    console.error("These generated icons no longer match branding/logo.svg:\n");
    for (const { file } of stale) console.error(`  ${path.relative(process.cwd(), file)}`);
    console.error(
      "\nRun `npm run icon` in apps/desktop and commit the result." +
        "\n(A @resvg/resvg-js upgrade can also change the encoded bytes - the fix" +
        "\nis the same, and the regenerated files are the ones that ship.)",
    );
  }
} else {
  // An `else`, not a fallthrough guarded by process.exit: the write loop must
  // be unreachable in check mode by structure, or removing a tail exit turns
  // the guard into a step that silently regenerates and always passes.
  for (const { file, data, note } of outputs) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    console.log(`wrote ${file} - ${note}, ${data.length} bytes`);
  }
}
