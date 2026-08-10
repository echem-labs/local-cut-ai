# LocalCut AI — brand assets

The mark is the **Cut Play** (design review 2): a play button sliced clean
through — the gap *is* the cut. Pure geometry, no letterforms.

| File | Use |
| --- | --- |
| `logo.svg` | Master mark on the brand-gradient tile. Scales losslessly — export PNGs at any size from this. |
| `logo-mono.svg` | One-color variant (`#5F4FD8`) for light grounds and print; recolor to `#fff` for dark grounds. |

Every app icon is generated from `logo.svg` by
`apps/desktop/scripts/make-icon.mjs` — re-run it after any geometry change
(`npm run icon` in `apps/desktop`) and commit the result, since it is the
committed binaries that ship. CI runs `npm run icon:check`, which fails if
they no longer match this file.

| Generated | Use |
| --- | --- |
| `build/icon.ico` | Stamped on the Windows exe and installer by electron-builder. |
| `build/icon.png` | The Linux AppImage/deb icon and the source of the freedesktop icon set. |
| `build/icon.icns` | The macOS bundle. Inset to Apple's 824/1024 grid — the Dock sizes every icon against that, so a full-bleed tile renders larger than its neighbours. |
| `public/icon.png` | The icon the *running* app uses (window, Linux taskbar, dev Dock, toasts) and the favicon. Vite copies `public/` into `dist/`, which is what puts it inside the asar; `build/` is build resources and never ships. |

The Windows taskbar also needs `APP_USER_MODEL_ID` in `electron/main.ts` to
equal `appId` in `electron-builder.yml`, or a pinned tile and a running
window are two different apps to the shell.

## Palette — "Electric Iris"

| Token | Dark theme | Light theme |
| --- | --- | --- |
| Accent | `#7C6CF8` | `#5B49D6` |
| Accent hover | `#948AF9` | `#4E3BC9` |
| Ground | `#0E0F12` | `#F6F5F9` |
| Brand gradient | `#A395FF → #5F4FD8` (135°) | same |

The gradient is reserved for exactly two places — the logo mark and the
primary CTA. Everything else uses the flat accent; that restraint is what
keeps the gradient feeling premium. Status colors (amber draft, green
final, red failed) are reserved and never decorative.

In-app the mark is drawn by `apps/desktop/src/components/BrandMark.tsx`;
keep its geometry in sync with `logo.svg`.
