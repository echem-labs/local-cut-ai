/**
 * Interface zoom = system baseline × user preference.
 *
 * The baseline is the desktop's text scale (GNOME text-scaling-factor via
 * the shell; 1 elsewhere) so the app matches the other apps on screen out
 * of the box. The user preference layers on top — persisted, adjustable
 * from Settings → General or Ctrl +/− (Ctrl 0 resets).
 */

const ZOOM_KEY = "localcut.uiZoom";
export const ZOOM_EVENT = "localcut-zoomchange";
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

const nearestStep = (value: number): number =>
  ZOOM_STEPS.reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best));

function readStored(): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ZOOM_KEY);
  } catch {
    /* storage disabled — fall through to the default */
  }
  const value = Number.parseFloat(raw ?? "1");
  // Snap to the scale so the Settings control always has a selected state.
  return Number.isFinite(value) ? nearestStep(value) : 1;
}

let baseline = 1;
let userZoom = readStored();

/** What `--titlebar-h` is declared as in tokens.css, and the height main.ts
 *  sizes `titleBarOverlay` against (one pixel short, so the bar's bottom
 *  border still shows under the buttons). */
const TITLEBAR_PX = 38;

/** The same clamp `setUiZoom` applies in the preload. Mirrored rather than
 *  imported because it lives across the bridge — and the CSS below has to be
 *  divided by the factor that was actually APPLIED, not the one asked for. */
const clampZoom = (factor: number): number =>
  Number.isFinite(factor) ? Math.min(3, Math.max(0.5, factor)) : 1;

export function userZoomFactor(): number {
  return userZoom;
}

function apply(): void {
  const factor = clampZoom(baseline * userZoom);
  // Optional-chained like theme.ts: the bridge is absent outside Electron
  // (e.g. vite serving a plain browser), where the browser owns zoom.
  if (!window.localcut) {
    window.dispatchEvent(new Event(ZOOM_EVENT));
    return;
  }
  window.localcut.setUiZoom(factor);
  // The min/max/close buttons are the OS's, drawn by the shell over the top
  // right of the window. Their height is in DEVICE pixels and does not move
  // with the renderer's zoom — but `--titlebar-h` is CSS, so it does. At 0.8
  // the drawn bar came out around 30 device pixels under a 37-pixel overlay,
  // and the buttons hung below the bar's own bottom border with the divider
  // line stopping short of them.
  //
  // Divide the zoom back out so the bar keeps the device height the overlay
  // was sized against. Everything INSIDE it still scales, which is right: the
  // OS glyphs are fixed, so the strip they sit in has to be too.
  document.documentElement.style.setProperty("--titlebar-h", `${TITLEBAR_PX / factor}px`);
  window.dispatchEvent(new Event(ZOOM_EVENT));
}

export function setUserZoom(factor: number): void {
  userZoom = factor;
  try {
    localStorage.setItem(ZOOM_KEY, String(factor));
  } catch {
    /* storage disabled — the zoom still applies for this session */
  }
  apply();
}

function stepZoom(direction: 1 | -1): void {
  const steps: readonly number[] = ZOOM_STEPS;
  const index = Math.min(
    steps.length - 1,
    Math.max(0, steps.indexOf(nearestStep(userZoom)) + direction),
  );
  setUserZoom(ZOOM_STEPS[index]);
}

/** Apply the persisted zoom, fetch the system baseline, and install the
 * Ctrl +/− / Ctrl 0 shortcuts. Call once at renderer startup. */
export function initZoom(): void {
  // Only claim the chords where we can actually scale: in a plain browser
  // (vite dev) the native zoom is the real thing and must not be swallowed.
  if (!window.localcut) return;
  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key === "=" || event.key === "+") stepZoom(1);
    else if (event.key === "-") stepZoom(-1);
    else if (event.key === "0") setUserZoom(1);
    else return;
    event.preventDefault();
  });
  // The user half applies synchronously so first paint isn't at the wrong
  // zoom while the baseline IPC resolves.
  apply();
  void window.localcut
    ?.getSystemTextScale()
    .then((scale) => {
      baseline = scale;
    })
    .catch(() => {})
    .then(apply);
}
