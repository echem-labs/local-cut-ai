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

export function userZoomFactor(): number {
  return userZoom;
}

function apply(): void {
  // Optional-chained like theme.ts: the bridge is absent outside Electron
  // (e.g. vite serving a plain browser), where the browser owns zoom.
  window.localcut?.setUiZoom(baseline * userZoom);
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
