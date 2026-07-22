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

let baseline = 1;
let userZoom = readStored();

function readStored(): number {
  const value = Number.parseFloat(localStorage.getItem(ZOOM_KEY) ?? "1");
  return Number.isFinite(value) && value >= ZOOM_STEPS[0] && value <= ZOOM_STEPS[ZOOM_STEPS.length - 1]
    ? value
    : 1;
}

export function userZoomFactor(): number {
  return userZoom;
}

function apply(): void {
  window.localcut.setUiZoom(baseline * userZoom);
  window.dispatchEvent(new Event(ZOOM_EVENT));
}

export function setUserZoom(factor: number): void {
  userZoom = factor;
  localStorage.setItem(ZOOM_KEY, String(factor));
  apply();
}

function stepZoom(direction: 1 | -1): void {
  // Nearest step, then move one — so an off-scale stored value still lands
  // back on the scale after a single keypress.
  const nearest = ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - userZoom) < Math.abs(best - userZoom) ? step : best,
  );
  const index = Math.min(ZOOM_STEPS.length - 1, Math.max(0, ZOOM_STEPS.indexOf(nearest) + direction));
  setUserZoom(ZOOM_STEPS[index]);
}

/** Fetch the system baseline, apply the combined zoom, and install the
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
  void window.localcut
    .getSystemTextScale()
    .then((scale) => {
      baseline = scale;
    })
    .catch(() => {})
    .then(apply);
}
