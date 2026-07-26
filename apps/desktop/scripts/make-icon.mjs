// Renders branding/logo.svg into build/icon.ico (embedded in the exe and
// installer by electron-builder) plus build/icon.png (the Linux
// AppImage/deb icon — freedesktop wants a plain 512px PNG). Small ico
// sizes are stored as classic BGRA bitmaps — the format Explorer's
// taskbar and list views read most reliably — and 64px+ as PNG, the
// Vista+ convention. Re-run with `npm run icon` after any change to the
// mark.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(path.join(here, "..", "..", "..", "branding", "logo.svg"));

const BMP_SIZES = [16, 24, 32, 48];
const PNG_SIZES = [64, 128, 256];

const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render();

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

const out = path.join(here, "..", "build", "icon.ico");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([icondir, ...dirEntries, ...entries.map((e) => e.data)]));
console.log(`wrote ${out} — ${entries.length} sizes, ${offset} bytes`);

const png = path.join(here, "..", "build", "icon.png");
writeFileSync(png, render(512).asPng());
console.log(`wrote ${png} — 512px`);

// build/icon.icns — the macOS app icon (Dock, Finder, the About panel).
// electron-builder can convert a PNG on macOS via iconutil, but not when the
// build runs anywhere else, so the .icns is generated here and committed with
// its siblings. ICNS is a flat container: an 8-byte magic + length header
// followed by typed entries, and PNG payloads are accepted from OS X 10.7 on.
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
];

const icnsEntries = ICNS_TYPES.map(([type, size]) => {
  const data = render(size).asPng();
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(data.length + 8, 4); // length INCLUDES the header
  return Buffer.concat([header, data]);
});

const icnsBody = Buffer.concat(icnsEntries);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, 4, "ascii");
icnsHeader.writeUInt32BE(icnsBody.length + 8, 4);

const icns = path.join(here, "..", "build", "icon.icns");
writeFileSync(icns, Buffer.concat([icnsHeader, icnsBody]));
console.log(`wrote ${icns} — ${icnsEntries.length} sizes, ${icnsBody.length + 8} bytes`);
